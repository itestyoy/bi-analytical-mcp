// A REFUSAL LEAVES NOTHING BEHIND AND NAMES THE WAY OUT. Input-validation guards and context lifecycle:
// a declaration whose every metric reads a measure on a slowly-changing model is refused in the call
// (it would build a layer with nothing to query), with the count to write instead; an id that names no
// context says how to find those that exist; a pipeline start whose steps are refused leaves no empty
// draft for each corrected retry.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { tempDir } from '../helpers/temp-dir.js';

const catalog = loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'));
const ctxs = new ContextManager({ workspaceRoot: tempDir('way-out') });
const engine = new Engine({ catalog, contextManager: ctxs });
after(() => engine.close?.());

const contexts = () => ctxs.list().length;

test('a declaration whose only metric reads a measure on the slowly-changing users model is refused, creating nothing', async () => {
  const before = contexts();
  await assert.rejects(engine.build_semantic_model({
    name: 'installs_only',
    semantic_models: [{ source: 'users', measures: [{ name: 'installs', expr: { fn: 'count_distinct', args: [{ column: 'player_id_of_internal' }] } }] }],
    metrics: [{ name: 'installs', type: 'simple', measure: 'installs' }],
  }), (e) => {
    assert.match(e.message, /no metric of this declaration can be queried/);
    assert.match(e.message, /'users' is slowly-changing/);
    // the count to write instead, on an events source that carries the users key
    assert.match(e.message, /source: 'events', measures: \[\{ name: '\w+', expr: \{ fn: 'count_distinct', args: \[\{ column: 'player_id_of_internal' \}\] \} \}\]/);
    return true;
  });
  assert.equal(contexts(), before, 'no context is created for a refused declaration');
});

test('an id that names no context says how to list those that exist', async () => {
  await assert.rejects(
    engine.query_pipeline_model({ context_id: 'nope12345678', steps: [{ stage: 'limit', limit: 1 }] }),
    /unknown context_id: nope12345678\. No context has that id .*context\(\{ request: \{ action: 'list' \} \}\)/,
  );
  const r = await engine.delete_context({ context_id: 'zzzzzzzzzzzz' });
  assert.equal(r.removed, false);
  assert.match(r.reason, /no context has this id/);
});

test('a pipeline start whose steps are refused leaves no draft behind', async () => {
  const before = contexts();
  for (let i = 0; i < 2; i++) {
    await assert.rejects(engine.build_pipeline_model({
      action: 'start', name: 'leak_probe', source: 'events',
      steps: [{ stage: 'aggregate', group_by: ['prise'], measures: [{ name: 'n', expr: { fn: 'count' } }] }],
    }), /unknown column 'prise'.*nothing was started/);
  }
  assert.equal(contexts(), before);
});

test('a function given a parameter under another name is refused as that function, naming the parameter it takes', async () => {
  const s = await engine.build_pipeline_model({ action: 'start', name: 'misnamed_params', source: 'events' });
  const refusal = async (expr) => {
    let msg = '';
    await assert.rejects(engine.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, steps: [{ stage: 'compute', name: 'x', expr }] }), (e) => { msg = e.message; return true; });
    return msg;
  };
  const t = { column: 'device_time' };
  for (const [expr, field, fn] of [
    [{ fn: 'cast', args: [{ column: 'event_name' }], to: 'int' }, 'type', 'cast'],
    [{ fn: 'date_trunc', args: [t], unit: 'week' }, 'grain', 'date_trunc'],
    [{ fn: 'date_trunc', args: [t], granularity: 'week' }, 'grain', 'date_trunc'],
    [{ fn: 'date_part', args: [t], unit: 'hour' }, 'part', 'date_part'],
  ]) {
    const msg = await refusal(expr);
    assert.match(msg, new RegExp(`missing required property '${field}'`), msg);
    assert.match(msg, new RegExp(`fn: ${fn} takes fn, args, ${field}`), msg);
  }
});
