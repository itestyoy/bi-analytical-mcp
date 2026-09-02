import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';

const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));
function engine(tweak) {
  const catalog = loadCatalog(CATALOG, {});
  tweak?.(catalog);
  return new Engine({ catalog, contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'bndl-')) }) });
}

// The fixture catalog marks bundle_id as the app dimension (meta.mcp.dimension:{bundle:true}).
test('catalog exposes the bundle/app column', () => {
  assert.equal(loadCatalog(CATALOG, {}).bundleColumn('events'), 'bundle_id');
});

// Seed REAL per-app coverage into the value index, then assert the { bundle } view splits
// properties into populated vs empty for the chosen app (so the AI skips the empty ones).
// Two apps: 'com.omg.words' populates ad_type; 'com.omg.relax' leaves it empty but has level_id.
test('semantic_index({ bundle }) splits populated vs empty properties per app', async () => {
  const e = engine();
  // ad_type_of_event_data: populated for words (40/1000), EMPTY for relax (0/500).
  e.valueIndex.upsertProperty('events', 'ad_type_of_event_data', {
    distinctCount: 3, totalCount: 40, nullCount: 1460, values: [{ value: 'rewarded', freq: 30 }],
    bundleCoverage: [{ bundle: 'com.omg.words', rowCount: 1000, nonNull: 40 }, { bundle: 'com.omg.relax', rowCount: 500, nonNull: 0 }],
  });
  // level_id_of_event_data: populated for BOTH apps.
  e.valueIndex.upsertProperty('events', 'level_id_of_event_data', {
    distinctCount: 10, totalCount: 900, nullCount: 600, values: [{ value: '1', freq: 100 }],
    bundleCoverage: [{ bundle: 'com.omg.words', rowCount: 1000, nonNull: 600 }, { bundle: 'com.omg.relax', rowCount: 500, nonNull: 300 }],
  });

  // overview lists both apps with their event-row counts.
  const ov = await e.semantic_index();
  assert.ok(Array.isArray(ov.bundles), 'overview lists bundles');
  const apps = Object.fromEntries(ov.bundles.map((b) => [b.bundle, b.event_rows]));
  assert.equal(apps['com.omg.words'], 1000);
  assert.equal(apps['com.omg.relax'], 500);

  // relax: ad_type is EMPTY (skip it), level_id is POPULATED.
  const relax = await e.semantic_index({ bundle: 'com.omg.relax' });
  assert.equal(relax.bundle, 'com.omg.relax');
  assert.equal(relax.event_rows, 500);
  assert.equal(relax.source, 'events', 'the app was seen in one source, so the block is that source');
  assert.ok(relax.empty.includes('ad_type_of_event_data'), 'ad_type is empty for relax');
  assert.ok(relax.populated.some((p) => p.property === 'level_id_of_event_data'), 'level_id is populated for relax');
  assert.ok(!relax.populated.some((p) => p.property === 'ad_type_of_event_data'), 'ad_type not in populated for relax');
  assert.equal(relax.empty_count + relax.populated_count, relax.property_count);

  // words: ad_type IS populated (40 non-null) → not empty here.
  const words = await e.semantic_index({ bundle: 'com.omg.words' });
  assert.ok(words.populated.some((p) => p.property === 'ad_type_of_event_data' && p.non_null === 40));
  assert.ok(!words.empty.includes('ad_type_of_event_data'));

  // an unknown app is rejected with the list of known apps.
  await assert.rejects(() => e.semantic_index({ bundle: 'com.omg.nope' }), /unknown app/);
});

// The { property } view carries the per-app split (bundle_coverage) + an empty-for-app rec.
test('semantic_index({ property }) surfaces per-app bundle_coverage', async () => {
  const e = engine();
  e.valueIndex.upsertProperty('events', 'ad_type_of_event_data', {
    distinctCount: 3, totalCount: 40, nullCount: 1460, values: [{ value: 'rewarded', freq: 30 }],
    bundleCoverage: [{ bundle: 'com.omg.words', rowCount: 1000, nonNull: 40 }, { bundle: 'com.omg.relax', rowCount: 500, nonNull: 0 }],
  });
  // DEFAULT (token-lean): ALL populated apps listed + an empty-app tally, not the full per-app list.
  const prop = await e.semantic_index({ property: 'ad_type_of_event_data' });
  assert.equal(prop.bundle_coverage, undefined, 'full per-app list (incl. empties) is NOT dumped by default');
  assert.equal(prop.bundle_coverage_summary.populated_apps, 1);
  assert.equal(prop.bundle_coverage_summary.empty_apps, 1);
  assert.ok(prop.bundle_coverage_summary.populated.some((b) => b.bundle === 'com.omg.words'), 'lists every populated app');
  assert.ok(prop.recommendations.some((r) => /Always NULL for 1 of 2 app/i.test(r)), 'flags the empty count + how to drill');
  // include_coverage:true returns the FULL per-app split (nothing lost, just on demand).
  const full = await e.semantic_index({ property: 'ad_type_of_event_data', include_coverage: true });
  assert.ok(Array.isArray(full.bundle_coverage), 'include_coverage returns the full per-app array');
  assert.equal(full.bundle_coverage.find((b) => b.bundle === 'com.omg.relax').non_null, 0, 'empty for relax');
});

// bundle is a HELPER across the other views (discoverability), not just its own view.
test('bundle is integrated as a helper across the index views', async () => {
  const e = engine();
  e.valueIndex.upsertProperty('events', 'ad_type_of_event_data', {
    distinctCount: 3, totalCount: 40, nullCount: 1460, values: [{ value: 'rewarded', freq: 30 }],
    bundleCoverage: [{ bundle: 'com.omg.words', rowCount: 1000, nonNull: 40 }, { bundle: 'com.omg.relax', rowCount: 500, nonNull: 0 }],
  });
  e.valueIndex.upsertProperty('events', 'level_id_of_event_data', {
    distinctCount: 10, totalCount: 900, nullCount: 600, values: [{ value: '1', freq: 100 }],
    bundleCoverage: [{ bundle: 'com.omg.words', rowCount: 1000, nonNull: 600 }, { bundle: 'com.omg.relax', rowCount: 500, nonNull: 300 }],
  });

  // overview: points at the { bundle } view in next_actions + recommendations.
  const ov = await e.semantic_index();
  assert.ok(ov.next_actions.some((a) => /bundle: '/.test(a.call) && /source: '/.test(a.call)), 'overview next_actions includes the bundle view, with its source');
  assert.ok(ov.recommendations.some((r) => /semantic_index\(\{ source: '[a-z_]+', bundle:/.test(r)), 'overview recommends the bundle view per source');

  // { model } (events): surfaces the app/bundle column + a pointer.
  const ev = await e.semantic_index({ model: 'events' });
  assert.equal(ev.bundle_column, 'bundle_id');
  assert.ok(/bundle/i.test(ev.bundle_note));
  assert.ok(ev.recommendations.some((r) => /source: 'events', bundle:/.test(r)), 'events model view points at ITS bundle view');

  // { event }: with >1 app, flags that a property may be empty for some apps.
  const evt = await e.semantic_index({ event: 'ad_finished' });
  assert.ok(evt.recommendations.some((r) => /bundle/.test(r)), JSON.stringify(evt.recommendations));

  // { search }: a query matching an app routes to its bundle view.
  const s = await e.semantic_index({ search: 'relax' });
  assert.ok(s.bundle_matches?.some((b) => b.bundle === 'com.omg.relax' && b.source === 'events'), JSON.stringify(s.bundle_matches));

  // { guide }: carries an IF/DO routing trigger for per-app emptiness.
  const g = await e.semantic_index({ guide: true });
  assert.ok(g.routing_triggers.some((t) => /\{ bundle:/.test(t.do) && /EMPTY/.test(t.do)), 'guide has a bundle routing trigger');
});

// { bundle } is a mutually-exclusive view + a guard when no app dimension is configured.
test('semantic_index({ bundle }) view contract', async () => {
  const e = engine();
  await assert.rejects(() => e.semantic_index({ bundle: 'x', property: 'ad_type_of_event_data' }), /at most ONE view/);
  // before any indexing, asking for a bundle returns the "not indexed yet" note (no apps).
  const none = await e.semantic_index({ bundle: 'whatever' });
  assert.ok(none.note && Array.isArray(none.bundles) && none.bundles.length === 0);
});

// COVERAGE IS PER SOURCE. The same app emits product events AND crash reports; its row count and
// its populated/empty split differ in each, so an app is a (source, bundle) pair everywhere: the
// overview lists it once per source, { bundle } answers per source and never merges, and
// { source, bundle } narrows to one.
test('the same app in two sources is two apps: nothing is merged across sources', async () => {
  // Both events sources carry the app column here (the fixture's crash source does not — a source
  // without one has no per-app coverage at all, which the named-source check below reports).
  const e = engine((cat) => { cat.getModel('crashlytics').bundle_column = 'bundle_id'; });
  e.valueIndex.upsertProperty('events', 'ad_type_of_event_data', {
    distinctCount: 3, totalCount: 40, nullCount: 960, values: [{ value: 'rewarded', freq: 30 }],
    bundleCoverage: [{ bundle: 'com.omg.words', rowCount: 1000, nonNull: 40 }],
  });
  e.valueIndex.upsertProperty('crashlytics', 'issue_title_of_event_data', {
    distinctCount: 2, totalCount: 7, nullCount: 0, values: [{ value: 'NullPointer', freq: 5 }],
    bundleCoverage: [{ bundle: 'com.omg.words', rowCount: 7, nonNull: 7 }],
  });
  e.valueIndex.upsertProperty('crashlytics', 'anr_duration_of_event_data', {
    distinctCount: 0, totalCount: 0, nullCount: 7, values: [],
    bundleCoverage: [{ bundle: 'com.omg.words', rowCount: 7, nonNull: 0 }],
  });

  // overview: one entry PER SOURCE, each with its own row count — 1000 events, 7 crash reports.
  const ov = await e.semantic_index();
  const rows = ov.bundles.filter((b) => b.bundle === 'com.omg.words');
  assert.deepEqual(rows.map((b) => [b.source, b.event_rows]).sort(), [['crashlytics', 7], ['events', 1000]]);

  // { bundle } without a source: one block per source, explicitly not merged.
  const both = await e.semantic_index({ bundle: 'com.omg.words' });
  assert.ok(Array.isArray(both.by_source) && both.by_source.length === 2, JSON.stringify(both));
  const ev = both.by_source.find((b) => b.source === 'events');
  const cr = both.by_source.find((b) => b.source === 'crashlytics');
  assert.equal(ev.event_rows, 1000); assert.equal(cr.event_rows, 7);
  assert.ok(ev.populated.some((p) => p.property === 'ad_type_of_event_data'));
  assert.ok(cr.populated.some((p) => p.property === 'issue_title_of_event_data'));
  assert.deepEqual(cr.empty, ['anr_duration_of_event_data'], 'the crash-side emptiness stays on the crash side');
  assert.ok(!ev.empty.includes('anr_duration_of_event_data'), 'and never leaks into the events block');

  // { source, bundle }: exactly one source's block, at the top level.
  const crashOnly = await e.semantic_index({ source: 'crashlytics', bundle: 'com.omg.words' });
  assert.equal(crashOnly.source, 'crashlytics');
  assert.equal(crashOnly.event_rows, 7);
  assert.equal(crashOnly.by_source, undefined);

  // a source that declares no app column is refused with the ones that do
  await assert.rejects(() => e.semantic_index({ source: 'users', bundle: 'com.omg.words' }), /not an events source/);
  // an app unknown on the named source is refused naming the source
  await assert.rejects(() => e.semantic_index({ source: 'crashlytics', bundle: 'com.omg.relax' }), /unknown app 'com.omg.relax' on source 'crashlytics'/);

  // { search } routes to the app PER SOURCE
  const s = await e.semantic_index({ search: 'words' });
  assert.deepEqual(s.bundle_matches.map((b) => b.source).sort(), ['crashlytics', 'events']);
});

test('naming a source that declares no app column is refused, listing the ones that do', async () => {
  const e = engine();
  await assert.rejects(() => e.semantic_index({ source: 'crashlytics', bundle: 'com.omg.words' }),
    /source 'crashlytics' declares no app\/bundle column .* Sources with one: events/);
});
