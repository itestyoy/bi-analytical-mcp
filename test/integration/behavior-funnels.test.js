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

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { startWarehouse, fixtureProject } from './warehouse-harness.js';
import { settle } from '../helpers/settle.js';
import { DBT_BIN, HAS_DBT, testDbt } from '../helpers/dbt-env.js';

const execFileP = promisify(execFile);
const BASE = fixtureProject('dbt_project'); // a private copy: the test files run side by side
const opts = { timeout: 300000 };

let wh;
let engine;
let backend;
const ctxOf = {}; // task name -> context_id

const num = (v) => Number(v === '' || v == null ? NaN : v);
const sumCol = (rows, col) => rows.reduce((s, r) => s + (Number.isFinite(num(r[col])) ? num(r[col]) : 0), 0);
const mapCol = (rows, keyCol, valCol) => Object.fromEntries(rows.map((r) => [String(r[keyCol]), num(r[valCol])]));

async function create(decl) {
  const out = await engine.build_semantic_model(decl);
  assert.equal(out.parse.ok, true, `parse failed for ${decl.name}: ${JSON.stringify(out.parse)}`);
  ctxOf[decl.name] = out.context_id;
  return out;
}
const q = (task, args) => engine.query_semantic_model({ context_id: ctxOf[task], ...args });

before(async () => {
  if (!HAS_DBT) return;
  wh = await startWarehouse();
  const env = { ...process.env, DBT_PROFILES_DIR: BASE, DBT_PROJECT_DIR: BASE, DUCKDB_PATH: wh.path };
  await execFileP(DBT_BIN, ['seed'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  await execFileP(DBT_BIN, ['run'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });

  const catalog = loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), { profilesDir: BASE, projectDir: BASE });
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: mkdtempSync(join(tmpdir(), 'bf-')), timeSpineDialect: 'duckdb' });
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
}, opts);

after(async () => { backend?.close?.(); if (wh) await wh.stop(); });
const skip = (t) => { if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; } return false; };

// ───────────────────────── Monetization + 1-hop JOINs ─────────────────────────

// The totals and the two ratios come back side by side in one query (the totals were a test of their
// own, 'monetization: total revenue = 85, payers = 7, purchases = 8', and payers = 7 another).
test('monetization: revenue 85 / payers 7 / purchases 8; ARPPU == revenue/payers and AOV == revenue/purchases', opts, async (t) => {
  if (skip(t)) return;
  const r = await q('mon', { metrics: ['mon_revenue', 'mon_payers', 'mon_purchases', 'mon_arppu', 'mon_aov'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const row = r.rows[0];
  assert.equal(num(row.mon_revenue), 85, '[totals] revenue 85');
  assert.equal(num(row.mon_payers), 7, '[totals] payers 7 (distinct buyers across the whole month)');
  assert.equal(num(row.mon_purchases), 8, '[totals] purchases 8');
  const rev = num(row.mon_revenue); const pay = num(row.mon_payers); const pur = num(row.mon_purchases);
  assert.ok(Math.abs(num(row.mon_arppu) - rev / pay) < 1e-6, `[ARPPU] arppu=${row.mon_arppu}`);
  assert.ok(Math.abs(num(row.mon_aov) - rev / pur) < 1e-6, `[AOV] aov=${row.mon_aov}`);
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
  assert.equal(num(top.rows[0].mon_revenue), 40);
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
    return Object.fromEntries(r.rows.map((x) => [`${String(x.metric_time_day).slice(0, 10)}|${x.users_platform}`, num(x[`${name}_events`])]));
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
  assert.equal(num(row.lvlf_s1), 12, '[level counts] L1');
  assert.equal(num(row.lvlf_s2), 6, '[level counts] L2');
  assert.equal(num(row.lvlf_s3), 3, '[level counts] L3');
  assert.ok(num(row.lvlf_s1) >= num(row.lvlf_s2) && num(row.lvlf_s2) >= num(row.lvlf_s3), '[level counts] monotonic');
  // 'level funnel: the L1->L2 share of players is the L2 players over the L1 players, in (0,1)'
  const v = num(row.lvlf_conv_1_2);
  assert.ok(num(row.lvlf_p2) > 0 && num(row.lvlf_p2) < num(row.lvlf_p1), `[L1->L2 share] 0 < L2 players < L1 players: ${JSON.stringify(row)}`);
  assert.ok(Math.abs(v - num(row.lvlf_p2) / num(row.lvlf_p1)) < 1e-9, `[L1->L2 share] conv_1_2=${v}`);
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
  assert.deepEqual([num(out.rows[0].visitors), num(out.rows[0].buyers)], [12, 7]);
});

test('conversion by users.country: the countries add up to the whole, each a share of its own visitors', opts, async (t) => {
  if (skip(t)) return;
  const out = await engine._buildPipeline({ name: 'conv_country', pipeline: { source: 'events', stages: [...CONVERSION, BY_COUNTRY, { stage: 'aggregate', group_by: ['country'], measures: [{ name: 'visitors', agg: 'count' }, converted] }] } });
  assert.equal(out.build?.ok, true, JSON.stringify(out.error || out.build));
  assert.ok(out.rows.length > 1, 'more than one country');
  assert.deepEqual([out.rows.reduce((a, r) => a + num(r.visitors), 0), out.rows.reduce((a, r) => a + num(r.buyers), 0)], [12, 7]);
  for (const r of out.rows) assert.ok(num(r.buyers) <= num(r.visitors), JSON.stringify(r));
});
