import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { settle } from '../helpers/settle.js';

// Allowed non-data test: semantic_index's OPERATIONAL views ({status}/{run}) report
// registry state (sync-run log + job list) read from SQLite/in-memory stores — no
// warehouse, no generated SQL asserted. Plus the strict view contract (input validation).
const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));
const engine = () => settle(new Engine({ catalog: loadCatalog(CATALOG, {}), contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'di-')) }) }));

test('semantic_index({ status }): idle state before any sync', async () => {
  const e = engine();
  const out = await e.semantic_index({ status: true });
  assert.equal(out.value_index.running, false);
  assert.equal(out.value_index.total_runs, 0);
  assert.equal(out.value_index.indexed_properties, 0);
  assert.equal(out.value_index.last_run, null);
  assert.equal(out.value_index.seconds_since_last_sync, null);
  assert.equal(out.tasks.total, 0);
  assert.deepEqual(out.tasks.running, []);
  assert.ok(out.recommendations.some((r) => /not run yet/i.test(r)), 'guides the AI that the index is empty');
});

test('semantic_index({ status }): reflects a recorded sync run', async () => {
  const e = engine();
  const runId = e.valueIndex.startRun();
  e.valueIndex.upsertProperty('events', 'p', { distinctCount: 1, totalCount: 3, values: [{ value: 'x', freq: 3 }] });
  e.valueIndex.finishRun(runId, { status: 'ok', propertiesIndexed: 1, valuesWritten: 1, errors: 0 });
  const out = await e.semantic_index({ status: true });
  assert.equal(out.value_index.running, false);
  assert.equal(out.value_index.total_runs, 1);
  assert.equal(out.value_index.indexed_properties, 1);
  assert.equal(out.value_index.last_successful_run.status, 'ok');
  assert.equal(typeof out.value_index.seconds_since_last_sync, 'number');
});

test('semantic_index: per-property timing + drill-down by run and via the property passport', async () => {
  const e = engine();
  // two runs, recording per-property timings (as the BackgroundIndexer does) — for
  // REAL catalog properties (the property passport validates names against the catalog).
  const r1 = e.valueIndex.startRun();
  e.valueIndex.recordPropertyTiming(r1, { source: 'events', property: 'result_of_event_data', ms: 5, valuesWritten: 2, distinctCount: 2, totalCount: 9, status: 'ok' });
  e.valueIndex.recordPropertyTiming(r1, { source: 'events', property: 'ad_type_of_event_data', ms: 80, valuesWritten: 4, distinctCount: 4, totalCount: 50, status: 'ok' });
  e.valueIndex.finishRun(r1, { status: 'ok', propertiesIndexed: 2, valuesWritten: 6, errors: 0 });
  const r2 = e.valueIndex.startRun();
  e.valueIndex.recordPropertyTiming(r2, { source: 'events', property: 'ad_type_of_event_data', ms: 60, valuesWritten: 4, distinctCount: 4, totalCount: 51, status: 'ok' });
  e.valueIndex.finishRun(r2, { status: 'ok', propertiesIndexed: 1, valuesWritten: 4, errors: 0 });

  // status view previews the slowest properties of the last run + exposes run ids.
  const sum = await e.semantic_index({ status: true });
  assert.equal(sum.value_index.last_run.id, r2);
  assert.ok(Array.isArray(sum.value_index.slowest_properties));

  // drill-down by RUN → per-property, slowest first.
  const byRun = await e.semantic_index({ run: r1 });
  assert.equal(byRun.run.id, r1);
  assert.equal(byRun.property_count, 2);
  assert.deepEqual(byRun.properties.map((p) => p.property), ['ad_type_of_event_data', 'result_of_event_data']); // 80ms before 5ms
  assert.equal(byRun.properties[0].ms, 80);

  // the property PASSPORT carries the indexing history across runs + average.
  const byProp = await e.semantic_index({ source: 'events', property: 'ad_type_of_event_data' });
  assert.equal(byProp.indexing.runs, 2);
  assert.equal(byProp.indexing.history[0].run_id, r2); // most recent first
  assert.equal(byProp.indexing.avg_ms, 70); // (80 + 60) / 2

  // unknown run id is rejected.
  await assert.rejects(() => e.semantic_index({ run: 99999 }), /unknown index run/);
});

// STRICT view contract: one view key at a time; params only on the views they apply to;
// unknown params rejected by the schema. Nothing is ever silently ignored.
test('semantic_index: strict view contract (exactly one view, scoped params)', async () => {
  const e = engine();
  await assert.rejects(() => e.semantic_index({ bogus: 1 }), /invalid input/);
  await assert.rejects(() => e.semantic_index({ event: 'tutorial', property: 'ad_type_of_event_data' }), /must be exactly one of: .*\{ source, property \}/);
  await assert.rejects(() => e.semantic_index({ status: true, run: 1 }), /must be exactly one of: .*\{ status \}/);
  // a paging field on a view that does not page is simply not a field of that view
  await assert.rejects(() => e.semantic_index({ source: 'events', event: 'tutorial', limit: 5 }), /unexpected property 'limit'/);
  await assert.rejects(() => e.semantic_index({ search: 'x', offset: 2 }), /unexpected property 'offset'/);
  await assert.rejects(() => e.semantic_index({ event: 'tutorial', recent: 3 }), /unexpected property 'recent'/);
  // valid scoped params are accepted.
  assert.ok((await e.semantic_index({ status: true, recent: 5 })).value_index);
  assert.ok((await e.semantic_index({ search: 'tutorial', limit: 5 })).query);
});

// A column's values are ordered by a list of sort items — the first orders, a second orders what the
// first ties — over the values the index holds, in both stores.
test('semantic_index({ source, property }): order_by is a list of { key, direction? } read in turn', async () => {
  for (const sqlite of [false, true]) {
    const e = sqlite
      ? settle(new Engine({ catalog: loadCatalog(CATALOG, {}), dbPath: join(mkdtempSync(join(tmpdir(), 'di-db-')), 'x.sqlite'), contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'di-')) }) }))
      : engine();
    e.valueIndex.upsertProperty('events', 'result_of_event_data', {
      distinctCount: 4, totalCount: 20,
      values: [{ value: 'win', freq: 8 }, { value: 'lose', freq: 5 }, { value: 'draw', freq: 5 }, { value: 'abort', freq: 2 }],
    });
    const order = async (order_by) => (await e.semantic_index({ source: 'events', property: 'result_of_event_data', ...(order_by ? { order_by } : {}) })).sample_values.map((v) => v.value);
    const at = sqlite ? 'sqlite' : 'memory';
    // the default: most frequent first, a tie by the value ascending
    assert.deepEqual(await order(), ['win', 'draw', 'lose', 'abort'], at);
    assert.deepEqual(await order([{ key: 'freq' }]), ['win', 'draw', 'lose', 'abort'], at);
    // a second item orders the tie
    assert.deepEqual(await order([{ key: 'freq' }, { key: 'value', direction: 'desc' }]), ['win', 'lose', 'draw', 'abort'], at);
    assert.deepEqual(await order([{ key: 'freq', direction: 'asc' }, { key: 'value' }]), ['abort', 'draw', 'lose', 'win'], at);
    assert.deepEqual(await order([{ key: 'value' }]), ['abort', 'draw', 'lose', 'win'], at);
    assert.deepEqual(await order([{ key: 'value', direction: 'desc' }]), ['win', 'lose', 'draw', 'abort'], at);
    const stats = (await e.semantic_index({ source: 'events', property: 'result_of_event_data', order_by: [{ key: 'freq' }, { key: 'value', direction: 'desc' }] })).value_stats;
    assert.deepEqual(stats.order_by, [{ key: 'freq', direction: 'desc' }, { key: 'value', direction: 'desc' }], at);
    // one key named twice orders nothing new: refused, not read once and ignored once
    await assert.rejects(() => e.semantic_index({ source: 'events', property: 'result_of_event_data', order_by: [{ key: 'freq' }, { key: 'freq', direction: 'asc' }] }), /names 'freq' twice/);
    // the values are distinct, so a second item after 'value' has no tie to order: refused, not ignored
    await assert.rejects(() => e.semantic_index({ source: 'events', property: 'result_of_event_data', order_by: [{ key: 'value' }, { key: 'freq', direction: 'asc' }] }), /nothing after 'value' has a tie to order/);
    // the earlier scalar order_by and its sibling direction are no spellings of it
    await assert.rejects(() => e.semantic_index({ source: 'events', property: 'result_of_event_data', order_by: 'value' }), /invalid input/);
    await assert.rejects(() => e.semantic_index({ source: 'events', property: 'result_of_event_data', direction: 'asc' }), /invalid input/);
    e.close?.();
  }
});

// include_coverage switches on the per-event and per-app split, which only an events source has.
test('semantic_index({ source, property }): include_coverage is offered on an events source alone', async () => {
  const e = engine();
  await assert.rejects(() => e.semantic_index({ source: 'users', property: 'country', include_coverage: true }), (err) => {
    assert.match(err.message, /unexpected property 'include_coverage' — \{ source, property \} takes source, property, limit, offset, order_by, recent/);
    assert.doesNotMatch(err.message, /`source` must be "events"/);
    return true;
  });
  assert.equal((await e.semantic_index({ source: 'events', property: 'result_of_event_data', include_coverage: true })).property, 'result_of_event_data');
});

// The SOURCE is ALWAYS a separate, named argument — in every catalog, however many sources it
// has. Input-validation guard: no view accepts an event or a column on its own, so no name ever
// has to be traced back to an owner.
const SINGLE_SOURCE = `version: 2
models:
  - name: fct_events
    config:
      meta:
        mcp:
          role: events
          primary_entity: event
          known_events: [login, purchase]
    columns:
      - { name: user_id, data_type: string, config: { meta: { mcp: { entity: { name: user, type: foreign } } } } }
      - { name: ts, data_type: timestamp, config: { meta: { mcp: { is_time: true } } } }
      - { name: event_name, data_type: string, config: { meta: { mcp: { is_event_name: true } } } }
`;

const SECOND_SOURCE = `  - name: fct_crash
    config:
      meta:
        mcp:
          role: crashlytics
          primary_entity: crash
          known_events: [boom]
    columns:
      - { name: user_id, data_type: string, config: { meta: { mcp: { entity: { name: user, type: foreign } } } } }
      - { name: ts, data_type: timestamp, config: { meta: { mcp: { is_time: true } } } }
      - { name: event_name, data_type: string, config: { meta: { mcp: { is_event_name: true } } } }
`;

function engineFor(yaml) {
  const dir = mkdtempSync(join(tmpdir(), 'srcarg-'));
  const file = join(dir, 'catalog.yml');
  writeFileSync(file, yaml);
  return settle(new Engine({ catalog: loadCatalog(file, {}), contextManager: new ContextManager({ workspaceRoot: dir }) }));
}

test('semantic_index: an event or a column is never asked for without its source', async () => {
  // ONE events source: being the only one earns it no shortcut — the pairing is still written out.
  const one = engineFor(SINGLE_SOURCE);
  // the refusal says what to add: the source, in the { source, event } view
  await assert.rejects(() => one.semantic_index({ event: 'login' }), /\{ source, event \}.*missing required property 'source'/);
  assert.equal((await one.semantic_index({ source: 'events', event: 'login' })).event, 'login');

  // SEVERAL events sources: same rule, same spelling — nothing about the catalog changes it.
  const two = engineFor(SINGLE_SOURCE + SECOND_SOURCE);
  await assert.rejects(() => two.semantic_index({ event: 'login' }), /must be exactly one of: .*\{ source, event \}/);
  assert.equal((await two.semantic_index({ source: 'events', event: 'login' })).event, 'login');
  assert.equal((await two.semantic_index({ source: 'crashlytics', event: 'boom' })).event, 'boom');
  // An event of the OTHER source is not in this source's vocabulary, so the pairing matches no
  // branch: the refusal names the one field that can be corrected — the source that declares the
  // event, or that source's event vocabulary.
  await assert.rejects(() => two.semantic_index({ source: 'crashlytics', event: 'login' }), /`source` must be "events"/);
  await assert.rejects(() => two.semantic_index({ source: 'events', event: 'boom' }), /`event` must be one of: login, purchase/);

  // A COLUMN is addressed the same way: a bare name has no spelling in either catalog.
  await assert.rejects(() => one.semantic_index({ property: 'user_id' }), /\{ source, property \}.*missing required property 'source'/);
  await assert.rejects(() => two.semantic_index({ property: 'user_id' }), /\{ source, property \}.*missing required property 'source'/);
});

test('semantic_index({ views }): several drill-ins in one call, each as it answers alone', async () => {
  const e = engine();
  const alone = [await e.semantic_index({ source: 'events', event: 'ad_finished' }), await e.semantic_index({ source: 'users' })];
  const both = await e.semantic_index({ views: [{ source: 'events', event: 'ad_finished' }, { source: 'users' }] });
  assert.deepEqual(both.views, alone);
  // only drill-ins, 2 to 5 of them, and a view of the batch is checked like one on its own
  await assert.rejects(() => e.semantic_index({ views: [{ status: true }, { source: 'users' }] }), /invalid input/);
  await assert.rejects(() => e.semantic_index({ views: [{ source: 'users' }] }), /invalid input/);
  await assert.rejects(() => e.semantic_index({ views: [{ source: 'users' }, { source: 'events', event: 'no_such_event' }] }), /invalid input/);
});
