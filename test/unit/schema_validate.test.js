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
  const r = v('create_semantic_model', {
    name: 'task_a',
    semantic_models: [{ from: 'events', event_scope: { event_name: [someEvent] }, measures: [{ name: 'rev', agg: 'sum', field: numericField }] }],
    metrics: [{ name: 'rev', type: 'simple', measure: { name: 'rev' } }],
  });
  assert.ok(r.ok, JSON.stringify(r.errors));
});

test('create: rejects unknown event property in dimension (enum from catalog)', () => {
  const r = v('create_semantic_model', {
    name: 'task_a',
    semantic_models: [{ from: 'events', dimensions: [{ source: 'event_property', property: 'not_a_real_prop' }] }],
    metrics: [{ name: 'm', type: 'simple', measure: { name: 'x' } }],
  });
  assert.equal(r.ok, false);
});

test('create: rejects unknown event_name in scope', () => {
  const r = v('create_semantic_model', {
    name: 'task_a',
    semantic_models: [{ from: 'events', event_scope: { event_name: ['not_an_event'] } }],
    metrics: [{ name: 'm', type: 'simple', measure: { name: 'x' } }],
  });
  assert.equal(r.ok, false);
});

test('create: rejects percentile measure without percentile value', () => {
  const r = v('create_semantic_model', {
    name: 'task_a',
    semantic_models: [{ from: 'events', measures: [{ name: 'p', agg: 'percentile', field: 'complete_time' }] }],
    metrics: [{ name: 'm', type: 'simple', measure: { name: 'p' } }],
  });
  assert.equal(r.ok, false);
});

test('create: rejects unknown model in from', () => {
  const r = v('create_semantic_model', {
    name: 'task_a',
    semantic_models: [{ from: 'nope', measures: [] }],
    metrics: [{ name: 'm', type: 'simple', measure: { name: 'x' } }],
  });
  assert.equal(r.ok, false);
});

test('create: rejects additional properties', () => {
  const r = v('create_semantic_model', { name: 'task_a', metrics: [{ name: 'm', type: 'simple', measure: { name: 'x' } }], bogus: 1 });
  assert.equal(r.ok, false);
});

test('create: ratio requires numerator and denominator', () => {
  const r = v('create_semantic_model', {
    name: 'task_a',
    metrics: [{ name: 'r', type: 'ratio', numerator: { name: 'a' } }],
  });
  assert.equal(r.ok, false);
});

test('query: requires context_id and metrics', () => {
  assert.equal(v('query_semantic_model', { metrics: ['x'] }).ok, false);
  assert.ok(v('query_semantic_model', { context_id: 'abcd12', metrics: ['x'] }).ok);
});

test('update: semantic_model must be a known model key', () => {
  assert.equal(v('update_semantic_model', { context_id: 'ctx123', semantic_model: 'ghost' }).ok, false);
  assert.ok(v('update_semantic_model', { context_id: 'ctx123', semantic_model: 'events', add_measures: [{ name: 'x', agg: 'count', field: '*' }] }).ok);
});

// TWO MODES, ONE TOOL. Declaring a task and editing the task already in a context used to be two
// tools with the same catalog vocabulary in both — and a listing carries every tool's schema on
// every request, so the deployment's payload properties were shipped twice over. They are one tool
// now, picked by `action`, and the old name stays callable for a client that learned it.
//
// Input-validation checks: what each mode requires, and that neither mode is asked for the other's
// fields.
test('create_semantic_model: the create mode and the update mode require their own fields', () => {
  const validators = makeValidators(buildSchemas(catalog));
  const check = (input) => validateInput(validators.create_semantic_model, input);
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

  // update mode: a context and the model being changed, and NOT name/metrics
  assert.equal(check({
    action: 'update', context_id: 'ctxabc123456', semantic_model: 'events',
    add_measures: [{ name: 'purchases', agg: 'count', field: '*' }],
  }).ok, true);
  const noModel = check({ action: 'update', context_id: 'ctxabc123456' });
  assert.equal(noModel.ok, false);
  assert.match(noModel.errors.join(' | '), /semantic_model/);
  assert.ok(!/'name'/.test(noModel.errors.join(' | ')), 'the update mode is never asked for the create mode\'s fields');
  // …and a model this catalog does not have is still refused by the schema
  assert.equal(check({ action: 'update', context_id: 'ctxabc123456', semantic_model: 'no_such_model' }).ok, false);
});
