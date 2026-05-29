// engine=match_recognize as a VIEW base model + a core MetricFlow semantic model
// on top. The server generates a per-user MATCH_RECOGNIZE model (BigQuery in
// prod; Postgres equivalent here), materializes it as a VIEW (dbt run), builds a
// semantic model over it, and queries metrics via MetricFlow — including JOINs to
// user attributes. Data-only assertions.

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

let pg; let engine; let backend;
const num = (v) => Number(v);
const mapCol = (rows, k, v) => Object.fromEntries(rows.map((r) => [String(r[k]), num(r[v])]));

before(async () => {
  if (!HAS_DBT) return;
  pg = await startPglite();
  process.env.DBT_PG_PORT = String(pg.port);
  const env = { ...process.env, DBT_PROFILES_DIR: BASE, DBT_PROJECT_DIR: BASE, DBT_PG_PORT: String(pg.port) };
  await execFileP(DBT_BIN, ['seed'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  await execFileP(DBT_BIN, ['run'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: mkdtempSync(join(tmpdir(), 'mr-')), timeSpineDialect: 'postgres' });
  backend = new MfEngineBackend({ pythonBin: PY_BIN, dbtBin: DBT_BIN, profilesDir: BASE });
  engine = new Engine({ catalog: loadCatalog(join(process.cwd(), 'config', 'catalog.json')), contextManager: ctxs, runner: backend });

  const out = await engine.register_native_model({
    name: 'activation',
    sequence: {
      partition_by: 'user', mode: 'ordered',
      steps: [
        { name: 'launch', event_name: ['first_launch'] },
        { name: 'tut1', event_name: ['tutorial'], where: [{ property: 'step_id', op: 'eq', value: 'step_1' }] },
        { name: 'tut2', event_name: ['tutorial'], where: [{ property: 'step_id', op: 'eq', value: 'step_2' }] },
        { name: 'tut3', event_name: ['tutorial'], where: [{ property: 'step_id', op: 'eq', value: 'step_3' }] },
      ],
      metrics: [
        { name: 'cr_launch_tut1', type: 'conversion', from: 'launch', to: 'tut1' },
      ],
    },
  });
  assert.equal(out.build.ok, true, `build failed: ${JSON.stringify(out.build)}`);
  globalThis.__mrctx = out.context_id;
  globalThis.__mrmetrics = out.metrics;
}, opts);

after(async () => { backend?.close(); if (pg) await pg.stop(); });
const skip = (t) => { if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; } return false; };

test('MR view: reached_<step> via MetricFlow = 12 / 8 / 5 / 3 (semantic model on the view)', opts, async (t) => {
  if (skip(t)) return;
  const r = await engine.query_semantic_model({ context_id: globalThis.__mrctx, metrics: ['reached_launch', 'reached_tut1', 'reached_tut2', 'reached_tut3'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const row = r.rows[0];
  assert.equal(num(row.reached_launch), 12);
  assert.equal(num(row.reached_tut1), 8);
  assert.equal(num(row.reached_tut2), 5);
  assert.equal(num(row.reached_tut3), 3);
});

test('MR view: users by furthest_step_name partition to 12 (local dim on the view)', opts, async (t) => {
  if (skip(t)) return;
  const r = await engine.query_semantic_model({ context_id: globalThis.__mrctx, metrics: ['users'], group_by: ['furthest_step_name'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const total = r.rows.reduce((s, x) => s + num(x.users), 0);
  assert.equal(total, 12);
  const by = mapCol(r.rows, 'user__furthest_step_name', 'users');
  assert.equal(by.tut3, 3); // only u1,u2,u3 reach the last step
});

test('MR view: reached_tut1 broken down by country (user attr carried into the view)', opts, async (t) => {
  if (skip(t)) return;
  const r = await engine.query_semantic_model({ context_id: globalThis.__mrctx, metrics: ['reached_tut1'], group_by: ['country'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const total = r.rows.reduce((s, x) => s + num(x.reached_tut1), 0);
  assert.equal(total, 8); // step_1 reached by 8 users, summed across countries
  assert.ok(r.rows.some((x) => x.user__country != null)); // breakdown column present
});

test('MR view: declared conversion metric (launch->tut1) = 8/12 in (0,1]', opts, async (t) => {
  if (skip(t)) return;
  const r = await engine.query_semantic_model({ context_id: globalThis.__mrctx, metrics: ['cr_launch_tut1'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const v = num(r.rows[0].cr_launch_tut1);
  assert.ok(Math.abs(v - 8 / 12) < 1e-6, `cr=${v}`);
});

test('update_native_model: shrink to a 3-step funnel, rebuild, re-query on data', opts, async (t) => {
  if (skip(t)) return;
  const upd = await engine.update_native_model({
    context_id: globalThis.__mrctx, name: 'activation',
    sequence: { partition_by: 'user', mode: 'ordered', steps: [
      { name: 'launch', event_name: ['first_launch'] },
      { name: 'tut1', event_name: ['tutorial'], where: [{ property: 'step_id', op: 'eq', value: 'step_1' }] },
      { name: 'tut2', event_name: ['tutorial'], where: [{ property: 'step_id', op: 'eq', value: 'step_2' }] },
    ] },
  });
  assert.equal(upd.build.ok, true, JSON.stringify(upd.build));
  assert.ok(upd.metrics.includes('reached_tut2') && !upd.metrics.includes('reached_tut3'));
  const r = await engine.query_semantic_model({ context_id: globalThis.__mrctx, metrics: ['reached_launch', 'reached_tut1', 'reached_tut2'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(num(r.rows[0].reached_launch), 12);
  assert.equal(num(r.rows[0].reached_tut2), 5);
});

test('delete_native_model: removes the model + semantic; context no longer serves it', opts, async (t) => {
  if (skip(t)) return;
  const del = await engine.delete_native_model({ context_id: globalThis.__mrctx });
  assert.equal(del.removed, true);
  assert.equal(del.parse.ok, true, JSON.stringify(del.parse));
  await assert.rejects(() => engine.query_semantic_model({ context_id: globalThis.__mrctx, metrics: ['reached_launch'] }));
});
