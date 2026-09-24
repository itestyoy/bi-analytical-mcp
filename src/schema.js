// Build JSON Schemas for the tools, with enums projected from the catalog.
// Everything that names a column/property/event/attribute is an enum -> an AI
// literally cannot submit an unknown name (validated by ajv at the boundary).
//
// Every property carries a `description` so the meaning/purpose of each
// parameter is self-explanatory to the MCP client (the AI) without external docs.

import { pipelineStageSchema, stageDefs } from './pipeline.js';
import { strEnum, oneOfOr, withoutEmpty } from './schema-kit.js';
import { DRILL_ROWS } from './apps/result-view-model.js'; // the most rows one view of a drill-down card reads

const NAME = '^[a-z][a-z0-9_]{0,40}$';
const TASK = '^[a-z][a-z0-9_]{2,40}$';
const CTX = '^[a-z0-9]{6,40}$';
const TASK_ID = '^[a-f0-9]{12}$'; // what src/jobs.js hands out
const WINDOW = '^[0-9]+ (second|minute|hour|day|week|month|quarter|year)s?$';

// Reusable property-description strings (kept consistent across tools).
const D = {
  context_id: 'ID of the isolated execution context to operate in. Omit on create to start a NEW, isolated context; pass an existing id to extend or query that same context. Each context is fully isolated, so parallel tasks never collide.',
  measure_name: 'Unique measure name within the task (lowercase snake_case). Referenced by metrics; the final queryable name is prefixed with the task, e.g. task_<name>.',
  agg: 'Aggregation applied to `field` to form the measure: count (rows), count_distinct (unique values of an entity key — required for conversion/funnel user counts), sum, average, median, min, max, percentile (needs `percentile`), sum_boolean (counts rows where a boolean/condition holds).',
  percentile: 'Percentile in (0,1), e.g. 0.95 for p95. Required when agg=percentile.',
  label: 'Human-readable label shown in BI tools / metadata. Defaults to the name when omitted.',
  event_name: 'Event scope for THIS measure: only rows whose event_name is in this list are aggregated. This is how a funnel/conversion step is pinned to a specific event. Overrides the semantic model\'s event_scope.',
  where_measure: 'Per-measure conditions on event_data JSON properties, ANDed with the event scope. Used to define a funnel step as event + property value (e.g. event_name=tutorial AND step_id=step_1).',
};

function whereItemSchema(catalog, modelKey) {
  return {
    type: 'object', additionalProperties: false, required: ['property', 'op'],
    description: 'One condition on a SCALAR event_data property (array/struct properties must be reduced via a prepare stage first).',
    properties: {
      property: strEnum(catalog.scalarEventProps(modelKey), `Scalar event_data property to test. NB: each property is only populated on specific events (see semantic_index({ source: '${modelKey}', event })); scope the measure to those event_name(s) or it reads NULL.`),
      op: { enum: ['eq', 'neq', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte'], description: 'Comparison operator. Use in/not_in with an array value; the rest take a scalar.' },
      value: { description: 'Literal value(s) to compare against. Scalar for eq/neq/gt/gte/lt/lte; array for in/not_in.' },
    },
  };
}

function measureFieldSchema(catalog, modelKey) {
  const opts = [{ enum: ['*'], title: 'rows' }];
  const keys = catalog.entityKeyColumns(modelKey);
  if (keys.length) opts.push({ type: 'string', enum: keys, title: 'entity_key' });
  if (catalog.isFact(modelKey)) {
    const props = catalog.scalarEventProps(modelKey);
    if (props.length) opts.push({ type: 'string', enum: props, title: 'event_property' });
  }
  // Amounts the schema marks aggregatable on this model. They carry NO aggregation of their
  // own — pick the function that answers the question in `agg`.
  const amounts = catalog.aggregatableFields(modelKey).map((a) => a.name);
  if (amounts.length) opts.push({ type: 'string', enum: amounts, title: 'amount' });
  return { description: 'What to aggregate: "*" (count rows), an entity-key column (for count_distinct of users/sessions), an event_data property, or an AMOUNT the schema marks aggregatable on this source. An amount fixes no function — choose the one the question needs in `agg` (sum / average / max / median / percentile / …). A STRING field that holds numbers needs "cast":"numeric" to sum/average it.', oneOf: opts };
}

function dimensionItemSchema(catalog, modelKey) {
  const branches = [];
  const cols = catalog.modelDimensionColumns(modelKey);
  if (cols.length) {
    branches.push({
      title: 'model_column',
      type: 'object',
      additionalProperties: false,
      required: ['source', 'column'],
      description: 'A dimension taken directly from a physical column of the model.',
      properties: {
        source: { enum: ['model_column'], description: 'Use a physical table column as the dimension.' },
        column: { type: 'string', enum: cols, description: 'Physical column name to expose as a dimension.' },
        as_type: { enum: ['categorical', 'time'], default: 'categorical', description: 'Whether to treat the column as a categorical attribute or a time dimension (enables time grains).' },
        grain: { enum: catalog.timeGranularities(), description: 'Time granularity when as_type=time (day/week/month/quarter/year).' },
        label: { type: 'string', description: D.label },
      },
    });
  }
  if (catalog.isFact(modelKey)) {
    branches.push({
      title: 'event_property',
      type: 'object',
      additionalProperties: false,
      required: ['source', 'property'],
      description: 'A dimension taken from an event_data property (e.g. level_id, product_id) so you can group/filter by it.',
      properties: {
        source: { enum: ['event_property'], description: 'Take the dimension from an event_data property.' },
        property: strEnum(catalog.scalarEventProps(modelKey), `Scalar event_data property to expose as a dimension. NB: only populated on specific events (see semantic_index({ source: '${modelKey}', event })); NULL on others.`),
        as_type: { enum: ['categorical'], default: 'categorical', description: 'event_data dimensions are always categorical.' },
        label: { type: 'string', description: D.label },
      },
    });
  }
  // A model with no groupable column and no payload has NO dimension to add: the field is left
  // out of its branch rather than offered as a choice with no options.
  return oneOfOr(branches, { type: 'object', description: 'A dimension to add to the semantic model (a column or an event_data property) for grouping/filtering.' });
}

// Generic (model-agnostic) item schemas for `update`, where the target model is
// already fixed by `semantic_model`. Field names are still catalog-constrained;
// exact model/field coupling is re-checked in compile.
function genericMeasureField(catalog) {
  const opts = [{ enum: ['*'], title: 'rows' }];
  const keys = [...new Set(catalog.modelKeys().flatMap((k) => catalog.entityKeyColumns(k)))];
  if (keys.length) opts.push({ type: 'string', enum: keys, title: 'entity_key' });
  const props = catalog.scalarEventPropEnum();
  if (props.length) opts.push({ type: 'string', enum: props, title: 'event_property' });
  const amounts = catalog.aggregatableFieldNames();
  if (amounts.length) opts.push({ type: 'string', enum: amounts, title: 'amount' });
  return { description: 'What to aggregate: "*", an entity-key column, a numeric event_data property, or an AMOUNT the schema marks aggregatable — all of the target semantic model\'s own source. An amount fixes no function; choose it in `agg`.', oneOf: opts };
}

function genericWhereItem(catalog) {
  const item = whereItemSchema(catalog, catalog.facts[0]); // shape only — the enum is replaced below
  item.properties.property = strEnum(catalog.scalarEventPropEnum(), 'Scalar event_data property of the target semantic model\'s own source. NB: each property is only populated on specific events; scope the measure to those event_name(s) or it reads NULL.');
  return item;
}

function genericMeasureItem(catalog) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'agg'],
    description: 'A measure to add to the target semantic model.',
    properties: {
      name: { type: 'string', pattern: NAME, description: D.measure_name },
      agg: { enum: ['count', 'count_distinct', 'sum', 'average', 'median', 'min', 'max', 'percentile', 'sum_boolean'], description: D.agg },
      field: genericMeasureField(catalog),
      percentile: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1, description: D.percentile },
      cast: { enum: ['numeric', 'int', 'float'], description: 'Cast the field to a numeric type before aggregating — needed to sum/average a STRING property that holds numbers (e.g. complete_time).' },
      label: { type: 'string', description: D.label },
      event_name: { type: 'array', minItems: 1, items: strEnum(catalog.eventNameEnum()), description: D.event_name },
      where: { type: 'array', description: D.where_measure, items: genericWhereItem(catalog) },
    },
    allOf: [{ if: { properties: { agg: { const: 'percentile' } } }, then: { required: ['percentile'] } }],
  };
}

function genericDimensionItem(catalog) {
  const cols = [...new Set(catalog.modelKeys().flatMap((k) => catalog.modelDimensionColumns(k)))];
  return {
    type: 'object',
    description: 'A dimension to add to the target semantic model (a column or an event_data property).',
    oneOf: [
      { title: 'model_column', type: 'object', additionalProperties: false, required: ['source', 'column'], description: 'Dimension from a physical column.', properties: { source: { enum: ['model_column'], description: 'Use a physical table column.' }, column: strEnum(cols, 'Physical column name.'), as_type: { enum: ['categorical', 'time'], description: 'Categorical attribute or time dimension.' }, grain: { enum: catalog.timeGranularities(), description: 'Time grain when as_type=time.' }, label: { type: 'string', description: D.label } } },
      { title: 'event_property', type: 'object', additionalProperties: false, required: ['source', 'property'], description: 'Dimension from a scalar event_data JSON property.', properties: { source: { enum: ['event_property'], description: 'Extract from event_data JSON.' }, property: strEnum(catalog.scalarEventPropEnum(), 'Scalar event_data property of the target semantic model\'s own source. NB: only populated on specific events (see semantic_index({ source, event })); NULL on others.'), as_type: { enum: ['categorical'], description: 'Always categorical.' }, label: { type: 'string', description: D.label } } },
    ],
  };
}

function measureItemSchema(catalog, modelKey) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'agg'],
    description: 'A measure: an aggregation over the model, optionally scoped to specific events / property values (the building block of funnel steps and metrics).',
    properties: {
      name: { type: 'string', pattern: NAME, description: D.measure_name },
      agg: { enum: ['count', 'count_distinct', 'sum', 'average', 'median', 'min', 'max', 'percentile', 'sum_boolean'], description: D.agg },
      field: measureFieldSchema(catalog, modelKey),
      percentile: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1, description: D.percentile },
      cast: { enum: ['numeric', 'int', 'float'], description: 'Cast the field to a numeric type before aggregating — needed to sum/average a STRING property that holds numbers (e.g. complete_time).' },
      label: { type: 'string', description: D.label },
      ...(catalog.isFact(modelKey)
        ? {
            event_name: { type: 'array', minItems: 1, items: strEnum(catalog.eventNames(modelKey)), description: D.event_name },
            where: {
              type: 'array',
              description: D.where_measure,
              items: whereItemSchema(catalog, modelKey),
            },
          }
        : {}),
    },
    allOf: [
      { if: { properties: { agg: { const: 'percentile' } } }, then: { required: ['percentile'] } },
    ],
  };
}

function semanticModelBranch(catalog, modelKey) {
  const dimItem = dimensionItemSchema(catalog, modelKey);
  const props = withoutEmpty({
    from: { enum: [modelKey], description: `Source model this semantic model is built from ("${modelKey}").` },
    dimensions: dimItem && { type: 'array', items: dimItem, description: 'Dimensions (columns or event_data properties) to expose for grouping/filtering.' },
    measures: { type: 'array', items: measureItemSchema(catalog, modelKey), description: 'Measures (aggregations) defined on this model; metrics reference these by name.' },
  });
  if (catalog.isFact(modelKey)) {
    props.event_scope = {
      type: 'object',
      additionalProperties: false,
      description: 'Default event filter applied to ALL measures in this semantic model (each measure can still narrow further via its own event_name). Use when the whole task concerns one event type.',
      properties: {
        event_name: { type: 'array', minItems: 1, items: strEnum(catalog.eventNames(modelKey)), description: 'Events that scope every measure here.' },
      },
    };
  }
  return { type: 'object', additionalProperties: false, required: ['from'], description: `Semantic model built on the "${modelKey}" model.`, properties: props };
}

function metricSchema() {
  const measureRef = {
    type: 'object',
    additionalProperties: false,
    required: ['name'],
    description: 'Reference to a measure by name.',
    properties: { name: { type: 'string', description: 'Name of a measure defined in this task.' } },
  };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'type'],
    description: 'A metric: the queryable quantity. simple wraps one measure; ratio = numerator/denominator; cumulative accumulates a measure over time; derived computes an expression over other metrics; conversion = share of a base population that later did a conversion event within a window.',
    properties: {
      name: { type: 'string', pattern: NAME, description: 'Unique metric name (lowercase snake_case). Queried as task_<name>.' },
      type: { enum: ['simple', 'ratio', 'cumulative', 'derived', 'conversion'], description: 'Metric kind — determines which of the fields below are required.' },
      label: { type: 'string', description: D.label },
      measure: { ...measureRef, description: 'simple/cumulative: the single measure this metric exposes.' },
      fill_nulls_with: { type: 'number', description: 'Value to substitute for NULL results (e.g. 0) so gaps in a time series render as zeros.' },
      numerator: { ...measureRef, description: 'ratio: the measure on top of the division.' },
      denominator: { ...measureRef, description: 'ratio: the measure on the bottom of the division.' },
      window: { type: 'string', pattern: WINDOW, description: 'conversion: time window in which the conversion must occur after the base event, e.g. "1 day", "7 day", "1 week".' },
      grain_to_date: { enum: ['day', 'week', 'month', 'quarter', 'year'], description: 'cumulative: reset accumulation at the start of each period (e.g. month-to-date).' },
      period_agg: { enum: ['first', 'last', 'average'], description: 'cumulative: how to collapse multiple values within a period.' },
      expr: { type: 'string', description: 'derived: arithmetic expression over the input metrics, e.g. "coins_in - coins_out". Restricted to a safe arithmetic grammar (the referenced metric aliases + basic math functions).' },
      metrics: { type: 'array', description: 'derived: the input metrics referenced by `expr`.', items: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string', description: 'Name of an input metric.' }, alias: { type: 'string', description: 'Optional alias to use for this metric inside `expr`.' } } } },
      base_measure: { ...measureRef, description: 'conversion: the starting population (must be count_distinct of an entity), e.g. users who launched.' },
      conversion_measure: { ...measureRef, description: 'conversion: the converted population (count_distinct of the same entity), e.g. users who purchased.' },
      entity: { type: 'string', description: 'conversion: the entity linking base and conversion events (e.g. "user").' },
      calculation: { enum: ['conversion_rate', 'conversion'], description: 'conversion: return the rate (converted/base, default) or the raw converted count.' },
      constant_properties: { type: 'array', items: { type: 'string' }, description: 'conversion: properties that must match between the base and conversion events (e.g. same product_id).' },
    },
    allOf: [
      { if: { properties: { type: { const: 'simple' } } }, then: { required: ['measure'] } },
      { if: { properties: { type: { const: 'ratio' } } }, then: { required: ['numerator', 'denominator'] } },
      { if: { properties: { type: { const: 'cumulative' } } }, then: { required: ['measure'] } },
      { if: { properties: { type: { const: 'derived' } } }, then: { required: ['expr', 'metrics'] } },
      { if: { properties: { type: { const: 'conversion' } } }, then: { required: ['base_measure', 'conversion_measure', 'window'] } },
    ],
  };
}

function predicateDefs(catalog) {
  return {
    fieldRef: {
      type: 'object',
      // model/attribute are validated per-context in the handler (task dims are not a static
      // enum); `_reachable_attributes` documents what the catalog can reach.
      _reachable_attributes: catalog.reachableAttributes(),
      description: 'The field a condition applies to: an attribute addressed by where it lives ({ kind: "dimension", model, attribute }) or the metric time axis.',
      oneOf: [
        { type: 'object', additionalProperties: false, required: ['kind', 'model', 'attribute'], description: 'A dimension addressed by WHERE IT LIVES: { kind: "dimension", model: "users", attribute: "country" } — the join path is resolved from the schema (add via when the source has several relationships to that model).', properties: { kind: { enum: ['dimension'], description: 'Filter on a dimension.' }, model: { enum: catalog.modelKeys(), description: 'The model that carries the attribute.' }, attribute: { type: 'string', description: 'The attribute (column) on that model.' }, via: { type: 'string', description: 'Optional relationship name when several lead to the model.' } } },
        { type: 'object', additionalProperties: false, required: ['kind'], description: 'The metric time axis.', properties: { kind: { enum: ['metric_time'], description: 'Filter on the metric time dimension.' }, grain: { enum: catalog.timeGranularities(), description: 'Time grain to bucket by.' } } },
      ],
    },
    predicate: {
      type: 'object',
      additionalProperties: false,
      required: ['field', 'op'],
      description: 'A single filter condition (field OP value).',
      properties: {
        field: { $ref: '#/$defs/fieldRef' },
        op: { enum: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'between', 'is_null', 'is_not_null'], description: 'Comparison operator. between takes [low, high]; in/not_in take an array; is_null/is_not_null take no value.' },
        value: { description: 'Value to compare against (scalar, array for in/not_in/between). Bound as an escaped literal.' },
      },
    },
    predicateGroup: {
      type: 'object',
      additionalProperties: false,
      required: ['op', 'conditions'],
      description: 'A boolean group combining conditions/sub-groups with AND or OR (compose for nested logic).',
      properties: {
        op: { enum: ['and', 'or'], description: 'How to combine the `conditions`.' },
        conditions: { type: 'array', minItems: 1, description: 'Conditions and/or nested groups.', items: { oneOf: [{ $ref: '#/$defs/predicate' }, { $ref: '#/$defs/predicateGroup' }] } },
      },
    },
  };
}

// The ceiling on the pacing timer (`time`). A wait happens INSIDE a tool call, so it is bounded by
// the same thing a build's grace is bounded by: the client's own timeout, which this server neither
// knows nor can raise. Asking for more than this returns after the cap, with `clamped: true`.
// Declared here because both the schema text and the engine's clamp must say the same number.
export const MAX_WAIT_SECONDS = 30;

// How many queries one call to a query tool may start (`queries`) or read back (`task_ids`).
export const MAX_BATCH = 5;

/** A copy of a schema without its descriptions: the same checks, told once where it is described. */
function terse(schema) {
  if (Array.isArray(schema)) return schema.map(terse);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'description') continue;
    // under `properties` the keys are field names, not schema keywords
    out[k] = k === 'properties' ? Object.fromEntries(Object.entries(v).map(([f, sub]) => [f, terse(sub)])) : terse(v);
  }
  return out;
}

export function buildSchemas(catalog) {
  const modelKeys = catalog.modelKeys();
  const create = {
    type: 'object',
    additionalProperties: false,
    // No root `required`: the two modes require different things, and the allOf below says which
    // (create → name + metrics, update → context_id + semantic_model), so a caller is never told
    // to supply a field the mode it asked for does not take.

    description: 'Declaratively create/extend the semantic models + metrics for an analytics task inside an isolated context — the GOVERNED path. Produces NAMED metrics you query many ways with query_semantic_model (group_by / time / filters), reusably. Use this for measurable, re-sliceable metrics (DAU, revenue, conversion, retention). TWO MODES: the default declares a task (name + semantic_models + metrics); action:"update" edits the task already in a context — add_measures / add_dimensions / add_metrics and the matching remove_* on one `semantic_model`, without restating the rest. For a one-off derived TABLE (funnel/sessionization/window/pivot — things the governed metrics cannot express), use build_pipeline_model instead. It returns a task_id: query_semantic_model({ task_id }) returns the parsed model (metrics, what it can be grouped by) — a query on this context waits for it by itself.',
    allOf: [
      { if: { properties: { action: { const: 'update' } }, required: ['action'] }, then: { required: ['context_id', 'semantic_model'] } },
      { if: { not: { properties: { action: { const: 'update' } }, required: ['action'] } }, then: { required: ['name', 'metrics'] } },
    ],
    properties: {
      action: { enum: ['create', 'update'], description: 'create (default) = declare a task: name + semantic_models + metrics. update = change the task already in this context: the add_*/remove_* fields below, on one `semantic_model`.' },
      context_id: { type: 'string', pattern: CTX, description: D.context_id },
      name: { type: 'string', pattern: TASK, description: 'Task name (lowercase snake_case). Namespaces all measures/metrics so multiple tasks coexist in one context.' },
      description: { type: 'string', description: 'What this task computes, in your words. Kept with the context and returned by context({ action: "describe" | "list" }), so a later call — or another session — can tell what this context is for without re-reading its YAML.' },
      use_base_models: { type: 'array', items: { type: 'string', enum: catalog.joinableModelKeys() }, description: 'Additional source models to load so their attributes become groupable/filterable as { model, attribute } (e.g. "users" to slice by { model: "users", attribute: "country" }). Every source named in semantic_models[].from is loaded already — list here only a model you join TO but define no measures on. Measures from SEVERAL sources may live in one task (one semantic model each): each reaches the joined model by its own declared key. If that model is slowly-changing, the join is point-in-time automatically — MetricFlow applies its validity window, so nothing is stated here.' },
      semantic_models: { type: 'array', items: { oneOf: modelKeys.map((k) => semanticModelBranch(catalog, k)) }, description: 'Semantic model definitions (one per source model) carrying the measures/dimensions for this task.' },
      metrics: { type: 'array', minItems: 1, items: metricSchema(), description: 'The metrics to expose for querying (each references measures defined above).' },
      dry_run: { type: 'boolean', description: 'If true, validate and return the definition WITHOUT writing files or building anything.' },
      include_yaml: { type: 'boolean', description: 'Return the full rendered context YAML in the response (default false). The YAML is always written to the context files regardless; omit it to keep responses small.' },
      // action: 'update' — the incremental path. Same vocabulary as above (that is why the two are
      // one tool: two schemas meant two copies of every enum in every listing).
      semantic_model: { type: 'string', enum: modelKeys, description: 'action:"update" — which model\'s semantic model to change.' },
      add_dimensions: { type: 'array', items: genericDimensionItem(catalog), description: 'action:"update" — dimensions to add.' },
      remove_dimensions: { type: 'array', items: { type: 'string' }, description: 'action:"update" — dimensions to remove, by the ATTRIBUTE they declare (the name `groupable` shows).' },
      add_measures: { type: 'array', items: genericMeasureItem(catalog), description: 'action:"update" — measures to add.' },
      remove_measures: { type: 'array', items: { type: 'string' }, description: 'action:"update" — measures to remove; refused while a metric depends on one, unless cascade.' },
      add_metrics: { type: 'array', items: metricSchema(), description: 'action:"update" — metrics to add.' },
      remove_metrics: { type: 'array', items: { type: 'string' }, description: 'action:"update" — metrics to remove.' },
      task: { type: 'string', description: 'action:"update" — the task the additions belong to (defaults to the context\'s first task).' },
      cascade: { type: 'boolean', description: 'action:"update" — also remove the metrics that depend on a removed measure.' },
    },
  };

  // register_native_model: build a derived dbt model from a declarative PIPELINE
  // (a pipe-syntax transformation, optionally ending in a match_recognize funnel)
  // and materialize it. The pipeline's rows ARE the result.
  const registerModel = {
    type: 'object', additionalProperties: false, required: ['name', 'pipeline'],
    description: 'Build a derived model from a PIPELINE: a `source` + ordered `stages` (where/derive/compute/unnest/join/aggregate/pivot/unpivot/sample/window/order_by/limit/project, and the match_recognize funnel stage). Its ROWS are the result — the call returns a task_id and query_pipeline_model({ task_id }) returns them; a pipeline started from that task (from_task) re-slices them without recomputing. Funnels are pipelines too: add a match_recognize stage, then slice it with a downstream join/aggregate (e.g. conversion by country).',
    properties: {
      context_id: { type: 'string', pattern: CTX, description: D.context_id },
      name: { type: 'string', pattern: TASK, description: 'Model name (lowercase snake_case); generated as pipe_<name>.' },
      description: { type: 'string', description: 'What this model computes, in your words. Kept with the context (returned by context({ action: "describe" | "list" })) and written into the generated model\'s config banner, so the table can be traced back to the question it answers.' },
      materialized: { enum: ['view', 'table'], default: 'table', description: 'How the result is stored: table (precomputed snapshot, default) or view (always fresh).' },
      dry_run: { type: 'boolean', description: 'If true, return the generated model definition for preview WITHOUT building anything.' },
      pipeline: {
        type: 'object', additionalProperties: false, required: ['source', 'stages'],
        description: 'The transformation pipeline: a `source` table + ordered `stages` applied left-to-right.',
        properties: {
          source: { type: 'string', enum: modelKeys, description: `Source table the pipeline reads. Always named: each source (${catalog.modelKeys().join(', ')}) has its own columns, events and payload, and they are never mixed.` },
          time_range: { type: 'object', additionalProperties: false, description: 'Restrict the pipeline to a time window on the source\'s time column (ISO dates), applied BEFORE the stages — avoids hand-written device_time literals and keeps whole-session windows intact.', properties: { start: { type: 'string', description: 'Inclusive start (ISO date/datetime).' }, end: { type: 'string', description: 'Inclusive end (ISO date/datetime; a date-only end means the WHOLE day).' }, timezone: { type: 'string', description: 'Optional IANA timezone (e.g. "Europe/Berlin"): start/end are read as wall-clock in this zone and converted to the UTC instants the warehouse stores. Omit for warehouse-native (UTC) bounds.' } } },
          stages: { type: 'array', minItems: 1, items: { $ref: '#/$defs/pipeline_stage' }, description: 'Ordered pipe stages; each transforms the previous output.' },
        },
      },
    },
  };

  // build_pipeline_model: compose a pipeline INCREMENTALLY, one stage at a time. A
  // single stateful tool with an `action`; each add_step validates the stage and
  // returns the columns now available for the NEXT stage (schema only — nothing is
  // materialized until materialize). The all-at-once register_native_model still works.
  const trProp = { type: 'object', additionalProperties: false, description: 'Restrict the pipeline to a time window on the source\'s time column (ISO dates), applied BEFORE the stages.', properties: { start: { type: 'string', description: 'Inclusive start (ISO date/datetime).' }, end: { type: 'string', description: 'Inclusive end (ISO date/datetime; a date-only end means the WHOLE day).' }, timezone: { type: 'string', description: 'Optional IANA timezone: start/end are wall-clock in this zone, converted to UTC instants.' } } };
  // A then-clause fragment that forbids the named properties (valid only when ALL are absent).
  const forbid = (props) => ({ not: { anyOf: props.map((p) => ({ required: [p] })) } });
  const buildModel = {
    type: 'object', additionalProperties: false, required: ['action'],
    description: 'Compose a native pipeline model INCREMENTALLY, one stage at a time — a single tool driven by `action`. Each add_step validates the stage and returns the exact columns now available for the NEXT stage (pure schema; NOTHING is materialized until materialize), so you build with full visibility instead of guessing a whole pipeline up front. Lifecycle: start → add_step* → (optional preview) → materialize (builds + runs the model) → add_step* → materialize again. MATERIALIZE IS NOT THE END: the draft stays open and the table it built STANDS FOR the steps so far, so the steps you add next read THAT table instead of recomputing an expensive prefix (an aggregate, a python model). Editing a step at or before a materialized prefix retires it (the next materialize rebuilds from the source); editing a step after it keeps it. Each response says what it started from (from_checkpoint / steps_recomputed) and what it retired (checkpoints_dropped). WHEN TO USE: a one-off derived TABLE whose rows are the answer — funnels (match_recognize), sessionization, window functions, pivots, anything the governed metrics cannot express; materialize returns a task_id — read the rows with query_pipeline_model({ task_id }), filter or regroup them with query_pipeline_model({ context_id, transform }). For REUSABLE named metrics you query many ways (group_by / time / filters), use build_semantic_model instead (the governed path).',
    // Each action accepts ONLY its relevant fields: start takes name/source/materialized/
    // time_range (+ an optional draft_id to reuse a context); add_step takes draft_id+stage;
    // preview/materialize/discard take just draft_id. `forbid` rejects any field that does not
    // belong to the action, so a stray param is an error rather than silently ignored.
    allOf: [
      // a draft reads a catalog source, or the stored table of a finished task (from_task)
      { if: { properties: { action: { const: 'start' } }, required: ['action'] }, then: { required: ['name'], anyOf: [{ required: ['source'] }, { required: ['from_task'] }], ...forbid(['stage', 'stages', 'index', 'after']) } },
      { if: { properties: { action: { const: 'add_step' } }, required: ['action'] }, then: { required: ['draft_id', 'stage'], ...forbid(['from_task', 'name', 'source', 'materialized', 'time_range', 'index', 'after', 'stages', 'description']) } },
      { if: { properties: { action: { const: 'add_steps' } }, required: ['action'] }, then: { required: ['draft_id', 'stages'], ...forbid(['from_task', 'name', 'source', 'materialized', 'time_range', 'index', 'after', 'stage', 'description']) } },
      { if: { properties: { action: { enum: ['edit_step', 'insert_step'] } }, required: ['action'] }, then: { required: ['draft_id', 'index', 'stage'], ...forbid(['from_task', 'name', 'source', 'materialized', 'time_range', 'after', 'stages', 'description']) } },
      { if: { properties: { action: { const: 'delete_step' } }, required: ['action'] }, then: { required: ['draft_id', 'index'], ...forbid(['from_task', 'name', 'source', 'materialized', 'time_range', 'stage', 'stages', 'after', 'description']) } },
      { if: { properties: { action: { const: 'truncate' } }, required: ['action'] }, then: { required: ['draft_id', 'after'], ...forbid(['from_task', 'name', 'source', 'materialized', 'time_range', 'stage', 'stages', 'index', 'description']) } },
      { if: { properties: { action: { const: 'fork' } }, required: ['action'] }, then: { required: ['draft_id'], ...forbid(['from_task', 'source', 'materialized', 'time_range', 'stage', 'stages', 'index']) } },
      { if: { properties: { action: { enum: ['preview', 'materialize', 'discard'] } }, required: ['action'] }, then: { required: ['draft_id'], ...forbid(['from_task', 'name', 'source', 'materialized', 'time_range', 'stage', 'stages', 'index', 'after', 'description']) } },
    ],
    properties: {
      action: { enum: ['start', 'add_step', 'add_steps', 'edit_step', 'insert_step', 'delete_step', 'truncate', 'fork', 'preview', 'materialize', 'discard'], description: 'start a new draft (returns a draft_id + source columns); add_step appends ONE stage and returns the columns available after it; add_steps appends SEVERAL stages at once (applied in order) and returns a per-step breakdown of how each changed the data — atomic (all-or-nothing); edit_step replaces step `index`; insert_step inserts a stage BEFORE `index`; delete_step removes step `index`; truncate keeps only steps 1..`after` (cheap "go back to step N"); fork branches a NEW draft from steps 1..`after` of this draft (or an already-materialized pipeline) WITHOUT touching the original — iterate variants without re-typing the shared prefix; preview shows steps + the SQL that would actually run (from a materialized prefix when there is one); materialize builds the model AND keeps the draft, recording the built table as the prefix the next steps read; discard drops the draft. Every edit revalidates the whole pipeline end-to-end and reports the failing step if an edit breaks a later one. PREFER add_step or SMALL add_steps chunks over one giant add_steps, so you see how each chunk changes the data.' },
      draft_id: { type: 'string', pattern: CTX, description: 'Draft handle returned by start (it is a context_id). Required for everything except start. For fork it may also be a context whose pipeline was already materialized.' },
      name: { type: 'string', pattern: TASK, description: 'Model name (lowercase snake_case); generated as pipe_<name>. Required for start; optional for fork (defaults to the source draft\'s name).' },
      description: { type: 'string', description: 'What this pipeline computes, in your words (start, or fork to override the parent\'s). Kept with the draft and carried to the model it materializes: returned by context({ action: "describe" | "list" }) and written into the generated model\'s config banner. A draft is cheap to make and easy to lose track of — this is what tells two of them apart later.' },
      materialized: { enum: ['view', 'table'], default: 'table', description: 'How the result is stored when materialized (chosen at start): table (default) or view.' },
      from_task: { type: 'string', pattern: TASK_ID, description: 'start only: begin FROM the stored table of a finished task — a query run with materialize:true, or a pipeline build — instead of a catalog source. The steps re-slice that result (filter, regroup, join, window…) WITHOUT recomputing it. `source` then names the source the steps resolve payload properties and relationships against (taken from the task when it read one source).' },
      source: { type: 'string', enum: modelKeys, description: `Source table the pipeline reads (start only, and REQUIRED there unless from_task). Each source (${catalog.modelKeys().join(', ')}) has its own columns, events and payload, and they are never mixed.` },
      time_range: trProp,
      stage: { $ref: '#/$defs/pipeline_stage', description: 'ONE pipe stage — appended (add_step), or placed at `index` (edit_step/insert_step), validated against the columns available at that point.' },
      stages: { type: 'array', minItems: 1, items: { $ref: '#/$defs/pipeline_stage' }, description: 'Several pipe stages to append IN ORDER (add_steps). Applied sequentially; the response reports each stage\'s effect on the data. Keep this to a small LOGICAL chunk — do NOT dump the whole pipeline at once.' },
      index: { type: 'integer', minimum: 1, description: 'Target step (1-based, per steps[].index) for edit_step / insert_step / delete_step. insert_step places the stage BEFORE this position (count+1 appends).' },
      after: { type: 'integer', minimum: 0, description: 'Keep steps 1..after — for truncate (drop the rest) and fork (copy that prefix into the new draft). 0 = none; omit on fork to copy all steps.' },
      include_columns: { type: 'boolean', description: 'start/add_step/edit ops: also return the FULL available_columns list. Off by default — the per-step response returns only the diff (columns_added + columns_removed_count, with the removed names only when short) to avoid re-dumping the whole schema each step; use preview for the full list too.' },
      include_steps: { type: 'boolean', description: 'add_step only: also return the FULL steps array. Off by default — add_step is append-only, so it echoes just the applied `step` + `steps_count` (you already have the earlier steps); pass true, or use preview, when you need the whole pipeline back.' },
    },
  };

  const pdefs = predicateDefs(catalog);
  // HOW A RESULT IS SHOWN — declared by the caller, never guessed: the card display_model_result draws in
  // a host that renders MCP Apps follows this when it is given. Every form
  // is one closed branch tagged by `kind` (a discriminator), and what a form needs is said by the
  // schema itself — required fields, array bounds, enums, if/then — not in prose. It names result
  // COLUMNS (the names the rows come back with), so a wrong one is refused with the list.
  const resultColumn = { type: 'string', minLength: 1, description: 'A column of THIS result, exactly as the rows come back: a metric name, <model>_<attribute>, metric_time_<grain>, or a pipeline column.' };
  const cardTitle = { type: 'string', maxLength: 120, description: 'Card title, in the person\'s words (e.g. "Onboarding funnel, Sep 1–23").' };
  const valueColumns = (what) => ({ type: 'array', minItems: 1, maxItems: 6, uniqueItems: true, items: resultColumn, description: `The value column(s): one ${what} each.` });
  const seriesColumn = (what) => ({ ...resultColumn, description: `Split the ONE y column into a ${what} per value of this column (e.g. users_platform).` });
  // a split names ONE value column: the schema says so, not a sentence
  const oneYWhenSplit = { if: { required: ['series_column'] }, then: { properties: { y: { maxItems: 1 } } } };
  const axis = { ...resultColumn, description: 'The axis column: time is put in time order, any other column keeps the row order.' };
  // a chart the person can drill into: the dimensions a clicked point, bar or slice opens into
  const drill = {
    type: 'object', additionalProperties: false, required: ['levels'],
    description: 'Let the person DRILL DOWN: a click on a bar, slice or point offers these dimensions, and the chart is redrawn filtered to what was clicked and broken down by the one chosen — then again, one level deeper, with the ones left. Reads a STORED result (materialize: true, or a pipeline build) whose rows carry these columns too (group the query by them as well); the chart is drawn from it folded over them. Each view RE-AGGREGATES with `agg`: sums and counts add up, but a distinct count, an average or a ratio does NOT (a user in two platforms counts twice) — be careful with non-additive metrics.',
    properties: {
      levels: { type: 'array', minItems: 1, maxItems: 5, description: 'The dimensions offered, in the order the menu lists them.', items: { type: 'object', additionalProperties: false, required: ['column'], properties: { column: resultColumn, label: { type: 'string', maxLength: 40, description: 'How the dimension reads in the menu (default: the column name).' } } } },
      agg: { enum: ['sum', 'count', 'min', 'max', 'avg'], default: 'sum', description: 'How the rows under a view fold into its values.' },
    },
  };
  const form = (kind, title, description, properties, required, extra = {}) => ({
    title, description, type: 'object', additionalProperties: false,
    required: ['kind', ...required],
    properties: { kind: { const: kind }, title: cardTitle, ...properties },
    ...extra,
  });
  const display = {
    description: 'How the card draws the rows. Pick the `kind` whose description matches the question; the card draws exactly that, in the declared order. It names result columns and changes no numbers. Omitted: the card follows the rows\' shape.',
    discriminator: { propertyName: 'kind' },
    oneOf: [
      form('line', 'line — a trend', 'A TREND over an ordered axis (usually time): one line, or several to compare series.', {
        x: axis, y: valueColumns('line'), series_column: seriesColumn('line'), drill,
      }, ['x', 'y'], oneYWhenSplit),
      form('area', 'area — a total split into parts over time', 'A COMPOSITION OVER TIME: series that add up to one total, STACKED (DAU by platform). Series that do not add up → line.', {
        x: axis, y: valueColumns('band'), series_column: seriesColumn('band'), drill,
      }, ['x', 'y'], oneYWhenSplit),
      form('bar', 'bar — a comparison across categories', 'A COMPARISON across categories, in row order: a bar per category, several per category (grouped), or stacked into one (part-to-whole per category).', {
        x: { ...resultColumn, description: 'The category column.' },
        y: valueColumns('bar per category'),
        series_column: seriesColumn('bar within each category'),
        stacked: { type: 'boolean', default: false, description: 'Stack the bars of a category into one instead of grouping them side by side.' },
        horizontal: { type: 'boolean', description: 'Lay the bars flat. Omitted: flat past 8 categories.' },
        drill,
      }, ['x', 'y'], oneYWhenSplit),
      form('pie', 'pie — shares of one total', 'A PART-TO-WHOLE at a glance, drawn as a donut: a slice per row. For a few clearly different shares — close values read better as bars. Past 6 slices the smallest fold into "Other".', {
        label_column: { ...resultColumn, description: 'The column naming each slice.' },
        value_column: { ...resultColumn, description: 'The column with each slice\'s amount (non-negative).' },
        drill,
      }, ['label_column', 'value_column']),
      form('funnel', 'funnel — ordered steps', 'ORDERED STEPS and how many reach each, with the conversion between them.', {
        steps: {
          description: 'The steps, in order — as COLUMNS of a one-row result, or as ROWS (one per step).',
          oneOf: [
            { title: 'steps are columns of one row', type: 'array', minItems: 2, maxItems: 20, items: { type: 'object', additionalProperties: false, required: ['column'], properties: { column: resultColumn, label: { type: 'string', maxLength: 60, description: 'How the step reads to the person (default: the column name).' } } } },
            { title: 'one row per step', type: 'object', additionalProperties: false, required: ['label_column', 'value_column'], properties: { label_column: { ...resultColumn, description: 'The column naming each step.' }, value_column: { ...resultColumn, description: 'The column with each step\'s count.' } } },
          ],
        },
      }, ['steps']),
      form('kpi', 'kpi — headline numbers', 'HEADLINE NUMBERS as stat tiles: a big value, its change against a previous value. One row, or with x a series whose last row is shown with its trend. A single number beats any chart.', {
        x: { ...axis, description: 'The axis of a multi-row result: each tile shows the LAST row, its change from the row before, and the trend as a sparkline.' },
        values: {
          type: 'array', minItems: 1, maxItems: 4, description: 'The tiles, in order.',
          items: {
            type: 'object', additionalProperties: false, required: ['column'],
            properties: {
              column: resultColumn,
              label: { type: 'string', maxLength: 60, description: 'How the number reads to the person (default: the column name).' },
              format: { enum: ['number', 'percent', 'currency'], default: 'number', description: 'percent: the value is a ratio (0.123 → 12.3%).' },
              currency: { type: 'string', pattern: '^[A-Z]{3}$', default: 'USD', description: 'ISO 4217 code.' },
              previous_column: { ...resultColumn, description: 'A column with the value to compare against (the previous period).' },
              good: { enum: ['up', 'down'], description: 'Which direction of change is good — colors the change. Omitted: shown without judgement.' },
            },
            // a currency code is for a currency value
            if: { required: ['currency'] }, then: { required: ['format'], properties: { format: { const: 'currency' } } },
          },
        },
      }, ['values']),
      form('pivot', 'pivot — a table to drill into', 'A TABLE TO DRILL INTO, level by level: the card shows the top level, and each row expands into the next level ON DEMAND — read from the stored result, filtered to that row — so the detail is never loaded all at once. Reads a STORED result (a query run with materialize: true, or a pipeline build). Each level RE-AGGREGATES the rows under it with the value\'s agg: sum, count, min and max fold honestly, but a distinct count, an average or a ratio does NOT add up across levels (a user present in two children counts twice) — be careful with non-additive metrics: prefer additive columns (counts, sums, the numerator and denominator of a ratio) as the values.', {
        levels: {
          type: 'array', minItems: 1, maxItems: 5, description: 'The dimension columns, from the top level down.',
          items: { type: 'object', additionalProperties: false, required: ['column'], properties: { column: resultColumn, label: { type: 'string', maxLength: 40, description: 'How the level reads to the person — short, it names a column and each opened row (default: the column name).' } } },
        },
        values: {
          type: 'array', minItems: 1, maxItems: 6, description: 'The value columns, each re-aggregated per level.',
          items: {
            type: 'object', additionalProperties: false, required: ['column'],
            properties: {
              column: resultColumn,
              agg: { enum: ['sum', 'count', 'min', 'max', 'avg'], default: 'sum', description: 'How the rows under a level fold into its value.' },
              label: { type: 'string', maxLength: 60, description: 'How the value reads to the person (default: the column name).' },
              format: { enum: ['number', 'percent', 'currency'], default: 'number' },
              currency: { type: 'string', pattern: '^[A-Z]{3}$', default: 'USD' },
            },
          },
        },
      }, ['levels', 'values']),
      form('sankey', 'sankey — flows between stages', 'FLOWS between stages: a row per link, source → target with an amount (installs from channel to platform). Links chain — a target can be the next source — and never loop back.', {
        source_column: { ...resultColumn, description: 'The column naming where a flow starts.' },
        target_column: { ...resultColumn, description: 'The column naming where it goes.' },
        value_column: { ...resultColumn, description: 'The column with the amount that flows (positive).' },
      }, ['source_column', 'target_column', 'value_column']),
    ],
  };

  // A read-only projection over a stored table — what query_pipeline_model runs over a built model
  // and what a drill-down card reads one view with. The row cap is the tool's own `limit`.
  const projection = {
    type: 'object', additionalProperties: false,
    description: 'A read-only projection over the stored table: filter rows, group, aggregate, filter the aggregates, sort — nothing upstream is recomputed.',
    properties: {
      where: { type: 'array', description: 'Row filters on result columns.', items: { type: 'object', additionalProperties: false, required: ['column', 'op'], properties: { column: { type: 'string', description: 'Result column to filter.' }, op: { enum: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'is_null', 'is_not_null'], description: 'Comparison operator.' }, value: { description: 'Comparison value (array for in/not_in).' } } } },
      group_by: { type: 'array', items: { type: 'string' }, description: 'Result columns to group by before aggregating.' },
      aggregations: { type: 'array', description: 'Aggregations to compute over the (grouped) result.', items: { type: 'object', additionalProperties: false, required: ['fn'], properties: { fn: { enum: ['sum', 'avg', 'min', 'max', 'count', 'count_distinct'], description: 'Aggregate function.' }, column: { type: 'string', description: 'Column to aggregate (omit, or \'*\', for a row count).' }, as: { type: 'string', pattern: '^[a-zA-Z_][a-zA-Z0-9_]*$', description: 'Output column alias (default: <fn>_<column>, or the function alone for a row count).' } }, if: { properties: { fn: { not: { const: 'count' } } } }, then: { required: ['column'] } } },
      having: { type: 'array', description: 'Post-aggregation filters on aggregate values.', items: { type: 'object', additionalProperties: false, required: ['fn', 'op', 'value'], properties: { fn: { enum: ['sum', 'avg', 'min', 'max', 'count', 'count_distinct'], description: 'Aggregate function to test.' }, column: { type: 'string', description: 'Column the aggregate applies to.' }, op: { enum: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'], description: 'Comparison operator.' }, value: { description: 'Threshold value.' } } } },
      order_by: { type: 'array', description: 'Sort the projected output.', items: { type: 'object', additionalProperties: false, required: ['key'], properties: { key: { type: 'string', description: 'Column/alias to sort by.' }, direction: { enum: ['asc', 'desc'], description: 'Sort direction.' }, nulls: { enum: ['first', 'last'], description: 'Where NULLs go. Omitted: the warehouse\'s default (which differs between warehouses).' } } } },
    },
  };
  const pipelineQueryFields = {
    transform: projection,
    limit: { type: 'integer', minimum: 1, maximum: 100000, description: 'Rows to return (default 1000); with task_id, pages a stored result.' },
    offset: { type: 'integer', minimum: 0, description: 'Rows to skip (paging); with task_id, pages a stored result.' },
  };
  // The read half of a query tool: { task_id } waits for a task of its side and returns it.
  const taskRead = {
    task_id: { type: 'string', pattern: TASK_ID, description: 'READ a task of this side back (instead of starting a query): wait for it and return its result.' },
    wait_seconds: { type: 'number', minimum: 0, maximum: MAX_WAIT_SECONDS, description: `With task_id: how long to wait for the task at most (default and cap ${MAX_WAIT_SECONDS}); it returns the moment the task is done. 0 = just look.` },
  };
  taskRead.cancel = { type: 'boolean', const: true, description: 'With task_id / task_ids: CANCEL those tasks instead of reading them — a running task ends at once as cancelled (its warehouse process is stopped; one still queued never starts); a finished one is left as it is.' };
  taskRead.task_ids = { type: 'array', minItems: 1, maxItems: MAX_BATCH, uniqueItems: true, items: { type: 'string', pattern: TASK_ID }, description: `READ up to ${MAX_BATCH} tasks of this side at once (the task_ids a batch returned): waits until all are done and returns each one's result, in this order.` };
  // The four modes of a query tool: start one query (context_id + its fields), start a batch
  // (context_id + queries), read one task (task_id), read several (task_ids). Each takes only its own fields.
  const queryModes = (fields) => [
    { if: { required: ['cancel'] }, then: { anyOf: [{ required: ['task_id'] }, { required: ['task_ids'] }], ...forbid(['wait_seconds', 'offset', 'limit']) } },
    { if: { required: ['task_id'] }, then: forbid(['context_id', ...fields, 'queries', 'task_ids']) },
    { if: { required: ['task_ids'] }, then: forbid(['context_id', ...fields, 'queries', 'task_id', 'offset', 'limit']) },
    { if: { required: ['queries'] }, then: { required: ['context_id'], ...forbid([...fields, 'offset', 'limit', 'wait_seconds']) } },
    { if: { not: { anyOf: [{ required: ['task_id'] }, { required: ['task_ids'] }] } }, then: { required: ['context_id'] } },
  ];
  const batchOf = (item, what) => ({ type: 'array', minItems: 1, maxItems: MAX_BATCH, description: `START up to ${MAX_BATCH} ${what} on this context in one call, run side by side: each item takes the fields of a single query (described above; context_id stays at the top). All are checked first — one mistake refuses the whole batch. Returns task_ids, in this order: read them together with { task_ids }.`, items: item });

  const semanticQueryFields = {
      task: { type: 'string', description: 'Optional task name hint (disambiguates when a context holds several tasks).' },
      metrics: { type: 'array', minItems: 1, items: { type: 'string' }, description: 'Metric names to fetch (as exposed by the context, e.g. task_<metric>).' },
      group_by: {
        type: 'array',
        description: 'How to break the metrics down. Two forms only: { time: "metric_time", grain } for a time series, and { model, attribute } for an attribute addressed by WHERE IT LIVES — the join path is resolved from the schema (add via: "<relationship>" when the source carries several relationships to that model). The owning model must be in use_base_models. No path strings.',
        items: {
          oneOf: [
            { type: 'object', additionalProperties: false, required: ['time'], description: 'Group by the metric time axis at a grain.', properties: { time: { enum: ['metric_time'], description: 'The metric time dimension.' }, grain: { enum: catalog.timeGranularities(), description: 'Time bucket size.' } } },
            { type: 'object', additionalProperties: false, required: ['model', 'attribute'], description: 'An attribute addressed by where it lives: { model: "users", attribute: "country" }. semantic_index() lists every one under groupable_attributes; build_semantic_model returns the context\'s under groupable. The response echoes the resolved column under group_by_resolved.', properties: { model: { enum: catalog.modelKeys(), description: 'The model that carries the attribute.' }, attribute: { type: 'string', description: 'The attribute (column or task dimension) on that model, as semantic_index({ model }) lists it.' }, via: { type: 'string', description: 'Optional: the relationship to reach the model through, when there are several (key variants).' } } },
          ],
        },
      },
      where: { $ref: '#/$defs/predicateGroup', description: 'Row filter applied before aggregation (boolean tree of conditions on dimensions / metric_time).' },
      order_by: { type: 'array', description: 'Sort order. Each key is a requested metric name, a RESULT COLUMN of this query ("metric_time_day", "users_country" — the names the rows come back with; "metric_time" is an alias of the time column), or a group_by attribute as { model, attribute }.', items: { type: 'object', additionalProperties: false, required: ['key'], properties: { key: { oneOf: [{ type: 'string', description: 'A requested metric name, a result column name (e.g. "users_country", "metric_time_day"), or "metric_time".' }, { type: 'object', additionalProperties: false, required: ['model', 'attribute'], properties: { model: { enum: catalog.modelKeys() }, attribute: { type: 'string' }, via: { type: 'string' } }, description: 'A group_by attribute, addressed as in group_by.' }] }, direction: { enum: ['asc', 'desc'], description: 'Sort direction (default asc).' } } } },
      time_range: { type: 'object', additionalProperties: false, description: 'Restrict to a metric_time range (ISO dates). Unbounded queries scan the whole history — always bound when exploring.', properties: { start: { type: 'string', description: 'Inclusive start (ISO date/datetime).' }, end: { type: 'string', description: 'Inclusive end (ISO date/datetime; a date-only end means the WHOLE day).' }, timezone: { type: 'string', description: 'Optional IANA timezone (e.g. "Europe/Berlin"): start/end are read as wall-clock in this zone and converted to the UTC instants the warehouse stores. Omit for warehouse-native (UTC) bounds.' } } },
      limit: { type: 'integer', minimum: 1, maximum: 100000, description: 'Max rows to return (default 1000); with task_id, pages a stored result.' },
      offset: { type: 'integer', minimum: 0, description: 'Rows to skip from the start (paging); with task_id, pages a stored result.' },
      materialize: { type: 'boolean', description: 'Store the WHOLE result as a table (the rows you get back are one page of it: `limit`/`offset`). A stored result survives a restart, is paged with query_semantic_model({ task_id, offset, limit }), can be drawn as a drill-down (a pivot, a chart with drill), and can be re-sliced by a pipeline started from it (build_pipeline_model({ action: "start", from_task })).' },
      dry_run: { type: 'boolean', description: 'If true, validate and return the compiled query WITHOUT executing it.' },
      explain: { type: 'boolean', description: 'If true, return the query plan (how the metrics compile) and the compiled query WITHOUT executing. A superset of dry_run; useful for inspecting/optimizing.' },
  };
  const query = {
    type: 'object',
    additionalProperties: false,
    description: `Start a metric query against a context (or up to ${MAX_BATCH} at once with queries) — or, with task_id / task_ids, read semantic tasks back.`,
    $defs: pdefs,
    allOf: queryModes(Object.keys(semanticQueryFields).filter((f) => f !== 'limit' && f !== 'offset')),
    properties: {
      ...taskRead,
      context_id: { type: 'string', pattern: CTX, description: D.context_id },
      ...semanticQueryFields,
      queries: batchOf({ type: 'object', additionalProperties: false, required: ['metrics'], properties: terse(semanticQueryFields) }, 'metric queries'),
    },
  };

  const update = {
    type: 'object',
    additionalProperties: false,
    required: ['context_id', 'semantic_model'],
    description: 'Incrementally add or remove measures/dimensions/metrics on a semantic model within a context, then re-parse.',
    properties: {
      context_id: { type: 'string', pattern: CTX, description: D.context_id },
      semantic_model: { type: 'string', enum: modelKeys, description: 'Which model\'s semantic model to modify.' },
      add_dimensions: { type: 'array', items: genericDimensionItem(catalog), description: 'Dimensions to add.' },
      remove_dimensions: { type: 'array', items: { type: 'string' }, description: 'Names of dimensions to remove.' },
      add_measures: { type: 'array', items: genericMeasureItem(catalog), description: 'Measures to add.' },
      remove_measures: { type: 'array', items: { type: 'string' }, description: 'Names of measures to remove (fails if metrics depend on them unless cascade is used elsewhere).' },
      add_metrics: { type: 'array', items: metricSchema(), description: 'Metrics to add.' },
      remove_metrics: { type: 'array', items: { type: 'string' }, description: 'Names of metrics to remove.' },
      task: { type: 'string', description: 'Task name the additions belong to (defaults to the context\'s first task).' },
      dry_run: { type: 'boolean', description: 'If true, validate the change WITHOUT building anything.' },
      include_yaml: { type: 'boolean', description: 'Return the full rendered context YAML in the response (default false; it is always written to the context files).' },
    },
  };

  const ctxRef = { type: 'object', additionalProperties: false, required: ['context_id'], description: 'Reference an existing context by id.', properties: { context_id: { type: 'string', pattern: CTX, description: D.context_id } } };
  const del = { type: 'object', additionalProperties: false, required: ['context_id', 'semantic_model'], description: 'Remove a semantic model\'s task additions from a context.', properties: { context_id: { type: 'string', pattern: CTX, description: D.context_id }, semantic_model: { type: 'string', enum: modelKeys, description: 'Which model\'s additions to remove.' }, cascade: { type: 'boolean', description: 'If true, also remove metrics that depend on the removed measures.' } } };
  const empty = { type: 'object', additionalProperties: false, properties: {} };

  // ONE context-lifecycle tool (action-driven), replacing list_contexts / describe_context /
  // drop_context / delete_native_model / delete_semantic_model. Strict per-action fields.
  const contextTool = {
    type: 'object', additionalProperties: false, required: ['action'],
    description: 'Manage isolated execution contexts (the workspaces build_semantic_model / build_pipeline_model produce). action: list (all contexts) | describe (one context\'s tasks/models/metrics/group-by paths) | drop (tear the whole context down) | delete_model (remove just the native pipeline model, keep the context) | delete_semantic_model (remove one table\'s task additions, with cascade for dependent metrics).',
    allOf: [
      { if: { properties: { action: { const: 'list' } }, required: ['action'] }, then: forbid(['from_task', 'context_id', 'semantic_model', 'cascade', 'force']) },
      { if: { properties: { action: { enum: ['describe', 'delete_model'] } }, required: ['action'] }, then: { required: ['context_id'], ...forbid(['from_task', 'semantic_model', 'cascade', 'force']) } },
      { if: { properties: { action: { const: 'drop' } }, required: ['action'] }, then: { required: ['context_id'], ...forbid(['from_task', 'semantic_model', 'cascade']) } },
      { if: { properties: { action: { const: 'delete_semantic_model' } }, required: ['action'] }, then: { required: ['context_id', 'semantic_model'], ...forbid(['from_task', 'force']) } },
    ],
    properties: {
      action: { enum: ['list', 'describe', 'drop', 'delete_model', 'delete_semantic_model'], description: 'list → all active contexts; describe → one context in depth; drop → tear down the whole context; delete_model → remove the native pipeline model only; delete_semantic_model → remove one model\'s task additions.' },
      context_id: { type: 'string', pattern: CTX, description: `${D.context_id} Required for every action except list.` },
      semantic_model: { type: 'string', enum: modelKeys, description: 'delete_semantic_model: which model\'s task additions to remove.' },
      cascade: { type: 'boolean', description: 'delete_semantic_model: also remove metrics that depend on the removed measures.' },
      force: { type: 'boolean', description: 'drop: tear the context down even though another draft READS a table it built (a fork that inherited a materialized prefix). Those drafts then have to recompute that prefix from the source.' },
    },
  };

  const tools = {
    build_semantic_model: create,
    // Stage schemas may reference root-level definitions (the recursive python body): hoist them.
    register_native_model: withStageDefs(registerModel, catalog),
    build_pipeline_model: withStageDefs(buildModel, catalog),
    delete_native_model: { ...ctxRef, description: 'Delete the registered native model in a context (remove its view + semantic model) and re-parse.' },
    context: contextTool,
    query_semantic_model: query,
    query_pipeline_model: {
      type: 'object', additionalProperties: false,
      description: `Query a built pipeline model (or up to ${MAX_BATCH} queries at once with queries) — or, with task_id / task_ids, read pipeline tasks back.`,
      allOf: queryModes(['transform']),
      properties: {
        ...taskRead,
        context_id: { type: 'string', pattern: CTX, description: 'The context whose BUILT pipeline model to query (the draft_id build_pipeline_model returned, after materialize).' },
        ...pipelineQueryFields,
        queries: batchOf({ type: 'object', additionalProperties: false, properties: terse(pipelineQueryFields) }, 'queries over the built model'),
      },
    },
    display_model_result: {
      type: 'object', additionalProperties: false, required: ['task_id'],
      description: 'Draw a finished result as a card for the person — once.',
      properties: {
        task_id: { type: 'string', pattern: TASK_ID, description: 'The task whose result to draw: a query, a pipeline build, or an experiment.' },
        display,
      },
    },
    drill_result: {
      type: 'object', additionalProperties: false, required: ['task_id', 'transform'],
      description: 'One view of a drawn drill-down card, read from its task\'s stored table (the card calls this; the model does not).',
      properties: {
        task_id: { type: 'string', pattern: TASK_ID, description: 'The task the card was drawn from.' },
        limit: { type: 'integer', minimum: 1, maximum: DRILL_ROWS, description: 'Rows of the view.' },
        transform: projection,
      },
    },
    list_query_jobs: empty,
    update_semantic_model: update,
    delete_semantic_model: del,
    drop_context: {
      ...ctxRef,
      description: 'Tear down an entire isolated context (delete its files + artifacts).',
      properties: { ...ctxRef.properties, force: { type: 'boolean', description: 'Drop even though another draft reads a table this context built.' } },
    },
    describe_context: { ...ctxRef, description: 'Describe a context: tasks, semantic models, measures, metrics, reachable group-by paths.' },
    list_contexts: empty,
    semantic_index: semanticIndexSchema(catalog),
    time: {
      type: 'object', additionalProperties: false, required: ['seconds'],
      description: `Wait for \`seconds\` (capped at ${MAX_WAIT_SECONDS}), then return. Purely a timer; it touches no data and follows no task — waiting for a task is its side\'s query tool with { task_id }.`,
      properties: {
        seconds: { type: 'number', minimum: 0, maximum: 86400, description: `Seconds to wait; the actual wait is capped at ${MAX_WAIT_SECONDS} (larger values are clamped, with clamped:true and cap_seconds in the result).` },
        reason: { type: 'string', description: 'Optional note on what you are waiting for (echoed back; metadata only).' },
      },
    },
    experiment: experimentSchema(),
    memory: memorySchema(catalog),
    ab_test: abTestSchema(),
    srm_check: srmCheckSchema(),
    sample_size: sampleSizeSchema(),
  };
  // Every tool schema is written with its vocabulary SPELLED OUT where it is accepted — that is
  // what makes a refusal able to say which mode the caller was closest to. Repeating a 5 KB list
  // of payload properties three times in one tool is the transport paying for that authoring
  // choice, so the repetition is folded out HERE, after the schemas are written and before they
  // leave: identical subtrees become one `$defs` entry the sites point at. Authoring is unchanged,
  // validation is unchanged (ajv resolves the ref), and the client is handed each list once.
  return Object.fromEntries(Object.entries(tools).map(([name, schema]) => [name, foldRepeats(foldVocabularies(schema))]));
}

/**
 * Fold IDENTICAL subtrees of one schema into `#/$defs` and point every occurrence at the one copy.
 * Purely a transport saving: the folded node carries its own description, so nothing a reader sees
 * is lost, and ajv validates through the ref exactly as it did inline.
 *
 * Only SCHEMA POSITIONS are folded — the value of a `properties` entry, a branch of a union, an
 * `items`. A raw array (an `enum`'s values, a `required` list) is never replaced: `$ref` is a
 * schema, and `enum: { $ref }` is not a schema at all. The saving on a vocabulary comes from
 * folding the little object that CARRIES the enum, which is what repeats anyway.
 *
 * Largest repetition first, so a big list is extracted before the structures that contain it.
 */
const MIN_FOLD = 300;
const SCHEMA_MAPS = ['properties', 'patternProperties', '$defs', 'definitions'];
const SCHEMA_LISTS = ['oneOf', 'anyOf', 'allOf', 'prefixItems'];
const SCHEMA_KEYS = ['items', 'additionalProperties', 'not', 'if', 'then', 'else', 'contains', 'propertyNames'];

/**
 * Fold a repeated VOCABULARY — the same `enum` list offered at several sites under different
 * descriptions (a source's payload properties are the measure's `field`, the dimension's `expr`
 * and the filter's `property`). The values move to one `$defs` entry and each site keeps its own
 * sentence: `{ $ref, description }`. On the production catalog one such list is ~5 KB and appears
 * three times per tool, in two tools.
 *
 * Only a node that is NOTHING BUT a typed vocabulary is folded (type/enum/description/title), so
 * no other constraint can be lost on the way into the ref.
 */
const VOCAB_KEYS = new Set(['type', 'enum', 'description', 'title']);
function foldVocabularies(schema, { minSize = MIN_FOLD } = {}) {
  const counts = new Map();
  const keyOf = (n) => (n.enum && Object.keys(n).every((k) => VOCAB_KEYS.has(k)) ? JSON.stringify([n.type || null, n.enum]) : null);
  eachSchema(schema, (n) => { const k = keyOf(n); if (k && k.length >= minSize) counts.set(k, (counts.get(k) || 0) + 1); });
  const shared = [...counts.entries()].filter(([, n]) => n > 1).map(([k]) => k);
  if (!shared.length) return schema;
  const $defs = { ...(schema.$defs || {}) };
  const names = new Map();
  for (const k of shared) {
    const [type, values] = JSON.parse(k);
    const name = defName({ enum: values }, Object.keys($defs));
    $defs[name] = { ...(type ? { type } : {}), enum: values };
    names.set(k, name);
  }
  const fold = (n) => {
    const k = keyOf(n);
    const name = k && names.get(k);
    return name ? { $ref: `#/$defs/${name}`, ...(n.description ? { description: n.description } : {}) } : n;
  };
  return { ...mapSchemas(schema, (n) => (n === schema ? n : fold(n))), $defs: Object.fromEntries(Object.entries($defs).map(([k, v]) => [k, v.enum ? v : mapSchemas(v, fold)])) };
}

export function foldRepeats(schema, { minSize = MIN_FOLD, maxDefs = 40 } = {}) {
  let out = schema;
  for (let i = 0; i < maxDefs; i += 1) {
    const counts = new Map();
    eachSchema(out, (n) => { const j = JSON.stringify(n); if (j.length >= minSize) counts.set(j, (counts.get(j) || 0) + 1); });
    let best = null;
    for (const [json, n] of counts) {
      if (n < 2) continue;
      const waste = (n - 1) * json.length;
      if (!best || waste > best.waste) best = { json, waste };
    }
    if (!best) break;
    const def = JSON.parse(best.json);
    const key = defName(def, Object.keys(out.$defs || {}));
    const ref = { $ref: `#/$defs/${key}` };
    const fold = (n) => (JSON.stringify(n) === best.json ? ref : n);
    const $defs = Object.fromEntries(Object.entries(out.$defs || {}).map(([k, v]) => [k, mapSchemas(v, fold)]));
    out = { ...mapSchemas(out, (n) => (n === out ? n : fold(n))), $defs: { ...$defs, [key]: def } };
  }
  return out;
}

/** Visit every schema-position node of a document, the root included. */
function eachSchema(node, visit) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return;
  visit(node);
  for (const k of SCHEMA_MAPS) if (node[k] && typeof node[k] === 'object') for (const v of Object.values(node[k])) eachSchema(v, visit);
  for (const k of SCHEMA_LISTS) if (Array.isArray(node[k])) for (const v of node[k]) eachSchema(v, visit);
  for (const k of SCHEMA_KEYS) if (node[k] && typeof node[k] === 'object' && !Array.isArray(node[k])) eachSchema(node[k], visit);
}

/** The same traversal, rebuilding the document: `fn` may return a replacement for a node. */
function mapSchemas(node, fn) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
  const replaced = fn(node);
  if (replaced !== node) return replaced;
  const out = { ...node };
  for (const k of SCHEMA_MAPS) if (out[k] && typeof out[k] === 'object') out[k] = Object.fromEntries(Object.entries(out[k]).map(([kk, v]) => [kk, mapSchemas(v, fn)]));
  for (const k of SCHEMA_LISTS) if (Array.isArray(out[k])) out[k] = out[k].map((v) => mapSchemas(v, fn));
  for (const k of SCHEMA_KEYS) if (out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) out[k] = mapSchemas(out[k], fn);
  return out;
}

/**
 * A readable name for a folded definition — what it IS, not `shared_3`: the vocabulary it pins,
 * the stage it describes, or its first field.
 */
function defName(node, taken) {
  const base = node.enum?.length ? `enum_${node.enum[0]}`
    : node.properties?.stage?.enum?.[0] ? `stage_${node.properties.stage.enum[0]}`
      : node.items?.$ref ? `list_${String(node.items.$ref).split('/').pop()}`
        : node.properties ? `obj_${Object.keys(node.properties)[0]}`
          : node.oneOf || node.anyOf ? 'union'
            : 'shared';
  const key = String(base).replace(/[^A-Za-z0-9_]/g, '_').slice(0, 48);
  let name = key; let n = 2;
  while (taken.includes(name)) { name = `${key}_${n}`; n += 1; }
  return name;
}


/**
 * THE exploration tool, as ONE BRANCH PER VIEW. Each view lists exactly the fields it takes and the
 * vocabulary it accepts, so "two views at once", "limit does not apply here" and "this source has
 * no such property" are not refusals the engine has to write — they are inputs the schema cannot
 * express. Names are enumerated PER SOURCE and a name is ALWAYS asked for within its source: there
 * is no source-less spelling of an event or a column at all, in any catalog, so no name ever has to
 * be traced back to an owner and no view ever has to guess which source was meant.
 */
function semanticIndexSchema(catalog) {
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
    guide: { anyOf: [{ type: 'boolean' }, { type: 'string' }], description: 'true for the whole guide, a task family name, or "python" for the authoring guide of this warehouse\'s python runtime (its constraints + a worked example per operation).' },
  };

  const branches = [
    view('overview (no arguments)', 'OVERVIEW (no arguments): models, each source\'s events, group-by paths, value-index freshness, recipe ids.', [], {}),
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
    description: 'THE data-exploration entry point — call it FIRST and whenever unsure what a field means. One progressive index over meaning + real values + completeness + freshness. Pass NO arguments for the overview, then exactly ONE view: { model } | { source, event } | { source, property } | { search } | { status } | { run } | { bundle } | { recipe } | { guide }. Each view below lists what it takes; a source and a name are separate fields, never glued into one string.',
    // A FLAT map of every field, next to the union. Some clients rewrite a tool schema for
    // OpenAI-style function calling, where a union at the ROOT is not part of the supported
    // subset: they drop it, and what the caller is then shown is an object with no fields at all
    // — which is how "the server wants `source` but it was not in the schema" happens. The union
    // is still the gate (a stripped schema only loses the narrowing, never the checking, because
    // validation runs here); this map is what survives the stripping.
    //
    // A NAME is still never offered without its owner: `event` and `property` are plain strings
    // here, and the per-source branch above is what enumerates the names of one source.
    properties: {
      model: field.model,
      source: { enum: models, description: `The source a name belongs to — passed TOGETHER with \`event\` or \`property\` (each source owns its own events and payload; they are never mixed). One of: ${models.join(', ')}.` },
      event: { type: 'string', description: 'An event NAME of `source` — the two are one address. The { source, event } branch for that source enumerates the names it declares.' },
      property: { type: 'string', description: 'A payload property or attribute NAME of `source` — the two are one address. The { source, property } branch for that source enumerates the names it has.' },
      search: field.search,
      fuzzy: field.fuzzy,
      status: field.status,
      run: field.run,
      ...(bundleSources.length ? { bundle: field.bundle } : {}),
      recipe: field.recipe,
      guide: field.guide,
      ...paging,
    },
    // `anyOf`, not `oneOf`: every branch is CLOSED (additionalProperties: false) and has its own
    // required set, so "at least one" and "exactly one" reject the same inputs here — and anyOf is
    // inside the subset the strict function-calling schemas support, so a client that keeps it
    // keeps the narrowing too.
    anyOf: branches,
  };
}

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
function memoryTargetSchema(catalog, description) {
  return {
    ...(description ? { description } : {}),
    oneOf: [
      {
        title: '{ source, name }',
        type: 'object', additionalProperties: false, required: ['source'],
        properties: {
          source: { enum: catalog.modelKeys(), description: 'The source the entity belongs to.' },
          name: { type: 'string', description: 'A property, user attribute or event of that source. Omit to link the model itself.' },
        },
      },
      {
        title: '{ term }',
        type: 'object', additionalProperties: false, required: ['term'],
        properties: { term: { type: 'string', minLength: 1, description: 'A phrase the user actually used, kept searchable as itself — for what the catalog has no entity for.' } },
      },
    ],
  };
}

function memorySchema(catalog) {
  // Per-action field definitions (shared between the client-facing union `properties` and
  // the strict per-action branches, so the two never drift).
  const F = {
    note: { type: 'string', minLength: 1, description: 'ONE ATOMIC finding, in plain words (e.g. "\'ad format\' = the event_data property ad_type_of_event_data, populated only on ad_started/ad_finished; values rewarded/interstitial/banner"). Keep it to a single fact — when studying a topic, make several small notes instead of one long one (atomic notes link and retrieve far better; an over-long note matches poorly and may fail to index).' },
    question: { type: 'string', description: 'The ORIGINAL business question / analytical goal this finding answers — why you looked it up, in the stakeholder\'s terms (e.g. "which ad format drives the most rewarded-video revenue?"). Embedded together with the note, so a future similarly-phrased business question retrieves this insight by meaning. Include it whenever the finding answers a real question.' },
    targets: { type: 'array', items: memoryTargetSchema(catalog), description: 'The catalog entities this finding is ABOUT (an ARRAY — note the plural), so it surfaces on their semantic_index views. Each is { source, name } — a property, user attribute or event of that source (e.g. { source: "events", name: "ad_type_of_event_data" }) — or { source } alone for the model itself. A name is never written on its own: the source says which entity it is. A phrase the catalog has no entity for is written { term: "..." } and stays searchable as itself.' },
    aliases: { type: 'array', items: { type: 'string' }, description: 'The word(s)/phrasing for this finding — give them IN BOTH the user\'s language AND English (e.g. ["ad format", "формат рекламы", "тип рекламы"]). Bilingual aliases make retrieval work cross-language: the lexical/fuzzy match needs the literal words (it cannot bridge scripts on its own), and the aliases are also embedded with the note so a query in either language matches by meaning. Add the user\'s exact wording + synonyms in each language.' },
    links: { type: 'array', description: 'Associated sources for the finding — a Confluence page, a dashboard, a ticket. A URL string, or { url, title }.', items: { oneOf: [{ type: 'string', description: 'A URL.' }, { type: 'object', additionalProperties: false, required: ['url'], properties: { url: { type: 'string', description: 'Link URL.' }, title: { type: 'string', description: 'Human-readable title.' } } }] } },
    target: memoryTargetSchema(catalog, 'Return notes linked to this ONE entity (singular — the same forms as record\'s `targets`).'),
    query: { type: 'string', description: 'A word/phrase to match against note text, the business question, aliases and linked targets. Token-aware + typo-tolerant fuzzy by default; when embeddings are enabled it ALSO matches by MEANING (a same-sense note with no shared words still surfaces).' },
    fuzzy: { type: 'boolean', description: 'Enable typo/approximate lexical matching (default true). false = exact word/substring only (semantic matching, if enabled, still runs).' },
    id: { type: 'string', description: 'Id of the note to delete (as returned by record / list / search).' },
    limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Max notes to return (default 50 for list, 20 for search).' },
  };

  // One strict, self-contained branch per action: ONLY its fields, additionalProperties:false,
  // its required set. The AI sees exactly what to pass for the chosen action — no guessing.
  const branch = (act, props, required, desc) => ({
    type: 'object', additionalProperties: false, required: ['action', ...required],
    title: act, description: desc,
    properties: { action: { enum: [act] }, ...props },
  });

  return {
    type: 'object',
    required: ['action'],
    description: 'DURABLE analyst memory: save what you FOUND OUT — a vague request tracked down to a real field, a gotcha, a useful source — LINKED to the catalog entities it concerns, so it comes back THROUGH semantic_index next time. Pick EXACTLY ONE action; each action has its OWN fixed field set (a field that does not belong to the action is rejected): record = save a finding (note [required] + question + targets[] + aliases[] + links[]); list = read notes (no args = all; { target } = notes about one entity); search = find notes by a word/phrase ({ query } [required] + fuzzy + limit); forget = delete one note ({ id } [required]). RECORD ONE ATOMIC FINDING PER NOTE — when studying a topic/document, make several small single-fact notes, not one big dump. Note: record takes the PLURAL `targets` (array); list takes the SINGULAR `target`.',
    discriminator: { propertyName: 'action' },
    // Union of every action\'s fields (gives MCP clients the real types); the selected
    // oneOf branch below enforces the exact per-action field set + rejects foreign fields.
    properties: { action: { enum: ['record', 'list', 'search', 'forget'], description: 'record → save a finding; list → read notes (all, or one { target }); search → find notes by { query }; forget → delete one note by { id }.' }, ...F },
    oneOf: [
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

// ── A/B test statistics (computed in JS over per-group aggregates) ────────────
//
// The schema is a DISCRIMINATED UNION on `metric`: each branch is fully self-
// contained (additionalProperties:false) and its group arms accept ONLY the fields
// that metric consumes. So a proportion test cannot carry `mean`, a mean test cannot
// carry `conversions`, a ratio test must carry exactly the five ratio sums, etc. —
// invalid field combinations are rejected by the schema, not just at runtime.
//
// A typed top-level `properties` (the UNION of all group fields) sits alongside the
// oneOf so MCP clients see the real argument types (control = object, variants = array,
// confidence = number, conversions = integer, …) and serialize them correctly; the oneOf
// still enforces the exact per-metric field set on the selected branch.
function abTestSchema() {
  const confidence = { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1, default: 0.95, description: 'Confidence level (e.g. 0.95).' };
  const alternative = { enum: ['two_sided', 'greater', 'less'], default: 'two_sided', description: 'Hypothesis direction for the variant vs control.' };
  const correction = { enum: ['none', 'holm', 'bh'], default: 'holm', description: 'Multiple-comparison correction across the variants: holm (family-wise error rate), bh (Benjamini–Hochberg false discovery rate), or none. Adds p_value_adjusted/significant_adjusted per variant.' };

  // Per-metric stat fields (kept DRY between the union arm and the strict branches).
  const F = {
    conversions: { type: 'integer', minimum: 0, description: 'proportion: number of successes in the group.' },
    mean: { type: 'number', description: 'mean: mean of the metric over the group.' },
    stddev: { type: 'number', minimum: 0, description: 'mean: standard deviation over the group.' },
    sumNum: { type: 'number', description: 'ratio: Σ of the per-user numerator.' },
    sumDen: { type: 'number', exclusiveMinimum: 0, description: 'ratio: Σ of the per-user denominator (must be > 0).' },
    sumNum2: { type: 'number', minimum: 0, description: 'ratio: Σ of numerator².' },
    sumDen2: { type: 'number', minimum: 0, description: 'ratio: Σ of denominator².' },
    sumNumDen: { type: 'number', description: 'ratio: Σ of numerator·denominator.' },
    sumY: { type: 'number', description: 'cuped: Σ of the per-user in-experiment value Y.' },
    sumY2: { type: 'number', minimum: 0, description: 'cuped: Σ of Y².' },
    sumX: { type: 'number', description: 'cuped: Σ of the per-user pre-experiment covariate X.' },
    sumX2: { type: 'number', minimum: 0, description: 'cuped: Σ of X².' },
    sumXY: { type: 'number', description: 'cuped: Σ of Y·X.' },
  };
  const label = { type: 'string', description: 'Group name (e.g. control, variant_b).' };
  const n = { type: 'integer', minimum: 1, description: 'Sample size (e.g. users in the group).' };

  // One metric's group arm (strict): label + n + exactly that metric's required fields.
  const arm = (fields, armDesc) => ({
    type: 'object', additionalProperties: false, required: ['n', ...Object.keys(fields)],
    description: armDesc,
    properties: { label, n, ...fields },
  });
  // Cross-metric multiplicity: p-values of the experiment's OTHER metrics join the
  // correction family, so a 10-metric scorecard cannot fish significance.
  const familyP = { type: 'array', items: { type: 'number', minimum: 0, maximum: 1 }, description: 'p-values of OTHER metrics in the same experiment readout — included in the multiplicity-correction family (Holm/BH) alongside the variants.' };
  const sequential = { type: 'boolean', description: 'Also compute an ALWAYS-VALID p per variant (mixture SPRT): p_value_sequential stays honest under repeated peeking at a RUNNING experiment, unlike the fixed-horizon p_value. proportion/mean only.' };
  const expectedEffect = { type: 'number', exclusiveMinimum: 0, description: 'Optional expected ABSOLUTE effect size — sets the sequential test\'s mixture prior scale (more power near this effect). Default: the observed sampling noise scale.' };
  // Whether a rise is good is a property of the METRIC, which the test cannot know: conversion up is
  // an improvement, crash rate or churn up is a regression. It changes no statistic — only how a
  // significant result is read (outcome: better | worse).
  const good = { enum: ['up', 'down'], default: 'up', description: 'Which direction of the metric is GOOD: up (conversion, revenue, retention) or down (crash rate, churn, load time, cost). Decides whether a significant change is an improvement or a regression; no statistic changes.' };

  // One metric branch of the union.
  const branch = (metric, branchDesc, fields, armDesc, extraProps = {}) => {
    const a = arm(fields, armDesc);
    return {
      type: 'object', additionalProperties: false, required: ['metric', 'control', 'variants'],
      description: branchDesc,
      properties: {
        metric: { enum: [metric] },
        confidence, alternative, correction, good,
        family_p_values: familyP,
        ...extraProps,
        control: a,
        variants: { type: 'array', minItems: 1, items: a, description: 'One or more variant groups, each tested against control.' },
      },
    };
  };
  // Top-level arm: lists EVERY metric's stat field (so clients see the full inner types and
  // any metric's group is expressible) but is still CLOSED — an unknown field is rejected.
  // The selected ab_test oneOf branch further pins the exact per-metric required set; this
  // closure also covers `experiment` (which composes these props WITHOUT the per-metric oneOf).
  const unionArm = { type: 'object', additionalProperties: false, required: ['n'], description: 'A group: n plus the stat fields the chosen metric needs.', properties: { label, n, ...F } };

  return {
    type: 'object',
    description: 'Two-sample (or multi-group) STATISTICAL SIGNIFICANCE test on PRE-AGGREGATED group stats — use it for ANY comparison of two groups, NOT only randomized A/B experiments. "control" and "variants" are just group A vs group B(…): e.g. mean time at first occurrence vs last occurrence, conversion of cohort X vs Y, before vs after. Don\'t hand-roll a t-test/z-test — compute per-group aggregates with a pipeline, then call this. The required group fields DEPEND ON metric (discriminated union): proportion → conversions+n (two-proportion z-test); mean → mean+stddev+n (Welch t-test); ratio → the five per-user sums sumNum/sumDen/sumNum2/sumDen2/sumNumDen (delta-method for ratio metrics whose analysis unit is finer than the randomization unit, e.g. completed/started or clicks/impressions per user); cuped → sumY/sumY2/sumX/sumX2/sumXY (CUPED variance reduction via a pre-period covariate, then Welch). Returns each variant vs control: lift (absolute+relative, with a relative-lift CI), test statistic, p-value, confidence interval, significance, and a multiplicity-adjusted p-value across the family.',
    required: ['metric', 'control', 'variants'],
    properties: {
      metric: { enum: ['proportion', 'mean', 'ratio', 'cuped'], description: 'Which test to run and which group fields are required: proportion→conversions; mean→mean,stddev; ratio→sumNum,sumDen,sumNum2,sumDen2,sumNumDen; cuped→sumY,sumY2,sumX,sumX2,sumXY.' },
      confidence, alternative, correction, good,
      family_p_values: familyP,
      sequential,
      expected_effect: expectedEffect,
      control: unionArm,
      variants: { type: 'array', minItems: 1, items: unionArm, description: 'One or more variant groups, each tested against control.' },
    },
    discriminator: { propertyName: 'metric' },
    oneOf: [
      branch('proportion', 'Conversion-rate test (two-proportion z-test): each group carries conversions out of n.',
        { conversions: F.conversions },
        'A group for a proportion test: n and the number of conversions.',
        { sequential, expected_effect: expectedEffect }),
      branch('mean', 'Continuous-metric test (Welch t-test): each group carries the per-user mean and stddev.',
        { mean: F.mean, stddev: F.stddev },
        'A group for a mean test: n, mean and stddev.',
        { sequential, expected_effect: expectedEffect }),
      branch('ratio', 'Ratio-metric test via the delta method: each group carries the per-user numerator/denominator sums plus their squares and cross-product.',
        { sumNum: F.sumNum, sumDen: F.sumDen, sumNum2: F.sumNum2, sumDen2: F.sumDen2, sumNumDen: F.sumNumDen },
        'A group for a ratio test: n and the five per-user sums (sumNum, sumDen, sumNum2, sumDen2, sumNumDen).'),
      branch('cuped', 'CUPED variance reduction (then Welch): each group carries the per-user sufficient sums of the in-experiment value Y and the pre-experiment covariate X.',
        { sumY: F.sumY, sumY2: F.sumY2, sumX: F.sumX, sumX2: F.sumX2, sumXY: F.sumXY },
        'A group for a CUPED test: n and the five per-user sufficient sums (sumY, sumY2, sumX, sumX2, sumXY).'),
    ],
  };
}

// ── Sample Ratio Mismatch guardrail ───────────────────────────────────────────
function srmCheckSchema() {
  return {
    type: 'object', additionalProperties: false, required: ['groups'],
    description: 'Sample Ratio Mismatch (SRM) guardrail: a χ² goodness-of-fit test that the OBSERVED per-group sample sizes match the intended split. A detected mismatch (p < 0.001) means randomization or logging is broken and the experiment is INVALID — run this BEFORE trusting any lift. Compute per-group n with a pipeline first.',
    properties: {
      groups: {
        type: 'array', minItems: 2, description: 'Observed groups with their sample sizes.',
        items: {
          type: 'object', additionalProperties: false, required: ['n'],
          properties: {
            label: { type: 'string', description: 'Group name (e.g. control, variant_b).' },
            n: { type: 'integer', minimum: 0, description: 'Observed sample size in this group.' },
          },
        },
      },
      expected_ratio: { type: 'array', minItems: 2, items: { type: 'number', exclusiveMinimum: 0 }, description: 'Intended split weights, same order as groups (e.g. [1,1] for 50/50, [2,1,1]). Defaults to an equal split.' },
    },
  };
}

// ── Power / sample-size planning ───────────────────────────────────────────────
//
// Discriminated union on `metric` (proportion needs baseline, mean needs stddev) and,
// within each branch, EXACTLY ONE of {mde, n} is required (provide mde → solve n;
// provide n → solve MDE). So neither "both" nor "neither" nor a mismatched dispersion
// field can be passed.
function sampleSizeSchema() {
  const power = { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1, default: 0.8, description: 'Desired statistical power (1−β).' };
  const confidence = { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1, default: 0.95, description: 'Confidence level (1−α).' };
  const alternative = { enum: ['two_sided', 'greater', 'less'], default: 'two_sided', description: 'Hypothesis direction.' };
  const mde = { type: 'number', exclusiveMinimum: 0, description: 'Absolute minimum detectable effect (e.g. +0.02 rate, or +1.5 revenue). Provide to solve for n.' };
  const n = { type: 'integer', minimum: 2, description: 'Sample size PER GROUP. Provide to solve for the MDE instead.' };
  const exactlyOneOfMdeN = [
    { required: ['mde'], not: { required: ['n'] } },
    { required: ['n'], not: { required: ['mde'] } },
  ];
  const baseline = { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1, description: 'proportion: baseline conversion rate.' };
  const stddev = { type: 'number', exclusiveMinimum: 0, description: 'mean: standard deviation of the metric.' };
  const dispersion = { proportion: baseline, mean: stddev };
  const branch = (metric, dispersionField, branchDesc) => ({
    type: 'object', additionalProperties: false,
    required: ['metric', dispersionField],
    description: branchDesc,
    properties: { metric: { enum: [metric] }, [dispersionField]: dispersion[metric], mde, n, power, confidence, alternative },
    oneOf: exactlyOneOfMdeN,
  });
  // Typed top-level `properties` (union of both metrics' fields) sits alongside the oneOf so
  // MCP clients send proper numbers (not JSON strings); the oneOf still enforces the exact
  // per-metric field set + exactly one of {mde, n}.
  return {
    type: 'object',
    description: 'Power / sample-size planning (no warehouse). Provide a target effect (mde) to get the required sample size PER GROUP, or a sample size (n) to get the minimum detectable effect (MDE) — exactly one of the two. metric=proportion needs a baseline rate; metric=mean needs a stddev. Use it to size a test up front and to tell a true null apart from an underpowered one.',
    required: ['metric'],
    properties: { metric: { enum: ['proportion', 'mean'], description: 'proportion → needs baseline; mean → needs stddev. Provide exactly one of mde (→ solve n) or n (→ solve MDE).' }, baseline, stddev, mde, n, power, confidence, alternative },
    discriminator: { propertyName: 'metric' },
    oneOf: [
      branch('proportion', 'baseline', 'Conversion-rate planning: needs a baseline rate, plus exactly one of mde or n.'),
      branch('mean', 'stddev', 'Continuous-metric planning: needs a stddev, plus exactly one of mde or n.'),
    ],
  };
}

// ── ONE experiment-lifecycle tool (action-driven), folding in plan/check_split/analyze ──
// Composes the three stat schemas' top-level fields under an `action` discriminator; each
// action requires its core fields here, and the engine delegates to the per-action handler
// which re-validates the exact (per-metric) field set. So the lifecycle is one tool, but the
// strict statistical contracts are preserved.
function experimentSchema() {
  const ab = abTestSchema();
  const srm = srmCheckSchema();
  const ss = sampleSizeSchema();
  const properties = {
    card: { type: 'boolean', description: 'Draw the result as a CARD for the person (the test, the split check or the plan), in hosts that render MCP Apps. Omitted: no card — ask for it only when the person should see this result.' },
    action: { enum: ['plan', 'check_split', 'analyze'], description: 'plan → required sample size / MDE (power planning, BEFORE running); check_split → Sample-Ratio-Mismatch χ² guardrail that the observed split is valid (run BEFORE trusting any lift); analyze → the A/B significance test on per-group aggregates.' },
    // union of all three actions' fields (analyze/ab_test wins on shared keys like metric).
    ...ss.properties,
    ...srm.properties,
    ...ab.properties,
  };
  return {
    type: 'object', additionalProperties: false, required: ['action'],
    description: 'The A/B EXPERIMENT lifecycle in ONE tool (action-driven): plan → check_split → analyze. plan = power/sample-size (how many users, or the MDE at a given n) BEFORE running; check_split = Sample-Ratio-Mismatch χ² guardrail (a bad split invalidates the experiment — run it BEFORE trusting any lift); analyze = the significance test on PRE-AGGREGATED per-group stats (metric: proportion → conversions, mean → mean+stddev, ratio → per-user sums, cuped → variance reduction), returning lift + p-value + CI + significance, multiplicity-adjusted across variants. Compute the per-group aggregates first with a pipeline.',
    allOf: [
      { if: { properties: { action: { const: 'plan' } }, required: ['action'] }, then: { required: ['metric'], properties: { metric: { enum: ['proportion', 'mean'] } } } },
      { if: { properties: { action: { const: 'check_split' } }, required: ['action'] }, then: { required: ['groups'] } },
      { if: { properties: { action: { const: 'analyze' } }, required: ['action'] }, then: { required: ['metric', 'control', 'variants'] } },
    ],
    properties,
  };
}


/** Attach the stages' `$defs` at a tool schema's root (where `#/$defs/…` references resolve). */
function withStageDefs(toolSchema, catalog) {
  const defs = stageDefs(catalog);
  return Object.keys(defs).length ? { ...toolSchema, $defs: { ...(toolSchema.$defs || {}), ...defs } } : toolSchema;
}
