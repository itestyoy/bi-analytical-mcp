import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCatalog } from '../../src/catalog.js';
import { compileDeclaration } from '../../src/compile.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';

// Allowed non-data tests: these assert the CATALOG METADATA CONTRACT — units,
// event semantics, partition hints and error fields are structured catalog facts
// surfaced to the AI (not generated SQL/YAML), so the discovery layer is honest.
const catalog = loadCatalog(new URL('../../config/catalog.yml', import.meta.url).pathname, { dialect: 'postgres' });
const engine = () => new Engine({ catalog, contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'dm-')) }) });

test('overview surfaces event_semantics + partition_column for the events fact', async () => {
  const out = await engine().semantic_index({});
  const ev = out.models.find((m) => m.kind === 'events_fact');
  assert.equal(ev.event_semantics.acquisition_event, 'first_launch');
  assert.equal(ev.event_semantics.session_event, 'new_session');
  assert.equal(ev.event_semantics.purchase_event, 'iap_purchase_completed');
  assert.equal(ev.partition_column, 'event_date');
});

test('semantic_index({ model: events }) carries the static partition/cost hint', async () => {
  const out = await engine().semantic_index({ model: 'events' });
  assert.equal(out.partition_column, 'event_date'); // static — no live runner needed
  assert.ok(typeof out.cost_hint === 'string' && out.cost_hint.length > 0);
  assert.deepEqual(out.event_semantics.session_end_event, 'end_session');
});

test('property drill-down surfaces unit; string-typed numeric gets a cast_hint', async () => {
  const e = engine();
  // numeric-typed with a declared unit → unit surfaced, NO cast needed.
  const rev = await e.semantic_index({ source: 'events', property: 'revenue_of_event_data' });
  assert.equal(rev.unit, 'usd');
  assert.equal(rev.cast_hint, undefined);
  // string-typed but seconds-in-meaning → unit + cast_hint:'numeric'.
  const ct = await e.semantic_index({ source: 'events', property: 'complete_time_of_event_data' });
  assert.equal(ct.unit, 'seconds');
  assert.equal(ct.type, 'string');
  assert.equal(ct.cast_hint, 'numeric');
});

test('event drill-down rows carry the unit per property', async () => {
  const out = await engine().semantic_index({ source: 'events', event: 'level_completed' });
  const ct = out.properties.find((p) => p.name === 'complete_time_of_event_data');
  assert.equal(ct.unit, 'seconds');
  const noUnit = out.properties.find((p) => p.name === 'result_of_event_data');
  assert.equal(noUnit.unit, undefined); // only declared units are surfaced — no guesses
});

// Compile errors carry the INPUT FIELD that caused them (ToolError.field via e.field).
test('compile errors name the offending field', () => {
  const declWith = (metrics) => ({ name: 't', semantic_models: [{ from: 'events', measures: [{ name: 'n', agg: 'count' }] }], metrics });
  try {
    compileDeclaration(catalog, declWith([{ name: 'm', type: 'simple', measure: { name: 'nope' } }]));
    assert.fail('expected unknown-measure error');
  } catch (e) {
    assert.match(e.message, /unknown measure 'nope'/);
    assert.match(e.message, /t_n/); // lists what IS declared
    assert.equal(e.field, 'metrics.measure');
  }
  try {
    compileDeclaration(catalog, { name: 't', use_base_models: ['nope'] });
    assert.fail('expected unknown-model error');
  } catch (e) {
    assert.match(e.message, /unknown model 'nope'/);
    assert.match(e.message, /users/); // lists the known models
    assert.equal(e.field, 'use_base_models');
  }
  try {
    compileDeclaration(catalog, { name: 't', semantic_models: [{ from: 'events', measures: [{ name: 'x', agg: 'sum', field: 'complete_time_of_event_data' }] }] });
    assert.fail('expected cast-required error');
  } catch (e) {
    assert.match(e.message, /cast/);
    assert.equal(e.field, 'measures.cast');
  }
});

test('overview carries join_note + value_index_status; payload-less event is not a dead end', async () => {
  const e = engine();
  const out = await e.semantic_index({});
  assert.ok(/model: 'users', attribute:/.test(out.join_note), 'join_note shows the structured attribute reference');
  assert.ok(out.join_note.includes("use_base_models"), 'join_note names the declaration');
  assert.equal(out.value_index_status.ready, false); // no indexer ran in this unit engine
  assert.equal(typeof out.value_index_status.indexed_properties, 'number');
  // Applicability is DATA-DERIVED: seed coverage so every event property is observed on some event
  // OTHER than first_launch (non-null=0 on first_launch) → first_launch legitimately carries no
  // payload, from the data rather than a declared meta.mcp.events list.
  for (const p of e.catalog.eventProps('events')) {
    e.valueIndex.upsertProperty('events', p, { coverage: [{ event: 'level_completed', rowCount: 5, nonNull: 5 }, { event: 'first_launch', rowCount: 3, nonNull: 0 }] });
  }
  // first_launch carries no event-specific payload — the response says what it IS for.
  const fl = await e.semantic_index({ source: 'events', event: 'first_launch' });
  assert.equal(fl.properties.filter((p) => p.events?.includes?.('first_launch')).length, 0);
  assert.ok(fl.recommendations.some((r) => r.includes('acquisition') || r.includes('occurrence')), JSON.stringify(fl.recommendations));
});
