// Reaching into a PARSED catalog document (a dbt schema YAML) to build a variant of it.
//
// dbt 1.10 moved `meta` under `config:` on models and columns, and the catalogs this repo ships are
// written that way — it is the only place dbt Fusion reads. A test that builds a variant is editing
// the author's file, so it has to reach the block where the author put it; these two helpers are
// that reach, and they work on either shape, because the loader accepts either too.

/** The live `mcp` block of a parsed model/column — under `config:` (dbt 1.10+) or at the top. */
export function mcp(node) {
  const block = node?.config?.meta?.mcp ?? node?.meta?.mcp;
  if (!block) throw new Error(`this node declares no meta.mcp: ${JSON.stringify(node?.name ?? node)}`);
  return block;
}

/** Replace a node's whole `mcp` block, writing it where dbt 1.10+ expects it. */
export function setMcp(node, block) {
  node.config = { ...(node.config || {}), meta: { ...(node.config?.meta || {}), mcp: block } };
  delete node.meta; // so the two places cannot disagree in the file the variant writes out
  return node;
}
