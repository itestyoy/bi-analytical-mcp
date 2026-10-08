// A COLUMN'S TYPE, AS THE CATALOG READS IT — a warehouse data type seen as a dimension type (time or
// categorical), as a pipeline column type, and whether it is a boolean.

import { isNumericType } from '../dialects/base.js';

// Native dbt `data_type`s that map to a MetricFlow time dimension.
export const TIME_DATA_TYPES = new Set(['date', 'timestamp', 'timestamptz', 'timestamp_ntz', 'timestamp_tz', 'datetime', 'time']);

/** Logical dimension type derived from the native dbt column `data_type`. */
export function dimTypeFromDataType(dataType) {
  return TIME_DATA_TYPES.has(String(dataType || '').toLowerCase()) ? 'time' : 'categorical';
}

/** Coarse pipeline type for a physical column (so pipelines can reference it). */
export function pipelineColumnType(cm, col) {
  if (cm.is_time) return 'time';
  if (cm.is_event_data) return 'json';
  if (cm.array) {
    const enc = cm.array.encoding || (String(col.data_type).toLowerCase() === 'string' ? 'json' : 'native');
    return enc === 'native' ? 'array' : 'string';
  }
  const dt = String(col.data_type || '').toLowerCase();
  if (TIME_DATA_TYPES.has(dt)) return 'time';
  if (isBooleanType(dt)) return 'boolean';
  return isNumericType(dt) ? 'numeric' : 'string';
}

/** A warehouse type that is a boolean (BigQuery BOOL / BOOLEAN, DuckDB BOOLEAN / BOOL). */
export const isBooleanType = (t) => /^bool(ean)?$/i.test(String(t || '').trim());

/** An event property's declared type that is an array — of scalars (`array`) or of structs
 *  (`array<struct>`): what an unnest explodes. */
export const isArrayPropertyType = (t) => String(t || '').toLowerCase().startsWith('array');

/**
 * A pipeline column type from the type a WAREHOUSE reports for a built column (BigQuery's INT64,
 * FLOAT64, TIMESTAMP, ARRAY<…>; DuckDB's BIGINT, DOUBLE, TIMESTAMP WITH TIME ZONE, VARCHAR[] …) —
 * for a column whose type no stage could say before it was built.
 */
export function physicalColumnType(dtype) {
  const t = String(dtype || '').trim().toLowerCase();
  if (!t) return 'unknown';
  if (/\[\]$|^(array|list)\b/.test(t)) return 'array';
  if (isBooleanType(t)) return 'boolean';
  if (/^(date|datetime|time|timestamp)\b/.test(t)) return 'time';
  if (/^(tinyint|smallint|int|integer|bigint|hugeint|ubigint|uinteger|usmallint|utinyint|int64|float|float64|double|real|decimal|numeric|bignumeric)\b/.test(t)) return 'numeric';
  return 'string';
}
