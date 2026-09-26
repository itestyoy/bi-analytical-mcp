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
import { TEXT_NOTE } from '../../src/apps/result-view-model.js';
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
  // no visual shape: not offered as a card, and a card asked for is answered in words, the numbers kept
  assert.equal((await engine.query_retentioneering_model({ task_id })).show_to_user, undefined);
  const asked = await engine.display_retentioneering_result({ task_id, analysis: 'conversion_rate' });
  assert.deepEqual([asked.drawn, asked.note, table(asked.result, 'result')[0].converted], [false, TEXT_NOTE, converted]);
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
  assert.equal(vm.kind, 'tables');
  assert.deepEqual(vm.tables.map((x) => [x.name, x.diverging]), [['diff', true], ['first', false], ['second', false]]);
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
