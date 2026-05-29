// Build JSON Schemas for the tools, with enums projected from the catalog.
// Everything that names a column/property/event/attribute is an enum -> an AI
// literally cannot submit an unknown name (validated by ajv at the boundary).

const NAME = '^[a-z][a-z0-9_]{0,40}$';
const TASK = '^[a-z][a-z0-9_]{2,40}$';
const CTX = '^[a-z0-9]{6,40}$';
const WINDOW = '^[0-9]+ (second|minute|hour|day|week|month|quarter|year)s?$';

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
  return { oneOf: opts };
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
      properties: {
        source: { const: 'model_column' },
        column: { type: 'string', enum: cols },
        as_type: { enum: ['categorical', 'time'], default: 'categorical' },
        grain: { enum: catalog.timeGranularities() },
        label: { type: 'string' },
      },
    });
  }
  if (modelKey === catalog.anchor) {
    branches.push({
      title: 'event_property',
      type: 'object',
      additionalProperties: false,
      required: ['source', 'property'],
      properties: {
        source: { const: 'event_property' },
        property: { type: 'string', enum: catalog.eventProps() },
        as_type: { const: 'categorical', default: 'categorical' },
        label: { type: 'string' },
      },
    });
  }
  return { type: 'object', oneOf: branches };
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
  return { oneOf: opts };
}

function genericMeasureItem(catalog) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'agg'],
    properties: {
      name: { type: 'string', pattern: NAME },
      agg: { enum: ['count', 'count_distinct', 'sum', 'average', 'median', 'min', 'max', 'percentile', 'sum_boolean'] },
      field: genericMeasureField(catalog),
      percentile: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1 },
      label: { type: 'string' },
      event_name: { type: 'array', minItems: 1, items: { type: 'string', enum: catalog.eventNames() } },
      where: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['property', 'op'], properties: { property: { type: 'string', enum: catalog.eventProps() }, op: { enum: ['eq', 'neq', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte'] }, value: {} } } },
    },
    allOf: [{ if: { properties: { agg: { const: 'percentile' } } }, then: { required: ['percentile'] } }],
  };
}

function genericDimensionItem(catalog) {
  const cols = [...new Set(catalog.modelKeys().flatMap((k) => catalog.modelDimensionColumns(k)))];
  return {
    type: 'object',
    oneOf: [
      { title: 'model_column', type: 'object', additionalProperties: false, required: ['source', 'column'], properties: { source: { const: 'model_column' }, column: { type: 'string', enum: cols }, as_type: { enum: ['categorical', 'time'] }, grain: { enum: catalog.timeGranularities() }, label: { type: 'string' } } },
      { title: 'event_property', type: 'object', additionalProperties: false, required: ['source', 'property'], properties: { source: { const: 'event_property' }, property: { type: 'string', enum: catalog.eventProps() }, as_type: { const: 'categorical' }, label: { type: 'string' } } },
    ],
  };
}

function measureItemSchema(catalog, modelKey) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'agg'],
    properties: {
      name: { type: 'string', pattern: NAME },
      agg: { enum: ['count', 'count_distinct', 'sum', 'average', 'median', 'min', 'max', 'percentile', 'sum_boolean'] },
      field: measureFieldSchema(catalog, modelKey),
      percentile: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1 },
      label: { type: 'string' },
      ...(modelKey === catalog.anchor
        ? {
            event_name: { type: 'array', minItems: 1, items: { type: 'string', enum: catalog.eventNames() }, description: 'Per-measure event scope (overrides semantic_models.event_scope) — needed for funnel/conversion measures.' },
            where: {
              type: 'array',
              description: 'Per-measure event_data property conditions, ANDed with the event scope. Used to define funnel steps as event + property value (e.g. event_name=tutorial AND step_id=step_1).',
              items: {
                type: 'object', additionalProperties: false, required: ['property', 'op'],
                properties: {
                  property: { type: 'string', enum: catalog.eventProps() },
                  op: { enum: ['eq', 'neq', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte'] },
                  value: {},
                },
              },
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
    from: { const: modelKey },
    dimensions: { type: 'array', items: dimensionItemSchema(catalog, modelKey) },
    measures: { type: 'array', items: measureItemSchema(catalog, modelKey) },
  };
  if (modelKey === catalog.anchor) {
    props.event_scope = {
      type: 'object',
      additionalProperties: false,
      properties: {
        event_name: { type: 'array', minItems: 1, items: { type: 'string', enum: catalog.eventNames() } },
      },
    };
  }
  return { type: 'object', additionalProperties: false, required: ['from'], properties: props };
}

function metricSchema() {
  const measureRef = {
    type: 'object',
    additionalProperties: false,
    required: ['name'],
    properties: { name: { type: 'string' } },
  };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'type'],
    properties: {
      name: { type: 'string', pattern: NAME },
      type: { enum: ['simple', 'ratio', 'cumulative', 'derived', 'conversion'] },
      label: { type: 'string' },
      measure: measureRef,
      fill_nulls_with: { type: 'number' },
      numerator: measureRef,
      denominator: measureRef,
      window: { type: 'string', pattern: WINDOW },
      grain_to_date: { enum: ['day', 'week', 'month', 'quarter', 'year'] },
      period_agg: { enum: ['first', 'last', 'average'] },
      expr: { type: 'string' },
      metrics: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string' }, alias: { type: 'string' } } } },
      base_measure: measureRef,
      conversion_measure: measureRef,
      entity: { type: 'string' },
      calculation: { enum: ['conversion_rate', 'conversion'] },
      constant_properties: { type: 'array', items: { type: 'string' } },
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
      oneOf: [
        { type: 'object', additionalProperties: false, required: ['kind', 'path'], properties: { kind: { const: 'dimension' }, path: { type: 'string' } } },
        { type: 'object', additionalProperties: false, required: ['kind'], properties: { kind: { const: 'metric_time' }, grain: { enum: catalog.timeGranularities() } } },
      ],
    },
    predicate: {
      type: 'object',
      additionalProperties: false,
      required: ['field', 'op'],
      properties: {
        field: { $ref: '#/$defs/fieldRef' },
        op: { enum: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'between', 'is_null', 'is_not_null'] },
        value: {},
      },
    },
    predicateGroup: {
      type: 'object',
      additionalProperties: false,
      required: ['op', 'conditions'],
      properties: {
        op: { enum: ['and', 'or'] },
        conditions: { type: 'array', minItems: 1, items: { oneOf: [{ $ref: '#/$defs/predicate' }, { $ref: '#/$defs/predicateGroup' }] } },
      },
    },
  };
}

export function buildSchemas(catalog) {
  const modelKeys = catalog.modelKeys();
  const sequenceStep = {
    type: 'object', additionalProperties: false, required: ['name', 'event_name'],
    properties: {
      name: { type: 'string', pattern: NAME },
      event_name: { type: 'array', minItems: 1, items: { type: 'string', enum: catalog.eventNames() } },
      where: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['property', 'op'], properties: { property: { type: 'string', enum: catalog.eventProps() }, op: { enum: ['eq', 'neq', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte'] }, value: {} } } },
    },
  };
  const create = {
    type: 'object',
    additionalProperties: false,
    required: ['name'],
    properties: {
      context_id: { type: 'string', pattern: CTX },
      name: { type: 'string', pattern: TASK },
      description: { type: 'string' },
      engine: { enum: ['core', 'match_recognize'], default: 'core', description: 'core = MetricFlow; match_recognize = sequenced funnel/path SQL generated by the server (target BigQuery).' },
      use_base_models: { type: 'array', items: { type: 'string', enum: catalog.joinableModelKeys() } },
      semantic_models: { type: 'array', items: { oneOf: modelKeys.map((k) => semanticModelBranch(catalog, k)) } },
      metrics: { type: 'array', minItems: 1, items: metricSchema() },
      sequence: {
        type: 'object', additionalProperties: false, required: ['steps'],
        description: 'For engine=match_recognize: ordered steps (each = event + optional property), partitioned by user/session.',
        properties: {
          partition_by: { enum: ['user', 'session'], default: 'user' },
          mode: { enum: ['ordered', 'strict'], default: 'ordered', description: 'ordered = later (gaps allowed); strict = immediately next event.' },
          steps: { type: 'array', minItems: 2, items: sequenceStep },
        },
      },
      dry_run: { type: 'boolean' },
    },
    allOf: [
      { if: { properties: { engine: { const: 'match_recognize' } }, required: ['engine'] }, then: { required: ['sequence'] }, else: { required: ['metrics'] } },
    ],
  };

  const pdefs = predicateDefs(catalog);
  const query = {
    type: 'object',
    additionalProperties: false,
    required: ['context_id'],
    $defs: pdefs,
    properties: {
      context_id: { type: 'string' },
      task: { type: 'string' },
      metrics: { type: 'array', minItems: 1, items: { type: 'string' } },
      group_by: {
        type: 'array',
        // dimension paths validated per-context in the handler (incl. task dims)
        items: {
          oneOf: [
            { type: 'object', additionalProperties: false, required: ['time'], properties: { time: { const: 'metric_time' }, grain: { enum: catalog.timeGranularities() } } },
            { type: 'string' },
          ],
        },
      },
      where: { $ref: '#/$defs/predicateGroup' },
      order_by: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['key'], properties: { key: { type: 'string' }, direction: { enum: ['asc', 'desc'] } } } },
      time_range: { type: 'object', additionalProperties: false, properties: { start: { type: 'string' }, end: { type: 'string' } } },
      limit: { type: 'integer', minimum: 1, maximum: 100000 },
      offset: { type: 'integer', minimum: 0 },
      dry_run: { type: 'boolean' },
    },
  };

  const update = {
    type: 'object',
    additionalProperties: false,
    required: ['context_id', 'semantic_model'],
    properties: {
      context_id: { type: 'string' },
      semantic_model: { type: 'string', enum: modelKeys },
      add_dimensions: { type: 'array', items: genericDimensionItem(catalog) },
      remove_dimensions: { type: 'array', items: { type: 'string' } },
      add_measures: { type: 'array', items: genericMeasureItem(catalog) },
      remove_measures: { type: 'array', items: { type: 'string' } },
      add_metrics: { type: 'array', items: metricSchema() },
      remove_metrics: { type: 'array', items: { type: 'string' } },
      task: { type: 'string' },
      dry_run: { type: 'boolean' },
    },
  };

  const ctxRef = { type: 'object', additionalProperties: false, required: ['context_id'], properties: { context_id: { type: 'string' } } };
  const del = { type: 'object', additionalProperties: false, required: ['context_id', 'semantic_model'], properties: { context_id: { type: 'string' }, semantic_model: { type: 'string', enum: modelKeys }, cascade: { type: 'boolean' } } };
  const empty = { type: 'object', additionalProperties: false, properties: {} };

  return {
    create_semantic_model: create,
    query_semantic_model: query,
    update_semantic_model: update,
    delete_semantic_model: del,
    drop_context: ctxRef,
    describe_context: ctxRef,
    list_contexts: empty,
    describe_catalog: empty,
  };
}
