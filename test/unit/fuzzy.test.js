import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rankFuzzy } from '../../src/fuzzy.js';
import { ValueIndex } from '../../src/value-index.js';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';

// ── rankFuzzy adapter (over Fuse.js) ──────────────────────────────────────────
test('rankFuzzy: exact tier first (score 1), then fuzzy by score; gate + tiebreak', () => {
  const items = ['country', 'county', 'continent', 'media_source'];
  const ranked = rankFuzzy('country', items, { fields: (x) => [x], tiebreak: (x) => x });
  assert.equal(ranked[0].item, 'country');
  assert.equal(ranked[0].match, 'exact');
  assert.equal(ranked[0].score, 1);
  // 'county' (one deletion) is a fuzzy hit; 'media_source' is unrelated → filtered out.
  assert.ok(ranked.some((r) => r.item === 'county' && r.match === 'fuzzy'));
  assert.ok(!ranked.some((r) => r.item === 'media_source'));
  // every kept hit has a similarity score in (0,1].
  for (const r of ranked) assert.ok(r.score > 0 && r.score <= 1);
  // limit is honoured.
  assert.equal(rankFuzzy('country', items, { fields: (x) => [x], limit: 1 }).length, 1);
});

test('rankFuzzy: substring is exact even with fuzzy disabled; short queries are exact-only', () => {
  const items = ['revenue_of_event_data', 'review_score'];
  // fuzzy disabled (threshold > 1): only substring hits, tagged exact.
  const exactOnly = rankFuzzy('revenu', items, { fields: (x) => [x], threshold: 1.01 });
  assert.deepEqual(exactOnly.map((r) => r.item), ['revenue_of_event_data']);
  assert.equal(exactOnly[0].match, 'exact');
  // a true typo (not a substring) finds nothing when fuzzy is off.
  assert.equal(rankFuzzy('reveune', items, { fields: (x) => [x], threshold: 1.01 }).length, 0);
  // <3-char queries never fuzz: 'co' is not a substring of 'platform' → no match.
  assert.equal(rankFuzzy('co', ['platform'], { fields: (x) => [x] }).length, 0);
});

// ── ValueIndex fuzzy value fallback (exact substring → fuzzy on miss) ──────────
test('ValueIndex.searchValues: exact substring tier, then fuzzy fallback on a typo', () => {
  const idx = new ValueIndex();
  idx.upsertProperty('users', 'country', { distinctCount: 3, totalCount: 24, values: [{ value: 'Germany', freq: 10 }, { value: 'France', freq: 8 }, { value: 'Spain', freq: 6 }] });
  // exact substring (case-insensitive) → match 'exact', score 1.
  const exact = idx.searchValues('ger');
  assert.ok(exact[0].value === 'Germany' && exact[0].match === 'exact' && exact[0].score === 1);
  // typo not present as a substring → fuzzy fallback still surfaces Germany.
  const typo = idx.searchValues('germny');
  assert.ok(typo.some((v) => v.value === 'Germany' && v.match === 'fuzzy'), JSON.stringify(typo));
  // fuzzy disabled → the typo finds nothing.
  assert.equal(idx.searchValues('germny', 20, { fuzzy: false }).length, 0);
  idx.close();
});

// ── engine { search } integration (schema vocabulary, no warehouse) ───────────
const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));
function engine() {
  const catalog = loadCatalog(CATALOG, {});
  return new Engine({ catalog, contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'fz-')) }) });
}

test('semantic_index({ search }) is fuzzy by default over property names', async () => {
  const e = engine();
  // exact substring → match:'exact', score 1.
  const exact = await e.semantic_index({ search: 'revenue' });
  const rev = exact.property_matches.find((p) => p.property === 'revenue_of_event_data');
  assert.ok(rev && rev.match === 'exact' && rev.score === 1);
  // a real typo (transposition, NOT a substring): "reveune" → revenue via fuzzy.
  const typo = await e.semantic_index({ search: 'reveune' });
  const fuzzyHit = typo.property_matches.find((p) => p.property === 'revenue_of_event_data');
  assert.ok(fuzzyHit, `expected fuzzy hit for 'reveune'; got ${JSON.stringify(typo.property_matches.map((p) => p.property))}`);
  assert.equal(fuzzyHit.match, 'fuzzy');
  assert.ok(fuzzyHit.score > 0 && fuzzyHit.score < 1);
  assert.equal(typo.fuzzy, true);
});

test('semantic_index({ search }) fuzzy-matches event names', async () => {
  const e = engine();
  const ev = await e.semantic_index({ search: 'tutoral' }); // typo of "tutorial"
  assert.ok(ev.event_names.some((m) => m.event === 'tutorial' && m.match === 'fuzzy'), JSON.stringify(ev.event_names));
});

test('semantic_index({ search, fuzzy: false }) restricts to exact substring', async () => {
  const e = engine();
  const out = await e.semantic_index({ search: 'revenu', fuzzy: false });
  assert.equal(out.fuzzy, false);
  const m = out.property_matches.find((p) => p.property === 'revenue_of_event_data');
  assert.ok(m && m.match === 'exact'); // 'revenu' IS a substring → exact
  // a true typo finds nothing with fuzzy off.
  const none = await e.semantic_index({ search: 'reveneu', fuzzy: false });
  assert.ok(!none.property_matches.some((p) => p.property === 'revenue_of_event_data'));
  assert.ok(none.recommendations.some((r) => /no catalog match/i.test(r)));
});

test('semantic_index: fuzzy belongs to { search } and nowhere else', async () => {
  const e = engine();
  // the { model } view does not take `fuzzy` — that is the SCHEMA's statement, not a check
  await assert.rejects(() => e.semantic_index({ model: 'events', fuzzy: true }), /unexpected property 'fuzzy'/);
});

test('semantic_index({ search }) flags fuzzy-only results as did-you-mean', async () => {
  const e = engine();
  const out = await e.semantic_index({ search: 'tutoral' });
  const anyExact = [...out.event_names, ...out.property_matches, ...out.dimension_matches, ...out.recipe_matches].some((m) => m.match === 'exact');
  assert.equal(anyExact, false);
  assert.ok(out.recommendations.some((r) => /closest matches by similarity/i.test(r)));
});
