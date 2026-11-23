// THE KEYS OF A COMPLEX PROPERTY (src/complex-keys.js): the id a key is stored under, the fields of a
// native struct type, and a numeric key's summary merged with a delta's — and the store's registry of
// keys (prop_keys), alike on both backends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { keyId, parseKeyId, holdsJson, isStructType, structFieldsOfType, mergeQuantiles, mergeNumeric, percentilesOf, QUANTILE_POINTS } from '../../src/complex-keys.js';
import { openStore } from '../../src/store.js';
import { ValueIndex } from '../../src/value-index.js';
import { tempDir } from '../helpers/temp-dir.js';

test('a key id names its property and field, and a property\'s own id is no key', () => {
  assert.deepEqual(parseKeyId(keyId('words_selected', 'word_dictionary')), { property: 'words_selected', field: 'word_dictionary' });
  assert.deepEqual(parseKeyId(keyId('breadcrumbs', '')), { property: 'breadcrumbs', field: '' });
  assert.equal(parseKeyId('level_id'), null);
});

test('the fields of a native struct type, on either warehouse', () => {
  assert.deepEqual(structFieldsOfType('ARRAY<STRUCT<word_number INT64, word_name STRING, extra STRUCT<a INT64, b STRING>, tags ARRAY<STRING>>>'), [
    { name: 'word_number', type: 'INT64', scalar: true },
    { name: 'word_name', type: 'STRING', scalar: true },
    { name: 'extra', type: 'STRUCT<a INT64, b STRING>', scalar: false },
    { name: 'tags', type: 'ARRAY<STRING>', scalar: false },
  ]);
  assert.deepEqual(structFieldsOfType('STRUCT("file" VARCHAR, line INTEGER)[]'), [
    { name: 'file', type: 'VARCHAR', scalar: true },
    { name: 'line', type: 'INTEGER', scalar: true },
  ]);
  assert.deepEqual(structFieldsOfType('ARRAY<STRING>'), []);
  assert.deepEqual(structFieldsOfType(null), []);
});

test('a text holds JSON when every value is written as an object or an array and one reads as one', () => {
  assert.equal(holdsJson([{ value: '{"level":"12"}', freq: 3 }, { value: '{"level":"1' }]), true, 'a cut value still starts as one');
  assert.equal(holdsJson(['[1, 2]']), true);
  assert.equal(holdsJson(['{"a":1}', 'plain']), false);
  assert.equal(holdsJson(['{not json']), false);
  assert.equal(holdsJson([]), false);
  assert.equal(isStructType('STRUCT<a INT64>'), true);
  assert.equal(isStructType('STRUCT(a INTEGER)'), true);
  assert.equal(isStructType('STRUCT(a INTEGER)[]'), false);
  assert.equal(isStructType('ARRAY<STRUCT<a INT64>>'), false);
});

const quantilesOf = (xs) => { const s = [...xs].sort((a, b) => a - b); return Array.from({ length: QUANTILE_POINTS + 1 }, (_, p) => s[Math.round((p / QUANTILE_POINTS) * (s.length - 1))]); };

test('quantiles of two samples merge into the union\'s, within a point\'s share', () => {
  const a = Array.from({ length: 1000 }, (_, i) => i);
  const b = Array.from({ length: 3000 }, (_, i) => 1000 + i);
  const merged = mergeQuantiles(quantilesOf(a), a.length, quantilesOf(b), b.length);
  const truth = quantilesOf([...a, ...b]);
  assert.equal(merged.length, QUANTILE_POINTS + 1);
  assert.equal(merged[0], 0);
  assert.equal(merged[QUANTILE_POINTS], 3999);
  for (let p = 0; p <= QUANTILE_POINTS; p++) assert.ok(Math.abs(merged[p] - truth[p]) <= 4000 / QUANTILE_POINTS + 1, `point ${p}: ${merged[p]} vs ${truth[p]}`);
  // one side empty: the other, exactly
  assert.deepEqual(mergeQuantiles(null, 0, quantilesOf(b), b.length), quantilesOf(b));
  assert.equal(mergeQuantiles(null, 0, null, 0), null);
});

test('a numeric summary merged with a delta: counts add, min and max widen', () => {
  const prior = { count: 10, min: 2, max: 9, quantiles: [2, 5, 9] };
  const delta = { count: 5, min: -1, max: 7, quantiles: [-1, 3, 7] };
  const m = mergeNumeric(prior, delta);
  assert.equal(m.count, 15);
  assert.equal(m.min, -1);
  assert.equal(m.max, 9);
  assert.equal(m.quantiles[0], -1);
  assert.equal(m.quantiles[m.quantiles.length - 1], 9);
  assert.deepEqual(mergeNumeric(null, delta), delta);
  assert.deepEqual(mergeNumeric(prior, null), prior);
  assert.deepEqual(percentilesOf(quantilesOf(Array.from({ length: 101 }, (_, i) => i))), { p01: 1, p05: 5, p25: 25, p50: 50, p75: 75, p95: 95, p99: 99 });
});

for (const kind of ['memory', 'sqlite']) {
  test(`the store keeps a key's registry — first seen kept, the rest replaced (${kind})`, () => {
    const store = kind === 'memory' ? openStore({}) : openStore({ dbPath: join(tempDir('keys'), 'mcp.sqlite') });
    if (kind === 'sqlite' && !store.persistent) return;
    const idx = new ValueIndex({ store });
    idx.putKey('crash', 'frames', 'line', { lastSeen: 100, elements: 4, numeric: { count: 4, min: 1, max: 9, quantiles: [1, 9] } });
    idx.putKey('crash', 'frames', 'File', { lastSeen: 100, elements: 2 });
    idx.putKey('crash', 'crumbs', '', { lastSeen: 50, elements: 3 });
    const first = idx.keys('crash', 'frames').find((k) => k.field === 'line').firstSeen;
    idx.putKey('crash', 'frames', 'line', { lastSeen: 200, elements: 6, numeric: { count: 6, min: 0, max: 9, quantiles: [0, 9] } });
    assert.deepEqual(idx.keys('crash', 'frames').map((k) => k.field), ['File', 'line'], 'code-point order');
    const line = idx.keys('crash', 'frames').find((k) => k.field === 'line');
    assert.equal(line.firstSeen, first);
    assert.equal(line.lastSeen, 200);
    assert.equal(line.elements, 6);
    assert.deepEqual(line.numeric, { count: 6, min: 0, max: 9, quantiles: [0, 9] });
    assert.deepEqual(idx.keys('crash').map((k) => `${k.property}.${k.field}`), ['crumbs.', 'frames.File', 'frames.line']);
    idx.removeKey('crash', 'frames', 'File');
    assert.deepEqual(idx.keys('crash', 'frames').map((k) => k.field), ['line']);
    assert.deepEqual(idx.keys('other'), []);
    store.close?.();
  });
}

// Where a complex property's elements are read from: a native array of JSON values is read as JSON whether
// the introspection reports it as ARRAY<JSON> or by its element's type (JSON); one native struct only where
// the catalog declares one — an array's reported RECORD is its element's, never one struct.
test('a native array of JSON is read as JSON whatever spelling its type has; one struct only where declared', async () => {
  const { loadCatalog } = await import('../../src/catalog.js');
  const c = loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), {});
  const name = c.complexEventProps('events').find((n) => /^words_selected_of/.test(n));
  const spec = c.eventPropertySpec(name, 'events');
  const storage = (encoding, data_type, type) => { Object.assign(spec, { column: name, encoding, data_type, type }); const st = c.complexStorage(name, 'events'); return { itemsJson: st.itemsJson, json: st.json, struct: st.struct }; };
  assert.deepEqual(storage('native', 'JSON', 'array'), { itemsJson: true, json: true, struct: false });
  assert.deepEqual(storage('native', 'ARRAY<JSON>', 'array'), { itemsJson: true, json: true, struct: false });
  assert.deepEqual(storage('native', 'JSON[]', 'array'), { itemsJson: true, json: true, struct: false });
  assert.deepEqual(storage('native', 'ARRAY<STRING>', 'array'), { itemsJson: false, json: false, struct: false });
  assert.deepEqual(storage('native', 'RECORD', 'array<struct>'), { itemsJson: false, json: false, struct: false });
  assert.deepEqual(storage('native', 'STRUCT<a INT64>', 'struct'), { itemsJson: false, json: false, struct: true });
  assert.deepEqual(storage('json', 'JSON', 'array<struct>'), { itemsJson: false, json: true, struct: false });
  assert.equal(storage('json', undefined, 'array<struct>').json, null, 'a type not known: neither');
});

// Where the value index reads keys inside an element: the structs its declaration names (a struct inside a
// declared struct, by its path), never a depth guessed; a native struct's scalar leaves however its type nests.
test('the structs a declaration names inside an element, and a native struct\'s scalar leaves', async () => {
  const { declaredStructPaths, nativeLeafPaths } = await import('../../src/complex-keys.js');
  assert.deepEqual(declaredStructPaths({ action_type: 'string', duration: 'int', additional_info: 'struct' }), ['additional_info']);
  assert.deepEqual(declaredStructPaths({ a: { type: 'struct', fields: { b: 'struct', c: 'int' } }, d: 'STRUCT' }), ['a', 'a.b', 'd']);
  assert.deepEqual(declaredStructPaths(null), []);
  assert.deepEqual(nativeLeafPaths(structFieldsOfType('ARRAY<STRUCT<id INT64, pos STRUCT<arrow STRING, cell INT64>, tags ARRAY<STRING>>>')), ['id', 'pos.arrow', 'pos.cell']);
});
