// Coverage proof: EACH analytics task family in config/recipes.json can be served
// by a dbt Semantic Layer model built through this engine. For every family we
// build the recipe's model ONCE via engine._recipe(id).semantic_payload (writes
// YAML + dbt parse), then run several query_model calls and assert on
// DATA: res.ok === true plus EXACT figures from fixtures/SEED_DATA.md and
// invariants (grouped sum == grand total; rate in [0,1]; DAU <= MAU; completers
// <= starters). >= 5 data assertions per family. Metrics a question reads side by side are asked
// in ONE query (one mf call), each check with a message naming it.
//
// This file is the one home of the semantic monetization / progression / funnel / DAU numbers: the
// platform and country cuts and the per-level progression of the behavior funnels are asserted here
// ('[behavior: …]'), as is the tutorial step funnel, and the cumulative metric over a partitioned
// source (11.) shares its warehouse. Each recipe it builds is listed in
// test/helpers/recipe-coverage.js, so the recipe loop of model-results.test.js does not run that
// recipe again.
//
// Only the two documented data sources exist (events fact + user attributes);
// joins are 1-hop events.user -> dim_users. NO text/SQL/command assertions.
//
// Runs against dbt Core + MetricFlow + DuckDB. Auto-skips when dbt/mf are not
// installed (HAS_DBT gate).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadCatalog } from '../../src/catalog.js';
import { loadRecipes } from '../../src/recipes.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { buildWarehouse, fixtureProject } from './warehouse-harness.js';
import { settle, startAndBuild, taskResult } from '../helpers/settle.js';
import { HAS_DBT, testDbt } from '../helpers/dbt-env.js';
import { tempDir } from '../helpers/temp-dir.js';
import { declare } from '../helpers/declare.js';

const BASE = fixtureProject('dbt_project'); // a private copy: the test files run side by side
const opts = { timeout: 600000 };

let wh;
let engine;

const num = (v) => Number(v === '' || v == null ? NaN : v);
const sumCol = (rows, col) => rows.reduce((s, r) => s + (Number.isFinite(num(r[col])) ? num(r[col]) : 0), 0);
const mapCol = (rows, keyCol, valCol) => Object.fromEntries(rows.map((r) => [String(r[keyCol]), num(r[valCol])]));
/** The sum of a measure per value of ONE group column of a result grouped by several (NaN where no row has a value). */
const marginal = (rows, keyCol, valCol) => {
  const out = {};
  for (const r of rows) {
    const k = String(r[keyCol]);
    const v = num(r[valCol]);
    if (!(k in out)) out[k] = NaN;
    if (Number.isFinite(v)) out[k] = (Number.isFinite(out[k]) ? out[k] : 0) + v;
  }
  return out;
};

before(async () => {
  if (!HAS_DBT) return;
  wh = await buildWarehouse(BASE); // the run's one build of the fixture, copied

  const catalog = loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), { profilesDir: BASE, projectDir: BASE });
  const recipes = loadRecipes(join(process.cwd(), 'config', 'recipes.json'));
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: tempDir('at'), timeSpineDialect: 'duckdb' });
  const runner = testDbt({ profilesDir: BASE });
  engine = settle(new Engine({ catalog, contextManager: ctxs, runner, recipes }));
}, opts);

after(async () => { engine?.runner?.close?.(); if (wh) await wh.stop(); });
const skip = (t) => { if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; } return false; };

// Build a recipe's model once via the published _recipe payload.
async function buildRecipe(t, id) {
  const out = await declare(engine, engine._recipe({ id }).semantic_payload);
  assert.equal(out.parse.ok, true, `parse failed for ${id}: ${JSON.stringify(out.parse.error || out.parse)}`);
  return out.context_id;
}
const q = (ctx, input) => engine.query_model({ context_id: ctx, ...input });

// ── 1. metric_types: measure_over_metric_time ────────────────────────────────
// #6: a numeric value that arrives as STRING is aggregable once it is read as a number (cast).
test('TASK cast: sum/avg a STRING-numeric property read as numeric (cast)', opts, async (t) => {
  if (skip(t)) return;
  const out = await declare(engine, {
    name: 'castq',
    semantic_models: [{ source: 'events', measures: [{ name: 'sum_ct', expr: { fn: 'sum', args: [{ fn: 'cast', args: [{ property: 'complete_time_of_event_data' }], type: 'numeric' }] } }, { name: 'avg_ct', expr: { fn: 'average', args: [{ fn: 'cast', args: [{ property: 'complete_time_of_event_data' }], type: 'numeric' }] } }], where: [{ fn: 'eq', args: [{ column: 'event_name' }, { value: 'level_completed' }] }] }],
    metrics: [
      { name: 'sum_ct', type: 'simple', measure: 'sum_ct' },
      { name: 'avg_ct', type: 'simple', measure: 'avg_ct' },
    ],
  });
  assert.equal(out.parse.ok, true, JSON.stringify(out.parse.error || out.parse));
  const r = await q(out.context_id, { steps: [{ stage: 'metrics', metrics: ['sum_ct', 'avg_ct'] }] });
  assert.equal(r.ok, true, JSON.stringify(r.error || r));
  assert.equal(num(r.rows[0].sum_ct), 1263);            // exact Σ complete_time
  assert.ok(Math.abs(num(r.rows[0].avg_ct) - 50.52) < 1e-6);
  // the same aggregation WITHOUT a cast is rejected (string is not numeric)
  await assert.rejects(declare(engine, {
    name: 'castbad',
    semantic_models: [{ source: 'events', measures: [{ name: 'bad', expr: { fn: 'average', args: [{ property: 'complete_time_of_event_data' }] } }], where: [{ fn: 'eq', args: [{ column: 'event_name' }, { value: 'level_completed' }] }] }],
    metrics: [{ name: 'bad', type: 'simple', measure: 'bad' }],
  }), /not numeric|cast/i);
});

test('TASK measure_over_metric_time: DAU/WAU/MAU & event volume', opts, async (t) => {
  if (skip(t)) return;
  const ctx = await buildRecipe(t, 'measure_over_metric_time');
  const grand = await q(ctx, { steps: [{ stage: 'metrics', metrics: ['dau', 'events'] }] });
  const byMonth = await q(ctx, { steps: [{ stage: 'metrics', metrics: ['dau'], group_by: [{ time: 'metric_time', grain: 'month' }] }] });
  for (const r of [grand, byMonth]) assert.equal(r.ok, true, JSON.stringify(r.error || r));
  assert.equal(num(grand.rows[0].dau), 12, '[grand] 12 distinct users overall');
  const mau = num(byMonth.rows[0].dau);
  assert.equal(mau, 12, '[by month] MAU = 12');
  assert.equal(num(grand.rows[0].events), 184, '[event volume] 184 seeded events');

  // a where step before the metrics step computes with a function of what group_by names: the weekend's
  // events — the ISO day of the week of metric_time is 6 or 7 — against the warehouse's own count of them
  const weekend = await q(ctx, { steps: [{ stage: 'where', conditions: [{ fn: 'in', args: [{ fn: 'date_part', args: [{ time: 'metric_time', grain: 'day' }], part: 'dow' }, { value: 6 }, { value: 7 }] }] }, { stage: 'metrics', metrics: ['events'] }] });
  assert.equal(weekend.ok, true, JSON.stringify(weekend.error || weekend));
  const { rows: [onWeekend] } = await wh.query('select count(*) as n from fct_analytics_events where isodow(device_time) in (6, 7)');
  assert.ok(num(onWeekend.n) > 0 && num(onWeekend.n) < 184, `[where date_part] the weekend holds some of the events: ${onWeekend.n}`);
  assert.equal(num(weekend.rows[0].events), num(onWeekend.n), '[where date_part] the weekend\'s events');

  // dry_run: the rendered SQL WITHOUT executing; the dataflow plan only with include: ["plan"] (feature/
  // lifecycle check — we assert the plan/SQL are PRESENT, not their content).
  const dauByDay = { stage: 'metrics', metrics: ['dau'], group_by: [{ time: 'metric_time', grain: 'day' }] };
  const planned = await q(ctx, { steps: [dauByDay], dry_run: true, include: ['plan'] });
  assert.equal(planned.ok, true, JSON.stringify(planned.error || planned));
  assert.equal(planned.dry_run, true, '[dry run] a dry run says so');
  assert.ok(typeof planned.sql === 'string' && planned.sql.length > 0, '[dry run] rendered SQL returned');
  assert.ok(planned.plan && typeof planned.plan === 'object', '[include plan] plan object returned');
  assert.ok(typeof planned.plan.dataflow_plan === 'string' && planned.plan.dataflow_plan.length > 0, '[include plan] dataflow plan present');
  await assert.rejects(() => q(ctx, { steps: [{ stage: 'metrics', metrics: ['dau'] }], include: ['plan'] }), (e) => e.field === 'include' && /include: \["plan"\] goes with dry_run/.test(e.message));
  // a dry run stores nothing: materialize beside it is refused, not ignored
  await assert.rejects(() => q(ctx, { steps: [dauByDay], dry_run: true, materialize: true }), /materialize goes with a query that runs/);

  // a dry run is compiled with the caller's own limit: its SQL, run as shown, returns that many rows
  // (it was compiled with the fetch size, one past the page); without a limit, every one of the 7 days
  const limited = await q(ctx, { steps: [dauByDay], limit: 3, dry_run: true });
  assert.equal(limited.ok, true, JSON.stringify(limited.error || limited));
  assert.equal(limited.dry_run, true, '[dry run] a dry run says so');
  assert.equal(limited.plan, undefined, '[dry run] no plan unless asked for');
  assert.equal((await wh.query(limited.sql)).rows.length, 3, '[dry run] compiled with the caller\'s limit');
  assert.equal((await wh.query(planned.sql)).rows.length, 7, '[dry run] without a limit, every one of the 7 days');

  // #4b: the steps after the metrics step name its result columns — the day axis is metric_time_day;
  // dry_run surfaces the columns the rows come back with; an order_by step naming a column the result
  // does not have (the bare `metric_time` too, which with two grains in group_by named only one of them)
  // is refused with the columns there are.
  const sortBy = (...keys) => ({ stage: 'order_by', keys });
  assert.deepEqual(planned.output_columns.map((c) => c.name).sort(), ['dau', 'metric_time_day'], `output_columns: ${JSON.stringify(planned.output_columns)}`);
  // a lone order_by step is MetricFlow's own order: the rows of the plain query, in that order
  const plain = await q(ctx, { steps: [dauByDay] });
  const sorted = await q(ctx, { steps: [dauByDay, sortBy({ key: 'metric_time_day' })] });
  assert.equal(sorted.ok, true, JSON.stringify(sorted.error || sorted));
  assert.equal(sorted.row_count, 7, '[by day] 7 distinct active days, in ascending order');
  assert.equal(Math.max(...sorted.rows.map((r) => num(r.dau))), 6, '[by day] peak DAU 6 (2026-01-05)');
  assert.ok(sorted.rows.every((r) => num(r.dau) <= mau), '[by day] DAU <= MAU');
  const day = (r) => String(r.metric_time_day).slice(0, 10); // an ISO day: its text sorts as the day does
  const at = sorted.rows.map(day);
  assert.deepEqual(at, [...at].sort(), '[order_by step] ascending days');
  const pairs = (rows) => rows.map((r) => [day(r), num(r.dau)]);
  assert.deepEqual(pairs(sorted.rows), pairs(plain.rows).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)), '[order_by step] the plain query\'s rows, in that order');
  // the same order asked with NULLs first — no NULL day here — is written by the read compiler over
  // MetricFlow's SQL: the same rows in the same order
  const nullsFirst = await q(ctx, { steps: [dauByDay, sortBy({ key: 'metric_time_day', nulls: 'first' })] });
  assert.deepEqual(pairs(nullsFirst.rows), pairs(sorted.rows), '[order_by step, over the SQL] the same rows in the same order');
  // …and in the same form: a day reads the same whichever path ran the query (`mf query`'s CSV, the dbt client's show)
  assert.deepEqual(nullsFirst.rows, sorted.rows, '[one form] the same values, whichever path ran the query');
  // (the step is named by its place in the query's steps: the one after the metrics step)
  await assert.rejects(() => q(ctx, { steps: [dauByDay, sortBy({ key: 'nonsense' })] }), /steps\[1\]: .*unknown column 'nonsense'.*available: metric_time_day, dau/);
  await assert.rejects(() => q(ctx, { steps: [{ ...dauByDay, group_by: [...dauByDay.group_by, { time: 'metric_time', grain: 'week' }] }, sortBy({ key: 'metric_time' })] }), /unknown column 'metric_time'.*available: metric_time_day, metric_time_week/);
  // a key is the result column it is handed as — the same 7 days, desc puts the latest first — never
  // the token the server resolves it to
  const byColumn = await q(ctx, { steps: [dauByDay, sortBy({ key: 'metric_time_day', direction: 'desc' })] });
  assert.equal(byColumn.row_count, 7);
  assert.deepEqual(byColumn.rows.map((r) => String(r.metric_time_day)), sorted.rows.map((r) => String(r.metric_time_day)).reverse());
  await assert.rejects(() => q(ctx, { steps: [dauByDay, sortBy({ key: 'metric_time__day' })] }), /unknown column 'metric_time__day'/);
});

// ── 2. joins: group_by_joined_attribute ──────────────────────────────────────
test('TASK group_by_joined_attribute: revenue/payers/ARPPU by user attribute (1-hop join)', opts, async (t) => {
  if (skip(t)) return;
  const ctx = await buildRecipe(t, 'group_by_joined_attribute');
  const total = await q(ctx, { steps: [{ stage: 'metrics', metrics: ['revenue', 'payers'] }] });
  const byCountry = await q(ctx, { steps: [{ stage: 'metrics', metrics: ['revenue'], group_by: [{ source: 'users', column: 'country' }] }] });
  const byPlatform = await q(ctx, { steps: [{ stage: 'metrics', metrics: ['revenue'], group_by: [{ source: 'users', column: 'platform' }] }] });
  const byAcq = await q(ctx, { steps: [{ stage: 'metrics', metrics: ['revenue', 'payers', 'arppu'], group_by: [{ source: 'users', column: 'acquisition_type' }] }] });
  for (const r of [total, byCountry, byPlatform, byAcq]) assert.equal(r.ok, true, JSON.stringify(r.error || r));
  assert.equal(num(total.rows[0].revenue), 85);             // total revenue 85
  assert.equal(num(total.rows[0].payers), 7);              // payers 7
  const cm = mapCol(byCountry.rows, 'users_country', 'revenue');
  assert.equal(cm.US, 35); assert.equal(cm.GB, 25); assert.equal(cm.BR, 25); // by country
  // a where step before the metrics step compares a function of a joined column: the country lowered is
  // 'us' — the US revenue
  const lowered = await q(ctx, { steps: [{ stage: 'where', conditions: [{ fn: 'eq', args: [{ fn: 'lower', args: [{ source: 'users', column: 'country' }] }, { value: 'us' }] }] }, { stage: 'metrics', metrics: ['revenue'] }] });
  assert.equal(lowered.ok, true, JSON.stringify(lowered.error || lowered));
  assert.equal(num(lowered.rows[0].revenue), cm.US, '[where lower(column)] the US revenue, 35');
  // DE has no completed purchases -> either absent or a null/0 revenue row
  assert.ok(!Number.isFinite(cm.DE) || cm.DE === 0, `[behavior: by country] DE=${cm.DE}`);
  assert.equal(sumCol(byCountry.rows, 'revenue'), 85);      // grouped sum == grand total
  const pm = mapCol(byPlatform.rows, 'users_platform', 'revenue');
  assert.equal(pm.ios, 65, '[behavior: by platform] ios 65'); assert.equal(pm.android, 20, '[behavior: by platform] android 20');
  assert.equal(sumCol(byPlatform.rows, 'revenue'), 85);
  const am = mapCol(byAcq.rows, 'users_acquisition_type', 'revenue');
  assert.equal(am.paid, 55); assert.equal(am.organic, 30);             // by acquisition_type
  // ARPPU == revenue/payers per acq segment (the three metrics come back side by side, one row per segment)
  const payByAcq = mapCol(byAcq.rows, 'users_acquisition_type', 'payers');
  for (const row of byAcq.rows) {
    const k = String(row.users_acquisition_type);
    if (!Number.isFinite(payByAcq[k]) || payByAcq[k] === 0) continue;
    assert.ok(Math.abs(num(row.arppu) - am[k] / payByAcq[k]) < 1e-6, `ARPPU ${k}`);
  }
});

// ── 3. metric_types: funnel_from_event_property_steps (event + step_id property value) ───
test('TASK funnel_from_event_property_steps: tutorial step_id drop-off 8 -> 5 -> 3', opts, async (t) => {
  if (skip(t)) return;
  const ctx = await buildRecipe(t, 'funnel_from_event_property_steps');
  const r = await q(ctx, { steps: [{ stage: 'metrics', metrics: ['step1', 'step2', 'step3', 'conv_1_2', 'conv_2_3'] }] });
  assert.equal(r.ok, true, JSON.stringify(r.error || r));
  const row = r.rows[0];
  assert.equal(num(row.step1), 8, '[steps] step_1 distinct users');
  assert.equal(num(row.step2), 5, '[steps] step_2');
  assert.equal(num(row.step3), 3, '[steps] step_3');
  assert.ok(num(row.step1) >= num(row.step2) && num(row.step2) >= num(row.step3), '[steps] monotonic drop-off');
  // the step-to-step share: who reached the next step over who reached this one
  assert.ok(Math.abs(num(row.conv_1_2) - 5 / 8) < 1e-9, `[step share] 5/8, got ${row.conv_1_2}`);
  assert.ok(Math.abs(num(row.conv_2_3) - 3 / 5) < 1e-9, `[step share] 3/5, got ${row.conv_2_3}`);
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
  const total = await q(ctx, { steps: [{ stage: 'metrics', metrics: ['revenue', 'buyers'] }] });
  const byCohort = await q(ctx, { steps: [{ stage: 'metrics', metrics: ['revenue', 'buyers'], group_by: [{ source: 'users', column: 'install_date' }] }] });
  const grid = await q(ctx, { steps: [{ stage: 'metrics', metrics: ['revenue'], group_by: [{ source: 'users', column: 'install_date' }, { time: 'metric_time', grain: 'day' }] }] });
  for (const r of [total, byCohort, grid]) assert.equal(r.ok, true, JSON.stringify(r.error || r));
  assert.equal(num(total.rows[0].revenue), 85, '[total] revenue 85');
  assert.equal(num(total.rows[0].buyers), 7, '[total] distinct buyers 7');
  assert.equal(sumCol(byCohort.rows, 'revenue'), 85, '[by cohort] revenue summed across cohorts == grand total');
  assert.equal(sumCol(grid.rows, 'revenue'), 85, '[grid] full grid sums to grand total');
  assert.ok(byCohort.rows.every((r) => num(r.buyers) <= 7), '[by cohort] per-cohort buyers <= total payers');
});

// ── 5b. a task's time dimension: what the catalog types as time is read at the declared grain ──
// users.install_date is a time column in the catalog. Declared on a task, it is a TIME dimension:
// at `grain` when one is given (week), at the catalog's own granularity (day) when not — the same
// rows as the users model's own install_date. The day cohorts summed by ISO week (Monday) are the
// week cohorts. The step's dimensions are its main model's: the cohorts' build is over the users, and
// counts the events with a measure of their own (`source`). The labels given go with the dimension, the
// measure and the metric. A dimension COMPUTED from the row ({ name, expr }) is grouped by where it lives:
// { semantic_model: [<its source>], dimension: <its name> }.
test('a task dimension over a time column is read at its grain (week), or at the catalog\'s (day); a computed one by its name', opts, async (t) => {
  if (skip(t)) return;
  const events = { source: 'events', measures: [{ name: 'cnt', expr: { fn: 'count' }, label: 'Events counted' }] };
  const task = (name, dims, eventDims) => declare(engine, {
    name,
    semantic_models: eventDims
      ? [{ ...events, dimensions: eventDims }, { source: 'users' }]
      : [{ source: 'users', ...(dims ? { dimensions: dims } : {}) }, events],
    metrics: [{ name: 'cnt', type: 'simple', measure: 'cnt', label: 'Events' }],
  });
  // (a build over the events computes a dimension of its own on them: whether the event is a completed purchase)
  const purchased = [{ name: 'purchased', expr: { fn: 'eq', args: [{ column: 'event_name' }, { value: 'iap_purchase_completed' }] } }];
  const built = {};
  for (const [name, dims, eventDims] of [['coh_wk', [{ column: 'install_date', grain: 'week', label: 'Install week' }]], ['coh_dy', [{ column: 'install_date' }]], ['coh_base', null], ['coh_buy', null, purchased]]) {
    const out = await task(name, dims, eventDims);
    assert.equal(out.parse.ok, true, JSON.stringify(out.parse));
    built[name] = out.context_id;
  }
  const cohorts = async (name) => {
    const r = await q(built[name], { steps: [{ stage: 'metrics', metrics: ['cnt'], group_by: [{ source: 'users', column: 'install_date' }] }] });
    assert.equal(r.ok, true, JSON.stringify(r.error || r));
    assert.ok(r.columns.some((c) => c.name === 'users_install_date'), `the column is named for the reference: ${JSON.stringify(r.columns)}`);
    return r.rows;
  };
  const day = (v) => (v == null ? null : new Date(v).toISOString().slice(0, 10));
  const byKey = (rows, name, key = day) => {
    const out = {};
    for (const r of rows) { const k = key(r.users_install_date); out[k] = (out[k] || 0) + num(r.cnt); }
    return out;
  };
  const isoWeek = (v) => { if (v == null) return null; const d = new Date(v); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };

  const dailyRows = await cohorts('coh_dy');
  const daily = byKey(dailyRows, 'coh_dy');
  // no grain: the catalog's day — the users model's own install_date, the same rows
  assert.deepEqual(daily, byKey(await cohorts('coh_base'), 'coh_base'));
  assert.equal(Object.values(daily).reduce((a, b) => a + b, 0), 184, 'every event counted once');
  assert.equal(Object.keys(daily).filter((k) => k !== 'null').length, 5, 'five install days');
  // at a week: the day cohorts (the same rows, folded) summed by ISO week, two weeks
  const weekly = byKey(await cohorts('coh_wk'), 'coh_wk');
  assert.deepEqual(weekly, byKey(dailyRows, 'coh_dy', isoWeek));
  assert.equal(Object.keys(weekly).filter((k) => k !== 'null').length, 2, 'Jan 1-4 and Jan 5 2026 are two ISO weeks');
  // filtered on the same column: only the cohort of the week of Jan 5
  const late = await q(built.coh_wk, { steps: [{ stage: 'where', conditions: [{ fn: 'gte', args: [{ source: 'users', column: 'install_date' }, { value: '2026-01-05' }] }] }, { stage: 'metrics', metrics: ['cnt'], group_by: [{ source: 'users', column: 'install_date' }] }] });
  assert.equal(late.ok, true, JSON.stringify(late.error || late));
  assert.deepEqual(byKey(late.rows, 'coh_wk'), { '2026-01-05': weekly['2026-01-05'] });

  // the computed dimension splits the events into the completed purchases and the rest, as the
  // warehouse counts them by hand
  const split = await q(built.coh_buy, { steps: [{ stage: 'metrics', metrics: ['cnt'], group_by: [{ semantic_model: ['events'], dimension: 'purchased' }] }] });
  assert.equal(split.ok, true, JSON.stringify(split.error || split));
  const flag = split.group_by_resolved['events.purchased'];
  const bySplit = Object.fromEntries(split.rows.map((r) => [String(r[flag]).toLowerCase(), num(r.cnt)]));
  const { rows: [byHand] } = await wh.query("select count(*) filter (where event_name = 'iap_purchase_completed') as yes, count(*) filter (where event_name <> 'iap_purchase_completed') as no from fct_analytics_events");
  assert.deepEqual(bySplit, { true: num(byHand.yes), false: num(byHand.no) }, `[computed dimension] ${JSON.stringify(split.rows)}`);
  assert.equal(num(byHand.yes), 8, '[computed dimension] the 8 completed purchases');

  // the labels went with what they were given on, into the layer dbt parsed
  const p = await engine.context({ action: 'describe', context_id: built.coh_wk });
  const users = p.semantic_models.find((sm) => sm.name === 'users');
  assert.equal(users.dimensions.find((d) => d.name === 'install_date').label, 'Install week');
  // (a measure is listed by the legacy spec; the latest spec has none — a simple metric carries its own)
  const measure = (p.semantic_models.find((sm) => sm.name === 'events').measures || []).find((m) => m.name === 'cnt');
  if (measure) assert.equal(measure.label, 'Events counted');
  assert.equal(p.metrics.find((m) => m.name === 'cnt').label, 'Events');
});

// ── 5c. a semantic layer over a table the build made ──
// The build's steps fold the events to one row per session (its start and its event count), and its last
// step is the semantic layer over THAT table: its time axis the session's start, joined to the install
// record valid then. Sessions and events per session, by the install country — the numbers a hand-written
// query over the same rows gives.
test('a semantic layer over a built table: sessions and events per session, by the country at the session\'s start', opts, async (t) => {
  if (skip(t)) return;
  const raw = engine.raw || engine;
  const started = await raw.build_model({
    action: 'start', name: 'sess', source: 'events', materialize: true,
    steps: [
      { stage: 'aggregate', group_by: ['player_id_of_internal', 'session_number'], measures: [{ name: 'session_start', expr: { fn: 'min', args: [{ column: 'device_time' }] } }, { name: 'n_events', expr: { fn: 'count' } }] },
      {
        stage: 'semantic_model', time: 'session_start',
        join: [{ source: 'users', on: { user: 'player_id_of_internal', time: 'session_start' } }],
        measures: [{ name: 'sessions', expr: { fn: 'count' } }, { name: 'events', expr: { fn: 'sum', args: [{ column: 'n_events' }] } }],
        metrics: [{ name: 'sessions', type: 'simple', measure: 'sessions' }, { name: 'events', type: 'simple', measure: 'events' }, { name: 'per_session', type: 'derived', expr: { fn: 'div', args: [{ metric: 'events' }, { metric: 'sessions' }] } }],
      },
    ],
  });
  assert.ok(started.materialize?.task_id, JSON.stringify(started.materialize));
  const parsed = await taskResult(raw, started.materialize.task_id);
  assert.equal(parsed.parse?.ok, true, JSON.stringify(parsed.parse || parsed.error));
  const ctx = started.context_id;
  const { rows: [all] } = await wh.query(`select count(*) as sessions, sum(n) as events from (select player_id_of_internal, session_number, count(*) as n from fct_analytics_events group by 1, 2) s`);
  const total = await q(ctx, { steps: [{ stage: 'metrics', metrics: ['sessions', 'events', 'per_session'] }] });
  assert.equal(total.ok, true, JSON.stringify(total.error));
  assert.equal(num(total.rows[0].sessions), num(all.sessions), 'one row per session');
  assert.equal(num(total.rows[0].events), 184, 'every event in its session');
  assert.ok(Math.abs(num(total.rows[0].per_session) - 184 / num(all.sessions)) < 1e-9);
  // by the install country valid at the session's start
  const byHand = (await wh.query(`select u.country, count(*) as n from (select player_id_of_internal, session_number, min(device_time) as start from fct_analytics_events group by 1, 2) s join dim_users u on u.player_id_of_internal = s.player_id_of_internal and s.start between u.install_time_valid_from and u.install_time_valid_until group by 1`)).rows;
  const r = await q(ctx, { steps: [{ stage: 'metrics', metrics: ['sessions'], group_by: [{ source: 'users', column: 'country' }] }] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const got = Object.fromEntries(r.rows.map((x) => [String(x.users_country), num(x.sessions)]));
  assert.deepEqual(got, Object.fromEntries(byHand.map((x) => [String(x.country), num(x.n)])));
  // a column of the built table is named by its semantic model; the built rows stay readable as a table
  const byCount = await q(ctx, { steps: [{ stage: 'metrics', metrics: ['sessions'], group_by: [{ semantic_model: ['sess'], dimension: 'n_events' }] }] });
  assert.equal(byCount.ok, true, JSON.stringify(byCount.error));
  assert.equal(byCount.rows.reduce((a, x) => a + num(x.sessions), 0), num(all.sessions));
  const read = await q(ctx, { steps: [{ stage: 'aggregate', measures: [{ name: 'n', expr: { fn: 'count' } }] }] });
  assert.equal(num(read.rows[0].n), num(all.sessions), 'the table itself, read as a pipeline\'s');
  // the step edited alone: the next materialize stands the layer on the table already built
  const { steps } = await raw.build_model({ action: 'preview', context_id: ctx });
  const { index, ...layer } = steps.find((st) => st.stage === 'semantic_model');
  await raw.build_model({ action: 'edit_step', context_id: ctx, index, step: { ...layer, measures: [...layer.measures, { name: 'longest', expr: { fn: 'max', args: [{ column: 'n_events' }] } }], metrics: [...layer.metrics, { name: 'longest', type: 'simple', measure: 'longest' }] } });
  const again = await raw.build_model({ action: 'materialize', context_id: ctx });
  assert.equal((await taskResult(raw, again.task_id)).parse?.ok, true);
  const { rows: [most] } = await wh.query('select max(n) as n from (select count(*) as n from fct_analytics_events group by player_id_of_internal, session_number) s');
  const longest = await q(ctx, { steps: [{ stage: 'metrics', metrics: ['longest', 'sessions'] }] });
  assert.equal(longest.ok, true, JSON.stringify(longest.error));
  assert.equal(num(longest.rows[0].longest), num(most.n));
  assert.equal(num(longest.rows[0].sessions), num(all.sessions));
});

// ── 6. metric_types: boolean_condition_as_measure (did / didn't purchase) ────
// (A did / didn't split by a Metric() filter is not tested here: no tool takes one — a where step before
// the metrics step is the one expression grammar, and caller Jinja stays literal text: CALLER TEXT IS
// NEVER JINJA in pipeline-stages.test.js.)
test('TASK boolean_condition_as_measure: did-purchase and session counts as counts with a condition (8 of 21)', opts, async (t) => {
  if (skip(t)) return;
  const ctx = await buildRecipe(t, 'boolean_condition_as_measure');
  const both = await q(ctx, { steps: [{ stage: 'metrics', metrics: ['purchases', 'sessions'] }] });
  const sessByDay = await q(ctx, { steps: [{ stage: 'metrics', metrics: ['sessions'], group_by: [{ time: 'metric_time', grain: 'day' }] }] });
  for (const r of [both, sessByDay]) assert.equal(r.ok, true, JSON.stringify(r.error || r));
  assert.equal(num(both.rows[0].purchases), 8, '[purchases] 8 completed purchases (a count over a case)');
  assert.equal(num(both.rows[0].sessions), 21, '[sessions] 21 new_session events');
  assert.equal(sumCol(sessByDay.rows, 'sessions'), 21, '[sessions by day] per-day sessions sum to 21');
  assert.ok(num(both.rows[0].purchases) < num(both.rows[0].sessions), '[both] behavior is a subset signal');
});

// ── 7. metric_types: agg_chosen_per_question (per level_id) ──────────────────
test('TASK agg_chosen_per_question: starts/completes/rate per level_id', opts, async (t) => {
  if (skip(t)) return;
  const ctx = await buildRecipe(t, 'agg_chosen_per_question');
  const totals = await q(ctx, { steps: [{ stage: 'metrics', metrics: ['starts', 'completes', 'completion_rate', 'avg_time'] }] });
  // the recipe's first example (starts and completes by level_id), with the rate beside them
  const byLevel = await q(ctx, { steps: [{ stage: 'metrics', metrics: ['starts', 'completes', 'completion_rate'], group_by: [{ source: 'events', property: 'level_id_of_event_data' }] }] });
  for (const r of [totals, byLevel]) assert.equal(r.ok, true, JSON.stringify(r.error || r));
  const row = totals.rows[0];
  assert.equal(num(row.starts), 28, '[totals] level_started 28');
  assert.equal(num(row.completes), 25, '[totals] level_completed 25');
  assert.ok(num(row.completes) <= num(row.starts), '[totals] completers <= starters');
  const cr = num(row.completion_rate);
  assert.ok(Math.abs(cr - 25 / 28) < 1e-9 && cr >= 0 && cr <= 1, `[overall rate] 25/28 in [0,1], got ${cr}`);
  assert.ok(cr > 0 && cr < 1, `[behavior: progression overall rate] 25/28 in (0,1), got ${cr}`);
  assert.ok(num(row.avg_time) > 0, '[avg time] positive');
  const sBy = mapCol(byLevel.rows, 'events_level_id_of_event_data', 'starts');
  assert.equal(sBy['1'], 12, '[per-level starts] L1'); assert.equal(sBy['2'], 6, '[per-level starts] L2'); assert.equal(sBy['3'], 3, '[per-level starts] L3');
  assert.equal(sumCol(byLevel.rows, 'starts'), 28, '[per-level starts] grouped starts sum to 28');
  const cBy = mapCol(byLevel.rows, 'events_level_id_of_event_data', 'completes');
  assert.equal(cBy['1'], 12, '[behavior: progression per-level completes] L1'); assert.equal(cBy['2'], 4, '[behavior: progression per-level completes] L2'); assert.equal(cBy['3'], 3, '[behavior: progression per-level completes] L3');
  const rBy = mapCol(byLevel.rows, 'events_level_id_of_event_data', 'completion_rate');
  for (const [lvl, v] of Object.entries(rBy)) if (Number.isFinite(v)) assert.ok(v >= 0 && v <= 1.0000001, `[behavior: progression per-level rate] L${lvl} in [0,1], got ${v}`);
  assert.ok(Math.abs(rBy['1'] - 1) < 1e-9, `[behavior: progression per-level rate] L1 = 1.0, got ${rBy['1']}`);
  // level 6: 1 start, 0 completes -> rate 0
  assert.ok(rBy['6'] === 0 || !Number.isFinite(rBy['6']), `[behavior: progression per-level rate] L6 = 0, got ${rBy['6']}`);
});

// ── 8. metric_types: ratio_metric ────────────────────────────────────────────
test('TASK ratio_metric: revenue/ARPPU/AOV by product/day/segment', opts, async (t) => {
  if (skip(t)) return;
  const ctx = await buildRecipe(t, 'ratio_metric');
  const totals = await q(ctx, { steps: [{ stage: 'metrics', metrics: ['revenue', 'payers', 'purchases', 'aov'] }] });
  // revenue is a sum, so the product and the country splits are the marginals of ONE query grouped by both
  const byProductCountry = await q(ctx, { steps: [{ stage: 'metrics', metrics: ['revenue'], group_by: [{ source: 'events', property: 'product_id_of_event_data' }, { source: 'users', column: 'country' }] }] });
  // (the recipe's first example, as it is served)
  const byDay = await q(ctx, { steps: [{ stage: 'metrics', metrics: ['revenue'], group_by: [{ time: 'metric_time', grain: 'day' }] }] });
  for (const r of [totals, byProductCountry, byDay]) assert.equal(r.ok, true, JSON.stringify(r.error || r));
  assert.equal(num(totals.rows[0].revenue), 85, '[totals] revenue 85');
  assert.equal(num(totals.rows[0].payers), 7, '[totals] payers 7');
  assert.equal(num(totals.rows[0].purchases), 8, '[totals] purchases 8');
  assert.ok(Math.abs(num(totals.rows[0].aov) - 85 / 8) < 1e-6, '[totals] AOV 85/8'); // AOV 10.625
  const pm = marginal(byProductCountry.rows, 'events_product_id_of_event_data', 'revenue');
  // (also the plain by-product revenue the monetization suites asked of their own `mon` task)
  assert.equal(pm.p1, 15, '[by product] p1'); assert.equal(pm.p2, 30, '[by product] p2'); assert.equal(pm.p3, 40, '[by product] p3');
  assert.equal(sumCol(byProductCountry.rows, 'revenue'), 85, '[by country] the country sum == grand total');
  assert.equal(sumCol(byDay.rows, 'revenue'), 85, '[by day] the per-day sum == grand total');
});

// ── 9. metric_types: payload_property_measure_and_dimension ──────────────────
test('TASK payload_property_measure_and_dimension: ad revenue & impressions by network/placement', opts, async (t) => {
  if (skip(t)) return;
  const ctx = await buildRecipe(t, 'payload_property_measure_and_dimension');
  const totals = await q(ctx, { steps: [{ stage: 'metrics', metrics: ['ad_revenue', 'impressions', 'rev_per_imp'] }] });
  const byNetwork = await q(ctx, { steps: [{ stage: 'metrics', metrics: ['ad_revenue'], group_by: [{ source: 'events', property: 'network_of_additional_info_of_event_data' }] }] });
  const byPlacement = await q(ctx, { steps: [{ stage: 'metrics', metrics: ['impressions'], group_by: [{ source: 'events', property: 'placement_of_event_data' }] }] });
  for (const r of [totals, byNetwork, byPlacement]) assert.equal(r.ok, true, JSON.stringify(r.error || r));
  assert.equal(num(totals.rows[0].ad_revenue), 29);                // total ad revenue 29 cents
  assert.equal(num(totals.rows[0].impressions), 12);              // 12 ad_finished impressions
  const nm = mapCol(byNetwork.rows, 'events_network_of_additional_info_of_event_data', 'ad_revenue');
  assert.equal(nm.admob, 12); assert.equal(nm.unity, 8); assert.equal(nm.ironsource, 6); assert.equal(nm.applovin, 3); // by network
  assert.equal(sumCol(byNetwork.rows, 'ad_revenue'), 29);          // network sum == grand total
  assert.equal(sumCol(byPlacement.rows, 'impressions'), 12);       // placement sum == total impressions
  const rpi = num(totals.rows[0].rev_per_imp);
  assert.ok(Math.abs(rpi - 29 / 12) < 1e-6, `rev_per_imp ${rpi}`);     // rev_per_imp == 29/12
});

// ── 10. metric_types: two_event_scopes_and_a_net (coins in vs out) ───────────
test('TASK two_event_scopes_and_a_net: coins in (510) vs out (140) & source split', opts, async (t) => {
  if (skip(t)) return;
  const ctx = await buildRecipe(t, 'two_event_scopes_and_a_net');
  const bySource = await q(ctx, { steps: [{ stage: 'metrics', metrics: ['coins_in', 'coins_out'], group_by: [{ source: 'events', property: 'source_type_of_event_data' }] }] });
  // the recipe's first example (net coins by day), with both of its inputs beside it — both are sums,
  // so the day split also carries the totals
  const byDay = await q(ctx, { steps: [{ stage: 'metrics', metrics: ['coins_in', 'coins_out', 'net_coins'], group_by: [{ time: 'metric_time', grain: 'day' }] }] });
  for (const r of [bySource, byDay]) assert.equal(r.ok, true, JSON.stringify(r.error || r));
  const coinsIn = sumCol(byDay.rows, 'coins_in');
  const coinsOut = sumCol(byDay.rows, 'coins_out');
  assert.equal(coinsIn, 510, '[totals] coins in 510');
  assert.equal(coinsOut, 140, '[totals] coins out 140');
  assert.equal(coinsIn - coinsOut, 370, '[totals] net coins 370');
  assert.equal(sumCol(bySource.rows, 'coins_in'), 510, '[by source] income source split sums to 510');
  assert.equal(sumCol(byDay.rows, 'coins_in'), 510, '[by day] income per-day sums to 510');
  // every day with income has spending too (01-01..01-04), so the day nets add up to the whole
  assert.equal(sumCol(byDay.rows, 'coins_out'), 140, '[by day] spending per-day sums to 140');
  assert.equal(sumCol(byDay.rows, 'net_coins'), 370, '[by day] the derived net per day sums to 370');
});

// ── 11. a cumulative metric over a partitioned source (moved from cumulative-window.test.js) ──
// A CUMULATIVE METRIC OVER A PARTITIONED SOURCE READS THE DAYS BEFORE ITS RANGE. The fixture's
// events source is partitioned by event_date (the day of device_time), and a time_range prunes those
// partitions with a filter of its own — applied to the rows BEFORE they accumulate. Its lower bound
// reaches back by the metric's window, or a 2-day window on the range's first day holds that day
// alone. Proven on DATA: each value below is the warehouse's own count of the same events, read with
// SQL written by hand in the test (events by day: 01-01 33, 01-02 42, 01-03 27, 01-04 39, 01-05 37).
const CUMULATIVE_TASK = {
  name: 'cum',
  semantic_models: [{ source: 'events', measures: [{ name: 'events_n', expr: { fn: 'count' } }] }],
  metrics: [
    { name: 'daily', type: 'simple', measure: 'events_n' },
    { name: 'two_day', type: 'cumulative', measure: 'events_n', window: '2 days' },
    { name: 'to_date', type: 'cumulative', measure: 'events_n' },
  ],
};

/** The warehouse's own count per day of device_time, by hand. */
async function eventsPerDay() {
  const { rows } = await wh.query('select cast(device_time as date) as d, count(*) as n from fct_analytics_events group by 1');
  return new Map(rows.map((r) => [String(r.d instanceof Date ? r.d.toISOString() : r.d).slice(0, 10), num(r.n)]));
}

test('a cumulative metric over a time_range sums the days before the range that its window covers — and one with no window, every day before', opts, async (t) => {
  if (skip(t)) return;
  const day = await eventsPerDay();
  const at = (d) => day.get(d) || 0;
  const created = await declare(engine, CUMULATIVE_TASK);
  const query = { context_id: created.context_id, time_range: { start: '2026-01-03', end: '2026-01-05' } };
  const cumulative = { stage: 'metrics', metrics: ['daily', 'two_day', 'to_date'], group_by: [{ time: 'metric_time', grain: 'day' }] };
  const byDay = [{ stage: 'order_by', keys: [{ key: 'metric_time_day' }] }];
  const r = await engine.query_model({ ...query, steps: [cumulative, ...byDay] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const got = r.rows.map((x) => [num(x.daily), num(x.two_day), num(x.to_date)]);
  const days = ['2026-01-03', '2026-01-04', '2026-01-05'];
  const prev = { '2026-01-03': '2026-01-02', '2026-01-04': '2026-01-03', '2026-01-05': '2026-01-04' };
  const upTo = (d) => [...day].filter(([k]) => k <= d).reduce((a, [, n]) => a + n, 0);
  assert.ok(at('2026-01-02') > 0, 'the fixture has events the day before the range');
  assert.deepEqual(got, days.map((d) => [at(d), at(prev[d]) + at(d), upTo(d)]));
  // a where step after the metrics step filters the RESULT, not the rows a metric folds (that is a where
  // step before it, or the window): the days it keeps carry the sums the whole query gave them, the days
  // before them included
  const later = await engine.query_model({ ...query, steps: [cumulative, { stage: 'where', conditions: [{ fn: 'gte', args: [{ column: 'metric_time_day' }, { value: '2026-01-04' }] }] }, ...byDay] });
  assert.equal(later.ok, true, JSON.stringify(later.error));
  assert.deepEqual(later.rows.map((x) => [num(x.daily), num(x.two_day), num(x.to_date)]), got.slice(1), '[where step] the last two days, as the whole query gave them');
});
