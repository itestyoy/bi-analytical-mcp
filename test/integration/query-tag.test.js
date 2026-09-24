// THE QUERY TAG ON EVERY PATH — a warehouse query caused by a call carries `/* {"app":…,"client":…,
// "tool":…,"task":…} */` (src/dbt/query-tag.js): the dbt 1.x and `mf` CLIs through
// python/query_tag.py, dbt v2's inline show in the SQL itself. Proven on DATA: the same numbers come
// back tagged as untagged — SEED_DATA's total IAP revenue 85 — on each path.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { createDbt } from '../../src/dbt/index.js';
import { Engine } from '../../src/engine.js';
import { withTag } from '../../src/request-context.js';
import { startWarehouse, fixtureProject } from './warehouse-harness.js';
import { settle } from '../helpers/settle.js';
import { DBT_BIN, HAS_DBT, dbtEnv } from '../helpers/dbt-env.js';

const execFileP = promisify(execFile);
const BASE = fixtureProject('dbt_project');
const opts = { timeout: 300000 };
const TAG = { client: 'probe-client/1.0', ua: 'probe-agent */ not a comment end', tool: 'query_semantic_model' };
const TASK = {
  name: 'tagged',
  semantic_models: [{ from: 'events', event_scope: { event_name: ['iap_purchase_completed'] }, measures: [{ name: 'revenue', agg: 'sum', field: 'price_in_usd_of_event_data' }] }],
  metrics: [{ name: 'revenue', type: 'simple', measure: { name: 'revenue' } }],
};
const V1 = dbtEnv('dbt-v1');

let wh; let engine;
before(async () => {
  if (!HAS_DBT) return;
  wh = await startWarehouse();
  const env = { ...process.env, DBT_PROFILES_DIR: BASE, DBT_PROJECT_DIR: BASE, DUCKDB_PATH: wh.path };
  await execFileP(DBT_BIN, ['seed'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  await execFileP(DBT_BIN, ['run'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: mkdtempSync(join(tmpdir(), 'qtag-')), timeSpineDialect: 'duckdb' });
  engine = settle(new Engine({ catalog: loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), { profilesDir: BASE, projectDir: BASE }), contextManager: ctxs, runner: createDbt({ environment: process.env.DBT_ENV || 'dbt-v2', profilesDir: BASE }) }));
}, opts);
after(async () => { if (wh) await wh.stop(); });
const skip = (t) => { if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; } return false; };

async function revenue() {
  const c = await engine.raw.build_semantic_model(TASK);
  const q = await engine.raw.query_semantic_model({ context_id: c.context_id, metrics: ['tagged_revenue'] });
  let r;
  do { r = await engine.raw.query_semantic_model({ task_id: q.task_id }); } while (r.status === 'running');
  assert.equal(r.status, 'done', JSON.stringify(r.error));
  return Number(r.rows[0].tagged_revenue);
}

test('a metric query caused by a tagged call (dbt parse + the mf CLI) returns the same numbers', opts, async (t) => {
  if (skip(t)) return;
  assert.equal(await revenue(), 85);
  assert.equal(await withTag(TAG, revenue), 85);
});

test('dbt show under a tag returns the same rows — dbt v2 (the tag in the SQL) and dbt 1.x (the adapter hook)', opts, async (t) => {
  if (skip(t)) return;
  const sql = "select sum(price_in_usd_of_event_data) as revenue from {{ ref('fct_analytics_events') }} where event_name = 'iap_purchase_completed'";
  process.env.DUCKDB_PATH = wh.path;
  const clients = [createDbt({ environment: 'dbt-v2', profilesDir: BASE }), ...(V1 ? [createDbt({ environment: 'dbt-v1', profilesDir: BASE })] : [])];
  for (const client of clients) {
    const plain = await client.show(BASE, sql);
    const tagged = await withTag(TAG, () => client.show(BASE, sql));
    assert.ok(plain.ok && tagged.ok, `${client.major}: ${tagged.error || plain.error}`);
    assert.equal(Number(tagged.rows[0].revenue), 85, `dbt ${client.major}.x`);
    assert.deepEqual(tagged.rows, plain.rows);
  }
});
