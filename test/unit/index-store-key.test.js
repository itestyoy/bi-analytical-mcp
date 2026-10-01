// Lifecycle checks (allowed as non-data tests): the value index is keyed by (SOURCE, property), so the
// same property name on two sources never shares a row.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/store.js';
import { ValueIndex } from '../../src/value-index.js';

const dbFile = () => join(mkdtempSync(join(tmpdir(), 'vi-key-')), 'value-index.sqlite');

// Two sources may carry the SAME property name; each keeps its own row.
test('the index keys values by (source, property) — same name on two sources never collides', () => {
  const index = new ValueIndex();
  index.upsertProperty('events', 'status_of_event_data', { distinctCount: 2, totalCount: 10, nullCount: 0, values: [{ value: 'success', freq: 7 }, { value: 'crash', freq: 3 }] });
  index.upsertProperty('crashlytics', 'status_of_event_data', { distinctCount: 1, totalCount: 4, nullCount: 0, values: [{ value: 'fatal', freq: 4 }] });

  assert.equal(index.stats('events', 'status_of_event_data').totalCount, 10);
  assert.equal(index.stats('crashlytics', 'status_of_event_data').totalCount, 4);
  assert.deepEqual(index.sampleValues('crashlytics', 'status_of_event_data', 5), [{ value: 'fatal', freq: 4 }]);
  assert.equal(index.sampleValues('events', 'status_of_event_data', 5).length, 2);
  const keys = index.properties();
  assert.ok(keys.some((k) => k.source === 'events' && k.property === 'status_of_event_data'));
  assert.ok(keys.some((k) => k.source === 'crashlytics' && k.property === 'status_of_event_data'));
  index.removeProperty('events', 'status_of_event_data');
  assert.equal(index.stats('events', 'status_of_event_data'), null);
  assert.equal(index.stats('crashlytics', 'status_of_event_data').totalCount, 4);
  index.close();
});

test('a correctly keyed database is opened as-is: its rows survive a restart', () => {
  const path = dbFile();
  let index = new ValueIndex({ store: openStore({ dbPath: path }) });
  index.upsertProperty('users', 'country', { distinctCount: 1, totalCount: 4, nullCount: 0, values: [{ value: 'US', freq: 4 }] });
  index.close();
  index = new ValueIndex({ store: openStore({ dbPath: path }) });
  assert.equal(index.stats('users', 'country').totalCount, 4);
  assert.deepEqual(index.sampleValues('users', 'country', 5), [{ value: 'US', freq: 4 }]);
  index.close();
});

// A run row is keyed by (run, SOURCE, property). SQLite allows NULL in a non-INTEGER primary key
// and NULLs never conflict, so a row written without its source would be inserted afresh on every
// write — double-counted in the run breakdown and invisible to the per-property history. It is a
// caller mistake, refused as one (an input-validation guard).
test('a run diagnostics row without its source is refused, not filed under NULL', () => {
  for (const store of [openStore({}), openStore({ dbPath: dbFile() })]) {
    assert.throws(() => store.runs.recordProperty(1, { property: 'ad_type_of_event_data', ms: 5 }), /needs both source and property/);
    assert.throws(() => store.runs.recordProperty(1, { source: 'events', ms: 5 }), /needs both source and property/);
    store.runs.recordProperty(1, { source: 'events', property: 'ad_type_of_event_data', ms: 5, status: 'ok' });
    store.runs.recordProperty(1, { source: 'events', property: 'ad_type_of_event_data', ms: 9, status: 'ok' });
    assert.equal(store.runs.properties(1).length, 1, 'the second write updated the row it keys');
    assert.equal(store.runs.properties(1)[0].ms, 9);
    store.close?.();
  }
});
