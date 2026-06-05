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

test('describe_index: schema rejects unknown params', async () => {
  const e = engine();
  await assert.rejects(async () => e.describe_index({ bogus: 1 }), 'additionalProperties:false');
  // valid optional param is accepted.
  assert.ok(e.describe_index({ recent: 5 }).value_index);
});
