// THE MEMORY TOOL'S INPUT — durable analyst findings, each linked to what it is about in the catalog.

import { form } from '../schema-kit.js';
import { refSchema } from './refs.js';

// ── Analyst memory (durable findings linked to catalog entities) ───────────────
// What WRITES the memory: `record` saves a finding (+ the entities it is about, the user's phrasings,
// and any source links), `forget` removes one. Reading it is semantic_index's — { search }, { notes },
// and the views of the entities a note is about: a read is never asked for before a removal.

/** A finding about what the catalog has no entity for: a phrase the user used. */
const TERM = form({
  title: '{ term }',
  required: ['term'],
  properties: { term: { type: 'string', minLength: 1, description: 'A phrase the user used, for what the catalog has no entity for.' } },
});

/**
 * What a finding can be ABOUT — a thing of the catalog, named by THE ref (`$defs.ref`, src/schema/refs.js)
 * as semantic_index's views name it — { source } the model, { source, event } an event of an events
 * source, { source, column } a column of a model, { source, property } an event property — or { term }, a
 * phrase the user used. Which refs a note may be about is the place's (REF_PLACES.about). A tool that
 * takes it carries the ref among its definitions (aboutDefs), built for its places, so its schema holds
 * those forms alone; the engine checks the place again when the note is read (src/engine/memory.js).
 */
export function aboutSchema(description) {
  return { ...(description ? { description } : {}), anyOf: [{ $ref: '#/$defs/ref' }, TERM] };
}

/** The definitions a tool that takes what a note is about carries: the one ref, built for the tool's
 *  `places` (REF_PLACES names: src/schema.js TOOL_PLACES). */
export function aboutDefs(catalog, { project = null, places = null } = {}) {
  return { ref: refSchema(catalog, { project, places }) };
}

export function memorySchema(catalog, { project = null, places = null } = {}) {
  // Per-action field definitions (shared between the client-facing union `properties` and
  // the strict per-action branches, so the two never drift).
  const F = {
    note: { type: 'string', minLength: 1, description: 'One finding in plain words; one fact per note.' },
    question: { type: 'string', description: 'The business question it answers, in the stakeholder\'s words.' },
    about: { type: 'array', items: aboutSchema(), description: 'What it is about, as semantic_index views name it; it surfaces on those views.' },
    aliases: { type: 'array', uniqueItems: true, items: { type: 'string', pattern: '\\S' }, description: 'The user\'s words for it, in their language and in English: search matches literal words.' },
    links: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['url'], properties: { url: { type: 'string' }, title: { type: 'string' } } } },
    id: { type: 'string', description: 'As record returned it, or { notes: true } lists it.' },
  };
  const finding = { note: F.note, question: F.question, about: F.about, aliases: F.aliases, links: F.links };

  // One strict, self-contained form per action: ONLY its fields, closed, its required set — the AI
  // sees exactly what to pass for the chosen action, and a field of another action is refused.
  const branch = (act, props, required, desc) => form({ title: act, description: desc, tag: ['action', act], required, properties: props });

  return {
    type: 'object',
    description: 'Record findings, or forget one by id.',
    $defs: aboutDefs(catalog, { project, places }),
    anyOf: [
      // one finding is a list of one; what one study turned up is several atomic notes, saved all or none
      branch('record', {
        notes: { type: 'array', minItems: 1, maxItems: 10, description: 'Each its own note; all are checked before any is saved.', items: { type: 'object', additionalProperties: false, required: ['note'], properties: finding } },
      }, ['notes'], 'Save findings — one, or several from one study, each its own note.'),
      branch('forget', { id: F.id }, ['id'],
        'Delete one note by id.'),
    ],
  };
}
