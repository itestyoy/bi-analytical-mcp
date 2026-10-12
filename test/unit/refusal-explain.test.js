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
import { renderRead } from '../../src/pipeline.js';

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

test('a deep and / or tree is checked, and refused, in time that grows with its size', () => {
  const e = engine();
  // one tree of each level's grammar: a metric query's where over a dimension, a pipeline where over a column
  const levels = [
    ['query_semantic_model', { source: 'users', column: 'country' }, (where) => ({ context_id: 'abc123', metrics: ['x'], where })],
    ['build_pipeline_model', { column: 'event_name' }, (conditions) => ({ action: 'add_steps', context_id: 'abc123', steps: [{ stage: 'where', conditions }] })],
  ];
  for (const [tool, subject, call] of levels) {
    const leaf = (bogus) => ({ fn: 'eq', args: [subject, { value: 'US' }], ...(bogus ? { bogus: 1 } : {}) });
    const tree = (d, bogus) => (d === 0 ? leaf(bogus) : { fn: d % 2 ? 'and' : 'or', args: [tree(d - 1, bogus), tree(d - 1, bogus)] });
    refusal(e, tool, call([tree(1, true)])); // compiled once
    let t0 = Date.now();
    assert.equal(refusal(e, tool, call([tree(9, false)])), null, tool);
    assert.ok(Date.now() - t0 < 1000, `${tool}: 512 leaves taken in ${Date.now() - t0} ms`);
    t0 = Date.now();
    const refused = refusal(e, tool, call([tree(9, true)]));
    assert.match(refused, /unexpected property 'bogus'/, tool);
    assert.ok(Date.now() - t0 < 5000, `${tool}: 512 leaves refused in ${Date.now() - t0} ms`);
  }
});

test('a join stage says how rows match in one field, via — a top-level on is refused', () => {
  const e = engine();
  const base = { action: 'add_steps', context_id: 'abc123' };
  const both = refusal(e, 'build_pipeline_model', { ...base, steps: [{ stage: 'join', with: 'users', via: 'user', on: ['player_id'], attrs: [{ column: 'country' }] }] });
  assert.match(both, /unexpected property 'on'/);
});

test('a read\'s condition is the one grammar over the stored table\'s columns, and a refusal names the form it meant', () => {
  const e = engine();
  const read = (steps) => refusal(e, 'query_pipeline_model', { context_id: 'abc123', steps });
  assert.equal(read([{ stage: 'where', conditions: [{ fn: 'eq', args: [{ column: 'a' }, { value: 1 }] }] }]), null);
  // a column against another column, an expression on either side: a read's too
  assert.equal(read([{ stage: 'where', conditions: [{ fn: 'gt', args: [{ fn: 'length', args: [{ column: 'a' }] }, { column: 'b' }] }] }]), null);
  // a stored table has no source: a read's expression, the one definition built for a read's place
  // (PLACES.stored_rows), has no event property among its leaves, so the schema refuses one — and the
  // read's place refuses it as the step is built, for a caller past the schema (src/pipeline.js renderRead)
  assert.match(read([{ stage: 'where', conditions: [{ fn: 'eq', args: [{ property: 'result_of_event_data' }, { value: 1 }] }] }]), /`steps\.0\.conditions\.0\.args\.0` has an unexpected property 'property'/);
  const property = (() => { try { renderRead(e.catalog, "{{ ref('t') }}", [{ name: 'a', type: 'numeric' }], [{ stage: 'where', conditions: [{ fn: 'eq', args: [{ property: 'result_of_event_data' }, { value: 1 }] }] }]); return null; } catch (err) { return err.message; } })();
  assert.match(property, /steps\[0\]: .*\{ property \} is not what a read of stored rows takes — it takes \{ column \}, \{ value \}, \{ now: true \}/);
  assert.match(property, /from_task/);
  // a field a condition does not read, in a measure's where, is refused under the condition's own title
  assert.match(read([{ stage: 'aggregate', group_by: ['a'], measures: [{ name: 'n', expr: { fn: 'count', where: [{ fn: 'eq', args: [{ column: 'a' }, { value: 1 }], value: 2 }] } }] }]), /`steps\.0\.measures\.0\.expr\.where\.0` has an unexpected property 'value' — fn: eq \| neq \| gt \| gte \| lt \| lte — args \[a, b\] \(a condition\) takes fn, args/);
});

test('a window aggregate takes no where, and a function that is no window takes no over — the refusal names the form', () => {
  const e = engine();
  const add = (stage) => refusal(e, 'build_pipeline_model', { action: 'add_steps', context_id: 'abc123', steps: [stage] });
  assert.match(add({ stage: 'compute', name: 'x', expr: { fn: 'sum', args: [{ column: 'a' }], over: {}, where: [{ fn: 'eq', args: [{ column: 'a' }, { value: 1 }] }] } }), /unexpected property 'where' — fn: sum \| average \| min \| max \(over a window\) takes fn, args, over/);
  assert.match(add({ stage: 'where', conditions: [{ fn: 'gt', args: [{ column: 'a' }, { value: 1 }], over: {} }] }), /must be exactly one of: fn: eq \| neq \| gt \| gte \| lt \| lte/);
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
