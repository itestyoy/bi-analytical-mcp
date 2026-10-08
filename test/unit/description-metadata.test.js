// `description` used to be a promise the server did not keep: build_semantic_model accepted it
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
const AGG = { stage: 'aggregate', group_by: ['player_id_of_internal'], measures: [{ name: 'revenue', agg: 'sum', column: 'price_in_usd_of_event_data' }] };

test('a draft keeps its description, reports it, and hands it to the fork', async () => {
  const e = engine();
  const note = 'revenue per player for the payer-share question';
  const start = await e.build_pipeline_model({ action: 'start', name: 'lbl', source: 'events', description: note });
  assert.equal(start.description, note, 'the start response echoes what it recorded');
  await e.build_pipeline_model({ action: 'add_steps', context_id: start.context_id, stages: [AGG] });

  const described = await e.context({ action: 'describe', context_id: start.context_id });
  assert.equal(described.draft?.description, note);
  const listed = (await e.context({ action: 'list' })).contexts.find((c) => c.context_id === start.context_id);
  assert.equal(listed.description, note, 'a listing says why the context exists, not only what is in it');

  // a fork inherits the parent's note (it is the same question, one variant on)…
  const fork = await e.build_pipeline_model({ action: 'fork', context_id: start.context_id });
  assert.equal(e.ctxs.get(fork.context_id).state.draft.description, note);
  // …and can say what makes it different instead
  const fork2 = await e.build_pipeline_model({ action: 'fork', context_id: start.context_id, description: 'same, but payers only' });
  assert.equal(e.ctxs.get(fork2.context_id).state.draft.description, 'same, but payers only');
});

test('the description belongs to the draft, not to every action on it', async () => {
  const e = engine();
  const { context_id } = await e.build_pipeline_model({ action: 'start', name: 'lbl2', source: 'events', description: 'x' });
  // add_steps / materialize describe a STEP, not the pipeline: a note there would have nowhere to go
  await assert.rejects(
    () => e.build_pipeline_model({ action: 'add_steps', context_id, stages: [AGG], description: 'nope' }),
    /invalid input|description/i,
  );
  await assert.rejects(
    () => e.build_pipeline_model({ action: 'materialize', context_id, description: 'nope' }),
    /invalid input|description/i,
  );
});

test('_buildPipeline records its description in the context', async () => {
  const e = engine();
  const out = await e._buildPipeline({
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
  const out = await e.build_semantic_model({
    name: 'rev_task', description: 'revenue + payers for the monetization readout',
    semantic_models: [{ from: 'events', measures: [{ name: 'revenue', agg: 'sum', field: 'price_in_usd_of_event_data' }], where: [{ field: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] }],
    metrics: [{ name: 'revenue', type: 'simple', measure: { name: 'revenue' } }],
  });
  const described = await e.context({ action: 'describe', context_id: out.context_id });
  assert.deepEqual(described.task_notes, { rev_task: 'revenue + payers for the monetization readout' });

  // a SECOND task in the same context keeps its own note, and neither overwrites the other
  await e.build_semantic_model({ action: 'update',
    context_id: out.context_id, name: 'sessions_task', description: 'session counts for the same readout',
    semantic_models: [{ from: 'events', measures: [{ name: 'sessions', agg: 'count' }], where: [{ field: 'event_name', op: 'eq', value: 'new_session' }] }],
    metrics: [{ name: 'sessions', type: 'simple', measure: { name: 'sessions' } }],
  }).catch(async (e2) => {
    // build_semantic_model action update may require the task to exist; creating a second task is the same path
    assert.match(String(e2.message), /./);
    await e.build_semantic_model({
      context_id: out.context_id, name: 'sessions_task', description: 'session counts for the same readout',
      semantic_models: [{ from: 'events', measures: [{ name: 'sessions', agg: 'count' }], where: [{ field: 'event_name', op: 'eq', value: 'new_session' }] }],
      metrics: [{ name: 'sessions', type: 'simple', measure: { name: 'sessions' } }],
    });
  });
  const again = await e.context({ action: 'describe', context_id: out.context_id });
  assert.equal(again.task_notes.rev_task, 'revenue + payers for the monetization readout');
  assert.equal(again.task_notes.sessions_task, 'session counts for the same readout');
});

test('no description means no empty field in the response', async () => {
  const e = engine();
  const { context_id } = await e.build_pipeline_model({ action: 'start', name: 'plain', source: 'events' });
  const described = await e.context({ action: 'describe', context_id });
  assert.ok(!('description' in (described.draft || {})), 'nothing is invented for a draft that said nothing');
  const listed = (await e.context({ action: 'list' })).contexts.find((c) => c.context_id === context_id);
  assert.ok(!('description' in listed));
  assert.ok(!('task_notes' in listed));
});

// The listing is a PAGE, most recently used first: a server keeps every conversation's contexts, and the
// whole list did not fit a model's window. Context lifecycle; no warehouse.
test('context list pages the contexts, most recently used first, and search narrows them', async () => {
  const e = engine();
  const ids = [];
  for (let i = 0; i < 5; i += 1) ids.push((await e.build_pipeline_model({ action: 'start', name: `pg${i}`, source: 'events', description: i === 2 ? 'the payer funnel' : `draft ${i}` })).context_id);
  e.ctxs.touch(ids[1]); // used last
  const first = await e.context({ action: 'list', limit: 2 });
  assert.equal(first.total, 5);
  assert.equal(first.contexts.length, 2);
  assert.equal(first.contexts[0].context_id, ids[1], 'the one used last comes first');
  assert.equal(first.next_offset, 2);
  const rest = await e.context({ action: 'list', offset: first.next_offset, limit: 10 });
  assert.equal(rest.contexts.length, 3);
  assert.equal(rest.next_offset, undefined, 'the last page says there is no next one');
  assert.deepEqual(new Set([...first.contexts, ...rest.contexts].map((c) => c.context_id)), new Set(ids));
  const found = await e.context({ action: 'list', search: 'PAYER funnel' });
  assert.deepEqual(found.contexts.map((c) => c.context_id), [ids[2]]);
  await assert.rejects(() => e.context({ action: 'list', limit: 0 }), /limit/);
  e.close();
});

test('status lists the latest tasks first, of every side', async () => {
  const e = engine();
  const ids = [];
  for (let i = 0; i < 12; i += 1) { ids.push(e.jobs.create({ tool: i % 2 ? 'query_pipeline_model' : 'query_retentioneering_model' })); await new Promise((r) => { setTimeout(r, 2); }); }
  const st = await e.semantic_index({ status: true });
  assert.equal(st.tasks.total, 12);
  assert.deepEqual(st.tasks.recent.map((t) => t.task_id), ids.slice(-10).reverse(), 'the newest ten, newest first');
  e.close();
});
