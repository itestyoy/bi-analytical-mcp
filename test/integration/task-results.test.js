// START, READ, SHOW — three calls. A metric query is a task: the call returns its task_id at once,
// get_task_result waits for it and returns the rows, and display_result draws them as a card — once
// per task. Proven on DATA against PGlite: the numbers read back and drawn are SEED_DATA's (total
// IAP revenue 85; by country US 35 / GB 25 / BR 25).

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
import { buildViewModel, drillView, DRILL_ROWS, pivotRows, pivotTransform, PIVOT_LEVEL_ROWS } from '../../src/apps/result-view-model.js';
import { settle, isStartedTask } from '../helpers/settle.js';

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
  engine = settle(new Engine({ catalog: loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), { profilesDir: BASE, projectDir: BASE }), contextManager: ctxs, runner: backend }));
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

const q = (input) => engine.query_semantic_model({ context_id: ctxId, metrics: ['mon_revenue'], ...input });
const byCountry = [{ model: 'users', attribute: 'country' }];
const paying = { op: 'and', conditions: [{ field: { kind: 'dimension', model: 'users', attribute: 'country' }, op: 'in', value: ['US', 'GB', 'BR'] }] };

test('a metric query answers with its task at once; get_task_result waits for it and returns the warehouse\'s rows', opts, async (t) => {
  if (skip(t)) return;
  const started = await engine.raw.query_semantic_model({ context_id: ctxId, metrics: ['mon_revenue'] });
  assert.ok(isStartedTask(started), JSON.stringify(started));
  assert.match(started.task_id, /^[a-f0-9]{12}$/);
  const done = await engine.get_task_result({ task_id: started.task_id });
  assert.equal(done.status, 'done', 'one wait is enough for a query this size');
  assert.ok(done.waited_seconds === undefined, 'a finished task answers with its result, not a wait report');
  assert.equal(done.tool, 'query_semantic_model');
  assert.equal(Number(done.rows[0].mon_revenue), 85);
  assert.equal(done.show_to_user?.tool, 'display_result', 'and says how to show it');
});

test('a query task keeps its grouping and the caller-facing column names', opts, async (t) => {
  if (skip(t)) return;
  const done = await q({ group_by: byCountry });
  const by = Object.fromEntries(done.rows.map((r) => [String(r.users_country), Number(r.mon_revenue)]));
  assert.deepEqual([by.US, by.GB, by.BR], [35, 25, 25]);
});

test('a query that FAILS in the warehouse is a task that ended in error', opts, async (t) => {
  if (skip(t)) return;
  // a filter on a value the warehouse cannot compare fails in the warehouse
  const done = await q({ where: { op: 'and', conditions: [{ field: { kind: 'metric_time' }, op: 'eq', value: 'not-a-date' }] } }).catch((e) => ({ refused: e }));
  if (done.refused) return; // refused before running is fine too
  assert.equal(done.ok, false);
  assert.equal(done.status, 'error');
});

// THE CARD DECLARATION (`display`) lives on display_result: the caller says what the result is, the
// card draws exactly that — and the card's numbers are the warehouse's.
test('a declared bar chart draws the warehouse\'s numbers in row order', opts, async (t) => {
  if (skip(t)) return;
  const display = { kind: 'bar', title: 'Revenue by country', x: 'users_country', y: ['mon_revenue'] };
  const done = await q({ group_by: byCountry, order_by: [{ key: 'mon_revenue', direction: 'asc' }] });
  const card = await engine.display_result({ task_id: done.task_id, display });
  assert.equal(card.drawn, true);
  assert.deepEqual(card.display, display);
  const m = buildViewModel('display_result', card);
  assert.equal(m.kind, 'chart');
  assert.equal(m.title, 'Revenue by country');
  // bars in the order the rows came back (ascending revenue; the country with none sorts last)
  assert.deepEqual(m.chart.bars.map((b) => b.label), done.rows.map((r) => String(r.users_country)));
  assert.deepEqual(m.chart.bars.map((b) => b.value), [25, 25, 35, 0]);
  assert.equal(m.chart.bars[2].label, 'US');
});

test('a declared funnel follows the declared steps, not the column names', opts, async (t) => {
  if (skip(t)) return;
  const done = await q({ group_by: byCountry, where: paying, order_by: [{ key: 'mon_revenue', direction: 'desc' }] });
  const card = await engine.display_result({ task_id: done.task_id, display: { kind: 'funnel', steps: { label_column: 'users_country', value_column: 'mon_revenue' } } });
  const m = buildViewModel('display_result', card);
  assert.equal(m.kind, 'funnel');
  assert.deepEqual(m.steps.map((x) => x.label), card.rows.map((r) => String(r.users_country)));
  assert.deepEqual(m.steps.map((x) => x.value), [35, 25, 25]);
  assert.equal(m.overall, 25 / 35);
});

test('a declaration naming a column the result does not have is refused, with the columns it has — and nothing is drawn', opts, async (t) => {
  if (skip(t)) return;
  const done = await q({});
  await assert.rejects(
    engine.display_result({ task_id: done.task_id, display: { kind: 'funnel', steps: [{ column: 'mon_revenue' }, { column: 'no_such_step' }] } }),
    (e) => e.field === 'display' && /mon_revenue/.test(e.message),
  );
  // refused is not drawn: the task can still be shown, once
  const card = await engine.display_result({ task_id: done.task_id, display: { kind: 'kpi', values: [{ column: 'mon_revenue' }] } });
  assert.equal(card.drawn, true);
});

test('a declared pie carries each country\'s share of the warehouse total; a pie of a single value is refused', opts, async (t) => {
  if (skip(t)) return;
  const done = await q({ group_by: byCountry, where: paying });
  const m = buildViewModel('display_result', await engine.display_result({ task_id: done.task_id, display: { kind: 'pie', label_column: 'users_country', value_column: 'mon_revenue' } }));
  assert.equal(m.chart.type, 'pie');
  assert.equal(m.chart.total, 85);
  // the largest share first (US 35 of 85); GB and BR tie at 25 each
  assert.deepEqual([m.chart.slices[0].label, m.chart.slices[0].share], ['US', 35 / 85]);
  assert.deepEqual(m.chart.slices.slice(1).map((x) => x.label).sort(), ['BR', 'GB']);
  assert.deepEqual(m.chart.slices.slice(1).map((x) => x.share), [25 / 85, 25 / 85]);
  // one row is a number, not a pie
  const one = await q({});
  await assert.rejects(engine.display_result({ task_id: one.task_id, display: { kind: 'pie', label_column: 'mon_revenue', value_column: 'mon_revenue' } }), (e) => e.field === 'display');
});

test('a KPI tile over the warehouse total shows its number; over many rows it needs an axis', opts, async (t) => {
  if (skip(t)) return;
  const done = await q({});
  const m = buildViewModel('display_result', await engine.display_result({ task_id: done.task_id, display: { kind: 'kpi', title: 'Revenue', values: [{ column: 'mon_revenue', label: 'IAP revenue', format: 'currency' }] } }));
  assert.equal(m.kind, 'kpi');
  assert.deepEqual(m.tiles.map((x) => [x.label, x.value]), [['IAP revenue', 85]]);
  // a row per country and no axis: refused, and the reply says why
  const many = await q({ group_by: byCountry });
  await assert.rejects(engine.display_result({ task_id: many.task_id, display: { kind: 'kpi', values: [{ column: 'mon_revenue' }] } }), (e) => e.field === 'display' && /ONE row/.test(e.message));
  assert.equal(many.rows.reduce((a, r) => a + Number(r.mon_revenue ?? 0), 0), 85);
});

// ONE RESULT, ONE CARD — by construction: display_result draws a task once, and nothing else draws.
test('a task is drawn once: a second display_result is refused, and reading it again draws nothing', opts, async (t) => {
  if (skip(t)) return;
  const done = await q({ group_by: byCountry });
  const display = { kind: 'bar', x: 'users_country', y: ['mon_revenue'] };
  assert.equal((await engine.display_result({ task_id: done.task_id, display })).drawn, true);
  await assert.rejects(engine.display_result({ task_id: done.task_id, display }), /shown already/);
  const again = await engine.get_task_result({ task_id: done.task_id });
  assert.equal(again.drawn, undefined, 'a read is never a card');
  assert.equal(again.show_to_user, undefined, 'and no longer suggests showing it');
  assert.equal(again.rows.reduce((a, r) => a + Number(r.mon_revenue ?? 0), 0), 85);
});

// A result that EXISTED and is no longer there says so structurally (error.code result_gone), and a
// card of it would read "no longer available" — not the failure a broken query is.
test('a result that is gone — forgotten, expired or deleted — is result_gone, not "Error"', opts, async (t) => {
  if (skip(t)) return;
  // held in memory, then forgotten (what a restart or the hour does)
  const done = await q({});
  assert.equal(Number(done.rows[0].mon_revenue), 85);
  engine.raw._taskResults.delete(done.task_id);
  const forgotten = await engine.get_task_result({ task_id: done.task_id });
  assert.deepEqual([forgotten.ok, forgotten.error.code], [false, 'result_gone']);
  assert.deepEqual(buildViewModel('display_result', forgotten), { kind: 'none', reason: 'gone' });
  // a task this server never ran
  await assert.rejects(engine.get_task_result({ task_id: 'ffffffffffff' }), (e) => e.code === 'result_gone');
  // a materialized result whose table definition was deleted
  const built = await q({ materialize: true });
  assert.equal(Number(built.rows[0].mon_revenue), 85);
  engine.ctxs.removeGeneratedFile(ctxId, `${built.table}.sql`);
  const deleted = await engine.get_task_result({ task_id: built.task_id, limit: 10 });
  assert.deepEqual([deleted.ok, deleted.error.code], [false, 'result_gone']);
  // …while a query that FAILED stays an error
  assert.equal(buildViewModel('display_result', { ok: false, status: 'error', error: { stage: 'query', message: 'x' } }).reason, 'error');
});

// A DRILL-DOWN: the card gets the top level, and each row it opens reads the next level from the
// task's stored table, filtered to that row — the same read the card makes, run here against the warehouse.
test('a pivot shows the top level from the warehouse, and a row opens into its children, which add up to it', opts, async (t) => {
  if (skip(t)) return;
  const display = { kind: 'pivot', levels: [{ column: 'users_country', label: 'Country' }, { column: 'users_platform', label: 'Platform' }], values: [{ column: 'mon_revenue', agg: 'sum', label: 'Revenue' }] };
  const groupBy = [{ model: 'users', attribute: 'country' }, { model: 'users', attribute: 'platform' }];
  // a drill-down reads a stored result: a result held in memory is refused
  const inMemory = await q({ group_by: groupBy });
  await assert.rejects(engine.display_result({ task_id: inMemory.task_id, display }), /materialize/);
  const stored = await q({ group_by: groupBy, materialize: true });
  const top = await engine.display_result({ task_id: stored.task_id, display });
  assert.equal(top.drawn, true, JSON.stringify(top.error || top.warnings));
  const m = buildViewModel('display_result', top);
  assert.equal(m.kind, 'pivot');
  assert.deepEqual(m.source, { task_id: stored.task_id });
  assert.deepEqual(m.levels, [{ column: 'users_country', label: 'Country' }, { column: 'users_platform', label: 'Platform' }]);
  const byC = Object.fromEntries(m.rows.map((r) => [r.label, r.values[0]]));
  assert.deepEqual([byC.US, byC.GB, byC.BR], [35, 25, 25]);
  assert.equal(m.rows[0].label, 'US', 'the largest first');
  // open US: the card's own read
  const us = m.rows.find((r) => r.label === 'US');
  const level = await engine.drill_result({ ...m.source, transform: pivotTransform(display, [us.key]), limit: PIVOT_LEVEL_ROWS });
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
  const stored = await q({ group_by: groupBy, materialize: true });
  // a drill level the chart already draws is refused (and nothing is drawn)
  await assert.rejects(engine.display_result({ task_id: stored.task_id, display: { ...display, drill: { levels: [{ column: 'users_country' }] } } }), (e) => e.field === 'display');
  const top = await engine.display_result({ task_id: stored.task_id, display });
  const m = buildViewModel('display_result', top);
  assert.equal(m.chart.type, 'bar');
  // one bar per country, whatever the platforms under it: the fold of the stored rows
  const byC = Object.fromEntries(m.chart.bars.map((b) => [b.label, b.value]));
  assert.deepEqual([byC.US, byC.GB, byC.BR], [35, 25, 25]);
  assert.deepEqual(m.chart.drill.levels, [{ column: 'users_platform', label: 'Platform' }]);
  // click US → by Platform
  const i = m.chart.labels.indexOf('US');
  const path = [{ column: 'users_country', value: m.chart.drill.keys[i] }];
  const view = drillView(display, path, { level: { column: 'users_platform' }, mode: 'breakdown' });
  const got = await engine.drill_result({ ...m.chart.drill.source, transform: view.transform, limit: DRILL_ROWS });
  const next = buildViewModel('display_result', { ...got, display: view.display, drill_source: m.chart.drill.source, drill_path: path });
  assert.equal(next.chart.x, 'users_platform');
  assert.equal(next.chart.bars.reduce((a, b) => a + b.value, 0), 35, 'US by platform adds up to US');
  assert.deepEqual(next.chart.drill.levels, [], 'no level left to step into');
});
