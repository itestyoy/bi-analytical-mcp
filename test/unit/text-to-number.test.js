// ONE TEXT-TO-NUMBER RULE, AND AN ELEMENT OF THE TYPE IT IS STORED AS — the input-validation side; no
// generated SQL is read. A cast to int is built from every kind of value on both warehouses (a number, a
// flag, a text, a value of no known type — a raw's among them, whatever its SQL yields, and a case that
// says a type its branches are not of — the dialect is told which, and converts each the one way: the
// number it holds, rounded half away from zero), and its `type` is one of the type words. An array's
// element has the type it is stored as, and the next step is checked against it: a native array of
// numbers gives numbers (a word compared with one, or looked for in it, is refused), one whose items are
// not known claims nothing, a JSON array is text (element_at refused until it is parsed), an array of
// structs gives no scalar element — and a native array read as { property } is of the items its column is
// tracked with, as one read as { column } is. The numbers themselves are proven on the warehouse
// (test/integration/pipeline-stages.test.js, "cast to int").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { buildSchemas } from '../../src/schema.js';
import { makeValidators, validateInput } from '../../src/validate.js';
import { renderPipeline } from '../../src/pipeline.js';

const FIXTURE = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));
const PRODUCTION = fileURLToPath(new URL('../../config/catalog.yml', import.meta.url));
const catalog = loadCatalog(FIXTURE, {});
const DIALECTS = ['duckdb', 'bigquery'];
const col = (column) => ({ column });
const val = (value) => ({ value });
const toInt = (expr) => ({ fn: 'cast', args: [expr], type: 'int' });
const eq = (a, v) => ({ fn: 'eq', args: [a, val(v)] });
const where = (...conditions) => ({ stage: 'where', conditions });
const compute = (name, expr) => ({ stage: 'compute', name, expr });
const unnest = (expr, name = 'el') => ({ stage: 'unnest', expr, name });
// a stored table's columns (a task's, a checkpoint's), as a build from it reads them
const STORED = {
  model: 'stored',
  columns: [
    { name: 'id', type: 'string' }, { name: 'n', type: 'numeric' }, { name: 'flag', type: 'boolean' }, { name: 'untyped', type: 'unknown' },
    { name: 'ints', type: 'array<int>' }, { name: 'things', type: 'array' }, { name: 'frames', type: 'array<struct>' },
  ],
};
/** A pipeline built over the stored table (or, given `from: null`, over `source`'s rows) on `dialect`. */
const build = (stages, dialect, { cat = catalog, source = 'events', from = STORED } = {}) => renderPipeline(cat, dialect, source, stages, from ? { from } : {});

test('cast to int is built from a number, a flag, a text and a value of no known type, on both warehouses', () => {
  for (const dialect of DIALECTS) {
    assert.doesNotThrow(() => build([
      compute('a', toInt(col('n'))), compute('b', toInt(col('flag'))), compute('c', toInt(col('id'))), compute('d', toInt(col('untyped'))),
      compute('e', toInt(val('9.99'))), compute('f', toInt(val(2.5))), compute('g', toInt(val(true))),
      compute('h', { fn: 'cast', args: [col('flag')], type: 'numeric' }), compute('i', { fn: 'cast', args: [col('id')], type: 'float' }),
    ], dialect), dialect);
    // over a source's rows: a property held as text, a DOUBLE property, and a cast of a cast
    assert.doesNotThrow(() => build([
      compute('a', toInt({ property: 'complete_time_of_event_data' })),
      compute('b', toInt({ fn: 'div', args: [col('daily_level_score_of_event_data'), val(18)] })),
      compute('c', toInt({ fn: 'cast', args: [col('daily_level_score_of_event_data')], type: 'string' })),
    ], dialect, { from: null }), dialect);
    // what only says its type: a raw that yields a flag (and says nothing), a raw that says numeric over a
    // text, a case that says int over text branches — each converted as what it holds, not as it says
    const isOn = { fn: 'eq', args: [col('flag'), val(true)] };
    const r = build([
      compute('a', toInt({ fn: 'raw', sql: '{1} > 0', args: [col('n')] })),
      compute('b', toInt({ fn: 'raw', sql: '{1}', args: [col('id')], type: 'numeric' })),
      compute('c', toInt({ fn: 'case', cases: [{ when: [isOn], then: col('id') }], type: 'int' })),
      compute('d', { fn: 'case', cases: [{ when: [isOn], then: col('id') }], type: 'int' }),
      compute('e', { fn: 'raw', sql: '{1} > 0', args: [col('n')] }),
    ], dialect);
    assert.deepEqual(['a', 'b', 'c', 'd', 'e'].map((c) => r.columns.get(c).type), ['int', 'int', 'int', 'int', 'unknown'], `${dialect}: a raw that says no type claims none`);
  }
});

test('a number met by a text is written as its text, and a text is not ordered against a number — the number it holds is read by cast', () => {
  for (const dialect of DIALECTS) {
    for (const op of ['eq', 'neq']) assert.doesNotThrow(() => build([where({ fn: op, args: [col('id'), val(5)] })], dialect), `${dialect} ${op}`);
    assert.doesNotThrow(() => build([where({ fn: 'in', args: [col('id'), val(5), val('x')] })], dialect));
    for (const c of [{ fn: 'gt', args: [col('id'), val(5)] }, { fn: 'between', args: [col('id'), val(1), val(9)] }]) {
      assert.throws(() => build([where(c)], dialect), /'id' is text: (gt|between) with a number would order it as text \('10' before '9'\) — read the number it holds first/, `${dialect} ${c.fn}`);
    }
    assert.doesNotThrow(() => build([where({ fn: 'gt', args: [toInt(col('id')), val(5)] }, { fn: 'gt', args: [col('id'), val('5')] })], dialect));
    // what nothing is known of takes a constant as it is written
    assert.doesNotThrow(() => build([where({ fn: 'gt', args: [col('untyped'), val(5)] }, { fn: 'gt', args: [{ fn: 'raw', sql: '{1} * 2', args: [col('n')] }, val(5)] })], dialect));
  }
});

test('cast takes a type word — int, numeric, float, string — and refuses another', () => {
  const validators = makeValidators(buildSchemas(catalog));
  const step = (type) => validateInput(validators.build_model, { action: 'add_steps', context_id: 'abcdef123456', steps: [compute('p', { fn: 'cast', args: [col('x')], type })] });
  for (const type of ['int', 'numeric', 'float', 'string']) assert.equal(step(type).ok, true, type);
  for (const type of ['integer', 'bigint', 'double', 'boolean']) {
    const r = step(type);
    assert.equal(r.ok, false, type);
    assert.ok(r.errors.some((m) => /type` must be one of: int, numeric, float, string/.test(m)), JSON.stringify(r.errors));
  }
});

test('an element of a native array of numbers is a number: a word compared with it is refused, a number taken', () => {
  for (const dialect of DIALECTS) {
    for (const pick of [unnest(col('ints')), compute('el', { fn: 'element_at', args: [col('ints')], index: 1 }), compute('el', { fn: 'array_last', args: [col('ints')] })]) {
      assert.throws(() => build([pick, where(eq(col('el'), 'abc'))], dialect), /'el' is a number: compare it with a number, not "abc"/, `${dialect} ${pick.stage} ${pick.expr.fn || ''}`);
      assert.doesNotThrow(() => build([pick, where(eq(col('el'), '5'))], dialect));
      assert.doesNotThrow(() => build([pick, where(eq(col('el'), 5))], dialect));
    }
  }
});

test('a native array of numbers is looked for a number: a word is refused, a number or a numeric text taken', () => {
  for (const dialect of DIALECTS) {
    assert.throws(() => build([compute('x', { fn: 'array_contains', args: [col('ints'), val('abc')] })], dialect), /an element of 'ints' is a number: compare it with a number, not "abc"/, dialect);
    for (const v of ['5', 5]) assert.doesNotThrow(() => build([compute('x', { fn: 'array_contains', args: [col('ints'), val(v)] })], dialect), `${dialect} ${v}`);
    // an array whose items are not known takes any constant, as it is written
    for (const v of ['abc', 5]) assert.doesNotThrow(() => build([compute('x', { fn: 'array_contains', args: [col('things'), val(v)] })], dialect), `${dialect} ${v}`);
  }
});

test('an element of an array whose items are not known claims no type: any constant is taken', () => {
  for (const dialect of DIALECTS) {
    for (const pick of [unnest(col('things')), compute('el', { fn: 'element_at', args: [col('things')], index: 2 }), compute('el', { fn: 'array_last', args: [col('things')] })]) {
      assert.doesNotThrow(() => build([pick, where(eq(col('el'), 'abc'))], dialect));
      assert.doesNotThrow(() => build([pick, where(eq(col('el'), 5))], dialect));
    }
  }
});

test('an array held as JSON text is text until it is parsed: element_at and an unnest of a copy are refused, json_parse_array opens it', () => {
  const crash = { source: 'crashlytics', from: null };
  for (const dialect of DIALECTS) {
    assert.throws(() => build([compute('x', { fn: 'element_at', args: [{ property: 'breadcrumbs_of_event_data' }], index: 1 })], dialect, crash), /its argument is 'string', not an array — produce an array first/);
    assert.throws(() => build([compute('trail', { property: 'breadcrumbs_of_event_data' }), unnest(col('trail'))], dialect, crash), /'trail' is string, not an array column — make one with json_parse_array/);
    assert.doesNotThrow(() => build([
      compute('trail', { fn: 'json_parse_array', args: [col('breadcrumbs_of_event_data')] }),
      compute('first', { fn: 'element_at', args: [col('trail')], index: 1 }), unnest(col('trail')),
      where(eq(col('first'), 'level_start'), eq(col('el'), 'gc_pause')),
    ], dialect, crash));
  }
});

test('an array of structs gives no scalar element, and has a length', () => {
  for (const dialect of DIALECTS) {
    assert.throws(() => build([compute('x', { fn: 'element_at', args: [col('frames')], index: 1 })], dialect), /element_at takes an array of scalars/);
    assert.throws(() => build([compute('x', { fn: 'array_contains', args: [col('frames'), val('x')] })], dialect), /array_contains takes an array of scalars/);
    assert.doesNotThrow(() => build([compute('x', { fn: 'array_length', args: [col('frames')] })], dialect));
  }
});

test('a warehouse ARRAY column is an array of the items it holds: the declared ones, the warehouse\'s once it is asked', () => {
  const array = 'block_reasons_of_additional_info_of_event_data'; // declared `array: { items: string }`, a native array
  const production = () => loadCatalog(PRODUCTION, {});
  for (const dialect of DIALECTS) {
    const declared = production();
    for (const pick of [unnest(col(array)), unnest({ property: array }), compute('el', { fn: 'element_at', args: [{ property: array }], index: 1 })]) {
      assert.doesNotThrow(() => build([pick, where(eq(col('el'), 'abc'))], dialect, { cat: declared, from: null }), 'an array of texts');
    }
    // grounded: the warehouse says it holds integers, and the element is one — however the array is named
    // ({ column }, { property }, a copy of the property) and whichever element is taken
    const grounded = production();
    grounded.typeToPhysical({ events: new Map([[array, 'ARRAY<INT64>']]) });
    for (const pick of [
      [unnest(col(array))], [unnest({ property: array })], [compute('el', { fn: 'array_last', args: [col(array)] })],
      [compute('el', { fn: 'element_at', args: [{ property: array }], index: 1 })], [compute('el', { fn: 'array_last', args: [{ property: array }] })],
      [compute('copy', { property: array }), unnest(col('copy'))], [compute('copy', { property: array }), compute('el', { fn: 'element_at', args: [col('copy')], index: 1 })],
    ]) {
      assert.throws(() => build([...pick, where(eq(col('el'), 'abc'))], dialect, { cat: grounded, from: null }), /'el' is a number/, `${dialect} ${JSON.stringify(pick)}`);
    }
    assert.throws(() => build([compute('x', { fn: 'array_contains', args: [{ property: array }, val('abc')] })], dialect, { cat: grounded, from: null }), /is a number: compare it with a number, not "abc"/);
    assert.doesNotThrow(() => build([compute('x', { fn: 'array_contains', args: [{ property: array }, val('5')] })], dialect, { cat: grounded, from: null }));
  }
});
