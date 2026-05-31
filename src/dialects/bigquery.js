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

  arrayUnnest(_prevAlias, column, key, alias, field, type = 'string') {
    this.ident(key); this.ident(alias);
    if (field) {
      this.ident(field);
      const e = `${alias}_e`;
      const base = `JSON_VALUE(${e}, '$.${field}')`;
      const ct = this.castType(type);
      return { join: `CROSS JOIN UNNEST(JSON_QUERY_ARRAY(${column}, '$.${key}')) AS ${e}`, element: ct ? `CAST(${base} AS ${ct})` : base };
    }
    return { join: `CROSS JOIN UNNEST(JSON_VALUE_ARRAY(${column}, '$.${key}')) AS ${alias}`, element: alias };
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
        const { join, element } = this.arrayUnnest(null, op.column, op.key, op.as, op.field, op.type);
        // bind the element to `as` (already so for the scalar form)
        return op.field ? `|> ${join}\n|> EXTEND ${element} AS ${this.ident(op.as)}` : `|> ${join}`;
      }
      case 'join': {
        const onCond = op.on.map((c) => this.ident(c)).join(', ');
        return `|> ${op.kind === 'INNER' ? 'INNER ' : 'LEFT '}JOIN ${op.relation} ${op.alias} USING (${onCond})`;
      }
      case 'aggregate':
        return `|> AGGREGATE ${op.aggs.map((a) => `${a.expr} AS ${this.ident(a.as)}`).join(', ')}${op.groupBy.length ? ` GROUP BY ${op.groupBy.map((c) => this.ident(c)).join(', ')}` : ''}`;
      case 'pivot':
        return `|> AGGREGATE ${op.fn}(${this.ident(op.valueCol)}) AS v GROUP BY ${[...op.groupBy, op.on].map((c) => this.ident(c)).join(', ')}\n|> PIVOT(${op.fn}(v) FOR ${this.ident(op.on)} IN (${op.values.map((v) => this.sqlLiteral(v)).join(', ')}))`;
      case 'unpivot':
        return `|> UNPIVOT(${this.ident(op.valueAs)} FOR ${this.ident(op.nameAs)} IN (${op.columns.map((c) => this.ident(c)).join(', ')}))`;
      case 'order_by':
        return `|> ORDER BY ${op.keys.map((k) => `${this.ident(k.key)}${k.dir === 'desc' ? ' DESC' : ''}`).join(', ')}`;
      case 'limit':
        return `|> LIMIT ${Number(op.n)}`;
      case 'project':
        return `|> SELECT ${op.cols.map((c) => this.ident(c)).join(', ')}`;
      default:
        throw new Error(`bigquery: unknown pipeline op '${op.op}'`);
    }
  }
}
