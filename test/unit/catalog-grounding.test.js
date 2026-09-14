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
  const ev = await e.semantic_index({ source: 'events', event: 'level_completed' });
  assert.ok(!ev.properties.some((p) => p.name === 'complete_time_of_event_data'));
  // { property } — drilling the pruned field is an unknown-property error, not a page.
  // the pruned column is not in the view's vocabulary at all — the schema, not a check
  await assert.rejects(() => e.semantic_index({ property: 'complete_time_of_event_data' }), /must be one of:|unexpected property/);
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

// ── STRUCTURAL columns: a missing one makes the model UNAVAILABLE (not silently degraded) ──
// The event name, the event time axis, the payload blob that properties are read from, and the
// identity key are what the machinery of a model rests on. Without one of them there is no useful
// degraded model, so grounding excludes the model with the reason — the same posture as refusing a
// contradictory declaration at load — while every ORDINARY column still just drops on its own.

/** Physical sets with `omit` removed from ONE model (all other models complete). */
function physWithout(catalog, model, omit) {
  const phys = physicalSets(catalog);
  phys[model] = new Set([...phys[model]].filter((n) => !omit.includes(n)));
  return phys;
}

test('grounding: an events source without its event_name column is UNAVAILABLE, not half-working', () => {
  const catalog = loadCatalog(CATALOG, {});
  const { pruned, unavailable } = catalog.groundToPhysical(physWithout(catalog, 'crashlytics', ['event_name']));
  assert.ok(unavailable.crashlytics, 'crashlytics must be reported unavailable');
  assert.match(unavailable.crashlytics.reason, /event_name/);
  assert.match(unavailable.crashlytics.reason, /is_event_name/);
  assert.deepEqual(unavailable.crashlytics.missing, ['event_name']);
  assert.equal(unavailable.crashlytics.role, 'crashlytics');
  // gone from every surface the tools derive from
  assert.ok(!catalog.modelKeys().includes('crashlytics'));
  assert.ok(!catalog.facts.includes('crashlytics'));
  assert.ok(!('crashlytics' in pruned), 'an unavailable model is not also listed as pruned');
  assert.deepEqual(catalog.unavailableModels().crashlytics.missing, ['event_name']);
  // the other events source is untouched
  assert.ok(catalog.facts.includes('events'));
  assert.ok(catalog.eventNames('events').length > 0);
  // the "unknown model" path names the reason instead of pretending the model never existed
  assert.throws(() => catalog.getModel('crashlytics'), /UNAVAILABLE.*event_name/);
});

test('grounding: an events source without its time column is UNAVAILABLE (no TypeError on render)', async () => {
  const catalog = loadCatalog(CATALOG, {});
  const { unavailable } = catalog.groundToPhysical(physWithout(catalog, 'crashlytics', ['event_time']));
  assert.match(unavailable.crashlytics.reason, /event_time/);
  assert.match(unavailable.crashlytics.reason, /is_time/);
  assert.ok(!catalog.modelKeys().includes('crashlytics'));
  // rendering the remaining catalog never touches the excluded model
  const { renderBaseModel } = await import('../../src/yaml-render.js');
  for (const k of catalog.modelKeys().filter((k) => catalog.isFact(k) || catalog.primaryEntityName(k))) assert.ok(renderBaseModel(catalog, k));
});

test('grounding: the payload blob is structural ONLY while properties are read from it', () => {
  // The fixture reads `words_collected` / `rewards` from the events blob → structural.
  let catalog = loadCatalog(CATALOG, {});
  const blob = catalog.getModel('events').event_data_column;
  assert.ok(blob, 'fixture events source must declare an event_data column');
  let r = catalog.groundToPhysical(physWithout(catalog, 'events', [blob]));
  assert.ok(r.unavailable.events, 'events must be unavailable when its blob (with properties in it) is missing');
  assert.match(r.unavailable.events.reason, /is_event_data/);
  assert.match(r.unavailable.events.reason, /words_collected|rewards/);
  // crashlytics declares no blob-only properties: a missing blob column is an ORDINARY drop there.
  catalog = loadCatalog(CATALOG, {});
  const cblob = catalog.getModel('crashlytics').event_data_column;
  const inBlob = Object.values(catalog.getModel('crashlytics').properties || {}).filter((p) => !p.column);
  if (cblob && !inBlob.length) {
    r = catalog.groundToPhysical(physWithout(catalog, 'crashlytics', [cblob]));
    assert.ok(!r.unavailable.crashlytics);
    assert.ok(catalog.facts.includes('crashlytics'));
    assert.equal(catalog.getModel('crashlytics').event_data_column, undefined);
    assert.ok(r.pruned.crashlytics.includes('(event_data column)'));
  }
});

test('grounding: a model without its identity key column is UNAVAILABLE and stops being a join target', () => {
  const catalog = loadCatalog(CATALOG, {});
  const keyCol = catalog.getModel('users').primary_entity.key[0].column;
  // before: facts point at users through `user`
  assert.equal(catalog.joinTargetFor('user'), 'users');
  assert.ok(catalog.entitiesOf('events').user, 'fixture events must declare the user relationship');
  const { pruned, unavailable } = catalog.groundToPhysical(physWithout(catalog, 'users', [keyCol]));
  assert.match(unavailable.users.reason, new RegExp(`${keyCol}.*primary entity 'user'`));
  assert.ok(!catalog.modelKeys().includes('users'));
  // the relationship that pointed at the vanished owner is gone from every remaining model, with the reason
  assert.equal(catalog.joinTargetFor('user'), undefined);
  for (const k of catalog.modelKeys()) {
    assert.ok(!catalog.entitiesOf(k).user, `${k} must no longer offer the 'user' relationship`);
  }
  assert.ok(pruned.events.some((x) => /entity:user \(owner 'users' unavailable\)/.test(x)), JSON.stringify(pruned.events));
  // nothing reachable through users any more
  assert.ok(!catalog.reachableAttributes().some((a) => a.model === 'users'));
});

test('grounding: a table that cannot be introspected makes its model UNAVAILABLE (relation not found)', async () => {
  const catalog = loadCatalog(CATALOG, {});
  const full = physicalSets(catalog);
  const runner = { relationColumns: async (_dir, model) => {
    const key = catalog.modelKeys().find((k) => catalog.getModel(k).dbt_model === model);
    if (key === 'experiments') return { ok: false, stderr: 'Database Error\n  relation "fct_experiment_assignments" does not exist' };
    return { ok: true, columns: [...full[key]].map((name) => ({ name })) };
  } };
  const { unavailable } = await groundCatalogToPhysical(catalog, runner, '/tmp/x');
  assert.ok(unavailable.experiments);
  assert.match(unavailable.experiments.reason, /cannot be introspected/);
  assert.match(unavailable.experiments.reason, /does not exist/);
  assert.ok(!catalog.modelKeys().includes('experiments'));
  assert.ok(catalog.modelKeys().includes('events') && catalog.modelKeys().includes('users'));
});

test('grounding: losing EVERY events source is a load failure, not a silent empty catalog', () => {
  const catalog = loadCatalog(CATALOG, {});
  const phys = physicalSets(catalog);
  for (const f of catalog.facts) phys[f] = new Set([...phys[f]].filter((n) => n !== catalog.getModel(f).event_name.column));
  assert.throws(() => catalog.groundToPhysical(phys), /no events source is available.*event_name/);
});

test('grounding: ordinary columns still drop one by one — the model stays available', () => {
  const catalog = loadCatalog(CATALOG, {});
  const bundle = catalog.bundleColumn('events');
  const { pruned, unavailable } = catalog.groundToPhysical(physWithout(catalog, 'events', [bundle, 'complete_time_of_event_data']));
  assert.deepEqual(unavailable, {});
  assert.ok(catalog.facts.includes('events'));
  assert.equal(catalog.bundleColumn('events'), null);
  assert.ok(pruned.events.includes('(bundle column)'), 'a dropped bundle column is reported, not silent');
  assert.ok(pruned.events.includes('complete_time_of_event_data'));
});

test('grounding: tools explain an unavailable model instead of "unknown model"', async () => {
  const catalog = loadCatalog(CATALOG, {});
  catalog.groundToPhysical(physWithout(catalog, 'crashlytics', ['event_name']));
  const engine = new Engine({ catalog, contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'grnd-')) }) });
  // { model } view: the status with the missing columns, not an error and not a half model
  const view = await engine.semantic_index({ model: 'crashlytics' });
  assert.equal(view.unavailable, true);
  assert.deepEqual(view.missing_columns, ['event_name']);
  assert.match(view.reason, /is_event_name/);
  // a task on it is refused at validation with the reason (schema enum excludes it; the engine names why)
  const { compileDeclaration } = await import('../../src/compile.js');
  assert.throws(() => compileDeclaration(catalog, { name: 't', semantic_models: [{ from: 'crashlytics', measures: [{ name: 'n', agg: 'count' }] }], metrics: [] }), /UNAVAILABLE.*event_name/);
  // the tool schema no longer offers it as a source, but the { model } view still accepts it to explain
  const { buildSchemas } = await import('../../src/schema.js');
  const schemas = buildSchemas(catalog);
  const enums = (node, out = []) => { if (Array.isArray(node)) node.forEach((n) => enums(n, out)); else if (node && typeof node === 'object') { if (Array.isArray(node.enum)) out.push(node.enum); for (const v of Object.values(node)) enums(v, out); } return out; };
  const offers = (schema, key) => enums(schema).some((e) => e.includes(key));
  assert.ok(!offers(schemas.create_semantic_model, 'crashlytics'), 'create_semantic_model must not offer the unavailable source');
  assert.ok(!offers(schemas.build_native_model, 'crashlytics'), 'build_native_model must not offer the unavailable source');
  assert.ok(offers(schemas.create_semantic_model, 'events'));
  const modelView = schemas.semantic_index.oneOf.find((b) => b.title === '{ model }');
  assert.ok(modelView.properties.model.enum.includes('crashlytics'), 'the { model } view still accepts it, to explain');
});

// Grounding reads the WAREHOUSE's answer. When dbt never got to ask — its own timeout, a signal, a
// spawn failure — that is not evidence of an absent table, and freezing it into the catalog would
// outlive the outage (the catalog is grounded once, at startup).
test('a model dbt could not ask about stays as declared, and is not marked unavailable', async () => {
  const catalog = loadCatalog(CATALOG, {});
  const asked = [];
  const runner = {
    relationColumns: async (_dir, model) => {
      asked.push(model);
      // the users table answers; the analytics fact times out mid-introspection
      if (/users/.test(model)) return { ok: true, columns: [{ name: 'player_id_of_internal' }, { name: 'country' }] };
      if (/analytics/.test(model)) return { ok: false, killed: true, signal: 'SIGTERM', error: 'dbt killed by SIGTERM — hit the 600000ms runner timeout' };
      return { ok: true, columns: (catalog.modelColumns(catalog.modelKeys().find((k) => catalog.getModel(k).dbt_model === model)) || []).map((c) => ({ name: c.name })) };
    },
  };
  const logs = [];
  await groundCatalogToPhysical(catalog, runner, '/tmp/base', (m) => logs.push(m));
  assert.ok(asked.length > 1);
  assert.equal(catalog.unavailableModels().events, undefined, 'the timed-out fact is NOT unavailable');
  assert.ok(catalog.facts.includes('events'), 'it is still an events source');
  assert.ok(catalog.eventNames('events').length > 0, 'and still carries its declared vocabulary');
  assert.ok(logs.some((l) => /was NOT checked/.test(l)), `the skip is reported: ${JSON.stringify(logs)}`);
  // the table that DID answer is still ground down to its real columns
  assert.deepEqual(Object.keys(catalog.getModel('users').dimensions || {}), ['country']);
});

// If NOTHING could be introspected, the unavailable thing is dbt or the warehouse, not every table
// at once — the catalog is served as declared instead of the server refusing to start.
test('when no model can be introspected the catalog is served as declared', async () => {
  const catalog = loadCatalog(CATALOG, {});
  const before = catalog.modelKeys().length;
  const logs = [];
  const runner = { relationColumns: async () => ({ ok: false, stderr: 'Could not connect to the warehouse: connection refused' }) };
  const out = await groundCatalogToPhysical(catalog, runner, '/tmp/base', (m) => logs.push(m));
  assert.deepEqual(out.pruned, {});
  assert.equal(catalog.modelKeys().length, before, 'every model survives');
  assert.deepEqual(catalog.unavailableModels(), {});
  assert.ok(catalog.facts.length > 0, 'the server has events sources to serve');
  assert.ok(logs.some((l) => /grounding SKIPPED/.test(l)), `the state is reported: ${JSON.stringify(logs)}`);
});
