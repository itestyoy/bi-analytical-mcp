// THE MEMORY TOOL'S INPUT — durable analyst findings, each linked to what it is about in the catalog.

import { form, strEnum } from '../schema-kit.js';

// ── Analyst memory (durable findings linked to catalog entities) ───────────────
// A single action-driven tool. `record` saves a finding (+ the entities it is about,
// the user's phrasings, and any source links); list/search/forget manage them. Strict
// per-action fields so a param that does not belong to the action is rejected.
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
    target: memoryTargetSchema(catalog, 'Return notes linked to this ONE entity (singular — the same forms as record\'s `targets`).'),
    query: { type: 'string', description: 'A word/phrase to match against note text, the business question, aliases and linked targets. Token-aware + typo-tolerant fuzzy by default; when embeddings are enabled it ALSO matches by MEANING (a same-sense note with no shared words still surfaces).' },
    fuzzy: { type: 'boolean', description: 'Enable typo/approximate lexical matching (default true). false = exact word/substring only (semantic matching, if enabled, still runs).' },
    id: { type: 'string', description: 'Id of the note to delete (as returned by record / list / search).' },
    limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Max notes to return (default 50 for list, 20 for search).' },
  };

  // One strict, self-contained form per action: ONLY its fields, closed, its required set — the AI
  // sees exactly what to pass for the chosen action, and a field of another action is refused.
  const branch = (act, props, required, desc) => form({ title: act, description: desc, tag: ['action', act], required, properties: props });

  return {
    type: 'object',
    description: 'Durable analyst memory: save what you found out — a vague request tracked down to a real field, a gotcha, a useful source — linked to the catalog entities it concerns, so it comes back through semantic_index next time. Pick exactly one action; each action has its own fixed field set (a field that does not belong to the action is rejected): record = save a finding (note [required] + question + targets[] + aliases[] + links[]); list = read notes (nothing else = all; { target } = notes about one entity); search = find notes by a word/phrase ({ query } [required] + fuzzy + limit); forget = delete one note ({ id } [required]). Record one atomic finding per note — when studying a topic/document, make several small single-fact notes, not one big dump. Note: record takes the plural `targets` (array); list takes the singular `target`.',
    anyOf: [
      branch('record', { note: F.note, question: F.question, targets: F.targets, aliases: F.aliases, links: F.links }, ['note'],
        'Save a finding. Required: note (one atomic fact). Optional: question (the business question it answers), targets (PLURAL array of entities it is about), aliases (the words the user used), links (sources).'),
      branch('list', { target: F.target, limit: F.limit }, [],
        'Read stored notes. No other field → ALL notes. Pass target (SINGULAR) to get only notes linked to that one entity.'),
      branch('search', { query: F.query, fuzzy: F.fuzzy, limit: F.limit }, ['query'],
        'Find notes by meaning/word. Required: query. Optional: fuzzy (default true), limit. Returns notes + a `semantic` flag (true only when vector search actually ran).'),
      branch('forget', { id: F.id }, ['id'],
        'Delete one note. Required: id (from record / list / search).'),
    ],
  };
}
