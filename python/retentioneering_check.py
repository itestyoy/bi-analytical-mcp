"""The library's own check of a path-analysis call, before the warehouse runtime is started.

A query starts one dbt Python model on the warehouse's runtime, which takes minutes to come up; a
parameter the library refuses would surface only then. So the server first runs the call HERE, on
the feature's own environment (the same pinned library), over two small stand-in eventstreams that
carry the eventstream's real event names, its path, session and segment columns — every step of the
call's preprocess and each analysis with its own, exactly as python/retentioneering_model.py runs
them. What the library refuses as a CONFIGURATION (an unknown event, a bad path pattern, a parameter
that needs another, a segment that does not exist at that step) is refused alike on both, and is
reported; the call is refused in seconds with the library's own message. What depends on the rows
(an empty result, a level no path has, a pattern that matches nothing) is left to the real data:
it differs between the stand-ins, or is of a class that says so.

    python retentioneering_check.py < {"spec": ..., "events": [...]}   →   {"problems": [...]}
"""

import json
import os
import sys

os.environ.setdefault("RETENTIONEERING_NO_TRACK", "1")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pandas as pd  # noqa: E402

from retentioneering_model import CHARTED, _Out, _stream  # noqa: E402

# The library's configuration errors — raised by what a step or an analysis was given, not by the
# rows (the data's own are EmptyEventstreamError, PatternNoMatchError, PathIdNotFoundError and
# SegmentLevelNotFoundError, left out). InvalidParameterError is also sklearn's, for a clustering
# parameter out of its range. And DuckDB's own, raised by the SQL the library builds from a step's
# constants (a date compared with a number, an operator it does not know): the stand-ins' rows are
# clean, so one both raise alike is the call's.
CONFIG_ERRORS = {
    "PreprocessingConfigError", "PreprocessingColumnNotFoundError", "InvalidParameterError",
    "InvalidMetricConfigError", "PatternSyntaxError", "DiffConfigError", "SchemaConfigError",
    "InvalidSegmentSelectionError", "GridPointNotFoundError", "AmbiguousGridPointError", "MetricDistributionError",
}


def _constants(value, out):
    """Every scalar constant of the call — a stand-in segment carries them all as levels, so that a
    level the call names is never refused here (whether the data has it is the data's question)."""
    if isinstance(value, dict):
        for v in value.values():
            _constants(v, out)
    elif isinstance(value, (list, tuple)):
        for v in value:
            _constants(v, out)
    elif isinstance(value, (str, int, float, bool)) and value is not None:
        out.add(value)
    return out


def stand_in(spec, events, variant):
    """A small eventstream of the call's own columns: variant 0 gives every path every event (in an
    order of its own, some repeated), variant 1 short paths that together cover them all — so a
    metric, a quantile or a match differs between the two, while every name is the same."""
    cols = spec["columns"]
    segs = list(cols.get("segments") or [])
    levels = ["level_a", "level_b", "level_c"] + sorted(_constants(spec, set()), key=repr)
    n = len(events)
    # two sizes that never agree, so a message that counts the paths differs between the two
    users = max(47, n + 17) if variant else 30
    start = pd.Timestamp("2026-01-05")
    rows = []
    for u in range(users):
        if variant:
            names = [events[(u + j * 7) % n] for j in range(2 + u % 9)]
            gap = pd.Timedelta(minutes=17 * (1 + u % 3))
        else:
            names = events[u % n:] + events[:u % n] + [events[u % n]] * (u % 4)
            gap = pd.Timedelta(minutes=1)
        for i, name in enumerate(names):
            row = {cols["user"]: f"u{u}", cols["event"]: name, cols["time"]: start + pd.Timedelta(hours=u) + gap * i}
            if cols.get("session"):
                row[cols["session"]] = f"u{u}#{1 + (i >= len(names) // 2)}"
            for k, s in enumerate(segs):
                row[s] = levels[(u + k + variant) % len(levels)]
            rows.append(row)
    return pd.DataFrame(rows)


# The library's own checks that raise a plain Python error (a segment column that is not there is a
# ValueError): counted when the library itself raised it — its frame, not sklearn's, pandas' or ours.
PLAIN_ERRORS = {"ValueError", "KeyError", "TypeError"}
LIBRARY_DIR = None


def _raised_by_library(e):
    global LIBRARY_DIR
    if LIBRARY_DIR is None:
        import retentioneering
        LIBRARY_DIR = os.path.dirname(os.path.abspath(retentioneering.__file__)) + os.sep
    tb = e.__traceback__
    last = None
    while tb is not None:
        last = tb
        tb = tb.tb_next
    return last is not None and os.path.abspath(last.tb_frame.f_code.co_filename).startswith(LIBRARY_DIR)


def _counts(e):
    name = type(e).__name__
    if name in CONFIG_ERRORS or type(e).__module__.split(".")[0].lstrip("_") == "duckdb":
        return True
    return name in PLAIN_ERRORS and _raised_by_library(e)


def _attempt(fn, where, found):
    """Run one step; a configuration error is recorded under `where`, anything else ends the check
    of that place (the rows' business). Returns what the step returned, or None."""
    try:
        return fn()
    except Exception as e:  # noqa: BLE001 — which errors count is decided by their class below
        if _counts(e):
            found[where] = f"{type(e).__name__}: {e}"
        return None


def check(spec, events):
    """The call's steps and analyses on both stand-ins → the configuration errors both raise alike."""
    from retentioneering.ops import apply_ops

    seen = []
    for variant in (0, 1):
        found = {}
        stream = _stream(stand_in(spec, events, variant), spec)
        base = _attempt(lambda: apply_ops(stream, spec["preprocess"]), "preprocess", found) if spec.get("preprocess") else stream
        if base is not None:
            for a in spec["analyses"]:
                where = f"analyses.{a['id']}"
                s = _attempt(lambda: apply_ops(base, a["preprocess"]), f"{where}.preprocess", found) if a.get("preprocess") else base
                if s is None:
                    continue
                charted = CHARTED.get(a["kind"])
                if charted and a["params"].get("diff") is None:
                    _attempt(lambda: charted(s, spec, a, _Out()), where, found)
                else:
                    _attempt(lambda: getattr(s, a["method"])(**a["params"]), where, found)
        seen.append(found)
    return [{"where": w, "message": m} for w, m in seen[0].items() if seen[1].get(w) == m]


if __name__ == "__main__":
    request = json.load(sys.stdin)
    json.dump({"problems": check(request["spec"], request["events"])}, sys.stdout)
