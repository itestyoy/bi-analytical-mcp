// A COLUMN'S TYPE, AS THE CATALOG READS IT — a warehouse data type seen as a dimension type (time or
// categorical), as a pipeline column type (an array of its items), and whether it is a boolean; the type a
// native array property is read as, and the one rule by which a warehouse's type replaces a declared one.

import { isNumericType } from '../dialects/base.js';

// Native dbt `data_type`s that map to a MetricFlow time dimension.
export const TIME_DATA_TYPES = new Set(['date', 'timestamp', 'timestamptz', 'timestamp_ntz', 'timestamp_tz', 'datetime', 'time']);

/** Logical dimension type derived from the native dbt column `data_type`. */
export function dimTypeFromDataType(dataType) {
  return TIME_DATA_TYPES.has(String(dataType || '').toLowerCase()) ? 'time' : 'categorical';
}

/** Coarse pipeline type for a physical column (so pipelines can reference it). An array column is an
 *  array of its declared items where it holds a native one, and text where it holds JSON. */
export function pipelineColumnType(cm, col) {
  if (cm.is_time) return 'time';
  if (cm.is_event_data) return 'json';
  if (cm.array) {
    const enc = cm.array.encoding || (String(col.data_type).toLowerCase() === 'string' ? 'json' : 'native');
    if (enc !== 'native') return 'string';
    return cm.array.fields ? 'array<struct>' : arrayColumnType(cm.array.items);
  }
  const dt = String(col.data_type || '').toLowerCase();
  if (TIME_DATA_TYPES.has(dt)) return 'time';
  if (isBooleanType(dt)) return 'boolean';
  return isNumericType(dt) ? 'numeric' : 'string';
}

/** A warehouse type that is a boolean (BigQuery BOOL / BOOLEAN, DuckDB BOOLEAN / BOOL). */
export const isBooleanType = (t) => /^bool(ean)?$/i.test(String(t || '').trim());

/** A type that is an array — of scalars (`array`, `array<int>` …) or of structs (`array<struct>`):
 *  an event property's declared type, or a pipeline column's; what an unnest explodes. */
export const isArrayPropertyType = (t) => String(t || '').toLowerCase().startsWith('array');

/**
 * AN ARRAY'S ITEMS AS A PIPELINE TYPE — a catalog's `items` word or a warehouse's element type (INT64,
 * BIGINT, FLOAT64, DOUBLE, NUMERIC, DECIMAL(…), STRING, VARCHAR, BOOL, TIMESTAMP …) in the words a value
 * is tracked by: int, float, numeric, string (the cast type words), boolean, time, json — 'struct' for a
 * struct, and 'unknown' (not claimed) for anything else.
 */
export function itemType(items) {
  const t = String(items || '').trim().toLowerCase();
  if (/^(struct|record|row)\b/.test(t)) return 'struct';
  if (/[[<]|^(array|list|map)\b/.test(t)) return 'unknown'; // an array of arrays, of maps
  if (isBooleanType(t)) return 'boolean';
  if (/^(date|datetime|time|timestamp)\b/.test(t)) return 'time';
  if (/^(tinyint|smallint|int|integer|bigint|hugeint|uhugeint|ubigint|uinteger|usmallint|utinyint|int2|int4|int8|int16|int32|int64)\b/.test(t)) return 'int';
  if (/^(float|float4|float8|float64|double|real)\b/.test(t)) return 'float';
  if (/^(decimal|numeric|bignumeric|bigdecimal)\b/.test(t)) return 'numeric';
  if (/^(string|varchar|text|char|bpchar)\b/.test(t)) return 'string';
  if (t === 'json') return 'json';
  return 'unknown';
}

/** The pipeline type of a NATIVE array whose items are `items`: 'array<int>', 'array<string>' …
 *  ('array<struct>' of structs) — 'array' where its items are not known. */
export function arrayColumnType(items) {
  const t = itemType(items);
  return t === 'unknown' ? 'array' : `array<${t}>`;
}

/** The type of one element of an array of pipeline type `t` — its items' type ('struct' for a struct),
 *  'unknown' (not claimed) where they are not known. */
export const elementType = (t) => /^array<(.+)>$/.exec(String(t || '').toLowerCase())?.[1] || 'unknown';

/**
 * THE TYPE A NATIVE ARRAY EVENT PROPERTY IS READ AS — an array of its items: as its column is tracked
 * where it is read (`tracked`: the warehouse's, once it was asked), else as the catalog declares them (a
 * struct array's `array<struct>`, a scalar one's `items`); 'array' where neither says. The one reader of
 * it — a { property } read (src/pipeline/compute.js) and an unnest of one (src/pipeline/stages.js) — so
 * the two spellings of one column, and a { column } read of it, agree.
 */
export function nativeArrayType(spec, tracked = null) {
  if (isArrayPropertyType(tracked) && tracked !== 'array') return String(tracked).toLowerCase();
  return String(spec?.type || '').toLowerCase() === 'array<struct>' ? 'array<struct>' : arrayColumnType(spec?.items);
}

/**
 * The type a column is tracked by once the warehouse has said what it holds (`physical`, a
 * physicalColumnType): the warehouse's — a scalar's for a scalar, an array of its items for a native
 * array, whatever a column declared with no type — and the declared one where the warehouse says less
 * (an array whose items it does not name, nothing) or what is of another kind (a JSON payload; an array
 * declared where it reports a scalar). The one rule of grounding: the catalog's (Catalog.typeToPhysical),
 * a build's source columns (src/pipeline.js) and a joined model's (src/pipeline/stages.js).
 */
export function groundedType(declared, physical) {
  if (!physical || physical === 'unknown') return declared;
  if (!declared || declared === 'unknown') return physical;
  if (declared === 'json') return declared;
  const arrays = [declared, physical].filter(isArrayPropertyType).length;
  if (arrays === 1) return declared;
  return arrays === 2 && physical === 'array' ? declared : physical;
}

/**
 * A pipeline column type from the type a WAREHOUSE reports for a built column (BigQuery's INT64,
 * FLOAT64, TIMESTAMP, ARRAY<…>; DuckDB's BIGINT, DOUBLE, TIMESTAMP WITH TIME ZONE, VARCHAR[] …) —
 * for a column whose type no stage could say before it was built. An array is an array of its items; a
 * scalar is read by the one vocabulary of warehouse type words (itemType), a number of any kind numeric.
 */
export function physicalColumnType(dtype) {
  const t = String(dtype || '').trim().toLowerCase();
  if (!t) return 'unknown';
  const items = /^(?:array|list)\s*<(.*)>$/.exec(t)?.[1] ?? /^(.*)\[\d*\]$/.exec(t)?.[1];
  if (items !== undefined) return arrayColumnType(items);
  if (/^(array|list)\b/.test(t)) return 'array';
  const k = itemType(t);
  if (k === 'int' || k === 'float' || k === 'numeric') return 'numeric';
  return k === 'boolean' || k === 'time' ? k : 'string';
}
