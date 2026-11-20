// THE KEYS OF A COMPLEX PROPERTY (src/complex-keys.js): the value index reads, off the data alone, the
// keys of an array's elements — a JSON array of objects in a column of its own (the crash source's stack
// frames), one inside the event payload (the events source's rewards) — and an array of scalars'
// elements, and counts each as a property: its values with frequencies, distinct count, the rows that
// carry it per event, a number's min / max / quantiles. Then a delta: rows added after the sync, one of
// them with a key the payload never had — counted on, and the new key counted over the whole history. A
// property the catalog declares a plain text but whose values are JSON objects (the crash custom keys) has
// its keys found and counted alike.
//
// DATA ONLY: every expectation is the warehouse's own count, read with SQL written here.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { BackgroundIndexer } from '../../src/value-indexer.js';
import { keyId } from '../../src/complex-keys.js';
import { buildWarehouse, fixtureProject } from './warehouse-harness.js';
import { settle } from '../helpers/settle.js';
import { HAS_DBT, testDbt } from '../helpers/dbt-env.js';
import { tempDir } from '../helpers/temp-dir.js';

const BASE = fixtureProject('dbt_project');
const opts = { timeout: 900000 };
const skip = (t) => { if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; } return false; };
let wh; let engine; let index; let indexer; let backend;

/** The warehouse's count of each value of `key` over the elements of `column` of `table`. */
async function truthValues(table, column, key, { blobKey = null } = {}) {
  const arr = blobKey ? `json_extract(${column}, '$."${blobKey}"[*]')` : `json_extract(${column}, '$[*]')`;
  const read = key ? `json_extract_string(e, '$."${key}"')` : "json_extract_string(e, '$')";
  const { rows } = await wh.query(`SELECT ${read} AS v, count(*) AS n FROM ${table}, unnest(${arr}) AS t(e) WHERE json_valid(${column}) AND ${read} IS NOT NULL GROUP BY 1 ORDER BY 1`);
  return Object.fromEntries(rows.map((r) => [String(r.v), Number(r.n)]));
}

/** The rows of `table` per event where some element of `column` holds `key`. */
async function truthRows(table, column, key, eventCol, { blobKey = null } = {}) {
  const arr = blobKey ? `json_extract(${column}, '$."${blobKey}"[*]')` : `json_extract(${column}, '$[*]')`;
  const { rows } = await wh.query(`SELECT ${eventCol} AS ev, count(*) AS n FROM ${table} WHERE json_valid(${column}) AND len([x FOR x IN ${arr} IF json_extract_string(x, '$."${key}"') IS NOT NULL]) > 0 GROUP BY 1 ORDER BY 1`);
  return Object.fromEntries(rows.map((r) => [String(r.ev), Number(r.n)]));
}

/** A JSON object in a text column: each value of `key` and its rows, and the rows per event that carry it. */
async function truthObject(table, column, key, eventCol) {
  const read = `json_extract_string(${column}, '$."${key}"')`;
  const values = await wh.query(`SELECT ${read} AS v, count(*) AS n FROM ${table} WHERE json_valid(${column}) AND json_type(${column}) = 'OBJECT' AND ${read} IS NOT NULL GROUP BY 1 ORDER BY 1`);
  const rows = await wh.query(`SELECT ${eventCol} AS ev, count(*) AS n FROM ${table} WHERE json_valid(${column}) AND json_type(${column}) = 'OBJECT' AND ${read} IS NOT NULL GROUP BY 1 ORDER BY 1`);
  const keys = await wh.query(`SELECT DISTINCT unnest(json_keys(${column})) AS k FROM ${table} WHERE json_valid(${column}) AND json_type(${column}) = 'OBJECT' ORDER BY 1`);
  return {
    values: Object.fromEntries(values.rows.map((r) => [String(r.v), Number(r.n)])),
    carried: Object.fromEntries(rows.rows.map((r) => [String(r.ev), Number(r.n)])),
    keys: keys.rows.map((r) => String(r.k)),
  };
}

const stored = (source, property, field) => Object.fromEntries(index.listValues(source, keyId(property, field), { limit: 1000 }).map((v) => [v.value, v.freq]));
const carried = (source, property, field) => Object.fromEntries(index.coverage(source, keyId(property, field)).filter((e) => e.non_null > 0).map((e) => [e.event_name, e.non_null]));

before(async () => {
  if (!HAS_DBT) return;
  wh = await buildWarehouse(BASE);
  backend = testDbt({ profilesDir: BASE });
  const catalog = loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), { profilesDir: BASE, projectDir: BASE });
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: tempDir('ck'), timeSpineDialect: 'duckdb' });
  engine = settle(new Engine({ catalog, contextManager: ctxs, runner: backend, dbPath: join(tempDir('ck-db'), 'index.sqlite') }));
  index = engine.valueIndex;
  indexer = new BackgroundIndexer({ catalog, runner: backend, index, baseProjectDir: BASE, intervalMs: 0, maxValues: 50, merge: true, logger: () => {} });
  await indexer.refresh();
}, opts);

after(async () => { backend?.close?.(); engine?.close(); if (wh) await wh.stop(); });

test('the keys of a JSON array of objects are read off the data, each counted as a property is', opts, async (t) => {
  if (skip(t)) return;
  assert.deepEqual(index.keys('crashlytics', 'stack_frames_of_event_data').map((k) => k.field), ['file', 'in_app', 'line']);
  for (const key of ['file', 'in_app', 'line']) {
    assert.deepEqual(stored('crashlytics', 'stack_frames_of_event_data', key), await truthValues('fct_crashlytics_events', 'stack_frames_of_event_data', key), key);
    assert.deepEqual(carried('crashlytics', 'stack_frames_of_event_data', key), await truthRows('fct_crashlytics_events', 'stack_frames_of_event_data', key, 'event_name'), `${key}: the rows per event that carry it`);
  }
  const files = await truthValues('fct_crashlytics_events', 'stack_frames_of_event_data', 'file');
  assert.equal(index.stats('crashlytics', keyId('stack_frames_of_event_data', 'file')).distinctCount, Object.keys(files).length);
  // a number: its count, min and max are the warehouse's
  const lines = Object.entries(await truthValues('fct_crashlytics_events', 'stack_frames_of_event_data', 'line')).flatMap(([v, n]) => Array(n).fill(Number(v)));
  const num = index.keys('crashlytics', 'stack_frames_of_event_data').find((k) => k.field === 'line').numeric;
  assert.equal(num.count, lines.length);
  assert.equal(num.min, Math.min(...lines));
  assert.equal(num.max, Math.max(...lines));
  assert.equal(num.quantiles.length, 101);
});

test('the keys of an array inside the event payload, and an array of scalars\' elements', opts, async (t) => {
  if (skip(t)) return;
  const blob = engine.raw.catalog.eventDataColumn('events');
  assert.deepEqual(index.keys('events', 'rewards').map((k) => k.field), ['item', 'qty']);
  for (const key of ['item', 'qty']) assert.deepEqual(stored('events', 'rewards', key), await truthValues('fct_analytics_events', blob, key, { blobKey: 'rewards' }), key);
  // an array of strings: its elements are the one key '' — the words, counted
  assert.deepEqual(index.keys('crashlytics', 'breadcrumbs_of_event_data').map((k) => k.field), ['']);
  assert.deepEqual(stored('crashlytics', 'breadcrumbs_of_event_data', ''), await truthValues('fct_crashlytics_events', 'breadcrumbs_of_event_data', ''));
});

test('a text property the data shows holding a JSON object: its keys are found and counted, its own values kept', opts, async (t) => {
  if (skip(t)) return;
  const prop = 'custom_keys_of_event_data';
  const { keys } = await truthObject('fct_crashlytics_events', prop, 'level', 'event_name');
  assert.ok(keys.length > 0, 'the fixture holds objects');
  assert.deepEqual(index.keys('crashlytics', prop).map((k) => k.field), keys);
  for (const key of keys) {
    const truth = await truthObject('fct_crashlytics_events', prop, key, 'event_name');
    assert.deepEqual(stored('crashlytics', prop, key), truth.values, key);
    assert.deepEqual(carried('crashlytics', prop, key), truth.carried, `${key}: the rows per event that carry it`);
  }
  // its own row is still the text property's: its values are the whole objects, as before
  const { rows } = await wh.query(`SELECT ${prop} AS v, count(*) AS n FROM fct_crashlytics_events WHERE ${prop} IS NOT NULL GROUP BY 1`);
  assert.deepEqual(Object.fromEntries(index.listValues('crashlytics', prop, { limit: 1000 }).map((v) => [v.value, v.freq])), Object.fromEntries(rows.map((r) => [String(r.v), Number(r.n)])));
  // the views: the property says it holds JSON and lists its keys; a key is a view of its own
  const view = await engine.semantic_index({ source: 'crashlytics', property: prop });
  assert.equal(view.holds_json, true);
  assert.deepEqual(view.keys.map((k) => k.field), keys);
  const one = await engine.semantic_index({ source: 'crashlytics', property: prop, field: keys[0], limit: 100 });
  assert.deepEqual(Object.fromEntries(one.sample_values.map((v) => [v.value, v.freq])), (await truthObject('fct_crashlytics_events', prop, keys[0], 'event_name')).values);
  // a text that holds no JSON has no keys
  await assert.rejects(Promise.resolve().then(() => engine.semantic_index({ source: 'crashlytics', property: 'issue_title_of_event_data', field: 'x' })), /no array or struct, and the index has seen no JSON in it/);
});

test('semantic_index: the property lists its keys, a key is a view of its own, and search finds it by its name', opts, async (t) => {
  if (skip(t)) return;
  const prop = await engine.semantic_index({ source: 'crashlytics', property: 'stack_frames_of_event_data' });
  assert.deepEqual(prop.keys.map((k) => k.field), ['file', 'in_app', 'line']);
  const files = await truthValues('fct_crashlytics_events', 'stack_frames_of_event_data', 'file');
  assert.equal(prop.keys.find((k) => k.field === 'file').values_counted, Object.values(files).reduce((a, b) => a + b, 0), 'the frames that name a file');
  const key = await engine.semantic_index({ source: 'crashlytics', property: 'stack_frames_of_event_data', field: 'file', limit: 100 });
  assert.deepEqual(Object.fromEntries(key.sample_values.map((v) => [v.value, v.freq])), files);
  assert.deepEqual(Object.fromEntries(key.event_coverage.map((e) => [e.event_name, e.non_null])), await truthRows('fct_crashlytics_events', 'stack_frames_of_event_data', 'file', 'event_name'));
  const line = await engine.semantic_index({ source: 'crashlytics', property: 'stack_frames_of_event_data', field: 'line' });
  const lines = Object.entries(await truthValues('fct_crashlytics_events', 'stack_frames_of_event_data', 'line')).flatMap(([v, n]) => Array(n).fill(Number(v)));
  assert.equal(line.numeric.min, Math.min(...lines));
  assert.equal(line.numeric.max, Math.max(...lines));
  // an array of strings: its elements' values in the property's own view
  const crumbs = await engine.semantic_index({ source: 'crashlytics', property: 'breadcrumbs_of_event_data' });
  const truth = await truthValues('fct_crashlytics_events', 'breadcrumbs_of_event_data', '');
  assert.equal(crumbs.element_values.distinct_count, Object.keys(truth).length);
  assert.deepEqual(Object.fromEntries(crumbs.element_values.top.map((v) => [v.value, v.freq])), Object.fromEntries(Object.entries(truth).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10)));
  // search: a key by its name
  const found = await engine.semantic_index({ search: 'in_app' });
  assert.ok(found.property_matches.some((m) => m.source === 'crashlytics' && m.property === 'stack_frames_of_event_data' && m.field === 'in_app'), JSON.stringify(found.property_matches));
  await assert.rejects(Promise.resolve().then(() => engine.semantic_index({ source: 'crashlytics', property: 'stack_frames_of_event_data', field: 'nope' })), /no key the index has seen.*file, in_app, line/);
});

test('a delta adds to what is kept; a key the payload never had is counted over the whole history', opts, async (t) => {
  if (skip(t)) return;
  const before = await truthValues('fct_crashlytics_events', 'stack_frames_of_event_data', 'file');
  // two reports arrive a month later — one with a frame that carries a key never seen before
  await wh.exec(`INSERT INTO fct_crashlytics_events SELECT * REPLACE (event_time + INTERVAL 30 DAY AS event_time, '[{"file":"Late.kt","line":3,"in_app":true,"module":"core"},{"file":"Late.kt","line":4,"in_app":false}]' AS stack_frames_of_event_data) FROM fct_crashlytics_events WHERE event_name = 'fatal_crash' ORDER BY event_time LIMIT 2`);
  await indexer.refresh();
  const after = await truthValues('fct_crashlytics_events', 'stack_frames_of_event_data', 'file');
  assert.notDeepEqual(after, before, 'the warehouse has the new frames');
  assert.deepEqual(stored('crashlytics', 'stack_frames_of_event_data', 'file'), after, 'the delta was added to what was kept, every value');
  assert.deepEqual(carried('crashlytics', 'stack_frames_of_event_data', 'file'), await truthRows('fct_crashlytics_events', 'stack_frames_of_event_data', 'file', 'event_name'));
  // the new key: found in the delta, counted over everything there is
  assert.ok(index.keys('crashlytics', 'stack_frames_of_event_data').some((k) => k.field === 'module'), 'the new key is in the index after the next sync');
  assert.deepEqual(stored('crashlytics', 'stack_frames_of_event_data', 'module'), await truthValues('fct_crashlytics_events', 'stack_frames_of_event_data', 'module'));
  // a text that holds an object is kept up by the delta too (its keys' own watermark)
  for (const key of index.keys('crashlytics', 'custom_keys_of_event_data').map((k) => k.field)) {
    const truth = await truthObject('fct_crashlytics_events', 'custom_keys_of_event_data', key, 'event_name');
    assert.deepEqual(stored('crashlytics', 'custom_keys_of_event_data', key), truth.values, `custom key ${key} after the delta`);
    assert.deepEqual(carried('crashlytics', 'custom_keys_of_event_data', key), truth.carried, `custom key ${key}: rows per event after the delta`);
  }
  // its key pass stands where the declared arrays' do: at the newest row the delta read
  assert.equal(index.keyPassMark('crashlytics', 'custom_keys_of_event_data'), index.stats('crashlytics', 'stack_frames_of_event_data').dataWatermark);
  const line = index.keys('crashlytics', 'stack_frames_of_event_data').find((k) => k.field === 'line').numeric;
  const lines = Object.entries(await truthValues('fct_crashlytics_events', 'stack_frames_of_event_data', 'line')).flatMap(([v, n]) => Array(n).fill(Number(v)));
  assert.equal(line.count, lines.length, 'a number\'s count adds up across the delta');
  assert.equal(line.min, Math.min(...lines));
  assert.equal(line.max, Math.max(...lines));
});

test('a text that reads as a non-finite number (Infinity, nan) keeps every value of the scan', opts, async (t) => {
  if (skip(t)) return;
  // a report whose frames name files a number cast reads as ±Infinity / NaN: the values of the whole scan are kept
  await wh.exec(`INSERT INTO fct_crashlytics_events SELECT * REPLACE (event_time + INTERVAL 31 DAY AS event_time, '[{"file":"Infinity","line":5,"in_app":true},{"file":"nan","line":6,"in_app":false},{"file":"-inf","line":7,"in_app":false}]' AS stack_frames_of_event_data) FROM fct_crashlytics_events WHERE event_name = 'fatal_crash' ORDER BY event_time LIMIT 1`);
  await indexer.refresh();
  for (const key of ['file', 'line', 'in_app']) {
    assert.deepEqual(stored('crashlytics', 'stack_frames_of_event_data', key), await truthValues('fct_crashlytics_events', 'stack_frames_of_event_data', key), key);
  }
  // a number's summary counts the numbers only — a word is no number, whatever a cast makes of it
  const lines = Object.entries(await truthValues('fct_crashlytics_events', 'stack_frames_of_event_data', 'line')).flatMap(([v, n]) => Array(n).fill(Number(v)));
  const line = index.keys('crashlytics', 'stack_frames_of_event_data').find((k) => k.field === 'line').numeric;
  assert.equal(line.count, lines.length);
  assert.equal(line.max, Math.max(...lines));
  const file = index.keys('crashlytics', 'stack_frames_of_event_data').find((k) => k.field === 'file');
  assert.equal(file.numeric?.count ?? 0, 0, 'no file name is counted as a number');
});
