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

test('create: accepts a valid declaration', () => {
  // Derive valid names from the catalog so this stays correct as the catalog
  // evolves (vocabulary differs across catalogs; the shape under test does not).
  const numericField = catalog.eventNumericProps('events')[0];
  const someEvent = catalog.eventNames('events')[0];
  const r = v('build_semantic_model', {
    name: 'task_a',
    semantic_models: [{ from: 'events', where: [{ field: 'event_name', op: 'eq', value: someEvent }], measures: [{ name: 'rev', agg: 'sum', field: numericField }] }],
    metrics: [{ name: 'rev', type: 'simple', measure: 'rev' }],
  });
  assert.ok(r.ok, JSON.stringify(r.errors));
});

test('create: rejects unknown event property in dimension (enum from catalog)', () => {
  const r = v('build_semantic_model', {
    name: 'task_a',
    semantic_models: [{ from: 'events', dimensions: [{ field: 'not_a_real_prop' }] }],
    metrics: [{ name: 'm', type: 'simple', measure: 'x' }],
  });
  assert.equal(r.ok, false);
});

test('create: an unknown event in a condition on the event name is refused when it is compiled', async () => {
  const { compileDeclaration } = await import('../../src/compile.js');
  assert.throws(() => compileDeclaration(catalog, {
    name: 'task_a',
    semantic_models: [{ from: 'events', where: [{ field: 'event_name', op: 'eq', value: 'not_an_event' }], measures: [{ name: 'n', agg: 'count' }] }],
    metrics: [{ name: 'm', type: 'simple', measure: 'n' }],
  }), /not_an_event/);
});

test('create: rejects percentile measure without percentile value', () => {
  const r = v('build_semantic_model', {
    name: 'task_a',
    semantic_models: [{ from: 'events', measures: [{ name: 'p', agg: 'percentile', field: 'complete_time' }] }],
    metrics: [{ name: 'm', type: 'simple', measure: 'p' }],
  });
  assert.equal(r.ok, false);
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

test('create: ratio requires numerator and denominator', () => {
  const r = v('build_semantic_model', {
    name: 'task_a',
    metrics: [{ name: 'r', type: 'ratio', numerator: 'a' }],
  });
  assert.equal(r.ok, false);
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

// ONE LOADER: an item of semantic_models with only `from` loads a model, in a declaration and an
// update alike; the earlier list of model names is not a field any more.
test('a model is loaded by an item { from } alone, in create and update; use_base_models is no field', () => {
  const metrics = [{ name: 'n', type: 'simple', measure: 'n' }];
  const events = { from: 'events', measures: [{ name: 'n', agg: 'count' }] };
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
  const events = { from: 'events', measures: [{ name: 'n', agg: 'count' }] };
  for (const input of [
    { name: 'task_a', semantic_models: [events, { from: noEntity }], metrics },
    { action: 'update', context_id: 'ctxabc123456', semantic_models: [{ from: noEntity }] },
  ]) assert.equal(v('build_semantic_model', input).ok, false, JSON.stringify(input));
  assert.throws(() => compileDeclaration(catalog, { name: 'task_a', semantic_models: [events, { from: noEntity }], metrics }),
    (err) => err.field === 'semantic_models.from' && /join stage/.test(err.message));
});

// A METRIC READS BY NAME: a measure, a ratio's two sides, a derived metric's inputs are strings.
test('a metric names what it reads by a string; a derived metric lists its inputs as names, with no alias', () => {
  const sm = [{ from: 'events', measures: [{ name: 'n', agg: 'count' }, { name: 'u', agg: 'count_distinct', field: 'player_id_of_internal' }] }];
  const ok = (metrics) => v('build_semantic_model', { name: 'task_a', semantic_models: sm, metrics });
  assert.ok(ok([{ name: 'n', type: 'simple', measure: 'n' }, { name: 'r', type: 'ratio', numerator: 'n', denominator: 'u' }, { name: 'd', type: 'derived', expr: 'n * 2', metrics: ['n'] }]).ok);
  // a stored name is longer than a declared one: no name pattern on a reference
  assert.ok(ok([{ name: 'x', type: 'simple', measure: 'a_task_with_a_long_name_of_forty_letters_a_measure_name' }]).ok);
  for (const metrics of [
    [{ name: 'n', type: 'simple', measure: { name: 'n' } }],
    [{ name: 'r', type: 'ratio', numerator: { name: 'n' }, denominator: 'u' }],
    [{ name: 'd', type: 'derived', expr: 'x * 2', metrics: [{ metric: 'n', name: 'x' }] }],
    [{ name: 'd', type: 'derived', expr: 'n + n', metrics: ['n', 'n'] }],
  ]) assert.equal(ok(metrics).ok, false, JSON.stringify(metrics));
});

// CUMULATIVE: all history or a trailing window, or to date within a grain — two forms, as MetricFlow
// takes one of the two; a window is counted in the grains metric_time is offered at.
test('cumulative takes a window or a grain_to_date, never both; a window is in days or longer', () => {
  const sm = [{ from: 'events', measures: [{ name: 'n', agg: 'count' }] }];
  const check = (m) => v('build_semantic_model', { name: 'task_a', semantic_models: sm, metrics: [{ name: 'c', type: 'cumulative', measure: 'n', ...m }] });
  for (const ok of [{}, { window: '7 days' }, { window: '1 month', period_agg: 'last' }, { grain_to_date: 'month' }]) assert.ok(check(ok).ok, JSON.stringify(ok));
  for (const bad of [{ window: '7 days', grain_to_date: 'month' }, { window: '12 hours' }, { window: '30 minutes' }]) assert.equal(check(bad).ok, false, JSON.stringify(bad));
});

// A DIMENSION IS WHAT THE CATALOG SAYS IT IS: a time column takes a grain, anything else none; the
// type is never asked for.
test('a dimension takes a grain only on a column the catalog types as time, and no as_type', () => {
  const check = (dims) => v('build_semantic_model', { name: 'task_a', semantic_models: [{ from: 'events', measures: [{ name: 'n', agg: 'count' }] }, { from: 'users', dimensions: dims }], metrics: [{ name: 'n', type: 'simple', measure: 'n' }] });
  assert.ok(check([{ field: 'install_date', grain: 'week', label: 'Install week' }, { field: 'country', label: 'Country' }]).ok);
  for (const bad of [[{ field: 'country', grain: 'week' }], [{ field: 'install_date', as_type: 'time' }], [{ field: 'country', as_type: 'categorical' }]]) assert.equal(check(bad).ok, false, JSON.stringify(bad));
});

// ONE MEASURE: a task's measure takes the functions every place aggregates with — sum_boolean is a
// count with a where — and `cast` only where a number is folded.
test('a task measure takes no sum_boolean, and cast only on a function that folds a number', () => {
  const check = (m) => v('build_semantic_model', { name: 'task_a', semantic_models: [{ from: 'events', measures: [{ name: 'm', ...m }] }], metrics: [{ name: 'm', type: 'simple', measure: 'm' }] });
  for (const ok of [{ agg: 'count', where: [{ field: 'event_name', op: 'eq', value: catalog.eventNames('events')[0] }] }, { agg: 'sum', field: 'complete_time_of_event_data', cast: 'numeric' }, { agg: 'percentile', field: 'complete_time_of_event_data', percentile: 0.9, cast: 'float' }]) assert.ok(check(ok).ok, JSON.stringify(ok));
  for (const bad of [{ agg: 'sum_boolean' }, { agg: 'count', cast: 'int' }, { agg: 'count_distinct', field: 'event_name', cast: 'numeric' }, { agg: 'sum', field: 'complete_time_of_event_data', cast: 'string' }]) assert.equal(check(bad).ok, false, JSON.stringify(bad));
});

// UPDATE: a removed dimension is one of its model's fields, and the task changed is a task's name.
test('update: remove.dimensions names a field of the model it names; task is a task name', () => {
  const check = (body) => v('build_semantic_model', { action: 'update', context_id: 'ctxabc123456', ...body });
  assert.ok(check({ remove: { dimensions: [{ from: 'users', field: 'country' }] } }).ok);
  for (const bad of [{ remove: { dimensions: [{ from: 'users', field: 'zzz' }] } }, { remove: { dimensions: [{ from: 'users', field: 'event_name' }] } }, { task: 'Bad Name' }]) assert.equal(check(bad).ok, false, JSON.stringify(bad));
});

// PREVIEW: a window goes with validate: true; the semantic model named is one a context can hold.
test('preview_semantic_model: show or validate over a window; a window without validate is refused', () => {
  const check = (body) => v('preview_semantic_model', { context_id: 'ctxabc123456', ...body });
  for (const ok of [{}, { metric: 'm' }, { semantic_model: 'events' }, { metric: 'm', semantic_model: 'events' }, { validate: true }, { validate: false }, { validate: true, time_range: { start: '2026-01-01', end: '2026-01-02' } }]) assert.ok(check(ok).ok, JSON.stringify(ok));
  for (const bad of [{ time_range: { start: '2026-01-01' } }, { validate: false, time_range: { start: '2026-01-01' } }, { semantic_model: 'no_such_model' }]) assert.equal(check(bad).ok, false, JSON.stringify(bad));
});

test('update: a semantic model it adds to must be a known model key', () => {
  assert.equal(v('build_semantic_model', { action: 'update', context_id: 'ctx123', semantic_models: [{ from: 'ghost' }] }).ok, false);
  assert.ok(v('build_semantic_model', { action: 'update', context_id: 'ctx123', semantic_models: [{ from: 'events', measures: [{ name: 'x', agg: 'count' }] }] }).ok);
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
    semantic_models: [{ from: 'events', measures: [{ name: 'revenue', agg: 'sum', field: 'price_in_usd_of_event_data' }] }],
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
    semantic_models: [{ from: 'events', measures: [{ name: 'purchases', agg: 'count' }] }],
  }).ok, true);
  const noContext = check({ action: 'update' });
  assert.equal(noContext.ok, false);
  assert.match(noContext.errors.join(' | '), /context_id/);
  assert.ok(!/'name'/.test(noContext.errors.join(' | ')), 'the update mode is never asked for the create mode\'s fields');
  // …the declaration's own fields are refused there, and a model this catalog does not have is refused by the schema
  assert.equal(check({ action: 'update', context_id: 'ctxabc123456', add_measures: [] }).ok, false);
  assert.equal(check({ action: 'update', context_id: 'ctxabc123456', semantic_models: [{ from: 'no_such_model' }] }).ok, false);
});
