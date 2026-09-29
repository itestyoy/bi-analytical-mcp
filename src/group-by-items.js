// WHAT A METRIC CAN BE GROUPED BY, AS METRICFLOW SAYS — not as this server works it out. MetricFlow
// lists, per metric, every group-by item it accepts (src/backends/mf-engine.js groupBys): a dimension
// with the semantic model that carries it and the ENTITY PATH to it (`entity_links`, one entity for a
// dimension of the metric's own model, more through joins), an entity, and metric_time with its grain.
// This module turns that list into the references a caller names, and a reference back into exactly
// one item — nothing is inferred: a reference either names one item of the list, or is refused with
// the items it could have named.
//
// A reference, in a context of one semantic model (`own`):
//   { dimension, grain? }                        — a dimension of `own`, reached directly;
//   { semantic_model, dimension, via, grain? }   — any other: `via` is the entity path, as listed;
//   { entity } / { entity, via }                 — an entity (via when it is reached through others);
//   { time: 'metric_time', grain }               — the time axis.

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
/** A dimension of `own` reached directly — what { dimension } alone names. */
const isOwnDirect = (i, own) => i.kind === 'dimension' && i.semantic_model === own && (i.entity_links || []).length === 1;

/** The reference a caller writes for an item, in a context of `own`. */
export function refOf(item, own) {
  if (isTime(item)) return { time: 'metric_time', grain: item.grain || 'day' };
  const links = item.entity_links || [];
  const grain = item.type === 'time' && item.grain ? { grain: item.grain } : {};
  if (item.kind === 'entity') return { entity: item.name, ...(links.length ? { via: viaOf(links) } : {}) };
  if (isOwnDirect(item, own)) return { dimension: item.name, ...grain };
  return { semantic_model: item.semantic_model, dimension: item.name, via: viaOf(links), ...grain };
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

/** How an item is shown in a message: the reference that names it. */
export const labelOf = (item, own) => JSON.stringify(refOf(item, own)).replace(/"(\w+)":/g, '$1: ');

/**
 * The ONE item a reference names among `items` → { item } | { error }. A dimension without
 * semantic_model and via is the context's own, reached directly; otherwise semantic_model, dimension
 * and via name it exactly. Nothing is chosen for the caller: no match, or more than one, is an error
 * naming what there is.
 */
export function resolveRef(items, ref, own, subject = 'this') {
  const show = (list) => list.slice(0, 30).map((i) => labelOf(i, own)).join(', ') || '(none but metric_time)';
  if (ref && 'entity' in ref) {
    const via = viaPath(ref.via) || [];
    const hits = items.filter((i) => i.kind === 'entity' && i.name === ref.entity && sameLinks(i.entity_links || [], via));
    if (hits.length) return { item: hits[0] }; // one entity through one path: the same key whichever model lists it
    const named = items.filter((i) => i.kind === 'entity' && i.name === ref.entity);
    return { error: named.length ? `the entity '${ref.entity}' is reached as ${show(named)} — name it that way` : `the entity '${ref.entity}' is not one ${subject} can be grouped by. It can: ${show(items.filter((i) => i.kind === 'entity'))}` };
  }
  const dims = items.filter((i) => i.kind === 'dimension' && !isTime(i));
  const sm = ref.semantic_model;
  const via = viaPath(ref.via);
  let hits;
  if (!sm && !via) hits = dims.filter((i) => isOwnDirect(i, own) && i.name === ref.dimension);
  else if (via) hits = dims.filter((i) => i.name === ref.dimension && (i.semantic_model === (sm || own)) && sameLinks(i.entity_links || [], via));
  else hits = []; // another model's dimension is named with the path to it
  if (hits.length === 1) return { item: hits[0] };
  const named = dims.filter((i) => i.name === ref.dimension && (!sm || i.semantic_model === sm));
  if (hits.length > 1) return { error: `'${ref.dimension}' is reached by several paths: ${show(hits)} — name the one you mean` };
  if (named.length) return { error: `'${ref.dimension}' is named ${show(named)} — ${sm && !via ? 'a dimension of another semantic model is named with via, the entity path to it' : 'name it that way'}` };
  return { error: `'${sm ? `${sm}.` : ''}${ref.dimension}' is not a dimension ${subject} can be grouped by. It can: ${show(dims)}` };
}
