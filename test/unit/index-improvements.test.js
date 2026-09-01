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
function engine(extra = {}) {
  const catalog = loadCatalog(CATALOG, {});
  return new Engine({ catalog, contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'idx-')) }), ...extra });
}

// п.2 RECALL: the index keeps only top-N values, so a property with more distinct values
// than are stored is flagged `values_capped` — and a "not found" search says so, so the AI
// does not mistake absence-from-index for absence-from-data.
test('values_capped is flagged when distinct_count exceeds stored values', async () => {
  const e = engine();
  // 100 distinct level ids but only 2 stored → the index is incomplete for this column.
  e.valueIndex.upsertProperty('events', 'level_id_of_event_data', { distinctCount: 100, totalCount: 900, values: [{ value: '1', freq: 10 }, { value: '2', freq: 5 }] });
  const p = await e.semantic_index({ property: 'level_id_of_event_data' });
  assert.equal(p.value_stats.values_capped, true);
  assert.equal(p.value_stats.indexed_value_count, 2);
  assert.ok(p.recommendations.some((r) => /RARE value may be absent|top 2 of 100/i.test(r)), JSON.stringify(p.recommendations));
});

test('a value search that finds nothing warns that rare values may be unindexed', async () => {
  const e = engine();
  const s = await e.semantic_index({ search: 'zzz_no_such_value_anywhere' });
  assert.ok((s.recommendations || []).some((r) => /rare value may not be indexed/i.test(r)), JSON.stringify(s.recommendations));
});

// п.5 FUZZY TARGETS: a near-miss target name links to the real catalog entity (not a term).
test('memory record fuzzy-resolves a near-miss target to the real entity', async () => {
  const e = engine();
  // typo: missing a 't' in "event" → should still link to ad_type_of_event_data.
  const out = await e.memory({ action: 'record', note: 'ad format lives here', targets: ['ad_type_of_even_data'] });
  const link = out.linked_to[0];
  assert.equal(link.kind, 'property');
  assert.equal(link.target, 'events.ad_type_of_event_data', 'fuzzy-linked to the real property, named with its source');
  assert.equal(link.fuzzy_resolved_from, 'ad_type_of_even_data');
  assert.ok(out.fuzzy_links_note, 'flags that a fuzzy link was used');
  // and it actually surfaces on the real property's view.
  const prop = await e.semantic_index({ property: 'ad_type_of_event_data' });
  assert.ok(prop.memory?.some((m) => m.id === out.id), 'note surfaces on the fuzzily-linked property');
  // a genuinely unrecognised string still stays a free term.
  const t = await e.memory({ action: 'record', note: 'x', targets: ['totally unrelated phrase 123'] });
  assert.equal(t.linked_to[0].kind, 'term');
});

// п.5 DURABILITY: a dedicated memory db keeps findings across engine instances (the
// mechanism behind surviving container restarts when pointed at a persistent volume).
test('memoryDbPath persists findings across engine instances', async () => {
  const memDb = join(mkdtempSync(join(tmpdir(), 'memdb-')), 'memory.sqlite');
  const ws = () => new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'idx-')) });
  const cat = () => loadCatalog(CATALOG, {});

  const e1 = new Engine({ catalog: cat(), contextManager: ws(), memoryDbPath: memDb });
  const rec = await e1.memory({ action: 'record', note: 'durable finding about ads', targets: ['ad_type_of_event_data'] });
  e1.close();

  const e2 = new Engine({ catalog: cat(), contextManager: ws(), memoryDbPath: memDb });
  const list = await e2.memory({ action: 'list' });
  assert.ok(list.notes.some((n) => n.id === rec.id && n.note === 'durable finding about ads'), 'finding persisted in the dedicated memory store');
  e2.close();
});

// п.3 VIEWS MANIFEST: the overview carries a machine-readable map of the drill-down views.
test('overview exposes a machine-readable views manifest', async () => {
  const ov = await engine().semantic_index();
  assert.ok(Array.isArray(ov.views), 'views manifest present');
  const keys = new Set(ov.views.map((v) => v.view));
  for (const k of ['model', 'event', 'property', 'search', 'guide', 'status']) assert.ok(keys.has(k), `views includes ${k}`);
  assert.ok(ov.views.every((v) => v.view && v.when), 'each view entry has view + when');
});

// п.3 NEXT_ACTIONS: structured { call, why } concrete next steps replace the prose `next`.
test('views carry structured next_actions (call + why), not just prose', async () => {
  const e = engine();
  const ov = await e.semantic_index();
  assert.equal(ov.next, undefined, 'the prose `next` paragraph is gone');
  assert.ok(Array.isArray(ov.next_actions) && ov.next_actions.length, 'overview has next_actions');
  assert.ok(ov.next_actions.every((a) => typeof a.call === 'string' && /semantic_index\(/.test(a.call) && a.why), 'each next_action is a runnable call + why');
  // a drill view carries them too, with the entity name filled in.
  const ev = await e.semantic_index({ event: 'ad_finished' });
  assert.ok(ev.next_actions.some((a) => /\{ property:/.test(a.call)), JSON.stringify(ev.next_actions));
});
