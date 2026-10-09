import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { MAX_WAIT_SECONDS } from '../../src/schema.js';
import { settle } from '../helpers/settle.js';

const catalog = loadCatalog(new URL('../../config/catalog.yml', import.meta.url).pathname, { dialect: 'duckdb' });
const engine = settle(new Engine({ catalog, contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'time-')) }) }));

test('time: returns immediately for 0s', async () => {
  const t0 = Date.now();
  const r = await engine.time({ seconds: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.waited_seconds, 0);
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
  // the answer says what was waited and the cap, nothing that is the same on every answer
  assert.equal(r.requested_seconds, undefined);
  assert.equal(r.clamped, undefined);
  assert.doesNotThrow(() => engine._validate('time', { seconds: MAX_WAIT_SECONDS }));
  const schema = engine.schemas.time;
  assert.ok(schema.description.includes(String(MAX_WAIT_SECONDS)), 'the tool description names the cap');
  assert.ok(schema.properties.seconds.description.includes(String(MAX_WAIT_SECONDS)));
});

// A wait longer than the cap is refused in the call, as a read's wait_seconds is — never accepted and
// then cut short behind the caller's back.
test('time: a request above the cap is refused, not clamped', async () => {
  assert.throws(() => engine._validate('time', { seconds: MAX_WAIT_SECONDS + 30 }), /must be <= 30/);
  await assert.rejects(() => engine.time({ seconds: MAX_WAIT_SECONDS + 0.5 }), /must be <= 30/);
});

test('time: validation rejects missing/negative seconds', () => {
  assert.throws(() => engine._validate('time', {}));
  assert.throws(() => engine._validate('time', { seconds: -5 }));
});
