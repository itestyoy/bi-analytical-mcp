#!/usr/bin/env python3
"""Extract, from the BigFrames library ITSELF, the facts our python-stage guide states.

Why this exists. The guide we hand the model says which operations raise on the frame `dbt.ref()`
returns in partial-ordering mode. Written from the vendor's prose, it was wrong in both directions:
we told callers `head(n)` "returns different rows between runs" (it raises), that `nlargest` "orders
by itself" (it needs an ordering unless keep='all'), that `unique()`/`drop_duplicates()` "do not
work" (one of them does, and the other has a keyword that makes it work), and we handed them
`std(ddof=0)`, a parameter this library does not have. Every one of those is decided by code that
can simply be read:

  * `@validations.requires_index`     → raises NullIndexError      (bigframes/core/validations.py)
  * `@validations.requires_ordering()`→ raises OrderRequiredError unless the frame is
                                         explicitly ordered (i.e. after sort_values/sort_index)
  * `validations.enforce_ordered(...)` called inside a body → the same rule, but per keyword
  * the signature of a method            → which parameters exist at all

So: read it, write it down with the version it came from, and let a test compare the guide against
it. This script does the reading.

Usage
  python3 scripts/bigframes-facts.py --write            # from the INSTALLED bigframes
  python3 scripts/bigframes-facts.py --write --source /path/to/site-packages/bigframes
  python3 scripts/bigframes-facts.py --check [...]      # exit 1 if the checked-in file differs

`--source` parses the library's files (no install needed, no BigQuery needed); without it the
installed package is imported and the decorators' own markers are read. Both produce the same
document; the source mode also records the line numbers the facts came from.
"""

from __future__ import annotations

import argparse
import ast
import datetime as _dt
import importlib
import inspect
import json
import pathlib
import sys

OUT = pathlib.Path(__file__).resolve().parent.parent / "config" / "bigframes-facts.json"
CLASSES = {"DataFrame": "dataframe.py", "Series": "series.py"}
# The ml modules whose estimators a python stage plausibly builds. bigframes.ml is a WRAPPER OVER
# BQML, not a port of scikit-learn: each constructor takes the options its BQML model type has, under
# BQML's names, and an sklearn parameter that has no BQML option simply does not exist (the observed
# failure: KMeans(standardize_features=True) → TypeError). So the parameter lists are read from the
# library and written down, per class, including which ones are KEYWORD-ONLY.
ML_MODULES = ["cluster", "linear_model", "ensemble", "decomposition", "preprocessing", "impute", "compose", "pipeline", "model_selection", "forecasting"]
# Signatures worth recording verbatim: each one is a parameter a caller is likely to reach for.
SIGNATURES = {
    "DataFrame": ["std", "var", "quantile", "head", "nlargest", "peek", "cache", "sort_values", "merge", "join"],
    "Series": ["std", "var", "quantile", "head", "nlargest", "unique", "drop_duplicates", "peek", "cache", "map", "sort_values"],
}


def _decorator_name(node: ast.expr) -> str:
    """`validations.requires_ordering()` → 'validations.requires_ordering'."""
    if isinstance(node, ast.Call):
        return _decorator_name(node.func)
    if isinstance(node, ast.Attribute):
        return f"{_decorator_name(node.value)}.{node.attr}"
    if isinstance(node, ast.Name):
        return node.id
    return ""


def _enforced_in_body(fn: ast.FunctionDef) -> list[str]:
    """Calls to enforce_ordered(...) inside the body — the per-keyword form (unique, nlargest)."""
    found = []
    for node in ast.walk(fn):
        if isinstance(node, ast.Call) and _decorator_name(node.func).endswith("enforce_ordered"):
            arg = node.args[1] if len(node.args) > 1 else None
            found.append(arg.value if isinstance(arg, ast.Constant) else "enforce_ordered")
    return found


def from_source(root: pathlib.Path) -> dict:
    version = None
    vfile = root / "version.py"
    if vfile.exists():
        for line in vfile.read_text().splitlines():
            if line.startswith("__version__"):
                version = line.split("=", 1)[1].strip().strip("\"'")
    facts = {"requires_index": {}, "requires_ordering": {}, "ordering_enforced_by_argument": {}, "signatures": {}, "where": {}}
    for cls, fname in CLASSES.items():
        tree = ast.parse((root / fname).read_text())
        target = next((n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == cls), None)
        if target is None:
            raise SystemExit(f"{fname}: class {cls} not found")
        idx, order, byarg, sigs, where = [], [], {}, {}, {}
        for fn in target.body:
            if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            decs = [_decorator_name(d) for d in fn.decorator_list]
            if any(d.endswith("requires_index") for d in decs):
                idx.append(fn.name)
                where[fn.name] = f"{fname}:{fn.lineno}"
            if any(d.endswith("requires_ordering") for d in decs):
                order.append(fn.name)
                where[fn.name] = f"{fname}:{fn.lineno}"
            enforced = _enforced_in_body(fn)
            if enforced and fn.name not in order:
                byarg[fn.name] = enforced
                where[fn.name] = f"{fname}:{fn.lineno}"
            if fn.name in SIGNATURES.get(cls, []):
                args = [a.arg for a in fn.args.args] + [a.arg for a in fn.args.kwonlyargs]
                sigs[fn.name] = [a for a in args if a != "self"]
                where[fn.name] = f"{fname}:{fn.lineno}"
        facts["requires_index"][cls] = sorted(set(idx))
        facts["requires_ordering"][cls] = sorted(set(order))
        facts["ordering_enforced_by_argument"][cls] = byarg
        facts["signatures"][cls] = sigs
        facts["where"][cls] = where
    facts["ml"] = _ml_from_source(root)
    return {"version": version, "read_from": "source", **facts}


def _params(fn: ast.FunctionDef) -> dict:
    """Positional and keyword-only parameter names of a def, self dropped."""
    return {
        "positional": [a.arg for a in fn.args.args if a.arg != "self"],
        "keyword_only": [a.arg for a in fn.args.kwonlyargs],
    }


def _ml_from_source(root: pathlib.Path) -> dict:
    """Constructor parameters of every public bigframes.ml estimator, per module."""
    out = {}
    for mod in ML_MODULES:
        f = root / "ml" / f"{mod}.py"
        if not f.exists():
            continue
        tree = ast.parse(f.read_text())
        entries = {}
        for n in tree.body:
            if isinstance(n, ast.ClassDef) and not n.name.startswith("_"):
                init = next((b for b in n.body if isinstance(b, ast.FunctionDef) and b.name == "__init__"), None)
                entries[n.name] = _params(init) if init else {"positional": [], "keyword_only": []}
            elif isinstance(n, ast.FunctionDef) and not n.name.startswith("_"):
                entries[f"{n.name}()"] = _params(n)
        if entries:
            out[mod] = entries
    return out


def from_installed() -> dict:
    bf = importlib.import_module("bigframes")
    mods = {"DataFrame": importlib.import_module("bigframes.dataframe"), "Series": importlib.import_module("bigframes.series")}
    facts = {"requires_index": {}, "requires_ordering": {}, "ordering_enforced_by_argument": {}, "signatures": {}, "where": {}}
    for cls, mod in mods.items():
        target = getattr(mod, cls)
        idx, order, sigs = [], [], {}
        for name, member in inspect.getmembers(target):
            fn = member.fget if isinstance(member, property) else member
            if getattr(fn, "_validations_requires_index", False):
                idx.append(name)
            if getattr(fn, "_validations_requires_ordering", False):
                order.append(name)
            if name in SIGNATURES.get(cls, []) and callable(fn):
                try:
                    sigs[name] = [p for p in inspect.signature(fn).parameters if p != "self"]
                except (TypeError, ValueError):
                    pass
        facts["requires_index"][cls] = sorted(set(idx))
        facts["requires_ordering"][cls] = sorted(set(order))
        facts["ordering_enforced_by_argument"][cls] = {}  # only visible in the source
        facts["signatures"][cls] = sigs
        facts["where"][cls] = {}
    facts["ml"] = _ml_from_installed()
    return {"version": getattr(bf, "__version__", None), "read_from": "installed", **facts}


def _ml_from_installed() -> dict:
    out = {}
    for mod_name in ML_MODULES:
        try:
            mod = importlib.import_module(f"bigframes.ml.{mod_name}")
        except ImportError:
            continue
        entries = {}
        for name, member in vars(mod).items():
            if name.startswith("_") or getattr(member, "__module__", None) != mod.__name__:
                continue
            if inspect.isclass(member):
                try:
                    sig = inspect.signature(member.__init__)
                except (TypeError, ValueError):
                    continue
                entries[name] = {
                    "positional": [p.name for p in sig.parameters.values() if p.name != "self" and p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD)],
                    "keyword_only": [p.name for p in sig.parameters.values() if p.kind == p.KEYWORD_ONLY],
                }
            elif inspect.isfunction(member):
                sig = inspect.signature(member)
                entries[f"{name}()"] = {
                    "positional": [p.name for p in sig.parameters.values() if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD)],
                    "keyword_only": [p.name for p in sig.parameters.values() if p.kind == p.KEYWORD_ONLY],
                }
        if entries:
            out[mod_name] = entries
    return out


# The rules that are NOT a list of method names: why alignment fails, what merge is, what an
# estimator returns. Each carries the place in the library that decides it, so the claim can be
# re-read rather than believed. Kept here (not in the JSON by hand) so the whole document is
# produced by one command.
RULES = [
    {
        "id": "align_needs_common_root",
        "claim": "Two objects with no index can be combined ONLY when they descend from the same "
                 "table expression (a projection/filter/window of one frame). Otherwise the align "
                 "path raises NullIndexError('Cannot implicitly align objects').",
        "evidence": "core/blocks.py Block.join → try_legacy_row_join → "
                    "core/rewrite/legacy_align.py legacy_join_as_projection requires common_selection_root",
    },
    {
        "id": "setitem_is_the_align_path",
        "claim": "df[\"c\"] = series goes through that same join, so a Series from ANOTHER frame "
                 "(a local frame, a cache()d frame, a groupby aggregate, an ml result) raises.",
        "evidence": "dataframe.py DataFrame._assign_series_join_on_index_to_col_ids → self._block.join(series._block, how='left')",
    },
    {
        "id": "one_side_indexed_raises",
        "claim": "If one side HAS an index and the other has none, the row-join path is skipped "
                 "entirely and NullIndexError is raised — which is why Series.map(dict) always "
                 "fails here: it builds a local frame, set_index()es it, and joins.",
        "evidence": "core/blocks.py Block.join → _throw_if_null_index('join'); series.py Series.map",
    },
    {
        "id": "merge_is_a_relational_join",
        "claim": "DataFrame.merge(on=<columns>) compiles to a SQL join and needs no index. "
                 "DataFrame.join(...) is the align path — the two are not interchangeable.",
        "evidence": "core/reshape/merge.py merge → core/blocks.py Block.merge → expr.relational_join",
    },
    {
        "id": "sort_values_grants_ordering",
        "claim": "An operation that requires an ordering is allowed once the frame is explicitly "
                 "ordered: the node sort_values creates reports explicitly_ordered=True, while the "
                 "table read reports order_ambiguous=True / explicitly_ordered=False.",
        "evidence": "core/validations.py enforce_ordered; core/nodes.py OrderByNode.explicitly_ordered, ReadTableNode.order_ambiguous",
    },
    {
        "id": "ml_predict_rereads_and_keeps_input_columns",
        "claim": "bigframes.ml predict/transform wrap the input in a SQL TVF and RE-READ the result "
                 "(read_gbq_query), so the result is a different root — assigning its column into "
                 "the input frame raises. It is not needed: the TVF output already contains every "
                 "input column plus the new ones, so return that frame.",
        "evidence": "ml/core.py BqmlModel._apply_ml_tvf (docstring: 'must include all input columns, with new columns appended')",
    },
    {
        "id": "cache_replaces_the_node",
        "claim": "cache() materializes to a temporary table and swaps the object's own node for a "
                 "read of it, returning self. Objects derived BEFORE the call keep the old root, so "
                 "mixing them with the cached frame raises — derive everything after caching.",
        "evidence": "dataframe.py DataFrame._cached → Block.cached(force=…)",
    },
    {
        "id": "ml_is_bqml_not_sklearn",
        "claim": "bigframes.ml estimators are WRAPPERS OVER BQML, not a port of scikit-learn. A "
                 "constructor accepts only the options its BQML model type has, under BQML's names "
                 "(KMeans: n_clusters, init, init_col, distance_type, max_iter, tol, warm_start — "
                 "and every one but the first is KEYWORD-ONLY). An sklearn parameter with no BQML "
                 "option does not exist: KMeans(standardize_features=True), n_init, random_state, "
                 "algorithm all raise TypeError: __init__() got an unexpected keyword argument. "
                 "The parameter lists in `ml` here are the whole surface.",
        "evidence": "ml/cluster.py KMeans.__init__ (keyword-only after n_clusters) and its "
                    "_BQML_PARAMS_MAPPING / _bqml_options, which map each parameter to a BQML "
                    "CREATE MODEL option",
    },
    {
        "id": "ml_scaling_is_a_transformer",
        "claim": "There is no scaling flag on an estimator. Scaling is its own transformer "
                 "(preprocessing.StandardScaler / MaxAbsScaler / MinMaxScaler, none of which takes "
                 "any parameter) used either on its own or as the FIRST step of ml.pipeline.Pipeline "
                 "— which takes EXACTLY TWO steps, (transform, estimator), and raises "
                 "NotImplementedError for anything else. Scaling done in SQL before the stage is "
                 "equally valid and cheaper.",
        "evidence": "ml/preprocessing.py StandardScaler.__init__(self); ml/pipeline.py "
                    "Pipeline.__init__ (len(steps) != 2 → NotImplementedError, and the transform "
                    "must be one of the listed transformers / ColumnTransformer)",
    },
    {
        "id": "peek_returns_pandas",
        "claim": "peek(n) returns a pandas object (an arbitrary sample, no ordering needed) — it is "
                 "for looking, never the value a model returns.",
        "evidence": "series.py Series.peek / dataframe.py DataFrame.peek",
    },
    {
        "id": "single_quantile_is_a_scalar",
        "claim": "quantile(q) with ONE q returns a real float (it executes and squeezes); with a "
                 "list it builds an indexed Series via transpose, which is the form to avoid here.",
        "evidence": "series.py Series.quantile",
    },
]


def build(source: pathlib.Path | None) -> dict:
    facts = from_source(source) if source else from_installed()
    return {
        "library": "bigframes",
        "note": "Generated by scripts/bigframes-facts.py from the library itself — do not hand-edit. "
                "The guide in src/python-guide.js is checked against this file "
                "(test/unit/bigframes-facts.test.js).",
        "generated_on": _dt.date.today().isoformat(),
        **facts,
        "rules": RULES,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", type=pathlib.Path, help="path to the bigframes package directory (parse instead of import)")
    ap.add_argument("--write", action="store_true", help="write config/bigframes-facts.json")
    ap.add_argument("--check", action="store_true", help="compare with the checked-in file; exit 1 on a difference")
    args = ap.parse_args()
    if not (args.write or args.check):
        ap.error("pass --write or --check")

    fresh = build(args.source)
    if args.write:
        OUT.write_text(json.dumps(fresh, indent=2, ensure_ascii=False) + "\n")
        print(f"wrote {OUT} (bigframes {fresh['version']}, read from {fresh['read_from']})")
        return 0

    current = json.loads(OUT.read_text())
    drop = ("generated_on", "read_from", "where")  # provenance, not facts
    same = {k: v for k, v in current.items() if k not in drop} == {k: v for k, v in fresh.items() if k not in drop}
    if same:
        print(f"config/bigframes-facts.json matches bigframes {fresh['version']}")
        return 0
    print(f"config/bigframes-facts.json does NOT match bigframes {fresh['version']}:", file=sys.stderr)
    for key in sorted(set(current) | set(fresh)):
        if key in drop:
            continue
        if current.get(key) != fresh.get(key):
            print(f"  {key}: checked-in {json.dumps(current.get(key))[:160]} … now {json.dumps(fresh.get(key))[:160]}", file=sys.stderr)
    print("Re-run with --write, then update src/python-guide.js and the bf_* recipes to match.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
