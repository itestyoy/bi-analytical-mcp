// The pipeline stage union lives ONCE per tool schema, under `$defs.pipeline_stage`, and every
// place that takes a stage points at it with `$ref` (src/pipeline.js → stageDefs). Before that the
// union was inlined at each site, which on the production catalog meant ~49 KB of identical schema
// handed to the client twice in one tool.
//
// Tests that look at what a stage's schema SAYS therefore have to resolve the ref. This helper is
// that one line, so a test reads as "the python branch of the stage union" instead of as a walk
// through the document.

import { deref, field, forms, pinned } from './schema-nav.js';

/** The stage union of a tool schema, wherever the tool puts it (`stage`, or `pipeline.stages`): one
 *  entry per stage — a stage written as several forms (compute, one per op) is one entry, its union. */
export function stageUnion(toolSchema, prop = 'stage') {
  const node = prop === 'stage'
    ? field(toolSchema, toolSchema, 'stage')
    : deref(toolSchema, field(toolSchema, field(toolSchema, toolSchema, 'pipeline'), 'stages')?.items);
  return (deref(toolSchema, node)?.anyOf || []).map((b) => deref(toolSchema, b));
}

/** The stage a branch of the union is (the name every one of its forms pins `stage` to). */
export function stageOf(toolSchema, branch) {
  return pinned(toolSchema, forms(toolSchema, branch)[0], 'stage')[0];
}

/** One branch of it, by the stage name its forms pin. */
export function stageBranch(toolSchema, name, prop = 'stage') {
  return stageUnion(toolSchema, prop).find((b) => stageOf(toolSchema, b) === name);
}

/** The stage names a tool offers — what is available on this deployment. */
export function stageNames(toolSchema, prop = 'stage') {
  return stageUnion(toolSchema, prop).map((b) => stageOf(toolSchema, b));
}
