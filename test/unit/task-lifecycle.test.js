// THE TASK LIFECYCLE — start, read, show as three calls.
//
// A call that starts warehouse work answers with its task only; tasks on one context run in order
// (a query issued right after its task was declared runs once the declaration is parsed); a result
// is drawn once; a pipeline starts only from a finished task that stored a table. Lifecycle and
// input-validation checks with a stub runner — the numbers these tasks produce are proven against
// the warehouse in test/integration/task-results.test.js and model-results.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { isStartedTask, taskResult, one } from '../helpers/settle.js';

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
const TASK = { name: 'task', semantic_models: [{ from: 'events', measures: [{ name: 'cnt', expr: { fn: 'count' } }] }], metrics: [{ name: 'cnt', type: 'simple', measure: 'cnt' }] };
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
  assert.equal((await one(e.query_semantic_model({ task_ids: [queried.task_id], wait_seconds: 0 }))).status, 'running');
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
  assert.equal(e._listTasks().tasks.length, 1, 'only the declaration\'s task exists');
});

test('a query tool\'s read pages what the task holds, reads only its own side, and an unknown task is result_gone', async () => {
  const runner = orderedRunner();
  const e = engine(runner);
  const created = await e.build_semantic_model(TASK);
  runner.parses.shift()();
  const q = await e.query_semantic_model({ context_id: created.context_id, metrics: ['task_cnt'] });
  await taskResult(e, q.task_id);
  // a result held in memory pages WITHIN the rows its query returned
  const within = await one(e.query_semantic_model({ task_ids: [q.task_id], limit: 1 }));
  assert.deepEqual([within.row_count, within.page.held_rows, within.page.has_more], [1, 1, false]);
  const past = await one(e.query_semantic_model({ task_ids: [q.task_id], offset: 10 }));
  assert.equal(past.row_count, 0);
  await assert.rejects(() => one(e.query_semantic_model({ task_ids: ['ffffffffffff'] })), (err) => err.code === 'result_gone');
  // a semantic task is not the pipeline side's to read
  await assert.rejects(() => one(e.query_pipeline_model({ task_ids: [q.task_id] })), /query_semantic_model/);
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
  const step = await e.build_pipeline_model({ action: 'add_steps', context_id: draft.context_id, steps: [{ stage: 'where', conditions: [{ fn: 'gt', args: [{ column: 'task_cnt' }, { value: 1 }] }] }] });
  assert.equal(step.column_count, 1);
  // the table's owner cannot be dropped under the draft that reads it
  assert.throws(() => e._dropContext({ context_id: created.context_id }), /reads|READS|consumer|force/i);
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
const WHERE_EVENT = { stage: 'where', conditions: [{ fn: 'eq', args: [{ column: 'event_name' }, { value: 'level_completed' }] }] };
/** The hints of an answer (its next, its recommendations, each step's) that send the caller to materialize. */
const asksToMaterialize = (r) => [r.next, ...(r.recommendations || []), ...(r.step_effects || []).flatMap((s) => s.recommendations || [])]
  .filter((h) => typeof h === 'string' && /\bmaterialize\b(?!\.task_id)/.test(h));

test('query_pipeline_model: the steps are checked in the call, and a query behind a build reads THAT build', async () => {
  const runner = heldBuilds();
  const e = engine(runner);
  const { context_id } = await e.build_pipeline_model({ action: 'start', name: 'lvl', source: 'events' });
  await e.build_pipeline_model({ action: 'add_steps', context_id, steps: [WHERE_EVENT] });
  // nothing built and nothing building: refused
  await assert.rejects(() => e.query_pipeline_model({ context_id }), /no built pipeline model/);
  const first = await e.build_pipeline_model({ action: 'materialize', context_id });
  // the first build is in flight: a query on it is accepted, checked against that build's columns
  const byEvent = (groupBy = ['event_name']) => ({ stage: 'aggregate', group_by: groupBy, measures: [{ name: 'count', expr: { fn: 'count' } }] });
  await assert.rejects(() => e.query_pipeline_model({ context_id, steps: [byEvent(['no_such_column'])] }), (err) => err.field === 'steps' && /^steps\[0\]: .*no_such_column/.test(err.message));
  // an order on a column the regroup did not keep is refused at the step that names it
  await assert.rejects(() => e.query_pipeline_model({ context_id, steps: [byEvent(), { stage: 'order_by', keys: [{ key: 'player_id_of_internal' }] }] }), (err) => err.field === 'steps' && /^steps\[1\]: .*player_id_of_internal/.test(err.message));
  // a stage that makes a new table is a build from the task, not a read
  await assert.rejects(() => e.query_pipeline_model({ context_id, steps: [{ stage: 'join', with: 'users', via: 'user', attrs: [{ column: 'country' }] }] }), /invalid input/);
  const q1 = await e.query_pipeline_model({ context_id, steps: [byEvent(), { stage: 'order_by', keys: [{ key: 'count' }] }] });
  assert.ok(isStartedTask(q1) && q1.read_with === 'query_pipeline_model');
  await until(() => runner.held.length);
  runner.held.shift()();
  const built1 = await taskResult(e, first.task_id);
  assert.equal((await taskResult(e, q1.task_id)).model, built1.model, 'the query read the build it was queued behind');
  // a second build starts; a query issued now reads the NEW table, not the one standing
  await e.build_pipeline_model({ action: 'add_steps', context_id, steps: [{ stage: 'limit', limit: 5 }] });
  const second = await e.build_pipeline_model({ action: 'materialize', context_id });
  const q2 = await e.query_pipeline_model({ context_id });
  await until(() => runner.held.length);
  runner.held.shift()();
  const built2 = await taskResult(e, second.task_id);
  assert.notEqual(built2.model, built1.model);
  assert.equal((await taskResult(e, q2.task_id)).model, built2.model);
  // a sum needs its argument: refused by the schema, in the call
  await assert.rejects(() => e.query_pipeline_model({ context_id, steps: [{ stage: 'aggregate', measures: [{ name: 's', expr: { fn: 'sum' } }] }] }), /invalid input.*'args'/);
  // and a read written as the earlier transform is refused with its steps
  await assert.rejects(() => e.query_pipeline_model({ context_id, transform: { group_by: ['event_name'], measures: [{ agg: 'count', name: 'count' }] } }), /invalid input.*"steps"/);
});

// A read only compiled (dry_run) is a task like the read, slotted behind the context's builds only: it
// answers the statement the read would run over the build it waits for, and the columns it answers
// with — read back as it is, paged or not (it holds no rows to page).
test('query_pipeline_model dry_run: a task that waits for the build, answering the read\'s SQL and its columns', async () => {
  const runner = heldBuilds();
  const e = engine(runner);
  const { context_id } = await e.build_pipeline_model({ action: 'start', name: 'lvl', source: 'events', steps: [WHERE_EVENT] });
  const build = await e.build_pipeline_model({ action: 'materialize', context_id });
  const byEvent = { stage: 'aggregate', group_by: ['event_name'], measures: [{ name: 'n', expr: { fn: 'count' } }] };
  // checked in the call, as the read is
  await assert.rejects(() => e.query_pipeline_model({ context_id, steps: [{ stage: 'order_by', keys: [{ key: 'nope' }] }], dry_run: true }), (err) => err.field === 'steps' && /^steps\[0\]: .*unknown column 'nope'/.test(err.message));
  const dry = await e.query_pipeline_model({ context_id, steps: [byEvent, { stage: 'order_by', keys: [{ key: 'n', direction: 'desc' }] }], limit: 3, dry_run: true });
  assert.ok(isStartedTask(dry) && dry.read_with === 'query_pipeline_model');
  await until(() => runner.held.length);
  assert.equal((await one(e.query_pipeline_model({ task_ids: [dry.task_id], wait_seconds: 0 }))).status, 'running', 'it waits for the build it reads');
  runner.held.shift()();
  const built = await taskResult(e, build.task_id);
  const out = await taskResult(e, dry.task_id);
  assert.deepEqual([out.status, out.dry_run, out.model, typeof out.sql], ['done', true, built.model, 'string']);
  assert.deepEqual(out.output_columns.map((c) => c.name), ['event_name', 'n']);
  assert.equal(out.rows, undefined, 'nothing was read');
  // a page of an answer that holds no rows is that answer
  const paged = await one(e.query_pipeline_model({ task_ids: [dry.task_id], offset: 0, limit: 5 }));
  assert.deepEqual([paged.status, paged.dry_run, paged.output_columns], ['done', true, out.output_columns]);
  // a batch member may be compiled only, beside one that reads
  const batch = await e.query_pipeline_model({ context_id, queries: [{ steps: [byEvent], dry_run: true }, { steps: [byEvent] }] });
  const [compiled, rows] = (await e.query_pipeline_model({ task_ids: batch.task_ids, wait_seconds: 5 })).results;
  assert.deepEqual([compiled.dry_run, compiled.rows, Array.isArray(rows.rows)], [true, undefined, true]);
});

// THE STEPS AFTER A METRIC QUERY are the read steps of query_pipeline_model over the result's columns as
// the caller names them, checked in the call. What MetricFlow says itself runs as `mf query`; any other
// step over the SQL it compiles — the answer is one shape either way: the caller's names, whether the
// rows are in a stated order, a sample said to be one.
/** A runner whose metric query answers in MetricFlow's names (and compiles to SQL when only explained),
 *  and whose read of SQL answers in the caller's names — the same rows whichever way a query runs. */
function tailRunner(rows) {
  const r = {
    async parse() { return { ok: true }; },
    async run() { return { ok: true, stdout: '', stderr: '' }; },
    async query(_dir, opts) {
      if (opts.explain) return { ok: true, sql: 'select 1' };
      return { ok: true, columns: [{ name: 'metric_time__day' }, { name: 'task_cnt' }], rows: rows.map((x) => ({ metric_time__day: x.metric_time_day, task_cnt: x.task_cnt })) };
    },
    async show() { return { ok: true, columns: [{ name: 'metric_time_day' }, { name: 'task_cnt' }], rows }; },
    async relationColumns() { return { ok: false }; },
  };
  return r;
}

test('the steps after a metric query are checked against the result\'s columns, in the call — a batch at the query that names one', async () => {
  const e = engine(tailRunner([]));
  const { context_id } = await e.build_semantic_model(TASK);
  const daily = { metrics: ['task_cnt'], group_by: [{ time: 'metric_time', grain: 'day' }] };
  const before = e._listTasks().tasks.length;
  for (const key of ['nonsense', 'metric_time__day', 'metric_time']) {
    await assert.rejects(() => e.query_semantic_model({ context_id, ...daily, steps: [{ stage: 'order_by', keys: [{ key }] }] }),
      (err) => err.field === 'steps' && new RegExp(`^steps\\[0\\]: .*unknown column '${key}' at this stage \\(available: metric_time_day, task_cnt\\)`).test(err.message), key);
  }
  // a column a step makes is there for the steps after it, and gone after an aggregate that drops it
  await assert.rejects(() => e.query_semantic_model({ context_id, ...daily, steps: [{ stage: 'aggregate', measures: [{ name: 'total', expr: { fn: 'sum', args: [{ column: 'task_cnt' }] } }] }, { stage: 'order_by', keys: [{ key: 'metric_time_day' }] }] }),
    (err) => err.field === 'steps' && /^steps\[1\]: .*unknown column 'metric_time_day' at this stage \(available: total\)/.test(err.message));
  await assert.rejects(() => e.query_semantic_model({ context_id, queries: [daily, { ...daily, steps: [{ stage: 'order_by', keys: [{ key: 'nonsense' }] }] }] }),
    (err) => err.field === 'queries[1].steps' && /^queries\[1\]: steps\[0\]: .*unknown column 'nonsense'/.test(err.message));
  // the earlier order_by is refused with the step it is now
  await assert.rejects(() => e.query_semantic_model({ context_id, ...daily, order_by: [{ key: 'task_cnt', direction: 'desc' }] }),
    (err) => err.message.includes(JSON.stringify({ stage: 'order_by', keys: [{ key: 'task_cnt', direction: 'desc' }] })));
  assert.equal(e._listTasks().tasks.length, before, 'no task was started for any of them');
});

test('a metric query answers in the caller\'s names whatever its steps — ordered by an order_by step, approximate after a sample', async () => {
  const rows = [{ metric_time_day: '2026-01-02', task_cnt: 7 }, { metric_time_day: '2026-01-01', task_cnt: 3 }];
  const e = engine(tailRunner(rows));
  const { context_id } = await e.build_semantic_model(TASK);
  const daily = { context_id, metrics: ['task_cnt'], group_by: [{ time: 'metric_time', grain: 'day' }] };
  const read = async (extra) => taskResult(e, (await e.query_semantic_model({ ...daily, ...extra })).task_id);
  const desc = { stage: 'order_by', keys: [{ key: 'task_cnt', direction: 'desc' }] };
  for (const [steps, ordered] of [
    [undefined, false],
    [[desc], true],
    [[{ stage: 'where', conditions: [{ fn: 'gt', args: [{ column: 'task_cnt' }, { value: 1 }] }] }, desc, { stage: 'limit', limit: 10 }], true],
    [[desc, { stage: 'where', conditions: [{ fn: 'gt', args: [{ column: 'task_cnt' }, { value: 1 }] }] }], false],
  ]) {
    const out = await read(steps ? { steps } : {});
    assert.equal(out.status, 'done', JSON.stringify(out.error || {}));
    assert.deepEqual(out.rows, rows, JSON.stringify(steps));
    assert.deepEqual(out.columns.map((c) => c.name), ['metric_time_day', 'task_cnt'], JSON.stringify(steps));
    // (a page in no stated order says so; an ordered one has nothing to warn of)
    assert.equal(out.page.ordered, ordered ? undefined : false, JSON.stringify(steps));
    assert.equal(out.sampled, undefined);
  }
  const sampled = await read({ steps: [{ stage: 'sample', share: 0.5 }] });
  assert.deepEqual([sampled.status, sampled.sampled, typeof sampled.sampling], ['done', true, 'object'], 'with the note a sampled read carries');
  // a query only compiled: the SQL after its steps, and the columns it answers with — a read of it, paged or not
  const dry = await e.query_semantic_model({ ...daily, steps: [{ stage: 'compute', name: 'per_day', expr: { fn: 'div', args: [{ column: 'task_cnt' }, { value: 2 }] } }], dry_run: true });
  const compiled = await taskResult(e, dry.task_id);
  assert.deepEqual([compiled.status, compiled.dry_run, typeof compiled.sql], ['done', true, 'string']);
  assert.deepEqual(compiled.output_columns.map((c) => c.name), ['metric_time_day', 'task_cnt', 'per_day']);
  assert.equal(compiled.output_columns[0].type, 'time', 'metric_time is a time');
  assert.equal(compiled.orderable_keys, undefined, 'output_columns says what orderable_keys did');
  const paged = await one(e.query_semantic_model({ task_ids: [dry.task_id], offset: 0, limit: 5 }));
  assert.deepEqual([paged.status, paged.output_columns], ['done', compiled.output_columns]);
  // stored, the table is the result after its steps
  const stored = await read({ steps: [desc], materialize: true });
  assert.deepEqual([stored.status, stored.table], ['done', `qr_${stored.task_id}`]);
});

// ONE FORM WHICHEVER PATH RAN IT: `mf query` answers as its CSV writes (a moment as Python prints it), the
// dbt client's show as its JSON does (the moment ISO) — the answer reads the same either way.
test('a metric query\'s values read the same whether MetricFlow or the steps\' SQL ran it', async () => {
  const iso = [{ metric_time_day: '2026-01-02T00:00:00', task_cnt: 7 }, { metric_time_day: '2026-01-01T00:00:00', task_cnt: 3 }];
  const runner = { ...tailRunner(iso), async query(_dir, opts) {
    if (opts.explain) return { ok: true, sql: 'select 1' };
    return { ok: true, columns: [{ name: 'metric_time__day' }, { name: 'task_cnt' }], rows: iso.map((x) => ({ metric_time__day: x.metric_time_day.replace('T', ' '), task_cnt: x.task_cnt })) };
  } };
  const e = engine(runner);
  const { context_id } = await e.build_semantic_model(TASK);
  const read = async (extra) => taskResult(e, (await e.query_semantic_model({ context_id, metrics: ['task_cnt'], group_by: [{ time: 'metric_time', grain: 'day' }], ...extra })).task_id);
  const byMetricFlow = await read({ steps: [{ stage: 'order_by', keys: [{ key: 'task_cnt', direction: 'desc' }] }] });
  const bySql = await read({ steps: [{ stage: 'order_by', keys: [{ key: 'task_cnt', direction: 'desc', nulls: 'first' }] }] });
  assert.deepEqual([byMetricFlow.rows, bySql.rows], [iso, iso]);
});

test('a draft starts with its first steps, and adding steps may start its build in the same call', async () => {
  const runner = heldBuilds();
  const e = engine(runner);
  const started = await e.build_pipeline_model({ action: 'start', name: 'lvl', source: 'events', steps: [WHERE_EVENT, { stage: 'limit', limit: 5 }] });
  assert.equal(e.ctxs.get(started.context_id).state.draft.stages.length, 2, 'both steps are on the draft');
  // the answer says the steps it holds: the ones added and their count, never an empty list beside them
  assert.equal(started.steps, undefined, 'no steps: [] beside the steps added');
  assert.deepEqual([started.steps_count, started.steps_added.map((s) => s.index)], [2, [1, 2]]);
  const listed = await e.build_pipeline_model({ action: 'start', name: 'lvl2', source: 'events', steps: [WHERE_EVENT], include_steps: true });
  assert.deepEqual(listed.steps.map((s) => s.index), [1], 'include_steps: the whole list');
  // a step that cannot compile leaves the draft started, with none of the batch
  await assert.rejects(() => e.build_pipeline_model({ action: 'start', name: 'bad', source: 'events', steps: [{ stage: 'where', conditions: [{ fn: 'eq', args: [{ column: 'no_such_column' }, { value: 1 }] }] }] }), (err) => /started, with no steps/.test(err.message) && err.field === 'steps[0]');
  const added = await e.build_pipeline_model({ action: 'add_steps', context_id: started.context_id, steps: [{ stage: 'limit', limit: 3 }], materialize: true });
  assert.ok(isStartedTask(added.materialize), JSON.stringify(added));
  assert.deepEqual(asksToMaterialize(added), [], 'nothing asks for the build this call started');
  await until(() => runner.held.length);
  runner.held.shift()();
  assert.equal((await taskResult(e, added.materialize.task_id)).status, 'done');
});

// A recipe's pipeline_payload is a start request as it stands: start is the default action, and a
// start that carries its steps may build them in the same call — one call where three went before.
test('a start is the default action, and a start with its steps and materialize: true builds them in the same call', async () => {
  const runner = heldBuilds();
  const e = engine(runner);
  const before = e.ctxs.list().length;
  // materialize builds the steps the start adds: with none, it is refused, and no context is made
  await assert.rejects(() => e.build_pipeline_model({ name: 'lvl', source: 'events', materialize: true }), (err) => err.field === 'materialize' && /`steps`/.test(err.message));
  assert.equal(e.ctxs.list().length, before, 'a refused start makes no context');
  const started = await e.build_pipeline_model({ name: 'lvl', source: 'events', steps: [WHERE_EVENT, { stage: 'limit', limit: 5 }], materialize: true });
  assert.equal(started.action, 'start');
  assert.equal(e.ctxs.get(started.context_id).state.draft.stages.length, 2, 'both steps are on the draft');
  assert.ok(isStartedTask(started.materialize), JSON.stringify(started));
  assert.equal(started.materialize.context_id, started.context_id, 'the build is the draft\'s, in its context');
  // the build is started: the answer sends the caller to read it, never to a second materialize
  assert.deepEqual(asksToMaterialize(started), [], 'nothing asks for the build this call started');
  assert.match(started.next, new RegExp(started.materialize.task_id), 'next reads the started build');
  await until(() => runner.held.length);
  runner.held.shift()();
  assert.equal((await taskResult(e, started.materialize.task_id)).status, 'done');
});

test('the context a draft is in is context_id on every action; draft_id is refused with that name', async () => {
  const e = engine(heldBuilds());
  const { context_id } = await e.build_pipeline_model({ name: 'lvl', source: 'events', steps: [WHERE_EVENT] });
  await assert.rejects(() => e.build_pipeline_model({ action: 'add_steps', draft_id: context_id, steps: [{ stage: 'limit', limit: 3 }] }), /'draft_id' — here that field is called 'context_id'/);
  assert.equal(e.ctxs.get(context_id).state.draft.stages.length, 1, 'the refused call added nothing');
  const fork = await e.build_pipeline_model({ action: 'fork', context_id, name: 'lvl_variant' });
  assert.deepEqual([fork.forked_from, typeof fork.context_id], [context_id, 'string']);
  assert.notEqual(fork.context_id, context_id, 'a fork is a context of its own');
});

test('add_steps with materialize while a build runs: the steps are added, and the build that could not start says why', async () => {
  const runner = heldBuilds();
  const e = engine(runner);
  const { context_id } = await e.build_pipeline_model({ action: 'start', name: 'lvl', source: 'events', steps: [WHERE_EVENT] });
  const first = await e.build_pipeline_model({ action: 'materialize', context_id });
  await until(() => runner.held.length);
  const added = await e.build_pipeline_model({ action: 'add_steps', context_id, steps: [{ stage: 'limit', limit: 3 }], materialize: true });
  // answered, not refused: the step is on the draft (once), and the answer says so beside the build's refusal
  assert.equal(e.ctxs.get(context_id).state.draft.stages.length, 2);
  assert.deepEqual([added.steps_added.length, added.steps_count], [1, 2]);
  assert.equal(added.materialize.ok, false);
  assert.equal(added.materialize.error.stage, 'validate');
  // the build in flight computes fewer steps than the draft holds: not "the same pipeline", but build again once it ends
  assert.match(added.materialize.error.message, /still running/);
  assert.match(added.materialize.error.message, new RegExp(first.task_id));
  assert.doesNotMatch(added.materialize.error.message, /SAME pipeline/);
  assert.match(added.next, /did not start/);
  // the call succeeded, its build did not: the error log keeps it as it keeps a refused call
  const [kept] = e.explore_errors({ tool: 'build_pipeline_model' }).errors;
  assert.deepEqual([kept?.field, kept?.stage, kept?.context_id], ['materialize', 'validate', context_id]);
  assert.equal(runner.held.length, 1, 'no second build started');
  // once it ends, the build of the grown draft starts
  runner.held.shift()();
  assert.equal((await taskResult(e, first.task_id)).status, 'done');
  const second = await e.build_pipeline_model({ action: 'materialize', context_id });
  assert.ok(isStartedTask(second));
  await until(() => runner.held.length);
  runner.held.shift()();
  assert.equal((await taskResult(e, second.task_id)).status, 'done');
});

test('a protocol task refuses a read of the other side at once, instead of waiting out the build', async () => {
  const { runToCompletion } = await import('../../src/mcp-surface.js');
  const runner = heldBuilds();
  const e = engine(runner);
  const { context_id } = await e.build_pipeline_model({ action: 'start', name: 'lvl', source: 'events' });
  await e.build_pipeline_model({ action: 'add_steps', context_id, steps: [WHERE_EVENT] });
  const build = await e.build_pipeline_model({ action: 'materialize', context_id });
  await until(() => runner.held.length);
  const t0 = Date.now();
  const { result } = await runToCompletion(e, 'query_semantic_model', { request: { task_ids: [build.task_id] } });
  assert.equal(result.isError, true);
  assert.match(JSON.parse(result.content[0].text).error.message, /query_pipeline_model/);
  assert.ok(Date.now() - t0 < 5000, 'answered without waiting for the build');
  assert.equal(e.jobs.get(build.task_id).status, 'running', 'and the build is still going');
  runner.held.shift()();
  await taskResult(e, build.task_id);
});

test('a name that is not a tool is refused as unknown — no old name dispatches', async () => {
  const { runTool } = await import('../../src/mcp-surface.js');
  const e = engine(orderedRunner());
  for (const name of ['build_native_model', 'get_task_result']) {
    const r = await runTool(e, name, { request: { task_id: 'aabbccddeeff' } });
    assert.equal(r.result.isError, true);
    assert.equal(r.unknown, true, name);
  }
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

// A STORED RESULT IS PAGED BY THE WAREHOUSE, IN ONE PAGE SHAPE: a page is the rows the read of it
// returns — a deep page never pulls the rows before it — one that starts past the end counts the
// table's rows, and every page carries the same of its answer wherever its rows come from (the rows the
// task holds, or its table): the build's details with the first page, where its rows come from on each.
test('a stored result is paged by the warehouse, each page in one shape, the build\'s details with the first', async () => {
  const ids = (from, n) => Array.from({ length: n }, (_, i) => ({ event_id: from + i }));
  let replies = [];
  const runner = { ...heldBuilds(), async run() { return { ok: true, stdout: '', stderr: '' }; }, async show() { return replies.length > 1 ? replies.shift() : replies[0]; } };
  const e = engine(runner);
  // the build's answer holds the table's first 50 rows, and more follow
  replies = [{ ok: true, columns: [{ name: 'event_id' }], rows: ids(0, 51) }];
  const build = await e.build_pipeline_model({ action: 'start', name: 'events_page', source: 'events', steps: [WHERE_EVENT], materialize: true });
  const id = build.materialize.task_id;
  const first = await taskResult(e, id);
  assert.deepEqual([first.status, first.rows.length, first.page.has_more], ['done', 50, true]);
  const details = ['model_sql', 'assumptions', 'output_columns', 'build'];
  for (const k of details) assert.ok(first[k] !== undefined, `the first page says the build's ${k}`);
  // a page within the rows held and a page read from the table: the same shape, with where the rows come from
  const held = await one(e.query_pipeline_model({ task_ids: [id], offset: 10, limit: 5 }));
  replies = [{ ok: true, columns: [{ name: 'event_id' }], rows: ids(45, 11) }];
  const read = await one(e.query_pipeline_model({ task_ids: [id], offset: 45, limit: 10 }));
  assert.deepEqual(held.rows, ids(10, 5));
  assert.deepEqual(read.rows, ids(45, 10));
  assert.deepEqual(Object.keys(held).sort(), Object.keys(read).sort());
  for (const page of [held, read]) {
    for (const k of details) assert.equal(page[k], undefined, `${k} is said once, with the first page`);
    assert.deepEqual([page.model, page.provenance], [first.model, first.provenance]);
  }
  // a deep page is the rows its read returns, the one past them telling that more follow
  replies = [{ ok: true, columns: [{ name: 'event_id' }], rows: ids(100000, 3) }];
  const deep = await one(e.query_pipeline_model({ task_ids: [id], offset: 100000, limit: 2 }));
  assert.deepEqual([deep.rows, deep.page.has_more, deep.page.next_offset], [ids(100000, 2), true, 100002]);
  // a page that starts past the last row holds none, and counts the rows there are
  replies = [{ ok: true, columns: [{ name: 'event_id' }], rows: [] }, { ok: true, columns: [{ name: 'n' }], rows: [{ n: 1234 }] }];
  const past = await one(e.query_pipeline_model({ task_ids: [id], offset: 5000 }));
  assert.deepEqual([past.rows, past.page.has_more, past.page.total_rows], [[], false, 1234]);
});

test('a drawn pivot keeps opening after a restart, and whatever envelope the host puts on its read', async () => {
  const { runTool } = await import('../../src/mcp-surface.js');
  const root = mkdtempSync(join(tmpdir(), 'drawn-'));
  const make = (runner) => new Engine({ catalog: loadCatalog(CATALOG, {}), contextManager: new ContextManager({ workspaceRoot: root, registryPath: join(root, 'registry.json') }), runner, dbPath: join(root, 'mcp.sqlite') });
  const rows = { ok: true, columns: [{ name: 'event_name' }, { name: 'n' }], rows: [{ event_name: 'level_completed', n: 3 }] };
  const runner = { ...heldBuilds(), async run() { return { ok: true, stdout: '', stderr: '' }; }, async show() { return rows; } };
  const e1 = make(runner);
  const { context_id } = await e1.build_pipeline_model({ action: 'start', name: 'lvl', source: 'events' });
  await e1.build_pipeline_model({ action: 'add_steps', context_id, steps: [{ stage: 'aggregate', group_by: ['event_name'], measures: [{ name: 'n', expr: { fn: 'count' } }] }] });
  const build = await e1.build_pipeline_model({ action: 'materialize', context_id });
  await taskResult(e1, build.task_id);
  const display = { kind: 'pivot', levels: [{ column: 'event_name' }], values: [{ column: 'n' }] };
  assert.equal((await e1.display_model_result({ task_id: build.task_id, display })).drawn, true);
  e1.close();
  // the server restarts; the card is still open in the conversation
  const e2 = make(runner);
  const level = await e2.drill_result({ task_id: build.task_id, path: [] });
  assert.notEqual(level.ok, false, JSON.stringify(level.error));
  await assert.rejects(() => e2.display_model_result({ task_id: build.task_id, display }), /shown already/, 'and it is still drawn once');
  // a host proxying the card's read without the Apps envelope is still served (the proof is the drawn task)
  const proxied = await runTool(e2, 'drill_result', { request: { task_id: build.task_id, path: [] } }, { renders: false });
  assert.equal(proxied.result.isError, undefined, proxied.result.content[0].text);
  // …while display_model_result itself is still refused to such a client
  assert.equal((await runTool(e2, 'display_model_result', { request: { task_id: build.task_id } }, { renders: false })).result.isError, true);
  e2.close();
});

// A BATCH — queries: [...] starts up to five queries on one context in one call; { task_ids } reads
// them back together.

/** A runner whose metric queries are held until the test releases them — to see what runs at once. */
function heldQueries() {
  const r = {
    log: [], held: [],
    async parse() { return { ok: true }; },
    query(_dir, opts) {
      r.log.push(`start:${opts.metrics.join(',')}`);
      return new Promise((resolve) => { r.held.push(() => { r.log.push(`end:${opts.metrics.join(',')}`); resolve({ ok: true, columns: [{ name: opts.metrics[0] }], rows: [{ [opts.metrics[0]]: 1 }] }); }); });
    },
    async run() { return { ok: true, stdout: '', stderr: '' }; },
    async show() { return { ok: true, columns: [], rows: [] }; },
    async relationColumns() { return { ok: false }; },
  };
  return r;
}
const TWO = { ...TASK, metrics: [{ name: 'cnt', type: 'simple', measure: 'cnt' }, { name: 'cnt2', type: 'simple', measure: 'cnt' }] };

test('a batch answers with its task_ids only; its members run side by side, and a query issued after it waits for all of them', async () => {
  const runner = heldQueries();
  const e = engine(runner);
  const created = await e.build_semantic_model(TWO);
  const batch = await e.query_semantic_model({ context_id: created.context_id, queries: [{ metrics: ['task_cnt'] }, { metrics: ['task_cnt2'] }] });
  assert.deepEqual(Object.keys(batch).sort(), ['context_id', 'next', 'read_with', 'task_ids']);
  assert.equal(batch.read_with, 'query_semantic_model');
  assert.equal(new Set(batch.task_ids).size, 2, 'one task per query');
  const later = await e.query_semantic_model({ context_id: created.context_id, metrics: ['task_cnt'] });
  await until(() => runner.held.length === 2);
  for (let i = 0; i < 10; i += 1) await tick();
  // both members started before either finished; the later query has not started
  assert.deepEqual(runner.log.slice().sort(), ['start:task_cnt', 'start:task_cnt2']);
  const peek = await e.query_semantic_model({ task_ids: batch.task_ids, wait_seconds: 0 });
  assert.deepEqual([peek.status, peek.results.map((r) => r.status)], ['running', ['running', 'running']]);
  runner.held.shift()();
  await until(() => batch.task_ids.some((id) => e.jobs.get(id).status === 'ready'));
  const half = await e.query_semantic_model({ task_ids: batch.task_ids, wait_seconds: 0 });
  assert.equal(half.status, 'running');
  assert.equal(half.results.filter((r) => r.status === 'done').length, 1);
  assert.match(half.next, new RegExp(half.results.find((r) => r.status === 'running').task_id), 'next names only what still runs');
  assert.equal(runner.log.filter((l) => l.startsWith('start:')).length, 2, 'the later query still waits for the whole batch');
  runner.held.shift()();
  await until(() => runner.held.length === 1);
  runner.held.shift()();
  const done = await e.query_semantic_model({ task_ids: batch.task_ids });
  assert.equal(done.status, 'done');
  assert.deepEqual(done.results.map((r) => r.task_id), batch.task_ids, 'in the order the batch returned');
  assert.equal((await taskResult(e, later.task_id)).status, 'done');
});

test('one mistake refuses the whole batch, naming the query — and nothing in it is started', async () => {
  const e = engine(orderedRunner());
  const created = await e.build_semantic_model(TASK);
  const before = e._listTasks().tasks.length;
  await assert.rejects(
    () => e.query_semantic_model({ context_id: created.context_id, queries: [{ metrics: ['task_cnt'] }, { metrics: ['no_such_metric'] }] }),
    (err) => err.field.startsWith('queries[1]') && /queries\[1\]: unknown metric/.test(err.message),
  );
  assert.equal(e._listTasks().tasks.length, before, 'no task was started for the batch');
});

test('a batch takes any number of queries, and each mode takes only its own fields', async () => {
  const e = engine(orderedRunner());
  const created = await e.build_semantic_model(TASK);
  const ctx = created.context_id;
  const q = { metrics: ['task_cnt'] };
  const many = await e.query_semantic_model({ context_id: ctx, queries: Array.from({ length: 12 }, () => q) });
  assert.equal(new Set(many.task_ids).size, 12, 'one task per query, however many');
  await assert.rejects(() => e.query_semantic_model({ context_id: ctx, queries: [q], metrics: ['task_cnt'] }), 'a query field beside queries');
  await assert.rejects(() => e.query_semantic_model({ queries: [q] }), 'a batch names its context');
  // a read pages each stored result: offset/limit are a read's own; a cancel takes neither
  await assert.rejects(() => e.query_semantic_model({ task_ids: [created.task_id], cancel: true, offset: 1 }), 'a cancel does not page');
  await assert.rejects(() => e.query_semantic_model({ task_ids: [created.task_id, created.task_id] }), 'the same task twice');
  await assert.rejects(() => e.query_pipeline_model({ context_id: ctx, queries: [{ metrics: ['task_cnt'] }] }), 'a pipeline query has no metrics');
  // a task of the other side is refused before any wait
  await assert.rejects(() => e.query_pipeline_model({ task_ids: [created.task_id] }), /query_semantic_model/);
});

test('a protocol task follows a batch read until every member is done', async () => {
  const { runToCompletion } = await import('../../src/mcp-surface.js');
  const runner = heldQueries();
  const e = engine(runner);
  const created = await e.build_semantic_model(TWO);
  const batch = await e.query_semantic_model({ context_id: created.context_id, queries: [{ metrics: ['task_cnt'] }, { metrics: ['task_cnt2'] }] });
  await until(() => runner.held.length === 2);
  const followed = runToCompletion(e, 'query_semantic_model', { request: { task_ids: batch.task_ids } });
  runner.held.shift()();
  await tick();
  runner.held.shift()();
  const { raw } = await followed;
  assert.equal(raw.status, 'done');
  assert.deepEqual(raw.results.map((r) => r.status), ['done', 'done']);
});

test('run as a batch member, a dbt command writes to a target directory of its own, seeded with the parse cache, and removed after', async () => {
  const { chmodSync, writeFileSync, mkdirSync, existsSync, readdirSync } = await import('node:fs');
  const { createDbt } = await import('../../src/dbt/index.js');
  const { isolatedTarget } = await import('../../src/request-context.js');
  const dir = mkdtempSync(join(tmpdir(), 'iso-'));
  const project = join(dir, 'project');
  mkdirSync(join(project, 'target'), { recursive: true });
  writeFileSync(join(project, 'target', 'partial_parse.msgpack'), 'cache');
  // a stand-in dbt: reports the target it was given and whether the parse cache is there
  const bin = join(dir, 'dbt');
  writeFileSync(bin, '#!/bin/sh\nT="${DBT_TARGET_PATH:-target}"\nC=no; [ -f "$T/partial_parse.msgpack" ] && C=yes\necho "{\\"show\\": [{\\"target\\": \\"$T\\", \\"cache\\": \\"$C\\"}]}"\n');
  chmodSync(bin, 0o755);
  const runner = createDbt({ version: 1, dbtBin: bin });
  const plain = await runner.show(project, 'select 1');
  assert.equal(plain.rows[0].target, 'target', 'alone, a command uses the context\'s own target/');
  const iso = await isolatedTarget(() => runner.show(project, 'select 1'));
  assert.notEqual(iso.rows[0].target, 'target');
  assert.equal(iso.rows[0].cache, 'yes', 'seeded with the context\'s partial-parse cache');
  assert.equal(existsSync(iso.rows[0].target), false, 'and removed after');
  assert.deepEqual(readdirSync(join(project, 'target')), ['partial_parse.msgpack'], 'the context\'s own target/ is untouched');
});

// CANCEL — { task_id | task_ids, cancel: true } on the query tool of the task's side.

test('a running query is cancelled at once: its process is stopped, a read says cancelled, and the queue goes on', async () => {
  const runner = heldQueries();
  const signals = [];
  const { currentSignal } = await import('../../src/request-context.js');
  const q0 = runner.query;
  runner.query = (dir, opts) => { signals.push(currentSignal()); return q0(dir, opts); };
  const e = engine(runner);
  const created = await e.build_semantic_model(TWO);
  const first = await e.query_semantic_model({ context_id: created.context_id, metrics: ['task_cnt'] });
  const second = await e.query_semantic_model({ context_id: created.context_id, metrics: ['task_cnt2'] });
  await until(() => runner.held.length === 1);
  const out = await one(e.query_semantic_model({ task_ids: [first.task_id], cancel: true }));
  assert.deepEqual([out.cancelled, out.status], [true, 'cancelled']);
  assert.equal(signals[0].aborted, true, 'the process the task started is told to stop');
  const read = await one(e.query_semantic_model({ task_ids: [first.task_id], wait_seconds: 5 }));
  assert.deepEqual([read.status, read.error.code], ['cancelled', 'cancelled']);
  // the held process ends (as a killed one would); the next task runs, and the cancelled one stays cancelled
  runner.held.shift()();
  await until(() => runner.held.length === 1);
  runner.held.shift()();
  assert.equal((await taskResult(e, second.task_id)).status, 'done');
  assert.equal((await one(e.query_semantic_model({ task_ids: [first.task_id] }))).status, 'cancelled');
  // a finished task is left as it is
  const again = await one(e.query_semantic_model({ task_ids: [second.task_id], cancel: true }));
  assert.deepEqual([again.cancelled, again.status], [false, 'done']);
});

test('a queued task that is cancelled never starts a process; a batch is cancelled by its task_ids', async () => {
  const runner = heldQueries();
  const e = engine(runner);
  const created = await e.build_semantic_model(TWO);
  const first = await e.query_semantic_model({ context_id: created.context_id, metrics: ['task_cnt'] });
  const batch = await e.query_semantic_model({ context_id: created.context_id, queries: [{ metrics: ['task_cnt'] }, { metrics: ['task_cnt2'] }] });
  await until(() => runner.held.length === 1);
  const out = await e.query_semantic_model({ task_ids: batch.task_ids, cancel: true });
  assert.deepEqual(out.results.map((r) => r.status), ['cancelled', 'cancelled']);
  runner.held.shift()();
  assert.equal((await taskResult(e, first.task_id)).status, 'done');
  for (let i = 0; i < 20; i += 1) await tick();
  assert.equal(runner.log.filter((l) => l.startsWith('start:')).length, 1, 'the cancelled batch never reached the warehouse');
  // cancel is refused beside fields it does not take, and for a task of the other side
  await assert.rejects(() => one(e.query_semantic_model({ task_ids: [first.task_id], cancel: true, wait_seconds: 1 })));
  await assert.rejects(() => e.query_semantic_model({ context_id: created.context_id, cancel: true }));
  await assert.rejects(() => one(e.query_pipeline_model({ task_ids: [first.task_id], cancel: true })), /query_semantic_model/);
});

test('a cancel under a protocol task is answered at once, not after the task', async () => {
  const { runToCompletion } = await import('../../src/mcp-surface.js');
  const runner = heldQueries();
  const e = engine(runner);
  const created = await e.build_semantic_model(TWO);
  const q = await e.query_semantic_model({ context_id: created.context_id, metrics: ['task_cnt'] });
  await until(() => runner.held.length === 1);
  const t0 = Date.now();
  const { raw } = await runToCompletion(e, 'query_semantic_model', { request: { task_ids: [q.task_id], cancel: true } });
  assert.equal(raw.results[0].status, 'cancelled');
  assert.ok(Date.now() - t0 < 2000);
  runner.held.shift()();
});
