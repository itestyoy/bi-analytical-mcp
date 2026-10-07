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
    note: { type: 'string', minLength: 1, description: 'ONE ATOMIC finding, in plain words (e.g. "\'ad format\' = the event_data property ad_type_of_event_data, populated only on ad_started/ad_finished; values rewarded/interstitial/banner"). Keep it to a single fact — when studying a topic, make several small notes instead of one long one (atomic notes link and retrieve far better; an over-long note matches poorly and may fail to index).' },
    question: { type: 'string', description: 'The ORIGINAL business question / analytical goal this finding answers — why you looked it up, in the stakeholder\'s terms (e.g. "which ad format drives the most rewarded-video revenue?"). Embedded together with the note, so a future similarly-phrased business question retrieves this insight by meaning. Include it whenever the finding answers a real question.' },
    targets: { type: 'array', items: memoryTargetSchema(catalog), description: 'The catalog entities this finding is ABOUT (an ARRAY — note the plural), so it surfaces on their semantic_index views. Each is { source, name } — a property, user attribute or event of that source (e.g. { source: "events", name: "ad_type_of_event_data" }) — or { source } alone for the model itself. A name is never written on its own: the source says which entity it is. A phrase the catalog has no entity for is written { term: "..." } and stays searchable as itself.' },
    aliases: { type: 'array', items: { type: 'string' }, description: 'The word(s)/phrasing for this finding — give them IN BOTH the user\'s language AND English (e.g. ["ad format", "формат рекламы", "тип рекламы"]). Bilingual aliases make retrieval work cross-language: the lexical/fuzzy match needs the literal words (it cannot bridge scripts on its own), and the aliases are also embedded with the note so a query in either language matches by meaning. Add the user\'s exact wording + synonyms in each language.' },
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
      branch('record', finding, ['note'],
        'Save a finding. Required: note (one atomic fact). Optional: question (the business question it answers), targets (PLURAL array of entities it is about), aliases (the words the user used), links (sources).'),
      // what one study turned up is several atomic notes: saved in one call, all or none
      branch('record', {
        notes: { type: 'array', minItems: 2, maxItems: 10, description: 'Several findings at once — what one study turned up, each its own atomic note. All are checked before any is saved.', items: { type: 'object', additionalProperties: false, required: ['note'], properties: finding } },
      }, ['notes'], 'Save several findings at once (2–10): each item is what a single record takes.'),
      branch('forget', { id: F.id }, ['id'],
        'Delete one note. Required: id (from record / list / search).'),
    ],
  };
}
