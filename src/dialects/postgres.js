// Postgres dialect: JSON/array primitives + pipeline lowering to a chained CTE.

import { Dialect } from './base.js';

const CASTS = { int: 'int', integer: 'int', bigint: 'bigint', numeric: 'numeric', float: 'double precision', double: 'double precision' };

export class PostgresDialect extends Dialect {
  get name() { return 'postgres'; }

  castType(type) { return CASTS[String(type || '').toLowerCase()]; }

  jsonExtract(column, key, type = 'string') {
    this.ident(key);
    const base = `(${column}->>'${key}')`;
    const ct = this.castType(type);
    return ct ? `${base}::${ct}` : base;
  }

  jsonArrayLength(column, key) {
    this.ident(key);
    return `jsonb_array_length(${column}->'${key}')`;
  }

  jsonArrayContains(column, key, value) {
    this.ident(key);
    return `(${column}->'${key}') @> ${this.sqlLiteral(JSON.stringify([value]))}::jsonb`;
  }

  jsonStructField(column, key, field, type = 'string') {
    this.ident(key); this.ident(field);
    const base = `(${column}->'${key}'->>'${field}')`;
    const ct = this.castType(type);
    return ct ? `${base}::${ct}` : base;
  }

  arrayUnnest(prevAlias, column, key, alias, field, type = 'string') {
    this.ident(key); this.ident(alias);
    const e = `${alias}_e`;
    if (field) {
      this.ident(field);
      const base = `(${e}->>'${field}')`;
      const ct = this.castType(type);
      return { join: `CROSS JOIN LATERAL jsonb_array_elements(${prevAlias}.${column}->'${key}') AS ${e}`, element: ct ? `${base}::${ct}` : base };
    }
    return { join: `CROSS JOIN LATERAL jsonb_array_elements_text(${prevAlias}.${column}->'${key}') AS ${e}`, element: e };
  }

  // ── Pipeline lowering: each op becomes a CTE `p{i}` selecting from the prior ──
  renderPipeline(baseRelation, ops) {
    if (!ops.length) return `SELECT * FROM ${baseRelation}`;
    let prev = baseRelation;
    const ctes = [];
    ops.forEach((op, i) => {
      const name = `p${i}`;
      ctes.push(`${name} AS (\n  ${this._step(prev, op)}\n)`);
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
        const { join, element } = this.arrayUnnest('s', op.column, op.key, op.as, op.field, op.type);
        return `SELECT s.*, ${element} AS ${this.ident(op.as)} FROM ${prev} s ${join}`;
      }
      case 'join': {
        const onCond = op.on.map((c) => `j.${this.ident(c)} = base.${this.ident(c)}`).join(' AND ');
        const attrs = op.attrs.map((a) => `j.${this.ident(a)} AS ${this.ident(a)}`);
        return `SELECT base.*${attrs.length ? `, ${attrs.join(', ')}` : ''} FROM ${prev} base ${op.kind || 'LEFT'} JOIN ${op.relation} j ON ${onCond}`;
      }
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
