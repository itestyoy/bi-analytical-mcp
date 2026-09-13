// Lifecycle checks (allowed as non-data tests): the value index is keyed by (SOURCE, property).
// A table keyed any other way — a `property`-only key, or `source` appended through ADD COLUMN
// with the old PRIMARY KEY left in place — rejects every (source, …) upsert, so it is dropped and
// recreated: the index is a rebuildable cache, and the background scan repopulates it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../../src/store.js';
import { ValueIndex } from '../../src/value-index.js';

const dbFile = () => join(mkdtempSync(join(tmpdir(), 'vi-key-')), 'value-index.sqlite');
const pkOf = (path, table) => { const db = new DatabaseSync(path); const pk = db.prepare(`PRAGMA table_info(${table})`).all().filter((c) => c.pk > 0).map((c) => c.name).sort(); db.close(); return pk; };

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

test('prop tables keyed by a flat `property` are recreated keyed by (source, property); nothing is carried', () => {
  const path = dbFile();
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE prop_stats (property TEXT PRIMARY KEY, distinct_count INTEGER, total_count INTEGER, null_count INTEGER, indexed_at INTEGER, high_cardinality INTEGER, data_watermark INTEGER)');
  db.exec('CREATE TABLE prop_values (property TEXT, value TEXT, freq INTEGER, PRIMARY KEY(property, value))');
  db.exec("INSERT INTO prop_stats VALUES ('users.country', 4, 12, 0, 111, 0, NULL)");
  db.exec("INSERT INTO prop_values VALUES ('users.country', 'US', 4)");
  db.close();

  const store = openStore({ dbPath: path });
  const index = new ValueIndex({ store });
  assert.deepEqual(index.properties(), [], 'the old rows are gone, not mis-filed under a guessed source');
  assert.deepEqual(pkOf(path, 'prop_stats'), ['property', 'source']);
  assert.deepEqual(pkOf(path, 'prop_values'), ['property', 'source', 'value']);
  // the recreated tables take the (source, property) upsert the old key rejected
  index.upsertProperty('users', 'country', { distinctCount: 2, totalCount: 9, nullCount: 0, values: [{ value: 'US', freq: 6 }, { value: 'DE', freq: 3 }] });
  index.upsertProperty('events', 'country', { distinctCount: 1, totalCount: 2, nullCount: 0, values: [{ value: 'GB', freq: 2 }] });
  assert.equal(index.stats('users', 'country').totalCount, 9);
  assert.equal(index.stats('events', 'country').totalCount, 2, 'same name on another source keeps its own row');
  const check = new DatabaseSync(path);
  assert.deepEqual(check.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%_v1'").all(), [], 'no set-aside copies linger');
  check.close();
  index.close();
});

// The shape a LIVE database actually had: `source` appended through ADD COLUMN, the PRIMARY KEY
// left as it was. An "is the column there" test would skip exactly this table, while every
// ON CONFLICT(source, …) write against it is rejected. The decision is by the KEY, not the column.
test('a table with `source` added by ALTER but the old PRIMARY KEY is recreated (the live-DB shape)', () => {
  const path = dbFile();
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE prop_stats (property TEXT PRIMARY KEY, distinct_count INTEGER, total_count INTEGER, null_count INTEGER, indexed_at INTEGER, high_cardinality INTEGER, data_watermark INTEGER)');
  db.exec('ALTER TABLE prop_stats ADD COLUMN source TEXT');
  db.exec('CREATE TABLE prop_values (property TEXT, value TEXT, freq INTEGER, PRIMARY KEY(property, value))');
  db.exec('ALTER TABLE prop_values ADD COLUMN source TEXT');
  db.exec("INSERT INTO prop_stats (property, distinct_count, total_count, null_count, indexed_at, high_cardinality, data_watermark, source) VALUES ('status_of_event_data', 2, 10, 0, 111, 0, 500, 'crashlytics')");
  // precondition: this exact shape rejects the two-column conflict target
  assert.throws(() => db.exec("INSERT INTO prop_stats (source, property, distinct_count) VALUES ('events', 'x', 1) ON CONFLICT(source, property) DO UPDATE SET distinct_count = excluded.distinct_count"), /ON CONFLICT clause does not match/);
  db.close();

  const store = openStore({ dbPath: path });
  const index = new ValueIndex({ store });
  assert.equal(index.stats('crashlytics', 'status_of_event_data'), null, 'not carried: the next scan rebuilds it');
  assert.deepEqual(pkOf(path, 'prop_stats'), ['property', 'source']);
  index.upsertProperty('crashlytics', 'status_of_event_data', { distinctCount: 1, totalCount: 3, nullCount: 0, values: [{ value: 'fatal', freq: 3 }] });
  index.upsertProperty('crashlytics', 'status_of_event_data', { distinctCount: 1, totalCount: 5, nullCount: 0, values: [{ value: 'fatal', freq: 5 }] }); // the upsert path
  assert.equal(index.stats('crashlytics', 'status_of_event_data').totalCount, 5);
  assert.deepEqual(index.sampleValues('crashlytics', 'status_of_event_data', 5), [{ value: 'fatal', freq: 5 }]);
  index.close();
});

// The per-run diagnostics table is keyed by (run, source, property) too; the old (run, property)
// key made the upsert's ON CONFLICT clause fail on the first write, which aborted the whole sync.
test('index_run_props keyed by (run, property) is recreated, so per-property run rows can be written', () => {
  const path = dbFile();
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE index_run_props (run_id INTEGER, property TEXT, ms INTEGER, values_written INTEGER, distinct_count INTEGER, total_count INTEGER, status TEXT, error TEXT, PRIMARY KEY(run_id, property))');
  db.exec('ALTER TABLE index_run_props ADD COLUMN source TEXT');
  db.exec("INSERT INTO index_run_props (run_id, property, ms, values_written, status, source) VALUES (7, 'ad_type_of_event_data', 12, 3, 'ok', 'events')");
  db.close();

  const store = openStore({ dbPath: path });
  store.runs.recordProperty(8, { source: 'events', property: 'ad_type_of_event_data', ms: 5, valuesWritten: 2, status: 'ok' });
  store.runs.recordProperty(8, { source: 'crashlytics', property: 'ad_type_of_event_data', ms: 6, valuesWritten: 1, status: 'ok' });
  store.runs.recordProperty(8, { source: 'events', property: 'ad_type_of_event_data', ms: 9, valuesWritten: 4, status: 'ok' }); // the upsert path
  const rows = store.runs.properties(8);
  assert.equal(rows.length, 2, 'one row per (source, property)');
  assert.equal(rows.find((r) => r.source === 'events').values_written, 4, 'the second write updated, not duplicated');
  assert.deepEqual(store.runs.properties(7), [], 'old run diagnostics are not carried');
  assert.deepEqual(pkOf(path, 'index_run_props'), ['property', 'run_id', 'source']);
  store.close?.();
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
