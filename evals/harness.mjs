// THE EVAL'S WORLD — the fixture warehouse the integration tests use (DuckDB, seeded and built by dbt
// from test/integration/fixtures/dbt_project — test/integration/warehouse-harness.js), and over it the
// engine PRODUCTION builds (src/server.js makeEngine: catalog grounding, the python gate, the recipes
// the runtime can run, the project's own semantic layer), reached by an MCP client over an in-memory
// transport. A model under evaluation sees exactly the tool list, descriptions and instructions a
// host would.
//
// EACH CASE GETS A WORLD OF ITS OWN: a fresh engine with its own store and workspace, so nothing one
// case leaves (a context, a memory note, a logged error) is there for the next — results do not
// depend on the order or the selection of cases. What every case shares is only what production
// has before any question: the built warehouse, and the value index, built once (a sync of the
// background indexer) into a template store that each case's store starts as a copy of.

import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEngine } from '../src/server.js';
import { loadSettings } from '../src/settings.js';
import { BackgroundIndexer } from '../src/value-indexer.js';
import { buildWarehouse, connectMcp, fixtureProject } from '../test/integration/warehouse-harness.js';
import { settleMcp } from '../test/helpers/settle.js';
import { HAS_DBT } from '../test/helpers/dbt-env.js';

const CATALOG = join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml');

/** A production engine over the fixture project, with its store at `dbPath`. */
function engineOver(base, dbPath) {
  return makeEngine({
    // the process's settings, with the deployment's paths pointed at the fixture; nothing reset
    env: { ...process.env, DBT_PROFILES_DIR: base, MCP_DB_RESET: '' },
    catalogPath: CATALOG,
    baseProjectDir: base,
    workspaceRoot: mkdtempSync(join(tmpdir(), 'eval-ws-')),
    dbPath,
  });
}

/**
 * The built warehouse and the indexed template store — what every case starts from. `caseWorld()`
 * then gives one case its own engine and client; `close()` releases the warehouse.
 */
export async function startEval() {
  if (!HAS_DBT) throw new Error('the eval runs on the fixture warehouse: build the dbt environments first (npm run dbt:env -- create)');
  const base = fixtureProject('dbt_project');
  const wh = await buildWarehouse(base);
  const template = join(mkdtempSync(join(tmpdir(), 'eval-store-')), 'mcp.sqlite');
  const indexing = await engineOver(base, template);
  try {
    const S = loadSettings();
    // one sync of the indexer production starts in the background, with the same settings — the
    // models are already built, so it does not rebuild them first
    await new BackgroundIndexer({
      catalog: indexing.catalog, runner: indexing.runner, index: indexing.valueIndex, baseProjectDir: base,
      intervalMs: 0, maxValues: S.VALUE_INDEX_MAX_VALUES, approxDistinct: S.MCP_INDEX_APPROX_DISTINCT, batchSize: S.MCP_INDEX_BATCH,
      highCardPct: S.MCP_INDEX_HIGH_CARD_PCT, runModels: false, logger: () => {},
    }).refresh();
  } finally {
    indexing.close();
  }
  return {
    wh,
    /** One case's world: a production engine on a copy of the template store, and a client on it. */
    async caseWorld() {
      const dbPath = join(mkdtempSync(join(tmpdir(), 'eval-case-')), 'mcp.sqlite');
      copyFileSync(template, dbPath);
      const engine = await engineOver(base, dbPath);
      const conn = await connectMcp(engine, 'bi-analytical-eval');
      return { client: conn.client, async close() { await conn.close(); engine.close(); } };
    },
    async close() { await wh.stop(); },
  };
}

/** One tool call as the model makes it: { text, isError } of the first content block. */
export async function callTool(client, name, args) {
  const res = await client.callTool({ name, arguments: args });
  return { text: res.content?.[0]?.text ?? '', isError: !!res.isError };
}

/** A call followed to its task's end (bounded — test/helpers/settle.js); throws on a failure. */
async function settled(client, name, args) {
  const { res, out } = await settleMcp(client, name, args);
  if (res.isError) throw new Error(`${name}: ${res.content?.[0]?.text?.slice(0, 400)}`);
  return out;
}

/**
 * A case's reference path: its pipeline started, stepped and materialized through the tools, read as
 * a number (`column` of the one row) or a map (`key` → `value` of every row). A missing row or an
 * empty value is an error, never a zero: a path that reads nothing has not reached any answer.
 */
export async function runReference(client, ref) {
  const s = await settled(client, 'build_pipeline_model', { action: 'start', name: `ref_${Date.now().toString(36)}`, source: ref.source });
  for (const stage of ref.stages) await settled(client, 'build_pipeline_model', { action: 'add_step', draft_id: s.draft_id, stage });
  const built = await settled(client, 'build_pipeline_model', { action: 'materialize', draft_id: s.draft_id });
  const rows = built.rows || [];
  if (!rows.length) throw new Error('the reference pipeline returned no rows');
  if (ref.column) return numberOf(rows[0][ref.column], `reference ${ref.column}`);
  return Object.fromEntries(rows.map((r) => [String(r[ref.key]), numberOf(r[ref.value], `reference ${ref.value}`)]));
}

function numberOf(v, what) {
  if (v === null || v === undefined || v === '') throw new Error(`${what} is empty`);
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${what} is not a number: ${v}`);
  return n;
}

/**
 * What a query of the warehouse says for an answer spec — a number (column `v` of the one row), a
 * label (`v` of the first row) or a map (`k` → `v`). An empty result or a NULL is an error, never a
 * zero or the string 'undefined': a case whose SQL reads nothing is a broken case.
 */
export async function valueOf(wh, kind, sql) {
  const { rows } = await wh.query(sql);
  if (!rows.length) throw new Error('the query returned no rows');
  if (kind === 'map') return Object.fromEntries(rows.map((r) => [String(r.k), numberOf(r.v, `value of ${r.k}`)]));
  if (kind === 'label') {
    if (rows[0].v === null || rows[0].v === undefined) throw new Error('the label is empty');
    return String(rows[0].v);
  }
  return numberOf(rows[0].v, 'the value');
}

/** A case's truth, from the warehouse (null for a case with nothing to state). */
export const truthOf = (wh, answer) => (answer.kind === 'none' ? null : valueOf(wh, answer.kind, answer.sql));

/** What a reference path returned, read as the answer's kind (a label is the largest row's key). */
export function referenceAnswer(answer, got) {
  if (answer.kind === 'label') return Object.entries(got).sort((a, b) => b[1] - a[1])[0][0];
  return got;
}
