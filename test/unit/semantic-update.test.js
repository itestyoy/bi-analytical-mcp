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
    /measure 'n' is already declared in task 'ret'/);
  // …unless the same update removes it first: a measure is replaced
  await update(e, first.context_id, {
    remove: { measures: ['u'] }, cascade: true,
    semantic_models: [{ from: 'events', measures: [{ name: 'u', agg: 'count_distinct', field: 'event_id' }] }],
  });
  assert.deepEqual(measuresOf(e.ctxs.get(first.context_id).state), ['ret_n', 'ret_u']);
  // the stored name a context describes a measure under reads it too
  const stored = await update(e, first.context_id, { metrics: [{ name: 'n_again', type: 'simple', measure: { name: 'ret_n' } }] });
  assert.ok(stored.metrics.includes('ret_n_again'));
  // a name that is not among them is still refused, listing what the task has as it was declared
  await assert.rejects(() => update(e, first.context_id, { metrics: [{ name: 'm', type: 'simple', measure: { name: 'nope' } }] }),
    /unknown measure 'nope'\. Declared in this task: ret_n, ret_u$/);
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
    /derived metric 'bad': its input 'zz' is not a metric of this task/);
  assert.deepEqual(e.ctxs.get(first.context_id).state, before, 'a refused update changes nothing');
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
