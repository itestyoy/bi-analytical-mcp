// THE RETENTIONEERING FEATURE'S TOOL SCHEMAS — a wrapper over the whole library, typed as far as the
// library itself says. Every analysis and every preprocessing op the library registers, each with its
// own parameters under the library's own names, their types, defaults and first docstring paragraph;
// every path metric with exactly the arguments it takes; the condition grammar; the edge weights,
// aggregations, clustering methods and scalers — all rendered from config/retentioneering-facts.json,
// the sheet scripts/retentioneering-facts.py extracts from the installed library. Nothing here restates
// one from the library's prose. What the CATALOG decides (the events sources, their events, the models
// a segment can come from and their attributes, the relationships that reach them) comes from the
// catalog. Names that exist only once an eventstream is built (the events after grouping, the segment
// columns) are checked at call time against that eventstream.
//
// What a call cannot carry is not offered, each for its stated reason (NOT_OFFERED): a Python callable,
// a DuckDB statement run on the analysis runtime (code, which this server never takes from a call —
// the data is declared in the build instead, in SQL where it lives), and the two ops the eventstream's
// shape rules out.

import { readFileSync } from 'node:fs';
import { assetPath, missingAssetMessage } from '../runtime-assets.js';
import { MAX_WAIT_SECONDS } from '../schema.js';
import { ToolError } from '../validate.js';
import { TASK_ID_PATTERN } from '../jobs.js';
import { getDialect } from '../dialects/index.js';
import { CARD_KINDS } from './view-model.js';
import { anyOfOr, form, pick, stringOtherThan, conditionList, CONSTANT, timeRange } from '../schema-kit.js';
import { OPS } from '../conditions.js';
import { CTX } from '../schema/fields.js';

let factsCache;
/** The facts sheet (read once). */
export function retentioneeringFacts() {
  if (factsCache === undefined) {
    const file = assetPath('retentioneeringFacts');
    if (!file) throw new Error(missingAssetMessage('retentioneeringFacts'));
    factsCache = JSON.parse(readFileSync(file, 'utf8'));
  }
  return factsCache;
}

/** Why a library op or parameter is not offered — the one list; the guide and the schema read it. */
export const NOT_OFFERED = {
  ops: {
    add_start_end_events: 'every analysis adds path_start/path_end itself; adding them again doubles them and shifts every step',
    urls_to_events: 'the eventstream carries event names, not URLs',
  },
  params: {
    func: 'a Python callable, which a call cannot carry',
    sql: 'a DuckDB statement run on the analysis runtime — code, which this server never takes from a call; declare the data in build_retentioneering_model instead (events, groups, segments, where), and keep rows by a condition after the steps with filter_events\' where (this tool writes the SQL)',
  },
};

/** The analyses the library offers, in the sheet's order. Read when asked, never at import: a server
 *  with the feature off never opens the sheet. */
export const analysisKinds = () => Object.keys(retentioneeringFacts().analyses);
/** The preprocessing ops offered: every op the library registers, but the ones NOT_OFFERED. */
export const offeredOps = () => Object.keys(retentioneeringFacts().ops).filter((op) => !NOT_OFFERED.ops[op]);

export const NAME = '^[a-z][a-z0-9_]*$';
/** A column of an eventstream: an identifier the warehouse stores (a segment, a path column, a custom one). */
const NAME_OR_COLUMN = '^[A-Za-z_][A-Za-z0-9_]*$';
/** The library's per-path column, which this wrapper names `path` (see pathField). */
const PATH_PARAM = 'path_col';
export const CONDITION_DEF = 'retentioneering_condition';

const TASK_ID = { type: 'string', pattern: TASK_ID_PATTERN, description: 'A task this tool started (its task_id).' };

const eventstreamWindow = timeRange('The time window on the source\'s own time axis, applied before anything else (ISO dates; a date-only end is the whole day). A partitioned source is read only within it, and a source whose catalog requires a window refuses a build without one.');

/** The events sources a path analysis can run over: those that name who each event belongs to. */
export function pathSources(catalog) {
  return catalog.facts.filter((f) => userKeyColumn(catalog, f));
}

/** The source's per-user key column, through the relationship it declares toward the users role. */
export function userKeyColumn(catalog, source) {
  const rel = catalog.entityTowardRole(source, 'users');
  const parts = rel ? catalog.entityKey(source, rel) : null;
  return parts && parts.length === 1 ? parts[0].column : null;
}

/** A source's own columns a path can be segmented or filtered by: every real column of it — what the
 *  catalog declares, and, when the warehouse was read, what the table holds (the same columns a
 *  pipeline can filter on) — without the event name, which the eventstream already is. */
export function sourceColumns(catalog, source, physical = null) {
  const eventCol = catalog.eventNameColumn(source);
  const declared = [...catalog.modelDimensionColumns(source), ...catalog.modelColumns(source).map((c) => c.name)];
  return [...new Set([...declared, ...(physical ? [...physical] : [])])].filter((c) => c && c !== eventCol).sort();
}

/** The relationships the path sources declare toward `model`. */
function relationshipsTo(catalog, sources, model) {
  return [...new Set(sources.flatMap((s) => Object.keys(catalog.entitiesOf(s)).filter((name) => catalog.joinTargetFor(name) === model)))].sort();
}

/** One event name of the path sources: an enum of their vocabularies (each checked against the source
 *  named at call time), or a free string when a source declares none (the warehouse decides). */
function eventName(catalog, sources) {
  const lists = sources.map((s) => catalog.eventNames(s));
  if (lists.some((l) => !l.length)) return { type: 'string' };
  return { type: 'string', enum: [...new Set(lists.flat())].sort() };
}

/** When events need logic the build's own rules cannot say — the one sentence every description that
 *  offers from_task carries. */
export const COMPLEX_EVENT_LOGIC = 'For event logic the build cannot say itself — events defined by a window (a lag, a gap, the n-th occurrence), by a match_recognize sequence, from several sources joined, over a cohort chosen by what users did — build that table with build_pipeline_model first and start the eventstream from its task (from_task).';

export function buildSchema(catalog) {
  const sources = pathSources(catalog);
  // an event of the source (the catalog's names, as an enum); a build from a task's table reads the
  // names that table holds instead — the same fields, with that one constraint lifted (see the end)
  const event = eventName(catalog, sources);
  const events = (description) => ({ type: 'array', minItems: 1, uniqueItems: true, items: event, description });
  const segmentBranches = catalog.modelKeys().map((model) => {
    const via = relationshipsTo(catalog, sources, model);
    return {
      type: 'object', additionalProperties: false, required: ['model', 'attribute'], title: model,
      properties: {
        model: { const: model },
        attribute: { type: 'string', enum: catalog.modelDimensionColumns(model), description: `A column of ${model}.` },
        ...(via.length ? { via: { type: 'string', enum: via, description: 'The relationship to reach it by, when the source declares several toward it.' } } : {}),
        name: { type: 'string', pattern: NAME, description: 'Name of the segment column (default: the attribute).' },
      },
    };
  }).filter((b) => b.properties.attribute.enum.length);
  // the source's OWN columns (its declared dimensions — an environment, an app, a platform) and its
  // scalar event properties: carried or filtered on without any join
  const ownColumns = [...new Set(sources.flatMap((src) => sourceColumns(catalog, src)))].sort();
  // a real column of the source — checked against the warehouse's table at call time, so a column the
  // catalog does not declare (an environment flag) is reachable exactly as a pipeline reaches it
  const column = (what) => ({ type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$', description: `${what}${ownColumns.length ? ` (declared: ${ownColumns.slice(0, 12).join(', ')}${ownColumns.length > 12 ? ', …' : ''})` : ''}; any other column of the table is checked against the warehouse.` });
  const ownProps = [...new Set(sources.flatMap((src) => catalog.scalarEventProps(src)))].sort();
  const own = (list, what) => ({ type: 'string', enum: list, description: `${what} of the source (each is checked against the source you name).` });
  segmentBranches.push({
    type: 'object', additionalProperties: false, required: ['column'], title: 'source column',
    properties: { column: column('A column of the source itself'), name: { type: 'string', pattern: NAME, description: 'Name of the segment column (default: the column).' } },
  });
  if (ownProps.length) segmentBranches.push({
    type: 'object', additionalProperties: false, required: ['property'], title: 'event property',
    properties: { property: own(ownProps, 'A scalar event_data property'), name: { type: 'string', pattern: NAME, description: 'Name of the segment column (default: the property).' } },
  });
  const OP = { enum: OPS };
  const VALUE = { ...CONSTANT, description: 'The constant (an array for in/not_in; [low, high] for between, both included; a string for the text operators; none for is_null/is_not_null).' };
  // one condition on the source's own column or on a scalar event property — the filter's and a split case's
  const condition = {
    anyOf: [
      { type: 'object', additionalProperties: false, required: ['column', 'op'], title: 'column', properties: { column: column('A column of the source'), op: OP, value: VALUE } },
      ...(ownProps.length ? [{ type: 'object', additionalProperties: false, required: ['property', 'op'], title: 'event property', properties: { property: own(ownProps, 'A scalar event_data property'), op: OP, value: VALUE } }] : []),
    ],
  };
  const parameter = {
    anyOf: [
      { type: 'object', additionalProperties: false, required: ['column'], title: 'column', properties: { column: column('A column of the source') } },
      ...(ownProps.length ? [{ type: 'object', additionalProperties: false, required: ['property'], title: 'event property', properties: { property: own(ownProps, 'A scalar event_data property') } }] : []),
    ],
  };
  const split = {
    type: 'array', minItems: 1,
    description: 'Make events out of an event\'s parameters, in SQL, before the paths are built: each rule renames the rows of one event. `by` splits it by the value of a property or column (ad_finished by is_error → ad_finished_true / ad_finished_false; `names` gives values their own names: { "true": "ad_finished_failed", "false": "ad_finished_success" }); `cases` names it by conditions, the first that holds (and `else` the rest). Rows of the event without the parameter keep its name. The new names are what every analysis reads; groups and top apply after.',
    items: {
      anyOf: [
        {
          type: 'object', additionalProperties: false, required: ['event', 'by'], title: 'by value',
          properties: {
            event,
            by: parameter,
            names: { type: 'object', additionalProperties: { type: 'string', pattern: NAME }, description: 'Your name for a value ({ "<value>": "<event name>" }); any other value becomes <event>_<value>.' },
          },
        },
        {
          type: 'object', additionalProperties: false, required: ['event', 'cases'], title: 'by conditions',
          properties: {
            event,
            cases: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['name', 'where'], properties: { name: { type: 'string', pattern: NAME, description: 'The new event\'s name.' }, where: conditionList(condition, 'Conditions that all hold (an item may be { or: [...] }).') } }, description: 'The first case whose conditions hold names the row.' },
            else: { type: 'string', pattern: NAME, description: 'The name for the event\'s other rows (omit: they keep the event\'s name).' },
          },
        },
      ],
    },
  };
  const f = retentioneeringFacts();
  const index = { type: 'integer', minimum: 1, description: 'edit_step / insert_step / delete_step: which step (1-based; insert_step puts the new one before it, or at the end with steps + 1).' };
  return buildForms(event, {
    description: 'The eventstream a path analysis reads — declared and built in SQL where the data lives (start), then shaped step by step with the library\'s own steps, each checked by the library as it is added, and materialized. Its rows come from an events source of the catalog (source), or from the stored table of a task (from_task + columns).',
    properties: {
      action: { enum: BUILD_ACTIONS, description: BUILD_ACTIONS.map((a) => `${a}: ${ACTION_SAYS()[a]}`).join('; ') },
      eventstream: { type: 'string', pattern: NAME, description: 'The eventstream a step action or fork works on (optional when the context holds one).' },
      step: { ...stepSchema(), description: 'edit_step / insert_step: one of the library\'s own steps — { type: <op>, ...its parameters under the library\'s names }.' },
      steps: { type: 'array', minItems: 1, items: stepSchema(), description: 'add_steps: the library\'s own steps — one or several, applied in order, each { type: <op>, ...its parameters under the library\'s names }.' },
      index,
      after: { type: 'integer', minimum: 0, description: 'truncate: keep steps 1..after (0: none). fork: copy steps 1..after (default: all).' },
      name: { type: 'string', pattern: NAME, description: 'start: name of this eventstream (lowercase snake_case; a context may hold several, and a later start of the same name replaces it). fork: the new eventstream\'s name.' },
      source: { type: 'string', enum: sources, description: 'The events source the paths are read from. Each path is one user\'s events, in time order; the user key is the one the source declares toward the users model. With from_task: the source that table was built from, when the task does not say it.' },
      from_task: {
        type: 'string', pattern: '^[a-f0-9]{12}$',
        description: `${COMPLEX_EVENT_LOGIC} The task of a finished build_pipeline_model materialize (or of a query run with materialize: true) whose stored table holds one row per event; the paths are read from it, not recomputed. Name its columns in columns. There, where / segments / events.split name the table's columns (payload properties and joined attributes are brought in by the pipeline), and the time window is the pipeline's.`,
      },
      columns: {
        type: 'object', additionalProperties: false, required: ['path', 'event', 'time'],
        description: 'With from_task: which columns of that table say which path an event is on, which event, and when.',
        properties: {
          path: {
            anyOf: [
              { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$' },
              { type: 'array', minItems: 1, maxItems: 4, uniqueItems: true, items: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$' } },
            ],
            description: 'The path key: one column (a user, a bidfloor_id, a tracking_id) — one path per value — or several (a user and a bidfloor_id: one path per player per cycle).',
          },
          event: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$', description: 'The column of the event name.' },
          time: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$', description: 'The column of the event time (a timestamp or a date) — the paths\' order.' },
        },
      },
      context_id: { type: 'string', pattern: CTX, description: 'Build into this context (it keeps its other eventstreams). Omit to start a new one.' },
      description: { type: 'string', description: 'What this eventstream is for, in your words — kept with the context.' },
      time_range: eventstreamWindow,
      path: {
        type: 'array', minItems: 1, maxItems: 4, items: parameter,
        description: `What one path is, when it is not the user (${[...new Set(sources.map((src) => userKeyColumn(catalog, src)))].join(', ')}): a column or scalar event property of the source — one path per value (a bidfloor id: one path per search cycle; a tracking id; a level) — or several, a composite key (the user column and a bidfloor id: one path per player per cycle). Events without every part are left out. Omit for one path per user.`,
      },
      events: {
        type: 'object', additionalProperties: false,
        description: 'Which events make up the paths, and under what names.',
        properties: {
          include: events('Keep only these events of the source (omit: every event).'),
          exclude: events('Drop these events (technical noise the paths should not show).'),
          groups: { type: 'object', propertyNames: { pattern: NAME }, additionalProperties: { type: 'array', minItems: 1, uniqueItems: true, items: { anyOf: [event, { type: 'string', pattern: NAME, description: 'An event events.split makes: a name in its names, cases or else, or <event>_<value> of a split by value.' }] }, description: 'The events merged under this name — events of the source, or events events.split makes.' }, description: 'Merge several events under one name: { "<new name>": ["<event>", …] }. A group name replaces its events in every analysis.' },
          split,
          top: { type: 'integer', minimum: 1, description: 'Optional: keep only the N most frequent event names (after grouping) and merge the rest into "other". Omitted, every event keeps its own name.' },
        },
      },
      segments: {
        type: 'array', minItems: 1,
        description: 'Columns to carry on every event as segments — what segment_overview, metric_distribution, diff and in_segment read: an attribute of a model the source reaches by a declared relationship ({ model, attribute }), a column of the source itself ({ column }), or a scalar event property ({ property }).',
        items: anyOfOr(segmentBranches),
      },
      where: conditionList({
        anyOf: [
          { ...condition.anyOf[0], properties: { ...condition.anyOf[0].properties, column: column('A column of the source (an environment or app column, say) or a segment declared above (its `name` or attribute name)') } },
          ...condition.anyOf.slice(1),
        ],
      }, 'Keep only the events matching every condition — on a column of the source itself or a segment declared above ({ column }), or on a scalar event property ({ property }); an item may be { or: [...] }, any of its conditions holds. Applied in SQL before the paths are built.'),
      sessions: {
        type: 'object', additionalProperties: false, required: ['gap_minutes'],
        description: 'Also split each user\'s path into sessions at gaps longer than gap_minutes, in SQL, so an analysis can read per-session paths (path: "sessions"). (A split_sessions step splits them by other rules: a timeout, a separator event, bounds.)',
        properties: { gap_minutes: { type: 'integer', minimum: 1 } },
      },
      sample: (() => {
        const kept = {
          share: { type: 'number', exclusiveMinimum: 0, maximum: 1, description: 'The share of users kept (0 < share ≤ 1).' },
          events: {
            type: 'object', minProperties: 1,
            propertyNames: { anyOf: [event, { type: 'string', pattern: NAME }] },
            additionalProperties: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
            description: 'The share of rows kept per event: { "<event>": share }. An event of the source or one events.split makes; groups apply after.',
          },
        };
        // by users, by events, or both — three closed forms, told apart by what each requires
        const by = (title, keys) => form({ title, required: keys, properties: pick(kept, keys) });
        return {
          type: 'object',
          description: 'Make the eventstream smaller, in SQL, before it is materialized — deterministic (a hash, not a random draw), so every build keeps the same rows. `share` keeps that share of USERS with all their events: the paths stay whole, so every analysis stays exact for the users kept. `events` keeps only a share of the rows of the named events ({ "ad_finished": 0.05 }), each row chosen by a hash of its user, time and name, and every other event whole: for an event so frequent it drowns the rest. A sampled event is under-counted by its share and drops out between its neighbours in the rest of the path, so transitions into and out of it (and counts, funnels and metrics over it) are no longer exact — use it when that event is context rather than the question. Both may be given.',
          anyOf: [by('a share of users', ['share']), by('a share of some events', ['events']), by('both', ['share', 'events'])],
        };
      })(),
    },
    $defs: { [CONDITION_DEF]: f.condition_schema },
  });
}

/** The build's actions, the pipeline builder's own words for the same moves. */
export const BUILD_ACTIONS = ['start', 'add_steps', 'edit_step', 'insert_step', 'delete_step', 'truncate', 'fork', 'preview', 'materialize'];

/** What each build action does — said once, on the form of that action (and joined for the field that lists them all). */
const ACTION_SAYS = () => ({
  start: 'declares the eventstream and builds it in SQL (a task); the default',
  add_steps: `appends library steps — one or several, all or none — and returns what each step changed (the events, path columns and segments it added or removed) and the eventstream's shape after them: its events, path columns, segments and their levels. Each is checked by the library itself on what the eventstream holds before it, so a step the library refuses is refused at once with the library's message (nothing runs). Not offered: ${NOT_OFFERED_OPS()}`,
  edit_step: 'replaces step `index`, re-checking every step after it and naming the first one it breaks',
  insert_step: 'inserts a step before step `index`, re-checking every step after it',
  delete_step: 'removes step `index`, re-checking every step after it',
  truncate: 'keeps steps 1..`after`',
  fork: 'copies steps 1..`after` into a new eventstream (`name`), to try a variant without touching this one',
  preview: 'lists the steps with what each changed',
  materialize: 'runs the steps not yet materialized on the warehouse (a task) — the analyses read the eventstream as materialized',
});

/**
 * The build as forms, one per action (and two for a start: from an events source, or from a task's
 * table) — each with exactly its own fields, so a stray one is refused rather than ignored. `schema`
 * carries every field (`properties`), the build's description and its `$defs`.
 *
 * The event fields hold the source's own names (an enum) when the rows come from an events source,
 * and the names a task's table holds when they come from one — a pipeline can compute event names the
 * catalog does not know. So a start from a task takes the same fields with that one constraint lifted,
 * and a start from a source keeps the catalog's enum: a typo there is still refused by the schema.
 */
function buildForms(event, schema) {
  const { properties: F, description, $defs } = schema;
  const free = { type: 'string', minLength: 1, description: 'An event name: of the source, or one the from_task table holds.' };
  const relax = (node) => (node === event ? free : Array.isArray(node) ? node.map(relax) : node && typeof node === 'object' ? Object.fromEntries(Object.entries(node).map(([k, v]) => [k, relax(v)])) : node);
  const lifted = event.enum ? relax(F) : F;
  const action = (value) => ({ tag: ['action', value], tagDescription: [].concat(value).map((a) => `${a}: ${ACTION_SAYS()[a]}`).join('; ') });
  const declaration = ['context_id', 'name', 'description', 'time_range', 'path', 'events', 'segments', 'where', 'sessions', 'sample'];
  // a step names the context its eventstream is in — a start may omit it (a new context), a step may not
  const stepContext = { ...F.context_id, description: 'The context the eventstream is in — the context_id start returned.' };
  const step = (value, title, required, optional = []) => form({ title, ...action(value), required: ['context_id', ...required], properties: { ...pick(F, ['context_id', 'eventstream', ...required, ...optional]), context_id: stepContext } });
  return {
    type: 'object',
    description,
    anyOf: [
      form({ title: 'start from an events source', ...action('start'), optionalTag: true, required: ['name', 'source'], properties: pick(F, ['source', ...declaration]) }),
      form({ title: 'start from a task\'s table', ...action('start'), optionalTag: true, required: ['name', 'from_task', 'columns'], properties: pick(lifted, ['from_task', 'columns', 'source', ...declaration]) }),
      step('add_steps', 'add steps', ['steps']),
      step(['edit_step', 'insert_step'], 'edit or insert a step', ['index', 'step']),
      step('delete_step', 'delete a step', ['index']),
      step('truncate', 'truncate the steps', ['after']),
      step('fork', 'fork the eventstream', ['name'], ['after', 'description']),
      step(['preview', 'materialize'], 'preview or materialize', []),
    ],
    ...($defs ? { $defs } : {}),
  };
}

/** Whose paths: the wrapper's name for the library's path column. */
const pathField = {
  anyOf: [
    { enum: ['users', 'sessions'] },
    { type: 'string', pattern: NAME, description: 'A path column a split_sessions step made (its session_col).' },
  ],
  description: 'Whose paths: each user\'s whole history (default), each session of the build (sessions), or the session column a split_sessions step made — a step of this eventstream before this one, or one materialized.',
};

/** Whether a schema (of the sheet) holds an anchor spec: an object with the library's anchor keys
 *  (a path metric's own `pattern` argument is counted as that metric's, below). */
const holdsAnchor = (sc) => !!sc && typeof sc === 'object' && (retentioneeringFacts().anchor_keys.every((k) => sc.properties?.[k] !== undefined) || Object.values(sc).some((v) => (Array.isArray(v) ? v.some(holdsAnchor) : holdsAnchor(v))));

/** Whether a library parameter is written in the path-pattern language — read off the sheet: its
 *  docstring links the grammar, or its type is an anchor spec (whose `pattern` is one). */
export const takesPathPattern = (p) => /\/docs\/path-patterns/.test(p.doc || '') || holdsAnchor(p.schema);

/** Every place the path-pattern language is written, from the sheet: each analysis's and op's
 *  parameter that takes one, and each path metric with a `pattern` argument. */
export function pathPatternUses() {
  const f = retentioneeringFacts();
  const of = (group) => Object.entries(group).flatMap(([k, x]) => x.params.filter(takesPathPattern).map((p) => `${k}.${p.name}`));
  return [...of(f.analyses), ...of(f.ops), ...Object.entries(f.metric_args).filter(([, a]) => a.pattern !== undefined).map(([m]) => `the ${m} metric`)];
}

/** A library parameter as a schema property: its type, its default, its first docstring paragraph. */
function param(p) {
  // a parameter written in the path-pattern language points at its grammar, which the guide carries
  const doc = p.doc && takesPathPattern(p) ? `${p.doc} The grammar in full: semantic_index({ request: { guide: "retentioneering" } }) → path_patterns.` : p.doc;
  return { ...p.schema, ...(p.default !== undefined ? { default: p.default } : {}), ...(doc ? { description: doc } : {}) };
}

/** add_segment's metric_bins as ONE list of bins, each with its own level name. The library takes
 *  cut points and level names as two lists whose lengths must agree (N cut points → N + 1 bins, and
 *  `quantiles: q` → q); two lists a schema cannot tie together are a mistake waiting to be written,
 *  so the tool asks for the bins themselves and a count that disagrees cannot be written at all.
 *  What the library allows in each (the metrics that give one value per path, the fewest equal
 *  quantiles, the open interval of a cut quantile, the reserved level) comes from the sheet. */
function metricBinsSchema() {
  const b = retentioneeringFacts().metric_bins;
  // '${b.undefined_level}' is the library's own level (the paths the metric has no value for): any other name
  const level = stringOtherThan(b.undefined_level, { minLength: 1, description: `This bin's segment level (unique within the split; '${b.undefined_level}' is the level of paths the metric has no value for).` });
  const lowest = { type: 'object', additionalProperties: false, required: ['level'], properties: { level } };
  const bounded = (key, schema) => ({ type: 'object', additionalProperties: false, required: ['level', key], properties: { level, [key]: schema } });
  return {
    type: 'object', additionalProperties: false, required: ['metric', 'bins'],
    description: `Split paths into segment levels by a per-path metric: one entry per bin, lowest first. The first bin has no lower bound; each next one starts at \`from\` (a value of the metric) or \`from_quantile\` (a share of paths, between 0 and 1) and runs up to the next one's start; bins with no bound at all are ${b.min_quantile_bins} or more equal-sized quantiles. Paths the metric has no value for get the level '${b.undefined_level}'.`,
    properties: {
      metric: { ...b.metric_schema, description: 'The per-path metric binned (one value per path).' },
      bins: {
        anyOf: [
          { title: 'by value', type: 'array', minItems: 2, prefixItems: [lowest], items: bounded('from', { type: 'number', description: 'Where this bin starts (inclusive), in the metric\'s units.' }) },
          { title: 'by quantile', type: 'array', minItems: 2, prefixItems: [lowest], items: bounded('from_quantile', { type: 'number', ...b.quantile_bounds, description: 'Where this bin starts, as the share of paths below it.' }) },
          { title: 'equal quantiles', type: 'array', minItems: b.min_quantile_bins, items: lowest },
        ],
      },
    },
  };
}

/** metric_bins as the library takes it (its own keys): the bins' starts sorted, each level kept
 *  with its bin. What a schema cannot say — two bins of one name, two starting at one point — is
 *  refused here, in the call. */
function metricBinsToLibrary({ metric, bins }, field) {
  const levels = bins.map((x) => x.level);
  const twice = levels.find((l, i) => levels.indexOf(l) !== i);
  if (twice !== undefined) throw new ToolError(`two bins are named '${twice}' — each bin needs its own level`, { stage: 'validate', field });
  const [lowest, ...rest] = bins;
  const key = rest.length && 'from' in rest[0] ? 'from' : rest.length && 'from_quantile' in rest[0] ? 'from_quantile' : null;
  if (!key) return { metric, quantiles: bins.length, segment_levels: levels };
  const sorted = [...rest].sort((x, y) => x[key] - y[key]);
  const same = sorted.find((x, i) => i && x[key] === sorted[i - 1][key]);
  if (same) throw new ToolError(`two bins start at ${key} ${same[key]} — each bin starts where the one before it ends`, { stage: 'validate', field });
  return { metric, [key === 'from' ? 'edges' : 'quantiles']: sorted.map((x) => x[key]), segment_levels: [lowest.level, ...sorted.map((x) => x.level)] };
}

/** add_segment's rules as cases the tool writes the SQL of. The library takes `[column, op, value,
 *  level]` entries and a final `[else_level]` and pastes `op` — and, for `in`, the value — into the
 *  CASE it runs on the analysis runtime, which is code taken from a call (NOT_OFFERED.params.sql says
 *  why this server takes none). So the operator is one of the library's own condition grammar, and
 *  every value is a constant the tool quotes itself; the shape also leaves no else entry to misplace. */
function rulesSchema() {
  const g = retentioneeringFacts().condition;
  const scalar = [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }];
  const level = { type: 'string', minLength: 1 };
  const kase = (op, value) => ({ type: 'object', additionalProperties: false, required: ['column', 'op', 'value', 'level'], properties: { column: { type: 'string', minLength: 1, description: 'A column of the eventstream (a segment, the event, a path column).' }, op, value, level: { ...level, description: 'The segment level of the paths this case matches.' } } });
  return {
    type: 'object', additionalProperties: false, required: ['cases', 'else'],
    description: 'Segment levels by conditions on the eventstream\'s columns, the first case that matches deciding: each case a column, an operator and a constant (a list of them for \'in\'), and `else` for what no case matches.',
    properties: {
      cases: { type: 'array', minItems: 1, items: { anyOf: [kase({ enum: g.compare }, { anyOf: scalar }), kase({ const: g.membership }, { type: 'array', minItems: 1, items: { anyOf: scalar } })] } },
      else: { ...level, description: 'The level of every row no case matches.' },
    },
  };
}

/** The library runs what this tool writes on DuckDB (its analysis runtime): the constants and names in
 *  it are the DuckDB dialect's own, quoted by its one writer. */
const DUCKDB = getDialect('duckdb');
/** A constant as a DuckDB literal: a string quoted (its quotes doubled), a number as itself. */
const literal = (v) => DUCKDB.sqlLiteral(v);

/** rules as the library takes them: `[column, op, value, level]` per case, then `[else]`. A value is
 *  handed over as the library quotes it (a string, a number, a flag) — and a list for `in` as the
 *  tuple of literals this tool writes. */
function rulesToLibrary({ cases, else: otherwise }, field) {
  const g = retentioneeringFacts().condition;
  return [
    ...cases.map((c) => {
      if (c.op === g.membership) return [c.column, c.op, `(${c.value.map(literal).join(', ')})`, c.level];
      if (typeof c.value === 'number' && !Number.isFinite(c.value)) throw new ToolError(`case on '${c.column}': ${c.value} is not a number a comparison can take`, { stage: 'validate', field });
      return [c.column, c.op, c.value, c.level];
    }),
    [otherwise],
  ];
}

/** A row condition on the eventstream's columns — a leaf compares one column with constants; a group
 *  ANDs or ORs its conditions; `not` negates one. The operators are the library's condition grammar's
 *  (its comparisons, its membership, its negation), with not_in and the null checks SQL adds. */
function rowConditionSchema() {
  const g = retentioneeringFacts().condition;
  const scalar = { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] };
  // a list of one kind of constant: it is compared as that kind, whatever type the column is stored in
  const list = { anyOf: ['string', 'number', 'boolean'].map((type) => ({ type: 'array', minItems: 1, items: { type } })) };
  const column = { type: 'string', pattern: NAME_OR_COLUMN, description: 'A column of the eventstream at this step: the event, its time, a path column (a session a split_sessions step made, its index), a segment, a custom column.' };
  const leaf = {
    anyOf: [
      { type: 'object', additionalProperties: false, required: ['column', 'op', 'value'], properties: { column, op: { enum: g.compare }, value: scalar } },
      { type: 'object', additionalProperties: false, required: ['column', 'op', 'value'], properties: { column, op: { enum: [g.membership, `not_${g.membership}`] }, value: list } },
      { type: 'object', additionalProperties: false, required: ['column', 'op'], properties: { column, op: { enum: ['is_null', 'is_not_null'] } } },
    ],
  };
  const group = (items) => ({ type: 'object', additionalProperties: false, required: ['op', 'conditions'], properties: { op: { enum: g.logical }, conditions: { type: 'array', minItems: 1, items } } });
  const negated = (of) => ({ type: 'object', additionalProperties: false, required: [g.negation], properties: { [g.negation]: of } });
  const inner = group(leaf);
  return {
    ...group({ anyOf: [leaf, inner, negated({ anyOf: [leaf, inner] })] }),
    description: `Keep only the rows whose columns satisfy a condition — a threshold, a range, a list, a missing value — on any column the eventstream has at this step (what keep / drop cannot say: they match listed values only). A number or a flag is compared as one, whatever the column is stored as (a segment is text). A missing value matches no comparison and no list, so a negation (!=, not_${g.membership}, ${g.negation}) keeps it, as drop does; is_null picks it out. Conditions combine with ${g.logical.join(' / ')} (one level of nesting) and ${g.negation}; this tool writes the SQL the library runs, its names and constants quoted. Instead of keep / drop, not with them.`,
  };
}

/** A column name as a DuckDB identifier, quoted. */
const ident = (name, field) => {
  try { return DUCKDB.quoteIdent(name); } catch { throw new ToolError(`'${name}' is not a column name`, { stage: 'validate', field }); }
};

/** A row condition as the library's `sql` for filter_events: SELECT * FROM eventstream WHERE …, every
 *  column quoted as an identifier and every constant as a literal — the caller's input stays data. A
 *  column is compared as the kind of its constant (a segment is stored as text: a threshold on it is a
 *  number's), and every test is two-valued — a missing value matches nothing, so a negation keeps it. */
function whereToSql(where, field) {
  const g = retentioneeringFacts().condition;
  const node = (n) => {
    if (n[g.negation] !== undefined) return `NOT (${node(n[g.negation])})`;
    if (n.conditions) return n.conditions.map((c) => `(${node(c)})`).join(` ${n.op.toUpperCase()} `);
    const name = ident(n.column, field);
    if (n.op === 'is_null') return `${name} IS NULL`;
    if (n.op === 'is_not_null') return `${name} IS NOT NULL`;
    const lit = (v) => { if (typeof v === 'number' && !Number.isFinite(v)) throw new ToolError(`condition on '${n.column}': ${v} is not a number a comparison can take`, { stage: 'validate', field }); return literal(v); };
    const sample = Array.isArray(n.value) ? n.value[0] : n.value;
    const col = typeof sample === 'number' ? `TRY_CAST(${name} AS DOUBLE)` : typeof sample === 'boolean' ? `TRY_CAST(${name} AS BOOLEAN)` : name;
    const test = (expr) => `COALESCE(${expr}, FALSE)`;
    if (n.op === g.membership || n.op === `not_${g.membership}`) {
      const inList = test(`${col} IN (${n.value.map(lit).join(', ')})`);
      return n.op === g.membership ? inList : `NOT ${inList}`;
    }
    if (n.op === '!=') return `NOT ${test(`${col} = ${lit(n.value)}`)}`;
    return test(`${col} ${n.op === '==' ? '=' : n.op} ${lit(n.value)}`);
  };
  return `SELECT * FROM eventstream WHERE ${node(where)}`;
}

/** Parameters this tool ADDS to a library op, each translated into one the library takes — a
 *  structured form of what the library would take as code (NOT_OFFERED): the schema reads `schema`,
 *  a step's value goes to the library under `library` through `toLibrary`. */
export const ADDED = {
  filter_events: { where: { schema: rowConditionSchema, library: 'sql', toLibrary: whereToSql } },
};

/** Library parameters the tool asks for in another shape, each with its translation back — the one
 *  table; the schema reads `schema`, the call's ops go through `toLibrary`. */
export const RESHAPED = {
  metric_bins: { schema: metricBinsSchema, toLibrary: metricBinsToLibrary },
  rules: { schema: rulesSchema, toLibrary: rulesToLibrary },
};

/** The properties and required list of a library callable's parameters — path_col as `path`, the
 *  parameters a call cannot carry left out, the reshaped ones in their own shape — and the VARIANTS
 *  its forms split into where one parameter decides what another may hold (a clustering's method
 *  decides its method_args). */
function params(list) {
  const properties = {};
  const required = [];
  for (const p of list) {
    if (NOT_OFFERED.params[p.name]) continue;
    if (p.name === PATH_PARAM) { properties.path = pathField; continue; }
    properties[p.name] = RESHAPED[p.name] ? RESHAPED[p.name].schema() : param(p);
    if (p.required) required.push(p.name);
  }
  return { properties, required, variants: methodVariants(list, properties) };
}

/** A clustering's method_args: the keys each method reads, from the library's own table of them — a
 *  variant per method, whose method_args take exactly that method's keys (the default method's may
 *  leave `method` out). → [] for a callable without both. */
function methodVariants(list, properties) {
  if (!properties.method_args || !properties.method) return [];
  const table = retentioneeringFacts().cluster_method_args;
  const fallback = list.find((p) => p.name === 'method')?.default;
  return Object.entries(table).map(([m, ks]) => ({
    title: `method: ${m}`,
    optional: m === fallback ? ['method'] : [],
    properties: {
      method: { const: m, ...(properties.method.description ? { description: properties.method.description } : {}) },
      method_args: { ...properties.method_args, type: 'object', additionalProperties: false, properties: Object.fromEntries(ks.map((k) => [k, { description: METHOD_ARGS_NOTE }])) },
    },
  }));
}

/**
 * The forms of a library callable (an op, an analysis): one — its tag, its parameters — or one per
 * variant, and a second of each where two parameters say the same thing two ways (`exclusive`: an
 * anchor and a path pattern centre the same steps, so a form takes one or the other).
 */
function callableForms({ tag, title, description, properties, required, variants, exclusive = null }) {
  const base = variants.length ? variants : [{ title: null, optional: [], properties: {} }];
  const out = [];
  for (const v of base) {
    const props = { ...properties, ...v.properties };
    const req = required.filter((r) => !v.optional.includes(r)).concat(Object.keys(v.properties).filter((k) => k === 'method' && !v.optional.includes('method')));
    const t = v.title ? `${title} — ${v.title}` : title;
    const one = (label, drop, need = null) => form({ title: label, description, tag, required: [...req.filter((r) => r !== drop), ...(need ? [need] : [])], properties: Object.fromEntries(Object.entries(props).filter(([k]) => k !== drop)) });
    // the first way is the one taken by default (its field optional); the second is the form that
    // names its own field — so a value giving neither is the first form's, and never both
    if (exclusive && exclusive.every((k) => k in props)) {
      out.push(one(`${t} — by ${exclusive[0]}`, exclusive[1]), one(`${t} — by ${exclusive[1]}`, exclusive[0], exclusive[1]));
    } else out.push(one(t, null));
  }
  return out;
}

function opSchemas() {
  const f = retentioneeringFacts();
  return offeredOps().flatMap((op) => {
    const { properties, required, variants } = params(f.ops[op].params);
    for (const [name, a] of Object.entries(ADDED[op] || {})) properties[name] = a.schema();
    return callableForms({ tag: ['type', op], title: op, description: f.ops[op].summary, properties, required, variants });
  });
}

/** One of the library's own steps ({ type: <op>, ...its parameters }) — an eventstream's step. */
function stepSchema() {
  return { anyOf: opSchemas() };
}

/** The ops left out, each with its reason — said wherever steps are offered. */
const NOT_OFFERED_OPS = () => Object.entries(NOT_OFFERED.ops).map(([op, why]) => `${op} (${why})`).join('; ');

const METHOD_ARGS_NOTE = 'the method\'s own arguments';

function analysisSchemas() {
  const f = retentioneeringFacts();
  const id = { type: 'string', pattern: NAME, description: 'Your name for this analysis in the result (default: its kind). Unique within the call.' };
  return analysisKinds().flatMap((kind) => {
    const a = f.analyses[kind];
    const { properties, required, variants } = params(a.params);
    return callableForms({
      tag: ['kind', kind], title: kind,
      description: `${a.summary}${CARD_KINDS.includes(kind) ? '' : ' (returned as tables, answered in words: it has no card)'}`,
      properties: { id, ...properties }, required, variants,
      // an anchor and a path pattern are two ways to centre the same steps: one or the other
      exclusive: ['anchor', 'path_pattern'],
    });
  });
}

export function querySchema() {
  const f = retentioneeringFacts();
  const F = {
    context_id: { type: 'string', pattern: CTX, description: 'The context the eventstream was built in.' },
    eventstream: { type: 'string', pattern: NAME, description: 'Which eventstream of the context (optional when it holds one).' },
    analyses: { type: 'array', minItems: 1, items: { anyOf: analysisSchemas() }, description: 'The analyses to run, computed together in one run.' },
    task_ids: { type: 'array', minItems: 1, uniqueItems: true, items: TASK_ID, description: 'The tasks to read back (or cancel) — one, or several read together; each one\'s result comes back under `results`, in this order.' },
    detail: { enum: ['summary', 'full'], default: 'summary', description: 'Reading a task: each analysis summarized — the biggest transitions, the leading events per step, each group\'s profile, the first rows of a table (summary) — or every record it computed (full).' },
    cancel: { const: true, description: 'Stop the tasks instead of reading them.' },
    wait_seconds: { type: 'integer', minimum: 0, maximum: MAX_WAIT_SECONDS, description: `How long to wait for a running task (default and cap ${MAX_WAIT_SECONDS}s).` },
  };
  return {
    type: 'object',
    description: 'Start path analyses over a built eventstream (its materialized steps included), or read one back.',
    anyOf: [
      form({ title: 'start analyses', required: ['context_id', 'analyses'], properties: pick(F, ['context_id', 'eventstream', 'analyses']) }),
      form({ title: 'read tasks', required: ['task_ids'], properties: pick(F, ['task_ids', 'detail', 'wait_seconds']) }),
      form({ title: 'cancel tasks', required: ['task_ids', 'cancel'], properties: pick(F, ['task_ids', 'cancel']) }),
    ],
    $defs: { [CONDITION_DEF]: f.condition_schema },
  };
}

export function displaySchema() {
  const f = retentioneeringFacts();
  return {
    type: 'object', additionalProperties: false, required: ['task_id', 'analysis'],
    description: 'Draw one analysis of a finished task as a card.',
    properties: {
      task_id: TASK_ID,
      analysis: { type: 'string', pattern: NAME, description: 'Which analysis of the task (its id — the kind, unless you named it).' },
      edge_weight: { enum: f.edge_weights, description: 'transition_graph: the weight the graph opens on (default proba_out); the card switches between all of them.' },
    },
  };
}
