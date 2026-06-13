// The catalog SEARCH subsystem behind semantic_index({ search }). Owns all matching +
// ranking so the engine just delegates. Five corpora are searched in one call:
//   event names · event properties · dimension attributes · recipes · indexed VALUES.
//
// The four SCHEMA corpora are static for the engine's life, so their Fuse indexes are
// built ONCE (lazily) and reused — weighted so a NAME/id outranks a description match.
// VALUES are dynamic (the background indexer keeps writing), so they are searched live
// via the value index (exact substring in SQL + a fuzzy fallback over a bounded pool).
//
// Every match across every corpus carries { score (similarity, 1=best), match:
// 'exact' | 'fuzzy' }, exact hits first — a consistent shape the AI can rely on.

import { FuzzyIndex } from './fuzzy.js';

const round3 = (n) => (n == null ? null : Math.round(n * 1000) / 1000);
const NAME_WEIGHT = 2; // a name/id match outranks a description match
const DESC_WEIGHT = 1;

export class CatalogSearch {
  constructor({ catalog, recipes, valueIndex }) {
    this.catalog = catalog;
    this.recipes = recipes;
    this.valueIndex = valueIndex;
    this._indexes = null; // built lazily on first search
  }

  /** Build (once) the Fuse indexes for the static schema corpora. */
  _build() {
    if (this._indexes) return this._indexes;
    const c = this.catalog;
    const descs = c.eventPropertyDescriptions();

    const events = new FuzzyIndex(c.eventNames(), {
      keys: [{ name: 'name', get: (e) => e }],
      tiebreak: (e) => e,
    });
    const properties = new FuzzyIndex(c.eventProps(), {
      keys: [
        { name: 'name', weight: NAME_WEIGHT, get: (p) => p },
        { name: 'desc', weight: DESC_WEIGHT, get: (p) => descs[p] || '' },
      ],
      tiebreak: (p) => p,
    });
    // Dimension attributes of the non-anchor models (users/experiments), keyed as
    // '<model>.<column>' — CONSISTENT with the { property } drill-down that accepts it.
    const dimItems = [];
    for (const mk of c.modelKeys()) {
      if (mk === c.anchor) continue;
      const dDescs = c.columnDescriptions(mk);
      for (const [col, dspec] of Object.entries(c.getModel(mk).dimensions || {})) {
        dimItems.push({ property: `${mk}.${col}`, model: mk, column: col, type: dspec.type, description: dDescs[col] || '' });
      }
    }
    const dimensions = new FuzzyIndex(dimItems, {
      keys: [
        { name: 'name', weight: NAME_WEIGHT, get: (d) => [d.column, d.property] },
        { name: 'desc', weight: DESC_WEIGHT, get: (d) => d.description },
      ],
      tiebreak: (d) => d.property,
    });
    const recipes = this.recipes ? new FuzzyIndex(this.recipes.summary(), {
      keys: [
        { name: 'name', weight: NAME_WEIGHT, get: (r) => [r.id, r.title, r.task_type].map((s) => String(s || '')) },
        { name: 'desc', weight: DESC_WEIGHT, get: (r) => [r.when_to_use, r.hack].map((s) => String(s || '')) },
      ],
      tiebreak: (r) => r.id,
    }) : null;

    this._indexes = { events, properties, dimensions, recipes };
    return this._indexes;
  }

  /**
   * Run a search. { search, fuzzy = true, limit = 20 }. Returns the full response:
   * matches per corpus (each { …, score, match }) + actionable recommendations.
   */
  run({ search, fuzzy = true, limit = 20 }) {
    const c = this.catalog;
    const query = String(search);
    const { events, properties, dimensions, recipes } = this._build();
    const opts = { threshold: fuzzy ? 0.6 : 1.01, fuzzy };
    const applies = c.eventPropertyEvents(); // property -> [event_name]; absent ⇒ all events

    const event_names = events.search(query, opts).map(({ item: e, score, match }) => ({
      event: e,
      property_count: c.eventProps().filter((p) => { const evs = applies[p]; return !evs || evs.includes(e); }).length,
      score: round3(score), match,
    }));
    const property_matches = properties.search(query, opts).map(({ item: p, score, match }) => ({
      property: p, type: c.eventPropertySpec(p)?.type ?? null, events: applies[p] || null, score: round3(score), match,
    }));
    const dimension_matches = dimensions.search(query, opts).map(({ item: d, score, match }) => ({
      property: d.property, model: d.model, type: d.type, description: d.description || undefined, score: round3(score), match,
    }));
    const recipe_matches = recipes
      ? recipes.search(query, opts).map(({ item: r, score, match }) => ({ id: r.id, title: r.title, task_type: r.task_type, score: round3(score), match }))
      : [];

    // VALUE matches live in the (dynamic) value index: exact substring + fuzzy fallback.
    // Namespaced keys ('users.country') are dimension attributes; bare keys are event
    // properties with the event(s) carrying them — so "rewarded" resolves to its
    // property, and a mistyped "germny" still surfaces 'Germany'.
    const value_matches = this.valueIndex.searchValues(query, limit, { fuzzy }).map((v) => {
      const dot = v.property.indexOf('.');
      const base = { value: v.value, freq: v.freq, property: v.property, score: round3(v.score ?? 1), match: v.match || 'exact' };
      if (dot > 0) {
        const mk = v.property.slice(0, dot); const col = v.property.slice(dot + 1);
        return { ...base, type: c.models[mk]?.dimensions?.[col]?.type ?? null, model: mk, events: null };
      }
      return { ...base, type: c.eventPropertySpec(v.property)?.type ?? null, events: applies[v.property] || null };
    });

    return { query, fuzzy, event_names, property_matches, dimension_matches, value_matches, recipe_matches, recommendations: this._recommend({ query, fuzzy, event_names, property_matches, dimension_matches, value_matches, recipe_matches }) };
  }

  /** Concrete next-move guidance from the matches (≤4), with a did-you-mean note. */
  _recommend({ query, fuzzy, event_names, property_matches, dimension_matches, value_matches, recipe_matches }) {
    const recs = [];
    if (value_matches.length) {
      const top = value_matches[0];
      recs.push(`Value '${top.value}' lives in ${top.model ? `attribute '${top.property}' (the '${top.model}' model)` : `property '${top.property}'`}${top.events ? ` (events: ${top.events.join(', ')})` : ''} — see its full value/frequency distribution: semantic_index({ property: '${top.property}' }).`);
      if (top.events?.[0]) recs.push(`See everything event '${top.events[0]}' carries: semantic_index({ event: '${top.events[0]}' }).`);
    }
    if (recipe_matches.length) recs.push(`Recipe '${recipe_matches[0].id}' covers this task type — semantic_index({ recipe: '${recipe_matches[0].id}' }) returns a ready payload + the reusable technique.`);
    if (dimension_matches.length) recs.push(`Attribute '${dimension_matches[0].property}' matches — drill its values with semantic_index({ property: '${dimension_matches[0].property}' }).`);
    if (property_matches.length) recs.push(`Drill into property '${property_matches[0].property}' for its real values + cardinality: semantic_index({ property: '${property_matches[0].property}' }).`);
    if (event_names.length) recs.push(`See what event '${event_names[0].event}' carries: semantic_index({ event: '${event_names[0].event}' }).`);

    const all = [...event_names, ...property_matches, ...dimension_matches, ...value_matches, ...recipe_matches];
    if (all.length && !all.some((m) => m.match === 'exact')) {
      recs.unshift(`No exact match for '${query}' — these are the closest matches by similarity (fuzzy). Refine the spelling if none fit.`);
    }
    if (!all.length) recs.push(`No catalog match for '${query}'${fuzzy ? '' : ' (fuzzy disabled)'}. Try semantic_index() for the event list, a broader substring${fuzzy ? '' : ', or drop fuzzy:false'}.`);
    return recs.slice(0, 4);
  }
}
