// THE RETENTIONEERING FEATURE'S TOOL SCHEMAS. Every choice the library decides — the analyses and
// their parameters, the edge weights, the path metrics and how each rolls up, the clustering methods
// and scalers, the anchor occurrences — is rendered from config/retentioneering-facts.json, the
// sheet scripts/retentioneering-facts.py extracts from the installed library; nothing here restates
// one from the library's prose. What the CATALOG decides (the events sources, the models a segment
// can come from) comes from the catalog. Event names are checked against the source at call time,
// so a schema never carries a source's whole vocabulary.

import { readFileSync } from 'node:fs';
import { assetPath, missingAssetMessage } from '../runtime-assets.js';
import { MAX_WAIT_SECONDS } from '../schema.js';

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

/** A parameter's default as the library declares it, from the sheet. */
export function libraryDefault(fn, param) {
  return retentioneeringFacts().data_functions[fn]?.find((p) => p.name === param)?.default;
}

export const ANALYSIS_KINDS = ['transition_graph', 'step_matrix', 'step_sankey', 'funnel', 'cluster_analysis', 'segment_overview'];
export const NAME = '^[a-z][a-z0-9_]{0,40}$';
const CTX = '^[A-Za-z0-9_-]{1,64}$';
export const MAX_STEPS = 30;
/** One call computes every analysis it lists in one run: up to one of each kind. */
export const MAX_ANALYSES = 6;

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

export function buildSchema(catalog) {
  const sources = pathSources(catalog);
  const joinable = catalog.joinableModelKeys();
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
          include: { type: 'array', minItems: 1, items: { type: 'string' }, description: 'Keep only these events of the source (omit: every event).' },
          exclude: { type: 'array', minItems: 1, items: { type: 'string' }, description: 'Drop these events (technical noise the paths should not show).' },
          groups: { type: 'object', additionalProperties: { type: 'array', minItems: 1, items: { type: 'string' } }, description: 'Merge several events under one name: { "<new name>": ["<event>", …] }. A group name replaces its events in every analysis.' },
          top: { type: 'integer', minimum: 2, description: 'Optional: keep only the N most frequent event names (after grouping) and merge the rest into "other". Omitted, every event keeps its own name.' },
        },
      },
      segments: {
        type: 'array', maxItems: 5,
        description: 'User attributes to carry on every event as segment columns — what segment_overview splits by. Each comes from a model the source reaches by a declared relationship.',
        items: {
          type: 'object', additionalProperties: false, required: ['model', 'attribute'],
          properties: {
            model: { type: 'string', enum: joinable, description: 'The model that carries the attribute (e.g. the users model).' },
            attribute: { type: 'string', description: 'A column of that model (semantic_index({ model }) lists them).' },
            via: { type: 'string', description: 'The relationship to reach it by, when the source declares several toward that model.' },
            as: { type: 'string', pattern: NAME, description: 'Name of the segment column (default: the attribute).' },
          },
        },
      },
      where: {
        type: 'array', minItems: 1,
        description: 'Keep only the events of users matching every condition, on the segment columns declared above.',
        items: {
          type: 'object', additionalProperties: false, required: ['column', 'op'],
          properties: {
            column: { type: 'string', description: 'A segment column (its `as` or attribute name).' },
            op: { enum: ['eq', 'neq', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte', 'is_null', 'is_not_null'] },
            value: { description: 'The constant (an array for in/not_in; none for is_null/is_not_null).' },
          },
        },
      },
      sessions: {
        type: 'object', additionalProperties: false, required: ['gap_minutes'],
        description: 'Also split each user\'s path into sessions at gaps longer than gap_minutes, so an analysis can read per-session paths (path: "sessions").',
        properties: { gap_minutes: { type: 'integer', minimum: 1, maximum: 1440 } },
      },
      sample: {
        type: 'object', additionalProperties: false, required: ['share'],
        description: 'Keep a share of USERS (all of each kept user\'s events), chosen by a hash of the user key: the same users on every build. Use it to keep a large source within what one analysis run holds in memory.',
        properties: { share: { type: 'number', exclusiveMinimum: 0, maximum: 1 } },
      },
    },
  };
}

function analysisSchemas() {
  const f = retentioneeringFacts();
  const path = { enum: ['users', 'sessions'], default: 'users', description: 'Whose paths: each user\'s whole history (default), or each session (needs sessions in the build).' };
  const id = { type: 'string', pattern: NAME, description: 'Your name for this analysis in the result (default: its kind). Unique within the call.' };
  const metric = {
    type: 'object', additionalProperties: false, required: ['metric'],
    properties: {
      metric: { enum: f.path_metrics, description: 'A per-path metric of the library (length, duration, event_count, has_event, …_bulk for one column per event, time_between, matches_pattern, …).' },
      metric_args: { type: 'object', description: 'The metric\'s arguments, as the library names them (event, events, start_event/end_event, pattern, …).' },
    },
  };
  const metricAgg = { ...metric, required: ['metric', 'agg'], properties: { ...metric.properties, agg: { enum: f.segment_aggs, description: 'How per-path values roll up across a group.' } } };
  const steps = (kind, what) => ({
    type: 'object', additionalProperties: false, required: ['kind'],
    title: kind,
    description: what,
    not: { required: ['anchor', 'path_pattern'] },
    properties: {
      kind: { const: kind }, id, path,
      max_steps: { type: 'integer', minimum: 1, maximum: MAX_STEPS, default: libraryDefault('step_sankey_data', 'max_steps'), description: 'How many steps to compute (on each side of an anchor).' },
      anchor: {
        type: 'object', additionalProperties: false, required: ['pattern'],
        description: 'Centre the steps on one position of each path: the paths where it does not occur are left out.',
        properties: {
          pattern: { type: 'string', description: 'An event, or a "->"-separated sequence of events.' },
          occurrence: { enum: f.anchor_occurrences.filter((o) => o !== 'all'), description: 'Which occurrence in a path (default first).' },
          offset: { type: 'integer', description: 'Shift the anchor by this many events.' },
        },
      },
      path_pattern: { type: 'string', description: 'Restrict and split the paths on a "->"-separated sequence ("a->.*->b"); each anchor event of the pattern gets its own block.' },
    },
  });
  return [
    {
      type: 'object', additionalProperties: false, required: ['kind'], title: 'transition_graph',
      description: 'Which event follows which: every transition with all its weights at once (count, unique_paths, share_of_total, avg_per_path, proba_in, proba_out, time_median, time_q95), and the library\'s layout of the events.',
      properties: { kind: { const: 'transition_graph' }, id, path },
    },
    steps('step_matrix', 'The share of paths at each event, step by step from the start (or around an anchor) — drawn as a heatmap.'),
    steps('step_sankey', 'The same per-step shares drawn as flows between steps.'),
    {
      type: 'object', additionalProperties: false, required: ['kind', 'steps'], title: 'funnel',
      description: 'How many paths reach each event of an ordered list, and the conversion step to step.',
      properties: { kind: { const: 'funnel' }, id, path, steps: { type: 'array', minItems: 2, maxItems: 12, items: { type: 'string' }, description: 'The events, in order.' } },
    },
    {
      type: 'object', additionalProperties: false, required: ['kind'], title: 'cluster_analysis',
      description: 'Groups of similar paths, from per-path metrics, with each group\'s size and profile.',
      properties: {
        kind: { const: 'cluster_analysis' }, id, path,
        features: { type: 'array', minItems: 1, items: metric, description: 'The per-path metrics paths are clustered on (default: event_count_bulk — how often each event occurs).' },
        method: { enum: f.cluster_methods, description: 'The clustering method (default kmeans).' },
        n_clusters: { oneOf: [{ type: 'integer', minimum: 2, maximum: 20 }, { type: 'array', minItems: 2, maxItems: 10, items: { type: 'integer', minimum: 2, maximum: 20 } }], description: 'kmeans: the number of clusters, or several to try — the best silhouette wins (default: the library\'s range).' },
        min_cluster_size: { type: 'integer', minimum: 2, description: 'hdbscan: the smallest group it forms.' },
        scaler: { enum: f.cluster_scalers, description: 'How features are scaled before clustering (default minmax).' },
        overview_metrics: { type: 'array', minItems: 1, items: metricAgg, description: 'What each cluster\'s profile shows (default: length, duration and the share of paths with each event).' },
      },
    },
    {
      type: 'object', additionalProperties: false, required: ['kind', 'segment'], title: 'segment_overview',
      description: 'Per-path metrics compared across the levels of a segment column of the eventstream.',
      properties: {
        kind: { const: 'segment_overview' }, id, path,
        segment: { type: 'string', description: 'A segment column the eventstream was built with.' },
        metrics: { type: 'array', minItems: 1, items: metricAgg, description: 'The metrics to compare (default: length and duration).' },
      },
    },
  ];
}

export function querySchema() {
  return {
    type: 'object', additionalProperties: false,
    description: 'Start path analyses over a built eventstream, or read one back.',
    allOf: [
      { if: { required: ['analyses'] }, then: { required: ['context_id'] } },
    ],
    properties: {
      context_id: { type: 'string', pattern: CTX, description: 'The context the eventstream was built in.' },
      eventstream: { type: 'string', pattern: NAME, description: 'Which eventstream of the context (optional when it holds one).' },
      analyses: { type: 'array', minItems: 1, maxItems: MAX_ANALYSES, items: { oneOf: analysisSchemas(), discriminator: { propertyName: 'kind' } }, description: `The analyses to run — up to ${MAX_ANALYSES}, computed together in one run.` },
      task_id: TASK_ID,
      task_ids: { type: 'array', minItems: 1, maxItems: 20, items: TASK_ID, description: 'Several tasks, read together.' },
      cancel: { type: 'boolean', description: 'With task_id / task_ids: stop them.' },
      wait_seconds: { type: 'integer', minimum: 0, maximum: MAX_WAIT_SECONDS, description: `How long to wait for a running task (default and cap ${MAX_WAIT_SECONDS}s).` },
    },
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
