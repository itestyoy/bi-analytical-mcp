import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { MAX_WAIT_SECONDS } from '../../src/schema.js';

const catalog = loadCatalog(new URL('../../config/catalog.yml', import.meta.url).pathname, { dialect: 'postgres' });
const engine = new Engine({ catalog, contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'time-')) }) });

test('time: returns immediately for 0s', async () => {
  const t0 = Date.now();
  const r = await engine.time({ seconds: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.waited_seconds, 0);
  assert.equal(r.clamped, false);
  assert.ok(Date.now() - t0 < 500);
});

test('time: actually waits the requested interval', async () => {
  const t0 = Date.now();
  const r = await engine.time({ seconds: 1, reason: 'poll' });
  assert.equal(r.waited_seconds, 1);
  assert.equal(r.reason, 'poll');
  assert.ok(Date.now() - t0 >= 950, 'waited ~1s');
});

// The ceiling is a real limit, not arithmetic in the test: the wait happens inside a tool call, so
// anything above it outlives the calling client. It is reported in the ANSWER (cap_seconds), which
// is what makes it checkable without actually waiting that long — and the schema text has to name
// the same number, or the caller plans its polling around a figure the server does not honour.
test('time: reports the cap it enforces, and the schema names the same number', async () => {
  const r = await engine.time({ seconds: 0 });
  assert.equal(r.cap_seconds, MAX_WAIT_SECONDS);
  assert.equal(MAX_WAIT_SECONDS, 30);
  assert.equal(r.clamped, false);
  assert.doesNotThrow(() => engine._validate('time', { seconds: 120 })); // a big ask is accepted, then clamped
  const schema = engine.schemas.time;
  assert.ok(schema.description.includes(String(MAX_WAIT_SECONDS)), 'the tool description names the cap');
  assert.ok(schema.properties.seconds.description.includes(String(MAX_WAIT_SECONDS)));
});

// The clamp itself, without waiting for it: setTimeout is replaced for the duration of the call, so
// the requested delay is OBSERVED rather than slept through. A suite that actually waited half a
// minute to learn this would be paid for on every run.
test('time: a request above the cap is clamped — the delay asked of the timer is the cap', async () => {
  const real = globalThis.setTimeout;
  const asked = [];
  globalThis.setTimeout = (fn, ms) => { asked.push(ms); return real(fn, 0); };
  try {
    const r = await engine.time({ seconds: MAX_WAIT_SECONDS + 30 });
    assert.deepEqual(asked, [(MAX_WAIT_SECONDS) * 1000], 'the timer is asked for the cap, not the request');
    assert.equal(r.waited_seconds, MAX_WAIT_SECONDS);
    assert.equal(r.requested_seconds, MAX_WAIT_SECONDS + 30);
    assert.equal(r.clamped, true);
  } finally {
    globalThis.setTimeout = real;
  }
});

test('time: validation rejects missing/negative seconds', () => {
  assert.throws(() => engine._validate('time', {}));
  assert.throws(() => engine._validate('time', { seconds: -5 }));
});
