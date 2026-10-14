// A RAW EXPRESSION IS ONE EXPRESSION, and A PARTITION BOUND IS THE UTC DAY OF ITS INSTANT.
// (1) The SQL of a raw expression lands inside the parentheses the server writes around it, in a model
// both warehouses run: a statement end, a comment, a quote that does not close or a parenthesis that does
// not balance would let it close the model's SELECT ("1)); DROP TABLE x; SELECT ((1" — BigQuery runs the
// rest as a script), so each is refused outside quoted text — and so are the quotes BigQuery and DuckDB
// end a text at differently (a backslash before a quote, three quotes in a row, DuckDB's $$), since what
// one warehouse reads as text the other would run. The same characters inside a quoted constant are text.
// (2) A where on the time axis of a source partitioned by another (day) column gets a bound on that column:
// the days of the warehouse clock (UTC) — a constant with an offset of its own (Z, ±hh[:mm]) is its UTC
// instant, and one in a spelling the warehouses would read apart (a zone name, a one-digit offset) is refused.
// Input-validation guards and the partition days a where is given: nothing here reads generated SQL.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { renderPipeline } from '../../src/pipeline.js';
import { fillPlaceholders } from '../../src/pipeline/sql.js';

const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));
const catalog = loadCatalog(CATALOG, {});
const COLS = new Set(['player_id_of_internal', 'device_time', 'event_date', 'event_name', 'session_number']);
const render = (stages) => renderPipeline(catalog, catalog.dialect, 'events', stages, { physicalCols: COLS });
const raw = (sql) => render([{ stage: 'compute', name: 'x', expr: { fn: 'raw', sql, args: [{ column: 'event_name' }] } }]);
const ONE = /a raw expression is ONE expression/;

test('a raw expression\'s SQL that would end the statement, comment out the rest or close what it did not open is refused, naming what it found', () => {
  // the reported one: a statement end and parentheses that close the model's own
  assert.throws(() => fillPlaceholders('1)); DROP TABLE x; SELECT ((1', []), (e) => ONE.test(e.message) && /a statement end \(;\)/.test(e.message) && /a \) that closes what it did not open/.test(e.message));
  for (const [sql, found] of [
    ['{1}; SELECT 1', /a statement end \(;\)/],
    ['{1} -- the rest of the line', /a comment \(--\)/],
    ['{1} # BigQuery reads this as a comment too', /a comment \(#\)/],
    ['{1} /* a note */', /a comment \(\/\* \*\/\)/],
    ['{1} */', /a comment \(\*\/\)/],
    ['upper({1}', /a \( that does not close/],
    ['upper({1}))', /a \) that closes what it did not open/],
    [')upper({1})(', /a \) that closes what it did not open/],
    ["concat({1}, 'abc)", /a ' that does not close/],
    ['concat({1}, "abc)', /a " that does not close/],
    ['concat({1}, $$a$$)', /a \$ \(a dollar-quoted text on DuckDB\)/],
    // DuckDB's $$ text around a quote: the quote pairs here, and DuckDB would run what is between
    ["$$ ' $$; DROP TABLE x; SELECT $$ ' $$ || {1}", /a \$/],
  ]) {
    assert.throws(() => raw(sql), (e) => ONE.test(e.message) && found.test(e.message) && /\{ value \} in args/.test(e.message), sql);
  }
});

test('a quote the two warehouses end a text at differently is refused before the text is read', () => {
  for (const sql of [
    // DuckDB reads 'a\' as a whole text, so the ; after it would run there
    "{1} || 'a\\'; DROP TABLE x; SELECT 1 --'",
    "concat({1}, 'x\\')",
    // BigQuery reads '''…''' as one text, so the ; between two of them would run there
    "{1} || '''x'y''' ; DROP TABLE t; SELECT '''p'q'''",
    'concat({1}, """a""")',
  ]) {
    assert.throws(() => raw(sql), /BigQuery and DuckDB end a text at differently.*\{ value \} in args/, sql);
  }
});

test('a statement end, a comment opener or a parenthesis inside a quoted constant is text, and accepted', () => {
  for (const sql of [
    "concat({1}, ';')",
    "concat({1}, '--x', '/* y */', '*/', '#', ')(', '$$')",
    'concat({1}, "a;b -- c")',
    "concat({1}, 'it''s; (fine')",
    "regexp_extract({1}, '(\\d+);')",
    // a placeholder inside a quoted text is text too: one argument, used once
    "concat({1}, '{2}')",
    'coalesce(nullif({1}, \'\'), \'none\')',
  ]) {
    assert.ok(raw(sql).columns.has('x'), sql);
  }
  assert.doesNotThrow(() => fillPlaceholders("if({1} > 0, ';', '(')", ['"n"']));
});

// the bound each where of the leading run gets on the partition column: { gte | lt: day }
const partitionBound = (cond) => {
  const where = render([{ stage: 'where', conditions: [cond] }]).chain[0].stages[0];
  return where.conditions.filter((c) => c.args?.[0]?.column === 'event_date').map((c) => [c.fn, c.args[1].value]);
};
const onTime = (fn, ...values) => ({ fn, args: [{ column: 'device_time' }, ...values.map((value) => ({ value }))] });

test('a where on the time axis bounds the partition column by the UTC day of an instant with an offset; a date or a wall-clock time stands as written', () => {
  // 2026-01-05T02:00:00+05:00 is 2026-01-04 21:00 UTC: its day is the 4th, not the 5th the text starts with
  assert.deepEqual(partitionBound(onTime('gte', '2026-01-05T02:00:00+05:00')), [['gte', '2026-01-04']]);
  assert.deepEqual(partitionBound(onTime('gte', '2026-01-05T00:00:00+14:00')), [['gte', '2026-01-04']]);
  assert.deepEqual(partitionBound(onTime('gte', '2026-01-04T23:30:00Z')), [['gte', '2026-01-04']]);
  // a negative offset moves the instant to the next UTC day
  assert.deepEqual(partitionBound(onTime('gte', '2026-01-04T22:00:00-05:00')), [['gte', '2026-01-05']]);
  // an exclusive end at a UTC midnight touches no day of its own; one before it touches its own day
  // (the catalog's partition_late_days, 3, read after it)
  assert.deepEqual(partitionBound(onTime('lt', '2026-01-05T05:00:00+05:00')), [['lt', '2026-01-08']]);
  assert.deepEqual(partitionBound(onTime('lt', '2026-01-05T02:00:00+05:00')), [['lt', '2026-01-08']]);
  assert.deepEqual(partitionBound(onTime('lte', '2026-01-05T02:00:00+05:00')), [['lt', '2026-01-08']]);
  assert.deepEqual(partitionBound(onTime('between', '2026-01-05T02:00:00+05:00', '2026-01-06T03:00:00+05:00')), [['gte', '2026-01-04'], ['lt', '2026-01-09']]);
  // the axis is UTC: a date, and a date-time with no offset, keep the day written
  assert.deepEqual(partitionBound(onTime('gte', '2026-01-05')), [['gte', '2026-01-05']]);
  assert.deepEqual(partitionBound(onTime('gte', '2026-01-05 02:00:00')), [['gte', '2026-01-05']]);
  assert.deepEqual(partitionBound(onTime('gte', '2026-01-05T23:59:59.500')), [['gte', '2026-01-05']]);
  assert.deepEqual(partitionBound(onTime('lt', '2026-01-05')), [['lt', '2026-01-08']]);
  assert.deepEqual(partitionBound(onTime('lt', '2026-01-05 00:00:00')), [['lt', '2026-01-08']]);
  assert.deepEqual(partitionBound(onTime('lte', '2026-01-05')), [['lt', '2026-01-09']]);
});

test('an hour-only offset (±hh) is an instant too: the partition day is its UTC day', () => {
  // 2026-01-05T02:00:00+05 is 2026-01-04 21:00 UTC; 2026-01-04T20:00:00-08 is 2026-01-05 04:00 UTC
  assert.deepEqual(partitionBound(onTime('gte', '2026-01-05T02:00:00+05')), [['gte', '2026-01-04']]);
  assert.deepEqual(partitionBound(onTime('gte', '2026-01-04T20:00:00-08')), [['gte', '2026-01-05']]);
  assert.deepEqual(partitionBound(onTime('gte', '2026-01-05T00:00:00+14')), [['gte', '2026-01-04']]);
  // a lowercase z is UTC, as a Z
  assert.deepEqual(partitionBound(onTime('gte', '2026-01-04T23:30:00z')), [['gte', '2026-01-04']]);
});

test('a time constant whose zone the warehouses would read apart is refused, naming the spelling it takes', () => {
  for (const value of [
    '2026-01-05T02:00:00+5', // an offset of one digit: BigQuery reads it, DuckDB's cast does not
    '2026-01-05T02:00:00+5:30',
    '2026-01-05 02:00:00 Asia/Karachi', // a zone name
    '2026-01-05 02:00:00 UTC',
    '2026-01-05 02:00:00 Z',
    '2026-01-05 24:00:00', // no such time
    '2026-01-05T02:00:00+25:00',
  ]) {
    assert.throws(() => partitionBound(onTime('gte', value)), /'device_time' is a moment: write it YYYY-MM-DD\[ HH:mm\[:ss\[\.ffffff\]\]\] with an optional Z or ±hh\[:mm\]/, value);
    assert.throws(() => partitionBound(onTime('between', '2026-01-04', value)), /is a moment/, `between …, ${value}`);
  }
});
