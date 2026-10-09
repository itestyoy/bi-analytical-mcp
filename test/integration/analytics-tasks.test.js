// Coverage proof: EACH analytics task family in config/recipes.json can be served
// by a dbt Semantic Layer model built through this engine. For every family we
// build the recipe's model ONCE via engine._recipe(id).semantic_payload (writes
// YAML + dbt parse), then run several query_semantic_model calls and assert on
// DATA: res.ok === true plus EXACT figures from fixtures/SEED_DATA.md and
// invariants (grouped sum == grand total; rate in [0,1]; DAU <= MAU; completers
// <= starters). >= 5 data assertions per family.
//
// Only the two documented data sources exist (events fact + user attributes);
// joins are 1-hop events.user -> dim_users. NO text/SQL/command assertions.
//
// Runs against dbt Core + MetricFlow + DuckDB. Auto-skips when dbt/mf are not
// installed (HAS_DBT gate).

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
import { settle, startAndBuild } from '../helpers/settle.js';
import { DBT_BIN, HAS_DBT, testDbt } from '../helpers/dbt-env.js';

const execFileP = promisify(execFile);
const BASE = fixtureProject('dbt_project'); // a private copy: the test files run side by side
const opts = { timeout: 600000 };

let wh;
let engine;

const num = (v) => Number(v === '' || v == null ? NaN : v);
const sumCol = (rows, col) => rows.reduce((s, r) => s + (Number.isFinite(num(r[col])) ? num(r[col]) : 0), 0);
const mapCol = (rows, keyCol, valCol) => Object.fromEntries(rows.map((r) => [String(r[keyCol]), num(r[valCol])]));

before(async () => {
  if (!HAS_DBT) return;
  wh = await startWarehouse();
  const env = { ...process.env, DBT_PROFILES_DIR: BASE, DBT_PROJECT_DIR: BASE, DUCKDB_PATH: wh.path };
  await execFileP(DBT_BIN, ['seed'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  await execFileP(DBT_BIN, ['run'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });

  const catalog = loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), { profilesDir: BASE, projectDir: BASE });
  const recipes = loadRecipes(join(process.cwd(), 'config', 'recipes.json'));
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: mkdtempSync(join(tmpdir(), 'at-')), timeSpineDialect: 'duckdb' });
  const runner = testDbt({ profilesDir: BASE });
  engine = settle(new Engine({ catalog, contextManager: ctxs, runner, recipes }));
}, opts);

after(async () => { engine?.runner?.close?.(); if (wh) await wh.stop(); });
const skip = (t) => { if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; } return false; };

// Build a recipe's model once via the published _recipe payload.
async function buildRecipe(t, id) {
  const out = await engine.build_semantic_model(engine._recipe({ id }).semantic_payload);
  assert.equal(out.parse.ok, true, `parse failed for ${id}: ${JSON.stringify(out.parse.error || out.parse)}`);
  return out.context_id;
}
const q = (ctx, input) => engine.query_semantic_model({ context_id: ctx, ...input });

// ── 1. metric_types: measure_over_metric_time ────────────────────────────────
// #6: a numeric value that arrives as STRING is aggregable via cast:numeric.
test('TASK cast: sum/avg a STRING-numeric property with cast:numeric', opts, async (t) => {
  if (skip(t)) return;
  const out = await engine.build_semantic_model({
    name: 'castq',
    semantic_models: [{ from: 'events', measures: [{ name: 'sum_ct', agg: 'sum', field: 'complete_time_of_event_data', cast: 'numeric' }, { name: 'avg_ct', agg: 'average', field: 'complete_time_of_event_data', cast: 'numeric' }], where: [{ field: 'event_name', op: 'eq', value: 'level_completed' }] }],
    metrics: [
      { name: 'sum_ct', type: 'simple', measure: 'sum_ct' },
      { name: 'avg_ct', type: 'simple', measure: 'avg_ct' },
    ],
  });
  assert.equal(out.parse.ok, true, JSON.stringify(out.parse.error || out.parse));
  const r = await q(out.context_id, { metrics: ['castq_sum_ct', 'castq_avg_ct'] });
  assert.equal(r.ok, true, JSON.stringify(r.error || r));
  assert.equal(num(r.rows[0].castq_sum_ct), 1263);            // exact Σ complete_time
  assert.ok(Math.abs(num(r.rows[0].castq_avg_ct) - 50.52) < 1e-6);
  // the same aggregation WITHOUT a cast is rejected (string is not numeric)
  await assert.rejects(engine.build_semantic_model({
    name: 'castbad',
    semantic_models: [{ from: 'events', measures: [{ name: 'bad', agg: 'average', field: 'complete_time_of_event_data' }], where: [{ field: 'event_name', op: 'eq', value: 'level_completed' }] }],
    metrics: [{ name: 'bad', type: 'simple', measure: 'bad' }],
  }), /not numeric|cast/i);
});

test('TASK measure_over_metric_time: DAU/WAU/MAU & event volume', opts, async (t) => {
  if (skip(t)) return;
  const ctx = await buildRecipe(t, 'measure_over_metric_time');
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

  // dry_run: the rendered SQL WITHOUT executing; the dataflow plan only with include_plan (feature/
  // lifecycle check — we assert the plan/SQL are PRESENT, not their content).
  const ex = await q(ctx, { metrics: ['active_users_dau'], group_by: [{ time: 'metric_time', grain: 'day' }], dry_run: true });
  assert.equal(ex.ok, true, JSON.stringify(ex.error || ex));
  assert.equal(ex.dry_run, true);
  assert.ok(typeof ex.sql === 'string' && ex.sql.length > 0);            // rendered SQL returned
  assert.equal(ex.plan, undefined, 'no plan unless asked for');
  const planned = await q(ctx, { metrics: ['active_users_dau'], group_by: [{ time: 'metric_time', grain: 'day' }], dry_run: true, include_plan: true });
  assert.ok(planned.plan && typeof planned.plan === 'object');           // plan object returned
  assert.ok(typeof planned.plan.dataflow_plan === 'string' && planned.plan.dataflow_plan.length > 0); // dataflow plan present
  await assert.rejects(() => q(ctx, { metrics: ['active_users_dau'], include_plan: true }), /include_plan goes with dry_run/);
  // a dry run stores nothing: materialize beside it is refused, not ignored
  await assert.rejects(() => q(ctx, { metrics: ['active_users_dau'], group_by: [{ time: 'metric_time', grain: 'day' }], dry_run: true, materialize: true }), /materialize goes with a query that runs/);

  // a dry run is compiled with the caller's own limit: its SQL, run as shown, returns that many rows
  // (it was compiled with the fetch size, one past the page); without a limit, every one of the 7 days
  const limited = await q(ctx, { metrics: ['active_users_dau'], group_by: [{ time: 'metric_time', grain: 'day' }], limit: 3, dry_run: true });
  assert.equal(limited.ok, true, JSON.stringify(limited.error || limited));
  assert.equal((await wh.query(limited.sql)).rows.length, 3);
  assert.equal((await wh.query(ex.sql)).rows.length, 7);

  // #4b: an order_by key is a result column's name — the day axis is metric_time_day; dry_run
  // surfaces the orderable keys; a key that is no result column (the bare `metric_time` too, which
  // with two grains in group_by named only one of them) is refused with the list.
  assert.ok(ex.orderable_keys.includes('metric_time_day') && ex.orderable_keys.includes('active_users_dau'), `orderable_keys: ${JSON.stringify(ex.orderable_keys)}`);
  const sorted = await q(ctx, { metrics: ['active_users_dau'], group_by: [{ time: 'metric_time', grain: 'day' }], order_by: [{ key: 'metric_time_day' }] });
  assert.equal(sorted.ok, true, JSON.stringify(sorted.error || sorted));
  assert.equal(sorted.row_count, 7); // same 7 days, in ascending order
  const at = sorted.rows.map((r) => new Date(r.metric_time_day).getTime());
  assert.deepEqual(at, [...at].sort((a, b) => a - b));
  await assert.rejects(() => q(ctx, { metrics: ['active_users_dau'], group_by: [{ time: 'metric_time', grain: 'day' }], order_by: [{ key: 'nonsense' }] }), /Orderable:/);
  await assert.rejects(() => q(ctx, { metrics: ['active_users_dau'], group_by: [{ time: 'metric_time', grain: 'day' }, { time: 'metric_time', grain: 'week' }], order_by: [{ key: 'metric_time' }] }), /Orderable: .*metric_time_day.*metric_time_week/);
  // a key is the result column it is handed as — the same 7 days, desc puts the latest first — never
  // the token the server resolves it to
  const byColumn = await q(ctx, { metrics: ['active_users_dau'], group_by: [{ time: 'metric_time', grain: 'day' }], order_by: [{ key: 'metric_time_day', direction: 'desc' }] });
  assert.equal(byColumn.row_count, 7);
  assert.deepEqual(byColumn.rows.map((r) => String(r.metric_time_day)), sorted.rows.map((r) => String(r.metric_time_day)).reverse());
  await assert.rejects(() => q(ctx, { metrics: ['active_users_dau'], group_by: [{ time: 'metric_time', grain: 'day' }], order_by: [{ key: 'metric_time__day' }] }), /Orderable:/);
});

// ── 2. joins: group_by_joined_attribute ──────────────────────────────────────
test('TASK group_by_joined_attribute: revenue/payers/ARPPU by user attribute (1-hop join)', opts, async (t) => {
  if (skip(t)) return;
  const ctx = await buildRecipe(t, 'group_by_joined_attribute');
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

// ── 3. metric_types: funnel_from_event_property_steps (event + step_id property value) ───
test('TASK funnel_from_event_property_steps: tutorial step_id drop-off 8 -> 5 -> 3', opts, async (t) => {
  if (skip(t)) return;
  const ctx = await buildRecipe(t, 'funnel_from_event_property_steps');
  const steps = await q(ctx, { metrics: ['tut_funnel_step1', 'tut_funnel_step2', 'tut_funnel_step3'] });
  const rates = await q(ctx, { metrics: ['tut_funnel_conv_1_2', 'tut_funnel_conv_2_3'] });
  for (const r of [steps, rates]) assert.equal(r.ok, true, JSON.stringify(r.error || r));
  const row = steps.rows[0];
  assert.equal(num(row.tut_funnel_step1), 8);                           // step_1 distinct users
  assert.equal(num(row.tut_funnel_step2), 5);                           // step_2
  assert.equal(num(row.tut_funnel_step3), 3);                           // step_3
  assert.ok(num(row.tut_funnel_step1) >= num(row.tut_funnel_step2) && num(row.tut_funnel_step2) >= num(row.tut_funnel_step3)); // monotonic
  // the step-to-step share: who reached the next step over who reached this one
  assert.ok(Math.abs(num(rates.rows[0].tut_funnel_conv_1_2) - 5 / 8) < 1e-9);
  assert.ok(Math.abs(num(rates.rows[0].tut_funnel_conv_2_3) - 3 / 5) < 1e-9);
});

// ── 4. pipeline: conversion_metric_window ───────────────────────────────────
// A conversion within a window is a pipeline (the semantic layer declares no conversion metric): one
// row per player from the first first_launch, the seconds to the next new_session of a later session, a
// conditional count per horizon. Proven against the same reading of the events written by hand.
test('TASK conversion_metric_window: a return (a second session) within 48h / 7×24h of the first launch', opts, async (t) => {
  if (skip(t)) return;
  const out = await startAndBuild(engine, engine._recipe({ id: 'conversion_metric_window' }).pipeline_payload);
  assert.equal(out.build?.ok, true, JSON.stringify(out.error || out.build));
  const { rows } = await wh.query(`
    with base as (select player_id_of_internal as p, min(device_time) as t from fct_analytics_events where event_name = 'first_launch' group by 1),
    back as (select base.p, min(epoch(e.device_time) - epoch(base.t)) as secs from base
             join fct_analytics_events e on e.player_id_of_internal = base.p and e.event_name = 'new_session' and e.session_number >= 2 and e.device_time > base.t group by 1)
    select (select count(*) from base) as cohort,
           (select count(*) from back where secs <= 172800) as back_2d,
           (select count(*) from back where secs <= 604800) as back_7d`);
  const want = rows[0];
  const got = out.rows[0];
  // the horizons split the cohort: some return within 48h, more within a week, not everyone
  assert.ok(num(want.back_2d) > 0 && num(want.back_7d) > num(want.back_2d) && num(want.cohort) > num(want.back_7d), JSON.stringify(want));
  assert.deepEqual([num(got.cohort), num(got.back_2d), num(got.back_7d)], [num(want.cohort), num(want.back_2d), num(want.back_7d)]);
  assert.ok(Math.abs(num(got.rate_2d) - num(want.back_2d) / num(want.cohort)) < 1e-9);
  assert.ok(Math.abs(num(got.rate_7d) - num(want.back_7d) / num(want.cohort)) < 1e-9);
});

// ── 5. joins: cohort_grid_two_time_axes (install_date x activity) ────────────
test('TASK cohort_grid_two_time_axes: install-cohort x activity revenue/buyers grid', opts, async (t) => {
  if (skip(t)) return;
  const ctx = await buildRecipe(t, 'cohort_grid_two_time_axes');
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

// ── 5b. a task's time dimension: what the catalog types as time is read at the declared grain ──
// users.install_date is a time column in the catalog. Declared on a task, it is a TIME dimension:
// at `grain` when one is given (week), at the catalog's own granularity (day) when not — the same
// rows as the users model's own install_date. The day cohorts summed by ISO week (Monday) are the
// week cohorts. The labels given go with the dimension, the measure and the metric.
test('a task dimension over a time column is read at its grain (week), or at the catalog\'s (day)', opts, async (t) => {
  if (skip(t)) return;
  const task = (name, dims) => engine.build_semantic_model({
    name,
    semantic_models: [{ from: 'events', measures: [{ name: 'n', agg: 'count', label: 'Events counted' }] }, { from: 'users', ...(dims ? { dimensions: dims } : {}) }],
    metrics: [{ name: 'n', type: 'simple', measure: 'n', label: 'Events' }],
  });
  const built = {};
  for (const [name, dims] of [['coh_wk', [{ field: 'install_date', grain: 'week', label: 'Install week' }]], ['coh_dy', [{ field: 'install_date' }]], ['coh_base', null]]) {
    const out = await task(name, dims);
    assert.equal(out.parse.ok, true, JSON.stringify(out.parse));
    built[name] = out.context_id;
  }
  const cohorts = async (name) => {
    const r = await q(built[name], { metrics: [`${name}_n`], group_by: [{ model: 'users', attribute: 'install_date' }] });
    assert.equal(r.ok, true, JSON.stringify(r.error || r));
    assert.ok(r.columns.some((c) => c.name === 'users_install_date'), `the column is named for the reference: ${JSON.stringify(r.columns)}`);
    return r.rows;
  };
  const day = (v) => (v == null ? null : new Date(v).toISOString().slice(0, 10));
  const byKey = (rows, name, key = day) => {
    const out = {};
    for (const r of rows) { const k = key(r.users_install_date); out[k] = (out[k] || 0) + num(r[`${name}_n`]); }
    return out;
  };
  const isoWeek = (v) => { if (v == null) return null; const d = new Date(v); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };

  const daily = byKey(await cohorts('coh_dy'), 'coh_dy');
  // no grain: the catalog's day — the users model's own install_date, the same rows
  assert.deepEqual(daily, byKey(await cohorts('coh_base'), 'coh_base'));
  assert.equal(Object.values(daily).reduce((a, b) => a + b, 0), 184, 'every event counted once');
  assert.equal(Object.keys(daily).filter((k) => k !== 'null').length, 5, 'five install days');
  // at a week: the day cohorts summed by ISO week, two weeks
  const weekly = byKey(await cohorts('coh_wk'), 'coh_wk');
  assert.deepEqual(weekly, byKey(await cohorts('coh_dy'), 'coh_dy', isoWeek));
  assert.equal(Object.keys(weekly).filter((k) => k !== 'null').length, 2, 'Jan 1-4 and Jan 5 2026 are two ISO weeks');
  // filtered on the same attribute: only the cohort of the week of Jan 5
  const late = await q(built.coh_wk, { metrics: ['coh_wk_n'], group_by: [{ model: 'users', attribute: 'install_date' }], where: [{ field: { model: 'users', attribute: 'install_date' }, op: 'gte', value: '2026-01-05' }] });
  assert.equal(late.ok, true, JSON.stringify(late.error || late));
  assert.deepEqual(byKey(late.rows, 'coh_wk'), { '2026-01-05': weekly['2026-01-05'] });

  // the labels went with what they were given on, into the layer dbt parsed
  const p = await engine.preview_semantic_model({ context_id: built.coh_wk });
  const users = p.semantic_models.find((sm) => sm.name === 'users');
  assert.equal(users.dimensions.find((d) => d.name === 'coh_wk_install_date').label, 'Install week');
  // (a measure is listed by the legacy spec; the latest spec has none — a simple metric carries its own)
  const measure = (p.semantic_models.find((sm) => sm.name === 'events').measures || []).find((m) => m.name === 'coh_wk_n');
  if (measure) assert.equal(measure.label, 'Events counted');
  assert.equal(p.metrics.find((m) => m.name === 'coh_wk_n').label, 'Events');
});

// ── 6. metric_types: boolean_condition_as_measure (did / didn't purchase) ────
test('TASK boolean_condition_as_measure: did/didn-t-purchase counts & Metric()-in-where split', opts, async (t) => {
  if (skip(t)) return;
  const ctx = await buildRecipe(t, 'boolean_condition_as_measure');
  const purchases = await q(ctx, { metrics: ['behavior_purchases'] });
  const sessions = await q(ctx, { metrics: ['behavior_sessions'] });
  const both = await q(ctx, { metrics: ['behavior_purchases', 'behavior_sessions'] });
  const sessByDay = await q(ctx, { metrics: ['behavior_sessions'], group_by: [{ time: 'metric_time', grain: 'day' }] });
  for (const r of [purchases, sessions, both, sessByDay]) assert.equal(r.ok, true, JSON.stringify(r.error || r));
  assert.equal(num(purchases.rows[0].behavior_purchases), 8);          // 8 completed purchases (a count with a where)
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

// ── 7. metric_types: agg_chosen_per_question (per level_id) ──────────────────
test('TASK agg_chosen_per_question: starts/completes/rate per level_id', opts, async (t) => {
  if (skip(t)) return;
  const ctx = await buildRecipe(t, 'agg_chosen_per_question');
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

// ── 8. metric_types: ratio_metric ────────────────────────────────────────────
test('TASK ratio_metric: revenue/ARPPU/AOV by product/day/segment', opts, async (t) => {
  if (skip(t)) return;
  const ctx = await buildRecipe(t, 'ratio_metric');
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

// ── 9. metric_types: payload_property_measure_and_dimension ──────────────────
test('TASK payload_property_measure_and_dimension: ad revenue & impressions by network/placement', opts, async (t) => {
  if (skip(t)) return;
  const ctx = await buildRecipe(t, 'payload_property_measure_and_dimension');
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

// ── 10. metric_types: two_event_scopes_and_a_net (coins in vs out) ───────────
test('TASK two_event_scopes_and_a_net: coins in (510) vs out (140) & source split', opts, async (t) => {
  if (skip(t)) return;
  const ctx = await buildRecipe(t, 'two_event_scopes_and_a_net');
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

// ── 11. metric_types: same_measure_two_grains (DAU/MAU) ──────────────────────
test('TASK same_measure_two_grains: DAU/MAU active base & stickiness', opts, async (t) => {
  if (skip(t)) return;
  const ctx = await buildRecipe(t, 'same_measure_two_grains');
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
