// A BUILD check, and the reason it exists: the server shells out to two Python scripts that no
// JavaScript imports — python/ast_gate.py (the static gate over a python stage) and
// python/mf_server.py (MetricFlow kept warm: every metric query). The image was built with `COPY src ./src`
// alone, so both were missing in production and the first python stage died with
//
//   ast gate failed (python3 exit 2): can't open file '/app/python/ast_gate.py'
//
// which reads like the analyst's code is broken. Nothing could have caught it: the path was
// correct, the file simply was not shipped. These are input-validation / packaging guards — the one
// kind of non-data test the project rules allow — and they fail HERE, in the repo, rather than in
// someone's warehouse.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNTIME_ASSETS, assetPath, missingAssetMessage } from '../../src/runtime-assets.js';
import { resolvePythonRuntime } from '../../src/catalog.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('every declared runtime asset exists in the repo', () => {
  for (const [name, a] of Object.entries(RUNTIME_ASSETS)) {
    assert.ok(existsSync(a.path), `${name} (${a.repoPath}) is declared but missing at ${a.path}`);
    assert.equal(assetPath(name), a.path);
  }
});

// The actual production failure: the image copied src/ and nothing else.
test('the Dockerfile copies every directory a runtime asset lives in', () => {
  const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
  const copied = new Set(
    [...dockerfile.matchAll(/^COPY\s+(?!--)(\S+)/gm)].map((m) => m[1].replace(/^\.\//, '').split('/')[0]),
  );
  for (const [name, a] of Object.entries(RUNTIME_ASSETS)) {
    const dir = a.repoPath.split('/')[0];
    assert.ok(copied.has(dir), `${name} lives in ${dir}/, which the Dockerfile never COPYs (it copies: ${[...copied].join(', ')})`);
  }
});

// A production failure of the same kind: Node ran as the container's PID 1, which the kernel hands every
// orphaned process to — and Node reaps only the processes it started itself, so each dbt / Python run left
// a zombie (1,687 in three days), and it ignored SIGTERM. PID 1 is an init that reaps and forwards signals.
test('the image runs the server under an init that reaps orphaned processes (tini as PID 1)', () => {
  const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
  const entry = dockerfile.match(/^ENTRYPOINT\s+(\[.*\])\s*$/m);
  assert.ok(entry, 'the Dockerfile declares no ENTRYPOINT: Node would be PID 1');
  assert.deepEqual(JSON.parse(entry[1]), ['/usr/bin/tini', '--']);
  assert.match(dockerfile, /apt-get install[^\n]*\btini\b/, 'tini is not installed in the image');
});

// …and the same directory must not be excluded on the way in.
test('no runtime asset directory is excluded by .dockerignore', () => {
  const ignore = existsSync(join(ROOT, '.dockerignore')) ? readFileSync(join(ROOT, '.dockerignore'), 'utf8') : '';
  const patterns = ignore.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  for (const [name, a] of Object.entries(RUNTIME_ASSETS)) {
    const dir = a.repoPath.split('/')[0];
    assert.ok(!patterns.includes(dir) && !patterns.includes(`${dir}/`), `.dockerignore excludes ${dir}/, needed by ${name}`);
    // …nor the file itself by an extension pattern (`*.json`) that no `!<path>` lets back in
    const ext = a.repoPath.match(/\.[a-z]+$/)?.[0];
    if (ext && patterns.includes(`*${ext}`)) assert.ok(patterns.includes(`!${a.repoPath}`), `.dockerignore excludes *${ext}, so ${a.repoPath} (needed by ${name}) needs a !${a.repoPath} line`);
  }
});

// A missing asset must be reported as a packaging defect — the caller can neither cause nor fix it
// by changing their request.
test('a missing asset is reported as a packaging defect, naming the file and the fix', () => {
  const msg = missingAssetMessage('astGate');
  assert.match(msg, /python\/ast_gate\.py is missing from this installation/);
  assert.match(msg, /PACKAGING defect, not a problem with the request or the data/);
  assert.match(msg, /Rebuild the image/);
});

// And with no gate in the build the python STAGE is not offered at all, so nobody writes one just
// to have it refused at spawn time. Not even the operator's force-on can conjure the file.
test('without the gate script the python stage is unavailable, force-on included', () => {
  const real = RUNTIME_ASSETS.astGate.path;
  RUNTIME_ASSETS.astGate.path = join(ROOT, 'python', '__no_such_gate__.py');
  try {
    for (const env of [{}, { MCP_PYTHON_MODELS: 'on' }]) {
      const rt = resolvePythonRuntime({ env });
      assert.equal(rt.available, false, JSON.stringify(rt));
      assert.match(rt.reason, /ast_gate\.py is missing/);
    }
  } finally {
    RUNTIME_ASSETS.astGate.path = real;
  }
  // restored: the stage is decided by the profile again, not by a missing file
  assert.ok(!/is missing/.test(resolvePythonRuntime({ env: {} }).reason || ''));
});
