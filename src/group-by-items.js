// WHAT A METRIC CAN BE GROUPED BY, AS METRICFLOW SAYS — not as this server works it out. MetricFlow
// lists, per metric, every group-by item it accepts (the dbt client's groupBys, src/dbt/v1.js): a dimension
// with the semantic model that carries it and the ENTITY PATH to it (`entity_links`, one entity for a
// dimension of the metric's own model, more through joins), an entity, and metric_time with its grain.
// MetricFlow itself builds every join; what it needs is WHICH item, and its name for one always carries
// the entity path (`media_source__label`) — it takes no bare `label`, even when only one path exists.
// A caller names the item by what it is and where it lives — the CHAIN of semantic models it is reached
// through (one model for its own dimensions or a direct join) — and this module finds MetricFlow's name
// for it in MetricFlow's own list. Each hop of MetricFlow's entity path is named by the model it joins
// onto (annotateChains).
//
// A chain of models names one item — unless the project joins one model through SEVERAL keys (a role: a
// buyer's and a seller's country, both of users) or a hop lands on no single model. Such a join is not
// served (servable): its items are left out of the list, and what is wrong is said, with how to declare
// it so it is served — one semantic model per key. Nothing is guessed: a reference names one listed
// item, or is refused with the ways it can be named.
//
// A reference, in a context of one semantic model (`own`):
//   { semantic_model: [own], dimension, grain? }           — a dimension of the context's own model;
//   { semantic_model: ['X'], dimension, grain? }           — of X, joined to directly;
//   { semantic_model: ['A', 'X'], dimension, grain? }      — of X, through A (the chain of joins);
//   { entity }                                             — an entity;
//   { time: 'metric_time', grain }                         — the time axis.
// semantic_model is always the chain, one model or several, matched as written: one spelling per item.


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
 * null and the hop is recorded (`unnamed`: the entity, the next one, the models it could be) — such an
 * item is not served (servable). Adds `chain` (and `unnamed`) to the items, in place.
 */
export function annotateChains(groupBys, models) {
  for (const items of Object.values(groupBys || {})) {
    for (const item of items) {
      if (item.kind !== 'dimension' || isTime(item)) continue;
      const links = item.entity_links || [];
      let unnamed = null;
      const hops = links.slice(0, -1).map((e, i) => {
        const at = models.filter((m) => uniqueOn(m, e) && (m.entities || []).some((x) => x.name === links[i + 1]));
        if (at.length !== 1 && !unnamed) unnamed = { entity: e, next: links[i + 1], models: at.map((m) => m.name) };
        return at.length === 1 ? at[0].name : null;
      });
      item.chain = unnamed ? null : [...hops, item.semantic_model];
      if (unnamed) item.unnamed = unnamed;
    }
  }
  return groupBys;
}

/** Where a dimension lives, as a reference writes it: the chain of models it is reached through. */
const whereOf = (item) => item.chain || [item.semantic_model];
const sameWhere = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** The time axis among a metric's items (metric_time, with the finest grain MetricFlow allows), or null. */
export const timeItem = (items) => items.find(isTime) || null;

const list = (xs) => xs.map((x) => `'${x}'`).join(', ');

/**
 * What a reference can name, and what it cannot. A join is NOT SERVED where the project joins one
 * semantic model through several keys — a ROLE (a buyer's and a seller's country, both of users):
 * MetricFlow lists the model's dimensions once per key, and the chain of models is the same for each,
 * so no reference can tell them apart — or where a hop of MetricFlow's path lands on no single model.
 * Those items are left out of every metric's list, and each such join is reported once: what is wrong
 * and how to declare it so it is served. `sources` maps a semantic model to the dbt model it reads.
 * → { groupBys, blocked: [{ semantic_model, keys?, dimensions, metrics, message, fix }] }
 */
export function servable(groupBys, sources = {}) {
  const blocked = new Map();
  const note = (key, make, item, metric) => {
    if (!blocked.has(key)) blocked.set(key, { ...make(), dimensions: new Set(), metrics: new Set() });
    const b = blocked.get(key);
    if (item.kind === 'dimension') b.dimensions.add(`${item.semantic_model}.${item.name}`);
    b.metrics.add(metric);
  };
  const out = {};
  for (const [metric, items] of Object.entries(groupBys || {})) {
    const left = new Set();
    // a hop no single model names
    for (const item of items) {
      if (!item.unnamed) continue;
      const { entity, next, models } = item.unnamed;
      note(`hop\u0000${entity}\u0000${next}`, () => ({
        semantic_model: models.length ? models : null,
        message: `MetricFlow joins through the key '${entity}' onto ${models.length ? `several semantic models that each carry '${next}' (${list(models)})` : `no semantic model that is unique on it and carries '${next}'`}, so the chain of models cannot be named`,
        fix: models.length ? `keep '${entity}' primary or unique in one of ${list(models)} only (a foreign key in the others)` : `declare '${entity}' primary or unique on the semantic model that carries '${next}'`,
      }), item, metric);
      left.add(item);
    }
    // one chain of models, several keys: a role
    const byWhere = new Map();
    for (const item of items) {
      if (item.kind !== 'dimension' || isTime(item) || left.has(item)) continue;
      const k = `${item.name}\u0000${JSON.stringify(whereOf(item))}`;
      byWhere.set(k, [...(byWhere.get(k) || []), item]);
    }
    for (const same of byWhere.values()) {
      if (new Set(same.map((i) => i.dunder_name)).size < 2) continue;
      // the first hop whose key differs: the model joined onto through several keys
      const paths = same.map((i) => i.entity_links || []);
      const at = paths[0].findIndex((_, h) => new Set(paths.map((p) => p[h])).size > 1);
      const model = whereOf(same[0])[at];
      const keys = [...new Set(paths.map((p) => p[at]))].sort();
      const dbtModel = sources[model];
      note(`role\u0000${model}\u0000${keys.join('.')}`, () => ({
        semantic_model: model, keys,
        message: `'${model}' is joined onto through several keys (${list(keys)}) — one semantic model in several roles, which the chain of models it is reached through cannot tell apart`,
        fix: `declare one semantic model per key: for each of ${list(keys)} a dbt model of its own over ${dbtModel ? `'${dbtModel}' (select * from {{ ref('${dbtModel}') }})` : `the model '${model}' reads`}, whose semantic model has that key as its primary entity and the dimensions it needs; each role is then a semantic model of its own, named in semantic_model`,
      }), same[0], metric);
      for (const i of same) left.add(i);
    }
    // an entity MetricFlow lists by several paths
    const byName = new Map();
    for (const item of items) if (item.kind === 'entity') byName.set(item.name, [...(byName.get(item.name) || []), item]);
    for (const [name, same] of byName) {
      const tokens = [...new Set(same.map((i) => tokenOf(i)))];
      if (tokens.length < 2) continue;
      note(`entity\u0000${name}`, () => ({
        semantic_model: null, entity: name,
        message: `the entity '${name}' is reached by several paths`,
        fix: `declare '${name}' on the metric's own semantic model, or give each path's key a name of its own`,
      }), same[0], metric);
      for (const i of same) left.add(i);
    }
    out[metric] = items.filter((i) => !left.has(i));
  }
  return { groupBys: out, blocked: [...blocked.values()].map((b) => ({ ...b, dimensions: [...b.dimensions].sort(), metrics: [...b.metrics].sort() })) };
}

/** The reference a caller writes for an item. */
export function refOf(item) {
  if (isTime(item)) return { time: 'metric_time', grain: item.grain || 'day' };
  if (item.kind === 'entity') return { entity: item.name };
  const grain = item.type === 'time' && item.grain ? { grain: item.grain } : {};
  return { semantic_model: whereOf(item), dimension: item.name, ...grain };
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
export const labelOf = (item) => JSON.stringify(refOf(item)).replace(/"(\w+)":/g, '$1: ');

/**
 * The ONE item a reference names among `items` → { item } | { error }. semantic_model is the chain of
 * models the dimension is reached through, matched as written (one model: its own, or a direct join).
 * No match is an error naming the ways it can be named; a join that is not served (`blocked`, from
 * servable) is refused with what is wrong and how to declare it.
 */
export function resolveRef(items, ref, subject = 'this', blocked = []) {
  const show = (xs) => xs.slice(0, 30).map((i) => labelOf(i)).join(', ') || '(none but metric_time)';
  const notServed = (b) => ({ error: `${b.message}: not served. To serve it, ${b.fix}.` });
  if (ref && 'entity' in ref) {
    const named = items.filter((i) => i.kind === 'entity' && i.name === ref.entity);
    // an entity several models declare is one key: MetricFlow lists it once per model, by one token
    if (new Set(named.map((i) => tokenOf(i))).size === 1) return { item: named[0] };
    const b = blocked.find((x) => x.entity === ref.entity);
    if (b) return notServed(b);
    return { error: `the entity '${ref.entity}' is not one ${subject} can be grouped by. It can: ${show(items.filter((i) => i.kind === 'entity'))}` };
  }
  const dims = items.filter((i) => i.kind === 'dimension' && !isTime(i));
  const chain = Array.isArray(ref.semantic_model) ? ref.semantic_model : [ref.semantic_model];
  const model = chain[chain.length - 1];
  const label = `${chain.join(' → ')}.${ref.dimension}`;
  const named = dims.filter((i) => i.name === ref.dimension && i.semantic_model === model);
  const hit = named.find((i) => sameWhere(whereOf(i), chain));
  if (hit) return { item: hit };
  const b = blocked.find((x) => x.dimensions.includes(`${model}.${ref.dimension}`) && (x.keys ? chain.includes(x.semantic_model) : true));
  if (b) return { error: `${notServed(b).error}${named.length ? ` It is also reached as ${show(named)}.` : ''}` };
  if (named.length) return { error: `'${label}' is reached as ${show(named)}` };
  const elsewhere = dims.filter((i) => i.name === ref.dimension);
  if (elsewhere.length) return { error: `'${ref.dimension}' is not a dimension of ${model}; it is ${show(elsewhere)}` };
  return { error: `'${label}' is not a dimension ${subject} can be grouped by. It can: ${show(dims)}` };
}
