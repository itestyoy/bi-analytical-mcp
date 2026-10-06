// BigQuery dialect: JSON/array primitives + pipeline lowering to native pipe
// syntax (FROM ... |> WHERE ... |> AGGREGATE ... |> PIVOT ...).
// https://docs.cloud.google.com/bigquery/docs/reference/standard-sql/pipe-syntax

import { Dialect } from './base.js';

const CASTS = { int: 'INT64', integer: 'INT64', bigint: 'INT64', numeric: 'NUMERIC', float: 'FLOAT64', double: 'FLOAT64' };

const BIGQUERY_RESERVED = new Set(('ALL AND ANY ARRAY AS ASC ASSERT_ROWS_MODIFIED AT BETWEEN BY CASE CAST COLLATE CONTAINS CREATE CROSS CUBE '
  + 'CURRENT DEFAULT DEFINE DESC DISTINCT ELSE END ENUM ESCAPE EXCEPT EXCLUDE EXISTS EXTRACT FALSE FETCH FOLLOWING FOR FROM FULL GROUP '
  + 'GROUPING GROUPS HASH HAVING IF IGNORE IN INNER INTERSECT INTERVAL INTO IS JOIN LATERAL LEFT LIKE LIMIT LOOKUP MERGE NATURAL NEW NO '
  + 'NOT NULL NULLS OF ON OR ORDER OUTER OVER PARTITION PRECEDING PROTO QUALIFY RANGE RECURSIVE RESPECT RIGHT ROLLUP ROWS SELECT SET '
  + 'SOME STRUCT TABLESAMPLE THEN TO TREAT TRUE UNBOUNDED UNION UNNEST USING WHEN WHERE WINDOW WITH WITHIN').split(' '));

export class BigQueryDialect extends Dialect {
  /** BigQuery quotes an identifier in backticks. */
  quoteIdent(name) {
    return `\`${this.ident(name)}\``;
  }

  get name() { return 'bigquery'; }

  /** BigQuery's reserved keywords (GoogleSQL lexical structure): a column named with one must be quoted. */
  get reservedWords() { return BIGQUERY_RESERVED; }

  /** A pipeline is lowered to BigQuery's pipe syntax (FROM … |> …), which dbt's own SQL parser (dbt v2) does not read. */
  get writesPipeSyntax() { return true; }

  castType(type) { return CASTS[String(type || '').toLowerCase()]; }

  /** A value read out of JSON (or an array) as `type`: SAFE_CAST, so a row whose value does not
   *  convert is NULL for that row — as DuckDB's TRY_CAST answers — instead of failing the query. */
  _typed(expr, type) {
    const ct = this.castType(type);
    return ct ? `SAFE_CAST(${expr} AS ${ct})` : expr;
  }

  jsonExtract(column, key, type = 'string') {
    this.ident(key);
    return this._typed(`JSON_VALUE(${column}, '$.${key}')`, type);
  }

  jsonArrayLength(column, key) {
    this.ident(key);
    return `ARRAY_LENGTH(JSON_QUERY_ARRAY(${column}, '$.${key}'))`;
  }

  // Element count of a native REPEATED column (0 for empty; a REPEATED column is never NULL).
  arrayLength(column) { return `ARRAY_LENGTH(${column})`; }

  jsonArrayContains(column, key, value) {
    this.ident(key);
    return `${this.sqlLiteral(value)} IN UNNEST(JSON_VALUE_ARRAY(${column}, '$.${key}'))`;
  }

  jsonStructField(column, key, field, type = 'string') {
    this.ident(key); this.ident(field);
    return this._typed(`JSON_VALUE(${column}, '$.${key}.${field}')`, type);
  }

  arrayUnnest(_prevAlias, column, key, alias, field, type = 'string', encoding = 'blob') {
    this.ident(alias);
    // The element is bound under `<alias>_e` and read through its declared type — a JSON array's
    // scalars come out as STRING, and `type` is what the stage promised the columns after it.
    const e = `${alias}_e`;
    // Native ARRAY/REPEATED column → unnest directly.
    if (key == null && encoding === 'native') {
      return { join: `CROSS JOIN UNNEST(${column}) AS ${e}`, element: this._typed(e, type) };
    }
    // Array-of-JSON elements: a key inside a json column (blob), or the flat STRING column
    // parsed as a JSON array (encoding 'json').
    const jarr = key != null ? (this.ident(key), `JSON_QUERY_ARRAY(${column}, '$.${key}')`) : `JSON_EXTRACT_ARRAY(${column}, '$')`;
    if (field) {
      this.ident(field);
      return { join: `CROSS JOIN UNNEST(${jarr}) AS ${e}`, element: this._typed(`JSON_VALUE(${e}, '$.${field}')`, type) };
    }
    if (type === 'json') { // bind the whole struct element as a JSON column
      return { join: `CROSS JOIN UNNEST(${jarr}) AS ${e}`, element: e };
    }
    // scalar elements
    const sarr = key != null ? `JSON_VALUE_ARRAY(${column}, '$.${key}')` : `JSON_EXTRACT_STRING_ARRAY(${column}, '$')`;
    return { join: `CROSS JOIN UNNEST(${sarr}) AS ${e}`, element: this._typed(e, type) };
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
    return this._typed(`JSON_VALUE(${column}, '$.${field}')`, type);
  }

  // ── column-level complex primitives (a flattened payload column, no blob) ──
  jsonColumnArrayLength(column) {
    // JSON_QUERY_ARRAY reads a JSON-typed column and a STRING holding JSON alike, and yields NULL
    // when the value is not an array — so a row whose value is a scalar counts as absent instead of
    // failing the query. (DuckDB needs an explicit guard for the same thing; see its dialect.)
    return `ARRAY_LENGTH(JSON_QUERY_ARRAY(${column}, '$'))`;
  }

  jsonColumnArrayContains(column, value) {
    // JSON_EXTRACT_STRING_ARRAY yields ARRAY<STRING>, so the membership literal is compared as a
    // string too — a numeric or boolean `value` would otherwise be a type error in IN UNNEST.
    return `CAST(${this.sqlLiteral(value)} AS STRING) IN UNNEST(JSON_EXTRACT_STRING_ARRAY(${column}, '$'))`;
  }

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

  secondsBetween(from, to) { return `TIMESTAMP_DIFF(${to}, ${from}, SECOND)`; }
  timeSpineSelect(start, end) { return `select d as date_day\nfrom unnest(generate_date_array('${start}', '${end}', interval 1 day)) as d`; }
  // block sampling on the table reference, then the projection over the sample
  sampleQuery(ref, percent, project) { return project(`${ref} TABLESAMPLE SYSTEM (${Number(percent)} PERCENT)`); }

  dateDiff(unit, from, to) {
    const u = { day: 'DAY', hour: 'HOUR', minute: 'MINUTE', second: 'SECOND' }[unit];
    if (!u) throw new Error(`dateDiff: bad unit ${unit}`);
    return `TIMESTAMP_DIFF(${to}, ${from}, ${u})`;
  }

  // Whole 24-HOUR days between two timestamps (retention-day style) — the DAY component of the
  // datetime interval equals div(total_hours, 24), i.e. genuine 24h buckets with NO month
  // normalization and NOT calendar-day boundaries. Signed (negative before `from`); the caller
  // clamps/coalesces.
  fullDaysBetween(from, to) {
    return `EXTRACT(DAY FROM (CAST(${to} AS DATETIME) - CAST(${from} AS DATETIME)))`;
  }

  dateTrunc(granularity, expr) {
    const g = { day: 'DAY', week: 'WEEK', month: 'MONTH', quarter: 'QUARTER', year: 'YEAR' }[granularity];
    if (!g) throw new Error(`dateTrunc: bad granularity ${granularity}`);
    return `TIMESTAMP_TRUNC(${expr}, ${g})`;
  }

  // A join key's column type is not declared, and GoogleSQL has no DATE overload for
  // TIMESTAMP_TRUNC (nor an implicit DATE→TIMESTAMP coercion), so a declared per-day key on a DATE
  // column was rejected outright. DATE() accepts DATE, DATETIME and TIMESTAMP alike, and every
  // grain a key may declare is a whole day or coarser, so the day is the right unit to compare at.
  grainExpr(granularity, expr) {
    const g = { day: 'DAY', week: 'WEEK', month: 'MONTH', quarter: 'QUARTER', year: 'YEAR' }[granularity];
    if (!g) throw new Error(`grainExpr: bad granularity ${granularity}`);
    return `DATE_TRUNC(DATE(${expr}), ${g})`;
  }

  datePart(part, expr) {
    const p = { dow: 'DAYOFWEEK', hour: 'HOUR', day: 'DAY', week: 'WEEK', month: 'MONTH', quarter: 'QUARTER', year: 'YEAR', doy: 'DAYOFYEAR' }[part];
    if (!p) throw new Error(`datePart: bad part ${part}`);
    return `EXTRACT(${p} FROM ${expr})`;
  }

  nowExpr() { return 'CURRENT_TIMESTAMP()'; }

  // DATE, DATETIME and TIMESTAMP do not compare with each other here (DuckDB promotes them): both
  // sides of a comparison of moments are read as TIMESTAMP — a date is its midnight, as DuckDB reads it
  timeOperand(expr) { return `CAST(${expr} AS TIMESTAMP)`; }

  roundExpr(expr, places = 0) { return `ROUND(${expr}, ${Number(places)})`; }

  // SAFE cast only: a bad value yields NULL instead of failing the whole query (no unsafe CAST).
  castExpr(expr, type) { return `SAFE_CAST(${expr} AS ${this.castType(type) || 'STRING'})`; }

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
    for (const op of ops) lines.push(this._step(op));
    return lines.join('\n');
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
        const keys = this.joinKeyParts(op, (c) => `base.${c}`, (c) => c);
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
          ...(op.between ? [this.validityWindow(`base.${this.quoteIdent(op.between.value)}`, `${op.alias}.${priv('from')}`, `${op.alias}.${priv('to')}`)] : []),
        ];
        const drop = [...keys.map((_, i) => priv(`key${i}`)), ...(op.between ? [priv('from'), priv('to')] : [])];
        return `|> AS base
|> ${kind}JOIN (SELECT ${proj.join(', ')} FROM ${op.relation}) AS ${op.alias} ON ${on.join(' AND ')}
|> DROP ${drop.join(', ')}`;
      }
      case 'aggregate':
        return `|> AGGREGATE ${op.aggs.map((a) => `${a.expr} AS ${this.quoteIdent(a.as)}`).join(', ')}${op.groupBy.length ? ` GROUP BY ${op.groupBy.map((c) => this.quoteIdent(c)).join(', ')}` : ''}`;
      case 'pivot':
        return `|> AGGREGATE ${op.fn}(${this.quoteIdent(op.valueCol)}) AS v GROUP BY ${[...op.groupBy, op.on].map((c) => this.quoteIdent(c)).join(', ')}\n|> PIVOT(${op.fn}(v) FOR ${this.quoteIdent(op.on)} IN (${op.values.map((v) => this.sqlLiteral(v)).join(', ')}))`;
      case 'unpivot':
        return `|> UNPIVOT(${this.quoteIdent(op.valueAs)} FOR ${this.quoteIdent(op.nameAs)} IN (${op.columns.map((c) => this.quoteIdent(c)).join(', ')}))`;
      case 'order_by':
        return `|> ORDER BY ${op.keys.map((k) => `${this.quoteIdent(k.key)}${k.dir === 'desc' ? ' DESC' : ''}`).join(', ')}`;
      case 'sample':
        return `|> TABLESAMPLE SYSTEM (${Number(op.percent)} PERCENT)`;
      case 'limit':
        return `|> LIMIT ${Number(op.n)}`;
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
