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
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { settle } from '../helpers/settle.js';
import { tempDir } from '../helpers/temp-dir.js';
import { declare } from '../helpers/declare.js';

const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));
const engine = () => settle(new Engine({
  catalog: loadCatalog(CATALOG, {}),
  contextManager: new ContextManager({ workspaceRoot: tempDir('descr') }),
}));
const AGG = { stage: 'aggregate', group_by: ['player_id_of_internal'], measures: [{ name: 'revenue', expr: { fn: 'sum', args: [{ column: 'price_in_usd_of_event_data' }] } }] };

test('a draft keeps its description, reports it, and hands it to the fork', async () => {
  const e = engine();
  const note = 'revenue per player for the payer-share question';
  const start = await e.build_model({ action: 'start', name: 'lbl', source: 'events', description: note });
  assert.equal(start.description, note, 'the start response echoes what it recorded');
  await e.build_model({ action: 'add_steps', context_id: start.context_id, steps: [AGG] });

  const described = await e.context({ action: 'describe', context_id: start.context_id });
  assert.equal(described.draft?.description, note);

  // a fork inherits the parent's note (it is the same question, one variant on)…
  const fork = await e.build_model({ action: 'fork', context_id: start.context_id, name: 'lbl_fork' });
  assert.equal(e.ctxs.get(fork.context_id).state.draft.description, note);
  // …and can say what makes it different instead
  const fork2 = await e.build_model({ action: 'fork', context_id: start.context_id, name: 'lbl_payers', description: 'same, but payers only' });
  assert.equal(e.ctxs.get(fork2.context_id).state.draft.description, 'same, but payers only');
});

test('the description belongs to the draft, not to every action on it', async () => {
  const e = engine();
  const { context_id } = await e.build_model({ action: 'start', name: 'lbl2', source: 'events', description: 'x' });
  // add_steps / materialize describe a STEP, not the pipeline: a note there would have nowhere to go
  await assert.rejects(
    () => e.build_model({ action: 'add_steps', context_id, steps: [AGG], description: 'nope' }),
    /invalid input|description/i,
  );
  await assert.rejects(
    () => e.build_model({ action: 'materialize', context_id, description: 'nope' }),
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
});

test('a governed task keeps its description', async () => {
  const e = engine();
  const out = await declare(e, {
    name: 'rev_task', description: 'revenue + payers for the monetization readout',
    semantic_models: [{ source: 'events', measures: [{ name: 'revenue', expr: { fn: 'sum', args: [{ column: 'price_in_usd_of_event_data' }] } }], where: [{ fn: 'eq', args: [{ column: 'event_name' }, { value: 'iap_purchase_completed' }] }] }],
    metrics: [{ name: 'revenue', type: 'simple', measure: 'revenue' }],
  });
  const described = await e.context({ action: 'describe', context_id: out.context_id });
  assert.deepEqual(described.task_notes, { rev_task: 'revenue + payers for the monetization readout' });

});

test('no description means no empty field in the response', async () => {
  const e = engine();
  const { context_id } = await e.build_model({ action: 'start', name: 'plain', source: 'events' });
  const described = await e.context({ action: 'describe', context_id });
  assert.ok(!('description' in (described.draft || {})), 'nothing is invented for a draft that said nothing');
});

// A context a build made is reached by the id its build answered: no listing names another's (its id is
// the key to its tables). Context lifecycle; no warehouse.
test('context list names no context a build made', async () => {
  const e = engine();
  for (let i = 0; i < 3; i += 1) await e.build_model({ action: 'start', name: `pg${i}`, source: 'events', description: `draft ${i}` });
  const listed = await e.context({ action: 'list' });
  assert.equal(listed.total, 0);
  assert.deepEqual(listed.contexts, []);
  assert.equal((await e.context({ action: 'list', search: 'draft' })).total, 0);
  await assert.rejects(() => e.context({ action: 'list', limit: 0 }), /limit/);
  e.close();
});

test('status lists the latest tasks first, of every side', async () => {
  const e = engine();
  const ids = [];
  for (let i = 0; i < 12; i += 1) { ids.push(e.jobs.create({ tool: i % 2 ? 'query_model' : 'query_retentioneering_model' })); await new Promise((r) => { setTimeout(r, 2); }); }
  const st = await e.semantic_index({ status: true });
  assert.equal(st.tasks.total, 12);
  assert.deepEqual(st.tasks.recent.map((t) => t.tool), ids.slice(-10).reverse().map((_, i) => ((11 - i) % 2 ? 'query_model' : 'query_retentioneering_model')), 'the newest ten, newest first');
  // a task is said by its tool, status and age — its id, context and table are the key to its rows
  for (const t of st.tasks.recent) assert.deepEqual(Object.keys(t).sort(), ['age_ms', 'status', 'tool']);
  e.close();
});
