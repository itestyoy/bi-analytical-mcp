#!/usr/bin/env python
"""MetricFlow, kept warm: one long-lived process on the MetricFlow environment's Python that answers the
dbt client (src/dbt/metricflow-server.js), one JSON line per request and one per answer.

`mf query` spends seconds before it reads a row: importing MetricFlow and dbt, `dbt debug` over the
project, loading the semantic manifest and building the engine over it. A query itself takes a tenth of
a second. So this process pays the imports once, and runs the CLI's OWN `query` command in-process with
the arguments the client built for the CLI — the CSV it writes, the SQL and dataflow plan it prints, an
error as it prints it, its exit code: the CLI's, by construction.

  {"id", "op": "mf", "argv": ["query", ...], "cwd", "env": {...}}
      -> {"id", "ok", "code", "stdout", "stderr"}     what `mf <argv>` run in `cwd` with `env` prints
  {"id", "op": "group_bys", "project_dir", "profiles_dir", "metrics": [...], "cwd", "env": {...}}
      -> {"id", "ok": true, "group_bys": {"<metric>": [item, ...]}} | {"id", "ok": false, "error"}
         what each metric can be grouped by, as MetricFlow lists it (list_group_bys) — the `mf` CLI
         prints only names; a dimension {kind, name, dunder_name, semantic_model, entity_links, type,
         grain}, an entity {kind, name, semantic_model, entity_links}
  an answer may also say {"retire": "<why>"}: the process could not let go of the warehouse after the
  request, and exits right after answering (below)

EVERY REQUEST GETS A CONFIGURATION OF ITS OWN, built as a fresh `mf` builds it — the CLI's
CLIConfiguration, with whatever caches it has, new each time — over the pieces its project keeps, and
only those, each of which was shown to leave the output byte for byte a fresh `mf`'s: the project's
`dbt debug` setup (profile + project) and the adapter it registered, the parsed semantic manifest
(reloaded when its file changes: path + mtime + size + inode) and the SemanticManifestLookup built over
that manifest (it caches what it resolves, not the node ids the SQL's aliases are made of). The ENGINE
is never kept: it caches dataflow plans and their nodes, and a query planned after another would number
its subqueries differently from a fresh `mf` (subq_4 for subq_5). A project is keyed by (directory,
environment, the project's dbt_project.yml and profiles.yml as they are); a setup that fails keeps
nothing, and the next request tries again, as `mf` would.

After EVERY request the warehouse is let go of — the adapter's connections closed, and dbt-duckdb's
process-wide database with them: a DuckDB file admits one process at a time, and the next dbt process
on it must find it free (the client holds the warehouse's turn for the request). A process that cannot
let go says so in its answer ("retire") and exits after it: it never waits idle holding the file.

One request at a time. A request that has to stop (cancelled, past its timeout) stops this process: the
client kills it and starts another on the next request — MetricFlow has no way to interrupt a query.
"""
import hashlib
import io
import json
import os
import sys
import threading
from pathlib import Path

# ---- the protocol's own channel: the process's real stdin/stdout, kept aside ------------------------
# Everything a library prints — the CLI's output, dbt's logs, a stray print, a C library writing to
# fd 1 — must never land in the answers. So the answers go to a duplicate of fd 1, fd 1 itself is
# pointed at stderr, and sys.stdout is the per-request capture below.
_ANSWERS = os.fdopen(os.dup(1), "w", encoding="utf-8")
_REQUESTS = os.fdopen(os.dup(0), "r", encoding="utf-8")
os.dup2(2, 1)
_REAL_STDERR = sys.stderr


class _Capture(io.TextIOBase):
    """A standard stream that, while a request runs, collects what is written to it — the text the
    CLI would have printed to that stream — and otherwise passes it on to stderr. Not a terminal (the
    CLI's output went to a pipe), text only (click asks with a write of b'' and must be told so)."""

    encoding = "utf-8"
    errors = "strict"

    def __init__(self):
        super().__init__()
        self._lock = threading.Lock()
        self._parts = None

    def begin(self):
        with self._lock:
            self._parts = []

    def end(self):
        with self._lock:
            text, self._parts = "".join(self._parts or []), None
        return text

    def writable(self):
        return True

    def isatty(self):
        return False

    def write(self, s):
        if not isinstance(s, str):
            raise TypeError(f"write() argument must be str, not {type(s).__name__}")
        with self._lock:
            if self._parts is not None:
                self._parts.append(s)
                return len(s)
        _REAL_STDERR.write(s)
        return len(s)

    def flush(self):
        if self._parts is None:
            _REAL_STDERR.flush()


_OUT = _Capture()
_ERR = _Capture()
sys.stdout = _OUT
sys.stderr = _ERR

# ---- MetricFlow and the CLI, imported once (after the streams above, which Halo binds at import) ----
import halo.halo  # noqa: E402

# Each spinner registers its own exit handler (stop, then clear the line). A one-shot `mf` runs them as
# the process exits — after its output, into its stdout; here they run as the request ends, still
# captured, and are not kept: an atexit entry per request would grow without end, and a spinner left
# running by a failed query would go on writing into the next one.
_SPINNER_EXITS = []
halo.halo.atexit = type("_RequestExit", (), {"register": staticmethod(_SPINNER_EXITS.append)})

from dbt.adapters.factory import get_adapter_by_type  # noqa: E402
from dbt_metricflow.cli.cli_configuration import CLIConfiguration  # noqa: E402
from dbt_metricflow.cli.dbt_connectors.dbt_config_accessor import dbtArtifacts  # noqa: E402
from dbt_metricflow.cli.main import query as _QUERY_COMMAND  # noqa: E402
from metricflow_semantics.model.semantic_manifest_lookup import SemanticManifestLookup  # noqa: E402

# the one command this process runs: a metric query (with --explain, its SQL and dataflow plan)
_COMMANDS = {"query": _QUERY_COMMAND}


def _stamp(path):
    """What says a file changed: its mtime, size and inode — None when it is not there."""
    try:
        st = os.stat(path)
    except OSError:
        return None
    return (st.st_mtime_ns, st.st_size, st.st_ino)


class _Kept:
    """What one project keeps between requests — only what a fresh `mf` would build the same: its setup
    (`dbt debug`: profile + project), the adapter that setup registered for ITS profile (dbt keeps one
    adapter per type, and the next project's setup replaces it), and the parsed semantic manifest with
    the lookup over it, both forgotten when the manifest's file changes."""

    def __init__(self):
        self.metadata = None
        self.adapter = None
        self._manifest = None  # [stamp, manifest, lookup or None]

    def set_up(self, metadata, adapter):
        self.metadata, self.adapter = metadata, adapter

    def manifest(self, project_path):
        # where MetricFlow reads it (dbtArtifacts.build_semantic_manifest_from_dbt_project_root)
        stamp = _stamp(Path(project_path, "target", "semantic_manifest.json").resolve())
        if self._manifest is None or self._manifest[0] != stamp:
            self._manifest = None
            manifest = dbtArtifacts.build_semantic_manifest_from_dbt_project_root(project_root=project_path)
            self._manifest = [stamp, manifest, None]
        return self._manifest[1]

    def lookup(self, manifest):
        entry = self._manifest
        if entry is None or entry[1] is not manifest:
            return SemanticManifestLookup(manifest)
        if entry[2] is None:
            entry[2] = SemanticManifestLookup(manifest)
        return entry[2]


class _RequestConfiguration(CLIConfiguration):
    """The CLI's configuration for ONE request — new, as a fresh `mf` makes it — taking from its
    project's _Kept only what that keeps: everything else the CLI builds (the SQL client, the engine,
    any cache a later dbt-metricflow adds) is built for this request alone."""

    def __init__(self, kept, key):
        super().__init__()
        self._kept = kept
        self._key = key

    def setup(self, dbt_profiles_path=None, dbt_project_path=None, configure_file_logging=True):
        kept = self._kept
        if kept.metadata is None:
            _LOGGING_FOR[0] = None  # a setup that runs points the logging at its project; one that fails: unknown
            super().setup(dbt_profiles_path=dbt_profiles_path, dbt_project_path=dbt_project_path, configure_file_logging=configure_file_logging)
            try:
                adapter = get_adapter_by_type(self.dbt_project_metadata.profile.credentials.type)
            except BaseException:
                self._is_setup = False  # not set up without its adapter: nothing is kept, the next request tries again
                raise
            kept.set_up(self.dbt_project_metadata, adapter)
            if configure_file_logging:
                _LOGGING_FOR[0] = self._key
            return
        self._dbt_project_metadata = kept.metadata
        if configure_file_logging and _LOGGING_FOR[0] != self._key:
            # the CLI logs each run to its project's logs/metricflow.log (set up with the configuration)
            self._configure_logging(log_file_path=self.log_file_path)
            _LOGGING_FOR[0] = self._key
        self._is_setup = True

    @property
    def dbt_artifacts(self):
        if self._dbt_artifacts is None:
            meta = self.dbt_project_metadata
            self._dbt_artifacts = dbtArtifacts(profile=meta.profile, project=meta.project, adapter=self._kept.adapter, semantic_manifest=self._kept.manifest(meta.project_path))
        return self._dbt_artifacts

    @property
    def semantic_manifest_lookup(self):
        return self._kept.lookup(self.semantic_manifest)


def _release_duckdb():
    """dbt-duckdb keeps one database per process, open after its connections close: closed here."""
    try:
        from dbt.adapters.duckdb.connections import DuckDBConnectionManager
    except ImportError:  # not a DuckDB install
        return
    with DuckDBConnectionManager._LOCK:
        env = DuckDBConnectionManager._ENV
        DuckDBConnectionManager._ENV = None
        if env is not None:
            env.close()


# why this process could not let go of the warehouse after the request it answers (then it exits)
_HOLDING = [None]


def _let_go(adapter):
    """Let go of the warehouse after a request: the adapter's connections, and dbt-duckdb's process-wide
    database. What fails is noted, and the process leaves after its answer (serve)."""
    failed = []
    if adapter is not None:
        try:
            adapter.cleanup_connections()
        except Exception as e:  # noqa: BLE001
            failed.append(f"closing the adapter's connections: {_stringify_exc(e)}")
    try:
        _release_duckdb()
    except Exception as e:  # noqa: BLE001
        failed.append(f"closing the DuckDB database: {_stringify_exc(e)}")
    if failed:
        _HOLDING[0] = "; ".join(failed)


# ---- what is kept: one _Kept per (directory, environment, project + profile files) -------------------
_KEPT = {}
_KEEP_AT_MOST = 32
_LOGGING_FOR = [None]


def _project_dirs(req):
    env = req.get("env") or {}
    cwd = req.get("cwd") or os.getcwd()
    project = req.get("project_dir") or env.get("DBT_PROJECT_DIR") or cwd
    profiles = req.get("profiles_dir") or env.get("DBT_PROFILES_DIR") or cwd
    return cwd, project, profiles


def _key(req):
    cwd, project, profiles = _project_dirs(req)
    env = json.dumps(sorted((req.get("env") or {}).items()))
    files = (_stamp(os.path.join(project, "dbt_project.yml")), _stamp(os.path.join(profiles, "profiles.yml")))
    return hashlib.sha256(json.dumps([cwd, project, profiles, env, files]).encode()).hexdigest()


def _enter(req):
    """Apply the request's working directory and environment — what the CLI would have started with."""
    env = req.get("env")
    if env is not None:
        os.environ.clear()
        os.environ.update({str(k): str(v) for k, v in env.items()})
    cwd = req.get("cwd")
    if cwd:
        os.chdir(cwd)


def _configuration(req):
    """The request's own configuration, over what its project keeps."""
    key = _key(req)
    kept = _KEPT.pop(key, None) or _Kept()
    _KEPT[key] = kept  # the most recently used last
    while len(_KEPT) > _KEEP_AT_MOST:
        _KEPT.pop(next(iter(_KEPT)))
    return _RequestConfiguration(kept, key)


def _run_mf(req):
    argv = list(req.get("argv") or [])
    command = _COMMANDS.get(argv[0] if argv else None)
    if command is None:
        return {"ok": False, "code": 2, "stdout": "", "stderr": f"this server runs only: mf {' | '.join(_COMMANDS)} (asked: mf {' '.join(argv)})\n"}
    _enter(req)
    cfg = _configuration(req)
    _OUT.begin()
    _ERR.begin()
    code = 0
    # the CLI's exit() closes sys.stdin: it is given one of its own (the requests come from elsewhere)
    sys.stdin = open(os.devnull)
    try:
        command.main(args=argv[1:], prog_name=f"mf {argv[0]}", obj=cfg, standalone_mode=True)
    except SystemExit as e:
        code = e.code
    except BaseException:  # noqa: BLE001 — as an uncaught exception ends `mf`: its traceback, exit 1
        import traceback

        traceback.print_exc()
        code = 1
    finally:
        sys.stdin.close()
        while _SPINNER_EXITS:
            try:
                _SPINNER_EXITS.pop()()  # as atexit runs them: the last registered first
            except Exception:  # noqa: BLE001
                pass
        _let_go(cfg._kept.adapter)
        stdout, stderr = _OUT.end(), _ERR.end()
    if code is None:
        code = 0
    elif not isinstance(code, int):
        stderr += f"{code}\n"
        code = 1
    return {"ok": code == 0, "code": code, "stdout": stdout, "stderr": stderr}


def _group_by_item(item):
    """One group-by item MetricFlow offers, as plain data."""
    from metricflow.engine.models import Dimension

    sm = getattr(item, "semantic_model_reference", None)
    links = [e.element_name for e in (getattr(item, "entity_links", None) or ())]
    if isinstance(item, Dimension):
        tp = item.type_params
        grain = getattr(tp, "time_granularity", None) if tp else None
        return {
            "kind": "dimension",
            "name": item.name,
            "dunder_name": item.dunder_name,
            "semantic_model": sm.semantic_model_name if sm else None,
            "entity_links": links,
            "type": str(getattr(item.type, "value", item.type)).lower(),
            "grain": str(getattr(grain, "value", grain)).lower() if grain else None,
        }
    return {
        "kind": "entity",
        "name": item.name,
        "semantic_model": sm.semantic_model_name if sm else None,
        "entity_links": links,
    }


def _group_bys(req):
    _enter(req)
    cfg = _configuration(req)
    _OUT.begin()
    _ERR.begin()
    try:
        _, project, profiles = _project_dirs(req)
        cfg.setup(dbt_profiles_path=Path(profiles), dbt_project_path=Path(project), configure_file_logging=False)
        # asked of MetricFlow itself, one metric at a time: what each can be grouped by
        return {"ok": True, "group_bys": {m: [_group_by_item(i) for i in cfg.mf.list_group_bys(metric_names=[m])] for m in req.get("metrics") or []}}
    finally:
        _let_go(cfg._kept.adapter)
        _OUT.end()
        _ERR.end()


_OPS = {"mf": _run_mf, "group_bys": _group_bys}


def _answer(req):
    op = _OPS.get(req.get("op"))
    if op is None:
        return {"ok": False, "error": f"unknown op {req.get('op')!r} (this server answers: {', '.join(_OPS)})"}
    return op(req)


def _stringify_exc(e):
    msg = str(e)
    return msg[:4000] if msg else type(e).__name__


def serve():
    for line in _REQUESTS:
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line)
            rid = req.get("id") if isinstance(req, dict) else None
            out = _answer(req)
        except Exception as e:  # noqa: BLE001 — a request that cannot be served is answered, not fatal
            out = {"ok": False, "error": _stringify_exc(e)}
        out["id"] = rid
        if _HOLDING[0]:
            out["retire"] = _HOLDING[0]
        _ANSWERS.write(json.dumps(out, default=str) + "\n")
        _ANSWERS.flush()
        if _HOLDING[0]:
            # a warehouse it could not let go of (a DuckDB file still locked) is let go of by leaving: the
            # client gives the answer once this process has ended, and the next request starts another
            _REAL_STDERR.write(f"mf_server: leaving — could not let go of the warehouse: {_HOLDING[0]}\n")
            _REAL_STDERR.flush()
            os._exit(1)


if __name__ == "__main__":
    serve()
