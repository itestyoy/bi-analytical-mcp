// THE RETENTIONEERING FEATURE, END TO END on DuckDB: an eventstream built in SQL from the fixture
// events, the analyses run as one dbt Python model on the feature's own dbt environment
// (`retentioneering`: dbt 1.x + the library), and every number checked against what the rows say —
// counted here, independently, from the warehouse.
//
// Skipped when the environment is not built (npm run dbt:env -- create retentioneering).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { createDbt } from '../../src/dbt/index.js';
import { Engine } from '../../src/engine.js';
import { createRetentioneeringFeature } from '../../src/retentioneering/index.js';
import { retentioneeringViewModel } from '../../src/retentioneering/view-model.js';
import { toCallToolResult } from '../../src/mcp-surface.js';
import { settle, one } from '../helpers/settle.js';
import { dbtEnv } from '../helpers/dbt-env.js';
import { fixtureProject, startWarehouse } from './warehouse-harness.js';

const execFileP = promisify(execFile);
const ENV = dbtEnv('retentioneering');
const opts = { timeout: 900000 };
const skip = (t) => { if (!ENV) { t.skip('dbt environment retentioneering not installed (npm run dbt:env -- create retentioneering)'); return true; } return false; };

let engine; let wh; let rows; let built; let analyses;
const FUNNEL = ['tutorial', 'level_started', 'shop_opened', 'iap_purchase_completed'];

before(async () => {
  if (!ENV) return;
  const BASE = fixtureProject('dbt_project');
  wh = await startWarehouse();
  const env = { ...process.env, DBT_PROFILES_DIR: BASE, DBT_PROJECT_DIR: BASE, DUCKDB_PATH: wh.path };
  await execFileP(ENV.dbtBin, ['seed'], { cwd: BASE, env, timeout: 240000, maxBuffer: 1 << 26 });
  await execFileP(ENV.dbtBin, ['run'], { cwd: BASE, env, timeout: 240000, maxBuffer: 1 << 26 });
  const runner = createDbt({ environment: ENV, profilesDir: BASE, timeout: 600000 });
  const catalog = loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), { profilesDir: BASE, projectDir: BASE });
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: mkdtempSync(join(tmpdir(), 'rete-ctx-')), timeSpineDialect: 'duckdb' });
  engine = settle(new Engine({
    catalog, contextManager: ctxs, runner, dbPath: join(mkdtempSync(join(tmpdir(), 'rete-db-')), 'x.sqlite'),
    // a read keeps 7 rows of a table (not 1000), so these few users' per-path tables are cut as a large
    // eventstream's are, and every whole read is proved by the numbers
    features: [createRetentioneeringFeature({ runner, keptRows: 7 })], featureStatus: [{ id: 'retentioneering', available: true }],
  }));
  // the rows every expectation below is counted from: each event, its user, its time — in path order
  rows = (await wh.query('select player_id_of_internal as u, event_name as e, device_time as t from fct_analytics_events order by 1, 3, 2')).rows;
  const b = await engine.build_retentioneering_model({ name: 'paths', source: 'events', segments: [{ model: 'users', attribute: 'platform' }], sessions: { gap_minutes: 30 } });
  built = await readDone(b.task_id);
  const q = await engine.query_retentioneering_model({
    context_id: built.context_id,
    analyses: [
      { kind: 'transition_graph' },
      { kind: 'step_matrix', max_steps: 5 },
      { kind: 'step_sankey', max_steps: 4 },
      { kind: 'funnel', steps: FUNNEL },
      { kind: 'cluster_analysis', features: [{ metric: 'event_count_bulk' }], method_args: { n_clusters: [2, 3] }, overview_metrics: [{ metric: 'length', agg: 'mean' }] },
      { kind: 'segment_overview', segment_col: 'platform', metrics: [{ metric: 'length', agg: 'mean' }] },
    ],
  });
  analyses = { task_id: q.task_id, read: await readDone(q.task_id) };
}, opts);
after(async () => { try { engine?.close(); } catch { /* noop */ } if (wh) await wh.stop(); });

/** A task's read, followed until it is done (one read waits at most 30 s; a build under load can take longer). */
const readDone = async (id, extra = {}) => {
  for (;;) {
    const r = await one(engine.query_retentioneering_model({ task_ids: [id], ...extra }));
    if (r.status !== 'running') return r;
  }
};

/** Each user's events in time order (ties by name, as the eventstream orders them). */
const paths = () => {
  const by = new Map();
  for (const r of rows) (by.get(r.u) || by.set(r.u, []).get(r.u)).push(r);
  for (const list of by.values()) list.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : a.e.localeCompare(b.e)));
  return by;
};
/** One analysis of the task in full — every cell the card draws, not the summary the model reads. */
const full = async (id) => (await readDone(analyses.task_id, { detail: 'full' })).analyses[id];

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
  const g = await full('transition_graph');
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
  const m = await full('step_matrix');
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
  const s = await full('step_sankey');
  const [block] = s.blocks;
  assert.ok(block.links.length > 0);
  const out = {};
  for (const l of block.links) out[`${l.step}|${l.source}`] = (out[`${l.step}|${l.source}`] || 0) + l.share;
  for (const c of block.cells) if (c.step < block.steps.at(-1)) assert.ok(Math.abs((out[`${c.step}|${c.event}`] || 0) - c.share) < 1e-9, `step ${c.step} ${c.event}`);
});

test('funnel: the paths that reach each step in order', opts, async (t) => {
  if (skip(t)) return;
  const reached = FUNNEL.map(() => 0);
  for (const list of paths().values()) {
    let k = 0;
    for (const r of list) if (k < FUNNEL.length && r.e === FUNNEL[k]) k += 1;
    for (let i = 0; i < k; i += 1) reached[i] += 1;
  }
  const f = analyses.read.analyses.funnel;
  assert.deepEqual(f.steps.map((s) => s.unique_paths), reached);
});

test('clusters cover every path once; segment overview sizes are the users per platform', opts, async (t) => {
  if (skip(t)) return;
  const c = analyses.read.analyses.cluster_analysis;
  assert.equal(c.clusters.reduce((a, x) => a + x.size, 0), built.users);
  assert.ok(c.silhouette.length === 2 && c.silhouette.filter((s) => s.best).length === 1);
  const perPlatform = (await wh.query('select platform, count(distinct u.player_id_of_internal) as n from dim_users u join (select distinct player_id_of_internal from fct_analytics_events) e using (player_id_of_internal) group by platform')).rows;
  const s = analyses.read.analyses.segment_overview;
  assert.deepEqual(Object.fromEntries(s.levels.map((l) => [l.name, l.size])), Object.fromEntries(perPlatform.map((r) => [r.platform, Number(r.n)])));
  // the summary is the groups' profiles plus the library's own tables — the label of every path among
  // them, its first rows shown and all of them counted — never the metric list spread into it
  for (const summary of [c, s]) assert.deepEqual(Object.keys(summary).filter((k) => /^\d+$/.test(k)), []);
  const labels = c.tables.find((tb) => tb.total_rows === built.users);
  assert.ok(labels, `a table with a row per path (${c.tables.map((tb) => `${tb.name}: ${tb.total_rows}`).join(', ')})`);
  assert.equal(labels.rows.length, Math.min(built.users, 7), 'the summary shows the first rows the read kept');
  // detail: "full" reads every row of it from the stored table — the read kept only its first
  const whole = (await readDone(analyses.task_id, { detail: 'full' })).analyses.cluster_analysis.tables.find((tb) => tb.name === labels.name);
  assert.equal(whole.rows.length, built.users);
});

test('a metric asked for at two aggs — or twice — in one overview is computed, each number the one it has alone', opts, async (t) => {
  if (skip(t)) return;
  const mean = { metric: 'length', agg: 'mean' };
  const median = { metric: 'length', agg: 'median' };
  const features = [{ metric: 'event_count_bulk' }];
  const q = await engine.query_retentioneering_model({ context_id: built.context_id, analyses: [
    // the library computes one column per metric before it rolls them up: these made two of one name
    { kind: 'segment_overview', id: 'both', segment_col: 'platform', metrics: [mean, median, mean] },
    { kind: 'segment_overview', id: 'mean', segment_col: 'platform', metrics: [mean] },
    { kind: 'segment_overview', id: 'median', segment_col: 'platform', metrics: [median] },
    { kind: 'cluster_analysis', id: 'clusters_both', features, method_args: { n_clusters: 2 }, overview_metrics: [mean, median] },
    { kind: 'cluster_analysis', id: 'clusters_mean', features, method_args: { n_clusters: 2 }, overview_metrics: [mean] },
    { kind: 'cluster_analysis', id: 'clusters_median', features, method_args: { n_clusters: 2 }, overview_metrics: [median] },
  ] });
  const r = await readDone(q.task_id, { detail: 'full' });
  assert.equal(r.status, 'done', JSON.stringify(r.error));
  const values = (id, name) => r.analyses[id].metrics.find((m) => m.metric === name)?.values;
  for (const [both, alone] of [['both', ''], ['clusters_both', 'clusters_']]) {
    assert.deepEqual(r.analyses[both].levels, r.analyses[`${alone}mean`].levels);
    assert.deepEqual(values(both, 'length_mean'), values(`${alone}mean`, 'length_mean'));
    assert.deepEqual(values(both, 'length_median'), values(`${alone}median`, 'length_median'));
    assert.ok(values(both, 'length_mean').length > 1);
  }
  // …and the platform sizes are the warehouse's users per platform, as for any overview
  const perPlatform = (await wh.query('select platform, count(distinct u.player_id_of_internal) as n from dim_users u join (select distinct player_id_of_internal from fct_analytics_events) e using (player_id_of_internal) group by platform')).rows;
  const size = values('both', 'segment_size');
  assert.deepEqual(Object.fromEntries(r.analyses.both.levels.map((l, i) => [l, size[i]])), Object.fromEntries(perPlatform.map((row) => [row.platform, Number(row.n)])));
});

test('the same call twice gives the same numbers, and a user sample keeps the same users on every build', opts, async (t) => {
  if (skip(t)) return;
  const again = await engine.query_retentioneering_model({ context_id: built.context_id, analyses: [{ kind: 'cluster_analysis', features: [{ metric: 'event_count_bulk' }], method_args: { n_clusters: [2, 3] }, overview_metrics: [{ metric: 'length', agg: 'mean' }] }, { kind: 'transition_graph' }] });
  const read = await readDone(again.task_id);
  assert.deepEqual(read.analyses.cluster_analysis, analyses.read.analyses.cluster_analysis);
  assert.deepEqual(read.analyses.transition_graph, analyses.read.analyses.transition_graph);
  const users = async () => {
    const b = await engine.build_retentioneering_model({ name: 'half', source: 'events', sample: { share: 0.5 } });
    const r = await readDone(b.task_id);
    return (await wh.query(`select distinct user_id from ${r.model} order by 1`)).rows.map((x) => x.user_id);
  };
  const first = await users();
  assert.ok(first.length > 0 && first.length < built.users, `a sample keeps some users, not all (${first.length})`);
  assert.deepEqual(await users(), first);
});

test('display draws one analysis once — the card model is built from the stored numbers', opts, async (t) => {
  if (skip(t)) return;
  const d = await engine.display_retentioneering_result({ task_id: analyses.task_id, analysis: 'funnel' });
  assert.equal(d.drawn, true);
  const vm = retentioneeringViewModel(d, { task_id: analyses.task_id, analysis: 'funnel' });
  assert.deepEqual(vm.steps.map((s) => s.value), analyses.read.analyses.funnel.steps.map((s) => s.unique_paths));
  assert.ok(toCallToolResult(d, 'display_retentioneering_result', {}, engine).structuredContent, 'a drawn card carries its structured result');
  await assert.rejects(engine.display_retentioneering_result({ task_id: analyses.task_id, analysis: 'funnel' }), /shown already/);
  // two calls at once for one analysis: one draws it, the other is refused — never two cards
  const both = await Promise.allSettled([0, 1].map(() => engine.display_retentioneering_result({ task_id: analyses.task_id, analysis: 'step_matrix' })));
  assert.deepEqual(both.map((b) => b.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(both.find((b) => b.status === 'fulfilled').value.drawn, true);
  assert.match(String(both.find((b) => b.status === 'rejected').reason?.message), /shown already/);
});

test('what cannot run is refused before anything starts', opts, async (t) => {
  if (skip(t)) return;
  const ctx = built.context_id;
  await assert.rejects(engine.build_retentioneering_model({ name: 'x', source: 'events', events: { include: ['levl_started'] } }), /invalid input.*level_started/);
  await assert.rejects(engine.query_retentioneering_model({ context_id: ctx, analyses: [{ kind: 'funnel', steps: ['first_launch', 'no_such_event'] }] }), (e) => e.field === 'analyses.steps');
  await assert.rejects(engine.query_retentioneering_model({ context_id: ctx, analyses: [{ kind: 'segment_overview', segment_col: 'country' }] }), (e) => e.field === 'analyses.segment_col');
  const half = await engine.build_retentioneering_model({ name: 'plain', source: 'events' });
  await readDone(half.task_id);
  await assert.rejects(engine.query_retentioneering_model({ context_id: half.context_id, analyses: [{ kind: 'transition_graph', path: 'sessions' }] }), (e) => e.field === 'analyses.path');
  // a task of another side is read by its own tool
  await assert.rejects(one(engine.query_pipeline_model({ task_ids: [analyses.task_id] })), /query_retentioneering_model/);
});

test('every event keeps its name unless a top N is asked for; the card carries its scope and path counts', opts, async (t) => {
  if (skip(t)) return;
  const counts = {};
  for (const r of rows) counts[r.e] = (counts[r.e] || 0) + 1;
  assert.ok(!built.vocabulary.some((v) => v.event === 'other'), 'no "other" by default');
  const top3 = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3);
  const b = await engine.build_retentioneering_model({ name: 'top3', source: 'events', events: { top: 3 } });
  const r = await readDone(b.task_id);
  const vocab = Object.fromEntries(r.vocabulary.map((v) => [v.event, v.events]));
  for (const [e, n] of top3) assert.equal(vocab[e], n);
  assert.equal(vocab.other, rows.length - top3.reduce((a, [, n]) => a + n, 0));
  // an analysis knows how many paths it read; the card, who and when
  assert.equal(analyses.read.analyses.funnel && (await full('funnel')).paths, built.users);
  const q = await engine.query_retentioneering_model({ context_id: built.context_id, analyses: [{ kind: 'funnel', steps: FUNNEL, path: 'sessions' }] });
  await readDone(q.task_id);
  const d = await engine.display_retentioneering_result({ task_id: q.task_id, analysis: 'funnel' });
  assert.equal(d.result.paths, built.sessions, 'per-session paths');
  assert.deepEqual({ users: d.scope.users, events: d.scope.events }, { users: built.users, events: rows.length });
});

/** Run one call and read it back in full (every record, not the summary). */
const runFull = async (input) => {
  const q = await engine.query_retentioneering_model({ context_id: built.context_id, ...input });
  const r = await readDone(q.task_id, { detail: 'full' });
  assert.equal(r.status, 'done', JSON.stringify(r.error));
  return { task_id: q.task_id, analyses: r.analyses };
};
const table = (result, name) => {
  const t = result.tables.find((x) => x.name === name);
  assert.ok(t, `a table '${name}' (has ${result.tables.map((x) => x.name).join(', ')})`);
  return t.rows.map((r) => Object.fromEntries(t.columns.map((c, i) => [c, r[i]])));
};

// ── an eventstream's steps: a draft the library checks as each step is added ─────────────────────

let stepsBuilt = null;
/** A context of its own for the step tests: one eventstream `base` (the users' paths, with platform). */
const stepsContext = async () => {
  if (!stepsBuilt) {
    const b = await engine.build_retentioneering_model({ name: 'base', source: 'events', segments: [{ model: 'users', attribute: 'platform' }] });
    stepsBuilt = await readDone(b.task_id);
    assert.equal(stepsBuilt.status, 'done', JSON.stringify(stepsBuilt.error));
  }
  return stepsBuilt.context_id;
};
/** A fork of `base` with these steps, materialized; its build's read. */
const shaped = async (name, steps) => {
  const ctx = await stepsContext();
  await engine.build_retentioneering_model({ action: 'fork', context_id: ctx, eventstream: 'base', name, after: 0 });
  const added = await engine.build_retentioneering_model({ action: 'add_steps', context_id: ctx, eventstream: name, steps });
  const m = await engine.build_retentioneering_model({ action: 'materialize', context_id: ctx, eventstream: name });
  const read = await readDone(m.task_id);
  assert.equal(read.status, 'done', JSON.stringify(read.error));
  return { ctx, added, read };
};
/** The analyses of one call over `eventstream`, read back. */
const analyze = async (ctx, eventstream, analyses, detail) => {
  const q = await engine.query_retentioneering_model({ context_id: ctx, eventstream, analyses });
  const r = await readDone(q.task_id, { ...(detail ? { detail } : {}) });
  assert.equal(r.status, 'done', JSON.stringify(r.error));
  return r.analyses;
};
/** Each user's event names in path order, collapsed runs of one event into one. */
const collapsed = (list) => list.map((r) => r.e).filter((e, i, all) => i === 0 || e !== all[i - 1]);

test('steps are the library\'s own op model: collapsed loops leave no self-transition, a path filter keeps the paths it names', opts, async (t) => {
  if (skip(t)) return;
  const { ctx } = await shaped('collapsed', [{ type: 'collapse_events', loops: true }]);
  const a = await analyze(ctx, 'collapsed', [{ kind: 'transition_graph' }], 'full');
  // the pairs of the paths once every run of one event is one event
  const expected = new Map();
  for (const list of paths().values()) {
    const seq = ['path_start', ...collapsed(list), 'path_end'];
    for (let i = 0; i + 1 < seq.length; i += 1) expected.set(`${seq[i]}>${seq[i + 1]}`, (expected.get(`${seq[i]}>${seq[i + 1]}`) || 0) + 1);
  }
  assert.deepEqual(new Map(a.transition_graph.edges.map((e) => [`${e.source}>${e.target}`, e.count])), expected);
  assert.ok(!a.transition_graph.edges.some((e) => e.source === e.target), 'no self-loops');
  // a fork of it with one more step: the collapsed paths longer than 5, the parent untouched
  await engine.build_retentioneering_model({ action: 'fork', context_id: ctx, eventstream: 'collapsed', name: 'long_paths' });
  await engine.build_retentioneering_model({ action: 'add_steps', context_id: ctx, eventstream: 'long_paths', steps: [{ type: 'filter_paths', condition: { op: '>', metric: 'length', value: 5 } }] });
  const m = await engine.build_retentioneering_model({ action: 'materialize', context_id: ctx, eventstream: 'long_paths' });
  const read = await readDone(m.task_id);
  const long = [...paths().values()].filter((list) => collapsed(list).length > 5).length;
  assert.equal(read.users, long, 'the materialized eventstream holds the paths the filter kept');
  const d = await analyze(ctx, 'long_paths', [{ kind: 'describe' }], 'full');
  assert.equal(d.describe.values['shape'].n_paths, long);
  const whole = await analyze(ctx, 'collapsed', [{ kind: 'describe' }], 'full');
  assert.equal(whole.describe.values['shape'].n_paths, built.users, 'the fork left its parent as it was');
});

test('filter_events takes a condition tree — what keep / drop cannot say — written as quoted SQL: its rows are the warehouse\'s own', opts, async (t) => {
  if (skip(t)) return;
  // a day boundary in the middle of the data, and the most frequent event left out by a negation
  const days = [...new Set(rows.map((r) => new Date(r.t).toISOString().slice(0, 10)))].sort();
  const from = days[Math.floor(days.length / 2)];
  const counts = new Map();
  for (const r of rows) counts.set(r.e, (counts.get(r.e) || 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
  const where = { op: 'and', conditions: [{ column: 'event_time', op: '>=', value: from }, { not: { column: 'event', op: 'in', value: [top] } }] };
  const { ctx } = await shaped('late_events', [{ type: 'filter_events', where }]);
  const a = await analyze(ctx, 'late_events', [{ kind: 'transition_graph' }], 'full');
  const want = new Map();
  for (const r of rows) if (new Date(r.t).toISOString().slice(0, 10) >= from && r.e !== top) want.set(r.e, (want.get(r.e) || 0) + 1);
  const got = new Map(a.transition_graph.nodes.filter((n) => n.event !== 'path_start' && n.event !== 'path_end').map((n) => [n.event, n.count]));
  assert.deepEqual(got, want);
  // a name that is not a column of the eventstream is the library's refusal, as the step is added
  await engine.build_retentioneering_model({ action: 'fork', context_id: ctx, eventstream: 'base', name: 'bad_where', after: 0 });
  await assert.rejects(engine.build_retentioneering_model({ action: 'add_steps', context_id: ctx, eventstream: 'bad_where', steps: [{ type: 'filter_events', where: { op: 'and', conditions: [{ column: 'no_such_col', op: '=', value: 'x' }] } }] }), (e) => e.field === 'steps[0]' && /no_such_col/.test(e.message));
});

test('an analysis the library raises on keeps its error; the call\'s other analyses keep their numbers', opts, async (t) => {
  if (skip(t)) return;
  // two events no path has in this order: a pattern of them matches nothing, which only the rows say
  const lists = [...paths().values()].map((l) => l.map((r) => r.e));
  const events = [...new Set(lists.flat())].sort();
  const follows = (a, b) => lists.some((l) => { const i = l.indexOf(a); return i >= 0 && l.slice(i + 1).includes(b); });
  const pair = events.flatMap((a) => events.map((b) => [a, b])).find(([a, b]) => a !== b && !follows(a, b));
  assert.ok(pair, 'the fixture has two events never in that order');
  const ctx = await stepsContext();
  const q = await engine.query_retentioneering_model({ context_id: ctx, eventstream: 'base', analyses: [{ kind: 'transition_graph' }, { kind: 'step_matrix', path_pattern: `${pair[0]}->.*->${pair[1]}` }] });
  const r = await readDone(q.task_id, { detail: 'full' });
  assert.equal(r.status, 'done', JSON.stringify(r.error));
  assert.equal(r.analyses.step_matrix.error.type, 'PatternNoMatchError');
  // the graph is computed all the same: its transitions are the pairs of the paths
  const pairs = lists.reduce((n, l) => n + l.length + 1, 0);
  assert.equal(r.analyses.transition_graph.edges.reduce((n, e) => n + e.count, 0), pairs);
  assert.notEqual(r.show_to_user?.arguments.request.analysis, 'step_matrix', 'the failed one is not offered as a card');
  await assert.rejects(engine.display_retentioneering_result({ task_id: q.task_id, analysis: 'step_matrix' }), (e) => e.field === 'analysis' && /PatternNoMatchError/.test(e.message));
  assert.ok(JSON.stringify(await engine.explore_errors({ task_id: q.task_id })).includes('PatternNoMatchError'), 'the failure is in the error log');
});

test('a where on a segment compares a number as a number, and a negation keeps the rows with no value — as the rows say', opts, async (t) => {
  if (skip(t)) return;
  const own = (await wh.query('select event_name as e, level_id_of_event_data as l from fct_analytics_events')).rows;
  const b = await engine.build_retentioneering_model({ name: 'levels', source: 'events', segments: [{ property: 'level_id_of_event_data', name: 'level' }] });
  const built = await readDone(b.task_id);
  assert.equal(built.status, 'done', JSON.stringify(built.error));
  const ctx = built.context_id;
  // the segment is stored as text; level 10 is above 5 as a number and below it as text
  assert.ok(own.some((x) => Number(x.l) >= 10), 'the fixture holds a level of two digits');
  const counted = async (name, where) => {
    await engine.build_retentioneering_model({ action: 'fork', context_id: ctx, eventstream: 'levels', name, after: 0 });
    await engine.build_retentioneering_model({ action: 'add_steps', context_id: ctx, eventstream: name, steps: [{ type: 'filter_events', where }] });
    const m = await engine.build_retentioneering_model({ action: 'materialize', context_id: ctx, eventstream: name });
    assert.equal((await readDone(m.task_id)).status, 'done');
    const a = await analyze(ctx, name, [{ kind: 'transition_graph' }], 'full');
    return new Map(a.transition_graph.nodes.filter((n) => n.event !== 'path_start' && n.event !== 'path_end').map((n) => [n.event, n.count]));
  };
  const tally = (list) => list.reduce((m, x) => m.set(x.e, (m.get(x.e) || 0) + 1), new Map());
  assert.deepEqual(await counted('above_5', { op: 'and', conditions: [{ column: 'level', op: '>', value: 5 }] }), tally(own.filter((x) => x.l != null && Number(x.l) > 5)));
  assert.deepEqual(await counted('not_level_1', { op: 'and', conditions: [{ not: { column: 'level', op: 'in', value: [1] } }] }), tally(own.filter((x) => x.l == null || Number(x.l) !== 1)));
  assert.deepEqual(await counted('level_not_1', { op: 'and', conditions: [{ column: 'level', op: '!=', value: 1 }] }), tally(own.filter((x) => x.l == null || Number(x.l) !== 1)));
});

test('a funnel\'s diff has a card: both groups on the same steps, each the funnel of that group alone, and their difference', opts, async (t) => {
  if (skip(t)) return;
  const ctx = await stepsContext();
  const platforms = (await wh.query('select distinct platform from dim_users order by 1')).rows.map((r) => String(r.platform));
  const [p1, p2] = platforms;
  const q = await engine.query_retentioneering_model({ context_id: ctx, eventstream: 'base', analyses: [{ kind: 'funnel', steps: FUNNEL, diff: ['platform', p1, p2] }] });
  const r = await readDone(q.task_id);
  assert.equal(r.status, 'done', JSON.stringify(r.error));
  assert.equal(r.show_to_user?.arguments.request.analysis, 'funnel', 'the diff is offered as a card');
  const d = await engine.display_retentioneering_result({ task_id: q.task_id, analysis: 'funnel' });
  const vm = retentioneeringViewModel(d, { task_id: q.task_id, analysis: 'funnel' });
  assert.equal(vm.kind, 'funnel_diff');
  assert.deepEqual([vm.groups.segment, vm.groups.first, vm.groups.second], ['platform', p1, p2]);
  // each group's steps are the funnel of that group alone
  const alone = async (p) => {
    const { ctx: c } = await shaped(`only_${p.replace(/[^a-z0-9]/gi, '_').toLowerCase()}`, [{ type: 'filter_events', where: { op: 'and', conditions: [{ column: 'platform', op: '=', value: p }] } }]);
    return (await analyze(c, `only_${p.replace(/[^a-z0-9]/gi, '_').toLowerCase()}`, [{ kind: 'funnel', steps: FUNNEL }])).funnel.steps.map((s) => s.unique_paths);
  };
  assert.deepEqual(vm.steps.map((s) => s.first.value), await alone(p1));
  assert.deepEqual(vm.steps.map((s) => s.second.value), await alone(p2));
  for (const s of vm.steps) assert.equal(s.delta.value, s.first.value - s.second.value);
  // the default read carries the same numbers: each step for both groups and their difference
  const sm = r.analyses.funnel;
  assert.deepEqual([sm.diff, sm.groups], [true, { segment: 'platform', first: p1, second: p2 }]);
  assert.deepEqual(sm.steps.map((s) => [s.first.unique_paths, s.second.unique_paths, s.difference.unique_paths]), vm.steps.map((s) => [s.first.value, s.second.value, s.delta.value]));
});

test('each step is checked by the library as it is added, and says what it changed — a refused one changes nothing', opts, async (t) => {
  if (skip(t)) return;
  const ctx = await stepsContext();
  await engine.build_retentioneering_model({ action: 'fork', context_id: ctx, eventstream: 'base', name: 'loop', after: 0 });
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
  assert.deepEqual(read.paths, ['user_id', 'visit']);
  // the numbers: a path per visit, as many as the table holds
  const visits = Number((await wh.query(`select count(distinct visit) as n from ${read.model}`)).rows[0].n);
  const d = await analyze(ctx, 'loop', [{ kind: 'path_metrics', metrics: [{ metric: 'length' }], path: 'visit' }], 'full');
  assert.equal(table(d.path_metrics, 'result').length, visits);
  // an edit at or before the materialized steps retires their table: the next materialize rebuilds
  const t1 = await engine.build_retentioneering_model({ action: 'truncate', context_id: ctx, eventstream: 'loop', after: 2 });
  assert.ok(t1.checkpoint_dropped);
  assert.equal(t1.materialized_through, 0);
});

test('metric bins: each bin holds the paths whose metric falls in it — by value, by quantile — and two bins of one name are refused in the call', opts, async (t) => {
  if (skip(t)) return;
  const lengths = [...paths().values()].map((list) => list.length);
  // pandas' linear quantile, which the library cuts at
  const sorted = [...lengths].sort((a, b) => a - b);
  const quantile = (q) => { const p = (sorted.length - 1) * q; const lo = Math.floor(p); return sorted[lo] + (sorted[Math.ceil(p)] - sorted[lo]) * (p - lo); };
  const median = quantile(0.5);
  const { ctx } = await shaped('bands', [
    // the bins in any order after the lowest: each keeps its own level
    { type: 'add_segment', name: 'length_band', metric_bins: { metric: { metric: 'length' }, bins: [{ level: 'short' }, { level: 'long', from: 10 }, { level: 'mid', from: 5 }] } },
    { type: 'add_segment', name: 'half', metric_bins: { metric: { metric: 'length' }, bins: [{ level: 'lower' }, { level: 'upper', from_quantile: 0.5 }] } },
  ]);
  const a = await analyze(ctx, 'bands', [
    { kind: 'segment_overview', id: 'by_value', segment_col: 'length_band', metrics: [{ metric: 'length', agg: 'mean' }] },
    { kind: 'segment_overview', id: 'by_quantile', segment_col: 'half', metrics: [{ metric: 'length', agg: 'mean' }] },
  ]);
  const sizes = (s) => Object.fromEntries(s.levels.map((l) => [l.name, l.size]));
  const count = (f) => lengths.filter(f).length;
  assert.deepEqual(sizes(a.by_value), Object.fromEntries(Object.entries({ short: count((n) => n < 5), mid: count((n) => n >= 5 && n < 10), long: count((n) => n >= 10) }).filter(([, n]) => n)));
  assert.deepEqual(sizes(a.by_quantile), Object.fromEntries(Object.entries({ lower: count((n) => n < median), upper: count((n) => n >= median) }).filter(([, n]) => n)));
  const bins = (list) => engine.build_retentioneering_model({ action: 'add_steps', context_id: ctx, eventstream: 'bands', steps: [{ type: 'add_segment', name: 'x', metric_bins: { metric: { metric: 'length' }, bins: list } }] });
  await assert.rejects(bins([{ level: 'a' }, { level: 'a', from: 3 }]), (e) => e.field === 'steps[0].metric_bins' && /two bins are named 'a'/.test(e.message));
  await assert.rejects(bins([{ level: 'a' }, { level: 'b', from: 3 }, { level: 'c', from: 3 }]), (e) => e.field === 'steps[0].metric_bins' && /two bins start/.test(e.message));
});

test('rules are cases the tool writes: each path gets the level of the first case its row matches, the rest the else level', opts, async (t) => {
  if (skip(t)) return;
  const perPlatform = (await wh.query('select platform, count(distinct u.player_id_of_internal) as n from dim_users u join (select distinct player_id_of_internal from fct_analytics_events) e using (player_id_of_internal) group by platform order by platform')).rows;
  const [first] = perPlatform;
  const { ctx, read } = await shaped('stores', [{ type: 'add_segment', name: 'store', rules: { cases: [{ column: 'platform', op: 'in', value: [first.platform, "it's not a level"], level: 'first_store' }], else: 'other_store' } }]);
  const rest = perPlatform.slice(1).reduce((n, r) => n + Number(r.n), 0);
  const want = Object.fromEntries(Object.entries({ first_store: Number(first.n), other_store: rest }).filter(([, n]) => n));
  // the materialized eventstream knows the levels the step made, with their users
  assert.deepEqual(Object.fromEntries(read.segment_levels.store.levels.map((l) => [l.level, l.users])), want);
  const a = await analyze(ctx, 'stores', [{ kind: 'segment_overview', segment_col: 'store', metrics: [{ metric: 'length', agg: 'mean' }] }]);
  assert.deepEqual(Object.fromEntries(a.segment_overview.levels.map((l) => [l.name, l.size])), want);
});

test('a later start of the same name makes a table of its own: a fork of the earlier eventstream keeps reading its rows', opts, async (t) => {
  if (skip(t)) return;
  const ctx = await stepsContext();
  const first = await readDone((await engine.build_retentioneering_model({ context_id: ctx, name: 'origin', source: 'events' })).task_id);
  await engine.build_retentioneering_model({ action: 'fork', context_id: ctx, eventstream: 'origin', name: 'origin_copy' });
  const again = await one(engine.query_retentioneering_model({ task_ids: [(await engine.build_retentioneering_model({ context_id: ctx, name: 'origin', source: 'events', events: { include: ['tutorial'] } })).task_id] }));
  assert.notEqual(again.model, first.model);
  assert.deepEqual(again.vocabulary.map((v) => v.event), ['tutorial']);
  // the fork reads the rows it was made from, and the first build's task still says them
  const graph = await analyze(ctx, 'origin_copy', [{ kind: 'transition_graph' }], 'full');
  assert.deepEqual(graph.transition_graph.nodes.map((n) => n.event).filter((e) => !['path_start', 'path_end'].includes(e)).sort(), first.vocabulary.map((v) => v.event).sort());
  const reread = await readDone(first.task_id);
  assert.equal(reread.events, first.events);
});

test('steps asked for at once are applied one after the other: none is lost', opts, async (t) => {
  if (skip(t)) return;
  const ctx = await stepsContext();
  await engine.build_retentioneering_model({ action: 'fork', context_id: ctx, eventstream: 'base', name: 'parallel', after: 0 });
  const steps = [{ type: 'rename_events', mapping: { shop_opened: 'shop' } }, { type: 'drop_events', names: ['tutorial'] }, { type: 'collapse_events', loops: true }];
  const answers = await Promise.all(steps.map((step) => engine.build_retentioneering_model({ action: 'add_steps', context_id: ctx, eventstream: 'parallel', steps: [step] })));
  assert.deepEqual(answers.map((a) => a.steps).sort(), [1, 2, 3]);
  const p = await engine.build_retentioneering_model({ action: 'preview', context_id: ctx, eventstream: 'parallel' });
  assert.deepEqual(p.steps.map((x) => x.step.type).sort(), steps.map((x) => x.type).sort());
  assert.ok(p.steps.every((x) => x.checked));
  // and the numbers are those of all three
  const m = await engine.build_retentioneering_model({ action: 'materialize', context_id: ctx, eventstream: 'parallel' });
  const read = await readDone(m.task_id);
  const names = read.vocabulary.map((v) => v.event);
  assert.ok(names.includes('shop') && !names.includes('shop_opened') && !names.includes('tutorial'));
});

test('a column a step makes is an identifier the warehouse stores; a segment named for a keyword is carried', opts, async (t) => {
  if (skip(t)) return;
  const ctx = await stepsContext();
  const segmentNamed = (name) => engine.build_retentioneering_model({ action: 'add_steps', context_id: ctx, eventstream: 'base', steps: [{ type: 'add_segment', name, rules: { cases: [{ column: 'platform', op: '=', value: 'ios', level: 'x' }], else: 'y' } }] });
  await assert.rejects(segmentNamed('ad format'), (e) => e.field === 'steps[0]' && /'ad format' cannot be a column/.test(e.message) && /nothing changed/.test(e.message));
  await assert.rejects(segmentNamed('seg\n'), (e) => e.field === 'steps[0]' && /cannot be a column/.test(e.message));
  // nor a name the stored eventstream uses for what it carries besides
  await assert.rejects(segmentNamed('event_order'), (e) => e.field === 'steps[0]' && /uses that name itself/.test(e.message));
  // `group` is a keyword in both warehouses: quoted wherever the eventstream and its summary name it
  const b = await engine.build_retentioneering_model({ context_id: ctx, name: 'keyworded', source: 'events', segments: [{ model: 'users', attribute: 'platform', name: 'group' }] });
  const read = await readDone(b.task_id);
  assert.equal(read.status, 'done', JSON.stringify(read.error));
  const perPlatform = (await wh.query('select platform, count(distinct u.player_id_of_internal) as n from dim_users u join (select distinct player_id_of_internal from fct_analytics_events) e using (player_id_of_internal) group by platform')).rows;
  assert.deepEqual(Object.fromEntries(read.segment_levels.group.levels.map((l) => [l.level, l.users])), Object.fromEntries(perPlatform.map((r) => [String(r.platform), Number(r.n)])));
  const a = await analyze(ctx, 'keyworded', [{ kind: 'segment_overview', segment_col: 'group', metrics: [{ metric: 'length', agg: 'mean' }] }]);
  assert.deepEqual(Object.fromEntries(a.segment_overview.levels.map((l) => [l.name, l.size])), Object.fromEntries(perPlatform.map((r) => [String(r.platform), Number(r.n)])));
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

test('a card speaks of the rows its analysis read, whatever the eventstream became after', opts, async (t) => {
  if (skip(t)) return;
  const { ctx, read: before } = await shaped('scoped', [{ type: 'collapse_events', loops: true }]);
  const q = await engine.query_retentioneering_model({ context_id: ctx, eventstream: 'scoped', analyses: [{ kind: 'transition_graph' }] });
  await readDone(q.task_id);
  // the eventstream moves on: fewer paths
  await engine.build_retentioneering_model({ action: 'add_steps', context_id: ctx, eventstream: 'scoped', steps: [{ type: 'filter_paths', condition: { op: '>', metric: 'length', value: 5 } }] });
  const after = await readDone((await engine.build_retentioneering_model({ action: 'materialize', context_id: ctx, eventstream: 'scoped' })).task_id);
  assert.ok(after.users < before.users);
  const d = await engine.display_retentioneering_result({ task_id: q.task_id, analysis: 'transition_graph' });
  assert.deepEqual([d.scope.users, d.scope.events], [before.users, before.events]);
});

test('a materialize that ends while a step is being edited never leaves a table standing for the old steps', opts, async (t) => {
  if (skip(t)) return;
  const ctx = await stepsContext();
  await engine.build_retentioneering_model({ action: 'fork', context_id: ctx, eventstream: 'base', name: 'racing', after: 0 });
  await engine.build_retentioneering_model({ action: 'add_steps', context_id: ctx, eventstream: 'racing', steps: [{ type: 'collapse_events', loops: true }, { type: 'drop_events', names: ['tutorial'] }] });
  const m = await engine.build_retentioneering_model({ action: 'materialize', context_id: ctx, eventstream: 'racing' });
  // the edit is made while the materialize runs; whichever ends first, the other sees it
  await engine.build_retentioneering_model({ action: 'edit_step', context_id: ctx, eventstream: 'racing', index: 2, step: { type: 'drop_events', names: ['shop_opened'] } });
  await readDone(m.task_id);
  const p = await engine.build_retentioneering_model({ action: 'preview', context_id: ctx, eventstream: 'racing' });
  assert.equal(p.materialized_through, 0, 'the table of the old steps does not stand for the edited ones');
  await assert.rejects(engine.query_retentioneering_model({ context_id: ctx, eventstream: 'racing', analyses: [{ kind: 'describe' }] }), (e) => e.field === 'eventstream' && /materialize/.test(e.message));
  // materialized again, the table holds the edited steps' events
  const again = await readDone((await engine.build_retentioneering_model({ action: 'materialize', context_id: ctx, eventstream: 'racing' })).task_id);
  const names = again.vocabulary.map((v) => v.event);
  assert.ok(names.includes('tutorial') && !names.includes('shop_opened'));
});

test('a draw that does not happen leaves no mark', opts, async (t) => {
  if (skip(t)) return;
  const q = await engine.query_retentioneering_model({ context_id: built.context_id, eventstream: 'paths', analyses: [{ kind: 'path_metrics', metrics: [{ metric: 'length' }] }, { kind: 'conversion_rate', start_anchor: 'level_started', end_anchor: 'level_completed' }] });
  await readDone(q.task_id);
  const ctx = engine.ctxs.get(built.context_id);
  // an analysis without a card is refused, and the refusal leaves nothing behind: no mark, nothing held
  await assert.rejects(engine.display_retentioneering_result({ task_id: q.task_id, analysis: 'conversion_rate' }), /no card/);
  assert.ok(!ctx.state.retentioneering.drawn?.[q.task_id]?.includes('conversion_rate'));
  await assert.rejects(engine.display_retentioneering_result({ task_id: q.task_id, analysis: 'conversion_rate' }), /no card/, 'refused for what it is, not as shown already');
});

test('a task whose context is gone is refused as gone, and a preview is not held behind a step waiting for a build', opts, async (t) => {
  if (skip(t)) return;
  const b = await engine.build_retentioneering_model({ name: 'short_lived', source: 'events', events: { include: ['tutorial', 'level_started'] } });
  await readDone(b.task_id);
  const q = await engine.query_retentioneering_model({ context_id: b.context_id, eventstream: 'short_lived', analyses: [{ kind: 'transition_graph' }] });
  await readDone(q.task_id);
  // a start in the same context, and a step on it that waits for that build — while a preview of the
  // first eventstream answers at once
  await engine.build_retentioneering_model({ context_id: b.context_id, name: 'second', source: 'events' });
  const order = [];
  const stepping = engine.build_retentioneering_model({ action: 'add_steps', context_id: b.context_id, eventstream: 'second', steps: [{ type: 'collapse_events', loops: true }] }).then(() => order.push('step'));
  await engine.build_retentioneering_model({ action: 'preview', context_id: b.context_id, eventstream: 'short_lived' }).then(() => order.push('preview'));
  await stepping;
  assert.deepEqual(order, ['preview', 'step']);
  await engine.delete_context({ context_id: b.context_id, force: true });
  await assert.rejects(engine.display_retentioneering_result({ task_id: q.task_id, analysis: 'transition_graph' }), (e) => e.code === 'result_gone' && e.stage === 'validate');
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
  const perPlatform = (await wh.query('select platform, count(distinct u.player_id_of_internal) as n from dim_users u join (select distinct player_id_of_internal from fct_analytics_events) e using (player_id_of_internal) group by platform')).rows;
  assert.deepEqual(Object.fromEntries(built.segment_levels.platform.levels.map((l) => [l.level, l.users])), Object.fromEntries(perPlatform.map((r) => [String(r.platform), Number(r.n)])));
});

test('a condition on a time metric compares seconds since the epoch: the paths that started before a moment', opts, async (t) => {
  if (skip(t)) return;
  const firsts = (await wh.query('select epoch(min(device_time)) as s from fct_analytics_events group by player_id_of_internal order by 1')).rows.map((r) => Number(r.s));
  const moment = firsts[Math.floor(firsts.length / 2)];
  const { read } = await shaped('early', [{ type: 'filter_paths', condition: { op: '<', metric: 'first_event_time', value: moment } }]);
  assert.equal(read.users, firsts.filter((s) => s < moment).length);
});

test('conversion rate and path metrics are the library\'s tables, and their numbers are the rows\'', opts, async (t) => {
  if (skip(t)) return;
  const { task_id, analyses: a } = await runFull({
    analyses: [
      { kind: 'conversion_rate', start_anchor: 'level_started', end_anchor: 'level_completed' },
      { kind: 'path_metrics', metrics: [{ metric: 'length' }, { metric: 'has_event', metric_args: { event: 'shop_opened' } }] },
    ],
  });
  let withStart = 0; let converted = 0;
  for (const list of paths().values()) {
    const seq = list.map((r) => r.e);
    const at = seq.indexOf('level_started');
    if (at < 0) continue;
    withStart += 1;
    if (seq.slice(at + 1).includes('level_completed')) converted += 1;
  }
  const [row] = table(a.conversion_rate, 'result');
  assert.deepEqual({ paths_with_start: row.paths_with_start, converted: row.converted }, { paths_with_start: withStart, converted });
  // neither has a card: none is offered, and one asked for is refused — the numbers are in the read
  assert.equal((await readDone(task_id)).show_to_user, undefined);
  await assert.rejects(engine.display_retentioneering_result({ task_id, analysis: 'conversion_rate' }), (e) => e.field === 'analysis' && /no card/.test(e.message));
  const metrics = table(a.path_metrics, 'result');
  assert.equal(metrics.length, built.users, 'one row per path, all of them');
  for (const [u, list] of paths()) {
    const m = metrics.find((x) => String(x.user_id) === String(u));
    assert.equal(m.length, list.length, `length of ${u}`);
    assert.equal(m.has_event_shop_opened, list.some((r) => r.e === 'shop_opened') ? 1 : 0, `shop_opened of ${u}`);
  }
});

test('diff: the same analysis for two segment levels and their difference — drawn as tables, the difference on a diverging scale', opts, async (t) => {
  if (skip(t)) return;
  const platforms = (await wh.query('select distinct platform from dim_users where platform is not null order by 1')).rows.map((r) => r.platform);
  const [p1, p2] = platforms;
  const { task_id, analyses: a } = await runFull({ analyses: [{ kind: 'transition_graph', edge_weight: 'count', diff: ['platform', p1, p2] }] });
  const platformOf = new Map((await wh.query('select player_id_of_internal as u, platform from dim_users')).rows.map((r) => [String(r.u), r.platform]));
  const pairs = (platform) => {
    const m = new Map();
    for (const [u, list] of paths()) {
      if (platformOf.get(String(u)) !== platform) continue;
      const seq = ['path_start', ...list.map((r) => r.e), 'path_end'];
      for (let i = 0; i + 1 < seq.length; i += 1) m.set(`${seq[i]}>${seq[i + 1]}`, (m.get(`${seq[i]}>${seq[i + 1]}`) || 0) + 1);
    }
    return m;
  };
  const cells = (name) => {
    const tb = a.transition_graph.tables.find((x) => x.name === name);
    const out = new Map();
    for (const row of tb.rows) tb.columns.slice(1).forEach((target, j) => { if (row[j + 1]) out.set(`${row[0]}>${target}`, row[j + 1]); });
    return out;
  };
  assert.deepEqual(cells('first'), pairs(p1));
  assert.deepEqual(cells('second'), pairs(p2));
  const first = pairs(p1); const second = pairs(p2);
  const diff = new Map([...new Set([...first.keys(), ...second.keys()])].map((k) => [k, (first.get(k) || 0) - (second.get(k) || 0)]).filter(([, v]) => v !== 0));
  assert.deepEqual(cells('diff'), diff);
  const d = await engine.display_retentioneering_result({ task_id, analysis: 'transition_graph' });
  const vm = retentioneeringViewModel(d, {});
  assert.equal(vm.kind, 'diff');
  assert.deepEqual(vm.tables.map((x) => [x.role, x.diverging]), [['diff', true], ['first', false], ['second', false]]);
});

test('a diff around an anchor is drawn block by block: each difference is its first group minus its second', opts, async (t) => {
  if (skip(t)) return;
  const [p1, p2] = (await wh.query('select distinct platform from dim_users where platform is not null order by 1')).rows.map((r) => r.platform);
  const { task_id, analyses: a } = await runFull({
    analyses: [
      { kind: 'step_matrix', max_steps: 3, diff: ['platform', p1, p2], path_pattern: 'tutorial->.*->level_completed' },
    ],
  });
  const m = a.step_matrix;
  assert.equal(m.diff, true);
  const blocks = [...new Set(m.tables.filter((x) => x.role === 'diff').map((x) => x.block))];
  assert.ok(blocks.length >= 1, 'a block per anchor of the pattern');
  for (const b of blocks) {
    const part = (role) => m.tables.find((x) => x.role === role && x.block === b);
    const value = (tb, row, j) => tb.rows.find((r) => r[0] === row)?.[j] ?? 0;
    const [diff, first, second] = ['diff', 'first', 'second'].map(part);
    for (const row of diff.rows) diff.columns.slice(1).forEach((_, k) => {
      assert.ok(Math.abs(row[k + 1] - (value(first, row[0], k + 1) - value(second, row[0], k + 1))) < 1e-9, `block ${b} ${row[0]} step ${diff.columns[k + 1]}`);
    });
  }
  const read = await readDone(task_id);
  assert.equal(read.show_to_user?.arguments.request.analysis, 'step_matrix', 'the anchored diff is offered as a card');
  const d = await engine.display_retentioneering_result({ task_id, analysis: 'step_matrix' });
  const vm = retentioneeringViewModel(d, {});
  assert.equal(vm.kind, 'diff');
  assert.equal(vm.tables.filter((x) => x.diverging).length, blocks.length);
});

test('a read is a summary by default and every record with detail: "full"', opts, async (t) => {
  if (skip(t)) return;
  const q = await engine.query_retentioneering_model({ context_id: built.context_id, analyses: [{ kind: 'path_metrics', metrics: [{ metric: 'length' }] }] });
  const summary = await readDone(q.task_id);
  const [tb] = summary.analyses.path_metrics.tables;
  assert.equal(tb.total_rows, built.users);
  // the first rows the read kept (7 in this suite), up to the 20 a summary shows
  assert.equal(tb.rows.length, Math.min(built.users, 20, 7));
  const all = await readDone(q.task_id, { detail: 'full' });
  assert.equal(all.analyses.path_metrics.tables[0].rows.length, built.users);
});

test('a distribution comparison is drawn as one histogram: each level\'s bins hold its paths', opts, async (t) => {
  if (skip(t)) return;
  const platformOf = new Map((await wh.query('select player_id_of_internal as u, platform from dim_users')).rows.map((r) => [String(r.u), r.platform]));
  const [p1, p2] = [...new Set([...paths().keys()].map((u) => platformOf.get(String(u))))].filter(Boolean).sort();
  const { task_id } = await runFull({ analyses: [{ kind: 'metric_distribution', segment_col: 'platform', metric: { metric: 'length' }, segment_levels: [p1, p2] }] });
  const d = await engine.display_retentioneering_result({ task_id, analysis: 'metric_distribution' });
  const vm = retentioneeringViewModel(d, {});
  assert.equal(vm.kind, 'distribution');
  assert.equal(vm.histograms.length, 1, 'two levels on the same bins: one comparison');
  const [h] = vm.histograms;
  assert.equal(h.series.length, 2);
  const lengths = (platform) => [...paths()].filter(([u]) => platformOf.get(String(u)) === platform).map(([, list]) => list.length);
  for (const [k, platform] of [[0, p1], [1, p2]]) {
    const ls = lengths(platform);
    assert.equal(h.series[k].values.reduce((a, b) => a + b, 0), ls.length, `${platform}: every path in a bin`);
    // each path counted in the bin its length falls in
    const { edges } = h;
    const expected = edges.slice(1).map((hi, i) => ls.filter((x) => x >= edges[i] && (x < hi || (i === edges.length - 2 && x <= hi))).length);
    assert.deepEqual(h.series[k].values, expected, platform);
  }
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
  const byLevel = (rows, key) => rows.reduce((m, x) => m.set(String(x[key] ?? ''), (m.get(String(x[key] ?? '')) || 0) + Number(x.n ?? 1)), new Map());
  assert.deepEqual(byLevel(es, 'level'), byLevel(kept.map((x) => ({ level: x.l })), 'level'), 'the property carried as a segment, value by value');
  // a column the table does not have is refused before anything runs, with the ones it has
  await assert.rejects(engine.build_retentioneering_model({ name: 'x', source: 'events', where: [{ column: 'no_such', op: 'eq', value: 1 }] }), (e) => e.field === 'where.column' && /bundle_id/.test(e.message));
});

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
  // by conditions: the first case that holds; the rest take `else`
  const c = await engine.build_retentioneering_model({
    name: 'by_case', source: 'events',
    events: { split: [{ event: 'level_completed', cases: [{ name: 'level_lost', where: [{ property: 'result_of_event_data', op: 'eq', value: 'lose' }] }], else: 'level_passed' }] },
  });
  const rc = await readDone(c.task_id);
  const lost = src.filter((x) => x.e === 'level_completed' && x.r === 'lose').length;
  const vocab = new Map(rc.vocabulary.map((v) => [v.event, v.events]));
  assert.deepEqual([vocab.get('level_lost'), vocab.get('level_passed'), vocab.get('level_completed')], [lost, src.filter((x) => x.e === 'level_completed').length - lost, undefined]);
  // the new names are what an analysis reads
  const q = await engine.query_retentioneering_model({ context_id: rc.context_id, eventstream: 'by_case', analyses: [{ kind: 'transition_graph' }] });
  const g = await readDone(q.task_id, { detail: 'full' });
  const nodes = new Map(g.analyses.transition_graph.nodes.map((n) => [n.event, n.count]));
  assert.equal(nodes.get('level_lost'), lost);
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
  await assert.rejects(engine.build_retentioneering_model({ name: 'x', source: 'events', events: { split: [{ event: 'level_completed', cases: [{ name: 'level_lost', where: [{ property: 'result_of_event_data', op: 'eq', value: 'lose' }] }] }], groups: { g: ['level_lostt'] } } }), (e) => e.field === 'events.groups.g');
});

test('a sample of an event keeps a share of its rows, the same rows on every build, and every other event whole', opts, async (t) => {
  if (skip(t)) return;
  const src = (await wh.query('select event_name as e from fct_analytics_events')).rows;
  const total = (name) => src.filter((x) => x.e === name).length;
  const build = async (name) => {
    const b = await engine.build_retentioneering_model({ name, source: 'events', sample: { events: { level_started: 0.5, first_launch: 1 } } });
    const r = await readDone(b.task_id);
    assert.equal(r.status, 'done', JSON.stringify(r.error));
    return r;
  };
  const [a, b] = [await build('ev_sample_a'), await build('ev_sample_b')];
  const vocab = (r) => new Map(r.vocabulary.map((v) => [v.event, v.events]));
  const kept = vocab(a).get('level_started');
  assert.ok(kept > 0 && kept < total('level_started'), `a share of level_started is kept (${kept} of ${total('level_started')})`);
  assert.equal(vocab(b).get('level_started'), kept, 'the same rows on a second build');
  for (const [e, n] of vocab(a)) if (e !== 'level_started') assert.equal(n, total(e), `${e} is whole`);
  assert.equal(a.events, src.length - total('level_started') + kept);
  assert.deepEqual(a.sample.events, { level_started: 0.5 }, 'the summary says what was sampled (a share of 1 is no sample)');
  // an event the source does not have is refused before anything runs
  await assert.rejects(engine.build_retentioneering_model({ name: 'x', source: 'events', sample: { events: { no_such_event: 0.5 } } }), /no_such_event|invalid input/);
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

// A FROM-TASK eventstream: an event only a window can define — a level started again right after a
// start (the previous event of the same player is also a start) — made in a pipeline, and read by the
// path analysis from that build's stored table, the columns named by the caller.
test('an eventstream from a pipeline build: events a window defined, the table\'s columns as path, event, time and segment', opts, async (t) => {
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
  assert.ok(expected.get('level_restarted') > 0, 'the fixture has restarts to find');
  const p = await engine.build_pipeline_model({ action: 'start', name: 'restarts', source: 'events' });
  await engine.build_pipeline_model({ action: 'add_steps', context_id: p.context_id, stages: [
    { stage: 'compute', name: 'prev', expr: { fn: 'lag', args: [{ column: 'event_name' }], over: { partition_by: ['player_id_of_internal'], order_by: [{ key: 'device_time' }, { key: 'event_id' }] } } },
    { stage: 'compute', name: 'ev', expr: { fn: 'case', cases: [{ when: [{ column: 'event_name', op: 'eq', value: 'level_started' }, { column: 'prev', op: 'eq', value: 'level_started' }], then: { value: 'level_restarted' } }], else: { column: 'event_name' }, type: 'string' } },
    { stage: 'project', columns: ['player_id_of_internal', 'ev', 'device_time', 'bundle_id'] },
  ] });
  const m = await engine.build_pipeline_model({ action: 'materialize', context_id: p.context_id });
  const built = await one(engine.query_pipeline_model({ task_ids: [m.task_id] }));
  assert.equal(built.status, 'done', JSON.stringify(built.error));
  const b = await engine.build_retentioneering_model({ name: 'from_pipe', from_task: m.task_id, columns: { path: 'player_id_of_internal', event: 'ev', time: 'device_time' }, segments: [{ column: 'bundle_id', name: 'app' }] });
  const r = await readDone(b.task_id);
  assert.equal(r.status, 'done', JSON.stringify(r.error));
  assert.deepEqual(new Map(r.vocabulary.map((v) => [v.event, v.events])), expected);
  assert.equal(r.users, byUser.size);
  // the analyses read it like any eventstream
  const q = await engine.query_retentioneering_model({ context_id: r.context_id, eventstream: 'from_pipe', analyses: [{ kind: 'transition_graph' }] });
  const g = await readDone(q.task_id, { detail: 'full' });
  assert.equal(new Map(g.analyses.transition_graph.nodes.map((n) => [n.event, n.count])).get('level_restarted'), expected.get('level_restarted'));
  // what the table cannot say is refused before anything runs, with where it belongs
  await assert.rejects(engine.build_retentioneering_model({ name: 'x', from_task: m.task_id, columns: { path: 'player_id_of_internal', event: 'ev', time: 'device_time' }, where: [{ property: 'result_of_event_data', op: 'eq', value: 'win' }] }), (e) => e.field === 'where.property' && /pipeline/.test(e.message));
  await assert.rejects(engine.build_retentioneering_model({ name: 'x', from_task: m.task_id, columns: { path: 'no_such', event: 'ev', time: 'device_time' } }), (e) => e.field === 'columns.path' && /ev/.test(e.message));
});

// A PATH that is not the user: one path per value of a column, of a composite key, or of an event property.
test('a path by a column, by a composite key and by an event property: one path per value, events without it left out', opts, async (t) => {
  if (skip(t)) return;
  const src = (await wh.query('select player_id_of_internal as u, session_number as s, level_id_of_event_data as l from fct_analytics_events')).rows;
  const distinct = (f) => new Set(src.filter((x) => f(x) != null && !String(f(x)).includes('null')).map(f)).size;
  const read = async (name, path) => {
    const b = await engine.build_retentioneering_model({ name, source: 'events', path });
    const r = await readDone(b.task_id);
    assert.equal(r.status, 'done', JSON.stringify(r.error));
    return r;
  };
  const bySession = await read('by_session_number', [{ column: 'session_number' }]);
  assert.equal(bySession.users, distinct((x) => x.s));
  assert.deepEqual(bySession.path, ['session_number']);
  const composite = await read('by_player_session', [{ column: 'player_id_of_internal' }, { column: 'session_number' }]);
  assert.equal(composite.users, distinct((x) => (x.u == null || x.s == null ? null : `${x.u}|${x.s}`)));
  const byLevel = await read('by_level', [{ property: 'level_id_of_event_data' }]);
  assert.equal(byLevel.users, distinct((x) => x.l));
  assert.equal(byLevel.events, src.filter((x) => x.l != null).length, 'events without the key are left out');
  // between: both ends included
  const b = await engine.build_retentioneering_model({ name: 'sessions_1_2', source: 'events', where: [{ column: 'session_number', op: 'between', value: [1, 2] }] });
  const r = await readDone(b.task_id);
  assert.equal(r.events, src.filter((x) => x.s >= 1 && x.s <= 2).length);
  await assert.rejects(engine.build_retentioneering_model({ name: 'x', source: 'events', path: [{ column: 'no_such' }] }), (e) => e.field === 'path');
});

// The task of a draft's SECOND build: that table reads the draft's first build (its checkpoint)
// through a ref — the eventstream and a new pipeline started from it compile only when the models it
// depends on come along with it.
test('from the task of a draft\'s rebuild: the eventstream and a pipeline started from it find the table it builds on', opts, async (t) => {
  if (skip(t)) return;
  const n = Number((await wh.query("select count(*) as n from fct_analytics_events where event_name <> 'first_launch'")).rows[0].n);
  const p = await engine.build_pipeline_model({ action: 'start', name: 'two_builds', source: 'events' });
  await engine.build_pipeline_model({ action: 'add_steps', context_id: p.context_id, stages: [{ stage: 'where', conditions: [{ column: 'event_name', op: 'neq', value: 'first_launch' }] }] });
  const first = await engine.build_pipeline_model({ action: 'materialize', context_id: p.context_id });
  assert.equal((await one(engine.query_pipeline_model({ task_ids: [first.task_id] }))).status, 'done');
  await engine.build_pipeline_model({ action: 'add_steps', context_id: p.context_id, stages: [{ stage: 'project', columns: ['player_id_of_internal', 'event_name', 'device_time'] }] });
  const second = await engine.build_pipeline_model({ action: 'materialize', context_id: p.context_id });
  const built = await one(engine.query_pipeline_model({ task_ids: [second.task_id] }));
  assert.equal(built.status, 'done', JSON.stringify(built.error));
  const b = await engine.build_retentioneering_model({ name: 'from_rebuild', from_task: second.task_id, columns: { path: 'player_id_of_internal', event: 'event_name', time: 'device_time' } });
  const r = await readDone(b.task_id);
  assert.equal(r.status, 'done', JSON.stringify(r.error));
  assert.equal(r.events, n);
  const q = await engine.build_pipeline_model({ action: 'start', name: 'on_rebuild', from_task: second.task_id, source: 'events' });
  await engine.build_pipeline_model({ action: 'add_steps', context_id: q.context_id, stages: [{ stage: 'aggregate', measures: [{ name: 'n', agg: 'count' }] }] });
  const m = await engine.build_pipeline_model({ action: 'materialize', context_id: q.context_id });
  const rows = await one(engine.query_pipeline_model({ task_ids: [m.task_id] }));
  assert.equal(rows.status, 'done', JSON.stringify(rows.error));
  assert.equal(Number(rows.rows[0].n), n);
});
