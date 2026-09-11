#!/usr/bin/env python
"""Static gate for the function bodies of a declared dbt Python model.

The server assembles each declared function as `def <name>(<params>):` + the body the caller
wrote, and asks this script whether it is admissible BEFORE anything is sent to the warehouse's
Python runtime (where `print` is invisible and a failure costs a cold start). A body may compute
over the frame it is given; it may not import, reach the dbt/session objects, touch the
interpreter or the host, or use dunder attributes.

Protocol: one JSON object on stdin — {"functions": [{"name","params","body"}]} — one JSON object
on stdout — {"ok": bool, "errors": [{"function","line","message"}]}. Lines are 1-based within
the BODY as the caller wrote it.
"""
import ast
import json
import sys

FORBIDDEN_CALLS = {
    "exec", "eval", "compile", "open", "__import__", "globals", "locals", "vars", "dir",
    "setattr", "delattr", "breakpoint", "input", "exit", "quit", "help", "memoryview",
}
FORBIDDEN_NAMES = {"dbt", "session", "__builtins__", "__loader__", "__spec__", "__file__", "__name__"}


def _check(fn):
    name, params, body = fn["name"], fn.get("params") or [], fn.get("body") or ""
    header = f"def {name}({', '.join(params)}):\n"
    indented = "".join("    " + line + "\n" for line in body.splitlines()) or "    pass\n"
    src = header + indented
    errors = []
    try:
        tree = ast.parse(src)
    except SyntaxError as e:  # line 1 of `src` is the def line
        ln = max(1, (e.lineno or 2) - 1)
        lines = body.splitlines()
        errors.append({"function": name, "line": ln, "text": lines[ln - 1].strip() if 0 < ln <= len(lines) else "", "message": f"syntax error: {e.msg}"})
        return errors
    fdef = tree.body[0]
    body_lines = body.splitlines()
    at = lambda node: max(1, getattr(node, "lineno", 2) - 1)  # noqa: E731
    text = lambda node: (body_lines[at(node) - 1].strip() if 0 < at(node) <= len(body_lines) else "")  # noqa: E731
    for node in ast.walk(fdef):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            errors.append({"function": name, "line": at(node), "text": text(node), "message": "an import inside a function body is not allowed — list the module in the declaration's `imports`"})
        elif isinstance(node, (ast.Global, ast.Nonlocal)):
            errors.append({"function": name, "line": at(node), "text": text(node), "message": "global / nonlocal are not allowed — a step function works only on the frame it receives"})
        elif isinstance(node, ast.Name) and node.id in FORBIDDEN_NAMES:
            errors.append({"function": name, "line": at(node), "text": text(node), "message": f"'{node.id}' is not reachable from a step function — inputs come through the declaration's `inputs`"})
        elif isinstance(node, ast.Attribute) and node.attr.startswith("__"):
            errors.append({"function": name, "line": at(node), "text": text(node), "message": f"dunder attribute '{node.attr}' is not allowed"})
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in FORBIDDEN_CALLS:
            errors.append({"function": name, "line": at(node), "text": text(node), "message": f"call to '{node.func.id}()' is not allowed"})
    if not any(isinstance(n, ast.Return) and n.value is not None for n in ast.walk(fdef)):
        errors.append({"function": name, "line": 1, "message": "a step function must `return` the frame it produced"})
    return errors


def main():
    req = json.loads(sys.stdin.read() or "{}")
    errors = []
    for fn in req.get("functions") or []:
        errors.extend(_check(fn))
    sys.stdout.write(json.dumps({"ok": not errors, "errors": errors}))


if __name__ == "__main__":
    main()
