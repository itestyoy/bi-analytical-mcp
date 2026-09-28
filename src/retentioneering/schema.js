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
import { CARD_KINDS } from './view-model.js';

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
    sql: 'a DuckDB statement run on the analysis runtime — code, which this server never takes from a call; declare the data in build_retentioneering_model instead (events, groups, segments, where)',
  },
};

/** The analyses the library offers, in the sheet's order. */
export const ANALYSIS_KINDS = Object.keys(retentioneeringFacts().analyses);
/** The preprocessing ops offered: every op the library registers, but the ones NOT_OFFERED. */
export const OFFERED_OPS = Object.keys(retentioneeringFacts().ops).filter((op) => !NOT_OFFERED.ops[op]);

export const NAME = '^[a-z][a-z0-9_]*$';
const CTX = '^[A-Za-z0-9_-]{1,64}$';
/** The library's per-path column, which this wrapper names `path` (see pathField). */
const PATH_PARAM = 'path_col';
export const CONDITION_DEF = 'retentioneering_condition';

const TASK_ID = { type: 'string', minLength: 1, description: 'A task this tool started (its task_id).' };

const timeRange = {
  type: 'object', additionalProperties: false,
  description: 'The time window on the source\'s own time axis, applied before anything else (ISO dates; a date-only end is the whole day).',
  properties: {
    start: { type: 'string', description: 'Inclusive start (ISO date/datetime).' },
    end: { type: 'string', description: 'Inclusive end (ISO date/datetime; a date-only end means the whole day).' },
    timezone: { type: 'string', description: 'Optional IANA timezone: start/end are wall-clock there. Omit for UTC.' },
  },
};

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

export function buildSchema(catalog) {
  const sources = pathSources(catalog);
  const event = eventName(catalog, sources);
  const events = (description) => ({ type: 'array', minItems: 1, uniqueItems: true, items: event, description });
  const segmentBranches = catalog.joinableModelKeys().map((model) => {
    const via = relationshipsTo(catalog, sources, model);
    return {
      type: 'object', additionalProperties: false, required: ['model', 'attribute'], title: model,
      properties: {
        model: { const: model },
        attribute: { type: 'string', enum: catalog.modelDimensionColumns(model), description: `A column of ${model}.` },
        ...(via.length ? { via: { type: 'string', enum: via, description: 'The relationship to reach it by, when the source declares several toward it.' } } : {}),
        as: { type: 'string', pattern: NAME, description: 'Name of the segment column (default: the attribute).' },
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
  const own = (key, list, what) => ({ type: 'string', enum: list, description: `${what} of the source (each is checked against the source you name).` });
  segmentBranches.push({
    type: 'object', additionalProperties: false, required: ['column'], title: 'source column',
    properties: { column: column('A column of the source itself'), as: { type: 'string', pattern: NAME, description: 'Name of the segment column (default: the column).' } },
  });
  if (ownProps.length) segmentBranches.push({
    type: 'object', additionalProperties: false, required: ['property'], title: 'event property',
    properties: { property: own('property', ownProps, 'A scalar event_data property'), as: { type: 'string', pattern: NAME, description: 'Name of the segment column (default: the property).' } },
  });
  const OPS = { enum: ['eq', 'neq', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte', 'is_null', 'is_not_null'] };
  const VALUE = { description: 'The constant (an array for in/not_in; none for is_null/is_not_null).' };
  // one condition on the source's own column or on a scalar event property — the filter's and a split case's
  const condition = {
    oneOf: [
      { type: 'object', additionalProperties: false, required: ['column', 'op'], title: 'column', properties: { column: column('A column of the source'), op: OPS, value: VALUE } },
      ...(ownProps.length ? [{ type: 'object', additionalProperties: false, required: ['property', 'op'], title: 'event property', properties: { property: own('property', ownProps, 'A scalar event_data property'), op: OPS, value: VALUE } }] : []),
    ],
  };
  const parameter = {
    oneOf: [
      { type: 'object', additionalProperties: false, required: ['column'], title: 'column', properties: { column: column('A column of the source') } },
      ...(ownProps.length ? [{ type: 'object', additionalProperties: false, required: ['property'], title: 'event property', properties: { property: own('property', ownProps, 'A scalar event_data property') } }] : []),
    ],
  };
  const split = {
    type: 'array', minItems: 1,
    description: 'Make events out of an event\'s parameters, in SQL, before the paths are built: each rule renames the rows of one event. `by` splits it by the value of a property or column (ad_finished by is_error → ad_finished_true / ad_finished_false; `names` gives values their own names: { "true": "ad_finished_failed", "false": "ad_finished_success" }); `cases` names it by conditions, the first that holds (and `else` the rest). Rows of the event without the parameter keep its name. The new names are what every analysis reads; groups and top apply after.',
    items: {
      oneOf: [
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
            cases: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['name', 'where'], properties: { name: { type: 'string', pattern: NAME, description: 'The new event\'s name.' }, where: { type: 'array', minItems: 1, items: condition, description: 'Conditions that all hold.' } } }, description: 'The first case whose conditions hold names the row.' },
            else: { type: 'string', pattern: NAME, description: 'The name for the event\'s other rows (omit: they keep the event\'s name).' },
          },
        },
      ],
    },
  };
  return {
    type: 'object', additionalProperties: false, required: ['name', 'source'],
    description: 'The eventstream a path analysis reads — declared, built in SQL where the data lives, and materialized.',
    properties: {
      name: { type: 'string', pattern: NAME, description: 'Name of this eventstream (lowercase snake_case). A context may hold several; a later build of the same name replaces it.' },
      source: { type: 'string', enum: sources, description: 'The events source the paths are read from. Each path is one user\'s events, in time order; the user key is the one the source declares toward the users model.' },
      context_id: { type: 'string', pattern: CTX, description: 'Build into this context (it keeps its other eventstreams). Omit to start a new one.' },
      description: { type: 'string', description: 'What this eventstream is for, in your words — kept with the context.' },
      time_range: timeRange,
      events: {
        type: 'object', additionalProperties: false,
        description: 'Which events make up the paths, and under what names.',
        properties: {
          include: events('Keep only these events of the source (omit: every event).'),
          exclude: events('Drop these events (technical noise the paths should not show).'),
          groups: { type: 'object', propertyNames: { pattern: NAME }, additionalProperties: events('The events merged under this name.'), description: 'Merge several events under one name: { "<new name>": ["<event>", …] }. A group name replaces its events in every analysis.' },
          split,
          top: { type: 'integer', minimum: 1, description: 'Optional: keep only the N most frequent event names (after grouping) and merge the rest into "other". Omitted, every event keeps its own name.' },
        },
      },
      segments: {
        type: 'array', minItems: 1,
        description: 'Columns to carry on every event as segments — what segment_overview, metric_distribution, diff and in_segment read: an attribute of a model the source reaches by a declared relationship ({ model, attribute }), a column of the source itself ({ column }), or a scalar event property ({ property }).',
        items: segmentBranches.length ? { oneOf: segmentBranches } : { not: {} },
      },
      where: {
        type: 'array', minItems: 1,
        description: 'Keep only the events matching every condition — on a column of the source itself or a segment declared above ({ column }), or on a scalar event property ({ property }). Applied in SQL before the paths are built.',
        items: {
          oneOf: [
            { ...condition.oneOf[0], properties: { ...condition.oneOf[0].properties, column: column('A column of the source (an environment or app column, say) or a segment declared above (its `as` or attribute name)') } },
            ...condition.oneOf.slice(1),
          ],
        },
      },
      sessions: {
        type: 'object', additionalProperties: false, required: ['gap_minutes'],
        description: 'Also split each user\'s path into sessions at gaps longer than gap_minutes, in SQL, so an analysis can read per-session paths (path: "sessions"). (A split_sessions preprocess step does the same inside an analysis, by other rules.)',
        properties: { gap_minutes: { type: 'integer', minimum: 1 } },
      },
      sample: {
        type: 'object', additionalProperties: false, required: ['share'],
        description: 'Keep a share of USERS (all of each kept user\'s events), chosen by a hash of the user key: the same users on every build. Use it to keep a large source within what one analysis run holds in memory.',
        properties: { share: { type: 'number', exclusiveMinimum: 0, maximum: 1 } },
      },
    },
  };
}

/** Whose paths: the wrapper's name for the library's path column. */
const pathField = {
  anyOf: [
    { enum: ['users', 'sessions'] },
    { type: 'string', pattern: NAME, description: 'The session_col of a split_sessions step in preprocess.' },
  ],
  description: 'Whose paths: each user\'s whole history (default), each session of the build (sessions), or the session column a split_sessions preprocess step adds.',
};

/** A library parameter as a schema property: its type, its default, its first docstring paragraph. */
function param(p) {
  return { ...p.schema, ...(p.default !== undefined ? { default: p.default } : {}), ...(p.doc ? { description: p.doc } : {}) };
}

/** The properties and required list of a library callable's parameters — path_col as `path`, the
 *  parameters a call cannot carry left out. */
function params(list) {
  const properties = {};
  const required = [];
  for (const p of list) {
    if (NOT_OFFERED.params[p.name]) continue;
    if (p.name === PATH_PARAM) { properties.path = pathField; continue; }
    properties[p.name] = param(p);
    if (p.required) required.push(p.name);
  }
  return { properties, required };
}

function opSchemas() {
  const f = retentioneeringFacts();
  return OFFERED_OPS.map((op) => {
    const { properties, required } = params(f.ops[op].params);
    return {
      type: 'object', additionalProperties: false, title: op, description: f.ops[op].summary,
      required: ['type', ...required],
      properties: { type: { const: op }, ...properties },
    };
  });
}

function preprocessField(where) {
  return {
    type: 'array', minItems: 1,
    items: { oneOf: opSchemas(), discriminator: { propertyName: 'type' } },
    description: `Library preprocessing steps applied in order ${where} — retentioneering's own op model ({ type: <op>, ...its parameters }). Not offered: ${Object.entries(NOT_OFFERED.ops).map(([op, why]) => `${op} (${why})`).join('; ')}.`,
  };
}

const METHOD_ARGS_NOTE = 'the method\'s own arguments';

function analysisSchemas() {
  const f = retentioneeringFacts();
  const id = { type: 'string', pattern: NAME, description: 'Your name for this analysis in the result (default: its kind). Unique within the call.' };
  return ANALYSIS_KINDS.map((kind) => {
    const a = f.analyses[kind];
    const { properties, required } = params(a.params);
    // clustering: the keys each method reads, from the library's own table of them
    if (properties.method_args) {
      const keys = [...new Set(Object.values(f.cluster_method_args).flat())].sort();
      properties.method_args = { ...properties.method_args, type: 'object', additionalProperties: false, properties: Object.fromEntries(keys.map((k) => [k, { description: `${METHOD_ARGS_NOTE} (${Object.entries(f.cluster_method_args).filter(([, ks]) => ks.includes(k)).map(([m]) => m).join(', ')})` }])) };
    }
    const branch = {
      type: 'object', additionalProperties: false, title: kind, description: `${a.summary}${CARD_KINDS.includes(kind) ? '' : ' (returned as tables, answered in words: it has no card)'}`,
      required: ['kind', ...required],
      properties: { kind: { const: kind }, id, preprocess: preprocessField('to this analysis alone, after the call\'s own preprocess'), ...properties },
    };
    // an anchor and a path pattern are two ways to centre the same steps: one or the other
    if (properties.anchor && properties.path_pattern) branch.not = { required: ['anchor', 'path_pattern'] };
    return branch;
  });
}

export function querySchema() {
  const f = retentioneeringFacts();
  return {
    type: 'object', additionalProperties: false,
    description: 'Start path analyses over a built eventstream, or read one back.',
    allOf: [
      { if: { required: ['analyses'] }, then: { required: ['context_id'] } },
    ],
    properties: {
      context_id: { type: 'string', pattern: CTX, description: 'The context the eventstream was built in.' },
      eventstream: { type: 'string', pattern: NAME, description: 'Which eventstream of the context (optional when it holds one).' },
      preprocess: preprocessField('to the eventstream before every analysis of this call'),
      analyses: { type: 'array', minItems: 1, items: { oneOf: analysisSchemas(), discriminator: { propertyName: 'kind' } }, description: 'The analyses to run, computed together in one run.' },
      task_id: TASK_ID,
      task_ids: { type: 'array', minItems: 1, uniqueItems: true, items: TASK_ID, description: 'Several tasks, read together.' },
      detail: { enum: ['summary', 'full'], default: 'summary', description: 'Reading a task: each analysis summarized — the biggest transitions, the leading events per step, each group\'s profile, the first rows of a table (summary) — or every record it computed (full).' },
      cancel: { type: 'boolean', description: 'With task_id / task_ids: stop them.' },
      wait_seconds: { type: 'integer', minimum: 0, maximum: MAX_WAIT_SECONDS, description: `How long to wait for a running task (default and cap ${MAX_WAIT_SECONDS}s).` },
    },
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
