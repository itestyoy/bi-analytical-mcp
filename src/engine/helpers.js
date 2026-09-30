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
