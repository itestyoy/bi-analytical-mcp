import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { ValueIndex, BackgroundIndexer } from '../../src/value-index.js';

// Allowed observability/lifecycle test: a STUB runner returns canned rows by SQL SHAPE (no
// warehouse, no generated-SQL assertions). The indexer issues COMBINED scans per batch — one
// cardinality (d{j}/t{j} per property + rows_total), one coverage (per event[×app], nn{j} per
// property), and per-property top-values (Postgres has no approx_top_k). A row Proxy answers
// the per-property aliases (d0/t0/nn0/…) uniformly so the stub need not know the batch size.
const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));

// Proxy whose fixed fields win; any d*/t*/nn* alias returns `n` (distinct/non-null fill).
const aliasRow = (fields, n) => new Proxy(fields, { get: (o, k) => (k in o ? o[k] : (typeof k === 'string' && (k[0] === 'd' || k[0] === 't' || k.startsWith('nn')) ? n : undefined)) });
// Shape-aware stub for a well-behaved warehouse: top-values 'x'(3), non-null 3 of 5 rows,
// coverage on first_launch.
function shapeStub() {
  return { show: async (_dir, sql) => {
    if (/ORDER BY n DESC/.test(sql)) return { ok: true, rows: [{ v: 'x', n: 3 }] };
    if (/AS rows_total/.test(sql) && !/GROUP BY/.test(sql)) return { ok: true, rows: [aliasRow({ rows_total: 5 }, 3)] };
    if (/GROUP BY/.test(sql) && /AS ev/.test(sql)) return { ok: true, rows: [aliasRow({ ev: 'first_launch', app: null, row_count: 5 }, 3)] };
    return { ok: true, rows: [] };
  } };
}

test('BackgroundIndexer logs sync start → steps → results, records the run + null coverage', async () => {
  const catalog = loadCatalog(CATALOG, {});
  const runner = shapeStub();
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

// Triple-cell collection: when the combined coverage query returns (event × app) rows, the
// indexer persists each cell so cellCoverage(prop, {bundle, event}) reflects the seeded fill
// (powers the native-model "field empty for this app+event" warning). Stub runner, no warehouse.
test('BackgroundIndexer stores per (bundle × event) triple cells', async () => {
  const catalog = loadCatalog(CATALOG, {});
  // ad_finished@words populated (nn=10), level_started@relax empty (nn=0); combined coverage
  // returns nn{j} per property — the alias Proxy answers any nn* with the cell's fill.
  const cell = (ev, app, row_count, nn) => new Proxy({ ev, app, row_count }, { get: (o, k) => (k in o ? o[k] : (typeof k === 'string' && k.startsWith('nn') ? nn : undefined)) });
  const runner = { show: async (_dir, sql) => {
    if (/ORDER BY n DESC/.test(sql)) return { ok: true, rows: [{ v: 'x', n: 3 }] };
    if (/AS rows_total/.test(sql) && !/GROUP BY/.test(sql)) return { ok: true, rows: [aliasRow({ rows_total: 18 }, 10)] };
    if (/GROUP BY/.test(sql) && /AS ev/.test(sql)) return { ok: true, rows: [cell('ad_finished', 'com.omg.words', 10, 10), cell('level_started', 'com.omg.relax', 8, 0)] };
    return { ok: true, rows: [] };
  } };
  const index = new ValueIndex();
  const bi = new BackgroundIndexer({ catalog, runner, index, baseProjectDir: '/tmp/none', intervalMs: 0, maxValues: 5, logger: () => {} });
  await bi.refresh();

  const prop = catalog.scalarEventProps()[0];
  // populated cell
  const filled = index.cellCoverage(prop, { bundle: 'com.omg.words', event: 'ad_finished' });
  assert.equal(filled.non_null, 10);
  // empty cell (field NULL for this app+event)
  const empty = index.cellCoverage(prop, { bundle: 'com.omg.relax', event: 'level_started' });
  assert.equal(empty.non_null, 0);
  assert.equal(empty.row_count, 8);
  // a combo that was never seen → no cell
  assert.equal(index.cellCoverage(prop, { bundle: 'com.omg.words', event: 'level_started' }), null);
  // the marginals still derive correctly from the same cells
  assert.ok(index.bundleCoverage(prop).some((b) => b.bundle === 'com.omg.words' && b.non_null === 10));
  index.close();
});

// Per-DB optimum: on a dialect WITH count-bearing approx-top-k (BigQuery), top-values are
// collected in ONE combined scan (no per-property ORDER BY) and parsed from the array shape.
test('BackgroundIndexer combines top-values via approx_top_k on a capable dialect', async () => {
  const catalog = loadCatalog(CATALOG, {});
  catalog.dialect = 'bigquery'; // → approxTopK is available → combined top-k path
  const topk = [{ value: 'rewarded', count: 30 }, { value: 'banner', count: 10 }]; // APPROX_TOP_COUNT shape
  let perPropTopCalls = 0;
  const runner = { show: async (_dir, sql) => {
    if (/ORDER BY n DESC/.test(sql)) { perPropTopCalls += 1; return { ok: true, rows: [] }; } // should NOT be used
    if (/APPROX_TOP_COUNT/.test(sql)) return { ok: true, rows: [new Proxy({}, { get: (_, k) => (typeof k === 'string' && k[0] === 'v' ? topk : undefined) })] };
    if (/AS rows_total/.test(sql) && !/GROUP BY/.test(sql)) return { ok: true, rows: [aliasRow({ rows_total: 50 }, 40)] };
    if (/GROUP BY/.test(sql) && /AS ev/.test(sql)) return { ok: true, rows: [aliasRow({ ev: 'ad_finished', app: null, row_count: 40 }, 40)] };
    return { ok: true, rows: [] };
  } };
  const index = new ValueIndex();
  const bi = new BackgroundIndexer({ catalog, runner, index, baseProjectDir: '/tmp/none', intervalMs: 0, maxValues: 5, logger: () => {} });
  await bi.refresh();

  const prop = catalog.scalarEventProps()[0];
  const vals = index.sampleValues(prop, 10);
  assert.deepEqual(new Set(vals.map((v) => v.value)), new Set(['rewarded', 'banner']), 'values parsed from approx_top_k');
  assert.equal(vals.find((v) => v.value === 'rewarded').freq, 30);
  assert.equal(perPropTopCalls, 0, 'no per-property top-values query when the dialect combines them');
  index.close();
});

// parseApproxTopK normalises both the BigQuery {value,count} and Snowflake [value,count] shapes.
test('parseApproxTopK normalises dialect array shapes', async () => {
  const { parseApproxTopK } = await import('../../src/dialect.js');
  assert.deepEqual(parseApproxTopK([{ value: 'a', count: 5 }, { value: 'b', count: 2 }]), [{ value: 'a', freq: 5 }, { value: 'b', freq: 2 }]);
  assert.deepEqual(parseApproxTopK([['a', 5], ['b', 2]]), [{ value: 'a', freq: 5 }, { value: 'b', freq: 2 }]);
  assert.deepEqual(parseApproxTopK(JSON.stringify([{ value: 'a', count: 5 }])), [{ value: 'a', freq: 5 }]); // JSON-string encoded
  assert.deepEqual(parseApproxTopK('not json'), []); // unparseable → empty (caller falls back)
});

// Observability: when the COMBINED batch scan fails but per-property succeeds, the fallback
// is not silent — the reason is logged (and indexing still completes via per-property).
test('a failed combined batch logs the reason and falls back to per-property', async () => {
  const catalog = loadCatalog(CATALOG, {});
  const runner = { show: async (_dir, sql) => {
    if (/ AS d0/.test(sql)) return { ok: false, stdout: '', stderr: 'column limit exceeded' }; // combined cardinality → batch fails
    if (/ORDER BY n DESC/.test(sql)) return { ok: true, rows: [{ v: 'x', n: 3 }] };            // per-property top
    if (/AS rows_total/.test(sql)) return { ok: true, rows: [{ d: 1, t: 3, rows_total: 5 }] };  // per-property cardinality
    if (/GROUP BY/.test(sql) && /AS ev/.test(sql)) return { ok: true, rows: [{ ev: 'first_launch', row_count: 5, non_null: 3 }] };
    return { ok: true, rows: [] };
  } };
  const logs = [];
  const index = new ValueIndex();
  const bi = new BackgroundIndexer({ catalog, runner, index, baseProjectDir: '/tmp/none', intervalMs: 0, maxValues: 5, logger: (m) => logs.push(m) });
  await bi.refresh();

  assert.ok(logs.some((l) => /combined scan FAILED, falling back to per-property/.test(l)), `expected a batch-failure log; got: ${logs.filter((l) => /FAILED/.test(l)).slice(0, 2).join(' | ')}`);
  // indexing still completed via the per-property fallback.
  const s = index.syncStatus();
  assert.equal(s.last_run.status, 'ok');
  assert.equal(index.stats(catalog.scalarEventProps()[0]).totalCount, 3);
  index.close();
});
