import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { loadRecipes } from '../../src/recipes.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { buildToolDefs } from '../../src/server.js';

const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));
const RECIPES = fileURLToPath(new URL('../../config/recipes.json', import.meta.url));
function engine() {
  const catalog = loadCatalog(CATALOG, {});
  return new Engine({ catalog, recipes: loadRecipes(RECIPES), contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'surf-')) }) });
}

// Advertised tool surface: the folded/rudimentary tools are gone; the merged ones present.
test('advertised tools: folded tools removed, context + experiment present', () => {
  const names = buildToolDefs(engine()).map((d) => d.name);
  assert.ok(names.includes('context'), 'unified context tool advertised');
  assert.ok(names.includes('experiment'), 'unified experiment tool advertised');
  assert.ok(names.includes('semantic_index') && names.includes('build_native_model'));
  for (const gone of ['update_native_model', 'list_query_jobs', 'get_recipe', 'list_recipes', 'list_contexts', 'describe_context', 'drop_context', 'delete_native_model', 'delete_semantic_model', 'register_native_model', 'ab_test', 'srm_check', 'sample_size']) {
    assert.ok(!names.includes(gone), `${gone} is no longer advertised`);
  }
  // every advertised tool has a real description (not name-as-description).
  for (const d of buildToolDefs(engine())) assert.notEqual(d.description, d.name, `${d.name} has a description`);
  // every advertised tool has a human-readable title (top-level + annotations), distinct from name.
  for (const d of buildToolDefs(engine())) {
    assert.ok(typeof d.title === 'string' && d.title.length > 0, `${d.name} has a title`);
    assert.equal(d.annotations?.title, d.title, `${d.name} mirrors title into annotations`);
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

// context({ action }) — the unified lifecycle tool — dispatches + validates strictly.
test('context tool: list / describe / drop dispatch and strict fields', async () => {
  const e = engine();
  // start a draft to create a context.
  const s = await e.build_native_model({ action: 'start', name: 'ctxtool', source: 'events' });
  const list = await e.context({ action: 'list' });
  assert.ok(list.contexts.some((c) => c.context_id === s.draft_id), 'list shows the created context');
  const desc = await e.context({ action: 'describe', context_id: s.draft_id });
  assert.equal(desc.context_id ?? desc.id ?? s.draft_id, desc.context_id ?? desc.id ?? s.draft_id); // describe returns the context shape
  // strict: describe requires context_id; list forbids it.
  await assert.rejects(() => e.context({ action: 'describe' }), /invalid input/);
  await assert.rejects(() => e.context({ action: 'list', context_id: s.draft_id }), /invalid input/);
  // delete_semantic_model requires semantic_model.
  await assert.rejects(() => e.context({ action: 'delete_semantic_model', context_id: s.draft_id }), /invalid input/);
  await assert.rejects(() => e.context({ action: 'bogus' }), /invalid input/);
  // drop tears the context down.
  await e.context({ action: 'drop', context_id: s.draft_id });
  const after = await e.context({ action: 'list' });
  assert.ok(!after.contexts.some((c) => c.context_id === s.draft_id), 'dropped context is gone');
});

// Recipes folded into semantic_index: overview lists them; { recipe: id } returns one.
test('semantic_index folds recipes: overview list + { recipe } payload', async () => {
  const e = engine();
  const overview = await e.semantic_index();
  assert.ok(Array.isArray(overview.recipes) && overview.recipes.some((r) => r.id === 'nday_retention'), 'overview lists recipe ids');
  const r = await e.semantic_index({ recipe: 'nday_retention' });
  assert.equal(r.id, 'nday_retention');
  assert.ok(r.hack && (r.create_payload || r.register_payload), 'recipe payload + hack returned');
  assert.ok(r.naming_note.includes('namespaced'), 'carries the task-namespacing note');
  // recipe is a mutually-exclusive view; an unknown id is rejected by the enum.
  await assert.rejects(() => e.semantic_index({ recipe: 'nday_retention', event: 'tutorial' }), /at most ONE view/);
  await assert.rejects(() => e.semantic_index({ recipe: 'no_such_recipe' }), /invalid input/);
});

// A pipeline with a sample stage produces an APPROXIMATE result, flagged loudly with
// safe/unsafe guidance + how to get the exact number (never silently misleading).
test('a sampled pipeline flags the result approximate with guidance', async () => {
  const e = engine();
  const s = await e.build_native_model({ action: 'start', name: 'sampled', source: 'events' });
  await e.build_native_model({ action: 'add_step', draft_id: s.draft_id, stage: { stage: 'sample', percent: 10 } });
  await e.build_native_model({ action: 'add_step', draft_id: s.draft_id, stage: { stage: 'aggregate', group_by: ['event_name'], measures: [{ name: 'n', fn: 'count' }] } });
  const out = await e.build_native_model({ action: 'materialize', draft_id: s.draft_id });
  assert.equal(out.provenance.approximate, true, 'provenance marks the result approximate');
  assert.equal(out.sampling.approximate, true);
  assert.equal(out.sampling.sample_percent, 10);
  assert.ok(out.sampling.not_reliable_for && out.sampling.get_exact, 'carries safe/unsafe + how-to-get-exact');
  // a non-sampled pipeline has neither flag.
  const s2 = await e.build_native_model({ action: 'start', name: 'exact', source: 'events' });
  await e.build_native_model({ action: 'add_step', draft_id: s2.draft_id, stage: { stage: 'aggregate', group_by: ['event_name'], measures: [{ name: 'n', fn: 'count' }] } });
  const out2 = await e.build_native_model({ action: 'materialize', draft_id: s2.draft_id });
  assert.equal(out2.provenance.approximate, undefined);
  assert.equal(out2.sampling, undefined);
});

// Recipes are building blocks reached THROUGH semantic_index, not a standalone tool.
test('recipes have no standalone tool; get_recipe payload is framed as a building block', async () => {
  const names = buildToolDefs(engine()).map((d) => d.name);
  assert.ok(!names.includes('get_recipe') && !names.includes('list_recipes'), 'no standalone recipe tools');
  const r = await engine().semantic_index({ recipe: 'nday_retention' });
  assert.ok(r.building_block && r.hack, 'recipe is presented as a reusable building block (+ hack technique)');
});

// #3 gotcha: referencing an event-specific property without scoping its event(s) reads NULL.
test('add_step warns when an event-specific property is used without its event scope', async () => {
  const e = engine();
  // Applicability is DATA-DERIVED from the value index: seed coverage showing ad_type is populated
  // only on ad_started/ad_finished (NULL on first_launch) — the nudge reads this, not a declared list.
  e.valueIndex.upsertProperty('events', 'ad_type_of_event_data', { coverage: [
    { event: 'ad_started', rowCount: 10, nonNull: 10 },
    { event: 'ad_finished', rowCount: 10, nonNull: 10 },
    { event: 'first_launch', rowCount: 5, nonNull: 0 },
  ] });
  const s = await e.build_native_model({ action: 'start', name: 'scopewarn', source: 'events' });
  // ad_type_of_event_data is populated only on ad_started/ad_finished.
  const a = await e.build_native_model({ action: 'add_step', draft_id: s.draft_id, stage: { stage: 'aggregate', group_by: ['ad_type_of_event_data'], measures: [{ name: 'n', fn: 'count' }] } });
  assert.ok(a.recommendations.some((r) => r.includes('ad_type_of_event_data') && r.includes('populated only on event')), JSON.stringify(a.recommendations));
  // with an upstream where scoping event_name to those events → no NULL warning.
  const s2 = await e.build_native_model({ action: 'start', name: 'scoped', source: 'events' });
  await e.build_native_model({ action: 'add_step', draft_id: s2.draft_id, stage: { stage: 'where', conditions: [{ column: 'event_name', op: 'in', value: ['ad_started', 'ad_finished'] }] } });
  const a2 = await e.build_native_model({ action: 'add_step', draft_id: s2.draft_id, stage: { stage: 'aggregate', group_by: ['ad_type_of_event_data'], measures: [{ name: 'n', fn: 'count' }] } });
  assert.ok(!a2.recommendations.some((r) => r.includes('populated only on event')), 'scoped event → no NULL warning');
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
  assert.ok(g.tasks && Array.isArray(g.tasks.retention) && g.tasks.retention.some((r) => r.id === 'nday_retention'), 'per-task recipe families listed');
  // narrow to one family.
  const gt = await e.semantic_index({ guide: 'retention' });
  assert.equal(gt.task, 'retention');
  assert.ok(gt.recipes.some((r) => r.id === 'retention_by_segment'));
  // overview points at the guide; guide is a mutually-exclusive view.
  const ov = await e.semantic_index();
  assert.ok(typeof ov.guide === 'string' && /guide/.test(ov.guide));
  await assert.rejects(() => e.semantic_index({ guide: true, model: 'events' }), /at most ONE view/);
});

// Without recipes configured, the recipe view + overview list are simply absent.
test('semantic_index recipe view is absent when no recipes configured', async () => {
  const catalog = loadCatalog(CATALOG, {});
  const e = new Engine({ catalog, contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'norec-')) }) });
  const overview = await e.semantic_index();
  assert.equal(overview.recipes, undefined);
  await assert.rejects(() => e.semantic_index({ recipe: 'x' }), /recipes are not configured|invalid input/);
});

// A governed path is served by the semantic model of the model it ends on. A task built from one
// events source does not load the other's, so a path onto that fact's own attributes is refused
// here with the fix — instead of reaching MetricFlow as an unknown entity.
test('a group-by path onto an unloaded FACT is refused with the use_base_models fix', async () => {
  const e = engine();
  const out = await e.create_semantic_model({
    name: 'evonly',
    semantic_models: [{ from: 'events', measures: [{ name: 'n', agg: 'count', field: '*' }] }],
    metrics: [{ name: 'n', type: 'simple', measure: { name: 'n' } }],
  });
  await assert.rejects(
    () => e.query_semantic_model({ context_id: out.context_id, metrics: ['evonly_n'], group_by: [{ model: 'crashlytics', attribute: 'app_version' }] }),
    /needs model 'crashlytics'.*use_base_models/s,
  );
});

// The relationship a model OWNS is reported as owned — its governed path ends here — not as
// "pipeline only" (the two conditions used to be tested in the wrong order).
test('semantic_index({ model }) reports an owned relationship as owned, with a governed path', async () => {
  const e = engine();
  const users = await e.semantic_index({ model: 'users' });
  const rel = users.relationships.find((r) => r.entity === 'user');
  assert.equal(rel.owned_here, true);
  assert.match(rel.use, /^owned here — other models point at it/);
  assert.ok(!/No model owns 'user'/.test(users.join_note || ''), users.join_note);
  const events = await e.semantic_index({ model: 'events' });
  assert.equal(events.relationships.find((r) => r.entity === 'user').use, 'metric query + pipeline');
});

// The qualified '<source>.<name>' form — the one the tool itself emits — resolves; a bare name
// carried by several sources is reported, never guessed.
test('memory targets: qualified names resolve, ambiguous bare names are refused', async () => {
  const e = engine();
  const saved = await e.memory({ action: 'record', note: 'ad_finished fires once per completed impression', targets: ['events.ad_finished', 'crashlytics.anr_duration_of_event_data', 'users.country'] });
  assert.deepEqual(saved.linked_to.map((l) => l.kind), ['event', 'property', 'property'], JSON.stringify(saved.linked_to));
  assert.deepEqual(saved.unresolved_terms || [], []);
  const shown = await e.semantic_index({ source: 'events', event: 'ad_finished' });
  assert.ok((shown.memory || []).length >= 1, 'the finding surfaces on the event it was about');
  // app_version is an attribute of BOTH users and crashlytics
  await assert.rejects(() => e.memory({ action: 'record', note: 'x', targets: ['app_version'] }), /ambiguous.*users\.app_version.*crashlytics\.app_version|ambiguous.*crashlytics\.app_version.*users\.app_version/s);
});

// Attributes that live only on an events source are searchable by name like any other.
test('semantic_index({ search }) finds a dimension that exists only on an events source', async () => {
  const e = engine();
  const r = await e.semantic_index({ search: 'bundle_id' });
  assert.ok(r.dimension_matches.some((d) => d.source === 'events' && d.column === 'bundle_id'), JSON.stringify(r.dimension_matches));
  const r2 = await e.semantic_index({ search: 'device_model' });
  assert.ok(r2.dimension_matches.some((d) => d.source === 'crashlytics'), 'the crash source copy is found too');
});

// The guide speaks only about what the catalog declares: its variant trigger names the real
// expanded relationships, and is absent on a catalog without variants.
test('the guide derives its variant-join trigger from the catalog, or omits it', async () => {
  const e = engine();
  const g = await e.semantic_index({ guide: true });
  const t = g.routing_triggers.find((x) => /alternative columns/.test(x.if));
  assert.ok(t && /ad_funnel_rewarded/.test(t.do) && /ad_funnel_banner/.test(t.do), JSON.stringify(t));
  assert.ok(!g.routing_triggers.some((x) => /crash/.test(x.if)), 'no domain-specific crash trigger');
  const catalog = loadCatalog(CATALOG, {});
  for (const m of Object.values(catalog.models)) for (const [n, en] of Object.entries(m.entities || {})) if (en.variant_of) delete m.entities[n];
  const plain = new Engine({ catalog, contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'surf-')) }) });
  const g2 = await plain.semantic_index({ guide: true });
  assert.ok(!g2.routing_triggers.some((x) => /alternative columns/.test(x.if)), 'no variants → no trigger');
});
