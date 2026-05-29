// engine=match_recognize: the server generates the row-pattern SQL from the
// declared ordered steps. Production target is BigQuery MATCH_RECOGNIZE; here we
// execute the equivalent on PGlite (BigQuery isn't available locally) and assert
// the funnel NUMBERS — data-only, events-only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { startPglite } from './pglite-harness.js';

const execFileP = promisify(execFile);
const BASE = join(process.cwd(), 'test', 'integration', 'fixtures', 'dbt_project');
const DBT_BIN = process.env.DBT_BIN || join(process.cwd(), '.dbtvenv', 'bin', 'dbt');
const MF_BIN = process.env.MF_BIN || join(process.cwd(), '.dbtvenv', 'bin', 'mf');
const HAS_DBT = existsSync(DBT_BIN) && existsSync(MF_BIN);
const opts = { timeout: 300000 };

let pg; let engine;
const num = (v) => Number(v);

before(async () => {
  if (!HAS_DBT) return;
  pg = await startPglite();
  process.env.DBT_PG_PORT = String(pg.port);
  const env = { ...process.env, DBT_PROFILES_DIR: BASE, DBT_PROJECT_DIR: BASE, DBT_PG_PORT: String(pg.port) };
  await execFileP(DBT_BIN, ['seed'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  await execFileP(DBT_BIN, ['run'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  // sqlRunner executes the generated (Postgres-equivalent) SQL on the same PGlite db
  const sqlRunner = async (sql) => {
    const r = await pg.db.query(sql);
    return { rows: r.rows, columns: (r.fields || []).map((f) => ({ name: f.name })) };
  };
  engine = new Engine({ catalog: loadCatalog(join(process.cwd(), 'config', 'catalog.json')), contextManager: new ContextManager({ baseProjectDir: BASE, workspaceRoot: mkdtempSync(join(tmpdir(), 'mr-')), timeSpineDialect: 'postgres' }), runner: null, sqlRunner });
}, opts);

after(async () => { if (pg) await pg.stop(); });
const skip = (t) => { if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; } return false; };

const FUNNEL = {
  name: 'activation', engine: 'match_recognize',
  sequence: { partition_by: 'user', mode: 'ordered', steps: [
    { name: 'launch', event_name: ['first_launch'] },
    { name: 'tut1', event_name: ['tutorial'], where: [{ property: 'step_id', op: 'eq', value: 'step_1' }] },
    { name: 'tut2', event_name: ['tutorial'], where: [{ property: 'step_id', op: 'eq', value: 'step_2' }] },
    { name: 'tut3', event_name: ['tutorial'], where: [{ property: 'step_id', op: 'eq', value: 'step_3' }] },
  ] },
};

test('match_recognize: create returns step metadata + generated SQL (engine routed off MetricFlow)', opts, async (t) => {
  if (skip(t)) return;
  const out = await engine.create_semantic_model(FUNNEL);
  assert.equal(out.engine, 'match_recognize');
  assert.deepEqual(out.steps, ['launch', 'tut1', 'tut2', 'tut3']);
  globalThis.__mrctx = out.context_id;
});

test('match_recognize: 4-step ordered funnel reached counts = 12 / 8 / 5 / 3 (on data)', opts, async (t) => {
  if (skip(t)) return;
  const res = await engine.query_semantic_model({ context_id: globalThis.__mrctx });
  assert.equal(res.ok, true, JSON.stringify(res));
  const row = res.rows[0];
  assert.equal(num(row.reached_launch), 12);
  assert.equal(num(row.reached_tut1), 8);
  assert.equal(num(row.reached_tut2), 5);
  assert.equal(num(row.reached_tut3), 3);
  // strictly monotonic funnel
  assert.ok(num(row.reached_launch) >= num(row.reached_tut1));
  assert.ok(num(row.reached_tut1) >= num(row.reached_tut2));
  assert.ok(num(row.reached_tut2) >= num(row.reached_tut3));
});

test('match_recognize: strict (immediately-next) mode also runs on data and is <= ordered', opts, async (t) => {
  if (skip(t)) return;
  const out = await engine.create_semantic_model({ ...FUNNEL, name: 'activation_strict', sequence: { ...FUNNEL.sequence, mode: 'strict' } });
  const res = await engine.query_semantic_model({ context_id: out.context_id });
  assert.equal(res.ok, true, JSON.stringify(res));
  const row = res.rows[0];
  // strict adjacency can only be <= the ordered (gaps-allowed) counts
  assert.ok(num(row.reached_tut1) <= 8);
  assert.ok(num(row.reached_tut2) <= 5);
  assert.ok(num(row.reached_tut3) <= 3);
  assert.ok(num(row.reached_launch) >= 0);
});
