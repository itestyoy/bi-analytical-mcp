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
