// BigQuery dialect: JSON/array primitives + pipeline lowering to native pipe
// syntax (FROM ... |> WHERE ... |> AGGREGATE ... |> PIVOT ...).
// https://docs.cloud.google.com/bigquery/docs/reference/standard-sql/pipe-syntax

import { Dialect } from './base.js';

const CASTS = { int: 'INT64', integer: 'INT64', bigint: 'INT64', numeric: 'NUMERIC', float: 'FLOAT64', double: 'FLOAT64' };

export class BigQueryDialect extends Dialect {
  get name() { return 'bigquery'; }

  castType(type) { return CASTS[String(type || '').toLowerCase()]; }

  jsonExtract(column, key, type = 'string') {
    this.ident(key);
    const base = `JSON_VALUE(${column}, '$.${key}')`;
    const ct = this.castType(type);
    return ct ? `CAST(${base} AS ${ct})` : base;
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
    const base = `JSON_VALUE(${column}, '$.${key}.${field}')`;
    const ct = this.castType(type);
    return ct ? `CAST(${base} AS ${ct})` : base;
  }

  arrayUnnest(_prevAlias, column, key, alias, field, type = 'string', encoding = 'blob') {
    this.ident(alias);
    // Native ARRAY/REPEATED column → unnest directly.
    if (key == null && encoding === 'native') {
      const ct = this.castType(type);
      return { join: `CROSS JOIN UNNEST(${column}) AS ${alias}`, element: ct ? `CAST(${alias} AS ${ct})` : alias };
    }
    // Array-of-JSON elements: a key inside a json column (blob), or the flat STRING column
    // parsed as a JSON array (encoding 'json').
    const jarr = key != null ? (this.ident(key), `JSON_QUERY_ARRAY(${column}, '$.${key}')`) : `JSON_EXTRACT_ARRAY(${column}, '$')`;
    if (field) {
      this.ident(field);
      const e = `${alias}_e`;
      const base = `JSON_VALUE(${e}, '$.${field}')`;
      const ct = this.castType(type);
      return { join: `CROSS JOIN UNNEST(${jarr}) AS ${e}`, element: ct ? `CAST(${base} AS ${ct})` : base };
    }
    if (type === 'json') { // bind the whole struct element as a JSON column
      return { join: `CROSS JOIN UNNEST(${jarr}) AS ${alias}`, element: alias };
    }
    // scalar elements
    const sarr = key != null ? `JSON_VALUE_ARRAY(${column}, '$.${key}')` : `JSON_EXTRACT_STRING_ARRAY(${column}, '$')`;
    const ct = this.castType(type);
    return { join: `CROSS JOIN UNNEST(${sarr}) AS ${alias}`, element: ct ? `CAST(${alias} AS ${ct})` : alias };
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
    const base = `JSON_VALUE(${column}, '$.${field}')`;
    const ct = this.castType(type);
    return ct ? `CAST(${base} AS ${ct})` : base;
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
  valueBucket(expr, buckets) { return `MOD(ABS(FARM_FINGERPRINT(CAST(${expr} AS STRING))), ${Number(buckets)})`; }

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

  roundExpr(expr, places = 0) { return `ROUND(${expr}, ${Number(places)})`; }

  // SAFE cast only: a bad value yields NULL instead of failing the whole query (no unsafe CAST).
  castExpr(expr, type) { return `SAFE_CAST(${expr} AS ${this.castType(type) || 'STRING'})`; }

  substringExpr(expr, start, len) { return `SUBSTR(${expr}, ${Number(start)}${len != null ? `, ${Number(len)}` : ''})`; }

  unixDateExpr(expr) { return `UNIX_DATE(CAST(${expr} AS DATE))`; }

  // HLL++ approximate distinct count (BigQuery's APPROX_COUNT_DISTINCT uses HLL++).
  approxCountDistinct(c) { return `APPROX_COUNT_DISTINCT(${c})`; }

  // Native HLL++ mergeable sketches — the additive distinct-count workflow.
  hllInit(c) { return `HLL_COUNT.INIT(${c})`; }
  hllMerge(c) { return `HLL_COUNT.MERGE(${c})`; }
  hllMergePartial(c) { return `HLL_COUNT.MERGE_PARTIAL(${c})`; }
  hllExtract(c) { return `HLL_COUNT.EXTRACT(${c})`; }

  // APPROX_QUANTILES is a sketch: the value comes back without ordering the whole column, which is
  // both why it is cheap on a large table and why it is not the exact quantile. Declared so the
  // stage can say so and an answer can be labelled honestly.
  get approximateStats() { return ['median', 'percentile']; }

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
        return `|> EXTEND ${op.cols.map((c) => `(${c.expr}) AS ${this.ident(c.name)}`).join(', ')}`;
      case 'unnest': {
        const { join, element } = this.arrayUnnest(null, op.column, op.key, op.as, op.field, op.type, op.encoding);
        // bind the element to `as` (already so for the scalar form)
        return op.field ? `|> ${join}\n|> EXTEND ${element} AS ${this.ident(op.as)}` : `|> ${join}`;
      }
      case 'join': {
        // The RIGHT side is a subquery that projects exactly what the stage promised: the join key
        // and `attrs` under their aliases — nothing else of the joined model reaches the pipe. Its
        // key expression is evaluated there, under the LEFT side's column name.
        const kind = op.kind === 'INNER' ? 'INNER ' : 'LEFT ';
        const attrs = op.attrs.map((a) => (a.as === a.column ? this.ident(a.column) : `${this.ident(a.column)} AS ${this.ident(a.as)}`));
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
          ? [`${this.ident(op.between.from)} AS ${priv('from')}`, `${this.ident(op.between.to)} AS ${priv('to')}`]
          : [];
        const proj = [...keys.map((k, i) => `${k.right} AS ${priv(`key${i}`)}`), ...win, ...attrs];
        const on = [
          ...keys.map((k, i) => `${k.left} = ${op.alias}.${priv(`key${i}`)}`),
          ...(op.between ? [this.validityWindow(`base.${this.ident(op.between.value)}`, `${op.alias}.${priv('from')}`, `${op.alias}.${priv('to')}`)] : []),
        ];
        const drop = [...keys.map((_, i) => priv(`key${i}`)), ...(op.between ? [priv('from'), priv('to')] : [])];
        return `|> AS base
|> ${kind}JOIN (SELECT ${proj.join(', ')} FROM ${op.relation}) AS ${op.alias} ON ${on.join(' AND ')}
|> DROP ${drop.join(', ')}`;
      }
      case 'aggregate':
        return `|> AGGREGATE ${op.aggs.map((a) => `${a.expr} AS ${this.ident(a.as)}`).join(', ')}${op.groupBy.length ? ` GROUP BY ${op.groupBy.map((c) => this.ident(c)).join(', ')}` : ''}`;
      case 'pivot':
        return `|> AGGREGATE ${op.fn}(${this.ident(op.valueCol)}) AS v GROUP BY ${[...op.groupBy, op.on].map((c) => this.ident(c)).join(', ')}\n|> PIVOT(${op.fn}(v) FOR ${this.ident(op.on)} IN (${op.values.map((v) => this.sqlLiteral(v)).join(', ')}))`;
      case 'unpivot':
        return `|> UNPIVOT(${this.ident(op.valueAs)} FOR ${this.ident(op.nameAs)} IN (${op.columns.map((c) => this.ident(c)).join(', ')}))`;
      case 'order_by':
        return `|> ORDER BY ${op.keys.map((k) => `${this.ident(k.key)}${k.dir === 'desc' ? ' DESC' : ''}`).join(', ')}`;
      case 'sample':
        return `|> TABLESAMPLE SYSTEM (${Number(op.percent)} PERCENT)`;
      case 'limit':
        return `|> LIMIT ${Number(op.n)}`;
      case 'project':
        return `|> SELECT ${op.cols.map((c) => this.ident(c)).join(', ')}`;
      case 'match_recognize':
        // BigQuery pipe-native funnel: `|> MATCH_RECOGNIZE (...)` + derived EXTEND/WHERE/SELECT
        // (pre-rendered in match-recognize.js, which owns the funnel semantics).
        return op.bqPipe;
      default:
        throw new Error(`bigquery: unknown pipeline op '${op.op}'`);
    }
  }
}
