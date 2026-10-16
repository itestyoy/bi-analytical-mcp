// A SEMANTIC LAYER DECLARED IN A TEST — a declaration ({ name, semantic_models, metrics }) as the
// build_model start it is read as (src/pipeline/semantic-stage.js stepOfDeclaration: the first item's
// model is the main one, the others' measures name their source, a model loaded for its columns is
// joined on its contract), started with materialize: true and settled into the parse's result — the
// layer as dbt parsed it, with its context_id. Most tests are about what the layer computes; this is
// the one place that writes their layer as a build_model call.

import { stepOfDeclaration } from '../../src/pipeline/semantic-stage.js';
import { taskResult } from './settle.js';

/** The build_model start a declaration is. */
export const declaration = (engine, decl) => stepOfDeclaration((engine.raw || engine).catalog, decl);

/** Declare `decl` on `engine` and return the task its materialize started — { task_id, context_id, … },
 *  as a call that starts warehouse work answers (a refusal is thrown as it is). */
export async function startDeclare(engine, decl) {
  const raw = engine.raw || engine;
  const out = await raw.build_model(declaration(raw, decl));
  if (out.materialize?.ok === false) throw Object.assign(new Error(out.materialize.error.message), out.materialize.error);
  return out.materialize;
}

/** Declare `decl` on `engine` and return the parse's result (a refusal is thrown as it is). */
export async function declare(engine, decl) {
  return taskResult(engine.raw || engine, (await startDeclare(engine, decl)).task_id);
}

/**
 * Change the semantic_model step of the build in `contextId` — `change(step)` returns the step it becomes
 * — and materialize it again: the layer the context holds is replaced by the new step's, and the
 * parse's result returned.
 */
export async function editLayer(engine, contextId, change) {
  const raw = engine.raw || engine;
  const { steps } = await raw.build_model({ action: 'preview', context_id: contextId });
  const { index, ...step } = steps.find((s) => s.stage === 'semantic_model');
  await raw.build_model({ action: 'edit_step', context_id: contextId, index, step: change(step) });
  const out = await raw.build_model({ action: 'materialize', context_id: contextId });
  return taskResult(raw, out.task_id);
}
