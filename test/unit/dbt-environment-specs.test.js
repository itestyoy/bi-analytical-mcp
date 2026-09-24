// THE dbt ENVIRONMENTS ARE THIS TOOL'S DECISION (src/dbt/environment-specs.js): only defined names
// and adapters are built, and every build has a hash lock that carries exactly the versions its spec
// pins — a spec changed without re-locking is caught here, not at the next image build.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENVIRONMENT_SPECS, INSTALLER, INSTALLER_LOCK, environmentPackages, environmentSpec, lockFile } from '../../src/dbt/environment-specs.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const normal = (name) => name.toLowerCase().replace(/_/g, '-');

/** A lock's requirement blocks: name → { version, hashes }. */
function readLock(file) {
  const out = new Map();
  for (const block of readFileSync(join(ROOT, file), 'utf8').split(/\n(?=[A-Za-z0-9])/)) {
    const pinned = block.match(/^([A-Za-z0-9._-]+)==([^\s;\\]+)/);
    const wheel = block.match(/^([A-Za-z0-9._-]+) @ \S+\/[A-Za-z0-9_.]+-([^-/\s]+)-[^/\s]+\.whl\b/);
    const m = pinned || wheel;
    if (m) out.set(normal(m[1]), { version: m[2], hashes: block.match(/--hash=sha256:[0-9a-f]{64}/g) || [] });
  }
  return out;
}

const builds = () => Object.entries(ENVIRONMENT_SPECS).flatMap(([name, spec]) => (spec.packages ? [[name, null]] : Object.keys(spec.adapters).map((a) => [name, a])));

test('an environment or adapter the specs do not define is refused, naming what is defined', () => {
  assert.throws(() => environmentSpec('my-own-dbt'), /no dbt environment 'my-own-dbt'.*dbt-v2/);
  assert.throws(() => environmentPackages('dbt-v1', 'snowflake'), /no 'snowflake' build.*duckdb, bigquery/);
  assert.throws(() => environmentPackages('metricflow'), /built per warehouse adapter/);
  assert.deepEqual(environmentPackages('dbt-v2', 'bigquery'), environmentPackages('dbt-v2', 'duckdb'));
});

test('every build has a lock holding each pinned package at the pinned version, every entry hashed', () => {
  for (const [name, adapter] of [...builds(), ['installer', null]]) {
    const file = name === 'installer' ? INSTALLER_LOCK : lockFile(name, adapter);
    assert.ok(existsSync(join(ROOT, file)), `${file} is missing — run: npm run dbt:env -- lock`);
    const lock = readLock(file);
    assert.ok(lock.size > 0, `${file} locks nothing`);
    for (const [pkg, { hashes }] of lock) assert.ok(hashes.length > 0, `${file}: ${pkg} has no hash`);
    for (const pin of name === 'installer' ? INSTALLER : environmentPackages(name, adapter)) {
      const [pkg, version] = pin.split('==');
      assert.equal(lock.get(normal(pkg))?.version, version, `${file} does not lock ${pin} — re-lock after changing the spec`);
    }
  }
});

test('a download-at-install package is locked as its wheel, never as the sdist whose build fetches one', () => {
  for (const [name, adapter] of builds()) {
    for (const pkg of environmentSpec(name).wheelsFromSdist || []) {
      const text = readFileSync(join(ROOT, lockFile(name, adapter)), 'utf8');
      assert.match(text, new RegExp(`^${pkg} @ https://\\S+\\.whl \\\\$`, 'm'), `${lockFile(name, adapter)}: ${pkg} is not locked as a wheel`);
    }
  }
});
