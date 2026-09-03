// END-TO-END on the REAL stack (dbt + MetricFlow + PGlite) for the SLOWLY-CHANGING (SCD-2)
// dimension cycle — the governed point-in-time join, the native-pipeline join.between, and the
// "incomplete join" nudge. The fixture is built so POINT-IN-TIME and a naive key-only join give
// DIFFERENT numbers, so the tests actually prove correctness (not just "it ran").
//
// Fixture (seeds): u1 is US in [Jan 1..14] then GB from Jan 15; u2=DE, u3=US (single version).
// Purchases: u1 $10 on Jan 5 (US era), u1 $20 on Jan 20 (GB era), u2 $30, u3 $40.
//   Point-in-time revenue by country: US = 10 + 40 = 50, GB = 20, DE = 30  → total 100.
//   Naive key-only join fans u1's 2 purchases across BOTH versions → total inflates to 130.
// DATA-ONLY assertions (per project rules): every check is on a returned number.

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
const BASE = join(process.cwd(), 'test', 'integration', 'fixtures', 'scd_project');
const CATALOG = join(process.cwd(), 'test', 'integration', 'fixtures', 'scd_catalog.yml');
const DBT_BIN = process.env.DBT_BIN || join(process.cwd(), '.dbtvenv', 'bin', 'dbt');
const MF_BIN = process.env.MF_BIN || join(process.cwd(), '.dbtvenv', 'bin', 'mf');
const PY_BIN = process.env.PYTHON_BIN || join(process.cwd(), '.dbtvenv', 'bin', 'python');
const HAS_DBT = existsSync(DBT_BIN) && existsSync(MF_BIN);
const opts = { timeout: 300000 };
const num = (v) => Number(v);
const byKey = (rows, k, v) => rows.map((r) => [String(r[k]), num(r[v])]);
const mapOf = (rows, k, v) => Object.fromEntries(byKey(rows, k, v));

let pg; let engine; let backend;

before(async () => {
  if (!HAS_DBT) return;
  pg = await startPglite();
  process.env.DBT_PG_PORT = String(pg.port);
  const env = { ...process.env, DBT_PROFILES_DIR: BASE, DBT_PROJECT_DIR: BASE, DBT_PG_PORT: String(pg.port) };
  await execFileP(DBT_BIN, ['seed'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  await execFileP(DBT_BIN, ['run'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: mkdtempSync(join(tmpdir(), 'scd-')), timeSpineDialect: 'postgres' });
  backend = new MfEngineBackend({ pythonBin: PY_BIN, dbtBin: DBT_BIN, profilesDir: BASE });
  engine = new Engine({ catalog: loadCatalog(CATALOG, { profilesDir: BASE, projectDir: BASE }), contextManager: ctxs, runner: backend, queryTimeoutMs: 120000 });
}, opts);

after(async () => { backend?.close(); if (pg) await pg.stop(); });
const skip = (t) => { if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; } return false; };

// 1) GOVERNED SCD point-in-time join: revenue by (versioned) country attributes each purchase to
//    the user version valid AT the event time. Proves no fan-out (total 100, not 130).
test('governed SCD join: revenue by users.country is point-in-time (US 50 / GB 20 / DE 30, total 100)', opts, async (t) => {
  if (skip(t)) return;
  const created = await engine.create_semantic_model({
    name: 'scd_rev', use_base_models: ['users'],
    semantic_models: [
      { from: 'events', event_scope: { event_name: ['iap_purchase_completed'] }, measures: [{ name: 'revenue', agg: 'sum', field: 'price_in_usd_of_event_data' }] },
      { from: 'users', dimensions: [{ source: 'model_column', column: 'country' }] },
    ],
    metrics: [{ name: 'revenue', type: 'simple', measure: { name: 'revenue' } }],
  });
  assert.equal(created.parse.ok, true, JSON.stringify(created.parse));
  const ctx = created.context_id;

  const total = await engine.query_semantic_model({ context_id: ctx, metrics: ['scd_rev_revenue'], materialize: true });
  assert.equal(total.status, 'ready', JSON.stringify(total));
  const totalR = await engine.get_query_result({ context_id: ctx, table: total.table, transform: { aggregations: [{ fn: 'sum', column: 'scd_rev_revenue', as: 't' }] } });
  assert.equal(num(totalR.rows[0].t), 100, 'point-in-time total revenue = 100 (a fan-out join would give 130)');

  const seg = await engine.query_semantic_model({ context_id: ctx, metrics: ['scd_rev_revenue'], group_by: [{ model: 'users', attribute: 'country' }], materialize: true });
  const rows = await engine.get_query_result({ context_id: ctx, table: seg.table });
  const by = mapOf(rows.rows, 'users_country', 'scd_rev_revenue');
  assert.equal(by.US, 50, `US = u1's pre-move $10 + u3 $40 = 50 (got ${JSON.stringify(by)})`);
  assert.equal(by.GB, 20, "GB = u1's post-move $20");
  assert.equal(by.DE, 30, 'DE = u2 $30');
  assert.equal(Object.values(by).reduce((a, b) => a + b, 0), 100, 'segments sum to the point-in-time total');
});

// 2) The governed SCD path relies on an auto-generated + auto-materialized time spine — exercise it
//    via a metric_time series (would error "no time spine" if the spine were missing/unbuilt).
test('governed SCD join: metric_time series works (time spine auto-built), Jan month = 100', opts, async (t) => {
  if (skip(t)) return;
  const created = await engine.create_semantic_model({
    name: 'scd_ts', use_base_models: ['users'],
    semantic_models: [{ from: 'events', event_scope: { event_name: ['iap_purchase_completed'] }, measures: [{ name: 'revenue', agg: 'sum', field: 'price_in_usd_of_event_data' }] }],
    metrics: [{ name: 'revenue', type: 'simple', measure: { name: 'revenue' } }],
  });
  assert.equal(created.parse.ok, true, JSON.stringify(created.parse));
  const m = await engine.query_semantic_model({ context_id: created.context_id, metrics: ['scd_ts_revenue'], group_by: [{ time: 'metric_time', grain: 'month' }], materialize: true });
  const r = await engine.get_query_result({ context_id: created.context_id, table: m.table });
  assert.equal(r.rows.reduce((s, x) => s + num(x.scd_ts_revenue), 0), 100, 'all revenue lands in the month buckets, summing to 100');
});

// 3) A measure declared on the SCD users model is illegal in MetricFlow (measures + validity_params).
//    The renderer must drop it (with a warning) and keep the manifest valid & queryable.
test('governed SCD join: a measure on the SCD users model is dropped with a warning; the task still parses & queries', opts, async (t) => {
  if (skip(t)) return;
  const created = await engine.create_semantic_model({
    name: 'scd_drop', use_base_models: ['users'],
    semantic_models: [
      { from: 'events', event_scope: { event_name: ['iap_purchase_completed'] }, measures: [{ name: 'revenue', agg: 'sum', field: 'price_in_usd_of_event_data' }] },
      { from: 'users', measures: [{ name: 'player_count', agg: 'count_distinct', field: 'internal_player_id' }] },
    ],
    metrics: [
      { name: 'revenue', type: 'simple', measure: { name: 'revenue' } },
      { name: 'players', type: 'simple', measure: { name: 'player_count' } },
    ],
  });
  assert.equal(created.parse.ok, true, `parse must still succeed after dropping the SCD measure: ${JSON.stringify(created.parse)}`);
  assert.ok((created.warnings || []).some((w) => /join-only/i.test(w) && /player_count/.test(w)), `expected a drop warning naming player_count, got ${JSON.stringify(created.warnings)}`);
  assert.ok(!created.metrics.includes('scd_drop_players'), 'the metric depending on the dropped measure is gone');
  assert.ok(created.metrics.includes('scd_drop_revenue'), 'the events metric survives');
  // and the surviving metric still queries to the point-in-time total
  const m = await engine.query_semantic_model({ context_id: created.context_id, metrics: ['scd_drop_revenue'], materialize: true });
  const r = await engine.get_query_result({ context_id: created.context_id, table: m.table, transform: { aggregations: [{ fn: 'sum', column: 'scd_drop_revenue', as: 't' }] } });
  assert.equal(num(r.rows[0].t), 100);
});

// 4) NATIVE PIPELINE point-in-time join via join.between: same point-in-time numbers as governed.
test('native pipeline join.between: point-in-time revenue by country = US 50 / GB 20 / DE 30', opts, async (t) => {
  if (skip(t)) return;
  const s = await engine.build_native_model({ action: 'start', name: 'scd_pipe', source: 'events' });
  const r = await engine.build_native_model({
    action: 'add_steps', draft_id: s.draft_id, stages: [
      { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] },
      { stage: 'derive', name: 'price', op: 'extract', source: 'price_in_usd_of_event_data', type: 'numeric' },
      { stage: 'join', with: 'users', on: 'internal_player_id', attrs: ['country'], between: { value: 'device_time', from: 'install_time_valid_from', to: 'install_time_valid_until' } },
      { stage: 'aggregate', group_by: ['country'], measures: [{ name: 'revenue', fn: 'sum', column: 'price' }, { name: 'n', fn: 'count' }] },
    ],
  });
  assert.equal(r.action, 'add_steps');
  const mat = await engine.build_native_model({ action: 'materialize', draft_id: s.draft_id });
  assert.equal(mat.build?.ok, true, JSON.stringify(mat.error || mat.build));
  const rows = await engine.get_query_result({ context_id: mat.context_id, table: mat.model });
  const by = mapOf(rows.rows, 'country', 'revenue');
  assert.equal(by.US, 50, `US = 50 point-in-time (got ${JSON.stringify(by)})`);
  assert.equal(by.GB, 20);
  assert.equal(by.DE, 30);
  assert.equal(rows.rows.reduce((a, x) => a + num(x.n), 0), 4, 'exactly the 4 purchases — no fan-out');
});

// 5) The SAME pipeline WITHOUT between fans out (u1's purchases match both versions): total inflates
//    to 130 and there are 6 joined rows. This is exactly what the join-completeness nudge warns about.
test('native pipeline key-only join (no between) fans out: total inflates to 130 / 6 rows', opts, async (t) => {
  if (skip(t)) return;
  const s = await engine.build_native_model({ action: 'start', name: 'scd_fanout', source: 'events' });
  await engine.build_native_model({
    action: 'add_steps', draft_id: s.draft_id, stages: [
      { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] },
      { stage: 'derive', name: 'price', op: 'extract', source: 'price_in_usd_of_event_data', type: 'numeric' },
      { stage: 'join', with: 'users', on: 'internal_player_id', attrs: ['country'] },
      { stage: 'aggregate', measures: [{ name: 'revenue', fn: 'sum', column: 'price' }, { name: 'n', fn: 'count' }] },
    ],
  });
  const mat = await engine.build_native_model({ action: 'materialize', draft_id: s.draft_id });
  assert.equal(mat.build?.ok, true, JSON.stringify(mat.error || mat.build));
  const rows = await engine.get_query_result({ context_id: mat.context_id, table: mat.model });
  assert.equal(num(rows.rows[0].revenue), 130, 'fan-out double-counts u1 across both versions → 130 (vs the correct 100)');
  assert.equal(num(rows.rows[0].n), 6, 'u1 (2 purchases) × 2 versions + u2 + u3 = 6 joined rows');
});

// 6) The join-completeness nudge fires in the pipeline response for an SCD key-only join, naming the
//    REAL schema columns to fix it (the caller's key + the event-time + validity columns).
test('native pipeline: SCD key-only join surfaces the INCOMPLETE JOIN nudge with real column names', opts, async (t) => {
  if (skip(t)) return;
  const s = await engine.build_native_model({ action: 'start', name: 'scd_warn', source: 'events' });
  const r = await engine.build_native_model({ action: 'add_step', draft_id: s.draft_id, stage: { stage: 'join', with: 'users', on: 'internal_player_id', attrs: ['country'] } });
  const w = (r.recommendations || []).find((x) => /INCOMPLETE JOIN/.test(x));
  assert.ok(w, `expected an INCOMPLETE JOIN nudge, got ${JSON.stringify(r.recommendations)}`);
  assert.match(w, /internal_player_id/);        // the caller's join key, echoed
  assert.match(w, /device_time/);               // the event-time column from the catalog
  assert.match(w, /install_time_valid_from/);   // validity-window columns from the catalog
  assert.match(w, /install_time_valid_until/);
  // and the correct form (WITH between) produces NO such nudge
  const s2 = await engine.build_native_model({ action: 'start', name: 'scd_ok', source: 'events' });
  const r2 = await engine.build_native_model({ action: 'add_step', draft_id: s2.draft_id, stage: { stage: 'join', with: 'users', on: 'internal_player_id', attrs: ['country'], between: { value: 'device_time', from: 'install_time_valid_from', to: 'install_time_valid_until' } } });
  assert.ok(!(r2.recommendations || []).some((x) => /INCOMPLETE JOIN/.test(x)), 'no nudge once between is present');
});
