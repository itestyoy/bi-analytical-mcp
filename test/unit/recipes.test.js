import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadCatalog } from '../../src/catalog.js';
import { loadRecipes } from '../../src/recipes.js';
import { buildSchemas } from '../../src/schema.js';
import { makeValidators, validateInput } from '../../src/validate.js';
import { compileDeclaration } from '../../src/compile.js';
import { Engine } from '../../src/engine.js';
import { ContextManager } from '../../src/context-manager.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const catalog = loadCatalog(join(process.cwd(), 'config', 'catalog.json'));
const recipes = loadRecipes(join(process.cwd(), 'config', 'recipes.json'));
const validators = makeValidators(buildSchemas(catalog));

test('recipes cover the expected analytics task types', () => {
  const ids = recipes.ids();
  for (const need of ['active_users_trend', 'metric_by_user_segment', 'step_conversion_funnel', 'nday_retention', 'cohort_retention_grid', 'behavioral_cohort', 'visit_to_purchase_conversion', 'level_progression', 'monetization_metrics', 'stickiness_lifecycle']) {
    assert.ok(ids.includes(need), `missing recipe: ${need}`);
  }
});

test('every recipe create_payload validates against the create schema and compiles', () => {
  for (const r of recipes.list) {
    const res = validateInput(validators.create_semantic_model, r.create_payload);
    assert.ok(res.ok, `recipe ${r.id} create_payload invalid: ${JSON.stringify(res.errors)}`);
    const compiled = compileDeclaration(catalog, r.create_payload); // throws on bad refs
    assert.ok(compiled.metricNames.length > 0, `recipe ${r.id} produced no metrics`);
    r.__metricNames = compiled.metricNames;
  }
});

test('every recipe example_query references metrics produced by its create_payload', () => {
  for (const r of recipes.list) {
    const produced = new Set(r.__metricNames || compileDeclaration(catalog, r.create_payload).metricNames);
    for (const q of r.example_queries || []) {
      for (const m of q.metrics) assert.ok(produced.has(m), `recipe ${r.id}: example metric ${m} not produced (have: ${[...produced]})`);
      const input = { context_id: 'abcdef', ...q };
      const res = validateInput(validators.query_semantic_model, input);
      assert.ok(res.ok, `recipe ${r.id} example query invalid: ${JSON.stringify(res.errors)}`);
    }
  }
});

test('engine list_recipes / get_recipe tools work', () => {
  const eng = new Engine({ catalog, contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'rec-')) }), runner: null, recipes });
  assert.equal(eng.list_recipes().recipes.length, recipes.list.length);
  const r = eng.get_recipe({ id: 'monetization_metrics' });
  assert.equal(r.id, 'monetization_metrics');
  assert.ok(r.create_payload && r.example_queries);
  assert.throws(() => eng.get_recipe({ id: 'nope' }));
});
