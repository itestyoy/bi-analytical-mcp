// What the parts of the engine share. The engine is ONE object (src/engine.js) whose methods live in
// several files, one per concern (src/engine/*.js): each file exports its methods as an object and
// `mixin` puts them on the Engine's prototype, as the class's own methods are — so `this` is the engine
// in every one of them, and a method is reached as `engine.<name>` wherever it is written.

/** Define each method (and getter) of `parts` on `Class.prototype`, non-enumerable like a class's own. A name defined twice is a mistake. */
export function mixin(Class, ...parts) {
  for (const part of parts) {
    for (const [name, desc] of Object.entries(Object.getOwnPropertyDescriptors(part))) {
      if (Object.prototype.hasOwnProperty.call(Class.prototype, name)) throw new Error(`${Class.name}.${name} is defined twice`);
      Object.defineProperty(Class.prototype, name, { ...desc, enumerable: false });
    }
  }
}

/** Presentation shape for a stored memory note: its note, targets, aliases and links, and its time. */
export function memoryView(e) {
  const targets = [...(e.targets || [])];
  return {
    id: e.id,
    note: e.note,
    ...(e.question ? { question: e.question } : {}),
    ...(targets.length ? { about: targets } : {}),
    ...(e.aliases && e.aliases.length ? { aliases: e.aliases } : {}),
    ...(e.links && e.links.length ? { links: e.links } : {}),
    recorded_at: e.created_at ? new Date(e.created_at).toISOString() : null,
  };
}

export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// references, each once (an entity several semantic models declare is one key to group by)
export const uniqueRefs = (refs) => [...new Map(refs.map((r) => [JSON.stringify(r), r])).values()];

export function clone(x) {
  return JSON.parse(JSON.stringify(x ?? null));
}

/**
 * THE PAGE A READ RETURNS — one shape for every tool that hands back rows (a metric query, a pipeline
 * build, a projection, a task read): where it starts, how many it asked for and returned, the total
 * when it is known (the rows ran out within the read), whether there are more and where the next page
 * starts — and, when the rows were not sorted, that their order is no order at all, so a page boundary
 * is not mistaken for a ranking and paging is done over a stable order.
 */
export function pageBlock({ offset = 0, limit, returned, has_more = false, total = null, ordered }) {
  const known = total ?? (has_more ? null : offset + returned);
  return {
    offset, limit, returned, ...(known != null ? { total_rows: known } : {}), has_more,
    ...(has_more ? { next_offset: offset + returned } : {}),
    ...(ordered === false ? { ordered: false, order_note: 'no order_by: the rows come in no particular order — add order_by for a ranking, and for pages that hold the same rows each time' } : {}),
  };
}

/**
 * The mandatory APPROXIMATE warning attached to any result computed over a random
 * sample: what it is safe for, what it is NOT, and how to get the exact answer. So the
 * caller is never misled into acting on a sampled number, and always has the choice.
 */
export function samplingNote(percent) {
  return {
    approximate: true,
    sample_percent: percent,
    why: `These rows were computed over a ~${percent}% RANDOM sample of the source for a FAST directional read — NOT the full population.`,
    safe_for: 'getting the shape/direction: top categories, rough proportions, whether a segment is non-trivial, sanity-checking a pipeline before a full run.',
    not_reliable_for: 'exact totals/counts, rates near 0 or 1, small segments, distinct counts, or ranking values that are close — sampling error can change or flip these.',
    get_exact: 'For a number you will act on, re-run WITHOUT sampling (omit the sample stage, or pass sample:false) to compute over ALL the data.',
  };
}
