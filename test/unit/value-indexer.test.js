import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { ValueIndex, BackgroundIndexer } from '../../src/value-index.js';

// Allowed observability/lifecycle test: a STUB runner returns canned rows (no warehouse,
// no generated-SQL assertions). We verify the indexer LOGS its sync lifecycle, records the
// run, and stores the null/coverage stats — not any query text. Each property issues THREE
// queries in order: top-values, cardinality+row-count, then per-event_name coverage.
const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));

test('BackgroundIndexer logs sync start → steps → results, records the run + null coverage', async () => {
  const catalog = loadCatalog(CATALOG, {});
  let call = 0;
  const runner = { show: async () => {
    const k = (call += 1) % 3;
    if (k === 1) return { ok: true, rows: [{ v: 'x', n: 3 }] };                         // top values
    if (k === 2) return { ok: true, rows: [{ d: 1, t: 3, rows_total: 5 }] };            // distinct / non-null / total rows
    return { ok: true, rows: [{ ev: 'first_launch', row_count: 5, non_null: 3 }] };     // per-event coverage
  } };
  const logs = [];
  const index = new ValueIndex();
  const bi = new BackgroundIndexer({ catalog, runner, index, baseProjectDir: '/tmp/none', intervalMs: 0, maxValues: 5, logger: (m) => logs.push(m) });

  await bi.refresh();

  // start line names the count of properties.
  assert.ok(logs.some((l) => /^sync #\d+ started: indexing \d+ scalar event properties/.test(l)), `missing start log; got: ${logs.slice(0, 2).join(' | ')}`);
  // per-step lines report what was stored (values / distinct / non-null / null / events).
  assert.ok(logs.some((l) => /sync #\d+ \[\d+\/\d+\] '.+': \d+ values stored, \d+ distinct \/ \d+ non-null \/ \d+ null of \d+ rows, \d+ events covered/.test(l)), 'missing per-step log');
  // finish line carries the results summary.
  assert.ok(logs.some((l) => /sync #\d+ done: status=ok, properties=\d+\/\d+, values=\d+, errors=0, duration=\d+ms/.test(l)), 'missing done log');

  // the run is recorded in the sync log.
  const s = index.syncStatus();
  assert.equal(s.total_runs, 1);
  assert.equal(s.running, false);
  assert.equal(s.last_run.status, 'ok');
  assert.ok(s.indexed_properties > 0);

  // null/coverage was captured per property: null_count = rows_total - non_null = 5 - 3 = 2.
  const prop = catalog.scalarEventProps()[0];
  const st = index.stats(prop);
  assert.equal(st.totalCount, 3);
  assert.equal(st.nullCount, 2);
  const cov = index.coverage(prop);
  assert.deepEqual(cov, [{ event_name: 'first_launch', row_count: 5, non_null: 3, null_count: 2 }]);
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
