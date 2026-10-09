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

// record RESOLVES what each note is about to a catalog entity and answers it in the form it was written in.
test('memory record resolves what a note is about to catalog entities (property/attr/event/model/term)', async () => {
  const e = engine();
  const about = [{ source: 'events', property: 'ad_type_of_event_data' }, { source: 'users', property: 'country' }, { source: 'events', event: 'ad_finished' }, { source: 'users' }, { term: 'ad format' }];
  const out = (await e.memory({ action: 'record', notes: [{ note: "'ad format' = the event_data property ad_type_of_event_data, only on ad_started/ad_finished; values rewarded/interstitial/banner.", about, aliases: ['ad format', 'ad type'], links: [{ url: 'https://confluence/ads' }, { url: 'https://dash/ads', title: 'Ads dashboard' }] }] })).notes[0];
  assert.ok(out.id, 'returns a note id');
  // answered as written — each item is what a { notes, about } filter takes — with the view each surfaces in
  assert.deepEqual(out.about, about);
  assert.deepEqual(out.surfaces_in, [
    "semantic_index({ request: { source: 'events', property: 'ad_type_of_event_data' } })",
    "semantic_index({ request: { source: 'users', property: 'country' } })",
    "semantic_index({ request: { source: 'events', event: 'ad_finished' } })",
    "semantic_index({ request: { source: 'users' } })",
    'semantic_index({ request: { search: "ad format" } })',
  ]);
  assert.deepEqual(out.unresolved_terms, ['ad format']);
  // each item of the answer filters the listing to this note
  for (const a of out.about) assert.ok((await listNotes(e, a)).notes.some((n) => n.id === out.id), JSON.stringify(a));
  assert.deepEqual(out.links, [{ url: 'https://confluence/ads' }, { url: 'https://dash/ads', title: 'Ads dashboard' }]);
  assert.deepEqual(out.aliases, ['ad format', 'ad type']);
});

// One spelling each: a link is { url, title? } (a bare URL string is not one), and an alias is a
// non-blank phrase given once (a blank or a repeated one would be dropped silently, so it is refused).
test('memory links are { url, title? } only; aliases are unique and non-blank', async () => {
  const e = engine();
  await assert.rejects(() => e.memory({ action: 'record', notes: [{ note: 'x', links: ['https://confluence/ads'] }] }), /invalid input/);
  await assert.rejects(() => e.memory({ action: 'record', notes: [{ note: 'x', aliases: ['ad format', 'ad format'] }] }), /invalid input/);
  await assert.rejects(() => e.memory({ action: 'record', notes: [{ note: 'x', aliases: ['   '] }] }), /invalid input/);
  await assert.rejects(() => e.memory({ action: 'record', notes: [{ note: 'x', aliases: [''] }] }), /invalid input/);
  const out = (await e.memory({ action: 'record', notes: [{ note: 'x', aliases: [' ad format '] }] })).notes[0];
  assert.deepEqual(out.aliases, ['ad format'], 'kept trimmed');
});

// A recorded finding SURFACES on every linked semantic_index view + in search by alias.
test('a recorded finding surfaces through semantic_index (views + search) by its links/aliases', async () => {
  const e = engine();
  const note = "'ad format' is ad_type_of_event_data (rewarded/interstitial/banner), only on ad_started/ad_finished.";
  const rec = (await e.memory({ action: 'record', notes: [{ note, about: [{ source: 'events', property: 'ad_type_of_event_data' }, { source: 'events', event: 'ad_finished' }, { source: 'users' }], aliases: ['ad format'] }] })).notes[0];

  // { property } — the event property it is about.
  const prop = await e.semantic_index({ source: 'events', property: 'ad_type_of_event_data' });
  assert.ok(prop.memory?.some((m) => m.id === rec.id && m.note === note), 'note attached to the property view');
  const attached = prop.memory.find((m) => m.id === rec.id);
  assert.deepEqual(attached.about, [{ source: 'events', property: 'ad_type_of_event_data' }, { source: 'events', event: 'ad_finished' }, { source: 'users' }]);

  // { event } — the carrying event.
  const ev = await e.semantic_index({ source: 'events', event: 'ad_finished' });
  assert.ok(ev.memory?.some((m) => m.id === rec.id), 'note attached to the event view');

  // { source } — a model-level link.
  const um = await e.semantic_index({ source: 'users' });
  assert.ok(um.memory?.some((m) => m.id === rec.id), 'note attached to the model view');

  // { search } by the ALIAS the user used → resolves back to the finding (+ the real field).
  const s = await e.semantic_index({ search: 'ad format' });
  assert.ok(s.memory_matches?.some((m) => m.id === rec.id && m.about.some((a) => a.source === 'events' && a.property === 'ad_type_of_event_data')), 'alias search resurfaces the note pointing at the real field');

  // an UNlinked property carries no memory.
  const other = await e.semantic_index({ source: 'events', property: 'level_id_of_event_data' });
  assert.equal(other.memory, undefined, 'unrelated property has no memory');
});

// A { source, property } attribute finding surfaces on that attribute's view.
test('memory linked to a users attribute surfaces on its property view', async () => {
  const e = engine();
  const rec = (await e.memory({ action: 'record', notes: [{ note: 'country is ISO-3166 alpha-2 on dim_users.', about: [{ source: 'users', property: 'country' }] }] })).notes[0];
  const attr = await e.semantic_index({ source: 'users', property: 'country' });
  assert.ok(attr.memory?.some((m) => m.id === rec.id), 'attribute view carries the note');
});

// read (all + about one entity, search) through semantic_index, forget through memory — the lifecycle round-trips the stored data.
test('memory notes / search / forget round-trip', async () => {
  const e = engine();
  const a = (await e.memory({ action: 'record', notes: [{ note: 'finding A about ads', about: [{ source: 'events', property: 'ad_type_of_event_data' }], aliases: ['ad format'] }] })).notes[0];
  const b = (await e.memory({ action: 'record', notes: [{ note: 'finding B about country', about: [{ source: 'users', property: 'country' }] }] })).notes[0];

  const all = await listNotes(e);
  assert.equal(all.total, 2);
  assert.ok(all.notes.some((n) => n.id === a.id) && all.notes.some((n) => n.id === b.id));

  const byTarget = await listNotes(e, { source: 'events', property: 'ad_type_of_event_data' });
  assert.deepEqual(byTarget.about, { source: 'events', property: 'ad_type_of_event_data' }, 'answered as asked');
  assert.equal(byTarget.total, 1);
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
  const rec = (await e.memory({ action: 'record', notes: [{ note: 'ad_type_of_event_data carries the ad format', question: 'which ad format drives the most rewarded revenue?', about: [{ source: 'events', property: 'ad_type_of_event_data' }] }] })).notes[0];
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
  const mon = (await sem.memory({ action: 'record', notes: [{ note: 'use ad_type to split the metric', question: 'which ad format makes the most money?', aliases: ['monetization'], about: [{ source: 'events', property: 'price_in_usd_of_event_data' }] }] })).notes[0];
  const tut = (await sem.memory({ action: 'record', notes: [{ note: 'the onboarding tutorial has 5 steps', about: [{ source: 'events', event: 'tutorial' }] }] })).notes[0];

  const s = await searchNotes(sem, 'revenue problems');
  assert.equal(s.semantic, true, 'embedder configured → semantic mode reported');
  assert.ok(s.notes.some((n) => n.id === mon.id), 'semantic search surfaces the note via its embedded business question (no shared words in the note text)');
  assert.ok(!s.notes.some((n) => n.id === tut.id), 'the unrelated tutorial note is below the similarity floor');

  // Without an embedder, the same query (no lexical overlap) does NOT find it.
  const fuzzy = engine();
  await fuzzy.memory({ action: 'record', notes: [{ note: 'IAP purchases are failing for some payers', aliases: ['monetization'], about: [{ source: 'events', property: 'price_in_usd_of_event_data' }] }] });
  const f = await searchNotes(fuzzy, 'revenue problems');
  assert.ok(!f.notes.some((n) => n.note.includes('IAP purchases')), 'fuzzy-only misses the same-meaning note (proves semantic added the recall)');
});

// Regression (test report 2026-06-13 #7): a multi-word phrase lifted from the NOTE body —
// not contiguous, not an alias — must still be found (token-coverage lexical match).
test('search finds a multi-word phrase from the note body (interleaved words)', async () => {
  const e = engine(); // no embedder → lexical only (the path that previously missed)
  const rec = (await e.memory({ action: 'record', notes: [{ note: 'action=record требует note без target, но с targets/question/aliases; одиночный target в record невалиден.', about: [{ term: 'betti_test' }], aliases: ['memory test'] }] })).notes[0];
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
  const rec = (await e.memory({ action: 'record', notes: [{ note: 'country is ISO-3166 alpha-2', about: [{ source: 'users', property: 'country' }], aliases: ['geo'] }] })).notes[0];
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
  await e.memory({ action: 'record', notes: [{ note: 'a finding', about: [{ source: 'events', property: 'ad_type_of_event_data' }] }] });
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
    () => e.memory({ action: 'record', notes: [{ note: 'country is ISO-3166', about: [{ source: 'users', property: 'country' }] }, { note: 'bad', about: [{ source: 'nope' }] }] }),
    /invalid input|notes\[1\]/,
  );
  assert.equal((await e.semantic_index({ notes: true })).total, 0, 'nothing was saved from the refused batch');
  const two = await e.memory({ action: 'record', notes: [
    { note: 'country is ISO-3166 alpha-2', about: [{ source: 'users', property: 'country' }] },
    { note: 'ad_type carries the ad format', about: [{ source: 'events', property: 'ad_type_of_event_data' }], aliases: ['ad format'] },
  ] });
  assert.equal(two.notes.length, 2);
  const listed = await e.semantic_index({ notes: true });
  assert.equal(listed.total, 2);
  assert.deepEqual(listed.notes.map((n) => n.id).sort(), two.notes.map((n) => n.id).sort());
  await assert.rejects(() => e.memory({ action: 'record', note: 'x', notes: [{ note: 'y' }, { note: 'z' }] }), /invalid input/, 'one note or several, not both');
});

// An entity is ALWAYS its source and what it is — { source, property }, { source, event }, { source }
// — and a phrase is { term }. Neither a bare name nor the glued '<source>.<name>' spelling exists, and
// a property and an event are told apart by their key, never by looking the name up.
test('memory about: an entity is { source, property | event }, a phrase is { term }, and a bare string is neither', async () => {
  const e = engine();
  await assert.rejects(
    () => e.memory({ action: 'record', notes: [{ note: 'x', about: ['users.country'] }] }),
    /must be exactly one of: \{ source: "events", property\? \}[^;]*\| \{ term \}/,
  );
  await assert.rejects(
    () => e.memory({ action: 'record', notes: [{ note: 'x', about: ['country'] }] }),
    /must be exactly one of: \{ source: "events", property\? \}[^;]*\| \{ term \}/,
  );
  // an event is not a property, nor a property an event: each is refused in the form that names it
  await assert.rejects(() => e.memory({ action: 'record', notes: [{ note: 'x', about: [{ source: 'events', property: 'ad_finished' }] }] }), /property` must be one of/);
  await assert.rejects(() => e.memory({ action: 'record', notes: [{ note: 'x', about: [{ source: 'events', event: 'ad_type_of_event_data' }] }] }), /event` must be one of/);
  // a dimension source has no events
  await assert.rejects(() => e.memory({ action: 'record', notes: [{ note: 'x', about: [{ source: 'users', event: 'ad_finished' }] }] }), /invalid input/);
  // the earlier { source, name } spelling is no form of it, and `targets` is told its name
  await assert.rejects(() => e.memory({ action: 'record', notes: [{ note: 'x', about: [{ source: 'users', name: 'country' }] }] }), /unexpected property 'name'/);
  await assert.rejects(() => e.memory({ action: 'record', notes: [{ note: 'x', targets: [{ source: 'users', property: 'country' }] }] }), /here that field is called 'about'/);
  // …and a phrase says it is one
  const ok = (await e.memory({ action: 'record', notes: [{ note: 'crashes spiked in 2.4.0', about: [{ term: 'v2.4 rollout' }] }] })).notes[0];
  assert.deepEqual(ok.about, [{ term: 'v2.4 rollout' }]);
  assert.deepEqual(ok.unresolved_terms, ['v2.4 rollout']);
});

// The listing pages like every other: a page of `limit`, `offset` where the previous one ended, and
// `next_offset` while more are kept — every note, or those about one entity, newest first.
test('semantic_index({ notes }) pages the notes, every one or those about one entity', async () => {
  const e = engine();
  const linked = new Set();
  for (let i = 0; i < 5; i += 1) {
    const { id } = (await e.memory({ action: 'record', notes: [{ note: `finding ${i}`, about: i < 3 ? [{ source: 'users', property: 'country' }] : [] }] })).notes[0];
    if (i < 3) linked.add(id);
  }
  // the order every page reads (newest first; notes kept in the same millisecond in one fixed order)
  const all = (await e.semantic_index({ notes: true })).notes.map((n) => n.id);
  assert.equal(all.length, 5);
  const first = await e.semantic_index({ notes: true, limit: 2 });
  assert.deepEqual([first.total, first.notes.map((n) => n.id), first.next_offset], [5, all.slice(0, 2), 2]);
  const last = await e.semantic_index({ notes: true, limit: 2, offset: 4 });
  assert.deepEqual([last.notes.map((n) => n.id), last.next_offset], [all.slice(4), undefined]);
  const about = { source: 'users', property: 'country' };
  const mine = all.filter((id) => linked.has(id));
  const page = await e.semantic_index({ notes: true, about, limit: 2, offset: 1 });
  assert.deepEqual(page.about, about);
  assert.deepEqual([page.total, page.notes.map((n) => n.id), page.next_offset], [3, mine.slice(1, 3), undefined]);
  const top = await e.semantic_index({ notes: true, about, limit: 1 });
  assert.deepEqual([top.notes.map((n) => n.id), top.next_offset], [mine.slice(0, 1), 1]);
});

// A target is STORED as what it names, not as a key that has to be taken apart to read it back.
// (The key exists only to look the note up, and nothing ever parses it.)
test('a memory target is stored structurally and read back without decoding', async () => {
  const store = openStore({});
  const e = engineWithStore(store);
  const rec = (await e.memory({ action: 'record', notes: [{ note: 'ad_type carries the format', about: [{ source: 'events', property: 'ad_type_of_event_data' }, { source: 'users' }, { term: 'совсем свободная фраза' }] }] })).notes[0];
  const stored = store.memory.get(rec.id).targets;
  assert.deepEqual(stored, [
    { kind: 'property', source: 'events', name: 'ad_type_of_event_data' },
    { kind: 'model', source: 'users' },
    { kind: 'term', term: 'совсем свободная фраза' },
  ], 'each target keeps its parts');
  // what comes back out is the same parts, written as the tools write them — the thing you can pass back in
  const listed = await listNotes(e);
  const shown = listed.notes.find((n) => n.id === rec.id).about;
  assert.deepEqual(shown, [{ source: 'events', property: 'ad_type_of_event_data' }, { source: 'users' }, { term: 'совсем свободная фраза' }]);
  for (const a of shown) {
    const again = await listNotes(e, a);
    assert.deepEqual(again.about, a);
    assert.ok(again.notes.some((n) => n.id === rec.id), JSON.stringify(a));
  }
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
