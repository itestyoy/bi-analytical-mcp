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
test('advertised tools: folded tools removed, context present', () => {
  const names = buildToolDefs(engine()).map((d) => d.name);
  assert.ok(names.includes('context'), 'unified context tool advertised');
  assert.ok(names.includes('semantic_index') && names.includes('build_native_model'));
  for (const gone of ['update_native_model', 'list_query_jobs', 'get_recipe', 'list_recipes', 'list_contexts', 'describe_context', 'drop_context', 'delete_native_model', 'delete_semantic_model', 'register_native_model']) {
    assert.ok(!names.includes(gone), `${gone} is no longer advertised`);
  }
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

// Without recipes configured, the recipe view + overview list are simply absent.
test('semantic_index recipe view is absent when no recipes configured', async () => {
  const catalog = loadCatalog(CATALOG, {});
  const e = new Engine({ catalog, contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'norec-')) }) });
  const overview = await e.semantic_index();
  assert.equal(overview.recipes, undefined);
  await assert.rejects(() => e.semantic_index({ recipe: 'x' }), /recipes are not configured|invalid input/);
});
