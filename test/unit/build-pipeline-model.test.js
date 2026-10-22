import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { settle, stepNotes, stepEffect } from '../helpers/settle.js';
import { tempDir } from '../helpers/temp-dir.js';

// Allowed non-data test: build_model's draft LIFECYCLE + input validation are
// pure schema/state machinery (renderPipeline folds columns WITHOUT a warehouse), so no
// runner is wired and nothing is materialized. We assert on draft state + column
// propagation + error guards — never on generated SQL text.
const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));

function engine() {
  const catalog = loadCatalog(CATALOG, {});
  return settle(new Engine({ catalog, contextManager: new ContextManager({ workspaceRoot: tempDir('bnm') }) }));
}

const mr = { stage: 'match_recognize', partition_by: ['player_id_of_internal'], steps: [{ name: 'a', event_name: ['first_launch'] }, { name: 'b', event_name: ['tutorial'] }] };

test('build_model: start returns a draft + source column count (full list on include columns)', async () => {
  const e = engine();
  const s = await e.build_model({ action: 'start', name: 'inc', source: 'events' });
  assert.match(s.context_id, /\w+/);
  assert.equal(s.action, 'start');
  assert.deepEqual(s.steps, []);
  assert.ok(s.column_count > 0, 'source column count reported');
  assert.equal(s.available_columns, undefined, 'full list not dumped by default');
  // opt in to the full list.
  const full = await e.build_model({ action: 'start', name: 'inc2', source: 'events', include: ['columns'] });
  assert.ok(full.available_columns.some((c) => c.name === 'player_id_of_internal'), 'source columns surfaced with include columns');
  assert.ok(Array.isArray(s.recommendations) && s.recommendations.length > 0);
});

test('build_model: add_steps propagates columns; bad step is rejected without mutating the draft', async () => {
  const e = engine();
  const s = await e.build_model({ action: 'start', name: 'inc', source: 'events' });
  const a1 = await e.build_model({ action: 'add_steps', context_id: s.context_id, steps: [mr], include: ['columns'] });
  assert.equal(stepEffect(a1).step_index, 1);
  const cols = a1.available_columns.map((c) => c.name);
  assert.ok(cols.includes('player_id_of_internal'), 'partition key carried');
  assert.ok(cols.includes('reached_a') && cols.includes('completed'), 'funnel output columns available');
  // a second stage references the funnel output produced by the first.
  const a2 = await e.build_model({ action: 'add_steps', context_id: s.context_id, steps: [{ stage: 'aggregate', group_by: ['completed'], measures: [{ name: 'n', expr: { fn: 'count' } }] }], include: ['columns'] });
  assert.equal(stepEffect(a2).step_index, 2);
  assert.deepEqual(a2.available_columns.map((c) => c.name), ['completed', 'n']);
  // a stage referencing a missing column is rejected and NOT persisted.
  await assert.rejects(() => e.build_model({ action: 'add_steps', context_id: s.context_id, steps: [{ stage: 'project', keep: ['no_such_col'] }] }));
  const pv = await e.build_model({ action: 'preview', context_id: s.context_id });
  assert.equal(pv.steps.length, 2, 'rejected step not persisted');
  assert.ok(typeof pv.model_sql === 'string' && pv.model_sql.length > 0, 'preview renders SQL (schema-only)');
});

// add_steps is append-only, so it echoes ONLY the applied step (+ steps_count), not the growing
// steps array — the O(n²) token saver. include: ['steps'] restores the full list on demand.
test('build_model: add_steps returns only the applied step by default; include steps gives the full list', async () => {
  const e = engine();
  const s = await e.build_model({ action: 'start', name: 'lean', source: 'events' });
  await e.build_model({ action: 'add_steps', context_id: s.context_id, steps: [{ stage: 'where', conditions: [{ fn: 'eq', args: [{ column: 'event_name' }, { value: 'iap_purchase_completed' }] }] }] });
  const a2 = await e.build_model({ action: 'add_steps', context_id: s.context_id, steps: [{ stage: 'aggregate', group_by: ['currency_of_event_data'], measures: [{ name: 'n', expr: { fn: 'count' } }] }] });
  // lean by default: the applied step + a count, NOT the whole steps array.
  assert.equal(a2.steps, undefined, 'the growing steps array is not re-echoed on add_steps');
  assert.equal(a2.steps_count, 2, 'steps_count reports the pipeline length');
  assert.equal(a2.steps_added[a2.steps_added.length - 1].stage, 'aggregate', 'the applied step is returned');
  assert.equal(a2.steps_added[a2.steps_added.length - 1].index, 2);
  assert.ok(stepNotes(a2).some((r) => /include: \["steps"\]|preview/.test(r)), 'recommendation points to the full-list drill');
  // opt back in to the full list.
  const a3 = await e.build_model({ action: 'add_steps', context_id: s.context_id, steps: [{ stage: 'order_by', keys: [{ key: 'n', direction: 'desc' }] }], include: ['steps'] });
  assert.ok(Array.isArray(a3.steps) && a3.steps.length === 3, 'include steps returns the full steps array');
  assert.equal(a3.steps_count, undefined, 'full list mode does not also send the count');
  // an edit answers alike: the step it put in place + the count; the full list only when asked for
  const where = { stage: 'where', conditions: [{ fn: 'eq', args: [{ column: 'event_name' }, { value: 'iap_purchase_failed' }] }] };
  const ed = await e.build_model({ action: 'edit_step', context_id: s.context_id, index: 1, step: where });
  assert.deepEqual([ed.steps, ed.step.index, ed.step.stage, ed.steps_count], [undefined, 1, 'where', 3], 'edit_step returns the step it placed and the count');
  const full = await e.build_model({ action: 'edit_step', context_id: s.context_id, index: 1, step: where, include: ['steps'] });
  assert.deepEqual([full.steps.length, full.step, full.steps_count], [3, undefined, undefined], 'include steps returns the full sequence');
});

// #1: by default add_steps returns a DIFF (what this stage changed), not the whole schema.
test('build_model: add_steps returns a column diff by default', async () => {
  const e = engine();
  const s = await e.build_model({ action: 'start', name: 'diff', source: 'events' });
  const a1 = await e.build_model({ action: 'add_steps', context_id: s.context_id, steps: [mr] });
  assert.equal(a1.available_columns, undefined, 'no full dump by default');
  assert.ok(typeof a1.column_count === 'number' && a1.column_count > 0);
  const added = stepEffect(a1).columns_added.map((c) => c.name);
  assert.ok(added.includes('reached_a') && added.includes('completed'), 'diff shows the funnel columns this stage added');
  // Compact diff: a step that drops many columns reports a COUNT, not ~200 names.
  assert.ok(typeof stepEffect(a1).columns_removed_count === 'number' && stepEffect(a1).columns_removed_count > 0);
  assert.equal(stepEffect(a1).columns_removed, undefined, 'long removed list omitted by default (count only)');
  // the carried partition key persists (NOT dropped) — verify via the full list.
  const full = await e.build_model({ action: 'preview', context_id: s.context_id });
  assert.ok(full.available_columns.some((c) => c.name === 'player_id_of_internal'), 'partition key carried through, not removed');
  // aggregate then collapses to group keys + measures: prior event columns show as removed.
  const a2 = await e.build_model({ action: 'add_steps', context_id: s.context_id, steps: [{ stage: 'aggregate', group_by: ['completed'], measures: [{ name: 'n', expr: { fn: 'count' } }] }] });
  assert.deepEqual(stepEffect(a2).columns_added.map((c) => c.name), ['n']); // group key 'completed' persisted; 'n' is new
  assert.ok((stepEffect(a2).columns_removed || []).includes('reached_a'), 'aggregated-away columns reported as removed (short list shown)');
  assert.equal(a2.column_count, 2);
});

test('build_model: discard drops the draft; later actions error cleanly', async () => {
  const e = engine();
  const s = await e.build_model({ action: 'start', name: 'inc', source: 'events' });
  await e.build_model({ action: 'add_steps', context_id: s.context_id, steps: [mr] });
  const d = await e.build_model({ action: 'discard', context_id: s.context_id });
  assert.equal(d.discarded, true);
  await assert.rejects(() => e.build_model({ action: 'add_steps', context_id: s.context_id, steps: [mr] }), /no draft/i);
  await assert.rejects(() => e.build_model({ action: 'preview', context_id: s.context_id }), /no draft/i);
});

test('build_model: starting again in the same context resets the draft', async () => {
  const e = engine();
  const s = await e.build_model({ action: 'start', name: 'first', source: 'events' });
  await e.build_model({ action: 'add_steps', context_id: s.context_id, steps: [mr] });
  // reuse the same context_id: a fresh start wipes prior steps + renames.
  const s2 = await e.build_model({ action: 'start', context_id: s.context_id, name: 'second', source: 'events' });
  assert.equal(s2.context_id, s.context_id);
  assert.equal(s2.name, 'second');
  assert.deepEqual(s2.steps, []);
  const pv = await e.build_model({ action: 'preview', context_id: s.context_id });
  assert.equal(pv.steps.length, 0);
});

test('build_model: schema rejects malformed actions', async () => {
  const e = engine();
  await assert.rejects(() => e.build_model({ action: 'start' }), 'start requires name');
  await assert.rejects(() => e.build_model({ action: 'add_steps', context_id: 'ctx_deadbeef' }), 'add_steps requires steps');
  // one step is a list of one: there is no second action for it
  await assert.rejects(() => e.build_model({ action: 'add_step', context_id: 'ctx_deadbeef', step: { stage: 'limit', limit: 1 } }), /add_steps/);
  await assert.rejects(() => e.build_model({ action: 'bogus' }), 'unknown action rejected');
});

// Strictness: each action rejects fields that do not belong to it (no silent ignoring).
test('build_model: schema rejects action-irrelevant fields', async () => {
  const e = engine();
  const s = await e.build_model({ action: 'start', name: 'strict', source: 'events' });
  // start must not carry a step (its first ones are `steps`).
  await assert.rejects(() => e.build_model({ action: 'start', name: 'strict_step', source: 'events', step: mr }), /unexpected property 'step'/, 'start + step rejected');
  // add_steps must not carry start-only fields.
  await assert.rejects(() => e.build_model({ action: 'add_steps', context_id: s.context_id, steps: [mr], source: 'events' }), 'add_steps + source rejected');
  await assert.rejects(() => e.build_model({ action: 'add_steps', context_id: s.context_id, steps: [mr], name: 'x' }), 'add_steps + name rejected');
  // preview/commit/discard take only context_id.
  await assert.rejects(() => e.build_model({ action: 'preview', context_id: s.context_id, step: mr }), 'preview + step rejected');
  await assert.rejects(() => e.build_model({ action: 'materialize', context_id: s.context_id, materialized: 'view' }), 'commit + materialized rejected');
  // start MAY carry context_id (legitimate context reuse) — not rejected.
  const reuse = await e.build_model({ action: 'start', context_id: s.context_id, name: 'reused', source: 'events' });
  assert.equal(reuse.context_id, s.context_id);
});

// a join on its contract: every part named — for a slowly-changing model the moment of the version.
test('build_model: a join names its contract\'s parts and exposes the joined columns', async () => {
  const e = engine();
  const s = await e.build_model({ action: 'start', name: 'pit', source: 'events' });
  const ok = await e.build_model({ action: 'add_steps', context_id: s.context_id, steps: [{
    stage: 'join', source: 'users', on: { user: 'player_id_of_internal', time: 'device_time' }, attrs: [{ column: 'country' }],
  }], include: ['columns'] });
  assert.ok(ok.available_columns.some((c) => c.name === 'country'), 'joined attr exposed');
  const pv = await e.build_model({ action: 'preview', context_id: s.context_id });
  assert.ok(typeof pv.model_sql === 'string' && pv.model_sql.length > 0, 'pipeline renders with the windowed join');
  // a part left out is refused by the schema: the contract is closed, every part required
  const s2 = await e.build_model({ action: 'start', name: 'pit2', source: 'events' });
  await assert.rejects(
    () => e.build_model({ action: 'add_steps', context_id: s2.context_id, steps: [{ stage: 'join', source: 'users', on: { user: 'player_id_of_internal' }, attrs: [{ column: 'country' }] }] }),
    /`steps\.0\.on` is missing required property 'time'/,
  );
  // …and a part's column must be one of the rows
  await assert.rejects(
    () => e.build_model({ action: 'add_steps', context_id: s2.context_id, steps: [{ stage: 'join', source: 'users', on: { user: 'player_id_of_internal', time: 'no_such_col' }, attrs: [{ column: 'country' }] }] }),
    /no_such_col/,
  );
});

// compute op=elapsed_days: the retention-day primitive is wired + input-validated at add_steps.
test('build_model: compute elapsed_days adds an int column and requires from+to', async () => {
  const e = engine();
  const s = await e.build_model({ action: 'start', name: 'ret', source: 'events' });
  // from an event timestamp to now → a whole-24h-day column (retention day).
  const ok = await e.build_model({ action: 'add_steps', context_id: s.context_id, steps: [{ stage: 'compute', name: 'ret_day', expr: { fn: 'elapsed_days', args: [{ column: 'device_time' }, { now: true }] } }], include: ['columns'] });
  const col = ok.available_columns.find((c) => c.name === 'ret_day');
  assert.ok(col && col.type === 'int', 'elapsed_days adds an int column');
  // missing an endpoint is rejected by schema (from+to both required).
  const s2 = await e.build_model({ action: 'start', name: 'ret2', source: 'events' });
  await assert.rejects(() => e.build_model({ action: 'add_steps', context_id: s2.context_id, steps: [{ stage: 'compute', name: 'bad', expr: { fn: 'elapsed_days', args: [{ column: 'device_time' }] } }] }), 'elapsed_days needs from AND to');
});

// #2: array ops are type-checked at add_steps (not only at commit/runtime).
test('build_model: array op on a non-array column is rejected at add_steps', async () => {
  const e = engine();
  const s = await e.build_model({ action: 'start', name: 'arr', source: 'events' });
  // array_last over a string column → rejected when the stage is ADDED, with a fix hint.
  await assert.rejects(
    () => e.build_model({ action: 'add_steps', context_id: s.context_id, steps: [{ stage: 'compute', name: 'last', expr: { fn: 'array_last', args: [{ column: 'player_id_of_internal' }] } }] }),
    /not an array/,
  );
  // correct flow: json_parse_array (string → array) first, then array_last passes validation.
  const s2 = await e.build_model({ action: 'start', name: 'arr2', source: 'events' });
  await e.build_model({ action: 'add_steps', context_id: s2.context_id, steps: [{ stage: 'compute', name: 'arr', expr: { fn: 'json_parse_array', args: [{ column: 'player_id_of_internal' }] } }] });
  const ok = await e.build_model({ action: 'add_steps', context_id: s2.context_id, steps: [{ stage: 'compute', name: 'last', expr: { fn: 'array_last', args: [{ column: 'arr' }] } }] });
  assert.equal(ok.steps_count, 2, 'array_last on a parsed array column is accepted');
});

// Physical grounding: when a runner can introspect the relation, a catalog column the
// PHYSICAL table lacks is excluded from the referenceable set (and surfaced as
// not_materialized) — so referencing it is a clean "unknown column" at add_steps, never a
// raw warehouse "Unrecognized name" at commit. This is the level_number_of_state case.
test('build_model grounds source columns to the physical relation', async () => {
  const catalog = loadCatalog(CATALOG, {});
  // Stub runner: the physical fct_analytics_events has these columns — NOTE it omits
  // 'complete_time_of_event_data' (declared in the fixture catalog, but "not materialized").
  const physical = ['player_id_of_internal', 'session_number', 'event_name', 'device_time', 'event_data', 'level_id_of_event_data', 'result_of_event_data', 'ad_type_of_event_data'];
  const runner = { relationColumns: async () => ({ ok: true, columns: physical.map((name) => ({ name })) }) };
  const e = settle(new Engine({ catalog, runner, contextManager: new ContextManager({ baseProjectDir: '/tmp/grounding', workspaceRoot: tempDir('gr') }) }));

  const s = await e.build_model({ action: 'start', name: 'grounded', source: 'events', include: ['columns'] });
  const names = s.available_columns.map((c) => c.name);
  assert.ok(names.includes('result_of_event_data'), 'a physically-present column is offered');
  assert.ok(!names.includes('complete_time_of_event_data'), 'a phantom catalog column is NOT offered');
  // The phantom is silently dropped — the desync is an internal guard, not surfaced.
  assert.equal(s.not_materialized, undefined, 'grounding is silent — no not_materialized field');

  // a physically-present column builds fine through add_steps.
  await e.build_model({ action: 'add_steps', context_id: s.context_id, steps: [{ stage: 'where', conditions: [{ fn: 'is_not_null', args: [{ column: 'result_of_event_data' }] }] }] });
  // the phantom column is rejected as an UNKNOWN COLUMN at add_steps (early + clear), not at commit.
  await assert.rejects(
    () => e.build_model({ action: 'add_steps', context_id: s.context_id, steps: [{ stage: 'aggregate', group_by: ['complete_time_of_event_data'], measures: [{ name: 'n', expr: { fn: 'count' } }] }] }),
    /unknown column 'complete_time_of_event_data'/,
  );
  const pv = await e.build_model({ action: 'preview', context_id: s.context_id });
  assert.equal(pv.steps.length, 1, 'the rejected phantom step was not persisted');
});

// No runner → grounding is skipped (physical truth unknown): declared columns are used
// as-is, exactly as before, so offline/test behaviour is unchanged.
test('build_model: grounding is skipped without a runner (declared columns as-is)', async () => {
  const e = engine(); // no runner
  const s = await e.build_model({ action: 'start', name: 'noground', source: 'events', include: ['columns'] });
  assert.ok(s.available_columns.some((c) => c.name === 'complete_time_of_event_data'), 'declared column offered (cannot verify physically offline)');
  assert.equal(s.not_materialized, undefined);
});

// add_steps: several steps at once, with the per-step effect of each folded into one reply.
test('build_model: add_steps applies several steps at once with a per-step breakdown', async () => {
  const e = engine();
  const s = await e.build_model({ action: 'start', name: 'multi', source: 'events' });
  const r = await e.build_model({ action: 'add_steps', context_id: s.context_id, steps: [
    { stage: 'where', conditions: [{ fn: 'eq', args: [{ column: 'event_name' }, { value: 'first_launch' }] }] },
    mr,
    { stage: 'aggregate', group_by: ['completed'], measures: [{ name: 'n', expr: { fn: 'count' } }] },
  ] });
  assert.equal(r.action, 'add_steps');
  assert.equal(r.steps_added.length, 3);
  assert.equal(r.step_effects.length, 3, 'one effect entry per applied stage, in order');
  assert.deepEqual(r.step_effects.map((x) => x.stage), ['where', 'match_recognize', 'aggregate']);
  assert.ok(r.step_effects.every((x) => typeof x.column_count === 'number' && Array.isArray(x.columns_added)), 'each effect reports the column delta');
  // the steps just added are echoed (with the count); the whole list only when asked for
  assert.deepEqual([r.steps_added.length, r.steps_count, r.steps], [3, 3, undefined]);
  const more = await e.build_model({ action: 'add_steps', context_id: s.context_id, steps: [{ stage: 'limit', limit: 5 }], include: ['steps'] });
  assert.deepEqual([more.steps.length, more.steps_added], [4, undefined]);
  const one = await e.build_model({ action: 'add_steps', context_id: s.context_id, steps: [{ stage: 'limit', limit: 3 }] });
  assert.deepEqual([one.steps_added.map((x) => x.index), one.steps_count], [[5], 5]);
});

test('build_model: add_steps is atomic — a bad stage rolls back the whole batch', async () => {
  const e = engine();
  const s = await e.build_model({ action: 'start', name: 'atomic', source: 'events' });
  await assert.rejects(
    () => e.build_model({ action: 'add_steps', context_id: s.context_id, steps: [
      { stage: 'where', conditions: [{ fn: 'eq', args: [{ column: 'event_name' }, { value: 'first_launch' }] }] },
      { stage: 'aggregate', group_by: ['no_such_col'], measures: [{ name: 'n', expr: { fn: 'count' } }] }, // breaks
    ] }),
    /none of the 2 steps was added/,
  );
  const pv = await e.build_model({ action: 'preview', context_id: s.context_id });
  assert.equal(pv.steps.length, 0, 'atomic: nothing applied, draft untouched');
});

// A refused step is named by its place in `steps` — add_steps' own field — one step or several.
test('build_model: a refused step of add_steps is steps[i], whether one is sent or several', async () => {
  const e = engine();
  const s = await e.build_model({ action: 'start', name: 'field', source: 'events' });
  await e.build_model({ action: 'add_steps', context_id: s.context_id, steps: [{ stage: 'limit', limit: 5 }] });
  const bad = { stage: 'where', conditions: [{ fn: 'eq', args: [{ column: 'no_such_col' }, { value: 1 }] }] };
  const alone = await e.build_model({ action: 'add_steps', context_id: s.context_id, steps: [bad] }).catch((err) => err);
  assert.equal(alone.field, 'steps[0]');
  assert.match(alone.message, /^steps\[0\]: step 2: /);
  const second = await e.build_model({ action: 'add_steps', context_id: s.context_id, steps: [{ stage: 'limit', limit: 3 }, bad] }).catch((err) => err);
  assert.equal(second.field, 'steps[1]');
  assert.match(second.message, /^steps\[1\]: step 3: /);
  assert.equal((await e.build_model({ action: 'preview', context_id: s.context_id })).steps.length, 1, 'nothing of either was added');
});

// A count counts rows without an argument; a sketch (hll_*) reads one, like every other aggregate.
test('build_model: an aggregate without an argument is a count only — a sketch is refused without one', async () => {
  const e = engine();
  const s = await e.build_model({ action: 'start', name: 'hll', source: 'events' });
  for (const fn of ['hll_init', 'hll_merge', 'hll_merge_partial']) {
    await assert.rejects(
      () => e.build_model({ action: 'add_steps', context_id: s.context_id, steps: [{ stage: 'aggregate', group_by: ['event_name'], measures: [{ name: 'x', expr: { fn } }] }] }),
      (err) => /invalid input/.test(err.message) && /'args'/.test(err.message),
      fn,
    );
  }
  const ok = await e.build_model({ action: 'add_steps', context_id: s.context_id, steps: [{ stage: 'aggregate', group_by: ['event_name'], measures: [{ name: 'players', expr: { fn: 'hll_init', args: [{ column: 'player_id_of_internal' }] } }, { name: 'n', expr: { fn: 'count' } }] }], include: ['columns'] });
  assert.deepEqual(ok.available_columns.map((c) => [c.name, c.type]), [['event_name', 'string'], ['players', 'sketch'], ['n', 'int']]);
});

// data_freshness = live MAX(time), re-queried once per INDEX SCAN (not on a wall-clock timer).
test('data_freshness re-queries after each index scan (reflects new data, not a frozen MAX)', async () => {
  const catalog = loadCatalog(CATALOG, {});
  let maxTime = '2026-07-10T00:00:00Z';
  const runner = { show: async (_d, sql) => (/MAX\(/.test(sql) ? { ok: true, rows: [{ latest: maxTime }] } : { ok: true, rows: [] }) };
  const e = settle(new Engine({ catalog, runner, contextManager: new ContextManager({ baseProjectDir: '/tmp/fresh', workspaceRoot: tempDir('fr') }) }));
  assert.equal(await e.probe.dataFreshness('events'), '2026-07-10T00:00:00Z', 'first read = MAX(device_time)');
  maxTime = '2026-07-21T00:00:00Z'; // new data lands
  assert.equal(await e.probe.dataFreshness('events'), '2026-07-10T00:00:00Z', 'between scans: still the cached value');
  // an index scan completes → bumps the sync generation → freshness must re-query.
  e.valueIndex.finishRun(e.valueIndex.startRun());
  assert.equal(await e.probe.dataFreshness('events'), '2026-07-21T00:00:00Z', 'after the scan: re-queried, reflects the newer MAX');
  e.close();
});

// ── P1: pointwise editing — edit_step mutates in place + revalidates; a fork goes back to step N ──
test('build_model: edit_step mutates in place, and a fork of steps 1..N goes back to step N', async () => {
  const e = engine();
  const s = await e.build_model({ action: 'start', name: 'edit', source: 'events' });
  const d = s.context_id;
  await e.build_model({ action: 'add_steps', context_id: d, steps: [{ stage: 'where', conditions: [{ fn: 'eq', args: [{ column: 'event_name' }, { value: 'first_launch' }] }] }] });
  await e.build_model({ action: 'add_steps', context_id: d, steps: [mr] });
  // edit step 1 in place (replace the where literal) — count unchanged.
  const ed = await e.build_model({ action: 'edit_step', context_id: d, index: 1, step: { stage: 'where', conditions: [{ fn: 'eq', args: [{ column: 'event_name' }, { value: 'tutorial' }] }] } });
  assert.equal(ed.action, 'edit_step');
  assert.deepEqual(ed.step.conditions[0].args[1], { value: 'tutorial' }, 'step 1 replaced in place');
  assert.deepEqual([ed.step.index, ed.steps_count], [1, 2], 'edit does not change the step count');
  // back to step 1: a fork of steps 1..1, the original untouched
  const back = await e.build_model({ action: 'fork', context_id: d, name: 'edit_back', after: 1, include: ['steps'] });
  assert.deepEqual(back.steps.map((x) => [x.index, x.stage]), [[1, 'where']]);
  assert.equal(e.ctxs.get(d).state.draft.stages.length, 2, 'the original keeps its steps');
  // the actions that moved steps around are no actions of the tool
  for (const action of ['insert_step', 'delete_step', 'truncate']) await assert.rejects(() => e.build_model({ action, context_id: d, index: 1, after: 1 }), /invalid input/, action);
  // out-of-range index/after are rejected.
  await assert.rejects(() => e.build_model({ action: 'edit_step', context_id: d, index: 9, step: mr }), /out of range/);
  await assert.rejects(() => e.build_model({ action: 'fork', context_id: d, name: 'edit_far', after: 9 }), /out of range/);
});

// An edit that breaks a LATER step is rejected with that step's index; the draft is intact.
test('build_model: an edit breaking a downstream step reports the step index, draft intact', async () => {
  const e = engine();
  const s = await e.build_model({ action: 'start', name: 'brk', source: 'events' });
  const d = s.context_id;
  await e.build_model({ action: 'add_steps', context_id: d, steps: [mr] }); // step 1: funnel exposes reached_a/completed
  await e.build_model({ action: 'add_steps', context_id: d, steps: [{ stage: 'where', conditions: [{ fn: 'eq', args: [{ column: 'completed' }, { value: true }] }] }] }); // step 2 uses 'completed'
  // replacing step 1 with a plain where removes 'completed' → step 2 can no longer reference it.
  await assert.rejects(
    () => e.build_model({ action: 'edit_step', context_id: d, index: 1, step: { stage: 'where', conditions: [{ fn: 'eq', args: [{ column: 'event_name' }, { value: 'first_launch' }] }] } }),
    /step 2/,
  );
  const pv = await e.build_model({ action: 'preview', context_id: d });
  assert.equal(pv.steps.length, 2, 'draft left intact after a rejected edit');
  assert.equal(pv.steps[0].stage, 'match_recognize', 'step 1 unchanged');
});

// fork branches a NEW draft from a prefix WITHOUT touching the original.
test('build_model: fork branches a new draft from step N; original untouched', async () => {
  const e = engine();
  const s = await e.build_model({ action: 'start', name: 'orig', source: 'events' });
  const d = s.context_id;
  await e.build_model({ action: 'add_steps', context_id: d, steps: [mr] });
  await e.build_model({ action: 'add_steps', context_id: d, steps: [{ stage: 'aggregate', group_by: ['completed'], measures: [{ name: 'n', expr: { fn: 'count' } }] }] });
  // a fork is a new thing with a name of its own: one without a name is refused, as the
  // retentioneering builder's fork is
  await assert.rejects(() => e.build_model({ action: 'fork', context_id: d, after: 1 }), (err) => err.stage === 'validate' && /'name'/.test(err.message));
  const fk = await e.build_model({ action: 'fork', context_id: d, name: 'variant', after: 1 });
  assert.notEqual(fk.context_id, d, 'fork is a NEW draft');
  assert.equal(fk.name, 'variant', 'under the name the call gives it');
  assert.equal(fk.copied_steps, 1);
  assert.deepEqual([fk.steps_count, fk.steps], [1, undefined], 'only the kept prefix copied');
  // the fork diverges independently; the source draft is never mutated.
  const f2 = await e.build_model({ action: 'add_steps', context_id: fk.context_id, steps: [{ stage: 'aggregate', group_by: ['reached_a'], measures: [{ name: 'm', expr: { fn: 'count' } }] }] });
  assert.equal(f2.steps_count, 2);
  const orig = await e.build_model({ action: 'preview', context_id: d });
  assert.equal(orig.steps.length, 2, 'source draft untouched by the fork or its edits');
  assert.equal(orig.name, 'orig', 'the original keeps its own name');
  assert.equal(orig.steps[1].stage, 'aggregate');
});

// What an answer includes goes with the actions that answer about the steps — as the retentioneering
// builder takes it: a preview lists both already, a materialize or a discard carries neither, so there
// an include is refused rather than ignored. The earlier flags are refused on every action, with the
// request they are now where the action takes it.
test('build_model: include is refused on preview, materialize and discard', async () => {
  const e = engine();
  const { context_id } = await e.build_model({ action: 'start', name: 'flags', source: 'events', steps: [mr] });
  for (const action of ['preview', 'materialize', 'discard']) {
    for (const include of [['columns'], ['steps']]) {
      await assert.rejects(() => e.build_model({ action, context_id, include }), /invalid input/, `${action} with ${include}`);
    }
    for (const flag of ['include_columns', 'include_steps']) {
      await assert.rejects(() => e.build_model({ action, context_id, [flag]: true }), /invalid input/, `${action} with ${flag}`);
    }
  }
  // the earlier include_* flags are no fields of a fork either: it says what it shows with include
  for (const flag of ['include_columns', 'include_steps']) {
    await assert.rejects(() => e.build_model({ action: 'fork', context_id, name: 'flag_fork', after: 1, [flag]: true }), /invalid input.*unexpected property/, flag);
  }
  assert.equal(e.ctxs.get(context_id).state.draft.stages.length, 1, 'the refused calls changed nothing');
});

// P3: a one_per_match funnel warns to filter completed=true (counts all starts otherwise).
test('build_model: one_per_match funnel warns to filter completed', async () => {
  const e = engine();
  const s = await e.build_model({ action: 'start', name: 'opm', source: 'events' });
  const a = await e.build_model({ action: 'add_steps', context_id: s.context_id, steps: [{ ...mr, rows: 'one_per_match' }] });
  assert.ok(stepNotes(a).some((r) => /one_per_match/.test(r) && /completed/.test(r)), 'warns that one_per_match counts all starts unless completed is filtered');
  // one_per_partition (default) does NOT raise the completed warning.
  const s2 = await e.build_model({ action: 'start', name: 'opp', source: 'events' });
  const a2 = await e.build_model({ action: 'add_steps', context_id: s2.context_id, steps: [mr] });
  assert.ok(!stepNotes(a2).some((r) => /one_per_match/.test(r)), 'no one_per_match warning for one_per_partition');
});

// A card's read is the server's view of what it drew: the caller names the path and the level, never
// steps of its own (nor the earlier `stages` or `transform`).
test('drill_result reads only a drawn task, by the path and level of its card — never a read of the caller\'s', async () => {
  const catalog = loadCatalog(CATALOG, {});
  const runner = { show: async () => ({ ok: true, rows: [{ a: 1 }], columns: [{ name: 'a' }] }) };
  const e = settle(new Engine({ catalog, runner, contextManager: new ContextManager({ baseProjectDir: '/tmp/gqr', workspaceRoot: tempDir('gqr') }) }));
  // the card names the path and the level; the view is the server's, made from the card as drawn
  await assert.rejects(() => e.drill_result({ task_id: 'abcdef123456', limit: 5, transform: { limit: 3 } }), /unexpected property 'transform'/);
  await assert.rejects(() => e.drill_result({ task_id: 'abcdef123456', limit: 5, stages: [{ stage: 'limit', limit: 3 }] }), /unexpected property 'stages'/);
  await assert.rejects(() => e.drill_result({ task_id: 'abcdef123456', limit: 5, steps: [{ stage: 'limit', limit: 3 }] }), /unexpected property 'steps'/);
  // a task that was never drawn is not a card's to read
  const task_id = e.jobs.create({ tool: 'query_model' });
  e.jobs.ready(task_id);
  await assert.rejects(() => e.drill_result({ task_id }), /not drawn/);
});

// ── add_steps refusals moved from the integration suites: each is decided by the schema and the
// catalog when the step is added, before any SQL exists, so no warehouse is read. ──

/** Start a draft over `source` and add one step to it (a refusal throws). */
async function addOne(e, source, stage) {
  const s = await e.build_model({ action: 'start', name: 'guard_step', source });
  return e.build_model({ action: 'add_steps', context_id: s.context_id, steps: [stage] });
}

// (from test/integration/declared-joins.test.js)
test('join guards: a model with no join contract, a self-join and the earlier with / via are all rejected', async () => {
  const e = engine();
  await assert.rejects(() => addOne(e, 'crashlytics', { stage: 'join', source: 'events', on: { user: 'player_id_of_internal' }, attrs: [{ column: 'event_id' }] }),
    /`steps\.0\.source` must be one of: users, experiments, crashlytics, acquisition|`steps\.0\.source`/, 'an events source declares no contract: not joinable');
  await assert.rejects(() => addOne(e, 'crashlytics', { stage: 'join', source: 'crashlytics', on: { user: 'player_id_of_internal', funnel: 'rewarded_tracking_id', format: 'rewarded' }, attrs: [{ column: 'crash_id', name: 'c2' }] }), /own source/);
  await assert.rejects(() => addOne(e, 'events', { stage: 'join', with: 'users', via: 'user', attrs: [{ column: 'country' }] }), /invalid input/, 'the join names its source and its contract, not with / via');
  // a model's amounts are not carried onto rows: an attribute only
  await assert.rejects(() => addOne(e, 'events', { stage: 'join', source: 'acquisition', on: { user: 'player_id_of_internal', time: 'device_time' }, attrs: [{ column: 'cost' }] }), /`steps\.0\.attrs\.0\.column` must be one of/);
});

// (from test/integration/declared-joins.test.js, 48.) Every way a name can end up used twice is
// refused, with the reason and the rename. The join key is called out separately: its value is the
// same on both sides, so the copy is not something to rename — it is something to drop.
test('48. duplicate names and unknown columns are refused with the fix', async () => {
  const e = engine();
  const crash = (attrs) => ({ stage: 'join', source: 'crashlytics', on: { user: 'player_id_of_internal', funnel: 'tracking_id', format: 'rewarded' }, ...(attrs ? { attrs } : {}) });
  // (a) attrs missing entirely — the error lists the joined model's attributes (never an amount)
  await assert.rejects(
    () => addOne(e, 'events', { stage: 'join', source: 'acquisition', on: { user: 'player_id_of_internal', time: 'device_time' } }),
    (err) => {
      assert.match(err.message, /missing required property 'attrs' — a list of \{ column, … \}, column one of: .*media_source/s, '(a) attrs missing');
      assert.doesNotMatch(err.message, /column one of: [^.]*\bcost\b/, '(a) an amount is no attribute');
      return true;
    },
  );
  // (b) a column the joined model does not have.
  await assert.rejects(() => addOne(e, 'events', crash([{ column: 'crash_id' }, { column: 'nope' }])), /`steps\.0\.attrs\.1\.column` must be one of: .*crash_id/s, '(b) a column the joined model does not have');
  // (c) a name the pipeline already carries, holding DIFFERENT data → rename it.
  await assert.rejects(
    () => addOne(e, 'events', crash([{ column: 'event_name' }])),
    (err) => {
      assert.match(err.message, /already has a column named 'event_name'/, '(c) the name already carried');
      assert.match(err.message, /hold different data.*name: 'crashlytics_event_name'/s, '(c) the rename to apply');
      return true;
    },
  );
  // (d) the same name, but it is the JOIN KEY → the pipeline's column already holds that value.
  await assert.rejects(() => addOne(e, 'events', crash([{ column: 'player_id_of_internal' }])), /is the join key.*holds the same value — drop it from attrs/s, '(d) the join key');
  // (e) two entries resolving to one name.
  await assert.rejects(() => addOne(e, 'events', crash([{ column: 'crash_id', name: 'x' }, { column: 'app_version', name: 'x' }])), /'crash_id' and 'app_version' would both be named 'x'/, '(e) two entries, one name');
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

// (#14 of the complex payload types in test/integration/pipeline-stages.test.js, moved here.) A complex
// op on a column that is not complex is refused, naming what the column IS — rather than building array
// SQL over text and failing in the warehouse.
test('14. complex ops on a scalar column are refused with what it actually is', async () => {
  const e = engine();
  // an unnest explodes an array: a scalar property has nothing to explode
  await assert.rejects(
    () => addOne(e, 'crashlytics', { stage: 'unnest', expr: { property: 'issue_title_of_event_data' }, name: 'x' }),
    /unnest: 'issue_title_of_event_data' is declared as string, not an array/,
  );
  await assert.rejects(
    () => addOne(e, 'crashlytics', { stage: 'compute', name: 'x', expr: { fn: 'array_length', args: [{ property: 'issue_title_of_event_data' }] } }),
    /'issue_title_of_event_data' is declared as string, not an array/,
  );
  // the custom-keys column holds a JSON OBJECT, so an array function is wrong there too — and the
  // message points at the read that IS right for an object.
  await assert.rejects(
    () => addOne(e, 'crashlytics', { stage: 'compute', name: 'x', expr: { fn: 'array_contains', args: [{ property: 'custom_keys_of_event_data' }, { value: 'wifi' }] } }),
    /'custom_keys_of_event_data'.*not an array.*A field of a JSON object is \{ property, field \}/s,
  );
  // element_at needs a native array, not the raw JSON string.
  await assert.rejects(
    () => addOne(e, 'crashlytics', { stage: 'compute', name: 'x', expr: { fn: 'element_at', args: [{ column: 'breadcrumbs_of_event_data' }], index: 1 } }),
    /not an array — produce an array first.*json_parse_array/s,
  );
});

// (moved here from the funnels of test/integration/pipeline-stages.test.js) A dry run renders the
// pipeline and builds nothing: no runner is wired here, so nothing could be built.
test('_buildPipeline: dry_run returns SQL without building', async () => {
  const e = engine();
  const dr = await e._buildPipeline({ name: 'dry_pipe', dry_run: true, pipeline: { source: 'events', stages: [{ stage: 'aggregate', group_by: [], measures: [{ name: 'n', expr: { fn: 'count' } }] }] } });
  assert.equal(dr.dry_run, true);
  assert.equal(dr.kind, 'pipeline');
  assert.equal(typeof dr.model_sql, 'string');
  // SQL is rendered in the ACTIVE warehouse dialect only — no second-dialect blob.
  assert.equal(dr.dialect, e.catalog.dialect);
  assert.equal(dr.model_sql_bigquery, undefined);
});
// an unpivot says what stays beside the two columns it makes: keep is required ([] keeps none), so a
// group key is never dropped by leaving keep out
test('build_model: an unpivot without keep is refused, naming keep', async () => {
  const e = engine();
  const s = await e.build_model({ action: 'start', name: 'unp', source: 'events', steps: [{ stage: 'aggregate', group_by: ['event_name'], measures: [{ name: 'n', expr: { fn: 'count' } }, { name: 'u', expr: { fn: 'count_distinct', args: [{ column: 'player_id_of_internal' }] } }] }] });
  await assert.rejects(
    () => e.build_model({ action: 'add_steps', context_id: s.context_id, steps: [{ stage: 'unpivot', columns: ['n', 'u'], name_column: 'm', value_column: 'v' }] }),
    /keep/,
  );
  const ok = await e.build_model({ action: 'add_steps', context_id: s.context_id, steps: [{ stage: 'unpivot', columns: ['n', 'u'], keep: ['event_name'], name_column: 'm', value_column: 'v' }], include: ['columns'] });
  assert.deepEqual(ok.available_columns.map((c) => c.name).sort(), ['event_name', 'm', 'v']);
});
