// A REFUSAL OF A LIST OF FORMS (src/validate.js explain): a { views } or { queries } request whose item is
// wrong is refused as that list's form, at the item — the value's own fields decide which form it meant,
// before whatever is wrong inside them, so an item's extra field never reads as "`views` is not a field".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';

const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));
const engine = () => new Engine({ catalog: loadCatalog(CATALOG), ctxs: new ContextManager({ root: mkdtempSync(join(tmpdir(), 'refusal-views-')) }) });
const refusal = (e, tool, input) => { try { e._validate(tool, input); return null; } catch (err) { return err.message; } };

test('semantic_index({ views }): an item with a field its view does not take is refused at that item', async () => {
  const e = engine();
  await assert.rejects(() => e.semantic_index({ views: [{ model: 'users', limit: 5 }, { model: 'events' }] }), (err) => {
    assert.match(err.message, /`views\.0` has an unexpected property 'limit' — \{ model \} takes model/);
    assert.doesNotMatch(err.message, /unexpected property 'views'/);
    assert.doesNotMatch(err.message, /overview \(an empty request\) takes no fields/);
    return true;
  });
  const second = refusal(e, 'semantic_index', { views: [{ source: 'events', event: 'ad_finished' }, { model: 'users', limit: 5 }] });
  assert.match(second, /`views\.1` has an unexpected property 'limit' — \{ model \} takes model/);
  assert.doesNotMatch(second, /unexpected property 'views'/);
  const event = refusal(e, 'semantic_index', { views: [{ source: 'events', event: 'ad_finished', limit: 5 }, { model: 'users' }] });
  assert.match(event, /`views\.0` has an unexpected property 'limit' — \{ source, event \} takes source, event/);
});

test('semantic_index({ views }): an item that is not a drill-in view is refused at that item', () => {
  const e = engine();
  for (const item of [{ status: true }, { guide: true }]) {
    const msg = refusal(e, 'semantic_index', { views: [item, { model: 'users' }] });
    assert.match(msg, new RegExp(`\`views\\.0\` has an unexpected property '${Object.keys(item)[0]}'`));
    assert.match(msg, /`views\.0` must be exactly one of: \{ model \}/);
    assert.doesNotMatch(msg, /unexpected property 'views'/);
  }
});

test('a field the value gives at its own level still decides first', () => {
  const e = engine();
  // a single view keeps its refusal: limit is not a field of { model }
  assert.match(refusal(e, 'semantic_index', { model: 'users', limit: 5 }), /request has an unexpected property 'limit' — \{ model \} takes model/);
  // a field beside views is said as the { views } form's own
  const beside = refusal(e, 'semantic_index', { views: [{ model: 'users' }, { model: 'events' }], limit: 5 });
  assert.match(beside, /request has an unexpected property 'limit' — \{ views \} takes views/);
});

test('a batch of queries with one bad item is refused at that item, not as a single query', () => {
  const e = engine();
  for (const tool of ['query_semantic_model', 'query_pipeline_model']) {
    const item = tool === 'query_semantic_model' ? { metrics: ['x'] } : { transform: {} };
    const msg = refusal(e, tool, { context_id: 'abc123', queries: [{ ...item, bogus: 1 }, item] });
    assert.match(msg, /`queries\.0` has an unexpected property 'bogus'/, tool);
    assert.doesNotMatch(msg, /unexpected property 'queries'/, tool);
  }
});

test('a field only one form takes, with a wrong value, is refused as that form, not as unknown to the default one', () => {
  const e = engine();
  const msg = refusal(e, 'delete_context', { context_id: 'abc123', semantic_model: 12345 });
  assert.match(msg, /`semantic_model` must be string/);
  assert.match(msg, /missing required property 'what'/);
  assert.doesNotMatch(msg, /unexpected property 'semantic_model'/);
});
