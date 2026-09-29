"""The library's own check of a path-analysis step or analysis, before anything runs on the warehouse.

The library runs on the warehouse's runtime, which takes minutes to come up; a parameter it refuses
would surface only then. So every step the caller adds to an eventstream's draft, and every analysis
of a query, is first run HERE, by the library itself, on the feature's own environment (the same
pinned library): over two small stand-in eventstreams of the SHAPE the eventstream has at that point —
its event names, its path columns, its segments with their levels, its custom columns. What the
library refuses as a CONFIGURATION (an unknown event, a bad path pattern, a parameter that needs
another, a segment that is not there at that step) is refused alike on both and is reported with the
library's own message. What depends on the rows (an empty result, a pattern that matches nothing) is
left to the real data: it differs between the stand-ins, or is of a class that says so.

A step that passes comes back with the shape it leaves — the names the step can leave, the segments
and their levels, the path columns — read off the stand-ins by the library's own schema, so the next
step is checked against what this one made, exactly as a pipeline stage is checked against the
columns the one before it left.

    python retentioneering_check.py --serve     one JSON request per line on stdin, one answer per line
    python retentioneering_check.py < request   one request, one answer

A request: {"shape": {...}, "steps": [op, ...], "analyses": [analysis, ...]} (either list may be
empty). An answer: {"steps": [{"ok": true, "shape": {...}} | {"ok": false, "problem": "..."} |
{"ok": null, "note": "..."}], "analyses": [{"where": "...", "message": "..."}]}.
"""

import json
import os
import re
import sys

os.environ.setdefault("RETENTIONEERING_NO_TRACK", "1")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pandas as pd  # noqa: E402

from retentioneering_model import CHARTED, _Out, _stream, stream_columns  # noqa: E402

# The library's configuration errors — raised by what a step or an analysis was given, not by the
# rows (the data's own are EmptyEventstreamError, PatternNoMatchError and PathIdNotFoundError, left
# out). InvalidParameterError is also sklearn's, for a clustering parameter out of its range. A level
# the library does not find (SegmentLevelNotFoundError) counts only where the shape knows every level
# of that segment — elsewhere the stand-in carries the call's own constants as levels, so it is never
# raised. And DuckDB's own, raised by the SQL the library builds from a step's constants (a date
# compared with a number, an operator it does not know): the stand-ins' rows are clean, so one both
# raise alike is the call's.
CONFIG_ERRORS = {
    "PreprocessingConfigError", "PreprocessingColumnNotFoundError", "InvalidParameterError",
    "InvalidMetricConfigError", "PatternSyntaxError", "DiffConfigError", "SchemaConfigError",
    "InvalidSegmentSelectionError", "GridPointNotFoundError", "AmbiguousGridPointError", "MetricDistributionError",
    "SegmentLevelNotFoundError",
}
# The library's own checks that raise a plain Python error (a segment column that is not there is a
# ValueError): counted when the library itself raised it — its frame, not sklearn's, pandas' or ours.
PLAIN_ERRORS = {"ValueError", "KeyError", "TypeError"}
# A column name a table in either warehouse takes as it is
IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
# The fixed column names of an eventstream (src/retentioneering/eventstream.js ES_COLUMNS)
COLUMNS = {"user": "user_id", "event": "event", "time": "event_time"}
# How many events one stand-in path carries at most: every event is still on some path, since there are
# at least as many paths as events
PATH_EVENTS = 200
# The levels a stand-in segment carries when the shape does not know all of its own — never a real one
PLACEHOLDERS = {"~stand-in a~", "~stand-in b~", "~stand-in c~"}

_LIBRARY_DIR = []


def _raised_by_library(e):
    if not _LIBRARY_DIR:
        import retentioneering
        _LIBRARY_DIR.append(os.path.dirname(os.path.abspath(retentioneering.__file__)) + os.sep)
    tb, last = e.__traceback__, None
    while tb is not None:
        last, tb = tb, tb.tb_next
    return last is not None and os.path.abspath(last.tb_frame.f_code.co_filename).startswith(_LIBRARY_DIR[0])


def _counts(e):
    name = type(e).__name__
    if name in CONFIG_ERRORS or type(e).__module__.split(".")[0].lstrip("_") == "duckdb":
        return True
    return name in PLAIN_ERRORS and _raised_by_library(e)


def _constants(value, out):
    """Every scalar constant of the request — a segment whose levels the shape does not know in full
    carries them all as levels on the stand-in, so a level the call names is never refused there."""
    if isinstance(value, dict):
        for v in value.values():
            _constants(v, out)
    elif isinstance(value, (list, tuple)):
        for v in value:
            _constants(v, out)
    elif isinstance(value, (str, int, float, bool)):
        out.add(str(value))
    return out


def spec_of(shape):
    """The column spec _stream reads a stand-in (or a table of this shape) with."""
    return {"columns": {**COLUMNS, "paths": shape["paths"], "segments": list(shape["segments"]), "custom": shape.get("columns") or []}}


def stand_in(shape, constants, variant):
    """A small eventstream of `shape`: variant 0 gives every path a long run of the events (in an order
    of its own, some repeated), variant 1 short paths — so a metric, a quantile or a match differs
    between the two, while every name, path column and segment level is on both."""
    events = list(shape["events"])
    n = len(events)
    segments = shape["segments"]
    levels = {}
    for s, info in segments.items():
        known = [str(v) for v in (info.get("levels") or [])]
        levels[s] = known if info.get("complete") and known else sorted(set(known) | set(constants) | PLACEHOLDERS)
    widest = max([len(v) for v in levels.values()] or [0])
    users = max(47, n + 17, widest + 17) if variant else max(30, n, widest)
    start = pd.Timestamp("2026-01-05")
    user = shape["paths"][0]
    rows = []
    for u in range(users):
        if variant:
            names = [events[(u + j * 7) % n] for j in range(2 + u % 9)]
            gap = pd.Timedelta(minutes=17 * (1 + u % 3))
        else:
            run = events[u % n:] + events[:u % n]
            names = run[:PATH_EVENTS] + [events[u % n]] * (u % 4)
            gap = pd.Timedelta(minutes=1)
        for i, name in enumerate(names):
            row = {user: f"u{u}", COLUMNS["event"]: name, COLUMNS["time"]: start + pd.Timedelta(hours=u) + gap * i}
            for k, p in enumerate(shape["paths"][1:]):
                row[p] = f"u{u}#{k}.{1 + (i >= len(names) // 2)}"
            for k, s in enumerate(segments):
                row[s] = levels[s][(u + k + variant) % len(levels[s])]
            for c in shape.get("columns") or []:
                row[c] = i
            rows.append(row)
    return _stream(pd.DataFrame(rows), spec_of(shape))


def _attempt(fn):
    """(result, None) — or (None, the error) when a configuration error was raised, or (None, False)
    when anything else was (the rows' business)."""
    try:
        return fn(), None
    except Exception as e:  # noqa: BLE001 — which errors count is decided by their class
        return None, (f"{type(e).__name__}: {e}" if _counts(e) else False)


def shape_after(before, streams, constants):
    """The shape the step left, read off its stand-ins: the event names on either, the path columns,
    the segments (a segment whose values the step left inside what it had keeps its levels, and whether
    they were complete; one the step made or changed carries the values the stand-ins show, not known
    to be complete) and the custom columns."""
    held = stream_columns(streams[0])
    frames = [s.to_dataframe() for s in streams]
    events = sorted({str(e) for f, s in zip(frames, streams) for e in f[s.schema.event_col].unique()})
    segments = {}
    for name in held["segments"]:
        seen = {str(v) for f in frames for v in f[name].dropna().unique()}
        had = before["segments"].get(name)
        if had is not None and seen <= {str(v) for v in had.get("levels") or []} | constants | PLACEHOLDERS:
            segments[name] = had
        else:
            segments[name] = {"levels": sorted(seen - PLACEHOLDERS), "complete": False}
    return {"events": events, "paths": held["paths"], "segments": segments, "columns": held["custom"]}


def check_steps(shape, steps, constants):
    """Each step on the stand-ins of the shape before it → its outcome, until the first refused one."""
    from retentioneering.ops import apply_ops

    out = []
    streams = [stand_in(shape, constants, v) for v in (0, 1)] if shape["events"] else []
    for step in steps:
        if not streams:
            out.append({"ok": None, "note": "not checked: the stand-ins had no events left before this step"})
            continue
        # `path` is this tool's name for the library's path column: one the eventstream holds at this step
        # (the library itself reads a missing one only as a KeyError deep in pandas)
        held = list(streams[0].schema.path_cols)
        if step.get("path_col") is not None and step["path_col"] not in held:
            out.append({"ok": False, "problem": f"path '{step['path_col']}' is not a path column of the eventstream at this step (its path columns: {', '.join(held)}) — a split_sessions step before it makes one"})
            break
        tried = [_attempt(lambda s=s: apply_ops(s, [step])) for s in streams]
        errors = [e for _, e in tried]
        if all(isinstance(e, str) for e in errors) and len(set(errors)) == 1:
            out.append({"ok": False, "problem": errors[0]})
            break
        alive = [r for r, e in tried if e is None]
        if len(alive) < len(tried):
            reasons = sorted({e for e in errors if isinstance(e, str)})
            out.append({"ok": None, "note": "not checked in full: the stand-ins could not carry it" + (f" ({reasons[0]})" if reasons else "")})
            streams = []
            continue
        after, err = _attempt(lambda: shape_after(shape, alive, constants))
        if after is None:
            out.append({"ok": None, "note": "not checked in full: what the step left could not be read" + (f" ({err})" if err else "")})
            streams = []
            continue
        # a column a step makes is stored in the warehouse's table when the steps are materialized: its
        # name is an identifier there (what BigQuery and DuckDB both take unquoted)
        made = [c for c in after["paths"] + list(after["segments"]) + after["columns"] if c not in shape["paths"] + list(shape["segments"]) + (shape.get("columns") or [])]
        bad = [c for c in made if not IDENT.match(c)]
        if bad:
            out.append({"ok": False, "problem": f"'{bad[0]}' cannot be a column of the eventstream: a column name is letters, digits and underscores, starting with a letter or an underscore — the warehouse stores the eventstream after its steps as a table"})
            break
        out.append({"ok": True, "shape": after})
        shape, streams = after, alive
    return out


def check_analyses(shape, analyses, constants, edge_weights):
    """Each analysis on the stand-ins of the shape → the configuration errors both raise alike."""
    if not analyses or not shape["events"]:
        return []
    spec = {**spec_of(shape), "edge_weights": edge_weights}
    seen = []
    for variant in (0, 1):
        found = {}
        stream = stand_in(shape, constants, variant)
        for a in analyses:
            charted = CHARTED.get(a["kind"])
            if charted and a["params"].get("diff") is None:
                _, err = _attempt(lambda: charted(stream, spec, a, _Out()))
            else:
                _, err = _attempt(lambda: getattr(stream, a["method"])(**a["params"]))
            if isinstance(err, str):
                found[f"analyses.{a['id']}"] = err
        seen.append(found)
    return [{"where": w, "message": m} for w, m in seen[0].items() if seen[1].get(w) == m]


def answer(request):
    steps = request.get("steps") or []
    analyses = request.get("analyses") or []
    constants = _constants([steps, analyses], set())
    return {"steps": check_steps(request["shape"], steps, constants) if steps else [],
            "analyses": check_analyses(request["shape"], analyses, constants, request.get("edge_weights") or [])}


def serve():
    for line in sys.stdin:
        if not line.strip():
            continue
        request = None
        try:
            request = json.loads(line)
            reply = {"id": request.get("id"), **answer(request)}
        except Exception as e:  # noqa: BLE001 — a request the check cannot carry is answered, not fatal
            # answered under its own id, so the caller gets it now (as no check) instead of at its timeout
            reply = {"id": request.get("id") if isinstance(request, dict) else None, "error": f"{type(e).__name__}: {e}"}
        sys.stdout.write(json.dumps(reply) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    import retentioneering  # noqa: F401 — loaded once, before the first request
    if "--serve" in sys.argv:
        serve()
    else:
        json.dump(answer(json.load(sys.stdin)), sys.stdout)
