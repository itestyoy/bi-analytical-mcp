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
  const update = refusal(e, 'build_semantic_model', { context_id: 'abc123', remove: { metrics: ['x'] } });
  assert.match(update, /update the task in a context/);
  assert.match(update, /missing required property 'action'/);
  assert.doesNotMatch(update, /unexpected property 'remove'/);
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

test('a join stage says how rows match in one field, via — a top-level on is refused', () => {
  const e = engine();
  const base = { action: 'add_steps', context_id: 'abc123' };
  const both = refusal(e, 'build_pipeline_model', { ...base, stages: [{ stage: 'join', with: 'users', via: 'user', on: ['player_id'], attrs: [{ column: 'country' }] }] });
  assert.match(both, /unexpected property 'on'/);
});

test('a read\'s condition is the column-and-constant form, and a refusal names it by its title', () => {
  const e = engine();
  const read = (where) => refusal(e, 'query_pipeline_model', { context_id: 'abc123', transform: { where } });
  assert.equal(read([{ column: 'a', op: 'eq', value: 1 }]), null);
  // a column compared with another column (an expression) is a pipeline step's, not a read's
  const vsColumn = read([{ column: 'a', op: 'eq', right: { column: 'b' } }]);
  assert.match(vsColumn, /a column and a constant/);
  assert.match(vsColumn, /unexpected property 'right'/);
  assert.doesNotMatch(vsColumn, /option 1/);
  // the same leaf in having and in a measure's where
  assert.match(refusal(e, 'query_pipeline_model', { context_id: 'abc123', transform: { group_by: ['a'], measures: [{ name: 'n', agg: 'count', where: [{ left: { column: 'a' }, op: 'eq', value: 1 }] }] } }), /a column and a constant/);
});

test('a query is started without an offset: paging is the read\'s, by row numbers of the result', () => {
  const e = engine();
  assert.match(refusal(e, 'query_semantic_model', { context_id: 'abc123', metrics: ['x'], offset: 10 }), /unexpected property 'offset'/);
  assert.match(refusal(e, 'query_pipeline_model', { context_id: 'abc123', offset: 10 }), /unexpected property 'offset'/);
  assert.match(refusal(e, 'query_pipeline_model', { context_id: 'abc123', queries: [{ limit: 5, offset: 10 }] }), /unexpected property 'offset'/);
  // a start's limit is the rows its task keeps; a read's offset/limit page them
  assert.equal(refusal(e, 'query_semantic_model', { context_id: 'abc123', metrics: ['x'], limit: 10 }), null);
  assert.equal(refusal(e, 'query_semantic_model', { task_ids: ['abc123abc123'], offset: 100, limit: 10 }), null);
});
