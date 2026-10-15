import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { settle, stepNotes } from '../helpers/settle.js';
import { tempDir } from '../helpers/temp-dir.js';

const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));
function engine() {
  const catalog = loadCatalog(CATALOG, {});
  return settle(new Engine({ catalog, contextManager: new ContextManager({ workspaceRoot: tempDir('fvg') }) }));
}
const whereStep = (e, draftId, column, op, value) => e.build_pipeline_model({ action: 'add_steps', context_id: draftId, steps: [{ stage: 'where', conditions: [{ fn: op, args: [{ column }, { value }] }] }] });

// A wrong-CASED filter value on a categorical event property is REJECTED with the real value,
// not silently filtered to nothing (the 'organic' vs 'Organic' problem).
test('a wrong-cased filter value is rejected with the correct casing suggested', async () => {
  const e = engine();
  // real indexed values for result_of_event_data are lowercase win/lose.
  e.valueIndex.upsertProperty('events', 'result_of_event_data', { distinctCount: 2, totalCount: 15, values: [{ value: 'win', freq: 10 }, { value: 'lose', freq: 5 }] });
  const s = await e.build_pipeline_model({ action: 'start', name: 'casecheck', source: 'events' });

  await assert.rejects(
    () => whereStep(e, s.context_id, 'result_of_event_data', 'eq', 'Win'),
    (err) => /different casing/.test(err.message) && /'win'/.test(err.message),
    'mis-cased value rejected + correct casing suggested',
  );
  // the exact, real value is accepted.
  const ok = await whereStep(e, s.context_id, 'result_of_event_data', 'eq', 'win');
  assert.equal(ok.action, 'add_steps');
});

// A comparison is checked wherever it stands in a condition — a member of an in, under or / not —
// and whether it names the column or the event property stored in it.
test('a wrong-cased value is rejected at any depth of and / or / not, on a column or an event property', async () => {
  const e = engine();
  e.valueIndex.upsertProperty('events', 'result_of_event_data', { distinctCount: 2, totalCount: 15, values: [{ value: 'win', freq: 10 }, { value: 'lose', freq: 5 }] });
  const s = await e.build_pipeline_model({ action: 'start', name: 'deep', source: 'events' });
  const add = (c) => e.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, steps: [{ stage: 'where', conditions: [c] }] });
  const miscased = (err) => /different casing/.test(err.message) && /'win'/.test(err.message);
  await assert.rejects(() => add({ fn: 'not', args: [{ fn: 'or', args: [{ fn: 'eq', args: [{ column: 'event_name' }, { value: 'tutorial' }] }, { fn: 'in', args: [{ column: 'result_of_event_data' }, { value: 'lose' }, { value: 'Win' }] }] }] }), miscased);
  await assert.rejects(() => add({ fn: 'eq', args: [{ property: 'result_of_event_data' }, { value: 'Win' }] }), miscased);
  const ok = await add({ fn: 'and', args: [{ fn: 'in', args: [{ column: 'result_of_event_data' }, { value: 'lose' }, { value: 'win' }] }, { fn: 'neq', args: [{ property: 'result_of_event_data' }, { value: 'win' }] }] });
  assert.equal(ok.action, 'add_steps');
});

// A value that does NOT occur (and the full value set is indexed) is rejected as absent.
test('an absent value is rejected when the full value set is indexed', async () => {
  const e = engine();
  e.valueIndex.upsertProperty('events', 'result_of_event_data', { distinctCount: 2, totalCount: 15, values: [{ value: 'win', freq: 10 }, { value: 'lose', freq: 5 }] });
  const s = await e.build_pipeline_model({ action: 'start', name: 'absent', source: 'events' });
  await assert.rejects(
    () => whereStep(e, s.context_id, 'result_of_event_data', 'eq', 'victory'),
    (err) => /does not occur/.test(err.message) && /win/.test(err.message),
  );
});

// The check is SOURCE-SCOPED via the anchor dimension key (events.<col>), e.g. bundle_id.
test('anchor dimension values are verified source-scoped (events.<col>)', async () => {
  const e = engine();
  e.valueIndex.upsertProperty('events', 'bundle_id', { distinctCount: 2, totalCount: 150, values: [{ value: 'com.omg.wordsearch', freq: 100 }, { value: 'com.omg.colorfit', freq: 50 }] });
  const s = await e.build_pipeline_model({ action: 'start', name: 'bundlefilter', source: 'events' });
  await assert.rejects(
    () => whereStep(e, s.context_id, 'bundle_id', 'eq', 'com.omg.WORDSEARCH'),
    (err) => /casing/.test(err.message) && /com\.omg\.wordsearch/.test(err.message),
  );
  const ok = await whereStep(e, s.context_id, 'bundle_id', 'eq', 'com.omg.wordsearch');
  assert.equal(ok.action, 'add_steps');
});

// When only the TOP-N is indexed (capped), an unknown value is NOT blocked — it WARNS, so a
// legitimately-rare value is never rejected on incomplete index data.
test('a capped (top-N) column neither blocks nor warns about an unindexed value — the result says whether it matched', async () => {
  const e = engine();
  e.valueIndex.upsertProperty('events', 'result_of_event_data', { distinctCount: 500, totalCount: 9999, values: [{ value: 'win', freq: 10 }, { value: 'lose', freq: 5 }] });
  const s = await e.build_pipeline_model({ action: 'start', name: 'capped', source: 'events' });
  const r = await whereStep(e, s.context_id, 'result_of_event_data', 'eq', 'some_rare_status');
  assert.equal(r.action, 'add_steps', 'not blocked');
  // a value past the indexed top-N is most often real: the note is kept for an empty result only
  assert.ok(!stepNotes(r).some((x) => /not in the index|more values than are indexed/i.test(x)), JSON.stringify(stepNotes(r)));
});

// HIGH-CARDINALITY guard (the user's concern): a column whose stored values reach the cap
// (≥50) is treated as incomplete even if distinct_count looks satisfied — an unknown value
// is WARNED, never hard-rejected (it may well exist beyond the indexed top-N).
test('a many-valued column (at the cap) never hard-rejects an unindexed value', async () => {
  const e = engine();
  const many = Array.from({ length: 50 }, (_, i) => ({ value: `v${i}`, freq: 50 - i }));
  e.valueIndex.upsertProperty('events', 'result_of_event_data', { distinctCount: 50, totalCount: 9999, values: many });
  const s = await e.build_pipeline_model({ action: 'start', name: 'manyvals', source: 'events' });
  const r = await whereStep(e, s.context_id, 'result_of_event_data', 'eq', 'v999_not_indexed');
  assert.equal(r.action, 'add_steps', 'a value beyond the cap is not blocked');
  assert.ok(!stepNotes(r).some((x) => /not in the index|more values than are indexed/i.test(x)), 'and not warned about: the result says whether it matched');
});

// A fuzzy NEAR-match is a WARNING, not a block — a distinct sibling value (level_1 vs level_3)
// must never be rejected just because it resembles an indexed one.
test('a fuzzy near-match warns but does not block', async () => {
  const e = engine();
  e.valueIndex.upsertProperty('events', 'result_of_event_data', { distinctCount: 2, totalCount: 15, values: [{ value: 'level_1', freq: 10 }, { value: 'level_2', freq: 5 }] });
  const s = await e.build_pipeline_model({ action: 'start', name: 'fuzzyok', source: 'events' });
  const r = await whereStep(e, s.context_id, 'result_of_event_data', 'eq', 'level_3');
  assert.equal(r.action, 'add_steps', 'a similar-but-distinct value is not blocked');
});

// An UNINDEXED column (cold index) cannot be verified → no block, no false rejection.
test('an unindexed column is not blocked (cannot verify)', async () => {
  const e = engine(); // nothing indexed
  const s = await e.build_pipeline_model({ action: 'start', name: 'cold', source: 'events' });
  const r = await whereStep(e, s.context_id, 'result_of_event_data', 'eq', 'whatever');
  assert.equal(r.action, 'add_steps', 'cold index → not blocked');
});

// Numeric/range filters are not value-checked (only categorical equality).
test('numeric/range comparisons are not value-checked', async () => {
  const e = engine();
  e.valueIndex.upsertProperty('events', 'result_of_event_data', { distinctCount: 2, values: [{ value: 'win', freq: 10 }, { value: 'lose', freq: 5 }] });
  const s = await e.build_pipeline_model({ action: 'start', name: 'range', source: 'events' });
  // a gt on a value not in the set is fine (it's a range op, not equality).
  const r = await whereStep(e, s.context_id, 'result_of_event_data', 'gt', 'aaa');
  assert.equal(r.action, 'add_steps');
});

// A user__<attr> path resolves on the model that OWNS `user` (dim_users), so a case-mismatched
// literal on it is rejected like any other — it used to slip through because the first model
// merely DECLARING `user` (events, as a foreign key) has no such attribute.
test('the value guard checks a joined attribute path against the owner\'s indexed values', async () => {
  const e = engine();
  e.valueIndex.upsertProperty('users', 'country', { distinctCount: 2, totalCount: 20, values: [{ value: 'DE', freq: 12 }, { value: 'US', freq: 8 }] });
  const out = await e.build_semantic_model({
    name: 'vguard',
    semantic_models: [{ source: 'events', measures: [{ name: 'n', expr: { fn: 'count' } }] }, { source: 'users' }],
    metrics: [{ name: 'n', type: 'simple', measure: 'n' }],
  });
  const country = { source: 'users', column: 'country' };
  // (a metric query filters the rows its metrics fold in where steps before its metrics step)
  const query = (...conditions) => e.query_model({ context_id: out.context_id, steps: [{ stage: 'where', conditions }, { stage: 'metrics', metrics: ['vguard_n'] }] });
  await assert.rejects(() => query({ fn: 'eq', args: [country, { value: 'de' }] }), /different casing.*'DE'/s);
  // …and inside or / not, a member of an in
  await assert.rejects(
    () => query({ fn: 'or', args: [{ fn: 'eq', args: [country, { value: 'US' }] }, { fn: 'not', args: [{ fn: 'in', args: [country, { value: 'de' }, { value: 'US' }] }] }] }),
    /different casing.*'DE'/s,
  );
  // …and in every where step before the metrics step, the second as the first
  await assert.rejects(
    () => e.query_model({ context_id: out.context_id, steps: [{ stage: 'where', conditions: [{ fn: 'eq', args: [country, { value: 'US' }] }] }, { stage: 'where', conditions: [{ fn: 'neq', args: [country, { value: 'de' }] }] }, { stage: 'metrics', metrics: ['vguard_n'] }] }),
    /different casing.*'DE'/s,
  );
});

test('a join\'s select value is checked against the joined model\'s real values, as a where\'s constant is', async () => {
  const e = engine();
  e.valueIndex.upsertProperty('experiments', 'experiment_name', { distinctCount: 1, totalCount: 12, values: [{ value: 'checkout_flow', freq: 12 }] });
  const s = await e.build_pipeline_model({ action: 'start', name: 'exp_join', source: 'events' });
  const join = (experiment) => e.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, steps: [{ stage: 'join', source: 'experiments', on: { user: 'player_id_of_internal', experiment }, attrs: [{ column: 'variant_group' }] }] });
  await assert.rejects(() => join('Checkout_Flow'), (err) => /join experiments on\.experiment/.test(err.message) && /different casing/.test(err.message) && /'checkout_flow'/.test(err.message));
  await assert.rejects(() => join('pricing_test'), (err) => /does not occur/.test(err.message) && /checkout_flow/.test(err.message));
  assert.ok((await join('checkout_flow')).context_id);
});
