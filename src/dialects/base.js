// Abstract warehouse dialect. Concrete dialects (duckdb.js, bigquery.js)
// implement the abstract methods; shared, dialect-independent logic lives here.
//
// Two responsibilities:
//   1. SQL value/identifier/JSON primitives (jsonExtract, array/struct helpers).
//   2. Lowering a logical pipeline (an ordered op IR) to SQL — DuckDB lowers to
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

/** A literal of `value`, its text quoted by `quote` (the warehouse's own string syntax). */
function literal(value, quote) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  const s = String(value);
  // DuckDB's parser ends a string at a NUL and BigQuery's CHR(0) is empty: no SQL says it alike
  if (s.includes('\0')) throw new Error(`the text constant ${JSON.stringify(s)} holds a NUL character (U+0000), which no warehouse reads alike in SQL — leave it out of the constant`);
  // a literal lands in a file dbt renders as Jinja: an opener in the value never reaches the file
  return inertLiteral(s, quote);
}

// The characters the warehouses quote DIFFERENTLY: a quote (DuckDB doubles it, BigQuery escapes it with a
// backslash), a backslash (an escape on BigQuery, a plain character on DuckDB) and a control character
// (a newline cannot stand in a BigQuery quoted string).
const UNEVEN = /['\\\x00-\x1f]/;

/** A text quoted as both warehouses read it alike: a plain quoted string where it holds none of the UNEVEN
 *  characters, each of those otherwise CHR(code) — a function both name alike — joined to the rest by ||. */
function portableText(s) {
  if (!UNEVEN.test(s)) return `'${s}'`;
  const parts = [];
  let run = '';
  for (const ch of s) {
    if (!UNEVEN.test(ch)) { run += ch; continue; }
    if (run) parts.push(`'${run}'`);
    run = '';
    parts.push(`CHR(${ch.codePointAt(0)})`);
  }
  if (run) parts.push(`'${run}'`);
  return `(${parts.join(' || ')})`;
}

/**
 * A safe SQL literal for a writer that does not know which warehouse it writes for: the same text reads
 * as the same value on every dialect. A writer that holds its dialect writes `dialect.sqlLiteral`, the
 * warehouse's own string syntax.
 */
export function sqlLiteral(value) {
  return literal(value, portableText);
}

export class Dialect {
  /* eslint-disable class-methods-use-this */
  get name() { throw new Error('abstract'); }

  /** A safe SQL string/number/boolean literal, its text in this warehouse's string syntax (quoteText). */
  sqlLiteral(value) {
    return literal(value, (s) => this.quoteText(s));
  }

  /** A text as a standard SQL string: a quote doubled, every other character (a backslash, a newline)
   *  as it is. */
  quoteText(s) {
    return `'${s.replace(/'/g, "''")}'`;
  }

  /** Validate a SQL identifier (column/alias/json key) — guards injection. */
  ident(name) {
    if (!IDENT.test(String(name || ''))) throw new Error(`unsafe SQL identifier: ${name}`);
    return name;
  }

  /** A validated identifier, quoted — a column a caller named may be a keyword (group, order). */
  quoteIdent(name) {
    return `"${this.ident(name)}"`;
  }

  /**
   * SQL for one part of a join key: the column, qualified for the side it belongs to, TRUNCATED to
   * the part's declared grain when it has one — so the two sides are compared at the unit the
   * schema says they join on, whatever each side's column type is.
   */
  keyPartExpr(part, qualify = (c) => c) {
    const col = qualify(this.quoteIdent(part.column));
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
        name: this.quoteIdent(lp.column),
        left: this.keyPartExpr(lp, qualifyLeft),
        right: this.keyPartExpr(op.onKeys.right[i], qualifyRight),
      }));
    }
    return op.on.map((c) => ({ name: this.quoteIdent(c), left: qualifyLeft(this.quoteIdent(c)), right: qualifyRight(this.quoteIdent(c)) }));
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
    // compared as moments: the bounds may be DATEs and the row's time a TIMESTAMP (timeOperand)
    const [v, f, t] = [value, from, to].map((x) => this.timeOperand(x));
    return `${v} >= ${f} AND (${to} IS NULL OR ${v} <= ${t})`;
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
      ? ` AND ${this.validityWindow(`base.${this.quoteIdent(op.between.column)}`, `j.${this.quoteIdent(op.between.from)}`, `j.${this.quoteIdent(op.between.to)}`)}`
      : '';
    const attrs = op.attrs.map((a) => `j.${this.quoteIdent(a.column)} AS ${this.quoteIdent(a.as)}`);
    return `SELECT base.*${attrs.length ? `, ${attrs.join(', ')}` : ''} FROM ${prev} base ${op.kind || 'LEFT'} JOIN ${op.relation} j ON ${eq}${btw}`;
  }

  isNumericType(type) { return isNumericType(type); }
  isTimeType(type) { return isTimeType(type); }

  /**
   * One sort key of an ORDER BY: the expression, its direction, and where its NULLs go — written
   * explicitly, last unless asked first, since the warehouses' own defaults differ (DuckDB puts them
   * last, BigQuery first in an ascending sort). The order_by stage and a read write theirs with it.
   */
  orderKey(sql, direction, nulls) {
    return `${sql} ${direction === 'desc' ? 'DESC' : 'ASC'} NULLS ${nulls === 'first' ? 'FIRST' : 'LAST'}`;
  }

  /**
   * A window's ORDER BY keys ([{ sql, direction, nulls }]) — of an aggregate of a frame (`aggregate`,
   * with its `frame`) or of a rank / a neighbour. Here every key is an orderKey; a dialect whose window
   * takes no NULLS clause somewhere writes the same order its own way.
   */
  windowOrder(keys, _opts = {}) {
    return keys.map((k) => this.orderKey(k.sql, k.direction, k.nulls)).join(', ');
  }

  /**
   * Whether this warehouse matches a funnel whose steps are the immediately next events
   * (match_recognize between_steps: 'none'): a row-pattern match without fillers says it directly;
   * the CTE lowering has no way to say "nothing in between".
   */
  get matchesAdjacentSteps() { return false; }

  // ── Abstract primitives (per-dialect) ──────────────────────────────────────
  castType(_type) { throw new Error('abstract castType'); }
  jsonExtract(_column, _key, _type) { throw new Error('abstract jsonExtract'); }
  // An array's length is 0 where there is no array — a NULL, an absent key, a value that is no array —
  // in every form (a native array, a JSON column, a key of the payload, a parsed JSON array), alike on
  // every warehouse.
  jsonArrayLength(_column, _key) { throw new Error('abstract jsonArrayLength'); }
  arrayLength(_column) { throw new Error('abstract arrayLength'); }
  jsonArrayContains(_column, _key, _value) { throw new Error('abstract jsonArrayContains'); }
  jsonStructField(_column, _key, _field, _type) { throw new Error('abstract jsonStructField'); }
  /** A key of a JSON column as its JSON text — an array or an object as JSON, not a scalar's value. */
  jsonExtractJson(_column, _key) { throw new Error('abstract jsonExtractJson'); }
  /** { join, element }: a FROM-join that explodes an array property + the element expr.
   *  encoding: 'blob' (json column at $.key), 'json' (flat STRING holding a JSON array),
   *  or 'native' (a real ARRAY/REPEATED column). `column` is a bare name, written quoted. */
  arrayUnnest(_prevAlias, _column, _key, _alias, _field, _type, _encoding) { throw new Error('abstract arrayUnnest'); }
  /** Parse a STRING column holding a JSON array into a real (native) array expression. */
  jsonParseArray(_column) { throw new Error('abstract jsonParseArray'); }
  /** Element at a 1-based index of a native array. */
  arrayElementAt(_column, _index) { throw new Error('abstract arrayElementAt'); }
  /** Last element of a native array. */
  arrayLast(_column) { throw new Error('abstract arrayLast'); }

  // ── Abstract time / scalar / statistical primitives (per-dialect) ──────────
  /** The WHOLE `unit`s (day|hour|minute|second) elapsed from fromExpr to toExpr, truncated toward
   *  zero (an hour and 59 minutes is 1 hour; signed), as an integer — the same count on every warehouse. */
  dateDiff(_unit, _fromExpr, _toExpr) { throw new Error('abstract dateDiff'); }
  /** The seconds from one moment to another (a date or a timestamp), as a number with the fraction of a
   *  second (a funnel's time between steps). */
  secondsBetween(_fromExpr, _toExpr) { throw new Error('abstract secondsBetween'); }
  /** The body of the daily time spine MetricFlow needs: one `date_day` per day, start..end inclusive. */
  timeSpineSelect(_start, _end) { throw new Error('abstract timeSpineSelect'); }
  /** A stable bucket in [0, buckets) for a value — the same value always lands in the same bucket,
   *  on every run: a deterministic sample of users is `bucket < share * buckets`. */
  valueBucket(_expr, _buckets) { throw new Error('abstract valueBucket'); }
  /** Whole 24-HOUR days between two moments (retention-day: FLOOR of the span in 24h buckets, so a
   *  moment before `from` is day -1, NOT calendar days). Signed; the caller clamps negatives / coalesces
   *  NULLs. */
  fullDaysBetween(_fromExpr, _toExpr) { throw new Error('abstract fullDaysBetween'); }
  /** Truncate a moment (a date, a datetime or a timestamp) to a granularity (day|week|month|quarter|year),
   *  as a timestamp. A week is the ISO week, starting on Monday, on every warehouse (as MetricFlow's week is). */
  dateTrunc(_granularity, _expr) { throw new Error('abstract dateTrunc'); }

  /**
   * A join KEY truncated to its declared grain. Separate from `dateTrunc` because a key column's
   * type is not declared anywhere — the two sides of a per-day join may be a DATE on one side and
   * a TIMESTAMP on the other — so this form must work for both, while `dateTrunc` keeps serving
   * the caller's own explicit truncation.
   */
  grainExpr(granularity, expr) { return this.dateTrunc(granularity, expr); }
  /** Extract a calendar part (dow|hour|day|week|month|quarter|year|doy) of a moment (a date, a datetime or
   *  a timestamp) as a number — dow the ISO day of the week (Monday 1 … Sunday 7), week the ISO week
   *  number, on every warehouse. `type`: the value's tracked type where it is known (a time_of_day has
   *  its hour alone). */
  datePart(_part, _expr, _type) { throw new Error('abstract datePart'); }
  /** Current timestamp. */
  nowExpr() { throw new Error('abstract nowExpr'); }
  /** A moment as compared with another expression: one where a date and a timestamp do not meet as they are. */
  timeOperand(expr) { return expr; }
  /** Round expr to `places` decimals. */
  roundExpr(_expr, _places) { throw new Error('abstract roundExpr'); }
  /** Cast expr to a type word (int | numeric | float | string), SAFE: what will not convert is NULL for
   *  its row. ONE RULE ON EVERY WAREHOUSE — to int, the number a value holds, rounded half away from zero:
   *  a number's, a text's (by fromText), a flag's 1 / 0. `from` is the value's tracked type; of none known
   *  ('unknown', null), the value is read as its text (a flag's true / false as 1 / 0). */
  castExpr(_expr, _type, _from) { throw new Error('abstract castExpr'); }
  /** A text read as a type word: the number it holds where it is written as a number (an int rounded half
   *  away from zero, a numeric to 9 places); a boolean where it says true or false (in any case, around
   *  spaces); a moment where it is written as one (a date, a timestamp — with a zone, the instant it
   *  names; without, UTC — a timestamp read as a TIMESTAMP, a date as the DATE of that moment); missing
   *  where it holds none of these; as it is for text. The one conversion of a text — cast's, and every
   *  typed read of JSON or an array's. */
  fromText(_expr, _type) { throw new Error('abstract fromText'); }
  /** The dbt config keys that make a table this server builds expire `days` after it is (re)built,
   *  for a model in `language` ('sql': its config() line | 'python': its YAML config): {} where the
   *  warehouse keeps no expiry. */
  expiryConfig(_days, _language) { return {}; }
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
  /**
   * A time column as the semantic layer reads it. MetricFlow keeps time in ONE type per warehouse — its
   * time spine and every truncation are of it — and a time dimension of another type is compared with
   * them as it is, which a strict warehouse refuses. Here the column is its own type.
   */
  semanticTimeExpr(column, _dataType) { return column; }
  /** Approximate distinct count (HLL++ where available). */
  approxCountDistinct(_columnSql) { throw new Error('abstract approxCountDistinct'); }
  // ── the value index's scans ─────────────────────────────────────────────────
  /** Rows of the last `days` days on time column `col` (a positive integer, checked by the caller). */
  recentSince(_col, _days) { throw new Error('abstract recentSince'); }
  /** Rows STRICTLY NEWER than an epoch-ms watermark on time column `col`. */
  sinceTimestampMs(_col, _ms) { throw new Error('abstract sinceTimestampMs'); }
  /** The K most frequent values WITH their counts in one aggregate, as a JSON string
   *  ([{ value, count }]), or null where the warehouse has none that carries the counts. */
  approxTopK(_expr, _k) { return null; }
  /** One cell of approxTopK's output as [{ value, freq }] — read by the dialect that writes it. */
  parseTopK(_raw) { throw new Error('abstract parseTopK'); }
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
