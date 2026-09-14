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
    // SAFE.PARSE_JSON turns text that is not JSON into NULL instead of failing the whole scan; a
    // JSON-typed column passes through it unchanged. NULL then counts as absent, like an empty one.
    return `ARRAY_LENGTH(JSON_QUERY_ARRAY(SAFE.PARSE_JSON(${column}), '$'))`;
  }

  jsonColumnArrayContains(column, value) {
    // JSON_EXTRACT_STRING_ARRAY yields ARRAY<STRING>, so the membership literal is compared as a
    // string too — a numeric or boolean `value` would otherwise be a type error in IN UNNEST.
    return `CAST(${this.sqlLiteral(value)} AS STRING) IN UNNEST(JSON_EXTRACT_STRING_ARRAY(${column}, '$'))`;
  }

  arrayContains(column, value) { return `${this.sqlLiteral(value)} IN UNNEST(${column})`; }

  jsonColumnStructField(column, field, type = 'string') {
    this.ident(field);
    const base = `JSON_VALUE(${column}, '$.${field}')`;
    const ct = this.castType(type);
    return ct ? `CAST(${base} AS ${ct})` : base;
  }

  // ── time / scalar / statistical ────────────────────────────────────────────
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

  /** CTE-form rendering of one op (fallback used only when a pipeline must lower to a
   *  chained CTE). match_recognize stays pipe-form on BigQuery (see _step), so this is
   *  rarely hit here. Standard SQL — valid on BigQuery. */
  stepCte(prev, op) {
    switch (op.op) {
      case 'where':
        return `SELECT * FROM ${prev} WHERE ${op.preds.join(' AND ')}`;
      case 'extend':
        return `SELECT *, ${op.cols.map((c) => `(${c.expr}) AS ${this.ident(c.name)}`).join(', ')} FROM ${prev}`;
      case 'unnest': {
        const { join, element } = this.arrayUnnest('s', op.column, op.key, op.as, op.field, op.type, op.encoding);
        return `SELECT s.*, ${element} AS ${this.ident(op.as)} FROM ${prev} s ${join}`;
      }
      case 'join': {
        // `onKeys` = a relationship declared in the schema: each side brings its OWN expression
        // for the same logical key (different column names, a time column truncated to the
        // declared grain), compared part by part. `on` = the plain shared-name form.
        const eq = op.onKeys
          ? op.onKeys.left.map((lp, i) => `${this.keyPartExpr(lp, (c) => `base.${c}`)} = ${this.keyPartExpr(op.onKeys.right[i], (c) => `j.${c}`)}`).join(' AND ')
          : op.on.map((c) => `j.${this.ident(c)} = base.${this.ident(c)}`).join(' AND ');
        const btw = op.between ? ` AND base.${this.ident(op.between.value)} BETWEEN j.${this.ident(op.between.from)} AND j.${this.ident(op.between.to)}` : '';
        const attrs = op.attrs.map((a) => `j.${this.ident(a.column)} AS ${this.ident(a.as)}`);
        return `SELECT base.*${attrs.length ? `, ${attrs.join(', ')}` : ''} FROM ${prev} base ${op.kind || 'LEFT'} JOIN ${op.relation} j ON ${eq}${btw}`;
      }
      case 'aggregate': {
        const sel = [...op.groupBy.map((c) => this.ident(c)), ...op.aggs.map((a) => `${a.expr} AS ${this.ident(a.as)}`)];
        return `SELECT ${sel.join(', ')} FROM ${prev}${op.groupBy.length ? ` GROUP BY ${op.groupBy.map((c) => this.ident(c)).join(', ')}` : ''}`;
      }
      case 'pivot': {
        const cols = op.values.map((v) => { if (!/^[A-Za-z0-9_]+$/.test(String(v))) throw new Error(`unsafe pivot value: ${v}`); return `${op.fn}(CASE WHEN ${this.ident(op.on)} = ${this.sqlLiteral(v)} THEN ${this.ident(op.valueCol)} END) AS ${v}`; });
        return `SELECT ${op.groupBy.map((c) => this.ident(c)).join(', ')}${op.groupBy.length ? ', ' : ''}${cols.join(', ')} FROM ${prev}${op.groupBy.length ? ` GROUP BY ${op.groupBy.map((c) => this.ident(c)).join(', ')}` : ''}`;
      }
      case 'order_by':
        return `SELECT * FROM ${prev} ORDER BY ${op.keys.map((k) => `${this.ident(k.key)}${k.dir === 'desc' ? ' DESC' : ''}`).join(', ')}`;
      case 'limit':
        return `SELECT * FROM ${prev} LIMIT ${Number(op.n)}`;
      case 'project':
        return `SELECT ${op.cols.map((c) => this.ident(c)).join(', ')} FROM ${prev}`;
      case 'sample':
        return `SELECT * FROM ${prev} WHERE RAND() < ${Number(op.percent) / 100}`;
      default:
        throw new Error(`bigquery: op '${op.op}' is not supported as a CTE step`);
    }
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
        // and `attrs` under their aliases — nothing else of the joined model reaches the pipe. A
        // declared relationship (`onKeys`) evaluates its right-hand key expression there under the
        // LEFT side's column name, so both forms join with `USING` and the key arrives once.
        const kind = op.kind === 'INNER' ? 'INNER ' : 'LEFT ';
        const attrs = op.attrs.map((a) => (a.as === a.column ? this.ident(a.column) : `${this.ident(a.column)} AS ${this.ident(a.as)}`));
        const keys = op.onKeys
          ? op.onKeys.left.map((lp, i) => ({ name: this.ident(lp.column), expr: this.keyPartExpr(op.onKeys.right[i]) }))
          : op.on.map((c) => ({ name: this.ident(c), expr: this.ident(c) }));
        if (!op.between) {
          const proj = [...keys.map((k) => (k.expr === k.name ? k.name : `${k.expr} AS ${k.name}`)), ...attrs];
          return `|> ${kind}JOIN (SELECT ${proj.join(', ')} FROM ${op.relation}) AS ${op.alias} USING (${keys.map((k) => k.name).join(', ')})`;
        }
        // A validity window is a predicate `USING` cannot say, so this form joins `ON`: the pipe
        // input is named (`|> AS base`) so the condition can qualify its side, the subquery carries
        // the key and the window under private names, and those are dropped once the match is made
        // — the output is again base's columns plus `attrs`.
        const priv = (n) => `_j_${n}`;
        const proj = [
          ...keys.map((k, i) => `${k.expr} AS ${priv(`key${i}`)}`),
          `${this.ident(op.between.from)} AS ${priv('from')}`, `${this.ident(op.between.to)} AS ${priv('to')}`,
          ...attrs,
        ];
        const on = [
          ...keys.map((k, i) => `base.${k.name} = ${op.alias}.${priv(`key${i}`)}`),
          `base.${this.ident(op.between.value)} BETWEEN ${op.alias}.${priv('from')} AND ${op.alias}.${priv('to')}`,
        ];
        return `|> AS base
|> ${kind}JOIN (SELECT ${proj.join(', ')} FROM ${op.relation}) AS ${op.alias} ON ${on.join(' AND ')}
|> DROP ${[...keys.map((_, i) => priv(`key${i}`)), priv('from'), priv('to')].join(', ')}`;
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
