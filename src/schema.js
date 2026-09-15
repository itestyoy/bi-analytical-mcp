// Build JSON Schemas for the tools, with enums projected from the catalog.
// Everything that names a column/property/event/attribute is an enum -> an AI
// literally cannot submit an unknown name (validated by ajv at the boundary).
//
// Every property carries a `description` so the meaning/purpose of each
// parameter is self-explanatory to the MCP client (the AI) without external docs.

import { pipelineStageSchema, stageDefs } from './pipeline.js';
import { strEnum, oneOfOr, withoutEmpty } from './schema-kit.js';

const NAME = '^[a-z][a-z0-9_]{0,40}$';
const TASK = '^[a-z][a-z0-9_]{2,40}$';
const CTX = '^[a-z0-9]{6,40}$';
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
  const opts = [{ const: '*', title: 'rows' }];
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
        source: { const: 'model_column', description: 'Use a physical table column as the dimension.' },
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
        source: { const: 'event_property', description: 'Take the dimension from an event_data property.' },
        property: strEnum(catalog.scalarEventProps(modelKey), `Scalar event_data property to expose as a dimension. NB: only populated on specific events (see semantic_index({ source: '${modelKey}', event })); NULL on others.`),
        as_type: { const: 'categorical', default: 'categorical', description: 'event_data dimensions are always categorical.' },
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
  const opts = [{ const: '*', title: 'rows' }];
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
      { title: 'model_column', type: 'object', additionalProperties: false, required: ['source', 'column'], description: 'Dimension from a physical column.', properties: { source: { const: 'model_column', description: 'Use a physical table column.' }, column: strEnum(cols, 'Physical column name.'), as_type: { enum: ['categorical', 'time'], description: 'Categorical attribute or time dimension.' }, grain: { enum: catalog.timeGranularities(), description: 'Time grain when as_type=time.' }, label: { type: 'string', description: D.label } } },
      { title: 'event_property', type: 'object', additionalProperties: false, required: ['source', 'property'], description: 'Dimension from a scalar event_data JSON property.', properties: { source: { const: 'event_property', description: 'Extract from event_data JSON.' }, property: strEnum(catalog.scalarEventPropEnum(), 'Scalar event_data property of the target semantic model\'s own source. NB: only populated on specific events (see semantic_index({ source, event })); NULL on others.'), as_type: { const: 'categorical', description: 'Always categorical.' }, label: { type: 'string', description: D.label } } },
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
    from: { const: modelKey, description: `Source model this semantic model is built from ("${modelKey}").` },
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
        { type: 'object', additionalProperties: false, required: ['kind', 'model', 'attribute'], description: 'A dimension addressed by WHERE IT LIVES: { kind: "dimension", model: "users", attribute: "country" } — the join path is resolved from the schema (add via when the source has several relationships to that model).', properties: { kind: { const: 'dimension', description: 'Filter on a dimension.' }, model: { enum: catalog.modelKeys(), description: 'The model that carries the attribute.' }, attribute: { type: 'string', description: 'The attribute (column) on that model.' }, via: { type: 'string', description: 'Optional relationship name when several lead to the model.' } } },
        { type: 'object', additionalProperties: false, required: ['kind'], description: 'The metric time axis.', properties: { kind: { const: 'metric_time', description: 'Filter on the metric time dimension.' }, grain: { enum: catalog.timeGranularities(), description: 'Time grain to bucket by.' } } },
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

export function buildSchemas(catalog) {
  const modelKeys = catalog.modelKeys();
  const create = {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'metrics'],
    description: 'Declaratively create/extend the semantic models + metrics for an analytics task inside an isolated context — the GOVERNED path. Produces NAMED metrics you query many ways with query_semantic_model (group_by / time / filters), reusably. Use this for measurable, re-sliceable metrics (DAU, revenue, conversion, retention). For a one-off derived TABLE (funnel/sessionization/window/pivot — things the governed metrics cannot express, read back with get_query_result), use build_native_model instead.',
    properties: {
      context_id: { type: 'string', pattern: CTX, description: D.context_id },
      name: { type: 'string', pattern: TASK, description: 'Task name (lowercase snake_case). Namespaces all measures/metrics so multiple tasks coexist in one context.' },
      description: { type: 'string', description: 'Free-text note describing what this task computes (metadata only).' },
      use_base_models: { type: 'array', items: { type: 'string', enum: catalog.joinableModelKeys() }, description: 'Additional source models to load so their attributes become groupable/filterable as { model, attribute } (e.g. "users" to slice by { model: "users", attribute: "country" }). Every source named in semantic_models[].from is loaded already — list here only a model you join TO but define no measures on. Measures from SEVERAL sources may live in one task (one semantic model each): each reaches the joined model by its own declared key. If that model is slowly-changing, the join is point-in-time automatically — MetricFlow applies its validity window, so nothing is stated here.' },
      semantic_models: { type: 'array', items: { oneOf: modelKeys.map((k) => semanticModelBranch(catalog, k)) }, description: 'Semantic model definitions (one per source model) carrying the measures/dimensions for this task.' },
      metrics: { type: 'array', minItems: 1, items: metricSchema(), description: 'The metrics to expose for querying (each references measures defined above).' },
      dry_run: { type: 'boolean', description: 'If true, validate and return the definition WITHOUT writing files or building anything.' },
      include_yaml: { type: 'boolean', description: 'Return the full rendered context YAML in the response (default false). The YAML is always written to the context files regardless; omit it to keep responses small.' },
    },
  };

  // register_native_model: build a derived dbt model from a declarative PIPELINE
  // (a pipe-syntax transformation, optionally ending in a match_recognize funnel)
  // and materialize it. The pipeline's rows ARE the result.
  const registerModel = {
    type: 'object', additionalProperties: false, required: ['name', 'pipeline'],
    description: 'Build a derived model from a PIPELINE: a `source` + ordered `stages` (where/derive/compute/unnest/join/aggregate/pivot/unpivot/sample/window/order_by/limit/project, and the match_recognize funnel stage). Its ROWS are the result — returned, and re-readable/sliceable via get_query_result. Funnels are pipelines too: add a match_recognize stage, then slice it with a downstream join/aggregate (e.g. conversion by country).',
    properties: {
      context_id: { type: 'string', pattern: CTX, description: D.context_id },
      name: { type: 'string', pattern: TASK, description: 'Model name (lowercase snake_case); generated as pipe_<name>.' },
      materialized: { enum: ['view', 'table'], default: 'table', description: 'How the result is stored: table (precomputed snapshot, default) or view (always fresh).' },
      dry_run: { type: 'boolean', description: 'If true, return the generated model definition for preview WITHOUT building anything.' },
      pipeline: {
        type: 'object', additionalProperties: false, required: ['source', 'stages'],
        description: 'The transformation pipeline: a `source` table + ordered `stages` applied left-to-right.',
        properties: {
          source: { type: 'string', enum: modelKeys, description: `Source table the pipeline reads. Always named: each source (${catalog.modelKeys().join(', ')}) has its own columns, events and payload, and they are never mixed.` },
          time_range: { type: 'object', additionalProperties: false, description: 'Restrict the pipeline to a time window on the source\'s time column (ISO dates), applied BEFORE the stages — avoids hand-written device_time literals and keeps whole-session windows intact.', properties: { start: { type: 'string', description: 'Inclusive start (ISO date/datetime).' }, end: { type: 'string', description: 'Inclusive end (ISO date/datetime; a date-only end means the WHOLE day).' }, timezone: { type: 'string', description: 'Optional IANA timezone (e.g. "Europe/Berlin"): start/end are read as wall-clock in this zone and converted to the UTC instants the warehouse stores. Omit for warehouse-native (UTC) bounds.' } } },
          stages: { type: 'array', minItems: 1, items: pipelineStageSchema(catalog), description: 'Ordered pipe stages; each transforms the previous output.' },
        },
      },
    },
  };

  // build_native_model: compose a pipeline INCREMENTALLY, one stage at a time. A
  // single stateful tool with an `action`; each add_step validates the stage and
  // returns the columns now available for the NEXT stage (schema only — nothing is
  // materialized until materialize). The all-at-once register_native_model still works.
  const trProp = { type: 'object', additionalProperties: false, description: 'Restrict the pipeline to a time window on the source\'s time column (ISO dates), applied BEFORE the stages.', properties: { start: { type: 'string', description: 'Inclusive start (ISO date/datetime).' }, end: { type: 'string', description: 'Inclusive end (ISO date/datetime; a date-only end means the WHOLE day).' }, timezone: { type: 'string', description: 'Optional IANA timezone: start/end are wall-clock in this zone, converted to UTC instants.' } } };
  // A then-clause fragment that forbids the named properties (valid only when ALL are absent).
  const forbid = (props) => ({ not: { anyOf: props.map((p) => ({ required: [p] })) } });
  const buildModel = {
    type: 'object', additionalProperties: false, required: ['action'],
    description: 'Compose a native pipeline model INCREMENTALLY, one stage at a time — a single tool driven by `action`. Each add_step validates the stage and returns the exact columns now available for the NEXT stage (pure schema; NOTHING is materialized until materialize), so you build with full visibility instead of guessing a whole pipeline up front. Lifecycle: start → add_step* → (optional preview) → materialize (builds + runs the model) → add_step* → materialize again. MATERIALIZE IS NOT THE END: the draft stays open and the table it built STANDS FOR the steps so far, so the steps you add next read THAT table instead of recomputing an expensive prefix (an aggregate, a python model). Editing a step at or before a materialized prefix retires it (the next materialize rebuilds from the source); editing a step after it keeps it. Each response says what it started from (from_checkpoint / steps_recomputed) and what it retired (checkpoints_dropped). WHEN TO USE: a one-off derived TABLE whose rows are the answer — funnels (match_recognize), sessionization, window functions, pivots, anything the governed metrics cannot express; read the rows back with get_query_result. For REUSABLE named metrics you query many ways (group_by / time / filters), use create_semantic_model instead (the governed path).',
    // Each action accepts ONLY its relevant fields: start takes name/source/materialized/
    // time_range (+ an optional draft_id to reuse a context); add_step takes draft_id+stage;
    // preview/materialize/discard take just draft_id. `forbid` rejects any field that does not
    // belong to the action, so a stray param is an error rather than silently ignored.
    allOf: [
      { if: { properties: { action: { const: 'start' } }, required: ['action'] }, then: { required: ['name', 'source'], ...forbid(['stage', 'stages', 'index', 'after']) } },
      { if: { properties: { action: { const: 'add_step' } }, required: ['action'] }, then: { required: ['draft_id', 'stage'], ...forbid(['name', 'source', 'materialized', 'time_range', 'index', 'after', 'stages']) } },
      { if: { properties: { action: { const: 'add_steps' } }, required: ['action'] }, then: { required: ['draft_id', 'stages'], ...forbid(['name', 'source', 'materialized', 'time_range', 'index', 'after', 'stage']) } },
      { if: { properties: { action: { enum: ['edit_step', 'insert_step'] } }, required: ['action'] }, then: { required: ['draft_id', 'index', 'stage'], ...forbid(['name', 'source', 'materialized', 'time_range', 'after', 'stages']) } },
      { if: { properties: { action: { const: 'delete_step' } }, required: ['action'] }, then: { required: ['draft_id', 'index'], ...forbid(['name', 'source', 'materialized', 'time_range', 'stage', 'stages', 'after']) } },
      { if: { properties: { action: { const: 'truncate' } }, required: ['action'] }, then: { required: ['draft_id', 'after'], ...forbid(['name', 'source', 'materialized', 'time_range', 'stage', 'stages', 'index']) } },
      { if: { properties: { action: { const: 'fork' } }, required: ['action'] }, then: { required: ['draft_id'], ...forbid(['source', 'materialized', 'time_range', 'stage', 'stages', 'index']) } },
      { if: { properties: { action: { enum: ['preview', 'materialize', 'discard'] } }, required: ['action'] }, then: { required: ['draft_id'], ...forbid(['name', 'source', 'materialized', 'time_range', 'stage', 'stages', 'index', 'after']) } },
    ],
    properties: {
      action: { enum: ['start', 'add_step', 'add_steps', 'edit_step', 'insert_step', 'delete_step', 'truncate', 'fork', 'preview', 'materialize', 'discard'], description: 'start a new draft (returns a draft_id + source columns); add_step appends ONE stage and returns the columns available after it; add_steps appends SEVERAL stages at once (applied in order) and returns a per-step breakdown of how each changed the data — atomic (all-or-nothing); edit_step replaces step `index`; insert_step inserts a stage BEFORE `index`; delete_step removes step `index`; truncate keeps only steps 1..`after` (cheap "go back to step N"); fork branches a NEW draft from steps 1..`after` of this draft (or an already-materialized pipeline) WITHOUT touching the original — iterate variants without re-typing the shared prefix; preview shows steps + the SQL that would actually run (from a materialized prefix when there is one); materialize builds the model AND keeps the draft, recording the built table as the prefix the next steps read; discard drops the draft. Every edit revalidates the whole pipeline end-to-end and reports the failing step if an edit breaks a later one. PREFER add_step or SMALL add_steps chunks over one giant add_steps, so you see how each chunk changes the data.' },
      draft_id: { type: 'string', pattern: CTX, description: 'Draft handle returned by start (it is a context_id). Required for everything except start. For fork it may also be a context whose pipeline was already materialized.' },
      name: { type: 'string', pattern: TASK, description: 'Model name (lowercase snake_case); generated as pipe_<name>. Required for start; optional for fork (defaults to the source draft\'s name).' },
      materialized: { enum: ['view', 'table'], default: 'table', description: 'How the result is stored when materialized (chosen at start): table (default) or view.' },
      source: { type: 'string', enum: modelKeys, description: `Source table the pipeline reads (start only, and REQUIRED there). Each source (${catalog.modelKeys().join(', ')}) has its own columns, events and payload, and they are never mixed.` },
      time_range: trProp,
      stage: { ...pipelineStageSchema(catalog), description: 'ONE pipe stage — appended (add_step), or placed at `index` (edit_step/insert_step), validated against the columns available at that point.' },
      stages: { type: 'array', minItems: 1, items: pipelineStageSchema(catalog), description: 'Several pipe stages to append IN ORDER (add_steps). Applied sequentially; the response reports each stage\'s effect on the data. Keep this to a small LOGICAL chunk — do NOT dump the whole pipeline at once.' },
      index: { type: 'integer', minimum: 1, description: 'Target step (1-based, per steps[].index) for edit_step / insert_step / delete_step. insert_step places the stage BEFORE this position (count+1 appends).' },
      after: { type: 'integer', minimum: 0, description: 'Keep steps 1..after — for truncate (drop the rest) and fork (copy that prefix into the new draft). 0 = none; omit on fork to copy all steps.' },
      include_columns: { type: 'boolean', description: 'start/add_step/edit ops: also return the FULL available_columns list. Off by default — the per-step response returns only the diff (columns_added + columns_removed_count, with the removed names only when short) to avoid re-dumping the whole schema each step; use preview for the full list too.' },
      include_steps: { type: 'boolean', description: 'add_step only: also return the FULL steps array. Off by default — add_step is append-only, so it echoes just the applied `step` + `steps_count` (you already have the earlier steps); pass true, or use preview, when you need the whole pipeline back.' },
    },
  };

  const pdefs = predicateDefs(catalog);
  const query = {
    type: 'object',
    additionalProperties: false,
    required: ['context_id'],
    description: 'Run a metric query against a context.',
    $defs: pdefs,
    properties: {
      context_id: { type: 'string', pattern: CTX, description: D.context_id },
      task: { type: 'string', description: 'Optional task name hint (disambiguates when a context holds several tasks).' },
      metrics: { type: 'array', minItems: 1, items: { type: 'string' }, description: 'Metric names to fetch (as exposed by the context, e.g. task_<metric>).' },
      group_by: {
        type: 'array',
        description: 'How to break the metrics down. Two forms only: { time: "metric_time", grain } for a time series, and { model, attribute } for an attribute addressed by WHERE IT LIVES — the join path is resolved from the schema (add via: "<relationship>" when the source carries several relationships to that model). The owning model must be in use_base_models. No path strings.',
        items: {
          oneOf: [
            { type: 'object', additionalProperties: false, required: ['time'], description: 'Group by the metric time axis at a grain.', properties: { time: { const: 'metric_time', description: 'The metric time dimension.' }, grain: { enum: catalog.timeGranularities(), description: 'Time bucket size.' } } },
            { type: 'object', additionalProperties: false, required: ['model', 'attribute'], description: 'An attribute addressed by where it lives: { model: "users", attribute: "country" }. semantic_index() lists every one under groupable_attributes; create_semantic_model returns the context\'s under groupable. The response echoes the resolved column under group_by_resolved.', properties: { model: { enum: catalog.modelKeys(), description: 'The model that carries the attribute.' }, attribute: { type: 'string', description: 'The attribute (column or task dimension) on that model, as semantic_index({ model }) lists it.' }, via: { type: 'string', description: 'Optional: the relationship to reach the model through, when there are several (key variants).' } } },
          ],
        },
      },
      where: { $ref: '#/$defs/predicateGroup', description: 'Row filter applied before aggregation (boolean tree of conditions on dimensions / metric_time).' },
      order_by: { type: 'array', description: 'Sort order. Each key is a requested metric name, a RESULT COLUMN of this query ("metric_time_day", "users_country" — the names the rows come back with; "metric_time" is an alias of the time column), or a group_by attribute as { model, attribute }.', items: { type: 'object', additionalProperties: false, required: ['key'], properties: { key: { oneOf: [{ type: 'string', description: 'A requested metric name, a result column name (e.g. "users_country", "metric_time_day"), or "metric_time".' }, { type: 'object', additionalProperties: false, required: ['model', 'attribute'], properties: { model: { enum: catalog.modelKeys() }, attribute: { type: 'string' }, via: { type: 'string' } }, description: 'A group_by attribute, addressed as in group_by.' }] }, direction: { enum: ['asc', 'desc'], description: 'Sort direction (default asc).' } } } },
      time_range: { type: 'object', additionalProperties: false, description: 'Restrict to a metric_time range (ISO dates). Unbounded queries scan the whole history — always bound when exploring.', properties: { start: { type: 'string', description: 'Inclusive start (ISO date/datetime).' }, end: { type: 'string', description: 'Inclusive end (ISO date/datetime; a date-only end means the WHOLE day).' }, timezone: { type: 'string', description: 'Optional IANA timezone (e.g. "Europe/Berlin"): start/end are read as wall-clock in this zone and converted to the UTC instants the warehouse stores. Omit for warehouse-native (UTC) bounds.' } } },
      limit: { type: 'integer', minimum: 1, maximum: 100000, description: 'Max rows to return (default 1000).' },
      offset: { type: 'integer', minimum: 0, description: 'Rows to skip from the start (paging).' },
      materialize: { type: 'boolean', description: 'Materialize the result and read rows back from it (resilient, re-fetchable). The table holds the WHOLE result — `limit`/`offset` page the rows you get back, and get_query_result transforms run over all of it. Slow queries (> timeout) return a query_id; poll get_query_result.' },
      dry_run: { type: 'boolean', description: 'If true, validate and return the compiled query WITHOUT executing it.' },
      explain: { type: 'boolean', description: 'If true, return the query plan (how the metrics compile) and the compiled query WITHOUT executing. A superset of dry_run; useful for inspecting/optimizing.' },
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
    description: 'Manage isolated execution contexts (the workspaces create_semantic_model / build_native_model produce). action: list (all contexts) | describe (one context\'s tasks/models/metrics/group-by paths) | drop (tear the whole context down) | delete_model (remove just the native pipeline model, keep the context) | delete_semantic_model (remove one table\'s task additions, with cascade for dependent metrics).',
    allOf: [
      { if: { properties: { action: { const: 'list' } }, required: ['action'] }, then: forbid(['context_id', 'semantic_model', 'cascade', 'force']) },
      { if: { properties: { action: { enum: ['describe', 'delete_model'] } }, required: ['action'] }, then: { required: ['context_id'], ...forbid(['semantic_model', 'cascade', 'force']) } },
      { if: { properties: { action: { const: 'drop' } }, required: ['action'] }, then: { required: ['context_id'], ...forbid(['semantic_model', 'cascade']) } },
      { if: { properties: { action: { const: 'delete_semantic_model' } }, required: ['action'] }, then: { required: ['context_id', 'semantic_model'], ...forbid(['force']) } },
    ],
    properties: {
      action: { enum: ['list', 'describe', 'drop', 'delete_model', 'delete_semantic_model'], description: 'list → all active contexts; describe → one context in depth; drop → tear down the whole context; delete_model → remove the native pipeline model only; delete_semantic_model → remove one model\'s task additions.' },
      context_id: { type: 'string', pattern: CTX, description: `${D.context_id} Required for every action except list.` },
      semantic_model: { type: 'string', enum: modelKeys, description: 'delete_semantic_model: which model\'s task additions to remove.' },
      cascade: { type: 'boolean', description: 'delete_semantic_model: also remove metrics that depend on the removed measures.' },
      force: { type: 'boolean', description: 'drop: tear the context down even though another draft READS a table it built (a fork that inherited a materialized prefix). Those drafts then have to recompute that prefix from the source.' },
    },
  };

  return {
    create_semantic_model: create,
    // Stage schemas may reference root-level definitions (the recursive python body): hoist them.
    register_native_model: withStageDefs(registerModel, catalog),
    build_native_model: withStageDefs(buildModel, catalog),
    delete_native_model: { ...ctxRef, description: 'Delete the registered native model in a context (remove its view + semantic model) and re-parse.' },
    context: contextTool,
    query_semantic_model: query,
    get_query_result: {
      type: 'object', additionalProperties: false,
      // Either poll by query_id (context_id not needed — taken from the job), or
      // fetch a known table directly (which requires its context_id).
      anyOf: [{ required: ['query_id'] }, { required: ['table', 'context_id'] }],
      description: 'Poll a background (materialized) query by query_id, or fetch a known result table directly by {context_id, table}; optionally re-slice it with a read-only transform.',
      properties: {
        context_id: { type: 'string', pattern: CTX, description: D.context_id },
        query_id: { type: 'string', pattern: '^[a-f0-9]{8,16}$', description: 'ID returned by a backgrounded materialize query; poll it for status + results.' },
        table: { type: 'string', pattern: '^(qr_[a-f0-9]{8,16}|pipe_[a-z][a-z0-9_]{0,80})$', description: 'A known result table to read directly (its name is returned by a prior materialize or register call) — works even if the job record is gone.' },
        limit: { type: 'integer', minimum: 1, maximum: 100000, description: 'Max rows to return (default 1000).' },
        offset: { type: 'integer', minimum: 0, description: 'Rows to skip from the start (paging over the stored result). Ignored when sample=true.' },
        sample: { type: 'boolean', description: 'If true, return a REPRESENTATIVE random subset of rows instead of the first rows — a better peek at large results.' },
        sample_percent: { type: 'number', exclusiveMinimum: 0, maximum: 100, description: 'Approximate % of rows to sample when sample=true (default 10).' },
        transform: {
          type: 'object', additionalProperties: false,
          description: 'Optional read-only re-slice of the stored result (compress/aggregate/filter it WITHOUT recomputing the original query).',
          properties: {
            where: { type: 'array', description: 'Row filters on result columns.', items: { type: 'object', additionalProperties: false, required: ['column', 'op'], properties: { column: { type: 'string', description: 'Result column to filter.' }, op: { enum: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'is_null', 'is_not_null'], description: 'Comparison operator.' }, value: { description: 'Comparison value (array for in/not_in).' } } } },
            group_by: { type: 'array', items: { type: 'string' }, description: 'Result columns to group by before aggregating.' },
            aggregations: { type: 'array', description: 'Aggregations to compute over the (grouped) result.', items: { type: 'object', additionalProperties: false, required: ['fn'], properties: { fn: { enum: ['sum', 'avg', 'min', 'max', 'count', 'count_distinct'], description: 'Aggregate function.' }, column: { type: 'string', description: 'Column to aggregate (omit for count).' }, as: { type: 'string', description: 'Output column alias.' } } } },
            having: { type: 'array', description: 'Post-aggregation filters on aggregate values.', items: { type: 'object', additionalProperties: false, required: ['fn', 'op', 'value'], properties: { fn: { enum: ['sum', 'avg', 'min', 'max', 'count', 'count_distinct'], description: 'Aggregate function to test.' }, column: { type: 'string', description: 'Column the aggregate applies to.' }, op: { enum: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'], description: 'Comparison operator.' }, value: { description: 'Threshold value.' } } } },
            order_by: { type: 'array', description: 'Sort the projected output.', items: { type: 'object', additionalProperties: false, required: ['key'], properties: { key: { type: 'string', description: 'Column/alias to sort by.' }, direction: { enum: ['asc', 'desc'], description: 'Sort direction.' } } } },
            limit: { type: 'integer', minimum: 1, maximum: 100000, description: 'Max rows after projection.' },
          },
        },
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
      description: 'Wait for `seconds` (capped at 60), then return. Use it to PACE background work: after a materialized/long query returns a query_id, call time to wait an interval, then poll get_query_result — repeat until ready. Purely a timer; it touches no data.',
      properties: {
        seconds: { type: 'number', minimum: 0, maximum: 86400, description: 'Seconds to wait; the actual wait is capped at 60 (larger values are clamped, with clamped:true in the result).' },
        reason: { type: 'string', description: 'Optional note on what you are waiting for (echoed back; metadata only).' },
      },
    },
    experiment: experimentSchema(),
    memory: memorySchema(catalog),
    ab_test: abTestSchema(),
    srm_check: srmCheckSchema(),
    sample_size: sampleSizeSchema(),
  };
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

  const branches = [
    view('overview (no arguments)', 'OVERVIEW (no arguments): models, each source\'s events, group-by paths, value-index freshness, recipe ids.', [], {}),
    view('{ model }', 'VIEW { model }: one model — its entities, time axis, dimension attributes with real sample values, physical columns, declared relationships and aggregatable amounts.', ['model'], {
      model: { enum: [...models, ...unavailable], description: 'The model to describe.' },
    }),
    // one branch per source: an event name belongs to the source that declares it, so a pairing
    // that source does not have cannot be written down.
    ...catalog.facts.map((f) => view('{ source, event }', `VIEW { source: '${f}', event }: the properties POPULATED on that event of '${f}'.`, ['source', 'event'], {
      source: { const: f, description: `The events source '${f}'.` },
      event: eventRef(f),
    })),
    // A column is ALWAYS asked for within its source — one branch per model, no source-less form.
    ...models.map((k) => view('{ source, property }', `VIEW { source: '${k}', property }: one column of '${k}' — its meaning, real value distribution (pageable), NULL coverage and indexing freshness.`, ['source', 'property'], {
      source: { const: k, description: `The source '${k}'.` },
      property: propRef(k),
      ...paging,
    })),
    view('{ search }', 'VIEW { search }: find events, properties, attributes, indexed VALUES and recipes by word — typo- and paraphrase-tolerant.', ['search'], {
      search: { type: 'string', description: 'The word or phrase to look for.' },
      fuzzy: { type: 'boolean', description: 'Enable typo/approximate matching (default true); false = exact substring only.' },
      limit: paging.limit,
    }),
    view('{ status }', 'VIEW { status }: operational state — value-index sync runs (freshness, errors, slowest properties) and background query jobs.', ['status'], {
      status: { const: true, description: 'Ask for the operational state.' },
      recent: paging.recent,
    }),
    view('{ run }', 'VIEW { run }: one sync run by id — its per-property breakdown, slowest first.', ['run'], {
      run: { type: 'integer', minimum: 1, description: 'Run id, from the status view.' },
      recent: paging.recent,
    }),
    ...(bundleSources.length ? [view('{ bundle }', 'VIEW { bundle }: for ONE app — which properties carry data for it vs are EMPTY.', ['bundle'], {
      bundle: { type: 'string', description: 'The app/bundle id; the overview lists them.' },
      source: { enum: bundleSources, description: 'Which source to read the per-app coverage of (needed when several declare an app column).' },
    })] : []),
    view('{ recipe }', 'VIEW { recipe }: ONE ready-made recipe by id — its payload, example queries and the reusable hack.', ['recipe'], {
      recipe: { type: 'string', description: 'Recipe id, from the overview.' },
    }),
    view('{ guide }', 'VIEW { guide }: HOW to approach a question — the analyst workflow and IF/DO routing; pass a task family to narrow it.', ['guide'], {
      guide: { type: ['boolean', 'string'], description: 'true for the whole guide, or a task family name.' },
    }),
  ];
  return {
    // Every tool's input is an OBJECT; the MCP handshake validates that on the root schema,
    // so `oneOf` narrows the shape but never replaces it.
    type: 'object',
    description: 'THE data-exploration entry point — call it FIRST and whenever unsure what a field means. One progressive index over meaning + real values + completeness + freshness. Pass NO arguments for the overview, then exactly ONE view: { model } | { source, event } | { source, property } | { search } | { status } | { run } | { bundle } | { recipe } | { guide }. Each view below lists what it takes; a source and a name are separate fields, never glued into one string.',
    oneOf: branches,
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
    properties: { action: { const: act }, ...props },
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

  // One metric branch of the union.
  const branch = (metric, branchDesc, fields, armDesc, extraProps = {}) => {
    const a = arm(fields, armDesc);
    return {
      type: 'object', additionalProperties: false, required: ['metric', 'control', 'variants'],
      description: branchDesc,
      properties: {
        metric: { const: metric },
        confidence, alternative, correction,
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
      confidence, alternative, correction,
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
    properties: { metric: { const: metric }, [dispersionField]: dispersion[metric], mde, n, power, confidence, alternative },
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
