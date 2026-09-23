#!/usr/bin/env python3
"""Move `meta:` under `config:` in dbt schema YAML — the place dbt 1.10 moved it to.

Why. Up to dbt 1.9 a model or a column carried `meta:` as a property of its own. dbt 1.10 moved it
under `config:`; dbt Core 1.11 still reads the old place and only warns
(PropertyMovedToConfigDeprecation), but dbt Fusion treats the top-level key as UNKNOWN
(UnusedConfigKey, dbt1060) and DROPS it silently. For this server that is not cosmetic: the whole
MCP surface — roles, the time axis, entities, dimensions, measures — lives in `meta.mcp`, so a
Fusion-parsed project would produce a catalog with nothing in it.

    - name: tracking_start_watch_time_of_rewarded        - name: tracking_start_watch_time_of_rewarded
      data_type: timestamp                                 data_type: timestamp
      meta:                              ──────────▶       config:
        mcp:                                                 meta:
          dimension: {}                                        mcp:
                                                                 dimension: {}

The rewrite is LINE-BASED on purpose: a schema file is written by people, and a YAML round-trip
would throw their comments, blank lines and quoting style away. Only the `meta:` line and the block
indented under it are touched.

It refuses rather than guesses:
  * a `meta:` already inside a `config:` block is left alone (already migrated);
  * a mapping that ALREADY has a sibling `config:` is reported and skipped — merging two blocks is
    a judgement call, not a rewrite;
  * an inline `meta: {…}` complete on one line moves as it is; one that spans several lines is
    reported and skipped;
  * and before writing anything, the result is PARSED and compared against the expected document
    (every `meta` moved under `config`), so a file is only written when it means the same thing.

Usage
  python3 scripts/meta-to-config.py --check  path/to/models            # what would change (exit 1 if any)
  python3 scripts/meta-to-config.py --write  path/to/models/foo.yml …  # rewrite in place
  python3 scripts/meta-to-config.py --check  --quiet  path             # for CI
"""

from __future__ import annotations

import argparse
import pathlib
import sys

try:
    import yaml  # PyYAML — dbt ships it, so it is present wherever dbt runs
except ImportError:  # pragma: no cover - the check below is the only use
    yaml = None


def _indent(line: str) -> int:
    return len(line) - len(line.lstrip(' '))


def _is_blank(line: str) -> bool:
    return not line.strip() or line.lstrip().startswith('#')


def _enclosing_key(lines: list[str], i: int, indent: int) -> str | None:
    """The key whose block this line sits in: the nearest line above with a smaller indent."""
    for j in range(i - 1, -1, -1):
        line = lines[j]
        if _is_blank(line):
            continue
        if _indent(line) < indent:
            return line.strip().rstrip(':').lstrip('- ').strip()
    return None


def _siblings(lines: list[str], i: int, indent: int) -> list[str]:
    """The other keys of the mapping `meta:` belongs to (same indent, same block)."""
    out = []
    for direction in (-1, 1):
        j = i + direction
        while 0 <= j < len(lines):
            line = lines[j]
            if _is_blank(line):
                j += direction
                continue
            ind = _indent(line)
            if ind > indent:               # inside a deeper block — keep scanning
                j += direction
                continue
            if ind < indent:               # left the mapping
                break
            stripped = line.strip()
            if stripped.startswith('- '):  # the next list item: a different mapping
                break
            out.append(stripped.split(':')[0].strip())
            j += direction
    return out


def convert(text: str, path: str = '<text>') -> tuple[str, list[str], list[str]]:
    """Return (new_text, moved, skipped) — `moved`/`skipped` are human-readable notes."""
    lines = text.split('\n')
    out: list[str] = []
    moved: list[str] = []
    skipped: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()
        indent = _indent(line)
        if stripped.startswith('- {') and 'meta:' in stripped:
            # A whole column written as a flow mapping. Rewriting one by hand is a two-second edit;
            # doing it here would mean parsing flow YAML with a regex, so it is reported instead —
            # what must never happen is silence about a block still in the old place.
            skipped.append(f'{path}:{i + 1}: `meta:` inside a flow mapping — move it by hand ({stripped[:60]}…)')
        elif stripped == 'meta:' or stripped.startswith('meta: '):
            where = f'{path}:{i + 1}'
            inline = stripped != 'meta:'
            # An inline `meta: { … }` complete on one line moves as it is; an unbalanced one (a flow
            # mapping continued on the next line) is left for a human.
            if inline and stripped.count('{') != stripped.count('}'):
                skipped.append(f'{where}: inline `{stripped}` spans several lines — move it by hand')
            elif _enclosing_key(lines, i, indent) == 'config':
                pass  # already under config:, nothing to do
            elif 'config' in _siblings(lines, i, indent):
                skipped.append(f'{where}: this block already has a sibling `config:` — merge by hand')
            else:
                # `config:` at meta's indent, then meta and its whole block two spaces deeper.
                out.append(' ' * indent + 'config:')
                out.append(' ' * (indent + 2) + stripped if inline else ' ' * (indent + 2) + 'meta:')
                if inline:
                    moved.append(where)
                    i += 1
                    continue
                j = i + 1
                while j < len(lines):
                    nxt = lines[j]
                    if not _is_blank(nxt) and _indent(nxt) <= indent:
                        break
                    out.append('' if not nxt.strip() else ' ' * 2 + nxt)
                    j += 1
                moved.append(where)
                i = j
                continue
        out.append(line)
        i += 1
    return '\n'.join(out), moved, skipped


def _expected(node):
    """The same document with every model/column `meta` moved under `config`."""
    if isinstance(node, list):
        return [_expected(n) for n in node]
    if not isinstance(node, dict):
        return node
    out = {k: _expected(v) for k, v in node.items() if k != 'meta'}
    if 'meta' in node:
        cfg = dict(out.get('config') or {})
        cfg['meta'] = _expected(node['meta'])
        out['config'] = cfg
    return out


def verify(before: str, after: str) -> str | None:
    """None when the rewrite means what it should; otherwise why not."""
    if yaml is None:
        return 'PyYAML is not installed — cannot verify the rewrite, so nothing was written'
    try:
        got = yaml.safe_load(after)
    except yaml.YAMLError as e:
        return f'the rewritten file is not valid YAML: {e}'
    want = _expected(yaml.safe_load(before))
    return None if got == want else 'the rewrite changed more than the position of `meta` — not written'


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('paths', nargs='+', type=pathlib.Path, help='YAML files, or directories to walk')
    ap.add_argument('--write', action='store_true', help='rewrite the files in place')
    ap.add_argument('--check', action='store_true', help='report what would change; exit 1 if anything would')
    ap.add_argument('--quiet', action='store_true', help='only the summary')
    args = ap.parse_args()
    if not (args.write or args.check):
        ap.error('pass --write or --check')

    files: list[pathlib.Path] = []
    for p in args.paths:
        if p.is_dir():
            files.extend(sorted(q for q in p.rglob('*') if q.suffix in ('.yml', '.yaml')))
        else:
            files.append(p)

    total_moved = total_skipped = changed_files = 0
    for f in files:
        before = f.read_text()
        after, moved, skipped = convert(before, str(f))
        total_moved += len(moved)
        total_skipped += len(skipped)
        for note in skipped:
            print(f'SKIP {note}', file=sys.stderr)
        if after == before:
            continue
        changed_files += 1
        why = verify(before, after)
        if why:
            print(f'FAIL {f}: {why}', file=sys.stderr)
            return 1
        if args.write:
            f.write_text(after)
        if not args.quiet:
            print(f'{"rewrote" if args.write else "would rewrite"} {f}: {len(moved)} block(s) moved under config:')

    print(f'{total_moved} meta block(s) in {changed_files} file(s){"" if args.write else " would be"} moved; {total_skipped} skipped')
    # --check is a gate: anything still in the old place fails it, whether this script can move it
    # (changed_files) or a human has to (total_skipped).
    if args.check and (changed_files or total_skipped):
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
