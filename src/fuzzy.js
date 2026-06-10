// Dependency-free fuzzy matching for catalog/vocabulary search. Pure functions, no
// state — the search layer feeds candidate strings and gets a similarity score back.
//
// Design (best-practice tiered scoring, deterministic, no npm dep):
//   1. EXACT substring            → 1.0  (always ranked first)
//   2. token prefix / containment → 0.9–0.95
//   3. ordered subsequence        → up to ~0.85 (all query chars appear in order)
//   4. Levenshtein similarity     → 1 − dist/len, taken over the CLOSEST token
// Matching is token-aware: a target is split on non-alphanumerics, so a typo is
// compared against the nearest WORD (works for long descriptions, not just names).
// A threshold gate keeps unrelated strings out; very short queries fall back to
// exact-only (fuzzing 1–2 chars is pure noise).

/** Levenshtein edit distance (iterative, two-row). */
export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let cur = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/** Edit-distance similarity in [0,1] (1 = identical). */
function simRatio(a, b) {
  const m = Math.max(a.length, b.length);
  return m === 0 ? 1 : 1 - levenshtein(a, b) / m;
}

/** True if every char of q appears in t in order (subsequence). */
function isSubsequence(q, t) {
  let i = 0;
  for (let j = 0; j < t.length && i < q.length; j += 1) if (t[j] === q[i]) i += 1;
  return i === q.length;
}

const MIN_FUZZY_LEN = 3; // queries shorter than this are matched exact-only

/**
 * Similarity of `query` to `target` in [0,1]; 0 means "no match". Combines exact
 * substring, token prefix/containment, subsequence and the best per-token edit
 * similarity, so typos and word forms score highly while unrelated strings stay low.
 */
export function fuzzyScore(query, target) {
  const q = String(query ?? '').toLowerCase().trim();
  const t = String(target ?? '').toLowerCase();
  if (!q || !t) return 0;
  if (t.includes(q)) return 1; // exact substring — the strongest signal
  if (q.length < MIN_FUZZY_LEN) return 0; // too short to fuzz safely

  const tokens = t.split(/[^a-z0-9]+/).filter(Boolean);
  let best = simRatio(q, t); // whole-string ratio (handles single-token targets)
  for (const tok of tokens) {
    if (tok.includes(q)) { best = Math.max(best, 0.95); continue; }
    if (tok.startsWith(q) || q.startsWith(tok)) best = Math.max(best, 0.9);
    best = Math.max(best, simRatio(q, tok));
  }
  // Ordered-subsequence credit (e.g. "convrate" ⊂ "conversion_rate"): partial, capped.
  if (best < 0.85 && (isSubsequence(q, t) || tokens.some((tok) => isSubsequence(q, tok)))) {
    best = Math.max(best, 0.7 + 0.15 * (q.length / Math.max(q.length, t.length)));
  }
  return best;
}

/**
 * Best similarity of `query` across several target fields (e.g. a property's name +
 * description). Returns { score, exact } where exact = a 1.0 substring hit.
 */
export function fuzzyScoreFields(query, fields) {
  let score = 0;
  for (const f of fields) { const s = fuzzyScore(query, f); if (s > score) score = s; }
  return { score, exact: score >= 1 };
}

/**
 * Rank `items` by fuzzy similarity to `query`. `fields(item)` returns the strings to
 * match against. Keeps items scoring ≥ threshold, EXACT substring hits first, then by
 * score desc, then by the stable `tiebreak(item)` string. Each kept item is returned
 * as { item, score, match: 'exact' | 'fuzzy' }.
 */
export function rankFuzzy(query, items, { fields, threshold = 0.6, limit, tiebreak } = {}) {
  const scored = [];
  for (const item of items) {
    const { score, exact } = fuzzyScoreFields(query, fields(item));
    if (score >= (exact ? 1 : threshold)) scored.push({ item, score, match: exact ? 'exact' : 'fuzzy' });
  }
  scored.sort((a, b) => {
    if (a.match !== b.match) return a.match === 'exact' ? -1 : 1; // exact tier first
    if (b.score !== a.score) return b.score - a.score;
    return tiebreak ? String(tiebreak(a.item)).localeCompare(String(tiebreak(b.item))) : 0;
  });
  return limit != null ? scored.slice(0, limit) : scored;
}
