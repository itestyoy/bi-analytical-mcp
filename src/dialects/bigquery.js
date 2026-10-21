// BigQuery dialect: JSON/array primitives + pipeline lowering to native pipe
// syntax (FROM ... |> WHERE ... |> AGGREGATE ... |> UNPIVOT ...).
// https://docs.cloud.google.com/bigquery/docs/reference/standard-sql/pipe-syntax

import { Dialect, isNumericType, isTimeType } from './base.js';
import { isBooleanType } from '../catalog/column-types.js';

const CASTS = { int: 'INT64', integer: 'INT64', bigint: 'INT64', numeric: 'NUMERIC', float: 'FLOAT64', double: 'FLOAT64' };
// A GoogleSQL quoted string's escapes: the backslash is its escape character (a doubled quote is no
// escape there), and a quoted string holds no newline.
const ESCAPES = { '\\': '\\\\', "'": "\\'", '\n': '\\n', '\r': '\\r', '\t': '\\t' };
// The whitespace a text read as a flag or a moment is trimmed of: ONE set on both warehouses (BigQuery's
// TRIM() alone removes every Unicode whitespace character, DuckDB's trim() spaces only) — space, tab,
// newline, vertical tab, form feed, carriage return.
const BLANK_CHARS = ' \t\n\v\f\r';


export class BigQueryDialect extends Dialect {
  /** BigQuery quotes an identifier in backticks. */
  quoteIdent(name) {
    return `\`${this.ident(name)}\``;
  }

  get name() { return 'bigquery'; }

  /** A text as a GoogleSQL quoted string: a backslash, a quote, a newline, a carriage return and a tab
   *  escaped by a backslash, any other control character as \xHH — so the text is the value, whatever
   *  it holds. */
  quoteText(s) {
    return `'${s.replace(/[\\'\x00-\x1f]/g, (c) => ESCAPES[c] ?? `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`)}'`;
  }

  /** A pipeline is lowered to BigQuery's pipe syntax (FROM … |> …), which dbt's own SQL parser (dbt v2) does not read. */
  get writesPipeSyntax() { return true; }

  castType(type) { return CASTS[String(type || '').toLowerCase()]; }

  /** MATCH_RECOGNIZE says "the immediately next event" with a pattern that has no filler between steps. */
  get matchesAdjacentSteps() { return true; }

  /**
   * A window's ORDER BY. A rank or a neighbour (row_number, lag …) takes NULLS FIRST / LAST as a query's
   * ORDER BY does; an aggregate window (sum, count … OVER) takes none, so a placement other than
   * BigQuery's own (first in an ascending sort, last in a descending one) is a leading key that sorts
   * the NULLs — `(k IS NULL)`. A RANGE frame with an offset orders by its one key and takes no other;
   * a NULL key is a peer of other NULLs alone, so its place changes no row's frame unless a side of the
   * frame is unbounded — that one case is refused rather than computed with NULLs on the other end.
   */
  windowOrder(keys, { aggregate = false, frame = null } = {}) {
    if (!aggregate) return super.windowOrder(keys);
    const asked = (k) => (k.nulls === 'first' ? 'first' : 'last');
    const native = (k) => asked(k) === (k.direction === 'desc' ? 'last' : 'first');
    const plain = (k) => `${k.sql}${k.direction === 'desc' ? ' DESC' : ''}`;
    const offset = frame?.mode === 'range' && [frame.preceding, frame.following].some((v) => Number.isInteger(v) && v > 0);
    if (offset) {
      const unbounded = (frame.preceding ?? 'unbounded') === 'unbounded' || frame.following === 'unbounded';
      if (keys.some((k) => !native(k)) && unbounded) {
        throw new Error('a RANGE window frame with an offset and an unbounded side cannot put NULL order keys anywhere but BigQuery\'s own place (first in an ascending sort, last in a descending one) — say nulls: \'first\' on that key (desc: \'last\'), which every warehouse then writes alike; or filter the NULLs out first (a where with is_not_null); or bound both sides of the frame');
      }
      return keys.map(plain).join(', ');
    }
    return keys.map((k) => (native(k) ? plain(k) : `(${k.sql} IS NULL)${asked(k) === 'first' ? ' DESC' : ''}, ${plain(k)}`)).join(', ');
  }

  /** A text read as `type` — SAFE, so a row whose text holds no number is NULL for that row, as DuckDB's
   *  TRY_CAST answers, instead of failing the query: an integer through NUMERIC, the number the text holds
   *  rounded half away from zero ('9.99' → 10, '2.5' → 3 — SAFE_CAST('9.99' AS INT64) alone is NULL, as is
   *  '3.0'), a numeric or a float as itself; as it is for a type no number is (text). NUMERIC rather than
   *  BIGNUMERIC: it takes what DuckDB's DECIMAL(38,9) takes (an exponent, '1e3'), at the same precision
   *  and scale; what is no numeric literal here ('1_000', '0x1F') DuckDB's side refuses alike. A flag is
   *  its true / false in any case; a moment BigQuery's own reading of the text as a TIMESTAMP (UTC unless
   *  it names a zone) — its canonical form, which DuckDB's side reads alone (MOMENT_TEXT there) — a date
   *  that moment's DATE; a flag and a moment trimmed of the whitespace both warehouses trim (BLANK_CHARS).
   *  The one conversion of a text: cast's, and every typed read of JSON or an array's. */
  fromText(expr, type) {
    const blank = this.quoteText(BLANK_CHARS);
    if (isBooleanType(type)) return `(CASE LOWER(TRIM(${expr}, ${blank})) WHEN 'true' THEN TRUE WHEN 'false' THEN FALSE END)`;
    if (isTimeType(type)) {
      const moment = `SAFE_CAST(TRIM(${expr}, ${blank}) AS TIMESTAMP)`;
      return String(type).toLowerCase() === 'date' ? `DATE(${moment})` : moment;
    }
    const ct = this.castType(type);
    if (!ct) return expr;
    return ct === 'INT64' ? `SAFE_CAST(SAFE_CAST(${expr} AS NUMERIC) AS INT64)` : `SAFE_CAST(${expr} AS ${ct})`;
  }

  jsonExtract(column, key, type = 'string') {
    this.ident(key);
    return this.fromText(`JSON_VALUE(${column}, '$.${key}')`, type);
  }

  // (JSON_QUERY_ARRAY is NULL where the key is absent or holds no array: a missing array, length 0)
  jsonArrayLength(column, key) {
    this.ident(key);
    return `COALESCE(ARRAY_LENGTH(JSON_QUERY_ARRAY(${column}, '$.${key}')), 0)`;
  }

  // Element count of a native array (0 for empty). A REPEATED column is never NULL, but an array an
  // expression yields may be (a parsed JSON array of a NULL text): a missing array, length 0.
  arrayLength(column) { return `COALESCE(ARRAY_LENGTH(${column}), 0)`; }

  // A JSON array's elements are text (JSON_VALUE_ARRAY reads each so): the value looked for is its text too.
  jsonArrayContains(column, key, value) {
    this.ident(key);
    return `${this.sqlLiteral(value == null ? null : String(value))} IN UNNEST(JSON_VALUE_ARRAY(${column}, '$.${key}'))`;
  }

  jsonStructField(column, key, field, type = 'string') {
    this.ident(key); this.ident(field);
    return this.fromText(`JSON_VALUE(${column}, '$.${key}.${field}')`, type);
  }

  /** A key's value as its JSON text — an array or an object as JSON (JSON_VALUE takes only a scalar). */
  jsonExtractJson(column, key) {
    this.ident(key);
    return `JSON_QUERY(${column}, '$.${key}')`;
  }

  arrayUnnest(_prevAlias, column, key, alias, field, type = 'string', encoding = 'blob') {
    this.ident(alias);
    // The element is bound under `<alias>_e` and read as it is stored — a native array's item as its
    // type (a struct's `field` as that field's), a JSON array's scalar as STRING; `type` (a kept draft's)
    // converts it as a text is (fromText). The array column is written quoted, as every column is.
    const e = `${alias}_e`;
    const col = this.quoteIdent(column);
    // Native ARRAY/REPEATED column → unnest directly.
    if (key == null && encoding === 'native') {
      return { join: `CROSS JOIN UNNEST(${col}) AS ${e}`, element: this.fromText(field ? `${e}.${this.quoteIdent(field)}` : e, type) };
    }
    // Array-of-JSON elements: a key inside a json column (blob), or the flat STRING column
    // parsed as a JSON array (encoding 'json').
    const jarr = key != null ? (this.ident(key), `JSON_QUERY_ARRAY(${col}, '$.${key}')`) : `JSON_EXTRACT_ARRAY(${col}, '$')`;
    if (field) {
      this.ident(field);
      return { join: `CROSS JOIN UNNEST(${jarr}) AS ${e}`, element: this.fromText(`JSON_VALUE(${e}, '$.${field}')`, type) };
    }
    if (type === 'json') { // bind the whole struct element as a JSON column
      return { join: `CROSS JOIN UNNEST(${jarr}) AS ${e}`, element: e };
    }
    // scalar elements
    const sarr = key != null ? `JSON_VALUE_ARRAY(${col}, '$.${key}')` : `JSON_EXTRACT_STRING_ARRAY(${col}, '$')`;
    return { join: `CROSS JOIN UNNEST(${sarr}) AS ${e}`, element: this.fromText(e, type) };
  }

  /** STRING holding a JSON array → a native ARRAY<STRING> (so it can be unnested as native). */
  jsonParseArray(column) {
    return `JSON_EXTRACT_STRING_ARRAY(${column}, '$')`;
  }

  arrayElementAt(column, index) { return `${column}[SAFE_OFFSET(${Number(index) - 1})]`; } // 1-based → 0-based OFFSET
  arrayLast(column) { return `${column}[SAFE_OFFSET(ARRAY_LENGTH(${column}) - 1)]`; }

  /** Extract a scalar field from a JSON-valued COLUMN (e.g. an unnested struct element). */
  jsonColumnField(column, field, type = 'string') {
    this.ident(field);
    return this.fromText(`JSON_VALUE(${column}, '$.${field}')`, type);
  }

  // ── column-level complex primitives (a flattened payload column, no blob) ──
  jsonColumnArrayLength(column) {
    // JSON_QUERY_ARRAY reads a JSON-typed column and a STRING holding JSON alike, and yields NULL
    // when the value is not an array — so a row whose value is a scalar counts as absent (length 0)
    // instead of failing the query. (DuckDB needs an explicit guard for the same thing; see its dialect.)
    return `COALESCE(ARRAY_LENGTH(JSON_QUERY_ARRAY(${column}, '$')), 0)`;
  }

  jsonColumnArrayContains(column, value) {
    // JSON_EXTRACT_STRING_ARRAY yields ARRAY<STRING>, so the value looked for is its text too — a
    // numeric or boolean literal would otherwise be a type error in IN UNNEST.
    return `${this.sqlLiteral(value == null ? null : String(value))} IN UNNEST(JSON_EXTRACT_STRING_ARRAY(${column}, '$'))`;
  }

  // (the value as the caller wrote it in the type of the array's items — src/pipeline/compute.js)
  arrayContains(column, value) { return `${this.sqlLiteral(value)} IN UNNEST(${column})`; }

  // JSON_VALUE parses a STRING holding JSON exactly as it reads a JSON-typed column, so the
  // struct-in-a-string form is the same expression here (on DuckDB it is the same idea: a guarded JSON read).
  jsonColumnStructField(column, field, type = 'string') { return this.jsonColumnField(column, field, type); }

  // ── time / scalar / statistical ────────────────────────────────────────────
  // A SQL model takes the adapter's own option. A python model writes its table through BigFrames,
  // which leaves the option unapplied, so its expiry is set once the table is written — a post-hook,
  // which carries Jinja and so goes in the model's YAML (a python file may hold none).
  expiryConfig(days, language) {
    if (!days) return {};
    return language === 'python'
      ? { post_hook: [`alter table {{ this }} set options (expiration_timestamp = timestamp_add(current_timestamp(), interval ${Number(days)} day))`] }
      : { hours_to_expiration: Number(days) * 24 };
  }
  valueBucket(expr, buckets) { return `MOD(ABS(FARM_FINGERPRINT(CAST(${expr} AS STRING))), ${Number(buckets)})`; }

  // the span to the microsecond, in seconds, as DuckDB's epoch difference has it (SECOND would truncate)
  secondsBetween(from, to) { return `(TIMESTAMP_DIFF(${this.timeOperand(to)}, ${this.timeOperand(from)}, MICROSECOND) / 1000000)`; }
  timeSpineSelect(start, end) { return `select d as date_day\nfrom unnest(generate_date_array('${start}', '${end}', interval 1 day)) as d`; }

  // TIMESTAMP_DIFF counts the whole units elapsed, truncated toward zero (a DAY is 24 hours, not a
  // calendar boundary); both sides are read as TIMESTAMP, so a DATE column is its midnight, as on DuckDB
  dateDiff(unit, from, to) {
    const u = { day: 'DAY', hour: 'HOUR', minute: 'MINUTE', second: 'SECOND' }[unit];
    if (!u) throw new Error(`dateDiff: bad unit ${unit}`);
    return `TIMESTAMP_DIFF(${this.timeOperand(to)}, ${this.timeOperand(from)}, ${u})`;
  }

  // Whole 24-HOUR days between two moments (retention-day style), as DuckDB counts them: the FLOOR of
  // the span (to the microsecond) in 24h buckets — NOT calendar days, and a moment before `from` is day
  // -1, not 0 (an interval's DAY part truncates toward zero). Signed; the caller clamps/coalesces.
  fullDaysBetween(from, to) {
    return `CAST(FLOOR(TIMESTAMP_DIFF(${this.timeOperand(to)}, ${this.timeOperand(from)}, MICROSECOND) / 86400000000) AS INT64)`;
  }

  // A week is the ISO week, starting on Monday (BigQuery's WEEK starts on Sunday) — the week DuckDB
  // truncates to and MetricFlow's BigQuery renderer writes (`isoweek`). The moment is read as a
  // TIMESTAMP (timeOperand): TIMESTAMP_TRUNC has no DATE or DATETIME overload.
  dateTrunc(granularity, expr) {
    const g = { day: 'DAY', week: 'ISOWEEK', month: 'MONTH', quarter: 'QUARTER', year: 'YEAR' }[granularity];
    if (!g) throw new Error(`dateTrunc: bad granularity ${granularity}`);
    return `TIMESTAMP_TRUNC(${this.timeOperand(expr)}, ${g})`;
  }

  // A join key's column type is not declared, and GoogleSQL has no DATE overload for
  // TIMESTAMP_TRUNC (nor an implicit DATE→TIMESTAMP coercion), so a declared per-day key on a DATE
  // column was rejected outright. DATE() accepts DATE, DATETIME and TIMESTAMP alike, and every
  // grain a key may declare is a whole day or coarser, so the day is the right unit to compare at.
  grainExpr(granularity, expr) {
    const g = { day: 'DAY', week: 'ISOWEEK', month: 'MONTH', quarter: 'QUARTER', year: 'YEAR' }[granularity];
    if (!g) throw new Error(`grainExpr: bad granularity ${granularity}`);
    return `DATE_TRUNC(DATE(${expr}), ${g})`;
  }

  // ISO numbering, as DuckDB's and MetricFlow's: DAYOFWEEK counts Sunday 1 … Saturday 7, renumbered to
  // Monday 1 … Sunday 7; the week is ISOWEEK (BigQuery's WEEK starts on Sunday). The moment is read as a
  // TIMESTAMP (timeOperand), so a DATE has an hour too (0, as on DuckDB) and every part is UTC's; a time of
  // day (`type` time_of_day: a TIME, which no CAST makes a TIMESTAMP) is read as it is, for its hour.
  datePart(part, expr, type = null) {
    const m = type === 'time_of_day' ? expr : this.timeOperand(expr);
    if (part === 'dow') return `IF(EXTRACT(DAYOFWEEK FROM ${m}) = 1, 7, EXTRACT(DAYOFWEEK FROM ${m}) - 1)`;
    const p = { hour: 'HOUR', day: 'DAY', week: 'ISOWEEK', month: 'MONTH', quarter: 'QUARTER', year: 'YEAR', doy: 'DAYOFYEAR' }[part];
    if (!p) throw new Error(`datePart: bad part ${part}`);
    return `EXTRACT(${p} FROM ${m})`;
  }

  nowExpr() { return 'CURRENT_TIMESTAMP()'; }

  // DATE, DATETIME and TIMESTAMP do not compare with each other here (DuckDB promotes them): both
  // sides of a comparison of moments are read as TIMESTAMP — a date is its midnight, as DuckDB reads it
  timeOperand(expr) { return `CAST(${expr} AS TIMESTAMP)`; }

  roundExpr(expr, places = 0) { return `ROUND(${expr}, ${Number(places)})`; }

  // SAFE cast only: a bad value yields NULL instead of failing the whole query (no unsafe CAST). ONE RULE
  // ON BOTH WAREHOUSES: an integer is the number a value holds, rounded half away from zero — a number by
  // BigQuery's own conversion (FLOAT64 / NUMERIC → INT64 rounds so), a text through NUMERIC (fromText); a
  // flag is 1 or 0, through INT64 (a BOOL converts to no other number). `from` is the value's type where
  // the writer knows it; of none known ('unknown', null — a raw's), the value is read as its text, which
  // every scalar converts to (a BOOL to no number) — a flag's true / false is 1 / 0.
  castExpr(expr, type, from = null) {
    const ct = this.castType(type);
    if (!ct) return `SAFE_CAST(${expr} AS STRING)`;
    if (isNumericType(from)) return `SAFE_CAST(${expr} AS ${ct})`;
    if (isBooleanType(from)) return ct === 'INT64' ? `SAFE_CAST(${expr} AS INT64)` : `SAFE_CAST(SAFE_CAST(${expr} AS INT64) AS ${ct})`;
    if (from == null || from === 'unknown') {
      const text = `SAFE_CAST(${expr} AS STRING)`;
      return `(CASE ${text} WHEN 'true' THEN 1 WHEN 'false' THEN 0 ELSE ${this.fromText(text, type)} END)`;
    }
    return this.fromText(expr, type);
  }

  substringExpr(expr, start, len) { return `SUBSTR(${expr}, ${Number(start)}${len != null ? `, ${Number(len)}` : ''})`; }

  unixDateExpr(expr) { return `UNIX_DATE(CAST(${expr} AS DATE))`; }

  // HLL++ approximate distinct count (BigQuery's APPROX_COUNT_DISTINCT uses HLL++).
  approxCountDistinct(c) { return `APPROX_COUNT_DISTINCT(${c})`; }

  recentSince(col, days) { return `${col} >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${Math.floor(Number(days))} DAY)`; }
  sinceTimestampMs(col, ms) { return `${col} > TIMESTAMP_MILLIS(${Math.floor(Number(ms))})`; }
  // wrapped in a JSON STRING: APPROX_TOP_COUNT returns a nested ARRAY<STRUCT> that `dbt show --output
  // json` cannot serialize (the query runs, the show step errors); parseTopK reads it back
  approxTopK(expr, k) { return `TO_JSON_STRING(APPROX_TOP_COUNT(${expr}, ${Math.max(1, Math.floor(Number(k) || 50))}))`; }
  /** The cell approxTopK writes — TO_JSON_STRING of ARRAY<STRUCT<value, count>> — as [{ value, freq }];
   *  [] when it is not that (the indexer then counts the property exactly, and says so). */
  parseTopK(raw) {
    let arr = raw;
    if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch { return []; } }
    if (!Array.isArray(arr)) return [];
    return arr.filter((e) => e && typeof e === 'object' && e.value != null).map((e) => ({ value: e.value, freq: Number(e.count) || 0 }));
  }

  // Native HLL++ mergeable sketches — the additive distinct-count workflow.
  hllInit(c) { return `HLL_COUNT.INIT(${c})`; }
  hllMerge(c) { return `HLL_COUNT.MERGE(${c})`; }
  hllMergePartial(c) { return `HLL_COUNT.MERGE_PARTIAL(${c})`; }
  hllExtract(c) { return `HLL_COUNT.EXTRACT(${c})`; }

  // APPROX_QUANTILES is a sketch: the value comes back without ordering the whole column, which is
  // both why it is cheap on a large table and why it is not the exact quantile. Declared so the
  // stage can say so and an answer can be labelled honestly.
  get approximateStats() { return ['median', 'percentile']; }

  // MetricFlow computes time on BigQuery as DATETIME (its spine, DATETIME_TRUNC, its casts), and
  // BigQuery compares a TIMESTAMP with neither a DATETIME nor a DATE: a cumulative metric's join to the
  // spine failed on TIMESTAMP <= DATE and a conversion's window on TIMESTAMP > DATETIME. A TIMESTAMP
  // column is read as the DATETIME of its UTC instant — the same moment, the type MetricFlow compares.
  semanticTimeExpr(column, dataType) { return /^timestamp$/i.test(String(dataType || '').trim()) ? `CAST(${column} AS DATETIME)` : column; }

  statAggExpr(fn, c, q) {
    switch (fn) {
      case 'stddev': return `STDDEV(${c})`;
      case 'variance': return `VARIANCE(${c})`;
      case 'median': return `APPROX_QUANTILES(${c}, 2)[OFFSET(1)]`;
      case 'percentile': return `APPROX_QUANTILES(${c}, 100)[OFFSET(CAST(${Number(q)} * 100 AS INT64))]`;
      default: throw new Error(`statAggExpr: bad fn ${fn}`);
    }
  }

  // ── Pipeline lowering: native |> pipe operators ────────────────────────────
  renderPipeline(baseRelation, ops) {
    const lines = [`FROM ${baseRelation}`];
    // each join its own alias (j1, j2, …): the table names of one pipe stay in scope down it, and two
    // joins under one name are refused ("Duplicate table alias")
    let joins = 0;
    for (const op of ops) lines.push(this._step(op.op === 'join' ? { ...op, alias: `${op.alias}${++joins}`, base: `base${joins}` } : op));
    return lines.join('\n');
  }

  /**
   * An unpivot's folded columns as UNPIVOT reads them (`types`: each one's tracked type). UNPIVOT folds
   * only columns of ONE type, and INT64, NUMERIC and FLOAT64 are three, while a stage tracks every number
   * as one kind (stages.js unpivotType): numbers whose words do not say they are one type — all int
   * (INT64) or all float (FLOAT64) — are each read as a FLOAT64. Of the two types that could hold them,
   * NUMERIC holds an INT64 and a NUMERIC exactly (FLOAT64 rounds them past 2^53, past ~15 significant
   * digits), so it is the one where every folded column is one of those; but it holds no FLOAT64 past
   * ±1e29, no NaN or ±inf (its cast would fail the query) and no digit past 9 places, and no word says a
   * column is a NUMERIC rather than a FLOAT64 — 'numeric' is also an average, a division, a FLOAT64
   * column — while the words that do say a type say INT64 alone where no fold is needed. FLOAT64 holds a
   * value of every one of them: BigQuery's own supertype of a FLOAT64 and any number, and the DOUBLE
   * DuckDB's UNION ALL lowering folds such columns to. Moments are one kind too: a stage tracks a DATE, a
   * DATETIME and a TIMESTAMP alike ('time'), so each is read as the TIMESTAMP of its moment (timeOperand, a
   * date its midnight) — the type DuckDB's UNION ALL promotes them to.
   */
  _unpivotValues(columns, types = []) {
    const q = columns.map((c) => this.quoteIdent(c));
    if (columns.length < 2 || types.length !== columns.length) return q;
    if (types.every((t) => String(t).toLowerCase() === 'time')) return q.map((c) => `${this.timeOperand(c)} AS ${c}`);
    if (!types.every(isNumericType)) return q;
    // the one BigQuery type a word names (CASTS), but 'numeric': a number of a kind not said
    const named = new Set(types.map((t) => (String(t).toLowerCase() === 'numeric' ? null : this.castType(t))));
    if (named.size === 1 && !named.has(null)) return q;
    return q.map((c, i) => `${this.castExpr(c, 'float', types[i])} AS ${c}`);
  }

  _step(op) {
    switch (op.op) {
      case 'where':
        return `|> WHERE ${op.preds.join(' AND ')}`;
      case 'extend':
        return `|> EXTEND ${op.cols.map((c) => `(${c.expr}) AS ${this.quoteIdent(c.name)}`).join(', ')}`;
      case 'unnest': {
        const { join, element } = this.arrayUnnest(null, op.column, op.key, op.as, op.field, op.type, op.encoding);
        // bind the element, read as its declared type, to `as`; the bare element column goes
        return `|> ${join}\n|> EXTEND ${element} AS ${this.quoteIdent(op.as)}\n|> DROP ${op.as}_e`;
      }
      case 'join': {
        // The RIGHT side is a subquery that projects exactly what the stage promised: the join key
        // and `attrs` under their aliases — nothing else of the joined model reaches the pipe. Its
        // key expression is evaluated there, under the LEFT side's column name.
        const kind = op.kind === 'INNER' ? 'INNER ' : 'LEFT ';
        const attrs = op.attrs.map((a) => (a.as === a.column ? this.quoteIdent(a.column) : `${this.quoteIdent(a.column)} AS ${this.quoteIdent(a.as)}`));
        // Both sides come from the SAME builder, so a part's grain truncates both — never just the
        // projected one. `USING` can only equate bare columns, so it is used only when neither side
        // needs an expression; a truncated part joins `ON`, like a validity window does.
        const base = op.base || 'base';
        const keys = this.joinKeyParts(op, (c) => `${base}.${c}`, (c) => c);
        if (!op.between && !this.joinKeyIsExpression(op)) {
          const proj = [...keys.map((k) => (k.right === k.name ? k.name : `${k.right} AS ${k.name}`)), ...attrs];
          return `|> ${kind}JOIN (SELECT ${proj.join(', ')} FROM ${op.relation}) AS ${op.alias} USING (${keys.map((k) => k.name).join(', ')})`;
        }
        // Joining `ON`: the pipe input is named (`|> AS base`) so each condition can qualify its
        // side, the subquery carries the key (and the window, when there is one) under private
        // names, and those are dropped once the match is made — the output is again base's columns
        // plus `attrs`. This is the only form that can compare an EXPRESSION, which is what a key
        // part with a declared grain is, and the only one that can carry a validity window.
        const priv = (n) => `_j_${n}`;
        const win = op.between
          ? [`${this.quoteIdent(op.between.from)} AS ${priv('from')}`, `${this.quoteIdent(op.between.to)} AS ${priv('to')}`]
          : [];
        const proj = [...keys.map((k, i) => `${k.right} AS ${priv(`key${i}`)}`), ...win, ...attrs];
        const on = [
          ...keys.map((k, i) => `${k.left} = ${op.alias}.${priv(`key${i}`)}`),
          ...(op.between ? [this.validityWindow(`${base}.${this.quoteIdent(op.between.column)}`, `${op.alias}.${priv('from')}`, `${op.alias}.${priv('to')}`)] : []),
        ];
        const drop = [...keys.map((_, i) => priv(`key${i}`)), ...(op.between ? [priv('from'), priv('to')] : [])];
        return `|> AS ${base}
|> ${kind}JOIN (SELECT ${proj.join(', ')} FROM ${op.relation}) AS ${op.alias} ON ${on.join(' AND ')}
|> DROP ${drop.join(', ')}`;
      }
      case 'aggregate':
        return `|> AGGREGATE ${op.aggs.map((a) => `${a.expr} AS ${this.quoteIdent(a.as)}`).join(', ')}${op.groupBy.length ? ` GROUP BY ${op.groupBy.map((c) => this.quoteIdent(c)).join(', ')}` : ''}`;
      case 'unpivot':
        // exactly `keep` + the two produced columns, and a row for every folded value — a NULL one too
        // (UNPIVOT drops them unless told otherwise), as the UNION ALL of the CTE lowering returns — in
        // the declared order, the name column before the value (UNPIVOT puts the value first); the folded
        // columns of one type (_unpivotValues)
        return `|> SELECT ${[...op.keep.map((c) => this.quoteIdent(c)), ...this._unpivotValues(op.columns, op.types)].join(', ')}\n|> UNPIVOT INCLUDE NULLS (${this.quoteIdent(op.valueColumn)} FOR ${this.quoteIdent(op.nameColumn)} IN (${op.columns.map((c) => this.quoteIdent(c)).join(', ')}))\n|> SELECT ${[...op.keep, op.nameColumn, op.valueColumn].map((c) => this.quoteIdent(c)).join(', ')}`;
      case 'order_by':
        return `|> ORDER BY ${op.keys.map((k) => this.orderKey(this.quoteIdent(k.key), k.direction, k.nulls)).join(', ')}`;
      case 'sample':
        // a row-level (Bernoulli) sample that works at any step, as DuckDB's: TABLESAMPLE takes a base
        // table only — not a view, nor the rows of a step before it
        return `|> WHERE RAND() < ${Number(op.share)}`;
      case 'limit':
        return `|> LIMIT ${Number(op.limit)}`;
      case 'project':
        return `|> SELECT ${op.cols.map((c) => this.quoteIdent(c)).join(', ')}`;
      case 'match_recognize':
        // BigQuery pipe-native funnel: `|> MATCH_RECOGNIZE (...)` + derived EXTEND/WHERE/SELECT
        // (pre-rendered in match-recognize.js, which owns the funnel semantics).
        return op.bqPipe;
      default:
        throw new Error(`bigquery: unknown pipeline op '${op.op}'`);
    }
  }
}
