import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';

// Allowed non-data test: describe_index reports operational/registry state (sync-run log
// + job list) read from SQLite/in-memory stores — no warehouse, no generated SQL asserted.
const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));
const engine = () => new Engine({ catalog: loadCatalog(CATALOG, {}), contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'di-')) }) });

test('describe_index: idle state before any sync', () => {
  const e = engine();
  const out = e.describe_index();
  assert.equal(out.value_index.running, false);
  assert.equal(out.value_index.total_runs, 0);
  assert.equal(out.value_index.indexed_properties, 0);
  assert.equal(out.value_index.last_run, null);
  assert.equal(out.value_index.seconds_since_last_sync, null);
  assert.equal(out.query_jobs.total, 0);
  assert.deepEqual(out.query_jobs.running, []);
  assert.ok(out.recommendations.some((r) => /not run yet/i.test(r)), 'guides the AI that the index is empty');
});

test('describe_index: reflects a recorded sync run', () => {
  const e = engine();
  const runId = e.valueIndex.startRun();
  e.valueIndex.upsertProperty('p', { distinctCount: 1, totalCount: 3, values: [{ value: 'x', freq: 3 }] });
  e.valueIndex.finishRun(runId, { status: 'ok', propertiesIndexed: 1, valuesWritten: 1, errors: 0 });
  const out = e.describe_index();
  assert.equal(out.value_index.running, false);
  assert.equal(out.value_index.total_runs, 1);
  assert.equal(out.value_index.indexed_properties, 1);
  assert.equal(out.value_index.last_successful_run.status, 'ok');
  assert.equal(typeof out.value_index.seconds_since_last_sync, 'number');
});

test('describe_index: per-property timing + drill-down by run and by property', () => {
  const e = engine();
  // two runs, recording per-property timings (as the BackgroundIndexer does).
  const r1 = e.valueIndex.startRun();
  e.valueIndex.recordPropertyTiming(r1, { property: 'fast_p', ms: 5, valuesWritten: 2, distinctCount: 2, totalCount: 9, status: 'ok' });
  e.valueIndex.recordPropertyTiming(r1, { property: 'slow_p', ms: 80, valuesWritten: 4, distinctCount: 4, totalCount: 50, status: 'ok' });
  e.valueIndex.finishRun(r1, { status: 'ok', propertiesIndexed: 2, valuesWritten: 6, errors: 0 });
  const r2 = e.valueIndex.startRun();
  e.valueIndex.recordPropertyTiming(r2, { property: 'slow_p', ms: 60, valuesWritten: 4, distinctCount: 4, totalCount: 51, status: 'ok' });
  e.valueIndex.finishRun(r2, { status: 'ok', propertiesIndexed: 1, valuesWritten: 4, errors: 0 });

  // summary previews the slowest properties of the last run + exposes run ids.
  const sum = e.describe_index();
  assert.equal(sum.value_index.last_run.id, r2);
  assert.ok(Array.isArray(sum.value_index.slowest_properties));

  // drill-down by RUN → per-property, slowest first.
  const byRun = e.describe_index({ run: r1 });
  assert.equal(byRun.run.id, r1);
  assert.equal(byRun.property_count, 2);
  assert.deepEqual(byRun.properties.map((p) => p.property), ['slow_p', 'fast_p']); // 80ms before 5ms
  assert.equal(byRun.properties[0].ms, 80);

  // drill-down by PROPERTY → timing history across runs + average.
  const byProp = e.describe_index({ property: 'slow_p' });
  assert.equal(byProp.runs, 2);
  assert.equal(byProp.history[0].run_id, r2); // most recent first
  assert.equal(byProp.avg_ms, 70); // (80 + 60) / 2

  // unknown run id is rejected.
  assert.throws(() => e.describe_index({ run: 99999 }), /unknown index run/);
});

test('describe_index: schema rejects unknown params', async () => {
  const e = engine();
  await assert.rejects(async () => e.describe_index({ bogus: 1 }), 'additionalProperties:false');
  // valid optional params are accepted.
  assert.ok(e.describe_index({ recent: 5 }).value_index);
});
