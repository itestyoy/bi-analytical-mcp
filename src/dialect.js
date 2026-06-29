// Functional facade over the dialect classes (src/dialects/*), kept so existing
// callers (compile/predicate/match-recognize/projection) need no change. The
// single source of dialect logic lives in the classes; this just delegates.
// Exactly two dialects are supported: postgres and bigquery.

import { getDialect } from './dialects/index.js';
import { isNumericType as _isNumericType } from './dialects/base.js';

export { SUPPORTED_DIALECTS } from './dialects/index.js';

export function isNumericType(type) {
  return _isNumericType(type);
}

export function jsonExtract(dialect, column, key, type = 'string') {
  return getDialect(dialect).jsonExtract(column, key, type);
}

/** A SQL string literal, safely single-quoted (dialect-independent). */
export function sqlLiteral(value) {
  return getDialect('postgres').sqlLiteral(value); // escaping is identical across our dialects
}

export function jsonArrayLength(dialect, column, key) {
  return getDialect(dialect).jsonArrayLength(column, key);
}

export function jsonArrayContains(dialect, column, key, value) {
  return getDialect(dialect).jsonArrayContains(column, key, value);
}

export function jsonStructField(dialect, column, key, field, type = 'string') {
  return getDialect(dialect).jsonStructField(column, key, field, type);
}

export function jsonArrayUnnest(dialect, prevAlias, column, key, alias, field, type = 'string') {
  return getDialect(dialect).arrayUnnest(prevAlias, column, key, alias, field, type);
}

/** CAST(expr AS <type>) in the dialect's spelling (numeric/int/float). */
export function castExpr(dialect, expr, type) {
  return getDialect(dialect).castExpr(expr, type);
}

/**
 * SQL predicate restricting `col` to the last `days` days (for bounding the value-index
 * scans on a partitioned fact). `days` MUST be a positive integer (caller-validated; it is
 * interpolated). Returns null for dialects we do not have a safe expression for → no window.
 */
export function recentSince(dialect, col, days) {
  const n = Math.floor(Number(days));
  if (!col || !Number.isFinite(n) || n <= 0) return null;
  const d = String(dialect || '').toLowerCase();
  if (d === 'postgres' || d === 'postgresql' || d === 'redshift') return `${col} >= CURRENT_TIMESTAMP - INTERVAL '${n} days'`;
  if (d === 'bigquery') return `${col} >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${n} DAY)`;
  if (d === 'snowflake') return `${col} >= DATEADD(day, -${n}, CURRENT_TIMESTAMP())`;
  if (d === 'duckdb') return `${col} >= now() - INTERVAL '${n} days'`;
  return null; // unknown dialect → no window (best-effort, never break the scan)
}

/**
 * APPROXIMATE distinct-count expression (HLL-class) for `expr`, or null when the dialect has
 * no built-in (→ caller falls back to exact COUNT(DISTINCT)). A cheaper cardinality scan on
 * a large fact; the count becomes approximate, so it is OPT-IN at the indexer.
 */
export function approxCountDistinct(dialect, expr) {
  const d = String(dialect || '').toLowerCase();
  if (d === 'bigquery' || d === 'snowflake' || d === 'duckdb') return `APPROX_COUNT_DISTINCT(${expr})`;
  if (d === 'redshift') return `APPROXIMATE COUNT(DISTINCT ${expr})`;
  return null; // postgres & unknown → no native approx; use exact COUNT(DISTINCT)
}

/**
 * APPROXIMATE top-K expression returning the K most frequent values WITH their counts in a
 * single aggregate — lets the indexer collect top-values for MANY properties in ONE scan.
 * null when the dialect has no count-bearing top-k (→ caller does a per-property GROUP BY,
 * the most efficient option that DB has). Note: DuckDB's approx_top_k returns values WITHOUT
 * counts, so it is intentionally excluded (we need frequencies).
 */
export function approxTopK(dialect, expr, k = 50) {
  const d = String(dialect || '').toLowerCase();
  const n = Math.max(1, Math.floor(Number(k) || 50));
  // Wrap the array result in a JSON STRING: APPROX_TOP_COUNT/APPROX_TOP_K return a nested
  // ARRAY<STRUCT> that `dbt show --output json` CANNOT serialize (the query runs fine in the
  // warehouse, but the show step then errors). A plain JSON string serializes cleanly and
  // parseApproxTopK() parses it back.
  if (d === 'bigquery') return `TO_JSON_STRING(APPROX_TOP_COUNT(${expr}, ${n}))`; // → "[{\"value\":..,\"count\":..}]"
  if (d === 'snowflake') return `TO_JSON(APPROX_TOP_K(${expr}, ${n}))`;            // → "[[value,count],..]"
  return null;
}

/**
 * Normalise an approx-top-k cell (from `dbt show --output json`) to [{ value, freq }],
 * tolerating both the BigQuery [{value,count}] and Snowflake [[value,count]] shapes and a
 * JSON-string-encoded value. Returns [] if it cannot be parsed (caller then falls back).
 */
export function parseApproxTopK(raw) {
  let arr = raw;
  if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch { return []; } }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const e of arr) {
    if (e == null) continue;
    if (Array.isArray(e)) { // [value, count]
      if (e[0] != null) out.push({ value: e[0], freq: Number(e[1]) || 0 });
    } else if (typeof e === 'object') { // { value, count } (case-insensitive keys)
      const lower = Object.fromEntries(Object.entries(e).map(([k, v]) => [k.toLowerCase(), v]));
      const v = lower.value ?? lower.val ?? lower.element;
      if (v != null) out.push({ value: v, freq: Number(lower.count ?? lower.cnt ?? lower.frequency) || 0 });
    }
  }
  return out;
}
