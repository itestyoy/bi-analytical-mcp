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
import { openStore } from '../../src/store.js';
import { settle } from '../helpers/settle.js';

const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));
const RECIPES = fileURLToPath(new URL('../../config/recipes.json', import.meta.url));
function engineWith(embedder, store) {
  const catalog = loadCatalog(CATALOG, {});
  return settle(new Engine({ catalog, recipes: loadRecipes(RECIPES), contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'mem-')) }), embedder, store }));
}
function engineWithStore(store) { return engineWith(undefined, store); }
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
// The memory is READ through semantic_index: { search } (its memory_matches) and { notes }.
const searchNotes = async (e, query, fuzzy) => { const r = await e.semantic_index({ search: query, ...(fuzzy === false ? { fuzzy: false } : {}) }); return { notes: r.memory_matches || [], semantic: r.memory_semantic ?? false, semantic_error: r.memory_semantic_error }; };
const listNotes = (e, about) => e.semantic_index({ notes: true, ...(about ? { about } : {}) });

test('memory tool is advertised with a real description', () => {
  const defs = buildToolDefs(engine());
  const m = defs.find((d) => d.name === 'memory');
  assert.ok(m, 'memory tool advertised');
  assert.notEqual(m.description, 'memory', 'has a real description');
});

// record RESOLVES each target to the right kind/key and stores the finding verbatim.
test('memory record resolves targets to catalog entities (property/attr/event/model/term)', async () => {
  const e = engine();
  const out = (await e.memory({ action: 'record', notes: [{ note: "'ad format' = the event_data property ad_type_of_event_data, only on ad_started/ad_finished; values rewarded/interstitial/banner.", targets: [{ source: 'events', name: 'ad_type_of_event_data' }, { source: 'users', name: 'country' }, { source: 'events', name: 'ad_finished' }, { source: 'users' }, { term: 'ad format' }], aliases: ['ad format', 'ad type'], links: ['https://confluence/ads', { url: 'https://dash/ads', title: 'Ads dashboard' }] }] })).notes[0];
  assert.ok(out.linked_to, 'saved, with what it links to');
  assert.ok(out.id, 'returns a note id');
  const linked = out.linked_to.map((l) => ({ kind: l.kind, ...l.target }));
  assert.deepEqual(linked, [
    { kind: 'property', source: 'events', name: 'ad_type_of_event_data' }, // a bare name resolved to its ONE source
    { kind: 'property', source: 'users', name: 'country' },
    { kind: 'event', source: 'events', name: 'ad_finished' },
    { kind: 'model', source: 'users' },
    { kind: 'term', term: 'ad format' }, // an unmatched phrase is kept as a free term
  ]);
  assert.deepEqual(out.unresolved_terms, ['ad format']);
  // links normalise (string → { url }); aliases pass through.
  assert.deepEqual(out.links, [{ url: 'https://confluence/ads' }, { url: 'https://dash/ads', title: 'Ads dashboard' }]);
  assert.deepEqual(out.aliases, ['ad format', 'ad type']);
});

// A recorded finding SURFACES on every linked semantic_index view + in search by alias.
test('a recorded finding surfaces through semantic_index (views + search) by its links/aliases', async () => {
  const e = engine();
  const note = "'ad format' is ad_type_of_event_data (rewarded/interstitial/banner), only on ad_started/ad_finished.";
  const rec = (await e.memory({ action: 'record', notes: [{ note, targets: [{ source: 'events', name: 'ad_type_of_event_data' }, { source: 'events', name: 'ad_finished' }, { source: 'users' }], aliases: ['ad format'] }] })).notes[0];

  // { property } — the event property it is about.
  const prop = await e.semantic_index({ source: 'events', property: 'ad_type_of_event_data' });
  assert.ok(prop.memory?.some((m) => m.id === rec.id && m.note === note), 'note attached to the property view');
  const attached = prop.memory.find((m) => m.id === rec.id);
  assert.ok(attached.about.some((a) => a.kind === 'property' && a.source === 'events' && a.name === 'ad_type_of_event_data'));

  // { event } — the carrying event.
  const ev = await e.semantic_index({ source: 'events', event: 'ad_finished' });
  assert.ok(ev.memory?.some((m) => m.id === rec.id), 'note attached to the event view');

  // { model } — a model-level link.
  const um = await e.semantic_index({ model: 'users' });
  assert.ok(um.memory?.some((m) => m.id === rec.id), 'note attached to the model view');

  // { search } by the ALIAS the user used → resolves back to the finding (+ the real field).
  const s = await e.semantic_index({ search: 'ad format' });
  assert.ok(s.memory_matches?.some((m) => m.id === rec.id && m.about.some((a) => a.source === 'events' && a.name === 'ad_type_of_event_data')), 'alias search resurfaces the note pointing at the real field');

  // an UNlinked property carries no memory.
  const other = await e.semantic_index({ source: 'events', property: 'level_id_of_event_data' });
  assert.equal(other.memory, undefined, 'unrelated property has no memory');
});

// A { source, name } attribute finding surfaces on that attribute's view.
test('memory linked to a users attribute surfaces on its property view', async () => {
  const e = engine();
  const rec = (await e.memory({ action: 'record', notes: [{ note: 'country is ISO-3166 alpha-2 on dim_users.', targets: [{ source: 'users', name: 'country' }] }] })).notes[0];
  const attr = await e.semantic_index({ source: 'users', property: 'country' });
  assert.ok(attr.memory?.some((m) => m.id === rec.id), 'attribute view carries the note');
});

// read (all + about one entity, search) through semantic_index, forget through memory — the lifecycle round-trips the stored data.
test('memory notes / search / forget round-trip', async () => {
  const e = engine();
  const a = (await e.memory({ action: 'record', notes: [{ note: 'finding A about ads', targets: [{ source: 'events', name: 'ad_type_of_event_data' }], aliases: ['ad format'] }] })).notes[0];
  const b = (await e.memory({ action: 'record', notes: [{ note: 'finding B about country', targets: [{ source: 'users', name: 'country' }] }] })).notes[0];

  const all = await listNotes(e);
  assert.equal(all.total, 2);
  assert.ok(all.notes.some((n) => n.id === a.id) && all.notes.some((n) => n.id === b.id));

  const byTarget = await listNotes(e, { source: 'events', name: 'ad_type_of_event_data' });
  assert.equal(byTarget.notes.length, 1);
  assert.equal(byTarget.notes[0].id, a.id);

  const found = await searchNotes(e, 'country');
  assert.equal(found.semantic, false, 'no embedder → fuzzy-only mode reported');
  assert.ok(found.notes.some((n) => n.id === b.id));
  // search also matches an alias.
  assert.ok((await searchNotes(e, 'ad format')).notes.some((n) => n.id === a.id));
  // FUZZY: a mistyped query still finds the note (typo-tolerant via the Fuse subsystem).
  assert.ok((await searchNotes(e, 'cuntry')).notes.some((n) => n.id === b.id), 'typo "cuntry" still finds the country note');
  // fuzzy:false makes the SAME typo miss (exact-substring only).
  assert.ok(!(await searchNotes(e, 'cuntry', false)).notes.some((n) => n.id === b.id), 'fuzzy:false → typo no longer matches');

  assert.equal((await e.memory({ action: 'forget', id: a.id })).forgotten, true);
  assert.equal((await listNotes(e)).total, 1, 'forgotten note is gone');
});

// The original business `question` is stored, echoed, surfaced — and embedded with the note.
test('memory records the business question and surfaces it', async () => {
  const e = engine();
  const rec = (await e.memory({ action: 'record', notes: [{ note: 'ad_type_of_event_data carries the ad format', question: 'which ad format drives the most rewarded revenue?', targets: [{ source: 'events', name: 'ad_type_of_event_data' }] }] })).notes[0];
  assert.equal(rec.question, 'which ad format drives the most rewarded revenue?', 'question echoed on record');
  // it travels onto the views + listings.
  const prop = await e.semantic_index({ source: 'events', property: 'ad_type_of_event_data' });
  assert.equal(prop.memory.find((m) => m.id === rec.id).question, 'which ad format drives the most rewarded revenue?');
  assert.equal((await listNotes(e)).notes.find((n) => n.id === rec.id).question, 'which ad format drives the most rewarded revenue?');
});

// SEMANTIC search (embedder configured): a query finds a same-meaning note with NO shared
// words — and the SAME query under fuzzy-only does NOT. Proves the embedding path adds recall.
test('semantic memory search finds a same-meaning note with no shared words', async () => {
  const sem = engineWith(stubEmbedder());
  // the business QUESTION is embedded with the note (note text alone shares no "revenue" word).
  const mon = (await sem.memory({ action: 'record', notes: [{ note: 'use ad_type to split the metric', question: 'which ad format makes the most money?', aliases: ['monetization'], targets: [{ source: 'events', name: 'price_in_usd_of_event_data' }] }] })).notes[0];
  const tut = (await sem.memory({ action: 'record', notes: [{ note: 'the onboarding tutorial has 5 steps', targets: [{ source: 'events', name: 'tutorial' }] }] })).notes[0];

  const s = await searchNotes(sem, 'revenue problems');
  assert.equal(s.semantic, true, 'embedder configured → semantic mode reported');
  assert.ok(s.notes.some((n) => n.id === mon.id), 'semantic search surfaces the note via its embedded business question (no shared words in the note text)');
  assert.ok(!s.notes.some((n) => n.id === tut.id), 'the unrelated tutorial note is below the similarity floor');

  // Without an embedder, the same query (no lexical overlap) does NOT find it.
  const fuzzy = engine();
  await fuzzy.memory({ action: 'record', notes: [{ note: 'IAP purchases are failing for some payers', aliases: ['monetization'], targets: [{ source: 'events', name: 'price_in_usd_of_event_data' }] }] });
  const f = await searchNotes(fuzzy, 'revenue problems');
  assert.ok(!f.notes.some((n) => n.note.includes('IAP purchases')), 'fuzzy-only misses the same-meaning note (proves semantic added the recall)');
});

// Regression (test report 2026-06-13 #7): a multi-word phrase lifted from the NOTE body —
// not contiguous, not an alias — must still be found (token-coverage lexical match).
test('search finds a multi-word phrase from the note body (interleaved words)', async () => {
  const e = engine(); // no embedder → lexical only (the path that previously missed)
  const rec = (await e.memory({ action: 'record', notes: [{ note: 'action=record требует note без target, но с targets/question/aliases; одиночный target в record невалиден.', targets: [{ term: 'betti_test' }], aliases: ['memory test'] }] })).notes[0];
  // the query words appear in the note but with "в record" interleaved — not a substring.
  const r = await searchNotes(e, 'одиночный target невалиден');
  assert.equal(r.semantic, false, 'no embedder → semantic honestly reported false');
  assert.ok(r.notes.some((n) => n.id === rec.id), 'token-coverage finds the phrase from the note body');
  // a query whose words are NOT (mostly) in any note still returns nothing.
  assert.equal((await searchNotes(e, 'completely unrelated zzz')).notes.length, 0);
});

// Honest semantic flag (test report #B): a configured-but-FAILING embedder must report
// semantic:false + a reason, NOT a misleading semantic:true — while lexical still works.
test('a failing embedder reports semantic:false + semantic_error (not a silent true)', async () => {
  const boom = { model: 'boom', embed: async () => { throw new Error('provider unreachable'); } };
  const e = engineWith(boom);
  const rec = (await e.memory({ action: 'record', notes: [{ note: 'country is ISO-3166 alpha-2', targets: [{ source: 'users', name: 'country' }], aliases: ['geo'] }] })).notes[0];
  const r = await searchNotes(e, 'geo');
  assert.equal(r.semantic, false, 'embedding failed → semantic reported false');
  assert.ok(typeof r.semantic_error === 'string' && r.semantic_error.includes('provider unreachable'), 'the failure reason is surfaced');
  assert.ok(r.notes.some((n) => n.id === rec.id), 'lexical search still works despite the embedder failure');
  // the SAME failure is surfaced via the semantic_index({ search }) path too (not hidden).
  const si = await e.semantic_index({ search: 'geo' });
  assert.ok(typeof si.memory_semantic_error === 'string' && si.memory_semantic_error.includes('provider unreachable'), 'semantic_index surfaces the memory embedding error');
});

// Cross-language via bilingual aliases: a Russian query finds an English note (and vice
// versa) on the pure LEXICAL path (no embedder) — because the RU phrasing is in `aliases`.
// (The semantic path additionally bridges languages via a multilingual embedder.)
test('bilingual aliases bridge languages on the lexical path', async () => {
  const e = engine(); // no embedder → lexical only
  const rec = (await e.memory({ action: 'record', notes: [{ note: 'media_source=organic means non-paid installs', aliases: ['organic traffic', 'органический трафик', 'органика'] }] })).notes[0];
  assert.ok((await searchNotes(e, 'органика')).notes.some((n) => n.id === rec.id), 'RU query finds the EN note via its RU alias');
  assert.ok((await searchNotes(e, 'organic traffic')).notes.some((n) => n.id === rec.id), 'EN query still finds it');
});

// Overview reports the stored count once anything is saved.
test('semantic_index overview surfaces the memory count', async () => {
  const e = engine();
  assert.equal((await e.semantic_index()).memory, undefined, 'no memory key when nothing is saved');
  await e.memory({ action: 'record', notes: [{ note: 'a finding', targets: [{ source: 'events', name: 'ad_type_of_event_data' }] }] });
  const ov = await e.semantic_index();
  assert.equal(ov.memory.notes, 1, 'overview reports the saved count');
});

// Strict validation: each action accepts only its fields; bad input is rejected.
test('memory strict input validation', async () => {
  const e = engine();
  await assert.rejects(() => e.memory({ action: 'record' }), /invalid input/, 'record needs a note');
  await assert.rejects(() => e.memory({ action: 'record', query: 'y', notes: [{ note: 'x' }] }), /invalid input/, 'record forbids query');
  await assert.rejects(() => e.memory({ action: 'search', query: 'x' }), /invalid input/, 'reading is semantic_index\'s: memory has no search');
  await assert.rejects(() => e.memory({ action: 'forget' }), /invalid input/, 'forget needs an id');
  await assert.rejects(() => e.memory({ action: 'list' }), /invalid input/, 'reading is semantic_index\'s: memory has no list');
  await assert.rejects(() => e.memory({ action: 'bogus' }), /invalid input/, 'unknown action rejected by enum');
  await assert.rejects(() => e.memory({ action: 'forget', id: 'nope_missing' }), /no memory note/, 'forgetting a missing id errors');
});

test('memory record of several notes saves them all, or none when one is wrong', async () => {
  const e = engine();
  await assert.rejects(
    () => e.memory({ action: 'record', notes: [{ note: 'country is ISO-3166', targets: [{ source: 'users', name: 'country' }] }, { note: 'bad', targets: [{ source: 'nope' }] }] }),
    /invalid input|notes\[1\]/,
  );
  assert.equal((await e.semantic_index({ notes: true })).total, 0, 'nothing was saved from the refused batch');
  const two = await e.memory({ action: 'record', notes: [
    { note: 'country is ISO-3166 alpha-2', targets: [{ source: 'users', name: 'country' }] },
    { note: 'ad_type carries the ad format', targets: [{ source: 'events', name: 'ad_type_of_event_data' }], aliases: ['ad format'] },
  ] });
  assert.equal(two.notes.length, 2);
  const listed = await e.semantic_index({ notes: true });
  assert.equal(listed.total, 2);
  assert.deepEqual(listed.notes.map((n) => n.id).sort(), two.notes.map((n) => n.id).sort());
  await assert.rejects(() => e.memory({ action: 'record', note: 'x', notes: [{ note: 'y' }, { note: 'z' }] }), /invalid input/, 'one note or several, not both');
});

// An entity is ALWAYS { source, name }; a phrase is { term }. Neither a bare name nor the glued
// '<source>.<name>' spelling exists, so a finding is never linked by a string that has to be taken
// apart — or silently kept as a free phrase, which would link it to nothing.
test('memory target: an entity is { source, name }, a phrase is { term }, and a bare string is neither', async () => {
  const e = engine();
  await assert.rejects(
    () => e.memory({ action: 'record', notes: [{ note: 'x', targets: ['users.country'] }] }),
    /must be exactly one of: \{ source: "events", name\? \}[^;]*\| \{ term \}/,
  );
  await assert.rejects(
    () => e.memory({ action: 'record', notes: [{ note: 'x', targets: ['country'] }] }),
    /must be exactly one of: \{ source: "events", name\? \}[^;]*\| \{ term \}/,
  );
  // …and a phrase says it is one
  const ok = (await e.memory({ action: 'record', notes: [{ note: 'crashes spiked in 2.4.0', targets: [{ term: 'v2.4 rollout' }] }] })).notes[0];
  assert.deepEqual(ok.linked_to.map((l) => l.kind), ['term']);
  assert.deepEqual(ok.unresolved_terms, ['v2.4 rollout']);
});

// A target is STORED as what it names, not as a key that has to be taken apart to read it back.
// (The key exists only to look the note up, and nothing ever parses it.)
test('a memory target is stored structurally and read back without decoding', async () => {
  const store = openStore({});
  const e = engineWithStore(store);
  const rec = (await e.memory({ action: 'record', notes: [{ note: 'ad_type carries the format', targets: [{ source: 'events', name: 'ad_type_of_event_data' }, { source: 'users' }, { term: 'совсем свободная фраза' }] }] })).notes[0];
  const stored = store.memory.get(rec.id).targets;
  assert.deepEqual(stored, [
    { kind: 'property', source: 'events', name: 'ad_type_of_event_data' },
    { kind: 'model', source: 'users' },
    { kind: 'term', term: 'совсем свободная фраза' },
  ], 'each target keeps its parts');
  // what comes back out is the same parts — on the note, and as the thing you can pass back in
  const listed = await listNotes(e);
  assert.deepEqual(listed.notes.find((n) => n.id === rec.id).about, stored);
  const again = await listNotes(e, { source: 'events', name: 'ad_type_of_event_data' });
  assert.deepEqual(again.about, { source: 'events', name: 'ad_type_of_event_data' });
  assert.ok(again.notes.some((n) => n.id === rec.id));
});

test('a note an earlier server stored with bare-string targets is read with each one as the phrase it is', async () => {
  const { MemoryStore } = await import('../../src/memory.js');
  const store = openStore({});
  store.memory.add({ id: 'old1', note: 'ad_type is empty on purchases', targets: ['property:events.ad_type', 'model:users'], created_at: 1 });
  const mem = new MemoryStore({ store });
  assert.deepEqual(mem.get('old1').targets, [{ kind: 'term', term: 'property:events.ad_type' }, { kind: 'term', term: 'model:users' }]);
  assert.deepEqual(mem.forTargets(['term:model:users']).map((n) => n.id), ['old1']);
  assert.deepEqual((await mem.search('ad_type', { fuzzy: false })).notes.map((n) => n.id), ['old1']);
});
