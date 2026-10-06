// WHAT A PIPELINE STAGE IS WRITTEN WITH — the schema pieces every stage shares (an operand, a
// condition, the comparison and aggregate vocabularies), their SQL over the columns available at
// that step (an operand, a condition, a window frame, an aggregate), and the bookkeeping of those
// columns (add one, require one to exist, require an array).

import { getDialect } from '../dialects/index.js';
import { isNumericType, isTimeType } from '../dialects/base.js';
import { COMPARE_SQL, OPS, comparison, typedLiteral } from '../conditions.js';
import { form, conditionList, CONSTANT } from '../schema-kit.js';
// (compute.js imports this module too: exprSql is read when a condition is written, never as the module loads)
import { exprSql } from './compute.js';

export const NAME = '^[a-z][a-z0-9_]{0,40}$';

export const NAME_RE = /^[a-z][a-z0-9_]{0,40}$/;

export const CMP = OPS;

export const AGG_FNS = ['sum', 'average', 'min', 'max', 'count', 'count_distinct', 'approx_count_distinct', 'stddev', 'variance', 'median', 'percentile', 'hll_init', 'hll_merge', 'hll_merge_partial'];

export const SKETCH_FNS = new Set(['hll_init', 'hll_merge_partial']); // produce a sketch column

export const STAT_FNS = new Set(['stddev', 'variance', 'median', 'percentile']);

/**
 * What THIS warehouse's statistical aggregates are: exact, or a sketch. The dialect declares it
 * (`approximateStats`), because the same `percentile` is exact on one warehouse and approximate on
 * another — and a caller that reports "the P99" has to say which of the two it is holding.
 */
export function statAccuracyNote(catalog) {
  let approx = [];
  try { approx = getDialect(catalog?.dialect)?.approximateStats || []; } catch { approx = []; }
  return approx.length
    ? `ON THIS WAREHOUSE ${approx.join('/')} are APPROXIMATE (sketch-based, which is what makes them cheap on a large table) — say so when you report the number; the other measures are exact.`
    : 'On this warehouse every measure here is exact.';
}

// An operand is an EXPRESSION (src/pipeline/compute.js: a column, a constant, now, or a function of
// expressions), defined once in the stage schemas' $defs and referenced from every place that takes one.
export const EXPR = { $ref: '#/$defs/expr' };

// One comparison, used identically by `where` and `case` branches. Either side is
// a column / constant / now: shorthand `{column, op, value}` (column vs constant)
// or `{left, op, right}` (column-vs-column, constant-vs-column, …). in/not_in take
// an array via `value` or `right.value`.
export const CONDITION = {
  type: 'object',
  description: 'A comparison: left = `column` (shorthand) or `left` operand; right = `value` constant (shorthand; array for in/not_in; [low,high] for between) or `right` operand. is_null/is_not_null take no right side.',
  // the left side is a column named outright or an operand — one of the two, never both
  anyOf: [
    form({ title: 'a column compared — { column, op, value } or { column, op, right: { column } }', required: ['column', 'op'], properties: { column: { type: 'string' }, op: { enum: CMP }, value: CONSTANT, right: EXPR } }),
    form({ title: 'an operand compared — { left: { column } | { value } | { now: true } | { fn, args }, op, right: { … } or value }', required: ['left', 'op'], properties: { left: EXPR, op: { enum: CMP }, value: CONSTANT, right: EXPR } }),
  ],
};

export const OPSYM = COMPARE_SQL;

/** The conditions a stage keeps rows by (a where, a CASE branch): a list that all hold, with { or } / { and } groups. */
export const CONDITIONS = (description) => conditionList(CONDITION, description);

// A string constrained to event-property `values`, but never an empty enum (ajv
// rejects `enum: []` at compile time). When the catalog has no such properties
// (e.g. a fully flattened payload with no array/struct fields) the field stays an
// open string — there is nothing valid to pick anyway.
export const propEnum = (values, description) => (values.length ? { type: 'string', enum: values, description } : { type: 'string', description });

/** An event property as seen from the pipeline's SOURCE fact (Catalog.propertyFor owns the
 *  bare-vs-qualified rules); a property of another fact is rejected with the fix. */
export const sourceProp = (catalog, source, name) => (source
  ? catalog.propertyFor(source, name, { hint: 'start the pipeline from the source that owns it' }) // the message names the owner
  : null);

/** A raw expression's SQL with `{n}` replaced by its n-th argument's SQL (outside strings, quoted
 *  names and comments); a placeholder with no argument, or an argument no placeholder uses, is refused. */
export function fillPlaceholders(sql, args) {
  const src = String(sql); const code = unquotedSql(src);
  const used = new Set();
  let out = ''; let last = 0;
  for (const m of code.matchAll(/\{(\d+)\}/g)) {
    const n = Number(m[1]);
    if (!(n >= 1 && n <= args.length)) throw new Error(`pipeline: a raw expression's {${n}} has no argument — it has ${args.length} (args: [${'{ column }'}, …], {1} the first)`);
    used.add(n);
    out += src.slice(last, m.index) + args[n - 1]; last = m.index + m[0].length;
  }
  const unused = args.map((_, i) => i + 1).filter((n) => !used.has(n));
  if (unused.length) throw new Error(`pipeline: a raw expression's argument${unused.length > 1 ? 's' : ''} ${unused.map((n) => `{${n}}`).join(', ')} ${unused.length > 1 ? 'are' : 'is'} not used in its SQL`);
  return out + src.slice(last);
}

/** Raw SQL with its comments, strings ('…', "…") and quoted names (`…`) blanked to spaces of the same
 *  length: what is left is its code, at the positions it holds in the text — the one reading of raw
 *  text, for its placeholders and its OVER alike. */
export function unquotedSql(sql) {
  return String(sql).replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.|"")*"|`[^`]*`/g, (m) => ' '.repeat(m.length));
}


// How a flag is spelled when a column stores it as text.
const TEXT_TRUE = ['true', '1', 't'];
const TEXT_FALSE = ['false', '0', 'f'];

// One comparison. Each side may be a column, a constant (value), or now:
//   { column, op, value }        — column vs constant (shorthand)
//   { left:{...}, op, right:{...} } — operands on both sides (column vs column,
//                                     constant vs column, etc.)
/** One condition's SQL. `opts` passes on to the expressions it compares (src/pipeline/compute.js exprSql:
 *  a where's condition takes no window function). */
export function condPred(d, cols, c, opts = {}) {
  // the left side: a column named outright, or an expression — with the type its constants are written in
  let left;
  if (c.left !== undefined) left = exprSql(d, cols, c.left, 'left', opts);
  else if (c.column !== undefined) { requireCol(cols, c.column); left = { sql: d.quoteIdent(c.column), type: cols.get(c.column)?.type || null, physical: !!cols.get(c.column)?.physical }; }
  else throw new Error('condition needs `column` or `left`');
  const name = c.column ?? c.left?.column ?? 'the left side';
  const right = c.right;
  // a constant on the right (`value`, or right: { value }) — the one comparison writer, in the left side's type
  if (right === undefined || (Object.hasOwn(right, 'value') && right.fn === undefined)) {
    const value = right ? right.value : c.value;
    if (value === undefined && c.op !== 'is_null' && c.op !== 'is_not_null') throw new Error('condition needs `value` or `right`');
    // a TEXT column of the warehouse holding a flag: a boolean is compared with every way text spells
    // it (true / 1 / t, false / 0 / f), so neither STRING = BOOL in the run nor a guess at the spelling
    if (left.physical && left.type === 'string' && [].concat(value).some((v) => typeof v === 'boolean')) {
      const values = [].concat(value);
      if (!['eq', 'ne', 'in', 'not_in'].includes(c.op) || !values.every((v) => typeof v === 'boolean')) {
        throw new Error(`'${name}' is a text column in the warehouse: a boolean is compared with it by eq / ne / in / not_in alone, and not mixed with other constants — or compare it with its text value (semantic_index({ request: { source, property } }) lists the values it holds)`);
      }
      const spellings = values.flatMap((v) => (v ? TEXT_TRUE : TEXT_FALSE)).map((s) => d.sqlLiteral(s));
      return `LOWER(TRIM(${left.sql})) ${c.op === 'ne' || c.op === 'not_in' ? 'NOT IN' : 'IN'} (${spellings.join(', ')})`;
    }
    return comparison(left.sql, c.op, value, { lit: (v) => typedLiteral(left.type, v, `'${name}'`) });
  }
  // an expression on the right (a column, now, a function): a plain comparison of the two
  if (!OPSYM[c.op]) throw new Error(`'${c.op}' compares with a constant (value), not with an expression`);
  const r = exprSql(d, cols, right, 'right', opts);
  // a constant on the left compared with a column on the right is written in that column's type
  if (c.left && Object.hasOwn(c.left, 'value') && c.left.fn === undefined) return `${typedLiteral(r.type, c.left.value, `'${right.column ?? 'the right side'}'`)} ${OPSYM[c.op]} ${r.sql}`;
  // a moment compared with an expression: a number or a boolean is never one — refused here, not as
  // DATE >= INT64 in the run; anything else meets it as a timestamp on both sides, so a DATE column
  // and a TIMESTAMP expression (a raw TIMESTAMP_SUB, now) compare as the warehouse cannot otherwise
  if (isTimeType(left.type) || isTimeType(r.type)) {
    const other = isTimeType(left.type) ? r.type : left.type;
    if (isNumericType(other) || other === 'boolean') {
      throw new Error(`${isTimeType(left.type) ? `'${name}'` : `'${right.column ?? 'the right side'}'`} is a moment (a date or a timestamp), and the other side is ${other}: compare it with a moment — { now: true }, a time column, a date_trunc, or a raw expression that yields a timestamp (e.g. { fn: "raw", sql: "TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)" }) — or with a date string as \`value\``);
    }
    return `${d.timeOperand(left.sql)} ${OPSYM[c.op]} ${d.timeOperand(r.sql)}`;
  }
  return `${left.sql} ${OPSYM[c.op]} ${r.sql}`;
}

// Window frame clause, e.g. ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW, or
// RANGE BETWEEN 10 PRECEDING AND CURRENT ROW (value offsets on the order key).
export function frameClause(f) {
  if (!f) return '';
  const mode = f.mode === 'range' ? 'RANGE' : 'ROWS';
  const bound = (v, dir) => {
    if (v === 'unbounded') return `UNBOUNDED ${dir}`;
    if (v === undefined || v === null || Number(v) === 0) return 'CURRENT ROW';
    if (!Number.isInteger(Number(v)) || Number(v) < 0) throw new Error(`window frame: bad ${dir.toLowerCase()} offset ${v}`);
    return `${Number(v)} ${dir}`;
  };
  const start = bound(f.preceding ?? 'unbounded', 'PRECEDING');
  const end = f.following === undefined ? 'CURRENT ROW' : bound(f.following, 'FOLLOWING');
  return ` ${mode} BETWEEN ${start} AND ${end}`;
}

/** The SQL function of an aggregation where it differs from its name (the vocabulary is the semantic layer's). */
export const sqlAgg = (agg) => (agg === 'average' ? 'avg' : agg);

export function aggExpr(d, fn, column, q, cond = null) {
  // a CONDITIONAL aggregate folds only the rows `cond` holds for: the value is NULL on every other
  // row, which every aggregate skips — count(case when …), sum(case when …) — the same on every warehouse
  if (fn === 'count' && !column) return cond ? `count(CASE WHEN ${cond} THEN 1 END)` : 'count(*)';
  const c = cond ? `CASE WHEN ${cond} THEN ${d.quoteIdent(column)} END` : d.quoteIdent(column);
  if (fn === 'count_distinct') return `count(distinct ${c})`;
  if (fn === 'approx_count_distinct') return d.approxCountDistinct(c);
  if (fn === 'hll_init') return d.hllInit(c);
  if (fn === 'hll_merge') return d.hllMerge(c);
  if (fn === 'hll_merge_partial') return d.hllMergePartial(c);
  if (STAT_FNS.has(fn)) {
    if (fn === 'percentile' && !(typeof q === 'number' && q > 0 && q < 1)) throw new Error('percentile requires `percentile` in (0,1)');
    return d.statAggExpr(fn, c, q);
  }
  return `${sqlAgg(fn)}(${c})`; // sum / average / min / max
}

export function addCol(cols, name, type) {
  if (!NAME_RE.test(name)) throw new Error(`invalid column name: ${name}`);
  const out = new Map(cols);
  out.set(name, { type });
  return out;
}

export function requireCol(cols, name) {
  if (cols.has(name)) return;
  // '*' is the GOVERNED path's spelling for "the rows themselves" (measures take field: '*').
  // A stage counts rows by leaving `column` out entirely, so say that instead of listing every
  // column and leaving the caller to guess what a SQL habit translates to here.
  if (name === '*') {
    throw new Error("pipeline: '*' is not a column — a stage counts ROWS by omitting `column` ({ name, agg: 'count' }); `field: '*'` is the governed path's spelling (build_semantic_model measures)");
  }
  throw new Error(`pipeline: unknown column '${name}' at this stage (available: ${[...cols.keys()].join(', ')})`);
}

