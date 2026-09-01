// RELATIONSHIPS DECLARED IN THE SCHEMA, used by both paths.
//
// A model declares its join keys once (meta.mcp.entities). A key may span SEVERAL columns and
// may line a time column up at a coarser grain, and the two sides may name their columns
// differently. Nothing here restates a column: a metric query groups by <entity>__<attribute>,
// a pipeline joins with `via: <entity>`.
//
// The fixture declares two such keys (see test/integration/fixtures/SEED_DATA.md §12):
//   player_day      = (player, day)          OWNED by the acquisition source (one row per pair);
//                     the events sources and the install record point at it with their own
//                     time column truncated to the day.
//   tracked_install = (tracking_id, player)  OWNED by dim_users (the install record);
//                     both events sources point at it.
//
// Every assertion is a NUMBER from running the model against the warehouse. The seed carries a
// deliberate STALE track (u12's 7 events and crash k13 report a tracking_id that is on no
// install record), so a composite-key join returns provably different counts from a join on the
// player alone — which is what proves the declared key is really being applied.
//
// Auto-skips when dbt/mf are not installed (HAS_DBT gate).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadCatalog } from '../../src/catalog.js';
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

let pg; let engine; let backend; let seq = 0;

const num = (v) => Number(v === '' || v == null ? NaN : v);
const mapCol = (rows, keyCol, valCol) => Object.fromEntries(rows.map((r) => [String(r[keyCol]), num(r[valCol])]));
const groupCol = (res, metric) => res.columns.map((c) => c.name).find((n) => n !== metric);
const sumCol = (rows, col) => rows.reduce((s, r) => s + num(r[col]), 0);

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
}, opts);

after(async () => { backend?.close(); if (pg) await pg.stop(); });
const skip = (t) => { if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; } return false; };

/** Build a pipeline: source -> the given stages -> COUNT(*), and return the row count. */
async function joinedRows(source, ...stages) {
  const s = await engine.build_native_model({ action: 'start', name: `jn_${seq++}`, source });
  for (const stage of [...stages, { stage: 'aggregate', measures: [{ name: 'n', fn: 'count' }] }]) {
    const r = await engine.build_native_model({ action: 'add_step', draft_id: s.draft_id, stage });
    assert.ok(!r.error, `add_step ${stage.stage}: ${JSON.stringify(r.error)}`);
  }
  const c = await engine.build_native_model({ action: 'materialize', draft_id: s.draft_id });
  assert.equal(c.build?.ok, true, JSON.stringify(c.error || c.build));
  return num(c.rows[0].n);
}

// ───────────────── 1. TWO EVENTS SOURCES joined on (tracking_id, player) ─────────────────

// The join the schema sanctions between the two events sources. Neither owns the key — a crash
// row and an analytics row match many-to-many — which is exactly why this belongs in a pipeline.
// SEED_DATA §12: matching pairs are 266 via the declared key; crash k13 carries the stale track,
// so joining on the player alone instead pulls in u7's 16 analytics events and gives 282.
test('two events sources join on the declared (tracking_id, player) key: 266 pairs, not 282', opts, async (t) => {
  if (skip(t)) return;
  const viaKey = await joinedRows('crashlytics', { stage: 'join', with: 'events', via: 'tracked_install', kind: 'inner', attrs: [] });
  const onPlayer = await joinedRows('crashlytics', { stage: 'join', with: 'events', on: ['player_id_of_internal'], kind: 'inner', attrs: [] });
  assert.equal(viaKey, 266, 'the composite key drops the crash whose track is on no install record');
  assert.equal(onPlayer, 282, 'the player alone matches that crash against all 16 of u7\'s events');
  assert.equal(onPlayer - viaKey, 16);
});

// The same relationship read from the OTHER side: analytics events joined to crash reports.
// Symmetric — the key is declared once and neither side is privileged.
test('the same relationship works in the other direction: events -> crash reports = 266', opts, async (t) => {
  if (skip(t)) return;
  assert.equal(await joinedRows('events', { stage: 'join', with: 'crashlytics', via: 'tracked_install', kind: 'inner', attrs: [] }), 266);
});

// ───────────────── 2. ACQUISITION <-> EVENTS ─────────────────

// Acquisition reaches the events sources exactly as the install record does. On the (player, day)
// key each event matches AT MOST ONE spend row: 150 event rows fall on a day the player has
// spend. Joining on the player alone fans out to 220, because u1 has spend on two days.
test('acquisition joins to an events source on (player, day): 150 rows, no fan-out', opts, async (t) => {
  if (skip(t)) return;
  const viaKey = await joinedRows('events', { stage: 'join', with: 'acquisition', via: 'player_day', kind: 'inner', attrs: ['media_source'] });
  const onPlayer = await joinedRows('events', { stage: 'join', with: 'acquisition', on: ['player_id_of_internal'], kind: 'inner', attrs: ['media_source'] });
  assert.equal(viaKey, 150);
  assert.equal(onPlayer, 220, 'the player alone multiplies u1\'s events across both of its spend days');
});

// …and from the acquisition side into the events source: the same relationship, same pairs.
test('an acquisition pipeline joins the events source on the same declared key = 150', opts, async (t) => {
  if (skip(t)) return;
  assert.equal(await joinedRows('acquisition', { stage: 'join', with: 'events', via: 'player_day', kind: 'inner', attrs: [] }), 150);
});

// The crash source reaches acquisition through the same declared key — nothing about it is
// specific to the analytics source. Here the DAY part of the key does all the work: every crash
// is on 2026-01-05..08 while all spend is on 01-01..05, and no player crashed on one of their
// own spend days — so the declared key matches nothing, while the player alone matches 17 pairs.
test('the crash source reaches acquisition on the same (player, day) key', opts, async (t) => {
  if (skip(t)) return;
  const viaKey = await joinedRows('crashlytics', { stage: 'join', with: 'acquisition', via: 'player_day', kind: 'inner', attrs: ['media_source'] });
  const onPlayer = await joinedRows('crashlytics', { stage: 'join', with: 'acquisition', on: ['player_id_of_internal'], kind: 'inner', attrs: ['media_source'] });
  assert.equal(viaKey, 0, 'no crash falls on a day that player had spend');
  assert.equal(onPlayer, 17, 'dropping the day part matches every crash against every spend row of its player');
  // …and a LEFT join keeps all 13 crash rows, with the spend attribute simply NULL.
  assert.equal(await joinedRows('crashlytics', { stage: 'join', with: 'acquisition', via: 'player_day', attrs: ['media_source'] }), 13);
});

// ───────────────── 3. INSTALLS <-> ACQUISITION ─────────────────

// The install record joins to acquisition on the install DAY: every one of the 12 installs finds
// exactly one spend row, so the count is 12 and not the 13 acquisition rows (u1's second spend
// day is not an install day).
test('installs join to acquisition on the install day: 12 installs, one spend row each', opts, async (t) => {
  if (skip(t)) return;
  assert.equal(await joinedRows('users', { stage: 'join', with: 'acquisition', via: 'player_day', kind: 'inner', attrs: ['media_source'] }), 12);
});

// …and back: every acquisition row finds its player in the install record.
test('acquisition joins back to installs on the player: all 13 spend rows match', opts, async (t) => {
  if (skip(t)) return;
  assert.equal(await joinedRows('acquisition', { stage: 'join', with: 'users', via: 'user', kind: 'inner', attrs: ['country'] }), 13);
});

// ───────────────── 4. EVENTS <-> INSTALLS on the composite install key ─────────────────

// The stricter install key vs the player key, on the same two tables: u12's 7 events report a
// track that is on no install record, so they match on the player but not on the install key.
test('the install key is stricter than the player key: 177 events match, not 184', opts, async (t) => {
  if (skip(t)) return;
  assert.equal(await joinedRows('events', { stage: 'join', with: 'users', via: 'tracked_install', kind: 'inner', attrs: ['country'] }), 177);
  assert.equal(await joinedRows('events', { stage: 'join', with: 'users', via: 'user', kind: 'inner', attrs: ['country'] }), 184);
});

// ───────────────── 5. KEY VARIANTS: the caller picks which tracking column ─────────────────

// The crash source reports a SEPARATE tracking id per ad format, and only the one for the format
// in play is populated. Each is a VARIANT of one declared relationship, so the caller picks which
// to join on. SEED_DATA §12: rewarded k1..k5, interstitial k6..k9, banner k10..k13 (k13 stale).
test('each ad-format tracking column is its own variant of the same relationship', opts, async (t) => {
  if (skip(t)) return;
  const matched = (variant) => joinedRows('crashlytics', { stage: 'join', with: 'users', via: `tracked_ad_${variant}`, kind: 'inner', attrs: ['country'] });
  assert.equal(await matched('rewarded'), 5);
  assert.equal(await matched('interstitial'), 4);
  assert.equal(await matched('banner'), 3, 'k13 reports a track no install record has');
  // together they account for every crash but the stale one — the variants partition the rows
  assert.equal(5 + 4 + 3, 12);
});

// The owning side declares its key ONCE; its single tracking column answers for every variant.
test('the owning side needs no per-variant declaration', opts, async (t) => {
  if (skip(t)) return;
  const users = await engine.semantic_index({ model: 'users' });
  const byName = Object.fromEntries(users.relationships.map((r) => [r.entity, r]));
  for (const v of ['rewarded', 'interstitial', 'banner']) {
    assert.deepEqual(byName[`tracked_ad_${v}`].key, ['tracking_id', 'player_id_of_internal'], `users answers ${v} with its one column`);
    assert.equal(byName[`tracked_ad_${v}`].owned_here, true);
  }
  const crash = Object.fromEntries((await engine.semantic_index({ model: 'crashlytics' })).relationships.map((r) => [r.entity, r]));
  assert.deepEqual(crash.tracked_ad_rewarded.key, ['rewarded_tracking_id', 'player_id_of_internal']);
  assert.deepEqual(crash.tracked_ad_banner.key, ['banner_tracking_id', 'player_id_of_internal']);
  assert.equal(crash.tracked_ad, undefined, 'a variants-only side has no base relationship of its own');
});

// …and the variants work in the semantic layer too: the SAME crash measure, attributed through a
// different tracking column each time.
test('a metric query picks the variant: crashes by country per ad format', opts, async (t) => {
  if (skip(t)) return;
  const out = await engine.create_semantic_model({
    name: 'adfmt',
    use_base_models: ['users'],
    semantic_models: [{ from: 'crashlytics', measures: [{ name: 'crashes', agg: 'count', field: '*' }] }],
    metrics: [{ name: 'crashes', type: 'simple', measure: { name: 'crashes' } }],
  });
  assert.equal(out.parse.ok, true, JSON.stringify(out.parse));
  const attributed = async (variant) => {
    const r = await engine.query_semantic_model({ context_id: out.context_id, metrics: ['adfmt_crashes'], group_by: [`tracked_ad_${variant}__country`] });
    assert.equal(r.ok, true, JSON.stringify(r.error));
    const by = mapCol(r.rows, groupCol(r, 'adfmt_crashes'), 'adfmt_crashes');
    return { attributed: sumCol(r.rows.filter((x) => x[groupCol(r, 'adfmt_crashes')] != null), 'adfmt_crashes'), by };
  };
  // rewarded: k1..k3 (u1, US) and k4..k5 (u2, US) -> 5 attributed, all US
  const rew = await attributed('rewarded');
  assert.equal(rew.attributed, 5);
  assert.equal(rew.by.US, 5);
  // interstitial: k6 (u3, GB), k7..k8 (u4, DE), k9 (u5, BR)
  const inter = await attributed('interstitial');
  assert.equal(inter.attributed, 4);
  assert.equal(inter.by.GB, 1);
  assert.equal(inter.by.DE, 2);
  assert.equal(inter.by.BR, 1);
  // banner: k10 (u1, US), k11..k12 (u6, US) -> 3 attributed; k13's stale track is not
  const ban = await attributed('banner');
  assert.equal(ban.attributed, 3);
  assert.equal(ban.by.US, 3);
});

// ───────────────── 6. THE SAME KEYS IN THE SEMANTIC LAYER ─────────────────

// A declared relationship is not a pipeline feature: MetricFlow joins on the very same key, so
// events measures are sliced by the ACQUISITION source's own attributes with no join stage at
// all. 184 events in total; the 34 that fall on a day with no spend land in the NULL bucket.
test('events measures group by an acquisition attribute over the declared (player, day) key', opts, async (t) => {
  if (skip(t)) return;
  const out = await engine.create_semantic_model({
    name: 'evspend',
    use_base_models: ['acquisition'],
    semantic_models: [{ from: 'events', measures: [{ name: 'evts', agg: 'count', field: '*' }] }],
    metrics: [{ name: 'evts', type: 'simple', measure: { name: 'evts' } }],
  });
  assert.equal(out.parse.ok, true, JSON.stringify(out.parse));
  const r = await engine.query_semantic_model({ context_id: out.context_id, metrics: ['evspend_evts'], group_by: ['player_day__media_source'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const by = mapCol(r.rows, groupCol(r, 'evspend_evts'), 'evspend_evts');
  assert.equal(by.meta, 47);
  assert.equal(by.organic, 50);
  assert.equal(by.applovin, 30);
  assert.equal(by.google, 23);
  assert.equal(by.null, 34, 'events on a day the player had no spend row');
  assert.equal(sumCol(r.rows, 'evspend_evts'), 184, 'every event is accounted for exactly once — the join did not fan out');
});

// The composite install key in the semantic layer, against the player key on the SAME measure:
// u7's crash reports a track that is on no install record, so it is unattributed (NULL) under
// the install key while the player key still files it under GB. Same data, two declared keys.
test('crash measures by the install key vs the player key: the stale track is unattributed', opts, async (t) => {
  if (skip(t)) return;
  const out = await engine.create_semantic_model({
    name: 'crgeo',
    use_base_models: ['users'],
    semantic_models: [{ from: 'crashlytics', measures: [{ name: 'crashes', agg: 'count', field: '*' }] }],
    metrics: [{ name: 'crashes', type: 'simple', measure: { name: 'crashes' } }],
  });
  assert.equal(out.parse.ok, true, JSON.stringify(out.parse));
  const run = async (path) => {
    const r = await engine.query_semantic_model({ context_id: out.context_id, metrics: ['crgeo_crashes'], group_by: [path] });
    assert.equal(r.ok, true, JSON.stringify(r.error));
    return mapCol(r.rows, groupCol(r, 'crgeo_crashes'), 'crgeo_crashes');
  };
  const byInstall = await run('tracked_install__country');
  const byPlayer = await run('user__country');
  assert.equal(byInstall.US, 8);
  assert.equal(byInstall.GB, 1, 'u7\'s crash carries a track no install record has');
  assert.equal(byInstall.null, 1, '…so it is unattributed under the install key');
  assert.equal(byPlayer.GB, 2, 'the player key still attributes it');
  assert.equal(byPlayer.null, undefined, 'nothing is unattributed by player');
  assert.equal(sumCol(Object.entries(byInstall).map(([, v]) => ({ v })), 'v'), 13);
});

// The install record's OWN measures sliced by acquisition attributes — installs reaching the
// acquisition source in the semantic layer, on the install day. 12 installs, 3 paid channels
// plus organic.
test('install measures group by an acquisition attribute over the install-day key', opts, async (t) => {
  if (skip(t)) return;
  const out = await engine.create_semantic_model({
    name: 'insp',
    use_base_models: ['users', 'acquisition'],
    semantic_models: [{ from: 'users', measures: [{ name: 'installs', agg: 'count', field: '*' }] }],
    metrics: [{ name: 'installs', type: 'simple', measure: { name: 'installs' } }],
  });
  assert.equal(out.parse.ok, true, JSON.stringify(out.parse));
  const r = await engine.query_semantic_model({ context_id: out.context_id, metrics: ['insp_installs'], group_by: ['player_day__media_source'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const by = mapCol(r.rows, groupCol(r, 'insp_installs'), 'insp_installs');
  assert.equal(by.meta, 3, JSON.stringify(by));
  assert.equal(by.organic, 4);
  assert.equal(by.google, 2);
  assert.equal(by.applovin, 3);
  assert.equal(sumCol(r.rows, 'insp_installs'), 12, 'each install matched exactly one spend row');
});

// ───────────────── 7. DISCOVERY + GUARDS (input validation) ─────────────────

// The relationships are discoverable, so a caller names one instead of guessing columns.
test('semantic_index({ model }) lists the declared relationships and their key columns', opts, async (t) => {
  if (skip(t)) return;
  const ev = await engine.semantic_index({ model: 'events' });
  const rels = Object.fromEntries(ev.relationships.map((r) => [r.entity, r]));
  assert.deepEqual(rels.player_day.key, ['player_id_of_internal', 'device_time (by day)']);
  assert.equal(rels.player_day.joins, 'acquisition');
  assert.deepEqual(rels.tracked_install.key, ['tracking_id', 'player_id_of_internal']);
  assert.equal(rels.tracked_install.joins, 'users');
  const acq = await engine.semantic_index({ model: 'acquisition' });
  const owned = acq.relationships.find((r) => r.entity === 'player_day');
  assert.equal(owned.owned_here, true, 'the acquisition source OWNS the (player, day) key');
  assert.deepEqual(owned.key, ['player_id_of_internal', 'spend_date (by day)']);
});

test('join guards: an undeclared relationship, a self-join and via+on are all rejected', opts, async (t) => {
  if (skip(t)) return;
  const step = async (source, stage) => {
    const s = await engine.build_native_model({ action: 'start', name: `gd_${seq++}`, source });
    return engine.build_native_model({ action: 'add_step', draft_id: s.draft_id, stage });
  };
  // an entity one side does not declare — the error names what the two DO share
  await assert.rejects(() => step('events', { stage: 'join', with: 'experiments', via: 'player_day' }),
    /declares no such relationship.*share: user/s);
  await assert.rejects(() => step('events', { stage: 'join', with: 'events', via: 'user' }), /own source/);
  await assert.rejects(() => step('events', { stage: 'join', with: 'users', via: 'user', on: ['player_id_of_internal'] }), /not both/);
});
