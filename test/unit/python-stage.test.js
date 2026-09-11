// The `python` pipeline stage: ONE declaration → two dbt models under the hood (the SQL stages as
// the prep TABLE, the stage as the dbt Python model that refs it). Allowed non-data checks: input
// validation (what the stage refuses, and why) and the context lifecycle (which files land where,
// what the context records). The rows the Python model produces are proven on a warehouse that
// runs dbt Python models (test/integration/python-stage.test.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { pyLiteral, importAllowlist } from '../../src/python-model.js';

const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));
const VENV_PY = join(process.cwd(), '.dbtvenv', 'bin', 'python');
const PY = existsSync(VENV_PY) ? VENV_PY : 'python3';
const HAS_PY = spawnSync(PY, ['--version']).status === 0;

const engine = () => {
  const ctxs = new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'pystage-')) });
  return new Engine({ catalog: loadCatalog(CATALOG, {}), contextManager: ctxs, pythonBin: PY });
};
const AGG = { stage: 'aggregate', group_by: ['player_id_of_internal'], measures: [{ name: 'n', fn: 'count' }, { name: 'revenue', fn: 'sum', column: 'price_in_usd_of_event_data' }] };
const ZSCORE = { name: 'zscore', params: ['df', 'column', 'as_'], body: "df[as_] = (df[column] - df[column].mean()) / df[column].std(ddof=0)\nreturn df" };
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
  await assert.rejects(() => e.register_native_model(decl({ pipeline: { source: 'events', stages: [AGG, { ...PY_STAGE, imports: [{ package: 'requests' }] }] } })), /package. must be one of: pandas, numpy, sklearn, scipy, statsmodels, bigframes/);
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
  const bad = { name: 'bad', params: ['df'], body: "import os\nx = eval('1')\ndf['t'] = dbt.this\nreturn df.__class__" };
  const err = await e.register_native_model(decl({ pipeline: { source: 'events', stages: [AGG, { ...PY_STAGE, functions: [bad], steps: [{ call: 'bad' }] }] } })).catch((x) => x);
  assert.ok(err instanceof Error);
  assert.match(err.message, /bad line 1: an import inside a function body/);
  assert.match(err.message, /bad line 2: call to 'eval\(\)'/);
  assert.match(err.message, /bad line 3: 'dbt' is not reachable/);
  assert.match(err.message, /bad line 4: dunder attribute '__class__'/);
  // a syntax error is caught here, not on the warehouse runtime
  const syn = { name: 'syn', params: ['df'], body: 'return df[' };
  await assert.rejects(() => e.register_native_model(decl({ pipeline: { source: 'events', stages: [AGG, { ...PY_STAGE, functions: [syn], steps: [{ call: 'syn' }] }] } })), /syn line 1: syntax error/);
  // a function that never returns the frame is refused too
  const noret = { name: 'noret', params: ['df'], body: "df['x'] = 1" };
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
