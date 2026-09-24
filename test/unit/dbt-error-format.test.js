import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDbtError } from '../../src/dbt/index.js';

// Error-surfacing UX (NOT a query-correctness check): dbt prints the SPECIFIC semantic-manifest
// validation rule on the line BEFORE the "Encountered an error" marker, and appends a deprecation
// summary AFTER it. The formatter must keep the rule and drop the boilerplate/deprecation noise —
// otherwise the operator sees only a generic "Semantic Manifest validation failed".

const LIVE_STDOUT = [
  '16:41:29  Running with dbt=1.11.11',
  '16:41:29  Registered adapter: duckdb=1.11.0',
  '16:41:29  Unable to do partial parsing because saved manifest not found. Starting full parse.',
  '16:41:30  The semantic model `users` has an entity named `user` with type primary but it also has the `primary_entity` field set to `user`. Both should not be present in the model.',
  '16:41:30  Encountered an error:',
  'Parsing Error',
  '  Semantic Manifest validation failed.',
  '[WARNING][DeprecationsSummary]: Deprecated functionality',
  'Summary of encountered deprecations:',
  '- PropertyMovedToConfigDeprecation: 184 occurrences',
].join('\n');

test('surfaces the validation-detail line that precedes the error marker', () => {
  const msg = formatDbtError(LIVE_STDOUT, '');
  assert.match(msg, /has an entity named `user` with type primary/, 'the specific rule is kept');
  assert.match(msg, /Semantic Manifest validation failed/, 'the marker section is kept');
});

test('drops boilerplate header and the trailing deprecation summary', () => {
  const msg = formatDbtError(LIVE_STDOUT, '');
  assert.ok(!/Running with dbt|Registered adapter|partial parsing/.test(msg), 'no boilerplate header');
  assert.ok(!/DeprecationsSummary|PropertyMovedToConfig|occurrences/.test(msg), 'no deprecation noise');
});

test('no marker → still drops leading boilerplate but keeps content', () => {
  const msg = formatDbtError('Running with dbt=1.11.11\nsomething unexpected happened', '');
  assert.equal(msg, 'something unexpected happened');
});

test('empty input yields a stable fallback', () => {
  assert.equal(formatDbtError('', ''), 'unknown dbt error');
});

test('the rows of `dbt show --output json` are read from dbt 1.x ({ "show": [...] }) and dbt v2 (a bare array) alike', async () => {
  const { parseShowJson } = await import('../../src/dbt/index.js');
  // dbt 1.x: log lines, then the object spread over several lines
  assert.deepEqual(parseShowJson('\x1b[0m12:00:00  Running with dbt=1.11.11\n{\n  "show": [\n    {"n": 5},\n    {"n": 6}\n  ]\n}\n'), [{ n: 5 }, { n: 6 }]);
  // dbt v2: a banner, the array on one line, then a status line
  assert.deepEqual(parseShowJson('       dbt 2.0.6\n   Loading profiles.yml\n[{"event_name":"level_started","n":28}]\n Succeeded model main.inline (ephemeral) [1 of 1 in 0.04s]\n'), [{ event_name: 'level_started', n: 28 }]);
  assert.deepEqual(parseShowJson('       dbt 2.0.6\n[]\n'), []);
  assert.deepEqual(parseShowJson('no rows here'), []);
});
