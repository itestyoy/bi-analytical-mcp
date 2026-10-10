// AUDIT REGRESSIONS — every finding of the two code audits, plus the structured attribute
// reference, proven on the REAL warehouse (DuckDB + dbt + MetricFlow + the value indexer).
//
// Every assertion is a NUMBER or a set of values read back from the warehouse or from the index
// the indexer built by scanning it — never the text of generated SQL/YAML. Where a finding is
// about a refusal, the test asserts the refusal AND, next to it, the number the correct call
// returns, so the guard is shown to protect a real answer.
//
// The findings share their warehouse work: one query is grouped by several attributes and each
// finding reads its own marginal of it, one catalog variant carries several mutations, and the
// index is scanned once. Every assertion message starts with the number of the finding it proves.
//
// Scenarios, in file order (the letters are the audit's sections):
//   S1  (A/C/J/K/N) one events x users query: the country, app, ad_type and month splits, the paths
//                   the structured references resolved to, and the freshness of the events read;
//   S2  (B)         the filter-value guard over the real index: five refusals, and the correctly
//                   cased values answer;
//   S3  (A/C)       a fact that OWNS ad_funnel: its attributes reached without and with via, and
//                   both sides label the relationship alike;
//   19  (C)         a relationship nobody owns is pipeline only, and the pipeline join gives 14 rows;
//   S5  (E/H)       grounding prunes an amount, a governed measure and a time axis with their
//                   columns; an events role not called 'events' loads; what survives answers;
//   S6  (F/N)       a column that is BOTH an amount and an attribute; a spend task joined to
//                   installs is as fresh as spend;
//   49b (N)         freshness over the recent partitions, and over a source quiet for longer;
//   S9  (J/N)       the crash source in a two-source task: device_model and event_name splits,
//                   per-source freshness;
//   S10 (I/K)       one events pipeline: the session key, an extracted property and a 64-bit id,
//                   all read back exact;
//   S7  (G/L/O/P/Q) the index before() built over a reset store: wiped, then filled; watermarks,
//                   run rows and apps per source; the property and event views;
//   S8  (Q)         a second merge pass finds no new rows — LAST: it rewrites the run S7 reads.
//
// Auto-skips when dbt/mf are not installed (HAS_DBT gate).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { loadCatalog, groundCatalogToPhysical } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { ValueIndex } from '../../src/value-index.js';
import { BackgroundIndexer } from '../../src/value-indexer.js';
import { buildWarehouse, fixtureProject } from './warehouse-harness.js';
import { mcp, setMcp } from '../helpers/catalog-doc.js';
import { settle } from '../helpers/settle.js';
import { HAS_DBT, testDbt } from '../helpers/dbt-env.js';

const BASE = fixtureProject('dbt_project'); // a private copy: the test files run side by side
const CATALOG = join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml');
const opts = { timeout: 600000 };

let wh; let backend; let ctxs; let engine; let catalog;
let indexer;                             // before()'s merge indexer over engine.valueIndex (S8 runs it again)
let wipedBeforeScan;                     // what the reset store held for users.country before the scan
let evUsersCtx; let evCrashCtx;
let ownerEngine; let ownerCtx;           // the crash source OWNS ad_funnel (type: unique)
let bothEngine; let bothCtx;             // acquisition.clicks is measure AND dimension
let seq = 0;

const num = (v) => Number(v === '' || v == null ? NaN : v);
const mapCol = (rows, keyCol, valCol) => Object.fromEntries(rows.map((r) => [r[keyCol] == null ? 'none' : String(r[keyCol]), num(r[valCol])]));
/** The sum of a measure per value of ONE group column of a multi-column result (null → 'none'). */
const marginal = (rows, keyCol, valCol) => {
  const out = {};
  for (const r of rows) { const k = r[keyCol] == null ? 'none' : String(r[keyCol]); out[k] = (out[k] ?? 0) + num(r[valCol]); }
  return out;
};
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
const evtsTask = (eng, name, load = []) => eng.build_semantic_model({
  name, semantic_models: [{ from: 'events', measures: [{ name: 'evts', agg: 'count' }] }, ...load.map((from) => ({ from }))],
  metrics: [{ name: 'evts', type: 'simple', measure: 'evts' }],
});
/** Run a pipeline of stages and return its rows. */
async function pipeRows(source, stages, eng = engine) {
  const s = await eng.build_pipeline_model({ action: 'start', name: `au_${seq++}`, source });
  for (const stage of stages) {
    const r = await eng.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, stages: [stage] });
    assert.ok(!r.error, `add_steps failed: ${JSON.stringify(r.error || r)}`);
  }
  const c = await eng.build_pipeline_model({ action: 'materialize', context_id: s.context_id });
  assert.equal(c.build?.ok, true, JSON.stringify(c.error || c.build));
  return c.rows;
}

before(async () => {
  if (!HAS_DBT) return;
  wh = await buildWarehouse(BASE); // the run's one build of the fixture, copied
  ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: mkdtempSync(join(tmpdir(), 'aud-ws-')), timeSpineDialect: 'duckdb' });
  backend = testDbt({ profilesDir: BASE });
  catalog = loadCatalog(CATALOG, { profilesDir: BASE, projectDir: BASE });

  // MCP_DB_RESET over a store that already holds a value: the engine opens its store with reset,
  // the production path, so the index starts empty (S7 asserts the seeded value is gone and the
  // scan filled the real ones).
  const dbPath = join(mkdtempSync(join(tmpdir(), 'aud-db-')), 'vi.sqlite');
  const seeded = new ValueIndex({ dbPath });
  seeded.upsertProperty('users', 'country', { distinctCount: 1, totalCount: 99, nullCount: 0, values: [{ value: 'ATLANTIS', freq: 99 }] });
  seeded.close();
  engine = settle(new Engine({ catalog, contextManager: ctxs, runner: backend, dbPath, resetDb: true }));
  wipedBeforeScan = engine.valueIndex.stats('users', 'country');

  // The value index is REAL: a full pass over the warehouse, awaited, so the guard and the
  // coverage views below answer from measured data. With merge on, a first pass over an empty
  // index scans every source whole and records each one's watermark; S8 runs the second pass.
  indexer = new BackgroundIndexer({ catalog, runner: backend, index: engine.valueIndex, baseProjectDir: BASE, intervalMs: 0, merge: true, maxValues: 50, logger: () => {} });
  await indexer.refresh();

  // events x users, ad_type declared as a task dimension: S1 reads every split of one query
  const eu = await engine.build_semantic_model({
    name: 'aeu',
    semantic_models: [{ from: 'events', dimensions: [{ field: 'ad_type_of_event_data' }], measures: [{ name: 'evts', agg: 'count' }] }, { from: 'users' }],
    metrics: [{ name: 'evts', type: 'simple', measure: 'evts' }],
  });
  assert.equal(eu.parse.ok, true, `40: a task declaring ad_type as a dimension parses: ${JSON.stringify(eu.parse)}`);
  evUsersCtx = eu.context_id;
  const both = await engine.build_semantic_model({
    name: 'aboth',
    semantic_models: [{ from: 'events', measures: [{ name: 'launches', agg: 'count' }], where: [{ field: 'event_name', op: 'eq', value: 'first_launch' }] }, { from: 'crashlytics', measures: [{ name: 'reports', agg: 'count' }] }],
    metrics: [{ name: 'launches', type: 'simple', measure: 'launches' }, { name: 'reports', type: 'simple', measure: 'reports' }],
  });
  evCrashCtx = both.context_id;

  ({ engine: ownerEngine } = variant((M) => {
    mcp(M.fct_crashlytics_events).entities = { ad_funnel: { type: 'unique', key: ['rewarded_tracking_id', 'player_id_of_internal'] } };
    mcp(M.fct_analytics_events).entities.ad_funnel = { type: 'foreign', key: ['tracking_id', 'player_id_of_internal'] };
  }));
  ownerCtx = (await evtsTask(ownerEngine, 'aown', ['crashlytics', 'users'])).context_id;

  // spend with installs loaded beside it (S6: the clicks splits, and freshness from spend alone)
  ({ engine: bothEngine } = variant((M) => {
    const clicks = M.fct_player_acquisition.columns.find((c) => c.name === 'clicks');
    setMcp(clicks, { measure: true, dimension: {} });
  }));
  const bt = await bothEngine.build_semantic_model({
    name: 'aclk',
    semantic_models: [{ from: 'acquisition', dimensions: [{ field: 'clicks' }], measures: [{ name: 'cost', agg: 'sum', field: 'cost' }, { name: 'click_total', agg: 'sum', field: 'clicks' }] }, { from: 'users' }],
    metrics: [{ name: 'cost', type: 'simple', measure: 'cost' }, { name: 'click_total', type: 'simple', measure: 'click_total' }],
  });
  assert.equal(bt.parse.ok, true, JSON.stringify(bt.parse));
  bothCtx = bt.context_id;
}, opts);

after(async () => { backend?.close?.(); engine?.valueIndex?.close?.(); if (wh) await wh.stop(); });

// ═══════════ S1. THE ATTRIBUTE, ADDRESSED BY WHERE IT LIVES — ONE QUERY, EVERY SPLIT ═══════════

test('S1 (A/C/J/K/N). one events x users query: country / bundle / ad_type / month marginals, resolved paths, freshness', opts, async (t) => {
  if (skip(t)) return;
  const r = await q(evUsersCtx, {
    metrics: ['aeu_evts'],
    group_by: [
      { model: 'users', attribute: 'country' },
      { model: 'events', attribute: 'bundle_id' },
      { model: 'events', attribute: 'ad_type_of_event_data' },
      { time: 'metric_time', grain: 'month' },
    ],
  });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const res = r.group_by_resolved || {};
  // 2. the response echoes the path each structured reference resolved to (metric_time is no attribute)
  assert.deepEqual(res, { 'users.country': 'users_country', 'events.bundle_id': 'events_bundle_id', 'events.ad_type_of_event_data': 'events_ad_type_of_event_data' },
    `2: the response echoes the path each structured reference resolved to: ${JSON.stringify(res)}`);
  assert.ok(r.columns.some((c) => c.name.includes('country')), '2: the result column carries the resolved name');
  // 1/17. { model: users, attribute: country } returns what users.country holds — the governed path the users model promises
  assert.deepEqual(marginal(r.rows, res['users.country'], 'aeu_evts'), { US: 67, GB: 57, DE: 31, BR: 29 }, '1/17: events per users.country');
  // 10/17. a structured attribute and a time grain together: one month, four countries, 184 events
  assert.equal(sumCol(r.rows, 'aeu_evts'), 184, '10/17: every event counted once across the splits');
  const monthCol = r.columns.map((c) => c.name).find((n) => n.startsWith('metric_time'));
  assert.ok(monthCol, `10: the month is a result column: ${r.columns.map((c) => c.name)}`);
  assert.equal(new Set(r.rows.map((row) => String(row[monthCol]))).size, 1, '10: the events fall in one month');
  assert.equal(new Set(r.rows.map((row) => row[res['users.country']])).size, 4, '10: four countries in the one month');
  // 4/38. the source's OWN attribute under its identity: bundle_id splits 131 / 53
  assert.deepEqual(marginal(r.rows, res['events.bundle_id'], 'aeu_evts'), { 'com.omg.wordsearch': 131, 'com.omg.colorfit': 53 }, '4/38: bundle_id splits 131 / 53');
  // 40. governed: ad_type as a task dimension → rewarded 10 / interstitial 8 / banner 6
  const byAd = marginal(r.rows, res['events.ad_type_of_event_data'], 'aeu_evts');
  assert.equal(byAd.rewarded, 10, `40: rewarded 10 (${JSON.stringify(byAd)})`);
  assert.equal(byAd.interstitial, 8, '40: interstitial 8');
  assert.equal(byAd.banner, 6, '40: banner 6');
  // 47. an events task is current through 2026-01-09, the latest device_time (users lends attributes, not measures)
  assert.equal(r.provenance.source, 'events', '47: the freshness is the events source\'s');
  assert.equal(dayOf(r.provenance.data_freshness), '2026-01-09', '47: current through the latest device_time');
});

// ═══════════ S2. THE VALUE GUARD REACHES A JOINED ATTRIBUTE THROUGH ITS OWNER ═══════════

test('S2 (B). the value guard over the real index: five refusals, and the correct values answer 57 / 124 / 31 / 53', opts, async (t) => {
  if (skip(t)) return;
  const country = { model: 'users', attribute: 'country' };
  const bundle = { model: 'events', attribute: 'bundle_id' };
  const filtered = (field, op, value) => ({ metrics: ['aeu_evts'], where: [{ field, op, value }] });
  // the guard reads the keys the REAL indexer wrote: (users, country) and (events, bundle_id)
  await assert.rejects(() => q(evUsersCtx, filtered(country, 'eq', 'gb')), /different casing.*'GB'/s, '11: a wrong-cased country on users.country is rejected with the real casing');
  await assert.rejects(() => q(evUsersCtx, filtered(country, 'in', ['GB', 'us'])), /different casing/, '13: an IN list is checked value by value');
  await assert.rejects(() => q(evUsersCtx, filtered(country, 'eq', 'XX')), /does not occur in this column/, '14: a value absent from a fully indexed small set is rejected outright');
  await assert.rejects(() => q(evUsersCtx, filtered(country, 'eq', 'De')), /different casing.*'DE'/s, '15: the guard applies to the structured reference too');
  await assert.rejects(() => q(evUsersCtx, filtered(bundle, 'eq', 'COM.OMG.COLORFIT')), /different casing.*'com\.omg\.colorfit'/s, "16: the source's own attribute is guarded against its own indexed values");
  // …and the correctly cased values answer
  const r = await q(evUsersCtx, { ...filtered(country, 'in', ['GB', 'US', 'DE']), group_by: [country] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const by = mapCol(r.rows, r.group_by_resolved['users.country'], 'aeu_evts');
  assert.equal(by.GB, 57, `3/12: a where addressed by model + attribute keeps GB's 57 events (${JSON.stringify(by)})`);
  assert.equal(by.GB + by.US, 124, '13: the IN list GB + US = 124');
  assert.equal(by.DE, 31, '15: the correctly cased DE returns 31');
  assert.ok(!('BR' in by), `3: the where keeps only the listed countries (${JSON.stringify(by)})`);
  const own = await q(evUsersCtx, filtered(bundle, 'eq', 'com.omg.colorfit'));
  assert.equal(own.ok, true, JSON.stringify(own.error));
  assert.equal(num(own.rows[0].aeu_evts), 53, "16: the source's own attribute, correctly cased, returns 53");
});

// ═══════════ S3 / 19. RELATIONSHIP LABELLING AND THE PATH IT GIVES ═══════════

test('S3 (A/C). a fact that owns ad_funnel: reached without and with via, labelled on both sides', opts, async (t) => {
  if (skip(t)) return;
  const r = await q(ownerCtx, {
    metrics: ['aown_evts'],
    group_by: [{ model: 'crashlytics', attribute: 'app_version' }, { model: 'crashlytics', attribute: 'device_model', via: 'ad_funnel' }],
  }, ownerEngine);
  assert.equal(r.ok, true, JSON.stringify(r.error));
  // 7. an attribute of an owned FACT is reached through the relationship the source declares
  assert.equal(r.group_by_resolved['crashlytics.app_version'], 'crashlytics_app_version', '7: resolved through ad_funnel, not through the crash identity');
  assert.deepEqual(marginal(r.rows, r.group_by_resolved['crashlytics.app_version'], 'aown_evts'), { none: 176, '1.0.0': 6, '1.1.0': 8 }, '7: events per crash app_version, without via');
  // 8. via names the relationship explicitly and gives the same join's numbers
  assert.deepEqual(marginal(r.rows, r.group_by_resolved['crashlytics.device_model'], 'aown_evts'), { none: 176, iphone: 14 }, '8: events per crash device_model, via ad_funnel');
  // 20. with an owner declared, both sides label the relationship consistently
  const crash = await ownerEngine.semantic_index({ source: 'crashlytics' });
  assert.match(crash.relationships.find((x) => x.entity === 'ad_funnel').use, /^owned here — other models point at it/, '20: the crash side owns ad_funnel');
  const events = await ownerEngine.semantic_index({ source: 'events' });
  const rel = events.relationships.find((x) => x.entity === 'ad_funnel');
  assert.equal(rel.use, 'metric query + pipeline', '20: the events side reaches it by metric query and pipeline');
  assert.equal(rel.joins, 'crashlytics', '20: the events side points at the owner');
});

test('19. a relationship nobody owns is pipeline only — and the pipeline join gives 14 rows', opts, async (t) => {
  if (skip(t)) return;
  const v = await engine.semantic_index({ source: 'crashlytics' });
  assert.equal(v.relationships.find((r) => r.entity === 'ad_funnel_rewarded').use, 'pipeline only');
  const rows = await pipeRows('crashlytics', [
    { stage: 'join', with: 'events', via: 'ad_funnel_rewarded', kind: 'inner', attrs: [{ column: 'event_name', name: 'ev_name' }] },
    { stage: 'aggregate', group_by: ['event_name'], measures: [{ name: 'n', agg: 'count' }] },
  ]);
  assert.deepEqual(mapCol(rows, 'event_name', 'n'), { fatal_crash: 8, non_fatal: 4, anr: 2 });
});

// ═══════════ S5. GROUNDING, AND NO ANCHOR ═══════════

test("S5 (E/H). one ungrounded variant: an amount, a governed measure and a time axis pruned; a renamed events role; what survives answers 17.50 / 17.50 / 184 and control 6 / variant_b 6", opts, async (t) => {
  if (skip(t)) return;
  // four mutations that touch each other nowhere: two on acquisition, one on experiments, the events role renamed
  const { catalog: cat, engine: eng } = variant((M) => {
    M.fct_player_acquisition.columns.push({ name: 'bonus_spend', data_type: 'numeric', config: { meta: { mcp: { measure: { unit: 'usd' } } } } });
    mcp(M.fct_player_acquisition).measures.ghost_total = { expr: 'ghost_cost', agg: 'sum', unit: 'usd' };
    M.fct_experiment_assignments.columns.push({ name: 'ghost_time', data_type: 'timestamp', config: { meta: { mcp: { is_time: true } } } });
    mcp(M.fct_analytics_events).role = 'analytics';
  });
  assert.equal(cat.getModel('experiments').time?.column, 'ghost_time', '27: the time axis is declared before grounding');
  assert.deepEqual([...eng.catalog.facts].sort(), ['analytics', 'crashlytics'], "33: an events source whose role is not called 'events' loads");
  const { pruned } = await groundCatalogToPhysical(cat, backend, BASE);
  // 24. a declared amount the table lacks is pruned
  assert.ok(pruned.acquisition.includes('amount:bonus_spend'), `24: the missing amount is pruned: ${JSON.stringify(pruned)}`);
  assert.ok(!cat.aggregatableFields('acquisition').some((a) => a.name === 'bonus_spend'), '24: the pruned amount is no aggregatable field');
  // 26. a governed measure whose column is missing is pruned
  assert.ok(pruned.acquisition.includes('measure:ghost_total'), `26: the governed measure over a missing column is pruned: ${JSON.stringify(pruned)}`);
  assert.equal(cat.getModel('acquisition').measures.ghost_total, undefined, '26: the pruned measure is gone from the model');
  // 27. a time axis on a missing column is dropped
  assert.ok(pruned.experiments.includes('(time axis)'), `27: the time axis over a missing column is pruned: ${JSON.stringify(pruned)}`);
  assert.equal(cat.getModel('experiments').time, undefined, '27: the model has no time axis left');
  // 25. a measure over the pruned amount is refused at validation, not in the warehouse
  await assert.rejects(() => eng.build_semantic_model({ name: 'agr2', semantic_models: [{ from: 'acquisition', measures: [{ name: 'b', agg: 'sum', field: 'bonus_spend' }] }], metrics: [{ name: 'b', type: 'simple', measure: 'b' }] }),
    /bonus_spend|invalid input/, '25: a measure over the pruned amount is refused at validation');
  // what survives builds and answers: the real amount, the surviving governed measure, the renamed source's count
  const c = await eng.build_semantic_model({
    name: 'agr',
    semantic_models: [{ from: 'acquisition', measures: [{ name: 'cost', agg: 'sum', field: 'cost' }] }, { from: 'analytics', measures: [{ name: 'n', agg: 'count' }] }],
    metrics: [{ name: 'cost', type: 'simple', measure: 'cost' }, { name: 'total_spend', type: 'simple', measure: 'total_spend' }, { name: 'n', type: 'simple', measure: 'n' }],
  });
  assert.equal(c.parse.ok, true, `26/33: the surviving measures and the renamed source parse: ${JSON.stringify(c.parse)}`);
  const r = await q(c.context_id, { metrics: ['agr_cost', 'agr_total_spend', 'agr_n'] }, eng);
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.ok(Math.abs(num(r.rows[0].agr_cost) - 17.5) < 1e-6, `24: the real amount still sums to 17.50 (${r.rows[0].agr_cost})`);
  assert.ok(Math.abs(num(r.rows[0].agr_total_spend) - 17.5) < 1e-6, `26: the surviving governed measure answers 17.50 (${r.rows[0].agr_total_spend})`);
  assert.equal(num(r.rows[0].agr_n), 184, "33: the source whose role is not called 'events' counts 184");
  // 27. …and the model without its time axis still joins
  const rows = await pipeRows('analytics', [
    { stage: 'join', with: 'experiments', via: 'user', kind: 'inner', attrs: [{ column: 'variant_group' }] },
    { stage: 'aggregate', group_by: ['variant_group'], measures: [{ name: 'players', agg: 'count_distinct', column: 'player_id_of_internal' }] },
  ], eng);
  assert.deepEqual(mapCol(rows, 'variant_group', 'players'), { control: 6, variant_b: 6 }, '27: the model without its time axis still joins: control 6 / variant_b 6');
});

// ═══════════ S6. AN AMOUNT THAT IS ALSO AN ATTRIBUTE; FRESHNESS FROM SPEND ═══════════

test('S6 (F/N). clicks is both an amount and an attribute; a spend task joined to installs is as fresh as spend', opts, async (t) => {
  if (skip(t)) return;
  const r = await q(bothCtx, { metrics: ['aclk_cost', 'aclk_click_total'], group_by: [{ model: 'acquisition', attribute: 'clicks' }] }, bothEngine);
  assert.equal(r.ok, true, JSON.stringify(r.error));
  // 28. cost grouped by the clicks VALUE: 9 clicks cost 5.25, 8 clicks 4.25, 0 clicks 0
  const by = mapCol(r.rows, r.group_by_resolved['acquisition.clicks'], 'aclk_cost');
  assert.ok(Math.abs(by['9'] - 5.25) < 1e-6, `28: 9 clicks cost 5.25 (${JSON.stringify(by)})`);
  assert.ok(Math.abs(by['8'] - 4.25) < 1e-6, '28: 8 clicks cost 4.25');
  assert.equal(by['0'], 0, '28: 0 clicks cost 0');
  assert.ok(Math.abs(sumCol(r.rows, 'aclk_cost') - 17.5) < 1e-6, '28: the groups sum to the 17.50 spent');
  // 29. …and clicks still sums as an amount: 64
  assert.equal(sumCol(r.rows, 'aclk_click_total'), 64, '29: clicks still sums as an amount');
  // 48. a spend task joined to installs takes its freshness from spend, not from installs
  assert.equal(r.provenance.source, 'acquisition', '48: users contributes attributes, not measures');
  assert.equal(dayOf(r.provenance.data_freshness), '2026-01-05', '48: current through the latest spend day');
  assert.equal(r.provenance.data_freshness_by_source, undefined, '48: one contributing source, no per-source split');
  // 30. the model view lists clicks both as an attribute and as an amount
  const v = await bothEngine.semantic_index({ source: 'acquisition' });
  assert.ok(v.dimensions.some((d) => d.name === 'clicks'), '30: clicks is listed as an attribute');
  assert.ok(v.aggregatable.some((a) => a.field === 'clicks'), '30: clicks is listed as an amount');
  assert.equal(v.dimensions.find((d) => d.name === 'clicks').distinct_count, null, '30: not profiled by THIS engine\'s index (separate store) — the attribute exists regardless');
});

// ═══════════ 49b / S9. DATA FRESHNESS; THE CRASH SOURCE BESIDE EVENTS ═══════════

test('49b. freshness read over the recent partitions is the latest device_time of all; a source quiet for longer is read whole, to the same day', opts, async (t) => {
  if (skip(t)) return;
  const { WarehouseProbe } = await import('../../src/engine/warehouse-probe.js');
  const truth = (await wh.query("select strftime(max(device_time), '%Y-%m-%d') as d from fct_analytics_events")).rows[0].d;
  const probeAt = (iso) => new WarehouseProbe({ runner: engine.runner, ctxs: engine.ctxs, catalog: engine.catalog, valueIndex: null, queryTimeoutMs: engine.probe.queryTimeoutMs, timeRangeConditions: (s, tr) => engine._timeRangeConditions(s, tr), now: () => Date.parse(iso) });
  // the day after the latest event: the lookback reaches it through the partitions
  assert.equal(dayOf(await probeAt('2026-01-10T12:00:00Z').dataFreshness('events')), truth);
  // months later: nothing in the lookback, so the whole source is read
  assert.equal(dayOf(await probeAt('2026-06-01T00:00:00Z').dataFreshness('events')), truth);
});

test('S9 (J/N). the crash source in a two-source task: device_model and event_name splits, per-source freshness', opts, async (t) => {
  if (skip(t)) return;
  // 39. search finds device_model on users AND on crashlytics
  const s = await engine.semantic_index({ search: 'device_model' });
  assert.deepEqual([...new Set(s.dimension_matches.filter((d) => d.property === 'device_model').map((d) => d.source))].sort(), ['crashlytics', 'users'], '39: device_model is found on users and on crashlytics');
  const truth = Object.fromEntries((await wh.query('select event_name, count(*) as n from fct_crashlytics_events group by 1')).rows.map((row) => [row.event_name, Number(row.n)]));
  const r = await q(evCrashCtx, {
    metrics: ['aboth_reports'],
    group_by: [{ model: 'crashlytics', attribute: 'device_model' }, { model: 'crashlytics', attribute: 'event_name' }],
    time_range: { start: '2020-01-01', end: '2030-12-31' },
  });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.deepEqual(marginal(r.rows, r.group_by_resolved['crashlytics.device_model'], 'aboth_reports'), { iphone: 7, pixel: 4, galaxy: 2 }, '39: the crash copy of device_model counts 7 / 4 / 2');
  // 49d. a metric grouped by the event name the schema offers as an attribute: the counts the warehouse holds
  assert.deepEqual(marginal(r.rows, r.group_by_resolved['crashlytics.event_name'], 'aboth_reports'), truth, '49d: reports per crash event, as the warehouse holds them');
  // 49. two events sources: per-source freshness, headline = the staler (crashes, 2026-01-08)
  const f = await q(evCrashCtx, { metrics: ['aboth_launches', 'aboth_reports'] });
  assert.equal(f.ok, true, JSON.stringify(f.error));
  assert.deepEqual([...f.provenance.source].sort(), ['crashlytics', 'events'], '49: both sources contribute measures');
  assert.equal(dayOf(f.provenance.data_freshness_by_source.events), '2026-01-09', '49: events are current through 2026-01-09');
  assert.equal(dayOf(f.provenance.data_freshness_by_source.crashlytics), '2026-01-08', '49: crashes are current through 2026-01-08');
  assert.equal(dayOf(f.provenance.data_freshness), '2026-01-08', '49: the headline is the staler source');
});

// ═══════════ S10. ONE EVENTS PIPELINE: NO JOIN KEY IS AN ATTRIBUTE BY NAME; ONE PROPERTY RULE ═══════════

test('S10 (I/K). one events pipeline: session_number, an extracted ad_type and a 64-bit id, all read back exact', opts, async (t) => {
  if (skip(t)) return;
  const truth = (await wh.query('select cast(3000624785682605657 as bigint)::varchar as id')).rows[0].id;
  const rows = await pipeRows('events', [
    { stage: 'compute', name: 'ad_type', expr: { fn: 'event_property', property: 'ad_type_of_event_data' } },
    { stage: 'compute', name: 'big_id', expr: { fn: 'raw', sql: 'CAST(3000624785682605657 AS BIGINT)', type: 'numeric' } },
    { stage: 'aggregate', group_by: ['session_number', 'ad_type', 'big_id'], measures: [{ name: 'n', agg: 'count' }] },
  ]);
  // 37. a pipeline reads the session key like any column
  assert.deepEqual(marginal(rows, 'session_number', 'n'), { 1: 150, 2: 26, 3: 4, 4: 4 }, '37: sessions 1..4 hold 150 / 26 / 4 / 4 events');
  // 41. the same property extracted in a pipeline → the same 10 / 8 / 6
  const byAd = marginal(rows, 'ad_type', 'n');
  delete byAd.none; // the events that carry no ad_type
  assert.deepEqual(byAd, { rewarded: 10, interstitial: 8, banner: 6 }, '41: the extracted ad_type splits 10 / 8 / 6');
  // 49c. an id past 2^53 comes back from a pipeline with every digit the warehouse holds
  assert.ok(rows.length > 0, '49c: the pipeline returned rows');
  for (const row of rows) assert.equal(String(row.big_id), truth, '49c: an id past 2^53 keeps every digit');
});

// ═══════════ S7. THE INDEX before() BUILT — NO WAREHOUSE CALL ═══════════

test('S7 (G/L/O/P/Q). the index before() built over a reset store: wiped, then filled; watermarks, run rows and apps per source; the views', opts, async (t) => {
  if (skip(t)) return;
  const index = engine.valueIndex;
  // 32. reset() over a store that held a value leaves an empty index that the scan then fills
  assert.equal(wipedBeforeScan, null, '32: the reset store held nothing before the scan');
  assert.deepEqual(Object.fromEntries(index.sampleValues('users', 'country', 10).map((v) => [v.value, v.freq])), { US: 4, GB: 4, DE: 3, BR: 2 }, '32: the scan filled the real values');
  // 58. with merge on, each source records its own watermark: events 2026-01-09, crashes 2026-01-08
  const ev = index.stats('events', 'ad_type_of_event_data').dataWatermark;
  const cr = index.stats('crashlytics', 'issue_title_of_event_data').dataWatermark;
  assert.equal(new Date(ev).toISOString().slice(0, 10), '2026-01-09', '58: the events watermark is its latest device_time');
  assert.equal(new Date(cr).toISOString().slice(0, 10), '2026-01-08', '58: the crash watermark is its own latest time');
  t.diagnostic(`events wm ${new Date(ev).toISOString()} / crash wm ${new Date(cr).toISOString()}`);
  // 44/60. the run rows carry their source
  const st = await engine.semantic_index({ status: true });
  const run = await engine.semantic_index({ run: st.value_index.last_run.id });
  const appVersion = run.properties.filter((p) => p.property === 'app_version');
  assert.deepEqual(appVersion.map((p) => p.source).sort(), ['crashlytics', 'users'], '44: app_version has a run row per source');
  assert.equal(appVersion.find((p) => p.source === 'users').distinct_count, 1, '44: users.app_version has 1 distinct value');
  assert.equal(appVersion.find((p) => p.source === 'crashlytics').distinct_count, 2, '44: crashlytics.app_version has 2 distinct values');
  const bySource = {};
  for (const p of run.properties) (bySource[p.source] ||= []).push(p);
  assert.ok(bySource.events?.length >= 20, `60: events rows: ${bySource.events?.length}`);
  assert.ok(bySource.crashlytics?.length >= 7, `60: crash rows: ${bySource.crashlytics?.length}`);
  assert.ok(bySource.users?.length >= 10, `60: users rows: ${bySource.users?.length}`);
  assert.deepEqual([...new Set(run.properties.map((p) => p.status))], ['ok'], '60: every row of the run is ok');
  // 45. the property view always takes the source, and answers per source
  await assert.rejects(() => engine.semantic_index({ property: 'app_version' }), /must be exactly one of: .*\{ source, property \}/, '45: the property view always takes the source');
  const u = await engine.semantic_index({ source: 'users', property: 'app_version' });
  // the seed writes '1.0'; dbt seed types the column numeric, so the warehouse value is 1
  assert.deepEqual(u.sample_values.map((v) => [String(v.value), v.freq]), [['1', 13]], '45: users.app_version answers for users');
  const c = await engine.semantic_index({ source: 'crashlytics', property: 'app_version' });
  assert.deepEqual(Object.fromEntries(c.sample_values.map((v) => [v.value, v.freq])), { '1.0.0': 7, '1.1.0': 6 }, '45: crashlytics.app_version answers for crashlytics');
  // 50. apps are listed per source: two on events (131 / 53), none on the crash source
  assert.deepEqual(index.bundles().map((b) => [b.source, b.bundle, b.row_count]), [['events', 'com.omg.wordsearch', 131], ['events', 'com.omg.colorfit', 53]], '50: two apps, both on events');
  assert.deepEqual(index.bundles('crashlytics'), [], '50: none on the crash source, which declares no app column');
  // 51. { source: events, bundle: colorfit }: level_id populated on every one of its 53 rows
  const colorfit = await engine.semantic_index({ source: 'events', bundle: 'com.omg.colorfit' });
  assert.equal(colorfit.populated.find((p) => p.property === 'level_id_of_event_data')?.non_null, 53, '51: level_id is populated on all 53 colorfit rows');
  // 57. the anr event carries anr_duration, breadcrumbs and custom_keys — not the stack
  const anr = await engine.semantic_index({ source: 'crashlytics', event: 'anr' });
  const names = anr.properties.map((p) => p.name);
  for (const n of ['anr_duration_of_event_data', 'breadcrumbs_of_event_data', 'custom_keys_of_event_data']) assert.ok(names.includes(n), `57: ${n} missing from ${names}`);
  assert.ok(!names.includes('stack_frames_of_event_data'), '57: an ANR has no exception stack');
});

// ═══════════ S8. THE SECOND MERGE PASS — LAST: IT REWRITES THE RUN S7 READS ═══════════

test("S8 (Q). a second merge pass over the engine's index finds no new rows and keeps every value", opts, async (t) => {
  if (skip(t)) return;
  const index = engine.valueIndex;
  const watermark = (source, property) => index.stats(source, property).dataWatermark;
  const kept = { events: watermark('events', 'ad_type_of_event_data'), crashlytics: watermark('crashlytics', 'issue_title_of_event_data') };
  await indexer.refresh();
  const run = index.syncStatus().last_run;
  assert.equal(run.status, 'ok', `59: the second pass ends ok: ${JSON.stringify(run)}`);
  assert.deepEqual(Object.fromEntries(index.sampleValues('events', 'ad_type_of_event_data', 10).map((v) => [v.value, v.freq])), { rewarded: 10, interstitial: 8, banner: 6 }, '59: the events values are not double-counted');
  assert.deepEqual(Object.fromEntries(index.sampleValues('crashlytics', 'app_version', 10).map((v) => [v.value, v.freq])), { '1.0.0': 7, '1.1.0': 6 }, '59: the crash values are kept');
  assert.equal(watermark('events', 'ad_type_of_event_data'), kept.events, '59: no new events rows, so the events watermark stays');
  assert.equal(watermark('crashlytics', 'issue_title_of_event_data'), kept.crashlytics, '59: no new crash rows, so the crash watermark stays');
});
