// Lifecycle check (allowed as a non-data test): the value index is keyed by (SOURCE, property),
// and a database written by the previous single-namespace layout is carried over without loss.
// v1 kept one flat `property` text key and encoded the source inside it ('users.country'); the
// carry-over asks the caller — which holds the catalog — who owns each old key.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../../src/store.js';
import { ValueIndex } from '../../src/value-index.js';

const dbFile = () => join(mkdtempSync(join(tmpdir(), 'vi-mig-')), 'value-index.sqlite');

// Two sources may carry the SAME property name; each keeps its own row.
test('the index keys values by (source, property) — same name on two sources never collides', () => {
  const index = new ValueIndex();
  index.upsertProperty('events', 'status_of_event_data', { distinctCount: 2, totalCount: 10, nullCount: 0, values: [{ value: 'success', freq: 7 }, { value: 'crash', freq: 3 }] });
  index.upsertProperty('crashlytics', 'status_of_event_data', { distinctCount: 1, totalCount: 4, nullCount: 0, values: [{ value: 'fatal', freq: 4 }] });

  assert.equal(index.stats('events', 'status_of_event_data').totalCount, 10);
  assert.equal(index.stats('crashlytics', 'status_of_event_data').totalCount, 4);
  assert.deepEqual(index.sampleValues('crashlytics', 'status_of_event_data', 5), [{ value: 'fatal', freq: 4 }]);
  assert.equal(index.sampleValues('events', 'status_of_event_data', 5).length, 2);
  // and each is listed as its own key
  const keys = index.properties();
  assert.ok(keys.some((k) => k.source === 'events' && k.property === 'status_of_event_data'));
  assert.ok(keys.some((k) => k.source === 'crashlytics' && k.property === 'status_of_event_data'));
  // dropping one leaves the other intact
  index.removeProperty('events', 'status_of_event_data');
  assert.equal(index.stats('events', 'status_of_event_data'), null);
  assert.equal(index.stats('crashlytics', 'status_of_event_data').totalCount, 4);
  index.close();
});

test('a v1 (single-namespace) database is carried over into (source, property)', () => {
  const path = dbFile();
  // Write a database in the OLD layout: one `property` key, the source glued into the name.
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE prop_stats (property TEXT PRIMARY KEY, distinct_count INTEGER, total_count INTEGER, null_count INTEGER, indexed_at INTEGER, high_cardinality INTEGER, data_watermark INTEGER)');
  db.exec('CREATE TABLE prop_values (property TEXT, value TEXT, freq INTEGER, PRIMARY KEY(property, value))');
  db.exec('CREATE TABLE prop_coverage (property TEXT, event_name TEXT, row_count INTEGER, non_null INTEGER, PRIMARY KEY(property, event_name))');
  db.exec("INSERT INTO prop_stats VALUES ('ad_type_of_event_data', 3, 24, 6, 111, 0, 900)");
  db.exec("INSERT INTO prop_stats VALUES ('users.country', 4, 12, 0, 111, 0, NULL)");
  db.exec("INSERT INTO prop_values VALUES ('ad_type_of_event_data', 'rewarded', 10)");
  db.exec("INSERT INTO prop_values VALUES ('users.country', 'US', 4)");
  db.exec("INSERT INTO prop_coverage VALUES ('ad_type_of_event_data', 'ad_finished', 12, 12)");
  db.close();

  const store = openStore({ dbPath: path });
  const index = new ValueIndex({ store });
  // The resolver stands in for the catalog: a bare name belongs to the events source, and a
  // '<model>.<column>' name to that model.
  const res = index.migrateLegacyKeys((key) => {
    const dot = key.indexOf('.');
    if (dot > 0) return { source: key.slice(0, dot), property: key.slice(dot + 1) };
    return { source: 'events', property: key };
  });
  assert.ok(res.migrated > 0, 'rows were carried over');
  assert.equal(res.dropped, 0);

  // stats, values and coverage all landed under the right source, with the numbers intact.
  const st = index.stats('events', 'ad_type_of_event_data');
  assert.equal(st.totalCount, 24);
  assert.equal(st.nullCount, 6);
  assert.equal(st.dataWatermark, 900, 'the incremental watermark survives, so no full re-scan');
  assert.deepEqual(index.sampleValues('events', 'ad_type_of_event_data', 5), [{ value: 'rewarded', freq: 10 }]);
  assert.deepEqual(index.coverage('events', 'ad_type_of_event_data'), [{ event_name: 'ad_finished', row_count: 12, non_null: 12, null_count: 0 }]);
  assert.equal(index.stats('users', 'country').totalCount, 12);
  assert.deepEqual(index.sampleValues('users', 'country', 5), [{ value: 'US', freq: 4 }]);
  // the glued name is NOT a key any more
  assert.equal(index.stats('events', 'users.country'), null);

  // Running it again is a no-op (the carried-over tables are gone).
  assert.deepEqual(index.migrateLegacyKeys(() => null), { migrated: 0, dropped: 0 });
  index.close();
});

test('a legacy key the catalog cannot place is dropped, not mis-filed', () => {
  const path = dbFile();
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE prop_stats (property TEXT PRIMARY KEY, distinct_count INTEGER, total_count INTEGER, null_count INTEGER, indexed_at INTEGER, high_cardinality INTEGER, data_watermark INTEGER)');
  db.exec("INSERT INTO prop_stats VALUES ('gone_column', 1, 1, 0, 111, 0, NULL)");
  db.close();

  const store = openStore({ dbPath: path });
  const index = new ValueIndex({ store });
  // The index is a rebuildable cache: an unplaceable key is dropped rather than guessed at.
  const res = index.migrateLegacyKeys(() => null);
  assert.equal(res.migrated, 0);
  assert.equal(res.dropped, 1);
  assert.deepEqual(index.properties(), []);
  index.close();
});

// The per-run diagnostics table is keyed by (run, source, property) too. A v1 database keyed it by
// (run, property) — and ADD COLUMN cannot widen a PRIMARY KEY, so the upsert's ON CONFLICT clause
// was rejected by SQLite on the first write, which aborted the whole sync. The old table is set
// aside and a correctly keyed one created.
test('a v1 index_run_props table is replaced, so per-property run rows can be written', () => {
  const path = dbFile();
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE index_run_props (run_id INTEGER, property TEXT, ms INTEGER, values_written INTEGER, distinct_count INTEGER, total_count INTEGER, status TEXT, error TEXT, PRIMARY KEY(run_id, property))');
  db.exec("INSERT INTO index_run_props VALUES (7, 'ad_type_of_event_data', 12, 3, 3, 24, 'ok', NULL)");
  db.close();

  const store = openStore({ dbPath: path });
  // the write that used to throw 'ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint'
  store.runs.recordProperty(8, { source: 'events', property: 'ad_type_of_event_data', ms: 5, valuesWritten: 2, status: 'ok' });
  store.runs.recordProperty(8, { source: 'crashlytics', property: 'ad_type_of_event_data', ms: 6, valuesWritten: 1, status: 'ok' });
  store.runs.recordProperty(8, { source: 'events', property: 'ad_type_of_event_data', ms: 9, valuesWritten: 4, status: 'ok' }); // the upsert path
  const rows = store.runs.properties(8);
  assert.equal(rows.length, 2, 'one row per (source, property)');
  assert.equal(rows.find((r) => r.source === 'events').values_written, 4, 'the second write updated, not duplicated');
  // the old rows are set aside, not silently mixed into the new key space
  const v1 = new DatabaseSync(path).prepare('SELECT count(*) AS n FROM index_run_props_v1').get();
  assert.equal(Number(v1.n), 1);
  store.close?.();
});

// MCP_DB_RESET must not resurrect: the v1 tables set aside by the constructor are dropped by
// reset(), so the legacy carry-over that follows has nothing to bring back.
test('reset() drops the set-aside v1 tables, so nothing is carried back after a reset', () => {
  const path = dbFile();
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE prop_stats (property TEXT PRIMARY KEY, distinct_count INTEGER, total_count INTEGER, null_count INTEGER, indexed_at INTEGER, high_cardinality INTEGER, data_watermark INTEGER)');
  db.exec('CREATE TABLE prop_values (property TEXT, value TEXT, freq INTEGER, PRIMARY KEY(property, value))');
  db.exec("INSERT INTO prop_stats VALUES ('users.country', 2, 20, 0, 111, 0, NULL)");
  db.exec("INSERT INTO prop_values VALUES ('users.country', 'US', 12), ('users.country', 'GB', 8)");
  db.close();

  const store = openStore({ dbPath: path, reset: true });
  const migrated = store.values.migrateLegacyKeys(() => ({ source: 'users', property: 'country' }));
  assert.equal(migrated.migrated ?? 0, 0, 'nothing legacy is left to migrate after a reset');
  assert.deepEqual(store.values.top('users', 'country', 10), [], 'the reset store is empty');
  store.close?.();
});

// ── The shape a LIVE database actually had: `source` appended through ADD COLUMN, the PRIMARY KEY
// left as it was. An "is the column there" test skips exactly this table, while every
// ON CONFLICT(run_id, source, property) write against it is rejected — silently, because run
// diagnostics never abort indexing. The migration must decide by the KEY, not by the column.
test('index_run_props with `source` added by ALTER but the old PRIMARY KEY is replaced (the live-DB shape)', () => {
  const path = dbFile();
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE index_run_props (run_id INTEGER, property TEXT, ms INTEGER, values_written INTEGER, distinct_count INTEGER, total_count INTEGER, status TEXT, error TEXT, PRIMARY KEY(run_id, property))');
  db.exec('ALTER TABLE index_run_props ADD COLUMN source TEXT'); // what 56e3a4c did to an existing DB
  db.exec("INSERT INTO index_run_props (run_id, property, ms, values_written, status, source) VALUES (103, 'ad_type_of_event_data', 12, 3, 'ok', 'events')");
  // precondition: this exact shape rejects the three-column conflict target
  assert.throws(() => db.exec("INSERT INTO index_run_props (run_id, source, property, ms) VALUES (104, 'events', 'x', 1) ON CONFLICT(run_id, source, property) DO UPDATE SET ms = excluded.ms"), /ON CONFLICT clause does not match/);
  db.close();

  const store = openStore({ dbPath: path });
  store.runs.recordProperty(104, { source: 'events', property: 'ad_type_of_event_data', ms: 5, valuesWritten: 2, status: 'ok' });
  store.runs.recordProperty(104, { source: 'crashlytics', property: 'ad_type_of_event_data', ms: 6, valuesWritten: 1, status: 'ok' });
  store.runs.recordProperty(104, { source: 'events', property: 'ad_type_of_event_data', ms: 9, valuesWritten: 4, status: 'ok' });
  const rows = store.runs.properties(104);
  assert.equal(rows.length, 2, 'per-property rows are written again (one per source × property)');
  assert.equal(rows.find((r) => r.source === 'events').values_written, 4, 'the upsert updates, not duplicates');
  const raw = new DatabaseSync(path);
  const pk = raw.prepare('PRAGMA table_info(index_run_props)').all().filter((c) => c.pk > 0).map((c) => c.name).sort();
  assert.deepEqual(pk, ['property', 'run_id', 'source'], 'the live table is now keyed by (run, source, property)');
  assert.equal(Number(raw.prepare('SELECT count(*) AS n FROM index_run_props_v1').get().n), 1, 'the old rows are set aside, not lost into the new key space');
  raw.close();
  store.close?.();
});

test('prop tables with `source` added by ALTER but the old key are re-keyed and their rows carried by the stored source', () => {
  const path = dbFile();
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE prop_stats (property TEXT PRIMARY KEY, distinct_count INTEGER, total_count INTEGER, null_count INTEGER, indexed_at INTEGER, high_cardinality INTEGER, data_watermark INTEGER)');
  db.exec('ALTER TABLE prop_stats ADD COLUMN source TEXT');
  db.exec('CREATE TABLE prop_values (property TEXT, value TEXT, freq INTEGER, PRIMARY KEY(property, value))');
  db.exec('ALTER TABLE prop_values ADD COLUMN source TEXT');
  db.exec("INSERT INTO prop_stats (property, distinct_count, total_count, null_count, indexed_at, high_cardinality, data_watermark, source) VALUES ('status_of_event_data', 2, 10, 0, 111, 0, 500, 'crashlytics')");
  db.exec("INSERT INTO prop_values (property, value, freq, source) VALUES ('status_of_event_data', 'fatal', 7, 'crashlytics')");
  db.close();

  const store = openStore({ dbPath: path });
  const index = new ValueIndex({ store });
  // The stored source wins: the resolver is NOT what places these rows (it would file them wrongly).
  const res = index.migrateLegacyKeys(() => ({ source: 'events', property: 'wrong' }));
  assert.equal(res.migrated, 2);
  assert.equal(res.dropped, 0);
  assert.equal(index.stats('crashlytics', 'status_of_event_data').totalCount, 10);
  assert.equal(index.stats('crashlytics', 'status_of_event_data').dataWatermark, 500);
  assert.deepEqual(index.sampleValues('crashlytics', 'status_of_event_data', 5), [{ value: 'fatal', freq: 7 }]);
  assert.equal(index.stats('events', 'wrong'), null);
  // and the re-keyed table accepts the (source, property) upsert that the old key rejected
  index.upsertProperty('events', 'status_of_event_data', { distinctCount: 1, totalCount: 3, nullCount: 0, values: [{ value: 'success', freq: 3 }] });
  assert.equal(index.stats('events', 'status_of_event_data').totalCount, 3);
  assert.equal(index.stats('crashlytics', 'status_of_event_data').totalCount, 10, 'same name on another source untouched');
  index.close();
});
