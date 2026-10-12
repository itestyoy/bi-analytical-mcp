// ONE EXPRESSION GRAMMAR (src/pipeline/compute.js): a condition, a measure and a computed value are one
// structure — a leaf, or a function { fn, args, …its parameters } over expressions — in ONE definition,
// `$defs.expr`, in every tool that takes one, built by one builder for that tool's places: the leaves
// (the rows' and the refs that name a value) and the functions they take, its arguments referring back to
// it. What a PLACE takes of it is one table (PLACES), read for a tool's definition and checked as the
// value is built, and the refusal names the place and what it takes; the one writer holds
// the rules of WHERE each kind may stand too — an aggregate only where a measure is written, a window
// only in a compute stage, a condition slot only booleans, a missing value only through is_null. What a
// store holds in an earlier spelling is carried over by one table of converters
// (src/earlier-spelling.js), each leaving today's spelling as it is.
//
// Schema, input-validation and conversion checks — no generated SQL is read; the numbers each
// function computes are proven against the warehouse in test/integration/.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { buildSchemas, TOOL_PLACES } from '../../src/schema.js';
import { makeValidators, validateInput } from '../../src/validate.js';
import { renderPipeline } from '../../src/pipeline.js';
import { FNS, PLACES, exprSchema, exprSql, conditionListSql } from '../../src/pipeline/compute.js';
import { getDialect } from '../../src/dialects/index.js';
import {
  currentCondition, currentConditions, currentExpression, currentMeasure, currentDimension, currentUnnest,
  transformStages, currentOf, currentQueryInput, isEarlierCondition, isEarlierMeasure,
  isEarlierRef, currentRef, isEarlierInclude, currentInclude,
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

/** The expression definition a schema carries: its leaves (the forms with no `fn`), the functions it
 *  offers, and what its arguments and a conditional aggregate's where are. */
function exprDef(doc, node = doc.$defs?.expr) {
  const all = forms(doc, node);
  return {
    leaves: all.filter((f) => !f.properties?.fn).map((f) => f.title),
    fns: new Set(all.flatMap((f) => pinned(doc, f, 'fn'))),
    // what an argument of it is: the same definition, said beside its forms
    argsRef: beside(doc, node, 'args')?.items?.$ref,
    // …and a conditional aggregate's where
    whereRef: beside(doc, node, 'where')?.items?.$ref,
  };
}

test('every tool that takes an expression carries the one definition, $defs.expr, built for its places, its arguments referring back to it', () => {
  // the definition with no place named (an internal caller's): every leaf of the rows, every ref that
  // names a value, every function
  const one = exprDef({}, exprSchema(catalog));
  assert.deepEqual(one.leaves.slice(0, 4), ['a column — { column }', 'an event property — { property }', 'a constant — { value }', 'the current time — { now: true }']);
  for (const ref of ['{ source: "users", column }', '{ source: "events", property }', '{ semantic_model, dimension }', '{ entity }', '{ metric }', '{ time: "metric_time" }']) assert.ok(one.leaves.includes(ref), `${ref} is a leaf: ${JSON.stringify(one.leaves)}`);
  assert.ok(!one.leaves.some((t) => /^\{ source \}$|event \}$/.test(t)), 'a ref that names no value (a source, an event) is no leaf');
  assert.deepEqual([...one.fns].sort(), Object.keys(FNS).sort(), 'every function, windows and raw included');
  // a tool's is the one builder's for ITS places (TOOL_PLACES): what they take together and nothing else,
  // under the one name, never a level of its own beside it
  for (const tool of ['build_pipeline_model', 'query_pipeline_model', 'build_semantic_model', 'query_semantic_model', 'build_pipeline_model.pipeline']) {
    const doc = schemas[tool];
    const places = TOOL_PLACES[tool.split('.')[0]].expr;
    const l = exprDef(doc);
    assert.deepEqual(l.leaves, exprDef({}, exprSchema(catalog, { places })).leaves, `${tool}: the leaves its places take`);
    assert.deepEqual([...l.fns].sort(), Object.keys(FNS).filter((fn) => places.some((p) => PLACES[p].fns.includes(fn))).sort(), `${tool}: the functions its places take`);
    assert.equal(forms(doc, doc.$defs.expr).some((f) => f.properties?.over), places.some((p) => PLACES[p].windows), `${tool}: a window's form only where a place takes one`);
    assert.equal(l.argsRef, '#/$defs/expr', `${tool}: its arguments are the one expression`);
    assert.equal(l.whereRef, '#/$defs/expr', `${tool}: and so is an aggregate's where`);
    assert.ok(!l.fns.has('event_property'), `${tool}: an event property is a leaf`);
    for (const gone of ['read_expr', 'metric_expr', 'eventstream_expr']) assert.equal(doc.$defs[gone], undefined, `${tool}: no ${gone}`);
  }
  const of = (tool) => exprDef(schemas[tool]);
  // a pipeline build: the rows' leaves, every function — no ref (a metric, another model's column)
  assert.deepEqual(of('build_pipeline_model').leaves, one.leaves.slice(0, 4));
  assert.deepEqual([...of('build_pipeline_model').fns].sort(), Object.keys(FNS).sort());
  // a read of stored rows: no event property and no raw — a build's
  assert.deepEqual(of('query_pipeline_model').leaves, ['a column — { column }', 'a constant — { value }', 'the current time — { now: true }']);
  assert.ok(!of('query_pipeline_model').fns.has('raw'));
  // a semantic declaration: its rows' leaves and { metric } (a derived metric's), no raw, no window, no sketch
  assert.deepEqual(of('build_semantic_model').leaves, [...one.leaves.slice(0, 4), '{ metric }']);
  for (const fn of ['raw', 'row_number', 'lag', 'hll_init', 'approx_count_distinct']) assert.ok(!of('build_semantic_model').fns.has(fn), `a semantic declaration takes no ${fn}`);
  // a metric query: what its where names (group_by's refs) and the steps' rows — no metric, no event property, no raw
  const sq = of('query_semantic_model').leaves;
  for (const leaf of ['a column — { column }', '{ source: "users", column }', '{ source: "events", property }', '{ semantic_model, dimension }', '{ entity }', '{ time: "metric_time" }']) assert.ok(sq.includes(leaf), `query_semantic_model: ${leaf}`);
  for (const leaf of ['{ metric }', 'an event property — { property }']) assert.ok(!sq.includes(leaf), `query_semantic_model: no ${leaf}`);
  assert.ok(!of('query_semantic_model').fns.has('raw'));
});

// What a place takes of the one expression is ONE table (PLACES), read by the writer as it builds a value:
// a leaf, a function or a window the place does not take is refused there, naming the place and what it
// takes — a pipeline step over a source's rows, a read of stored rows (a read, the steps after a metric
// query, a card's drill), a semantic model, a metric query's where, a derived metric.
test('each place takes what its row in PLACES says, and a refusal names the place and what it takes', () => {
  const d = getDialect('duckdb');
  const cols = new Map([['a', { type: 'numeric' }], ['s', { type: 'string' }], ['t', { type: 'time' }]]);
  // a place's own leaves (a metric, what group_by names) are the level's to resolve: a stand-in here
  const refs = (e) => (e.metric !== undefined || e.source !== undefined ? { sql: '"r"', type: 'numeric', name: 'r' } : null);
  const sql = (place, e) => exprSql(d, cols, e, 'x', { place, leaf: refs, catalog, source: 'events' });
  const refused = (place, e, said) => assert.throws(() => sql(place, e), (err) => err.message.startsWith(`x: ${said} is not what ${PLACES[place].what} takes — it takes `), `${place}: ${JSON.stringify(e)}`);
  const OVER_S = { partition_by: ['s'], order_by: [{ key: 't' }] };
  const raw = { fn: 'raw', sql: 'upper({1})', args: [{ column: 's' }] };
  assert.deepEqual(Object.keys(PLACES).sort(), ['derived_metric', 'metric_where', 'semantic_model', 'source_rows', 'stored_rows']);
  // a step over a source's rows: the rows' leaves and every function — a metric, a ref of another model are elsewhere
  assert.ok(sql('source_rows', raw).sql);
  refused('source_rows', { metric: 'revenue' }, '{ metric }');
  refused('source_rows', { source: 'users', column: 'country' }, '{ source, column }');
  assert.throws(() => sql('source_rows', { metric: 'revenue' }), /a metric is query_semantic_model's/, 'and says where it is');
  // a read of stored rows: no source, so no event property; no raw SQL — both a build's, from the task
  assert.ok(sql('stored_rows', { fn: 'row_number', over: OVER_S }).sql);
  assert.ok(sql('stored_rows', { now: true }).sql);
  refused('stored_rows', raw, 'raw');
  refused('stored_rows', { property: 'result_of_event_data' }, '{ property }');
  assert.throws(() => sql('stored_rows', raw), /build from the task — build_pipeline_model\(\{ request: \{ action: "start", name, from_task \} \}\)/);
  // a semantic model: no raw SQL, no window
  assert.ok(sql('semantic_model', { now: true }).sql);
  refused('semantic_model', { fn: 'raw', sql: '1' }, 'raw');
  refused('semantic_model', { fn: 'row_number', over: OVER_S }, 'row_number');
  refused('semantic_model', { fn: 'sum', args: [{ column: 'a' }], over: OVER_S }, 'a window (sum with over)');
  // a metric query's where: what group_by names and constants — conditions, logic, scalars; no column, no fold
  assert.ok(sql('metric_where', { fn: 'gt', args: [{ source: 'users', column: 'country' }, { value: 1 }] }).sql);
  refused('metric_where', { column: 'a' }, '{ column }');
  refused('metric_where', { metric: 'revenue' }, '{ metric }');
  refused('metric_where', { fn: 'count' }, 'count');
  refused('metric_where', { fn: 'json_field', args: [{ source: 'users', column: 'country' }], field: 'x' }, 'json_field');
  // a derived metric: other metrics and constants, in arithmetic
  assert.ok(sql('derived_metric', { fn: 'div', args: [{ metric: 'a' }, { metric: 'b' }] }).sql);
  refused('derived_metric', { column: 'a' }, '{ column }');
  refused('derived_metric', { fn: 'sum', args: [{ metric: 'a' }] }, 'sum');
  refused('derived_metric', { fn: 'eq', args: [{ metric: 'a' }, { value: 1 }] }, 'eq');
  assert.deepEqual(PLACES.derived_metric.fns, ['add', 'sub', 'mul', 'div', 'round', 'floor', 'ceil', 'abs', 'coalesce', 'least', 'greatest']);
  // a condition list at a place is checked alike, item by item
  assert.throws(() => conditionListSql(d, cols, [{ fn: 'eq', args: [{ column: 's' }, { value: 'x' }] }, { fn: 'eq', args: [{ metric: 'm' }, { value: 1 }] }], 'where', { place: 'stored_rows' }), /\{ metric \} is not what a read of stored rows takes/);
  // a feature passes a place of its own, in the same shape: the refusal names it
  assert.throws(() => exprSql(d, cols, raw, 'x', { place: { ...PLACES.stored_rows, what: 'a feature\'s where', hint: null } }), (err) => err.message === 'x: raw is not what a feature\'s where takes — it takes { column }, { value }, { now: true }, and every function but raw');
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
  const country = { source: 'users', column: 'country' };
  // a condition, in each subject it had, and its groups
  for (const [earlier, today, opts] of [
    [{ column: 'a', op: 'gt', value: 1 }, { fn: 'gt', args: [col('a'), val(1)] }],
    [{ column: 'a', op: 'is_null' }, { fn: 'is_null', args: [col('a')] }],
    [{ column: 'a', op: 'in', value: [1, 2] }, { fn: 'in', args: [col('a'), val(1), val(2)] }],
    [{ column: 'a', op: 'between', value: [1, 3] }, { fn: 'between', args: [col('a'), val(1), val(3)] }],
    [{ left: { fn: 'length', args: [col('a')] }, op: 'gt', right: col('b') }, { fn: 'gt', args: [{ fn: 'length', args: [col('a')] }, col('b')] }],
    [{ field: 'p', op: 'eq', value: 'x' }, { fn: 'eq', args: [{ property: 'p' }, val('x')] }, { subject: () => 'property' }],
    [{ field: 'p', op: 'eq', value: 'x' }, { fn: 'eq', args: [col('p'), val('x')] }, { subject: () => 'column' }],
    [{ field: { model: 'users', attribute: 'country' }, op: 'in', value: ['US', 'DE'] }, { fn: 'in', args: [country, val('US'), val('DE')] }],
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
  // a semantic model's dimension, as declared and as an update removes it (its model, `from` then, is its `source`)
  assert.deepEqual(currentDimension({ field: 'install_date', grain: 'week', label: 'W' }), { column: 'install_date', grain: 'week', label: 'W' });
  assert.deepEqual(currentDimension({ from: 'users', field: 'country' }), { source: 'users', column: 'country' });
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

// THE ONE REF, THE ONE INCLUDE, A SOURCE'S NAME (src/earlier-spelling.js): what a metric query named
// { model, attribute, via? } is the ref it names now — a model's column, an event property the task
// declared a dimension, or a dimension it computed, which reading the caller that knows says
// (opts.subject); a semantic model item's and a removed dimension's `from` is `source`, an update's `task`
// its `name`; each "show me more" flag is an item of the one list `include`. Each converter leaves a
// value in today's spelling as it is.
test('a { model, attribute } ref, a `from`, an update\'s `task` and the include flags convert to today\'s spelling', () => {
  const old = { model: 'users', attribute: 'country' };
  assert.ok(isEarlierRef(old));
  assert.deepEqual(currentRef(old), { source: 'users', column: 'country' }, 'a column without a subject to ask');
  assert.deepEqual(currentRef({ ...old, via: 'user' }), { source: 'users', column: 'country', via: 'user' }, 'via stays with the column');
  assert.deepEqual(currentRef({ model: 'events', attribute: 'level_id_of_event_data' }, { subject: () => 'property' }), { source: 'events', property: 'level_id_of_event_data' });
  assert.deepEqual(currentRef({ model: 'users', attribute: 'is_us' }, { subject: () => 'dimension' }), { semantic_model: ['users'], dimension: 'is_us' });
  // the subject is asked with the name and its model
  const asked = [];
  currentRef(old, { subject: (attribute, model) => { asked.push([attribute, model]); return 'column'; } });
  assert.deepEqual(asked, [['country', 'users']]);
  for (const today of [{ source: 'users', column: 'country' }, { source: 'events', property: 'p' }, { semantic_model: ['users'], dimension: 'd' }, { entity: 'user' }, { time: 'metric_time', grain: 'day' }]) {
    assert.equal(isEarlierRef(today), false);
    assert.equal(currentRef(today), today, JSON.stringify(today));
    assert.equal(currentOf(today), today, JSON.stringify(today));
  }
  // …wherever it stands: an argument of an expression, an earlier condition's field
  assert.deepEqual(currentExpression({ fn: 'eq', args: [old, val('US')] }), { fn: 'eq', args: [{ source: 'users', column: 'country' }, val('US')] });
  assert.deepEqual(currentOf([{ fn: 'not', args: [{ fn: 'eq', args: [old, val('US')] }] }]), [{ fn: 'not', args: [{ fn: 'eq', args: [{ source: 'users', column: 'country' }, val('US')] }] }]);
  // a semantic model item, a dimension an update removes, an update's task
  const COUNT = { name: 'n', expr: { fn: 'count' } };
  assert.deepEqual(currentOf({ from: 'events', measures: [COUNT] }), { source: 'events', measures: [COUNT] });
  assert.deepEqual(currentOf({ from: 'users', column: 'country' }), { source: 'users', column: 'country' });
  assert.deepEqual(currentOf({ action: 'update', context_id: 'abcdef123456', task: 't1', semantic_models: [{ from: 'users' }] }), { action: 'update', context_id: 'abcdef123456', name: 't1', semantic_models: [{ source: 'users' }] });
  const item = { source: 'events', measures: [COUNT] };
  assert.equal(currentOf(item), item);
  // a join stage's between and a funnel metric's from are no source (no model named `from` there)
  const between = { stage: 'join', with: 'users', via: 'user', attrs: [col('country')], between: { column: 'device_time', from: 'install_time_valid_from', to: 'install_time_valid_until' } };
  assert.equal(currentOf(between), between);
  // the flags: each true one an item of `include`, after what the list already holds; a false one asks for nothing
  for (const [flags, include] of [
    [{ include_columns: true }, ['columns']],
    [{ include_steps: true, include_columns: true }, ['steps', 'columns']],
    [{ include_yaml: true }, ['yaml']],
    [{ include_plan: true }, ['plan']],
    [{ include_coverage: true }, ['coverage']],
    [{ detail: 'full' }, ['details']],
    [{ include: ['steps'], include_columns: true }, ['steps', 'columns']],
  ]) {
    assert.ok(isEarlierInclude({ a: 1, ...flags }), JSON.stringify(flags));
    assert.deepEqual(currentInclude({ a: 1, ...flags }), { a: 1, include }, JSON.stringify(flags));
  }
  assert.deepEqual(currentInclude({ a: 1, include_columns: false }), { a: 1 });
  assert.deepEqual(currentInclude({ a: 1, detail: 'summary' }), { a: 1 }, 'a summary was the default: nothing more');
  for (const today of [{ a: 1 }, { a: 1, include: ['columns'] }]) assert.equal(currentInclude(today), today);
  // a value that only looks like one is no flag
  assert.equal(isEarlierInclude({ detail: true }), false);
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
  // what it grouped and filtered by, as { model, attribute }, is the ref it names; its plan, `include`
  const country = { model: 'users', attribute: 'country' };
  assert.deepEqual(currentQueryInput({ metrics: ['dau'], group_by: [country, { time: 'metric_time', grain: 'day' }], where: [{ fn: 'eq', args: [country, val('US')] }], dry_run: true, include_plan: true }), {
    metrics: ['dau'], group_by: [{ source: 'users', column: 'country' }, { time: 'metric_time', grain: 'day' }], where: [{ fn: 'eq', args: [{ source: 'users', column: 'country' }, val('US')] }], dry_run: true, include: ['plan'],
  });
  assert.deepEqual(currentQueryInput({ metrics: ['dau'], group_by: [{ model: 'events', attribute: 'p' }] }, { subject: () => 'property' }), { metrics: ['dau'], group_by: [{ source: 'events', property: 'p' }] });
  assert.deepEqual(currentQueryInput({ context_id: 'abcdef123456', queries: [{ metrics: ['dau'], group_by: [country] }] }).queries, [{ metrics: ['dau'], group_by: [{ source: 'users', column: 'country' }] }]);
  // today's spelling is the same object
  for (const v of [today, { context_id: 'abcdef123456' }, { task_ids: ['abcdef123456'], offset: 0, limit: 10 }, { context_id: 'abcdef123456', queries: [today] }, { metrics: ['dau'], group_by: [{ source: 'users', column: 'country' }], include: ['plan'] }]) assert.equal(currentQueryInput(v), v, JSON.stringify(v));
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
