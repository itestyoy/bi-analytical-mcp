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

test('create: accepts a valid declaration', () => {
  // Derive valid names from the catalog so this stays correct as the catalog
  // evolves (vocabulary differs across catalogs; the shape under test does not).
  const numericField = catalog.eventNumericProps('events')[0];
  const someEvent = catalog.eventNames('events')[0];
  const r = v('build_semantic_model', {
    name: 'task_a',
    semantic_models: [{ source: 'events', where: [eventIs(someEvent)], measures: [{ name: 'rev', expr: { fn: 'sum', args: [{ property: numericField }] } }] }],
    metrics: [{ name: 'rev', type: 'simple', measure: 'rev' }],
  });
  assert.ok(r.ok, JSON.stringify(r.errors));
});

test('create: rejects unknown event property in dimension (enum from catalog)', () => {
  const r = v('build_semantic_model', {
    name: 'task_a',
    semantic_models: [{ source: 'events', dimensions: [{ property: 'not_a_real_prop' }] }],
    metrics: [{ name: 'm', type: 'simple', measure: 'x' }],
  });
  assert.equal(r.ok, false);
});

test('create: an unknown event in a condition on the event name is refused when it is compiled', async () => {
  const { compileDeclaration } = await import('../../src/compile.js');
  assert.throws(() => compileDeclaration(catalog, {
    name: 'task_a',
    semantic_models: [{ source: 'events', where: [eventIs('not_an_event')], measures: [COUNT] }],
    metrics: [{ name: 'm', type: 'simple', measure: 'n' }],
  }), /not_an_event/);
});

test('create: rejects percentile measure without percentile value', () => {
  const r = v('build_semantic_model', {
    name: 'task_a',
    semantic_models: [{ source: 'events', measures: [{ name: 'p', expr: { fn: 'percentile', args: [{ property: 'complete_time_of_event_data' }] } }] }],
    metrics: [{ name: 'm', type: 'simple', measure: 'p' }],
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' | '), /missing required property 'percentile'/);
});

test('create: rejects unknown model in source', () => {
  const r = v('build_semantic_model', {
    name: 'task_a',
    semantic_models: [{ source: 'nope', measures: [] }],
    metrics: [{ name: 'm', type: 'simple', measure: 'x' }],
  });
  assert.equal(r.ok, false);
});

test('create: rejects additional properties', () => {
  const r = v('build_semantic_model', { name: 'task_a', metrics: [{ name: 'm', type: 'simple', measure: 'x' }], bogus: 1 });
  assert.equal(r.ok, false);
});

test('create: a ratio is no metric type of its own — it is a derived metric dividing two', () => {
  const r = v('build_semantic_model', {
    name: 'task_a',
    metrics: [{ name: 'r', type: 'ratio', numerator: 'a', denominator: 'b' }],
  });
  assert.equal(r.ok, false);
  // refused in the earlier spelling it is, with the derived metric it is now — never a fuzzy 'cumulative'
  assert.match(r.errors.join(' | '), /`metrics\.0` is written in an earlier spelling — write \{"name":"r","type":"derived","expr":\{"fn":"div","args":\[\{"metric":"a"\},\{"metric":"b"\}\]\}\}/);
  assert.doesNotMatch(r.errors.join(' | '), /Did you mean/);
  assert.ok(v('build_semantic_model', { name: 'task_a', metrics: [{ name: 'r', type: 'derived', expr: { fn: 'div', args: [{ metric: 'a' }, { metric: 'b' }] } }] }).ok);
});

// A METRIC QUERY IS ITS STEPS: a context and a list of steps that holds its metrics step — { stage:
// "metrics", metrics, group_by? } — in a single query and in each of a batch's alike.
test('query: requires context_id and steps, its metrics in a metrics step', () => {
  const metrics = (extra = {}) => ({ stage: 'metrics', metrics: ['x'], ...extra });
  assert.equal(v('query_semantic_model', { steps: [metrics()] }).ok, false);
  assert.ok(v('query_semantic_model', { context_id: 'abcd12', steps: [metrics()] }).ok);
  assert.ok(v('query_semantic_model', { context_id: 'abcd12', queries: [{ steps: [metrics()] }, { steps: [metrics(), { stage: 'limit', limit: 3 }] }] }).ok);
  // a single query names its steps as a batch item does
  assert.match(v('query_semantic_model', { context_id: 'abcd12' }).errors.join(' | '), /missing required property 'steps'/);
  for (const bad of [[], [metrics({ metrics: [] })], [metrics({ metrics: ['x', 'x'] })], [{ stage: 'metrics' }]]) assert.equal(v('query_semantic_model', { context_id: 'abcd12', steps: bad }).ok, false, JSON.stringify(bad));
  // a field nothing reads is refused, not ignored
  assert.equal(v('query_semantic_model', { context_id: 'abcd12', steps: [metrics()], task: 'mon' }).ok, false);
  assert.equal(v('query_semantic_model', { context_id: 'abcd12', steps: [metrics({ task: 'mon' })] }).ok, false);
  assert.equal(v('query_semantic_model', { context_id: 'abcd12', queries: [{ steps: [metrics()], task: 'mon' }] }).ok, false);
  // the same group_by item twice would be two identical columns
  assert.equal(v('query_semantic_model', { context_id: 'abcd12', steps: [metrics({ group_by: [{ time: 'metric_time', grain: 'day' }, { time: 'metric_time', grain: 'day' }] })] }).ok, false);
  assert.ok(v('query_semantic_model', { context_id: 'abcd12', steps: [metrics({ group_by: [{ time: 'metric_time', grain: 'day' }, { time: 'metric_time', grain: 'week' }] })] }).ok);
  // a step that makes a new table is no step of a metric query: its schema holds none
  assert.match(v('query_semantic_model', { context_id: 'abcd12', steps: [metrics(), { stage: 'join', with: 'users', via: 'user', attrs: [{ column: 'country' }] }] }).errors.join(' | '), /`steps\.1\.stage` must be one of: .*\bmetrics\b/);
});

// A METRIC QUERY'S WHERE is a where step before its metrics step: the one expression over what the query
// groups by — a ref spelled as group_by names it, constants, conditions, and / or / not and the scalar
// functions. The schema is the one definition, built for the tool's places — the where steps' and the
// steps' after the metrics step together; what the where's place leaves out of it (a column of a table,
// an aggregate, a window — the steps' after it) is refused as the query is built, naming the place
// (expression-grammar.test.js).
test('query: a where step before the metrics step is conditions over the refs group_by takes, nested to any depth', () => {
  const country = { source: 'users', column: 'country' };
  const q = (where) => v('query_semantic_model', { context_id: 'abcd12', steps: [{ stage: 'where', conditions: where }, { stage: 'metrics', metrics: ['x'] }] });
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

// ONE LOADER: an item of semantic_models with only `source` loads a model, in a declaration and an
// update alike; the earlier list of model names is not a field any more.
test('a model is loaded by an item { source } alone, in create and update; use_base_models is no field', () => {
  const metrics = [{ name: 'n', type: 'simple', measure: 'n' }];
  const events = { source: 'events', measures: [COUNT] };
  assert.ok(v('build_semantic_model', { name: 'task_a', semantic_models: [events, { source: 'users' }], metrics }).ok);
  assert.ok(v('build_semantic_model', { action: 'update', context_id: 'ctxabc123456', semantic_models: [{ source: 'users' }] }).ok);
  for (const input of [
    { name: 'task_a', use_base_models: ['users'], semantic_models: [events], metrics },
    { action: 'update', context_id: 'ctxabc123456', use_base_models: ['users'] },
  ]) assert.match(v('build_semantic_model', input).errors.join(' | '), /unexpected property 'use_base_models'/);
});

// …and only a model a semantic layer can load is offered: one with no primary entity (the
// experiments source) is a pipeline join's, refused on `semantic_models.source` rather than at render.
test('a model with no primary entity is not offered to semantic_models, and compiling one is refused on its source', async () => {
  const { compileDeclaration } = await import('../../src/compile.js');
  const noEntity = catalog.modelKeys().find((k) => !catalog.isFact(k) && !catalog.getModel(k).primary_entity);
  assert.ok(noEntity, 'the catalog carries a model with no primary entity');
  assert.ok(!catalog.semanticModelKeys().includes(noEntity));
  const metrics = [{ name: 'n', type: 'simple', measure: 'n' }];
  const events = { source: 'events', measures: [COUNT] };
  for (const input of [
    { name: 'task_a', semantic_models: [events, { source: noEntity }], metrics },
    { action: 'update', context_id: 'ctxabc123456', semantic_models: [{ source: noEntity }] },
  ]) assert.equal(v('build_semantic_model', input).ok, false, JSON.stringify(input));
  assert.throws(() => compileDeclaration(catalog, { name: 'task_a', semantic_models: [events, { source: noEntity }], metrics }),
    (err) => err.field === 'semantic_models.source' && /join stage/.test(err.message));
});

// A METRIC READS BY NAME: a simple metric's measure is a string; a derived metric is an expression whose
// leaves are the metrics it reads ({ metric }), numbers and the arithmetic a derived metric computes with.
test('a metric names what it reads by a string; a derived metric reads its inputs off its expression', () => {
  const sm = [{ source: 'events', measures: [COUNT, { name: 'u', expr: { fn: 'count_distinct', args: [{ column: 'player_id_of_internal' }] } }] }];
  const ok = (metrics) => v('build_semantic_model', { name: 'task_a', semantic_models: sm, metrics });
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
  const place = /is not what a derived metric's expr takes — it takes \{ metric \}, \{ value \}, and add, sub, mul, div, round, floor, ceil, abs, coalesce, least, greatest/;
  const fns = /`metrics\.1\.expr\.fn` must be one of: add, sub, mul, div, round, floor, ceil, abs, coalesce, least, greatest/;
  for (const [expr, said, refusal] of [
    [{ fn: 'mul', args: [{ column: 'n' }, { value: 2 }] }, /\{ column \} /, /`metrics\.1\.expr\.args\.0` must be exactly one of: a constant — \{ value \} \| \{ metric \} \| fn: add/],
    [{ fn: 'mul', args: [{ source: 'users', column: 'country' }, { value: 2 }] }, /\{ source, column \} /, /`metrics\.1\.expr\.args\.0`/],
    [{ fn: 'add', args: [{ metric: 'n' }, { semantic_model: ['users'], dimension: 'is_us' }] }, /\{ semantic_model, dimension \} /, /`metrics\.1\.expr\.args\.1`/],
    [{ fn: 'sum', args: [{ metric: 'n' }] }, /sum /, new RegExp(`${fns.source}\\. 'sum' is not taken here: it stands in a measure's expr — ONE aggregate of the rows`)],
    [{ fn: 'gt', args: [{ metric: 'n' }, { value: 2 }] }, /gt /, fns],
  ]) {
    const r = v('build_semantic_model', decl(expr));
    assert.equal(r.ok, false, `${JSON.stringify(expr)}: no form of a derived metric's expr`);
    assert.match(r.errors.join(' | '), refusal, JSON.stringify(expr));
    assert.throws(() => compileDeclaration(catalog, decl(expr)), (e) => e.field === 'metrics.expr' && said.test(e.message) && place.test(e.message), JSON.stringify(expr));
  }
  for (const expr of [{ fn: 'div', args: [{ metric: 'n' }, { metric: 'n' }] }, { fn: 'round', args: [{ fn: 'mul', args: [{ metric: 'n' }, { value: 100 }] }], places: 1 }]) assert.ok(v('build_semantic_model', decl(expr)).ok, JSON.stringify(expr));
  assert.throws(() => compileDeclaration(catalog, decl({ fn: 'add', args: [{ metric: 'n' }, { value: 'x' }] })), (e) => e.field === 'metrics.expr' && /a derived metric computes with numbers/.test(e.message));
});

// A SEMANTIC MODEL'S EXPRESSIONS ARE OF TWO KINDS: a value of each row (`$defs.expr` — an item's where, a
// computed dimension, what a measure folds), in which no aggregate stands, and a measure (`$defs.aggregate`)
// — exactly ONE aggregate of the task's, its arguments row expressions, a case among them where it folds
// only the rows a condition holds for. The schema holds both: a measure that is no aggregate (a column, a
// formula over aggregates), an aggregate nested in one, an aggregate in a row is refused in the call,
// saying what the place takes and where the refused function stands. An earlier spelling of a measure is
// still refused with its value as it is now.
test('a semantic measure is ONE aggregate over row expressions, and a row takes none — held by the schema', () => {
  const decl = ({ measures = [COUNT], where, dims } = {}) => ({ name: 'task_a', semantic_models: [{ source: 'events', measures, ...(where ? { where } : {}) }, ...(dims ? [{ source: 'users', dimensions: dims }] : [])], metrics: [{ name: 'n', type: 'simple', measure: 'n' }] });
  const m = (expr) => decl({ measures: [{ name: 'n', expr }] });
  const refused = (input, ...said) => {
    const r = v('build_semantic_model', input);
    assert.equal(r.ok, false, JSON.stringify(input));
    for (const re of said) assert.match(r.errors.join(' | '), re, JSON.stringify(input));
  };
  const elsewhere = (fn) => new RegExp(`'${fn}' is not taken here: it stands in a measure's expr — ONE aggregate of the rows`);
  const at = '`semantic_models\\.0\\.measures\\.0\\.expr';
  // a measure that is no aggregate: a column, a constant, a formula over aggregates — the forms it may be named
  refused(m({ column: 'session_number' }), new RegExp(`${at}\` must be exactly one of: fn: sum \\| average \\| min \\| max \\| count_distinct \\| median \\(an aggregate\\) \\| fn: count`), new RegExp(`${at}\` is missing required property 'fn'`));
  refused(m({ value: 1 }), new RegExp(`${at}\` is missing required property 'fn'`));
  // (a formula over aggregates: each aggregate a measure's, the formula a derived metric's)
  refused(m({ fn: 'div', args: [{ fn: 'count' }, { fn: 'count_distinct', args: [{ column: 'player_id_of_internal' }] }] }), new RegExp(`${at}\\.fn\` must be one of: sum, average, min, max, count_distinct, median, count, percentile\\. 'div' is not taken here: it stands in a derived metric's expr`), elsewhere('count'), elsewhere('count_distinct'));
  // a measure written as a value of the row — a formula over its columns or properties, a case, a cast — is
  // what the ONE aggregate folds: said as its argument, never as a derived metric's (which reads no column)
  for (const expr of [
    { fn: 'mul', args: [{ property: catalog.eventNumericProps('events')[0] }, { value: 2 }] },
    { fn: 'add', args: [{ column: 'session_number' }, { column: 'session_number' }] },
    { fn: 'coalesce', args: [{ column: 'session_number' }, { value: 0 }] },
    { fn: 'case', cases: [{ when: [eventIs(catalog.eventNames('events')[0])], then: { value: 1 } }] },
  ]) {
    refused(m(expr), new RegExp(`${at}\\.fn\` must be one of: sum, average, min, max, count_distinct, median, count, percentile\\. '${expr.fn}' is not taken here: it stands in the argument of a measure's expr — ONE aggregate of the rows`));
    assert.doesNotMatch(v('build_semantic_model', m(expr)).errors.join(' | '), /derived metric/, JSON.stringify(expr));
  }
  // an aggregate of an aggregate, an aggregate in a row: an item's where, a computed dimension
  refused(m({ fn: 'sum', args: [{ fn: 'count' }] }), new RegExp(`${at}\\.args\\.0\\.fn\` must be one of: `), elsewhere('count'));
  refused(decl({ where: [{ fn: 'gt', args: [{ fn: 'count' }, { value: 1 }] }] }), /`semantic_models\.0\.where\.0\.args\.0\.fn` must be one of: /, elsewhere('count'));
  refused(decl({ dims: [{ name: 'x', expr: { fn: 'max', args: [{ column: 'country' }] } }] }), /`semantic_models\.1\.dimensions\.0\.expr\.fn` must be one of: /, elsewhere('max'));
  // the measures there are: a conditional aggregate (over a case), a count of the rows, a percentile, an
  // aggregate over a computed row value
  const first = eventIs(catalog.eventNames('events')[0]);
  for (const expr of [
    { fn: 'sum', args: [{ fn: 'case', cases: [{ when: [first], then: { column: 'session_number' } }] }] },
    { fn: 'count' },
    { fn: 'count', args: [{ fn: 'case', cases: [{ when: [first], then: { value: 1 } }] }] },
    { fn: 'percentile', args: [{ column: 'session_number' }], percentile: 0.9 },
    { fn: 'average', args: [{ fn: 'mul', args: [{ column: 'session_number' }, { value: 2 }] }] },
  ]) assert.ok(v('build_semantic_model', m(expr)).ok, `${JSON.stringify(expr)}: ${v('build_semantic_model', m(expr)).errors?.join(' | ')}`);
  refused(m({ fn: 'percentile', args: [{ column: 'session_number' }] }), new RegExp(`${at}\` is missing required property 'percentile'`));
  // a measure in an earlier spelling — { name, agg, column } — is refused with the measure it is now
  for (const [earlier, now] of [
    [{ name: 'n', agg: 'sum', column: 'session_number' }, { name: 'n', expr: { fn: 'sum', args: [{ column: 'session_number' }] } }],
    [{ name: 'n', agg: 'count' }, { name: 'n', expr: { fn: 'count', args: [] } }],
  ]) {
    const r = v('build_semantic_model', decl({ measures: [earlier] }));
    assert.ok(r.errors.join(' ').includes(`\`semantic_models.0.measures.0\` is written in an earlier spelling — write ${JSON.stringify(now)}`), r.errors.join(' | '));
    assert.ok(v('build_semantic_model', decl({ measures: [now] })).ok, 'and what it is now is taken');
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
  const sm = [{ source: 'events', measures: [COUNT] }];
  const check = (m) => v('build_semantic_model', { name: 'task_a', semantic_models: sm, metrics: [{ name: 'c', type: 'cumulative', measure: 'n', ...m }] });
  for (const ok of [{}, { window: '7 days' }, { window: '1 month', period_agg: 'last' }, { grain_to_date: 'month' }]) assert.ok(check(ok).ok, JSON.stringify(ok));
  for (const bad of [{ window: '7 days', grain_to_date: 'month' }, { window: '12 hours' }, { window: '30 minutes' }]) assert.equal(check(bad).ok, false, JSON.stringify(bad));
});

// A DIMENSION IS WHAT THE CATALOG SAYS IT IS: a time column takes a grain, anything else none; the
// type is never asked for. A computed dimension is a row expression under a name of its own.
test('a dimension takes a grain only on a column the catalog types as time, and no as_type; a computed one is { name, expr }', () => {
  const check = (dims) => v('build_semantic_model', { name: 'task_a', semantic_models: [{ source: 'events', measures: [COUNT] }, { source: 'users', dimensions: dims }], metrics: [{ name: 'n', type: 'simple', measure: 'n' }] });
  assert.ok(check([{ column: 'install_date', grain: 'week', label: 'Install week' }, { column: 'country', label: 'Country' }, { name: 'is_us', expr: { fn: 'eq', args: [{ column: 'country' }, { value: 'US' }] }, label: 'US' }]).ok);
  for (const bad of [[{ column: 'country', grain: 'week' }], [{ column: 'install_date', as_type: 'time' }], [{ column: 'country', as_type: 'categorical' }], [{ column: 'no_such' }], [{ name: 'is_us' }]]) assert.equal(check(bad).ok, false, JSON.stringify(bad));
  // the earlier { field } is refused with the dimension written today
  assert.ok(check([{ field: 'country' }]).errors.join(' ').includes('is written in an earlier spelling — write {"column":"country"}'));
});

// ONE MEASURE: a task's measure is { name, expr }, its expr ONE aggregate of the task's (sum_boolean is a
// count over a case), and a value read as a number first is a cast inside its argument.
test('a task measure is one of the task\'s aggregates — no sum_boolean, no sketch, no window — and a cast is an argument', async () => {
  const check = (expr) => v('build_semantic_model', { name: 'task_a', semantic_models: [{ source: 'events', measures: [{ name: 'm', expr }] }], metrics: [{ name: 'm', type: 'simple', measure: 'm' }] });
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
  const earlier = v('build_semantic_model', { name: 'task_a', semantic_models: [{ source: 'events', measures: [{ name: 'm', agg: 'count' }] }], metrics: [{ name: 'm', type: 'simple', measure: 'm' }] });
  assert.ok(earlier.errors.join(' ').includes('is written in an earlier spelling — write {"name":"m","expr":{"fn":"count","args":[]}}'), earlier.errors.join(' | '));
  // …an aggregate's where with the case it folds, a typed read with the read (cast where it named a type
  // the catalog does not read it as; without the catalog to ask, a cast)
  const said = (r, path, now) => assert.ok(r.errors.join(' ').includes(`\`${path}\` is written in an earlier spelling — write ${JSON.stringify(now)}`), r.errors.join(' | '));
  said(check({ fn: 'count', where: [first] }), 'semantic_models.0.measures.0.expr', { fn: 'count', args: [{ fn: 'case', cases: [{ when: [first], then: { value: 1 } }] }] });
  const price = { property: 'price_in_usd_of_event_data', type: 'numeric' };
  said(check({ fn: 'sum', args: [price] }), 'semantic_models.0.measures.0.expr.args.0', { fn: 'cast', args: [{ property: 'price_in_usd_of_event_data' }], type: 'numeric' });
  const typedBy = validateInput(validators.build_semantic_model, { name: 'task_a', semantic_models: [{ source: 'events', measures: [{ name: 'm', expr: { fn: 'sum', args: [price] } }] }], metrics: [{ name: 'm', type: 'simple', measure: 'm' }] }, { propertyType: propertyTypes(catalog) });
  said(typedBy, 'semantic_models.0.measures.0.expr.args.0', { property: 'price_in_usd_of_event_data' });
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

// UPDATE: a removed dimension is named the way it was declared — a column, an event property, or a
// computed dimension's name — under the model it is `source` of, and the task changed is addressed by
// its `name` (the earlier `task` is refused with the request it is now).
test('update: remove.dimensions names a dimension of the model it names, as it was declared; name is a task name', () => {
  const check = (body) => v('build_semantic_model', { action: 'update', context_id: 'ctxabc123456', ...body });
  assert.ok(check({ remove: { dimensions: [{ source: 'users', column: 'country' }] } }).ok);
  assert.ok(check({ remove: { dimensions: [{ source: 'users', name: 'is_us' }] } }).ok);
  assert.ok(check({ remove: { dimensions: [{ source: 'events', property: catalog.eventNumericProps('events')[0] }] } }).ok);
  assert.ok(check({ name: 'task_a', semantic_models: [{ source: 'users' }] }).ok);
  for (const bad of [{ remove: { dimensions: [{ source: 'users', column: 'zzz' }] } }, { remove: { dimensions: [{ source: 'users', column: 'event_name' }] } }, { remove: { dimensions: [{ source: 'users', field: 'country' }] } }, { name: 'Bad Name' }]) assert.equal(check(bad).ok, false, JSON.stringify(bad));
  const task = check({ task: 'task_a', semantic_models: [{ source: 'users' }] });
  assert.equal(task.ok, false);
  assert.ok(task.errors.join(' ').includes(`is written in an earlier spelling — write ${JSON.stringify({ action: 'update', context_id: 'ctxabc123456', semantic_models: [{ source: 'users' }], name: 'task_a' })}`), task.errors.join(' | '));
});

// PREVIEW: a window goes with validate: true; the semantic model named is one a context can hold.
test('preview_semantic_model: show or validate over a window; a window without validate is refused', () => {
  const check = (body) => v('preview_semantic_model', { context_id: 'ctxabc123456', ...body });
  for (const ok of [{}, { metric: 'm' }, { semantic_model: 'events' }, { metric: 'm', semantic_model: 'events' }, { validate: true }, { validate: false }, { validate: true, time_range: { start: '2026-01-01', end: '2026-01-02' } }]) assert.ok(check(ok).ok, JSON.stringify(ok));
  for (const bad of [{ time_range: { start: '2026-01-01' } }, { validate: false, time_range: { start: '2026-01-01' } }, { semantic_model: 'no_such_model' }]) assert.equal(check(bad).ok, false, JSON.stringify(bad));
});

test('update: a semantic model it adds to must be a known model key', () => {
  assert.equal(v('build_semantic_model', { action: 'update', context_id: 'ctx123', semantic_models: [{ source: 'ghost' }] }).ok, false);
  assert.ok(v('build_semantic_model', { action: 'update', context_id: 'ctx123', semantic_models: [{ source: 'events', measures: [{ name: 'x', expr: { fn: 'count' } }] }] }).ok);
});

// TWO MODES, ONE TOOL. Declaring a task and editing the task already in a context used to be two
// tools with the same catalog vocabulary in both — and a listing carries every tool's schema on
// every request, so the deployment's payload properties were shipped twice over. They are one tool
// now, picked by `action`.
//
// Input-validation checks: what each mode requires, and that neither mode is asked for the other's
// fields.
test('build_semantic_model: the create mode and the update mode require their own fields', () => {
  const validators = makeValidators(buildSchemas(catalog));
  const check = (input) => validateInput(validators.build_semantic_model, input);
  const TASK = {
    name: 'rev',
    semantic_models: [{ source: 'events', measures: [{ name: 'revenue', expr: { fn: 'sum', args: [{ column: 'price_in_usd_of_event_data' }] } }] }],
    metrics: [{ name: 'revenue', type: 'simple', measure: 'revenue' }],
  };

  assert.equal(check(TASK).ok, true, JSON.stringify(check(TASK).errors));
  assert.equal(check({ ...TASK, action: 'create' }).ok, true, 'the default mode can be named explicitly');

  // create mode: the declaration is what is required — and the refusal says so
  const bare = check({ semantic_models: [] });
  assert.equal(bare.ok, false);
  assert.match(bare.errors.join(' | '), /name/);
  assert.match(bare.errors.join(' | '), /metrics/);

  // update mode: a context, and what it adds written as a declaration writes it — NOT name/metrics required
  assert.equal(check({
    action: 'update', context_id: 'ctxabc123456',
    semantic_models: [{ source: 'events', measures: [{ name: 'purchases', expr: { fn: 'count' } }] }],
  }).ok, true);
  const noContext = check({ action: 'update' });
  assert.equal(noContext.ok, false);
  assert.match(noContext.errors.join(' | '), /context_id/);
  assert.ok(!/'name'/.test(noContext.errors.join(' | ')), 'the update mode is never asked for the create mode\'s fields');
  // …the declaration's own fields are refused there, and a model this catalog does not have is refused by the schema
  assert.equal(check({ action: 'update', context_id: 'ctxabc123456', add_measures: [] }).ok, false);
  assert.equal(check({ action: 'update', context_id: 'ctxabc123456', semantic_models: [{ source: 'no_such_model' }] }).ok, false);
});
