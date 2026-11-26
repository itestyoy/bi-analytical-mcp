// A SCHEDULED MODEL ACROSS A RESTART (context lifecycle): one whose first build stood stays scheduled; one
// whose first build never stood — the process ended during it — is no scheduled model when the registry is
// read again, so its draft is open to be fixed instead of fixed for ever.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContextManager } from '../../src/context-manager.js';
import { tempDir } from '../helpers/temp-dir.js';

test('a first build that never stood leaves no scheduled model after a restart', () => {
  const root = tempDir('sched-restart');
  const a = new ContextManager({ workspaceRoot: root });
  const built = a.create();
  const pending = a.create();
  built.state.scheduled = { model: 'm1', refreshed_at: new Date().toISOString() };
  pending.state.scheduled = { model: 'm2' };
  a.touch(built.id);
  a.touch(pending.id);
  const b = new ContextManager({ workspaceRoot: root });
  assert.ok(b.get(built.id).state.scheduled, 'a model that stood stays scheduled');
  assert.equal(b.get(pending.id).state.scheduled, undefined, 'one that never stood is a draft again');
});
