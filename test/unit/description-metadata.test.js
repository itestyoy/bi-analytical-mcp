// `description` used to be a promise the server did not keep: create_semantic_model accepted it
// and threw it away ("metadata only"), while the two pipeline paths did not accept it at all — so a
// caller that tried to label what it was building was told the field does not exist, and a caller
// that labelled a governed task got a field that went nowhere.
//
// Now it is kept and reported back. That matters most for pipelines: a draft is cheap to start and
// easy to lose track of, and a listing of ids, names and metric names says what is in a context,
// never why it exists.
//
// Context-lifecycle + input-validation tests (both allowed as non-data): what is stored, what comes
// back, and what is refused. Nothing here asserts on generated SQL or YAML.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { settle } from '../helpers/settle.js';

const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));
const engine = () => settle(new Engine({
  catalog: loadCatalog(CATALOG, {}),
  contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'descr-')) }),
}));
const AGG = { stage: 'aggregate', group_by: ['player_id_of_internal'], measures: [{ name: 'revenue', fn: 'sum', column: 'price_in_usd_of_event_data' }] };

test('a draft keeps its description, reports it, and hands it to the fork', async () => {
  const e = engine();
  const note = 'revenue per player for the payer-share question';
  const start = await e.build_native_model({ action: 'start', name: 'lbl', source: 'events', description: note });
  assert.equal(start.description, note, 'the start response echoes what it recorded');
  await e.build_native_model({ action: 'add_step', draft_id: start.draft_id, stage: AGG });

  const described = await e.context({ action: 'describe', context_id: start.draft_id });
  assert.equal(described.draft?.description, note);
  const listed = (await e.context({ action: 'list' })).contexts.find((c) => c.context_id === start.draft_id);
  assert.equal(listed.description, note, 'a listing says why the context exists, not only what is in it');

  // a fork inherits the parent's note (it is the same question, one variant on)…
  const fork = await e.build_native_model({ action: 'fork', draft_id: start.draft_id });
  assert.equal(e.ctxs.get(fork.draft_id).state.draft.description, note);
  // …and can say what makes it different instead
  const fork2 = await e.build_native_model({ action: 'fork', draft_id: start.draft_id, description: 'same, but payers only' });
  assert.equal(e.ctxs.get(fork2.draft_id).state.draft.description, 'same, but payers only');
});

test('the description belongs to the draft, not to every action on it', async () => {
  const e = engine();
  const { draft_id } = await e.build_native_model({ action: 'start', name: 'lbl2', source: 'events', description: 'x' });
  // add_step / materialize describe a STEP, not the pipeline: a note there would have nowhere to go
  await assert.rejects(
    () => e.build_native_model({ action: 'add_step', draft_id, stage: AGG, description: 'nope' }),
    /invalid input|description/i,
  );
  await assert.rejects(
    () => e.build_native_model({ action: 'materialize', draft_id, description: 'nope' }),
    /invalid input|description/i,
  );
});

test('register_native_model records its description in the context', async () => {
  const e = engine();
  const out = await e.register_native_model({
    name: 'oneshot', description: 'payer revenue, one-off table for the weekly readout',
    pipeline: { source: 'events', stages: [AGG] },
  });
  assert.equal(out.build?.ok, true, JSON.stringify(out.error || {}));
  const described = await e.context({ action: 'describe', context_id: out.context_id });
  assert.equal(described.models?.[0]?.description, 'payer revenue, one-off table for the weekly readout');
  const listed = (await e.context({ action: 'list' })).contexts.find((c) => c.context_id === out.context_id);
  assert.equal(listed.description, 'payer revenue, one-off table for the weekly readout');
});

test('a governed task keeps its description per task name', async () => {
  const e = engine();
  const out = await e.create_semantic_model({
    name: 'rev_task', description: 'revenue + payers for the monetization readout',
    semantic_models: [{ from: 'events', event_scope: { event_name: ['iap_purchase_completed'] }, measures: [{ name: 'revenue', agg: 'sum', field: 'price_in_usd_of_event_data' }] }],
    metrics: [{ name: 'revenue', type: 'simple', measure: { name: 'revenue' } }],
  });
  const described = await e.context({ action: 'describe', context_id: out.context_id });
  assert.deepEqual(described.task_notes, { rev_task: 'revenue + payers for the monetization readout' });

  // a SECOND task in the same context keeps its own note, and neither overwrites the other
  await e.update_semantic_model({
    context_id: out.context_id, name: 'sessions_task', description: 'session counts for the same readout',
    semantic_models: [{ from: 'events', event_scope: { event_name: ['new_session'] }, measures: [{ name: 'sessions', agg: 'count', field: '*' }] }],
    metrics: [{ name: 'sessions', type: 'simple', measure: { name: 'sessions' } }],
  }).catch(async (e2) => {
    // update_semantic_model may require the task to exist; creating a second task is the same path
    assert.match(String(e2.message), /./);
    await e.create_semantic_model({
      context_id: out.context_id, name: 'sessions_task', description: 'session counts for the same readout',
      semantic_models: [{ from: 'events', event_scope: { event_name: ['new_session'] }, measures: [{ name: 'sessions', agg: 'count', field: '*' }] }],
      metrics: [{ name: 'sessions', type: 'simple', measure: { name: 'sessions' } }],
    });
  });
  const again = await e.context({ action: 'describe', context_id: out.context_id });
  assert.equal(again.task_notes.rev_task, 'revenue + payers for the monetization readout');
  assert.equal(again.task_notes.sessions_task, 'session counts for the same readout');
});

test('no description means no empty field in the response', async () => {
  const e = engine();
  const { draft_id } = await e.build_native_model({ action: 'start', name: 'plain', source: 'events' });
  const described = await e.context({ action: 'describe', context_id: draft_id });
  assert.ok(!('description' in (described.draft || {})), 'nothing is invented for a draft that said nothing');
  const listed = (await e.context({ action: 'list' })).contexts.find((c) => c.context_id === draft_id);
  assert.ok(!('description' in listed));
  assert.ok(!('task_notes' in listed));
});
