// The `python` pipeline stage: ONE declaration → two dbt models under the hood (the SQL stages as
// the prep TABLE, the stage as the dbt Python model that refs it). Allowed non-data checks: input
// validation (what the stage refuses, and why) and the context lifecycle (which files land where,
// what the context records). The rows the Python model produces are proven on a warehouse that
// runs dbt Python models (test/integration/python-stage.test.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { pyLiteral, importAllowlist, frameProfile, compilePythonStage, runAstGate, pythonRunHints } from '../../src/python-model.js';

const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));
// The fixture catalog is loaded without a dbt profile here → no Python runtime → the stage would be
// hidden. Force it on for these tests, exactly as an operator does when the submission is set per
// model; the availability rules themselves are tested at the end of this file.
process.env.MCP_PYTHON_MODELS = 'on';
const VENV_PY = join(process.cwd(), '.dbtvenv', 'bin', 'python');
const PY = existsSync(VENV_PY) ? VENV_PY : 'python3';
const HAS_PY = spawnSync(PY, ['--version']).status === 0;

const engine = () => {
  const ctxs = new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'pystage-')) });
  return new Engine({ catalog: loadCatalog(CATALOG, {}), contextManager: ctxs, pythonBin: PY });
};
const AGG = { stage: 'aggregate', group_by: ['player_id_of_internal'], measures: [{ name: 'n', fn: 'count' }, { name: 'revenue', fn: 'sum', column: 'price_in_usd_of_event_data' }] };
const ZSCORE = { name: 'zscore', params: ['df', 'column', 'as_'], body: ['df[as_] = (df[column] - df[column].mean()) / df[column].std(ddof=0)', 'return df'] };
const PY_STAGE = { stage: 'python', imports: [{ package: 'numpy' }], functions: [ZSCORE], steps: [{ call: 'zscore', args: { column: 'revenue', as_: 'revenue_z' } }], output: { columns: ['player_id_of_internal', 'revenue', 'revenue_z'] } };
const decl = (over = {}) => ({ name: 'seg', pipeline: { source: 'events', stages: [AGG, PY_STAGE] }, ...over });
const pipeFiles = (e, id) => readdirSync(e.ctxs.generatedDir(id)).filter((f) => f.startsWith('pipe_')).sort();
const skipNoPy = (t) => { if (!HAS_PY) { t.skip('no python interpreter for the static gate'); return true; } return false; };

test('pyLiteral: JSON values become Python literals', () => {
  assert.equal(pyLiteral(true), 'True'); assert.equal(pyLiteral(null), 'None'); assert.equal(pyLiteral(4), '4');
  assert.equal(pyLiteral("it's"), '"it\'s"');
  assert.equal(pyLiteral(['a', 1, false]), '["a", 1, False]');
  assert.equal(pyLiteral({ k: [null] }), '{"k": [None]}');
});

test('importAllowlist: the base set + the operator\'s MCP_PYTHON_PACKAGES (import=pip)', () => {
  const a = importAllowlist({ MCP_PYTHON_PACKAGES: 'holidays, prophet=prophet, bad-name=x' });
  assert.equal(a.get('sklearn'), 'scikit-learn');
  assert.equal(a.get('pandas'), null);
  assert.equal(a.get('holidays'), null, 'no pip name → preinstalled');
  assert.equal(a.get('prophet'), 'prophet');
  assert.ok(!a.has('bad-name'));
});

test('python stage: one declaration lands as prep TABLE + Python model under the pipeline name', async (t) => {
  if (skipNoPy(t)) return;
  const e = engine();
  const r = await e.register_native_model(decl({ materialized: 'view' })); // view requested: overridden, and said so
  assert.equal(r.build.ok, true);
  assert.match(r.model, /^pipe_seg_[a-z0-9]+$/);
  assert.equal(r.materialized, 'table');
  assert.deepEqual(r.models.map((m) => [m.model, m.kind, m.input]), [[`${r.model}_s1`, 'sql', 'fct_analytics_events'], [r.model, 'python', `${r.model}_s1`]], 'the chain: SQL model → Python model reading it');
  assert.equal(r.python[0].model, r.model);
  assert.deepEqual(r.python[0].packages, [], 'numpy ships with the runtime → nothing for dbt to install');
  assert.deepEqual(r.python[0].steps, ['zscore']);
  assert.deepEqual(r.columns, ['player_id_of_internal', 'revenue', 'revenue_z'], 'the declared output columns are the pipeline\'s columns');
  assert.ok(r.assumptions.some((a) => /view was requested/.test(a)));
  // files: the SQL prep model, the Python model and its YAML sidecar — and NO pipe_seg_<ctx>.sql
  const files = pipeFiles(e, r.context_id);
  assert.deepEqual(files, [`${r.model}.py`, `${r.model}.yml`, `${r.model}_s1.sql`]);
  // the context records the split
  const n = e.ctxs.get(r.context_id).state.native;
  assert.equal(n.model, r.model);
  assert.deepEqual(n.chain.map((m) => m.model), [`${r.model}_s1`, r.model]);
  assert.equal(r.build.executed, false, 'no runner → written, not run');
  // the result is addressed like any pipeline model
  assert.equal(r.read_with.table, r.model);
});

test('python stage: a rebuild WITHOUT the stage removes the Python files (dbt allows one model per name)', async (t) => {
  if (skipNoPy(t)) return;
  const e = engine();
  const r1 = await e.register_native_model(decl());
  const r2 = await e.register_native_model({ name: 'seg', context_id: r1.context_id, pipeline: { source: 'events', stages: [AGG] } });
  assert.equal(r2.model, r1.model);
  assert.deepEqual(pipeFiles(e, r1.context_id), [`${r1.model}.sql`]);
  assert.equal(e.ctxs.get(r1.context_id).state.native.python, undefined);
});

// A python stage may sit ANYWHERE, any number of times: every one is a dbt model of its own, and
// the SQL stages around it become SQL models reading the previous model — dbt builds the chain.
test('python stage anywhere: first (reads the source), middle, twice — each a model in the chain', async (t) => {
  if (skipNoPy(t)) return;
  const e = engine();
  const PY_OUT = { ...PY_STAGE, output: { columns: ['player_id_of_internal', 'revenue', 'revenue_z'] } };
  const PY_FIRST = { stage: 'python', functions: [{ name: 'keep', params: ['df'], body: ['return df'] }], steps: [{ call: 'keep' }] }; // no output → the source's columns pass through
  const r = await e.register_native_model({ name: 'chain', pipeline: { source: 'events', stages: [PY_FIRST, AGG, PY_OUT, { stage: 'where', conditions: [{ column: 'revenue_z', op: 'gt', value: 0 }] }, { stage: 'limit', n: 10 }] } });
  assert.deepEqual(r.models.map((m) => [m.model, m.kind, m.input]), [
    [`${r.model}_s1`, 'python', 'fct_analytics_events'],   // python FIRST → dbt.ref of the source itself
    [`${r.model}_s2`, 'sql', `${r.model}_s1`],              // the aggregate reads the Python model
    [`${r.model}_s3`, 'python', `${r.model}_s2`],
    [r.model, 'sql', `${r.model}_s3`],                      // SQL after python: where + limit over the Python model's columns
  ]);
  assert.equal(r.materialized, 'table');
  assert.deepEqual(r.columns, ['player_id_of_internal', 'revenue', 'revenue_z'], 'the where stage saw revenue_z because the python stage declared output.columns');
  assert.deepEqual(pipeFiles(e, r.context_id), [`${r.model}.sql`, `${r.model}_s1.py`, `${r.model}_s1.yml`, `${r.model}_s2.sql`, `${r.model}_s3.py`, `${r.model}_s3.yml`]);
  assert.equal(r.python.length, 2);
  // Each model's `input` above IS what it reads; that the generated code actually reads THAT model
  // is proven by running the chain (test/integration/python-stage.test.js — the rows only come out
  // right if each link reads the previous one).
  assert.deepEqual(r.python.map((m) => m.input), ['fct_analytics_events', `${r.model}_s2`]);
  // a SQL stage that names a column the python stage did not declare is refused at validation
  const PY_NO_OUT = { ...PY_STAGE, output: undefined };
  await assert.rejects(() => e.register_native_model({ name: 'chain2', dry_run: true, pipeline: { source: 'events', stages: [AGG, PY_NO_OUT, { stage: 'where', conditions: [{ column: 'revenue_z', op: 'gt', value: 0 }] }] } }), /unknown column 'revenue_z'/);
  // a rebuild with a SHORTER chain leaves no orphaned _sN model behind
  const r2 = await e.register_native_model({ name: 'chain', context_id: r.context_id, pipeline: { source: 'events', stages: [AGG, PY_OUT] } });
  assert.deepEqual(pipeFiles(e, r.context_id), [`${r2.model}.py`, `${r2.model}.yml`, `${r2.model}_s1.sql`]);
});

test('python stage: the allowed packages are an ENUM in the tool schema; anything else is refused by the schema', async () => {
  const e = engine();
  const items = e.schemas.register_native_model.properties.pipeline.properties.stages.items.oneOf.find((s) => s.properties.stage.enum?.[0] === 'python');
  assert.deepEqual(items.properties.imports.items.properties.package.enum, [...importAllowlist().keys()], 'the enum IS the allowlist');
  assert.ok(items.properties.imports.items.properties.package.enum.includes('sklearn'));
  await assert.rejects(() => e.register_native_model(decl({ pipeline: { source: 'events', stages: [AGG, { ...PY_STAGE, imports: [{ package: 'requests' }] }] } })), /package. must be one of: pandas, numpy, sklearn, scipy, statsmodels/);
  // a bare string is no longer an import declaration
  await assert.rejects(() => e.register_native_model(decl({ pipeline: { source: 'events', stages: [AGG, { ...PY_STAGE, imports: ['numpy'] }] } })));
});

test('python stage: a step must call a declared function with exactly its parameters', async () => {
  const e = engine();
  const bad = (steps) => e.register_native_model(decl({ pipeline: { source: 'events', stages: [AGG, { ...PY_STAGE, steps }] } }));
  await assert.rejects(() => bad([{ call: 'nope', args: {} }]), /'nope' is not a declared function. Declared: zscore/);
  await assert.rejects(() => bad([{ call: 'zscore', args: { column: 'revenue' } }]), /'zscore' needs 'as_'/);
  await assert.rejects(() => bad([{ call: 'zscore', args: { column: 'revenue', as_: 'z', extra: 1 } }]), /has no parameter 'extra'/);
  await assert.rejects(() => bad([{ call: 'zscore', args: { df: 1, column: 'revenue', as_: 'z' } }]), /'df' is the frame parameter/);
});

test('python stage: the static gate refuses imports in bodies, dbt/session access, eval and dunders — naming function and line', async (t) => {
  if (skipNoPy(t)) return;
  const e = engine();
  const bad = { name: 'bad', params: ['df'], body: ['import os', "x = eval('1')", "df['t'] = dbt.this", 'return df.__class__'] };
  const err = await e.register_native_model(decl({ pipeline: { source: 'events', stages: [AGG, { ...PY_STAGE, functions: [bad], steps: [{ call: 'bad' }] }] } })).catch((x) => x);
  assert.ok(err instanceof Error);
  assert.match(err.message, /bad line 1 \(import os\): an import inside a function body/);
  assert.match(err.message, /bad line 2 .*: 'eval' is not available here/);
  assert.match(err.message, /bad line 3 .*: 'dbt' is not available here/);
  assert.match(err.message, /bad line 4 .*: attribute '__class__' is private/);
  // The gate allowlists NAMES, so a dunder spelled through getattr (or any other builtin that
  // fetches by name) has no spelling either — the hole a blocklist of literal dunders leaves open.
  const sneaky = { name: 'sneaky', params: ['df'], body: ['sess = getattr(getattr(df, "__class__"), "__init__")', 'return df'] };
  await assert.rejects(
    () => e.register_native_model(decl({ pipeline: { source: 'events', stages: [AGG, { ...PY_STAGE, functions: [sneaky], steps: [{ call: 'sneaky' }] }] } })),
    /sneaky line 1 .*: 'getattr' is not available here/,
  );
  // …and so does a name the declaration never bound (no `imports` entry for it).
  const undeclared = { name: 'undeclared', params: ['df'], body: ["df['c'] = os.getcwd()", 'return df'] };
  await assert.rejects(
    () => e.register_native_model(decl({ pipeline: { source: 'events', stages: [AGG, { ...PY_STAGE, functions: [undeclared], steps: [{ call: 'undeclared' }] }] } })),
    /undeclared line 1 .*: 'os' is not available here/,
  );
  // a syntax error is caught here, not on the warehouse runtime
  const syn = { name: 'syn', params: ['df'], body: ['return df['] };
  await assert.rejects(() => e.register_native_model(decl({ pipeline: { source: 'events', stages: [AGG, { ...PY_STAGE, functions: [syn], steps: [{ call: 'syn' }] }] } })), /syn line 1 \(return df\[\): syntax error/);
  // a function that never returns the frame is refused too
  const noret = { name: 'noret', params: ['df'], body: ["df['x'] = 1"] };
  await assert.rejects(() => e.register_native_model(decl({ pipeline: { source: 'events', stages: [AGG, { ...PY_STAGE, functions: [noret], steps: [{ call: 'noret' }] }] } })), /must `return` the frame/);
  // nothing was written by a refused declaration
  assert.equal(e.ctxs.list().length, 0);
});

test('python stage: a package the runtime lacks goes to dbt\'s packages config; operator extras are literal', async (t) => {
  if (skipNoPy(t)) return;
  const ctxs = new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'pystage-')) });
  const e = new Engine({ catalog: loadCatalog(CATALOG, {}), contextManager: ctxs, pythonBin: PY, pythonModelConfig: { submission_method: 'bigframes' } });
  const st = { ...PY_STAGE, imports: [{ package: 'sklearn', submodule: 'cluster', names: ['KMeans'] }, { package: 'scipy', submodule: 'stats' }, { package: 'numpy', as: 'np' }] };
  const r = await e.register_native_model(decl({ dry_run: true, pipeline: { source: 'events', stages: [AGG, st] } }));
  assert.equal(r.dry_run, true);
  assert.deepEqual(r.python[0].packages, ['scikit-learn', 'scipy']);
  assert.equal(r.materialized, 'table');
  assert.equal(ctxs.list().length, 0, 'dry_run writes nothing');
});

// The operator's pin decides ONE runtime, so the tool SCHEMA and the compiled model must describe
// the same one. A BigQuery profile submits through BigFrames by default; pinning `serverless` makes
// it PySpark — and the schema used to keep offering the default's packages (it re-read the
// environment) while the model was compiled for the pin, so an import the schema accepted could be
// refused at compile.
test('python stage: the pinned submission decides BOTH the offered packages and the compiled model', async (t) => {
  if (skipNoPy(t)) return;
  const catalog = loadCatalog(CATALOG, {});
  catalog.pythonRuntime = { available: true, runtime: 'bigquery', config: {}, packages: '' }; // as a BigQuery profile resolves
  const ctxs = new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'pystage-')) });
  const e = new Engine({ catalog, contextManager: ctxs, pythonBin: PY, pythonModelConfig: { submission_method: 'serverless' } });
  const pkgEnum = () => e.schemas.register_native_model.properties.pipeline.properties.stages.items.oneOf
    .find((x) => x.properties?.stage?.enum?.[0] === 'python').properties.imports.items.properties.package.enum;
  assert.ok(pkgEnum().includes('pyspark'), `the schema offers the pinned runtime's packages: ${pkgEnum().join(', ')}`);
  assert.ok(!pkgEnum().includes('bigframes'), 'and not the default submission\'s');
  const r = await e.register_native_model(decl({ dry_run: true, pipeline: { source: 'events', stages: [AGG, { ...PY_STAGE, imports: [{ package: 'pyspark', submodule: 'sql.functions', as: 'F' }] }] } }));
  assert.equal(r.python[0].runtime, 'pyspark', 'the model is compiled for the same runtime the schema described');
});

test('incremental builder: add_step python → columns, nothing may follow, preview carries the model, materialize writes the split', async (t) => {
  if (skipNoPy(t)) return;
  const e = engine();
  const s = await e.build_native_model({ action: 'start', name: 'seg', source: 'events' });
  await e.build_native_model({ action: 'add_step', draft_id: s.draft_id, stage: AGG });
  const p = await e.build_native_model({ action: 'add_step', draft_id: s.draft_id, stage: PY_STAGE });
  assert.deepEqual(p.columns_added.map((c) => c.name), ['revenue_z']);
  const pv = await e.build_native_model({ action: 'preview', draft_id: s.draft_id });
  assert.deepEqual(pv.models.map((m) => [m.model, m.kind]), [[`pipe_seg_${s.draft_id}_s1`, 'sql'], [`pipe_seg_${s.draft_id}`, 'python']]);
  assert.equal(pv.models[1].input, `pipe_seg_${s.draft_id}_s1`, 'the python model reads the SQL model before it');
  assert.deepEqual(pv.available_columns.map((c) => c.name), ['player_id_of_internal', 'revenue', 'revenue_z']);
  // SQL after the python stage is allowed — it becomes the next model in the chain
  const after = await e.build_native_model({ action: 'add_step', draft_id: s.draft_id, stage: { stage: 'limit', n: 5 } });
  assert.equal(after.step_index, 3);
  const m = await e.build_native_model({ action: 'materialize', draft_id: s.draft_id });
  assert.equal(m.model, `pipe_seg_${s.draft_id}`);
  assert.deepEqual(pipeFiles(e, s.draft_id), [`${m.model}.sql`, `${m.model}_s1.sql`, `${m.model}_s2.py`, `${m.model}_s2.yml`]);
});

// The body is STRUCTURE: nesting is indentation, so the shape itself has to be valid Python shape.
test('python stage: body structure — nesting is indentation, headers open blocks, no spaces-as-indent', async (t) => {
  if (skipNoPy(t)) return;
  const e = engine();
  const withBody = (body) => e.register_native_model(decl({ dry_run: true, pipeline: { source: 'events', stages: [AGG, { ...PY_STAGE, functions: [{ name: 'f', params: ['df', 'k'], body }], steps: [{ call: 'f', args: { k: 2 } }] }] } }));
  // a real nested body renders as indented Python the gate accepts
  // (that nesting becomes the RIGHT indentation is proven by running such a body — the branches
  // pick different values, and the rows say which one ran: test/integration/python-stage.test.js)
  const ok = await withBody(['if k > 1:', ["df['seg'] = 1", 'for c in df.columns:', ['df[c] = df[c]']], 'else:', ["df['seg'] = 0"], 'return df']);
  assert.equal(ok.dry_run, true);
  // a block with no header before it
  await assert.rejects(() => withBody(['x = 1', ["df['seg'] = 1"], 'return df']), /nested block must follow a line that opens it .*the line before is "x = 1"/);
  // a header with no block after it
  await assert.rejects(() => withBody(['if k > 1:', 'return df']), /"if k > 1:" opens a block, so the next item must be a nested array/);
  // indentation by spaces is refused — nesting is the only way
  await assert.rejects(() => withBody(['if k > 1:', ['    return df']]), /must not start with whitespace|must match pattern/);
  // an empty block, a newline inside a line, a text blob instead of an array
  await assert.rejects(() => withBody(['if k > 1:', [], 'return df']), /empty block|at least 1 item/);
  await assert.rejects(() => withBody(['x = 1\nreturn df']), /must not contain a newline|pattern/);
  await assert.rejects(() => withBody('return df'), /body/);
  assert.equal(e.ctxs.list().length, 0);
});

// The recursion lives in ONE definition at the tool root — no unrolled copies, no depth cap.
test('python stage: the body schema is a recursive $ref to $defs.py_block hoisted to each tool root', async (t) => {
  if (skipNoPy(t)) return;
  const e = engine();
  for (const tool of ['build_native_model', 'register_native_model']) {
    const root = e.schemas[tool];
    assert.ok(root.$defs?.py_block, `${tool} carries $defs.py_block at its root`);
    assert.deepEqual(root.$defs.py_block.items.anyOf[1], { $ref: '#/$defs/py_block' }, 'the block refers to itself');
    const stages = tool === 'build_native_model' ? root.properties.stage.oneOf : root.properties.pipeline.properties.stages.items.oneOf;
    const py = stages.find((st) => st.properties.stage.enum?.[0] === 'python');
    assert.equal(py.properties.functions.items.properties.body.$ref, '#/$defs/py_block');
  }
  // twelve levels deep validates and renders — deeper than any unrolled schema allowed
  const deep = (n) => (n === 0 ? ['return df'] : [`if k > ${n}:`, deep(n - 1), 'else:', ['return df']]);
  const r = await e.register_native_model(decl({ dry_run: true, pipeline: { source: 'events', stages: [AGG, { ...PY_STAGE, functions: [{ name: 'f', params: ['df', 'k'], body: deep(12) }], steps: [{ call: 'f', args: { k: 1 } }] }] } }));
  assert.equal(r.dry_run, true); // and such a body RUNS (integration: twelve levels deep, by rows)
});

// ── Availability: the stage exists only where dbt can run Python models — decided from the profile ──
test('python stage: offered only where the dbt profile can run Python models; refused elsewhere with the reason', async () => {
  const { resolvePythonRuntime } = await import('../../src/catalog.js');
  const PG = fileURLToPath(new URL('../integration/fixtures/dbt_project', import.meta.url));      // postgres profile
  const DUCK = fileURLToPath(new URL('../integration/fixtures/duckdb_project', import.meta.url)); // duckdb profile
  const noEnv = { };
  // the decision itself
  assert.equal(resolvePythonRuntime({ profilesDir: PG, projectDir: PG, env: noEnv }).available, false);
  assert.match(resolvePythonRuntime({ profilesDir: PG, projectDir: PG, env: noEnv }).reason, /postgres.*runs no dbt Python models/);
  assert.deepEqual(resolvePythonRuntime({ profilesDir: DUCK, projectDir: DUCK, env: noEnv }), { available: true, runtime: 'duckdb', config: {}, packages: '' });
  assert.equal(resolvePythonRuntime({ profilesDir: PG, projectDir: PG, env: { MCP_PYTHON_MODELS: 'on' } }).available, true, 'the operator may force it on');
  assert.equal(resolvePythonRuntime({ profilesDir: DUCK, projectDir: DUCK, env: { MCP_PYTHON_MODELS: 'off' } }).available, false, '…or off');
  assert.equal(resolvePythonRuntime({ profilesDir: '/nonexistent', env: noEnv }).available, false);
  // a BigQuery profile: only with a submission set up
  const bq = (out) => { const dir = mkdtempSync(join(tmpdir(), 'bqprof-')); writeFileSync(join(dir, 'profiles.yml'), `p:\n  target: dev\n  outputs:\n    dev:\n      type: bigquery\n${Object.entries(out).map(([k, v]) => `      ${k}: ${v}`).join('\n')}\n`); return resolvePythonRuntime({ profilesDir: dir, env: noEnv }); };
  assert.equal(bq({ project: 'x' }).available, false);
  assert.match(bq({ project: 'x' }).reason, /submission_method \(bigframes \| serverless \| cluster\)/);
  // method_declared says whether the profile SAID the submission or the settings only implied it —
  // an implied one must be written into each model's dbt.config, or dbt uses its own default
  assert.deepEqual(bq({ project: 'x', submission_method: 'bigframes', gcs_bucket: 'b', compute_region: 'us-central1' }), { available: true, runtime: 'bigquery', method: 'bigframes', method_source: 'profile', method_declared: true, config: {}, packages: '' });
  assert.deepEqual(bq({ project: 'x', gcs_bucket: 'b', dataproc_region: 'us-central1' }), { available: true, runtime: 'bigquery', method: 'serverless', method_source: "inferred from the profile's settings", method_declared: false, config: {}, packages: '' });
  assert.deepEqual(bq({ project: 'x', gcs_bucket: 'b', compute_region: 'us-central1' }), { available: true, runtime: 'bigquery', method: 'bigframes', method_source: "inferred from the profile's settings", method_declared: false, config: {}, packages: '' });
  // the operator's settings are resolved ONCE, here, and travel with the runtime — so the schema,
  // the stage's validation and the compiled model cannot describe different runtimes.
  const pinned = resolvePythonRuntime({ profilesDir: DUCK, projectDir: DUCK, env: { MCP_PYTHON_MODEL_CONFIG: '{"submission_method":"serverless"}', MCP_PYTHON_PACKAGES: 'shap=shap' } });
  assert.deepEqual(pinned.config, { submission_method: 'serverless' });
  assert.equal(pinned.packages, 'shap=shap');
  assert.deepEqual(resolvePythonRuntime({ profilesDir: DUCK, projectDir: DUCK, env: { MCP_PYTHON_MODEL_CONFIG: 'not json' } }).config, {}, 'an unparseable pin is no pin');
  // and what the tools show: with the postgres profile the stage is ABSENT from the schemas…
  const saved = process.env.MCP_PYTHON_MODELS; delete process.env.MCP_PYTHON_MODELS;
  try {
    const cPg = loadCatalog(CATALOG, { profilesDir: PG, projectDir: PG });
    assert.equal(cPg.pythonRuntime.available, false);
    const ePg = new Engine({ catalog: cPg, contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'pystage-')) }), pythonBin: PY });
    const stagesPg = ePg.schemas.build_native_model.properties.stage.oneOf.map((st) => st.properties.stage.enum?.[0]);
    assert.ok(!stagesPg.includes('python'), `no python stage on postgres: ${stagesPg.join(', ')}`);
    assert.ok(!ePg.schemas.build_native_model.$defs?.py_block, 'and no py_block definition either');
    // …and a declaration naming it is refused with the reason, not with a warehouse error later
    await assert.rejects(() => ePg.register_native_model({ name: 'seg', pipeline: { source: 'events', stages: [AGG, PY_STAGE] } }), /python stage is not available: .*postgres.*runs no dbt Python models|must be equal to one of the allowed values|stage/);
    // the overview says so
    const ov = await ePg.semantic_index({});
    assert.equal(ov.python_models.available, false);
    assert.match(ov.python_models.reason, /postgres/);
    // with the duckdb profile it is there, and the overview names the runtime
    const cDuck = loadCatalog(CATALOG, { profilesDir: DUCK, projectDir: DUCK });
    const eDuck = new Engine({ catalog: cDuck, contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'pystage-')) }), pythonBin: PY });
    assert.ok(eDuck.schemas.build_native_model.properties.stage.oneOf.some((st) => st.properties.stage.enum?.[0] === 'python'));
    assert.ok(eDuck.schemas.build_native_model.$defs.py_block);
    assert.deepEqual((await eDuck.semantic_index({})).python_models.runtime, 'duckdb');
  } finally { process.env.MCP_PYTHON_MODELS = saved; }
});

// ── The frame: dbt.ref() exactly as the platform returns it, and the last step's return IS the
// result. No conversion, no projection written by the server — a function that needs pandas writes
// the platform's own call and owns the cost. That contract is proven by RUNNING a model: the DuckDB
// test calls relation-only methods (.filter/.project) on the frame it receives and reads the rows
// back, which only works if dbt.ref() arrived unconverted (test/integration/python-stage.test.js).
// What is checked HERE is the platform decision itself — which runtime a profile compiles for, and
// which packages that runtime may import.
test('python stage: the profile decides the runtime and what it may import', () => {
  const profileOf = (rt, config = {}) => frameProfile(rt, config);
  assert.equal(profileOf({ runtime: 'bigquery', method: 'bigframes' }).key, 'bigframes');
  assert.equal(profileOf({ runtime: 'bigquery', method: 'bigframes' }, { submission_method: 'serverless' }).key, 'pyspark', "the operator's submission wins");
  assert.equal(profileOf({ runtime: 'duckdb' }).key, 'duckdb');
  // the platform's own package is importable only where it exists
  assert.ok(importAllowlist({}, profileOf({ runtime: 'bigquery', method: 'bigframes' })).has('bigframes'));
  assert.ok(importAllowlist({}, profileOf({ runtime: 'databricks' })).has('pyspark'));
  assert.ok(!importAllowlist({}, profileOf({ runtime: 'databricks' })).has('bigframes'));
  assert.ok(importAllowlist({}, profileOf({ runtime: 'snowflake' })).has('snowflake'));
  assert.ok(!importAllowlist({}).has('bigframes'), 'no platform package without a runtime');
  // and the compiled model records the runtime it was compiled for
  const compiled = compilePythonStage(
    { stage: 'python', functions: [{ name: 'f', params: ['df'], body: ['return df'] }], steps: [{ call: 'f' }] },
    { modelName: 'm', inputModel: 'm_prep', allow: importAllowlist({}, profileOf({ runtime: 'bigquery', method: 'bigframes' })), profile: profileOf({ runtime: 'bigquery', method: 'bigframes' }) },
  );
  assert.equal(compiled.runtime, 'bigframes');
});

test('python stage: the schema names THIS warehouse\'s frame — and there is no frame switch to flip', () => {
  const DUCK = fileURLToPath(new URL('../integration/fixtures/duckdb_project', import.meta.url));
  const saved = process.env.MCP_PYTHON_MODELS; delete process.env.MCP_PYTHON_MODELS;
  try {
    const c = loadCatalog(CATALOG, { profilesDir: DUCK, projectDir: DUCK });
    const e = new Engine({ catalog: c, contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'pystage-')) }), pythonBin: PY });
    const py = e.schemas.build_native_model.properties.stage.oneOf.find((st) => st.properties.stage.enum?.[0] === 'python');
    assert.equal(py.properties.frame, undefined, 'no frame option');
    assert.match(py.description, /DuckDBPyRelation/);
    assert.match(py.description, /converting to pandas is a deliberate, single-node choice you make inside a function, never done for you/);
    assert.ok(py.properties.imports.items.properties.package.enum.includes('duckdb'));
  } finally { process.env.MCP_PYTHON_MODELS = saved; }
});

// The stage's description carries the PLATFORM's own rules: the in-engine ML library and the
// do/don't list that keeps the work in the warehouse — only the rules of THIS warehouse.
test('python stage: descriptions name this platform\'s in-engine ML library and rules (BigFrames → bigframes.ml, never sklearn)', () => {
  const bq = frameProfile({ runtime: 'bigquery', method: 'bigframes' });
  assert.match(bq.ml, /bigframes\.ml\.cluster\.KMeans/);
  assert.match(bq.guide, /NEVER sklearn/);
  assert.match(bq.guide, /stay in COLUMN EXPRESSIONS/);
  assert.match(bq.guide, /apply\/map/);
  assert.match(bq.guide, /THE RIGHT FORM PER OPERATION/, 'the right form for each operation is in the description itself');
  // the guide names the FAILURE, not just the property: unordered head/tail raises, it does not
  // quietly return an arbitrary slice
  assert.match(bq.guide, /ordering_mode="partial"/);
  assert.match(bq.guide, /OrderRequiredError/);
  const spark = frameProfile({ runtime: 'databricks' });
  assert.match(spark.ml, /pyspark\.ml/);
  assert.ok(!spark.guide.includes('bigframes'), 'no BigFrames rules on Spark');
  const snow = frameProfile({ runtime: 'snowflake' });
  assert.match(snow.ml, /snowflake\.ml\.modeling/);
  // and they land in the live schema for a BigQuery bigframes profile
  const dir = mkdtempSync(join(tmpdir(), 'bqprof-'));
  writeFileSync(join(dir, 'profiles.yml'), 'p:\n  target: dev\n  outputs:\n    dev:\n      type: bigquery\n      project: x\n      submission_method: bigframes\n      gcs_bucket: b\n      compute_region: us-central1\n');
  const saved = process.env.MCP_PYTHON_MODELS; delete process.env.MCP_PYTHON_MODELS;
  try {
    const c = loadCatalog(CATALOG, { profilesDir: dir, dialect: 'bigquery' });
    const e = new Engine({ catalog: c, contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'pystage-')) }), pythonBin: PY });
    const py = e.schemas.build_native_model.properties.stage.oneOf.find((st) => st.properties.stage.enum?.[0] === 'python');
    assert.match(py.description, /MODELLING: bigframes\.ml/);
    assert.match(py.description, /RULES FOR BIGFRAMES/);
    assert.match(py.properties.functions.items.properties.body.description, /Modelling: bigframes\.ml/);
    assert.match(py.properties.functions.items.properties.body.description, /converts itself with df\.to_pandas\(\)/);
    assert.match(py.properties.imports.items.properties.package.description, /prefer bigframes \(bigframes\.ml\) over sklearn/);
    assert.ok(!py.description.includes('PYSPARK') && !py.description.includes('SNOWPARK'), 'only this platform\'s rules');
  } finally { process.env.MCP_PYTHON_MODELS = saved; }
});

// dbt's adapter and this server's SQL writer read the SAME profile and can disagree: dbt connects
// with duckdb (and runs Python models there) while no SQL dialect is written for it, so pipelines
// are rendered in another dialect's syntax against it. That is a fact about the deployment — it is
// reported, not assumed away.
test('an adapter with no SQL dialect of its own is reported, not silently rendered as another', async () => {
  const DUCK = fileURLToPath(new URL('../integration/fixtures/duckdb_project', import.meta.url));
  const saved = process.env.WAREHOUSE_DIALECT; delete process.env.WAREHOUSE_DIALECT;
  try {
    const catalog = loadCatalog(CATALOG, { profilesDir: DUCK, projectDir: DUCK });
    assert.equal(catalog.dialect, 'postgres', 'SQL is written in a dialect this server knows');
    assert.deepEqual(catalog.dialectFallback, { profile_type: 'duckdb', rendering_as: 'postgres', explicit: false });
    const e = new Engine({ catalog, contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'dialect-')) }), pythonBin: PY });
    const overview = await e.semantic_index({});
    assert.match(overview.dialect_note || '', /duckdb.*rendered as postgres SQL/);
    // and a profile the server DOES write SQL for says nothing
    const PG = fileURLToPath(new URL('../integration/fixtures/dbt_project', import.meta.url));
    const pg = loadCatalog(CATALOG, { profilesDir: PG, projectDir: PG });
    assert.equal(pg.dialectFallback, null);
    assert.equal((await new Engine({ catalog: pg, contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'dialect-')) }) }).semantic_index({})).dialect_note, undefined);
  } finally { if (saved === undefined) delete process.env.WAREHOUSE_DIALECT; else process.env.WAREHOUSE_DIALECT = saved; }
});

// Every python stage of a chain is gated in ONE interpreter run, from the models the chain already
// compiled: a spawn per stage is pure request latency, and re-compiling a stage to gate it only
// repeats work. The error still names the stage's own model and the function inside it.
test('a chain with several python stages is gated in one run, and errors name the model', async (t) => {
  if (skipNoPy(t)) return;
  const e = engine();
  let runs = 0;
  const realSpawn = (await import('node:child_process')).spawn;
  assert.ok(realSpawn);
  const py = { ...PY_STAGE };
  const second = { stage: 'python', functions: [{ name: 'tag', params: ['df'], body: ["df['t'] = 1", 'return df'] }], steps: [{ call: 'tag' }], output: { columns: ['player_id_of_internal', 'revenue_z', 't'] } };
  // count the gate's interpreter runs by wrapping the engine's own gate entry point
  const gate = e._gateCompiled.bind(e);
  e._gateCompiled = async (units) => { if (units.length) runs += 1; return gate(units); };
  const ok = await e.register_native_model(decl({ dry_run: true, pipeline: { source: 'events', stages: [AGG, py, { stage: 'limit', n: 5 }, second] } }));
  assert.equal(ok.python.length, 2, 'two python models in the chain');
  assert.equal(runs, 1, 'gated in a single run');
  // and a body that is refused in the SECOND stage is reported against that stage's model
  const bad = { stage: 'python', functions: [{ name: 'tag', params: ['df'], body: ["df['t'] = getattr(df, 'x')", 'return df'] }], steps: [{ call: 'tag' }] };
  const err = await e.register_native_model(decl({ dry_run: true, pipeline: { source: 'events', stages: [AGG, py, { stage: 'limit', n: 5 }, bad] } })).catch((x) => x);
  assert.ok(err instanceof Error);
  assert.match(err.message, /pipe_seg: tag line 1 .*'getattr' is not available here/, 'the model whose body was refused is named (here the chain\'s last, which carries the pipeline name)');
});

// ── TWO RUNTIME TRAPS OF THE WAREHOUSE'S PYTHON RUNTIME ────────────────────────────────────
// Both were found by running models, and neither fails in parsing: they fail minutes later, in a
// notebook runtime whose output the author never sees. So both are answered BEFORE submission.

// (1) `dbt.source(...)[["col"]]` — a subscript directly on the call breaks dbt's own AST scan, the
// dependency never reaches the manifest, and the notebook dies with KeyError: 'bi.player_installs'.
// Here it cannot be written at all: a step body sees only its own names, so `dbt` and `session`
// are not readable, and the ONE dbt.ref the model needs is written by the server on its own line.
test('a step body cannot reach dbt or session at all (so no subscript-on-call can break the manifest)', async (t) => {
  if (skipNoPy(t)) return;
  const sub = await runAstGate(PY, [{ name: 'f', params: ['df'], body: 'x = dbt.source("bi","player_installs")[["col"]]\nreturn x' }]);
  assert.equal(sub.ok, false);
  assert.match(sub.errors[0].message, /'dbt' is not available here/);
  const sess = await runAstGate(PY, [{ name: 'f', params: ['df'], body: 'return session.table("x")' }]);
  assert.equal(sess.ok, false);
  assert.match(sess.errors[0].message, /'session' is not available here/);
});

// The two things dbt's BigFrames wrapper takes away — row order and the index — are RULES, not
// refusals: what a given line does on a runtime depends on how the code is written, so they are
// stated where the author reads them before writing (the stage description), and the failure they
// cause is explained when it happens. This pins that they are actually in that description.
test('the BigFrames rules state both runtime traps and the form that works', () => {
  const { guide } = frameProfile({ runtime: 'bigquery', method: 'bigframes' }, {});
  // no row order → head()/tail() need an explicit sort
  assert.match(guide, /ordering_mode="partial"/);
  assert.match(guide, /OrderRequiredError/);
  assert.match(guide, /sort_values/);
  // no index → an alignment raises, and the form that works is a merge
  assert.match(guide, /NO INDEX/);
  assert.match(guide, /NullIndexError/);
  assert.match(guide, /merge/);
  assert.match(guide, /set_index/);
  assert.ok(!/Series\.map with a dict/.test(guide), 'and the form that raises is not recommended');
  // the runtimes whose frames carry both say none of it
  for (const rt of [{ runtime: 'snowflake' }, { runtime: 'duckdb' }, { runtime: 'bigquery', method: 'cluster' }]) {
    assert.ok(!/NullIndexError|ordering_mode/.test(frameProfile(rt, {}).guide), JSON.stringify(rt));
  }
});

// A failure only the warehouse can produce arrives with what the error CLASS means on this runtime
// — a fact about the runtime, not a diagnosis of the author's code (we cannot know from here which
// line raised it). Keyed off what the runtime declares, so a runtime without such rules stays silent.
test('a run failure explains the runtime behind the error class, without prescribing a rewrite', () => {
  const bq = frameProfile({ runtime: 'bigquery', method: 'bigframes' }, {});
  const duck = frameProfile({ runtime: 'duckdb' }, {});
  const log = 'Compilation Error in model pipe_seg_ab12\n  NullIndexError: Cannot implicitly align objects. Please set an index using set_index.';
  const hints = pythonRunHints(bq, log);
  assert.equal(hints.length, 1);
  assert.match(hints[0], /NO INDEX/);
  assert.match(hints[0], /^About this runtime:/, 'it states what the runtime is like…');
  assert.ok(!/\b(Put|Express|Wrap|Use|Rewrite)\b/.test(hints[0]), '…and does not prescribe a rewrite it cannot know is the right one');
  assert.deepEqual(pythonRunHints(duck, log), [], 'a runtime whose frames carry an index says nothing');
  assert.match(pythonRunHints(bq, 'OrderRequiredError: the frame is not ordered')[0], /no row order/);
  assert.deepEqual(pythonRunHints(bq, 'Database Error: syntax error at or near "selct"'), [], 'an ordinary SQL failure is left alone');
});

// The cookbook is served THROUGH the tools — semantic_index({ guide: 'python' }) — so the examples
// reach the model on demand instead of bloating every tool description. It is per RUNTIME: the
// deployment's own profile decides which one (or none).
test('the python authoring guide is served for this deployment\'s runtime, with examples', async (t) => {
  if (skipNoPy(t)) return;
  const catalog = loadCatalog(CATALOG, {});
  catalog.pythonRuntime = { available: true, runtime: 'bigquery', config: {}, packages: '' };
  const e = new Engine({ catalog, contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'pyguide-')) }), pythonBin: PY });

  const g = await e.semantic_index({ guide: 'python' });
  assert.equal(g.runtime, 'bigframes');
  assert.ok(g.rules.length >= 5 && g.examples.length >= 10, 'constraints and a worked example per task');
  // every example says what to do, and the ones that replace a trap say what it replaces and why
  for (const ex of g.examples) {
    assert.ok(ex.task && Array.isArray(ex.do) && ex.do.length, JSON.stringify(ex));
    if (ex.avoid) assert.ok(ex.why, `${ex.task}: an 'avoid' without a 'why' teaches nothing`);
  }
  // the traps this runtime actually has are covered by an example, not only by prose
  const text = JSON.stringify(g);
  for (const needle of ['merge', 'peek', 'sort_values', 'groupby', 'cache()', 'bigframes.ml', 'sql_scalar', 'to_pandas']) {
    assert.ok(text.includes(needle), `the guide covers ${needle}`);
  }
  // …and the stage description points at it rather than repeating it
  assert.match(frameProfile(catalog.pythonRuntime, {}).guide, /semantic_index\(\{ guide: "python" \}\)/);

  // a deployment that runs no python models says so instead of showing another runtime's guide
  const plain = loadCatalog(CATALOG, {});
  plain.pythonRuntime = { available: false, reason: 'no runtime' };
  const e2 = new Engine({ catalog: plain, contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'pyguide2-')) }) });
  const none = await e2.semantic_index({ guide: 'python' });
  assert.match(none.note, /runs no python models/);
  assert.equal(none.examples, undefined);
});

// The rules must be IN the stage description — the agent sees it without fetching anything — and
// they are rendered from the same data as the full guide, so the two cannot drift.
test('the stage description itself carries the runtime rules and the right form per task', async (t) => {
  if (skipNoPy(t)) return;
  const catalog = loadCatalog(CATALOG, {});
  catalog.pythonRuntime = { available: true, runtime: 'bigquery', config: {}, packages: '' };
  const e = new Engine({ catalog, contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'pydesc-')) }), pythonBin: PY });
  const py = e.schemas.build_native_model.properties.stage.oneOf.find((b) => b.properties?.stage?.enum?.[0] === 'python');

  // every rule of the guide is represented in the description…
  const guide = await e.semantic_index({ guide: 'python' });
  for (const r of guide.rules) assert.ok(py.description.includes(r.short), `rule missing from the description: ${r.short.slice(0, 40)}…`);
  // …and so is the right form for every task the guide has an example for
  for (const ex of guide.examples) assert.ok(py.description.includes(ex.line), `form missing from the description: ${ex.line.slice(0, 40)}…`);
  // the declaration form the caller actually writes is there too
  assert.match(py.description, /you declare `imports`/);
  assert.match(py.description, /submission_method="bigframes"/);
  // the BODY description does not repeat it — one copy per tool surface
  const body = py.properties.functions.items.properties.body.description;
  assert.ok(!body.includes('THE RIGHT FORM PER TASK'), 'the rules live in one place');
  assert.match(body, /RULES for this runtime — and the right form for each task — are on the stage description/);
});

// A worked recipe beats prose, so the stage DESCRIPTION is an INDEX of them rather than a manual:
// each id with the move it covers and an instruction to study them, because the caller has to know
// they exist BEFORE writing the first function. Wired from the deployment's own recipe file — a
// deployment that ships none has nothing to point at, so its description keeps carrying the forms
// itself (checked at the end).
//
// They are per APPROACH, not per business task: each one is the correct form of a single move on
// the frame (a lookup, a per-group value, a top-N, a threshold, a prediction), so a real question
// is assembled from several. Hence every id must be reachable WITH its move named — a caller that
// can only find the one nearest its wording would miss the others its function needs.
test('the stage description and the guide send the caller to this deployment\'s python recipes', async (t) => {
  if (skipNoPy(t)) return;
  const { loadRecipes } = await import('../../src/recipes.js');
  const recipes = loadRecipes(fileURLToPath(new URL('../../config/recipes.json', import.meta.url)));
  const ids = recipes.idsRequiring('python_models');
  assert.ok(ids.length >= 3, 'the shipped recipes cover the frame approaches of this runtime');

  const catalog = loadCatalog(CATALOG, {});
  catalog.pythonRuntime = { available: true, runtime: 'bigquery', config: {}, packages: '' };
  const e = new Engine({ catalog, contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'pyrec-')) }), recipes, pythonBin: PY });

  const py = e.schemas.build_native_model.properties.stage.oneOf.find((b) => b.properties?.stage?.enum?.[0] === 'python');
  assert.match(py.description, /STUDY THE RECIPES FIRST/, 'the description INSISTS on reading them');
  const entries = recipes.entriesRequiring('python_models');
  for (const { id, title } of entries) {
    assert.ok(py.description.includes(id), `recipe ${id} is not named in the stage description`);
    assert.ok(py.description.includes(title), `recipe ${id} is named without its move (${title}) — the caller cannot tell which one it needs`);
  }
  assert.match(py.description, /semantic_index\(\{ recipe: "<id>" \}\)/, 'and the description says HOW to fetch one');
  // …and it is an INDEX, not a manual: the per-operation code forms live in the recipes and the
  // full guide now, so the description no longer repeats them (that is what makes it shorter).
  assert.ok(!py.description.includes('THE RIGHT FORM PER OPERATION'), 'the forms are in the recipes, not inlined here');
  // what it still carries itself: why this runtime bites, and where the reasoning lives
  assert.match(py.description, /NullIndexError/);
  assert.match(py.description, /OrderRequiredError/);
  assert.match(py.description, /semantic_index\(\{ guide: "python" \}\)/);

  const g = await e.semantic_index({ guide: 'python' });
  assert.deepEqual(g.recipes.ids, ids);
  assert.deepEqual(g.recipes.moves, entries.map((r) => `${r.id}: ${r.title}`), 'the guide names the move behind every id too');
  assert.match(g.recipes.fetch, /semantic_index\(\{ recipe: '/);
  assert.match(g.read_next, /STUDY THE RECIPES BEFORE YOU WRITE/);
  assert.match(g.recipes.note, /STUDY THESE BEFORE WRITING A FUNCTION/);

  // every one of them is fetchable and carries what makes it adaptable
  for (const id of ids) {
    const r = await e.semantic_index({ recipe: id });
    const body = r.recipe || r;
    assert.ok(body.register_payload?.pipeline?.stages?.some((st) => st.stage === 'python'), `${id} must contain a python stage`);
    assert.ok(body.hack && body.notes && body.read_first, `${id} must carry the technique, the caveats and the read-first pointer`);
  }

  // a deployment with no python recipes says nothing about them
  const bare = loadCatalog(CATALOG, {});
  bare.pythonRuntime = { available: true, runtime: 'bigquery', config: {}, packages: '' };
  const e2 = new Engine({ catalog: bare, contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'pyrec2-')) }), pythonBin: PY });
  const py2 = e2.schemas.build_native_model.properties.stage.oneOf.find((b) => b.properties?.stage?.enum?.[0] === 'python');
  assert.ok(!py2.description.includes('STUDY THE RECIPES FIRST'));
  for (const { id } of entries) assert.ok(!py2.description.includes(id), 'no recipe of another deployment is advertised');
  // …and with nothing to point at, the description carries the forms itself instead of dropping them
  assert.match(py2.description, /THE RIGHT FORM PER OPERATION/);
  assert.ok(py2.description.length > py.description.length, 'pointing at recipes is what makes the description shorter');
});

// A python stage at the size a real analysis reaches — six functions, ~150 lines, nested blocks —
// went in as `step 2: unknown pipeline stage: undefined`, which reads like a schema problem and
// sent the caller to shrink the payload. The schema's own limits (30 functions, 400 body lines per
// function, 500 chars per line, 50 steps, 20 imports) are nowhere near that, so a payload this size
// must simply pass: through add_step, through add_steps, and through the all-at-once register.
// Whatever produced that message, it was not a limit here, and this test is what would catch it
// becoming one.
test('a python stage of six functions / ~150 lines is accepted by every entry point', async (t) => {
  if (skipNoPy(t)) return;
  const line = (n) => `df["c${n}"] = df["revenue"] * ${n}`;
  const fn = (i) => ({
    name: `step_${i}`,
    params: ['df', 'column'],
    body: [
      `# stage ${i}: a block with nesting, a loop and a branch`,
      'total = df[column].sum()',
      'if total > 0:',
      [
        'df["share"] = df[column] / total',
        'for k in range(3):',
        [
          'if k > 1:',
          [line(i * 10 + 1)],
          'else:',
          [line(i * 10 + 2)],
        ],
      ],
      'else:',
      ['df["share"] = 0'],
      ...Array.from({ length: 22 }, (_, j) => line(i * 100 + j)),
      'return df',
    ],
  });
  const functions = [1, 2, 3, 4, 5, 6].map(fn);
  const count = (block) => block.reduce((n, item) => n + (Array.isArray(item) ? count(item) : 1), 0);
  const lines = functions.reduce((n, f) => n + count(f.body), 0);
  assert.ok(lines >= 150, `the payload must be at the reported size (got ~${lines} lines)`);
  const big = {
    stage: 'python',
    imports: [{ package: 'numpy', as: 'np' }],
    functions,
    steps: functions.map((f) => ({ call: f.name, args: { column: 'revenue' } })),
    output: { columns: ['player_id_of_internal', 'revenue', 'share'] },
  };

  // 1. incrementally: the aggregate, then the big stage
  const e = engine();
  const s = await e.build_native_model({ action: 'start', name: 'bigpy', source: 'events' });
  await e.build_native_model({ action: 'add_step', draft_id: s.draft_id, stage: AGG });
  const added = await e.build_native_model({ action: 'add_step', draft_id: s.draft_id, stage: big });
  assert.equal(added.step?.stage, 'python', JSON.stringify(added.error || added).slice(0, 300));

  // 2. both stages at once
  const e2 = engine();
  const s2 = await e2.build_native_model({ action: 'start', name: 'bigpy2', source: 'events' });
  const many = await e2.build_native_model({ action: 'add_steps', draft_id: s2.draft_id, stages: [AGG, big] });
  assert.equal(many.added, 2, JSON.stringify(many.error || many).slice(0, 300));

  // 3. all-at-once registration: renders the whole chain (python model + its SQL prep)
  const dry = await engine().register_native_model({ name: 'bigpy3', dry_run: true, pipeline: { source: 'events', stages: [AGG, big] } });
  assert.equal(dry.dry_run, true, JSON.stringify(dry.error || {}).slice(0, 300));
  assert.equal(dry.python?.length, 1, 'one python model in the chain');
});

// WHAT BELONGS IN A PYTHON STAGE AT ALL. Everything SQL can compute is computed in SQL — including
// the preparation of the table the analysis reads — so a python stage with nothing in front of it
// hands the raw source to a runtime that is slower, costlier and full of its own limits. The server
// says so, and only says so: the shape is legitimate when the analysis really is per source row
// (a model scoring every event), and from here there is no way to tell those apart.
test('a python stage with no preparation before it is told so; one after an SQL stage is not', async (t) => {
  if (skipNoPy(t)) return;
  const nudge = (res) => (res.recommendations || res.warnings || []).filter((w) => /reads .* as it is/.test(w));

  // 1. python FIRST, on the raw source → the nudge, and it names what belongs in SQL
  const e = engine();
  const raw = await e.build_native_model({ action: 'start', name: 'raw_py', source: 'events' });
  const added = await e.build_native_model({ action: 'add_step', draft_id: raw.draft_id, stage: PY_STAGE });
  const [said] = nudge(added);
  assert.ok(said, `expected the preparation nudge, got: ${JSON.stringify(added.recommendations || [])}`);
  assert.match(said, /'events'/, 'it names the source being read raw');
  assert.match(said, /aggregating to the grain/, 'and what belongs in a stage before it');
  assert.match(said, /device_time/, 'including the time column of that source');
  assert.match(said, /nothing to change/, 'and it stays a recommendation, not a verdict');

  // 2. the same stage after an aggregate → nothing to say
  const prepared = await e.build_native_model({ action: 'start', name: 'prep_py', source: 'events' });
  await e.build_native_model({ action: 'add_step', draft_id: prepared.draft_id, stage: AGG });
  const after = await e.build_native_model({ action: 'add_step', draft_id: prepared.draft_id, stage: PY_STAGE });
  assert.deepEqual(nudge(after), [], 'an aggregate before the stage IS the preparation');

  // 3. a where alone counts too — narrowing is preparation
  const scoped = await e.build_native_model({ action: 'start', name: 'scoped_py', source: 'events' });
  await e.build_native_model({ action: 'add_step', draft_id: scoped.draft_id, stage: { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] } });
  await e.build_native_model({ action: 'add_step', draft_id: scoped.draft_id, stage: AGG });
  const scopedPy = await e.build_native_model({ action: 'add_step', draft_id: scoped.draft_id, stage: PY_STAGE });
  assert.deepEqual(nudge(scopedPy), []);

  // 4. the all-at-once path says the same thing (a recipe payload, a hand-written one)
  const dry = await engine().register_native_model({ name: 'raw_py2', dry_run: true, pipeline: { source: 'events', stages: [PY_STAGE] } });
  assert.ok(nudge(dry).length === 1, `register should nudge too: ${JSON.stringify(dry.warnings || [])}`);
  // …and a pipeline-level time_range is preparation: it is a leading WHERE on the source's time
  const windowed = await engine().register_native_model({
    name: 'raw_py3', dry_run: true,
    pipeline: { source: 'events', time_range: { start: '2026-01-01', end: '2026-01-05' }, stages: [PY_STAGE] },
  });
  assert.deepEqual(nudge(windowed), []);
});

// The rule has to reach the caller BEFORE it writes anything, so it is in the stage description and
// in the guide — not only in the response to a stage already written.
test('the SQL-vs-python division of labour is in the stage description and the guide', async (t) => {
  if (skipNoPy(t)) return;
  const catalog = loadCatalog(CATALOG, {});
  catalog.pythonRuntime = { available: true, runtime: 'bigquery', config: {}, packages: '' };
  const e = new Engine({ catalog, contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'sqlfirst-')) }), pythonBin: PY });
  const py = e.schemas.build_native_model.properties.stage.oneOf.find((b) => b.properties?.stage?.enum?.[0] === 'python')
    || e.schemas.build_native_model.properties.stage.anyOf?.find((b) => b.properties?.stage?.enum?.[0] === 'python');
  assert.match(py.description, /WHAT BELONGS HERE/);
  assert.match(py.description, /PREPARING the table this analysis reads/);
  assert.match(py.description, /never the raw source/);

  const g = await e.semantic_index({ guide: 'python' });
  const first = g.rules[0];
  assert.match(first.rule, /ONLY what SQL cannot say/, 'it is the FIRST rule, before the runtime traps');
  assert.match(first.why, /COST AND EXACTNESS|READABILITY/, 'and it says why, so it does not read as taste');
  // the routing triggers say it too, for the caller that never opens the python guide
  const routing = JSON.stringify((await e.semantic_index({ guide: true })).routing_triggers);
  assert.match(routing, /computed in SQL/);
});

// The nudge has to be TRUE, not just well-meant. Two shapes it used to lie about: a python stage
// that follows another python stage (it reads THAT model's table, not the source), and a pipeline
// rendered from a materialized prefix (its first stage reads the built table). Both were reported
// as "reads 'events' as it is".
test('the preparation nudge does not fire where the stage reads a table rather than the source', () => {
  const e = engine();
  const nudges = (stages, opts) => e._stageWarnings('events', stages, opts).filter((w) => /as it is/.test(w));

  // one python stage on the raw source: the one case the nudge is for
  assert.equal(nudges([PY_STAGE]).length, 1);
  // a SECOND python stage after it reads the first one's table — it is not the source any more
  assert.equal(nudges([PY_STAGE, PY_STAGE]).length, 1, 'only the first stage may be nudged');
  // …and the one that is nudged is the FIRST one
  assert.match(e._stageWarnings('events', [PY_STAGE, PY_STAGE]).find((w) => /as it is/.test(w)), /'events'/);
  // a pipeline continued from a materialized prefix starts at a built table: nothing to say
  assert.deepEqual(nudges([PY_STAGE], { startsFromTable: true }), []);
  assert.deepEqual(nudges([PY_STAGE, PY_STAGE], { startsFromTable: true }), []);
  // a time_range is preparation (a leading WHERE on the source's time column)
  assert.deepEqual(nudges([PY_STAGE], { timeRange: { start: '2026-01-01' } }), []);
});
