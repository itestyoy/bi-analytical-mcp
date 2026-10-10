import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProjection } from '../../src/projection.js';
import { getDialect } from '../../src/dialects/index.js';

const q = getDialect('duckdb');

// input-validation guards (allowed by the test rules): unsafe input is rejected.
test('rejects unsafe identifiers (SQL-injection guard)', () => {
  assert.throws(() => buildProjection('t', { group_by: ['a; drop table x'] }, q));
  assert.throws(() => buildProjection('t', { measures: [{ agg: 'sum', column: 'x); --', name: 'x' }] }, q));
  assert.throws(() => buildProjection('t', { where: [{ column: '1=1', op: 'eq', value: 1 }] }, q));
  assert.throws(() => buildProjection('t', { order_by: [{ key: 'x y' }] }, q));
});

test('rejects unsupported agg / operator', () => {
  assert.throws(() => buildProjection('t', { measures: [{ fn: 'evil', column: 'x', name: 'x' }] }, q));
  assert.throws(() => buildProjection('t', { where: [{ column: 'a', op: 'bad', value: 1 }] }, q));
});

// Valid structured input (incl. a value carrying a quote + SQL) is accepted and
// builds without throwing. We do NOT assert on the generated SQL text here; the
// escaping is proven on DATA in test/integration/materialize.test.js (a quoted
// injection value is bound as a literal -> runs safely, matches nothing).
test('accepts valid structured input (incl. quoted value) and builds output', () => {
  const sql = buildProjection("{{ ref('qr') }}", {
    group_by: ['user__country'],
    measures: [{ agg: 'sum', column: 'mon_revenue', name: 'total' }],
    where: [{ column: 'user__country', op: 'in', value: ["US'); drop", 'GB'] }],
    having: [{ column: 'total', op: 'gte', value: 25 }],
    order_by: [{ key: 'total', direction: 'desc' }],
    limit: 10,
  }, q);
  assert.equal(typeof sql, 'string');
  assert.ok(sql.length > 0);
});

// a read's measure takes the aggregate stage's functions but for the sketch PRODUCERS: a read returns
// values, and merges a sketch a pipeline stored with hll_merge (its numbers: test/integration/materialize.test.js)
test('a read folds with the aggregate stage\'s functions, but makes no sketch', () => {
  for (const agg of ['approx_count_distinct', 'hll_merge', 'median', 'count_distinct']) {
    assert.equal(typeof buildProjection('t', { group_by: ['g'], measures: [{ agg, column: 'x', name: 'v' }] }, q), 'string', agg);
  }
  for (const agg of ['hll_init', 'hll_merge_partial']) assert.throws(() => buildProjection('t', { group_by: ['g'], measures: [{ agg, column: 'x', name: 'v' }] }, q), /unsupported agg/, agg);
});

// a read's measure is refused by the aggregate stage's own rule (src/pipeline/sql.js aggExpr), named by
// the measure it refuses — one copy of each rule, the same words wherever a measure is written
test('a read\'s measure is refused by the measure\'s own rule, naming the measure', async () => {
  const { aggExpr } = await import('../../src/pipeline/sql.js');
  const ruleOf = (fn) => { try { fn(); } catch (e) { return e.message; } return null; };
  for (const [measure, rule] of [
    [{ agg: 'sum', name: 'v' }, () => aggExpr(q, 'sum', null)],
    [{ agg: 'percentile', column: 'x', name: 'v' }, () => aggExpr(q, 'percentile', 'x', undefined)],
    [{ agg: 'percentile', column: 'x', percentile: 1.5, name: 'v' }, () => aggExpr(q, 'percentile', 'x', 1.5)],
  ]) {
    const said = ruleOf(rule);
    assert.ok(said, JSON.stringify(measure));
    assert.throws(() => buildProjection('t', { measures: [measure] }, q), (e) => e.message === `measure 'v': ${said}`, JSON.stringify(measure));
  }
  // a count goes without a column: it counts rows
  assert.equal(typeof buildProjection('t', { measures: [{ agg: 'count', name: 'n' }] }, q), 'string');
});
