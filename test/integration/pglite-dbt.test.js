// End-to-end: declarative create -> dbt parse -> mf query, against dbt Core +
// PGlite (over a TCP socket). Skipped automatically if dbt/mf are not installed.

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

const execFileP = promisify(execFile);
const BASE = join(process.cwd(), 'test', 'integration', 'fixtures', 'dbt_project');
const DBT_BIN = process.env.DBT_BIN || join(process.cwd(), '.dbtvenv', 'bin', 'dbt');
const MF_BIN = process.env.MF_BIN || join(process.cwd(), '.dbtvenv', 'bin', 'mf');
const HAS_DBT = existsSync(DBT_BIN) && existsSync(MF_BIN);
const opts = { timeout: 300000 };

let pg;
let engine;

before(async () => {
  if (!HAS_DBT) return;
  pg = await startPglite();
  process.env.DBT_PG_PORT = String(pg.port);
  // materialize base tables + time spine in PGlite
  const env = { ...process.env, DBT_PROFILES_DIR: BASE, DBT_PROJECT_DIR: BASE, DBT_PG_PORT: String(pg.port) };
  // load CSV seeds, then build models + the metricflow time spine
  await execFileP(DBT_BIN, ['seed'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  await execFileP(DBT_BIN, ['run'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });

  const catalog = loadCatalog(join(process.cwd(), 'config', 'catalog.json'));
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: mkdtempSync(join(tmpdir(), 'mcpit-')) });
  const runner = new DbtRunner({ dbtBin: DBT_BIN, mfBin: MF_BIN, profilesDir: BASE });
  engine = new Engine({ catalog, contextManager: ctxs, runner });
}, opts);

after(async () => {
  if (pg) await pg.stop();
});

const DECL = {
  name: 'lvl_econ',
  use_base_models: ['users', 'campaigns'],
  semantic_models: [{
    from: 'events', event_scope: { event_name: ['purchase'] },
    dimensions: [{ source: 'event_property', property: 'product_id' }],
    measures: [
      { name: 'revenue', agg: 'sum', field: 'revenue' },
      { name: 'payers', agg: 'count_distinct', field: 'user_id' },
    ],
  }],
  metrics: [
    { name: 'revenue', type: 'simple', measure: { name: 'revenue' } },
    { name: 'payers', type: 'simple', measure: { name: 'payers' } },
    { name: 'arppu', type: 'ratio', numerator: { name: 'revenue' }, denominator: { name: 'payers' } },
  ],
};

test('create_semantic_model parses in an isolated context', opts, async (t) => {
  if (!HAS_DBT) return t.skip('dbt/mf not installed');
  const out = await engine.create_semantic_model(DECL);
  t.diagnostic(`context=${out.context_id} parse=${JSON.stringify(out.parse)}`);
  assert.equal(out.parse.ok, true, `parse failed: ${JSON.stringify(out.parse)}`);
  t.diagnostic(out.yaml);
  globalThis.__ctx = out.context_id;
});

test('query total revenue scoped to purchases (M3 scope baked in)', opts, async (t) => {
  if (!HAS_DBT) return t.skip('dbt/mf not installed');
  const ctx = globalThis.__ctx;
  const res = await engine.query_semantic_model({ context_id: ctx, metrics: ['lvl_econ_revenue'] });
  t.diagnostic(JSON.stringify(res));
  assert.equal(res.ok, true, JSON.stringify(res.error || res));
  // all purchases: total purchase revenue (documented) = 1699
  const total = res.rows.reduce((s, r) => s + Number(Object.values(r).at(-1)), 0);
  assert.equal(total, 1699);
});

test('query revenue grouped by metric_time + joined user dimension, filtered to paid', opts, async (t) => {
  if (!HAS_DBT) return t.skip('dbt/mf not installed');
  const ctx = globalThis.__ctx;
  const res = await engine.query_semantic_model({
    context_id: ctx,
    metrics: ['lvl_econ_revenue'],
    group_by: [{ time: 'metric_time', grain: 'day' }, 'user__country'],
    where: { op: 'and', conditions: [{ field: { kind: 'dimension', path: 'user__acquisition_type' }, op: 'eq', value: 'paid' }] },
    order_by: [{ key: 'metric_time__day', direction: 'asc' }],
  });
  t.diagnostic(JSON.stringify(res));
  assert.equal(res.ok, true, JSON.stringify(res.error || res));
  // paid users only: u1 (100+50, US, 2026-01-03) and u3 (200, GB, 2026-01-04) -> paid revenue total = 700
  const revs = res.rows.map((r) => Number(r.lvl_econ_revenue ?? Object.values(r).at(-1)));
  assert.equal(revs.reduce((a, b) => a + b, 0), 700);
  assert.ok(res.columns.some((c) => /country/.test(c.name)), 'expected a country column');
});

test('dry_run query returns compiled SQL (mf --explain)', opts, async (t) => {
  if (!HAS_DBT) return t.skip('dbt/mf not installed');
  const ctx = globalThis.__ctx;
  const res = await engine.query_semantic_model({ context_id: ctx, metrics: ['lvl_econ_arppu'], dry_run: true });
  assert.equal(res.ok, true, JSON.stringify(res.error || res));
  assert.match(res.sql.toLowerCase(), /select|with/);
});

test('programmatic MetricFlow sidecar yields identical result (no mf CLI)', opts, async (t) => {
  if (!HAS_DBT) return t.skip('dbt/mf not installed');
  const { MfEngineBackend } = await import('../../src/backends/mf-engine.js');
  const PY = join(process.cwd(), '.dbtvenv', 'bin', 'python');
  const backend = new MfEngineBackend({ pythonBin: PY, dbtBin: DBT_BIN, profilesDir: BASE });
  try {
    const dir = engine.ctxs.dir(globalThis.__ctx);
    const res = await backend.query(dir, { metrics: ['lvl_econ_revenue'] });
    t.diagnostic(JSON.stringify(res));
    assert.equal(res.ok, true, JSON.stringify(res.stderr || res));
    const total = res.rows.reduce((s, r) => s + Number(Object.values(r).at(-1)), 0);
    assert.equal(total, 1699);
    const explain = await backend.query(dir, { metrics: ['lvl_econ_revenue'], explain: true });
    assert.match((explain.sql || '').toLowerCase(), /select|with/);
  } finally {
    backend.close();
  }
});
