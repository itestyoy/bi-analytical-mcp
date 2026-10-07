// WHAT AN EXPRESSION OR A CONDITION CANNOT BE IS REFUSED WHEN THE STAGE IS ADDED — not minutes later
// by the warehouse, and not silently: a window function in a where (SQL filters rows before any window
// is computed — raw SQL with OVER included), a window function inside another's arguments (no warehouse
// nests them), a list where a value goes, a window bound that does not read as a moment. A step stored by
// an earlier version is carried over to this version's spelling.
// What a value picked from several is typed as follows its arguments, so the next stage compares it
// in its own type; and a whole-table window in a CASE's condition gets the same nudge as one in its
// branch. Input-validation guards only: nothing here reads generated SQL.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { renderPipeline } from '../../src/pipeline.js';
import { resolveTimeRange } from '../../src/time-range.js';

const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));
const catalog = loadCatalog(CATALOG, {});
const COLS = new Set(['player_id_of_internal', 'device_time', 'event_date', 'event_name', 'session_number']);
const render = (stages) => renderPipeline(catalog, catalog.dialect, 'events', stages, { physicalCols: COLS });
const OVER = { partition_by: ['player_id_of_internal'], order_by: [{ key: 'device_time' }] };

test('a window function is refused in a where, with the way: compute it into a column, then filter', () => {
  assert.throws(
    () => render([{ stage: 'where', conditions: [{ left: { fn: 'row_number', over: OVER }, op: 'eq', value: 1 }] }]),
    /window function \(row_number\) cannot be compared in a where.*compute stage/s,
  );
  // …inside an { or } too
  assert.throws(
    () => render([{ stage: 'where', conditions: [{ or: [{ column: 'event_name', op: 'eq', value: 'tutorial' }, { left: { fn: 'lag', args: [{ column: 'session_number' }], over: OVER }, op: 'gt', value: 1 }] }] }]),
    /window function \(lag\) cannot be compared in a where/,
  );
  // the way it says: the window in a column, the where on that column
  const ok = render([
    { stage: 'compute', name: 'nth', expr: { fn: 'row_number', over: OVER } },
    { stage: 'where', conditions: [{ column: 'nth', op: 'eq', value: 1 }] },
  ]);
  assert.ok(ok.columns.has('nth'));
  // a CASE in a computed column may test one: that is a select list, where windows are computed
  assert.ok(render([{ stage: 'compute', name: 'first', expr: { fn: 'case', cases: [{ when: [{ left: { fn: 'row_number', over: OVER }, op: 'eq', value: 1 }], then: { value: 1 } }], else: { value: 0 }, type: 'int' } }]).columns.has('first'));
});

test('a window function is refused as the argument of another', () => {
  assert.throws(
    () => render([{ stage: 'compute', name: 'x', expr: { fn: 'sum', args: [{ fn: 'lag', args: [{ column: 'session_number' }], over: OVER }], over: OVER } }]),
    /window function \(lag\) cannot be an argument of another window function/,
  );
  // arithmetic over windows is not nesting: sum(x) over (…) - lag(x) over (…)
  assert.ok(render([{ stage: 'compute', name: 'x', expr: { fn: 'sub', args: [{ fn: 'sum', args: [{ column: 'session_number' }], over: OVER }, { fn: 'lag', args: [{ column: 'session_number' }], over: OVER }] } }]).columns.has('x'));
});

test('a list is a condition\'s constant, never an expression\'s value', () => {
  assert.throws(
    () => render([{ stage: 'compute', name: 'x', expr: { fn: 'coalesce', args: [{ column: 'session_number' }, { value: [1, 2] }] } }]),
    /a constant is a string, a number, a boolean or null — a list belongs in a condition's `value`/,
  );
  // where it belongs
  assert.ok(render([{ stage: 'where', conditions: [{ column: 'session_number', op: 'in', value: [1, 2] }] }]));
});

test('a step stored by an earlier version is built in this version\'s spelling — the same columns as the step written today', () => {
  const columns = (stages) => [...render(stages).columns.entries()].map(([k, v]) => `${k}:${v.type}`);
  for (const [earlier, today] of [
    [{ stage: 'compute', name: 'd', op: 'elapsed_days', from: { column: 'device_time' }, to: { now: true } }, { stage: 'compute', name: 'd', expr: { fn: 'elapsed_days', args: [{ column: 'device_time' }, { now: true }] } }],
    [{ stage: 'compute', name: 'w', op: 'window', fn: 'avg', column: 'session_number', partition_by: ['player_id_of_internal'] }, { stage: 'compute', name: 'w', expr: { fn: 'average', args: [{ column: 'session_number' }], over: { partition_by: ['player_id_of_internal'] } } }],
    [{ stage: 'aggregate', group_by: ['event_name'], measures: [{ name: 'n', fn: 'avg', column: 'session_number' }, { name: 'p', fn: 'percentile', q: 0.9, column: 'session_number' }] }, { stage: 'aggregate', group_by: ['event_name'], measures: [{ name: 'n', agg: 'average', column: 'session_number' }, { name: 'p', agg: 'percentile', percentile: 0.9, column: 'session_number' }] }],
    [{ stage: 'pivot', on: 'event_name', fn: 'avg', value_column: 'session_number', values: ['tutorial'] }, { stage: 'pivot', on: 'event_name', agg: 'average', value_column: 'session_number', values: ['tutorial'] }],
    [{ stage: 'join', with: 'users', via: 'user', attrs: [{ column: 'country', as: 'c' }] }, { stage: 'join', with: 'users', via: 'user', attrs: [{ column: 'country', name: 'c' }] }],
  ]) assert.deepEqual(columns([earlier]), columns([today]), earlier.stage);
  // a derive stage is the compute stage reading the same event property — a column of its own, or a key of the payload
  const withPayload = (stages) => [...renderPipeline(catalog, catalog.dialect, 'events', stages, { physicalCols: new Set([...COLS, 'event_data', 'price_in_usd_of_event_data']) }).columns.entries()].map(([k, v]) => `${k}:${v.type}`);
  for (const [earlier, today] of [
    [{ stage: 'derive', name: 'p', op: 'extract', source: 'price_in_usd_of_event_data', type: 'numeric' }, { stage: 'compute', name: 'p', expr: { fn: 'event_property', property: 'price_in_usd_of_event_data', type: 'numeric' } }],
    [{ stage: 'derive', name: 'n', op: 'array_length', source: 'words_collected' }, { stage: 'compute', name: 'n', expr: { fn: 'array_length', property: 'words_collected' } }],
    [{ stage: 'derive', name: 'c', op: 'contains', source: 'words_collected', value: 'cat' }, { stage: 'compute', name: 'c', expr: { fn: 'array_contains', property: 'words_collected', item: 'cat' } }],
  ]) assert.deepEqual(withPayload([earlier]), withPayload([today]), earlier.op);
});

test('a value picked from several is typed as its arguments are, and compared in that type', () => {
  // the earlier of two times is a time: a date constant compares with it
  assert.ok(render([
    { stage: 'compute', name: 'first_seen', expr: { fn: 'least', args: [{ column: 'device_time' }, { now: true }] } },
    { stage: 'where', conditions: [{ column: 'first_seen', op: 'gte', value: '2026-01-01' }] },
  ]).columns.get('first_seen').type !== 'numeric');
  // a date and a time are both moments: never typed a number
  assert.ok(render([
    { stage: 'compute', name: 'first', expr: { fn: 'least', args: [{ column: 'event_date' }, { column: 'device_time' }] } },
    { stage: 'where', conditions: [{ column: 'first', op: 'gte', value: '2026-01-01' }] },
  ]).columns.get('first').type !== 'numeric');
  // a number falling back to a number is a number: a word does not compare with it
  assert.throws(() => render([
    { stage: 'compute', name: 'n', expr: { fn: 'coalesce', args: [{ column: 'session_number' }, { value: 0 }] } },
    { stage: 'where', conditions: [{ column: 'n', op: 'eq', value: 'many' }] },
  ]), /'n' is a numeric column/);
});

test('a whole-table window in a CASE\'s condition gets the global-window nudge; a raw OVER () in a where is refused like a structured window', async () => {
  const e = new Engine({ catalog, contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'guards-')) }) });
  const caseWindow = { stage: 'compute', name: 'above', expr: { fn: 'case', cases: [{ when: [{ left: { fn: 'average', args: [{ column: 'session_number' }], over: {} }, op: 'gt', value: 1 }], then: { value: 1 } }], else: { value: 0 }, type: 'int' } };
  assert.match(e.advisor.globalWindowWarnings(caseWindow).join(' '), /Global analytic window: the window function 'average' has no partition_by/);
  // in a where a window is not a cost but an error, partitioned or not
  for (const sql of ['count(*) over ()', 'count(*) OVER (PARTITION BY player_id_of_internal)']) {
    assert.throws(() => render([{ stage: 'where', conditions: [{ left: { fn: 'raw', sql }, op: 'gt', value: 1 }] }]), /raw expression with OVER \(…\) is a window function, and a where cannot compare one/);
  }
  // the word in a string is no window
  assert.ok(render([{ stage: 'where', conditions: [{ left: { fn: 'raw', sql: "'game over (again)'" }, op: 'eq', value: 'x' }] }]));
});

test('a window bound with its own offset is that instant, with or without a timezone; fractions stay as written; no impossible moment is rolled over', () => {
  const r = resolveTimeRange({ start: '2026-09-01T00:00:00Z', end: '2026-09-07T23:59:59.500+02:00', timezone: 'Europe/Berlin' });
  assert.deepEqual([r.start, r.end], ['2026-09-01 00:00:00', '2026-09-07 21:59:59.500']);
  // without a timezone the offset still names the instant — so the partition day is the instant's own
  assert.equal(resolveTimeRange({ start: '2024-01-02T01:00+03:00' }).start, '2024-01-01 22:00:00');
  // a wall-clock bound is read in the zone, its fraction of a second as written
  assert.equal(resolveTimeRange({ start: '2026-09-01 10:00', timezone: 'Europe/Berlin' }).start, '2026-09-01 08:00:00');
  assert.equal(resolveTimeRange({ start: '2024-01-01 10:00:00.255', timezone: 'UTC' }).start, '2024-01-01 10:00:00.255');
  assert.equal(resolveTimeRange({ start: '2024-01-01 10:00:00.255', timezone: 'Europe/Berlin' }).start, '2024-01-01 09:00:00.255');
  // a day the month does not have, an hour past 23: refused on every path, never rolled into the next day
  for (const tr of [{ start: '2024-02-30', timezone: 'Europe/Berlin' }, { start: '2024-02-30T10:00Z' }, { start: '2024-01-01 25:00' }, { start: '2024-01-01T25:00Z', timezone: 'UTC' }, { start: 'last week', timezone: 'Europe/Berlin' }]) {
    assert.throws(() => resolveTimeRange(tr), (e) => e.field === 'time_range.start' && /not a date or a date-time/.test(e.message), JSON.stringify(tr));
  }
});

test('the earliest or latest of a column is of that column\'s type — a time stays a time, and compares with a date', () => {
  const out = render([
    { stage: 'aggregate', group_by: ['player_id_of_internal'], measures: [{ name: 'first_at', agg: 'min', column: 'device_time' }, { name: 'most', agg: 'max', column: 'session_number' }, { name: 'n', agg: 'count' }] },
    { stage: 'where', conditions: [{ column: 'first_at', op: 'gte', value: '2026-01-01' }] },
  ]);
  assert.deepEqual(['first_at', 'most', 'n'].map((c) => out.columns.get(c).type), [render([]).columns.get('device_time').type, 'numeric', 'numeric']);
});
