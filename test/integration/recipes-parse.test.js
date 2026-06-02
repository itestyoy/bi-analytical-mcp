// Every recipe must be RUNNABLE end-to-end: its create_payload parses (dbt parse)
// and its first example query executes (mf query). This guarantees the recipes we
// hand to the agent actually build valid models and compute metrics.

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
const recipes = loadRecipes(join(process.cwd(), 'config', 'recipes.json'));

before(async () => {
  if (!HAS_DBT) return;
  pg = await startPglite();
  process.env.DBT_PG_PORT = String(pg.port);
  const env = { ...process.env, DBT_PROFILES_DIR: BASE, DBT_PROJECT_DIR: BASE, DBT_PG_PORT: String(pg.port) };
  await execFileP(DBT_BIN, ['seed'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  await execFileP(DBT_BIN, ['run'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  const catalog = loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), { profilesDir: BASE, projectDir: BASE });
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: mkdtempSync(join(tmpdir(), 'rp-')), timeSpineDialect: 'postgres' });
  backend = new MfEngineBackend({ pythonBin: PY_BIN, dbtBin: DBT_BIN, profilesDir: BASE });
  engine = new Engine({ catalog, contextManager: ctxs, runner: backend });
}, opts);

after(async () => { backend?.close(); if (pg) await pg.stop(); });

for (const r of recipes.list) {
  test(`recipe '${r.id}' is runnable end-to-end`, opts, async (t) => {
    if (!HAS_DBT) return t.skip('dbt/mf not installed');

    // Tool-only recipe (no warehouse), e.g. power/sample-size planning: run each
    // declared tool call and assert it computes a successful result.
    if (r.tool_calls) {
      for (const call of r.tool_calls) {
        const res = engine[call.tool](call.args);
        assert.equal(res.ok, true, `${r.id}: tool ${call.tool} failed: ${JSON.stringify(res)}`);
      }
      return;
    }

    // Pipeline/register-based recipe (e.g. A/B): build the model, then — if it
    // declares an ab_test or srm_check mapping — feed its per-group rows into the tool.
    if (r.register_payload) {
      const out = await engine.register_native_model(r.register_payload);
      assert.equal(out.build.ok, true, `build failed for ${r.id}: ${JSON.stringify(out.error || out.build)}`);
      assert.ok(Array.isArray(out.rows) && out.rows.length >= 2, `${r.id} expected >=2 group rows`);
      if (r.ab_test) {
        const map = r.ab_test;
        const arms = out.rows.map((row) => {
          const arm = { label: String(row[map.group_field]), n: Number(row[map.n_field]) };
          if (map.conversions_field) arm.conversions = Number(row[map.conversions_field]);
          if (map.mean_field) { arm.mean = Number(row[map.mean_field]); arm.stddev = Number(row[map.stddev_field]); }
          for (const f of ['sumY', 'sumY2', 'sumX', 'sumX2', 'sumXY', 'sumNum', 'sumDen', 'sumNum2', 'sumDen2', 'sumNumDen']) if (map[`${f}_field`]) arm[f] = Number(row[map[`${f}_field`]]);
          return arm;
        });
        const [control, ...variants] = arms;
        const res = engine.ab_test({ metric: map.metric, control, variants });
        assert.equal(res.ok, true, `ab_test failed for ${r.id}: ${JSON.stringify(res)}`);
        assert.equal(res.results.length, variants.length);
        for (const v of res.results) assert.ok(Number.isFinite(v.p_value) && v.p_value >= 0 && v.p_value <= 1, `bad p_value for ${r.id}`);
      }
      if (r.srm_check) {
        const map = r.srm_check;
        const groups = out.rows.map((row) => ({ label: String(row[map.group_field]), n: Number(row[map.n_field]) }));
        const res = engine.srm_check({ groups, ...(map.expected_ratio ? { expected_ratio: map.expected_ratio } : {}) });
        assert.equal(res.ok, true, `srm_check failed for ${r.id}: ${JSON.stringify(res)}`);
        assert.ok(Number.isFinite(res.p_value) && res.p_value >= 0 && res.p_value <= 1, `bad p_value for ${r.id}`);
      }
      await engine.delete_native_model({ context_id: out.context_id });
      return;
    }

    // Semantic-model recipe: create + run its first example query.
    const out = await engine.create_semantic_model(r.create_payload);
    assert.equal(out.parse.ok, true, `parse failed for ${r.id}: ${JSON.stringify(out.parse.error || out.parse)}`);
    const example = (r.example_queries || [])[0];
    if (example) {
      const res = await engine.query_semantic_model({ context_id: out.context_id, ...example });
      assert.equal(res.ok, true, `query failed for ${r.id}: ${JSON.stringify(res.error || res)}`);
      assert.ok(Array.isArray(res.rows), `${r.id} returned no rows array`);
    }
  });
}
