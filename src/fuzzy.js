// Fuzzy matching for catalog/vocabulary search, powered by Fuse.js (Bitap).
//
// Two layers:
//   FuzzyIndex — a REUSABLE index over a fixed item list. Build it ONCE for a static
//     corpus (the catalog never changes at runtime) and query it many times; the Fuse
//     index and the exact-substring corpus are built up front, not per search.
//   rankFuzzy — a one-shot convenience (build + search) for AD-HOC corpora that change,
//     e.g. the value-index candidate pool.
//
// Both return [{ item, score, match }] with the EXACT tier first:
//   tier 1  EXACT substring (case-insensitive) — always matches, ranked first, and the
//           ONLY tier when fuzzy is off;
//   tier 2  Fuse fuzzy — typo/approximate hits at/above the per-call similarity floor.
// Fuse scores are DISTANCES (0 = perfect … 1 = no match); we expose similarity =
// 1 − distance so callers reason in "how close", and gate by it per call.

import Fuse from 'fuse.js';

const norm = (s) => String(s ?? '').toLowerCase();
const round3 = (n) => Math.round(n * 1000) / 1000;
const MIN_FUZZY_LEN = 3; // queries shorter than this are matched exact-only (1–2 chars fuzz to noise)

// Build-time Fuse distance ceiling. Kept liberal so a single index serves any per-call
// similarity floor; the floor is applied by filtering results in search().
const FUSE_DISTANCE_CEILING = 0.6;

/**
 * Reusable fuzzy index over `items`. `keys` describe the string fields to match:
 *   [{ name, weight?, get(item) -> string | string[] }]
 * Higher weight = more influential (e.g. a name over a description). `tiebreak(item)`
 * gives a stable string for deterministic ordering within a tier.
 */
export class FuzzyIndex {
  constructor(items, { keys, tiebreak } = {}) {
    this.items = items;
    this._tiebreak = tiebreak;
    const docs = items.map((item, i) => {
      const d = { __i: i };
      for (const k of keys) d[k.name] = k.get(item);
      return d;
    });
    this._fuse = new Fuse(docs, {
      keys: keys.map((k) => ({ name: k.name, weight: k.weight ?? 1 })),
      includeScore: true,
      ignoreLocation: true, // match anywhere in the field, not only near the start
      threshold: FUSE_DISTANCE_CEILING,
      minMatchCharLength: MIN_FUZZY_LEN,
    });
    // Lowercased field strings per item, for the exact-substring tier (Fuse-independent
    // → exact hits are always found and deterministic, even for <3-char queries).
    this._exact = items.map((item) => keys.flatMap((k) => {
      const v = k.get(item);
      return (Array.isArray(v) ? v : [v]).map(norm);
    }));
  }

  /**
   * Rank items by similarity to `query`. Options: threshold (similarity floor in [0,1],
   * default 0.6), limit, fuzzy (default true — false = exact substring only).
   */
  search(query, { threshold = 0.6, limit, fuzzy = true } = {}) {
    const q = String(query ?? '').trim();
    if (!q) return [];
    const ql = norm(q);
    const tb = (item) => (this._tiebreak ? String(this._tiebreak(item)) : '');

    // tier 1 — exact substring.
    const exactIdx = new Set();
    const exact = [];
    this._exact.forEach((fields, i) => {
      if (fields.some((f) => f.includes(ql))) { exact.push({ item: this.items[i], score: 1, match: 'exact' }); exactIdx.add(i); }
    });
    exact.sort((a, b) => tb(a.item).localeCompare(tb(b.item)));

    // tier 2 — Fuse fuzzy, gated by the per-call similarity floor.
    let fuzzyHits = [];
    if (fuzzy && q.length >= MIN_FUZZY_LEN) {
      fuzzyHits = this._fuse.search(q)
        .filter((r) => !exactIdx.has(r.item.__i) && 1 - (r.score ?? 0) >= threshold)
        .map((r) => ({ item: this.items[r.item.__i], score: round3(1 - (r.score ?? 0)), match: 'fuzzy' }))
        .sort((a, b) => b.score - a.score || tb(a.item).localeCompare(tb(b.item)));
    }

    const out = [...exact, ...fuzzyHits];
    return limit != null ? out.slice(0, limit) : out;
  }
}

/**
 * One-shot rank of an ad-hoc `items` list. `fields(item) -> string[]`. Pass threshold > 1
 * for exact-substring only. Prefer a cached FuzzyIndex for static, frequently-searched corpora.
 */
export function rankFuzzy(query, items, { fields, threshold = 0.6, limit, tiebreak } = {}) {
  if (!items.length) return [];
  const idx = new FuzzyIndex(items, { keys: [{ name: 'f', get: fields }], tiebreak });
  return idx.search(query, { threshold, limit, fuzzy: threshold <= 1 });
}
