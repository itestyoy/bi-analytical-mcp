import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadCatalog } from '../../src/catalog.js';
import { buildSchemas } from '../../src/schema.js';
import { makeValidators, validateInput } from '../../src/validate.js';

const catalog = loadCatalog(join(process.cwd(), 'config', 'catalog.json'));
const validators = makeValidators(buildSchemas(catalog));

function v(tool, input) {
  return validateInput(validators[tool], input);
}

test('create: accepts a valid declaration', () => {
  const r = v('create_semantic_model', {
    name: 'task_a',
    semantic_models: [{ from: 'events', event_scope: { event_name: ['iap_purchase_completed'] }, measures: [{ name: 'rev', agg: 'sum', field: 'price_in_usd' }] }],
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
