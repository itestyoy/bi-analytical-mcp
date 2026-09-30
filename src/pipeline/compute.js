// THE COMPUTE STAGE'S OPS — one table: each op's required fields and its SQL. The stage's schema (the
// op enum, the per-op requirements) and its build both read it (src/pipeline/stages.js).

import { rawUnknownColumns, condPred, frameClause, requireCol, requireArrayCol } from './sql.js';

// ── The compute stage's ops ─────────────────────────────
// One entry per op: what it needs (`needs` — the fields its schema makes required, or `then` for a rule
// that is not a plain list) and how it is written (`sql`, over one step's helpers → { expr, type },
// type 'numeric' when it is not said). The op enum, the schema's per-op requirements and the build all
// read this table, so an op is added in one place.
export const fn1 = (fn, type) => ({ needs: ['column'], sql: ({ col }) => ({ expr: `${fn}(${col()})`, type }) });

export const arith = (sym) => ({
  needs: ['left', 'right'],
  sql: ({ operand, p }) => {
    const l = operand(p.left, 'left'); const r = operand(p.right, 'right');
    return { expr: sym === '/' ? `(${l} / NULLIF(${r}, 0))` : `(${l} ${sym} ${r})` };
  },
});

// Clamping against a NUMBER (a threshold computed in an earlier pass) is the common case, so the
// operands may be literals as well as columns: `parts` takes operands, `columns` stays the shorthand
// for the all-columns form.
export const clamp = (fn) => ({
  then: { anyOf: [{ title: 'all-columns form: { columns: ["a", "b"] }', required: ['columns'] }, { title: 'with a literal: { parts: [{ column: "a" }, { value: 12.5 }] }', required: ['parts'] }] },
  sql: ({ operand, list, p }) => {
    const args = p.parts?.length ? p.parts.map((o, i) => operand(o, `part[${i}]`)) : list();
    if (!args.length) throw new Error(`compute op '${fn}' needs \`columns\` (column names) or \`parts\` (columns and/or literals, e.g. a threshold)`);
    return { expr: `${fn}(${args.join(', ')})` };
  },
});

export const COMPUTE_OPS = {
  const: {
    needs: ['value'],
    sql: ({ d, p }) => {
      if (p.value === undefined) throw new Error("compute op 'const' needs a `value` (the literal to place in the column)");
      return { expr: d.sqlLiteral(p.value), type: typeof p.value === 'number' ? 'numeric' : typeof p.value === 'boolean' ? 'boolean' : 'string' };
    },
  },
  add: arith('+'),
  sub: arith('-'),
  mul: arith('*'),
  div: arith('/'),
  round: { needs: ['column'], sql: ({ d, col, p }) => ({ expr: d.roundExpr(col(), p.places ?? 0) }) },
  floor: fn1('floor'),
  ceil: fn1('ceil'),
  abs: fn1('abs'),
  coalesce: { needs: ['columns'], sql: ({ d, list, p }) => ({ expr: `coalesce(${[...list(), ...(p.default !== undefined ? [d.sqlLiteral(p.default)] : [])].join(', ')})`, type: 'string' }) },
  least: clamp('least'),
  greatest: clamp('greatest'),
  cast: { needs: ['column', 'type'], sql: ({ d, col, p }) => ({ expr: d.castExpr(col(), p.type || 'string'), type: p.type || 'string' }) },
  concat: {
    needs: ['parts'],
    sql: ({ operand, p }) => {
      if (!p.parts?.length) throw new Error('concat: needs parts');
      return { expr: `concat(${p.parts.map((o, i) => operand(o, `part[${i}]`)).join(', ')})`, type: 'string' };
    },
  },
  upper: fn1('upper', 'string'),
  lower: fn1('lower', 'string'),
  length: fn1('length', 'int'),
  substring: { needs: ['column', 'start'], sql: ({ d, col, p }) => ({ expr: d.substringExpr(col(), p.start ?? 1, p.len), type: 'string' }) },
  trim: fn1('trim', 'string'),
  replace: { needs: ['column', 'search', 'replacement'], sql: ({ d, col, p }) => ({ expr: `replace(${col()}, ${d.sqlLiteral(p.search ?? '')}, ${d.sqlLiteral(p.replacement ?? '')})`, type: 'string' }) },
  json_field: {
    needs: ['column', 'field'],
    // An unnested struct element is already JSON-typed; a flattened payload column holding JSON is
    // TEXT and has to be parsed first, or the json operators do not apply to it.
    sql: ({ d, cols, col, p }) => {
      requireCol(cols, p.column);
      const asJson = cols.get(p.column)?.type === 'json';
      return { expr: asJson ? d.jsonColumnField(col(), p.field, p.type) : d.jsonColumnStructField(col(), p.field, p.type), type: p.type || 'string' };
    },
  },
  json_parse_array: { needs: ['column'], sql: ({ d, col }) => ({ expr: d.jsonParseArray(col()), type: 'array' }) }, // STRING JSON array → native array (then unnest)
  element_at: { needs: ['column', 'index'], sql: ({ d, cols, col, p }) => { requireArrayCol(cols, p.column, 'element_at'); return { expr: d.arrayElementAt(col(), p.index), type: p.type || 'string' }; } },
  array_last: { needs: ['column'], sql: ({ d, cols, col, p }) => { requireArrayCol(cols, p.column, 'array_last'); return { expr: d.arrayLast(col()), type: p.type || 'string' }; } },
  raw: {
    needs: ['sql'],
    // escape hatch: verbatim dialect SQL — over columns that exist at this point
    sql: ({ cols, p }) => {
      if (!p.sql) throw new Error('raw: needs sql');
      const unknown = rawUnknownColumns(p.sql, cols);
      if (unknown.length) throw new Error(`pipeline: raw expression for '${p.name}' names ${unknown.map((n) => `'${n}'`).join(', ')}, not ${unknown.length === 1 ? 'a column' : 'columns'} at this stage (available: ${[...cols.keys()].join(', ')}) — a raw expression reads the columns the steps before it produced`);
      return { expr: `(${p.sql})`, type: p.type || 'string' };
    },
  },
  hll_extract: { needs: ['column'], sql: ({ d, col }) => ({ expr: d.hllExtract(col()), type: 'int' }) },
  date_diff: { needs: ['from', 'to', 'unit'], sql: ({ d, operand, p }) => ({ expr: d.dateDiff(p.unit, operand(p.from, 'from'), operand(p.to, 'to')), type: p.unit === 'day' ? 'int' : 'numeric' }) },
  date_trunc: { needs: ['column', 'granularity'], sql: ({ d, col, p }) => ({ expr: d.dateTrunc(p.granularity, col()), type: 'time' }) },
  date_part: { needs: ['column', 'part'], sql: ({ d, col, p }) => ({ expr: d.datePart(p.part, col()), type: 'int' }) },
  unix_date: { needs: ['column'], sql: ({ d, col }) => ({ expr: d.unixDateExpr(col()), type: 'int' }) },
  elapsed_days: {
    needs: ['from', 'to'],
    // Whole 24-HOUR days between `from` and `to` (retention-day) — floor of the span in 24h buckets,
    // NOT calendar days. Default clamp_zero folds negatives (pre-`from` events) AND NULLs (e.g. a
    // missing install_date on a left join) to 0, so the result is a clean day 0+.
    sql: ({ d, operand, p }) => {
      const inner = d.fullDaysBetween(operand(p.from, 'from'), operand(p.to, 'to'));
      return { expr: p.clamp_zero === false ? inner : `COALESCE(GREATEST(${inner}, 0), 0)`, type: 'int' };
    },
  },
  case: {
    needs: ['cases'],
    sql: ({ d, cols, operand, p }) => {
      if (!p.cases?.length) throw new Error('case: needs at least one branch');
      const branches = p.cases.map((cs) => `WHEN ${cs.when.map((c) => condPred(d, cols, c)).join(' AND ')} THEN ${operand(cs.then, 'then')}`);
      return { expr: `CASE ${branches.join(' ')}${p.else !== undefined ? ` ELSE ${operand(p.else, 'else')}` : ''} END`, type: p.type || 'string' };
    },
  },
  window: {
    needs: ['fn'],
    sql: ({ d, cols, col, p }) => {
      (p.partition_by || []).forEach((c) => requireCol(cols, c));
      (p.order_by || []).forEach((o) => requireCol(cols, o.key));
      const parts = (p.partition_by || []).map((c) => d.quoteIdent(c));
      const ords = (p.order_by || []).map((o) => `${d.quoteIdent(o.key)}${o.direction === 'desc' ? ' DESC' : ''}`);
      let call; let frame = ''; let type;
      if (['row_number', 'rank', 'dense_rank'].includes(p.fn)) { call = `${p.fn}()`; type = 'int'; }
      // the value a lag/lead/min/max returns is the column's own; a count is a whole number
      else if (['lag', 'lead'].includes(p.fn)) { call = `${p.fn}(${col()}, ${p.offset ?? 1}${p.default !== undefined ? `, ${d.sqlLiteral(p.default)}` : ''})`; type = cols.get(p.column)?.type || 'unknown'; }
      else if (['sum', 'avg', 'count', 'min', 'max'].includes(p.fn)) {
        call = p.fn === 'count' && !p.column ? 'count(*)' : `${p.fn}(${col()})`; frame = frameClause(p.frame);
        type = p.fn === 'count' ? 'int' : ['min', 'max'].includes(p.fn) ? (cols.get(p.column)?.type || 'unknown') : 'numeric';
      }
      else throw new Error(`window: bad fn ${p.fn}`);
      if (frame && !ords.length) throw new Error('window frame requires order_by');
      const over = `OVER (${[parts.length ? `PARTITION BY ${parts.join(', ')}` : '', ords.length ? `ORDER BY ${ords.join(', ')}` : ''].filter(Boolean).join(' ')}${frame})`;
      return { expr: `${call} ${over}`, type };
    },
  },
};

/** The compute schema's per-op requirements, read off COMPUTE_OPS — ops that need the same fields share one rule. */
export function computeRequirements() {
  const byRule = new Map();
  for (const [op, o] of Object.entries(COMPUTE_OPS)) {
    const then = o.then || { required: o.needs };
    const key = JSON.stringify(then);
    if (!byRule.has(key)) byRule.set(key, { then, ops: [] });
    byRule.get(key).ops.push(op);
  }
  return [...byRule.values()].map(({ then, ops }) => ({ if: { properties: { op: ops.length === 1 ? { const: ops[0] } : { enum: ops } }, required: ['op'] }, then }));
}
