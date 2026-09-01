// The background value index populates REAL event-property values (top values by
// frequency + cardinality) from the warehouse, surfaced in semantic_index.
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
import { loadRecipes } from '../../src/recipes.js';
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
// 10-min budget: before() awaits a FULL real indexer pass (37 targets × ~3 mf round-trips
// each ≈ several minutes); the production indexer is background/non-blocking, but the test
// awaits it synchronously to assert on populated values, so give the hook ample headroom.
const opts = { timeout: 600000 };

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
  const recipes = loadRecipes(join(process.cwd(), 'config', 'recipes.json'));
  engine = new Engine({ catalog, contextManager: ctxs, runner: backend, dbPath, recipes });
  index = engine.valueIndex;
  indexer = new BackgroundIndexer({ catalog, runner: backend, index, baseProjectDir: BASE, intervalMs: 0, maxValues: 50, logger: () => {} });
  // Await directly — do NOT rely on timers; we want the index populated before asserting.
  await indexer.refresh();
}, opts);

after(async () => { backend?.close(); index?.close(); if (pg) await pg.stop(); });

// Verify the EXACT property names against the fixture catalog via semantic_index.
test('exact property names: ad_finished + level_completed carry the *_of_event_data props', opts, async (t) => {
  if (skip(t)) return;
  const ad = await engine.semantic_index({ event: 'ad_finished' });
  assert.ok(ad.properties.some((p) => p.name === 'ad_type_of_event_data'), 'ad_finished carries ad_type_of_event_data');
  const lvl = await engine.semantic_index({ event: 'level_completed' });
  assert.ok(lvl.properties.some((p) => p.name === 'result_of_event_data'), 'level_completed carries result_of_event_data');
});

// ad_type over the whole fact (ad_started + ad_finished): rewarded 10 / interstitial 8 / banner 6,
// distinct = 3, total = 24 (SEED_DATA: 12 ad_started + 12 ad_finished).
test('ad_type_of_event_data indexes the real value SET with seed frequencies', opts, async (t) => {
  if (skip(t)) return;
  const vals = index.sampleValues('events', 'ad_type_of_event_data');
  assert.deepEqual(new Set(vals.map((v) => v.value)), new Set(['rewarded', 'interstitial', 'banner']));
  assert.equal(valOf(vals, 'rewarded').freq, 10);
  assert.equal(valOf(vals, 'interstitial').freq, 8);
  assert.equal(valOf(vals, 'banner').freq, 6);
  // ordered by freq desc
  assert.deepEqual(vals.map((v) => v.value), ['rewarded', 'interstitial', 'banner']);
  const st = index.stats('events', 'ad_type_of_event_data');
  assert.equal(st.distinctCount, 3);
  assert.equal(st.totalCount, 24);
});

// result over the whole fact (only level_completed carries it): win 20 / lose 5, distinct = 2.
test('result_of_event_data indexes win/lose with the seed counts (20 wins / 5 losses)', opts, async (t) => {
  if (skip(t)) return;
  const vals = index.sampleValues('events', 'result_of_event_data');
  assert.deepEqual(new Set(vals.map((v) => v.value)), new Set(['win', 'lose']));
  assert.equal(valOf(vals, 'win').freq, 20);
  assert.equal(valOf(vals, 'lose').freq, 5);
  const st = index.stats('events', 'result_of_event_data');
  assert.equal(st.distinctCount, 2);
  assert.equal(st.totalCount, 25); // 25 level_completed rows
});

// semantic_index({ property }) surfaces sample_values + distinct/total + indexed.
test('semantic_index({ property }) returns sample_values + counts matching the index', opts, async (t) => {
  if (skip(t)) return;
  const out = await engine.semantic_index({ property: 'ad_type_of_event_data' });
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

// Applicability (which events carry a property) is DATA-DERIVED from the scan's per-event coverage,
// NOT the declared meta.mcp.events — prove the reported `events` == the observed non-null carriers.
test('semantic_index({ property }).events is derived from per-event coverage (not a declared list)', opts, async (t) => {
  if (skip(t)) return;
  const out = await engine.semantic_index({ property: 'ad_type_of_event_data' });
  const cov = index.coverage('events', 'ad_type_of_event_data');
  const observed = cov.filter((e) => e.non_null > 0).map((e) => e.event_name).sort();
  assert.ok(observed.length > 0, 'the scan observed at least one carrier');
  assert.deepEqual([...out.events].sort(), observed, 'reported events == observed non-null carriers');
  // an event on which the field is ALWAYS null is not reported as a carrier
  for (const ev of cov.filter((e) => e.non_null === 0).map((e) => e.event_name)) {
    assert.ok(!out.events.includes(ev), `${ev} (all-NULL for this field) is not a reported carrier`);
  }
});

// COMPLEX (array/struct) properties get per-event coverage too, so their applicability is
// data-derived — they no longer leak onto EVERY event. words_selected_of_event_data is a JSON
// array carried only on level_completed in the seed.
test('complex array property gets DATA-DERIVED per-event coverage (no leak onto unrelated events)', opts, async (t) => {
  if (skip(t)) return;
  const prop = 'words_selected_of_event_data';
  assert.ok(engine.catalog.complexEventProps().includes(prop), 'precondition: it is a complex property');
  const cov = index.coverage('events', prop);
  assert.ok(cov.length > 0, 'complex prop has per-event coverage after the refresh');
  const carriers = cov.filter((e) => e.non_null > 0).map((e) => e.event_name).sort();
  assert.deepEqual(carriers, ['level_completed'], `carried only on level_completed (got ${JSON.stringify(carriers)})`);
  assert.deepEqual([...index.appliesEvents('events', prop)].sort(), carriers, 'appliesEvents == observed carriers');
  // the leak we fixed: an unrelated event must NOT list this complex prop
  const fl = await engine.semantic_index({ event: 'first_launch' });
  assert.ok(!fl.properties.some((p) => p.name === prop), 'complex prop does NOT leak onto first_launch');
  // its real carrier DOES list it
  const lc = await engine.semantic_index({ event: 'level_completed' });
  assert.ok(lc.properties.some((p) => p.name === prop), 'complex prop shown on its real carrier (level_completed)');
  // A) declared STRUCTURE + B) raw EXAMPLES are surfaced on the property view.
  const out = await engine.semantic_index({ property: prop });
  assert.equal(out.complex, true);
  assert.ok(out.fields || out.items, 'A: the array/struct shape is surfaced (fields/items) from the catalog');
  assert.equal(out.encoding, 'json', 'A: encoding surfaced');
  assert.equal(out.distinct_count, null, 'no distinct for a complex value');
  assert.ok(Array.isArray(out.sample_values) && out.sample_values.length > 0, 'B: raw example values are indexed');
  assert.ok(out.sample_values.every((s) => typeof s.value === 'string' && s.value.length <= 300), 'examples are length-capped strings');
  assert.ok(/example|shape/i.test(out.sample_note || ''), 'B: examples are labelled as shape, not frequency');
});

// semantic_index({ property }) value listing is pageable + orderable (limit/offset/order_by/direction).
test('semantic_index({ property }) pages + orders the indexed values', opts, async (t) => {
  if (skip(t)) return;
  // freq desc, top 1 → 'rewarded' (10); next page → 'interstitial' (8).
  const p1 = await engine.semantic_index({ property: 'ad_type_of_event_data', limit: 1 });
  assert.deepEqual(p1.sample_values.map((v) => v.value), ['rewarded']);
  assert.equal(p1.value_stats.has_more, true);
  const p2 = await engine.semantic_index({ property: 'ad_type_of_event_data', limit: 1, offset: 1 });
  assert.deepEqual(p2.sample_values.map((v) => v.value), ['interstitial']);
  // order_by value asc → alphabetical.
  const alpha = await engine.semantic_index({ property: 'ad_type_of_event_data', order_by: 'value' });
  assert.deepEqual(alpha.sample_values.map((v) => v.value), ['banner', 'interstitial', 'rewarded']);
  assert.equal(alpha.value_stats.order_by, 'value');
  assert.equal(alpha.value_stats.has_more, false);
  // freq asc → least common first.
  const asc = await engine.semantic_index({ property: 'ad_type_of_event_data', order_by: 'freq', direction: 'asc' });
  assert.deepEqual(asc.sample_values.map((v) => v.value), ['banner', 'interstitial', 'rewarded']);
  // has_more must be FALSE when the page covers all values (limit == distinct_count),
  // and TRUE only when a non-empty next page exists (no false positive at the boundary).
  const exact = await engine.semantic_index({ property: 'ad_type_of_event_data', limit: 3 });
  assert.equal(exact.value_stats.returned, 3);
  assert.equal(exact.value_stats.has_more, false);
  const boundary = await engine.semantic_index({ property: 'ad_type_of_event_data', limit: 2 });
  assert.equal(boundary.value_stats.has_more, true); // a 3rd value exists
});

// semantic_index({ event }) adds a COMPACT distinct_count + top-3 sample_values per property.
test('semantic_index({ event }) carries compact index hints per property', opts, async (t) => {
  if (skip(t)) return;
  const out = await engine.semantic_index({ event: 'ad_finished' });
  const p = out.properties.find((x) => x.name === 'ad_type_of_event_data');
  assert.equal(p.distinct_count, 3);
  assert.ok(p.sample_values.length <= 3, 'event view keeps sample_values compact (top 3)');
  assert.ok(p.sample_values.some((v) => v.value === 'rewarded'));
});

// semantic_index({ search }) ALSO searches VALUES: "rewarded" surfaces ad_type,
// says WHERE it lives (the event(s) carrying the property), and recommends next moves.
test('semantic_index({ search: "rewarded" }) returns a value_match with provenance + recommendations', opts, async (t) => {
  if (skip(t)) return;
  const out = await engine.semantic_index({ search: 'rewarded' });
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
test('semantic_index({ property }) returns non-empty recommendations', opts, async (t) => {
  if (skip(t)) return;
  const out = await engine.semantic_index({ property: 'ad_type_of_event_data' });
  assert.ok(Array.isArray(out.recommendations) && out.recommendations.length > 0 && out.recommendations.every((r) => typeof r === 'string' && r.length), 'property view recommends a concrete next move');
});

// semantic_index reports the value-index SYNC state after the real refresh in `before`.
test('semantic_index reports the value-index sync state + jobs', opts, async (t) => {
  if (skip(t)) return;
  const out = await engine.semantic_index({ status: true });
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

  // per-property timing drill-down: by RUN (slowest first) and by PROPERTY (history).
  const runId = vi.last_run.id;
  assert.ok(Number.isInteger(runId));
  const byRun = await engine.semantic_index({ run: runId });
  assert.equal(byRun.run.id, runId);
  assert.ok(byRun.property_count > 0, 'per-property timing recorded for the run');
  const adRow = byRun.properties.find((p) => p.property === 'ad_type_of_event_data');
  assert.ok(adRow, 'ad_type appears in the per-property breakdown');
  assert.ok(typeof adRow.ms === 'number' && adRow.ms >= 0, 'each property has a measured duration');
  assert.equal(adRow.distinct_count, 3); // matches the indexed cardinality
  // slowest-first ordering holds.
  const msList = byRun.properties.map((p) => p.ms);
  assert.deepEqual(msList, [...msList].sort((a, b) => b - a));
  // by PROPERTY: timing history for ad_type.
  const byProp = await engine.semantic_index({ property: 'ad_type_of_event_data' });
  assert.ok(byProp.indexing.runs >= 1 && byProp.indexing.history[0].run_id === runId);
  assert.equal(byProp.indexing.history[0].distinct_count, 3);
});

// semantic_index({ property }) reports null coverage from real seed counts: ad_type is
// populated ONLY on the 24 ad events; the other 160 of 184 rows are NULL. The per-event
// breakdown marks which events the property applies to, so expected NULLs (non-ad events)
// are distinguishable from real gaps (there are none here — both ad events are 100% filled).
test('semantic_index({ property }) reports null_count + per-event coverage from the seed', opts, async (t) => {
  if (skip(t)) return;
  // include_coverage:true → the FULL per-event table (incl. always-NULL events), needed to assert
  // the whole-fact partition below. (Default is carriers-only; covered by property-view-lean.test.js.)
  const out = await engine.semantic_index({ property: 'ad_type_of_event_data', include_coverage: true });
  // overall: 24 non-null of 184 rows → 160 NULL.
  assert.equal(out.value_stats.non_null_count, 24);
  assert.equal(out.value_stats.row_count, 184);
  assert.equal(out.value_stats.null_count, 160);
  assert.equal(out.value_stats.null_fraction, Math.round((160 / 184) * 10000) / 10000);
  // declared applicability comes from the catalog (meta.mcp.events).
  assert.deepEqual(new Set(out.events), new Set(['ad_started', 'ad_finished']));
  // per-event_name coverage: the two ad events are fully populated (null_count 0, applies);
  const cov = Object.fromEntries(out.event_coverage.map((e) => [e.event_name, e]));
  assert.equal(cov.ad_started.non_null, 12);
  assert.equal(cov.ad_started.null_count, 0);
  assert.equal(cov.ad_started.applies, true);
  assert.equal(cov.ad_finished.null_count, 0);
  assert.equal(cov.ad_finished.applies, true);
  // ...a non-ad event carries the field on NONE of its rows, and is flagged not-applicable.
  assert.equal(cov.first_launch.non_null, 0);
  assert.equal(cov.first_launch.null_count, 12); // 12 first_launch rows, all NULL
  assert.equal(cov.first_launch.applies, false);
  // the coverage row_counts partition the whole fact (every one of the 184 rows is accounted for).
  assert.equal(out.event_coverage.reduce((s, e) => s + e.row_count, 0), 184);
  // NO real gaps: there is no applicable event with NULLs (data quality is clean in the seed).
  assert.equal(out.event_coverage.filter((e) => e.applies && e.null_count > 0).length, 0);
});

// ── Non-anchor attribute indexing (users / experiments) — DATA from the seed ──

// users.country is indexed under its namespaced key with the SEED distribution. dim_users is
// SCD-2, so the index counts VERSIONS, not players: 13 rows for 12 players, because u1 has a US
// version and a GB one. US=4, GB=4, DE=3, BR=2, no NULLs.
test('users.country is indexed with the real seed distribution (US4/GB4/DE3/BR2 over 13 versions)', opts, async (t) => {
  if (skip(t)) return;
  const vals = index.sampleValues('users', 'country');
  assert.deepEqual(new Set(vals.map((v) => v.value)), new Set(['US', 'GB', 'DE', 'BR']));
  assert.equal(valOf(vals, 'US').freq, 4);
  assert.equal(valOf(vals, 'GB').freq, 4);
  assert.equal(valOf(vals, 'DE').freq, 3);
  assert.equal(valOf(vals, 'BR').freq, 2);
  const st = index.stats('users', 'country');
  assert.equal(st.distinctCount, 4);
  assert.equal(st.totalCount, 13);  // one row per player VERSION, none NULL
  assert.equal(st.nullCount, 0);
});

// Experiments become DISCOVERABLE: experiment names + variant groups are indexed.
test('experiments.experiment_name / variant_group are indexed (checkout_flow; control 6 / variant_b 6)', opts, async (t) => {
  if (skip(t)) return;
  const names = index.sampleValues('experiments', 'experiment_name');
  assert.deepEqual(names, [{ value: 'checkout_flow', freq: 12 }]);
  const variants = index.sampleValues('experiments', 'variant_group');
  assert.deepEqual(new Set(variants.map((v) => v.value)), new Set(['control', 'variant_b']));
  assert.equal(valOf(variants, 'control').freq, 6);
  assert.equal(valOf(variants, 'variant_b').freq, 6);
});

// semantic_index({ model: 'users' }) surfaces each dimension WITH its indexed values.
test('semantic_index({ model: "users" }) lists dimensions with sample_values + cardinality', opts, async (t) => {
  if (skip(t)) return;
  const out = await engine.semantic_index({ model: 'users' });
  const country = out.dimensions.find((d) => d.name === 'country');
  assert.equal(country.distinct_count, 4);
  assert.ok(country.sample_values.some((v) => v.value === 'US' && v.freq === 4), `US(4) in samples: ${JSON.stringify(country.sample_values)}`);
  const ms = out.dimensions.find((d) => d.name === 'media_source');
  assert.equal(ms.distinct_count, 4); // meta/organic/google/applovin
});

// semantic_index({ property: 'users.country' }) drills a namespaced attribute like a property.
test('semantic_index({ property: "users.country" }) returns the attribute value distribution', opts, async (t) => {
  if (skip(t)) return;
  const out = await engine.semantic_index({ property: 'users.country' });
  assert.equal(out.model, 'users');
  assert.equal(out.column, 'country');
  assert.equal(out.distinct_count, 4);
  assert.equal(valOf(out.sample_values, 'US').freq, 4);
  // dim_users is SCD-2 and u1 has a US version and a GB one, so US and GB are TIED at 4
  // versions each. Pin the invariant — the reported top value IS a most-frequent one —
  // rather than an arbitrary tie-break the warehouse is free to decide either way.
  assert.equal(valOf(out.sample_values, 'GB').freq, 4);
  const maxFreq = Math.max(...out.sample_values.map((v) => v.freq));
  assert.equal(valOf(out.sample_values, out.value_stats.top_value).freq, maxFreq);
  // the guidance names the JOIN path (user attributes are reached via the users join).
  assert.ok(out.recommendations.some((r) => r.includes('user__country') || r.includes("join with:'users'")), JSON.stringify(out.recommendations));
  // unknown attribute → clear error, not a silent empty result.
  await assert.rejects(() => engine.semantic_index({ source: 'users', property: 'nope' }), /is not a property or dimension of 'users'/);
});

// search now finds: attribute VALUES (a country code), dimension attributes by name,
// experiment names, and matching recipes — the full discovery loop in one call.
test('semantic_index({ search }) finds attribute values, dimensions, experiments and recipes', opts, async (t) => {
  if (skip(t)) return;
  // a known country code resolves to the users.country attribute.
  const de = await engine.semantic_index({ search: 'DE' });
  const deHit = de.value_matches.find((m) => m.source === 'users' && m.property === 'country' && m.value === 'DE');
  assert.ok(deHit, `expected users.country DE value match: ${JSON.stringify(de.value_matches)}`);
  assert.equal(deHit.freq, 3);
  assert.equal(deHit.model, 'users');
  // an experiment name is discoverable by substring.
  const exp = await engine.semantic_index({ search: 'checkout' });
  assert.ok(exp.value_matches.some((m) => m.source === 'experiments' && m.property === 'experiment_name' && m.value === 'checkout_flow'), JSON.stringify(exp.value_matches));
  // a dimension attribute is discoverable by its name.
  const dim = await engine.semantic_index({ search: 'country' });
  assert.ok(dim.dimension_matches.some((d) => d.source === 'users' && d.column === 'country'), JSON.stringify(dim.dimension_matches));
  // a recipe is discoverable by task keyword.
  const ret = await engine.semantic_index({ search: 'retention' });
  assert.ok(ret.recipe_matches.some((r) => r.id === 'nday_retention'), JSON.stringify(ret.recipe_matches));
  assert.ok(ret.recommendations.some((r) => r.includes('semantic_index({ recipe')), 'search guides to the recipe view');
});

// Per-app (bundle) coverage from the REAL warehouse: the seed assigns level events to
// 'com.omg.colorfit' and everything else (incl. ad events) to 'com.omg.wordsearch', so
// ad_type is EMPTY for colorfit while level_id is EMPTY for wordsearch — the { bundle }
// view must split populated vs empty per app off the actual indexed counts.
test('semantic_index({ bundle }) splits populated vs empty event properties per app (real data)', opts, async (t) => {
  if (skip(t)) return;
  // overview lists both apps with their real event-row counts (131 wordsearch / 53 colorfit).
  const ov = await engine.semantic_index();
  const apps = Object.fromEntries((ov.bundles || []).map((b) => [b.bundle, b.event_rows]));
  assert.equal(apps['com.omg.wordsearch'], 131, JSON.stringify(ov.bundles));
  assert.equal(apps['com.omg.colorfit'], 53, JSON.stringify(ov.bundles));

  // colorfit = only level_started/level_completed → level_id populated, ad_type EMPTY.
  const colorfit = await engine.semantic_index({ bundle: 'com.omg.colorfit' });
  assert.equal(colorfit.event_rows, 53);
  assert.ok(colorfit.populated.some((p) => p.property === 'level_id_of_event_data'), 'level_id populated for colorfit');
  assert.ok(colorfit.empty.some((x) => x.source === 'events' && x.property === 'ad_type_of_event_data'), 'ad_type EMPTY for colorfit');
  assert.ok(!colorfit.populated.some((p) => p.property === 'ad_type_of_event_data'));

  // wordsearch = ad/iap/etc (no level events) → ad_type populated, level_id EMPTY.
  const words = await engine.semantic_index({ bundle: 'com.omg.wordsearch' });
  assert.ok(words.populated.some((p) => p.property === 'ad_type_of_event_data'), 'ad_type populated for wordsearch');
  assert.ok(words.empty.some((x) => x.source === 'events' && x.property === 'level_id_of_event_data'), 'level_id EMPTY for wordsearch');

  // the { property } view carries the same per-app split: by default a summary (empty_apps count),
  // and the full per-app list under include_coverage:true — ad_type is non_null=0 for colorfit.
  const adSummary = await engine.semantic_index({ property: 'ad_type_of_event_data' });
  assert.ok(adSummary.bundle_coverage_summary.empty_apps >= 1, 'summary flags the empty app(s) by default');
  const adProp = await engine.semantic_index({ property: 'ad_type_of_event_data', include_coverage: true });
  const cf = (adProp.bundle_coverage || []).find((b) => b.bundle === 'com.omg.colorfit');
  assert.equal(cf?.non_null, 0, JSON.stringify(adProp.bundle_coverage));

  // unknown app → clear error listing the known apps.
  await assert.rejects(() => engine.semantic_index({ bundle: 'com.omg.nope' }), /unknown app/);
});

// Triple (property × bundle × event) coverage from the REAL warehouse: the seed puts level
// events on com.omg.colorfit, so ad_type is NULL there while result IS present — the exact
// per-cell fill that powers the native-model "field is empty for this app+event" warning.
test('triple coverage: per (bundle × event) cell fill matches the seeded data', opts, async (t) => {
  if (skip(t)) return;
  // ad_type_of_event_data is NULL on colorfit's level_started rows (it only carries on ad_*).
  const adCell = index.cellCoverage('events', 'ad_type_of_event_data', { bundle: 'com.omg.colorfit', event: 'level_started' });
  assert.ok(adCell, 'cell exists (colorfit emits level_started)');
  assert.equal(adCell.non_null, 0, 'ad_type is empty for colorfit+level_started');
  // result_of_event_data IS populated on level_completed (which colorfit emits).
  const resCell = index.cellCoverage('events', 'result_of_event_data', { bundle: 'com.omg.colorfit', event: 'level_completed' });
  assert.ok(resCell && resCell.non_null > 0, JSON.stringify(resCell));
});

// ─────────── SECOND EVENTS FACT: the SAME mechanism, namespaced keys ───────────
// The crash source goes through the same worklist → batch scan → store path as the analytics
// source, but against ITS table, ITS event_name column and ITS time column. Everything below
// is read back from the SAME SQLite store both sources write to. SEED_DATA §10.

test('crash-fact property values land in the index with the seed frequencies', opts, async (t) => {
  if (skip(t)) return;
  const vals = index.sampleValues('crashlytics', 'issue_title_of_event_data');
  assert.deepEqual(new Set(vals.map((v) => v.value)),
    new Set(['NullPointer', 'OutOfMemory', 'NetworkTimeout', 'DecodeError', 'MainThreadBlocked']));
  assert.equal(valOf(vals, 'NullPointer').freq, 4);
  assert.equal(valOf(vals, 'OutOfMemory').freq, 2);
  assert.equal(valOf(vals, 'NetworkTimeout').freq, 3);
  assert.equal(valOf(vals, 'DecodeError').freq, 1);
  assert.equal(valOf(vals, 'MainThreadBlocked').freq, 3);
  const st = index.stats('crashlytics', 'issue_title_of_event_data');
  assert.equal(st.distinctCount, 5);
  assert.equal(st.totalCount, 13); // every crash row carries an issue title
  // the index is keyed by (source, property), so the same property name on another source is
  // a different key entirely — nothing is written into the other source's space
  assert.ok(!index.stats('events', 'issue_title_of_event_data'), "the crash fact's property is not written into the events source's space");
});

test('per-event coverage on the crash fact is keyed by ITS event names', opts, async (t) => {
  if (skip(t)) return;
  // anr_duration exists ONLY on anr (3 rows); crash_message ONLY on fatal_crash (6 rows)
  const anr = index.coverage('crashlytics', 'anr_duration_of_event_data').filter((e) => e.non_null > 0);
  assert.deepEqual(anr.map((e) => e.event_name), ['anr']);
  assert.equal(anr[0].non_null, 3);
  const msg = index.coverage('crashlytics', 'crash_message_of_event_data').filter((e) => e.non_null > 0);
  assert.deepEqual(msg.map((e) => e.event_name), ['fatal_crash']);
  assert.equal(msg[0].non_null, 6);
});

test('semantic_index({ event }) on the crash fact lists only what THAT event carries', opts, async (t) => {
  if (skip(t)) return;
  const out = await engine.semantic_index({ source: 'crashlytics', event: 'anr' });
  assert.equal(out.source, 'crashlytics');
  const names = out.properties.map((p) => p.name);
  assert.ok(names.includes('anr_duration_of_event_data'), 'anr carries its duration');
  assert.ok(!names.includes('crash_message_of_event_data'), 'a fatal-only property is not listed on anr');
});

test('semantic_index({ property }) resolves a qualified crash property', opts, async (t) => {
  if (skip(t)) return;
  const out = await engine.semantic_index({ source: 'crashlytics', property: 'issue_title_of_event_data' });
  assert.equal(out.source, 'crashlytics');
  assert.equal(out.indexed, true);
  assert.equal(out.distinct_count, 5);
  assert.equal(out.total_count, 13);
  assert.deepEqual([...out.events].sort(), ['anr', 'fatal_crash', 'non_fatal']);
  assert.equal(out.value_stats.top_value, 'NullPointer');
  assert.equal(out.value_stats.top_freq, 4);
});

test('a DIMENSION of the crash fact is indexed under its own namespaced key', opts, async (t) => {
  if (skip(t)) return;
  const vals = index.sampleValues('crashlytics', 'app_version');
  assert.equal(valOf(vals, '1.0.0').freq, 7);
  assert.equal(valOf(vals, '1.1.0').freq, 6);
  assert.equal(index.stats('crashlytics', 'app_version').totalCount, 13);
});

test('the crash fact ARRAY property gets complex coverage + example values', opts, async (t) => {
  if (skip(t)) return;
  const cov = index.coverage('crashlytics', 'breadcrumbs_of_event_data').filter((e) => e.non_null > 0);
  assert.deepEqual(cov.map((e) => e.event_name).sort(), ['anr', 'fatal_crash', 'non_fatal']);
  const by = Object.fromEntries(cov.map((e) => [e.event_name, e.non_null]));
  assert.equal(by.fatal_crash, 6);
  assert.equal(by.non_fatal, 4);
  assert.equal(by.anr, 3);
  assert.ok(index.sampleValues('crashlytics', 'breadcrumbs_of_event_data').length > 0, 'shape examples stored');
});
