// Functional facade over the dialect classes (src/dialects/*), kept so existing
// callers (compile/predicate/match-recognize/projection) need no change. The
// single source of dialect logic lives in the classes; this just delegates.
// Exactly two dialects are supported: duckdb and bigquery.

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
  return getDialect('duckdb').sqlLiteral(value); // escaping is identical across our dialects
}

export function jsonArrayLength(dialect, column, key) {
  return getDialect(dialect).jsonArrayLength(column, key);
}

/** Element count of a NATIVE array COLUMN (a REPEATED/ARRAY column, not a JSON blob key). */
export function arrayLength(dialect, column) {
  return getDialect(dialect).arrayLength(column);
}

/**
 * Element count of a COLUMN that holds a whole JSON array — whatever its physical type: a STRING
 * with JSON text, or a native JSON / jsonb column. Both dialects' functions accept either, so no
 * string literal is ever compared against the column (BigQuery defines no JSON = STRING operator).
 */
export function jsonColumnArrayLength(dialect, column) {
  return getDialect(dialect).jsonColumnArrayLength(column);
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

/** Rows of the last `days` days on `col` (null for no window: `days` not a positive integer). */
export function recentSince(dialect, col, days) {
  const n = Math.floor(Number(days));
  return col && Number.isFinite(n) && n > 0 ? getDialect(dialect).recentSince(col, n) : null;
}

/** Rows strictly newer than an epoch-ms watermark on `col` — the incremental-merge delta scan
 *  (null → the caller re-scans everything rather than risk a bad bound). */
export function sinceTimestampMs(dialect, col, ms) {
  const n = Math.floor(Number(ms));
  return col && Number.isFinite(n) ? getDialect(dialect).sinceTimestampMs(col, n) : null;
}

/** The warehouse's distinct count for a cardinality scan — the same expression the pipeline's
 *  approx_count_distinct writes (exact on DuckDB, where numbers are checked exactly). */
export function approxCountDistinct(dialect, expr) {
  return getDialect(dialect).approxCountDistinct(expr);
}

/** The K most frequent values with their counts in one aggregate, or null (→ a GROUP BY per property). */
export function approxTopK(dialect, expr, k = 50) {
  return getDialect(dialect).approxTopK(expr, k);
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
