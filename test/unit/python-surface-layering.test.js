// THE PYTHON SURFACE HAS LAYERS, and each fact belongs to exactly one of them (the list is written
// out at the top of src/python-guide.js). This test is the guard on that division, because the
// failure mode is silent: a list copied into a second text keeps working, and then the library
// changes and only one of the two copies is updated.
//
//   facts       → config/bigframes-facts.json (extracted from the library)
//   rules       → src/python-guide.js, rendered compact into the stage description and in full
//                 through semantic_index({ guide: 'python' })
//   hints       → composed from the same facts, carried by the frame profile
//   reference   → the same facts published as fetchable recipes
//   mechanics   → the frame profile + the stage description (the stage in THIS server)
//   when to use → one routing trigger in src/guide.js
//   worked form → config/recipes.json, plus the shape nudges in src/engine.js
//
// These are surface checks of the kind the project allows as non-data: what the server SAYS, and
// where it says it. Nothing here asserts on generated SQL, YAML or python.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCatalog } from '../../src/catalog.js';
import { loadRecipes } from '../../src/recipes.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { frameProfile, pythonRunHints } from '../../src/python-model.js';
import { pythonAuthoringGuide, mlClassesText } from '../../src/python-guide.js';
import { buildGuide } from '../../src/guide.js';

const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));
const RECIPES = fileURLToPath(new URL('../../config/recipes.json', import.meta.url));
const FACTS = JSON.parse(readFileSync(fileURLToPath(new URL('../../config/bigframes-facts.json', import.meta.url)), 'utf8'));

const engine = () => {
  const catalog = loadCatalog(CATALOG, {});
  catalog.pythonRuntime = { available: true, runtime: 'bigquery', method: 'bigframes', config: {}, packages: '' };
  return new Engine({ catalog, recipes: loadRecipes(RECIPES), contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'layer-')) }) });
};
const stageDescription = (e) => e.schemas.build_native_model.properties.stage.oneOf
  .find((b) => b.properties?.stage?.enum?.[0] === 'python').description;

const occurrences = (text, probe) => text.split(probe).length - 1;

test('the stage description states the SQL-first rule ONCE, through the guide it renders', () => {
  const d = stageDescription(engine());
  // it IS there — a caller who reads only the description still learns what belongs in the stage
  assert.match(d, /only what SQL cannot say/);
  assert.match(d, /PREPARED table/);
  // …and exactly once: the description's own job is the mechanics, the rule comes from the guide
  for (const probe of ['only what SQL cannot say', 'PREPARED table', 'WHAT BELONGS HERE']) {
    assert.equal(occurrences(d, probe), 1, `"${probe}" appears ${occurrences(d, probe)}× in the stage description — the rule has one home`);
  }
  // the mechanics that ARE the description's own: where the stage sits, what the server writes
  for (const probe of ['dbt.ref', 'output.columns', 'SIZE:']) assert.match(d, new RegExp(probe.replace('.', '\\.')));
});

test('the estimator list in the frame profile comes from the extracted sheet', () => {
  const bq = frameProfile({ runtime: 'bigquery', method: 'bigframes' });
  const classes = mlClassesText();
  assert.ok(classes && bq.ml.includes(classes), 'the profile renders the generated list rather than keeping its own');
  // every module the sheet knows is named, and nothing is named that the sheet does not know
  for (const mod of Object.keys(FACTS.ml)) assert.match(classes, new RegExp(`\\b${mod}\\.`), `${mod} is missing from the generated list`);
  for (const cls of Object.keys(FACTS.ml.cluster)) assert.match(classes, new RegExp(cls));
  // …and the profile line does NOT restate parameters: those live in the reference recipe
  assert.ok(!/n_clusters/.test(bq.ml), 'parameters belong to bf_ml_signatures, not to this one-liner');
});

test('a failure hint names the same methods and claims as the fact sheet, and points at a recipe', () => {
  const bq = frameProfile({ runtime: 'bigquery', method: 'bigframes' });
  const ordering = pythonRunHints(bq, 'OrderRequiredError: Op head requires an ordering.')[0];
  for (const method of ['head', 'rank', 'shift']) {
    assert.ok(FACTS.requires_ordering.DataFrame.includes(method) || FACTS.requires_ordering.Series.includes(method), `precondition: ${method} is marked`);
    assert.match(ordering, new RegExp(`\\b${method}\\b`), `the hint omits ${method}`);
  }
  assert.match(ordering, /bf_frame_method_rules/, 'and sends the caller to the full list instead of repeating it');

  const kw = pythonRunHints(bq, "TypeError: KMeans.__init__() got an unexpected keyword argument 'standardize_features'")[0];
  const claim = FACTS.rules.find((r) => r.id === 'ml_is_bqml_not_sklearn').claim;
  assert.ok(kw.includes(claim.slice(0, 60)), 'the hint carries the fact sheet claim verbatim, not a paraphrase');
  assert.match(kw, /bf_ml_signatures/);

  // the library's own words for the two-step pipeline limit, so the matcher cannot fire on our logs
  const twoStep = pythonRunHints(bq, 'NotImplementedError: Currently only two step (transform, estimator) pipelines are supported.');
  assert.equal(twoStep.length, 1);
  assert.match(twoStep[0], /ColumnTransformer/);
  assert.deepEqual(pythonRunHints(bq, 'dbt is building the chain of 2 models for this pipeline'), [], 'the word "pipeline" in a build log is not a failure');
});

// EVERY failure class we have an answer for is answered where the caller is standing: on the run
// that failed. A case with no hint is a hole — the caller is left with the warehouse's words alone.
test('each failure class this server knows is answered on the failed run', () => {
  const bq = frameProfile({ runtime: 'bigquery', method: 'bigframes' });
  const e = engine();
  const cases = [
    ['NullIndexError: Cannot implicitly align objects', /merge/],
    ['OrderRequiredError: Op head requires an ordering.', /sort_values/],
    ["TypeError: KMeans.__init__() got an unexpected keyword argument 'standardize_features'", /bf_ml_signatures/],
    ['NotImplementedError: Currently only two step (transform, estimator) pipelines are supported.', /ColumnTransformer/],
    ['ValueError: convert it to a BigFrames BigQuery function', /vectorized/],
    ['MemoryError: notebook runtime out of memory', /to_pandas/],
  ];
  for (const [log, expect] of cases) {
    const hints = pythonRunHints(bq, log);
    assert.equal(hints.length, 1, `no hint for: ${log}`);
    assert.match(hints[0], expect);
  }
  // the two failures that are the CHAIN's or the SQL's, not the runtime's
  assert.match(e._pythonRunMessage('', 'Unrecognized name: CENTROID_ID'), /output.columns/);
  assert.match(e._sqlRunMessage('', 'Resources exceeded during query execution'), /agg_table_stat_no_global_window/);
  // …and a log with nothing to say about is left as the warehouse wrote it
  assert.deepEqual(pythonRunHints(bq, 'Compilation Error: model not found'), []);
});

test('the routing trigger says WHEN to reach for python, and hands over to the guide and the recipes', () => {
  const catalog = loadCatalog(CATALOG, {});
  catalog.pythonRuntime = { available: true, runtime: 'bigquery', method: 'bigframes', config: {}, packages: '' };
  const g = buildGuide(catalog, loadRecipes(RECIPES), { python: frameProfile(catalog.pythonRuntime) });
  const trigger = g.routing_triggers.find((t) => /SQL cannot express/.test(t.if));
  assert.ok(trigger, 'the trigger exists');
  assert.match(trigger.do, /guide: "python"/, 'it points at the guide…');
  assert.match(trigger.do, /recipe: "<id>"/, '…and at the recipes');
  // it does NOT re-teach the frame rules: no method lists, no signatures in a routing trigger
  assert.ok(!/NullIndexError|OrderRequiredError|n_clusters/.test(trigger.do), 'the trigger routes, it does not teach');
});

test('every failure a shipped recipe answers has a place that names that recipe', () => {
  const e = engine();
  const bq = frameProfile({ runtime: 'bigquery', method: 'bigframes' });
  const surfaces = [
    stageDescription(e),
    JSON.stringify(pythonAuthoringGuide(bq, loadRecipes(RECIPES).entriesRequiring('python_models'))),
    JSON.stringify(bq.runHints),
    e._sqlRunMessage('', 'Resources exceeded during query execution'),
    JSON.stringify(e._globalWindowWarnings({ stage: 'compute', op: 'window', fn: 'avg', column: 'x' })),
  ].join('\n');
  // each observed failure of the last weeks is answered SOMEWHERE the caller will be standing
  for (const id of [
    'bf_ml_signatures',               // TypeError on an sklearn parameter
    'bf_frame_method_rules',          // OrderRequiredError / NullIndexError
    'bf_ml_predict_as_column',        // a prediction assigned back
    'bf_ml_categoricals_into_a_model', // a third Pipeline step
    'agg_table_stat_no_global_window', // Resources exceeded on a global window
    'agg_scale_rows_by_literals',      // and its second pass
  ]) assert.match(surfaces, new RegExp(id), `nothing points at ${id} when it is needed`);
});
