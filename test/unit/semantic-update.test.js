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
import { settle } from '../helpers/settle.js';

const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));
const engine = () => settle(new Engine({
  catalog: loadCatalog(CATALOG, {}),
  contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'sem-update-')) }),
}));

// task 'ret': measures n (count) and u (distinct players), metrics n, u and r = n / u
const declare = (e) => e.build_semantic_model({
  name: 'ret',
  semantic_models: [
    { from: 'events', measures: [{ name: 'n', agg: 'count' }, { name: 'u', agg: 'count_distinct', field: 'player_id_of_internal' }] },
    { from: 'users', dimensions: [{ field: 'country' }] },
  ],
  metrics: [
    { name: 'n', type: 'simple', measure: { name: 'n' } },
    { name: 'u', type: 'simple', measure: { name: 'u' } },
    { name: 'r', type: 'ratio', numerator: { name: 'n' }, denominator: { name: 'u' } },
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
  assert.deepEqual(metricsOf(state), ['ret_u'], 'the simple metric over n and the ratio that reads it are gone');
  assert.deepEqual(out.metrics, ['ret_u'], 'the answer lists what the context keeps');
  for (const m of state.metrics) {
    for (const x of measureRefs(m, state.metrics)) assert.ok(measuresOf(state).includes(x), `${m.name} reads ${x}, which exists`);
  }
});

// ── an update's metrics could not read the measures the task already declared ───────────────
test('an update adds a metric over measures the task declared before, by their declared names', async () => {
  const e = engine();
  const first = await declare(e);
  const out = await update(e, first.context_id, { metrics: [{ name: 'per_user', type: 'ratio', numerator: { name: 'n' }, denominator: { name: 'u' } }] });
  assert.ok(out.metrics.includes('ret_per_user'));
  const state = e.ctxs.get(first.context_id).state;
  assert.deepEqual(measuresOf(state), ['ret_n', 'ret_u'], 'no measure is added twice');
  const perUser = state.metrics.find((m) => m.name === 'ret_per_user');
  assert.deepEqual([...measureRefs(perUser, state.metrics)].sort(), ['ret_n', 'ret_u']);

  // declaring an existing measure again would write it twice, which dbt refuses at parse
  await assert.rejects(() => update(e, first.context_id, { semantic_models: [{ from: 'events', measures: [{ name: 'n', agg: 'count' }] }] }),
    /measure 'n' is already in this context, as 'ret_n'\. To replace it, remove it and declare it again in one update/);
  // …unless the same update removes it first: a measure is replaced
  await update(e, first.context_id, {
    remove: { measures: ['u'] }, cascade: true,
    semantic_models: [{ from: 'events', measures: [{ name: 'u', agg: 'count_distinct', field: 'event_id' }] }],
  });
  assert.deepEqual(measuresOf(e.ctxs.get(first.context_id).state), ['ret_n', 'ret_u']);
  // the stored name a context describes a measure under reads it too
  const stored = await update(e, first.context_id, { metrics: [{ name: 'n_again', type: 'simple', measure: { name: 'ret_n' } }] });
  assert.ok(stored.metrics.includes('ret_n_again'));
  // a name that is not among them is still refused, listing the context's measures as it stores them
  await assert.rejects(() => update(e, first.context_id, { metrics: [{ name: 'm', type: 'simple', measure: { name: 'nope' } }] }),
    /unknown measure 'nope'\. This call declares no measure\. Already in this context: ret_n, ret_u\.$/);
});

// ── a derived metric over a metric named as the context lists it read a metric that is not there ──
test('a derived metric in an update reads the task\'s metrics by their declared or stored names, and refuses one it does not have', async () => {
  const e = engine();
  const first = await declare(e);
  await update(e, first.context_id, { metrics: [{ name: 'per_user', type: 'derived', expr: 'ret_n / ret_u', metrics: [{ metric: 'ret_n' }, { metric: 'ret_u' }] }] });
  await update(e, first.context_id, { metrics: [{ name: 'per_user2', type: 'derived', expr: 'n / u', metrics: [{ metric: 'n' }, { metric: 'u' }] }] });
  const state = e.ctxs.get(first.context_id).state;
  const inputsOf = (name) => state.metrics.find((m) => m.name === name).type_params.metrics.map((x) => x.name);
  assert.deepEqual(inputsOf('ret_per_user'), ['ret_n', 'ret_u'], 'the stored names, as they are');
  assert.deepEqual(inputsOf('ret_per_user2'), ['ret_n', 'ret_u'], 'the declared names, namespaced');
  const before = structuredClone(state);
  await assert.rejects(() => update(e, first.context_id, { metrics: [{ name: 'bad', type: 'derived', expr: 'zz', metrics: [{ metric: 'zz' }] }] }),
    /derived metric 'bad': no metric named 'zz' or 'ret_zz' to build it from\. This call declares no metric\. Already in this context: ret_n, ret_u, ret_r, ret_per_user, ret_per_user2\.$/);
  // a declaration of its own reads only its own metrics: an input it does not declare is refused too
  assert.throws(() => compileDeclaration(e.catalog, { name: 'd', semantic_models: [{ from: 'events', measures: [{ name: 'n', agg: 'count' }] }], metrics: [{ name: 'x', type: 'derived', expr: 'nope', metrics: [{ metric: 'nope' }] }] }),
    /derived metric 'x': no metric named 'nope' or 'd_nope' to build it from\. This call declares no metric\.$/);
  assert.deepEqual(e.ctxs.get(first.context_id).state, before, 'a refused update changes nothing');
});

// ── two derived metrics of one call built from each other were taken, and had no value to compute ──
test('derived metrics built from each other are refused, in any order and through a third', async () => {
  const e = engine();
  const first = await declare(e);
  const before = structuredClone(e.ctxs.get(first.context_id).state);
  await assert.rejects(() => update(e, first.context_id, { metrics: [
    { name: 'a', type: 'derived', expr: 'b + n', metrics: [{ metric: 'b' }, { metric: 'n' }] },
    { name: 'b', type: 'derived', expr: 'a * 2', metrics: [{ metric: 'a' }] },
  ] }), /derived metrics built from each other: ret_a → ret_b → ret_a/);
  await assert.rejects(() => update(e, first.context_id, { metrics: [
    { name: 'a', type: 'derived', expr: 'c', metrics: [{ metric: 'c' }] },
    { name: 'b', type: 'derived', expr: 'a', metrics: [{ metric: 'a' }] },
    { name: 'c', type: 'derived', expr: 'b', metrics: [{ metric: 'b' }] },
  ] }), /derived metrics built from each other/);
  assert.deepEqual(e.ctxs.get(first.context_id).state, before, 'a refused update changes nothing');
  // a chain that ends in a metric of the task is taken
  const out = await update(e, first.context_id, { metrics: [
    { name: 'b', type: 'derived', expr: 'a * 2', metrics: [{ metric: 'a' }] },
    { name: 'a', type: 'derived', expr: 'n / u', metrics: [{ metric: 'n' }, { metric: 'u' }] },
  ] });
  assert.ok(out.metrics.includes('ret_a') && out.metrics.includes('ret_b'));
});

// ── an update that declared a metric the context had was answered ok, and the old one kept ─────
test('an update that declares a metric the context already has is refused, and replaces it when it removes it first', async () => {
  const e = engine();
  const first = await declare(e);
  const before = structuredClone(e.ctxs.get(first.context_id).state);
  await assert.rejects(() => update(e, first.context_id, { metrics: [{ name: 'n', type: 'simple', measure: { name: 'u' } }] }),
    /metric 'n' is already in this context, as 'ret_n'\. To replace it, remove it and declare it again in one update/);
  assert.deepEqual(e.ctxs.get(first.context_id).state, before, 'nothing changed');

  const out = await update(e, first.context_id, { remove: { metrics: ['n'] }, cascade: true, metrics: [{ name: 'n', type: 'simple', measure: { name: 'u' } }] });
  const state = e.ctxs.get(first.context_id).state;
  assert.deepEqual([...measureRefs(state.metrics.find((m) => m.name === 'ret_n'), state.metrics)], ['ret_u'], 'the new definition is the one kept');
  assert.deepEqual(out.metrics.slice().sort(), ['ret_n', 'ret_u'], 'the ratio built on the old one went with it');
});

// ── a ratio read a measure through a metric that only held the name it looks for ─────────────
test('a ratio over a measure refuses a metric of another definition under the name it reads it through, and reuses one over the same measure', async () => {
  const e = engine();
  // 'u' counts the events: a metric named as the measure u, over measure n
  const first = await e.build_semantic_model({
    name: 'ret',
    semantic_models: [{ from: 'events', measures: [{ name: 'n', agg: 'count' }, { name: 'u', agg: 'count_distinct', field: 'player_id_of_internal' }] }],
    metrics: [{ name: 'n', type: 'simple', measure: { name: 'n' } }, { name: 'u', type: 'simple', measure: { name: 'n' } }],
  });
  const before = structuredClone(e.ctxs.get(first.context_id).state);
  const perUser = { name: 'per_user', type: 'ratio', numerator: { name: 'n' }, denominator: { name: 'u' } };
  await assert.rejects(() => update(e, first.context_id, { metrics: [perUser] }),
    /ratio 'per_user' reads measure 'u' through a simple metric named 'ret_u', and 'ret_u' is already a simple metric over measure 'ret_n' in this context/);
  assert.deepEqual(e.ctxs.get(first.context_id).state, before, 'nothing changed');

  // a simple metric over u declared before it is the one the ratio reads; ret_n, over n, is reused as it is
  await update(e, first.context_id, { metrics: [{ name: 'users', type: 'simple', measure: { name: 'u' } }, perUser] });
  const state = e.ctxs.get(first.context_id).state;
  const ratio = state.metrics.find((m) => m.name === 'ret_per_user');
  assert.deepEqual([ratio.type_params.numerator.name, ratio.type_params.denominator.name], ['ret_n', 'ret_users']);
  assert.deepEqual(metricsOf(state), ['ret_n', 'ret_per_user', 'ret_u', 'ret_users'], 'no metric made or kept twice');
});

test('in one declaration a metric takes a name no other metric of it holds, a ratio\'s own included', () => {
  const catalog = loadCatalog(CATALOG, {});
  const decl = (metrics) => ({ name: 'ret', semantic_models: [{ from: 'events', measures: [{ name: 'n', agg: 'count' }, { name: 'u', agg: 'count_distinct', field: 'player_id_of_internal' }] }], metrics });
  const ratio = { name: 'r', type: 'ratio', numerator: { name: 'n' }, denominator: { name: 'u' } };
  const overU = { name: 'n', type: 'simple', measure: { name: 'u' } };
  assert.throws(() => compileDeclaration(catalog, decl([ratio, overU])), /metric 'n' is stored as 'ret_n', the name of the simple metric over measure 'ret_n' that a ratio of this call reads it through/);
  assert.throws(() => compileDeclaration(catalog, decl([overU, ratio])), /ratio 'r' reads measure 'n' through a simple metric named 'ret_n', and 'ret_n' is already a simple metric over measure 'ret_u' of this call/);
  assert.throws(() => compileDeclaration(catalog, decl([{ name: 'n', type: 'simple', measure: { name: 'n' } }, { name: 'n', type: 'simple', measure: { name: 'u' } }])), /metric 'n' is declared twice in this call/);
  // the same reading under that name is the caller's, wherever it is written: the ratio reads it, filled as declared
  const filled = { name: 'n', type: 'simple', measure: { name: 'n' }, fill_nulls_with: 0 };
  for (const metrics of [[ratio, filled], [filled, ratio]]) {
    const out = compileDeclaration(catalog, decl(metrics));
    assert.deepEqual(out.metrics.map((m) => m.name).sort(), ['ret_n', 'ret_r', 'ret_u']);
    assert.equal(out.metrics.find((m) => m.name === 'ret_n').type_params.measure.fill_nulls_with, 0);
  }
});

// ── a declaration beside a task already in the context wrote its measures a second time ──────
test('a declaration into a context refuses a measure or metric the context already has, and takes another task beside it', async () => {
  const e = engine();
  const first = await declare(e);
  const before = structuredClone(e.ctxs.get(first.context_id).state);
  const into = (body) => e.build_semantic_model({ context_id: first.context_id, ...body });
  await assert.rejects(() => into({ name: 'ret', semantic_models: [{ from: 'events', measures: [{ name: 'n', agg: 'count' }] }], metrics: [{ name: 'n2', type: 'simple', measure: { name: 'n' } }] }),
    /measure 'n' is already in this context, as 'ret_n'/);
  await assert.rejects(() => into({ name: 'ret', semantic_models: [{ from: 'events', measures: [{ name: 'k', agg: 'count' }] }], metrics: [{ name: 'n', type: 'simple', measure: { name: 'k' } }] }),
    /metric 'n' is already in this context, as 'ret_n'/);
  await assert.rejects(() => into({ name: 'ret', dry_run: true, semantic_models: [{ from: 'events', measures: [{ name: 'n', agg: 'count' }] }], metrics: [{ name: 'n2', type: 'simple', measure: { name: 'n' } }] }),
    /measure 'n' is already in this context/, 'a dry run is refused alike');
  assert.deepEqual(e.ctxs.get(first.context_id).state, before, 'nothing changed');

  await into({ name: 'conv', semantic_models: [{ from: 'events', measures: [{ name: 'k', agg: 'count' }] }], metrics: [{ name: 'k', type: 'simple', measure: { name: 'k' } }] });
  const state = e.ctxs.get(first.context_id).state;
  assert.deepEqual(state.tasks, ['ret', 'conv']);
  assert.deepEqual(measuresOf(state), ['conv_k', 'ret_n', 'ret_u'], 'each measure once');

  // the refusal of an unknown measure lists the context's measures as the context's, not the task's
  await assert.rejects(() => update(e, first.context_id, { task: 'ret', metrics: [{ name: 'm', type: 'simple', measure: { name: 'nope' } }] }),
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
  await assert.rejects(() => update(e, first.context_id, { remove: { dimensions: [{ from: 'crashlytics', field: 'x' }] } }),
    /cannot remove dimension 'x': 'crashlytics' carries no such dimension.*It has none/s);
  assert.deepEqual(e.ctxs.get(first.context_id).state, before);

  // a measure removal that would pass, in a call refused on its dimension
  await assert.rejects(() => update(e, first.context_id, { remove: { measures: ['u'], dimensions: [{ from: 'users', field: 'nope' }] }, cascade: true }),
    /cannot remove dimension 'nope'/);
  assert.deepEqual(e.ctxs.get(first.context_id).state, before);

  // an addition that does not compile, beside a removal
  await assert.rejects(() => update(e, first.context_id, { remove: { metrics: ['r'] }, metrics: [{ name: 'm', type: 'simple', measure: { name: 'nope' } }] }),
    /unknown measure 'nope'/);
  assert.deepEqual(e.ctxs.get(first.context_id).state, before);
  assert.equal(readFileSync(first.files[0], 'utf8'), fileBefore, 'the context file is not rewritten');

  // and the next successful update starts from the state before the refusals
  await update(e, first.context_id, { remove: { dimensions: [{ from: 'users', field: 'country' }] } });
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
// Every condition takes the same operators; a pattern's constant is text, not an event name.
test('a semantic model condition on event_name takes the pattern operators; an event it compares is still checked', () => {
  const catalog = loadCatalog(CATALOG, {});
  const decl = (cond) => ({
    name: 'pat',
    semantic_models: [{ from: 'events', where: [cond], measures: [{ name: 'm', agg: 'count', where: [cond] }] }],
    metrics: [{ name: 'm', type: 'simple', measure: { name: 'm' } }],
  });
  for (const [op, value] of [['like', 'level_%'], ['not_like', 'ad_%'], ['contains', 'level'], ['starts_with', 'ad_'], ['ends_with', '_completed']]) {
    assert.doesNotThrow(() => compileDeclaration(catalog, decl({ field: 'event_name', op, value })), op);
  }
  for (const [op, value] of [['eq', 'nope'], ['neq', 'nope'], ['in', ['level_started', 'nope']], ['not_in', ['nope']]]) {
    assert.throws(() => compileDeclaration(catalog, decl({ field: 'event_name', op, value })), /unknown event 'nope' on 'events'/, op);
  }
  assert.doesNotThrow(() => compileDeclaration(catalog, decl({ field: 'event_name', op: 'in', value: ['level_started', 'level_completed'] })));
});
