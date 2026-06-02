// DB-level A/B integration test: compute the per-variant PRELIMINARY AGGREGATES
// in the warehouse (PGlite + dbt) by materializing each A/B recipe's pipeline as a
// real model, read back the per-variant rows, then compute the FINAL STATISTICS
// (proportion / mean / CUPED) via the ab_test tool. We assert on the NUMBERS the
// tool returns — derived by hand from the seed — proving the full path:
//   events + experiments  ──pipeline──▶  per-variant rows  ──ab_test──▶  stats.
//
// Seed facts (window = experiment assignment 2026-01-01 → 2026-02-01):
//   experiments  control  = {u1,u3,u5,u7,u9,u11}   variant_b = {u2,u4,u6,u8,u10,u12}
//   iap purchases (price): u1=5+10, u3=5, u5=20, u7=10, u9=5, u11=10, u10=20
//   ⇒ conversion: control 6/6 = 1.0 ; variant_b 1/6 ≈ 0.1667 (only u10)
//   ⇒ revenue/user mean: control 65/6 ≈ 10.8333 ; variant_b 20/6 ≈ 3.3333
//   ⇒ CUPED: no events precede assigned_at ⇒ θ = 0 ⇒ adjusted == raw mean test.

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
const close = (a, b, tol = 1e-3) => assert.ok(Math.abs(a - b) <= tol, `${a} ≈ ${b}`);

let pg; let engine; let backend;
const recipes = loadRecipes(join(process.cwd(), 'config', 'recipes.json'));
const recipe = (id) => recipes.list.find((r) => r.id === id);

before(async () => {
  if (!HAS_DBT) return;
  pg = await startPglite();
  process.env.DBT_PG_PORT = String(pg.port);
  const env = { ...process.env, DBT_PROFILES_DIR: BASE, DBT_PROJECT_DIR: BASE, DBT_PG_PORT: String(pg.port) };
  await execFileP(DBT_BIN, ['seed'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  await execFileP(DBT_BIN, ['run'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  const catalog = loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), { profilesDir: BASE, projectDir: BASE });
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: mkdtempSync(join(tmpdir(), 'ab-')), timeSpineDialect: 'postgres' });
  backend = new MfEngineBackend({ pythonBin: PY_BIN, dbtBin: DBT_BIN, profilesDir: BASE });
  engine = new Engine({ catalog, contextManager: ctxs, runner: backend });
}, opts);

after(async () => { backend?.close(); if (pg) await pg.stop(); });

// Materialize a recipe's pipeline in the warehouse and return its per-variant rows
// keyed by variant_group (control / variant_b), plus a cleanup handle.
async function aggregatesFor(id) {
  const r = recipe(id);
  const out = await engine.register_native_model(r.register_payload);
  assert.equal(out.build.ok, true, `build failed for ${id}: ${JSON.stringify(out.error || out.build)}`);
  const map = r.ab_test;
  const byGroup = {};
  for (const row of out.rows) byGroup[String(row[map.group_field])] = row;
  return { map, byGroup, context_id: out.context_id };
}

// Turn one per-variant row into an ab_test arm using the recipe's field mapping.
function arm(map, row) {
  const a = { label: String(row[map.group_field]), n: Number(row[map.n_field]) };
  if (map.conversions_field) a.conversions = Number(row[map.conversions_field]);
  if (map.mean_field) { a.mean = Number(row[map.mean_field]); a.stddev = Number(row[map.stddev_field]); }
  for (const f of ['sumY', 'sumY2', 'sumX', 'sumX2', 'sumXY', 'sumNum', 'sumDen', 'sumNum2', 'sumDen2', 'sumNumDen']) if (map[`${f}_field`]) a[f] = Number(row[map[`${f}_field`]]);
  return a;
}

test('conversion: DB aggregates → two-proportion z-test (control 6/6 vs variant 1/6)', opts, async (t) => {
  if (!HAS_DBT) return t.skip('dbt/mf not installed');
  const { map, byGroup, context_id } = await aggregatesFor('ab_test_conversion');
  try {
    // preliminary counts computed IN the warehouse
    assert.equal(Number(byGroup.control.n), 6);
    assert.equal(Number(byGroup.variant_b.n), 6);
    assert.equal(Number(byGroup.control.conversions), 6);   // all six controls purchased
    assert.equal(Number(byGroup.variant_b.conversions), 1); // only u10 in variant_b

    const res = engine.ab_test({ metric: map.metric, control: arm(map, byGroup.control), variants: [arm(map, byGroup.variant_b)] });
    assert.equal(res.ok, true);
    const v = res.results[0];
    close(v.control_rate, 1.0);
    close(v.variant_rate, 1 / 6);
    close(v.absolute_lift, 1 / 6 - 1);
    assert.equal(v.significant, true); // 100% vs 17% on n=6 is a clear drop
    assert.ok(Number.isFinite(v.p_value) && v.p_value >= 0 && v.p_value <= 1);
  } finally { await engine.delete_native_model({ context_id }); }
});

test('revenue/user: DB aggregates → Welch t-test (means 10.833 vs 3.333)', opts, async (t) => {
  if (!HAS_DBT) return t.skip('dbt/mf not installed');
  const { map, byGroup, context_id } = await aggregatesFor('ab_test_revenue');
  try {
    assert.equal(Number(byGroup.control.n), 6);
    assert.equal(Number(byGroup.variant_b.n), 6);
    close(Number(byGroup.control.rev_mean), 65 / 6);   // (15+5+20+10+5+10)/6
    close(Number(byGroup.variant_b.rev_mean), 20 / 6); // only u10 = 20

    const res = engine.ab_test({ metric: map.metric, control: arm(map, byGroup.control), variants: [arm(map, byGroup.variant_b)] });
    assert.equal(res.ok, true);
    const v = res.results[0];
    close(v.control_mean, 65 / 6);
    close(v.variant_mean, 20 / 6);
    close(v.absolute_lift, 20 / 6 - 65 / 6);
    assert.ok(Number.isFinite(v.p_value) && v.p_value >= 0 && v.p_value <= 1);
  } finally { await engine.delete_native_model({ context_id }); }
});

test('CUPED: DB sufficient statistics → adjusted t-test (θ=0 with no pre-period)', opts, async (t) => {
  if (!HAS_DBT) return t.skip('dbt/mf not installed');
  const { map, byGroup, context_id } = await aggregatesFor('ab_test_cuped');
  try {
    assert.equal(Number(byGroup.control.n), 6);
    assert.equal(Number(byGroup.variant_b.n), 6);
    close(Number(byGroup.control.sum_y), 65);  // Σ in-experiment revenue (control)
    close(Number(byGroup.variant_b.sum_y), 20);
    close(Number(byGroup.control.sum_x), 0);   // no events precede assigned_at ⇒ X≡0
    close(Number(byGroup.variant_b.sum_x), 0);

    const res = engine.ab_test({ metric: map.metric, control: arm(map, byGroup.control), variants: [arm(map, byGroup.variant_b)] });
    assert.equal(res.ok, true);
    close(res.theta, 0, 1e-9);                 // Var(X)=0 ⇒ θ=0 ⇒ CUPED == plain test
    const v = res.results[0];
    close(v.theta, 0, 1e-9);
    close(v.variance_reduction, 0, 1e-9);      // no covariate signal removed
    close(v.control_mean, 65 / 6);             // adjusted mean == raw mean
    close(v.variant_mean, 20 / 6);
    assert.ok(Number.isFinite(v.p_value) && v.p_value >= 0 && v.p_value <= 1);
  } finally { await engine.delete_native_model({ context_id }); }
});

test('ratio: DB per-user sums → delta-method test (level completion 16/16 vs 10/12)', opts, async (t) => {
  if (!HAS_DBT) return t.skip('dbt/mf not installed');
  const { map, byGroup, context_id } = await aggregatesFor('ab_test_ratio');
  try {
    assert.equal(Number(byGroup.control.n), 6);
    assert.equal(Number(byGroup.variant_b.n), 6);
    // completed (numerator) / started (denominator), summed over the group's users
    close(Number(byGroup.control.sum_num), 15); close(Number(byGroup.control.sum_den), 16);   // 15 of 16 started levels completed
    close(Number(byGroup.variant_b.sum_num), 10); close(Number(byGroup.variant_b.sum_den), 12); // 10 of 12 completed

    const res = engine.ab_test({ metric: map.metric, control: arm(map, byGroup.control), variants: [arm(map, byGroup.variant_b)] });
    assert.equal(res.ok, true);
    const v = res.results[0];
    close(v.control_ratio, 15 / 16);      // 0.9375
    close(v.variant_ratio, 10 / 12);      // ≈ 0.8333
    close(v.absolute_lift, 10 / 12 - 15 / 16);
    assert.ok(Number.isFinite(v.p_value) && v.p_value >= 0 && v.p_value <= 1);
  } finally { await engine.delete_native_model({ context_id }); }
});

test('SRM: per-variant sizes computed in the DB pass the guardrail (6 vs 6)', opts, async (t) => {
  if (!HAS_DBT) return t.skip('dbt/mf not installed');
  const { map, byGroup, context_id } = await aggregatesFor('ab_test_conversion');
  try {
    // feed the warehouse-computed group sizes into the SRM check — a clean 6/6 split
    const groups = Object.values(byGroup).map((row) => ({ label: String(row[map.group_field]), n: Number(row[map.n_field]) }));
    const res = engine.srm_check({ groups });
    assert.equal(res.ok, true);
    close(res.chi_square, 0);             // 6 vs 6 against an even split
    assert.equal(res.srm_detected, false);
  } finally { await engine.delete_native_model({ context_id }); }
});
