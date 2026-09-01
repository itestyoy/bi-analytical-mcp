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
//               from both ends, plus the governed path over two facts at the same time.
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
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { startPglite } from './pglite-harness.js';

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
  engine = new Engine({ catalog, contextManager: ctxs, runner: backend });

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
  M.fct_experiment_assignments.meta.mcp.entities = { ghost_pair: { type: 'unique', key: ['ghost_pair_id', 'player_id_of_internal'] } };
  M.fct_analytics_events.meta.mcp.entities.ghost_pair = { type: 'foreign', key: ['event_id', 'player_id_of_internal'] };
  // (c) HALF a window: the start column is real, the end column is missing
  M.dim_users.columns.find((c) => c.name === 'install_time_valid_until').name = 'ghost_valid_end';
  // (d) a variant of a working relationship, on a missing column
  M.fct_crashlytics_events.columns.push({ name: 'ghost_tracking_id', data_type: 'string' });
  M.fct_crashlytics_events.meta.mcp.entities.ad_funnel.variants.ghost = { key: ['ghost_tracking_id', 'player_id_of_internal'] };

  const phantomPath = join(mkdtempSync(join(tmpdir(), 'phantom-')), 'catalog.yml');
  writeFileSync(phantomPath, yaml.dump(doc));
  phantom = loadCatalog(phantomPath, { profilesDir: BASE, projectDir: BASE });
  // every phantom declaration survives the LOAD — only the warehouse knows they are not there
  assert.equal(phantom.getModel('acquisition').scd, true, 'declared as slowly-changing before grounding');
  assert.ok(phantom.joinEntityNames().includes('ad_funnel_ghost'));
  assert.equal(phantom.joinTargetFor('ghost_pair'), 'experiments');

  ({ pruned: phantomPruned } = await groundCatalogToPhysical(phantom, backend, BASE));

  phantomEngine = new Engine({ catalog: phantom, contextManager: ctxs, runner: backend });
  const pc = await phantomEngine.create_semantic_model({
    name: 'jph',
    semantic_models: [{ from: 'acquisition', measures: [{ name: 'cost', agg: 'sum', field: 'cost' }] }],
    metrics: [{ name: 'cost', type: 'simple', measure: { name: 'cost' } }],
  });
  assert.equal(pc.parse.ok, true, `the grounded phantom catalog must still parse: ${JSON.stringify(pc.parse)}`);
  phantomCostCtx = pc.context_id;
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
test('5. governed = pipeline: the metric by user__country matches scenario 4', opts, async (t) => {
  if (skip(t)) return;
  const r = await q(acqCtx, { metrics: ['jacq_cost'], group_by: ['user__country'] });
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
  const r = await q(acqCtx, { metrics: ['jacq_cost'], where: { op: 'and', conditions: [{ field: { kind: 'dimension', path: 'user__country' }, op: 'eq', value: 'GB' }] } });
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
  const r = await q(evCtx, { metrics: ['jev_evts'], group_by: ['user__country'] });
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
  const res = await phantomEngine.query_semantic_model({ context_id: sm.context_id, metrics: ['jphev_evts'], group_by: ['user__country'] });
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
  const r = await q(evCtx, { metrics: ['jev_evts'], group_by: ['ad_funnel_rewarded__country'] }).catch((e) => ({ ok: false, error: String(e.message || e) }));
  assert.equal(r.ok, false, 'the funnel key must not be groupable in a metric query');
  // …while the owned player key is, and answers with real numbers.
  const good = await q(evCtx, { metrics: ['jev_evts'], group_by: ['user__country'] });
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
  const r = await q(acqCtx, { metrics: ['jacq_cost'], group_by: ['user__country'], dry_run: true });
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
    group_by: ['user__country'],
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
