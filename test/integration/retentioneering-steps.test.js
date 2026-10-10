// THE RETENTIONEERING FEATURE, END TO END on DuckDB — an eventstream's steps and the specs a start
// takes: forks of the users' paths (`paths`) shaped by the library's own ops, each checked by the library
// as it is added and materialized as one dbt Python model on the feature's own dbt environment
// (`retentioneering`: dbt 1.x + the library); and starts whose events, paths, window and sample the SQL
// decides. Every number is checked against what the rows say — counted here, independently, from the
// warehouse. The analyses are retentioneering.test.js; both stand on retentioneering-harness.js and run
// side by side.
//
// A check that names an earlier test (T13, T22, …) in its message is that test's, merged into a scenario
// that shares its builds and runs. What one materialize or query costs is a python model (a dbt process
// and the library's import) and the summary's dbt reads, and a start its SQL model and those reads — so a
// scenario runs its steps through as few of them as its checks allow, and a start carries several of the
// specs a start takes when their checks do not read each other's numbers.
//
// Skipped when the environment is not built (npm run dbt:env -- create retentioneering).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ENV, opts, skip, collapsed, table, sizes, openWorld } from './retentioneering-harness.js';

let w; let engine; let wh; let built;
const readDone = (id, extra) => w.readDone(id, extra);
const paths = () => w.paths();
const analyze = (...args) => w.analyze(...args);
const stepsContext = () => w.stepsContext();
const shaped = (name, steps) => w.shaped(name, steps);

before(async () => {
  if (!ENV) return;
  w = await openWorld();
  ({ engine, wh, built } = w);
}, opts);
after(async () => { await w?.close(); });

// ── an eventstream's steps: forks of `paths`, each a draft the library checks as each step is added ──

// D + F — the segments steps make (bins of a metric by value and by quantile, levels by rules) and then
// the paths collapsed: ONE materialize. A fork of it reads its table before a step of its own: ONE query
// of the collapsed transitions, every path described, an overview of each segment. Then the fork moves on
// by two path filters, a length and a time condition: ONE materialize — its parent left as it was, and the
// query's card still about the rows it read.
test('segments a step makes and collapsed paths: each level holds its paths, no self-transition; a fork moved on by a length and a time condition (seconds since the epoch) keeps its paths and leaves its parent; a card speaks of the rows it read', opts, async (t) => {
  if (skip(t)) return;
  const lengths = [...paths().values()].map((list) => list.length);
  // pandas' linear quantile, which the library cuts at
  const sorted = [...lengths].sort((a, b) => a - b);
  const quantile = (q) => { const p = (sorted.length - 1) * q; const lo = Math.floor(p); return sorted[lo] + (sorted[Math.ceil(p)] - sorted[lo]) * (p - lo); };
  const median = quantile(0.5);
  // rules: the first platform (and a constant with a quote, which the tool writes as one) is one level, the rest the else level
  const [first, ...others] = w.perPlatform;
  const want = Object.fromEntries(Object.entries({ first_store: first.n, other_store: others.reduce((n, r) => n + r.n, 0) }).filter(([, n]) => n));
  // the segments are made on the paths as they are, before the collapse: a segment is its path's own, so
  // each path keeps its level when its loops collapse after
  const { ctx, read: read1 } = await shaped('collapsed', [
    // the bins in any order after the lowest: each keeps its own level
    { type: 'add_segment', name: 'length_band', metric_bins: { metric: { metric: 'length' }, bins: [{ level: 'short' }, { level: 'long', from: 10 }, { level: 'mid', from: 5 }] } },
    { type: 'add_segment', name: 'half', metric_bins: { metric: { metric: 'length' }, bins: [{ level: 'lower' }, { level: 'upper', from_quantile: 0.5 }] } },
    { type: 'add_segment', name: 'store', rules: { cases: [{ column: 'platform', op: 'in', value: [first.platform, "it's not a level"], level: 'first_store' }], else: 'other_store' } },
    { type: 'collapse_events', loops: true },
  ]);
  // T20 — the materialized eventstream knows the levels the step made, with their users
  assert.deepEqual(Object.fromEntries(read1.segment_levels.store.levels.map((l) => [l.level, l.users])), want, 'T20: the rules\' levels in the build\'s summary');
  // T19 — two bins of one name, or two starting at one point, are refused in the call
  const bins = (list) => engine.build_retentioneering_model({ action: 'add_steps', context_id: ctx, eventstream: 'collapsed', steps: [{ type: 'add_segment', name: 'x', metric_bins: { metric: { metric: 'length' }, bins: list } }] });
  await assert.rejects(bins([{ level: 'a' }, { level: 'a', from: 3 }]), (e) => e.field === 'steps[0].metric_bins' && /two bins are named 'a'/.test(e.message), 'T19: two bins of one name');
  await assert.rejects(bins([{ level: 'a' }, { level: 'b', from: 3 }, { level: 'c', from: 3 }]), (e) => e.field === 'steps[0].metric_bins' && /two bins start/.test(e.message), 'T19: two bins of one start');

  // T13 — a fork of the collapsed paths, before a step of its own, reads their table: the pairs of the
  // paths once every run of one event is one event, every path described, each segment level by level
  await engine.build_retentioneering_model({ action: 'fork', context_id: ctx, eventstream: 'collapsed', name: 'long_paths' });
  const overview = (name, segment) => ({ kind: 'segment_overview', name, segment_col: segment, metrics: [{ metric: 'length', agg: 'mean' }] });
  const q = await engine.query_retentioneering_model({
    context_id: ctx, eventstream: 'long_paths',
    analyses: [{ kind: 'transition_graph' }, { kind: 'describe' }, overview('by_value', 'length_band'), overview('by_quantile', 'half'), overview('by_store', 'store')],
  });
  const a = await readDone(q.task_id, { detail: 'full' });
  assert.equal(a.status, 'done', JSON.stringify(a.error));
  const expected = new Map();
  for (const list of paths().values()) {
    const seq = ['path_start', ...collapsed(list), 'path_end'];
    for (let i = 0; i + 1 < seq.length; i += 1) expected.set(`${seq[i]}>${seq[i + 1]}`, (expected.get(`${seq[i]}>${seq[i + 1]}`) || 0) + 1);
  }
  assert.deepEqual(new Map(a.analyses.transition_graph.edges.map((e) => [`${e.source}>${e.target}`, e.count])), expected, 'T13: collapsed loops — the transitions of the collapsed paths');
  assert.ok(!a.analyses.transition_graph.edges.some((e) => e.source === e.target), 'T13: no self-loops');
  assert.equal(a.analyses.describe.values['shape'].n_paths, built.users, 'T13: collapsing loops keeps every path');
  const count = (f) => lengths.filter(f).length;
  assert.deepEqual(sizes(a.analyses.by_value, 'by_value'), Object.fromEntries(Object.entries({ short: count((n) => n < 5), mid: count((n) => n >= 5 && n < 10), long: count((n) => n >= 10) }).filter(([, n]) => n)), 'T19 by value: each bin holds the paths whose length falls in it');
  assert.deepEqual(sizes(a.analyses.by_quantile, 'by_quantile'), Object.fromEntries(Object.entries({ lower: count((n) => n < median), upper: count((n) => n >= median) }).filter(([, n]) => n)), 'T19 by quantile: each bin holds the paths whose length falls in it');
  assert.deepEqual(sizes(a.analyses.by_store, 'by_store'), want, 'T20: each path gets the level of the first case its row matches, the rest the else level');

  // T13 + T30 — the fork moves on: the collapsed paths longer than 8, and (T30) those that started before a
  // moment in seconds since the epoch, the median of the players' first events. Each condition leaves out
  // a path the other keeps, so each shows in the count.
  const firstOf = new Map((await wh.query('select player_id_of_internal as u, epoch(min(device_time)) as s from fct_analytics_events group by 1')).rows.map((r) => [String(r.u), Number(r.s)]));
  const firsts = [...firstOf.values()].sort((x, y) => x - y);
  const moment = firsts[Math.floor(firsts.length / 2)];
  // guard: collapsing loops cannot move a path's first event when no path begins with two events of one name
  assert.ok([...paths().values()].every((list) => list.length < 2 || list[0].e !== list[1].e), 'guard: no path begins with two events of one name');
  const kept = [...paths()].map(([u, list]) => ({ long: collapsed(list).length > 8, early: firstOf.get(String(u)) < moment }));
  assert.ok(kept.some((p) => p.early && !p.long), 'guard: the length condition leaves out a path the time condition keeps');
  assert.ok(kept.some((p) => p.long && !p.early), 'guard: the time condition leaves out a path the length condition keeps');
  await engine.build_retentioneering_model({ action: 'add_steps', context_id: ctx, eventstream: 'long_paths', steps: [
    { type: 'filter_paths', condition: { op: '>', metric: 'length', value: 8 } },
    { type: 'filter_paths', condition: { op: '<', metric: 'first_event_time', value: moment } },
  ] });
  const moved = await readDone((await engine.build_retentioneering_model({ action: 'materialize', context_id: ctx, eventstream: 'long_paths' })).task_id);
  assert.equal(moved.status, 'done', `T13 + T30 long_paths, moved on: ${JSON.stringify(moved.error)}`);
  assert.equal(moved.users, kept.filter((p) => p.long && p.early).length, 'T13 + T30: the materialized fork holds the paths both filters kept — the collapsed length, and a time metric compared in seconds since the epoch');
  assert.ok(moved.users < read1.users, 'T25: the eventstream moved on — fewer paths');
  // T25 — a card speaks of the rows its analysis read, whatever the eventstream became after
  const d = await engine.display_retentioneering_result({ task_id: q.task_id, analysis: 'transition_graph' });
  assert.deepEqual([d.scope.users, d.scope.events], [read1.users, read1.events], 'T25: the card\'s scope is the rows its analysis read');
  // T13 — the fork left its parent as it was: its own steps, materialized, and every path in its table
  const parent = await engine.build_retentioneering_model({ action: 'preview', context_id: ctx, eventstream: 'collapsed' });
  assert.deepEqual([parent.steps.length, parent.materialized_through], [4, 4], 'T13: the parent keeps its own steps, materialized');
  assert.equal(Number((await wh.query(`select count(distinct user_id) as n from ${parent.table}`)).rows[0].n), built.users, 'T13: the fork left its parent as it was — every path in its table');
});

test('each step is checked by the library as it is added, and says what it changed — a refused one changes nothing', opts, async (t) => {
  if (skip(t)) return;
  const ctx = await stepsContext();
  await engine.build_retentioneering_model({ action: 'fork', context_id: ctx, eventstream: 'paths', name: 'loop', after: 0 });
  const add = (step) => engine.build_retentioneering_model({ action: 'add_steps', context_id: ctx, eventstream: 'loop', steps: [step] });
  const started = Date.now();
  const s1 = await add({ type: 'rename_events', mapping: { shop_opened: 'shop' } });
  assert.deepEqual([s1.added[0].checked, s1.added[0].changed.events_added, s1.added[0].changed.events_removed], [true, ['shop'], ['shop_opened']]);
  const s2 = await add({ type: 'split_sessions', timeout: '30m', session_col: 'visit' });
  assert.deepEqual(s2.added[0].changed.paths_added, ['visit']);
  const s3 = await add({ type: 'add_segment', name: 'band', metric_bins: { metric: { metric: 'length' }, bins: [{ level: 'short' }, { level: 'long', from: 5 }] } });
  assert.deepEqual(s3.added[0].changed.segments_added, ['band']);
  assert.deepEqual(s3.shape.segments.band.levels.sort(), ['long', 'short']);
  // refused by the library, with its own message, on what the eventstream holds at that step
  const refusedStep = (step, re) => assert.rejects(add(step), (e) => e.field === 'steps[0]' && re.test(e.message) && /nothing changed/.test(e.message));
  await refusedStep({ type: 'rename_events', mapping: { shop_opened: 'store' } }, /shop_opened/); // renamed at step 1
  await refusedStep({ type: 'filter_events', keep: { platform: ['no_such_platform'] } }, /no_such_platform/);
  await refusedStep({ type: 'collapse_events', loops: true, name: 'x->y' }, /->/);
  await refusedStep({ type: 'add_segment', name: 'band', rules: { cases: [{ column: 'platform', op: '=', value: 'ios', level: 'apple' }], else: 'other' } }, /band/); // exists
  assert.ok(Date.now() - started < 60000, 'every answer came from the library\'s own check, without a run');
  const p = await engine.build_retentioneering_model({ action: 'preview', context_id: ctx, eventstream: 'loop' });
  assert.deepEqual(p.steps.map((x) => [x.index, x.step.type, x.checked]), [[1, 'rename_events', true], [2, 'split_sessions', true], [3, 'add_segment', true]]);
  // an edit is checked with every step after it: renaming another event leaves step 2 and 3 as they are
  const e1 = await engine.build_retentioneering_model({ action: 'edit_step', context_id: ctx, eventstream: 'loop', index: 1, step: { type: 'rename_events', mapping: { level_started: 'start' } } });
  assert.equal(e1.steps, 3);
  // an inserted step is checked on what the step before it left, and moves the rest along
  const i1 = await engine.build_retentioneering_model({ action: 'insert_step', context_id: ctx, eventstream: 'loop', index: 2, step: { type: 'drop_events', names: ['tutorial'] } });
  assert.deepEqual([i1.steps, i1.step.index, i1.changed.events_removed], [4, 2, ['tutorial']]);
  await assert.rejects(engine.build_retentioneering_model({ action: 'insert_step', context_id: ctx, eventstream: 'loop', index: 2, step: { type: 'drop_events', names: ['level_started'] } }), (e) => /level_started/.test(e.message) && /nothing changed/.test(e.message)); // renamed by step 1
  assert.equal((await engine.build_retentioneering_model({ action: 'delete_step', context_id: ctx, eventstream: 'loop', index: 2 })).steps, 3);
  // ...while deleting the step that makes the session column breaks a later step that reads it
  await engine.build_retentioneering_model({ action: 'add_steps', context_id: ctx, eventstream: 'loop', steps: [{ type: 'filter_paths', condition: { op: '>', metric: 'length', value: 1 }, path: 'visit' }] });
  await assert.rejects(engine.build_retentioneering_model({ action: 'delete_step', context_id: ctx, eventstream: 'loop', index: 2 }), (e) => /step 3 \(filter_paths\)|step 4|visit/.test(e.message) && /nothing changed/.test(e.message));
  // the analyses read what is materialized: steps not yet materialized are said, not skipped
  await assert.rejects(engine.query_retentioneering_model({ context_id: ctx, eventstream: 'loop', analyses: [{ kind: 'describe' }] }), (e) => e.field === 'eventstream' && /materialize/.test(e.message));
  const m = await engine.build_retentioneering_model({ action: 'materialize', context_id: ctx, eventstream: 'loop' });
  const read = await readDone(m.task_id);
  assert.equal(read.status, 'done', JSON.stringify(read.error));
  assert.equal(read.steps_materialized, 4);
  assert.ok(read.vocabulary.some((v) => v.event === 'start') && !read.vocabulary.some((v) => v.event === 'level_started'), 'the table holds the renamed events');
  // the path columns, as the library's schema lists them: the user, the start's sessions, the visit a step made
  assert.deepEqual(read.paths, ['user_id', 'session_id', 'visit']);
  // the numbers: a path per visit, as many as the table holds
  const visits = Number((await wh.query(`select count(distinct visit) as n from ${read.model}`)).rows[0].n);
  const d = await analyze(ctx, 'loop', [{ kind: 'path_metrics', metrics: [{ metric: 'length' }], path: 'visit' }], 'full');
  assert.equal(table(d.path_metrics, 'result').length, visits);
  // an edit at or before the materialized steps retires their table: the next materialize rebuilds
  const t1 = await engine.build_retentioneering_model({ action: 'truncate', context_id: ctx, eventstream: 'loop', after: 2 });
  assert.ok(t1.checkpoint_dropped);
  assert.equal(t1.materialized_through, 0);
});

// H — one draft, three steps asked for at once, then materialized while one of them is edited.
test('steps asked for at once are all applied, and a materialize racing an edit never leaves the old steps\' table standing', opts, async (t) => {
  if (skip(t)) return;
  const ctx = await stepsContext();
  await engine.build_retentioneering_model({ action: 'fork', context_id: ctx, eventstream: 'paths', name: 'racing', after: 0 });
  // T22 — steps asked for at once are applied one after the other: none is lost
  const steps = [{ type: 'rename_events', mapping: { shop_opened: 'shop' } }, { type: 'drop_events', names: ['tutorial'] }, { type: 'collapse_events', loops: true }];
  const answers = await Promise.all(steps.map((step) => engine.build_retentioneering_model({ action: 'add_steps', context_id: ctx, eventstream: 'racing', steps: [step] })));
  assert.deepEqual(answers.map((a) => a.steps).sort(), [1, 2, 3], 'T22: each answer is one step further');
  const p = await engine.build_retentioneering_model({ action: 'preview', context_id: ctx, eventstream: 'racing' });
  assert.deepEqual(p.steps.map((x) => x.step.type).sort(), steps.map((x) => x.type).sort(), 'T22: none is lost');
  assert.ok(p.steps.every((x) => x.checked), 'T22: each is checked');
  // T26 — the edit is made while the materialize runs; whichever ends first, the other sees it. (The rename
  // has left no shop_opened to drop: the edit drops level_completed.)
  const drop = p.steps.find((x) => x.step.type === 'drop_events').index;
  const m = await engine.build_retentioneering_model({ action: 'materialize', context_id: ctx, eventstream: 'racing' });
  await engine.build_retentioneering_model({ action: 'edit_step', context_id: ctx, eventstream: 'racing', index: drop, step: { type: 'drop_events', names: ['level_completed'] } });
  // T22 — the materialize built from the steps it was started with: the numbers are those of all three
  const read = await readDone(m.task_id);
  assert.equal(read.status, 'done', `T22 racing: ${JSON.stringify(read.error)}`);
  const names = read.vocabulary.map((v) => v.event);
  assert.ok(names.includes('shop') && !names.includes('shop_opened') && !names.includes('tutorial'), 'T22: the numbers are those of all three steps');
  const edited = await engine.build_retentioneering_model({ action: 'preview', context_id: ctx, eventstream: 'racing' });
  assert.equal(edited.materialized_through, 0, 'T26: the table of the old steps does not stand for the edited ones');
  await assert.rejects(engine.query_retentioneering_model({ context_id: ctx, eventstream: 'racing', analyses: [{ kind: 'describe' }] }), (e) => e.field === 'eventstream' && /materialize/.test(e.message), 'T26: the analyses wait for the edited steps to be materialized');
  // materialized again, the table holds the edited steps' events
  const again = await readDone((await engine.build_retentioneering_model({ action: 'materialize', context_id: ctx, eventstream: 'racing' })).task_id);
  assert.equal(again.status, 'done', `T26 racing again: ${JSON.stringify(again.error)}`);
  const now = again.vocabulary.map((v) => v.event);
  assert.ok(now.includes('tutorial') && !now.includes('level_completed'), 'T26: materialized again, the table holds the edited steps\' events');
});

// ── what a start takes: its events, its path, its window, its sample — decided in SQL ────────────────
// A start below carries two of these specs where the checks of each read numbers the other leaves as they
// are: a split of events with a path or with a window, a where with a top N. A sample by a hash is two
// starts of one spec.

/** How many distinct values `f` gives over `list` — a missing part of a key makes no path. */
const distinct = (list, f) => new Set(list.filter((x) => f(x) != null && !String(f(x)).includes('null')).map(f)).size;
const counts = (list) => list.reduce((m, x) => m.set(x, (m.get(x) || 0) + 1), new Map());

// A PATH that is not the user, by an event property (a key of one part takes the property's branch), and
// events made from an event's parameters by a value: one start.
test('a path by an event property, its events split by a value (with names of its own): one path per level, events without it left out, every event counted from the rows', opts, async (t) => {
  if (skip(t)) return;
  const src = (await wh.query('select event_name as e, result_of_event_data as r, level_id_of_event_data as l from fct_analytics_events')).rows;
  // by value: win → level_won (its own name), any other value → level_completed_<value>
  const b = await engine.build_retentioneering_model({
    name: 'by_level', source: 'events', path: [{ property: 'level_id_of_event_data' }],
    events: { split: [{ event: 'level_completed', by: { property: 'result_of_event_data' }, names: { win: 'level_won' } }] },
  });
  const r = await readDone(b.task_id);
  assert.equal(r.status, 'done', JSON.stringify(r.error));
  const withLevel = src.filter((x) => x.l != null);
  assert.equal(r.users, distinct(src, (x) => x.l), 'a path per level');
  assert.deepEqual(r.path, ['level_id_of_event_data'], 'the summary says what one path is: the property');
  assert.equal(r.events, withLevel.length, 'events without the key are left out — and no event of a level lost to the split');
  // guard: the levels' events hold the value given a name and another
  const results = new Set(withLevel.filter((x) => x.e === 'level_completed').map((x) => x.r));
  assert.ok(results.has('win') && [...results].some((v) => v != null && v !== 'win'), 'guard: the levels\' events hold a named value and another');
  const expected = counts(withLevel.map((x) => (x.e !== 'level_completed' || x.r == null ? x.e : x.r === 'win' ? 'level_won' : `level_completed_${x.r}`)));
  assert.deepEqual(new Map(r.vocabulary.map((v) => [v.event, v.events])), expected, 'split by value: the named value under its name, any other as <event>_<value>, every other event as it was');
  // an unknown parameter is refused before anything runs
  await assert.rejects(engine.build_retentioneering_model({ name: 'x', source: 'events', events: { split: [{ event: 'level_completed', by: { property: 'no_such' } }] } }), /invalid input|no_such/, 'an unknown parameter');
});

// A window in a timezone, and events made from an event's parameters by conditions: one start.
test('a time window scopes the eventstream on the partitioned source (in a timezone, across the UTC day), its events split by conditions; a source that requires a window refuses a build without it', opts, async (t) => {
  if (skip(t)) return;
  // 2026-01-02 in UTC+14 = [01-01 10:00, 01-02 10:00) UTC — partly on the previous UTC day
  const window = "device_time >= timestamp '2026-01-01 10:00:00' and device_time < timestamp '2026-01-02 10:00:00'";
  const inWindow = Number((await wh.query(`select count(*) as n from fct_analytics_events where ${window}`)).rows[0].n);
  const results = (await wh.query(`select result_of_event_data as r from fct_analytics_events where event_name = 'level_completed' and ${window}`)).rows.map((x) => x.r);
  // by conditions: the first case that holds; the rest take `else` — the names the table holds, and so
  // what an analysis of it reads
  const b = await engine.build_retentioneering_model({
    name: 'windowed', source: 'events', time_range: { start: '2026-01-02', end: '2026-01-02', timezone: 'Pacific/Kiritimati' },
    events: { split: [{ event: 'level_completed', cases: [{ name: 'level_lost', when: [{ property: 'result_of_event_data', op: 'eq', value: 'lose' }] }], else: 'level_passed' }] },
  });
  const r = await readDone(b.task_id);
  assert.equal(r.status, 'done', JSON.stringify(r.error));
  assert.equal(r.events, inWindow, 'the window: the events in it, none lost to the split');
  assert.equal(inWindow, 39, 'guard: the window the fixture is known to hold');
  const lost = results.filter((x) => x === 'lose').length;
  assert.ok(lost > 0 && lost < results.length, 'guard: the window holds a lost level and another');
  const vocab = new Map(r.vocabulary.map((v) => [v.event, v.events]));
  assert.deepEqual([vocab.get('level_lost'), vocab.get('level_passed'), vocab.get('level_completed')], [lost, results.length - lost, undefined], 'split by conditions: the first case that holds names the row, the rest take else');
  const saved = engine.catalog._requireTimeRangeAll;
  engine.catalog._requireTimeRangeAll = true;
  try {
    await assert.rejects(engine.build_retentioneering_model({ name: 'x', source: 'events' }), (e) => e.field === 'time_range', 'a source that requires a window refuses a build without it');
  } finally { engine.catalog._requireTimeRangeAll = saved; }
});

// A PATH by a composite key of columns (a column as a key part takes the composite key's branch), and a
// group merging events the split made with events of the source: one start. Its paths, forked twice, each
// fork with one sample step the caller left unseeded.
test('a path by a composite key of columns, its events split and merged into a group with events of the source; a sample of those paths the caller left unseeded is drawn with a fixed seed — the same paths on every materialize', opts, async (t) => {
  if (skip(t)) return;
  const src = (await wh.query('select player_id_of_internal as u, session_number as s, event_name as e, result_of_event_data as r from fct_analytics_events')).rows;
  const b = await engine.build_retentioneering_model({
    name: 'by_player_session', source: 'events', path: [{ column: 'player_id_of_internal' }, { column: 'session_number' }],
    events: {
      split: [{ event: 'level_completed', by: { property: 'result_of_event_data' }, names: { win: 'level_won' } }],
      groups: { level_end: ['level_won', 'level_completed_lose', 'shop_opened'] },
    },
  });
  const composite = await readDone(b.task_id);
  assert.equal(composite.status, 'done', JSON.stringify(composite.error));
  assert.equal(composite.users, distinct(src, (x) => (x.u == null || x.s == null ? null : `${x.u}|${x.s}`)), 'a path per value of the composite key');
  assert.deepEqual(composite.path, ['player_id_of_internal', 'session_number'], 'the summary says what one path is: the key\'s parts');
  // the group: a name the split gives, an <event>_<value> and an event of the source, under the group's name
  const vocab = new Map(composite.vocabulary.map((v) => [v.event, v.events]));
  const n = (f) => src.filter(f).length;
  assert.equal(vocab.get('level_end'), n((x) => (x.e === 'level_completed' && ['win', 'lose'].includes(x.r)) || x.e === 'shop_opened'), 'a group merges a name the split gives, an <event>_<value> and an event of the source');
  assert.deepEqual([vocab.get('level_won'), vocab.get('level_completed_lose'), vocab.get('shop_opened')], [undefined, undefined, undefined], 'the group\'s events are under its name only');
  // a name neither the source nor the split has is still refused, and a path column the source does not have
  await assert.rejects(engine.build_retentioneering_model({ name: 'x', source: 'events', events: { split: [{ event: 'level_completed', cases: [{ name: 'level_lost', when: [{ property: 'result_of_event_data', op: 'eq', value: 'lose' }] }] }], groups: { g: ['level_lostt'] } } }), (e) => e.field === 'events.groups.g', 'a group name neither the source nor the split has');
  await assert.rejects(engine.build_retentioneering_model({ name: 'x', source: 'events', path: [{ column: 'no_such' }] }), (e) => e.field === 'path', 'a path column the source does not have');

  // a sample the caller left unseeded is drawn with a fixed seed: the same paths on every materialize
  const ctx = composite.context_id;
  const sampled = [];
  for (const name of ['half_a', 'half_b']) {
    await engine.build_retentioneering_model({ action: 'fork', context_id: ctx, eventstream: 'by_player_session', name, after: 0 });
    await engine.build_retentioneering_model({ action: 'add_steps', context_id: ctx, eventstream: name, steps: [{ type: 'sample_paths', frac: 0.5 }] });
    const read = await readDone((await engine.build_retentioneering_model({ action: 'materialize', context_id: ctx, eventstream: name })).task_id);
    assert.equal(read.status, 'done', `${name}: ${JSON.stringify(read.error)}`);
    sampled.push((await wh.query(`select distinct user_id from ${read.model} order by 1`)).rows.map((r) => r.user_id));
  }
  assert.ok(sampled[0].length > 0 && sampled[0].length < composite.users, 'a real sample');
  assert.deepEqual(sampled[0], sampled[1], 'the same paths on every materialize');
});

// A where on the source's own column, and a top N of the events it keeps: one start.
test('a where between two values (both ends included), and a top N: the most frequent events of those rows keep their names, the rest is "other" — no event dropped', opts, async (t) => {
  if (skip(t)) return;
  const src = (await wh.query('select session_number as s, event_name as e from fct_analytics_events')).rows;
  const b = await engine.build_retentioneering_model({ name: 'sessions_1_2', source: 'events', where: [{ column: 'session_number', op: 'between', value: [1, 2] }], events: { top: 3 } });
  const r = await readDone(b.task_id);
  assert.equal(r.status, 'done', JSON.stringify(r.error));
  const inSessions = src.filter((x) => x.s >= 1 && x.s <= 2);
  assert.equal(r.events, inSessions.length, 'between: both ends included — and the top N drops no event');
  const tally = {};
  for (const x of inSessions) tally[x.e] = (tally[x.e] || 0) + 1;
  const top3 = Object.entries(tally).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3);
  const vocab = Object.fromEntries(r.vocabulary.map((v) => [v.event, v.events]));
  for (const [e, k] of top3) assert.equal(vocab[e], k, `T12 top 3: ${e} keeps its name`);
  assert.equal(vocab.other, inSessions.length - top3.reduce((x, [, k]) => x + k, 0), 'T12 top 3: the rest is "other"');
});

// I — two starts of one sampled spec: a share of the users and a share of one event's rows, each by a
// hash, so both builds hold the same users and the same rows; every other event of those users whole.
test('a sample is drawn by a hash — the same users and the same rows of an event on every build, every other event whole', opts, async (t) => {
  if (skip(t)) return;
  const build = async (name) => {
    const b = await engine.build_retentioneering_model({ name, source: 'events', sample: { share: 0.5, events: { level_started: 0.5, first_launch: 1 } } });
    const r = await readDone(b.task_id);
    assert.equal(r.status, 'done', `${name}: ${JSON.stringify(r.error)}`);
    return r;
  };
  const [a, b] = [await build('sampled_a'), await build('sampled_b')];
  const usersOf = async (r) => (await wh.query(`select distinct user_id from ${r.model} order by 1`)).rows.map((x) => x.user_id);
  const users = await usersOf(a);
  assert.ok(users.length > 0 && users.length < built.users, `T9: a sample keeps some users, not all (${users.length})`);
  assert.deepEqual(await usersOf(b), users, 'T9: a user sample keeps the same users on every build');
  // the counts expected of the sampled event and of the others: over the users the table holds
  const held = new Set(users.map(String));
  const theirs = w.rows.filter((x) => held.has(String(x.u)));
  const total = (name) => theirs.filter((x) => x.e === name).length;
  const vocab = (r) => new Map(r.vocabulary.map((v) => [v.event, v.events]));
  const kept = vocab(a).get('level_started');
  assert.ok(kept > 0 && kept < total('level_started'), `T39: a share of level_started is kept (${kept} of ${total('level_started')})`);
  assert.equal(vocab(b).get('level_started'), kept, 'T39: the same rows on a second build');
  for (const [e, k] of vocab(a)) if (e !== 'level_started') assert.equal(k, total(e), `T39: ${e} is whole`);
  assert.equal(a.events, theirs.length - total('level_started') + kept, 'T39: every other event whole, the sampled one at its share');
  assert.deepEqual(a.sample.events, { level_started: 0.5 }, 'T39: the summary says what was sampled (a share of 1 is no sample)');
  // an event the source does not have is refused before anything runs
  await assert.rejects(engine.build_retentioneering_model({ name: 'x', source: 'events', sample: { events: { no_such_event: 0.5 } } }), /no_such_event|invalid input/, 'T39: an event the source does not have');
});
