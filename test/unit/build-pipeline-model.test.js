import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { settle, stepNotes, stepEffect } from '../helpers/settle.js';

// Allowed non-data test: build_pipeline_model's draft LIFECYCLE + input validation are
// pure schema/state machinery (renderPipeline folds columns WITHOUT a warehouse), so no
// runner is wired and nothing is materialized. We assert on draft state + column
// propagation + error guards — never on generated SQL text.
const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));

function engine() {
  const catalog = loadCatalog(CATALOG, {});
  return settle(new Engine({ catalog, contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'bnm-')) }) }));
}

const mr = { stage: 'match_recognize', partition_by: ['player_id_of_internal'], steps: [{ name: 'a', event_name: ['first_launch'] }, { name: 'b', event_name: ['tutorial'] }] };

test('build_pipeline_model: start returns a draft + source column count (full list on include_columns)', async () => {
  const e = engine();
  const s = await e.build_pipeline_model({ action: 'start', name: 'inc', source: 'events' });
  assert.match(s.context_id, /\w+/);
  assert.equal(s.action, 'start');
  assert.deepEqual(s.steps, []);
  assert.ok(s.column_count > 0, 'source column count reported');
  assert.equal(s.available_columns, undefined, 'full list not dumped by default');
  // opt in to the full list.
  const full = await e.build_pipeline_model({ action: 'start', name: 'inc2', source: 'events', include_columns: true });
  assert.ok(full.available_columns.some((c) => c.name === 'player_id_of_internal'), 'source columns surfaced with include_columns');
  assert.ok(Array.isArray(s.recommendations) && s.recommendations.length > 0);
});

test('build_pipeline_model: add_steps propagates columns; bad step is rejected without mutating the draft', async () => {
  const e = engine();
  const s = await e.build_pipeline_model({ action: 'start', name: 'inc', source: 'events' });
  const a1 = await e.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, stages: [mr], include_columns: true });
  assert.equal(stepEffect(a1).step_index, 1);
  const cols = a1.available_columns.map((c) => c.name);
  assert.ok(cols.includes('player_id_of_internal'), 'partition key carried');
  assert.ok(cols.includes('reached_a') && cols.includes('completed'), 'funnel output columns available');
  // a second stage references the funnel output produced by the first.
  const a2 = await e.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, stages: [{ stage: 'aggregate', group_by: ['completed'], measures: [{ name: 'n', agg: 'count' }] }], include_columns: true });
  assert.equal(stepEffect(a2).step_index, 2);
  assert.deepEqual(a2.available_columns.map((c) => c.name), ['completed', 'n']);
  // a stage referencing a missing column is rejected and NOT persisted.
  await assert.rejects(() => e.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, stages: [{ stage: 'project', keep: ['no_such_col'] }] }));
  const pv = await e.build_pipeline_model({ action: 'preview', context_id: s.context_id });
  assert.equal(pv.steps.length, 2, 'rejected step not persisted');
  assert.ok(typeof pv.model_sql === 'string' && pv.model_sql.length > 0, 'preview renders SQL (schema-only)');
});

// add_steps is append-only, so it echoes ONLY the applied step (+ steps_count), not the growing
// steps array — the O(n²) token saver. include_steps:true restores the full list on demand.
test('build_pipeline_model: add_steps returns only the applied step by default; include_steps:true gives the full list', async () => {
  const e = engine();
  const s = await e.build_pipeline_model({ action: 'start', name: 'lean', source: 'events' });
  await e.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, stages: [{ stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] }] });
  const a2 = await e.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, stages: [{ stage: 'aggregate', group_by: ['currency_of_event_data'], measures: [{ name: 'n', agg: 'count' }] }] });
  // lean by default: the applied step + a count, NOT the whole steps array.
  assert.equal(a2.steps, undefined, 'the growing steps array is not re-echoed on add_steps');
  assert.equal(a2.steps_count, 2, 'steps_count reports the pipeline length');
  assert.equal(a2.steps_added[a2.steps_added.length - 1].stage, 'aggregate', 'the applied step is returned');
  assert.equal(a2.steps_added[a2.steps_added.length - 1].index, 2);
  assert.ok(stepNotes(a2).some((r) => /include_steps:true|preview/.test(r)), 'recommendation points to the full-list drill');
  // opt back in to the full list.
  const a3 = await e.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, stages: [{ stage: 'order_by', keys: [{ key: 'n', direction: 'desc' }] }], include_steps: true });
  assert.ok(Array.isArray(a3.steps) && a3.steps.length === 3, 'include_steps:true returns the full steps array');
  assert.equal(a3.steps_count, undefined, 'full list mode does not also send the count');
  // edit_step still returns the full list (the sequence changed).
  const ed = await e.build_pipeline_model({ action: 'edit_step', context_id: s.context_id, index: 1, stage: { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'iap_purchase_failed' }] } });
  assert.ok(Array.isArray(ed.steps) && ed.steps.length === 3, 'edit_step returns the full reshuffled sequence');
});

// #1: by default add_steps returns a DIFF (what this stage changed), not the whole schema.
test('build_pipeline_model: add_steps returns a column diff by default', async () => {
  const e = engine();
  const s = await e.build_pipeline_model({ action: 'start', name: 'diff', source: 'events' });
  const a1 = await e.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, stages: [mr] });
  assert.equal(a1.available_columns, undefined, 'no full dump by default');
  assert.ok(typeof a1.column_count === 'number' && a1.column_count > 0);
  const added = stepEffect(a1).columns_added.map((c) => c.name);
  assert.ok(added.includes('reached_a') && added.includes('completed'), 'diff shows the funnel columns this stage added');
  // Compact diff: a step that drops many columns reports a COUNT, not ~200 names.
  assert.ok(typeof stepEffect(a1).columns_removed_count === 'number' && stepEffect(a1).columns_removed_count > 0);
  assert.equal(stepEffect(a1).columns_removed, undefined, 'long removed list omitted by default (count only)');
  // the carried partition key persists (NOT dropped) — verify via the full list.
  const full = await e.build_pipeline_model({ action: 'preview', context_id: s.context_id });
  assert.ok(full.available_columns.some((c) => c.name === 'player_id_of_internal'), 'partition key carried through, not removed');
  // aggregate then collapses to group keys + measures: prior event columns show as removed.
  const a2 = await e.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, stages: [{ stage: 'aggregate', group_by: ['completed'], measures: [{ name: 'n', agg: 'count' }] }] });
  assert.deepEqual(stepEffect(a2).columns_added.map((c) => c.name), ['n']); // group key 'completed' persisted; 'n' is new
  assert.ok((stepEffect(a2).columns_removed || []).includes('reached_a'), 'aggregated-away columns reported as removed (short list shown)');
  assert.equal(a2.column_count, 2);
});

test('build_pipeline_model: discard drops the draft; later actions error cleanly', async () => {
  const e = engine();
  const s = await e.build_pipeline_model({ action: 'start', name: 'inc', source: 'events' });
  await e.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, stages: [mr] });
  const d = await e.build_pipeline_model({ action: 'discard', context_id: s.context_id });
  assert.equal(d.discarded, true);
  await assert.rejects(() => e.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, stages: [mr] }), /no draft/i);
  await assert.rejects(() => e.build_pipeline_model({ action: 'preview', context_id: s.context_id }), /no draft/i);
});

test('build_pipeline_model: starting again in the same context resets the draft', async () => {
  const e = engine();
  const s = await e.build_pipeline_model({ action: 'start', name: 'first', source: 'events' });
  await e.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, stages: [mr] });
  // reuse the same context_id: a fresh start wipes prior stages + renames.
  const s2 = await e.build_pipeline_model({ action: 'start', context_id: s.context_id, name: 'second', source: 'events' });
  assert.equal(s2.context_id, s.context_id);
  assert.equal(s2.name, 'second');
  assert.deepEqual(s2.steps, []);
  const pv = await e.build_pipeline_model({ action: 'preview', context_id: s.context_id });
  assert.equal(pv.steps.length, 0);
});

test('build_pipeline_model: schema rejects malformed actions', async () => {
  const e = engine();
  await assert.rejects(() => e.build_pipeline_model({ action: 'start' }), 'start requires name');
  await assert.rejects(() => e.build_pipeline_model({ action: 'add_steps', context_id: 'ctx_deadbeef' }), 'add_steps requires stages');
  // one stage is a list of one: there is no second action for it
  await assert.rejects(() => e.build_pipeline_model({ action: 'add_step', context_id: 'ctx_deadbeef', stage: { stage: 'limit', limit: 1 } }), /add_steps/);
  await assert.rejects(() => e.build_pipeline_model({ action: 'bogus' }), 'unknown action rejected');
});

// Strictness: each action rejects fields that do not belong to it (no silent ignoring).
test('build_pipeline_model: schema rejects action-irrelevant fields', async () => {
  const e = engine();
  const s = await e.build_pipeline_model({ action: 'start', name: 'strict', source: 'events' });
  // start must not carry a stage.
  await assert.rejects(() => e.build_pipeline_model({ action: 'start', name: 'x', stage: mr }), 'start + stage rejected');
  // add_steps must not carry start-only fields.
  await assert.rejects(() => e.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, stages: [mr], source: 'events' }), 'add_steps + source rejected');
  await assert.rejects(() => e.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, stages: [mr], name: 'x' }), 'add_steps + name rejected');
  // preview/commit/discard take only context_id.
  await assert.rejects(() => e.build_pipeline_model({ action: 'preview', context_id: s.context_id, stage: mr }), 'preview + stage rejected');
  await assert.rejects(() => e.build_pipeline_model({ action: 'materialize', context_id: s.context_id, materialized: 'view' }), 'commit + materialized rejected');
  // start MAY carry context_id (legitimate context reuse) — not rejected.
  const reuse = await e.build_pipeline_model({ action: 'start', context_id: s.context_id, name: 'reused', source: 'events' });
  assert.equal(reuse.context_id, s.context_id);
});

// join with a `between` (point-in-time / SCD-2) window: accepted, validated, exposes attrs.
test('build_pipeline_model: join between (temporal window) validates and exposes joined columns', async () => {
  const e = engine();
  const s = await e.build_pipeline_model({ action: 'start', name: 'pit', source: 'events' });
  // value is a base (events) column; from/to are columns of the joined model.
  const ok = await e.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, stages: [{
    stage: 'join', with: 'users', via: { on: ['player_id_of_internal'] }, attrs: [{ column: 'country' }],
    between: { column: 'device_time', from: 'install_date', to: 'install_date' },
  }], include_columns: true });
  assert.ok(ok.available_columns.some((c) => c.name === 'country'), 'joined attr exposed');
  // it renders end-to-end (forces the ON-clause CTE form so the BETWEEN can be expressed).
  const pv = await e.build_pipeline_model({ action: 'preview', context_id: s.context_id });
  assert.ok(typeof pv.model_sql === 'string' && pv.model_sql.length > 0, 'pipeline renders with the between join');
  // a window bound that is not a column of the joined model is refused by the schema, naming its columns
  const s2 = await e.build_pipeline_model({ action: 'start', name: 'pit2', source: 'events' });
  await assert.rejects(
    () => e.build_pipeline_model({ action: 'add_steps', context_id: s2.context_id, stages: [{
      stage: 'join', with: 'users', via: { on: ['player_id_of_internal'] }, attrs: [{ column: 'country' }],
      between: { column: 'device_time', from: 'no_such_col', to: 'install_date' },
    }] }),
    /between\.from` must be one of: [^;]*install_time_valid_from/,
  );
});

// compute op=elapsed_days: the retention-day primitive is wired + input-validated at add_steps.
test('build_pipeline_model: compute elapsed_days adds an int column and requires from+to', async () => {
  const e = engine();
  const s = await e.build_pipeline_model({ action: 'start', name: 'ret', source: 'events' });
  // from an event timestamp to now → a whole-24h-day column (retention day).
  const ok = await e.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, stages: [{ stage: 'compute', name: 'ret_day', expr: { fn: 'elapsed_days', args: [{ column: 'device_time' }, { now: true }] } }], include_columns: true });
  const col = ok.available_columns.find((c) => c.name === 'ret_day');
  assert.ok(col && col.type === 'int', 'elapsed_days adds an int column');
  // missing an endpoint is rejected by schema (from+to both required).
  const s2 = await e.build_pipeline_model({ action: 'start', name: 'ret2', source: 'events' });
  await assert.rejects(() => e.build_pipeline_model({ action: 'add_steps', context_id: s2.context_id, stages: [{ stage: 'compute', name: 'bad', expr: { fn: 'elapsed_days', args: [{ column: 'device_time' }] } }] }), 'elapsed_days needs from AND to');
});

// #2: array ops are type-checked at add_steps (not only at commit/runtime).
test('build_pipeline_model: array op on a non-array column is rejected at add_steps', async () => {
  const e = engine();
  const s = await e.build_pipeline_model({ action: 'start', name: 'arr', source: 'events' });
  // array_last over a string column → rejected when the stage is ADDED, with a fix hint.
  await assert.rejects(
    () => e.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, stages: [{ stage: 'compute', name: 'last', expr: { fn: 'array_last', args: [{ column: 'player_id_of_internal' }] } }] }),
    /not an array/,
  );
  // correct flow: json_parse_array (string → array) first, then array_last passes validation.
  const s2 = await e.build_pipeline_model({ action: 'start', name: 'arr2', source: 'events' });
  await e.build_pipeline_model({ action: 'add_steps', context_id: s2.context_id, stages: [{ stage: 'compute', name: 'arr', expr: { fn: 'json_parse_array', args: [{ column: 'player_id_of_internal' }] } }] });
  const ok = await e.build_pipeline_model({ action: 'add_steps', context_id: s2.context_id, stages: [{ stage: 'compute', name: 'last', expr: { fn: 'array_last', args: [{ column: 'arr' }] } }] });
  assert.equal(ok.steps_count, 2, 'array_last on a parsed array column is accepted');
});

// Physical grounding: when a runner can introspect the relation, a catalog column the
// PHYSICAL table lacks is excluded from the referenceable set (and surfaced as
// not_materialized) — so referencing it is a clean "unknown column" at add_steps, never a
// raw warehouse "Unrecognized name" at commit. This is the level_number_of_state case.
test('build_pipeline_model grounds source columns to the physical relation', async () => {
  const catalog = loadCatalog(CATALOG, {});
  // Stub runner: the physical fct_analytics_events has these columns — NOTE it omits
  // 'complete_time_of_event_data' (declared in the fixture catalog, but "not materialized").
  const physical = ['player_id_of_internal', 'session_number', 'event_name', 'device_time', 'event_data', 'level_id_of_event_data', 'result_of_event_data', 'ad_type_of_event_data'];
  const runner = { relationColumns: async () => ({ ok: true, columns: physical.map((name) => ({ name })) }) };
  const e = settle(new Engine({ catalog, runner, contextManager: new ContextManager({ baseProjectDir: '/tmp/grounding', workspaceRoot: mkdtempSync(join(tmpdir(), 'gr-')) }) }));

  const s = await e.build_pipeline_model({ action: 'start', name: 'grounded', source: 'events', include_columns: true });
  const names = s.available_columns.map((c) => c.name);
  assert.ok(names.includes('result_of_event_data'), 'a physically-present column is offered');
  assert.ok(!names.includes('complete_time_of_event_data'), 'a phantom catalog column is NOT offered');
  // The phantom is silently dropped — the desync is an internal guard, not surfaced.
  assert.equal(s.not_materialized, undefined, 'grounding is silent — no not_materialized field');

  // a physically-present column builds fine through add_steps.
  await e.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, stages: [{ stage: 'where', conditions: [{ column: 'result_of_event_data', op: 'is_not_null' }] }] });
  // the phantom column is rejected as an UNKNOWN COLUMN at add_steps (early + clear), not at commit.
  await assert.rejects(
    () => e.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, stages: [{ stage: 'aggregate', group_by: ['complete_time_of_event_data'], measures: [{ name: 'n', agg: 'count' }] }] }),
    /unknown column 'complete_time_of_event_data'/,
  );
  const pv = await e.build_pipeline_model({ action: 'preview', context_id: s.context_id });
  assert.equal(pv.steps.length, 1, 'the rejected phantom step was not persisted');
});

// No runner → grounding is skipped (physical truth unknown): declared columns are used
// as-is, exactly as before, so offline/test behaviour is unchanged.
test('build_pipeline_model: grounding is skipped without a runner (declared columns as-is)', async () => {
  const e = engine(); // no runner
  const s = await e.build_pipeline_model({ action: 'start', name: 'noground', source: 'events', include_columns: true });
  assert.ok(s.available_columns.some((c) => c.name === 'complete_time_of_event_data'), 'declared column offered (cannot verify physically offline)');
  assert.equal(s.not_materialized, undefined);
});

// add_steps: several stages at once, with the per-step effect of each folded into one reply.
test('build_pipeline_model: add_steps applies several stages at once with a per-step breakdown', async () => {
  const e = engine();
  const s = await e.build_pipeline_model({ action: 'start', name: 'multi', source: 'events' });
  const r = await e.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, stages: [
    { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'first_launch' }] },
    mr,
    { stage: 'aggregate', group_by: ['completed'], measures: [{ name: 'n', agg: 'count' }] },
  ] });
  assert.equal(r.action, 'add_steps');
  assert.equal(r.added, 3);
  assert.equal(r.step_effects.length, 3, 'one effect entry per applied stage, in order');
  assert.deepEqual(r.step_effects.map((x) => x.stage), ['where', 'match_recognize', 'aggregate']);
  assert.ok(r.step_effects.every((x) => typeof x.column_count === 'number' && Array.isArray(x.columns_added)), 'each effect reports the column delta');
  // the steps just added are echoed (with the count); the whole list only when asked for
  assert.deepEqual([r.steps_added.length, r.steps_count, r.steps], [3, 3, undefined]);
  const more = await e.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, stages: [{ stage: 'limit', limit: 5 }], include_steps: true });
  assert.deepEqual([more.steps.length, more.steps_added], [4, undefined]);
  const one = await e.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, stages: [{ stage: 'limit', limit: 3 }] });
  assert.deepEqual([one.steps_added.map((x) => x.index), one.steps_count], [[5], 5]);
});

test('build_pipeline_model: add_steps is atomic — a bad stage rolls back the whole batch', async () => {
  const e = engine();
  const s = await e.build_pipeline_model({ action: 'start', name: 'atomic', source: 'events' });
  await assert.rejects(
    () => e.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, stages: [
      { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'first_launch' }] },
      { stage: 'aggregate', group_by: ['no_such_col'], measures: [{ name: 'n', agg: 'count' }] }, // breaks
    ] }),
    /none of the 2 stages was added/,
  );
  const pv = await e.build_pipeline_model({ action: 'preview', context_id: s.context_id });
  assert.equal(pv.steps.length, 0, 'atomic: nothing applied, draft untouched');
});

// A refused stage is named by its place in `stages` — add_steps' own field — one stage or several.
test('build_pipeline_model: a refused stage of add_steps is stages[i], whether one is sent or several', async () => {
  const e = engine();
  const s = await e.build_pipeline_model({ action: 'start', name: 'field', source: 'events' });
  await e.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, stages: [{ stage: 'limit', limit: 5 }] });
  const bad = { stage: 'where', conditions: [{ column: 'no_such_col', op: 'eq', value: 1 }] };
  const alone = await e.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, stages: [bad] }).catch((err) => err);
  assert.equal(alone.field, 'stages[0]');
  assert.match(alone.message, /^stages\[0\]: step 2: /);
  const second = await e.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, stages: [{ stage: 'limit', limit: 3 }, bad] }).catch((err) => err);
  assert.equal(second.field, 'stages[1]');
  assert.match(second.message, /^stages\[1\]: step 3: /);
  assert.equal((await e.build_pipeline_model({ action: 'preview', context_id: s.context_id })).steps.length, 1, 'nothing of either was added');
});

// A count counts rows without a column; a sketch (hll_*) reads one, like every other function.
test('build_pipeline_model: an aggregate measure without a column is a count only — a sketch is refused without one', async () => {
  const e = engine();
  const s = await e.build_pipeline_model({ action: 'start', name: 'hll', source: 'events' });
  for (const agg of ['hll_init', 'hll_merge', 'hll_merge_partial']) {
    await assert.rejects(
      () => e.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, stages: [{ stage: 'aggregate', group_by: ['event_name'], measures: [{ name: 'x', agg }] }] }),
      (err) => err.stage === 'validate' && /column/.test(err.message) && !/unsafe SQL identifier/.test(err.message),
      agg,
    );
  }
  const ok = await e.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, stages: [{ stage: 'aggregate', group_by: ['event_name'], measures: [{ name: 'players', agg: 'hll_init', column: 'player_id_of_internal' }, { name: 'n', agg: 'count' }] }], include_columns: true });
  assert.deepEqual(ok.available_columns.map((c) => [c.name, c.type]), [['event_name', 'string'], ['players', 'sketch'], ['n', 'numeric']]);
});

// data_freshness = live MAX(time), re-queried once per INDEX SCAN (not on a wall-clock timer).
test('data_freshness re-queries after each index scan (reflects new data, not a frozen MAX)', async () => {
  const catalog = loadCatalog(CATALOG, {});
  let maxTime = '2026-07-10T00:00:00Z';
  const runner = { show: async (_d, sql) => (/MAX\(/.test(sql) ? { ok: true, rows: [{ latest: maxTime }] } : { ok: true, rows: [] }) };
  const e = settle(new Engine({ catalog, runner, contextManager: new ContextManager({ baseProjectDir: '/tmp/fresh', workspaceRoot: mkdtempSync(join(tmpdir(), 'fr-')) }) }));
  assert.equal(await e.probe.dataFreshness('events'), '2026-07-10T00:00:00Z', 'first read = MAX(device_time)');
  maxTime = '2026-07-21T00:00:00Z'; // new data lands
  assert.equal(await e.probe.dataFreshness('events'), '2026-07-10T00:00:00Z', 'between scans: still the cached value');
  // an index scan completes → bumps the sync generation → freshness must re-query.
  e.valueIndex.finishRun(e.valueIndex.startRun());
  assert.equal(await e.probe.dataFreshness('events'), '2026-07-21T00:00:00Z', 'after the scan: re-queried, reflects the newer MAX');
  e.close();
});

// ── P1: pointwise editing — edit/insert/delete/truncate mutate in place + revalidate ──
test('build_pipeline_model: edit_step / insert_step / delete_step / truncate mutate in place', async () => {
  const e = engine();
  const s = await e.build_pipeline_model({ action: 'start', name: 'edit', source: 'events' });
  const d = s.context_id;
  await e.build_pipeline_model({ action: 'add_steps', context_id: d, stages: [{ stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'first_launch' }] }] });
  await e.build_pipeline_model({ action: 'add_steps', context_id: d, stages: [mr] });
  // edit step 1 in place (replace the where literal) — count unchanged.
  const ed = await e.build_pipeline_model({ action: 'edit_step', context_id: d, index: 1, stage: { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'tutorial' }] } });
  assert.equal(ed.action, 'edit_step');
  assert.equal(ed.steps[0].conditions[0].value, 'tutorial', 'step 1 replaced in place');
  assert.equal(ed.steps.length, 2, 'edit does not change the step count');
  // insert a new step BEFORE position 1.
  const ins = await e.build_pipeline_model({ action: 'insert_step', context_id: d, index: 1, stage: { stage: 'where', conditions: [{ column: 'event_name', op: 'in', value: ['tutorial', 'first_launch'] }] } });
  assert.equal(ins.steps.length, 3);
  assert.equal(ins.steps[0].conditions[0].op, 'in', 'inserted at the front');
  // delete step 2.
  const del = await e.build_pipeline_model({ action: 'delete_step', context_id: d, index: 2 });
  assert.equal(del.steps.length, 2);
  // truncate back to a single step (the cheap "go back to step N").
  const tr = await e.build_pipeline_model({ action: 'truncate', context_id: d, after: 1 });
  assert.equal(tr.steps.length, 1);
  // out-of-range index/after are rejected.
  await assert.rejects(() => e.build_pipeline_model({ action: 'edit_step', context_id: d, index: 9, stage: mr }), /out of range/);
  await assert.rejects(() => e.build_pipeline_model({ action: 'truncate', context_id: d, after: 9 }), /out of range/);
});

// An edit that breaks a LATER step is rejected with that step's index; the draft is intact.
test('build_pipeline_model: an edit breaking a downstream step reports the step index, draft intact', async () => {
  const e = engine();
  const s = await e.build_pipeline_model({ action: 'start', name: 'brk', source: 'events' });
  const d = s.context_id;
  await e.build_pipeline_model({ action: 'add_steps', context_id: d, stages: [mr] }); // step 1: funnel exposes reached_a/completed
  await e.build_pipeline_model({ action: 'add_steps', context_id: d, stages: [{ stage: 'where', conditions: [{ column: 'completed', op: 'eq', value: true }] }] }); // step 2 uses 'completed'
  // replacing step 1 with a plain where removes 'completed' → step 2 can no longer reference it.
  await assert.rejects(
    () => e.build_pipeline_model({ action: 'edit_step', context_id: d, index: 1, stage: { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'first_launch' }] } }),
    /step 2/,
  );
  const pv = await e.build_pipeline_model({ action: 'preview', context_id: d });
  assert.equal(pv.steps.length, 2, 'draft left intact after a rejected edit');
  assert.equal(pv.steps[0].stage, 'match_recognize', 'step 1 unchanged');
});

// fork branches a NEW draft from a prefix WITHOUT touching the original.
test('build_pipeline_model: fork branches a new draft from step N; original untouched', async () => {
  const e = engine();
  const s = await e.build_pipeline_model({ action: 'start', name: 'orig', source: 'events' });
  const d = s.context_id;
  await e.build_pipeline_model({ action: 'add_steps', context_id: d, stages: [mr] });
  await e.build_pipeline_model({ action: 'add_steps', context_id: d, stages: [{ stage: 'aggregate', group_by: ['completed'], measures: [{ name: 'n', agg: 'count' }] }] });
  const fk = await e.build_pipeline_model({ action: 'fork', context_id: d, after: 1 });
  assert.notEqual(fk.context_id, d, 'fork is a NEW draft');
  assert.equal(fk.copied_steps, 1);
  assert.equal(fk.steps.length, 1, 'only the kept prefix copied');
  // the fork diverges independently; the source draft is never mutated.
  const f2 = await e.build_pipeline_model({ action: 'add_steps', context_id: fk.context_id, stages: [{ stage: 'aggregate', group_by: ['reached_a'], measures: [{ name: 'm', agg: 'count' }] }] });
  assert.equal(f2.steps_count, 2);
  const orig = await e.build_pipeline_model({ action: 'preview', context_id: d });
  assert.equal(orig.steps.length, 2, 'source draft untouched by the fork or its edits');
  assert.equal(orig.steps[1].stage, 'aggregate');
});

// P3: a one_per_match funnel warns to filter completed=true (counts all starts otherwise).
test('build_pipeline_model: one_per_match funnel warns to filter completed', async () => {
  const e = engine();
  const s = await e.build_pipeline_model({ action: 'start', name: 'opm', source: 'events' });
  const a = await e.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, stages: [{ ...mr, rows: 'one_per_match' }] });
  assert.ok(stepNotes(a).some((r) => /one_per_match/.test(r) && /completed/.test(r)), 'warns that one_per_match counts all starts unless completed is filtered');
  // one_per_partition (default) does NOT raise the completed warning.
  const s2 = await e.build_pipeline_model({ action: 'start', name: 'opp', source: 'events' });
  const a2 = await e.build_pipeline_model({ action: 'add_steps', context_id: s2.context_id, stages: [mr] });
  assert.ok(!stepNotes(a2).some((r) => /one_per_match/.test(r)), 'no one_per_match warning for one_per_partition');
});

// P4: limit + transform.limit both cap rows — together they'd emit two LIMITs (SQL error).
// The guard rejects the ambiguity; either source alone reads fine.
test('drill_result reads only a drawn task, by the path and level of its card — never a projection of the caller\'s', async () => {
  const catalog = loadCatalog(CATALOG, {});
  const runner = { show: async () => ({ ok: true, rows: [{ a: 1 }], columns: [{ name: 'a' }] }) };
  const e = settle(new Engine({ catalog, runner, contextManager: new ContextManager({ baseProjectDir: '/tmp/gqr', workspaceRoot: mkdtempSync(join(tmpdir(), 'gqr-')) }) }));
  // the card names the path and the level; the view is the server's, made from the card as drawn
  await assert.rejects(() => e.drill_result({ task_id: 'abcdef123456', limit: 5, transform: { limit: 3 } }), /unexpected property 'transform'/);
  // a task that was never drawn is not a card's to read
  const task_id = e.jobs.create({ tool: 'query_semantic_model' });
  e.jobs.ready(task_id);
  await assert.rejects(() => e.drill_result({ task_id }), /not drawn/);
});

// ── add_steps refusals moved from the integration suites: each is decided by the schema and the
// catalog when the step is added, before any SQL exists, so no warehouse is read. ──

/** Start a draft over `source` and add one stage to it (a refusal throws). */
async function addOne(e, source, stage) {
  const s = await e.build_pipeline_model({ action: 'start', name: 'guard_step', source });
  return e.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, stages: [stage] });
}

// (from test/integration/declared-joins.test.js)
test('join guards: an undeclared relationship, a self-join and a top-level on are all rejected', async () => {
  const e = engine();
  await assert.rejects(() => addOne(e, 'events', { stage: 'join', with: 'experiments', via: 'ad_funnel_rewarded', attrs: [{ column: 'variant_group' }] }),
    /`stages\.0\.via` must be "user"/, 'the schema offers only the relationships the joined model shares');
  await assert.rejects(() => addOne(e, 'events', { stage: 'join', with: 'events', via: 'user', attrs: [{ column: 'event_name', name: 'other_event' }] }), /own source/);
  await assert.rejects(() => addOne(e, 'events', { stage: 'join', with: 'users', via: 'user', on: ['player_id_of_internal'], attrs: [{ column: 'country' }] }), /unexpected property 'on'/, 'how the rows match is one field, via: a relationship or { on }');
});

// (from test/integration/declared-joins.test.js, 48.) Every way a name can end up used twice is
// refused, with the reason and the rename. The join key is called out separately: its value is the
// same on both sides, so the copy is not something to rename — it is something to drop. (The rename
// the error prints, built with both sides present, is mcp-end-to-end.test.js #5(c).)
test('48. duplicate names and unknown columns are refused with the fix', async () => {
  const e = engine();
  // (a) attrs missing entirely — the error lists what the model actually offers.
  await assert.rejects(
    () => addOne(e, 'crashlytics', { stage: 'join', with: 'acquisition', via: 'user' }),
    (err) => {
      assert.match(err.message, /missing required property 'attrs' — a list of \{ column, … \}, column one of: .*cost.*impressions.*clicks/s, '(a) attrs missing');
      return true;
    },
  );
  // (b) a column the joined model does not have.
  await assert.rejects(
    () => addOne(e, 'crashlytics', { stage: 'join', with: 'acquisition', via: 'user', attrs: [{ column: 'cost' }, { column: 'nope' }] }),
    /`stages\.0\.attrs\.1\.column` must be one of: .*cost/s,
    '(b) a column the joined model does not have',
  );
  // (c) a name the pipeline already carries, holding DIFFERENT data → rename it.
  await assert.rejects(
    () => addOne(e, 'crashlytics', { stage: 'join', with: 'events', via: 'ad_funnel_rewarded', attrs: [{ column: 'event_name' }] }),
    (err) => {
      assert.match(err.message, /already has a column named 'event_name'/, '(c) the name already carried');
      assert.match(err.message, /hold different data.*name: 'events_event_name'/s, '(c) the rename to apply');
      return true;
    },
  );
  // (d) the same name, but it is the JOIN KEY → the pipeline's column already holds that value.
  await assert.rejects(
    () => addOne(e, 'crashlytics', { stage: 'join', with: 'events', via: 'ad_funnel_rewarded', attrs: [{ column: 'player_id_of_internal' }] }),
    /is the join key.*holds the same value — drop it from attrs/s,
    '(d) the join key',
  );
  // (e) two entries resolving to one name.
  await assert.rejects(
    () => addOne(e, 'crashlytics', {
      stage: 'join', with: 'events', via: 'ad_funnel_rewarded',
      attrs: [{ column: 'event_id', name: 'x' }, { column: 'tracking_id', name: 'x' }],
    }),
    /'event_id' and 'tracking_id' would both be named 'x'/,
    '(e) two entries, one name',
  );
});

// (from test/integration/crashlytics-fact.test.js) A funnel runs over ONE fact: an event of the
// OTHER fact is rejected outright rather than silently matching nothing.
test('an event of the other fact is rejected in a crash-fact funnel', async () => {
  const e = engine();
  const a = await addOne(e, 'crashlytics', {
    stage: 'match_recognize',
    partition_by: ['player_id_of_internal'],
    steps: [
      { name: 'launch', event_name: ['first_launch'] },
      { name: 'crash', event_name: ['fatal_crash'] },
    ],
  }).catch((err) => ({ error: { message: err.message } }));
  assert.ok(a.error, 'a cross-fact step is refused');
  assert.match(String(a.error.message), /first_launch/);
});

// (from test/integration/crashlytics-complex-types.test.js, 14.) A complex op on a column that is
// not complex is refused, naming what the column IS — rather than building array SQL over text and
// failing in the warehouse.
test('14. complex ops on a scalar column are refused with what it actually is', async () => {
  const e = engine();
  // an unnest names only an array property: a scalar one is not among those it offers
  await assert.rejects(
    () => addOne(e, 'crashlytics', { stage: 'unnest', property: 'issue_title_of_event_data', name: 'x' }),
    /`stages\.0\.property` must be one of: .*breadcrumbs_of_event_data/,
  );
  await assert.rejects(
    () => addOne(e, 'crashlytics', { stage: 'compute', name: 'x', expr: { fn: 'array_length', property: 'issue_title_of_event_data' } }),
    /array_length: 'issue_title_of_event_data' is declared as string, not an array/,
  );
  // the custom-keys column holds a JSON OBJECT, so an array op is wrong there too — and the
  // message points at the read that IS right for an object.
  await assert.rejects(
    () => addOne(e, 'crashlytics', { stage: 'compute', name: 'x', expr: { fn: 'array_contains', property: 'custom_keys_of_event_data', item: 'wifi' } }),
    /array_contains: 'custom_keys_of_event_data'.*not an array.*fn: "event_property", property, field/s,
  );
  // element_at needs a native array, not the raw JSON string.
  await assert.rejects(
    () => addOne(e, 'crashlytics', { stage: 'compute', name: 'x', expr: { fn: 'element_at', args: [{ column: 'breadcrumbs_of_event_data' }], index: 1 } }),
    /not an array — produce an array first.*json_parse_array/s,
  );
});

// (from test/integration/match-recognize.test.js) A dry run renders the pipeline and builds nothing:
// no runner is wired here, so nothing could be built.
test('_buildPipeline: dry_run returns SQL without building', async () => {
  const e = engine();
  const dr = await e._buildPipeline({ name: 'dry_pipe', dry_run: true, pipeline: { source: 'events', stages: [{ stage: 'aggregate', group_by: [], measures: [{ name: 'n', agg: 'count' }] }] } });
  assert.equal(dr.dry_run, true);
  assert.equal(dr.kind, 'pipeline');
  assert.equal(typeof dr.model_sql, 'string');
  // SQL is rendered in the ACTIVE warehouse dialect only — no second-dialect blob.
  assert.equal(dr.dialect, e.catalog.dialect);
  assert.equal(dr.model_sql_bigquery, undefined);
});