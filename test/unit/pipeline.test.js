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

// Data-model contract (config/catalog.yml): the events fact declares ONLY columns
// physically materialized per event. User/install attributes are NOT denormalized onto
// the fact — they live on the users dimension and are reached via a join. This guards the
// reported bug (catalog over-declaring *_of_main_data user attrs → "Unrecognized name" at
// commit). It is a catalog-structure + validation-guard check, not a generated-SQL match.
test('user/install attributes are on dim_users, NOT on the events fact', () => {
  const eventCols = new Set(catalog.modelColumns('events').map((c) => c.name));
  const userCols = new Set(catalog.modelColumns('users').map((c) => c.name));
  // these belong to the user/install record — must be absent from the fact...
  for (const attr of ['platform', 'country', 'media_source', 'ab_test_group', 'is_valid_install', 'install_package', 'install_build_number']) {
    assert.ok(!eventCols.has(attr), `'${attr}' must not be a column of the events fact`);
    assert.ok(!eventCols.has(`${attr}_of_main_data`), `denormalized '${attr}_of_main_data' must not be on the events fact`);
  }
  // ...and the segmentable ones are reachable via the users dimension instead.
  for (const attr of ['platform', 'country', 'media_source', 'install_package', 'install_build_number', 'is_valid_install']) {
    assert.ok(userCols.has(attr), `'${attr}' must be a column of dim_users (reached via a users-join)`);
  }
});

// Consequence of the above: referencing a user attribute directly on the events fact
// (no join) is rejected by the pipeline compiler; the correct path is `join with:'users'`.
test('user attribute is rejected on the fact directly, accepted via a users-join', () => {
  // direct reference on the fact → unknown column (it is not materialized there).
  assert.throws(() => renderPipeline(catalog, 'postgres', 'events', [
    { stage: 'aggregate', group_by: ['country'], measures: [{ name: 'n', fn: 'count' }] },
  ]), /unknown column 'country'/);
  // joined from the users dimension → resolves and renders.
  const { sql } = renderPipeline(catalog, 'postgres', 'events', [
    { stage: 'join', with: 'users', on: 'player_id_of_internal', attrs: ['country'] },
    { stage: 'aggregate', group_by: ['country'], measures: [{ name: 'n', fn: 'count' }] },
  ]);
  assert.ok(sql.length > 0);
});

test('pivot rejects an unsafe value (non-identifier)', () => {
  assert.throws(() => renderPipeline(catalog, 'postgres', 'events', [
    { stage: 'derive', name: 'price', op: 'extract', source: 'price_in_usd_of_event_data', type: 'numeric' },
    { stage: 'join', with: 'users', on: 'appsflyer_id', attrs: ['country'] },
    { stage: 'pivot', group_by: [], on: 'country', fn: 'sum', value_column: 'price', values: ["US'); drop"] },
  ]));
});

test('percentile requires q in (0,1); compute validates operands', () => {
  assert.throws(() => renderPipeline(catalog, 'postgres', 'events', [
    { stage: 'derive', name: 'price', op: 'extract', source: 'price_in_usd_of_event_data', type: 'numeric' },
    { stage: 'aggregate', group_by: [], measures: [{ name: 'p', fn: 'percentile', column: 'price' }] },
  ]), /percentile requires q/);
  assert.throws(() => renderPipeline(catalog, 'postgres', 'events', [
    { stage: 'compute', name: 'x', op: 'add', left: { column: 'nope' }, right: { value: 1 } },
  ]), /unknown column 'nope'/);
});

test('date_diff / stat functions render on both dialects', () => {
  const stages = [
    { stage: 'derive', name: 'price', op: 'extract', source: 'price_in_usd_of_event_data', type: 'numeric' },
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
