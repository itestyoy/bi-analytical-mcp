// A NON-EVENTS source with MEASURES declared entirely in the catalog schema: acquisition
// spend at (player, day) grain. Nothing about these measures is known to the code — the
// aggregations, names, units and the percentile parameter all come from meta.mcp — so the
// same declarations work for any column of any source.
// Every assertion is on the NUMBERS returned by dbt + MetricFlow / the pipeline against
// PGlite, per test/integration/fixtures/SEED_DATA.md (§11).
// Auto-skips when dbt/mf are not installed (HAS_DBT gate).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { MfEngineBackend } from '../../src/backends/mf-engine.js';
import { Engine } from '../../src/engine.js';
import { startPglite } from './pglite-harness.js';

const execFileP = promisify(execFile);
const BASE = join(process.cwd(), 'test', 'integration', 'fixtures', 'dbt_project');
const DBT_BIN = process.env.DBT_BIN || join(process.cwd(), '.dbtvenv', 'bin', 'dbt');
const MF_BIN = process.env.MF_BIN || join(process.cwd(), '.dbtvenv', 'bin', 'mf');
const PY_BIN = process.env.PYTHON_BIN || join(process.cwd(), '.dbtvenv', 'bin', 'python');
const HAS_DBT = existsSync(DBT_BIN) && existsSync(MF_BIN);
const opts = { timeout: 300000 };

let pg; let engine; let backend; let ctx;

const num = (v) => Number(v === '' || v == null ? NaN : v);
const sumCol = (rows, col) => rows.reduce((s, r) => s + (Number.isFinite(num(r[col])) ? num(r[col]) : 0), 0);
const mapCol = (rows, keyCol, valCol) => Object.fromEntries(rows.map((r) => [String(r[keyCol]), num(r[valCol])]));
const groupCol = (res, metric) => res.columns.map((c) => c.name).find((n) => n !== metric);
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

before(async () => {
  if (!HAS_DBT) return;
  pg = await startPglite();
  process.env.DBT_PG_PORT = String(pg.port);
  const env = { ...process.env, DBT_PROFILES_DIR: BASE, DBT_PROJECT_DIR: BASE, DBT_PG_PORT: String(pg.port) };
  await execFileP(DBT_BIN, ['seed'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  await execFileP(DBT_BIN, ['run'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });

  const catalog = loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), { profilesDir: BASE, projectDir: BASE });
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: mkdtempSync(join(tmpdir(), 'mcpit-acq-')), timeSpineDialect: 'postgres' });
  backend = new MfEngineBackend({ pythonBin: PY_BIN, dbtBin: DBT_BIN, profilesDir: BASE });
  engine = new Engine({ catalog, contextManager: ctxs, runner: backend });

  // The schema only MARKS which fields are amounts (cost / impressions / clicks, and the
  // cost_per_click expression). It fixes no aggregation, so the task picks one per question —
  // the same `cost` field is summed here, maxed there, and read at a percentile below.
  const out = await engine.create_semantic_model({
    name: 'uacq',
    use_base_models: ['users'],
    semantic_models: [{
      from: 'acquisition',
      measures: [
        { name: 'cost', agg: 'sum', field: 'cost' },
        { name: 'impressions', agg: 'sum', field: 'impressions' },
        { name: 'clicks', agg: 'sum', field: 'clicks' },
        { name: 'max_daily_cost', agg: 'max', field: 'cost' },
        { name: 'avg_daily_cost', agg: 'average', field: 'cost' },
        { name: 'p90_daily_cost', agg: 'percentile', field: 'cost', percentile: 0.9 },
        { name: 'avg_cost_per_click', agg: 'average', field: 'cost_per_click' },
      ],
    }],
    metrics: [
      { name: 'cost', type: 'simple', measure: { name: 'cost' } },
      { name: 'impressions', type: 'simple', measure: { name: 'impressions' } },
      { name: 'clicks', type: 'simple', measure: { name: 'clicks' } },
      { name: 'max_daily_cost', type: 'simple', measure: { name: 'max_daily_cost' } },
      { name: 'avg_daily_cost', type: 'simple', measure: { name: 'avg_daily_cost' } },
      { name: 'p90_daily_cost', type: 'simple', measure: { name: 'p90_daily_cost' } },
      { name: 'avg_cost_per_click', type: 'simple', measure: { name: 'avg_cost_per_click' } },
      { name: 'cpc', type: 'ratio', numerator: { name: 'cost' }, denominator: { name: 'clicks' } },
    ],
  });
  assert.equal(out.parse.ok, true, `parse failed: ${JSON.stringify(out.parse)}`);
  ctx = out.context_id;
}, opts);

after(async () => { backend?.close(); if (pg) await pg.stop(); });
const skip = (t) => { if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; } return false; };
const q = (input) => engine.query_semantic_model({ context_id: ctx, ...input });

// SEED_DATA §11: 13 rows, cost 17.50, impressions 1280, clicks 64.
test('a marked amount is aggregated the way the task asks: cost 17.50 / impressions 1280 / clicks 64', opts, async (t) => {
  if (skip(t)) return;
  const r = await q({ metrics: ['uacq_cost', 'uacq_impressions', 'uacq_clicks'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.ok(near(num(r.rows[0].uacq_cost), 17.5), `cost=${r.rows[0].uacq_cost}`);
  assert.equal(num(r.rows[0].uacq_impressions), 1280);
  assert.equal(num(r.rows[0].uacq_clicks), 64);
});

// THE SAME marked field, three different aggregations chosen by the task — including one that
// carries a parameter. Over the 13 daily costs: max 3.00, mean 17.50/13, and percentile_cont(0.9)
// interpolating between 2.50 and 2.75 → 2.70. Nothing in the schema decided any of these.
test('the same amount under three aggregations: max 3.00, mean 17.50/13, p90 2.70', opts, async (t) => {
  if (skip(t)) return;
  const r = await q({ metrics: ['uacq_max_daily_cost', 'uacq_avg_daily_cost', 'uacq_p90_daily_cost'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.ok(near(num(r.rows[0].uacq_max_daily_cost), 3.0), `max=${r.rows[0].uacq_max_daily_cost}`);
  assert.ok(near(num(r.rows[0].uacq_avg_daily_cost), 17.5 / 13, 1e-6), `avg=${r.rows[0].uacq_avg_daily_cost}`);
  assert.ok(near(num(r.rows[0].uacq_p90_daily_cost), 2.7, 1e-4), `p90=${r.rows[0].uacq_p90_daily_cost}`);
});

// A model-level entry is an aggregatable EXPRESSION over the model's columns, equally free of a
// fixed function. cost_per_click = cost / clicks per row; the four rows with no clicks are NULL,
// so the mean is over the nine that have them.
test('an aggregatable expression: the mean per-row cost per click over the rows that have clicks', opts, async (t) => {
  if (skip(t)) return;
  const r = await q({ metrics: ['uacq_avg_cost_per_click'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const perRow = [[1.50, 5], [2.00, 8], [1.25, 6], [3.00, 10], [0.50, 2], [2.50, 9], [1.75, 7], [2.25, 8], [2.75, 9]].map(([c, k]) => c / k);
  const expected = perRow.reduce((a, b) => a + b, 0) / perRow.length;
  assert.ok(near(num(r.rows[0].uacq_avg_cost_per_click), expected, 1e-6), `avg cpc=${r.rows[0].uacq_avg_cost_per_click} want ${expected}`);
});

// A ratio over two of the task's own measures: 17.50 / 64.
test('a ratio metric over two task measures: CPC = 17.50/64', opts, async (t) => {
  if (skip(t)) return;
  const r = await q({ metrics: ['uacq_cpc'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.ok(near(num(r.rows[0].uacq_cpc), 17.5 / 64, 1e-6), `cpc=${r.rows[0].uacq_cpc}`);
});

// SEED_DATA §11: cost by channel — meta 5.75, applovin 8.25, google 3.50, organic 0.
test('grouped by an attribute of the same source: cost by media_source', opts, async (t) => {
  if (skip(t)) return;
  const r = await q({ metrics: ['uacq_cost'], group_by: ['acquisition__media_source'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const by = mapCol(r.rows, groupCol(r, 'uacq_cost'), 'uacq_cost');
  assert.ok(near(by.meta, 5.75), `meta=${by.meta}`);
  assert.ok(near(by.applovin, 8.25), `applovin=${by.applovin}`);
  assert.ok(near(by.google, 3.5), `google=${by.google}`);
  assert.ok(near(by.organic, 0), `organic=${by.organic}`);
  assert.ok(near(sumCol(r.rows, 'uacq_cost'), 17.5));
});

// The source carries the user entity, and dim_users is SLOWLY-CHANGING, so spend is attributed
// POINT-IN-TIME — to the install version valid on the SPEND DAY. u1 spent 1.50 on 01-01 (still
// US) and 0.50 on 01-03 (already GB), so that 0.50 lands in GB, not US.
// SEED_DATA §11 + §13: US 6.75 / GB 5.00 / DE 4.00 / BR 1.75, total still 17.50.
test('cost by user__country is attributed to the install version valid on the spend day', opts, async (t) => {
  if (skip(t)) return;
  const r = await q({ metrics: ['uacq_cost'], group_by: ['user__country'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const by = mapCol(r.rows, groupCol(r, 'uacq_cost'), 'uacq_cost');
  assert.ok(near(by.US, 6.75), `US=${by.US}`);
  assert.ok(near(by.GB, 5.0), `GB=${by.GB}`);
  assert.ok(near(by.DE, 4.0), `DE=${by.DE}`);
  assert.ok(near(by.BR, 1.75), `BR=${by.BR}`);
  assert.ok(near(sumCol(r.rows, 'uacq_cost'), 17.5), 'no version fan-out: the total is unchanged');
});

// meta.mcp.is_time gives a NON-events source its own time axis, so metric_time works on it.
// SEED_DATA §11 per day: 1.50 / 3.25 / 3.50 / 4.25 / 5.00.
test('the declared time axis drives metric_time on a non-events source', opts, async (t) => {
  if (skip(t)) return;
  const r = await q({ metrics: ['uacq_cost'], group_by: [{ time: 'metric_time', grain: 'day' }], time_range: { start: '2026-01-01', end: '2026-01-05' } });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const by = Object.fromEntries(r.rows.map((row) => {
    const day = String(row[groupCol(r, 'uacq_cost')]).slice(0, 10);
    return [day, num(row.uacq_cost)];
  }));
  assert.ok(near(by['2026-01-01'], 1.5), JSON.stringify(by));
  assert.ok(near(by['2026-01-02'], 3.25), JSON.stringify(by));
  assert.ok(near(by['2026-01-03'], 3.5), JSON.stringify(by));
  assert.ok(near(by['2026-01-04'], 4.25), JSON.stringify(by));
  assert.ok(near(by['2026-01-05'], 5.0), JSON.stringify(by));
  assert.ok(near(sumCol(r.rows, 'uacq_cost'), 17.5));
});

// A COMPOSITE join key is what keeps a per-day table from fanning out: u1 has spend on TWO
// days (SEED_DATA §11), so joining 12 first_launch events on the player alone yields 13 rows,
// while joining on player + day yields exactly 12.
test('composite join key prevents fan-out: player+day = 12 rows, player alone = 13', opts, async (t) => {
  if (skip(t)) return;
  const rowsAfterJoin = async (name, on) => {
    const s = await engine.build_native_model({ action: 'start', name, source: 'events' });
    await engine.build_native_model({ action: 'add_step', draft_id: s.draft_id, stage: { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'first_launch' }] } });
    await engine.build_native_model({ action: 'add_step', draft_id: s.draft_id, stage: { stage: 'compute', name: 'spend_date', op: 'date_trunc', column: 'device_time', granularity: 'day' } });
    await engine.build_native_model({ action: 'add_step', draft_id: s.draft_id, stage: { stage: 'join', with: 'acquisition', on, attrs: ['media_source'] } });
    await engine.build_native_model({ action: 'add_step', draft_id: s.draft_id, stage: { stage: 'aggregate', measures: [{ name: 'n', fn: 'count' }] } });
    const c = await engine.build_native_model({ action: 'materialize', draft_id: s.draft_id });
    assert.equal(c.build?.ok, true, JSON.stringify(c.error || c.build));
    return num(c.rows[0].n);
  };
  assert.equal(await rowsAfterJoin('acq_join_pair', ['player_id_of_internal', 'spend_date']), 12, 'player+day matches one cost row per event');
  assert.equal(await rowsAfterJoin('acq_join_single', ['player_id_of_internal']), 13, "player alone duplicates u1's event across both spend days");
});

// meta.mcp.dimension:false keeps a column out of the group-by surface while leaving it a real
// column; meta.mcp.index:false keeps one out of value profiling while leaving it groupable.
test('the schema opt-outs hold: a measure/opted-out column is not groupable but is readable', opts, async (t) => {
  if (skip(t)) return;
  const model = await engine.semantic_index({ model: 'acquisition' });
  const dims = model.dimensions.map((d) => d.name);
  // The measure columns and the `dimension: false` column are NOT attributes; the source's
  // declared time axis is (grouping spend by its own day needs no join).
  assert.deepEqual(dims.sort(), ['campaign', 'campaign_id', 'media_source', 'spend_date'], 'measures and the opted-out column are not attributes');
  assert.equal(model.time, 'spend_date', 'the declared axis is reported as the source\'s time');
  // The amounts come back marked and self-describing — field, unit, meaning — and with NO
  // aggregation attached, because choosing one is the caller's job, not the schema's.
  const amounts = Object.fromEntries(model.aggregatable.map((x) => [x.field, x]));
  assert.deepEqual(Object.keys(amounts).sort(), ['clicks', 'cost', 'cost_per_click', 'impressions']);
  assert.equal(amounts.cost.unit, 'usd');
  assert.equal(amounts.cost.label, 'UA cost');
  assert.equal(amounts.cost_per_click.expr, 'cost / nullif(clicks, 0)', 'an expression amount carries its expression');
  for (const a of Object.values(amounts)) assert.equal(a.agg, undefined, 'no aggregation is fixed in the schema');
  assert.deepEqual(model.measures, [], 'this source fixes no governed measure');
  const cols = model.columns.map((c) => c.name);
  for (const c of ['cost', 'impressions', 'clicks', 'ingest_batch_id']) assert.ok(cols.includes(c), `${c} is still a real column`);

  // …and a pipeline can still READ the opted-out column: the seed carries one loader batch per
  // row, so grouping by it yields one row per (player, day) — 13.
  const s = await engine.build_native_model({ action: 'start', name: 'acq_batches', source: 'acquisition' });
  await engine.build_native_model({ action: 'add_step', draft_id: s.draft_id, stage: { stage: 'aggregate', group_by: ['ingest_batch_id'], measures: [{ name: 'n', fn: 'count' }] } });
  const c = await engine.build_native_model({ action: 'materialize', draft_id: s.draft_id });
  assert.equal(c.build?.ok, true, JSON.stringify(c.error || c.build));
  assert.equal(c.rows.length, 13, 'one row per (player, day) — the column is readable even though it is not an attribute');
  assert.equal(sumCol(c.rows, 'n'), 13);
});
