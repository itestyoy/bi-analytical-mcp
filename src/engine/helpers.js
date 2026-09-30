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

/**
 * Presentation shape for a stored memory note: decode the canonical "<kind>:<key>" targets
 * back into their public { kind, source, name } form, expose the note/aliases/links, and stamp
 * the time.
 */
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
 * The attribute a compiled dimension was DECLARED as. `_attribute` records it at compile time; a
 * context persisted before that falls back to the longest task name the identifier starts with —
 * longest, because one task name may be a prefix of another ('ret' and 'ret_v2') and the shorter
 * one would leave part of the task name inside the attribute.
 */
export function declaredAttribute(dim, tasks = []) {
  if (dim._attribute) return dim._attribute;
  const t = [...tasks].filter((tk) => dim.name.startsWith(`${tk}_`)).sort((a, b) => b.length - a.length)[0];
  return t ? dim.name.slice(t.length + 1) : dim.name;
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
