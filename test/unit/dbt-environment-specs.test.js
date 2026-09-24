// THE dbt ENVIRONMENTS ARE THIS TOOL'S DECISION (src/dbt/environment-specs.js): only defined names
// are built, every package is named at an exact version, and each carries both warehouses' adapters.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENVIRONMENT_SPECS, INSTALLER, environmentPackages } from '../../src/dbt/environment-specs.js';

test('an environment the specs do not define is refused, naming what is defined', () => {
  assert.throws(() => environmentPackages('my-own-dbt'), /no dbt environment 'my-own-dbt'.*dbt-v2, dbt-v1, metricflow/);
});

test('every package is named at an exact version', () => {
  for (const pin of [INSTALLER, ...Object.keys(ENVIRONMENT_SPECS).flatMap((name) => environmentPackages(name))]) {
    assert.match(pin, /^[A-Za-z0-9._-]+==\d+(\.\d+)*$/, `'${pin}' is not name==exact.version`);
  }
});

test('the Python dbt environments carry the adapters of both warehouses', () => {
  for (const name of ['dbt-v1', 'metricflow']) {
    const names = environmentPackages(name).map((p) => p.split('==')[0]);
    assert.ok(names.includes('dbt-duckdb') && names.includes('dbt-bigquery'), `${name}: ${names.join(', ')}`);
  }
});
