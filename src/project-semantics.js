// THE PROJECT'S OWN SEMANTIC LAYER — the semantic models and metrics the dbt project (DBT_BASE_PROJECT)
// declares itself, read once at start and queried with query_semantic_model like any context: no build
// step, since they are already defined and do not change while the server runs.
//
// At start the server copies the project into ONE internal context (PROJECT_STORE, never addressed by a
// caller), parses it through the dbt client, and reads the semantic manifest dbt wrote into the LAYER
// (src/semantic-manifest.js), and asks MetricFlow what each metric can be grouped by (src/group-by-items.js)
// — the joins, entity paths and grains are MetricFlow's, never worked out here. Each of the project's
// semantic models is then a context of its OWN,
// addressed by its name as the project declares it (context_id: "<semantic model>") — its metrics (and every metric made of
// metrics that read it), its dimensions — all of them working in that one parsed copy, so nothing is
// copied or parsed per model. A query is checked against the layer before anything runs, and
// MetricFlow runs it over the copy exactly as the project defines it. Nothing is rendered or
// rewritten: the project's YAML is the definition.

import { utimesSync } from 'node:fs';
import { formatDbtError } from './dbt/output.js';
import { manifestLayer } from './semantic-manifest.js';
import { annotateChains } from './group-by-items.js';
import { CONTEXT_ID } from './context-manager.js';

/** The internal context holding the parsed copy of the project that the per-model contexts share. */
export const PROJECT_STORE = '_project';

/**
 * Copy the project into PROJECT_STORE (anew on every start: the project may have changed), parse it
 * through the dbt client, read its semantic layer, and register one context per semantic model.
 * → { layer, contexts, skipped?, dimension_only? } when the project declares metrics, { error } when it
 * cannot be parsed (said in the overview), null when there is nothing to serve. A start that serves
 * nothing keeps the store while it holds results earlier starts stored.
 */
export async function loadProjectSemantics({ runner, contextManager }) {
  if (!runner?.parse || !runner.semanticManifest || !contextManager?.baseProjectDir) return null;
  // the results earlier queries stored (materialize) outlive a restart as any context's do: their
  // models are carried into the fresh copy, so a stored task is still paged, drilled and built on
  const stored = contextManager.has(PROJECT_STORE) ? contextManager.resultModels(PROJECT_STORE) : [];
  // …and who reads them: the pipelines started from a stored result are recorded on the context that
  // owns it, which is registered anew below
  const consumersOf = new Map(contextManager.sharing(PROJECT_STORE).map((id) => [id, contextManager.get(id).state.checkpoint_consumers]).filter(([, c]) => c && Object.keys(c).length));
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
  // the copy is kept as long as the server runs: never reclaimed for being idle, never built on, and
  // nobody's to address — its semantic models are
  store.state = { ...store.state, engine: 'project-store', pinned: true, internal: true };
  // a start that serves nothing still keeps the results earlier ones stored, for the next start that
  // does — only a store with none is let go
  const serveNothing = (out) => { if (!stored.length) contextManager.drop(store.id); else contextManager.touch(store.id); return out; };
  const r = await runner.parse(dir);
  if (!r.ok) return serveNothing({ error: formatDbtError(r.stdout, r.stderr) || 'the project did not parse' });
  const layer = manifestLayer(runner.semanticManifest(dir));
  if (!layer.metrics.length) return serveNothing(null);
  // what each metric can be grouped by, as MetricFlow itself resolves it over this copy — every join,
  // entity path and grain is MetricFlow's word, never a rule this server applies on its own
  if (!runner.groupBys) return serveNothing({ error: 'the query engine cannot list what the metrics can be grouped by (MetricFlow)' });
  const listed = await runner.groupBys(dir, layer.metrics.map((m) => m.name));
  if (!listed.ok) return serveNothing({ error: `MetricFlow could not list what the project's metrics can be grouped by: ${listed.error}` });
  // …each hop of an entity path named by the model it joins onto, as a caller names a chain
  layer.groupBys = annotateChains(listed.group_bys, layer.semantic_models);
  // the dbt model each semantic model reads, as dbt recorded it (the cost guardrail's key)
  layer.sources = runner.semanticModelSources ? runner.semanticModelSources(dir) : {};
  const contexts = [];
  const skipped = [];
  const dimensionOnly = [];
  for (const sm of layer.semantic_models) {
    // a semantic model no metric reads has nothing to query in a context of its own: its dimensions
    // are reached from the contexts of the models whose metrics reach it
    const metrics = layer.metrics.filter((m) => m.semantic_models.includes(sm.name));
    if (!metrics.length) { dimensionOnly.push(sm.name); continue; }
    // a context a task built under the same id keeps it (context ids of tasks are generated, so this
    // is a name the project would have to pick on purpose)
    if (!new RegExp(CONTEXT_ID).test(sm.name)) { skipped.push({ semantic_model: sm.name, reason: `its name is not a context id (${CONTEXT_ID})` }); continue; }
    if (contextManager.has(sm.name)) { skipped.push({ semantic_model: sm.name, reason: `a context '${sm.name}' already exists` }); continue; }
    contextManager.createShared(sm.name, PROJECT_STORE, {
      engine: 'project', pinned: true, semantic_model: sm.name,
      metrics: metrics.map((m) => ({ name: m.name, type: m.type })),
      ...(consumersOf.has(sm.name) ? { checkpoint_consumers: consumersOf.get(sm.name) } : {}),
    });
    contexts.push(sm.name);
  }
  contextManager.touch(store.id);
  return { layer, contexts, ...(skipped.length ? { skipped } : {}), ...(dimensionOnly.length ? { dimension_only: dimensionOnly } : {}) };
}
