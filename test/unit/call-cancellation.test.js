// A CANCELLED CALL STOPS THE PROCESS IT STARTED — and only a call that is still in flight does; and a
// process's temporary files go with it.
//
// The signal rides the async context (src/request-context.js) down to the one place that spawns
// processes (src/dbt/process.js). Four properties, each one a way this could go wrong:
//   * a cancelled call kills its dbt process instead of letting it scan the warehouse to the end;
//   * work SHARED between callers (WarehouseProbe.bestEffort) is detached — one caller leaving does not
//     kill the read another caller is waiting on;
//   * a releasable signal stops forwarding once the call has returned — a build handed back as a
//     query_id is meant to outlive its call;
//   * a process's temporary directory (its TMPDIR) is its own, and is gone once it has ended — at its
//     end, killed by a cancellation, or never started — with what it left there.
//
// The "dbt" here is a shell script that sleeps (for the TMPDIR checks, after leaving a model file and
// its bytecode there); lifecycle checks, no warehouse.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createDbt } from '../../src/dbt/index.js';
import { runProcess, runWithInput } from '../../src/dbt/process.js';
import { withSignal, detached, currentSignal, releasableSignal } from '../../src/request-context.js';

function sleepyDbt(seconds = 10) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-dbt-'));
  const bin = join(dir, 'dbt');
  writeFileSync(bin, `#!/bin/sh\nsleep ${seconds}\necho done\n`);
  chmodSync(bin, 0o755);
  return { bin, dir };
}

test('a cancelled call kills its dbt process', async () => {
  const { bin, dir } = sleepyDbt();
  const runner = createDbt({ version: 1, dbtBin: bin, timeout: 60000 });
  const ctl = new AbortController();
  const t0 = Date.now();
  const p = withSignal(ctl.signal, () => runner.run(dir));
  setTimeout(() => ctl.abort(), 200);
  const r = await p;
  assert.equal(r.ok, false);
  assert.equal(r.cancelled, true);
  assert.match(r.error, /cancelled/);
  assert.ok(Date.now() - t0 < 3000, `stopped at the cancellation, not after 10s (${Date.now() - t0}ms)`);
  // a call that is already cancelled does not start one at all
  const again = await withSignal(ctl.signal, () => runner.run(dir));
  assert.equal(again.ok, false);
});

test('a call without a signal runs to its end', async () => {
  const { bin, dir } = sleepyDbt(0.2);
  const r = await createDbt({ version: 1, dbtBin: bin }).run(dir);
  assert.equal(r.ok, true);
});

test('detached work is outside every call\'s cancellation', async () => {
  const ctl = new AbortController();
  await withSignal(ctl.signal, async () => {
    assert.equal(currentSignal(), ctl.signal);
    await detached(async () => { assert.equal(currentSignal(), undefined); });
  });
});

test('a releasable signal forwards a cancellation only until it is released', () => {
  const source = new AbortController();
  const a = releasableSignal(source.signal);
  a.release();
  source.abort();
  assert.equal(a.signal.aborted, false, 'released: the call had returned, its build lives on');
  const source2 = new AbortController();
  const b = releasableSignal(source2.signal);
  source2.abort();
  assert.equal(b.signal.aborted, true, 'in flight: the cancellation reaches the call');
});

/** A "dbt" that leaves a model file and its bytecode in its TMPDIR, says where that was, then sleeps. */
function leavingDbt(seconds) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-dbt-'));
  const bin = join(dir, 'dbt');
  writeFileSync(bin, `#!/bin/sh\n: "\${TMPDIR:?}"\nmkdir -p "$TMPDIR/__pycache__"\ntouch "$TMPDIR/tmpmodel.py" "$TMPDIR/__pycache__/tmpmodel.cpython-311.pyc"\necho "$TMPDIR" > "$PWD/tmpdir.txt"\nsleep ${seconds}\n`);
  chmodSync(bin, 0o755);
  return { bin, dir, used: () => readFileSync(join(dir, 'tmpdir.txt'), 'utf8').trim() };
}

const until = async (ok, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 25))) if (ok()) return true;
  return ok();
};

test('a process has a temporary directory of its own, removed with what it left there when it ends', async () => {
  const { bin, dir, used } = leavingDbt(0);
  const r = await createDbt({ version: 1, dbtBin: bin }).run(dir);
  assert.equal(r.ok, true);
  const own = used();
  assert.ok(own && !relative(tmpdir(), own).startsWith('..') && own !== tmpdir(), `a directory of its own under the server's: ${own}`);
  assert.equal(existsSync(own), false, 'removed, with the model file and its bytecode');
});

test('a process killed by a cancellation has its temporary directory removed too', async () => {
  const { bin, dir, used } = leavingDbt(10);
  const ctl = new AbortController();
  const p = withSignal(ctl.signal, () => createDbt({ version: 1, dbtBin: bin, timeout: 60000 }).run(dir));
  const said = join(dir, 'tmpdir.txt');
  assert.ok(await until(() => existsSync(said) && readFileSync(said, 'utf8').endsWith('\n')), 'it left its files before the cancellation');
  ctl.abort();
  const r = await p;
  assert.equal(r.cancelled, true);
  const own = used();
  assert.ok(own);
  assert.ok(await until(() => !existsSync(own)), 'removed once the killed process closed');
});

test('a process fed on stdin, one that cannot start, and one refused before it starts leave no temporary directory', async () => {
  // os.tmpdir() reads TMPDIR on every call: here, a directory this test alone writes to
  const saved = process.env.TMPDIR;
  const base = mkdtempSync(join(tmpdir(), 'own-tmp-'));
  process.env.TMPDIR = base;
  try {
    const fed = await runWithInput('/bin/sh', ['-c', 'cat >/dev/null; mkdir -p "$TMPDIR/__pycache__"; touch "$TMPDIR/tmpm.py" "$TMPDIR/__pycache__/tmpm.cpython-311.pyc"; echo "$TMPDIR"'], 'x');
    assert.equal(fed.ok, true);
    assert.ok(fed.stdout.trim().startsWith(join(base, 'dbt-proc-')), fed.stdout);
    assert.equal((await runProcess(join(base, 'no-such-dbt'), [])).ok, false, 'not found: the spawn fails after it returns');
    assert.equal((await runProcess('/bin/sh', ['-c', 'true', 'a\u0000b'])).ok, false, 'a NUL in an argument: the spawn throws');
    assert.deepEqual(readdirSync(base), []);
  } finally {
    if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved;
  }
});
