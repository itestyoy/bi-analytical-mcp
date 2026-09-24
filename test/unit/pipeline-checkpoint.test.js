import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { settle } from '../helpers/settle.js';

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
const agg = (name) => ({ stage: 'aggregate', group_by: ['player_id_of_internal'], measures: [{ name, fn: 'count' }] });
const keepEvents = (value) => ({ stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value }] });
const funnel = {
  stage: 'match_recognize',
  partition_by: ['player_id_of_internal'],
  steps: [{ name: 'a', event_name: ['level_started'] }, { name: 'b', event_name: ['level_completed'] }],
};

test('materialize keeps the draft and records the built table as a checkpoint; the next step reads it', async () => {
  const e = engine();
  const { draft_id } = await e.build_pipeline_model({ action: 'start', name: 'seg', source: 'events' });
  await e.build_pipeline_model({ action: 'add_step', draft_id, stage: agg('events_seen') });
  const built = await e.build_pipeline_model({ action: 'materialize', draft_id });
  assert.equal(built.checkpoint.at, 1);
  assert.equal(built.checkpoint.model, built.model);
  assert.equal(built.checkpoint.carries_source, undefined, 'an aggregate does not carry the source columns');
  const draft = draftOf(e, draft_id);
  assert.ok(draft, 'the draft survives materialize');
  assert.equal(draft.checkpoints.length, 1);
  // The next step is validated against the CHECKPOINT's columns and reported as reading it.
  const next = await e.build_pipeline_model({ action: 'add_step', draft_id, stage: { stage: 'where', conditions: [{ column: 'events_seen', op: 'gte', value: 2 }] } });
  assert.deepEqual(next.from_checkpoint, { at: 1, model: built.model, built_at: draft.checkpoints[0].built_at });
  assert.equal(next.steps_recomputed, 1, 'only the new step would be recomputed');
  // A second materialize builds under its OWN name, so it never overwrites the table it reads.
  const again = await e.build_pipeline_model({ action: 'materialize', draft_id });
  assert.notEqual(again.model, built.model);
  assert.equal(again.from_checkpoint.model, built.model);
  assert.equal(again.steps_recomputed, 1);
  assert.deepEqual(draftOf(e, draft_id).checkpoints.map((c) => c.at), [1, 2]);
  // Nothing left after the last checkpoint → nothing to build (not a silent copy of the table).
  await assert.rejects(() => e.build_pipeline_model({ action: 'materialize', draft_id }), /nothing to build/);
});

test('invalidation is positional: an edit retires the checkpoints whose prefix contains that step', async () => {
  const e = engine();
  const { draft_id } = await e.build_pipeline_model({ action: 'start', name: 'seg', source: 'events' });
  await e.build_pipeline_model({ action: 'add_step', draft_id, stage: agg('events_seen') });
  await e.build_pipeline_model({ action: 'add_step', draft_id, stage: { stage: 'where', conditions: [{ column: 'events_seen', op: 'gte', value: 2 }] } });
  const c1 = await e.build_pipeline_model({ action: 'materialize', draft_id }); // at: 2
  await e.build_pipeline_model({ action: 'add_step', draft_id, stage: { stage: 'compute', name: 'twice', op: 'mul', left: { column: 'events_seen' }, right: { value: 2 } } });
  await e.build_pipeline_model({ action: 'add_step', draft_id, stage: { stage: 'order_by', keys: [{ key: 'twice', direction: 'desc' }] } });
  const c2 = await e.build_pipeline_model({ action: 'materialize', draft_id }); // at: 4
  assert.deepEqual(draftOf(e, draft_id).checkpoints.map((c) => c.at), [2, 4]);

  // Editing step 3 retires ONLY the checkpoint that baked it (at: 4); the one at 2 lives.
  const edit = await e.build_pipeline_model({ action: 'edit_step', draft_id, index: 3, stage: { stage: 'compute', name: 'twice', op: 'mul', left: { column: 'events_seen' }, right: { value: 3 } } });
  assert.deepEqual(edit.checkpoints_dropped.map((d) => d.at), [4]);
  assert.deepEqual(draftOf(e, draft_id).checkpoints.map((c) => c.at), [2]);
  assert.deepEqual(edit.from_checkpoint.model, c1.model);
  // The live prefix keeps its files, and so does the retired one WHILE it is the context's
  // registered result: `ctx.state.model` still advertises that table and get_query_result reads it
  // through a ref, which needs the definition.
  assert.ok(e.ctxs.hasPipelineModel(draft_id, c1.model), 'live checkpoint model kept');
  assert.equal(e.ctxs.get(draft_id).state.model, c2.model);
  assert.ok(e.ctxs.hasPipelineModel(draft_id, c2.model), 'the built result stays readable after the edit');

  // Editing step 1 is below the surviving checkpoint → it goes too, and the rebuild is full.
  const deep = await e.build_pipeline_model({ action: 'edit_step', draft_id, index: 1, stage: agg('events_seen') });
  assert.deepEqual(deep.checkpoints_dropped.map((d) => d.at), [2]);
  assert.equal(deep.from_checkpoint, undefined);
  assert.deepEqual(draftOf(e, draft_id).checkpoints, []);
  // …and THAT one is not the registered result, so its own files go — without taking the
  // registered model's with them, although it is the base name every later build extends.
  assert.ok(!e.ctxs.hasPipelineModel(draft_id, c1.model), 'the retired prefix nobody reads is cleaned up');
  assert.ok(e.ctxs.hasPipelineModel(draft_id, c2.model), 'the registered result is untouched');
});

test('truncate retires the checkpoints past the kept prefix; add_step never retires one', async () => {
  const e = engine();
  const { draft_id } = await e.build_pipeline_model({ action: 'start', name: 'seg', source: 'events' });
  await e.build_pipeline_model({ action: 'add_step', draft_id, stage: agg('events_seen') });
  await e.build_pipeline_model({ action: 'materialize', draft_id }); // at: 1
  await e.build_pipeline_model({ action: 'add_step', draft_id, stage: { stage: 'where', conditions: [{ column: 'events_seen', op: 'gte', value: 2 }] } });
  await e.build_pipeline_model({ action: 'materialize', draft_id }); // at: 2
  const added = await e.build_pipeline_model({ action: 'add_step', draft_id, stage: { stage: 'project', columns: ['player_id_of_internal'] } });
  assert.equal(added.checkpoints_dropped, undefined, 'appending never invalidates a prefix');
  const tr = await e.build_pipeline_model({ action: 'truncate', draft_id, after: 1 });
  assert.deepEqual(tr.checkpoints_dropped.map((d) => d.at), [2]);
  assert.deepEqual(draftOf(e, draft_id).checkpoints.map((c) => c.at), [1]);
});

test('a stage needing the source columns is refused after a checkpoint that dropped them, accepted after one that kept them', async () => {
  const e = engine();
  // (a) checkpoint after an aggregate: one row per player, no event columns left.
  const a = await e.build_pipeline_model({ action: 'start', name: 'seg', source: 'events' });
  await e.build_pipeline_model({ action: 'add_step', draft_id: a.draft_id, stage: agg('events_seen') });
  await e.build_pipeline_model({ action: 'materialize', draft_id: a.draft_id });
  await assert.rejects(
    () => e.build_pipeline_model({ action: 'add_step', draft_id: a.draft_id, stage: funnel }),
    /no longer that source's events/,
  );
  // a payload read is refused for the same reason — the column it reads is not there.
  await assert.rejects(
    () => e.build_pipeline_model({ action: 'add_step', draft_id: a.draft_id, stage: { stage: 'derive', name: 'lvl', op: 'extract', source: 'level_id_of_event_data' } }),
    /unknown column/,
  );

  // (b) checkpoint where the rows are still events (a where) → the funnel is legal on top of it.
  const b = await e.build_pipeline_model({ action: 'start', name: 'funnel_on_slice', source: 'events' });
  await e.build_pipeline_model({ action: 'add_step', draft_id: b.draft_id, stage: keepEvents('level_started') });
  const built = await e.build_pipeline_model({ action: 'materialize', draft_id: b.draft_id });
  assert.equal(built.checkpoint.carries_source, 'events');
  const ok = await e.build_pipeline_model({ action: 'add_step', draft_id: b.draft_id, stage: funnel, include_columns: true });
  assert.equal(ok.from_checkpoint.at, 1);
  assert.ok(ok.available_columns.some((c) => c.name === 'reached_a'), 'funnel built on top of the materialized slice');
});

test('fork inherits a checkpoint it keeps, copies its definition, and the owner cannot be dropped under it', async () => {
  const e = engine();
  const { draft_id } = await e.build_pipeline_model({ action: 'start', name: 'seg', source: 'events' });
  await e.build_pipeline_model({ action: 'add_step', draft_id, stage: agg('events_seen') });
  const c1 = await e.build_pipeline_model({ action: 'materialize', draft_id }); // at: 1
  await e.build_pipeline_model({ action: 'add_step', draft_id, stage: { stage: 'where', conditions: [{ column: 'events_seen', op: 'gte', value: 5 }] } });
  const c2 = await e.build_pipeline_model({ action: 'materialize', draft_id }); // at: 2

  const fork = await e.build_pipeline_model({ action: 'fork', draft_id, after: 1, name: 'seg_alt' });
  assert.deepEqual(fork.inherited_checkpoints, [{ at: 1, model: c1.model, owner: draft_id }]);
  assert.ok(e.ctxs.hasPipelineModel(fork.draft_id, c1.model), "the parent's model is readable in the fork (ref resolves)");
  assert.ok(!e.ctxs.hasPipelineModel(fork.draft_id, c2.model), 'a checkpoint past `after` is not inherited');

  // The fork continues on top of the INHERITED table — only its own step is computed.
  const step = await e.build_pipeline_model({ action: 'add_step', draft_id: fork.draft_id, stage: { stage: 'where', conditions: [{ column: 'events_seen', op: 'lt', value: 5 }] } });
  assert.equal(step.from_checkpoint.model, c1.model);
  assert.equal(step.steps_recomputed, 1);

  // Dropping the owner would take that table with it → refused, naming the consumer.
  await assert.rejects(() => e.context({ action: 'drop', context_id: draft_id }), new RegExp(`${fork.draft_id}.*${c1.model}`));
  assert.ok(e.ctxs.has(draft_id), 'nothing was dropped');
  // Forced: the fork's inherited checkpoint is retired, so it recomputes from the source.
  assert.deepEqual(await e.context({ action: 'drop', context_id: draft_id, force: true }), { removed: true });
  assert.deepEqual(draftOf(e, fork.draft_id).checkpoints, []);
});

test('a checkpoint is retired when the value index moved on, or its model is gone', async () => {
  const e = engine();
  const { draft_id } = await e.build_pipeline_model({ action: 'start', name: 'seg', source: 'events' });
  await e.build_pipeline_model({ action: 'add_step', draft_id, stage: agg('events_seen') });
  const built = await e.build_pipeline_model({ action: 'materialize', draft_id });
  assert.equal(draftOf(e, draft_id).checkpoints.length, 1);
  // A completed index scan means the source data may have moved — the prefix is no longer trusted.
  draftOf(e, draft_id).checkpoints[0].index_run_id = 'a-previous-scan';
  const afterScan = await e.build_pipeline_model({ action: 'add_step', draft_id, stage: { stage: 'project', columns: ['player_id_of_internal'] } });
  assert.match(afterScan.checkpoints_dropped[0].reason, /value index was refreshed/);
  assert.deepEqual(draftOf(e, draft_id).checkpoints, []);

  // And when the model itself is deleted out from under the draft.
  const second = await e.build_pipeline_model({ action: 'materialize', draft_id });
  e.ctxs.removePipelineFiles(draft_id, second.model);
  const afterDelete = await e.build_pipeline_model({ action: 'add_step', draft_id, stage: { stage: 'project', columns: ['player_id_of_internal'] } });
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
  const { draft_id } = await e.build_pipeline_model({ action: 'start', name: 'seg', source: 'events' });
  await e.build_pipeline_model({ action: 'add_step', draft_id, stage: agg('events_seen') });
  const built = await e.build_pipeline_model({ action: 'materialize', draft_id });
  await e.build_pipeline_model({ action: 'add_step', draft_id, stage: { stage: 'where', conditions: [{ column: 'events_seen', op: 'gte', value: 2 }] } });
  // the index moved on since the prefix was built
  draftOf(e, draft_id).checkpoints[0].index_run_id = 'an-older-scan';
  const pv = await e.build_pipeline_model({ action: 'preview', draft_id });
  assert.equal(pv.from_checkpoint, undefined, 'the prefix is not offered any more');
  assert.match(pv.checkpoints_dropped[0].reason, /value index was refreshed/);
  assert.equal(pv.checkpoints_dropped[0].model, built.model);
  assert.deepEqual(draftOf(e, draft_id).checkpoints, []);
});

// A cold index has no marker to compare: the FIRST scan completing observed the same data the
// prefix was built from, so it is not evidence that anything moved.
test('a prefix built before the first index scan is not retired by that scan', async () => {
  const e = engine();
  const { draft_id } = await e.build_pipeline_model({ action: 'start', name: 'seg', source: 'events' });
  await e.build_pipeline_model({ action: 'add_step', draft_id, stage: agg('events_seen') });
  const built = await e.build_pipeline_model({ action: 'materialize', draft_id });
  assert.equal(draftOf(e, draft_id).checkpoints[0].index_run_id, null, 'nothing had been scanned yet');
  const next = await e.build_pipeline_model({ action: 'add_step', draft_id, stage: { stage: 'where', conditions: [{ column: 'events_seen', op: 'gte', value: 2 }] } });
  assert.equal(next.from_checkpoint.model, built.model, 'still usable');
  assert.equal(next.checkpoints_dropped, undefined);
});

// The build counter belongs to the CONTEXT: a second draft of the same name in the same context
// would otherwise start over at the bare name and rebuild the very table a fork inherited.
test('a new draft in the same context never reuses a model name', async () => {
  const e = engine();
  const first = await e.build_pipeline_model({ action: 'start', name: 'seg', source: 'events' });
  await e.build_pipeline_model({ action: 'add_step', draft_id: first.draft_id, stage: agg('events_seen') });
  const built = await e.build_pipeline_model({ action: 'materialize', draft_id: first.draft_id });
  const fork = await e.build_pipeline_model({ action: 'fork', draft_id: first.draft_id, after: 1, name: 'seg_alt' });
  assert.equal(fork.inherited_checkpoints[0].model, built.model);

  // start again in the SAME context, same name: the next build takes its own name
  const again = await e.build_pipeline_model({ action: 'start', name: 'seg', source: 'events', draft_id: first.draft_id });
  assert.equal(again.draft_id, first.draft_id);
  await e.build_pipeline_model({ action: 'add_step', draft_id: first.draft_id, stage: agg('other_count') });
  const rebuilt = await e.build_pipeline_model({ action: 'materialize', draft_id: first.draft_id });
  assert.notEqual(rebuilt.model, built.model, 'the inherited table is not rebuilt under the fork');
  assert.ok(e.ctxs.hasPipelineModel(first.draft_id, built.model), "and the fork's prefix still exists");
});

// The idle-context GC used to drop a checkpoint owner without consulting the consumers —
// bypassing the refusal that context({ action: 'drop' }) makes for exactly that reason.
test('the idle GC does not reclaim a context whose prefix a fork reads', async () => {
  const e = engine();
  const { draft_id } = await e.build_pipeline_model({ action: 'start', name: 'seg', source: 'events' });
  await e.build_pipeline_model({ action: 'add_step', draft_id, stage: agg('events_seen') });
  await e.build_pipeline_model({ action: 'materialize', draft_id });
  const fork = await e.build_pipeline_model({ action: 'fork', draft_id, after: 1, name: 'seg_alt' });
  for (const c of [draft_id, fork.draft_id]) { const x = e.ctxs.get(c); x.lastUsedAt = 1; x.createdAt = 1; } // long idle
  assert.deepEqual(e.gc(1000), [fork.draft_id], 'the consumer itself is reclaimable; its owner is not');
  assert.ok(e.ctxs.has(draft_id), 'the owner stayed');
  // once the fork is gone, nothing reads the prefix and the owner is reclaimable again
  assert.deepEqual(e.gc(1000), [draft_id]);
});
