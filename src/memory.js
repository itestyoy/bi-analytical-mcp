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
   * Find notes matching `query`. Always runs the LEXICAL/FUZZY match (shared Fuse.js
   * subsystem: exact-substring first, then typo/approximate over note text + aliases +
   * target keys). When an embedder is configured it ALSO runs SEMANTIC search — embeds
   * the query, KNN over the stored vectors (sqlite-vec when available, else JS cosine),
   * and BLENDS the two (a note ranks by the better of its fuzzy / cosine score) — so
   * "monetization issues" can surface a note about "IAP purchase failures" with no shared
   * words. Self-healing: any note missing a current-model vector is embedded on the fly
   * (one batch call) and persisted. fuzzy:false restricts the lexical side to exact
   * substring (semantic still runs if configured). Async because embedding is a network op.
   */
  async search(query, { limit = 20, fuzzy = true } = {}) {
    const q = String(query ?? '').trim();
    if (!q) return [];
    const notes = this.all({ limit: 2000 });
    if (!notes.length) return [];

    // Lexical/fuzzy candidates (over-fetch a little so the blend has room to reorder).
    const lexical = rankFuzzy(q, notes, {
      fields: (e) => this._embedText(e).split('\n'),
      threshold: fuzzy ? 0.6 : 2, // > 1 -> exact-substring only (rankFuzzy turns fuzzy off)
      limit: Math.max(limit, 20),
      tiebreak: (e) => e.id,
    });

    // Blend by id: start from the lexical hits, then fold in semantic hits.
    const byId = new Map(notes.map((n) => [n.id, n]));
    const scored = new Map(); // id -> best score
    for (const r of lexical) scored.set(r.item.id, r.score);

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
      } catch { /* provider/store failed → lexical results only (graceful) */ }
    }

    return [...scored.entries()]
      .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(b[0]))
      .slice(0, limit)
      .map(([id]) => byId.get(id))
      .filter(Boolean);
  }
}
