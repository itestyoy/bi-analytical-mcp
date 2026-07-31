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

  // dimension/fact model with a natural primary key. When the model is SLOWLY-CHANGING (SCD-2:
  // several validity-windowed rows per key) AND MetricFlow's SCD support is enabled, the join
  // entity is declared `natural` (not `primary`, since the key is not unique) and the two
  // validity-bound time dimensions carry validity_params — MetricFlow then does a POINT-IN-TIME
  // join (fact agg_time within the window) instead of a fan-out equality.
  // DEFAULT ON when the catalog marks validity columns (verified against dbt-semantic-interfaces
  // 0.9.0 via dbt parse: validity_params nested under type_params parses cleanly). An ESCAPE HATCH
  // MCP_SCD_VALIDITY_PARAMS=false disables it for anyone on an OLDER DSI that rejects the field —
  // then the model emits a plain primary-key form (use a pipeline join.between for point-in-time).
  const scd = m.scd && !/^(0|false|no|off)$/i.test(String(process.env.MCP_SCD_VALIDITY_PARAMS ?? '').trim());
  const pe = m.primary_entity;
  const peName = typeof pe === 'string' ? pe : pe.name;
  const peCol = typeof pe === 'string' ? undefined : pe.column;
  // For SCD the join key is a `natural` entity (not unique per row). dbt still requires the model
  // to declare a PRIMARY entity when it has dimensions, so also set the model-level primary_entity
  // (verified via `dbt parse` + `mf query`: this yields the point-in-time join, no fan-out).
  if (scd) sm.primary_entity = peName;
  sm.entities = [{ name: peName, type: scd ? 'natural' : 'primary', ...(peCol ? { expr: peCol } : {}) }];
  for (const [name, e] of Object.entries(m.entities || {})) {
    sm.entities.push({ name, type: e.type, expr: e.column });
  }
  sm.dimensions = [];
  let timeDim;
  for (const [name, d] of Object.entries(m.dimensions || {})) {
    if (d.type === 'time') {
      const dim = { name, type: 'time', type_params: { time_granularity: d.granularity || 'day' } };
      // validity_params is nested UNDER type_params (dbt-semantic-interfaces schema) — NOT a
      // sibling of it; the top-level placement is what dbt rejected as an unexpected property.
      if (scd && d.validity) { dim.type_params.validity_params = d.validity === 'start' ? { is_start: true } : { is_end: true }; dim.expr = name; }
      sm.dimensions.push(dim);
      if (!(scd && d.validity)) timeDim ||= name; // a validity bound is not the model's agg_time dimension
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
