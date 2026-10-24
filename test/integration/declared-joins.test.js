// JOINS: a pipeline joins a model on the CONTRACT the model declares; the semantic layer on the keys.
//
// A model that may be joined onto rows declares a join contract (meta.mcp.join): its key's parts,
// declared unique by its authors, the time it is matched at and the values it is narrowed to. A
// pipeline names every part — { source, on: { <part>: <a column of the rows | a value> } } — and the
// engine writes the join. The semantic layer joins on the relationships of meta.mcp.entities, and
// MetricFlow applies a validity window itself.
//
// The fixture (see test/integration/fixtures/SEED_DATA.md §12-13):
//   users        the install record, SCD-2: { user, time } — the version valid at the moment named.
//                u1 moved US -> GB on 2026-01-03.
//   acquisition  one row per player and day: { user, time } — the record of the moment's day.
//   experiments  one row per player × experiment: { user, experiment } — the experiment named.
//   crashlytics  a crash report per player and ad funnel: { user, funnel, format } — the funnel
//                matched on the tracking-id column of the format named. The authors' `unique` is
//                trusted, never checked — and true here: a report carries a funnel only when it is
//                the first after it.
//
// Every assertion is a NUMBER (or a set of ids) from running against the warehouse — per the
// project rule the generated SQL is never matched as text. Each case is built so a wrong ON
// clause, a dropped window or the wrong column moves the number.
//
// Sections:
//   A-D (8-18)  the join behaviour, every case built and run as a real pipeline / metric query;
//   E   (21-25) grounding: a declaration the built tables do not back;
//   F   (26-33) the GENERATED join code, proven by executing it and comparing its rows to a
//               reference query written by hand here — still no text matching;
//   H   (35-38, 40) all FOUR sources in one chain — three contracts at once — plus the governed
//               path over two facts at the same time;
//   I   (41-42) the governed side: a join path needs its owning model loaded; a pipeline's join
//               part names a column of the rows as they are at its step;
//   J   (44, 47, 49) `attrs` is the contract: exactly the listed attributes arrive — nothing implicit;
//   K   (50-53) a FACT as the semantic join target: owning a key with `type: unique` gives its
//               attributes a governed path, and a key unique on the data adds no row;
//   L           the same day (31, 8).
//
// Where a scenario's numbers are asserted elsewhere, it lives there and is not repeated here:
//   - over the real MCP protocol, test/integration/mcp-end-to-end.test.js;
//   - add_steps refusals that need no warehouse (an undeclared relationship, a self-join, a
//     top-level on, a missing / unknown / duplicate attrs name) and the key part's own fields:
//     test/unit/build-pipeline-model.test.js and test/unit/declared-join-keys.test.js.
//
// Auto-skips when dbt/mf are not installed (HAS_DBT gate).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { loadCatalog, groundCatalogToPhysical } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { buildWarehouse, fixtureProject } from './warehouse-harness.js';
import { mcp } from '../helpers/catalog-doc.js';
import { settle } from '../helpers/settle.js';
import { HAS_DBT, testDbt } from '../helpers/dbt-env.js';
import { tempDir } from '../helpers/temp-dir.js';
import { declare, editLayer } from '../helpers/declare.js';

const BASE = fixtureProject('dbt_project'); // a private copy: the test files run side by side
const opts = { timeout: 300000 };

let wh; let engine; let backend; let acqCtx; let evCtx; let seq = 0;
// A second catalog over the SAME warehouse, declaring things the tables do not actually have —
// see section E. `phantom` is that catalog AFTER real introspection has grounded it.
let phantom; let phantomEngine; let phantomPruned; let phantomCostCtx;
// A third catalog over the SAME warehouse, in which the CRASH source OWNS the ad funnel
// (type: unique) instead of both sides pointing at nobody — see section K.
let ownerCatalog; let ownerEngine; let ownerCtx;
let oneCatalog; let oneEngine; let oneCtx;
let trueCatalog; let trueEngine; let trueCtx;

const num = (v) => Number(v === '' || v == null ? NaN : v);
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const mapCol = (rows, keyCol, valCol) => Object.fromEntries(rows.map((r) => [String(r[keyCol]), num(r[valCol])]));
const groupCol = (res, metric) => res.columns.map((c) => c.name).find((n) => n !== metric);
const sumCol = (rows, col) => rows.reduce((s, r) => s + num(r[col]), 0);
/** A metric per value of ONE attribute's result column (a NULL is 'none'), summed over a result that may be grouped by several. */
const splitBy = (res, attribute, metric) => {
  const key = res.columns.map((c) => c.name).find((n) => n.includes(attribute));
  assert.ok(key, `a result column for ${attribute}: ${res.columns.map((c) => c.name)}`);
  const out = {};
  for (const x of res.rows) { const k = x[key] == null ? 'none' : String(x[key]); out[k] = (out[k] ?? 0) + num(x[metric]); }
  return out;
};

/** The validity window of the install record, stated per the source's own time column. */

before(async () => {
  if (!HAS_DBT) return;
  wh = await buildWarehouse(BASE);

  const catalog = loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), { profilesDir: BASE, projectDir: BASE });
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: tempDir('mcpit-join'), timeSpineDialect: 'duckdb' });
  backend = testDbt({ profilesDir: BASE });
  engine = settle(new Engine({ catalog, contextManager: ctxs, runner: backend }));

  // Governed contexts: MetricFlow reaches the SCD install record by itself, point-in-time.
  const acq = await declare(engine, {
    name: 'jacq',
    semantic_models: [{ source: 'acquisition', measures: [{ name: 'cost', expr: { fn: 'sum', args: [{ column: 'cost' }] } }] }, { source: 'users' }],
    metrics: [{ name: 'cost', type: 'simple', measure: 'cost' }],
  });
  assert.equal(acq.parse.ok, true, JSON.stringify(acq.parse));
  acqCtx = acq.context_id;

  const ev = await declare(engine, {
    name: 'jev',
    semantic_models: [{ source: 'events', measures: [{ name: 'evts', expr: { fn: 'count' } }] }, { source: 'users' }],
    metrics: [{ name: 'evts', type: 'simple', measure: 'evts' }],
  });
  assert.equal(ev.parse.ok, true, JSON.stringify(ev.parse));
  evCtx = ev.context_id;

  // ── the PHANTOM catalog: declares columns the built tables do not have ──────────────
  // Same dbt project, so introspection is real; only the declaration lies. Built here rather
  // than checked in as a second fixture so it cannot drift from the catalog it is derived from.
  const doc = yaml.load(readFileSync(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), 'utf8'));
  const M = Object.fromEntries(doc.models.map((m) => [m.name, m]));
  // (a) a validity window whose BOTH columns are missing
  M.fct_player_acquisition.columns.push(
    { name: 'ghost_valid_from', data_type: 'timestamp', config: { meta: { mcp: { dimension: { validity: 'start' } } } } },
    { name: 'ghost_valid_until', data_type: 'timestamp', config: { meta: { mcp: { dimension: { validity: 'end' } } } } },
  );
  // (b) a relationship a model OWNS, on a column that is missing. It goes on the experiments
  // source, not on the one above: a validity window and an owned key cannot coexist, and the
  // catalog rejects that combination outright (see the unit guards).
  M.fct_experiment_assignments.columns.push({ name: 'ghost_pair_id', data_type: 'string' });
  mcp(M.fct_experiment_assignments).entities = { ghost_pair: { type: 'unique', key: ['ghost_pair_id', 'player_id_of_internal'] } };
  mcp(M.fct_analytics_events).entities.ghost_pair = { type: 'foreign', key: ['event_id', 'player_id_of_internal'] };
  // (c) HALF a window: the start column is real, the end column is missing
  M.dim_users.columns.find((c) => c.name === 'install_time_valid_until').name = 'ghost_valid_end';
  mcp(M.dim_users).join.time.within = ['install_time_valid_from', 'ghost_valid_end'];
  // (d) a variant of a working relationship, on a missing column
  M.fct_crashlytics_events.columns.push({ name: 'ghost_tracking_id', data_type: 'string' });
  mcp(M.fct_crashlytics_events).entities.ad_funnel.variants.ghost = { key: ['ghost_tracking_id', 'player_id_of_internal'] };

  const phantomPath = join(tempDir('phantom'), 'catalog.yml');
  writeFileSync(phantomPath, yaml.dump(doc));
  phantom = loadCatalog(phantomPath, { profilesDir: BASE, projectDir: BASE });
  // every phantom declaration survives the LOAD — only the warehouse knows they are not there
  assert.equal(phantom.getModel('acquisition').scd, true, 'declared as slowly-changing before grounding');
  assert.ok(phantom.joinEntityNames().includes('ad_funnel_ghost'));
  assert.equal(phantom.joinTargetFor('ghost_pair'), 'experiments');

  ({ pruned: phantomPruned } = await groundCatalogToPhysical(phantom, backend, BASE));

  phantomEngine = settle(new Engine({ catalog: phantom, contextManager: ctxs, runner: backend }));
  const pc = await declare(phantomEngine, {
    name: 'jph',
    semantic_models: [{ source: 'acquisition', measures: [{ name: 'cost', expr: { fn: 'sum', args: [{ column: 'cost' }] } }] }],
    metrics: [{ name: 'cost', type: 'simple', measure: 'cost' }],
  });
  assert.equal(pc.parse.ok, true, `the grounded phantom catalog must still parse: ${JSON.stringify(pc.parse)}`);
  phantomCostCtx = pc.context_id;

  // ── the OWNED-FUNNEL catalog: the crash source declares itself the owner ─────────────
  // Same warehouse, one declaration changed: `ad_funnel` becomes `unique` on the crash
  // source, so it is the join TARGET and its attributes get a governed path. See section K.
  const od = yaml.load(readFileSync(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), 'utf8'));
  const OM = Object.fromEntries(od.models.map((x) => [x.name, x]));
  mcp(OM.fct_crashlytics_events).entities = { ad_funnel: { type: 'unique', key: ['rewarded_tracking_id', 'player_id_of_internal'] } };
  mcp(OM.fct_analytics_events).entities.ad_funnel = { type: 'foreign', key: ['tracking_id', 'player_id_of_internal'] };
  const ownerPath = join(tempDir('owner'), 'catalog.yml');
  writeFileSync(ownerPath, yaml.dump(od));
  ownerCatalog = loadCatalog(ownerPath, { profilesDir: BASE, projectDir: BASE });
  ownerEngine = settle(new Engine({ catalog: ownerCatalog, contextManager: ctxs, runner: backend }));
  const oc = await declare(ownerEngine, {
    name: 'jown',
    semantic_models: [{ source: 'events', measures: [{ name: 'evts', expr: { fn: 'count' } }] }, { source: 'crashlytics' }],
    metrics: [{ name: 'evts', type: 'simple', measure: 'evts' }],
  });
  assert.equal(oc.parse.ok, true, JSON.stringify(oc.parse));
  ownerCtx = oc.context_id;

  // Two MORE catalogs over the same warehouse, each making the crash source the owner of the
  // funnel with a DIFFERENT key, so that what gets generated can only come from what was
  // declared. `one` uses a ONE-column key, the rewarded funnel alone (unique on this data too: each
  // funnel is carried by one report); `true` uses funnel_tracking_id, one row per report by construction.
  // Each declares the join contract its key is — the semantic layer joins a model on its contract.
  const owned = (crashKey, eventKey, declareColumn, contract) => {
    const d = yaml.load(readFileSync(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), 'utf8'));
    const M = Object.fromEntries(d.models.map((x) => [x.name, x]));
    if (declareColumn) {
      M.fct_crashlytics_events.columns.push({
        name: declareColumn, data_type: 'string', config: { meta: { mcp: { index: false } } },
        description: 'The one ad funnel this crash report belongs to; unique per report.',
      });
    }
    mcp(M.fct_crashlytics_events).entities = { ad_funnel: { type: 'unique', key: crashKey } };
    mcp(M.fct_crashlytics_events).join = contract;
    mcp(M.fct_analytics_events).entities.ad_funnel = { type: 'foreign', key: eventKey };
    const at = join(tempDir('owned'), 'catalog.yml');
    writeFileSync(at, yaml.dump(d));
    return loadCatalog(at, { profilesDir: BASE, projectDir: BASE });
  };
  // `users` is loaded too: the catalog advertises TWO-hop paths through the owned
  // relationship (ad_funnel__user__*), and a path can only be served when the model that owns
  // its last leg is in the context.
  const evtsOn = async (engine, name) => {
    const r = await declare(engine, {
      name,
      semantic_models: [{ source: 'events', measures: [{ name: 'evts', expr: { fn: 'count' } }] }, { source: 'crashlytics' }, { source: 'users' }],
      metrics: [{ name: 'evts', type: 'simple', measure: 'evts' }],
    });
    assert.equal(r.parse.ok, true, JSON.stringify(r.parse));
    return r;
  };

  const byFormat = mcp(yaml.load(readFileSync(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), 'utf8')).models.find((x) => x.name === 'fct_crashlytics_events')).join;
  oneCatalog = owned(['rewarded_tracking_id'], ['tracking_id'], null, { unique: true, key: { funnel: byFormat.key.funnel }, select: byFormat.select });
  oneEngine = settle(new Engine({ catalog: oneCatalog, contextManager: ctxs, runner: backend }));
  oneCtx = (await evtsOn(oneEngine, 'jone')).context_id;

  trueCatalog = owned(['funnel_tracking_id'], ['tracking_id'], 'funnel_tracking_id', { unique: true, key: { funnel: 'funnel_tracking_id' } });
  trueEngine = settle(new Engine({ catalog: trueCatalog, contextManager: ctxs, runner: backend }));
  trueCtx = (await evtsOn(trueEngine, 'jtrue')).context_id;
}, opts);

after(async () => { backend?.close?.(); if (wh) await wh.stop(); });
const skip = (t) => { if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; } return false; };

/** Run a pipeline of steps and return its materialized rows. */
async function pipeRows(source, ...steps) {
  const s = await engine.build_model({ action: 'start', name: `jn_${seq++}`, source });
  for (const step of steps) {
    const r = await engine.build_model({ action: 'add_steps', context_id: s.context_id, steps: [step] });
    assert.ok(!r.error, `add_steps ${step.stage}: ${JSON.stringify(r.error)}`);
  }
  const c = await engine.build_model({ action: 'materialize', context_id: s.context_id });
  assert.equal(c.build?.ok, true, JSON.stringify(c.error || c.build));
  return c.rows;
}

/**
 * Join `source` to another model and report BOTH the row count and how many distinct base rows
 * they came from. Equal ⇒ the join added no duplicates; n > distinct ⇒ it fanned out.
 */
async function joinStats(source, joinStage, idColumn) {
  const rows = await pipeRows(source, joinStage, {
    stage: 'aggregate',
    measures: [{ name: 'n', expr: { fn: 'count' } }, { name: 'distinct_base', expr: { fn: 'count_distinct', args: [{ column: idColumn }] } }],
  });
  return { n: num(rows[0].n), distinct: num(rows[0].distinct_base) };
}

const q = (ctx, input) => engine.query_model({ context_id: ctx, ...input });

// ═══════════ A. THE JOIN CONTRACT: every part named, unique on the joined side ═══════════
//
// A model is joined onto rows by its join contract (meta.mcp.join): `on` names each part — a key or
// the time a column of the rows, a select part a value. The joined side is declared unique on it, so
// every row of the rows meets at most one row there: the count of the rows never grows. (The contract's
// refusals — a part left out, a model without one, an amount in attrs — are test/unit's.)

const USERS_AT = (time) => ({ source: 'users', on: { user: 'player_id_of_internal', time } });
const SPEND_ON = (time) => ({ source: 'acquisition', on: { user: 'player_id_of_internal', time } });
const CRASH_OF = (format) => ({ source: 'crashlytics', on: { user: 'player_id_of_internal', funnel: 'tracking_id', format } });

// 8. The spend record of the day: one row per player and day, so an event meets its player's record
//    of the day it happened, or none — 150 of the 184 events, none twice.
test('8. events meet the spend record of their day: 150 of 184, none twice, by channel 30 / 23 / 47 / 50', opts, async (t) => {
  if (skip(t)) return;
  const left = await joinStats('events', { stage: 'join', ...SPEND_ON('device_time'), attrs: [{ column: 'media_source' }] }, 'event_id');
  assert.deepEqual([left.n, left.distinct], [184, 184], 'a left join keeps every event, once');
  const rows = await pipeRows('events',
    { stage: 'join', ...SPEND_ON('device_time'), kind: 'inner', attrs: [{ column: 'media_source' }] },
    { stage: 'aggregate', group_by: ['media_source'], measures: [{ name: 'n', expr: { fn: 'count' } }] });
  assert.deepEqual(mapCol(rows, 'media_source', 'n'), { applovin: 30, google: 23, meta: 47, organic: 50 });
  assert.equal(sumCol(rows, 'n'), 150, 'the events on a day their player has a spend record');
});

// 9. One experiment, named by its value: the experiments contract narrows the assignments to it before
//    the join, so every event meets its player's ONE assignment — control 116 events of 6 players,
//    variant_b 68 of 6.
test('9. events meet their player\'s assignment in the experiment named: control 116 / variant_b 68', opts, async (t) => {
  if (skip(t)) return;
  const exp = { stage: 'join', source: 'experiments', on: { user: 'player_id_of_internal', experiment: 'checkout_flow' }, kind: 'inner', attrs: [{ column: 'variant_group' }] };
  const r = await joinStats('events', exp, 'event_id');
  assert.deepEqual([r.n, r.distinct], [184, 184]);
  const rows = await pipeRows('events', exp, { stage: 'aggregate', group_by: ['variant_group'], measures: [{ name: 'n', expr: { fn: 'count' } }, { name: 'players', expr: { fn: 'count_distinct', args: [{ column: 'player_id_of_internal' }] } }] });
  assert.deepEqual(mapCol(rows, 'variant_group', 'n'), { control: 116, variant_b: 68 });
  assert.deepEqual(mapCol(rows, 'variant_group', 'players'), { control: 6, variant_b: 6 });
});

// 10. The SCD join also works in a FILTER, not just a group-by: GB spend is 5.00.
test('10. filtering a metric by a point-in-time attribute: GB spend = 5.00', opts, async (t) => {
  if (skip(t)) return;
  const r = await q(acqCtx, { steps: [{ stage: 'where', conditions: [{ fn: 'eq', args: [{ source: 'users', column: 'country' }, { value: 'GB' }] }] }, { stage: 'metrics', metrics: ['cost'] }] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.ok(near(num(r.rows[0].cost), 5.0), `GB=${r.rows[0].cost}`);
});

// ═══════════ C. installs is SCD for every source, not just acquisition ═══════════

// 11. Events: the version valid at each event's time — one per event.
test('11. events join installs point-in-time: 184 rows, no duplicates', opts, async (t) => {
  if (skip(t)) return;
  const r = await joinStats('events', { stage: 'join', ...USERS_AT('device_time'), kind: 'inner', attrs: [{ column: 'country' }] }, 'event_id');
  assert.equal(r.n, 184);
  assert.equal(r.distinct, 184);
});

// 13. Attribution moves with the window: 30 of u1's events are US, 6 are GB.
test('13. events by country are attributed point-in-time: US 67 / GB 57 / DE 31 / BR 29', opts, async (t) => {
  if (skip(t)) return;
  const rows = await pipeRows('events',
    { stage: 'join', ...USERS_AT('device_time'), kind: 'inner', attrs: [{ column: 'country' }] },
    { stage: 'aggregate', group_by: ['country'], measures: [{ name: 'n', expr: { fn: 'count' } }] });
  const by = mapCol(rows, 'country', 'n');
  assert.equal(by.US, 67);
  assert.equal(by.GB, 57);
  assert.equal(by.DE, 31);
  assert.equal(by.BR, 29);
  assert.equal(sumCol(rows, 'n'), 184);
});

// (14. The governed path agrees, without anyone writing a window — events by users.country, US 67 /
// GB 57 / DE 31 / BR 29 as the pipeline's 13 — is asserted on 41's query, the same events x users
// layer grouped the same way: '[14]'.)

// 15. The crash source reaches installs the same way — nothing is specific to one source.
test('15. crash reports join installs point-in-time: 13 rows, no duplicates', opts, async (t) => {
  if (skip(t)) return;
  const r = await joinStats('crashlytics', { stage: 'join', ...USERS_AT('event_time'), kind: 'inner', attrs: [{ column: 'country' }] }, 'crash_id');
  assert.equal(r.n, 13);
  assert.equal(r.distinct, 13);
});

// ═══════════ D. the ad funnel: which crash report followed the ad an event belongs to ═══════════
//
// The crash source's contract: the player and the funnel, on the tracking-id column of the FORMAT the
// caller names. Its authors declare it unique — the authors' word, trusted, never checked — and the
// data holds it: a report carries a funnel only when it is the first report after it, so every funnel
// event meets at most one report (16's 8 rows from 8 events).

// 18. The key is (funnel, PLAYER), not the funnel alone. u2 and u10 share the funnel id 'fnl_dup', so a
//     player-blind join would hand u2's banner crashes to u10's ad events. It does not.
test('18. the player is part of the key: a shared funnel id does not leak across players', opts, async (t) => {
  if (skip(t)) return;
  const rows = await pipeRows('events',
    { stage: 'where', conditions: [{ fn: 'eq', args: [{ column: 'tracking_id' }, { value: 'fnl_dup' }] }] },
    { stage: 'join', ...CRASH_OF('banner'), attrs: [{ column: 'crash_id' }] },
    { stage: 'project', keep: ['event_id', 'crash_id'] });
  const pairs = new Set(rows.map((r) => `${r.event_id}|${r.crash_id ?? '-'}`));
  assert.deepEqual(pairs, new Set(['e133|k4', 'e134|k4', 'e149|-', 'e150|-']),
    "u2's events meet u2's banner report; u10's e149 / e150, same funnel id, meet none");
});

// ═══════════ E. GROUNDING: a declaration the warehouse does not back ═══════════
//
// The catalog is reconciled against the real tables on load, and anything the warehouse does
// not have is pruned. Two things used to survive that pruning and break downstream: the
// slowly-changing FLAG (leaving a `natural` entity with no window, which MetricFlow rejects
// outright) and a declared JOIN KEY (leaving `via` to build SQL against a missing column).
// Every case below runs against the same built warehouse, through real introspection.

// 21. A window whose columns were never built: the model must stop being slowly-changing, and —
//     the point of it — the manifest must still parse and the metric still answer. Before the
//     fix dbt rejected it: "natural entities are supported only with a validity window".
test('21. a phantom validity window is dropped and the source still queries: cost 17.50', opts, async (t) => {
  if (skip(t)) return;
  assert.match(String(phantomPruned.acquisition || ''), /ghost_valid_from/);
  assert.match(String(phantomPruned.acquisition || ''), /no longer treated as slowly-changing/);
  assert.ok(!phantom.getModel('acquisition').scd, 'the flag went with the columns');
  const r = await phantomEngine.query_model({ context_id: phantomCostCtx, steps: [{ stage: 'metrics', metrics: ['cost'] }] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.ok(near(num(r.rows[0].cost), 17.5), `cost=${r.rows[0].cost}`);
});

// 22. HALF a window is not a window: one bound survived, the other did not, so the model is not
//     slowly-changing either (MetricFlow needs exactly one start and one end).
test('22. a half-built window also drops the slowly-changing flag', opts, async (t) => {
  if (skip(t)) return;
  const dims = phantom.getModel('users').dimensions;
  assert.ok(dims.install_time_valid_from, 'the start column is real and survived');
  assert.ok(!dims.ghost_valid_end, 'the end column was never built and was pruned');
  assert.ok(!phantom.getModel('users').scd, 'one bound alone cannot make a validity window');
  assert.match(String(phantomPruned.users || ''), /no longer treated as slowly-changing/);
  // …and its join contract, which names the missing bound, is no longer offered: nothing joins on it
  assert.equal(phantom.joinContract('users'), null);
  assert.ok(!phantom.joinableModels().includes('users'));
  // …and with no contract it is joined by nothing: a semantic layer's join of it is refused (it would
  // match every version of u1), and a layer over the events alone still parses and answers
  await assert.rejects(() => phantomEngine.build_model({ action: 'start', name: 'jphev', source: 'events', steps: [{ stage: 'semantic_model', join: [{ source: 'users', on: { user: 'player_id_of_internal', time: 'device_time' } }], measures: [{ name: 'evts', expr: { fn: 'count' } }], metrics: [{ name: 'evts', type: 'simple', measure: 'evts' }] }] }),
    /'users' declares no join contract, so it is not joinable|unexpected property 'join'|`steps\.0\.join\.0/);
  const sm = await declare(phantomEngine, {
    name: 'jphev',
    semantic_models: [{ source: 'events', measures: [{ name: 'evts', expr: { fn: 'count' } }] }],
    metrics: [{ name: 'evts', type: 'simple', measure: 'evts' }],
  });
  assert.equal(sm.parse.ok, true, JSON.stringify(sm.parse));
  const res = await phantomEngine.query_model({ context_id: sm.context_id, steps: [{ stage: 'metrics', metrics: ['evts'] }] });
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.equal(sumCol(res.rows, 'evts'), 184);
});

// 23. A relationship whose key column is missing stops being offered to the semantic layer.
test('23. a phantom relationship is pruned', opts, async (t) => {
  if (skip(t)) return;
  assert.ok(!phantom.joinEntityNames().includes('ad_funnel_ghost'), 'not offered any more');
  assert.equal(phantom.entityKey('crashlytics', 'ad_funnel_ghost'), undefined);
  assert.match(String(phantomPruned.crashlytics || ''), /entity:ad_funnel_ghost/);
});

// 24. Pruning is surgical: the crash source's join contract, built on real columns, still joins on
//     every format with the same numbers as in the honest catalog.
test('24. the join contract is untouched by the pruning: 8 / 4 / 4', opts, async (t) => {
  if (skip(t)) return;
  assert.ok(phantom.joinContract('crashlytics'), 'the contract names real columns only, so it survives');
  // the join the pruned catalog generates for each format, run on the warehouse (section F's
  // technique: 32 holds what preview shows to what materialize builds) — nothing materialized.
  const n = async (format) => (await runSql(await generatedSql(phantomEngine, 'events',
    { stage: 'join', ...CRASH_OF(format), kind: 'inner', attrs: [{ column: 'crash_id' }] }))).length;
  assert.equal(await n('rewarded'), 8, 'rewarded');
  assert.equal(await n('interstitial'), 4, 'interstitial');
  assert.equal(await n('banner'), 4, 'banner');
});

// 25. When the pruned key was the OWNER of a relationship, the ownership index must be rebuilt —
//     otherwise a target keeps being advertised by a model that no longer declares the key.
test('25. pruning an owning key clears the join target', opts, async (t) => {
  if (skip(t)) return;
  assert.equal(phantom.entityKey('experiments', 'ghost_pair'), undefined, 'the owner lost the key');
  assert.equal(phantom.joinTargetFor('ghost_pair'), undefined, 'so nothing points at it as a target');
  assert.ok(!phantom.reachableAttributes().some((r) => r.via === 'ghost_pair'), 'and it offers no attribute through it');
  // the events side still declares it, but with no owner it is not offered as a join
  assert.ok(!phantom.joinEntityNames().includes('ghost_pair'));
  // the owner's other, real relationship is untouched — and its join contract still joins, on the
  // warehouse: one assignment per player in the experiment, so every one of the 184 events pairs once.
  assert.deepEqual(phantom.entityKey('experiments', 'user'), [{ column: 'player_id_of_internal' }]);
  assert.equal(phantom.joinTargetFor('user'), 'users');
  const st = await phantomEngine.build_model({ action: 'start', name: `ph_${seq++}`, source: 'events' });
  for (const stage of [
    { stage: 'join', source: 'experiments', on: { user: 'player_id_of_internal', experiment: 'checkout_flow' }, kind: 'inner', attrs: [{ column: 'variant_group' }] },
    { stage: 'aggregate', measures: [{ name: 'n', expr: { fn: 'count' } }, { name: 'distinct_base', expr: { fn: 'count_distinct', args: [{ column: 'event_id' }] } }] },
  ]) {
    const r = await phantomEngine.build_model({ action: 'add_steps', context_id: st.context_id, steps: [stage] });
    assert.ok(!r.error, JSON.stringify(r.error));
  }
  const c = await phantomEngine.build_model({ action: 'materialize', context_id: st.context_id });
  assert.equal(c.build?.ok, true, JSON.stringify(c.error || c.build));
  assert.equal(num(c.rows[0].n), 184);
  assert.equal(num(c.rows[0].distinct_base), 184, 'and it did not fan out');
});

// ═══════════ discovery + guards (input validation) ═══════════

test('relationships are discoverable, with their key columns and what they point at', opts, async (t) => {
  if (skip(t)) return;
  const crash = Object.fromEntries((await engine.semantic_index({ source: 'crashlytics' })).relationships.map((r) => [r.entity, r]));
  assert.deepEqual(crash.ad_funnel_rewarded.key, ['rewarded_tracking_id', 'player_id_of_internal']);
  assert.deepEqual(crash.ad_funnel_banner.key, ['banner_tracking_id', 'player_id_of_internal']);
  assert.equal(crash.ad_funnel_rewarded.joins, undefined, 'nobody owns the funnel key — no governed path');
  assert.equal(crash.user.joins, 'users');
  const ev = Object.fromEntries((await engine.semantic_index({ source: 'events' })).relationships.map((r) => [r.entity, r]));
  assert.deepEqual(ev.ad_funnel_rewarded.key, ['tracking_id', 'player_id_of_internal'],
    'the single-column side answers every variant');
});

// A relationship nobody owns has NO governed path — MetricFlow can only join onto a unique
// key. Asking for one must be refused rather than silently answered from some other join.
test('an unowned relationship offers no governed group-by path', opts, async (t) => {
  if (skip(t)) return;
  const r = await q(evCtx, { steps: [{ stage: 'metrics', metrics: ['evts'], group_by: [{ source: 'users', column: 'country', via: 'ad_funnel_rewarded' }] }] }).catch((e) => ({ ok: false, error: String(e.message || e) }));
  assert.equal(r.ok, false, 'the funnel key must not be groupable in a metric query');
  // (…while the owned player key is, and answers: the same query is 41's, by country — 14's numbers.)
});

// (The join guards — a model with no contract, a self-join, the earlier with / via, an amount in
// attrs, all refused at add_steps — are test/unit/build-pipeline-model.test.js's: no warehouse is read.)

// ═══════════ F. THE GENERATED JOIN CODE, PROVEN BY RUNNING IT ═══════════
//
// The rule still holds: nothing below matches SQL as text. What these cases do instead is take
// the code the tool ACTUALLY GENERATED for a join, hand it to the same warehouse, and compare
// the rows it returns against a reference query WRITTEN BY HAND in the test — the join as it
// was meant to come out. Identical result sets are the proof: a wrong ON column, a lost
// validity predicate, the wrong variant or the wrong join kind all move the rows apart, and
// the reference cannot drift along with the generator because nothing generates it.
//
// The only text operation here is resolving dbt's `ref()` so the snippet can be executed at
// all — plumbing, not an assertion.

const REF = /\{\{\s*ref\(\s*'([^']+)'\s*\)\s*\}\}/g;

/** Execute SQL on the very warehouse the tools ran against (same DuckDB database). */
async function runSql(sql) {
  const { rows } = await wh.query(sql.replace(REF, (_, m) => `main.${m}`).trim().replace(/;\s*$/, ''));
  return rows;
}

/** Project a query to `cols` in a fixed order, so two queries are comparable row by row. */
function ordered(sql, cols) {
  const by = cols.map((_, i) => `${i + 1} NULLS LAST`).join(', ');
  return runSql(`SELECT ${cols.join(', ')} FROM (${sql.trim().replace(/;\s*$/, '')}) x ORDER BY ${by}`);
}

/**
 * The SQL the tool generates for these steps — read from `preview`, nothing built. The engine
 * is the honest one unless a case passes another (24 previews on the pruned phantom catalog).
 */
async function generatedSql(...args) {
  const eng = typeof args[0] === 'string' ? engine : args.shift();
  const [source, ...steps] = args;
  const s = await eng.build_model({ action: 'start', name: `gen_${seq++}`, source });
  for (const step of steps) {
    const r = await eng.build_model({ action: 'add_steps', context_id: s.context_id, steps: [step] });
    assert.ok(!r.error, `add_steps ${step.stage}: ${JSON.stringify(r.error)}`);
  }
  const p = await eng.build_model({ action: 'preview', context_id: s.context_id });
  assert.ok(p.model_sql, 'preview returns the generated model SQL');
  return p.model_sql;
}

const ACQ_TO_USERS_PIT = `
  SELECT a.acquisition_id, u.country
    FROM {{ ref('fct_player_acquisition') }} a
    JOIN {{ ref('dim_users') }} u
      ON a.player_id_of_internal = u.player_id_of_internal
     AND a.spend_date BETWEEN u.install_time_valid_from AND u.install_time_valid_until`;

// 26. The contract's key + the time named must generate exactly the join a human would write.
test('26. the generated point-in-time join returns what a hand-written one returns', opts, async (t) => {
  if (skip(t)) return;
  const gen = await generatedSql('acquisition', { stage: 'join', ...USERS_AT('spend_date'), kind: 'inner', attrs: [{ column: 'country' }] });
  const want = await ordered(ACQ_TO_USERS_PIT, ['acquisition_id', 'country']);
  assert.equal(want.length, 13, 'the reference join is itself the 13-row point-in-time answer');
  assert.deepEqual(await ordered(gen, ['acquisition_id', 'country']), want);
  // the key alone would match both of u1's install versions: 15 rows — the window is what keeps 13
  const keyOnly = await ordered(`
    SELECT a.acquisition_id, u.country
      FROM {{ ref('fct_player_acquisition') }} a
      JOIN {{ ref('dim_users') }} u ON a.player_id_of_internal = u.player_id_of_internal`, ['acquisition_id', 'country']);
  assert.equal(keyOnly.length, 15);
});

// 28. Each format must generate a join on ITS OWN tracking column. Three references, three
//     answers: if the generator ignored the caller's word they could not all match.
test('28. each ad format generates the join on its own tracking column', opts, async (t) => {
  if (skip(t)) return;
  const refFor = (col) => `
    SELECT e.event_id, c.crash_id
      FROM {{ ref('fct_analytics_events') }} e
      JOIN {{ ref('fct_crashlytics_events') }} c
        ON c.${col} = e.tracking_id
       AND c.player_id_of_internal = e.player_id_of_internal`;
  for (const [format, col, n] of [['rewarded', 'rewarded_tracking_id', 8], ['interstitial', 'interstitial_tracking_id', 4], ['banner', 'banner_tracking_id', 4]]) {
    const gen = await generatedSql('events', { stage: 'join', ...CRASH_OF(format), kind: 'inner', attrs: [{ column: 'crash_id' }] });
    const want = await ordered(refFor(col), ['event_id', 'crash_id']);
    assert.equal(want.length, n, `${format}: the reference itself`);
    const got = await ordered(gen, ['event_id', 'crash_id']);
    assert.deepEqual(got, want, format);
    // '16. the events of a rewarded funnel meet its crash report: 8 rows from 8 events, 4 reports' —
    // the contract's `unique` holds, so no event meets two reports
    if (format === 'rewarded') {
      assert.equal(new Set(got.map((r) => String(r.event_id))).size, 8, '[16] from 8 events');
      assert.equal(new Set(got.map((r) => String(r.crash_id))).size, 4, '[16] 4 crash reports: k1, k6, k9, k13');
    }
  }
});

// 29. BOTH parts of the key must reach the generated code. Drop the player half by hand and the
//     shared funnel id 'fnl_dup' hands u2's banner report to u10's events — 6 rows instead of 4.
test('29. the composite key generates BOTH equalities, not just the funnel id', opts, async (t) => {
  if (skip(t)) return;
  const gen = await generatedSql('events', { stage: 'join', ...CRASH_OF('banner'), kind: 'inner', attrs: [{ column: 'crash_id' }] });
  const got = await ordered(gen, ['event_id', 'crash_id']);
  const funnelOnly = await ordered(`
    SELECT e.event_id, c.crash_id
      FROM {{ ref('fct_analytics_events') }} e
      JOIN {{ ref('fct_crashlytics_events') }} c ON c.banner_tracking_id = e.tracking_id`, ['event_id', 'crash_id']);
  assert.equal(funnelOnly.length, 6, 'the funnel id ALONE pulls u10 into k4');
  assert.equal(got.length, 4);
  assert.notDeepEqual(got, funnelOnly);
  // '19. an empty format column matches nothing': only the reports that recorded a banner funnel
  assert.equal(new Set(got.map((r) => String(r.crash_id))).size, 2, '[19] only k4 and k11 carry a banner funnel');
});

// 30. `kind` must generate the join type it names: left-joined, every event stays, a NULL where no
//     report matched.
test('30. kind:left generates a LEFT JOIN — 184 rows, 180 of them unmatched', opts, async (t) => {
  if (skip(t)) return;
  const gen = await generatedSql('events', { stage: 'join', ...CRASH_OF('banner'), attrs: [{ column: 'crash_id' }] });
  const got = await ordered(gen, ['event_id', 'crash_id']);
  const want = await ordered(`
    SELECT e.event_id, c.crash_id
      FROM {{ ref('fct_analytics_events') }} e
      LEFT JOIN {{ ref('fct_crashlytics_events') }} c
        ON c.banner_tracking_id = e.tracking_id
       AND c.player_id_of_internal = e.player_id_of_internal`, ['event_id', 'crash_id']);
  assert.equal(want.length, 184, '4 events with their one report + 180 events with none');
  assert.equal(want.filter((r) => r.crash_id == null).length, 180);
  assert.deepEqual(got, want);
  assert.equal(new Set(got.map((r) => String(r.event_id))).size, 184, '[19] a left join keeps every event');
});

// 31. The same day: the time part of a per-day contract compares DAYS on both sides — an event at
//     14:00 meets its player's spend row stamped at midnight of that day.
test('31. a same-day contract generates the key AND the day: 150 events meet a spend row, by hand too', opts, async (t) => {
  if (skip(t)) return;
  const gen = await generatedSql('events', { stage: 'join', ...SPEND_ON('device_time'), kind: 'inner', attrs: [{ column: 'acquisition_id' }] });
  const want = await ordered(`
    SELECT e.event_id, a.acquisition_id
      FROM {{ ref('fct_analytics_events') }} e
      JOIN {{ ref('fct_player_acquisition') }} a
        ON e.player_id_of_internal = a.player_id_of_internal
       AND CAST(e.device_time AS DATE) = CAST(a.spend_date AS DATE)`, ['event_id', 'acquisition_id']);
  assert.equal(want.length, 150);
  const got = await ordered(gen, ['event_id', 'acquisition_id']);
  assert.deepEqual(got, want);
  assert.equal(new Set(got.map((r) => String(r.event_id))).size, 150, 'one spend row per event: the day is part of the key');
  // the player key alone would pair each event with EVERY spend day of its player: 220
  const keyOnly = await runSql(`SELECT count(*) AS n FROM {{ ref('fct_analytics_events') }} e JOIN {{ ref('fct_player_acquisition') }} a ON e.player_id_of_internal = a.player_id_of_internal`);
  assert.equal(num(keyOnly[0].n), 220);
});

// 32. The code shown in `preview` must be the code `materialize` actually builds — otherwise
//     everything proven above is proven about SQL nobody runs.
test('32. what preview shows is what materialize builds', opts, async (t) => {
  if (skip(t)) return;
  const steps = [
    { stage: 'join', ...USERS_AT('spend_date'), kind: 'inner', attrs: [{ column: 'country' }] },
    { stage: 'aggregate', group_by: ['country'], measures: [{ name: 'total', expr: { fn: 'sum', args: [{ column: 'cost' }] } }] },
  ];
  const direct = mapCol(await runSql(await generatedSql('acquisition', ...steps)), 'country', 'total');
  const builtRows = await pipeRows('acquisition', ...steps);
  const built = mapCol(builtRows, 'country', 'total');
  assert.deepEqual(Object.keys(built).sort(), Object.keys(direct).sort());
  for (const k of Object.keys(direct)) assert.ok(near(built[k], direct[k]), `${k}: built=${built[k]} previewed=${direct[k]}`);
  // '3. the windowed join leaves the total spend at 17.50' — money is what duplicates corrupt
  assert.ok(near(sumCol(builtRows, 'total'), 17.5), `[3] total=${sumCol(builtRows, 'total')}`);
  // '4. spend by country is attributed to the version valid on the spend day': u1's 0.50 on 01-03
  // is GB, its 1.50 on 01-01 is US
  assert.ok(near(built.US, 6.75), `[4] US=${built.US}`);
  assert.ok(near(built.GB, 5.0), `[4] GB=${built.GB}`);
  assert.ok(near(built.DE, 4.0), `[4] DE=${built.DE}`);
  assert.ok(near(built.BR, 1.75), `[4] BR=${built.BR}`);
});

// 33. The GOVERNED path generates its own join, from the entity the semantic model declares.
//     Run that SQL too: the semantic layer's point-in-time join must land on the same numbers
//     as the hand-written one, or the generated YAML describes the wrong key.
test('33. the semantic layer generates the point-in-time join correctly', opts, async (t) => {
  if (skip(t)) return;
  const r = await q(acqCtx, { steps: [{ stage: 'metrics', metrics: ['cost'], group_by: [{ source: 'users', column: 'country' }] }], dry_run: true });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.ok(r.sql, 'dry_run returns the SQL the semantic layer generated');
  const rows = await runSql(r.sql);
  assert.ok(rows.length, 'the generated query returned rows');
  const cKey = Object.keys(rows[0]).find((k) => k.includes('country'));
  const mKey = Object.keys(rows[0]).find((k) => k !== cKey && k.includes('cost'));
  const by = mapCol(rows, cKey, mKey);
  const want = await runSql(`
    SELECT u.country, SUM(a.cost) AS total
      FROM {{ ref('fct_player_acquisition') }} a
      JOIN {{ ref('dim_users') }} u
        ON a.player_id_of_internal = u.player_id_of_internal
       AND a.spend_date BETWEEN u.install_time_valid_from AND u.install_time_valid_until
     GROUP BY 1`);
  const ref = mapCol(want, 'country', 'total');
  assert.deepEqual(Object.keys(by).sort(), Object.keys(ref).sort());
  for (const k of Object.keys(ref)) assert.ok(near(by[k], ref[k]), `${k}: generated=${by[k]} reference=${ref[k]}`);
  assert.ok(near(ref.US, 6.75) && near(ref.GB, 5.0) && near(ref.DE, 4.0) && near(ref.BR, 1.75));
});

// ═══════════ G. THE SAME JOIN THROUGH A REAL MCP CALL ═══════════
//
// (34) A point-in-time pipeline join driven over the protocol is mcp-end-to-end.test.js #3, a
// refusal there surfacing as an MCP tool error is its #5, the by-country numbers of these stages
// are 32's, and the `via` refusal is the join guards' (test/unit/build-pipeline-model.test.js).

// ═══════════ H. ALL FOUR SOURCES IN ONE CHAIN ═══════════
//
// "Which crash report followed the rewarded ad an event belongs to, for a player from which country,
// bought through which channel that day" touches the events source, the install record, the spend
// table and the crash source in one pipeline. Every join is a CONTRACT the joined model declares —
// a point-in-time one, a same-day one, a part chosen by a word — and each part names a column of the
// event rows, so the whole chain hangs off the event.

/** Materialize a pipeline once per key and memoize — the chain is reused across cases. */
const chainCache = new Map();
async function chain(key, source, steps) {
  if (!chainCache.has(key)) chainCache.set(key, await pipeRows(source, ...steps));
  return chainCache.get(key);
}

const CHAIN = [
  { stage: 'join', ...USERS_AT('device_time'), kind: 'inner', attrs: [{ column: 'country' }] },
  { stage: 'join', ...SPEND_ON('device_time'), kind: 'inner', attrs: [{ column: 'acquisition_id' }, { column: 'media_source' }] },
  { stage: 'join', ...CRASH_OF('rewarded'), kind: 'inner', attrs: [{ column: 'crash_id' }] },
  { stage: 'project', keep: ['crash_id', 'event_id', 'acquisition_id', 'country', 'media_source'] },
];

// 35. Three contracts in one pipeline over four sources: the 8 (event, report) pairs of the rewarded
//     funnels all fall on a day their player has a spend row — 8 events, 4 reports, 4 spend rows.
test('35. four sources in one pipeline: 8 rows, 8 events, 4 crashes, 4 spend rows', opts, async (t) => {
  if (skip(t)) return;
  const rows = await chain('events', 'events', CHAIN);
  assert.equal(rows.length, 8);
  assert.equal(new Set(rows.map((r) => String(r.event_id))).size, 8);
  assert.equal(new Set(rows.map((r) => String(r.crash_id))).size, 4, 'k1, k6, k9, k13');
  assert.equal(new Set(rows.map((r) => String(r.acquisition_id))).size, 4);
});

// 37. Each row is attributed at ITS event's instant and day: u1's rewarded funnel ran while it was US.
test('37. the chain attributes each event at its own instant: US 2 / GB 4 / BR 2; meta 4 / applovin 2 / organic 2', opts, async (t) => {
  if (skip(t)) return;
  const rows = await chain('events', 'events', CHAIN);
  const countBy = (col) => rows.reduce((m, r) => ({ ...m, [String(r[col])]: (m[String(r[col])] || 0) + 1 }), {});
  assert.deepEqual(countBy('country'), { US: 2, GB: 4, BR: 2 });
  assert.deepEqual(countBy('media_source'), { meta: 4, applovin: 2, organic: 2 });
});

// 38. And the CODE the four-way chain generates is the four-way join a human would write —
//     executed on the warehouse and compared row for row (section F, extended to a chain).
test('38. the generated four-way join matches a hand-written one', opts, async (t) => {
  if (skip(t)) return;
  const gen = await generatedSql('events', ...CHAIN.slice(0, 3));
  const cols = ['crash_id', 'event_id', 'acquisition_id', 'country'];
  const want = await ordered(`
    SELECT c.crash_id, e.event_id, a.acquisition_id, u.country
      FROM {{ ref('fct_analytics_events') }} e
      JOIN {{ ref('dim_users') }} u
        ON e.player_id_of_internal = u.player_id_of_internal
       AND e.device_time BETWEEN u.install_time_valid_from AND u.install_time_valid_until
      JOIN {{ ref('fct_player_acquisition') }} a
        ON e.player_id_of_internal = a.player_id_of_internal
       AND CAST(e.device_time AS DATE) = CAST(a.spend_date AS DATE)
      JOIN {{ ref('fct_crashlytics_events') }} c
        ON c.rewarded_tracking_id = e.tracking_id
       AND c.player_id_of_internal = e.player_id_of_internal`, cols);
  assert.equal(want.length, 8);
  assert.deepEqual(await ordered(gen, cols), want);
});

// 40. The GOVERNED path over two facts at once: a spend measure and an event measure in one
//     task, both reaching the SAME slowly-changing install record by the declared player key,
//     plus a derived metric dividing one by the other across them. MetricFlow applies each
//     source's point-in-time join itself.
test('40. governed: spend and events from two sources, sliced by the same install attribute', opts, async (t) => {
  if (skip(t)) return;
  const task = await declare(engine, {
    name: 'jmix',
    semantic_models: [{ source: 'acquisition', measures: [{ name: 'cost', expr: { fn: 'sum', args: [{ column: 'cost' }] } }] }, { source: 'events', measures: [{ name: 'evts', expr: { fn: 'count' } }] }, { source: 'users' }],
    metrics: [
      { name: 'cost', type: 'simple', measure: 'cost' },
      { name: 'evts', type: 'simple', measure: 'evts' },
      { name: 'cost_per_event', type: 'derived', expr: { fn: 'div', args: [{ metric: 'cost' }, { metric: 'evts' }] } },
    ],
  });
  assert.equal(task.parse.ok, true, JSON.stringify(task.parse));
  const r = await engine.query_model({
    context_id: task.context_id,
    steps: [{ stage: 'metrics', metrics: ['cost', 'evts', 'cost_per_event'], group_by: [{ source: 'users', column: 'country' }] }],
  });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const key = r.columns.map((c) => c.name).find((n) => n.includes('country'));
  const by = Object.fromEntries(r.rows.map((x) => [String(x[key]), x]));
  for (const [country, cost, evts] of [['US', 6.75, 67], ['GB', 5.0, 57], ['DE', 4.0, 31], ['BR', 1.75, 29]]) {
    assert.ok(near(num(by[country].cost), cost), `${country} cost=${by[country].cost}`);
    assert.equal(num(by[country].evts), evts, `${country} evts`);
    assert.ok(near(num(by[country].cost_per_event), cost / evts, 1e-6), `${country} cpe=${by[country].cost_per_event}`);
  }
  // neither source fanned the other out: the totals are still the honest per-source totals.
  assert.ok(near(sumCol(r.rows, 'cost'), 17.5));
  assert.equal(sumCol(r.rows, 'evts'), 184);
});

// ═══════════ I. THE GOVERNED SIDE OF THE SAME RULES ═══════════
//
// The pipeline cases above prove what `via` builds. These prove the metric-query side of the
// same declarations: which join paths a context actually offers, what happens when the model
// that owns the path was not loaded, and that measures from three different sources line up on
// metric_time without any of them joining the others.

// 41. A governed join path is not free-floating: the model that OWNS the relationship has to be
//     loaded into the task. Refused with the fix, not answered from somewhere else — and the
//     same task WITH the model answers.
test('41. a join path without its owning model is refused, and works once loaded — and (14) governed = pipeline for events too', opts, async (t) => {
  if (skip(t)) return;
  const bare = await declare(engine, {
    name: 'jbare',
    semantic_models: [{ source: 'events', measures: [{ name: 'evts', expr: { fn: 'count' } }] }],
    metrics: [{ name: 'evts', type: 'simple', measure: 'evts' }],
  });
  assert.equal(bare.parse.ok, true, JSON.stringify(bare.parse));
  await assert.rejects(
    () => engine.query_model({ context_id: bare.context_id, steps: [{ stage: 'metrics', metrics: ['evts'], group_by: [{ source: 'users', column: 'country' }] }] }),
    /needs model 'users', which this context does not read.*join it in the build's semantic_model step — \{ source: 'users', on: \{ … \} \}/s,
  );
  // the metric itself answers fine — it is the PATH that needed the model, not the measure.
  const flat = await engine.query_model({ context_id: bare.context_id, steps: [{ stage: 'metrics', metrics: ['evts'] }] });
  assert.equal(flat.ok, true, JSON.stringify(flat.error));
  assert.equal(num(flat.rows[0].evts), 184);
  // the fix the refusal names — the model joined in the semantic_model step on its contract — loads it
  // into this context, and the same group_by now answers, every event counted once
  const loadedNow = await editLayer(engine, bare.context_id, (st) => ({ ...st, join: [{ source: 'users', on: { user: 'player_id_of_internal', time: 'device_time' } }] }));
  assert.equal(loadedNow.parse.ok, true, JSON.stringify(loadedNow.parse));
  const viaUpdate = await engine.query_model({ context_id: bare.context_id, steps: [{ stage: 'metrics', metrics: ['evts'], group_by: [{ source: 'users', column: 'country' }] }] });
  assert.equal(viaUpdate.ok, true, JSON.stringify(viaUpdate.error));
  assert.equal(sumCol(viaUpdate.rows, 'evts'), 184);
  // '14. governed = pipeline for events too': the point-in-time breakdown by country, as 13's pipeline
  // attributes it — MetricFlow applies the window itself
  const by = mapCol(viaUpdate.rows, groupCol(viaUpdate, 'evts'), 'evts');
  assert.equal(by.US, 67, '[14] US');
  assert.equal(by.GB, 57, '[14] GB');
  assert.equal(by.DE, 31, '[14] DE');
  assert.equal(by.BR, 29, '[14] BR');
  assert.equal(sumCol(viaUpdate.rows, 'evts'), 184, '[14] every event once');
});

// 42. A part names a column of the ROWS as they are at that step — a column an earlier join brought
//     keys the next one: a crash report's install day (from the install record valid at the crash)
//     finds the player's spend record of that day — 13 reports, by channel applovin 3 / google 2 /
//     meta 5 / organic 3.
test('42. a joined column keys the next join: the spend record of the install day, 13 reports', opts, async (t) => {
  if (skip(t)) return;
  const rows = await pipeRows('crashlytics',
    { stage: 'join', ...USERS_AT('event_time'), kind: 'inner', attrs: [{ column: 'install_date' }] },
    { stage: 'join', ...SPEND_ON('install_date'), kind: 'inner', attrs: [{ column: 'media_source' }] },
    { stage: 'aggregate', group_by: ['media_source'], measures: [{ name: 'n', expr: { fn: 'count' } }] });
  assert.deepEqual(mapCol(rows, 'media_source', 'n'), { applovin: 3, google: 2, meta: 5, organic: 3 });
  // …and a part naming a column the rows do not have (yet) is refused at the step
  const s2 = await engine.build_model({ action: 'start', name: `ch_${seq++}`, source: 'crashlytics' });
  await assert.rejects(
    () => engine.build_model({ action: 'add_steps', context_id: s2.context_id, steps: [{ stage: 'join', ...SPEND_ON('install_date'), attrs: [{ column: 'media_source' }] }] }),
    /install_date/,
  );
});

// (43. Three sources side by side on metric_time, each keeping its own total — 17.50 / 184 / 13 —
// is mcp-end-to-end.test.js #7, the same declaration and query over the protocol.)

// ═══════════ J. `attrs` IS THE CONTRACT ═══════════
//
// A join brings EXACTLY the columns the caller lists, and nothing else: there is no implicit set to
// reason about, so what the next stage sees is what was asked for, and a column that was not listed is
// an "unknown column" error rather than a surprise. The list may name any ATTRIBUTE of the joined
// model — its ids, its time, its event-scoped `*_of_event_data` payload — but not an amount: carried
// onto rows an amount repeats on every row that meets it, so it is a measure of the semantic layer.
// A name cannot be used twice: a collision is refused with the rename to apply.

/** events → the crash report of the rewarded funnel → the spend record of the day. Every column named. */
const CHAIN_LISTED = [
  { stage: 'join', ...CRASH_OF('rewarded'), kind: 'inner', attrs: [{ column: 'crash_id' }, { column: 'issue_title_of_event_data' }, { column: 'event_time', name: 'crashed_at' }] },
  { stage: 'join', ...SPEND_ON('device_time'), kind: 'inner', attrs: [{ column: 'acquisition_id' }, { column: 'spend_date' }, { column: 'media_source' }] },
];

// 44. Fields from all three models in one aggregate — ids, event-scoped payload, a joined time.
test('44. any attribute of a joined model can be listed: 8 rows, 4 reports, 4 issues, 8 events, 4 funnels, 4 spend rows', opts, async (t) => {
  if (skip(t)) return;
  const rows = await pipeRows('events', ...CHAIN_LISTED, {
    stage: 'aggregate',
    measures: [
      { name: 'n', expr: { fn: 'count' } },
      { name: 'crashes', expr: { fn: 'count_distinct', args: [{ column: 'crash_id' }] } },
      { name: 'issues', expr: { fn: 'count_distinct', args: [{ column: 'issue_title_of_event_data' }] } },
      { name: 'events', expr: { fn: 'count_distinct', args: [{ column: 'event_id' }] } },
      { name: 'funnels', expr: { fn: 'count_distinct', args: [{ column: 'tracking_id' }] } },
      { name: 'spend_rows', expr: { fn: 'count_distinct', args: [{ column: 'acquisition_id' }] } },
      // a joined time is a time: it orders against the rows' own
      { name: 'after', expr: { fn: 'count', args: [{ fn: 'case', cases: [{ when: [{ fn: 'gt', args: [{ column: 'crashed_at' }, { column: 'device_time' }] }], then: { value: 1 } }] }] } },
    ],
  });
  const r = rows[0];
  assert.equal(num(r.n), 8);
  assert.equal(num(r.crashes), 4);
  assert.equal(num(r.issues), 4);
  assert.equal(num(r.events), 8);
  assert.equal(num(r.funnels), 4, 'fnl_01, fnl_04, fnl_06, fnl_08');
  assert.equal(num(r.spend_rows), 4);
  const want = await runSql(`SELECT count(*) AS n FROM {{ ref('fct_analytics_events') }} e JOIN {{ ref('fct_crashlytics_events') }} c ON c.rewarded_tracking_id = e.tracking_id AND c.player_id_of_internal = e.player_id_of_internal JOIN {{ ref('fct_player_acquisition') }} a ON e.player_id_of_internal = a.player_id_of_internal AND CAST(e.device_time AS DATE) = CAST(a.spend_date AS DATE) WHERE c.event_time > e.device_time`);
  assert.equal(num(r.after), num(want[0].n), 'the crash after the ad, compared as moments');
});

// (45. Grouping by a joined attribute — meta 4 / organic 2 / applovin 2 — is mcp-end-to-end.test.js
// #9's slice.)

// 47. What was listed is what is there — and nothing else. The joined model has a dozen more
//     columns; none of them leaked in, so naming one is a plain unknown-column failure.
test('47. only the listed columns arrive: an unlisted one is an unknown column', opts, async (t) => {
  if (skip(t)) return;
  const narrow = { stage: 'join', ...CRASH_OF('rewarded'), kind: 'inner', attrs: [{ column: 'crash_id' }] };
  const rows = await pipeRows('events', narrow,
    { stage: 'aggregate', measures: [{ name: 'crashes', expr: { fn: 'count_distinct', args: [{ column: 'crash_id' }] } }] });
  assert.equal(num(rows[0].crashes), 4);
  for (const unlisted of ['issue_title_of_event_data', 'rewarded_tracking_id', 'is_fatal_of_event_data']) {
    await assert.rejects(
      () => pipeRows('events', narrow, { stage: 'aggregate', measures: [{ name: 'x', expr: { fn: 'count_distinct', args: [{ column: unlisted }] } }] }),
      new RegExp(`unknown column '${unlisted}'`),
      `${unlisted} must not appear unasked`,
    );
  }
  const wider = await pipeRows('events',
    { ...narrow, attrs: [{ column: 'crash_id' }, { column: 'issue_title_of_event_data' }] },
    { stage: 'aggregate', measures: [{ name: 'issues', expr: { fn: 'count_distinct', args: [{ column: 'issue_title_of_event_data' }] } }] });
  assert.equal(num(wider[0].issues), 4);
});

// (48. Every way a name can end up used twice is refused at add_steps, with the reason and the
// rename: test/unit/build-pipeline-model.test.js. The rename the error prints, built with both
// sides present — fatal_crash 4 / non_fatal 2 / anr 2 beside ad_started 4 / ad_finished 4 — is
// mcp-end-to-end.test.js #5(c).)

// 49. The all-at-once path is held to the same contract — a pipeline handed over whole, or
//     merely previewed, is rejected the same way instead of building a model that misses a
//     field. crashlytics and the install record both carry app_version and device_model, and
//     they mean different things: the version that crashed vs the version at install.
test('49. a pipeline passed whole obeys the same contract', opts, async (t) => {
  if (skip(t)) return;
  const preview = (attrs) => engine._buildPipeline({
    name: 'contract_preview', dry_run: true,
    pipeline: { source: 'crashlytics', stages: [{ stage: 'join', ...USERS_AT('event_time'), kind: 'inner', ...(attrs ? { attrs } : {}) }] },
  });
  await assert.rejects(() => preview(null), /missing required property 'attrs' — a list of \{ column, … \}, column one of: .*country/s);
  await assert.rejects(() => preview([{ column: 'app_version' }]), /already has a column named 'app_version'.*name: 'users_app_version'/s);
  const ok = await preview([{ column: 'app_version', name: 'users_app_version' }, { column: 'country' }]);
  assert.ok(ok.model_sql, 'the resolved preview renders');

  // and it builds, with BOTH versions in the result.
  const rows = await pipeRows('crashlytics',
    { stage: 'join', ...USERS_AT('event_time'), kind: 'inner', attrs: [{ column: 'app_version', name: 'users_app_version' }, { column: 'country' }] },
    { stage: 'aggregate', measures: [
      { name: 'n', expr: { fn: 'count' } },
      { name: 'crash_versions', expr: { fn: 'count_distinct', args: [{ column: 'app_version' }] } },
      { name: 'install_versions', expr: { fn: 'count_distinct', args: [{ column: 'users_app_version' }] } },
      { name: 'countries', expr: { fn: 'count_distinct', args: [{ column: 'country' }] } },
    ] });
  assert.equal(num(rows[0].n), 13, 'point-in-time: one install version per crash');
  assert.ok(num(rows[0].crash_versions) >= 1, 'the crash side stayed the base column');
  assert.ok(num(rows[0].install_versions) >= 1, 'and the install side arrived renamed');
  assert.equal(num(rows[0].countries), 4);
});

// ═══════════ K. A FACT THAT OWNS A RELATIONSHIP ═══════════
//
// So far the ad funnel has had no owner: several events share one id, so neither side is
// unique on it and it is a pipeline join. A warehouse can model it the other way round — ONE
// row per funnel on the crash side, many events pointing at it. Then the crash source is the
// join TARGET and says so: `ad_funnel: { type: unique, ... }`, and a measure on events can be
// grouped by the crash source's ATTRIBUTES through the governed path.
//
// Two things pinned here. First that the path resolves at all: a governed
// `<relationship>__<attribute>` can only reach a dimension the manifest carries, so a fact used
// as a join target has to emit its own declared attributes — it used to emit only its time axis,
// and every ad_funnel__<attr> the catalog advertised was refused by MetricFlow as "no valid join
// path exists". Second that `unique` is a CLAIM ABOUT THE DATA, and the fixture makes it true: a
// report carries a funnel only when it is the first after it (SEED_DATA.md §12), so no (funnel,
// player) pair repeats on the owning side and the join adds no row.

// 50. The governed path reaches the owning fact's attributes: 176 events matched no report,
//     8 matched one — split by the app version the crash was reported from.
// 51. …and the total stays 184: each of the four rewarded funnels meets one report.
// Both attributes come through the SAME join (ad_funnel onto the crash row), so 50's app-version
// split and 51's device-model total are the marginals of ONE query grouped by both.
test('50. a fact that owns a key exposes its attributes to a governed group-by; 51. a `unique` key that is unique adds no row: 184 stays 184', opts, async (t) => {
  if (skip(t)) return;
  assert.equal(ownerCatalog.joinTargetFor('ad_funnel'), 'crashlytics', '[50] the crash source is the target');
  const r = await ownerEngine.query_model({
    context_id: ownerCtx, steps: [{ stage: 'metrics', metrics: ['evts'], group_by: [{ source: 'crashlytics', column: 'app_version', via: 'ad_funnel' }, { source: 'crashlytics', column: 'device_model', via: 'ad_funnel' }] }],
  });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.deepEqual(splitBy(r, 'app_version', 'evts'), { none: 176, '1.0.0': 2, '1.1.0': 6 }, '[50] events per crash app_version, via ad_funnel');

  const flat = await ownerEngine.query_model({ context_id: ownerCtx, steps: [{ stage: 'metrics', metrics: ['evts'] }] });
  assert.equal(flat.ok, true, JSON.stringify(flat.error));
  assert.equal(num(flat.rows[0].evts), 184, '[51] ungrouped, nothing is joined and the count is honest');

  assert.equal(sumCol(r.rows, 'evts'), 184, '[51] grouped through the join, the count is the same: no event meets two reports');
  // the key is unique on the owning side, as declared — which is why.
  const dup = await wh.query(`SELECT count(*) AS n FROM (
    SELECT rewarded_tracking_id, player_id_of_internal FROM main.fct_crashlytics_events
    WHERE rewarded_tracking_id IS NOT NULL GROUP BY 1, 2 HAVING count(*) > 1) d`);
  assert.equal(num(dup.rows[0].n), 0, '[51] no (funnel, player) pair repeats on the crash side');
});

// 52. The KEY SHAPE comes from the declaration and nothing else. The same warehouse, the same
//     question, the crash source owning the funnel by ONE column instead of two: both sides
//     render that one column, the keys still meet, and the answer is identical to scenario 50.
test('52. a one-column `unique` key answers exactly as the two-column one', opts, async (t) => {
  if (skip(t)) return;
  assert.equal(oneCatalog.joinTargetFor('ad_funnel'), 'crashlytics', 'one column is enough to own it');
  assert.deepEqual(oneCatalog.entityKey('crashlytics', 'ad_funnel'), [{ column: 'rewarded_tracking_id' }]);
  assert.deepEqual(oneCatalog.entityKey('events', 'ad_funnel'), [{ column: 'tracking_id' }]);

  // both attributes through the one join, in one query (as 50's): each split is a marginal of it
  const r = await oneEngine.query_model({
    context_id: oneCtx, steps: [{ stage: 'metrics', metrics: ['evts'], group_by: [{ source: 'crashlytics', column: 'app_version', via: 'ad_funnel' }, { source: 'crashlytics', column: 'device_model', via: 'ad_funnel' }] }],
  });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.deepEqual(splitBy(r, 'app_version', 'evts'), { none: 176, '1.0.0': 2, '1.1.0': 6 }, 'same numbers as the two-column key');
  assert.deepEqual(splitBy(r, 'device_model', 'evts'), { none: 176, iphone: 8 }, 'by device_model, the same as the two-column key');
});

// 53. NOTHING IS ADVERTISED THAT CANNOT BE ANSWERED. Whatever the catalog lists under the owned
//     relationship is queried here, driven off what the server advertises — the overview's
//     groupable_columns, each a ref { source, column, via } a query takes as it is — so a newly
//     declared attribute is covered without touching this test. Each one must come back with rows;
//     the owner's OWN attributes must also total exactly 184, since a truthful many-to-one join
//     cannot add a row. Every path goes through the ONE relationship, so they are asked in ONE
//     query (one mf call), each a column of it and each split a marginal of its rows; only when that
//     query is refused is each path asked on its own, so a refusal names the path it is about.
test('53. every attribute the catalog advertises for an owned relationship answers, and a truthful `unique` never duplicates: 184 stays 184', opts, async (t) => {
  if (skip(t)) return;
  // (one relationship leads to the owner, so it is advertised without via — naming it would add nothing)
  const refs = (await trueEngine.semantic_index()).groupable_columns.filter((r) => r.source === 'crashlytics');
  assert.ok(refs.every((r) => !r.via), `a single relationship needs no via: ${JSON.stringify(refs)}`);
  // the owner's attributes: its dimensions and, an events source, its event name — the one set the schema and the engine read
  const own = trueCatalog.modelDimensionColumns('crashlytics');
  assert.ok(own.length >= 2, `the owning fact must declare attributes to reach: ${own}`);
  assert.deepEqual(refs.map((r) => r.column).sort(), [...own].sort(), 'exactly the owner\'s attributes are advertised through the relationship');

  const refused = []; const totals = {}; const answered = {};
  const ask = async (group_by) => {
    try {
      const r = await trueEngine.query_model({ context_id: trueCtx, steps: [{ stage: 'metrics', metrics: ['evts'], group_by }] });
      if (!r.ok) return { why: JSON.stringify(r.error) };
      if (!r.rows.length) return { why: 'answered with no rows' };
      return { r };
    } catch (e) { return { why: `threw ${e.message}` }; }
  };
  const together = await ask(refs);
  if (together.r) for (const ref of refs) answered[ref.column] = together.r;
  else {
    for (const ref of refs) {
      const alone = await ask([ref]);
      if (alone.r) answered[ref.column] = alone.r; else refused.push(`${ref.source}.${ref.column}: ${alone.why}`);
    }
  }
  for (const [a, r] of Object.entries(answered)) totals[a] = Object.values(splitBy(r, a, 'evts')).reduce((s, n) => s + n, 0);
  assert.deepEqual(refused, [], 'the catalog must not offer an attribute the engine refuses');
  for (const a of own) assert.equal(totals[a], 184, `${a} must not inflate`);

  // '54. a truthful `unique` never duplicates: 184 stays 184' — THE ANSWER TO "how can a
  // many-to-one join fan out". It cannot. Here the owning column holds one row per value
  // (checked against the warehouse), and the very same
  // generated join keeps the count at exactly 184 — 24 events find their one crash report, 160
  // find none. The rows are the ones read above; every attribute's split totals 184 there.
  const dup = await wh.query(`SELECT count(*) AS n FROM (
    SELECT funnel_tracking_id FROM main.fct_crashlytics_events
    WHERE funnel_tracking_id IS NOT NULL GROUP BY 1 HAVING count(*) > 1) d`);
  assert.equal(num(dup.rows[0].n), 0, '[54] the claim is true on this warehouse: no repeated key');
  const split = (attribute) => {
    const r = answered[attribute];
    assert.ok(r, `[54] ${attribute} is advertised through ad_funnel and answered`);
    return splitBy(r, attribute, 'evts');
  };
  assert.deepEqual(split('app_version'), { none: 160, '1.0.0': 16, '1.1.0': 8 }, '[54] by app_version: 24 matched, none twice');
  assert.deepEqual(split('device_model'), { none: 160, iphone: 12, pixel: 8, galaxy: 4 }, '[54] by device_model');
});

// ═══════════ L. THE SAME DAY ═══════════
//
// A measures source is one row per player×DAY, so it is joined on the pair (player, day) — and the two
// sides store that day differently: the spend row at midnight, the event at the moment it happened. Its
// contract's time is `same_day`: both sides compared as days. 31 proves the generated join against a
// hand-written one (150 events meet a spend row, none twice); 8 the same join by channel.

// (A grain is part of the key, so it is checked like one at LOAD — an unknown unit, or a field that
// is not a key part: test/unit/declared-join-keys.test.js, 'a key part takes column + grain, and
// nothing else'.)
