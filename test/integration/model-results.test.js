// WHAT A BUILT MODEL ANSWERS, ON DATA — one fixture warehouse and one engine for the governed metrics of
// the monetization and level funnels, their results stored as tables (paged, re-sliced, drawn and
// drilled), the A/B recipes fed into the statistics, and every recipe no other test proves. The files
// this one absorbed each loaded the same warehouse and built the same engine — two of them the same
// revenue metric — so here that setup is paid once, and every test keeps its title and every
// assertion its message. Each section opens with the comment of the file it was. Data-only assertions
// (no SQL/jinja/command text). Auto-skips when dbt/mf are not installed (HAS_DBT gate).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCatalog } from '../../src/catalog.js';
import { loadRecipes } from '../../src/recipes.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { buildWarehouse, fixtureProject } from './warehouse-harness.js';
import { settle, isStartedTask, taskResult, one, startAndBuild } from '../helpers/settle.js';
import { armFrom } from '../helpers/experiment-arm.js';
import { HAS_DBT, testDbt } from '../helpers/dbt-env.js';
import { DATA_TESTED } from '../helpers/recipe-coverage.js';

const BASE = fixtureProject('dbt_project'); // a private copy: the test files run side by side
const opts = { timeout: 300000 };
const num = (v) => Number(v);
const skip = (t) => { if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; } return false; };
const recipes = loadRecipes(join(process.cwd(), 'config', 'recipes.json'));

let wh; let engine; let backend;
const ctxOf = {}; // task name -> context_id
const numOrNaN = (v) => Number(v === '' || v == null ? NaN : v);
const sumCol = (rows, col) => rows.reduce((s, r) => s + (Number.isFinite(numOrNaN(r[col])) ? numOrNaN(r[col]) : 0), 0);
const mapCol = (rows, keyCol, valCol) => Object.fromEntries(rows.map((r) => [String(r[keyCol]), numOrNaN(r[valCol])]));

async function create(decl) {
  const out = await engine.build_semantic_model(decl);
  assert.equal(out.parse.ok, true, `parse failed for ${decl.name}: ${JSON.stringify(out.parse)}`);
  ctxOf[decl.name] = out.context_id;
  return out;
}
const q = (task, args) => engine.query_semantic_model({ context_id: ctxOf[task], ...args });

before(async () => {
  if (!HAS_DBT) return;
  wh = await buildWarehouse(BASE);
  const catalog = loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), { profilesDir: BASE, projectDir: BASE });
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: mkdtempSync(join(tmpdir(), 'results-')), timeSpineDialect: 'duckdb' });
  backend = testDbt({ profilesDir: BASE });
  engine = settle(new Engine({ catalog, contextManager: ctxs, runner: backend }));

  // ---- build the task models once ----

  // Monetization: revenue / payers / purchases / arppu / aov, with a 1-hop join
  // to user attributes and a local product_id event-property dimension.
  await create({
    name: 'mon',
    semantic_models: [{ from: 'events', dimensions: [{ field: 'product_id_of_event_data' }], measures: [{ name: 'revenue', agg: 'sum', field: 'price_in_usd_of_event_data' }, { name: 'payers', agg: 'count_distinct', field: 'player_id_of_internal' }, { name: 'purchases', agg: 'count' }], where: [{ field: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] }, { from: 'users' }],
    metrics: [
      { name: 'revenue', type: 'simple', measure: 'revenue' },
      { name: 'payers', type: 'simple', measure: 'payers' },
      { name: 'purchases', type: 'simple', measure: 'purchases' },
      { name: 'arppu', type: 'ratio', numerator: 'revenue', denominator: 'payers' },
      { name: 'aov', type: 'ratio', numerator: 'revenue', denominator: 'purchases' },
    ],
  });

  // Level funnel: event_name=level_started, the step keyed by the level_id property (1 -> 2 -> 3).
  await create({
    name: 'lvlf',
    semantic_models: [{ from: 'events', measures: [{ name: 'l1', agg: 'count', where: [{ field: 'event_name', op: 'eq', value: 'level_started' }, { field: 'level_id_of_event_data', op: 'eq', value: 1 }] }, { name: 'l2', agg: 'count', where: [{ field: 'event_name', op: 'eq', value: 'level_started' }, { field: 'level_id_of_event_data', op: 'eq', value: 2 }] }, { name: 'l3', agg: 'count', where: [{ field: 'event_name', op: 'eq', value: 'level_started' }, { field: 'level_id_of_event_data', op: 'eq', value: 3 }] }, { name: 'u1', agg: 'count_distinct', field: 'player_id_of_internal', where: [{ field: 'event_name', op: 'eq', value: 'level_started' }, { field: 'level_id_of_event_data', op: 'eq', value: 1 }] }, { name: 'u2', agg: 'count_distinct', field: 'player_id_of_internal', where: [{ field: 'event_name', op: 'eq', value: 'level_started' }, { field: 'level_id_of_event_data', op: 'eq', value: 2 }] }] }],
    metrics: [
      { name: 's1', type: 'simple', measure: 'l1' },
      { name: 's2', type: 'simple', measure: 'l2' },
      { name: 's3', type: 'simple', measure: 'l3' },
      { name: 'p1', type: 'simple', measure: 'u1' },
      { name: 'p2', type: 'simple', measure: 'u2' },
      { name: 'conv_1_2', type: 'ratio', numerator: 'u2', denominator: 'u1' },
    ],
  });
  // (the stored-results section reads mon_revenue from the 'mon' model above: it built a model of its
  // own holding that one metric, the same revenue over the same rows)
}, opts);

after(async () => { backend?.close?.(); if (wh) await wh.stop(); });

// ════════════ MONETIZATION, LEVEL FUNNEL, CONVERSION (was behavior-funnels.test.js) ════════════
// Realistic, scenario-heavy coverage built ONLY from the two documented data
// sources: the events fact (fct_analytics_events) and user attributes
// (dim_users). Joins are 1-hop events.user -> dim_users (user__country,
// user__platform, user__media_source, user__acquisition_type, ...). Funnels use
// events + event_data property values. Exact numbers come from
// test/integration/fixtures/SEED_DATA.md.
//
// What is here is what no other suite asserts: the media_source split, nested / OR where,
// order_by + limit, a metric window over a partitioned source, time_range, week / month grains,
// the level funnel keyed by an event property, and the visit -> purchase conversion as a pipeline.
// The semantic monetization / progression / DAU numbers (country, platform and acquisition_type
// cuts, per-level starts / completes / rates) are analytics-tasks.test.js's, built from the recipes.
//
// HARD RULE: assertions are DATA-ONLY — res.ok / res.row_count and the numeric
// values keyed out of res.rows. No SQL/jinja/command/column-name string checks.
//
// Runs against dbt Core + MetricFlow + DuckDB; auto-skips if dbt/mf absent.

// ───────────────────────── Monetization + 1-hop JOINs ─────────────────────────

// The totals and the two ratios come back side by side in one query (the totals were a test of their
// own, 'monetization: total revenue = 85, payers = 7, purchases = 8', and payers = 7 another).
test('monetization: revenue 85 / payers 7 / purchases 8; ARPPU == revenue/payers and AOV == revenue/purchases', opts, async (t) => {
  if (skip(t)) return;
  const r = await q('mon', { metrics: ['mon_revenue', 'mon_payers', 'mon_purchases', 'mon_arppu', 'mon_aov'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const row = r.rows[0];
  assert.equal(numOrNaN(row.mon_revenue), 85, '[totals] revenue 85');
  assert.equal(numOrNaN(row.mon_payers), 7, '[totals] payers 7 (distinct buyers across the whole month)');
  assert.equal(numOrNaN(row.mon_purchases), 8, '[totals] purchases 8');
  const rev = numOrNaN(row.mon_revenue); const pay = numOrNaN(row.mon_payers); const pur = numOrNaN(row.mon_purchases);
  assert.ok(Math.abs(numOrNaN(row.mon_arppu) - rev / pay) < 1e-6, `[ARPPU] arppu=${row.mon_arppu}`);
  assert.ok(Math.abs(numOrNaN(row.mon_aov) - rev / pur) < 1e-6, `[AOV] aov=${row.mon_aov}`);
});

test('monetization: revenue by users.media_source = meta 25 / organic 30 / google 20 / applovin 10', opts, async (t) => {
  if (skip(t)) return;
  const r = await q('mon', { metrics: ['mon_revenue'], group_by: [{ model: 'users', attribute: 'media_source' }] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const by = mapCol(r.rows, 'users_media_source', 'mon_revenue');
  assert.equal(by.meta, 25); assert.equal(by.organic, 30); assert.equal(by.google, 20); assert.equal(by.applovin, 10);
  assert.equal(sumCol(r.rows, 'mon_revenue'), 85);
});

test('monetization: nested where (country in [US,GB] AND paid) -> 5+10+15+20 = 50', opts, async (t) => {
  if (skip(t)) return;
  // GB paid payers: u3(5), u7(10); US paid payers: u1(15), u10(20) -> 5+10+15+20 = 50
  const r = await q('mon', { metrics: ['mon_revenue'], where: [{ field: { model: 'users', attribute: 'country' }, op: 'in', value: ['US', 'GB'] }, { field: { model: 'users', attribute: 'acquisition_type' }, op: 'eq', value: 'paid' }] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(sumCol(r.rows, 'mon_revenue'), 50);
});

test('monetization: where with OR (US OR BR) -> 35 + 25 = 60', opts, async (t) => {
  if (skip(t)) return;
  const r = await q('mon', { metrics: ['mon_revenue'], where: [{ or: [{ field: { model: 'users', attribute: 'country' }, op: 'eq', value: 'US' }, { field: { model: 'users', attribute: 'country' }, op: 'eq', value: 'BR' }] }] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(sumCol(r.rows, 'mon_revenue'), 60);
});

// (the plain revenue by product_id, p1 15 / p2 30 / p3 40, is analytics-tasks' ratio_metric task)
test('monetization: revenue by product_id, order_by + limit 1: the top product = 40', opts, async (t) => {
  if (skip(t)) return;
  const top = await q('mon', {
    metrics: ['mon_revenue'], group_by: [{ model: 'events', attribute: 'product_id_of_event_data' }],
    where: [{ field: { model: 'events', attribute: 'product_id_of_event_data' }, op: 'is_not_null' }],
    order_by: [{ key: 'mon_revenue', direction: 'desc' }], limit: 1,
  });
  assert.equal(top.ok, true, JSON.stringify(top.error));
  assert.equal(top.row_count, 1);
  assert.equal(numOrNaN(top.rows[0].mon_revenue), 40);
});

// The fixture is partitioned by event_date, so a metric query's window also bounds the partition
// (through the semantic model's partition dimension). A pruning aid only: the numbers are the ones
// the rows give, and the same as with no partition column declared at all. 2026-01-02 in UTC+14 is
// [01-01 10:00, 01-02 10:00) UTC — partly on the previous UTC day.
test('a metric window on a partitioned source: the numbers of the rows, the same with the partition declared as without it', opts, async (t) => {
  if (skip(t)) return;
  const decl = (name) => ({
    name,
    semantic_models: [{ from: 'events', measures: [{ name: 'events', agg: 'count' }] }, { from: 'users' }],
    metrics: [{ name: 'events', type: 'simple', measure: 'events' }],
  });
  const window = { start: '2026-01-02', end: '2026-01-02', timezone: 'Pacific/Kiritimati' };
  const run = async (name) => {
    await create(decl(name));
    const r = await q(name, { metrics: [`${name}_events`], group_by: [{ time: 'metric_time', grain: 'day' }, { model: 'users', attribute: 'platform' }], time_range: window });
    assert.equal(r.ok, true, JSON.stringify(r.error));
    return Object.fromEntries(r.rows.map((x) => [`${String(x.metric_time_day).slice(0, 10)}|${x.users_platform}`, numOrNaN(x[`${name}_events`])]));
  };
  const pruned = await run('part_on');
  const model = engine.catalog.getModel('events');
  const declared = model.partition_column;
  let plain;
  try { model.partition_column = undefined; plain = await run('part_off'); } finally { model.partition_column = declared; }
  assert.deepEqual(pruned, plain);
  // at day grain MetricFlow widens the window to the whole days it touches (01-01 and 01-02 UTC) —
  // so the partition bound must reach the previous UTC day too, or 01-01 would be lost
  const total = Object.values(pruned).reduce((a, b) => a + b, 0);
  const fromRows = Number((await wh.query("select count(*) as n from fct_analytics_events where device_time >= timestamp '2026-01-01' and device_time < timestamp '2026-01-03'")).rows[0].n);
  assert.equal(total, fromRows);
  assert.equal(total, 75);
  // the bound is real: read without the late days, the 5 events that arrived three days late
  // (filed under 01-04) fall outside the partitions the window reads
  const late = model.partition_late_days;
  let early;
  try { model.partition_late_days = 0; early = await run('part_early'); } finally { model.partition_late_days = late; }
  assert.equal(Object.values(early).reduce((a, b) => a + b, 0), 70);
});

test('monetization: time_range 2026-01-04..05 (day grain) -> 10+5+20+10 = 45', opts, async (t) => {
  if (skip(t)) return;
  // o5 u7 10 (01-04), o6 u9 5 (01-04), o7 u10 20 (01-05), o8 u11 10 (01-05)
  const r = await q('mon', { metrics: ['mon_revenue'], group_by: [{ time: 'metric_time', grain: 'day' }], time_range: { start: '2026-01-04', end: '2026-01-05' } });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(sumCol(r.rows, 'mon_revenue'), 45);
});

// (revenue by metric_time day, summing to 85, is analytics-tasks' ratio_metric task)
test('monetization: revenue by week/month sums to 85, in a single month', opts, async (t) => {
  if (skip(t)) return;
  const week = await q('mon', { metrics: ['mon_revenue'], group_by: [{ time: 'metric_time', grain: 'week' }] });
  const month = await q('mon', { metrics: ['mon_revenue'], group_by: [{ time: 'metric_time', grain: 'month' }] });
  for (const r of [week, month]) assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(sumCol(week.rows, 'mon_revenue'), 85, '[week] sums to 85');
  assert.equal(sumCol(month.rows, 'mon_revenue'), 85, '[month] sums to 85');
  // single month in the seed
  assert.equal(month.row_count, 1, '[month] a single month in the seed');
});

// ───────────────────────── Level funnel (event + level_id) ─────────────────────────

// One query carries both of the level funnel's former tests (multistep-funnel.test.js).
test('level funnel: per-level starts 12 / 6 / 3 and the L1->L2 player share', opts, async (t) => {
  if (skip(t)) return;
  const r = await q('lvlf', { metrics: ['lvlf_s1', 'lvlf_s2', 'lvlf_s3', 'lvlf_p1', 'lvlf_p2', 'lvlf_conv_1_2'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const row = r.rows[0];
  // 'level funnel: level_started counts by level_id = 12 / 6 / 3 (monotonic)'
  assert.equal(numOrNaN(row.lvlf_s1), 12, '[level counts] L1');
  assert.equal(numOrNaN(row.lvlf_s2), 6, '[level counts] L2');
  assert.equal(numOrNaN(row.lvlf_s3), 3, '[level counts] L3');
  assert.ok(numOrNaN(row.lvlf_s1) >= numOrNaN(row.lvlf_s2) && numOrNaN(row.lvlf_s2) >= numOrNaN(row.lvlf_s3), '[level counts] monotonic');
  // 'level funnel: the L1->L2 share of players is the L2 players over the L1 players, in (0,1)'
  const v = numOrNaN(row.lvlf_conv_1_2);
  assert.ok(numOrNaN(row.lvlf_p2) > 0 && numOrNaN(row.lvlf_p2) < numOrNaN(row.lvlf_p1), `[L1->L2 share] 0 < L2 players < L1 players: ${JSON.stringify(row)}`);
  assert.ok(Math.abs(v - numOrNaN(row.lvlf_p2) / numOrNaN(row.lvlf_p1)) < 1e-9, `[L1->L2 share] conv_1_2=${v}`);
});

// ───────────────────────── Visit -> purchase conversion ─────────────────────────

// A conversion is a PIPELINE: one row per visitor from the first session, whether a purchase followed —
// the semantic layer declares no conversion metric (MetricFlow would filter its base side only).
const CONVERSION = [
  { stage: 'match_recognize', partition_by: [{ entity: 'user' }], steps: [{ name: 'visit', event_name: ['new_session'] }, { name: 'buy', event_name: ['iap_purchase_completed'] }] },
];
// users is slowly changing: the country a visitor had at the first visit, not every version of it
const BY_COUNTRY = { stage: 'join', with: 'users', via: 'user', between: { column: 'first_seen_at', from: 'install_time_valid_from', to: 'install_time_valid_until' }, attrs: [{ column: 'country' }] };
const converted = { name: 'buyers', agg: 'count', where: [{ column: 'completed', op: 'eq', value: true }] };

test('conversion: visit->purchase — 7 of the 12 visitors bought after a session', opts, async (t) => {
  if (skip(t)) return;
  const out = await engine._buildPipeline({ name: 'conv_all', pipeline: { source: 'events', stages: [...CONVERSION, { stage: 'aggregate', measures: [{ name: 'visitors', agg: 'count' }, converted] }] } });
  assert.equal(out.build?.ok, true, JSON.stringify(out.error || out.build));
  assert.deepEqual([numOrNaN(out.rows[0].visitors), numOrNaN(out.rows[0].buyers)], [12, 7]);
});

test('conversion by users.country: the countries add up to the whole, each a share of its own visitors', opts, async (t) => {
  if (skip(t)) return;
  const out = await engine._buildPipeline({ name: 'conv_country', pipeline: { source: 'events', stages: [...CONVERSION, BY_COUNTRY, { stage: 'aggregate', group_by: ['country'], measures: [{ name: 'visitors', agg: 'count' }, converted] }] } });
  assert.equal(out.build?.ok, true, JSON.stringify(out.error || out.build));
  assert.ok(out.rows.length > 1, 'more than one country');
  assert.deepEqual([out.rows.reduce((a, r) => a + numOrNaN(r.visitors), 0), out.rows.reduce((a, r) => a + numOrNaN(r.buyers), 0)], [12, 7]);
  for (const r of out.rows) assert.ok(numOrNaN(r.buyers) <= numOrNaN(r.visitors), JSON.stringify(r));
});

// ════════════ STORED RESULTS (was materialize.test.js) ═════════════════════════════════════════
// Materialization mode: a query is a task; with materialize:true it is compiled to SQL, written as
// a materialized='table' dbt model named after the task, built (dbt run), and rows are read back
// from that table (dbt show) — results live in the warehouse (resilient, pageable). A stored result
// is re-sliced by a pipeline started from its task (from_task), and a drawn card reads its views
// from it (drill_result: the path taken, the server makes the level). Data-only assertions.

test('materialize: the query is a task whose result is a stored table — rows read back = total revenue 85', opts, async (t) => {
  if (skip(t)) return;
  const r = await engine.query_semantic_model({ context_id: ctxOf.mon, metrics: ['mon_revenue'], materialize: true });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.status, 'done');
  assert.ok(r.task_id && r.table, 'the task and the table it left');
  assert.equal(r.table, `qr_${r.task_id}`);
  assert.equal(num(r.rows[0].mon_revenue), 85);
  globalThis.__matTask = r.task_id;
});

test('resilient re-read: once the in-memory response is gone, query_semantic_model({ task_id }) reads the stored table', opts, async (t) => {
  if (skip(t)) return;
  engine.raw._taskResults.delete(globalThis.__matTask); // what a restart (or an hour) does to the held response
  const r = await one(engine.query_semantic_model({ task_ids: [globalThis.__matTask] }));
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.status, 'done');
  assert.equal(num(r.rows[0].mon_revenue), 85); // recomputes nothing — reads the table
});

// ONE materialized revenue-by-country task carries what three tests each materialized it for: the call
// that starts it never waits, a pipeline started FROM it re-slices it without recomputing, and it is
// paged with query_semantic_model({ task_ids }) to its end. Each check is labelled with its old test.
test('one materialized revenue-by-country task: started without waiting, read back (sum 85), re-sliced by pipelines from its task, and paged to its end', opts, async (t) => {
  if (skip(t)) return;
  // 'the call that starts a query never waits: a task_id now, the rows from query_semantic_model({ task_id })'
  const started = await engine.raw.query_semantic_model({ context_id: ctxOf.mon, metrics: ['mon_revenue'], group_by: [{ model: 'users', attribute: 'country' }], materialize: true });
  assert.ok(isStartedTask(started), `[never waits] a task_id now: ${JSON.stringify(started)}`);
  const m = await taskResult(engine, started.task_id);
  assert.equal(m.ok, true, JSON.stringify(m.error));
  assert.equal(m.status, 'done', '[never waits] the rows from the task');
  assert.equal(m.rows.reduce((s, x) => s + num(x.mon_revenue), 0), 85, '[never waits] revenue by country sums to the grand total');

  // 'a pipeline started FROM a stored result re-slices it without recomputing (where / aggregate / a filter on the aggregate)'
  const from = async (name, stages) => {
    const d = await engine.build_pipeline_model({ action: 'start', name, from_task: m.task_id });
    assert.equal(d.reads, m.table, '[from_task] the draft reads the task\'s table');
    await engine.build_pipeline_model({ action: 'add_steps', context_id: d.context_id, stages });
    const built = await engine.build_pipeline_model({ action: 'materialize', context_id: d.context_id });
    assert.equal(built.status, 'done', JSON.stringify(built.error));
    return built.rows;
  };
  // (a) compress to a single total
  const [total] = await from('total', [{ stage: 'aggregate', measures: [{ name: 'total', agg: 'sum', column: 'mon_revenue' }] }]);
  assert.equal(num(total.total), 85, '[from_task] (a) the total');
  // (b) one country -> exact seed value (US revenue = 35)
  const [us] = await from('only_us', [{ stage: 'where', conditions: [{ column: 'users_country', op: 'eq', value: 'US' }] }, { stage: 'aggregate', measures: [{ name: 'rev', agg: 'sum', column: 'mon_revenue' }] }]);
  assert.equal(num(us.rev), 35, '[from_task] (b) US');
  // (c) group, then keep the groups whose total clears a bar
  const big = await from('big', [
    { stage: 'aggregate', group_by: ['users_country'], measures: [{ name: 'rev', agg: 'sum', column: 'mon_revenue' }] },
    { stage: 'where', conditions: [{ column: 'rev', op: 'gte', value: 25 }] },
  ]);
  assert.ok(big.length >= 1 && big.every((r) => num(r.rev) >= 25), '[from_task] (c) the groups that clear the bar');
  assert.ok(big.reduce((s, r) => s + num(r.rev), 0) <= 85, '[from_task] (c) within the total');

  // 'a stored result is paged with query_semantic_model({ task_id }): limit/offset + has_more reconstruct it'
  const full = await one(engine.query_semantic_model({ task_ids: [m.task_id], limit: 1000 }));
  const rowCount = full.row_count;
  assert.ok(rowCount >= 2, `[paged] expected multiple country rows, got ${rowCount}`);
  // page through in chunks of 2; has_more drives the loop and must terminate.
  const collected = [];
  let offset = 0; let last; let guard = 0;
  do {
    last = await one(engine.query_semantic_model({ task_ids: [m.task_id], limit: 2, offset }));
    assert.equal(last.ok, true, JSON.stringify(last.error));
    collected.push(...last.rows);
    offset += 2;
  } while (last.page.has_more && guard++ < 20);
  assert.equal(last.page.has_more, false, '[paged] terminates on the last page');
  assert.equal(collected.length, rowCount, '[paged] pages cover every row exactly');
  assert.equal(collected.reduce((s, x) => s + num(x.mon_revenue), 0), 85, '[paged] the pages sum to the total');
});

test('a drawn card reads its views from its own task: a row opens into a level that adds up to it, a path value is bound as a literal', opts, async (t) => {
  if (skip(t)) return;
  const m = await engine.query_semantic_model({ context_id: ctxOf.mon, metrics: ['mon_revenue'], group_by: [{ model: 'users', attribute: 'country' }, { model: 'users', attribute: 'platform' }], materialize: true });
  const card = await engine.display_model_result({ task_id: m.task_id, display: { kind: 'pivot', levels: [{ column: 'users_country' }, { column: 'users_platform' }], values: [{ column: 'mon_revenue' }] } });
  assert.equal(card.drawn, true, JSON.stringify(card).slice(0, 300));
  assert.equal(card.rows.reduce((s, r) => s + num(r.mon_revenue), 0), 85, 'the top level is the whole result, folded by country');
  // the card opens the US row: the path taken, and the server reads the next level (platform) under it
  const us = await engine.drill_result({ task_id: m.task_id, path: [{ column: 'users_country', value: 'US' }] });
  assert.equal(us.ok, true, JSON.stringify(us.error));
  assert.ok(us.rows.length >= 1);
  assert.equal(us.rows.reduce((s, r) => s + num(r.mon_revenue), 0), 35, 'US by platform adds up to US');
  // injection/escaping proven on DATA: a path value containing a quote+SQL is bound as a literal ->
  // the read runs safely and simply matches nothing.
  const inj = await engine.drill_result({ task_id: m.task_id, path: [{ column: 'users_country', value: "US'); drop table x; --" }] });
  assert.equal(inj.ok, true, JSON.stringify(inj.error));
  assert.equal(inj.rows.length, 0);
});

// QUERYING A BUILT PIPELINE MODEL: query_pipeline_model({ context_id, transform }) filters, groups
// and aggregates the stored table without recomputing it. A count with a `column` must count
// NON-NULL values (COUNT(column)), NOT rows (COUNT(*)). Proven on DATA: a pipeline derives
// `price` (populated only on iap_purchase_completed, NULL on every other event), so count(price) <
// count(*), and count(price) + (rows where price IS NULL) == count(*). A regression to COUNT(*) makes
// them equal. A value carrying SQL is bound as a literal.
test('query_pipeline_model over a built model: count(column) counts NON-NULL only, values are literals', opts, async (t) => {
  if (skip(t)) return;
  const s = await engine.build_pipeline_model({ action: 'start', name: 'nullcount', source: 'events' });
  await engine.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, stages: [{ stage: 'compute', name: 'price', expr: { fn: 'event_property', property: 'price_in_usd_of_event_data', type: 'numeric' } }] });
  const mat = await engine.build_pipeline_model({ action: 'materialize', context_id: s.context_id });
  assert.equal(mat.build?.ok, true, JSON.stringify(mat.error || mat.build));
  const started = await engine.raw.query_pipeline_model({ context_id: s.context_id, transform: { measures: [{ agg: 'count', name: 'total' }] } });
  assert.ok(isStartedTask(started), 'a query over a built model is a task too');
  const totalR = await taskResult(engine, started.task_id);
  const read = (transform) => engine.query_pipeline_model({ context_id: s.context_id, transform });
  const nnR = await read({ measures: [{ agg: 'count', column: 'price', name: 'nn' }] });
  const nullR = await read({ where: [{ column: 'price', op: 'is_null' }], measures: [{ agg: 'count', name: 'nulls' }] });
  assert.equal(totalR.ok !== false && nnR.ok !== false && nullR.ok !== false, true, JSON.stringify({ totalR: totalR.error, nnR: nnR.error, nullR: nullR.error }));
  const total = num(totalR.rows[0].total); const nonNull = num(nnR.rows[0].nn); const nulls = num(nullR.rows[0].nulls);
  assert.ok(nulls > 0, `fixture must have NULL price rows, got ${nulls}`);
  assert.ok(nonNull < total, `count(price)=${nonNull} must exclude NULLs (< total ${total}) — a COUNT(*) regression makes them equal`);
  assert.equal(nonNull + nulls, total, `count(column) + null_count must equal count(*): ${nonNull} + ${nulls} != ${total}`);
  // grouped: the priced rows per event name add back up to the non-NULL count, and only purchase events carry a price
  const byEvent = await read({ where: [{ column: 'price', op: 'is_not_null' }], group_by: ['event_name'], measures: [{ agg: 'count', column: 'price', name: 'n' }] });
  assert.ok(byEvent.rows.every((r) => String(r.event_name).startsWith('iap_purchase')), JSON.stringify(byEvent.rows));
  assert.equal(byEvent.rows.reduce((a, r) => a + num(r.n), 0), nonNull);
  // injection/escaping proven on DATA: the literal matches nothing, and the query runs
  const inj = await read({ where: [{ column: 'event_name', op: 'eq', value: "x'); drop table x; --" }], measures: [{ agg: 'count', name: 'n' }] });
  assert.equal(num(inj.rows[0].n), 0);
  // a read sorts as the order_by stage does: NULL prices last unless a key asks them first, on every warehouse
  const first = async (key) => (await engine.query_pipeline_model({ context_id: s.context_id, transform: { order_by: [key, { key: 'event_id' }] }, limit: 1 })).rows[0].price;
  const extremes = await read({ measures: [{ agg: 'min', column: 'price', name: 'lo' }, { agg: 'max', column: 'price', name: 'hi' }] });
  assert.equal(num(await first({ key: 'price' })), num(extremes.rows[0].lo));
  assert.equal(num(await first({ key: 'price', direction: 'desc' })), num(extremes.rows[0].hi));
  assert.equal(await first({ key: 'price', nulls: 'first' }), null);
  assert.equal(await first({ key: 'price', direction: 'desc', nulls: 'first' }), null);
  // a semantic context is not a pipeline model
  await assert.rejects(() => engine.query_pipeline_model({ context_id: ctxOf.mon }), /no built pipeline model/);
});

// A CONDITIONAL aggregate and a SECOND level over a built model: per player, how many level starts
// and completes (count … where), then how many players there are and how many completed at least
// once (the groups counted, a per-group condition) — all read from the stored table, checked against
// the rows. And a lag over a text column is text in the schema, as its values are.
test('query_pipeline_model: conditional aggregates and a second level count the groups, as the rows do; a lag of text is text', opts, async (t) => {
  if (skip(t)) return;
  const src = (await wh.query('select player_id_of_internal as u, event_name as e from fct_analytics_events')).rows;
  const per = new Map();
  for (const r of src) { const p = per.get(r.u) || { s: 0, c: 0 }; if (r.e === 'level_started') p.s += 1; if (r.e === 'level_completed') p.c += 1; per.set(r.u, p); }
  const s = await engine.build_pipeline_model({ action: 'start', name: 'two_levels', source: 'events' });
  const step = await engine.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, include_columns: true, stages: [{ stage: 'compute', name: 'prev_event', expr: { fn: 'lag', args: [{ column: 'event_name' }], over: { partition_by: ['player_id_of_internal'], order_by: [{ key: 'device_time' }, { key: 'event_id' }] } } }] });
  assert.equal(step.available_columns.find((c) => c.name === 'prev_event')?.type, 'string', 'a lag of event_name is text');
  const mat = await engine.build_pipeline_model({ action: 'materialize', context_id: s.context_id });
  assert.equal(mat.build?.ok, true, JSON.stringify(mat.error || mat.build));
  const prev = await engine.query_pipeline_model({ context_id: s.context_id, transform: { where: [{ column: 'prev_event', op: 'is_not_null' }], group_by: ['prev_event'], measures: [{ agg: 'count', name: 'n' }] } });
  assert.ok(prev.rows.every((r) => typeof r.prev_event === 'string' && src.some((x) => x.e === r.prev_event)), 'its values are event names');
  const r = await engine.query_pipeline_model({ context_id: s.context_id, transform: {
    group_by: ['player_id_of_internal'],
    measures: [
      { agg: 'count', where: [{ column: 'event_name', op: 'eq', value: 'level_started' }], name: 'starts' },
      { agg: 'count', where: [{ column: 'event_name', op: 'eq', value: 'level_completed' }], name: 'completes' },
    ],
    then: { measures: [
      { agg: 'count', name: 'players' },
      { agg: 'count', where: [{ column: 'completes', op: 'gt', value: 0 }], name: 'completed_once' },
      { agg: 'sum', column: 'starts', name: 'starts' },
    ] },
  } });
  assert.equal(r.ok !== false, true, JSON.stringify(r.error));
  assert.equal(r.rows.length, 1);
  const row = r.rows[0];
  assert.equal(num(row.players), per.size);
  assert.equal(num(row.completed_once), [...per.values()].filter((p) => p.c > 0).length);
  assert.equal(num(row.starts), [...per.values()].reduce((a, p) => a + p.s, 0));
  // a second level reads the first's columns only
  await assert.rejects(() => engine.query_pipeline_model({ context_id: s.context_id, transform: { group_by: ['player_id_of_internal'], measures: [{ agg: 'count', name: 'n' }], then: { measures: [{ agg: 'sum', column: 'event_name', name: 's' }] } } }), /then\.measures/);
});

// PAGING IS THE READ'S: a read's offset/limit are row numbers of the task's result. A query keeps the
// first `limit` rows of it (a page past them is told it was not kept); a stored result pages to its
// last row, its first answer included — a page past the rows the task holds is read from the table.
test('a held result pages by its row numbers, and a page past the rows it kept says how to have them', opts, async (t) => {
  if (skip(t)) return;
  const order_by = [{ key: 'users_country', direction: 'asc' }];
  const full = await engine.query_semantic_model({ context_id: ctxOf.mon, metrics: ['mon_revenue'], group_by: [{ model: 'users', attribute: 'country' }], order_by });
  assert.ok(full.rows.length >= 3, `expected at least 3 country rows, got ${full.rows.length}`);
  const countries = full.rows.map((r) => r.users_country);
  // the task keeps its first 2 rows
  const started = await engine.raw.query_semantic_model({ context_id: ctxOf.mon, metrics: ['mon_revenue'], group_by: [{ model: 'users', attribute: 'country' }], order_by, limit: 2 });
  await taskResult(engine.raw, started.task_id);
  const second = await one(engine.query_semantic_model({ task_ids: [started.task_id], offset: 1, limit: 1 }));
  assert.deepEqual(second.rows.map((r) => r.users_country), [countries[1]], 'offset 1 is the result\'s second row');
  assert.equal(Number(second.rows[0].mon_revenue), Number(full.rows[1].mon_revenue));
  assert.equal(second.page.offset, 1);
  // a page that reaches past the 2 rows kept: the rows kept, more exist, and no row number reads them
  const page = await one(engine.query_semantic_model({ task_ids: [started.task_id] }));
  assert.deepEqual(page.rows.map((r) => r.users_country), countries.slice(0, 2));
  assert.equal(page.page.has_more, true);
  assert.equal(page.page.next_offset, undefined);
  assert.equal(page.page.held_rows, 2);
  assert.ok(page.warnings.some((w) => /larger limit/.test(w)), JSON.stringify(page.warnings));
});

test('a stored result pages to its last row: a page past the rows the task holds is read from its table', opts, async (t) => {
  if (skip(t)) return;
  const group_by = [{ model: 'users', attribute: 'country' }];
  // the task holds 1 row of its result; the table stores them all
  const m = await engine.raw.query_semantic_model({ context_id: ctxOf.mon, metrics: ['mon_revenue'], group_by, materialize: true, limit: 1 });
  const held = await taskResult(engine.raw, m.task_id);
  assert.equal(held.status, 'done', JSON.stringify(held.error));
  const all = await one(engine.query_semantic_model({ task_ids: [m.task_id] }));
  assert.ok(all.rows.length >= 3, 'the first page is the result\'s, not the one row held');
  assert.equal(all.page.has_more, false);
  assert.equal(all.page.total_rows, all.rows.length);
  assert.equal(all.rows.reduce((s, r) => s + num(r.mon_revenue), 0), 85);
  // row by row, by row number: the same rows as that page, in its order
  const one1 = await one(engine.query_semantic_model({ task_ids: [m.task_id], offset: 1, limit: 1 }));
  assert.deepEqual(one1.rows, [all.rows[1]]);
  assert.equal(one1.page.next_offset, 2);
  // a page that starts past the last row holds none, and counts the rows there are
  const past = await one(engine.query_semantic_model({ task_ids: [m.task_id], offset: all.rows.length + 10 }));
  assert.deepEqual([past.rows, past.page.total_rows, past.page.has_more], [[], all.rows.length, false]);
  // a card draws the rows the task keeps
  const card = await engine.display_model_result({ task_id: m.task_id, display: { kind: 'bar', x: 'users_country', y: ['mon_revenue'] } });
  assert.equal(card.rows.length, 1);
  // …once its answer is gone too (a restart): the task's 2 rows, read from the table, not a default
  const two = await engine.raw.query_semantic_model({ context_id: ctxOf.mon, metrics: ['mon_revenue'], group_by, materialize: true, limit: 2 });
  assert.equal((await taskResult(engine.raw, two.task_id)).status, 'done');
  engine.raw._taskResults.delete(two.task_id);
  const late = await engine.display_model_result({ task_id: two.task_id, display: { kind: 'bar', x: 'users_country', y: ['mon_revenue'] } });
  assert.equal(late.drawn, true, JSON.stringify(late.error));
  assert.equal(late.rows.length, 2);
  for (const r of late.rows) assert.ok(all.rows.some((a) => a.users_country === r.users_country && num(a.mon_revenue) === num(r.mon_revenue)), JSON.stringify(r));
});

test('a pipeline build pages its stored table to the last row, and a projection keeps its first limit rows', opts, async (t) => {
  if (skip(t)) return;
  const truth = (await wh.query('select event_id from fct_analytics_events order by event_id')).rows.map((r) => r.event_id);
  assert.ok(truth.length > 100, `expected more than two pages of events, got ${truth.length}`);
  const started = await engine.raw.build_pipeline_model({ action: 'start', name: 'paged_events', source: 'events', stages: [{ stage: 'project', keep: ['event_id', 'event_name'] }, { stage: 'order_by', keys: [{ key: 'event_id' }] }], materialize: true });
  const built = { task_id: started.materialize?.task_id, context_id: started.context_id };
  assert.ok(built.task_id, JSON.stringify(started));
  const first = await taskResult(engine.raw, built.task_id);
  assert.equal(first.status, 'done', JSON.stringify(first.error));
  // page through the build's task by next_offset: every event once, past the 50 rows its answer holds
  const seen = []; const sizes = [];
  let offset = 0;
  for (let guard = 0; guard < 20; guard += 1) {
    const page = await one(engine.query_pipeline_model({ task_ids: [built.task_id], offset }));
    assert.equal(page.status, 'done', JSON.stringify(page.error));
    assert.equal(page.page.offset, offset);
    seen.push(...page.rows.map((r) => r.event_id)); sizes.push(page.rows.length);
    if (!page.page.has_more) { assert.equal(page.page.total_rows, truth.length); break; }
    offset = page.page.next_offset;
  }
  assert.deepEqual([...seen].sort(), [...truth].sort(), 'the pages hold every event exactly once');
  assert.deepEqual(sizes.slice(0, -1).every((n) => n === 50), true, `pages of 50: ${sizes.join(', ')}`);
  // a page across the end of the rows held is the table's, as a read of it again
  const across = await one(engine.query_pipeline_model({ task_ids: [built.task_id], offset: 45, limit: 10 }));
  assert.deepEqual(across.rows.map((r) => r.event_id), seen.slice(45, 55));
  // …with where its rows come from, and not the build's own SQL, said once with its first page
  assert.deepEqual([across.provenance?.tier, across.model_sql], ['pipeline', undefined]);
  // a build that ends unsorted says so on every page — those read from its table past the rows held too —
  // and its pages still hold every row once
  const loose = await engine.raw.build_pipeline_model({ action: 'start', name: 'loose_events', source: 'events', stages: [{ stage: 'project', keep: ['event_id'] }], materialize: true });
  assert.equal((await taskResult(engine.raw, loose.materialize?.task_id)).status, 'done');
  const pages = [];
  for (let off = 0; off != null && pages.length < 20;) {
    const p = await one(engine.query_pipeline_model({ task_ids: [loose.materialize.task_id], offset: off }));
    pages.push(p); off = p.page.next_offset;
  }
  assert.ok(pages.length > 1, 'more than one page');
  assert.ok(pages.every((p) => p.page.ordered === false), JSON.stringify(pages.map((p) => p.page)));
  assert.deepEqual(pages.flatMap((p) => p.rows.map((r) => r.event_id)).sort(), [...truth].sort());
  await engine._deletePipelineModel({ context_id: loose.context_id });
  // a projection over the built model keeps its first 60 rows: a read pages them by row number
  const q = await engine.raw.query_pipeline_model({ context_id: built.context_id, transform: { order_by: [{ key: 'event_id' }] }, limit: 60 });
  await taskResult(engine.raw, q.task_id);
  const tail = await one(engine.query_pipeline_model({ task_ids: [q.task_id], offset: 50 }));
  assert.deepEqual(tail.rows.map((r) => r.event_id), [...truth].sort().slice(50, 60));
  assert.equal(tail.page.has_more, true);
  assert.equal(tail.page.next_offset, undefined, 'rows past the 60 kept are not read by a row number');
  await engine._deletePipelineModel({ context_id: built.context_id });
});

// A READ'S MEASURE is the aggregate stage's, written by the same writer: it merges a sketch a pipeline
// stored, and counts distinct approximately (exact on DuckDB) — SEED_DATA: 7 distinct buyers over 3
// products (3 + 3 + 2 per product: u1 bought twice).
test('a read merges a stored sketch with hll_merge and counts with approx_count_distinct: 7 buyers, not 8', opts, async (t) => {
  if (skip(t)) return;
  const purchases = { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] };
  const sketched = await engine._buildPipeline({ name: 'buyer_sketch', pipeline: { source: 'events', stages: [
    purchases,
    { stage: 'compute', name: 'pid', expr: { fn: 'event_property', property: 'product_id_of_event_data', type: 'string' } },
    { stage: 'aggregate', group_by: ['pid'], measures: [{ name: 'sk', agg: 'hll_init', column: 'player_id_of_internal' }, { name: 'n', agg: 'count_distinct', column: 'player_id_of_internal' }] },
  ] } });
  assert.equal(sketched.build?.ok, true, JSON.stringify(sketched.error || sketched.build));
  const merged = await engine.query_pipeline_model({ context_id: sketched.context_id, transform: { measures: [{ name: 'buyers', agg: 'hll_merge', column: 'sk' }, { name: 'naive', agg: 'sum', column: 'n' }] } });
  assert.equal(merged.ok !== false, true, JSON.stringify(merged.error));
  assert.equal(num(merged.rows[0].buyers), 7);
  assert.equal(num(merged.rows[0].naive), 8);
  const raw = await engine._buildPipeline({ name: 'buyer_rows', pipeline: { source: 'events', stages: [purchases] } });
  const approx = await engine.query_pipeline_model({ context_id: raw.context_id, transform: { measures: [{ name: 'buyers', agg: 'approx_count_distinct', column: 'player_id_of_internal' }, { name: 'exact', agg: 'count_distinct', column: 'player_id_of_internal' }] } });
  assert.equal(num(approx.rows[0].buyers), 7);
  assert.equal(num(approx.rows[0].exact), 7);
  await engine._deletePipelineModel({ context_id: sketched.context_id });
  await engine._deletePipelineModel({ context_id: raw.context_id });
});

// A description is metadata, and metadata must not be able to change a number. It travels into the
// generated model's config banner (a SQL comment), so the way to prove it is inert is to build the
// SAME pipeline twice — once labelled, once not — and compare the ROWS, not the SQL text.
test('a described pipeline builds and returns exactly the rows of the same pipeline unlabelled', opts, async (t) => {
  if (skip(t)) return;
  const stages = [
    { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] },
    { stage: 'compute', name: 'price', expr: { fn: 'event_property', property: 'price_in_usd_of_event_data', type: 'numeric' } },
    { stage: 'aggregate', group_by: ['player_id_of_internal'], measures: [{ name: 'revenue', agg: 'sum', column: 'price' }, { name: 'purchases', agg: 'count' }] },
    { stage: 'order_by', keys: [{ key: 'player_id_of_internal', direction: 'asc' }] },
  ];
  const build = async (name, description) => {
    const out = await engine._buildPipeline({ name, ...(description ? { description } : {}), pipeline: { source: 'events', stages } });
    assert.equal(out.build?.ok, true, JSON.stringify(out.error || out.build));
    return out;
  };

  const plain = await build('descr_plain');
  const labelled = await build('descr_labelled', 'revenue per payer — the weekly monetization readout');

  const norm = (rows) => rows.map((r) => [String(r.player_id_of_internal), Number(r.revenue), Number(r.purchases)]);
  assert.ok(labelled.rows.length > 0, 'the labelled build returned rows');
  assert.deepEqual(norm(labelled.rows), norm(plain.rows), 'the label changed no value');
  // …and the label is what the context now says this model is for
  const described = await engine.context({ action: 'describe', context_id: labelled.context_id });
  assert.equal(described.models?.[0]?.description, 'revenue per payer — the weekly monetization readout');
  await engine._deletePipelineModel({ context_id: plain.context_id });
  await engine._deletePipelineModel({ context_id: labelled.context_id });
});

// ════════════ A/B RECIPES INTO THE STATISTICS (was ab-test.test.js) ════════════════════════════
// DB-level A/B integration test: compute the per-variant PRELIMINARY AGGREGATES
// in the warehouse (DuckDB + dbt) by materializing each A/B recipe's pipeline as a
// real model, read back the per-variant rows, then compute the FINAL STATISTICS
// (mean / CUPED / ratio) via experiment({ action: 'analyze' }). We assert on the NUMBERS the
// tool returns — derived by hand from the seed — proving the full path:
//   events + experiments  ──pipeline──▶  per-variant rows  ──experiment analyze──▶  stats.
// The proportion recipe (experiment_conversion) and the SRM check run in end-to-end.test.js (5a–5c).
//
// Seed facts (window = experiment assignment 2026-01-01 → 2026-02-01):
//   experiments  control  = {u1,u3,u5,u7,u9,u11}   variant_b = {u2,u4,u6,u8,u10,u12}
//   iap purchases (price): u1=5+10, u3=5, u5=20, u7=10, u9=5, u11=10, u10=20
//   ⇒ conversion: control 6/6 = 1.0 ; variant_b 1/6 ≈ 0.1667 (only u10)
//   ⇒ revenue/user mean: control 65/6 ≈ 10.8333 ; variant_b 20/6 ≈ 3.3333
//   ⇒ CUPED: no events precede assigned_at ⇒ θ = 0 ⇒ adjusted == raw mean test.

const near = (a, b, tol = 1e-3) => assert.ok(Math.abs(a - b) <= tol, `${a} ≈ ${b}`);
const recipe = (id) => recipes.list.find((r) => r.id === id);

// Materialize a recipe's pipeline in the warehouse and return its per-variant rows
// keyed by variant_group (control / variant_b), plus a cleanup handle.
async function aggregatesFor(id) {
  const r = recipe(id);
  const out = await startAndBuild(engine, r.pipeline_payload); // the recipe's start request, as it is served
  assert.equal(out.build.ok, true, `build failed for ${id}: ${JSON.stringify(out.error || out.build)}`);
  const map = r.experiment;
  const byGroup = {};
  for (const row of out.rows) byGroup[String(row[map.group_field])] = row;
  return { map, byGroup, context_id: out.context_id };
}

// Turn one per-variant row into an experiment arm using the recipe's arm template.
const arm = armFrom;

test('revenue/user: DB aggregates → Welch t-test (means 10.833 vs 3.333)', opts, async (t) => {
  if (!HAS_DBT) return t.skip('dbt/mf not installed');
  const { map, byGroup, context_id } = await aggregatesFor('experiment_revenue');
  try {
    assert.equal(Number(byGroup.control.n), 6);
    assert.equal(Number(byGroup.variant_b.n), 6);
    near(Number(byGroup.control.rev_mean), 65 / 6);   // (15+5+20+10+5+10)/6
    near(Number(byGroup.variant_b.rev_mean), 20 / 6); // only u10 = 20

    const res = engine._analyzeExperiment({ metric: map.metric, control: arm(map, byGroup.control), variants: [arm(map, byGroup.variant_b)] });
    assert.equal(res.ok, true);
    const v = res.results[0];
    near(v.control_mean, 65 / 6);
    near(v.variant_mean, 20 / 6);
    near(v.absolute_lift, 20 / 6 - 65 / 6);
    assert.ok(Number.isFinite(v.p_value) && v.p_value >= 0 && v.p_value <= 1);
  } finally { await engine._deletePipelineModel({ context_id }); }
});

test('CUPED: DB sufficient statistics → adjusted t-test (θ=0 with no pre-period)', opts, async (t) => {
  if (!HAS_DBT) return t.skip('dbt/mf not installed');
  const { map, byGroup, context_id } = await aggregatesFor('experiment_cuped');
  try {
    assert.equal(Number(byGroup.control.n), 6);
    assert.equal(Number(byGroup.variant_b.n), 6);
    near(Number(byGroup.control.sum_y), 65);  // Σ in-experiment revenue (control)
    near(Number(byGroup.variant_b.sum_y), 20);
    near(Number(byGroup.control.sum_x), 0);   // no events precede assigned_at ⇒ X≡0
    near(Number(byGroup.variant_b.sum_x), 0);

    const res = engine._analyzeExperiment({ metric: map.metric, control: arm(map, byGroup.control), variants: [arm(map, byGroup.variant_b)] });
    assert.equal(res.ok, true);
    near(res.theta, 0, 1e-9);                 // Var(X)=0 ⇒ θ=0 ⇒ CUPED == plain test
    const v = res.results[0];
    near(v.theta, 0, 1e-9);
    near(v.variance_reduction, 0, 1e-9);      // no covariate signal removed
    near(v.control_mean, 65 / 6);             // adjusted mean == raw mean
    near(v.variant_mean, 20 / 6);
    assert.ok(Number.isFinite(v.p_value) && v.p_value >= 0 && v.p_value <= 1);
  } finally { await engine._deletePipelineModel({ context_id }); }
});

test('ratio: DB per-user sums → delta-method test (level completion 16/16 vs 10/12)', opts, async (t) => {
  if (!HAS_DBT) return t.skip('dbt/mf not installed');
  const { map, byGroup, context_id } = await aggregatesFor('experiment_ratio');
  try {
    assert.equal(Number(byGroup.control.n), 6);
    assert.equal(Number(byGroup.variant_b.n), 6);
    // completed (numerator) / started (denominator), summed over the group's users
    near(Number(byGroup.control.sum_num), 15); near(Number(byGroup.control.sum_den), 16);   // 15 of 16 started levels completed
    near(Number(byGroup.variant_b.sum_num), 10); near(Number(byGroup.variant_b.sum_den), 12); // 10 of 12 completed

    const res = engine._analyzeExperiment({ metric: map.metric, control: arm(map, byGroup.control), variants: [arm(map, byGroup.variant_b)] });
    assert.equal(res.ok, true);
    const v = res.results[0];
    near(v.control_ratio, 15 / 16);      // 0.9375
    near(v.variant_ratio, 10 / 12);      // ≈ 0.8333
    near(v.absolute_lift, 10 / 12 - 15 / 16);
    assert.ok(Number.isFinite(v.p_value) && v.p_value >= 0 && v.p_value <= 1);
  } finally { await engine._deletePipelineModel({ context_id }); }
});

// ════════════ EVERY RECIPE RUNS (was recipes-parse.test.js) ════════════════════════════════════
// Every recipe must be RUNNABLE end-to-end: its semantic_payload parses (dbt parse)
// and its first example query executes (mf query); its pipeline_payload — a build_pipeline_model
// start request — is sent AS IT STANDS, with materialize: true, and its build returns rows. This
// guarantees the recipes we hand to the agent are requests the tools take, and compute.
//
// What this loop leaves to others, so nothing is run twice: a recipe another test builds from its
// own payload and proves on its numbers (DATA_TESTED, test/helpers/recipe-coverage.js), and the kinds
// that never read the warehouse — a PYTHON-model recipe (compiled and gated in
// test/unit/python-stage.test.js), a generated REFERENCE entry and a tool-only recipe
// (test/unit/recipes-layers.test.js). Any recipe not covered there, a new one included, runs here.

// The recipes only this loop proves: not data-tested elsewhere, and of a kind that reads the warehouse.
const RUN_HERE = recipes.list.filter((r) => !DATA_TESTED[r.id] && !r.reference && r.requires !== 'python_models' && !r.tool_calls);

for (const r of RUN_HERE) {
  test(`recipe '${r.id}' is runnable end-to-end`, opts, async (t) => {
    if (!HAS_DBT) return t.skip('dbt/mf not installed');

    // Pipeline recipe (e.g. A/B): its start request, built in the same call, then — if it
    // declares an experiment mapping (analyze, or check_split) — its per-group rows fed into the test.
    if (r.pipeline_payload) {
      const out = await startAndBuild(engine, r.pipeline_payload);
      assert.equal(out.build.ok, true, `build failed for ${r.id}: ${JSON.stringify(out.error || out.build)}`);
      // A recipe that feeds a two-group test needs its groups; one that collapses the table to a
      // single row of statistics (the table-wide aggregate) is correct at exactly one row.
      const least = r.experiment ? 2 : 1;
      assert.ok(Array.isArray(out.rows) && out.rows.length >= least, `${r.id} expected >=${least} row(s), got ${out.rows?.length}`);
      if (r.experiment?.action === 'analyze') {
        const map = r.experiment;
        const arms = out.rows.map((row) => armFrom(map, row));
        const [control, ...variants] = arms;
        const res = engine._analyzeExperiment({ metric: map.metric, control, variants });
        assert.equal(res.ok, true, `experiment analyze failed for ${r.id}: ${JSON.stringify(res)}`);
        assert.equal(res.results.length, variants.length);
        for (const v of res.results) assert.ok(Number.isFinite(v.p_value) && v.p_value >= 0 && v.p_value <= 1, `bad p_value for ${r.id}`);
      }
      if (r.experiment?.action === 'check_split') {
        const map = r.experiment;
        const groups = out.rows.map((row) => armFrom(map, row));
        const res = engine._checkSplit({ groups, ...(map.expected_ratio ? { expected_ratio: map.expected_ratio } : {}) });
        assert.equal(res.ok, true, `experiment check_split failed for ${r.id}: ${JSON.stringify(res)}`);
        assert.ok(Number.isFinite(res.p_value) && res.p_value >= 0 && res.p_value <= 1, `bad p_value for ${r.id}`);
      }
      await engine._deletePipelineModel({ context_id: out.context_id });
      return;
    }

    // Semantic-model recipe: create + run its first example query.
    const out = await engine.build_semantic_model(r.semantic_payload);
    assert.equal(out.parse.ok, true, `parse failed for ${r.id}: ${JSON.stringify(out.parse.error || out.parse)}`);
    const example = (r.example_queries || [])[0];
    if (example) {
      const res = await engine.query_semantic_model({ context_id: out.context_id, ...example });
      assert.equal(res.ok, true, `query failed for ${r.id}: ${JSON.stringify(res.error || res)}`);
      assert.ok(Array.isArray(res.rows), `${r.id} returned no rows array`);
    }
  });
}

// A deployment's own file written for an earlier version carries a pipeline recipe as
// { name, pipeline: { source, stages } } — the one-call shape no tool takes. It is served as the start
// request it stands for, and that request builds: the shipped A/B conversion, as such a file would
// hold it, gives the per-variant numbers the fixture holds (control 6 of 6, variant_b 1 of 6).
test('a deployment recipe in the earlier { name, pipeline } shape is served as a start request that builds', opts, async (t) => {
  if (!HAS_DBT) return t.skip('dbt/mf not installed');
  const shipped = recipes.get('experiment_conversion').pipeline_payload;
  const file = join(mkdtempSync(join(tmpdir(), 'rp-old-')), 'mine.json');
  writeFileSync(file, JSON.stringify({ recipes: [{ id: 'my_conversion', task_type: 'experiment', title: 'mine', when_to_use: '', hack: '', pipeline_payload: { name: 'my_conversion', pipeline: { source: shipped.source, stages: shipped.stages } } }] }));
  const served = loadRecipes(join(process.cwd(), 'config', 'recipes.json'), file).get('my_conversion').pipeline_payload;
  const out = await startAndBuild(engine, served);
  assert.equal(out.build?.ok, true, JSON.stringify(out.error || out.build));
  const byGroup = Object.fromEntries(out.rows.map((row) => [String(row.variant_group), [Number(row.n), Number(row.conversions)]]));
  assert.deepEqual([byGroup.control, byGroup.variant_b], [[6, 6], [6, 1]]);
  await engine._deletePipelineModel({ context_id: out.context_id });
});
