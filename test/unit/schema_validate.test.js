import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadCatalog } from '../../src/catalog.js';
import { buildSchemas } from '../../src/schema.js';
import { makeValidators, validateInput } from '../../src/validate.js';

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
    semantic_models: [{ from: 'events', where: [eventIs(someEvent)], measures: [{ name: 'rev', expr: { fn: 'sum', args: [{ property: numericField }] } }] }],
    metrics: [{ name: 'rev', type: 'simple', measure: 'rev' }],
  });
  assert.ok(r.ok, JSON.stringify(r.errors));
});

test('create: rejects unknown event property in dimension (enum from catalog)', () => {
  const r = v('build_semantic_model', {
    name: 'task_a',
    semantic_models: [{ from: 'events', dimensions: [{ property: 'not_a_real_prop' }] }],
    metrics: [{ name: 'm', type: 'simple', measure: 'x' }],
  });
  assert.equal(r.ok, false);
});

test('create: an unknown event in a condition on the event name is refused when it is compiled', async () => {
  const { compileDeclaration } = await import('../../src/compile.js');
  assert.throws(() => compileDeclaration(catalog, {
    name: 'task_a',
    semantic_models: [{ from: 'events', where: [eventIs('not_an_event')], measures: [COUNT] }],
    metrics: [{ name: 'm', type: 'simple', measure: 'n' }],
  }), /not_an_event/);
});

test('create: rejects percentile measure without percentile value', () => {
  const r = v('build_semantic_model', {
    name: 'task_a',
    semantic_models: [{ from: 'events', measures: [{ name: 'p', expr: { fn: 'percentile', args: [{ property: 'complete_time_of_event_data' }] } }] }],
    metrics: [{ name: 'm', type: 'simple', measure: 'p' }],
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' | '), /missing required property 'percentile'/);
});

test('create: rejects unknown model in from', () => {
  const r = v('build_semantic_model', {
    name: 'task_a',
    semantic_models: [{ from: 'nope', measures: [] }],
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

test('query: requires context_id and metrics', () => {
  assert.equal(v('query_semantic_model', { metrics: ['x'] }).ok, false);
  assert.ok(v('query_semantic_model', { context_id: 'abcd12', metrics: ['x'] }).ok);
  // a single query names its metrics as a batch item does
  assert.match(v('query_semantic_model', { context_id: 'abcd12' }).errors.join(' | '), /metrics/);
  // a field nothing reads is refused, not ignored
  assert.equal(v('query_semantic_model', { context_id: 'abcd12', metrics: ['x'], task: 'mon' }).ok, false);
  assert.equal(v('query_semantic_model', { context_id: 'abcd12', queries: [{ metrics: ['x'], task: 'mon' }] }).ok, false);
  // the same group_by item twice would be two identical columns
  assert.equal(v('query_semantic_model', { context_id: 'abcd12', metrics: ['x'], group_by: [{ time: 'metric_time', grain: 'day' }, { time: 'metric_time', grain: 'day' }] }).ok, false);
  assert.ok(v('query_semantic_model', { context_id: 'abcd12', metrics: ['x'], group_by: [{ time: 'metric_time', grain: 'day' }, { time: 'metric_time', grain: 'week' }] }).ok);
});

// A METRIC QUERY'S WHERE is the one grammar over what the query groups by: a dimension reference spelled
// as group_by names it, constants, conditions, and / or / not and the scalar functions — no column of a
// table, no aggregate, no window (rule 5 of the grammar).
test('query: a where is conditions over the references group_by takes, nested to any depth', () => {
  const country = { model: 'users', attribute: 'country' };
  const q = (where) => v('query_semantic_model', { context_id: 'abcd12', metrics: ['x'], where });
  for (const ok of [
    [{ fn: 'eq', args: [country, { value: 'US' }] }],
    [{ fn: 'or', args: [{ fn: 'in', args: [country, { value: 'US' }, { value: 'DE' }] }, { fn: 'not', args: [{ fn: 'is_null', args: [country] }] }] }],
    [{ fn: 'in', args: [{ fn: 'date_part', args: [{ time: 'metric_time', grain: 'day' }], part: 'dow' }, { value: 6 }, { value: 7 }] }],
  ]) assert.ok(q(ok).ok, `${JSON.stringify(ok)}: ${q(ok).errors?.join(' | ')}`);
  for (const bad of [
    [{ fn: 'eq', args: [{ column: 'country' }, { value: 'US' }] }],
    [{ fn: 'gt', args: [{ fn: 'count' }, { value: 1 }] }],
    [{ fn: 'eq', args: [country, { value: 'US' }], bogus: 1 }],
  ]) assert.equal(q(bad).ok, false, JSON.stringify(bad));
  // the earlier { field, op, value } and its { or } groups are refused with the condition written today
  const earlier = q([{ or: [{ field: country, op: 'eq', value: 'US' }, { field: country, op: 'eq', value: 'DE' }] }]);
  assert.equal(earlier.ok, false);
  assert.ok(earlier.errors.join(' ').includes(`is written in an earlier spelling — write ${JSON.stringify({ fn: 'or', args: [{ fn: 'eq', args: [country, { value: 'US' }] }, { fn: 'eq', args: [country, { value: 'DE' }] }] })}`), earlier.errors.join(' | '));
});

// ONE LOADER: an item of semantic_models with only `from` loads a model, in a declaration and an
// update alike; the earlier list of model names is not a field any more.
test('a model is loaded by an item { from } alone, in create and update; use_base_models is no field', () => {
  const metrics = [{ name: 'n', type: 'simple', measure: 'n' }];
  const events = { from: 'events', measures: [COUNT] };
  assert.ok(v('build_semantic_model', { name: 'task_a', semantic_models: [events, { from: 'users' }], metrics }).ok);
  assert.ok(v('build_semantic_model', { action: 'update', context_id: 'ctxabc123456', semantic_models: [{ from: 'users' }] }).ok);
  for (const input of [
    { name: 'task_a', use_base_models: ['users'], semantic_models: [events], metrics },
    { action: 'update', context_id: 'ctxabc123456', use_base_models: ['users'] },
  ]) assert.match(v('build_semantic_model', input).errors.join(' | '), /unexpected property 'use_base_models'/);
});

// …and only a model a semantic layer can load is offered: one with no primary entity (the
// experiments source) is a pipeline join's, refused on `semantic_models.from` rather than at render.
test('a model with no primary entity is not offered to semantic_models, and compiling one is refused on its from', async () => {
  const { compileDeclaration } = await import('../../src/compile.js');
  const noEntity = catalog.modelKeys().find((k) => !catalog.isFact(k) && !catalog.getModel(k).primary_entity);
  assert.ok(noEntity, 'the catalog carries a model with no primary entity');
  assert.ok(!catalog.semanticModelKeys().includes(noEntity));
  const metrics = [{ name: 'n', type: 'simple', measure: 'n' }];
  const events = { from: 'events', measures: [COUNT] };
  for (const input of [
    { name: 'task_a', semantic_models: [events, { from: noEntity }], metrics },
    { action: 'update', context_id: 'ctxabc123456', semantic_models: [{ from: noEntity }] },
  ]) assert.equal(v('build_semantic_model', input).ok, false, JSON.stringify(input));
  assert.throws(() => compileDeclaration(catalog, { name: 'task_a', semantic_models: [events, { from: noEntity }], metrics }),
    (err) => err.field === 'semantic_models.from' && /join stage/.test(err.message));
});

// A METRIC READS BY NAME: a simple metric's measure is a string; a derived metric is an expression whose
// leaves are the metrics it reads ({ metric }), numbers and the arithmetic a derived metric computes with.
test('a metric names what it reads by a string; a derived metric reads its inputs off its expression', () => {
  const sm = [{ from: 'events', measures: [COUNT, { name: 'u', expr: { fn: 'count_distinct', args: [{ column: 'player_id_of_internal' }] } }] }];
  const ok = (metrics) => v('build_semantic_model', { name: 'task_a', semantic_models: sm, metrics });
  assert.ok(ok([{ name: 'n', type: 'simple', measure: 'n' }, { name: 'u', type: 'simple', measure: 'u' }, { name: 'r', type: 'derived', expr: { fn: 'div', args: [{ metric: 'n' }, { metric: 'u' }] } }, { name: 'd', type: 'derived', expr: { fn: 'round', args: [{ fn: 'mul', args: [{ metric: 'n' }, { value: 2 }] }], places: 1 }, fill_nulls_with: 0 }]).ok);
  // a stored name is longer than a declared one: no name pattern on a reference
  assert.ok(ok([{ name: 'x', type: 'simple', measure: 'a_task_with_a_long_name_of_forty_letters_a_measure_name' }]).ok);
  for (const metrics of [
    [{ name: 'n', type: 'simple', measure: { name: 'n' } }],
    // the earlier text over a list of inputs, an input list beside the expression
    [{ name: 'd', type: 'derived', expr: 'n * 2', metrics: ['n'] }],
    [{ name: 'd', type: 'derived', expr: { fn: 'mul', args: [{ metric: 'n' }, { value: 2 }] }, metrics: ['n'] }],
    // a column is a model's, an aggregate a measure's, a constant a number
    [{ name: 'd', type: 'derived', expr: { fn: 'mul', args: [{ column: 'n' }, { value: 2 }] } }],
    [{ name: 'd', type: 'derived', expr: { fn: 'sum', args: [{ metric: 'n' }] } }],
    [{ name: 'd', type: 'derived', expr: { fn: 'add', args: [{ metric: 'n' }, { value: 'x' }] } }],
  ]) assert.equal(ok(metrics).ok, false, JSON.stringify(metrics));
});

test('a derived metric that reads no metric, an unknown one or itself is refused when it is compiled', async () => {
  const { compileDeclaration } = await import('../../src/compile.js');
  const decl = (metrics) => ({ name: 'task_a', semantic_models: [{ from: 'events', measures: [COUNT] }], metrics: [{ name: 'n', type: 'simple', measure: 'n' }, ...metrics] });
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
  const sm = [{ from: 'events', measures: [COUNT] }];
  const check = (m) => v('build_semantic_model', { name: 'task_a', semantic_models: sm, metrics: [{ name: 'c', type: 'cumulative', measure: 'n', ...m }] });
  for (const ok of [{}, { window: '7 days' }, { window: '1 month', period_agg: 'last' }, { grain_to_date: 'month' }]) assert.ok(check(ok).ok, JSON.stringify(ok));
  for (const bad of [{ window: '7 days', grain_to_date: 'month' }, { window: '12 hours' }, { window: '30 minutes' }]) assert.equal(check(bad).ok, false, JSON.stringify(bad));
});

// A DIMENSION IS WHAT THE CATALOG SAYS IT IS: a time column takes a grain, anything else none; the
// type is never asked for. A computed dimension is a row expression under a name of its own.
test('a dimension takes a grain only on a column the catalog types as time, and no as_type; a computed one is { name, expr }', () => {
  const check = (dims) => v('build_semantic_model', { name: 'task_a', semantic_models: [{ from: 'events', measures: [COUNT] }, { from: 'users', dimensions: dims }], metrics: [{ name: 'n', type: 'simple', measure: 'n' }] });
  assert.ok(check([{ column: 'install_date', grain: 'week', label: 'Install week' }, { column: 'country', label: 'Country' }, { name: 'is_us', expr: { fn: 'eq', args: [{ column: 'country' }, { value: 'US' }] }, label: 'US' }]).ok);
  for (const bad of [[{ column: 'country', grain: 'week' }], [{ column: 'install_date', as_type: 'time' }], [{ column: 'country', as_type: 'categorical' }], [{ column: 'no_such' }], [{ name: 'is_us' }]]) assert.equal(check(bad).ok, false, JSON.stringify(bad));
  // the earlier { field } is refused with the dimension written today
  assert.ok(check([{ field: 'country' }]).errors.join(' ').includes('is written in an earlier spelling — write {"column":"country"}'));
});

// ONE MEASURE: a task's measure is { name, expr }, its expr ONE aggregate of the task's (sum_boolean is a
// count with a where), and a value read as a number first is a cast inside its argument.
test('a task measure is one of the task\'s aggregates — no sum_boolean, no sketch, no window — and a cast is an argument', () => {
  const check = (expr) => v('build_semantic_model', { name: 'task_a', semantic_models: [{ from: 'events', measures: [{ name: 'm', expr }] }], metrics: [{ name: 'm', type: 'simple', measure: 'm' }] });
  const asNumber = (type) => ({ fn: 'cast', args: [{ property: 'complete_time_of_event_data' }], type });
  for (const ok of [
    { fn: 'count', where: [eventIs(catalog.eventNames('events')[0])] },
    { fn: 'sum', args: [asNumber('numeric')] },
    { fn: 'percentile', args: [asNumber('float')], percentile: 0.9 },
  ]) assert.ok(check(ok).ok, JSON.stringify(ok));
  for (const bad of [
    { fn: 'sum_boolean' },
    { fn: 'hll_init', args: [{ column: 'event_name' }] },
    { fn: 'approx_count_distinct', args: [{ column: 'event_name' }] },
    { fn: 'sum', args: [{ column: 'session_number' }], over: {} },
    { fn: 'raw', sql: 'sum(1)' },
  ]) assert.equal(check(bad).ok, false, JSON.stringify(bad));
  // the earlier { agg, field, cast } is refused with the measure written today
  const earlier = v('build_semantic_model', { name: 'task_a', semantic_models: [{ from: 'events', measures: [{ name: 'm', agg: 'count' }] }], metrics: [{ name: 'm', type: 'simple', measure: 'm' }] });
  assert.ok(earlier.errors.join(' ').includes('is written in an earlier spelling — write {"name":"m","expr":{"fn":"count","args":[]}}'), earlier.errors.join(' | '));
});

// UPDATE: a removed dimension is named the way it was declared — a column, an event property, or a
// computed dimension's name — and the task changed is a task's name.
test('update: remove.dimensions names a dimension of the model it names, as it was declared; task is a task name', () => {
  const check = (body) => v('build_semantic_model', { action: 'update', context_id: 'ctxabc123456', ...body });
  assert.ok(check({ remove: { dimensions: [{ from: 'users', column: 'country' }] } }).ok);
  assert.ok(check({ remove: { dimensions: [{ from: 'users', name: 'is_us' }] } }).ok);
  assert.ok(check({ remove: { dimensions: [{ from: 'events', property: catalog.eventNumericProps('events')[0] }] } }).ok);
  for (const bad of [{ remove: { dimensions: [{ from: 'users', column: 'zzz' }] } }, { remove: { dimensions: [{ from: 'users', column: 'event_name' }] } }, { remove: { dimensions: [{ from: 'users', field: 'country' }] } }, { task: 'Bad Name' }]) assert.equal(check(bad).ok, false, JSON.stringify(bad));
});

// PREVIEW: a window goes with validate: true; the semantic model named is one a context can hold.
test('preview_semantic_model: show or validate over a window; a window without validate is refused', () => {
  const check = (body) => v('preview_semantic_model', { context_id: 'ctxabc123456', ...body });
  for (const ok of [{}, { metric: 'm' }, { semantic_model: 'events' }, { metric: 'm', semantic_model: 'events' }, { validate: true }, { validate: false }, { validate: true, time_range: { start: '2026-01-01', end: '2026-01-02' } }]) assert.ok(check(ok).ok, JSON.stringify(ok));
  for (const bad of [{ time_range: { start: '2026-01-01' } }, { validate: false, time_range: { start: '2026-01-01' } }, { semantic_model: 'no_such_model' }]) assert.equal(check(bad).ok, false, JSON.stringify(bad));
});

test('update: a semantic model it adds to must be a known model key', () => {
  assert.equal(v('build_semantic_model', { action: 'update', context_id: 'ctx123', semantic_models: [{ from: 'ghost' }] }).ok, false);
  assert.ok(v('build_semantic_model', { action: 'update', context_id: 'ctx123', semantic_models: [{ from: 'events', measures: [{ name: 'x', expr: { fn: 'count' } }] }] }).ok);
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
    semantic_models: [{ from: 'events', measures: [{ name: 'revenue', expr: { fn: 'sum', args: [{ column: 'price_in_usd_of_event_data' }] } }] }],
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
    semantic_models: [{ from: 'events', measures: [{ name: 'purchases', expr: { fn: 'count' } }] }],
  }).ok, true);
  const noContext = check({ action: 'update' });
  assert.equal(noContext.ok, false);
  assert.match(noContext.errors.join(' | '), /context_id/);
  assert.ok(!/'name'/.test(noContext.errors.join(' | ')), 'the update mode is never asked for the create mode\'s fields');
  // …the declaration's own fields are refused there, and a model this catalog does not have is refused by the schema
  assert.equal(check({ action: 'update', context_id: 'ctxabc123456', add_measures: [] }).ok, false);
  assert.equal(check({ action: 'update', context_id: 'ctxabc123456', semantic_models: [{ from: 'no_such_model' }] }).ok, false);
});
