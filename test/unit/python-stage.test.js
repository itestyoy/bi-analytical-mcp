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
import { pyLiteral, importAllowlist, frameProfile, compilePythonStage } from '../../src/python-model.js';

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
  assert.equal(r.python.prep_model, `${r.model}_prep`);
  assert.deepEqual(r.python.packages, [], 'numpy ships with the runtime → nothing for dbt to install');
  assert.deepEqual(r.python.steps, ['zscore']);
  assert.deepEqual(r.columns, ['player_id_of_internal', 'revenue', 'revenue_z'], 'the declared output columns are the pipeline\'s columns');
  assert.ok(r.assumptions.some((a) => /view was requested/.test(a)));
  // files: the SQL prep model, the Python model and its YAML sidecar — and NO pipe_seg_<ctx>.sql
  const files = pipeFiles(e, r.context_id);
  assert.deepEqual(files, [`${r.model}.py`, `${r.model}.yml`, `${r.model}_prep.sql`]);
  // the context records the split
  const n = e.ctxs.get(r.context_id).state.native;
  assert.equal(n.model, r.model);
  assert.equal(n.python.prep_model, `${r.model}_prep`);
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

test('python stage must be the LAST stage', async () => {
  const e = engine();
  await assert.rejects(() => e.register_native_model({ name: 'seg', pipeline: { source: 'events', stages: [AGG, PY_STAGE, { stage: 'limit', n: 10 }] } }), /python.*must be the LAST stage.*limit/);
});

test('python stage: the allowed packages are an ENUM in the tool schema; anything else is refused by the schema', async () => {
  const e = engine();
  const items = e.schemas.register_native_model.properties.pipeline.properties.stages.items.oneOf.find((s) => s.properties.stage.const === 'python');
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
  assert.match(err.message, /bad line 2 \(x = eval\('1'\)\): call to 'eval\(\)'/);
  assert.match(err.message, /bad line 3 .*: 'dbt' is not reachable/);
  assert.match(err.message, /bad line 4 .*: dunder attribute '__class__'/);
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
  assert.deepEqual(r.python.packages, ['scikit-learn', 'scipy']);
  assert.equal(r.materialized, 'table');
  assert.equal(ctxs.list().length, 0, 'dry_run writes nothing');
});

test('incremental builder: add_step python → columns, nothing may follow, preview carries the model, materialize writes the split', async (t) => {
  if (skipNoPy(t)) return;
  const e = engine();
  const s = await e.build_native_model({ action: 'start', name: 'seg', source: 'events' });
  await e.build_native_model({ action: 'add_step', draft_id: s.draft_id, stage: AGG });
  const p = await e.build_native_model({ action: 'add_step', draft_id: s.draft_id, stage: PY_STAGE });
  assert.deepEqual(p.columns_added.map((c) => c.name), ['revenue_z']);
  await assert.rejects(() => e.build_native_model({ action: 'add_step', draft_id: s.draft_id, stage: { stage: 'limit', n: 5 } }), /must be the LAST stage/);
  const pv = await e.build_native_model({ action: 'preview', draft_id: s.draft_id });
  assert.equal(pv.python.prep_model, `pipe_seg_${s.draft_id}_prep`);
  assert.equal(pv.python.model, `pipe_seg_${s.draft_id}`);
  assert.deepEqual(pv.available_columns.map((c) => c.name), ['player_id_of_internal', 'revenue', 'revenue_z']);
  const m = await e.build_native_model({ action: 'materialize', draft_id: s.draft_id });
  assert.equal(m.model, `pipe_seg_${s.draft_id}`);
  assert.deepEqual(pipeFiles(e, s.draft_id), [`${m.model}.py`, `${m.model}.yml`, `${m.model}_prep.sql`]);
});

// The body is STRUCTURE: nesting is indentation, so the shape itself has to be valid Python shape.
test('python stage: body structure — nesting is indentation, headers open blocks, no spaces-as-indent', async (t) => {
  if (skipNoPy(t)) return;
  const e = engine();
  const withBody = (body) => e.register_native_model(decl({ dry_run: true, pipeline: { source: 'events', stages: [AGG, { ...PY_STAGE, functions: [{ name: 'f', params: ['df', 'k'], body }], steps: [{ call: 'f', args: { k: 2 } }] }] } }));
  // a real nested body renders as indented Python the gate accepts
  const ok = await withBody(['if k > 1:', ["df['seg'] = 1", 'for c in df.columns:', ['df[c] = df[c]']], 'else:', ["df['seg'] = 0"], 'return df']);
  assert.equal(ok.dry_run, true);
  assert.ok(ok.python.code.includes("\n    if k > 1:\n        df['seg'] = 1\n        for c in df.columns:\n            df[c] = df[c]\n    else:\n        df['seg'] = 0\n    return df\n"), 'each nesting level is one indentation level');
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
    const py = stages.find((st) => st.properties.stage.const === 'python');
    assert.equal(py.properties.functions.items.properties.body.$ref, '#/$defs/py_block');
  }
  // twelve levels deep validates and renders — deeper than any unrolled schema allowed
  const deep = (n) => (n === 0 ? ['return df'] : [`if k > ${n}:`, deep(n - 1), 'else:', ['return df']]);
  const r = await e.register_native_model(decl({ dry_run: true, pipeline: { source: 'events', stages: [AGG, { ...PY_STAGE, functions: [{ name: 'f', params: ['df', 'k'], body: deep(12) }], steps: [{ call: 'f', args: { k: 1 } }] }] } }));
  assert.equal(r.dry_run, true);
  assert.ok(r.python.code.includes(`${'    '.repeat(13)}return df`), 'level 12 rendered with 13 indents (function body = 1)');
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
  assert.deepEqual(resolvePythonRuntime({ profilesDir: DUCK, projectDir: DUCK, env: noEnv }), { available: true, runtime: 'duckdb' });
  assert.equal(resolvePythonRuntime({ profilesDir: PG, projectDir: PG, env: { MCP_PYTHON_MODELS: 'on' } }).available, true, 'the operator may force it on');
  assert.equal(resolvePythonRuntime({ profilesDir: DUCK, projectDir: DUCK, env: { MCP_PYTHON_MODELS: 'off' } }).available, false, '…or off');
  assert.equal(resolvePythonRuntime({ profilesDir: '/nonexistent', env: noEnv }).available, false);
  // a BigQuery profile: only with a submission set up
  const bq = (out) => { const dir = mkdtempSync(join(tmpdir(), 'bqprof-')); writeFileSync(join(dir, 'profiles.yml'), `p:\n  target: dev\n  outputs:\n    dev:\n      type: bigquery\n${Object.entries(out).map(([k, v]) => `      ${k}: ${v}`).join('\n')}\n`); return resolvePythonRuntime({ profilesDir: dir, env: noEnv }); };
  assert.equal(bq({ project: 'x' }).available, false);
  assert.match(bq({ project: 'x' }).reason, /submission_method \(bigframes \| serverless \| cluster\)/);
  assert.deepEqual(bq({ project: 'x', submission_method: 'bigframes', gcs_bucket: 'b', compute_region: 'us-central1' }), { available: true, runtime: 'bigquery', method: 'bigframes' });
  assert.deepEqual(bq({ project: 'x', gcs_bucket: 'b', dataproc_region: 'us-central1' }), { available: true, runtime: 'bigquery', method: 'serverless' });
  // and what the tools show: with the postgres profile the stage is ABSENT from the schemas…
  const saved = process.env.MCP_PYTHON_MODELS; delete process.env.MCP_PYTHON_MODELS;
  try {
    const cPg = loadCatalog(CATALOG, { profilesDir: PG, projectDir: PG });
    assert.equal(cPg.pythonRuntime.available, false);
    const ePg = new Engine({ catalog: cPg, contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'pystage-')) }), pythonBin: PY });
    const stagesPg = ePg.schemas.build_native_model.properties.stage.oneOf.map((st) => st.properties.stage.const);
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
    assert.ok(eDuck.schemas.build_native_model.properties.stage.oneOf.some((st) => st.properties.stage.const === 'python'));
    assert.ok(eDuck.schemas.build_native_model.$defs.py_block);
    assert.deepEqual((await eDuck.semantic_index({})).python_models.runtime, 'duckdb');
  } finally { process.env.MCP_PYTHON_MODELS = saved; }
});

// ── The frame: dbt.ref() as the platform returns it by default; pandas only on request, spelled
// per platform exactly as dbt's docs do. No helper that probes for a conversion method.
test('python stage: native frame by default — dbt.ref() is used as returned; pandas is an explicit per-platform conversion', () => {
  const ALLOW = importAllowlist({});
  const stage = { stage: 'python', functions: [{ name: 'f', params: ['df'], body: ['return df'] }], steps: [{ call: 'f' }], output: { columns: ['a', 'b'] } };
  const compile = (rt, over = {}, config = {}) => compilePythonStage({ ...stage, ...over }, { modelName: 'm', prepModel: 'm_prep', allow: importAllowlist({}, frameProfile(rt, config)), config, profile: frameProfile(rt, config) });
  // BigFrames: native = the pandas API inside BigQuery → pandas-style projection, no conversion
  let c = compile({ runtime: 'bigquery', method: 'bigframes' });
  assert.ok(c.code.includes('\n    df = dbt.ref("m_prep")\n'), 'ref used as is');
  assert.ok(!c.code.includes('_frame') && !c.code.includes('import pandas'), 'no conversion helper, no pandas import');
  assert.ok(c.code.includes('    return df[["a", "b"]]'));
  assert.equal(c.runtime, 'bigframes');
  // …and pandas on request → .to_pandas()
  c = compile({ runtime: 'bigquery', method: 'bigframes' }, { frame: 'pandas' });
  assert.ok(c.code.includes('\n    df = dbt.ref("m_prep").to_pandas()\n'));
  assert.ok(c.code.includes('import pandas as pd'));
  // Dataproc / Databricks: PySpark — .select() for native, pandas-on-Spark for pandas
  c = compile({ runtime: 'bigquery', method: 'serverless' });
  assert.ok(c.code.includes('    return df.select("a", "b")'));
  c = compile({ runtime: 'databricks' }, { frame: 'pandas' });
  assert.ok(c.code.includes('.pandas_api()'));
  // Snowpark
  c = compile({ runtime: 'snowflake' }, { frame: 'pandas' });
  assert.ok(c.code.includes('dbt.ref("m_prep").to_pandas()'));
  assert.ok(c.code.includes('return df[["a", "b"]]'), 'a pandas frame is projected pandas-style');
  c = compile({ runtime: 'snowflake' });
  assert.ok(c.code.includes('return df.select("a", "b")'));
  // DuckDB
  c = compile({ runtime: 'duckdb' }, { frame: 'pandas' });
  assert.ok(c.code.includes('dbt.ref("m_prep").df()'));
  // the operator's per-model submission method decides the BigQuery profile too
  assert.equal(frameProfile({ runtime: 'bigquery', method: 'bigframes' }, { submission_method: 'serverless' }).key, 'pyspark');
  // the platform's own package is importable only where it exists
  assert.ok(importAllowlist({}, frameProfile({ runtime: 'bigquery', method: 'bigframes' })).has('bigframes'));
  assert.ok(importAllowlist({}, frameProfile({ runtime: 'databricks' })).has('pyspark'));
  assert.ok(!importAllowlist({}, frameProfile({ runtime: 'databricks' })).has('bigframes'));
  assert.ok(importAllowlist({}, frameProfile({ runtime: 'snowflake' })).has('snowflake'));
  // an unknown runtime cannot write a pandas conversion → refused, native still works
  assert.throws(() => compile({ runtime: 'unknown' }, { frame: 'pandas' }), /frame: 'pandas' is not available/);
  assert.ok(compile({ runtime: 'unknown' }).code.includes('df = dbt.ref("m_prep")\n'));
  assert.deepEqual(ALLOW.has('bigframes'), false, 'no platform package without a runtime');
});

test('python stage: the schema describes THIS warehouse\'s frame and offers pandas only where it can be written', () => {
  const DUCK = fileURLToPath(new URL('../integration/fixtures/duckdb_project', import.meta.url));
  const saved = process.env.MCP_PYTHON_MODELS; delete process.env.MCP_PYTHON_MODELS;
  try {
    const c = loadCatalog(CATALOG, { profilesDir: DUCK, projectDir: DUCK });
    const e = new Engine({ catalog: c, contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'pystage-')) }), pythonBin: PY });
    const py = e.schemas.build_native_model.properties.stage.oneOf.find((st) => st.properties.stage.const === 'python');
    assert.deepEqual(py.properties.frame.enum, ['native', 'pandas']);
    assert.match(py.properties.frame.description, /DuckDBPyRelation/);
    assert.match(py.properties.frame.description, /\.df\(\)/);
    assert.ok(py.properties.imports.items.properties.package.enum.includes('duckdb'));
  } finally { process.env.MCP_PYTHON_MODELS = saved; }
  // forced on with no profile: the runtime is unknown → native only
  const e2 = engine();
  const py2 = e2.schemas.build_native_model.properties.stage.oneOf.find((st) => st.properties.stage.const === 'python');
  assert.deepEqual(py2.properties.frame.enum, ['native']);
});
