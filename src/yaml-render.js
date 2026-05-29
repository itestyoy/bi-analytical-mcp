// Render resolved context state into dbt semantic_models + metrics YAML.
// Invariant (C3): exactly ONE semantic model per dbt model per context — base
// template from the catalog, augmented with the task additions.

import yaml from 'js-yaml';

const EVENT_TIME_DIM = 'event_time';

/** Build the base semantic model object for a model key from the catalog. */
export function renderBaseModel(catalog, key) {
  const m = catalog.getModel(key);
  const sm = { name: key, model: `ref('${m.dbt_model}')` };

  if (key === catalog.anchor) {
    sm.defaults = { agg_time_dimension: EVENT_TIME_DIM };
    sm.primary_entity = typeof m.primary_entity === 'string' ? m.primary_entity : m.primary_entity.name;
    sm.entities = Object.entries(m.entities || {}).map(([name, e]) => ({ name, type: e.type, expr: e.column }));
    sm.dimensions = [
      { name: EVENT_TIME_DIM, type: 'time', type_params: { time_granularity: m.time.granularity || 'day' }, expr: m.time.column },
    ];
    sm.measures = [];
    return sm;
  }

  // dimension/fact model with a natural primary key
  const pe = m.primary_entity;
  const peName = typeof pe === 'string' ? pe : pe.name;
  const peCol = typeof pe === 'string' ? undefined : pe.column;
  sm.entities = [{ name: peName, type: 'primary', ...(peCol ? { expr: peCol } : {}) }];
  for (const [name, e] of Object.entries(m.entities || {})) {
    sm.entities.push({ name, type: e.type, expr: e.column });
  }
  sm.dimensions = [];
  let timeDim;
  for (const [name, d] of Object.entries(m.dimensions || {})) {
    if (d.type === 'time') {
      sm.dimensions.push({ name, type: 'time', type_params: { time_granularity: d.granularity || 'day' } });
      timeDim ||= name;
    } else {
      sm.dimensions.push({ name, type: 'categorical' });
    }
  }
  const measures = Object.entries(m.measures || {}).map(([name, mm]) => ({ name, agg: mm.agg, expr: mm.expr }));
  if (measures.length) {
    sm.measures = measures;
    if (timeDim) sm.defaults = { agg_time_dimension: timeDim };
  }
  return sm;
}

/**
 * Render the full context YAML.
 * @param state { additions: {modelKey:{measures,dimensions}}, metrics: [], usedModels: [] }
 * @returns { yaml, semanticModels: string[], metricNames: string[] }
 */
export function renderContext(catalog, state) {
  const modelsToRender = new Set(state.usedModels || []);
  // always include any model that received additions
  for (const k of Object.keys(state.additions || {})) modelsToRender.add(k);

  const semanticModels = [];
  for (const key of modelsToRender) {
    const sm = renderBaseModel(catalog, key);
    const add = state.additions?.[key];
    if (add) {
      for (const d of add.dimensions || []) sm.dimensions.push(d);
      for (const me of add.measures || []) {
        const mm = { ...me };
        if (key === catalog.anchor && !mm.agg_time_dimension) mm.agg_time_dimension = EVENT_TIME_DIM;
        (sm.measures ||= []).push(mm);
      }
    }
    semanticModels.push(sm);
  }

  const doc = { semantic_models: semanticModels };
  if (state.metrics?.length) doc.metrics = state.metrics;

  // js-yaml quotes ref('...') fine as a plain scalar; force flow-off for readability
  const body = yaml.dump(doc, { lineWidth: 120, noRefs: true, quotingType: '"' });
  return {
    yaml: unquoteRefs(body),
    semanticModels: semanticModels.map((s) => s.name),
    metricNames: (state.metrics || []).map((m) => m.name),
  };
}

// js-yaml double-quotes strings containing parentheses; dbt accepts both, but we
// emit ref('...') unquoted to match idiomatic dbt YAML.
function unquoteRefs(body) {
  return body.replace(/model: "(ref\('[^']+'\))"/g, 'model: $1');
}
