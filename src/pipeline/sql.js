// WHAT A PIPELINE STAGE IS WRITTEN WITH — the schema pieces every stage shares (an operand, a
// condition, the comparison and aggregate vocabularies), their SQL over the columns available at
// that step (an operand, a condition, a window frame, an aggregate), and the bookkeeping of those
// columns (add one, require one to exist, require an array).

import { getDialect } from '../dialects/index.js';
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

// A RAW expression is the caller's own SQL, run as written — but a column it names has to exist at
// this point, or the warehouse refuses the whole model ("Unrecognized name") minutes later. What is
// surely a column reference is checked here: a name with an underscore (a SQL keyword that is not a
// function call rarely has one — those that do are listed), outside strings and quoted names, not a
// function (followed by "("), not a field of something (".x" / "x."), not an alias the expression
// declares itself (AS x, a lambda's x ->). Anything else — a bare word, a date part, a type — is left
// to the warehouse.
export const RAW_KEYWORDS = new Set(['current_date', 'current_time', 'current_timestamp', 'current_datetime', 'current_user', 'session_user', 'current_catalog', 'current_schema', 'current_role', 'utc_timestamp', 'utc_date']);

/**
 * The columns a RAW expression names bare whose names are reserved words of the warehouse (`new`,
 * `rows`, `group` — a pivot's values become such columns): SQL reads them as keywords, so the
 * expression fails in the warehouse. A quoted name, a function call (`if(`) and a field (`.new`)
 * are not such a use.
 */
export function rawReservedColumns(sql, cols, reserved) {
  if (!reserved?.size) return [];
  const text = unquotedSql(sql);
  const names = new Map([...cols.keys()].map((c) => [c.toLowerCase(), c]));
  const out = [];
  for (const m of text.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    const word = m[0]; const at = m.index; const end = at + word.length;
    const col = names.get(word.toLowerCase());
    if (!col || !reserved.has(word.toUpperCase()) || out.includes(col)) continue;
    if (/[.@:$]\s*$/.test(text.slice(Math.max(0, at - 2), at)) || /^\s*[(.]/.test(text.slice(end, end + 3))) continue;
    out.push(col);
  }
  return out;
}

/** Raw SQL with its comments, string literals and quoted names blanked: what is left is its code. */
export function unquotedSql(sql) {
  return String(sql)
    .replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.|"")*"|`[^`]*`/g, ' ');
}

export function rawUnknownColumns(sql, cols) {
  const text = unquotedSql(sql);
  const known = new Set([...cols.keys()].map((c) => c.toLowerCase()));
  for (const m of text.matchAll(/\bas\s+([A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*)\s*->/gi)) known.add((m[1] || m[2]).toLowerCase());
  const unknown = [];
  for (const m of text.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    const name = m[0]; const at = m.index; const end = at + name.length;
    if (!name.includes('_') || /[0-9]/.test(text[at - 1] || '') || RAW_KEYWORDS.has(name.toLowerCase()) || known.has(name.toLowerCase())) continue;
    if (/[.@:$]\s*$/.test(text.slice(Math.max(0, at - 2), at)) || /^\s*[(.]/.test(text.slice(end, end + 3))) continue;
    if (!unknown.includes(name)) unknown.push(name);
  }
  return unknown;
}


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
    // a TEXT column of the warehouse never equals a boolean: refused here, not as STRING = BOOL in the run
    if (left.physical && left.type === 'string' && [].concat(value).some((v) => typeof v === 'boolean')) {
      throw new Error(`'${name}' is a text column in the warehouse: compare it with its text value (a string such as 'false' or '0' — semantic_index({ request: { source, property } }) lists the values it holds), not with the boolean ${JSON.stringify(value)}`);
    }
    return comparison(left.sql, c.op, value, { lit: (v) => typedLiteral(left.type, v, `'${name}'`) });
  }
  // an expression on the right (a column, now, a function): a plain comparison of the two
  if (!OPSYM[c.op]) throw new Error(`'${c.op}' compares with a constant (value), not with an expression`);
  const r = exprSql(d, cols, right, 'right', opts);
  // a constant on the left compared with a column on the right is written in that column's type
  const lhs = c.left && Object.hasOwn(c.left, 'value') && c.left.fn === undefined ? typedLiteral(r.type, c.left.value, `'${right.column ?? 'the right side'}'`) : left.sql;
  return `${lhs} ${OPSYM[c.op]} ${r.sql}`;
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

