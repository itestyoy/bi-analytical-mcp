// THE PROJECT'S OWN SEMANTIC LAYER — the semantic models and metrics the dbt project (DBT_BASE_PROJECT)
// declares itself, read once at start and queried with query_semantic_model like any context: no build
// step, since they are already defined and do not change while the server runs.
//
// At start the server copies the project into ONE internal context (PROJECT_STORE, never addressed by a
// caller), parses it through the dbt client, and reads the semantic manifest dbt wrote into the LAYER
// (src/semantic-manifest.js). Each of the project's semantic models is then a context of its OWN,
// addressed by its name (context_id: "aso_store_performance") — its metrics (and every metric made of
// metrics that read it), its dimensions — all of them working in that one parsed copy, so nothing is
// copied or parsed per model. A query is checked against the layer before anything runs, and
// MetricFlow runs it over the copy exactly as the project defines it. Nothing is rendered or
// rewritten: the project's YAML is the definition.

import { utimesSync } from 'node:fs';
import { formatDbtError } from './dbt/output.js';
import { manifestLayer } from './semantic-manifest.js';
import { CONTEXT_ID } from './context-manager.js';

/** The internal context holding the parsed copy of the project that the per-model contexts share. */
export const PROJECT_STORE = '_project';

/**
 * Copy the project into PROJECT_STORE (anew on every start: the project may have changed), parse it
 * through the dbt client, read its semantic layer, and register one context per semantic model.
 * → { layer, contexts, skipped? } when the project declares metrics, { error } when it cannot be parsed
 * (said in the overview), null when there is nothing to serve.
 */
export async function loadProjectSemantics({ runner, contextManager }) {
  if (!runner?.parse || !runner.semanticManifest || !contextManager?.baseProjectDir) return null;
  // the results earlier queries stored (materialize) outlive a restart as any context's do: their
  // models are carried into the fresh copy, so a stored task is still paged, drilled and built on
  const stored = contextManager.has(PROJECT_STORE) ? contextManager.resultModels(PROJECT_STORE) : [];
  for (const id of contextManager.sharing(PROJECT_STORE)) contextManager.drop(id);
  if (contextManager.has(PROJECT_STORE)) contextManager.drop(PROJECT_STORE);
  const store = contextManager.create(PROJECT_STORE, { projectSemantics: true });
  const dir = contextManager.dir(store.id);
  for (const m of stored) {
    // …with its age: the retention that retires a stored result counts from when it was stored
    const file = contextManager.writeModel(store.id, m.name, m.sql);
    try { utimesSync(file, new Date(m.mtimeMs), new Date(m.mtimeMs)); } catch { /* the age restarts */ }
  }
  try { contextManager.ensureTimeSpine?.(store.id); } catch { /* the parse says what is missing */ }
  const r = await runner.parse(dir);
  if (!r.ok) {
    contextManager.drop(store.id);
    return { error: formatDbtError(r.stdout, r.stderr) || 'the project did not parse' };
  }
  const layer = manifestLayer(runner.semanticManifest(dir));
  if (!layer.metrics.length) {
    contextManager.drop(store.id);
    return null;
  }
  // the copy is served as long as the server runs: never reclaimed for being idle, never built on,
  // and nobody's to address — its semantic models are
  store.state = { ...store.state, engine: 'project-store', pinned: true, internal: true };
  const contexts = [];
  const skipped = [];
  for (const sm of layer.semantic_models) {
    // a context a task built under the same id keeps it (context ids of tasks are generated, so this
    // is a name the project would have to pick on purpose)
    if (!new RegExp(CONTEXT_ID).test(sm.name)) { skipped.push({ semantic_model: sm.name, reason: `its name is not a context id (${CONTEXT_ID})` }); continue; }
    if (contextManager.has(sm.name)) { skipped.push({ semantic_model: sm.name, reason: `a context '${sm.name}' already exists` }); continue; }
    contextManager.createShared(sm.name, PROJECT_STORE, {
      engine: 'project', pinned: true, semantic_model: sm.name,
      metrics: layer.metrics.filter((m) => m.semantic_models.includes(sm.name)).map((m) => ({ name: m.name, type: m.type })),
    });
    contexts.push(sm.name);
  }
  contextManager.touch(store.id);
  return { layer, contexts, ...(skipped.length ? { skipped } : {}) };
}
