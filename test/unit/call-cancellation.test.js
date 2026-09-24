// A CANCELLED CALL STOPS THE PROCESS IT STARTED — and only a call that is still in flight does.
//
// The signal rides the async context (src/request-context.js) down to the one place that spawns
// processes (src/dbt/process.js). Three properties, each one a way this could go wrong:
//   * a cancelled call kills its dbt process instead of letting it scan the warehouse to the end;
//   * work SHARED between callers (Engine._bestEffort) is detached — one caller leaving does not
//     kill the read another caller is waiting on;
//   * a releasable signal stops forwarding once the call has returned — a build handed back as a
//     query_id is meant to outlive its call.
//
// The "dbt" here is a shell script that sleeps; lifecycle checks, no warehouse.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDbt } from '../../src/dbt/index.js';
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
  const runner = createDbt({ dbtBin: bin, timeout: 60000 });
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
  const r = await createDbt({ dbtBin: bin }).run(dir);
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
