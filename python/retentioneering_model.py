"""The retentioneering feature's analysis step — the body of every dbt Python model the feature
generates (src/retentioneering/python.js inlines this file and appends `model(dbt, session)`).

It is THIS SERVER's code, never the caller's: the caller declares preprocessing steps (the library's own
op model, applied with retentioneering.ops.apply_ops) and analyses (the library's methods, under their
own parameter names) — validated against the tool schema before anything starts — and this file turns
an eventstream table prepared in SQL into their results, written as one long table, one row per record:

    analysis  the caller's id for the analysis (unique within the call)
    kind      the analysis (transition_graph, step_matrix, …, describe)
    part      what the record is: for the charted analyses node, edge, layout, cell, block, link, step,
              overview, metric, silhouette, params; for any other result (and any diff) table, row, value
    seq       its position within (analysis, part) — the order is deterministic
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
        key = (analysis, part)
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


def _table(out, a, name, frame):
    if isinstance(frame, pd.Series):
        frame = frame.to_frame(name=frame.name if frame.name is not None else "value")
    if not isinstance(frame.index, pd.RangeIndex):
        frame = frame.reset_index()
    columns = [_label(c) for c in frame.columns]
    kinds = [_column_kind(frame.iloc[:, j]) for j in range(frame.shape[1])]
    out.add(a["id"], a["kind"], "table", {"table": name, "columns": json.dumps(columns), "kinds": json.dumps(kinds)})
    for row in frame.itertuples(index=False, name=None):
        out.add(a["id"], a["kind"], "row", {"table": name, "values": json.dumps([_deep(v) for v in row], default=str)})


def _records(value):
    return isinstance(value, list) and value and all(isinstance(v, dict) for v in value)


def _emit(out, a, name, value):
    """Any result of the library — a frame, a dict of frames and values, a tuple of them — as tables
    and values, each under the name the library gave it (a tuple's parts by position)."""
    if isinstance(value, (pd.DataFrame, pd.Series)):
        _table(out, a, name, value)
    elif isinstance(value, tuple):
        names = ["diff", "first", "second"] if a["params"].get("diff") is not None and len(value) == 3 else [f"{name}_{i + 1}" for i in range(len(value))]
        for n, v in zip(names, value):
            _emit(out, a, n, v)
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
    data = stream.cluster_analysis_data(**a["params"])
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


def segment_overview(stream, spec, a, out):
    frame = stream.segment_overview_data(**a["params"])
    _overview(frame, a, out, "segment_overview", "level", _metric_meta(stream, a["params"].get("metrics")))


CHARTED = {
    "transition_graph": transition_graph,
    "step_matrix": step_matrix,
    "step_sankey": step_sankey,
    "funnel": funnel,
    "cluster_analysis": cluster_analysis,
    "segment_overview": segment_overview,
}


def run(frame, spec):
    """The analyses `spec` names, over the eventstream `frame` → the long result table."""
    from retentioneering import Eventstream

    cols = spec["columns"]
    pdf = _to_pandas(frame).copy()
    # one clock for every runtime: UTC, without a zone (the warehouse stores instants)
    ts = pd.to_datetime(pdf[cols["time"]], utc=True)
    pdf[cols["time"]] = ts.dt.tz_convert(None)
    pdf[cols["event"]] = pdf[cols["event"]].astype(str)
    path_cols = [cols["user"]] + ([cols["session"]] if cols.get("session") else [])
    for c in path_cols + list(cols.get("segments") or []):
        pdf[c] = pdf[c].astype(str)
    pdf = pdf.sort_values(path_cols[:1] + [cols["time"], cols["event"]], kind="mergesort").reset_index(drop=True)
    stream = Eventstream(pdf, schema={
        "path_cols": path_cols,
        "event_col": cols["event"],
        "timestamp_col": cols["time"],
        "segment_cols": list(cols.get("segments") or []),
    })
    from retentioneering.ops import apply_ops

    base = apply_ops(stream, spec["preprocess"]) if spec.get("preprocess") else stream
    out = _Out()
    for a in spec["analyses"]:
        s = apply_ops(base, a["preprocess"]) if a.get("preprocess") else base
        # how many paths the analysis reads — what its shares are shares OF, so a card can give counts
        frame_out = s.to_dataframe()
        if a["path_col"] in frame_out.columns:
            out.add(a["id"], a["kind"], "scope", {"paths": int(frame_out[a["path_col"]].nunique())})
        charted = CHARTED.get(a["kind"])
        if charted and a["params"].get("diff") is None:
            charted(s, spec, a, out)
        else:
            _emit(out, a, "result", getattr(s, a["method"])(**a["params"]))
    return pd.DataFrame(out.rows, columns=RESULT_COLUMNS)
