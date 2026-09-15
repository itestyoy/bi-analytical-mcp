// Postgres dialect: JSON/array primitives + pipeline lowering to a chained CTE.

import { Dialect } from './base.js';

const CASTS = { int: 'int', integer: 'int', bigint: 'bigint', numeric: 'numeric', float: 'double precision', double: 'double precision' };

export class PostgresDialect extends Dialect {
  get name() { return 'postgres'; }

  castType(type) { return CASTS[String(type || '').toLowerCase()]; }

  jsonExtract(column, key, type = 'string') {
    this.ident(key);
    const base = `(${column}->>'${key}')`;
    return this.castType(type) ? this.castExpr(base, type) : base;
  }

  jsonArrayLength(column, key) {
    this.ident(key);
    // A payload key is not typed: on some rows it may hold a scalar where others hold an array, and
    // asking a scalar for its length RAISES — failing the whole query over the column. Not an array
    // → NULL, which reads as "no array here" everywhere this is used. (`IS JSON` is Postgres 16+.)
    return `(CASE WHEN (${column}->'${key}') IS JSON ARRAY THEN jsonb_array_length(${column}->'${key}') END)`;
  }

  // Element count of a native array column (array_length returns NULL for an empty array → 0).
  arrayLength(column) { return `COALESCE(array_length(${column}, 1), 0)`; }

  jsonArrayContains(column, key, value) {
    this.ident(key);
    return `(${column}->'${key}') @> ${this.sqlLiteral(JSON.stringify([value]))}::jsonb`;
  }

  jsonStructField(column, key, field, type = 'string') {
    this.ident(key); this.ident(field);
    const base = `(${column}->'${key}'->>'${field}')`;
    return this.castType(type) ? this.castExpr(base, type) : base;
  }

  arrayUnnest(prevAlias, column, key, alias, field, type = 'string', encoding = 'blob') {
    this.ident(alias);
    const e = `${alias}_e`;
    const pa = prevAlias ? `${prevAlias}.` : '';
    // Native ARRAY column → unnest directly (no JSON parsing).
    if (key == null && encoding === 'native') {
      return { join: `CROSS JOIN LATERAL unnest(${pa}${column}) AS ${e}`, element: this.castType(type) ? this.castExpr(e, type) : e };
    }
    // The jsonb array to explode: a key inside a json column (blob), or the flat STRING
    // column itself parsed as jsonb (encoding 'json').
    let arr;
    if (key != null) { this.ident(key); arr = `${pa}${column}->'${key}'`; } else { arr = `(${pa}${column})::jsonb`; }
    if (field) {
      this.ident(field);
      const base = `(${e}->>'${field}')`;
      return { join: `CROSS JOIN LATERAL jsonb_array_elements(${arr}) AS ${e}`, element: this.castType(type) ? this.castExpr(base, type) : base };
    }
    if (type === 'json') { // bind the whole struct element as a jsonb column (multi-field extraction downstream)
      return { join: `CROSS JOIN LATERAL jsonb_array_elements(${arr}) AS ${e}`, element: e };
    }
    return { join: `CROSS JOIN LATERAL jsonb_array_elements_text(${arr}) AS ${e}`, element: this.castType(type) ? this.castExpr(e, type) : e };
  }

  /** STRING holding a JSON array → a native text[] array (so it can be unnested as native). */
  jsonParseArray(column) {
    return `ARRAY(SELECT jsonb_array_elements_text((${column})::jsonb))`;
  }

  arrayElementAt(column, index) { return `(${column})[${Number(index)}]`; }       // 1-based
  arrayLast(column) { return `(${column})[array_length(${column}, 1)]`; }

  /** Extract a scalar field from a JSON-valued COLUMN (e.g. an unnested struct element). */
  jsonColumnField(column, field, type = 'string') {
    this.ident(field);
    const base = `(${column}->>'${field}')`;
    return this.castType(type) ? this.castExpr(base, type) : base;
  }

  // ── column-level complex primitives (a flattened payload column, no blob) ──
  /**
   * A TEXT column holding JSON, read through the jsonb operators. The `::jsonb` cast RAISES on a
   * row whose text is not JSON, and ONE such row fails the whole statement — so every read guards
   * the cast the same way: the value is tested first, and a row that does not hold the expected
   * JSON shape yields NULL, which counts as absent everywhere these are used.
   *
   * The guard is what makes a malformed row a missing value instead of a failed query, so it
   * belongs to EVERY read, not just the one that happened to be scanned over every row. It needs
   * `IS JSON`, which is Postgres 16+ (PGlite 17 and BigQuery's own guards are fine); on an older
   * server these reads are unsupported rather than silently unguarded.
   */
  _jsonbWhenValid(column, expr, shape = '') {
    return `(CASE WHEN ${column} IS JSON${shape ? ` ${shape}` : ''} THEN ${expr} END)`;
  }

  jsonColumnArrayLength(column) {
    return this._jsonbWhenValid(column, `jsonb_array_length((${column})::jsonb)`, 'ARRAY');
  }

  jsonColumnArrayContains(column, value) {
    return this._jsonbWhenValid(column, `(((${column})::jsonb) @> ${this.sqlLiteral(JSON.stringify([value]))}::jsonb)`, 'ARRAY');
  }

  arrayContains(column, value) { return `(${this.sqlLiteral(value)} = ANY(${column}))`; }

  jsonColumnStructField(column, field, type = 'string') {
    this.ident(field);
    const base = `((${column})::jsonb->>'${field}')`;
    return this._jsonbWhenValid(column, this.castType(type) ? this.castExpr(base, type) : base);
  }

  // ── time / scalar / statistical ────────────────────────────────────────────
  dateDiff(unit, from, to) {
    switch (unit) {
      case 'day': return `(${to}::date - ${from}::date)`;
      case 'hour': return `(EXTRACT(EPOCH FROM (${to} - ${from})) / 3600.0)`;
      case 'minute': return `(EXTRACT(EPOCH FROM (${to} - ${from})) / 60.0)`;
      case 'second': return `EXTRACT(EPOCH FROM (${to} - ${from}))`;
      default: throw new Error(`dateDiff: bad unit ${unit}`);
    }
  }

  // Whole 24-HOUR days between two timestamps (retention-day style): floor of the elapsed span
  // in 24h buckets — matches BigQuery's EXTRACT(DAY FROM datetime interval), NOT calendar days
  // (dateDiff 'day' above is calendar). floor() handles the negative (pre-install) case; the
  // caller clamps/coalesces.
  fullDaysBetween(from, to) {
    return `FLOOR(EXTRACT(EPOCH FROM ((${to})::timestamp - (${from})::timestamp)) / 86400.0)::int`;
  }

  // Same reason as BigQuery's: a key column may be a DATE on one side and a TIMESTAMP on the
  // other, so both are lifted to timestamp before truncating (Postgres coerces DATE silently, but
  // the two dialects must derive a key the same way).
  grainExpr(granularity, expr) {
    if (!['day', 'week', 'month', 'quarter', 'year'].includes(granularity)) throw new Error(`grainExpr: bad granularity ${granularity}`);
    return `date_trunc('${granularity}', (${expr})::timestamp)`;
  }

  dateTrunc(granularity, expr) {
    if (!['day', 'week', 'month', 'quarter', 'year'].includes(granularity)) throw new Error(`dateTrunc: bad granularity ${granularity}`);
    return `date_trunc('${granularity}', ${expr})`;
  }

  datePart(part, expr) {
    if (!['dow', 'hour', 'day', 'week', 'month', 'quarter', 'year', 'doy'].includes(part)) throw new Error(`datePart: bad part ${part}`);
    return `EXTRACT(${part} FROM ${expr})`;
  }

  nowExpr() { return 'now()'; }

  roundExpr(expr, places = 0) { return `round((${expr})::numeric, ${Number(places)})`; }

  // SAFE cast only (Postgres has no TRY_CAST): text is always safe; a numeric target returns NULL
  // for non-numeric input (guard with a numeric-literal regex, then route through numeric so e.g.
  // '1.5'→int does not error). Never fails the query on a bad value — which is why EVERY read that
  // casts a JSON-derived value comes through here: a raw `::numeric` aborts the whole statement on
  // the first row whose payload holds a word, while BigQuery's SAFE_CAST yields NULL for that row
  // and results for the rest. The two dialects must answer the same question the same way.
  castExpr(expr, type) {
    const ct = this.castType(type);
    if (!ct || ct === 'text') return `(${expr})::text`;
    return `(CASE WHEN (${expr})::text ~ '^\\s*[-+]?[0-9]+(\\.[0-9]+)?([eE][-+]?[0-9]+)?\\s*$' THEN (${expr})::numeric${ct === 'numeric' ? '' : `::${ct}`} END)`;
  }

  substringExpr(expr, start, len) { return `substring(${expr} from ${Number(start)}${len != null ? ` for ${Number(len)}` : ''})`; }

  unixDateExpr(expr) { return `((${expr})::date - DATE '1970-01-01')`; }

  // Postgres core has no HLL++; fall back to an EXACT distinct count (same answer,
  // not approximate). Install the postgresql-hll extension for true HLL++.
  approxCountDistinct(c) { return `count(distinct ${c})`; }

  // EXACT, MERGEABLE sketch fallback: a sketch is the chr(1)-joined set of distinct
  // values. init dedups; merge_partial concatenates (a coarser sketch); merge and
  // extract dedup-and-count. Same additive semantics as HLL++, exact (small data).
  hllInit(c) { return `string_agg(distinct (${c})::text, chr(1))`; }
  hllMergePartial(c) { return `string_agg(${c}, chr(1))`; }
  hllMerge(c) { return `(SELECT count(distinct e) FROM unnest(string_to_array(string_agg(${c}, chr(1)), chr(1))) AS e)`; }
  hllExtract(c) { return `(SELECT count(distinct e) FROM unnest(string_to_array(${c}, chr(1))) AS e)`; }

  statAggExpr(fn, c, q) {
    switch (fn) {
      case 'stddev': return `stddev_samp(${c})`;
      case 'variance': return `var_samp(${c})`;
      case 'median': return `percentile_cont(0.5) WITHIN GROUP (ORDER BY ${c})`;
      case 'percentile': return `percentile_cont(${Number(q)}) WITHIN GROUP (ORDER BY ${c})`;
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
        // emulate PIVOT with conditional aggregation; one output column per value.
        const cols = op.values.map((v) => `${op.fn}(CASE WHEN ${this.ident(op.on)} = ${this.sqlLiteral(v)} THEN ${this.ident(op.valueCol)} END) AS ${pivotCol(v)}`);
        return `SELECT ${op.groupBy.map((c) => this.ident(c)).join(', ')}${op.groupBy.length ? ', ' : ''}${cols.join(', ')} FROM ${prev}${op.groupBy.length ? ` GROUP BY ${op.groupBy.map((c) => this.ident(c)).join(', ')}` : ''}`;
      }
      case 'unpivot': {
        const vals = op.columns.map((c) => `(${this.sqlLiteral(c)}, ${this.ident(c)})`).join(', ');
        return `SELECT ${op.keep.map((c) => this.ident(c)).join(', ')}${op.keep.length ? ', ' : ''}u.${this.ident(op.nameAs)}, u.${this.ident(op.valueAs)} FROM ${prev} CROSS JOIN LATERAL (VALUES ${vals}) AS u(${this.ident(op.nameAs)}, ${this.ident(op.valueAs)})`;
      }
      case 'order_by':
        return `SELECT * FROM ${prev} ORDER BY ${op.keys.map((k) => `${this.ident(k.key)}${k.dir === 'desc' ? ' DESC' : ''}`).join(', ')}`;
      case 'sample':
        // TABLESAMPLE only applies to physical tables in Postgres, not CTEs, so
        // we emulate a row-level (Bernoulli) sample that works at any pipe stage.
        return `SELECT * FROM ${prev} WHERE random() < ${Number(op.percent) / 100}`;
      case 'limit':
        return `SELECT * FROM ${prev} LIMIT ${Number(op.n)}`;
      case 'project':
        return `SELECT ${op.cols.map((c) => this.ident(c)).join(', ')} FROM ${prev}`;
      default:
        throw new Error(`postgres: unknown pipeline op '${op.op}'`);
    }
  }
}

// A pivot output value -> a safe quoted column identifier.
function pivotCol(value) {
  const v = String(value);
  if (!/^[A-Za-z0-9_]+$/.test(v)) throw new Error(`unsafe pivot value (must be alphanumeric/underscore): ${value}`);
  return `"${v}"`;
}
