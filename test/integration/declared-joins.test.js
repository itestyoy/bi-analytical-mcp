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
  const r = await q(acqCtx, { metrics: ['jacq_cost'], where: [{ field: { kind: 'dimension', path: 'user__country' }, op: 'eq', value: 'GB' }] });
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
});

// 23. A relationship whose key column is missing stops being offered — and cannot be called.
test('23. a phantom relationship is pruned and rejected at the call', opts, async (t) => {
  if (skip(t)) return;
  assert.ok(!phantom.joinEntityNames().includes('ad_funnel_ghost'), 'not offered any more');
  assert.equal(phantom.entityKey('crashlytics', 'ad_funnel_ghost'), undefined);
  assert.match(String(phantomPruned.crashlytics || ''), /entity:ad_funnel_ghost/);
  const s = await phantomEngine.build_native_model({ action: 'start', name: `ph_${seq++}`, source: 'crashlytics' });
  await assert.rejects(
    () => phantomEngine.build_native_model({ action: 'add_step', draft_id: s.draft_id, stage: { stage: 'join', with: 'events', via: 'ad_funnel_ghost' } }),
    /declares no such relationship/,
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
  // the owner's other, real relationship is untouched
  assert.deepEqual(phantom.entityKey('experiments', 'user'), [{ column: 'player_id_of_internal' }]);
  assert.equal(phantom.joinTargetFor('user'), 'users');
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
