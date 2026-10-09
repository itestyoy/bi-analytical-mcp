// THE RETENTIONEERING FEATURE, END TO END on DuckDB — an eventstream's steps and the specs a start
// takes: forks of the users' paths (`paths`) shaped by the library's own ops, each checked by the library
// as it is added and materialized as one dbt Python model on the feature's own dbt environment
// (`retentioneering`: dbt 1.x + the library); and starts whose events, paths and window the SQL decides.
// Every number is checked against what the rows say — counted here, independently, from the warehouse.
// The analyses are retentioneering.test.js; both stand on retentioneering-harness.js and run side by side.
//
// A check that names an earlier test (T13, T22, …) in its message is that test's, merged into a scenario
// that shares its builds and runs.
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

// D — the collapsed paths, a fork of them filtered by length, and the collapsed paths moved on by a
// time condition after an analysis read them.
test('collapsed paths: no self-transition; a fork with a path filter keeps its paths and leaves its parent; a time condition counts seconds since the epoch; a card speaks of the rows it read', opts, async (t) => {
  if (skip(t)) return;
  const { ctx, read: read1 } = await shaped('collapsed', [{ type: 'collapse_events', loops: true }]);
  // T13 — a fork of it with one more step: the collapsed paths longer than 5, the parent untouched
  await engine.build_retentioneering_model({ action: 'fork', context_id: ctx, eventstream: 'collapsed', name: 'long_paths' });
  await engine.build_retentioneering_model({ action: 'add_steps', context_id: ctx, eventstream: 'long_paths', steps: [{ type: 'filter_paths', condition: { op: '>', metric: 'length', value: 5 } }] });
  const read2 = await readDone((await engine.build_retentioneering_model({ action: 'materialize', context_id: ctx, eventstream: 'long_paths' })).task_id);
  assert.equal(read2.status, 'done', `T13 long_paths: ${JSON.stringify(read2.error)}`);
  const long = [...paths().values()].filter((list) => collapsed(list).length > 5).length;
  assert.equal(read2.users, long, 'T13: the materialized eventstream holds the paths the filter kept');

  // T13 — the analyses read the collapsed paths: the pairs of the paths once every run of one event is one event
  const q = await engine.query_retentioneering_model({ context_id: ctx, eventstream: 'collapsed', analyses: [{ kind: 'transition_graph' }, { kind: 'describe' }] });
  const a = await readDone(q.task_id, { detail: 'full' });
  assert.equal(a.status, 'done', JSON.stringify(a.error));
  const expected = new Map();
  for (const list of paths().values()) {
    const seq = ['path_start', ...collapsed(list), 'path_end'];
    for (let i = 0; i + 1 < seq.length; i += 1) expected.set(`${seq[i]}>${seq[i + 1]}`, (expected.get(`${seq[i]}>${seq[i + 1]}`) || 0) + 1);
  }
  assert.deepEqual(new Map(a.analyses.transition_graph.edges.map((e) => [`${e.source}>${e.target}`, e.count])), expected, 'T13: collapsed loops — the transitions of the collapsed paths');
  assert.ok(!a.analyses.transition_graph.edges.some((e) => e.source === e.target), 'T13: no self-loops');
  assert.equal(a.analyses.describe.values['shape'].n_paths, built.users, 'T13: the fork left its parent as it was');

  // T30 + T25 — the collapsed paths move on: the paths that started before a moment (seconds since the
  // epoch), the median of the players' first events
  const firsts = (await wh.query('select epoch(min(device_time)) as s from fct_analytics_events group by player_id_of_internal order by 1')).rows.map((r) => Number(r.s));
  const moment = firsts[Math.floor(firsts.length / 2)];
  // guard: collapsing loops cannot move a path's first event when no path begins with two events of one name
  assert.ok([...paths().values()].every((list) => list.length < 2 || list[0].e !== list[1].e), 'guard: no path begins with two events of one name');
  await engine.build_retentioneering_model({ action: 'add_steps', context_id: ctx, eventstream: 'collapsed', steps: [{ type: 'filter_paths', condition: { op: '<', metric: 'first_event_time', value: moment } }] });
  const moved = await readDone((await engine.build_retentioneering_model({ action: 'materialize', context_id: ctx, eventstream: 'collapsed' })).task_id);
  assert.equal(moved.status, 'done', `T30 collapsed, moved on: ${JSON.stringify(moved.error)}`);
  assert.equal(moved.users, firsts.filter((s) => s < moment).length, 'T30: a condition on a time metric compares seconds since the epoch');
  assert.ok(moved.users < read1.users, 'T25: the eventstream moved on — fewer paths');
  // T25 — a card speaks of the rows its analysis read, whatever the eventstream became after
  const d = await engine.display_retentioneering_result({ task_id: q.task_id, analysis: 'transition_graph' });
  assert.deepEqual([d.scope.users, d.scope.events], [read1.users, read1.events], 'T25: the card\'s scope is the rows its analysis read');
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

// F — the segments steps make, all on one fork (a segment step leaves the paths as they are): bins of a
// metric by value and by quantile, and levels by rules.
test('segments a step makes: metric bins by value and by quantile, rules case by case — each level holds its paths', opts, async (t) => {
  if (skip(t)) return;
  const lengths = [...paths().values()].map((list) => list.length);
  // pandas' linear quantile, which the library cuts at
  const sorted = [...lengths].sort((a, b) => a - b);
  const quantile = (q) => { const p = (sorted.length - 1) * q; const lo = Math.floor(p); return sorted[lo] + (sorted[Math.ceil(p)] - sorted[lo]) * (p - lo); };
  const median = quantile(0.5);
  // rules: the first platform (and a constant with a quote, which the tool writes as one) is one level, the rest the else level
  const [first, ...others] = w.perPlatform;
  const want = Object.fromEntries(Object.entries({ first_store: first.n, other_store: others.reduce((n, r) => n + r.n, 0) }).filter(([, n]) => n));
  const { ctx, read } = await shaped('bands', [
    // the bins in any order after the lowest: each keeps its own level
    { type: 'add_segment', name: 'length_band', metric_bins: { metric: { metric: 'length' }, bins: [{ level: 'short' }, { level: 'long', from: 10 }, { level: 'mid', from: 5 }] } },
    { type: 'add_segment', name: 'half', metric_bins: { metric: { metric: 'length' }, bins: [{ level: 'lower' }, { level: 'upper', from_quantile: 0.5 }] } },
    { type: 'add_segment', name: 'store', rules: { cases: [{ column: 'platform', op: 'in', value: [first.platform, "it's not a level"], level: 'first_store' }], else: 'other_store' } },
  ]);
  // T20 — the materialized eventstream knows the levels the step made, with their users
  assert.deepEqual(Object.fromEntries(read.segment_levels.store.levels.map((l) => [l.level, l.users])), want, 'T20: the rules\' levels in the build\'s summary');
  const a = await analyze(ctx, 'bands', [
    { kind: 'segment_overview', name: 'by_value', segment_col: 'length_band', metrics: [{ metric: 'length', agg: 'mean' }] },
    { kind: 'segment_overview', name: 'by_quantile', segment_col: 'half', metrics: [{ metric: 'length', agg: 'mean' }] },
    { kind: 'segment_overview', name: 'by_store', segment_col: 'store', metrics: [{ metric: 'length', agg: 'mean' }] },
  ]);
  const count = (f) => lengths.filter(f).length;
  assert.deepEqual(sizes(a.by_value), Object.fromEntries(Object.entries({ short: count((n) => n < 5), mid: count((n) => n >= 5 && n < 10), long: count((n) => n >= 10) }).filter(([, n]) => n)), 'T19 by value: each bin holds the paths whose length falls in it');
  assert.deepEqual(sizes(a.by_quantile), Object.fromEntries(Object.entries({ lower: count((n) => n < median), upper: count((n) => n >= median) }).filter(([, n]) => n)), 'T19 by quantile: each bin holds the paths whose length falls in it');
  assert.deepEqual(sizes(a.by_store), want, 'T20: each path gets the level of the first case its row matches, the rest the else level');
  // T19 — two bins of one name, or two starting at one point, are refused in the call
  const bins = (list) => engine.build_retentioneering_model({ action: 'add_steps', context_id: ctx, eventstream: 'bands', steps: [{ type: 'add_segment', name: 'x', metric_bins: { metric: { metric: 'length' }, bins: list } }] });
  await assert.rejects(bins([{ level: 'a' }, { level: 'a', from: 3 }]), (e) => e.field === 'steps[0].metric_bins' && /two bins are named 'a'/.test(e.message), 'T19: two bins of one name');
  await assert.rejects(bins([{ level: 'a' }, { level: 'b', from: 3 }, { level: 'c', from: 3 }]), (e) => e.field === 'steps[0].metric_bins' && /two bins start/.test(e.message), 'T19: two bins of one start');
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

test('a sample the caller left unseeded is drawn with a fixed seed: the same paths on every materialize', opts, async (t) => {
  if (skip(t)) return;
  const kept = [];
  for (const name of ['half_a', 'half_b']) {
    const { read } = await shaped(name, [{ type: 'sample_paths', frac: 0.5 }]);
    kept.push((await wh.query(`select distinct user_id from ${read.model} order by 1`)).rows.map((r) => r.user_id));
  }
  assert.ok(kept[0].length > 0 && kept[0].length < built.users, 'a real sample');
  assert.deepEqual(kept[0], kept[1]);
});

// ── what a start takes: its events, its path, its window — decided in SQL ─────────────────────────

test('events made from an event\'s parameters: split by value (with names of its own) and by conditions, counted from the rows', opts, async (t) => {
  if (skip(t)) return;
  const src = (await wh.query('select player_id_of_internal as u, event_name as e, result_of_event_data as r, device_time as t from fct_analytics_events')).rows;
  const counts = (list) => list.reduce((m, x) => m.set(x, (m.get(x) || 0) + 1), new Map());
  // by value: win → level_won (its own name), any other value → level_completed_<value>
  const b = await engine.build_retentioneering_model({
    name: 'by_result', source: 'events',
    events: { split: [{ event: 'level_completed', by: { property: 'result_of_event_data' }, names: { win: 'level_won' } }] },
  });
  const r = await readDone(b.task_id);
  assert.equal(r.status, 'done', JSON.stringify(r.error));
  const expected = counts(src.map((x) => (x.e !== 'level_completed' || x.r == null ? x.e : x.r === 'win' ? 'level_won' : `level_completed_${x.r}`)));
  assert.deepEqual(new Map(r.vocabulary.map((v) => [v.event, v.events])), expected);
  assert.equal(r.events, src.length, 'no event lost');
  // by conditions: the first case that holds; the rest take `else` — the names the table holds, and so
  // what an analysis of it reads
  const c = await engine.build_retentioneering_model({
    name: 'by_case', source: 'events',
    events: { split: [{ event: 'level_completed', cases: [{ name: 'level_lost', when: [{ property: 'result_of_event_data', op: 'eq', value: 'lose' }] }], else: 'level_passed' }] },
  });
  const rc = await readDone(c.task_id);
  const lost = src.filter((x) => x.e === 'level_completed' && x.r === 'lose').length;
  const vocab = new Map(rc.vocabulary.map((v) => [v.event, v.events]));
  assert.deepEqual([vocab.get('level_lost'), vocab.get('level_passed'), vocab.get('level_completed')], [lost, src.filter((x) => x.e === 'level_completed').length - lost, undefined]);
  // an unknown parameter is refused before anything runs
  await assert.rejects(engine.build_retentioneering_model({ name: 'x', source: 'events', events: { split: [{ event: 'level_completed', by: { property: 'no_such' } }] } }), /invalid input|no_such/);
});

test('a group merges events the split made — a name it gives and an <event>_<value> — with events of the source', opts, async (t) => {
  if (skip(t)) return;
  const src = (await wh.query('select event_name as e, result_of_event_data as r from fct_analytics_events')).rows;
  const b = await engine.build_retentioneering_model({
    name: 'grouped', source: 'events',
    events: {
      split: [{ event: 'level_completed', by: { property: 'result_of_event_data' }, names: { win: 'level_won' } }],
      groups: { level_end: ['level_won', 'level_completed_lose', 'shop_opened'] },
    },
  });
  const r = await readDone(b.task_id);
  assert.equal(r.status, 'done', JSON.stringify(r.error));
  const vocab = new Map(r.vocabulary.map((v) => [v.event, v.events]));
  const n = (f) => src.filter(f).length;
  assert.equal(vocab.get('level_end'), n((x) => (x.e === 'level_completed' && ['win', 'lose'].includes(x.r)) || x.e === 'shop_opened'));
  assert.deepEqual([vocab.get('level_won'), vocab.get('level_completed_lose'), vocab.get('shop_opened')], [undefined, undefined, undefined]);
  // a name neither the source nor the split has is still refused
  await assert.rejects(engine.build_retentioneering_model({ name: 'x', source: 'events', events: { split: [{ event: 'level_completed', cases: [{ name: 'level_lost', when: [{ property: 'result_of_event_data', op: 'eq', value: 'lose' }] }] }], groups: { g: ['level_lostt'] } } }), (e) => e.field === 'events.groups.g');
});

test('a time window scopes the eventstream on the partitioned source (in a timezone, across the UTC day), and a source that requires one refuses a build without it', opts, async (t) => {
  if (skip(t)) return;
  // 2026-01-02 in UTC+14 = [01-01 10:00, 01-02 10:00) UTC — partly on the previous UTC day
  const inWindow = Number((await wh.query("select count(*) as n from fct_analytics_events where device_time >= timestamp '2026-01-01 10:00:00' and device_time < timestamp '2026-01-02 10:00:00'")).rows[0].n);
  const b = await engine.build_retentioneering_model({ name: 'windowed', source: 'events', time_range: { start: '2026-01-02', end: '2026-01-02', timezone: 'Pacific/Kiritimati' } });
  const r = await readDone(b.task_id);
  assert.equal(r.status, 'done', JSON.stringify(r.error));
  assert.equal(r.events, inWindow);
  assert.equal(inWindow, 39);
  const saved = engine.catalog._requireTimeRangeAll;
  engine.catalog._requireTimeRangeAll = true;
  try {
    await assert.rejects(engine.build_retentioneering_model({ name: 'x', source: 'events' }), (e) => e.field === 'time_range');
  } finally { engine.catalog._requireTimeRangeAll = saved; }
});

// A PATH that is not the user: one path per value of a composite key of columns, or of an event property
// (a key of one part takes the property's branch; a column as a key part, the composite key's).
test('a path by a column, by a composite key and by an event property: one path per value, events without it left out', opts, async (t) => {
  if (skip(t)) return;
  const src = (await wh.query('select player_id_of_internal as u, session_number as s, level_id_of_event_data as l, event_name as e from fct_analytics_events')).rows;
  const distinct = (f) => new Set(src.filter((x) => f(x) != null && !String(f(x)).includes('null')).map(f)).size;
  const read = async (name, path) => {
    const b = await engine.build_retentioneering_model({ name, source: 'events', path });
    const r = await readDone(b.task_id);
    assert.equal(r.status, 'done', JSON.stringify(r.error));
    return r;
  };
  const composite = await read('by_player_session', [{ column: 'player_id_of_internal' }, { column: 'session_number' }]);
  assert.equal(composite.users, distinct((x) => (x.u == null || x.s == null ? null : `${x.u}|${x.s}`)));
  assert.deepEqual(composite.path, ['player_id_of_internal', 'session_number'], 'the summary says what one path is: the key\'s parts');
  const byLevel = await read('by_level', [{ property: 'level_id_of_event_data' }]);
  assert.equal(byLevel.users, distinct((x) => x.l));
  assert.deepEqual(byLevel.path, ['level_id_of_event_data'], 'the summary says what one path is: the property');
  assert.equal(byLevel.events, src.filter((x) => x.l != null).length, 'events without the key are left out');
  // between: both ends included — and a top N: the most frequent events of those rows keep their names,
  // the rest is "other" (no event is dropped)
  const b = await engine.build_retentioneering_model({ name: 'sessions_1_2', source: 'events', where: [{ column: 'session_number', op: 'between', value: [1, 2] }], events: { top: 3 } });
  const r = await readDone(b.task_id);
  assert.equal(r.status, 'done', JSON.stringify(r.error));
  const inSessions = src.filter((x) => x.s >= 1 && x.s <= 2);
  assert.equal(r.events, inSessions.length);
  const counts = {};
  for (const x of inSessions) counts[x.e] = (counts[x.e] || 0) + 1;
  const top3 = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3);
  const vocab = Object.fromEntries(r.vocabulary.map((v) => [v.event, v.events]));
  for (const [e, n] of top3) assert.equal(vocab[e], n, `T12 top 3: ${e} keeps its name`);
  assert.equal(vocab.other, inSessions.length - top3.reduce((a, [, n]) => a + n, 0), 'T12 top 3: the rest is "other"');
  await assert.rejects(engine.build_retentioneering_model({ name: 'x', source: 'events', path: [{ column: 'no_such' }] }), (e) => e.field === 'path');
});
