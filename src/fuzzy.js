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
    // the words of each item's NAME fields (the keys of the highest weight): a query mistyped from one
    // word of a name (purchse → iap_purchase_completed) is scored by how close it is to that word
    const top = Math.max(...keys.map((k) => k.weight ?? 1));
    this._words = items.map((item) => keys.filter((k) => (k.weight ?? 1) === top).flatMap((k) => {
      const v = k.get(item);
      return (Array.isArray(v) ? v : [v]).flatMap((x) => norm(x).split(/[^a-z0-9]+/).filter(Boolean));
    }));
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
        .map((r) => ({ item: this.items[r.item.__i], score: round3(fuzzyScore(1 - (r.score ?? 0), wordSimilarity(ql, this._words[r.item.__i]))), match: 'fuzzy' }))
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

/** A word of the name this close to the query explains the hit (a typo of it). */
const CLOSE_WORD = 0.75;
/** A fuzzy hit's similarity: as close as the nearest word of its name, where one is that close; a hit no
 *  word of its name explains (letters shared with a description, a fragment of another word) ranks below
 *  one that is — Fuse's own score, discounted. */
const fuzzyScore = (fuse, word) => (word >= CLOSE_WORD ? Math.max(fuse, word) : fuse * 0.9);

/** How close `q` is to the nearest of `words`: 1 − its edit distance (insert, delete, substitute, swap
 *  two neighbours) over the longer length — 0 for none. */
function wordSimilarity(q, words) {
  let best = 0;
  for (const w of words) {
    const d = editDistance(q, w);
    best = Math.max(best, 1 - d / Math.max(q.length, w.length));
  }
  return best;
}

function editDistance(a, b) {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
    }
  }
  return rows[a.length][b.length];
}
