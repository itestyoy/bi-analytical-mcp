// Recipes come in TWO LAYERS: the SYSTEM file that ships with the server and the DEPLOYMENT's own
// file(s). Before this they were one path — RECIPES_PATH REPLACED the system set, so a deployment
// with its own recipes silently lost every shipped one, python ones included.
//
// Input-validation / surface guard (the allowed non-data kind): what is offered, to whom, and why
// one is withheld. Nothing here runs a recipe — that is recipes-parse.test.js on the warehouse.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRecipes } from '../../src/recipes.js';

const SYSTEM = fileURLToPath(new URL('../../config/recipes.json', import.meta.url));

const deploymentFile = (recipes) => {
  const f = join(mkdtempSync(join(tmpdir(), 'rec-')), 'mine.json');
  writeFileSync(f, JSON.stringify({ recipes }));
  return f;
};

test('a deployment file ADDS to the system recipes instead of replacing them', () => {
  const mine = deploymentFile([
    { id: 'my_domain_recipe', task_type: 'engagement', title: 'Mine', when_to_use: 'my game', hack: 'x' },
  ]);
  const merged = loadRecipes(SYSTEM, mine);
  const system = loadRecipes(SYSTEM);
  assert.ok(merged.ids().length === system.ids().length + 1, 'every shipped recipe is still there');
  assert.ok(merged.ids().includes('my_domain_recipe'), "and the deployment's own one is offered too");
  // each side is labelled, so the caller can tell what came from where
  const byId = Object.fromEntries(merged.summary().map((r) => [r.id, r.origin]));
  assert.equal(byId.my_domain_recipe, 'deployment');
  // …and a recipe that came from the system FILE says so. (The set also carries generated
  // REFERENCE entries — a library's extracted signatures, published as fetchable recipes — whose
  // origin is 'generated'; they are not from either file.)
  const fromSystemFile = system.summary().find((r) => !r.requires || r.origin === 'system');
  assert.equal(byId[fromSystemFile.id], 'system');
  assert.ok(merged.summary().some((r) => r.origin === 'generated'), 'the generated reference entries are labelled as such');
});

test('a deployment may OVERRIDE a system recipe by reusing its id', () => {
  const systemId = loadRecipes(SYSTEM).ids()[0];
  const mine = deploymentFile([{ id: systemId, task_type: 'engagement', title: 'My version', when_to_use: 'ours', hack: 'x' }]);
  const merged = loadRecipes(SYSTEM, mine);
  assert.equal(merged.get(systemId).title, 'My version');
  assert.equal(merged.get(systemId).origin, 'deployment');
  assert.equal(merged.ids().length, loadRecipes(SYSTEM).ids().length, 'an override replaces, it does not duplicate');
});

test('several deployment files load in order', () => {
  const a = deploymentFile([{ id: 'r_a', task_type: 't', title: 'A', when_to_use: '', hack: '' }]);
  const b = deploymentFile([{ id: 'r_b', task_type: 't', title: 'B', when_to_use: '', hack: '' }, { id: 'r_a', task_type: 't', title: 'A2', when_to_use: '', hack: '' }]);
  const merged = loadRecipes(SYSTEM, `${a},${b}`);
  assert.ok(merged.ids().includes('r_a') && merged.ids().includes('r_b'));
  assert.equal(merged.get('r_a').title, 'A2', 'the later file wins');
});

test('a recipe is offered only where this deployment can run it', () => {
  const mine = deploymentFile([
    { id: 'needs_python', task_type: 't', title: 'py', when_to_use: '', hack: '', requires: 'python_models' },
    { id: 'bq_only', task_type: 't', title: 'bq', when_to_use: '', hack: '', dialect: 'bigquery' },
    { id: 'bigframes_only', task_type: 't', title: 'bf', when_to_use: '', hack: '', runtime: 'bigframes' },
    { id: 'anywhere', task_type: 't', title: 'any', when_to_use: '', hack: '' },
  ]);
  const bq = loadRecipes(SYSTEM, mine, { dialect: 'bigquery', python: true, runtime: 'bigframes' });
  for (const id of ['needs_python', 'bq_only', 'bigframes_only', 'anywhere']) assert.ok(bq.ids().includes(id), id);

  const local = loadRecipes(SYSTEM, mine, { dialect: 'duckdb', python: false, runtime: 'unknown' });
  assert.ok(local.ids().includes('anywhere'));
  for (const id of ['needs_python', 'bq_only', 'bigframes_only']) assert.ok(!local.ids().includes(id), `${id} must not be offered here`);
  // the shipped python recipes are withheld on that deployment too
  assert.deepEqual(local.idsRequiring('python_models'), []);
  assert.ok(loadRecipes(SYSTEM, [], { dialect: 'bigquery', python: true, runtime: 'bigframes' }).idsRequiring('python_models').length >= 3);

  // …and fetching one by id still answers, saying why it does not fit here
  assert.match(local.get('needs_python').unavailable_here, /no dbt python models/);
  assert.match(local.get('bq_only').unavailable_here, /this warehouse is duckdb/);
  assert.equal(local.get('anywhere').unavailable_here, undefined);
});
