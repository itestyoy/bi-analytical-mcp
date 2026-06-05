// The background value index populates REAL event-property values (top values by
// frequency + cardinality) from the warehouse, surfaced in describe_catalog.
// DATA-ONLY: we await indexer.refresh() directly (no timers) and assert on the
// VALUES/COUNTS read from the seeded fact (per fixtures/SEED_DATA.md) — never on
// any generated SQL string.

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
import { ValueIndex, BackgroundIndexer } from '../../src/value-index.js';
import { startPglite } from './pglite-harness.js';

const execFileP = promisify(execFile);
const BASE = join(process.cwd(), 'test', 'integration', 'fixtures', 'dbt_project');
const DBT_BIN = process.env.DBT_BIN || join(process.cwd(), '.dbtvenv', 'bin', 'dbt');
const MF_BIN = process.env.MF_BIN || join(process.cwd(), '.dbtvenv', 'bin', 'mf');
const PY_BIN = process.env.PYTHON_BIN || join(process.cwd(), '.dbtvenv', 'bin', 'python');
const HAS_DBT = existsSync(DBT_BIN) && existsSync(MF_BIN);
const opts = { timeout: 300000 };

let pg; let engine; let backend; let index; let indexer;
const skip = (t) => { if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; } return false; };
const valOf = (arr, v) => arr.find((x) => x.value === v);

before(async () => {
  if (!HAS_DBT) return;
  pg = await startPglite();
  process.env.DBT_PG_PORT = String(pg.port);
  const env = { ...process.env, DBT_PROFILES_DIR: BASE, DBT_PROJECT_DIR: BASE, DBT_PG_PORT: String(pg.port) };
  await execFileP(DBT_BIN, ['seed'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  await execFileP(DBT_BIN, ['run'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: mkdtempSync(join(tmpdir(), 'vi-')), timeSpineDialect: 'postgres' });
  backend = new MfEngineBackend({ pythonBin: PY_BIN, dbtBin: DBT_BIN, profilesDir: BASE });
  const catalog = loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), { profilesDir: BASE, projectDir: BASE });
  // A temp-file value index so the index is real SQLite (not just the engine's default).
  const dbPath = join(mkdtempSync(join(tmpdir(), 'vi-db-')), 'value-index.sqlite');
  engine = new Engine({ catalog, contextManager: ctxs, runner: backend, valueIndexDbPath: dbPath });
  index = engine.valueIndex;
  indexer = new BackgroundIndexer({ catalog, runner: backend, index, baseProjectDir: BASE, intervalMs: 0, maxValues: 50, logger: () => {} });
  // Await directly — do NOT rely on timers; we want the index populated before asserting.
  await indexer.refresh();
}, opts);

after(async () => { backend?.close(); index?.close(); if (pg) await pg.stop(); });

// Verify the EXACT property names against the fixture catalog via describe_catalog.
test('exact property names: ad_finished + level_completed carry the *_of_event_data props', opts, async (t) => {
  if (skip(t)) return;
  const ad = await engine.describe_catalog({ event: 'ad_finished' });
  assert.ok(ad.properties.some((p) => p.name === 'ad_type_of_event_data'), 'ad_finished carries ad_type_of_event_data');
  const lvl = await engine.describe_catalog({ event: 'level_completed' });
  assert.ok(lvl.properties.some((p) => p.name === 'result_of_event_data'), 'level_completed carries result_of_event_data');
});

// ad_type over the whole fact (ad_started + ad_finished): rewarded 10 / interstitial 8 / banner 6,
// distinct = 3, total = 24 (SEED_DATA: 12 ad_started + 12 ad_finished).
test('ad_type_of_event_data indexes the real value SET with seed frequencies', opts, async (t) => {
  if (skip(t)) return;
  const vals = index.sampleValues('ad_type_of_event_data');
  assert.deepEqual(new Set(vals.map((v) => v.value)), new Set(['rewarded', 'interstitial', 'banner']));
  assert.equal(valOf(vals, 'rewarded').freq, 10);
  assert.equal(valOf(vals, 'interstitial').freq, 8);
  assert.equal(valOf(vals, 'banner').freq, 6);
  // ordered by freq desc
  assert.deepEqual(vals.map((v) => v.value), ['rewarded', 'interstitial', 'banner']);
  const st = index.stats('ad_type_of_event_data');
  assert.equal(st.distinctCount, 3);
  assert.equal(st.totalCount, 24);
});

// result over the whole fact (only level_completed carries it): win 20 / lose 5, distinct = 2.
test('result_of_event_data indexes win/lose with the seed counts (20 wins / 5 losses)', opts, async (t) => {
  if (skip(t)) return;
  const vals = index.sampleValues('result_of_event_data');
  assert.deepEqual(new Set(vals.map((v) => v.value)), new Set(['win', 'lose']));
  assert.equal(valOf(vals, 'win').freq, 20);
  assert.equal(valOf(vals, 'lose').freq, 5);
  const st = index.stats('result_of_event_data');
  assert.equal(st.distinctCount, 2);
  assert.equal(st.totalCount, 25); // 25 level_completed rows
});

// describe_catalog({ property }) surfaces sample_values + distinct/total + indexed.
test('describe_catalog({ property }) returns sample_values + counts matching the index', opts, async (t) => {
  if (skip(t)) return;
  const out = await engine.describe_catalog({ property: 'ad_type_of_event_data' });
  assert.equal(out.indexed, true);
  assert.equal(out.distinct_count, 3);
  assert.equal(out.total_count, 24);
  assert.deepEqual(new Set(out.sample_values.map((v) => v.value)), new Set(['rewarded', 'interstitial', 'banner']));
  assert.equal(valOf(out.sample_values, 'rewarded').freq, 10);
  // descriptive stats: most-frequent value + its share of the 24 indexed rows.
  assert.equal(out.value_stats.distinct_count, 3);
  assert.equal(out.value_stats.total_count, 24);
  assert.equal(out.value_stats.top_value, 'rewarded');
  assert.equal(out.value_stats.top_freq, 10);
  assert.equal(out.value_stats.top_share, Math.round((10 / 24) * 1000) / 1000); // ~0.417
});

// describe_catalog({ property }) value listing is pageable + orderable (limit/offset/order_by/direction).
test('describe_catalog({ property }) pages + orders the indexed values', opts, async (t) => {
  if (skip(t)) return;
  // freq desc, top 1 → 'rewarded' (10); next page → 'interstitial' (8).
  const p1 = await engine.describe_catalog({ property: 'ad_type_of_event_data', limit: 1 });
  assert.deepEqual(p1.sample_values.map((v) => v.value), ['rewarded']);
  assert.equal(p1.value_stats.has_more, true);
  const p2 = await engine.describe_catalog({ property: 'ad_type_of_event_data', limit: 1, offset: 1 });
  assert.deepEqual(p2.sample_values.map((v) => v.value), ['interstitial']);
  // order_by value asc → alphabetical.
  const alpha = await engine.describe_catalog({ property: 'ad_type_of_event_data', order_by: 'value' });
  assert.deepEqual(alpha.sample_values.map((v) => v.value), ['banner', 'interstitial', 'rewarded']);
  assert.equal(alpha.value_stats.order_by, 'value');
  assert.equal(alpha.value_stats.has_more, false);
  // freq asc → least common first.
  const asc = await engine.describe_catalog({ property: 'ad_type_of_event_data', order_by: 'freq', direction: 'asc' });
  assert.deepEqual(asc.sample_values.map((v) => v.value), ['banner', 'interstitial', 'rewarded']);
  // has_more must be FALSE when the page covers all values (limit == distinct_count),
  // and TRUE only when a non-empty next page exists (no false positive at the boundary).
  const exact = await engine.describe_catalog({ property: 'ad_type_of_event_data', limit: 3 });
  assert.equal(exact.value_stats.returned, 3);
  assert.equal(exact.value_stats.has_more, false);
  const boundary = await engine.describe_catalog({ property: 'ad_type_of_event_data', limit: 2 });
  assert.equal(boundary.value_stats.has_more, true); // a 3rd value exists
});

// describe_catalog({ event }) adds a COMPACT distinct_count + top-3 sample_values per property.
test('describe_catalog({ event }) carries compact index hints per property', opts, async (t) => {
  if (skip(t)) return;
  const out = await engine.describe_catalog({ event: 'ad_finished' });
  const p = out.properties.find((x) => x.name === 'ad_type_of_event_data');
  assert.equal(p.distinct_count, 3);
  assert.ok(p.sample_values.length <= 3, 'event view keeps sample_values compact (top 3)');
  assert.ok(p.sample_values.some((v) => v.value === 'rewarded'));
});

// describe_catalog({ search }) ALSO searches VALUES: "rewarded" surfaces ad_type,
// says WHERE it lives (the event(s) carrying the property), and recommends next moves.
test('describe_catalog({ search: "rewarded" }) returns a value_match with provenance + recommendations', opts, async (t) => {
  if (skip(t)) return;
  const out = await engine.describe_catalog({ search: 'rewarded' });
  assert.ok(Array.isArray(out.value_matches), 'value_matches present');
  const hit = out.value_matches.find((m) => m.value === 'rewarded' && m.property === 'ad_type_of_event_data');
  assert.ok(hit, `expected a rewarded value_match on ad_type; got ${JSON.stringify(out.value_matches)}`);
  assert.equal(hit.freq, 10);
  // provenance: the value resolves to the event(s) that carry its property (real catalog mapping).
  assert.ok(Array.isArray(hit.events) && hit.events.includes('ad_finished'), `value_match should name the carrying event(s); got ${JSON.stringify(hit.events)}`);
  // next-step guidance for the AI (presence + actionability, not exact wording).
  assert.ok(Array.isArray(out.recommendations) && out.recommendations.length > 0 && out.recommendations.every((r) => typeof r === 'string' && r.length), 'search returns actionable recommendations');
});

// Both drill-downs guide the AI's next exploration step.
test('describe_catalog({ property }) returns non-empty recommendations', opts, async (t) => {
  if (skip(t)) return;
  const out = await engine.describe_catalog({ property: 'ad_type_of_event_data' });
  assert.ok(Array.isArray(out.recommendations) && out.recommendations.length > 0 && out.recommendations.every((r) => typeof r === 'string' && r.length), 'property view recommends a concrete next move');
});

// describe_index reports the value-index SYNC state after the real refresh in `before`.
test('describe_index reports the value-index sync state + jobs', opts, async (t) => {
  if (skip(t)) return;
  const out = await engine.describe_index();
  const vi = out.value_index;
  assert.equal(vi.persisted, true, 'real SQLite-backed index');
  assert.equal(vi.running, false, 'the awaited refresh has finished');
  assert.ok(vi.total_runs >= 1, 'at least the one refresh from before() is logged');
  assert.ok(vi.indexed_properties > 0, 'properties were indexed');
  assert.ok(vi.total_values > 0, 'values were stored');
  assert.equal(vi.last_successful_run.status, 'ok', 'the refresh completed cleanly');
  assert.equal(vi.last_successful_run.errors, 0);
  assert.ok(vi.last_successful_run.properties_indexed > 0);
  assert.ok(typeof vi.seconds_since_last_sync === 'number' && vi.seconds_since_last_sync >= 0);
  // jobs section present (no background query jobs ran in this suite).
  assert.equal(typeof out.query_jobs.total, 'number');
  assert.ok(Array.isArray(out.query_jobs.running));
  assert.ok(out.recommendations.length > 0);
});
