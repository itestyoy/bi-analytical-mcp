// The catalog SEARCH subsystem behind semantic_index({ request: { search } }). Owns all matching +
// ranking so the engine just delegates. Five corpora are searched in one call:
//   event names · event properties · models' columns · recipes · indexed VALUES.
// Every match names what it found as the ref names it — { source, event }, { source, property },
// { source, column } — so a hit is the view to drill into, written as that view takes it.
//
// The four SCHEMA corpora are static for the engine's life, so their Fuse indexes are
// built ONCE (lazily) and reused — weighted so a NAME/id outranks a description match.
// VALUES are dynamic (the background indexer keeps writing), so they are searched live
// via the value index (exact substring in SQL + a fuzzy fallback over a bounded pool).
//
// Every match across every corpus carries { score (similarity, 1=best), match:
// 'exact' | 'fuzzy' }, exact hits first — a consistent shape the AI can rely on.

import { FuzzyIndex } from './fuzzy.js';
import { keyRef, keyView } from './engine/value-index-views.js';

const round3 = (n) => (n == null ? null : Math.round(n * 1000) / 1000);
const NAME_WEIGHT = 2; // a name/id match outranks a description match
const DESC_WEIGHT = 1;
const RECIPE_MATCHES = 3; // recipes listed for one query, at most
const RECIPE_SPREAD = 0.15; // and only those within this of the best score
const WEAK_MATCH = 0.8; // a best fuzzy score below this is no close match
const RECIPE_CLOSE = 0.85; // a loose recipe match below this is listed, not recommended
const MENTIONED = 0.8; // a recipe whose prose (not its id or title) holds the word scores this
const RECIPE_BESIDE_NAME = 0.9; // beside a match of the data's own names, a loose recipe below this is left out
const MATCH_SPREAD = 0.15; // a loose match is shown only within this of the best match of any list
const WEAK_SHOWN = 2; // where nothing matches closely, each list shows at most this many resemblances

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
    // Every source's vocabulary is searchable. An item carries its SOURCE as a field, so a hit
    // says where it lives without the source being glued into the name.
    const eventItems = c.facts.flatMap((f) => c.eventNames(f).map((name) => ({ source: f, name })));
    const propItems = c.facts.flatMap((f) => {
      const d = c.eventPropertyDescriptions(f);
      return c.eventProps(f).map((name) => ({ source: f, name, desc: d[name] || '' }));
    });
    const events = new FuzzyIndex(eventItems, {
      keys: [{ name: 'name', get: (e) => e.name }],
      tiebreak: (e) => `${e.source}.${e.name}`,
    });
    const properties = new FuzzyIndex(propItems, {
      keys: [
        { name: 'name', weight: NAME_WEIGHT, get: (p) => p.name },
        { name: 'desc', weight: DESC_WEIGHT, get: (p) => p.desc },
      ],
      tiebreak: (p) => `${p.source}.${p.name}`,
    });
    // The models' groupable columns: { source, column } — the pair the { source, column } view takes.
    const dimItems = [];
    // EVERY model's attributes, events sources included: a dimension that lives only on a fact
    // (the app column, a crash source's app_version) is as searchable as a users attribute.
    for (const mk of c.modelKeys()) {
      const dDescs = c.columnDescriptions(mk);
      for (const [col, dspec] of Object.entries(c.getModel(mk).dimensions || {})) {
        dimItems.push({ source: mk, column: col, type: dspec.type, description: dDescs[col] || '' });
      }
    }
    const dimensions = new FuzzyIndex(dimItems, {
      keys: [
        { name: 'name', weight: NAME_WEIGHT, get: (d) => [d.column] },
        { name: 'desc', weight: DESC_WEIGHT, get: (d) => d.description },
      ],
      tiebreak: (d) => `${d.source}.${d.column}`,
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
    // DATA-DERIVED applicability per source, from the value index (which events actually carry each
    // property), not the declared meta.mcp.events. Absent/unknown ⇒ treated as "all events" downstream.
    const appliesOf = (source) => this.valueIndex.appliesMap(source, c.eventProps(source));

    const event_names = events.search(query, opts).map(({ item: e, score, match }) => {
      const applies = appliesOf(e.source);
      return {
        event: e.name,
        source: e.source,
        property_count: c.eventProps(e.source).filter((p) => { const evs = applies[p]; return !evs || evs.includes(e.name); }).length,
        score: round3(score), match,
      };
    });
    const property_matches = properties.search(query, opts).map(({ item: p, score, match }) => ({
      property: p.name,
      source: p.source,
      type: c.eventPropertySpec(p.name, p.source)?.type ?? null,
      events: appliesOf(p.source)[p.name] || null,
      score: round3(score), match,
    }));
    const column_matches = dimensions.search(query, opts).map(({ item: d, score, match }) => ({
      source: d.source, column: d.column, type: d.type, description: d.description || undefined, score: round3(score), match,
    }));
    const recipe_matches = recipes
      ? recipes.search(query, opts).map(({ item: r, score, match }) => {
        // a word found only in a recipe's prose (when to use it, its technique) is mentioned there, not
        // what the recipe is: exact is kept for its id and title
        const named = [r.id, r.title, r.task_type].some((x) => String(x || '').toLowerCase().includes(String(query).toLowerCase()));
        return match === 'exact' && !named
          ? { id: r.id, title: r.title, task_type: r.task_type, score: MENTIONED, match: 'mentioned' }
          : { id: r.id, title: r.title, task_type: r.task_type, score: round3(score), match };
      })
        // a loose query touches many recipes' prose: the few nearest the best one are the answer
        .filter((r, i, all) => i < RECIPE_MATCHES && r.score >= all[0].score - RECIPE_SPREAD)
      : [];

    // VALUE matches live in the (dynamic) value index: exact substring + fuzzy fallback.
    // Each hit names its SOURCE plus what carries it there — so "rewarded" resolves to the
    // property that carries it, and a mistyped "germny" still surfaces 'Germany'.
    // An indexed value belongs to (source, key): an event property of that source ({ property }), or one
    // of its columns ({ column }) — which, the catalog says (keyRef), as the views take them.
    const value_matches = this.valueIndex.searchValues(query, limit, { fuzzy }).map((v) => {
      const ref = keyRef(c, v.source, v.property);
      const base = { value: v.value, freq: v.freq, source: v.source, ...ref, score: round3(v.score ?? 1), match: v.match || 'exact' };
      if (ref.property !== undefined) return { ...base, type: c.eventPropertySpec(v.property, v.source)?.type ?? null, events: appliesOf(v.source)[v.property] || null };
      return { ...base, type: c.models[v.source]?.dimensions?.[v.property]?.type ?? null, events: null };
    });
    // A loose match is said only near the best one: a query that names something exactly (or nearly)
    // is answered by that, not by every name its letters resemble — within a list, an exact match
    // leaves out the list's loose ones; across the lists, a match far below the best is left out.
    const lists = { event_names, property_matches, column_matches, value_matches, recipe_matches };
    const best = Math.max(0, ...Object.values(lists).flat().map((m) => m.score ?? 0));
    const near = (list) => {
      const exact = list.some((m) => m.match === 'exact');
      return list.filter((m) => m.match === 'exact' || (!exact && (m.score ?? 0) >= best - MATCH_SPREAD));
    };
    // (where nothing matches closely, a few resemblances per list are enough to say so)
    for (const k of Object.keys(lists)) lists[k] = near(lists[k]).slice(0, best < WEAK_MATCH ? WEAK_SHOWN : undefined);
    // a recipe is a task type, not a name of the data: beside a name the word does match (an event, a
    // value), a recipe whose title only resembles it is left out — an exact one, or a close one, stays
    const named = ['event_names', 'property_matches', 'column_matches', 'value_matches'].some((k) => lists[k].length);
    if (named) lists.recipe_matches = lists.recipe_matches.filter((m) => m.match === 'exact' || (m.score ?? 0) >= RECIPE_BESIDE_NAME);
    const recommendations = this._recommend({ query, fuzzy, ...lists });

    return { query, fuzzy, ...lists, recommendations };
  }

  /** Concrete next-move guidance from the matches (≤4), with a did-you-mean note. */
  _recommend({ query, fuzzy, event_names, property_matches, column_matches, value_matches, recipe_matches }) {
    const recs = [];
    if (value_matches.length) {
      const top = value_matches[0];
      // a column of its model, or a property riding on that source's events (run() says which)
      const name = top.property ?? top.column;
      recs.push(`Value '${top.value}' lives in ${top.property !== undefined ? 'property' : 'column'} '${name}' of source '${top.source}'${top.events ? ` (events: ${top.events.join(', ')})` : ''} — see its full value/frequency distribution: ${keyView(this.catalog, top.source, name)}.`);
      if (top.events?.[0]) recs.push(`See everything event '${top.events[0]}' carries: semantic_index({ request: { source: '${top.source}', event: '${top.events[0]}' } }).`);
    }
    // the schema's best matches, the closest first (an event before a column at the same score)
    const named = [
      ...(event_names.length ? [{ score: event_names[0].score, text: `See what event '${event_names[0].event}' of source '${event_names[0].source}' carries: semantic_index({ request: { source: '${event_names[0].source}', event: '${event_names[0].event}' } }).` }] : []),
      ...(property_matches.length ? [{ score: property_matches[0].score, text: `Drill into property '${property_matches[0].property}' of source '${property_matches[0].source}' for its real values + cardinality: semantic_index({ request: { source: '${property_matches[0].source}', property: '${property_matches[0].property}' } }).` }] : []),
      ...(column_matches.length ? [{ score: column_matches[0].score, text: `Column '${column_matches[0].column}' of source '${column_matches[0].source}' matches — drill its values with semantic_index({ request: { source: '${column_matches[0].source}', column: '${column_matches[0].column}' } }).` }] : []),
      // (a recipe is said to cover the task only where it matches it closely — a loose one is listed, not recommended)
      ...(recipe_matches.length && (recipe_matches[0].match === 'exact' || recipe_matches[0].score >= RECIPE_CLOSE) ? [{ score: recipe_matches[0].score, text: `Recipe '${recipe_matches[0].id}' covers this task type — semantic_index({ request: { recipe: '${recipe_matches[0].id}' } }) returns a ready payload + the reusable technique.` }] : []),
    ];
    const all = [...event_names, ...property_matches, ...column_matches, ...value_matches, ...recipe_matches];
    const best = all.length ? Math.max(...all.map((m) => (m.match === 'exact' ? 1 : m.score ?? 0))) : 0;
    // (a match that only resembles the word is listed, not recommended: the note below says the data may not hold it)
    if (best >= WEAK_MATCH) recs.push(...named.sort((a, b) => b.score - a.score).map((n) => n.text));

    if (all.length && !all.some((m) => m.match === 'exact')) {
      recs.unshift(best < WEAK_MATCH
        ? `Nothing in the catalog matches '${query}' closely — the matches below only resemble it (fuzzy, best ${best}); the data may not hold it. Check the event list (semantic_index({ request: {} })) before building on one of them.`
        : `No exact match for '${query}' — these are the closest matches by similarity (fuzzy). Refine the spelling if none fit.`);
    }
    if (!all.length) recs.push(`No catalog match for '${query}'${fuzzy ? '' : ' (fuzzy disabled)'}. Try semantic_index({ request: {} }) for the event list, a broader substring${fuzzy ? '' : ', or drop fuzzy:false'}.`);
    return recs.slice(0, 4);
  }
}
