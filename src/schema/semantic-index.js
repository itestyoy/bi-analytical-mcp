// SEMANTIC_INDEX'S INPUT — one closed branch per view, each with exactly the fields it takes and the
// catalog's vocabulary as enums, so two views at once or a name a source does not carry cannot be written.

import { RESEARCH_DOMAINS } from '../research-guides.js';
import { strEnum } from '../schema-kit.js';

/**
 * THE exploration tool, as ONE BRANCH PER VIEW. Each view lists exactly the fields it takes and the
 * vocabulary it accepts, so "two views at once", "limit does not apply here" and "this source has
 * no such property" are not refusals the engine has to write — they are inputs the schema cannot
 * express. Names are enumerated PER SOURCE and a name is ALWAYS asked for within its source: there
 * is no source-less spelling of an event or a column at all, in any catalog, so no name ever has to
 * be traced back to an owner and no view ever has to guess which source was meant.
 */
export function semanticIndexSchema(catalog) {
  const models = catalog.modelKeys();
  const unavailable = Object.keys(catalog.unavailableModels?.() || {});
  const paging = {
    limit: { type: 'integer', minimum: 1, maximum: 1000, description: 'How many indexed values to return (default 10).' },
    offset: { type: 'integer', minimum: 0, description: 'Skip this many values first — page through a long tail.' },
    order_by: { enum: ['freq', 'value'], description: 'Order the values by frequency (default) or alphabetically.' },
    direction: { enum: ['asc', 'desc'], description: 'Sort direction (default desc for freq, asc for value).' },
    recent: { type: 'integer', minimum: 1, maximum: 100, description: 'How many recent indexing runs to include.' },
    include_coverage: { type: 'boolean', description: 'Return the FULL per-event and per-app coverage instead of the summary.' },
  };
  const view = (title, description, required, properties) => ({ title, type: 'object', additionalProperties: false, description, ...(required.length ? { required } : {}), properties });
  const eventsOf = (k) => (catalog.isFact(k) ? catalog.eventNames(k) : []);
  const bundleSources = models.filter((k) => catalog.getModel(k).bundle_column);

  // Each vocabulary is written out where it is accepted, not hoisted into a $ref: a wrong name
  // then fails INSIDE the branch that offered it, so the refusal can say which mode it was closest
  // to and list that mode's names. Behind a $ref the failure belongs to the shared definition
  // instead, and the reader is handed a vocabulary without being told whose it is.
  const eventRef = (f) => strEnum(eventsOf(f), `An event '${f}' declares.`);
  const propRef = (k) => strEnum(catalog.propertyEnumFor(k), `A payload property or attribute of '${k}'.`);

  // The single-view fields, written once: the branch that requires one and the flat root map below
  // reference the SAME schema, so the two cannot describe the same field differently.
  const field = {
    model: { enum: [...models, ...unavailable], description: 'The model to describe.' },
    search: { type: 'string', description: 'The word or phrase to look for.' },
    fuzzy: { type: 'boolean', description: 'Enable typo/approximate matching (default true); false = exact substring only.' },
    status: { enum: [true], description: 'Ask for the operational state.' },
    run: { type: 'integer', minimum: 1, description: 'Run id, from the status view.' },
    bundle: { type: 'string', description: 'The app/bundle id; the overview lists them.' },
    recipe: { type: 'string', description: 'Recipe id, from the overview.' },
    guide: { anyOf: [{ type: 'boolean' }, { type: 'string' }], description: `true for the whole guide, a task family name, "python" for the authoring guide of this warehouse\'s python runtime (its constraints + a worked example per operation), or "research" for how to run an investigation (sequence, checks, report) — with ${RESEARCH_DOMAINS.map((d) => `"${d}"`).join(', ')} for what matters in each domain. "python", "research" and "research/<domain>" are reserved: not recipe families.` },
  };

  const branches = [
    view('overview (an empty request)', 'OVERVIEW (an empty request): models, each source\'s events, group-by paths, value-index freshness, recipe ids.', [], {}),
    view('{ model }', 'VIEW { model }: one model — its entities, time axis, dimension attributes with real sample values, physical columns, declared relationships and aggregatable amounts.', ['model'], {
      model: field.model,
    }),
    // one branch per source: an event name belongs to the source that declares it, so a pairing
    // that source does not have cannot be written down.
    ...catalog.facts.map((f) => view('{ source, event }', `VIEW { source: '${f}', event }: the properties POPULATED on that event of '${f}'.`, ['source', 'event'], {
      source: { enum: [f], description: `The events source '${f}'.` },
      event: eventRef(f),
    })),
    // A column is ALWAYS asked for within its source — one branch per model, no source-less form.
    ...models.map((k) => view('{ source, property }', `VIEW { source: '${k}', property }: one column of '${k}' — its meaning, real value distribution (pageable), NULL coverage and indexing freshness.`, ['source', 'property'], {
      source: { enum: [k], description: `The source '${k}'.` },
      property: propRef(k),
      ...paging,
    })),
    view('{ search }', 'VIEW { search }: find events, properties, attributes, indexed VALUES and recipes by word — typo- and paraphrase-tolerant.', ['search'], {
      search: field.search,
      fuzzy: field.fuzzy,
      limit: paging.limit,
    }),
    view('{ status }', 'VIEW { status }: operational state — value-index sync runs (freshness, errors, slowest properties) and background query jobs.', ['status'], {
      status: field.status,
      recent: paging.recent,
    }),
    view('{ run }', 'VIEW { run }: one sync run by id — its per-property breakdown, slowest first.', ['run'], {
      run: field.run,
      recent: paging.recent,
    }),
    ...(bundleSources.length ? [view('{ bundle }', 'VIEW { bundle }: for ONE app — which properties carry data for it vs are EMPTY.', ['bundle'], {
      bundle: field.bundle,
      source: { enum: bundleSources, description: 'Which source to read the per-app coverage of (needed when several declare an app column).' },
    })] : []),
    view('{ recipe }', 'VIEW { recipe }: ONE ready-made recipe by id — its payload, example queries and the reusable hack.', ['recipe'], {
      recipe: field.recipe,
    }),
    view('{ guide }', 'VIEW { guide }: HOW to approach a question — the analyst workflow and IF/DO routing; pass a task family to narrow it.', ['guide'], {
      guide: field.guide,
    }),
  ];
  return {
    // Every tool's input is an OBJECT; the MCP handshake validates that on the root schema,
    // so the branch union narrows the shape but never replaces it.
    type: 'object',
    description: 'THE data-exploration entry point — call it FIRST and whenever unsure what a field means. One progressive index over meaning + real values + completeness + freshness. Pass an empty request ({ request: {} }) for the overview, then exactly ONE view: { model } | { source, event } | { source, property } | { search } | { status } | { run } | { bundle } | { recipe } | { guide }. Each view below lists what it takes; a source and a name are separate fields, never glued into one string.',
    // One closed form per view (an `anyOf` — src/schema-kit.js says why), each with its own required
    // set, so exactly one matches. A NAME is never offered without its owner: the { source, event }
    // and { source, property } forms enumerate one source's names each.
    anyOf: branches,
  };
}
