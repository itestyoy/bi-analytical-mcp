// THE TASK LIFECYCLE — start, read, show as three calls.
//
// A call that starts warehouse work answers with its task only; tasks on one context run in order
// (a query issued right after its task was declared runs once the declaration is parsed); a result
// is drawn once; a pipeline starts only from a finished task that stored a table. Lifecycle and
// input-validation checks with a stub runner — the numbers these tasks produce are proven against
// the warehouse in test/integration/task-results.test.js and materialize.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { isStartedTask, taskResult } from '../helpers/settle.js';

const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));

/** A runner that records the order of what it was asked to do; parse finishes when the test says. */
function orderedRunner() {
  const r = {
    log: [],
    parses: [],
    parse() { r.log.push('parse:start'); return new Promise((resolve) => { r.parses.push(() => { r.log.push('parse:end'); resolve({ ok: true }); }); }); },
    async query() { r.log.push('query'); return { ok: true, columns: [{ name: 'task_cnt' }], rows: [{ task_cnt: 3 }] }; },
    async run() { return { ok: true, stdout: '', stderr: '' }; },
    async show() { return { ok: true, columns: [{ name: 'task_cnt' }], rows: [{ task_cnt: 3 }] }; },
    async relationColumns() { return { ok: false }; },
  };
  return r;
}

const engine = (runner) => new Engine({ catalog: loadCatalog(CATALOG, {}), contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'tasks-')) }), runner });
const TASK = { name: 'task', semantic_models: [{ from: 'events', measures: [{ name: 'cnt', agg: 'count' }] }], metrics: [{ name: 'cnt', type: 'simple', measure: { name: 'cnt' } }] };
const tick = () => new Promise((r) => { setTimeout(r, 5); });

test('a call that starts work answers with its task only, and a query on the same context waits for the parse', async () => {
  const runner = orderedRunner();
  const e = engine(runner);
  const created = await e.build_semantic_model(TASK);
  assert.ok(isStartedTask(created), JSON.stringify(created));
  assert.deepEqual(Object.keys(created).sort(), ['context_id', 'next', 'read_with', 'task_id']);
  assert.equal(created.read_with, 'query_semantic_model', 'it names the tool that reads it back');
  // the declaration was taken in the call: a query validates against it right away…
  const queried = await e.query_semantic_model({ context_id: created.context_id, metrics: ['task_cnt'] });
  assert.ok(isStartedTask(queried));
  for (let i = 0; i < 10; i += 1) await tick();
  // …and runs only once the parse is done
  assert.deepEqual(runner.log, ['parse:start'], 'the query waits for the declaration to be parsed');
  assert.equal((await e.query_semantic_model({ task_id: queried.task_id, wait_seconds: 0 })).status, 'running');
  runner.parses.shift()();
  const done = await taskResult(e, queried.task_id);
  assert.deepEqual(runner.log, ['parse:start', 'parse:end', 'query']);
  assert.equal(done.status, 'done');
  assert.equal((await taskResult(e, created.task_id)).parse.ok, true);
});

test('a mistake is refused IN the call — no task is started for it', async () => {
  const e = engine(orderedRunner());
  const created = await e.build_semantic_model(TASK);
  await assert.rejects(() => e.query_semantic_model({ context_id: created.context_id, metrics: ['no_such_metric'] }), /unknown metric/);
  assert.equal(e.list_query_jobs().tasks.length, 1, 'only the declaration\'s task exists');
});

test('a query tool\'s read pages what the task holds, reads only its own side, and an unknown task is result_gone', async () => {
  const runner = orderedRunner();
  const e = engine(runner);
  const created = await e.build_semantic_model(TASK);
  runner.parses.shift()();
  const q = await e.query_semantic_model({ context_id: created.context_id, metrics: ['task_cnt'] });
  await taskResult(e, q.task_id);
  // a result held in memory pages WITHIN the rows its query returned
  const within = await e.query_semantic_model({ task_id: q.task_id, limit: 1 });
  assert.deepEqual([within.row_count, within.page.held_rows, within.page.has_more], [1, 1, false]);
  const past = await e.query_semantic_model({ task_id: q.task_id, offset: 10 });
  assert.equal(past.row_count, 0);
  await assert.rejects(() => e.query_semantic_model({ task_id: 'ffffffffffff' }), (err) => err.code === 'result_gone');
  // a semantic task is not the pipeline side's to read
  await assert.rejects(() => e.query_pipeline_model({ task_id: q.task_id }), /query_semantic_model/);
});

test('a pipeline starts only from a finished task that stored a table', async () => {
  const runner = orderedRunner();
  const e = engine(runner);
  const start = (from_task, extra = {}) => e.build_pipeline_model({ action: 'start', name: 'slice', from_task, ...extra });
  await assert.rejects(() => start('ffffffffffff'), (err) => err.code === 'result_gone');
  const created = await e.build_semantic_model(TASK);
  // still running (the parse is held)
  await assert.rejects(() => start(created.task_id), /still running/);
  runner.parses.shift()();
  await taskResult(e, created.task_id);
  // finished, but a declaration stores no table; nor does a query held in memory
  await assert.rejects(() => start(created.task_id), /no stored table/);
  const inMemory = await e.query_semantic_model({ context_id: created.context_id, metrics: ['task_cnt'] });
  await taskResult(e, inMemory.task_id);
  await assert.rejects(() => start(inMemory.task_id), /materialize:true/);
  // a stored one starts a draft that reads its table, as step 0
  const stored = await e.query_semantic_model({ context_id: created.context_id, metrics: ['task_cnt'], materialize: true });
  const done = await taskResult(e, stored.task_id);
  assert.equal(done.table, `qr_${stored.task_id}`);
  await assert.rejects(() => start(stored.task_id, { time_range: { start: '2024-01-01' } }), /time_range/);
  const draft = await start(stored.task_id, { include_columns: true });
  assert.equal(draft.reads, done.table);
  assert.deepEqual(draft.available_columns.map((c) => c.name), ['task_cnt']);
  const step = await e.build_pipeline_model({ action: 'add_step', draft_id: draft.draft_id, stage: { stage: 'where', conditions: [{ column: 'task_cnt', op: 'gt', value: 1 }] } });
  assert.equal(step.column_count, 1);
  // the table's owner cannot be dropped under the draft that reads it
  assert.throws(() => e.drop_context({ context_id: created.context_id }), /reads|READS|consumer|force/i);
});

test('display_model_result draws a model\'s rows once — and nothing else; an experiment is no task', async () => {
  const runner = orderedRunner();
  const e = engine(runner);
  const created = await e.build_semantic_model(TASK);
  runner.parses.shift()();
  await taskResult(e, created.task_id);
  await assert.rejects(() => e.display_model_result({ task_id: created.task_id }), /no rows to draw/);
  const kpi = { kind: 'kpi', values: [{ column: 'task_cnt' }] };
  const q = await e.query_semantic_model({ context_id: created.context_id, metrics: ['task_cnt'] });
  await taskResult(e, q.task_id);
  const drawn = await e.display_model_result({ task_id: q.task_id, display: kpi });
  assert.equal(drawn.drawn, true);
  await assert.rejects(() => e.display_model_result({ task_id: q.task_id, display: kpi }), /shown already/);
  // two calls at once for one task: one card
  const q2 = await e.query_semantic_model({ context_id: created.context_id, metrics: ['task_cnt'] });
  await taskResult(e, q2.task_id);
  const both = await Promise.allSettled([e.display_model_result({ task_id: q2.task_id, display: kpi }), e.display_model_result({ task_id: q2.task_id, display: kpi })]);
  assert.deepEqual(both.map((x) => x.status).sort(), ['fulfilled', 'rejected']);
  // an experiment's statistics come back with the call, as before: no task to show or read
  assert.equal(e.experiment({ action: 'plan', metric: 'proportion', baseline: 0.1, mde: 0.02 }).task_id, undefined);
});

/** A runner whose builds finish when the test says so; everything else answers at once. */
function heldBuilds() {
  const r = {
    held: [],
    async parse() { return { ok: true }; },
    run() { return new Promise((resolve) => { r.held.push(() => resolve({ ok: true, stdout: '', stderr: '' })); }); },
    async show() { return { ok: true, columns: [{ name: 'n' }], rows: [{ n: 1 }] }; },
    async query() { return { ok: true, columns: [], rows: [] }; },
    async relationColumns() { return { ok: false }; },
  };
  return r;
}
const until = async (cond) => { for (let i = 0; i < 400 && !cond(); i += 1) await tick(); };
const WHERE_EVENT = { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'level_completed' }] };

test('query_pipeline_model: the transform is checked in the call, and a query behind a build reads THAT build', async () => {
  const runner = heldBuilds();
  const e = engine(runner);
  const { draft_id } = await e.build_pipeline_model({ action: 'start', name: 'lvl', source: 'events' });
  await e.build_pipeline_model({ action: 'add_step', draft_id, stage: WHERE_EVENT });
  // nothing built and nothing building: refused
  await assert.rejects(() => e.query_pipeline_model({ context_id: draft_id }), /no built pipeline model/);
  const first = await e.build_pipeline_model({ action: 'materialize', draft_id });
  // the first build is in flight: a query on it is accepted, checked against that build's columns
  await assert.rejects(() => e.query_pipeline_model({ context_id: draft_id, transform: { group_by: ['no_such_column'] } }), (err) => err.field === 'transform' && /no_such_column/.test(err.message));
  await assert.rejects(() => e.query_pipeline_model({ context_id: draft_id, transform: { group_by: ['event_name'], order_by: [{ key: 'player_id_of_internal' }] } }), /order_by/);
  const q1 = await e.query_pipeline_model({ context_id: draft_id, transform: { group_by: ['event_name'], aggregations: [{ fn: 'count', column: '*' }], order_by: [{ key: 'count' }] } });
  assert.ok(isStartedTask(q1) && q1.read_with === 'query_pipeline_model');
  await until(() => runner.held.length);
  runner.held.shift()();
  const built1 = await taskResult(e, first.task_id);
  assert.equal((await taskResult(e, q1.task_id)).model, built1.model, 'the query read the build it was queued behind');
  // a second build starts; a query issued now reads the NEW table, not the one standing
  await e.build_pipeline_model({ action: 'add_step', draft_id, stage: { stage: 'limit', n: 5 } });
  const second = await e.build_pipeline_model({ action: 'materialize', draft_id });
  const q2 = await e.query_pipeline_model({ context_id: draft_id });
  await until(() => runner.held.length);
  runner.held.shift()();
  const built2 = await taskResult(e, second.task_id);
  assert.notEqual(built2.model, built1.model);
  assert.equal((await taskResult(e, q2.task_id)).model, built2.model);
  // a sum needs a column: refused by the schema, in the call
  await assert.rejects(() => e.query_pipeline_model({ context_id: draft_id, transform: { aggregations: [{ fn: 'sum' }] } }), /column/);
});

test('a protocol task refuses a read of the other side at once, instead of waiting out the build', async () => {
  const { runToCompletion } = await import('../../src/mcp-surface.js');
  const runner = heldBuilds();
  const e = engine(runner);
  const { draft_id } = await e.build_pipeline_model({ action: 'start', name: 'lvl', source: 'events' });
  await e.build_pipeline_model({ action: 'add_step', draft_id, stage: WHERE_EVENT });
  const build = await e.build_pipeline_model({ action: 'materialize', draft_id });
  await until(() => runner.held.length);
  const t0 = Date.now();
  const { result } = await runToCompletion(e, 'query_semantic_model', { task_id: build.task_id });
  assert.equal(result.isError, true);
  assert.match(JSON.parse(result.content[0].text).error.message, /query_pipeline_model/);
  assert.ok(Date.now() - t0 < 5000, 'answered without waiting for the build');
  assert.equal(e.jobs.get(build.task_id).status, 'running', 'and the build is still going');
  runner.held.shift()();
  await taskResult(e, build.task_id);
});

test('a renamed tool answers under its old name; a removed one says what replaced it', async () => {
  const { runTool } = await import('../../src/mcp-surface.js');
  const e = engine(orderedRunner());
  const { raw } = await runTool(e, 'build_native_model', { action: 'start', name: 'old_name', source: 'events' });
  assert.match(raw.draft_id, /^[a-z0-9]+$/, 'build_native_model still starts a draft');
  const gone = await runTool(e, 'get_task_result', { task_id: 'aabbccddeeff' });
  assert.equal(gone.result.isError, true);
  assert.match(JSON.parse(gone.result.content[0].text).error.message, /query_semantic_model.*query_pipeline_model/);
});

test('the tool that started a task is persisted with it, so its side survives a restart', async () => {
  const { JobManager } = await import('../../src/jobs.js');
  const dbPath = join(mkdtempSync(join(tmpdir(), 'jobs-')), 'jobs.sqlite');
  const a = new JobManager({ dbPath });
  const id = a.create({ tool: 'query_pipeline_model', contextId: 'c1' });
  a.ready(id);
  a.close();
  const b = new JobManager({ dbPath });
  assert.equal(b.get(id)?.tool, 'query_pipeline_model');
  b.close();
});
