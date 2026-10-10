// A NON-EVENTS source with MEASURES declared entirely in the catalog schema: acquisition
// spend at (player, day) grain. Nothing about these measures is known to the code — the
// aggregations, names, units and the percentile parameter all come from meta.mcp — so the
// same declarations work for any column of any source.
// Every assertion is on the NUMBERS returned by dbt + MetricFlow / the pipeline against
// DuckDB, per test/integration/fixtures/SEED_DATA.md (§11).
// Auto-skips when dbt/mf are not installed (HAS_DBT gate).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { loadRecipes } from '../../src/recipes.js';
import { buildWarehouse, fixtureProject } from './warehouse-harness.js';
import { settle } from '../helpers/settle.js';
import { HAS_DBT, testDbt } from '../helpers/dbt-env.js';

const BASE = fixtureProject('dbt_project'); // a private copy: the test files run side by side
const opts = { timeout: 300000 };

let wh; let engine; let backend; let ctx;
const recipes = loadRecipes(join(process.cwd(), 'config', 'recipes.json'));

const num = (v) => Number(v === '' || v == null ? NaN : v);
const sumCol = (rows, col) => rows.reduce((s, r) => s + (Number.isFinite(num(r[col])) ? num(r[col]) : 0), 0);
/** The sum of a measure per key (`keyOf(row)`) over a result grouped by several columns. */
const marginal = (rows, keyOf, valCol) => {
  const out = {};
  for (const r of rows) { const k = keyOf(r); out[k] = (out[k] ?? 0) + (Number.isFinite(num(r[valCol])) ? num(r[valCol]) : 0); }
  return out;
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

before(async () => {
  if (!HAS_DBT) return;
  wh = await buildWarehouse(BASE); // the run's one build of the fixture, copied

  const catalog = loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), { profilesDir: BASE, projectDir: BASE });
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: mkdtempSync(join(tmpdir(), 'mcpit-acq-')), timeSpineDialect: 'duckdb' });
  backend = testDbt({ profilesDir: BASE });
  engine = settle(new Engine({ catalog, contextManager: ctxs, runner: backend }));

  // The schema only MARKS which fields are amounts (cost / impressions / clicks, and the
  // cost_per_click expression). It fixes no aggregation, so the task picks one per question —
  // the same `cost` field is summed here, maxed there, and read at a percentile below.
  const out = await engine.build_semantic_model({
    name: 'uacq',
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
    },
    { from: 'users' }],
    metrics: [
      { name: 'cost', type: 'simple', measure: 'cost' },
      { name: 'impressions', type: 'simple', measure: 'impressions' },
      { name: 'clicks', type: 'simple', measure: 'clicks' },
      { name: 'max_daily_cost', type: 'simple', measure: 'max_daily_cost' },
      { name: 'avg_daily_cost', type: 'simple', measure: 'avg_daily_cost' },
      { name: 'p90_daily_cost', type: 'simple', measure: 'p90_daily_cost' },
      { name: 'avg_cost_per_click', type: 'simple', measure: 'avg_cost_per_click' },
      { name: 'cpc', type: 'ratio', numerator: 'cost', denominator: 'clicks' },
    ],
  });
  assert.equal(out.parse.ok, true, `parse failed: ${JSON.stringify(out.parse)}`);
  ctx = out.context_id;
}, opts);

after(async () => { backend?.close?.(); if (wh) await wh.stop(); });
const skip = (t) => { if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; } return false; };
const q = (input) => engine.query_semantic_model({ context_id: ctx, ...input });

// EVERY AGGREGATION THE TASK CHOSE over the marked amounts, asked in ONE ungrouped query (MetricFlow
// takes all eight metrics in one call); each check is named by the question it answers.
test('every aggregation the task chose over the marked amounts, in one ungrouped query: cost / impressions / clicks, max / mean / p90, the mean per-row cost per click, CPC', opts, async (t) => {
  if (skip(t)) return;
  const r = await q({ metrics: ['uacq_cost', 'uacq_impressions', 'uacq_clicks', 'uacq_max_daily_cost', 'uacq_avg_daily_cost', 'uacq_p90_daily_cost', 'uacq_avg_cost_per_click', 'uacq_cpc'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const row = r.rows[0];

  // [a marked amount is aggregated the way the task asks] SEED_DATA §11: 13 rows, cost 17.50,
  // impressions 1280, clicks 64.
  assert.ok(near(num(row.uacq_cost), 17.5), `[marked amount: cost 17.50] cost=${row.uacq_cost}`);
  assert.equal(num(row.uacq_impressions), 1280, '[marked amount: impressions 1280]');
  assert.equal(num(row.uacq_clicks), 64, '[marked amount: clicks 64]');

  // [the same amount under three measures] THE SAME marked field, three different aggregations
  // chosen by the task — including one that carries a parameter. Over the 13 daily costs: max 3.00,
  // mean 17.50/13, and percentile_cont(0.9) interpolating between 2.50 and 2.75 → 2.70. Nothing in
  // the schema decided any of these.
  assert.ok(near(num(row.uacq_max_daily_cost), 3.0), `[three measures: max 3.00] max=${row.uacq_max_daily_cost}`);
  assert.ok(near(num(row.uacq_avg_daily_cost), 17.5 / 13, 1e-6), `[three measures: mean 17.50/13] avg=${row.uacq_avg_daily_cost}`);
  assert.ok(near(num(row.uacq_p90_daily_cost), 2.7, 1e-4), `[three measures: p90 2.70] p90=${row.uacq_p90_daily_cost}`);

  // [an aggregatable expression] A model-level entry is an aggregatable EXPRESSION over the model's
  // columns, equally free of a fixed function. cost_per_click = cost / clicks per row; the four rows
  // with no clicks are NULL, so the mean is over the nine that have them.
  const perRow = [[1.50, 5], [2.00, 8], [1.25, 6], [3.00, 10], [0.50, 2], [2.50, 9], [1.75, 7], [2.25, 8], [2.75, 9]].map(([c, k]) => c / k);
  const expected = perRow.reduce((a, b) => a + b, 0) / perRow.length;
  assert.ok(near(num(row.uacq_avg_cost_per_click), expected, 1e-6), `[aggregatable expression: mean per-row cost per click] avg cpc=${row.uacq_avg_cost_per_click} want ${expected}`);

  // [a ratio metric over two task measures] 17.50 / 64.
  assert.ok(near(num(row.uacq_cpc), 17.5 / 64, 1e-6), `[ratio of two task measures: CPC = 17.50/64] cpc=${row.uacq_cpc}`);
});

// SEED_DATA §11: cost by channel — meta 5.75, applovin 8.25, google 3.50, organic 0.
// meta.mcp.is_time gives a NON-events source its own time axis, so metric_time works on it.
// SEED_DATA §11 per day: 1.50 / 3.25 / 3.50 / 4.25 / 5.00.
// cost is a sum, so the channel and the day splits are the marginals of ONE query grouped by both;
// its time_range is the source's whole span (01-01..01-05: every spend row, 17.50), so the channel
// split is the unwindowed one.
test('grouped by an attribute of the same source: cost by media_source; and the declared time axis drives metric_time on a non-events source', opts, async (t) => {
  if (skip(t)) return;
  const r = await q({ metrics: ['uacq_cost'], group_by: [{ model: 'acquisition', attribute: 'media_source' }, { time: 'metric_time', grain: 'day' }], time_range: { start: '2026-01-01', end: '2026-01-05' } });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const by = marginal(r.rows, (row) => String(row[r.group_by_resolved['acquisition.media_source']]), 'uacq_cost');
  assert.ok(near(by.meta, 5.75), `[by media_source] meta=${by.meta}`);
  assert.ok(near(by.applovin, 8.25), `[by media_source] applovin=${by.applovin}`);
  assert.ok(near(by.google, 3.5), `[by media_source] google=${by.google}`);
  assert.ok(near(by.organic, 0), `[by media_source] organic=${by.organic}`);
  assert.ok(near(sumCol(r.rows, 'uacq_cost'), 17.5), '[by media_source] the channels sum to 17.50');
  const byDay = marginal(r.rows, (row) => String(row.metric_time_day).slice(0, 10), 'uacq_cost');
  assert.ok(near(byDay['2026-01-01'], 1.5), `[time axis] ${JSON.stringify(byDay)}`);
  assert.ok(near(byDay['2026-01-02'], 3.25), `[time axis] ${JSON.stringify(byDay)}`);
  assert.ok(near(byDay['2026-01-03'], 3.5), `[time axis] ${JSON.stringify(byDay)}`);
  assert.ok(near(byDay['2026-01-04'], 4.25), `[time axis] ${JSON.stringify(byDay)}`);
  assert.ok(near(byDay['2026-01-05'], 5.0), `[time axis] ${JSON.stringify(byDay)}`);
  assert.ok(near(sumCol(r.rows, 'uacq_cost'), 17.5), '[time axis] the days sum to 17.50');
});

// (Spend by users.country, attributed POINT-IN-TIME to the install version valid on the spend day —
// US 6.75 / GB 5.00 / DE 4.00 / BR 1.75 — is mcp-end-to-end.test.js #1, the same measure over MCP.)

// A COMPOSITE join key is what keeps a per-day table from fanning out: u1 has spend on TWO
// days (SEED_DATA §11), so joining 12 first_launch events on the player alone yields 13 rows,
// while joining on player + day yields exactly 12.
test('composite join key prevents fan-out: player+day = 12 rows, player alone = 13', opts, async (t) => {
  if (skip(t)) return;
  const rowsAfterJoin = async (name, on) => {
    const s = await engine.build_pipeline_model({ action: 'start', name, source: 'events' });
    await engine.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, stages: [{ stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'first_launch' }] }] });
    await engine.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, stages: [{ stage: 'compute', name: 'spend_date', expr: { fn: 'date_trunc', args: [{ column: 'device_time' }], grain: 'day' } }] });
    await engine.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, stages: [{ stage: 'join', with: 'acquisition', via: { on }, attrs: [{ column: 'media_source' }] }] });
    await engine.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, stages: [{ stage: 'aggregate', measures: [{ name: 'n', agg: 'count' }] }] });
    const c = await engine.build_pipeline_model({ action: 'materialize', context_id: s.context_id });
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
  const model = await engine.semantic_index({ source: 'acquisition' });
  const dims = model.dimensions.map((d) => d.name);
  // The measure columns and the `dimension: false` column are NOT attributes; the source's
  // declared time axis is (grouping spend by its own day needs no join).
  assert.deepEqual(dims.sort(), ['campaign', 'campaign_id', 'media_source', 'spend_date'], 'measures and the opted-out column are not attributes');
  assert.equal(model.time, 'spend_date', 'the declared axis is reported as the source\'s time');
  // The amounts come back marked and self-describing — field, unit, meaning — and with NO
  // aggregation attached, because choosing one is the caller's job, not the schema's.
  const amounts = Object.fromEntries(model.aggregatable.map((x) => [x.field, x]));
  assert.deepEqual(Object.keys(amounts).sort(), ['clicks', 'cost', 'cost_per_click', 'impressions', 'total_spend']);
  assert.equal(amounts.cost.unit, 'usd');
  assert.equal(amounts.cost.label, 'UA cost');
  assert.equal(amounts.cost_per_click.expr, 'cost / nullif(clicks, 0)', 'an expression amount carries its expression');
  for (const a of Object.values(amounts)) assert.equal(a.agg, undefined, 'no aggregation is fixed in the schema');
  // The one declaration WITH `agg` is additionally reported as a governed measure — the free
  // choice over the same expression stays above, which is why `total_spend` appears in both.
  assert.deepEqual(model.measures.map((x) => [x.name, x.agg]), [['total_spend', 'sum']], 'the governed measure is listed with its fixed function');
  const cols = model.columns.map((c) => c.name);
  for (const c of ['cost', 'impressions', 'clicks', 'ingest_batch_id']) assert.ok(cols.includes(c), `${c} is still a real column`);

  // …and a pipeline can still READ the opted-out column: the seed carries one loader batch per
  // row, so grouping by it yields one row per (player, day) — 13.
  const s = await engine.build_pipeline_model({ action: 'start', name: 'acq_batches', source: 'acquisition' });
  await engine.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, stages: [{ stage: 'aggregate', group_by: ['ingest_batch_id'], measures: [{ name: 'n', agg: 'count' }] }] });
  const c = await engine.build_pipeline_model({ action: 'materialize', context_id: s.context_id });
  assert.equal(c.build?.ok, true, JSON.stringify(c.error || c.build));
  assert.equal(c.rows.length, 13, 'one row per (player, day) — the column is readable even though it is not an attribute');
  assert.equal(sumCol(c.rows, 'n'), 13);
});

// The GOVERNED twin of the free-choice form. `cost` is a marked amount — every task above picked
// its own function over it (sum, max, average, p90). `total_spend` is the same column declared
// WITH `agg: sum` in the schema, so it is one measure whose function nobody re-decides. The task
// only names it; it must reach the manifest from the source that declared it.
test('a governed measure declared in the schema: total_spend = 17.50, applovin 8.25', opts, async (t) => {
  if (skip(t)) return;
  // The task declares NO measure of its own: it names the schema's, and adds only the attribute
  // it wants to slice by. It is the shipped recipe's own payload (governed_measure_by_name), and its
  // first query is the recipe's first example — this test is that recipe's data proof
  // (test/helpers/recipe-coverage.js).
  const out = await engine.build_semantic_model(recipes.get('governed_measure_by_name').semantic_payload);
  assert.equal(out.parse.ok, true, JSON.stringify(out.parse));
  const r = await engine.query_semantic_model({ context_id: out.context_id, metrics: ['gov_total_spend'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.ok(near(num(r.rows[0].gov_total_spend), 17.5), `total_spend=${r.rows[0].gov_total_spend}`);

  // it groups like any other measure — by the source's own attribute, and through a declared
  // relationship exactly as a task measure does: a sum, so both are the marginals of ONE query
  const g = await engine.query_semantic_model({ context_id: out.context_id, metrics: ['gov_total_spend'], group_by: [{ model: 'acquisition', attribute: 'media_source' }, { model: 'users', attribute: 'country' }] });
  assert.equal(g.ok, true, JSON.stringify(g.error));
  const by = marginal(g.rows, (row) => String(row[g.group_by_resolved['acquisition.media_source']]), 'gov_total_spend');
  assert.ok(near(by.applovin, 8.25), `[by media_source] applovin=${by.applovin}`);
  assert.ok(near(by.meta, 5.75), `[by media_source] meta=${by.meta}`);
  assert.ok(near(by.google, 3.5), `[by media_source] google=${by.google}`);
  assert.ok(near(sumCol(g.rows, 'gov_total_spend'), 17.5), '[by media_source] the channels sum to 17.50');
  assert.ok(near(sumCol(g.rows, 'gov_total_spend'), 17.5), '[by users.country] the point-in-time join keeps the total');
});
