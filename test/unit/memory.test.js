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
function engineWith(embedder) {
  const catalog = loadCatalog(CATALOG, {});
  return new Engine({ catalog, recipes: loadRecipes(RECIPES), contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'mem-')) }), embedder });
}
function engine() { return engineWith(undefined); }

// A deterministic, offline stub embedder: maps text to a 3-axis "concept" vector by keyword
// (axis 0 = monetization/revenue, 1 = tutorial/onboarding, 2 = geo). Synonyms share an axis,
// so a query maps near a note that means the same thing even with NO shared words — proving
// the SEMANTIC path without any network. (Real deployments inject createEmbedder() instead.)
function stubEmbedder() {
  const AX = [
    ['revenue', 'monetization', 'monetisation', 'iap', 'purchase', 'purchases', 'payer', 'payers', 'money', 'spend'],
    ['tutorial', 'onboarding', 'step', 'steps'],
    ['country', 'geo', 'region', 'germany'],
  ];
  const vecFor = (text) => {
    const toks = String(text).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const v = AX.map(() => 0);
    for (const t of toks) AX.forEach((set, i) => { if (set.includes(t)) v[i] += 1; });
    return v;
  };
  return { model: 'stub-3', embed: async (texts) => texts.map(vecFor) };
}

// The memory tool is advertised and dispatches its four actions.
test('memory tool is advertised with a real description', () => {
  const defs = buildToolDefs(engine());
  const m = defs.find((d) => d.name === 'memory');
  assert.ok(m, 'memory tool advertised');
  assert.notEqual(m.description, 'memory', 'has a real description');
});

// record RESOLVES each target to the right kind/key and stores the finding verbatim.
test('memory record resolves targets to catalog entities (property/attr/event/model/term)', async () => {
  const e = engine();
  const out = await e.memory({
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
  const rec = await e.memory({ action: 'record', note, targets: ['ad_type_of_event_data', 'ad_finished', 'users'], aliases: ['ad format'] });

  // { property } — the event property it is about.
  const prop = await e.semantic_index({ property: 'ad_type_of_event_data' });
  assert.ok(prop.memory?.some((m) => m.id === rec.id && m.note === note), 'note attached to the property view');
  const attached = prop.memory.find((m) => m.id === rec.id);
  assert.ok(attached.about.some((a) => a.kind === 'property' && a.key === 'ad_type_of_event_data'));

  // { event } — the carrying event.
  const ev = await e.semantic_index({ event: 'ad_finished' });
  assert.ok(ev.memory?.some((m) => m.id === rec.id), 'note attached to the event view');

  // { model } — a model-level link.
  const um = await e.semantic_index({ model: 'users' });
  assert.ok(um.memory?.some((m) => m.id === rec.id), 'note attached to the model view');

  // { search } by the ALIAS the user used → resolves back to the finding (+ the real field).
  const s = await e.semantic_index({ search: 'ad format' });
  assert.ok(s.memory_matches?.some((m) => m.id === rec.id && m.about.some((a) => a.key === 'ad_type_of_event_data')), 'alias search resurfaces the note pointing at the real field');

  // an UNlinked property carries no memory.
  const other = await e.semantic_index({ property: 'level_id_of_event_data' });
  assert.equal(other.memory, undefined, 'unrelated property has no memory');
});

// A "<model>.<column>" attribute finding surfaces on that attribute's view.
test('memory linked to a "<model>.<column>" attribute surfaces on its property view', async () => {
  const e = engine();
  const rec = await e.memory({ action: 'record', note: 'country is ISO-3166 alpha-2 on dim_users.', targets: ['users.country'] });
  const attr = await e.semantic_index({ property: 'users.country' });
  assert.ok(attr.memory?.some((m) => m.id === rec.id), 'attribute view carries the note');
});

// list (all + by target), search, forget — the lifecycle round-trips the stored data.
test('memory list / search / forget round-trip', async () => {
  const e = engine();
  const a = await e.memory({ action: 'record', note: 'finding A about ads', targets: ['ad_type_of_event_data'], aliases: ['ad format'] });
  const b = await e.memory({ action: 'record', note: 'finding B about country', targets: ['users.country'] });

  const all = await e.memory({ action: 'list' });
  assert.equal(all.total, 2);
  assert.ok(all.notes.some((n) => n.id === a.id) && all.notes.some((n) => n.id === b.id));

  const byTarget = await e.memory({ action: 'list', target: 'ad_type_of_event_data' });
  assert.equal(byTarget.notes.length, 1);
  assert.equal(byTarget.notes[0].id, a.id);

  const found = await e.memory({ action: 'search', query: 'country' });
  assert.equal(found.semantic, false, 'no embedder → fuzzy-only mode reported');
  assert.ok(found.notes.some((n) => n.id === b.id));
  // search also matches an alias.
  assert.ok((await e.memory({ action: 'search', query: 'ad format' })).notes.some((n) => n.id === a.id));
  // FUZZY: a mistyped query still finds the note (typo-tolerant via the Fuse subsystem).
  assert.ok((await e.memory({ action: 'search', query: 'cuntry' })).notes.some((n) => n.id === b.id), 'typo "cuntry" still finds the country note');
  // fuzzy:false makes the SAME typo miss (exact-substring only).
  assert.ok(!(await e.memory({ action: 'search', query: 'cuntry', fuzzy: false })).notes.some((n) => n.id === b.id), 'fuzzy:false → typo no longer matches');

  assert.equal((await e.memory({ action: 'forget', id: a.id })).forgotten, true);
  assert.equal((await e.memory({ action: 'list' })).total, 1, 'forgotten note is gone');
});

// SEMANTIC search (embedder configured): a query finds a same-meaning note with NO shared
// words — and the SAME query under fuzzy-only does NOT. Proves the embedding path adds recall.
test('semantic memory search finds a same-meaning note with no shared words', async () => {
  const sem = engineWith(stubEmbedder());
  const mon = await sem.memory({ action: 'record', note: 'IAP purchases are failing for some payers', aliases: ['monetization'], targets: ['price_in_usd_of_event_data'] });
  const tut = await sem.memory({ action: 'record', note: 'the onboarding tutorial has 5 steps', targets: ['tutorial'] });

  const s = await sem.memory({ action: 'search', query: 'revenue problems' });
  assert.equal(s.semantic, true, 'embedder configured → semantic mode reported');
  assert.ok(s.notes.some((n) => n.id === mon.id), 'semantic search surfaces the monetization note for "revenue" (no shared words)');
  assert.ok(!s.notes.some((n) => n.id === tut.id), 'the unrelated tutorial note is below the similarity floor');

  // Without an embedder, the same query (no lexical overlap) does NOT find it.
  const fuzzy = engine();
  await fuzzy.memory({ action: 'record', note: 'IAP purchases are failing for some payers', aliases: ['monetization'], targets: ['price_in_usd_of_event_data'] });
  const f = await fuzzy.memory({ action: 'search', query: 'revenue problems' });
  assert.ok(!f.notes.some((n) => n.note.includes('IAP purchases')), 'fuzzy-only misses the same-meaning note (proves semantic added the recall)');
});

// Overview reports the stored count once anything is saved.
test('semantic_index overview surfaces the memory count', async () => {
  const e = engine();
  assert.equal((await e.semantic_index()).memory, undefined, 'no memory key when nothing is saved');
  await e.memory({ action: 'record', note: 'a finding', targets: ['ad_type_of_event_data'] });
  const ov = await e.semantic_index();
  assert.equal(ov.memory.notes, 1, 'overview reports the saved count');
});

// Strict validation: each action accepts only its fields; bad input is rejected.
test('memory strict input validation', async () => {
  const e = engine();
  await assert.rejects(() => e.memory({ action: 'record' }), /invalid input/, 'record needs a note');
  await assert.rejects(() => e.memory({ action: 'record', note: 'x', query: 'y' }), /invalid input/, 'record forbids query');
  await assert.rejects(() => e.memory({ action: 'search' }), /invalid input/, 'search needs a query');
  await assert.rejects(() => e.memory({ action: 'forget' }), /invalid input/, 'forget needs an id');
  await assert.rejects(() => e.memory({ action: 'list', note: 'x' }), /invalid input/, 'list forbids note');
  await assert.rejects(() => e.memory({ action: 'list', fuzzy: true }), /invalid input/, 'fuzzy is search-only');
  await assert.rejects(() => e.memory({ action: 'bogus' }), /invalid input/, 'unknown action rejected by enum');
  await assert.rejects(() => e.memory({ action: 'forget', id: 'nope_missing' }), /no memory note/, 'forgetting a missing id errors');
});
