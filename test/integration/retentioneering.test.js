// THE RETENTIONEERING FEATURE, END TO END on DuckDB — the analyses: an eventstream built in SQL from the
// fixture events, the analyses run as one dbt Python model on the feature's own dbt environment
// (`retentioneering`: dbt 1.x + the library), and every number checked against what the rows say —
// counted here, independently, from the warehouse. Also here: a context's eventstreams over time, the
// filter_events grammar, the starts from a pipeline's tasks. An eventstream's steps and the specs a start
// takes are retentioneering-steps.test.js; both stand on retentioneering-harness.js and run side by side.
//
// Every analysis of the users' paths is ONE call (Q1, in before()) — the charted ones, the diffs and the
// ones without a card alike: each test below reads its own of them, from the default read (a page of each
// table) or from the one read of every row, or from its drawn card — but for one call of analyses without
// a card only (T31: a call with nothing to draw offers no card, which no call that has a card can show).
// A read rounds its numbers to 4 decimals: a share read from it is held to the rows within that. A check
// that names an earlier test (T8, T17, …) in its message is that test's, merged into a scenario that
// shares its builds and runs. What one python model costs is a dbt process and the library's import, so
// a check rides on a run that happens anyway wherever it can.
//
// Skipped when the environment is not built (npm run dbt:env -- create retentioneering).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { retentioneeringViewModel } from '../../src/retentioneering/view-model.js';
import { toCallToolResult } from '../../src/mcp-surface.js';
import { READ_PAGE } from '../../src/schema/fields.js';
import { one } from '../helpers/settle.js';
import { ENV, opts, skip, FUNNEL, table, sizes, openWorld, usersJoin, EVERY_ROW } from './retentioneering-harness.js';

let w; let engine; let wh; let rows; let built; let analyses;
/** Users per platform ({ platform: users }), each user's platform, the platforms with paths in order. */
let perPlatform; let platformOf; let platforms;
const readDone = (id, extra) => w.readDone(id, extra);
const paths = () => w.paths();

// each call gets objects of its own
const mean = () => ({ metric: 'length', agg: 'mean' });
const median = () => ({ metric: 'length', agg: 'median' });
const features = () => [{ metric: 'event_count_bulk' }];
/** The clustering Q1 runs, and the context test's call again (T9). */
const clusters = () => ({ kind: 'cluster_analysis', features: features(), method_args: { n_clusters: [2, 3] }, overview_metrics: [mean()] });
/** Two analyses no card draws (T31): Q1 runs them among the others, and a call of its own alone. */
const cardless = () => [
  { kind: 'conversion_rate', start_anchor: 'level_started', end_anchor: 'level_completed' },
  { kind: 'path_metrics', metrics: [{ metric: 'length' }, { metric: 'has_event', metric_args: { event: 'shop_opened' } }] },
];

/** How many of these paths reach each FUNNEL step in order. */
const reach = (lists) => {
  const reached = FUNNEL.map(() => 0);
  for (const list of lists) {
    let k = 0;
    for (const r of list) if (k < FUNNEL.length && r.e === FUNNEL[k]) k += 1;
    for (let i = 0; i < k; i += 1) reached[i] += 1;
  }
  return reached;
};

before(async () => {
  if (!ENV) return;
  w = await openWorld();
  ({ engine, wh, rows, built } = w);
  perPlatform = Object.fromEntries(w.perPlatform.map((r) => [r.platform, r.n]));
  platformOf = new Map((await wh.query('select player_id_of_internal as u, platform from dim_users')).rows.map((r) => [String(r.u), r.platform]));
  platforms = [...new Set([...paths().keys()].map((u) => platformOf.get(String(u))))].filter(Boolean).sort();
  // T15: two events no path has in this order — a pattern of them matches nothing, which only the rows say
  const lists = [...paths().values()].map((l) => l.map((r) => r.e));
  const events = [...new Set(lists.flat())].sort();
  const follows = (a, b) => lists.some((l) => { const i = l.indexOf(a); return i >= 0 && l.slice(i + 1).includes(b); });
  const pair = events.flatMap((a) => events.map((b) => [a, b])).find(([a, b]) => a !== b && !follows(a, b));
  assert.ok(pair, 'T15: the fixture has two events never in that order');
  const [p1, p2] = platforms;
  // Q1: every analysis the readers below check, in one call. The order matters: show_to_user names the
  // first analysis that can be drawn and is not yet — the two without a card come first (T31: passed
  // over for one that has a card), then the funnel's diff (T17: offered), then the anchored diff (T33:
  // offered next)
  const q = await engine.query_retentioneering_model({
    context_id: built.context_id, eventstream: 'paths',
    analyses: [
      // T31 + T34: the analyses no card draws
      ...cardless(),
      // T17 / T33 / T32 / T35: every diff kind and a distribution comparison, each group the rows' own
      { kind: 'funnel', name: 'funnel_diff', steps: FUNNEL, diff: ['platform', p1, p2] },
      { kind: 'step_matrix', name: 'step_matrix_diff', max_steps: 3, diff: ['platform', p1, p2], path_pattern: 'tutorial->.*->level_completed' },
      { kind: 'transition_graph', name: 'graph_diff', edge_weight: 'count', diff: ['platform', p1, p2] },
      { kind: 'metric_distribution', segment_col: 'platform', metric: { metric: 'length' }, segment_levels: [p1, p2] },
      { kind: 'transition_graph' },
      { kind: 'step_matrix', max_steps: 5 },
      { kind: 'step_sankey', max_steps: 4 },
      { kind: 'funnel', steps: FUNNEL },
      clusters(),
      { kind: 'segment_overview', segment_col: 'platform', metrics: [mean()] },
      // T8: the library computes one column per metric before it rolls them up — these made two of one name
      { kind: 'segment_overview', name: 'both', segment_col: 'platform', metrics: [mean(), median(), mean()] },
      { kind: 'segment_overview', name: 'mean', segment_col: 'platform', metrics: [mean()] },
      { kind: 'segment_overview', name: 'median', segment_col: 'platform', metrics: [median()] },
      { kind: 'cluster_analysis', name: 'clusters_both', features: features(), method_args: { n_clusters: 2 }, overview_metrics: [mean(), median()] },
      { kind: 'cluster_analysis', name: 'clusters_mean', features: features(), method_args: { n_clusters: 2 }, overview_metrics: [mean()] },
      { kind: 'cluster_analysis', name: 'clusters_median', features: features(), method_args: { n_clusters: 2 }, overview_metrics: [median()] },
      // T12: per-session paths
      { kind: 'funnel', name: 'funnel_sessions', steps: FUNNEL, path: 'session_id' },
      // T15: the library raises on this one; the call's others keep their numbers
      { kind: 'step_matrix', name: 'unmatched', path_pattern: `${pair[0]}->.*->${pair[1]}` },
    ],
  });
  // the read the model gets by default (a page of each table), and one of every row — each read once
  analyses = { task_id: q.task_id, read: await readDone(q.task_id), full: await readDone(q.task_id, EVERY_ROW) };
}, opts);
after(async () => { await w?.close(); });

/** One analysis of Q1, every row of each of its tables — what a page of the default read may cut. */
const full = (id) => analyses.full.analyses[id];
/** A share read back (rounded to 4 decimals) is the rows' own within the rounding — `n` such shares
 *  added or taken from each other, within n times it. */
const near = (got, want, n = 1) => Math.abs(got - want) <= n * 5e-5 + 1e-12;

test('the eventstream holds every event of every user, and its vocabulary is the source\'s own counts', opts, async (t) => {
  if (skip(t)) return;
  assert.equal(built.status, 'done', JSON.stringify(built.error));
  assert.equal(built.events, rows.length);
  assert.equal(built.users, new Set(rows.map((r) => r.u)).size);
  const counts = {};
  for (const r of rows) counts[r.e] = (counts[r.e] || 0) + 1;
  assert.deepEqual(Object.fromEntries(built.vocabulary.map((v) => [v.event, v.events])), counts);
});

test('sessions split each path at gaps longer than asked — the count matches the gaps in the rows', opts, async (t) => {
  if (skip(t)) return;
  let sessions = 0;
  for (const list of paths().values()) list.forEach((r, i) => { if (i === 0 || (new Date(r.t) - new Date(list[i - 1].t)) / 1000 > 30 * 60) sessions += 1; });
  assert.equal(built.sessions, sessions);
});

test('transition graph: every transition count is the number of consecutive pairs in the paths', opts, async (t) => {
  if (skip(t)) return;
  assert.equal(analyses.read.status, 'done', JSON.stringify(analyses.read.error));
  const expected = new Map();
  const add = (a, b) => expected.set(`${a}>${b}`, (expected.get(`${a}>${b}`) || 0) + 1);
  for (const list of paths().values()) {
    const seq = ['path_start', ...list.map((r) => r.e), 'path_end'];
    for (let i = 0; i + 1 < seq.length; i += 1) add(seq[i], seq[i + 1]);
  }
  const transitions = table(full('transition_graph'), 'transitions');
  assert.deepEqual(new Map(transitions.map((e) => [`${e.from}>${e.to}`, e.count])), expected);
  // the read ranks them: the biggest transitions first
  assert.deepEqual(transitions.map((e) => e.count), [...expected.values()].sort((a, b) => b - a), 'the biggest transitions first');
  // proba_out: the share of the source's departures
  const out = {};
  for (const [k, n] of expected) { const s = k.split('>')[0]; out[s] = (out[s] || 0) + n; }
  for (const e of transitions) assert.ok(near(e.proba_out, e.count / out[e.from]), `${e.from}>${e.to}`);
  // the card draws the same transitions, its weights unrounded, and its layout places every event,
  // deterministically
  const g = (await engine.display_retentioneering_result({ task_id: analyses.task_id, display: { analysis: 'transition_graph' } })).result;
  assert.deepEqual(new Map(g.edges.map((e) => [`${e.source}>${e.target}`, e.count])), expected);
  for (const e of g.edges) assert.ok(Math.abs(e.proba_out - e.count / out[e.source]) < 1e-9, `${e.source}>${e.target}`);
  assert.ok(g.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)));
});

test('step matrix: the share at each step is the share of paths whose t-th position is that event', opts, async (t) => {
  if (skip(t)) return;
  const users = paths();
  // the read's table: a row per event, its share of the paths at each step (a column per step)
  const tb = full('step_matrix').tables.find((x) => x.name === 'step_matrix');
  const steps = tb.columns.slice(1).map(Number);
  const cells = new Map(tb.rows.flatMap(([e, ...shares]) => shares.map((s, k) => [`${steps[k]}|${e}`, s])));
  for (const step of steps) {
    const count = {};
    for (const list of users.values()) {
      const seq = ['path_start', ...list.map((r) => r.e), 'path_end'];
      const e = step < seq.length ? seq[step] : 'path_end';
      count[e] = (count[e] || 0) + 1;
    }
    for (const [e, n] of Object.entries(count)) assert.ok(near(cells.get(`${step}|${e}`) || 0, n / users.size), `step ${step} ${e}`);
  }
  // the events by the highest share they reach
  const peaks = tb.rows.map(([, ...shares]) => Math.max(...shares));
  assert.deepEqual(peaks, [...peaks].sort((a, b) => b - a), 'the events by their peak share');
});

test('step sankey: the flows out of each step add up to that step\'s shares', opts, async (t) => {
  if (skip(t)) return;
  // the card's flows and shares, unrounded
  const s = (await engine.display_retentioneering_result({ task_id: analyses.task_id, display: { analysis: 'step_sankey' } })).result;
  const [block] = s.blocks;
  assert.ok(block.links.length > 0);
  const out = {};
  for (const l of block.links) out[`${l.step}|${l.source}`] = (out[`${l.step}|${l.source}`] || 0) + l.share;
  for (const c of block.cells) if (c.step < block.steps.at(-1)) assert.ok(Math.abs((out[`${c.step}|${c.event}`] || 0) - c.share) < 1e-9, `step ${c.step} ${c.event}`);
  // the read's flows are the card's, the biggest first
  const flows = table(full('step_sankey'), 'flows');
  assert.equal(flows.length, block.links.length, 'the read holds every flow');
  for (const l of block.links) assert.ok(flows.some((f) => f.step === l.step && f.from === l.source && f.to === l.target && near(f.share, l.share)), `the flow ${l.step} ${l.source}>${l.target}`);
  assert.deepEqual(flows.map((f) => f.share), flows.map((f) => f.share).sort((a, b) => b - a), 'the flows by share');
});

test('funnel: the paths that reach each step in order', opts, async (t) => {
  if (skip(t)) return;
  // the read's funnel table, its steps in funnel order
  const f = table(analyses.read.analyses.funnel, 'funnel');
  assert.deepEqual(f.map((s) => s.unique_paths), reach(paths().values()));
});

test('clusters cover every path once; segment overview sizes are the users per platform', opts, async (t) => {
  if (skip(t)) return;
  const c = analyses.read.analyses.cluster_analysis;
  assert.equal(c.clusters.reduce((a, x) => a + x.size, 0), built.users);
  assert.ok(c.silhouette.length === 2 && c.silhouette.filter((s) => s.best).length === 1);
  const s = analyses.read.analyses.segment_overview;
  assert.deepEqual(sizes(s), perPlatform);
  // the read is the groups' profiles beside a page of each table — the groups' metrics, and the
  // library's own: the label of every path among them, counted — never the metric list spread into it
  for (const read of [c, s]) assert.deepEqual(Object.keys(read).filter((k) => /^\d+$/.test(k)), []);
  const labels = c.tables.find((tb) => tb.name !== 'metrics' && tb.page.total_rows === built.users);
  assert.ok(labels, `a table with a row per path (${c.tables.map((tb) => `${tb.name}: ${tb.page.total_rows}`).join(', ')})`);
  // a page of READ_PAGE rows holds them — past the 7 the task holds, read from the stored table
  assert.equal(labels.rows.length, Math.min(built.users, READ_PAGE), 'the default page holds its rows, past those the task holds');
  assert.deepEqual(full('cluster_analysis').tables.find((tb) => tb.name === labels.name).rows, labels.rows, 'the same rows as the read of every row');
});

test('a metric asked for at two aggs — or twice — in one overview is computed, each number the one it has alone', opts, async (t) => {
  if (skip(t)) return;
  const r = analyses.full;
  assert.equal(r.status, 'done', JSON.stringify(r.error));
  // a metric's row of the groups' metrics table: its value per group, by the group's name
  const values = (id, name) => {
    const tb = r.analyses[id].tables.find((x) => x.name === 'metrics');
    const row = tb.rows.find((x) => x[0] === name);
    return row && Object.fromEntries(tb.columns.slice(2).map((group, i) => [group, row[i + 2]]));
  };
  const groups = (id) => (r.analyses[id].levels ?? r.analyses[id].clusters).map((g) => g.name);
  for (const [both, alone] of [['both', ''], ['clusters_both', 'clusters_']]) {
    assert.deepEqual(groups(both), groups(`${alone}mean`));
    assert.deepEqual(values(both, 'length_mean'), values(`${alone}mean`, 'length_mean'));
    assert.deepEqual(values(both, 'length_median'), values(`${alone}median`, 'length_median'));
    assert.ok(Object.keys(values(both, 'length_mean')).length > 1);
  }
  // …and the platform sizes are the warehouse's users per platform, as for any overview
  assert.deepEqual(sizes(r.analyses.both, 'both'), perPlatform);
});

test('display draws one analysis once — the card model is built from the stored numbers', opts, async (t) => {
  if (skip(t)) return;
  // a card takes a title in the person's words, and draws the analysis's numbers under it
  const d = await engine.display_retentioneering_result({ task_id: analyses.task_id, display: { analysis: 'funnel', title: 'Tutorial to first purchase' } });
  assert.equal(d.drawn, true);
  const vm = retentioneeringViewModel(d);
  assert.equal(vm.title, 'Tutorial to first purchase');
  assert.deepEqual(vm.steps.map((s) => s.value), table(analyses.read.analyses.funnel, 'funnel').map((s) => s.unique_paths));
  assert.ok(toCallToolResult(d, 'display_retentioneering_result', {}, engine).structuredContent, 'a drawn card carries its structured result');
  await assert.rejects(engine.display_retentioneering_result({ task_id: analyses.task_id, display: { analysis: 'funnel' } }), /shown already/);
  // two calls at once for one analysis: one draws it, the other is refused — never two cards
  const both = await Promise.allSettled([0, 1].map(() => engine.display_retentioneering_result({ task_id: analyses.task_id, display: { analysis: 'step_matrix' } })));
  assert.deepEqual(both.map((b) => b.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(both.find((b) => b.status === 'fulfilled').value.drawn, true);
  assert.match(String(both.find((b) => b.status === 'rejected').reason?.message), /shown already/);
});

// A path a shape does not hold (no sessions, a word for the user) and a typo in an event are refused in
// test/unit/retentioneering-feature.test.js; these need the built eventstream's own shape.
test('what cannot run is refused before anything starts', opts, async (t) => {
  if (skip(t)) return;
  const ctx = built.context_id;
  await assert.rejects(engine.query_retentioneering_model({ context_id: ctx, eventstream: 'paths', analyses: [{ kind: 'funnel', steps: ['first_launch', 'no_such_event'] }] }), (e) => e.field === 'analyses.steps');
  await assert.rejects(engine.query_retentioneering_model({ context_id: ctx, eventstream: 'paths', analyses: [{ kind: 'segment_overview', segment_col: 'country' }] }), (e) => e.field === 'analyses.segment_col');
  // a task of another side is read by its own tool
  await assert.rejects(one(engine.query_model({ task_ids: [analyses.task_id] })), /query_retentioneering_model/);
});

// A top N's names and its "other" are counted in retentioneering-steps.test.js (the path-key test's
// sessions_1_2 build).
test('every event keeps its name by default; the card carries its scope and path counts — a path per session too', opts, async (t) => {
  if (skip(t)) return;
  assert.ok(!built.vocabulary.some((v) => v.event === 'other'), 'no "other" by default');
  // an analysis knows how many paths it read; the card, who and when
  assert.equal(analyses.read.analyses.funnel.paths, built.users);
  const d = await engine.display_retentioneering_result({ task_id: analyses.task_id, display: { analysis: 'funnel_sessions' } });
  assert.equal(d.result.paths, built.sessions, 'per-session paths');
  assert.deepEqual({ users: d.scope.users, events: d.scope.events }, { users: built.users, events: rows.length });
});

test('an analysis the library raises on keeps its error; the call\'s other analyses keep their numbers', opts, async (t) => {
  if (skip(t)) return;
  const r = analyses.full;
  assert.equal(r.status, 'done', JSON.stringify(r.error));
  assert.equal(r.analyses.unmatched.error.type, 'PatternNoMatchError');
  // the graph is computed all the same: its transitions are the pairs of the paths
  const pairs = [...paths().values()].reduce((n, l) => n + l.length + 1, 0);
  assert.equal(table(r.analyses.transition_graph, 'transitions').reduce((n, e) => n + e.count, 0), pairs);
  assert.notEqual(r.show_to_user?.arguments.request.display.analysis, 'unmatched', 'the failed one is not offered as a card');
  await assert.rejects(engine.display_retentioneering_result({ task_id: analyses.task_id, display: { analysis: 'unmatched' } }), (e) => e.field === 'display.analysis' && /PatternNoMatchError/.test(e.message));
  assert.ok(JSON.stringify(await engine.explore_errors({ task_id: analyses.task_id })).includes('PatternNoMatchError'), 'the failure is in the error log');
});

test('what the library refuses in an analysis is refused by the library itself before the run — its own message, in seconds', opts, async (t) => {
  if (skip(t)) return;
  const started = Date.now();
  const refused = (input, field, re) => assert.rejects(engine.query_retentioneering_model({ context_id: built.context_id, eventstream: 'paths', ...input }), (e) => e.field === field && re.test(e.message) && /nothing ran/.test(e.message));
  // an anchor token the library reads with its spacing, an event a metric names, a level the segment does not have
  await refused({ analyses: [{ kind: 'step_matrix', anchor: { pattern: 'level_started -> shop_opened' } }] }, 'analyses.step_matrix', /level_started /);
  await refused({ analyses: [{ kind: 'segment_overview', segment_col: 'platform', metrics: [{ metric: 'has_event', metric_args: { event: 'no_such_event' }, agg: 'mean' }] }] }, 'analyses.segment_overview', /no_such_event/);
  await refused({ analyses: [{ kind: 'transition_graph', diff: ['platform', 'no_such_platform', '<REST>'] }] }, 'analyses.transition_graph', /no_such_platform/);
  assert.ok(Date.now() - started < 60000, 'refused without a run');
  // the build's summary knows each segment's levels, with their users — what a diff or a filter may name
  assert.deepEqual(Object.fromEntries(built.segment_levels.platform.levels.map((l) => [l.level, l.users])), perPlatform);
});

// Q1's diffs — every diff kind and a distribution comparison, each group checked against the rows of its
// own users, each diff drawn in its own form. (T9 — the same analyses in another call give the same
// numbers — is the context test's: its call runs Q1's clustering and graph again over the same rows.)
test('diffs and a distribution in one call — each group the rows\' own, each diff drawn in its form', opts, async (t) => {
  if (skip(t)) return;
  const [p1, p2] = platforms;
  const q = { task_id: analyses.task_id };
  const r = analyses.read;
  assert.equal(r.status, 'done', JSON.stringify(r.error));
  /** The paths of one platform's users. */
  const of = (platform) => [...paths()].filter(([u]) => platformOf.get(String(u)) === platform).map(([, list]) => list);

  // T17 — a funnel's diff has a card: both groups on the same steps, each the funnel of that group alone
  // (the read was made before anything of the call was drawn)
  assert.equal(r.show_to_user?.arguments.request.display.analysis, 'funnel_diff', 'T17: the diff is offered as a card');
  const df = await engine.display_retentioneering_result({ task_id: q.task_id, display: { analysis: 'funnel_diff' } });
  const vf = retentioneeringViewModel(df);
  assert.equal(vf.kind, 'funnel_diff', 'T17: drawn as a funnel diff');
  assert.deepEqual([vf.groups.segment, vf.groups.first, vf.groups.second], ['platform', p1, p2], 'T17: its groups');
  // each group's steps are the funnel of that group's paths alone, as the rows reach them (the rule the funnel test holds the library to)
  assert.deepEqual(vf.steps.map((s) => s.first.value), reach(of(p1)), `T17: ${p1} alone`);
  assert.deepEqual(vf.steps.map((s) => s.second.value), reach(of(p2)), `T17: ${p2} alone`);
  for (const s of vf.steps) assert.equal(s.delta.value, s.first.value - s.second.value, 'T17: the difference');
  // the default read carries the same numbers: each step for both groups and their difference
  const sm = r.analyses.funnel_diff;
  assert.deepEqual([sm.diff, sm.groups], [true, { segment: 'platform', first: p1, second: p2 }], 'T17: the read says the diff and its groups');
  assert.deepEqual(table(sm, 'funnel').map((s) => [s.first_unique_paths, s.second_unique_paths, s.difference_unique_paths]), vf.steps.map((s) => [s.first.value, s.second.value, s.delta.value]), 'T17: the read\'s steps are the card\'s');

  // T33 — once the funnel is drawn, the anchored diff is the card offered next
  const again = await readDone(q.task_id);
  assert.equal(again.show_to_user?.arguments.request.display.analysis, 'step_matrix_diff', 'T33: the anchored diff is offered as a card');
  const all = analyses.full;
  assert.equal(all.status, 'done', JSON.stringify(all.error));

  // T33 — a diff around an anchor, block by block: each difference is its first group minus its second
  const m = all.analyses.step_matrix_diff;
  assert.equal(m.diff, true, 'T33: a diff');
  const blocks = [...new Set(m.tables.filter((x) => x.role === 'diff').map((x) => x.block))];
  assert.ok(blocks.length >= 1, 'T33: a block per anchor of the pattern');
  for (const b of blocks) {
    const part = (role) => m.tables.find((x) => x.role === role && x.block === b);
    const value = (tb, row, j) => tb.rows.find((x) => x[0] === row)?.[j] ?? 0;
    const [diff, first, second] = ['diff', 'first', 'second'].map(part);
    // (three shares read back rounded: the difference of two, against the third)
    for (const row of diff.rows) diff.columns.slice(1).forEach((_, k) => {
      assert.ok(near(row[k + 1], value(first, row[0], k + 1) - value(second, row[0], k + 1), 3), `T33: block ${b} ${row[0]} step ${diff.columns[k + 1]}`);
    });
  }
  const dm = retentioneeringViewModel(await engine.display_retentioneering_result({ task_id: q.task_id, display: { analysis: 'step_matrix_diff' } }));
  assert.equal(dm.kind, 'diff', 'T33: drawn as tables');
  assert.equal(dm.tables.filter((x) => x.diverging).length, blocks.length, 'T33: each block\'s difference on a diverging scale');

  // T32 — the same analysis for two segment levels and their difference, drawn as tables
  const pairs = (platform) => {
    const out = new Map();
    for (const list of of(platform)) {
      const seq = ['path_start', ...list.map((x) => x.e), 'path_end'];
      for (let i = 0; i + 1 < seq.length; i += 1) out.set(`${seq[i]}>${seq[i + 1]}`, (out.get(`${seq[i]}>${seq[i + 1]}`) || 0) + 1);
    }
    return out;
  };
  const cells = (name) => {
    const tb = all.analyses.graph_diff.tables.find((x) => x.name === name);
    const out = new Map();
    for (const row of tb.rows) tb.columns.slice(1).forEach((target, j) => { if (row[j + 1]) out.set(`${row[0]}>${target}`, row[j + 1]); });
    return out;
  };
  const first = pairs(p1); const second = pairs(p2);
  assert.deepEqual(cells('first'), first, `T32: ${p1}'s transitions`);
  assert.deepEqual(cells('second'), second, `T32: ${p2}'s transitions`);
  const diff = new Map([...new Set([...first.keys(), ...second.keys()])].map((k) => [k, (first.get(k) || 0) - (second.get(k) || 0)]).filter(([, v]) => v !== 0));
  assert.deepEqual(cells('diff'), diff, 'T32: their difference');
  const dg = retentioneeringViewModel(await engine.display_retentioneering_result({ task_id: q.task_id, display: { analysis: 'graph_diff' } }));
  assert.equal(dg.kind, 'diff', 'T32: drawn as tables');
  assert.deepEqual(dg.tables.map((x) => [x.role, x.diverging]), [['diff', true], ['first', false], ['second', false]], 'T32: the difference on a diverging scale');

  // T35 — a distribution comparison is drawn as one histogram: each level's bins hold its paths
  const dd = retentioneeringViewModel(await engine.display_retentioneering_result({ task_id: q.task_id, display: { analysis: 'metric_distribution' } }));
  assert.equal(dd.kind, 'distribution', 'T35: drawn as a distribution');
  assert.equal(dd.histograms.length, 1, 'T35: two levels on the same bins: one comparison');
  const [h] = dd.histograms;
  assert.equal(h.series.length, 2, 'T35: a series per level');
  for (const [k, platform] of [[0, p1], [1, p2]]) {
    const ls = of(platform).map((list) => list.length);
    assert.equal(h.series[k].values.reduce((a, b) => a + b, 0), ls.length, `T35: ${platform}: every path in a bin`);
    // each path counted in the bin its length falls in
    const { edges } = h;
    const expected = edges.slice(1).map((hi, i) => ls.filter((x) => x >= edges[i] && (x < hi || (i === edges.length - 2 && x <= hi))).length);
    assert.deepEqual(h.series[k].values, expected, `T35: ${platform}'s bins`);
  }
});

// Q1's analyses no card draws: their numbers are in the read (a page of each table, by row numbers), no
// card is offered for them — passed over in Q1, and none at all for a call of them alone — and a draw
// asked for anyway is refused without leaving a mark.
test('analyses without a card: the library\'s tables, the rows\' numbers, every table paged by its row numbers — none offered, and a refused draw leaves no mark', opts, async (t) => {
  if (skip(t)) return;
  const q = { task_id: analyses.task_id };
  const summary = analyses.read;
  assert.equal(summary.status, 'done', JSON.stringify(summary.error));
  const all = analyses.full;
  assert.equal(all.status, 'done', JSON.stringify(all.error));
  const a = all.analyses;

  // T31 — conversion rate and path metrics are the library's tables, and their numbers are the rows'
  let withStart = 0; let converted = 0;
  for (const list of paths().values()) {
    const seq = list.map((r) => r.e);
    const at = seq.indexOf('level_started');
    if (at < 0) continue;
    withStart += 1;
    if (seq.slice(at + 1).includes('level_completed')) converted += 1;
  }
  const [row] = table(a.conversion_rate, 'result');
  assert.deepEqual({ paths_with_start: row.paths_with_start, converted: row.converted }, { paths_with_start: withStart, converted }, 'T31: the conversion is the rows\'');
  // neither has a card: none is offered, and one asked for is refused — the numbers are in the read. The
  // offer names the first analysis of the call that can be drawn (the read was made before any was): the
  // two listed first are passed over for the funnel's diff listed after them
  assert.deepEqual(Object.keys(summary.analyses).slice(0, 3), ['conversion_rate', 'path_metrics', 'funnel_diff'], 'guard: the read lists the two without a card first, then one with a card');
  assert.equal(summary.show_to_user?.arguments.request.display.analysis, 'funnel_diff', 'T31: the analyses without a card are passed over for the first one that has one');
  // …and a call made of them alone offers no card at all: nothing in it can be drawn
  const alone = await engine.query_retentioneering_model({ context_id: built.context_id, eventstream: 'paths', analyses: cardless() });
  const aloneRead = await readDone(alone.task_id);
  assert.equal(aloneRead.status, 'done', JSON.stringify(aloneRead.error));
  assert.deepEqual(Object.keys(aloneRead.analyses), ['conversion_rate', 'path_metrics'], 'guard: the call holds the two alone');
  for (const k of ['conversion_rate', 'path_metrics']) assert.deepEqual(aloneRead.analyses[k].tables, summary.analyses[k].tables, `guard: ${k} alone has the numbers it has in Q1`);
  assert.equal(aloneRead.show_to_user, undefined, 'T31: a call of analyses without a card offers none');
  await assert.rejects(engine.display_retentioneering_result({ task_id: q.task_id, display: { analysis: 'conversion_rate' } }), (e) => e.field === 'display.analysis' && /no card/.test(e.message), 'T31: a card asked for is refused');
  // T27 — the refusal leaves nothing behind: no mark, nothing held
  const ctx = engine.ctxs.get(built.context_id);
  assert.ok(!ctx.state.retentioneering.drawn?.[q.task_id]?.includes('conversion_rate'), 'T27: a draw that does not happen leaves no mark');
  await assert.rejects(engine.display_retentioneering_result({ task_id: q.task_id, display: { analysis: 'conversion_rate' } }), /no card/, 'T27: refused for what it is, not as shown already');
  const metrics = table(a.path_metrics, 'result');
  assert.equal(metrics.length, built.users, 'T31: one row per path, all of them');
  for (const [u, list] of paths()) {
    const m = metrics.find((x) => String(x.user_id) === String(u));
    assert.equal(m.length, list.length, `T31: length of ${u}`);
    assert.equal(m.has_event_shop_opened, list.some((r) => r.e === 'shop_opened') ? 1 : 0, `T31: shop_opened of ${u}`);
  }

  // T34 — a read pages every table of every analysis by its row numbers: the default page counts every
  // row; and two pages — the first rows, which the task holds, and the rest, read past them from the
  // stored table — put together are the read of every row, table by table
  const [tb] = summary.analyses.path_metrics.tables;
  assert.equal(tb.page.total_rows, built.users, 'T34: a page counts every row');
  assert.equal(tb.rows.length, Math.min(built.users, READ_PAGE), 'T34: the default page holds READ_PAGE rows');
  const cut = 5;
  const head = await readDone(q.task_id, { offset: 0, limit: cut });
  const rest = await readDone(q.task_id, { offset: cut, limit: EVERY_ROW.limit });
  let paged = 0;
  for (const [id, analysis] of Object.entries(a)) {
    for (const [i, whole] of (analysis.tables || []).entries()) {
      const [first, second] = [head.analyses[id].tables[i], rest.analyses[id].tables[i]];
      assert.deepEqual([first.name, second.name], [whole.name, whole.name], `T34: ${id}: the pages hold the same tables`);
      assert.deepEqual([...first.rows, ...second.rows], whole.rows, `T34: ${id} ${whole.name}: two pages are every row`);
      assert.deepEqual([first.page.has_more, first.page.next_offset], whole.rows.length > cut ? [true, cut] : [false, undefined], `T34: ${id} ${whole.name}: the first page says where the next starts`);
      if (whole.rows.length > 7) paged += 1;
    }
  }
  assert.ok(paged > 0, 'guard: a table goes on past the 7 rows the task holds');
});

// (A sample drawn by a hash — two starts of one sampled spec — is retentioneering-steps.test.js's, with
// the other specs a start takes.)

// E — filter_events.where on an eventstream of its own (a level segment from an event property, read
// into a column by a compute stage), each where on a fork of it, materialized: the events its table holds
// are the rows the condition keeps, counted here from the warehouse. Three forks carry the six checks: two
// of them join the wheres of several checks by an or, with guards that each part's own exclusion still
// shows in the counts.
test('filter_events.where: every operator, a number compared as a number, not(…) keeps a missing value where neq drops it, a kept tree re-checked — the rows the warehouse keeps', opts, async (t) => {
  if (skip(t)) return;
  const own = (await wh.query('select event_name as e, level_id_of_event_data as l, device_time as t from fct_analytics_events')).rows;
  const b = await engine.build_retentioneering_model({ name: 'levels', source: 'events', steps: [{ stage: 'compute', name: 'level', expr: { property: 'level_id_of_event_data' } }], segments: ['level'] });
  const levels = await readDone(b.task_id);
  assert.equal(levels.status, 'done', `T16 levels: ${JSON.stringify(levels.error)}`);
  const ctx = levels.context_id;
  // the segment is stored as text; level 10 is above 5 as a number and below it as text
  assert.ok(own.some((x) => Number(x.l) >= 10), 'T16: the fixture holds a level of two digits');
  const tally = (list) => list.reduce((m, x) => m.set(x.e, (m.get(x.e) || 0) + 1), new Map());
  const num = (x) => (x.l == null ? null : Number(x.l));
  /** An eventstream's steps materialized: the events its table holds, by name. */
  const materialized = async (name) => {
    const m = await engine.build_retentioneering_model({ action: 'materialize', context_id: ctx, eventstream: name });
    const read = await readDone(m.task_id);
    assert.equal(read.status, 'done', `${name}: ${JSON.stringify(read.error)}`);
    return new Map(read.vocabulary.filter((v) => v.event !== 'path_start' && v.event !== 'path_end').map((v) => [v.event, v.events]));
  };
  /** A fork of `levels` with one filter_events step, materialized. */
  const kept = async (name, where) => {
    await engine.build_retentioneering_model({ action: 'fork', context_id: ctx, eventstream: 'levels', name, after: 0 });
    await engine.build_retentioneering_model({ action: 'add_steps', context_id: ctx, eventstream: name, steps: [{ type: 'filter_events', where }] });
    return materialized(name);
  };

  // T14 + T16 — what keep / drop cannot say: a day boundary in the middle of the data, the most frequent
  // event left out, and two negations on the level written as not(…) — not(in), not(eq) — each keeping
  // the rows with no level, or (T16 above_5) a level above 5, compared as a number: the day boundary holds
  // for all of it, the negations together or the level. (The level 10 started on a later day is kept by
  // the number alone: the most frequent event is a start, and as text '10' is below '5'.)
  const level = { column: 'level' };
  const event = { column: 'event' };
  const day = (x) => new Date(x.t).toISOString().slice(0, 10);
  const days = [...new Set(own.map(day))].sort();
  const from = days[Math.floor(days.length / 2)];
  const counts = tally(own);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
  const holds = [
    ['event_time gte', (x) => day(x) >= from],
    ['event not_in', (x) => x.e !== top],
    ['level not(in)', (x) => num(x) == null || num(x) !== 1],
    ['level not(eq)', (x) => num(x) == null || num(x) !== 2],
  ];
  const aboveAsNumber = (x) => num(x) != null && num(x) > 5;
  const aboveAsText = (x) => num(x) != null && String(num(x)) > '5';
  /** The rows the where keeps — the day boundary, and the negations or the level above 5 — with any of
   *  `holds` left out (`without`) and the level read as `above` reads it. */
  const keptBy = ({ without = null, above = aboveAsNumber } = {}) => {
    const conds = holds.filter((c) => c !== without);
    const [time, ...negations] = holds;
    const holdsOf = (c) => (x) => !conds.includes(c) || c[1](x);
    return own.filter((x) => holdsOf(time)(x) && (negations.every((c) => holdsOf(c)(x)) || above(x)));
  };
  const want = tally(keptBy());
  // guards: each condition leaves out rows the rest of the where keeps, the level keeps rows the negations
  // leave out — and only as a number — and rows with no level are among those kept: so each operator's
  // exclusion, a number compared as a number, and a negation keeping a missing value show in the counts
  for (const c of holds) assert.notDeepEqual(tally(keptBy({ without: c })), want, `guard: ${c[0]} leaves out rows the rest of the where keeps`);
  assert.notDeepEqual(tally(keptBy({ above: () => false })), want, 'guard: the level above 5 keeps rows the negations leave out');
  assert.notDeepEqual(tally(keptBy({ above: aboveAsText })), want, 'guard: the level above 5 read as text keeps other rows');
  assert.ok(keptBy().some((x) => x.l == null), 'guard: rows with no level pass every condition');
  // the current time ({ now: true }) is a leaf of the one expression this place takes too: every event is
  // before it, so it leaves the count as it is — a moment read as anything else would not run
  assert.ok(own.every((x) => new Date(x.t) < new Date()), 'guard: every event is before now');
  assert.deepEqual(await kept('negations', [
    { fn: 'gte', args: [{ column: 'event_time' }, { value: from }] },
    { fn: 'lt', args: [{ column: 'event_time' }, { now: true }] },
    { fn: 'or', args: [
      { fn: 'and', args: [
        { fn: 'not_in', args: [event, { value: top }] },
        { fn: 'not', args: [{ fn: 'in', args: [level, { value: 1 }] }] },
        { fn: 'not', args: [{ fn: 'eq', args: [level, { value: 2 }] }] },
      ] },
      { fn: 'gt', args: [level, { value: 5 }] },
    ] },
  ]), want, 'T14 + T16 negations, and T16 above_5: the rows the warehouse keeps — not(…) keeps the rows with no level, a level is compared as a number');

  // T16 — every operator a where takes: a range (both ends), a text pattern, and conditions of which one
  // holds (mid_levels: a level between 2 and 9 that is a level's event or at least 9 — written as the two
  // ways it holds) — or (T16 as_written) a substring matched as written: a % or _ in it is that character,
  // not a wildcard (read as a LIKE pattern, 'ad%' would keep ad_started and ad_finished, and 'e_s'
  // new_session and end_session) — or a first launch whose level is not 1: neq is "present and
  // different", and a first launch has no level, so that part keeps none (were a missing value
  // different from 1, it would keep every first launch)
  const midLevels = (x) => num(x) != null && num(x) >= 2 && num(x) <= 9 && (x.e.startsWith('level') || num(x) >= 9);
  const asWritten = (x) => x.e === 'tutorial' || x.e.startsWith('ad%') || x.e.includes('e_s') || x.e.endsWith('_started');
  const asWildcards = (x) => x.e === 'tutorial' || /^ad/.test(x.e) || /e.s/.test(x.e) || /._started$/.test(x.e);
  const launchNeq = (x) => x.e === 'first_launch' && num(x) != null && num(x) !== 1;
  const launchMissingKept = (x) => x.e === 'first_launch' && (num(x) == null || num(x) !== 1);
  const either = (...fs) => (x) => fs.some((f) => f(x));
  const want2 = tally(own.filter(either(midLevels, asWritten, launchNeq)));
  // guards: the wildcard reading keeps other rows; the range keeps rows the substrings do not, and each of
  // its ends leaves out rows they do not keep (a level 1, a level 10 that is not a start); a first launch
  // has no level, and reading neq as keeping a missing value would keep them all
  const widened = (lo, hi) => (x) => num(x) != null && num(x) >= lo && num(x) <= hi && (x.e.startsWith('level') || num(x) >= 9);
  assert.notDeepEqual(tally(own.filter(asWildcards)), tally(own.filter(asWritten)), 'guard: the wildcard reading keeps other rows');
  assert.notDeepEqual(tally(own.filter(either(midLevels, asWildcards, launchNeq))), want2, 'guard: the wildcard reading keeps other rows beside the range');
  assert.notDeepEqual(tally(own.filter(asWritten)), want2, 'guard: the range keeps rows the substrings do not');
  for (const [end, range] of [['lower', widened(1, 9)], ['upper', widened(2, 10)]]) assert.notDeepEqual(tally(own.filter(either(range, asWritten, launchNeq))), want2, `guard: the range's ${end} end leaves out rows the rest of the where keeps`);
  assert.ok(own.some((x) => x.e === 'first_launch') && own.filter((x) => x.e === 'first_launch').every((x) => num(x) == null), 'guard: the first launches carry no level');
  assert.notDeepEqual(tally(own.filter(either(midLevels, asWritten, launchMissingKept))), want2, 'guard: neq read as keeping a missing value keeps the first launches');
  const between29 = { fn: 'between', args: [level, { value: 2 }, { value: 9 }] };
  assert.deepEqual(
    await kept('mid_levels', [{ fn: 'or', args: [
      { fn: 'and', args: [between29, { fn: 'starts_with', args: [event, { value: 'level' }] }] },
      { fn: 'and', args: [between29, { fn: 'gte', args: [level, { value: 9 }] }] },
      { fn: 'eq', args: [event, { value: 'tutorial' }] },
      { fn: 'starts_with', args: [event, { value: 'ad%' }] },
      { fn: 'contains', args: [event, { value: 'e_s' }] },
      { fn: 'ends_with', args: [event, { value: '_started' }] },
      { fn: 'and', args: [{ fn: 'eq', args: [event, { value: 'first_launch' }] }, { fn: 'neq', args: [level, { value: 1 }] }] },
    ] }]),
    want2,
    'T16 mid_levels: a range, a text pattern, an or — T16 as_written: a substring\'s % and _ are those characters — and neq keeps no missing value',
  );

  // T16 — a step an earlier version kept in its own tree — { op, conditions }, { not } — is re-checked
  // (here, as the step before it is deleted) and keeps the rows it kept then: a missing value matches
  // nothing, so the negation keeps it
  await engine.build_retentioneering_model({ action: 'fork', context_id: ctx, eventstream: 'levels', name: 'kept_tree', after: 0 });
  const tree = { op: 'or', conditions: [{ column: 'level', op: '>', value: 5 }, { not: { op: 'and', conditions: [{ column: 'level', op: '>=', value: 2 }, { column: 'event', op: 'in', value: ['level_completed'] }] } }] };
  engine.ctxs.get(ctx).state.retentioneering.eventstreams.kept_tree.steps = [{ step: { type: 'collapse_events', loops: true } }, { step: { type: 'filter_events', where: tree } }];
  await engine.build_retentioneering_model({ action: 'delete_step', context_id: ctx, eventstream: 'kept_tree', index: 1 });
  assert.deepEqual(await materialized('kept_tree'), tally(own.filter((x) => (num(x) != null && num(x) > 5) || !(num(x) != null && num(x) >= 2 && x.e === 'level_completed'))), 'T16 kept_tree: the earlier tree keeps the rows it kept then');

  // T14 — a name that is not a column of the eventstream is the library's refusal, as the step is added
  await engine.build_retentioneering_model({ action: 'fork', context_id: ctx, eventstream: 'levels', name: 'bad_where', after: 0 });
  await assert.rejects(engine.build_retentioneering_model({ action: 'add_steps', context_id: ctx, eventstream: 'bad_where', steps: [{ type: 'filter_events', where: [{ fn: 'eq', args: [{ column: 'no_such_col' }, { value: 'x' }] }] }] }), (e) => e.field === 'steps[0]' && /no_such_col/.test(e.message), 'T14: a column the eventstream does not have');
  // …and an event property is the source's, not the eventstream's: refused at this place, naming what it
  // takes — the start's compute stage is where a property becomes a column (as `level` above)
  await assert.rejects(engine.build_retentioneering_model({ action: 'add_steps', context_id: ctx, eventstream: 'bad_where', steps: [{ type: 'filter_events', where: [{ fn: 'eq', args: [{ property: 'level_id_of_event_data' }, { value: '1' }] }] }] }), (e) => e.field === 'steps[0].where' && /\{ property \} is not what filter_events' where takes/.test(e.message), 'an event property at filter_events\' place');
});

// G — one context's eventstreams over time (a context of its own, deleted at the end): a start, its
// fork, a later start of the same name; a keyword segment; a step waiting for a build while a preview
// answers; and a task of the context once it is gone.
test('a context\'s eventstreams over time: a later start makes a table of its own, a fork keeps its rows and description, a keyword segment is carried, a preview is not held behind a build — and once the context is gone its task is refused', opts, async (t) => {
  if (skip(t)) return;
  // `group` is a keyword in both warehouses: quoted wherever the eventstream and its summary name it — the
  // platform a join stage brings under that name
  const first = await readDone((await engine.build_retentioneering_model({ name: 'origin', source: 'events', description: 'every event', steps: [usersJoin([{ column: 'platform', name: 'group' }])], segments: ['group'] })).task_id);
  assert.equal(first.status, 'done', `T23 origin: ${JSON.stringify(first.error)}`);
  const ctx = first.context_id;
  assert.deepEqual(Object.fromEntries(first.segment_levels.group.levels.map((l) => [l.level, l.users])), perPlatform, 'T23: a segment named for a keyword is carried, level by level');
  await engine.build_retentioneering_model({ action: 'fork', context_id: ctx, eventstream: 'origin', name: 'origin_copy' });
  // a description is kept with its eventstream (a fork carries its parent's), not with the context
  const described = async () => Object.fromEntries((await engine.context({ action: 'describe', context_id: ctx })).eventstreams.map((e) => [e.name, e.description]));
  const atFork = await described();
  assert.deepEqual([atFork.origin, atFork.origin_copy], ['every event', 'every event'], 'T21: the fork carries its parent\'s description');

  // T23 — a column a step makes is an identifier the warehouse stores
  const segmentNamed = (name) => engine.build_retentioneering_model({ action: 'add_steps', context_id: ctx, eventstream: 'origin_copy', steps: [{ type: 'add_segment', name, rules: { cases: [{ column: 'group', op: '=', value: 'ios', level: 'x' }], else: 'y' } }] });
  await assert.rejects(segmentNamed('ad format'), (e) => e.field === 'steps[0]' && /'ad format' cannot be a column/.test(e.message) && /nothing changed/.test(e.message), 'T23: a name with a space');
  await assert.rejects(segmentNamed('seg\n'), (e) => e.field === 'steps[0]' && /cannot be a column/.test(e.message), 'T23: a name with a newline');
  // nor a name the stored eventstream uses for what it carries besides
  await assert.rejects(segmentNamed('event_order'), (e) => e.field === 'steps[0]' && /uses that name itself/.test(e.message), 'T23: a name the stored eventstream uses');

  // T28 + T21 — a later start of the same name, and a step on it that waits for that build — while a
  // preview of another eventstream of the context answers at once
  const restart = await engine.build_retentioneering_model({ context_id: ctx, name: 'origin', source: 'events', steps: [{ stage: 'where', conditions: [{ fn: 'eq', args: [{ column: 'event_name' }, { value: 'tutorial' }] }] }] });
  const order = [];
  const stepping = engine.build_retentioneering_model({ action: 'add_steps', context_id: ctx, eventstream: 'origin', steps: [{ type: 'collapse_events', loops: true }] }).then(() => order.push('step'));
  await engine.build_retentioneering_model({ action: 'preview', context_id: ctx, eventstream: 'origin_copy' }).then(() => order.push('preview'));
  await stepping;
  assert.deepEqual(order, ['preview', 'step'], 'T28: a preview is not held behind a step waiting for a build');
  const again = await readDone(restart.task_id);
  assert.notEqual(again.model, first.model, 'T21: a later start of the same name makes a table of its own');
  assert.deepEqual(again.vocabulary.map((v) => v.event), ['tutorial'], 'T21: the later start holds its own events');
  const atRestart = await described();
  assert.deepEqual([atRestart.origin, atRestart.origin_copy], [undefined, 'every event'], 'T21: the description went with the eventstream it was given to');

  // the fork reads the rows it was made from (T21), the keyword segment among them (T23) — and Q1's
  // clustering and graph run again over them (T9)
  const q = await engine.query_retentioneering_model({ context_id: ctx, eventstream: 'origin_copy', analyses: [{ kind: 'transition_graph' }, { kind: 'segment_overview', segment_col: 'group', metrics: [mean()] }, clusters()] });
  const a = await readDone(q.task_id, EVERY_ROW);
  assert.equal(a.status, 'done', JSON.stringify(a.error));
  assert.deepEqual(table(a.analyses.transition_graph, 'events').map((n) => n.event).filter((e) => !['path_start', 'path_end'].includes(e)).sort(), first.vocabulary.map((v) => v.event).sort(), 'T21: a fork of the earlier eventstream keeps reading its rows');
  // T9 — the same analyses in another call give the same numbers: the rows are the users' paths Q1 read
  // (every event of every user; this eventstream has no sessions, and names its platform segment `group`)
  assert.deepEqual([first.events, first.users], [built.events, built.users], 'guard: the fork holds the rows of the users\' paths');
  assert.deepEqual(a.analyses.cluster_analysis, full('cluster_analysis'), 'T9: the clusters of Q1');
  assert.deepEqual(a.analyses.transition_graph, full('transition_graph'), 'T9: the transition graph of Q1');
  // a read holds the overview's groups as this server reshapes the library's rows — each level with
  // its size and profile (the metrics by level, and the library's own tables, are under `tables`)
  assert.deepEqual(sizes(a.analyses.segment_overview, 'T23: an overview of the keyword segment'), perPlatform, 'T23: an overview of the keyword segment');
  // …and the first build's task still says them
  const reread = await readDone(first.task_id);
  assert.equal(reread.events, first.events, 'T21: the first build\'s task still says its rows');

  // delete_context in the feature's own form removes one eventstream: the context keeps the other, and the
  // task that read the removed one still reads its rows — its tables stay until the context is dropped
  const removed = await engine.delete_context({ what: 'eventstream', context_id: ctx, eventstream: 'origin_copy' });
  assert.deepEqual([removed.removed, removed.eventstream], [true, 'origin_copy']);
  assert.deepEqual(Object.keys(await described()), ['origin'], 'one eventstream removed, the other kept');
  assert.deepEqual((await readDone(q.task_id, EVERY_ROW)).analyses.transition_graph, a.analyses.transition_graph, 'the task that read the removed eventstream reads the same rows');
  await assert.rejects(engine.delete_context({ what: 'eventstream', context_id: ctx, eventstream: 'origin_copy' }), (e) => e.field === 'eventstream' && /no eventstream 'origin_copy'/.test(e.message), 'an eventstream the context no longer holds');

  // T28 — a task whose context is gone is refused as gone
  await engine.delete_context({ context_id: ctx, force: true });
  await assert.rejects(engine.display_retentioneering_result({ task_id: q.task_id, display: { analysis: 'transition_graph' } }), (e) => e.code === 'result_gone' && e.stage === 'validate', 'T28: a task whose context is gone');
});

test('the source\'s own columns and event properties filter the paths and carry as segments, by the start\'s steps — no join needed', opts, async (t) => {
  if (skip(t)) return;
  const own = (await wh.query('select player_id_of_internal as u, event_name as e, bundle_id as b, level_id_of_event_data as l from fct_analytics_events')).rows;
  // a where on a column of the source, a compute copying a column under another name, a compute reading
  // an event property into a column — and the two columns carried as segments
  const b = await engine.build_retentioneering_model({
    name: 'one_app', source: 'events',
    steps: [
      { stage: 'where', conditions: [{ fn: 'eq', args: [{ column: 'bundle_id' }, { value: 'com.omg.colorfit' }] }] },
      { stage: 'compute', name: 'app', expr: { column: 'bundle_id' } },
      { stage: 'compute', name: 'level', expr: { property: 'level_id_of_event_data' } },
    ],
    segments: ['app', 'level'],
  });
  const r = await readDone(b.task_id);
  assert.equal(r.status, 'done', JSON.stringify(r.error));
  const kept = own.filter((x) => x.b === 'com.omg.colorfit');
  assert.equal(r.events, kept.length, 'only that app\'s events');
  assert.equal(r.users, new Set(kept.map((x) => x.u)).size);
  const es = (await wh.query(`select app, level, count(*) as n from ${r.model} group by 1, 2`)).rows;
  assert.deepEqual([...new Set(es.map((x) => x.app))], ['com.omg.colorfit'], 'the column carried as a segment');
  const byLevel = (list, key) => list.reduce((m, x) => m.set(String(x[key] ?? ''), (m.get(String(x[key] ?? '')) || 0) + Number(x.n ?? 1)), new Map());
  assert.deepEqual(byLevel(es, 'level'), byLevel(kept.map((x) => ({ level: x.l })), 'level'), 'the property carried as a segment, value by value');
  // a column the table does not have is refused before anything runs, by the step that names it, with the ones it has
  await assert.rejects(engine.build_retentioneering_model({ name: 'x', source: 'events', steps: [{ stage: 'where', conditions: [{ fn: 'eq', args: [{ column: 'no_such' }, { value: 1 }] }] }] }), (e) => e.field === 'steps[0]' && /no_such/.test(e.message) && /bundle_id/.test(e.message));
});

// K — FROM A PIPELINE'S TASKS. An event only a window can define — a level started again right after a
// start (the previous event of the same player is also a start) — made in a pipeline draft, and read by
// the path analysis from that build's stored table, the columns named by the caller. Then the draft's
// SECOND build: that table reads the draft's first build (its checkpoint) through a ref — the
// eventstream and a new pipeline started from it compile only when the models it depends on come along
// with it. (An eventstream stored with its path in columns.path: test/unit/retentioneering-feature.test.js.)
test('from a pipeline\'s tasks: an eventstream over a window-defined event, and over the draft\'s rebuild; a pipeline started from that rebuild finds its table', opts, async (t) => {
  if (skip(t)) return;
  const src = (await wh.query('select event_id as id, player_id_of_internal as u, event_name as e, device_time as t, bundle_id as b from fct_analytics_events')).rows;
  // the same rule, counted here from the rows: previous event of the player, by time then event id
  const byUser = new Map();
  for (const r of src) (byUser.get(r.u) || byUser.set(r.u, []).get(r.u)).push(r);
  const expected = new Map();
  for (const list of byUser.values()) {
    list.sort((a, b) => (String(a.t) < String(b.t) ? -1 : String(a.t) > String(b.t) ? 1 : String(a.id).localeCompare(String(b.id))));
    list.forEach((r, i) => {
      const name = r.e === 'level_started' && list[i - 1]?.e === 'level_started' ? 'level_restarted' : r.e;
      expected.set(name, (expected.get(name) || 0) + 1);
    });
  }
  assert.ok(expected.get('level_restarted') > 0, 'T41: the fixture has restarts to find');
  const p = await engine.build_model({ action: 'start', name: 'restarts', source: 'events' });
  await engine.build_model({ action: 'add_steps', context_id: p.context_id, steps: [
    { stage: 'compute', name: 'prev', expr: { fn: 'lag', args: [{ column: 'event_name' }], over: { partition_by: ['player_id_of_internal'], order_by: [{ key: 'device_time' }, { key: 'event_id' }] } } },
    { stage: 'compute', name: 'ev', expr: { fn: 'case', cases: [{ when: [{ fn: 'eq', args: [{ column: 'event_name' }, { value: 'level_started' }] }, { fn: 'eq', args: [{ column: 'prev' }, { value: 'level_started' }] }], then: { value: 'level_restarted' } }], else: { column: 'event_name' }, type: 'string' } },
    { stage: 'project', keep: ['player_id_of_internal', 'ev', 'device_time', 'bundle_id'] },
  ] });
  const m = await engine.build_model({ action: 'materialize', context_id: p.context_id });
  const firstBuild = await one(engine.query_model({ task_ids: [m.task_id] }));
  assert.equal(firstBuild.status, 'done', `T41 the draft's first build: ${JSON.stringify(firstBuild.error)}`);
  // the start's steps run over the task's table as over a source: here a compute copying a column under the segment's name
  const b = await engine.build_retentioneering_model({ name: 'from_pipe', from_task: m.task_id, path: ['player_id_of_internal'], columns: { event: 'ev', time: 'device_time' }, steps: [{ stage: 'compute', name: 'app', expr: { column: 'bundle_id' } }], segments: ['app'] });
  const r = await readDone(b.task_id);
  assert.equal(r.status, 'done', `T41 from_pipe: ${JSON.stringify(r.error)}`);
  assert.deepEqual(new Map(r.vocabulary.map((v) => [v.event, v.events])), expected, 'T41: the events a window defined, counted from the rows');
  assert.equal(r.users, byUser.size, 'T41: a path per player');
  assert.deepEqual(r.path, ['player_id_of_internal'], 'T41: the summary says what one path is');
  // the analyses read it like any eventstream — here the task's table itself, before any step
  const q = await engine.query_retentioneering_model({ context_id: r.context_id, eventstream: 'from_pipe', analyses: [{ kind: 'transition_graph' }] });
  const g = await readDone(q.task_id, EVERY_ROW);
  assert.equal(g.status, 'done', JSON.stringify(g.error));
  assert.equal(new Map(table(g.analyses.transition_graph, 'events').map((n) => [n.event, n.count])).get('level_restarted'), expected.get('level_restarted'), 'T41: the analysis reads the window-defined event');
  // what the table cannot say is refused before anything runs, with where it belongs
  await assert.rejects(engine.build_retentioneering_model({ name: 'x', from_task: m.task_id, path: ['player_id_of_internal'], columns: { event: 'ev', time: 'device_time' }, steps: [{ stage: 'where', conditions: [{ fn: 'eq', args: [{ property: 'result_of_event_data' }, { value: 'win' }] }] }] }), (e) => e.field === 'steps[0]' && /result_of_event_data/.test(e.message), 'T41: a property of the source is not the table\'s');
  await assert.rejects(engine.build_retentioneering_model({ name: 'x', from_task: m.task_id, path: ['no_such'], columns: { event: 'ev', time: 'device_time' } }), (e) => e.field === 'path' && /ev/.test(e.message), 'T41: a path column the table does not have');

  // T43 — the draft's second build (every event but the first launch; the case renames only level_started)
  const n = Number((await wh.query("select count(*) as n from fct_analytics_events where event_name <> 'first_launch'")).rows[0].n);
  await engine.build_model({ action: 'add_steps', context_id: p.context_id, steps: [{ stage: 'where', conditions: [{ fn: 'neq', args: [{ column: 'ev' }, { value: 'first_launch' }] }] }] });
  const second = await engine.build_model({ action: 'materialize', context_id: p.context_id });
  const rebuilt = await one(engine.query_model({ task_ids: [second.task_id] }));
  assert.equal(rebuilt.status, 'done', `T43 the draft's rebuild: ${JSON.stringify(rebuilt.error)}`);
  const rb = await engine.build_retentioneering_model({ name: 'from_rebuild', from_task: second.task_id, path: ['player_id_of_internal'], columns: { event: 'ev', time: 'device_time' } });
  const rr = await readDone(rb.task_id);
  assert.equal(rr.status, 'done', `T43 from_rebuild: ${JSON.stringify(rr.error)}`);
  assert.equal(rr.events, n, 'T43: the eventstream over the rebuild finds the table it builds on');
  const pq = await engine.build_model({ action: 'start', name: 'on_rebuild', from_task: second.task_id, source: 'events' });
  await engine.build_model({ action: 'add_steps', context_id: pq.context_id, steps: [{ stage: 'aggregate', measures: [{ name: 'n', expr: { fn: 'count' } }] }] });
  const pm = await engine.build_model({ action: 'materialize', context_id: pq.context_id });
  const counted = await one(engine.query_model({ task_ids: [pm.task_id] }));
  assert.equal(counted.status, 'done', `T43 on_rebuild: ${JSON.stringify(counted.error)}`);
  assert.equal(Number(counted.rows[0].n), n, 'T43: a pipeline started from the rebuild finds its table');

  // T44 — an eventstream reads events: a pipeline build's task is taken (above), a semantic task is not.
  // A semantic layer's build holds metrics, and what a metric query stores is aggregated, one row per
  // group — refused before anything runs, naming the way to the events.
  const semantic = /task \w+ is of a semantic layer/;
  const coreDone = async (id) => { for (;;) { const r = await one(engine.query_model({ task_ids: [id] })); if (r.status !== 'running') return r; } };
  const layer = await engine.build_model({ action: 'start', name: 'sem_layer', source: 'events', steps: [{ stage: 'semantic_model', measures: [{ name: 'evts', expr: { fn: 'count' } }], metrics: [{ name: 'evts', type: 'simple', measure: 'evts' }] }], materialize: true });
  const parsed = await coreDone(layer.materialize.task_id);
  assert.equal(parsed.status, 'done', `T44 the layer parses: ${JSON.stringify(parsed.error)}`);
  const asStream = (from_task) => engine.build_retentioneering_model({ name: 'from_sem', from_task, path: ['player_id_of_internal'], columns: { event: 'event_name', time: 'device_time' } });
  await assert.rejects(asStream(layer.materialize.task_id), (e) => e.field === 'from_task' && semantic.test(e.message), 'T44: a semantic layer\'s build');
  const stored = await engine.query_model({ context_id: layer.context_id, steps: [{ stage: 'metrics', metrics: ['evts'], group_by: [{ time: 'metric_time', grain: 'day' }] }], materialize: true });
  const result = await coreDone(stored.task_id);
  assert.equal(result.status, 'done', `T44 the metric query stores its result: ${JSON.stringify(result.error)}`);
  await assert.rejects(asStream(stored.task_id), (e) => e.field === 'from_task' && semantic.test(e.message), 'T44: a metric query stored with materialize');
  // …while the pipeline's own build is still taken, the rows it stored counted as events
  const againStart = await engine.build_retentioneering_model({ name: 'from_pipe_again', from_task: second.task_id, path: ['player_id_of_internal'], columns: { event: 'ev', time: 'device_time' } });
  const again = await readDone(againStart.task_id);
  assert.equal(again.events, n, 'T44: a pipeline build stays a source of an eventstream');
  // T45 — the other way round: an eventstream's task is no table a build starts from (said as it is, not
  // as a restart), the query tool of the core does not read a path-analysis context, and a refused start
  // leaves no context behind
  await assert.rejects(engine.build_model({ action: 'start', name: 'from_rete', from_task: againStart.task_id }),
    (e) => e.field === 'from_task' && /was started by build_retentioneering_model, and a build starts only from a pipeline build or a metric query run with materialize: true/.test(e.message), 'T45: from an eventstream\'s task');
  await assert.rejects(engine.query_model({ context_id: againStart.context_id, steps: [{ stage: 'limit', limit: 1 }] }), (e) => e.field === 'context_id' && /holds no semantic layer and no pipeline table/.test(e.message), 'T45: query_model on a path-analysis context');
  const contexts = () => engine.ctxs.list().length;
  const count = contexts();
  await assert.rejects(engine.build_retentioneering_model({ name: 'bad_path', from_task: second.task_id, path: ['no_such_column'], columns: { event: 'ev', time: 'device_time' } }), (e) => e.field === 'path' && /'no_such_column' is not a column of/.test(e.message), 'T45: a start refused at its rows\' columns');
  assert.equal(contexts(), count, 'T45: a refused start leaves no context');
});
