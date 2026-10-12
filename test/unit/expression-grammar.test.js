// ONE EXPRESSION GRAMMAR (src/pipeline/compute.js): a condition, a measure and a computed value are one
// structure — a leaf, or a function { fn, args, …its parameters } over expressions — at every level of
// every tool. Each level offers the leaves and functions it reads, under a `$defs` entry of its own that
// its arguments refer back to; the one writer holds the rules of WHERE each kind may stand — an
// aggregate only where a measure is written, a window only in a compute stage, a condition slot only
// booleans, a missing value only through is_null. What a store holds in an earlier spelling is carried
// over by one table of converters (src/earlier-spelling.js), each leaving today's spelling as it is.
//
// Schema, input-validation and conversion checks — no generated SQL is read; the numbers each
// function computes are proven against the warehouse in test/integration/.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { buildSchemas } from '../../src/schema.js';
import { makeValidators, validateInput } from '../../src/validate.js';
import { renderPipeline } from '../../src/pipeline.js';
import { DERIVED_FNS } from '../../src/compile.js';
import {
  currentCondition, currentConditions, currentExpression, currentMeasure, currentDimension, currentUnnest,
  transformStages, currentOf, currentQueryInput, isEarlierCondition, isEarlierMeasure,
} from '../../src/earlier-spelling.js';
import { beside, forms, pinned } from '../helpers/schema-nav.js';

const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));
const catalog = loadCatalog(CATALOG, {});
const schemas = buildSchemas(catalog);
const validators = makeValidators(schemas);
const COLS = new Set(['player_id_of_internal', 'device_time', 'event_date', 'event_name', 'session_number']);
const render = (stages) => renderPipeline(catalog, catalog.dialect, 'events', stages, { physicalCols: COLS });
const OVER = { partition_by: ['player_id_of_internal'], order_by: [{ key: 'device_time' }] };
const col = (column) => ({ column });
const val = (value) => ({ value });
const where = (...conditions) => ({ stage: 'where', conditions });
const measure = (expr, groupBy = []) => ({ stage: 'aggregate', group_by: groupBy, measures: [{ name: 'm', expr }] });

/** A level's expression definition: its leaves (the forms with no `fn`) and the functions it offers. */
function level(tool, def) {
  const doc = schemas[tool];
  const node = doc.$defs[def];
  const all = forms(doc, node);
  return {
    node,
    leaves: all.filter((f) => !f.properties?.fn).map((f) => f.title),
    fns: new Set(all.flatMap((f) => pinned(doc, f, 'fn'))),
    // what an argument of it is: the same definition, said beside its forms
    argsRef: beside(doc, node, 'args')?.items?.$ref,
    // …and a conditional aggregate's where, where the level folds rows
    whereRef: beside(doc, node, 'where')?.items?.$ref,
  };
}

test('each level offers its own leaves and functions under a $defs entry its arguments refer back to', () => {
  const pipeline = level('build_pipeline_model', 'expr');
  assert.deepEqual(pipeline.leaves, ['a column — { column }', 'an event property — { property }', 'a constant — { value }', 'the current time — { now: true }']);
  for (const fn of ['add', 'case', 'raw', 'eq', 'in', 'and', 'not', 'sum', 'count', 'percentile', 'row_number', 'lag']) assert.ok(pipeline.fns.has(fn), `a pipeline computes ${fn}`);
  // a read runs over a stored table: no event property to read
  const read = level('query_pipeline_model', 'expr');
  assert.deepEqual(read.leaves, ['a column — { column }', 'a constant — { value }', 'the current time — { now: true }']);
  // a semantic model: its columns and event properties, conditions, scalars and the task's aggregates — no raw SQL, no window
  const model = level('build_semantic_model', 'expr');
  assert.deepEqual(model.leaves, ['a column — { column }', 'an event property — { property }', 'a constant — { value }']);
  for (const fn of ['eq', 'and', 'case', 'sum', 'count', 'percentile']) assert.ok(model.fns.has(fn), fn);
  for (const fn of ['raw', 'row_number', 'lag', 'hll_init', 'approx_count_distinct']) assert.ok(!model.fns.has(fn), `a semantic model offers no ${fn}`);
  // a derived metric: the metrics it reads, numbers, and the arithmetic over them
  const derived = level('build_semantic_model', 'metric_expr');
  assert.deepEqual(derived.leaves, ['a metric — { metric }', 'a number — { value }']);
  assert.deepEqual([...derived.fns].sort(), [...DERIVED_FNS].sort());
  // a metric query's where: the references group_by takes and constants — conditions, logic, scalars; no column, no fold
  const query = level('query_semantic_model', 'expr');
  assert.ok(query.leaves.includes('the metric time axis') && query.leaves.includes('an attribute of users') && query.leaves.includes('a constant — { value }'), JSON.stringify(query.leaves));
  assert.ok(!query.leaves.some((t) => /\{ column \}|\{ property \}/.test(t)));
  for (const fn of ['eq', 'or', 'not', 'date_part']) assert.ok(query.fns.has(fn), fn);
  for (const fn of ['sum', 'count', 'row_number', 'raw']) assert.ok(!query.fns.has(fn), `a metric query's where offers no ${fn}`);
  // the steps after a metric query read its result as a read reads a stored table — in an expression
  // of their own beside the where's: its columns, constants and the time; a read's functions, no raw
  const tail = level('query_semantic_model', 'read_expr');
  assert.deepEqual(tail.leaves, read.leaves);
  assert.deepEqual([...tail.fns].sort(), [...read.fns].sort());
  for (const fn of ['sum', 'count', 'gt', 'row_number']) assert.ok(tail.fns.has(fn), `a step after a metric query computes ${fn}`);
  assert.ok(!tail.fns.has('raw'), 'a read takes no raw SQL');
  // every level recursive through its own definition; the event_property function is gone everywhere
  for (const [tool, def] of [['build_pipeline_model', 'expr'], ['query_pipeline_model', 'expr'], ['build_semantic_model', 'expr'], ['build_semantic_model', 'metric_expr'], ['query_semantic_model', 'expr'], ['query_semantic_model', 'read_expr']]) {
    const l = level(tool, def);
    assert.equal(l.argsRef, `#/$defs/${def}`, `${tool}.${def}: its arguments are its own expressions`);
    assert.ok(!l.fns.has('event_property'), `${tool}.${def}: an event property is a leaf`);
    // a level that folds rows takes a conditional aggregate's where, in its own grammar; one that does not, none
    assert.equal(l.whereRef, l.fns.has('count') ? `#/$defs/${def}` : undefined, `${tool}.${def}: an aggregate's where`);
  }
});

test('a function takes its own arguments and parameters, and nothing else', () => {
  const step = (stage) => validateInput(validators.build_pipeline_model, { action: 'add_steps', context_id: 'abcdef123456', steps: [stage] });
  const refused = (stage, re) => { const r = step(stage); assert.equal(r.ok, false, JSON.stringify(stage)); assert.match(r.errors.join(' | '), re, JSON.stringify(stage)); };
  // arity
  refused(where({ fn: 'between', args: [col('a'), val(1)] }), /at least 3 items/);
  refused(where({ fn: 'in', args: [col('a')] }), /at least 2 items/);
  refused(where({ fn: 'not', args: [col('a'), col('b')] }), /at most 1 item/);
  refused(measure({ fn: 'count', args: [col('a'), col('b')] }), /at most 1 item/);
  // parameters: what one requires, and a field it does not read
  refused(measure({ fn: 'percentile', args: [col('a')] }), /missing required property 'percentile'/);
  refused({ stage: 'compute', name: 'x', expr: { fn: 'row_number' } }, /missing required property 'over'/);
  refused(where({ fn: 'eq', args: [col('a'), val(1)], where: [{ fn: 'eq', args: [col('a'), val(1)] }] }), /eq/);
  refused({ stage: 'compute', name: 'x', expr: { fn: 'count_distinct', args: [col('a')], over: {} } }, /count_distinct/);
  // the shapes that are
  for (const stage of [
    where({ fn: 'between', args: [col('a'), val(1), val(3)] }, { fn: 'in', args: [col('a'), val(1)] }, { fn: 'not', args: [{ fn: 'is_null', args: [col('a')] }] }),
    measure({ fn: 'count' }),
    measure({ fn: 'percentile', args: [col('a')], percentile: 0.9, where: [{ fn: 'gt', args: [col('a'), val(0)] }] }),
    { stage: 'compute', name: 'x', expr: { fn: 'sum', args: [col('a')], over: { partition_by: ['b'], order_by: [{ key: 'c' }], frame: { mode: 'rows', preceding: 6 } } } },
  ]) assert.equal(step(stage).ok, true, `${JSON.stringify(stage)}: ${step(stage).errors?.join(' | ')}`);
});

test('an aggregate folds rows only where a measure is written; a window stands only in a compute stage', () => {
  // an aggregate in a row: a where, a compute without over
  assert.throws(() => render([where({ fn: 'gt', args: [{ fn: 'sum', args: [col('session_number')] }, val(1)] })]), /sum with no `over` folds many rows into one value, which a row cannot hold/);
  assert.throws(() => render([{ stage: 'compute', name: 'x', expr: { fn: 'count' } }]), /count with no `over` folds many rows into one value.*give it `over`/s);
  // an aggregate of an aggregate is a second aggregate stage
  assert.throws(() => render([measure({ fn: 'sum', args: [{ fn: 'count' }] })]), /count cannot fold the result of another aggregate — an aggregate of aggregates is a second aggregate stage/);
  // a window in a measure, and as an aggregate's argument: computed into a column first
  assert.throws(() => render([measure({ fn: 'sum', args: [col('session_number')], over: OVER })]), /a measure folds a group's rows into one value, and a window \(sum with over\) keeps every row/);
  assert.throws(() => render([measure({ fn: 'sum', args: [{ fn: 'row_number', over: OVER }] })]), /a window function \(row_number.*\) cannot be an aggregate's argument/);
  // …and in a conditional aggregate's where, which is a condition slot
  assert.throws(() => render([measure({ fn: 'count', where: [{ fn: 'gt', args: [{ fn: 'row_number', over: OVER }, val(1)] }] })]), /window function \(row_number with over\) cannot stand in a condition/);
  // the ways that are: a window in a compute stage, folded after it
  const ok = render([
    { stage: 'compute', name: 'nth', expr: { fn: 'row_number', over: OVER } },
    measure({ fn: 'sum', args: [col('nth')], where: [{ fn: 'gt', args: [col('nth'), val(1)] }] }),
  ]);
  assert.equal(ok.columns.get('m').type, 'numeric');
});

test('a measure is aggregates combined: a column outside them is a group_by column, and one aggregate at least', () => {
  assert.throws(() => render([measure({ fn: 'add', args: [col('session_number'), { fn: 'count' }] }, ['event_name'])]), /'session_number' stands outside an aggregate, so it has to be one of the group_by columns \(event_name\)/);
  assert.throws(() => render([measure(col('event_name'), ['event_name'])]), /a measure folds rows, so it needs an aggregate/);
  assert.throws(() => render([measure(val(1))]), /a measure folds rows, so it needs an aggregate/);
  // a group_by column beside an aggregate is the group's own value
  assert.deepEqual([...render([measure({ fn: 'div', args: [{ fn: 'count' }, col('session_number')] }, ['session_number'])]).columns.keys()], ['session_number', 'm']);
  // a measure's name is one column: a group_by column or another measure under it would be two
  assert.throws(() => render([{ stage: 'aggregate', group_by: ['event_name'], measures: [{ name: 'event_name', expr: { fn: 'count' } }] }]), /'event_name' names a group_by column/);
  assert.throws(() => render([{ stage: 'aggregate', measures: [{ name: 'n', expr: { fn: 'count' } }, { name: 'n', expr: { fn: 'count' } }] }]), /'n' names two measures/);
});

test('a condition slot takes booleans: a comparison, logic, a boolean column — everywhere one is written', () => {
  const notACondition = /a where takes conditions — a comparison \(\{ fn: "eq", args: \[\.\.\.\] \}\), and \/ or \/ not, or a boolean column/;
  assert.throws(() => render([where(col('session_number'))]), notACondition);
  assert.throws(() => render([where({ fn: 'add', args: [col('session_number'), val(1)] })]), notACondition);
  assert.throws(() => render([where(val(1))]), notACondition);
  // a CASE's when and a conditional aggregate's where are condition slots too
  assert.throws(() => render([{ stage: 'compute', name: 'k', expr: { fn: 'case', cases: [{ when: [col('session_number')], then: val(1) }] } }]), notACondition);
  assert.throws(() => render([measure({ fn: 'count', where: [col('session_number')] })]), notACondition);
  // and / or / not take conditions
  assert.throws(() => render([where({ fn: 'and', args: [{ fn: 'eq', args: [col('event_name'), val('x')] }, val(3)] })]), /and takes conditions/);
  assert.throws(() => render([where({ fn: 'not', args: [col('session_number')] })]), /not takes conditions/);
  // a flag a compute stage stores is a boolean column, and a where takes it as it is
  const flagged = render([{ stage: 'compute', name: 'flag', expr: { fn: 'not', args: [{ fn: 'eq', args: [col('event_name'), val('x')] }] } }, where(col('flag'))]);
  assert.equal(flagged.columns.get('flag').type, 'boolean');
});

test('a missing value is tested with is_null / is_not_null: a comparison with a null constant is refused', () => {
  const nullRule = /compares with \{ value: null \}, which no value equals — a missing value is tested with is_null \/ is_not_null/;
  for (const c of [
    { fn: 'eq', args: [col('event_name'), val(null)] },
    { fn: 'neq', args: [col('event_name'), val(null)] },
    { fn: 'in', args: [col('event_name'), val('a'), val(null)] },
    { fn: 'between', args: [col('session_number'), val(null), val(3)] },
    { fn: 'like', args: [col('event_name'), val(null)] },
  ]) assert.throws(() => render([where(c)]), nullRule, JSON.stringify(c));
  assert.ok(render([where({ fn: 'is_null', args: [col('event_name')] }, { fn: 'is_not_null', args: [col('session_number')] })]));
  // a constant is a scalar, never a list (an in whose members are one list is an earlier spelling: a
  // kept step is carried over, a call refused with its members as arguments)
  assert.throws(() => render([where({ fn: 'eq', args: [col('event_name'), val(['a', 'b'])] })]), /a list is written as arguments of their own/);
  const listed = validateInput(validators.build_pipeline_model, { action: 'add_steps', context_id: 'abcdef123456', steps: [where({ fn: 'in', args: [col('event_name'), val(['a', 'b'])] })] });
  assert.ok(listed.errors.join(' ').includes(`is written in an earlier spelling — write ${JSON.stringify({ fn: 'in', args: [col('event_name'), val('a'), val('b')] })}`), listed.errors.join(' | '));
});

test('every earlier spelling converts to the one grammar — and a value in today\'s spelling is left as it is', () => {
  const country = { model: 'users', attribute: 'country' };
  // a condition, in each subject it had, and its groups
  for (const [earlier, today, opts] of [
    [{ column: 'a', op: 'gt', value: 1 }, { fn: 'gt', args: [col('a'), val(1)] }],
    [{ column: 'a', op: 'is_null' }, { fn: 'is_null', args: [col('a')] }],
    [{ column: 'a', op: 'in', value: [1, 2] }, { fn: 'in', args: [col('a'), val(1), val(2)] }],
    [{ column: 'a', op: 'between', value: [1, 3] }, { fn: 'between', args: [col('a'), val(1), val(3)] }],
    [{ left: { fn: 'length', args: [col('a')] }, op: 'gt', right: col('b') }, { fn: 'gt', args: [{ fn: 'length', args: [col('a')] }, col('b')] }],
    [{ field: 'p', op: 'eq', value: 'x' }, { fn: 'eq', args: [{ property: 'p' }, val('x')] }, { subject: () => 'property' }],
    [{ field: 'p', op: 'eq', value: 'x' }, { fn: 'eq', args: [col('p'), val('x')] }, { subject: () => 'column' }],
    [{ field: country, op: 'in', value: ['US', 'DE'] }, { fn: 'in', args: [country, val('US'), val('DE')] }],
    [{ or: [{ column: 'a', op: 'gt', value: 1 }, { and: [{ column: 'b', op: 'is_null' }, { column: 'c', op: 'eq', value: true }] }] }, { fn: 'or', args: [{ fn: 'gt', args: [col('a'), val(1)] }, { fn: 'and', args: [{ fn: 'is_null', args: [col('b')] }, { fn: 'eq', args: [col('c'), val(true)] }] }] }],
    [{ and: [{ column: 'a', op: 'gt', value: 1 }] }, { fn: 'gt', args: [col('a'), val(1)] }],
  ]) {
    assert.ok(isEarlierCondition(earlier), JSON.stringify(earlier));
    assert.deepEqual(currentCondition(earlier, opts), today, JSON.stringify(earlier));
    assert.deepEqual(currentCondition(today, opts), today, `${JSON.stringify(today)} is today's`);
    assert.equal(currentOf(today), today, `${JSON.stringify(today)} is kept by identity`);
  }
  assert.deepEqual(currentConditions([{ column: 'a', op: 'gt', value: 1 }]), [{ fn: 'gt', args: [col('a'), val(1)] }]);
  // an expression: the event_property function, the array functions naming their property, a list constant, nested ones
  for (const [earlier, today] of [
    [{ fn: 'event_property', property: 'p', field: 'f', type: 'numeric' }, { property: 'p', field: 'f', type: 'numeric' }],
    [{ fn: 'array_length', property: 'items' }, { fn: 'array_length', args: [{ property: 'items' }] }],
    [{ fn: 'array_contains', property: 'items', item: 'cat' }, { fn: 'array_contains', args: [{ property: 'items' }, val('cat')] }],
    [{ fn: 'not_in', args: [col('a'), { value: ['x', 'y'] }] }, { fn: 'not_in', args: [col('a'), val('x'), val('y')] }],
    [{ fn: 'case', cases: [{ when: [{ column: 'a', op: 'eq', value: 1 }], then: { fn: 'event_property', property: 'p' } }], else: val(0) }, { fn: 'case', cases: [{ when: [{ fn: 'eq', args: [col('a'), val(1)] }], then: { property: 'p' } }], else: val(0) }],
    [{ fn: 'count', where: [{ column: 'a', op: 'in', value: [1, 2] }] }, { fn: 'count', where: [{ fn: 'in', args: [col('a'), val(1), val(2)] }] }],
  ]) {
    assert.deepEqual(currentExpression(earlier), today, JSON.stringify(earlier));
    assert.deepEqual(currentExpression(today), today, `${JSON.stringify(today)} is today's`);
  }
  // a measure: `fn` before `agg`, `q` before `percentile`, a cast before a function, a pivot's without its name
  for (const [earlier, today] of [
    [{ name: 'n', agg: 'count' }, { name: 'n', expr: { fn: 'count', args: [] } }],
    [{ name: 'r', agg: 'sum', column: 'price' }, { name: 'r', expr: { fn: 'sum', args: [col('price')] } }],
    [{ name: 'a', fn: 'avg', column: 'x' }, { name: 'a', expr: { fn: 'average', args: [col('x')] } }],
    [{ name: 'p', fn: 'quantile', q: 0.5, field: 'x', cast: 'numeric', where: [{ field: 'e', op: 'eq', value: 'a' }], label: 'P' }, { name: 'p', expr: { fn: 'percentile', args: [{ fn: 'cast', args: [col('x')], type: 'numeric' }], percentile: 0.5, where: [{ fn: 'eq', args: [col('e'), val('a')] }] }, label: 'P' }],
    [{ agg: 'sum', column: 'x' }, { fn: 'sum', args: [col('x')] }],
  ]) {
    assert.ok(isEarlierMeasure(earlier), JSON.stringify(earlier));
    assert.deepEqual(currentMeasure(earlier), today, JSON.stringify(earlier));
  }
  const measureToday = { name: 'r', expr: { fn: 'sum', args: [col('price')] } };
  assert.deepEqual(currentMeasure(measureToday), measureToday);
  assert.equal(isEarlierMeasure(measureToday), false);
  // a semantic model's dimension, as declared and as an update removes it
  assert.deepEqual(currentDimension({ field: 'install_date', grain: 'week', label: 'W' }), { column: 'install_date', grain: 'week', label: 'W' });
  assert.deepEqual(currentDimension({ from: 'users', field: 'country' }), { from: 'users', column: 'country' });
  assert.deepEqual(currentDimension({ field: 'p' }, { subject: () => 'property' }), { property: 'p' });
  const dimensionToday = { column: 'country', label: 'Country' };
  assert.equal(currentDimension(dimensionToday), dimensionToday);
  // an unnest naming its array as a field of its own
  assert.deepEqual(currentUnnest({ stage: 'unnest', property: 'items', name: 'i' }), { stage: 'unnest', expr: { property: 'items' }, name: 'i' });
  assert.deepEqual(currentUnnest({ stage: 'unnest', column: 'arr', name: 'i', field: 'id' }), { stage: 'unnest', expr: col('arr'), name: 'i', field: 'id' });
  const unnestToday = { stage: 'unnest', expr: { property: 'items' }, name: 'i' };
  assert.equal(currentUnnest(unnestToday), unnestToday);
  // a read's transform is its steps
  assert.deepEqual(currentOf({ context_id: 'abcdef123456', transform: { group_by: ['a'] } }), { context_id: 'abcdef123456', steps: [{ stage: 'aggregate', group_by: ['a'], measures: [{ name: 'rows', expr: { fn: 'count' } }] }] });
  assert.deepEqual(transformStages({}), []);
  // a metric query's order_by is the order_by step after its steps
  const keys = [{ key: 'revenue', direction: 'desc' }];
  assert.deepEqual(currentOf({ context_id: 'abcdef123456', metrics: ['revenue'], order_by: keys, limit: 5 }), { context_id: 'abcdef123456', metrics: ['revenue'], limit: 5, steps: [{ stage: 'order_by', keys }] });
  // a field only renamed is the refusal's hint (here that field is called 'steps'), not a conversion
  const named = { context_id: 'abcdef123456', stages: [{ stage: 'limit', limit: 5 }] };
  assert.equal(currentOf(named), named);
});

// A QUERY'S INPUT KEPT WITH ITS TASK is read back in today's spelling (src/earlier-spelling.js
// currentQueryInput): a read's steps were its `stages` (its `transform` before that), and a metric
// query's `order_by` is the order_by step after its steps — a batch's queries alike, and the same object
// when nothing in it is of an earlier spelling.
test('a stored query input is carried over as steps: stages, transform and a metric query\'s order_by', () => {
  const limit = { stage: 'limit', limit: 3 };
  // a pipeline read
  assert.deepEqual(currentQueryInput({ context_id: 'abcdef123456', stages: [limit] }), { context_id: 'abcdef123456', steps: [limit] });
  assert.deepEqual(currentQueryInput({ context_id: 'abcdef123456', transform: { group_by: ['a'] } }), { context_id: 'abcdef123456', steps: [{ stage: 'aggregate', group_by: ['a'], measures: [{ name: 'rows', expr: { fn: 'count' } }] }] });
  // a metric query: its order_by after the steps it already had
  const keys = [{ key: 'metric_time_day', direction: 'desc' }];
  assert.deepEqual(currentQueryInput({ metrics: ['dau'], order_by: keys }), { metrics: ['dau'], steps: [{ stage: 'order_by', keys }] });
  assert.deepEqual(currentQueryInput({ metrics: ['dau'], steps: [limit], order_by: keys }), { metrics: ['dau'], steps: [limit, { stage: 'order_by', keys }] });
  assert.deepEqual(currentQueryInput({ metrics: ['dau'], order_by: [] }), { metrics: ['dau'] }, 'an empty order_by orders nothing');
  // a batch: each query alike, the ones already in today's spelling kept by identity
  const today = { metrics: ['dau'], steps: [limit] };
  const batch = currentQueryInput({ context_id: 'abcdef123456', queries: [today, { metrics: ['dau'], order_by: keys }, { stages: [limit] }] });
  assert.equal(batch.queries[0], today);
  assert.deepEqual(batch.queries.slice(1), [{ metrics: ['dau'], steps: [{ stage: 'order_by', keys }] }, { steps: [limit] }]);
  // today's spelling is the same object
  for (const v of [today, { context_id: 'abcdef123456' }, { task_ids: ['abcdef123456'], offset: 0, limit: 10 }, { context_id: 'abcdef123456', queries: [today] }]) assert.equal(currentQueryInput(v), v, JSON.stringify(v));
  // a window's order_by is not a metric query's (no metrics beside it)
  assert.equal(currentQueryInput(OVER), OVER);
  const windowed = { stage: 'compute', name: 'n', expr: { fn: 'row_number', over: OVER } };
  assert.equal(currentOf(windowed), windowed);
});

test('currentOf converts what is old anywhere in a value, keeps what is not by identity, and leaves the libraries\' own grammars alone', () => {
  const today = { stage: 'where', conditions: [{ fn: 'eq', args: [col('a'), val(1)] }] };
  assert.equal(currentOf(today), today);
  assert.equal(currentOf([today, { stage: 'limit', limit: 5 }])[0], today);
  const mixed = { a: { fn: 'eq', args: [col('x'), val(1)] }, b: { column: 'y', op: 'gt', value: 2 } };
  const now = currentOf(mixed);
  assert.notEqual(now, mixed);
  assert.equal(now.a, mixed.a, 'the part already in the grammar is the same object');
  assert.deepEqual(now.b, { fn: 'gt', args: [col('y'), val(2)] });
  // the retentioneering library's conditions ({ op: '>', metric, value }, { op: 'and', args }) are its own grammar, not an earlier one of ours
  for (const lib of [{ type: 'filter_paths', condition: { op: '>', metric: 'length', value: 3 } }, { op: 'and', args: [{ op: 'in', metric: 'length', value: [1, 2] }] }]) {
    assert.equal(currentOf(lib), lib, JSON.stringify(lib));
  }
  assert.equal(isEarlierCondition({ op: 'in', metric: 'length', value: [1] }), false);
});

test('a stage stored in an earlier spelling builds as today\'s; one written today builds as it is', () => {
  const kept = [
    { stage: 'where', conditions: [{ column: 'event_name', op: 'in', value: ['tutorial', 'first_launch'] }, { or: [{ column: 'session_number', op: 'gt', value: 1 }, { column: 'session_number', op: 'is_null' }] }] },
    { stage: 'aggregate', group_by: ['event_name'], measures: [{ name: 'n', agg: 'count' }, { name: 's', agg: 'sum', column: 'session_number', where: [{ column: 'session_number', op: 'gt', value: 2 }] }] },
  ];
  const today = [
    where({ fn: 'in', args: [col('event_name'), val('tutorial'), val('first_launch')] }, { fn: 'or', args: [{ fn: 'gt', args: [col('session_number'), val(1)] }, { fn: 'is_null', args: [col('session_number')] }] }),
    { stage: 'aggregate', group_by: ['event_name'], measures: [{ name: 'n', expr: { fn: 'count', args: [] } }, { name: 's', expr: { fn: 'sum', args: [col('session_number')], where: [{ fn: 'gt', args: [col('session_number'), val(2)] }] } }] },
  ];
  const built = render(kept);
  assert.deepEqual(kept.map((s) => built.current.get(s)), today);
  assert.deepEqual([...built.columns.entries()], [...render(today).columns.entries()]);
  const again = render(today);
  for (const s of today) assert.equal(again.current.get(s), s, 'today\'s spelling is kept by identity');
});
