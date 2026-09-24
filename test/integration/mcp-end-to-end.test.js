// TEN COMPLEX SCENARIOS, EACH DRIVEN THE WHOLE WAY AN ASSISTANT DRIVES THIS SERVER.
//
// Nothing here calls the engine directly. Every step goes through a real MCP client over a
// transport: tools/list, tools/call with JSON arguments, the answer read back out of the MCP
// content block — and the numbers asserted are what the WAREHOUSE returned (DuckDB + dbt +
// MetricFlow, seeded and built in `before`). A scenario is a sequence of tool calls, the way a
// real task is: discover, declare, query; or start a draft, add stages, materialize, re-slice.
//
// The point is coverage of the SEAMS: the protocol surface, input validation at the boundary,
// the governed path and the pipeline path, joins across all four sources, a funnel feeding a
// segment join, a pipeline result feeding a statistics tool, and a stored result re-sliced
// without recomputing. Every assertion is a number or a set of ids from the database — per the
// project rule, never the text of a generated query.
//
// Auto-skips when dbt/mf are not installed (HAS_DBT gate).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { MfEngineBackend } from '../../src/backends/mf-engine.js';
import { Engine } from '../../src/engine.js';
import { makeMcpServer } from '../../src/server.js';
import { startWarehouse, fixtureProject } from './warehouse-harness.js';
import { isStartedTask } from '../helpers/settle.js';
import { DBT_BIN, MF_BIN, PY_BIN, HAS_DBT } from '../helpers/dbt-env.js';

const execFileP = promisify(execFile);
const BASE = fixtureProject('dbt_project'); // a private copy: the test files run side by side
const opts = { timeout: 300000 };

let wh; let backend; let server; let client; let seq = 0;

const num = (v) => Number(v === '' || v == null ? NaN : v);
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const mapCol = (rows, keyCol, valCol) => Object.fromEntries(rows.map((r) => [String(r[keyCol]), num(r[valCol])]));
const sumCol = (rows, col) => rows.reduce((s, r) => s + (Number.isFinite(num(r[col])) ? num(r[col]) : 0), 0);
const groupCol = (res, metric) => res.columns.map((c) => c.name).find((n) => n !== metric);
/** The validity window of the install record, stated per the calling source's own time column. */
const AT = (value) => ({ value, from: 'install_time_valid_from', to: 'install_time_valid_until' });

before(async () => {
  if (!HAS_DBT) return;
  wh = await startWarehouse();
  const env = { ...process.env, DBT_PROFILES_DIR: BASE, DBT_PROJECT_DIR: BASE, DUCKDB_PATH: wh.path };
  await execFileP(DBT_BIN, ['seed', '--full-refresh'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  await execFileP(DBT_BIN, ['run'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });

  const catalog = loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), { profilesDir: BASE, projectDir: BASE });
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: mkdtempSync(join(tmpdir(), 'mcpe2e-')), timeSpineDialect: 'duckdb' });
  backend = new MfEngineBackend({ pythonBin: PY_BIN, dbtBin: DBT_BIN, profilesDir: BASE });
  const engine = new Engine({ catalog, contextManager: ctxs, runner: backend });

  // The real protocol surface: an MCP server over a transport, and a client on the other end.
  server = makeMcpServer(engine);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'mcp-e2e-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
}, opts);

after(async () => {
  if (client) await client.close();
  if (server) await server.close();
  backend?.close();
  if (wh) await wh.stop();
});

const skip = (t) => { if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; } return false; };

/**
 * One MCP tool call, the way an assistant makes it: a call that STARTS work answers with its
 * task_id, and the result is read back with the query tool of its side ({ task_id }, called again
 * while it says running).
 */
async function settled(name, args) {
  let res = await client.callTool({ name, arguments: args });
  let out = JSON.parse(res.content[0].text);
  if (!res.isError && isStartedTask(out)) {
    do {
      res = await client.callTool({ name: out.read_with, arguments: { task_id: out.task_id } }); // the started task names its reader
      out = JSON.parse(res.content[0].text);
    } while (!res.isError && out.status === 'running');
  }
  return { res, out };
}

/** One MCP tool call that must succeed; returns the parsed result payload. */
async function call(name, args) {
  const { res, out } = await settled(name, args);
  assert.ok(!res.isError, `${name} failed: ${res.content?.[0]?.text}`);
  return out;
}

/** One MCP tool call that must FAIL (refused in the call, or its task failed); returns the parsed { ok:false, error } payload. */
async function callErr(name, args) {
  const { res, out } = await settled(name, args);
  assert.equal(res.isError, true, `${name} was expected to fail but returned: ${res.content?.[0]?.text?.slice(0, 300)}`);
  return out;
}

/** A whole pipeline over MCP: start → add_step per stage → materialize. */
async function mcpPipeline(source, stages, name) {
  const s = await call('build_pipeline_model', { action: 'start', name: name || `e2e_${seq++}`, source });
  for (const stage of stages) await call('build_pipeline_model', { action: 'add_step', draft_id: s.draft_id, stage });
  const built = await call('build_pipeline_model', { action: 'materialize', draft_id: s.draft_id });
  assert.equal(built.build?.ok, true, JSON.stringify(built.error || built.build));
  return built;
}

/** A governed task over MCP: create it, then query it. */
async function mcpTask(payload) {
  const created = await call('build_semantic_model', payload);
  assert.equal(created.parse?.ok, true, JSON.stringify(created.parse));
  return created.context_id;
}

// ═══════════ 1. discover → declare → query, the whole governed loop ═══════════

test('1. discovery to a point-in-time metric: spend by install country = 6.75 / 5.00 / 4.00 / 1.75', opts, async (t) => {
  if (skip(t)) return;
  // the protocol advertises the tools an assistant needs…
  const tools = (await client.listTools()).tools.map((x) => x.name);
  for (const needed of ['semantic_index', 'build_semantic_model', 'query_semantic_model', 'build_pipeline_model', 'query_pipeline_model', 'experiment']) {
    assert.ok(tools.includes(needed), `${needed} is advertised`);
  }
  // …and only those: editing a task is a MODE of build_semantic_model, not a tool of its own —
  // two tools meant the deployment's whole vocabulary twice in every listing.
  assert.ok(!tools.includes('update_semantic_model'), 'the update tool is folded into build_semantic_model');
  const createTool = (await client.listTools()).tools.find((x) => x.name === 'build_semantic_model');
  assert.deepEqual(createTool.inputSchema.properties.action.enum, ['create', 'update']);
  // …the overview names the four sources…
  const overview = await call('semantic_index', {});
  const models = JSON.stringify(overview.models || overview);
  for (const m of ['events', 'crashlytics', 'acquisition', 'users']) assert.match(models, new RegExp(m));
  // …drilling the spend source shows which of its fields are AMOUNTS, with no function fixed…
  const acq = await call('semantic_index', { model: 'acquisition' });
  const amounts = (acq.aggregatable || []).map((a) => a.field);
  for (const f of ['cost', 'impressions', 'clicks']) assert.ok(amounts.includes(f), `${f} is offered as an amount`);
  assert.ok(!(acq.dimensions || []).some((d) => d.name === 'cost'), 'an amount is not a groupable attribute');
  // …and its relationship to the install record is discoverable, not guessed.
  const rel = (acq.relationships || []).find((r) => r.entity === 'user');
  assert.equal(rel.joins, 'users');

  // Declare the metric the discovery pointed at, then answer with it. dim_users is SCD-2, so
  // MetricFlow applies the validity window itself: each spend row is attributed to the install
  // version valid on the spend day.
  const ctx = await mcpTask({
    name: 'e2e_ua',
    use_base_models: ['users'],
    semantic_models: [{ from: 'acquisition', measures: [{ name: 'cost', agg: 'sum', field: 'cost' }] }],
    metrics: [{ name: 'cost', type: 'simple', measure: { name: 'cost' } }],
  });
  const r = await call('query_semantic_model', { context_id: ctx, metrics: ['e2e_ua_cost'], group_by: [{ model: 'users', attribute: 'country' }] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const by = mapCol(r.rows, groupCol(r, 'e2e_ua_cost'), 'e2e_ua_cost');
  assert.ok(near(by.US, 6.75), `US=${by.US}`);
  assert.ok(near(by.GB, 5.0), `GB=${by.GB}`);
  assert.ok(near(by.DE, 4.0), `DE=${by.DE}`);
  assert.ok(near(by.BR, 1.75), `BR=${by.BR}`);
  assert.ok(near(sumCol(r.rows, 'e2e_ua_cost'), 17.5), 'and the total is untouched by the join');
});

// ═══════════ 2. four sources in one pipeline, stage by stage ═══════════

test('2. crash → its ad funnel → the install version then → that player\'s spend: 22 rows', opts, async (t) => {
  if (skip(t)) return;
  const built = await mcpPipeline('crashlytics', [
    { stage: 'join', with: 'events', via: 'ad_funnel_rewarded', kind: 'inner', attrs: ['event_id', 'tracking_id'] },
    { stage: 'join', with: 'users', via: 'user', between: AT('event_time'), kind: 'inner', attrs: ['country'] },
    { stage: 'join', with: 'acquisition', via: 'user', kind: 'inner', attrs: ['acquisition_id', 'cost', 'media_source'] },
    { stage: 'aggregate', measures: [
      { name: 'n', fn: 'count' },
      { name: 'crashes', fn: 'count_distinct', column: 'crash_id' },
      { name: 'events', fn: 'count_distinct', column: 'event_id' },
      { name: 'funnels', fn: 'count_distinct', column: 'tracking_id' },
      { name: 'spend', fn: 'sum', column: 'cost' },
    ] },
  ]);
  const r = built.rows[0];
  assert.equal(num(r.n), 22, '7 crashes x 2 funnel events, and u1 pairs with both of its spend rows');
  assert.equal(num(r.crashes), 7);
  assert.equal(num(r.events), 8);
  assert.equal(num(r.funnels), 4);
  assert.ok(near(num(r.spend), 25.0), `spend=${r.spend}`);
  // the rows are a task's result — readable again by its id — and the pipeline tier is named.
  assert.equal(built.tool, 'build_pipeline_model');
  assert.equal(built.table, built.model);
  assert.equal(built.provenance?.tier, 'pipeline');
});

// ═══════════ 3. the point-in-time window, present and absent ═══════════

test('3. the validity window decides the answer: 13 attributed rows vs 15 duplicated ones', opts, async (t) => {
  if (skip(t)) return;
  const stats = async (extra) => {
    const built = await mcpPipeline('acquisition', [
      { stage: 'join', with: 'users', via: 'user', kind: 'inner', attrs: ['country'], ...extra },
      { stage: 'aggregate', measures: [{ name: 'n', fn: 'count' }, { name: 'rows', fn: 'count_distinct', column: 'acquisition_id' }] },
    ]);
    return { n: num(built.rows[0].n), distinct: num(built.rows[0].rows) };
  };
  const windowed = await stats({ between: AT('spend_date') });
  assert.deepEqual(windowed, { n: 13, distinct: 13 }, 'one install version per spend row');
  const keyOnly = await stats({});
  assert.deepEqual(keyOnly, { n: 15, distinct: 13 }, 'u1 has two spend rows and two install versions');

  // …and the step that omits it says so, before anything is built.
  const s = await call('build_pipeline_model', { action: 'start', name: `e2e_${seq++}`, source: 'acquisition' });
  const step = await call('build_pipeline_model', {
    action: 'add_step', draft_id: s.draft_id,
    stage: { stage: 'join', with: 'users', via: 'user', attrs: ['country'] },
  });
  const recs = JSON.stringify(step.recommendations || []);
  assert.match(recs, /INCOMPLETE JOIN/);
  assert.match(recs, /install_time_valid_from/, 'and names the real window columns');
});

// ═══════════ 4. one relationship, three ad formats ═══════════

test('4. the caller picks the ad format: 14 / 12 / 8 rows, and k1 keeps its funnels apart', opts, async (t) => {
  if (skip(t)) return;
  const rowsFor = async (variant) => (await mcpPipeline('crashlytics', [
    { stage: 'join', with: 'events', via: `ad_funnel_${variant}`, kind: 'inner', attrs: ['event_id'] },
    { stage: 'aggregate', measures: [{ name: 'n', fn: 'count' }] },
  ])).rows[0].n;
  assert.equal(num(await rowsFor('rewarded')), 14);
  assert.equal(num(await rowsFor('interstitial')), 12);
  assert.equal(num(await rowsFor('banner')), 8);

  // u1 crashed having seen a rewarded funnel AND an interstitial one; each variant returns its
  // own pair, and the banner column is empty so it returns nothing.
  const idsFor = async (variant) => {
    const built = await mcpPipeline('crashlytics', [
      { stage: 'where', conditions: [{ column: 'crash_id', op: 'eq', value: 'k1' }] },
      { stage: 'join', with: 'events', via: `ad_funnel_${variant}`, kind: 'inner', attrs: ['event_id'] },
      { stage: 'project', columns: ['event_id'] },
    ]);
    return new Set(built.rows.map((r) => String(r.event_id)));
  };
  assert.deepEqual(await idsFor('rewarded'), new Set(['e129', 'e130']));
  assert.deepEqual(await idsFor('interstitial'), new Set(['e131', 'e132']));
  assert.deepEqual(await idsFor('banner'), new Set());
});

// ═══════════ 5. what the caller asked for is what the caller gets ═══════════

test('5. the attrs contract, enforced at the protocol boundary', opts, async (t) => {
  if (skip(t)) return;
  const start = async () => (await call('build_pipeline_model', { action: 'start', name: `e2e_${seq++}`, source: 'crashlytics' })).draft_id;

  // (a) no attrs → refused, and the error lists what the model actually offers.
  const missing = await callErr('build_pipeline_model', {
    action: 'add_step', draft_id: await start(),
    stage: { stage: 'join', with: 'acquisition', via: 'user' },
  });
  assert.match(missing.error.message, /`attrs` is required/);
  assert.match(missing.error.message, /Columns of 'acquisition':.*cost.*impressions.*clicks/s);

  // (b) a name the pipeline already carries → refused, with the rename to apply.
  const dup = await callErr('build_pipeline_model', {
    action: 'add_step', draft_id: await start(),
    stage: { stage: 'join', with: 'events', via: 'ad_funnel_rewarded', attrs: ['event_name'] },
  });
  assert.match(dup.error.message, /already has a column named 'event_name'/);
  assert.match(dup.error.message, /as: 'events_event_name'/);

  // (c) the rename works, and both sides are readable side by side.
  const built = await mcpPipeline('crashlytics', [
    { stage: 'join', with: 'events', via: 'ad_funnel_rewarded', kind: 'inner', attrs: [{ column: 'event_name', as: 'events_event_name' }] },
    { stage: 'aggregate', group_by: ['event_name', 'events_event_name'], measures: [{ name: 'n', fn: 'count' }] },
  ]);
  const crashSide = {}; const adSide = {};
  for (const r of built.rows) {
    crashSide[String(r.event_name)] = (crashSide[String(r.event_name)] || 0) + num(r.n);
    adSide[String(r.events_event_name)] = (adSide[String(r.events_event_name)] || 0) + num(r.n);
  }
  assert.deepEqual(crashSide, { fatal_crash: 8, non_fatal: 4, anr: 2 });
  assert.deepEqual(adSide, { ad_started: 7, ad_finished: 7 });

  // (d) an unlisted column of the joined model is simply not there.
  const s = await start();
  await call('build_pipeline_model', { action: 'add_step', draft_id: s, stage: { stage: 'join', with: 'events', via: 'ad_funnel_rewarded', kind: 'inner', attrs: ['event_id'] } });
  const unlisted = await callErr('build_pipeline_model', {
    action: 'add_step', draft_id: s,
    stage: { stage: 'aggregate', measures: [{ name: 'x', fn: 'count_distinct', column: 'tracking_id' }] },
  });
  assert.match(unlisted.error.message, /unknown column 'tracking_id'/);
});

// ═══════════ 6. a funnel, then the segment it converted in ═══════════

test('6. funnel conversion by install country: 12 enter (US 4 / GB 3 / DE 3 / BR 2), 8 reach step 1', opts, async (t) => {
  if (skip(t)) return;
  const built = await mcpPipeline('events', [
    { stage: 'match_recognize',
      partition_by: ['player_id_of_internal'],
      mode: 'ordered',
      steps: [
        { name: 'launch', event_name: ['first_launch'] },
        { name: 'tut1', event_name: ['tutorial'], where: [{ property: 'element_of_event_data', op: 'eq', value: 'step_1' }] },
      ] },
    // after the funnel the per-event time is gone; `first_seen_at` (the funnel's first event) is
    // the instant to attribute the player by.
    { stage: 'join', with: 'users', via: 'user', between: AT('first_seen_at'), kind: 'inner', attrs: ['country'] },
    { stage: 'aggregate', group_by: ['country', 'reached_tut1'], measures: [{ name: 'n', fn: 'count' }] },
  ]);
  const cell = {};
  for (const r of built.rows) cell[`${r.country}/${String(r.reached_tut1)}`] = num(r.n);
  const entered = {};
  for (const r of built.rows) entered[String(r.country)] = (entered[String(r.country)] || 0) + num(r.n);
  assert.deepEqual(entered, { US: 4, GB: 3, DE: 3, BR: 2 }, 'every player who launched, by the country valid then');
  assert.equal(cell['US/true'], 3);
  assert.equal(cell['GB/true'], 2);
  assert.equal(cell['DE/true'], 2);
  assert.equal(cell['BR/true'], 1);
  assert.equal(sumCol(built.rows, 'n'), 12);
});

// ═══════════ 7. three sources compared, none joined to the others ═══════════

test('7. spend, events and crashes side by side on metric_time: 17.50 / 184 / 13', opts, async (t) => {
  if (skip(t)) return;
  const ctx = await mcpTask({
    name: 'e2e_mix',
    semantic_models: [
      { from: 'acquisition', measures: [{ name: 'cost', agg: 'sum', field: 'cost' }] },
      { from: 'events', measures: [{ name: 'evts', agg: 'count', field: '*' }] },
      { from: 'crashlytics', measures: [{ name: 'crashes', agg: 'count', field: '*' }] },
    ],
    metrics: [
      { name: 'cost', type: 'simple', measure: { name: 'cost' } },
      { name: 'evts', type: 'simple', measure: { name: 'evts' } },
      { name: 'crashes', type: 'simple', measure: { name: 'crashes' } },
    ],
  });
  const r = await call('query_semantic_model', {
    context_id: ctx,
    metrics: ['e2e_mix_cost', 'e2e_mix_evts', 'e2e_mix_crashes'],
    group_by: [{ time: 'metric_time', grain: 'day' }],
  });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  // A day may carry spend but no crash and the other way round, so the series has holes — that
  // is the honest shape of an outer alignment. Each source keeps its own total.
  assert.ok(near(sumCol(r.rows, 'e2e_mix_cost'), 17.5), `cost=${sumCol(r.rows, 'e2e_mix_cost')}`);
  assert.equal(sumCol(r.rows, 'e2e_mix_evts'), 184);
  assert.equal(sumCol(r.rows, 'e2e_mix_crashes'), 13);
  assert.ok(r.rows.length > 1, 'a real day-by-day series');
});

// ═══════════ 8. a pipeline result feeding the statistics tool ═══════════

test('8. per-variant aggregates from the warehouse, then significance: control 6/6 vs variant_b 1/6', opts, async (t) => {
  if (skip(t)) return;
  // group sizes: distinct players per assigned variant, straight from the experiments source.
  const sizes = await mcpPipeline('events', [
    { stage: 'join', with: 'experiments', via: 'user', kind: 'inner', attrs: ['variant_group', 'experiment_name'] },
    { stage: 'aggregate', group_by: ['variant_group'], measures: [{ name: 'users', fn: 'count_distinct', column: 'player_id_of_internal' }] },
  ]);
  const n = mapCol(sizes.rows, 'variant_group', 'users');
  assert.deepEqual(n, { control: 6, variant_b: 6 });

  // conversions: the same players, scoped to the purchase event.
  const conv = await mcpPipeline('events', [
    { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] },
    { stage: 'join', with: 'experiments', via: 'user', kind: 'inner', attrs: ['variant_group'] },
    { stage: 'aggregate', group_by: ['variant_group'], measures: [{ name: 'payers', fn: 'count_distinct', column: 'player_id_of_internal' }] },
  ]);
  const c = mapCol(conv.rows, 'variant_group', 'payers');
  assert.deepEqual(c, { control: 6, variant_b: 1 });

  // the split first — a broken randomisation invalidates any lift.
  const split = await call('experiment', {
    action: 'check_split',
    groups: [{ label: 'control', n: n.control }, { label: 'variant_b', n: n.variant_b }],
  });
  assert.equal(split.srm ?? split.mismatch ?? false, false, `an even 6/6 split is not an SRM: ${JSON.stringify(split)}`);

  // …then the test, on the numbers the warehouse just produced.
  const res = await call('experiment', {
    action: 'analyze',
    metric: 'proportion',
    control: { label: 'control', n: n.control, conversions: c.control },
    variants: [{ label: 'variant_b', n: n.variant_b, conversions: c.variant_b }],
    correction: 'holm',
  });
  const arm = res.results[0];
  assert.equal(arm.variant, 'variant_b');
  assert.ok(arm.p_value < 0.05, `p=${arm.p_value}`);
  assert.equal(arm.significant_adjusted ?? arm.significant, true, JSON.stringify(arm));
  assert.ok(num(arm.lift ?? arm.absolute_lift ?? arm.delta) < 0, `variant_b is worse, not better: ${JSON.stringify(arm)}`);
});

// ═══════════ 9. a stored result, re-sliced without recomputing ═══════════

test('9. materialize once, then re-slice the stored result from its task: meta 18 / organic 2 / applovin 2', opts, async (t) => {
  if (skip(t)) return;
  const built = await mcpPipeline('crashlytics', [
    { stage: 'join', with: 'events', via: 'ad_funnel_rewarded', kind: 'inner', attrs: ['event_id'] },
    { stage: 'join', with: 'acquisition', via: 'user', kind: 'inner', attrs: ['media_source', 'cost'] },
  ], `e2e_store_${seq++}`);
  assert.equal(num(built.row_count), 22, 'the row-level result is stored as a table');

  // …and a pipeline started FROM that task aggregates it WITHOUT re-running the joins.
  const slice = async (name, stages) => {
    const d = await call('build_pipeline_model', { action: 'start', name, from_task: built.task_id });
    await call('build_pipeline_model', { action: 'add_steps', draft_id: d.draft_id, stages });
    return call('build_pipeline_model', { action: 'materialize', draft_id: d.draft_id });
  };
  const sliced = await slice(`e2e_slice_${seq++}`, [
    { stage: 'aggregate', group_by: ['media_source'], measures: [{ name: 'n', fn: 'count' }, { name: 'spend', fn: 'sum', column: 'cost' }] },
  ]);
  const n = mapCol(sliced.rows, 'media_source', 'n');
  const spend = mapCol(sliced.rows, 'media_source', 'spend');
  assert.deepEqual(n, { meta: 18, organic: 2, applovin: 2 });
  assert.ok(near(spend.meta, 20.0) && near(spend.organic, 0.0) && near(spend.applovin, 5.0), JSON.stringify(spend));

  // a filter over the stored result is just as cheap.
  const meta = await slice(`e2e_slice_${seq++}`, [
    { stage: 'where', conditions: [{ column: 'media_source', op: 'eq', value: 'meta' }] },
    { stage: 'aggregate', measures: [{ name: 'n', fn: 'count' }] },
  ]);
  assert.equal(num(meta.rows[0].n), 18);
  // the stored result itself pages without recomputing
  const page = await call('query_pipeline_model', { task_id: built.task_id, limit: 5, offset: 20 });
  assert.equal(page.rows.length, 2, 'rows 21-22 of 22');
});

// ═══════════ 10. an existing task, extended in place ═══════════

test('10. extend a task over MCP and re-query: cost 17.50 alongside 64 clicks', opts, async (t) => {
  if (skip(t)) return;
  const ctx = await mcpTask({
    name: 'e2e_grow',
    semantic_models: [{ from: 'acquisition', measures: [{ name: 'cost', agg: 'sum', field: 'cost' }] }],
    metrics: [{ name: 'cost', type: 'simple', measure: { name: 'cost' } }],
  });
  const before = await call('query_semantic_model', { context_id: ctx, metrics: ['e2e_grow_cost'] });
  assert.equal(before.ok, true, JSON.stringify(before.error));
  assert.ok(near(num(before.rows[0].e2e_grow_cost), 17.5));

  // the new metric does not exist yet — the boundary says so rather than answering.
  const tooEarly = await callErr('query_semantic_model', { context_id: ctx, metrics: ['e2e_grow_clicks'] });
  assert.ok(tooEarly.error.message.length > 0, JSON.stringify(tooEarly));

  // add a second amount from the SAME source, choosing its aggregation here and now.
  const grown = await call('build_semantic_model', {
    action: 'update',
    context_id: ctx,
    semantic_model: 'acquisition',
    add_measures: [{ name: 'clicks', agg: 'sum', field: 'clicks' }],
    add_metrics: [{ name: 'clicks', type: 'simple', measure: { name: 'clicks' } }],
  });
  assert.equal(grown.parse?.ok, true, JSON.stringify(grown.parse));
  // the old name is no longer advertised but still answers, so a client that learned it keeps working
  const legacy = await call('update_semantic_model', {
    context_id: ctx,
    semantic_model: 'acquisition',
    add_measures: [{ name: 'impressions', agg: 'sum', field: 'impressions' }],
    add_metrics: [{ name: 'impressions', type: 'simple', measure: { name: 'impressions' } }],
  });
  assert.equal(legacy.parse?.ok, true, JSON.stringify(legacy.parse));

  const after = await call('query_semantic_model', { context_id: ctx, metrics: ['e2e_grow_cost', 'e2e_grow_clicks'] });
  assert.equal(after.ok, true, JSON.stringify(after.error));
  assert.ok(near(num(after.rows[0].e2e_grow_cost), 17.5), 'the original metric is unchanged');
  assert.equal(num(after.rows[0].e2e_grow_clicks), 64);

  // the context describes what it now holds — both metrics, one task.
  const described = await call('context', { action: 'describe', context_id: ctx });
  const metrics = JSON.stringify(described.metrics || described);
  assert.match(metrics, /e2e_grow_cost/);
  assert.match(metrics, /e2e_grow_clicks/);
});
