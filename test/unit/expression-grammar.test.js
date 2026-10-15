// ONE EXPRESSION GRAMMAR (src/pipeline/compute.js): a condition, a measure and a computed value are one
// structure — a leaf, or a function { fn, args, …its parameters } over expressions — in ONE definition,
// `$defs.expr`, in every tool that takes one, built by one builder for that tool's places: the leaves
// (the rows' and the refs that name a value) and the functions they take, its arguments referring back to
// it. What a PLACE takes of it is one table (PLACES), read for a tool's definition and checked as the
// value is built, and the refusal names the place and what it takes; the one writer holds
// the rules of WHERE each kind may stand too — an aggregate only where a measure is written, a window
// only in a compute stage, a condition slot only booleans, a missing value only through is_null. A value
// is of the type of what it is read from, and cast converts it; a conditional aggregate folds a case. What
// a store holds in an earlier spelling is carried over by one table of converters
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
import { FNS, PLACES, EXPR_KINDS, AGGREGATE_FNS, exprSchema, exprSql, conditionListSql, propertyTypes } from '../../src/pipeline/compute.js';
import { getDialect } from '../../src/dialects/index.js';
import {
  currentCondition, currentConditions, currentExpression, currentMeasure, currentDimension, currentUnnest,
  transformStages, currentOf, currentQueryInput, isEarlierCondition, isEarlierMeasure,
  isEarlierRef, currentRef, isEarlierInclude, currentInclude,
  isTypedRead, isEarlierAggregate, isTypedUnnest, untypedUnnest, isEarlierMetricQuery,
} from '../../src/earlier-spelling.js';
import { METRIC_QUERY_FIELDS } from '../../src/schema/fields.js';
import { beside, deref, forms, pinned } from '../helpers/schema-nav.js';
import { stageBranch } from '../helpers/stage-schema.js';

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
/** A CASE of one branch: `then` where the conditions hold, `other` (when given) on every other row. */
const caseOf = (when, then, other) => ({ fn: 'case', cases: [{ when, then }], ...(other !== undefined ? { else: other } : {}) });

/** The expression definition a schema carries: its leaves (the forms with no `fn`), the functions it
 *  offers, what its arguments are, and every field a form or the union beside them names. */
function exprDef(doc, node = doc.$defs?.expr) {
  const all = forms(doc, node);
  return {
    leaves: all.filter((f) => !f.properties?.fn).map((f) => f.title),
    fns: new Set(all.flatMap((f) => pinned(doc, f, 'fn'))),
    // what an argument of it is: the same definition, said beside its forms
    argsRef: beside(doc, node, 'args')?.items?.$ref,
    fields: new Set([...all.flatMap((f) => Object.keys(f.properties || {})), ...Object.keys(deref(doc, node)?.properties || {})]),
  };
}

/** The fields of the form a function is offered in (the first: an aggregate's that folds rows). */
const formOf = (doc, fn, node = doc.$defs?.expr) => forms(doc, node).find((f) => pinned(doc, f, 'fn').includes(fn));

test('every tool that takes an expression carries the row expression, $defs.expr, built for its places, its arguments referring back to it', () => {
  // the definition with no place named (an internal caller's): every leaf of the rows, every ref that
  // names a value, every function
  const one = exprDef({}, exprSchema(catalog));
  assert.deepEqual(one.leaves.slice(0, 4), ['a column — { column }', 'an event property — { property }', 'a constant — { value }', 'the current time — { now: true }']);
  for (const ref of ['{ source: "users", column }', '{ source: "events", property }', '{ semantic_model, dimension }', '{ entity }', '{ metric }', '{ time: "metric_time" }']) assert.ok(one.leaves.includes(ref), `${ref} is a leaf: ${JSON.stringify(one.leaves)}`);
  assert.ok(!one.leaves.some((t) => /^\{ source \}$|event \}$/.test(t)), 'a ref that names no value (a source, an event) is no leaf');
  assert.deepEqual([...one.fns].sort(), Object.keys(FNS).sort(), 'every function, windows and raw included');
  // a tool's is the one builder's for ITS places (TOOL_PLACES): what they take together and nothing else,
  // under the one name, never a level of its own beside it — less the aggregates where its measures are a
  // kind of their own (build_semantic_model's $defs.aggregate)
  for (const tool of ['build_pipeline_model', 'query_model', 'build_semantic_model', 'build_pipeline_model.pipeline']) {
    const doc = schemas[tool];
    const kinds = TOOL_PLACES[tool.split('.')[0]];
    const places = kinds.expr;
    const l = exprDef(doc);
    assert.deepEqual(l.leaves, exprDef({}, exprSchema(catalog, { places })).leaves, `${tool}: the leaves its places take`);
    assert.deepEqual([...l.fns].sort(), Object.keys(FNS).filter((fn) => places.some((p) => PLACES[p].fns.includes(fn)) && !(kinds.aggregate && AGGREGATE_FNS.includes(fn))).sort(), `${tool}: the functions its places take`);
    const windows = places.some((p) => PLACES[p].windows);
    assert.equal(forms(doc, doc.$defs.expr).some((f) => f.properties?.over), windows, `${tool}: a window's form only where a place takes one`);
    // …a window function's `over` $defs.over, an aggregate over a window's $defs.over_frame, there and only there
    for (const def of ['over', 'over_frame']) assert.equal(def in doc.$defs, windows, `${tool}: $defs.${def} ${windows ? 'missing' : 'with no window form'}`);
    for (const f of forms(doc, doc.$defs.expr).filter((x) => x.properties?.over)) assert.equal(f.properties.over.$ref, f.title.includes('(over a window)') ? '#/$defs/over_frame' : '#/$defs/over', `${tool}: ${f.title} refers to its window`);
    assert.equal(l.argsRef, '#/$defs/expr', `${tool}: its arguments are the one expression`);
    // a conditional aggregate folds a case: no aggregate takes a where of its own, beside the forms or in one
    assert.equal(l.fields.has('where'), false, `${tool}: no aggregate's where`);
    assert.ok(!l.fns.has('event_property'), `${tool}: an event property is a leaf`);
    for (const gone of ['read_expr', 'eventstream_expr']) assert.equal(doc.$defs[gone], undefined, `${tool}: no ${gone}`);
    // a closed kind of the expression is there only where a place of that kind is
    for (const kind of ['aggregate', 'metric_expr']) assert.equal(kind in doc.$defs, !!kinds[kind], `${tool}: $defs.${kind}`);
  }
  const of = (tool) => exprDef(schemas[tool]);
  // a pipeline build: the rows' leaves, every function — no ref (a metric, another model's column)
  assert.deepEqual(of('build_pipeline_model').leaves, one.leaves.slice(0, 4));
  assert.deepEqual([...of('build_pipeline_model').fns].sort(), Object.keys(FNS).sort());
  // a query — a read of stored rows, a metric query's where: no event property and no raw — a build's
  assert.deepEqual(of('query_model').leaves.slice(0, 3), ['a column — { column }', 'a constant — { value }', 'the current time — { now: true }']);
  assert.ok(!of('query_model').leaves.includes('an event property — { property }'));
  assert.ok(!of('query_model').fns.has('raw'));
  // a semantic declaration: its rows' leaves and no aggregate — a measure is a kind of its own, ONE
  // aggregate of the task's whose arguments are the rows' expression; a derived metric's value is another,
  // { metric } and { value } in arithmetic, its arguments of its own kind. No raw, no window, no sketch
  const sem = schemas.build_semantic_model;
  assert.deepEqual(of('build_semantic_model').leaves, one.leaves.slice(0, 4));
  for (const fn of AGGREGATE_FNS) assert.ok(!of('build_semantic_model').fns.has(fn), `a semantic row expression takes no ${fn}`);
  const measure = exprDef(sem, sem.$defs.aggregate);
  assert.deepEqual(measure.leaves, [], 'a measure is a function: no leaf');
  assert.deepEqual([...measure.fns].sort(), AGGREGATE_FNS.filter((fn) => PLACES.semantic_model.fns.includes(fn)).sort(), 'the aggregates a semantic model takes');
  assert.equal(measure.argsRef, EXPR_KINDS.aggregate.args, 'its arguments are the rows\' expression');
  assert.ok(!forms(sem, sem.$defs.aggregate).some((f) => f.properties?.over), 'it folds rows: no window form');
  const derived = exprDef(sem, sem.$defs.metric_expr);
  assert.deepEqual(derived.leaves, ['a constant — { value }', '{ metric }']);
  assert.deepEqual([...derived.fns].sort(), [...PLACES.derived_metric.fns].sort());
  assert.equal(derived.argsRef, '#/$defs/metric_expr', 'its arguments are of its own kind');
  for (const fn of ['raw', 'row_number', 'lag', 'hll_init', 'approx_count_distinct']) {
    for (const kind of ['expr', 'aggregate', 'metric_expr']) assert.ok(!exprDef(sem, sem.$defs[kind]).fns.has(fn), `a semantic declaration's ${kind} takes no ${fn}`);
  }
  // a metric query: what its where steps name (group_by's refs) and the rows after its metrics step — no metric, no event property, no raw
  const sq = of('query_model').leaves;
  for (const leaf of ['a column — { column }', '{ source: "users", column }', '{ source: "events", property }', '{ semantic_model, dimension }', '{ entity }', '{ time: "metric_time" }']) assert.ok(sq.includes(leaf), `query_model: ${leaf}`);
  for (const leaf of ['{ metric }', 'an event property — { property }']) assert.ok(!sq.includes(leaf), `query_model: no ${leaf}`);
  assert.ok(!of('query_model').fns.has('raw'));
});

// A VALUE'S TYPE IS WHAT IT IS READ FROM, AND ONE FUNCTION CONVERTS IT (cast): an event property is read
// as the type the catalog declares, a field of one and what json_field takes out as text, what element_at /
// array_last take out as the array's items — none of them names a type. Only what makes a value of a type
// it says names one: cast, case, raw. An aggregate folds the rows its argument has a value on, and takes no
// where of its own.
test('a read names no type — cast converts; only cast, case and raw say a type; an aggregate takes no where', () => {
  for (const tool of ['build_pipeline_model', 'build_semantic_model']) {
    const doc = schemas[tool];
    const leaf = forms(doc, doc.$defs.expr).find((f) => f.title === 'an event property — { property }');
    assert.deepEqual(Object.keys(leaf.properties).sort(), ['field', 'property'], `${tool}: { property, field? }`);
    for (const fn of ['cast', 'case']) assert.ok(formOf(doc, fn).properties.type, `${tool}: ${fn} says its type`);
    // (a semantic measure is a kind of its own: its aggregates are there)
    for (const fn of ['sum', 'count', 'percentile']) assert.equal(formOf(doc, fn, doc.$defs.aggregate || doc.$defs.expr).properties.where, undefined, `${tool}: ${fn} takes no where`);
  }
  const build = schemas.build_pipeline_model;
  assert.ok(formOf(build, 'raw').properties.type, 'raw says what its SQL yields');
  for (const fn of ['json_field', 'element_at', 'array_last']) assert.equal(formOf(build, fn).properties.type, undefined, `${fn} names no type`);
  assert.equal(forms(build, stageBranch(build, 'unnest')).some((f) => f.properties?.type), false, 'an unnest reads its element as it is');
  // what a property is read as is the catalog's type, text where it declares none — per source, or the
  // type every events source declaring the name agrees on
  const of = propertyTypes(catalog, 'events');
  assert.equal(of('price_in_usd_of_event_data'), 'numeric');
  assert.equal(of('result_of_event_data'), 'string');
  assert.equal(of('no_such_property'), undefined);
  assert.equal(propertyTypes(catalog)('anr_duration_of_event_data'), 'numeric', 'crashlytics alone declares it');
  assert.equal(propertyTypes(null)('price_in_usd_of_event_data'), undefined, 'no catalog: not known');
  // the columns a read makes carry those types: a numeric property a number, a text one text until cast
  const PAYLOAD = new Set([...COLS, 'price_in_usd_of_event_data', 'result_of_event_data']);
  const built = renderPipeline(catalog, catalog.dialect, 'events', [
    { stage: 'compute', name: 'price', expr: { property: 'price_in_usd_of_event_data' } },
    { stage: 'compute', name: 'result', expr: { property: 'result_of_event_data' } },
    { stage: 'compute', name: 'result_n', expr: { fn: 'cast', args: [{ property: 'result_of_event_data' }], type: 'int' } },
  ], { physicalCols: PAYLOAD });
  assert.deepEqual(['price', 'result', 'result_n'].map((c) => built.columns.get(c).type), ['numeric', 'string', 'int']);
  // a call that names the type is refused with the read as it is now: the property alone where the catalog
  // reads it as that type (the converter asked, opts.propertyType), cast where it is another or not known
  const step = (expr, opts) => validateInput(validators.build_pipeline_model, { action: 'add_steps', context_id: 'abcdef123456', steps: [{ stage: 'compute', name: 'p', expr }] }, opts);
  const shown = (r, now) => assert.ok(r.errors.join(' ').includes(`\`steps.0.expr\` is written in an earlier spelling — write ${JSON.stringify(now)}`), r.errors.join(' | '));
  const price = { property: 'price_in_usd_of_event_data' };
  shown(step({ ...price, type: 'numeric' }, { propertyType: propertyTypes(catalog) }), price);
  shown(step({ ...price, type: 'int' }, { propertyType: propertyTypes(catalog) }), { fn: 'cast', args: [price], type: 'int' });
  shown(step({ ...price, type: 'numeric' }), { fn: 'cast', args: [price], type: 'numeric' });
});

// What a place takes of the one expression is ONE table (PLACES), read by the writer as it builds a value:
// a leaf, a function or a window the place does not take is refused there, naming the place and what it
// takes — a pipeline step over a source's rows, a read of stored rows (a read, the steps after a metric
// query's metrics step, a card's drill), a semantic model, a where step before the metrics step, a
// derived metric.
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
  assert.throws(() => sql('source_rows', { metric: 'revenue' }), /a metric is query_model's/, 'and says where it is');
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
    measure({ fn: 'percentile', args: [caseOf([{ fn: 'gt', args: [col('a'), val(0)] }], col('a'))], percentile: 0.9 }),
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
  // …and in the conditions of the case a conditional aggregate folds, which are a condition slot
  assert.throws(() => render([measure({ fn: 'count', args: [caseOf([{ fn: 'gt', args: [{ fn: 'row_number', over: OVER }, val(1)] }], val(1))] })]), /window function \(row_number with over\) cannot stand in a condition/);
  // the ways that are: a window in a compute stage, folded after it
  const ok = render([
    { stage: 'compute', name: 'nth', expr: { fn: 'row_number', over: OVER } },
    measure({ fn: 'sum', args: [caseOf([{ fn: 'gt', args: [col('nth'), val(1)] }], col('nth'))] }),
  ]);
  assert.equal(ok.columns.get('m').type, 'numeric');
});

// THE WINDOW IS NAMED ONCE PER WHAT READS IT, in every tool whose expression takes one, both built by
// overSchema: a window function's `over` is $defs.over (its partition and order — a rank or a neighbour reads
// its partition whole), an aggregate over a window's is $defs.over_frame (the same and the frame each value
// folds). So a frame on a rank or a neighbour is refused by the schema, and — for a caller past it — where
// the value is built, saying to leave it out.
test('a window function\'s window is $defs.over, an aggregate over a window\'s $defs.over_frame: a frame on a rank or a neighbour is refused', () => {
  for (const tool of ['build_pipeline_model', 'query_model', 'query_model']) {
    const doc = schemas[tool];
    const windowed = forms(doc, doc.$defs.expr).filter((f) => f.properties?.over);
    assert.ok(windowed.length >= 4, `${tool}: its window forms`);
    for (const f of windowed) assert.equal(deref(doc, f.properties.over), f.title.includes('(over a window)') ? doc.$defs.over_frame : doc.$defs.over, `${tool}: ${f.title}`);
    assert.deepEqual(Object.keys(doc.$defs.over.properties), ['partition_by', 'order_by']);
    assert.deepEqual(Object.keys(doc.$defs.over_frame.properties), ['partition_by', 'order_by', 'frame']);
  }
  for (const def of ['over', 'over_frame']) assert.equal(schemas.build_semantic_model.$defs[def], undefined, 'a semantic model takes no window');
  const FRAMED = { ...OVER, frame: { mode: 'rows', preceding: 6 } };
  const step = (expr) => validateInput(validators.build_pipeline_model, { action: 'add_steps', context_id: 'abcdef123456', steps: [{ stage: 'compute', name: 'x', expr }] });
  for (const expr of [{ fn: 'sum', args: [col('session_number')], over: FRAMED }, { fn: 'count', over: FRAMED }, { fn: 'row_number', over: OVER }]) {
    assert.equal(step(expr).ok, true, `${JSON.stringify(expr)}: ${step(expr).errors?.join(' | ')}`);
  }
  assert.match(step({ fn: 'sum', args: [col('session_number')], over: { ...OVER, rows: 6 } }).errors.join(' | '), /`steps\.0\.expr\.over` has an unexpected property 'rows'/);
  // a frame on a rank or a neighbour is refused by the schema…
  for (const expr of [{ fn: 'row_number', over: FRAMED }, { fn: 'lag', args: [col('session_number')], over: FRAMED }]) {
    assert.match(step(expr).errors.join(' | '), /`steps\.0\.expr\.over` has an unexpected property 'frame'/, expr.fn);
  }
  // …and, past it, where the value is built: an aggregate over a frame builds; a frame on a rank or a
  // neighbour is refused, naming the rule
  assert.equal(render([{ stage: 'compute', name: 'x', expr: { fn: 'sum', args: [col('session_number')], over: FRAMED } }]).columns.get('x').type, 'numeric');
  for (const expr of [{ fn: 'row_number', over: FRAMED }, { fn: 'lag', args: [col('session_number')], over: FRAMED }]) {
    assert.throws(() => render([{ stage: 'compute', name: 'x', expr }]), new RegExp(`${expr.fn} takes no \`over\\.frame\` — a frame bounds what an aggregate over a window \\(sum / average / min / max / count\\) folds for each row.*Leave the frame out`), expr.fn);
  }
});

// A CONDITIONAL AGGREGATE FOLDS A CASE: a value on the rows where the condition holds, missing on the
// others, which every aggregate skips. An else gives those rows a value, which every aggregate folds as
// the value it is — an average of 1 else 0 is a share of the rows, a max of it "any". Under count and
// count_distinct (its approximations alike: approx_count_distinct, and hll_init's sketch) an else always
// changes what is counted, so there it is refused where the value is built, saying to leave it out; an else
// of null is none.
test('an aggregate over a case with an else is refused under count and count_distinct only — the rule named where it is built', () => {
  const isTut = { fn: 'eq', args: [col('event_name'), val('tutorial')] };
  const trap = (fn) => new RegExp(`${fn} over a case with an else — an else under count, count_distinct, approx_count_distinct, hll_init always changes what is counted.*Leave the else out`, 's');
  for (const fn of ['count', 'count_distinct', 'approx_count_distinct', 'hll_init']) {
    assert.throws(() => render([measure({ fn, args: [caseOf([isTut], col('session_number'), val(0))] })]), trap(fn), fn);
  }
  // over a window alike, and in a pivot's cell, whose own condition is folded in beside the caller's
  assert.throws(() => render([{ stage: 'compute', name: 'x', expr: { fn: 'count', args: [caseOf([isTut], val(1), val(0))], over: OVER } }]), trap('count'));
  const pivot = (m) => render([{ stage: 'pivot', on: 'event_name', group_by: ['player_id_of_internal'], measure: m, values: [{ value: 'tutorial', name: 'tut' }, { value: null, name: 'none' }] }]);
  assert.throws(() => pivot({ fn: 'count', args: [caseOf([isTut], val(1), val(0))] }), trap('count'));
  assert.throws(() => pivot({ fn: 'count_distinct', args: [caseOf([isTut], col('player_id_of_internal'), val('none'))] }), trap('count_distinct'));
  // what is not: every other aggregate with an else (folding, over a window, in a pivot's cell), an else
  // of null, a case with no else
  for (const fn of ['sum', 'average', 'min', 'max', 'median', 'stddev', 'variance']) {
    assert.ok(render([measure({ fn, args: [caseOf([isTut], col('session_number'), val(0))] })]).columns.has('m'), fn);
  }
  assert.ok(render([measure({ fn: 'percentile', args: [caseOf([isTut], col('session_number'), val(0))], percentile: 0.5 })]).columns.has('m'));
  for (const fn of ['sum', 'average', 'max']) assert.ok(render([{ stage: 'compute', name: 'x', expr: { fn, args: [caseOf([isTut], val(1), val(0))], over: OVER } }]).columns.has('x'), fn);
  assert.equal(render([measure({ fn: 'count', args: [caseOf([isTut], val(1), val(null))] })]).columns.get('m').type, 'int');
  assert.equal(render([measure({ fn: 'count', args: [caseOf([isTut], val(1))] })]).columns.get('m').type, 'int');
  for (const fn of ['sum', 'average']) assert.deepEqual([...pivot({ fn, args: [caseOf([isTut], col('session_number'), val(0))] }).columns.keys()], ['player_id_of_internal', 'tut', 'none'], fn);
  assert.ok(pivot({ fn: 'count', args: [caseOf([{ fn: 'gt', args: [col('session_number'), val(1)] }], val(1))] }).columns.has('tut'));
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
  // a CASE's when is a condition slot too — the case a conditional aggregate folds alike
  assert.throws(() => render([{ stage: 'compute', name: 'k', expr: { fn: 'case', cases: [{ when: [col('session_number')], then: val(1) }] } }]), notACondition);
  assert.throws(() => render([measure({ fn: 'count', args: [caseOf([col('session_number')], val(1))] })]), notACondition);
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
  // an expression: the event_property function, the array functions naming their property, a list constant,
  // a typed read (cast where its type is not what the read yields now), an aggregate's where (the case it
  // folds now), nested ones
  for (const [earlier, today] of [
    [{ fn: 'event_property', property: 'p', field: 'f', type: 'numeric' }, { fn: 'cast', args: [{ property: 'p', field: 'f' }], type: 'numeric' }],
    [{ fn: 'event_property', property: 'p', field: 'f', type: 'string' }, { property: 'p', field: 'f' }],
    [{ fn: 'array_length', property: 'items' }, { fn: 'array_length', args: [{ property: 'items' }] }],
    [{ fn: 'array_contains', property: 'items', item: 'cat' }, { fn: 'array_contains', args: [{ property: 'items' }, val('cat')] }],
    [{ fn: 'not_in', args: [col('a'), { value: ['x', 'y'] }] }, { fn: 'not_in', args: [col('a'), val('x'), val('y')] }],
    [{ fn: 'case', cases: [{ when: [{ column: 'a', op: 'eq', value: 1 }], then: { fn: 'event_property', property: 'p' } }], else: val(0) }, { fn: 'case', cases: [{ when: [{ fn: 'eq', args: [col('a'), val(1)] }], then: { property: 'p' } }], else: val(0) }],
    [{ fn: 'json_field', args: [col('j')], field: 'f', type: 'int' }, { fn: 'cast', args: [{ fn: 'json_field', args: [col('j')], field: 'f' }], type: 'int' }],
    [{ fn: 'json_field', args: [col('j')], field: 'f', type: 'string' }, { fn: 'json_field', args: [col('j')], field: 'f' }],
    [{ fn: 'element_at', args: [col('a')], index: 2, type: 'numeric' }, { fn: 'cast', args: [{ fn: 'element_at', args: [col('a')], index: 2 }], type: 'numeric' }],
    // (an element is of its array's items, which the value does not say: the cast stays, a text's too)
    [{ fn: 'array_last', args: [col('a')], type: 'string' }, { fn: 'cast', args: [{ fn: 'array_last', args: [col('a')] }], type: 'string' }],
    [{ fn: 'count', where: [{ column: 'a', op: 'in', value: [1, 2] }] }, { fn: 'count', args: [caseOf([{ fn: 'in', args: [col('a'), val(1), val(2)] }], val(1))] }],
    [{ fn: 'sum', args: [col('x')], where: [{ fn: 'gt', args: [col('a'), val(0)] }] }, { fn: 'sum', args: [caseOf([{ fn: 'gt', args: [col('a'), val(0)] }], col('x'))] }],
    [{ fn: 'sum', args: [col('x')], where: [] }, { fn: 'sum', args: [col('x')] }],
    [{ fn: 'div', args: [{ fn: 'count', args: [], where: [{ fn: 'is_null', args: [col('a')] }] }, { fn: 'count' }] }, { fn: 'div', args: [{ fn: 'count', args: [caseOf([{ fn: 'is_null', args: [col('a')] }], val(1))] }, { fn: 'count' }] }],
  ]) {
    assert.deepEqual(currentExpression(earlier), today, JSON.stringify(earlier));
    assert.deepEqual(currentExpression(today), today, `${JSON.stringify(today)} is today's`);
  }
  // a typed event property: the leaf alone where its type is the catalog's (opts.propertyType), a cast to
  // any other — and a cast where the catalog is not known
  const typed = { property: 'price_in_usd_of_event_data', type: 'numeric' };
  const propertyType = propertyTypes(catalog, 'events');
  assert.ok(isTypedRead(typed) && isTypedRead({ fn: 'json_field', args: [col('j')], field: 'f', type: 'int' }));
  assert.equal(isTypedRead({ property: 'p' }), false);
  assert.equal(isTypedRead({ fn: 'cast', args: [col('a')], type: 'int' }), false, 'cast says what it makes');
  assert.deepEqual(currentExpression(typed, { propertyType }), { property: 'price_in_usd_of_event_data' });
  assert.deepEqual(currentExpression({ ...typed, type: 'int' }, { propertyType }), { fn: 'cast', args: [{ property: 'price_in_usd_of_event_data' }], type: 'int' });
  assert.deepEqual(currentExpression(typed), { fn: 'cast', args: [{ property: 'price_in_usd_of_event_data' }], type: 'numeric' });
  assert.deepEqual(currentOf([where({ fn: 'gt', args: [typed, val(1)] })], { propertyType }), [where({ fn: 'gt', args: [{ property: 'price_in_usd_of_event_data' }, val(1)] })]);
  // an aggregate's where: only one folding rows took it; a window's is refused as a window's (by the writer)
  assert.ok(isEarlierAggregate({ fn: 'count', where: [] }));
  const windowed = { fn: 'sum', args: [col('x')], over: {}, where: [{ fn: 'gt', args: [col('a'), val(0)] }] };
  assert.equal(isEarlierAggregate(windowed), false);
  assert.deepEqual(currentExpression(windowed), windowed);
  // …its argument a case already: folded as a pivot's cell is (foldWhere, the one builder) — the
  // conditions in every branch, the else only where they hold
  const gt = { fn: 'gt', args: [col('a'), val(0)] };
  const isX = { fn: 'eq', args: [col('e'), val('x')] };
  assert.deepEqual(currentExpression({ fn: 'average', args: [caseOf([isX], val(1), val(0))], where: [gt] }), { fn: 'average', args: [{ fn: 'case', cases: [{ when: [gt, isX], then: val(1) }], else: caseOf([gt], val(0)) }] });
  // a measure: `fn` before `agg`, `q` before `percentile`, a cast before a function, its where a case, a
  // pivot's without its name
  for (const [earlier, today] of [
    [{ name: 'n', agg: 'count' }, { name: 'n', expr: { fn: 'count', args: [] } }],
    [{ name: 'r', agg: 'sum', column: 'price' }, { name: 'r', expr: { fn: 'sum', args: [col('price')] } }],
    [{ name: 'a', fn: 'avg', column: 'x' }, { name: 'a', expr: { fn: 'average', args: [col('x')] } }],
    [{ name: 'p', fn: 'quantile', q: 0.5, field: 'x', cast: 'numeric', where: [{ field: 'e', op: 'eq', value: 'a' }], label: 'P' }, { name: 'p', expr: { fn: 'percentile', args: [caseOf([{ fn: 'eq', args: [col('e'), val('a')] }], { fn: 'cast', args: [col('x')], type: 'numeric' })], percentile: 0.5 }, label: 'P' }],
    [{ name: 'c', agg: 'count', where: [{ column: 'e', op: 'eq', value: 'a' }] }, { name: 'c', expr: { fn: 'count', args: [caseOf([{ fn: 'eq', args: [col('e'), val('a')] }], val(1))] } }],
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
  // …and one naming its element's type: text said nothing; another is the element read under
  // `<name>_element` and a compute stage casting it under its name — two steps, so in a list of steps
  const typedUnnest = { stage: 'unnest', expr: { property: 'items' }, name: 'i', type: 'int' };
  assert.ok(isTypedUnnest(typedUnnest));
  assert.equal(isTypedUnnest(unnestToday), false);
  assert.deepEqual(untypedUnnest({ ...typedUnnest, type: 'string' }), [unnestToday]);
  const split = [{ stage: 'unnest', expr: { property: 'items' }, name: 'i_element' }, { stage: 'compute', name: 'i', expr: { fn: 'cast', args: [col('i_element')], type: 'int' } }];
  assert.deepEqual(untypedUnnest(typedUnnest), split);
  assert.deepEqual(untypedUnnest({ stage: 'unnest', property: 'items', name: 'i', type: 'int' }), split, 'its array named the earlier way too');
  const limit = { stage: 'limit', limit: 5 };
  assert.deepEqual(currentOf([typedUnnest, limit]), [...split, limit]);
  assert.deepEqual(currentOf({ ...typedUnnest, type: 'string' }), unnestToday, 'on its own, a text element drops its type');
  assert.equal(currentOf(typedUnnest), typedUnnest, 'on its own, an element of another type is two steps, no one value: left for the refusal to say');
  // the element's name is a name a step may make, and none another step of the list makes
  const NAME = /^[a-z][a-z0-9_]{0,40}$/;
  const long = 'a'.repeat(41);
  const [longUnnest, longCast] = untypedUnnest({ ...typedUnnest, name: long });
  assert.ok(NAME.test(longUnnest.name) && longUnnest.name !== long, longUnnest.name);
  assert.deepEqual([longCast.name, longCast.expr.args[0].column], [long, longUnnest.name]);
  const made = { stage: 'compute', name: 'i_element', expr: val(1) };
  const [, second, , third] = currentOf([made, typedUnnest, { ...typedUnnest, type: 'numeric' }]);
  assert.deepEqual([second.name, third.name], ['i_element_2', 'i_element_3']);
  // a read's transform is its steps
  assert.deepEqual(currentOf({ context_id: 'abcdef123456', transform: { group_by: ['a'] } }), { context_id: 'abcdef123456', steps: [{ stage: 'aggregate', group_by: ['a'], measures: [{ name: 'rows', expr: { fn: 'count' } }] }] });
  assert.deepEqual(transformStages({}), []);
  // a metric query is its steps: its metrics a metrics step, its order_by the order_by step after it
  const keys = [{ key: 'revenue', direction: 'desc' }];
  assert.deepEqual(currentOf({ context_id: 'abcdef123456', metrics: ['revenue'], order_by: keys, limit: 5 }), { context_id: 'abcdef123456', limit: 5, steps: [{ stage: 'metrics', metrics: ['revenue'] }, { stage: 'order_by', keys }] });
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
// currentQueryInput): a read's steps were its `stages` (its `transform` before that); a metric query is its
// steps — its `metrics` and `group_by` its metrics step, its `where` a where step before it, its steps and
// its `order_by` (an order_by step) after it — a batch's queries alike, what its steps hold in the one
// grammar, and the same object when nothing in it is of an earlier spelling.
test('a stored query input is carried over as steps: stages, transform, a metric query\'s metrics, group_by, where and order_by', () => {
  const limit = { stage: 'limit', limit: 3 };
  const dau = { stage: 'metrics', metrics: ['dau'] };
  // a pipeline read
  assert.deepEqual(currentQueryInput({ context_id: 'abcdef123456', stages: [limit] }), { context_id: 'abcdef123456', steps: [limit] });
  assert.deepEqual(currentQueryInput({ context_id: 'abcdef123456', transform: { group_by: ['a'] } }), { context_id: 'abcdef123456', steps: [{ stage: 'aggregate', group_by: ['a'], measures: [{ name: 'rows', expr: { fn: 'count' } }] }] });
  // a metric query: its metrics step, then the steps it already had, then its order_by
  const keys = [{ key: 'metric_time_day', direction: 'desc' }];
  assert.deepEqual(currentQueryInput({ metrics: ['dau'] }), { steps: [dau] });
  assert.deepEqual(currentQueryInput({ metrics: ['dau'], order_by: keys }), { steps: [dau, { stage: 'order_by', keys }] });
  assert.deepEqual(currentQueryInput({ metrics: ['dau'], steps: [limit], order_by: keys }), { steps: [dau, limit, { stage: 'order_by', keys }] });
  assert.deepEqual(currentQueryInput({ metrics: ['dau'], order_by: [], group_by: [], where: [] }), { steps: [dau] }, 'an empty list says nothing');
  // a batch: each query alike, the ones already in today's spelling kept by identity
  const today = { steps: [dau, limit] };
  const batch = currentQueryInput({ context_id: 'abcdef123456', queries: [today, { metrics: ['dau'], order_by: keys }, { stages: [limit] }] });
  assert.equal(batch.queries[0], today);
  assert.deepEqual(batch.queries.slice(1), [{ steps: [dau, { stage: 'order_by', keys }] }, { steps: [limit] }]);
  // what it grouped by is its metrics step's group_by and what it filtered by a where step before it, each
  // { model, attribute } the ref it names; its plan, `include`
  const country = { model: 'users', attribute: 'country' };
  const byCountry = { source: 'users', column: 'country' };
  assert.deepEqual(currentQueryInput({ metrics: ['dau'], group_by: [country, { time: 'metric_time', grain: 'day' }], where: [{ fn: 'eq', args: [country, val('US')] }], dry_run: true, include_plan: true }), {
    dry_run: true, include: ['plan'],
    steps: [{ stage: 'where', conditions: [{ fn: 'eq', args: [byCountry, val('US')] }] }, { ...dau, group_by: [byCountry, { time: 'metric_time', grain: 'day' }] }],
  });
  assert.deepEqual(currentQueryInput({ metrics: ['dau'], group_by: [{ model: 'events', attribute: 'p' }] }, { subject: () => 'property' }), { steps: [{ ...dau, group_by: [{ source: 'events', property: 'p' }] }] });
  assert.deepEqual(currentQueryInput({ context_id: 'abcdef123456', queries: [{ metrics: ['dau'], group_by: [country] }] }).queries, [{ steps: [{ ...dau, group_by: [byCountry] }] }]);
  // what its steps hold, in the one grammar: a ref in a metrics step or a where step, an aggregate's where after it
  const isUS = { fn: 'eq', args: [byCountry, val('US')] };
  assert.deepEqual(currentQueryInput({ steps: [{ stage: 'where', conditions: [{ fn: 'eq', args: [country, val('US')] }] }, { ...dau, group_by: [country] }] }), { steps: [{ stage: 'where', conditions: [isUS] }, { ...dau, group_by: [byCountry] }] });
  const counted = { stage: 'aggregate', measures: [{ name: 'n', expr: { fn: 'count', where: [{ fn: 'gt', args: [col('dau'), val(1)] }] } }] };
  assert.deepEqual(currentQueryInput({ steps: [dau, counted] }).steps[1].measures[0].expr, { fn: 'count', args: [caseOf([{ fn: 'gt', args: [col('dau'), val(1)] }], val(1))] });
  // today's spelling is the same object
  for (const v of [today, { context_id: 'abcdef123456' }, { task_ids: ['abcdef123456'], offset: 0, limit: 10 }, { context_id: 'abcdef123456', queries: [today] }, { steps: [{ stage: 'where', conditions: [isUS] }, { ...dau, group_by: [byCountry] }], include: ['plan'] }]) assert.equal(currentQueryInput(v), v, JSON.stringify(v));
  // a window's order_by is not a metric query's (no metrics beside it)
  assert.equal(currentQueryInput(OVER), OVER);
  const windowed = { stage: 'compute', name: 'n', expr: { fn: 'row_number', over: OVER } };
  assert.equal(currentOf(windowed), windowed);
});

// A METRIC QUERY OF AN EARLIER FORM is told by its metrics named outside its steps — where a query stands
// (a kept input, a batch's item) that alone says it; anywhere else a field of a query beside them, so a
// list an update removes ({ remove: { metrics: [...] } }) or a derived metric's inputs are never one.
test('an earlier metric query is its metrics outside its steps, beside a query\'s field — never a removal or a step', () => {
  assert.ok(isEarlierMetricQuery({ metrics: ['dau'] }, true));
  assert.equal(isEarlierMetricQuery({ metrics: ['dau'] }), false, 'by itself, a list of names');
  for (const k of ['context_id', 'group_by', 'where', 'order_by', 'steps', 'time_range', 'limit', 'materialize', 'dry_run']) assert.ok(isEarlierMetricQuery({ metrics: ['dau'], [k]: k === 'limit' ? 5 : [] }), k);
  assert.equal(isEarlierMetricQuery({ stage: 'metrics', metrics: ['dau'] }, true), false, 'a metrics step is today\'s');
  assert.equal(isEarlierMetricQuery({ metrics: [{ name: 'n', type: 'simple', measure: 'n' }] }, true), false, 'a declaration\'s metrics are objects');
  assert.equal(isEarlierMetricQuery({ metrics: [] }, true), false, 'no metric named is no metric query');
  assert.equal(isEarlierMetricQuery({ metrics: [], group_by: [], context_id: 'abcdef123456' }), false);
  // a field of today's query, read off its form (METRIC_QUERY_FIELDS, what src/schema.js builds it from)
  for (const k of METRIC_QUERY_FIELDS) assert.ok(isEarlierMetricQuery({ metrics: ['dau'], [k]: true }), k);
  const update = { action: 'update', context_id: 'abcdef123456', name: 'ret', remove: { metrics: ['n'] } };
  assert.equal(currentOf(update), update);
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
    { stage: 'aggregate', group_by: ['event_name'], measures: [{ name: 'n', agg: 'count' }, { name: 's', agg: 'sum', column: 'session_number', where: [{ column: 'session_number', op: 'gt', value: 2 }] }, { name: 'f', expr: { fn: 'count', args: [], where: [{ fn: 'eq', args: [col('event_name'), val('tutorial')] }] } }] },
  ];
  const today = [
    where({ fn: 'in', args: [col('event_name'), val('tutorial'), val('first_launch')] }, { fn: 'or', args: [{ fn: 'gt', args: [col('session_number'), val(1)] }, { fn: 'is_null', args: [col('session_number')] }] }),
    { stage: 'aggregate', group_by: ['event_name'], measures: [{ name: 'n', expr: { fn: 'count', args: [] } }, { name: 's', expr: { fn: 'sum', args: [caseOf([{ fn: 'gt', args: [col('session_number'), val(2)] }], col('session_number'))] } }, { name: 'f', expr: { fn: 'count', args: [caseOf([{ fn: 'eq', args: [col('event_name'), val('tutorial')] }], val(1))] } }] },
  ];
  const built = render(kept);
  assert.deepEqual(kept.map((s) => built.current.get(s)), today);
  assert.deepEqual([...built.columns.entries()], [...render(today).columns.entries()]);
  const again = render(today);
  for (const s of today) assert.equal(again.current.get(s), s, 'today\'s spelling is kept by identity');
});

// A KEPT TYPED READ is read against the catalog of the draft's source: the property alone where it is
// read as that type now, a cast where it named another — so it builds to the column of the type it had.
// A kept unnest naming its element's type is not split (a draft counts its steps): it builds as it did.
test('a kept typed read builds as the catalog\'s type or a cast to its own; a kept typed unnest builds as it did', () => {
  // (words_collected is a key of the payload)
  const PAYLOAD = new Set([...COLS, 'price_in_usd_of_event_data', 'result_of_event_data', 'event_data']);
  const build = (stages) => renderPipeline(catalog, catalog.dialect, 'events', stages, { physicalCols: PAYLOAD });
  const kept = [
    { stage: 'compute', name: 'price', expr: { property: 'price_in_usd_of_event_data', type: 'numeric' } },
    { stage: 'compute', name: 'result', expr: { fn: 'event_property', property: 'result_of_event_data', type: 'int' } },
  ];
  const built = build(kept);
  assert.deepEqual(kept.map((s) => built.current.get(s)), [
    { stage: 'compute', name: 'price', expr: { property: 'price_in_usd_of_event_data' } },
    { stage: 'compute', name: 'result', expr: { fn: 'cast', args: [{ property: 'result_of_event_data' }], type: 'int' } },
  ]);
  assert.deepEqual([built.columns.get('price').type, built.columns.get('result').type], ['numeric', 'int']);
  const unnest = { stage: 'unnest', expr: { property: 'words_collected' }, name: 'w', type: 'int' };
  const kept2 = build([unnest, { stage: 'aggregate', group_by: ['w'], measures: [{ name: 'n', expr: { fn: 'count' } }] }]);
  assert.equal(kept2.current.get(unnest), unnest, 'one step, as it was');
  assert.deepEqual([...kept2.columns.entries()], [['w', { type: 'int' }], ['n', { type: 'int' }]]);
});
