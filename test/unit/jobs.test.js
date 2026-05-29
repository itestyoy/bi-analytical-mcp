import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobManager } from '../../src/jobs.js';

test('JobManager tracks status/table/context in memory', () => {
  const jm = new JobManager();
  const id = jm.create({ contextId: 'ctx1' });
  jm.setTable(id, `qr_${id}`);
  assert.equal(jm.get(id).status, 'running');
  jm.ready(id);
  assert.equal(jm.get(id).status, 'ready');
  assert.equal(jm.get(id).table, `qr_${id}`);
  jm.fail(jm.create({ contextId: 'c' }), 'boom');
  assert.ok(jm.list().some((j) => j.status === 'error'));
});

test('JobManager persists jobs to SQLite and reloads them (survives restart)', () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'jobs-')), 'jobs.sqlite');
  const jm1 = new JobManager({ dbPath });
  const id = jm1.create({ contextId: 'ctxA' });
  jm1.setTable(id, `qr_${id}`);
  jm1.ready(id);

  // new manager, same db file -> reloads persisted jobs
  const jm2 = new JobManager({ dbPath });
  const j = jm2.get(id);
  assert.ok(j, 'job reloaded from sqlite');
  assert.equal(j.status, 'ready');
  assert.equal(j.contextId, 'ctxA');
  assert.equal(j.table, `qr_${id}`);
});
