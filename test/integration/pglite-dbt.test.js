// Focused smoke: declarative create -> dbt parse -> mf query against dbt Core +
// MetricFlow + PGlite. Builds a monetization model (iap_purchase_completed,
// sum price_in_usd, count_distinct player_id_of_internal) and asserts the EXACT totals
// documented in test/integration/fixtures/SEED_DATA.md. Data-only assertions:
// only res.ok / res.row_count and numeric values keyed out of res.rows.
// Auto-skips when dbt/mf are not installed (HAS_DBT gate).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadCatalog } from '../../src/catalog.js';
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

let pg;
let engine;
let backend;
let ctx; // monetization context id

const num = (v) => Number(v === '' || v == null ? NaN : v);
const sumCol = (rows, col) => rows.reduce((s, r) => s + (Number.isFinite(num(r[col])) ? num(r[col]) : 0), 0);
const mapCol = (rows, keyCol, valCol) => Object.fromEntries(rows.map((r) => [String(r[keyCol]), num(r[valCol])]));

before(async () => {
  if (!HAS_DBT) return;
  pg = await startPglite();
  process.env.DBT_PG_PORT = String(pg.port);
  // materialize seeds + models + the MetricFlow time spine into PGlite
  const env = { ...process.env, DBT_PROFILES_DIR: BASE, DBT_PROJECT_DIR: BASE, DBT_PG_PORT: String(pg.port) };
  await execFileP(DBT_BIN, ['seed'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  await execFileP(DBT_BIN, ['run'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });

  const catalog = loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), { profilesDir: BASE, projectDir: BASE });
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: mkdtempSync(join(tmpdir(), 'mcpit-')), timeSpineDialect: 'postgres' });
  backend = new MfEngineBackend({ pythonBin: PY_BIN, dbtBin: DBT_BIN, profilesDir: BASE });
  engine = new Engine({ catalog, contextManager: ctxs, runner: backend });

  // Monetization model: only two data sources (events fact + user attributes).
  const out = await engine.create_semantic_model({
    name: 'mon',
    use_base_models: ['users'],
    semantic_models: [{
      from: 'events', event_scope: { event_name: ['iap_purchase_completed'] },
      dimensions: [{ source: 'event_property', property: 'product_id_of_event_data' }],
      measures: [
        { name: 'revenue', agg: 'sum', field: 'price_in_usd_of_event_data' },
        { name: 'payers', agg: 'count_distinct', field: 'player_id_of_internal' },
        { name: 'purchases', agg: 'count', field: '*' },
      ],
    }],
    metrics: [
      { name: 'revenue', type: 'simple', measure: { name: 'revenue' } },
      { name: 'payers', type: 'simple', measure: { name: 'payers' } },
      { name: 'purchases', type: 'simple', measure: { name: 'purchases' } },
      { name: 'arppu', type: 'ratio', numerator: { name: 'revenue' }, denominator: { name: 'payers' } },
    ],
  });
  assert.equal(out.parse.ok, true, `parse failed: ${JSON.stringify(out.parse)}`);
  ctx = out.context_id;
}, opts);

after(async () => { backend?.close(); if (pg) await pg.stop(); });
const skip = (t) => { if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; } return false; };
const q = (input) => engine.query_semantic_model({ context_id: ctx, ...input });

// SEED_DATA: total IAP revenue = 85, distinct payers = 7, purchases = 8.
test('total IAP revenue = 85 USD', opts, async (t) => {
  if (skip(t)) return;
  const r = await q({ metrics: ['mon_revenue'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(sumCol(r.rows, 'mon_revenue'), 85);
});

test('payers = 7, purchases = 8, arppu = 85/7', opts, async (t) => {
  if (skip(t)) return;
  const r = await q({ metrics: ['mon_revenue', 'mon_payers', 'mon_purchases', 'mon_arppu'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const row = r.rows[0];
  assert.equal(num(row.mon_revenue), 85);
  assert.equal(num(row.mon_payers), 7);
  assert.equal(num(row.mon_purchases), 8);
  assert.ok(Math.abs(num(row.mon_arppu) - 85 / 7) < 1e-6, `arppu=${row.mon_arppu}`);
});

// SEED_DATA: revenue by country -> US=35, GB=25, BR=25, DE=0 (no rows).
test('revenue by user__country (1-hop join) = US 35 / GB 25 / BR 25', opts, async (t) => {
  if (skip(t)) return;
  const r = await q({ metrics: ['mon_revenue'], group_by: ['user__country'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const by = mapCol(r.rows, 'user__country', 'mon_revenue');
  assert.equal(by.US, 35);
  assert.equal(by.GB, 25);
  assert.equal(by.BR, 25);
  // DE has no completed purchases -> either absent or a null/0 revenue row
  assert.ok(!Number.isFinite(by.DE) || by.DE === 0, `DE revenue should be 0, got ${by.DE}`);
  // grouped revenue sums to the grand total
  assert.equal(sumCol(r.rows, 'mon_revenue'), 85);
});

// SEED_DATA: revenue by acquisition_type -> paid=55, organic=30.
test('revenue filtered by user__acquisition_type: paid 55 / organic 30', opts, async (t) => {
  if (skip(t)) return;
  const paid = await q({ metrics: ['mon_revenue'], where: { op: 'and', conditions: [{ field: { kind: 'dimension', path: 'user__acquisition_type' }, op: 'eq', value: 'paid' }] } });
  const org = await q({ metrics: ['mon_revenue'], where: { op: 'and', conditions: [{ field: { kind: 'dimension', path: 'user__acquisition_type' }, op: 'eq', value: 'organic' }] } });
  assert.equal(paid.ok, true, JSON.stringify(paid.error));
  assert.equal(org.ok, true, JSON.stringify(org.error));
  assert.equal(sumCol(paid.rows, 'mon_revenue'), 55);
  assert.equal(sumCol(org.rows, 'mon_revenue'), 30);
});

// SEED_DATA: revenue by product -> p1=15, p2=30, p3=40 (local event-property dim).
test('revenue by product_id = p1 15 / p2 30 / p3 40', opts, async (t) => {
  if (skip(t)) return;
  const r = await q({ metrics: ['mon_revenue'], group_by: ['mon_product_id_of_event_data'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const by = mapCol(r.rows, 'event__mon_product_id_of_event_data', 'mon_revenue');
  assert.equal(by.p1, 15);
  assert.equal(by.p2, 30);
  assert.equal(by.p3, 40);
  assert.equal(sumCol(r.rows, 'mon_revenue'), 85);
});
