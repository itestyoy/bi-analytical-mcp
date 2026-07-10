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

// Incremental: a budget-bounded run indexes only a SLICE, and stalest-first ordering lets the
// NEXT run resume with what is still missing — the index fills over several short runs instead
// of one giant pass (the fix for "all columns at once needs a 2h timeout").
test('BackgroundIndexer indexes incrementally across runs (budget-bounded, stalest-first, resumable)', async () => {
  const catalog = loadCatalog(CATALOG, {});
  const index = new ValueIndex();
  const total = new BackgroundIndexer({ catalog, runner: shapeStub(), baseProjectDir: '/tmp/none' })._targets().length;
  assert.ok(total >= 4, `fixture should expose several targets; got ${total}`);
  // batchSize 1 + maxPropsPerRun 2 → each run indexes exactly 2 properties, then stops.
  const bi = new BackgroundIndexer({ catalog, runner: shapeStub(), index, baseProjectDir: '/tmp/none', intervalMs: 0, maxValues: 5, batchSize: 1, maxPropsPerRun: 2, logger: () => {} });

  await bi.refresh();
  const after1 = index.syncStatus().indexed_properties;
  assert.equal(after1, 2, `first bounded run indexes maxPropsPerRun properties; got ${after1}`);
  const notes1 = index.runNotes(index.syncStatus().last_run.id);
  assert.ok(notes1.some((n) => /run budget reached/.test(n.note)), 'early-stop reason recorded on the run');

  await bi.refresh();
  const after2 = index.syncStatus().indexed_properties;
  assert.ok(after2 > after1, `the second run resumes with NEW (stalest) properties: ${after1} → ${after2}`);

  // keep going: the whole set fills over several bounded runs.
  let guard = 0;
  while (index.syncStatus().indexed_properties < total && guard++ < 200) await bi.refresh();
  assert.equal(index.syncStatus().indexed_properties, total, 'index fills completely over several bounded runs');
  index.close();
});

// Merge mode: an already-indexed anchor property is re-scanned only for rows since its
// watermark, and the delta counts are ADDED to what is stored (freq/coverage/total accumulate).
function mergeStub(wm = 1000) {
  return { show: async (_dir, sql) => {
    if (/ORDER BY n DESC/.test(sql)) return { ok: true, rows: [{ v: 'x', n: 3 }] };
    if (/AS rows_total/.test(sql)) return { ok: true, rows: [aliasRow({ rows_total: 5, wm }, 3)] }; // d/t=3, rows_total=5, max-time=wm
    if (/GROUP BY/.test(sql) && /AS ev/.test(sql)) return { ok: true, rows: [aliasRow({ ev: 'first_launch', app: null, row_count: 5 }, 3)] };
    return { ok: true, rows: [] };
  } };
}

test('merge mode accumulates counts across syncs (delta since the watermark)', async () => {
  const catalog = loadCatalog(CATALOG, {});
  assert.ok(['postgres', 'postgresql'].includes(catalog.dialect), 'fixture is a dialect with a since-clause');
  const index = new ValueIndex();
  const prop = catalog.scalarEventProps()[0];
  const bi = new BackgroundIndexer({ catalog, runner: mergeStub(1000), index, baseProjectDir: '/tmp/none', intervalMs: 0, maxValues: 5, merge: true, logger: () => {} });

  await bi.refresh(); // first: full scan, records the watermark
  assert.deepEqual(index.sampleValues(prop, 5), [{ value: 'x', freq: 3 }], 'full scan stores freq 3');
  assert.equal(index.stats(prop).totalCount, 3);
  assert.equal(index.stats(prop).dataWatermark, 1000, 'watermark recorded');

  await bi.refresh(); // second: delta since the watermark → MERGE (add) into what is stored
  assert.deepEqual(index.sampleValues(prop, 5), [{ value: 'x', freq: 6 }], 'delta merged: 3 + 3 = 6');
  assert.equal(index.stats(prop).totalCount, 6, 'non-null total accumulated');
  index.close();
});

test('high-cardinality fields are flagged and skipped on the next sync', async () => {
  const catalog = loadCatalog(CATALOG, {});
  const index = new ValueIndex();
  const prop = catalog.scalarEventProps()[0];
  // stub: distinct 3 of non-null 3 → 100% unique; threshold 90% → every field flagged near-unique.
  const bi = new BackgroundIndexer({ catalog, runner: shapeStub(), index, baseProjectDir: '/tmp/none', intervalMs: 0, maxValues: 5, highCardPct: 90, logger: () => {} });

  await bi.refresh();
  assert.equal(index.stats(prop).highCardinality, true, 'distinct/total = 100% ≥ 90% → flagged high-cardinality');
  const at1 = index.stats(prop).indexedAt;
  assert.ok(index.syncStatus().last_run.properties_indexed > 0, 'first run indexes the fields');

  await bi.refresh(); // flagged fields are now skipped
  assert.equal(index.syncStatus().last_run.properties_indexed, 0, 'all high-cardinality fields skipped next sync');
  assert.equal(index.stats(prop).indexedAt, at1, 'the flagged field was not re-scanned');
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

  // the REAL warehouse error ('column limit exceeded') must propagate, not a generic message.
  assert.ok(logs.some((l) => /combined batch scan .* FAILED .* column limit exceeded/.test(l)), `expected the real reason in the log; got: ${logs.filter((l) => /FAILED/.test(l)).slice(0, 2).join(' | ')}`);
  // the reason is ALSO recorded IN THE INDEX (visible via semantic_index({ run })) — not only stderr.
  const s = index.syncStatus();
  const notes = index.runNotes(s.last_run.id);
  assert.ok(notes.some((n) => /column limit exceeded/.test(n.note)), `real fallback reason recorded in the run: ${JSON.stringify(notes)}`);
  // indexing still completed via the per-property fallback.
  assert.equal(s.last_run.status, 'ok');
  assert.equal(index.stats(catalog.scalarEventProps()[0]).totalCount, 3);
  index.close();
});

// The FULL fallback reason is surfaced THROUGH the tools: semantic_index({ status }) + ({ run }).
test('semantic_index({ status })/({ run }) surface the full batch fallback reason', async () => {
  const { ContextManager } = await import('../../src/context-manager.js');
  const { Engine } = await import('../../src/engine.js');
  const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const catalog = loadCatalog(CATALOG, {});
  const engine = new Engine({ catalog, contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'rn-')) }) });
  const runner = { show: async (_d, sql) => {
    // combined cardinality fails with the REAL dbt error on stderr (no node "Command failed" wrapper).
    if (/ AS d0/.test(sql)) return { ok: false, error: 'dbt exited with code 1', stderr: 'Database Error\n  permission denied on column foo' };
    if (/ORDER BY n DESC/.test(sql)) return { ok: true, rows: [{ v: 'x', n: 3 }] };
    if (/AS rows_total/.test(sql)) return { ok: true, rows: [{ d: 1, t: 3, rows_total: 5 }] };
    if (/GROUP BY/.test(sql) && /AS ev/.test(sql)) return { ok: true, rows: [{ ev: 'first_launch', row_count: 5, non_null: 3 }] };
    return { ok: true, rows: [] };
  } };
  await new BackgroundIndexer({ catalog, runner, index: engine.valueIndex, baseProjectDir: '/tmp/none', intervalMs: 0, maxValues: 5, logger: () => {} }).refresh();

  const runId = engine.valueIndex.syncStatus().last_run.id;
  const run = await engine.semantic_index({ run: runId });
  // the REAL dbt/warehouse error is surfaced verbatim; no node "Command failed: …" stack wrapper.
  assert.ok((run.fallbacks || []).some((n) => /permission denied on column foo/.test(n)), `{ run }.fallbacks: ${JSON.stringify(run.fallbacks)}`);
  assert.ok(!(run.fallbacks || []).some((n) => /Command failed|ChildProcess|genericNodeError/.test(n)), `no node wrapper noise: ${JSON.stringify(run.fallbacks)}`);
  const st = await engine.semantic_index({ status: true });
  assert.ok((st.value_index.last_run_fallbacks || []).some((n) => /permission denied/.test(n)), `{ status } fallbacks: ${JSON.stringify(st.value_index.last_run_fallbacks)}`);
  engine.close();
});

// Resilience: a failing combined TOP-K must NOT discard the batch — cardinality+coverage stay
// combined, only top-values degrade to per-property, and the real reason is recorded.
test('a failed combined top-k degrades ONLY top-values, keeping cardinality+coverage combined', async () => {
  const catalog = loadCatalog(CATALOG, {});
  catalog.dialect = 'bigquery'; // combined top-k path
  let perPropTop = 0; let combinedCardCalls = 0; let combinedCovCalls = 0;
  const runner = { show: async (_d, sql) => {
    if (/APPROX_TOP_COUNT/.test(sql)) return { ok: false, stdout: 'Running with dbt=1.11\nRegistered adapter: bigquery\nDatabase Error\n  Resources exceeded during query execution', stderr: '' };
    if (/ORDER BY n DESC/.test(sql)) { perPropTop += 1; return { ok: true, rows: [{ v: 'x', n: 3 }] }; } // per-property top fallback
    if (/ AS d0/.test(sql)) { combinedCardCalls += 1; return { ok: true, rows: [aliasRow({ rows_total: 5 }, 3)] }; } // combined cardinality (kept)
    if (/GROUP BY/.test(sql) && /AS ev/.test(sql)) { combinedCovCalls += 1; return { ok: true, rows: [aliasRow({ ev: 'first_launch', app: null, row_count: 5 }, 3)] }; } // combined coverage (kept)
    return { ok: true, rows: [] };
  } };
  const index = new ValueIndex();
  await new BackgroundIndexer({ catalog, runner, index, baseProjectDir: '/tmp/none', intervalMs: 0, maxValues: 5, batchSize: 40, logger: () => {} }).refresh();

  // top-k failed → per-property top ran; but cardinality+coverage stayed COMBINED (one each per batch).
  assert.ok(perPropTop > 0, 'top-values fell back to per-property');
  assert.ok(combinedCardCalls > 0 && combinedCovCalls > 0, 'cardinality+coverage stayed combined (not full fallback)');
  // the real reason is recorded in the run, with the dbt banner stripped.
  const s = index.syncStatus();
  const notes = index.runNotes(s.last_run.id).map((n) => n.note);
  // FULL raw output is kept verbatim (banner AND the real error line) — nothing stripped/truncated.
  assert.ok(notes.some((n) => /top-k .* FAILED/.test(n) && /Resources exceeded during query execution/.test(n) && /Running with dbt/.test(n)), JSON.stringify(notes));
  // stats + values still landed.
  assert.equal(index.stats(catalog.scalarEventProps()[0]).totalCount, 3);
  index.close();
});
