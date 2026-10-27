// WHAT THE TASK INDEX COMPUTES (src/task-index.js), as pure functions of the rows it read — run in a
// thread of their own (src/task-themes-worker.js): the local vectors, the ranking of a search, the
// clustering of a period into themes. Over a long window that is seconds of work, and the server's
// own thread answers every other call meanwhile.

import { createHash } from 'node:crypto';
import { cosineSimilarity } from './embeddings.js';

/** The local vector: the words of the text hashed into this many dimensions. */
export const LOCAL_DIMS = 512;
/** A theme is told with this many of its most typical tasks. */
const EXAMPLES = 3;
/** The clusters are found on at most this many tasks of the window, evenly spaced; every task is then put in its nearest. */
const CLUSTER_SAMPLE = 2000;
/** The number of clusters is chosen on at most this many of them (the silhouette compares every pair). */
const SILHOUETTE_SAMPLE = 400;

// the words that say nothing of a task's subject, in the two languages its texts are written in
const STOP = new Set(['by', 'of', 'the', 'and', 'or', 'per', 'for', 'in', 'on', 'to', 'over', 'with', 'from', 'at', 'as', 'is', 'an', 'по', 'на', 'за', 'для', 'из', 'без', 'от', 'до', 'при', 'не']);

/** An English plural said as its singular (installs → install), so the two forms are one word. */
const singular = (w) => (w.length > 3 && /^[a-z]+s$/.test(w) && !/(ss|us|is)$/.test(w) ? w.slice(0, -1) : w);

/** The words of a text: letters and digits, lower case, a snake_case name also taken apart. */
export function words(text) {
  const out = [];
  const keep = (p) => p.length > 1 && !/^\d+$/.test(p) && !STOP.has(p);
  for (const w of String(text || '').toLowerCase().match(/[\p{L}\p{N}_]+/gu) || []) {
    if (keep(w)) out.push(singular(w));
    // a word written with underscores also says each of its words
    const inner = w.includes('_') ? w.match(/[\p{L}\p{N}]+/gu) || [] : [];
    out.push(...inner.filter(keep).map(singular));
  }
  return out;
}

export function normalized(v) {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  return Array.from(v, (x) => x / n);
}

/**
 * Local vectors for a set of texts: each text's words weighted by tf (log) × idf over the set, hashed
 * into LOCAL_DIMS signed buckets, unit length — and `of(text)`, the vector of another text (a phrase
 * searched for) by the same weights.
 */
export function localVectors(texts) {
  const df = new Map();
  for (const t of texts) for (const w of new Set(words(t))) df.set(w, (df.get(w) || 0) + 1);
  const n = texts.length;
  const of = (text) => {
    const v = new Float64Array(LOCAL_DIMS);
    const tf = new Map();
    for (const w of words(text)) tf.set(w, (tf.get(w) || 0) + 1);
    for (const [w, c] of tf) {
      const idf = Math.log((n + 1) / ((df.get(w) || 0) + 1)) + 1 / (n + 1);
      const h = createHash('md5').update(w).digest();
      v[h.readUInt32LE(0) % LOCAL_DIMS] += (h[4] & 1 ? 1 : -1) * (1 + Math.log(c)) * idf;
    }
    return normalized(v);
  };
  return { vectors: texts.map(of), of };
}

/** A deterministic random number source (mulberry32), so a clustering is the same on every run. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Spherical k-means (cosine) with k-means++ seeding from a fixed seed: unit vectors in, for each
 * vector its cluster, and each cluster's centre (unit length).
 */
export function kmeans(vectors, k, { iterations = 30, seed = 1 } = {}) {
  const n = vectors.length;
  const rnd = seeded(seed);
  const centres = [vectors[Math.floor(rnd() * n)]];
  while (centres.length < k) {
    const d = vectors.map((v) => Math.max(0, 1 - Math.max(...centres.map((c) => cosineSimilarity(v, c)))) ** 2);
    const total = d.reduce((a, b) => a + b, 0);
    if (total <= 0) break;
    let r = rnd() * total;
    let i = 0;
    while (i < n - 1 && (r -= d[i]) > 0) i += 1;
    centres.push(vectors[i]);
  }
  let assign = new Array(n).fill(0);
  for (let it = 0; it < iterations; it += 1) {
    const next = vectors.map((v) => nearest(v, centres));
    const moved = next.some((c, i) => c !== assign[i]);
    assign = next;
    centresOf(vectors, assign, centres);
    if (!moved && it > 0) break;
  }
  return { assign, centres };
}

/** The centre a vector is nearest to (by cosine). */
function nearest(v, centres) {
  let best = 0; let bs = -Infinity;
  centres.forEach((c, j) => { const s = cosineSimilarity(v, c); if (s > bs) { bs = s; best = j; } });
  return best;
}

/** Each cluster's centre, the mean of its members made unit length (in place; an empty cluster keeps its own). */
function centresOf(vectors, assign, centres) {
  for (let j = 0; j < centres.length; j += 1) {
    const members = vectors.filter((_, i) => assign[i] === j);
    if (!members.length) continue;
    const sum = new Float64Array(members[0].length);
    for (const m of members) for (let d = 0; d < m.length; d += 1) sum[d] += m[d];
    centres[j] = normalized(sum);
  }
  return centres;
}

/**
 * The best of several spherical k-means runs (seeds 1..restarts): the one whose points lie closest to
 * their centres — one run can settle in a poor split, and which one it is depends on the order of the
 * points.
 */
export function bestKmeans(vectors, k, { restarts = 6 } = {}) {
  let best = null;
  for (let seed = 1; seed <= restarts; seed += 1) {
    const c = kmeans(vectors, k, { seed });
    const cohesion = vectors.reduce((a, v, i) => a + cosineSimilarity(v, c.centres[c.assign[i]]), 0);
    if (!best || cohesion > best.cohesion + 1e-12) best = { ...c, cohesion };
  }
  return best;
}

/** The mean silhouette of a clustering (cosine distance): how much closer each point is to its own cluster than to the next. */
export function silhouette(vectors, assign) {
  const k = Math.max(-1, ...assign) + 1;
  if (k < 2) return 0;
  let total = 0;
  for (let i = 0; i < vectors.length; i += 1) {
    const dist = new Array(k).fill(0); const cnt = new Array(k).fill(0);
    for (let j = 0; j < vectors.length; j += 1) {
      if (i === j) continue;
      dist[assign[j]] += 1 - cosineSimilarity(vectors[i], vectors[j]); cnt[assign[j]] += 1;
    }
    const own = assign[i];
    if (cnt[own] === 0) continue; // a singleton scores 0
    const a = dist[own] / cnt[own];
    const b = Math.min(...dist.map((d, c) => (c === own || !cnt[c] ? Infinity : d / cnt[c])));
    total += b === Infinity ? 0 : (b - a) / Math.max(a, b);
  }
  return total / vectors.length;
}

/** Every `step`-th index of `n`, so that at most `cap` are taken. */
const evenly = (n, cap) => { const step = Math.max(1, Math.ceil(n / cap)); return Array.from({ length: n }, (_, i) => i).filter((i) => i % step === 0); };

/** The vectors of the rows read: the embedder's where they came with them, else local ones over their texts. */
function vectorsOf({ texts, vectors }) {
  if (vectors) return { vectors, of: null };
  return localVectors(texts);
}

/** The rows most like a phrase: their indices and similarity, best first (ties: the later task first). */
export function rankSimilar({ texts, ats, vectors, query, queryVector, limit }) {
  const v = vectorsOf({ texts, vectors });
  const q = queryVector || v.of(query);
  return v.vectors.map((x, i) => ({ i, s: cosineSimilarity(q, x) })).sort((a, b) => b.s - a.s || ats[b.i] - ats[a.i]).slice(0, limit);
}

/**
 * The themes of the rows read: those at least `minSimilarity` like `about` (where it is given),
 * clustered — `clusters` of them, or the number whose clustering separates best — each with its size,
 * its share of the rows clustered, its days, the words that set it apart and the indices of its most
 * typical rows. The clusters are found on an evenly spaced sample of a large window, every row then
 * put in its nearest.
 */
export function computeThemes({ texts, ats, tools, sources, vectors, about = null, aboutVector = null, minSimilarity, clusters = null }) {
  const v = vectorsOf({ texts, vectors });
  let keep = texts.map((_, i) => i);
  if (about) {
    const q = aboutVector || v.of(about);
    keep = keep.filter((i) => cosineSimilarity(q, v.vectors[i]) >= minSimilarity);
  }
  const out = { tasks_about: keep.length };
  if (!keep.length) return { ...out, themes: [] };
  const vecs = keep.map((i) => v.vectors[i]);
  let centres;
  if (keep.length < 2) centres = [vecs[0]];
  else {
    const sample = evenly(vecs.length, CLUSTER_SAMPLE);
    const sv = sample.map((i) => vecs[i]);
    // many restarts are what a small sample needs; a large one settles alike in fewer
    const restarts = sv.length > 500 ? 3 : 6;
    let best;
    if (clusters) best = bestKmeans(sv, Math.min(clusters, sv.length), { restarts });
    else {
      const most = Math.min(12, Math.floor(sv.length / 3));
      const ss = evenly(sv.length, SILHOUETTE_SAMPLE);
      for (let k = 2; k <= most; k += 1) {
        const c = bestKmeans(sv, k, { restarts });
        const s = silhouette(ss.map((i) => sv[i]), ss.map((i) => c.assign[i]));
        if (!best || s > best.score) best = { ...c, score: s };
      }
    }
    centres = best ? best.centres : [normalized(sv.reduce((a, x) => a.map((y, d) => y + x[d]), new Array(sv[0].length).fill(0)))];
  }
  // every row of the window in its nearest cluster, the centres then made of all their members
  const assign = vecs.map((x) => nearest(x, centres));
  centresOf(vecs, assign, centres);
  const rows = keep.map((i, j) => ({ i, vector: vecs[j], cluster: assign[j] }));
  const themes = centres.map((c, j) => theme(rows.filter((r) => r.cluster === j), c, rows, { texts, ats, tools, sources }))
    .filter((t) => t.tasks).sort((a, b) => b.tasks - a.tasks);
  return { ...out, themes };
}

/** One theme: its size and share, its days, the words that set it apart, the indices of its most typical rows. */
function theme(members, centre, all, { texts, ats, tools, sources }) {
  if (!members.length) return { tasks: 0 };
  const freq = (rs) => { const m = new Map(); for (const r of rs) for (const w of new Set(words(texts[r.i]))) m.set(w, (m.get(w) || 0) + 1); return m; };
  const inside = freq(members); const everywhere = freq(all);
  // the tool and the source name no subject, and a word most tasks of the window say sets no theme apart
  const plumbing = new Set(all.flatMap((r) => words(`${tools[r.i] || ''} ${sources[r.i] || ''}`)));
  const terms = [...inside].filter(([w, n]) => n >= Math.min(2, members.length) && !plumbing.has(w) && (everywhere.get(w) || 0) < 0.8 * all.length)
    .map(([w, n]) => [w, (n / members.length) * Math.log((all.length + 1) / (everywhere.get(w) || 1))])
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8).map(([w]) => w);
  const days = new Map();
  for (const r of members) { const d = new Date(ats[r.i]).toISOString().slice(0, 10); days.set(d, (days.get(d) || 0) + 1); }
  const typical = [...members].sort((a, b) => cosineSimilarity(centre, b.vector) - cosineSimilarity(centre, a.vector) || ats[b.i] - ats[a.i]).slice(0, EXAMPLES);
  return {
    tasks: members.length,
    share: Math.round((members.length / all.length) * 1000) / 1000,
    terms,
    days: [...days].sort((a, b) => a[0].localeCompare(b[0])).map(([d, n]) => ({ day: d, tasks: n })),
    examples: typical.map((r) => r.i),
  };
}

/** What a thread is asked to compute: `similar` or `themes`, over the rows the index read. */
export function compute(op, payload) {
  if (op === 'similar') return rankSimilar(payload);
  if (op === 'themes') return computeThemes(payload);
  throw new Error(`unknown task-index computation '${op}'`);
}
