// WHAT A PIPELINE STAGE IS WRITTEN WITH — the schema pieces every stage shares (an operand, a
// condition, the comparison and aggregate vocabularies), their SQL over the columns available at
// that step (an operand, a condition, a window frame, an aggregate), and the bookkeeping of those
// columns (add one, require one to exist, require an array).

import { getDialect } from '../dialects/index.js';
import { isNumericType, isTimeType } from '../dialects/base.js';
import { COMPARE_SQL, OPS, comparison, typedLiteral } from '../conditions.js';
import { form, conditionList, anyOfOr, strEnum, CONSTANT } from '../schema-kit.js';
// (compute.js imports this module too: exprSql is read when a condition is written, never as the module loads)
import { exprSql } from './compute.js';

export const NAME = '^[a-z][a-z0-9_]{0,40}$';

export const NAME_RE = /^[a-z][a-z0-9_]{0,40}$/;

export const CMP = OPS;

export const AGG_FNS = ['sum', 'average', 'min', 'max', 'count', 'count_distinct', 'approx_count_distinct', 'stddev', 'variance', 'median', 'percentile', 'hll_init', 'hll_merge', 'hll_merge_partial'];

export const SKETCH_FNS = new Set(['hll_init', 'hll_merge_partial']); // produce a sketch column

export const STAT_FNS = new Set(['stddev', 'variance', 'median', 'percentile']);

/** The functions for which the column is optional: a count counts rows without it (a sketch, like every other function, reads one). */
const COLUMN_OPTIONAL = ['count'];

/**
 * ONE MEASURE, wherever rows are aggregated — a pipeline's aggregate stage, a read's transform, a
 * semantic model: { name, agg, <key>?, percentile?, where? }, in closed forms told apart by `agg` —
 * the functions that fold a column (it is required), those for which it is optional (a count of
 * rows), those that take none, and the percentile (column and quantile required). `aggs` is what the
 * place can compute; `key` what it calls what is aggregated (a table's `column`, a source's
 * `field`) and `column` its schema; `where` the conditions a conditional measure folds the rows of;
 * `pattern` what a produced name may be; `extra` the place's own optional fields. `named: false` is
 * the measure where the place names what it produces itself (a pivot names a column per value): the
 * same forms without `name`.
 */
export function measureSchema({ aggs, column, where, description, pattern = NAME, key = 'column', optional = COLUMN_OPTIONAL, none = [], extra = {}, named = true }) {
  const name = named ? { type: 'string', pattern, description: 'The name of the column it produces.' } : undefined;
  const needs = aggs.filter((a) => a !== 'percentile' && !optional.includes(a) && !none.includes(a));
  const opt = aggs.filter((a) => optional.includes(a));
  const zero = aggs.filter((a) => none.includes(a));
  const own = Object.fromEntries(Object.entries({ name, where, ...extra }).filter(([, v]) => v !== undefined));
  const req = (...keys) => [...(named ? ['name'] : []), ...keys];
  const forms = [
    form({ title: `agg: ${needs.join(' | ')}`, tag: ['agg', needs], required: req(key), properties: { ...own, [key]: column } }),
    ...(opt.length ? [form({ title: `agg: ${opt.join(' | ')} (${key} optional)`, tag: ['agg', opt], required: req(), properties: { ...own, [key]: column } })] : []),
    ...(zero.length ? [form({ title: `agg: ${zero.join(' | ')} (no ${key})`, tag: ['agg', zero], required: req(), properties: own })] : []),
    ...(aggs.includes('percentile') ? [form({ title: 'agg: percentile', tag: ['agg', 'percentile'], required: req(key, 'percentile'), properties: { ...own, [key]: column, percentile: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1, description: 'The quantile in (0,1), e.g. 0.95 for p95.' } } })] : []),
  ];
  return { type: 'object', ...(description ? { description } : {}), anyOf: forms };
}

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

// One comparison, used identically by every where, a measure's where, a CASE branch and a funnel
// step. Its LEFT side is a column named outright (`column`) or another expression (`left`: a function,
// now, a constant — a column is written `column`); its RIGHT side a constant (`value`; a list for
// in/not_in, [low, high] for between, none for is_null/is_not_null) or an expression (`right`). Four
// closed forms, told apart by the two keys each requires, so `value` and `right` never meet.
const CMP_VALUE = { ...CONSTANT, description: 'The constant compared with: a list for in / not_in, [low, high] for between, none for is_null / is_not_null.' };
const CMP_LEFT = { ...EXPR, description: 'An expression that is not a bare column — a function ({ fn, args }), { now: true } or a constant { value }; a column is compared as { column }.' };
const CMP_RIGHT = { ...EXPR, description: 'The expression compared with — a column ({ column }), { now: true } or a function; eq … lte only. A constant compared with is `value`.' };
export const CONDITION = {
  type: 'object',
  description: 'A comparison: the left side a `column` or a `left` expression, the right side a constant `value` or a `right` expression.',
  anyOf: [
    form({ title: 'a column and a constant — { column, op, value }', required: ['column', 'op'], properties: { column: { type: 'string' }, op: { enum: CMP }, value: CMP_VALUE } }),
    form({ title: 'a column and an expression — { column, op, right }', required: ['column', 'op', 'right'], properties: { column: { type: 'string' }, op: { enum: CMP }, right: CMP_RIGHT } }),
    form({ title: 'an expression and a constant — { left, op, value }', required: ['left', 'op'], properties: { left: CMP_LEFT, op: { enum: CMP }, value: CMP_VALUE } }),
    form({ title: 'an expression and an expression — { left, op, right }', required: ['left', 'op', 'right'], properties: { left: CMP_LEFT, op: { enum: CMP }, right: CMP_RIGHT } }),
  ],
};

/** A condition whose column is written as left: { column } — the spelling a column does not take. */
export const columnAsLeft = (c) => OPS.includes(c?.op) && !!c.left && typeof c.left === 'object' && !Array.isArray(c.left) && c.left.column !== undefined && c.left.fn === undefined;

/** A condition whose constant is written as right: { value } — the spelling a constant does not take
 *  there: a constant compared with is `value`. */
export const constantAsRight = (c) => OPS.includes(c?.op) && !!c.right && typeof c.right === 'object' && !Array.isArray(c.right) && Object.hasOwn(c.right, 'value') && c.right.fn === undefined;

/** How a condition's operand written in the spelling it does not take is told its own — null when
 *  both sides are written as the closed forms write them. */
export function operandSpelling(c) {
  if (columnAsLeft(c)) return `compares the column '${c.left.column}' as left: { column } — a column is compared as { column: '${c.left.column}', op, … }: write { column } instead of left: { column } (left is for an expression: a function, now, a constant)`;
  if (constantAsRight(c)) return `compares with the constant ${JSON.stringify(c.right.value)} as right: { value } — a constant compared with is \`value\`: write value: ${JSON.stringify(c.right.value)} instead of right: { value } (right is for an expression: a column, now, a function)`;
  return null;
}

/**
 * The conditions in a request's stages that write an operand in a spelling it does not take — a
 * column as left: { column }, a constant as right: { value } — as [path, what to write] pairs. The
 * schema cannot tell those operands from another (`left` and `right` are expressions, and a column and
 * a constant are ones), so a new step is checked here before it is built: a column is `column`, a
 * constant `value`, and only a step a draft kept from an earlier version is carried over in the other
 * spelling (src/pipeline/earlier.js).
 */
export function operandsMisspelled(value, at = '') {
  const found = [];
  const walk = (x, path) => {
    if (Array.isArray(x)) { x.forEach((v, i) => walk(v, `${path}.${i}`)); return; }
    if (!x || typeof x !== 'object') return;
    const told = operandSpelling(x);
    if (told) found.push([path, told]);
    for (const [k, v] of Object.entries(x)) walk(v, path ? `${path}.${k}` : k);
  };
  walk(value, at);
  return found;
}

/**
 * ONE TYPE WORD — what a value is read or converted as: compute's cast, a JSON / array read, an
 * unnested element, a raw expression's result, a CASE's.
 */
export const TYPE = { enum: ['int', 'numeric', 'float', 'string'], description: 'The type: what cast converts to (SAFE — a value that will not convert becomes NULL rather than failing the query), what a JSON/array read, an unnested element or a raw expression yields, a CASE result.' };

/**
 * ONE SORT KEY — the order_by stage's keys, a window's over.order_by and a read's order_by: a column,
 * its direction, and where its NULLs go. An omitted `nulls` is last on every warehouse (each writes it
 * explicitly: their own defaults differ), so a top-N or a row_number over a nullable key is the same rows
 * everywhere.
 */
export const SORT_KEY = {
  type: 'object', additionalProperties: false, required: ['key'],
  properties: {
    key: { type: 'string', description: 'The column to sort by.' },
    direction: { enum: ['asc', 'desc'], description: 'asc (default) or desc.' },
    nulls: { enum: ['first', 'last'], description: 'Where NULLs go: last (default) or first — the same on every warehouse.' },
  },
};

/** Every relationship name the events sources declare — what a partition's { entity } may name. */
function relationshipNames(catalog) {
  if (!catalog?.facts) return [];
  return [...new Set(catalog.facts.flatMap((f) => Object.keys(catalog.getModel(f).entities || {})))].sort();
}

/**
 * ONE PARTITION ITEM — what a funnel's sequence and a window's rows restart per: a column available
 * here, or { entity }, a relationship the source declares, whose key column is used. A catalog whose
 * sources declare no relationship offers the column alone.
 */
export function partitionItem(catalog) {
  const rel = relationshipNames(catalog);
  return anyOfOr([
    { title: 'a column', type: 'string', description: 'A column available here.' },
    ...(rel.length ? [{
      title: '{ entity }', type: 'object', additionalProperties: false, required: ['entity'],
      description: 'A relationship the source declares — its key column is used.',
      properties: { entity: strEnum(rel) },
    }] : []),
  ]);
}

/**
 * The column a partition item names: a column as it is, or { entity } — the key column of that
 * relationship of the pipeline's source, which has to be ONE real column (a composite key, or a part
 * truncated to a grain, is an expression: the caller partitions by the columns it means). A bare name
 * that is a relationship and no column here is told to say { entity }. `where` names it in a refusal.
 */
export function partitionColumn({ catalog, source, cols }, p, where) {
  const model = catalog && source ? catalog.getModel(source) : null;
  const declared = Object.keys(model?.entities || {});
  if (p !== null && typeof p === 'object') {
    const e = model?.entities?.[p.entity];
    if (!e) throw new Error(`${where}: '${source}' declares no relationship '${p.entity}' (declared: ${declared.join(', ') || 'none'})`);
    const parts = e.key || [];
    if (parts.length !== 1 || parts[0].grain) {
      throw new Error(`${where}: relationship '${p.entity}' of '${source}' is keyed by ${parts.map((x) => x.column).join(' + ') || 'nothing'}${parts.some((x) => x.grain) ? ' (truncated to a grain)' : ''}, which is an expression, not a column — partition by the column(s) you mean`);
    }
    return parts[0].column;
  }
  const s = String(p);
  if (!cols?.has(s) && declared.includes(s)) throw new Error(`${where}: '${s}' is a RELATIONSHIP of '${source}', not a column — write { entity: '${s}' } to partition by its key column`);
  return s;
}

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

/**
 * The columns a RAW expression writes by name in its TEXT — each word spelled exactly as a column at
 * this step is named (case included, so a keyword in upper case is not a lower-case column), outside
 * strings and comments, and each name in the warehouse's own identifier quotes (`identQuote`). A
 * function call (`name(`) and a field (`.name`) are not a column. A column reaches raw SQL only as an
 * item of its `args`: one found here is refused, so the positional form holds by construction.
 */
export function rawNamedColumns(sql, cols, identQuote) {
  const src = String(sql);
  const named = [];
  const add = (c) => { if (!named.includes(c)) named.push(c); };
  // a quoted name: the identifier quotes of this warehouse, read with the comments blanked first
  const uncommented = src.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));
  for (const m of uncommented.matchAll(/'(?:[^'\\]|\\.|'')*'|"((?:[^"\\]|\\.|"")*)"|`([^`]*)`/g)) {
    const inner = m[0][0] === '"' ? m[1] : m[0][0] === '`' ? m[2] : null;
    if (inner != null && m[0][0] === identQuote && cols.has(inner)) add(inner);
  }
  // a bare word of the code
  const code = unquotedSql(src);
  for (const m of code.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    const word = m[0]; const at = m.index; const end = at + word.length;
    if (!cols.has(word) || /[0-9]/.test(code[at - 1] || '')) continue;
    if (/[.@:$]\s*$/.test(code.slice(Math.max(0, at - 2), at)) || /^\s*[(.]/.test(code.slice(end, end + 3))) continue;
    add(word);
  }
  return named;
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

/** A boolean compared with a TEXT column of the warehouse holding a flag: matched against every way
 *  text spells it (true / 1 / t, false / 0 / f), so neither STRING = BOOL in the run nor a guess at
 *  the spelling — whichever side of the condition the constant is written on. */
function textFlag(d, sql, op, value, name) {
  const values = [].concat(value);
  if (!['eq', 'neq', 'in', 'not_in'].includes(op) || !values.every((v) => typeof v === 'boolean')) {
    throw new Error(`'${name}' is a text column in the warehouse: a boolean is compared with it by eq / neq / in / not_in alone, and not mixed with other constants — or compare it with its text value (semantic_index({ request: { source, property } }) lists the values it holds)`);
  }
  const spellings = values.flatMap((v) => (v ? TEXT_TRUE : TEXT_FALSE)).map((x) => d.sqlLiteral(x));
  return `LOWER(TRIM(${sql})) ${op === 'neq' || op === 'not_in' ? 'NOT IN' : 'IN'} (${spellings.join(', ')})`;
}
const isTextFlag = (side, value) => side.physical && side.type === 'string' && [].concat(value).some((v) => typeof v === 'boolean');

// One comparison, in the four closed forms of CONDITION:
//   { column, op, value? }  — a column vs a constant
//   { column, op, right }   — a column vs an expression (a column, now, a function)
//   { left, op, value? }    — an expression vs a constant
//   { left, op, right }     — an expression vs an expression (a constant on the left, a column on the right, …)
/** One condition's SQL. `opts` passes on to the expressions it compares (src/pipeline/compute.js exprSql:
 *  a where's condition takes no window function). */
export function condPred(d, cols, c, opts = {}) {
  // the left side: a column named outright, or an expression — with the type its constants are written in
  // (a column is `column`, and the right side a constant or an expression, never both: the closed forms
  // of CONDITION, held here too for a condition that did not come through the schema)
  const misspelled = operandSpelling(c);
  if (misspelled) throw new Error(`a condition ${misspelled}`);
  if (c.value !== undefined && c.right !== undefined) throw new Error('a condition compares with a constant (`value`) or with an expression (`right`), not both');
  let left;
  if (c.left !== undefined) left = exprSql(d, cols, c.left, 'left', opts);
  else if (c.column !== undefined) { requireCol(cols, c.column); left = { sql: d.quoteIdent(c.column), type: cols.get(c.column)?.type || null, physical: !!cols.get(c.column)?.physical }; }
  else throw new Error('condition needs `column` or `left`');
  const name = c.column ?? c.left?.column ?? 'the left side';
  const right = c.right;
  // a constant on the right (`value`) — the one comparison writer, in the left side's type
  if (right === undefined) {
    const value = c.value;
    if (value === undefined && c.op !== 'is_null' && c.op !== 'is_not_null') throw new Error('condition needs `value` or `right`');
    if (isTextFlag(left, value)) return textFlag(d, left.sql, c.op, value, name);
    return comparison(left.sql, c.op, value, { lit: (v) => typedLiteral(left.type, v, `'${name}'`) });
  }
  // an expression on the right (a column, now, a function): a plain comparison of the two
  if (!OPSYM[c.op]) throw new Error(`'${c.op}' compares with a constant (value), not with an expression`);
  const r = exprSql(d, cols, right, 'right', opts);
  // a constant on the left compared with a column on the right is written in that column's type
  if (c.left && Object.hasOwn(c.left, 'value') && c.left.fn === undefined) {
    const rname = `${right.column ?? 'the right side'}`;
    if (isTextFlag(r, c.left.value)) return textFlag(d, r.sql, c.op, c.left.value, rname);
    return `${typedLiteral(r.type, c.left.value, `'${rname}'`)} ${OPSYM[c.op]} ${r.sql}`;
  }
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
  // (the schema asks for it; a step kept from an earlier version is told so here, not by the identifier guard)
  if (!column) throw new Error(`pipeline: a measure with agg '${fn}' needs \`column\` — only a count counts rows without one`);
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
  // '*' is SQL's spelling for "the rows themselves"; here every measure counts rows by leaving its column out.
  // A stage counts rows by leaving `column` out entirely, so say that instead of listing every
  // column and leaving the caller to guess what a SQL habit translates to here.
  if (name === '*') {
    throw new Error("pipeline: '*' is not a column — a measure counts ROWS by leaving `column` out ({ name, agg: 'count' })");
  }
  throw new Error(`pipeline: unknown column '${name}' at this stage (available: ${[...cols.keys()].join(', ')})`);
}

