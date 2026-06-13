// Durable ANALYST MEMORY: the findings the AI makes while resolving a question —
// a vague phrasing tracked down to a real field, a non-obvious gotcha, an associated
// source (a Confluence page, a dashboard). Each note is LINKED to the catalog entities
// it is about (a property / column / event / model) via canonical target keys, so it
// surfaces back THROUGH semantic_index when someone next looks at that entity or searches
// the word the user originally used. Persistence is delegated to the shared store backend
// (see store.js) — this class holds the domain operations + the small in-JS filtering
// (the note set is tiny), and no SQL.
//
// A canonical target key encodes the entity kind + key as "<kind>:<key>", e.g.
//   property:ad_type_of_event_data | property:users.country | event:ad_finished |
//   model:users | term:ad format   (a free phrase the user used that did not resolve)
// — so a note found by search points straight back at the right semantic_index view.

import { randomUUID } from 'node:crypto';
import { rankFuzzy } from './fuzzy.js';

// Cosine-similarity floor for a SEMANTIC hit to count (text-embedding-class models put
// genuinely related-but-differently-worded texts well above this; noise stays below).
const SEMANTIC_FLOOR = 0.3;

export class MemoryStore {
  constructor({ store, embedder } = {}) {
    this.store = store;
    // Optional embedder ({ model, embed(texts) }) → semantic search. None → fuzzy only.
    this.embedder = embedder || null;
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
      ...(e.targets || []).map((t) => { const i = String(t).indexOf(':'); return i > 0 ? t.slice(i + 1) : String(t); }),
    ].filter(Boolean).join('\n');
  }

  /** Persist one finding. Returns the stored entry (with its generated id + timestamp). */
  record({ note, question = null, targets = [], aliases = [], links = [] } = {}) {
    const id = randomUUID().replace(/-/g, '').slice(0, 12);
    const entry = { id, note: String(note), question: question || null, targets, aliases, links, created_at: Date.now() };
    this.store.memory.add(entry);
    return entry;
  }

  get(id) { return this.store.memory.get(id); }

  /** Delete one note by id. Returns whether a row existed. */
  forget(id) { return this.store.memory.remove(id); }

  /** All notes, most recent first. */
  all(opts = {}) { return this.store.memory.all(opts); }

  /** { notes } — coverage counts. */
  counts() { return this.store.memory.counts(); }

  /** Notes whose canonical targets intersect any of `keys` (for a semantic_index view). */
  forTargets(keys) {
    if (!keys || !keys.length) return [];
    const set = new Set(keys);
    return this.all({ limit: 2000 }).filter((e) => (e.targets || []).some((t) => set.has(t)));
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
    const qtokens = ql.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 3);
    for (const n of notes) {
      const hay = this._embedText(n).toLowerCase();
      let lex = 0;
      if (ql && hay.includes(ql)) lex = 1; // whole-query exact substring
      else if (qtokens.length) {
        const cov = qtokens.filter((t) => hay.includes(t)).length / qtokens.length;
        if (cov >= 0.6) lex = 0.5 + 0.4 * cov; // most/all query words present
      }
      if (lex > 0) scored.set(n.id, lex);
    }

    // ── lexical: Fuse typo/approximate (only when fuzzy is enabled) ──
    if (fuzzy) {
      for (const r of rankFuzzy(q, notes, { fields: (e) => this._embedText(e).split('\n'), threshold: 0.6, limit: Math.max(limit, 20), tiebreak: (e) => e.id })) {
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
      } catch (e) { semanticError = String(e?.message || e).slice(0, 200); } // visible, not silent
    }

    const ranked = [...scored.entries()]
      .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(b[0]))
      .slice(0, limit)
      .map(([id]) => byId.get(id))
      .filter(Boolean);
    return { notes: ranked, semantic, ...(semanticError ? { semantic_error: semanticError } : {}) };
  }
}
