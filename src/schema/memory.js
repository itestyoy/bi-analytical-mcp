// THE MEMORY TOOL'S INPUT — durable analyst findings, each linked to what it is about in the catalog.

import { form, strEnum } from '../schema-kit.js';

// ── Analyst memory (durable findings linked to catalog entities) ───────────────
// What WRITES the memory: `record` saves a finding (+ the entities it is about, the user's phrasings,
// and any source links), `forget` removes one. Reading it is semantic_index's — { search }, { notes },
// and the views of the entities a note is about: a read is never asked for before a removal.
/**
 * What a finding can be ABOUT — an entity of a source, addressed as semantic_index's views address it,
 * or a phrase the user used. Closed forms, told apart by their keys: { source, property } a column or
 * payload property of that source, { source, event } an event of an events source, { source } the
 * model itself, { term } a phrase. A NAME is never written without its source, and a property and an
 * event are never one field to be told apart by looking the name up: the key says which it is.
 */
export function memoryTargetSchema(catalog, description) {
  return {
    ...(description ? { description } : {}),
    anyOf: [
      // one form per source: the model itself, or one of ITS columns / payload properties
      ...catalog.modelKeys().map((source) => form({
        title: `{ source: "${source}", property? }`,
        required: ['source'],
        properties: {
          source: { const: source, description: 'The source the entity belongs to.' },
          property: strEnum(catalog.propertyEnumFor(source), `A column or payload property of ${source}, as semantic_index({ request: { source, property } }) names it. Omit to link the model itself.`),
        },
      })),
      // one form per events source: one of ITS events
      ...catalog.facts.map((source) => form({
        title: `{ source: "${source}", event }`,
        required: ['source', 'event'],
        properties: {
          source: { const: source, description: 'The events source the event belongs to.' },
          event: strEnum(catalog.eventNames(source), `An event of ${source}.`),
        },
      })),
      form({
        title: '{ term }',
        required: ['term'],
        properties: { term: { type: 'string', minLength: 1, description: 'A phrase the user actually used, kept searchable as itself — for what the catalog has no entity for.' } },
      }),
    ],
  };
}

export function memorySchema(catalog) {
  // Per-action field definitions (shared between the client-facing union `properties` and
  // the strict per-action branches, so the two never drift).
  const F = {
    note: { type: 'string', minLength: 1, description: 'One finding, in plain words (e.g. "\'ad format\' = ad_type_of_event_data, only on ad_started / ad_finished"). One fact per note: small notes link and match better.' },
    question: { type: 'string', description: 'The business question this finding answers, in the stakeholder\'s words; it is embedded with the note, so a later question with the same meaning finds it.' },
    about: { type: 'array', items: memoryTargetSchema(catalog), description: 'The catalog entities this finding is about, so it surfaces on their semantic_index views: { source, property } — a column or payload property of that source — { source, event } — an event of an events source — { source } for the model itself, or { term } for a phrase the catalog has no entity for. Each is written as semantic_index({ request: { notes: true, about } }) takes it.' },
    aliases: { type: 'array', uniqueItems: true, items: { type: 'string', pattern: '\\S' }, description: 'The user\'s words for it, in their language and in English (e.g. ["ad format", "формат рекламы"]): search matches literal words and cannot cross scripts by itself.' },
    links: { type: 'array', description: 'Associated sources for the finding — a Confluence page, a dashboard, a ticket: { url, title? }.', items: { type: 'object', additionalProperties: false, required: ['url'], properties: { url: { type: 'string', description: 'Link URL.' }, title: { type: 'string', description: 'Human-readable title.' } } } },
    id: { type: 'string', description: 'Id of the note to delete (as record returned it, or semantic_index({ request: { notes: true } }) lists it).' },
  };
  const finding = { note: F.note, question: F.question, about: F.about, aliases: F.aliases, links: F.links };

  // One strict, self-contained form per action: ONLY its fields, closed, its required set — the AI
  // sees exactly what to pass for the chosen action, and a field of another action is refused.
  const branch = (act, props, required, desc) => form({ title: act, description: desc, tag: ['action', act], required, properties: props });

  return {
    type: 'object',
    description: 'Write the analyst memory: record a finding, or forget one by id. Notes are read with semantic_index — { search }, { notes: true }, and on the views of the entities they are about.',
    anyOf: [
      // one finding is a list of one; what one study turned up is several atomic notes, saved all or none
      branch('record', {
        notes: { type: 'array', minItems: 1, maxItems: 10, description: 'The findings — one, or what one study turned up (up to 10), each its own atomic note. All are checked before any is saved.', items: { type: 'object', additionalProperties: false, required: ['note'], properties: finding } },
      }, ['notes'], 'Save findings — one, or several from one study, each its own note.'),
      branch('forget', { id: F.id }, ['id'],
        'Delete one note by id.'),
    ],
  };
}
