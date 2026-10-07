import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadCatalog } from '../../src/catalog.js';
import { buildSchemas } from '../../src/schema.js';
import { makeValidators, validateInput } from '../../src/validate.js';

const catalog = loadCatalog(join(process.cwd(), 'config', 'catalog.yml'));
const validators = makeValidators(buildSchemas(catalog));

function v(tool, input) {
  return validateInput(validators[tool], input);
}

test('create: accepts a valid declaration', () => {
  // Derive valid names from the catalog so this stays correct as the catalog
  // evolves (vocabulary differs across catalogs; the shape under test does not).
  const numericField = catalog.eventNumericProps('events')[0];
  const someEvent = catalog.eventNames('events')[0];
  const r = v('build_semantic_model', {
    name: 'task_a',
    semantic_models: [{ from: 'events', where: [{ field: 'event_name', op: 'eq', value: someEvent }], measures: [{ name: 'rev', agg: 'sum', field: numericField }] }],
    metrics: [{ name: 'rev', type: 'simple', measure: { name: 'rev' } }],
  });
  assert.ok(r.ok, JSON.stringify(r.errors));
});

test('create: rejects unknown event property in dimension (enum from catalog)', () => {
  const r = v('build_semantic_model', {
    name: 'task_a',
    semantic_models: [{ from: 'events', dimensions: [{ field: 'not_a_real_prop' }] }],
    metrics: [{ name: 'm', type: 'simple', measure: { name: 'x' } }],
  });
  assert.equal(r.ok, false);
});

test('create: an unknown event in a condition on the event name is refused when it is compiled', async () => {
  const { compileDeclaration } = await import('../../src/compile.js');
  assert.throws(() => compileDeclaration(catalog, {
    name: 'task_a',
    semantic_models: [{ from: 'events', where: [{ field: 'event_name', op: 'eq', value: 'not_an_event' }], measures: [{ name: 'n', agg: 'count' }] }],
    metrics: [{ name: 'm', type: 'simple', measure: { name: 'n' } }],
  }), /not_an_event/);
});

test('create: rejects percentile measure without percentile value', () => {
  const r = v('build_semantic_model', {
    name: 'task_a',
    semantic_models: [{ from: 'events', measures: [{ name: 'p', agg: 'percentile', field: 'complete_time' }] }],
    metrics: [{ name: 'm', type: 'simple', measure: { name: 'p' } }],
  });
  assert.equal(r.ok, false);
});

test('create: rejects unknown model in from', () => {
  const r = v('build_semantic_model', {
    name: 'task_a',
    semantic_models: [{ from: 'nope', measures: [] }],
    metrics: [{ name: 'm', type: 'simple', measure: { name: 'x' } }],
  });
  assert.equal(r.ok, false);
});

test('create: rejects additional properties', () => {
  const r = v('build_semantic_model', { name: 'task_a', metrics: [{ name: 'm', type: 'simple', measure: { name: 'x' } }], bogus: 1 });
  assert.equal(r.ok, false);
});

test('create: ratio requires numerator and denominator', () => {
  const r = v('build_semantic_model', {
    name: 'task_a',
    metrics: [{ name: 'r', type: 'ratio', numerator: { name: 'a' } }],
  });
  assert.equal(r.ok, false);
});

test('query: requires context_id and metrics', () => {
  assert.equal(v('query_semantic_model', { metrics: ['x'] }).ok, false);
  assert.ok(v('query_semantic_model', { context_id: 'abcd12', metrics: ['x'] }).ok);
});

test('update: a semantic model it adds to must be a known model key', () => {
  assert.equal(v('build_semantic_model', { action: 'update', context_id: 'ctx123', semantic_models: [{ from: 'ghost' }] }).ok, false);
  assert.ok(v('build_semantic_model', { action: 'update', context_id: 'ctx123', semantic_models: [{ from: 'events', measures: [{ name: 'x', agg: 'count' }] }] }).ok);
});

// TWO MODES, ONE TOOL. Declaring a task and editing the task already in a context used to be two
// tools with the same catalog vocabulary in both — and a listing carries every tool's schema on
// every request, so the deployment's payload properties were shipped twice over. They are one tool
// now, picked by `action`.
//
// Input-validation checks: what each mode requires, and that neither mode is asked for the other's
// fields.
test('build_semantic_model: the create mode and the update mode require their own fields', () => {
  const validators = makeValidators(buildSchemas(catalog));
  const check = (input) => validateInput(validators.build_semantic_model, input);
  const TASK = {
    name: 'rev',
    semantic_models: [{ from: 'events', measures: [{ name: 'revenue', agg: 'sum', field: 'price_in_usd_of_event_data' }] }],
    metrics: [{ name: 'revenue', type: 'simple', measure: { name: 'revenue' } }],
  };

  assert.equal(check(TASK).ok, true, JSON.stringify(check(TASK).errors));
  assert.equal(check({ ...TASK, action: 'create' }).ok, true, 'the default mode can be named explicitly');

  // create mode: the declaration is what is required — and the refusal says so
  const bare = check({ semantic_models: [] });
  assert.equal(bare.ok, false);
  assert.match(bare.errors.join(' | '), /name/);
  assert.match(bare.errors.join(' | '), /metrics/);

  // update mode: a context, and what it adds written as a declaration writes it — NOT name/metrics required
  assert.equal(check({
    action: 'update', context_id: 'ctxabc123456',
    semantic_models: [{ from: 'events', measures: [{ name: 'purchases', agg: 'count' }] }],
  }).ok, true);
  const noContext = check({ action: 'update' });
  assert.equal(noContext.ok, false);
  assert.match(noContext.errors.join(' | '), /context_id/);
  assert.ok(!/'name'/.test(noContext.errors.join(' | ')), 'the update mode is never asked for the create mode\'s fields');
  // …the declaration's own fields are refused there, and a model this catalog does not have is refused by the schema
  assert.equal(check({ action: 'update', context_id: 'ctxabc123456', add_measures: [] }).ok, false);
  assert.equal(check({ action: 'update', context_id: 'ctxabc123456', semantic_models: [{ from: 'no_such_model' }] }).ok, false);
});
