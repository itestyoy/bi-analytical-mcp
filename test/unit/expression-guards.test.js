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
    [{ stage: 'pivot', on: 'event_name', fn: 'avg', value_column: 'session_number', values: ['tutorial'] }, { stage: 'pivot', on: 'event_name', measure: { agg: 'average', column: 'session_number' }, values: [{ value: 'tutorial', name: 'tutorial' }] }],
    [{ stage: 'pivot', on: 'event_name', agg: 'sum', value_column: 'session_number', values: ['Tutorial', '7'] }, { stage: 'pivot', on: 'event_name', measure: { agg: 'sum', column: 'session_number' }, values: [{ value: 'Tutorial', name: 'Tutorial' }, { value: '7', name: '_7' }] }],
    [{ stage: 'join', with: 'users', via: 'user', attrs: [{ column: 'country', as: 'c' }] }, { stage: 'join', with: 'users', via: 'user', attrs: [{ column: 'country', name: 'c' }] }],
    [{ stage: 'join', with: 'users', via: 'user', between: { value: 'device_time', from: 'install_time_valid_from', to: 'install_time_valid_until' }, attrs: [{ column: 'country' }] }, { stage: 'join', with: 'users', via: 'user', between: { column: 'device_time', from: 'install_time_valid_from', to: 'install_time_valid_until' }, attrs: [{ column: 'country' }] }],
    [{ stage: 'unpivot', keep: ['event_name'], columns: ['session_number'], name_as: 'metric', value_as: 'amount' }, { stage: 'unpivot', keep: ['event_name'], columns: ['session_number'], name_column: 'metric', value_column: 'amount' }],
    [{ stage: 'project', columns: ['event_name', 'device_time'] }, { stage: 'project', keep: ['event_name', 'device_time'] }],
    [{ stage: 'limit', n: 5 }, { stage: 'limit', limit: 5 }],
    [{ stage: 'sample', percent: 10 }, { stage: 'sample', share: 0.1 }],
    [{ stage: 'where', conditions: [{ left: { column: 'session_number' }, op: 'gt', value: 1, right: { column: 'session_number' } }, { or: [{ left: { column: 'event_name' }, op: 'eq', value: 'tutorial' }, { column: 'session_number', op: 'is_null' }] }] }, { stage: 'where', conditions: [{ column: 'session_number', op: 'gt', right: { column: 'session_number' } }, { or: [{ column: 'event_name', op: 'eq', value: 'tutorial' }, { column: 'session_number', op: 'is_null' }] }] }],
    [{ stage: 'where', conditions: [{ column: 'session_number', op: 'gt', right: { value: 1 } }, { left: { fn: 'length', args: [{ column: 'event_name' }] }, op: 'gt', value: 9, right: { value: 3 } }] }, { stage: 'where', conditions: [{ column: 'session_number', op: 'gt', value: 1 }, { left: { fn: 'length', args: [{ column: 'event_name' }] }, op: 'gt', value: 3 }] }],
    [{ stage: 'compute', name: 'k', expr: { fn: 'case', cases: [{ when: [{ left: { column: 'session_number' }, op: 'gt', value: 1 }], then: { value: 'more' } }], else: { value: 'one' } } }, { stage: 'compute', name: 'k', expr: { fn: 'case', cases: [{ when: [{ column: 'session_number', op: 'gt', value: 1 }], then: { value: 'more' } }], else: { value: 'one' } } }],
    [{ stage: 'aggregate', measures: [{ name: 'n', agg: 'count', where: [{ left: { column: 'event_name' }, op: 'eq', value: 'tutorial' }] }] }, { stage: 'aggregate', measures: [{ name: 'n', agg: 'count', where: [{ column: 'event_name', op: 'eq', value: 'tutorial' }] }] }],
    [{ stage: 'match_recognize', mode: 'ordered', between_steps: 'gap', partition_by: ['player_id_of_internal'], steps: [{ name: 'a', event_name: ['first_launch'] }, { name: 'b', event_name: ['tutorial'] }] }, { stage: 'match_recognize', between_steps: 'gap', partition_by: ['player_id_of_internal'], steps: [{ name: 'a', event_name: ['first_launch'] }, { name: 'b', event_name: ['tutorial'] }] }],
    [{ stage: 'match_recognize', mode: 'ordered', partition_by: ['player_id_of_internal'], steps: [{ name: 'a', event_name: ['first_launch'] }, { name: 'b', event_name: ['tutorial'] }] }, { stage: 'match_recognize', partition_by: ['player_id_of_internal'], steps: [{ name: 'a', event_name: ['first_launch'] }, { name: 'b', event_name: ['tutorial'] }] }],
  ]) assert.deepEqual(columns([earlier]), columns([today]), JSON.stringify(earlier));
  // a kept strict funnel is the funnel whose steps are adjacent events: what a warehouse without a
  // row-pattern match cannot say, refused as that choice
  assert.throws(() => render([{ stage: 'match_recognize', mode: 'strict', partition_by: ['player_id_of_internal'], steps: [{ name: 'a', event_name: ['first_launch'] }, { name: 'b', event_name: ['tutorial'] }] }]), /between_steps 'none'/);
  // a kept unnest's `source` is the property it named, or the array column a step before it made — as its build resolved it
  const unnested = (stages) => [...renderPipeline(catalog, catalog.dialect, 'events', stages, { physicalCols: new Set([...COLS, 'event_data']) }).columns.entries()].map(([k, v]) => `${k}:${v.type}`);
  assert.deepEqual(unnested([{ stage: 'unnest', source: 'words_collected', name: 'w' }]), unnested([{ stage: 'unnest', property: 'words_collected', name: 'w' }]));
  const parsed = { stage: 'compute', name: 'arr', expr: { fn: 'json_parse_array', args: [{ column: 'event_name' }] } };
  assert.deepEqual(unnested([parsed, { stage: 'unnest', source: 'arr', name: 'w' }]), unnested([parsed, { stage: 'unnest', column: 'arr', name: 'w' }]));
  // the render reports each kept step in today's spelling — what a draft keeps from its next accepted
  // edit — and a draft's steps are shown in it, so one copied into edit_step is one the tool takes
  const keptSteps = [parsed, { stage: 'unnest', source: 'arr', name: 'w' }, { stage: 'limit', n: 5 }];
  const built = renderPipeline(catalog, catalog.dialect, 'events', keptSteps, { physicalCols: new Set([...COLS, 'event_data']) });
  assert.deepEqual(keptSteps.map((s) => built.current.get(s)), [parsed, { stage: 'unnest', column: 'arr', name: 'w' }, { stage: 'limit', limit: 5 }]);
  assert.equal(built.current.get(parsed), parsed, 'a step in today\'s spelling is kept as it is');
  // the view is the render's own spelling, not a guess beside it: each step as its build renders it
  const view = Object.assign(Object.create(Engine.prototype), { catalog });
  const physSet = new Set([...COLS, 'event_data']);
  const draftSteps = [{ stage: 'limit', n: 5 }, { stage: 'unnest', source: 'words_collected', name: 'w' }, parsed, { stage: 'unnest', source: 'arr', name: 'v' }];
  assert.deepEqual(view._draftSteps({ source: 'events', stages: draftSteps }, physSet), [
    { index: 1, stage: 'limit', limit: 5 },
    { index: 2, stage: 'unnest', property: 'words_collected', name: 'w' },
    { index: 3, ...parsed },
    { index: 4, stage: 'unnest', column: 'arr', name: 'v' },
  ]);
  // a kept funnel's step condition on a name that is both an event property and a column of the rows
  // is the column, as its build resolves it — so the step copied into edit_step reads that column
  const onLevel = { stage: 'match_recognize', partition_by: ['player_id_of_internal'], steps: [{ name: 'a', event_name: ['level_started'] }, { name: 'b', event_name: ['level_completed'], where: [{ property: 'level_id_of_event_data', op: 'eq', value: 1 }] }] };
  const levelCols = new Set([...COLS, 'level_id_of_event_data']);
  const [shown] = view._draftSteps({ source: 'events', stages: [onLevel] }, levelCols);
  const { index: _i, ...shownStep } = shown;
  assert.deepEqual(shownStep, renderPipeline(catalog, catalog.dialect, 'events', [onLevel], { physicalCols: levelCols }).current.get(onLevel));
  assert.deepEqual(shownStep.steps[1].where, [{ column: 'level_id_of_event_data', op: 'eq', value: 1 }]);
  // a step that no longer builds is shown as stored, the steps before it as built
  const broken = view._draftSteps({ source: 'events', stages: [{ stage: 'limit', n: 5 }, { stage: 'where', conditions: [{ column: 'no_such_column', op: 'eq', value: 1 }] }] }, physSet);
  assert.deepEqual(broken.map(({ index: _n, ...s }) => s), [{ stage: 'limit', limit: 5 }, { stage: 'where', conditions: [{ column: 'no_such_column', op: 'eq', value: 1 }] }]);
  // a kept one that named a scalar property — which the schema no longer offers — is refused by its build, saying what the property is
  assert.throws(() => renderPipeline(catalog, catalog.dialect, 'events', [{ stage: 'unnest', source: 'price_in_usd_of_event_data', name: 'w' }], { physicalCols: new Set([...COLS, 'price_in_usd_of_event_data']) }), /'price_in_usd_of_event_data' is declared as numeric, not an array/);
  // a derive stage is the compute stage reading the same event property — a column of its own, or a key of the payload
  const withPayload = (stages) => [...renderPipeline(catalog, catalog.dialect, 'events', stages, { physicalCols: new Set([...COLS, 'event_data', 'price_in_usd_of_event_data']) }).columns.entries()].map(([k, v]) => `${k}:${v.type}`);
  for (const [earlier, today] of [
    [{ stage: 'derive', name: 'p', op: 'extract', source: 'price_in_usd_of_event_data', type: 'numeric' }, { stage: 'compute', name: 'p', expr: { fn: 'event_property', property: 'price_in_usd_of_event_data', type: 'numeric' } }],
    [{ stage: 'derive', name: 'n', op: 'array_length', source: 'words_collected' }, { stage: 'compute', name: 'n', expr: { fn: 'array_length', property: 'words_collected' } }],
    [{ stage: 'derive', name: 'c', op: 'contains', source: 'words_collected', value: 'cat' }, { stage: 'compute', name: 'c', expr: { fn: 'array_contains', property: 'words_collected', item: 'cat' } }],
  ]) assert.deepEqual(withPayload([earlier]), withPayload([today]), earlier.op);
  // a funnel kept with a step condition on `property`, a `filter` and `metrics` builds the columns it built
  const kept = { stage: 'match_recognize', partition_by: ['player_id_of_internal'], steps: [{ name: 'a', event_name: ['first_launch'] }, { name: 'b', event_name: ['tutorial'], where: [{ property: 'session_number', op: 'gte', value: 1 }] }], filter: { event_name: ['first_launch', 'tutorial'] }, metrics: [{ name: 'gap', type: 'avg_seconds_between', from: 'a', to: 'b' }, { name: 'n', type: 'agg_at_step', step: 'b', property: 'session_number' }] };
  const out = withPayload([kept]);
  for (const c of ['reached_b:boolean', 'at_b:time', 'secs_gap:numeric', 'pv_n:numeric']) assert.ok(out.includes(c), `${c} in ${out.join(', ')}`);
  // a kept funnel whose step reads an event property as its left side — the form a `property`
  // condition became — still has its `mode` and its other kept conditions carried over: a strict one
  // is the adjacent-events funnel, refused here as that choice…
  const price = { left: { fn: 'event_property', property: 'price_in_usd_of_event_data', type: 'numeric' }, op: 'gte', value: 1 };
  const funnel = (extra, where) => ({ stage: 'match_recognize', partition_by: ['player_id_of_internal'], steps: [{ name: 'a', event_name: ['first_launch'] }, { name: 'b', event_name: ['tutorial'], where }], ...extra });
  assert.throws(() => withPayload([funnel({ mode: 'strict' }, [price])]), /between_steps 'none'/);
  assert.throws(() => withPayload([funnel({ mode: 'strict' }, [{ or: [price, { column: 'session_number', op: 'gt', value: 1 }] }])]), /between_steps 'none'/);
  // …and an ordered one builds what its current spelling builds, its left: { column } and its
  // top-level `property` (inside an { or } too) in this version's forms
  for (const [earlier, today] of [
    [funnel({ mode: 'ordered' }, [price, { left: { column: 'session_number' }, op: 'gt', value: 1 }]), funnel({}, [price, { column: 'session_number', op: 'gt', value: 1 }])],
    [funnel({ mode: 'ordered', between_steps: 'gap' }, [{ or: [price, { property: 'session_number', op: 'gte', value: 1 }, { left: { column: 'session_number' }, op: 'gt', value: 1, right: { column: 'session_number' } }] }]), funnel({ between_steps: 'gap' }, [{ or: [price, { column: 'session_number', op: 'gte', value: 1 }, { column: 'session_number', op: 'gt', right: { column: 'session_number' } }] }])],
    [funnel({ mode: 'ordered' }, [price, { column: 'session_number', op: 'gt', right: { value: 1 } }]), funnel({}, [price, { column: 'session_number', op: 'gt', value: 1 }])],
  ]) assert.deepEqual(withPayload([earlier]), withPayload([today]), JSON.stringify(earlier));
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

test('a condition is a column or an expression against a constant or an expression — never `value` and `right` together, never left: { column } or right: { value }', async () => {
  const e = new Engine({ catalog, contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'guards-')) }) });
  const { context_id } = await e.build_pipeline_model({ action: 'start', name: 'cond', source: 'events' });
  const add = (c) => e.build_pipeline_model({ action: 'add_steps', context_id, stages: [{ stage: 'where', conditions: [c] }] });
  // both right sides: no form takes the two, so the schema refuses rather than one being ignored
  await assert.rejects(() => add({ column: 'session_number', op: 'gt', value: 1, right: { column: 'session_number' } }), /unexpected property/);
  await assert.rejects(() => add({ left: { fn: 'length', args: [{ column: 'event_name' }] }, op: 'gt', value: 1, right: { value: 2 } }), /unexpected property/);
  // a column is `column`: left: { column } is told so
  await assert.rejects(() => add({ left: { column: 'session_number' }, op: 'gt', value: 1 }), /write \{ column \} instead of left: \{ column \}/);
  // a constant compared with is `value`: right: { value } is told so — on either left side
  await assert.rejects(() => add({ column: 'session_number', op: 'gt', right: { value: 1 } }), /write value: 1 instead of right: \{ value \}/);
  await assert.rejects(() => add({ left: { fn: 'length', args: [{ column: 'event_name' }] }, op: 'gt', right: { value: 3 } }), /write value: 3 instead of right: \{ value \}/);
  // each of the four forms is taken
  for (const c of [
    { column: 'session_number', op: 'gt', value: 1 },
    { column: 'session_number', op: 'is_null' },
    { column: 'session_number', op: 'gte', right: { column: 'session_number' } },
    { left: { fn: 'length', args: [{ column: 'event_name' }] }, op: 'gt', value: 3 },
    { left: { fn: 'length', args: [{ column: 'event_name' }] }, op: 'gt', right: { column: 'session_number' } },
  ]) assert.ok(await add(c), JSON.stringify(c));
});

test('a pivot names a column per value, never twice or as a group key; unpivot keeps or folds a column, not both', () => {
  const pivot = (extra) => render([{ stage: 'pivot', on: 'event_name', measure: { agg: 'count' }, ...extra }]);
  assert.throws(() => pivot({ values: [{ value: 'tutorial', name: 'n' }, { value: 'first_launch', name: 'n' }] }), /pivot: 'n' names two values/);
  assert.throws(() => pivot({ group_by: ['session_number'], values: [{ value: 'tutorial', name: 'session_number' }] }), /pivot: 'session_number' names a group_by column/);
  assert.throws(() => pivot({ values: [{ value: 'tutorial', name: 'a' }, { value: 'tutorial', name: 'b' }] }), /the value "tutorial" is listed twice/);
  assert.throws(() => render([{ stage: 'pivot', on: 'event_name', measure: { agg: 'sum', column: 'nope' }, values: [{ value: 'tutorial', name: 't' }] }]), /unknown column 'nope'/);
  // a number compared with a numeric column, a word refused there — the value is typed as `on` is
  assert.ok(render([{ stage: 'pivot', on: 'session_number', measure: { agg: 'count' }, values: [{ value: 1, name: 's1' }, { value: null, name: 'none' }] }]));
  assert.throws(() => render([{ stage: 'pivot', on: 'session_number', measure: { agg: 'count' }, values: [{ value: 'many', name: 's' }] }]), /'session_number' is a numeric column/);
  const unpivot = (extra) => render([{ stage: 'unpivot', columns: ['session_number'], name_column: 'metric', value_column: 'amount', ...extra }]);
  assert.deepEqual([...unpivot({ keep: ['event_name'] }).columns.keys()], ['event_name', 'metric', 'amount']);
  assert.throws(() => unpivot({ keep: ['session_number'] }), /'session_number' is both kept and folded/);
  assert.throws(() => unpivot({ keep: ['event_name'], name_column: 'event_name' }), /'event_name' is a kept column/);
  assert.throws(() => unpivot({ value_column: 'metric' }), /name the same column/);
});

test('a window partitions by a column or a declared relationship\'s one key column', () => {
  const nth = (partition) => render([{ stage: 'compute', name: 'rn', expr: { fn: 'row_number', over: { partition_by: [partition], order_by: [{ key: 'device_time' }] } } }]);
  assert.deepEqual([...nth({ entity: 'user' }).columns.keys()], [...nth('player_id_of_internal').columns.keys()]);
  assert.throws(() => nth('user'), /'user' is a RELATIONSHIP of 'events', not a column — write \{ entity: 'user' \}/);
  assert.throws(() => nth({ entity: 'ad_funnel' }), /is keyed by .*, which is an expression, not a column/);
});

test('a running window over a nullable key on BigQuery: NULLs where BigQuery puts them build, elsewhere the refusal names that way out', () => {
  const running = (key) => renderPipeline(catalog, 'bigquery', 'events', [
    { stage: 'compute', name: 'roll', expr: { fn: 'sum', args: [{ column: 'session_number' }], over: { partition_by: ['player_id_of_internal'], order_by: [key], frame: { mode: 'range', preceding: 'unbounded', following: 1 } } } },
  ], { physicalCols: COLS });
  assert.throws(() => running({ key: 'session_number' }), /say nulls: 'first' on that key \(desc: 'last'\)/);
  assert.throws(() => running({ key: 'session_number', direction: 'desc', nulls: 'first' }), /say nulls: 'first' on that key \(desc: 'last'\)/);
  for (const key of [{ key: 'session_number', nulls: 'first' }, { key: 'session_number', direction: 'desc', nulls: 'last' }]) assert.ok(running(key).columns.has('roll'), JSON.stringify(key));
});
