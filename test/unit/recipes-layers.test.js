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

// A pipeline recipe's payload is the build_pipeline_model start request itself, handed over as it
// stands: build_pipeline_model({ request: <pipeline_payload> }). Every shipped one is held to the
// tool's own schema here (input validation — what they compute is recipes-parse.test.js's), on a
// deployment that runs python models, so the python ones are offered their stage.
test('every shipped pipeline_payload is a build_pipeline_model start request the tool accepts as it stands', async () => {
  await import('../../src/engine.js'); // the engine registers the funnel and python stages, as a server does
  const { loadCatalog } = await import('../../src/catalog.js');
  const { buildSchemas } = await import('../../src/schema.js');
  const { makeValidators, validateInput } = await import('../../src/validate.js');
  const catalog = loadCatalog(fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url)), {});
  catalog.pythonRuntime = { available: true, runtime: 'bigquery', config: {}, packages: '' }; // as a BigQuery deployment resolves
  const validators = makeValidators(buildSchemas(catalog));
  const pipelines = loadRecipes(SYSTEM).list.filter((r) => r.pipeline_payload);
  assert.ok(pipelines.length > 10, 'the shipped set has pipeline recipes');
  for (const r of pipelines) {
    const res = validateInput(validators.build_pipeline_model, r.pipeline_payload);
    assert.equal(res.ok, true, `${r.id}: ${(res.errors || []).join(' | ')}`);
    assert.equal(r.pipeline_payload.action, 'start', `${r.id}: a start request`);
  }
});

// A deployment's file is not ours to rewrite: one written for an earlier version carries the
// one-call shape { name, pipeline: { source, time_range?, stages } }, which no tool takes. It is
// served as the start request it stands for.
test('a deployment recipe in the earlier { name, pipeline } shape is served as the start request', () => {
  const stages = [{ stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'first_launch' }] }];
  const mine = deploymentFile([{ id: 'old_shape', task_type: 't', title: 'old', when_to_use: '', hack: '', pipeline_payload: { name: 'old_shape', description: 'kept', pipeline: { source: 'events', time_range: { start: '2026-01-01', end: '2026-01-31' }, stages } } }]);
  assert.deepEqual(loadRecipes(SYSTEM, mine).get('old_shape').pipeline_payload, { action: 'start', name: 'old_shape', description: 'kept', source: 'events', time_range: { start: '2026-01-01', end: '2026-01-31' }, stages });
});

// The same for an experiment block written for an earlier version: its columns are named by flat
// `<field>_field` keys (the experiment tool's earlier field names), which the tool now refuses. It is
// served with `arm` — the group as the tool takes it — and a row read through it is a group the
// experiment tool accepts.
test('a deployment recipe with the earlier flat experiment block is served with `arm`, and its rows are groups the tool accepts', async () => {
  const { loadCatalog } = await import('../../src/catalog.js');
  const { ContextManager } = await import('../../src/context-manager.js');
  const { Engine } = await import('../../src/engine.js');
  const { settle } = await import('../helpers/settle.js');
  const { armFrom } = await import('../helpers/experiment-arm.js');
  const catalog = loadCatalog(fileURLToPath(new URL('../../config/catalog.yml', import.meta.url)), { dialect: 'duckdb' });
  const engine = settle(new Engine({ catalog, contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'rec-ab-')) }) }));

  const old = {
    proportion: { action: 'analyze', metric: 'proportion', group_field: 'g', n_field: 'n', conversions_field: 'conv' },
    mean: { action: 'analyze', metric: 'mean', group_field: 'g', n_field: 'n', mean_field: 'm', stddev_field: 'sd' },
    cuped: { action: 'analyze', metric: 'cuped', group_field: 'g', n_field: 'n', sumY_field: 'sy', sumY2_field: 'sy2', sumX_field: 'sx', sumX2_field: 'sx2', sumXY_field: 'sxy' },
    ratio: { action: 'analyze', metric: 'ratio', group_field: 'g', n_field: 'n', sumNum_field: 'sn', sumDen_field: 'sd', sumNum2_field: 'sn2', sumDen2_field: 'sd2', sumNumDen_field: 'snd' },
    split: { action: 'check_split', group_field: 'g', n_field: 'n', expected_ratio: [1, 1] },
  };
  const mine = deploymentFile(Object.entries(old).map(([k, experiment]) => ({ id: `old_${k}`, task_type: 'experiment', title: k, when_to_use: '', hack: '', experiment })));
  const served = (k) => loadRecipes(SYSTEM, mine).get(`old_${k}`).experiment;

  assert.deepEqual(served('proportion'), { action: 'analyze', metric: 'proportion', group_field: 'g', arm: { n: 'n', conversions: 'conv' } });
  assert.deepEqual(served('mean'), { action: 'analyze', metric: 'mean', group_field: 'g', arm: { n: 'n', mean: 'm', stddev: 'sd' } });
  assert.deepEqual(served('cuped'), { action: 'analyze', metric: 'cuped', group_field: 'g', arm: { n: 'n', sum: 'sy', sum_squares: 'sy2', covariate: { sum: 'sx', sum_squares: 'sx2' }, sum_products: 'sxy' } });
  assert.deepEqual(served('ratio'), { action: 'analyze', metric: 'ratio', group_field: 'g', arm: { n: 'n', numerator: { sum: 'sn', sum_squares: 'sn2' }, denominator: { sum: 'sd', sum_squares: 'sd2' }, sum_products: 'snd' } });
  assert.deepEqual(served('split'), { action: 'check_split', group_field: 'g', expected_ratio: [1, 1], arm: { n: 'n' } });

  // rows as a per-group pipeline gives them: control first, then the variant
  const rows = {
    proportion: [{ g: 'control', n: 1000, conv: 200 }, { g: 'B', n: 1000, conv: 250 }],
    mean: [{ g: 'control', n: 500, m: 10, sd: 2 }, { g: 'B', n: 500, m: 12, sd: 2 }],
    cuped: [{ g: 'control', n: 4, sy: 10, sy2: 30, sx: 8, sx2: 20, sxy: 24 }, { g: 'B', n: 4, sy: 14, sy2: 54, sx: 8, sx2: 20, sxy: 32 }],
    ratio: [{ g: 'control', n: 4, sn: 6, sn2: 12, sd: 12, sd2: 40, snd: 21 }, { g: 'B', n: 4, sn: 8, sn2: 20, sd: 12, sd2: 40, snd: 28 }],
  };
  for (const [k, [control, ...variants]] of Object.entries(rows)) {
    const map = served(k);
    const r = engine.experiment({ action: map.action, metric: map.metric, control: armFrom(map, control), variants: variants.map((row) => armFrom(map, row)) });
    assert.equal(r.ok, true, k);
    assert.equal(r.results.length, 1, k);
    assert.equal(r.results[0].variant, 'B', k);
  }
  const split = served('split');
  const srm = engine.experiment({ action: split.action, groups: [{ g: 'control', n: 1000 }, { g: 'B', n: 1010 }].map((row) => armFrom(split, row)), expected_ratio: split.expected_ratio });
  assert.equal(srm.srm_detected, false);

  // a block already in the current shape is served as written
  const current = { action: 'analyze', metric: 'proportion', group_field: 'g', arm: { n: 'n', conversions: 'conv' } };
  const now = deploymentFile([{ id: 'now', task_type: 'experiment', title: 'now', when_to_use: '', hack: '', experiment: current }]);
  assert.deepEqual(loadRecipes(SYSTEM, now).get('now').experiment, current);
});
