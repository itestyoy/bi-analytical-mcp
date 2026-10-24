// THE RETENTIONEERING FEATURE'S TOOL SCHEMAS — a wrapper over the whole library, typed as far as the
// library itself says. Every analysis and every preprocessing op the library registers, each with its
// own parameters under the library's own names, their types, defaults and first docstring sentence (the
// rest of the docstring is the guide's: `parameters`);
// every path metric with exactly the arguments it takes; the condition grammar; the edge weights,
// aggregations, clustering methods and scalers — all rendered from config/retentioneering-facts.json,
// the sheet scripts/retentioneering-facts.py extracts from the installed library. Nothing here restates
// one from the library's prose. What the CATALOG decides (the events sources) comes from the catalog,
// through the core's one stage definition (`$defs.stage`, src/pipeline/stages.js stageDefs) — the
// library's ops are this tool's runtime group in it, and no stage of the pipeline: the rows are prepared
// by build_model and read from its task — and its one expression (`$defs.expr`), built for filter_events'
// where, so they hold what that place takes and nothing else. What each place of the build takes is
// checked as the step is built (build-input.js checkStepPlaces). Names that exist only once an
// eventstream is built (the event names it holds, the columns its steps make) are checked at call time
// against what the steps produced.
//
// What a call cannot carry is not offered, each for its stated reason (NOT_OFFERED): a Python callable,
// a DuckDB statement run on the analysis runtime (code, which this server never takes from a call —
// the data is declared in the build instead, in SQL where it lives), and the two ops the eventstream's
// shape rules out.

import { readFileSync } from 'node:fs';
import { assetPath, missingAssetMessage } from '../runtime-assets.js';
import { ToolError, firstSentence } from '../validate.js';
import { TASK_ID_PATTERN } from '../jobs.js';
import { getDialect } from '../dialects/index.js';
import { CARD_KINDS } from './view-model.js';
import { form, pick, stringOtherThan, timeRange, conditionSlot } from '../schema-kit.js';
import { stageDefs } from '../pipeline/stages.js';
import { conditionListSql, EXPR_REF, CONDITION_FNS, LOGIC_FNS } from '../pipeline/compute.js';
import { CTX, NAME as CORE_NAME, TASK_READ, READ_PAGE } from '../schema/fields.js';
import { cardTitle } from '../schema/display.js';
import { ES_COLUMNS } from './names.js';

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
    sql: 'a DuckDB statement run on the analysis runtime — code, which this server never takes from a call; declare the data in build_retentioneering_model\'s start instead (its steps, the pipeline\'s SQL stages: which events, what they are named, the attributes and properties carried), and keep rows by a condition after the library\'s steps with filter_events\' where (this tool writes the SQL)',
  },
};

/** The analyses the library offers, in the sheet's order. Read when asked, never at import: a server
 *  with the feature off never opens the sheet. */
export const analysisKinds = () => Object.keys(retentioneeringFacts().analyses);
/** The preprocessing ops offered: every op the library registers, but the ones NOT_OFFERED. */
export const offeredOps = () => Object.keys(retentioneeringFacts().ops).filter((op) => !NOT_OFFERED.ops[op]);

export const NAME = '^[a-z][a-z0-9_]*$';
/** A NEW eventstream's name (start, fork) — bounded as every name the server makes a model of is (the
 *  core's NAME): it goes into the file names of the eventstream's models. */
const NEW_EVENTSTREAM = CORE_NAME;
/** An eventstream a context already holds, as it is named there: an earlier version took names of any
 *  length, and a kept context still holds them — so a reference is held to NAME alone. */
const EVENTSTREAM_REF = NAME;
/** A column of an eventstream: an identifier the warehouse stores (a segment, a path column, a custom one). */
const NAME_OR_COLUMN = '^[A-Za-z_][A-Za-z0-9_]*$';
/** The library's per-path column, which this wrapper names `path` (see pathField). */
const PATH_PARAM = 'path_col';
export const CONDITION_DEF = 'retentioneering_condition';
/** Where the one stage definition is, in this tool's schema as in every tool that takes steps. */
const STAGE_REF = '#/$defs/stage';

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

/** Rows prepared before the paths are read — the one sentence every description that offers from_task
 *  carries: the eventstream reads a source's own rows, or a table build_model made. */
export const COMPLEX_EVENT_LOGIC = 'To prepare the rows first — keep some events, rename, merge or split events (a case over the event and its properties), read an event property or a related model\'s attribute into a column (a compute, a join), a funnel sequence, the events of several sources, a cohort chosen by what its users did — build that table with build_model and start the eventstream from its task (from_task).';

/**
 * WHAT THE BUILD'S STEPS ARE — the library's own steps ({ type }) only, checked as the build is called
 * (build-input.js checkStepPlaces): add_steps / edit_step / insert_step. The rows are prepared before
 * the eventstream reads them — by build_model, its task the start's from_task — so a start takes no
 * steps, and no stage of the pipeline is a step here (a place of the core's shape that takes none).
 */
export const LIBRARY_STEPS = { what: 'the library\'s steps (add_steps, edit_step, insert_step)', takes: 'the library\'s own steps — { type: <op>, …its parameters }', stages: [] };

export function buildSchema(catalog, { project = null } = {}) {
  const sources = pathSources(catalog);
  const f = retentioneeringFacts();
  const column = (description) => ({ type: 'string', pattern: NAME_OR_COLUMN, description });
  // a source's own event and time columns, said where a start may name others
  const own = sources.map((src) => `${src}: ${catalog.eventNameColumn(src)}, ${catalog.getModel(src).time.column}`).join('; ');
  // which column is the event and which its time — a source's own unless named, a task's table's always
  // named (its columns carry no catalog meaning)
  const columns = (required) => ({
    type: 'object', additionalProperties: false, ...(required ? { required: ['event', 'time'] } : { minProperties: 1 }),
    description: required
      ? 'Which columns of the task\'s table are the event name and its time.'
      : `Which columns of the source are the event name and its time, when not its own (${own}) — another time column, say. Events renamed, merged or split are a column build_model makes (from_task).`,
    properties: {
      event: column('The column of the event name.'),
      time: column('The column of the event time (a timestamp or a date) — the paths\' order.'),
    },
  });
  const index = { type: 'integer', minimum: 1, description: 'edit_step / insert_step / delete_step: which step (1-based; insert_step puts the new one before it, or at the end with steps + 1).' };
  return buildForms({
    description: `The eventstream a path analysis reads — the rows of an events source (its own columns, within a window), or of the table a build_model pipeline made (from_task), declared and built in SQL where the data lives; then shaped step by step with the library's own steps, each checked by the library as it is added, and materialized. ${COMPLEX_EVENT_LOGIC} Each library parameter is said in a sentence; its full text is in semantic_index({ request: { guide: "retentioneering" } }) → parameters.`,
    sourceColumns: columns(false),
    properties: {
      action: { enum: BUILD_ACTIONS, description: BUILD_ACTIONS.map((a) => `${a}: ${ACTION_SAYS()[a]}`).join('; ') },
      eventstream: { type: 'string', pattern: EVENTSTREAM_REF, description: 'The eventstream a step action or fork works on (optional when the context holds one).' },
      step: { $ref: STAGE_REF, description: 'edit_step / insert_step: one of the library\'s own steps — { type: <op>, ...its parameters under the library\'s names }.' },
      steps: { type: 'array', minItems: 1, items: { $ref: STAGE_REF }, description: 'add_steps: the library\'s own steps — one or several, applied in order, each { type: <op>, ...its parameters under the library\'s names }.' },
      index,
      after: { type: 'integer', minimum: 0, description: 'truncate: keep steps 1..after (0: none). fork: copy steps 1..after (default: all).' },
      name: { type: 'string', pattern: NEW_EVENTSTREAM, description: 'start: name of this eventstream (lowercase snake_case; a context may hold several, and a later start of the same name replaces it). fork: the new eventstream\'s name.' },
      source: { type: 'string', enum: sources, description: 'The events source the paths are read from. Each path is one user\'s events, in time order; the user key is the one the source declares toward the users model. With from_task: the source that table was built from, when the task does not say it — what its steps read event properties and relationships of.' },
      from_task: {
        type: 'string', pattern: TASK_ID_PATTERN,
        description: 'The task of a finished build_model pipeline materialize (its stages, no semantic_model step) whose stored table holds one row per event — the rows prepared there; the paths are read from it, not recomputed. A semantic layer\'s task, or a metric query\'s (its rows are aggregates), is refused. Name its path column(s) in path and its event and time columns in columns; the time window is the pipeline\'s.',
      },
      columns: columns(true),
      context_id: { type: 'string', pattern: CTX, description: 'Build into this context (it keeps its other eventstreams). Omit to start a new one.' },
      description: { type: 'string', description: 'What this eventstream is for, in your words — kept with this eventstream.' },
      time_range: eventstreamWindow,
      path: {
        type: 'array', minItems: 1, maxItems: 4, uniqueItems: true, items: column('A column of the rows.'),
        description: `What one path is: a column of the rows — one path per value (a bidfloor id: one path per search cycle; a tracking id; a level) — or several, a composite key (the user and a bidfloor id: one path per player per cycle). An event property is a column of a table build_model makes (from_task). Rows without every part are left out. From an events source it may be omitted: one path per user (${[...new Set(sources.map((src) => userKeyColumn(catalog, src)))].join(', ')}); from a task's table it is required.`,
      },
      segments: {
        type: 'array', minItems: 1, uniqueItems: true, items: column('A column of the rows.'),
        description: 'Columns carried on every event as segments, as text, each under its column\'s name — what segment_overview, metric_distribution, diff and in_segment read: a column of the rows (a user attribute or an event property is one of a table build_model joins or computes it into: from_task).',
      },
      top: { type: 'integer', minimum: 1, description: 'Keep only the N most frequent event names and merge the rest into "other" (omit: every event keeps its own name).' },
      sessions: {
        type: 'object', additionalProperties: false, required: ['gap_minutes'],
        description: `Also split each user's path into sessions at gaps longer than gap_minutes, in SQL, so an analysis can read per-session paths (path: "${ES_COLUMNS.session}"). (A split_sessions step splits them by other rules: a timeout, a separator event, bounds.)`,
        properties: { gap_minutes: { type: 'integer', minimum: 1 } },
      },
      sample: (() => {
        const kept = {
          share: { type: 'number', exclusiveMinimum: 0, maximum: 1, description: 'The share of users kept (0 < share ≤ 1).' },
          events: {
            type: 'object', minProperties: 1,
            additionalProperties: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
            description: 'The share of rows kept per event: { "<event>": share } — the event as the rows name it (after a compute that renames events, the new name).',
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
      // what a step action answers with beyond what it changed — the pipeline builder's own list
      include: { type: 'array', uniqueItems: true, items: { enum: ['columns', 'steps'] }, description: 'What else the answer shows: "columns" — the eventstream\'s whole shape after the call, every event, path column, segment with its levels and custom column (by default what the steps changed: the events, path columns and segments added and removed); "steps" — every step of the eventstream, as preview lists them (by default only the steps just added, or the one put in place, and steps_count).' },
    },
    $defs: (() => {
      // THE ONE STAGE DEFINITION, the core's (src/pipeline/stages.js), built for this tool's one place —
      // the library's ops, this tool's runtime group, and no stage of the pipeline — and the one expression
      // (`expr`) built for where this tool's expressions stand: filter_events' where (FILTER_PLACE)
      const defs = stageDefs(catalog, { project, runtime: opSchemas(), places: [LIBRARY_STEPS], exprPlaces: [FILTER_PLACE] });
      return {
        ...defs,
        stage: { ...defs.stage, description: `One of the library's own steps { type: <op>, … }: ${LIBRARY_STEPS.what} take ${LIBRARY_STEPS.takes}.` },
        [CONDITION_DEF]: compactCondition(f.condition_schema),
      };
    })(),
  });
}

/** The build's actions, the pipeline builder's own words for the same moves. */
export const BUILD_ACTIONS = ['start', 'add_steps', 'edit_step', 'insert_step', 'delete_step', 'truncate', 'fork', 'preview', 'materialize'];

/** What each build action does — said once, on the form of that action (and joined for the field that lists them all). */
const ACTION_SAYS = () => ({
  start: 'declares the eventstream and builds it in SQL (a task); the default',
  add_steps: `appends library steps — one or several, all or none — and returns each with what it changed (the events, path columns and segments it added or removed), and steps_count. Each is checked by the library itself on what the eventstream holds before it, so a step the library refuses is refused at once with the library's message (nothing runs). Not offered: ${NOT_OFFERED_OPS()}`,
  edit_step: 'replaces step `index`, re-checking every step after it and naming the first one it breaks',
  insert_step: 'inserts a step before step `index`, re-checking every step after it',
  delete_step: 'removes step `index`, re-checking every step after it',
  truncate: 'keeps steps 1..`after`',
  fork: 'copies steps 1..`after` into a new eventstream (`name`, required), to try a variant without touching this one',
  preview: 'lists every step with what each changed, and the eventstream\'s shape after them',
  materialize: 'runs the steps not yet materialized on the warehouse (a task) — the analyses read the eventstream as materialized',
});

/**
 * The build as forms, one per action (and two for a start: from an events source, or from a task's
 * table) — each with exactly its own fields, so a stray one is refused rather than ignored. `schema`
 * carries every field (`properties`), the build's description and its `$defs`.
 *
 * Both starts take the same fields — the rows' steps (the pipeline's SQL stages: `startSteps`), their
 * path, segments and event names — and differ where the rows come from: an events source names its own
 * event and time columns (`columns` only when a stage made others: `sourceColumns`) and takes a window, a
 * task's table names its path and its columns always (its columns carry no catalog meaning) and was
 * bounded by the pipeline that made it. The actions that change the steps answer with what changed, and
 * take the pipeline builder's list for more (`include`: columns, steps).
 */
function buildForms(schema) {
  const { properties: F, description, sourceColumns, $defs } = schema;
  const action = (value) => ({ tag: ['action', value], tagDescription: [].concat(value).map((a) => `${a}: ${ACTION_SAYS()[a]}`).join('; ') });
  const declaration = ['context_id', 'name', 'description', 'path', 'segments', 'top', 'sessions', 'sample'];
  const echo = ['include'];
  // a step names the context its eventstream is in — a start may omit it (a new context), a step may not
  const stepContext = { ...F.context_id, description: 'The context the eventstream is in — the context_id start returned.' };
  const step = (value, title, required, optional = []) => form({ title, ...action(value), required: ['context_id', ...required], properties: { ...pick(F, ['context_id', 'eventstream', ...required, ...optional]), context_id: stepContext } });
  return {
    type: 'object',
    description,
    anyOf: [
      form({ title: 'start from an events source', ...action('start'), optionalTag: true, required: ['name', 'source'], properties: { ...pick(F, ['source', 'time_range', ...declaration]), columns: sourceColumns } }),
      form({ title: 'start from a task\'s table', ...action('start'), optionalTag: true, required: ['name', 'from_task', 'path', 'columns'], properties: pick(F, ['from_task', 'source', 'columns', ...declaration]) }),
      step('add_steps', 'add steps', ['steps'], echo),
      step(['edit_step', 'insert_step'], 'edit or insert a step', ['index', 'step'], echo),
      step('delete_step', 'delete a step', ['index'], echo),
      step('truncate', 'truncate the steps', ['after'], echo),
      step('fork', 'fork the eventstream', ['name'], ['after', 'description', ...echo]),
      step(['preview', 'materialize'], 'preview or materialize', []),
    ],
    ...($defs ? { $defs } : {}),
  };
}

/** Whose paths: the wrapper's name for the library's path column — a path column of the eventstream,
 *  as its shape lists them (`paths`), spelled as it is there. */
const pathField = () => ({
  type: 'string', pattern: NAME_OR_COLUMN,
  description: `Whose paths: a path column of the eventstream, as its shape lists them (paths) — ${ES_COLUMNS.user} (the default), the build's path key: the user, unless start named another path; ${ES_COLUMNS.session} when the build split sessions; or the session column a split_sessions step made (a step of this eventstream before this one, or one materialized).`,
});

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

// a docstring's first sentence: the one reader, the refusals' (src/validate.js)
export { firstSentence };

/** A library parameter as a schema property: its type, its default, its docstring's first sentence. */
function param(p) {
  // a parameter written in the path-pattern language points at its grammar, which the guide carries
  const said = p.doc ? firstSentence(p.doc) : '';
  const doc = said && takesPathPattern(p) ? `${said} The grammar: semantic_index({ request: { guide: "retentioneering" } }) → path_patterns.` : said;
  return { ...p.schema, ...(p.default !== undefined ? { default: p.default } : {}), ...(doc ? { description: doc } : {}) };
}

/**
 * Which value goes with which `op` of a path-metric condition — the pairing the one form per metric
 * (compactCondition) leaves to the value: membership a list of constants, every comparison one. Checked
 * wherever a condition is written (a build's steps, a query's analyses), before the library sees it.
 */
export function checkConditionPairs(node, field) {
  const { membership } = retentioneeringFacts().condition;
  const walk = (n, at) => {
    if (Array.isArray(n)) { n.forEach((x, i) => walk(x, `${at}[${i}]`)); return; }
    if (!n || typeof n !== 'object') return;
    if (typeof n.metric === 'string' && typeof n.op === 'string' && 'value' in n && (n.op === membership) !== Array.isArray(n.value)) {
      throw new ToolError(`${at}: op "${n.op}" takes ${n.op === membership ? 'a list of constants' : 'one constant'} as its value — ${n.op === membership ? `a single one is { op: "=", … }, or [${JSON.stringify(n.value)}]` : `a list is op "${membership}"`}`, { stage: 'validate', field: at });
    }
    for (const [k, v] of Object.entries(n)) walk(v, `${at}.${k}`);
  };
  walk(node, field);
}

/**
 * The path-metric condition, one form per metric: the sheet writes a comparison (one constant) and a
 * membership (a list) as two forms of each metric — the same metric, its own arguments, twice. Here they
 * are one: `op` any of the grammar's, the value a constant or a list of them; which goes with which is
 * the library's to say, and its check refuses the other pairing when the step is added.
 */
export function compactCondition(schema) {
  const byMetric = new Map();
  const rest = [];
  for (const b of schema.anyOf || []) {
    const metric = b.properties?.metric?.const;
    if (metric === undefined) { rest.push(b); continue; }
    const seen = byMetric.get(metric);
    if (!seen) { byMetric.set(metric, { ...b, title: metric, properties: { ...b.properties } }); continue; }
    const ops = (x) => (x.const !== undefined ? [x.const] : x.enum);
    seen.properties.op = { enum: [...ops(seen.properties.op), ...ops(b.properties.op)] };
    const values = [seen.properties.value, b.properties.value].map(({ description, ...v }) => v);
    seen.properties.value = { anyOf: values, description: `${seen.properties.value.description || ''} A list of them with in.`.trim() };
  }
  return { ...schema, anyOf: [...byMetric.values(), ...rest] };
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

/**
 * filter_events' where — a where over rows without a payload: the eventstream's own columns. It is
 * written in the ONE expression (`$defs.expr`, src/pipeline/compute.js), and what it takes of it is a
 * place of this tool's own: a column, a constant, the current time; the conditions and and / or / not —
 * no scalar function (a value computed from columns is a column build_model makes, where the rows are
 * prepared), no event property (the eventstream carries columns), no window and no raw SQL: the library
 * runs what this tool writes, and SQL a call brings is code (NOT_OFFERED.params.sql). The tool's
 * `$defs.expr` is built for this place alone, so it carries only these forms.
 */
export const FILTER_PLACE = {
  what: 'filter_events\' where', leaves: ['column', 'value', 'now'], fns: [...CONDITION_FNS, ...LOGIC_FNS], windows: false,
  hint: 'A column is one the eventstream has at this step, compared with constants; a value computed from columns, or an event property, is a column of a table build_model makes (the start\'s from_task)',
};

/** filter_events' where: a condition slot of the one expression — a list that all hold, as every where. */
function rowConditionSchema() {
  return conditionSlot(EXPR_REF, 'Keep only the rows where every condition holds — a comparison, a range, a membership, a text test, a missing value (is_null), and / or / not over them — of a column the eventstream has at this step ({ column }: the event, its time, a path column, a segment, a custom column) with constants ({ value }) (what keep / drop cannot say: they match listed values only). A column compared with constants is read as their kind, whatever it is stored as (a segment is text: a threshold on it is a number\'s). A comparison with a missing value does not hold — neq, not_in and not_like too (present and different); not(…) holds wherever its condition does not, a missing value included, as drop does. This tool writes the SQL the library runs, its names and constants quoted. Instead of keep / drop, not with them.');
}

/** A row condition as the library's `sql` for filter_events: SELECT * FROM eventstream WHERE …, written
 *  by the one writer for DuckDB at this filter's place — every column quoted, every constant a literal,
 *  so the caller's input stays data. A column compared with constants is read as their kind
 *  (castToConstant: a segment is stored as text, and a threshold on it is a number's), and a comparison
 *  with a missing value holds for no row, as it holds nowhere else; not(…) is what keeps one. */
function whereToSql(where, field) {
  let preds;
  try {
    preds = conditionListSql(DUCKDB, null, where, field, { castToConstant: true, place: FILTER_PLACE });
  } catch (e) {
    throw new ToolError(e?.message || String(e), { stage: 'validate', field });
  }
  return `SELECT * FROM eventstream WHERE ${preds.map((s) => `(${s})`).join(' AND ')}`;
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
    if (p.name === PATH_PARAM) { properties.path = pathField(); continue; }
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

/** The library's own steps ({ type: <op>, ...its parameters }) — an eventstream's steps, this tool's
 *  runtime group of the one stage definition. */
function opSchemas() {
  const f = retentioneeringFacts();
  return offeredOps().flatMap((op) => {
    const { properties, required, variants } = params(f.ops[op].params);
    for (const [name, a] of Object.entries(ADDED[op] || {})) properties[name] = a.schema();
    return callableForms({ tag: ['type', op], title: op, description: f.ops[op].summary, properties, required, variants });
  });
}

/** The ops left out, each with its reason — said wherever steps are offered. */
const NOT_OFFERED_OPS = () => Object.entries(NOT_OFFERED.ops).map(([op, why]) => `${op} (${why})`).join('; ');

const METHOD_ARGS_NOTE = 'the method\'s own arguments';

function analysisSchemas() {
  const f = retentioneeringFacts();
  const name = { type: 'string', pattern: NAME, description: 'Your name for this analysis in the result (default: its kind) — what a read lists it under and display_retentioneering_result draws it by. Unique within the call.' };
  return analysisKinds().flatMap((kind) => {
    const a = f.analyses[kind];
    const { properties, required, variants } = params(a.params);
    return callableForms({
      tag: ['kind', kind], title: kind,
      description: `${a.summary}${CARD_KINDS.includes(kind) ? '' : ' (returned as tables, answered in words: it has no card)'}`,
      properties: { name, ...properties }, required, variants,
      // an anchor and a path pattern are two ways to centre the same steps: one or the other
      exclusive: ['anchor', 'path_pattern'],
    });
  });
}

export function querySchema() {
  const f = retentioneeringFacts();
  const F = {
    context_id: { type: 'string', pattern: CTX, description: 'The context the eventstream was built in.' },
    eventstream: { type: 'string', pattern: EVENTSTREAM_REF, description: 'Which eventstream of the context (optional when it holds one).' },
    analyses: { type: 'array', minItems: 1, items: { anyOf: analysisSchemas() }, description: 'The analyses to run, computed together in one run.' },
    // a read is the core's (src/schema/fields.js TASK_READ), paged as the other query tools page theirs:
    // here each table of each analysis, by its row numbers
    ...TASK_READ,
    offset: { type: 'integer', minimum: 0, description: 'The row each table\'s page starts at — of every table of each task\'s result (an analysis\'s transitions, its step shares, its groups\' metrics, the library\'s tables; a build\'s segment levels): 0 is its first row, next_offset where the previous page ended.' },
    limit: { type: 'integer', minimum: 1, maximum: 100000, description: `How many rows of each table the page holds (default ${READ_PAGE}).` },
  };
  return {
    type: 'object',
    description: 'Start path analyses over a built eventstream (its materialized steps included), or read one back.',
    anyOf: [
      form({ title: 'start analyses', required: ['context_id', 'analyses'], properties: pick(F, ['context_id', 'eventstream', 'analyses']) }),
      form({ title: 'read tasks', required: ['task_ids'], properties: pick(F, ['task_ids', 'wait_seconds', 'offset', 'limit']) }),
      form({ title: 'cancel tasks', required: ['task_ids', 'cancel'], properties: pick(F, ['task_ids', 'cancel']) }),
    ],
    $defs: { [CONDITION_DEF]: compactCondition(f.condition_schema) },
  };
}

/** The display, in the one shape a card is asked for — { task_id, display }, as display_model_result
 *  takes it: the task, and what its card draws. */
export function displaySchema() {
  const f = retentioneeringFacts();
  return {
    type: 'object', additionalProperties: false, required: ['task_id', 'display'],
    description: 'Draw one analysis of a finished task as a card.',
    properties: {
      task_id: { type: 'string', pattern: TASK_ID_PATTERN, description: 'A finished query_retentioneering_model task (its task_id).' },
      display: {
        type: 'object', additionalProperties: false, required: ['analysis'],
        description: 'What the card draws: one analysis of the task, under a title of yours.',
        properties: {
          analysis: { type: 'string', pattern: NAME, description: 'Which analysis of the task: its name — the kind, unless you named it.' },
          title: cardTitle,
          edge_weight: { enum: f.edge_weights, description: 'transition_graph: the weight the graph opens on (default proba_out); the card switches between all of them.' },
        },
      },
    },
  };
}

/** delete_context's form for an eventstream — the kind of build a path-analysis context holds, removed
 *  as the core's are (src/features.js deletes): `what` pinned, its context and the eventstream named. */
export function deleteSchema() {
  return form({
    title: 'one eventstream',
    tag: ['what', 'eventstream'],
    tagDescription: 'eventstream: remove one eventstream of a path-analysis context and keep the context (its tables stay until the context is dropped, so the tasks that built and read it still read back).',
    required: ['context_id', 'eventstream'],
    properties: {
      context_id: { type: 'string', pattern: CTX, description: 'The path-analysis context the eventstream is in (the context_id build_retentioneering_model returned).' },
      eventstream: { type: 'string', pattern: EVENTSTREAM_REF, description: 'Which eventstream of the context, by its name.' },
    },
  });
}
