// THE MEMORY TOOL'S INPUT — durable analyst findings, each linked to what it is about in the catalog.

import { form, strEnum } from '../schema-kit.js';

// ── Analyst memory (durable findings linked to catalog entities) ───────────────
// What WRITES the memory: `record` saves a finding (+ the entities it is about, the user's phrasings,
// and any source links), `forget` removes one. Reading it is semantic_index's — { search }, { notes },
// and the views of the entities a note is about: a read is never asked for before a removal.
/**
 * What a finding can be ABOUT. Two things, each written as itself: an entity OF A SOURCE — always
 * the pair, never a name on its own — or a phrase the user used. A NAME and a PHRASE are not the
 * same thing, so they do not share a spelling; and since the source is its own field, the glued
 * '<source>.<name>' form has no spelling either.
 */
export function memoryTargetSchema(catalog, description) {
  return {
    ...(description ? { description } : {}),
    anyOf: [
      // one closed form per source: `name` is one of ITS properties, attributes or events
      ...catalog.modelKeys().map((source) => {
        const m = catalog.models[source];
        const names = [...new Set([...Object.keys(m.dimensions || {}), ...(catalog.isFact(source) ? [...Object.keys(m.properties || {}), ...catalog.eventNames(source)] : [])])];
        return {
          title: `{ source: "${source}", name? }`,
          type: 'object', additionalProperties: false, required: ['source'],
          properties: {
            source: { const: source, description: 'The source the entity belongs to.' },
            ...(names.length ? { name: strEnum(names, `A property, attribute or event of ${source}. Omit to link the model itself.`) } : {}),
          },
        };
      }),
      {
        title: '{ term }',
        type: 'object', additionalProperties: false, required: ['term'],
        properties: { term: { type: 'string', minLength: 1, description: 'A phrase the user actually used, kept searchable as itself — for what the catalog has no entity for.' } },
      },
    ],
  };
}

export function memorySchema(catalog) {
  // Per-action field definitions (shared between the client-facing union `properties` and
  // the strict per-action branches, so the two never drift).
  const F = {
    note: { type: 'string', minLength: 1, description: 'One finding, in plain words (e.g. "\'ad format\' = ad_type_of_event_data, only on ad_started / ad_finished"). One fact per note: small notes link and match better.' },
    question: { type: 'string', description: 'The business question this finding answers, in the stakeholder\'s words; it is embedded with the note, so a later question with the same meaning finds it.' },
    targets: { type: 'array', items: memoryTargetSchema(catalog), description: 'The catalog entities this finding is about, so it surfaces on their semantic_index views: { source, name } — a property, attribute or event of that source — { source } for a model, or { term } for a phrase the catalog has no entity for.' },
    aliases: { type: 'array', items: { type: 'string' }, description: 'The user\'s words for it, in their language and in English (e.g. ["ad format", "формат рекламы"]): search matches literal words and cannot cross scripts by itself.' },
    links: { type: 'array', description: 'Associated sources for the finding — a Confluence page, a dashboard, a ticket. A URL string, or { url, title }.', items: { anyOf: [{ type: 'string', description: 'A URL.' }, { type: 'object', additionalProperties: false, required: ['url'], properties: { url: { type: 'string', description: 'Link URL.' }, title: { type: 'string', description: 'Human-readable title.' } } }] } },
    id: { type: 'string', description: 'Id of the note to delete (as record returned it, or semantic_index({ notes: true }) lists it).' },
  };
  const finding = { note: F.note, question: F.question, targets: F.targets, aliases: F.aliases, links: F.links };

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
