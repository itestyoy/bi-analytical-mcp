// Regressions from the code review. Each test names the defect it pins, in the terms of what the
// USER would have seen. Allowed non-data checks only: input-validation guards (a bad input is
// refused) and context lifecycle (which files a context owns) — never the text of generated SQL.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { openStore } from '../../src/store.js';
import { renderContext } from '../../src/yaml-render.js';

const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));
const engine = (over = {}) => new Engine({
  catalog: loadCatalog(CATALOG, {}),
  contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'rev-')) }),
  ...over,
});

// ── delete_native_model left a pipeline's other files behind ────────────────────────────────
// A pipeline is a CHAIN of generated files: `<model>.sql`, and for a python stage `<model>.py` +
// `<model>.yml`, plus `<model>_sN.*` per step. Deleting only `<model>.sql` reported removed:true
// while dbt kept compiling the rest — and with the context's state cleared, nothing could name
// them again. Lifecycle check: what the context owns on disk afterwards.
test('delete_native_model removes EVERY file of the pipeline, not just the .sql', async () => {
  const e = engine();
  const ctx = e.ctxs.create();
  const dir = e.ctxs.generatedDir(ctx.id);
  ctx.state.engine = 'pipeline';
  ctx.state.model = 'pipe_demo';
  // the shapes a pipeline actually renders, plus a file belonging to ANOTHER model
  for (const f of ['pipe_demo.sql', 'pipe_demo.py', 'pipe_demo.yml', 'pipe_demo_s1.sql', 'pipe_demo_s2.py', 'pipe_other.sql']) {
    writeFileSync(join(dir, f), '-- x\n');
  }
  const out = await e.delete_native_model({ context_id: ctx.id });
  assert.equal(out.removed, true);
  const left = readdirSync(dir).filter((f) => f.startsWith('pipe_'));
  assert.deepEqual(left, ['pipe_other.sql'], 'only the other model’s file survives');
  assert.deepEqual([...out.removed_files].sort(), ['pipe_demo.py', 'pipe_demo.sql', 'pipe_demo.yml', 'pipe_demo_s1.sql', 'pipe_demo_s2.py']);
});

// ── the { source, property } view threw TypeError instead of refusing ───────────────────────
// The schema's enum normally makes an unknown name unwritable, but a source that declares no
// columns projects no enum and the field degrades to an open string. The view then read `.type`
// off a column that was not there.
test('an unknown column name is refused by the property view, not read off undefined', async () => {
  const e = engine();
  await assert.rejects(() => e.semantic_index({ source: 'users', property: 'no_such_column' }),
    /not a property or attribute of 'users'|`property` must be one of/);
});

// ── memory: a rewritten legacy target must be stored like every other target ────────────────
// `record` stores targets as objects; the one-time rewrite of source-less legacy keys used to
// store STRINGS ('term:foo') into the same list, so one note could hold two shapes and the
// `term:` prefix leaked into the searchable text.
test('a rewritten legacy memory target is stored in the same shape as a recorded one', async () => {
  const store = openStore({});
  const mk = () => new Engine({ catalog: loadCatalog(CATALOG, {}), contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'rev-')) }), store });
  const e0 = mk();
  store.memory.add({ id: 'legacy', note: 'ad format lives in ad_type', targets: ['property:ad_type_of_event_data'], aliases: [], links: [], created_at: Date.now() });
  const e = mk(); // a fresh Engine over the same store runs the rewrite
  const rec = await e.memory({ action: 'record', note: 'a recorded one', targets: [{ term: 'ad_type_of_event_data' }] });

  const shapeOf = (id) => store.memory.get(id).targets.map((t) => (t && typeof t === 'object' ? Object.keys(t).sort().join('+') : `string:${t}`));
  assert.deepEqual(shapeOf('legacy'), shapeOf(rec.id), 'the rewritten target has the same shape as a recorded one');
  // and the prefix never becomes part of what is searched
  const found = await e.memory({ action: 'search', query: 'ad_type_of_event_data' });
  assert.ok(found.notes.some((n) => n.id === 'legacy'), 'still findable by the word itself');
  assert.ok(!JSON.stringify(store.memory.get('legacy').targets).includes('term:'), 'no "term:" prefix inside the stored target');
  e0.close(); e.close();
});

// ── meta.mcp.dimension: false was ignored on a non-fact's time axis ─────────────────────────
// The opt-out is read further down the column loop, but the time axis returns before reaching it,
// so a spend table's `spend_date` stayed a groupable attribute however it was declared.
test('meta.mcp.dimension: false takes the time axis out of the group-by surface too', () => {
  const base = (optOut) => `version: 2
models:
  - name: fct_events
    meta:
      mcp: { role: events, primary_entity: event, known_events: [login] }
    columns:
      - { name: user_id, data_type: string, meta: { mcp: { entity: { name: user, type: foreign } } } }
      - { name: ts, data_type: timestamp, meta: { mcp: { is_time: true } } }
      - { name: event_name, data_type: string, meta: { mcp: { is_event_name: true } } }
  - name: dim_users
    meta: { mcp: { role: users } }
    columns:
      - { name: user_id, data_type: string, meta: { mcp: { entity: { name: user, type: primary } } } }
      - { name: country, data_type: string }
  - name: fct_spend
    meta: { mcp: { role: acquisition } }
    columns:
      - { name: user_id, data_type: string, meta: { mcp: { entity: { name: user, type: foreign } } } }
      - { name: spend_date, data_type: date, meta: { mcp: { is_time: true${optOut ? ', dimension: false' : ''} } } }
      - { name: cost, data_type: numeric, meta: { mcp: { measure: true } } }
`;
  const load = (yaml) => {
    const f = join(mkdtempSync(join(tmpdir(), 'rev-')), 'catalog.yml');
    writeFileSync(f, yaml);
    return loadCatalog(f, {});
  };
  const kept = load(base(false));
  assert.deepEqual(kept.modelDimensionColumns('acquisition'), ['spend_date'], 'by default the axis is groupable');
  const optedOut = load(base(true));
  assert.deepEqual(optedOut.modelDimensionColumns('acquisition'), [], 'opted out, it is not');
  // …and it is STILL the model's time axis, just not an attribute
  assert.equal(optedOut.getModel('acquisition').time?.column, 'spend_date');
});

// ── a pipeline whose only stage is `python` ran synchronously ───────────────────────────────
// The detached build was gated on the model COUNT, but a lone python stage renders as one model
// and still pays the warehouse Python runtime's cold start — minutes of a blocked call with no
// query_id to poll. Checked through the engine's own decision, with a runner stub standing in for
// the warehouse (no SQL text is asserted).
test('a single python-model pipeline is built detached, like a chain', async (t) => {
  process.env.MCP_PYTHON_MODELS = 'on'; // the fixture has no dbt profile, so the stage is hidden otherwise
  const VENV_PY = join(process.cwd(), '.dbtvenv', 'bin', 'python');
  const PY = existsSync(VENV_PY) ? VENV_PY : 'python3';
  if (spawnSync(PY, ['--version']).status !== 0) { t.skip('no python interpreter for the static gate'); return; }

  // The build is the slow part, so it is stubbed: what is under test is WHICH path the engine
  // takes, and a `run` that never returns within the timeout is exactly the situation the
  // detached path exists for.
  let ran = 0; let detached = false;
  const runner = {
    async run() { ran += 1; await new Promise((r) => setTimeout(r, 400)); return { ok: true, stdout: '', stderr: '' }; },
    async show() { return { ok: true, rows: [], columns: [] }; },
    async parse() { return { ok: true }; },
  };
  const e = new Engine({
    catalog: loadCatalog(CATALOG, {}),
    contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'rev-')) }),
    runner, pythonBin: PY, queryTimeoutMs: 50, // anything slower than this hands back a query_id
  });
  const py = {
    stage: 'python',
    functions: [{ name: 'tag', params: ['df'], body: ['df["tag"] = 1', 'return df'] }],
    steps: [{ call: 'tag', args: {} }],
    output: { columns: ['tag'] },
  };
  const out = await e.register_native_model({ name: 'only_py', pipeline: { source: 'events', stages: [py] } });
  assert.ok(out.ok !== false, JSON.stringify(out.error || {}));
  detached = out.status === 'running' && !!out.query_id;
  assert.ok(detached, `a lone python model hands back a query_id instead of blocking: ${JSON.stringify(out).slice(0, 300)}`);
  assert.equal(ran, 1, 'and the build did start');
});

// ── a funnel step filtering a JSON-BLOB payload property threw ReferenceError ───────────────
// Removing the (always-null) `col` qualifier from stepPredicate left one reference to it behind.
// A FLATTENED property short-circuits before that line, which is why the fixtures never hit it;
// a property read out of the event_data JSON does reach it, and the whole funnel died with
// "col is not defined" instead of building.
test('a funnel step can filter a property read from the event_data blob', async () => {
  const yaml = `version: 2
models:
  - name: fct_events
    meta:
      mcp:
        role: events
        primary_entity: event
        known_events: [tutorial, level_completed]
    columns:
      - { name: event_id, data_type: string, meta: { mcp: { entity: { name: event, type: primary } } } }
      - { name: user_id, data_type: string, meta: { mcp: { entity: { name: user, type: foreign } } } }
      - { name: ts, data_type: timestamp, meta: { mcp: { is_time: true } } }
      - { name: event_name, data_type: string, meta: { mcp: { is_event_name: true } } }
      - name: event_data
        data_type: jsonb
        meta:
          mcp:
            is_event_data: true
            properties:
              step_id: { type: string }
  - name: dim_users
    meta: { mcp: { role: users } }
    columns:
      - { name: user_id, data_type: string, meta: { mcp: { entity: { name: user, type: primary } } } }
      - { name: country, data_type: string }
`;
  const dir = mkdtempSync(join(tmpdir(), 'blob-'));
  const file = join(dir, 'catalog.yml');
  writeFileSync(file, yaml);
  const e = new Engine({ catalog: loadCatalog(file, {}), contextManager: new ContextManager({ workspaceRoot: dir }) });
  const funnel = {
    stage: 'match_recognize',
    partition_by: [{ entity: 'user' }],
    steps: [
      { name: 's1', event_name: ['tutorial'], where: [{ property: 'step_id', op: 'eq', value: 'step_1' }] },
      { name: 's2', event_name: ['tutorial'], where: [{ property: 'step_id', op: 'eq', value: 'step_2' }] },
    ],
    metrics: [{ name: 'reached_s2', type: 'reached', step: 's2' }],
  };
  const out = await e.register_native_model({ name: 'blob_funnel', dry_run: true, pipeline: { source: 'events', stages: [funnel] } });
  assert.ok(out.ok !== false, JSON.stringify(out.error || {}));
});

// ── a shipped recipe joined a slowly-changing dimension with no point-in-time window ───────
// The recipe text mentioned the window as something the caller should add; the payload did not
// carry it, so `dn_retention_exact` run as shipped fanned out to every historical version of each
// player and inflated Day-N retention. Whether the window is NEEDED is a property of the catalog,
// so the payload is fitted to it when the recipe is handed over.
test('a recipe payload is fitted to this catalog: an SCD join gets its validity window', async () => {
  const { loadRecipes } = await import('../../src/recipes.js');
  const e = new Engine({
    catalog: loadCatalog(CATALOG, {}),
    recipes: loadRecipes(fileURLToPath(new URL('../../config/recipes.json', import.meta.url))),
    contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'rev-')) }),
  });
  const out = await e.semantic_index({ recipe: 'dn_retention_exact' });
  const joinStage = out.register_payload.pipeline.stages.find((s) => s.stage === 'join' && s.with === 'users');
  const u = e.catalog.getModel('users');
  assert.ok(u.scd, 'the fixture users model is slowly-changing (otherwise this test proves nothing)');
  const from = Object.entries(u.dimensions).find(([, d]) => d.validity === 'start')[0];
  const to = Object.entries(u.dimensions).find(([, d]) => d.validity === 'end')[0];
  assert.deepEqual(joinStage.between, { value: e.catalog.getModel('events').time.column, from, to });
  assert.ok(out.fitted_to_catalog?.some((f) => f.includes("join with 'users'")), JSON.stringify(out.fitted_to_catalog));
});

// ── a pipeline submitted all at once got none of the stage warnings ─────────────────────────
// The incremental builder warns about an SCD join with no window; register_native_model ran the
// very same stages silently. Both paths now make the same judgements.
test('register_native_model warns about an incomplete SCD join, like the step builder does', async () => {
  const e = engine();
  const out = await e.register_native_model({
    name: 'scd_fanout', dry_run: true,
    pipeline: { source: 'events', stages: [{ stage: 'join', with: 'users', via: 'user', attrs: ['country'] }] },
  });
  assert.ok((out.warnings || []).some((w) => /INCOMPLETE JOIN/.test(w)), JSON.stringify(out.warnings));
  // with the window stated, there is nothing to warn about
  const ok = await e.register_native_model({
    name: 'scd_pit', dry_run: true,
    pipeline: { source: 'events', stages: [{ stage: 'join', with: 'users', via: 'user', attrs: ['country'], between: { value: 'device_time', from: 'install_time_valid_from', to: 'install_time_valid_until' } }] },
  });
  assert.ok(!(ok.warnings || []).some((w) => /INCOMPLETE JOIN/.test(w)), JSON.stringify(ok.warnings));
});

// ── remove_dimensions matched a name nobody is ever shown ───────────────────────────────────
// What is stored is the task-namespaced copy ('ret_country'); what the tools publish is the
// attribute ('country'). Matching on the stored name made every removal a silent no-op that
// still reported success.
test('remove_dimensions takes the attribute it was offered, and refuses an unknown one', async () => {
  const e = engine();
  const first = await e.create_semantic_model({
    name: 'ret',
    semantic_models: [
      { from: 'events', measures: [{ name: 'n', agg: 'count', field: '*' }] },
      { from: 'users', dimensions: [{ source: 'model_column', column: 'country' }] },
    ],
    metrics: [{ name: 'n', type: 'simple', measure: { name: 'n' } }],
  });
  const ctx = e.ctxs.get(first.context_id);
  assert.deepEqual(ctx.state.additions.users.dimensions.map((d) => d.name), ['ret_country'], 'stored namespaced');
  assert.ok(first.groupable.some((g) => g.model === 'users' && g.attribute === 'country'), 'offered as the attribute');

  await assert.rejects(
    () => e.update_semantic_model({ context_id: first.context_id, semantic_model: 'users', remove_dimensions: ['nope'] }),
    /cannot remove dimension 'nope'.*It has: country/s,
  );
  const out = await e.update_semantic_model({ context_id: first.context_id, semantic_model: 'users', remove_dimensions: ['country'] });
  assert.deepEqual(e.ctxs.get(first.context_id).state.additions.users.dimensions, [], 'the declaration is really gone');
  // and out of the manifest — `country` stays REACHABLE through the join (that is the catalog's
  // own surface), but the task no longer declares its own copy of it
  const { yaml } = renderContext(e.catalog, e.ctxs.get(first.context_id).state);
  assert.ok(!/ret_country/.test(yaml), 'the task-namespaced dimension is out of the manifest');
  assert.ok(out.metrics.length >= 1, 'the rest of the task is intact');
});

// ── the suggested group_by example named a model the context had not loaded ─────────────────
// `groupable` returned every attribute the CATALOG can reach, and the example deliberately picked
// a model other than the task's source — so the suggested call failed with "needs model 'users',
// which is not loaded in this context".
test('groupable and the example only name models this context loaded', async () => {
  const e = engine();
  const out = await e.create_semantic_model({
    name: 'evonly',
    semantic_models: [{ from: 'events', measures: [{ name: 'n', agg: 'count', field: '*' }] }],
    metrics: [{ name: 'n', type: 'simple', measure: { name: 'n' } }],
  });
  const loaded = new Set(out.joined_models);
  assert.ok(!loaded.has('users'), 'this context loaded no users model');
  assert.ok((out.groupable || []).every((g) => loaded.has(g.model)), JSON.stringify(out.groupable));
  assert.ok((out.groupable_after_loading || []).some((g) => g.model === 'users'), 'and the rest is offered separately');
  assert.match(out.groupable_after_loading_note || '', /use_base_models/);
  // whatever is published as groupable is accepted by the query path
  const ctx = e.ctxs.get(out.context_id);
  for (const g of out.groupable || []) {
    assert.equal(typeof e._normalizeRef(ctx, { model: g.model, attribute: g.attribute, ...(g.via ? { via: g.via } : {}) }, 'group_by'), 'string');
  }
});

// ── the submission method was concluded but never written down ──────────────────────────────
// A BigQuery profile may only HINT at its python submission: compute_region + gcs_bucket and no
// `submission_method`. This server inferred 'bigframes' from those settings and said so in
// semantic_index — but wrote `dbt.config(materialized="table")` and nothing else, so dbt fell back
// to its own default submission and every python model went to Dataproc instead, dying with
// "403 … dataproc.batches.create". The conclusion has to travel INTO the model.
test('the resolved submission method is written into the model, not just reported', async () => {
  const { resolvePythonRuntime } = await import('../../src/catalog.js');
  const { frameProfile, compilePythonStage, importAllowlist } = await import('../../src/python-model.js');
  const dir = mkdtempSync(join(tmpdir(), 'prof-'));
  writeFileSync(join(dir, 'profiles.yml'), [
    'p:', '  target: prod', '  outputs:', '    prod:',
    '      type: bigquery', '      project: x', '      dataset: bi',
    '      compute_region: us-central1', '      gcs_bucket: staging-bucket', '',
  ].join('\n'));

  const rt = resolvePythonRuntime({ profilesDir: dir, env: {} });
  assert.equal(rt.available, true);
  assert.equal(rt.method, 'bigframes', 'inferred from compute_region');
  assert.equal(rt.method_declared, false, 'the profile never declared it — which is why it must be written down');

  const profile = frameProfile(rt, rt.config || {});
  const stage = { stage: 'python', functions: [{ name: 'f', params: ['df'], body: ['return df'] }], steps: [{ call: 'f' }] };
  const compiled = compilePythonStage(stage, {
    modelName: 'm', inputModel: 'm_in', allow: importAllowlist({}, profile),
    config: rt.config || {}, profile, submission: rt.method,
  });
  assert.equal(compiled.config.submission_method, 'bigframes', 'the model configures the submission it was resolved to run on');

  // the operator's own override still wins over what was inferred
  const forced = compilePythonStage(stage, {
    modelName: 'm', inputModel: 'm_in', allow: importAllowlist({}, profile),
    config: { submission_method: 'serverless' }, profile, submission: rt.method,
  });
  assert.equal(forced.config.submission_method, 'serverless');

  // a profile that DECLARES the method is marked as such (nothing is being guessed there)
  writeFileSync(join(dir, 'profiles.yml'), [
    'p:', '  target: prod', '  outputs:', '    prod:',
    '      type: bigquery', '      project: x', '      dataset: bi',
    '      submission_method: bigframes', '      compute_region: us-central1', '      gcs_bucket: b', '',
  ].join('\n'));
  const declared = resolvePythonRuntime({ profilesDir: dir, env: {} });
  assert.equal(declared.method_declared, true);
});

// ── the submission is a MODEL config; dbt_project.yml is where dbt looks ─────────────────────
// dbt's bigquery macro resolves it as config.get("submission_method", "serverless") and reads
// nothing else — the profile's compute_region / gcs_bucket say who may submit a job, never how.
// So a project that configures the submission in dbt_project.yml must be believed over anything
// inferred from the profile, and an inferred value must be written into the model or the code and
// the runtime disagree (a Colab notebook holding PySpark, or a 403 on dataproc.batches.create).
test('the submission is read from dbt_project.yml first, and its source is reported', async () => {
  const { resolvePythonRuntime, submissionFromProject } = await import('../../src/catalog.js');
  const dir = mkdtempSync(join(tmpdir(), 'proj-'));
  // a profile whose settings IMPLY bigframes, and nothing declaring it
  writeFileSync(join(dir, 'profiles.yml'), [
    'p:', '  target: prod', '  outputs:', '    prod:',
    '      type: bigquery', '      project: x', '      dataset: bi',
    '      compute_region: us-central1', '      gcs_bucket: b', '',
  ].join('\n'));
  const project = (extra) => writeFileSync(join(dir, 'dbt_project.yml'), [
    'name: proj', 'profile: p', 'config-version: 2', 'models:', '  proj:', '    +materialized: table', ...extra, '',
  ].join('\n'));

  // nothing in the project → inferred, and said to be inferred
  project([]);
  const guessed = resolvePythonRuntime({ profilesDir: dir, projectDir: dir, env: {} });
  assert.equal(guessed.method, 'bigframes');
  assert.equal(guessed.method_declared, false);
  assert.match(guessed.method_source, /inferred/);

  // the project configures it, nested as dbt nests it → that wins and is credited
  project(['    python:', '      +submission_method: serverless']);
  assert.equal(submissionFromProject(dir), 'serverless');
  const declared = resolvePythonRuntime({ profilesDir: dir, projectDir: dir, env: {} });
  assert.equal(declared.method, 'serverless', 'the project overrides what the profile settings imply');
  assert.equal(declared.method_source, 'dbt_project.yml');
  assert.equal(declared.method_declared, true);

  // and the model carries whatever was resolved, so dbt's config.get finds it
  const { frameProfile, compilePythonStage, importAllowlist } = await import('../../src/python-model.js');
  const profile = frameProfile(declared, {});
  const compiled = compilePythonStage(
    { stage: 'python', functions: [{ name: 'f', params: ['df'], body: ['return df'] }], steps: [{ call: 'f' }] },
    { modelName: 'm', inputModel: 'm_in', allow: importAllowlist({}, profile), config: {}, profile, submission: declared.method },
  );
  assert.equal(compiled.config.submission_method, 'serverless');
});
