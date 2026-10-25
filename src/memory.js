// Durable ANALYST MEMORY: the findings the AI makes while resolving a question —
// a vague phrasing tracked down to a real field, a non-obvious gotcha, an associated
// source (a Confluence page, a dashboard). Each note is LINKED to the catalog entities
// it is about (a property / column / event / model) via canonical target keys, so it
// surfaces back THROUGH semantic_index when someone next looks at that entity or searches
// the word the user originally used. Persistence is delegated to the shared store backend
// (see store.js) — this class holds the domain operations + the small in-JS filtering
// (the note set is tiny), and no SQL.
//
// A TARGET is stored as what it IS — { kind, source, name } for an event property, a model's column
// or an event, { kind, source } for a model, { kind, term } for a free phrase the user used — and
// spoken by the tools as `aboutOf` writes it, the ref's own spelling ({ source, property } /
// { source, column } / { source, event } / { source } / { term }). `targetKey` folds one into a single
// string ONLY to look it up; nothing ever takes a key apart again. That is the whole rule: a name may
// be assembled for an index, never dismantled to recover what it names. A note an earlier version
// kept named a model's column as a property; it is read as the column it is (currentTarget).

import { randomUUID } from 'node:crypto';
import { rankFuzzy } from './fuzzy.js';

/** The lookup key of a target: assembled from its parts, never parsed back. */
export function targetKey(t) {
  if (t.kind === 'term') return `term:${String(t.term).toLowerCase()}`;
  if (t.kind === 'model') return `model:${t.source}`;
  return `${t.kind}:${t.source}.${t.name}`;
}

/**
 * A stored target as the tools write it — what memory records under `about` and semantic_index's
 * { notes, about } filters by, the ref's spelling: { source, property }, { source, column },
 * { source, event }, { source } for the model, { term }. The stored kind maps one-to-one to the key.
 */
export function aboutOf(t) {
  if (t.kind === 'term') return { term: t.term };
  if (t.kind === 'model') return { source: t.source };
  if (t.kind === 'event') return { source: t.source, event: t.name };
  if (t.kind === 'column') return { source: t.source, column: t.name };
  return { source: t.source, property: t.name };
}

/**
 * A stored target as this version keeps it. An earlier version kept a model's column as a property of
 * its source (one kind for both, `property`); one the catalog knows as a column — not an event property
 * of that source — is that column now, so it is found under the column's key and spoken as the column.
 * The same target otherwise (and without a catalog to ask).
 */
export function currentTarget(t, catalog) {
  if (!catalog || t?.kind !== 'property') return t;
  const kind = catalog.attributeKind(t.source, t.name);
  return kind && kind !== 'property' ? { ...t, kind: 'column' } : t;
}

/** The words of a target, for search and embedding — the parts, not the assembled key. */
export function targetWords(t) {
  return t.kind === 'term' ? String(t.term) : [t.source, t.name].filter(Boolean).join('.');
}

/**
 * A note as read: every target a structure, as this version keeps it (currentTarget). A bare string an
 * earlier server stored names nothing this catalog can address, so it is read as the phrase it is —
 * searchable, never taken apart.
 */
const asRead = (e, catalog) => e && { ...e, targets: (e.targets || []).map((t) => (t && typeof t === 'object' ? currentTarget(t, catalog) : { kind: 'term', term: String(t) })) };

// Cosine-similarity floor for a SEMANTIC hit to count. Two notes of one domain (a game's analytics) sit
// at 0.3–0.45 with a text-embedding-3 model whatever they say, so a floor at 0.3 let every note in;
// a same-meaning note is well above this one.
const SEMANTIC_FLOOR = 0.45;
// A hit far weaker than the best one is noise beside it: a search answers with the notes within this
// share of its top score.
const RELATIVE_FLOOR = 0.75;

export class MemoryStore {
  constructor({ store, embedder, catalog = null } = {}) {
    this.store = store;
    // Optional embedder ({ model, embed(texts) }) → semantic search. None → fuzzy only.
    this.embedder = embedder || null;
    // what a kept target names — a column or an event property — for a note an earlier version kept (currentTarget)
    this.catalog = catalog;
  }

  /** Whether semantic (vector) search is active. */
  get semantic() { return !!this.embedder; }

  /**
   * The text a note is embedded as (and lexically matched on): the original business
   * QUESTION it answers + the finding + the words/entities attached to it. Embedding the
   * question means a future, similarly-phrased business question retrieves this insight.
   */
  _embedText(e) {
    return [
      e.question,
      e.note,
      ...(e.aliases || []),
      ...(e.targets || []).map(targetWords),
    ].filter(Boolean).join('\n');
  }

  /** Persist one finding. Returns the stored entry (with its generated id + timestamp). */
  record({ note, question = null, targets = [], aliases = [], links = [] } = {}) {
    const id = randomUUID().replace(/-/g, '').slice(0, 12);
    const entry = { id, note: String(note), question: question || null, targets, aliases, links, created_at: Date.now() };
    this.store.memory.add(entry);
    return entry;
  }

  get(id) { return asRead(this.store.memory.get(id), this.catalog); }

  /** Delete one note by id. Returns whether a row existed. */
  forget(id) { return this.store.memory.remove(id); }

  /** All notes, most recent first. */
  all(opts = {}) { return this.store.memory.all(opts).map((e) => asRead(e, this.catalog)); }

  /** { notes } — coverage counts. */
  counts() { return this.store.memory.counts(); }

  /** Notes whose canonical targets intersect any of `keys` (for a semantic_index view). */
  forTargets(keys) {
    if (!keys || !keys.length) return [];
    const set = new Set(keys);
    return this.all({ limit: 2000 }).filter((e) => (e.targets || []).some((t) => set.has(targetKey(t))));
  }

  /**
   * Find notes matching `query`. Returns { notes, semantic, semantic_error? }.
   *
   * LEXICAL (always): over each note's combined text (question + note + aliases + target
   * keys), three signals — (1) exact phrase substring, (2) TOKEN COVERAGE: the fraction of
   * the query's words present anywhere in the note (so a multi-word phrase lifted from the
   * note body still matches even if words are interleaved — e.g. "одиночный target невалиден"
   * finds "одиночный target в record невалиден"), and (3) when fuzzy is on, Fuse typo/
   * approximate matching. fuzzy:false keeps (1)+(2) (still exact-token based), dropping (3).
   *
   * SEMANTIC (when an embedder is configured): embeds the query, KNN over the stored vectors
   * (sqlite-vec when available, else JS cosine) and BLENDS it in (a note ranks by the best of
   * its lexical / cosine score) — so a same-meaning note with no shared words still surfaces.
   * Self-healing: notes missing a current-model vector are embedded on the fly and persisted.
   * `semantic` in the result reports whether semantic search ACTUALLY ran (false + a short
   * `semantic_error` if the provider failed) — never a misleading "on" when it silently fell
   * back to lexical. Async because embedding is a network op.
   */
  async search(query, { limit = 20, fuzzy = true } = {}) {
    const q = String(query ?? '').trim();
    if (!q) return { notes: [], semantic: false };
    const notes = this.all({ limit: 2000 });
    if (!notes.length) return { notes: [], semantic: false };

    const byId = new Map(notes.map((n) => [n.id, n]));
    const scored = new Map(); // id -> best score across all signals

    // ── lexical: exact phrase + token coverage (bag-of-words, unicode-aware) ──
    const ql = q.toLowerCase();
    // a query word counts where a word of the note STARTS with it ('purchase' in 'purchases'), never
    // inside one ('format' in 'reformatted', 'ad' in 'load'); a two-letter word ('ad', 'ui') counts too
    const escape = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const qtokens = ql.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2).map((t) => new RegExp(`(?<![\\p{L}\\p{N}])${escape(t)}`, 'u'));
    // what a note is ABOUT — its question, its aliases (the user's words for it), what it is linked to —
    // outweighs a word its body mentions in passing: a long note names many things it is not about
    const scoreIn = (hay, phrase, [base, span]) => {
      if (ql && hay.includes(ql)) return phrase;
      if (!qtokens.length) return 0;
      const cov = qtokens.filter((t) => t.test(hay)).length / qtokens.length;
      return cov >= 0.6 ? base + span * cov : 0;
    };
    for (const n of notes) {
      const short = [n.question, ...(n.aliases || []), ...(n.targets || []).map(targetWords)].filter(Boolean).join('\n').toLowerCase();
      const lex = Math.max(scoreIn(short, 1, [0.5, 0.4]), scoreIn(String(n.note || '').toLowerCase(), 0.7, [0.3, 0.3]));
      if (lex > 0) scored.set(n.id, lex);
    }

    // ── lexical: Fuse typo/approximate (only when fuzzy is enabled) — over the SHORT fields only (the
    // question, the aliases, what the note is about): over a long note body a short query's letters
    // match fragments of almost any note; the body is matched by its words above and by meaning below ──
    if (fuzzy) {
      const short = (e) => [e.question, ...(e.aliases || []), ...(e.targets || []).map(targetWords)].filter(Boolean);
      for (const r of rankFuzzy(q, notes, { fields: short, threshold: 0.55, limit: Math.max(limit, 20), tiebreak: (e) => e.id })) {
        scored.set(r.item.id, Math.max(scored.get(r.item.id) ?? 0, r.score));
      }
    }

    // ── semantic (vector) search, blended in — only when an embedder is configured ──
    let semantic = false; let semanticError;
    if (this.embedder) {
      try {
        const model = this.embedder.model;
        // Backfill: embed any note lacking a current-model vector (one batch call), persist.
        const have = this.store.memory.vectorIds(model);
        const need = notes.filter((n) => !have.has(n.id));
        if (need.length) {
          const vecs = await this.embedder.embed(need.map((n) => this._embedText(n)));
          need.forEach((n, i) => { if (vecs[i]) this.store.memory.vectorPut(n.id, vecs[i], model); });
        }
        const [qvec] = await this.embedder.embed([q]);
        for (const { id, score } of this.store.memory.vectorSearch(qvec, { limit: Math.max(limit, 20), model })) {
          if (score < SEMANTIC_FLOOR) continue;
          scored.set(id, Math.max(scored.get(id) ?? 0, score));
        }
        semantic = true; // embedding + KNN actually completed
      } catch (e) {
        // Surface the failure EXPLICITLY (returned to the tool as semantic_error) AND log it
        // for ops — never a silent fall-through that looks like "no semantic matches".
        semanticError = String(e?.message || e).slice(0, 300);
        console.error(`[mcp] ${new Date().toISOString()} memory semantic search FAILED (falling back to lexical): ${semanticError}`);
      }
    }

    const best = Math.max(0, ...scored.values());
    const ranked = [...scored.entries()]
      .filter(([, score]) => score >= best * RELATIVE_FLOOR)
      .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(b[0]))
      .slice(0, limit)
      .map(([id, score]) => byId.get(id) && { ...byId.get(id), score: Math.round(score * 100) / 100 })
      .filter(Boolean);
    return { notes: ranked, semantic, ...(semanticError ? { semantic_error: semanticError } : {}) };
  }
}
