#!/usr/bin/env python3
"""The facts the retentioneering feature states about the library — EXTRACTED from it, never
written from its prose (CLAUDE.md: a fact about an external library is generated from that library).

Everything the feature's tool schemas offer is read HERE from the installed package and written to
config/retentioneering-facts.json:

  analyses   every headless analysis (each widget's `*_data` twin, and the Eventstream methods that
             return a result rather than a stream) with its parameters;
  ops        every preprocessing op of the library's own op model (retentioneering.ops.registered_ops —
             the `{"type": <op>, ...params}` steps `apply_ops`, `recipe()` and the library's MCP use)
             with its parameters;
  anchors, metrics, aggregations, clustering methods, edge weights — the library's constants.

Each parameter carries a JSON Schema generated from the library's own type hints (the processor
class's constructor, else the method's signature, else the type its numpy docstring names), its
default, whether it is required, and the first paragraph of its docstring. src/retentioneering/schema.js
builds every tool schema from this sheet; test/unit/retentioneering-feature.test.js holds them to it.

    .venvs/retentioneering/bin/python scripts/retentioneering-facts.py --write   # regenerate
    .venvs/retentioneering/bin/python scripts/retentioneering-facts.py --check   # exit 1 if stale
"""

import ast
import inspect
import itertools
import json
import os
import re
import sys
import typing
from datetime import date
from importlib import metadata

os.environ.setdefault("RETENTIONEERING_NO_TRACK", "1")

import pandas as pd  # noqa: E402
import retentioneering.data_processors as processors  # noqa: E402
from retentioneering import Eventstream  # noqa: E402
from retentioneering.metrics import condition_ast, metric_builder  # noqa: E402
from retentioneering.ops import registered_ops  # noqa: E402
from retentioneering.paths import anchors  # noqa: E402
from retentioneering.tools import segment_overview, cluster_analysis  # noqa: E402
from retentioneering.utils import clustering_methods  # noqa: E402

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "config", "retentioneering-facts.json")

# The analyses: the six widgets' headless twins (step matrix and step sankey share one — step_matrix_data
# is its alias), and the Eventstream methods that return a result, not a stream.
ANALYSES = {
    "transition_graph": "transition_graph_data",
    "step_matrix": "step_matrix_data",
    "step_sankey": "step_sankey_data",
    "funnel": "funnel_data",
    "cluster_analysis": "cluster_analysis_data",
    "segment_overview": "segment_overview_data",
    "conversion_rate": "get_conversion_rate",
    "metric_distribution": "get_metric_distribution",
    "path_metrics": "get_metrics",
    "describe": "describe",
}

SCALARS = {str: {"type": "string"}, int: {"type": "integer"}, float: {"type": "number"}, bool: {"type": "boolean"}}


def anchor_schema():
    """An anchor spec as the library defines it (paths.anchors): a pattern, or an object of its keys."""
    return {
        "oneOf": [
            {"type": "string", "description": "An event, or a '->'-separated pattern of events."},
            {
                "type": "object", "additionalProperties": False, "required": ["pattern"],
                "properties": {
                    "pattern": {"type": "string"},
                    "at": {"oneOf": [{"type": "integer"}, {"type": "string"}]},
                    "occurrence": {"enum": list(anchors.OCCURRENCES)},
                    "offset": {"oneOf": [{"type": "integer"}, {"type": "string"}]},
                    "offset_side": {"enum": list(anchors.OFFSET_SIDES)},
                    "event_col": {"type": "string"},
                },
            },
        ],
    }


def from_hint(t):
    """A JSON Schema for a Python type hint (None when the hint says nothing usable)."""
    if t is None or t is type(None):
        return None
    if t is typing.Any:
        return {}
    if t in SCALARS:
        return dict(SCALARS[t])
    if t is list or t is tuple or t is set:
        return {"type": "array"}
    if t is dict:
        return {"type": "object"}
    if t is pd.Timedelta:
        return {"type": "string", "description": "a duration, e.g. '30m'"}
    origin = typing.get_origin(t)
    args = typing.get_args(t)
    if origin is typing.Literal:
        return {"enum": list(args)}
    if origin in (typing.Union, getattr(__import__("types"), "UnionType", None)):
        parts = [from_hint(a) for a in args if a is not type(None)]
        parts = [p for p in parts if p is not None]
        if not parts:
            return None
        if any(p == {} for p in parts):
            return {}
        return parts[0] if len(parts) == 1 else {"anyOf": parts}
    if origin in (list, tuple, set, typing.Collection) or (origin is not None and getattr(origin, "__name__", "") in ("Collection", "Sequence", "Iterable")):
        item = from_hint(args[0]) if args else None
        return {"type": "array", **({"items": item} if item else {})}
    if origin is dict:
        value = from_hint(args[1]) if len(args) == 2 else None
        return {"type": "object", **({"additionalProperties": value} if value not in (None, {}) else {})}
    if callable(t) and getattr(t, "__name__", "") == "Callable" or origin is getattr(__import__("collections.abc", fromlist=["Callable"]), "Callable"):
        return None
    return {}


DOC_TYPES = {"str": {"type": "string"}, "int": {"type": "integer"}, "float": {"type": "number"}, "bool": {"type": "boolean"},
             "dict": {"type": "object"}, "list": {"type": "array"}, "tuple": {"type": "array"}}


def from_doc_type(text):
    """A JSON Schema for the type a numpy docstring names ('bool or list of str, optional')."""
    if not text:
        return None
    text = re.sub(r",?\s*optional\b", "", text).replace("{", "").replace("}", "").strip()
    parts = []
    for alt in re.split(r"\s+or\s+|\s*\|\s*", text):
        alt = alt.strip().strip("`")
        m = re.match(r"^(list|tuple) of (\w+)", alt)
        if m:
            item = DOC_TYPES.get(m.group(2)) or ({"type": "object"} if m.group(2) == "dict" else {})
            parts.append({"type": "array", **({"items": item} if item else {})})
        elif alt in DOC_TYPES:
            parts.append(dict(DOC_TYPES[alt]))
        elif alt.startswith("pd.Timedelta") or alt == "Timedelta":
            parts.append({"type": "string", "description": "a duration, e.g. '30m'"})
        elif re.match(r'^"[^"]+"(\s*,\s*"[^"]+")*$', alt):
            return {"enum": re.findall(r'"([^"]+)"', alt)}
        else:
            return {}
    if not parts:
        return None
    return parts[0] if len(parts) == 1 else {"anyOf": parts}


def doc_params(doc):
    """name → (type text, first paragraph) from a numpy-style Parameters section."""
    out = {}
    if not doc:
        return out
    m = re.search(r"Parameters\n-+\n(.*?)(?:\n\s*\n[A-Z][A-Za-z ]+\n-+\n|\Z)", doc, re.S)
    if not m:
        return out
    current = None
    for line in m.group(1).split("\n"):
        head = re.match(r"^(\w+)\s*:\s*(.*)$", line)
        if head and not line.startswith(" "):
            current = head.group(1)
            out[current] = [head.group(2).strip(), []]
        elif head and not line.startswith(" ") is False and re.match(r"^(\w+)\s*$", line):
            current = line.strip()
            out[current] = ["", []]
        elif current is not None:
            out[current][1].append(line.strip())
    result = {}
    for name, (typ, lines) in out.items():
        text = "\n".join(lines).strip()
        first = re.split(r"\n\s*\n", text)[0] if text else ""
        result[name] = (typ, re.sub(r"\s+", " ", first).strip())
    return result


def plain(value):
    if value is inspect.Parameter.empty:
        return None
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if isinstance(value, tuple):
        return list(value)
    return None


def _metric_arg_keys():
    """metric → the metric_args keys its branch of MetricConfig._parse_dict_config reads (directly, or
    through the library's own normalizer helpers it hands metric_args to) — read from the source."""
    tree = ast.parse(inspect.getsource(metric_builder))
    funcs = {n.name: n for n in tree.body if isinstance(n, ast.FunctionDef)}
    config = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "MetricConfig")
    parse = next(n for n in config.body if isinstance(n, ast.FunctionDef) and n.name == "_parse_dict_config")

    def is_args(n):
        return isinstance(n, ast.Name) and n.id == "metric_args"

    def keys_in(node, seen=()):
        keys = set()
        for n in ast.walk(node):
            if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "get" and is_args(n.func.value) and n.args and isinstance(n.args[0], ast.Constant):
                keys.add(n.args[0].value)
            if isinstance(n, ast.Subscript) and is_args(n.value) and isinstance(n.slice, ast.Constant):
                keys.add(n.slice.value)
            if isinstance(n, ast.Compare) and isinstance(n.left, ast.Constant) and isinstance(n.left.value, str) and any(is_args(c) for c in n.comparators):
                keys.add(n.left.value)
            if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id in funcs and n.func.id not in seen and any(is_args(a) for a in n.args):
                keys |= keys_in(funcs[n.func.id], seen + (n.func.id,))
        return keys

    out = {}
    for stmt in parse.body:
        node = stmt if isinstance(stmt, ast.If) else None
        while node is not None:
            t = node.test
            if isinstance(t, ast.Compare) and isinstance(t.left, ast.Name) and t.left.id == "metric":
                c = t.comparators[0]
                names = [c.value] if isinstance(c, ast.Constant) else [e.value for e in c.elts] if isinstance(c, ast.Tuple) else []
                keys = set()
                for b in node.body:
                    keys |= keys_in(b)
                for name in names:
                    out[name] = sorted(keys)
            node = node.orelse[0] if len(node.orelse) == 1 and isinstance(node.orelse[0], ast.If) else None
    return out


def _metric_args():
    """metric → {key: {schema, required}}: what each metric's arguments ARE, as the library accepts them.

    The keys come from the parser's source (_metric_arg_keys); what each takes is PROBED — every
    combination of candidate values is put through the library's own parse, validation and computation
    on a two-path eventstream, and a key keeps the value kinds it was checked for (a value accepted where
    another was refused). A key the library never accepts (a sibling flavour's spelling it rejects) is
    dropped; a key present in every accepted combination is required."""
    frame = pd.DataFrame({"user_id": ["u", "u", "v"], "event": ["e", "e", "e"],
                          "timestamp": pd.to_datetime(["2024-01-01", "2024-01-02", "2024-01-01"]), "seg": ["e", "e", "e"]})
    stream = Eventstream(frame, schema={"path_cols": ["user_id"], "event_col": "event", "timestamp_col": "timestamp", "segment_cols": ["seg"]})
    builder = metric_builder.MetricBuilder(stream)
    modes = sorted(metric_builder.IN_SEGMENT_MODES)
    # (kind, value): an event and a level ("e"), a column ("seg"), a list of them, numbers, a flag, the modes
    candidates = [("string", "e"), ("string", "seg"), ("array", ["e"]), ("integer", 1), ("number", 0.5), ("boolean", True)] + [("mode", m) for m in modes]

    def accepted(metric, args):
        cfg = {"metric": metric, "metric_args": args}
        try:
            metric_builder.MetricConfig([cfg], available_events=["e"])
            builder.validate_metric_config(cfg)
            stream.get_metrics([cfg])
            return True
        except Exception:  # noqa: BLE001 — a refusal is the answer being probed
            return False

    out = {}
    for metric, keys in _metric_arg_keys().items():
        results = {}
        for combo in itertools.product([None, *range(len(candidates))], repeat=len(keys)):
            results[combo] = accepted(metric, {k: candidates[i][1] for k, i in zip(keys, combo) if i is not None})
        good = [c for c, ok in results.items() if ok]
        spec = {}
        for pos, key in enumerate(keys):
            seen = {c[pos] for c in good if c[pos] is not None}
            if not seen:
                continue
            checked = {c[pos] for c in good if c[pos] is not None and any(not results[c[:pos] + (j,) + c[pos + 1:]] for j in range(len(candidates)))}
            kinds = {candidates[i][0] for i in (checked or seen)}
            values = {candidates[i][1] for i in (checked or seen) if candidates[i][0] in ("mode",)}
            parts = []
            if "string" in kinds:
                parts.append({"type": "string"})
            elif values:
                parts.append({"enum": [m for m in modes if m in values]})
            if "array" in kinds:
                parts.append({"type": "array", "items": {"type": "string"}})
            if "number" in kinds:
                parts.append({"type": "number"})
            elif "integer" in kinds:
                parts.append({"type": "integer"})
            elif "boolean" in kinds:
                parts.append({"type": "boolean"})
            schema = parts[0] if len(parts) == 1 else {"anyOf": parts}
            spec[key] = {"schema": schema, "required": all(c[pos] is not None for c in good)}
        out[metric] = spec
    return out


METRIC_ARGS = None


CONDITION_REF = "#/$defs/retentioneering_condition"


def condition_schema(grammar):
    """A condition node as JSON Schema: a comparison leaf per metric (with that metric's own arguments),
    AND/OR over `args`, NOT over one arg. Recursive through CONDITION_REF."""
    primitive = [{"type": "string"}, {"type": "number"}, {"type": "boolean"}]
    leaves = []
    for metric in sorted(set(metric_builder.VALID_METRICS) - set(grammar["forbidden_metrics"])):
        args = METRIC_ARGS.get(metric, {})
        required = sorted(k for k, a in args.items() if a["required"])
        leaf = {
            "type": "object", "additionalProperties": False, "title": metric,
            "required": ["op", "metric", "value", *(["metric_args"] if required else [])],
            "properties": {
                "op": {"enum": [*grammar["compare"], grammar["membership"]]},
                "metric": {"const": metric},
                "value": {"anyOf": [*primitive, {"type": "array", "minItems": 1, "items": {"anyOf": primitive}}], "description": f"A constant; a list of them for '{grammar['membership']}'."},
            },
        }
        if args:
            leaf["properties"]["metric_args"] = {"type": "object", "additionalProperties": False, **({"required": required} if required else {}), "properties": {k: a["schema"] for k, a in sorted(args.items())}}
        leaves.append(leaf)
    node = {"$ref": CONDITION_REF}
    return {"oneOf": [
        *leaves,
        {"type": "object", "additionalProperties": False, "title": "/".join(grammar["logical"]), "required": ["op", "args"],
         "properties": {"op": {"enum": grammar["logical"]}, "args": {"type": "array", "minItems": 1, "items": node}}},
        {"type": "object", "additionalProperties": False, "title": grammar["negation"], "required": ["op", "args"],
         "properties": {"op": {"const": grammar["negation"]}, "args": {"type": "array", "minItems": 1, "maxItems": 1, "items": node}}},
    ]}


def condition_grammar():
    """The operators a metric condition (filter_paths' `condition`, a collapse_events name case) is
    built from — read out of condition_ast.ast_to_sql, which is where the library decides them: the
    `op.upper()` it compares with AND/OR (branches over `args`), NOT (one arg), IN (a list `value`),
    and the set of comparison operators, with the alias it maps onto `=`."""
    fn = next(n for n in ast.parse(inspect.getsource(condition_ast)).body if isinstance(n, ast.FunctionDef) and n.name == "ast_to_sql")
    upper, compare, alias = [], [], []
    for n in ast.walk(fn):
        if isinstance(n, ast.Compare) and isinstance(n.left, ast.Call) and isinstance(n.left.func, ast.Attribute) and n.left.func.attr == "upper":
            c = n.comparators[0]
            upper.append([e.value for e in c.elts] if isinstance(c, (ast.Set, ast.Tuple, ast.List)) else [c.value])
        if isinstance(n, ast.Compare) and isinstance(n.left, ast.Name) and n.left.id == "op" and isinstance(n.ops[0], ast.NotIn) and isinstance(n.comparators[0], ast.Set):
            compare = [e.value for e in n.comparators[0].elts]
        if isinstance(n, ast.Compare) and isinstance(n.left, ast.Name) and n.left.id == "op" and isinstance(n.ops[0], ast.Eq) and isinstance(n.comparators[0], ast.Constant):
            alias.append(n.comparators[0].value)
    logical = next(g for g in upper if len(g) > 1)
    single = [g[0] for g in upper if len(g) == 1]
    order = ["=", "!=", ">", ">=", "<", "<="]
    return {
        "logical": sorted(v.lower() for v in logical),
        "negation": next(v.lower() for v in single if v not in ("IN",) and v not in logical),
        "membership": next(v.lower() for v in single if v == "IN"),
        "compare": sorted(compare, key=lambda o: order.index(o) if o in order else len(order)) + alias,
        "forbidden_metrics": sorted(condition_ast.FORBIDDEN_IN_CONDITIONS),
    }


_PROBE = {}


def _probe_stream():
    """Twenty two-level paths — enough for the library to cluster, split and roll up."""
    if "stream" not in _PROBE:
        rows = []
        for u in range(20):
            for i in range(2 + u % 5):
                rows.append((f"u{u}", ["a", "b", "c"][(u + i) % 3], pd.Timestamp("2024-01-01") + pd.Timedelta(minutes=10 * i), "x" if u % 2 else "y"))
        frame = pd.DataFrame(rows, columns=["user_id", "event", "timestamp", "seg"])
        _PROBE["stream"] = Eventstream(frame, schema={"path_cols": ["user_id"], "event_col": "event", "timestamp_col": "timestamp", "segment_cols": ["seg"]})
    return _PROBE["stream"]


# the other required parameters a probe call needs (a path metric, a segment column, a new name, and a
# fixed cluster count, since the library's default range needs more paths than a probe has)
PROBE_ARGS = {"features": [{"metric": "length"}], "segment_col": "seg", "name": "probe", "metric": {"metric": "length"}, "metrics": [{"metric": "length"}]}


def agg_mode(method, param, many):
    """Whether this metric-config parameter rolls values up with `agg` — PROBED on the library: the same
    call with agg "mean" and with agg "median" must both run AND differ (a parameter that ignores the key
    returns the same thing), and a call without it tells whether it is required."""
    stream = _probe_stream()
    names = inspect.signature(method).parameters
    base = {k: v for k, v in PROBE_ARGS.items() if k in names and k != param and names[k].default is inspect.Parameter.empty}
    if "method_args" in names:
        base["method_args"] = {"n_clusters": 2}

    def run(config):
        try:
            out = getattr(stream, method.__name__)(**base, **{param: [config] if many else config})
            return repr(out.to_dataframe() if hasattr(out, "to_dataframe") else out)
        except Exception:  # noqa: BLE001 — a refusal is the answer being probed
            return None

    mean = run({"metric": "length", "agg": "mean"})
    median = run({"metric": "length", "agg": "median"})
    if mean is None or median is None or mean == median:
        return None
    return "optional" if run({"metric": "length"}) is not None else "required"


def metric_config_schema(mode, many):
    """A path-metric config as the library's metric registry defines it: one branch per metric of its own
    list, each with exactly the arguments that metric takes, and — where the parameter rolls the values up
    (agg_mode) — an aggregation of its own list."""
    rolls_up = mode is not None
    branches = []
    for metric in sorted(metric_builder.VALID_METRICS):
        args = METRIC_ARGS.get(metric, {})
        required = sorted(k for k, a in args.items() if a["required"])
        branch = {
            "type": "object", "additionalProperties": False, "title": metric,
            "required": ["metric", *(["metric_args"] if required else []), *(["agg"] if mode == "required" else [])],
            "properties": {"metric": {"const": metric}},
        }
        if args:
            branch["properties"]["metric_args"] = {
                "type": "object", "additionalProperties": False,
                **({"required": required} if required else {}),
                "properties": {k: a["schema"] for k, a in sorted(args.items())},
            }
        if rolls_up:
            branch["properties"]["agg"] = {"enum": sorted(segment_overview.AGG_FUNCTIONS) + ["complement_distance"]}
        branches.append(branch)
    item = {"type": "object", "required": ["metric"], "oneOf": branches, "discriminator": {"propertyName": "metric"}}
    return {"type": "array", "items": item} if many else item


# What the library narrows only by its own constants, not in the signature: the clustering method and
# scaler of cluster_analysis_data (typed there as plain str) are the same Literals add_clusters declares.
CONSTANT_OVERRIDES = {
    ("cluster_analysis_data", "method"): lambda: {"enum": list(typing.get_args(cluster_analysis.T_ClusteringMethod))},
    ("cluster_analysis_data", "scaler"): lambda: {"enum": list(typing.get_args(typing.get_args(cluster_analysis.T_Scaler)[0]))},
}


def params_of(method, processor=None):
    sig = inspect.signature(method)
    method_hints = typing.get_type_hints(method)
    class_hints = typing.get_type_hints(processor.__init__) if processor else {}
    docs = doc_params(inspect.getdoc(method))
    out = []
    for p in sig.parameters.values():
        if p.name == "self" or p.kind in (p.VAR_POSITIONAL, p.VAR_KEYWORD):
            continue
        doc_type, doc_text = docs.get(p.name, ("", ""))
        if "anchor" in p.name:
            schema = anchor_schema()
            if "list" in doc_type:
                schema = {"oneOf": [*anchor_schema()["oneOf"], {"type": "array", "items": anchor_schema()}]}
        elif (method.__name__, p.name) in CONSTANT_OVERRIDES:
            schema = CONSTANT_OVERRIDES[(method.__name__, p.name)]()
        elif re.match(r"condition tree", doc_text, re.I):
            # the grammar is one definition (condition_schema), placed in the tool schema's $defs
            schema = {"anyOf": [{"$ref": CONDITION_REF}, {"type": "array", "minItems": 1, "items": {"$ref": CONDITION_REF}}]}
        elif re.search(r"metric config", doc_text, re.I):
            many = not doc_type.strip().startswith("dict")
            schema = metric_config_schema(agg_mode(method, p.name, many), many)
        else:
            schema = None
            for source in (class_hints.get(p.name), method_hints.get(p.name)):
                if source is not None:
                    schema = from_hint(source)
                    if schema not in (None, {}):
                        break
            if schema in (None, {}):
                schema = from_doc_type(doc_type) or schema or {}
        entry = {"name": p.name, "required": p.default is inspect.Parameter.empty, "schema": schema}
        if p.default is not inspect.Parameter.empty and plain(p.default) is not None:
            entry["default"] = plain(p.default)
        if doc_text:
            entry["doc"] = doc_text
        out.append(entry)
    return out


def summary_line(method):
    doc = inspect.getdoc(method) or ""
    return re.sub(r"\s+", " ", re.split(r"\n\s*\n", doc)[0]).strip()


def processor_class(op):
    camel = "".join(part.capitalize() for part in op.split("_"))
    cls = getattr(processors, camel, None)
    return cls if inspect.isclass(cls) else None


def dedupe(schema):
    """The same alternative twice (two hints naming one JSON type) is one alternative."""
    if isinstance(schema, dict):
        schema = {k: dedupe(v) for k, v in schema.items()}
        for key in ("anyOf", "oneOf"):
            if key in schema:
                unique = []
                for part in schema[key]:
                    if part not in unique:
                        unique.append(part)
                if len(unique) == 1 and len(schema) == 1:
                    return unique[0]
                schema[key] = unique
        return schema
    if isinstance(schema, list):
        return [dedupe(v) for v in schema]
    return schema


def build():
    global METRIC_ARGS
    METRIC_ARGS = _metric_args()
    edge = typing.get_args(typing.get_type_hints(Eventstream.transition_graph_data)["edge_weight"])
    return {
        "library": "retentioneering",
        "note": "Generated by scripts/retentioneering-facts.py from the installed library — do not hand-edit.",
        "version": metadata.version("retentioneering"),
        "generated_on": date.today().isoformat(),
        "analyses": dedupe({kind: {"method": m, "summary": summary_line(getattr(Eventstream, m)), "params": params_of(getattr(Eventstream, m))} for kind, m in ANALYSES.items()}),
        "ops": dedupe({op: {"summary": summary_line(getattr(Eventstream, op)), "params": params_of(getattr(Eventstream, op), processor_class(op))} for op in sorted(registered_ops())}),
        "metric_args": {m: {k: a for k, a in sorted(args.items())} for m, args in sorted(METRIC_ARGS.items())},
        "edge_weights": list(edge),
        "path_metrics": sorted(metric_builder.VALID_METRICS),
        "in_segment_modes": sorted(metric_builder.IN_SEGMENT_MODES),
        "synthetic_events": sorted(metric_builder.SYNTHETIC_EVENTS),
        "segment_aggs": sorted(segment_overview.AGG_FUNCTIONS) + ["complement_distance"],
        "cluster_methods": list(typing.get_args(cluster_analysis.T_ClusteringMethod)),
        "cluster_method_args": {m: sorted(keys) for m, keys in clustering_methods.METHOD_ARGS.items()},
        "cluster_scalers": list(typing.get_args(typing.get_args(cluster_analysis.T_Scaler)[0])) if typing.get_args(cluster_analysis.T_Scaler) else [],
        "condition": condition_grammar(),
        "condition_schema": condition_schema(condition_grammar()),
        "anchor_keys": sorted(anchors.SPEC_KEYS),
        "anchor_occurrences": list(anchors.OCCURRENCES),
        "anchor_offset_sides": list(anchors.OFFSET_SIDES),
    }


def normalized(facts):
    return {k: v for k, v in facts.items() if k != "generated_on"}


def main(argv):
    facts = build()
    if "--check" in argv:
        try:
            with open(OUT, encoding="utf-8") as f:
                current = json.load(f)
        except FileNotFoundError:
            print(f"{OUT} is missing", file=sys.stderr)
            return 1
        if normalized(current) != normalized(facts):
            print(f"{OUT} is stale for retentioneering {facts['version']} — regenerate with --write", file=sys.stderr)
            return 1
        print(f"{OUT} matches retentioneering {facts['version']}")
        return 0
    if "--write" in argv:
        with open(OUT, "w", encoding="utf-8") as f:
            json.dump(facts, f, indent=2, sort_keys=False, ensure_ascii=False)
            f.write("\n")
        print(f"wrote {OUT} (retentioneering {facts['version']})")
        return 0
    json.dump(facts, sys.stdout, indent=2, ensure_ascii=False)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
