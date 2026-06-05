import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { ValueIndex, BackgroundIndexer } from '../../src/value-index.js';

// Allowed observability/lifecycle test: a STUB runner returns canned rows (no warehouse,
// no generated-SQL assertions). We verify the indexer LOGS its sync lifecycle and records
// the run — not any query text. Call order alternates top-values / cardinality per property.
const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));

test('BackgroundIndexer logs sync start → steps → results and records the run', async () => {
  const catalog = loadCatalog(CATALOG, {});
  let call = 0;
  const runner = { show: async () => { call += 1; return call % 2 === 1 ? { ok: true, rows: [{ v: 'x', n: 3 }] } : { ok: true, rows: [{ d: 1, t: 3 }] }; } };
  const logs = [];
  const index = new ValueIndex();
  const bi = new BackgroundIndexer({ catalog, runner, index, baseProjectDir: '/tmp/none', intervalMs: 0, maxValues: 5, logger: (m) => logs.push(m) });

  await bi.refresh();

  // start line names the count of properties.
  assert.ok(logs.some((l) => /^sync #\d+ started: indexing \d+ scalar event properties/.test(l)), `missing start log; got: ${logs.slice(0, 2).join(' | ')}`);
  // per-step lines report what was stored.
  assert.ok(logs.some((l) => /sync #\d+ \[\d+\/\d+\] '.+': \d+ values stored, \d+ distinct \/ \d+ total/.test(l)), 'missing per-step log');
  // finish line carries the results summary.
  assert.ok(logs.some((l) => /sync #\d+ done: status=ok, properties=\d+\/\d+, values=\d+, errors=0, duration=\d+ms/.test(l)), 'missing done log');

  // the run is recorded in the sync log.
  const s = index.syncStatus();
  assert.equal(s.total_runs, 1);
  assert.equal(s.running, false);
  assert.equal(s.last_run.status, 'ok');
  assert.ok(s.indexed_properties > 0);
  index.close();
});

test('BackgroundIndexer records a failed sync (errors logged, status error/partial)', async () => {
  const catalog = loadCatalog(CATALOG, {});
  const runner = { show: async () => { throw new Error('warehouse down'); } };
  const logs = [];
  const index = new ValueIndex();
  const bi = new BackgroundIndexer({ catalog, runner, index, baseProjectDir: '/tmp/none', intervalMs: 0, maxValues: 5, logger: (m) => logs.push(m) });

  await bi.refresh();

  assert.ok(logs.some((l) => /FAILED — warehouse down/.test(l)), 'per-property failure logged');
  assert.ok(logs.some((l) => /done: status=error, /.test(l)), 'done log reports error status');
  const s = index.syncStatus();
  assert.equal(s.last_run.status, 'error');
  assert.ok(s.last_run.errors > 0);
  assert.equal(s.indexed_properties, 0);
  index.close();
});
