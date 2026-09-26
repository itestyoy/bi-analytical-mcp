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
      { kind: 'cluster_analysis', n_clusters: [2, 3] },
      { kind: 'segment_overview', segment: 'platform' },
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
  const again = await engine.query_retentioneering_model({ context_id: built.context_id, analyses: [{ kind: 'cluster_analysis', n_clusters: [2, 3] }, { kind: 'transition_graph' }] });
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
  await assert.rejects(engine.build_retentioneering_model({ name: 'x', source: 'events', events: { include: ['levl_started'] } }), (e) => e.field === 'events.include' && /level_started/.test(e.message));
  await assert.rejects(engine.query_retentioneering_model({ context_id: ctx, analyses: [{ kind: 'funnel', steps: ['first_launch', 'no_such_event'] }] }), (e) => e.field === 'analyses.steps');
  await assert.rejects(engine.query_retentioneering_model({ context_id: ctx, analyses: [{ kind: 'segment_overview', segment: 'country' }] }), (e) => e.field === 'analyses.segment');
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
