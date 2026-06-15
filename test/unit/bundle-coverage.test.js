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
function engine() {
  const catalog = loadCatalog(CATALOG, {});
  return new Engine({ catalog, contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'bndl-')) }) });
}

// The fixture catalog marks bundle_id as the app dimension (meta.mcp.dimension:{bundle:true}).
test('catalog exposes the bundle/app column', () => {
  assert.equal(loadCatalog(CATALOG, {}).bundleColumn(), 'bundle_id');
});

// Seed REAL per-app coverage into the value index, then assert the { bundle } view splits
// properties into populated vs empty for the chosen app (so the AI skips the empty ones).
// Two apps: 'com.omg.words' populates ad_type; 'com.omg.relax' leaves it empty but has level_id.
test('semantic_index({ bundle }) splits populated vs empty properties per app', async () => {
  const e = engine();
  // ad_type_of_event_data: populated for words (40/1000), EMPTY for relax (0/500).
  e.valueIndex.upsertProperty('ad_type_of_event_data', {
    distinctCount: 3, totalCount: 40, nullCount: 1460, values: [{ value: 'rewarded', freq: 30 }],
    bundleCoverage: [{ bundle: 'com.omg.words', rowCount: 1000, nonNull: 40 }, { bundle: 'com.omg.relax', rowCount: 500, nonNull: 0 }],
  });
  // level_id_of_event_data: populated for BOTH apps.
  e.valueIndex.upsertProperty('level_id_of_event_data', {
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
  e.valueIndex.upsertProperty('ad_type_of_event_data', {
    distinctCount: 3, totalCount: 40, nullCount: 1460, values: [{ value: 'rewarded', freq: 30 }],
    bundleCoverage: [{ bundle: 'com.omg.words', rowCount: 1000, nonNull: 40 }, { bundle: 'com.omg.relax', rowCount: 500, nonNull: 0 }],
  });
  const prop = await e.semantic_index({ property: 'ad_type_of_event_data' });
  assert.ok(Array.isArray(prop.bundle_coverage), 'property view carries bundle_coverage');
  const relax = prop.bundle_coverage.find((b) => b.bundle === 'com.omg.relax');
  assert.equal(relax.non_null, 0, 'empty for relax');
  assert.ok(prop.recommendations.some((r) => /EMPTY .*com\.omg\.relax/i.test(r)), 'flags the app it is empty for');
});

// { bundle } is a mutually-exclusive view + a guard when no app dimension is configured.
test('semantic_index({ bundle }) view contract', async () => {
  const e = engine();
  await assert.rejects(() => e.semantic_index({ bundle: 'x', property: 'ad_type_of_event_data' }), /at most ONE view/);
  // before any indexing, asking for a bundle returns the "not indexed yet" note (no apps).
  const none = await e.semantic_index({ bundle: 'whatever' });
  assert.ok(none.note && Array.isArray(none.bundles) && none.bundles.length === 0);
});
