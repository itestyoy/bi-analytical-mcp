// A metric query that outlasts its call is handed back as a query_id and runs on; get_query_result
// then returns the SAME rows the query would have returned inline. Proven on DATA against PGlite:
// the engine's grace is set to 1ms, so every real query detaches, and the numbers read back are
// SEED_DATA's (total IAP revenue 85; by country US 35 / GB 25 / BR 25).

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

let pg; let engine; let backend; let ctxId;

before(async () => {
  if (!HAS_DBT) return;
  pg = await startPglite();
  process.env.DBT_PG_PORT = String(pg.port);
  const env = { ...process.env, DBT_PROFILES_DIR: BASE, DBT_PROJECT_DIR: BASE, DBT_PG_PORT: String(pg.port) };
  await execFileP(DBT_BIN, ['seed'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  await execFileP(DBT_BIN, ['run'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: mkdtempSync(join(tmpdir(), 'detq-')), timeSpineDialect: 'postgres' });
  backend = new MfEngineBackend({ pythonBin: PY_BIN, dbtBin: DBT_BIN, profilesDir: BASE });
  engine = new Engine({ catalog: loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), { profilesDir: BASE, projectDir: BASE }), contextManager: ctxs, runner: backend, queryTimeoutMs: 1 });
  const out = await engine.create_semantic_model({
    name: 'mon', use_base_models: ['users'],
    semantic_models: [{ from: 'events', event_scope: { event_name: ['iap_purchase_completed'] }, measures: [{ name: 'revenue', agg: 'sum', field: 'price_in_usd_of_event_data' }] }],
    metrics: [{ name: 'revenue', type: 'simple', measure: { name: 'revenue' } }],
  });
  assert.equal(out.parse.ok, true, JSON.stringify(out.parse));
  ctxId = out.context_id;
}, opts);

after(async () => { backend?.close(); if (pg) await pg.stop(); });
const skip = (t) => { if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; } return false; };

async function follow(queryId) {
  for (let i = 0; i < 300; i++) {
    const r = await engine.get_query_result({ query_id: queryId });
    if (r.status !== 'running') return r;
    await sleep(200);
  }
  throw new Error(`query ${queryId} never finished`);
}

test('a metric query past its grace hands back a query_id; the rows arrive through get_query_result', opts, async (t) => {
  if (skip(t)) return;
  const first = await engine.query_semantic_model({ context_id: ctxId, metrics: ['mon_revenue'] });
  assert.equal(first.status, 'running', JSON.stringify(first));
  assert.match(first.query_id, /^[a-f0-9]{12}$/);
  const done = await follow(first.query_id);
  assert.equal(done.ok, true, JSON.stringify(done.error));
  assert.equal(done.status, 'ready');
  assert.equal(Number(done.rows[0].mon_revenue), 85);
});

test('a detached query keeps its grouping and the caller-facing column names', opts, async (t) => {
  if (skip(t)) return;
  const first = await engine.query_semantic_model({ context_id: ctxId, metrics: ['mon_revenue'], group_by: [{ model: 'users', attribute: 'country' }] });
  assert.equal(first.status, 'running');
  const done = await follow(first.query_id);
  const by = Object.fromEntries(done.rows.map((r) => [String(r.users_country), Number(r.mon_revenue)]));
  assert.equal(by.US, 35);
  assert.equal(by.GB, 25);
  assert.equal(by.BR, 25);
});

test('a detached query that FAILS reports the failure through get_query_result', opts, async (t) => {
  if (skip(t)) return;
  // a filter on a value the warehouse cannot compare (a string against a numeric attribute) fails in the warehouse
  const first = await engine.query_semantic_model({ context_id: ctxId, metrics: ['mon_revenue'], where: { op: 'and', conditions: [{ field: { kind: 'metric_time' }, op: 'eq', value: 'not-a-date' }] } });
  if (first.status !== 'running') { assert.equal(first.ok, false, 'refused before running is fine too'); return; }
  const done = await follow(first.query_id);
  assert.equal(done.ok, false);
  assert.equal(done.status, 'error');
});
