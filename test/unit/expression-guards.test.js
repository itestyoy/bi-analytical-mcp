// WHAT AN EXPRESSION OR A CONDITION CANNOT BE IS REFUSED WHEN THE STAGE IS ADDED — not minutes later
// by the warehouse, and not silently: a window function in a condition (SQL filters rows before any
// window is computed — raw SQL with OVER included, and a CASE's `when` is a condition too), a window
// function inside another's arguments (no warehouse nests them), a list where a constant goes, a window
// bound that does not read as a moment. A step stored by an earlier version is carried over to this
// version's spelling — the one expression grammar (src/earlier-spelling.js).
// What a value picked from several is typed as follows its arguments, so the next stage compares it
// in its own type; and a whole-table window in a CASE gets the same nudge as one at the top of a
// compute. Input-validation guards only: nothing here reads generated SQL.

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
const col = (column) => ({ column });
const val = (value) => ({ value });

test('a window function is refused in a condition, with the way: compute it into a column, then filter', () => {
  assert.throws(
    () => render([{ stage: 'where', conditions: [{ fn: 'eq', args: [{ fn: 'row_number', over: OVER }, val(1)] }] }]),
    /window function \(row_number with over\) cannot stand in a condition.*compute stage/s,
  );
  // …inside an or too
  assert.throws(
    () => render([{ stage: 'where', conditions: [{ fn: 'or', args: [{ fn: 'eq', args: [col('event_name'), val('tutorial')] }, { fn: 'gt', args: [{ fn: 'lag', args: [col('session_number')], over: OVER }, val(1)] }] }] }]),
    /window function \(lag with over\) cannot stand in a condition/,
  );
  // a CASE's `when` is a condition slot like a where's: a window is computed into a column first there too
  assert.throws(
    () => render([{ stage: 'compute', name: 'first', expr: { fn: 'case', cases: [{ when: [{ fn: 'eq', args: [{ fn: 'row_number', over: OVER }, val(1)] }], then: val(1) }], else: val(0), type: 'int' } }]),
    /window function \(row_number with over\) cannot stand in a condition/,
  );
  // the way it says: the window in a column, the where on that column
  const ok = render([
    { stage: 'compute', name: 'nth', expr: { fn: 'row_number', over: OVER } },
    { stage: 'where', conditions: [{ fn: 'eq', args: [col('nth'), val(1)] }] },
  ]);
  assert.ok(ok.columns.has('nth'));
  // a CASE's branch may be one: that is a select list, where windows are computed
  assert.ok(render([{ stage: 'compute', name: 'first', expr: { fn: 'case', cases: [{ when: [{ fn: 'gt', args: [col('session_number'), val(1)] }], then: { fn: 'row_number', over: OVER } }], else: val(0), type: 'int' } }]).columns.has('first'));
});

test('a window function is refused as the argument of another', () => {
  assert.throws(
    () => render([{ stage: 'compute', name: 'x', expr: { fn: 'sum', args: [{ fn: 'lag', args: [col('session_number')], over: OVER }], over: OVER } }]),
    /window function \(lag\) cannot be an argument of another window function/,
  );
  // arithmetic over windows is not nesting: sum(x) over (…) - lag(x) over (…)
  assert.ok(render([{ stage: 'compute', name: 'x', expr: { fn: 'sub', args: [{ fn: 'sum', args: [col('session_number')], over: OVER }, { fn: 'lag', args: [col('session_number')], over: OVER }] } }]).columns.has('x'));
});

test('a constant is never a list: a membership takes each member as an argument of its own', () => {
  assert.throws(
    () => render([{ stage: 'compute', name: 'x', expr: { fn: 'coalesce', args: [col('session_number'), val([1, 2])] } }]),
    /a constant is a string, a number, a boolean or null — a list is written as arguments of their own/,
  );
  assert.throws(
    () => render([{ stage: 'where', conditions: [{ fn: 'eq', args: [col('session_number'), val([1, 2])] }] }]),
    /a list is written as arguments of their own/,
  );
  // how a membership is written
  assert.ok(render([{ stage: 'where', conditions: [{ fn: 'in', args: [col('session_number'), val(1), val(2)] }] }]));
});

test('a step stored by an earlier version is built in this version\'s spelling — the step written today, and the same columns', () => {
  const physical = new Set([...COLS, 'event_data', 'price_in_usd_of_event_data']);
  const built = (stages) => renderPipeline(catalog, catalog.dialect, 'events', stages, { physicalCols: physical });
  const columns = (stages) => [...built(stages).columns.entries()].map(([k, v]) => `${k}:${v.type}`);
  // each pair: what an earlier version stored, and the step written today — the kept one is read as
  // today's (what the render reports, and what a draft shows), and builds the same columns
  // (a kept typed read is the property alone where the catalog reads it as that type, a cast where it named another)
  const price = { fn: 'gte', args: [{ property: 'price_in_usd_of_event_data' }, val(1)] };
  const funnel = (extra, where) => ({ stage: 'match_recognize', partition_by: ['player_id_of_internal'], steps: [{ name: 'a', event_name: ['first_launch'] }, { name: 'b', event_name: ['tutorial'], where }], ...extra });
  const priceThen = { left: { fn: 'event_property', property: 'price_in_usd_of_event_data', type: 'numeric' }, op: 'gte', value: 1 };
  for (const [earlier, today] of [
    // stage words
    [{ stage: 'compute', name: 'd', op: 'elapsed_days', from: col('device_time'), to: { now: true } }, { stage: 'compute', name: 'd', expr: { fn: 'elapsed_days', args: [col('device_time'), { now: true }] } }],
    [{ stage: 'compute', name: 'w', op: 'window', fn: 'avg', column: 'session_number', partition_by: ['player_id_of_internal'] }, { stage: 'compute', name: 'w', expr: { fn: 'average', args: [col('session_number')], over: { partition_by: ['player_id_of_internal'] } } }],
    [{ stage: 'join', with: 'users', via: 'user', attrs: [{ column: 'country', as: 'c' }] }, { stage: 'join', with: 'users', via: 'user', attrs: [{ column: 'country', name: 'c' }] }],
    [{ stage: 'join', with: 'users', via: 'user', between: { value: 'device_time', from: 'install_time_valid_from', to: 'install_time_valid_until' }, attrs: [{ column: 'country' }] }, { stage: 'join', with: 'users', via: 'user', between: { column: 'device_time', from: 'install_time_valid_from', to: 'install_time_valid_until' }, attrs: [{ column: 'country' }] }],
    [{ stage: 'unpivot', keep: ['event_name'], columns: ['session_number'], name_as: 'metric', value_as: 'amount' }, { stage: 'unpivot', keep: ['event_name'], columns: ['session_number'], name_column: 'metric', value_column: 'amount' }],
    [{ stage: 'project', columns: ['event_name', 'device_time'] }, { stage: 'project', keep: ['event_name', 'device_time'] }],
    [{ stage: 'limit', n: 5 }, { stage: 'limit', limit: 5 }],
    [{ stage: 'sample', percent: 10 }, { stage: 'sample', share: 0.1 }],
    [{ stage: 'match_recognize', mode: 'ordered', between_steps: 'gap', partition_by: ['player_id_of_internal'], steps: [{ name: 'a', event_name: ['first_launch'] }, { name: 'b', event_name: ['tutorial'] }] }, { stage: 'match_recognize', between_steps: 'gap', partition_by: ['player_id_of_internal'], steps: [{ name: 'a', event_name: ['first_launch'] }, { name: 'b', event_name: ['tutorial'] }] }],
    [{ stage: 'match_recognize', mode: 'ordered', partition_by: ['player_id_of_internal'], steps: [{ name: 'a', event_name: ['first_launch'] }, { name: 'b', event_name: ['tutorial'] }] }, { stage: 'match_recognize', partition_by: ['player_id_of_internal'], steps: [{ name: 'a', event_name: ['first_launch'] }, { name: 'b', event_name: ['tutorial'] }] }],
    // a measure: `fn` before `agg`, `q` before `percentile`, then `agg` + `column` — an expression now
    [{ stage: 'aggregate', group_by: ['event_name'], measures: [{ name: 'n', fn: 'avg', column: 'session_number' }, { name: 'p', fn: 'percentile', q: 0.9, column: 'session_number' }] }, { stage: 'aggregate', group_by: ['event_name'], measures: [{ name: 'n', expr: { fn: 'average', args: [col('session_number')] } }, { name: 'p', expr: { fn: 'percentile', args: [col('session_number')], percentile: 0.9 } }] }],
    [{ stage: 'aggregate', measures: [{ name: 'n', agg: 'count', where: [{ left: col('event_name'), op: 'eq', value: 'tutorial' }] }, { name: 's', agg: 'sum', column: 'session_number' }] }, { stage: 'aggregate', measures: [{ name: 'n', expr: { fn: 'count', args: [{ fn: 'case', cases: [{ when: [{ fn: 'eq', args: [col('event_name'), val('tutorial')] }], then: val(1) }] }] } }, { name: 's', expr: { fn: 'sum', args: [col('session_number')] } }] }],
    // an aggregate's where: the case it folds now
    [{ stage: 'aggregate', measures: [{ name: 's', expr: { fn: 'sum', args: [col('session_number')], where: [{ fn: 'gt', args: [col('session_number'), val(1)] }] } }] }, { stage: 'aggregate', measures: [{ name: 's', expr: { fn: 'sum', args: [{ fn: 'case', cases: [{ when: [{ fn: 'gt', args: [col('session_number'), val(1)] }], then: col('session_number') }] }] } }] }],
    // a pivot: agg + value_column + values as names, then a measure { agg, column } — the aggregate expression now
    [{ stage: 'pivot', on: 'event_name', fn: 'avg', value_column: 'session_number', values: ['tutorial'] }, { stage: 'pivot', on: 'event_name', measure: { fn: 'average', args: [col('session_number')] }, values: [{ value: 'tutorial', name: 'tutorial' }] }],
    [{ stage: 'pivot', on: 'event_name', agg: 'sum', value_column: 'session_number', values: ['Tutorial', '7'] }, { stage: 'pivot', on: 'event_name', measure: { fn: 'sum', args: [col('session_number')] }, values: [{ value: 'Tutorial', name: 'Tutorial' }, { value: '7', name: '_7' }] }],
    [{ stage: 'pivot', on: 'event_name', measure: { agg: 'count' }, values: [{ value: 'tutorial', name: 't' }] }, { stage: 'pivot', on: 'event_name', measure: { fn: 'count', args: [] }, values: [{ value: 'tutorial', name: 't' }] }],
    // a condition: { column | left, op, value | right } and its { or } / { and } groups — a function now;
    // a `value` beside `right` was not read, and an in's list is its members
    [{ stage: 'where', conditions: [{ left: col('session_number'), op: 'gt', value: 1, right: col('session_number') }, { or: [{ left: col('event_name'), op: 'eq', value: 'tutorial' }, { column: 'session_number', op: 'is_null' }] }] }, { stage: 'where', conditions: [{ fn: 'gt', args: [col('session_number'), col('session_number')] }, { fn: 'or', args: [{ fn: 'eq', args: [col('event_name'), val('tutorial')] }, { fn: 'is_null', args: [col('session_number')] }] }] }],
    [{ stage: 'where', conditions: [{ column: 'session_number', op: 'gt', right: { value: 1 } }, { left: { fn: 'length', args: [col('event_name')] }, op: 'gt', value: 9, right: { value: 3 } }, { column: 'session_number', op: 'in', value: [1, 2] }, { and: [{ column: 'event_name', op: 'neq', value: 'x' }] }] }, { stage: 'where', conditions: [{ fn: 'gt', args: [col('session_number'), val(1)] }, { fn: 'gt', args: [{ fn: 'length', args: [col('event_name')] }, val(3)] }, { fn: 'in', args: [col('session_number'), val(1), val(2)] }, { fn: 'neq', args: [col('event_name'), val('x')] }] }],
    [{ stage: 'compute', name: 'k', expr: { fn: 'case', cases: [{ when: [{ left: col('session_number'), op: 'gt', value: 1 }], then: val('more') }], else: val('one') } }, { stage: 'compute', name: 'k', expr: { fn: 'case', cases: [{ when: [{ fn: 'gt', args: [col('session_number'), val(1)] }], then: val('more') }], else: val('one') } }],
    // an event property read by a function of its own, and the array functions naming `property` — a leaf and args now;
    // a read that named its type: the read alone where it yields that type now, a cast where it is another
    [{ stage: 'compute', name: 'p', expr: { fn: 'event_property', property: 'price_in_usd_of_event_data', type: 'numeric' } }, { stage: 'compute', name: 'p', expr: { property: 'price_in_usd_of_event_data' } }],
    [{ stage: 'compute', name: 'p', expr: { property: 'price_in_usd_of_event_data', type: 'int' } }, { stage: 'compute', name: 'p', expr: { fn: 'cast', args: [{ property: 'price_in_usd_of_event_data' }], type: 'int' } }],
    [{ stage: 'compute', name: 'j', expr: { fn: 'json_field', args: [col('event_name')], field: 'a', type: 'int' } }, { stage: 'compute', name: 'j', expr: { fn: 'cast', args: [{ fn: 'json_field', args: [col('event_name')], field: 'a' }], type: 'int' } }],
    [{ stage: 'compute', name: 'j', expr: { fn: 'json_field', args: [col('event_name')], field: 'a', type: 'string' } }, { stage: 'compute', name: 'j', expr: { fn: 'json_field', args: [col('event_name')], field: 'a' } }],
    [{ stage: 'compute', name: 'n', expr: { fn: 'array_length', property: 'words_collected' } }, { stage: 'compute', name: 'n', expr: { fn: 'array_length', args: [{ property: 'words_collected' }] } }],
    [{ stage: 'compute', name: 'c', expr: { fn: 'array_contains', property: 'words_collected', item: 'cat' } }, { stage: 'compute', name: 'c', expr: { fn: 'array_contains', args: [{ property: 'words_collected' }, val('cat')] } }],
    // a derive stage is the compute stage reading the same event property — a column of its own, or a key of the payload
    [{ stage: 'derive', name: 'p', op: 'extract', source: 'price_in_usd_of_event_data', type: 'numeric' }, { stage: 'compute', name: 'p', expr: { property: 'price_in_usd_of_event_data' } }],
    [{ stage: 'derive', name: 'n', op: 'array_length', source: 'words_collected' }, { stage: 'compute', name: 'n', expr: { fn: 'array_length', args: [{ property: 'words_collected' }] } }],
    [{ stage: 'derive', name: 'c', op: 'contains', source: 'words_collected', value: 'cat' }, { stage: 'compute', name: 'c', expr: { fn: 'array_contains', args: [{ property: 'words_collected' }, val('cat')] } }],
    // an unnest naming its array as a field of its own — its expr now
    [{ stage: 'unnest', property: 'words_collected', name: 'w' }, { stage: 'unnest', expr: { property: 'words_collected' }, name: 'w' }],
    [{ stage: 'unnest', source: 'words_collected', name: 'w' }, { stage: 'unnest', expr: { property: 'words_collected' }, name: 'w' }],
    // a kept funnel's step conditions — the property read as a left side, a mode, an or — in this version's forms
    [funnel({ mode: 'ordered' }, [priceThen, { left: col('session_number'), op: 'gt', value: 1 }]), funnel({}, [price, { fn: 'gt', args: [col('session_number'), val(1)] }])],
    [funnel({ mode: 'ordered', between_steps: 'gap' }, [{ or: [priceThen, { property: 'session_number', op: 'gte', value: 1 }, { left: col('session_number'), op: 'gt', value: 1, right: col('session_number') }] }]), funnel({ between_steps: 'gap' }, [{ fn: 'or', args: [price, { fn: 'gte', args: [col('session_number'), val(1)] }, { fn: 'gt', args: [col('session_number'), col('session_number')] }] }])],
    [funnel({ mode: 'ordered' }, [priceThen, { column: 'session_number', op: 'gt', right: { value: 1 } }]), funnel({}, [price, { fn: 'gt', args: [col('session_number'), val(1)] }])],
  ]) {
    assert.deepEqual(built([earlier]).current.get(earlier), today, JSON.stringify(earlier));
    assert.deepEqual(columns([earlier]), columns([today]), JSON.stringify(earlier));
  }
  // a step in today's spelling is kept as it is — by identity
  const todays = { stage: 'where', conditions: [{ fn: 'eq', args: [col('event_name'), val('tutorial')] }] };
  assert.equal(built([todays]).current.get(todays), todays);
  // a kept strict funnel is the funnel whose steps are adjacent events: what a warehouse without a
  // row-pattern match cannot say, refused as that choice — whatever its step conditions are spelled in
  assert.throws(() => render([{ stage: 'match_recognize', mode: 'strict', partition_by: ['player_id_of_internal'], steps: [{ name: 'a', event_name: ['first_launch'] }, { name: 'b', event_name: ['tutorial'] }] }]), /between_steps 'none'/);
  assert.throws(() => built([funnel({ mode: 'strict' }, [priceThen])]), /between_steps 'none'/);
  assert.throws(() => built([funnel({ mode: 'strict' }, [{ or: [priceThen, { column: 'session_number', op: 'gt', value: 1 }] }])]), /between_steps 'none'/);
  // a kept unnest's `source` is the property it named, or the array column a step before it made — as its build resolved it
  const parsed = { stage: 'compute', name: 'arr', expr: { fn: 'json_parse_array', args: [col('event_name')] } };
  assert.deepEqual(columns([parsed, { stage: 'unnest', source: 'arr', name: 'w' }]), columns([parsed, { stage: 'unnest', expr: col('arr'), name: 'w' }]));
  // the render reports each kept step in today's spelling — what a draft keeps from its next accepted
  // edit — and a draft's steps are shown in it, so one copied into edit_step is one the tool takes
  const keptSteps = [parsed, { stage: 'unnest', source: 'arr', name: 'w' }, { stage: 'limit', n: 5 }];
  const kept = built(keptSteps);
  assert.deepEqual(keptSteps.map((s) => kept.current.get(s)), [parsed, { stage: 'unnest', expr: col('arr'), name: 'w' }, { stage: 'limit', limit: 5 }]);
  assert.equal(kept.current.get(parsed), parsed, 'a step in today\'s spelling is kept as it is');
  // the view is the render's own spelling, not a guess beside it: each step as its build renders it
  const view = Object.assign(Object.create(Engine.prototype), { catalog });
  const physSet = new Set([...COLS, 'event_data']);
  const draftSteps = [{ stage: 'limit', n: 5 }, { stage: 'unnest', source: 'words_collected', name: 'w' }, parsed, { stage: 'unnest', source: 'arr', name: 'v' }, { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'x' }] }];
  assert.deepEqual(view._draftSteps({ source: 'events', stages: draftSteps }, physSet), [
    { index: 1, stage: 'limit', limit: 5 },
    { index: 2, stage: 'unnest', expr: { property: 'words_collected' }, name: 'w' },
    { index: 3, ...parsed },
    { index: 4, stage: 'unnest', expr: col('arr'), name: 'v' },
    { index: 5, stage: 'where', conditions: [{ fn: 'eq', args: [col('event_name'), val('x')] }] },
  ]);
  // a kept funnel's step condition on a name that is both an event property and a column of the rows
  // is the column, as its build resolves it — so the step copied into edit_step reads that column
  const onLevel = { stage: 'match_recognize', partition_by: ['player_id_of_internal'], steps: [{ name: 'a', event_name: ['level_started'] }, { name: 'b', event_name: ['level_completed'], where: [{ property: 'level_id_of_event_data', op: 'eq', value: 1 }] }] };
  const levelCols = new Set([...COLS, 'level_id_of_event_data']);
  const [shown] = view._draftSteps({ source: 'events', stages: [onLevel] }, levelCols);
  const { index: _i, ...shownStep } = shown;
  assert.deepEqual(shownStep, renderPipeline(catalog, catalog.dialect, 'events', [onLevel], { physicalCols: levelCols }).current.get(onLevel));
  assert.deepEqual(shownStep.steps[1].where, [{ fn: 'eq', args: [col('level_id_of_event_data'), val(1)] }]);
  // a step that no longer builds is shown as stored, the steps before it as built
  const broken = view._draftSteps({ source: 'events', stages: [{ stage: 'limit', n: 5 }, { stage: 'where', conditions: [{ column: 'no_such_column', op: 'eq', value: 1 }] }] }, physSet);
  assert.deepEqual(broken.map(({ index: _n, ...s }) => s), [{ stage: 'limit', limit: 5 }, { stage: 'where', conditions: [{ column: 'no_such_column', op: 'eq', value: 1 }] }]);
  // a kept one that named a scalar property — which no array function takes — is refused by its build, saying what the property is
  assert.throws(() => renderPipeline(catalog, catalog.dialect, 'events', [{ stage: 'unnest', source: 'price_in_usd_of_event_data', name: 'w' }], { physicalCols: new Set([...COLS, 'price_in_usd_of_event_data']) }), /'price_in_usd_of_event_data' is declared as numeric, not an array/);
  // a funnel kept with a step condition on `property`, a `filter` and `metrics` builds the columns it built
  const keptFunnel = { stage: 'match_recognize', partition_by: ['player_id_of_internal'], steps: [{ name: 'a', event_name: ['first_launch'] }, { name: 'b', event_name: ['tutorial'], where: [{ property: 'session_number', op: 'gte', value: 1 }] }], filter: { event_name: ['first_launch', 'tutorial'] }, metrics: [{ name: 'gap', type: 'avg_seconds_between', from: 'a', to: 'b' }, { name: 'n', type: 'agg_at_step', step: 'b', property: 'session_number' }] };
  const out = columns([keptFunnel]);
  for (const c of ['reached_b:boolean', 'at_b:time', 'secs_gap:numeric', 'pv_n:numeric']) assert.ok(out.includes(c), `${c} in ${out.join(', ')}`);
});

test('a value picked from several is typed as its arguments are, and compared in that type', () => {
  // the earlier of two times is a time: a date constant compares with it
  assert.ok(render([
    { stage: 'compute', name: 'first_seen', expr: { fn: 'least', args: [col('device_time'), { now: true }] } },
    { stage: 'where', conditions: [{ fn: 'gte', args: [col('first_seen'), val('2026-01-01')] }] },
  ]).columns.get('first_seen').type !== 'numeric');
  // a date and a time are both moments: never typed a number
  assert.ok(render([
    { stage: 'compute', name: 'first', expr: { fn: 'least', args: [col('event_date'), col('device_time')] } },
    { stage: 'where', conditions: [{ fn: 'gte', args: [col('first'), val('2026-01-01')] }] },
  ]).columns.get('first').type !== 'numeric');
  // a number falling back to a number is a number: a word does not compare with it
  assert.throws(() => render([
    { stage: 'compute', name: 'n', expr: { fn: 'coalesce', args: [col('session_number'), val(0)] } },
    { stage: 'where', conditions: [{ fn: 'eq', args: [col('n'), val('many')] }] },
  ]), /'n' is a number: compare it with a number/);
  // a CASE is typed as its branches are, not as text
  assert.equal(render([{ stage: 'compute', name: 'k', expr: { fn: 'case', cases: [{ when: [{ fn: 'gt', args: [col('session_number'), val(1)] }], then: col('session_number') }], else: val(0) } }]).columns.get('k').type, 'numeric');
});

test('a whole-table window in a CASE gets the global-window nudge; a raw OVER () in a where is refused like a structured window', async () => {
  const e = new Engine({ catalog, contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'guards-')) }) });
  const caseWindow = { stage: 'compute', name: 'above', expr: { fn: 'case', cases: [{ when: [{ fn: 'gt', args: [col('session_number'), val(1)] }], then: { fn: 'average', args: [col('session_number')], over: {} } }], else: val(0), type: 'numeric' } };
  assert.match(e.advisor.globalWindowWarnings(caseWindow).join(' '), /Global analytic window: the window function 'average' has no partition_by/);
  // in a condition a window is not a cost but an error, partitioned or not
  for (const sql of ['count(*) over ()', 'count(*) OVER (PARTITION BY player_id_of_internal)']) {
    assert.throws(() => render([{ stage: 'where', conditions: [{ fn: 'gt', args: [{ fn: 'raw', sql }, val(1)] }] }]), /raw expression with OVER \(…\) is a window function, and a condition cannot test one/);
  }
  // the word in a string is no window
  assert.ok(render([{ stage: 'where', conditions: [{ fn: 'eq', args: [{ fn: 'raw', sql: "'game over (again)'" }, val('x')] }] }]));
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

test('a measure is typed by its aggregate: the earliest or latest of a column is of that column\'s type, a count an integer', () => {
  const out = render([
    { stage: 'aggregate', group_by: ['player_id_of_internal'], measures: [{ name: 'first_at', expr: { fn: 'min', args: [col('device_time')] } }, { name: 'most', expr: { fn: 'max', args: [col('session_number')] } }, { name: 'n', expr: { fn: 'count' } }, { name: 'per', expr: { fn: 'div', args: [{ fn: 'sum', args: [col('session_number')] }, { fn: 'count_distinct', args: [col('event_name')] }] } }] },
    { stage: 'where', conditions: [{ fn: 'gte', args: [col('first_at'), val('2026-01-01')] }] },
  ]);
  assert.deepEqual(['first_at', 'most', 'n', 'per'].map((c) => out.columns.get(c).type), [render([]).columns.get('device_time').type, 'numeric', 'int', 'numeric']);
});

test('a condition is a function: an earlier spelling is refused with the value written today; a field a function does not read is refused', async () => {
  const e = new Engine({ catalog, contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'guards-')) }) });
  const { context_id } = await e.build_pipeline_model({ action: 'start', name: 'cond', source: 'events' });
  const add = (c) => e.build_pipeline_model({ action: 'add_steps', context_id, steps: [{ stage: 'where', conditions: [c] }] });
  const shown = (today) => (err) => err.message.includes('is written in an earlier spelling') && err.message.includes(`write ${JSON.stringify(today)}`);
  for (const [earlier, today] of [
    [{ column: 'session_number', op: 'gt', value: 1 }, { fn: 'gt', args: [col('session_number'), val(1)] }],
    [{ column: 'session_number', op: 'is_null' }, { fn: 'is_null', args: [col('session_number')] }],
    [{ left: { fn: 'length', args: [col('event_name')] }, op: 'gt', right: col('session_number') }, { fn: 'gt', args: [{ fn: 'length', args: [col('event_name')] }, col('session_number')] }],
    [{ or: [{ column: 'session_number', op: 'gt', value: 1 }, { column: 'event_name', op: 'eq', value: 'x' }] }, { fn: 'or', args: [{ fn: 'gt', args: [col('session_number'), val(1)] }, { fn: 'eq', args: [col('event_name'), val('x')] }] }],
    [{ fn: 'in', args: [col('event_name'), { value: ['a', 'b'] }] }, { fn: 'in', args: [col('event_name'), val('a'), val('b')] }],
  ]) await assert.rejects(() => add(earlier), shown(today), JSON.stringify(earlier));
  // a field the function does not read, an argument too few: refused, not ignored
  await assert.rejects(() => add({ fn: 'gt', args: [col('session_number'), val(1)], value: 2 }), /unexpected property 'value'/);
  await assert.rejects(() => add({ fn: 'gt', args: [col('session_number')] }), /must have at least 2 items/);
  // each shape is taken: a column against a constant or an expression, an expression on the left, a test of a missing value, logic
  for (const c of [
    { fn: 'gt', args: [col('session_number'), val(1)] },
    { fn: 'is_null', args: [col('session_number')] },
    { fn: 'gte', args: [col('session_number'), col('session_number')] },
    { fn: 'gt', args: [{ fn: 'length', args: [col('event_name')] }, val(3)] },
    { fn: 'not', args: [{ fn: 'and', args: [{ fn: 'in', args: [col('event_name'), val('a'), val('b')] }, { fn: 'between', args: [col('session_number'), val(1), val(3)] }] }] },
  ]) assert.ok(await add(c), JSON.stringify(c));
});

// A READ NAMES NO TYPE, AN AGGREGATE NO WHERE: a new call written the earlier way is refused with the value
// written today — a typed read as the read cast to its type (the type dropped where the read yields it:
// text out of a JSON document; an element is of its array's items, so its cast stays), an aggregate's where
// as the case it folds, an unnest naming its element's type as the unnest and a compute stage casting the
// element (in a list of steps, where the two fit; a lone step has no one value it is now: the two steps it
// is are said, to put where it stood — the one thing said of it, never a value that still names a type —
// its element named `name` or, before that, `as`).
test('a typed read, an aggregate\'s where and a typed unnest are refused with the value written today', async () => {
  const e = new Engine({ catalog, contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'guards-')) }) });
  const { context_id } = await e.build_pipeline_model({ action: 'start', name: 'typed', source: 'events' });
  const add = (...steps) => e.build_pipeline_model({ action: 'add_steps', context_id, steps });
  const shown = (today) => (err) => err.message.includes('is written in an earlier spelling') && err.message.includes(`write ${JSON.stringify(today)}`);
  const isTut = { fn: 'eq', args: [col('event_name'), val('tutorial')] };
  for (const [earlier, today] of [
    [{ stage: 'compute', name: 'p', expr: { property: 'price_in_usd_of_event_data', type: 'int' } }, { fn: 'cast', args: [{ property: 'price_in_usd_of_event_data' }], type: 'int' }],
    [{ stage: 'compute', name: 'p', expr: { fn: 'json_field', args: [col('event_name')], field: 'a', type: 'numeric' } }, { fn: 'cast', args: [{ fn: 'json_field', args: [col('event_name')], field: 'a' }], type: 'numeric' }],
    [{ stage: 'compute', name: 'p', expr: { fn: 'json_field', args: [col('event_name')], field: 'a', type: 'string' } }, { fn: 'json_field', args: [col('event_name')], field: 'a' }],
    [{ stage: 'aggregate', measures: [{ name: 'n', expr: { fn: 'count', where: [isTut] } }] }, { fn: 'count', args: [{ fn: 'case', cases: [{ when: [isTut], then: val(1) }] }] }],
    [{ stage: 'aggregate', measures: [{ name: 's', expr: { fn: 'average', args: [col('session_number')], where: [isTut] } }] }, { fn: 'average', args: [{ fn: 'case', cases: [{ when: [isTut], then: col('session_number') }] }] }],
  ]) await assert.rejects(() => add(earlier), shown(today), JSON.stringify(earlier));
  const unnest = { stage: 'unnest', expr: { property: 'words_collected' }, name: 'w' };
  await assert.rejects(() => add({ ...unnest, type: 'int' }, { stage: 'limit', limit: 5 }), shown([{ ...unnest, name: 'w_element' }, { stage: 'compute', name: 'w', expr: { fn: 'cast', args: [col('w_element')], type: 'int' } }, { stage: 'limit', limit: 5 }]));
  await assert.rejects(() => add({ ...unnest, type: 'string' }), shown(unnest));
  // alone, it is said as the two steps it is, to put where it stood — and nothing else of it: no field
  // refused one by one, no value still naming its type (its array named the earlier way alike)
  const two = `${JSON.stringify({ ...unnest, name: 'w_element' })} in its place, then ${JSON.stringify({ stage: 'compute', name: 'w', expr: { fn: 'cast', args: [col('w_element')], type: 'int' } })} after it`;
  for (const step of [
    { ...unnest, type: 'int' }, { stage: 'unnest', property: 'words_collected', name: 'w', type: 'int' },
    { stage: 'unnest', expr: { property: 'words_collected' }, as: 'w', type: 'int' }, { stage: 'unnest', property: 'words_collected', as: 'w', type: 'int' },
  ]) {
    await assert.rejects(() => e.build_pipeline_model({ action: 'insert_step', context_id, index: 1, step }), (err) => err.message.startsWith('invalid input: `step`: an unnest takes no type')
      && err.message.endsWith(two) && !/unexpected property|earlier spelling/.test(err.message) && !err.message.includes('"name":"w","type":"int"'), JSON.stringify(step));
  }
  // a long name: its element's name is cut to a name a step may make
  await assert.rejects(() => add({ ...unnest, name: 'w'.repeat(41), type: 'int' }), shown([{ ...unnest, name: `${'w'.repeat(33)}_element` }, { stage: 'compute', name: 'w'.repeat(41), expr: { fn: 'cast', args: [col(`${'w'.repeat(33)}_element`)], type: 'int' } }]));
  // what is written today is taken
  assert.equal((await add({ stage: 'compute', name: 'p', expr: { fn: 'cast', args: [{ property: 'price_in_usd_of_event_data' }], type: 'int' } }, unnest, { stage: 'aggregate', group_by: ['w'], measures: [{ name: 'n', expr: { fn: 'count', args: [{ fn: 'case', cases: [{ when: [isTut], then: val(1) }] }] } }] })).steps_count, 3);
});

test('a pivot names a column per value, never twice or as a group key; its measure is an aggregate expression; unpivot keeps or folds a column, not both', () => {
  const pivot = (extra) => render([{ stage: 'pivot', on: 'event_name', measure: { fn: 'count' }, ...extra }]);
  assert.throws(() => pivot({ values: [{ value: 'tutorial', name: 'n' }, { value: 'first_launch', name: 'n' }] }), /pivot: 'n' names two values/);
  assert.throws(() => pivot({ group_by: ['session_number'], values: [{ value: 'tutorial', name: 'session_number' }] }), /pivot: 'session_number' names a group_by column/);
  assert.throws(() => pivot({ values: [{ value: 'tutorial', name: 'a' }, { value: 'tutorial', name: 'b' }] }), /the value "tutorial" is listed twice/);
  assert.throws(() => render([{ stage: 'pivot', on: 'event_name', measure: { fn: 'sum', args: [col('nope')] }, values: [{ value: 'tutorial', name: 't' }] }]), /unknown column 'nope'/);
  // a cell is the measure over the rows of its value: a column outside an aggregate is none
  assert.throws(() => render([{ stage: 'pivot', on: 'event_name', measure: col('session_number'), values: [{ value: 'tutorial', name: 't' }] }]), /'session_number' stands outside an aggregate/);
  // …and a formula over aggregates is one
  assert.equal(render([{ stage: 'pivot', on: 'event_name', measure: { fn: 'div', args: [{ fn: 'sum', args: [col('session_number')] }, { fn: 'count' }] }, values: [{ value: 'tutorial', name: 't' }] }]).columns.get('t').type, 'numeric');
  // a number compared with a numeric column, a word refused there — the value is typed as `on` is
  assert.ok(render([{ stage: 'pivot', on: 'session_number', measure: { fn: 'count' }, values: [{ value: 1, name: 's1' }, { value: null, name: 'none' }] }]));
  assert.throws(() => render([{ stage: 'pivot', on: 'session_number', measure: { fn: 'count' }, values: [{ value: 'many', name: 's' }] }]), /'session_number' is a number: compare it with a number/);
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
    { stage: 'compute', name: 'roll', expr: { fn: 'sum', args: [col('session_number')], over: { partition_by: ['player_id_of_internal'], order_by: [key], frame: { mode: 'range', preceding: 'unbounded', following: 1 } } } },
  ], { physicalCols: COLS });
  assert.throws(() => running({ key: 'session_number' }), /say nulls: 'first' on that key \(desc: 'last'\)/);
  assert.throws(() => running({ key: 'session_number', direction: 'desc', nulls: 'first' }), /say nulls: 'first' on that key \(desc: 'last'\)/);
  for (const key of [{ key: 'session_number', nulls: 'first' }, { key: 'session_number', direction: 'desc', nulls: 'last' }]) assert.ok(running(key).columns.has('roll'), JSON.stringify(key));
});
