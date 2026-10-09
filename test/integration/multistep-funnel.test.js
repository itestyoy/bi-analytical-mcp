// Multi-step funnels where each STEP = event + property value.
// Two real shapes:
//   A) tutorial onboarding: event_name=tutorial, step keyed by event_data step_id
//      (step_1 -> step_2 -> step_3), with the step-to-step share (a ratio metric).
//   B) level funnel: event_name=level_started, step keyed by level_id (1 -> 2 -> 3).
// Exact numbers from test/integration/fixtures/SEED_DATA.md.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadCatalog } from '../../src/catalog.js';
import { loadRecipes } from '../../src/recipes.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { startWarehouse, fixtureProject } from './warehouse-harness.js';
import { settle } from '../helpers/settle.js';
import { DBT_BIN, HAS_DBT, testDbt } from '../helpers/dbt-env.js';

const execFileP = promisify(execFile);
const BASE = fixtureProject('dbt_project'); // a private copy: the test files run side by side
const opts = { timeout: 300000 };

let wh; let engine; let backend;
const ctxOf = {};
const num = (v) => Number(v === '' || v == null ? NaN : v);
const create = async (decl) => {
  const out = await engine.build_semantic_model(decl);
  assert.equal(out.parse.ok, true, `parse failed for ${decl.name}: ${JSON.stringify(out.parse.error || out.parse)}`);
  ctxOf[decl.name] = out.context_id;
  return out;
};
const q = (task, args) => engine.query_semantic_model({ context_id: ctxOf[task], ...args });

before(async () => {
  if (!HAS_DBT) return;
  wh = await startWarehouse();
  const env = { ...process.env, DBT_PROFILES_DIR: BASE, DBT_PROJECT_DIR: BASE, DUCKDB_PATH: wh.path };
  await execFileP(DBT_BIN, ['seed'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  await execFileP(DBT_BIN, ['run'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  const catalog = loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), { profilesDir: BASE, projectDir: BASE });
  const recipes = loadRecipes(join(process.cwd(), 'config', 'recipes.json'));
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: mkdtempSync(join(tmpdir(), 'msf-')), timeSpineDialect: 'duckdb' });
  backend = testDbt({ profilesDir: BASE });
  engine = settle(new Engine({ catalog, contextManager: ctxs, runner: backend, recipes }));

  // Scenario A: build from the published recipe (tutorial step funnel)
  await create(recipes.get('funnel_from_event_property_steps').semantic_payload);

  // Scenario B: a level funnel keyed by level_id (event + property value)
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

test('tutorial funnel: the step-to-step share is who reached the next step over who reached this one (5/8, 3/5)', opts, async (t) => {
  if (skip(t)) return;
  const r = await q('tut_funnel', { metrics: ['tut_funnel_conv_1_2', 'tut_funnel_conv_2_3'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.ok(Math.abs(num(r.rows[0].tut_funnel_conv_1_2) - 5 / 8) < 1e-9);
  assert.ok(Math.abs(num(r.rows[0].tut_funnel_conv_2_3) - 3 / 5) < 1e-9);
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

test('level funnel: the L1->L2 share of players is the L2 players over the L1 players, in (0,1)', opts, async (t) => {
  if (skip(t)) return;
  const r = await q('lvlf', { metrics: ['lvlf_p1', 'lvlf_p2', 'lvlf_conv_1_2'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const row = r.rows[0];
  const v = num(row.lvlf_conv_1_2);
  assert.ok(num(row.lvlf_p2) > 0 && num(row.lvlf_p2) < num(row.lvlf_p1), JSON.stringify(row));
  assert.ok(Math.abs(v - num(row.lvlf_p2) / num(row.lvlf_p1)) < 1e-9, `conv_1_2=${v}`);
});
