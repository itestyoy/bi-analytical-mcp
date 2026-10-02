// WHAT AN EXPRESSION OR A CONDITION CANNOT BE IS REFUSED WHEN THE STAGE IS ADDED — not minutes later
// by the warehouse, and not silently: a window function in a where (SQL filters rows before any window
// is computed), a window function inside another's arguments (no warehouse nests them), a list where a
// value goes, a step stored by an earlier version, a window bound that does not read as a moment.
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
const COLS = new Set(['player_id_of_internal', 'device_time', 'event_name', 'session_number']);
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

test('a step stored by an earlier version says so, for each spelling that changed', () => {
  const said = (stage) => { try { render([stage]); return ''; } catch (e) { return e.message; } };
  for (const stage of [
    { stage: 'compute', name: 'd', op: 'elapsed_days', from: { column: 'device_time' }, to: { now: true } },
    { stage: 'aggregate', measures: [{ name: 'n', fn: 'count' }] },
    { stage: 'pivot', on: 'event_name', fn: 'sum', value_column: 'session_number', values: ['tutorial'] },
    { stage: 'join', with: 'users', via: 'user', attrs: [{ column: 'country', as: 'c' }] },
    { stage: 'unnest', source: 'items', as: 'item' },
  ]) assert.match(said(stage), /stored by an earlier version of this server.*write it as this version does/s, stage.stage);
});

test('a value picked from several is typed as its arguments are, and compared in that type', () => {
  // the earlier of two times is a time: a date constant compares with it
  assert.ok(render([
    { stage: 'compute', name: 'first_seen', expr: { fn: 'least', args: [{ column: 'device_time' }, { now: true }] } },
    { stage: 'where', conditions: [{ column: 'first_seen', op: 'gte', value: '2026-01-01' }] },
  ]).columns.get('first_seen').type !== 'numeric');
  // a number falling back to a number is a number: a word does not compare with it
  assert.throws(() => render([
    { stage: 'compute', name: 'n', expr: { fn: 'coalesce', args: [{ column: 'session_number' }, { value: 0 }] } },
    { stage: 'where', conditions: [{ column: 'n', op: 'eq', value: 'many' }] },
  ]), /'n' is a numeric column/);
});

test('a whole-table window in a CASE\'s condition, or a raw OVER () in a where, gets the global-window nudge', async () => {
  const e = new Engine({ catalog, contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'guards-')) }) });
  const caseWindow = { stage: 'compute', name: 'above', expr: { fn: 'case', cases: [{ when: [{ left: { fn: 'average', args: [{ column: 'session_number' }], over: {} }, op: 'gt', value: 1 }], then: { value: 1 } }], else: { value: 0 }, type: 'int' } };
  assert.match(e.advisor.globalWindowWarnings(caseWindow).join(' '), /Global analytic window: the window function 'average' has no partition_by/);
  const rawWhere = { stage: 'where', conditions: [{ left: { fn: 'raw', sql: 'count(*) over ()' }, op: 'gt', value: 1 }] };
  assert.match(e.advisor.globalWindowWarnings(rawWhere).join(' '), /raw expression uses OVER \(\) with no PARTITION BY/);
  assert.deepEqual(e.advisor.globalWindowWarnings({ stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'x' }] }), []);
});

test('a window bound with its own offset is that instant whatever the timezone; one that reads as no moment is refused', () => {
  const r = resolveTimeRange({ start: '2026-09-01T00:00:00Z', end: '2026-09-07T23:59:59.500+02:00', timezone: 'Europe/Berlin' });
  assert.deepEqual([r.start, r.end], ['2026-09-01 00:00:00', '2026-09-07 21:59:59.500']);
  // a wall-clock bound is still read in the zone
  assert.equal(resolveTimeRange({ start: '2026-09-01 10:00', timezone: 'Europe/Berlin' }).start, '2026-09-01 08:00:00');
  assert.throws(() => resolveTimeRange({ start: 'last week', timezone: 'Europe/Berlin' }), (e) => e.field === 'time_range.start' && /not a date or a date-time/.test(e.message));
});
