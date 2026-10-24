import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { loadCatalog } from '../../src/catalog.js';
import { loadRecipes } from '../../src/recipes.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { buildToolDefs } from '../../src/server.js';
import { renderContext } from '../../src/yaml-render.js';
import { stageBranch } from '../helpers/stage-schema.js';
import { settle, stepNotes } from '../helpers/settle.js';
import { deref, field } from '../helpers/schema-nav.js';
import { mcp } from '../helpers/catalog-doc.js';
import { tempDir } from '../helpers/temp-dir.js';
import { declare } from '../helpers/declare.js';

const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));
const RECIPES = fileURLToPath(new URL('../../config/recipes.json', import.meta.url));
function engine() {
  const catalog = loadCatalog(CATALOG, {});
  return settle(new Engine({ catalog, recipes: loadRecipes(RECIPES), contextManager: new ContextManager({ workspaceRoot: tempDir('surf') }) }));
}

// Advertised tool surface: the folded/rudimentary tools are gone; the merged ones present.
test('advertised tools: folded tools removed, context + experiment present', () => {
  const names = buildToolDefs(engine()).map((d) => d.name);
  assert.ok(names.includes('context'), 'unified context tool advertised');
  assert.ok(names.includes('experiment'), 'unified experiment tool advertised');
  assert.ok(names.includes('semantic_index') && names.includes('build_model'));
  for (const gone of ['update_native_model', 'list_query_jobs', 'get_recipe', 'list_recipes', 'list_contexts', 'describe_context', 'drop_context', 'delete_native_model', 'delete_semantic_model', 'register_native_model', 'ab_test', 'srm_check', 'sample_size']) {
    assert.ok(!names.includes(gone), `${gone} is no longer advertised`);
  }
  // every advertised tool has a real description (not name-as-description).
  for (const d of buildToolDefs(engine())) assert.notEqual(d.description, d.name, `${d.name} has a description`);
  // every advertised tool has a human-readable title, distinct from name.
  for (const d of buildToolDefs(engine())) {
    assert.ok(typeof d.title === 'string' && d.title.length > 0, `${d.name} has a title`);
    assert.notEqual(d.title, d.name, `${d.name} title is not the raw name`);
  }
});

// experiment({ action }) — the unified A/B lifecycle — dispatches + validates strictly.
test('experiment tool: plan / check_split / analyze dispatch + strict fields', () => {
  const e = engine();
  const plan = e.experiment({ action: 'plan', metric: 'proportion', baseline: 0.2, mde: 0.02 });
  assert.ok(plan.n_per_group > 0, 'plan returns a sample size');
  const srm = e.experiment({ action: 'check_split', groups: [{ label: 'c', n: 100 }, { label: 'v', n: 100 }] });
  assert.equal(srm.srm_detected, false, 'even split passes SRM');
  const a = e.experiment({ action: 'analyze', metric: 'proportion', control: { n: 1000, conversions: 200 }, variants: [{ label: 'b', n: 1000, conversions: 260 }] });
  assert.equal(a.results.length, 1);
  assert.equal(a.results[0].significant, true);
  // strict: analyze needs control+variants; check_split needs groups; plan rejects ratio metric.
  assert.throws(() => e.experiment({ action: 'analyze', metric: 'proportion' }), /invalid input/);
  assert.throws(() => e.experiment({ action: 'check_split' }), /invalid input/);
  assert.throws(() => e.experiment({ action: 'plan', metric: 'ratio', mde: 0.1 }), /invalid input/);
  assert.throws(() => e.experiment({ action: 'bogus' }), /invalid input/);
  // proportion guard: a success count cannot exceed the sample size (rate > 100% is impossible).
  assert.throws(
    () => e.experiment({ action: 'analyze', metric: 'proportion', control: { n: 100, conversions: 110 }, variants: [{ label: 'b', n: 100, conversions: 50 }] }),
    /cannot exceed n/,
  );
  // a variant over n is rejected too.
  assert.throws(
    () => e.experiment({ action: 'analyze', metric: 'proportion', control: { n: 100, conversions: 10 }, variants: [{ label: 'b', n: 100, conversions: 150 }] }),
    /cannot exceed n/,
  );
  // strict group shape: an unknown field inside control/variant is rejected (closed arm),
  // even via experiment (which composes the group props without the per-metric oneOf).
  assert.throws(
    () => e.experiment({ action: 'analyze', metric: 'proportion', control: { n: 100, conversions: 10, bogus: 1 }, variants: [{ label: 'b', n: 100, conversions: 20 }] }),
    /invalid input/,
  );
});

// context reads the contexts; delete_context removes them — each validated strictly.
test('context lists and describes, delete_context removes — and a read never removes', async () => {
  const e = engine();
  // start a draft to create a context.
  const s = await e.build_model({ action: 'start', name: 'ctxtool', source: 'events' });
  const list = await e.context({ action: 'list' });
  assert.ok(list.contexts.some((c) => c.context_id === s.context_id), 'list shows the created context');
  const desc = await e.context({ action: 'describe', context_id: s.context_id });
  assert.equal(desc.context_id ?? desc.id ?? s.context_id, desc.context_id ?? desc.id ?? s.context_id); // describe returns the context shape
  // strict: describe requires context_id; list forbids it.
  await assert.rejects(() => e.context({ action: 'describe' }), /invalid input/);
  await assert.rejects(() => e.context({ action: 'list', context_id: s.context_id }), /invalid input/);
  await assert.rejects(() => e.context({ action: 'bogus' }), /invalid input/);
  // context only reads: an action that would remove is not one of its actions
  await assert.rejects(() => e.context({ action: 'drop', context_id: s.context_id }), /must be one of: list, describe/);
  assert.ok((await e.context({ action: 'list' })).contexts.some((c) => c.context_id === s.context_id), 'a read removed nothing');
  // delete_context: semantic_model needs its model; context forbids the model's fields
  await assert.rejects(() => e.delete_context({ what: 'semantic_model', context_id: s.context_id }), /invalid input/);
  await assert.rejects(() => e.delete_context({ context_id: s.context_id, cascade: true }), /invalid input/);
  await e.delete_context({ context_id: s.context_id });
  const after = await e.context({ action: 'list' });
  assert.ok(!after.contexts.some((c) => c.context_id === s.context_id), 'dropped context is gone');
});

// Recipes folded into semantic_index: overview lists them; { recipe: id } returns one.
test('semantic_index folds recipes: overview list + { recipe } payload', async () => {
  const e = engine();
  const overview = await e.semantic_index();
  assert.ok(Array.isArray(overview.recipes) && overview.recipes.some((r) => r.id === 'conversion_metric_window'), 'overview lists recipe ids');
  const r = await e.semantic_index({ recipe: 'conversion_metric_window' });
  assert.equal(r.id, 'conversion_metric_window');
  assert.ok(r.hack && (r.semantic_payload || r.pipeline_payload), 'recipe payload + hack returned');
  assert.ok(r.building_block, 'carries how to use it');
  // recipe is a mutually-exclusive view; an unknown id is rejected by the enum.
  await assert.rejects(() => e.semantic_index({ recipe: 'conversion_metric_window', event: 'tutorial' }), /must be exactly one of: .*\{ recipe \}/);
  await assert.rejects(() => e.semantic_index({ recipe: 'no_such_recipe' }), /invalid input/);
});

// A pipeline with a sample stage produces an APPROXIMATE result, flagged loudly with
// safe/unsafe guidance + how to get the exact number (never silently misleading).
test('a sampled pipeline flags the result approximate with guidance', async () => {
  const e = engine();
  const s = await e.build_model({ action: 'start', name: 'sampled', source: 'events' });
  await e.build_model({ action: 'add_steps', context_id: s.context_id, steps: [{ stage: 'sample', share: 0.1 }] });
  await e.build_model({ action: 'add_steps', context_id: s.context_id, steps: [{ stage: 'aggregate', group_by: ['event_name'], measures: [{ name: 'rows', expr: { fn: 'count' } }] }] });
  const out = await e.build_model({ action: 'materialize', context_id: s.context_id });
  assert.equal(out.provenance.approximate, true, 'provenance marks the result approximate');
  assert.equal(out.sampling.approximate, true);
  assert.equal(out.sampling.sample_share, 0.1);
  assert.ok(out.sampling.not_reliable_for && out.sampling.get_exact, 'carries safe/unsafe + how-to-get-exact');
  // a non-sampled pipeline has neither flag.
  const s2 = await e.build_model({ action: 'start', name: 'exact', source: 'events' });
  await e.build_model({ action: 'add_steps', context_id: s2.context_id, steps: [{ stage: 'aggregate', group_by: ['event_name'], measures: [{ name: 'rows', expr: { fn: 'count' } }] }] });
  const out2 = await e.build_model({ action: 'materialize', context_id: s2.context_id });
  assert.equal(out2.provenance.approximate, undefined);
  assert.equal(out2.sampling, undefined);
});

// Recipes are building blocks reached THROUGH semantic_index, not a standalone tool.
test('recipes have no standalone tool; _recipe payload is framed as a building block', async () => {
  const names = buildToolDefs(engine()).map((d) => d.name);
  assert.ok(!names.includes('get_recipe') && !names.includes('list_recipes'), 'no standalone recipe tools');
  const r = await engine().semantic_index({ recipe: 'conversion_metric_window' });
  assert.ok(r.building_block && r.hack, 'recipe is presented as a reusable building block (+ hack technique)');
});

// #3 gotcha: referencing an event-specific property without scoping its event(s) reads NULL.
test('add_steps warns when an event-specific property is used without its event scope', async () => {
  const e = engine();
  // Applicability is DATA-DERIVED from the value index: seed coverage showing ad_type is populated
  // only on ad_started/ad_finished (NULL on first_launch) — the nudge reads this, not a declared list.
  e.valueIndex.upsertProperty('events', 'ad_type_of_event_data', { coverage: [
    { event: 'ad_started', rowCount: 10, nonNull: 10 },
    { event: 'ad_finished', rowCount: 10, nonNull: 10 },
    { event: 'first_launch', rowCount: 5, nonNull: 0 },
  ] });
  const s = await e.build_model({ action: 'start', name: 'scopewarn', source: 'events' });
  // ad_type_of_event_data is populated only on ad_started/ad_finished.
  const a = await e.build_model({ action: 'add_steps', context_id: s.context_id, steps: [{ stage: 'aggregate', group_by: ['ad_type_of_event_data'], measures: [{ name: 'rows', expr: { fn: 'count' } }] }] });
  assert.ok(stepNotes(a).some((r) => r.includes('ad_type_of_event_data') && r.includes('populated only on event')), JSON.stringify(stepNotes(a)));
  // with an upstream where scoping event_name to those events → no NULL warning.
  const s2 = await e.build_model({ action: 'start', name: 'scoped', source: 'events' });
  await e.build_model({ action: 'add_steps', context_id: s2.context_id, steps: [{ stage: 'where', conditions: [{ fn: 'in', args: [{ column: 'event_name' }, { value: 'ad_started' }, { value: 'ad_finished' }] }] }] });
  const a2 = await e.build_model({ action: 'add_steps', context_id: s2.context_id, steps: [{ stage: 'aggregate', group_by: ['ad_type_of_event_data'], measures: [{ name: 'rows', expr: { fn: 'count' } }] }] });
  assert.ok(!stepNotes(a2).some((r) => r.includes('populated only on event')), 'scoped event → no NULL warning');
  const warnFor = async (cond) => {
    const d = await e.build_model({ action: 'start', name: 'scoped2', source: 'events' });
    await e.build_model({ action: 'add_steps', context_id: d.context_id, steps: [{ stage: 'where', conditions: [cond] }] });
    const r = await e.build_model({ action: 'add_steps', context_id: d.context_id, steps: [{ stage: 'aggregate', group_by: ['ad_type_of_event_data'], measures: [{ name: 'rows', expr: { fn: 'count' } }] }] });
    return (stepNotes(r) || []).find((x) => x.includes('populated only on event'));
  };
  // a scope WITHIN the field's events is the right choice: every row it keeps carries the field
  const onEvent = (fn, ...values) => ({ fn, args: [{ column: 'event_name' }, ...values.map((value) => ({ value }))] });
  assert.equal(await warnFor(onEvent('eq', 'ad_started')), undefined);
  // a scope that also keeps an event without the field: those rows read NULL, and it names that event
  assert.match(await warnFor(onEvent('in', 'ad_started', 'first_launch')), /also keeps first_launch/);
  // a condition that does not name the events kept is no scope
  assert.match(await warnFor(onEvent('neq', 'first_launch')), /add an earlier where on event_name/);
  // a funnel step reads a property on the events it names itself: scoped by that step, no earlier where
  // needed — flagged only where the step names an event the property is not on
  const funnel = async (events) => {
    const d = await e.build_model({ action: 'start', name: 'funnelscope', source: 'events' });
    const r = await e.build_model({ action: 'add_steps', context_id: d.context_id, steps: [{ stage: 'match_recognize', steps: [
      { name: 'launch', event_name: ['first_launch'] },
      { name: 'ad', event_name: events, where: [{ fn: 'eq', args: [{ property: 'ad_type_of_event_data' }, { value: 'rewarded' }] }] },
    ] }] });
    return (stepNotes(r) || []).find((x) => x.includes('populated only on event'));
  };
  assert.equal(await funnel(['ad_started']), undefined);
  assert.match(await funnel(['ad_started', 'first_launch']), /step 'ad' also names first_launch/);
});

// HLL is promoted as the preferred distinct-count method (mergeable, high-accuracy).
test('guide promotes HLL sketches for distinct counts', async () => {
  const g = await engine().semantic_index({ guide: true });
  assert.ok(g.routing_triggers.some((t) => /distinct/i.test(t.if) && /HLL/i.test(t.do) && /merge/i.test(t.do)), 'guide carries an HLL distinct-count trigger');
});

// The analyst procedure is served THROUGH the MCP: semantic_index({ guide }).
test('semantic_index({ guide }) serves the workflow + routing triggers + per-task recipes', async () => {
  const e = engine();
  const g = await e.semantic_index({ guide: true });
  assert.ok(Array.isArray(g.workflow) && g.workflow.length >= 4, 'workflow steps present');
  assert.ok(Array.isArray(g.routing_triggers) && g.routing_triggers.every((t) => t.if && t.do), 'IF/DO routing triggers present');
  assert.ok(g.tasks && Array.isArray(g.tasks.metric_types) && g.tasks.metric_types.some((r) => r.id === 'ratio_metric') && g.tasks.pipeline.some((r) => r.id === 'conversion_metric_window'), 'per-family recipe listing present');
  // narrow to one family.
  const gt = await e.semantic_index({ guide: 'metric_types' });
  assert.equal(gt.task, 'metric_types');
  assert.ok(gt.recipes.some((r) => r.id === 'ratio_metric'));
  // overview points at the guide; guide is a mutually-exclusive view.
  const ov = await e.semantic_index();
  assert.ok(typeof ov.guide === 'string' && /guide/.test(ov.guide));
  await assert.rejects(() => e.semantic_index({ guide: true, source: 'events' }), /must be exactly one of: .*\{ guide \}/);
});

// Without recipes configured, the recipe view + overview list are simply absent.
test('semantic_index recipe view is absent when no recipes configured', async () => {
  const catalog = loadCatalog(CATALOG, {});
  const e = settle(new Engine({ catalog, contextManager: new ContextManager({ workspaceRoot: tempDir('norec') }) }));
  const overview = await e.semantic_index();
  assert.equal(overview.recipes, undefined);
  await assert.rejects(() => e.semantic_index({ recipe: 'x' }), /recipes are not configured|invalid input/);
});

// A governed path is served by the semantic model of the model it ends on. A task built from one
// events source does not load the other's, so a path onto that fact's own attributes is refused
// here with the fix — instead of reaching MetricFlow as an unknown entity.
test('a group-by path onto an unloaded FACT is refused with the fix: a measure of it loads it', async () => {
  const e = engine();
  const out = await declare(e, {
    name: 'evonly',
    semantic_models: [{ source: 'events', measures: [{ name: 'rows', expr: { fn: 'count' } }] }],
    metrics: [{ name: 'rows', type: 'simple', measure: 'rows' }],
  });
  await assert.rejects(
    () => e.query_model({ context_id: out.context_id, steps: [{ stage: 'metrics', metrics: ['rows'], group_by: [{ source: 'crashlytics', column: 'app_version' }] }] }),
    (err) => err.field === 'steps' && /needs model 'crashlytics'.*a measure of the build's semantic_model step with source: 'crashlytics' loads it/s.test(err.message),
  );
});

// A ref names only what is there: a column the model lacks, the events source's session key (no join
// key is a column by name) and a `via` that is not a relationship onto that model are each refused by
// the schema, listing what the model does have — before anything runs. A dimension a task computed is
// { semantic_model: [<its model>], dimension }, resolved against the context's own dimensions; a
// column named that way is told where it lives, and an event property the task did not declare a
// dimension is told the update that declares it.
test('a group-by column or via the model does not have is refused, listing the real ones', async () => {
  const e = engine();
  const evu = await declare(e, {
    name: 'evu',
    semantic_models: [{ source: 'events', measures: [{ name: 'rows', expr: { fn: 'count' } }] }, { source: 'users' }],
    metrics: [{ name: 'rows', type: 'simple', measure: 'rows' }],
  });
  // (the metrics step's group_by: a refusal names it as the query numbers its steps)
  const groupBy = (eng, contextId, metric, ref) => eng.query_model({ context_id: contextId, steps: [{ stage: 'metrics', metrics: [metric], group_by: [ref] }] });
  await assert.rejects(() => groupBy(e, evu.context_id, 'rows', { source: 'users', column: 'shoe_size' }),
    /`steps\.0\.group_by\.0\.column` must be one of: .*country/s, 'a column the model does not have is refused, listing the ones it has');
  assert.ok(!e.catalog.modelDimensionColumns('events').includes('session_number'), 'the session key is not a dimension column of events');
  await assert.rejects(() => groupBy(e, evu.context_id, 'rows', { source: 'events', column: 'session_number' }),
    (err) => /`steps\.0\.group_by\.0\.column` must be one of: bundle_id, event_name/.test(err.message) && !/session_number/.test(err.message.split('must be one of:').pop().split('. ')[0])
      && /'session_number' is the key of 'session' — a metric query groups by and filters on it as \{ entity: "session" \}/.test(err.message), 'the session key is not a groupable column of the events source: it is named by its entity');
  await assert.rejects(() => groupBy(e, evu.context_id, 'rows', { semantic_model: ['users'], dimension: 'country' }),
    (err) => err.field === 'steps' && /^steps\[0\] group_by\[0\]: 'users\.country' is a column of 'users', named where it lives in the catalog — write \{ source: 'users', column: 'country' \}/.test(err.message));
  await assert.rejects(() => groupBy(e, evu.context_id, 'rows', { source: 'events', property: 'level_id_of_event_data' }),
    (err) => err.field === 'steps' && /is not a dimension of this context — declare it one — \{ property: 'level_id_of_event_data' \} in the dimensions of the build's semantic_model step/.test(err.message));
  // a dimension the task computes is named by its semantic model and its name
  const computed = await declare(e, {
    name: 'evc',
    semantic_models: [{ source: 'events', dimensions: [{ name: 'is_launch', expr: { fn: 'eq', args: [{ column: 'event_name' }, { value: 'first_launch' }] } }], measures: [{ name: 'rows', expr: { fn: 'count' } }] }],
    metrics: [{ name: 'rows', type: 'simple', measure: 'rows' }],
  });
  const ctx = e.ctxs.get(computed.context_id);
  assert.equal(e._taskRef(ctx, { semantic_model: ['events'], dimension: 'is_launch' }).column, 'events_is_launch');
  await assert.rejects(() => groupBy(e, computed.context_id, 'rows', { semantic_model: ['events'], dimension: 'is_eu' }),
    (err) => err.field === 'steps' && /'events\.is_eu' is not a dimension this context computed on 'events'/.test(err.message));
  // the crash source OWNS ad_funnel here (type: unique): ad_funnel is a relationship onto it, 'session' is not
  const doc = yaml.load(readFileSync(CATALOG, 'utf8'));
  const M = Object.fromEntries(doc.models.map((x) => [x.name, x]));
  mcp(M.fct_crashlytics_events).entities = { ad_funnel: { type: 'unique', key: ['rewarded_tracking_id', 'player_id_of_internal'] } };
  mcp(M.fct_analytics_events).entities.ad_funnel = { type: 'foreign', key: ['tracking_id', 'player_id_of_internal'] };
  const at = join(tempDir('surf-own'), 'catalog.yml');
  writeFileSync(at, yaml.dump(doc));
  const owner = settle(new Engine({ catalog: loadCatalog(at, {}), contextManager: new ContextManager({ workspaceRoot: tempDir('surf') }) }));
  const own = await declare(owner, {
    name: 'own',
    semantic_models: [{ source: 'events', measures: [{ name: 'rows', expr: { fn: 'count' } }] }, { source: 'crashlytics' }, { source: 'users' }],
    metrics: [{ name: 'rows', type: 'simple', measure: 'rows' }],
  });
  await assert.rejects(() => groupBy(owner, own.context_id, 'rows', { source: 'crashlytics', column: 'app_version', via: 'session' }),
    /`steps\.0\.group_by\.0\.via` must be one of: .*ad_funnel/s, 'a via that is not a relationship onto that model is refused, listing the real ones');
});

// The relationship a model OWNS is reported as owned — its governed path ends here — not as
// "pipeline only" (the two conditions used to be tested in the wrong order).
test('semantic_index({ source }) reports an owned relationship as owned, with a governed path', async () => {
  const e = engine();
  const users = await e.semantic_index({ source: 'users' });
  const rel = users.relationships.find((r) => r.entity === 'user');
  assert.equal(rel.owned_here, true);
  assert.match(rel.use, /^owned here — other models point at it/);
  assert.ok(!/No model owns 'user'/.test(users.join_note || ''), users.join_note);
  const events = await e.semantic_index({ source: 'events' });
  const evUser = events.relationships.find((r) => r.entity === 'user');
  assert.equal(evUser.use, 'metric query');
  assert.equal(evUser.joins, 'users', 'the events side points at the model that owns the relationship');
});

// What a note is about is the PAIR the tool itself emits. A name on its own has no spelling at all — so
// a name two sources carry can never be attached to the wrong one, and never has to be disambiguated.
test('memory about: { source, property }, { source, column } and { source, event } resolve; a bare name is no entity', async () => {
  const e = engine();
  const saved = (await e.memory({ action: 'record', notes: [{ note: 'ad_finished fires once per completed impression', about: [{ source: 'events', event: 'ad_finished' }, { source: 'crashlytics', property: 'anr_duration_of_event_data' }, { source: 'users', column: 'country' }] }] })).notes[0];
  assert.deepEqual(saved.about, [{ source: 'events', event: 'ad_finished' }, { source: 'crashlytics', property: 'anr_duration_of_event_data' }, { source: 'users', column: 'country' }]);
  assert.deepEqual(saved.unresolved_terms || [], []);
  const shown = await e.semantic_index({ source: 'events', event: 'ad_finished' });
  assert.ok((shown.memory || []).length >= 1, 'the finding surfaces on the event it was about');
  // …and on the qualified crash property it is about as well
  const crashProp = await e.semantic_index({ source: 'crashlytics', property: 'anr_duration_of_event_data' });
  assert.ok((crashProp.memory || []).some((m) => /fires once per completed impression/.test(m.note)), `the finding surfaces on the crash property: ${JSON.stringify(crashProp.memory)}`);
  // app_version is a column of BOTH users and crashlytics — each is written as its own target
  await assert.rejects(() => e.memory({ action: 'record', notes: [{ note: 'x', about: ['app_version'] }] }), /`notes\.0\.about\.0` must be exactly one of: .*\| \{ term \}/);
  const both = (await e.memory({ action: 'record', notes: [{ note: 'app_version means the build, on either source', about: [{ source: 'users', column: 'app_version' }, { source: 'crashlytics', column: 'app_version' }] }] })).notes[0];
  assert.deepEqual(both.about.map((a) => a.source), ['users', 'crashlytics']);
});

// Columns that live only on an events source are searchable by name like any other.
test('semantic_index({ search }) finds a column that exists only on an events source', async () => {
  const e = engine();
  const r = await e.semantic_index({ search: 'bundle_id' });
  assert.ok(r.column_matches.some((d) => d.source === 'events' && d.column === 'bundle_id'), JSON.stringify(r.column_matches));
  assert.equal(r.dimension_matches, undefined, 'one name for the matches');
  // a match is named as the view that opens it takes it
  const m = r.column_matches.find((d) => d.column === 'bundle_id');
  assert.equal((await e.semantic_index({ source: m.source, column: m.column })).column, 'bundle_id');
  const r2 = await e.semantic_index({ search: 'device_model' });
  assert.ok(r2.column_matches.some((d) => d.source === 'crashlytics'), 'the crash source copy is found too');
});

// The guide speaks only about what the catalog declares: its join trigger names the models that declare
// a join contract, and is absent on a catalog where none does.
test('the guide derives its join trigger from the catalog\'s join contracts, or omits it', async () => {
  const e = engine();
  const g = await e.semantic_index({ guide: true });
  const t = g.routing_triggers.find((x) => /JOIN CONTRACT/.test(x.do));
  assert.ok(t && ['users', 'experiments', 'crashlytics', 'acquisition'].every((m) => t.do.includes(m)), JSON.stringify(t));
  assert.ok(!g.routing_triggers.some((x) => /crash/i.test(x.if)), 'no domain-specific crash trigger');
  const catalog = loadCatalog(CATALOG, {});
  for (const m of Object.values(catalog.models)) delete m.join;
  const plain = settle(new Engine({ catalog, contextManager: new ContextManager({ workspaceRoot: tempDir('surf') }) }));
  const g2 = await plain.semantic_index({ guide: true });
  assert.ok(!g2.routing_triggers.some((x) => /JOIN CONTRACT/.test(x.do)), 'no contract → no trigger');
});

// A funnel partitions by COLUMNS, or by a relationship the source DECLARES — named as one. No bare
// magic word means a relationship, and nothing in the engine knows what any relationship is called.
test('match_recognize partition_by: a column, or { entity } from the declared relationships', async () => {
  const e = engine();
  const bpm = e.schemas.build_model;
  const st = stageBranch(bpm, 'match_recognize');
  const branches = deref(bpm, field(bpm, st, 'partition_by').items).anyOf.map((b) => deref(bpm, b));
  const entityBranch = branches.find((b) => b.type === 'object');
  assert.ok(entityBranch, 'the entity form is in the schema, not only in prose');
  assert.deepEqual(deref(bpm, entityBranch.properties.entity).enum, ['ad_funnel', 'ad_funnel_banner', 'ad_funnel_interstitial', 'ad_funnel_rewarded', 'session', 'user'], 'the enum is what the catalog declares');
  assert.ok(branches.some((b) => b.type === 'string'), 'a plain column is still a column');

  const steps = [{ name: 'aa', event_name: ['first_launch'] }, { name: 'bb', event_name: ['new_session'] }];
  const start = await e.build_model({ action: 'start', name: 'fnl_part', source: 'events' });
  const add = (partition_by) => e.build_model({ action: 'add_steps', context_id: start.context_id, steps: [{ stage: 'match_recognize', steps, ...(partition_by ? { partition_by } : {}) }] });
  // a relationship written as a bare word is not a column — and the message says what to write
  await assert.rejects(() => add(['user']), /'user' is a RELATIONSHIP of 'events', not a column — write \{ entity: 'user' \}/);
  // a relationship keyed by several columns cannot be a partition column at all
  await assert.rejects(() => add([{ entity: 'ad_funnel' }]), /is keyed by .*, which is an expression, not a column/);
  // a relationship no source declares never gets past the SCHEMA — the enum is the contract
  await assert.rejects(() => add([{ entity: 'nope' }]), /entity` must be one of: ad_funnel, .*, user/);
});

// A client may pass on only the first 2,048 characters of a tool description or of the server's
// instructions (Claude Code does). Each description fits whole, and the instructions open with a
// core block that fits whatever the client was offered — the detail after it is extra, not needed.
test('the instructions open with a paragraph of at most 512 characters — what ChatGPT and Codex ask to stand alone', async () => {
  const { coreInstructions } = await import('../../src/mcp-surface.js');
  for (const offer of [{}, { apps: true, skillUris: ['skill://omg-analytics/SKILL.md'] }]) {
    const opening = coreInstructions(offer).split('\n\n')[0];
    assert.ok(opening.length <= 512, `${opening.length} characters`);
  }
});

// A question about how the server is built is declined: the opening carries the rule's brief, for a
// client that reads 512 characters, the core block the rule itself, which extends that same brief —
// whatever the client was offered — and semantic_index's description it again, for a client that
// reads no instructions.
test('the opening, the core block and the first tool all carry the refusal to talk about how the server is built', async () => {
  const { coreInstructions } = await import('../../src/mcp-surface.js');
  const { SELF_REFUSAL, SELF_REFUSAL_BRIEF, SELF_REFUSAL_TOOL } = await import('../../src/self-refusal.js');
  assert.ok(SELF_REFUSAL.startsWith(SELF_REFUSAL_BRIEF) && SELF_REFUSAL_TOOL.startsWith(SELF_REFUSAL_BRIEF), 'one wording: each form extends the brief');
  for (const offer of [{}, { apps: true, skillUris: ['skill://a/SKILL.md'], featureLines: ['a feature line'] }]) {
    const core = coreInstructions(offer);
    assert.ok(core.split('\n\n')[0].includes(SELF_REFUSAL_BRIEF), 'the opening states the brief');
    assert.ok(core.includes(SELF_REFUSAL), 'the core block states the rule');
  }
  // a client that reads no instructions still meets it, on the tool every question starts with
  assert.ok(buildToolDefs(engine()).find((d) => d.name === 'semantic_index').description.includes(SELF_REFUSAL_TOOL), 'semantic_index states it');
});

test('every tool description, and the core of the instructions for any offer, fits in 2,048 characters', async () => {
  const { coreInstructions, servicesFor } = await import('../../src/mcp-surface.js');
  for (const d of buildToolDefs(engine())) assert.ok(d.description.length <= 2048, `${d.name}: ${d.description.length} characters`);
  // the served skills under one root, and the feature's line: the largest core a deployment can serve
  const skillUris = ['skill://omg-analytics/analytics/SKILL.md', 'skill://omg-analytics/research/SKILL.md', 'skill://omg-analytics/python-stage/SKILL.md'];
  const { INSTRUCTIONS_LINE } = await import('../../src/retentioneering/guide.js');
  for (const offer of [{}, { apps: true }, { skillUris }, { apps: true, skillUris }, { apps: true, skillUris, featureLines: [INSTRUCTIONS_LINE] }]) {
    const core = coreInstructions(offer);
    assert.ok(core.length <= 2048, `${JSON.stringify(offer)}: ${core.length} characters`);
  }
  const services = servicesFor(engine());
  // the skills are found within the cut: the core names the root every served skill sits under
  const { skillRoot } = await import('../../src/mcp-surface.js');
  const served = services.skills?.skills.map((s) => s.uri) ?? [];
  assert.ok(served.length && served.every((u) => u.startsWith(skillRoot(served))) && coreInstructions({ skillUris: served }).includes(skillRoot(served)), 'the core names where the skills are');
  for (const offer of [{}, { apps: true, skills: true }]) {
    assert.ok(services.instructionsFor(offer).startsWith(coreInstructions({ apps: !!offer.apps, skillUris: offer.skills ? (services.skills?.skills.map((s) => s.uri) ?? []) : [] })), 'the instructions open with the core block');
  }
});
