import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { levenshtein, fuzzyScore, rankFuzzy } from '../../src/fuzzy.js';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';

// ── pure scorer ──────────────────────────────────────────────────────────────
test('levenshtein basic distances', () => {
  assert.equal(levenshtein('', ''), 0);
  assert.equal(levenshtein('abc', 'abc'), 0);
  assert.equal(levenshtein('kitten', 'sitting'), 3);
  assert.equal(levenshtein('germny', 'germany'), 1);
});

test('fuzzyScore: exact substring is 1; typos score high; unrelated low', () => {
  assert.equal(fuzzyScore('retention', 'nday_retention'), 1); // substring
  assert.equal(fuzzyScore('COUNTRY', 'users.country'), 1); // case-insensitive substring
  // one-char typo against the closest token scores high...
  assert.ok(fuzzyScore('retenton', 'retention') > 0.8);
  assert.ok(fuzzyScore('germny', 'Germany') > 0.8);
  // ...token-aware: a typo'd word matches the nearest WORD of a longer string.
  assert.ok(fuzzyScore('convrsion', 'visit_to_purchase_conversion') > 0.6);
  // unrelated stays low (below the 0.6 gate).
  assert.ok(fuzzyScore('zzzz', 'country') < 0.6);
  // too-short queries don't fuzz (exact-only): 'co' is not a substring of 'platform'.
  assert.equal(fuzzyScore('co', 'platform'), 0);
});

test('rankFuzzy: exact tier first, then by score, stable tiebreak', () => {
  const items = ['country', 'county', 'continent', 'media_source'];
  const ranked = rankFuzzy('country', items, { fields: (x) => [x], tiebreak: (x) => x });
  assert.equal(ranked[0].item, 'country'); // exact substring
  assert.equal(ranked[0].match, 'exact');
  assert.equal(ranked[0].score, 1);
  // 'county' (one deletion) is a fuzzy hit; 'media_source' is filtered out.
  assert.ok(ranked.some((r) => r.item === 'county' && r.match === 'fuzzy'));
  assert.ok(!ranked.some((r) => r.item === 'media_source'));
  // threshold gate + limit.
  assert.equal(rankFuzzy('country', items, { fields: (x) => [x], limit: 1 }).length, 1);
});

// ── engine { search } integration (schema vocabulary, no warehouse) ───────────
const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));
function engine() {
  const catalog = loadCatalog(CATALOG, {});
  return new Engine({ catalog, contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'fz-')) }) });
}

test('semantic_index({ search }) is fuzzy by default over property names', async () => {
  const e = engine();
  // exact substring still works and is marked exact with score 1.
  const exact = await e.semantic_index({ search: 'revenue' });
  const rev = exact.property_matches.find((p) => p.property === 'revenue_of_event_data');
  assert.ok(rev && rev.match === 'exact' && rev.score === 1);
  // a real typo (transposition, NOT a substring): "reveune" → revenue via fuzzy.
  const typo = await e.semantic_index({ search: 'reveune' });
  const fuzzyHit = typo.property_matches.find((p) => p.property === 'revenue_of_event_data');
  assert.ok(fuzzyHit, `expected fuzzy hit for 'reveune'; got ${JSON.stringify(typo.property_matches.map((p) => p.property))}`);
  assert.equal(fuzzyHit.match, 'fuzzy');
  assert.ok(fuzzyHit.score >= 0.6 && fuzzyHit.score < 1);
  assert.equal(typo.fuzzy, true);
});

test('semantic_index({ search }) fuzzy-matches event names and recipes', async () => {
  const e = engine();
  // event name typo: "tutoral" → tutorial.
  const ev = await e.semantic_index({ search: 'tutoral' });
  assert.ok(ev.event_names.some((m) => m.event === 'tutorial' && m.match === 'fuzzy'));
});

test('semantic_index({ search, fuzzy: false }) restricts to exact substring', async () => {
  const e = engine();
  const out = await e.semantic_index({ search: 'revenu', fuzzy: false });
  assert.equal(out.fuzzy, false);
  // 'revenu' IS a substring of 'revenue_of_event_data' → still found, but as exact.
  const m = out.property_matches.find((p) => p.property === 'revenue_of_event_data');
  assert.ok(m && m.match === 'exact');
  // a true typo that is NOT a substring finds nothing with fuzzy off.
  const none = await e.semantic_index({ search: 'reveneu', fuzzy: false });
  assert.ok(!none.property_matches.some((p) => p.property === 'revenue_of_event_data'));
  assert.ok(none.recommendations.some((r) => /no catalog match/i.test(r)));
});

test('semantic_index: fuzzy only applies to { search }', async () => {
  const e = engine();
  await assert.rejects(() => e.semantic_index({ model: 'events', fuzzy: true }), /fuzzy only applies/);
});

test('semantic_index({ search }) flags fuzzy-only results as did-you-mean', async () => {
  const e = engine();
  const out = await e.semantic_index({ search: 'tutoral' }); // no exact hit anywhere
  const anyExact = [...out.event_names, ...out.property_matches, ...out.dimension_matches, ...out.recipe_matches].some((m) => m.match === 'exact');
  assert.equal(anyExact, false);
  assert.ok(out.recommendations.some((r) => /closest matches by similarity/i.test(r)));
});
