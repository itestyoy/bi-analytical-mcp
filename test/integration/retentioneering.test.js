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
import { settle } from '../helpers/settle.js';
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
    features: [createRetentioneeringFeature({ runner })], featureStatus: [{ id: 'retentioneering', available: true }],
  }));
  // the rows every expectation below is counted from: each event, its user, its time — in path order
  rows = (await wh.query('select player_id_of_internal as u, event_name as e, device_time as t from fct_analytics_events order by 1, 3, 2')).rows;
  const b = await engine.build_retentioneering_model({ name: 'paths', source: 'events', segments: [{ model: 'users', attribute: 'platform' }], sessions: { gap_minutes: 30 } });
  built = await engine.query_retentioneering_model({ task_id: b.task_id });
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
  analyses = { task_id: q.task_id, read: await engine.query_retentioneering_model({ task_id: q.task_id }) };
}, opts);
after(async () => { try { engine?.close(); } catch { /* noop */ } if (wh) await wh.stop(); });

/** Each user's events in time order (ties by name, as the eventstream orders them). */
const paths = () => {
  const by = new Map();
  for (const r of rows) (by.get(r.u) || by.set(r.u, []).get(r.u)).push(r);
  for (const list of by.values()) list.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : a.e.localeCompare(b.e)));
  return by;
};
/** One analysis of the task in full — every cell the card draws, not the summary the model reads. */
const full = async (id) => engine._taskResults.get(analyses.task_id).out.analyses[id];

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
});

test('the same call twice gives the same numbers, and a user sample keeps the same users on every build', opts, async (t) => {
  if (skip(t)) return;
  const again = await engine.query_retentioneering_model({ context_id: built.context_id, analyses: [{ kind: 'cluster_analysis', features: [{ metric: 'event_count_bulk' }], method_args: { n_clusters: [2, 3] }, overview_metrics: [{ metric: 'length', agg: 'mean' }] }, { kind: 'transition_graph' }] });
  const read = await engine.query_retentioneering_model({ task_id: again.task_id });
  assert.deepEqual(read.analyses.cluster_analysis, analyses.read.analyses.cluster_analysis);
  assert.deepEqual(read.analyses.transition_graph, analyses.read.analyses.transition_graph);
  const users = async () => {
    const b = await engine.build_retentioneering_model({ name: 'half', source: 'events', sample: { share: 0.5 } });
    const r = await engine.query_retentioneering_model({ task_id: b.task_id });
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
});

test('what cannot run is refused before anything starts', opts, async (t) => {
  if (skip(t)) return;
  const ctx = built.context_id;
  await assert.rejects(engine.build_retentioneering_model({ name: 'x', source: 'events', events: { include: ['levl_started'] } }), /invalid input.*level_started/);
  await assert.rejects(engine.query_retentioneering_model({ context_id: ctx, analyses: [{ kind: 'funnel', steps: ['first_launch', 'no_such_event'] }] }), (e) => e.field === 'analyses.steps');
  await assert.rejects(engine.query_retentioneering_model({ context_id: ctx, analyses: [{ kind: 'segment_overview', segment_col: 'country' }] }), (e) => e.field === 'analyses.segment_col');
  const half = await engine.build_retentioneering_model({ name: 'plain', source: 'events' });
  await engine.query_retentioneering_model({ task_id: half.task_id });
  await assert.rejects(engine.query_retentioneering_model({ context_id: half.context_id, analyses: [{ kind: 'transition_graph', path: 'sessions' }] }), (e) => e.field === 'analyses.path');
  // a task of another side is read by its own tool
  await assert.rejects(engine.query_pipeline_model({ task_id: analyses.task_id }), /query_retentioneering_model/);
});

test('every event keeps its name unless a top N is asked for; the card carries its scope and path counts', opts, async (t) => {
  if (skip(t)) return;
  const counts = {};
  for (const r of rows) counts[r.e] = (counts[r.e] || 0) + 1;
  assert.ok(!built.vocabulary.some((v) => v.event === 'other'), 'no "other" by default');
  const top3 = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3);
  const b = await engine.build_retentioneering_model({ name: 'top3', source: 'events', events: { top: 3 } });
  const r = await engine.query_retentioneering_model({ task_id: b.task_id });
  const vocab = Object.fromEntries(r.vocabulary.map((v) => [v.event, v.events]));
  for (const [e, n] of top3) assert.equal(vocab[e], n);
  assert.equal(vocab.other, rows.length - top3.reduce((a, [, n]) => a + n, 0));
  // an analysis knows how many paths it read; the card, who and when
  assert.equal(analyses.read.analyses.funnel && (await full('funnel')).paths, built.users);
  const q = await engine.query_retentioneering_model({ context_id: built.context_id, analyses: [{ kind: 'funnel', steps: FUNNEL, path: 'sessions' }] });
  await engine.query_retentioneering_model({ task_id: q.task_id });
  const d = await engine.display_retentioneering_result({ task_id: q.task_id, analysis: 'funnel' });
  assert.equal(d.result.paths, built.sessions, 'per-session paths');
  assert.deepEqual({ users: d.scope.users, events: d.scope.events }, { users: built.users, events: rows.length });
});

/** Run one call and read it back in full (every record, not the summary). */
const runFull = async (input) => {
  const q = await engine.query_retentioneering_model({ context_id: built.context_id, ...input });
  const r = await engine.query_retentioneering_model({ task_id: q.task_id, detail: 'full' });
  assert.equal(r.status, 'done', JSON.stringify(r.error));
  return { task_id: q.task_id, analyses: r.analyses };
};
const table = (result, name) => {
  const t = result.tables.find((x) => x.name === name);
  assert.ok(t, `a table '${name}' (has ${result.tables.map((x) => x.name).join(', ')})`);
  return t.rows.map((r) => Object.fromEntries(t.columns.map((c, i) => [c, r[i]])));
};

test('preprocess is the library\'s own op model: collapsed loops leave no self-transition, a path filter keeps the paths it names', opts, async (t) => {
  if (skip(t)) return;
  const { analyses: a } = await runFull({
    preprocess: [{ type: 'collapse_events', loops: true }],
    analyses: [
      { kind: 'transition_graph' },
      { kind: 'describe', id: 'long_paths', preprocess: [{ type: 'filter_paths', condition: { op: '>', metric: 'length', value: 5 } }] },
    ],
  });
  // the pairs of the paths once every run of one event is one event
  const expected = new Map();
  for (const list of paths().values()) {
    const seq = ['path_start', ...list.map((r) => r.e).filter((e, i, all) => i === 0 || e !== all[i - 1]), 'path_end'];
    for (let i = 0; i + 1 < seq.length; i += 1) expected.set(`${seq[i]}>${seq[i + 1]}`, (expected.get(`${seq[i]}>${seq[i + 1]}`) || 0) + 1);
  }
  assert.deepEqual(new Map(a.transition_graph.edges.map((e) => [`${e.source}>${e.target}`, e.count])), expected);
  assert.ok(!a.transition_graph.edges.some((e) => e.source === e.target), 'no self-loops');
  // describe after filter_paths(length > 5), over the collapsed paths of the call
  const long = [...paths().values()].filter((list) => list.map((r) => r.e).filter((e, i, all) => i === 0 || e !== all[i - 1]).length > 5).length;
  assert.equal(a.long_paths.values['shape'].n_paths, long);
  assert.equal(a.long_paths.paths, long);
});

test('metric bins: each bin holds the paths whose metric falls in it — by value, by quantile — and two bins of one name are refused in the call', opts, async (t) => {
  if (skip(t)) return;
  const lengths = [...paths().values()].map((list) => list.length);
  // pandas' linear quantile, which the library cuts at
  const sorted = [...lengths].sort((a, b) => a - b);
  const quantile = (q) => { const p = (sorted.length - 1) * q; const lo = Math.floor(p); return sorted[lo] + (sorted[Math.ceil(p)] - sorted[lo]) * (p - lo); };
  const median = quantile(0.5);
  const { analyses: a } = await runFull({
    analyses: [
      // the bins in any order after the lowest: each keeps its own level
      { kind: 'segment_overview', id: 'by_value', segment_col: 'length_band', metrics: [{ metric: 'length', agg: 'mean' }],
        preprocess: [{ type: 'add_segment', name: 'length_band', metric_bins: { metric: { metric: 'length' }, bins: [{ level: 'short' }, { level: 'long', from: 10 }, { level: 'mid', from: 5 }] } }] },
      { kind: 'segment_overview', id: 'by_quantile', segment_col: 'half', metrics: [{ metric: 'length', agg: 'mean' }],
        preprocess: [{ type: 'add_segment', name: 'half', metric_bins: { metric: { metric: 'length' }, bins: [{ level: 'lower' }, { level: 'upper', from_quantile: 0.5 }] } }] },
    ],
  });
  const sizes = (s) => Object.fromEntries(s.levels.map((l) => [l.name, l.size]));
  const count = (f) => lengths.filter(f).length;
  assert.deepEqual(sizes(a.by_value), Object.fromEntries(Object.entries({ short: count((n) => n < 5), mid: count((n) => n >= 5 && n < 10), long: count((n) => n >= 10) }).filter(([, n]) => n)));
  assert.deepEqual(sizes(a.by_quantile), Object.fromEntries(Object.entries({ lower: count((n) => n < median), upper: count((n) => n >= median) }).filter(([, n]) => n)));
  const bins = (list) => engine.query_retentioneering_model({ context_id: built.context_id, preprocess: [{ type: 'add_segment', name: 'x', metric_bins: { metric: { metric: 'length' }, bins: list } }], analyses: [{ kind: 'describe' }] });
  await assert.rejects(bins([{ level: 'a' }, { level: 'a', from: 3 }]), (e) => e.field === 'preprocess.metric_bins' && /two bins are named 'a'/.test(e.message));
  await assert.rejects(bins([{ level: 'a' }, { level: 'b', from: 3 }, { level: 'c', from: 3 }]), (e) => e.field === 'preprocess.metric_bins' && /two bins start/.test(e.message));
});

test('a condition on a time metric compares seconds since the epoch: the paths that started before a moment', opts, async (t) => {
  if (skip(t)) return;
  const firsts = (await wh.query('select epoch(min(device_time)) as s from fct_analytics_events group by player_id_of_internal order by 1')).rows.map((r) => Number(r.s));
  const moment = firsts[Math.floor(firsts.length / 2)];
  const { analyses: a } = await runFull({
    analyses: [{ kind: 'describe', id: 'early', preprocess: [{ type: 'filter_paths', condition: { op: '<', metric: 'first_event_time', value: moment } }] }],
  });
  assert.equal(a.early.paths, firsts.filter((s) => s < moment).length);
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
  assert.equal((await engine.query_retentioneering_model({ task_id })).show_to_user, undefined);
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

test('a diff around an anchor is drawn block by block: each difference is its first group minus its second; a funnel diff has no card', opts, async (t) => {
  if (skip(t)) return;
  const [p1, p2] = (await wh.query('select distinct platform from dim_users where platform is not null order by 1')).rows.map((r) => r.platform);
  const { task_id, analyses: a } = await runFull({
    analyses: [
      { kind: 'step_matrix', max_steps: 3, diff: ['platform', p1, p2], path_pattern: 'tutorial->.*->level_completed' },
      { kind: 'funnel', steps: FUNNEL, diff: ['platform', p1, p2] },
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
  const read = await engine.query_retentioneering_model({ task_id });
  assert.equal(read.show_to_user?.arguments.analysis, 'step_matrix', 'the anchored diff is offered as a card');
  const d = await engine.display_retentioneering_result({ task_id, analysis: 'step_matrix' });
  const vm = retentioneeringViewModel(d, {});
  assert.equal(vm.kind, 'diff');
  assert.equal(vm.tables.filter((x) => x.diverging).length, blocks.length);
  await assert.rejects(engine.display_retentioneering_result({ task_id, analysis: 'funnel' }), (e) => e.field === 'analysis' && /diff of funnel/.test(e.message));
});

test('a read is a summary by default and every record with detail: "full"', opts, async (t) => {
  if (skip(t)) return;
  const q = await engine.query_retentioneering_model({ context_id: built.context_id, analyses: [{ kind: 'path_metrics', metrics: [{ metric: 'length' }] }] });
  const summary = await engine.query_retentioneering_model({ task_id: q.task_id });
  const [tb] = summary.analyses.path_metrics.tables;
  assert.equal(tb.total_rows, built.users);
  assert.equal(tb.rows.length, Math.min(built.users, 20));
  const all = await engine.query_retentioneering_model({ task_id: q.task_id, detail: 'full' });
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
    segments: [{ column: 'bundle_id', as: 'app' }, { property: 'level_id_of_event_data', as: 'level' }],
  });
  const r = await engine.query_retentioneering_model({ task_id: b.task_id });
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
  const r = await engine.query_retentioneering_model({ task_id: b.task_id });
  assert.equal(r.status, 'done', JSON.stringify(r.error));
  const expected = counts(src.map((x) => (x.e !== 'level_completed' || x.r == null ? x.e : x.r === 'win' ? 'level_won' : `level_completed_${x.r}`)));
  assert.deepEqual(new Map(r.vocabulary.map((v) => [v.event, v.events])), expected);
  assert.equal(r.events, src.length, 'no event lost');
  // by conditions: the first case that holds; the rest take `else`
  const c = await engine.build_retentioneering_model({
    name: 'by_case', source: 'events',
    events: { split: [{ event: 'level_completed', cases: [{ name: 'level_lost', where: [{ property: 'result_of_event_data', op: 'eq', value: 'lose' }] }], else: 'level_passed' }] },
  });
  const rc = await engine.query_retentioneering_model({ task_id: c.task_id });
  const lost = src.filter((x) => x.e === 'level_completed' && x.r === 'lose').length;
  const vocab = new Map(rc.vocabulary.map((v) => [v.event, v.events]));
  assert.deepEqual([vocab.get('level_lost'), vocab.get('level_passed'), vocab.get('level_completed')], [lost, src.filter((x) => x.e === 'level_completed').length - lost, undefined]);
  // the new names are what an analysis reads
  const q = await engine.query_retentioneering_model({ context_id: rc.context_id, eventstream: 'by_case', analyses: [{ kind: 'transition_graph' }] });
  const g = await engine.query_retentioneering_model({ task_id: q.task_id, detail: 'full' });
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
  const r = await engine.query_retentioneering_model({ task_id: b.task_id });
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
    const r = await engine.query_retentioneering_model({ task_id: b.task_id });
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
  const r = await engine.query_retentioneering_model({ task_id: b.task_id });
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
  await engine.build_pipeline_model({ action: 'add_steps', draft_id: p.draft_id, stages: [
    { stage: 'compute', name: 'prev', op: 'window', fn: 'lag', column: 'event_name', partition_by: ['player_id_of_internal'], order_by: [{ key: 'device_time' }, { key: 'event_id' }] },
    { stage: 'compute', name: 'ev', op: 'case', type: 'string', cases: [{ when: [{ column: 'event_name', op: 'eq', value: 'level_started' }, { column: 'prev', op: 'eq', value: 'level_started' }], then: { value: 'level_restarted' } }], else: { column: 'event_name' } },
    { stage: 'project', columns: ['player_id_of_internal', 'ev', 'device_time', 'bundle_id'] },
  ] });
  const m = await engine.build_pipeline_model({ action: 'materialize', draft_id: p.draft_id });
  const built = await engine.query_pipeline_model({ task_id: m.task_id });
  assert.equal(built.status, 'done', JSON.stringify(built.error));
  const b = await engine.build_retentioneering_model({ name: 'from_pipe', from_task: m.task_id, columns: { path: 'player_id_of_internal', event: 'ev', time: 'device_time' }, segments: [{ column: 'bundle_id', as: 'app' }] });
  const r = await engine.query_retentioneering_model({ task_id: b.task_id });
  assert.equal(r.status, 'done', JSON.stringify(r.error));
  assert.deepEqual(new Map(r.vocabulary.map((v) => [v.event, v.events])), expected);
  assert.equal(r.users, byUser.size);
  // the analyses read it like any eventstream
  const q = await engine.query_retentioneering_model({ context_id: r.context_id, eventstream: 'from_pipe', analyses: [{ kind: 'transition_graph' }] });
  const g = await engine.query_retentioneering_model({ task_id: q.task_id, detail: 'full' });
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
    const r = await engine.query_retentioneering_model({ task_id: b.task_id });
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
  const r = await engine.query_retentioneering_model({ task_id: b.task_id });
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
  await engine.build_pipeline_model({ action: 'add_step', draft_id: p.draft_id, stage: { stage: 'where', conditions: [{ column: 'event_name', op: 'neq', value: 'first_launch' }] } });
  const first = await engine.build_pipeline_model({ action: 'materialize', draft_id: p.draft_id });
  assert.equal((await engine.query_pipeline_model({ task_id: first.task_id })).status, 'done');
  await engine.build_pipeline_model({ action: 'add_step', draft_id: p.draft_id, stage: { stage: 'project', columns: ['player_id_of_internal', 'event_name', 'device_time'] } });
  const second = await engine.build_pipeline_model({ action: 'materialize', draft_id: p.draft_id });
  const built = await engine.query_pipeline_model({ task_id: second.task_id });
  assert.equal(built.status, 'done', JSON.stringify(built.error));
  const b = await engine.build_retentioneering_model({ name: 'from_rebuild', from_task: second.task_id, columns: { path: 'player_id_of_internal', event: 'event_name', time: 'device_time' } });
  const r = await engine.query_retentioneering_model({ task_id: b.task_id });
  assert.equal(r.status, 'done', JSON.stringify(r.error));
  assert.equal(r.events, n);
  const q = await engine.build_pipeline_model({ action: 'start', name: 'on_rebuild', from_task: second.task_id, source: 'events' });
  await engine.build_pipeline_model({ action: 'add_step', draft_id: q.draft_id, stage: { stage: 'aggregate', measures: [{ name: 'n', fn: 'count' }] } });
  const m = await engine.build_pipeline_model({ action: 'materialize', draft_id: q.draft_id });
  const rows = await engine.query_pipeline_model({ task_id: m.task_id });
  assert.equal(rows.status, 'done', JSON.stringify(rows.error));
  assert.equal(Number(rows.rows[0].n), n);
});
