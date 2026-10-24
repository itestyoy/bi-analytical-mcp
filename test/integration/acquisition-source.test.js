// A NON-EVENTS source with MEASURES declared entirely in the catalog schema: acquisition
// spend at (player, day) grain. Nothing about these measures is known to the code — the
// aggregations, names, units and the percentile parameter all come from meta.mcp — so the
// same declarations work for any column of any source.
// Every assertion is on the NUMBERS returned by dbt + MetricFlow / the pipeline against
// DuckDB, per test/integration/fixtures/SEED_DATA.md (§11).
// Auto-skips when dbt/mf are not installed (HAS_DBT gate).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { mcp } from '../helpers/catalog-doc.js';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { loadRecipes } from '../../src/recipes.js';
import { buildWarehouse, fixtureProject } from './warehouse-harness.js';
import { settle, taskResult } from '../helpers/settle.js';
import { HAS_DBT, testDbt } from '../helpers/dbt-env.js';
import { tempDir } from '../helpers/temp-dir.js';
import { declare } from '../helpers/declare.js';

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
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: tempDir('mcpit-acq'), timeSpineDialect: 'duckdb' });
  backend = testDbt({ profilesDir: BASE });
  engine = settle(new Engine({ catalog, contextManager: ctxs, runner: backend }));

  // The schema only MARKS which fields are amounts (cost / impressions / clicks, and the
  // cost_per_click expression). It fixes no aggregation, so the task picks one per question —
  // the same `cost` field is summed here, maxed there, and read at a percentile below.
  const out = await declare(engine, {
    name: 'uacq',
    semantic_models: [{
      source: 'acquisition',
      measures: [
        { name: 'cost', expr: { fn: 'sum', args: [{ column: 'cost' }] } },
        { name: 'impressions', expr: { fn: 'sum', args: [{ column: 'impressions' }] } },
        { name: 'clicks', expr: { fn: 'sum', args: [{ column: 'clicks' }] } },
        { name: 'max_daily_cost', expr: { fn: 'max', args: [{ column: 'cost' }] } },
        { name: 'avg_daily_cost', expr: { fn: 'average', args: [{ column: 'cost' }] } },
        { name: 'p90_daily_cost', expr: { fn: 'percentile', args: [{ column: 'cost' }], percentile: 0.9 } },
        { name: 'avg_cost_per_click', expr: { fn: 'average', args: [{ column: 'cost_per_click' }] } },
      ],
    },
    { source: 'users' }],
    metrics: [
      { name: 'cost', type: 'simple', measure: 'cost' },
      { name: 'impressions', type: 'simple', measure: 'impressions' },
      { name: 'clicks', type: 'simple', measure: 'clicks' },
      { name: 'max_daily_cost', type: 'simple', measure: 'max_daily_cost' },
      { name: 'avg_daily_cost', type: 'simple', measure: 'avg_daily_cost' },
      { name: 'p90_daily_cost', type: 'simple', measure: 'p90_daily_cost' },
      { name: 'avg_cost_per_click', type: 'simple', measure: 'avg_cost_per_click' },
      // a ratio is a derived metric whose expression divides one metric by another
      { name: 'cpc', type: 'derived', expr: { fn: 'div', args: [{ metric: 'cost' }, { metric: 'clicks' }] } },
    ],
  });
  assert.equal(out.parse.ok, true, `parse failed: ${JSON.stringify(out.parse)}`);
  ctx = out.context_id;
}, opts);

after(async () => { backend?.close?.(); if (wh) await wh.stop(); });
const skip = (t) => { if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; } return false; };
const q = (input) => engine.query_model({ context_id: ctx, ...input });

// EVERY AGGREGATION THE TASK CHOSE over the marked amounts, asked in ONE ungrouped query (MetricFlow
// takes all eight metrics in one call); each check is named by the question it answers.
test('every aggregation the task chose over the marked amounts, in one ungrouped query: cost / impressions / clicks, max / mean / p90, the mean per-row cost per click, CPC', opts, async (t) => {
  if (skip(t)) return;
  const r = await q({ steps: [{ stage: 'metrics', metrics: ['cost', 'impressions', 'clicks', 'max_daily_cost', 'avg_daily_cost', 'p90_daily_cost', 'avg_cost_per_click', 'cpc'] }] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const row = r.rows[0];

  // [a marked amount is aggregated the way the task asks] SEED_DATA §11: 13 rows, cost 17.50,
  // impressions 1280, clicks 64.
  assert.ok(near(num(row.cost), 17.5), `[marked amount: cost 17.50] cost=${row.cost}`);
  assert.equal(num(row.impressions), 1280, '[marked amount: impressions 1280]');
  assert.equal(num(row.clicks), 64, '[marked amount: clicks 64]');

  // [the same amount under three measures] THE SAME marked field, three different aggregations
  // chosen by the task — including one that carries a parameter. Over the 13 daily costs: max 3.00,
  // mean 17.50/13, and percentile_cont(0.9) interpolating between 2.50 and 2.75 → 2.70. Nothing in
  // the schema decided any of these.
  assert.ok(near(num(row.max_daily_cost), 3.0), `[three measures: max 3.00] max=${row.max_daily_cost}`);
  assert.ok(near(num(row.avg_daily_cost), 17.5 / 13, 1e-6), `[three measures: mean 17.50/13] avg=${row.avg_daily_cost}`);
  assert.ok(near(num(row.p90_daily_cost), 2.7, 1e-4), `[three measures: p90 2.70] p90=${row.p90_daily_cost}`);

  // [an aggregatable expression] A model-level entry is an aggregatable EXPRESSION over the model's
  // columns, equally free of a fixed function. cost_per_click = cost / clicks per row; the four rows
  // with no clicks are NULL, so the mean is over the nine that have them.
  const perRow = [[1.50, 5], [2.00, 8], [1.25, 6], [3.00, 10], [0.50, 2], [2.50, 9], [1.75, 7], [2.25, 8], [2.75, 9]].map(([c, k]) => c / k);
  const expected = perRow.reduce((a, b) => a + b, 0) / perRow.length;
  assert.ok(near(num(row.avg_cost_per_click), expected, 1e-6), `[aggregatable expression: mean per-row cost per click] avg cpc=${row.avg_cost_per_click} want ${expected}`);

  // [a derived metric dividing two task metrics] 17.50 / 64.
  assert.ok(near(num(row.cpc), 17.5 / 64, 1e-6), `[div of two task metrics: CPC = 17.50/64] cpc=${row.cpc}`);
});

// SEED_DATA §11: cost by channel — meta 5.75, applovin 8.25, google 3.50, organic 0.
// meta.mcp.is_time gives a NON-events source its own time axis, so metric_time works on it.
// SEED_DATA §11 per day: 1.50 / 3.25 / 3.50 / 4.25 / 5.00.
// cost is a sum, so the channel and the day splits are the marginals of ONE query grouped by both;
// its time_range is the source's whole span (01-01..01-05: every spend row, 17.50), so the channel
// split is the unwindowed one.
test('grouped by an attribute of the same source: cost by media_source; and the declared time axis drives metric_time on a non-events source', opts, async (t) => {
  if (skip(t)) return;
  const r = await q({ steps: [{ stage: 'metrics', metrics: ['cost'], group_by: [{ source: 'acquisition', column: 'media_source' }, { time: 'metric_time', grain: 'day' }] }], time_range: { start: '2026-01-01', end: '2026-01-05' } });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const by = marginal(r.rows, (row) => String(row[r.group_by_resolved['acquisition.media_source']]), 'cost');
  assert.ok(near(by.meta, 5.75), `[by media_source] meta=${by.meta}`);
  assert.ok(near(by.applovin, 8.25), `[by media_source] applovin=${by.applovin}`);
  assert.ok(near(by.google, 3.5), `[by media_source] google=${by.google}`);
  assert.ok(near(by.organic, 0), `[by media_source] organic=${by.organic}`);
  assert.ok(near(sumCol(r.rows, 'cost'), 17.5), '[by media_source] the channels sum to 17.50');
  const byDay = marginal(r.rows, (row) => String(row.metric_time_day).slice(0, 10), 'cost');
  assert.ok(near(byDay['2026-01-01'], 1.5), `[time axis] ${JSON.stringify(byDay)}`);
  assert.ok(near(byDay['2026-01-02'], 3.25), `[time axis] ${JSON.stringify(byDay)}`);
  assert.ok(near(byDay['2026-01-03'], 3.5), `[time axis] ${JSON.stringify(byDay)}`);
  assert.ok(near(byDay['2026-01-04'], 4.25), `[time axis] ${JSON.stringify(byDay)}`);
  assert.ok(near(byDay['2026-01-05'], 5.0), `[time axis] ${JSON.stringify(byDay)}`);
  assert.ok(near(sumCol(r.rows, 'cost'), 17.5), '[time axis] the days sum to 17.50');
});

// (Spend by users.country, attributed POINT-IN-TIME to the install version valid on the spend day —
// US 6.75 / GB 5.00 / DE 4.00 / BR 1.75 — is mcp-end-to-end.test.js #1, the same measure over MCP.)

// THE DAY IS PART OF THE KEY: u1 has spend on TWO days (SEED_DATA §11), so the 12 first_launch events
// joined on the player alone would be 13 rows; the acquisition contract joins the player AND the day of
// the moment named, so they stay exactly 12.
test('the same-day contract prevents fan-out: 12 first launches stay 12 rows', opts, async (t) => {
  if (skip(t)) return;
  const s = await engine.build_model({ action: 'start', name: 'acq_join_day', source: 'events' });
  for (const step of [
    { stage: 'where', conditions: [{ fn: 'eq', args: [{ column: 'event_name' }, { value: 'first_launch' }] }] },
    { stage: 'join', source: 'acquisition', on: { user: 'player_id_of_internal', time: 'device_time' }, attrs: [{ column: 'media_source' }] },
    { stage: 'aggregate', measures: [{ name: 'n', expr: { fn: 'count' } }, { name: 'matched', expr: { fn: 'count', args: [{ column: 'media_source' }] } }] },
  ]) await engine.build_model({ action: 'add_steps', context_id: s.context_id, steps: [step] });
  const c = await engine.build_model({ action: 'materialize', context_id: s.context_id });
  assert.equal(c.build?.ok, true, JSON.stringify(c.error || c.build));
  assert.equal(num(c.rows[0].n), 12, 'one row per first launch: the day keeps u1 from meeting both spend days');
  const { rows } = await wh.query(`SELECT count(*) AS n FROM main.fct_analytics_events e JOIN main.fct_player_acquisition a ON e.player_id_of_internal = a.player_id_of_internal AND CAST(e.device_time AS DATE) = CAST(a.spend_date AS DATE) WHERE e.event_name = 'first_launch'`);
  assert.equal(num(c.rows[0].matched), num(rows[0].n), 'the launches that met their day\'s spend record, as a hand-written join counts them');
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
  // The amounts come back marked and self-describing — column, unit, meaning — and with NO
  // aggregation attached, because choosing one is the caller's job, not the schema's.
  const amounts = Object.fromEntries(model.aggregatable.map((x) => [x.column, x]));
  assert.deepEqual(Object.keys(amounts).sort(), ['clicks', 'cost', 'cost_per_click', 'impressions', 'total_spend']);
  assert.equal(amounts.cost.unit, 'usd');
  assert.equal(amounts.cost.label, 'UA cost');
  assert.equal(amounts.cost_per_click.expr, 'cost / nullif(clicks, 0)', 'an expression amount carries its expression');
  for (const a of Object.values(amounts)) assert.ok(!('fn' in a) && !('agg' in a), 'no aggregation is fixed in the schema');
  // The one declaration WITH `agg` is additionally reported as a governed measure — the free
  // choice over the same expression stays above, which is why `total_spend` appears in both.
  assert.deepEqual(model.measures.map((x) => [x.name, x.agg]), [['total_spend', 'sum']], 'the governed measure is listed with its fixed function');
  const cols = model.columns.map((c) => c.name);
  for (const c of ['cost', 'impressions', 'clicks', 'ingest_batch_id']) assert.ok(cols.includes(c), `${c} is still a real column`);

  // …and a pipeline can still READ the opted-out column: the seed carries one loader batch per
  // row, so grouping by it yields one row per (player, day) — 13.
  const s = await engine.build_model({ action: 'start', name: 'acq_batches', source: 'acquisition' });
  await engine.build_model({ action: 'add_steps', context_id: s.context_id, steps: [{ stage: 'aggregate', group_by: ['ingest_batch_id'], measures: [{ name: 'n', expr: { fn: 'count' } }] }] });
  const c = await engine.build_model({ action: 'materialize', context_id: s.context_id });
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
  const out = await declare(engine, recipes.get('governed_measure_by_name').semantic_payload);
  assert.equal(out.parse.ok, true, JSON.stringify(out.parse));
  const r = await engine.query_model({ context_id: out.context_id, steps: [{ stage: 'metrics', metrics: ['total_spend'] }] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.ok(near(num(r.rows[0].total_spend), 17.5), `total_spend=${r.rows[0].total_spend}`);

  // it groups like any other measure — by the source's own attribute, and through a declared
  // relationship exactly as a task measure does: a sum, so both are the marginals of ONE query
  const g = await engine.query_model({ context_id: out.context_id, steps: [{ stage: 'metrics', metrics: ['total_spend'], group_by: [{ source: 'acquisition', column: 'media_source' }, { source: 'users', column: 'country' }] }] });
  assert.equal(g.ok, true, JSON.stringify(g.error));
  const by = marginal(g.rows, (row) => String(row[g.group_by_resolved['acquisition.media_source']]), 'total_spend');
  assert.ok(near(by.applovin, 8.25), `[by media_source] applovin=${by.applovin}`);
  assert.ok(near(by.meta, 5.75), `[by media_source] meta=${by.meta}`);
  assert.ok(near(by.google, 3.5), `[by media_source] google=${by.google}`);
  assert.ok(near(sumCol(g.rows, 'total_spend'), 17.5), '[by media_source] the channels sum to 17.50');
  // the country is the install version valid on the spend day (SEED_DATA §13): u1's two spend rows fall
  // in two versions (01-01 US 1.50, 01-03 GB 0.50), so the split is US 6.75 / GB 5.00 / DE 4.00 / BR 1.75
  // — u1's first version for both days would make it US 7.25 / GB 4.50, its last US 5.25 / GB 6.50, and
  // the key alone would count u1's rows twice (the countries would sum to 19.50, not 17.50)
  const byCountry = marginal(g.rows, (row) => String(row[g.group_by_resolved['users.country']]), 'total_spend');
  assert.deepEqual(Object.keys(byCountry).sort(), ['BR', 'DE', 'GB', 'US'], `[by users.country] every spend row has the country valid on its day: ${JSON.stringify(byCountry)}`);
  assert.ok(near(byCountry.US, 6.75), `[by users.country] US=${byCountry.US}`);
  assert.ok(near(byCountry.GB, 5.0), `[by users.country] GB=${byCountry.GB}`);
  assert.ok(near(byCountry.DE, 4.0), `[by users.country] DE=${byCountry.DE}`);
  assert.ok(near(byCountry.BR, 1.75), `[by users.country] BR=${byCountry.BR}`);
});

// A model whose identity names no key column (a variant of the fixture: acquisition's primary entity a
// name alone, its acquisition_id an ordinary column) is grouped by its own columns, never by that
// identity — which would read a column of its name the table does not have: a validate over a window
// runs every column it can be cut by, and each comes back.
test('a source whose identity has no key column validates whole: every column it can be cut by runs', opts, async (t) => {
  if (skip(t)) return;
  const doc = yaml.load(readFileSync(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), 'utf8'));
  const acq = doc.models.find((m) => mcp(m).role === 'acquisition');
  const idCol = acq.columns.find((c) => c.name === 'acquisition_id');
  delete idCol.config;
  const at = join(tempDir('mcpit-keyless'), 'catalog.yml');
  writeFileSync(at, yaml.dump(doc));
  const keyless = settle(new Engine({ catalog: loadCatalog(at, { profilesDir: BASE, projectDir: BASE }), contextManager: new ContextManager({ baseProjectDir: BASE, workspaceRoot: tempDir('mcpit-keyless-ws'), timeSpineDialect: 'duckdb' }), runner: backend }));
  const out = await declare(keyless, { name: 'keyless', semantic_models: [{ source: 'acquisition', measures: [{ name: 'cost', expr: { fn: 'sum', args: [{ column: 'cost' }] } }] }], metrics: [{ name: 'cost', type: 'simple', measure: 'cost' }] });
  assert.equal(out.parse.ok, true, JSON.stringify(out.parse));
  const started = await keyless.raw.context({ action: 'describe', context_id: out.context_id, validate: true, time_range: { start: '2026-01-01', end: '2026-01-31' } });
  const checked = await taskResult(keyless, started.task_id);
  const sm = checked.ran.semantic_models.find((x) => x.semantic_model === 'acquisition');
  assert.deepEqual([sm?.checked, sm?.ok, sm?.failed], [true, true, undefined], JSON.stringify(sm));
  assert.ok(checked.ran.metrics.find((m) => m.metric === 'cost').value > 0, 'the metric reads rows in the window');
});

// A column the schema marks required_filter (a variant of the fixture: acquisition's media_source) is
// one every question over the model should filter: a metric or a build over its rows that compares it
// nowhere is warned (and still answered — all of its values together), and one that filters it — a
// where step, or a case in the measure — is not. The numbers are the fixture's (SEED_DATA §11).
test('a required_filter column: an answer over all its values is warned, a filtered one is not — 17.50 vs applovin 8.25', opts, async (t) => {
  if (skip(t)) return;
  const doc = yaml.load(readFileSync(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), 'utf8'));
  const acq = doc.models.find((m) => mcp(m).role === 'acquisition');
  acq.columns.find((c) => c.name === 'media_source').config = { meta: { mcp: { required_filter: true } } };
  // campaign is required only of applovin's rows (a column required `when` another holds some values)
  acq.columns.find((c) => c.name === 'campaign').config = { meta: { mcp: { required_filter: { when: { media_source: 'applovin' } } } } };
  const at = join(tempDir('mcpit-reqfilter'), 'catalog.yml');
  writeFileSync(at, yaml.dump(doc));
  const e = settle(new Engine({ catalog: loadCatalog(at, { profilesDir: BASE, projectDir: BASE }), contextManager: new ContextManager({ baseProjectDir: BASE, workspaceRoot: tempDir('mcpit-reqfilter-ws'), timeSpineDialect: 'duckdb' }), runner: backend }));
  const warnedOf = (r, column) => (r.warnings || []).some((w) => w.includes('required_filter') && w.includes(`'${column}'`));
  const warned = (r) => warnedOf(r, 'media_source');
  const applovin = { fn: 'eq', args: [{ column: 'media_source' }, { value: 'applovin' }] };
  const out = await declare(e, {
    name: 'reqf',
    semantic_models: [{ source: 'acquisition', measures: [
      { name: 'cost', expr: { fn: 'sum', args: [{ column: 'cost' }] } },
      { name: 'applovin_cost', expr: { fn: 'sum', args: [{ fn: 'case', cases: [{ when: [applovin], then: { column: 'cost' } }] }] } },
      { name: 'meta_cost', expr: { fn: 'sum', args: [{ fn: 'case', cases: [{ when: [{ fn: 'eq', args: [{ column: 'media_source' }, { value: 'meta' }] }], then: { column: 'cost' } }] }] } },
    ] }],
    metrics: [{ name: 'cost', type: 'simple', measure: 'cost' }, { name: 'applovin_cost', type: 'simple', measure: 'applovin_cost' }, { name: 'meta_cost', type: 'simple', measure: 'meta_cost' }],
  });
  assert.equal(out.parse.ok, true, JSON.stringify(out.parse));
  const all = await e.query_model({ context_id: out.context_id, steps: [{ stage: 'metrics', metrics: ['cost'] }] });
  assert.equal(all.ok, true, JSON.stringify(all.error));
  assert.ok(near(num(all.rows[0].cost), 17.5), `cost=${all.rows[0].cost}`);
  assert.ok(warned(all), `cost folds every media_source: ${JSON.stringify(all.warnings)}`);
  const own = await e.query_model({ context_id: out.context_id, steps: [{ stage: 'metrics', metrics: ['applovin_cost'] }] });
  assert.ok(near(num(own.rows[0].applovin_cost), 8.25), `applovin_cost=${own.rows[0].applovin_cost}`);
  assert.ok(!warned(own), `a measure whose case compares the column folds the rows it names: ${JSON.stringify(own.warnings)}`);
  assert.ok(warnedOf(own, 'campaign'), `applovin's rows: campaign is required of them: ${JSON.stringify(own.warnings)}`);
  const meta = await e.query_model({ context_id: out.context_id, steps: [{ stage: 'metrics', metrics: ['meta_cost'] }] });
  assert.ok(near(num(meta.rows[0].meta_cost), 5.75), `meta_cost=${meta.rows[0].meta_cost}`);
  assert.ok(!warnedOf(meta, 'media_source') && !warnedOf(meta, 'campaign'), `meta's rows: campaign is not required of them: ${JSON.stringify(meta.warnings)}`);
  const one = await e.query_model({ context_id: out.context_id, steps: [{ stage: 'where', conditions: [{ fn: 'eq', args: [{ source: 'acquisition', column: 'media_source' }, { value: 'applovin' }] }] }, { stage: 'metrics', metrics: ['cost', 'applovin_cost'] }] });
  assert.equal(one.ok, true, JSON.stringify(one.error));
  assert.ok(near(num(one.rows[0].cost), 8.25) && near(num(one.rows[0].applovin_cost), 8.25), JSON.stringify(one.rows));
  assert.ok(!warned(one), JSON.stringify(one.warnings));

  const plain = await declare(e, { name: 'reqf_plain', semantic_models: [{ source: 'acquisition', measures: [{ name: 'cost', expr: { fn: 'sum', args: [{ column: 'cost' }] } }] }], metrics: [{ name: 'cost', type: 'simple', measure: 'cost' }] });
  const unfiltered = await e.query_model({ context_id: plain.context_id, steps: [{ stage: 'metrics', metrics: ['cost'] }] });
  assert.ok(near(num(unfiltered.rows[0].cost), 17.5), `cost=${unfiltered.rows[0].cost}`);
  assert.ok(warned(unfiltered), `an answer over every media_source is warned: ${JSON.stringify(unfiltered.warnings)}`);
  const filtered = await e.query_model({ context_id: plain.context_id, steps: [{ stage: 'where', conditions: [{ fn: 'eq', args: [{ source: 'acquisition', column: 'media_source' }, { value: 'applovin' }] }] }, { stage: 'metrics', metrics: ['cost'] }] });
  assert.ok(near(num(filtered.rows[0].cost), 8.25), `cost=${filtered.rows[0].cost}`);
  assert.ok(!warned(filtered), JSON.stringify(filtered.warnings));

  // a build over the model's rows: warned without a where on the column, not with one
  const build = async (name, steps) => {
    const s = await e.build_model({ action: 'start', name, source: 'acquisition' });
    await e.build_model({ action: 'add_steps', context_id: s.context_id, steps });
    return e.build_model({ action: 'materialize', context_id: s.context_id });
  };
  const sum = { stage: 'aggregate', measures: [{ name: 'cost', expr: { fn: 'sum', args: [{ column: 'cost' }] } }] };
  const b1 = await build('reqf_all', [sum]);
  assert.ok(near(num(b1.rows[0].cost), 17.5) && warned(b1), JSON.stringify({ rows: b1.rows, warnings: b1.warnings }));
  const b2 = await build('reqf_one', [{ stage: 'where', conditions: [applovin] }, sum]);
  assert.ok(near(num(b2.rows[0].cost), 8.25) && !warned(b2), JSON.stringify({ rows: b2.rows, warnings: b2.warnings }));
});
