import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCatalog } from '../../src/catalog.js';
import { renderPipeline } from '../../src/pipeline.js';
import { getDialect, SUPPORTED_DIALECTS } from '../../src/dialects/index.js';

const catalog = loadCatalog(new URL('../../config/catalog.yml', import.meta.url).pathname, { dialect: 'postgres' });

// input-validation guards (allowed): unsupported dialect / bad references rejected.
test('only postgres and bigquery are supported', () => {
  assert.deepEqual([...SUPPORTED_DIALECTS].sort(), ['bigquery', 'postgres']);
  assert.ok(getDialect('postgres'));
  assert.ok(getDialect('bigquery'));
  assert.throws(() => getDialect('snowflake'));
});

test('pipeline rejects a reference to a column not present at that stage', () => {
  assert.throws(() => renderPipeline(catalog, 'postgres', 'events', [
    { stage: 'aggregate', group_by: ['nope'], measures: [{ name: 'c', fn: 'count' }] },
  ]), /unknown column 'nope'/);
});

test('pivot rejects an unsafe value (non-identifier)', () => {
  assert.throws(() => renderPipeline(catalog, 'postgres', 'events', [
    { stage: 'derive', name: 'price', op: 'extract', source: 'price_in_usd', type: 'numeric' },
    { stage: 'join', with: 'users', on: 'appsflyer_id', attrs: ['country'] },
    { stage: 'pivot', group_by: [], on: 'country', fn: 'sum', value_column: 'price', values: ["US'); drop"] },
  ]));
});

test('percentile requires q in (0,1); compute validates operands', () => {
  assert.throws(() => renderPipeline(catalog, 'postgres', 'events', [
    { stage: 'derive', name: 'price', op: 'extract', source: 'price_in_usd', type: 'numeric' },
    { stage: 'aggregate', group_by: [], measures: [{ name: 'p', fn: 'percentile', column: 'price' }] },
  ]), /percentile requires q/);
  assert.throws(() => renderPipeline(catalog, 'postgres', 'events', [
    { stage: 'compute', name: 'x', op: 'add', left: { column: 'nope' }, right: { value: 1 } },
  ]), /unknown column 'nope'/);
});

test('date_diff / stat functions render on both dialects', () => {
  const stages = [
    { stage: 'derive', name: 'price', op: 'extract', source: 'price_in_usd', type: 'numeric' },
    { stage: 'compute', name: 'age', op: 'date_diff', from: { column: 'device_time' }, to: { now: true }, unit: 'day' },
    { stage: 'aggregate', group_by: [], measures: [{ name: 'm', fn: 'median', column: 'price' }] },
  ];
  for (const d of ['postgres', 'bigquery']) assert.ok(renderPipeline(catalog, d, 'events', stages).sql.length > 0);
});

test('both dialects render a non-empty string for the same pipeline', () => {
  const stages = [
    { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'new_session' }] },
    { stage: 'aggregate', group_by: [], measures: [{ name: 'n', fn: 'count' }] },
  ];
  for (const d of ['postgres', 'bigquery']) {
    const { sql } = renderPipeline(catalog, d, 'events', stages);
    assert.equal(typeof sql, 'string');
    assert.ok(sql.length > 0);
  }
});
