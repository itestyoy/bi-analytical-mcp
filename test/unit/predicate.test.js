import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderField, renderPredicate, renderGroup, renderWhereClauses } from '../../src/predicate.js';

test('renderField wrappers', () => {
  assert.equal(renderField({ kind: 'dimension', path: 'user__country' }), "{{ Dimension('user__country') }}");
  assert.equal(renderField({ kind: 'metric_time', grain: 'week' }), "{{ TimeDimension('metric_time', 'week') }}");
  assert.equal(renderField({ kind: 'entity', name: 'user' }), "{{ Entity('user') }}");
});

test('renderField rejects unsafe path', () => {
  assert.throws(() => renderField({ kind: 'dimension', path: "x') or 1=1--" }));
});

test('operators render correctly', () => {
  const f = { kind: 'dimension', path: 'user__country' };
  assert.equal(renderPredicate({ field: f, op: 'eq', value: 'US' }), "{{ Dimension('user__country') }} = 'US'");
  assert.equal(renderPredicate({ field: f, op: 'neq', value: 'US' }), "{{ Dimension('user__country') }} != 'US'");
  assert.equal(renderPredicate({ field: f, op: 'in', value: ['US', 'GB'] }), "{{ Dimension('user__country') }} in ('US', 'GB')");
  assert.equal(renderPredicate({ field: f, op: 'not_in', value: ['US'] }), "{{ Dimension('user__country') }} not in ('US')");
  assert.equal(renderPredicate({ field: { kind: 'dimension', path: 'user__age' }, op: 'between', value: [18, 35] }), "{{ Dimension('user__age') }} between 18 and 35");
  assert.equal(renderPredicate({ field: f, op: 'is_null' }), "{{ Dimension('user__country') }} is null");
  assert.equal(renderPredicate({ field: f, op: 'is_not_null' }), "{{ Dimension('user__country') }} is not null");
});

test('between requires two values', () => {
  assert.throws(() => renderPredicate({ field: { kind: 'dimension', path: 'x' }, op: 'between', value: [1] }));
});

test('group rendering: nested and/or', () => {
  const group = {
    op: 'and',
    conditions: [
      { field: { kind: 'dimension', path: 'user__acquisition_type' }, op: 'eq', value: 'paid' },
      { op: 'or', conditions: [
        { field: { kind: 'dimension', path: 'user__country' }, op: 'eq', value: 'US' },
        { field: { kind: 'dimension', path: 'user__country' }, op: 'eq', value: 'GB' },
      ] },
    ],
  };
  const clauses = renderWhereClauses(group);
  assert.equal(clauses.length, 2);
  assert.equal(clauses[0], "{{ Dimension('user__acquisition_type') }} = 'paid'");
  assert.ok(clauses[1].includes(' or '));
  assert.equal(renderGroup({ op: 'or', conditions: [{ field: { kind: 'dimension', path: 'a' }, op: 'eq', value: 1 }] }), "{{ Dimension('a') }} = 1");
});
