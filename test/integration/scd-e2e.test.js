// END-TO-END on the REAL stack (dbt + MetricFlow + DuckDB) for the SLOWLY-CHANGING (SCD-2)
// dimension cycle — the governed point-in-time join, the pipeline join.between, and the
// "incomplete join" nudge. The fixture is built so POINT-IN-TIME and a naive key-only join give
// DIFFERENT numbers, so the tests actually prove correctness (not just "it ran").
//
// Fixture (seeds): u1 is US in [Jan 1..14] then GB from Jan 15; u2=DE, u3=US (single version).
// Purchases: u1 $10 on Jan 5 (US era), u1 $20 on Jan 20 (GB era), u2 $30, u3 $40.
//   Point-in-time revenue by country: US = 10 + 40 = 50, GB = 20, DE = 30  → total 100.
//   Naive key-only join fans u1's 2 purchases across BOTH versions → total inflates to 130.
// DATA-ONLY assertions (per project rules): every check is on a returned number.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { startWarehouse, fixtureProject } from './warehouse-harness.js';
import { settle } from '../helpers/settle.js';
import { DBT_BIN, HAS_DBT, testDbt } from '../helpers/dbt-env.js';
import { tempDir } from '../helpers/temp-dir.js';

const execFileP = promisify(execFile);
const BASE = fixtureProject('scd_project'); // a private copy: the test files run side by side
const CATALOG = join(process.cwd(), 'test', 'integration', 'fixtures', 'scd_catalog.yml');
const opts = { timeout: 300000 };
const num = (v) => Number(v);
const byKey = (rows, k, v) => rows.map((r) => [String(r[k]), num(r[v])]);
const mapOf = (rows, k, v) => Object.fromEntries(byKey(rows, k, v));
/** The sum of `v` per value of ONE group column `k` of a result grouped by several (rows with no value add nothing). */
const marginalOf = (rows, k, v) => {
  const out = {};
  for (const [key, n] of byKey(rows, k, v)) out[key] = (out[key] ?? 0) + (Number.isFinite(n) ? n : 0);
  return out;
};

let wh; let engine; let backend;

before(async () => {
  if (!HAS_DBT) return;
  wh = await startWarehouse();
  const env = { ...process.env, DBT_PROFILES_DIR: BASE, DBT_PROJECT_DIR: BASE, DUCKDB_PATH: wh.path };
  await execFileP(DBT_BIN, ['seed'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  await execFileP(DBT_BIN, ['run'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: tempDir('scd'), timeSpineDialect: 'duckdb' });
  backend = testDbt({ profilesDir: BASE });
  engine = settle(new Engine({ catalog: loadCatalog(CATALOG, { profilesDir: BASE, projectDir: BASE }), contextManager: ctxs, runner: backend }));
}, opts);

after(async () => { backend?.close?.(); if (wh) await wh.stop(); });
const skip = (t) => { if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; } return false; };

// 1) GOVERNED SCD point-in-time join: revenue by (versioned) country attributes each purchase to
//    the user version valid AT the event time. Proves no fan-out (total 100, not 130).
// 2) The governed SCD path relies on an auto-generated + auto-materialized time spine — scd_project
//    has no metricflow_time_spine model of its own, so this is the one data proof of it — exercised
//    via a metric_time series (would error "no time spine" if the spine were missing/unbuilt).
// One task serves both (the series was a task of its own), and ONE query reads every number: revenue
// is a sum, so the total, the country split and the month buckets are all its marginals — and a
// fan-out of the point-in-time join would inflate each of them.
test('governed SCD join on a project with no time spine of its own: point-in-time revenue by country (50 / 20 / 30, total 100) and a metric_time month series (100)', opts, async (t) => {
  if (skip(t)) return;
  const created = await engine.build_semantic_model({
    name: 'scd_rev',
    semantic_models: [{ source: 'events', measures: [{ name: 'revenue', expr: { fn: 'sum', args: [{ property: 'price_in_usd_of_event_data' }] } }], where: [{ fn: 'eq', args: [{ column: 'event_name' }, { value: 'iap_purchase_completed' }] }] }, { source: 'users', dimensions: [{ column: 'country' }] }],
    metrics: [{ name: 'revenue', type: 'simple', measure: 'revenue' }],
  });
  assert.equal(created.parse.ok, true, JSON.stringify(created.parse));
  const ctx = created.context_id;

  // 'governed SCD join: revenue by users.country is point-in-time (US 50 / GB 20 / DE 30, total 100)'
  // 'governed SCD join: metric_time series works (time spine auto-built), Jan month = 100'
  const seg = await engine.query_model({ context_id: ctx, steps: [{ stage: 'metrics', metrics: ['scd_rev_revenue'], group_by: [{ source: 'users', column: 'country' }, { time: 'metric_time', grain: 'month' }] }] });
  assert.equal(seg.status, 'done', JSON.stringify(seg));
  const total = seg.rows.reduce((s, x) => s + (Number.isFinite(num(x.scd_rev_revenue)) ? num(x.scd_rev_revenue) : 0), 0);
  assert.equal(total, 100, '[point-in-time] total revenue = 100 (a fan-out join would give 130)');
  const by = marginalOf(seg.rows, 'users_country', 'scd_rev_revenue');
  assert.equal(by.US, 50, `[point-in-time] US = u1's pre-move $10 + u3 $40 = 50 (got ${JSON.stringify(by)})`);
  assert.equal(by.GB, 20, "[point-in-time] GB = u1's post-move $20");
  assert.equal(by.DE, 30, '[point-in-time] DE = u2 $30');
  assert.equal(Object.values(by).reduce((a, b) => a + b, 0), 100, '[point-in-time] segments sum to the point-in-time total');
  const months = marginalOf(seg.rows, 'metric_time_month', 'scd_rev_revenue');
  assert.equal(Object.values(months).reduce((a, b) => a + b, 0), 100, '[time spine] all revenue lands in the month buckets, summing to 100');
});

// 3) A measure declared on the SCD users model is illegal in MetricFlow (measures + validity_params).
//    The renderer must drop it (with a warning) and keep the manifest valid & queryable.
test('governed SCD join: a measure on the SCD users model is dropped with a warning; the task still parses & queries', opts, async (t) => {
  if (skip(t)) return;
  const created = await engine.build_semantic_model({
    name: 'scd_drop',
    semantic_models: [{ source: 'events', measures: [{ name: 'revenue', expr: { fn: 'sum', args: [{ property: 'price_in_usd_of_event_data' }] } }], where: [{ fn: 'eq', args: [{ column: 'event_name' }, { value: 'iap_purchase_completed' }] }] }, { source: 'users', measures: [{ name: 'player_count', expr: { fn: 'count_distinct', args: [{ column: 'internal_player_id' }] } }] }],
    metrics: [
      { name: 'revenue', type: 'simple', measure: 'revenue' },
      { name: 'players', type: 'simple', measure: 'player_count' },
      // built on the dropped measure through the metric over it
      { name: 'revenue_per_player', type: 'derived', expr: { fn: 'div', args: [{ metric: 'revenue' }, { metric: 'players' }] } },
    ],
  });
  assert.equal(created.parse.ok, true, `parse must still succeed after dropping the SCD measure: ${JSON.stringify(created.parse)}`);
  assert.ok((created.warnings || []).some((w) => /slowly-changing/i.test(w) && /player_count/.test(w)), `expected a drop warning naming player_count, got ${JSON.stringify(created.warnings)}`);
  assert.ok(!created.metrics.includes('scd_drop_players'), 'the metric depending on the dropped measure is gone');
  assert.ok(!created.metrics.includes('scd_drop_revenue_per_player'), 'a derived metric over it goes with it');
  assert.ok(created.metrics.includes('scd_drop_revenue'), 'the events metric survives');
  // a dropped metric is refused when it is asked for, before any task starts — not by MetricFlow later
  await assert.rejects(engine.query_model({ context_id: created.context_id, steps: [{ stage: 'metrics', metrics: ['scd_drop_players'] }] }), /not in its semantic layer/);
  // and the surviving metric still queries to the point-in-time total
  const r = await engine.query_model({ context_id: created.context_id, steps: [{ stage: 'metrics', metrics: ['scd_drop_revenue'] }] });
  assert.equal(r.status, 'done', JSON.stringify(r));
  assert.equal(num(r.rows[0].scd_drop_revenue), 100);
});

// 4) PIPELINE point-in-time join via the users contract's time: same point-in-time numbers as governed.
test('pipeline join on the users contract: point-in-time revenue by country = US 50 / GB 20 / DE 30', opts, async (t) => {
  if (skip(t)) return;
  const s = await engine.build_pipeline_model({ action: 'start', name: 'scd_pipe', source: 'events' });
  const r = await engine.build_pipeline_model({
    action: 'add_steps', context_id: s.context_id, steps: [
      { stage: 'where', conditions: [{ fn: 'eq', args: [{ column: 'event_name' }, { value: 'iap_purchase_completed' }] }] },
      { stage: 'compute', name: 'price', expr: { property: 'price_in_usd_of_event_data' } },
      { stage: 'join', source: 'users', on: { user: 'internal_player_id', time: 'device_time' }, attrs: [{ column: 'country' }] },
      { stage: 'aggregate', group_by: ['country'], measures: [{ name: 'revenue', expr: { fn: 'sum', args: [{ column: 'price' }] } }, { name: 'n', expr: { fn: 'count' } }] },
    ],
  });
  assert.equal(r.action, 'add_steps');
  const mat = await engine.build_pipeline_model({ action: 'materialize', context_id: s.context_id });
  assert.equal(mat.build?.ok, true, JSON.stringify(mat.error || mat.build));
  // the build's rows are its table's (a country each, well under a page)
  const by = mapOf(mat.rows, 'country', 'revenue');
  assert.equal(by.US, 50, `US = 50 point-in-time (got ${JSON.stringify(by)})`);
  assert.equal(by.GB, 20);
  assert.equal(by.DE, 30);
  assert.equal(mat.rows.reduce((a, x) => a + num(x.n), 0), 4, 'exactly the 4 purchases — no fan-out');
});

// 5) The key alone — u1's purchases meeting both of its versions — would inflate the total to 130 over
//    6 rows (a hand-written join shows it); the contract requires the moment, so a join that names none
//    is refused at the step, the part named, instead of building that.
test('the key alone would inflate to 130 / 6 rows; a join without its time is refused', opts, async (t) => {
  if (skip(t)) return;
  const { rows } = await wh.query(`SELECT sum(e.price_in_usd_of_event_data) AS revenue, count(*) AS n FROM main.fct_events e JOIN main.dim_users u ON e.internal_player_id = u.internal_player_id WHERE e.event_name = 'iap_purchase_completed'`);
  assert.deepEqual([num(rows[0].revenue), num(rows[0].n)], [130, 6], 'u1 (2 purchases) × 2 versions + u2 + u3');
  const s = await engine.build_pipeline_model({ action: 'start', name: 'scd_notime', source: 'events' });
  await assert.rejects(
    () => engine.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, steps: [{ stage: 'join', source: 'users', on: { user: 'internal_player_id' }, attrs: [{ column: 'country' }] }] }),
    /missing required property 'time'/,
  );
});
