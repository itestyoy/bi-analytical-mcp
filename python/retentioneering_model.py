"""The retentioneering feature's analysis step — the body of every dbt Python model the feature
generates (src/retentioneering/python.js inlines this file and appends `model(dbt, session)`).

It is THIS SERVER's code, never the caller's: the caller declares an eventstream's steps (the library's
own op model, applied with retentioneering.ops.apply_ops — `apply_steps` stores the eventstream after
them as a table) and analyses (the library's methods, under their own parameter names) — each checked
by the library itself before anything starts — and `run` turns an eventstream table into their
results, written as one long table, one row per record:

    analysis  the caller's id for the analysis (unique within the call)
    kind      the analysis (transition_graph, step_matrix, …, describe)
    part      what the record is: for the charted analyses node, edge, layout, cell, block, link, step,
              overview, metric, silhouette, params; for any other result (and any diff) table, row, value
    seq       its position within (analysis, part) — within its table, for a table's rows; the order
              is deterministic
    payload   the record, as JSON

Everything is deterministic: the rows are ordered before the library sees them, the clustering and
the graph layout run with the library's fixed seeds, and records are emitted in a sorted order.
"""

import inspect
import json
import math
import os

os.environ.setdefault("RETENTIONEERING_NO_TRACK", "1")

import pandas as pd  # noqa: E402

RESULT_COLUMNS = ["analysis", "kind", "part", "seq", "payload"]

# How long the library's installation on a warehouse runtime may take, and how much of pip's own
# output a failure carries back — its last lines are where pip says why.
INSTALL_TIMEOUT_SECONDS = 1200
INSTALL_TAIL_LINES = 60


def to_runtime(result, source, session):
    """The result in the kind of frame the runtime writes. On BigFrames, dbt writes the returned frame
    with its own to_gbq and then closes that frame's session — a pandas frame has neither, so it is
    handed back through the session the model ran in. Anywhere else the pandas frame is written as is.
    """
    if type(source).__module__.split(".")[0] == "bigframes" and hasattr(session, "read_pandas"):
        return session.read_pandas(result)
    return result


def ensure_library(requirement):
    """Make `requirement` (name==version) importable before the analysis runs.

    Already there at that version (this server's own environment, or a runtime template that has it
    preinstalled) → nothing is done. Otherwise it is installed with pip in the runtime — with binary
    wheels preferred, so nothing is compiled there — and a failure is raised with the last lines
    pip printed, which say why (a resolver conflict, a missing wheel, no route to the index). The
    install is this code's, rather than dbt's `packages`, for exactly that reason: dbt's installer
    keeps pip's output to itself when pip fails.
    """
    import importlib.metadata
    import subprocess
    import sys

    name, _, version = requirement.partition("==")
    try:
        if importlib.metadata.version(name) == version:
            return
    except importlib.metadata.PackageNotFoundError:
        pass
    command = [sys.executable, "-m", "pip", "install", "--prefer-binary", "--disable-pip-version-check",
               "--no-input", "--progress-bar", "off", requirement]
    print(f"installing {requirement} on this runtime")
    try:
        done = subprocess.run(command, capture_output=True, text=True, timeout=INSTALL_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired as e:
        said = ((e.stdout or "") + "\n" + (e.stderr or "")) if isinstance(e.stdout, str) else ""
        tail = "\n".join(said.strip().splitlines()[-INSTALL_TAIL_LINES:])
        raise RuntimeError(f"installing {requirement} did not finish in {INSTALL_TIMEOUT_SECONDS}s on this runtime. pip's last lines:\n{tail}")
    if done.returncode != 0:
        tail = "\n".join((done.stdout + "\n" + done.stderr).strip().splitlines()[-INSTALL_TAIL_LINES:])
        raise RuntimeError(f"installing {requirement} failed on this runtime (pip exit {done.returncode}). pip's last lines:\n{tail}")
    print(f"installed {requirement}")


def _to_pandas(frame):
    """The input relation as a pandas DataFrame, whatever the runtime handed over."""
    if isinstance(frame, pd.DataFrame):
        return frame
    for method in ("to_pandas", "df", "toPandas"):
        if hasattr(frame, method):
            return getattr(frame, method)()
    raise TypeError(f"cannot read a {type(frame).__name__} as a pandas DataFrame")


def _plain(value):
    """A JSON-safe scalar: NaN/NaT → None, a duration → seconds, numpy scalars → Python."""
    if value is None:
        return None
    if isinstance(value, pd.Timedelta):
        return None if pd.isna(value) else value.total_seconds()
    if isinstance(value, pd.Timestamp):
        return None if pd.isna(value) else value.isoformat()
    if hasattr(value, "item") and not isinstance(value, (str, bytes)):
        try:
            value = value.item()
        except (ValueError, AttributeError):
            pass
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return None
    try:
        if pd.isna(value):
            return None
    except (TypeError, ValueError):
        pass
    return value


class _Out:
    def __init__(self):
        self.rows = []
        self.seq = {}

    def add(self, analysis, kind, part, record):
        # a table's rows are numbered within their table, so a reader can take the first rows of each
        key = (analysis, part, record["table"]) if part == "row" else (analysis, part)
        n = self.seq.get(key, 0)
        self.seq[key] = n + 1
        self.rows.append([analysis, kind, part, n, json.dumps({k: _plain(v) for k, v in record.items()}, sort_keys=True, default=str)])


def _default(method, name):
    """A parameter's default as the library declares it."""
    p = inspect.signature(method).parameters.get(name)
    return None if p is None or p.default is inspect.Parameter.empty else p.default


# ── any result, as tables and values ──────────────────────────────────────────────────────────

def _deep(value):
    """A JSON-safe value, all the way down."""
    if isinstance(value, dict):
        return {str(k): _deep(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_deep(v) for v in value]
    if hasattr(value, "tolist") and not isinstance(value, (str, bytes)) and getattr(value, "ndim", 0):
        return [_deep(v) for v in value.tolist()]
    return _plain(value)


def _kind_of(value):
    """What a single value is, for the card to format it: a duration (sent as seconds), a moment, a
    number, a flag, text — read from the value's own type, never from its name."""
    if isinstance(value, (pd.Timedelta,)) or type(value).__name__ == "timedelta64":
        return "duration"
    if isinstance(value, pd.Timestamp) or type(value).__name__ in ("datetime", "datetime64"):
        return "datetime"
    if isinstance(value, bool) or type(value).__name__ == "bool_":
        return "boolean"
    if isinstance(value, int) or type(value).__name__.startswith(("int", "uint")):
        return "integer"
    if isinstance(value, float) or type(value).__name__.startswith("float"):
        return "number"
    return "text"


def _kinds(value):
    """The same structure as `value`, each leaf replaced by its kind."""
    if isinstance(value, dict):
        return {str(k): _kinds(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return "list"
    return _kind_of(value)


def _column_kind(series):
    """A column's kind from its dtype (an object column: from its first value)."""
    dtype = series.dtype
    if pd.api.types.is_timedelta64_dtype(dtype):
        return "duration"
    if pd.api.types.is_datetime64_any_dtype(dtype):
        return "datetime"
    if pd.api.types.is_bool_dtype(dtype):
        return "boolean"
    if pd.api.types.is_integer_dtype(dtype):
        return "integer"
    if pd.api.types.is_float_dtype(dtype):
        return "number"
    first = series.dropna()
    return _kind_of(first.iloc[0]) if len(first) else "text"


def _label(col):
    return " / ".join(str(c) for c in col) if isinstance(col, tuple) else str(col)


def _table(out, a, name, frame, role=None, block=None):
    """One frame as a table. A diff's parts carry their `role` (diff | first | second) and, around an
    anchor or a path pattern, their `block` — so a reader takes them by what they are, not by name."""
    if isinstance(frame, pd.Series):
        frame = frame.to_frame(name=frame.name if frame.name is not None else "value")
    if not isinstance(frame.index, pd.RangeIndex):
        frame = frame.reset_index()
    columns = [_label(c) for c in frame.columns]
    kinds = [_column_kind(frame.iloc[:, j]) for j in range(frame.shape[1])]
    meta = {**({"role": role} if role else {}), **({"block": block} if block is not None else {})}
    out.add(a["id"], a["kind"], "table", {"table": name, "columns": json.dumps(columns), "kinds": json.dumps(kinds), "rows": int(frame.shape[0]), **meta})
    for row in frame.itertuples(index=False, name=None):
        out.add(a["id"], a["kind"], "row", {"table": name, "values": json.dumps([_deep(v) for v in row], default=str)})


def _records(value):
    return isinstance(value, list) and value and all(isinstance(v, dict) for v in value)


def _emit(out, a, name, value):
    """Any result of the library — a frame, a dict of frames and values, a tuple of them — as tables
    and values, each under the name the library gave it (a tuple's parts by position)."""
    if isinstance(value, (pd.DataFrame, pd.Series)):
        _table(out, a, name, value)
    elif isinstance(value, tuple) and name == "result" and a["params"].get("diff") is not None and len(value) == 3:
        # a diff: (difference, first group, second group), each one frame or a tuple of blocks
        for role, part in zip(("diff", "first", "second"), value):
            blocks = part if isinstance(part, tuple) else (part,)
            for b, frame in enumerate(blocks):
                _table(out, a, role if len(blocks) == 1 else f"{role} {b + 1}", frame, role=role, block=b if len(blocks) > 1 else None)
    elif isinstance(value, tuple):
        for i, v in enumerate(value):
            _emit(out, a, f"{name}_{i + 1}", v)
    elif isinstance(value, dict) and any(isinstance(v, (pd.DataFrame, pd.Series, dict, tuple)) or _records(v) for v in value.values()):
        for k, v in value.items():
            _emit(out, a, k if name == "result" else f"{name}.{k}", v)
    elif _records(value):
        _table(out, a, name, pd.DataFrame(value))
    else:
        out.add(a["id"], a["kind"], "value", {"name": name, "value": json.dumps(_deep(value), default=str), "kinds": json.dumps(_kinds(value))})


# ── the analyses the card charts ──────────────────────────────────────────────────────────────

def transition_graph(stream, spec, a, out):
    params = {k: v for k, v in a["params"].items() if k != "edge_weight"}
    path_col = a["path_col"]
    weights = spec["edge_weights"]
    matrices = {w: stream.transition_graph_data(edge_weight=w, **params) for w in weights}
    counts = matrices["count"]
    events = [str(e) for e in counts.index]
    n_paths = int(stream.to_dataframe()[path_col].nunique())
    event_counts = stream.get_event_counts()
    for e in events:
        occurrences = n_paths if e in ("path_start", "path_end") else int(event_counts.get(e, 0))
        out.add(a["id"], "transition_graph", "node", {"event": e, "count": occurrences})
    for source in events:
        for target in [str(t) for t in counts.columns]:
            c = counts.loc[source, target]
            if not c:
                continue
            record = {"source": source, "target": target}
            for w in weights:
                record[w] = matrices[w].loc[source, target]
            out.add(a["id"], "transition_graph", "edge", record)
    from retentioneering.tools.graph_layout import GraphLayout
    layout = GraphLayout(stream).fit(path_col=path_col)
    for e in sorted(layout):
        out.add(a["id"], "transition_graph", "layout", {"event": e, "x": layout[e]["x"], "y": layout[e]["y"]})


def _steps(stream, spec, a, out, kind):
    data = stream.step_sankey_data(**a["params"])
    blocks = data if isinstance(data, tuple) else (data,)
    for b, block in enumerate(blocks):
        steps = [int(s) if str(s).lstrip("-").isdigit() else str(s) for s in block.columns]
        out.add(a["id"], kind, "block", {"block": b, "steps": json.dumps(steps), "events": len(block.index)})
        for event in block.index:
            for step, col in zip(steps, block.columns):
                share = block.loc[event, col]
                if share:
                    out.add(a["id"], kind, "cell", {"block": b, "event": str(event), "step": step, "share": share})


def _step_links(stream, path_col, max_steps):
    """Flows between consecutive steps for the sankey: the share of paths at event `source` on step
    t and at `target` on step t+1. A step is the library's own: step 0 is path_start, step t the t-th
    event, and a path that has ended stays at path_end — the same positions step_sankey_data counts
    (test/integration/retentioneering.test.js holds the two together)."""
    df = stream.to_dataframe()
    order = [c for c in ("index",) if c in df.columns]
    seqs = df.sort_values([path_col] + order, kind="mergesort").groupby(path_col, sort=True)[stream.schema.event_col].apply(lambda s: [str(x) for x in s])
    n = len(seqs)
    flows = {}
    for seq in seqs:
        full = ["path_start"] + seq + ["path_end"]
        at = lambda t: full[t] if t < len(full) else "path_end"  # noqa: E731
        for t in range(max_steps):
            key = (t, at(t), at(t + 1))
            flows[key] = flows.get(key, 0) + 1
    return [{"step": t, "source": s, "target": g, "share": c / n} for (t, s, g), c in sorted(flows.items())] if n else []


def step_matrix(stream, spec, a, out):
    _steps(stream, spec, a, out, "step_matrix")


def step_sankey(stream, spec, a, out):
    _steps(stream, spec, a, out, "step_sankey")
    # flows exist for the steps from the path start; around an anchor the card shows the columns alone
    p = a["params"]
    if not p.get("anchor") and not p.get("path_pattern"):
        max_steps = p.get("max_steps", _default(stream.step_sankey_data, "max_steps"))
        for link in _step_links(stream, a["path_col"], max_steps):
            out.add(a["id"], "step_sankey", "link", {"block": 0, **link})


def funnel(stream, spec, a, out):
    data = stream.funnel_data(**a["params"])
    for i, st in enumerate(data["steps"]):
        out.add(a["id"], "funnel", "step", {"index": i, **st})
    for k, v in data.items():
        if k != "steps":
            _emit(out, a, k, v)


def _overview(frame, a, out, kind, level_name, meta):
    for metric in frame.index:
        for level in frame.columns:
            out.add(a["id"], kind, "overview", {"metric": str(metric), level_name: str(level), "value": frame.loc[metric, level]})
        # what the row IS — the metric, the event it is about, the roll-up — carried from the configs
        # the library composed the row's name from, so nothing downstream reads it back out of the name
        if str(metric) in meta:
            out.add(a["id"], kind, "metric", {"metric": str(metric), **meta[str(metric)]})


def _metric_meta(stream, configs):
    """The library's own reading of metric configs: the column each yields (a _bulk metric one per
    event) and the event it is about; a rolled-up row is named <column>_<agg>."""
    from retentioneering.metrics.metric_builder import MetricConfig

    if not configs:
        return {}
    events = sorted(str(e) for e in stream.get_event_counts().keys())
    meta = {}
    for parsed in MetricConfig(configs, available_events=events).parsed_configs:
        agg = parsed["original"].get("agg")
        names = parsed.get("metric_names") or []
        evs = parsed.get("event_names") or []
        for i, col in enumerate(names):
            event = evs[i] if len(evs) == len(names) else (evs[0] if len(evs) == 1 else None)
            meta[f"{col}_{agg}" if agg else col] = {"base": parsed["type"], "event": event, "agg": agg}
    return meta


def cluster_analysis(stream, spec, a, out):
    params = a["params"]
    batches = _metric_batches(stream, params["overview_metrics"]) if params.get("overview_metrics") else [None]
    data = stream.cluster_analysis_data(**({**params, "overview_metrics": batches[0]} if batches[0] is not None else params))
    # the overview's other batches (a metric at a second agg): the clustering is seeded, so each call
    # finds the same clusters, and only the overview's rows are taken from it
    for batch in batches[1:]:
        more = stream.cluster_analysis_data(**{**params, "overview_metrics": batch}).get("overview_df")
        if more is not None and data.get("overview_df") is not None:
            both = pd.concat([data["overview_df"], more])
            data["overview_df"] = both[~both.index.duplicated(keep="first")]
    if data.get("overview_df") is not None:
        _overview(data["overview_df"], a, out, "cluster_analysis", "cluster", _metric_meta(stream, a["params"].get("overview_metrics")))
    if data.get("best_params") is not None:
        out.add(a["id"], "cluster_analysis", "params", {"params": json.dumps(_deep(data["best_params"]), sort_keys=True, default=str)})
    sil = data.get("silhouette")
    if sil:
        # the point the result describes: the one selected, else the highest silhouette
        best = sil.get("selected_index") if sil.get("selected_index") is not None else sil.get("best_index")
        for i, (params, score) in enumerate(zip(sil["params"], sil["silhouette"])):
            out.add(a["id"], "cluster_analysis", "silhouette", {"params": json.dumps(_deep(params), sort_keys=True, default=str), "score": score, "best": i == best})
    # everything else the library returned (each path's cluster, the NMF step) as tables and values
    for k, v in data.items():
        if k not in ("overview_df", "best_params", "silhouette") and v is not None:
            _emit(out, a, k, v)


def _metric_batches(stream, configs):
    """The metric configs in batches the library computes in ONE call: it builds one column per metric
    (and event) BEFORE it rolls them up, so two configs of the same metric — the same one at another
    agg (a median and a mean of event_count), or the same one twice — make two columns of one name and
    the call fails ("Data must be 1-dimensional", or "'DataFrame' object has no attribute 'name'" on
    another pandas). Each batch holds a column once; an identical config is kept once. The library's
    own parse names the columns."""
    from retentioneering.metrics.metric_builder import MetricConfig

    events = sorted(str(e) for e in stream.get_event_counts().keys())
    parsed = MetricConfig(configs, available_events=events).parsed_configs
    batches, seen = [], set()
    for cfg, p in zip(configs, parsed):
        key = json.dumps(cfg, sort_keys=True, default=str)
        if key in seen:
            continue
        seen.add(key)
        cols = set(p.get("metric_names") or [])
        home = next((b for b in batches if not (b["cols"] & cols)), None)
        if home is None:
            home = {"cols": set(), "configs": []}
            batches.append(home)
        home["cols"] |= cols
        home["configs"].append(cfg)
    return [b["configs"] for b in batches]


def segment_overview(stream, spec, a, out):
    params = a["params"]
    if not params.get("metrics"):
        frames = [stream.segment_overview_data(**params)]
    else:
        frames = [stream.segment_overview_data(**{**params, "metrics": batch}) for batch in _metric_batches(stream, params["metrics"])]
    # the rows of every batch, each once (the segment's size and share come back with each)
    frame = pd.concat(frames)
    frame = frame[~frame.index.duplicated(keep="first")]
    _overview(frame, a, out, "segment_overview", "level", _metric_meta(stream, params.get("metrics")))


CHARTED = {
    "transition_graph": transition_graph,
    "step_matrix": step_matrix,
    "step_sankey": step_sankey,
    "funnel": funnel,
    "cluster_analysis": cluster_analysis,
    "segment_overview": segment_overview,
}


def _stream(frame, spec):
    """The library's Eventstream over `frame`, ordered and typed the way every analysis reads it.

    `spec["columns"]`: the path owner (`user`, the first path column), the event, its time, the other
    path columns (`paths` — a session of the build, a split_sessions column of a materialized step),
    the segments, the custom columns a step kept, and `order`: the position of each event within its
    path, when the rows are a materialized step's — the library's own order, synthetic events included,
    which a sort by time and name would not restore."""
    from retentioneering import Eventstream

    cols = spec["columns"]
    pdf = _to_pandas(frame).copy()
    # one clock for every runtime: UTC, without a zone (the warehouse stores instants)
    ts = pd.to_datetime(pdf[cols["time"]], utc=True)
    pdf[cols["time"]] = ts.dt.tz_convert(None)
    pdf[cols["event"]] = pdf[cols["event"]].astype(str)
    path_cols = [cols["user"]] + [c for c in (cols.get("paths") or []) if c != cols["user"]]
    for c in path_cols:
        pdf[c] = pdf[c].astype(str)
    # a segment's levels as text, and a path with no value left without one (the library's <MISSING>),
    # never a level spelled "None" or "nan"
    for c in cols.get("segments") or []:
        pdf[c] = pdf[c].astype(object).where(pdf[c].isna(), pdf[c].astype(str))
    order = cols.get("order")
    keys = [cols["user"], order] if order and order in pdf.columns else [cols["user"], cols["time"], cols["event"]]
    pdf = pdf.sort_values(keys, kind="mergesort").reset_index(drop=True)
    # what a materialized step carries besides the events: their order, and its columns' roles
    pdf = pdf.drop(columns=[c for c in (order, cols.get("roles")) if c and c in pdf.columns])
    custom = [c for c in (cols.get("custom") or []) if c in pdf.columns]
    stream = Eventstream(pdf, schema={
        "path_cols": path_cols,
        "event_col": cols["event"],
        "timestamp_col": cols["time"],
        "segment_cols": list(cols.get("segments") or []),
        **({"custom_cols": custom} if custom else {}),
    })
    return stream


def stream_columns(stream):
    """What an eventstream holds, by the library's own schema: its path columns (the owner first), its
    segments and the custom columns a step added."""
    schema = stream.schema
    return {
        "paths": list(schema.path_cols),
        "segments": list(schema.segment_cols),
        "custom": list(schema.custom_cols or []),
    }


def apply_steps(frame, spec):
    """The eventstream `frame` after the library steps `spec["steps"]` (its own op model, applied with
    apply_ops) — as rows again: the path columns, the event, its time, the segments, the custom
    columns; `out.order`, each event's position in its path (the library's order, kept); and
    `out.roles`, on the first row only, the columns' roles as the library's schema has them (which
    are paths, segments, custom) — so the table says what it is, whatever the steps made."""
    from retentioneering.ops import apply_ops

    stream = apply_ops(_stream(frame, spec), spec["steps"])
    df = stream.to_dataframe()
    held = stream_columns(stream)
    schema = stream.schema
    keep = held["paths"] + [schema.event_col, schema.timestamp_col] + held["segments"] + held["custom"]
    out = df[keep].copy().reset_index(drop=True)
    out[spec["out"]["order"]] = out.groupby(held["paths"][0], sort=False).cumcount()
    for c in held["segments"]:
        out[c] = out[c].astype(object).where(out[c].isna(), out[c].astype(str))
    roles = [None] * len(out)
    if roles:
        roles[0] = json.dumps(held)
    out[spec["out"]["roles"]] = pd.Series(roles, dtype=object)
    return out


def charted_of(a):
    """The charted function an analysis runs through, or None for the library's own result — one
    decision for the run and its pre-run check: a diff only where the spec says its card keeps the
    analysis's own shape (`diff_charted`, set by the server's one table of diff cards)."""
    if a["params"].get("diff") is not None and not a.get("diff_charted"):
        return None
    return CHARTED.get(a["kind"])


def _diff_groups(diff):
    """What the two groups of a diff are: two levels of a segment (the library's <REST> the others,
    <MISSING> the paths with no level), or two lists of path ids."""
    if isinstance(diff, (list, tuple)) and len(diff) == 3 and isinstance(diff[0], str):
        return {"segment": diff[0], "first": str(diff[1]), "second": str(diff[2])}
    return {"first": f"{len(diff[0])} paths", "second": f"{len(diff[1])} paths"}


def _analyze(stream, spec, a, frame_out, out):
    """One analysis's records into `out`."""
    # how many paths the analysis reads — what its shares are shares OF, so a card can give counts
    if a["path_col"] in frame_out.columns:
        out.add(a["id"], a["kind"], "scope", {"paths": int(frame_out[a["path_col"]].nunique())})
    charted = charted_of(a)
    diff = a["params"].get("diff")
    if diff is not None:
        # which groups, and in which form the diff is stored: the analysis's own shape, or the library's tables
        out.add(a["id"], a["kind"], "diff", {"diff": True, "charted": charted is not None, "groups": json.dumps(_diff_groups(diff), default=str)})
    if charted:
        charted(stream, spec, a, out)
    else:
        _emit(out, a, "result", getattr(stream, a["method"])(**a["params"]))


def run(frame, spec):
    """The analyses `spec` names, over the eventstream `frame` → the long result table. Each analysis
    stands alone: one the library raises on is kept as its error, and the others keep their results."""
    stream = _stream(frame, spec)
    frame_out = stream.to_dataframe()
    out = _Out()
    for a in spec["analyses"]:
        own = _Out()
        try:
            _analyze(stream, spec, a, frame_out, own)
        except Exception as e:  # noqa: BLE001 — the library's own error, said for this analysis alone
            own = _Out()
            own.add(a["id"], a["kind"], "error", {"type": type(e).__name__, "message": str(e)})
        out.rows.extend(own.rows)
    return pd.DataFrame(out.rows, columns=RESULT_COLUMNS)
