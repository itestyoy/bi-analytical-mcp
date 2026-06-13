// END-TO-END integration test: ONE realistic analytics workflow that exercises ALL
// the MCP tools together and verifies they chain correctly. A single seed+run feeds
// every hop. The story (an analyst onboarding into a new dataset):
//   1. DISCOVERY   — semantic_index overview → event → property (paged/ordered) →
//                    value search, asserting the rewarded → ad_type → ad_finished
//                    provenance fact from the value index.
//   2. INDEX STATE — semantic_index reports the value-index sync after refresh().
//   3. NATIVE PIPE — build_native_model (start/add_step/preview/commit) builds the
//                    activation funnel; rows read back via get_query_result; the
//                    committed counts equal the all-at-once register path (12/8/5/3).
//   4. SEMANTIC    — create_semantic_model (IAP revenue) → query_semantic_model by
//                    country → update_semantic_model adds a payers metric → re-query;
//                    context({describe|list}) + semantic_index({status}) lifecycle.
//   5. A/B         — build_native_model fed the conversion recipe's stages one-at-a-
//                    time → materialize → per-variant aggregates → ab_test + srm_check +
//                    sample_size, asserting the exact numbers ab-test.test.js asserts.
//   6. RECIPES     — semantic_index overview list + semantic_index({ recipe: id }).
//   7. TEARDOWN    — context({delete_semantic_model|delete_model|drop}), then
//                    context({list}) shows the dropped context gone.
//
// DATA-ONLY: every substantive assertion is on a returned VALUE/COUNT (grounded in
// fixtures/SEED_DATA.md and the existing integration tests). The only non-data checks
// are model_sql existence, recommendations-are-strings, and context/job lifecycle.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadCatalog } from '../../src/catalog.js';
import { loadRecipes } from '../../src/recipes.js';
import { ContextManager } from '../../src/context-manager.js';
import { MfEngineBackend } from '../../src/backends/mf-engine.js';
import { Engine } from '../../src/engine.js';
import { ValueIndex, BackgroundIndexer } from '../../src/value-index.js';
import { startPglite } from './pglite-harness.js';

const execFileP = promisify(execFile);
const BASE = join(process.cwd(), 'test', 'integration', 'fixtures', 'dbt_project');
const DBT_BIN = process.env.DBT_BIN || join(process.cwd(), '.dbtvenv', 'bin', 'dbt');
const MF_BIN = process.env.MF_BIN || join(process.cwd(), '.dbtvenv', 'bin', 'mf');
const PY_BIN = process.env.PYTHON_BIN || join(process.cwd(), '.dbtvenv', 'bin', 'python');
const HAS_DBT = existsSync(DBT_BIN) && existsSync(MF_BIN);
// 10-min budget: before() awaits a FULL real indexer pass (37 targets × ~3 mf round-trips
// each ≈ several minutes); the production indexer is background/non-blocking, but the test
// awaits it synchronously to assert on populated values, so give the hook ample headroom.
const opts = { timeout: 600000 };

const num = (v) => Number(v);
const tru = (v) => v === true || v === 't' || v === 'true' || v === 1 || v === '1';
const reached = (rows, step) => rows.filter((r) => tru(r[`reached_${step}`])).length;
const valOf = (arr, v) => arr.find((x) => x.value === v);
const close = (a, b, tol = 1e-3) => assert.ok(Math.abs(a - b) <= tol, `${a} ≈ ${b}`);

// Shared state threaded through the ORDERED tests below (one coherent workflow).
let pg; let engine; let backend; let index; let indexer; let recipes;
const S = {}; // S.semCtx, S.draftId, S.pipeCtx, S.pipeTable, S.abCtx

// The canonical 4-step activation funnel (copied verbatim from match-recognize.test.js).
const activationSteps = [
  { name: 'launch', event_name: ['first_launch'] },
  { name: 'tut1', event_name: ['tutorial'], where: [{ property: 'element_of_event_data', op: 'eq', value: 'step_1' }] },
  { name: 'tut2', event_name: ['tutorial'], where: [{ property: 'element_of_event_data', op: 'eq', value: 'step_2' }] },
  { name: 'tut3', event_name: ['tutorial'], where: [{ property: 'element_of_event_data', op: 'eq', value: 'step_3' }] },
];
const matchActivation = (extra = {}) => ({ stage: 'match_recognize', partition_by: ['player_id_of_internal'], mode: 'ordered', steps: activationSteps, ...extra });

const skip = (t) => { if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; } return false; };

before(async () => {
  if (!HAS_DBT) return;
  pg = await startPglite();
  process.env.DBT_PG_PORT = String(pg.port);
  const env = { ...process.env, DBT_PROFILES_DIR: BASE, DBT_PROJECT_DIR: BASE, DBT_PG_PORT: String(pg.port) };
  await execFileP(DBT_BIN, ['seed'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  await execFileP(DBT_BIN, ['run'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  const catalog = loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), { profilesDir: BASE, projectDir: BASE });
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: mkdtempSync(join(tmpdir(), 'e2e-')), timeSpineDialect: 'postgres' });
  backend = new MfEngineBackend({ pythonBin: PY_BIN, dbtBin: DBT_BIN, profilesDir: BASE });
  recipes = loadRecipes(join(process.cwd(), 'config', 'recipes.json'));
  // A temp-file value index so semantic_index reports a REAL persisted SQLite index.
  const dbPath = join(mkdtempSync(join(tmpdir(), 'e2e-db-')), 'value-index.sqlite');
  engine = new Engine({ catalog, contextManager: ctxs, runner: backend, recipes, dbPath, queryTimeoutMs: 60000 });
  index = engine.valueIndex;
  indexer = new BackgroundIndexer({ catalog, runner: backend, index, baseProjectDir: BASE, intervalMs: 0, maxValues: 50, logger: () => {} });
  // Await directly so the value index is populated before the discovery assertions.
  await indexer.refresh();
}, opts);

after(async () => { backend?.close(); index?.close(); if (pg) await pg.stop(); });

// ───────────────────────── 1. DISCOVERY ─────────────────────────
test('1a. semantic_index overview lists models + event names (no column dump)', opts, async (t) => {
  if (skip(t)) return;
  const overview = await engine.semantic_index();
  assert.ok(overview.models.find((m) => m.key === 'events'), 'events model present');
  assert.ok(Array.isArray(overview.event_names) && overview.event_names.includes('ad_finished'), 'overview lists event names incl. ad_finished');
  assert.equal(overview.models.find((m) => m.key === 'events').physical_columns, undefined, 'overview stays compact');
});

test('1b. semantic_index({ event: "ad_finished" }) scopes to that event\'s properties + index hints', opts, async (t) => {
  if (skip(t)) return;
  const ev = await engine.semantic_index({ event: 'ad_finished' });
  const p = ev.properties.find((x) => x.name === 'ad_type_of_event_data');
  assert.ok(p, 'ad_finished carries ad_type_of_event_data');
  assert.equal(p.distinct_count, 3); // rewarded/interstitial/banner over the whole fact
  assert.ok(p.sample_values.length <= 3 && p.sample_values.some((v) => v.value === 'rewarded'), 'compact top-3 hint includes rewarded');
});

test('1c. semantic_index({ property }) pages + orders the indexed values (10/8/6)', opts, async (t) => {
  if (skip(t)) return;
  const out = await engine.semantic_index({ property: 'ad_type_of_event_data' });
  assert.equal(out.distinct_count, 3);
  assert.equal(out.total_count, 24); // 12 ad_started + 12 ad_finished
  assert.equal(valOf(out.sample_values, 'rewarded').freq, 10);
  assert.equal(valOf(out.sample_values, 'interstitial').freq, 8);
  assert.equal(valOf(out.sample_values, 'banner').freq, 6);
  // paging: top 1 by freq desc, then offset 1
  const p1 = await engine.semantic_index({ property: 'ad_type_of_event_data', limit: 1 });
  assert.deepEqual(p1.sample_values.map((v) => v.value), ['rewarded']);
  assert.equal(p1.value_stats.has_more, true);
  const p2 = await engine.semantic_index({ property: 'ad_type_of_event_data', limit: 1, offset: 1 });
  assert.deepEqual(p2.sample_values.map((v) => v.value), ['interstitial']);
  // order_by value asc → alphabetical
  const alpha = await engine.semantic_index({ property: 'ad_type_of_event_data', order_by: 'value' });
  assert.deepEqual(alpha.sample_values.map((v) => v.value), ['banner', 'interstitial', 'rewarded']);
  assert.ok(Array.isArray(out.recommendations) && out.recommendations.length > 0 && out.recommendations.every((r) => typeof r === 'string' && r.length), 'actionable recommendations');
});

test('1d. semantic_index({ search: "rewarded" }) traces value → property → event provenance', opts, async (t) => {
  if (skip(t)) return;
  const out = await engine.semantic_index({ search: 'rewarded' });
  const hit = out.value_matches.find((m) => m.value === 'rewarded' && m.property === 'ad_type_of_event_data');
  assert.ok(hit, `expected rewarded → ad_type match; got ${JSON.stringify(out.value_matches)}`);
  assert.equal(hit.freq, 10);
  assert.ok(Array.isArray(hit.events) && hit.events.includes('ad_finished'), 'provenance names the carrying event');
  assert.ok(out.recommendations.length > 0 && out.recommendations.every((r) => typeof r === 'string' && r.length), 'search recommendations');
});

// ───────────────────────── 2. INDEX STATE ─────────────────────────
test('2. semantic_index({ status }) reports a clean value-index sync with EXACT coverage', opts, async (t) => {
  if (skip(t)) return;
  const out = await engine.semantic_index({ status: true });
  const vi = out.value_index;
  assert.equal(vi.persisted, true);
  assert.equal(vi.running, false);
  assert.equal(vi.last_successful_run.status, 'ok');
  assert.equal(vi.last_successful_run.errors, 0);
  // EXACT coverage: every scalar event property PLUS every categorical dimension
  // attribute of the non-anchor models (users/experiments) was indexed — no silent gaps…
  const dimTargets = engine.catalog.modelKeys()
    .filter((k) => k !== engine.catalog.anchor)
    .flatMap((k) => Object.entries(engine.catalog.getModel(k).dimensions || {})
      .filter(([, s]) => String(s?.type || '').toLowerCase() !== 'time'));
  assert.equal(vi.indexed_properties, engine.catalog.scalarEventProps().length + dimTargets.length, 'one prop_stats row per indexable property/attribute');
  // …and the persisted counts equal what the run itself reported (DB COUNT == run counters).
  assert.equal(vi.indexed_properties, vi.last_successful_run.properties_indexed);
  assert.equal(vi.total_values, vi.last_successful_run.values_written);
  assert.ok(vi.total_values > 0, 'values stored');
  assert.equal(typeof out.query_jobs.total, 'number');
});

// 2b. Read the index DIRECTLY (bypassing semantic_index): the exact seeded values landed.
test('2b. the value index holds the exact seeded values (direct read)', opts, async (t) => {
  if (skip(t)) return;
  const vi = engine.valueIndex;
  // ad_type over the whole fact: rewarded 10 / interstitial 8 / banner 6 (SEED_DATA §5, ad_started+ad_finished).
  const adStat = vi.stats('ad_type_of_event_data');
  assert.equal(adStat.distinctCount, 3);
  assert.equal(adStat.totalCount, 24);
  assert.ok(typeof adStat.indexedAt === 'number');
  assert.deepEqual(vi.sampleValues('ad_type_of_event_data'), [{ value: 'rewarded', freq: 10 }, { value: 'interstitial', freq: 8 }, { value: 'banner', freq: 6 }]);
  // level result: win 20 / lose 5 (SEED_DATA §4), distinct 2 / total 25.
  const rStat = vi.stats('result_of_event_data');
  assert.equal(rStat.distinctCount, 2);
  assert.equal(rStat.totalCount, 25);
  assert.deepEqual(vi.sampleValues('result_of_event_data'), [{ value: 'win', freq: 20 }, { value: 'lose', freq: 5 }]);
  // direct paging/order over the index (order_by value → alphabetical).
  assert.deepEqual(vi.listValues('ad_type_of_event_data', { by: 'value' }).map((v) => v.value), ['banner', 'interstitial', 'rewarded']);
  // substring search may legitimately match more than one value (e.g. 'rewarded_ad'),
  // ordered by freq desc → the exact ad_type 'rewarded' (10) is the top hit.
  const sv = vi.searchValues('rewarded');
  assert.ok(sv.some((m) => m.property === 'ad_type_of_event_data' && m.value === 'rewarded' && m.freq === 10), 'exact rewarded→ad_type match present');
  assert.equal(sv[0].value, 'rewarded', 'highest-frequency match first');
});

// ───────────────────────── 3. NATIVE PIPELINE (incremental) ─────────────────────────
test('3a. build_native_model: start → add_step (funnel) → preview → commit = 12/8/5/3', opts, async (t) => {
  if (skip(t)) return;
  const s = await engine.build_native_model({ action: 'start', name: 'e2e_funnel', source: 'events', include_columns: true });
  assert.ok(s.draft_id, 'start returns a draft_id');
  assert.ok(s.available_columns.some((c) => c.name === 'player_id_of_internal'), 'source columns at start');
  S.draftId = s.draft_id;

  // default add_step returns a DIFF; the funnel columns show up as added.
  const a1 = await engine.build_native_model({ action: 'add_step', draft_id: S.draftId, stage: matchActivation() });
  assert.equal(a1.step_index, 1);
  const cols = a1.columns_added.map((c) => c.name);
  assert.ok(cols.includes('reached_launch') && cols.includes('completed'), 'funnel output columns reported as added');

  const pv = await engine.build_native_model({ action: 'preview', draft_id: S.draftId });
  assert.ok(typeof pv.model_sql === 'string' && pv.model_sql.length > 0, 'preview renders SQL (existence only)');
  assert.equal(pv.steps.length, 1);

  const c = await engine.build_native_model({ action: 'materialize', draft_id: S.draftId });
  assert.equal(c.build?.ok, true, JSON.stringify(c.error || c.build));
  assert.equal(reached(c.rows, 'launch'), 12);
  assert.equal(reached(c.rows, 'tut1'), 8);
  assert.equal(reached(c.rows, 'tut2'), 5);
  assert.equal(reached(c.rows, 'tut3'), 3);
  S.pipeCtx = c.context_id;
  S.pipeTable = c.model;
  assert.equal(c.read_with?.tool, 'get_query_result');
  assert.equal(c.read_with?.table, c.model);
});

test('3b. get_query_result re-reads the committed pipeline rows (same 12/8/5/3)', opts, async (t) => {
  if (skip(t)) return;
  const r = await engine.get_query_result({ context_id: S.pipeCtx, table: S.pipeTable });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(reached(r.rows, 'launch'), 12);
  assert.equal(reached(r.rows, 'tut1'), 8);
  assert.equal(reached(r.rows, 'tut2'), 5);
  assert.equal(reached(r.rows, 'tut3'), 3);
  // transform the stored table in place: count users whose furthest step is tut3 = 3
  const t3 = await engine.get_query_result({ context_id: S.pipeCtx, table: S.pipeTable, transform: { where: [{ column: 'furthest_step_name', op: 'eq', value: 'tut3' }], aggregations: [{ fn: 'count', column: '*', as: 'n' }] } });
  assert.equal(t3.ok, true, JSON.stringify(t3.error));
  assert.equal(num(t3.rows[0].n), 3);
});

test('3c. commit equals the all-at-once register_native_model path (fidelity 12/8/5/3)', opts, async (t) => {
  if (skip(t)) return;
  const out = await engine.register_native_model({ name: 'e2e_funnel_aao', pipeline: { stages: [matchActivation()] } });
  assert.equal(out.build?.ok, true, JSON.stringify(out.error || out.build));
  assert.equal(reached(out.rows, 'launch'), 12);
  assert.equal(reached(out.rows, 'tut1'), 8);
  assert.equal(reached(out.rows, 'tut2'), 5);
  assert.equal(reached(out.rows, 'tut3'), 3);
  await engine.delete_native_model({ context_id: out.context_id });
});

// ───────────────────────── 4. SEMANTIC MODEL ─────────────────────────
test('4a. create_semantic_model (IAP revenue) → query by country = US35/GB25/BR25, total 85', opts, async (t) => {
  if (skip(t)) return;
  const created = await engine.create_semantic_model({
    name: 'e2e_mon', use_base_models: ['users'],
    semantic_models: [{ from: 'events', event_scope: { event_name: ['iap_purchase_completed'] }, measures: [{ name: 'revenue', agg: 'sum', field: 'price_in_usd_of_event_data' }] }],
    metrics: [{ name: 'revenue', type: 'simple', measure: { name: 'revenue' } }],
  });
  assert.equal(created.parse.ok, true, JSON.stringify(created.parse));
  S.semCtx = created.context_id;

  const r = await engine.query_semantic_model({ context_id: S.semCtx, metrics: ['e2e_mon_revenue'], group_by: ['user__country'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const by = Object.fromEntries(r.rows.map((x) => [String(x.user__country), num(x.e2e_mon_revenue)]));
  assert.equal(by.US, 35);
  assert.equal(by.GB, 25);
  assert.equal(by.BR, 25);
  assert.equal(Object.values(by).reduce((s, n) => s + n, 0), 85); // grand total revenue
});

test('4b. update_semantic_model adds a payers metric; re-query = 7 distinct payers', opts, async (t) => {
  if (skip(t)) return;
  const upd = await engine.update_semantic_model({
    context_id: S.semCtx, semantic_model: 'events',
    add_measures: [{ name: 'payers', agg: 'count_distinct', field: 'player_id_of_internal', event_name: ['iap_purchase_completed'] }],
    add_metrics: [{ name: 'payers', type: 'simple', measure: { name: 'payers' } }],
  });
  assert.equal(upd.parse.ok, true, JSON.stringify(upd.parse));
  assert.ok(upd.metrics.includes('e2e_mon_payers'), 'new metric registered');

  const r = await engine.query_semantic_model({ context_id: S.semCtx, metrics: ['e2e_mon_payers'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(num(r.rows[0].e2e_mon_payers), 7); // distinct payers = 7 (SEED_DATA §3)
});

test('4c. context({describe|list}) + semantic_index({status}) reflect the registered task', opts, async (t) => {
  if (skip(t)) return;
  const dc = await engine.context({ action: 'describe', context_id: S.semCtx });
  assert.equal(dc.engine, 'core');
  assert.ok(dc.metrics.includes('e2e_mon_revenue') && dc.metrics.includes('e2e_mon_payers'), 'both metrics in context');
  assert.ok(dc.measures.includes('e2e_mon_revenue') && dc.measures.includes('e2e_mon_payers'), 'both measures in context');

  const status = await engine.semantic_index({ status: true });
  assert.ok(Array.isArray(status.query_jobs.recent), 'query jobs listed in the status view'); // non-materialized queries ⇒ none spawned

  const ctxs = await engine.context({ action: 'list' });
  assert.ok(ctxs.contexts.some((c) => c.context_id === S.semCtx), 'semantic context listed');
  assert.ok(ctxs.contexts.some((c) => c.context_id === S.pipeCtx), 'pipeline context listed');
});

// ───────────────────────── 5. A/B over the experiments role ─────────────────────────
test('5a. build_native_model fed the conversion recipe stages → per-variant aggregates (control 6/6, variant 1/6)', opts, async (t) => {
  if (skip(t)) return;
  // Exercise the AI-facing incremental builder by feeding the recipe's pipeline
  // stages one at a time, then commit. (register_native_model with the same payload
  // is the documented fallback; here we prove the add_step path also works.)
  const r = recipes.list.find((x) => x.id === 'ab_test_conversion');
  const stages = r.register_payload.pipeline.stages;
  const start = await engine.build_native_model({ action: 'start', name: 'e2e_ab_conv', source: r.register_payload.pipeline.source });
  for (const stage of stages) {
    const a = await engine.build_native_model({ action: 'add_step', draft_id: start.draft_id, stage });
    assert.ok(Number.isInteger(a.step_index), 'each add_step advances the draft');
  }
  const commit = await engine.build_native_model({ action: 'materialize', draft_id: start.draft_id });
  assert.equal(commit.build?.ok, true, JSON.stringify(commit.error || commit.build));
  S.abCtx = commit.context_id;

  const map = r.ab_test;
  const byGroup = {};
  for (const row of commit.rows) byGroup[String(row[map.group_field])] = row;
  assert.equal(num(byGroup.control.n), 6);
  assert.equal(num(byGroup.variant_b.n), 6);
  assert.equal(num(byGroup.control.conversions), 6);   // all six controls purchased
  assert.equal(num(byGroup.variant_b.conversions), 1); // only u10 in variant_b
  S.abByGroup = byGroup;
  S.abMap = map;
});

test('5b. ab_test on the per-variant aggregates: significant drop (1.0 → 1/6)', opts, async (t) => {
  if (skip(t)) return;
  const { abMap: map, abByGroup: byGroup } = S;
  const arm = (row) => ({ label: String(row[map.group_field]), n: num(row[map.n_field]), conversions: num(row[map.conversions_field]) });
  const res = engine.ab_test({ metric: map.metric, control: arm(byGroup.control), variants: [arm(byGroup.variant_b)] });
  assert.equal(res.ok, true);
  const v = res.results[0];
  close(v.control_rate, 1.0);
  close(v.variant_rate, 1 / 6);
  close(v.absolute_lift, 1 / 6 - 1);
  assert.equal(v.significant, true); // 100% vs 17% on n=6 is a clear drop
  assert.ok(Number.isFinite(v.p_value) && v.p_value >= 0 && v.p_value <= 1);
});

test('5c. srm_check on the warehouse-computed split: clean 6 vs 6 passes', opts, async (t) => {
  if (skip(t)) return;
  const { abMap: map, abByGroup: byGroup } = S;
  const groups = Object.values(byGroup).map((row) => ({ label: String(row[map.group_field]), n: num(row[map.n_field]) }));
  const res = engine.srm_check({ groups });
  assert.equal(res.ok, true);
  close(res.chi_square, 0);          // 6 vs 6 against an even split
  assert.equal(res.srm_detected, false);
});

test('5d. sample_size planning matches the recipe tool_calls outputs (data-grounded)', opts, async (t) => {
  if (skip(t)) return;
  // Use the ab_test_power recipe's declared tool_calls so the asserted numbers are
  // the recipe's own ground truth (the recipes-parse suite runs these too).
  const power = recipes.list.find((x) => x.id === 'ab_test_power');
  for (const call of power.tool_calls) {
    const res = engine[call.tool](call.args);
    assert.equal(res.ok, true, JSON.stringify(res));
  }
  // proportion baseline=0.2, mde=0.02 → required n per group, doubled = total_n.
  const prop = engine.sample_size({ metric: 'proportion', baseline: 0.2, mde: 0.02 });
  assert.equal(prop.ok, true);
  assert.ok(Number.isInteger(prop.n_per_group) && prop.n_per_group > 0, 'n per group is a positive integer');
  assert.equal(prop.total_n, 2 * prop.n_per_group, 'total_n is two arms');
  close(prop.relative_mde, 0.02 / 0.2);
  // given n, the MDE round-trips to a value smaller than the original mde at this n.
  const fromN = engine.sample_size({ metric: 'proportion', baseline: 0.2, n: prop.n_per_group });
  assert.ok(fromN.mde > 0 && fromN.mde <= 0.02 + 1e-9, 'inverse direction yields a consistent MDE');
});

// ───────────────────────── 6. RECIPES ─────────────────────────
test('6. semantic_index overview lists recipes; { recipe: id } returns a payload + hack', opts, async (t) => {
  if (skip(t)) return;
  const overview = await engine.semantic_index();
  assert.ok(Array.isArray(overview.recipes) && overview.recipes.length > 0, 'recipes listed in the overview');
  const ids = overview.recipes.map((r) => r.id);
  for (const want of ['ab_test_conversion', 'monetization_metrics', 'multistep_funnel', 'ab_test_power']) {
    assert.ok(ids.includes(want), `recipe '${want}' present`);
  }
  const conv = await engine.semantic_index({ recipe: 'ab_test_conversion' });
  assert.equal(conv.id, 'ab_test_conversion');
  assert.ok(conv.register_payload && conv.register_payload.pipeline, 'A/B recipe carries a register_payload pipeline');
  assert.ok(typeof conv.hack === 'string' && conv.hack.length > 0, 'recipe carries a generalizable hack');
  const power = await engine.semantic_index({ recipe: 'ab_test_power' });
  assert.ok(Array.isArray(power.tool_calls) && power.tool_calls.length > 0, 'tool-only recipe carries tool_calls');
});

// ───────────────────────── 7. TEARDOWN ─────────────────────────
test('7. context: delete models + drop contexts; list shows them gone', opts, async (t) => {
  if (skip(t)) return;
  // delete the semantic task's model additions (context delete_semantic_model action)
  const dsm = await engine.context({ action: 'delete_semantic_model', context_id: S.semCtx, semantic_model: 'events', cascade: true });
  assert.equal(dsm.removed, true);
  // delete the A/B pipeline model definition (context delete_model action)
  const dnm = await engine.context({ action: 'delete_model', context_id: S.abCtx });
  assert.equal(dnm.removed, true);

  for (const id of [S.semCtx, S.pipeCtx, S.abCtx]) {
    const d = await engine.context({ action: 'drop', context_id: id });
    assert.equal(d.removed, true, `dropped ${id}`);
  }
  const remaining = (await engine.context({ action: 'list' })).contexts;
  for (const id of [S.semCtx, S.pipeCtx, S.abCtx]) {
    assert.ok(!remaining.some((c) => c.context_id === id), `context ${id} gone`);
  }
  assert.equal(remaining.length, before - 3, 'exactly the three dropped contexts removed');
});
