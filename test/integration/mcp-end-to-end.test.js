// TEN COMPLEX SCENARIOS, EACH DRIVEN THE WHOLE WAY AN ASSISTANT DRIVES THIS SERVER.
//
// Nothing here calls the engine directly. Every step goes through a real MCP client over a
// transport: tools/list, tools/call with JSON arguments, the answer read back out of the MCP
// content block — and the numbers asserted are what the WAREHOUSE returned (DuckDB + dbt +
// MetricFlow, seeded and built in `before`). A scenario is a sequence of tool calls, the way a
// real task is: discover, declare, query; or start a draft, add steps, materialize, re-slice.
//
// The point is coverage of the SEAMS: the protocol surface, input validation at the boundary,
// the governed path and the pipeline path, joins across all four sources, a funnel feeding a
// segment join, a pipeline result feeding a statistics tool, and a stored result re-sliced
// without recomputing. Every assertion is a number or a set of ids from the database — per the
// project rule, never the text of a generated query.
//
// It is also the one home of the join scenarios declared-joins.test.js would otherwise repeat on the
// engine: the users contract's time (#3), the governed spend by install country (#1), the three ad
// formats and k1's funnels kept apart (#4), the attrs rename built (#5), three sources on metric_time
// (#7), and the stored chain re-sliced by media_source (#9).
//
// Auto-skips when dbt/mf are not installed (HAS_DBT gate).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { buildWarehouse, connectMcp, fixtureProject } from './warehouse-harness.js';
import { settleMcp } from '../helpers/settle.js';
import { forms, pinned } from '../helpers/schema-nav.js';
import { HAS_DBT, testDbt } from '../helpers/dbt-env.js';
import { tempDir } from '../helpers/temp-dir.js';

const BASE = fixtureProject('dbt_project'); // a private copy: the test files run side by side
const opts = { timeout: 300000 };

let wh; let backend; let mcpConn; let client; let seq = 0;

const num = (v) => Number(v === '' || v == null ? NaN : v);
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const mapCol = (rows, keyCol, valCol) => Object.fromEntries(rows.map((r) => [String(r[keyCol]), num(r[valCol])]));
const sumCol = (rows, col) => rows.reduce((s, r) => s + (Number.isFinite(num(r[col])) ? num(r[col]) : 0), 0);
const groupCol = (res, metric) => res.columns.map((c) => c.name).find((n) => n !== metric);
/** The validity window of the install record, stated per the calling source's own time column. */

before(async () => {
  if (!HAS_DBT) return;
  wh = await buildWarehouse(BASE);

  const catalog = loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), { profilesDir: BASE, projectDir: BASE });
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: tempDir('mcpe2e'), timeSpineDialect: 'duckdb' });
  backend = testDbt({ profilesDir: BASE });
  const engine = new Engine({ catalog, contextManager: ctxs, runner: backend });

  // The real protocol surface: an MCP server over a transport, and a client on the other end.
  mcpConn = await connectMcp(engine, 'mcp-e2e-test');
  ({ client } = mcpConn);
}, opts);

after(async () => {
  if (mcpConn) await mcpConn.close();
  backend?.close?.();
  if (wh) await wh.stop();
});

const skip = (t) => { if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; } return false; };

/**
 * One MCP tool call, the way an assistant makes it: a call that STARTS work answers with its
 * task_id, and the result is read back with the query tool of its side ({ task_id }, called again
 * while it says running).
 */
function settled(name, args) {
  return settleMcp(client, name, args);
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

/** A whole pipeline over MCP: start → add_steps → materialize. */
async function mcpPipeline(source, steps, name) {
  const s = await call('build_model', { action: 'start', name: name || `e2e_${seq++}`, source });
  for (const step of steps) await call('build_model', { action: 'add_steps', context_id: s.context_id, steps: [step] });
  const built = await call('build_model', { action: 'materialize', context_id: s.context_id });
  assert.equal(built.build?.ok, true, JSON.stringify(built.error || built.build));
  return built;
}

/** A semantic layer over MCP: a build whose only step is its semantic_model step, materialized in the
 *  same call, its parse read back with the tool the answer names. */
async function mcpTask({ name, source, ...step }) {
  const started = await call('build_model', { action: 'start', name, source, steps: [{ stage: 'semantic_model', ...step }], materialize: true });
  assert.ok(started.materialize?.task_id, JSON.stringify(started.materialize));
  const parsed = (await call(started.materialize.read_with, { task_ids: [started.materialize.task_id] })).results[0];
  assert.equal(parsed.parse?.ok, true, JSON.stringify(parsed.parse || parsed.error));
  return started.context_id;
}

// ═══════════ 1. discover → declare → query, the whole governed loop ═══════════

test('1. discovery to a point-in-time metric: spend by install country = 6.75 / 5.00 / 4.00 / 1.75', opts, async (t) => {
  if (skip(t)) return;
  // the protocol advertises the tools an assistant needs…
  const tools = (await client.listTools()).tools.map((x) => x.name);
  for (const needed of ['semantic_index', 'build_model', 'query_model', 'experiment']) {
    assert.ok(tools.includes(needed), `${needed} is advertised`);
  }
  // …and only those: a semantic layer is a build's last step, not a tool of its own — two builders
  // meant the deployment's whole vocabulary twice in every listing.
  for (const gone of ['build_semantic_model', 'build_pipeline_model', 'update_semantic_model']) assert.ok(!tools.includes(gone), `${gone} is no tool`);
  const builder = (await client.listTools()).tools.find((x) => x.name === 'build_model');
  const request = builder.inputSchema.properties.request;
  assert.ok(forms(builder.inputSchema, request).flatMap((f) => pinned(builder.inputSchema, f, 'action')).includes('start'));
  // …the overview names the four sources…
  const overview = await call('semantic_index', {});
  const models = JSON.stringify(overview.models || overview);
  for (const m of ['events', 'crashlytics', 'acquisition', 'users']) assert.match(models, new RegExp(m));
  // …drilling the spend source shows which of its fields are AMOUNTS, with no function fixed…
  const acq = await call('semantic_index', { source: 'acquisition' });
  const amounts = (acq.aggregatable || []).map((a) => a.column);
  for (const f of ['cost', 'impressions', 'clicks']) assert.ok(amounts.includes(f), `${f} is offered as an amount`);
  assert.ok(!(acq.dimensions || []).some((d) => d.name === 'cost'), 'an amount is not a groupable attribute');
  // …and its relationship to the install record is discoverable, not guessed.
  const rel = (acq.relationships || []).find((r) => r.entity === 'user');
  assert.equal(rel.joins, 'users');

  // Declare the metric the discovery pointed at, then answer with it. dim_users is SCD-2, so
  // MetricFlow applies the validity window itself: each spend row is attributed to the install
  // version valid on the spend day.
  const ctx = await mcpTask({
    name: 'e2e_ua', source: 'acquisition',
    join: [{ source: 'users', on: { user: 'player_id_of_internal', time: 'spend_date' } }],
    measures: [{ name: 'cost', expr: { fn: 'sum', args: [{ column: 'cost' }] } }],
    metrics: [{ name: 'cost', type: 'simple', measure: 'cost' }],
  });
  const r = await call('query_model', { context_id: ctx, steps: [{ stage: 'metrics', metrics: ['cost'], group_by: [{ source: 'users', column: 'country' }] }] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const by = mapCol(r.rows, groupCol(r, 'cost'), 'cost');
  assert.ok(near(by.US, 6.75), `US=${by.US}`);
  assert.ok(near(by.GB, 5.0), `GB=${by.GB}`);
  assert.ok(near(by.DE, 4.0), `DE=${by.DE}`);
  assert.ok(near(by.BR, 1.75), `BR=${by.BR}`);
  assert.ok(near(sumCol(r.rows, 'cost'), 17.5), 'and the total is untouched by the join');
});

// ═══════════ 2. four sources in one pipeline, stage by stage ═══════════

test('2. an event → its funnel\'s crash report → the install version then → the spend record of the day: 8 rows', opts, async (t) => {
  if (skip(t)) return;
  const built = await mcpPipeline('events', [
    { stage: 'join', source: 'crashlytics', on: { user: 'player_id_of_internal', funnel: 'tracking_id', format: 'rewarded' }, kind: 'inner', attrs: [{ column: 'crash_id' }] },
    { stage: 'join', source: 'users', on: { user: 'player_id_of_internal', time: 'device_time' }, kind: 'inner', attrs: [{ column: 'country' }] },
    { stage: 'join', source: 'acquisition', on: { user: 'player_id_of_internal', time: 'device_time' }, kind: 'inner', attrs: [{ column: 'acquisition_id' }, { column: 'media_source' }] },
    { stage: 'aggregate', measures: [
      { name: 'n', expr: { fn: 'count' } },
      { name: 'crashes', expr: { fn: 'count_distinct', args: [{ column: 'crash_id' }] } },
      { name: 'events', expr: { fn: 'count_distinct', args: [{ column: 'event_id' }] } },
      { name: 'funnels', expr: { fn: 'count_distinct', args: [{ column: 'tracking_id' }] } },
      { name: 'spend_rows', expr: { fn: 'count_distinct', args: [{ column: 'acquisition_id' }] } },
    ] },
  ]);
  const r = built.rows[0];
  assert.equal(num(r.n), 8, '8 funnel events meet one report each, every one on a spend day');
  assert.equal(num(r.crashes), 4);
  assert.equal(num(r.events), 8);
  assert.equal(num(r.funnels), 4);
  assert.equal(num(r.spend_rows), 4);
  // the rows are a task's result — readable again by its id — and the pipeline tier is named.
  assert.equal(built.tool, 'build_model');
  assert.equal(built.table, built.model);
  assert.equal(built.provenance?.tier, 'pipeline');
});

// ═══════════ 3. the point-in-time contract ═══════════

test('3. the users contract joins the version valid then: 13 attributed rows — and its time is required', opts, async (t) => {
  if (skip(t)) return;
  const built = await mcpPipeline('acquisition', [
    { stage: 'join', source: 'users', on: { user: 'player_id_of_internal', time: 'spend_date' }, kind: 'inner', attrs: [{ column: 'country' }] },
    { stage: 'aggregate', measures: [{ name: 'n', expr: { fn: 'count' } }, { name: 'rows', expr: { fn: 'count_distinct', args: [{ column: 'acquisition_id' }] } }] },
  ]);
  assert.deepEqual({ n: num(built.rows[0].n), distinct: num(built.rows[0].rows) }, { n: 13, distinct: 13 }, 'one install version per spend row');
  // a join that names no moment is refused at the protocol boundary — the key alone would match every version
  const s = await call('build_model', { action: 'start', name: `e2e_${seq++}`, source: 'acquisition' });
  const refused = await callErr('build_model', {
    action: 'add_steps', context_id: s.context_id,
    steps: [{ stage: 'join', source: 'users', on: { user: 'player_id_of_internal' }, attrs: [{ column: 'country' }] }] });
  assert.match(refused.error.message, /missing required property 'time'/);
});

// ═══════════ 4. one relationship, three ad formats ═══════════

test('4. the caller picks the ad format: 8 / 4 / 4 rows, and k1 keeps its funnels apart', opts, async (t) => {
  if (skip(t)) return;
  // ONE build per format: the joined pairs (event, crash) — a table of a few rows, so its row count
  // is the join's size and k1's own pairs are read off the same rows
  const pairsFor = async (format) => mcpPipeline('events', [
    { stage: 'join', source: 'crashlytics', on: { user: 'player_id_of_internal', funnel: 'tracking_id', format }, kind: 'inner', attrs: [{ column: 'crash_id' }] },
    { stage: 'project', keep: ['crash_id', 'event_id'] },
  ]);
  const built = { rewarded: await pairsFor('rewarded'), interstitial: await pairsFor('interstitial'), banner: await pairsFor('banner') };
  assert.equal(num(built.rewarded.row_count), 8, '[rows] rewarded');
  assert.equal(num(built.interstitial.row_count), 4, '[rows] interstitial');
  assert.equal(num(built.banner.row_count), 4, '[rows] banner');

  // u1 crashed having seen a rewarded funnel AND an interstitial one; each format returns its
  // own pair, and the banner column is empty so it returns nothing.
  const idsFor = (format) => {
    assert.equal(built[format].rows.length, num(built[format].row_count), `[k1] every ${format} pair is read back`);
    return new Set(built[format].rows.filter((r) => String(r.crash_id) === 'k1').map((r) => String(r.event_id)));
  };
  assert.deepEqual(idsFor('rewarded'), new Set(['e129', 'e130']), '[k1] its rewarded pair');
  assert.deepEqual(idsFor('interstitial'), new Set(['e131', 'e132']), '[k1] its interstitial pair');
  assert.deepEqual(idsFor('banner'), new Set(), '[k1] no banner funnel');
});

// ═══════════ 5. what the caller asked for is what the caller gets ═══════════

test('5. the attrs contract, enforced at the protocol boundary', opts, async (t) => {
  if (skip(t)) return;
  const start = async () => (await call('build_model', { action: 'start', name: `e2e_${seq++}`, source: 'events' })).context_id;
  const crash = (attrs) => ({ stage: 'join', source: 'crashlytics', on: { user: 'player_id_of_internal', funnel: 'tracking_id', format: 'rewarded' }, ...(attrs ? { attrs } : {}) });

  // (a) no attrs → refused, and the error lists the joined model's attributes — never an amount.
  const missing = await callErr('build_model', {
    action: 'add_steps', context_id: await start(),
    steps: [{ stage: 'join', source: 'acquisition', on: { user: 'player_id_of_internal', time: 'device_time' } }] });
  assert.match(missing.error.message, /missing required property 'attrs' — a list of \{ column, … \}, column one of: .*media_source/s);
  assert.doesNotMatch(missing.error.message, /column one of: [^.]*\bcost\b/);

  // (b) a name the pipeline already carries → refused, with the rename to apply.
  const dup = await callErr('build_model', { action: 'add_steps', context_id: await start(), steps: [crash([{ column: 'event_name' }])] });
  assert.match(dup.error.message, /already has a column named 'event_name'/);
  assert.match(dup.error.message, /name: 'crashlytics_event_name'/);

  // (c) the rename works, and both sides are readable side by side.
  const built = await mcpPipeline('events', [
    { ...crash([{ column: 'event_name', name: 'crashlytics_event_name' }]), kind: 'inner' },
    { stage: 'aggregate', group_by: ['event_name', 'crashlytics_event_name'], measures: [{ name: 'n', expr: { fn: 'count' } }] },
  ]);
  const adSide = {}; const crashSide = {};
  for (const r of built.rows) {
    adSide[String(r.event_name)] = (adSide[String(r.event_name)] || 0) + num(r.n);
    crashSide[String(r.crashlytics_event_name)] = (crashSide[String(r.crashlytics_event_name)] || 0) + num(r.n);
  }
  assert.deepEqual(crashSide, { fatal_crash: 4, non_fatal: 2, anr: 2 });
  assert.deepEqual(adSide, { ad_started: 4, ad_finished: 4 });

  // (d) an unlisted column of the joined model is simply not there.
  const s = await start();
  await call('build_model', { action: 'add_steps', context_id: s, steps: [{ ...crash([{ column: 'crash_id' }]), kind: 'inner' }] });
  const unlisted = await callErr('build_model', {
    action: 'add_steps', context_id: s,
    steps: [{ stage: 'aggregate', measures: [{ name: 'x', expr: { fn: 'count_distinct', args: [{ column: 'issue_title_of_event_data' }] } }] }] });
  assert.match(unlisted.error.message, /unknown column 'issue_title_of_event_data'/);
});

// ═══════════ 6. a funnel, then the segment it converted in ═══════════

test('6. funnel conversion by install country: 12 enter (US 4 / GB 3 / DE 3 / BR 2), 8 reach step 1', opts, async (t) => {
  if (skip(t)) return;
  const built = await mcpPipeline('events', [
    { stage: 'match_recognize',
      partition_by: ['player_id_of_internal'],
      steps: [
        { name: 'launch', event_name: ['first_launch'] },
        { name: 'tut1', event_name: ['tutorial'], where: [{ fn: 'eq', args: [{ column: 'element_of_event_data' }, { value: 'step_1' }] }] },
      ] },
    // after the funnel the per-event time is gone; `first_seen_at` (the funnel's first event) is
    // the instant to attribute the player by.
    { stage: 'join', source: 'users', on: { user: 'player_id_of_internal', time: 'first_seen_at' }, kind: 'inner', attrs: [{ column: 'country' }] },
    { stage: 'aggregate', group_by: ['country', 'reached_tut1'], measures: [{ name: 'n', expr: { fn: 'count' } }] },
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
  // each measure folds its own source's rows; MetricFlow compares them on metric_time
  const ctx = await mcpTask({
    name: 'e2e_mix', source: 'acquisition',
    measures: [{ name: 'cost', expr: { fn: 'sum', args: [{ column: 'cost' }] } }, { name: 'evts', source: 'events', expr: { fn: 'count' } }, { name: 'crashes', source: 'crashlytics', expr: { fn: 'count' } }],
    metrics: [
      { name: 'cost', type: 'simple', measure: 'cost' },
      { name: 'evts', type: 'simple', measure: 'evts' },
      { name: 'crashes', type: 'simple', measure: 'crashes' },
    ],
  });
  const r = await call('query_model', {
    context_id: ctx,
    steps: [{ stage: 'metrics', metrics: ['cost', 'evts', 'crashes'], group_by: [{ time: 'metric_time', grain: 'day' }] }],
  });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  // A day may carry spend but no crash and the other way round, so the series has holes — that
  // is the honest shape of an outer alignment. Each source keeps its own total.
  assert.ok(near(sumCol(r.rows, 'cost'), 17.5), `cost=${sumCol(r.rows, 'cost')}`);
  assert.equal(sumCol(r.rows, 'evts'), 184);
  assert.equal(sumCol(r.rows, 'crashes'), 13);
  assert.ok(r.rows.length > 1, 'a real day-by-day series');
});

// ═══════════ 8. a pipeline result feeding the statistics tool ═══════════

test('8. per-variant aggregates from the warehouse, then significance: control 6/6 vs variant_b 1/6', opts, async (t) => {
  if (skip(t)) return;
  // group sizes: distinct players per assigned variant, straight from the experiments source.
  const sizes = await mcpPipeline('events', [
    { stage: 'join', source: 'experiments', on: { user: 'player_id_of_internal', experiment: 'checkout_flow' }, kind: 'inner', attrs: [{ column: 'variant_group' }] },
    { stage: 'aggregate', group_by: ['variant_group'], measures: [{ name: 'users', expr: { fn: 'count_distinct', args: [{ column: 'player_id_of_internal' }] } }] },
  ]);
  const n = mapCol(sizes.rows, 'variant_group', 'users');
  assert.deepEqual(n, { control: 6, variant_b: 6 });

  // conversions: the same players, scoped to the purchase event.
  const conv = await mcpPipeline('events', [
    { stage: 'where', conditions: [{ fn: 'eq', args: [{ column: 'event_name' }, { value: 'iap_purchase_completed' }] }] },
    { stage: 'join', source: 'experiments', on: { user: 'player_id_of_internal', experiment: 'checkout_flow' }, kind: 'inner', attrs: [{ column: 'variant_group' }] },
    { stage: 'aggregate', group_by: ['variant_group'], measures: [{ name: 'payers', expr: { fn: 'count_distinct', args: [{ column: 'player_id_of_internal' }] } }] },
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

// The slice groups by an attribute of the third model beside a count of the first.
test('9. materialize once, then re-slice the stored result from its task: meta 4 / organic 2 / applovin 2', opts, async (t) => {
  if (skip(t)) return;
  const built = await mcpPipeline('events', [
    { stage: 'join', source: 'crashlytics', on: { user: 'player_id_of_internal', funnel: 'tracking_id', format: 'rewarded' }, kind: 'inner', attrs: [{ column: 'crash_id' }] },
    { stage: 'join', source: 'acquisition', on: { user: 'player_id_of_internal', time: 'device_time' }, kind: 'inner', attrs: [{ column: 'media_source' }] },
  ], `e2e_store_${seq++}`);
  assert.equal(num(built.row_count), 8, 'the row-level result is stored as a table');

  // …and a pipeline started FROM that task aggregates it WITHOUT re-running the joins.
  const slice = async (name, steps) => {
    const d = await call('build_model', { action: 'start', name, from_task: built.task_id });
    await call('build_model', { action: 'add_steps', context_id: d.context_id, steps });
    return call('build_model', { action: 'materialize', context_id: d.context_id });
  };
  const sliced = await slice(`e2e_slice_${seq++}`, [
    { stage: 'aggregate', group_by: ['media_source'], measures: [{ name: 'n', expr: { fn: 'count' } }, { name: 'crashes', expr: { fn: 'count_distinct', args: [{ column: 'crash_id' }] } }] },
  ]);
  assert.deepEqual(mapCol(sliced.rows, 'media_source', 'n'), { meta: 4, organic: 2, applovin: 2 });

  // a filter over the stored result is just as cheap.
  const meta = await slice(`e2e_slice_${seq++}`, [
    { stage: 'where', conditions: [{ fn: 'eq', args: [{ column: 'media_source' }, { value: 'meta' }] }] },
    { stage: 'aggregate', measures: [{ name: 'n', expr: { fn: 'count' } }] },
  ]);
  assert.equal(num(meta.rows[0].n), 4);
  // the stored result itself pages without recomputing
  const page = (await call('query_model', { task_ids: [built.task_id], limit: 5, offset: 5 })).results[0];
  assert.equal(page.rows.length, 3, 'rows 6-8 of 8');
});

// ═══════════ 10. an existing task, extended in place ═══════════

test('10. extend a semantic layer over MCP and re-query: cost 17.50 alongside 64 clicks', opts, async (t) => {
  if (skip(t)) return;
  const ctx = await mcpTask({
    name: 'e2e_grow', source: 'acquisition',
    measures: [{ name: 'cost', expr: { fn: 'sum', args: [{ column: 'cost' }] } }],
    metrics: [{ name: 'cost', type: 'simple', measure: 'cost' }],
  });
  const before = await call('query_model', { context_id: ctx, steps: [{ stage: 'metrics', metrics: ['cost'] }] });
  assert.equal(before.ok, true, JSON.stringify(before.error));
  assert.ok(near(num(before.rows[0].cost), 17.5));
  // a metric query is its steps: its metrics named outside a metrics step are no field of it, refused at
  // the boundary
  const outside = await callErr('query_model', { context_id: ctx, metrics: ['cost'] });
  assert.match(outside.error.message, /invalid input.*unexpected property 'metrics'/s, JSON.stringify(outside));

  // the new metric does not exist yet — the boundary says so rather than answering.
  const tooEarly = await callErr('query_model', { context_id: ctx, steps: [{ stage: 'metrics', metrics: ['clicks'] }] });
  assert.ok(tooEarly.error.message.length > 0, JSON.stringify(tooEarly));

  // add a second amount from the SAME source, choosing its aggregation here and now: the build's
  // semantic_model step edited — the step as preview shows it, with the measure and its metric beside
  // the others — and materialized again
  const { steps } = await call('build_model', { action: 'preview', context_id: ctx });
  const { index, ...layer } = steps.find((st) => st.stage === 'semantic_model');
  await call('build_model', { action: 'edit_step', context_id: ctx, index, step: { ...layer, measures: [...layer.measures, { name: 'clicks', expr: { fn: 'sum', args: [{ column: 'clicks' }] } }], metrics: [...layer.metrics, { name: 'clicks', type: 'simple', measure: 'clicks' }] } });
  const grown = await call('build_model', { action: 'materialize', context_id: ctx });
  assert.equal(grown.parse?.ok, true, JSON.stringify(grown.parse));

  const after = await call('query_model', { context_id: ctx, steps: [{ stage: 'metrics', metrics: ['cost', 'clicks'] }] });
  assert.equal(after.ok, true, JSON.stringify(after.error));
  assert.ok(near(num(after.rows[0].cost), 17.5), 'the original metric is unchanged');
  assert.equal(num(after.rows[0].clicks), 64);

  // the context describes what it now holds — both metrics, one task.
  const described = await call('context', { action: 'describe', context_id: ctx });
  const metrics = JSON.stringify(described.metrics || described);
  assert.match(metrics, /cost/);
  assert.match(metrics, /clicks/);
});
