// A STEP ADDS A COLUMN UNDER A NAME OF ITS OWN, and AN UNPIVOT'S VALUE COLUMN IS OF ITS COLUMNS' TYPE.
// (1) A compute, or an unnest's element, named as a column the rows already have would leave two columns
// sharing one name — DuckDB renames the second (every later step reads the first), BigQuery refuses it —
// so the step is refused when it is added, naming the column, as a join's attrs are.
// (2) The value column of an unpivot holds every folded column's values, so it is tracked as the one type
// they share — a text value column is compared as text — and columns of different kinds are refused,
// each named with its type, saying to cast them to one type first (numbers are one kind).
// The boolean a compute stores is proven on DATA in test/integration/sql-review-c.test.js. Input-validation
// guards and the column types a step leaves: nothing here reads generated SQL.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { renderPipeline, renderRead } from '../../src/pipeline.js';

const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));
const catalog = loadCatalog(CATALOG, {});
const COLS = new Set(['player_id_of_internal', 'device_time', 'event_date', 'event_name', 'session_number', 'bundle_id', 'event_data']);
const render = (stages) => renderPipeline(catalog, catalog.dialect, 'events', stages, { physicalCols: COLS });
const TABLE = "{{ ref('qr') }}";
const COLUMNS = [{ name: 'country', type: 'string' }, { name: 'platform', type: 'string' }, { name: 'revenue', type: 'numeric' }, { name: 'n', type: 'int' }, { name: 'day', type: 'time' }, { name: 'payer', type: 'boolean' }, { name: 'raw_value', type: 'unknown' }];
const read = (steps) => renderRead(catalog, TABLE, COLUMNS, steps);
const TAKEN = (name) => new RegExp(`the pipeline already has a column named '${name}'.*two columns sharing one name.*Choose another name`);

test('a compute named as a column the rows already have is refused, naming it — a source column, an earlier compute, a stored column', () => {
  assert.throws(() => render([{ stage: 'compute', name: 'event_name', expr: { fn: 'upper', args: [{ column: 'event_name' }] } }]), (e) => /compute 'event_name'/.test(e.message) && TAKEN('event_name').test(e.message));
  assert.throws(() => render([
    { stage: 'compute', name: 'x', expr: { fn: 'upper', args: [{ column: 'event_name' }] } },
    { stage: 'compute', name: 'x', expr: { fn: 'lower', args: [{ column: 'event_name' }] } },
  ]), TAKEN('x'));
  assert.throws(() => read([{ stage: 'compute', name: 'revenue', expr: { fn: 'mul', args: [{ column: 'revenue' }, { value: 2 }] } }]), TAKEN('revenue'));
  // a name of its own is added
  assert.ok(render([{ stage: 'compute', name: 'loud', expr: { fn: 'upper', args: [{ column: 'event_name' }] } }]).columns.has('loud'));
  assert.ok(read([{ stage: 'compute', name: 'revenue2', expr: { fn: 'mul', args: [{ column: 'revenue' }, { value: 2 }] } }]).columns.has('revenue2'));
});

test('an unnest whose element is named as a column the rows already have is refused — of an event property, of an array column, of an expression', () => {
  assert.throws(() => render([{ stage: 'unnest', expr: { property: 'words_collected' }, name: 'event_name' }]), (e) => /unnest 'event_name'/.test(e.message) && TAKEN('event_name').test(e.message));
  const arr = { stage: 'compute', name: 'arr', expr: { fn: 'json_parse_array', args: [{ column: 'event_name' }] } };
  assert.throws(() => render([arr, { stage: 'unnest', expr: { column: 'arr' }, name: 'arr' }]), TAKEN('arr'));
  assert.throws(() => render([{ stage: 'unnest', expr: { fn: 'json_parse_array', args: [{ column: 'event_name' }] }, name: 'bundle_id' }]), TAKEN('bundle_id'));
  // a name of its own is added, by each of the three
  assert.ok(render([{ stage: 'unnest', expr: { property: 'words_collected' }, name: 'word' }]).columns.has('word'));
  assert.ok(render([arr, { stage: 'unnest', expr: { column: 'arr' }, name: 'item' }]).columns.has('item'));
  assert.ok(render([{ stage: 'unnest', expr: { fn: 'json_parse_array', args: [{ column: 'event_name' }] }, name: 'item' }]).columns.has('item'));
});

test('a join exposing a column under a name the rows have is refused in the same words', () => {
  assert.throws(
    () => render([{ stage: 'join', with: 'users', via: 'user', attrs: [{ column: 'country', name: 'event_name' }] }]),
    /join 'users' attrs: the pipeline already has a column named 'event_name', so exposing 'users'\.country under that name would leave two columns sharing one name/,
  );
});

test('an unpivot of text columns makes a text value column: a where compares it with a text constant', () => {
  const steps = [
    { stage: 'unpivot', columns: ['country', 'platform'], name_column: 'attribute', value_column: 'v' },
    { stage: 'where', conditions: [{ fn: 'eq', args: [{ column: 'v' }, { value: 'US' }] }] },
  ];
  const out = read(steps);
  assert.equal(out.columns.get('v').type, 'string');
  assert.equal(out.columns.get('attribute').type, 'string');
  // …and in a build, over two text columns computed from the source's
  const built = render([
    { stage: 'compute', name: 'a', expr: { fn: 'upper', args: [{ column: 'event_name' }] } },
    { stage: 'compute', name: 'b', expr: { fn: 'lower', args: [{ column: 'bundle_id' }] } },
    { stage: 'unpivot', keep: ['player_id_of_internal'], columns: ['a', 'b'], name_column: 'which', value_column: 'text' },
    { stage: 'where', conditions: [{ fn: 'eq', args: [{ column: 'text' }, { value: 'TUTORIAL' }] }] },
  ]);
  assert.equal(built.columns.get('text').type, 'string');
});

test('an unpivot\'s value column is its columns\' one type: numbers of any kind are numeric, one type is kept, an unknown claims none', () => {
  assert.equal(read([{ stage: 'unpivot', columns: ['revenue', 'n'], name_column: 'm', value_column: 'v' }]).columns.get('v').type, 'numeric');
  assert.equal(read([{ stage: 'unpivot', columns: ['n'], name_column: 'm', value_column: 'v' }]).columns.get('v').type, 'int');
  assert.equal(read([{ stage: 'unpivot', columns: ['day'], name_column: 'm', value_column: 'v' }]).columns.get('v').type, 'time');
  assert.equal(read([{ stage: 'unpivot', columns: ['payer'], name_column: 'm', value_column: 'v' }]).columns.get('v').type, 'boolean');
  assert.equal(read([{ stage: 'unpivot', columns: ['country', 'raw_value'], name_column: 'm', value_column: 'v' }]).columns.get('v').type, 'unknown');
});

test('an unpivot of moments (a DATE and a TIMESTAMP are both tracked as a moment) folds them into a moment on both warehouses', () => {
  for (const dialect of ['duckdb', 'bigquery']) {
    const built = renderPipeline(catalog, dialect, 'events', [
      { stage: 'unpivot', keep: ['player_id_of_internal'], columns: ['event_date', 'device_time'], name_column: 'which', value_column: 'at' },
      { stage: 'where', conditions: [{ fn: 'gte', args: [{ column: 'at' }, { value: '2026-01-02' }] }] },
    ], { physicalCols: Object.assign(new Set(COLS), { types: new Map([['event_date', 'DATE'], ['device_time', 'TIMESTAMP']]) }) });
    assert.equal(built.columns.get('at').type, 'time', dialect);
  }
});

test('an unpivot of columns of different types is refused, naming each with its type and saying to cast them first', () => {
  assert.throws(
    () => read([{ stage: 'unpivot', keep: ['day'], columns: ['country', 'revenue'], name_column: 'm', value_column: 'v' }]),
    (e) => /unpivot: the value column holds one type/.test(e.message) && /'country' string, 'revenue' numeric/.test(e.message) && /Cast them to one type first/.test(e.message),
  );
  assert.throws(() => read([{ stage: 'unpivot', columns: ['payer', 'n'], name_column: 'm', value_column: 'v' }]), /'payer' boolean, 'n' int/);
  assert.throws(() => read([{ stage: 'unpivot', columns: ['day', 'country'], name_column: 'm', value_column: 'v' }]), /'day' time, 'country' string/);
  // the way it says: each cast to one type, then folded
  const cast = read([
    { stage: 'compute', name: 'country_t', expr: { fn: 'cast', args: [{ column: 'country' }], type: 'string' } },
    { stage: 'compute', name: 'revenue_t', expr: { fn: 'cast', args: [{ column: 'revenue' }], type: 'string' } },
    { stage: 'unpivot', columns: ['country_t', 'revenue_t'], name_column: 'm', value_column: 'v' },
  ]);
  assert.equal(cast.columns.get('v').type, 'string');
});
