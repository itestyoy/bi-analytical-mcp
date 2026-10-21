// A TEXT CONSTANT IS WRITTEN IN THE WAREHOUSE'S OWN STRING SYNTAX, whatever it holds — a quote, a
// backslash, a newline, a Jinja opener: a stage built with one builds on DuckDB and on BigQuery alike
// (the rows it finds are test/integration/sql-review-a.test.js's). One character no SQL says alike — a
// NUL, where DuckDB's parser ends a string and BigQuery's CHR(0) is empty — is refused when the stage is
// built, naming the constant. Input-validation guards only: nothing here reads generated SQL.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { renderPipeline, renderRead } from '../../src/pipeline.js';
import { physicalColumnType } from '../../src/catalog/column-types.js';

const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));
const catalog = loadCatalog(CATALOG, {});
const COLS = new Set(['player_id_of_internal', 'device_time', 'event_date', 'event_name', 'session_number']);
const render = (dialect, stages) => renderPipeline(catalog, dialect, 'events', stages, { physicalCols: COLS });
const DIALECTS = ['duckdb', 'bigquery'];
const where = (value) => ({ stage: 'where', conditions: [{ fn: 'eq', args: [{ column: 'event_name' }, { value }] }] });
const compute = (value) => ({ stage: 'compute', name: 'label', expr: { fn: 'coalesce', args: [{ column: 'event_name' }, { value }] } });

test('a text constant holding a quote, a backslash, a control character or a Jinja opener builds on both warehouses', () => {
  for (const dialect of DIALECTS) {
    for (const value of ["Cote d'Ivoire", "\\' OR TRUE --", 'a\\', 'line\nbreak\ttab\r\x01', "{{ x }}'{% y %}"]) {
      assert.doesNotThrow(() => render(dialect, [where(value), compute(value)]), `${dialect}: ${JSON.stringify(value)}`);
    }
  }
});

test('a text constant holding a NUL character is refused when the stage is built, naming the constant', () => {
  for (const dialect of DIALECTS) {
    assert.throws(() => render(dialect, [where('a\0b')]), /"a\\u0000b" holds a NUL character \(U\+0000\)/, `${dialect}: a condition's constant`);
    assert.throws(() => render(dialect, [compute('a\0b')]), /holds a NUL character/, `${dialect}: a computed value's constant`);
  }
});

// A TIME OF DAY IS NO MOMENT: a TIME column (BigQuery's TIME, DuckDB's TIME) has an hour and no date, and
// no warehouse reads it as a TIMESTAMP (BigQuery casts no TIME to one) — so date_part takes its hour
// alone, and a date part of it is refused when the step is built, on both warehouses alike.
test('date_part of a time of day takes its hour; a date part of it is refused, naming the part', () => {
  const columns = [{ name: 'local_time', type: physicalColumnType('TIME') }, { name: 'at', type: physicalColumnType('TIMESTAMP') }, { name: 'day', type: physicalColumnType('DATE') }];
  const part = (column, p) => ({ stage: 'compute', name: `p_${p}`, expr: { fn: 'date_part', args: [{ column }], part: p } });
  for (const dialect of DIALECTS) {
    const read = (steps) => renderRead(catalog, "{{ ref('t') }}", columns, steps, { dialect });
    assert.equal(read([part('local_time', 'hour')]).columns.get('p_hour').type, 'int', `${dialect}: the hour of a time of day`);
    for (const p of ['dow', 'day', 'week', 'month', 'quarter', 'year', 'doy']) {
      assert.throws(() => read([part('local_time', p)]), new RegExp(`date_part: its argument is a time of day, which has an hour and no date — part '${p}' needs a date or a timestamp`), `${dialect}: ${p}`);
      // a moment has every part
      assert.doesNotThrow(() => read([part('at', p), { ...part('day', p), name: `d_${p}` }]), `${dialect}: ${p} of a moment`);
    }
  }
});

// A DATE PART TAKES THE VALUES OF ITS NUMBERING: a constant compared with it outside them would match no
// row (or every row) without a word — a weekend counted as [0, 6] where dow is ISO (Saturday 6, Sunday 7).
test('a date part compared with a constant outside its numbering is refused, naming the range', () => {
  const columns = [{ name: 'at', type: physicalColumnType('TIMESTAMP') }];
  const dow = { fn: 'date_part', args: [{ column: 'at' }], part: 'dow' };
  const keep = (fn, ...values) => ({ stage: 'where', conditions: [{ fn, args: [dow, ...values.map((value) => ({ value }))] }] });
  for (const dialect of DIALECTS) {
    const read = (steps) => renderRead(catalog, "{{ ref('t') }}", columns, steps, { dialect });
    assert.throws(() => read([keep('in', 0, 6)]), /'dow' runs 1 … 7 \(ISO: Monday 1 … Saturday 6, Sunday 7/, `${dialect}: a weekend counted from 0`);
    assert.throws(() => read([keep('gt', 8)]), /compares date_part 'dow' with 8/, `${dialect}: past the last day`);
    assert.doesNotThrow(() => read([keep('in', 6, 7)]), `${dialect}: the ISO weekend`);
    assert.throws(() => read([{ stage: 'where', conditions: [{ fn: 'eq', args: [{ fn: 'date_part', args: [{ column: 'at' }], part: 'hour' }, { value: 24 }] }] }]), /'hour' runs 0 … 23/, `${dialect}: hour 24`);
  }
});
