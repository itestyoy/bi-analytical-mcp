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
