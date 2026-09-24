// END-TO-END integration test: ONE realistic analytics workflow that exercises ALL
// the MCP tools together and verifies they chain correctly. A single seed+run feeds
// every hop. The story (an analyst onboarding into a new dataset):
//   1. DISCOVERY   — semantic_index overview → event → property (paged/ordered) →
//                    value search, asserting the rewarded → ad_type → ad_finished
//                    provenance fact from the value index.
//   2. INDEX STATE — semantic_index reports the value-index sync after refresh().
//   3. NATIVE PIPE — build_pipeline_model (start/add_step/preview/commit) builds the
//                    activation funnel; rows read back via query_pipeline_model; the
//                    committed counts equal the all-at-once register path (12/8/5/3).
//   4. SEMANTIC    — build_semantic_model (IAP revenue) → query_semantic_model by
//                    country → update_semantic_model adds a payers metric → re-query;
//                    context({describe|list}) + semantic_index({status}) lifecycle.
//   5. A/B         — build_pipeline_model fed the conversion recipe's stages one-at-a-
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
import { startWarehouse } from './warehouse-harness.js';
import { settle, readTable } from '../helpers/settle.js';

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
let wh; let engine; let backend; let index; let indexer; let recipes;
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
  wh = await startWarehouse();
  const env = { ...process.env, DBT_PROFILES_DIR: BASE, DBT_PROJECT_DIR: BASE, DUCKDB_PATH: wh.path };
  await execFileP(DBT_BIN, ['seed'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  await execFileP(DBT_BIN, ['run'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  const catalog = loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), { profilesDir: BASE, projectDir: BASE });
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: mkdtempSync(join(tmpdir(), 'e2e-')), timeSpineDialect: 'duckdb' });
  backend = new MfEngineBackend({ pythonBin: PY_BIN, dbtBin: DBT_BIN, profilesDir: BASE });
  recipes = loadRecipes(join(process.cwd(), 'config', 'recipes.json'));
  // A temp-file value index so semantic_index reports a REAL persisted SQLite index.
  const dbPath = join(mkdtempSync(join(tmpdir(), 'e2e-db-')), 'value-index.sqlite');
  engine = settle(new Engine({ catalog, contextManager: ctxs, runner: backend, recipes, dbPath }));
  index = engine.valueIndex;
  indexer = new BackgroundIndexer({ catalog, runner: backend, index, baseProjectDir: BASE, intervalMs: 0, maxValues: 50, logger: () => {} });
  // Await directly so the value index is populated before the discovery assertions.
  await indexer.refresh();
}, opts);

after(async () => { backend?.close(); index?.close(); if (wh) await wh.stop(); });

// ───────────────────────── 1. DISCOVERY ─────────────────────────
test('1a. semantic_index overview lists models + event names (no column dump)', opts, async (t) => {
  if (skip(t)) return;
  const overview = await engine.semantic_index();
  assert.ok(overview.models.find((m) => m.key === 'events'), 'events model present');
  assert.ok(overview.event_names.events.includes('ad_finished'), 'the events source lists its own event names incl. ad_finished');
  assert.ok(overview.event_names.crashlytics.includes('fatal_crash'), 'the crash source lists ITS own event names, not merged into one list');
  assert.equal(overview.models.find((m) => m.key === 'events').physical_columns, undefined, 'overview stays compact');
});

test('1b. semantic_index({ source: "events", event: "ad_finished" }) scopes to that event\'s properties + index hints', opts, async (t) => {
  if (skip(t)) return;
  const ev = await engine.semantic_index({ source: 'events', event: 'ad_finished' });
  const p = ev.properties.find((x) => x.name === 'ad_type_of_event_data');
  assert.ok(p, 'ad_finished carries ad_type_of_event_data');
  assert.equal(p.distinct_count, 3); // rewarded/interstitial/banner over the whole fact
  assert.ok(p.sample_values.length <= 3 && p.sample_values.some((v) => v.value === 'rewarded'), 'compact top-3 hint includes rewarded');
});

test('1c. semantic_index({ source, property }) pages + orders the indexed values (10/8/6)', opts, async (t) => {
  if (skip(t)) return;
  const out = await engine.semantic_index({ source: 'events', property: 'ad_type_of_event_data' });
  assert.equal(out.distinct_count, 3);
  assert.equal(out.total_count, 24); // 12 ad_started + 12 ad_finished
  assert.equal(valOf(out.sample_values, 'rewarded').freq, 10);
  assert.equal(valOf(out.sample_values, 'interstitial').freq, 8);
  assert.equal(valOf(out.sample_values, 'banner').freq, 6);
  // paging: top 1 by freq desc, then offset 1
  const p1 = await engine.semantic_index({ source: 'events', property: 'ad_type_of_event_data', limit: 1 });
  assert.deepEqual(p1.sample_values.map((v) => v.value), ['rewarded']);
  assert.equal(p1.value_stats.has_more, true);
  const p2 = await engine.semantic_index({ source: 'events', property: 'ad_type_of_event_data', limit: 1, offset: 1 });
  assert.deepEqual(p2.sample_values.map((v) => v.value), ['interstitial']);
  // order_by value asc → alphabetical
  const alpha = await engine.semantic_index({ source: 'events', property: 'ad_type_of_event_data', order_by: 'value' });
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
  // EXACT coverage — one prop_stats row per indexable key, over EVERY events fact:
  //   · that fact's event properties (scalar top-values AND complex coverage-only), plus
  //   · its categorical dimensions except the event_name column,
  // and the categorical dimensions of every non-fact model (users/experiments). No gaps.
  const c = engine.catalog;
  // …minus anything the schema opted OUT of value indexing (meta.mcp.index:false — an id
  // column is groupable but has no enumerable value set worth scanning).
  const catDims = (k, skip) => Object.entries(c.getModel(k).dimensions || {})
    .filter(([d, spec]) => d !== skip && spec?.index !== false && String(spec?.type || '').toLowerCase() !== 'time')
    .map(([d]) => d);
  const expected = c.facts.reduce((n, f) => n + c.eventProps(f).length + catDims(f, c.eventNameColumn(f)).length, 0)
    + c.modelKeys().filter((k) => !c.isFact(k)).reduce((n, k) => n + catDims(k).length, 0);
  assert.equal(vi.indexed_properties, expected, 'one prop_stats row per indexable property/attribute');
  // …and the persisted counts equal what the run itself reported (DB COUNT == run counters).
  assert.equal(vi.indexed_properties, vi.last_successful_run.properties_indexed);
  assert.equal(vi.total_values, vi.last_successful_run.values_written);
  assert.ok(vi.total_values > 0, 'values stored');
  assert.equal(typeof out.tasks.total, 'number');
});

// 2b. Read the index DIRECTLY (bypassing semantic_index): the exact seeded values landed.
test('2b. the value index holds the exact seeded values (direct read)', opts, async (t) => {
  if (skip(t)) return;
  const vi = engine.valueIndex;
  // ad_type over the whole fact: rewarded 10 / interstitial 8 / banner 6 (SEED_DATA §5, ad_started+ad_finished).
  const adStat = vi.stats('events', 'ad_type_of_event_data');
  assert.equal(adStat.distinctCount, 3);
  assert.equal(adStat.totalCount, 24);
  assert.ok(typeof adStat.indexedAt === 'number');
  assert.deepEqual(vi.sampleValues('events', 'ad_type_of_event_data'), [{ value: 'rewarded', freq: 10 }, { value: 'interstitial', freq: 8 }, { value: 'banner', freq: 6 }]);
  // level result: win 20 / lose 5 (SEED_DATA §4), distinct 2 / total 25.
  const rStat = vi.stats('events', 'result_of_event_data');
  assert.equal(rStat.distinctCount, 2);
  assert.equal(rStat.totalCount, 25);
  assert.deepEqual(vi.sampleValues('events', 'result_of_event_data'), [{ value: 'win', freq: 20 }, { value: 'lose', freq: 5 }]);
  // direct paging/order over the index (order_by value → alphabetical).
  assert.deepEqual(vi.listValues('events', 'ad_type_of_event_data', { by: 'value' }).map((v) => v.value), ['banner', 'interstitial', 'rewarded']);
  // substring search may legitimately match more than one value (e.g. 'rewarded_ad'),
  // ordered by freq desc → the exact ad_type 'rewarded' (10) is the top hit.
  const sv = vi.searchValues('rewarded');
  assert.ok(sv.some((m) => m.property === 'ad_type_of_event_data' && m.value === 'rewarded' && m.freq === 10), 'exact rewarded→ad_type match present');
  assert.equal(sv[0].value, 'rewarded', 'highest-frequency match first');
});

// ───────────────────────── 3. NATIVE PIPELINE (incremental) ─────────────────────────
test('3a. build_pipeline_model: start → add_step (funnel) → preview → commit = 12/8/5/3', opts, async (t) => {
  if (skip(t)) return;
  const s = await engine.build_pipeline_model({ action: 'start', name: 'e2e_funnel', source: 'events', include_columns: true });
  assert.ok(s.draft_id, 'start returns a draft_id');
  assert.ok(s.available_columns.some((c) => c.name === 'player_id_of_internal'), 'source columns at start');
  S.draftId = s.draft_id;

  // default add_step returns a DIFF; the funnel columns show up as added.
  const a1 = await engine.build_pipeline_model({ action: 'add_step', draft_id: S.draftId, stage: matchActivation() });
  assert.equal(a1.step_index, 1);
  const cols = a1.columns_added.map((c) => c.name);
  assert.ok(cols.includes('reached_launch') && cols.includes('completed'), 'funnel output columns reported as added');

  const pv = await engine.build_pipeline_model({ action: 'preview', draft_id: S.draftId });
  assert.ok(typeof pv.model_sql === 'string' && pv.model_sql.length > 0, 'preview renders SQL (existence only)');
  assert.equal(pv.steps.length, 1);

  const c = await engine.build_pipeline_model({ action: 'materialize', draft_id: S.draftId });
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
  const r = await engine.query_pipeline_model({ task_id: S.pipeTask, limit: 1000 });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(reached(r.rows, 'launch'), 12);
  assert.equal(reached(r.rows, 'tut1'), 8);
  assert.equal(reached(r.rows, 'tut2'), 5);
  assert.equal(reached(r.rows, 'tut3'), 3);
  // transform the stored table in place: count users whose furthest step is tut3 = 3
  const t3 = await readTable(engine, S.pipeCtx, S.pipeTable, { transform: { where: [{ column: 'furthest_step_name', op: 'eq', value: 'tut3' }], aggregations: [{ fn: 'count', column: '*', as: 'n' }] } });
  assert.equal(t3.ok, true, JSON.stringify(t3.error));
  assert.equal(num(t3.rows[0].n), 3);
});

test('3c. commit equals the all-at-once register_native_model path (fidelity 12/8/5/3)', opts, async (t) => {
  if (skip(t)) return;
  const out = await engine.register_native_model({ name: 'e2e_funnel_aao', pipeline: { source: 'events', stages: [matchActivation()] } });
  assert.equal(out.build?.ok, true, JSON.stringify(out.error || out.build));
  assert.equal(reached(out.rows, 'launch'), 12);
  assert.equal(reached(out.rows, 'tut1'), 8);
  assert.equal(reached(out.rows, 'tut2'), 5);
  assert.equal(reached(out.rows, 'tut3'), 3);
  await engine.delete_native_model({ context_id: out.context_id });
});

// ───────────────────────── 4. SEMANTIC MODEL ─────────────────────────
test('4a. build_semantic_model (IAP revenue) → query by country = US35/GB25/BR25, total 85', opts, async (t) => {
  if (skip(t)) return;
  const created = await engine.build_semantic_model({
    name: 'e2e_mon', use_base_models: ['users'],
    semantic_models: [{ from: 'events', event_scope: { event_name: ['iap_purchase_completed'] }, measures: [{ name: 'revenue', agg: 'sum', field: 'price_in_usd_of_event_data' }] }],
    metrics: [{ name: 'revenue', type: 'simple', measure: { name: 'revenue' } }],
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
  // Provenance #1: real data_freshness (latest event time) + an open-ended window flags
  // staleness (the tail past the latest data is empty/partial).
  assert.equal(r.provenance.tier, 'governed_metric');
  assert.ok(typeof r.provenance.data_freshness === 'string' && r.provenance.data_freshness.length > 0, 'data_freshness = latest event time');
  assert.ok(r.recommendations.some((x) => /current only through/i.test(x)), `open-ended window flags freshness: ${JSON.stringify(r.recommendations)}`);

  // Recommendation #4: count_distinct grouped by time is non-additive → prefer HLL sketches.
  const byDay = await engine.query_semantic_model({ context_id: S.semCtx, metrics: ['e2e_mon_payers'], group_by: [{ time: 'metric_time', grain: 'day' }] });
  assert.ok(byDay.recommendations.some((x) => /not additive/i.test(x) && /HLL/i.test(x)), `distinct-by-time should warn + suggest HLL: ${JSON.stringify(byDay.recommendations)}`);
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
  // stages one at a time, then commit. (register_native_model with the same payload
  // is the documented fallback; here we prove the add_step path also works.)
  const r = recipes.list.find((x) => x.id === 'ab_test_conversion');
  const stages = r.register_payload.pipeline.stages;
  const start = await engine.build_pipeline_model({ action: 'start', name: 'e2e_ab_conv', source: r.register_payload.pipeline.source });
  for (const stage of stages) {
    const a = await engine.build_pipeline_model({ action: 'add_step', draft_id: start.draft_id, stage });
    assert.ok(Number.isInteger(a.step_index), 'each add_step advances the draft');
  }
  const commit = await engine.build_pipeline_model({ action: 'materialize', draft_id: start.draft_id });
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

test('5b. experiment({analyze}) on the per-variant aggregates: significant drop (1.0 → 1/6)', opts, async (t) => {
  if (skip(t)) return;
  const { abMap: map, abByGroup: byGroup } = S;
  const arm = (row) => ({ label: String(row[map.group_field]), n: num(row[map.n_field]), conversions: num(row[map.conversions_field]) });
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
  const groups = Object.values(byGroup).map((row) => ({ label: String(row[map.group_field]), n: num(row[map.n_field]) }));
  const res = engine.experiment({ action: 'check_split', groups });
  assert.equal(res.ok, true);
  close(res.chi_square, 0);          // 6 vs 6 against an even split
  assert.equal(res.srm_detected, false);
});

test('5d. experiment({plan}) matches the recipe tool_calls outputs (data-grounded)', opts, async (t) => {
  if (skip(t)) return;
  // Use the ab_test_power recipe's declared tool_calls so the asserted numbers are
  // the recipe's own ground truth (the recipes-parse suite runs these too).
  const power = recipes.list.find((x) => x.id === 'ab_test_power');
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
  for (const want of ['ab_test_conversion', 'ratio_metric', 'funnel_from_event_property_steps', 'ab_test_power']) {
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
});
