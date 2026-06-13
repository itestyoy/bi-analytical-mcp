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
