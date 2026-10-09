// Every recipe must be RUNNABLE end-to-end: its semantic_payload parses (dbt parse)
// and its first example query executes (mf query); its pipeline_payload — a build_pipeline_model
// start request — is sent AS IT STANDS, with materialize: true, and its build returns rows. This
// guarantees the recipes we hand to the agent are requests the tools take, and compute.
//
// What this loop leaves to others, so nothing is run twice: a recipe another test builds from its
// own payload and proves on its numbers (DATA_TESTED, test/helpers/recipe-coverage.js), and the kinds
// that never read the warehouse — a PYTHON-model recipe (compiled and gated in
// test/unit/python-stage.test.js), a generated REFERENCE entry and a tool-only recipe
// (test/unit/recipes-layers.test.js). Any recipe not covered there, a new one included, runs here.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadCatalog } from '../../src/catalog.js';
import { loadRecipes } from '../../src/recipes.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { startWarehouse, fixtureProject } from './warehouse-harness.js';
import { settle, startAndBuild } from '../helpers/settle.js';
import { armFrom } from '../helpers/experiment-arm.js';
import { DBT_BIN, HAS_DBT, testDbt } from '../helpers/dbt-env.js';
import { DATA_TESTED } from '../helpers/recipe-coverage.js';

const execFileP = promisify(execFile);
const BASE = fixtureProject('dbt_project'); // a private copy: the test files run side by side
const opts = { timeout: 300000 };

let wh; let engine; let backend;
const recipes = loadRecipes(join(process.cwd(), 'config', 'recipes.json'));

before(async () => {
  if (!HAS_DBT) return;
  wh = await startWarehouse();
  const env = { ...process.env, DBT_PROFILES_DIR: BASE, DBT_PROJECT_DIR: BASE, DUCKDB_PATH: wh.path };
  await execFileP(DBT_BIN, ['seed'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  await execFileP(DBT_BIN, ['run'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  const catalog = loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), { profilesDir: BASE, projectDir: BASE });
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: mkdtempSync(join(tmpdir(), 'rp-')), timeSpineDialect: 'duckdb' });
  backend = testDbt({ profilesDir: BASE });
  engine = settle(new Engine({ catalog, contextManager: ctxs, runner: backend }));
}, opts);

after(async () => { backend?.close?.(); if (wh) await wh.stop(); });

// The recipes only this loop proves: not data-tested elsewhere, and of a kind that reads the warehouse.
const RUN_HERE = recipes.list.filter((r) => !DATA_TESTED[r.id] && !r.reference && r.requires !== 'python_models' && !r.tool_calls);

for (const r of RUN_HERE) {
  test(`recipe '${r.id}' is runnable end-to-end`, opts, async (t) => {
    if (!HAS_DBT) return t.skip('dbt/mf not installed');

    // Pipeline recipe (e.g. A/B): its start request, built in the same call, then — if it
    // declares an experiment mapping (analyze, or check_split) — its per-group rows fed into the test.
    if (r.pipeline_payload) {
      const out = await startAndBuild(engine, r.pipeline_payload);
      assert.equal(out.build.ok, true, `build failed for ${r.id}: ${JSON.stringify(out.error || out.build)}`);
      // A recipe that feeds a two-group test needs its groups; one that collapses the table to a
      // single row of statistics (the table-wide aggregate) is correct at exactly one row.
      const least = r.experiment ? 2 : 1;
      assert.ok(Array.isArray(out.rows) && out.rows.length >= least, `${r.id} expected >=${least} row(s), got ${out.rows?.length}`);
      if (r.experiment?.action === 'analyze') {
        const map = r.experiment;
        const arms = out.rows.map((row) => armFrom(map, row));
        const [control, ...variants] = arms;
        const res = engine._analyzeExperiment({ metric: map.metric, control, variants });
        assert.equal(res.ok, true, `experiment analyze failed for ${r.id}: ${JSON.stringify(res)}`);
        assert.equal(res.results.length, variants.length);
        for (const v of res.results) assert.ok(Number.isFinite(v.p_value) && v.p_value >= 0 && v.p_value <= 1, `bad p_value for ${r.id}`);
      }
      if (r.experiment?.action === 'check_split') {
        const map = r.experiment;
        const groups = out.rows.map((row) => armFrom(map, row));
        const res = engine._checkSplit({ groups, ...(map.expected_ratio ? { expected_ratio: map.expected_ratio } : {}) });
        assert.equal(res.ok, true, `experiment check_split failed for ${r.id}: ${JSON.stringify(res)}`);
        assert.ok(Number.isFinite(res.p_value) && res.p_value >= 0 && res.p_value <= 1, `bad p_value for ${r.id}`);
      }
      await engine._deletePipelineModel({ context_id: out.context_id });
      return;
    }

    // Semantic-model recipe: create + run its first example query.
    const out = await engine.build_semantic_model(r.semantic_payload);
    assert.equal(out.parse.ok, true, `parse failed for ${r.id}: ${JSON.stringify(out.parse.error || out.parse)}`);
    const example = (r.example_queries || [])[0];
    if (example) {
      const res = await engine.query_semantic_model({ context_id: out.context_id, ...example });
      assert.equal(res.ok, true, `query failed for ${r.id}: ${JSON.stringify(res.error || res)}`);
      assert.ok(Array.isArray(res.rows), `${r.id} returned no rows array`);
    }
  });
}

// A deployment's own file written for an earlier version carries a pipeline recipe as
// { name, pipeline: { source, stages } } — the one-call shape no tool takes. It is served as the start
// request it stands for, and that request builds: the shipped A/B conversion, as such a file would
// hold it, gives the per-variant numbers the fixture holds (control 6 of 6, variant_b 1 of 6).
test('a deployment recipe in the earlier { name, pipeline } shape is served as a start request that builds', opts, async (t) => {
  if (!HAS_DBT) return t.skip('dbt/mf not installed');
  const shipped = recipes.get('experiment_conversion').pipeline_payload;
  const file = join(mkdtempSync(join(tmpdir(), 'rp-old-')), 'mine.json');
  writeFileSync(file, JSON.stringify({ recipes: [{ id: 'my_conversion', task_type: 'experiment', title: 'mine', when_to_use: '', hack: '', pipeline_payload: { name: 'my_conversion', pipeline: { source: shipped.source, stages: shipped.stages } } }] }));
  const served = loadRecipes(join(process.cwd(), 'config', 'recipes.json'), file).get('my_conversion').pipeline_payload;
  const out = await startAndBuild(engine, served);
  assert.equal(out.build?.ok, true, JSON.stringify(out.error || out.build));
  const byGroup = Object.fromEntries(out.rows.map((row) => [String(row.variant_group), [Number(row.n), Number(row.conversions)]]));
  assert.deepEqual([byGroup.control, byGroup.variant_b], [[6, 6], [6, 1]]);
  await engine._deletePipelineModel({ context_id: out.context_id });
});
