// DuckDB dialect: JSON/list primitives + pipeline lowering to a chained CTE. The warehouse for
// local work and the tests (a database in a file — one process at a time, see src/dbt/process.js);
// production runs on BigQuery. Where DuckDB and BigQuery could answer the same question differently
// (a value that does not parse, a malformed JSON row), this dialect answers as BigQuery does: NULL for
// that row, a result for the rest — never a failed statement.

import { Dialect, isNumericType, isTimeType } from './base.js';
import { isBooleanType } from '../catalog/column-types.js';

// An integer is a BIGINT, as BigQuery's INT64. Numbers come back as DOUBLE, not DECIMAL: DuckDB's bare
// DECIMAL is (18,3) and would round a price.
const CASTS = { int: 'BIGINT', integer: 'BIGINT', bigint: 'BIGINT', numeric: 'DOUBLE', float: 'DOUBLE', double: 'DOUBLE' };
// A text is read as a number through an exact decimal of BigQuery's NUMERIC precision and scale, so both
// warehouses read the same number out of it ('1e3' is 1000; 'nan', 'inf' and '1e40' are missing alike) —
// rounded half away from zero where it has more places, as NUMERIC rounds it. Only a text BigQuery reads
// as a number at all is read as one (its literal — a float's also inf, infinity and nan, in any case):
// DuckDB also takes digits split by '_' ('1_000'), which BigQuery does not.
const EXACT = 'DECIMAL(38,9)';
const DIGITS = '([0-9]+[.]?[0-9]*|[.][0-9]+)([eE][+-]?[0-9]+)?';
const NUMBER_TEXT = `[+-]?${DIGITS}`;
const FLOAT_TEXT = `[+-]?(${DIGITS}|inf|infinity|nan)`;
// GoogleSQL's canonical TIMESTAMP text — what BigQuery's SAFE_CAST reads as a moment, as NUMBER_TEXT is
// what it reads as a number: YYYY-[M]M-[D]D, then { |T|t}[H]H:[M]M:[S]S[.F] (an hour 00–23, the seconds
// written, up to six fractional digits), then Z, an offset ±H[H][:MM] or ±HHMM, or after a space a tz name
// (read with the 'i' flag). DuckDB's own cast also reads '2024/01/05', 'epoch', '±infinity', an hour 24, a
// time without seconds and nine fractional digits, which BigQuery does not: those are missing on both.
const MOMENT_TEXT = '[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}([ t]([01]?[0-9]|2[0-3]):[0-5]?[0-9]:[0-5]?[0-9]([.][0-9]{1,6})?(z|[+-]([0-9]{1,2}(:[0-9]{2})?|[0-9]{4})| [a-z][a-z0-9_+-]*(/[a-z0-9_+-]+)*)?)?';
// A moment of MOMENT_TEXT written with a zone after its time of day — Z, an offset or a zone name: the
// instant it names, as BigQuery reads it. DuckDB's own TIMESTAMP cast drops an offset.
const ZONED_TEXT = '.*[0-9]:[0-9]{1,2}:[0-9]{1,2}([.][0-9]*)?(z|[+-].+| .+)';
// The whitespace a text read as a flag or a moment is trimmed of: ONE set on both warehouses (DuckDB's
// trim() alone removes spaces only, BigQuery's TRIM() every Unicode whitespace character) — space, tab,
// newline, vertical tab, form feed, carriage return.
const BLANK = "(' ' || chr(9) || chr(10) || chr(11) || chr(12) || chr(13))";

/** A JSON path to one key: `$."key"` (the key is a validated identifier). */
const keyPath = (key) => `'$."${key}"'`;


export class DuckDBDialect extends Dialect {
  get name() { return 'duckdb'; }

  /** A pipeline is lowered to chained CTEs: plain SQL any parser reads. */
  get writesPipeSyntax() { return false; }

  castType(type) { return CASTS[String(type || '').toLowerCase()]; }

  /**
   * A JSON read guarded against a row that does not hold JSON: DuckDB's JSON functions RAISE on
   * malformed text, and one such row would fail the whole statement. Such a row reads as NULL.
   */
  _whenJson(column, expr, extra = '') {
    return `(CASE WHEN json_valid(${column})${extra ? ` AND ${extra}` : ''} THEN ${expr} END)`;
  }

  jsonExtract(column, key, type = 'string') {
    this.ident(key);
    return this.fromText(this._whenJson(column, `json_extract_string(${column}, ${keyPath(key)})`), type);
  }

  jsonArrayLength(column, key) {
    this.ident(key);
    // A payload key is not typed: on some rows it may hold a scalar where others hold an array.
    // Not an array (absent, a scalar, a row that holds no JSON) → no array here: length 0.
    return `COALESCE(${this._whenJson(column, `json_array_length(${column}, ${keyPath(key)})`, `json_type(${column}, ${keyPath(key)}) = 'ARRAY'`)}, 0)`;
  }

  // Element count of a native LIST column (an empty list is 0, a missing one 0 as on the other side).
  arrayLength(column) { return `COALESCE(len(${column}), 0)`; }

  // A JSON array's elements are text, as every read of one has them (json_extract_string of each): the
  // value looked for is its text too, so 5 finds 5 and "5" alike, as BigQuery's JSON_VALUE_ARRAY does.
  jsonArrayContains(column, key, value) {
    this.ident(key);
    return this._whenJson(column, `list_contains(json_extract_string(${column}, '$."${key}"[*]'), ${this.sqlLiteral(value == null ? null : String(value))})`, `json_type(${column}, ${keyPath(key)}) = 'ARRAY'`);
  }

  jsonStructField(column, key, field, type = 'string') {
    this.ident(key); this.ident(field);
    return this.fromText(this._whenJson(column, `json_extract_string(${column}, '$."${key}"."${field}"')`), type);
  }

  /** A key's value as its JSON text — an array or an object as JSON, a string quoted — as BigQuery's
   *  JSON_QUERY writes it. */
  jsonExtractJson(column, key) {
    this.ident(key);
    return this._whenJson(column, `CAST(json_extract(${column}, ${keyPath(key)}) AS VARCHAR)`);
  }

  /**
   * One row per element of an array: a native LIST column, a key of a JSON column holding an array
   * (blob), or a string column holding a JSON array (encoding 'json'). A row whose value is not an
   * array contributes no elements. The element is read as it is stored — a native list's item as its
   * type (a struct's `field` as that field's), a JSON array's scalar as text; `type` (a kept draft's)
   * converts it as a text is (fromText). The array column is written quoted, as every column is.
   */
  arrayUnnest(prevAlias, column, key, alias, field, type = 'string', encoding = 'blob') {
    this.ident(alias);
    const e = `${alias}_e`;
    const pa = prevAlias ? `${prevAlias}.` : '';
    const lateral = (list) => `CROSS JOIN LATERAL (SELECT unnest(${list}) AS v) AS ${e}`;
    const cast = (x) => this.fromText(x, type);
    const src = `${pa}${this.quoteIdent(column)}`;
    if (key == null && encoding === 'native') return { join: lateral(src), element: cast(field ? `struct_extract(${e}.v, '${this.ident(field)}')` : `${e}.v`) };
    let path;
    if (key != null) { this.ident(key); path = `$."${key}"`; } else { path = '$'; }
    const isArray = `json_type(${src}, '${path}') = 'ARRAY'`;
    const elements = (fn) => `COALESCE(${this._whenJson(src, `${fn}(${src}, '${path}[*]')`, isArray)}, [])`;
    if (field) {
      this.ident(field);
      return { join: lateral(elements('json_extract')), element: cast(`json_extract_string(${e}.v, '$."${field}"')`) };
    }
    if (type === 'json') return { join: lateral(elements('json_extract')), element: `${e}.v` }; // the whole struct element, for multi-field extraction downstream
    return { join: lateral(elements('json_extract_string')), element: cast(`${e}.v`) };
  }

  /** STRING holding a JSON array → a native VARCHAR[] list (so it can be unnested as native). */
  jsonParseArray(column) {
    return this._whenJson(column, `json_extract_string(${column}, '$[*]')`, `json_type(${column}) = 'ARRAY'`);
  }

  arrayElementAt(column, index) { return `list_extract(${column}, ${Number(index)})`; } // 1-based
  arrayLast(column) { return `list_extract(${column}, -1)`; }

  /** Extract a scalar field from a JSON-valued COLUMN (e.g. an unnested struct element). */
  jsonColumnField(column, field, type = 'string') {
    this.ident(field);
    return this.fromText(`json_extract_string(${column}, '$."${field}"')`, type);
  }

  // ── column-level complex primitives (a flattened payload column, no blob) ──
  // (a value that is no JSON array — NULL, a scalar, no JSON — is a missing array: length 0)
  jsonColumnArrayLength(column) {
    return `COALESCE(${this._whenJson(column, `json_array_length(${column})`, `json_type(${column}) = 'ARRAY'`)}, 0)`;
  }

  // (its elements are text, as jsonArrayContains says)
  jsonColumnArrayContains(column, value) {
    return this._whenJson(column, `list_contains(json_extract_string(${column}, '$[*]'), ${this.sqlLiteral(value == null ? null : String(value))})`, `json_type(${column}) = 'ARRAY'`);
  }

  // (the value as the caller wrote it in the type of the list's items — src/pipeline/compute.js)
  arrayContains(column, value) { return `list_contains(${column}, ${this.sqlLiteral(value)})`; }

  jsonColumnStructField(column, field, type = 'string') {
    this.ident(field);
    return this.fromText(this._whenJson(column, `json_extract_string(${column}, '$."${field}"')`), type);
  }

  // ── time / scalar / statistical ────────────────────────────────────────────
  _epoch(expr) { return `epoch(CAST(${expr} AS TIMESTAMP))`; }

  valueBucket(expr, buckets) { return `(hash(CAST(${expr} AS VARCHAR)) % ${Number(buckets)})`; }

  // (both read as TIMESTAMP, as dateDiff's: a DATE minus a DATE is a count of days, which has no epoch;
  //  the exact microseconds subtracted, then divided — as BigQuery's TIMESTAMP_DIFF(…, MICROSECOND) / 1000000,
  //  where two epochs in seconds, DOUBLEs, would read 1.2 s as 1.2000000476837158)
  secondsBetween(from, to) { return `((epoch_us(CAST(${to} AS TIMESTAMP)) - epoch_us(CAST(${from} AS TIMESTAMP))) / 1000000)`; }
  // range() is a table of timestamps, one per day
  timeSpineSelect(start, end) { return `select cast(range as date) as date_day\nfrom range(date '${start}', date '${end}' + interval 1 day, interval 1 day)`; }

  // The whole units elapsed, truncated toward zero — as BigQuery's TIMESTAMP_DIFF counts them: the
  // span in seconds divided by the unit, trunc'd (CAST alone would round), an integer.
  dateDiff(unit, from, to) {
    const secs = { day: 86400, hour: 3600, minute: 60, second: 1 }[unit];
    if (!secs) throw new Error(`dateDiff: bad unit ${unit}`);
    return `CAST(trunc((${this._epoch(to)} - ${this._epoch(from)}) / ${secs}) AS BIGINT)`;
  }

  // Whole 24-HOUR days between two timestamps (retention-day style): floor of the elapsed span in
  // 24h buckets — as BigQuery's fullDaysBetween counts it (FLOOR of TIMESTAMP_DIFF in microseconds), NOT
  // calendar days. floor() (not dateDiff's trunc) puts a pre-install moment on day -1, not day 0.
  fullDaysBetween(from, to) {
    return `CAST(FLOOR((${this._epoch(to)} - ${this._epoch(from)}) / 86400.0) AS INTEGER)`;
  }

  // A key column may be a DATE on one side and a TIMESTAMP on the other, so both are lifted to
  // timestamp before truncating — the dialects must derive a key the same way.
  grainExpr(granularity, expr) {
    if (!['day', 'week', 'month', 'quarter', 'year'].includes(granularity)) throw new Error(`grainExpr: bad granularity ${granularity}`);
    return `date_trunc('${granularity}', CAST(${expr} AS TIMESTAMP))`;
  }

  // a moment (stored as UTC) as the wall clock of `tz`: the UTC instant, then that zone's local time
  inTimezone(expr, tz) { return `timezone(${this.sqlLiteral(tz)}, timezone('UTC', CAST(${expr} AS TIMESTAMP)))`; }

  // (DuckDB's week is the ISO week: it starts on Monday)
  dateTrunc(granularity, expr) {
    if (!['day', 'week', 'month', 'quarter', 'year'].includes(granularity)) throw new Error(`dateTrunc: bad granularity ${granularity}`);
    return `date_trunc('${granularity}', ${expr})`;
  }

  // the ISO day of the week (isodow: Monday 1 … Sunday 7 — dow would count Sunday 0); week is DuckDB's ISO week
  datePart(part, expr) {
    const p = { dow: 'isodow', hour: 'hour', day: 'day', week: 'week', month: 'month', quarter: 'quarter', year: 'year', doy: 'doy' }[part];
    if (!p) throw new Error(`datePart: bad part ${part}`);
    return `EXTRACT(${p} FROM ${expr})`;
  }

  // a plain TIMESTAMP (now() is WITH TIME ZONE), comparable with the TIMESTAMP columns
  nowExpr() { return 'CAST(now() AS TIMESTAMP)'; }

  roundExpr(expr, places = 0) { return `round(CAST(${expr} AS DOUBLE), ${Number(places)})`; }

  // SAFE cast only: a value that does not convert is NULL for its row (TRY_CAST), as BigQuery's
  // SAFE_CAST — a raw CAST would abort the whole statement on the first payload holding a word. ONE RULE
  // ON BOTH WAREHOUSES: an integer is the number a value holds, rounded half away from zero (as BigQuery
  // converts a FLOAT64 or a NUMERIC) — a number through round(), since a DOUBLE's own cast rounds half to
  // EVEN (2.5 → 2), a numeric to NUMERIC's 9 places (EXACT); a text through fromText; a flag 1 or 0. `from`
  // is the value's type where the writer knows it; of none known ('unknown', null — a raw's), the value is
  // read as its text, which a number and a flag have too — a flag's true / false is 1 / 0 — as BigQuery
  // reads it.
  castExpr(expr, type, from = null) {
    const ct = this.castType(type);
    if (!ct) return `CAST(${expr} AS VARCHAR)`;
    if (isNumericType(from)) {
      if (ct === 'BIGINT') return `TRY_CAST(round(${expr}) AS BIGINT)`;
      return String(type).toLowerCase() === 'numeric' ? `TRY_CAST(TRY_CAST(${expr} AS ${EXACT}) AS DOUBLE)` : `TRY_CAST(${expr} AS DOUBLE)`;
    }
    if (isBooleanType(from)) return `TRY_CAST(${expr} AS ${ct})`;
    if (from == null || from === 'unknown') {
      const text = `CAST(${expr} AS VARCHAR)`;
      return `(CASE ${text} WHEN 'true' THEN 1 WHEN 'false' THEN 0 ELSE ${this.fromText(text, type)} END)`;
    }
    return this.fromText(expr, type);
  }

  /** A text read as `type`: the number it holds — an integer rounded half away from zero, a numeric to
   *  NUMERIC's 9 places, a float as a double — where it is written as BigQuery reads one (NUMBER_TEXT,
   *  FLOAT_TEXT), and missing where it holds none; a flag its true / false in any case; a moment as
   *  BigQuery reads it, only in GoogleSQL's canonical form (_textMoment, MOMENT_TEXT), a date that
   *  moment's DATE — a flag and a moment trimmed of the whitespace both warehouses trim (BLANK); as it is
   *  for a type none of these is (text). The one conversion of a text: cast's, and every typed read of
   *  JSON or an array's. */
  fromText(expr, type) {
    if (isBooleanType(type)) return `(CASE lower(trim(CAST(${expr} AS VARCHAR), ${BLANK})) WHEN 'true' THEN TRUE WHEN 'false' THEN FALSE END)`;
    if (isTimeType(type)) {
      const moment = this._textMoment(expr);
      return String(type).toLowerCase() === 'date' ? `CAST(${moment} AS DATE)` : moment;
    }
    const ct = this.castType(type);
    if (!ct) return expr;
    const exact = ct === 'BIGINT' || String(type).toLowerCase() === 'numeric';
    const read = exact ? `TRY_CAST(TRY_CAST(${expr} AS ${EXACT}) AS ${ct})` : `TRY_CAST(${expr} AS DOUBLE)`;
    return `(CASE WHEN regexp_full_match(trim(CAST(${expr} AS VARCHAR)), '${exact ? NUMBER_TEXT : FLOAT_TEXT}', 'i') THEN ${read} END)`;
  }

  /** A text read as a moment, a TIMESTAMP, as BigQuery's SAFE_CAST reads it: only where it is written in
   *  GoogleSQL's canonical form (MOMENT_TEXT — missing otherwise, as there), spelled as DuckDB's cast reads
   *  the same moment (a T or t between the date and the time a space, a z the Z, an offset's one-digit hour
   *  two digits); with a zone (ZONED_TEXT), the instant it names, in UTC (the epoch of a TIMESTAMPTZ, read
   *  in no session time zone); without one, the time it says, as UTC. */
  _textMoment(expr) {
    const t = `trim(CAST(${expr} AS VARCHAR), ${BLANK})`;
    const spaced = `regexp_replace(${t}, '^([0-9]{4}-[0-9]{1,2}-[0-9]{1,2})[Tt]', '\\1 ')`;
    const zulu = `regexp_replace(${spaced}, '([0-9])z$', '\\1Z')`;
    const n = `regexp_replace(${zulu}, '(:[0-9]{1,2}([.][0-9]*)?)([+-])([0-9])(:[0-9]{2})?$', '\\1\\30\\4\\5')`;
    return `(CASE WHEN NOT regexp_full_match(${t}, '${MOMENT_TEXT}', 'i') THEN NULL WHEN regexp_full_match(${t}, '${ZONED_TEXT}', 'i') THEN make_timestamp(epoch_us(TRY_CAST(${n} AS TIMESTAMPTZ))) ELSE TRY_CAST(${n} AS TIMESTAMP) END)`;
  }

  substringExpr(expr, start, len) { return `substring(${expr}, ${Number(start)}${len != null ? `, ${Number(len)}` : ''})`; }

  unixDateExpr(expr) { return `date_diff('day', DATE '1970-01-01', CAST(${expr} AS DATE))`; }

  // EXACT distinct count: this is the local/test warehouse, where the numbers are checked exactly
  // (approx_count_distinct exists, but an HLL estimate would make a test's number a coin toss).
  approxCountDistinct(c) { return `count(distinct ${c})`; }

  recentSince(col, days) { return `${col} >= CAST(now() AS TIMESTAMP) - INTERVAL '${Math.floor(Number(days))} days'`; }
  sinceTimestampMs(col, ms) { return `${col} > epoch_ms(${Math.floor(Number(ms))})`; }
  // approx_top_k returns the values WITHOUT their counts, so the index groups each property instead

  // EXACT, MERGEABLE sketch: a sketch is the chr(1)-joined set of distinct values. init dedups;
  // merge_partial concatenates (a coarser sketch); merge and extract dedup-and-count. Same additive
  // semantics as HLL++, exact.
  hllInit(c) { return `string_agg(distinct CAST(${c} AS VARCHAR), chr(1))`; }
  hllMergePartial(c) { return `string_agg(${c}, chr(1))`; }
  hllMerge(c) { return `len(list_distinct(string_split(string_agg(${c}, chr(1)), chr(1))))`; }
  hllExtract(c) { return `len(list_distinct(string_split(${c}, chr(1))))`; }

  statAggExpr(fn, c, q) {
    switch (fn) {
      case 'stddev': return `stddev_samp(${c})`;
      case 'variance': return `var_samp(${c})`;
      case 'median': return `quantile_cont(${c}, 0.5)`;
      case 'percentile': return `quantile_cont(${c}, ${Number(q)})`;
      default: throw new Error(`statAggExpr: bad fn ${fn}`);
    }
  }

  // ── Pipeline lowering: each op becomes a CTE `p{i}` selecting from the prior ──
  renderPipeline(baseRelation, ops) {
    if (!ops.length) return `SELECT * FROM ${baseRelation}`;
    let prev = baseRelation;
    const ctes = [];
    ops.forEach((op, i) => {
      const name = `p${i}`;
      // A stage that renders itself (match_recognize) contributes its own self-contained SELECT.
      ctes.push(`${name} AS (\n  ${op.render ? op.render(prev, this.name) : this._step(prev, op)}\n)`);
      prev = name;
    });
    return `WITH ${ctes.join(',\n')}\nSELECT * FROM ${prev}`;
  }

  _step(prev, op) {
    switch (op.op) {
      case 'where':
        return `SELECT * FROM ${prev} WHERE ${op.preds.join(' AND ')}`;
      case 'extend':
        return `SELECT *, ${op.cols.map((c) => `(${c.expr}) AS ${this.quoteIdent(c.name)}`).join(', ')} FROM ${prev}`;
      case 'unnest': {
        const { join, element } = this.arrayUnnest('s', op.column, op.key, op.as, op.field, op.type, op.encoding);
        return `SELECT s.*, ${element} AS ${this.quoteIdent(op.as)} FROM ${prev} s ${join}`;
      }
      case 'join':
        return this.joinCte(prev, op);
      case 'aggregate': {
        const sel = [...op.groupBy.map((c) => this.quoteIdent(c)), ...op.aggs.map((a) => `${a.expr} AS ${this.quoteIdent(a.as)}`)];
        return `SELECT ${sel.join(', ')} FROM ${prev}${op.groupBy.length ? ` GROUP BY ${op.groupBy.map((c) => this.quoteIdent(c)).join(', ')}` : ''}`;
      }
      case 'unpivot': {
        // one branch per unpivoted column — the same rows a LATERAL VALUES gives, in plain SQL: exactly
        // `keep` + the two produced columns, a row for every folded value, NULL ones too
        const keep = op.keep.map((c) => this.quoteIdent(c));
        const branches = op.columns.map((c) => `SELECT ${keep.join(', ')}${keep.length ? ', ' : ''}${this.sqlLiteral(c)} AS ${this.quoteIdent(op.nameColumn)}, ${this.quoteIdent(c)} AS ${this.quoteIdent(op.valueColumn)} FROM ${prev}`);
        return branches.join('\n  UNION ALL\n  ');
      }
      case 'order_by':
        return `SELECT * FROM ${prev} ORDER BY ${op.keys.map((k) => this.orderKey(this.quoteIdent(k.key), k.direction, k.nulls)).join(', ')}`;
      case 'sample':
        // a row-level (Bernoulli) sample that works at any stage (TABLESAMPLE needs a table)
        return `SELECT * FROM ${prev} WHERE random() < ${Number(op.share)}`;
      case 'limit':
        return `SELECT * FROM ${prev} LIMIT ${Number(op.limit)}`;
      case 'project':
        return `SELECT ${op.cols.map((c) => this.quoteIdent(c)).join(', ')} FROM ${prev}`;
      default:
        throw new Error(`duckdb: unknown pipeline op '${op.op}'`);
    }
  }
}
