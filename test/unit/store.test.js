import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, registerStoreBackend, storeBackends, MemoryBackend } from '../../src/store.js';
import { JobManager } from '../../src/jobs.js';
import { ValueIndex } from '../../src/value-index.js';

// The store is a swappable repository layer; the managers contain no SQL. These tests
// exercise the contract + the backend registry (no warehouse, allowed lifecycle checks).

test('openStore falls back to the in-memory backend without a path', () => {
  const s = openStore({});
  assert.equal(s.persistent, false);
  assert.equal(s.kind, 'memory');
});

test('one shared store backs BOTH the job registry and the value index (separate tables)', () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'store-')), 'mcp.sqlite');
  const store = openStore({ dbPath });
  if (!store.persistent) return; // no node:sqlite here

  const jobs = new JobManager({ store });
  const idx = new ValueIndex({ store });
  const id = jobs.create({ contextId: 'c1' });
  jobs.ready(id);
  const runId = idx.startRun();
  idx.upsertProperty('events', 'p', { distinctCount: 1, totalCount: 3, values: [{ value: 'x', freq: 3 }] });
  idx.finishRun(runId, { status: 'ok', propertiesIndexed: 1, valuesWritten: 1, errors: 0 });

  // Reopen the SAME file with fresh managers over a fresh store → both subsystems reloaded.
  const store2 = openStore({ dbPath });
  const jobs2 = new JobManager({ store: store2 });
  const idx2 = new ValueIndex({ store: store2 });
  assert.equal(jobs2.get(id).status, 'ready', 'jobs table persisted');
  assert.deepEqual(idx2.sampleValues('events', 'p'), [{ value: 'x', freq: 3 }], 'value index tables persisted in the same file');
  assert.equal(idx2.syncStatus().last_run.status, 'ok', 'index_runs persisted in the same file');
  store.close(); store2.close();
});

test('a custom backend can be registered and selected (database is swappable)', () => {
  // Register a trivial alternate backend (delegates to MemoryBackend) and select it.
  registerStoreBackend('mem-test', () => new MemoryBackend());
  assert.ok(storeBackends().includes('mem-test'));
  const s = openStore({ dbPath: '/whatever', backend: 'mem-test' });
  assert.equal(s.kind, 'memory');
  // The managers work over it unchanged (no SQL knowledge in them).
  const idx = new ValueIndex({ store: s });
  idx.upsertProperty('events', 'p', { distinctCount: 1, totalCount: 1, values: [{ value: 'v', freq: 1 }] });
  assert.deepEqual(idx.sampleValues('events', 'p'), [{ value: 'v', freq: 1 }]);
});

test('openStore throws on an unknown backend name', () => {
  assert.throws(() => openStore({ backend: 'nope' }), /unknown store backend/);
});

test('openStore({ reset: true }) wipes all state on open (MCP_DB_RESET)', () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'store-reset-')), 'mcp.sqlite');
  const probe = new ValueIndex({ store: openStore({ dbPath }) });
  if (!probe.persistent) return; // no node:sqlite here

  // seed a persistent store with a job + indexed values + a run.
  const seed = openStore({ dbPath });
  const jobs = new JobManager({ store: seed });
  const idx = new ValueIndex({ store: seed });
  jobs.ready(jobs.create({ contextId: 'c1' }));
  const r = idx.startRun();
  idx.upsertProperty('events', 'p', { distinctCount: 1, totalCount: 1, values: [{ value: 'v', freq: 1 }] });
  idx.finishRun(r, { status: 'ok' });
  seed.close();

  // reopen WITH reset → everything is gone.
  const fresh = openStore({ dbPath, reset: true });
  const jobs2 = new JobManager({ store: fresh });
  const idx2 = new ValueIndex({ store: fresh });
  assert.equal(jobs2.list().length, 0, 'jobs cleared');
  assert.deepEqual(idx2.sampleValues('events', 'p'), [], 'values cleared');
  assert.equal(idx2.syncStatus().total_runs, 0, 'run log cleared');
  fresh.close();
});

test('an older database gets the columns added since, and keeps its rows', async () => {
  const { DatabaseSync } = await import('node:sqlite').catch(() => ({}));
  if (!DatabaseSync) return; // no node:sqlite here
  const dbPath = join(mkdtempSync(join(tmpdir(), 'store-old-')), 'mcp.sqlite');
  const old = new DatabaseSync(dbPath);
  old.exec('CREATE TABLE jobs (id TEXT PRIMARY KEY, context_id TEXT, table_name TEXT, status TEXT, error TEXT, started_at INTEGER, ready_at INTEGER)');
  old.exec("INSERT INTO jobs (id, context_id, status) VALUES ('j1', 'c1', 'ready')");
  old.exec('CREATE TABLE errors (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, source TEXT, severity TEXT, tool TEXT, stage TEXT, field TEXT, code TEXT, context_id TEXT, task_id TEXT, message TEXT, args TEXT, detail TEXT)');
  old.close();
  const store = openStore({ dbPath });
  store.close();
  const db = new DatabaseSync(dbPath);
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  assert.ok(['tool', 'drawn'].every((c) => cols('jobs').includes(c)), cols('jobs').join(','));
  assert.ok(['context', 'files', 'runtime'].every((c) => cols('errors').includes(c)));
  assert.equal(db.prepare("SELECT context_id FROM jobs WHERE id = 'j1'").get().context_id, 'c1');
  // opened again, nothing more to add — and no error
  db.close();
  openStore({ dbPath }).close();
});
