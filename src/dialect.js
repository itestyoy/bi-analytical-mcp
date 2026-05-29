// Warehouse-specific SQL expression rendering.
// The catalog stores logical names; physical SQL (esp. JSON extraction from the
// events `event_properties` column) is produced here, per warehouse dialect.

const NUMERIC_TYPES = new Set(['int', 'integer', 'numeric', 'float', 'double', 'bigint']);

export function isNumericType(type) {
  return NUMERIC_TYPES.has(String(type || '').toLowerCase());
}

/** SQL cast target for a logical property type, per dialect. */
function castType(dialect, type) {
  const t = String(type || 'string').toLowerCase();
  if (dialect === 'postgres') {
    return { int: 'int', integer: 'int', bigint: 'bigint', numeric: 'numeric', float: 'double precision', double: 'double precision' }[t];
  }
  if (dialect === 'bigquery') {
    return { int: 'INT64', integer: 'INT64', bigint: 'INT64', numeric: 'NUMERIC', float: 'FLOAT64', double: 'FLOAT64' }[t];
  }
  if (dialect === 'snowflake') {
    return { int: 'NUMBER', integer: 'NUMBER', bigint: 'NUMBER', numeric: 'NUMBER', float: 'FLOAT', double: 'FLOAT' }[t];
  }
  return undefined;
}

/**
 * Render an expression that extracts `key` from a JSON column for the dialect,
 * casting to `type` when not a string.
 */
export function jsonExtract(dialect, column, key, type = 'string') {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
    throw new Error(`Unsafe JSON key: ${key}`);
  }
  const t = String(type || 'string').toLowerCase();
  if (dialect === 'postgres') {
    const base = `(${column}->>'${key}')`;
    const ct = castType(dialect, t);
    return ct ? `${base}::${ct}` : base;
  }
  if (dialect === 'bigquery') {
    const base = `JSON_VALUE(${column}, '$.${key}')`;
    const ct = castType(dialect, t);
    return ct ? `CAST(${base} AS ${ct})` : base;
  }
  if (dialect === 'snowflake') {
    const base = `${column}:${key}`;
    const ct = castType(dialect, t);
    return ct ? `${base}::${ct}` : `${base}::string`;
  }
  throw new Error(`Unsupported warehouse_dialect: ${dialect}`);
}

/** A SQL string literal, safely single-quoted for the dialects we support. */
export function sqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return `'${String(value).replace(/'/g, "''")}'`;
}
