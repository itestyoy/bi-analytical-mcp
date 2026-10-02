import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
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

test('a database an earlier server wrote is brought to the declared tables: columns added, a cache keyed otherwise rebuilt, the rest kept', () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'store-old-')), 'mcp.sqlite');
  const old = new DatabaseSync(dbPath);
  old.exec('CREATE TABLE jobs (id TEXT PRIMARY KEY, context_id TEXT, table_name TEXT, status TEXT, error TEXT, started_at INTEGER, ready_at INTEGER)');
  old.exec("INSERT INTO jobs VALUES ('j1', 'c1', 't1', 'ready', NULL, 1, 2)");
  old.exec('CREATE TABLE prop_stats (property TEXT PRIMARY KEY, distinct_count INTEGER, total_count INTEGER, indexed_at INTEGER)');
  old.exec("INSERT INTO prop_stats VALUES ('users.country', 1, 99, 1)");
  old.exec('CREATE TABLE errors (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, source TEXT, severity TEXT, tool TEXT, stage TEXT, field TEXT, code TEXT, context_id TEXT, task_id TEXT, message TEXT, args TEXT, detail TEXT)');
  old.close();

  const store = openStore({ dbPath });
  const jobs = new JobManager({ store });
  assert.equal(jobs.get('j1').status, 'ready', 'a job row is kept');
  const id = jobs.create({ contextId: 'c2', tool: 'query_pipeline_model' });
  jobs.ready(id);
  const idx = new ValueIndex({ store });
  assert.equal(idx.stats('users', 'country'), null, 'the cache keyed by property alone is rebuilt empty');
  idx.upsertProperty('users', 'country', { distinctCount: 2, totalCount: 5, values: [{ value: 'US', freq: 3 }, { value: 'GB', freq: 2 }] });
  store.errors.add({ at: 1, source: 'call', message: 'm', context: '{}', runtime: '{}' });
  store.close();

  const again = openStore({ dbPath });
  assert.equal(new JobManager({ store: again }).get(id).tool, 'query_pipeline_model', 'the added column holds what is written');
  assert.deepEqual(new ValueIndex({ store: again }).sampleValues('users', 'country'), [{ value: 'US', freq: 3 }, { value: 'GB', freq: 2 }]);
  assert.equal(again.errors.list().rows[0].context, '{}');
  again.close();
});

test('a table that is not a cache, keyed otherwise than declared, is refused naming both keys', () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'store-key-')), 'mcp.sqlite');
  const old = new DatabaseSync(dbPath);
  old.exec('CREATE TABLE memory (note TEXT PRIMARY KEY, targets TEXT)');
  old.close();
  assert.throws(() => openStore({ dbPath }), /memory is keyed by \(note\), this server keys it by \(id\) — it cannot be changed in place$/);
  assert.throws(() => openStore({ dbPath, reset: true }), /memory is keyed by \(note\)/, 'MCP_DB_RESET keeps memory, so it does not rebuild it either');
});

test('a table MCP_DB_RESET wipes, keyed otherwise, is refused naming the reset — and rebuilt under it, the kept tables kept', () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'store-reset-key-')), 'mcp.sqlite');
  const old = new DatabaseSync(dbPath);
  old.exec('CREATE TABLE jobs (context_id TEXT PRIMARY KEY, status TEXT)');
  old.exec('CREATE TABLE memory (id TEXT PRIMARY KEY, note TEXT, question TEXT, targets TEXT, aliases TEXT, links TEXT, created_at INTEGER)');
  old.exec(`INSERT INTO memory (id, note, targets, aliases, links, created_at) VALUES ('m1', 'kept', '[]', '[]', '[]', 1)`);
  old.close();
  assert.throws(() => openStore({ dbPath }), /jobs is keyed by \(context_id\).*MCP_DB_RESET=1 clears it/);
  const store = openStore({ dbPath, reset: true });
  const jobs = new JobManager({ store });
  const id = jobs.create({ contextId: 'c1', tool: 'query_pipeline_model' });
  assert.equal(jobs.get(id).contextId, 'c1');
  assert.equal(store.memory.get('m1').note, 'kept');
  store.close();
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

test('a task stored before tasks recorded their tool is refused by either side, as gone', async () => {
  const { TaskRunner } = await import('../../src/task-runner.js');
  const dbPath = join(mkdtempSync(join(tmpdir(), 'store-notool-')), 'mcp.sqlite');
  const old = new DatabaseSync(dbPath);
  old.exec('CREATE TABLE jobs (id TEXT PRIMARY KEY, context_id TEXT, table_name TEXT, status TEXT, error TEXT, started_at INTEGER, ready_at INTEGER)');
  old.exec("INSERT INTO jobs VALUES ('aaaaaaaaaaaa', 'c1', 't1', 'ready', NULL, 1, 2)");
  old.close();
  const jobs = new JobManager({ store: openStore({ dbPath }) });
  const sides = { query_semantic_model: 'semantic', query_pipeline_model: 'pipeline' };
  const runner = new TaskRunner({ jobs, ctxs: null, sideOf: (tool) => sides[tool] || null, readers: { semantic: 'query_semantic_model', pipeline: 'query_pipeline_model' } });
  for (const side of ['semantic', 'pipeline']) assert.throws(() => runner.forSide('aaaaaaaaaaaa', side), (e) => /records no tool that started it/.test(e.message) && e.code === 'result_gone');
  // a task whose tool is no longer served (its feature off) says so, not that it records none
  const off = jobs.create({ contextId: 'c2', tool: 'query_retentioneering_model' });
  assert.throws(() => runner.forSide(off, 'semantic'), /started by query_retentioneering_model, which this server does not serve now/);
});
