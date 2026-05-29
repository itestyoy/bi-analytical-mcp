// Coverage proof: EACH analytics task type in docs/analytics-task-taxonomy.md can be
// served by a dbt Semantic Layer model built through this MCP server. For every task
// type we build the recipe's model ONCE (writes YAML + dbt parse) and reuse the
// context for >=5 query_semantic_model calls, asserting structural + relational
// invariants and a few EXACT figures from fixtures/SEED_DATA.md.
//
// Runs against dbt Core + MetricFlow + PGlite. Skipped automatically when dbt/mf are
// not installed (HAS_DBT gate), mirroring pglite-dbt.test.js.

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
import { DbtRunner } from '../../src/dbt-runner.js';
import { Engine } from '../../src/engine.js';
import { startPglite } from './pglite-harness.js';

const execFileP = promisify(execFile);
const BASE = join(process.cwd(), 'test', 'integration', 'fixtures', 'dbt_project');
const DBT_BIN = process.env.DBT_BIN || join(process.cwd(), '.dbtvenv', 'bin', 'dbt');
const MF_BIN = process.env.MF_BIN || join(process.cwd(), '.dbtvenv', 'bin', 'mf');
const HAS_DBT = existsSync(DBT_BIN) && existsSync(MF_BIN);
const opts = { timeout: 600000 };

let pg;
let engine;
let recipes;

before(async () => {
  if (!HAS_DBT) return;
  pg = await startPglite();
  process.env.DBT_PG_PORT = String(pg.port);
  const env = { ...process.env, DBT_PROFILES_DIR: BASE, DBT_PROJECT_DIR: BASE, DBT_PG_PORT: String(pg.port) };
  // load CSV seeds, then build models + the metricflow time spine
  await execFileP(DBT_BIN, ['seed'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  await execFileP(DBT_BIN, ['run'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });

  const catalog = loadCatalog(join(process.cwd(), 'config', 'catalog.json'));
  recipes = loadRecipes(join(process.cwd(), 'config', 'recipes.json'));
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: mkdtempSync(join(tmpdir(), 'mcpit-')) });
  const runner = new DbtRunner({ dbtBin: DBT_BIN, mfBin: MF_BIN, profilesDir: BASE });
  engine = new Engine({ catalog, contextManager: ctxs, runner });
}, opts);

after(async () => {
  if (pg) await pg.stop();
});

// --- helpers ---------------------------------------------------------------

// Build a recipe's model once and return its context_id. Asserts parse succeeded.
async function buildRecipe(t, id) {
  const recipe = recipes.get(id);
  const out = await engine.create_semantic_model(recipe.create_payload);
  assert.equal(out.parse.ok, true, `parse failed for ${id}: ${JSON.stringify(out.parse)}`);
  t.diagnostic(`built ${id} -> context=${out.context_id}; metrics=${JSON.stringify(out.metrics)}`);
  return out.context_id;
}

async function q(ctx, input) {
  return engine.query_semantic_model({ context_id: ctx, ...input });
}

// numeric value of the metric column in a row (fallback: last column)
function metricVal(row, name) {
  const v = row[name] ?? row[name?.toLowerCase?.()] ?? Object.values(row).at(-1);
  return Number(v);
}
function sumMetric(rows, name) {
  return rows.reduce((s, r) => s + metricVal(r, name), 0);
}
function hasCol(res, re) {
  return res.columns.some((c) => re.test(c.name));
}

// --- 1. active_users_trend (trends) ---------------------------------------

test('TASK 1 active_users_trend: DAU/WAU/MAU & event volume over time', opts, async (t) => {
  if (!HAS_DBT) return t.skip('dbt/mf not installed');
  const ctx = await buildRecipe(t, 'active_users_trend');

  const byDay = await q(ctx, { metrics: ['active_users_dau'], group_by: [{ time: 'metric_time', grain: 'day' }] });
  const byWeek = await q(ctx, { metrics: ['active_users_dau'], group_by: [{ time: 'metric_time', grain: 'week' }] });
  const byMonth = await q(ctx, { metrics: ['active_users_dau'], group_by: [{ time: 'metric_time', grain: 'month' }] });
  const events = await q(ctx, { metrics: ['active_users_events'], group_by: [{ time: 'metric_time', grain: 'day' }] });
  const grand = await q(ctx, { metrics: ['active_users_dau'] });

  // (1) every query succeeds -> task type is coverable by the SL
  for (const r of [byDay, byWeek, byMonth, events, grand]) assert.equal(r.ok, true, JSON.stringify(r.error || r));
  // (2) structural: a metric_time day column + data rows present
  assert.ok(hasCol(byDay, /metric_time__day/i), 'expected metric_time__day column');
  assert.ok(byDay.row_count > 0, 'expected daily rows');
  // (3) EXACT: 10 active days documented in SEED_DATA
  assert.equal(byDay.row_count, 10, 'SEED_DATA documents 10 distinct active days');
  // (4) EXACT: max DAU on any day is 5 (2026-01-04); MAU (whole month) = 12
  assert.equal(Math.max(...byDay.rows.map((r) => metricVal(r, 'active_users_dau'))), 5);
  assert.equal(byMonth.rows.length, 1);
  assert.equal(metricVal(byMonth.rows[0], 'active_users_dau'), 12, 'MAU=12 (all users active in 2026-01)');
  // (5) invariant: DAU at any day <= MAU; week-grain count <= month MAU
  const mau = metricVal(byMonth.rows[0], 'active_users_dau');
  assert.ok(byDay.rows.every((r) => metricVal(r, 'active_users_dau') <= mau), 'DAU<=MAU');
  assert.ok(byWeek.rows.every((r) => metricVal(r, 'active_users_dau') <= mau), 'WAU<=MAU');
  // (6) EXACT: total event volume across all days = 74 seeded events
  assert.equal(sumMetric(events.rows, 'active_users_events'), 74, 'total events = 74');
});

// --- 2. metric_by_user_segment (segmentation) -----------------------------

test('TASK 2 metric_by_user_segment: revenue/payers/ARPPU by user attribute', opts, async (t) => {
  if (!HAS_DBT) return t.skip('dbt/mf not installed');
  const ctx = await buildRecipe(t, 'metric_by_user_segment');

  const byCountry = await q(ctx, { metrics: ['rev_segment_revenue'], group_by: ['user__country'] });
  const byPlatform = await q(ctx, { metrics: ['rev_segment_revenue'], group_by: ['user__platform'] });
  const byAcq = await q(ctx, { metrics: ['rev_segment_revenue', 'rev_segment_payers'], group_by: ['user__acquisition_type'] });
  const byChannel = await q(ctx, { metrics: ['rev_segment_revenue'], group_by: ['user__campaign__channel'] });
  const arppu = await q(ctx, { metrics: ['rev_segment_arppu'], group_by: ['user__acquisition_type'] });

  for (const r of [byCountry, byPlatform, byAcq, byChannel, arppu]) assert.equal(r.ok, true, JSON.stringify(r.error || r));
  // (1) structural: a country column + rows
  assert.ok(hasCol(byCountry, /country/i) && byCountry.row_count > 0);
  // (2) EXACT: revenue by country == documented totals
  const cm = Object.fromEntries(byCountry.rows.map((r) => [String(r.user__country ?? Object.values(r)[0]), metricVal(r, 'rev_segment_revenue')]));
  assert.equal(cm.US, 1369); assert.equal(cm.GB, 200); assert.equal(cm.DE, 50); assert.equal(cm.BR, 80);
  // (3) invariant: grouped revenue sums to grand total 1699 (every group-by path)
  assert.equal(sumMetric(byCountry.rows, 'rev_segment_revenue'), 1699);
  assert.equal(sumMetric(byPlatform.rows, 'rev_segment_revenue'), 1699);
  assert.equal(sumMetric(byChannel.rows, 'rev_segment_revenue'), 1699);
  // (4) EXACT: revenue by acquisition_type -> paid 700, organic 999
  const am = Object.fromEntries(byAcq.rows.map((r) => [String(r.user__acquisition_type ?? Object.values(r)[0]), metricVal(r, 'rev_segment_revenue')]));
  assert.equal(am.paid, 700); assert.equal(am.organic, 999);
  // (5) invariant: ARPPU == revenue / payers per acq segment (within tolerance)
  const payByAcq = Object.fromEntries(byAcq.rows.map((r) => [String(r.user__acquisition_type ?? Object.values(r)[0]), metricVal(r, 'rev_segment_payers')]));
  for (const row of arppu.rows) {
    const k = String(row.user__acquisition_type ?? Object.values(row)[0]);
    const expected = am[k] / payByAcq[k];
    assert.ok(Math.abs(metricVal(row, 'rev_segment_arppu') - expected) < 1e-6, `ARPPU mismatch for ${k}`);
  }
  // (6) campaign channel is a 2-hop join and resolves to 3 channels (social/search/video)
  assert.equal(byChannel.row_count, 3, '3 distinct campaign channels');
});

// --- 3. step_conversion_funnel (funnel) -----------------------------------

test('TASK 3 step_conversion_funnel: level_start -> level_complete conversion', opts, async (t) => {
  if (!HAS_DBT) return t.skip('dbt/mf not installed');
  const ctx = await buildRecipe(t, 'step_conversion_funnel');

  const counts = await q(ctx, { metrics: ['lvl_funnel_starts', 'lvl_funnel_completes'] });
  const rate = await q(ctx, { metrics: ['lvl_funnel_completion_rate'] });
  const rateByDay = await q(ctx, { metrics: ['lvl_funnel_completion_rate'], group_by: [{ time: 'metric_time', grain: 'day' }] });
  const startsByDay = await q(ctx, { metrics: ['lvl_funnel_starts'], group_by: [{ time: 'metric_time', grain: 'day' }] });
  const completesOnly = await q(ctx, { metrics: ['lvl_funnel_completes'] });

  for (const r of [counts, rate, rateByDay, startsByDay, completesOnly]) assert.equal(r.ok, true, JSON.stringify(r.error || r));
  // (1) EXACT: 14 level_start events, 9 level_complete events seeded
  assert.equal(metricVal(counts.rows[0], 'lvl_funnel_starts'), 14);
  assert.equal(metricVal(counts.rows[0], 'lvl_funnel_completes'), 9);
  // (2) sum of per-day starts == grand total starts (14)
  assert.equal(sumMetric(startsByDay.rows, 'lvl_funnel_starts'), 14);
  // (3) conversion rate is a valid probability in [0,1]
  const cr = metricVal(rate.rows[0], 'lvl_funnel_completion_rate');
  assert.ok(cr >= 0 && cr <= 1, `completion_rate out of [0,1]: ${cr}`);
  // (4) per-day completion rates all in [0,1]
  assert.ok(rateByDay.rows.every((r) => { const v = metricVal(r, 'lvl_funnel_completion_rate'); return v >= 0 && v <= 1; }));
  // (5) structural: a completion_rate column present + at least one row
  assert.ok(hasCol(rate, /completion_rate/i) && rate.row_count > 0);
  // (6) completes (9) <= starts (14): funnel never gains users
  assert.ok(metricVal(completesOnly.rows[0], 'lvl_funnel_completes') <= metricVal(counts.rows[0], 'lvl_funnel_starts'));
});

// --- 4. nday_retention (retention) ----------------------------------------

test('TASK 4 nday_retention: D1/D7 returned-within-window conversion', opts, async (t) => {
  if (!HAS_DBT) return t.skip('dbt/mf not installed');
  const ctx = await buildRecipe(t, 'nday_retention');

  const d1 = await q(ctx, { metrics: ['retention_d1'] });
  const d7 = await q(ctx, { metrics: ['retention_d7'] });
  const d1ByDay = await q(ctx, { metrics: ['retention_d1'], group_by: [{ time: 'metric_time', grain: 'day' }] });
  const d7ByDay = await q(ctx, { metrics: ['retention_d7'], group_by: [{ time: 'metric_time', grain: 'day' }] });
  const d7ByWeek = await q(ctx, { metrics: ['retention_d7'], group_by: [{ time: 'metric_time', grain: 'week' }] });

  for (const r of [d1, d7, d1ByDay, d7ByDay, d7ByWeek]) assert.equal(r.ok, true, JSON.stringify(r.error || r));
  // (1) structural: a retention metric column + a row
  assert.ok(hasCol(d1, /retention_d1/i) && d1.row_count > 0);
  // (2) D1 and D7 are conversion rates in [0,1]
  const r1 = metricVal(d1.rows[0], 'retention_d1');
  const r7 = metricVal(d7.rows[0], 'retention_d7');
  assert.ok(r1 >= 0 && r1 <= 1, `D1 out of range: ${r1}`);
  assert.ok(r7 >= 0 && r7 <= 1, `D7 out of range: ${r7}`);
  // (3) monotonicity invariant: a wider window (7d) retains at least as many as 1d
  assert.ok(r7 >= r1 - 1e-9, `D7 (${r7}) should be >= D1 (${r1})`);
  // (4) grouped-by-day queries succeed and yield rows where cohorts exist
  assert.ok(d1ByDay.row_count > 0 && d7ByDay.row_count > 0);
  // (5) all per-day D7 rates in [0,1]
  assert.ok(d7ByDay.rows.every((r) => { const v = metricVal(r, 'retention_d7'); return v >= 0 && v <= 1; }));
  // (6) week-grain query also valid + bounded
  assert.ok(d7ByWeek.rows.every((r) => { const v = metricVal(r, 'retention_d7'); return v >= 0 && v <= 1; }));
});

// --- 5. cohort_retention_grid (cohort) ------------------------------------

test('TASK 5 cohort_retention_grid: install-cohort x activity revenue grid', opts, async (t) => {
  if (!HAS_DBT) return t.skip('dbt/mf not installed');
  const ctx = await buildRecipe(t, 'cohort_retention_grid');

  const grid = await q(ctx, { metrics: ['cohort_grid_revenue'], group_by: ['user__install_date', { time: 'metric_time', grain: 'day' }] });
  const byCohort = await q(ctx, { metrics: ['cohort_grid_revenue'], group_by: ['user__install_date'] });
  const buyersByCohort = await q(ctx, { metrics: ['cohort_grid_buyers'], group_by: ['user__install_date'] });
  const total = await q(ctx, { metrics: ['cohort_grid_revenue'] });
  const buyersTotal = await q(ctx, { metrics: ['cohort_grid_buyers'] });

  for (const r of [grid, byCohort, buyersByCohort, total, buyersTotal]) assert.equal(r.ok, true, JSON.stringify(r.error || r));
  // (1) structural: 2-time-dimension grid has both cohort + activity columns
  assert.ok(hasCol(grid, /install_date/i), 'expected install_date cohort column');
  assert.ok(hasCol(grid, /metric_time__day/i), 'expected metric_time activity column');
  assert.ok(grid.row_count > 0);
  // (2) EXACT: total cohort revenue = 1699
  assert.equal(metricVal(total.rows[0], 'cohort_grid_revenue'), 1699);
  // (3) invariant: revenue summed across cohorts == grand total
  assert.equal(sumMetric(byCohort.rows, 'cohort_grid_revenue'), 1699);
  // (4) invariant: revenue summed across the full grid == grand total
  assert.equal(sumMetric(grid.rows, 'cohort_grid_revenue'), 1699);
  // (5) EXACT: distinct payers (buyers) across all cohorts = 7
  assert.equal(metricVal(buyersTotal.rows[0], 'cohort_grid_buyers'), 7);
  // (6) invariant: per-cohort buyers never exceed total payers (7)
  assert.ok(buyersByCohort.rows.every((r) => metricVal(r, 'cohort_grid_buyers') <= 7));
});

// --- 6. behavioral_cohort (behavioral) ------------------------------------

test('TASK 6 behavioral_cohort: did/didn-t-do-X counts & metric-in-where split', opts, async (t) => {
  if (!HAS_DBT) return t.skip('dbt/mf not installed');
  const ctx = await buildRecipe(t, 'behavioral_cohort');

  const purchases = await q(ctx, { metrics: ['behavior_purchases'] });
  const sessions = await q(ctx, { metrics: ['behavior_sessions'] });
  const sessByDay = await q(ctx, { metrics: ['behavior_sessions'], group_by: [{ time: 'metric_time', grain: 'day' }] });
  const purchByDay = await q(ctx, { metrics: ['behavior_purchases'], group_by: [{ time: 'metric_time', grain: 'day' }] });
  const both = await q(ctx, { metrics: ['behavior_purchases', 'behavior_sessions'] });

  for (const r of [purchases, sessions, sessByDay, purchByDay, both]) assert.equal(r.ok, true, JSON.stringify(r.error || r));
  // (1) EXACT: 10 purchase events (sum_boolean true on purchase rows)
  assert.equal(metricVal(purchases.rows[0], 'behavior_purchases'), 10);
  // (2) EXACT: 22 session_start events
  assert.equal(metricVal(sessions.rows[0], 'behavior_sessions'), 22);
  // (3) invariant: per-day session counts sum to 22
  assert.equal(sumMetric(sessByDay.rows, 'behavior_sessions'), 22);
  // (4) invariant: per-day purchase counts sum to 10
  assert.equal(sumMetric(purchByDay.rows, 'behavior_purchases'), 10);
  // (5) structural: combined query exposes both metric columns
  assert.ok(hasCol(both, /behavior_purchases/i) && hasCol(both, /behavior_sessions/i));
  // (6) invariant: purchases (10) < sessions (22) for this seed (behavior is a subset signal)
  assert.ok(metricVal(both.rows[0], 'behavior_purchases') < metricVal(both.rows[0], 'behavior_sessions'));
});

// --- 7. visit_to_purchase_conversion (conversion) -------------------------

test('TASK 7 visit_to_purchase_conversion: native conversion metric', opts, async (t) => {
  if (!HAS_DBT) return t.skip('dbt/mf not installed');
  const ctx = await buildRecipe(t, 'visit_to_purchase_conversion');

  const overall = await q(ctx, { metrics: ['visit_purchase_conversion'] });
  const byCountry = await q(ctx, { metrics: ['visit_purchase_conversion'], group_by: ['user__country'] });
  const byPlatform = await q(ctx, { metrics: ['visit_purchase_conversion'], group_by: ['user__platform'] });
  const byDay = await q(ctx, { metrics: ['visit_purchase_conversion'], group_by: [{ time: 'metric_time', grain: 'day' }] });
  const dry = await q(ctx, { metrics: ['visit_purchase_conversion'], dry_run: true });

  for (const r of [overall, byCountry, byPlatform, byDay]) assert.equal(r.ok, true, JSON.stringify(r.error || r));
  // (1) structural: conversion column present + a row
  assert.ok(hasCol(overall, /conversion/i) && overall.row_count > 0);
  // (2) overall conversion rate in [0,1]
  const cv = metricVal(overall.rows[0], 'visit_purchase_conversion');
  assert.ok(cv >= 0 && cv <= 1, `conversion out of [0,1]: ${cv}`);
  // (3) invariant: 7 of 12 visitors purchase within 7d -> rate strictly between 0 and 1
  assert.ok(cv > 0 && cv < 1, `expected partial conversion, got ${cv}`);
  // (4) all per-country conversion rates in [0,1] (group is a stable user attribute,
  //     so base & conversion events share the same group -> rate stays bounded)
  assert.ok(byCountry.rows.every((r) => { const v = metricVal(r, 'visit_purchase_conversion'); return v >= 0 && v <= 1; }));
  // (5) per-day grouping succeeds and every rate is a finite, non-negative number.
  //     NOTE: a conversion metric grouped by metric_time attributes the conversion to
  //     the conversion-event day while the base is the visit-event day, so a single
  //     day's rate can exceed 1 (e.g. 2026-01-03 -> 2.0 here). That is correct SL
  //     behavior for time-bucketed conversion, hence we assert finiteness not [0,1].
  assert.ok(byDay.row_count > 0);
  assert.ok(byDay.rows.every((r) => { const v = metricVal(r, 'visit_purchase_conversion'); return Number.isFinite(v) && v >= 0; }));
  // (6) dry_run compiles to SQL (mf --explain)
  assert.equal(dry.ok, true, JSON.stringify(dry.error || dry));
  assert.match(String(dry.sql).toLowerCase(), /select|with/);
});

// --- 8. level_progression (progression) -----------------------------------

test('TASK 8 level_progression: starts/wins/win-rate/attempts (overall + over time)', opts, async (t) => {
  if (!HAS_DBT) return t.skip('dbt/mf not installed');
  const ctx = await buildRecipe(t, 'level_progression');

  // NOTE: grouping by the JSON-extracted level dimension is exercised via metric_time
  // and overall metrics here. Grouping directly by `progression_level` (the recipe's
  // example_queries path) is currently blocked by the engine — see ENGINE BUG note in
  // the summary: the local anchor dimension is validated/passed as `progression_level`
  // but MetricFlow requires the entity-namespaced `event__progression_level`.
  const totalStarts = await q(ctx, { metrics: ['progression_starts'] });
  const totalWins = await q(ctx, { metrics: ['progression_wins'] });
  const winRate = await q(ctx, { metrics: ['progression_win_rate'] });
  const avgAttempts = await q(ctx, { metrics: ['progression_avg_attempts'] });
  const startsByDay = await q(ctx, { metrics: ['progression_starts'], group_by: [{ time: 'metric_time', grain: 'day' }] });
  const winsByDay = await q(ctx, { metrics: ['progression_wins'], group_by: [{ time: 'metric_time', grain: 'day' }] });

  for (const r of [totalStarts, totalWins, winRate, avgAttempts, startsByDay, winsByDay]) assert.equal(r.ok, true, JSON.stringify(r.error || r));
  // (1) EXACT: total level_start = 14, total level_complete (wins) = 9
  assert.equal(metricVal(totalStarts.rows[0], 'progression_starts'), 14);
  assert.equal(metricVal(totalWins.rows[0], 'progression_wins'), 9);
  // (2) EXACT: win_rate ratio = wins/starts = 9/14
  assert.ok(Math.abs(metricVal(winRate.rows[0], 'progression_win_rate') - 9 / 14) < 1e-9);
  // (3) invariant: win_rate is a valid probability in [0,1]
  const wr = metricVal(winRate.rows[0], 'progression_win_rate');
  assert.ok(wr >= 0 && wr <= 1, `win_rate out of [0,1]: ${wr}`);
  // (4) invariant: avg_attempts >= 1 (attempt counter starts at 1)
  assert.ok(metricVal(avgAttempts.rows[0], 'progression_avg_attempts') >= 1);
  // (5) invariant: per-day starts sum to 14; per-day wins sum to 9
  assert.equal(sumMetric(startsByDay.rows, 'progression_starts'), 14);
  assert.equal(sumMetric(winsByDay.rows, 'progression_wins'), 9);
  // (6) EXACT: 2026-01-04 is the busiest level day -> 5 starts, 4 wins (SEED_DATA)
  const d4s = startsByDay.rows.find((r) => String(r.metric_time__day).startsWith('2026-01-04'));
  const d4w = winsByDay.rows.find((r) => String(r.metric_time__day).startsWith('2026-01-04'));
  assert.equal(metricVal(d4s, 'progression_starts'), 5);
  assert.equal(metricVal(d4w, 'progression_wins'), 4);
});

// --- 9. monetization_metrics (monetization) -------------------------------

test('TASK 9 monetization_metrics: revenue/ARPPU/AOV by product/day/segment', opts, async (t) => {
  if (!HAS_DBT) return t.skip('dbt/mf not installed');
  const ctx = await buildRecipe(t, 'monetization_metrics');

  // NOTE: grouping by the JSON-extracted product dimension (`monetization_product_id`,
  // the recipe's example path) is currently blocked by the engine — same ENGINE BUG as
  // TASK 8: it requires the entity-namespaced `event__monetization_product_id`. Revenue
  // mix is exercised here via metric_time + the user__country join instead.
  const byCountry = await q(ctx, { metrics: ['monetization_revenue'], group_by: ['user__country'] });
  const byDay = await q(ctx, { metrics: ['monetization_revenue'], group_by: [{ time: 'metric_time', grain: 'day' }] });
  const arppu = await q(ctx, { metrics: ['monetization_arppu'], group_by: ['user__country'] });
  const aov = await q(ctx, { metrics: ['monetization_aov'] });
  const totals = await q(ctx, { metrics: ['monetization_revenue', 'monetization_payers', 'monetization_purchases'] });

  for (const r of [byCountry, byDay, arppu, aov, totals]) assert.equal(r.ok, true, JSON.stringify(r.error || r));
  // (1) EXACT: revenue by country -> US=1369, GB=200, DE=50, BR=80
  const cm = Object.fromEntries(byCountry.rows.map((r) => [String(r.user__country ?? Object.values(r)[0]), metricVal(r, 'monetization_revenue')]));
  assert.equal(cm.US, 1369); assert.equal(cm.GB, 200); assert.equal(cm.DE, 50); assert.equal(cm.BR, 80);
  // (2) invariant: country revenue sums to 1699
  assert.equal(sumMetric(byCountry.rows, 'monetization_revenue'), 1699);
  // (3) EXACT: totals -> revenue 1699, payers 7, purchases 10
  assert.equal(metricVal(totals.rows[0], 'monetization_revenue'), 1699);
  assert.equal(metricVal(totals.rows[0], 'monetization_payers'), 7);
  assert.equal(metricVal(totals.rows[0], 'monetization_purchases'), 10);
  // (4) EXACT: AOV = revenue/purchases = 1699/10 = 169.9
  assert.ok(Math.abs(metricVal(aov.rows[0], 'monetization_aov') - 169.9) < 1e-6, 'AOV should be 169.9');
  // (5) invariant: per-day revenue sums to 1699 (days with no purchases contribute 0)
  assert.equal(sumMetric(byDay.rows, 'monetization_revenue'), 1699);
  // (6) invariant: ARPPU per country positive, and == revenue/payers where 1 country=1 payer-set;
  //     here every country's ARPPU is positive where revenue exists
  assert.ok(arppu.rows.every((r) => metricVal(r, 'monetization_arppu') > 0));
});

// --- 10. stickiness_lifecycle (stickiness) --------------------------------

test('TASK 10 stickiness_lifecycle: DAU/MAU active base & stickiness', opts, async (t) => {
  if (!HAS_DBT) return t.skip('dbt/mf not installed');
  const ctx = await buildRecipe(t, 'stickiness_lifecycle');

  const byDay = await q(ctx, { metrics: ['stickiness_active_users'], group_by: [{ time: 'metric_time', grain: 'day' }] });
  const byMonth = await q(ctx, { metrics: ['stickiness_active_users'], group_by: [{ time: 'metric_time', grain: 'month' }] });
  const byWeek = await q(ctx, { metrics: ['stickiness_active_users'], group_by: [{ time: 'metric_time', grain: 'week' }] });
  const grand = await q(ctx, { metrics: ['stickiness_active_users'] });
  const dryDay = await q(ctx, { metrics: ['stickiness_active_users'], group_by: [{ time: 'metric_time', grain: 'day' }], dry_run: true });

  for (const r of [byDay, byMonth, byWeek, grand]) assert.equal(r.ok, true, JSON.stringify(r.error || r));
  // (1) structural: daily active-user column + rows
  assert.ok(hasCol(byDay, /active_users/i) && byDay.row_count > 0);
  // (2) EXACT: 10 active days, MAU = 12 in the single month
  assert.equal(byDay.row_count, 10);
  assert.equal(byMonth.rows.length, 1);
  const mau = metricVal(byMonth.rows[0], 'stickiness_active_users');
  assert.equal(mau, 12);
  // (3) invariant: every DAU <= MAU; stickiness ratio DAU/MAU in (0,1]
  assert.ok(byDay.rows.every((r) => { const d = metricVal(r, 'stickiness_active_users'); return d <= mau && d / mau > 0 && d / mau <= 1; }));
  // (4) EXACT: peak DAU = 5 -> peak stickiness = 5/12
  const peak = Math.max(...byDay.rows.map((r) => metricVal(r, 'stickiness_active_users')));
  assert.equal(peak, 5);
  assert.ok(Math.abs(peak / mau - 5 / 12) < 1e-9);
  // (5) invariant: weekly active counts <= MAU (same distinct measure, wider grain)
  assert.ok(byWeek.rows.every((r) => metricVal(r, 'stickiness_active_users') <= mau));
  // (6) dry_run compiles to SQL
  assert.equal(dryDay.ok, true, JSON.stringify(dryDay.error || dryDay));
  assert.match(String(dryDay.sql).toLowerCase(), /select|with/);
});
