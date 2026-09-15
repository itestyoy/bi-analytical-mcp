#!/usr/bin/env python
"""Static structural gate for the function bodies of a declared dbt Python model.

The server assembles each declared function as `def <name>(<params>):` + the body the caller
wrote, and asks this script whether it is admissible BEFORE anything is sent to the warehouse's
Python runtime (where `print` is invisible and a failure costs a cold start).

The check is an ALLOWLIST, not a blocklist: a body may use only the statement/expression forms a
frame transform needs, may name only its own parameters and locals, the names the declaration's
`imports` bound, the other declared functions, and a small set of builtins — and may touch only
public attributes. Everything else (imports, `global`, dunder attributes, `getattr`/`eval`/`open`
and friends, the dbt/session objects) has no spelling that reaches it, so a body cannot be written
to reach the interpreter or the host through a name the author did not declare.

This is a structural guard over what the caller declares, not a sandbox: the code still runs in
the warehouse's Python runtime, and what it may touch THERE is decided by that runtime and the
credentials dbt runs with.

Protocol: one JSON object on stdin — {"functions": [{"name","params","body","id"?,"bindings"?]}],
"bindings": [...], "require_order_for_row_slice"?: bool, "require_index_for_align"?: bool} — one
JSON object on stdout — {"ok": bool, "errors": [{"function","id","line",
"text","message"}]}. A function may carry its own `bindings` (and an `id` echoed back in its
errors), so the functions of SEVERAL declarations are checked in one run without sharing names.
Lines are 1-based within the BODY as the caller wrote it.
"""
import ast
import json
import sys

# Builtins a frame transform legitimately needs. Anything that reaches the interpreter, the host,
# or an attribute by NAME (getattr/setattr/vars/dir/type/super/object/eval/exec/compile/open/
# __import__/globals/locals/input/breakpoint/memoryview) is deliberately absent.
SAFE_BUILTINS = frozenset({
    "abs", "all", "any", "bool", "dict", "divmod", "enumerate", "filter", "float", "format",
    "frozenset", "int", "isinstance", "len", "list", "map", "max", "min", "pow", "print", "range",
    "repr", "reversed", "round", "set", "slice", "sorted", "str", "sum", "tuple", "zip",
})

# Exception classes a body may catch or raise. Names only — they reach nothing on their own.
SAFE_BUILTINS = SAFE_BUILTINS | frozenset({
    "ArithmeticError", "AttributeError", "Exception", "FloatingPointError", "IndexError",
    "KeyError", "LookupError", "NotImplementedError", "OverflowError", "RuntimeError",
    "StopIteration", "TypeError", "ValueError", "ZeroDivisionError",
})

# Statement / expression forms a body may use. Node classes absent here have no legal spelling:
# Import, ImportFrom, Global, Nonlocal, ClassDef, Delete, Await/Yield and the async forms.
ALLOWED_NODES = (
    ast.Module, ast.FunctionDef, ast.arguments, ast.arg,
    ast.Assign, ast.AugAssign, ast.AnnAssign, ast.Expr, ast.Return, ast.Pass,
    ast.If, ast.For, ast.While, ast.Break, ast.Continue, ast.With, ast.withitem,
    ast.Try, ast.ExceptHandler, ast.Raise, ast.Assert,
    ast.BoolOp, ast.BinOp, ast.UnaryOp, ast.Lambda, ast.IfExp, ast.NamedExpr,
    ast.Dict, ast.Set, ast.List, ast.Tuple, ast.ListComp, ast.SetComp, ast.DictComp,
    ast.GeneratorExp, ast.comprehension, ast.Compare, ast.Call, ast.keyword, ast.Starred,
    ast.Constant, ast.JoinedStr, ast.FormattedValue,
    ast.Attribute, ast.Subscript, ast.Slice, ast.Name,
    # operator / context marker nodes (Add, Lt, And, Load, …)
    ast.operator, ast.cmpop, ast.boolop, ast.unaryop, ast.expr_context,
)

# Frame methods that TAKE the first/last rows, and the ones that establish an order. On a frame
# whose ordering_mode is "partial" (the default of dbt's BigFrames wrapper) taking rows off an
# unordered frame is not merely non-deterministic — it RAISES OrderRequiredError at run time, in
# the warehouse's Python runtime where nothing of this gate's feedback reaches the author. So the
# pairing is checked here, before the model is submitted.
ROW_SLICE_METHODS = frozenset({"head", "tail"})
ORDERING_METHODS = frozenset({
    "sort_values", "sort_index", "sort", "orderBy", "order_by", "order", "nlargest", "nsmallest",
})

# The same shape for the other thing such a frame lacks: an INDEX. dbt.ref() hands BigFrames a
# frame with a null index, so an operation that would implicitly align two objects raises
# NullIndexError instead. `map` is the one we refuse: it is how a dict lookup gets written, it is
# always an alignment, and the fix (a merge) is mechanical. Filtering one frame by another frame's
# Series fails the same way, but it is not distinguishable here from the LEGITIMATE
# `mask = df["a"] > 1; df = df[mask]` (this gate knows no types and no frame identity), so refusing
# it would refuse working code — that one is left to the stage's rules and the run-failure hint.
ALIGNING_METHODS = frozenset({"map"})
# Having called either of these, the author has an index (set_index) or has left the lazy frame for
# real pandas (to_pandas) — alignment is legitimate from there on.
INDEX_ESCAPE_METHODS = frozenset({"set_index", "to_pandas"})

NODE_LABEL = {
    "Import": "an import inside a function body is not allowed — list the module in the declaration's `imports`",
    "ImportFrom": "an import inside a function body is not allowed — list the module in the declaration's `imports`",
    "Global": "global / nonlocal are not allowed — a step function works only on the frame it receives",
    "Nonlocal": "global / nonlocal are not allowed — a step function works only on the frame it receives",
    "ClassDef": "a class definition is not allowed in a step function",
    "Delete": "`del` is not allowed in a step function",
}


def _bound_names(fdef):
    """Every name the function itself introduces: parameters, assignment targets, loop and
    comprehension targets, `with ... as`, `except ... as`, walrus. Over-approximates Python's
    scoping on purpose — it only ever widens which of the AUTHOR'S OWN names are readable."""
    names = set()

    def add_args(a):
        for group in (getattr(a, "posonlyargs", []), a.args, a.kwonlyargs):
            for arg in group:
                names.add(arg.arg)
        for arg in (a.vararg, a.kwarg):
            if arg:
                names.add(arg.arg)

    add_args(fdef.args)
    for node in ast.walk(fdef):
        if isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
            names.add(node.id)
        elif isinstance(node, ast.Lambda):
            add_args(node.args)
        elif isinstance(node, ast.ExceptHandler) and node.name:
            names.add(node.name)
    return names


def _check(fn, default_bindings, require_order_for_row_slice=False, require_index_for_align=False):
    name, params, body = fn["name"], fn.get("params") or [], fn.get("body") or ""
    bindings = fn.get("bindings")
    if bindings is None:
        bindings = default_bindings
    fid = fn.get("id")
    header = "def %s(%s):\n" % (name, ", ".join(params))
    indented = "".join("    " + line + "\n" for line in body.splitlines()) or "    pass\n"
    src = header + indented
    errors = []
    try:
        tree = ast.parse(src)
    except SyntaxError as e:  # line 1 of `src` is the def line
        ln = max(1, (e.lineno or 2) - 1)
        lines = body.splitlines()
        errors.append({"function": name, "id": fid, "line": ln, "text": lines[ln - 1].strip() if 0 < ln <= len(lines) else "", "message": "syntax error: %s" % e.msg})
        return errors
    fdef = tree.body[0]
    body_lines = body.splitlines()

    def at(node):
        return max(1, getattr(node, "lineno", 2) - 1)

    def text(node):
        i = at(node)
        return body_lines[i - 1].strip() if 0 < i <= len(body_lines) else ""

    def err(node, message):
        errors.append({"function": name, "id": fid, "line": at(node), "text": text(node), "message": message})

    readable = _bound_names(fdef) | set(bindings) | SAFE_BUILTINS
    for node in ast.walk(fdef):
        if node is fdef:
            continue
        kind = type(node).__name__
        if not isinstance(node, ALLOWED_NODES):
            err(node, NODE_LABEL.get(kind, "`%s` is not allowed in a step function" % kind))
            continue
        if isinstance(node, ast.FunctionDef):
            err(node, "a nested function definition is not allowed — declare it as its own step function")
        elif isinstance(node, ast.Attribute) and node.attr.startswith("_"):
            err(node, "attribute '%s' is private — a step function uses the public API of the frame it receives" % node.attr)
        elif isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load) and node.id not in readable:
            err(node, "'%s' is not available here — a step function sees its parameters, its own locals, the declaration's `imports` and the other declared functions" % node.id)
    if require_order_for_row_slice:
        ordered = any(
            isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr in ORDERING_METHODS
            for n in ast.walk(fdef)
        )
        if not ordered:
            for node in ast.walk(fdef):
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in ROW_SLICE_METHODS:
                    err(node, "'%s' on a frame with no explicit order raises OrderRequiredError on this runtime (the dbt wrapper runs with ordering_mode=\"partial\") — sort first, e.g. df.sort_values('<column>', ascending=False).%s(n)" % (node.func.attr, node.func.attr))
                    break
    if require_index_for_align:
        indexed = any(
            isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr in INDEX_ESCAPE_METHODS
            for n in ast.walk(fdef)
        )
        if not indexed:
            for node in ast.walk(fdef):
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in ALIGNING_METHODS:
                    err(node, "'%s' aligns two objects, and the frame from dbt.ref() has NO INDEX on this runtime, so it raises NullIndexError at run time (reset_index(drop=True) does not give it one) — put the lookup in a frame and MERGE it: lookup = bpd.DataFrame({\"k\": list(d.keys()), \"v\": list(d.values())}); df = df.merge(lookup, on=\"k\", how=\"inner\"); or, if you really need alignment, wrap the step in df.set_index('<key>') ... reset_index()" % node.func.attr)
                    break

    if not any(isinstance(n, ast.Return) and n.value is not None for n in ast.walk(fdef)):
        errors.append({"function": name, "id": fid, "line": 1, "text": body_lines[0].strip() if body_lines else "", "message": "a step function must `return` the frame it produced"})
    # one error per line is enough to act on; keep the first few in source order
    seen = set()
    unique = []
    for e in sorted(errors, key=lambda x: x["line"]):
        key = (e["line"], e["message"])
        if key not in seen:
            seen.add(key)
            unique.append(e)
    return unique


def main():
    req = json.loads(sys.stdin.read() or "{}")
    bindings = req.get("bindings") or []
    # The caller knows the warehouse runtime, so it decides whether unordered head/tail is fatal
    # there; the gate only enforces what it is told.
    require_order = bool(req.get("require_order_for_row_slice"))
    require_index = bool(req.get("require_index_for_align"))
    errors = []
    for fn in req.get("functions") or []:
        errors.extend(_check(fn, bindings, require_order, require_index))
    sys.stdout.write(json.dumps({"ok": not errors, "errors": errors}))


if __name__ == "__main__":
    main()
