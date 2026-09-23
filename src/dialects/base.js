// Abstract warehouse dialect. Concrete dialects (postgres.js, bigquery.js)
// implement the abstract methods; shared, dialect-independent logic lives here.
//
// Two responsibilities:
//   1. SQL value/identifier/JSON primitives (jsonExtract, array/struct helpers).
//   2. Lowering a logical pipeline (an ordered op IR) to SQL — Postgres lowers to
//      a chained-CTE; BigQuery lowers to native pipe syntax. The op IR is shared;
//      only the assembly differs, so a stage is written once and runs on both.
import { inertLiteral } from '../jinja-inert.js';

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
    // a literal lands in a file dbt renders as Jinja: an opener in the value never reaches the file
    return inertLiteral(String(value), (v) => `'${v.replace(/'/g, "''")}'`);
  }

  /** Validate a SQL identifier (column/alias/json key) — guards injection. */
  ident(name) {
    if (!IDENT.test(String(name || ''))) throw new Error(`unsafe SQL identifier: ${name}`);
    return name;
  }

  /**
   * SQL for one part of a join key: the column, qualified for the side it belongs to, TRUNCATED to
   * the part's declared grain when it has one — so the two sides are compared at the unit the
   * schema says they join on, whatever each side's column type is.
   */
  keyPartExpr(part, qualify = (c) => c) {
    const col = qualify(this.ident(part.column));
    return part.grain ? this.grainExpr(part.grain, col) : col;
  }

  /**
   * SQL for a whole (possibly COMPOSITE) join key: the parts cast to text and concatenated with
   * a separator. `||` propagates NULL in both dialects, which is what a join key wants — a row
   * missing any part must not match anything.
   */
  compositeKeyExpr(parts, qualify = (c) => c) {
    return parts.map((p) => this.castExpr(this.keyPartExpr(p, qualify), 'string')).join(" || '|' || ");
  }

  /**
   * The key of a pipeline `join` op, part by part, as BOTH sides render it — the single place the
   * two sides of a join are derived, so no dialect can apply a part's grain to one side only.
   * `onKeys` = a relationship declared in the schema (each side has its own column name, and a
   * part may be truncated to the grain it is joined at); `on` = the plain shared-name form.
   * `qualifyLeft` / `qualifyRight` place each side; the default leaves both bare.
   */
  joinKeyParts(op, qualifyLeft = (c) => c, qualifyRight = (c) => c) {
    if (op.onKeys) {
      return op.onKeys.left.map((lp, i) => ({
        name: this.ident(lp.column),
        left: this.keyPartExpr(lp, qualifyLeft),
        right: this.keyPartExpr(op.onKeys.right[i], qualifyRight),
      }));
    }
    return op.on.map((c) => ({ name: this.ident(c), left: qualifyLeft(this.ident(c)), right: qualifyRight(this.ident(c)) }));
  }

  /** True when a key part is compared as an EXPRESSION (a declared grain truncates it) rather than
   *  as the bare column — so a form that can only equate bare columns (BigQuery's `USING`) would
   *  quietly compare the untruncated values instead. */
  joinKeyIsExpression(op) {
    return !!op.onKeys && [...op.onKeys.left, ...op.onKeys.right].some((p) => p.grain);
  }

  /**
   * A row's time inside a version's validity window — the ONE spelling every join form uses.
   * Half-open at the END: a CURRENT version has no end yet (dbt snapshots write NULL into
   * dbt_valid_to), and `BETWEEN … AND NULL` is never true — the plain form drops exactly the rows a
   * "what is it NOW" question is about.
   */
  validityWindow(value, from, to) {
    return `${value} >= ${from} AND (${to} IS NULL OR ${value} <= ${to})`;
  }

  /**
   * The CTE form of a pipeline `join` op: base row plus exactly the attributes it asked for.
   * `between` adds the validity window. Standard SQL, so both dialects join a declared
   * relationship exactly the same way.
   */
  joinCte(prev, op) {
    const eq = this.joinKeyParts(op, (c) => `base.${c}`, (c) => `j.${c}`)
      .map((k) => `${k.left} = ${k.right}`).join(' AND ');
    const btw = op.between
      ? ` AND ${this.validityWindow(`base.${this.ident(op.between.value)}`, `j.${this.ident(op.between.from)}`, `j.${this.ident(op.between.to)}`)}`
      : '';
    const attrs = op.attrs.map((a) => `j.${this.ident(a.column)} AS ${this.ident(a.as)}`);
    return `SELECT base.*${attrs.length ? `, ${attrs.join(', ')}` : ''} FROM ${prev} base ${op.kind || 'LEFT'} JOIN ${op.relation} j ON ${eq}${btw}`;
  }

  isNumericType(type) { return isNumericType(type); }
  isTimeType(type) { return isTimeType(type); }

  // ── Abstract primitives (per-dialect) ──────────────────────────────────────
  castType(_type) { throw new Error('abstract castType'); }
  jsonExtract(_column, _key, _type) { throw new Error('abstract jsonExtract'); }
  jsonArrayLength(_column, _key) { throw new Error('abstract jsonArrayLength'); }
  arrayLength(_column) { throw new Error('abstract arrayLength'); }
  jsonArrayContains(_column, _key, _value) { throw new Error('abstract jsonArrayContains'); }
  jsonStructField(_column, _key, _field, _type) { throw new Error('abstract jsonStructField'); }
  /** { join, element }: a FROM-join that explodes an array property + the element expr.
   *  encoding: 'blob' (json column at $.key), 'json' (flat STRING holding a JSON array),
   *  or 'native' (a real ARRAY/REPEATED column). */
  arrayUnnest(_prevAlias, _column, _key, _alias, _field, _type, _encoding) { throw new Error('abstract arrayUnnest'); }
  /** Parse a STRING column holding a JSON array into a real (native) array expression. */
  jsonParseArray(_column) { throw new Error('abstract jsonParseArray'); }
  /** Element at a 1-based index of a native array. */
  arrayElementAt(_column, _index) { throw new Error('abstract arrayElementAt'); }
  /** Last element of a native array. */
  arrayLast(_column) { throw new Error('abstract arrayLast'); }

  // ── Abstract time / scalar / statistical primitives (per-dialect) ──────────
  /** Difference toExpr - fromExpr expressed in `unit` (day|hour|minute|second). */
  dateDiff(_unit, _fromExpr, _toExpr) { throw new Error('abstract dateDiff'); }
  /** Whole 24-HOUR days between two timestamps (retention-day: floor of the span in 24h buckets,
   *  NOT calendar days). Signed; the caller clamps negatives / coalesces NULLs. */
  fullDaysBetween(_fromExpr, _toExpr) { throw new Error('abstract fullDaysBetween'); }
  /** Truncate a timestamp/date to a granularity (day|week|month|quarter|year). */
  dateTrunc(_granularity, _expr) { throw new Error('abstract dateTrunc'); }

  /**
   * A join KEY truncated to its declared grain. Separate from `dateTrunc` because a key column's
   * type is not declared anywhere — the two sides of a per-day join may be a DATE on one side and
   * a TIMESTAMP on the other — so this form must work for both, while `dateTrunc` keeps serving
   * the caller's own explicit truncation.
   */
  grainExpr(granularity, expr) { return this.dateTrunc(granularity, expr); }
  /** Extract a calendar part (dow|hour|day|week|month|quarter|year|doy) as a number. */
  datePart(_part, _expr) { throw new Error('abstract datePart'); }
  /** Current timestamp. */
  nowExpr() { throw new Error('abstract nowExpr'); }
  /** Round expr to `places` decimals. */
  roundExpr(_expr, _places) { throw new Error('abstract roundExpr'); }
  /** Cast expr to a logical type. */
  castExpr(_expr, _type) { throw new Error('abstract castExpr'); }
  /** Substring of a string expr (1-based start, optional length). */
  substringExpr(_expr, _start, _len) { throw new Error('abstract substringExpr'); }
  /** Integer day number (days since 1970-01-01) of a date/timestamp expr — the
   *  portable ORDER BY key for value-based RANGE windows (e.g. last N days). */
  unixDateExpr(_expr) { throw new Error('abstract unixDateExpr'); }
  /** Extract a scalar field from a JSON-valued column (e.g. an unnested struct element). */
  jsonColumnField(_column, _field, _type) { throw new Error('abstract jsonColumnField'); }

  // ── COLUMN-level complex primitives. The pair above works on a JSON BLOB plus a key; these
  // work on a FLATTENED payload column that itself holds the array/object — the shape a
  // warehouse produces when the payload is exploded into real columns (a crash fact's
  // breadcrumbs / stack frames / custom keys), where there is no blob to key into.
  /** Element count of a column holding a JSON ARRAY (string or json-typed). */
  jsonColumnArrayLength(_column) { throw new Error('abstract jsonColumnArrayLength'); }

  /** Membership in a column holding a JSON ARRAY. */
  jsonColumnArrayContains(_column, _value) { throw new Error('abstract jsonColumnArrayContains'); }

  /** Membership in a NATIVE array column. */
  arrayContains(_column, _value) { throw new Error('abstract arrayContains'); }

  /** One field of a column holding a JSON OBJECT (string or json-typed). */
  jsonColumnStructField(_column, _field, _type) { throw new Error('abstract jsonColumnStructField'); }
  /** Statistical aggregate (stddev|variance|median|percentile) over a column. */
  statAggExpr(_fn, _columnSql, _q) { throw new Error('abstract statAggExpr'); }
  /**
   * Which of those this warehouse computes APPROXIMATELY. Declared, not guessed: a percentile that
   * is exact on one warehouse is a sketch on another, and a caller that reports "the P99" has to
   * know which of the two it got. It also decides cost — the exact form has to order the values,
   * which is what puts a whole table in one worker's memory.
   */
  get approximateStats() { return []; }
  /** Approximate distinct count (HLL++ where available). */
  approxCountDistinct(_columnSql) { throw new Error('abstract approxCountDistinct'); }
  // ── HLL++ mergeable sketches (the additive distinct-count workflow) ─────────
  /** Build a sketch over a column (aggregate). */
  hllInit(_columnSql) { throw new Error('abstract hllInit'); }
  /** Merge sketches and return the distinct cardinality (aggregate). */
  hllMerge(_sketchSql) { throw new Error('abstract hllMerge'); }
  /** Merge sketches into a coarser sketch — additivity for staged/rolling rollups (aggregate). */
  hllMergePartial(_sketchSql) { throw new Error('abstract hllMergePartial'); }
  /** Distinct cardinality from one sketch (scalar). */
  hllExtract(_sketchSql) { throw new Error('abstract hllExtract'); }

  // ── Abstract pipeline lowering (per-dialect) ───────────────────────────────
  // Lower a base relation + ordered op IR (see pipeline.js) to a single SQL text.
  renderPipeline(_baseRelation, _ops) { throw new Error('abstract renderPipeline'); }
  /* eslint-enable class-methods-use-this */
}
