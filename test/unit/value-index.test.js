import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ValueIndex } from '../../src/value-index.js';

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
