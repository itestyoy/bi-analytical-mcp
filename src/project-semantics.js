// THE PROJECT'S OWN SEMANTIC LAYER — the semantic models and metrics the dbt project (DBT_BASE_PROJECT)
// declares itself, read once at start and queried with query_semantic_model like any context: no build
// step, since they are already defined and do not change while the server runs.
//
// At start the server copies the project into a context of its own (PROJECT_CONTEXT), parses it
// through the dbt client, and reads the semantic manifest dbt wrote — whatever dbt version and YAML
// spec the project uses, the manifest says the same things: each semantic model with its entities and
// dimensions, each metric with what it reads. From it this builds the LAYER: the metrics, the semantic
// models, and for each metric the dimensions it can be grouped and filtered by (its own semantic
// models', and those of a semantic model its entities reach, one hop — the `<entity>__<dimension>`
// MetricFlow addresses). A query is checked against that before anything runs, and MetricFlow runs it
// over the project's copy exactly as the project defines it. Nothing is rendered or rewritten: the
// project's YAML is the definition.

import { utimesSync } from 'node:fs';
import { formatDbtError } from './dbt/output.js';

/** The context the project's semantic layer is served from — a fixed id, the same on every start. */
export const PROJECT_CONTEXT = 'project';

const IDENTITY = new Set(['primary', 'unique', 'natural']);

const hasMeta = (meta) => !!meta && typeof meta === 'object' && Object.keys(meta).length > 0;

/** A semantic model's own entity (what its dimensions are addressed through), or null. */
function primaryEntity(sm) {
  return sm.primary_entity || (sm.entities || []).find((e) => IDENTITY.has(e.type))?.name || null;
}

/**
 * The layer a semantic manifest describes: { semantic_models, metrics, reach, entities } — every metric
 * with the semantic models it reads; `reach(metric)`: the dimensions it can be grouped by, each
 * { semantic_model, dimension, type, grain?, entity, path } (path: MetricFlow's `<entity>__<dimension>`);
 * and `entities(metric)`: the entities of the semantic models it reads — a key such as an app or a
 * country that a project may declare ONLY as an entity (no dimension on the column), grouped by name.
 */
export function projectLayer(manifest) {
  const models = (manifest?.semantic_models || []).map((sm) => ({
    name: sm.name,
    ...(sm.description ? { description: sm.description } : {}),
    table: sm.node_relation?.alias || sm.node_relation?.relation_name || null,
    entity: primaryEntity(sm),
    entities: (sm.entities || []).map((e) => ({ name: e.name, type: e.type })),
    ...(hasMeta(sm.config?.meta) ? { meta: sm.config.meta } : {}),
    dimensions: (sm.dimensions || []).map((d) => ({
      name: d.name, type: d.type,
      ...(d.type === 'time' && d.type_params?.time_granularity ? { grain: d.type_params.time_granularity } : {}),
      ...(d.description ? { description: d.description } : {}),
    })),
    measures: (sm.measures || []).map((m) => m.name),
  }));
  const byName = new Map(models.map((m) => [m.name, m]));
  const measureOwner = new Map(models.flatMap((m) => m.measures.map((me) => [me, m.name])));
  const raw = new Map((manifest?.metrics || []).map((m) => [m.name, m]));

  // what a metric reads: its own semantic model (a simple metric of the latest spec names it), the
  // owners of the measures it names (the legacy spec), and whatever the metrics it is made of read
  const readsOf = new Map();
  const reads = (name, seen = new Set()) => {
    if (readsOf.has(name)) return readsOf.get(name);
    if (seen.has(name)) return new Set();
    seen.add(name);
    const m = raw.get(name);
    const tp = m?.type_params || {};
    const out = new Set();
    if (tp.metric_aggregation_params?.semantic_model) out.add(tp.metric_aggregation_params.semantic_model);
    const measures = [tp.measure?.name, ...(tp.input_measures || []).map((x) => x?.name), tp.conversion_type_params?.base_measure?.name, tp.conversion_type_params?.conversion_measure?.name].filter(Boolean);
    for (const me of measures) if (measureOwner.has(me)) out.add(measureOwner.get(me));
    const inputs = [tp.numerator?.name, tp.denominator?.name, ...(tp.metrics || []).map((x) => x?.name), tp.cumulative_type_params?.metric?.name, tp.conversion_type_params?.base_metric?.name, tp.conversion_type_params?.conversion_metric?.name].filter(Boolean);
    for (const i of inputs) for (const s of reads(i, seen)) out.add(s);
    readsOf.set(name, out);
    return out;
  };

  // one semantic model's dimensions, addressed through `entity`
  const dimsOf = (sm, entity) => sm.dimensions.map((d) => ({ semantic_model: sm.name, dimension: d.name, type: d.type, ...(d.grain ? { grain: d.grain } : {}), entity, path: `${entity}__${d.name}` }));
  const reachOf = new Map();
  const reach = (name) => {
    if (reachOf.has(name)) return reachOf.get(name);
    const out = [];
    const seen = new Set();
    const add = (list) => { for (const d of list) { const k = `${d.semantic_model}\u0000${d.dimension}\u0000${d.entity}`; if (!seen.has(k)) { seen.add(k); out.push(d); } } };
    for (const s of reads(name)) {
      const sm = byName.get(s);
      if (!sm) continue;
      if (sm.entity) add(dimsOf(sm, sm.entity));
      // one hop: a semantic model whose own entity is one of this one's
      for (const e of sm.entities) {
        for (const other of models) if (other !== sm && other.entity === e.name) add(dimsOf(other, e.name));
      }
    }
    reachOf.set(name, out);
    return out;
  };

  const entities = (name) => [...new Set([...reads(name)].flatMap((s) => (byName.get(s)?.entities || []).map((e) => e.name)))].sort();

  const metrics = [...raw.values()].map((m) => ({
    name: m.name, type: m.type,
    ...(m.label ? { label: m.label } : {}),
    ...(m.description ? { description: m.description } : {}),
    // what the project says about reading it (additive: false, a threshold, available_from…)
    ...(hasMeta(m.config?.meta) ? { meta: m.config.meta } : {}),
    semantic_models: [...reads(m.name)].sort(),
  })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { semantic_models: models, metrics, reach, entities };
}

/**
 * Copy the project into PROJECT_CONTEXT (anew on every start: the project may have changed), parse it
 * through the dbt client and read its semantic layer. → { layer } when the project declares metrics,
 * { error } when it cannot be parsed (said in the overview), null when there is nothing to serve.
 */
export async function loadProjectSemantics({ runner, contextManager }) {
  if (!runner?.parse || !runner.semanticManifest || !contextManager?.baseProjectDir) return null;
  // the results earlier queries stored (materialize) outlive a restart as any context's do: their
  // models are carried into the fresh copy, so a stored task is still paged, drilled and built on
  const stored = contextManager.has(PROJECT_CONTEXT) ? contextManager.resultModels(PROJECT_CONTEXT) : [];
  if (contextManager.has(PROJECT_CONTEXT)) contextManager.drop(PROJECT_CONTEXT);
  const ctx = contextManager.create(PROJECT_CONTEXT, { projectSemantics: true });
  const dir = contextManager.dir(ctx.id);
  for (const m of stored) {
    // …with its age: the retention that retires a stored result counts from when it was stored
    const file = contextManager.writeModel(ctx.id, m.name, m.sql);
    try { utimesSync(file, new Date(m.mtimeMs), new Date(m.mtimeMs)); } catch { /* the age restarts */ }
  }
  try { contextManager.ensureTimeSpine?.(ctx.id); } catch { /* the parse says what is missing */ }
  const r = await runner.parse(dir);
  if (!r.ok) {
    contextManager.drop(ctx.id);
    return { error: formatDbtError(r.stdout, r.stderr) || 'the project did not parse' };
  }
  const layer = projectLayer(runner.semanticManifest(dir));
  if (!layer.metrics.length) {
    contextManager.drop(ctx.id);
    return null;
  }
  // served as long as the server runs: never reclaimed for being idle, never built on
  ctx.state = { ...ctx.state, engine: 'project', pinned: true, metrics: layer.metrics.map((m) => ({ name: m.name, type: m.type })), usedModels: [] };
  contextManager.touch(ctx.id);
  return { layer, context_id: ctx.id };
}
