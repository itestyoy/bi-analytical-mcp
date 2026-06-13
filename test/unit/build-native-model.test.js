import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';

// Allowed non-data test: build_native_model's draft LIFECYCLE + input validation are
// pure schema/state machinery (renderPipeline folds columns WITHOUT a warehouse), so no
// runner is wired and nothing is materialized. We assert on draft state + column
// propagation + error guards — never on generated SQL text.
const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));

function engine() {
  const catalog = loadCatalog(CATALOG, {});
  return new Engine({ catalog, contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'bnm-')) }) });
}

const mr = { stage: 'match_recognize', partition_by: ['player_id_of_internal'], steps: [{ name: 'a', event_name: ['first_launch'] }, { name: 'b', event_name: ['tutorial'] }] };

test('build_native_model: start returns a draft + source column count (full list on include_columns)', async () => {
  const e = engine();
  const s = await e.build_native_model({ action: 'start', name: 'inc', source: 'events' });
  assert.match(s.draft_id, /\w+/);
  assert.equal(s.action, 'start');
  assert.deepEqual(s.steps, []);
  assert.ok(s.column_count > 0, 'source column count reported');
  assert.equal(s.available_columns, undefined, 'full list not dumped by default');
  // opt in to the full list.
  const full = await e.build_native_model({ action: 'start', name: 'inc2', source: 'events', include_columns: true });
  assert.ok(full.available_columns.some((c) => c.name === 'player_id_of_internal'), 'source columns surfaced with include_columns');
  assert.ok(Array.isArray(s.recommendations) && s.recommendations.length > 0);
});

test('build_native_model: add_step propagates columns; bad step is rejected without mutating the draft', async () => {
  const e = engine();
  const s = await e.build_native_model({ action: 'start', name: 'inc', source: 'events' });
  const a1 = await e.build_native_model({ action: 'add_step', draft_id: s.draft_id, stage: mr, include_columns: true });
  assert.equal(a1.step_index, 1);
  const cols = a1.available_columns.map((c) => c.name);
  assert.ok(cols.includes('player_id_of_internal'), 'partition key carried');
  assert.ok(cols.includes('reached_a') && cols.includes('completed'), 'funnel output columns available');
  // a second stage references the funnel output produced by the first.
  const a2 = await e.build_native_model({ action: 'add_step', draft_id: s.draft_id, stage: { stage: 'aggregate', group_by: ['completed'], measures: [{ name: 'n', fn: 'count' }] }, include_columns: true });
  assert.equal(a2.step_index, 2);
  assert.deepEqual(a2.available_columns.map((c) => c.name), ['completed', 'n']);
  // a stage referencing a missing column is rejected and NOT persisted.
  await assert.rejects(() => e.build_native_model({ action: 'add_step', draft_id: s.draft_id, stage: { stage: 'project', columns: ['no_such_col'] } }));
  const pv = await e.build_native_model({ action: 'preview', draft_id: s.draft_id });
  assert.equal(pv.steps.length, 2, 'rejected step not persisted');
  assert.ok(typeof pv.model_sql === 'string' && pv.model_sql.length > 0, 'preview renders SQL (schema-only)');
});

// #1: by default add_step returns a DIFF (what this stage changed), not the whole schema.
test('build_native_model: add_step returns a column diff by default', async () => {
  const e = engine();
  const s = await e.build_native_model({ action: 'start', name: 'diff', source: 'events' });
  const a1 = await e.build_native_model({ action: 'add_step', draft_id: s.draft_id, stage: mr });
  assert.equal(a1.available_columns, undefined, 'no full dump by default');
  assert.ok(typeof a1.column_count === 'number' && a1.column_count > 0);
  const added = a1.columns_added.map((c) => c.name);
  assert.ok(added.includes('reached_a') && added.includes('completed'), 'diff shows the funnel columns this stage added');
  assert.ok(!a1.columns_removed.includes('player_id_of_internal'), 'the carried partition key is not reported as removed');
  // aggregate then collapses to group keys + measures: prior event columns show as removed.
  const a2 = await e.build_native_model({ action: 'add_step', draft_id: s.draft_id, stage: { stage: 'aggregate', group_by: ['completed'], measures: [{ name: 'n', fn: 'count' }] } });
  assert.deepEqual(a2.columns_added.map((c) => c.name), ['n']); // group key 'completed' persisted; 'n' is new
  assert.ok(a2.columns_removed.includes('reached_a'), 'aggregated-away columns reported as removed');
  assert.equal(a2.column_count, 2);
});

test('build_native_model: discard drops the draft; later actions error cleanly', async () => {
  const e = engine();
  const s = await e.build_native_model({ action: 'start', name: 'inc', source: 'events' });
  await e.build_native_model({ action: 'add_step', draft_id: s.draft_id, stage: mr });
  const d = await e.build_native_model({ action: 'discard', draft_id: s.draft_id });
  assert.equal(d.discarded, true);
  await assert.rejects(() => e.build_native_model({ action: 'add_step', draft_id: s.draft_id, stage: mr }), /no draft/i);
  await assert.rejects(() => e.build_native_model({ action: 'preview', draft_id: s.draft_id }), /no draft/i);
});

test('build_native_model: starting again in the same context resets the draft', async () => {
  const e = engine();
  const s = await e.build_native_model({ action: 'start', name: 'first', source: 'events' });
  await e.build_native_model({ action: 'add_step', draft_id: s.draft_id, stage: mr });
  // reuse the same draft_id: a fresh start wipes prior stages + renames.
  const s2 = await e.build_native_model({ action: 'start', draft_id: s.draft_id, name: 'second', source: 'events' });
  assert.equal(s2.draft_id, s.draft_id);
  assert.equal(s2.name, 'second');
  assert.deepEqual(s2.steps, []);
  const pv = await e.build_native_model({ action: 'preview', draft_id: s.draft_id });
  assert.equal(pv.steps.length, 0);
});

test('build_native_model: schema rejects malformed actions', async () => {
  const e = engine();
  await assert.rejects(() => e.build_native_model({ action: 'start' }), 'start requires name');
  await assert.rejects(() => e.build_native_model({ action: 'add_step', draft_id: 'ctx_deadbeef' }), 'add_step requires a stage');
  await assert.rejects(() => e.build_native_model({ action: 'bogus' }), 'unknown action rejected');
});

// Strictness: each action rejects fields that do not belong to it (no silent ignoring).
test('build_native_model: schema rejects action-irrelevant fields', async () => {
  const e = engine();
  const s = await e.build_native_model({ action: 'start', name: 'strict', source: 'events' });
  // start must not carry a stage.
  await assert.rejects(() => e.build_native_model({ action: 'start', name: 'x', stage: mr }), 'start + stage rejected');
  // add_step must not carry start-only fields.
  await assert.rejects(() => e.build_native_model({ action: 'add_step', draft_id: s.draft_id, stage: mr, source: 'events' }), 'add_step + source rejected');
  await assert.rejects(() => e.build_native_model({ action: 'add_step', draft_id: s.draft_id, stage: mr, name: 'x' }), 'add_step + name rejected');
  // preview/commit/discard take only draft_id.
  await assert.rejects(() => e.build_native_model({ action: 'preview', draft_id: s.draft_id, stage: mr }), 'preview + stage rejected');
  await assert.rejects(() => e.build_native_model({ action: 'materialize', draft_id: s.draft_id, materialized: 'view' }), 'commit + materialized rejected');
  // start MAY carry draft_id (legitimate context reuse) — not rejected.
  const reuse = await e.build_native_model({ action: 'start', draft_id: s.draft_id, name: 'reused' });
  assert.equal(reuse.draft_id, s.draft_id);
});

// #2: array ops are type-checked at add_step (not only at commit/runtime).
test('build_native_model: array op on a non-array column is rejected at add_step', async () => {
  const e = engine();
  const s = await e.build_native_model({ action: 'start', name: 'arr', source: 'events' });
  // array_last over a string column → rejected when the stage is ADDED, with a fix hint.
  await assert.rejects(
    () => e.build_native_model({ action: 'add_step', draft_id: s.draft_id, stage: { stage: 'compute', name: 'last', op: 'array_last', column: 'player_id_of_internal' } }),
    /not an array/,
  );
  // correct flow: json_parse_array (string → array) first, then array_last passes validation.
  const s2 = await e.build_native_model({ action: 'start', name: 'arr2', source: 'events' });
  await e.build_native_model({ action: 'add_step', draft_id: s2.draft_id, stage: { stage: 'compute', name: 'arr', op: 'json_parse_array', column: 'player_id_of_internal' } });
  const ok = await e.build_native_model({ action: 'add_step', draft_id: s2.draft_id, stage: { stage: 'compute', name: 'last', op: 'array_last', column: 'arr' } });
  assert.equal(ok.steps.length, 2, 'array_last on a parsed array column is accepted');
});

// Physical grounding: when a runner can introspect the relation, a catalog column the
// PHYSICAL table lacks is excluded from the referenceable set (and surfaced as
// not_materialized) — so referencing it is a clean "unknown column" at add_step, never a
// raw warehouse "Unrecognized name" at commit. This is the level_number_of_state case.
test('build_native_model grounds source columns to the physical relation', async () => {
  const catalog = loadCatalog(CATALOG, {});
  // Stub runner: the physical fct_analytics_events has these columns — NOTE it omits
  // 'complete_time_of_event_data' (declared in the fixture catalog, but "not materialized").
  const physical = ['player_id_of_internal', 'session_number', 'event_name', 'device_time', 'event_data', 'level_id_of_event_data', 'result_of_event_data', 'ad_type_of_event_data'];
  const runner = { relationColumns: async () => ({ ok: true, columns: physical.map((name) => ({ name })) }) };
  const e = new Engine({ catalog, runner, contextManager: new ContextManager({ baseProjectDir: '/tmp/grounding', workspaceRoot: mkdtempSync(join(tmpdir(), 'gr-')) }) });

  const s = await e.build_native_model({ action: 'start', name: 'grounded', source: 'events', include_columns: true });
  const names = s.available_columns.map((c) => c.name);
  assert.ok(names.includes('result_of_event_data'), 'a physically-present column is offered');
  assert.ok(!names.includes('complete_time_of_event_data'), 'a phantom catalog column is NOT offered');
  assert.ok(s.not_materialized.includes('complete_time_of_event_data'), 'the desync is surfaced in not_materialized');

  // a physically-present column builds fine through add_step.
  await e.build_native_model({ action: 'add_step', draft_id: s.draft_id, stage: { stage: 'where', conditions: [{ column: 'result_of_event_data', op: 'is_not_null' }] } });
  // the phantom column is rejected as an UNKNOWN COLUMN at add_step (early + clear), not at commit.
  await assert.rejects(
    () => e.build_native_model({ action: 'add_step', draft_id: s.draft_id, stage: { stage: 'aggregate', group_by: ['complete_time_of_event_data'], measures: [{ name: 'n', fn: 'count' }] } }),
    /unknown column 'complete_time_of_event_data'/,
  );
  const pv = await e.build_native_model({ action: 'preview', draft_id: s.draft_id });
  assert.equal(pv.steps.length, 1, 'the rejected phantom step was not persisted');
});

// No runner → grounding is skipped (physical truth unknown): declared columns are used
// as-is, exactly as before, so offline/test behaviour is unchanged.
test('build_native_model: grounding is skipped without a runner (declared columns as-is)', async () => {
  const e = engine(); // no runner
  const s = await e.build_native_model({ action: 'start', name: 'noground', source: 'events', include_columns: true });
  assert.ok(s.available_columns.some((c) => c.name === 'complete_time_of_event_data'), 'declared column offered (cannot verify physically offline)');
  assert.equal(s.not_materialized, undefined);
});
