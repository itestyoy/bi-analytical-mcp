// THE dbt CLIENT (src/dbt/): one contract over dbt, whatever its version, and one turn at a time on
// a warehouse that admits one process (DuckDB). Lifecycle and input checks with stand-in `dbt`
// binaries — the numbers dbt produces are proven against DuckDB in test/integration.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDbt, detectDbtMajor } from '../../src/dbt/index.js';
import { warehouseOf } from '../../src/dbt/warehouse.js';

/** A project dir with a profile of `type` (and a DuckDB path read from DUCKDB_PATH). */
function project(type) {
  const dir = mkdtempSync(join(tmpdir(), 'dbtc-'));
  writeFileSync(join(dir, 'dbt_project.yml'), 'name: p\nprofile: p\n');
  writeFileSync(join(dir, 'profiles.yml'), `p:\n  target: dev\n  outputs:\n    dev:\n      type: ${type}\n      path: "{{ env_var('DUCKDB_PATH') }}"\n`);
  return dir;
}

/** A stand-in binary: runs `script` (sh) with the args. */
function bin(dir, script) {
  const p = join(dir, `fake-${Math.random().toString(36).slice(2)}`);
  writeFileSync(p, `#!/bin/sh\n${script}\n`);
  chmodSync(p, 0o755);
  return p;
}

test('the warehouse is read from the project\'s profile: DuckDB takes turns by its database file, BigQuery does not', () => {
  const duck = project('duckdb');
  const w = warehouseOf(duck, duck, { DUCKDB_PATH: '/data/a.duckdb' });
  assert.deepEqual(w, { adapter: 'duckdb', singleWriter: true, turn: '/data/a.duckdb' });
  const bq = project('bigquery');
  assert.deepEqual(warehouseOf(bq, bq, {}), { adapter: 'bigquery', singleWriter: false, turn: null });
  assert.deepEqual(warehouseOf(mkdtempSync(join(tmpdir(), 'none-')), undefined, {}).adapter, null, 'no profile: unknown, no turn');
});

test('on a single-writer warehouse the client runs one process at a time; elsewhere they run together', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'turns-'));
  const log = join(dir, 'log');
  writeFileSync(log, '');
  // each process notes when it starts and ends, and takes a moment in between
  const dbt = bin(dir, `echo "start $$" >> ${log}; sleep 0.3; echo "end $$" >> ${log}; echo '{"show": []}'`);
  const order = () => readFileSync(log, 'utf8').trim().split('\n').map((l) => l.split(' ')[0]);
  process.env.DUCKDB_PATH = join(dir, 'w.duckdb');
  const duck = project('duckdb');
  const c = createDbt({ version: 1, dbtBin: dbt, profilesDir: duck });
  await Promise.all([c.show(duck, 'select 1'), c.show(duck, 'select 2'), c.show(duck, 'select 3')]);
  assert.deepEqual(order(), ['start', 'end', 'start', 'end', 'start', 'end'], 'strictly one after another');
  writeFileSync(log, '');
  const bq = project('bigquery');
  await Promise.all([createDbt({ version: 1, dbtBin: dbt, profilesDir: bq }).show(bq, 'select 1'), createDbt({ version: 1, dbtBin: dbt, profilesDir: bq }).show(bq, 'select 2')]);
  assert.deepEqual(order().slice(0, 2), ['start', 'start'], 'both running at once');
});

test('the client is chosen by the dbt major version: 1.x reads the legacy semantic YAML, v2 the latest; others are refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ver-'));
  const v1 = bin(dir, 'echo "Core:"; echo "  - installed: 1.11.11"');
  const v2 = bin(dir, 'echo "dbt 2.0.6"');
  assert.equal(detectDbtMajor(v1), 1);
  assert.equal(detectDbtMajor(v2), 2);
  const c1 = createDbt({ version: 'auto', dbtBin: v1 });
  const c2 = createDbt({ version: 'auto', dbtBin: v2 });
  assert.deepEqual([c1.major, c1.semanticSpec, c1.pythonModelsOn('duckdb')], [1, 'legacy', true]);
  assert.deepEqual([c2.major, c2.semanticSpec, c2.pythonModelsOn('duckdb'), c2.pythonModelsOn('bigquery')], [2, 'latest', false, true]);
  assert.throws(() => createDbt({ version: 3 }), /dbt 3\.x is not supported/);
});

test('dbt runs in a named environment (`dbt-v2` unless named); MetricFlow is an environment of its own', async () => {
  const { resolveEnvironment, listEnvironments } = await import('../../src/dbt/environments.js');
  const { environmentBuild, INSTALLER } = await import('../../src/dbt/environment-specs.js');
  const { mkdirSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'envs-'));
  // a venv with these executables, each answering --version for its dbt, marked as built by
  // `dbt-env create` from its spec as it is now
  const venv = (name, bins, version) => {
    mkdirSync(join(dir, name, 'bin'), { recursive: true });
    for (const b of bins) {
      writeFileSync(join(dir, name, 'bin', b), `#!/bin/sh\necho "dbt ${version}"\n`);
      chmodSync(join(dir, name, 'bin', b), 0o755);
    }
    writeFileSync(join(dir, name, 'mcp-env.json'), JSON.stringify({ name, ...environmentBuild(name) }));
  };
  venv('dbt-v2', ['dbt'], '2.0.6');                            // dbt v2: the binary only
  venv('dbt-v1', ['dbt', 'python'], '1.11.11');                 // dbt 1.x, no MetricFlow
  venv('metricflow', ['mf', 'dbt', 'python'], '1.11.11');       // MetricFlow (+ the dbt-core it queries with)
  assert.deepEqual(listEnvironments({ dir }).map((e) => e.name), ['dbt-v1', 'dbt-v2', 'metricflow']);
  const d = resolveEnvironment(undefined, { dir, env: {} });
  assert.equal(d.name, 'dbt-v2');
  assert.equal(d.dbtBin, join(dir, 'dbt-v2', 'bin', 'dbt'));
  assert.deepEqual([d.metricflowFrom, d.mfBin, d.pythonBin], ['metricflow', join(dir, 'metricflow', 'bin', 'mf'), join(dir, 'metricflow', 'bin', 'python')]);
  const one = resolveEnvironment(undefined, { dir, env: { DBT_ENV: 'dbt-v1' } });
  assert.deepEqual([one.name, one.metricflowFrom], ['dbt-v1', 'metricflow'], 'DBT_ENV names another dbt; MetricFlow stays its own');
  assert.throws(() => resolveEnvironment('nope', { dir }), /environment 'nope' not found.*there: dbt-v1, dbt-v2, metricflow\)/);
  assert.throws(() => resolveEnvironment(undefined, { dir, env: { MF_ENV: 'mf2' } }), /MetricFlow environment 'mf2' not found/);
  // only OUR environments run: a name the specs do not define, a venv not built by `create`, or one
  // built with other versions than the spec names is refused
  mkdirSync(join(dir, 'my-dbt', 'bin'), { recursive: true });
  writeFileSync(join(dir, 'my-dbt', 'bin', 'dbt'), '#!/bin/sh\necho "dbt 1.11.11"\n');
  chmodSync(join(dir, 'my-dbt', 'bin', 'dbt'), 0o755);
  assert.throws(() => resolveEnvironment('my-dbt', { dir, env: {} }), /refused: 'my-dbt' is not an environment this tool defines/);
  // …and each serves only as what it is: the MetricFlow venv has a `dbt` too, but is not a dbt environment
  assert.throws(() => resolveEnvironment('metricflow', { dir, env: {} }), /refused: 'metricflow' is a metricflow environment, not a dbt one \(dbt environments: dbt-v2, dbt-v1\)/);
  assert.throws(() => resolveEnvironment('dbt-v2', { dir, env: { MF_ENV: 'dbt-v1' } }), /MetricFlow environment 'dbt-v1' not found/);
  // the same packages in another order are the same build; another pip is not
  writeFileSync(join(dir, 'dbt-v1', 'mcp-env.json'), JSON.stringify({ name: 'dbt-v1', ...environmentBuild('dbt-v1'), packages: [...environmentBuild('dbt-v1').packages].reverse() }));
  assert.equal(resolveEnvironment('dbt-v1', { dir, env: {} }).name, 'dbt-v1');
  writeFileSync(join(dir, 'dbt-v1', 'mcp-env.json'), JSON.stringify({ name: 'dbt-v1', ...environmentBuild('dbt-v1'), installer: 'pip==23.0.1' }));
  assert.throws(() => resolveEnvironment('dbt-v1', { dir, env: {} }), new RegExp(`refused: .*built with pip==23\\.0\\.1 .*the spec says ${INSTALLER.replace(/\./g, '\\.')}`));
  writeFileSync(join(dir, 'dbt-v1', 'mcp-env.json'), JSON.stringify({ name: 'dbt-v1', installer: INSTALLER, packages: ['dbt-core==1.10.0', 'dbt-duckdb==1.10.0'] }));
  assert.throws(() => resolveEnvironment('dbt-v1', { dir, env: {} }), /refused: .*built with pip==[\d.]+ dbt-core==1\.10\.0 dbt-duckdb==1\.10\.0, the spec says/);
  const { rmSync } = await import('node:fs');
  rmSync(join(dir, 'dbt-v1', 'mcp-env.json'));
  assert.throws(() => resolveEnvironment('dbt-v1', { dir, env: {} }), /refused: .*not built by this tool/);
  // the client takes the environment's binaries, and its version from them
  const c = createDbt({ environment: d });
  assert.deepEqual([c.major, c.dbtBin, c.mfBin, c.environment.name], [2, d.dbtBin, d.mfBin, 'dbt-v2']);
});
