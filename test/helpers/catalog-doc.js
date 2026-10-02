// Reaching into a PARSED catalog document (a dbt schema YAML) to build a variant of it.
//
// The MCP block lives under `config:` on models and columns (`config.meta.mcp`) — the one place the
// loader reads. A test that builds a variant edits that block.

/** The `mcp` block of a parsed model/column. */
export function mcp(node) {
  const block = node?.config?.meta?.mcp;
  if (!block) throw new Error(`this node declares no meta.mcp: ${JSON.stringify(node?.name ?? node)}`);
  return block;
}

/** Replace a node's whole `mcp` block. */
export function setMcp(node, block) {
  node.config = { ...(node.config || {}), meta: { ...(node.config?.meta || {}), mcp: block } };
  return node;
}
