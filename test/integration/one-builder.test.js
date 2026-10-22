// ONE BUILDER, ONE QUERY TOOL, ONE JOIN CONTRACT — the redesign proven on the data
// (docs/knowledge/decisions/2026/10/2026-10-15-20-30-00-one-builder-one-query-one-join-contract.md).
// Every call here is the tool's own, written as a caller writes it — no declaration helper:
//   1. a build whose one step is its semantic layer: the users model joined on its contract, an amount of
//      another model (acquisition) computed on its own rows beside the events, every name as declared;
//   2. the layer changed by edit_step and materialized again: the context holds the new one only;
//   3. a context's layer described as dbt parsed it, and validated on the warehouse over a window;
//   4. a pipeline taken back to an earlier step by a fork, its rows those of the steps it kept.
// DATA-ONLY assertions (the project's rule): every number is held to the warehouse's own count.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { buildWarehouse, fixtureProject } from './warehouse-harness.js';
import { settle, taskResult } from '../helpers/settle.js';
import { HAS_DBT, testDbt } from '../helpers/dbt-env.js';
import { tempDir } from '../helpers/temp-dir.js';

const BASE = fixtureProject('dbt_project'); // a private copy: the test files run side by side
const opts = { timeout: 600000 };
const WINDOW = { start: '2026-01-01', end: '2026-01-31' };
const num = (v) => Number(v === '' || v == null ? NaN : v);
const near = (a, b) => Math.abs(a - b) < 1e-9;

let wh;
let engine;

before(async () => {
  if (!HAS_DBT) return;
  wh = await buildWarehouse(BASE);
  const catalog = loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), { profilesDir: BASE, projectDir: BASE });
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: tempDir('onebld'), timeSpineDialect: 'duckdb' });
  engine = settle(new Engine({ catalog, contextManager: ctxs, runner: testDbt({ profilesDir: BASE }) }));
}, opts);

after(async () => { engine?.runner?.close?.(); if (wh) await wh.stop(); });
const skip = (t) => { if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; } return false; };

const USERS = { source: 'users', on: { user: 'player_id_of_internal', time: 'device_time' } };
const LAYER = {
  stage: 'semantic_model',
  join: [USERS],
  dimensions: [{ name: 'is_purchase', expr: { fn: 'eq', args: [{ column: 'event_name' }, { value: 'iap_purchase_completed' }] } }, { name: 'weekday', expr: { fn: 'date_part', args: [{ column: 'device_time' }], part: 'dow' } }, { name: 'la_day', expr: { fn: 'date_trunc', grain: 'day', args: [{ fn: 'in_timezone', timezone: 'America/Los_Angeles', args: [{ column: 'device_time' }] }] } }],
  measures: [
    { name: 'evts', expr: { fn: 'count' } },
    { name: 'players', expr: { fn: 'count_distinct', args: [{ column: 'player_id_of_internal' }] } },
    { name: 'spend', source: 'acquisition', expr: { fn: 'sum', args: [{ column: 'cost' }] } },
  ],
  metrics: [
    { name: 'evts', type: 'simple', measure: 'evts' },
    { name: 'players', type: 'simple', measure: 'players' },
    { name: 'spend', type: 'simple', measure: 'spend' },
    { name: 'evts_per_player', type: 'derived', expr: { fn: 'div', args: [{ metric: 'evts' }, { metric: 'players' }] } },
  ],
};
const metrics = (names, extra = {}) => ({ stage: 'metrics', metrics: names, ...extra });

let ctx;

test('a build whose one step is its layer: joined on the contract, an amount computed beside the events, every name as declared', opts, async (t) => {
  if (skip(t)) return;
  const out = await engine.build_model({ action: 'start', name: 'onebld', source: 'events', steps: [LAYER], materialize: true });
  ctx = out.context_id;
  assert.deepEqual(out.step_effects[0].metrics.sort(), ['evts', 'evts_per_player', 'players', 'spend']);
  const parsed = await taskResult(engine, out.materialize.task_id);
  assert.equal(parsed.parse?.ok ?? parsed.ok, true, JSON.stringify(parsed));

  const [truth] = (await wh.query('select count(*) as evts, count(distinct player_id_of_internal) as players from fct_analytics_events')).rows;
  const [{ spend }] = (await wh.query('select sum(cost) as spend from fct_player_acquisition')).rows;
  const all = await engine.query_model({ context_id: ctx, steps: [metrics(['evts', 'players', 'spend', 'evts_per_player'])], time_range: WINDOW });
  assert.equal(all.ok, true, JSON.stringify(all.error));
  const [row] = all.rows;
  // the result's columns are the names the step declared
  assert.equal(num(row.evts), num(truth.evts));
  assert.equal(num(row.players), num(truth.players));
  assert.ok(near(num(row.spend), num(spend)), `spend ${row.spend} vs ${spend}`);
  assert.ok(near(num(row.evts_per_player), num(truth.evts) / num(truth.players)));

  // grouped by an attribute of the joined model: every event counted once (the contract's key is unique
  // at a moment), the per-country counts those the warehouse gives for the version valid at the event
  const by = await engine.query_model({ context_id: ctx, steps: [metrics(['evts'], { group_by: [{ source: 'users', column: 'platform' }] })], time_range: WINDOW });
  assert.equal(by.ok, true, JSON.stringify(by.error));
  const col = by.group_by_resolved['users.platform'];
  const got = Object.fromEntries(by.rows.map((r) => [String(r[col] ?? 'null'), num(r.evts)]));
  assert.equal(Object.values(got).reduce((a, b) => a + b, 0), num(truth.evts), `no event repeats or is lost: ${JSON.stringify(got)}`);
  const sql = `select coalesce(u.platform, 'null') as k, count(*) as n from fct_analytics_events e
    left join dim_users u on u.player_id_of_internal = e.player_id_of_internal
     and e.device_time >= u.install_time_valid_from and (u.install_time_valid_until is null or e.device_time < u.install_time_valid_until)
    group by 1`;
  const want = Object.fromEntries((await wh.query(sql)).rows.map((r) => [String(r.k), num(r.n)]));
  assert.deepEqual(got, want);

  // after the metrics step a group_by item is named as group_by names it, a metric as { metric }: the same
  // rows as the result's column names give, the platforms with more than one event, the biggest first
  const platform = { source: 'users', column: 'platform' };
  const byRef = await engine.query_model({ context_id: ctx, time_range: WINDOW, steps: [metrics(['evts'], { group_by: [platform] }),
    { stage: 'where', conditions: [{ fn: 'gt', args: [{ metric: 'evts' }, { value: 1 }] }, { fn: 'is_not_null', args: [platform] }] },
    { stage: 'order_by', keys: [{ key: 'evts', direction: 'desc' }, { key: platform }] }] });
  assert.equal(byRef.ok, true, JSON.stringify(byRef.error));
  const expected = Object.entries(want).filter(([k, n]) => k !== 'null' && n > 1).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  assert.deepEqual(byRef.rows.map((r) => [String(r[col]), num(r.evts)]), expected);

  // every slot that names a column takes the same refs: grouped by platform and country, folded back to
  // platform by an aggregate whose group_by names it as group_by does, the metric summed as { metric },
  // sorted by { metric } — the per-platform counts again; a pivot's on and a project's keep alike
  const country = { source: 'users', column: 'country' };
  const refold = await engine.query_model({ context_id: ctx, time_range: WINDOW, steps: [metrics(['evts'], { group_by: [platform, country] }),
    { stage: 'where', conditions: [{ fn: 'is_not_null', args: [platform] }] },
    { stage: 'aggregate', group_by: [platform], measures: [{ name: 'n', expr: { fn: 'sum', args: [{ metric: 'evts' }] } }] },
    { stage: 'order_by', keys: [{ key: 'n', direction: 'desc' }, { key: platform }] },
    { stage: 'project', keep: [platform, 'n'] }] });
  assert.equal(refold.ok, true, JSON.stringify(refold.error));
  const perPlatform = Object.entries(want).filter(([k]) => k !== 'null').sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  assert.deepEqual(refold.rows.map((r) => [String(r[col]), num(r.n)]), perPlatform);
  const sorted = await engine.query_model({ context_id: ctx, time_range: WINDOW, steps: [metrics(['evts'], { group_by: [platform] }), { stage: 'order_by', keys: [{ key: { metric: 'evts' }, direction: 'desc' }, { key: platform }] }] });
  assert.equal(sorted.ok, true, JSON.stringify(sorted.error));
  assert.deepEqual(sorted.rows.map((r) => num(r.evts)), Object.values(want).sort((a, b) => b - a));
  const [first] = Object.keys(want).filter((k) => k !== 'null').sort();
  const pivoted = await engine.query_model({ context_id: ctx, time_range: WINDOW, steps: [metrics(['evts'], { group_by: [platform] }),
    { stage: 'pivot', on: platform, measure: { fn: 'sum', args: [{ metric: 'evts' }] }, values: [{ value: first, name: 'first_platform' }] }] });
  assert.equal(pivoted.ok, true, JSON.stringify(pivoted.error));
  assert.equal(num(pivoted.rows[0].first_platform), want[first]);

  // a time column of the joined model at a bucket of its own: events by the ISO week of the install, as
  // the warehouse counts them for the version valid at each event
  const week = { source: 'users', column: 'install_date', grain: 'week' };
  const byWeek = await engine.query_model({ context_id: ctx, time_range: WINDOW, steps: [metrics(['evts'], { group_by: [week] }), { stage: 'order_by', keys: [{ key: week }] }] });
  assert.equal(byWeek.ok, true, JSON.stringify(byWeek.error));
  const wcol = byWeek.group_by_resolved['users.install_date'];
  const gotWeeks = byWeek.rows.map((r) => [r[wcol] == null ? null : String(r[wcol]).slice(0, 10), num(r.evts)]);
  const weeks = (await wh.query(`select strftime(date_trunc('week', u.install_date), '%Y-%m-%d') as w, count(*) as n from fct_analytics_events e
    left join dim_users u on u.player_id_of_internal = e.player_id_of_internal
     and e.device_time >= u.install_time_valid_from and (u.install_time_valid_until is null or e.device_time < u.install_time_valid_until)
    group by 1 order by 1 nulls last`)).rows.map((r) => [r.w == null ? null : String(r.w), num(r.n)]);
  assert.deepEqual(gotWeeks, weeks);

  // a window after the metrics step names its columns as the query does: the day before's count by lag,
  // ordered by the day as group_by names it
  const dayRef = { time: 'metric_time', grain: 'day' };
  const lagged = await engine.query_model({ context_id: ctx, time_range: WINDOW, steps: [metrics(['evts'], { group_by: [dayRef] }),
    { stage: 'compute', name: 'prev', expr: { fn: 'lag', args: [{ metric: 'evts' }], over: { order_by: [{ key: dayRef }] } } },
    { stage: 'order_by', keys: [{ key: dayRef }] }] });
  assert.equal(lagged.ok, true, JSON.stringify(lagged.error));
  assert.deepEqual(lagged.rows.map((r) => (r.prev == null ? null : num(r.prev))), [null, ...lagged.rows.slice(0, -1).map((r) => num(r.evts))]);

  // a window inside a week, grouped by week: MetricFlow counts the week whole — the rows of every day of
  // it, as the warehouse counts them — and the answer says the days it covers
  const midWeek = await engine.query_model({ context_id: ctx, time_range: { start: '2026-01-06', end: '2026-01-07' }, steps: [metrics(['evts'], { group_by: [{ time: 'metric_time', grain: 'week' }] })] });
  assert.equal(midWeek.ok, true, JSON.stringify(midWeek.error));
  const [{ n: wholeWeek }] = (await wh.query("select count(*) as n from fct_analytics_events where device_time >= '2026-01-05' and device_time < '2026-01-12'")).rows;
  assert.deepEqual(midWeek.rows.map((r) => num(r.evts)), [num(wholeWeek)]);
  assert.ok(midWeek.warnings.some((w) => w.includes('2026-01-05 … 2026-01-11')), JSON.stringify(midWeek.warnings));
  // a window in a timezone, grouped by day: the days are UTC days, the first and last counted whole —
  // the days MetricFlow returns are those the answer names, each its whole UTC day as the warehouse counts it
  const la = await engine.query_model({ context_id: ctx, time_range: { start: '2026-01-02', end: '2026-01-03', timezone: 'America/Los_Angeles' }, steps: [metrics(['evts'], { group_by: [{ time: 'metric_time', grain: 'day' }] }), { stage: 'order_by', keys: [{ key: { time: 'metric_time', grain: 'day' } }] }] });
  assert.equal(la.ok, true, JSON.stringify(la.error));
  const days = (await wh.query("select strftime(date_trunc('day', device_time), '%Y-%m-%d') as d, count(*) as n from fct_analytics_events where device_time >= '2026-01-02' and device_time < '2026-01-05' group by 1 order by 1")).rows.map((r) => [r.d, num(r.n)]);
  assert.deepEqual(la.rows.map((r) => [String(r.metric_time_day).slice(0, 10), num(r.evts)]), days);
  assert.ok(la.warnings.some((w) => w.includes('2026-01-02 … 2026-01-04 UTC')), JSON.stringify(la.warnings));
  // the timezone's own days, as the warning says to count them: a computed dimension of each row's local
  // day, kept to the days asked — as the warehouse counts Los Angeles days (UTC−8 in January)
  const laDay = { semantic_model: ['events'], dimension: 'la_day' };
  const local = await engine.query_model({ context_id: ctx, steps: [
    { stage: 'where', conditions: [{ fn: 'between', args: [laDay, { value: '2026-01-02' }, { value: '2026-01-03' }] }] },
    metrics(['evts'], { group_by: [laDay] }), { stage: 'order_by', keys: [{ key: laDay }] }] });
  assert.equal(local.ok, true, JSON.stringify(local.error));
  const lacol = local.group_by_resolved['events.la_day'];
  const laDays = (await wh.query("select strftime(cast(device_time - interval 8 hour as date), '%Y-%m-%d') as d, count(*) as n from fct_analytics_events where cast(device_time - interval 8 hour as date) between '2026-01-02' and '2026-01-03' group by 1 order by 1")).rows.map((r) => [r.d, num(r.n)]);
  assert.deepEqual(local.rows.map((r) => [String(r[lacol]).slice(0, 10), num(r.evts)]), laDays);

  // a text column holding a flag, filtered by true before the metrics step: compared as the text it holds
  // ('true', '1', 't' in any case), as a pipeline compares it — MetricFlow is never handed text = TRUE
  const [{ n: flagged }] = (await wh.query("select count(*) as n from fct_analytics_events where lower(trim(bundle_id)) in ('true', '1', 't')")).rows;
  const byFlagText = await engine.query_model({ context_id: ctx, time_range: WINDOW, steps: [{ stage: 'where', conditions: [{ fn: 'eq', args: [{ source: 'events', column: 'bundle_id' }, { value: true }] }] }, metrics(['evts'])] });
  assert.equal(byFlagText.ok, true, JSON.stringify(byFlagText.error));
  assert.equal(num(byFlagText.rows[0]?.evts ?? 0), num(flagged));

  // a computed boolean dimension reads back as true / false, whichever path ran the query — MetricFlow's
  // own (its CSV writes Python's 'True') or the SQL it compiles with a step after it
  const flag = { semantic_model: ['events'], dimension: 'is_purchase' };
  const [{ n: purchases }] = (await wh.query("select count(*) as n from fct_analytics_events where event_name = 'iap_purchase_completed'")).rows;
  const counts = { true: num(purchases), false: num(truth.evts) - num(purchases) };
  for (const tail of [[], [{ stage: 'where', conditions: [{ fn: 'gt', args: [{ metric: 'evts' }, { value: 0 }] }] }]]) {
    const byFlag = await engine.query_model({ context_id: ctx, time_range: WINDOW, steps: [metrics(['evts'], { group_by: [flag] }), ...tail] });
    assert.equal(byFlag.ok, true, JSON.stringify(byFlag.error));
    const fcol = byFlag.group_by_resolved['events.is_purchase'];
    assert.deepEqual(Object.fromEntries(byFlag.rows.map((r) => [r[fcol], num(r.evts)])), counts, `${tail.length ? 'over its SQL' : 'mf query'}: ${JSON.stringify(byFlag.rows)}`);
    assert.ok(byFlag.rows.every((r) => typeof r[fcol] === 'boolean'), JSON.stringify(byFlag.rows));
  }
  // a computed number reads back as a number too: events per ISO day of the week, as the warehouse counts them
  const weekdays = Object.fromEntries((await wh.query('select isodow(device_time) as d, count(*) as n from fct_analytics_events group by 1')).rows.map((r) => [num(r.d), num(r.n)]));
  for (const tail of [[], [{ stage: 'where', conditions: [{ fn: 'gt', args: [{ metric: 'evts' }, { value: 0 }] }] }]]) {
    const wd = { semantic_model: ['events'], dimension: 'weekday' };
    const byDay = await engine.query_model({ context_id: ctx, time_range: WINDOW, steps: [metrics(['evts'], { group_by: [wd] }), ...tail] });
    assert.equal(byDay.ok, true, JSON.stringify(byDay.error));
    const dcol = byDay.group_by_resolved['events.weekday'];
    assert.ok(byDay.rows.every((r) => typeof r[dcol] === 'number'), JSON.stringify(byDay.rows));
    assert.deepEqual(Object.fromEntries(byDay.rows.map((r) => [r[dcol], num(r.evts)])), weekdays);
  }
});

test('a metric is cut by the columns its own rows reach: another model\'s column refused in the call, described per metric, its freshness its own source\'s', opts, async (t) => {
  if (skip(t) || !ctx) return;
  // spend folds acquisition's rows: an events column does not cut it (MetricFlow would refuse it minutes later)
  const byEvent = { group_by: [{ source: 'events', column: 'event_name' }] };
  await assert.rejects(() => engine.query_model({ context_id: ctx, steps: [metrics(['evts', 'spend'], byEvent)], time_range: WINDOW }), /'events\.event_name' does not cut 'spend' \(it folds acquisition\)[^]*it cuts 'evts'/);
  const evts = await engine.query_model({ context_id: ctx, steps: [metrics(['evts'], byEvent)], time_range: WINDOW });
  assert.equal(evts.ok, true, JSON.stringify(evts.error));
  // describe lists, for each metric, the dimensions that cut it
  const dimsOf = async (metric) => (await engine.context({ action: 'describe', context_id: ctx, metric })).metrics[0].group_by.dimensions.map((d) => `${d.source ?? d.semantic_model.join('.')}.${d.column ?? d.property ?? d.dimension}`);
  assert.ok((await dimsOf('evts')).includes('events.event_name'));
  assert.ok(!(await dimsOf('spend')).includes('events.event_name'));
  // the freshness read is the queried metric's own source's
  const spend = await engine.query_model({ context_id: ctx, steps: [metrics(['spend'])], time_range: WINDOW });
  assert.equal(spend.ok, true, JSON.stringify(spend.error));
  assert.equal(spend.provenance.source, 'acquisition');
  // an entity is a key the metric's own rows carry: a session cuts the events, not the spend
  const entitiesOf = async (metric) => (await engine.context({ action: 'describe', context_id: ctx, metric })).metrics[0].group_by.entities.map((x) => x.entity);
  assert.ok((await entitiesOf('evts')).includes('session'));
  assert.ok(!(await entitiesOf('spend')).includes('session'));
  await assert.rejects(() => engine.query_model({ context_id: ctx, steps: [metrics(['spend'], { group_by: [{ entity: 'session' }] })], time_range: WINDOW }), /the entity 'session' does not cut 'spend' \(it folds acquisition/);
});

test('a model removed with its metrics (cascade) stays removed: the build\'s semantic_model step says the same', opts, async (t) => {
  if (skip(t) || !ctx) return;
  // without cascade the refusal says how to take the metrics with it
  await assert.rejects(() => engine.delete_context({ what: 'semantic_model', context_id: ctx, semantic_model: 'acquisition' }), /metrics depend on this model's measures: spend — add cascade: true/);
  const removed = await engine.delete_context({ what: 'semantic_model', context_id: ctx, semantic_model: 'acquisition', cascade: true });
  assert.equal(removed.removed, true);
  const { steps } = await engine.build_model({ action: 'preview', context_id: ctx });
  const layer = steps.find((x) => x.stage === 'semantic_model');
  assert.ok(!layer.measures.some((m) => m.source === 'acquisition') && !layer.metrics.some((m) => m.name === 'spend'), JSON.stringify(layer));
  const built = await engine.raw.build_model({ action: 'materialize', context_id: ctx });
  await taskResult(engine, built.task_id);
  await assert.rejects(() => engine.query_model({ context_id: ctx, steps: [metrics(['spend'])], time_range: WINDOW }), /unknown metric in context: 'spend'/);
  const r = await engine.query_model({ context_id: ctx, steps: [metrics(['evts'])], time_range: WINDOW });
  assert.equal(r.ok, true, JSON.stringify(r.error));
});

test('edit_step and materialize replace the layer: the new metric answers, the old one is gone', opts, async (t) => {
  if (skip(t) || !ctx) return;
  const { steps } = await engine.build_model({ action: 'preview', context_id: ctx });
  const { index } = steps.find((s) => s.stage === 'semantic_model');
  const tutorials = { fn: 'count', args: [{ fn: 'case', cases: [{ when: [{ fn: 'eq', args: [{ column: 'event_name' }, { value: 'tutorial' }] }], then: { value: 1 } }] }] };
  await engine.build_model({ action: 'edit_step', context_id: ctx, index, step: { stage: 'semantic_model', measures: [{ name: 'tutorials', expr: tutorials }], metrics: [{ name: 'tutorials', type: 'simple', measure: 'tutorials' }] } });
  const built = await engine.raw.build_model({ action: 'materialize', context_id: ctx });
  await taskResult(engine, built.task_id);
  const [{ n }] = (await wh.query("select count(*) as n from fct_analytics_events where event_name = 'tutorial'")).rows;
  const r = await engine.query_model({ context_id: ctx, steps: [metrics(['tutorials'])], time_range: WINDOW });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(num(r.rows[0].tutorials), num(n));
  await assert.rejects(() => engine.query_model({ context_id: ctx, steps: [metrics(['evts'])], time_range: WINDOW }), /unknown metric in context: 'evts'. Available: tutorials/);
});

test('describe shows the layer as dbt parsed it; validate runs each metric over the window, as the warehouse counts', opts, async (t) => {
  if (skip(t) || !ctx) return;
  const described = await engine.context({ action: 'describe', context_id: ctx, metric: 'tutorials' });
  assert.equal(described.status.valid, true, JSON.stringify(described.status));
  assert.deepEqual(described.metrics.map((m) => m.name), ['tutorials']);
  const started = await engine.raw.context({ action: 'describe', context_id: ctx, validate: true, time_range: WINDOW });
  const v = await taskResult(engine, started.task_id);
  assert.equal(v.valid, true, JSON.stringify(v));
  const [{ n }] = (await wh.query("select count(*) as n from fct_analytics_events where event_name = 'tutorial'")).rows;
  assert.equal(num(v.ran.metrics.find((x) => x.metric === 'tutorials').value), num(n));
  // the source's dimensions are named as the source names its columns — its time column among them
  const own = v.ran.semantic_models.find((x) => x.semantic_model === 'events');
  assert.ok(own?.checked && own.dimensions.includes('device_time') && !own.dimensions.includes('event_time'), JSON.stringify(own));
});

test('a fork after step N is the build taken back to it: its rows are those of the steps it kept', opts, async (t) => {
  if (skip(t)) return;
  const tutorial = { stage: 'where', conditions: [{ fn: 'eq', args: [{ column: 'event_name' }, { value: 'tutorial' }] }] };
  const perPlayer = { stage: 'aggregate', group_by: ['player_id_of_internal'], measures: [{ name: 'events', expr: { fn: 'count' } }] };
  const s = await engine.build_model({ action: 'start', name: 'fork_src', source: 'events', steps: [tutorial, perPlayer] });
  const back = await engine.build_model({ action: 'fork', context_id: s.context_id, name: 'fork_back', after: 1 });
  assert.equal(back.steps_count, 1);
  const built = await engine.raw.build_model({ action: 'materialize', context_id: back.context_id });
  const done = await taskResult(engine, built.task_id);
  const [{ n }] = (await wh.query("select count(*) as n from fct_analytics_events where event_name = 'tutorial'")).rows;
  assert.equal(done.page?.total_rows ?? done.total_rows ?? done.rows.length, num(n), 'one row per tutorial event: the aggregate is not kept');
  // the original keeps both steps: one row per player who did a tutorial
  const orig = await taskResult(engine, (await engine.raw.build_model({ action: 'materialize', context_id: s.context_id })).task_id);
  const [{ p }] = (await wh.query("select count(distinct player_id_of_internal) as p from fct_analytics_events where event_name = 'tutorial'")).rows;
  assert.equal(orig.page?.total_rows ?? orig.total_rows ?? orig.rows.length, num(p));
  // a build whose every step is built is checked by its build: validate answers so, it is not refused
  const checked = await taskResult(engine, (await engine.raw.build_model({ action: 'preview', context_id: s.context_id, validate: true })).task_id);
  assert.equal(checked.ok, true, JSON.stringify(checked));
  assert.deepEqual(checked.checked, []);
  // the list names each build and says what it holds
  const listed = Object.fromEntries((await engine.context({ action: 'list', limit: 50 })).contexts.map((c) => [c.context_id, c]));
  assert.equal(listed[s.context_id].name, 'fork_src');
  assert.ok(listed[s.context_id].holds.some((h) => /built table/.test(h)), JSON.stringify(listed[s.context_id]));
  // a build whose one step is its semantic layer holds that layer, built
  assert.deepEqual(listed[ctx].holds, ['a semantic layer'], JSON.stringify(listed[ctx]));
  // a step edited after the build: the table is the earlier steps' — the list and a read of it say so
  // (the rows read are still the build's: one per player who did a tutorial)
  await engine.build_model({ action: 'edit_step', context_id: s.context_id, index: 2, step: { ...perPlayer, measures: [{ name: 'n', expr: { fn: 'count' } }] } });
  const relisted = (await engine.context({ action: 'list', limit: 50 })).contexts.find((c) => c.context_id === s.context_id);
  assert.ok(relisted.holds.some((h) => /older than the steps/.test(h)), JSON.stringify(relisted));
  const stale = await engine.query_model({ context_id: s.context_id, steps: [{ stage: 'limit', limit: 1000 }] });
  assert.equal(stale.rows.length, num(p));
  assert.ok((stale.warnings || []).some((w) => /built before the steps changed/.test(w)), JSON.stringify(stale.warnings));
});

test('insert_step and delete_step change the steps in place: the rows are those of the steps the build holds', opts, async (t) => {
  if (skip(t)) return;
  const tutorial = { stage: 'where', conditions: [{ fn: 'eq', args: [{ column: 'event_name' }, { value: 'tutorial' }] }] };
  const perPlayer = { stage: 'aggregate', group_by: ['player_id_of_internal'], measures: [{ name: 'events', expr: { fn: 'count' } }] };
  const s = await engine.build_model({ action: 'start', name: 'ins_del', source: 'events', steps: [perPlayer] });
  const rowsOf = async () => { const r = await taskResult(engine, (await engine.raw.build_model({ action: 'materialize', context_id: s.context_id })).task_id); return r.page?.total_rows ?? r.total_rows ?? r.rows.length; };
  const [{ all }] = (await wh.query('select count(distinct player_id_of_internal) as "all" from fct_analytics_events')).rows;
  const [{ tut }] = (await wh.query("select count(distinct player_id_of_internal) as tut from fct_analytics_events where event_name = 'tutorial'")).rows;
  assert.equal(await rowsOf(), num(all), 'one row per player');
  // the where put in as step 1: the aggregate is step 2 now, and folds the tutorial events only
  const ins = await engine.build_model({ action: 'insert_step', context_id: s.context_id, index: 1, step: tutorial });
  assert.deepEqual([ins.step_index, ins.steps_count], [1, 2]);
  assert.equal(await rowsOf(), num(tut), 'one row per player who did a tutorial');
  // removed again: every player
  const del = await engine.build_model({ action: 'delete_step', context_id: s.context_id, index: 1 });
  assert.equal(del.steps_count, 1);
  assert.equal(await rowsOf(), num(all));
  // a step out of range is refused, naming the range
  await assert.rejects(() => engine.build_model({ action: 'delete_step', context_id: s.context_id, index: 3 }), /delete_step index=3 out of range — the draft has 1 step/);
});

// A DATE column compared with a moment at midnight written ISO, with its zone (2026-01-03T00:00:00Z): the
// day it names — the rows the warehouse keeps for that day — as a date written plainly keeps.
test('a date column against a midnight written ISO keeps the rows of that day on', opts, async (t) => {
  if (skip(t)) return;
  const [{ n }] = (await wh.query("select count(*) as n from fct_analytics_events where event_date >= DATE '2026-01-03'")).rows;
  for (const value of ['2026-01-03T00:00:00Z', '2026-01-03 00:00:00', '2026-01-03']) {
    const out = await engine.build_model({ action: 'start', name: 'iso_day', source: 'events', materialize: true, steps: [
      { stage: 'where', conditions: [{ fn: 'gte', args: [{ column: 'event_date' }, { value }] }] },
      { stage: 'aggregate', measures: [{ name: 'n', expr: { fn: 'count' } }] },
    ] });
    const r = await taskResult(engine, out.materialize.task_id);
    assert.equal(num(r.rows[0].n), num(n), value);
  }
});


// A layer over the table the steps built: a flag column the steps made, declared a dimension by its column,
// reads back as true / false — the player-days of each, as the warehouse counts them.
test('a flag column of a built table, declared a dimension, reads back as a flag', opts, async (t) => {
  if (skip(t)) return;
  const out = await engine.build_model({ action: 'start', name: 'busy_days', source: 'events', materialize: true, steps: [
    { stage: 'compute', name: 'day', expr: { fn: 'date_trunc', grain: 'day', args: [{ column: 'device_time' }] } },
    { stage: 'aggregate', group_by: ['player_id_of_internal', 'day'], measures: [{ name: 'evts', expr: { fn: 'count' } }] },
    { stage: 'compute', name: 'busy', expr: { fn: 'gt', args: [{ column: 'evts' }, { value: 3 }] } },
    { stage: 'semantic_model', time: 'day', dimensions: [{ column: 'busy' }], measures: [{ name: 'player_days', expr: { fn: 'count' } }], metrics: [{ name: 'player_days', type: 'simple', measure: 'player_days' }] },
  ] });
  await taskResult(engine, out.materialize.task_id);
  const r = await engine.query_model({ context_id: out.context_id, steps: [{ stage: 'metrics', metrics: ['player_days'], group_by: [{ semantic_model: ['busy_days'], dimension: 'busy' }] }] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const col = r.group_by_resolved['busy_days.busy'];
  assert.ok(r.rows.every((row) => typeof row[col] === 'boolean'), JSON.stringify(r.rows));
  const want = Object.fromEntries((await wh.query("select n > 3 as b, count(*) as k from (select player_id_of_internal, date_trunc('day', device_time) as d, count(*) as n from fct_analytics_events group by 1, 2) group by 1")).rows.map((x) => [String(x.b), num(x.k)]));
  assert.deepEqual(Object.fromEntries(r.rows.map((row) => [String(row[col]), num(row.player_days)])), want);
});

test('a numeric event property declared a dimension reads back as a number; a series comes in time order; a dry run types its metrics', opts, async (t) => {
  if (skip(t)) return;
  const out = await engine.build_model({ action: 'start', name: 'levels', source: 'events', materialize: true, steps: [
    { stage: 'semantic_model', dimensions: [{ property: 'level_id_of_event_data' }], measures: [{ name: 'evts', expr: { fn: 'count' } }, { name: 'spent', expr: { fn: 'sum', args: [{ column: 'level_id_of_event_data' }] } }], metrics: [{ name: 'evts', type: 'simple', measure: 'evts' }, { name: 'spent', type: 'simple', measure: 'spent' }] },
  ] });
  await taskResult(engine, out.materialize.task_id);
  const level = { source: 'events', property: 'level_id_of_event_data' };
  const r = await engine.query_model({ context_id: out.context_id, time_range: WINDOW, steps: [metrics(['evts'], { group_by: [level] })] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const col = r.group_by_resolved['events.level_id_of_event_data'];
  assert.ok(r.rows.every((row) => row[col] === null || typeof row[col] === 'number'), JSON.stringify(r.rows.slice(0, 5)));
  const want = Object.fromEntries((await wh.query(`select level_id_of_event_data as l, count(*) as k from fct_analytics_events where device_time >= '${WINDOW.start}' and device_time < '2026-02-01' group by 1`)).rows.map((x) => [x.l == null ? 'null' : String(num(x.l)), num(x.k)]));
  assert.deepEqual(Object.fromEntries(r.rows.map((row) => [row[col] == null ? 'null' : String(row[col]), num(row.evts)])), want);
  // with no step after the metrics step, the days come earliest first
  const days = await engine.query_model({ context_id: out.context_id, time_range: WINDOW, steps: [metrics(['evts'], { group_by: [{ time: 'metric_time', grain: 'day' }] })] });
  const dayCol = Object.keys(days.rows[0]).find((k) => k !== 'evts');
  const seen = days.rows.map((row) => String(row[dayCol]));
  assert.deepEqual(seen, [...seen].sort());
  assert.ok(seen.length > 1);
  // a dry run says what its metrics are: a count a whole number, a sum a number
  const dry = await engine.query_model({ context_id: out.context_id, time_range: WINDOW, dry_run: true, steps: [metrics(['evts', 'spent'], { group_by: [level] })] });
  const typeOf = Object.fromEntries(dry.output_columns.map((c) => [c.name, c.type]));
  assert.deepEqual([typeOf.evts, typeOf.spent], ['int', 'numeric']);
});
