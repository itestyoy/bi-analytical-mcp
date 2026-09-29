// WHAT A METRIC CAN BE GROUPED BY, AS METRICFLOW SAYS — not as this server works it out. MetricFlow
// lists, per metric, every group-by item it accepts (src/backends/mf-engine.js groupBys): a dimension
// with the semantic model that carries it and the ENTITY PATH to it (`entity_links`, one entity for a
// dimension of the metric's own model, more through joins), an entity, and metric_time with its grain.
// MetricFlow itself builds every join; what it needs is WHICH item, and its name for one always carries
// the entity path (`media_source__label`) — it takes no bare `label`, even when only one path exists.
// A caller names the item by what it is and where it lives — the semantic model, or for a link of
// several joins the CHAIN of semantic models it is reached through — and this module finds MetricFlow's
// name for it in MetricFlow's own list. Each hop of MetricFlow's entity path is named by the model it
// joins onto (annotateChains). `via` (the entity) is asked for only where one chain is joined through
// different keys — a role: a buyer's country and a seller's are one chain, users — the case MetricFlow
// does not choose either. Nothing else is inferred: a reference names one listed item, or is refused
// with the ways it can be named.
//
// A reference, in a context of one semantic model (`own`):
//   { semantic_model: [own], dimension, grain? }           — a dimension of the context's own model;
//   { semantic_model: ['X'], dimension, grain? }           — of X, joined to directly;
//   { semantic_model: ['A', 'X'], dimension, grain? }      — of X, through A (the chain of joins);
//   … plus via: the entity                                 — only for a role (one chain, several keys);
//   { entity } (+ via for a path)                          — an entity;
//   { time: 'metric_time', grain }                         — the time axis.
// semantic_model is always the chain, one model or several, matched as written: one spelling per item.

const sameLinks = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
/** `via` as the caller writes it (one entity, or a path) → the entity path. */
export const viaPath = (via) => (via == null ? null : Array.isArray(via) ? via : [via]);
const viaOf = (links) => (links.length === 1 ? links[0] : links);

/** An item's identity, across metrics: the same dimension of the same semantic model through the same
 *  path is the same item; an entity is its name and path, whichever model's metric lists it. */
const keyOf = (i) => `${i.kind}\u0000${i.kind === 'entity' ? '' : i.semantic_model || ''}\u0000${i.name}\u0000${(i.entity_links || []).join('.')}`;

/** The items EVERY one of `metrics` can be grouped by (MetricFlow's list for each, intersected). */
export function commonItems(groupBys, metrics) {
  const lists = metrics.map((m) => groupBys[m] || []);
  if (!lists.length) return [];
  const rest = lists.slice(1).map((l) => new Set(l.map(keyOf)));
  return lists[0].filter((i) => rest.every((s) => s.has(keyOf(i))));
}

const isTime = (i) => i.kind === 'dimension' && i.name === 'metric_time' && !i.semantic_model;

const IDENTITY = new Set(['primary', 'unique', 'natural']);
/** Whether a semantic model (as src/semantic-manifest.js reads it) is unique on an entity — what a join
 *  through that entity lands on. */
const uniqueOn = (m, e) => m.entity === e || (m.entities || []).some((x) => x.name === e && IDENTITY.has(x.type));

/**
 * Each dimension's CHAIN — the semantic models MetricFlow's entity path joins through, in order, the
 * last being the model that carries it. A hop is named by the declaration: the one model unique on that
 * entity that also carries the next entity of the path. Where a hop names no single model the chain is
 * left out, and the item is named by its path (via). Adds `chain` to the items, in place.
 */
export function annotateChains(groupBys, models) {
  for (const items of Object.values(groupBys || {})) {
    for (const item of items) {
      if (item.kind !== 'dimension' || isTime(item)) continue;
      const links = item.entity_links || [];
      const hops = links.slice(0, -1).map((e, i) => {
        const at = models.filter((m) => uniqueOn(m, e) && (m.entities || []).some((x) => x.name === links[i + 1]));
        return at.length === 1 ? at[0].name : null;
      });
      item.chain = hops.every(Boolean) ? [...hops, item.semantic_model] : null;
    }
  }
  return groupBys;
}

/** Where a dimension lives, as a reference writes it: the chain of models it is reached through — its
 *  own model alone for a direct join; the model alone (and via) where a hop cannot be named. */
const whereOf = (item) => item.chain || [item.semantic_model];
/** The time axis among a metric's items (metric_time, with the finest grain MetricFlow allows), or null. */
export const timeItem = (items) => items.find(isTime) || null;

/** The items a reference without `via` would mean too: the same dimension where it lives — the same
 *  model, or the same chain — (or the same entity) by another key. */
const samesOf = (items, item) => {
  const same = items.filter((i) => i.kind === item.kind && i.name === item.name && !isTime(i) && (item.kind === 'entity' || JSON.stringify(whereOf(i)) === JSON.stringify(whereOf(item))));
  // an entity several models declare is ONE key: told apart only by the path it is reached through
  return item.kind === 'entity' ? [...new Map(same.map((i) => [(i.entity_links || []).join('.'), i])).values()] : same;
};

/** The reference a caller writes for an item, in a context of `own`, among the `items` listed with
 *  it: via only when MetricFlow lists that dimension (or entity) through more than one path. */
export function refOf(item, own, items = [item]) {
  if (isTime(item)) return { time: 'metric_time', grain: item.grain || 'day' };
  const links = item.entity_links || [];
  const grain = item.type === 'time' && item.grain ? { grain: item.grain } : {};
  const via = samesOf(items, item).length > 1 ? { via: viaOf(links) } : {};
  if (item.kind === 'entity') return { entity: item.name, ...via };
  return { semantic_model: whereOf(item), dimension: item.name, ...via, ...grain };
}

/** MetricFlow's token for an item (at `grain` for a time dimension). */
export function tokenOf(item, grain) {
  if (isTime(item)) return `metric_time__${grain || item.grain || 'day'}`;
  const base = item.kind === 'entity' ? [...(item.entity_links || []), item.name].join('__') : item.dunder_name;
  return item.type === 'time' ? `${base}__${grain || item.grain || 'day'}` : base;
}

/** The result column an item's group-by becomes: the caller's name, never MetricFlow's token. */
export function columnOf(item, grain) {
  if (isTime(item)) return `metric_time_${grain || item.grain || 'day'}`;
  if (item.kind === 'entity') return [...(item.entity_links || []), item.name].join('_');
  return `${item.semantic_model}_${item.name}${item.type === 'time' ? `_${grain || item.grain || 'day'}` : ''}`;
}

/** How an item is shown in a message: the reference that names it (among `items`). */
export const labelOf = (item, own, items) => JSON.stringify(refOf(item, own, items)).replace(/"(\w+)":/g, '$1: ');

/**
 * The ONE item a reference names among `items` → { item } | { error }. semantic_model is the chain of
 * models the dimension is reached through, matched as written (one model: its direct join); `via` picks
 * a role where one chain is joined through several keys, and must then be given. No match, or several,
 * is an error naming the ways it can be named.
 */
export function resolveRef(items, ref, own, subject = 'this') {
  const show = (list) => list.slice(0, 30).map((i) => labelOf(i, own, items)).join(', ') || '(none but metric_time)';
  const via = viaPath(ref.via);
  const byPath = (list) => (via ? list.filter((i) => sameLinks(i.entity_links || [], via)) : list);
  if (ref && 'entity' in ref) {
    const named = items.filter((i) => i.kind === 'entity' && i.name === ref.entity);
    // an entity several models declare is one key: distinct only by its path
    const paths = [...new Map(named.map((i) => [(i.entity_links || []).join('.'), i])).values()];
    const hits = byPath(paths);
    if (hits.length === 1) return { item: hits[0] };
    if (hits.length > 1) return { error: `the entity '${ref.entity}' is reached by several paths: ${show(hits)} — name the one you mean with via` };
    return { error: named.length ? `the entity '${ref.entity}' is reached as ${show(paths)}` : `the entity '${ref.entity}' is not one ${subject} can be grouped by. It can: ${show(items.filter((i) => i.kind === 'entity'))}` };
  }
  const dims = items.filter((i) => i.kind === 'dimension' && !isTime(i));
  const chain = Array.isArray(ref.semantic_model) ? ref.semantic_model : [ref.semantic_model];
  const model = chain[chain.length - 1];
  const label = `${chain.join(' → ')}.${ref.dimension}`;
  const named = dims.filter((i) => i.name === ref.dimension && i.semantic_model === model);
  const hits = byPath(named.filter((i) => JSON.stringify(whereOf(i)) === JSON.stringify(chain)));
  if (hits.length === 1) return { item: hits[0] };
  if (hits.length > 1) return { error: `'${label}' is reached several ways: ${show(hits)} — name the one you mean` };
  if (named.length) return { error: `'${label}' is reached as ${show(named)}` };
  const elsewhere = dims.filter((i) => i.name === ref.dimension);
  if (elsewhere.length) return { error: `'${ref.dimension}' is not a dimension of ${model}; it is ${show(elsewhere)}` };
  return { error: `'${label}' is not a dimension ${subject} can be grouped by. It can: ${show(dims)}` };
}
