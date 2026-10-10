#!/usr/bin/env python
"""MetricFlow, kept warm: one long-lived process on the MetricFlow environment's Python that answers the
dbt client (src/dbt/metricflow-server.js), one JSON line per request and one per answer.

`mf query` spends seconds before it reads a row: importing MetricFlow and dbt, `dbt debug` over the
project, loading the semantic manifest and building the engine over it. A query itself takes a tenth of
a second. So this process pays the imports once, keeps each project's dbt setup (its profile and adapter)
and its parsed manifest with the engine built over it, and runs the CLI's OWN `query` command in-process
with the arguments the client built for the CLI — the CSV it writes, the SQL and dataflow plan it prints,
an error as it prints it, its exit code: the CLI's, by construction.

  {"id", "op": "mf", "argv": ["query", ...], "cwd", "env": {...}}
      -> {"id", "ok", "code", "stdout", "stderr"}     what `mf <argv>` run in `cwd` with `env` prints
  {"id", "op": "group_bys", "project_dir", "profiles_dir", "metrics": [...], "cwd", "env": {...}}
      -> {"id", "ok": true, "group_bys": {"<metric>": [item, ...]}} | {"id", "ok": false, "error"}
         what each metric can be grouped by, as MetricFlow lists it (list_group_bys) — the `mf` CLI
         prints only names; a dimension {kind, name, dunder_name, semantic_model, entity_links, type,
         grain}, an entity {kind, name, semantic_model, entity_links}

A request carries the environment the CLI would have run with (`env`) and its working directory
(`cwd`): both are applied before it runs, and what is kept is kept per (directory, environment, the
project's dbt_project.yml and profiles.yml as they are). The semantic manifest is reloaded when its file
changes (path + mtime + size). After EVERY request the warehouse is let go of — the adapter's connections
closed, and dbt-duckdb's process-wide database with them: a DuckDB file admits one process at a time, and
the next dbt process on it must find it free (the client holds the warehouse's turn for the request).

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

# the one command this process runs: a metric query (with --explain, its SQL and dataflow plan)
_COMMANDS = {"query": _QUERY_COMMAND}


def _stamp(path):
    """What says a file changed: its mtime, size and inode — None when it is not there."""
    try:
        st = os.stat(path)
    except OSError:
        return None
    return (st.st_mtime_ns, st.st_size, st.st_ino)


class _WarmConfiguration(CLIConfiguration):
    """The CLI's configuration, kept between requests. The adapter is the one `dbt debug` registered
    for THIS project's profile, taken right after its setup (dbt keeps one adapter per type, and the
    next project's setup replaces it); the semantic manifest is read as the CLI reads it, lazily, and
    forgotten when its file changes, with what is built over it."""

    def __init__(self):
        super().__init__()
        self._adapter = None
        self._manifest_stamp = None

    def setup(self, *args, **kwargs):
        super().setup(*args, **kwargs)
        self._adapter = get_adapter_by_type(self.dbt_project_metadata.profile.credentials.type)

    @property
    def dbt_artifacts(self):
        if self._dbt_artifacts is None:
            meta = self.dbt_project_metadata
            stamp = _stamp(self.manifest_path)
            manifest = dbtArtifacts.build_semantic_manifest_from_dbt_project_root(project_root=meta.project_path)
            self._dbt_artifacts = dbtArtifacts(profile=meta.profile, project=meta.project, adapter=self._adapter, semantic_manifest=manifest)
            self._manifest_stamp = stamp
        return self._dbt_artifacts

    @property
    def manifest_path(self):
        # where MetricFlow reads it (dbtArtifacts.build_semantic_manifest_from_dbt_project_root)
        return Path(self.dbt_project_metadata.project_path, "target", "semantic_manifest.json").resolve()

    def refresh(self):
        """Before a request: what is built over the manifest is built anew — the lookup and the engine
        number the nodes they make as they go (the SQL's aliases), and caches built by one query would
        number the next one's differently from a fresh `mf`; building them is a few hundredths of a
        second. The parsed manifest itself is kept while its file is the one read."""
        self._semantic_manifest_lookup = None
        self._sql_client = None
        self._mf = None
        if self._dbt_artifacts is not None and _stamp(self.manifest_path) != self._manifest_stamp:
            self._dbt_artifacts = None

    def release(self):
        """Let go of the warehouse: the adapter's connections, and dbt-duckdb's process-wide database
        (it holds the file open after its connections close)."""
        try:
            if self._adapter is not None:
                self._adapter.cleanup_connections()
        except Exception:  # noqa: BLE001
            pass
        _release_duckdb()


def _release_duckdb():
    try:
        from dbt.adapters.duckdb.connections import DuckDBConnectionManager
    except Exception:  # noqa: BLE001 — not a DuckDB install
        return
    with DuckDBConnectionManager._LOCK:
        env = DuckDBConnectionManager._ENV
        DuckDBConnectionManager._ENV = None
        if env is not None:
            try:
                env.close()
            except Exception:  # noqa: BLE001
                pass


# ---- what is kept: one configuration per (directory, environment, project + profile files) ---------
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


def _configuration(key):
    cfg = _KEPT.pop(key, None) or _WarmConfiguration()
    _KEPT[key] = cfg  # the most recently used last
    while len(_KEPT) > _KEEP_AT_MOST:
        old = _KEPT.pop(next(iter(_KEPT)))
        old.release()
    cfg.refresh()
    return cfg


def _forget(key, cfg):
    if _KEPT.get(key) is cfg:
        del _KEPT[key]


def _run_mf(req):
    argv = list(req.get("argv") or [])
    command = _COMMANDS.get(argv[0] if argv else None)
    if command is None:
        return {"ok": False, "code": 2, "stdout": "", "stderr": f"this server runs only: mf {' | '.join(_COMMANDS)} (asked: mf {' '.join(argv)})\n"}
    _enter(req)
    key = _key(req)
    cfg = _configuration(key)
    if cfg.is_setup and _LOGGING_FOR[0] != key:
        # the CLI logs each run to its project's logs/metricflow.log (set up with the configuration)
        cfg._configure_logging(log_file_path=cfg.log_file_path)
        _LOGGING_FOR[0] = key
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
        # a setup that ran in the command pointed the logging at this project (one that failed: unknown)
        _LOGGING_FOR[0] = key if cfg.is_setup else None
        cfg.release()
        stdout, stderr = _OUT.end(), _ERR.end()
    if code is None:
        code = 0
    elif not isinstance(code, int):
        stderr += f"{code}\n"
        code = 1
    if not cfg.is_setup:
        _forget(key, cfg)  # a setup that failed is tried again by the next request, as `mf` would
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
    key = _key(req)
    cfg = _configuration(key)
    _OUT.begin()
    _ERR.begin()
    try:
        if not cfg.is_setup:
            _, project, profiles = _project_dirs(req)
            cfg.setup(dbt_profiles_path=Path(profiles), dbt_project_path=Path(project), configure_file_logging=False)
        # asked of MetricFlow itself, one metric at a time: what each can be grouped by
        return {"ok": True, "group_bys": {m: [_group_by_item(i) for i in cfg.mf.list_group_bys(metric_names=[m])] for m in req.get("metrics") or []}}
    finally:
        cfg.release()
        _OUT.end()
        _ERR.end()
        if not cfg.is_setup:
            _forget(key, cfg)


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
        _ANSWERS.write(json.dumps(out, default=str) + "\n")
        _ANSWERS.flush()


if __name__ == "__main__":
    serve()
