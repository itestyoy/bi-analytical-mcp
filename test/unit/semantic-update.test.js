// build_semantic_model({ action: 'update' }) — the incremental path on a task already in a context.
// Allowed non-data checks only: input-validation guards (a bad input is refused, a good one is
// taken) and context lifecycle (the context's state and the files it owns) — never the text of
// generated SQL or YAML.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { compileDeclaration, measureRefs } from '../../src/compile.js';
import { renderContext } from '../../src/yaml-render.js';
import { settle } from '../helpers/settle.js';

const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));
const engine = () => settle(new Engine({
  catalog: loadCatalog(CATALOG, {}),
  contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'sem-update-')) }),
}));

// a derived metric dividing one metric by another (what a ratio is), and one of any expression over them
const div = (a, b) => ({ fn: 'div', args: [{ metric: a }, { metric: b }] });
const derived = (name, expr) => ({ name, type: 'derived', expr });

// task 'ret': measures n (count) and u (distinct players), metrics n, u and r = n / u
const declare = (e) => e.build_semantic_model({
  name: 'ret',
  semantic_models: [
    { source: 'events', measures: [{ name: 'n', expr: { fn: 'count' } }, { name: 'u', expr: { fn: 'count_distinct', args: [{ column: 'player_id_of_internal' }] } }] },
    { source: 'users', dimensions: [{ column: 'country' }] },
  ],
  metrics: [
    { name: 'n', type: 'simple', measure: 'n' },
    { name: 'u', type: 'simple', measure: 'u' },
    derived('r', div('n', 'u')),
  ],
});
const update = (e, contextId, body) => e.build_semantic_model({ action: 'update', context_id: contextId, ...body });
const measuresOf = (state) => Object.values(state.additions).flatMap((a) => a.measures.map((m) => m.name)).sort();
const metricsOf = (state) => state.metrics.map((m) => m.name).sort();

// ── cascade removed the measure but kept the metrics that read it ───────────────────────────
// The context was left with a metric over a measure that no longer existed, and dbt refused it.
test('cascade takes the metrics that read a removed measure with it, and the answer no longer lists them', async () => {
  const e = engine();
  const first = await declare(e);
  await assert.rejects(() => update(e, first.context_id, { remove: { measures: ['n'] } }),
    /cannot remove measure 'ret_n'; metrics read it: ret_n, ret_r/);

  const out = await update(e, first.context_id, { remove: { measures: ['n'] }, cascade: true });
  const state = e.ctxs.get(first.context_id).state;
  assert.deepEqual(measuresOf(state), ['ret_u']);
  assert.deepEqual(metricsOf(state), ['ret_u'], 'the simple metric over n and the derived metric built on it are gone');
  assert.deepEqual(out.metrics, ['ret_u'], 'the answer lists what the context keeps');
  for (const m of state.metrics) {
    for (const x of measureRefs(m, state.metrics)) assert.ok(measuresOf(state).includes(x), `${m.name} reads ${x}, which exists`);
  }
});

// ── an update's metrics could not read the measures the task already declared ───────────────
test('an update adds a metric over the metrics and measures the task declared before, by their declared names', async () => {
  const e = engine();
  const first = await declare(e);
  const out = await update(e, first.context_id, { metrics: [derived('per_user', div('n', 'u'))] });
  assert.ok(out.metrics.includes('ret_per_user'));
  const state = e.ctxs.get(first.context_id).state;
  assert.deepEqual(measuresOf(state), ['ret_n', 'ret_u'], 'no measure is added twice');
  const perUser = state.metrics.find((m) => m.name === 'ret_per_user');
  assert.deepEqual([...measureRefs(perUser, state.metrics)].sort(), ['ret_n', 'ret_u']);

  // declaring an existing measure again would write it twice, which dbt refuses at parse
  await assert.rejects(() => update(e, first.context_id, { semantic_models: [{ source: 'events', measures: [{ name: 'n', expr: { fn: 'count' } }] }] }),
    /measure 'n' is already in this context, as 'ret_n'\. To replace it, remove it and declare it again in one update/);
  // …unless the same update removes it first: a measure is replaced
  await update(e, first.context_id, {
    remove: { measures: ['u'] }, cascade: true,
    semantic_models: [{ source: 'events', measures: [{ name: 'u', expr: { fn: 'count_distinct', args: [{ column: 'event_id' }] } }] }],
  });
  assert.deepEqual(measuresOf(e.ctxs.get(first.context_id).state), ['ret_n', 'ret_u']);
  // the stored name a context describes a measure under reads it too
  const stored = await update(e, first.context_id, { metrics: [{ name: 'n_again', type: 'simple', measure: 'ret_n' }] });
  assert.ok(stored.metrics.includes('ret_n_again'));
  // a name that is not among them is still refused, listing the context's measures as it stores them
  await assert.rejects(() => update(e, first.context_id, { metrics: [{ name: 'm', type: 'simple', measure: 'nope' }] }),
    /unknown measure 'nope'\. This call declares no measure\. Already in this context: ret_n, ret_u\.$/);
});

// ── a derived metric over a metric named as the context lists it read a metric that is not there ──
test('a derived metric in an update reads the task\'s metrics by their declared or stored names, and refuses one it does not have', async () => {
  const e = engine();
  const first = await declare(e);
  await update(e, first.context_id, { metrics: [derived('per_user', div('ret_n', 'ret_u'))] });
  await update(e, first.context_id, { metrics: [derived('per_user2', div('n', 'u'))] });
  const state = e.ctxs.get(first.context_id).state;
  const inputsOf = (name) => state.metrics.find((m) => m.name === name).type_params.metrics.map((x) => x.name);
  assert.deepEqual(inputsOf('ret_per_user'), ['ret_n', 'ret_u'], 'the stored names, as they are');
  assert.deepEqual(inputsOf('ret_per_user2'), ['ret_n', 'ret_u'], 'the declared names, namespaced');
  const before = structuredClone(state);
  await assert.rejects(() => update(e, first.context_id, { metrics: [derived('bad', { fn: 'add', args: [{ metric: 'zz' }, { value: 1 }] })] }),
    /derived metric 'bad': no metric named 'zz' or 'ret_zz' to build it from\. This call declares no metric\. Already in this context: ret_n, ret_u, ret_r, ret_per_user, ret_per_user2\.$/);
  // a declaration of its own reads only its own metrics: an input it does not declare is refused too
  assert.throws(() => compileDeclaration(e.catalog, { name: 'd', semantic_models: [{ source: 'events', measures: [{ name: 'n', expr: { fn: 'count' } }] }], metrics: [derived('x', { fn: 'add', args: [{ metric: 'nope' }, { value: 1 }] })] }),
    /derived metric 'x': no metric named 'nope' or 'd_nope' to build it from\. This call declares no metric\.$/);
  assert.deepEqual(e.ctxs.get(first.context_id).state, before, 'a refused update changes nothing');
});

// ── two derived metrics of one call built from each other were taken, and had no value to compute ──
test('derived metrics built from each other are refused, in any order and through a third', async () => {
  const e = engine();
  const first = await declare(e);
  const before = structuredClone(e.ctxs.get(first.context_id).state);
  const twice = (m) => ({ fn: 'mul', args: [{ metric: m }, { value: 2 }] });
  await assert.rejects(() => update(e, first.context_id, { metrics: [
    derived('a', { fn: 'add', args: [{ metric: 'b' }, { metric: 'n' }] }),
    derived('b', twice('a')),
  ] }), /derived metrics built from each other: ret_a → ret_b → ret_a/);
  await assert.rejects(() => update(e, first.context_id, { metrics: [
    derived('a', twice('c')),
    derived('b', twice('a')),
    derived('c', twice('b')),
  ] }), /derived metrics built from each other/);
  assert.deepEqual(e.ctxs.get(first.context_id).state, before, 'a refused update changes nothing');
  // a chain that ends in a metric of the task is taken
  const out = await update(e, first.context_id, { metrics: [
    derived('b', twice('a')),
    derived('a', div('n', 'u')),
  ] });
  assert.ok(out.metrics.includes('ret_a') && out.metrics.includes('ret_b'));
});

// ── an update that declared a metric the context had was answered ok, and the old one kept ─────
test('an update that declares a metric the context already has is refused, and replaces it when it removes it first', async () => {
  const e = engine();
  const first = await declare(e);
  const before = structuredClone(e.ctxs.get(first.context_id).state);
  await assert.rejects(() => update(e, first.context_id, { metrics: [{ name: 'n', type: 'simple', measure: 'u' }] }),
    /metric 'n' is already in this context, as 'ret_n'\. To replace it, remove it and declare it again in one update/);
  assert.deepEqual(e.ctxs.get(first.context_id).state, before, 'nothing changed');

  const out = await update(e, first.context_id, { remove: { metrics: ['n'] }, cascade: true, metrics: [{ name: 'n', type: 'simple', measure: 'u' }] });
  const state = e.ctxs.get(first.context_id).state;
  assert.deepEqual([...measureRefs(state.metrics.find((m) => m.name === 'ret_n'), state.metrics)], ['ret_u'], 'the new definition is the one kept');
  assert.deepEqual(out.metrics.slice().sort(), ['ret_n', 'ret_u'], 'the derived metric built on the old one went with it');
});

// ── a metric an earlier version stored is a metric of the context still ─────────────────────
// The context keeps COMPILED metrics, so a ratio and a derived metric written as text, stored before a
// derived metric was an expression, are read as they were: what they read, what removing one of their
// inputs takes with it, what a new derived metric builds on, and the YAML they render into.
test('a ratio and a text-derived metric an earlier version stored stay the context\'s: read, built on, removed with their inputs', async () => {
  const e = engine();
  const first = await declare(e);
  const state = e.ctxs.get(first.context_id).state;
  // the metrics as the earlier compile stored them, in place of the derived r
  state.metrics = state.metrics.filter((m) => m.name !== 'ret_r');
  state.metrics.push({ name: 'ret_r', type: 'ratio', label: 'ret_r', type_params: { numerator: { name: 'ret_n' }, denominator: { name: 'ret_u' } } });
  state.metrics.push({ name: 'ret_d', type: 'derived', label: 'ret_d', type_params: { expr: 'ret_n - ret_u', metrics: [{ name: 'ret_n' }, { name: 'ret_u' }] } });
  for (const name of ['ret_r', 'ret_d']) assert.deepEqual([...measureRefs(state.metrics.find((m) => m.name === name), state.metrics)].sort(), ['ret_n', 'ret_u'], name);
  assert.deepEqual(renderContext(e.catalog, state).metricNames.slice().sort(), ['ret_d', 'ret_n', 'ret_r', 'ret_u'], 'both render');
  // a metric they are built from is not removed from under them
  await assert.rejects(() => update(e, first.context_id, { remove: { metrics: ['n'] } }), /cannot remove metric 'ret_n'; metrics are built from it: ret_r, ret_d/);
  // a derived metric is built on a kept ratio by its declared name
  const built = await update(e, first.context_id, { metrics: [derived('pct', { fn: 'mul', args: [{ metric: 'r' }, { value: 100 }] })] });
  assert.ok(built.metrics.includes('ret_pct'));
  assert.deepEqual(e.ctxs.get(first.context_id).state.metrics.find((m) => m.name === 'ret_pct').type_params.metrics.map((x) => x.name), ['ret_r']);
  // …and removing a measure under cascade takes every metric that reads it, the kept ones included
  const out = await update(e, first.context_id, { remove: { measures: ['u'] }, cascade: true });
  assert.deepEqual(out.metrics, ['ret_n']);
});

test('in one declaration a metric takes a name no other metric of it holds', () => {
  const catalog = loadCatalog(CATALOG, {});
  const decl = (metrics) => ({ name: 'ret', semantic_models: [{ source: 'events', measures: [{ name: 'n', expr: { fn: 'count' } }, { name: 'u', expr: { fn: 'count_distinct', args: [{ column: 'player_id_of_internal' }] } }] }], metrics });
  assert.throws(() => compileDeclaration(catalog, decl([{ name: 'n', type: 'simple', measure: 'n' }, { name: 'n', type: 'simple', measure: 'u' }])), /metric 'n' is declared twice in this call/);
  assert.throws(() => compileDeclaration(catalog, decl([{ name: 'n', type: 'simple', measure: 'n' }, derived('n', div('n', 'n'))])), /metric 'n' is declared twice in this call/);
  // a derived metric reads the call's simple metrics by their declared names, filled as declared, in any order
  const filled = { name: 'n', type: 'simple', measure: 'n', fill_nulls_with: 0 };
  const users = { name: 'u', type: 'simple', measure: 'u' };
  for (const metrics of [[derived('r', div('n', 'u')), filled, users], [filled, users, derived('r', div('n', 'u'))]]) {
    const out = compileDeclaration(catalog, decl(metrics));
    assert.deepEqual(out.metrics.map((m) => m.name).sort(), ['ret_n', 'ret_r', 'ret_u']);
    assert.equal(out.metrics.find((m) => m.name === 'ret_n').type_params.measure.fill_nulls_with, 0);
    assert.deepEqual(out.metrics.find((m) => m.name === 'ret_r').type_params.metrics.map((x) => x.name), ['ret_n', 'ret_u']);
  }
});

// ── a declaration beside a task already in the context wrote its measures a second time ──────
test('a declaration into a context refuses a measure or metric the context already has, and takes another task beside it', async () => {
  const e = engine();
  const first = await declare(e);
  const before = structuredClone(e.ctxs.get(first.context_id).state);
  const into = (body) => e.build_semantic_model({ context_id: first.context_id, ...body });
  await assert.rejects(() => into({ name: 'ret', semantic_models: [{ source: 'events', measures: [{ name: 'n', expr: { fn: 'count' } }] }], metrics: [{ name: 'n2', type: 'simple', measure: 'n' }] }),
    /measure 'n' is already in this context, as 'ret_n'/);
  await assert.rejects(() => into({ name: 'ret', semantic_models: [{ source: 'events', measures: [{ name: 'k', expr: { fn: 'count' } }] }], metrics: [{ name: 'n', type: 'simple', measure: 'k' }] }),
    /metric 'n' is already in this context, as 'ret_n'/);
  await assert.rejects(() => into({ name: 'ret', dry_run: true, semantic_models: [{ source: 'events', measures: [{ name: 'n', expr: { fn: 'count' } }] }], metrics: [{ name: 'n2', type: 'simple', measure: 'n' }] }),
    /measure 'n' is already in this context/, 'a dry run is refused alike');
  assert.deepEqual(e.ctxs.get(first.context_id).state, before, 'nothing changed');

  await into({ name: 'conv', semantic_models: [{ source: 'events', measures: [{ name: 'k', expr: { fn: 'count' } }] }], metrics: [{ name: 'k', type: 'simple', measure: 'k' }] });
  const state = e.ctxs.get(first.context_id).state;
  assert.deepEqual(state.tasks, ['ret', 'conv']);
  assert.deepEqual(measuresOf(state), ['conv_k', 'ret_n', 'ret_u'], 'each measure once');

  // the refusal of an unknown measure lists the context's measures as the context's, not the task's
  await assert.rejects(() => update(e, first.context_id, { name: 'ret', metrics: [{ name: 'm', type: 'simple', measure: 'nope' }] }),
    /unknown measure 'nope'\. This call declares no measure\. Already in this context: ret_n, ret_u, conv_k\.$/);
});

test('the update form says what remove.metrics refuses and what cascade takes with a removed metric', () => {
  const e = engine();
  const updateForm = e.schemas.build_semantic_model.anyOf.find((f) => f.properties.action?.const === 'update');
  assert.match(updateForm.properties.remove.properties.metrics.description, /cascade/);
  assert.match(updateForm.properties.cascade.description, /removed measure/);
  assert.match(updateForm.properties.cascade.description, /removed metric/);
});

// ── a removed metric left the metrics built on it pointing at nothing ───────────────────────
test('a metric other metrics are built from is removed with them only under cascade', async () => {
  const e = engine();
  const first = await declare(e);
  const before = structuredClone(e.ctxs.get(first.context_id).state);
  await assert.rejects(() => update(e, first.context_id, { remove: { metrics: ['n'] } }),
    /cannot remove metric 'ret_n'; metrics are built from it: ret_r \(cascade removes them too\)/);
  assert.deepEqual(e.ctxs.get(first.context_id).state, before, 'nothing removed');
  const out = await update(e, first.context_id, { remove: { metrics: ['n'] }, cascade: true });
  assert.deepEqual(metricsOf(e.ctxs.get(first.context_id).state), ['ret_u']);
  assert.deepEqual(out.metrics, ['ret_u']);
  assert.deepEqual(measuresOf(e.ctxs.get(first.context_id).state), ['ret_n', 'ret_u'], 'the measures stay');
});

// ── an update replaced the whole state, under a build holding the old one ──────────────────
// A context may hold a pipeline draft beside its semantic task; a build in flight keeps the draft
// object and clears its marker on it when it ends.
test('an update writes the semantic part back into the same state object, leaving the rest of it', async () => {
  const e = engine();
  const first = await declare(e);
  const ctx = e.ctxs.get(first.context_id);
  const live = ctx.state;
  const draft = { name: 'kept', building: { task_id: 'x' } };
  live.draft = draft;
  await update(e, first.context_id, { remove: { metrics: ['r'] } });
  assert.equal(e.ctxs.get(first.context_id).state, live, 'the same object');
  assert.equal(live.draft, draft, 'the draft a build holds is the context\'s draft still');
  assert.deepEqual(metricsOf(live), ['ret_n', 'ret_u']);
});

// ── a refused update still changed the context ──────────────────────────────────────────────
// The partial edits stayed in memory and the next successful update wrote them.
test('a refused update leaves the context state and its files as they were', async () => {
  const e = engine();
  const first = await declare(e);
  const ctx = e.ctxs.get(first.context_id);
  const before = structuredClone(ctx.state);
  const fileBefore = readFileSync(first.files[0], 'utf8');

  // a removal on a model the task never declared: refused, and no entry is made for that model
  await assert.rejects(() => update(e, first.context_id, { remove: { dimensions: [{ source: 'crashlytics', column: 'app_version' }] } }),
    /cannot remove dimension 'app_version': 'crashlytics' carries no such dimension.*It has none/s);
  assert.deepEqual(e.ctxs.get(first.context_id).state, before);

  // a measure removal that would pass, in a call refused on its dimension
  await assert.rejects(() => update(e, first.context_id, { remove: { measures: ['u'], dimensions: [{ source: 'users', column: 'platform' }] }, cascade: true }),
    /cannot remove dimension 'platform'/);
  assert.deepEqual(e.ctxs.get(first.context_id).state, before);

  // an addition that does not compile, beside a removal
  await assert.rejects(() => update(e, first.context_id, { remove: { metrics: ['r'] }, metrics: [{ name: 'm', type: 'simple', measure: 'nope' }] }),
    /unknown measure 'nope'/);
  assert.deepEqual(e.ctxs.get(first.context_id).state, before);
  assert.equal(readFileSync(first.files[0], 'utf8'), fileBefore, 'the context file is not rewritten');

  // and the next successful update starts from the state before the refusals
  await update(e, first.context_id, { remove: { dimensions: [{ source: 'users', column: 'country' }] } });
  const after = e.ctxs.get(first.context_id).state;
  assert.deepEqual(Object.keys(after.additions).sort(), ['events', 'users']);
  assert.deepEqual(measuresOf(after), ['ret_n', 'ret_u']);
  assert.deepEqual(metricsOf(after), ['ret_n', 'ret_r', 'ret_u']);
});

test('a dry-run update changes nothing in the context', async () => {
  const e = engine();
  const first = await declare(e);
  const before = structuredClone(e.ctxs.get(first.context_id).state);
  const out = await update(e, first.context_id, { remove: { measures: ['n'] }, cascade: true, dry_run: true });
  assert.deepEqual(out.metrics, ['ret_u']);
  assert.deepEqual(e.ctxs.get(first.context_id).state, before);
});

// ── remove.measures / remove.metrics ignored a name that matched nothing ────────────────────
// They compared the stored, task-namespaced name only: the name the caller declared did nothing,
// and success was reported.
test('remove takes a measure or metric by its declared or its stored name, and refuses one that matches nothing', async () => {
  const e = engine();
  const first = await declare(e);
  await update(e, first.context_id, { remove: { metrics: ['r'] } });
  assert.deepEqual(metricsOf(e.ctxs.get(first.context_id).state), ['ret_n', 'ret_u'], 'the declared name');
  await update(e, first.context_id, { remove: { metrics: ['ret_u'] } });
  assert.deepEqual(metricsOf(e.ctxs.get(first.context_id).state), ['ret_n'], 'the stored name');

  await update(e, first.context_id, { remove: { measures: ['u'] } });
  assert.deepEqual(measuresOf(e.ctxs.get(first.context_id).state), ['ret_n'], 'no metric reads u any more');
  await update(e, first.context_id, { remove: { measures: ['ret_n'] }, cascade: true });
  assert.deepEqual(measuresOf(e.ctxs.get(first.context_id).state), []);

  const second = await declare(e); // a fresh context, nothing removed from it
  await assert.rejects(() => update(e, second.context_id, { remove: { metrics: ['zz'] } }),
    /cannot remove metric 'zz': this context has no metric named 'zz' or 'ret_zz'\. It has: ret_n, ret_u, ret_r/);
  await assert.rejects(() => update(e, second.context_id, { remove: { measures: ['zz'] } }),
    /cannot remove measure 'zz': this context has no measure named 'zz' or 'ret_zz'\. It has: ret_n, ret_u/);
  assert.deepEqual(metricsOf(e.ctxs.get(second.context_id).state), ['ret_n', 'ret_r', 'ret_u'], 'nothing was removed');
});

// ── a pattern on event_name was refused as an unknown event ─────────────────────────────────
// Every condition takes the same functions; a pattern's constant is text, not an event name.
test('a semantic model condition on event_name takes the pattern functions; an event it compares is still checked, at any depth', () => {
  const catalog = loadCatalog(CATALOG, {});
  const decl = (cond) => ({
    name: 'pat',
    semantic_models: [{ source: 'events', where: [cond], measures: [{ name: 'm', expr: { fn: 'count', args: [{ fn: 'case', cases: [{ when: [cond], then: { value: 1 } }] }] } }] }],
    metrics: [{ name: 'm', type: 'simple', measure: 'm' }],
  });
  const onEvent = (fn, ...values) => ({ fn, args: [{ column: 'event_name' }, ...values.map((value) => ({ value }))] });
  for (const [fn, value] of [['like', 'level_%'], ['not_like', 'ad_%'], ['contains', 'level'], ['starts_with', 'ad_'], ['ends_with', '_completed']]) {
    assert.doesNotThrow(() => compileDeclaration(catalog, decl(onEvent(fn, value))), fn);
  }
  for (const cond of [onEvent('eq', 'nope'), onEvent('neq', 'nope'), onEvent('in', 'level_started', 'nope'), onEvent('not_in', 'nope'), { fn: 'or', args: [onEvent('eq', 'level_started'), { fn: 'not', args: [onEvent('eq', 'nope')] }] }]) {
    assert.throws(() => compileDeclaration(catalog, decl(cond)), /unknown event 'nope' on 'events'/, JSON.stringify(cond));
  }
  assert.doesNotThrow(() => compileDeclaration(catalog, decl(onEvent('in', 'level_started', 'level_completed'))));
  // …the case a measure folds alone, with no where of its model beside it, as well
  const caseOnly = { name: 'pat', semantic_models: [{ source: 'events', measures: [{ name: 'm', expr: { fn: 'count', args: [{ fn: 'case', cases: [{ when: [onEvent('eq', 'nope')], then: { value: 1 } }] }] } }] }], metrics: [{ name: 'm', type: 'simple', measure: 'm' }] };
  assert.throws(() => compileDeclaration(catalog, caseOnly), /unknown event 'nope' on 'events'/);
});

// ── what a semantic model computes stands where its kind may stand ──────────────────────────
// A where and a computed dimension are values of each row; a measure is ONE aggregate. What cannot
// stand there is refused when it is compiled, with what to write instead (rule 4 of the grammar).
test('a semantic model refuses an aggregate in a row place, a formula as a measure, a non-condition in a where', () => {
  const catalog = loadCatalog(CATALOG, {});
  const count = { name: 'n', expr: { fn: 'count' } };
  const decl = (sm) => ({ name: 'pl', semantic_models: sm, metrics: [{ name: 'n', type: 'simple', measure: 'n' }] });
  const refused = (sm, field, re) => assert.throws(() => compileDeclaration(catalog, decl(sm)), (e) => e.field === field && re.test(e.message), JSON.stringify(sm));
  refused([{ source: 'events', measures: [count], where: [{ fn: 'gt', args: [{ fn: 'count' }, { value: 1 }] }] }], 'semantic_models.where', /count folds rows into one value, and this is a value of each row/);
  refused([{ source: 'events', measures: [count] }, { source: 'users', dimensions: [{ name: 'x', expr: { fn: 'max', args: [{ column: 'country' }] } }] }], 'dimensions.expr', /max folds rows into one value, and this is a value of each row/);
  refused([{ source: 'events', measures: [{ name: 'n', expr: { fn: 'div', args: [{ fn: 'count' }, { value: 2 }] } }] }], 'measures.expr', /a measure is ONE aggregate — .* a formula over several aggregates is several measures and a derived metric/);
  refused([{ source: 'events', measures: [{ name: 'n', expr: { column: 'session_number' } }] }], 'measures.expr', /a measure is ONE aggregate/);
  refused([{ source: 'events', measures: [{ name: 'n', expr: { fn: 'sum', args: [{ fn: 'count' }] } }] }], 'measures.expr', /count folds rows into one value/);
  refused([{ source: 'events', measures: [count], where: [{ column: 'session_number' }] }], 'semantic_models.where', /a where takes conditions/);
  refused([{ source: 'events', measures: [count], where: [{ fn: 'eq', args: [{ column: 'event_name' }, { value: null }] }] }], 'semantic_models.where', /a missing value is tested with is_null/);
  // a computed dimension is a value of the row: a condition, a case, arithmetic — under a name of its own
  assert.ok(compileDeclaration(catalog, decl([{ source: 'events', measures: [count] }, { source: 'users', dimensions: [{ name: 'is_us', expr: { fn: 'eq', args: [{ column: 'country' }, { value: 'US' }] } }] }])));
  refused([{ source: 'events', measures: [count] }, { source: 'users', dimensions: [{ name: 'country', expr: { column: 'country' } }] }], 'dimensions.name', /already has an attribute of that name/);
});

// ── an update to a task the context does not hold made a second task ────────────────────────
// A name the context has no task under is refused with the tasks it has and the declaration that
// adds one; a task it does hold is the one changed.
test('an update names a task the context holds; another name is refused with the declaration that adds one', async () => {
  const e = engine();
  const first = await declare(e);
  const before = JSON.stringify(e.ctxs.get(first.context_id).state);
  await assert.rejects(() => update(e, first.context_id, { name: 'typo', metrics: [{ name: 'k', type: 'simple', measure: 'n' }] }),
    (err) => err.field === 'name' && /holds no task 'typo'\. It holds: ret\./.test(err.message) && /build_semantic_model\(\{ request: \{ name: 'typo', context_id: /.test(err.message));
  // the task was named `task` once: refused with the update it is now, before anything is read
  await assert.rejects(() => update(e, first.context_id, { task: 'ret', metrics: [{ name: 'k', type: 'simple', measure: 'n' }] }),
    (err) => err.message.includes(`is written in an earlier spelling — write ${JSON.stringify({ action: 'update', context_id: first.context_id, metrics: [{ name: 'k', type: 'simple', measure: 'n' }], name: 'ret' })}`));
  assert.equal(JSON.stringify(e.ctxs.get(first.context_id).state), before, 'the refused updates changed nothing');

  // a second task, declared beside the first, is changed by an update that names it
  await e.build_semantic_model({ name: 'ret_v2', context_id: first.context_id, semantic_models: [{ source: 'events', measures: [{ name: 'm', expr: { fn: 'count' } }] }], metrics: [{ name: 'm', type: 'simple', measure: 'm' }] });
  await update(e, first.context_id, { name: 'ret_v2', metrics: [{ name: 'm2', type: 'simple', measure: 'm' }] });
  const state = e.ctxs.get(first.context_id).state;
  assert.deepEqual([...state.tasks].sort(), ['ret', 'ret_v2']);
  assert.ok(state.metrics.some((m) => m.name === 'ret_v2_m2'), 'the metric went to the task named');
});

// ── a where with nothing to scope was ignored ───────────────────────────────────────────────
// An item's where scopes the measures declared beside it; an item with a where and no measures is
// refused (an item with only `from` loads its model, and is taken).
test('an item with a where and no measures is refused, in a declaration and in an update', async () => {
  const e = engine();
  const where = [{ fn: 'eq', args: [{ column: 'event_name' }, { value: 'level_started' }] }];
  assert.throws(() => compileDeclaration(e.catalog, { name: 'w', semantic_models: [{ source: 'events', measures: [{ name: 'n', expr: { fn: 'count' } }] }, { source: 'events', where }], metrics: [{ name: 'n', type: 'simple', measure: 'n' }] }),
    (err) => err.field === 'semantic_models.where' && /has a where but no measures/.test(err.message));
  const first = await declare(e);
  await assert.rejects(() => update(e, first.context_id, { semantic_models: [{ source: 'events', where }] }), /has a where but no measures/);
  // the same item with a measure beside it is taken, and so is a bare { from }
  assert.doesNotThrow(() => compileDeclaration(e.catalog, { name: 'w', semantic_models: [{ source: 'events', where, measures: [{ name: 'n', expr: { fn: 'count' } }] }, { source: 'crashlytics' }], metrics: [{ name: 'n', type: 'simple', measure: 'n' }] }));
  await update(e, first.context_id, { semantic_models: [{ source: 'crashlytics' }] });
  assert.ok(e.ctxs.get(first.context_id).state.usedModels.includes('crashlytics'), 'an item with only from loads its model in an update');
});
