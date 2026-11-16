// A DEPLOY THAT ADDS A COLUMN: the server checks its catalog against the warehouse once, at start
// (src/server.js makeEngine → groundCatalogToPhysical), and drops a declared column the table lacks. A
// column a new schema adds is in the table only once its model is rebuilt, so the start rebuilds the
// source models (MCP_INDEX_DBT_RUN) BEFORE it grounds the catalog — else the first start after the
// deploy would lose the column until the next restart.
//
// The warehouse is built from the fixture project; then the deploy is simulated — the events model's SQL
// gains a column and the catalog declares it — and the server is started the way production starts it.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { makeEngine } from '../../src/server.js';
import { buildWarehouse, fixtureProject } from './warehouse-harness.js';
import { settle, startAndBuild } from '../helpers/settle.js';
import { HAS_DBT, testDbt } from '../helpers/dbt-env.js';
import { tempDir } from '../helpers/temp-dir.js';

const BASE = fixtureProject('dbt_project');
const CATALOG = join(tempDir('grounding-catalog'), 'catalog.yml');
const opts = { timeout: 900000 };
const skip = (t) => { if (!HAS_DBT) { t.skip('dbt not installed'); return true; } return false; };
let wh = null;
const engines = [];

before(async () => {
  if (!HAS_DBT) return;
  wh = await buildWarehouse(BASE);
  // THE DEPLOY: the model gains a column — its table, built above, does not have it yet — and the
  // catalog declares it
  const model = join(BASE, 'models', 'fct_analytics_events.sql');
  const sql = readFileSync(model, 'utf8');
  assert.ok(sql.includes('    event_data,\n'));
  writeFileSync(model, sql.replace('    event_data,\n', '    lower(event_name) as event_kind,\n    event_data,\n'));
  const catalog = readFileSync(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), 'utf8');
  assert.ok(catalog.includes('      - name: bundle_id\n'));
  writeFileSync(CATALOG, catalog.replace('      - name: bundle_id\n', '      - name: event_kind\n        data_type: string\n        description: "The event\'s name, lower-cased."\n      - name: bundle_id\n'));
});

after(async () => {
  for (const e of engines) { try { e.close(); } catch { /* closed */ } }
  await wh?.close?.();
});

/** The server as production starts it, over the deployed project; `rebuild` is MCP_INDEX_DBT_RUN. */
async function start(rebuild) {
  const engine = await makeEngine({
    env: { ...process.env, DBT_PROFILES_DIR: BASE, MCP_INDEX_DBT_RUN: rebuild ? 'true' : 'false' },
    baseProjectDir: BASE, catalogPath: CATALOG, runner: testDbt({ profilesDir: BASE }),
    workspaceRoot: tempDir('grounding-ws'), dbPath: join(tempDir('grounding-db'), 'mcp.sqlite'),
  });
  engines.push(engine);
  return settle(engine);
}

const BY_KIND = { description: 'what the test computes', question: 'what the test asks', action: 'start', name: 'by_kind', source: 'events', time_range: { start: '2026-01-01', end: '2026-01-31' }, steps: [{ stage: 'aggregate', group_by: ['event_kind'], measures: [{ name: 'n', expr: { fn: 'count' } }] }] };

test('without the rebuild at start, the column the table does not have yet is dropped from the catalog', opts, async (t) => {
  if (skip(t)) return;
  const engine = await start(false);
  await assert.rejects(startAndBuild(engine, BY_KIND), /event_kind/);
});

test('with it, the first start after the deploy serves the new column — its counts the table\'s', opts, async (t) => {
  if (skip(t)) return;
  const engine = await start(true);
  const build = await startAndBuild(engine, BY_KIND);
  assert.equal(build.status, 'done', JSON.stringify(build));
  const truth = await testDbt({ profilesDir: BASE }).show(BASE, "select lower(event_name) as event_kind, count(*) as n from {{ ref('fct_analytics_events') }} where device_time >= timestamp '2026-01-01' and device_time < timestamp '2026-02-01' group by 1", 1000);
  assert.equal(truth.ok, true, JSON.stringify(truth));
  const counts = (rows) => Object.fromEntries(rows.map((r) => [r.event_kind, Number(r.n)]));
  assert.ok(truth.rows.length > 1, 'several kinds of event');
  assert.deepEqual(counts(build.rows), counts(truth.rows));
});
