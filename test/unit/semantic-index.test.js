import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';

// Allowed non-data test: semantic_index's OPERATIONAL views ({status}/{run}) report
// registry state (sync-run log + job list) read from SQLite/in-memory stores — no
// warehouse, no generated SQL asserted. Plus the strict view contract (input validation).
const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));
const engine = () => new Engine({ catalog: loadCatalog(CATALOG, {}), contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'di-')) }) });

test('semantic_index({ status }): idle state before any sync', async () => {
  const e = engine();
  const out = await e.semantic_index({ status: true });
  assert.equal(out.value_index.running, false);
  assert.equal(out.value_index.total_runs, 0);
  assert.equal(out.value_index.indexed_properties, 0);
  assert.equal(out.value_index.last_run, null);
  assert.equal(out.value_index.seconds_since_last_sync, null);
  assert.equal(out.query_jobs.total, 0);
  assert.deepEqual(out.query_jobs.running, []);
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
  const byProp = await e.semantic_index({ property: 'ad_type_of_event_data' });
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
  await assert.rejects(() => e.semantic_index({ model: 'events', limit: 5 }), /unexpected property 'limit'/);
  await assert.rejects(() => e.semantic_index({ search: 'x', offset: 2 }), /unexpected property 'offset'/);
  await assert.rejects(() => e.semantic_index({ event: 'tutorial', recent: 3 }), /unexpected property 'recent'/);
  // valid scoped params are accepted.
  assert.ok((await e.semantic_index({ status: true, recent: 5 })).value_index);
  assert.ok((await e.semantic_index({ search: 'tutorial', limit: 5 })).query);
});

// The SOURCE is a separate argument, and it may be left out only where there is nothing to
// choose between. Input-validation guard: the source-less { event } spelling exists in a
// one-source catalog and does not exist at all once a second events source is declared.
const SINGLE_SOURCE = `version: 2
models:
  - name: fct_events
    meta:
      mcp:
        role: events
        primary_entity: event
        known_events: [login, purchase]
    columns:
      - { name: user_id, data_type: string, meta: { mcp: { entity: { name: user, type: foreign } } } }
      - { name: ts, data_type: timestamp, meta: { mcp: { is_time: true } } }
      - { name: event_name, data_type: string, meta: { mcp: { is_event_name: true } } }
`;

const SECOND_SOURCE = `  - name: fct_crash
    meta:
      mcp:
        role: crashlytics
        primary_entity: crash
        known_events: [boom]
    columns:
      - { name: user_id, data_type: string, meta: { mcp: { entity: { name: user, type: foreign } } } }
      - { name: ts, data_type: timestamp, meta: { mcp: { is_time: true } } }
      - { name: event_name, data_type: string, meta: { mcp: { is_event_name: true } } }
`;

function engineFor(yaml) {
  const dir = mkdtempSync(join(tmpdir(), 'srcarg-'));
  const file = join(dir, 'catalog.yml');
  writeFileSync(file, yaml);
  return new Engine({ catalog: loadCatalog(file, {}), contextManager: new ContextManager({ workspaceRoot: dir }) });
}

test('semantic_index: the event source may be omitted only when the catalog has exactly one', async () => {
  // ONE events source — the name alone is unambiguous, so the source-less spelling is accepted.
  const one = engineFor(SINGLE_SOURCE);
  assert.equal((await one.semantic_index({ event: 'login' })).event, 'login');
  assert.equal((await one.semantic_index({ source: 'events', event: 'login' })).event, 'login');

  // TWO events sources — every source is equal, so there is no source-less spelling to submit and
  // the refusal names the mode that exists rather than guessing a source.
  const two = engineFor(SINGLE_SOURCE + SECOND_SOURCE);
  await assert.rejects(() => two.semantic_index({ event: 'login' }), /must be exactly one of: .*\{ source, event \}/);
  await assert.rejects(() => two.semantic_index({ event: 'login' }), /unexpected property 'event'/);
  assert.equal((await two.semantic_index({ source: 'events', event: 'login' })).event, 'login');
  assert.equal((await two.semantic_index({ source: 'crashlytics', event: 'boom' })).event, 'boom');
  // an event of the OTHER source is not in this source's vocabulary.
  await assert.rejects(() => two.semantic_index({ source: 'crashlytics', event: 'login' }), /`event` must be one of: boom/);
});
