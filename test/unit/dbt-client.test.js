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
