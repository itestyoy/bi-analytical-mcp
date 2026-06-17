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
  return new Engine({ catalog, contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'fvg-')) }) });
}
const whereStep = (e, draftId, column, op, value) => e.build_native_model({ action: 'add_step', draft_id: draftId, stage: { stage: 'where', conditions: [{ column, op, value }] } });

// A wrong-CASED filter value on a categorical event property is REJECTED with the real value,
// not silently filtered to nothing (the 'organic' vs 'Organic' problem).
test('a wrong-cased filter value is rejected with the correct casing suggested', async () => {
  const e = engine();
  // real indexed values for result_of_event_data are lowercase win/lose.
  e.valueIndex.upsertProperty('result_of_event_data', { distinctCount: 2, totalCount: 15, values: [{ value: 'win', freq: 10 }, { value: 'lose', freq: 5 }] });
  const s = await e.build_native_model({ action: 'start', name: 'casecheck', source: 'events' });

  await assert.rejects(
    () => whereStep(e, s.draft_id, 'result_of_event_data', 'eq', 'Win'),
    (err) => /different casing/.test(err.message) && /'win'/.test(err.message),
    'mis-cased value rejected + correct casing suggested',
  );
  // the exact, real value is accepted.
  const ok = await whereStep(e, s.draft_id, 'result_of_event_data', 'eq', 'win');
  assert.equal(ok.action, 'add_step');
});

// A value that does NOT occur (and the full value set is indexed) is rejected as absent.
test('an absent value is rejected when the full value set is indexed', async () => {
  const e = engine();
  e.valueIndex.upsertProperty('result_of_event_data', { distinctCount: 2, totalCount: 15, values: [{ value: 'win', freq: 10 }, { value: 'lose', freq: 5 }] });
  const s = await e.build_native_model({ action: 'start', name: 'absent', source: 'events' });
  await assert.rejects(
    () => whereStep(e, s.draft_id, 'result_of_event_data', 'eq', 'victory'),
    (err) => /does not occur/.test(err.message) && /win/.test(err.message),
  );
});

// The check is SOURCE-SCOPED via the anchor dimension key (events.<col>), e.g. bundle_id.
test('anchor dimension values are verified source-scoped (events.<col>)', async () => {
  const e = engine();
  e.valueIndex.upsertProperty('events.bundle_id', { distinctCount: 2, totalCount: 150, values: [{ value: 'com.omg.wordsearch', freq: 100 }, { value: 'com.omg.colorfit', freq: 50 }] });
  const s = await e.build_native_model({ action: 'start', name: 'bundlefilter', source: 'events' });
  await assert.rejects(
    () => whereStep(e, s.draft_id, 'bundle_id', 'eq', 'com.omg.WORDSEARCH'),
    (err) => /casing/.test(err.message) && /com\.omg\.wordsearch/.test(err.message),
  );
  const ok = await whereStep(e, s.draft_id, 'bundle_id', 'eq', 'com.omg.wordsearch');
  assert.equal(ok.action, 'add_step');
});

// When only the TOP-N is indexed (capped), an unknown value is NOT blocked — it WARNS, so a
// legitimately-rare value is never rejected on incomplete index data.
test('a capped (top-N) column warns instead of blocking an unindexed value', async () => {
  const e = engine();
  e.valueIndex.upsertProperty('result_of_event_data', { distinctCount: 500, totalCount: 9999, values: [{ value: 'win', freq: 10 }, { value: 'lose', freq: 5 }] });
  const s = await e.build_native_model({ action: 'start', name: 'capped', source: 'events' });
  const r = await whereStep(e, s.draft_id, 'result_of_event_data', 'eq', 'some_rare_status');
  assert.equal(r.action, 'add_step', 'not blocked');
  assert.ok(r.recommendations.some((x) => /not in the index|more values than are indexed/i.test(x)), JSON.stringify(r.recommendations));
});

// HIGH-CARDINALITY guard (the user's concern): a column whose stored values reach the cap
// (≥50) is treated as incomplete even if distinct_count looks satisfied — an unknown value
// is WARNED, never hard-rejected (it may well exist beyond the indexed top-N).
test('a many-valued column (at the cap) never hard-rejects an unindexed value', async () => {
  const e = engine();
  const many = Array.from({ length: 50 }, (_, i) => ({ value: `v${i}`, freq: 50 - i }));
  e.valueIndex.upsertProperty('result_of_event_data', { distinctCount: 50, totalCount: 9999, values: many });
  const s = await e.build_native_model({ action: 'start', name: 'manyvals', source: 'events' });
  const r = await whereStep(e, s.draft_id, 'result_of_event_data', 'eq', 'v999_not_indexed');
  assert.equal(r.action, 'add_step', 'a value beyond the cap is not blocked');
  assert.ok(r.recommendations.some((x) => /not in the index|more values than are indexed/i.test(x)));
});

// A fuzzy NEAR-match is a WARNING, not a block — a distinct sibling value (level_1 vs level_3)
// must never be rejected just because it resembles an indexed one.
test('a fuzzy near-match warns but does not block', async () => {
  const e = engine();
  e.valueIndex.upsertProperty('result_of_event_data', { distinctCount: 2, totalCount: 15, values: [{ value: 'level_1', freq: 10 }, { value: 'level_2', freq: 5 }] });
  const s = await e.build_native_model({ action: 'start', name: 'fuzzyok', source: 'events' });
  const r = await whereStep(e, s.draft_id, 'result_of_event_data', 'eq', 'level_3');
  assert.equal(r.action, 'add_step', 'a similar-but-distinct value is not blocked');
});

// An UNINDEXED column (cold index) cannot be verified → no block, no false rejection.
test('an unindexed column is not blocked (cannot verify)', async () => {
  const e = engine(); // nothing indexed
  const s = await e.build_native_model({ action: 'start', name: 'cold', source: 'events' });
  const r = await whereStep(e, s.draft_id, 'result_of_event_data', 'eq', 'whatever');
  assert.equal(r.action, 'add_step', 'cold index → not blocked');
});

// Numeric/range filters are not value-checked (only categorical equality).
test('numeric/range comparisons are not value-checked', async () => {
  const e = engine();
  e.valueIndex.upsertProperty('result_of_event_data', { distinctCount: 2, values: [{ value: 'win', freq: 10 }, { value: 'lose', freq: 5 }] });
  const s = await e.build_native_model({ action: 'start', name: 'range', source: 'events' });
  // a gt on a value not in the set is fine (it's a range op, not equality).
  const r = await whereStep(e, s.draft_id, 'result_of_event_data', 'gt', 'aaa');
  assert.equal(r.action, 'add_step');
});
