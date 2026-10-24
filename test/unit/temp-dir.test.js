// EVERY TEMPORARY DIRECTORY A TEST OR AN EVAL MAKES GOES WHEN ITS RUN ENDS (test/helpers/temp-dir.js):
// runs that left theirs behind once filled a disk with 110,000 of them. The helper's lifecycle, and
// that nothing under test/ or evals/ makes one any other way.
//
// Checks on the files a run leaves; no warehouse.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../helpers/temp-dir.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const HELPER = new URL('../helpers/temp-dir.js', import.meta.url);

function sources(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'node_modules' || name === 'results' || name === 'fixtures' ? [] : sources(p);
    return /\.m?js$/.test(name) ? [p] : [];
  });
}

test('a directory made in a before() hook is there for the tests, and gone once the file ends', () => {
  const out = tempDir('temp-dir-probe');
  const file = join(out, 'probe.test.mjs');
  const record = join(out, 'made.json');
  writeFileSync(file, `
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { removeTempDir, tempDir } from ${JSON.stringify(HELPER.href)};
let kept;
before(async () => { await null; kept = tempDir('temp-dir-probe-kept'); writeFileSync(join(kept, 'f'), 'x'); });
test('the tests see what before() made', () => {
  assert.ok(existsSync(join(kept, 'f')));
  const early = tempDir('temp-dir-probe-early');
  removeTempDir(early);
  assert.equal(existsSync(early), false, 'removed when asked');
  writeFileSync(${JSON.stringify(record)}, JSON.stringify({ kept, early }));
});
`);
  // the file runs as a file of its own run, not as a child reporting to this one
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--test', file], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const { kept, early } = JSON.parse(readFileSync(record, 'utf8'));
  assert.equal(existsSync(kept), false, 'removed when the file ended');
  assert.equal(existsSync(early), false);
});

test('no test or eval makes a temporary directory but through tempDir', () => {
  const RAW = /\b(?:mkdtempSync|mkdtemp|tmpdir)\s*\(/;
  const raw = [...sources(join(ROOT, 'test')), ...sources(join(ROOT, 'evals'))]
    .filter((f) => f !== HELPER.pathname && RAW.test(readFileSync(f, 'utf8')))
    .map((f) => f.slice(ROOT.length));
  assert.deepEqual(raw, [], 'make it with tempDir(prefix) from test/helpers/temp-dir.js — it is removed when the run ends');
});
