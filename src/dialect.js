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

// ── Array / struct (complex JSON) helpers ────────────────────────────────────
// event_data scalar keys use jsonExtract; arrays and array-of-struct need
// different SQL per dialect. These keep that dialect logic in one place.

function safeKey(key) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) throw new Error(`Unsafe JSON key: ${key}`);
  return key;
}

/** Number of elements in a JSON array property. */
export function jsonArrayLength(dialect, column, key) {
  safeKey(key);
  if (dialect === 'bigquery') return `ARRAY_LENGTH(JSON_QUERY_ARRAY(${column}, '$.${key}'))`;
  if (dialect === 'snowflake') return `ARRAY_SIZE(${column}:${key})`;
  return `jsonb_array_length(${column}->'${key}')`; // postgres jsonb
}

/** Boolean: does the JSON (string) array property contain `value`. */
export function jsonArrayContains(dialect, column, key, value) {
  safeKey(key);
  if (dialect === 'bigquery') return `${sqlLiteral(value)} IN UNNEST(JSON_VALUE_ARRAY(${column}, '$.${key}'))`;
  if (dialect === 'snowflake') return `ARRAY_CONTAINS(${sqlLiteral(value)}::variant, ${column}:${key})`;
  return `(${column}->'${key}') @> ${sqlLiteral(JSON.stringify([value]))}::jsonb`; // postgres containment
}

/** Extract a scalar field from a JSON struct property, cast to `type`. */
export function jsonStructField(dialect, column, key, field, type = 'string') {
  safeKey(key);
  safeKey(field);
  if (dialect === 'bigquery') {
    const base = `JSON_VALUE(${column}, '$.${key}.${field}')`;
    const ct = castType('bigquery', type);
    return ct ? `CAST(${base} AS ${ct})` : base;
  }
  if (dialect === 'snowflake') {
    const base = `${column}:${key}.${field}`;
    const ct = castType('snowflake', type);
    return ct ? `${base}::${ct}` : `${base}::string`;
  }
  const base = `(${column}->'${key}'->>'${field}')`;
  const ct = castType('postgres', type);
  return ct ? `${base}::${ct}` : base;
}

/**
 * A FROM-clause join that explodes a JSON array property into one row per
 * element, binding the element (or a struct field of it) to `alias`.
 * Returns { join, element } — `join` appended after the base relation, `element`
 * is the SQL expression for the bound value.
 */
export function jsonArrayUnnest(dialect, prevAlias, column, key, alias, field, type = 'string') {
  safeKey(key);
  const elemAlias = `${alias}_e`;
  if (dialect === 'bigquery') {
    if (field) {
      safeKey(field);
      const base = `JSON_VALUE(${elemAlias}, '$.${field}')`;
      const ct = castType('bigquery', type);
      const expr = ct ? `CAST(${base} AS ${ct})` : base;
      return { join: `CROSS JOIN UNNEST(JSON_QUERY_ARRAY(${prevAlias}.${column}, '$.${key}')) AS ${elemAlias}`, element: expr };
    }
    return { join: `CROSS JOIN UNNEST(JSON_VALUE_ARRAY(${prevAlias}.${column}, '$.${key}')) AS ${elemAlias}`, element: elemAlias };
  }
  // postgres jsonb
  if (field) {
    safeKey(field);
    const base = `(${elemAlias}->>'${field}')`;
    const ct = castType('postgres', type);
    const expr = ct ? `${base}::${ct}` : base;
    return { join: `CROSS JOIN LATERAL jsonb_array_elements(${prevAlias}.${column}->'${key}') AS ${elemAlias}`, element: expr };
  }
  return { join: `CROSS JOIN LATERAL jsonb_array_elements_text(${prevAlias}.${column}->'${key}') AS ${elemAlias}`, element: elemAlias };
}
