// Abstract warehouse dialect. Concrete dialects (postgres.js, bigquery.js)
// implement the abstract methods; shared, dialect-independent logic lives here.
//
// Two responsibilities:
//   1. SQL value/identifier/JSON primitives (jsonExtract, array/struct helpers).
//   2. Lowering a logical pipeline (an ordered op IR) to SQL — Postgres lowers to
//      a chained-CTE; BigQuery lowers to native pipe syntax. The op IR is shared;
//      only the assembly differs, so a stage is written once and runs on both.

const NUMERIC_TYPES = new Set(['int', 'integer', 'numeric', 'float', 'double', 'bigint']);
const TIME_TYPES = new Set(['date', 'timestamp', 'timestamptz', 'timestamp_ntz', 'timestamp_tz', 'datetime', 'time']);
const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function isNumericType(type) {
  return NUMERIC_TYPES.has(String(type || '').toLowerCase());
}
export function isTimeType(type) {
  return TIME_TYPES.has(String(type || '').toLowerCase());
}

export class Dialect {
  /* eslint-disable class-methods-use-this */
  get name() { throw new Error('abstract'); }

  /** A safe SQL string/number/boolean literal (shared across dialects). */
  sqlLiteral(value) {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number') return String(value);
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    return `'${String(value).replace(/'/g, "''")}'`;
  }

  /** Validate a SQL identifier (column/alias/json key) — guards injection. */
  ident(name) {
    if (!IDENT.test(String(name || ''))) throw new Error(`unsafe SQL identifier: ${name}`);
    return name;
  }

  isNumericType(type) { return isNumericType(type); }
  isTimeType(type) { return isTimeType(type); }

  // ── Abstract primitives (per-dialect) ──────────────────────────────────────
  castType(_type) { throw new Error('abstract castType'); }
  jsonExtract(_column, _key, _type) { throw new Error('abstract jsonExtract'); }
  jsonArrayLength(_column, _key) { throw new Error('abstract jsonArrayLength'); }
  jsonArrayContains(_column, _key, _value) { throw new Error('abstract jsonArrayContains'); }
  jsonStructField(_column, _key, _field, _type) { throw new Error('abstract jsonStructField'); }
  /** { join, element }: a FROM-join that explodes an array property + the element expr. */
  arrayUnnest(_prevAlias, _column, _key, _alias, _field, _type) { throw new Error('abstract arrayUnnest'); }

  // ── Abstract time / scalar / statistical primitives (per-dialect) ──────────
  /** Difference toExpr - fromExpr expressed in `unit` (day|hour|minute|second). */
  dateDiff(_unit, _fromExpr, _toExpr) { throw new Error('abstract dateDiff'); }
  /** Truncate a timestamp/date to a granularity (day|week|month|quarter|year). */
  dateTrunc(_granularity, _expr) { throw new Error('abstract dateTrunc'); }
  /** Extract a calendar part (dow|hour|day|week|month|quarter|year|doy) as a number. */
  datePart(_part, _expr) { throw new Error('abstract datePart'); }
  /** Current timestamp. */
  nowExpr() { throw new Error('abstract nowExpr'); }
  /** Round expr to `places` decimals. */
  roundExpr(_expr, _places) { throw new Error('abstract roundExpr'); }
  /** Cast expr to a logical type. */
  castExpr(_expr, _type) { throw new Error('abstract castExpr'); }
  /** Statistical aggregate (stddev|variance|median|percentile) over a column. */
  statAggExpr(_fn, _columnSql, _q) { throw new Error('abstract statAggExpr'); }

  // ── Abstract pipeline lowering (per-dialect) ───────────────────────────────
  // Lower a base relation + ordered op IR (see pipeline.js) to a single SQL text.
  renderPipeline(_baseRelation, _ops) { throw new Error('abstract renderPipeline'); }
  /* eslint-enable class-methods-use-this */
}
