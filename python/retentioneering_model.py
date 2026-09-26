"""The retentioneering feature's analysis step — the body of every dbt Python model the feature
generates (src/retentioneering/python.js inlines this file and appends `model(dbt, session)`).

It is THIS SERVER's code, never the caller's: the caller declares which analyses to run and with
which parameters (validated against the tool schema before anything starts), and this file turns an
eventstream table prepared in SQL into the headless `*_data` results of retentioneering, written as
one long table — one row per record:

    analysis  the caller's id for the analysis (unique within the call)
    kind      transition_graph | step_matrix | step_sankey | funnel | cluster_analysis | segment_overview
    part      what the record is (node, edge, layout, cell, block, step, overview, silhouette, params)
    seq       its position within (analysis, part) — the order is deterministic
    payload   the record, as JSON

Everything is deterministic: the rows are ordered before the library sees them, the clustering and
the graph layout run with the library's fixed seeds, and records are emitted in a sorted order.
"""

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


def _path_col(spec, analysis):
    return spec["columns"]["session"] if analysis.get("path") == "sessions" else spec["columns"]["user"]


# ── the analyses ──────────────────────────────────────────────────────────────────────────────

def transition_graph(stream, spec, a, out):
    path_col = _path_col(spec, a)
    weights = spec["edge_weights"]
    matrices = {w: stream.transition_graph_data(edge_weight=w, path_col=path_col) for w in weights}
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
    path_col = _path_col(spec, a)
    kwargs = {"max_steps": a.get("max_steps", 10), "path_col": path_col}
    if a.get("anchor"):
        kwargs["anchor"] = a["anchor"]
    elif a.get("path_pattern"):
        kwargs["path_pattern"] = a["path_pattern"]
    data = stream.step_sankey_data(**kwargs)
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
    if not a.get("anchor") and not a.get("path_pattern"):
        for link in _step_links(stream, _path_col(spec, a), a.get("max_steps", 10)):
            out.add(a["id"], "step_sankey", "link", {"block": 0, **link})


def funnel(stream, spec, a, out):
    data = stream.funnel_data(steps=a["steps"], path_col=_path_col(spec, a))
    for i, st in enumerate(data["steps"]):
        out.add(a["id"], "funnel", "step", {"index": i, **st})


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
    overview_metrics = a.get("overview_metrics") or [{"metric": "length", "agg": "mean"}, {"metric": "duration", "agg": "median"}, {"metric": "has_event_bulk", "agg": "mean"}]
    kwargs = {
        "features": a.get("features") or [{"metric": "event_count_bulk"}],
        "method": a.get("method", "kmeans"),
        "path_col": _path_col(spec, a),
        "overview_metrics": overview_metrics,
    }
    if a.get("method_args"):
        kwargs["method_args"] = a["method_args"]
    if a.get("scaler"):
        kwargs["scaler"] = a["scaler"]
    data = stream.cluster_analysis_data(**kwargs)
    if data.get("overview_df") is not None:
        _overview(data["overview_df"], a, out, "cluster_analysis", "cluster", _metric_meta(stream, overview_metrics))
    if data.get("best_params") is not None:
        out.add(a["id"], "cluster_analysis", "params", {"params": json.dumps(data["best_params"], sort_keys=True, default=str)})
    sil = data.get("silhouette")
    if sil:
        for i, (params, score) in enumerate(zip(sil["params"], sil["silhouette"])):
            out.add(a["id"], "cluster_analysis", "silhouette", {"params": json.dumps(params, sort_keys=True, default=str), "score": score, "best": i == sil.get("best_index")})


def segment_overview(stream, spec, a, out):
    metrics = a.get("metrics") or [{"metric": "length", "agg": "mean"}, {"metric": "duration", "agg": "median"}]
    frame = stream.segment_overview_data(a["segment"], metrics=metrics, path_col=_path_col(spec, a))
    _overview(frame, a, out, "segment_overview", "level", _metric_meta(stream, metrics))


ANALYSES = {
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
    out = _Out()
    for a in spec["analyses"]:
        ANALYSES[a["kind"]](stream, spec, a, out)
    return pd.DataFrame(out.rows, columns=RESULT_COLUMNS)
