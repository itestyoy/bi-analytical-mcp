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
  const prop = catalog.scalarEventProps('events')[0];
  const st = index.stats('events', prop);
  assert.equal(st.totalCount, 3);
  assert.equal(st.nullCount, 2);
  const cov = index.coverage('events', prop);
  assert.deepEqual(cov, [{ event_name: 'first_launch', row_count: 5, non_null: 3, null_count: 2 }]);
  index.close();
});

// Merge mode: an already-indexed anchor property is re-scanned only for rows since its
// watermark, and the delta counts are ADDED to what is stored (freq/coverage/total accumulate).
test('merge mode accumulates counts across syncs (delta), scanned as ONE combined batch query', async () => {
  const catalog = loadCatalog(CATALOG, {});
  assert.ok(['postgres', 'postgresql'].includes(catalog.dialect), 'fixture is a dialect with a since-clause');
  const index = new ValueIndex();
  const prop = catalog.scalarEventProps('events')[0];
  const nEvent = catalog.scalarEventProps('events').length;
  assert.ok(nEvent >= 3, 'fixture has several event properties in one batch');
  // Batched = ONE combined cardinality scan (per-property d0 alias) PER SOURCE, not one per
  // property — so the count is the number of source groups, far fewer than the property count.
  const groupCount = new Set(new BackgroundIndexer({ catalog, runner: { show: async () => ({ ok: true, rows: [] }) }, baseProjectDir: '/tmp/none' })._targets().map((t) => t.ref)).size;
  let combinedCard = 0;
  const runner = { show: async (_d, sql) => {
    if (/ AS d0/.test(sql)) combinedCard += 1;
    if (/ORDER BY n DESC/.test(sql)) return { ok: true, rows: [{ v: 'x', n: 3 }] };
    if (/AS rows_total/.test(sql)) return { ok: true, rows: [aliasRow({ rows_total: 5, wm: 1000 }, 3)] };
    if (/GROUP BY/.test(sql) && /AS ev/.test(sql)) return { ok: true, rows: [aliasRow({ ev: 'first_launch', app: null, row_count: 5 }, 3)] };
    return { ok: true, rows: [] };
  } };
  const bi = new BackgroundIndexer({ catalog, runner, index, baseProjectDir: '/tmp/none', intervalMs: 0, maxValues: 5, merge: true, logger: () => {} });

  await bi.refresh(); // first: full bootstrap scan (one combined query per source), records the watermark
  assert.deepEqual(index.sampleValues('events', prop, 5), [{ value: 'x', freq: 3 }], 'full scan stores freq 3');
  assert.equal(index.stats('events', prop).totalCount, 3);
  assert.equal(index.stats('events', prop).dataWatermark, 1000, 'watermark recorded');
  assert.equal(combinedCard, groupCount, 'event props indexed by ONE combined scan per source (batched), not one-per-property');
  assert.ok(combinedCard < nEvent, 'far fewer scans than properties');

  await bi.refresh(); // second: delta since the watermark → still ONE combined query per source → MERGE
  assert.deepEqual(index.sampleValues('events', prop, 5), [{ value: 'x', freq: 6 }], 'delta merged: 3 + 3 = 6');
  assert.equal(index.stats('events', prop).totalCount, 6, 'non-null total accumulated');
  assert.equal(combinedCard, groupCount * 2, 'the delta pass is also batched (one combined query per source, not hundreds)');
  index.close();
});

test('high-cardinality fields are flagged and skipped on the next sync', async () => {
  const catalog = loadCatalog(CATALOG, {});
  const index = new ValueIndex();
  const prop = catalog.scalarEventProps('events')[0];
  // stub: distinct 3 of non-null 3 → 100% unique; threshold 90% → every field flagged near-unique.
  const bi = new BackgroundIndexer({ catalog, runner: shapeStub(), index, baseProjectDir: '/tmp/none', intervalMs: 0, maxValues: 5, highCardPct: 90, logger: () => {} });

  await bi.refresh();
  assert.equal(index.stats('events', prop).highCardinality, true, 'distinct/total = 100% ≥ 90% → flagged high-cardinality');
  const at1 = index.stats('events', prop).indexedAt;
  assert.ok(index.syncStatus().last_run.properties_indexed > 0, 'first run indexes the fields');

  await bi.refresh(); // flagged SCALAR fields are now skipped; complex props still get coverage-only
  // refresh() runs the complex-coverage pass per FACT, so count every fact's complex properties
  const complexN = catalog.facts.reduce((n, f) => n + catalog.complexEventProps(f).length, 0);
  assert.equal(index.syncStatus().last_run.properties_indexed, complexN, 'all high-cardinality SCALARS skipped; only complex-coverage refreshes');
  assert.equal(index.stats('events', prop).indexedAt, at1, 'the flagged field was not re-scanned');
  index.close();
});

// Rebuild-then-index: with runModels on, the sync `dbt run`s the source models BEFORE scanning.
test('runModels rebuilds the source models (dbt run) before indexing', async () => {
  const catalog = loadCatalog(CATALOG, {});
  const index = new ValueIndex();
  const order = [];
  const runner = {
    run: async () => { order.push('run'); return { ok: true, stdout: '', stderr: '' }; },
    show: async (_d, sql) => {
      order.push('show');
      if (/ORDER BY n DESC/.test(sql)) return { ok: true, rows: [{ v: 'x', n: 3 }] };
      if (/AS rows_total/.test(sql)) return { ok: true, rows: [aliasRow({ rows_total: 5 }, 3)] };
      if (/GROUP BY/.test(sql) && /AS ev/.test(sql)) return { ok: true, rows: [aliasRow({ ev: 'first_launch', app: null, row_count: 5 }, 3)] };
      return { ok: true, rows: [] };
    },
  };
  const bi = new BackgroundIndexer({ catalog, runner, index, baseProjectDir: '/tmp/none', intervalMs: 0, maxValues: 5, runModels: true, logger: () => {} });

  await bi.refresh();

  assert.equal(order[0], 'run', 'dbt run happens FIRST');
  assert.ok(order.includes('show'), 'then the index scans');
  assert.ok(order.indexOf('run') < order.indexOf('show'), 'models rebuilt before scanning');
  assert.ok(index.stats('events', catalog.scalarEventProps('events')[0]) != null, 'index populated after the rebuild');
  index.close();
});

// A failed dbt run does not stop indexing — it logs + notes and indexes existing data.
test('runModels: a failed dbt run still indexes existing data (best-effort)', async () => {
  const catalog = loadCatalog(CATALOG, {});
  const index = new ValueIndex();
  const runner = {
    run: async () => ({ ok: false, stderr: 'model build failed' }),
    show: async (_d, sql) => {
      if (/ORDER BY n DESC/.test(sql)) return { ok: true, rows: [{ v: 'x', n: 3 }] };
      if (/AS rows_total/.test(sql)) return { ok: true, rows: [aliasRow({ rows_total: 5 }, 3)] };
      if (/GROUP BY/.test(sql) && /AS ev/.test(sql)) return { ok: true, rows: [aliasRow({ ev: 'first_launch', app: null, row_count: 5 }, 3)] };
      return { ok: true, rows: [] };
    },
  };
  const bi = new BackgroundIndexer({ catalog, runner, index, baseProjectDir: '/tmp/none', intervalMs: 0, maxValues: 5, runModels: true, logger: () => {} });

  await bi.refresh();

  assert.ok(index.stats('events', catalog.scalarEventProps('events')[0]) != null, 'still indexed despite the failed build');
  const notes = index.runNotes(index.syncStatus().last_run.id);
  assert.ok(notes.some((n) => /dbt run of source models failed/.test(n.note)), 'the build failure is recorded on the run');
  index.close();
});

// Schema sync: a field no longer in the table (not a target) is pruned from the index.
test('a field gone from the schema is pruned from the index on the next sync', async () => {
  const catalog = loadCatalog(CATALOG, {});
  const index = new ValueIndex();
  const bi = new BackgroundIndexer({ catalog, runner: shapeStub(), index, baseProjectDir: '/tmp/none', intervalMs: 0, maxValues: 5, logger: () => {} });
  // seed a stale entry for a column that no longer exists (not produced by _targets()).
  index.upsertProperty('events', 'ghost_col', { distinctCount: 1, totalCount: 1, nullCount: 0, values: [{ value: 'g', freq: 1 }] });
  assert.ok(index.properties().some((k) => k.source === 'events' && k.property === 'ghost_col'));

  await bi.refresh();

  assert.ok(!index.properties().includes('events.ghost_col'), 'orphan field pruned');
  assert.equal(index.stats('events', 'ghost_col'), null);
  assert.ok(index.stats('events', catalog.scalarEventProps('events')[0]) != null, 'valid fields stay indexed');
  index.close();
});

// A newly added field is indexed on its OWN (full scan); the already-indexed ones only get a
// cheap delta — not a full re-run of everything.
test('a newly added field is indexed individually; existing fields stay delta-scanned', async () => {
  const catalog = loadCatalog(CATALOG, {});
  assert.ok(['postgres', 'postgresql'].includes(catalog.dialect), 'fixture dialect has a since-clause');
  const index = new ValueIndex();
  let deltaScans = 0; // combined cardinality scans bounded to "device_time > watermark"
  const runner = { show: async (_d, sql) => {
    if (/ AS d0/.test(sql) && /device_time >/.test(sql)) deltaScans += 1;
    if (/ORDER BY n DESC/.test(sql)) return { ok: true, rows: [{ v: 'x', n: 3 }] };
    if (/AS rows_total/.test(sql)) return { ok: true, rows: [aliasRow({ rows_total: 5, wm: 1000 }, 3)] };
    if (/GROUP BY/.test(sql) && /AS ev/.test(sql)) return { ok: true, rows: [aliasRow({ ev: 'first_launch', app: null, row_count: 5 }, 3)] };
    return { ok: true, rows: [] };
  } };
  const bi = new BackgroundIndexer({ catalog, runner, index, baseProjectDir: '/tmp/none', intervalMs: 0, maxValues: 5, merge: true, logger: () => {} });

  await bi.refresh(); // bootstrap — all full, no delta
  assert.equal(deltaScans, 0, 'first pass is a full bootstrap');
  const newbie = catalog.scalarEventProps('events')[0];
  index.removeProperty('events', newbie); // simulate a freshly ADDED column: nothing stored for it yet
  deltaScans = 0;

  await bi.refresh();

  assert.equal(deltaScans, 1, 'existing anchor fields delta-scanned in ONE combined query — not full re-run');
  assert.ok(index.stats('events', newbie) != null, 'the new field was indexed on its own (full scan)');
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

  const prop = catalog.scalarEventProps('events')[0];
  // populated cell
  const filled = index.cellCoverage('events', prop, { bundle: 'com.omg.words', event: 'ad_finished' });
  assert.equal(filled.non_null, 10);
  // empty cell (field NULL for this app+event)
  const empty = index.cellCoverage('events', prop, { bundle: 'com.omg.relax', event: 'level_started' });
  assert.equal(empty.non_null, 0);
  assert.equal(empty.row_count, 8);
  // a combo that was never seen → no cell
  assert.equal(index.cellCoverage('events', prop, { bundle: 'com.omg.words', event: 'level_started' }), null);
  // the marginals still derive correctly from the same cells
  assert.ok(index.bundleCoverage('events', prop).some((b) => b.bundle === 'com.omg.words' && b.non_null === 10));
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

  const prop = catalog.scalarEventProps('events')[0];
  const vals = index.sampleValues('events', prop, 10);
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
  assert.equal(index.stats('events', catalog.scalarEventProps('events')[0]).totalCount, 3);
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
  assert.equal(index.stats('events', catalog.scalarEventProps('events')[0]).totalCount, 3);
  index.close();
});

// Complex (array/struct) coverage is INCREMENTAL like scalars: with merge on and a stored
// watermark, only rows newer than it are scanned and the counts are ADDED to what is stored
// (not a full re-scan). Driven directly with a mock runner (no warehouse).
test('complex-coverage merges a delta into stored coverage (incremental, not full re-scan)', async () => {
  const catalog = loadCatalog(CATALOG, {});
  const index = new ValueIndex();
  const prop = 'words_selected_of_event_data';
  assert.ok(catalog.complexEventProps('events').includes(prop), 'fixture has a complex prop');
  const covQueries = [];
  const runner = {
    show: async (_d, sql) => {
      if (/AS v\b/.test(sql) && !/GROUP BY/.test(sql)) return { ok: true, rows: [{ v: '[{"word_name":"cat"}]' }] }; // examples (row cap via show limit, no inline LIMIT)
      if (/GROUP BY/.test(sql) && /AS ev\b/.test(sql)) {
        const isDelta = /\bWHERE\b/.test(sql); // full scan has no WHERE (windowDays 0); delta has the since-clause
        covQueries.push(isDelta ? 'delta' : 'full');
        return isDelta
          ? { ok: true, rows: [{ ev: 'level_completed', row_count: 3, nn: 3, wm: 2000 }] }
          : { ok: true, rows: [{ ev: 'level_completed', row_count: 5, nn: 5, wm: 1000 }] };
      }
      return { ok: true, rows: [] };
    },
  };
  const bi = new BackgroundIndexer({ catalog, runner, index, baseProjectDir: '/tmp/none', intervalMs: 0, merge: true, logger: () => {} });

  // 2nd arg is the FACT to scan — always named: every scan is bound to ONE source's columns.
  await bi._indexComplexCoverage(1, 'events'); // first pass: no watermark → FULL scan
  assert.equal(index.coverage('events', prop).find((e) => e.event_name === 'level_completed').non_null, 5, 'full scan stored 5');
  assert.equal(index.stats('events', prop).dataWatermark, 1000, 'watermark advanced to the full scan max');
  assert.ok(index.sampleValues('events', prop).length > 0, 'examples stored');

  await bi._indexComplexCoverage(2, 'events'); // second pass: watermark set → DELTA, counts ADD
  assert.equal(index.coverage('events', prop).find((e) => e.event_name === 'level_completed').non_null, 8, 'delta ADDED (5 + 3), not replaced');
  assert.equal(index.stats('events', prop).dataWatermark, 2000, 'watermark advanced to the delta max');
  const complexN = catalog.complexEventProps('events').length;
  assert.ok(covQueries.slice(0, complexN).every((x) => x === 'full'), 'first pass = full scan per complex prop');
  assert.ok(covQueries.slice(complexN).length > 0 && covQueries.slice(complexN).every((x) => x === 'delta'), 'second pass = since-watermark delta per complex prop (no full re-scan)');
  index.close();
});

// ── EVERY SOURCE IS ITS OWN SCAN ────────────────────────────────────────────────────────────
// Two events sources are two tables with two time axes. The fixture has events (device_time) and
// crashlytics (event_time). The stub below behaves like a warehouse in the one way that matters
// here: a query against the crash table that names the OTHER fact's time column is rejected.

// A stub warehouse: canned shapes as above, but any SQL over the crash table that references the
// events fact's time column fails the way Postgres would. The combined batch over the crash table
// is made to fail so the per-property fallback (the path that used to borrow the anchor's column)
// is what runs; rows carry a `wm` so a watermark gets stored and the SECOND sync goes delta.
function twoFactStub() {
  return { show: async (_dir, sql) => {
    const crash = /fct_crashlytics_events/.test(sql);
    if (crash && /device_time/.test(sql)) return { ok: false, stdout: '', stderr: 'column "device_time" does not exist' };
    if (crash && / AS d0/.test(sql)) return { ok: false, stdout: '', stderr: 'combined scan refused' }; // force per-property
    if (/ORDER BY n DESC/.test(sql)) return { ok: true, rows: [{ v: 'x', n: 3 }] };
    if (/AS rows_total/.test(sql) && !/GROUP BY/.test(sql)) return { ok: true, rows: [aliasRow({ d: 1, t: 3, rows_total: 5, wm: 1000 }, 3)] };
    if (/GROUP BY/.test(sql) && /AS ev/.test(sql)) return { ok: true, rows: [aliasRow({ ev: 'fatal_crash', app: null, row_count: 5, non_null: 3, wm: 1000 }, 3)] };
    if (/AS v\b/.test(sql)) return { ok: true, rows: [] };
    return { ok: true, rows: [{ wm: 1000 }] };
  } };
}

test('a delta on the second source is bounded on ITS time column, not the first source\'s', async () => {
  const catalog = loadCatalog(CATALOG, {});
  const crashProp = catalog.scalarEventProps('crashlytics')[0];
  const index = new ValueIndex();
  const bi = new BackgroundIndexer({ catalog, runner: twoFactStub(), index, baseProjectDir: '/tmp/none', intervalMs: 0, merge: true, maxValues: 5, logger: () => {} });

  await bi.refresh(); // first sync: crash props fall back per-property, full scan, watermark stored
  assert.equal(index.stats('crashlytics', crashProp)?.dataWatermark, 1000, 'the crash source recorded its own watermark');

  await bi.refresh(); // second sync: the fallback goes DELTA — `event_time > …` on the crash table
  const run = index.syncStatus().last_run;
  const crashRows = index.runProperties(run.id).filter((r) => r.source === 'crashlytics');
  assert.ok(crashRows.length > 0, 'crash properties were scanned');
  assert.deepEqual([...new Set(crashRows.map((r) => r.status))], ['ok'], `every crash property indexed without error: ${JSON.stringify(crashRows.filter((r) => r.status !== 'ok').slice(0, 3))}`);
  // and it WAS a delta: the stub answers the bounded query with 3 more rows, merged onto the 3 stored
  assert.equal(index.stats('crashlytics', crashProp).totalCount, 6, 'delta counts ADDED to the stored ones');
  index.close();
});

test('per-run diagnostics failing for one source never abort the scan of any source', async () => {
  const catalog = loadCatalog(CATALOG, {});
  const index = new ValueIndex();
  // The run log refuses crash rows (the shape of the old-database bug): indexing must not notice.
  const real = index.recordPropertyTiming.bind(index);
  index.recordPropertyTiming = (runId, f) => { if (f.source === 'crashlytics') throw new Error('diagnostics store broken'); return real(runId, f); };
  const bi = new BackgroundIndexer({ catalog, runner: shapeStub(), index, baseProjectDir: '/tmp/none', intervalMs: 0, maxValues: 5, logger: () => {} });
  await bi.refresh();
  const run = index.syncStatus().last_run;
  assert.equal(run.status, 'ok', `a diagnostics failure is not an indexing failure: ${JSON.stringify(run)}`);
  assert.equal(index.stats('events', catalog.scalarEventProps('events')[0]).totalCount, 3, 'the events source is indexed');
  assert.equal(index.stats('crashlytics', catalog.scalarEventProps('crashlytics')[0]).totalCount, 3, 'and so is the crash source');
  index.close();
});
