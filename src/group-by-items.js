// WHAT A METRIC CAN BE GROUPED BY, AS METRICFLOW SAYS — not as this server works it out. MetricFlow
// lists, per metric, every group-by item it accepts (src/backends/mf-engine.js groupBys): a dimension
// with the semantic model that carries it and the ENTITY PATH to it (`entity_links`, one entity for a
// dimension of the metric's own model, more through joins), an entity, and metric_time with its grain.
// MetricFlow itself builds every join; what it needs is WHICH item, and its name for one always carries
// the entity path (`media_source__label`) — it takes no bare `label`, even when only one path exists.
// A caller names the item by what it is and where it lives, and this module finds MetricFlow's name
// for it in MetricFlow's own list. `via` (the entity path) is asked for only where MetricFlow lists
// SEVERAL paths to the same dimension — the one case MetricFlow does not choose either. Nothing else
// is inferred: a reference names one listed item, or is refused with the ways it can be named.
//
// A reference, in a context of one semantic model (`own`):
//   { dimension, grain? }                         — a dimension of `own`;
//   { semantic_model, dimension, grain? }         — a dimension of another semantic model;
//   … plus via: the entity path                   — only when MetricFlow lists several paths to it;
//   { entity } (+ via, likewise)                  — an entity;
//   { time: 'metric_time', grain }                — the time axis.

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
/** The time axis among a metric's items (metric_time, with the finest grain MetricFlow allows), or null. */
export const timeItem = (items) => items.find(isTime) || null;

/** The items a reference without `via` could mean: the same dimension of the same model (or the
 *  same entity) by any path MetricFlow lists. */
const samesOf = (items, item) => items.filter((i) => i.kind === item.kind && i.name === item.name && (item.kind === 'entity' || i.semantic_model === item.semantic_model) && !isTime(i));

/** The reference a caller writes for an item, in a context of `own`, among the `items` listed with
 *  it: via only when MetricFlow lists that dimension (or entity) through more than one path. */
export function refOf(item, own, items = [item]) {
  if (isTime(item)) return { time: 'metric_time', grain: item.grain || 'day' };
  const links = item.entity_links || [];
  const grain = item.type === 'time' && item.grain ? { grain: item.grain } : {};
  const via = samesOf(items, item).length > 1 ? { via: viaOf(links) } : {};
  if (item.kind === 'entity') return { entity: item.name, ...via };
  if (item.semantic_model === own) return { dimension: item.name, ...via, ...grain };
  return { semantic_model: item.semantic_model, dimension: item.name, ...via, ...grain };
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
 * The ONE item a reference names among `items` → { item } | { error }. The dimension of the model the
 * reference says it lives in (the context's own when semantic_model is left out) — found in
 * MetricFlow's list, with the path MetricFlow gives it; `via` picks among paths only where the list
 * holds several, and must then be given. No match, or several without via, is an error naming what
 * there is.
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
  const sm = ref.semantic_model || own;
  const named = dims.filter((i) => i.name === ref.dimension && i.semantic_model === sm);
  const hits = byPath(named);
  if (hits.length === 1) return { item: hits[0] };
  if (hits.length > 1) return { error: `'${sm}.${ref.dimension}' is reached by several paths: ${show(hits)} — name the one you mean with via` };
  if (named.length) return { error: `'${sm}.${ref.dimension}' is reached as ${show(named)} — not through that via` };
  const elsewhere = dims.filter((i) => i.name === ref.dimension);
  if (elsewhere.length) return { error: `'${ref.dimension}' is not a dimension of ${sm}; it is ${show(elsewhere)}` };
  return { error: `'${sm}.${ref.dimension}' is not a dimension ${subject} can be grouped by. It can: ${show(dims)}` };
}
