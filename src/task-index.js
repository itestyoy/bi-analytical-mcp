// THE TASK INDEX — what has been asked of this server, by meaning. Every task a tool starts (a build,
// a query) is kept as one line of text that says what it computes — its context's name and
// description, the source, the events, metrics, columns and values it names, its window — with a
// vector of that text. semantic_index({ request: { tasks } }) reads it two ways: the tasks most like
// a phrase, and the themes of a period (the tasks of the window, narrowed to those near a phrase if
// one is given, clustered).
//
// It is a record of the QUESTIONS, never a way to the data: what it answers carries no task id, no
// context id and no table — a task found here cannot be read back, built on or drawn. Another task's
// rows may not fit the question at hand, and reaching them is not what this is for.
//
// The vector is the deployment's embedder's (the one semantic memory search uses — MEMORY_EMBEDDINGS,
// OpenAI) at TASK_DIMS dimensions, computed after the task starts and never in its way, and stored
// with the model that made it: a search reads only the rows of the model it asks with, and the rows
// of another model (a deployment that switched) are re-embedded when the index is read. Without an
// embedder the vector is a local one, made when the index is read: the text's words weighted by how
// rare they are among the tasks read (TF-IDF, so what every task says weighs nothing) and hashed into
// LOCAL_DIMS dimensions — the index works on every deployment, coarser where the words differ but
// the meaning is the same.

import { createHash } from 'node:crypto';
import { cosineSimilarity } from './embeddings.js';
import { resolveTimeRange, momentMs, isValidTimezone } from './time-range.js';
import { ToolError } from './validate.js';

/** The dimensions an OpenAI text-embedding-3 vector is asked at (plenty to tell themes apart, 1 KB a row). */
export const TASK_DIMS = 256;
/** The local vector: the words of the text hashed into this many dimensions. */
export const LOCAL_DIMS = 512;
export const LOCAL_MODEL = `local-words-${LOCAL_DIMS}`;
/** At most this many rows are embedded in one request to the embedder. */
const EMBED_BATCH = 64;
/** A theme is told with this many of its most typical tasks. */
const EXAMPLES = 3;
/** The number of clusters is chosen on at most this many tasks of the window. */
const SILHOUETTE_SAMPLE = 400;

// the fields of a tool's input whose strings say WHAT is computed (a name, a source, an event, a
// metric, a column, a value) — not how (a function, a stage, a direction)
const MEANINGFUL = new Set(['source', 'event', 'event_name', 'events', 'metric', 'metrics', 'measure', 'column', 'property', 'dimension', 'entity', 'semantic_model', 'value', 'group_by', 'keep', 'on', 'name', 'description', 'label', 'experiment', 'analysis']);

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

/**
 * One line that says what a task computes, from what the server knows of it: its context's name and
 * description, the tool, and the meaningful strings of its input. Nothing of the user's own words —
 * the server never sees them — and nothing it would have to guess.
 */
export function taskText({ tool, ctx = null, input = null }) {
  const state = ctx?.state || {};
  const name = state.draft?.name || (Array.isArray(state.tasks) && state.tasks.length ? state.tasks[state.tasks.length - 1] : null);
  const notes = Object.values(state.task_notes || {});
  const description = state.draft?.description || notes[notes.length - 1] || null;
  const seen = new Set();
  const said = [];
  const walk = (v, key) => {
    if (said.length >= 60) return;
    if (typeof v === 'string') {
      if (MEANINGFUL.has(key) && v.length <= 200 && !seen.has(v)) { seen.add(v); said.push(v); }
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      if (key === 'value' && !seen.has(String(v))) { seen.add(String(v)); said.push(String(v)); }
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (k !== 'sql' && k !== 'body') walk(x, k);
  };
  walk(input, null);
  const window = input?.time_range ? [input.time_range.start, input.time_range.end].filter(Boolean).join('..') : null;
  return [
    name ? `${String(name).replace(/_/g, ' ')}${description ? `: ${description}` : ''}` : description,
    `${tool}${state.draft?.source ? ` over ${state.draft.source}` : ''}`,
    said.length ? said.join(', ') : null,
    window ? `window ${window}` : null,
  ].filter(Boolean).join(' — ');
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

function normalized(v) {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  return Array.from(v, (x) => x / n);
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
    const next = vectors.map((v) => { let best = 0; let bs = -Infinity; centres.forEach((c, j) => { const s = cosineSimilarity(v, c); if (s > bs) { bs = s; best = j; } }); return best; });
    const moved = next.some((c, i) => c !== assign[i]);
    assign = next;
    for (let j = 0; j < centres.length; j += 1) {
      const members = vectors.filter((_, i) => assign[i] === j);
      if (!members.length) continue;
      const sum = new Float64Array(members[0].length);
      for (const m of members) for (let d = 0; d < m.length; d += 1) sum[d] += m[d];
      centres[j] = normalized(sum);
    }
    if (!moved && it > 0) break;
  }
  return { assign, centres };
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

/** The window of a time_range as epoch milliseconds { since, until }, read as every time_range is. */
function windowOf(tr) {
  if (tr?.timezone && !isValidTimezone(tr.timezone)) throw new ToolError(`time_range.timezone: unknown timezone '${tr.timezone}' — use an IANA name like 'Europe/Berlin' or 'UTC'`, { stage: 'validate', field: 'time_range.timezone' });
  const b = resolveTimeRange(tr) || {};
  return {
    since: b.start != null ? momentMs(b.start) : null,
    until: b.endExclusive != null ? momentMs(b.endExclusive) - 1 : b.end != null ? momentMs(b.end) : null,
  };
}

const day = (ms) => new Date(ms).toISOString().slice(0, 10);

export class TaskIndex {
  /**
   * @param store     the store (its `taskLog` repository)
   * @param embedder  the deployment's embedder, or null (the local vector then)
   * @param toolOf    (the kind a task was started as) → the tool that is said as
   * @param logger    a line for what failed in the background
   */
  constructor({ store, embedder = null, toolOf = (t) => t, logger = () => {} }) {
    this.store = store;
    this.embedder = embedder;
    this.toolOf = toolOf;
    this.logger = logger;
    this.pending = new Set(); // ids waiting for the embedder
    this.flushing = null;
  }

  /** The model a vector is made by on this deployment (the name each row is stored with). */
  get model() {
    return this.embedder ? `${this.embedder.model}@${TASK_DIMS}` : LOCAL_MODEL;
  }

  /** Keep a task that just started. Never throws, never waits: a task does not depend on its record. */
  record({ id, tool, ctx = null, input = null, at = Date.now() }) {
    try {
      const text = taskText({ tool: this.toolOf(tool) || tool, ctx, input });
      this.store.taskLog.put({ id, at, tool: this.toolOf(tool) || tool, source: ctx?.state?.draft?.source ?? input?.source ?? null, text });
      if (this.embedder) { this.pending.add(id); this._schedule(); }
    } catch (e) { this.logger(`✗ task ${id} not indexed: ${e?.message || e}`); }
  }

  /** Tasks started before the index existed (or before this deployment's model) — kept from the job registry. */
  backfill(jobs = [], ctxOf = () => null) {
    for (const j of jobs) {
      if (!j?.id || this.store.taskLog.has(j.id)) continue;
      this.record({ id: j.id, tool: j.tool || 'task', ctx: j.contextId ? ctxOf(j.contextId) : null, at: j.startedAt || Date.now() });
    }
  }

  _schedule() {
    if (this.flushing) return;
    const t = setTimeout(() => { this.flushing = this._flush().catch((e) => this.logger(`✗ embedding tasks: ${e?.message || e}`)).finally(() => { this.flushing = null; if (this.pending.size) this._schedule(); }); }, 200);
    t.unref?.();
  }

  /** Embed what waits (and any row of another model), batch by batch. */
  async _flush() {
    if (!this.embedder) return;
    const missing = this.store.taskLog.missing(this.model, 10000);
    const ids = new Set([...this.pending, ...missing.map((r) => r.id)]);
    this.pending.clear();
    const rows = missing.filter((r) => ids.has(r.id));
    for (let i = 0; i < rows.length; i += EMBED_BATCH) {
      const batch = rows.slice(i, i + EMBED_BATCH);
      const vecs = await this.embedder.embed(batch.map((r) => r.text), { dimensions: TASK_DIMS });
      batch.forEach((r, j) => { if (vecs[j]) this.store.taskLog.setVector(r.id, this.model, normalized(vecs[j])); });
    }
  }

  /**
   * Every row of the window with its vector — the embedder's (embedding first what still waits), or
   * the local one made over the window's texts — and `vectorOf(text)`, a phrase's vector by the same model.
   */
  async _rows(timeRange) {
    const { since, until } = windowOf(timeRange);
    if (!this.embedder) {
      const rows = this.store.taskLog.range({ since, until });
      const local = localVectors(rows.map((r) => r.text));
      return { rows: rows.map((r, i) => ({ ...r, vector: local.vectors[i] })), vectorOf: async (text) => local.of(text) };
    }
    if (this.flushing) await this.flushing;
    await this._flush();
    const vectorOf = async (text) => normalized((await this.embedder.embed([text], { dimensions: TASK_DIMS }))[0]);
    return { rows: this.store.taskLog.range({ since, until, model: this.model }), vectorOf };
  }

  /** What a task is said as here: what it computed and when — never a way back to it. */
  _shown(r, score) {
    return { at: new Date(r.at).toISOString(), tool: r.tool, ...(r.source ? { source: r.source } : {}), task: r.text, ...(score != null ? { similarity: Math.round(score * 1000) / 1000 } : {}) };
  }

  /** The tasks most like a phrase, within a window. */
  async similar({ search, time_range: timeRange, limit = 10 }) {
    const { rows, vectorOf } = await this._rows(timeRange);
    const q = await vectorOf(search);
    const ranked = rows.map((r) => ({ r, s: cosineSimilarity(q, r.vector) })).sort((a, b) => b.s - a.s || b.r.at - a.r.at).slice(0, limit);
    return { model: this.model, searched: rows.length, tasks: ranked.map(({ r, s }) => this._shown(r, s)) };
  }

  /**
   * The themes of a window: its tasks (those at least `min_similarity` like `about`, where it is
   * given) clustered — `clusters` of them, or the number whose clustering separates best — each with
   * its size, its share, its days, the words that set it apart and its most typical tasks.
   */
  async themes({ time_range: timeRange, about = null, min_similarity: minSimilarity = null, clusters = null }) {
    const read = await this._rows(timeRange);
    let { rows } = read;
    const total = rows.length;
    if (about) {
      const q = await read.vectorOf(about);
      const floor = minSimilarity ?? (this.embedder ? 0.3 : 0.1);
      rows = rows.filter((r) => cosineSimilarity(q, r.vector) >= floor);
    }
    const out = { model: this.model, tasks_in_window: total, ...(about ? { about, tasks_about: rows.length } : {}) };
    if (rows.length < 2) return { ...out, themes: rows.length ? [this._theme(rows, rows[0].vector, total)] : [] };
    const vectors = rows.map((r) => r.vector);
    let best;
    if (clusters) best = bestKmeans(vectors, Math.min(clusters, rows.length));
    else {
      const most = Math.min(12, Math.floor(rows.length / 3));
      // the silhouette compares every pair: over a large window it is measured on an evenly spaced sample
      const step = Math.max(1, Math.ceil(rows.length / SILHOUETTE_SAMPLE));
      const sampled = vectors.map((_, i) => i).filter((i) => i % step === 0);
      for (let k = 2; k <= most; k += 1) {
        const c = bestKmeans(vectors, k);
        const s = silhouette(sampled.map((i) => vectors[i]), sampled.map((i) => c.assign[i]));
        if (!best || s > best.score) best = { ...c, score: s };
      }
      if (!best) best = { assign: rows.map(() => 0), centres: [normalized(vectors.reduce((a, v) => a.map((x, d) => x + v[d]), new Array(vectors[0].length).fill(0)))] };
    }
    const groups = best.centres.map((c, j) => ({ centre: c, members: rows.filter((_, i) => best.assign[i] === j) })).filter((g) => g.members.length);
    const themes = groups.map((g) => this._theme(g.members, g.centre, rows.length, rows)).sort((a, b) => b.tasks - a.tasks);
    return { ...out, themes };
  }

  /** One theme: its size and share, its days, the words that set it apart, its most typical tasks. */
  _theme(members, centre, of, all = members) {
    const freq = (rs) => { const m = new Map(); for (const r of rs) for (const w of new Set(words(r.text))) m.set(w, (m.get(w) || 0) + 1); return m; };
    const inside = freq(members); const everywhere = freq(all);
    // the tool and the source name no subject, and a word most tasks of the window say sets no theme apart
    const plumbing = new Set(all.flatMap((r) => words(`${r.tool || ''} ${r.source || ''}`)));
    const terms = [...inside].filter(([w, n]) => n >= Math.min(2, members.length) && !plumbing.has(w) && (everywhere.get(w) || 0) < 0.8 * all.length)
      .map(([w, n]) => [w, (n / members.length) * Math.log((all.length + 1) / (everywhere.get(w) || 1))])
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8).map(([w]) => w);
    const days = new Map();
    for (const r of members) days.set(day(r.at), (days.get(day(r.at)) || 0) + 1);
    const typical = [...members].sort((a, b) => cosineSimilarity(centre, b.vector) - cosineSimilarity(centre, a.vector) || b.at - a.at).slice(0, EXAMPLES);
    return {
      tasks: members.length,
      share: Math.round((members.length / of) * 1000) / 1000,
      terms,
      days: [...days].sort((a, b) => a[0].localeCompare(b[0])).map(([d, n]) => ({ day: d, tasks: n })),
      examples: typical.map((r) => this._shown(r)),
    };
  }
}
