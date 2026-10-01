// HOW A REFUSAL READS (src/validate.js explain): the form the value meant and its own errors — and the
// time a refusal takes grows with the call's size, not with every branch tried at every level.
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
const engine = () => new Engine({ catalog: loadCatalog(CATALOG), ctxs: new ContextManager({ root: mkdtempSync(join(tmpdir(), 'refusal-')) }) });
const refusal = (e, tool, input) => { try { e._validate(tool, input); return null; } catch (err) { return err.message; } };

test('a mode left unnamed is refused as the mode the fields belong to, with the modes there are', () => {
  const e = engine();
  const update = refusal(e, 'build_semantic_model', { context_id: 'abc123', semantic_model: 'events', remove_metrics: ['x'] });
  assert.match(update, /update the task in a context/);
  assert.match(update, /missing required property 'action'/);
  assert.doesNotMatch(update, /unexpected property 'semantic_model'/);
  const del = refusal(e, 'delete_context', { context_id: 'abc123', semantic_model: 'events' });
  assert.match(del, /one semantic model's additions/);
  assert.match(del, /missing required property 'what'/);
});

test('a deep where tree is refused in time that grows with its size', () => {
  const e = engine();
  const leaf = () => ({ field: { model: 'users', attribute: 'country' }, op: 'eq', value: 'US', bogus: 1 });
  const tree = (d) => (d === 0 ? leaf() : { op: d % 2 ? 'and' : 'or', conditions: [tree(d - 1), tree(d - 1)] });
  refusal(e, 'query_semantic_model', { context_id: 'abc123', metrics: ['x'], where: tree(1) }); // compiled once
  const t0 = Date.now();
  assert.ok(refusal(e, 'query_semantic_model', { context_id: 'abc123', metrics: ['x'], where: tree(9) }));
  assert.ok(Date.now() - t0 < 5000, `512 leaves refused in ${Date.now() - t0} ms`);
});

test('a join stage takes via or on, never both', () => {
  const e = engine();
  const base = { action: 'add_step', draft_id: 'abc123' };
  const both = refusal(e, 'build_pipeline_model', { ...base, stage: { stage: 'join', with: 'users', via: 'user', on: 'player_id', attrs: ['country'] } });
  assert.match(both, /unexpected property '(via|on)'/);
});
