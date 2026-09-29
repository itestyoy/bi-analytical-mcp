// THE PROJECT'S OWN SEMANTIC LAYER — the semantic models and metrics the dbt project (DBT_BASE_PROJECT)
// declares itself, read once at start and queried with query_semantic_model like any context: no build
// step, since they are already defined and do not change while the server runs.
//
// At start the server copies the project into a context of its own (PROJECT_CONTEXT), parses it
// through the dbt client, and reads the semantic manifest dbt wrote into the LAYER (src/semantic-manifest.js):
// the metrics, the semantic models, and for each metric the dimensions and entities it can be grouped
// and filtered by. A query is checked against that before anything runs, and MetricFlow runs it
// over the project's copy exactly as the project defines it. Nothing is rendered or rewritten: the
// project's YAML is the definition.

import { utimesSync } from 'node:fs';
import { formatDbtError } from './dbt/output.js';
import { manifestLayer } from './semantic-manifest.js';

/** The context the project's semantic layer is served from — a fixed id, the same on every start. */
export const PROJECT_CONTEXT = 'project';

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
  const layer = manifestLayer(runner.semanticManifest(dir));
  if (!layer.metrics.length) {
    contextManager.drop(ctx.id);
    return null;
  }
  // served as long as the server runs: never reclaimed for being idle, never built on
  ctx.state = { ...ctx.state, engine: 'project', pinned: true, metrics: layer.metrics.map((m) => ({ name: m.name, type: m.type })), usedModels: [] };
  contextManager.touch(ctx.id);
  return { layer, context_id: ctx.id };
}
