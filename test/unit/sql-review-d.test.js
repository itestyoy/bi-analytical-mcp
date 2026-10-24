// A CONDITION IS ONE VALUE WHEREVER IT STANDS, AND A VALUE IS OF THE TYPE IT IS READ AS: a condition
// whose arguments are conditions builds on both warehouses (each operand keeps its own precedence); a
// boolean constant beside a text is its text, accepted where it meets one; a flattened event property is
// its column, so a text one holding a flag is compared as the column is — an order with a boolean refused;
// and a payload key declared a type the one conversion of a text does not make is tracked as text, so an
// order with a number is refused, saying to cast, instead of failing in the warehouse. The rows these
// find are test/integration/sql-review-d.test.js's. Input-validation guards only: nothing here reads
// generated SQL.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { renderPipeline } from '../../src/pipeline.js';

const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));
const DIALECTS = ['duckdb', 'bigquery'];
// the source's columns as the warehouse reports them (a flag kept as text among them)
const TYPES = { event_id: 'VARCHAR', player_id_of_internal: 'VARCHAR', session_number: 'BIGINT', level_id_of_event_data: 'BIGINT', device_time: 'TIMESTAMP', event_date: 'DATE', event_name: 'VARCHAR', event_data: 'JSON', is_clicked_of_event_data: 'VARCHAR', result_of_event_data: 'VARCHAR' };
const PHYSICAL = Object.assign(new Set(Object.keys(TYPES)), { types: new Map(Object.entries(TYPES)) });
const render = (catalog, dialect, stages) => renderPipeline(catalog, dialect, 'events', stages, { physicalCols: PHYSICAL });
const col = (column) => ({ column });
const val = (value) => ({ value });
const fn = (name, args, extra = {}) => ({ fn: name, args, ...extra });
const where = (...conditions) => ({ stage: 'where', conditions });

test('a condition whose arguments are conditions builds on both warehouses', () => {
  const catalog = loadCatalog(CATALOG, {});
  const gt = fn('gt', [col('session_number'), col('level_id_of_event_data')]);
  const conditions = [
    fn('eq', [gt, val(true)]),
    fn('neq', [fn('eq', [col('event_name'), val('level_completed')]), fn('eq', [col('result_of_event_data'), val('win')])]),
    fn('is_null', [gt]),
    fn('in', [gt, val(false)]),
    fn('like', [fn('concat', [col('event_name'), val('-'), col('session_number')]), val('level%')]),
  ];
  for (const dialect of DIALECTS) {
    for (const c of conditions) assert.doesNotThrow(() => render(catalog, dialect, [where(c)]), `${dialect}: ${JSON.stringify(c)}`);
  }
});

test('a boolean constant beside a text is its text: a JSON field and a text cast take true and false', () => {
  const catalog = loadCatalog(CATALOG, {});
  const field = fn('json_field', [col('event_data')], { field: 'is_reward_received' });
  for (const dialect of DIALECTS) {
    for (const c of [fn('eq', [field, val(true)]), fn('in', [field, val(false), val('no')]), fn('neq', [fn('cast', [col('session_number')], { type: 'string' }), val(true)])]) {
      assert.doesNotThrow(() => render(catalog, dialect, [where(c)]), `${dialect}: ${JSON.stringify(c)}`);
    }
  }
});

test('a flattened event property is its column: a text one holding a flag refuses an order with a boolean, as the column does', () => {
  const catalog = loadCatalog(CATALOG, {});
  const textFlag = /'is_clicked_of_event_data' is a text column in the warehouse/;
  for (const dialect of DIALECTS) {
    for (const leaf of [col('is_clicked_of_event_data'), { property: 'is_clicked_of_event_data' }]) {
      assert.throws(() => render(catalog, dialect, [where(fn('gt', [leaf, val(true)]))]), textFlag, `${dialect}: ${JSON.stringify(leaf)} > true`);
      assert.doesNotThrow(() => render(catalog, dialect, [where(fn('eq', [leaf, val(true)]))]), `${dialect}: ${JSON.stringify(leaf)} = true`);
    }
  }
});

test('a payload key of a type no conversion of a text makes is text: an order with a number is refused, saying to cast', () => {
  const catalog = loadCatalog(CATALOG, {});
  // keys of the event_data blob declared a type the dialect's one conversion of a text does not make
  Object.assign(catalog.getModel('events').properties, { score_word: { type: 'number' }, extra: { type: 'json' } });
  for (const dialect of DIALECTS) {
    for (const property of ['score_word', 'extra']) {
      assert.throws(
        () => render(catalog, dialect, [where(fn('gt', [{ property }, val(5)]))]),
        new RegExp(`'${property}' is text: gt with a number would order it as text .*\\{ fn: "cast"`),
        `${dialect}: ${property}`,
      );
      // read as the number it holds, it is ordered as one
      assert.doesNotThrow(() => render(catalog, dialect, [where(fn('gt', [fn('cast', [{ property }], { type: 'numeric' }), val(5)]))]), `${dialect}: cast(${property})`);
    }
  }
});

test('a payload key declared in another word for a flag (bool, BOOLEAN) is a boolean: true / "true" taken, a word refused', () => {
  const catalog = loadCatalog(CATALOG, {});
  Object.assign(catalog.getModel('events').properties, { reward_bool: { type: 'bool' }, reward_upper: { type: 'BOOLEAN' } });
  for (const dialect of DIALECTS) {
    for (const property of ['reward_bool', 'reward_upper']) {
      for (const value of [true, 'true', 0]) assert.doesNotThrow(() => render(catalog, dialect, [where(fn('eq', [{ property }, val(value)]))]), `${dialect}: ${property} = ${JSON.stringify(value)}`);
      assert.throws(() => render(catalog, dialect, [where(fn('eq', [{ property }, val('yes')]))]), /is a boolean: compare it with true or false, not "yes"/, `${dialect}: ${property} = 'yes'`);
      // it stands as a condition by itself, as a boolean column does
      assert.doesNotThrow(() => render(catalog, dialect, [where({ property })]), `${dialect}: ${property} as a condition`);
    }
  }
});
