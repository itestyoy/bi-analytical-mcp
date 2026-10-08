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
