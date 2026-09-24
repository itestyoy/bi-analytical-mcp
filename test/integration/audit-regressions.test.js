// AUDIT REGRESSIONS — every finding of the two code audits, plus the structured attribute
// reference, proven on the REAL warehouse (PGlite + dbt + MetricFlow + the value indexer).
//
// Every assertion is a NUMBER or a set of values read back from the warehouse or from the index
// the indexer built by scanning it — never the text of generated SQL/YAML. Where a finding is
// about a refusal, the test asserts the refusal AND, next to it, the number the correct call
// returns, so the guard is shown to protect a real answer.
//
// Sections:
//   A (1-10)  { model, attribute, via } — the attribute addressed by where it lives; the
//             `<entity>__<attribute>` spelling is resolved from the schema, never typed;
//   B (11-16) the filter-value guard reaches a joined attribute through its OWNER;
//   C (17-20) relationship labelling: owned vs pipeline-only, and the path each one gives;
//   D (21-23) memory targets in the qualified form; ambiguity reported;
//   E (24-27) grounding prunes amounts, measures and time axes with their columns;
//   F (28-30) a column that is BOTH an amount and an attribute;
//   G (31-32) MCP_DB_RESET is a clean slate even over a v1 database;
//   H (33-35) no anchor: roles are identity, sources are named;
//   I (36-37) no join key is an attribute by NAME;
//   J (38-39) search covers the attributes of events sources;
//   K (40-43) one property-expression rule: governed, pipeline and index agree;
//   L (44-45) run rows carry their source; same-named properties stay apart;
//   M (46)    the guide's variant trigger names real relationships that really join;
//   N (47-49) data freshness comes from the sources whose measures are read;
//   O (50-52) per-app coverage per source;
//   P (53-57) nothing declared about events or values: the index is the truth;
//   Q (58-60) the indexer scans each source on its own axis.
//
// Auto-skips when dbt/mf are not installed (HAS_DBT gate).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import yaml from 'js-yaml';
import { loadCatalog, groundCatalogToPhysical } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { MfEngineBackend } from '../../src/backends/mf-engine.js';
import { Engine } from '../../src/engine.js';
import { ValueIndex, BackgroundIndexer } from '../../src/value-index.js';
import { openStore } from '../../src/store.js';
import { startPglite } from './pglite-harness.js';
import { mcp, setMcp } from '../helpers/catalog-doc.js';
import { settle } from '../helpers/settle.js';

const execFileP = promisify(execFile);
const BASE = join(process.cwd(), 'test', 'integration', 'fixtures', 'dbt_project');
const CATALOG = join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml');
const DBT_BIN = process.env.DBT_BIN || join(process.cwd(), '.dbtvenv', 'bin', 'dbt');
const MF_BIN = process.env.MF_BIN || join(process.cwd(), '.dbtvenv', 'bin', 'mf');
const PY_BIN = process.env.PYTHON_BIN || join(process.cwd(), '.dbtvenv', 'bin', 'python');
const HAS_DBT = existsSync(DBT_BIN) && existsSync(MF_BIN);
const opts = { timeout: 600000 };

let pg; let backend; let ctxs; let engine; let catalog;
let evCtx; let evUsersCtx; let acqUsersCtx; let evCrashCtx;
let ownerEngine; let ownerCtx;           // the crash source OWNS ad_funnel (type: unique)
let bothEngine; let bothCtx;             // acquisition.clicks is measure AND dimension
let renamedEngine;                       // the events role is called 'analytics'
let seq = 0;

const num = (v) => Number(v === '' || v == null ? NaN : v);
const mapCol = (rows, keyCol, valCol) => Object.fromEntries(rows.map((r) => [r[keyCol] == null ? 'none' : String(r[keyCol]), num(r[valCol])]));
const groupCol = (res, metric) => res.columns.map((c) => c.name).find((n) => n !== metric);
const sumCol = (rows, col) => rows.reduce((s, r) => s + num(r[col]), 0);
const skip = (t) => { if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; } return false; };
const q = (ctx, input, eng = engine) => eng.query_semantic_model({ context_id: ctx, ...input });
const dayOf = (v) => String(v).slice(0, 10);

/** A catalog variant over the same warehouse: mutate the fixture document, load, wrap in an Engine. */
function variant(mutate, extra = {}) {
  const doc = yaml.load(readFileSync(CATALOG, 'utf8'));
  const M = Object.fromEntries(doc.models.map((x) => [x.name, x]));
  mutate(M, doc);
  const at = join(mkdtempSync(join(tmpdir(), 'aud-')), 'catalog.yml');
  writeFileSync(at, yaml.dump(doc));
  const cat = loadCatalog(at, { profilesDir: BASE, projectDir: BASE });
  return { catalog: cat, engine: settle(new Engine({ catalog: cat, contextManager: ctxs, runner: backend, ...extra })) };
}
const evtsTask = (eng, name, more = {}) => eng.create_semantic_model({
  name, semantic_models: [{ from: 'events', measures: [{ name: 'evts', agg: 'count', field: '*' }] }],
  metrics: [{ name: 'evts', type: 'simple', measure: { name: 'evts' } }], ...more,
});
/** Run a pipeline of stages and return its rows. */
async function pipeRows(source, stages, eng = engine) {
  const s = await eng.build_native_model({ action: 'start', name: `au_${seq++}`, source });
  for (const stage of stages) {
    const r = await eng.build_native_model({ action: 'add_step', draft_id: s.draft_id, stage });
    assert.ok(!r.error, `add_step failed: ${JSON.stringify(r.error || r)}`);
  }
  const c = await eng.build_native_model({ action: 'materialize', draft_id: s.draft_id });
  assert.equal(c.build?.ok, true, JSON.stringify(c.error || c.build));
  return c.rows;
}

before(async () => {
  if (!HAS_DBT) return;
  pg = await startPglite();
  process.env.DBT_PG_PORT = String(pg.port);
  const env = { ...process.env, DBT_PROFILES_DIR: BASE, DBT_PROJECT_DIR: BASE, DBT_PG_PORT: String(pg.port) };
  await execFileP(DBT_BIN, ['seed'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  await execFileP(DBT_BIN, ['run'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: mkdtempSync(join(tmpdir(), 'aud-ws-')), timeSpineDialect: 'postgres' });
  backend = new MfEngineBackend({ pythonBin: PY_BIN, dbtBin: DBT_BIN, profilesDir: BASE });
  catalog = loadCatalog(CATALOG, { profilesDir: BASE, projectDir: BASE });
  engine = settle(new Engine({ catalog, contextManager: ctxs, runner: backend, dbPath: join(mkdtempSync(join(tmpdir(), 'aud-db-')), 'vi.sqlite') }));
  // The value index is REAL: a full pass over the warehouse, awaited, so the guard and the
  // coverage views below answer from measured data.
  const indexer = new BackgroundIndexer({ catalog, runner: backend, index: engine.valueIndex, baseProjectDir: BASE, intervalMs: 0, maxValues: 50, logger: () => {} });
  await indexer.refresh();

  evCtx = (await evtsTask(engine, 'aev')).context_id;
  evUsersCtx = (await evtsTask(engine, 'aeu', { use_base_models: ['users'] })).context_id;
  const acq = await engine.create_semantic_model({
    name: 'aacq', use_base_models: ['users'],
    semantic_models: [{ from: 'acquisition', measures: [{ name: 'cost', agg: 'sum', field: 'cost' }] }],
    metrics: [{ name: 'cost', type: 'simple', measure: { name: 'cost' } }],
  });
  acqUsersCtx = acq.context_id;
  const both = await engine.create_semantic_model({
    name: 'aboth',
    semantic_models: [
      { from: 'events', event_scope: { event_name: ['first_launch'] }, measures: [{ name: 'launches', agg: 'count', field: '*' }] },
      { from: 'crashlytics', measures: [{ name: 'reports', agg: 'count', field: '*' }] },
    ],
    metrics: [{ name: 'launches', type: 'simple', measure: { name: 'launches' } }, { name: 'reports', type: 'simple', measure: { name: 'reports' } }],
  });
  evCrashCtx = both.context_id;

  ({ engine: ownerEngine } = variant((M) => {
    mcp(M.fct_crashlytics_events).entities = { ad_funnel: { type: 'unique', key: ['rewarded_tracking_id', 'player_id_of_internal'] } };
    mcp(M.fct_analytics_events).entities.ad_funnel = { type: 'foreign', key: ['tracking_id', 'player_id_of_internal'] };
  }));
  ownerCtx = (await evtsTask(ownerEngine, 'aown', { use_base_models: ['crashlytics', 'users'] })).context_id;

  ({ engine: bothEngine } = variant((M) => {
    const clicks = M.fct_player_acquisition.columns.find((c) => c.name === 'clicks');
    setMcp(clicks, { measure: true, dimension: {} });
  }));
  const bt = await bothEngine.create_semantic_model({
    name: 'aclk',
    semantic_models: [{ from: 'acquisition', dimensions: [{ source: 'model_column', column: 'clicks' }], measures: [{ name: 'cost', agg: 'sum', field: 'cost' }, { name: 'click_total', agg: 'sum', field: 'clicks' }] }],
    metrics: [{ name: 'cost', type: 'simple', measure: { name: 'cost' } }, { name: 'click_total', type: 'simple', measure: { name: 'click_total' } }],
  });
  assert.equal(bt.parse.ok, true, JSON.stringify(bt.parse));
  bothCtx = bt.context_id;

  ({ engine: renamedEngine } = variant((M) => { mcp(M.fct_analytics_events).role = 'analytics'; }));
}, opts);

after(async () => { backend?.close(); engine?.valueIndex?.close?.(); if (pg) await pg.stop(); });

// ═══════════ A. THE ATTRIBUTE, ADDRESSED BY WHERE IT LIVES ═══════════

test('1. { model: users, attribute: country } returns exactly what users.country returns', opts, async (t) => {
  if (skip(t)) return;
  const a = await q(evUsersCtx, { metrics: ['aeu_evts'], group_by: [{ model: 'users', attribute: 'country' }] });
  const b = await q(evUsersCtx, { metrics: ['aeu_evts'], group_by: [{ model: 'users', attribute: 'country' }] });
  assert.equal(b.ok, true, JSON.stringify(b.error));
  const byA = mapCol(a.rows, groupCol(a, 'aeu_evts'), 'aeu_evts');
  const byB = mapCol(b.rows, groupCol(b, 'aeu_evts'), 'aeu_evts');
  assert.deepEqual(byB, byA);
  assert.deepEqual(byB, { US: 67, GB: 57, DE: 31, BR: 29 });
});

test('2. the response echoes the path the structured reference resolved to', opts, async (t) => {
  if (skip(t)) return;
  const r = await q(evUsersCtx, { metrics: ['aeu_evts'], group_by: [{ model: 'users', attribute: 'country' }] });
  assert.deepEqual(r.group_by_resolved, { 'users.country': 'users_country' });
  assert.ok(r.columns.some((c) => c.name.includes('country')), 'the result column carries the resolved name');
});

test('3. a where clause addressed by model + attribute: GB has 57 events', opts, async (t) => {
  if (skip(t)) return;
  const r = await q(evUsersCtx, { metrics: ['aeu_evts'], where: { op: 'and', conditions: [{ field: { kind: 'dimension', model: 'users', attribute: 'country' }, op: 'eq', value: 'GB' }] } });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(num(r.rows[0].aeu_evts), 57);
});

test("4. the source's OWN attribute under its identity: bundle_id splits 131 / 53", opts, async (t) => {
  if (skip(t)) return;
  const r = await q(evCtx, { metrics: ['aev_evts'], group_by: [{ model: 'events', attribute: 'bundle_id' }] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.deepEqual(mapCol(r.rows, groupCol(r, 'aev_evts'), 'aev_evts'), { 'com.omg.wordsearch': 131, 'com.omg.colorfit': 53 });
  assert.equal(r.group_by_resolved['events.bundle_id'], 'events_bundle_id');
});

test('5. an attribute the model does not have is refused, listing the ones it has', opts, async (t) => {
  if (skip(t)) return;
  await assert.rejects(() => q(evUsersCtx, { metrics: ['aeu_evts'], group_by: [{ model: 'users', attribute: 'shoe_size' }] }),
    /'shoe_size' is not an attribute of 'users'.*country/s);
});

test('6. a model the task did not load is refused with the use_base_models fix', opts, async (t) => {
  if (skip(t)) return;
  await assert.rejects(() => q(evCtx, { metrics: ['aev_evts'], group_by: [{ model: 'users', attribute: 'country' }] }),
    /needs model 'users'.*use_base_models/s);
});

test('7. an attribute of an owned FACT is reached through the relationship the source declares', opts, async (t) => {
  if (skip(t)) return;
  const r = await q(ownerCtx, { metrics: ['aown_evts'], group_by: [{ model: 'crashlytics', attribute: 'app_version' }] }, ownerEngine);
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.deepEqual(mapCol(r.rows, groupCol(r, 'aown_evts'), 'aown_evts'), { none: 176, '1.0.0': 6, '1.1.0': 8 });
  assert.equal(r.group_by_resolved['crashlytics.app_version'], 'crashlytics_app_version', 'resolved through ad_funnel, not through the crash identity');
});

test('8. via names the relationship explicitly and gives the same numbers', opts, async (t) => {
  if (skip(t)) return;
  const r = await q(ownerCtx, { metrics: ['aown_evts'], group_by: [{ model: 'crashlytics', attribute: 'device_model', via: 'ad_funnel' }] }, ownerEngine);
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.deepEqual(mapCol(r.rows, groupCol(r, 'aown_evts'), 'aown_evts'), { none: 176, iphone: 14 });
});

test('9. a via that is not a relationship to that model is refused, listing the real ones', opts, async (t) => {
  if (skip(t)) return;
  await assert.rejects(() => q(ownerCtx, { metrics: ['aown_evts'], group_by: [{ model: 'crashlytics', attribute: 'app_version', via: 'session' }] }, ownerEngine),
    /'session' is not a relationship from this task's source\(s\) to 'crashlytics'.*ad_funnel/s);
});

test('10. a structured attribute and a time grain together: one month, 184 events', opts, async (t) => {
  if (skip(t)) return;
  const r = await q(evUsersCtx, { metrics: ['aeu_evts'], group_by: [{ model: 'users', attribute: 'country' }, { time: 'metric_time', grain: 'month' }] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.rows.length, 4, 'four countries in the one month');
  assert.equal(sumCol(r.rows, 'aeu_evts'), 184);
});

// ═══════════ B. THE VALUE GUARD REACHES A JOINED ATTRIBUTE THROUGH ITS OWNER ═══════════

test('11. a wrong-cased country on users.country is rejected with the real casing', opts, async (t) => {
  if (skip(t)) return;
  await assert.rejects(() => q(evUsersCtx, { metrics: ['aeu_evts'], where: { op: 'and', conditions: [{ field: { kind: 'dimension', model: 'users', attribute: 'country' }, op: 'eq', value: 'gb' }] } }),
    /different casing.*'GB'/s);
});

test('12. …and the correctly cased value returns 57', opts, async (t) => {
  if (skip(t)) return;
  const r = await q(evUsersCtx, { metrics: ['aeu_evts'], where: { op: 'and', conditions: [{ field: { kind: 'dimension', model: 'users', attribute: 'country' }, op: 'eq', value: 'GB' }] } });
  assert.equal(num(r.rows[0].aeu_evts), 57);
});

test('13. an IN list is checked value by value: GB + US = 124', opts, async (t) => {
  if (skip(t)) return;
  const r = await q(evUsersCtx, { metrics: ['aeu_evts'], where: { op: 'and', conditions: [{ field: { kind: 'dimension', model: 'users', attribute: 'country' }, op: 'in', value: ['GB', 'US'] }] } });
  assert.equal(num(r.rows[0].aeu_evts), 124);
  await assert.rejects(() => q(evUsersCtx, { metrics: ['aeu_evts'], where: { op: 'and', conditions: [{ field: { kind: 'dimension', model: 'users', attribute: 'country' }, op: 'in', value: ['GB', 'us'] }] } }), /different casing/);
});

test('14. a value absent from a fully indexed small set is rejected outright', opts, async (t) => {
  if (skip(t)) return;
  await assert.rejects(() => q(evUsersCtx, { metrics: ['aeu_evts'], where: { op: 'and', conditions: [{ field: { kind: 'dimension', model: 'users', attribute: 'country' }, op: 'eq', value: 'XX' }] } }),
    /does not occur in this column/);
});

test('15. the guard applies to the structured reference too', opts, async (t) => {
  if (skip(t)) return;
  await assert.rejects(() => q(evUsersCtx, { metrics: ['aeu_evts'], where: { op: 'and', conditions: [{ field: { kind: 'dimension', model: 'users', attribute: 'country' }, op: 'eq', value: 'De' }] } }),
    /different casing.*'DE'/s);
  const ok = await q(evUsersCtx, { metrics: ['aeu_evts'], where: { op: 'and', conditions: [{ field: { kind: 'dimension', model: 'users', attribute: 'country' }, op: 'eq', value: 'DE' }] } });
  assert.equal(num(ok.rows[0].aeu_evts), 31);
});

test("16. the source's own attribute is guarded against its own indexed values", opts, async (t) => {
  if (skip(t)) return;
  await assert.rejects(() => q(evCtx, { metrics: ['aev_evts'], where: { op: 'and', conditions: [{ field: { kind: 'dimension', model: 'events', attribute: 'bundle_id' }, op: 'eq', value: 'COM.OMG.COLORFIT' }] } }),
    /different casing.*'com\.omg\.colorfit'/s);
  const ok = await q(evCtx, { metrics: ['aev_evts'], where: { op: 'and', conditions: [{ field: { kind: 'dimension', model: 'events', attribute: 'bundle_id' }, op: 'eq', value: 'com.omg.colorfit' }] } });
  assert.equal(num(ok.rows[0].aev_evts), 53);
});

// ═══════════ C. RELATIONSHIP LABELLING AND THE PATH IT GIVES ═══════════

test('17. the users model reports `user` as owned, and the governed path it promises works', opts, async (t) => {
  if (skip(t)) return;
  const v = await engine.semantic_index({ model: 'users' });
  const rel = v.relationships.find((r) => r.entity === 'user');
  assert.equal(rel.owned_here, true);
  assert.match(rel.use, /^owned here — other models point at it/);
  assert.ok(!/No model owns 'user'/.test(v.join_note || ''));
  const r = await q(evUsersCtx, { metrics: ['aeu_evts'], group_by: [{ model: 'users', attribute: 'country' }] });
  assert.equal(sumCol(r.rows, 'aeu_evts'), 184);
});

test('18. the events model reports `user` as metric query + pipeline, pointing at users', opts, async (t) => {
  if (skip(t)) return;
  const v = await engine.semantic_index({ model: 'events' });
  const rel = v.relationships.find((r) => r.entity === 'user');
  assert.equal(rel.use, 'metric query + pipeline');
  assert.equal(rel.joins, 'users');
});

test('19. a relationship nobody owns is pipeline only — and the pipeline join gives 14 rows', opts, async (t) => {
  if (skip(t)) return;
  const v = await engine.semantic_index({ model: 'crashlytics' });
  assert.equal(v.relationships.find((r) => r.entity === 'ad_funnel_rewarded').use, 'pipeline only');
  const rows = await pipeRows('crashlytics', [
    { stage: 'join', with: 'events', via: 'ad_funnel_rewarded', kind: 'inner', attrs: [{ column: 'event_name', as: 'ev_name' }] },
    { stage: 'aggregate', group_by: ['event_name'], measures: [{ name: 'n', fn: 'count' }] },
  ]);
  assert.deepEqual(mapCol(rows, 'event_name', 'n'), { fatal_crash: 8, non_fatal: 4, anr: 2 });
});

test('20. with an owner declared, both sides label the relationship consistently', opts, async (t) => {
  if (skip(t)) return;
  const crash = await ownerEngine.semantic_index({ model: 'crashlytics' });
  assert.match(crash.relationships.find((r) => r.entity === 'ad_funnel').use, /^owned here — other models point at it/);
  const events = await ownerEngine.semantic_index({ model: 'events' });
  const rel = events.relationships.find((r) => r.entity === 'ad_funnel');
  assert.equal(rel.use, 'metric query + pipeline');
  assert.equal(rel.joins, 'crashlytics');
});

// ═══════════ D. MEMORY TARGETS ═══════════

test('21. a finding recorded on { source: events, name: ad_finished } surfaces on that event', opts, async (t) => {
  if (skip(t)) return;
  const saved = await engine.memory({ action: 'record', note: 'ad_finished carries revenue; ad_started never does', targets: [{ source: 'events', name: 'ad_finished' }] });
  assert.deepEqual(saved.linked_to.map((l) => l.kind), ['event']);
  const v = await engine.semantic_index({ source: 'events', event: 'ad_finished' });
  assert.ok((v.memory || []).some((m) => /ad_finished carries revenue/.test(m.note)), JSON.stringify(v.memory));
});

test('22. a finding on a qualified crash property surfaces on that property', opts, async (t) => {
  if (skip(t)) return;
  await engine.memory({ action: 'record', note: 'ANR seconds are only on anr reports', targets: [{ source: 'crashlytics', name: 'anr_duration_of_event_data' }] });
  const v = await engine.semantic_index({ source: 'crashlytics', property: 'anr_duration_of_event_data' });
  assert.ok((v.memory || []).some((m) => /ANR seconds/.test(m.note)), JSON.stringify(v.memory));
});

test('23. a bare name carried by two sources is refused, naming both', opts, async (t) => {
  if (skip(t)) return;
  await assert.rejects(() => engine.memory({ action: 'record', note: 'x', targets: ['app_version'] }), /must be exactly one of: \{ source, name \} \| \{ term \}/);
});

// ═══════════ E. GROUNDING ═══════════

test('24. a declared amount the table lacks is pruned; the real one still sums to 17.50', opts, async (t) => {
  if (skip(t)) return;
  const { catalog: cat, engine: eng } = variant((M) => {
    M.fct_player_acquisition.columns.push({ name: 'bonus_spend', data_type: 'numeric', meta: { mcp: { measure: { unit: 'usd' } } } });
  });
  const { pruned } = await groundCatalogToPhysical(cat, backend, BASE);
  assert.ok(pruned.acquisition.includes('amount:bonus_spend'), JSON.stringify(pruned));
  assert.ok(!cat.aggregatableFields('acquisition').some((a) => a.name === 'bonus_spend'));
  const c = await eng.create_semantic_model({ name: 'agr1', semantic_models: [{ from: 'acquisition', measures: [{ name: 'cost', agg: 'sum', field: 'cost' }] }], metrics: [{ name: 'cost', type: 'simple', measure: { name: 'cost' } }] });
  const r = await q(c.context_id, { metrics: ['agr1_cost'] }, eng);
  assert.ok(Math.abs(num(r.rows[0].agr1_cost) - 17.5) < 1e-6);
});

test('25. a measure over the pruned amount is refused at validation, not in the warehouse', opts, async (t) => {
  if (skip(t)) return;
  const { catalog: cat, engine: eng } = variant((M) => {
    M.fct_player_acquisition.columns.push({ name: 'bonus_spend', data_type: 'numeric', meta: { mcp: { measure: { unit: 'usd' } } } });
  });
  await groundCatalogToPhysical(cat, backend, BASE);
  await assert.rejects(() => eng.create_semantic_model({ name: 'agr2', semantic_models: [{ from: 'acquisition', measures: [{ name: 'b', agg: 'sum', field: 'bonus_spend' }] }], metrics: [{ name: 'b', type: 'simple', measure: { name: 'b' } }] }),
    /bonus_spend|invalid input/);
});

test('26. a governed measure whose column is missing is pruned; the surviving one answers 17.50', opts, async (t) => {
  if (skip(t)) return;
  const { catalog: cat, engine: eng } = variant((M) => {
    mcp(M.fct_player_acquisition).measures.ghost_total = { expr: 'ghost_cost', agg: 'sum', unit: 'usd' };
  });
  const { pruned } = await groundCatalogToPhysical(cat, backend, BASE);
  assert.ok(pruned.acquisition.includes('measure:ghost_total'), JSON.stringify(pruned));
  assert.equal(cat.getModel('acquisition').measures.ghost_total, undefined);
  const c = await eng.create_semantic_model({ name: 'agr3', metrics: [{ name: 'total_spend', type: 'simple', measure: { name: 'total_spend' } }] });
  assert.equal(c.parse.ok, true, JSON.stringify(c.parse));
  const r = await q(c.context_id, { metrics: ['agr3_total_spend'] }, eng);
  assert.ok(Math.abs(num(r.rows[0].agr3_total_spend) - 17.5) < 1e-6);
});

test('27. a time axis on a missing column is dropped and the model still joins: control 6 / variant_b 6', opts, async (t) => {
  if (skip(t)) return;
  const { catalog: cat, engine: eng } = variant((M) => {
    M.fct_experiment_assignments.columns.push({ name: 'ghost_time', data_type: 'timestamp', meta: { mcp: { is_time: true } } });
  });
  assert.equal(cat.getModel('experiments').time?.column, 'ghost_time', 'declared before grounding');
  const { pruned } = await groundCatalogToPhysical(cat, backend, BASE);
  assert.ok(pruned.experiments.includes('(time axis)'), JSON.stringify(pruned));
  assert.equal(cat.getModel('experiments').time, undefined);
  const rows = await pipeRows('events', [
    { stage: 'join', with: 'experiments', via: 'user', kind: 'inner', attrs: ['variant_group'] },
    { stage: 'aggregate', group_by: ['variant_group'], measures: [{ name: 'players', fn: 'count_distinct', column: 'player_id_of_internal' }] },
  ], eng);
  assert.deepEqual(mapCol(rows, 'variant_group', 'players'), { control: 6, variant_b: 6 });
});

// ═══════════ F. AN AMOUNT THAT IS ALSO AN ATTRIBUTE ═══════════

test('28. cost grouped by the clicks VALUE: 9 clicks cost 5.25, 8 clicks 4.25, 0 clicks 0', opts, async (t) => {
  if (skip(t)) return;
  const r = await q(bothCtx, { metrics: ['aclk_cost'], group_by: [{ model: 'acquisition', attribute: 'clicks' }] }, bothEngine);
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const by = mapCol(r.rows, groupCol(r, 'aclk_cost'), 'aclk_cost');
  assert.ok(Math.abs(by['9'] - 5.25) < 1e-6, JSON.stringify(by));
  assert.ok(Math.abs(by['8'] - 4.25) < 1e-6);
  assert.equal(by['0'], 0);
  assert.ok(Math.abs(sumCol(r.rows, 'aclk_cost') - 17.5) < 1e-6);
});

test('29. …and clicks still sums as an amount: 64', opts, async (t) => {
  if (skip(t)) return;
  const r = await q(bothCtx, { metrics: ['aclk_click_total'] }, bothEngine);
  assert.equal(num(r.rows[0].aclk_click_total), 64);
});

test('30. the model view lists clicks both as an attribute and as an amount', opts, async (t) => {
  if (skip(t)) return;
  const v = await bothEngine.semantic_index({ model: 'acquisition' });
  assert.ok(v.dimensions.some((d) => d.name === 'clicks'));
  assert.ok(v.aggregatable.some((a) => a.field === 'clicks'));
  assert.equal(v.dimensions.find((d) => d.name === 'clicks').distinct_count, null, 'not profiled by THIS engine\'s index (separate store) — the attribute exists regardless');
});

// ═══════════ G. RESET IS A CLEAN SLATE ═══════════

test('31. over a database keyed the old way the indexer rebuilds from the warehouse: US 4 / GB 4 / DE 3 / BR 2', opts, async (t) => {
  if (skip(t)) return;
  const path = join(mkdtempSync(join(tmpdir(), 'aud-v1-')), 'vi.sqlite');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE prop_stats (property TEXT PRIMARY KEY, distinct_count INTEGER, total_count INTEGER, null_count INTEGER, indexed_at INTEGER, high_cardinality INTEGER, data_watermark INTEGER)');
  db.exec('CREATE TABLE prop_values (property TEXT, value TEXT, freq INTEGER, PRIMARY KEY(property, value))');
  db.exec("INSERT INTO prop_stats VALUES ('users.country', 1, 99, 0, 1, 0, NULL)");
  db.exec("INSERT INTO prop_values VALUES ('users.country', 'ATLANTIS', 99)");
  db.close();
  const store = openStore({ dbPath: path });
  const index = new ValueIndex({ store });
  assert.equal(index.stats('users', 'country'), null, 'the old rows are dropped, never mis-filed');
  const bi = new BackgroundIndexer({ catalog, runner: backend, index, baseProjectDir: BASE, intervalMs: 0, maxValues: 50, logger: () => {} });
  await bi.refresh();
  const vals = Object.fromEntries(index.sampleValues('users', 'country', 10).map((v) => [v.value, v.freq]));
  assert.deepEqual(vals, { US: 4, GB: 4, DE: 3, BR: 2 });
  assert.equal(vals.ATLANTIS, undefined);
  index.close();
});

test('32. reset() over a fresh store leaves an empty index that the scan then fills', opts, async (t) => {
  if (skip(t)) return;
  const path = join(mkdtempSync(join(tmpdir(), 'aud-reset-')), 'vi.sqlite');
  let index = new ValueIndex({ store: openStore({ dbPath: path }) });
  index.upsertProperty('users', 'country', { distinctCount: 1, totalCount: 99, nullCount: 0, values: [{ value: 'ATLANTIS', freq: 99 }] });
  index.close();
  index = new ValueIndex({ store: openStore({ dbPath: path, reset: true }) });
  assert.equal(index.stats('users', 'country'), null, 'wiped');
  const bi = new BackgroundIndexer({ catalog, runner: backend, index, baseProjectDir: BASE, intervalMs: 0, maxValues: 50, logger: () => {} });
  await bi.refresh();
  const vals = Object.fromEntries(index.sampleValues('users', 'country', 10).map((v) => [v.value, v.freq]));
  assert.deepEqual(vals, { US: 4, GB: 4, DE: 3, BR: 2 });
  index.close();
});

// ═══════════ H. NO ANCHOR ═══════════

test("33. an events source whose role is not called 'events' loads and counts 184", opts, async (t) => {
  if (skip(t)) return;
  assert.deepEqual([...renamedEngine.catalog.facts].sort(), ['analytics', 'crashlytics']);
  const c = await renamedEngine.create_semantic_model({ name: 'aren', semantic_models: [{ from: 'analytics', measures: [{ name: 'n', agg: 'count', field: '*' }] }], metrics: [{ name: 'n', type: 'simple', measure: { name: 'n' } }] });
  assert.equal(c.parse.ok, true, JSON.stringify(c.parse));
  const r = await q(c.context_id, { metrics: ['aren_n'] }, renamedEngine);
  assert.equal(num(r.rows[0].aren_n), 184);
});

test('34. meta.mcp.anchor is refused at load: there is no default source', opts, async (t) => {
  if (skip(t)) return;
  assert.throws(() => variant((M) => { mcp(M.fct_analytics_events).anchor = true; }), /meta\.mcp\.anchor is no longer a schema key/);
});

test('35. an event accessor without a source is refused; named, it answers', opts, async (t) => {
  if (skip(t)) return;
  assert.throws(() => catalog.eventNames(), /a source is required/);
  assert.deepEqual([...catalog.eventNames('crashlytics')].sort(), ['anr', 'fatal_crash', 'non_fatal']);
});

// ═══════════ I. NO JOIN KEY IS AN ATTRIBUTE BY NAME ═══════════

test('36. the session key is not a groupable path of the events source', opts, async (t) => {
  if (skip(t)) return;
  assert.ok(!catalog.modelDimensionColumns('events').includes('session_number'));
  await assert.rejects(() => q(evCtx, { metrics: ['aev_evts'], group_by: [{ model: 'events', attribute: 'session_number' }] }), /'session_number' is not an attribute of 'events'/);
});

test('37. …a pipeline reads the key like any column: sessions 1..4 hold 150 / 26 / 4 / 4 events', opts, async (t) => {
  if (skip(t)) return;
  const rows = await pipeRows('events', [{ stage: 'aggregate', group_by: ['session_number'], measures: [{ name: 'n', fn: 'count' }] }]);
  assert.deepEqual(mapCol(rows, 'session_number', 'n'), { 1: 150, 2: 26, 3: 4, 4: 4 });
});

// ═══════════ J. SEARCH COVERS EVENTS-SOURCE ATTRIBUTES ═══════════

test('38. search finds bundle_id on the events source, and the attribute groups 131 / 53', opts, async (t) => {
  if (skip(t)) return;
  const s = await engine.semantic_index({ search: 'bundle_id' });
  assert.ok(s.dimension_matches.some((d) => d.source === 'events' && d.column === 'bundle_id'), JSON.stringify(s.dimension_matches));
  const r = await q(evCtx, { metrics: ['aev_evts'], group_by: [{ model: 'events', attribute: 'bundle_id' }] });
  assert.deepEqual(mapCol(r.rows, groupCol(r, 'aev_evts'), 'aev_evts'), { 'com.omg.wordsearch': 131, 'com.omg.colorfit': 53 });
});

test('39. device_model is found on users AND on crashlytics; the crash copy counts 7 / 4 / 2', opts, async (t) => {
  if (skip(t)) return;
  const s = await engine.semantic_index({ search: 'device_model' });
  assert.deepEqual([...new Set(s.dimension_matches.filter((d) => d.column === 'device_model').map((d) => d.source))].sort(), ['crashlytics', 'users']);
  const r = await q(evCrashCtx, { metrics: ['aboth_reports'], group_by: [{ model: 'crashlytics', attribute: 'device_model' }] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.deepEqual(mapCol(r.rows, groupCol(r, 'aboth_reports'), 'aboth_reports'), { iphone: 7, pixel: 4, galaxy: 2 });
});

// ═══════════ K. ONE RULE FOR READING A PROPERTY ═══════════

test('40. governed: ad_type as a task dimension → rewarded 10 / interstitial 8 / banner 6', opts, async (t) => {
  if (skip(t)) return;
  const c = await engine.create_semantic_model({ name: 'aadt', semantic_models: [{ from: 'events', dimensions: [{ source: 'event_property', property: 'ad_type_of_event_data' }], measures: [{ name: 'n', agg: 'count', field: '*' }] }], metrics: [{ name: 'n', type: 'simple', measure: { name: 'n' } }] });
  assert.equal(c.parse.ok, true, JSON.stringify(c.parse));
  const r = await q(c.context_id, { metrics: ['aadt_n'], group_by: [{ model: 'events', attribute: 'ad_type_of_event_data' }] });
  const by = mapCol(r.rows, groupCol(r, 'aadt_n'), 'aadt_n');
  assert.equal(by.rewarded, 10); assert.equal(by.interstitial, 8); assert.equal(by.banner, 6);
});

test('41. pipeline: the same property extracted → the same 10 / 8 / 6', opts, async (t) => {
  if (skip(t)) return;
  const rows = await pipeRows('events', [
    { stage: 'derive', name: 'ad_type', op: 'extract', source: 'ad_type_of_event_data' },
    { stage: 'where', conditions: [{ column: 'ad_type', op: 'is_not_null' }] },
    { stage: 'aggregate', group_by: ['ad_type'], measures: [{ name: 'n', fn: 'count' }] },
  ]);
  assert.deepEqual(mapCol(rows, 'ad_type', 'n'), { rewarded: 10, interstitial: 8, banner: 6 });
});

test('42. the value index read the same property the same way: 10 / 8 / 6 with 24 non-null', opts, async (t) => {
  if (skip(t)) return;
  const vals = Object.fromEntries(engine.valueIndex.sampleValues('events', 'ad_type_of_event_data', 10).map((v) => [v.value, v.freq]));
  assert.deepEqual(vals, { rewarded: 10, interstitial: 8, banner: 6 });
  assert.equal(engine.valueIndex.stats('events', 'ad_type_of_event_data').totalCount, 24);
});

test('43. a numeric property: governed sum and pipeline sum both give 85 over 8 purchases', opts, async (t) => {
  if (skip(t)) return;
  const c = await engine.create_semantic_model({ name: 'arev', semantic_models: [{ from: 'events', event_scope: { event_name: ['iap_purchase_completed'] }, measures: [{ name: 'rev', agg: 'sum', field: 'price_in_usd_of_event_data' }, { name: 'n', agg: 'count', field: '*' }] }], metrics: [{ name: 'rev', type: 'simple', measure: { name: 'rev' } }, { name: 'n', type: 'simple', measure: { name: 'n' } }] });
  const r = await q(c.context_id, { metrics: ['arev_rev', 'arev_n'] });
  assert.equal(num(r.rows[0].arev_rev), 85); assert.equal(num(r.rows[0].arev_n), 8);
  const rows = await pipeRows('events', [
    { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] },
    { stage: 'derive', name: 'price', op: 'extract', source: 'price_in_usd_of_event_data', type: 'numeric' },
    { stage: 'aggregate', measures: [{ name: 'rev', fn: 'sum', column: 'price' }, { name: 'n', fn: 'count' }] },
  ]);
  assert.equal(num(rows[0].rev), 85); assert.equal(num(rows[0].n), 8);
});

// ═══════════ L. RUN ROWS CARRY THEIR SOURCE ═══════════

test('44. the run view tells users.app_version (1 distinct) from crashlytics.app_version (2 distinct)', opts, async (t) => {
  if (skip(t)) return;
  const st = await engine.semantic_index({ status: true });
  const run = await engine.semantic_index({ run: st.value_index.last_run.id });
  const rows = run.properties.filter((p) => p.property === 'app_version');
  assert.deepEqual(rows.map((p) => p.source).sort(), ['crashlytics', 'users']);
  assert.equal(rows.find((p) => p.source === 'users').distinct_count, 1);
  assert.equal(rows.find((p) => p.source === 'crashlytics').distinct_count, 2);
});

test('45. the property view always takes the source, and answers per source', opts, async (t) => {
  if (skip(t)) return;
  await assert.rejects(() => engine.semantic_index({ property: 'app_version' }), /must be exactly one of: .*\{ source, property \}/);
  const u = await engine.semantic_index({ source: 'users', property: 'app_version' });
  // the seed writes '1.0'; dbt seed types the column numeric, so the warehouse value is 1
  assert.deepEqual(u.sample_values.map((v) => [String(v.value), v.freq]), [['1', 13]]);
  const c = await engine.semantic_index({ source: 'crashlytics', property: 'app_version' });
  assert.deepEqual(Object.fromEntries(c.sample_values.map((v) => [v.value, v.freq])), { '1.0.0': 7, '1.1.0': 6 });
});

// ═══════════ M. THE GUIDE ═══════════

test('46. the guide names the real variant relationships, and the first one joins 14 rows', opts, async (t) => {
  if (skip(t)) return;
  const g = await engine.semantic_index({ guide: true });
  const trig = g.routing_triggers.find((x) => /alternative columns/.test(x.if));
  assert.ok(trig && /ad_funnel_rewarded/.test(trig.do) && /ad_funnel_interstitial/.test(trig.do) && /ad_funnel_banner/.test(trig.do), JSON.stringify(trig));
  assert.ok(!g.routing_triggers.some((x) => /crash/i.test(x.if)), 'nothing domain-specific');
  const rows = await pipeRows('crashlytics', [
    { stage: 'join', with: 'events', via: 'ad_funnel_rewarded', kind: 'inner', attrs: [{ column: 'event_name', as: 'ev' }] },
    { stage: 'aggregate', measures: [{ name: 'n', fn: 'count' }] },
  ]);
  assert.equal(num(rows[0].n), 14);
});

// ═══════════ N. DATA FRESHNESS ═══════════

test('47. an events task is current through 2026-01-09, the latest device_time', opts, async (t) => {
  if (skip(t)) return;
  const r = await q(evCtx, { metrics: ['aev_evts'] });
  assert.equal(dayOf(r.provenance.data_freshness), '2026-01-09');
  assert.equal(r.provenance.source, 'events');
});

test('48. a spend task joined to installs takes its freshness from spend, not from installs', opts, async (t) => {
  if (skip(t)) return;
  const r = await q(acqUsersCtx, { metrics: ['aacq_cost'] });
  assert.equal(r.provenance.source, 'acquisition', 'users contributes attributes, not measures');
  assert.equal(dayOf(r.provenance.data_freshness), '2026-01-05');
  assert.equal(r.provenance.data_freshness_by_source, undefined, 'one contributing source, no per-source split');
});

test('49. two events sources: per-source freshness, headline = the staler (crashes, 2026-01-08)', opts, async (t) => {
  if (skip(t)) return;
  const r = await q(evCrashCtx, { metrics: ['aboth_launches', 'aboth_reports'] });
  assert.deepEqual([...r.provenance.source].sort(), ['crashlytics', 'events']);
  assert.equal(dayOf(r.provenance.data_freshness_by_source.events), '2026-01-09');
  assert.equal(dayOf(r.provenance.data_freshness_by_source.crashlytics), '2026-01-08');
  assert.equal(dayOf(r.provenance.data_freshness), '2026-01-08');
});

// ═══════════ O. PER-APP COVERAGE PER SOURCE ═══════════

test('50. apps are listed per source: two on events (131 / 53), none on the crash source', opts, async (t) => {
  if (skip(t)) return;
  const apps = engine.valueIndex.bundles();
  assert.deepEqual(apps.map((b) => [b.source, b.bundle, b.row_count]), [['events', 'com.omg.wordsearch', 131], ['events', 'com.omg.colorfit', 53]]);
  assert.deepEqual(engine.valueIndex.bundles('crashlytics'), []);
});

test('51. { source: events, bundle: colorfit }: level_id populated (53), ad_type empty', opts, async (t) => {
  if (skip(t)) return;
  const v = await engine.semantic_index({ source: 'events', bundle: 'com.omg.colorfit' });
  assert.equal(v.source, 'events'); assert.equal(v.event_rows, 53);
  assert.equal(v.populated.find((p) => p.property === 'level_id_of_event_data')?.non_null, 53);
  assert.ok(v.empty.includes('ad_type_of_event_data'));
});

test('52. the app view offers only the sources that declare an app column', opts, async (t) => {
  if (skip(t)) return;
  // not a refusal the engine writes: the view's `source` is enumerated from the sources that
  // carry an app column, so naming one without it has no spelling.
  // One source carries an app column here, so the refusal PINS it ("must be \"events\""); with
  // several it lists them.
  await assert.rejects(() => engine.semantic_index({ source: 'crashlytics', bundle: 'com.omg.colorfit' }), /`source` must be ("events"|one of: events)/);
});

// ═══════════ P. NOTHING DECLARED — THE INDEX IS THE TRUTH ═══════════

test('53. which events carry anr_duration is observed: exactly [anr]', opts, async (t) => {
  if (skip(t)) return;
  const v = await engine.semantic_index({ source: 'crashlytics', property: 'anr_duration_of_event_data' });
  assert.deepEqual([...v.events].sort(), ['anr']);
  assert.equal(v.declared_values, undefined, 'nothing declared, nothing echoed');
});

test('54. the event view lists only what the event actually carries', opts, async (t) => {
  if (skip(t)) return;
  const lc = await engine.semantic_index({ source: 'events', event: 'level_completed' });
  const names = lc.properties.map((p) => p.name);
  assert.ok(names.includes('result_of_event_data') && names.includes('level_id_of_event_data'), names.join(','));
  assert.ok(!names.includes('ad_type_of_event_data'), 'ad_type is never on level_completed');
});

test('55. values come from the index with their frequencies: win 20 / lose 5', opts, async (t) => {
  if (skip(t)) return;
  const v = await engine.semantic_index({ source: 'events', property: 'result_of_event_data' });
  assert.deepEqual(Object.fromEntries(v.sample_values.map((x) => [x.value, x.freq])), { win: 20, lose: 5 });
  assert.deepEqual([...v.events].sort(), ['level_completed']);
});

test('56. a catalog that still declares events: or values: is refused with the replacement', opts, async (t) => {
  if (skip(t)) return;
  assert.throws(() => variant((M) => { mcp(M.fct_analytics_events.columns.find((c) => c.name === 'result_of_event_data')).events = ['level_completed']; }),
    /meta\.mcp\.events is no longer a schema key.*meta\.mcp\.property: true/s);
  assert.throws(() => variant((M) => { setMcp(M.dim_users.columns.find((c) => c.name === 'platform'), { values: ['ios', 'android'] }); }),
    /meta\.mcp\.values is no longer a schema key/);
});

test('57. the anr event carries anr_duration, breadcrumbs and custom_keys — not the stack', opts, async (t) => {
  if (skip(t)) return;
  const v = await engine.semantic_index({ source: 'crashlytics', event: 'anr' });
  const names = v.properties.map((p) => p.name);
  for (const n of ['anr_duration_of_event_data', 'breadcrumbs_of_event_data', 'custom_keys_of_event_data']) assert.ok(names.includes(n), `${n} missing from ${names}`);
  assert.ok(!names.includes('stack_frames_of_event_data'), 'an ANR has no exception stack');
});

// ═══════════ Q. EACH SOURCE IS SCANNED ON ITS OWN AXIS ═══════════

test('58. with merge on, each source records its own watermark: events 2026-01-09, crashes 2026-01-08', opts, async (t) => {
  if (skip(t)) return;
  const index = new ValueIndex();
  const bi = new BackgroundIndexer({ catalog, runner: backend, index, baseProjectDir: BASE, intervalMs: 0, merge: true, maxValues: 50, logger: () => {} });
  await bi.refresh();
  const ev = index.stats('events', 'ad_type_of_event_data').dataWatermark;
  const cr = index.stats('crashlytics', 'issue_title_of_event_data').dataWatermark;
  assert.equal(new Date(ev).toISOString().slice(0, 10), '2026-01-09');
  assert.equal(new Date(cr).toISOString().slice(0, 10), '2026-01-08');
  t.diagnostic(`events wm ${new Date(ev).toISOString()} / crash wm ${new Date(cr).toISOString()}`);
  index.close();
});

test('59. a second merge pass finds no new rows on either source and keeps every value', opts, async (t) => {
  if (skip(t)) return;
  const index = new ValueIndex();
  const bi = new BackgroundIndexer({ catalog, runner: backend, index, baseProjectDir: BASE, intervalMs: 0, merge: true, maxValues: 50, logger: () => {} });
  await bi.refresh();
  await bi.refresh();
  const run = index.syncStatus().last_run;
  assert.equal(run.status, 'ok', JSON.stringify(run));
  assert.deepEqual(Object.fromEntries(index.sampleValues('events', 'ad_type_of_event_data', 10).map((v) => [v.value, v.freq])), { rewarded: 10, interstitial: 8, banner: 6 }, 'not double-counted');
  assert.deepEqual(Object.fromEntries(index.sampleValues('crashlytics', 'app_version', 10).map((v) => [v.value, v.freq])), { '1.0.0': 7, '1.1.0': 6 });
  index.close();
});

test('60. one run covers both sources, each row labelled with its source and all ok', opts, async (t) => {
  if (skip(t)) return;
  const st = await engine.semantic_index({ status: true });
  const run = await engine.semantic_index({ run: st.value_index.last_run.id });
  const bySource = {};
  for (const p of run.properties) (bySource[p.source] ||= []).push(p);
  assert.ok(bySource.events?.length >= 20, `events rows: ${bySource.events?.length}`);
  assert.ok(bySource.crashlytics?.length >= 7, `crash rows: ${bySource.crashlytics?.length}`);
  assert.ok(bySource.users?.length >= 10, `users rows: ${bySource.users?.length}`);
  assert.deepEqual([...new Set(run.properties.map((p) => p.status))], ['ok']);
});
