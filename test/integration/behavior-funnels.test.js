// Realistic, scenario-heavy coverage built ONLY from the two documented data
// sources: the events fact (fct_analytics_events) and user attributes
// (dim_users). Joins are 1-hop events.user -> dim_users (user__country,
// user__platform, user__media_source, user__acquisition_type, ...). Funnels use
// events + event_data property values. Exact numbers come from
// test/integration/fixtures/SEED_DATA.md.
//
// HARD RULE: assertions are DATA-ONLY — res.ok / res.row_count and the numeric
// values keyed out of res.rows. No SQL/jinja/command/column-name string checks.
//
// Runs against dbt Core + MetricFlow + PGlite; auto-skips if dbt/mf absent.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadCatalog } from '../../src/catalog.js';
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
const opts = { timeout: 300000 };

let pg;
let engine;
let backend;
const ctxOf = {}; // task name -> context_id

const num = (v) => Number(v === '' || v == null ? NaN : v);
const sumCol = (rows, col) => rows.reduce((s, r) => s + (Number.isFinite(num(r[col])) ? num(r[col]) : 0), 0);
const mapCol = (rows, keyCol, valCol) => Object.fromEntries(rows.map((r) => [String(r[keyCol]), num(r[valCol])]));

async function create(decl) {
  const out = await engine.create_semantic_model(decl);
  assert.equal(out.parse.ok, true, `parse failed for ${decl.name}: ${JSON.stringify(out.parse)}`);
  ctxOf[decl.name] = out.context_id;
  return out;
}
const q = (task, args) => engine.query_semantic_model({ context_id: ctxOf[task], ...args });

before(async () => {
  if (!HAS_DBT) return;
  pg = await startPglite();
  process.env.DBT_PG_PORT = String(pg.port);
  const env = { ...process.env, DBT_PROFILES_DIR: BASE, DBT_PROJECT_DIR: BASE, DBT_PG_PORT: String(pg.port) };
  await execFileP(DBT_BIN, ['seed'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  await execFileP(DBT_BIN, ['run'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });

  const catalog = loadCatalog(join(process.cwd(), 'config', 'catalog.yml'));
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: mkdtempSync(join(tmpdir(), 'bf-')), timeSpineDialect: 'postgres' });
  backend = new MfEngineBackend({ pythonBin: PY_BIN, dbtBin: DBT_BIN, profilesDir: BASE });
  engine = new Engine({ catalog, contextManager: ctxs, runner: backend });

  // ---- build the task models once ----

  // Monetization: revenue / payers / purchases / arppu / aov, with a 1-hop join
  // to user attributes and a local product_id event-property dimension.
  await create({
    name: 'mon', use_base_models: ['users'],
    semantic_models: [{ from: 'events', event_scope: { event_name: ['iap_purchase_completed'] },
      dimensions: [{ source: 'event_property', property: 'product_id' }],
      measures: [
        { name: 'revenue', agg: 'sum', field: 'price_in_usd' },
        { name: 'payers', agg: 'count_distinct', field: 'appsflyer_id' },
        { name: 'purchases', agg: 'count', field: '*' },
      ] }],
    metrics: [
      { name: 'revenue', type: 'simple', measure: { name: 'revenue' } },
      { name: 'payers', type: 'simple', measure: { name: 'payers' } },
      { name: 'purchases', type: 'simple', measure: { name: 'purchases' } },
      { name: 'arppu', type: 'ratio', numerator: { name: 'revenue' }, denominator: { name: 'payers' } },
      { name: 'aov', type: 'ratio', numerator: { name: 'revenue' }, denominator: { name: 'purchases' } },
    ],
  });

  // Level progression: starts / completes per level_id (event-property dim).
  await create({
    name: 'prog',
    semantic_models: [{ from: 'events', dimensions: [{ source: 'event_property', property: 'level_id' }],
      measures: [
        { name: 'starts', agg: 'count', field: '*', event_name: ['level_started'] },
        { name: 'completes', agg: 'count', field: '*', event_name: ['level_completed'] },
      ] }],
    metrics: [
      { name: 'starts', type: 'simple', measure: { name: 'starts' } },
      { name: 'completes', type: 'simple', measure: { name: 'completes' } },
      { name: 'completion_rate', type: 'ratio', numerator: { name: 'completes' }, denominator: { name: 'starts' } },
    ],
  });

  // Visit -> purchase conversion (native conversion metric), 1-hop join for splits.
  await create({
    name: 'conv', use_base_models: ['users'],
    semantic_models: [{ from: 'events', measures: [
      { name: 'visitors', agg: 'count_distinct', field: 'appsflyer_id', event_name: ['new_session'] },
      { name: 'buyers', agg: 'count_distinct', field: 'appsflyer_id', event_name: ['iap_purchase_completed'] },
    ] }],
    metrics: [
      { name: 'visitors', type: 'simple', measure: { name: 'visitors' } },
      { name: 'buyers', type: 'simple', measure: { name: 'buyers' } },
      { name: 'conversion', type: 'conversion', base_measure: { name: 'visitors' }, conversion_measure: { name: 'buyers' }, entity: 'user', window: '30 day' },
    ],
  });

  // Behavioral cohort: active users + a did-purchase boolean, split via Metric()
  // in the warm backend --where.
  await create({
    name: 'beh',
    semantic_models: [{ from: 'events', measures: [
      { name: 'active', agg: 'count_distinct', field: 'appsflyer_id', event_name: ['new_session'] },
      { name: 'purch', agg: 'sum_boolean', event_name: ['iap_purchase_completed'] },
    ] }],
    metrics: [
      { name: 'active', type: 'simple', measure: { name: 'active' } },
      { name: 'purch', type: 'simple', measure: { name: 'purch' } },
    ],
  });
}, opts);

after(async () => { backend?.close(); if (pg) await pg.stop(); });
const skip = (t) => { if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; } return false; };

// ───────────────────────── Monetization + 1-hop JOINs ─────────────────────────

test('monetization: total revenue = 85, payers = 7, purchases = 8', opts, async (t) => {
  if (skip(t)) return;
  const r = await q('mon', { metrics: ['mon_revenue', 'mon_payers', 'mon_purchases'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const row = r.rows[0];
  assert.equal(num(row.mon_revenue), 85);
  assert.equal(num(row.mon_payers), 7);
  assert.equal(num(row.mon_purchases), 8);
});

test('monetization: ARPPU == revenue/payers and AOV == revenue/purchases', opts, async (t) => {
  if (skip(t)) return;
  const r = await q('mon', { metrics: ['mon_revenue', 'mon_payers', 'mon_purchases', 'mon_arppu', 'mon_aov'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const row = r.rows[0];
  const rev = num(row.mon_revenue); const pay = num(row.mon_payers); const pur = num(row.mon_purchases);
  assert.ok(Math.abs(num(row.mon_arppu) - rev / pay) < 1e-6, `arppu=${row.mon_arppu}`);
  assert.ok(Math.abs(num(row.mon_aov) - rev / pur) < 1e-6, `aov=${row.mon_aov}`);
});

test('monetization: revenue by user__country = US 35 / GB 25 / BR 25 (sums to 85)', opts, async (t) => {
  if (skip(t)) return;
  const r = await q('mon', { metrics: ['mon_revenue'], group_by: ['user__country'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const by = mapCol(r.rows, 'user__country', 'mon_revenue');
  assert.equal(by.US, 35); assert.equal(by.GB, 25); assert.equal(by.BR, 25);
  assert.ok(!Number.isFinite(by.DE) || by.DE === 0, `DE=${by.DE}`);
  assert.equal(sumCol(r.rows, 'mon_revenue'), 85);
});

test('monetization: revenue by user__platform = ios 65 / android 20 (sums to 85)', opts, async (t) => {
  if (skip(t)) return;
  const r = await q('mon', { metrics: ['mon_revenue'], group_by: ['user__platform'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const by = mapCol(r.rows, 'user__platform', 'mon_revenue');
  assert.equal(by.ios, 65); assert.equal(by.android, 20);
  assert.equal(sumCol(r.rows, 'mon_revenue'), 85);
});

test('monetization: revenue by user__media_source = meta 25 / organic 30 / google 20 / applovin 10', opts, async (t) => {
  if (skip(t)) return;
  const r = await q('mon', { metrics: ['mon_revenue'], group_by: ['user__media_source'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const by = mapCol(r.rows, 'user__media_source', 'mon_revenue');
  assert.equal(by.meta, 25); assert.equal(by.organic, 30); assert.equal(by.google, 20); assert.equal(by.applovin, 10);
  assert.equal(sumCol(r.rows, 'mon_revenue'), 85);
});

test('monetization: revenue by user__acquisition_type = paid 55 / organic 30', opts, async (t) => {
  if (skip(t)) return;
  const r = await q('mon', { metrics: ['mon_revenue'], group_by: ['user__acquisition_type'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const by = mapCol(r.rows, 'user__acquisition_type', 'mon_revenue');
  assert.equal(by.paid, 55); assert.equal(by.organic, 30);
  assert.equal(sumCol(r.rows, 'mon_revenue'), 85);
});

test('monetization: payers = 7 (distinct buyers across the whole month)', opts, async (t) => {
  if (skip(t)) return;
  const r = await q('mon', { metrics: ['mon_payers'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(num(r.rows[0].mon_payers), 7);
});

test('monetization: nested where (country in [US,GB] AND paid) -> 5+10+15+20 = 50', opts, async (t) => {
  if (skip(t)) return;
  // GB paid payers: u3(5), u7(10); US paid payers: u1(15), u10(20) -> 5+10+15+20 = 50
  const r = await q('mon', { metrics: ['mon_revenue'], where: { op: 'and', conditions: [
    { field: { kind: 'dimension', path: 'user__country' }, op: 'in', value: ['US', 'GB'] },
    { field: { kind: 'dimension', path: 'user__acquisition_type' }, op: 'eq', value: 'paid' },
  ] } });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(sumCol(r.rows, 'mon_revenue'), 50);
});

test('monetization: where with OR (US OR BR) -> 35 + 25 = 60', opts, async (t) => {
  if (skip(t)) return;
  const r = await q('mon', { metrics: ['mon_revenue'], where: { op: 'or', conditions: [
    { field: { kind: 'dimension', path: 'user__country' }, op: 'eq', value: 'US' },
    { field: { kind: 'dimension', path: 'user__country' }, op: 'eq', value: 'BR' },
  ] } });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(sumCol(r.rows, 'mon_revenue'), 60);
});

test('monetization: revenue by product_id = p1 15 / p2 30 / p3 40; order_by+limit top = 40', opts, async (t) => {
  if (skip(t)) return;
  const r = await q('mon', { metrics: ['mon_revenue'], group_by: ['mon_product_id'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const by = mapCol(r.rows, 'event__mon_product_id', 'mon_revenue');
  assert.equal(by.p1, 15); assert.equal(by.p2, 30); assert.equal(by.p3, 40);

  const top = await q('mon', {
    metrics: ['mon_revenue'], group_by: ['mon_product_id'],
    where: { op: 'and', conditions: [{ field: { kind: 'dimension', path: 'mon_product_id' }, op: 'is_not_null' }] },
    order_by: [{ key: 'mon_revenue', direction: 'desc' }], limit: 1,
  });
  assert.equal(top.ok, true, JSON.stringify(top.error));
  assert.equal(top.row_count, 1);
  assert.equal(num(top.rows[0].mon_revenue), 40);
});

test('monetization: time_range 2026-01-04..05 (day grain) -> 10+5+20+10 = 45', opts, async (t) => {
  if (skip(t)) return;
  // o5 u7 10 (01-04), o6 u9 5 (01-04), o7 u10 20 (01-05), o8 u11 10 (01-05)
  const r = await q('mon', { metrics: ['mon_revenue'], group_by: [{ time: 'metric_time', grain: 'day' }], time_range: { start: '2026-01-04', end: '2026-01-05' } });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(sumCol(r.rows, 'mon_revenue'), 45);
});

test('monetization: revenue by day/week/month all sum to 85', opts, async (t) => {
  if (skip(t)) return;
  const day = await q('mon', { metrics: ['mon_revenue'], group_by: [{ time: 'metric_time', grain: 'day' }] });
  const week = await q('mon', { metrics: ['mon_revenue'], group_by: [{ time: 'metric_time', grain: 'week' }] });
  const month = await q('mon', { metrics: ['mon_revenue'], group_by: [{ time: 'metric_time', grain: 'month' }] });
  for (const r of [day, week, month]) assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(sumCol(day.rows, 'mon_revenue'), 85);
  assert.equal(sumCol(week.rows, 'mon_revenue'), 85);
  assert.equal(sumCol(month.rows, 'mon_revenue'), 85);
  // single month in the seed
  assert.equal(month.row_count, 1);
});

// ───────────────────────── Level progression (per level_id) ─────────────────────────

test('progression: per-level starts = 12/6/3 and completes = 12/4/3 (levels 1-3)', opts, async (t) => {
  if (skip(t)) return;
  const s = await q('prog', { metrics: ['prog_starts'], group_by: ['prog_level_id'] });
  const c = await q('prog', { metrics: ['prog_completes'], group_by: ['prog_level_id'] });
  assert.equal(s.ok, true, JSON.stringify(s.error));
  assert.equal(c.ok, true, JSON.stringify(c.error));
  const sBy = mapCol(s.rows, 'event__prog_level_id', 'prog_starts');
  const cBy = mapCol(c.rows, 'event__prog_level_id', 'prog_completes');
  assert.equal(sBy['1'], 12); assert.equal(sBy['2'], 6); assert.equal(sBy['3'], 3);
  assert.equal(cBy['1'], 12); assert.equal(cBy['2'], 4); assert.equal(cBy['3'], 3);
});

test('progression totals: starts = 28, completes = 25 (completers <= starters)', opts, async (t) => {
  if (skip(t)) return;
  const r = await q('prog', { metrics: ['prog_starts', 'prog_completes'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const row = r.rows[0];
  assert.equal(num(row.prog_starts), 28);
  assert.equal(num(row.prog_completes), 25);
  assert.ok(num(row.prog_completes) <= num(row.prog_starts));
});

test('progression: completion_rate per level in [0,1]; L1=1.0; L6=0.0', opts, async (t) => {
  if (skip(t)) return;
  const r = await q('prog', { metrics: ['prog_completion_rate'], group_by: ['prog_level_id'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const by = mapCol(r.rows, 'event__prog_level_id', 'prog_completion_rate');
  for (const v of Object.values(by)) if (Number.isFinite(v)) assert.ok(v >= 0 && v <= 1.0000001, `rate ${v}`);
  assert.ok(Math.abs(by['1'] - 1) < 1e-9, `L1=${by['1']}`);
  // level 6: 1 start, 0 completes -> rate 0
  assert.ok(by['6'] === 0 || !Number.isFinite(by['6']), `L6=${by['6']}`);
});

test('progression: overall completion_rate = 25/28 in (0,1)', opts, async (t) => {
  if (skip(t)) return;
  const r = await q('prog', { metrics: ['prog_completion_rate'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const v = num(r.rows[0].prog_completion_rate);
  assert.ok(Math.abs(v - 25 / 28) < 1e-9, `rate=${v}`);
  assert.ok(v > 0 && v < 1);
});

// ───────────────────────── Visit -> purchase conversion ─────────────────────────

test('conversion: 12 visitors, 7 buyers', opts, async (t) => {
  if (skip(t)) return;
  const r = await q('conv', { metrics: ['conv_visitors', 'conv_buyers'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(num(r.rows[0].conv_visitors), 12);
  assert.equal(num(r.rows[0].conv_buyers), 7);
});

test('conversion: visit->purchase rate in [0,1] ~ payers/visitors = 7/12', opts, async (t) => {
  if (skip(t)) return;
  const r = await q('conv', { metrics: ['conv_conversion'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const v = num(r.rows[0].conv_conversion);
  assert.ok(v >= 0 && v <= 1.0000001, `conversion=${v}`);
  assert.ok(Math.abs(v - 7 / 12) < 0.06, `conversion≈0.583 got ${v}`);
});

test('conversion by user__country: every rate in [0,1]', opts, async (t) => {
  if (skip(t)) return;
  const r = await q('conv', { metrics: ['conv_conversion'], group_by: ['user__country'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.ok(r.row_count > 0);
  for (const row of r.rows) { const v = num(row.conv_conversion); if (Number.isFinite(v)) assert.ok(v >= 0 && v <= 1.0000001, `rate ${v}`); }
});

// ───────────────── Behavioral cohort (did / didn't purchase, Metric() filter) ─────────────────

test('behavioral: total active users = 12', opts, async (t) => {
  if (skip(t)) return;
  const r = await q('beh', { metrics: ['beh_active'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(num(r.rows[0].beh_active), 12);
});

test('behavioral cohort: active users who PURCHASED = 7 (Metric() in --where)', opts, async (t) => {
  if (skip(t)) return;
  const dir = engine.ctxs.dir(ctxOf.beh);
  const r = await backend.query(dir, { metrics: ['beh_active'], where: ["{{ Metric('beh_purch', group_by=['user']) }} > 0"] });
  assert.equal(r.ok, true, r.stderr);
  assert.equal(num(r.rows[0].beh_active), 7);
});

test('behavioral cohort: active users who did NOT purchase = 5 (complement)', opts, async (t) => {
  if (skip(t)) return;
  const dir = engine.ctxs.dir(ctxOf.beh);
  const r = await backend.query(dir, { metrics: ['beh_active'], where: ["{{ Metric('beh_purch', group_by=['user']) }} = 0"] });
  assert.equal(r.ok, true, r.stderr);
  assert.equal(num(r.rows[0].beh_active), 5);
});
