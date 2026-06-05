import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';

// Allowed non-data test: build_native_model's draft LIFECYCLE + input validation are
// pure schema/state machinery (renderPipeline folds columns WITHOUT a warehouse), so no
// runner is wired and nothing is materialized. We assert on draft state + column
// propagation + error guards — never on generated SQL text.
const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));

function engine() {
  const catalog = loadCatalog(CATALOG, {});
  return new Engine({ catalog, contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'bnm-')) }) });
}

const mr = { stage: 'match_recognize', partition_by: ['player_id_of_internal'], steps: [{ name: 'a', event_name: ['first_launch'] }, { name: 'b', event_name: ['tutorial'] }] };

test('build_native_model: start returns a draft + source columns', async () => {
  const e = engine();
  const s = await e.build_native_model({ action: 'start', name: 'inc', source: 'events' });
  assert.match(s.draft_id, /\w+/);
  assert.equal(s.action, 'start');
  assert.deepEqual(s.steps, []);
  assert.ok(s.available_columns.some((c) => c.name === 'player_id_of_internal'), 'source columns surfaced');
  assert.ok(Array.isArray(s.recommendations) && s.recommendations.length > 0);
});

test('build_native_model: add_step propagates columns; bad step is rejected without mutating the draft', async () => {
  const e = engine();
  const s = await e.build_native_model({ action: 'start', name: 'inc', source: 'events' });
  const a1 = await e.build_native_model({ action: 'add_step', draft_id: s.draft_id, stage: mr });
  assert.equal(a1.step_index, 1);
  const cols = a1.available_columns.map((c) => c.name);
  assert.ok(cols.includes('player_id_of_internal'), 'partition key carried');
  assert.ok(cols.includes('reached_a') && cols.includes('completed'), 'funnel output columns available');
  // a second stage references the funnel output produced by the first.
  const a2 = await e.build_native_model({ action: 'add_step', draft_id: s.draft_id, stage: { stage: 'aggregate', group_by: ['completed'], measures: [{ name: 'n', fn: 'count' }] } });
  assert.equal(a2.step_index, 2);
  assert.deepEqual(a2.available_columns.map((c) => c.name), ['completed', 'n']);
  // a stage referencing a missing column is rejected and NOT persisted.
  await assert.rejects(() => e.build_native_model({ action: 'add_step', draft_id: s.draft_id, stage: { stage: 'project', columns: ['no_such_col'] } }));
  const pv = await e.build_native_model({ action: 'preview', draft_id: s.draft_id });
  assert.equal(pv.steps.length, 2, 'rejected step not persisted');
  assert.ok(typeof pv.model_sql === 'string' && pv.model_sql.length > 0, 'preview renders SQL (schema-only)');
});

test('build_native_model: discard drops the draft; later actions error cleanly', async () => {
  const e = engine();
  const s = await e.build_native_model({ action: 'start', name: 'inc', source: 'events' });
  await e.build_native_model({ action: 'add_step', draft_id: s.draft_id, stage: mr });
  const d = await e.build_native_model({ action: 'discard', draft_id: s.draft_id });
  assert.equal(d.discarded, true);
  await assert.rejects(() => e.build_native_model({ action: 'add_step', draft_id: s.draft_id, stage: mr }), /no draft/i);
  await assert.rejects(() => e.build_native_model({ action: 'preview', draft_id: s.draft_id }), /no draft/i);
});

test('build_native_model: starting again in the same context resets the draft', async () => {
  const e = engine();
  const s = await e.build_native_model({ action: 'start', name: 'first', source: 'events' });
  await e.build_native_model({ action: 'add_step', draft_id: s.draft_id, stage: mr });
  // reuse the same draft_id: a fresh start wipes prior stages + renames.
  const s2 = await e.build_native_model({ action: 'start', draft_id: s.draft_id, name: 'second', source: 'events' });
  assert.equal(s2.draft_id, s.draft_id);
  assert.equal(s2.name, 'second');
  assert.deepEqual(s2.steps, []);
  const pv = await e.build_native_model({ action: 'preview', draft_id: s.draft_id });
  assert.equal(pv.steps.length, 0);
});

test('build_native_model: schema rejects malformed actions', async () => {
  const e = engine();
  await assert.rejects(() => e.build_native_model({ action: 'start' }), 'start requires name');
  await assert.rejects(() => e.build_native_model({ action: 'add_step', draft_id: 'ctx_deadbeef' }), 'add_step requires a stage');
  await assert.rejects(() => e.build_native_model({ action: 'bogus' }), 'unknown action rejected');
});
