// Materialization mode: a query is a task; with materialize:true it is compiled to SQL, written as
// a materialized='table' dbt model named after the task, built (dbt run), and rows are read back
// from that table (dbt show) — results live in the warehouse (resilient, pageable). A stored result
// is re-sliced by a pipeline started from its task (from_task), and a drawn card reads its views
// from it (drill_result). Data-only assertions.

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
import { startWarehouse } from './warehouse-harness.js';
import { settle, isStartedTask, taskResult } from '../helpers/settle.js';

const execFileP = promisify(execFile);
const BASE = join(process.cwd(), 'test', 'integration', 'fixtures', 'dbt_project');
const DBT_BIN = process.env.DBT_BIN || join(process.cwd(), '.dbtvenv', 'bin', 'dbt');
const MF_BIN = process.env.MF_BIN || join(process.cwd(), '.dbtvenv', 'bin', 'mf');
const PY_BIN = process.env.PYTHON_BIN || join(process.cwd(), '.dbtvenv', 'bin', 'python');
const HAS_DBT = existsSync(DBT_BIN) && existsSync(MF_BIN);
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
  backend = new MfEngineBackend({ pythonBin: PY_BIN, dbtBin: DBT_BIN, profilesDir: BASE });
  engine = settle(new Engine({ catalog: loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), { profilesDir: BASE, projectDir: BASE }), contextManager: ctxs, runner: backend }));
  const out = await engine.build_semantic_model({
    name: 'mon', use_base_models: ['users'],
    semantic_models: [{ from: 'events', event_scope: { event_name: ['iap_purchase_completed'] }, measures: [{ name: 'revenue', agg: 'sum', field: 'price_in_usd_of_event_data' }] }],
    metrics: [{ name: 'revenue', type: 'simple', measure: { name: 'revenue' } }],
  });
  assert.equal(out.parse.ok, true, JSON.stringify(out.parse));
  ctxId = out.context_id;
}, opts);

after(async () => { backend?.close(); if (wh) await wh.stop(); });
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
  const r = await engine.query_semantic_model({ task_id: globalThis.__matTask });
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
    await engine.build_pipeline_model({ action: 'add_steps', draft_id: d.draft_id, stages });
    const built = await engine.build_pipeline_model({ action: 'materialize', draft_id: d.draft_id });
    assert.equal(built.status, 'done', JSON.stringify(built.error));
    return built.rows;
  };
  // (a) compress to a single total
  const [total] = await from('total', [{ stage: 'aggregate', measures: [{ name: 'total', fn: 'sum', column: 'mon_revenue' }] }]);
  assert.equal(num(total.total), 85);
  // (b) one country -> exact seed value (US revenue = 35)
  const [us] = await from('only_us', [{ stage: 'where', conditions: [{ column: 'users_country', op: 'eq', value: 'US' }] }, { stage: 'aggregate', measures: [{ name: 'rev', fn: 'sum', column: 'mon_revenue' }] }]);
  assert.equal(num(us.rev), 35);
  // (c) group, then keep the groups whose total clears a bar
  const big = await from('big', [
    { stage: 'aggregate', group_by: ['users_country'], measures: [{ name: 'rev', fn: 'sum', column: 'mon_revenue' }] },
    { stage: 'where', conditions: [{ column: 'rev', op: 'gte', value: 25 }] },
  ]);
  assert.ok(big.length >= 1 && big.every((r) => num(r.rev) >= 25));
  assert.ok(big.reduce((s, r) => s + num(r.rev), 0) <= 85);
});

test('a drawn card reads its views from its own task: values are bound as literals, a count counts values', opts, async (t) => {
  if (skip(t)) return;
  const m = await engine.query_semantic_model({ context_id: ctxId, metrics: ['mon_revenue'], group_by: [{ model: 'users', attribute: 'country' }], materialize: true });
  const card = await engine.display_model_result({ task_id: m.task_id, display: { kind: 'pivot', levels: [{ column: 'users_country' }], values: [{ column: 'mon_revenue' }] } });
  assert.equal(card.drawn, true, JSON.stringify(card).slice(0, 300));
  assert.equal(card.rows.reduce((s, r) => s + num(r.mon_revenue), 0), 85, 'the top level is the whole result, folded by country');
  const us = await engine.drill_result({ task_id: m.task_id, transform: { where: [{ column: 'users_country', op: 'eq', value: 'US' }], aggregations: [{ fn: 'sum', column: 'mon_revenue', as: 'rev' }] } });
  assert.equal(num(us.rows[0].rev), 35);
  // injection/escaping proven on DATA: a value containing a quote+SQL is bound as a literal ->
  // the read runs safely and simply matches nothing.
  const inj = await engine.drill_result({ task_id: m.task_id, transform: { where: [{ column: 'users_country', op: 'eq', value: "US'); drop table x; --" }], aggregations: [{ fn: 'sum', column: 'mon_revenue', as: 'rev' }] } });
  assert.equal(inj.ok, true, JSON.stringify(inj.error));
  assert.ok(inj.rows.length === 0 || num(inj.rows[0].rev) === 0 || inj.rows[0].rev == null);
});

// QUERYING A BUILT PIPELINE MODEL: query_pipeline_model({ context_id, transform }) filters, groups
// and aggregates the stored table without recomputing it. A count with a `column` must count
// NON-NULL values (COUNT(column)), NOT rows (COUNT(*)). Proven on DATA: a native pipeline derives
// `price` (populated only on iap_purchase_completed, NULL on every other event), so count(price) <
// count(*), and count(price) + (rows where price IS NULL) == count(*). A regression to COUNT(*) makes
// them equal. A value carrying SQL is bound as a literal.
test('query_pipeline_model over a built model: count(column) counts NON-NULL only, values are literals', opts, async (t) => {
  if (skip(t)) return;
  const s = await engine.build_pipeline_model({ action: 'start', name: 'nullcount', source: 'events' });
  await engine.build_pipeline_model({ action: 'add_step', draft_id: s.draft_id, stage: { stage: 'derive', name: 'price', op: 'extract', source: 'price_in_usd_of_event_data', type: 'numeric' } });
  const mat = await engine.build_pipeline_model({ action: 'materialize', draft_id: s.draft_id });
  assert.equal(mat.build?.ok, true, JSON.stringify(mat.error || mat.build));
  const started = await engine.raw.query_pipeline_model({ context_id: s.draft_id, transform: { aggregations: [{ fn: 'count', column: '*', as: 'total' }] } });
  assert.ok(isStartedTask(started), 'a query over a built model is a task too');
  const totalR = await taskResult(engine, started.task_id);
  const read = (transform) => engine.query_pipeline_model({ context_id: s.draft_id, transform });
  const nnR = await read({ aggregations: [{ fn: 'count', column: 'price', as: 'nn' }] });
  const nullR = await read({ where: [{ column: 'price', op: 'is_null' }], aggregations: [{ fn: 'count', column: '*', as: 'nulls' }] });
  assert.equal(totalR.ok !== false && nnR.ok !== false && nullR.ok !== false, true, JSON.stringify({ totalR: totalR.error, nnR: nnR.error, nullR: nullR.error }));
  const total = num(totalR.rows[0].total); const nonNull = num(nnR.rows[0].nn); const nulls = num(nullR.rows[0].nulls);
  assert.ok(nulls > 0, `fixture must have NULL price rows, got ${nulls}`);
  assert.ok(nonNull < total, `count(price)=${nonNull} must exclude NULLs (< total ${total}) — a COUNT(*) regression makes them equal`);
  assert.equal(nonNull + nulls, total, `count(column) + null_count must equal count(*): ${nonNull} + ${nulls} != ${total}`);
  // grouped: the priced rows per event name add back up to the non-NULL count, and only purchase events carry a price
  const byEvent = await read({ where: [{ column: 'price', op: 'is_not_null' }], group_by: ['event_name'], aggregations: [{ fn: 'count', column: 'price', as: 'n' }] });
  assert.ok(byEvent.rows.every((r) => String(r.event_name).startsWith('iap_purchase')), JSON.stringify(byEvent.rows));
  assert.equal(byEvent.rows.reduce((a, r) => a + num(r.n), 0), nonNull);
  // injection/escaping proven on DATA: the literal matches nothing, and the query runs
  const inj = await read({ where: [{ column: 'event_name', op: 'eq', value: "x'); drop table x; --" }], aggregations: [{ fn: 'count', column: '*', as: 'n' }] });
  assert.equal(num(inj.rows[0].n), 0);
  // a semantic context is not a pipeline model
  await assert.rejects(() => engine.query_pipeline_model({ context_id: ctxId }), /no built pipeline model/);
});

test('a stored result is paged with query_semantic_model({ task_id }): limit/offset + has_more reconstruct it', opts, async (t) => {
  if (skip(t)) return;
  const m = await engine.query_semantic_model({ context_id: ctxId, metrics: ['mon_revenue'], group_by: [{ model: 'users', attribute: 'country' }], materialize: true });
  assert.equal(m.status, 'done', JSON.stringify(m));
  const full = await engine.query_semantic_model({ task_id: m.task_id, limit: 1000 });
  const total = full.row_count;
  assert.ok(total >= 2, `expected multiple country rows, got ${total}`);
  // page through in chunks of 2; has_more drives the loop and must terminate.
  const collected = [];
  let offset = 0; let last; let guard = 0;
  do {
    last = await engine.query_semantic_model({ task_id: m.task_id, limit: 2, offset });
    assert.equal(last.ok, true, JSON.stringify(last.error));
    collected.push(...last.rows);
    offset += 2;
  } while (last.page.has_more && guard++ < 20);
  assert.equal(last.page.has_more, false);                 // terminates on the last page
  assert.equal(collected.length, total);                   // pages cover every row exactly
  assert.equal(collected.reduce((s, x) => s + num(x.mon_revenue), 0), 85);
});

// A description is metadata, and metadata must not be able to change a number. It travels into the
// generated model's config banner (a SQL comment), so the way to prove it is inert is to build the
// SAME pipeline twice — once labelled, once not — and compare the ROWS, not the SQL text.
test('a described pipeline builds and returns exactly the rows of the same pipeline unlabelled', opts, async (t) => {
  if (skip(t)) return;
  const stages = [
    { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] },
    { stage: 'derive', name: 'price', op: 'extract', source: 'price_in_usd_of_event_data', type: 'numeric' },
    { stage: 'aggregate', group_by: ['player_id_of_internal'], measures: [{ name: 'revenue', fn: 'sum', column: 'price' }, { name: 'purchases', fn: 'count' }] },
    { stage: 'order_by', keys: [{ key: 'player_id_of_internal', direction: 'asc' }] },
  ];
  const build = async (name, description) => {
    const out = await engine.register_native_model({ name, ...(description ? { description } : {}), pipeline: { source: 'events', stages } });
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
  await engine.delete_native_model({ context_id: plain.context_id });
  await engine.delete_native_model({ context_id: labelled.context_id });
});
