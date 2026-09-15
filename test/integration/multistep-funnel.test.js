// Multi-step funnels where each STEP = event + property value.
// Two real shapes:
//   A) tutorial onboarding: event_name=tutorial, step keyed by event_data step_id
//      (step_1 -> step_2 -> step_3), with step-to-step conversion.
//   B) level funnel: event_name=level_started, step keyed by level_id (1 -> 2 -> 3).
// Exact numbers from test/integration/fixtures/SEED_DATA.md.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadCatalog } from '../../src/catalog.js';
import { loadRecipes } from '../../src/recipes.js';
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
const ctxOf = {};
const num = (v) => Number(v === '' || v == null ? NaN : v);
const create = async (decl) => {
  const out = await engine.create_semantic_model(decl);
  assert.equal(out.parse.ok, true, `parse failed for ${decl.name}: ${JSON.stringify(out.parse.error || out.parse)}`);
  ctxOf[decl.name] = out.context_id;
  return out;
};
const q = (task, args) => engine.query_semantic_model({ context_id: ctxOf[task], ...args });

before(async () => {
  if (!HAS_DBT) return;
  pg = await startPglite();
  process.env.DBT_PG_PORT = String(pg.port);
  const env = { ...process.env, DBT_PROFILES_DIR: BASE, DBT_PROJECT_DIR: BASE, DBT_PG_PORT: String(pg.port) };
  await execFileP(DBT_BIN, ['seed'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  await execFileP(DBT_BIN, ['run'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  const catalog = loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), { profilesDir: BASE, projectDir: BASE });
  const recipes = loadRecipes(join(process.cwd(), 'config', 'recipes.json'));
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: mkdtempSync(join(tmpdir(), 'msf-')), timeSpineDialect: 'postgres' });
  backend = new MfEngineBackend({ pythonBin: PY_BIN, dbtBin: DBT_BIN, profilesDir: BASE });
  engine = new Engine({ catalog, contextManager: ctxs, runner: backend, recipes });

  // Scenario A: build from the published recipe (tutorial step funnel)
  await create(recipes.get('funnel_from_event_property_steps').create_payload);

  // Scenario B: a level funnel keyed by level_id (event + property value)
  await create({
    name: 'lvlf',
    semantic_models: [{ from: 'events', measures: [
      { name: 'l1', agg: 'count', field: '*', event_name: ['level_started'], where: [{ property: 'level_id_of_event_data', op: 'eq', value: 1 }] },
      { name: 'l2', agg: 'count', field: '*', event_name: ['level_started'], where: [{ property: 'level_id_of_event_data', op: 'eq', value: 2 }] },
      { name: 'l3', agg: 'count', field: '*', event_name: ['level_started'], where: [{ property: 'level_id_of_event_data', op: 'eq', value: 3 }] },
      { name: 'u1', agg: 'count_distinct', field: 'player_id_of_internal', event_name: ['level_started'], where: [{ property: 'level_id_of_event_data', op: 'eq', value: 1 }] },
      { name: 'u2', agg: 'count_distinct', field: 'player_id_of_internal', event_name: ['level_started'], where: [{ property: 'level_id_of_event_data', op: 'eq', value: 2 }] },
    ] }],
    metrics: [
      { name: 's1', type: 'simple', measure: { name: 'l1' } },
      { name: 's2', type: 'simple', measure: { name: 'l2' } },
      { name: 's3', type: 'simple', measure: { name: 'l3' } },
      { name: 'conv_1_2', type: 'conversion', base_measure: { name: 'u1' }, conversion_measure: { name: 'u2' }, entity: 'user', window: '30 day' },
    ],
  });
}, opts);

after(async () => { backend?.close(); if (pg) await pg.stop(); });
const skip = (t) => { if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; } return false; };

// ── Scenario A: tutorial step funnel (event + step_id) ──

test('tutorial funnel: distinct users per step = 8 / 5 / 3 (event + step_id property)', opts, async (t) => {
  if (skip(t)) return;
  const r = await q('tut_funnel', { metrics: ['tut_funnel_step1', 'tut_funnel_step2', 'tut_funnel_step3'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const row = r.rows[0];
  assert.equal(num(row.tut_funnel_step1), 8);
  assert.equal(num(row.tut_funnel_step2), 5);
  assert.equal(num(row.tut_funnel_step3), 3);
  // monotonic drop-off
  assert.ok(num(row.tut_funnel_step1) >= num(row.tut_funnel_step2));
  assert.ok(num(row.tut_funnel_step2) >= num(row.tut_funnel_step3));
});

test('tutorial funnel: step-to-step conversion rates in (0,1] and reflect drop-off', opts, async (t) => {
  if (skip(t)) return;
  const c12 = await q('tut_funnel', { metrics: ['tut_funnel_conv_1_2'] });
  const c23 = await q('tut_funnel', { metrics: ['tut_funnel_conv_2_3'] });
  assert.equal(c12.ok, true, JSON.stringify(c12.error));
  assert.equal(c23.ok, true, JSON.stringify(c23.error));
  const v12 = num(c12.rows[0].tut_funnel_conv_1_2);
  const v23 = num(c23.rows[0].tut_funnel_conv_2_3);
  // step_2 ⊆ step_1 (5/8), step_3 ⊆ step_2 (3/5)
  assert.ok(v12 > 0 && v12 <= 1.0001, `conv_1_2=${v12}`);
  assert.ok(v23 > 0 && v23 <= 1.0001, `conv_2_3=${v23}`);
  assert.ok(Math.abs(v12 - 5 / 8) < 0.06, `conv_1_2≈0.625 got ${v12}`);
  assert.ok(Math.abs(v23 - 3 / 5) < 0.06, `conv_2_3≈0.6 got ${v23}`);
});

// ── Scenario B: level funnel (event + level_id) ──

test('level funnel: level_started counts by level_id = 12 / 6 / 3 (monotonic)', opts, async (t) => {
  if (skip(t)) return;
  const r = await q('lvlf', { metrics: ['lvlf_s1', 'lvlf_s2', 'lvlf_s3'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const row = r.rows[0];
  assert.equal(num(row.lvlf_s1), 12);
  assert.equal(num(row.lvlf_s2), 6);
  assert.equal(num(row.lvlf_s3), 3);
  assert.ok(num(row.lvlf_s1) >= num(row.lvlf_s2) && num(row.lvlf_s2) >= num(row.lvlf_s3));
});

test('level funnel: L1->L2 user conversion in (0,1]', opts, async (t) => {
  if (skip(t)) return;
  const r = await q('lvlf', { metrics: ['lvlf_conv_1_2'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const v = num(r.rows[0].lvlf_conv_1_2);
  assert.ok(v > 0 && v <= 1.0001, `conv_1_2=${v}`);
});
