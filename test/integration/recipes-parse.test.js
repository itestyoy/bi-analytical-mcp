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
  const catalog = loadCatalog(join(process.cwd(), 'config', 'catalog.yml'));
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: mkdtempSync(join(tmpdir(), 'rp-')), timeSpineDialect: 'postgres' });
  backend = new MfEngineBackend({ pythonBin: PY_BIN, dbtBin: DBT_BIN, profilesDir: BASE });
  engine = new Engine({ catalog, contextManager: ctxs, runner: backend });
}, opts);

after(async () => { backend?.close(); if (pg) await pg.stop(); });

for (const r of recipes.list) {
  test(`recipe '${r.id}' parses and its first example query runs`, opts, async (t) => {
    if (!HAS_DBT) return t.skip('dbt/mf not installed');
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
