// THE dbt ENVIRONMENTS ARE THIS TOOL'S DECISION (src/dbt/environment-specs.js): only defined names
// and adapters are built, and every package is named at an exact version.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENVIRONMENT_SPECS, INSTALLER, environmentPackages, environmentSpec } from '../../src/dbt/environment-specs.js';

test('an environment or adapter the specs do not define is refused, naming what is defined', () => {
  assert.throws(() => environmentSpec('my-own-dbt'), /no dbt environment 'my-own-dbt'.*dbt-v2/);
  assert.throws(() => environmentPackages('dbt-v1', 'snowflake'), /no 'snowflake' build.*duckdb, bigquery/);
  assert.throws(() => environmentPackages('metricflow'), /built per warehouse adapter/);
  assert.deepEqual(environmentPackages('dbt-v2', 'bigquery'), environmentPackages('dbt-v2', 'duckdb'));
});

test('every package of every build is named at an exact version', () => {
  const builds = Object.entries(ENVIRONMENT_SPECS).flatMap(([name, spec]) => (spec.packages ? [[name, null]] : Object.keys(spec.adapters).map((a) => [name, a])));
  for (const pin of [INSTALLER, ...builds.flatMap(([name, adapter]) => environmentPackages(name, adapter))]) {
    assert.match(pin, /^[A-Za-z0-9._-]+==\d+(\.\d+)*$/, `'${pin}' is not name==exact.version`);
  }
});
