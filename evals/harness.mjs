// THE EVAL'S WORLD — the fixture warehouse the integration tests use (DuckDB, seeded and built by
// dbt from test/integration/fixtures/dbt_project), a real Engine over it, and an MCP client on the
// other end of an in-memory transport: a model under evaluation sees exactly the tool list, the
// descriptions and the instructions a host would. Plus each case's truth, read from the warehouse
// by its own SQL, and its reference path through the tools. The grading is evals/grade.mjs.

import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { loadCatalog } from '../src/catalog.js';
import { ContextManager } from '../src/context-manager.js';
import { Engine } from '../src/engine.js';
import { loadRecipes } from '../src/recipes.js';
import { assetPath } from '../src/runtime-assets.js';
import { makeMcpServer } from '../src/server.js';
import { startWarehouse, fixtureProject } from '../test/integration/warehouse-harness.js';
import { DBT_BIN, HAS_DBT, testDbt } from '../test/helpers/dbt-env.js';
import { isStartedTask } from '../test/helpers/settle.js';

const execFileP = promisify(execFile);

/** The warehouse, the engine and a connected MCP client; `close()` releases all three. */
export async function startWorld() {
  if (!HAS_DBT) throw new Error('the eval runs on the fixture warehouse: build the dbt environments first (npm run dbt:env -- create)');
  const base = fixtureProject('dbt_project');
  const wh = await startWarehouse();
  const env = { ...process.env, DBT_PROFILES_DIR: base, DBT_PROJECT_DIR: base, DUCKDB_PATH: wh.path };
  for (const cmd of [['seed', '--full-refresh'], ['run']]) {
    await execFileP(DBT_BIN, cmd, { cwd: base, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  }
  const catalog = loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), { profilesDir: base, projectDir: base });
  const runner = testDbt({ profilesDir: base });
  const engine = new Engine({
    catalog,
    runner,
    recipes: loadRecipes(assetPath('systemRecipes'), '', { dialect: catalog.dialect, python: false }),
    contextManager: new ContextManager({ baseProjectDir: base, workspaceRoot: mkdtempSync(join(tmpdir(), 'eval-')), timeSpineDialect: 'duckdb' }),
  });
  const server = makeMcpServer(engine);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'bi-analytical-eval', version: '0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return {
    wh,
    client,
    async close() {
      await client.close();
      await server.close();
      runner.close?.();
      await wh.stop();
    },
  };
}

/** One tool call as the model makes it: { text, isError } of the first content block. */
export async function callTool(client, name, args) {
  const res = await client.callTool({ name, arguments: args });
  return { text: res.content?.[0]?.text ?? '', isError: !!res.isError };
}

/** A call that starts a task, followed to its end through the reader it names. Throws on a failure. */
async function settled(client, name, args) {
  let { text, isError } = await callTool(client, name, args);
  let out = JSON.parse(text);
  if (!isError && isStartedTask(out)) {
    const { read_with: reader, task_id: taskId } = out;
    do {
      ({ text, isError } = await callTool(client, reader, { task_id: taskId }));
      out = JSON.parse(text);
    } while (!isError && out.status === 'running');
  }
  if (isError) throw new Error(`${name}: ${text.slice(0, 400)}`);
  return out;
}

/** A case's reference path: its pipeline started, stepped and materialized through the tools. */
export async function runReference(client, ref) {
  const s = await settled(client, 'build_pipeline_model', { action: 'start', name: `ref_${Date.now().toString(36)}`, source: ref.source });
  for (const stage of ref.stages) await settled(client, 'build_pipeline_model', { action: 'add_step', draft_id: s.draft_id, stage });
  const built = await settled(client, 'build_pipeline_model', { action: 'materialize', draft_id: s.draft_id });
  const rows = built.rows || [];
  if (ref.column) return Number(rows[0]?.[ref.column]);
  if (ref.value && rows.length) {
    const map = Object.fromEntries(rows.map((r) => [String(r[ref.key]), Number(r[ref.value])]));
    return map;
  }
  return null;
}

/** A case's truth, from the warehouse: a number, a label, or a map of key → number. */
export async function truthOf(wh, answer) {
  if (answer.kind === 'none') return null;
  const { rows } = await wh.query(answer.sql);
  if (answer.kind === 'map') return Object.fromEntries(rows.map((r) => [String(r.k), Number(r.v)]));
  if (answer.kind === 'label') return String(rows[0]?.v);
  return Number(rows[0]?.v);
}

/** What a reference path returned, read as the answer's kind (a label is the largest row's key). */
export function referenceAnswer(answer, got) {
  if (answer.kind === 'label') return Object.entries(got).sort((a, b) => b[1] - a[1])[0]?.[0];
  return got;
}
