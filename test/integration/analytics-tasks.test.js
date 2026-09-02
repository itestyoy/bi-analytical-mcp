// Coverage proof: EACH analytics task family in config/recipes.json can be served
// by a dbt Semantic Layer model built through this engine. For every family we
// build the recipe's model ONCE via engine.get_recipe(id).create_payload (writes
// YAML + dbt parse), then run several query_semantic_model calls and assert on
// DATA: res.ok === true plus EXACT figures from fixtures/SEED_DATA.md and
// invariants (grouped sum == grand total; rate in [0,1]; DAU <= MAU; completers
// <= starters). >= 5 data assertions per family.
//
// Only the two documented data sources exist (events fact + user attributes);
// joins are 1-hop events.user -> dim_users. NO text/SQL/command assertions.
//
// Runs against dbt Core + MetricFlow + PGlite. Auto-skips when dbt/mf are not
// installed (HAS_DBT gate).

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
import { startPglite } from './pglite-harness.js';

const execFileP = promisify(execFile);
const BASE = join(process.cwd(), 'test', 'integration', 'fixtures', 'dbt_project');
const DBT_BIN = process.env.DBT_BIN || join(process.cwd(), '.dbtvenv', 'bin', 'dbt');
const MF_BIN = process.env.MF_BIN || join(process.cwd(), '.dbtvenv', 'bin', 'mf');
const PY_BIN = process.env.PYTHON_BIN || join(process.cwd(), '.dbtvenv', 'bin', 'python');
const HAS_DBT = existsSync(DBT_BIN) && existsSync(MF_BIN);
const opts = { timeout: 600000 };

let pg;
let engine;

const num = (v) => Number(v === '' || v == null ? NaN : v);
const sumCol = (rows, col) => rows.reduce((s, r) => s + (Number.isFinite(num(r[col])) ? num(r[col]) : 0), 0);
const mapCol = (rows, keyCol, valCol) => Object.fromEntries(rows.map((r) => [String(r[keyCol]), num(r[valCol])]));

before(async () => {
  if (!HAS_DBT) return;
  pg = await startPglite();
  process.env.DBT_PG_PORT = String(pg.port);
  const env = { ...process.env, DBT_PROFILES_DIR: BASE, DBT_PROJECT_DIR: BASE, DBT_PG_PORT: String(pg.port) };
  await execFileP(DBT_BIN, ['seed'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  await execFileP(DBT_BIN, ['run'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });

  const catalog = loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), { profilesDir: BASE, projectDir: BASE });
  const recipes = loadRecipes(join(process.cwd(), 'config', 'recipes.json'));
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: mkdtempSync(join(tmpdir(), 'at-')), timeSpineDialect: 'postgres' });
  const runner = new MfEngineBackend({ pythonBin: PY_BIN, dbtBin: DBT_BIN, profilesDir: BASE });
  engine = new Engine({ catalog, contextManager: ctxs, runner, recipes });
}, opts);

after(async () => { engine?.runner?.close?.(); if (pg) await pg.stop(); });
const skip = (t) => { if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; } return false; };

// Build a recipe's model once via the published get_recipe payload.
async function buildRecipe(t, id) {
  const out = await engine.create_semantic_model(engine.get_recipe({ id }).create_payload);
  assert.equal(out.parse.ok, true, `parse failed for ${id}: ${JSON.stringify(out.parse.error || out.parse)}`);
  return out.context_id;
}
const q = (ctx, input) => engine.query_semantic_model({ context_id: ctx, ...input });

// ── 1. trends: active_users_trend ────────────────────────────────────────────
// #6: a numeric value that arrives as STRING is aggregable via cast:numeric.
test('TASK cast: sum/avg a STRING-numeric property with cast:numeric', opts, async (t) => {
  if (skip(t)) return;
  const out = await engine.create_semantic_model({
    name: 'castq',
    semantic_models: [{
      from: 'events',
      event_scope: { event_name: ['level_completed'] },
      measures: [
        { name: 'sum_ct', agg: 'sum', field: 'complete_time_of_event_data', cast: 'numeric' },
        { name: 'avg_ct', agg: 'average', field: 'complete_time_of_event_data', cast: 'numeric' },
      ],
    }],
    metrics: [
      { name: 'sum_ct', type: 'simple', measure: { name: 'sum_ct' } },
      { name: 'avg_ct', type: 'simple', measure: { name: 'avg_ct' } },
    ],
  });
  assert.equal(out.parse.ok, true, JSON.stringify(out.parse.error || out.parse));
  const r = await q(out.context_id, { metrics: ['castq_sum_ct', 'castq_avg_ct'] });
  assert.equal(r.ok, true, JSON.stringify(r.error || r));
  assert.equal(num(r.rows[0].castq_sum_ct), 1263);            // exact Σ complete_time
  assert.ok(Math.abs(num(r.rows[0].castq_avg_ct) - 50.52) < 1e-6);
  // the same aggregation WITHOUT a cast is rejected (string is not numeric)
  await assert.rejects(engine.create_semantic_model({
    name: 'castbad',
    semantic_models: [{ from: 'events', event_scope: { event_name: ['level_completed'] }, measures: [{ name: 'bad', agg: 'average', field: 'complete_time_of_event_data' }] }],
    metrics: [{ name: 'bad', type: 'simple', measure: { name: 'bad' } }],
  }), /not numeric|cast/i);
});

test('TASK active_users_trend: DAU/WAU/MAU & event volume', opts, async (t) => {
  if (skip(t)) return;
  const ctx = await buildRecipe(t, 'active_users_trend');
  const grand = await q(ctx, { metrics: ['active_users_dau'] });
  const byDay = await q(ctx, { metrics: ['active_users_dau'], group_by: [{ time: 'metric_time', grain: 'day' }] });
  const byMonth = await q(ctx, { metrics: ['active_users_dau'], group_by: [{ time: 'metric_time', grain: 'month' }] });
  const events = await q(ctx, { metrics: ['active_users_events'] });
  for (const r of [grand, byDay, byMonth, events]) assert.equal(r.ok, true, JSON.stringify(r.error || r));
  assert.equal(num(grand.rows[0].active_users_dau), 12);                 // 12 distinct users overall
  assert.equal(byDay.row_count, 7);                                      // 7 distinct active days
  assert.equal(Math.max(...byDay.rows.map((r) => num(r.active_users_dau))), 6); // peak DAU 6 (2026-01-05)
  const mau = num(byMonth.rows[0].active_users_dau);
  assert.equal(mau, 12);                                                 // MAU = 12
  assert.ok(byDay.rows.every((r) => num(r.active_users_dau) <= mau));    // DAU <= MAU
  assert.equal(num(events.rows[0].active_users_events), 184);           // 184 seeded events

  // explain: return the query PLAN + rendered SQL WITHOUT executing (feature/
  // lifecycle check — we assert the plan/SQL are PRESENT, not their content).
  const ex = await q(ctx, { metrics: ['active_users_dau'], group_by: [{ time: 'metric_time', grain: 'day' }], explain: true });
  assert.equal(ex.ok, true, JSON.stringify(ex.error || ex));
  assert.equal(ex.explain, true);
  assert.ok(typeof ex.sql === 'string' && ex.sql.length > 0);            // rendered SQL returned
  assert.ok(ex.plan && typeof ex.plan === 'object');                     // plan object returned
  assert.ok(typeof ex.plan.dataflow_plan === 'string' && ex.plan.dataflow_plan.length > 0); // dataflow plan present
  assert.ok(typeof ex.plan.execution_plan === 'string' && ex.plan.execution_plan.length > 0); // execution plan present

  // #4b: order_by accepts the `metric_time` alias (resolves to metric_time_day, so the
  // suffix need not be guessed); explain surfaces the orderable tokens; a bad key lists them.
  assert.ok(ex.orderable_keys.includes('metric_time_day') && ex.orderable_keys.includes('active_users_dau'), `orderable_keys: ${JSON.stringify(ex.orderable_keys)}`);
  const sorted = await q(ctx, { metrics: ['active_users_dau'], group_by: [{ time: 'metric_time', grain: 'day' }], order_by: [{ key: 'metric_time' }] });
  assert.equal(sorted.ok, true, JSON.stringify(sorted.error || sorted));
  assert.equal(sorted.row_count, 7); // same 7 days, now ordered by the resolved metric_time_day
  await assert.rejects(() => q(ctx, { metrics: ['active_users_dau'], group_by: [{ time: 'metric_time', grain: 'day' }], order_by: [{ key: 'nonsense' }] }), /Orderable:/);
});

// ── 2. segmentation: metric_by_user_segment ──────────────────────────────────
test('TASK metric_by_user_segment: revenue/payers/ARPPU by user attribute (1-hop join)', opts, async (t) => {
  if (skip(t)) return;
  const ctx = await buildRecipe(t, 'metric_by_user_segment');
  const total = await q(ctx, { metrics: ['rev_segment_revenue', 'rev_segment_payers'] });
  const byCountry = await q(ctx, { metrics: ['rev_segment_revenue'], group_by: [{ model: 'users', attribute: 'country' }] });
  const byPlatform = await q(ctx, { metrics: ['rev_segment_revenue'], group_by: [{ model: 'users', attribute: 'platform' }] });
  const byAcq = await q(ctx, { metrics: ['rev_segment_revenue', 'rev_segment_payers'], group_by: [{ model: 'users', attribute: 'acquisition_type' }] });
  const arppu = await q(ctx, { metrics: ['rev_segment_arppu'], group_by: [{ model: 'users', attribute: 'acquisition_type' }] });
  for (const r of [total, byCountry, byPlatform, byAcq, arppu]) assert.equal(r.ok, true, JSON.stringify(r.error || r));
  assert.equal(num(total.rows[0].rev_segment_revenue), 85);             // total revenue 85
  assert.equal(num(total.rows[0].rev_segment_payers), 7);              // payers 7
  const cm = mapCol(byCountry.rows, 'users_country', 'rev_segment_revenue');
  assert.equal(cm.US, 35); assert.equal(cm.GB, 25); assert.equal(cm.BR, 25); // by country
  assert.equal(sumCol(byCountry.rows, 'rev_segment_revenue'), 85);      // grouped sum == grand total
  assert.equal(sumCol(byPlatform.rows, 'rev_segment_revenue'), 85);
  const am = mapCol(byAcq.rows, 'users_acquisition_type', 'rev_segment_revenue');
  assert.equal(am.paid, 55); assert.equal(am.organic, 30);             // by acquisition_type
  // ARPPU == revenue/payers per acq segment
  const payByAcq = mapCol(byAcq.rows, 'users_acquisition_type', 'rev_segment_payers');
  for (const row of arppu.rows) {
    const k = String(row.users_acquisition_type);
    if (!Number.isFinite(payByAcq[k]) || payByAcq[k] === 0) continue;
    assert.ok(Math.abs(num(row.rev_segment_arppu) - am[k] / payByAcq[k]) < 1e-6, `ARPPU ${k}`);
  }
});

// ── 3. funnel: step_conversion_funnel (level_started -> level_completed) ──────
test('TASK step_conversion_funnel: distinct-user start->complete conversion', opts, async (t) => {
  if (skip(t)) return;
  const ctx = await buildRecipe(t, 'step_conversion_funnel');
  const counts = await q(ctx, { metrics: ['lvl_funnel_starters', 'lvl_funnel_completers'] });
  const rate = await q(ctx, { metrics: ['lvl_funnel_completion_rate'] });
  const rateByDay = await q(ctx, { metrics: ['lvl_funnel_completion_rate'], group_by: [{ time: 'metric_time', grain: 'day' }] });
  const startsByDay = await q(ctx, { metrics: ['lvl_funnel_starters'], group_by: [{ time: 'metric_time', grain: 'day' }] });
  const byCountry = await q(ctx, { metrics: ['lvl_funnel_completion_rate'], group_by: [{ model: 'users', attribute: 'country' }] });
  for (const r of [counts, rate, rateByDay, startsByDay, byCountry]) assert.equal(r.ok, true, JSON.stringify(r.error || r));
  // all 12 users start AND complete at least one level (level 1 completed by all)
  assert.equal(num(counts.rows[0].lvl_funnel_starters), 12);
  assert.equal(num(counts.rows[0].lvl_funnel_completers), 12);
  assert.ok(num(counts.rows[0].lvl_funnel_completers) <= num(counts.rows[0].lvl_funnel_starters)); // completers <= starters
  const cr = num(rate.rows[0].lvl_funnel_completion_rate);
  assert.ok(cr >= 0 && cr <= 1, `rate ${cr}`);                          // rate in [0,1]
  assert.ok(rateByDay.rows.every((r) => { const v = num(r.lvl_funnel_completion_rate); return !Number.isFinite(v) || (v >= 0 && v <= 1); }));
  assert.ok(sumCol(startsByDay.rows, 'lvl_funnel_starters') >= 12);     // per-day distinct >= overall distinct
});

// ── 4. funnel: multistep_funnel (event + step_id property value) ──────────────
test('TASK multistep_funnel: tutorial step_id drop-off 8 -> 5 -> 3', opts, async (t) => {
  if (skip(t)) return;
  const ctx = await buildRecipe(t, 'multistep_funnel');
  const steps = await q(ctx, { metrics: ['tut_funnel_step1', 'tut_funnel_step2', 'tut_funnel_step3'] });
  const c12 = await q(ctx, { metrics: ['tut_funnel_conv_1_2'] });
  const c23 = await q(ctx, { metrics: ['tut_funnel_conv_2_3'] });
  for (const r of [steps, c12, c23]) assert.equal(r.ok, true, JSON.stringify(r.error || r));
  const row = steps.rows[0];
  assert.equal(num(row.tut_funnel_step1), 8);                           // step_1 distinct users
  assert.equal(num(row.tut_funnel_step2), 5);                           // step_2
  assert.equal(num(row.tut_funnel_step3), 3);                           // step_3
  assert.ok(num(row.tut_funnel_step1) >= num(row.tut_funnel_step2) && num(row.tut_funnel_step2) >= num(row.tut_funnel_step3)); // monotonic
  const v12 = num(c12.rows[0].tut_funnel_conv_1_2);
  const v23 = num(c23.rows[0].tut_funnel_conv_2_3);
  assert.ok(v12 > 0 && v12 <= 1.0001, `conv12 ${v12}`);                 // rate in (0,1]
  assert.ok(v23 > 0 && v23 <= 1.0001, `conv23 ${v23}`);
  assert.ok(Math.abs(v12 - 5 / 8) < 0.06, `conv12≈0.625 got ${v12}`);
});

// ── 5. retention: nday_retention ─────────────────────────────────────────────
test('TASK nday_retention: D1/D7 return-within-window conversion rates', opts, async (t) => {
  if (skip(t)) return;
  const ctx = await buildRecipe(t, 'nday_retention');
  const d1 = await q(ctx, { metrics: ['retention_d1'] });
  const d7 = await q(ctx, { metrics: ['retention_d7'] });
  const d1ByDay = await q(ctx, { metrics: ['retention_d1'], group_by: [{ time: 'metric_time', grain: 'day' }] });
  const d7ByDay = await q(ctx, { metrics: ['retention_d7'], group_by: [{ time: 'metric_time', grain: 'day' }] });
  for (const r of [d1, d7, d1ByDay, d7ByDay]) assert.equal(r.ok, true, JSON.stringify(r.error || r));
  const r1 = num(d1.rows[0].retention_d1);
  const r7 = num(d7.rows[0].retention_d7);
  // cohort=first_launch, returned=new_session are DIFFERENT events, so the rate
  // reflects data (not the old tautological 1.0 from identical measures). The
  // AGGREGATE rate is a true conversion rate in [0,1].
  assert.ok(r1 >= 0 && r1 <= 1, `D1 ${r1}`);                            // aggregate rate in [0,1]
  assert.ok(r7 >= 0 && r7 <= 1, `D7 ${r7}`);
  assert.ok(r7 >= r1 - 1e-9, `D7(${r7}) >= D1(${r1})`);                 // wider window retains >=
  assert.ok(d1ByDay.row_count > 0 && d7ByDay.row_count > 0);
  // Per-day grouping of a conversion metric is NOT bounded by 1: returns are
  // attributed within the window across day boundaries, so a single day's
  // numerator can exceed that day's cohort. Assert only the valid invariant —
  // finite per-day rates are non-negative — and that real values are present.
  assert.ok(d7ByDay.rows.every((r) => { const v = num(r.retention_d7); return !Number.isFinite(v) || v >= 0; }));
  assert.ok(d7ByDay.rows.some((r) => Number.isFinite(num(r.retention_d7)) && num(r.retention_d7) > 0));
});

// ── 6. cohort: cohort_retention_grid (install_date x activity) ────────────────
test('TASK cohort_retention_grid: install-cohort x activity revenue/buyers grid', opts, async (t) => {
  if (skip(t)) return;
  const ctx = await buildRecipe(t, 'cohort_retention_grid');
  const total = await q(ctx, { metrics: ['cohort_grid_revenue'] });
  const buyersTotal = await q(ctx, { metrics: ['cohort_grid_buyers'] });
  const byCohort = await q(ctx, { metrics: ['cohort_grid_revenue'], group_by: [{ model: 'users', attribute: 'install_date' }] });
  const buyersByCohort = await q(ctx, { metrics: ['cohort_grid_buyers'], group_by: [{ model: 'users', attribute: 'install_date' }] });
  const grid = await q(ctx, { metrics: ['cohort_grid_revenue'], group_by: [{ model: 'users', attribute: 'install_date' }, { time: 'metric_time', grain: 'day' }] });
  for (const r of [total, buyersTotal, byCohort, buyersByCohort, grid]) assert.equal(r.ok, true, JSON.stringify(r.error || r));
  assert.equal(num(total.rows[0].cohort_grid_revenue), 85);            // total revenue 85
  assert.equal(num(buyersTotal.rows[0].cohort_grid_buyers), 7);        // distinct buyers 7
  assert.equal(sumCol(byCohort.rows, 'cohort_grid_revenue'), 85);      // revenue summed across cohorts == grand total
  assert.equal(sumCol(grid.rows, 'cohort_grid_revenue'), 85);          // full grid sums to grand total
  assert.ok(buyersByCohort.rows.every((r) => num(r.cohort_grid_buyers) <= 7)); // per-cohort buyers <= total payers
});

// ── 7. behavioral: behavioral_cohort (did / didn't purchase) ─────────────────
test('TASK behavioral_cohort: did/didn-t-purchase counts & Metric()-in-where split', opts, async (t) => {
  if (skip(t)) return;
  const ctx = await buildRecipe(t, 'behavioral_cohort');
  const purchases = await q(ctx, { metrics: ['behavior_purchases'] });
  const sessions = await q(ctx, { metrics: ['behavior_sessions'] });
  const both = await q(ctx, { metrics: ['behavior_purchases', 'behavior_sessions'] });
  const sessByDay = await q(ctx, { metrics: ['behavior_sessions'], group_by: [{ time: 'metric_time', grain: 'day' }] });
  for (const r of [purchases, sessions, both, sessByDay]) assert.equal(r.ok, true, JSON.stringify(r.error || r));
  assert.equal(num(purchases.rows[0].behavior_purchases), 8);          // 8 completed purchases (sum_boolean)
  assert.equal(num(sessions.rows[0].behavior_sessions), 21);           // 21 new_session events
  assert.equal(sumCol(sessByDay.rows, 'behavior_sessions'), 21);       // per-day sessions sum to 21
  assert.ok(num(both.rows[0].behavior_purchases) < num(both.rows[0].behavior_sessions)); // behavior is a subset signal

  // did / didn't split via Metric() in the warm backend --where
  const dir = engine.ctxs.dir(ctx);
  const did = await engine.runner.query(dir, { metrics: ['behavior_sessions'], where: ["{{ Metric('behavior_purchases', group_by=['user']) }} > 0"] });
  const didnt = await engine.runner.query(dir, { metrics: ['behavior_sessions'], where: ["{{ Metric('behavior_purchases', group_by=['user']) }} = 0"] });
  assert.equal(did.ok, true, did.stderr);
  assert.equal(didnt.ok, true, didnt.stderr);
  // purchasers (7) + non-purchasers (5) sessions partition the 21 total sessions
  assert.equal(num(did.rows[0].behavior_sessions) + num(didnt.rows[0].behavior_sessions), 21);
});

// ── 8. conversion: visit_to_purchase_conversion ──────────────────────────────
test('TASK visit_to_purchase_conversion: native conversion metric', opts, async (t) => {
  if (skip(t)) return;
  const ctx = await buildRecipe(t, 'visit_to_purchase_conversion');
  const visits = await q(ctx, { metrics: ['visit_purchase_visits'] });
  const overall = await q(ctx, { metrics: ['visit_purchase_conversion'] });
  const byCountry = await q(ctx, { metrics: ['visit_purchase_conversion'], group_by: [{ model: 'users', attribute: 'country' }] });
  const byPlatform = await q(ctx, { metrics: ['visit_purchase_conversion'], group_by: [{ model: 'users', attribute: 'platform' }] });
  const byDay = await q(ctx, { metrics: ['visit_purchase_conversion'], group_by: [{ time: 'metric_time', grain: 'day' }] });
  for (const r of [visits, overall, byCountry, byPlatform, byDay]) assert.equal(r.ok, true, JSON.stringify(r.error || r));
  assert.equal(num(visits.rows[0].visit_purchase_visits), 12);         // all 12 users visit
  const cv = num(overall.rows[0].visit_purchase_conversion);
  assert.ok(cv >= 0 && cv <= 1, `cv ${cv}`);                           // rate in [0,1]
  assert.ok(Math.abs(cv - 7 / 12) < 0.06, `cv≈0.583 got ${cv}`);       // ~ payers/visitors = 7/12
  assert.ok(byCountry.rows.every((r) => { const v = num(r.visit_purchase_conversion); return !Number.isFinite(v) || (v >= 0 && v <= 1); }));
  assert.ok(byDay.row_count > 0 && byDay.rows.every((r) => { const v = num(r.visit_purchase_conversion); return !Number.isFinite(v) || v >= 0; }));
});

// ── 9. progression: level_progression (per level_id) ─────────────────────────
test('TASK level_progression: starts/completes/rate per level_id', opts, async (t) => {
  if (skip(t)) return;
  const ctx = await buildRecipe(t, 'level_progression');
  const totals = await q(ctx, { metrics: ['progression_starts', 'progression_completes'] });
  const rate = await q(ctx, { metrics: ['progression_completion_rate'] });
  const avgTime = await q(ctx, { metrics: ['progression_avg_time'] });
  const startsByLevel = await q(ctx, { metrics: ['progression_starts'], group_by: [{ model: 'events', attribute: 'level_id_of_event_data' }] });
  const completesByLevel = await q(ctx, { metrics: ['progression_completes'], group_by: [{ model: 'events', attribute: 'level_id_of_event_data' }] });
  for (const r of [totals, rate, avgTime, startsByLevel, completesByLevel]) assert.equal(r.ok, true, JSON.stringify(r.error || r));
  assert.equal(num(totals.rows[0].progression_starts), 28);            // total level_started 28
  assert.equal(num(totals.rows[0].progression_completes), 25);         // total level_completed 25
  assert.ok(num(totals.rows[0].progression_completes) <= num(totals.rows[0].progression_starts)); // completers <= starters
  const cr = num(rate.rows[0].progression_completion_rate);
  assert.ok(Math.abs(cr - 25 / 28) < 1e-9 && cr >= 0 && cr <= 1, `rate ${cr}`); // 25/28 in [0,1]
  assert.ok(num(avgTime.rows[0].progression_avg_time) > 0);
  const sBy = mapCol(startsByLevel.rows, 'events_level_id_of_event_data', 'progression_starts');
  assert.equal(sBy['1'], 12); assert.equal(sBy['2'], 6); assert.equal(sBy['3'], 3); // per-level starts
  assert.equal(sumCol(startsByLevel.rows, 'progression_starts'), 28);  // grouped starts sum to 28
});

// ── 10. monetization: monetization_metrics ───────────────────────────────────
test('TASK monetization_metrics: revenue/ARPPU/AOV by product/day/segment', opts, async (t) => {
  if (skip(t)) return;
  const ctx = await buildRecipe(t, 'monetization_metrics');
  const totals = await q(ctx, { metrics: ['monetization_revenue', 'monetization_payers', 'monetization_purchases'] });
  const aov = await q(ctx, { metrics: ['monetization_aov'] });
  const byProduct = await q(ctx, { metrics: ['monetization_revenue'], group_by: [{ model: 'events', attribute: 'product_id_of_event_data' }] });
  const byCountry = await q(ctx, { metrics: ['monetization_revenue'], group_by: [{ model: 'users', attribute: 'country' }] });
  const byDay = await q(ctx, { metrics: ['monetization_revenue'], group_by: [{ time: 'metric_time', grain: 'day' }] });
  for (const r of [totals, aov, byProduct, byCountry, byDay]) assert.equal(r.ok, true, JSON.stringify(r.error || r));
  assert.equal(num(totals.rows[0].monetization_revenue), 85);          // revenue 85
  assert.equal(num(totals.rows[0].monetization_payers), 7);            // payers 7
  assert.equal(num(totals.rows[0].monetization_purchases), 8);         // purchases 8
  assert.ok(Math.abs(num(aov.rows[0].monetization_aov) - 85 / 8) < 1e-6, 'AOV 85/8'); // AOV 10.625
  const pm = mapCol(byProduct.rows, 'events_product_id_of_event_data', 'monetization_revenue');
  assert.equal(pm.p1, 15); assert.equal(pm.p2, 30); assert.equal(pm.p3, 40); // by product
  assert.equal(sumCol(byCountry.rows, 'monetization_revenue'), 85);    // country sum == grand total
  assert.equal(sumCol(byDay.rows, 'monetization_revenue'), 85);        // per-day sum == grand total
});

// ── 11. ads: ad_monetization ─────────────────────────────────────────────────
test('TASK ad_monetization: ad revenue & impressions by network/placement', opts, async (t) => {
  if (skip(t)) return;
  const ctx = await buildRecipe(t, 'ad_monetization');
  const totals = await q(ctx, { metrics: ['ads_ad_revenue', 'ads_impressions'] });
  const byNetwork = await q(ctx, { metrics: ['ads_ad_revenue'], group_by: [{ model: 'events', attribute: 'network_of_additional_info_of_event_data' }] });
  const byPlacement = await q(ctx, { metrics: ['ads_impressions'], group_by: [{ model: 'events', attribute: 'placement_of_event_data' }] });
  const revPerImp = await q(ctx, { metrics: ['ads_rev_per_imp'] });
  const byType = await q(ctx, { metrics: ['ads_impressions'], group_by: [{ model: 'events', attribute: 'ad_type_of_event_data' }] });
  for (const r of [totals, byNetwork, byPlacement, revPerImp, byType]) assert.equal(r.ok, true, JSON.stringify(r.error || r));
  assert.equal(num(totals.rows[0].ads_ad_revenue), 29);                // total ad revenue 29 cents
  assert.equal(num(totals.rows[0].ads_impressions), 12);              // 12 ad_finished impressions
  const nm = mapCol(byNetwork.rows, 'events_network_of_additional_info_of_event_data', 'ads_ad_revenue');
  assert.equal(nm.admob, 12); assert.equal(nm.unity, 8); assert.equal(nm.ironsource, 6); assert.equal(nm.applovin, 3); // by network
  assert.equal(sumCol(byNetwork.rows, 'ads_ad_revenue'), 29);          // network sum == grand total
  assert.equal(sumCol(byPlacement.rows, 'ads_impressions'), 12);       // placement sum == total impressions
  const rpi = num(revPerImp.rows[0].ads_rev_per_imp);
  assert.ok(Math.abs(rpi - 29 / 12) < 1e-6, `rev_per_imp ${rpi}`);     // rev_per_imp == 29/12
});

// ── 12. economy: currency_economy (coins in vs out) ──────────────────────────
test('TASK currency_economy: coins in (510) vs out (140) & source split', opts, async (t) => {
  if (skip(t)) return;
  const ctx = await buildRecipe(t, 'currency_economy');
  const totals = await q(ctx, { metrics: ['economy_coins_in', 'economy_coins_out'] });
  const inBySource = await q(ctx, { metrics: ['economy_coins_in'], group_by: [{ model: 'events', attribute: 'source_type_of_event_data' }] });
  const outBySource = await q(ctx, { metrics: ['economy_coins_out'], group_by: [{ model: 'events', attribute: 'source_type_of_event_data' }] });
  const inByDay = await q(ctx, { metrics: ['economy_coins_in'], group_by: [{ time: 'metric_time', grain: 'day' }] });
  const outByDay = await q(ctx, { metrics: ['economy_coins_out'], group_by: [{ time: 'metric_time', grain: 'day' }] });
  for (const r of [totals, inBySource, outBySource, inByDay, outByDay]) assert.equal(r.ok, true, JSON.stringify(r.error || r));
  const coinsIn = num(totals.rows[0].economy_coins_in);
  const coinsOut = num(totals.rows[0].economy_coins_out);
  assert.equal(coinsIn, 510);                                          // total coins in 510
  assert.equal(coinsOut, 140);                                         // total coins out 140
  assert.equal(coinsIn - coinsOut, 370);                              // net coins 370
  assert.equal(sumCol(inBySource.rows, 'economy_coins_in'), 510);      // income source split sums to 510
  assert.equal(sumCol(inByDay.rows, 'economy_coins_in'), 510);         // income per-day sums to 510
});

// ── 13. stickiness: stickiness_lifecycle (DAU/MAU) ───────────────────────────
test('TASK stickiness_lifecycle: DAU/MAU active base & stickiness', opts, async (t) => {
  if (skip(t)) return;
  const ctx = await buildRecipe(t, 'stickiness_lifecycle');
  const grand = await q(ctx, { metrics: ['stickiness_active_users'] });
  const byDay = await q(ctx, { metrics: ['stickiness_active_users'], group_by: [{ time: 'metric_time', grain: 'day' }] });
  const byWeek = await q(ctx, { metrics: ['stickiness_active_users'], group_by: [{ time: 'metric_time', grain: 'week' }] });
  const byMonth = await q(ctx, { metrics: ['stickiness_active_users'], group_by: [{ time: 'metric_time', grain: 'month' }] });
  for (const r of [grand, byDay, byWeek, byMonth]) assert.equal(r.ok, true, JSON.stringify(r.error || r));
  assert.equal(num(grand.rows[0].stickiness_active_users), 12);        // 12 active overall
  assert.equal(byDay.row_count, 7);                                    // 7 distinct active days
  const mau = num(byMonth.rows[0].stickiness_active_users);
  assert.equal(mau, 12);                                               // MAU 12
  const peak = Math.max(...byDay.rows.map((r) => num(r.stickiness_active_users)));
  assert.equal(peak, 6);                                               // peak DAU 6
  assert.ok(byDay.rows.every((r) => num(r.stickiness_active_users) <= mau)); // DAU <= MAU
  assert.ok(byWeek.rows.every((r) => num(r.stickiness_active_users) <= mau)); // WAU <= MAU
});
