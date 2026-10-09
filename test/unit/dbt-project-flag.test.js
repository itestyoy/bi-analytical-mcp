// THE CONTEXT'S COPY OF dbt_project.yml CARRIES `flags.require_nested_cumulative_type_params: false`,
// AND NOTHING ELSE OF IT CHANGES — dbt reads the file as YAML 1.1 (yes/no are booleans, a date is a
// date, 0123 is octal), so the project's own lines must reach it as they were written, not re-dumped.
//
// Allowed non-data tests: what is kept of the project file the server copies into a context
// (lifecycle). Each case holds the result to its INPUT — the input's lines all there, byte for byte,
// but the flag's one — and to the document it loads as: the input's, with the flag false.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import yaml from 'js-yaml';
import { withCumulativeWindowFlag } from '../../src/dbt/v1.js';

const FLAG = 'require_nested_cumulative_type_params';

/** The lines `after` adds to `before` and the ones it drops (a longest-common-subsequence diff by line). */
function lineDiff(before, after) {
  const a = before.split('\n'); const b = after.split('\n');
  const L = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const added = []; const dropped = [];
  let i = 0; let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) dropped.push(a[i++]); else added.push(b[j++]);
  }
  return { added: [...added, ...b.slice(j)], dropped: [...dropped, ...a.slice(i)] };
}

/** The input's document with the flag off — what the result must load as. */
const wanted = (text) => {
  const doc = yaml.load(text) || {};
  return { ...doc, flags: { ...(doc.flags || {}), [FLAG]: false } };
};

/** The result loads as the input with the flag off, edits only `changed` lines, and is a fixed point. */
function holds(text, { added, dropped }) {
  const out = withCumulativeWindowFlag(text);
  assert.deepEqual(yaml.load(out), wanted(text));
  const diff = lineDiff(text, out);
  assert.equal(diff.added.length, added, `lines added: ${JSON.stringify(diff.added)}`);
  assert.equal(diff.dropped.length, dropped, `lines dropped: ${JSON.stringify(diff.dropped)}`);
  assert.equal(withCumulativeWindowFlag(out), out, 'a second pass changes nothing');
  return { out, diff };
}

// what a YAML 1.2 dump would change: a date, yes/no/on, an octal, a float written 1.0, a comment
const PROJECT = [
  'name: my_proj # the project',
  "version: '1.0'",
  'config-version: 2',
  'vars:',
  '  start_date: 2024-01-01',
  '  flag: yes',
  '  big: 0123',
  '  ratio: 1.0',
  'models:',
  '  my_proj:',
  '    legacy:',
  '      +enabled: no',
  '      +persist_docs: { relation: on }',
  '',
].join('\n');

test('a project without flags gets a flags block appended; every line of its own is kept as written', () => {
  holds(PROJECT, { added: 2, dropped: 0 });
  // a file that does not end with a newline (its last line ended by one, then the block), and an empty one
  holds('name: p\nversion: 1.0', { added: 3, dropped: 0 });
  holds('', { added: 2, dropped: 0 });
});

test('a block `flags:` gets the key as one more line, at its own indentation', () => {
  const text = `name: p\nflags:\n    # why these are set\n    send_anonymous_usage_stats: false\n${PROJECT.split('\n').slice(3).join('\n')}`;
  holds(text, { added: 1, dropped: 0 });
  // `flags:` with nothing under it yet (a comment after it, a blank line before the next key)
  holds('name: p\nflags: # none yet\n\nvars:\n  on_flag: on\n', { added: 1, dropped: 0 });
  // …or with that written as null
  holds('name: p\nflags: ~\nvars:\n  on_flag: on\n', { added: 2, dropped: 1 });
  holds('flags: null # none yet\n', { added: 2, dropped: 1 });
});

test('a flag the project set true is set false in the copy — its line alone, the comment on it kept', () => {
  const text = `name: p\nflags:\n  ${FLAG}: true   # set during the 1.9 migration\n  x: yes\nother: 0123\n`;
  holds(text, { added: 1, dropped: 1 });
  // the key with no value, and spelled the YAML 1.1 way (`no` is a string to js-yaml, false to dbt)
  holds(`flags:\n  ${FLAG}:\n`, { added: 1, dropped: 1 });
  holds(`flags:\n  ${FLAG}: no\n`, { added: 1, dropped: 1 });
  // quoted keys
  holds(`"flags":\n  '${FLAG}': True\n`, { added: 1, dropped: 1 });
});

test('a flow `flags: { … }` gets the key inside it, on one line or over several', () => {
  holds('name: p\nflags: { send_anonymous_usage_stats: false } # c\nd: 2024-01-01\n', { added: 1, dropped: 1 });
  holds('flags: {}\n', { added: 1, dropped: 1 });
  holds(`flags: {${FLAG}: True, a: 1}\n`, { added: 1, dropped: 1 });
  holds('flags: {\n  a: 1\n}\nb: no\n', { added: 1, dropped: 1 });
});

test('a flag already false, or a file whose edit cannot be shown to change only the flag, is left as it is', () => {
  for (const text of [
    `flags:\n  ${FLAG}: false\n`,
    'flags: [1, 2]\n', // not a mapping
    'name: p\n...\n', // a document end: anything appended is another document
    'flags: &f\n  a: 1\nother: *f\n', // an anchored mapping, read again elsewhere
    'name: [unclosed\n', // not YAML at all: the parse is dbt's to report
  ]) assert.equal(withCumulativeWindowFlag(text), text, JSON.stringify(text));
});

test('CRLF line ends are kept', () => {
  const text = 'name: p\r\nflags:\r\n  a: true\r\nv: no\r\n';
  holds(text, { added: 1, dropped: 0 });
});
