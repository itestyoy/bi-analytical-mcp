// Materialization mode: a query is a task; with materialize:true it is compiled to SQL, written as
// a materialized='table' dbt model named after the task, built (dbt run), and rows are read back
// from that table (dbt show) — results live in the warehouse (resilient, pageable). A stored result
// is re-sliced by a pipeline started from its task (from_task), and a drawn card reads its views
// from it (drill_result: the path taken, the server makes the level). Data-only assertions.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { startWarehouse, fixtureProject } from './warehouse-harness.js';
import { settle, isStartedTask, taskResult, one } from '../helpers/settle.js';
import { DBT_BIN, HAS_DBT, testDbt } from '../helpers/dbt-env.js';

const execFileP = promisify(execFile);
const BASE = fixtureProject('dbt_project'); // a private copy: the test files run side by side
const opts = { timeout: 300000 };
const num = (v) => Number(v);

let wh; let engine; let backend; let ctxId;

before(async () => {
  if (!HAS_DBT) return;
  wh = await startWarehouse();
  const env = { ...process.env, DBT_PROFILES_DIR: BASE, DBT_PROJECT_DIR: BASE, DUCKDB_PATH: wh.path };
  await execFileP(DBT_BIN, ['seed'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  await execFileP(DBT_BIN, ['run'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: mkdtempSync(join(tmpdir(), 'mat-')), timeSpineDialect: 'duckdb' });
  backend = testDbt({ profilesDir: BASE });
  engine = settle(new Engine({ catalog: loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), { profilesDir: BASE, projectDir: BASE }), contextManager: ctxs, runner: backend }));
  const out = await engine.build_semantic_model({
    name: 'mon',
    semantic_models: [{ from: 'events', measures: [{ name: 'revenue', agg: 'sum', field: 'price_in_usd_of_event_data' }], where: [{ field: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] }, { from: 'users' }],
    metrics: [{ name: 'revenue', type: 'simple', measure: 'revenue' }],
  });
  assert.equal(out.parse.ok, true, JSON.stringify(out.parse));
  ctxId = out.context_id;
}, opts);

after(async () => { backend?.close?.(); if (wh) await wh.stop(); });
const skip = (t) => { if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; } return false; };

test('materialize: the query is a task whose result is a stored table — rows read back = total revenue 85', opts, async (t) => {
  if (skip(t)) return;
  const r = await engine.query_semantic_model({ context_id: ctxId, metrics: ['mon_revenue'], materialize: true });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.status, 'done');
  assert.ok(r.task_id && r.table, 'the task and the table it left');
  assert.equal(r.table, `qr_${r.task_id}`);
  assert.equal(num(r.rows[0].mon_revenue), 85);
  globalThis.__matTask = r.task_id;
});

test('resilient re-read: once the in-memory response is gone, query_semantic_model({ task_id }) reads the stored table', opts, async (t) => {
  if (skip(t)) return;
  engine.raw._taskResults.delete(globalThis.__matTask); // what a restart (or an hour) does to the held response
  const r = await one(engine.query_semantic_model({ task_ids: [globalThis.__matTask] }));
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.status, 'done');
  assert.equal(num(r.rows[0].mon_revenue), 85); // recomputes nothing — reads the table
});

test('the call that starts a query never waits: a task_id now, the rows from query_semantic_model({ task_id })', opts, async (t) => {
  if (skip(t)) return;
  const started = await engine.raw.query_semantic_model({ context_id: ctxId, metrics: ['mon_revenue'], group_by: [{ model: 'users', attribute: 'country' }], materialize: true });
  assert.ok(isStartedTask(started), JSON.stringify(started));
  const res = await taskResult(engine, started.task_id);
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.equal(res.status, 'done');
  const total = res.rows.reduce((s, x) => s + num(x.mon_revenue), 0);
  assert.equal(total, 85); // revenue by country sums to the grand total
});

test('a pipeline started FROM a stored result re-slices it without recomputing (where / aggregate / a filter on the aggregate)', opts, async (t) => {
  if (skip(t)) return;
  const m = await engine.query_semantic_model({ context_id: ctxId, metrics: ['mon_revenue'], group_by: [{ model: 'users', attribute: 'country' }], materialize: true });
  assert.equal(m.status, 'done', JSON.stringify(m));
  const from = async (name, stages) => {
    const d = await engine.build_pipeline_model({ action: 'start', name, from_task: m.task_id });
    assert.equal(d.reads, m.table, 'the draft reads the task\'s table');
    await engine.build_pipeline_model({ action: 'add_steps', context_id: d.context_id, stages });
    const built = await engine.build_pipeline_model({ action: 'materialize', context_id: d.context_id });
    assert.equal(built.status, 'done', JSON.stringify(built.error));
    return built.rows;
  };
  // (a) compress to a single total
  const [total] = await from('total', [{ stage: 'aggregate', measures: [{ name: 'total', agg: 'sum', column: 'mon_revenue' }] }]);
  assert.equal(num(total.total), 85);
  // (b) one country -> exact seed value (US revenue = 35)
  const [us] = await from('only_us', [{ stage: 'where', conditions: [{ column: 'users_country', op: 'eq', value: 'US' }] }, { stage: 'aggregate', measures: [{ name: 'rev', agg: 'sum', column: 'mon_revenue' }] }]);
  assert.equal(num(us.rev), 35);
  // (c) group, then keep the groups whose total clears a bar
  const big = await from('big', [
    { stage: 'aggregate', group_by: ['users_country'], measures: [{ name: 'rev', agg: 'sum', column: 'mon_revenue' }] },
    { stage: 'where', conditions: [{ column: 'rev', op: 'gte', value: 25 }] },
  ]);
  assert.ok(big.length >= 1 && big.every((r) => num(r.rev) >= 25));
  assert.ok(big.reduce((s, r) => s + num(r.rev), 0) <= 85);
});

test('a drawn card reads its views from its own task: a row opens into a level that adds up to it, a path value is bound as a literal', opts, async (t) => {
  if (skip(t)) return;
  const m = await engine.query_semantic_model({ context_id: ctxId, metrics: ['mon_revenue'], group_by: [{ model: 'users', attribute: 'country' }, { model: 'users', attribute: 'platform' }], materialize: true });
  const card = await engine.display_model_result({ task_id: m.task_id, display: { kind: 'pivot', levels: [{ column: 'users_country' }, { column: 'users_platform' }], values: [{ column: 'mon_revenue' }] } });
  assert.equal(card.drawn, true, JSON.stringify(card).slice(0, 300));
  assert.equal(card.rows.reduce((s, r) => s + num(r.mon_revenue), 0), 85, 'the top level is the whole result, folded by country');
  // the card opens the US row: the path taken, and the server reads the next level (platform) under it
  const us = await engine.drill_result({ task_id: m.task_id, path: [{ column: 'users_country', value: 'US' }] });
  assert.equal(us.ok, true, JSON.stringify(us.error));
  assert.ok(us.rows.length >= 1);
  assert.equal(us.rows.reduce((s, r) => s + num(r.mon_revenue), 0), 35, 'US by platform adds up to US');
  // injection/escaping proven on DATA: a path value containing a quote+SQL is bound as a literal ->
  // the read runs safely and simply matches nothing.
  const inj = await engine.drill_result({ task_id: m.task_id, path: [{ column: 'users_country', value: "US'); drop table x; --" }] });
  assert.equal(inj.ok, true, JSON.stringify(inj.error));
  assert.equal(inj.rows.length, 0);
});

// QUERYING A BUILT PIPELINE MODEL: query_pipeline_model({ context_id, transform }) filters, groups
// and aggregates the stored table without recomputing it. A count with a `column` must count
// NON-NULL values (COUNT(column)), NOT rows (COUNT(*)). Proven on DATA: a pipeline derives
// `price` (populated only on iap_purchase_completed, NULL on every other event), so count(price) <
// count(*), and count(price) + (rows where price IS NULL) == count(*). A regression to COUNT(*) makes
// them equal. A value carrying SQL is bound as a literal.
test('query_pipeline_model over a built model: count(column) counts NON-NULL only, values are literals', opts, async (t) => {
  if (skip(t)) return;
  const s = await engine.build_pipeline_model({ action: 'start', name: 'nullcount', source: 'events' });
  await engine.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, stages: [{ stage: 'compute', name: 'price', expr: { fn: 'event_property', property: 'price_in_usd_of_event_data', type: 'numeric' } }] });
  const mat = await engine.build_pipeline_model({ action: 'materialize', context_id: s.context_id });
  assert.equal(mat.build?.ok, true, JSON.stringify(mat.error || mat.build));
  const started = await engine.raw.query_pipeline_model({ context_id: s.context_id, transform: { measures: [{ agg: 'count', name: 'total' }] } });
  assert.ok(isStartedTask(started), 'a query over a built model is a task too');
  const totalR = await taskResult(engine, started.task_id);
  const read = (transform) => engine.query_pipeline_model({ context_id: s.context_id, transform });
  const nnR = await read({ measures: [{ agg: 'count', column: 'price', name: 'nn' }] });
  const nullR = await read({ where: [{ column: 'price', op: 'is_null' }], measures: [{ agg: 'count', name: 'nulls' }] });
  assert.equal(totalR.ok !== false && nnR.ok !== false && nullR.ok !== false, true, JSON.stringify({ totalR: totalR.error, nnR: nnR.error, nullR: nullR.error }));
  const total = num(totalR.rows[0].total); const nonNull = num(nnR.rows[0].nn); const nulls = num(nullR.rows[0].nulls);
  assert.ok(nulls > 0, `fixture must have NULL price rows, got ${nulls}`);
  assert.ok(nonNull < total, `count(price)=${nonNull} must exclude NULLs (< total ${total}) — a COUNT(*) regression makes them equal`);
  assert.equal(nonNull + nulls, total, `count(column) + null_count must equal count(*): ${nonNull} + ${nulls} != ${total}`);
  // grouped: the priced rows per event name add back up to the non-NULL count, and only purchase events carry a price
  const byEvent = await read({ where: [{ column: 'price', op: 'is_not_null' }], group_by: ['event_name'], measures: [{ agg: 'count', column: 'price', name: 'n' }] });
  assert.ok(byEvent.rows.every((r) => String(r.event_name).startsWith('iap_purchase')), JSON.stringify(byEvent.rows));
  assert.equal(byEvent.rows.reduce((a, r) => a + num(r.n), 0), nonNull);
  // injection/escaping proven on DATA: the literal matches nothing, and the query runs
  const inj = await read({ where: [{ column: 'event_name', op: 'eq', value: "x'); drop table x; --" }], measures: [{ agg: 'count', name: 'n' }] });
  assert.equal(num(inj.rows[0].n), 0);
  // a read sorts as the order_by stage does: NULL prices last unless a key asks them first, on every warehouse
  const first = async (key) => (await engine.query_pipeline_model({ context_id: s.context_id, transform: { order_by: [key, { key: 'event_id' }] }, limit: 1 })).rows[0].price;
  const extremes = await read({ measures: [{ agg: 'min', column: 'price', name: 'lo' }, { agg: 'max', column: 'price', name: 'hi' }] });
  assert.equal(num(await first({ key: 'price' })), num(extremes.rows[0].lo));
  assert.equal(num(await first({ key: 'price', direction: 'desc' })), num(extremes.rows[0].hi));
  assert.equal(await first({ key: 'price', nulls: 'first' }), null);
  assert.equal(await first({ key: 'price', direction: 'desc', nulls: 'first' }), null);
  // a semantic context is not a pipeline model
  await assert.rejects(() => engine.query_pipeline_model({ context_id: ctxId }), /no built pipeline model/);
});

// A CONDITIONAL aggregate and a SECOND level over a built model: per player, how many level starts
// and completes (count … where), then how many players there are and how many completed at least
// once (the groups counted, a per-group condition) — all read from the stored table, checked against
// the rows. And a lag over a text column is text in the schema, as its values are.
test('query_pipeline_model: conditional aggregates and a second level count the groups, as the rows do; a lag of text is text', opts, async (t) => {
  if (skip(t)) return;
  const src = (await wh.query('select player_id_of_internal as u, event_name as e from fct_analytics_events')).rows;
  const per = new Map();
  for (const r of src) { const p = per.get(r.u) || { s: 0, c: 0 }; if (r.e === 'level_started') p.s += 1; if (r.e === 'level_completed') p.c += 1; per.set(r.u, p); }
  const s = await engine.build_pipeline_model({ action: 'start', name: 'two_levels', source: 'events' });
  const step = await engine.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, include_columns: true, stages: [{ stage: 'compute', name: 'prev_event', expr: { fn: 'lag', args: [{ column: 'event_name' }], over: { partition_by: ['player_id_of_internal'], order_by: [{ key: 'device_time' }, { key: 'event_id' }] } } }] });
  assert.equal(step.available_columns.find((c) => c.name === 'prev_event')?.type, 'string', 'a lag of event_name is text');
  const mat = await engine.build_pipeline_model({ action: 'materialize', context_id: s.context_id });
  assert.equal(mat.build?.ok, true, JSON.stringify(mat.error || mat.build));
  const prev = await engine.query_pipeline_model({ context_id: s.context_id, transform: { where: [{ column: 'prev_event', op: 'is_not_null' }], group_by: ['prev_event'], measures: [{ agg: 'count', name: 'n' }] } });
  assert.ok(prev.rows.every((r) => typeof r.prev_event === 'string' && src.some((x) => x.e === r.prev_event)), 'its values are event names');
  const r = await engine.query_pipeline_model({ context_id: s.context_id, transform: {
    group_by: ['player_id_of_internal'],
    measures: [
      { agg: 'count', where: [{ column: 'event_name', op: 'eq', value: 'level_started' }], name: 'starts' },
      { agg: 'count', where: [{ column: 'event_name', op: 'eq', value: 'level_completed' }], name: 'completes' },
    ],
    then: { measures: [
      { agg: 'count', name: 'players' },
      { agg: 'count', where: [{ column: 'completes', op: 'gt', value: 0 }], name: 'completed_once' },
      { agg: 'sum', column: 'starts', name: 'starts' },
    ] },
  } });
  assert.equal(r.ok !== false, true, JSON.stringify(r.error));
  assert.equal(r.rows.length, 1);
  const row = r.rows[0];
  assert.equal(num(row.players), per.size);
  assert.equal(num(row.completed_once), [...per.values()].filter((p) => p.c > 0).length);
  assert.equal(num(row.starts), [...per.values()].reduce((a, p) => a + p.s, 0));
  // a second level reads the first's columns only
  await assert.rejects(() => engine.query_pipeline_model({ context_id: s.context_id, transform: { group_by: ['player_id_of_internal'], measures: [{ agg: 'count', name: 'n' }], then: { measures: [{ agg: 'sum', column: 'event_name', name: 's' }] } } }), /then\.measures/);
});

test('a stored result is paged with query_semantic_model({ task_id }): limit/offset + has_more reconstruct it', opts, async (t) => {
  if (skip(t)) return;
  const m = await engine.query_semantic_model({ context_id: ctxId, metrics: ['mon_revenue'], group_by: [{ model: 'users', attribute: 'country' }], materialize: true });
  assert.equal(m.status, 'done', JSON.stringify(m));
  const full = await one(engine.query_semantic_model({ task_ids: [m.task_id], limit: 1000 }));
  const total = full.row_count;
  assert.ok(total >= 2, `expected multiple country rows, got ${total}`);
  // page through in chunks of 2; has_more drives the loop and must terminate.
  const collected = [];
  let offset = 0; let last; let guard = 0;
  do {
    last = await one(engine.query_semantic_model({ task_ids: [m.task_id], limit: 2, offset }));
    assert.equal(last.ok, true, JSON.stringify(last.error));
    collected.push(...last.rows);
    offset += 2;
  } while (last.page.has_more && guard++ < 20);
  assert.equal(last.page.has_more, false);                 // terminates on the last page
  assert.equal(collected.length, total);                   // pages cover every row exactly
  assert.equal(collected.reduce((s, x) => s + num(x.mon_revenue), 0), 85);
});

// PAGING IS THE READ'S: a read's offset/limit are row numbers of the task's result. A query keeps the
// first `limit` rows of it (a page past them is told it was not kept); a stored result pages to its
// last row, its first answer included — a page past the rows the task holds is read from the table.
test('a held result pages by its row numbers, and a page past the rows it kept says how to have them', opts, async (t) => {
  if (skip(t)) return;
  const order_by = [{ key: 'users_country', direction: 'asc' }];
  const full = await engine.query_semantic_model({ context_id: ctxId, metrics: ['mon_revenue'], group_by: [{ model: 'users', attribute: 'country' }], order_by });
  assert.ok(full.rows.length >= 3, `expected at least 3 country rows, got ${full.rows.length}`);
  const countries = full.rows.map((r) => r.users_country);
  // the task keeps its first 2 rows
  const started = await engine.raw.query_semantic_model({ context_id: ctxId, metrics: ['mon_revenue'], group_by: [{ model: 'users', attribute: 'country' }], order_by, limit: 2 });
  await taskResult(engine.raw, started.task_id);
  const second = await one(engine.query_semantic_model({ task_ids: [started.task_id], offset: 1, limit: 1 }));
  assert.deepEqual(second.rows.map((r) => r.users_country), [countries[1]], 'offset 1 is the result\'s second row');
  assert.equal(Number(second.rows[0].mon_revenue), Number(full.rows[1].mon_revenue));
  assert.equal(second.page.offset, 1);
  // a page that reaches past the 2 rows kept: the rows kept, more exist, and no row number reads them
  const page = await one(engine.query_semantic_model({ task_ids: [started.task_id] }));
  assert.deepEqual(page.rows.map((r) => r.users_country), countries.slice(0, 2));
  assert.equal(page.page.has_more, true);
  assert.equal(page.page.next_offset, undefined);
  assert.equal(page.page.held_rows, 2);
  assert.ok(page.warnings.some((w) => /larger limit/.test(w)), JSON.stringify(page.warnings));
});

test('a stored result pages to its last row: a page past the rows the task holds is read from its table', opts, async (t) => {
  if (skip(t)) return;
  const group_by = [{ model: 'users', attribute: 'country' }];
  // the task holds 1 row of its result; the table stores them all
  const m = await engine.raw.query_semantic_model({ context_id: ctxId, metrics: ['mon_revenue'], group_by, materialize: true, limit: 1 });
  const held = await taskResult(engine.raw, m.task_id);
  assert.equal(held.status, 'done', JSON.stringify(held.error));
  const all = await one(engine.query_semantic_model({ task_ids: [m.task_id] }));
  assert.ok(all.rows.length >= 3, 'the first page is the result\'s, not the one row held');
  assert.equal(all.page.has_more, false);
  assert.equal(all.page.total_rows, all.rows.length);
  assert.equal(all.rows.reduce((s, r) => s + num(r.mon_revenue), 0), 85);
  // row by row, by row number: the same rows as that page, in its order
  const one1 = await one(engine.query_semantic_model({ task_ids: [m.task_id], offset: 1, limit: 1 }));
  assert.deepEqual(one1.rows, [all.rows[1]]);
  assert.equal(one1.page.next_offset, 2);
  // a page that starts past the last row holds none, and counts the rows there are
  const past = await one(engine.query_semantic_model({ task_ids: [m.task_id], offset: all.rows.length + 10 }));
  assert.deepEqual([past.rows, past.page.total_rows, past.page.has_more], [[], all.rows.length, false]);
  // a card draws the rows the task keeps
  const card = await engine.display_model_result({ task_id: m.task_id, display: { kind: 'bar', x: 'users_country', y: ['mon_revenue'] } });
  assert.equal(card.rows.length, 1);
  // …once its answer is gone too (a restart): the task's 2 rows, read from the table, not a default
  const two = await engine.raw.query_semantic_model({ context_id: ctxId, metrics: ['mon_revenue'], group_by, materialize: true, limit: 2 });
  assert.equal((await taskResult(engine.raw, two.task_id)).status, 'done');
  engine.raw._taskResults.delete(two.task_id);
  const late = await engine.display_model_result({ task_id: two.task_id, display: { kind: 'bar', x: 'users_country', y: ['mon_revenue'] } });
  assert.equal(late.drawn, true, JSON.stringify(late.error));
  assert.equal(late.rows.length, 2);
  for (const r of late.rows) assert.ok(all.rows.some((a) => a.users_country === r.users_country && num(a.mon_revenue) === num(r.mon_revenue)), JSON.stringify(r));
});

test('a pipeline build pages its stored table to the last row, and a projection keeps its first limit rows', opts, async (t) => {
  if (skip(t)) return;
  const truth = (await wh.query('select event_id from fct_analytics_events order by event_id')).rows.map((r) => r.event_id);
  assert.ok(truth.length > 100, `expected more than two pages of events, got ${truth.length}`);
  const started = await engine.raw.build_pipeline_model({ action: 'start', name: 'paged_events', source: 'events', stages: [{ stage: 'project', keep: ['event_id', 'event_name'] }, { stage: 'order_by', keys: [{ key: 'event_id' }] }], materialize: true });
  const built = { task_id: started.materialize?.task_id, context_id: started.context_id };
  assert.ok(built.task_id, JSON.stringify(started));
  const first = await taskResult(engine.raw, built.task_id);
  assert.equal(first.status, 'done', JSON.stringify(first.error));
  // page through the build's task by next_offset: every event once, past the 50 rows its answer holds
  const seen = []; const sizes = [];
  let offset = 0;
  for (let guard = 0; guard < 20; guard += 1) {
    const page = await one(engine.query_pipeline_model({ task_ids: [built.task_id], offset }));
    assert.equal(page.status, 'done', JSON.stringify(page.error));
    assert.equal(page.page.offset, offset);
    seen.push(...page.rows.map((r) => r.event_id)); sizes.push(page.rows.length);
    if (!page.page.has_more) { assert.equal(page.page.total_rows, truth.length); break; }
    offset = page.page.next_offset;
  }
  assert.deepEqual([...seen].sort(), [...truth].sort(), 'the pages hold every event exactly once');
  assert.deepEqual(sizes.slice(0, -1).every((n) => n === 50), true, `pages of 50: ${sizes.join(', ')}`);
  // a page across the end of the rows held is the table's, as a read of it again
  const across = await one(engine.query_pipeline_model({ task_ids: [built.task_id], offset: 45, limit: 10 }));
  assert.deepEqual(across.rows.map((r) => r.event_id), seen.slice(45, 55));
  // …with where its rows come from, and not the build's own SQL, said once with its first page
  assert.deepEqual([across.provenance?.tier, across.model_sql], ['pipeline', undefined]);
  // a build that ends unsorted says so on every page — those read from its table past the rows held too —
  // and its pages still hold every row once
  const loose = await engine.raw.build_pipeline_model({ action: 'start', name: 'loose_events', source: 'events', stages: [{ stage: 'project', keep: ['event_id'] }], materialize: true });
  assert.equal((await taskResult(engine.raw, loose.materialize?.task_id)).status, 'done');
  const pages = [];
  for (let off = 0; off != null && pages.length < 20;) {
    const p = await one(engine.query_pipeline_model({ task_ids: [loose.materialize.task_id], offset: off }));
    pages.push(p); off = p.page.next_offset;
  }
  assert.ok(pages.length > 1, 'more than one page');
  assert.ok(pages.every((p) => p.page.ordered === false), JSON.stringify(pages.map((p) => p.page)));
  assert.deepEqual(pages.flatMap((p) => p.rows.map((r) => r.event_id)).sort(), [...truth].sort());
  await engine._deletePipelineModel({ context_id: loose.context_id });
  // a projection over the built model keeps its first 60 rows: a read pages them by row number
  const q = await engine.raw.query_pipeline_model({ context_id: built.context_id, transform: { order_by: [{ key: 'event_id' }] }, limit: 60 });
  await taskResult(engine.raw, q.task_id);
  const tail = await one(engine.query_pipeline_model({ task_ids: [q.task_id], offset: 50 }));
  assert.deepEqual(tail.rows.map((r) => r.event_id), [...truth].sort().slice(50, 60));
  assert.equal(tail.page.has_more, true);
  assert.equal(tail.page.next_offset, undefined, 'rows past the 60 kept are not read by a row number');
  await engine._deletePipelineModel({ context_id: built.context_id });
});

// A READ'S MEASURE is the aggregate stage's, written by the same writer: it merges a sketch a pipeline
// stored, and counts distinct approximately (exact on DuckDB) — SEED_DATA: 7 distinct buyers over 3
// products (3 + 3 + 2 per product: u1 bought twice).
test('a read merges a stored sketch with hll_merge and counts with approx_count_distinct: 7 buyers, not 8', opts, async (t) => {
  if (skip(t)) return;
  const purchases = { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] };
  const sketched = await engine._buildPipeline({ name: 'buyer_sketch', pipeline: { source: 'events', stages: [
    purchases,
    { stage: 'compute', name: 'pid', expr: { fn: 'event_property', property: 'product_id_of_event_data', type: 'string' } },
    { stage: 'aggregate', group_by: ['pid'], measures: [{ name: 'sk', agg: 'hll_init', column: 'player_id_of_internal' }, { name: 'n', agg: 'count_distinct', column: 'player_id_of_internal' }] },
  ] } });
  assert.equal(sketched.build?.ok, true, JSON.stringify(sketched.error || sketched.build));
  const merged = await engine.query_pipeline_model({ context_id: sketched.context_id, transform: { measures: [{ name: 'buyers', agg: 'hll_merge', column: 'sk' }, { name: 'naive', agg: 'sum', column: 'n' }] } });
  assert.equal(merged.ok !== false, true, JSON.stringify(merged.error));
  assert.equal(num(merged.rows[0].buyers), 7);
  assert.equal(num(merged.rows[0].naive), 8);
  const raw = await engine._buildPipeline({ name: 'buyer_rows', pipeline: { source: 'events', stages: [purchases] } });
  const approx = await engine.query_pipeline_model({ context_id: raw.context_id, transform: { measures: [{ name: 'buyers', agg: 'approx_count_distinct', column: 'player_id_of_internal' }, { name: 'exact', agg: 'count_distinct', column: 'player_id_of_internal' }] } });
  assert.equal(num(approx.rows[0].buyers), 7);
  assert.equal(num(approx.rows[0].exact), 7);
  await engine._deletePipelineModel({ context_id: sketched.context_id });
  await engine._deletePipelineModel({ context_id: raw.context_id });
});

// A description is metadata, and metadata must not be able to change a number. It travels into the
// generated model's config banner (a SQL comment), so the way to prove it is inert is to build the
// SAME pipeline twice — once labelled, once not — and compare the ROWS, not the SQL text.
test('a described pipeline builds and returns exactly the rows of the same pipeline unlabelled', opts, async (t) => {
  if (skip(t)) return;
  const stages = [
    { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] },
    { stage: 'compute', name: 'price', expr: { fn: 'event_property', property: 'price_in_usd_of_event_data', type: 'numeric' } },
    { stage: 'aggregate', group_by: ['player_id_of_internal'], measures: [{ name: 'revenue', agg: 'sum', column: 'price' }, { name: 'purchases', agg: 'count' }] },
    { stage: 'order_by', keys: [{ key: 'player_id_of_internal', direction: 'asc' }] },
  ];
  const build = async (name, description) => {
    const out = await engine._buildPipeline({ name, ...(description ? { description } : {}), pipeline: { source: 'events', stages } });
    assert.equal(out.build?.ok, true, JSON.stringify(out.error || out.build));
    return out;
  };

  const plain = await build('descr_plain');
  const labelled = await build('descr_labelled', 'revenue per payer — the weekly monetization readout');

  const norm = (rows) => rows.map((r) => [String(r.player_id_of_internal), Number(r.revenue), Number(r.purchases)]);
  assert.ok(labelled.rows.length > 0, 'the labelled build returned rows');
  assert.deepEqual(norm(labelled.rows), norm(plain.rows), 'the label changed no value');
  // …and the label is what the context now says this model is for
  const described = await engine.context({ action: 'describe', context_id: labelled.context_id });
  assert.equal(described.models?.[0]?.description, 'revenue per payer — the weekly monetization readout');
  await engine._deletePipelineModel({ context_id: plain.context_id });
  await engine._deletePipelineModel({ context_id: labelled.context_id });
});
