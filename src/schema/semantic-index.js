// SEMANTIC_INDEX'S INPUT — one closed branch per view, each with exactly the fields it takes and the
// catalog's vocabulary as enums, so two views at once or a name a source does not carry cannot be written.

import { RESEARCH_DOMAINS } from '../research-guides.js';
import { refForms, REF_PLACES } from './refs.js';
import { aboutSchema, aboutDefs } from './memory.js';
import { timeRange } from '../schema-kit.js';

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
    limit: { type: 'integer', minimum: 1, maximum: 1000, description: 'Default 10.' },
    offset: { type: 'integer', minimum: 0 },
    order_by: {
      type: 'array', minItems: 1, maxItems: 2,
      description: 'Default: by frequency.',
      items: {
        type: 'object', additionalProperties: false, required: ['key'],
        properties: {
          key: { enum: ['freq', 'value'] },
          direction: { enum: ['asc', 'desc'] },
        },
      },
    },
    recent: { type: 'integer', minimum: 1, maximum: 100, description: 'Latest indexing runs to include (default 3).' },
  };
  // the per-event and per-app split of an event property (an events source alone has either)
  const include = { include: { type: 'array', uniqueItems: true, items: { enum: ['coverage'] }, description: 'The full per-event and per-app coverage.' } };
  const view = (title, description, required, properties) => ({ title, type: 'object', additionalProperties: false, ...(description ? { description } : {}), ...(required.length ? { required } : {}), properties });
  // per-app coverage is measured on the events sources that name the app (src/engine/semantic-index.js _indexBundle)
  const bundleSources = catalog.facts.filter((f) => catalog.bundleColumn(f));

  // A VIEW OF A THING OF THE CATALOG — the ref's own forms, one per source with that source's names
  // (refForms), each with what its view reads beside the ref's fields. The vocabulary stays inside the
  // form that offers it: a wrong name fails within the source it was asked of, so the refusal names
  // that source's form and lists its names. A view reads a column where it is: `via` only if the place
  // reads a relationship.
  const refs = refForms(catalog, { project, via: !!REF_PLACES.index_view.via, timeColumns: !!REF_PLACES.index_view.timeColumns });
  const refView = (kind, title, description, extra = {}) => refs[kind].map((f) => ({ ...f, title, description: description(f.properties.source), properties: { ...f.properties, ...extra } }));
  const refViews = {
    source: refView('source', '{ source }', () => 'One source: its columns, relationships, amounts.'),
    // an event name belongs to the source that declares it, so a pairing that source does not have cannot be written down
    source_event: refView('source_event', '{ source, event }', () => 'The properties that event carries.'),
    source_column: refView('source_column', '{ source, column }', () => 'One column: its meaning, values, NULL coverage.', paging),
    source_property: refView('source_property', '{ source, property }', () => 'One event property: its meaning, values, coverage per event and app.', { ...paging, ...include }),
  };

  // The single-view fields, written once.
  const field = {
    search: { type: 'string' },
    fuzzy: { type: 'boolean', description: 'Default true; false: exact substring.' },
    status: { const: true },
    run: { type: 'integer', minimum: 1 },
    bundle: { type: 'string' },
    recipe: { type: 'string' },
    guide: { anyOf: [{ type: 'boolean' }, { type: 'string' }], description: `true, a task family, "python", or "research" (${RESEARCH_DOMAINS.map((d) => `"${d}"`).join(', ')}).` },
  };

  // the views that drill into one thing — what a { views } request may hold several of: first the
  // views of the refs the place takes (REF_PLACES.index_view), in its order
  const drill = [
    ...REF_PLACES.index_view.takes.flatMap((kind) => refViews[kind]),
    view('{ search }', 'Events, properties, columns, values and recipes by word.', ['search'], {
      search: field.search,
      fuzzy: field.fuzzy,
      limit: { type: 'integer', minimum: 1, maximum: 1000, description: 'Matches of each kind: values (default 20), saved notes (default 5, at most 20).' },
    }),
    view('{ notes }', 'The saved findings, newest first.', ['notes'], {
      notes: { const: true },
      about: aboutSchema('Only the notes about this entity.'),
      limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Default 50.' },
      offset: { type: 'integer', minimum: 0 },
    }),
    ...(bundleSources.length ? [view('{ bundle }', 'Which properties one app fills.', ['bundle'], {
      bundle: field.bundle,
      source: { enum: bundleSources },
    })] : []),
    view('{ recipe }', 'One recipe in full.', ['recipe'], {
      recipe: field.recipe,
    }),
  ];
  const branches = [
    view('overview (an empty request)', null, [], {}),
    ...drill,
    // several drill-ins at once (a few events, their properties): one call where they would go one by one
    view('{ views }', '2–5 drill-in views at once.', ['views'], {
      views: { type: 'array', minItems: 2, maxItems: 5, items: { anyOf: drill } },
    }),
    view('{ status }', 'Index sync runs and background tasks.', ['status'], {
      status: field.status,
      recent: { type: 'integer', minimum: 1, maximum: 100, description: 'Default 10.' },
    }),
    view('{ run }', 'One sync run by id.', ['run'], {
      run: field.run,
    }),
    view('{ guide }', 'How to approach a question.', ['guide'], {
      guide: field.guide,
    }),
    // what has been asked of this server (src/task-index.js): a record of the questions, never a way to their data
    view('{ tasks }', 'What has been asked of this server: the past tasks most like a phrase (what each computed, when and how), or the themes of a period — never their data.', ['tasks'], {
      tasks: {
        anyOf: [
          {
            title: 'tasks like a phrase', type: 'object', additionalProperties: false, required: ['search'],
            properties: {
              search: { type: 'string', minLength: 1, description: 'What to find tasks like, in any language.' },
              time_range: timeRange('Only the tasks started within it.'),
              limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Default 10.' },
            },
          },
          {
            title: 'the themes of a period', type: 'object', additionalProperties: false, required: ['themes'],
            properties: {
              themes: { const: true },
              time_range: timeRange('The period; omitted, every task kept.'),
              about: { type: 'string', minLength: 1, description: 'Only the tasks like this phrase (e.g. "ad revenue"), clustered.' },
              min_similarity: { type: 'number', minimum: 0, maximum: 1, description: 'How like `about` a task must be (default 0.3 with the deployment\'s embedder, 0.1 without).' },
              clusters: { type: 'integer', minimum: 2, maximum: 20, description: 'Omitted, the number that separates them best.' },
            },
          },
        ],
      },
    }),
  ];
  return {
    // Every tool's input is an OBJECT; the MCP handshake validates that on the root schema,
    // so the branch union narrows the shape but never replaces it.
    type: 'object',
    description: 'An empty request for the overview, one view, or { views } for several.',
    // what a note is about is the one ref (`$defs.ref`), as memory records it — built for this tool's
    // places (`places`: its views and the notes' about)
    $defs: aboutDefs(catalog, { project, places }),
    // One closed form per view (an `anyOf` — src/schema-kit.js says why), each with its own required
    // set, so exactly one matches. A NAME is never offered without its owner: the { source, event },
    // { source, column } and { source, property } forms enumerate one source's names each.
    anyOf: branches,
  };
}
