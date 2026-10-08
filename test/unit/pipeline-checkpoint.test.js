import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { openStore } from '../../src/store.js';
import { settle, taskResult } from '../helpers/settle.js';

// Allowed non-data tests: a CHECKPOINT's invalidation is draft STATE (positional — we own the
// edit sequence), stage availability is an input-validation guard, and the file/reference
// bookkeeping is context LIFECYCLE. No warehouse is wired here and nothing is executed; the
// NUMBERS a continued pipeline returns are proven in test/integration/pipeline-checkpoint.test.js.
const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));

function engine() {
  const catalog = loadCatalog(CATALOG, {});
  return settle(new Engine({ catalog, contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'cp-')) }) }));
}

const draftOf = (e, id) => e.ctxs.get(id).state.draft;
const agg = (name) => ({ stage: 'aggregate', group_by: ['player_id_of_internal'], measures: [{ name, agg: 'count' }] });
const keepEvents = (value) => ({ stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value }] });
const funnel = {
  stage: 'match_recognize',
  partition_by: ['player_id_of_internal'],
  steps: [{ name: 'a', event_name: ['level_started'] }, { name: 'b', event_name: ['level_completed'] }],
};

test('materialize keeps the draft and records the built table as a checkpoint; the next step reads it', async () => {
  const e = engine();
  const { context_id } = await e.build_pipeline_model({ action: 'start', name: 'seg', source: 'events' });
  await e.build_pipeline_model({ action: 'add_steps', context_id, stages: [agg('events_seen')] });
  const built = await e.build_pipeline_model({ action: 'materialize', context_id });
  assert.equal(built.checkpoint.at, 1);
  assert.equal(built.checkpoint.model, built.model);
  assert.equal(built.checkpoint.carries_source, undefined, 'an aggregate does not carry the source columns');
  const draft = draftOf(e, context_id);
  assert.ok(draft, 'the draft survives materialize');
  assert.equal(draft.checkpoints.length, 1);
  // The next step is validated against the CHECKPOINT's columns and reported as reading it.
  const next = await e.build_pipeline_model({ action: 'add_steps', context_id, stages: [{ stage: 'where', conditions: [{ column: 'events_seen', op: 'gte', value: 2 }] }] });
  assert.deepEqual(next.from_checkpoint, { at: 1, model: built.model, built_at: draft.checkpoints[0].built_at });
  assert.equal(next.steps_recomputed, 1, 'only the new step would be recomputed');
  // A second materialize builds under its OWN name, so it never overwrites the table it reads.
  const again = await e.build_pipeline_model({ action: 'materialize', context_id });
  assert.notEqual(again.model, built.model);
  assert.equal(again.from_checkpoint.model, built.model);
  assert.equal(again.steps_recomputed, 1);
  assert.deepEqual(draftOf(e, context_id).checkpoints.map((c) => c.at), [1, 2]);
  // Nothing left after the last checkpoint → nothing to build (not a silent copy of the table).
  await assert.rejects(() => e.build_pipeline_model({ action: 'materialize', context_id }), /nothing to build/);
});

test('invalidation is positional: an edit retires the checkpoints whose prefix contains that step', async () => {
  const e = engine();
  const { context_id } = await e.build_pipeline_model({ action: 'start', name: 'seg', source: 'events' });
  await e.build_pipeline_model({ action: 'add_steps', context_id, stages: [agg('events_seen')] });
  await e.build_pipeline_model({ action: 'add_steps', context_id, stages: [{ stage: 'where', conditions: [{ column: 'events_seen', op: 'gte', value: 2 }] }] });
  const c1 = await e.build_pipeline_model({ action: 'materialize', context_id }); // at: 2
  await e.build_pipeline_model({ action: 'add_steps', context_id, stages: [{ stage: 'compute', name: 'twice', expr: { fn: 'mul', args: [{ column: 'events_seen' }, { value: 2 }] } }] });
  await e.build_pipeline_model({ action: 'add_steps', context_id, stages: [{ stage: 'order_by', keys: [{ key: 'twice', direction: 'desc' }] }] });
  const c2 = await e.build_pipeline_model({ action: 'materialize', context_id }); // at: 4
  assert.deepEqual(draftOf(e, context_id).checkpoints.map((c) => c.at), [2, 4]);

  // Editing step 3 retires ONLY the checkpoint that baked it (at: 4); the one at 2 lives.
  const edit = await e.build_pipeline_model({ action: 'edit_step', context_id, index: 3, stage: { stage: 'compute', name: 'twice', expr: { fn: 'mul', args: [{ column: 'events_seen' }, { value: 3 }] } } });
  assert.deepEqual(edit.checkpoints_dropped.map((d) => d.at), [4]);
  assert.deepEqual(draftOf(e, context_id).checkpoints.map((c) => c.at), [2]);
  assert.deepEqual(edit.from_checkpoint.model, c1.model);
  // The live prefix keeps its files, and so does the retired one WHILE it is the context's
  // registered result: `ctx.state.model` still advertises that table and get_query_result reads it
  // through a ref, which needs the definition.
  assert.ok(e.ctxs.hasPipelineModel(context_id, c1.model), 'live checkpoint model kept');
  assert.equal(e.ctxs.get(context_id).state.model, c2.model);
  assert.ok(e.ctxs.hasPipelineModel(context_id, c2.model), 'the built result stays readable after the edit');

  // Editing step 1 is below the surviving checkpoint → it goes too, and the rebuild is full.
  const deep = await e.build_pipeline_model({ action: 'edit_step', context_id, index: 1, stage: agg('events_seen') });
  assert.deepEqual(deep.checkpoints_dropped.map((d) => d.at), [2]);
  assert.equal(deep.from_checkpoint, undefined);
  assert.deepEqual(draftOf(e, context_id).checkpoints, []);
  // …and THAT one is not the registered result — but the registered result was built ON it (it reads
  // c1 through a ref), so its definition stays: without it the registered model has a ref nothing
  // defines, and dbt compiles every model of the project before any build runs.
  assert.ok(e.ctxs.hasPipelineModel(context_id, c1.model), 'a retired prefix the registered result reads is kept');
  assert.ok(e.ctxs.hasPipelineModel(context_id, c2.model), 'the registered result is untouched');
  assert.deepEqual(e.ctxs.pruneDanglingModels(context_id), [], 'and nothing in the context dangles');
});

test('truncate retires the checkpoints past the kept prefix; add_steps never retires one', async () => {
  const e = engine();
  const { context_id } = await e.build_pipeline_model({ action: 'start', name: 'seg', source: 'events' });
  await e.build_pipeline_model({ action: 'add_steps', context_id, stages: [agg('events_seen')] });
  await e.build_pipeline_model({ action: 'materialize', context_id }); // at: 1
  await e.build_pipeline_model({ action: 'add_steps', context_id, stages: [{ stage: 'where', conditions: [{ column: 'events_seen', op: 'gte', value: 2 }] }] });
  await e.build_pipeline_model({ action: 'materialize', context_id }); // at: 2
  const added = await e.build_pipeline_model({ action: 'add_steps', context_id, stages: [{ stage: 'project', columns: ['player_id_of_internal'] }] });
  assert.equal(added.checkpoints_dropped, undefined, 'appending never invalidates a prefix');
  const tr = await e.build_pipeline_model({ action: 'truncate', context_id, after: 1 });
  assert.deepEqual(tr.checkpoints_dropped.map((d) => d.at), [2]);
  assert.deepEqual(draftOf(e, context_id).checkpoints.map((c) => c.at), [1]);
});

test('a stage needing the source columns is refused after a checkpoint that dropped them, accepted after one that kept them', async () => {
  const e = engine();
  // (a) checkpoint after an aggregate: one row per player, no event columns left.
  const a = await e.build_pipeline_model({ action: 'start', name: 'seg', source: 'events' });
  await e.build_pipeline_model({ action: 'add_steps', context_id: a.context_id, stages: [agg('events_seen')] });
  await e.build_pipeline_model({ action: 'materialize', context_id: a.context_id });
  await assert.rejects(
    () => e.build_pipeline_model({ action: 'add_steps', context_id: a.context_id, stages: [funnel] }),
    /no longer that source's events/,
  );
  // a payload read is refused for the same reason — the column it reads is not there.
  await assert.rejects(
    () => e.build_pipeline_model({ action: 'add_steps', context_id: a.context_id, stages: [{ stage: 'compute', name: 'lvl', expr: { fn: 'event_property', property: 'level_id_of_event_data' } }] }),
    /unknown column/,
  );

  // (b) checkpoint where the rows are still events (a where) → the funnel is legal on top of it.
  const b = await e.build_pipeline_model({ action: 'start', name: 'funnel_on_slice', source: 'events' });
  await e.build_pipeline_model({ action: 'add_steps', context_id: b.context_id, stages: [keepEvents('level_started')] });
  const built = await e.build_pipeline_model({ action: 'materialize', context_id: b.context_id });
  assert.equal(built.checkpoint.carries_source, 'events');
  const ok = await e.build_pipeline_model({ action: 'add_steps', context_id: b.context_id, stages: [funnel], include_columns: true });
  assert.equal(ok.from_checkpoint.at, 1);
  assert.ok(ok.available_columns.some((c) => c.name === 'reached_a'), 'funnel built on top of the materialized slice');
});

test('fork inherits a checkpoint it keeps, copies its definition, and the owner cannot be dropped under it', async () => {
  const e = engine();
  const { context_id } = await e.build_pipeline_model({ action: 'start', name: 'seg', source: 'events' });
  await e.build_pipeline_model({ action: 'add_steps', context_id, stages: [agg('events_seen')] });
  const c1 = await e.build_pipeline_model({ action: 'materialize', context_id }); // at: 1
  await e.build_pipeline_model({ action: 'add_steps', context_id, stages: [{ stage: 'where', conditions: [{ column: 'events_seen', op: 'gte', value: 5 }] }] });
  const c2 = await e.build_pipeline_model({ action: 'materialize', context_id }); // at: 2

  const fork = await e.build_pipeline_model({ action: 'fork', context_id, after: 1, name: 'seg_alt' });
  assert.deepEqual(fork.inherited_checkpoints, [{ at: 1, model: c1.model, owner: context_id }]);
  assert.ok(e.ctxs.hasPipelineModel(fork.context_id, c1.model), "the parent's model is readable in the fork (ref resolves)");
  assert.ok(!e.ctxs.hasPipelineModel(fork.context_id, c2.model), 'a checkpoint past `after` is not inherited');

  // The fork continues on top of the INHERITED table — only its own step is computed.
  const step = await e.build_pipeline_model({ action: 'add_steps', context_id: fork.context_id, stages: [{ stage: 'where', conditions: [{ column: 'events_seen', op: 'lt', value: 5 }] }] });
  assert.equal(step.from_checkpoint.model, c1.model);
  assert.equal(step.steps_recomputed, 1);

  // Dropping the owner would take that table with it → refused, naming the consumer.
  await assert.rejects(() => e.delete_context({ context_id }), new RegExp(`${fork.context_id}.*${c1.model}`));
  assert.ok(e.ctxs.has(context_id), 'nothing was dropped');
  // Forced: the fork's inherited checkpoint is retired, so it recomputes from the source.
  assert.deepEqual(await e.delete_context({ context_id, force: true }), { removed: true });
  assert.deepEqual(draftOf(e, fork.context_id).checkpoints, []);
});

test('a checkpoint is retired when the value index moved on, or its model is gone', async () => {
  const e = engine();
  const { context_id } = await e.build_pipeline_model({ action: 'start', name: 'seg', source: 'events' });
  await e.build_pipeline_model({ action: 'add_steps', context_id, stages: [agg('events_seen')] });
  await e.build_pipeline_model({ action: 'materialize', context_id });
  assert.equal(draftOf(e, context_id).checkpoints.length, 1);
  // A completed index scan means the source data may have moved — the prefix is no longer trusted.
  draftOf(e, context_id).checkpoints[0].index_run_id = 'a-previous-scan';
  const afterScan = await e.build_pipeline_model({ action: 'add_steps', context_id, stages: [{ stage: 'project', columns: ['player_id_of_internal'] }] });
  assert.match(afterScan.checkpoints_dropped[0].reason, /value index was refreshed/);
  assert.deepEqual(draftOf(e, context_id).checkpoints, []);

  // And when the model itself is deleted out from under the draft.
  const second = await e.build_pipeline_model({ action: 'materialize', context_id });
  e.ctxs.removePipelineFiles(context_id, second.model);
  const afterDelete = await e.build_pipeline_model({ action: 'add_steps', context_id, stages: [{ stage: 'project', columns: ['player_id_of_internal'] }] });
  assert.match(afterDelete.checkpoints_dropped[0].reason, /no longer exists/);
});

test('lifecycle: cleanup takes a pipeline\'s later builds and leaves an inherited definition alone', async () => {
  const e = engine();
  const ctxs = e.ctxs;
  const a = ctxs.create(); const b = ctxs.create();
  for (const f of ['pipe_x_a.sql', 'pipe_x_a_s1.sql', 'pipe_x_a_c2.sql', 'pipe_x_a_c2_s1.py', 'pipe_x_a_c2_s1.yml', 'pipe_other_a.sql']) {
    writeFileSync(join(ctxs.generatedDir(a.id), f), '-- x\n');
  }
  // Inheriting copies ONE model (with its chain), not the whole family of builds.
  const copied = ctxs.copyPipelineFiles(a.id, b.id, 'pipe_x_a_c2');
  assert.deepEqual(copied.sort(), ['pipe_x_a_c2.sql', 'pipe_x_a_c2_s1.py', 'pipe_x_a_c2_s1.yml']);
  writeFileSync(join(ctxs.generatedDir(b.id), 'pipe_x_b.sql'), '-- own\n');
  // Cleaning up a pipeline NAME takes its chain and the models of its later builds…
  const removed = ctxs.removePipelineFiles(a.id, 'pipe_x_a');
  assert.deepEqual(removed.sort(), ['pipe_x_a.sql', 'pipe_x_a_c2.sql', 'pipe_x_a_c2_s1.py', 'pipe_x_a_c2_s1.yml', 'pipe_x_a_s1.sql']);
  assert.ok(existsSync(join(ctxs.generatedDir(a.id), 'pipe_other_a.sql')), 'another pipeline untouched');
  // …and NOTHING of another context: b's cleanup of its own pipeline keeps the inherited definition,
  // whose model name carries its owner's context id (which is why the two can never collide).
  assert.deepEqual(ctxs.removePipelineFiles(b.id, 'pipe_x_b'), ['pipe_x_b.sql']);
  assert.ok(ctxs.hasPipelineModel(b.id, 'pipe_x_a_c2'), 'inherited definition still readable in the fork');
});

// ── review follow-ups on the lifecycle around the built tables ──────────────────────────────

// preview WRITES BACK the plan (it retires what went stale), so it must report it: silently
// dropping a prefix left the next materialize recomputing everything with nothing said about why.
test('preview reports the prefix it retired instead of dropping it silently', async () => {
  const e = engine();
  const { context_id } = await e.build_pipeline_model({ action: 'start', name: 'seg', source: 'events' });
  await e.build_pipeline_model({ action: 'add_steps', context_id, stages: [agg('events_seen')] });
  const built = await e.build_pipeline_model({ action: 'materialize', context_id });
  await e.build_pipeline_model({ action: 'add_steps', context_id, stages: [{ stage: 'where', conditions: [{ column: 'events_seen', op: 'gte', value: 2 }] }] });
  // the index moved on since the prefix was built
  draftOf(e, context_id).checkpoints[0].index_run_id = 'an-older-scan';
  const pv = await e.build_pipeline_model({ action: 'preview', context_id });
  assert.equal(pv.from_checkpoint, undefined, 'the prefix is not offered any more');
  assert.match(pv.checkpoints_dropped[0].reason, /value index was refreshed/);
  assert.equal(pv.checkpoints_dropped[0].model, built.model);
  assert.deepEqual(draftOf(e, context_id).checkpoints, []);
});

// A cold index has no marker to compare: the FIRST scan completing observed the same data the
// prefix was built from, so it is not evidence that anything moved.
test('a prefix built before the first index scan is not retired by that scan', async () => {
  const e = engine();
  const { context_id } = await e.build_pipeline_model({ action: 'start', name: 'seg', source: 'events' });
  await e.build_pipeline_model({ action: 'add_steps', context_id, stages: [agg('events_seen')] });
  const built = await e.build_pipeline_model({ action: 'materialize', context_id });
  assert.equal(draftOf(e, context_id).checkpoints[0].index_run_id, null, 'nothing had been scanned yet');
  const next = await e.build_pipeline_model({ action: 'add_steps', context_id, stages: [{ stage: 'where', conditions: [{ column: 'events_seen', op: 'gte', value: 2 }] }] });
  assert.equal(next.from_checkpoint.model, built.model, 'still usable');
  assert.equal(next.checkpoints_dropped, undefined);
});

// The build counter belongs to the CONTEXT: a second draft of the same name in the same context
// would otherwise start over at the bare name and rebuild the very table a fork inherited.
test('a new draft in the same context never reuses a model name', async () => {
  const e = engine();
  const first = await e.build_pipeline_model({ action: 'start', name: 'seg', source: 'events' });
  await e.build_pipeline_model({ action: 'add_steps', context_id: first.context_id, stages: [agg('events_seen')] });
  const built = await e.build_pipeline_model({ action: 'materialize', context_id: first.context_id });
  const fork = await e.build_pipeline_model({ action: 'fork', context_id: first.context_id, after: 1, name: 'seg_alt' });
  assert.equal(fork.inherited_checkpoints[0].model, built.model);

  // start again in the SAME context, same name: the next build takes its own name
  const again = await e.build_pipeline_model({ action: 'start', name: 'seg', source: 'events', context_id: first.context_id });
  assert.equal(again.context_id, first.context_id);
  await e.build_pipeline_model({ action: 'add_steps', context_id: first.context_id, stages: [agg('other_count')] });
  const rebuilt = await e.build_pipeline_model({ action: 'materialize', context_id: first.context_id });
  assert.notEqual(rebuilt.model, built.model, 'the inherited table is not rebuilt under the fork');
  assert.ok(e.ctxs.hasPipelineModel(first.context_id, built.model), "and the fork's prefix still exists");
});

// The idle-context GC used to drop a checkpoint owner without consulting the consumers —
// bypassing the refusal that delete_context makes for exactly that reason.
test('the idle GC does not reclaim a context whose prefix a fork reads', async () => {
  const e = engine();
  const { context_id } = await e.build_pipeline_model({ action: 'start', name: 'seg', source: 'events' });
  await e.build_pipeline_model({ action: 'add_steps', context_id, stages: [agg('events_seen')] });
  await e.build_pipeline_model({ action: 'materialize', context_id });
  const fork = await e.build_pipeline_model({ action: 'fork', context_id, after: 1, name: 'seg_alt' });
  for (const c of [context_id, fork.context_id]) { const x = e.ctxs.get(c); x.lastUsedAt = 1; x.createdAt = 1; } // long idle
  assert.deepEqual(e.gc(1000), [fork.context_id], 'the consumer itself is reclaimable; its owner is not');
  assert.ok(e.ctxs.has(context_id), 'the owner stayed');
  // once the fork is gone, nothing reads the prefix and the owner is reclaimable again
  assert.deepEqual(e.gc(1000), [context_id]);
});

// A constant is compared with a column in the type the WAREHOUSE gives it: a flag stored as text is
// text, and a boolean is compared with every way text spells it. A checkpoint — and a task's table a
// draft starts from — stands for the steps before it, so its columns keep that word: the same
// condition is written the same way before the prefix is built and after it, in either form of the
// condition. Shown here by what such a column refuses (an order comparison with a boolean); the rows
// are proven against the warehouse in test/integration/condition-grammar.test.js.
test('a text flag of the warehouse stays text after a checkpoint and in a draft started from the build', async () => {
  const dtypes = { event_id: 'VARCHAR', player_id_of_internal: 'VARCHAR', event_name: 'VARCHAR', device_time: 'TIMESTAMP', event_date: 'DATE', event_data: 'JSON', is_clicked_of_event_data: 'VARCHAR' };
  const runner = {
    async run() { return { ok: true, stdout: '', stderr: '' }; },
    async show() { return { ok: true, rows: [], columns: [] }; },
    async relationColumns() { return { ok: true, columns: Object.entries(dtypes).map(([name, dtype]) => ({ name, dtype })) }; },
  };
  const e = new Engine({ catalog: loadCatalog(CATALOG, {}), runner, contextManager: new ContextManager({ baseProjectDir: '/tmp/cp-text-flag', workspaceRoot: mkdtempSync(join(tmpdir(), 'cp-')) }) });
  const textFlag = /'is_clicked_of_event_data' is a text column in the warehouse/;
  const forms = [{ column: 'is_clicked_of_event_data' }, { left: { column: 'is_clicked_of_event_data' } }];
  const ordered = (left) => ({ stage: 'where', conditions: [{ ...left, op: 'gt', value: true }] });
  // …and with the constant written on the left
  const constantLeft = { stage: 'where', conditions: [{ left: { value: true }, op: 'gt', right: { column: 'is_clicked_of_event_data' } }] };
  const refusedBoth = async (context_id, when) => {
    for (const left of forms) await assert.rejects(() => e.build_pipeline_model({ action: 'add_steps', context_id, stages: [ordered(left)] }), textFlag, `${when}: ${JSON.stringify(left)}`);
    await assert.rejects(() => e.build_pipeline_model({ action: 'add_steps', context_id, stages: [constantLeft] }), textFlag, `${when}: a constant on the left`);
  };

  const { context_id } = await e.build_pipeline_model({ action: 'start', name: 'flg', source: 'events', stages: [keepEvents('level_started')] });
  await refusedBoth(context_id, 'on the source');
  const started = await e.build_pipeline_model({ action: 'materialize', context_id });
  const built = await taskResult(e, started.task_id);
  assert.equal(built.status, 'done');
  await refusedBoth(context_id, 'after the checkpoint');
  const eq = await e.build_pipeline_model({ action: 'add_steps', context_id, stages: [{ stage: 'where', conditions: [{ column: 'is_clicked_of_event_data', op: 'eq', value: true }] }] });
  assert.equal(eq.from_checkpoint.model, built.model, 'the step reads the built table');

  const from = await e.build_pipeline_model({ action: 'start', name: 'flg2', from_task: started.task_id, include_columns: true });
  assert.ok(from.available_columns.some((c) => c.name === 'is_clicked_of_event_data'));
  assert.ok(from.available_columns.every((c) => !Object.hasOwn(c, 'physical')), 'the answer lists names and types only');
  await refusedBoth(from.context_id, 'from the task');
});

// A draft started from a task's table asks the warehouse for that table's own column types — whoever
// built it, and whether or not a checkpoint still records them. The stub warehouse answers for the
// source and, with `tables`, for every table a task built: a flag stored as text, a count as a number.
const FLAG_TYPES = { event_id: 'VARCHAR', player_id_of_internal: 'VARCHAR', event_name: 'VARCHAR', device_time: 'TIMESTAMP', event_date: 'DATE', event_data: 'JSON', is_clicked_of_event_data: 'VARCHAR', task_cnt: 'BIGINT', events_event_name: 'VARCHAR' };
function flagRunner({ tables = true } = {}) {
  const sourceModel = loadCatalog(CATALOG, {}).getModel('events').dbt_model;
  return {
    async parse() { return { ok: true }; },
    async query() { return { ok: true, sql: 'select 1' }; },
    async run() { return { ok: true, stdout: '', stderr: '' }; },
    async show() { return { ok: true, columns: [{ name: 'task_cnt' }, { name: 'events_event_name' }], rows: [{ task_cnt: 3, events_event_name: 'level_started' }] }; },
    async relationColumns(_dir, model) {
      if (!tables && model !== sourceModel) return { ok: false };
      return { ok: true, columns: Object.entries(FLAG_TYPES).map(([name, dtype]) => ({ name, dtype })) };
    },
  };
}
const flagEngine = (runner, { workspaceRoot = mkdtempSync(join(tmpdir(), 'cp-')), store } = {}) => new Engine({
  catalog: loadCatalog(CATALOG, {}), runner, ...(store ? { store } : {}),
  contextManager: new ContextManager({ baseProjectDir: '/tmp/cp-text-flag', workspaceRoot }),
});
const TEXT_FLAG = /'is_clicked_of_event_data' is a text column in the warehouse/;
const flagOrdered = { stage: 'where', conditions: [{ column: 'is_clicked_of_event_data', op: 'gt', value: true }] };
const flagEq = { stage: 'where', conditions: [{ column: 'is_clicked_of_event_data', op: 'eq', value: true }] };
const builtFlags = async (e, context_id) => {
  const started = await e.build_pipeline_model({ action: 'materialize', context_id });
  assert.equal((await taskResult(e, started.task_id)).status, 'done');
  return started.task_id;
};

test('a draft started from an earlier build reads its table\'s types from the warehouse after a later build superseded its checkpoint', async () => {
  const e = flagEngine(flagRunner());
  const { context_id } = await e.build_pipeline_model({ action: 'start', name: 'flg', source: 'events', stages: [keepEvents('level_started')] });
  const first = await builtFlags(e, context_id);
  await e.build_pipeline_model({ action: 'edit_step', context_id, index: 1, stage: keepEvents('level_completed') });
  const second = await builtFlags(e, context_id);
  const owner = e.ctxs.get(context_id).state;
  assert.ok(![...(owner.draft.checkpoints || []), ...(owner.pipeline_origin?.checkpoints || [])].some((c) => c.task_id === first), 'no checkpoint records the first build any more');
  for (const task of [first, second]) {
    const from = await e.build_pipeline_model({ action: 'start', name: 'flg_from', from_task: task, include_columns: true });
    assert.ok(from.available_columns.every((c) => !Object.hasOwn(c, 'physical')), 'the answer lists names and types only');
    await assert.rejects(() => e.build_pipeline_model({ action: 'add_steps', context_id: from.context_id, stages: [flagOrdered] }), TEXT_FLAG, `from task ${task}`);
    const eq = await e.build_pipeline_model({ action: 'add_steps', context_id: from.context_id, stages: [flagEq] });
    assert.equal(eq.added, 1, 'a boolean compared by eq is taken, spelled as text');
  }
});

test('where the warehouse cannot be asked about a task\'s table, the marks its build\'s checkpoint recorded stand', async () => {
  const e = flagEngine(flagRunner({ tables: false }));
  const { context_id } = await e.build_pipeline_model({ action: 'start', name: 'flg', source: 'events', stages: [keepEvents('level_started')] });
  const task = await builtFlags(e, context_id);
  const from = await e.build_pipeline_model({ action: 'start', name: 'flg_from', from_task: task });
  await assert.rejects(() => e.build_pipeline_model({ action: 'add_steps', context_id: from.context_id, stages: [flagOrdered] }), TEXT_FLAG);
});

test('a draft started from a semantic query run with materialize: true has its table\'s column types from the warehouse', async () => {
  const e = flagEngine(flagRunner());
  const created = await e.build_semantic_model({ name: 'task', semantic_models: [{ from: 'events', measures: [{ name: 'cnt', agg: 'count' }] }], metrics: [{ name: 'cnt', type: 'simple', measure: { name: 'cnt' } }] });
  await taskResult(e, created.task_id);
  const stored = await e.query_semantic_model({ context_id: created.context_id, metrics: ['task_cnt'], group_by: [{ model: 'events', attribute: 'event_name' }], materialize: true });
  assert.equal((await taskResult(e, stored.task_id)).status, 'done');
  const from = await e.build_pipeline_model({ action: 'start', name: 'slice', from_task: stored.task_id, include_columns: true });
  assert.deepEqual(from.available_columns, [{ name: 'task_cnt', type: 'numeric' }, { name: 'events_event_name', type: 'string' }]);
  await assert.rejects(
    () => e.build_pipeline_model({ action: 'add_steps', context_id: from.context_id, stages: [{ stage: 'where', conditions: [{ column: 'task_cnt', op: 'gt', value: 'many' }] }] }),
    /'task_cnt' is a numeric column/,
  );
  await assert.rejects(
    () => e.build_pipeline_model({ action: 'add_steps', context_id: from.context_id, stages: [{ stage: 'where', conditions: [{ column: 'events_event_name', op: 'gt', value: true }] }] }),
    /'events_event_name' is a text column in the warehouse/,
  );
});

test('after a restart, a draft started from a build\'s task has its table\'s column types from the warehouse', async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'cp-'));
  const store = openStore({ dbPath: join(workspaceRoot, 'store.sqlite') });
  const e = flagEngine(flagRunner(), { workspaceRoot, store });
  const { context_id } = await e.build_pipeline_model({ action: 'start', name: 'flg', source: 'events', stages: [keepEvents('level_started')] });
  const task = await builtFlags(e, context_id);
  // a new process over the same registry and job store: the task's answer held in memory is gone
  const e2 = flagEngine(flagRunner(), { workspaceRoot, store });
  assert.equal(e2.jobs.get(task).status, 'ready');
  const from = await e2.build_pipeline_model({ action: 'start', name: 'flg_from', from_task: task, include_columns: true });
  assert.deepEqual(from.available_columns.find((c) => c.name === 'is_clicked_of_event_data'), { name: 'is_clicked_of_event_data', type: 'string' });
  await assert.rejects(() => e2.build_pipeline_model({ action: 'add_steps', context_id: from.context_id, stages: [flagOrdered] }), TEXT_FLAG);
});
