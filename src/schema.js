// Build JSON Schemas for the tools, with enums projected from the catalog.
// Everything that names a column/property/event/attribute is an enum -> an AI
// literally cannot submit an unknown name (validated by ajv at the boundary).
//
// Every property carries a `description` so the meaning/purpose of each
// parameter is self-explanatory to the MCP client (the AI) without external docs.

import { stageSchemas } from './pipeline.js';

const NAME = '^[a-z][a-z0-9_]{0,40}$';
const TASK = '^[a-z][a-z0-9_]{2,40}$';
const CTX = '^[a-z0-9]{6,40}$';
const WINDOW = '^[0-9]+ (second|minute|hour|day|week|month|quarter|year)s?$';

// Reusable property-description strings (kept consistent across tools).
const D = {
  context_id: 'ID of the isolated execution context to operate in. Omit on create to start a NEW context (a fresh, isolated dbt overlay); pass an existing id to extend/query that same context. Every context has its own semantic models, generated SQL and target dir, so parallel tasks never collide.',
  measure_name: 'Unique measure name within the task (lowercase snake_case). Referenced by metrics; the final queryable name is prefixed with the task, e.g. task_<name>.',
  agg: 'Aggregation applied to `field` to form the measure: count (rows), count_distinct (unique values of an entity key — required for conversion/funnel user counts), sum, average, median, min, max, percentile (needs `percentile`), sum_boolean (counts rows where a boolean/condition holds).',
  percentile: 'Percentile in (0,1), e.g. 0.95 for p95. Required when agg=percentile.',
  label: 'Human-readable label shown in BI tools / metadata. Defaults to the name when omitted.',
  event_name: 'Event scope for THIS measure: only rows whose event_name is in this list are aggregated. This is how a funnel/conversion step is pinned to a specific event. Overrides the semantic model\'s event_scope.',
  where_measure: 'Per-measure conditions on event_data JSON properties, ANDed with the event scope. Used to define a funnel step as event + property value (e.g. event_name=tutorial AND step_id=step_1).',
};

function whereItemSchema(catalog) {
  return {
    type: 'object', additionalProperties: false, required: ['property', 'op'],
    description: 'One condition on a SCALAR event_data property (array/struct properties must be reduced via a prepare stage first).',
    properties: {
      property: { type: 'string', enum: catalog.scalarEventProps(), description: 'Scalar event_data property to test.' },
      op: { enum: ['eq', 'neq', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte'], description: 'Comparison operator. Use in/not_in with an array value; the rest take a scalar.' },
      value: { description: 'Literal value(s) to compare against. Scalar for eq/neq/gt/gte/lt/lte; array for in/not_in. Always bound as a parameter/escaped literal (never interpolated as SQL).' },
    },
  };
}

// Sequence-step condition: a scalar event_data property OR a prepare-derived
// column (validated at render against the prepare columns + scalar props).
function seqWhereItem(catalog) {
  return {
    type: 'object', additionalProperties: false, required: ['property', 'op'],
    description: 'A step condition on a scalar event_data property or a prepare-derived column.',
    properties: {
      property: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,40}$', description: 'Scalar event_data property or a prepare-derived column name.' },
      op: { enum: ['eq', 'neq', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte'], description: 'Comparison operator.' },
      value: { description: 'Literal value(s); array for in/not_in.' },
    },
  };
}

function measureFieldSchema(catalog, modelKey) {
  const opts = [{ const: '*', title: 'rows' }];
  const keys = catalog.entityKeyColumns(modelKey);
  if (keys.length) opts.push({ type: 'string', enum: keys, title: 'entity_key' });
  if (modelKey === catalog.anchor) {
    const nums = catalog.eventNumericProps();
    if (nums.length) opts.push({ type: 'string', enum: nums, title: 'event_property_numeric' });
  } else {
    // numeric model columns are rare in dims; allow none by default
  }
  return { description: 'What to aggregate: "*" (count rows), an entity-key column (for count_distinct of users/sessions), or a numeric event_data property (for sum/average/etc.).', oneOf: opts };
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
  if (modelKey === catalog.anchor) {
    branches.push({
      title: 'event_property',
      type: 'object',
      additionalProperties: false,
      required: ['source', 'property'],
      description: 'A dimension extracted from a JSON event_data property (e.g. level_id, product_id) so you can group/filter by it.',
      properties: {
        source: { const: 'event_property', description: 'Extract the dimension from the event_data JSON column.' },
        property: { type: 'string', enum: catalog.scalarEventProps(), description: 'Scalar event_data property key to expose as a categorical dimension.' },
        as_type: { const: 'categorical', default: 'categorical', description: 'event_data dimensions are always categorical.' },
        label: { type: 'string', description: D.label },
      },
    });
  }
  return { type: 'object', description: 'A dimension to add to the semantic model (a column or an event_data property) for grouping/filtering.', oneOf: branches };
}

// Generic (model-agnostic) item schemas for `update`, where the target model is
// already fixed by `semantic_model`. Field names are still catalog-constrained;
// exact model/field coupling is re-checked in compile.
function genericMeasureField(catalog) {
  const opts = [{ const: '*', title: 'rows' }];
  const keys = [...new Set(catalog.modelKeys().flatMap((k) => catalog.entityKeyColumns(k)))];
  if (keys.length) opts.push({ type: 'string', enum: keys, title: 'entity_key' });
  const nums = catalog.eventNumericProps();
  if (nums.length) opts.push({ type: 'string', enum: nums, title: 'numeric' });
  return { description: 'What to aggregate: "*", an entity-key column, or a numeric event_data property.', oneOf: opts };
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
      label: { type: 'string', description: D.label },
      event_name: { type: 'array', minItems: 1, items: { type: 'string', enum: catalog.eventNames() }, description: D.event_name },
      where: { type: 'array', description: D.where_measure, items: whereItemSchema(catalog) },
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
      { title: 'model_column', type: 'object', additionalProperties: false, required: ['source', 'column'], description: 'Dimension from a physical column.', properties: { source: { const: 'model_column', description: 'Use a physical table column.' }, column: { type: 'string', enum: cols, description: 'Physical column name.' }, as_type: { enum: ['categorical', 'time'], description: 'Categorical attribute or time dimension.' }, grain: { enum: catalog.timeGranularities(), description: 'Time grain when as_type=time.' }, label: { type: 'string', description: D.label } } },
      { title: 'event_property', type: 'object', additionalProperties: false, required: ['source', 'property'], description: 'Dimension from a scalar event_data JSON property.', properties: { source: { const: 'event_property', description: 'Extract from event_data JSON.' }, property: { type: 'string', enum: catalog.scalarEventProps(), description: 'Scalar event_data property key.' }, as_type: { const: 'categorical', description: 'Always categorical.' }, label: { type: 'string', description: D.label } } },
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
      label: { type: 'string', description: D.label },
      ...(modelKey === catalog.anchor
        ? {
            event_name: { type: 'array', minItems: 1, items: { type: 'string', enum: catalog.eventNames() }, description: D.event_name },
            where: {
              type: 'array',
              description: D.where_measure,
              items: whereItemSchema(catalog),
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
  const props = {
    from: { const: modelKey, description: `Source dbt model this semantic model is built from ("${modelKey}").` },
    dimensions: { type: 'array', items: dimensionItemSchema(catalog, modelKey), description: 'Dimensions (columns or event_data properties) to expose for grouping/filtering.' },
    measures: { type: 'array', items: measureItemSchema(catalog, modelKey), description: 'Measures (aggregations) defined on this model; metrics reference these by name.' },
  };
  if (modelKey === catalog.anchor) {
    props.event_scope = {
      type: 'object',
      additionalProperties: false,
      description: 'Default event filter applied to ALL measures in this semantic model (each measure can still narrow further via its own event_name). Use when the whole task concerns one event type.',
      properties: {
        event_name: { type: 'array', minItems: 1, items: { type: 'string', enum: catalog.eventNames() }, description: 'Events that scope every measure here.' },
      },
    };
  }
  return { type: 'object', additionalProperties: false, required: ['from'], description: `Semantic model built on the "${modelKey}" dbt model.`, properties: props };
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
  const paths = catalog.reachableGroupByPaths();
  return {
    fieldRef: {
      type: 'object',
      // `path` is validated per-context in the handler (task dims are not a
      // static enum); `_paths` documents the catalog-reachable join paths.
      _reachable_paths: paths,
      description: 'The field a condition applies to: a dimension path or the metric time axis.',
      oneOf: [
        { type: 'object', additionalProperties: false, required: ['kind', 'path'], description: 'A dimension, addressed by its (possibly entity-qualified) path.', properties: { kind: { const: 'dimension', description: 'Filter on a dimension.' }, path: { type: 'string', description: 'Dimension path: a task-local dimension name, or an entity-qualified join path like user__country. Validated against the context.' } } },
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
  // Attribute columns available for filter.user_segment = dimensions of the
  // joinable (non-anchor) dimension models — derived from the catalog, not a
  // hardcoded model key.
  const userAttrCols = [...new Set(catalog.joinableModelKeys().flatMap((k) => catalog.modelDimensionColumns(k)))];
  const sequenceStep = {
    type: 'object', additionalProperties: false, required: ['name', 'event_name'],
    description: 'One ordered step of the sequence/funnel: an event (optionally narrowed by event_data property values).',
    properties: {
      name: { type: 'string', pattern: NAME, description: 'Step name (lowercase snake_case); used in generated columns/metrics like reached_<name>.' },
      event_name: { type: 'array', minItems: 1, items: { type: 'string', enum: catalog.eventNames() }, description: 'Event(s) that constitute this step.' },
      where: { type: 'array', description: 'Conditions on a scalar event_data property or a prepare-derived column that further define the step (e.g. step_id=step_1).', items: seqWhereItem(catalog) },
    },
  };
  const create = {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'metrics'],
    description: 'Declaratively create/extend the semantic models + metrics for an analytics task inside an isolated context.',
    properties: {
      context_id: { type: 'string', pattern: CTX, description: D.context_id },
      name: { type: 'string', pattern: TASK, description: 'Task name (lowercase snake_case). Namespaces all measures/metrics so multiple tasks coexist in one context.' },
      description: { type: 'string', description: 'Free-text note describing what this task computes (metadata only).' },
      use_base_models: { type: 'array', items: { type: 'string', enum: catalog.joinableModelKeys() }, description: 'Additional dbt models to load so their dimensions become joinable (e.g. "users" to slice by country/platform). The events anchor is always available.' },
      semantic_models: { type: 'array', items: { oneOf: modelKeys.map((k) => semanticModelBranch(catalog, k)) }, description: 'Semantic model definitions (one per source dbt model) carrying the measures/dimensions for this task.' },
      metrics: { type: 'array', minItems: 1, items: metricSchema(), description: 'The metrics to expose for querying (each references measures defined above).' },
      dry_run: { type: 'boolean', description: 'If true, render and validate the YAML and return it WITHOUT writing files or running dbt.' },
    },
  };

  // register_native_model: build a derived dbt model (e.g. a MATCH_RECOGNIZE sequence
  // VIEW) and expose it to the semantic layer — kept SEPARATE from the semantic
  // query so the row-pattern SQL and MetricFlow don't get mixed up.
  const registerModel = {
    type: 'object', additionalProperties: false, required: ['name', 'sequence'],
    description: 'Build a derived dbt model from a sequence spec (MATCH_RECOGNIZE funnel/path, BigQuery target) materialized as a view, plus a semantic model on top — so its metrics/dimensions become queryable like any other model.',
    properties: {
      context_id: { type: 'string', pattern: CTX, description: D.context_id },
      name: { type: 'string', pattern: TASK, description: 'Native model name (lowercase snake_case); the generated model is seq_<name>.' },
      kind: { enum: ['match_recognize'], default: 'match_recognize', description: 'Derived-model engine. Only row-pattern (MATCH_RECOGNIZE) sequences are supported.' },
      materialized: { enum: ['view', 'table'], default: 'view', description: 'dbt materialization of the generated model: view (default, always fresh) or table (precomputed snapshot).' },
      dry_run: { type: 'boolean', description: 'If true, return the generated SQL + semantic YAML WITHOUT building anything.' },
      sequence: {
        type: 'object', additionalProperties: false, required: ['steps'],
        description: 'Ordered steps (each = event + optional event_data property), partitioned by user/session, with optional sequence metrics.',
        properties: {
          partition_by: { enum: ['user', 'session'], default: 'user', description: 'Partition the row-pattern match per user or per session.' },
          mode: { enum: ['ordered', 'strict'], default: 'ordered', description: 'ordered = steps in order but other events may occur between them (gaps allowed); strict = each step must be the immediately next event (BigQuery target only).' },
          filter: {
            type: 'object', additionalProperties: false,
            description: 'Optional PRE-FILTER applied to the events BEFORE the row-pattern match — slices the data scanned so the build/query runs faster. It narrows the population only; it does NOT redefine the steps.',
            properties: {
              time_range: { type: 'object', additionalProperties: false, description: 'Restrict the scan to an event-time window (ISO dates). Biggest speed-up — prunes by date.', properties: { start: { type: 'string', description: 'Inclusive start (ISO date/datetime).' }, end: { type: 'string', description: 'Inclusive end (ISO date/datetime).' } } },
              event_name: { type: 'array', minItems: 1, items: { type: 'string', enum: catalog.eventNames() }, description: 'Only scan these events; drop all other event rows before matching. In ordered mode this is a safe, large speed-up (the funnel only depends on the step events).' },
              where: { type: 'array', description: 'event_data property conditions ANDed across the WHOLE scan. Use only for properties present on every scanned event (else rows lacking the property are dropped).', items: whereItemSchema(catalog) },
              user_segment: { type: 'array', description: 'Keep only events whose user matches these dim_users attributes (a semi-join FILTER — no columns are carried into the view; attributes for grouping still come from the semantic-layer join). E.g. country=US to build the funnel for one segment.', items: { type: 'object', additionalProperties: false, required: ['property', 'op'], properties: { property: { type: 'string', enum: userAttrCols, description: 'dim_users attribute to filter on.' }, op: { enum: ['eq', 'neq', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte'], description: 'Comparison operator (array value for in/not_in).' }, value: { description: 'Literal value(s) to match.' } } } },
            },
          },
          prepare: {
            type: 'array',
            description: 'Optional ORDERED data-prep pipeline applied (after filter) BEFORE the row-pattern match — a chain of transform stages that prepare the dataset (e.g. derive a scalar from an array/struct property, or unnest an array). Each stage builds on the previous; the columns they add are referenceable in step `where` and agg_at_step metrics. Use this for complex (array / array-of-struct) event_data properties, which cannot be used directly.',
            items: stageSchemas(catalog, ['derive', 'unnest']),
          },
          steps: { type: 'array', minItems: 2, items: sequenceStep, description: 'The ordered funnel steps (>= 2).' },
          metrics: {
            type: 'array',
            description: 'Sequence metrics computed in the view and aggregated by the semantic model. If omitted, defaults to a reached-count per step.',
            items: {
              type: 'object', additionalProperties: false, required: ['name', 'type'],
              description: 'A metric over each user\'s matched sequence.',
              properties: {
                name: { type: 'string', pattern: NAME, description: 'Metric name (lowercase snake_case).' },
                type: { enum: ['reached', 'completed', 'conversion', 'avg_seconds_between', 'agg_at_step'], description: 'reached: users reaching `step`; completed: users reaching the last step; conversion: reached(to)/reached(from); avg_seconds_between: mean seconds from `from` to `to`; agg_at_step: aggregate a `property` captured at `step`.' },
                step: { type: 'string', description: 'Target step name (for reached / agg_at_step).' },
                from: { type: 'string', description: 'Origin step name (for conversion / avg_seconds_between).' },
                to: { type: 'string', description: 'Destination step name (for conversion / avg_seconds_between).' },
                agg: { enum: ['sum', 'avg', 'min', 'max'], description: 'Aggregation for agg_at_step.' },
                property: { type: 'string', pattern: NAME, description: 'Scalar event_data property OR a prepare-derived column to aggregate for agg_at_step.' },
              },
            },
          },
        },
      },
    },
  };

  const pdefs = predicateDefs(catalog);
  const query = {
    type: 'object',
    additionalProperties: false,
    required: ['context_id'],
    description: 'Run a metric query (MetricFlow / dbt Core) against a context.',
    $defs: pdefs,
    properties: {
      context_id: { type: 'string', pattern: CTX, description: D.context_id },
      task: { type: 'string', description: 'Optional task name hint (disambiguates when a context holds several tasks).' },
      metrics: { type: 'array', minItems: 1, items: { type: 'string' }, description: 'Metric names to fetch (as exposed by the context, e.g. task_<metric>).' },
      group_by: {
        type: 'array',
        description: 'Dimensions to break the metrics down by: either { time: "metric_time", grain } for a time series, or a dimension path string (task-local name or entity-qualified like user__country). Validated against the context.',
        // dimension paths validated per-context in the handler (incl. task dims)
        items: {
          oneOf: [
            { type: 'object', additionalProperties: false, required: ['time'], description: 'Group by the metric time axis at a grain.', properties: { time: { const: 'metric_time', description: 'The metric time dimension.' }, grain: { enum: catalog.timeGranularities(), description: 'Time bucket size.' } } },
            { type: 'string', description: 'A dimension path to group by.' },
          ],
        },
      },
      where: { $ref: '#/$defs/predicateGroup', description: 'Row filter applied before aggregation (boolean tree of conditions on dimensions / metric_time).' },
      order_by: { type: 'array', description: 'Sort order. Each key must be a requested metric or group-by token.', items: { type: 'object', additionalProperties: false, required: ['key'], properties: { key: { type: 'string', description: 'Metric or group-by token to sort by.' }, direction: { enum: ['asc', 'desc'], description: 'Sort direction (default asc).' } } } },
      time_range: { type: 'object', additionalProperties: false, description: 'Restrict to a metric_time range (ISO dates).', properties: { start: { type: 'string', description: 'Inclusive start (ISO date/datetime).' }, end: { type: 'string', description: 'Inclusive end (ISO date/datetime).' } } },
      limit: { type: 'integer', minimum: 1, maximum: 100000, description: 'Max rows to return (default 1000).' },
      offset: { type: 'integer', minimum: 0, description: 'Rows to skip from the start (paging).' },
      materialize: { type: 'boolean', description: 'Materialize the query as a dbt table and read rows back from it (resilient, re-fetchable). Slow queries (> timeout) return a query_id; poll get_query_result.' },
      dry_run: { type: 'boolean', description: 'If true, return the generated SQL (explain) WITHOUT executing the query.' },
      explain: { type: 'boolean', description: 'If true, return the query PLAN (MetricFlow dataflow plan + execution plan) AND the rendered SQL WITHOUT executing — like `mf query --explain --show-dataflow-plan`. A superset of dry_run; useful for inspecting/optimizing how the metrics compile.' },
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
      dry_run: { type: 'boolean', description: 'If true, render/validate without running dbt parse.' },
    },
  };

  const ctxRef = { type: 'object', additionalProperties: false, required: ['context_id'], description: 'Reference an existing context by id.', properties: { context_id: { type: 'string', pattern: CTX, description: D.context_id } } };
  const del = { type: 'object', additionalProperties: false, required: ['context_id', 'semantic_model'], description: 'Remove a semantic model\'s task additions from a context.', properties: { context_id: { type: 'string', pattern: CTX, description: D.context_id }, semantic_model: { type: 'string', enum: modelKeys, description: 'Which model\'s additions to remove.' }, cascade: { type: 'boolean', description: 'If true, also remove metrics that depend on the removed measures.' } } };
  const empty = { type: 'object', additionalProperties: false, properties: {} };

  return {
    create_semantic_model: create,
    register_native_model: registerModel,
    update_native_model: { ...registerModel, required: ['context_id', 'name', 'sequence'], description: 'Update a registered native model in place: regenerate the view + semantic model from a new sequence spec and rebuild.' },
    delete_native_model: { ...ctxRef, description: 'Delete the registered native model in a context (remove its view + semantic model) and re-parse.' },
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
        table: { type: 'string', pattern: '^qr_[a-f0-9]{8,16}$', description: 'A known result table name (qr_<id>) to read directly — works even if the job record is gone.' },
        limit: { type: 'integer', minimum: 1, maximum: 100000, description: 'Max rows to return (default 1000).' },
        offset: { type: 'integer', minimum: 0, description: 'Rows to skip from the start (paging over the stored result).' },
        transform: {
          type: 'object', additionalProperties: false,
          description: 'Optional read-only projection over the materialized result table (compress/re-slice WITHOUT recomputing the analytics query). Identifiers are validated; values are literal-escaped.',
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
    drop_context: { ...ctxRef, description: 'Tear down an entire isolated context (delete its files + artifacts).' },
    describe_context: { ...ctxRef, description: 'Describe a context: tasks, semantic models, measures, metrics, reachable group-by paths.' },
    list_contexts: empty,
    describe_catalog: empty,
  };
}
