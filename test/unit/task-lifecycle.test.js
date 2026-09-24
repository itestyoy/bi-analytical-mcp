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
  const created = await e.create_semantic_model(TASK);
  assert.ok(isStartedTask(created), JSON.stringify(created));
  assert.deepEqual(Object.keys(created).sort(), ['context_id', 'next', 'task_id']);
  // the declaration was taken in the call: a query validates against it right away…
  const queried = await e.query_semantic_model({ context_id: created.context_id, metrics: ['task_cnt'] });
  assert.ok(isStartedTask(queried));
  for (let i = 0; i < 10; i += 1) await tick();
  // …and runs only once the parse is done
  assert.deepEqual(runner.log, ['parse:start'], 'the query waits for the declaration to be parsed');
  assert.equal((await e.get_task_result({ task_id: queried.task_id, wait_seconds: 0 })).status, 'running');
  runner.parses.shift()();
  const done = await taskResult(e, queried.task_id);
  assert.deepEqual(runner.log, ['parse:start', 'parse:end', 'query']);
  assert.equal(done.status, 'done');
  assert.equal((await taskResult(e, created.task_id)).parse.ok, true);
});

test('a mistake is refused IN the call — no task is started for it', async () => {
  const e = engine(orderedRunner());
  const created = await e.create_semantic_model(TASK);
  await assert.rejects(() => e.query_semantic_model({ context_id: created.context_id, metrics: ['no_such_metric'] }), /unknown metric/);
  assert.equal(e.list_query_jobs().tasks.length, 1, 'only the declaration\'s task exists');
});

test('get_task_result pages only a STORED result; an unknown task is result_gone', async () => {
  const runner = orderedRunner();
  const e = engine(runner);
  const created = await e.create_semantic_model(TASK);
  runner.parses.shift()();
  const q = await e.query_semantic_model({ context_id: created.context_id, metrics: ['task_cnt'] });
  await taskResult(e, q.task_id);
  await assert.rejects(() => e.get_task_result({ task_id: q.task_id, offset: 10 }), /STORED table/);
  await assert.rejects(() => e.get_task_result({ task_id: 'ffffffffffff' }), (err) => err.code === 'result_gone');
});

test('a pipeline starts only from a finished task that stored a table', async () => {
  const runner = orderedRunner();
  const e = engine(runner);
  const start = (from_task, extra = {}) => e.build_native_model({ action: 'start', name: 'slice', from_task, ...extra });
  await assert.rejects(() => start('ffffffffffff'), (err) => err.code === 'result_gone');
  const created = await e.create_semantic_model(TASK);
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
  const step = await e.build_native_model({ action: 'add_step', draft_id: draft.draft_id, stage: { stage: 'where', conditions: [{ column: 'task_cnt', op: 'gt', value: 1 }] } });
  assert.equal(step.column_count, 1);
  // the table's owner cannot be dropped under the draft that reads it
  assert.throws(() => e.drop_context({ context_id: created.context_id }), /reads|READS|consumer|force/i);
});

test('display_result draws a result with rows or an experiment, once — and nothing else', async () => {
  const runner = orderedRunner();
  const e = engine(runner);
  const created = await e.create_semantic_model(TASK);
  runner.parses.shift()();
  await taskResult(e, created.task_id);
  await assert.rejects(() => e.display_result({ task_id: created.task_id }), /no rows to draw/);
  const plan = e.experiment({ action: 'plan', metric: 'proportion', baseline: 0.1, mde: 0.02 });
  await assert.rejects(() => e.display_result({ task_id: plan.task_id, display: { kind: 'kpi', values: [{ column: 'n_per_group' }] } }), /draws its own card/);
  const drawn = await e.display_result({ task_id: plan.task_id });
  assert.equal(drawn.drawn, true);
  assert.equal(drawn.n_per_group, plan.n_per_group);
  await assert.rejects(() => e.display_result({ task_id: plan.task_id }), /shown already/);
  // two calls at once for one task: one card
  const split = e.experiment({ action: 'check_split', groups: [{ label: 'a', n: 100 }, { label: 'b', n: 100 }] });
  const both = await Promise.allSettled([e.display_result({ task_id: split.task_id }), e.display_result({ task_id: split.task_id })]);
  assert.deepEqual(both.map((x) => x.status).sort(), ['fulfilled', 'rejected']);
});
