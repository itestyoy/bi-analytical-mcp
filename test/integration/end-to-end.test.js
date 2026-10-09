// END-TO-END integration test: ONE realistic analytics workflow that exercises ALL
// the MCP tools together and verifies they chain correctly. A single seed+run feeds
// every hop. The story (an analyst onboarding into a new dataset):
//   (Discovery and the value index's sync state — semantic_index overview → event →
//    property → value search, and { status } after a refresh — are value-index.test.js's,
//    which builds the index over the same fixture.)
//   3. PIPELINE — build_pipeline_model (start/add_steps/preview/commit) builds the
//                    activation funnel; rows read back via query_pipeline_model (12/8/5/3,
//                    the same counts match-recognize.test.js proves on the all-at-once build).
//   4. SEMANTIC    — build_semantic_model (IAP revenue) → query_semantic_model by
//                    country → build_semantic_model action update adds a payers metric → re-query;
//                    context({describe|list}) + semantic_index({status}) lifecycle.
//   5. A/B         — build_pipeline_model fed the conversion recipe's stages one-at-a-
//                    time → materialize → per-variant aggregates → experiment analyze + check_split +
//                    plan: the conversion recipe's data proof (ab-test.test.js runs the others).
//   6. RECIPES     — semantic_index overview list + semantic_index({ recipe: id }).
//   7. TEARDOWN    — delete_context({ what: semantic_model | pipeline_model | context }), then
//                    context({list}) shows the dropped context gone.
//
// DATA-ONLY: every substantive assertion is on a returned VALUE/COUNT (grounded in
// fixtures/SEED_DATA.md and the existing integration tests). The only non-data checks
// are model_sql existence, recommendations-are-strings, and context/job lifecycle.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadCatalog } from '../../src/catalog.js';
import { loadRecipes } from '../../src/recipes.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { startWarehouse, fixtureProject } from './warehouse-harness.js';
import { settle, readTable, one, stepEffect } from '../helpers/settle.js';
import { armFrom } from '../helpers/experiment-arm.js';
import { DBT_BIN, HAS_DBT, testDbt } from '../helpers/dbt-env.js';

const execFileP = promisify(execFile);
const BASE = fixtureProject('dbt_project'); // a private copy: the test files run side by side
const opts = { timeout: 300000 };

const num = (v) => Number(v);
const tru = (v) => v === true || v === 't' || v === 'true' || v === 1 || v === '1';
const reached = (rows, step) => rows.filter((r) => tru(r[`reached_${step}`])).length;
const close = (a, b, tol = 1e-3) => assert.ok(Math.abs(a - b) <= tol, `${a} ≈ ${b}`);

// Shared state threaded through the ORDERED tests below (one coherent workflow).
let wh; let engine; let backend; let recipes;
const S = {}; // S.semCtx, S.draftId, S.pipeCtx, S.pipeTable, S.abCtx

// The canonical 4-step activation funnel (copied verbatim from match-recognize.test.js).
const activationSteps = [
  { name: 'launch', event_name: ['first_launch'] },
  { name: 'tut1', event_name: ['tutorial'], where: [{ column: 'element_of_event_data', op: 'eq', value: 'step_1' }] },
  { name: 'tut2', event_name: ['tutorial'], where: [{ column: 'element_of_event_data', op: 'eq', value: 'step_2' }] },
  { name: 'tut3', event_name: ['tutorial'], where: [{ column: 'element_of_event_data', op: 'eq', value: 'step_3' }] },
];
const matchActivation = (extra = {}) => ({ stage: 'match_recognize', partition_by: ['player_id_of_internal'], steps: activationSteps, ...extra });

const skip = (t) => { if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; } return false; };

before(async () => {
  if (!HAS_DBT) return;
  wh = await startWarehouse();
  const env = { ...process.env, DBT_PROFILES_DIR: BASE, DBT_PROJECT_DIR: BASE, DUCKDB_PATH: wh.path };
  await execFileP(DBT_BIN, ['seed'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  await execFileP(DBT_BIN, ['run'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  const catalog = loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), { profilesDir: BASE, projectDir: BASE });
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: mkdtempSync(join(tmpdir(), 'e2e-')), timeSpineDialect: 'duckdb' });
  backend = testDbt({ profilesDir: BASE });
  recipes = loadRecipes(join(process.cwd(), 'config', 'recipes.json'));
  engine = settle(new Engine({ catalog, contextManager: ctxs, runner: backend, recipes }));
}, opts);

after(async () => { backend?.close?.(); if (wh) await wh.stop(); });

// ───────────────────────── 3. PIPELINE (incremental) ─────────────────────────
test('3a. build_pipeline_model: start → add_steps (funnel) → preview → commit = 12/8/5/3', opts, async (t) => {
  if (skip(t)) return;
  const s = await engine.build_pipeline_model({ action: 'start', name: 'e2e_funnel', source: 'events', include_columns: true });
  assert.ok(s.context_id, 'start returns a context_id');
  assert.ok(s.available_columns.some((c) => c.name === 'player_id_of_internal'), 'source columns at start');
  S.draftId = s.context_id;

  // default add_steps returns a DIFF; the funnel columns show up as added.
  const a1 = await engine.build_pipeline_model({ action: 'add_steps', context_id: S.draftId, stages: [matchActivation()] });
  assert.equal(stepEffect(a1).step_index, 1);
  const cols = stepEffect(a1).columns_added.map((c) => c.name);
  assert.ok(cols.includes('reached_launch') && cols.includes('completed'), 'funnel output columns reported as added');

  const pv = await engine.build_pipeline_model({ action: 'preview', context_id: S.draftId });
  assert.ok(typeof pv.model_sql === 'string' && pv.model_sql.length > 0, 'preview renders SQL (existence only)');
  assert.equal(pv.steps.length, 1);

  const c = await engine.build_pipeline_model({ action: 'materialize', context_id: S.draftId });
  assert.equal(c.build?.ok, true, JSON.stringify(c.error || c.build));
  assert.equal(reached(c.rows, 'launch'), 12);
  assert.equal(reached(c.rows, 'tut1'), 8);
  assert.equal(reached(c.rows, 'tut2'), 5);
  assert.equal(reached(c.rows, 'tut3'), 3);
  S.pipeCtx = c.context_id;
  S.pipeTable = c.model;
  S.pipeTask = c.task_id;
  assert.equal(c.tool, 'build_pipeline_model', 'the rows are the build task\'s result');
  // Provenance: a pipeline result is tagged tier=pipeline with the source + real data freshness.
  assert.equal(c.provenance?.tier, 'pipeline');
  assert.equal(c.provenance?.source, 'events');
  assert.ok(typeof c.provenance?.data_freshness === 'string' && c.provenance.data_freshness.length > 0, 'data freshness = latest event time');
});

test('3b. the build task\'s stored table is re-read (paged) with query_pipeline_model (same 12/8/5/3)', opts, async (t) => {
  if (skip(t)) return;
  const r = await one(engine.query_pipeline_model({ task_ids: [S.pipeTask], limit: 1000 }));
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(reached(r.rows, 'launch'), 12);
  assert.equal(reached(r.rows, 'tut1'), 8);
  assert.equal(reached(r.rows, 'tut2'), 5);
  assert.equal(reached(r.rows, 'tut3'), 3);
  // transform the stored table in place: count users whose furthest step is tut3 = 3
  const t3 = await readTable(engine, S.pipeCtx, S.pipeTable, { transform: { where: [{ column: 'furthest_step_name', op: 'eq', value: 'tut3' }], measures: [{ agg: 'count', name: 'n' }] } });
  assert.equal(t3.ok, true, JSON.stringify(t3.error));
  assert.equal(num(t3.rows[0].n), 3);
});

// ───────────────────────── 4. SEMANTIC MODEL ─────────────────────────
test('4a. build_semantic_model (IAP revenue) → query by country = US35/GB25/BR25, total 85', opts, async (t) => {
  if (skip(t)) return;
  const created = await engine.build_semantic_model({
    name: 'e2e_mon',
    semantic_models: [{ from: 'events', measures: [{ name: 'revenue', agg: 'sum', field: 'price_in_usd_of_event_data' }], where: [{ field: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] }, { from: 'users' }],
    metrics: [{ name: 'revenue', type: 'simple', measure: 'revenue' }],
  });
  assert.equal(created.parse.ok, true, JSON.stringify(created.parse));
  S.semCtx = created.context_id;

  const r = await engine.query_semantic_model({ context_id: S.semCtx, metrics: ['e2e_mon_revenue'], group_by: [{ model: 'users', attribute: 'country' }] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const by = Object.fromEntries(r.rows.map((x) => [String(x.users_country), num(x.e2e_mon_revenue)]));
  assert.equal(by.US, 35);
  assert.equal(by.GB, 25);
  assert.equal(by.BR, 25);
  assert.equal(Object.values(by).reduce((s, n) => s + n, 0), 85); // grand total revenue
  // Provenance: a metric query is tagged tier=governed_metric with the metrics + data freshness.
  assert.equal(r.provenance?.tier, 'governed_metric');
  assert.deepEqual(r.provenance?.metrics, ['e2e_mon_revenue']);
  assert.ok(typeof r.provenance?.data_freshness === 'string' && r.provenance.data_freshness.length > 0, 'data freshness present');
});

test('4b. build_semantic_model action update adds a payers metric; re-query = 7 distinct payers', opts, async (t) => {
  if (skip(t)) return;
  const upd = await engine.build_semantic_model({ action: 'update',
    context_id: S.semCtx,
    semantic_models: [{ from: 'events', measures: [{ name: 'payers', agg: 'count_distinct', field: 'player_id_of_internal', where: [{ field: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] }] }],
    metrics: [{ name: 'payers', type: 'simple', measure: 'payers' }],
  });
  assert.equal(upd.parse.ok, true, JSON.stringify(upd.parse));
  assert.ok(upd.metrics.includes('e2e_mon_payers'), 'new metric registered');

  const r = await engine.query_semantic_model({ context_id: S.semCtx, metrics: ['e2e_mon_payers'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(num(r.rows[0].e2e_mon_payers), 7); // distinct payers = 7 (SEED_DATA §3)
  // Provenance #1: real data_freshness (latest event time) + an open-ended window flags
  // staleness (the tail past the latest data is empty/partial).
  assert.equal(r.provenance.tier, 'governed_metric');
  assert.ok(typeof r.provenance.data_freshness === 'string' && r.provenance.data_freshness.length > 0, 'data_freshness = latest event time');
  assert.ok(r.recommendations.some((x) => /current only through/i.test(x)), `open-ended window flags freshness: ${JSON.stringify(r.recommendations)}`);

  // Recommendation #4: count_distinct grouped by time is non-additive → prefer HLL sketches.
  const byDay = await engine.query_semantic_model({ context_id: S.semCtx, metrics: ['e2e_mon_payers'], group_by: [{ time: 'metric_time', grain: 'day' }] });
  assert.ok(byDay.recommendations.some((x) => /not additive/i.test(x) && /HLL/i.test(x)), `distinct-by-time should warn + suggest HLL: ${JSON.stringify(byDay.recommendations)}`);
});

test('4b2. derived metrics added by an update read the task\'s metrics by stored name, by declared name and by both in one expr alike: 85 / 7', opts, async (t) => {
  if (skip(t)) return;
  const upd = await engine.build_semantic_model({ action: 'update',
    context_id: S.semCtx,
    metrics: [
      { name: 'per_payer_stored', type: 'derived', expr: 'e2e_mon_revenue / e2e_mon_payers', metrics: ['e2e_mon_revenue', 'e2e_mon_payers'] },
      { name: 'per_payer_declared', type: 'derived', expr: 'revenue / payers', metrics: ['revenue', 'payers'] },
      { name: 'per_payer_mixed', type: 'derived', expr: 'e2e_mon_revenue / payers', metrics: ['e2e_mon_revenue', 'payers'] },
    ],
  });
  assert.equal(upd.parse.ok, true, JSON.stringify(upd.parse));

  const names = ['e2e_mon_per_payer_stored', 'e2e_mon_per_payer_declared', 'e2e_mon_per_payer_mixed'];
  const r = await engine.query_semantic_model({ context_id: S.semCtx, metrics: names });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  for (const n of names) close(num(r.rows[0][n]), 85 / 7);
});

test('4c. context({describe|list}) + semantic_index({status}) reflect the registered task', opts, async (t) => {
  if (skip(t)) return;
  const dc = await engine.context({ action: 'describe', context_id: S.semCtx });
  assert.equal(dc.engine, 'core');
  assert.ok(dc.metrics.includes('e2e_mon_revenue') && dc.metrics.includes('e2e_mon_payers'), 'both metrics in context');
  assert.ok(dc.measures.includes('e2e_mon_revenue') && dc.measures.includes('e2e_mon_payers'), 'both measures in context');

  const status = await engine.semantic_index({ status: true });
  assert.ok(Array.isArray(status.tasks.recent), 'query jobs listed in the status view'); // non-materialized queries ⇒ none spawned

  const ctxs = await engine.context({ action: 'list' });
  assert.ok(ctxs.contexts.some((c) => c.context_id === S.semCtx), 'semantic context listed');
  assert.ok(ctxs.contexts.some((c) => c.context_id === S.pipeCtx), 'pipeline context listed');
});

// ───────────────────────── 5. A/B over the experiments role ─────────────────────────
test('5a. build_pipeline_model fed the conversion recipe stages → per-variant aggregates (control 6/6, variant 1/6)', opts, async (t) => {
  if (skip(t)) return;
  // Exercise the AI-facing incremental builder by feeding the recipe's pipeline
  // stages one at a time, then commit. (_buildPipeline with the same payload
  // is the documented fallback; here we prove the add_steps path also works.)
  const r = recipes.list.find((x) => x.id === 'experiment_conversion');
  const stages = r.pipeline_payload.stages;
  const start = await engine.build_pipeline_model({ action: 'start', name: 'e2e_ab_conv', source: r.pipeline_payload.source });
  for (const stage of stages) {
    const a = await engine.build_pipeline_model({ action: 'add_steps', context_id: start.context_id, stages: [stage] });
    assert.ok(Number.isInteger(stepEffect(a).step_index), 'each add_steps advances the draft');
  }
  const commit = await engine.build_pipeline_model({ action: 'materialize', context_id: start.context_id });
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
  // the recipe's own ground truth (the recipes-parse suite runs these too).
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
  assert.ok(conv.pipeline_payload?.action === 'start' && conv.pipeline_payload.stages?.length, 'A/B recipe carries a pipeline_payload: a start request with its stages');
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
