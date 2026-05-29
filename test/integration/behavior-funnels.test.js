// Realistic, scenario-heavy coverage: complex funnels, user-behavior cohorts,
// monetization, and JOIN checks (1-hop events->users, 2-hop ->campaigns), across
// many parameter combinations (multi-metric, nested where, order/limit, time
// range, grains, percentile, ratio, conversion, Metric()-filter behavioral
// segments). Exact numbers come from test/integration/fixtures/SEED_DATA.md.
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
const mapCol = (rows, keyCol, valCol) => Object.fromEntries(rows.map((r) => [r[keyCol], num(r[valCol])]));

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

  const catalog = loadCatalog(join(process.cwd(), 'config', 'catalog.json'));
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: mkdtempSync(join(tmpdir(), 'bf-')), timeSpineDialect: 'postgres' });
  backend = new MfEngineBackend({ pythonBin: PY_BIN, dbtBin: DBT_BIN, profilesDir: BASE });
  engine = new Engine({ catalog, contextManager: ctxs, runner: backend });

  // ---- build the task models once ----
  await create({
    name: 'mon', use_base_models: ['users', 'campaigns'],
    semantic_models: [{ from: 'events', event_scope: { event_name: ['purchase'] },
      dimensions: [{ source: 'event_property', property: 'product_id' }],
      measures: [
        { name: 'revenue', agg: 'sum', field: 'revenue' },
        { name: 'payers', agg: 'count_distinct', field: 'user_id' },
        { name: 'purchases', agg: 'count', field: '*' },
        { name: 'p90', agg: 'percentile', field: 'revenue', percentile: 0.9 },
      ] }],
    metrics: [
      { name: 'revenue', type: 'simple', measure: { name: 'revenue' } },
      { name: 'payers', type: 'simple', measure: { name: 'payers' } },
      { name: 'purchases', type: 'simple', measure: { name: 'purchases' } },
      { name: 'arppu', type: 'ratio', numerator: { name: 'revenue' }, denominator: { name: 'payers' } },
      { name: 'aov', type: 'ratio', numerator: { name: 'revenue' }, denominator: { name: 'purchases' } },
      { name: 'p90rev', type: 'simple', measure: { name: 'p90' } },
    ],
  });

  await create({
    name: 'prog',
    semantic_models: [{ from: 'events', dimensions: [{ source: 'event_property', property: 'level' }],
      measures: [
        { name: 'starts', agg: 'count', field: '*', event_name: ['level_start'] },
        { name: 'wins', agg: 'count', field: '*', event_name: ['level_complete'] },
        { name: 'fails', agg: 'count', field: '*', event_name: ['level_fail'] },
      ] }],
    metrics: [
      { name: 'starts', type: 'simple', measure: { name: 'starts' } },
      { name: 'wins', type: 'simple', measure: { name: 'wins' } },
      { name: 'fails', type: 'simple', measure: { name: 'fails' } },
      { name: 'win_rate', type: 'ratio', numerator: { name: 'wins' }, denominator: { name: 'starts' } },
    ],
  });

  await create({
    name: 'tut',
    semantic_models: [{ from: 'events',
      dimensions: [{ source: 'event_property', property: 'step_id' }],
      measures: [{ name: 'users', agg: 'count_distinct', field: 'user_id', event_name: ['tutorial_step'] }] }],
    metrics: [{ name: 'users', type: 'simple', measure: { name: 'users' } }],
  });

  await create({
    name: 'conv', use_base_models: ['users'],
    semantic_models: [{ from: 'events', measures: [
      { name: 'visits', agg: 'count_distinct', field: 'user_id', event_name: ['session_start'] },
      { name: 'buyers', agg: 'count_distinct', field: 'user_id', event_name: ['purchase'] },
    ] }],
    metrics: [
      { name: 'visits', type: 'simple', measure: { name: 'visits' } },
      { name: 'conversion', type: 'conversion', base_measure: { name: 'visits' }, conversion_measure: { name: 'buyers' }, entity: 'user', window: '7 day' },
    ],
  });

  await create({
    name: 'beh',
    semantic_models: [{ from: 'events', measures: [
      { name: 'active', agg: 'count_distinct', field: 'user_id', event_name: ['session_start'] },
      { name: 'purch', agg: 'sum_boolean', event_name: ['purchase'] },
    ] }],
    metrics: [
      { name: 'active', type: 'simple', measure: { name: 'active' } },
      { name: 'purch', type: 'simple', measure: { name: 'purch' } },
    ],
  });
}, opts);

after(async () => { backend?.close(); if (pg) await pg.stop(); });
const skip = (t) => { if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; } return false; };

// ───────────────────────── Monetization + JOINs ─────────────────────────

test('monetization: total revenue = 1699', opts, async (t) => {
  if (skip(t)) return;
  const r = await q('mon', { metrics: ['mon_revenue'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(sumCol(r.rows, 'mon_revenue'), 1699);
});

test('JOIN 1-hop: revenue by user__country (events -> users)', opts, async (t) => {
  if (skip(t)) return;
  const r = await q('mon', { metrics: ['mon_revenue'], group_by: ['user__country'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const by = mapCol(r.rows, 'user__country', 'mon_revenue');
  assert.equal(by.US, 1369); assert.equal(by.GB, 200); assert.equal(by.DE, 50); assert.equal(by.BR, 80);
});

test('JOIN 2-hop: revenue by user__campaign__channel (events -> users -> campaigns)', opts, async (t) => {
  if (skip(t)) return;
  const r = await q('mon', { metrics: ['mon_revenue'], group_by: ['user__campaign__channel'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const by = mapCol(r.rows, 'user__campaign__channel', 'mon_revenue');
  assert.equal(by.social, 430); assert.equal(by.search, 1149); assert.equal(by.video, 120);
});

test('JOIN filter: revenue by acquisition_type = paid(700) / organic(999)', opts, async (t) => {
  if (skip(t)) return;
  const paid = await q('mon', { metrics: ['mon_revenue'], where: { op: 'and', conditions: [{ field: { kind: 'dimension', path: 'user__acquisition_type' }, op: 'eq', value: 'paid' }] } });
  const org = await q('mon', { metrics: ['mon_revenue'], where: { op: 'and', conditions: [{ field: { kind: 'dimension', path: 'user__acquisition_type' }, op: 'eq', value: 'organic' }] } });
  assert.equal(sumCol(paid.rows, 'mon_revenue'), 700);
  assert.equal(sumCol(org.rows, 'mon_revenue'), 999);
});

test('nested where (country in [US,GB] AND paid) = 570', opts, async (t) => {
  if (skip(t)) return;
  const r = await q('mon', { metrics: ['mon_revenue'], where: { op: 'and', conditions: [
    { field: { kind: 'dimension', path: 'user__country' }, op: 'in', value: ['US', 'GB'] },
    { field: { kind: 'dimension', path: 'user__acquisition_type' }, op: 'eq', value: 'paid' },
  ] } });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(sumCol(r.rows, 'mon_revenue'), 570);
});

test('local event dim: revenue by product_id (bare name auto-qualified to event__)', opts, async (t) => {
  if (skip(t)) return;
  const r = await q('mon', { metrics: ['mon_revenue'], group_by: ['mon_product_id'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const by = mapCol(r.rows, 'event__mon_product_id', 'mon_revenue');
  assert.equal(by.p1, 1499); assert.equal(by.p2, 150); assert.equal(by.p3, 50);
});

test('multi-metric in one query: revenue=1699, payers=7, arppu=1699/7', opts, async (t) => {
  if (skip(t)) return;
  const r = await q('mon', { metrics: ['mon_revenue', 'mon_payers', 'mon_arppu'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const row = r.rows[0];
  assert.equal(num(row.mon_revenue), 1699);
  assert.equal(num(row.mon_payers), 7);
  assert.ok(Math.abs(num(row.mon_arppu) - 1699 / 7) < 0.1, `arppu=${row.mon_arppu}`);
});

test('order_by + limit: top product by revenue is p1=1499 (excluding null product)', opts, async (t) => {
  if (skip(t)) return;
  const r = await q('mon', {
    metrics: ['mon_revenue'], group_by: ['mon_product_id'],
    where: { op: 'and', conditions: [{ field: { kind: 'dimension', path: 'mon_product_id' }, op: 'is_not_null' }] },
    order_by: [{ key: 'mon_revenue', direction: 'desc' }], limit: 1,
  });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.rows.length, 1);
  assert.equal(num(r.rows[0].mon_revenue), 1499);
});

test('time range: revenue for 2026-01-03..05 = 1449', opts, async (t) => {
  if (skip(t)) return;
  const r = await q('mon', { metrics: ['mon_revenue'], group_by: [{ time: 'metric_time', grain: 'day' }], time_range: { start: '2026-01-03', end: '2026-01-05' } });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(sumCol(r.rows, 'mon_revenue'), 1449);
});

test('ratio by segment: revenue by platform ios=430 / android=1269', opts, async (t) => {
  if (skip(t)) return;
  const r = await q('mon', { metrics: ['mon_revenue'], group_by: ['user__platform'] });
  const by = mapCol(r.rows, 'user__platform', 'mon_revenue');
  assert.equal(by.ios, 430); assert.equal(by.android, 1269);
});

test('percentile measure (p90 revenue) returns a positive value', opts, async (t) => {
  if (skip(t)) return;
  const r = await q('mon', { metrics: ['mon_p90rev'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.ok(num(r.rows[0].mon_p90rev) > 0);
});

// ───────────────────────── Level progression funnel ─────────────────────────

test('progression: per-level starts (L1=7) and wins (L1=4)', opts, async (t) => {
  if (skip(t)) return;
  const s = await q('prog', { metrics: ['prog_starts'], group_by: ['prog_level'] });
  const w = await q('prog', { metrics: ['prog_wins'], group_by: ['prog_level'] });
  assert.equal(s.ok, true, JSON.stringify(s.error));
  assert.equal(mapCol(s.rows, 'event__prog_level', 'prog_starts')['1'], 7);
  assert.equal(mapCol(w.rows, 'event__prog_level', 'prog_wins')['1'], 4);
});

test('progression totals: starts=14, wins=9, fails=6', opts, async (t) => {
  if (skip(t)) return;
  const r = await q('prog', { metrics: ['prog_starts', 'prog_wins', 'prog_fails'] });
  const row = r.rows[0];
  assert.equal(num(row.prog_starts), 14);
  assert.equal(num(row.prog_wins), 9);
  assert.equal(num(row.prog_fails), 6);
});

test('progression win_rate per level in [0,1]; L3=1.0; L1 in (0.5,0.6)', opts, async (t) => {
  if (skip(t)) return;
  const r = await q('prog', { metrics: ['prog_win_rate'], group_by: ['prog_level'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const by = mapCol(r.rows, 'event__prog_level', 'prog_win_rate');
  for (const v of Object.values(by)) if (Number.isFinite(v)) assert.ok(v >= 0 && v <= 1.0000001, `win_rate ${v}`);
  assert.ok(Math.abs(by['3'] - 1) < 1e-6);
  assert.ok(by['1'] > 0.5 && by['1'] < 0.6);
});

// ───────────────────────── Tutorial funnel (step drop-off) ─────────────────────────

test('tutorial funnel: distinct users by step ts1=5 -> ts2=2 (drop-off)', opts, async (t) => {
  if (skip(t)) return;
  const r = await q('tut', { metrics: ['tut_users'], group_by: ['tut_step_id'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const by = mapCol(r.rows, 'event__tut_step_id', 'tut_users');
  assert.equal(by.ts1, 5); assert.equal(by.ts2, 2);
});

test('tutorial: total distinct users who started the tutorial = 5', opts, async (t) => {
  if (skip(t)) return;
  const r = await q('tut', { metrics: ['tut_users'] });
  assert.equal(num(r.rows[0].tut_users), 5);
});

// ───────────────────────── Visit -> purchase conversion ─────────────────────────

test('conversion: all 12 users visit', opts, async (t) => {
  if (skip(t)) return;
  const r = await q('conv', { metrics: ['conv_visits'] });
  assert.equal(num(r.rows[0].conv_visits), 12);
});

test('conversion: visit->purchase rate within 7d ~ 7/12 in (0.5,0.7)', opts, async (t) => {
  if (skip(t)) return;
  const r = await q('conv', { metrics: ['conv_conversion'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const v = num(r.rows[0].conv_conversion);
  assert.ok(v > 0.5 && v <= 0.7, `conversion=${v}`);
});

test('conversion by country (join): every rate in [0,1]', opts, async (t) => {
  if (skip(t)) return;
  const r = await q('conv', { metrics: ['conv_conversion'], group_by: ['user__country'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  for (const row of r.rows) { const v = num(row.conv_conversion); if (Number.isFinite(v)) assert.ok(v >= 0 && v <= 1.0000001, `rate ${v}`); }
});

// ───────────────────────── Behavioral cohorts (did / didn't, Metric() filter) ─────────────────────────

test('behavioral: total active users = 12', opts, async (t) => {
  if (skip(t)) return;
  const r = await q('beh', { metrics: ['beh_active'] });
  assert.equal(num(r.rows[0].beh_active), 12);
});

test('behavioral cohort: active users who PURCHASED = 7 (Metric() in --where)', opts, async (t) => {
  if (skip(t)) return;
  const dir = engine.ctxs.dir(ctxOf.beh);
  const r = await backend.query(dir, { metrics: ['beh_active'], where: ["{{ Metric('beh_purch', group_by=['user']) }} > 0"] });
  assert.equal(r.ok, true, r.stderr);
  assert.equal(num(r.rows[0].beh_active), 7);
});

test('behavioral cohort: active users who did NOT purchase = 5 (Metric() in --where)', opts, async (t) => {
  if (skip(t)) return;
  const dir = engine.ctxs.dir(ctxOf.beh);
  const r = await backend.query(dir, { metrics: ['beh_active'], where: ["{{ Metric('beh_purch', group_by=['user']) }} = 0"] });
  assert.equal(r.ok, true, r.stderr);
  assert.equal(num(r.rows[0].beh_active), 5);
});
