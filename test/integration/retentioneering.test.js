// THE RETENTIONEERING FEATURE, END TO END on DuckDB — the analyses: an eventstream built in SQL from the
// fixture events, the analyses run as one dbt Python model on the feature's own dbt environment
// (`retentioneering`: dbt 1.x + the library), and every number checked against what the rows say —
// counted here, independently, from the warehouse. Also here: a context's eventstreams over time, the
// filter_events grammar, the starts from a pipeline's tasks. An eventstream's steps and the specs a start
// takes are retentioneering-steps.test.js; both stand on retentioneering-harness.js and run side by side.
//
// Every analysis of the users' paths is ONE call (Q1, in before()) — the charted ones, the diffs and the
// ones without a card alike: each test below reads its own of them, from the summary or from the one read
// of every record. A check that names an earlier test (T8, T17, …) in its message is that test's, merged
// into a scenario that shares its builds and runs. What one python model costs is a dbt process and the
// library's import, so a check rides on a run that happens anyway wherever it can.
//
// Skipped when the environment is not built (npm run dbt:env -- create retentioneering).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { retentioneeringViewModel } from '../../src/retentioneering/view-model.js';
import { toCallToolResult } from '../../src/mcp-surface.js';
import { one } from '../helpers/settle.js';
import { ENV, opts, skip, FUNNEL, table, sizes, openWorld } from './retentioneering-harness.js';

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
  // over), then the funnel's diff (T17: offered), then the anchored diff (T33: offered next)
  const q = await engine.query_retentioneering_model({
    context_id: built.context_id, eventstream: 'paths',
    analyses: [
      // T31 + T34: the analyses no card draws
      { kind: 'conversion_rate', start_anchor: 'level_started', end_anchor: 'level_completed' },
      { kind: 'path_metrics', metrics: [{ metric: 'length' }, { metric: 'has_event', metric_args: { event: 'shop_opened' } }] },
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
  // the summary the model reads, and every record the card draws — each read once
  analyses = { task_id: q.task_id, read: await readDone(q.task_id), full: await readDone(q.task_id, { detail: 'full' }) };
}, opts);
after(async () => { await w?.close(); });

/** One analysis of Q1 in full — every cell the card draws, not the summary the model reads. */
const full = (id) => analyses.full.analyses[id];

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
  const g = full('transition_graph');
  assert.deepEqual(new Map(g.edges.map((e) => [`${e.source}>${e.target}`, e.count])), expected);
  // proba_out: the share of the source's departures
  const out = {};
  for (const [k, n] of expected) { const s = k.split('>')[0]; out[s] = (out[s] || 0) + n; }
  for (const e of g.edges) assert.ok(Math.abs(e.proba_out - e.count / out[e.source]) < 1e-9, `${e.source}>${e.target}`);
  // the layout places every event, deterministically
  assert.ok(g.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)));
});

test('step matrix: the share at each step is the share of paths whose t-th position is that event', opts, async (t) => {
  if (skip(t)) return;
  const users = paths();
  const m = full('step_matrix');
  const cells = new Map(m.blocks[0].cells.map((c) => [`${c.step}|${c.event}`, c.share]));
  for (const step of m.blocks[0].steps) {
    const count = {};
    for (const list of users.values()) {
      const seq = ['path_start', ...list.map((r) => r.e), 'path_end'];
      const e = step < seq.length ? seq[step] : 'path_end';
      count[e] = (count[e] || 0) + 1;
    }
    for (const [e, n] of Object.entries(count)) assert.ok(Math.abs((cells.get(`${step}|${e}`) || 0) - n / users.size) < 1e-9, `step ${step} ${e}`);
  }
});

test('step sankey: the flows out of each step add up to that step\'s shares', opts, async (t) => {
  if (skip(t)) return;
  const s = full('step_sankey');
  const [block] = s.blocks;
  assert.ok(block.links.length > 0);
  const out = {};
  for (const l of block.links) out[`${l.step}|${l.source}`] = (out[`${l.step}|${l.source}`] || 0) + l.share;
  for (const c of block.cells) if (c.step < block.steps.at(-1)) assert.ok(Math.abs((out[`${c.step}|${c.event}`] || 0) - c.share) < 1e-9, `step ${c.step} ${c.event}`);
});

test('funnel: the paths that reach each step in order', opts, async (t) => {
  if (skip(t)) return;
  const f = analyses.read.analyses.funnel;
  assert.deepEqual(f.steps.map((s) => s.unique_paths), reach(paths().values()));
});

test('clusters cover every path once; segment overview sizes are the users per platform', opts, async (t) => {
  if (skip(t)) return;
  const c = analyses.read.analyses.cluster_analysis;
  assert.equal(c.clusters.reduce((a, x) => a + x.size, 0), built.users);
  assert.ok(c.silhouette.length === 2 && c.silhouette.filter((s) => s.best).length === 1);
  const s = analyses.read.analyses.segment_overview;
  assert.deepEqual(sizes(s), perPlatform);
  // the summary is the groups' profiles plus the library's own tables — the label of every path among
  // them, its first rows shown and all of them counted — never the metric list spread into it
  for (const summary of [c, s]) assert.deepEqual(Object.keys(summary).filter((k) => /^\d+$/.test(k)), []);
  const labels = c.tables.find((tb) => tb.total_rows === built.users);
  assert.ok(labels, `a table with a row per path (${c.tables.map((tb) => `${tb.name}: ${tb.total_rows}`).join(', ')})`);
  assert.equal(labels.rows.length, Math.min(built.users, 7), 'the summary shows the first rows the read kept');
  // detail: "full" reads every row of it from the stored table — the read kept only its first
  const whole = full('cluster_analysis').tables.find((tb) => tb.name === labels.name);
  assert.equal(whole.rows.length, built.users);
});

test('a metric asked for at two aggs — or twice — in one overview is computed, each number the one it has alone', opts, async (t) => {
  if (skip(t)) return;
  const r = analyses.full;
  assert.equal(r.status, 'done', JSON.stringify(r.error));
  const values = (id, name) => r.analyses[id].metrics.find((m) => m.metric === name)?.values;
  for (const [both, alone] of [['both', ''], ['clusters_both', 'clusters_']]) {
    assert.deepEqual(r.analyses[both].levels, r.analyses[`${alone}mean`].levels);
    assert.deepEqual(values(both, 'length_mean'), values(`${alone}mean`, 'length_mean'));
    assert.deepEqual(values(both, 'length_median'), values(`${alone}median`, 'length_median'));
    assert.ok(values(both, 'length_mean').length > 1);
  }
  // …and the platform sizes are the warehouse's users per platform, as for any overview
  assert.deepEqual(sizes(r.analyses.both, 'both'), perPlatform);
});

test('display draws one analysis once — the card model is built from the stored numbers', opts, async (t) => {
  if (skip(t)) return;
  // a card takes a title in the person's words, and draws the analysis's numbers under it
  const d = await engine.display_retentioneering_result({ task_id: analyses.task_id, analysis: 'funnel', title: 'Tutorial to first purchase' });
  assert.equal(d.drawn, true);
  const vm = retentioneeringViewModel(d, { task_id: analyses.task_id, analysis: 'funnel' });
  assert.equal(vm.title, 'Tutorial to first purchase');
  assert.deepEqual(vm.steps.map((s) => s.value), analyses.read.analyses.funnel.steps.map((s) => s.unique_paths));
  assert.ok(toCallToolResult(d, 'display_retentioneering_result', {}, engine).structuredContent, 'a drawn card carries its structured result');
  await assert.rejects(engine.display_retentioneering_result({ task_id: analyses.task_id, analysis: 'funnel' }), /shown already/);
  // two calls at once for one analysis: one draws it, the other is refused — never two cards
  const both = await Promise.allSettled([0, 1].map(() => engine.display_retentioneering_result({ task_id: analyses.task_id, analysis: 'step_matrix' })));
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
  await assert.rejects(one(engine.query_pipeline_model({ task_ids: [analyses.task_id] })), /query_retentioneering_model/);
});

// A top N's names and its "other" are counted in retentioneering-steps.test.js (the path-key test's
// sessions_1_2 build).
test('every event keeps its name by default; the card carries its scope and path counts — a path per session too', opts, async (t) => {
  if (skip(t)) return;
  assert.ok(!built.vocabulary.some((v) => v.event === 'other'), 'no "other" by default');
  // an analysis knows how many paths it read; the card, who and when
  assert.equal(analyses.read.analyses.funnel && full('funnel').paths, built.users);
  const d = await engine.display_retentioneering_result({ task_id: analyses.task_id, analysis: 'funnel_sessions' });
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
  assert.equal(r.analyses.transition_graph.edges.reduce((n, e) => n + e.count, 0), pairs);
  assert.notEqual(r.show_to_user?.arguments.request.analysis, 'unmatched', 'the failed one is not offered as a card');
  await assert.rejects(engine.display_retentioneering_result({ task_id: analyses.task_id, analysis: 'unmatched' }), (e) => e.field === 'analysis' && /PatternNoMatchError/.test(e.message));
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
  assert.equal(r.show_to_user?.arguments.request.analysis, 'funnel_diff', 'T17: the diff is offered as a card');
  const df = await engine.display_retentioneering_result({ task_id: q.task_id, analysis: 'funnel_diff' });
  const vf = retentioneeringViewModel(df, { task_id: q.task_id, analysis: 'funnel_diff' });
  assert.equal(vf.kind, 'funnel_diff', 'T17: drawn as a funnel diff');
  assert.deepEqual([vf.groups.segment, vf.groups.first, vf.groups.second], ['platform', p1, p2], 'T17: its groups');
  // each group's steps are the funnel of that group's paths alone, as the rows reach them (the rule the funnel test holds the library to)
  assert.deepEqual(vf.steps.map((s) => s.first.value), reach(of(p1)), `T17: ${p1} alone`);
  assert.deepEqual(vf.steps.map((s) => s.second.value), reach(of(p2)), `T17: ${p2} alone`);
  for (const s of vf.steps) assert.equal(s.delta.value, s.first.value - s.second.value, 'T17: the difference');
  // the default read carries the same numbers: each step for both groups and their difference
  const sm = r.analyses.funnel_diff;
  assert.deepEqual([sm.diff, sm.groups], [true, { segment: 'platform', first: p1, second: p2 }], 'T17: the summary says the diff and its groups');
  assert.deepEqual(sm.steps.map((s) => [s.first.unique_paths, s.second.unique_paths, s.difference.unique_paths]), vf.steps.map((s) => [s.first.value, s.second.value, s.delta.value]), 'T17: the summary\'s steps are the card\'s');

  // T33 — once the funnel is drawn, the anchored diff is the card offered next
  const again = await readDone(q.task_id);
  assert.equal(again.show_to_user?.arguments.request.analysis, 'step_matrix_diff', 'T33: the anchored diff is offered as a card');
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
    for (const row of diff.rows) diff.columns.slice(1).forEach((_, k) => {
      assert.ok(Math.abs(row[k + 1] - (value(first, row[0], k + 1) - value(second, row[0], k + 1))) < 1e-9, `T33: block ${b} ${row[0]} step ${diff.columns[k + 1]}`);
    });
  }
  const dm = retentioneeringViewModel(await engine.display_retentioneering_result({ task_id: q.task_id, analysis: 'step_matrix_diff' }), {});
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
  const dg = retentioneeringViewModel(await engine.display_retentioneering_result({ task_id: q.task_id, analysis: 'graph_diff' }), {});
  assert.equal(dg.kind, 'diff', 'T32: drawn as tables');
  assert.deepEqual(dg.tables.map((x) => [x.role, x.diverging]), [['diff', true], ['first', false], ['second', false]], 'T32: the difference on a diverging scale');

  // T35 — a distribution comparison is drawn as one histogram: each level's bins hold its paths
  const dd = retentioneeringViewModel(await engine.display_retentioneering_result({ task_id: q.task_id, analysis: 'metric_distribution' }), {});
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

// Q1's analyses no card draws: their numbers are in the read (a summary by default, every record with
// detail: "full"), and a draw asked for anyway is refused without leaving a mark.
test('analyses without a card: the library\'s tables, the rows\' numbers, a summary by default and every record in full — and a refused draw leaves no mark', opts, async (t) => {
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
  assert.equal(summary.show_to_user?.arguments.request.analysis, 'funnel_diff', 'T31: no card is offered');
  await assert.rejects(engine.display_retentioneering_result({ task_id: q.task_id, analysis: 'conversion_rate' }), (e) => e.field === 'analysis' && /no card/.test(e.message), 'T31: a card asked for is refused');
  // T27 — the refusal leaves nothing behind: no mark, nothing held
  const ctx = engine.ctxs.get(built.context_id);
  assert.ok(!ctx.state.retentioneering.drawn?.[q.task_id]?.includes('conversion_rate'), 'T27: a draw that does not happen leaves no mark');
  await assert.rejects(engine.display_retentioneering_result({ task_id: q.task_id, analysis: 'conversion_rate' }), /no card/, 'T27: refused for what it is, not as shown already');
  const metrics = table(a.path_metrics, 'result');
  assert.equal(metrics.length, built.users, 'T31: one row per path, all of them');
  for (const [u, list] of paths()) {
    const m = metrics.find((x) => String(x.user_id) === String(u));
    assert.equal(m.length, list.length, `T31: length of ${u}`);
    assert.equal(m.has_event_shop_opened, list.some((r) => r.e === 'shop_opened') ? 1 : 0, `T31: shop_opened of ${u}`);
  }

  // T34 — a read is a summary by default and every record with detail: "full"
  const [tb] = summary.analyses.path_metrics.tables;
  assert.equal(tb.total_rows, built.users, 'T34: the summary counts every row');
  // the first rows the read kept (7 in this suite), up to the 20 a summary shows
  assert.equal(tb.rows.length, Math.min(built.users, 20, 7), 'T34: the summary shows the first rows the read kept');
  assert.equal(a.path_metrics.tables[0].rows.length, built.users, 'T34: detail "full" reads every row');
});

// (A sample drawn by a hash — two starts of one sampled spec — is retentioneering-steps.test.js's, with
// the other specs a start takes.)

// E — filter_events.where on an eventstream of its own (a level segment from an event property), each
// where on a fork of it, materialized: the events its table holds are the rows the condition keeps,
// counted here from the warehouse. Three forks carry the five checks: two of them join the wheres of two
// checks by an or, with guards that each part's own exclusion still shows in the counts.
test('filter_events.where: every operator, a number compared as a number, a negation keeps a missing value, a kept tree re-checked — the rows the warehouse keeps', opts, async (t) => {
  if (skip(t)) return;
  const own = (await wh.query('select event_name as e, level_id_of_event_data as l, device_time as t from fct_analytics_events')).rows;
  const b = await engine.build_retentioneering_model({ name: 'levels', source: 'events', segments: [{ property: 'level_id_of_event_data', name: 'level' }] });
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
  // event left out, and two negations on the level (not_in, neq) — each keeping the rows with no level —
  // or (T16 above_5) a level above 5, compared as a number: the day boundary holds for all of it, the
  // negations together or the level. (The level 10 started on a later day is kept by the number alone: the
  // most frequent event is a start, and as text '10' is below '5'.)
  const day = (x) => new Date(x.t).toISOString().slice(0, 10);
  const days = [...new Set(own.map(day))].sort();
  const from = days[Math.floor(days.length / 2)];
  const counts = tally(own);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
  const holds = [
    ['event_time gte', (x) => day(x) >= from],
    ['event not_in', (x) => x.e !== top],
    ['level not_in', (x) => num(x) == null || num(x) !== 1],
    ['level neq', (x) => num(x) == null || num(x) !== 2],
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
  assert.deepEqual(await kept('negations', [
    { column: 'event_time', op: 'gte', value: from },
    { or: [
      { and: [{ column: 'event', op: 'not_in', value: [top] }, { column: 'level', op: 'not_in', value: [1] }, { column: 'level', op: 'neq', value: 2 }] },
      { column: 'level', op: 'gt', value: 5 },
    ] },
  ]), want, 'T14 + T16 negations, and T16 above_5: the rows the warehouse keeps — a negation keeps the rows with no level, a level is compared as a number');

  // T16 — every operator a where takes: a range (both ends), a text pattern, and conditions of which one
  // holds (mid_levels: a level between 2 and 9 that is a level's event or at least 9 — written as the two
  // ways it holds) — or (T16 as_written) a substring matched as written: a % or _ in it is that character,
  // not a wildcard (read as a LIKE pattern, 'ad%' would keep ad_started and ad_finished, and 'e_s'
  // new_session and end_session)
  const midLevels = (x) => num(x) != null && num(x) >= 2 && num(x) <= 9 && (x.e.startsWith('level') || num(x) >= 9);
  const asWritten = (x) => x.e === 'tutorial' || x.e.startsWith('ad%') || x.e.includes('e_s') || x.e.endsWith('_started');
  const asWildcards = (x) => x.e === 'tutorial' || /^ad/.test(x.e) || /e.s/.test(x.e) || /._started$/.test(x.e);
  const either = (a, b) => (x) => a(x) || b(x);
  const want2 = tally(own.filter(either(midLevels, asWritten)));
  // guards: the wildcard reading keeps other rows; the range keeps rows the substrings do not, and each of
  // its ends leaves out rows they do not keep (a level 1, a level 10 that is not a start)
  const widened = (lo, hi) => (x) => num(x) != null && num(x) >= lo && num(x) <= hi && (x.e.startsWith('level') || num(x) >= 9);
  assert.notDeepEqual(tally(own.filter(asWildcards)), tally(own.filter(asWritten)), 'guard: the wildcard reading keeps other rows');
  assert.notDeepEqual(tally(own.filter(either(midLevels, asWildcards))), want2, 'guard: the wildcard reading keeps other rows beside the range');
  assert.notDeepEqual(tally(own.filter(asWritten)), want2, 'guard: the range keeps rows the substrings do not');
  for (const [end, range] of [['lower', widened(1, 9)], ['upper', widened(2, 10)]]) assert.notDeepEqual(tally(own.filter(either(range, asWritten))), want2, `guard: the range's ${end} end leaves out rows the rest of the where keeps`);
  assert.deepEqual(
    await kept('mid_levels', [{ or: [
      { and: [{ column: 'level', op: 'between', value: [2, 9] }, { column: 'event', op: 'starts_with', value: 'level' }] },
      { and: [{ column: 'level', op: 'between', value: [2, 9] }, { column: 'level', op: 'gte', value: 9 }] },
      { column: 'event', op: 'eq', value: 'tutorial' }, { column: 'event', op: 'starts_with', value: 'ad%' }, { column: 'event', op: 'contains', value: 'e_s' }, { column: 'event', op: 'ends_with', value: '_started' },
    ] }]),
    want2,
    'T16 mid_levels: a range, a text pattern, an or — and T16 as_written: a substring\'s % and _ are those characters',
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
  await assert.rejects(engine.build_retentioneering_model({ action: 'add_steps', context_id: ctx, eventstream: 'bad_where', steps: [{ type: 'filter_events', where: [{ column: 'no_such_col', op: 'eq', value: 'x' }] }] }), (e) => e.field === 'steps[0]' && /no_such_col/.test(e.message), 'T14: a column the eventstream does not have');
});

// G — one context's eventstreams over time (a context of its own, deleted at the end): a start, its
// fork, a later start of the same name; a keyword segment; a step waiting for a build while a preview
// answers; and a task of the context once it is gone.
test('a context\'s eventstreams over time: a later start makes a table of its own, a fork keeps its rows and description, a keyword segment is carried, a preview is not held behind a build — and once the context is gone its task is refused', opts, async (t) => {
  if (skip(t)) return;
  // `group` is a keyword in both warehouses: quoted wherever the eventstream and its summary name it
  const first = await readDone((await engine.build_retentioneering_model({ name: 'origin', source: 'events', description: 'every event', segments: [{ model: 'users', attribute: 'platform', name: 'group' }] })).task_id);
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
  const restart = await engine.build_retentioneering_model({ context_id: ctx, name: 'origin', source: 'events', events: { include: ['tutorial'] } });
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
  const a = await readDone(q.task_id, { detail: 'full' });
  assert.equal(a.status, 'done', JSON.stringify(a.error));
  assert.deepEqual(a.analyses.transition_graph.nodes.map((n) => n.event).filter((e) => !['path_start', 'path_end'].includes(e)).sort(), first.vocabulary.map((v) => v.event).sort(), 'T21: a fork of the earlier eventstream keeps reading its rows');
  // T9 — the same analyses in another call give the same numbers: the rows are the users' paths Q1 read
  // (every event of every user; this eventstream has no sessions, and names its platform segment `group`)
  assert.deepEqual([first.events, first.users], [built.events, built.users], 'guard: the fork holds the rows of the users\' paths');
  assert.deepEqual(a.analyses.cluster_analysis, full('cluster_analysis'), 'T9: the clusters of Q1');
  assert.deepEqual(a.analyses.transition_graph, full('transition_graph'), 'T9: the transition graph of Q1');
  // a full read holds the overview as this server reshapes the library's rows — the level names, and
  // each metric's values level by level, segment_size among them (the library's own tables are under
  // `tables`)
  assert.deepEqual(sizes(a.analyses.segment_overview, 'T23: an overview of the keyword segment'), perPlatform, 'T23: an overview of the keyword segment');
  // …and the first build's task still says them
  const reread = await readDone(first.task_id);
  assert.equal(reread.events, first.events, 'T21: the first build\'s task still says its rows');

  // T28 — a task whose context is gone is refused as gone
  await engine.delete_context({ context_id: ctx, force: true });
  await assert.rejects(engine.display_retentioneering_result({ task_id: q.task_id, analysis: 'transition_graph' }), (e) => e.code === 'result_gone' && e.stage === 'validate', 'T28: a task whose context is gone');
});

test('the source\'s own columns and event properties filter the paths and carry as segments — no join needed', opts, async (t) => {
  if (skip(t)) return;
  const own = (await wh.query('select player_id_of_internal as u, event_name as e, bundle_id as b, level_id_of_event_data as l from fct_analytics_events')).rows;
  const b = await engine.build_retentioneering_model({
    name: 'one_app', source: 'events',
    where: [{ column: 'bundle_id', op: 'eq', value: 'com.omg.colorfit' }],
    segments: [{ column: 'bundle_id', name: 'app' }, { property: 'level_id_of_event_data', name: 'level' }],
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
  // a column the table does not have is refused before anything runs, with the ones it has
  await assert.rejects(engine.build_retentioneering_model({ name: 'x', source: 'events', where: [{ column: 'no_such', op: 'eq', value: 1 }] }), (e) => e.field === 'where.column' && /bundle_id/.test(e.message));
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
  const p = await engine.build_pipeline_model({ action: 'start', name: 'restarts', source: 'events' });
  await engine.build_pipeline_model({ action: 'add_steps', context_id: p.context_id, stages: [
    { stage: 'compute', name: 'prev', expr: { fn: 'lag', args: [{ column: 'event_name' }], over: { partition_by: ['player_id_of_internal'], order_by: [{ key: 'device_time' }, { key: 'event_id' }] } } },
    { stage: 'compute', name: 'ev', expr: { fn: 'case', cases: [{ when: [{ column: 'event_name', op: 'eq', value: 'level_started' }, { column: 'prev', op: 'eq', value: 'level_started' }], then: { value: 'level_restarted' } }], else: { column: 'event_name' }, type: 'string' } },
    { stage: 'project', keep: ['player_id_of_internal', 'ev', 'device_time', 'bundle_id'] },
  ] });
  const m = await engine.build_pipeline_model({ action: 'materialize', context_id: p.context_id });
  const firstBuild = await one(engine.query_pipeline_model({ task_ids: [m.task_id] }));
  assert.equal(firstBuild.status, 'done', `T41 the draft's first build: ${JSON.stringify(firstBuild.error)}`);
  const b = await engine.build_retentioneering_model({ name: 'from_pipe', from_task: m.task_id, path: [{ column: 'player_id_of_internal' }], columns: { event: 'ev', time: 'device_time' }, segments: [{ column: 'bundle_id', name: 'app' }] });
  const r = await readDone(b.task_id);
  assert.equal(r.status, 'done', `T41 from_pipe: ${JSON.stringify(r.error)}`);
  assert.deepEqual(new Map(r.vocabulary.map((v) => [v.event, v.events])), expected, 'T41: the events a window defined, counted from the rows');
  assert.equal(r.users, byUser.size, 'T41: a path per player');
  assert.deepEqual(r.path, ['player_id_of_internal'], 'T41: the summary says what one path is');
  // the analyses read it like any eventstream — here the task's table itself, before any step
  const q = await engine.query_retentioneering_model({ context_id: r.context_id, eventstream: 'from_pipe', analyses: [{ kind: 'transition_graph' }] });
  const g = await readDone(q.task_id, { detail: 'full' });
  assert.equal(g.status, 'done', JSON.stringify(g.error));
  assert.equal(new Map(g.analyses.transition_graph.nodes.map((n) => [n.event, n.count])).get('level_restarted'), expected.get('level_restarted'), 'T41: the analysis reads the window-defined event');
  // what the table cannot say is refused before anything runs, with where it belongs
  await assert.rejects(engine.build_retentioneering_model({ name: 'x', from_task: m.task_id, path: [{ column: 'player_id_of_internal' }], columns: { event: 'ev', time: 'device_time' }, where: [{ property: 'result_of_event_data', op: 'eq', value: 'win' }] }), (e) => e.field === 'where.property' && /pipeline/.test(e.message), 'T41: a property of the source is not the table\'s');
  await assert.rejects(engine.build_retentioneering_model({ name: 'x', from_task: m.task_id, path: [{ column: 'no_such' }], columns: { event: 'ev', time: 'device_time' } }), (e) => e.field === 'path' && /ev/.test(e.message), 'T41: a path column the table does not have');

  // T43 — the draft's second build (every event but the first launch; the case renames only level_started)
  const n = Number((await wh.query("select count(*) as n from fct_analytics_events where event_name <> 'first_launch'")).rows[0].n);
  await engine.build_pipeline_model({ action: 'add_steps', context_id: p.context_id, stages: [{ stage: 'where', conditions: [{ column: 'ev', op: 'neq', value: 'first_launch' }] }] });
  const second = await engine.build_pipeline_model({ action: 'materialize', context_id: p.context_id });
  const rebuilt = await one(engine.query_pipeline_model({ task_ids: [second.task_id] }));
  assert.equal(rebuilt.status, 'done', `T43 the draft's rebuild: ${JSON.stringify(rebuilt.error)}`);
  const rb = await engine.build_retentioneering_model({ name: 'from_rebuild', from_task: second.task_id, path: [{ column: 'player_id_of_internal' }], columns: { event: 'ev', time: 'device_time' } });
  const rr = await readDone(rb.task_id);
  assert.equal(rr.status, 'done', `T43 from_rebuild: ${JSON.stringify(rr.error)}`);
  assert.equal(rr.events, n, 'T43: the eventstream over the rebuild finds the table it builds on');
  const pq = await engine.build_pipeline_model({ action: 'start', name: 'on_rebuild', from_task: second.task_id, source: 'events' });
  await engine.build_pipeline_model({ action: 'add_steps', context_id: pq.context_id, stages: [{ stage: 'aggregate', measures: [{ name: 'n', agg: 'count' }] }] });
  const pm = await engine.build_pipeline_model({ action: 'materialize', context_id: pq.context_id });
  const counted = await one(engine.query_pipeline_model({ task_ids: [pm.task_id] }));
  assert.equal(counted.status, 'done', `T43 on_rebuild: ${JSON.stringify(counted.error)}`);
  assert.equal(Number(counted.rows[0].n), n, 'T43: a pipeline started from the rebuild finds its table');
});
