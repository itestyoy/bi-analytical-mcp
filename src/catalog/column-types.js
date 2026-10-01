// A COLUMN'S TYPE, AS THE CATALOG READS IT — a warehouse data type seen as a dimension type (time or
// categorical), as a pipeline column type, and whether it is a boolean.

import { isNumericType } from '../dialect.js';

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
