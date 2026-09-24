// THE QUERY TAG — technical facts about where a warehouse query came from, carried as a leading SQL
// comment on every query the call causes: `/* {"app":"dbt-semantic-mcp","client":"claude-ai/1.0",
// "tool":"query_semantic_model","task":"…"} */`. What it says is what the request carried (the
// client application's clientInfo, its User-Agent) plus what this server knows (the tool, the task,
// the context) — technical information for reading the warehouse's query history, NOT an identity:
// nothing in it is verified.
//
// It reaches the SQL on every path this server runs: the dbt / MetricFlow processes get it in
// MCP_QUERY_TAG, and python/query_tag.py puts it in front of every query their dbt adapter sends
// (dbt 1.x and `mf`, on DuckDB and BigQuery alike); dbt v2 is a binary no hook reaches, so its
// client prefixes the SQL it hands over itself (`show --inline`).

import { currentTag } from '../request-context.js';

const APP = 'dbt-semantic-mcp';
const MAX_VALUE = 120;
const MAX_TAG = 600;

/** A tag value made safe inside a SQL block comment: one line, no comment terminator, bounded. */
function clean(value) {
  return String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\*\//g, '* /').replace(/\/\*/g, '/ *').slice(0, MAX_VALUE);
}

/** The text of a tag (JSON) for `fields`, or null when there is nothing to say. */
export function formatQueryTag(fields) {
  if (!fields || !Object.values(fields).some((v) => v != null && v !== '')) return null;
  const out = { app: APP };
  for (const [k, v] of Object.entries(fields)) if (v != null && v !== '') out[k] = clean(v);
  const text = JSON.stringify(out);
  return text.length > MAX_TAG ? `${text.slice(0, MAX_TAG - 1)}…` : text;
}

/** The tag of the call this code runs for, as text — null outside a call. */
export function queryTag() {
  return formatQueryTag(currentTag());
}

/** `sql` with the call's tag in front of it, as a comment (unchanged outside a call). */
export function tagSql(sql) {
  const tag = queryTag();
  return tag ? `/* ${tag} */\n${sql}` : sql;
}
