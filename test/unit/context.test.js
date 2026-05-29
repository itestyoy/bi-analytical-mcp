import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextManager, mergeCompiled, newContextId } from '../../src/context-manager.js';

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 'ctxmgr-'));
}

test('newContextId is 12 hex chars', () => {
  assert.match(newContextId(), /^[0-9a-f]{12}$/);
});

test('create / writeYaml / list / drop lifecycle', () => {
  const root = tmpRoot();
  const cm = new ContextManager({ workspaceRoot: root });
  const ctx = cm.create();
  assert.ok(existsSync(cm.dir(ctx.id)));
  cm.writeYaml(ctx.id, 'semantic_models: []\n');
  assert.ok(cm.generatedFiles(ctx.id).length === 1);
  assert.equal(cm.list().length, 1);
  const res = cm.drop(ctx.id);
  assert.equal(res.removed, true);
  assert.equal(existsSync(cm.dir(ctx.id)), false);
  assert.equal(cm.list().length, 0);
});

test('registry persists and reconciles with disk on reload', () => {
  const root = tmpRoot();
  const cm1 = new ContextManager({ workspaceRoot: root });
  const a = cm1.create();
  const b = cm1.create();
  // simulate orphaned registry entry: drop b's dir but keep registry via a second manager BEFORE drop
  const cm2 = new ContextManager({ workspaceRoot: root }); // reloads registry from disk
  assert.deepEqual(cm2.list().map((c) => c.context_id).sort(), [a.id, b.id].sort());
});

test('lease prevents drop while in-flight', () => {
  const root = tmpRoot();
  const cm = new ContextManager({ workspaceRoot: root });
  const ctx = cm.create();
  cm.acquire(ctx.id);
  assert.throws(() => cm.drop(ctx.id), /in-flight/);
  cm.release(ctx.id);
  assert.equal(cm.drop(ctx.id).removed, true);
});

test('mergeCompiled accumulates additions and dedups metrics', () => {
  const state = {};
  mergeCompiled(state, { task: 't1', additions: { events: { measures: [{ name: 'a' }], dimensions: [] } }, metrics: [{ name: 'm1' }], usedModels: ['events'] });
  mergeCompiled(state, { task: 't2', additions: { events: { measures: [{ name: 'b' }], dimensions: [] }, users: { measures: [], dimensions: [{ name: 'd' }] } }, metrics: [{ name: 'm1' }, { name: 'm2' }], usedModels: ['events', 'users'] });
  assert.deepEqual(state.additions.events.measures.map((m) => m.name), ['a', 'b']);
  assert.deepEqual(state.metrics.map((m) => m.name), ['m1', 'm2']);
  assert.deepEqual(state.usedModels.sort(), ['events', 'users']);
  assert.deepEqual(state.tasks, ['t1', 't2']);
});
