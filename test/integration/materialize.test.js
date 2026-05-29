// Materialization mode + background jobs: a query is compiled to SQL, written as
// a materialized='table' dbt model, built (dbt run), and rows are read back from
// that table (dbt show) — results live in the warehouse (resilient/re-fetchable).
// Slow queries (> timeout) return a query_id; get_query_result polls + fetches.
// Data-only assertions.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
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
const num = (v) => Number(v);

let pg; let engine; let backend; let ctxId;

before(async () => {
  if (!HAS_DBT) return;
  pg = await startPglite();
  process.env.DBT_PG_PORT = String(pg.port);
  const env = { ...process.env, DBT_PROFILES_DIR: BASE, DBT_PROJECT_DIR: BASE, DBT_PG_PORT: String(pg.port) };
  await execFileP(DBT_BIN, ['seed'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  await execFileP(DBT_BIN, ['run'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: mkdtempSync(join(tmpdir(), 'mat-')), timeSpineDialect: 'postgres' });
  backend = new MfEngineBackend({ pythonBin: PY_BIN, dbtBin: DBT_BIN, profilesDir: BASE });
  engine = new Engine({ catalog: loadCatalog(join(process.cwd(), 'config', 'catalog.yml'), { profilesDir: BASE, projectDir: BASE }), contextManager: ctxs, runner: backend, queryTimeoutMs: 60000 });
  const out = await engine.create_semantic_model({
    name: 'mon', use_base_models: ['users'],
    semantic_models: [{ from: 'events', event_scope: { event_name: ['iap_purchase_completed'] }, measures: [{ name: 'revenue', agg: 'sum', field: 'price_in_usd' }] }],
    metrics: [{ name: 'revenue', type: 'simple', measure: { name: 'revenue' } }],
  });
  assert.equal(out.parse.ok, true, JSON.stringify(out.parse));
  ctxId = out.context_id;
}, opts);

after(async () => { backend?.close(); if (pg) await pg.stop(); });
const skip = (t) => { if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; } return false; };

test('materialize (sync): query persisted as a table, rows read back = total revenue 85', opts, async (t) => {
  if (skip(t)) return;
  const r = await engine.query_semantic_model({ context_id: ctxId, metrics: ['mon_revenue'], materialize: true });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.status, 'ready');
  assert.ok(r.query_id && r.table, 'returns query_id + table');
  assert.equal(num(r.rows[0].mon_revenue), 85);
  globalThis.__matTable = r.table;
  globalThis.__matQid = r.query_id;
});

test('resilient re-fetch: read the materialized result table directly by name', opts, async (t) => {
  if (skip(t)) return;
  const r = await engine.get_query_result({ context_id: ctxId, table: globalThis.__matTable });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.status, 'ready');
  assert.equal(num(r.rows[0].mon_revenue), 85); // recomputes nothing — reads the table
});

test('get_query_result by query_id returns the same materialized rows', opts, async (t) => {
  if (skip(t)) return;
  const r = await engine.get_query_result({ context_id: ctxId, query_id: globalThis.__matQid });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(num(r.rows[0].mon_revenue), 85);
});

test('background: timeout -> running + query_id, then poll get_query_result to ready', opts, async (t) => {
  if (skip(t)) return;
  engine.queryTimeoutMs = 1; // force background
  const started = await engine.query_semantic_model({ context_id: ctxId, metrics: ['mon_revenue'], group_by: ['user__country'], materialize: true });
  assert.equal(started.status, 'running', JSON.stringify(started));
  assert.ok(started.query_id);
  let res;
  for (let i = 0; i < 60; i++) {
    res = await engine.get_query_result({ context_id: ctxId, query_id: started.query_id });
    if (res.status !== 'running') break;
    await sleep(1000);
  }
  engine.queryTimeoutMs = 60000;
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.equal(res.status, 'ready');
  const total = res.rows.reduce((s, x) => s + num(x.mon_revenue), 0);
  assert.equal(total, 85); // revenue by country sums to the grand total
});

test('transform: compress/re-slice the materialized result table (where/group_by/agg/having)', opts, async (t) => {
  if (skip(t)) return;
  // materialize revenue by country (multi-row), then project over the stored table
  const m = await engine.query_semantic_model({ context_id: ctxId, metrics: ['mon_revenue'], group_by: ['user__country'], materialize: true });
  assert.equal(m.status, 'ready', JSON.stringify(m));

  // (a) compress to a single total
  const totalR = await engine.get_query_result({ context_id: ctxId, table: m.table, transform: { aggregations: [{ fn: 'sum', column: 'mon_revenue', as: 'total' }] } });
  assert.equal(totalR.ok, true, JSON.stringify(totalR.error));
  assert.equal(num(totalR.rows[0].total), 85);

  // (b) filter (where) to one country -> exact seed value (US revenue = 35)
  const us = await engine.get_query_result({ context_id: ctxId, table: m.table, transform: { where: [{ column: 'user__country', op: 'eq', value: 'US' }], aggregations: [{ fn: 'sum', column: 'mon_revenue', as: 'rev' }] } });
  assert.equal(us.ok, true, JSON.stringify(us.error));
  assert.equal(num(us.rows[0].rev), 35);

  // (b2) injection/escaping proven on DATA: a value containing a quote+SQL is
  // bound as a literal -> the query runs safely and simply matches nothing.
  const inj = await engine.get_query_result({ context_id: ctxId, table: m.table, transform: { where: [{ column: 'user__country', op: 'eq', value: "US'); drop table x; --" }], aggregations: [{ fn: 'sum', column: 'mon_revenue', as: 'rev' }] } });
  assert.equal(inj.ok, true, JSON.stringify(inj.error)); // no SQL error: the literal was escaped
  assert.ok(inj.rows.length === 0 || num(inj.rows[0].rev) === 0 || inj.rows[0].rev == null); // matches no country

  // (c) group_by + having + count of qualifying groups
  const big = await engine.get_query_result({ context_id: ctxId, table: m.table, transform: { group_by: ['user__country'], aggregations: [{ fn: 'sum', column: 'mon_revenue', as: 'rev' }], having: [{ fn: 'sum', column: 'mon_revenue', op: 'gte', value: 25 }], order_by: [{ key: 'rev', direction: 'desc' }] } });
  assert.equal(big.ok, true, JSON.stringify(big.error));
  assert.ok(big.rows.every((r) => num(r.rev) >= 25)); // HAVING applied
  assert.ok(big.rows.reduce((s, r) => s + num(r.rev), 0) <= 85);
});
