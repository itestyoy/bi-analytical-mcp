// THE PIECES THE TOOL SCHEMAS SHARE — the name patterns, the reused descriptions, the items a
// declaration and a query are written in (a measure, a dimension, a where item, a metric, a reference
// into the project's own layer), the predicate grammar, and the limits every tool quotes (how long a
// read waits, how many queries a batch holds). The tools are put together in src/schema.js.

import { MEASURE_AGGS, GRAINS } from '../catalog.js';
import { TASK_ID_PATTERN } from '../jobs.js';
import { strEnum, anyOfOr, withoutEmpty, form, pick } from '../schema-kit.js';
import { CONTEXT_ID } from '../context-manager.js';

export const NAME = '^[a-z][a-z0-9_]{0,40}$';

export const TASK = '^[a-z][a-z0-9_]{2,40}$';

export const CTX = CONTEXT_ID;

export const TASK_ID = TASK_ID_PATTERN;

export const WINDOW = '^[0-9]+ (second|minute|hour|day|week|month|quarter|year)s?$';

// Reusable property-description strings (kept consistent across tools).
export const D = {
  context_id: 'ID of the isolated execution context to operate in. Omit on create to start a NEW, isolated context; pass an existing id to extend or query that same context. Each context is fully isolated, so parallel tasks never collide.',
  measure_name: 'Unique measure name within the task (lowercase snake_case). Referenced by metrics; the final queryable name is prefixed with the task, e.g. task_<name>.',
  agg: 'Aggregation applied to `field` to form the measure: count (rows), count_distinct (unique values of an entity key — required for conversion/funnel user counts), sum, average, median, min, max, percentile (needs `percentile`), sum_boolean (counts rows where a boolean/condition holds).',
  percentile: 'Percentile in (0,1), e.g. 0.95 for p95. Required when agg=percentile.',
  label: 'Human-readable label shown in BI tools / metadata. Defaults to the name when omitted.',
  event_name: 'Event scope for THIS measure: only rows whose event_name is in this list are aggregated. This is how a funnel/conversion step is pinned to a specific event. Overrides the semantic model\'s event_scope.',
  where_measure: 'Per-measure conditions on event_data JSON properties, ANDed with the event scope. Used to define a funnel step as event + property value (e.g. event_name=tutorial AND step_id=step_1).',
};

export function whereItemSchema(catalog, modelKey) {
  return {
    type: 'object', additionalProperties: false, required: ['property', 'op'],
    description: 'One condition on a SCALAR event_data property (array/struct properties must be reduced via a prepare stage first).',
    properties: {
      property: strEnum(catalog.scalarEventProps(modelKey), `Scalar event_data property to test. NB: each property is only populated on specific events (see semantic_index({ request: { source: '${modelKey}', event } })); scope the measure to those event_name(s) or it reads NULL.`),
      op: { enum: ['eq', 'neq', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte'], description: 'Comparison operator. Use in/not_in with an array value; the rest take a scalar.' },
      value: { description: 'Literal value(s) to compare against. Scalar for eq/neq/gt/gte/lt/lte; array for in/not_in.' },
    },
  };
}

export function measureFieldSchema(catalog, modelKey) {
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
  // the kinds may share a name (a key column that is also an amount): any of them it is, the field is the same
  return { description: 'What to aggregate: "*" (count rows), an entity-key column (for count_distinct of users/sessions), an event_data property, or an AMOUNT the schema marks aggregatable on this source. An amount fixes no function — choose the one the question needs in `agg` (sum / average / max / median / percentile / …). A STRING field that holds numbers needs "cast":"numeric" to sum/average it.', anyOf: opts };
}

export function dimensionItemSchema(catalog, modelKey) {
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
        property: strEnum(catalog.scalarEventProps(modelKey), `Scalar event_data property to expose as a dimension. NB: only populated on specific events (see semantic_index({ request: { source: '${modelKey}', event } })); NULL on others.`),
        as_type: { enum: ['categorical'], default: 'categorical', description: 'event_data dimensions are always categorical.' },
        label: { type: 'string', description: D.label },
      },
    });
  }
  // A model with no groupable column and no payload has NO dimension to add: the field is left
  // out of its branch rather than offered as a choice with no options.
  return anyOfOr(branches, { type: 'object', description: 'A dimension to add to the semantic model (a column or an event_data property) for grouping/filtering.' });
}

// Generic (model-agnostic) item schemas for `update`, where the target model is
// already fixed by `semantic_model`. Field names are still catalog-constrained;
// exact model/field coupling is re-checked in compile.
export function genericMeasureField(catalog) {
  const opts = [{ enum: ['*'], title: 'rows' }];
  const keys = [...new Set(catalog.modelKeys().flatMap((k) => catalog.entityKeyColumns(k)))];
  if (keys.length) opts.push({ type: 'string', enum: keys, title: 'entity_key' });
  const props = catalog.scalarEventPropEnum();
  if (props.length) opts.push({ type: 'string', enum: props, title: 'event_property' });
  const amounts = catalog.aggregatableFieldNames();
  if (amounts.length) opts.push({ type: 'string', enum: amounts, title: 'amount' });
  return { description: 'What to aggregate: "*", an entity-key column, a numeric event_data property, or an AMOUNT the schema marks aggregatable — all of the target semantic model\'s own source. An amount fixes no function; choose it in `agg`.', anyOf: opts };
}

export function genericWhereItem(catalog) {
  const item = whereItemSchema(catalog, catalog.facts[0]); // shape only — the enum is replaced below
  item.properties.property = strEnum(catalog.scalarEventPropEnum(), 'Scalar event_data property of the target semantic model\'s own source. NB: each property is only populated on specific events; scope the measure to those event_name(s) or it reads NULL.');
  return item;
}

export function genericMeasureItem(catalog) {
  return byAgg('A measure to add to the target semantic model.', {
    name: { type: 'string', pattern: NAME, description: D.measure_name },
    field: genericMeasureField(catalog),
    percentile: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1, description: D.percentile },
    cast: { enum: ['numeric', 'int', 'float'], description: 'Cast the field to a numeric type before aggregating — needed to sum/average a STRING property that holds numbers (e.g. complete_time).' },
    label: { type: 'string', description: D.label },
    event_name: { type: 'array', minItems: 1, items: strEnum(catalog.eventNameEnum()), description: D.event_name },
    where: { type: 'array', description: D.where_measure, items: genericWhereItem(catalog) },
  });
}

/**
 * A measure, in two forms told apart by its `agg`: a percentile, which takes the quantile it reads
 * (`percentile`, required), and every other aggregation, which takes none.
 */
function byAgg(description, fields) {
  const { percentile, ...rest } = fields;
  const others = [...MEASURE_AGGS].filter((a) => a !== 'percentile');
  return {
    type: 'object',
    description,
    anyOf: [
      form({ title: 'an aggregation', tag: ['agg', others], tagDescription: D.agg, required: ['name'], properties: rest }),
      form({ title: 'a percentile', tag: ['agg', 'percentile'], tagDescription: 'percentile: the value at the quantile `percentile` of `field`.', required: ['name', 'percentile'], properties: { ...rest, percentile } }),
    ],
  };
}

export function genericDimensionItem(catalog) {
  const cols = [...new Set(catalog.modelKeys().flatMap((k) => catalog.modelDimensionColumns(k)))];
  return {
    type: 'object',
    description: 'A dimension to add to the target semantic model (a column or an event_data property).',
    anyOf: [
      { title: 'model_column', type: 'object', additionalProperties: false, required: ['source', 'column'], description: 'Dimension from a physical column.', properties: { source: { enum: ['model_column'], description: 'Use a physical table column.' }, column: strEnum(cols, 'Physical column name.'), as_type: { enum: ['categorical', 'time'], description: 'Categorical attribute or time dimension.' }, grain: { enum: catalog.timeGranularities(), description: 'Time grain when as_type=time.' }, label: { type: 'string', description: D.label } } },
      { title: 'event_property', type: 'object', additionalProperties: false, required: ['source', 'property'], description: 'Dimension from a scalar event_data JSON property.', properties: { source: { enum: ['event_property'], description: 'Extract from event_data JSON.' }, property: strEnum(catalog.scalarEventPropEnum(), 'Scalar event_data property of the target semantic model\'s own source. NB: only populated on specific events (see semantic_index({ request: { source, event } })); NULL on others.'), as_type: { enum: ['categorical'], description: 'Always categorical.' }, label: { type: 'string', description: D.label } } },
    ],
  };
}

export function measureItemSchema(catalog, modelKey) {
  return byAgg('A measure: an aggregation over the model, optionally scoped to specific events / property values (the building block of funnel steps and metrics).', {
    name: { type: 'string', pattern: NAME, description: D.measure_name },
    field: measureFieldSchema(catalog, modelKey),
    percentile: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1, description: D.percentile },
    cast: { enum: ['numeric', 'int', 'float'], description: 'Cast the field to a numeric type before aggregating — needed to sum/average a STRING property that holds numbers (e.g. complete_time).' },
    label: { type: 'string', description: D.label },
    ...(catalog.isFact(modelKey)
      ? {
          event_name: { type: 'array', minItems: 1, items: strEnum(catalog.eventNames(modelKey)), description: D.event_name },
          where: { type: 'array', description: D.where_measure, items: whereItemSchema(catalog, modelKey) },
        }
      : {}),
  });
}

export function semanticModelBranch(catalog, modelKey) {
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

export function metricSchema() {
  const measureRef = {
    type: 'object',
    additionalProperties: false,
    required: ['name'],
    description: 'Reference to a measure by name.',
    properties: { name: { type: 'string', description: 'Name of a measure defined in this task.' } },
  };
  const fields = {
    name: { type: 'string', pattern: NAME, description: 'Unique metric name (lowercase snake_case). Queried as task_<name>.' },
    label: { type: 'string', description: D.label },
    measure: { ...measureRef, description: 'The single measure this metric exposes.' },
    fill_nulls_with: { type: 'number', description: 'Value to substitute for NULL results (e.g. 0) so gaps in a time series render as zeros.' },
    numerator: { ...measureRef, description: 'The measure on top of the division.' },
    denominator: { ...measureRef, description: 'The measure on the bottom of the division.' },
    grain_to_date: { enum: GRAINS, description: 'Reset accumulation at the start of each period (e.g. month-to-date).' },
    period_agg: { enum: ['first', 'last', 'average'], description: 'How to collapse multiple values within a period.' },
    expr: { type: 'string', description: 'Arithmetic expression over the input metrics, e.g. "coins_in - coins_out". Restricted to a safe arithmetic grammar (the referenced metric aliases + basic math functions).' },
    metrics: { type: 'array', description: 'The input metrics referenced by `expr`.', items: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string', description: 'Name of an input metric.' }, alias: { type: 'string', description: 'Optional alias to use for this metric inside `expr`.' } } } },
    base_measure: { ...measureRef, description: 'The starting population (must be count_distinct of an entity), e.g. users who launched.' },
    conversion_measure: { ...measureRef, description: 'The converted population (count_distinct of the same entity), e.g. users who purchased.' },
    window: { type: 'string', pattern: WINDOW, description: 'Time window in which the conversion must occur after the base event, e.g. "1 day", "7 day", "1 week".' },
    entity: { type: 'string', description: 'The entity linking base and conversion events (default "user").' },
    calculation: { enum: ['conversion_rate', 'conversion'], description: 'Return the rate (converted/base, default) or the raw converted count.' },
    constant_properties: { type: 'array', items: { type: 'string' }, description: 'Properties that must match between the base and conversion events (e.g. same product_id).' },
  };
  // one form per kind of metric, each with exactly the fields that kind reads (src/compile.js)
  const kind = (type, title, required, optional, own = {}) => form({ title, tag: ['type', type], required: ['name', ...required], properties: { ...pick(fields, ['name', 'label', ...required, ...optional]), ...own } });
  return {
    type: 'object',
    description: 'A metric: the queryable quantity. simple wraps one measure; ratio = numerator/denominator; cumulative accumulates a measure over time; derived computes an expression over other metrics; conversion = share of a base population that later did a conversion event within a window.',
    anyOf: [
      kind('simple', 'simple: one measure', ['measure'], ['fill_nulls_with']),
      kind('ratio', 'ratio: numerator / denominator', ['numerator', 'denominator'], []),
      kind('cumulative', 'cumulative: a measure accumulated over time', ['measure'], ['grain_to_date', 'period_agg'], { window: { type: 'string', pattern: WINDOW, description: 'Accumulate over a trailing window (e.g. "7 days") instead of all history.' } }),
      kind('derived', 'derived: an expression over other metrics', ['expr', 'metrics'], []),
      kind('conversion', 'conversion: the share of a base population that converted within a window', ['base_measure', 'conversion_measure', 'window'], ['entity', 'calculation', 'constant_properties']),
    ],
  };
}

/** A dimension of the dbt project's OWN semantic layer (src/project-semantics.js), addressed by the
 *  semantic model that carries it — what a query of a context of the project's own semantic models names. */
export function projectRef(project, catalog, { withKind = false } = {}) {
  const names = project.semantic_models.map((m) => m.name);
  return {
    type: 'object', additionalProperties: false, required: [...(withKind ? ['kind'] : []), 'semantic_model', 'dimension'],
    description: `A dimension of one of the dbt project's own semantic models, used in that model's context (context_id: the semantic model's name), named by what it is and where it lives: semantic_model is the chain of semantic models it is reached through — ["<the context's own>"] for a dimension of the context's own model, ["X"] for one of X joined to directly, ["A", "X"] for one of X reached through A — and MetricFlow makes the joins. ${withKind ? 'The condition compares that dimension\'s values.' : 'Its result column is <semantic_model>_<dimension>, with _<grain> for a time dimension.'} preview_semantic_model({ request: { context_id, metric } }) lists every dimension a metric takes, spelled as here, under its group_by.dimensions.`,
    properties: {
      ...(withKind ? { kind: { enum: ['dimension'], description: 'Filter on a dimension.' } } : {}),
      semantic_model: { type: 'array', minItems: 1, items: { enum: names }, description: 'Where the dimension lives: the chain of semantic models it is reached through, in order, ending with the one that carries it — one model for its own dimensions or a direct join, several for a chain of joins.' },
      dimension: { type: 'string', description: 'The dimension\'s name, as the project declares it.' },
      ...(withKind ? {} : { grain: { enum: catalog.timeGranularities(), description: 'Only for a time dimension: the bucket rows are grouped into (default: the dimension\'s own granularity).' } }),
    },
  };
}

/** An entity of the dbt project's own semantic layer, grouped or filtered by name — the key a project
 *  may declare only as an entity (an app, a country), which MetricFlow groups by as it is. → [] when
 *  the layer declares none, [ref] otherwise. */
export function projectEntityRef(project, { withKind = false } = {}) {
  const entities = [...new Set(project.semantic_models.flatMap((m) => m.entities.map((e) => e.name)))].sort();
  if (!entities.length) return [];
  return [{
    type: 'object', additionalProperties: false, required: [...(withKind ? ['kind'] : []), 'entity'],
    description: `An entity of one of the dbt project's own semantic models, by name, used in that model's context: a key the project declares as an entity — often a column with no dimension of its own, such as a foreign key. ${withKind ? 'The condition compares the key\'s values.' : 'Grouping by it gives one row per key value; its result column is the entity\'s name.'} Every requested metric has to carry it; preview_semantic_model({ request: { context_id, metric } }) lists a metric's entities under its group_by.entities.`,
    properties: {
      ...(withKind ? { kind: { enum: ['entity'], description: 'Filter on an entity.' } } : {}),
      entity: { enum: entities, description: 'The entity\'s name, as the project declares it.' },
    },
  }];
}

/** A metric_time window, as a metric query and a preview's validation take it. */
export const METRIC_TIME_RANGE = { type: 'object', additionalProperties: false, description: 'Restrict to a metric_time range (ISO dates). Unbounded queries scan the whole history — always bound when exploring.', properties: { start: { type: 'string', description: 'Inclusive start (ISO date/datetime).' }, end: { type: 'string', description: 'Inclusive end (ISO date/datetime; a date-only end means the WHOLE day).' }, timezone: { type: 'string', description: 'Optional IANA timezone (e.g. "Europe/Berlin"): start/end are read as wall-clock in this zone and converted to the UTC instants the warehouse stores. Omit for warehouse-native (UTC) bounds.' } } };

export function predicateDefs(catalog, project = null) {
  return {
    fieldRef: {
      type: 'object',
      // model/attribute are validated per-context in the handler (task dims are not a static
      // enum); `_reachable_attributes` documents what the catalog can reach.
      _reachable_attributes: catalog.reachableAttributes(),
      description: 'The field a condition applies to: an attribute addressed by where it lives ({ kind: "dimension", model, attribute }) or the metric time axis.',
      anyOf: [
        { type: 'object', additionalProperties: false, required: ['kind', 'model', 'attribute'], description: 'A dimension addressed by WHERE IT LIVES: { kind: "dimension", model: "users", attribute: "country" } — the join path is resolved from the schema (add via when the source has several relationships to that model).', properties: { kind: { enum: ['dimension'], description: 'Filter on a dimension.' }, model: { enum: catalog.modelKeys(), description: 'The model that carries the attribute.' }, attribute: { type: 'string', description: 'The attribute (column) on that model.' }, via: { type: 'string', description: 'Optional relationship name when several lead to the model.' } } },
        { type: 'object', additionalProperties: false, required: ['kind'], description: 'The metric time axis.', properties: { kind: { enum: ['metric_time'], description: 'Filter on the metric time dimension.' }, grain: { enum: catalog.timeGranularities(), description: 'Time grain to bucket by.' } } },
        ...(project ? [projectRef(project, catalog, { withKind: true }), ...projectEntityRef(project, { withKind: true })] : []),
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
        conditions: { type: 'array', minItems: 1, description: 'Conditions and/or nested groups.', items: { anyOf: [{ $ref: '#/$defs/predicate' }, { $ref: '#/$defs/predicateGroup' }] } },
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
export function terse(schema) {
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
