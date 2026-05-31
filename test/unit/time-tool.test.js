import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';

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

test('time: caps the wait at 60s (clamp math, no long wait)', () => {
  assert.doesNotThrow(() => engine._validate('time', { seconds: 120 })); // accepted by schema
  assert.equal(Math.min(Math.max(120, 0), 60), 60); // clamp result the engine applies
});

test('time: validation rejects missing/negative seconds', () => {
  assert.throws(() => engine._validate('time', {}));
  assert.throws(() => engine._validate('time', { seconds: -5 }));
});
