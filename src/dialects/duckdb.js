// DuckDB dialect: JSON/list primitives + pipeline lowering to a chained CTE. The warehouse for
// local work and the tests (a database in a file — one process at a time, see src/dbt/process.js);
// production runs on BigQuery. Where DuckDB and BigQuery could answer the same question differently
// (a value that does not parse, a malformed JSON row), this dialect answers as BigQuery does: NULL for
// that row, a result for the rest — never a failed statement.

import { Dialect } from './base.js';

// Numbers come back as DOUBLE, not DECIMAL: DuckDB's bare DECIMAL is (18,3) and would round a price.
const CASTS = { int: 'INTEGER', integer: 'INTEGER', bigint: 'BIGINT', numeric: 'DOUBLE', float: 'DOUBLE', double: 'DOUBLE' };

/** A JSON path to one key: `$."key"` (the key is a validated identifier). */
const keyPath = (key) => `'$."${key}"'`;

export class DuckDBDialect extends Dialect {
  get name() { return 'duckdb'; }

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
    const base = this._whenJson(column, `json_extract_string(${column}, ${keyPath(key)})`);
    return this.castType(type) ? this.castExpr(base, type) : base;
  }

  jsonArrayLength(column, key) {
    this.ident(key);
    // A payload key is not typed: on some rows it may hold a scalar where others hold an array.
    // Not an array → NULL, which reads as "no array here" everywhere this is used.
    return this._whenJson(column, `json_array_length(${column}, ${keyPath(key)})`, `json_type(${column}, ${keyPath(key)}) = 'ARRAY'`);
  }

  // Element count of a native LIST column (an empty list is 0, NULL stays 0 as on the other side).
  arrayLength(column) { return `COALESCE(len(${column}), 0)`; }

  jsonArrayContains(column, key, value) {
    this.ident(key);
    return this._whenJson(column, `json_contains(json_extract(${column}, ${keyPath(key)}), ${this.sqlLiteral(JSON.stringify(value))})`, `json_type(${column}, ${keyPath(key)}) = 'ARRAY'`);
  }

  jsonStructField(column, key, field, type = 'string') {
    this.ident(key); this.ident(field);
    const base = this._whenJson(column, `json_extract_string(${column}, '$."${key}"."${field}"')`);
    return this.castType(type) ? this.castExpr(base, type) : base;
  }

  /**
   * One row per element of an array: a native LIST column, a key of a JSON column holding an array
   * (blob), or a string column holding a JSON array (encoding 'json'). A row whose value is not an
   * array contributes no elements.
   */
  arrayUnnest(prevAlias, column, key, alias, field, type = 'string', encoding = 'blob') {
    this.ident(alias);
    const e = `${alias}_e`;
    const pa = prevAlias ? `${prevAlias}.` : '';
    const lateral = (list) => `CROSS JOIN LATERAL (SELECT unnest(${list}) AS v) AS ${e}`;
    const cast = (x) => (this.castType(type) ? this.castExpr(x, type) : x);
    if (key == null && encoding === 'native') return { join: lateral(`${pa}${column}`), element: cast(`${e}.v`) };
    const src = `${pa}${column}`;
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
    const base = `json_extract_string(${column}, '$."${field}"')`;
    return this.castType(type) ? this.castExpr(base, type) : base;
  }

  // ── column-level complex primitives (a flattened payload column, no blob) ──
  jsonColumnArrayLength(column) {
    return this._whenJson(column, `json_array_length(${column})`, `json_type(${column}) = 'ARRAY'`);
  }

  jsonColumnArrayContains(column, value) {
    return this._whenJson(column, `json_contains(${column}, ${this.sqlLiteral(JSON.stringify(value))})`, `json_type(${column}) = 'ARRAY'`);
  }

  arrayContains(column, value) { return `list_contains(${column}, ${this.sqlLiteral(value)})`; }

  jsonColumnStructField(column, field, type = 'string') {
    this.ident(field);
    const base = this._whenJson(column, `json_extract_string(${column}, '$."${field}"')`);
    return this.castType(type) ? this.castExpr(base, type) : base;
  }

  // ── time / scalar / statistical ────────────────────────────────────────────
  _epoch(expr) { return `epoch(CAST(${expr} AS TIMESTAMP))`; }

  valueBucket(expr, buckets) { return `(hash(CAST(${expr} AS VARCHAR)) % ${Number(buckets)})`; }

  dateDiff(unit, from, to) {
    switch (unit) {
      case 'day': return `date_diff('day', CAST(${from} AS DATE), CAST(${to} AS DATE))`;
      case 'hour': return `((${this._epoch(to)} - ${this._epoch(from)}) / 3600.0)`;
      case 'minute': return `((${this._epoch(to)} - ${this._epoch(from)}) / 60.0)`;
      case 'second': return `(${this._epoch(to)} - ${this._epoch(from)})`;
      default: throw new Error(`dateDiff: bad unit ${unit}`);
    }
  }

  // Whole 24-HOUR days between two timestamps (retention-day style): floor of the elapsed span in
  // 24h buckets — matches BigQuery's EXTRACT(DAY FROM datetime interval), NOT calendar days
  // (dateDiff 'day' above is calendar). floor() handles the negative (pre-install) case.
  fullDaysBetween(from, to) {
    return `CAST(FLOOR((${this._epoch(to)} - ${this._epoch(from)}) / 86400.0) AS INTEGER)`;
  }

  // A key column may be a DATE on one side and a TIMESTAMP on the other, so both are lifted to
  // timestamp before truncating — the dialects must derive a key the same way.
  grainExpr(granularity, expr) {
    if (!['day', 'week', 'month', 'quarter', 'year'].includes(granularity)) throw new Error(`grainExpr: bad granularity ${granularity}`);
    return `date_trunc('${granularity}', CAST(${expr} AS TIMESTAMP))`;
  }

  dateTrunc(granularity, expr) {
    if (!['day', 'week', 'month', 'quarter', 'year'].includes(granularity)) throw new Error(`dateTrunc: bad granularity ${granularity}`);
    return `date_trunc('${granularity}', ${expr})`;
  }

  datePart(part, expr) {
    if (!['dow', 'hour', 'day', 'week', 'month', 'quarter', 'year', 'doy'].includes(part)) throw new Error(`datePart: bad part ${part}`);
    return `EXTRACT(${part} FROM ${expr})`;
  }

  // a plain TIMESTAMP (now() is WITH TIME ZONE), comparable with the TIMESTAMP columns
  nowExpr() { return 'CAST(now() AS TIMESTAMP)'; }

  roundExpr(expr, places = 0) { return `round(CAST(${expr} AS DOUBLE), ${Number(places)})`; }

  // SAFE cast only: a value that does not parse is NULL for its row (TRY_CAST), as BigQuery's
  // SAFE_CAST — a raw CAST would abort the whole statement on the first payload holding a word.
  // Integers go through DOUBLE so '1.5' → 2, as the other side rounds it.
  castExpr(expr, type) {
    const ct = this.castType(type);
    if (!ct) return `CAST(${expr} AS VARCHAR)`;
    if (ct === 'DOUBLE') return `TRY_CAST(${expr} AS DOUBLE)`;
    return `TRY_CAST(TRY_CAST(${expr} AS DOUBLE) AS ${ct})`;
  }

  substringExpr(expr, start, len) { return `substring(${expr}, ${Number(start)}${len != null ? `, ${Number(len)}` : ''})`; }

  unixDateExpr(expr) { return `date_diff('day', DATE '1970-01-01', CAST(${expr} AS DATE))`; }

  // EXACT distinct count: this is the local/test warehouse, where the numbers are checked exactly
  // (approx_count_distinct exists, but an HLL estimate would make a test's number a coin toss).
  approxCountDistinct(c) { return `count(distinct ${c})`; }

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
        return `SELECT *, ${op.cols.map((c) => `(${c.expr}) AS ${this.ident(c.name)}`).join(', ')} FROM ${prev}`;
      case 'unnest': {
        const { join, element } = this.arrayUnnest('s', op.column, op.key, op.as, op.field, op.type, op.encoding);
        return `SELECT s.*, ${element} AS ${this.ident(op.as)} FROM ${prev} s ${join}`;
      }
      case 'join':
        return this.joinCte(prev, op);
      case 'aggregate': {
        const sel = [...op.groupBy.map((c) => this.ident(c)), ...op.aggs.map((a) => `${a.expr} AS ${this.ident(a.as)}`)];
        return `SELECT ${sel.join(', ')} FROM ${prev}${op.groupBy.length ? ` GROUP BY ${op.groupBy.map((c) => this.ident(c)).join(', ')}` : ''}`;
      }
      case 'pivot': {
        // conditional aggregation; one output column per value.
        const cols = op.values.map((v) => `${op.fn}(CASE WHEN ${this.ident(op.on)} = ${this.sqlLiteral(v)} THEN ${this.ident(op.valueCol)} END) AS ${pivotCol(v)}`);
        return `SELECT ${op.groupBy.map((c) => this.ident(c)).join(', ')}${op.groupBy.length ? ', ' : ''}${cols.join(', ')} FROM ${prev}${op.groupBy.length ? ` GROUP BY ${op.groupBy.map((c) => this.ident(c)).join(', ')}` : ''}`;
      }
      case 'unpivot': {
        // one branch per unpivoted column — the same rows a LATERAL VALUES gives, in plain SQL
        const keep = op.keep.map((c) => this.ident(c));
        const branches = op.columns.map((c) => `SELECT ${keep.join(', ')}${keep.length ? ', ' : ''}${this.sqlLiteral(c)} AS ${this.ident(op.nameAs)}, ${this.ident(c)} AS ${this.ident(op.valueAs)} FROM ${prev}`);
        return branches.join('\n  UNION ALL\n  ');
      }
      case 'order_by':
        return `SELECT * FROM ${prev} ORDER BY ${op.keys.map((k) => `${this.ident(k.key)}${k.dir === 'desc' ? ' DESC' : ''}`).join(', ')}`;
      case 'sample':
        // a row-level (Bernoulli) sample that works at any stage (TABLESAMPLE needs a table)
        return `SELECT * FROM ${prev} WHERE random() < ${Number(op.percent) / 100}`;
      case 'limit':
        return `SELECT * FROM ${prev} LIMIT ${Number(op.n)}`;
      case 'project':
        return `SELECT ${op.cols.map((c) => this.ident(c)).join(', ')} FROM ${prev}`;
      default:
        throw new Error(`duckdb: unknown pipeline op '${op.op}'`);
    }
  }
}

// A pivot output value -> a safe quoted column identifier.
function pivotCol(value) {
  const v = String(value);
  if (!/^[A-Za-z0-9_]+$/.test(v)) throw new Error(`unsafe pivot value (must be alphanumeric/underscore): ${value}`);
  return `"${v}"`;
}
