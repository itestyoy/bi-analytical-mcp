// AN EVENT NAME IN A CONDITION IS ONE OF THE SOURCE'S EVENTS. The catalog declares every event of a
// source, so a constant compared with the event-name column that is not one of them can only filter to
// nothing — a count of 0 or a blank metric that reads like an answer. Input-validation guards: a
// pipeline where, a semantic model's where and a funnel step refuse it, naming the events it may have
// meant (the same name in another casing, the close ones) or the source that does record it.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { compileDeclaration } from '../../src/compile.js';
import { tempDir } from '../helpers/temp-dir.js';

const catalog = loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'));
const engine = new Engine({ catalog, contextManager: new ContextManager({ workspaceRoot: tempDir('event-name') }) });
after(() => engine.close?.());

const eventIs = (value) => ({ fn: 'eq', args: [{ column: 'event_name' }, { value }] });

/** The refusal of a pipeline whose where compares the event name with `value`. */
async function pipelineRefusal(value, op = eventIs(value)) {
  const s = await engine.build_pipeline_model({ action: 'start', name: `ev_${Math.abs(hash(JSON.stringify(op)))}`, source: 'events' });
  await assert.rejects(
    engine.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, steps: [{ stage: 'where', conditions: [op] }] }),
    (e) => { pipelineRefusal.last = e.message; return true; },
  );
  return pipelineRefusal.last;
}
const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);

test('a pipeline where on an event name in another casing is refused with the real name', async () => {
  const msg = await pipelineRefusal('Tutorial');
  assert.match(msg, /unknown event 'Tutorial' on 'events'/);
  assert.match(msg, /Did you mean 'tutorial'\?/);
});

test('a pipeline where on a word that is part of event names is refused with those events', async () => {
  const msg = await pipelineRefusal('purchase');
  assert.match(msg, /'iap_purchase_completed'/);
  assert.match(msg, /'iap_purchase_failed'/);
});

test('a pipeline where on another source\'s event is refused naming that source', async () => {
  const msg = await pipelineRefusal('fatal_crash');
  assert.match(msg, /event 'fatal_crash' belongs to the 'crashlytics' source, not 'events'/);
});

test('every member of an in / not_in and a neq is checked too', async () => {
  assert.match(await pipelineRefusal('x', { fn: 'in', args: [{ column: 'event_name' }, { value: 'tutorial' }, { value: 'Shop_Opened' }] }), /Did you mean 'shop_opened'\?/);
  assert.match(await pipelineRefusal('x', { fn: 'neq', args: [{ column: 'event_name' }, { value: 'tutorail' }] }), /Did you mean 'tutorial'\?/);
});

test('a pipeline where on a real event is accepted', async () => {
  const s = await engine.build_pipeline_model({ action: 'start', name: 'ev_ok', source: 'events' });
  const r = await engine.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, steps: [{ stage: 'where', conditions: [eventIs('tutorial')] }] });
  assert.notEqual(r.ok, false, JSON.stringify(r));
});

test('a semantic model\'s where on an unknown event names the events it may have meant', () => {
  assert.throws(() => compileDeclaration(catalog, {
    name: 'task_a',
    semantic_models: [{ source: 'events', where: [eventIs('purchase')], measures: [{ name: 'n', expr: { fn: 'count' } }] }],
    metrics: [{ name: 'm', type: 'simple', measure: 'n' }],
  }), /unknown event 'purchase' on 'events'\. Did you mean 'iap_purchase_completed' or 'iap_purchase_failed'\?/);
});

test('a word close to no event is refused without a guess', () => {
  assert.equal(catalog.eventNameRefusal('events', 'weather'), "unknown event 'weather' on 'events'. See semantic_index({ request: { source: 'events' } })");
});
