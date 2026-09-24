// A metric query that outlasts its call is handed back as a query_id and runs on; get_query_result
// then returns the SAME rows the query would have returned inline. Proven on DATA against PGlite:
// the engine's grace is set to 1ms, so every real query detaches, and the numbers read back are
// SEED_DATA's (total IAP revenue 85; by country US 35 / GB 25 / BR 25).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { MfEngineBackend } from '../../src/backends/mf-engine.js';
import { Engine } from '../../src/engine.js';
import { startPglite } from './pglite-harness.js';
import { buildViewModel, drillView, DRILL_ROWS, pivotRows, pivotTransform, PIVOT_LEVEL_ROWS } from '../../src/apps/result-view-model.js';

const execFileP = promisify(execFile);
const BASE = join(process.cwd(), 'test', 'integration', 'fixtures', 'dbt_project');
const DBT_BIN = process.env.DBT_BIN || join(process.cwd(), '.dbtvenv', 'bin', 'dbt');
const MF_BIN = process.env.MF_BIN || join(process.cwd(), '.dbtvenv', 'bin', 'mf');
const PY_BIN = process.env.PYTHON_BIN || join(process.cwd(), '.dbtvenv', 'bin', 'python');
const HAS_DBT = existsSync(DBT_BIN) && existsSync(MF_BIN);
const opts = { timeout: 300000 };

let pg; let engine; let backend; let ctxId;

before(async () => {
  if (!HAS_DBT) return;
  pg = await startPglite();
  process.env.DBT_PG_PORT = String(pg.port);
  const env = { ...process.env, DBT_PROFILES_DIR: BASE, DBT_PROJECT_DIR: BASE, DBT_PG_PORT: String(pg.port) };
  await execFileP(DBT_BIN, ['seed'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  await execFileP(DBT_BIN, ['run'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: mkdtempSync(join(tmpdir(), 'detq-')), timeSpineDialect: 'postgres' });
  backend = new MfEngineBackend({ pythonBin: PY_BIN, dbtBin: DBT_BIN, profilesDir: BASE });
  engine = new Engine({ catalog: loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), { profilesDir: BASE, projectDir: BASE }), contextManager: ctxs, runner: backend, queryTimeoutMs: 1 });
  const out = await engine.create_semantic_model({
    name: 'mon', use_base_models: ['users'],
    semantic_models: [{ from: 'events', event_scope: { event_name: ['iap_purchase_completed'] }, measures: [{ name: 'revenue', agg: 'sum', field: 'price_in_usd_of_event_data' }] }],
    metrics: [{ name: 'revenue', type: 'simple', measure: { name: 'revenue' } }],
  });
  assert.equal(out.parse.ok, true, JSON.stringify(out.parse));
  ctxId = out.context_id;
}, opts);

after(async () => { backend?.close(); if (pg) await pg.stop(); });
const skip = (t) => { if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; } return false; };

async function follow(queryId) {
  for (let i = 0; i < 300; i++) {
    const r = await engine.get_query_result({ query_id: queryId });
    if (r.status !== 'running') return r;
    await sleep(200);
  }
  throw new Error(`query ${queryId} never finished`);
}

test('a metric query past its grace hands back a query_id; the rows arrive through get_query_result', opts, async (t) => {
  if (skip(t)) return;
  const first = await engine.query_semantic_model({ context_id: ctxId, metrics: ['mon_revenue'] });
  assert.equal(first.status, 'running', JSON.stringify(first));
  assert.match(first.query_id, /^[a-f0-9]{12}$/);
  const done = await follow(first.query_id);
  assert.equal(done.ok, true, JSON.stringify(done.error));
  assert.equal(done.status, 'ready');
  assert.equal(Number(done.rows[0].mon_revenue), 85);
});

test('a detached query keeps its grouping and the caller-facing column names', opts, async (t) => {
  if (skip(t)) return;
  const first = await engine.query_semantic_model({ context_id: ctxId, metrics: ['mon_revenue'], group_by: [{ model: 'users', attribute: 'country' }] });
  assert.equal(first.status, 'running');
  const done = await follow(first.query_id);
  const by = Object.fromEntries(done.rows.map((r) => [String(r.users_country), Number(r.mon_revenue)]));
  assert.equal(by.US, 35);
  assert.equal(by.GB, 25);
  assert.equal(by.BR, 25);
});

test('a detached query that FAILS reports the failure through get_query_result', opts, async (t) => {
  if (skip(t)) return;
  // a filter on a value the warehouse cannot compare (a string against a numeric attribute) fails in the warehouse
  const first = await engine.query_semantic_model({ context_id: ctxId, metrics: ['mon_revenue'], where: { op: 'and', conditions: [{ field: { kind: 'metric_time' }, op: 'eq', value: 'not-a-date' }] } });
  if (first.status !== 'running') { assert.equal(first.ok, false, 'refused before running is fine too'); return; }
  const done = await follow(first.query_id);
  assert.equal(done.ok, false);
  assert.equal(done.status, 'error');
});

// THE CARD DECLARATION (`display`): the caller says what the result is, the card draws exactly that.
// A query that detaches remembers it, so the rows read back through get_query_result come with it —
// and the card's numbers are the warehouse's.
test('a declared bar chart survives the detach and draws the warehouse\'s numbers in row order', opts, async (t) => {
  if (skip(t)) return;
  const display = { kind: 'bar', title: 'Revenue by country', x: 'users_country', y: ['mon_revenue'] };
  const first = await engine.query_semantic_model({ context_id: ctxId, metrics: ['mon_revenue'], group_by: [{ model: 'users', attribute: 'country' }], order_by: [{ key: 'mon_revenue', direction: 'asc' }], display });
  assert.equal(first.status, 'running');
  const done = await follow(first.query_id);
  assert.deepEqual(done.display, display);
  const m = buildViewModel('get_query_result', done);
  assert.equal(m.kind, 'chart');
  assert.equal(m.title, 'Revenue by country');
  // bars in the order the rows came back (ascending revenue; the country with none sorts last)
  assert.deepEqual(m.chart.bars.map((b) => b.label), done.rows.map((r) => String(r.users_country)));
  assert.deepEqual(m.chart.bars.map((b) => b.value), [25, 25, 35, 0]);
  assert.equal(m.chart.bars[2].label, 'US');
});

test('a funnel declared on a read of that result follows the declared steps, not the column names', opts, async (t) => {
  if (skip(t)) return;
  const paying = { op: 'and', conditions: [{ field: { kind: 'dimension', model: 'users', attribute: 'country' }, op: 'in', value: ['US', 'GB', 'BR'] }] };
  const first = await engine.query_semantic_model({ context_id: ctxId, metrics: ['mon_revenue'], group_by: [{ model: 'users', attribute: 'country' }], where: paying, order_by: [{ key: 'mon_revenue', direction: 'desc' }] });
  const done = await follow(first.query_id);
  assert.equal(done.display, undefined, 'no declaration, none attached');
  const read = await engine.get_query_result({ query_id: first.query_id, display: { kind: 'funnel', steps: { label_column: 'users_country', value_column: 'mon_revenue' } } });
  const m = buildViewModel('get_query_result', read);
  assert.equal(m.kind, 'funnel');
  assert.deepEqual(m.steps.map((x) => x.label), read.rows.map((r) => String(r.users_country)));
  assert.deepEqual(m.steps.map((x) => x.value), [35, 25, 25]);
  assert.equal(m.overall, 25 / 35);
});

test('a declaration naming a column the result does not have is refused, with the columns it has', opts, async (t) => {
  if (skip(t)) return;
  await assert.rejects(
    engine.query_semantic_model({ context_id: ctxId, metrics: ['mon_revenue'], display: { kind: 'line', x: 'metric_time_day', y: ['mon_revenue'] } }),
    (e) => e.field === 'display',
  );
  const first = await engine.query_semantic_model({ context_id: ctxId, metrics: ['mon_revenue'] });
  await follow(first.query_id);
  await assert.rejects(
    engine.get_query_result({ query_id: first.query_id, display: { kind: 'funnel', steps: [{ column: 'mon_revenue' }, { column: 'no_such_step' }] } }),
    (e) => e.field === 'display',
  );
});

test('a declared pie carries each country\'s share of the warehouse total; a pie of negative or single values is refused', opts, async (t) => {
  if (skip(t)) return;
  const paying = { op: 'and', conditions: [{ field: { kind: 'dimension', model: 'users', attribute: 'country' }, op: 'in', value: ['US', 'GB', 'BR'] }] };
  const first = await engine.query_semantic_model({ context_id: ctxId, metrics: ['mon_revenue'], group_by: [{ model: 'users', attribute: 'country' }], where: paying, display: { kind: 'pie', label_column: 'users_country', value_column: 'mon_revenue' } });
  const done = await follow(first.query_id);
  const m = buildViewModel('get_query_result', done);
  assert.equal(m.chart.type, 'pie');
  assert.equal(m.chart.total, 85);
  // the largest share first (US 35 of 85); GB and BR tie at 25 each
  assert.deepEqual([m.chart.slices[0].label, m.chart.slices[0].share], ['US', 35 / 85]);
  assert.deepEqual(m.chart.slices.slice(1).map((x) => x.label).sort(), ['BR', 'GB']);
  assert.deepEqual(m.chart.slices.slice(1).map((x) => x.share), [25 / 85, 25 / 85]);
  // one row is a number, not a pie
  const one = await engine.query_semantic_model({ context_id: ctxId, metrics: ['mon_revenue'] });
  await follow(one.query_id);
  await assert.rejects(engine.get_query_result({ query_id: one.query_id, display: { kind: 'pie', label_column: 'mon_revenue', value_column: 'mon_revenue' } }), (e) => e.field === 'display');
});

test('a KPI tile over the warehouse total shows its number; over many rows it needs an axis', opts, async (t) => {
  if (skip(t)) return;
  const first = await engine.query_semantic_model({ context_id: ctxId, metrics: ['mon_revenue'], display: { kind: 'kpi', title: 'Revenue', values: [{ column: 'mon_revenue', label: 'IAP revenue', format: 'currency' }] } });
  const done = await follow(first.query_id);
  const m = buildViewModel('get_query_result', done);
  assert.equal(m.kind, 'kpi');
  assert.deepEqual(m.tiles.map((x) => [x.label, x.value]), [['IAP revenue', 85]]);
  // a row per country and no axis: the rows come back, the tiles are not drawn, and the reply says why
  const many = await follow((await engine.query_semantic_model({ context_id: ctxId, metrics: ['mon_revenue'], group_by: [{ model: 'users', attribute: 'country' }], display: { kind: 'kpi', values: [{ column: 'mon_revenue' }] } })).query_id);
  assert.equal(many.display, undefined);
  assert.ok((many.warnings || []).some((w) => w.startsWith('display was not applied')), JSON.stringify(many.warnings));
  assert.equal(many.rows.reduce((a, r) => a + Number(r.mon_revenue ?? 0), 0), 85);
});

// A result that EXISTED and is no longer there says so structurally (error.code result_gone), and the
// card reads it as "no longer available" — not as the failure a broken query is.
test('a result that is gone — forgotten, expired or deleted — is result_gone, and the card says so instead of "Error"', opts, async (t) => {
  if (skip(t)) return;
  // held in memory, then forgotten (what a restart or the hour does)
  const first = await engine.query_semantic_model({ context_id: ctxId, metrics: ['mon_revenue'] });
  const done = await follow(first.query_id);
  assert.equal(Number(done.rows[0].mon_revenue), 85);
  engine._inlineResults.delete(first.query_id);
  const forgotten = await engine.get_query_result({ query_id: first.query_id });
  assert.deepEqual([forgotten.ok, forgotten.error.code], [false, 'result_gone']);
  assert.deepEqual(buildViewModel('get_query_result', forgotten), { kind: 'none', reason: 'gone' });
  // a query_id this server never issued
  await assert.rejects(engine.get_query_result({ query_id: 'ffffffffffff' }), (e) => e.code === 'result_gone');
  // a materialized result whose table definition was deleted
  const mat = await engine.query_semantic_model({ context_id: ctxId, metrics: ['mon_revenue'], materialize: true });
  const built = await follow(mat.query_id);
  assert.equal(Number(built.rows[0].mon_revenue), 85);
  engine.ctxs.removeGeneratedFile(ctxId, `${built.table}.sql`);
  const deleted = await engine.get_query_result({ query_id: mat.query_id });
  assert.deepEqual([deleted.ok, deleted.error.code], [false, 'result_gone']);
  // …while a query that FAILED stays an error
  assert.equal(buildViewModel('get_query_result', { ok: false, status: 'error', error: { stage: 'query', message: 'x' } }).reason, 'error');
});

// A DRILL-DOWN: the card gets the top level, and each row it opens reads the next level from the
// stored result, filtered to that row — the same read the card makes, run here against the warehouse.
test('a pivot shows the top level from the warehouse, and a row opens into its children, which add up to it', opts, async (t) => {
  if (skip(t)) return;
  const display = { kind: 'pivot', levels: [{ column: 'users_country', label: 'Country' }, { column: 'users_platform', label: 'Platform' }], values: [{ column: 'mon_revenue', agg: 'sum', label: 'Revenue' }] };
  // a drill-down reads a stored result: without materialize the schema refuses it
  await assert.rejects(engine.query_semantic_model({ context_id: ctxId, metrics: ['mon_revenue'], group_by: [{ model: 'users', attribute: 'country' }, { model: 'users', attribute: 'platform' }], display }), (e) => e.field !== undefined || /materialize/.test(e.message));
  const first = await engine.query_semantic_model({ context_id: ctxId, metrics: ['mon_revenue'], group_by: [{ model: 'users', attribute: 'country' }, { model: 'users', attribute: 'platform' }], materialize: true, display });
  const top = first.status === 'running' ? await follow(first.query_id) : first;
  assert.equal(top.ok, true, JSON.stringify(top.error));
  const m = buildViewModel('get_query_result', top);
  assert.equal(m.kind, 'pivot');
  assert.deepEqual(m.source, { query_id: first.query_id });
  assert.deepEqual(m.levels, [{ column: 'users_country', label: 'Country' }, { column: 'users_platform', label: 'Platform' }]);
  const byCountry = Object.fromEntries(m.rows.map((r) => [r.label, r.values[0]]));
  assert.deepEqual([byCountry.US, byCountry.GB, byCountry.BR], [35, 25, 25]);
  assert.equal(m.rows[0].label, 'US', 'the largest first');
  // open US: the card's own read
  const us = m.rows.find((r) => r.label === 'US');
  const level = await engine.get_query_result({ ...m.source, transform: pivotTransform(display, [us.key]), limit: PIVOT_LEVEL_ROWS });
  const children = pivotRows(level, display, 1);
  assert.ok(children.length >= 1);
  assert.equal(children.reduce((a, c) => a + (c.values[0] ?? 0), 0), 35, 'the children of US add up to US');
});

// A CHART DRILL-DOWN: the chart is drawn from the stored table folded over its drill levels, and a
// click steps into a mark — the same read the card makes, run here against the warehouse.
test('a drillable bar is drawn folded over its drill level, and a bar drills into its breakdown, which adds up to it', opts, async (t) => {
  if (skip(t)) return;
  const display = { kind: 'bar', x: 'users_country', y: ['mon_revenue'], drill: { levels: [{ column: 'users_platform', label: 'Platform' }] } };
  const groupBy = [{ model: 'users', attribute: 'country' }, { model: 'users', attribute: 'platform' }];
  await assert.rejects(engine.query_semantic_model({ context_id: ctxId, metrics: ['mon_revenue'], group_by: groupBy, display }), (e) => e.field !== undefined || /materialize/.test(e.message));
  const first = await engine.query_semantic_model({ context_id: ctxId, metrics: ['mon_revenue'], group_by: groupBy, materialize: true, display });
  const top = first.status === 'running' ? await follow(first.query_id) : first;
  const m = buildViewModel('get_query_result', top);
  assert.equal(m.chart.type, 'bar');
  // one bar per country, whatever the platforms under it: the fold of the stored rows
  const byCountry = Object.fromEntries(m.chart.bars.map((b) => [b.label, b.value]));
  assert.deepEqual([byCountry.US, byCountry.GB, byCountry.BR], [35, 25, 25]);
  assert.deepEqual(m.chart.drill.levels, [{ column: 'users_platform', label: 'Platform' }]);
  // click US → by Platform
  const i = m.chart.labels.indexOf('US');
  const path = [{ column: 'users_country', value: m.chart.drill.keys[i] }];
  const view = drillView(display, path, { level: { column: 'users_platform' }, mode: 'breakdown' });
  const got = await engine.get_query_result({ ...m.chart.drill.source, transform: view.transform, limit: DRILL_ROWS });
  const next = buildViewModel('get_query_result', { ...got, display: view.display, drill_source: m.chart.drill.source, drill_path: path });
  assert.equal(next.chart.x, 'users_platform');
  assert.equal(next.chart.bars.reduce((a, b) => a + b.value, 0), 35, 'US by platform adds up to US');
  assert.deepEqual(next.chart.drill.levels, [], 'no level left to step into');
  // a drill level the chart already draws is refused
  await assert.rejects(engine.get_query_result({ query_id: first.query_id, display: { ...display, drill: { levels: [{ column: 'users_country' }] } } }), (e) => e.field === 'display');
});

// ONE QUERY, ONE CARD: the model waits with time({ query_id }) — no card — and reads the result once.
test('time({ query_id }) wakes as soon as the query is done, then one read returns the warehouse\'s rows', opts, async (t) => {
  if (skip(t)) return;
  const first = await engine.query_semantic_model({ context_id: ctxId, metrics: ['mon_revenue'] });
  assert.equal(first.status, 'running');
  let waited;
  for (let i = 0; i < 20; i++) {
    waited = await engine.time({ seconds: 30, query_id: first.query_id });
    if (waited.query.status !== 'running') break;
  }
  assert.equal(waited.query.status, 'ready');
  assert.ok(waited.waited_seconds < 30, `woke early (${waited.waited_seconds}s)`);
  const read = await engine.get_query_result({ query_id: first.query_id });
  assert.equal(Number(read.rows[0].mon_revenue), 85);
  // a query this server does not know: gone, at once
  const gone = await engine.time({ seconds: 30, query_id: 'ffffffffffff' });
  assert.deepEqual([gone.query.status, gone.waited_seconds < 1], ['gone', true]);
});
