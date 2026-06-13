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

export class MemoryStore {
  constructor({ store } = {}) {
    this.store = store;
  }

  /** Persist one finding. Returns the stored entry (with its generated id + timestamp). */
  record({ note, targets = [], aliases = [], links = [] } = {}) {
    const id = randomUUID().replace(/-/g, '').slice(0, 12);
    const entry = { id, note: String(note), targets, aliases, links, created_at: Date.now() };
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
   * FUZZY match over a note's TEXT, its aliases (the user's phrasings) and its target
   * keys/terms — so a word the user used (even mistyped or paraphrased) resolves back to
   * the finding. Powered by the shared Fuse.js subsystem (src/fuzzy.js): EXACT-substring
   * hits rank first, then typo/approximate hits above the similarity floor. Pass
   * fuzzy:false for exact-substring only. The note set is tiny, so a one-shot rank over
   * all notes is cheap (no persistent vector index needed).
   */
  search(query, { limit = 20, fuzzy = true } = {}) {
    const q = String(query ?? '').trim();
    if (!q) return [];
    const notes = this.all({ limit: 2000 });
    if (!notes.length) return [];
    const ranked = rankFuzzy(q, notes, {
      // Search the note text, the aliases, and the target KEYS (the "<kind>:" prefix
      // stripped, so "ad_type_of_event_data" / "users.country" / a free phrase all match).
      fields: (e) => [
        e.note,
        ...(e.aliases || []),
        ...(e.targets || []).map((t) => { const i = String(t).indexOf(':'); return i > 0 ? t.slice(i + 1) : String(t); }),
      ].filter(Boolean),
      threshold: fuzzy ? 0.6 : 2, // > 1 -> exact-substring only (rankFuzzy turns fuzzy off)
      limit,
      tiebreak: (e) => e.id,
    });
    return ranked.map((r) => r.item);
  }
}
