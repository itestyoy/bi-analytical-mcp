import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';

// P0 token-leanness of semantic_index({ property }): by default the per-event coverage shows ONLY
// the events that carry the property (applies:true); the always-NULL events are omitted with a
// count + an explicit include_coverage:true drill. Nothing is lost — the full table is one call away.
// (Response-shape check, not a query-correctness/SQL-text assertion.)
const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));
function engine() {
  const catalog = loadCatalog(CATALOG, {});
  return new Engine({ catalog, contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'lean-')) }) });
}

test('event_coverage is carriers-only by default, with an omitted count + include_coverage drill', async () => {
  const e = engine();
  // ad_type carries data on 1 event, is always-NULL on 2 others (3 events in coverage).
  e.valueIndex.upsertProperty('events', 'ad_type_of_event_data', {
    distinctCount: 2, totalCount: 30, nullCount: 20, values: [{ value: 'rewarded', freq: 30 }],
    coverage: [
      { event: 'ad_finished', rowCount: 30, nonNull: 30 },
      { event: 'level_completed', rowCount: 15, nonNull: 0 },
      { event: 'first_launch', rowCount: 5, nonNull: 0 },
    ],
  });

  const lean = await e.semantic_index({ source: 'events', property: 'ad_type_of_event_data' });
  assert.deepEqual(lean.event_coverage.map((r) => r.event_name), ['ad_finished'], 'only the carrier is shown');
  assert.equal(lean.event_coverage_omitted, 2, 'the two always-NULL events are counted, not dumped');
  assert.ok(
    lean.next_actions.some((a) => /include_coverage: true/.test(a.call)),
    `an explicit drill to the full coverage is present, got ${JSON.stringify(lean.next_actions)}`,
  );

  // include_coverage:true → the FULL per-event table (nothing lost).
  const full = await e.semantic_index({ source: 'events', property: 'ad_type_of_event_data', include_coverage: true });
  assert.deepEqual(
    full.event_coverage.map((r) => r.event_name).sort(),
    ['ad_finished', 'first_launch', 'level_completed'],
    'full table includes the always-NULL events on demand',
  );
  assert.equal(full.event_coverage_omitted, undefined, 'no omitted marker when the full table is returned');
});
