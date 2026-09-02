import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog, groundCatalogToPhysical } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';

// Catalog grounding: a field the dbt schema DECLARES but the physical table LACKS must
// not appear ANYWHERE — not in pipeline columns, not in event properties, not in the tool
// schemas (enums), not in semantic_index. We prove it by grounding a fixture catalog
// against a stub physical column set, then asserting absence across every surface.
const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));

// Physical columns the (stub) warehouse reports for each model — deliberately OMITTING
// 'complete_time_of_event_data' (an events payload property) and 'region' (a users dim),
// both of which the fixture catalog declares.
function physicalSets(catalog) {
  const omit = new Set(['complete_time_of_event_data', 'region']);
  const phys = {};
  for (const key of catalog.modelKeys()) {
    const names = catalog.modelColumns(key).map((c) => c.name).filter((n) => !omit.has(n));
    // role columns / event_data live outside modelColumns for the anchor — add them back.
    const m = catalog.getModel(key);
    if (catalog.isFact(key)) { names.push(m.event_name?.column, m.time?.column, m.event_data_column); for (const e of Object.values(m.entities || {})) names.push(e.column); }
    phys[key] = new Set(names.filter(Boolean).map((n) => n.toLowerCase()));
  }
  return phys;
}

function groundedEngine() {
  const catalog = loadCatalog(CATALOG, {});
  catalog.groundToPhysical(physicalSets(catalog));
  return new Engine({ catalog, contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'grnd-')) }) });
}

test('groundToPhysical prunes a phantom event property from the catalog accessors', () => {
  const catalog = loadCatalog(CATALOG, {});
  assert.ok(catalog.scalarEventProps('events').includes('complete_time_of_event_data'), 'declared before grounding');
  const { pruned } = catalog.groundToPhysical(physicalSets(catalog));
  assert.ok(pruned.events.includes('complete_time_of_event_data'), 'reported as pruned');
  // gone from EVERY catalog accessor that feeds tools/schemas/index.
  assert.ok(!catalog.scalarEventProps('events').includes('complete_time_of_event_data'));
  assert.ok(!catalog.eventProps('events').includes('complete_time_of_event_data'));
  assert.ok(!catalog.modelColumns('events').some((c) => c.name === 'complete_time_of_event_data'));
  // a physically-present property is untouched.
  assert.ok(catalog.scalarEventProps('events').includes('ad_type_of_event_data'));
});

test('grounded catalog: phantom field is absent from the tool SCHEMAS (enums)', () => {
  const e = groundedEngine();
  // create_semantic_model dimension/measure enums are projected from scalarEventProps.
  const schemaStr = JSON.stringify(e.schemas.create_semantic_model);
  assert.ok(!schemaStr.includes('complete_time_of_event_data'), 'pruned property not selectable in any enum');
  assert.ok(schemaStr.includes('ad_type_of_event_data'), 'a real property is still selectable');
});

test('grounded catalog: phantom field is absent from semantic_index everywhere', async () => {
  const e = groundedEngine();
  // { event } — the property list for an event that declared it.
  const ev = await e.semantic_index({ event: 'level_completed' });
  assert.ok(!ev.properties.some((p) => p.name === 'complete_time_of_event_data'));
  // { property } — drilling the pruned field is an unknown-property error, not a page.
  await assert.rejects(() => e.semantic_index({ property: 'complete_time_of_event_data' }), /unknown property/);
  // { search } — searching its exact name returns no property match for it.
  const s = await e.semantic_index({ search: 'complete_time_of_event_data', fuzzy: false });
  assert.ok(!s.property_matches.some((p) => p.property === 'complete_time_of_event_data'));
  // a pruned USERS dimension is gone from the model view + group-by surface.
  const um = await e.semantic_index({ model: 'users' });
  assert.ok(!um.dimensions.some((d) => d.name === 'region'));
  assert.ok(!e.catalog.modelDimensionColumns('users').includes('region'));
});

test('groundToPhysical leaves models with no physical info untouched (best-effort)', () => {
  const catalog = loadCatalog(CATALOG, {});
  const before = catalog.scalarEventProps('events').length;
  catalog.groundToPhysical({}); // nothing known → prune nothing
  assert.equal(catalog.scalarEventProps('events').length, before);
});

test('groundCatalogToPhysical introspects via the runner and prunes', async () => {
  const catalog = loadCatalog(CATALOG, {});
  const phys = physicalSets(catalog);
  // Stub runner: relationColumns returns the physical set per model (minus the omitted).
  const runner = { relationColumns: async (_dir, model) => {
    const key = catalog.modelKeys().find((k) => catalog.getModel(k).dbt_model === model);
    return { ok: true, columns: [...(phys[key] || [])].map((name) => ({ name })) };
  } };
  const { pruned } = await groundCatalogToPhysical(catalog, runner, '/tmp/x');
  assert.ok(pruned.events.includes('complete_time_of_event_data'));
  assert.ok(!catalog.scalarEventProps('events').includes('complete_time_of_event_data'));
  // no runner → no-op.
  const c2 = loadCatalog(CATALOG, {});
  const r2 = await groundCatalogToPhysical(c2, null, '/tmp/x');
  assert.deepEqual(r2.pruned, {});
});

// A declaration the table does not back is not offered: an amount or governed measure whose
// column is missing, and a time axis whose column is missing (it would otherwise become an
// agg_time_dimension dbt rejects). Only the models present in the physical map are touched.
test('grounding prunes amounts, governed measures and the time axis with their columns', () => {
  const catalog = loadCatalog(CATALOG, {});
  const acq = catalog.getModel('acquisition');
  assert.ok(catalog.aggregatableFields('acquisition').some((a) => a.name === 'clicks'), 'declared before grounding');
  assert.ok(acq.measures.total_spend, 'governed measure declared');
  assert.equal(acq.time.column, 'spend_date');
  // the physical table lacks cost, clicks and spend_date
  const phys = new Map([['acquisition', new Set(['acquisition_id', 'player_id_of_internal', 'impressions', 'media_source', 'campaign', 'campaign_id', 'ingest_batch_id'])]]);
  const { pruned } = catalog.groundToPhysical(phys);
  assert.ok(!catalog.aggregatableFields('acquisition').some((a) => a.name === 'clicks'), 'clicks (missing) is no longer an amount');
  assert.ok(!catalog.aggregatableFields('acquisition').some((a) => a.name === 'cost'), 'cost (missing) is no longer an amount');
  assert.equal(catalog.getModel('acquisition').measures?.total_spend, undefined, 'the governed measure whose expr IS the missing column is gone');
  assert.ok(catalog.aggregatableFields('acquisition').some((a) => a.name === 'cost_per_click'), 'a real expression cannot be checked and is kept');
  assert.equal(catalog.getModel('acquisition').time, undefined, 'the time axis over the missing column is gone');
  assert.ok(pruned.acquisition.includes('amount:clicks') && pruned.acquisition.includes('measure:total_spend') && pruned.acquisition.includes('(time axis)'), JSON.stringify(pruned));
  // the impressions amount, whose column IS there, stays
  assert.ok(catalog.aggregatableFields('acquisition').some((a) => a.name === 'impressions'));
});
