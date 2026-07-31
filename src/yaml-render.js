// Render resolved context state into dbt semantic_models + metrics YAML.
// Invariant (C3): exactly ONE semantic model per dbt model per context — base
// template from the catalog, augmented with the task additions.

import yaml from 'js-yaml';

const EVENT_TIME_DIM = 'event_time';

/** A model is treated as SCD-2 (validity_params emitted) when the catalog marked validity columns
 *  AND the escape hatch MCP_SCD_VALIDITY_PARAMS is not disabling it. SCD models are join-only. */
function isScdModel(m) {
  return !!m.scd && !/^(0|false|no|off)$/i.test(String(process.env.MCP_SCD_VALIDITY_PARAMS ?? '').trim());
}

/** True when a metric's type_params reference any measure name in `names` (simple/ratio/derived). */
function metricRefsMeasure(metric, names) {
  const tp = metric.type_params || {};
  const refs = [];
  const push = (v) => { if (typeof v === 'string') refs.push(v); else if (v?.name) refs.push(v.name); };
  push(tp.measure);
  for (const m of tp.measures || []) push(m);
  push(tp.numerator); push(tp.denominator);
  for (const m of tp.input_measures || []) push(m);
  return refs.some((r) => names.has(r));
}

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
  const scd = isScdModel(m);
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
  // MetricFlow HARD CONSTRAINT: a semantic model with validity_params (SCD-2) may NOT also define
  // measures ("Semantic model X has both measures and validity param dimensions defined. This is
  // not currently supported!"). An SCD dimension is join-only (point-in-time), so we emit it
  // dimension-only and drop any catalog measures — measures belong on the events fact, not on a
  // slowly-changing dimension.
  if (!scd) {
    const measures = Object.entries(m.measures || {}).map(([name, mm]) => ({ name, agg: mm.agg, expr: mm.expr }));
    if (measures.length) {
      sm.measures = measures;
      if (timeDim) sm.defaults = { agg_time_dimension: timeDim };
    }
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
  const droppedMeasures = new Set(); // measures removed because their model is SCD (join-only)
  for (const key of modelsToRender) {
    const sm = renderBaseModel(catalog, key);
    const scd = isScdModel(catalog.getModel(key));
    const add = state.additions?.[key];
    if (add) {
      for (const d of add.dimensions || []) sm.dimensions.push(d);
      for (const me of add.measures || []) {
        // MetricFlow forbids measures on an SCD (validity_params) model — drop them so the manifest
        // is valid; the point-in-time JOIN still works (it uses the dimensions), only measures move.
        if (scd) { droppedMeasures.add(me.name); continue; }
        const mm = { ...me };
        if (key === catalog.anchor && !mm.agg_time_dimension) mm.agg_time_dimension = EVENT_TIME_DIM;
        (sm.measures ||= []).push(mm);
      }
    }
    semanticModels.push(sm);
  }

  // Drop metrics that reference a measure we removed from an SCD model — otherwise dbt fails parse
  // with "a semantic model having a measure `X` does not exist but was referenced".
  const droppedMetrics = [];
  const metrics = (state.metrics || []).filter((mt) => {
    if (droppedMeasures.size && metricRefsMeasure(mt, droppedMeasures)) { droppedMetrics.push(mt.name); return false; }
    return true;
  });

  const doc = { semantic_models: semanticModels };
  if (metrics.length) doc.metrics = metrics;

  // js-yaml quotes ref('...') fine as a plain scalar; force flow-off for readability
  const body = yaml.dump(doc, { lineWidth: 120, noRefs: true, quotingType: '"' });
  const warnings = [];
  if (droppedMeasures.size) {
    warnings.push(`SCD dimension model is join-only: MetricFlow forbids measures on a validity_params model, so measure(s) [${[...droppedMeasures].join(', ')}] were not emitted${droppedMetrics.length ? ` (and metric(s) [${droppedMetrics.join(', ')}] that depended on them were dropped)` : ''}. Source of such a measure is the catalog's meta.mcp.measures on this model OR a prior task on a reused context_id (it stays in ctx.state.additions) — not auto-generated. Define user counts on the events fact (count_distinct of the user key) instead.`);
  }
  return {
    yaml: unquoteRefs(body),
    semanticModels: semanticModels.map((s) => s.name),
    metricNames: metrics.map((m) => m.name),
    warnings,
  };
}

// js-yaml double-quotes strings containing parentheses; dbt accepts both, but we
// emit ref('...') unquoted to match idiomatic dbt YAML.
function unquoteRefs(body) {
  return body.replace(/model: "(ref\('[^']+'\))"/g, 'model: $1');
}
