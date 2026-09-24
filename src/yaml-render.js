// Render resolved context state into dbt semantic_models + metrics YAML.
// Invariant (C3): exactly ONE semantic model per dbt model per context — base
// template from the catalog, augmented with the task additions.

import yaml from 'js-yaml';
import { primaryEntityName } from './catalog.js';
import { getDialect } from './dialects/index.js';
import { inertProse } from './jinja-inert.js';
import { toLatestSpec } from './semantic-latest.js';

const EVENT_TIME_DIM = 'event_time';

/**
 * The `expr` MetricFlow joins a declared entity on. A single column is emitted as the column
 * itself (what MetricFlow has always seen); a COMPOSITE key becomes one concatenated
 * expression, so the two sides compare the same value even when their columns differ in name.
 */
function entityExpr(catalog, ent) {
  const parts = ent.key || []; // a variants-only side has no single canonical key
  if (!parts.length) return undefined;
  // One plain column stays the column itself (what MetricFlow has always seen) — and needs no
  // dialect to say so. A grain makes it an expression like any composite key, because the
  // truncation is part of what the key IS.
  if (parts.length === 1 && !parts[0].grain) return parts[0].column;
  const d = getDialect(catalog.dialect);
  return parts.length === 1 ? d.keyPartExpr(parts[0]) : d.compositeKeyExpr(parts);
}

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

/** The model's own governed measures, in dbt shape. Declared once in the schema with a FIXED
 *  aggregation, so every task computes them the same way. */
function declaredMeasures(m) {
  return Object.entries(m.measures || {}).map(([name, mm]) => ({
    name, agg: mm.agg, expr: mm.expr,
    ...(mm.agg_params ? { agg_params: mm.agg_params } : {}),
    ...(mm.label ? { label: mm.label } : {}),
    ...(mm.description ? { description: mm.description } : {}),
  }));
}

/** Build the base semantic model object for a model key from the catalog. */
export function renderBaseModel(catalog, key) {
  const m = catalog.getModel(key);
  const sm = { name: key, model: `ref('${m.dbt_model}')` };

  // Every FACT renders the same way — its own event-time dimension, its own primary
  // entity, its own measures. `EVENT_TIME_DIM` is scoped to the semantic model, so two
  // facts each get their own agg_time_dimension without colliding.
  if (catalog.isFact(key)) {
    sm.defaults = { agg_time_dimension: EVENT_TIME_DIM };
    sm.primary_entity = primaryEntityName(m);
    sm.entities = Object.entries(m.entities || {}).map(([name, e]) => ({ name, type: e.type, expr: entityExpr(catalog, e) }));
    sm.dimensions = [
      { name: EVENT_TIME_DIM, type: 'time', type_params: { time_granularity: m.time.granularity || 'day' }, expr: m.time.column },
    ];
    // …and its own declared ATTRIBUTES. A fact is not only a measure carrier: when another
    // source points at it through a declared relationship, these are what that relationship is
    // FOR — `<relationship>__<attribute>` can only resolve to a dimension the manifest actually
    // carries, so a fact whose attributes were left out advertised join paths nothing could
    // serve. They cost nothing when unused.
    for (const [name, d] of Object.entries(m.dimensions || {})) {
      if (name === EVENT_TIME_DIM) continue;
      sm.dimensions.push(d.type === 'time'
        ? { name, type: 'time', type_params: { time_granularity: d.granularity || 'day' } }
        : { name, type: 'categorical' });
    }
    // A source's own DECLARED measures (a `meta.mcp.measures` entry with `agg`, or a column
    // marked `measure: { agg }`) — the governed form, whose function the schema fixes for
    // everyone. They are published for EVERY role: the catalog already offers them as base
    // measure references, so a fact that dropped them left a metric pointing at a measure the
    // manifest did not contain. Its agg_time_dimension is the event-time axis set above.
    sm.measures = declaredMeasures(m);
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
  if (!pe) {
    throw new Error(`model '${key}' has no primary entity: declare meta.mcp.primary_entity, or mark its key column meta.mcp.entity: { type: primary }. A model without one can only be reached through a pipeline join stage, not use_base_models.`);
  }
  const peName = typeof pe === 'string' ? pe : pe.name;

  // For SCD the join key is a `natural` entity (not unique per row). dbt still requires the model
  // to declare a PRIMARY entity when it has dimensions, so also set the model-level primary_entity
  // (verified via `dbt parse` + `mf query`: this yields the point-in-time join, no fan-out).
  if (scd) sm.primary_entity = peName;
  const peExpr = typeof pe === 'string' ? undefined : entityExpr(catalog, pe);
  sm.entities = [{ name: peName, type: scd ? 'natural' : 'primary', ...(peExpr ? { expr: peExpr } : {}) }];
  for (const [name, e] of Object.entries(m.entities || {})) {
    sm.entities.push({ name, type: e.type, expr: entityExpr(catalog, e) });
  }
  sm.dimensions = [];
  // A non-events source may still have a TIME AXIS (meta.mcp.is_time) — an install record's
  // install day, a daily spend table's spend day. It is the model's agg_time_dimension, exactly
  // as an events source's event_time is, and it is emitted by the dimension loop below (the
  // catalog keeps it there so it stays groupable); this only names it as the axis.
  // It must be the NAME OF A DIMENSION THIS MODEL EMITS: dbt-semantic-interfaces rejects a
  // manifest whose agg_time_dimension is not defined as a dimension, and the axis column can be
  // opted out of grouping (meta.mcp.dimension: false) — then it is a column, not a dimension, and
  // naming it here would break `dbt parse` for every context that merely loads the model. So the
  // loop below chooses among what it actually emitted.
  let timeDim = null;
  for (const [name, d] of Object.entries(m.dimensions || {})) {
    if (d.type === 'time') {
      const dim = { name, type: 'time', type_params: { time_granularity: d.granularity || 'day' } };
      // validity_params is nested UNDER type_params (dbt-semantic-interfaces schema) — NOT a
      // sibling of it; the top-level placement is what dbt rejected as an unexpected property.
      if (scd && d.validity) { dim.type_params.validity_params = d.validity === 'start' ? { is_start: true } : { is_end: true }; dim.expr = name; }
      sm.dimensions.push(dim);
      // the declared axis wins when it IS emitted; otherwise the first non-validity time dimension
      if (!(scd && d.validity) && (name === m.time?.column || !timeDim)) timeDim = name;
    } else {
      sm.dimensions.push({ name, type: 'categorical' });
    }
  }
  // The model's aggregation time axis is a property of the MODEL, not of whether the catalog
  // happens to declare a measure on it: a task may add one later, and MetricFlow then needs the
  // axis already named or it refuses the manifest.
  if (!scd && timeDim) sm.defaults = { agg_time_dimension: timeDim };
  // MetricFlow HARD CONSTRAINT: a semantic model with validity_params (SCD-2) may NOT also define
  // measures ("Semantic model X has both measures and validity param dimensions defined. This is
  // not currently supported!"). An SCD dimension is join-only (point-in-time), so we emit it
  // dimension-only and drop any catalog measures — measures belong on the events fact, not on a
  // slowly-changing dimension.
  if (!scd) {
    const measures = declaredMeasures(m);
    if (measures.length) sm.measures = measures;
  }
  return sm;
}

/**
 * Render the full context YAML.
 * @param state { additions: {modelKey:{measures,dimensions}}, metrics: [], usedModels: [] }
 * @returns { yaml, semanticModels: string[], metricNames: string[] }
 */
/** A compiled declaration as the MANIFEST takes it: our own `_`-prefixed annotations are for the
 *  tools that describe and resolve it, and dbt rejects a key it does not know. */
function manifestOnly(decl) {
  return Object.fromEntries(Object.entries(decl).filter(([k]) => !k.startsWith('_')));
}

/**
 * `spec` is the semantic YAML the installed dbt reads (its client's `semanticSpec`): 'legacy'
 * (dbt 1.x) or 'latest' (dbt v2) — the same semantic layer, rendered once and then converted
 * (src/semantic-latest.js). A 'latest' render also returns `latest` ({ models, metrics }), which the
 * context writer merges into the project's own model entries.
 */
export function renderContext(catalog, state, { spec = 'legacy' } = {}) {
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
      // A task may re-declare an attribute the base model already carries (it is offered in the
      // schema either way). Two dimensions with one name is a manifest dbt rejects, so the base
      // one stands and the duplicate is dropped.
      const have = new Set(sm.dimensions.map((d) => d.name));
      for (const d of add.dimensions || []) { if (have.has(d.name)) continue; have.add(d.name); sm.dimensions.push(manifestOnly(d)); }
      for (const me of add.measures || []) {
        // MetricFlow forbids measures on an SCD (validity_params) model — drop them so the manifest
        // is valid; the point-in-time JOIN still works (it uses the dimensions), only measures move.
        if (scd) { droppedMeasures.add(me.name); continue; }
        const mm = { ...me };
        if (catalog.isFact(key) && !mm.agg_time_dimension) mm.agg_time_dimension = EVENT_TIME_DIM;
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
  // dbt renders descriptions and labels as Jinja: the caller's prose goes in inert (jinja-inert.js)
  const latest = spec === 'latest' ? toLatestSpec(inertProse(doc)) : null;
  const body = latest
    ? yaml.dump(latest.metrics.length ? { models: latest.models, metrics: latest.metrics } : { models: latest.models }, { lineWidth: 120, noRefs: true, quotingType: '"' })
    : yaml.dump(inertProse(doc), { lineWidth: 120, noRefs: true, quotingType: '"' });
  const warnings = [];
  if (droppedMeasures.size) {
    warnings.push(`SCD dimension model is join-only: MetricFlow forbids measures on a validity_params model, so measure(s) [${[...droppedMeasures].join(', ')}] were not emitted${droppedMetrics.length ? ` (and metric(s) [${droppedMetrics.join(', ')}] that depended on them were dropped)` : ''}. Source of such a measure is the catalog's meta.mcp.measures on this model OR a prior task on a reused context_id (it stays in ctx.state.additions) — not auto-generated. Define user counts on the events fact (count_distinct of the user key) instead.`);
  }
  return {
    yaml: latest ? body : unquoteRefs(body),
    ...(latest ? { latest } : {}),
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
