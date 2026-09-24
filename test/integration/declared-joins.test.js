// JOINS: the key comes from the SCHEMA, the validity window from the CALL.
//
// A model declares its join keys once (meta.mcp.entities); a caller names the relationship
// (`via`) and never restates a column. When the target is SLOWLY-CHANGING the key alone is not
// enough — the row must also fall inside a validity window, and in a pipeline that window is
// stated explicitly in `between` (MetricFlow applies it by itself in the governed path).
//
// The fixture (see test/integration/fixtures/SEED_DATA.md §12-13):
//   user                 the player key. dim_users OWNS it and is SCD-2, so every join to
//                        installs is point-in-time. u1 moved US -> GB on 2026-01-03.
//   ad_funnel_{rewarded,interstitial,banner}
//                        the AD FUNNEL: events sharing one tracking_id are one funnel; a crash
//                        row records the last funnel id per ad format before the app died, so
//                        joining reconstructs the funnel that was running. NOBODY owns this key
//                        (one funnel spans several events), so it is a pipeline join only.
//
// Every assertion is a NUMBER (or a set of ids) from running against the warehouse — per the
// project rule the generated SQL is never matched as text. Each case is built so a wrong ON
// clause, a dropped window or the wrong column moves the number. Where a join can multiply
// rows there is an explicit no-duplicates invariant: count(*) == count(distinct <base key>).
//
// Sections:
//   A-D (1-20)  the join behaviour, every case built and run as a real pipeline / metric query;
//   E   (21-25) grounding: a declaration the built tables do not back;
//   F   (26-33) the GENERATED join code, proven by executing it and comparing its rows to a
//               reference query written by hand here — still no text matching;
//   G   (34)    the same join driven through a real MCP client: tools/list, tools/call, JSON in
//               and the answer read out of the MCP content block;
//   H   (35-40) all FOUR sources in one chain — three declared relationships at once, walked
//               from both ends, plus the governed path over two facts at the same time;
//   I   (41-43) the governed side of the same rules: a join path needs its owning model loaded,
//               a chained `via` resolves on the pipeline's own source, and three sources line up
//               on metric_time without joining each other;
//   J   (44-49) `attrs` is the contract: exactly the listed columns arrive — any column of the
//               joined model, amounts and event-scoped payload included — nothing implicit, and
//               a name that would be used twice REJECTS the step with the rename to apply;
//   K   (50-54) a FACT as the join target: owning a key with `type: unique` gives its attributes
//               a governed path, in whatever key shape was declared; nothing the catalog
//               advertises may be refused; and `unique` is a claim about the data that nothing
//               verifies — a false one inflates the count, a true one cannot.
//
// Auto-skips when dbt/mf are not installed (HAS_DBT gate).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import yaml from 'js-yaml';
import { loadCatalog, groundCatalogToPhysical } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { MfEngineBackend } from '../../src/backends/mf-engine.js';
import { Engine } from '../../src/engine.js';
import { makeMcpServer } from '../../src/server.js';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { startPglite } from './pglite-harness.js';
import { mcp, setMcp } from '../helpers/catalog-doc.js';
import { settle } from '../helpers/settle.js';

const execFileP = promisify(execFile);
const BASE = join(process.cwd(), 'test', 'integration', 'fixtures', 'dbt_project');
const DBT_BIN = process.env.DBT_BIN || join(process.cwd(), '.dbtvenv', 'bin', 'dbt');
const MF_BIN = process.env.MF_BIN || join(process.cwd(), '.dbtvenv', 'bin', 'mf');
const PY_BIN = process.env.PYTHON_BIN || join(process.cwd(), '.dbtvenv', 'bin', 'python');
const HAS_DBT = existsSync(DBT_BIN) && existsSync(MF_BIN);
const opts = { timeout: 300000 };

let pg; let engine; let backend; let acqCtx; let evCtx; let seq = 0;
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

/** The validity window of the install record, stated per the source's own time column. */
const AT = (value) => ({ value, from: 'install_time_valid_from', to: 'install_time_valid_until' });

before(async () => {
  if (!HAS_DBT) return;
  pg = await startPglite();
  process.env.DBT_PG_PORT = String(pg.port);
  const env = { ...process.env, DBT_PROFILES_DIR: BASE, DBT_PROJECT_DIR: BASE, DBT_PG_PORT: String(pg.port) };
  await execFileP(DBT_BIN, ['seed', '--full-refresh'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  await execFileP(DBT_BIN, ['run'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });

  const catalog = loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), { profilesDir: BASE, projectDir: BASE });
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: mkdtempSync(join(tmpdir(), 'mcpit-join-')), timeSpineDialect: 'postgres' });
  backend = new MfEngineBackend({ pythonBin: PY_BIN, dbtBin: DBT_BIN, profilesDir: BASE });
  engine = settle(new Engine({ catalog, contextManager: ctxs, runner: backend }));

  // Governed contexts: MetricFlow reaches the SCD install record by itself, point-in-time.
  const acq = await engine.create_semantic_model({
    name: 'jacq',
    use_base_models: ['users'],
    semantic_models: [{ from: 'acquisition', measures: [{ name: 'cost', agg: 'sum', field: 'cost' }] }],
    metrics: [{ name: 'cost', type: 'simple', measure: { name: 'cost' } }],
  });
  assert.equal(acq.parse.ok, true, JSON.stringify(acq.parse));
  acqCtx = acq.context_id;

  const ev = await engine.create_semantic_model({
    name: 'jev',
    use_base_models: ['users'],
    semantic_models: [{ from: 'events', measures: [{ name: 'evts', agg: 'count', field: '*' }] }],
    metrics: [{ name: 'evts', type: 'simple', measure: { name: 'evts' } }],
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
    { name: 'ghost_valid_from', data_type: 'timestamp', meta: { mcp: { dimension: { validity: 'start' } } } },
    { name: 'ghost_valid_until', data_type: 'timestamp', meta: { mcp: { dimension: { validity: 'end' } } } },
  );
  // (b) a relationship a model OWNS, on a column that is missing. It goes on the experiments
  // source, not on the one above: a validity window and an owned key cannot coexist, and the
  // catalog rejects that combination outright (see the unit guards).
  M.fct_experiment_assignments.columns.push({ name: 'ghost_pair_id', data_type: 'string' });
  mcp(M.fct_experiment_assignments).entities = { ghost_pair: { type: 'unique', key: ['ghost_pair_id', 'player_id_of_internal'] } };
  mcp(M.fct_analytics_events).entities.ghost_pair = { type: 'foreign', key: ['event_id', 'player_id_of_internal'] };
  // (c) HALF a window: the start column is real, the end column is missing
  M.dim_users.columns.find((c) => c.name === 'install_time_valid_until').name = 'ghost_valid_end';
  // (d) a variant of a working relationship, on a missing column
  M.fct_crashlytics_events.columns.push({ name: 'ghost_tracking_id', data_type: 'string' });
  mcp(M.fct_crashlytics_events).entities.ad_funnel.variants.ghost = { key: ['ghost_tracking_id', 'player_id_of_internal'] };

  const phantomPath = join(mkdtempSync(join(tmpdir(), 'phantom-')), 'catalog.yml');
  writeFileSync(phantomPath, yaml.dump(doc));
  phantom = loadCatalog(phantomPath, { profilesDir: BASE, projectDir: BASE });
  // every phantom declaration survives the LOAD — only the warehouse knows they are not there
  assert.equal(phantom.getModel('acquisition').scd, true, 'declared as slowly-changing before grounding');
  assert.ok(phantom.joinEntityNames().includes('ad_funnel_ghost'));
  assert.equal(phantom.joinTargetFor('ghost_pair'), 'experiments');

  ({ pruned: phantomPruned } = await groundCatalogToPhysical(phantom, backend, BASE));

  phantomEngine = settle(new Engine({ catalog: phantom, contextManager: ctxs, runner: backend }));
  const pc = await phantomEngine.create_semantic_model({
    name: 'jph',
    semantic_models: [{ from: 'acquisition', measures: [{ name: 'cost', agg: 'sum', field: 'cost' }] }],
    metrics: [{ name: 'cost', type: 'simple', measure: { name: 'cost' } }],
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
  const ownerPath = join(mkdtempSync(join(tmpdir(), 'owner-')), 'catalog.yml');
  writeFileSync(ownerPath, yaml.dump(od));
  ownerCatalog = loadCatalog(ownerPath, { profilesDir: BASE, projectDir: BASE });
  ownerEngine = settle(new Engine({ catalog: ownerCatalog, contextManager: ctxs, runner: backend }));
  const oc = await ownerEngine.create_semantic_model({
    name: 'jown',
    use_base_models: ['crashlytics'],
    semantic_models: [{ from: 'events', measures: [{ name: 'evts', agg: 'count', field: '*' }] }],
    metrics: [{ name: 'evts', type: 'simple', measure: { name: 'evts' } }],
  });
  assert.equal(oc.parse.ok, true, JSON.stringify(oc.parse));
  ownerCtx = oc.context_id;

  // Two MORE catalogs over the same warehouse, each making the crash source the owner of the
  // funnel with a DIFFERENT key, so that what gets generated can only come from what was
  // declared. `one` uses a ONE-column key on a column that repeats (the claim is false, as
  // above); `true` uses funnel_tracking_id, which really is one row per value.
  const owned = (crashKey, eventKey, declareColumn) => {
    const d = yaml.load(readFileSync(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), 'utf8'));
    const M = Object.fromEntries(d.models.map((x) => [x.name, x]));
    if (declareColumn) {
      M.fct_crashlytics_events.columns.push({
        name: declareColumn, data_type: 'string', meta: { mcp: { index: false } },
        description: 'The one ad funnel this crash report belongs to; unique per report.',
      });
    }
    mcp(M.fct_crashlytics_events).entities = { ad_funnel: { type: 'unique', key: crashKey } };
    mcp(M.fct_analytics_events).entities.ad_funnel = { type: 'foreign', key: eventKey };
    const at = join(mkdtempSync(join(tmpdir(), 'owned-')), 'catalog.yml');
    writeFileSync(at, yaml.dump(d));
    return loadCatalog(at, { profilesDir: BASE, projectDir: BASE });
  };
  // `users` is loaded too: the catalog advertises TWO-hop paths through the owned
  // relationship (ad_funnel__user__*), and a path can only be served when the model that owns
  // its last leg is in the context.
  const evtsOn = async (engine, name) => {
    const r = await engine.create_semantic_model({
      name, use_base_models: ['crashlytics', 'users'],
      semantic_models: [{ from: 'events', measures: [{ name: 'evts', agg: 'count', field: '*' }] }],
      metrics: [{ name: 'evts', type: 'simple', measure: { name: 'evts' } }],
    });
    assert.equal(r.parse.ok, true, JSON.stringify(r.parse));
    return r;
  };

  oneCatalog = owned(['rewarded_tracking_id'], ['tracking_id']);
  oneEngine = settle(new Engine({ catalog: oneCatalog, contextManager: ctxs, runner: backend }));
  oneCtx = (await evtsOn(oneEngine, 'jone')).context_id;

  trueCatalog = owned(['funnel_tracking_id'], ['tracking_id'], 'funnel_tracking_id');
  trueEngine = settle(new Engine({ catalog: trueCatalog, contextManager: ctxs, runner: backend }));
  trueCtx = (await evtsOn(trueEngine, 'jtrue')).context_id;
}, opts);

after(async () => { backend?.close(); if (pg) await pg.stop(); });
const skip = (t) => { if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; } return false; };

/** Run a pipeline of stages and return its materialized rows. */
async function pipeRows(source, ...stages) {
  const s = await engine.build_native_model({ action: 'start', name: `jn_${seq++}`, source });
  for (const stage of stages) {
    const r = await engine.build_native_model({ action: 'add_step', draft_id: s.draft_id, stage });
    assert.ok(!r.error, `add_step ${stage.stage}: ${JSON.stringify(r.error)}`);
  }
  const c = await engine.build_native_model({ action: 'materialize', draft_id: s.draft_id });
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
    measures: [{ name: 'n', fn: 'count' }, { name: 'distinct_base', fn: 'count_distinct', column: idColumn }],
  });
  return { n: num(rows[0].n), distinct: num(rows[0].distinct_base) };
}

/** The add_step response for a join — used to read its warnings. */
async function joinStep(source, joinStage) {
  const s = await engine.build_native_model({ action: 'start', name: `jw_${seq++}`, source });
  return engine.build_native_model({ action: 'add_step', draft_id: s.draft_id, stage: joinStage });
}

const q = (ctx, input) => engine.query_semantic_model({ context_id: ctx, ...input });

// ═══════════ A. acquisition → installs: the validity window ═══════════

// 1. Each spend row matches exactly ONE install version — the one valid on the spend day.
test('1. acquisition joins installs point-in-time: 13 rows, one version each', opts, async (t) => {
  if (skip(t)) return;
  const r = await joinStats('acquisition',
    { stage: 'join', with: 'users', via: 'user', between: AT('spend_date'), kind: 'inner', attrs: ['country'] },
    'acquisition_id');
  assert.equal(r.n, 13);
  assert.equal(r.distinct, 13, 'no spend row matched two versions');
});

// 2. Drop the window and u1's two spend rows match BOTH of its versions.
test('2. without the window the same join duplicates: 15 rows from 13 spend rows', opts, async (t) => {
  if (skip(t)) return;
  const r = await joinStats('acquisition',
    { stage: 'join', with: 'users', via: 'user', kind: 'inner', attrs: ['country'] },
    'acquisition_id');
  assert.equal(r.n, 15, 'u1 has 2 spend rows x 2 install versions');
  assert.equal(r.distinct, 13, 'still only 13 real spend rows — the extra 2 are duplicates');
  const warned = await joinStep('acquisition', { stage: 'join', with: 'users', via: 'user', attrs: ['country'] });
  assert.match(JSON.stringify(warned.recommendations || []), /INCOMPLETE JOIN/);
  assert.match(JSON.stringify(warned.recommendations || []), /install_time_valid_from/, 'the nudge names the real window columns');
});

// 3. Money is the thing duplicates corrupt: with the window the total is untouched.
test('3. the windowed join leaves the total spend at 17.50', opts, async (t) => {
  if (skip(t)) return;
  const rows = await pipeRows('acquisition',
    { stage: 'join', with: 'users', via: 'user', between: AT('spend_date'), kind: 'inner', attrs: ['country'] },
    { stage: 'aggregate', measures: [{ name: 'total', fn: 'sum', column: 'cost' }] });
  assert.ok(near(num(rows[0].total), 17.5), `total=${rows[0].total}`);
});

// 4. …and the attribution follows the window: u1's 0.50 on 01-03 is GB, its 1.50 on 01-01 is US.
test('4. spend by country is attributed to the version valid on the spend day', opts, async (t) => {
  if (skip(t)) return;
  const rows = await pipeRows('acquisition',
    { stage: 'join', with: 'users', via: 'user', between: AT('spend_date'), kind: 'inner', attrs: ['country'] },
    { stage: 'aggregate', group_by: ['country'], measures: [{ name: 'total', fn: 'sum', column: 'cost' }] });
  const by = mapCol(rows, 'country', 'total');
  assert.ok(near(by.US, 6.75), `US=${by.US}`);
  assert.ok(near(by.GB, 5.0), `GB=${by.GB}`);
  assert.ok(near(by.DE, 4.0), `DE=${by.DE}`);
  assert.ok(near(by.BR, 1.75), `BR=${by.BR}`);
});

// 5. The governed path does the same point-in-time join on its own — same numbers, no `between`.
test('5. governed = pipeline: the metric by users.country matches scenario 4', opts, async (t) => {
  if (skip(t)) return;
  const r = await q(acqCtx, { metrics: ['jacq_cost'], group_by: [{ model: 'users', attribute: 'country' }] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const by = mapCol(r.rows, groupCol(r, 'jacq_cost'), 'jacq_cost');
  assert.ok(near(by.US, 6.75), `US=${by.US}`);
  assert.ok(near(by.GB, 5.0), `GB=${by.GB}`);
  assert.ok(near(by.DE, 4.0), `DE=${by.DE}`);
  assert.ok(near(by.BR, 1.75), `BR=${by.BR}`);
  assert.ok(near(sumCol(r.rows, 'jacq_cost'), 17.5), 'no fan-out in the governed path either');
});

// ═══════════ B. acquisition ↔ events: the plain player key ═══════════

// 6. No window here: events is not slowly-changing, so the player key is the whole join.
test('6. acquisition joins an events source on the player key: 220 pairs', opts, async (t) => {
  if (skip(t)) return;
  const r = await joinStats('events',
    { stage: 'join', with: 'acquisition', via: 'user', kind: 'inner', attrs: ['media_source'] },
    'event_id');
  assert.equal(r.n, 220, 'u1 has two spend rows, so its 36 events pair twice');
  // 7. …and no event was dropped: every one of the 184 is represented.
  assert.equal(r.distinct, 184);
});

// 8. The relationship is symmetric — declared once, usable from either side.
test('8. the same relationship from the acquisition side gives the same 220 pairs', opts, async (t) => {
  if (skip(t)) return;
  const r = await joinStats('acquisition',
    { stage: 'join', with: 'events', via: 'user', kind: 'inner', attrs: ['event_id'] },
    'acquisition_id');
  assert.equal(r.n, 220);
  assert.equal(r.distinct, 13, 'all 13 spend rows participated');
});

// 9. That pairing is many-to-many BY DESIGN, so money summed over it is meaningless — pin the
//    inflated number down so nobody mistakes this join for a spend metric.
test('9. summing cost over the event pairing inflates it to 267.75, not 17.50', opts, async (t) => {
  if (skip(t)) return;
  const rows = await pipeRows('events',
    { stage: 'join', with: 'acquisition', via: 'user', kind: 'inner', attrs: ['cost'] },
    { stage: 'aggregate', measures: [{ name: 'total', fn: 'sum', column: 'cost' }] });
  assert.ok(near(num(rows[0].total), 267.75), `total=${rows[0].total}`);
});

// 10. The SCD join also works in a FILTER, not just a group-by: GB spend is 5.00.
test('10. filtering a metric by a point-in-time attribute: GB spend = 5.00', opts, async (t) => {
  if (skip(t)) return;
  const r = await q(acqCtx, { metrics: ['jacq_cost'], where: { op: 'and', conditions: [{ field: { kind: 'dimension', model: 'users', attribute: 'country' }, op: 'eq', value: 'GB' }] } });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.ok(near(num(r.rows[0].jacq_cost), 5.0), `GB=${r.rows[0].jacq_cost}`);
});

// ═══════════ C. installs is SCD for every source, not just acquisition ═══════════

// 11. Events, with the window: one install version per event.
test('11. events join installs point-in-time: 184 rows, no duplicates', opts, async (t) => {
  if (skip(t)) return;
  const r = await joinStats('events',
    { stage: 'join', with: 'users', via: 'user', between: AT('device_time'), kind: 'inner', attrs: ['country'] },
    'event_id');
  assert.equal(r.n, 184);
  assert.equal(r.distinct, 184);
});

// 12. …and without it, u1's 36 events double.
test('12. events without the window: 220 rows from 184 events, with the nudge', opts, async (t) => {
  if (skip(t)) return;
  const r = await joinStats('events',
    { stage: 'join', with: 'users', via: 'user', kind: 'inner', attrs: ['country'] },
    'event_id');
  assert.equal(r.n, 220);
  assert.equal(r.distinct, 184);
  const warned = await joinStep('events', { stage: 'join', with: 'users', via: 'user', attrs: ['country'] });
  assert.match(JSON.stringify(warned.recommendations || []), /INCOMPLETE JOIN/);
});

// 13. Attribution moves with the window: 30 of u1's events are US, 6 are GB.
test('13. events by country are attributed point-in-time: US 67 / GB 57 / DE 31 / BR 29', opts, async (t) => {
  if (skip(t)) return;
  const rows = await pipeRows('events',
    { stage: 'join', with: 'users', via: 'user', between: AT('device_time'), kind: 'inner', attrs: ['country'] },
    { stage: 'aggregate', group_by: ['country'], measures: [{ name: 'n', fn: 'count' }] });
  const by = mapCol(rows, 'country', 'n');
  assert.equal(by.US, 67);
  assert.equal(by.GB, 57);
  assert.equal(by.DE, 31);
  assert.equal(by.BR, 29);
  assert.equal(sumCol(rows, 'n'), 184);
});

// 14. The governed path agrees, without anyone writing a window.
test('14. governed = pipeline for events too', opts, async (t) => {
  if (skip(t)) return;
  const r = await q(evCtx, { metrics: ['jev_evts'], group_by: [{ model: 'users', attribute: 'country' }] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const by = mapCol(r.rows, groupCol(r, 'jev_evts'), 'jev_evts');
  assert.equal(by.US, 67);
  assert.equal(by.GB, 57);
  assert.equal(by.DE, 31);
  assert.equal(by.BR, 29);
  assert.equal(sumCol(r.rows, 'jev_evts'), 184);
});

// 15. The crash source reaches installs the same way — nothing is specific to one source.
test('15. crash reports join installs point-in-time: 13 rows, no duplicates', opts, async (t) => {
  if (skip(t)) return;
  const r = await joinStats('crashlytics',
    { stage: 'join', with: 'users', via: 'user', between: AT('event_time'), kind: 'inner', attrs: ['country'] },
    'crash_id');
  assert.equal(r.n, 13);
  assert.equal(r.distinct, 13);
});

// ═══════════ D. the ad funnel: which ad was running when the app died ═══════════

// 16. A crash points at the last rewarded funnel before it; the join returns that funnel's
//     events. 7 crashes carry a rewarded funnel, each funnel is 2 events → 14 rows.
test('16. a crash finds the events of its rewarded funnel: 14 rows from 7 crashes', opts, async (t) => {
  if (skip(t)) return;
  const r = await joinStats('crashlytics',
    { stage: 'join', with: 'events', via: 'ad_funnel_rewarded', kind: 'inner', attrs: ['event_id'] },
    'crash_id');
  assert.equal(r.n, 14);
  assert.equal(r.distinct, 7, 'k1..k3 and k10 (u1), k6, k9, k13');
});

// 17. Each ad format is its own key: three variants, three different answers. If the caller's
//     choice were ignored and one column always used, these would not differ.
test('17. the three ad formats give three different results: 14 / 12 / 8', opts, async (t) => {
  if (skip(t)) return;
  const n = async (variant) => (await joinStats('crashlytics',
    { stage: 'join', with: 'events', via: `ad_funnel_${variant}`, kind: 'inner', attrs: ['event_id'] }, 'crash_id')).n;
  assert.equal(await n('rewarded'), 14);
  assert.equal(await n('interstitial'), 12);
  assert.equal(await n('banner'), 8);
});

// 18. The key is (funnel, PLAYER), not the funnel alone. u2 and u10 share the funnel id
//     'fnl_dup', so a player-blind join would pull u10's ad events into u2's crash. It does not.
test('18. the player is part of the key: a shared funnel id does not leak across players', opts, async (t) => {
  if (skip(t)) return;
  const rows = await pipeRows('crashlytics',
    { stage: 'where', conditions: [{ column: 'crash_id', op: 'eq', value: 'k4' }] },
    { stage: 'join', with: 'events', via: 'ad_funnel_banner', kind: 'inner', attrs: ['event_id'] },
    { stage: 'project', columns: ['event_id'] });
  assert.deepEqual(new Set(rows.map((r) => String(r.event_id))), new Set(['e133', 'e134']),
    "only u2's own banner events — e149/e150 are u10's, same funnel id");
});

// 19. A crash with no ad of that format has an empty column, and NULL matches nothing.
test('19. an empty format column matches nothing; a left join still keeps the crash', opts, async (t) => {
  if (skip(t)) return;
  const inner = await joinStats('crashlytics',
    { stage: 'join', with: 'events', via: 'ad_funnel_banner', kind: 'inner', attrs: ['event_id'] }, 'crash_id');
  assert.equal(inner.distinct, 4, 'only k4, k5, k11, k12 recorded a banner funnel');
  const left = await joinStats('crashlytics',
    { stage: 'join', with: 'events', via: 'ad_funnel_banner', attrs: ['event_id'] }, 'crash_id');
  assert.equal(left.distinct, 13, 'a left join keeps every crash report');
  assert.equal(left.n, 17, '4 matched crashes x 2 funnel events + 9 unmatched crashes');
});

// 20. The join returns THAT funnel, not everything the player did. u1 crashed having seen both
//     a rewarded and an interstitial funnel; each variant returns its own two events.
test('20. the funnel is isolated: u1 gets its rewarded pair or its interstitial pair, not both', opts, async (t) => {
  if (skip(t)) return;
  const ids = async (variant) => {
    const rows = await pipeRows('crashlytics',
      { stage: 'where', conditions: [{ column: 'crash_id', op: 'eq', value: 'k1' }] },
      { stage: 'join', with: 'events', via: `ad_funnel_${variant}`, kind: 'inner', attrs: ['event_id'] },
      { stage: 'project', columns: ['event_id'] });
    return new Set(rows.map((r) => String(r.event_id)));
  };
  assert.deepEqual(await ids('rewarded'), new Set(['e129', 'e130']));
  assert.deepEqual(await ids('interstitial'), new Set(['e131', 'e132']));
  assert.deepEqual(await ids('banner'), new Set(), 'u1 saw no banner before the crash');
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
  const r = await phantomEngine.query_semantic_model({ context_id: phantomCostCtx, metrics: ['jph_cost'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.ok(near(num(r.rows[0].jph_cost), 17.5), `cost=${r.rows[0].jph_cost}`);
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
  // …and the degradation is not just a flag on an object: the manifest PARSES (dbt rejects a
  // `natural` entity that has no window) and the join now behaves as a plain dimension —
  // u1's 36 events reach BOTH of its install rows, so the grouped total is 220, not 184.
  const sm = await phantomEngine.create_semantic_model({
    name: 'jphev',
    use_base_models: ['users'],
    semantic_models: [{ from: 'events', measures: [{ name: 'evts', agg: 'count', field: '*' }] }],
    metrics: [{ name: 'evts', type: 'simple', measure: { name: 'evts' } }],
  });
  assert.equal(sm.parse.ok, true, JSON.stringify(sm.parse));
  const res = await phantomEngine.query_semantic_model({ context_id: sm.context_id, metrics: ['jphev_evts'], group_by: [{ model: 'users', attribute: 'country' }] });
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.equal(sumCol(res.rows, 'jphev_evts'), 220, 'with no window left every event meets both of u1\'s versions');
});

// 23. A relationship whose key column is missing stops being offered — and cannot be called.
test('23. a phantom relationship is pruned and rejected at the call', opts, async (t) => {
  if (skip(t)) return;
  assert.ok(!phantom.joinEntityNames().includes('ad_funnel_ghost'), 'not offered any more');
  assert.equal(phantom.entityKey('crashlytics', 'ad_funnel_ghost'), undefined);
  assert.match(String(phantomPruned.crashlytics || ''), /entity:ad_funnel_ghost/);
  const s = await phantomEngine.build_native_model({ action: 'start', name: `ph_${seq++}`, source: 'crashlytics' });
  // Refused before any SQL exists: the pruned name is not even in the tool's `via` enum, so the
  // rejection lists the relationships that DID survive and never mentions the ghost.
  await assert.rejects(
    () => phantomEngine.build_native_model({ action: 'add_step', draft_id: s.draft_id, stage: { stage: 'join', with: 'events', via: 'ad_funnel_ghost' } }),
    (e) => /must be one of|declares no such relationship/.test(e.message) && !/ad_funnel_ghost/.test(e.message),
    'a key the warehouse cannot back is refused here, not as a SQL error',
  );
});

// 24. Pruning is surgical: the sibling variants, built on real columns, still join and still
//     return the same numbers as in the honest catalog.
test('24. the real variants are untouched by the pruning: 14 / 12 / 8', opts, async (t) => {
  if (skip(t)) return;
  for (const v of ['rewarded', 'interstitial', 'banner']) {
    assert.deepEqual(phantom.entityKey('crashlytics', `ad_funnel_${v}`), [{ column: `${v}_tracking_id` }, { column: 'player_id_of_internal' }]);
  }
  const n = async (variant) => {
    const st = await phantomEngine.build_native_model({ action: 'start', name: `ph_${seq++}`, source: 'crashlytics' });
    for (const stage of [
      { stage: 'join', with: 'events', via: `ad_funnel_${variant}`, kind: 'inner', attrs: ['event_id'] },
      { stage: 'aggregate', measures: [{ name: 'n', fn: 'count' }] },
    ]) {
      const r = await phantomEngine.build_native_model({ action: 'add_step', draft_id: st.draft_id, stage });
      assert.ok(!r.error, JSON.stringify(r.error));
    }
    const c = await phantomEngine.build_native_model({ action: 'materialize', draft_id: st.draft_id });
    assert.equal(c.build?.ok, true, JSON.stringify(c.error || c.build));
    return num(c.rows[0].n);
  };
  assert.equal(await n('rewarded'), 14);
  assert.equal(await n('interstitial'), 12);
  assert.equal(await n('banner'), 8);
});

// 25. When the pruned key was the OWNER of a relationship, the ownership index must be rebuilt —
//     otherwise a target keeps being advertised by a model that no longer declares the key.
test('25. pruning an owning key clears the join target', opts, async (t) => {
  if (skip(t)) return;
  assert.equal(phantom.entityKey('experiments', 'ghost_pair'), undefined, 'the owner lost the key');
  assert.equal(phantom.joinTargetFor('ghost_pair'), undefined, 'so nothing points at it as a target');
  assert.ok(!phantom.reachableGroupByPaths().some((p) => p.startsWith('ghost_pair__')), 'and it offers no group-by path');
  // the events side still declares it, but with no owner it is not offered as a join
  assert.ok(!phantom.joinEntityNames().includes('ghost_pair'));
  // the owner's other, real relationship is untouched — and still joins, on the warehouse:
  // one assignment per player, so every one of the 184 events pairs exactly once.
  assert.deepEqual(phantom.entityKey('experiments', 'user'), [{ column: 'player_id_of_internal' }]);
  assert.equal(phantom.joinTargetFor('user'), 'users');
  const st = await phantomEngine.build_native_model({ action: 'start', name: `ph_${seq++}`, source: 'events' });
  for (const stage of [
    { stage: 'join', with: 'experiments', via: 'user', kind: 'inner', attrs: ['variant_group'] },
    { stage: 'aggregate', measures: [{ name: 'n', fn: 'count' }, { name: 'distinct_base', fn: 'count_distinct', column: 'event_id' }] },
  ]) {
    const r = await phantomEngine.build_native_model({ action: 'add_step', draft_id: st.draft_id, stage });
    assert.ok(!r.error, JSON.stringify(r.error));
  }
  const c = await phantomEngine.build_native_model({ action: 'materialize', draft_id: st.draft_id });
  assert.equal(c.build?.ok, true, JSON.stringify(c.error || c.build));
  assert.equal(num(c.rows[0].n), 184);
  assert.equal(num(c.rows[0].distinct_base), 184, 'and it did not fan out');
});

// ═══════════ discovery + guards (input validation) ═══════════

test('relationships are discoverable, with their key columns and what they point at', opts, async (t) => {
  if (skip(t)) return;
  const crash = Object.fromEntries((await engine.semantic_index({ model: 'crashlytics' })).relationships.map((r) => [r.entity, r]));
  assert.deepEqual(crash.ad_funnel_rewarded.key, ['rewarded_tracking_id', 'player_id_of_internal']);
  assert.deepEqual(crash.ad_funnel_banner.key, ['banner_tracking_id', 'player_id_of_internal']);
  assert.equal(crash.ad_funnel_rewarded.joins, undefined, 'nobody owns the funnel key — pipeline only');
  assert.equal(crash.user.joins, 'users');
  const ev = Object.fromEntries((await engine.semantic_index({ model: 'events' })).relationships.map((r) => [r.entity, r]));
  assert.deepEqual(ev.ad_funnel_rewarded.key, ['tracking_id', 'player_id_of_internal'],
    'the single-column side answers every variant');
});

// A relationship nobody owns has NO governed path — MetricFlow can only join onto a unique
// key. Asking for one must be refused rather than silently answered from some other join.
test('an unowned relationship offers no governed group-by path', opts, async (t) => {
  if (skip(t)) return;
  const r = await q(evCtx, { metrics: ['jev_evts'], group_by: [{ model: 'users', attribute: 'country', via: 'ad_funnel_rewarded' }] }).catch((e) => ({ ok: false, error: String(e.message || e) }));
  assert.equal(r.ok, false, 'the funnel key must not be groupable in a metric query');
  // …while the owned player key is, and answers with real numbers.
  const good = await q(evCtx, { metrics: ['jev_evts'], group_by: [{ model: 'users', attribute: 'country' }] });
  assert.equal(good.ok, true, JSON.stringify(good.error));
  assert.equal(sumCol(good.rows, 'jev_evts'), 184);
});

test('join guards: an undeclared relationship, a self-join and via+on are all rejected', opts, async (t) => {
  if (skip(t)) return;
  await assert.rejects(() => joinStep('events', { stage: 'join', with: 'experiments', via: 'ad_funnel_rewarded' }),
    /declares no such relationship.*share: user/s);
  await assert.rejects(() => joinStep('events', { stage: 'join', with: 'events', via: 'user' }), /own source/);
  await assert.rejects(() => joinStep('events', { stage: 'join', with: 'users', via: 'user', on: ['player_id_of_internal'] }), /not both/);
});

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

/** Execute SQL on the very warehouse the tools ran against (same PGlite instance). */
async function runSql(sql) {
  const { rows } = await pg.db.query(sql.replace(REF, (_, m) => `public.${m}`).trim().replace(/;\s*$/, ''));
  return rows;
}

/** Project a query to `cols` in a fixed order, so two queries are comparable row by row. */
function ordered(sql, cols) {
  const by = cols.map((_, i) => `${i + 1} NULLS LAST`).join(', ');
  return runSql(`SELECT ${cols.join(', ')} FROM (${sql.trim().replace(/;\s*$/, '')}) x ORDER BY ${by}`);
}

/** The SQL the tool generates for these stages — read from `preview`, nothing built. */
async function generatedSql(source, ...stages) {
  const s = await engine.build_native_model({ action: 'start', name: `gen_${seq++}`, source });
  for (const stage of stages) {
    const r = await engine.build_native_model({ action: 'add_step', draft_id: s.draft_id, stage });
    assert.ok(!r.error, `add_step ${stage.stage}: ${JSON.stringify(r.error)}`);
  }
  const p = await engine.build_native_model({ action: 'preview', draft_id: s.draft_id });
  assert.ok(p.model_sql, 'preview returns the generated model SQL');
  return p.model_sql;
}

const ACQ_TO_USERS_PIT = `
  SELECT a.acquisition_id, u.country
    FROM {{ ref('fct_player_acquisition') }} a
    JOIN {{ ref('dim_users') }} u
      ON a.player_id_of_internal = u.player_id_of_internal
     AND a.spend_date BETWEEN u.install_time_valid_from AND u.install_time_valid_until`;

// 26. The declared key + the stated window must generate exactly the join a human would write.
test('26. the generated point-in-time join returns what a hand-written one returns', opts, async (t) => {
  if (skip(t)) return;
  const gen = await generatedSql('acquisition',
    { stage: 'join', with: 'users', via: 'user', between: AT('spend_date'), kind: 'inner', attrs: ['country'] });
  const want = await ordered(ACQ_TO_USERS_PIT, ['acquisition_id', 'country']);
  assert.equal(want.length, 13, 'the reference join is itself the 13-row point-in-time answer');
  assert.deepEqual(await ordered(gen, ['acquisition_id', 'country']), want);
});

// 27. Take the window away and the generated code must lose the BETWEEN — and nothing else.
test('27. without `between` the generated code is the same join minus the window', opts, async (t) => {
  if (skip(t)) return;
  const gen = await generatedSql('acquisition',
    { stage: 'join', with: 'users', via: 'user', kind: 'inner', attrs: ['country'] });
  const got = await ordered(gen, ['acquisition_id', 'country']);
  const want = await ordered(`
    SELECT a.acquisition_id, u.country
      FROM {{ ref('fct_player_acquisition') }} a
      JOIN {{ ref('dim_users') }} u
        ON a.player_id_of_internal = u.player_id_of_internal`, ['acquisition_id', 'country']);
  assert.equal(want.length, 15, 'the key alone matches both of u1\'s install versions');
  assert.deepEqual(got, want);
  assert.notDeepEqual(got, await ordered(ACQ_TO_USERS_PIT, ['acquisition_id', 'country']),
    'and it is NOT the windowed join — `between` is what puts the window in the code');
});

// 28. Each variant must generate a join on ITS OWN tracking column. Three references, three
//     answers: if the generator ignored the caller's variant they could not all match.
test('28. each ad-format variant generates the join on its own tracking column', opts, async (t) => {
  if (skip(t)) return;
  const refFor = (col) => `
    SELECT c.crash_id, e.event_id
      FROM {{ ref('fct_crashlytics_events') }} c
      JOIN {{ ref('fct_analytics_events') }} e
        ON c.${col} = e.tracking_id
       AND c.player_id_of_internal = e.player_id_of_internal`;
  for (const [variant, col, n] of [['rewarded', 'rewarded_tracking_id', 14], ['interstitial', 'interstitial_tracking_id', 12], ['banner', 'banner_tracking_id', 8]]) {
    const gen = await generatedSql('crashlytics',
      { stage: 'join', with: 'events', via: `ad_funnel_${variant}`, kind: 'inner', attrs: ['event_id'] });
    const want = await ordered(refFor(col), ['crash_id', 'event_id']);
    assert.equal(want.length, n, `${variant}: the reference itself`);
    assert.deepEqual(await ordered(gen, ['crash_id', 'event_id']), want, variant);
  }
});

// 29. BOTH parts of the composite key must reach the generated code. Drop the player half by
//     hand and the shared funnel id 'fnl_dup' leaks u10's events into u2's crashes — 12 rows
//     instead of 8. The generated code must be the 8.
test('29. the composite key generates BOTH equalities, not just the funnel id', opts, async (t) => {
  if (skip(t)) return;
  const gen = await generatedSql('crashlytics',
    { stage: 'join', with: 'events', via: 'ad_funnel_banner', kind: 'inner', attrs: ['event_id'] });
  const got = await ordered(gen, ['crash_id', 'event_id']);
  const funnelOnly = await ordered(`
    SELECT c.crash_id, e.event_id
      FROM {{ ref('fct_crashlytics_events') }} c
      JOIN {{ ref('fct_analytics_events') }} e ON c.banner_tracking_id = e.tracking_id`, ['crash_id', 'event_id']);
  assert.equal(funnelOnly.length, 12, 'the funnel id ALONE pulls u10 into k4/k5');
  assert.equal(got.length, 8);
  assert.notDeepEqual(got, funnelOnly);
});

// 30. `kind` must generate the join type it names: the same stage left-joined keeps every
//     crash, with a NULL where nothing matched.
test('30. kind:left generates a LEFT JOIN — 17 rows, 9 of them unmatched', opts, async (t) => {
  if (skip(t)) return;
  const gen = await generatedSql('crashlytics',
    { stage: 'join', with: 'events', via: 'ad_funnel_banner', attrs: ['event_id'] });
  const got = await ordered(gen, ['crash_id', 'event_id']);
  const want = await ordered(`
    SELECT c.crash_id, e.event_id
      FROM {{ ref('fct_crashlytics_events') }} c
      LEFT JOIN {{ ref('fct_analytics_events') }} e
        ON c.banner_tracking_id = e.tracking_id
       AND c.player_id_of_internal = e.player_id_of_internal`, ['crash_id', 'event_id']);
  assert.equal(want.length, 17);
  assert.equal(want.filter((r) => r.event_id == null).length, 9, 'the crashes with no banner funnel');
  assert.deepEqual(got, want);
});

// 31. A single-column declared key must generate a single equality — no invented second part.
test('31. a one-column relationship generates one equality: the 220 event x spend pairs', opts, async (t) => {
  if (skip(t)) return;
  const gen = await generatedSql('events',
    { stage: 'join', with: 'acquisition', via: 'user', kind: 'inner', attrs: ['acquisition_id'] });
  const want = await ordered(`
    SELECT e.event_id, a.acquisition_id
      FROM {{ ref('fct_analytics_events') }} e
      JOIN {{ ref('fct_player_acquisition') }} a
        ON e.player_id_of_internal = a.player_id_of_internal`, ['event_id', 'acquisition_id']);
  assert.equal(want.length, 220);
  assert.deepEqual(await ordered(gen, ['event_id', 'acquisition_id']), want);
});

// 32. The code shown in `preview` must be the code `materialize` actually builds — otherwise
//     everything proven above is proven about SQL nobody runs.
test('32. what preview shows is what materialize builds', opts, async (t) => {
  if (skip(t)) return;
  const stages = [
    { stage: 'join', with: 'users', via: 'user', between: AT('spend_date'), kind: 'inner', attrs: ['country'] },
    { stage: 'aggregate', group_by: ['country'], measures: [{ name: 'total', fn: 'sum', column: 'cost' }] },
  ];
  const direct = mapCol(await runSql(await generatedSql('acquisition', ...stages)), 'country', 'total');
  const built = mapCol(await pipeRows('acquisition', ...stages), 'country', 'total');
  assert.deepEqual(Object.keys(built).sort(), Object.keys(direct).sort());
  for (const k of Object.keys(direct)) assert.ok(near(built[k], direct[k]), `${k}: built=${built[k]} previewed=${direct[k]}`);
  assert.ok(near(direct.US, 6.75) && near(direct.GB, 5.0) && near(direct.DE, 4.0) && near(direct.BR, 1.75));
});

// 33. The GOVERNED path generates its own join, from the entity the semantic model declares.
//     Run that SQL too: the semantic layer's point-in-time join must land on the same numbers
//     as the hand-written one, or the generated YAML describes the wrong key.
test('33. the semantic layer generates the point-in-time join correctly', opts, async (t) => {
  if (skip(t)) return;
  const r = await q(acqCtx, { metrics: ['jacq_cost'], group_by: [{ model: 'users', attribute: 'country' }], dry_run: true });
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
// Everything above calls the engine directly. This one goes the whole way an assistant does:
// an MCP client over a transport, tools/list, tools/call with JSON arguments, and the answer
// read back out of the MCP content block. Same warehouse, same numbers — so the join is
// reachable through the actual protocol surface, not only through the JS method.

test('34. the join runs end-to-end over MCP and returns the same 6.75 / 5.00 / 4.00 / 1.75', opts, async (t) => {
  if (skip(t)) return;
  const server = makeMcpServer(engine);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'declared-joins-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const tools = (await client.listTools()).tools.map((x) => x.name);
    assert.ok(tools.includes('build_native_model'), 'the pipeline tool is advertised');
    const call = async (name, args) => {
      const res = await client.callTool({ name, arguments: args });
      assert.ok(!res.isError, `${name}: ${res.content?.[0]?.text}`);
      return JSON.parse(res.content[0].text);
    };

    const s = await call('build_native_model', { action: 'start', name: `mcp_${seq++}`, source: 'acquisition' });
    await call('build_native_model', {
      action: 'add_step',
      draft_id: s.draft_id,
      stage: { stage: 'join', with: 'users', via: 'user', between: AT('spend_date'), kind: 'inner', attrs: ['country'] },
    });
    await call('build_native_model', {
      action: 'add_step',
      draft_id: s.draft_id,
      stage: { stage: 'aggregate', group_by: ['country'], measures: [{ name: 'total', fn: 'sum', column: 'cost' }] },
    });
    const built = await call('build_native_model', { action: 'materialize', draft_id: s.draft_id });
    assert.equal(built.build?.ok, true, JSON.stringify(built.error || built.build));
    const by = mapCol(built.rows, 'country', 'total');
    assert.ok(near(by.US, 6.75), `US=${by.US}`);
    assert.ok(near(by.GB, 5.0), `GB=${by.GB}`);
    assert.ok(near(by.DE, 4.0), `DE=${by.DE}`);
    assert.ok(near(by.BR, 1.75), `BR=${by.BR}`);

    // A relationship the two models do not share comes back as an MCP tool ERROR, not an answer.
    const s2 = await call('build_native_model', { action: 'start', name: `mcp_${seq++}`, source: 'events' });
    const bad = await client.callTool({
      name: 'build_native_model',
      arguments: { action: 'add_step', draft_id: s2.draft_id, stage: { stage: 'join', with: 'experiments', via: 'ad_funnel_rewarded' } },
    });
    assert.equal(bad.isError, true);
    assert.match(JSON.parse(bad.content[0].text).error.message, /declares no such relationship/);
  } finally {
    await client.close();
    await server.close();
  }
});

// ═══════════ H. ALL FOUR SOURCES IN ONE CHAIN ═══════════
//
// The cases above join two models at a time. Real questions do not: "which ad funnel was
// running when the app died, for a player from which country, bought through which channel"
// touches the crash source, the events source, the install record and the spend table in one
// pipeline. Every join stage here goes through a relationship DECLARED IN THE SCHEMA — three
// different ones, two of them composite, one of them point-in-time — and the pipeline is
// materialized and read back like any other.
//
// The chain is built from BOTH ends: from the crash side and from the event side, in a
// different order. The set of (crash, event, spend) triples must come out identical — same
// relation, whichever way you walk it. What must NOT come out identical is the country: each
// chain attributes the player to the install version valid at ITS OWN instant, and a crash on
// 05 Jan is not the same moment as the ad event that preceded it.

/** Materialize a pipeline once per key and memoize — the chains are reused across cases. */
const chainCache = new Map();
async function chain(key, source, stages) {
  if (!chainCache.has(key)) chainCache.set(key, await pipeRows(source, ...stages));
  return chainCache.get(key);
}

// crash → the funnel's events → the install version valid AT THE CRASH → that player's spend.
const CHAIN_FROM_CRASH = [
  { stage: 'join', with: 'events', via: 'ad_funnel_rewarded', kind: 'inner', attrs: ['event_id'] },
  { stage: 'join', with: 'users', via: 'user', between: AT('event_time'), kind: 'inner', attrs: ['country'] },
  { stage: 'join', with: 'acquisition', via: 'user', kind: 'inner', attrs: ['acquisition_id', 'cost'] },
  { stage: 'project', columns: ['crash_id', 'event_id', 'acquisition_id', 'country', 'cost'] },
];

// the same four models from the other end: event → its install version AT THE EVENT → that
// player's spend → the crash reports whose rewarded funnel is this event's funnel.
const CHAIN_FROM_EVENT = [
  { stage: 'join', with: 'users', via: 'user', between: AT('device_time'), kind: 'inner', attrs: ['country'] },
  { stage: 'join', with: 'acquisition', via: 'user', kind: 'inner', attrs: ['acquisition_id', 'cost'] },
  { stage: 'join', with: 'crashlytics', via: 'ad_funnel_rewarded', kind: 'inner', attrs: ['crash_id'] },
  { stage: 'project', columns: ['crash_id', 'event_id', 'acquisition_id', 'country', 'cost'] },
];

const triples = (rows) => new Set(rows.map((r) => `${r.crash_id}|${r.event_id}|${r.acquisition_id}`));
const countBy = (rows, col) => rows.reduce((m, r) => ({ ...m, [String(r[col])]: (m[String(r[col])] || 0) + 1 }), {});

// 35. Three declared relationships in one pipeline — a variant key, a point-in-time key and a
//     plain key — over four sources. 7 crashes carry a rewarded funnel, each funnel is 2 events
//     (14 rows), and u1 has two spend rows, so its 8 rows pair twice: 22.
test('35. four sources in one pipeline from the crash side: 22 rows, 7 crashes, 8 events', opts, async (t) => {
  if (skip(t)) return;
  const rows = await chain('crash', 'crashlytics', CHAIN_FROM_CRASH);
  assert.equal(rows.length, 22);
  assert.equal(new Set(rows.map((r) => String(r.crash_id))).size, 7, 'k1..k3, k10 (u1), k6, k9, k13');
  assert.equal(new Set(rows.map((r) => String(r.event_id))).size, 8, 'four u1 crashes point at the same funnel pair');
  assert.equal(new Set(rows.map((r) => String(r.acquisition_id))).size, 5, 'a1 + a7 (u1), a3, a5, a8');
});

// 36. The identical relation reached in a different order, from a different source, through a
//     different sequence of the same declared keys.
test('36. the same four sources from the event side give the identical 22 triples', opts, async (t) => {
  if (skip(t)) return;
  const fromCrash = await chain('crash', 'crashlytics', CHAIN_FROM_CRASH);
  const fromEvent = await chain('event', 'events', CHAIN_FROM_EVENT);
  assert.equal(fromEvent.length, 22);
  assert.deepEqual(triples(fromEvent), triples(fromCrash));
});

// 37. …but the two chains do NOT agree on the country, and that is the point of a point-in-time
//     join: u1 saw its rewarded funnel while still US and crashed after moving to GB.
test('37. each chain attributes the player at ITS OWN instant: GB 20 / BR 2 vs US 16 / GB 4 / BR 2', opts, async (t) => {
  if (skip(t)) return;
  const fromCrash = await chain('crash', 'crashlytics', CHAIN_FROM_CRASH);
  const fromEvent = await chain('event', 'events', CHAIN_FROM_EVENT);
  assert.deepEqual(countBy(fromCrash, 'country'), { GB: 20, BR: 2 }, 'attributed at the crash time');
  assert.deepEqual(countBy(fromEvent, 'country'), { US: 16, GB: 4, BR: 2 }, 'attributed at the ad-event time');
  // the money carried along is the same either way — only the label on it moved.
  assert.ok(near(sumCol(fromCrash, 'cost'), 25.0), `crash side=${sumCol(fromCrash, 'cost')}`);
  assert.ok(near(sumCol(fromEvent, 'cost'), 25.0), `event side=${sumCol(fromEvent, 'cost')}`);
});

// 38. And the CODE the four-way chain generates is the four-way join a human would write —
//     executed on the warehouse and compared row for row (section F, extended to a chain).
test('38. the generated four-way join matches a hand-written one', opts, async (t) => {
  if (skip(t)) return;
  const gen = await generatedSql('crashlytics', ...CHAIN_FROM_CRASH.slice(0, 3));
  const cols = ['crash_id', 'event_id', 'acquisition_id', 'country'];
  // Every `via` resolves its LEFT key from the pipeline's SOURCE, so all three ON clauses hang
  // off the crash row — that is what the reference has to mirror.
  const want = await ordered(`
    SELECT c.crash_id, e.event_id, a.acquisition_id, u.country
      FROM {{ ref('fct_crashlytics_events') }} c
      JOIN {{ ref('fct_analytics_events') }} e
        ON c.rewarded_tracking_id = e.tracking_id
       AND c.player_id_of_internal = e.player_id_of_internal
      JOIN {{ ref('dim_users') }} u
        ON c.player_id_of_internal = u.player_id_of_internal
       AND c.event_time BETWEEN u.install_time_valid_from AND u.install_time_valid_until
      JOIN {{ ref('fct_player_acquisition') }} a
        ON c.player_id_of_internal = a.player_id_of_internal`, cols);
  assert.equal(want.length, 22);
  assert.deepEqual(await ordered(gen, cols), want);
});

// 39. The same four sources aggregated in the chain: spend per crash-carrying funnel event, by
//     the channel it was bought through. The money is inflated by the pairing (that is what a
//     many-to-many join does) — pin the number so nobody reads it as a spend report.
test('39. aggregating the chain: 25.00 across 3 channels, u1 dominating', opts, async (t) => {
  if (skip(t)) return;
  const rows = await pipeRows('crashlytics',
    ...CHAIN_FROM_CRASH.slice(0, 2),
    { stage: 'join', with: 'acquisition', via: 'user', kind: 'inner', attrs: ['media_source', 'cost'] },
    { stage: 'aggregate', group_by: ['media_source'], measures: [{ name: 'spend', fn: 'sum', column: 'cost' }, { name: 'n', fn: 'count' }] });
  const spend = mapCol(rows, 'media_source', 'spend');
  const n = mapCol(rows, 'media_source', 'n');
  assert.ok(near(spend.meta, 20.0), `meta=${spend.meta}`);      // u1 8x1.50 + 8x0.50, u3 2x2.00
  assert.ok(near(spend.applovin, 5.0), `applovin=${spend.applovin}`); // u7 2x2.50
  assert.ok(near(spend.organic, 0.0), `organic=${spend.organic}`);    // u5 2x0.00
  assert.equal(n.meta + n.applovin + n.organic, 22);
  assert.ok(near(sumCol(rows, 'spend'), 25.0));
});

// 40. The GOVERNED path over two facts at once: a spend measure and an event measure in one
//     task, both reaching the SAME slowly-changing install record by the declared player key,
//     plus a ratio that spans them. MetricFlow applies each source's point-in-time join itself.
test('40. governed: spend and events from two sources, sliced by the same install attribute', opts, async (t) => {
  if (skip(t)) return;
  const task = await engine.create_semantic_model({
    name: 'jmix',
    use_base_models: ['users'],
    semantic_models: [
      { from: 'acquisition', measures: [{ name: 'cost', agg: 'sum', field: 'cost' }] },
      { from: 'events', measures: [{ name: 'evts', agg: 'count', field: '*' }] },
    ],
    metrics: [
      { name: 'cost', type: 'simple', measure: { name: 'cost' } },
      { name: 'evts', type: 'simple', measure: { name: 'evts' } },
      { name: 'cost_per_event', type: 'ratio', numerator: { name: 'cost' }, denominator: { name: 'evts' } },
    ],
  });
  assert.equal(task.parse.ok, true, JSON.stringify(task.parse));
  const r = await engine.query_semantic_model({
    context_id: task.context_id,
    metrics: ['jmix_cost', 'jmix_evts', 'jmix_cost_per_event'],
    group_by: [{ model: 'users', attribute: 'country' }],
  });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const key = r.columns.map((c) => c.name).find((n) => n.includes('country'));
  const by = Object.fromEntries(r.rows.map((x) => [String(x[key]), x]));
  for (const [country, cost, evts] of [['US', 6.75, 67], ['GB', 5.0, 57], ['DE', 4.0, 31], ['BR', 1.75, 29]]) {
    assert.ok(near(num(by[country].jmix_cost), cost), `${country} cost=${by[country].jmix_cost}`);
    assert.equal(num(by[country].jmix_evts), evts, `${country} evts`);
    assert.ok(near(num(by[country].jmix_cost_per_event), cost / evts, 1e-6), `${country} cpe=${by[country].jmix_cost_per_event}`);
  }
  // neither source fanned the other out: the totals are still the honest per-source totals.
  assert.ok(near(sumCol(r.rows, 'jmix_cost'), 17.5));
  assert.equal(sumCol(r.rows, 'jmix_evts'), 184);
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
test('41. a join path without its owning model is refused, and works once loaded', opts, async (t) => {
  if (skip(t)) return;
  const bare = await engine.create_semantic_model({
    name: 'jbare',
    semantic_models: [{ from: 'events', measures: [{ name: 'evts', agg: 'count', field: '*' }] }],
    metrics: [{ name: 'evts', type: 'simple', measure: { name: 'evts' } }],
  });
  assert.equal(bare.parse.ok, true, JSON.stringify(bare.parse));
  await assert.rejects(
    () => engine.query_semantic_model({ context_id: bare.context_id, metrics: ['jbare_evts'], group_by: [{ model: 'users', attribute: 'country' }] }),
    /needs model 'users', which is not loaded.*use_base_models/s,
  );
  // the metric itself answers fine — it is the PATH that needed the model, not the measure.
  const flat = await engine.query_semantic_model({ context_id: bare.context_id, metrics: ['jbare_evts'] });
  assert.equal(flat.ok, true, JSON.stringify(flat.error));
  assert.equal(num(flat.rows[0].jbare_evts), 184);
  // …and the context that DID load it returns the point-in-time breakdown.
  const loaded = await q(evCtx, { metrics: ['jev_evts'], group_by: [{ model: 'users', attribute: 'country' }] });
  assert.equal(loaded.ok, true, JSON.stringify(loaded.error));
  assert.equal(sumCol(loaded.rows, 'jev_evts'), 184);
});

// 42. Chaining has a rule worth pinning: `via` resolves its LEFT key on the pipeline's OWN
//     source, so a relationship declared only on a model joined earlier is not reachable. The
//     refusal says which model was asked and what the two sides actually share.
test('42. a chained relationship the pipeline source does not declare is refused', opts, async (t) => {
  if (skip(t)) return;
  const s = await engine.build_native_model({ action: 'start', name: `ch_${seq++}`, source: 'acquisition' });
  const ok = await engine.build_native_model({
    action: 'add_step', draft_id: s.draft_id,
    stage: { stage: 'join', with: 'events', via: 'user', kind: 'inner', attrs: ['tracking_id'] },
  });
  assert.ok(!ok.error, JSON.stringify(ok.error));
  // `tracking_id` is now IN the pipeline — but the ad-funnel relationship belongs to the events
  // source, not to acquisition, so it cannot be the next hop.
  await assert.rejects(
    () => engine.build_native_model({
      action: 'add_step', draft_id: s.draft_id,
      stage: { stage: 'join', with: 'crashlytics', via: 'ad_funnel_rewarded' },
    }),
    /'acquisition' declares no such relationship.*share: user/s,
  );
  // the hop the source DOES declare works from the same draft.
  const good = await engine.build_native_model({
    action: 'add_step', draft_id: s.draft_id,
    stage: { stage: 'join', with: 'crashlytics', via: 'user', kind: 'inner', attrs: ['crash_id'] },
  });
  assert.ok(!good.error, JSON.stringify(good.error));
});

// 43. Three sources, no join between them: a spend measure, an event measure and a crash measure
//     in ONE task, aligned on metric_time. Each keeps its own time axis and its own total — this
//     is how sources are compared when a row-to-row join would be wrong.
test('43. three sources side by side on metric_time keep their own totals: 17.50 / 184 / 13', opts, async (t) => {
  if (skip(t)) return;
  const task = await engine.create_semantic_model({
    name: 'jtri',
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
  assert.equal(task.parse.ok, true, JSON.stringify(task.parse));
  const r = await engine.query_semantic_model({
    context_id: task.context_id,
    metrics: ['jtri_cost', 'jtri_evts', 'jtri_crashes'],
    group_by: [{ time: 'metric_time', grain: 'day' }],
  });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  // A day may carry spend but no crash (and the other way round), so the series has holes —
  // that is the honest shape of an outer alignment, not a bug. Total each metric over it.
  const total = (col) => r.rows.reduce((s, row) => s + (Number.isFinite(num(row[col])) ? num(row[col]) : 0), 0);
  assert.ok(near(total('jtri_cost'), 17.5), `cost=${total('jtri_cost')}`);
  assert.equal(total('jtri_evts'), 184);
  assert.equal(total('jtri_crashes'), 13);
  assert.ok(r.rows.length > 1, 'a real day-by-day series, not one collapsed row');
});

// ═══════════ J. `attrs` IS THE CONTRACT ═══════════
//
// A join exposes EXACTLY the columns the caller lists, and nothing else. `attrs` is required:
// there is no implicit set to reason about, so what the next stage sees is what was asked for,
// and a column that was not listed is an "unknown column" error rather than a surprise.
//
// What matters is that the list may name ANY column of the joined model — not only its
// groupable attributes. Its ids, its time axis, its event-scoped `*_of_event_data` payload and
// above all its AMOUNTS are all reachable; an amount is deliberately not a groupable attribute,
// so a join limited to "dimensions" left cost, impressions and clicks behind — the very fields
// a spend source is joined for.
//
// A name cannot be used twice. If a listed column would land on a name the pipeline already
// carries, or two entries would resolve to one name, the step is REJECTED with the reason and
// the rename to apply — never silently resolved one way or the other.

/** crashlytics → the funnel's events → that player's spend. Every column is named. */
const CHAIN_LISTED = [
  { stage: 'join', with: 'events', via: 'ad_funnel_rewarded', kind: 'inner', attrs: ['event_id', 'tracking_id', 'ad_type_of_event_data'] },
  { stage: 'join', with: 'acquisition', via: 'user', kind: 'inner', attrs: ['acquisition_id', 'spend_date', 'cost', 'impressions', 'clicks', 'media_source'] },
];

// 44. Fields from all three models in one aggregate — ids, event-scoped payload and amounts.
test('44. any column of a joined model can be listed: 7 crashes / 8 events / 25.00 spend', opts, async (t) => {
  if (skip(t)) return;
  const rows = await pipeRows('crashlytics', ...CHAIN_LISTED, {
    stage: 'aggregate',
    measures: [
      { name: 'n', fn: 'count' },
      // crashlytics (the base): its id and an EVENT-SCOPED payload column
      { name: 'crashes', fn: 'count_distinct', column: 'crash_id' },
      { name: 'issues', fn: 'count_distinct', column: 'issue_title_of_event_data' },
      // events (joined): its id, its funnel key and its own event-scoped payload
      { name: 'events', fn: 'count_distinct', column: 'event_id' },
      { name: 'funnels', fn: 'count_distinct', column: 'tracking_id' },
      { name: 'ad_types', fn: 'count_distinct', column: 'ad_type_of_event_data' },
      // acquisition (joined): the AMOUNTS — the fields a dimensions-only join could not reach
      { name: 'spend', fn: 'sum', column: 'cost' },
      { name: 'impressions', fn: 'sum', column: 'impressions' },
      { name: 'clicks', fn: 'sum', column: 'clicks' },
      { name: 'spend_rows', fn: 'count_distinct', column: 'acquisition_id' },
    ],
  });
  const r = rows[0];
  assert.equal(num(r.n), 22);
  assert.equal(num(r.crashes), 7);
  assert.equal(num(r.issues), 5);
  assert.equal(num(r.events), 8);
  assert.equal(num(r.funnels), 4, 'fnl_01, fnl_04, fnl_06, fnl_08');
  assert.equal(num(r.ad_types), 1, 'every one of these funnels is a rewarded ad');
  assert.ok(near(num(r.spend), 25.0), `spend=${r.spend}`);
  assert.equal(num(r.impressions), 1780);
  assert.equal(num(r.clicks), 90);
  assert.equal(num(r.spend_rows), 5);
});

// 45. …and they group by each other: an attribute from the third model as the key, amounts from
//     the same model and a count of the first one as the measures.
test('45. group by a joined attribute, measure joined amounts: meta 18 / organic 2 / applovin 2', opts, async (t) => {
  if (skip(t)) return;
  const rows = await pipeRows('crashlytics', ...CHAIN_LISTED, {
    stage: 'aggregate',
    group_by: ['media_source'],
    measures: [{ name: 'n', fn: 'count' }, { name: 'spend', fn: 'sum', column: 'cost' }, { name: 'impressions', fn: 'sum', column: 'impressions' }],
  });
  const n = mapCol(rows, 'media_source', 'n');
  const spend = mapCol(rows, 'media_source', 'spend');
  const imp = mapCol(rows, 'media_source', 'impressions');
  assert.deepEqual(Object.keys(n).sort(), ['applovin', 'meta', 'organic']);
  assert.equal(n.meta, 18); assert.equal(n.organic, 2); assert.equal(n.applovin, 2);
  assert.ok(near(spend.meta, 20.0) && near(spend.organic, 0.0) && near(spend.applovin, 5.0), JSON.stringify(spend));
  assert.equal(imp.meta, 1420); assert.equal(imp.organic, 0); assert.equal(imp.applovin, 360);
});

// 46. A joined TIME column is a time column, not a string: date math across two models works.
//     Days from the spend row to the crash — 2 to 6 across the 22 pairs.
test('46. date math between a base time column and a joined one: 2..6 days, 82 in total', opts, async (t) => {
  if (skip(t)) return;
  const rows = await pipeRows('crashlytics', ...CHAIN_LISTED,
    { stage: 'compute', name: 'days_after_spend', op: 'date_diff', from: { column: 'spend_date' }, to: { column: 'event_time' }, unit: 'day' },
    { stage: 'aggregate', measures: [{ name: 'lo', fn: 'min', column: 'days_after_spend' }, { name: 'hi', fn: 'max', column: 'days_after_spend' }, { name: 'total', fn: 'sum', column: 'days_after_spend' }] });
  assert.equal(num(rows[0].lo), 2);
  assert.equal(num(rows[0].hi), 6);
  assert.equal(num(rows[0].total), 82);
});

// 47. What was listed is what is there — and nothing else. The joined model has 30-odd more
//     columns; none of them leaked in, so naming one is a plain unknown-column failure.
test('47. only the listed columns arrive: an unlisted one is an unknown column', opts, async (t) => {
  if (skip(t)) return;
  const narrow = { stage: 'join', with: 'events', via: 'ad_funnel_rewarded', kind: 'inner', attrs: ['event_id'] };
  // the listed one is usable…
  const rows = await pipeRows('crashlytics', narrow,
    { stage: 'aggregate', measures: [{ name: 'events', fn: 'count_distinct', column: 'event_id' }] });
  assert.equal(num(rows[0].events), 8);
  // …and its neighbours in the joined model are simply not in the pipeline.
  for (const unlisted of ['tracking_id', 'ad_type_of_event_data', 'session_number', 'device_time']) {
    await assert.rejects(
      () => pipeRows('crashlytics', narrow, { stage: 'aggregate', measures: [{ name: 'x', fn: 'count_distinct', column: unlisted }] }),
      new RegExp(`unknown column '${unlisted}'`),
      `${unlisted} must not appear unasked`,
    );
  }
  // …and asking for it is all it takes.
  const wider = await pipeRows('crashlytics',
    { ...narrow, attrs: ['event_id', 'tracking_id'] },
    { stage: 'aggregate', measures: [{ name: 'funnels', fn: 'count_distinct', column: 'tracking_id' }] });
  assert.equal(num(wider[0].funnels), 4);
});

// 48. Every way a name can end up used twice is refused, with the reason and the rename. The
//     join key is called out separately: its value is the same on both sides, so the copy is
//     not something to rename — it is something to drop.
test('48. duplicate names and unknown columns are refused with the fix', opts, async (t) => {
  if (skip(t)) return;
  // (a) attrs missing entirely — the error lists what the model actually offers.
  await assert.rejects(
    () => joinStep('crashlytics', { stage: 'join', with: 'acquisition', via: 'user' }),
    (e) => {
      assert.match(e.message, /`attrs` is required — list the columns you want/);
      assert.match(e.message, /Columns of 'acquisition':.*cost.*impressions.*clicks/s);
      return true;
    },
  );
  // (b) a column the joined model does not have.
  await assert.rejects(
    () => joinStep('crashlytics', { stage: 'join', with: 'acquisition', via: 'user', attrs: ['cost', 'nope'] }),
    /'nope' is not a column of 'acquisition'.*cost/s,
  );
  // (c) a name the pipeline already carries, holding DIFFERENT data → rename it.
  await assert.rejects(
    () => joinStep('crashlytics', { stage: 'join', with: 'events', via: 'ad_funnel_rewarded', attrs: ['event_name'] }),
    (e) => {
      assert.match(e.message, /already has a column named 'event_name'/);
      assert.match(e.message, /hold different data.*as: 'events_event_name'/s);
      return true;
    },
  );
  // (d) the same name, but it is the JOIN KEY → the pipeline's column already holds that value.
  await assert.rejects(
    () => joinStep('crashlytics', { stage: 'join', with: 'events', via: 'ad_funnel_rewarded', attrs: ['player_id_of_internal'] }),
    /is the join key.*holds the same value — drop it from attrs/s,
  );
  // (e) two entries resolving to one name.
  await assert.rejects(
    () => joinStep('crashlytics', {
      stage: 'join', with: 'events', via: 'ad_funnel_rewarded',
      attrs: [{ column: 'event_id', as: 'x' }, { column: 'tracking_id', as: 'x' }],
    }),
    /'event_id' and 'tracking_id' would both be named 'x'/,
  );
  // …and the rename the error printed is accepted, with both sides present.
  const rows = await pipeRows('crashlytics',
    { stage: 'join', with: 'events', via: 'ad_funnel_rewarded', kind: 'inner', attrs: [{ column: 'event_name', as: 'events_event_name' }] },
    { stage: 'aggregate', group_by: ['event_name', 'events_event_name'], measures: [{ name: 'n', fn: 'count' }] });
  const crashSide = {}; const adSide = {};
  for (const r of rows) {
    crashSide[String(r.event_name)] = (crashSide[String(r.event_name)] || 0) + num(r.n);
    adSide[String(r.events_event_name)] = (adSide[String(r.events_event_name)] || 0) + num(r.n);
  }
  assert.deepEqual(crashSide, { fatal_crash: 8, non_fatal: 4, anr: 2 }, 'the base keeps its own event_name');
  assert.deepEqual(adSide, { ad_started: 7, ad_finished: 7 }, 'and the joined one lives beside it, renamed');
});

// 49. The all-at-once path is held to the same contract — a pipeline handed over whole, or
//     merely previewed, is rejected the same way instead of building a model that misses a
//     field. crashlytics and the install record both carry app_version and device_model, and
//     they mean different things: the version that crashed vs the version at install.
test('49. a pipeline passed whole obeys the same contract', opts, async (t) => {
  if (skip(t)) return;
  const preview = (attrs) => engine.register_native_model({
    name: 'contract_preview', dry_run: true,
    pipeline: { source: 'crashlytics', stages: [{ stage: 'join', with: 'users', via: 'user', between: AT('event_time'), kind: 'inner', ...(attrs ? { attrs } : {}) }] },
  });
  await assert.rejects(() => preview(null), /join 'users': `attrs` is required/);
  await assert.rejects(() => preview(['app_version']), /already has a column named 'app_version'.*as: 'users_app_version'/s);
  const ok = await preview([{ column: 'app_version', as: 'users_app_version' }, 'country']);
  assert.ok(ok.model_sql, 'the resolved preview renders');

  // and it builds, with BOTH versions in the result.
  const rows = await pipeRows('crashlytics',
    { stage: 'join', with: 'users', via: 'user', between: AT('event_time'), kind: 'inner', attrs: [{ column: 'app_version', as: 'users_app_version' }, 'country'] },
    { stage: 'aggregate', measures: [
      { name: 'n', fn: 'count' },
      { name: 'crash_versions', fn: 'count_distinct', column: 'app_version' },
      { name: 'install_versions', fn: 'count_distinct', column: 'users_app_version' },
      { name: 'countries', fn: 'count_distinct', column: 'country' },
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
// path exists". Second that `unique` is a CLAIM ABOUT THE DATA and nothing verifies it: in THIS
// warehouse it is false (four reports of u1 name the same funnel), and the numbers below are the
// honest consequence.

// 50. The governed path reaches the owning fact's attributes: 176 events matched no report,
//     14 matched one — split by the app version the crash was reported from.
test('50. a fact that owns a key exposes its attributes to a governed group-by', opts, async (t) => {
  if (skip(t)) return;
  assert.equal(ownerCatalog.joinTargetFor('ad_funnel'), 'crashlytics', 'the crash source is the target');
  const r = await ownerEngine.query_semantic_model({
    context_id: ownerCtx, metrics: ['jown_evts'], group_by: [{ model: 'crashlytics', attribute: 'app_version', via: 'ad_funnel' }],
  });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const key = r.columns.map((c) => c.name).find((n) => n.includes('app_version'));
  const by = Object.fromEntries(r.rows.map((x) => [x[key] == null ? 'none' : String(x[key]), num(x.jown_evts)]));
  assert.deepEqual(by, { none: 176, '1.0.0': 6, '1.1.0': 8 });
});

// 51. …and the total says what the claim cost: 190 against an honest 184. u1's two funnel
//     events match FOUR of its crash reports, so they are counted four times. Where the owning
//     side really does hold one row per key, the same query totals exactly.
test('51. `unique` is a claim nobody checks: a false one inflates 184 to 190', opts, async (t) => {
  if (skip(t)) return;
  const flat = await ownerEngine.query_semantic_model({ context_id: ownerCtx, metrics: ['jown_evts'] });
  assert.equal(flat.ok, true, JSON.stringify(flat.error));
  assert.equal(num(flat.rows[0].jown_evts), 184, 'ungrouped, nothing is joined and the count is honest');

  const grouped = await ownerEngine.query_semantic_model({
    context_id: ownerCtx, metrics: ['jown_evts'], group_by: [{ model: 'crashlytics', attribute: 'device_model', via: 'ad_funnel' }],
  });
  assert.equal(grouped.ok, true, JSON.stringify(grouped.error));
  assert.equal(sumCol(grouped.rows, 'jown_evts'), 190, 'the join added 6 rows: 2 events x 4 reports of one funnel');
  // the same key is genuinely NOT unique on the owning side — which is why.
  const dup = await pg.db.query(`SELECT count(*) AS n FROM (
    SELECT rewarded_tracking_id, player_id_of_internal FROM public.fct_crashlytics_events
    WHERE rewarded_tracking_id IS NOT NULL GROUP BY 1, 2 HAVING count(*) > 1) d`);
  assert.equal(num(dup.rows[0].n), 1, 'one duplicated (funnel, player) pair — u1 with fnl_01, four times');
});


// 52. The KEY SHAPE comes from the declaration and nothing else. The same warehouse, the same
//     question, the crash source owning the funnel by ONE column instead of two: both sides
//     render that one column, the keys still meet, and the answer is identical to scenario 50.
test('52. a one-column `unique` key answers exactly as the two-column one', opts, async (t) => {
  if (skip(t)) return;
  assert.equal(oneCatalog.joinTargetFor('ad_funnel'), 'crashlytics', 'one column is enough to own it');
  assert.deepEqual(oneCatalog.entityKey('crashlytics', 'ad_funnel'), [{ column: 'rewarded_tracking_id' }]);
  assert.deepEqual(oneCatalog.entityKey('events', 'ad_funnel'), [{ column: 'tracking_id' }]);

  const r = await oneEngine.query_semantic_model({
    context_id: oneCtx, metrics: ['jone_evts'], group_by: [{ model: 'crashlytics', attribute: 'app_version', via: 'ad_funnel' }],
  });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const key = r.columns.map((c) => c.name).find((n) => n.includes('app_version'));
  const by = Object.fromEntries(r.rows.map((x) => [x[key] == null ? 'none' : String(x[key]), num(x.jone_evts)]));
  assert.deepEqual(by, { none: 176, '1.0.0': 6, '1.1.0': 8 }, 'same numbers as the two-column key');

  const dev = await oneEngine.query_semantic_model({
    context_id: oneCtx, metrics: ['jone_evts'], group_by: [{ model: 'crashlytics', attribute: 'device_model', via: 'ad_funnel' }],
  });
  assert.equal(dev.ok, true, JSON.stringify(dev.error));
  const dk = dev.columns.map((c) => c.name).find((n) => n.includes('device_model'));
  assert.deepEqual(Object.fromEntries(dev.rows.map((x) => [x[dk] == null ? 'none' : String(x[dk]), num(x.jone_evts)])),
    { none: 176, iphone: 14 });
});

// 53. NOTHING IS ADVERTISED THAT CANNOT BE ANSWERED. Whatever the catalog lists under the owned
//     relationship is queried here, one path at a time, driven off the catalog itself — so a
//     newly declared attribute is covered without touching this test. Each one must come back
//     with rows; the owner's OWN attributes must also total exactly 184, since a truthful
//     many-to-one join cannot add a row.
test('53. every attribute the catalog advertises for an owned relationship answers', opts, async (t) => {
  if (skip(t)) return;
  const refs = trueCatalog.reachableAttributes().filter((r) => r.model === 'crashlytics' && r.via === 'ad_funnel');
  const own = Object.keys(trueCatalog.getModel('crashlytics').dimensions || {});
  assert.ok(own.length >= 2, `the owning fact must declare attributes to reach: ${own}`);
  assert.deepEqual(refs.map((r) => r.attribute).sort(), [...own].sort(), 'exactly the owner\'s attributes are advertised through the relationship');

  const refused = []; const totals = {};
  for (const ref of refs) {
    let r;
    try {
      r = await trueEngine.query_semantic_model({ context_id: trueCtx, metrics: ['jtrue_evts'], group_by: [ref] });
    } catch (e) { refused.push(`${ref.model}.${ref.attribute}: threw ${e.message}`); continue; }
    if (!r.ok) { refused.push(`${ref.model}.${ref.attribute}: ${JSON.stringify(r.error)}`); continue; }
    if (!r.rows.length) { refused.push(`${ref.model}.${ref.attribute}: answered with no rows`); continue; }
    totals[ref.attribute] = sumCol(r.rows, 'jtrue_evts');
  }
  assert.deepEqual(refused, [], 'the catalog must not offer an attribute the engine refuses');
  for (const a of own) assert.equal(totals[a], 184, `${a} must not inflate`);
});


// 54. THE ANSWER TO "how can a many-to-one join fan out". It cannot. Section K's 190 came from a
//     FALSE claim; here the owning column really does hold one row per value (checked against
//     the warehouse below), and the very same generated join keeps the count at exactly 184 —
//     24 events find their one crash report, 160 find none.
test('54. a truthful `unique` never duplicates: 184 stays 184', opts, async (t) => {
  if (skip(t)) return;
  const dup = await pg.db.query(`SELECT count(*) AS n FROM (
    SELECT funnel_tracking_id FROM public.fct_crashlytics_events
    WHERE funnel_tracking_id IS NOT NULL GROUP BY 1 HAVING count(*) > 1) d`);
  assert.equal(num(dup.rows[0].n), 0, 'the claim is true on this warehouse: no repeated key');

  const flat = await trueEngine.query_semantic_model({ context_id: trueCtx, metrics: ['jtrue_evts'] });
  assert.equal(flat.ok, true, JSON.stringify(flat.error));
  assert.equal(num(flat.rows[0].jtrue_evts), 184);

  const r = await trueEngine.query_semantic_model({
    context_id: trueCtx, metrics: ['jtrue_evts'], group_by: [{ model: 'crashlytics', attribute: 'app_version', via: 'ad_funnel' }],
  });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const key = r.columns.map((c) => c.name).find((n) => n.includes('app_version'));
  const by = Object.fromEntries(r.rows.map((x) => [x[key] == null ? 'none' : String(x[key]), num(x.jtrue_evts)]));
  assert.deepEqual(by, { none: 160, '1.0.0': 16, '1.1.0': 8 }, '24 matched, none twice');
  assert.equal(sumCol(r.rows, 'jtrue_evts'), 184, 'the join added nothing — many-to-ONE');

  const dev = await trueEngine.query_semantic_model({
    context_id: trueCtx, metrics: ['jtrue_evts'], group_by: [{ model: 'crashlytics', attribute: 'device_model', via: 'ad_funnel' }],
  });
  assert.equal(dev.ok, true, JSON.stringify(dev.error));
  const dk = dev.columns.map((c) => c.name).find((n) => n.includes('device_model'));
  assert.deepEqual(Object.fromEntries(dev.rows.map((x) => [x[dk] == null ? 'none' : String(x[dk]), num(x.jtrue_evts)])),
    { none: 160, iphone: 12, pixel: 8, galaxy: 4 });
  assert.equal(sumCol(dev.rows, 'jtrue_evts'), 184);
});

// ═══════════ L. A KEY PART'S GRAIN ═══════════
//
// A measures source is one row per player×DAY, so it joins to events on the pair (player, day) —
// and the two sides store that day differently: the spend row at midnight, the event at the moment
// it happened. The grain is what makes them the same key: BOTH sides render truncated to it. The
// contrast is the proof — the same relationship declared without the grain compares raw timestamps
// and matches nothing at all.
const perDayCatalog = (grain) => {
  const d = yaml.load(readFileSync(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), 'utf8'));
  const M = Object.fromEntries(d.models.map((x) => [x.name, x]));
  const day = (column) => (grain ? { column, grain } : column);
  mcp(M.fct_player_acquisition).entities = {
    ...(mcp(M.fct_player_acquisition).entities || {}),
    player_day: { type: 'unique', key: ['player_id_of_internal', day('spend_date')] },
  };
  mcp(M.fct_analytics_events).entities.player_day = { type: 'foreign', key: ['player_id_of_internal', day('device_time')] };
  const at = join(mkdtempSync(join(tmpdir(), `perday-${grain || 'raw'}-`)), 'catalog.yml');
  writeFileSync(at, yaml.dump(d));
  return loadCatalog(at, { profilesDir: BASE, projectDir: BASE });
};

/** Join events → acquisition through `player_day` on the given catalog and count what matched. */
async function perDayMatches(catalog) {
  const eng = settle(new Engine({ catalog, contextManager: new ContextManager({ baseProjectDir: BASE, workspaceRoot: mkdtempSync(join(tmpdir(), 'perday-ctx-')), timeSpineDialect: 'postgres' }), runner: backend }));
  const s = await eng.build_native_model({ action: 'start', name: `pd_${seq++}`, source: 'events' });
  const j = await eng.build_native_model({
    action: 'add_step',
    draft_id: s.draft_id,
    stage: { stage: 'join', with: 'acquisition', via: 'player_day', kind: 'inner', attrs: ['cost'] },
  });
  assert.ok(!j.error, `add_step join: ${JSON.stringify(j.error)}`);
  await eng.build_native_model({ action: 'add_step', draft_id: s.draft_id, stage: { stage: 'aggregate', measures: [{ name: 'n', fn: 'count' }, { name: 'spend', fn: 'sum', column: 'cost' }] } });
  const c = await eng.build_native_model({ action: 'materialize', draft_id: s.draft_id });
  assert.equal(c.build?.ok, true, JSON.stringify(c.error || c.build));
  return { n: num(c.rows[0].n), spend: num(c.rows[0].spend) };
}

test('34. a key part declared at day grain joins the day, not the instant', opts, async (t) => {
  if (skip(t)) return;
  const withGrain = await perDayMatches(perDayCatalog('day'));
  const raw = await perDayMatches(perDayCatalog(null));
  // Same declaration, same warehouse: only the grain differs. Without it the event's timestamp is
  // compared to the spend row's midnight and nothing matches; with it every event that happened on
  // a day the player has a spend row finds exactly that row.
  assert.equal(raw.n, 0, 'without a grain the raw timestamps never meet');
  assert.ok(withGrain.n > 0, 'with the grain the day matches');
  // 150 = the events whose (player, day) appears in the 13 acquisition rows; 203.25 = each of
  // those events carrying its own day's cost (the seed has exactly one spend row per player-day,
  // so a per-day join cannot fan out).
  assert.equal(withGrain.n, 150, 'events on a player-day that has a spend row');
  assert.equal(withGrain.spend, 203.25, 'each matched event carries its day\'s spend');
});

// A grain is part of the key, so it is checked like one: an unknown unit, or a field that is not a
// key part at all, is refused at LOAD — not silently dropped, leaving a join that compares raw.
test('35. a key part takes column + grain, and nothing else', opts, async (t) => {
  if (skip(t)) return;
  const bad = (part) => () => {
    const d = yaml.load(readFileSync(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), 'utf8'));
    const M = Object.fromEntries(d.models.map((x) => [x.name, x]));
    mcp(M.fct_analytics_events).entities.player_day = { type: 'foreign', key: ['player_id_of_internal', part] };
    const at = join(mkdtempSync(join(tmpdir(), 'badpart-')), 'catalog.yml');
    writeFileSync(at, yaml.dump(d));
    return loadCatalog(at, { profilesDir: BASE, projectDir: BASE });
  };
  assert.throws(bad({ column: 'device_time', grain: 'fortnight' }), /grain 'fortnight' is not one of day, week, month, quarter, year/);
  assert.throws(bad({ column: 'device_time', truncate: 'day' }), /'truncate' is not a key-part field/);
});
