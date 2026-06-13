import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { loadRecipes } from '../../src/recipes.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { buildToolDefs } from '../../src/server.js';

const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));
const RECIPES = fileURLToPath(new URL('../../config/recipes.json', import.meta.url));
function engine() {
  const catalog = loadCatalog(CATALOG, {});
  return new Engine({ catalog, recipes: loadRecipes(RECIPES), contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'mem-')) }) });
}

// The memory tool is advertised and dispatches its four actions.
test('memory tool is advertised with a real description', () => {
  const defs = buildToolDefs(engine());
  const m = defs.find((d) => d.name === 'memory');
  assert.ok(m, 'memory tool advertised');
  assert.notEqual(m.description, 'memory', 'has a real description');
});

// record RESOLVES each target to the right kind/key and stores the finding verbatim.
test('memory record resolves targets to catalog entities (property/attr/event/model/term)', () => {
  const e = engine();
  const out = e.memory({
    action: 'record',
    note: "'ad format' = the event_data property ad_type_of_event_data, only on ad_started/ad_finished; values rewarded/interstitial/banner.",
    targets: ['ad_type_of_event_data', 'users.country', 'ad_finished', 'users', 'ad format'],
    aliases: ['ad format', 'ad type'],
    links: ['https://confluence/ads', { url: 'https://dash/ads', title: 'Ads dashboard' }],
  });
  assert.equal(out.saved, true);
  assert.ok(out.id, 'returns a note id');
  const byKey = Object.fromEntries(out.linked_to.map((l) => [l.target, l.kind]));
  assert.equal(byKey['ad_type_of_event_data'], 'property');
  assert.equal(byKey['users.country'], 'property');
  assert.equal(byKey['ad_finished'], 'event');
  assert.equal(byKey['users'], 'model');
  assert.equal(byKey['ad format'], 'term', 'an unmatched phrase is kept as a free term');
  assert.deepEqual(out.unresolved_terms, ['ad format']);
  // links normalise (string → { url }); aliases pass through.
  assert.deepEqual(out.links, [{ url: 'https://confluence/ads' }, { url: 'https://dash/ads', title: 'Ads dashboard' }]);
  assert.deepEqual(out.aliases, ['ad format', 'ad type']);
});

// A recorded finding SURFACES on every linked semantic_index view + in search by alias.
test('a recorded finding surfaces through semantic_index (views + search) by its links/aliases', async () => {
  const e = engine();
  const note = "'ad format' is ad_type_of_event_data (rewarded/interstitial/banner), only on ad_started/ad_finished.";
  const rec = e.memory({ action: 'record', note, targets: ['ad_type_of_event_data', 'ad_finished', 'users'], aliases: ['ad format'] });

  // { property } — the event property it is about.
  const prop = await e.semantic_index({ property: 'ad_type_of_event_data' });
  assert.ok(prop.memory?.some((m) => m.id === rec.id && m.note === note), 'note attached to the property view');
  // the about[] decodes back to typed targets.
  const attached = prop.memory.find((m) => m.id === rec.id);
  assert.ok(attached.about.some((a) => a.kind === 'property' && a.key === 'ad_type_of_event_data'));

  // { event } — the carrying event.
  const ev = await e.semantic_index({ event: 'ad_finished' });
  assert.ok(ev.memory?.some((m) => m.id === rec.id), 'note attached to the event view');

  // { model } — a model-level link.
  const um = await e.semantic_index({ model: 'users' });
  assert.ok(um.memory?.some((m) => m.id === rec.id), 'note attached to the model view');

  // { search } by the ALIAS the user used → resolves back to the finding (+ the real field in about[]).
  const s = await e.semantic_index({ search: 'ad format' });
  assert.ok(s.memory_matches?.some((m) => m.id === rec.id && m.about.some((a) => a.key === 'ad_type_of_event_data')), 'alias search resurfaces the note pointing at the real field');

  // an UNlinked property carries no memory.
  const other = await e.semantic_index({ property: 'level_id_of_event_data' });
  assert.equal(other.memory, undefined, 'unrelated property has no memory');
});

// A "<model>.<column>" attribute finding surfaces on that attribute's view.
test('memory linked to a "<model>.<column>" attribute surfaces on its property view', async () => {
  const e = engine();
  const rec = e.memory({ action: 'record', note: 'country is ISO-3166 alpha-2 on dim_users.', targets: ['users.country'] });
  const attr = await e.semantic_index({ property: 'users.country' });
  assert.ok(attr.memory?.some((m) => m.id === rec.id), 'attribute view carries the note');
});

// list (all + by target), search, forget — the lifecycle round-trips the stored data.
test('memory list / search / forget round-trip', () => {
  const e = engine();
  const a = e.memory({ action: 'record', note: 'finding A about ads', targets: ['ad_type_of_event_data'], aliases: ['ad format'] });
  const b = e.memory({ action: 'record', note: 'finding B about country', targets: ['users.country'] });

  const all = e.memory({ action: 'list' });
  assert.equal(all.total, 2);
  assert.ok(all.notes.some((n) => n.id === a.id) && all.notes.some((n) => n.id === b.id));

  const byTarget = e.memory({ action: 'list', target: 'ad_type_of_event_data' });
  assert.equal(byTarget.notes.length, 1);
  assert.equal(byTarget.notes[0].id, a.id);

  const found = e.memory({ action: 'search', query: 'country' });
  assert.equal(found.notes.length, 1);
  assert.equal(found.notes[0].id, b.id);
  // search also matches an alias.
  assert.equal(e.memory({ action: 'search', query: 'ad format' }).notes[0].id, a.id);
  // FUZZY: a mistyped query still finds the note (typo-tolerant via the Fuse subsystem).
  assert.ok(e.memory({ action: 'search', query: 'cuntry' }).notes.some((n) => n.id === b.id), 'typo "cuntry" still finds the country note');
  // fuzzy:false makes the SAME typo miss (exact-substring only).
  assert.ok(!e.memory({ action: 'search', query: 'cuntry', fuzzy: false }).notes.some((n) => n.id === b.id), 'fuzzy:false → typo no longer matches');

  assert.equal(e.memory({ action: 'forget', id: a.id }).forgotten, true);
  assert.equal(e.memory({ action: 'list' }).total, 1, 'forgotten note is gone');
});

// Overview reports the stored count once anything is saved.
test('semantic_index overview surfaces the memory count', async () => {
  const e = engine();
  assert.equal((await e.semantic_index()).memory, undefined, 'no memory key when nothing is saved');
  e.memory({ action: 'record', note: 'a finding', targets: ['ad_type_of_event_data'] });
  const ov = await e.semantic_index();
  assert.equal(ov.memory.notes, 1, 'overview reports the saved count');
});

// Strict validation: each action accepts only its fields; bad input is rejected.
test('memory strict input validation', () => {
  const e = engine();
  assert.throws(() => e.memory({ action: 'record' }), /invalid input/, 'record needs a note');
  assert.throws(() => e.memory({ action: 'record', note: 'x', query: 'y' }), /invalid input/, 'record forbids query');
  assert.throws(() => e.memory({ action: 'search' }), /invalid input/, 'search needs a query');
  assert.throws(() => e.memory({ action: 'forget' }), /invalid input/, 'forget needs an id');
  assert.throws(() => e.memory({ action: 'list', note: 'x' }), /invalid input/, 'list forbids note');
  assert.throws(() => e.memory({ action: 'list', fuzzy: true }), /invalid input/, 'fuzzy is search-only');
  assert.throws(() => e.memory({ action: 'bogus' }), /invalid input/, 'unknown action rejected by enum');
  assert.throws(() => e.memory({ action: 'forget', id: 'nope_missing' }), /no memory note/, 'forgetting a missing id errors');
});
