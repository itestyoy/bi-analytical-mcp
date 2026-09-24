import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { settle } from '../helpers/settle.js';

const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));
function engine() {
  const catalog = loadCatalog(CATALOG, {});
  return settle(new Engine({ catalog, contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'tri-')) }) }));
}
const add = (e, id, stage) => e.build_native_model({ action: 'add_step', draft_id: id, stage });

// TRIPLE: a field NULL for the scoped (bundle × event) combination → warned after the step
// that uses it (the field is wrong FOR THIS APP+EVENT, so the step yields no values).
test('warns when a used field is empty for the scoped bundle+event (triple)', async () => {
  const e = engine();
  e.valueIndex.upsertProperty('events', 'ad_type_of_event_data', {
    distinctCount: 3, totalCount: 50, values: [{ value: 'rewarded', freq: 30 }],
    cellCoverage: [
      { bundle: 'com.omg.colorfit', event: 'level_started', rowCount: 53, nonNull: 0 },  // EMPTY here
      { bundle: 'com.omg.wordsearch', event: 'ad_finished', rowCount: 50, nonNull: 50 }, // populated there
    ],
  });
  const s = await e.build_native_model({ action: 'start', name: 'triple_empty', source: 'events' });
  await add(e, s.draft_id, { stage: 'where', conditions: [{ column: 'bundle_id', op: 'eq', value: 'com.omg.colorfit' }] });
  await add(e, s.draft_id, { stage: 'where', conditions: [{ column: 'event_name', op: 'in', value: ['level_started'] }] });
  const r = await add(e, s.draft_id, { stage: 'aggregate', group_by: ['ad_type_of_event_data'], measures: [{ name: 'n', fn: 'count' }] });
  assert.ok(
    r.recommendations.some((x) => x.includes('ad_type_of_event_data') && /NO values/.test(x) && x.includes('com.omg.colorfit') && x.includes('level_started')),
    JSON.stringify(r.recommendations),
  );
});

// The SAME field on a combination where it IS populated → no empty-combination warning.
test('no warning when the field is populated for the scoped bundle+event', async () => {
  const e = engine();
  e.valueIndex.upsertProperty('events', 'ad_type_of_event_data', {
    distinctCount: 3, totalCount: 50, values: [{ value: 'rewarded', freq: 30 }],
    cellCoverage: [{ bundle: 'com.omg.wordsearch', event: 'ad_finished', rowCount: 50, nonNull: 50 }],
  });
  const s = await e.build_native_model({ action: 'start', name: 'triple_ok', source: 'events' });
  await add(e, s.draft_id, { stage: 'where', conditions: [{ column: 'bundle_id', op: 'eq', value: 'com.omg.wordsearch' }] });
  await add(e, s.draft_id, { stage: 'where', conditions: [{ column: 'event_name', op: 'in', value: ['ad_finished'] }] });
  const r = await add(e, s.draft_id, { stage: 'aggregate', group_by: ['ad_type_of_event_data'], measures: [{ name: 'n', fn: 'count' }] });
  assert.ok(!r.recommendations.some((x) => /NO values/.test(x)), JSON.stringify(r.recommendations));
});

// MARGINAL (bundle only, no event scope): field NULL for the scoped app → warned.
test('warns from the per-bundle marginal when only the app is scoped', async () => {
  const e = engine();
  e.valueIndex.upsertProperty('events', 'ad_type_of_event_data', {
    distinctCount: 3, totalCount: 50, values: [{ value: 'rewarded', freq: 30 }],
    bundleCoverage: [{ bundle: 'com.omg.colorfit', rowCount: 53, nonNull: 0 }, { bundle: 'com.omg.wordsearch', rowCount: 1000, nonNull: 50 }],
  });
  const s = await e.build_native_model({ action: 'start', name: 'bundle_only', source: 'events' });
  await add(e, s.draft_id, { stage: 'where', conditions: [{ column: 'bundle_id', op: 'eq', value: 'com.omg.colorfit' }] });
  const r = await add(e, s.draft_id, { stage: 'aggregate', group_by: ['ad_type_of_event_data'], measures: [{ name: 'n', fn: 'count' }] });
  assert.ok(r.recommendations.some((x) => x.includes('ad_type_of_event_data') && /NULL for app/.test(x) && x.includes('com.omg.colorfit')), JSON.stringify(r.recommendations));
});

// Nothing scoped → no empty-combination warning (left to the generic event-scope hint).
test('no empty-combination warning when nothing concrete is scoped', async () => {
  const e = engine();
  e.valueIndex.upsertProperty('events', 'ad_type_of_event_data', { distinctCount: 3, cellCoverage: [{ bundle: 'com.omg.colorfit', event: 'level_started', rowCount: 53, nonNull: 0 }] });
  const s = await e.build_native_model({ action: 'start', name: 'noscope', source: 'events' });
  const r = await add(e, s.draft_id, { stage: 'aggregate', group_by: ['ad_type_of_event_data'], measures: [{ name: 'n', fn: 'count' }] });
  assert.ok(!r.recommendations.some((x) => /NO values|NULL for app/.test(x)), JSON.stringify(r.recommendations));
});
