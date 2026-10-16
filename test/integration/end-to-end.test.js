// END-TO-END integration test: ONE realistic analytics workflow that exercises ALL
// the MCP tools together and verifies they chain correctly. A single seed+run feeds
// every hop. The story (an analyst onboarding into a new dataset):
//   (Discovery and the value index's sync state — semantic_index overview → event →
//    property → value search, and { status } after a refresh — are value-index.test.js's,
//    which builds the index over the same fixture.)
//   3. PIPELINE — build_model (start/add_steps/preview/commit) builds the
//                    activation funnel; rows read back via query_model (12/8/5/3,
//                    the same counts the funnels of pipeline-stages.test.js prove on the
//                    all-at-once build).
//   4. SEMANTIC    — build_semantic_model (IAP revenue) → query_model by
//                    country → an edit of the semantic_model step adds a payers metric → re-query;
//                    context({describe|list}) + semantic_index({status}) lifecycle.
//   5. A/B         — build_model fed the conversion recipe's steps one-at-a-
//                    time → materialize → per-variant aggregates → experiment analyze + check_split +
//                    plan: the conversion recipe's data proof (model-results.test.js runs the
//                    others).
//   6. RECIPES     — semantic_index overview list + semantic_index({ recipe: id }).
//   7. TEARDOWN    — delete_context({ what: semantic_model | pipeline_model | context }), then
//                    context({list}) shows the dropped context gone.
//
// DATA-ONLY: every substantive assertion is on a returned VALUE/COUNT (grounded in
// fixtures/SEED_DATA.md and the existing integration tests). The only non-data checks
// are model_sql existence, recommendations-are-strings, and context/job lifecycle.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadCatalog } from '../../src/catalog.js';
import { loadRecipes } from '../../src/recipes.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { buildWarehouse, fixtureProject } from './warehouse-harness.js';
import { settle, readTable, one, stepEffect } from '../helpers/settle.js';
import { armFrom } from '../helpers/experiment-arm.js';
import { HAS_DBT, testDbt } from '../helpers/dbt-env.js';
import { tempDir } from '../helpers/temp-dir.js';
import { declare, editLayer } from '../helpers/declare.js';

const BASE = fixtureProject('dbt_project'); // a private copy: the test files run side by side
const opts = { timeout: 300000 };

const num = (v) => Number(v);
const tru = (v) => v === true || v === 't' || v === 'true' || v === 1 || v === '1';
const reached = (rows, step) => rows.filter((r) => tru(r[`reached_${step}`])).length;
const close = (a, b, tol = 1e-3) => assert.ok(Math.abs(a - b) <= tol, `${a} ≈ ${b}`);

// Shared state threaded through the ORDERED tests below (one coherent workflow).
let wh; let engine; let backend; let recipes;
const S = {}; // S.semCtx, S.draftId, S.pipeCtx, S.pipeTable, S.abCtx

// The canonical 4-step activation funnel (the same steps as the funnels of pipeline-stages.test.js).
const activationSteps = [
  { name: 'launch', event_name: ['first_launch'] },
  { name: 'tut1', event_name: ['tutorial'], where: [{ fn: 'eq', args: [{ column: 'element_of_event_data' }, { value: 'step_1' }] }] },
  { name: 'tut2', event_name: ['tutorial'], where: [{ fn: 'eq', args: [{ column: 'element_of_event_data' }, { value: 'step_2' }] }] },
  { name: 'tut3', event_name: ['tutorial'], where: [{ fn: 'eq', args: [{ column: 'element_of_event_data' }, { value: 'step_3' }] }] },
];
const matchActivation = (extra = {}) => ({ stage: 'match_recognize', partition_by: ['player_id_of_internal'], steps: activationSteps, ...extra });

const skip = (t) => { if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; } return false; };

before(async () => {
  if (!HAS_DBT) return;
  wh = await buildWarehouse(BASE); // the run's one build of the fixture, copied
  const catalog = loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), { profilesDir: BASE, projectDir: BASE });
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: tempDir('e2e'), timeSpineDialect: 'duckdb' });
  backend = testDbt({ profilesDir: BASE });
  recipes = loadRecipes(join(process.cwd(), 'config', 'recipes.json'));
  engine = settle(new Engine({ catalog, contextManager: ctxs, runner: backend, recipes }));
}, opts);

after(async () => { backend?.close?.(); engine?.close(); if (wh) await wh.stop(); });

// ───────────────────────── 3. PIPELINE (incremental) ─────────────────────────
test('3a. build_model: start → add_steps (funnel) → preview → commit = 12/8/5/3', opts, async (t) => {
  if (skip(t)) return;
  const s = await engine.build_model({ action: 'start', name: 'e2e_funnel', source: 'events', include: ['columns'] });
  assert.ok(s.context_id, 'start returns a context_id');
  assert.ok(s.available_columns.some((c) => c.name === 'player_id_of_internal'), 'source columns at start');
  S.draftId = s.context_id;

  // default add_steps returns a DIFF; the funnel columns show up as added.
  const a1 = await engine.build_model({ action: 'add_steps', context_id: S.draftId, steps: [matchActivation()] });
  assert.equal(stepEffect(a1).step_index, 1);
  const cols = stepEffect(a1).columns_added.map((c) => c.name);
  assert.ok(cols.includes('reached_launch') && cols.includes('completed'), 'funnel output columns reported as added');

  const pv = await engine.build_model({ action: 'preview', context_id: S.draftId });
  assert.ok(typeof pv.model_sql === 'string' && pv.model_sql.length > 0, 'preview renders SQL (existence only)');
  assert.equal(pv.steps.length, 1);

  const c = await engine.build_model({ action: 'materialize', context_id: S.draftId });
  assert.equal(c.build?.ok, true, JSON.stringify(c.error || c.build));
  assert.equal(reached(c.rows, 'launch'), 12);
  assert.equal(reached(c.rows, 'tut1'), 8);
  assert.equal(reached(c.rows, 'tut2'), 5);
  assert.equal(reached(c.rows, 'tut3'), 3);
  S.pipeCtx = c.context_id;
  S.pipeTable = c.model;
  S.pipeTask = c.task_id;
  assert.equal(c.tool, 'build_model', 'the rows are the build task\'s result');
  // Provenance: a pipeline result is tagged tier=pipeline with the source + real data freshness.
  assert.equal(c.provenance?.tier, 'pipeline');
  assert.equal(c.provenance?.source, 'events');
  assert.ok(typeof c.provenance?.data_freshness === 'string' && c.provenance.data_freshness.length > 0, 'data freshness = latest event time');
});

test('3b. the build task\'s stored table is re-read (paged) with query_model (same 12/8/5/3)', opts, async (t) => {
  if (skip(t)) return;
  const r = await one(engine.query_model({ task_ids: [S.pipeTask], limit: 1000 }));
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(reached(r.rows, 'launch'), 12);
  assert.equal(reached(r.rows, 'tut1'), 8);
  assert.equal(reached(r.rows, 'tut2'), 5);
  assert.equal(reached(r.rows, 'tut3'), 3);
  // read the stored table in stages, in place: count users whose furthest step is tut3 = 3
  const t3 = await readTable(engine, S.pipeCtx, S.pipeTable, { stages: [
    { stage: 'where', conditions: [{ fn: 'eq', args: [{ column: 'furthest_step_name' }, { value: 'tut3' }] }] },
    { stage: 'aggregate', measures: [{ name: 'n', expr: { fn: 'count' } }] },
  ] });
  assert.equal(t3.ok, true, JSON.stringify(t3.error));
  assert.equal(num(t3.rows[0].n), 3);
});

// ───────────────────────── 4. SEMANTIC MODEL ─────────────────────────
test('4a. build_semantic_model (IAP revenue) → query by country = US35/GB25/BR25, total 85', opts, async (t) => {
  if (skip(t)) return;
  const created = await declare(engine, {
    name: 'e2e_mon',
    semantic_models: [{ source: 'events', measures: [{ name: 'revenue', expr: { fn: 'sum', args: [{ property: 'price_in_usd_of_event_data' }] } }], where: [{ fn: 'eq', args: [{ column: 'event_name' }, { value: 'iap_purchase_completed' }] }] }, { source: 'users' }],
    metrics: [{ name: 'revenue', type: 'simple', measure: 'revenue' }],
  });
  assert.equal(created.parse.ok, true, JSON.stringify(created.parse));
  S.semCtx = created.context_id;

  const r = await engine.query_model({ context_id: S.semCtx, steps: [{ stage: 'metrics', metrics: ['revenue'], group_by: [{ source: 'users', column: 'country' }] }] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const by = Object.fromEntries(r.rows.map((x) => [String(x.users_country), num(x.revenue)]));
  assert.equal(by.US, 35);
  assert.equal(by.GB, 25);
  assert.equal(by.BR, 25);
  assert.equal(Object.values(by).reduce((s, n) => s + n, 0), 85); // grand total revenue
  // Provenance: a metric query is tagged tier=governed_metric with the metrics + data freshness.
  assert.equal(r.provenance?.tier, 'governed_metric');
  assert.deepEqual(r.provenance?.metrics, ['revenue']);
  assert.ok(typeof r.provenance?.data_freshness === 'string' && r.provenance.data_freshness.length > 0, 'data freshness present');
});

// Two edits of the semantic_model step, one after the other — a payers measure and metric, then three
// derived metrics, each an expression of { metric } leaves read as stored or as declared — and ONE
// ungrouped query reads the payers and the derived metrics side by side (one mf call); the by-day query
// is the distinct-by-time recommendation's.
test('4b. an edit of the semantic_model step adds a payers metric (re-query = 7 distinct payers), and derived metrics read the task\'s metrics by stored name, by declared name and by both in one expr alike: 85 / 7', opts, async (t) => {
  if (skip(t)) return;
  const upd = await editLayer(engine, S.semCtx, (st) => ({
    ...st,
    // the distinct players of the purchases: count_distinct over a case that yields the player on a
    // purchase and nothing on any other row
    measures: [...st.measures, { name: 'payers', expr: { fn: 'count_distinct', args: [{ fn: 'case', cases: [{ when: [{ fn: 'eq', args: [{ column: 'event_name' }, { value: 'iap_purchase_completed' }] }], then: { column: 'player_id_of_internal' } }] }] } }],
    metrics: [...st.metrics, { name: 'payers', type: 'simple', measure: 'payers' }],
  }));
  assert.equal(upd.parse.ok, true, JSON.stringify(upd.parse));
  assert.ok(upd.metrics.includes('payers'), '[payers] new metric registered');

  const derived = await editLayer(engine, S.semCtx, (st) => ({
    ...st,
    metrics: [...st.metrics,
      { name: 'per_payer_stored', type: 'derived', expr: { fn: 'div', args: [{ metric: 'revenue' }, { metric: 'payers' }] } },
      { name: 'per_payer_declared', type: 'derived', expr: { fn: 'div', args: [{ metric: 'revenue' }, { metric: 'payers' }] } },
      { name: 'per_payer_mixed', type: 'derived', expr: { fn: 'div', args: [{ metric: 'revenue' }, { metric: 'payers' }] } },
    ],
  }));
  assert.equal(derived.parse.ok, true, JSON.stringify(derived.parse));

  const names = ['per_payer_stored', 'per_payer_declared', 'per_payer_mixed'];
  const r = await engine.query_model({ context_id: S.semCtx, steps: [{ stage: 'metrics', metrics: ['payers', ...names] }] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(num(r.rows[0].payers), 7, '[payers] distinct payers = 7 (SEED_DATA §3)');
  const [payers] = (await wh.query(`select count(distinct player_id_of_internal) as n from fct_analytics_events where event_name = 'iap_purchase_completed'`)).rows;
  assert.equal(num(r.rows[0].payers), num(payers.n), '[count_distinct over a case] the warehouse\'s distinct payers');
  // Provenance #1: real data_freshness (latest event time) + an open-ended window flags
  // staleness (the tail past the latest data is empty/partial).
  assert.equal(r.provenance.tier, 'governed_metric');
  assert.ok(typeof r.provenance.data_freshness === 'string' && r.provenance.data_freshness.length > 0, 'data_freshness = latest event time');
  assert.ok(r.recommendations.some((x) => /current only through/i.test(x)), `open-ended window flags freshness: ${JSON.stringify(r.recommendations)}`);
  // [derived] the three spellings read the same two stored metrics: 85 / 7
  for (const n of names) close(num(r.rows[0][n]), 85 / 7);

  // Recommendation #4: count_distinct grouped by time is non-additive → prefer HLL sketches.
  const byDay = await engine.query_model({ context_id: S.semCtx, steps: [{ stage: 'metrics', metrics: ['payers'], group_by: [{ time: 'metric_time', grain: 'day' }] }] });
  assert.ok(byDay.recommendations.some((x) => /not additive/i.test(x) && /HLL/i.test(x)), `distinct-by-time should warn + suggest HLL: ${JSON.stringify(byDay.recommendations)}`);
});

test('4c. context({describe|list}) + semantic_index({status}) reflect the registered task', opts, async (t) => {
  if (skip(t)) return;
  const dc = await engine.context({ action: 'describe', context_id: S.semCtx });
  assert.equal(dc.engine, 'core');
  // the layer as dbt parsed it: each metric with its definition
  const metrics = dc.metrics.map((m) => m.name);
  assert.ok(metrics.includes('revenue') && metrics.includes('payers'), 'both metrics in context');
  assert.ok(dc.measures.includes('revenue') && dc.measures.includes('payers'), 'both measures in context');

  const status = await engine.semantic_index({ status: true });
  assert.ok(Array.isArray(status.tasks.recent), 'query jobs listed in the status view'); // non-materialized queries ⇒ none spawned

  const ctxs = await engine.context({ action: 'list' });
  assert.ok(ctxs.contexts.some((c) => c.context_id === S.semCtx), 'semantic context listed');
  assert.ok(ctxs.contexts.some((c) => c.context_id === S.pipeCtx), 'pipeline context listed');
});

// ───────────────────────── 5. A/B over the experiments role ─────────────────────────
test('5a. build_model fed the conversion recipe steps → per-variant aggregates (control 6/6, variant 1/6)', opts, async (t) => {
  if (skip(t)) return;
  // Exercise the AI-facing incremental builder by feeding the recipe's pipeline
  // steps one at a time, then commit. (_buildPipeline with the same payload
  // is the documented fallback; here we prove the add_steps path also works.)
  const r = recipes.list.find((x) => x.id === 'experiment_conversion');
  const steps = r.pipeline_payload.steps;
  const start = await engine.build_model({ action: 'start', name: 'e2e_ab_conv', source: r.pipeline_payload.source });
  for (const step of steps) {
    const a = await engine.build_model({ action: 'add_steps', context_id: start.context_id, steps: [step] });
    assert.ok(Number.isInteger(stepEffect(a).step_index), 'each add_steps advances the draft');
  }
  const commit = await engine.build_model({ action: 'materialize', context_id: start.context_id });
  assert.equal(commit.build?.ok, true, JSON.stringify(commit.error || commit.build));
  S.abCtx = commit.context_id;

  const map = r.experiment;
  const byGroup = {};
  for (const row of commit.rows) byGroup[String(row[map.group_field])] = row;
  assert.equal(num(byGroup.control.n), 6);
  assert.equal(num(byGroup.variant_b.n), 6);
  assert.equal(num(byGroup.control.conversions), 6);   // all six controls purchased
  assert.equal(num(byGroup.variant_b.conversions), 1); // only u10 in variant_b
  S.abByGroup = byGroup;
  S.abMap = map;
});

test('5b. experiment({analyze}) on the per-variant aggregates: significant drop (1.0 → 1/6)', opts, async (t) => {
  if (skip(t)) return;
  const { abMap: map, abByGroup: byGroup } = S;
  const arm = (row) => armFrom(map, row);
  const res = engine.experiment({ action: 'analyze', metric: map.metric, control: arm(byGroup.control), variants: [arm(byGroup.variant_b)] });
  assert.equal(res.ok, true);
  const v = res.results[0];
  close(v.control_rate, 1.0);
  close(v.variant_rate, 1 / 6);
  close(v.absolute_lift, 1 / 6 - 1);
  assert.equal(v.significant, true); // 100% vs 17% on n=6 is a clear drop
  assert.ok(Number.isFinite(v.p_value) && v.p_value >= 0 && v.p_value <= 1);
});

test('5c. experiment({check_split}) on the warehouse-computed split: clean 6 vs 6 passes', opts, async (t) => {
  if (skip(t)) return;
  const { abMap: map, abByGroup: byGroup } = S;
  const groups = Object.values(byGroup).map((row) => ({ label: String(row[map.group_field]), n: num(row[map.arm.n]) }));
  const res = engine.experiment({ action: 'check_split', groups });
  assert.equal(res.ok, true);
  close(res.chi_square, 0);          // 6 vs 6 against an even split
  assert.equal(res.srm_detected, false);
});

test('5d. experiment({plan}) matches the recipe tool_calls outputs (data-grounded)', opts, async (t) => {
  if (skip(t)) return;
  // Use the experiment_power recipe's declared tool_calls so the asserted numbers are
  // the recipe's own ground truth (test/unit/recipes-layers.test.js runs these too).
  const power = recipes.list.find((x) => x.id === 'experiment_power');
  for (const call of power.tool_calls) {
    const res = engine[call.tool](call.args);
    assert.equal(res.ok, true, JSON.stringify(res));
  }
  // proportion baseline=0.2, mde=0.02 → required n per group, doubled = total_n.
  const prop = engine.experiment({ action: 'plan', metric: 'proportion', baseline: 0.2, mde: 0.02 });
  assert.equal(prop.ok, true);
  assert.ok(Number.isInteger(prop.n_per_group) && prop.n_per_group > 0, 'n per group is a positive integer');
  assert.equal(prop.total_n, 2 * prop.n_per_group, 'total_n is two arms');
  close(prop.relative_mde, 0.02 / 0.2);
  // given n, the MDE round-trips to a value smaller than the original mde at this n.
  const fromN = engine.experiment({ action: 'plan', metric: 'proportion', baseline: 0.2, n: prop.n_per_group });
  assert.ok(fromN.mde > 0 && fromN.mde <= 0.02 + 1e-9, 'inverse direction yields a consistent MDE');
});

// ───────────────────────── 6. RECIPES ─────────────────────────
test('6. semantic_index overview lists recipes; { recipe: id } returns a payload + hack', opts, async (t) => {
  if (skip(t)) return;
  const overview = await engine.semantic_index();
  assert.ok(Array.isArray(overview.recipes) && overview.recipes.length > 0, 'recipes listed in the overview');
  const ids = overview.recipes.map((r) => r.id);
  for (const want of ['experiment_conversion', 'ratio_metric', 'funnel_from_event_property_steps', 'experiment_power']) {
    assert.ok(ids.includes(want), `recipe '${want}' present`);
  }
  const conv = await engine.semantic_index({ recipe: 'experiment_conversion' });
  assert.equal(conv.id, 'experiment_conversion');
  assert.ok(conv.pipeline_payload?.action === 'start' && conv.pipeline_payload.steps?.length, 'A/B recipe carries a pipeline_payload: a start request with its steps');
  assert.ok(typeof conv.hack === 'string' && conv.hack.length > 0, 'recipe carries a generalizable hack');
  const power = await engine.semantic_index({ recipe: 'experiment_power' });
  assert.ok(Array.isArray(power.tool_calls) && power.tool_calls.length > 0, 'tool-only recipe carries tool_calls');
});

// ───────────────────────── 7. TEARDOWN ─────────────────────────
test('7. context: delete models + drop contexts; list shows them gone', opts, async (t) => {
  if (skip(t)) return;
  // delete the semantic task's model additions (delete_context with what: 'semantic_model')
  const dsm = await engine.delete_context({ what: 'semantic_model', context_id: S.semCtx, semantic_model: 'events', cascade: true });
  assert.equal(dsm.removed, true);
  // delete the A/B pipeline model definition (context delete_model action)
  const dnm = await engine.delete_context({ what: 'pipeline_model', context_id: S.abCtx });
  assert.equal(dnm.removed, true);

  for (const id of [S.semCtx, S.pipeCtx, S.abCtx]) {
    const d = await engine.delete_context({ context_id: id });
    assert.equal(d.removed, true, `dropped ${id}`);
  }
  const remaining = (await engine.context({ action: 'list' })).contexts;
  for (const id of [S.semCtx, S.pipeCtx, S.abCtx]) {
    assert.ok(!remaining.some((c) => c.context_id === id), `context ${id} gone`);
  }
});
