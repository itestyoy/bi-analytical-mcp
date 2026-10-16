import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadCatalog } from '../../src/catalog.js';
import { buildSchemas } from '../../src/schema.js';
import { makeValidators, validateInput } from '../../src/validate.js';
import { propertyTypes } from '../../src/pipeline/compute.js';

const catalog = loadCatalog(join(process.cwd(), 'config', 'catalog.yml'));
const validators = makeValidators(buildSchemas(catalog));

function v(tool, input) {
  return validateInput(validators[tool], input);
}

const COUNT = { name: 'n', expr: { fn: 'count' } };
const eventIs = (value) => ({ fn: 'eq', args: [{ column: 'event_name' }, { value }] });
/** A build whose only step is its semantic layer, over `source` (events unless said). */
const layer = (step, source = 'events') => ({ action: 'start', name: 'task_a', source, steps: [{ stage: 'semantic_model', ...step }] });
const vl = (step, source) => v('build_model', layer(step, source));
const N = [{ name: 'n', type: 'simple', measure: 'n' }];

test('semantic_model: accepts a valid step', () => {
  // Derive valid names from the catalog so this stays correct as the catalog
  // evolves (vocabulary differs across catalogs; the shape under test does not).
  const numericField = catalog.eventNumericProps('events')[0];
  const someEvent = catalog.eventNames('events')[0];
  const r = vl({ measures: [{ name: 'rev', expr: { fn: 'sum', args: [{ fn: 'case', cases: [{ when: [eventIs(someEvent)], then: { property: numericField } }] }] } }], metrics: [{ name: 'rev', type: 'simple', measure: 'rev' }] });
  assert.ok(r.ok, JSON.stringify(r.errors));
});

test('semantic_model: an unknown event property in a dimension is refused when it is compiled', async () => {
  const { compileDeclaration } = await import('../../src/compile.js');
  assert.throws(() => compileDeclaration(catalog, { name: 'task_a', semantic_models: [{ source: 'events', dimensions: [{ property: 'not_a_real_prop' }], measures: [COUNT] }], metrics: N }), /not_a_real_prop/);
});

test('semantic_model: an unknown event in a condition on the event name is refused when it is compiled', async () => {
  const { compileDeclaration } = await import('../../src/compile.js');
  assert.throws(() => compileDeclaration(catalog, {
    name: 'task_a',
    semantic_models: [{ source: 'events', where: [eventIs('not_an_event')], measures: [COUNT] }],
    metrics: [{ name: 'm', type: 'simple', measure: 'n' }],
  }), /not_an_event/);
});

test('semantic_model: a percentile measure without its percentile is refused', () => {
  const r = vl({ measures: [{ name: 'p', expr: { fn: 'percentile', args: [{ property: 'complete_time_of_event_data' }] } }], metrics: [{ name: 'm', type: 'simple', measure: 'p' }] });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' | '), /missing required property 'percentile'/);
});

test('semantic_model: a source the catalog lacks is refused', () => {
  assert.equal(vl({ measures: [COUNT], metrics: N }, 'nope').ok, false);
});

test('semantic_model: a field it does not take is refused', () => {
  assert.equal(vl({ metrics: N, bogus: 1 }).ok, false);
  // it takes no where: the rows a measure folds are its case's
  assert.equal(vl({ metrics: N, measures: [COUNT], where: [eventIs('x')] }).ok, false);
  // and it is its build's step: metrics are required
  assert.equal(vl({ measures: [COUNT] }).ok, false);
});

test('semantic_model: a ratio is no metric type of its own — it is a derived metric dividing two', () => {
  const r = vl({ metrics: [{ name: 'r', type: 'ratio', numerator: 'a', denominator: 'b' }] });
  assert.equal(r.ok, false);
  // refused in the earlier spelling it is, with the derived metric it is now — never a fuzzy 'cumulative'
  assert.match(r.errors.join(' | '), /`steps\.0\.metrics\.0` is written in an earlier spelling — write \{"name":"r","type":"derived","expr":\{"fn":"div","args":\[\{"metric":"a"\},\{"metric":"b"\}\]\}\}/);
  assert.doesNotMatch(r.errors.join(' | '), /Did you mean/);
  assert.ok(vl({ metrics: [{ name: 'r', type: 'derived', expr: { fn: 'div', args: [{ metric: 'a' }, { metric: 'b' }] } }] }).ok);
});

// A METRIC QUERY IS ITS STEPS: a context and a list of steps that holds its metrics step — { stage:
// "metrics", metrics, group_by? } — in a single query and in each of a batch's alike.
test('query: requires context_id, its metrics in a metrics step', () => {
  const metrics = (extra = {}) => ({ stage: 'metrics', metrics: ['x'], ...extra });
  assert.equal(v('query_model', { steps: [metrics()] }).ok, false);
  assert.ok(v('query_model', { context_id: 'abcd12', steps: [metrics()] }).ok);
  assert.ok(v('query_model', { context_id: 'abcd12', queries: [{ steps: [metrics()] }, { steps: [metrics(), { stage: 'limit', limit: 3 }] }] }).ok);
  // no steps: a read of the context's stored table as it is (the engine refuses one where none is stored)
  assert.ok(v('query_model', { context_id: 'abcd12' }).ok);
  for (const bad of [[], [metrics({ metrics: [] })], [metrics({ metrics: ['x', 'x'] })], [{ stage: 'metrics' }]]) assert.equal(v('query_model', { context_id: 'abcd12', steps: bad }).ok, false, JSON.stringify(bad));
  // a field nothing reads is refused, not ignored
  assert.equal(v('query_model', { context_id: 'abcd12', steps: [metrics()], task: 'mon' }).ok, false);
  assert.equal(v('query_model', { context_id: 'abcd12', steps: [metrics({ task: 'mon' })] }).ok, false);
  assert.equal(v('query_model', { context_id: 'abcd12', queries: [{ steps: [metrics()], task: 'mon' }] }).ok, false);
  // the same group_by item twice would be two identical columns
  assert.equal(v('query_model', { context_id: 'abcd12', steps: [metrics({ group_by: [{ time: 'metric_time', grain: 'day' }, { time: 'metric_time', grain: 'day' }] })] }).ok, false);
  assert.ok(v('query_model', { context_id: 'abcd12', steps: [metrics({ group_by: [{ time: 'metric_time', grain: 'day' }, { time: 'metric_time', grain: 'week' }] })] }).ok);
  // a step that makes a new table is no step of a metric query: its schema holds none
  assert.match(v('query_model', { context_id: 'abcd12', steps: [metrics(), { stage: 'join', source: 'users', on: { user: 'player_id_of_internal', time: 'device_time' }, attrs: [{ column: 'country' }] }] }).errors.join(' | '), /`steps\.1\.stage` must be one of: .*\bmetrics\b/);
});

// A METRIC QUERY'S WHERE is a where step before its metrics step: the one expression over what the query
// groups by — a ref spelled as group_by names it, constants, conditions, and / or / not and the scalar
// functions. The schema is the one definition, built for the tool's places — the where steps' and the
// steps' after the metrics step together; what the where's place leaves out of it (a column of a table,
// an aggregate, a window — the steps' after it) is refused as the query is built, naming the place
// (expression-grammar.test.js).
test('query: a where step before the metrics step is conditions over the refs group_by takes, nested to any depth', () => {
  const country = { source: 'users', column: 'country' };
  const q = (where) => v('query_model', { context_id: 'abcd12', steps: [{ stage: 'where', conditions: where }, { stage: 'metrics', metrics: ['x'] }] });
  for (const ok of [
    [{ fn: 'eq', args: [country, { value: 'US' }] }],
    [{ fn: 'or', args: [{ fn: 'in', args: [country, { value: 'US' }, { value: 'DE' }] }, { fn: 'not', args: [{ fn: 'is_null', args: [country] }] }] }],
    [{ fn: 'in', args: [{ fn: 'date_part', args: [{ time: 'metric_time', grain: 'day' }], part: 'dow' }, { value: 6 }, { value: 7 }] }],
    [{ fn: 'eq', args: [{ source: 'events', property: catalog.eventNumericProps('events')[0] }, { value: 1 }] }],
  ]) assert.ok(q(ok).ok, `${JSON.stringify(ok)}: ${q(ok).errors?.join(' | ')}`);
  for (const bad of [
    [{ fn: 'eq', args: [country, { value: 'US' }], bogus: 1 }],
    [{ fn: 'eq', args: [{ source: 'users', column: 'no_such' }, { value: 'US' }] }],
    [{ fn: 'eq', args: [{ source: 'users', property: 'country' }, { value: 'US' }] }],
  ]) assert.equal(q(bad).ok, false, JSON.stringify(bad));
  // the earlier { field, op, value } and its { or } groups are refused with the condition written today,
  // its { model, attribute } the ref it is now
  const old = { model: 'users', attribute: 'country' };
  const earlier = q([{ or: [{ field: old, op: 'eq', value: 'US' }, { field: old, op: 'eq', value: 'DE' }] }]);
  assert.equal(earlier.ok, false);
  assert.ok(earlier.errors.join(' ').includes(`is written in an earlier spelling — write ${JSON.stringify({ fn: 'or', args: [{ fn: 'eq', args: [country, { value: 'US' }] }, { fn: 'eq', args: [country, { value: 'DE' }] }] })}`), earlier.errors.join(' | '));
});

// ONE JOIN: a model whose attributes the metrics are grouped by is joined in the step on its contract —
// { source, on: { <part>: <a column of the main model> } }, every part named; the earlier list of model
// names is no field.
test('a model is joined on its contract in the step; use_base_models is no field', () => {
  const users = { source: 'users', on: { user: 'player_id_of_internal', time: 'device_time' } };
  assert.ok(vl({ measures: [COUNT], join: [users], metrics: N }).ok);
  for (const bad of [
    { measures: [COUNT], join: [{ source: 'users', on: { user: 'player_id_of_internal' } }], metrics: N },
    { measures: [COUNT], join: [{ source: 'users' }], metrics: N },
    { measures: [COUNT], join: [{ ...users, on: { ...users.on, extra: 'x' } }], metrics: N },
  ]) assert.equal(vl(bad).ok, false, JSON.stringify(bad));
  assert.match(vl({ measures: [COUNT], use_base_models: ['users'], metrics: N }).errors.join(' | '), /unexpected property 'use_base_models'/);
});

// …and only a model a semantic layer can load is offered: one with no primary entity (the experiments
// source) is a pipeline join's — not a join of the step, not a measure's source.
test('a model with no primary entity is no join and no measure source of the step, and compiling one is refused on its source', async () => {
  const { compileDeclaration } = await import('../../src/compile.js');
  const noEntity = catalog.modelKeys().find((k) => !catalog.isFact(k) && !catalog.getModel(k).primary_entity);
  assert.ok(noEntity, 'the catalog carries a model with no primary entity');
  assert.ok(!catalog.semanticModelKeys().includes(noEntity));
  assert.equal(vl({ measures: [{ ...COUNT, source: noEntity }], metrics: N }).ok, false);
  assert.equal(vl({ measures: [COUNT], join: [{ source: noEntity, on: {} }], metrics: N }).ok, false);
  assert.throws(() => compileDeclaration(catalog, { name: 'task_a', semantic_models: [{ source: 'events', measures: [COUNT] }, { source: noEntity }], metrics: N }),
    (err) => err.field === 'semantic_models.source' && /join stage/.test(err.message));
});

// A METRIC READS BY NAME: a simple metric's measure is a string; a derived metric is an expression whose
// leaves are the metrics it reads ({ metric }), numbers and the arithmetic a derived metric computes with.
test('a metric names what it reads by a string; a derived metric reads its inputs off its expression', () => {
  const measures = [COUNT, { name: 'u', expr: { fn: 'count_distinct', args: [{ column: 'player_id_of_internal' }] } }];
  const ok = (metrics) => vl({ measures, metrics });
  assert.ok(ok([{ name: 'n', type: 'simple', measure: 'n' }, { name: 'u', type: 'simple', measure: 'u' }, { name: 'r', type: 'derived', expr: { fn: 'div', args: [{ metric: 'n' }, { metric: 'u' }] } }, { name: 'd', type: 'derived', expr: { fn: 'round', args: [{ fn: 'mul', args: [{ metric: 'n' }, { value: 2 }] }], places: 1 }, fill_nulls_with: 0 }]).ok);
  // a stored name is longer than a declared one: no name pattern on a reference
  assert.ok(ok([{ name: 'x', type: 'simple', measure: 'a_task_with_a_long_name_of_forty_letters_a_measure_name' }]).ok);
  for (const metrics of [
    [{ name: 'n', type: 'simple', measure: { name: 'n' } }],
    // the earlier text over a list of inputs, an input list beside the expression
    [{ name: 'd', type: 'derived', expr: 'n * 2', metrics: ['n'] }],
    [{ name: 'd', type: 'derived', expr: { fn: 'mul', args: [{ metric: 'n' }, { value: 2 }] }, metrics: ['n'] }],
  ]) assert.equal(ok(metrics).ok, false, JSON.stringify(metrics));
});

// A derived metric's expr is an expression of its own kind (`$defs.metric_expr`): what its place
// (PLACES.derived_metric) takes — other metrics and constants in arithmetic — and nothing else, so a
// column (a model's), an aggregate (a measure's), a condition or a ref of the semantic layer is no form of
// it and the schema refuses it, saying what the place takes (and, of an aggregate, where it stands). The
// declaration's own compile refuses each too, for a caller past the schema, and holds what the schema does
// not say: a constant there is a number.
test('a derived metric reads metrics and numbers in arithmetic: anything else is refused by its kind, and at its place', async () => {
  const { compileDeclaration } = await import('../../src/compile.js');
  const decl = (expr) => ({ name: 'task_a', semantic_models: [{ source: 'events', measures: [COUNT] }], metrics: [{ name: 'n', type: 'simple', measure: 'n' }, { name: 'd', type: 'derived', expr }] });
  const step = (expr) => ({ measures: [COUNT], metrics: decl(expr).metrics });
  const place = /is not what a derived metric's expr takes — it takes \{ metric \}, \{ value \}, and add, sub, mul, div, round, floor, ceil, abs, coalesce, least, greatest/;
  const fns = /`steps\.0\.metrics\.1\.expr\.fn` must be one of: add, sub, mul, div, round, floor, ceil, abs, coalesce, least, greatest/;
  for (const [expr, said, refusal] of [
    [{ fn: 'mul', args: [{ column: 'n' }, { value: 2 }] }, /\{ column \} /, /`steps\.0\.metrics\.1\.expr\.args\.0` must be exactly one of: a constant — \{ value \} \| \{ metric \} \| fn: add/],
    [{ fn: 'mul', args: [{ source: 'users', column: 'country' }, { value: 2 }] }, /\{ source, column \} /, /`steps\.0\.metrics\.1\.expr\.args\.0`/],
    [{ fn: 'add', args: [{ metric: 'n' }, { semantic_model: ['users'], dimension: 'is_us' }] }, /\{ semantic_model, dimension \} /, /`steps\.0\.metrics\.1\.expr\.args\.1`/],
    [{ fn: 'sum', args: [{ metric: 'n' }] }, /sum /, new RegExp(`${fns.source}\\. 'sum' is not taken here: it stands in a measure's expr — ONE aggregate of the rows`)],
    [{ fn: 'gt', args: [{ metric: 'n' }, { value: 2 }] }, /gt /, fns],
  ]) {
    const r = vl(step(expr));
    assert.equal(r.ok, false, `${JSON.stringify(expr)}: no form of a derived metric's expr`);
    assert.match(r.errors.join(' | '), refusal, JSON.stringify(expr));
    assert.throws(() => compileDeclaration(catalog, decl(expr)), (e) => e.field === 'metrics.expr' && said.test(e.message) && place.test(e.message), JSON.stringify(expr));
  }
  for (const expr of [{ fn: 'div', args: [{ metric: 'n' }, { metric: 'n' }] }, { fn: 'round', args: [{ fn: 'mul', args: [{ metric: 'n' }, { value: 100 }] }], places: 1 }]) assert.ok(vl(step(expr)).ok, JSON.stringify(expr));
  assert.throws(() => compileDeclaration(catalog, decl({ fn: 'add', args: [{ metric: 'n' }, { value: 'x' }] })), (e) => e.field === 'metrics.expr' && /a derived metric computes with numbers/.test(e.message));
});

// A SEMANTIC MODEL'S EXPRESSIONS ARE OF TWO KINDS: a value of each row (`$defs.expr` — an item's where, a
// computed dimension, what a measure folds), in which no aggregate stands, and a measure (`$defs.aggregate`)
// — exactly ONE aggregate of the task's, its arguments row expressions, a case among them where it folds
// only the rows a condition holds for. The schema holds the measure: one that is no aggregate (a column, a
// formula over aggregates) or an aggregate nested in one is refused in the call, saying what the place
// takes and where the refused function stands; an aggregate in a row (a computed dimension) is refused when
// the step is compiled — a build's row expression folds rows in its aggregate stage. An earlier spelling of
// a measure is still refused with its value as it is now.
test('a semantic measure is ONE aggregate over row expressions, and a row takes none', async () => {
  const { compileDeclaration } = await import('../../src/compile.js');
  const decl = ({ measures = [COUNT], dims } = {}) => ({ measures, ...(dims ? { dimensions: dims } : {}), metrics: [{ name: 'n', type: 'simple', measure: 'n' }] });
  const m = (expr) => decl({ measures: [{ name: 'n', expr }] });
  const refused = (input, ...said) => {
    const r = vl(input);
    assert.equal(r.ok, false, JSON.stringify(input));
    for (const re of said) assert.match(r.errors.join(' | '), re, JSON.stringify(input));
  };
  const elsewhere = (fn) => new RegExp(`'${fn}' is not taken here: it stands in a measure's expr — ONE aggregate of the rows`);
  const at = '`steps\\.0\\.measures\\.0\\.expr';
  // a measure that is no aggregate: a column, a constant, a formula over aggregates — the forms it may be named
  refused(m({ column: 'session_number' }), new RegExp(`${at}\` must be exactly one of: fn: sum \\| average \\| min \\| max \\| count_distinct \\| median \\(an aggregate\\) \\| fn: count`), new RegExp(`${at}\` is missing required property 'fn'`));
  refused(m({ value: 1 }), new RegExp(`${at}\` is missing required property 'fn'`));
  // (a formula over aggregates: each aggregate a measure's, the formula a derived metric's)
  // (a formula over aggregates: each aggregate a measure's, the formula a derived metric's — refused in the
  // call, and the aggregates in it when the step is compiled)
  const ratio = { fn: 'div', args: [{ fn: 'count' }, { fn: 'count_distinct', args: [{ column: 'player_id_of_internal' }] }] };
  refused(m(ratio), new RegExp(`${at}\\.fn\` must be one of: sum, average, min, max, count_distinct, median, count, percentile\\. 'div' is not taken here`));
  assert.throws(() => compileDeclaration(catalog, { name: 'task_a', semantic_models: [{ source: 'events', measures: [{ name: 'n', expr: ratio }] }], metrics: N }), /aggregate/);
  // a measure written as a value of the row — a formula over its columns or properties, a case, a cast — is
  // what the ONE aggregate folds: said as its argument, never as a derived metric's (which reads no column)
  for (const expr of [
    { fn: 'mul', args: [{ property: catalog.eventNumericProps('events')[0] }, { value: 2 }] },
    { fn: 'add', args: [{ column: 'session_number' }, { column: 'session_number' }] },
    { fn: 'coalesce', args: [{ column: 'session_number' }, { value: 0 }] },
    { fn: 'case', cases: [{ when: [eventIs(catalog.eventNames('events')[0])], then: { value: 1 } }] },
  ]) {
    refused(m(expr), new RegExp(`${at}\\.fn\` must be one of: sum, average, min, max, count_distinct, median, count, percentile\\. '${expr.fn}' is not taken here: it stands in the argument of a measure's expr — ONE aggregate of the rows`));
    assert.doesNotMatch(vl(m(expr)).errors.join(' | '), /derived metric/, JSON.stringify(expr));
  }
  // an aggregate of an aggregate, an aggregate in a row: an item's where, a computed dimension
  assert.throws(() => compileDeclaration(catalog, { name: 'task_a', semantic_models: [{ source: 'events', measures: [{ name: 'n', expr: { fn: 'sum', args: [{ fn: 'count' }] } }] }], metrics: N }), /count/);
  assert.throws(() => compileDeclaration(catalog, { name: 'task_a', semantic_models: [{ source: 'events', measures: [COUNT], dimensions: [{ name: 'x', expr: { fn: 'max', args: [{ column: 'event_name' }] } }] }], metrics: N }), /max/);
  // the measures there are: a conditional aggregate (over a case), a count of the rows, a percentile, an
  // aggregate over a computed row value
  const first = eventIs(catalog.eventNames('events')[0]);
  for (const expr of [
    { fn: 'sum', args: [{ fn: 'case', cases: [{ when: [first], then: { column: 'session_number' } }] }] },
    { fn: 'count' },
    { fn: 'count', args: [{ fn: 'case', cases: [{ when: [first], then: { value: 1 } }] }] },
    { fn: 'percentile', args: [{ column: 'session_number' }], percentile: 0.9 },
    { fn: 'average', args: [{ fn: 'mul', args: [{ column: 'session_number' }, { value: 2 }] }] },
  ]) assert.ok(vl(m(expr)).ok, `${JSON.stringify(expr)}: ${vl(m(expr)).errors?.join(' | ')}`);
  refused(m({ fn: 'percentile', args: [{ column: 'session_number' }] }), new RegExp(`${at}\` is missing required property 'percentile'`));
  // a measure in an earlier spelling — { name, agg, column } — is refused with the measure it is now
  for (const [earlier, now] of [
    [{ name: 'n', agg: 'sum', column: 'session_number' }, { name: 'n', expr: { fn: 'sum', args: [{ column: 'session_number' }] } }],
    [{ name: 'n', agg: 'count' }, { name: 'n', expr: { fn: 'count', args: [] } }],
  ]) {
    const r = vl(decl({ measures: [earlier] }));
    assert.ok(r.errors.join(' ').includes(`\`steps.0.measures.0\` is written in an earlier spelling — write ${JSON.stringify(now)}`), r.errors.join(' | '));
    assert.ok(vl(decl({ measures: [now] })).ok, 'and what it is now is taken');
  }
});

test('a derived metric that reads no metric, an unknown one or itself is refused when it is compiled', async () => {
  const { compileDeclaration } = await import('../../src/compile.js');
  const decl = (metrics) => ({ name: 'task_a', semantic_models: [{ source: 'events', measures: [COUNT] }], metrics: [{ name: 'n', type: 'simple', measure: 'n' }, ...metrics] });
  const derived = (name, expr) => ({ name, type: 'derived', expr });
  assert.throws(() => compileDeclaration(catalog, decl([derived('a', { fn: 'add', args: [{ value: 2 }, { value: 1 }] })])), (e) => e.field === 'metrics.expr' && /reads no metric/.test(e.message));
  assert.throws(() => compileDeclaration(catalog, decl([derived('a', { fn: 'add', args: [{ metric: 'zzz' }, { value: 1 }] })])), (e) => e.field === 'metrics.expr' && /no metric named 'zzz'/.test(e.message));
  assert.throws(() => compileDeclaration(catalog, decl([derived('a', { fn: 'add', args: [{ metric: 'b' }, { value: 1 }] }), derived('b', { fn: 'add', args: [{ metric: 'a' }, { value: 1 }] })])), (e) => e.field === 'metrics.expr' && /built from each other/.test(e.message));
  // a ratio is refused with the way to write it
  assert.throws(() => compileDeclaration(catalog, decl([{ name: 'r', type: 'ratio', numerator: 'n', denominator: 'n' }])), (e) => e.field === 'metrics.type' && /a ratio is a derived metric dividing one metric by another/.test(e.message));
  // its inputs are what its leaves name
  const out = compileDeclaration(catalog, decl([derived('a', { fn: 'div', args: [{ metric: 'n' }, { fn: 'add', args: [{ metric: 'n' }, { value: 1 }] }] })]));
  assert.deepEqual(out.metrics.find((m) => m.name === 'task_a_a').type_params.metrics.map((m) => m.name), ['task_a_n']);
});

// CUMULATIVE: all history or a trailing window, or to date within a grain — two forms, as MetricFlow
// takes one of the two; a window is counted in the grains metric_time is offered at.
test('cumulative takes a window or a grain_to_date, never both; a window is in days or longer', () => {
  const check = (m) => vl({ measures: [COUNT], metrics: [{ name: 'c', type: 'cumulative', measure: 'n', ...m }] });
  for (const ok of [{}, { window: '7 days' }, { window: '1 month', period_agg: 'last' }, { grain_to_date: 'month' }]) assert.ok(check(ok).ok, JSON.stringify(ok));
  for (const bad of [{ window: '7 days', grain_to_date: 'month' }, { window: '12 hours' }, { window: '30 minutes' }]) assert.equal(check(bad).ok, false, JSON.stringify(bad));
});

// A DIMENSION IS WHAT THE CATALOG SAYS IT IS: a time column takes a grain, anything else none; the
// type is never asked for. A computed dimension is a row expression under a name of its own. The step's
// dimensions are its main model's, written in closed forms; which columns there are is the model's,
// checked when the step is compiled.
test('a dimension takes a grain only on a column the catalog types as time, and no as_type; a computed one is { name, expr }', async () => {
  const { compileDeclaration } = await import('../../src/compile.js');
  const check = (dims) => vl({ measures: [{ name: 'n', expr: { fn: 'count' } }], dimensions: dims, metrics: N }, 'users');
  assert.ok(check([{ column: 'install_date', grain: 'week', label: 'Install week' }, { column: 'country', label: 'Country' }, { name: 'is_us', expr: { fn: 'eq', args: [{ column: 'country' }, { value: 'US' }] }, label: 'US' }]).ok);
  for (const bad of [[{ column: 'install_date', as_type: 'time' }], [{ column: 'country', as_type: 'categorical' }], [{ name: 'is_us' }]]) assert.equal(check(bad).ok, false, JSON.stringify(bad));
  const compiled = (dims) => compileDeclaration(catalog, { name: 'task_a', semantic_models: [{ source: 'events', measures: [COUNT] }, { source: 'users', dimensions: dims }], metrics: N });
  for (const bad of [[{ column: 'country', grain: 'week' }], [{ column: 'no_such' }]]) assert.throws(() => compiled(bad), JSON.stringify(bad));
  // the earlier { field } is refused with the dimension written today
  assert.match(check([{ field: 'country' }]).errors.join(' | '), /`steps\.0\.dimensions\.0` is written in an earlier spelling/);
});

// ONE MEASURE: a task's measure is { name, expr }, its expr ONE aggregate of the task's (sum_boolean is a
// count over a case), and a value read as a number first is a cast inside its argument.
test('a task measure is one of the task\'s aggregates — no sum_boolean, no sketch, no window — and a cast is an argument', async () => {
  const check = (expr) => vl({ measures: [{ name: 'm', expr }], metrics: [{ name: 'm', type: 'simple', measure: 'm' }] });
  const asNumber = (type) => ({ fn: 'cast', args: [{ property: 'complete_time_of_event_data' }], type });
  const first = eventIs(catalog.eventNames('events')[0]);
  for (const ok of [
    { fn: 'count', args: [{ fn: 'case', cases: [{ when: [first], then: { value: 1 } }] }] },
    { fn: 'sum', args: [asNumber('numeric')] },
    { fn: 'percentile', args: [asNumber('float')], percentile: 0.9 },
  ]) assert.ok(check(ok).ok, JSON.stringify(ok));
  assert.equal(check({ fn: 'sum_boolean' }).ok, false, 'no such function');
  // the tool's expression holds what its places take: what a semantic model's measure leaves out — a
  // sketch, a window, raw SQL — is no form of it, so the schema refuses it; and the declaration's own
  // compile refuses it too, for a caller that skips the schema (its place, PLACES.semantic_model)
  const compiled = async (expr) => (await import('../../src/compile.js')).compileDeclaration(catalog, { name: 'task_a', semantic_models: [{ source: 'events', measures: [{ name: 'm', expr }] }], metrics: [{ name: 'm', type: 'simple', measure: 'm' }] });
  for (const [bad, said] of [
    [{ fn: 'hll_init', args: [{ column: 'event_name' }] }, /hll_init is not what a semantic model's where, dimension or measure takes/],
    [{ fn: 'approx_count_distinct', args: [{ column: 'event_name' }] }, /approx_count_distinct is not what a semantic model's where, dimension or measure takes/],
    [{ fn: 'sum', args: [{ column: 'session_number' }], over: {} }, /a measure is ONE aggregate/],
    [{ fn: 'raw', sql: 'sum(1)' }, /a measure is ONE aggregate/],
  ]) {
    assert.equal(check(bad).ok, false, JSON.stringify(bad));
    await assert.rejects(() => compiled(bad), (e) => e.field === 'measures.expr' && said.test(e.message), JSON.stringify(bad));
  }
  // the earlier { agg, field, cast } is refused with the measure written today
  const earlier = vl({ measures: [{ name: 'm', agg: 'count' }], metrics: [{ name: 'm', type: 'simple', measure: 'm' }] });
  assert.ok(earlier.errors.join(' ').includes('is written in an earlier spelling — write {"name":"m","expr":{"fn":"count","args":[]}}'), earlier.errors.join(' | '));
  // …an aggregate's where with the case it folds, a typed read with the read (cast where it named a type
  // the catalog does not read it as; without the catalog to ask, a cast)
  const said = (r, path, now) => assert.ok(r.errors.join(' ').includes(`\`${path}\` is written in an earlier spelling — write ${JSON.stringify(now)}`), r.errors.join(' | '));
  said(check({ fn: 'count', where: [first] }), 'steps.0.measures.0.expr', { fn: 'count', args: [{ fn: 'case', cases: [{ when: [first], then: { value: 1 } }] }] });
  const price = { property: 'price_in_usd_of_event_data', type: 'numeric' };
  said(check({ fn: 'sum', args: [price] }), 'steps.0.measures.0.expr.args.0', { fn: 'cast', args: [{ property: 'price_in_usd_of_event_data' }], type: 'numeric' });
  const typedBy = validateInput(validators.build_model, layer({ measures: [{ name: 'm', expr: { fn: 'sum', args: [price] } }], metrics: [{ name: 'm', type: 'simple', measure: 'm' }] }), { propertyType: propertyTypes(catalog) });
  said(typedBy, 'steps.0.measures.0.expr.args.0', { property: 'price_in_usd_of_event_data' });
});

// THE ELSE TRAP, IN A SEMANTIC MODEL TOO: a measure that folds only some rows folds a case with no else
// under count / count_distinct — an else gives every other row a value, and they count any value. Refused
// when the declaration compiles, naming the rule; every other aggregate folds the else as its value (an
// average of 1 else 0 is a share of the rows).
test('a semantic measure over a case with an else is refused under count and count_distinct only', async () => {
  const { compileDeclaration } = await import('../../src/compile.js');
  const first = eventIs(catalog.eventNames('events')[0]);
  const decl = (expr) => ({ name: 'task_a', semantic_models: [{ source: 'events', measures: [{ name: 'm', expr }] }], metrics: [{ name: 'm', type: 'simple', measure: 'm' }] });
  const over = (fn, then, other) => ({ fn, args: [{ fn: 'case', cases: [{ when: [first], then }], ...(other ? { else: other } : {}) }] });
  for (const fn of ['count', 'count_distinct']) {
    assert.throws(() => compileDeclaration(catalog, decl(over(fn, { column: 'session_number' }, { value: 0 }))), (e) => e.field === 'measures.expr' && new RegExp(`${fn} over a case with an else — an else under count, count_distinct, approx_count_distinct, hll_init always changes what is counted.*Leave the else out`).test(e.message), fn);
  }
  for (const fn of ['sum', 'average', 'max']) assert.ok(compileDeclaration(catalog, decl(over(fn, { value: 1 }, { value: 0 }))), fn);
  assert.ok(compileDeclaration(catalog, decl(over('count', { value: 1 }, { value: null }))));
  assert.ok(compileDeclaration(catalog, decl(over('count', { value: 1 }))));
});

// DESCRIBE: a window goes with validate: true; the semantic model named is one a context can hold.
test('context describe: show or validate over a window; a window without validate is refused', () => {
  const check = (body) => v('context', { action: 'describe', context_id: 'ctxabc123456', ...body });
  for (const ok of [{}, { metric: 'm' }, { semantic_model: 'events' }, { metric: 'm', semantic_model: 'events' }, { validate: true }, { validate: false }, { validate: true, time_range: { start: '2026-01-01', end: '2026-01-02' } }]) assert.ok(check(ok).ok, JSON.stringify(ok));
  for (const bad of [{ time_range: { start: '2026-01-01' } }, { validate: false, time_range: { start: '2026-01-01' } }, { semantic_model: 'No-such' }]) assert.equal(check(bad).ok, false, JSON.stringify(bad));
});
