// A BATCH OF QUERIES — one call starts up to five queries on a context, they run side by side, and
// one read returns them all. Run with the production runner (the `mf` CLI and `dbt`, each member its
// own process), proven on DATA against PGlite: SEED_DATA's total IAP revenue 85, by country US 35 /
// GB 25 / BR 25; 184 event rows, 11 of them priced (8 completed purchases = 85, 3 failed = 35).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { DbtRunner } from '../../src/dbt-runner.js';
import { Engine } from '../../src/engine.js';
import { startPglite } from './pglite-harness.js';
import { settle } from '../helpers/settle.js';

const execFileP = promisify(execFile);
const BASE = join(process.cwd(), 'test', 'integration', 'fixtures', 'dbt_project');
const DBT_BIN = process.env.DBT_BIN || join(process.cwd(), '.dbtvenv', 'bin', 'dbt');
const MF_BIN = process.env.MF_BIN || join(process.cwd(), '.dbtvenv', 'bin', 'mf');
const HAS_DBT = existsSync(DBT_BIN) && existsSync(MF_BIN);
const opts = { timeout: 300000 };
const num = (v) => Number(v);

let pg; let engine;
const TASK = {
  name: 'mon', use_base_models: ['users'],
  semantic_models: [{ from: 'events', event_scope: { event_name: ['iap_purchase_completed'] }, measures: [{ name: 'revenue', agg: 'sum', field: 'price_in_usd_of_event_data' }] }],
  metrics: [{ name: 'revenue', type: 'simple', measure: { name: 'revenue' } }],
};
const byCountry = [{ model: 'users', attribute: 'country' }];
const revenueBy = (rows) => Object.fromEntries(rows.map((r) => [String(r.users_country), num(r.mon_revenue)]));

before(async () => {
  if (!HAS_DBT) return;
  pg = await startPglite();
  process.env.DBT_PG_PORT = String(pg.port);
  const env = { ...process.env, DBT_PROFILES_DIR: BASE, DBT_PROJECT_DIR: BASE, DBT_PG_PORT: String(pg.port) };
  await execFileP(DBT_BIN, ['seed'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  await execFileP(DBT_BIN, ['run'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: mkdtempSync(join(tmpdir(), 'batch-')), timeSpineDialect: 'postgres' });
  const runner = new DbtRunner({ dbtBin: DBT_BIN, mfBin: MF_BIN, profilesDir: BASE });
  engine = settle(new Engine({ catalog: loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), { profilesDir: BASE, projectDir: BASE }), contextManager: ctxs, runner }));
}, opts);

after(async () => { if (pg) await pg.stop(); });
const skip = (t) => { if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; } return false; };

/** Read a batch back until none of it is running. */
async function readAll(tool, taskIds) {
  const byId = new Map();
  let left = taskIds;
  while (left.length) {
    const r = await engine.raw[tool]({ task_ids: left });
    for (const x of r.results) if (x.status !== 'running') byId.set(x.task_id, x);
    left = r.results.filter((x) => x.status === 'running').map((x) => x.task_id);
  }
  return taskIds.map((id) => byId.get(id));
}

test('a batch started right after the declaration waits for its parse, runs every query, and one read returns the warehouse\'s numbers in order', opts, async (t) => {
  if (skip(t)) return;
  // the declaration is still being parsed when the batch is started
  const created = await engine.raw.build_semantic_model(TASK);
  const started = await engine.raw.query_semantic_model({
    context_id: created.context_id,
    queries: [
      { metrics: ['mon_revenue'] },
      { metrics: ['mon_revenue'], group_by: byCountry },
      { metrics: ['mon_revenue'], group_by: byCountry, materialize: true },
      { metrics: ['mon_revenue'], where: { op: 'and', conditions: [{ field: { kind: 'dimension', model: 'users', attribute: 'country' }, op: 'eq', value: 'US' }] } },
    ],
  });
  assert.deepEqual(Object.keys(started).sort(), ['context_id', 'next', 'read_with', 'task_ids']);
  assert.equal(started.task_ids.length, 4);
  const [total, grouped, stored, us] = await readAll('query_semantic_model', started.task_ids);
  for (const r of [total, grouped, stored, us]) assert.equal(r.status, 'done', JSON.stringify(r.error));
  assert.equal(num(total.rows[0].mon_revenue), 85);
  const g = revenueBy(grouped.rows);
  assert.deepEqual([g.US, g.GB, g.BR], [35, 25, 25]);
  // the materialized member left its table, which pages like any stored result
  assert.equal(stored.table, `qr_${stored.task_id}`);
  const s = revenueBy(stored.rows);
  assert.deepEqual([s.US, s.GB, s.BR], [35, 25, 25]);
  const page = await engine.query_semantic_model({ task_id: stored.task_id, limit: 2 });
  assert.equal(page.rows.length, 2);
  assert.equal(page.page.has_more, true);
  assert.equal(num(us.rows[0].mon_revenue), 35);
  // each member is a task of its own: it is drawn on its own, once
  const card = await engine.display_model_result({ task_id: grouped.task_id, display: { kind: 'bar', x: 'users_country', y: ['mon_revenue'] } });
  assert.deepEqual(card.rows.map((r) => num(r.mon_revenue)).sort((a, b) => a - b), [0, 25, 25, 35]);
});

test('a batch of projections over a built pipeline model: count, non-NULL count and sums read back together', opts, async (t) => {
  if (skip(t)) return;
  const s = await engine.build_pipeline_model({ action: 'start', name: 'priced', source: 'events' });
  await engine.build_pipeline_model({ action: 'add_step', draft_id: s.draft_id, stage: { stage: 'derive', name: 'price', op: 'extract', source: 'price_in_usd_of_event_data', type: 'numeric' } });
  const mat = await engine.build_pipeline_model({ action: 'materialize', draft_id: s.draft_id });
  assert.equal(mat.build?.ok, true, JSON.stringify(mat.error || mat.build));
  const started = await engine.raw.query_pipeline_model({
    context_id: s.draft_id,
    queries: [
      { transform: { aggregations: [{ fn: 'count', as: 'rows' }] } },
      { transform: { aggregations: [{ fn: 'count', column: 'price', as: 'priced' }] } },
      { transform: { where: [{ column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }], aggregations: [{ fn: 'sum', column: 'price', as: 'revenue' }] } },
      { transform: { where: [{ column: 'price', op: 'is_not_null' }], group_by: ['event_name'], aggregations: [{ fn: 'sum', column: 'price', as: 'amount' }], order_by: [{ key: 'event_name' }] } },
    ],
  });
  assert.equal(started.read_with, 'query_pipeline_model');
  const [rows, priced, revenue, byEvent] = await readAll('query_pipeline_model', started.task_ids);
  for (const r of [rows, priced, revenue, byEvent]) assert.equal(r.status, 'done', JSON.stringify(r.error));
  assert.equal(num(rows.rows[0].rows), 184);
  assert.equal(num(priced.rows[0].priced), 11);
  assert.equal(num(revenue.rows[0].revenue), 85);
  assert.deepEqual(byEvent.rows.map((r) => [r.event_name, num(r.amount)]), [['iap_purchase_completed', 85], ['iap_purchase_failed', 35]]);
});

test('a query issued after a batch runs once the whole batch is done, and reads the same data', opts, async (t) => {
  if (skip(t)) return;
  const created = await engine.build_semantic_model(TASK);
  const batch = await engine.raw.query_semantic_model({ context_id: created.context_id, queries: [{ metrics: ['mon_revenue'] }, { metrics: ['mon_revenue'], group_by: byCountry }] });
  const after = await engine.query_semantic_model({ context_id: created.context_id, metrics: ['mon_revenue'], group_by: byCountry });
  // by the time the later query is done, every member of the batch is too
  const peek = await engine.raw.query_semantic_model({ task_ids: batch.task_ids, wait_seconds: 0 });
  assert.equal(peek.status, 'done');
  assert.deepEqual(peek.results.map((r) => r.status), ['done', 'done']);
  assert.equal(num(peek.results[0].rows[0].mon_revenue), 85);
  const g = revenueBy(after.rows);
  assert.deepEqual([g.US, g.GB, g.BR], [35, 25, 25]);
  assert.deepEqual(revenueBy(peek.results[1].rows), g, 'the batch member grouped the same way reads the same numbers');
});
