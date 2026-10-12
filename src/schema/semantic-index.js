// SEMANTIC_INDEX'S INPUT — one closed branch per view, each with exactly the fields it takes and the
// catalog's vocabulary as enums, so two views at once or a name a source does not carry cannot be written.

import { RESEARCH_DOMAINS } from '../research-guides.js';
import { refForms, REF_PLACES } from './refs.js';
import { aboutSchema, aboutDefs } from './memory.js';

/**
 * THE exploration tool, as ONE BRANCH PER VIEW. Each view lists exactly the fields it takes and the
 * vocabulary it accepts, so "two views at once", "limit does not apply here" and "this source has
 * no such property" are not refusals the engine has to write — they are inputs the schema cannot
 * express. A view of a thing of the catalog IS the ref that names it (src/schema/refs.js: { source },
 * { source, event }, { source, column }, { source, property } — the kinds REF_PLACES.index_view takes),
 * each form the ref's own with the view's paging beside it: one closed form per source, so a name is
 * ALWAYS asked for within its source — no source-less spelling of an event or a column exists in any
 * catalog — and a model's column and an event's payload property are told apart by their key.
 */
export function semanticIndexSchema(catalog, { project = null, places = null } = {}) {
  // a column's values, paged — and on an events source, its coverage per event and per app
  const paging = {
    limit: { type: 'integer', minimum: 1, maximum: 1000, description: 'How many indexed values to return (default 10).' },
    offset: { type: 'integer', minimum: 0, description: 'Skip this many values first — page through a long tail.' },
    order_by: {
      type: 'array', minItems: 1, maxItems: 2,
      description: 'How the values are ordered — by frequency (the default, most frequent first) or by the value itself (alphabetically); a second item orders the values the first one ties.',
      items: {
        type: 'object', additionalProperties: false, required: ['key'],
        properties: {
          key: { enum: ['freq', 'value'], description: 'freq — how often the value occurs; value — the value itself.' },
          direction: { enum: ['asc', 'desc'], description: 'Sort direction (default desc for freq, asc for value).' },
        },
      },
    },
    recent: { type: 'integer', minimum: 1, maximum: 100, description: 'How many of this column\'s latest indexing runs to include (default 3).' },
  };
  // the per-event and per-app split of an event property (an events source alone has either)
  const include = { include: { type: 'array', uniqueItems: true, items: { enum: ['coverage'] }, description: '"coverage" — the full per-event and per-app coverage instead of the summary.' } };
  const view = (title, description, required, properties) => ({ title, type: 'object', additionalProperties: false, description, ...(required.length ? { required } : {}), properties });
  // per-app coverage is measured on the events sources that name the app (src/engine/semantic-index.js _indexBundle)
  const bundleSources = catalog.facts.filter((f) => catalog.bundleColumn(f));

  // A VIEW OF A THING OF THE CATALOG — the ref's own forms, one per source with that source's names
  // (refForms), each with what its view reads beside the ref's fields. The vocabulary stays inside the
  // form that offers it: a wrong name fails within the source it was asked of, so the refusal names
  // that source's form and lists its names. A view reads a column where it is: `via` only if the place
  // reads a relationship.
  const refs = refForms(catalog, { project, via: !!REF_PLACES.index_view.via });
  const refView = (kind, title, description, extra = {}) => refs[kind].map((f) => ({ ...f, title, description: description(f.properties.source), properties: { ...f.properties, ...extra } }));
  const sourceOf = (s) => s.const ?? null;
  const refViews = {
    source: refView('source', '{ source }', () => 'One source — its entities, time axis, dimension attributes with real sample values, physical columns, declared relationships and aggregatable amounts.'),
    // an event name belongs to the source that declares it, so a pairing that source does not have cannot be written down
    source_event: refView('source_event', '{ source, event }', (s) => `The properties populated on that event of '${sourceOf(s)}'.`),
    source_column: refView('source_column', '{ source, column }', (s) => `One column of '${sourceOf(s)}' — its meaning, real value distribution (pageable), NULL coverage and indexing freshness.`, paging),
    source_property: refView('source_property', '{ source, property }', (s) => `One event property of '${sourceOf(s)}' — its meaning, real value distribution (pageable), NULL coverage per event and per app, and indexing freshness.`, { ...paging, ...include }),
  };

  // The single-view fields, written once.
  const field = {
    search: { type: 'string', description: 'The word or phrase to look for.' },
    fuzzy: { type: 'boolean', description: 'Enable typo/approximate matching (default true); false = exact substring only.' },
    status: { const: true, description: 'Ask for the operational state.' },
    run: { type: 'integer', minimum: 1, description: 'Run id, from the status view.' },
    bundle: { type: 'string', description: 'The app/bundle id; the overview lists them.' },
    recipe: { type: 'string', description: 'Recipe id, from the overview.' },
    guide: { anyOf: [{ type: 'boolean' }, { type: 'string' }], description: `true for the whole guide, a task family name, "python" for the authoring guide of this warehouse\'s python runtime (its constraints + a worked example per operation), or "research" for how to run an investigation (sequence, checks, report) — with ${RESEARCH_DOMAINS.map((d) => `"${d}"`).join(', ')} for what matters in each domain. "python", "research" and "research/<domain>" are reserved: not recipe families.` },
  };

  // the views that drill into one thing — what a { views } request may hold several of: first the
  // views of the refs the place takes (REF_PLACES.index_view), in its order
  const drill = [
    ...REF_PLACES.index_view.takes.flatMap((kind) => refViews[kind]),
    view('{ search }', 'Find events, event properties, columns, indexed values and recipes by word — typo- and paraphrase-tolerant.', ['search'], {
      search: field.search,
      fuzzy: field.fuzzy,
      limit: { type: 'integer', minimum: 1, maximum: 1000, description: 'How many indexed values to return at most (default 20) — it bounds value_matches; the event, property, column and recipe matches are each the closest few.' },
    }),
    view('{ notes }', 'The analyst memory — the saved findings, newest first, each with its id (memory forgets one by id): every one, or those `about` one entity. A finding also surfaces on the views of what it is about, and in { search }.', ['notes'], {
      notes: { const: true },
      about: aboutSchema('Only the notes about this one entity — named as memory records it: { source } for the model itself, { source, event }, { source, column }, { source, property }, or { term }.'),
      limit: { type: 'integer', minimum: 1, maximum: 200, description: 'How many notes the page holds (default 50).' },
      offset: { type: 'integer', minimum: 0, description: 'Skip this many of the newest first — next_offset of the previous page.' },
    }),
    ...(bundleSources.length ? [view('{ bundle }', 'For one app — which event properties and columns carry data for it and which are empty.', ['bundle'], {
      bundle: field.bundle,
      source: { enum: bundleSources, description: 'Which source\'s per-app coverage; omitted, every source that saw the app, each in its own block.' },
    })] : []),
    view('{ recipe }', 'One ready-made recipe by id — its payload, example queries and the reusable hack.', ['recipe'], {
      recipe: field.recipe,
    }),
  ];
  const branches = [
    view('overview (an empty request)', 'The overview: models, each source\'s events, group-by paths, value-index freshness, recipe ids.', [], {}),
    ...drill,
    // several drill-ins at once (a few events, their properties): one call where they would go one by one
    view('{ views }', '2–5 of the drill-in views at once, answered in the order asked — e.g. the events a question names and the properties it groups by.', ['views'], {
      views: { type: 'array', minItems: 2, maxItems: 5, items: { anyOf: drill } },
    }),
    view('{ status }', 'Operational state — value-index sync runs (freshness, errors, slowest properties) and background query jobs.', ['status'], {
      status: field.status,
      recent: { type: 'integer', minimum: 1, maximum: 100, description: 'How many of the latest index runs and of the latest tasks to list — it caps both lists (default 10).' },
    }),
    view('{ run }', 'One sync run by id — its per-property breakdown, slowest first.', ['run'], {
      run: field.run,
    }),
    view('{ guide }', 'How to approach a question — the analyst workflow and IF/DO routing; pass a task family to narrow it.', ['guide'], {
      guide: field.guide,
    }),
  ];
  return {
    // Every tool's input is an OBJECT; the MCP handshake validates that on the root schema,
    // so the branch union narrows the shape but never replaces it.
    type: 'object',
    description: 'An empty request for the overview, exactly one view (one of the forms below), or { views: [...] } for several drill-ins at once. A source and a name are separate fields, never glued into one string: a model\'s column is { source, column }, an event\'s payload property { source, property }.',
    // what a note is about is the one ref (`$defs.ref`), as memory records it — built for this tool's
    // places (`places`: its views and the notes' about)
    $defs: aboutDefs(catalog, { project, places }),
    // One closed form per view (an `anyOf` — src/schema-kit.js says why), each with its own required
    // set, so exactly one matches. A NAME is never offered without its owner: the { source, event },
    // { source, column } and { source, property } forms enumerate one source's names each.
    anyOf: branches,
  };
}
