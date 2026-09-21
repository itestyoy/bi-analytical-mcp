// The pipeline stage union lives ONCE per tool schema, under `$defs.pipeline_stage`, and every
// place that takes a stage points at it with `$ref` (src/pipeline.js → stageDefs). Before that the
// union was inlined at each site, which on the production catalog meant ~49 KB of identical schema
// handed to the client twice in one tool.
//
// Tests that look at what a stage's schema SAYS therefore have to resolve the ref. This helper is
// that one line, so a test reads as "the python branch of the stage union" instead of as a walk
// through the document.

/** The stage union of a tool schema, wherever the tool puts it (`stage`, or `pipeline.stages`). */
export function stageUnion(toolSchema, prop = 'stage') {
  const node = prop === 'stage'
    ? toolSchema.properties?.stage
    : toolSchema.properties?.pipeline?.properties?.stages?.items;
  const target = node?.$ref ? resolve(toolSchema, node.$ref) : node;
  return target?.oneOf || target?.anyOf || [];
}

/** One branch of it, by the stage name its discriminator pins. */
export function stageBranch(toolSchema, name, prop = 'stage') {
  return stageUnion(toolSchema, prop).find((b) => b.properties?.stage?.enum?.[0] === name || b.properties?.stage?.const === name);
}

/** The stage names a tool offers — what is available on this deployment. */
export function stageNames(toolSchema, prop = 'stage') {
  return stageUnion(toolSchema, prop).map((b) => b.properties?.stage?.enum?.[0] ?? b.properties?.stage?.const);
}

function resolve(doc, ref) {
  return String(ref).replace(/^#\//, '').split('/').reduce((node, key) => node?.[decodeURIComponent(key)], doc);
}
