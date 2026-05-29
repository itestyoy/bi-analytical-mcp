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

test('MR view: reached_tut1 broken down by country (user attr JOINED at the semantic layer)', opts, async (t) => {
  if (skip(t)) return;
  // country lives on dim_users, NOT in the view. MetricFlow joins it via the
  // shared `user` entity during SQL generation — no join baked into the view.
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

test('MR + semantic model: a sequence measure grouped by a LOCAL view dim AND a JOINED user dim in one query', opts, async (t) => {
  if (skip(t)) return;
  // Strongest proof of the architecture: the user-dim join is DECLARED in the
  // semantic model (shared `user` entity), not baked into the view. One
  // MetricFlow query groups reached_tut1 by furthest_step_name (a column of the
  // view) AND platform (a column that lives ONLY on dim_users) — MetricFlow
  // performs the join at SQL generation.
  const r = await engine.query_semantic_model({
    context_id: globalThis.__mrctx,
    metrics: ['reached_tut1'],
    group_by: ['furthest_step_name', 'platform'],
  });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.ok(r.rows.every((x) => 'user__furthest_step_name' in x && 'user__platform' in x), 'both breakdown columns present');
  // grand total over the 2-D grid reconciles to the 8 users who reached tut1
  const total = r.rows.reduce((s, x) => s + num(x.reached_tut1), 0);
  assert.equal(total, 8);
  // reached_tut1 is only attributed to users whose furthest step is tut1/tut2/tut3
  const reachers = new Set(['tut1', 'tut2', 'tut3']);
  assert.ok(r.rows.every((x) => num(x.reached_tut1) === 0 || reachers.has(String(x.user__furthest_step_name))));
});

test('MR + semantic model: declared conversion metric sliced by a JOINED user attribute (country)', opts, async (t) => {
  if (skip(t)) return;
  const r = await engine.query_semantic_model({ context_id: globalThis.__mrctx, metrics: ['cr_launch_tut1'], group_by: ['country'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.ok(r.rows.length >= 1);
  assert.ok(r.rows.some((x) => x.user__country != null)); // join produced the country breakdown
  // every per-country conversion rate is a valid ratio in [0,1]
  assert.ok(r.rows.every((x) => { const v = num(x.cr_launch_tut1); return !Number.isFinite(v) || (v >= -1e-9 && v <= 1 + 1e-9); }));
});

test('describe_catalog: returns REAL physical columns for every model (adapter introspection)', opts, async (t) => {
  if (skip(t)) return;
  const dc = await engine.describe_catalog();
  const events = dc.models.find((m) => m.key === 'events');
  const users = dc.models.find((m) => m.key === 'users');
  const evCols = events.physical_columns.map((c) => c.name);
  const uCols = users.physical_columns.map((c) => c.name);
  // actual warehouse columns, not declared metadata
  assert.ok(['event_name', 'appsflyer_id', 'event_data', 'device_time', 'session_number'].every((c) => evCols.includes(c)));
  assert.ok(['appsflyer_id', 'country', 'platform', 'install_date'].every((c) => uCols.includes(c)));
  assert.ok(events.physical_columns.every((c) => typeof c.dtype === 'string')); // real types present
});

test('describe_context: the registered native model is introspectable like a dbt model (properties)', opts, async (t) => {
  if (skip(t)) return;
  const d = await engine.describe_context({ context_id: globalThis.__mrctx });
  assert.ok(d.models[0].physical_columns.some((c) => c.name === 'furthest_step_name'), 'real physical columns from the view');
  assert.equal(d.engine, 'match_recognize');
  assert.equal(d.models.length, 1);
  const m = d.models[0];
  assert.equal(m.model, 'seq_activation');
  // dimensions: furthest_step_name is LOCAL to the view; country/platform are
  // reachable via the declared join to dim_users (not columns of the view).
  assert.ok(m.dimensions.includes('furthest_step_name'));
  assert.ok(m.dimensions.includes('country') && m.dimensions.includes('platform'));
  // measures + metrics computed by MATCH_RECOGNIZE are exposed
  assert.ok(m.measures.includes('reached_tut1') && m.measures.includes('users'));
  assert.ok(m.metrics.includes('cr_launch_tut1'));
  assert.ok(d.groupable.includes('furthest_step_name') && d.groupable.includes('country'));
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
