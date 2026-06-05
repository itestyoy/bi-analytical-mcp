import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ValueIndex } from '../../src/value-index.js';

// Persistence: a dbPath-backed index survives a close + reopen (the data is a file on
// disk). Skips cleanly if node:sqlite is unavailable (then it is an in-memory fallback).
test('ValueIndex persists to a file on disk across reopen', () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'vi-persist-')), 'value-index.sqlite');
  const a = new ValueIndex({ dbPath });
  if (!a.db) { a.close(); return; } // node:sqlite not available here → nothing to assert
  const runId = a.startRun();
  a.upsertProperty('p', { distinctCount: 2, totalCount: 9, values: [{ value: 'x', freq: 5 }, { value: 'y', freq: 4 }] });
  a.finishRun(runId, { status: 'ok', propertiesIndexed: 1, valuesWritten: 2, errors: 0 });
  a.close();

  // Reopen the SAME file in a fresh instance — the values + run log are still there.
  const b = new ValueIndex({ dbPath });
  assert.ok(b.db, 'reopened a real SQLite file');
  assert.deepEqual(b.sampleValues('p'), [{ value: 'x', freq: 5 }, { value: 'y', freq: 4 }]);
  assert.equal(b.stats('p').distinctCount, 2);
  const s = b.syncStatus();
  assert.equal(s.indexed_properties, 1);
  assert.equal(s.total_values, 2);
  assert.equal(s.last_run.status, 'ok'); // the finished run was persisted, not reconciled to interrupted
  b.close();
});

// Allowed non-data unit test: it exercises the in-memory STORE (no dbPath →
// Map fallback), not any generated SQL. Round-trips upsert → sample/search/stats.
test('ValueIndex in-memory fallback round-trips upsert → sampleValues/stats/searchValues', () => {
  const idx = new ValueIndex(); // no dbPath -> in-memory Map fallback
  idx.upsertProperty('ad_type_of_event_data', {
    distinctCount: 3,
    totalCount: 24,
    values: [{ value: 'rewarded', freq: 10 }, { value: 'interstitial', freq: 8 }, { value: 'banner', freq: 6 }],
  });

  // sampleValues is ordered by freq desc and respects the limit.
  const top = idx.sampleValues('ad_type_of_event_data');
  assert.deepEqual(top.map((v) => v.value), ['rewarded', 'interstitial', 'banner']);
  assert.deepEqual(top.map((v) => v.freq), [10, 8, 6]);
  assert.deepEqual(idx.sampleValues('ad_type_of_event_data', 2).map((v) => v.value), ['rewarded', 'interstitial']);

  // stats round-trip.
  const st = idx.stats('ad_type_of_event_data');
  assert.equal(st.distinctCount, 3);
  assert.equal(st.totalCount, 24);
  assert.equal(typeof st.indexedAt, 'number');

  // searchValues finds a value by case-insensitive substring, freq desc.
  const m = idx.searchValues('REWARD');
  assert.equal(m.length, 1);
  assert.equal(m[0].property, 'ad_type_of_event_data');
  assert.equal(m[0].value, 'rewarded');
  assert.equal(m[0].freq, 10);

  // Unknown property → empty/null, never throws.
  assert.deepEqual(idx.sampleValues('nope'), []);
  assert.equal(idx.stats('nope'), null);

  // Re-upsert REPLACES prior rows for that property (no stale leftovers).
  idx.upsertProperty('ad_type_of_event_data', { distinctCount: 1, totalCount: 5, values: [{ value: 'banner', freq: 5 }] });
  assert.deepEqual(idx.sampleValues('ad_type_of_event_data').map((v) => v.value), ['banner']);
  assert.equal(idx.searchValues('rewarded').length, 0);
  idx.close();
});

// listValues: ordering (freq/value, asc/desc) + paging (limit/offset) over the store.
test('ValueIndex.listValues orders + pages the in-memory store', () => {
  const idx = new ValueIndex();
  idx.upsertProperty('p', { distinctCount: 3, totalCount: 24, values: [{ value: 'rewarded', freq: 10 }, { value: 'interstitial', freq: 8 }, { value: 'banner', freq: 6 }] });

  // default: freq desc.
  assert.deepEqual(idx.listValues('p').map((v) => v.value), ['rewarded', 'interstitial', 'banner']);
  // freq asc.
  assert.deepEqual(idx.listValues('p', { by: 'freq', dir: 'asc' }).map((v) => v.value), ['banner', 'interstitial', 'rewarded']);
  // value asc (alphabetical) — default dir for value is asc.
  assert.deepEqual(idx.listValues('p', { by: 'value' }).map((v) => v.value), ['banner', 'interstitial', 'rewarded']);
  // value desc.
  assert.deepEqual(idx.listValues('p', { by: 'value', dir: 'desc' }).map((v) => v.value), ['rewarded', 'interstitial', 'banner']);
  // paging: limit + offset over freq desc.
  assert.deepEqual(idx.listValues('p', { limit: 1 }).map((v) => v.value), ['rewarded']);
  assert.deepEqual(idx.listValues('p', { limit: 1, offset: 1 }).map((v) => v.value), ['interstitial']);
  assert.deepEqual(idx.listValues('p', { offset: 3 }), []); // past the end
  idx.close();
});

// Determinism on TIED frequencies: ordering must break ties on value ASC (so the
// in-memory fallback matches the SQLite `ORDER BY ..., value ASC` path exactly).
test('ValueIndex tie-break is deterministic (value ASC) on equal frequencies', () => {
  const idx = new ValueIndex();
  idx.upsertProperty('t', { distinctCount: 3, totalCount: 15, values: [{ value: 'zebra', freq: 5 }, { value: 'apple', freq: 5 }, { value: 'mango', freq: 5 }] });
  // freq desc, ties → value ASC.
  assert.deepEqual(idx.sampleValues('t').map((v) => v.value), ['apple', 'mango', 'zebra']);
  assert.deepEqual(idx.listValues('t', { by: 'freq', dir: 'desc' }).map((v) => v.value), ['apple', 'mango', 'zebra']);
  // freq asc, ties → still value ASC (tie-break never flips with direction).
  assert.deepEqual(idx.listValues('t', { by: 'freq', dir: 'asc' }).map((v) => v.value), ['apple', 'mango', 'zebra']);
  // searchValues ties → value ASC ('a' occurs in all three).
  assert.deepEqual(idx.searchValues('a').map((v) => v.value), ['apple', 'mango', 'zebra']);
  // paging is stable across the tie.
  assert.deepEqual(idx.listValues('t', { limit: 1, offset: 1 }).map((v) => v.value), ['mango']);
  idx.close();
});

// Sync-run log (consumed by describe_index): startRun/finishRun + syncStatus over the store.
test('ValueIndex sync-run log: startRun/finishRun + syncStatus', () => {
  const idx = new ValueIndex(); // in-memory fallback

  // No runs yet.
  let s = idx.syncStatus();
  assert.equal(s.total_runs, 0);
  assert.equal(s.running, false);
  assert.equal(s.last_run, null);
  assert.equal(s.indexed_properties, 0);

  // A run in progress shows running:true with an open last_run.
  const runId = idx.startRun();
  s = idx.syncStatus();
  assert.equal(s.running, true);
  assert.equal(s.last_run.status, 'running');
  assert.equal(s.last_run.finished_at, null);

  // Index a property mid-run, then finish.
  idx.upsertProperty('p', { distinctCount: 2, totalCount: 9, values: [{ value: 'a', freq: 5 }, { value: 'b', freq: 4 }] });
  idx.finishRun(runId, { status: 'ok', propertiesIndexed: 1, valuesWritten: 2, errors: 0 });
  s = idx.syncStatus();
  assert.equal(s.running, false);
  assert.equal(s.total_runs, 1);
  assert.equal(s.last_run.status, 'ok');
  assert.equal(s.last_run.properties_indexed, 1);
  assert.equal(s.last_run.values_written, 2);
  assert.ok(s.last_run.duration_ms >= 0);
  assert.equal(s.indexed_properties, 1);
  assert.equal(s.total_values, 2);
  assert.equal(s.last_successful_run.status, 'ok');

  // A second, failed run: last_run is the failure, last_successful_run stays the OK one.
  const r2 = idx.startRun();
  idx.finishRun(r2, { status: 'error', propertiesIndexed: 0, valuesWritten: 0, errors: 3, error: 'boom' });
  s = idx.syncStatus();
  assert.equal(s.total_runs, 2);
  assert.equal(s.last_run.status, 'error');
  assert.equal(s.last_run.error, 'boom');
  assert.equal(s.last_successful_run.status, 'ok');
  idx.close();
});
