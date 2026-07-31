import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDbtError } from '../../src/dbt-runner.js';

// Error-surfacing UX (NOT a query-correctness check): dbt prints the SPECIFIC semantic-manifest
// validation rule on the line BEFORE the "Encountered an error" marker, and appends a deprecation
// summary AFTER it. The formatter must keep the rule and drop the boilerplate/deprecation noise —
// otherwise the operator sees only a generic "Semantic Manifest validation failed".

const LIVE_STDOUT = [
  '16:41:29  Running with dbt=1.11.11',
  '16:41:29  Registered adapter: postgres=1.10.0',
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
