// WHAT A PIPELINE STAGE IS WRITTEN WITH — the schema pieces every stage shares (an operand, a
// condition, the comparison and aggregate vocabularies), their SQL over the columns available at
// that step (an operand, a condition, a window frame, an aggregate), and the bookkeeping of those
// columns (add one, require one to exist, require an array).

import { getDialect } from '../dialects/index.js';
import { COMPARE_SQL, typedLiteral } from '../conditions.js';
import { form } from '../schema-kit.js';

export const NAME = '^[a-z][a-z0-9_]{0,40}$';

export const NAME_RE = /^[a-z][a-z0-9_]{0,40}$/;

export const CMP = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'between', 'is_null', 'is_not_null', 'like', 'not_like', 'contains', 'starts_with', 'ends_with'];

export const AGG_FNS = ['sum', 'avg', 'min', 'max', 'count', 'count_distinct', 'approx_count_distinct', 'stddev', 'variance', 'median', 'percentile', 'hll_init', 'hll_merge', 'hll_merge_partial'];

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

// A scalar operand: exactly one of a column reference, a literal value, or the
// `now` token (current timestamp). Shared by `where`, `compute`, and `case`.
export const OPERAND = {
  type: 'object',
  description: 'One of: { column }, { value }, or { now: true }.',
  anyOf: [
    form({ title: 'a column', required: ['column'], properties: { column: { type: 'string' } } }),
    form({ title: 'a constant', required: ['value'], properties: { value: {} } }),
    form({ title: 'the current time', required: ['now'], properties: { now: { const: true } } }),
  ],
};

// One comparison, used identically by `where` and `case` branches. Either side is
// a column / constant / now: shorthand `{column, op, value}` (column vs constant)
// or `{left, op, right}` (column-vs-column, constant-vs-column, …). in/not_in take
// an array via `value` or `right.value`.
export const CONDITION = {
  type: 'object',
  description: 'A comparison: left = `column` (shorthand) or `left` operand; right = `value` constant (shorthand; array for in/not_in; [low,high] for between) or `right` operand. is_null/is_not_null take no right side.',
  // the left side is a column named outright or an operand — one of the two, never both
  anyOf: [
    form({ title: 'a column compared', required: ['column', 'op'], properties: { column: { type: 'string' }, op: { enum: CMP }, value: {}, right: OPERAND } }),
    form({ title: 'an operand compared', required: ['left', 'op'], properties: { left: OPERAND, op: { enum: CMP }, value: {}, right: OPERAND } }),
  ],
};

export const OPSYM = COMPARE_SQL;

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

// SQL for one operand: a column reference, a literal constant, or `now`.
export function operandSql(d, cols, o, label = 'operand') {
  if (o === null || typeof o !== 'object') throw new Error(`${label}: must be { column } | { value } | { now: true }`);
  if (o.now) return d.nowExpr();
  if (o.column !== undefined) { requireCol(cols, o.column); return d.quoteIdent(o.column); }
  if (o.value !== undefined) return d.sqlLiteral(o.value);
  throw new Error(`${label}: needs column | value | now`);
}

// A RAW expression is the caller's own SQL, run as written — but a column it names has to exist at
// this point, or the warehouse refuses the whole model ("Unrecognized name") minutes later. What is
// surely a column reference is checked here: a name with an underscore (a SQL keyword that is not a
// function call rarely has one — those that do are listed), outside strings and quoted names, not a
// function (followed by "("), not a field of something (".x" / "x."), not an alias the expression
// declares itself (AS x, a lambda's x ->). Anything else — a bare word, a date part, a type — is left
// to the warehouse.
export const RAW_KEYWORDS = new Set(['current_date', 'current_time', 'current_timestamp', 'current_datetime', 'current_user', 'session_user', 'current_catalog', 'current_schema', 'current_role', 'utc_timestamp', 'utc_date']);

export function rawUnknownColumns(sql, cols) {
  const text = String(sql)
    .replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.|"")*"|`[^`]*`/g, ' ');
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

/** The type of the COLUMN one side of a comparison names (null for a constant, `now`, or an untyped column). */
export function sideType(cols, c, side) {
  const name = side === 'left' ? (c.left ? c.left.column : c.column) : c.right?.column;
  return name !== undefined ? cols.get(name)?.type || null : null;
}

// One comparison. Each side may be a column, a constant (value), or now:
//   { column, op, value }        — column vs constant (shorthand)
//   { left:{...}, op, right:{...} } — operands on both sides (column vs column,
//                                     constant vs column, etc.)
export function condPred(d, cols, c) {
  let lhs;
  if (c.left !== undefined) lhs = operandSql(d, cols, c.left, 'left');
  else if (c.column !== undefined) { requireCol(cols, c.column); lhs = d.quoteIdent(c.column); }
  else throw new Error('condition needs `column` or `left`');
  if (c.op === 'is_null') return `${lhs} IS NULL`;
  if (c.op === 'is_not_null') return `${lhs} IS NOT NULL`;
  // the column a constant is compared with, and what it is called in a refusal
  const leftType = sideType(cols, c, 'left');
  const rightType = sideType(cols, c, 'right');
  const colName = c.left ? c.left.column : c.column;
  const lit = (v, type = leftType, name = colName) => typedLiteral(type, v, `'${name}'`);
  if (c.op === 'in' || c.op === 'not_in') {
    const arr = c.right?.value ?? c.value;
    if (!Array.isArray(arr)) throw new Error(`${c.op} needs an array value`);
    return `${lhs} ${c.op === 'in' ? 'IN' : 'NOT IN'} (${arr.map((v) => lit(v)).join(', ')})`;
  }
  if (c.op === 'between') {
    const arr = c.right?.value ?? c.value;
    if (!Array.isArray(arr) || arr.length !== 2) throw new Error('between needs [low, high]');
    return `${lhs} BETWEEN ${lit(arr[0])} AND ${lit(arr[1])}`;
  }
  if (['like', 'not_like', 'contains', 'starts_with', 'ends_with'].includes(c.op)) {
    const v = c.right?.value ?? c.value;
    if (typeof v !== 'string') throw new Error(`${c.op} needs a string value`);
    const pat = c.op === 'like' || c.op === 'not_like' ? v : c.op === 'contains' ? `%${v}%` : c.op === 'starts_with' ? `${v}%` : `%${v}`;
    return `${lhs} ${c.op === 'not_like' ? 'NOT LIKE' : 'LIKE'} ${d.sqlLiteral(pat)}`;
  }
  if (!OPSYM[c.op]) throw new Error(`unsupported comparison op: ${c.op}`);
  let rhs;
  // a constant on the left compared with a column on the right is written in that column's type
  if (c.left?.value !== undefined && c.right?.column !== undefined) lhs = lit(c.left.value, rightType, c.right.column);
  if (c.right !== undefined) rhs = c.right.value !== undefined && !c.right.column ? lit(c.right.value) : operandSql(d, cols, c.right, 'right');
  else if (c.value !== undefined) rhs = lit(c.value);
  else throw new Error('condition needs `value` or `right`');
  return `${lhs} ${OPSYM[c.op]} ${rhs}`;
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

export function aggExpr(d, fn, column, q) {
  if (fn === 'count' && !column) return 'count(*)';
  const c = d.quoteIdent(column);
  if (fn === 'count_distinct') return `count(distinct ${c})`;
  if (fn === 'approx_count_distinct') return d.approxCountDistinct(c);
  if (fn === 'hll_init') return d.hllInit(c);
  if (fn === 'hll_merge') return d.hllMerge(c);
  if (fn === 'hll_merge_partial') return d.hllMergePartial(c);
  if (STAT_FNS.has(fn)) {
    if (fn === 'percentile' && !(typeof q === 'number' && q > 0 && q < 1)) throw new Error("percentile requires q in (0,1)");
    return d.statAggExpr(fn, c, q);
  }
  return `${fn}(${c})`; // sum / avg / min / max
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
    throw new Error("pipeline: '*' is not a column — a stage counts ROWS by omitting `column` ({ name, fn: 'count' }); `field: '*'` is the governed path's spelling (build_semantic_model measures)");
  }
  throw new Error(`pipeline: unknown column '${name}' at this stage (available: ${[...cols.keys()].join(', ')})`);
}

// Static type guard so a JSON/string column passed to an array op is rejected when the
// stage is ADDED (renderPipeline), not at warehouse run time. Only KNOWN-bad types fail;
// 'array' and unknown/untyped columns are allowed (benefit of the doubt for raw/native).
export function requireArrayCol(cols, name, op) {
  requireCol(cols, name);
  const t = cols.get(name)?.type;
  if (t && t !== 'array' && t !== 'unknown') {
    throw new Error(`compute ${op}: column '${name}' is '${t}', not an array — produce an array first (compute op=json_parse_array on a JSON/string column, or unnest a native array column), then ${op}.`);
  }
}
