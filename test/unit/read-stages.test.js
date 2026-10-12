// A READ IS STEPS OF THE PIPELINE'S OWN STAGES over a stored table, or over a metric query's result
// (src/pipeline.js renderRead): the stages that re-slice rows — where, compute, aggregate, pivot,
// unpivot, order_by, limit, sample, project — built by the pipeline's own builders over the relation's
// columns. A stage that makes a new table (a join, an unnest, a funnel, a python model) is a build from
// the task, and a read has no source, so an event property or a declared relationship is not a thing it
// can read.
//
// Input-validation guards and the column set a read leaves (allowed by the test rules): nothing here
// reads generated SQL. The rows a read returns are proven on DATA in test/integration/.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { renderRead, READ_STAGES } from '../../src/pipeline.js';
import { buildSchemas } from '../../src/schema.js';
import { makeValidators, validateInput } from '../../src/validate.js';
import { transformStages } from '../../src/earlier-spelling.js';

const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));
const catalog = loadCatalog(CATALOG, {});
const TABLE = "{{ ref('qr') }}";
// the stored table's columns, as the server knows them (a checkpoint, a held answer)
const COLUMNS = [{ name: 'user__country', type: 'string' }, { name: 'mon_revenue', type: 'numeric' }, { name: 'day', type: 'time' }, { name: 'n', type: 'int' }];
const read = (stages, columns = COLUMNS) => renderRead(catalog, TABLE, columns, stages);
const cond = (fn, column, ...values) => ({ fn, args: [{ column }, ...values.map((value) => ({ value }))] });

test('a read takes the stages that re-slice the stored rows, and leaves the columns they make', () => {
  assert.deepEqual(READ_STAGES, ['where', 'compute', 'aggregate', 'pivot', 'unpivot', 'order_by', 'limit', 'sample', 'project']);
  // where, a regroup, a where after it (what a having was), an order and a cap — a quoted value is a constant
  const out = read([
    { stage: 'where', conditions: [cond('in', 'user__country', "US'); drop", 'GB')] },
    { stage: 'aggregate', group_by: ['user__country'], measures: [{ name: 'total', expr: { fn: 'sum', args: [{ column: 'mon_revenue' }] } }, { name: 'per_day', expr: { fn: 'div', args: [{ fn: 'sum', args: [{ column: 'mon_revenue' }] }, { fn: 'count_distinct', args: [{ column: 'day' }] }] } }] },
    { stage: 'where', conditions: [cond('gte', 'total', 25)] },
    { stage: 'order_by', keys: [{ key: 'total', direction: 'desc' }] },
    { stage: 'limit', limit: 10 },
  ]);
  assert.deepEqual([...out.columns.keys()], ['user__country', 'total', 'per_day']);
  assert.equal(typeof out.sql, 'string');
  // a second level (what `then` was) is a second aggregate over the first one's columns
  assert.deepEqual([...read([
    { stage: 'aggregate', group_by: ['user__country', 'day'], measures: [{ name: 'rev', expr: { fn: 'sum', args: [{ column: 'mon_revenue' }] } }] },
    { stage: 'aggregate', group_by: ['user__country'], measures: [{ name: 'p90_day', expr: { fn: 'percentile', args: [{ column: 'rev' }], percentile: 0.9 } }] },
  ]).columns.keys()], ['user__country', 'p90_day']);
  // the rest of them, each with the columns it leaves
  assert.deepEqual([...read([{ stage: 'compute', name: 'rn', expr: { fn: 'row_number', over: { partition_by: ['user__country'], order_by: [{ key: 'day' }] } } }]).columns.keys()], ['user__country', 'mon_revenue', 'day', 'n', 'rn']);
  assert.deepEqual([...read([{ stage: 'pivot', on: 'user__country', measure: { fn: 'sum', args: [{ column: 'mon_revenue' }] }, values: [{ value: 'US', name: 'us' }, { value: null, name: 'unknown' }] }]).columns.keys()], ['us', 'unknown']);
  assert.deepEqual([...read([{ stage: 'unpivot', keep: ['day'], columns: ['n', 'mon_revenue'], name_column: 'metric', value_column: 'v' }]).columns.keys()], ['day', 'metric', 'v']);
  assert.deepEqual([...read([{ stage: 'sample', share: 0.1 }, { stage: 'project', drop: ['day'] }]).columns.keys()], ['user__country', 'mon_revenue', 'n']);
  // the columns may come as a Map, as a stage's own column map is
  assert.deepEqual([...renderRead(catalog, TABLE, new Map([['a', { type: 'int' }]]), [{ stage: 'compute', name: 'b', expr: { fn: 'add', args: [{ column: 'a' }, { value: 1 }] } }]).columns.keys()], ['a', 'b']);
});

test('a read says whether its rows come ordered: the last stage but a limit is an order_by', () => {
  assert.equal(read([{ stage: 'order_by', keys: [{ key: 'n' }] }, { stage: 'limit', limit: 3 }]).ordered, true);
  assert.equal(read([{ stage: 'order_by', keys: [{ key: 'n' }] }, { stage: 'where', conditions: [cond('gt', 'n', 1)] }]).ordered, false);
  assert.equal(read([]).ordered, false);
});

test('a stage that makes a new table is refused in a read, naming the stages a read takes and the build from the task', () => {
  for (const st of [
    { stage: 'join', with: 'users', via: 'user', attrs: [{ column: 'country' }] },
    { stage: 'unnest', expr: { column: 'n' }, name: 'w' },
    { stage: 'match_recognize', partition_by: ['user__country'], steps: [{ name: 'a', event_name: ['first_launch'] }] },
    { stage: 'python' },
  ]) {
    assert.throws(() => read([{ stage: 'limit', limit: 1 }, st]), (e) => e.message.startsWith('steps[1]: a read takes where, compute, aggregate')
      && e.message.includes(`a ${st.stage} stage makes a new table`) && /from_task/.test(e.message), st.stage);
  }
  // a step that arrived without its `stage` is said so, at its place
  assert.throws(() => read([{ limit: 3 }]), (e) => e.message.startsWith('steps[0]: a read takes') && /names no `stage`/.test(e.message));
  // the tool's schema offers a read's stages alone
  const v = makeValidators(buildSchemas(catalog));
  const q = (request) => validateInput(v.query_pipeline_model, request);
  assert.equal(q({ context_id: 'abcdef123456', steps: [{ stage: 'limit', limit: 3 }] }).ok, true);
  assert.match(q({ context_id: 'abcdef123456', steps: [{ stage: 'join', with: 'users', via: 'user', attrs: [{ column: 'country' }] }] }).errors.join(' | '), /`steps\.0\.stage` must be one of: where, compute, aggregate, pivot, unpivot, order_by, limit, sample, project/);
  // no steps is a read of the table as it is: the field is left out, never an empty list
  assert.match(q({ context_id: 'abcdef123456', steps: [] }).errors.join(' | '), /at least 1 item/);
  assert.equal(q({ context_id: 'abcdef123456' }).ok, true);
  assert.equal(q({ context_id: 'abcdef123456', queries: [{ steps: [{ stage: 'limit', limit: 3 }] }, { limit: 5 }] }).ok, true);
});

// The steps after a metric query are the same read, over the SQL MetricFlow compiled for it (a
// subquery relation whose columns carry the caller's names, each typed where it is known): a step
// naming a column the result does not have — MetricFlow's own spelling of one included — is refused
// with the result's columns.
test('a read runs over a query as over a table: its steps over the result\'s columns, refused with them', () => {
  const RESULT = [{ name: 'metric_time_day', type: 'time' }, { name: 'users_country', type: 'string' }, { name: 'revenue', type: 'unknown' }];
  const over = (steps) => renderRead(catalog, '(\nselect 1\n) AS _metrics', RESULT, steps);
  const having = over([
    { stage: 'where', conditions: [cond('gt', 'revenue', 100), cond('gte', 'metric_time_day', '2026-01-01')] },
    { stage: 'compute', name: 'per_user', expr: { fn: 'div', args: [{ column: 'revenue' }, { value: 1000 }] } },
    { stage: 'order_by', keys: [{ key: 'per_user', direction: 'desc' }] },
    { stage: 'limit', limit: 5 },
  ]);
  assert.deepEqual([...having.columns.keys()], ['metric_time_day', 'users_country', 'revenue', 'per_user']);
  assert.equal(having.ordered, true);
  // a regroup of the result: by country, over every day
  assert.deepEqual([...over([{ stage: 'aggregate', group_by: ['users_country'], measures: [{ name: 'total', expr: { fn: 'sum', args: [{ column: 'revenue' }] } }] }]).columns.keys()], ['users_country', 'total']);
  // MetricFlow's spelling of a column is not the result's
  for (const key of ['metric_time__day', 'metric_time', 'nonsense']) {
    assert.throws(() => over([{ stage: 'order_by', keys: [{ key }] }]), (e) => new RegExp(`^steps\\[0\\]: .*unknown column '${key}' at this stage \\(available: metric_time_day, users_country, revenue\\)`).test(e.message), key);
  }
});

test('a stored table has no source: an event property and a declared relationship are refused, its columns are read', () => {
  assert.throws(() => read([{ stage: 'compute', name: 'p', expr: { property: 'price_in_usd_of_event_data' } }]), /reads an event property of a pipeline's source, and these rows read none \(a stored table\) — name one of their columns/);
  assert.throws(() => read([{ stage: 'compute', name: 'rn', expr: { fn: 'row_number', over: { partition_by: [{ entity: 'user' }], order_by: [{ key: 'day' }] } } }]), /\{ entity \} names a relationship of a pipeline's source, and these rows read none/);
  // …and the schema of the read offers no { property } leaf
  const v = makeValidators(buildSchemas(catalog));
  assert.equal(validateInput(v.query_pipeline_model, { context_id: 'abcdef123456', steps: [{ stage: 'compute', name: 'p', expr: { property: 'price_in_usd_of_event_data' } }] }).ok, false);
});

// input-validation guards (allowed by the test rules): unsafe input is rejected, a name not a column of
// the table is refused with the columns it has, a constant is typed as the column it meets.
test('a read refuses what is not a column of the table, a name that is no identifier, and a constant of another type', () => {
  assert.throws(() => read([{ stage: 'aggregate', group_by: ['a; drop table x'], measures: [{ name: 'x', expr: { fn: 'count' } }] }]), /steps\[0\]: .*unknown column 'a; drop table x' at this stage \(available: user__country, mon_revenue, day, n\)/);
  assert.throws(() => read([{ stage: 'where', conditions: [cond('eq', '1=1', 1)] }]), /unknown column '1=1'/);
  assert.throws(() => read([{ stage: 'order_by', keys: [{ key: 'x y' }] }]), /unknown column 'x y'/);
  assert.throws(() => read([{ stage: 'aggregate', measures: [{ name: 'x); --', expr: { fn: 'count' } }] }]), /unsafe SQL identifier/);
  assert.throws(() => read([{ stage: 'aggregate', measures: [{ name: 'x', expr: { fn: 'evil', args: [{ column: 'n' }] } }] }]), /unknown function 'evil'/);
  assert.throws(() => read([{ stage: 'where', conditions: [cond('eq', 'mon_revenue', 'lots')] }]), /'mon_revenue' is a number: compare it with a number, not "lots"/);
  // a measure is refused by the measure's own rules, the same words wherever one is written
  assert.throws(() => read([{ stage: 'aggregate', measures: [{ name: 'v', expr: { fn: 'percentile', args: [{ column: 'n' }], percentile: 1.5 } }] }]), /aggregate measure 'v': percentile needs `percentile` in \(0,1\)/);
  assert.throws(() => read([{ stage: 'aggregate', group_by: ['day'], measures: [{ name: 'v', expr: { column: 'n' } }] }]), /'n' stands outside an aggregate, so it has to be one of the group_by columns \(day\)/);
  // a count goes without an argument: it counts rows; a sketch a pipeline stored is merged into a number
  for (const fn of ['count', 'approx_count_distinct', 'hll_merge', 'count_distinct']) {
    assert.equal(read([{ stage: 'aggregate', group_by: ['day'], measures: [{ name: 'v', expr: { fn, args: fn === 'count' ? [] : [{ column: 'n' }] } }] }]).columns.get('v').type, 'int', fn);
  }
});

test('a read written as an earlier `transform` is refused with the steps it is now; its converter reads every part of one', () => {
  const v = makeValidators(buildSchemas(catalog));
  const transform = { where: [{ column: 'user__country', op: 'eq', value: 'US' }], group_by: ['day'], measures: [{ name: 'rev', agg: 'sum', column: 'mon_revenue' }] };
  const steps = [
    { stage: 'where', conditions: [cond('eq', 'user__country', 'US')] },
    { stage: 'aggregate', group_by: ['day'], measures: [{ name: 'rev', expr: { fn: 'sum', args: [{ column: 'mon_revenue' }] } }] },
  ];
  const refused = validateInput(v.query_pipeline_model, { context_id: 'abcdef123456', transform });
  assert.equal(refused.ok, false);
  assert.ok(refused.errors.join(' ').includes(`is written in an earlier spelling — write ${JSON.stringify({ context_id: 'abcdef123456', steps })}`), refused.errors.join(' | '));
  // having is a where after the aggregate, order_by its stage, then a second level; a group_by alone counts its rows
  assert.deepEqual(transformStages({ ...transform, having: [{ column: 'rev', op: 'gt', value: 10 }], order_by: [{ key: 'rev', direction: 'desc' }], then: { group_by: ['rev'] } }), [
    ...steps,
    { stage: 'where', conditions: [cond('gt', 'rev', 10)] },
    { stage: 'order_by', keys: [{ key: 'rev', direction: 'desc' }] },
    { stage: 'aggregate', group_by: ['rev'], measures: [{ name: 'rows', expr: { fn: 'count' } }] },
  ]);
  // what it converts to is a read the table takes
  assert.deepEqual([...read(transformStages(transform)).columns.keys()], ['day', 'rev']);
});
