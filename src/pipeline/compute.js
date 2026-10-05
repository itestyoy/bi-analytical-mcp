// THE COMPUTE STAGE'S EXPRESSIONS — one table: each function's arguments, its parameters and its SQL.
// An expression is a column ({ column }), a constant ({ value }), the current time ({ now: true }) or a
// function over expressions ({ fn, args: [...], ...its parameters }), nested to any depth — so a
// computed column is one stage however many steps its formula has, and the same expression is what a
// condition compares (src/pipeline/sql.js CONDITION). The schema ($defs.expr: one form per function
// shape) and the build (exprSql) both read FNS, so a function is added in one place — and a parameter
// a function does not read is not in its form, so it is refused instead of silently ignored.

import { GRAINS } from '../catalog.js';
// (sql.js imports this module too: what is read from it here is read when a function runs, never as
// the module loads)
import { isNumericType, isTimeType } from '../dialects/base.js';
import { rawUnknownColumns, rawReservedColumns, unquotedSql, condPred, frameClause, requireCol, sqlAgg, EXPR, CONDITIONS } from './sql.js';
import { conditionsSql, eachCondition } from '../conditions.js';
import { form, SCALAR } from '../schema-kit.js';

const ORDER = { type: 'array', items: { type: 'object', additionalProperties: false, required: ['key'], properties: { key: { type: 'string' }, direction: { enum: ['asc', 'desc'] } } }, description: 'Window ordering.' };
const PARTITION = { type: 'array', uniqueItems: true, items: { type: 'string' }, description: 'Window partition columns. LEAVING IT OUT MAKES ONE GLOBAL WINDOW over every row, which one worker has to hold: on a large table that is how a query runs out of memory ("Resources exceeded during query execution"). A window is for a value computed WITHIN a group (per player, per day, per session) — for a table-wide number use an aggregate stage with no group_by (one row) and apply it as a literal afterwards.' };
// a frame bound: an offset, or the edge of the partition
const BOUND = { anyOf: [{ type: 'integer', minimum: 0, title: 'an offset' }, { const: 'unbounded', title: '"unbounded"' }] };
const FRAME = {
  type: 'object', additionalProperties: false,
  description: 'Window frame. ROWS = physical row offsets; RANGE = value offsets on the ORDER BY key (for a rolling N-DAY window, order by a unix_date column and use range with preceding:N). Omit for the default frame.',
  properties: {
    mode: { enum: ['rows', 'range'], description: 'rows = physical rows; range = value-based on the order key.' },
    preceding: { ...BOUND, description: 'Lower bound: a row (or value) offset, or "unbounded" (default unbounded).' },
    following: { ...BOUND, description: 'Upper bound: an offset, "unbounded", or 0/omitted = CURRENT ROW.' },
  },
};

// the parameters a function may take, by name — each function's form picks its own
const params = () => ({
  places: { type: 'integer', minimum: 0, maximum: 12, description: 'Decimal places (default 0).' },
  type: { enum: ['int', 'numeric', 'float', 'string'], description: 'The type: what cast converts to (SAFE — a value that will not convert becomes NULL rather than failing the query), what a JSON/array read or a raw expression yields, a CASE result.' },
  start: { type: 'integer', minimum: 1, description: '1-based start position.' },
  len: { type: 'integer', minimum: 0, description: 'Length in characters (optional).' },
  search: { type: 'string', description: 'Substring to find.' },
  replacement: { type: 'string', description: 'What replaces it.' },
  field: { type: 'string', description: 'The field of a JSON OBJECT to read — an unnested array-of-struct element, or a flattened payload column that holds JSON (e.g. a crash report\'s custom keys).' },
  index: { type: 'integer', minimum: 1, description: '1-based index.' },
  unit: { enum: ['day', 'hour', 'minute', 'second'], description: 'The unit of the difference.' },
  grain: { enum: GRAINS, description: 'The time bucket to truncate to.' },
  part: { enum: ['dow', 'hour', 'day', 'week', 'month', 'quarter', 'year', 'doy'], description: 'The date part to extract.' },
  clamp_zero: { type: 'boolean', description: 'Fold negative (before the start) and NULL (e.g. a missing install_date) results to 0, so it is a clean day 0+. Default true; false for the raw signed/NULL-able value.' },
  sql: { type: 'string', description: 'Raw dialect SQL over existing columns — the escape hatch when no function fits (e.g. array indexing, a dialect function). Not portable across dialects. It reads only the columns available at this step: a name it uses that is not one of them is refused when the step is added.' },
  cases: { type: 'array', minItems: 1, description: 'CASE branches (the first that holds wins); each `when` is a list of conditions that all hold (an item may be an { or: [...] } group), `then` an expression.', items: { type: 'object', additionalProperties: false, required: ['when', 'then'], properties: { when: CONDITIONS('The conditions this branch takes: all of them hold.'), then: EXPR } } },
  else: { ...EXPR, description: 'The value when no branch holds (default NULL).' },
  offset: { type: 'integer', minimum: 1, description: 'Row offset (default 1).' },
  default: { ...SCALAR, description: 'The constant when the offset row does not exist.' },
  over: { type: 'object', additionalProperties: false, description: 'The window: the rows it is computed over, in order.', properties: { partition_by: PARTITION, order_by: ORDER } },
  over_frame: { type: 'object', additionalProperties: false, description: 'The window: the rows it is computed over, in order, and the frame of them each value reads.', properties: { partition_by: PARTITION, order_by: ORDER, frame: FRAME } },
});

// a window clause in raw SQL, outside its string literals, quoted names and comments
const RAW_OVER = /\bover\s*\(/i;

/** The type of a value picked from several (coalesce, least, greatest): the one its typed arguments
 *  share; numbers of any kind are numeric, moments of any kind a time; arguments of kinds that do not
 *  meet are 'unknown' (compared as written); with no typed argument, `fallback`. An untyped constant
 *  (null) says nothing. */
function commonType(types, fallback) {
  const typed = [...new Set(types.filter((t) => t && t !== 'unknown'))];
  if (!typed.length) return fallback;
  if (typed.length === 1) return typed[0];
  if (typed.every(isNumericType)) return 'numeric';
  if (typed.every(isTimeType)) return 'time';
  return 'unknown';
}

const one = (fn, type) => ({ args: 1, sql: ({ a }) => ({ expr: `${fn}(${a[0]})`, type }) });
const arith = (sym) => ({ args: 2, sql: ({ a }) => ({ expr: sym === '/' ? `(${a[0]} / NULLIF(${a[1]}, 0))` : `(${a[0]} ${sym} ${a[1]})` }) });
// An array function's argument is checked when the stage is ADDED, not at warehouse run time: only a
// KNOWN non-array type fails — an array, or a column whose type is unknown (raw, native), passes.
const ARRAY_TYPES = new Set(['array', 'unknown', undefined, null]);
const needsArray = (fn, t) => { if (!ARRAY_TYPES.has(t)) throw new Error(`${fn}: its argument is '${t}', not an array — produce an array first (json_parse_array on a JSON/string column, or unnest a native array column)`); };

/** The window clause of a window function: OVER (PARTITION BY … ORDER BY … frame). */
function overSql(d, cols, over = {}, { frame = false } = {}) {
  (over.partition_by || []).forEach((c) => requireCol(cols, c));
  (over.order_by || []).forEach((o) => requireCol(cols, o.key));
  const parts = (over.partition_by || []).map((c) => d.quoteIdent(c));
  const ords = (over.order_by || []).map((o) => `${d.quoteIdent(o.key)}${o.direction === 'desc' ? ' DESC' : ''}`);
  const f = frame ? frameClause(over.frame) : '';
  if (f && !ords.length) throw new Error('a window frame requires order_by');
  return `OVER (${[parts.length ? `PARTITION BY ${parts.join(', ')}` : '', ords.length ? `ORDER BY ${ords.join(', ')}` : ''].filter(Boolean).join(' ')}${f})`;
}

/**
 * Every function, by name: how many `args` it takes (a number, or { min } for a list), the
 * parameters it requires (`needs`) and may take (`may`), and its SQL over the rendered arguments `a`
 * (with their types `t`) → { expr, type } (type 'numeric' when it is not said). `title` says what
 * the arguments are when their order matters.
 */
export const FNS = {
  add: { ...arith('+'), title: '[left, right]' },
  sub: { ...arith('-'), title: '[left, right]' },
  mul: { ...arith('*'), title: '[left, right]' },
  div: { ...arith('/'), title: '[left, right]' },
  round: { args: 1, may: ['places'], sql: ({ d, a, p }) => ({ expr: d.roundExpr(a[0], p.places ?? 0) }) },
  floor: one('floor'),
  ceil: one('ceil'),
  abs: one('abs'),
  upper: one('upper', 'string'),
  lower: one('lower', 'string'),
  length: one('length', 'int'),
  trim: one('trim', 'string'),
  unix_date: { args: 1, sql: ({ d, a }) => ({ expr: d.unixDateExpr(a[0]), type: 'int' }) },
  hll_extract: { args: 1, sql: ({ d, a }) => ({ expr: d.hllExtract(a[0]), type: 'int' }) },
  json_parse_array: { args: 1, sql: ({ d, a }) => ({ expr: d.jsonParseArray(a[0]), type: 'array' }) }, // STRING JSON array → native array (then unnest)
  coalesce: { args: { min: 2 }, sql: ({ a, t }) => ({ expr: `coalesce(${a.join(', ')})`, type: commonType(t, 'string') }) },
  least: { args: { min: 2 }, sql: ({ a, t }) => ({ expr: `least(${a.join(', ')})`, type: commonType(t, 'numeric') }) },
  greatest: { args: { min: 2 }, sql: ({ a, t }) => ({ expr: `greatest(${a.join(', ')})`, type: commonType(t, 'numeric') }) },
  concat: { args: { min: 1 }, sql: ({ a }) => ({ expr: `concat(${a.join(', ')})`, type: 'string' }) },
  cast: { args: 1, needs: ['type'], sql: ({ d, a, p }) => ({ expr: d.castExpr(a[0], p.type), type: p.type }) },
  substring: { args: 1, needs: ['start'], may: ['len'], sql: ({ d, a, p }) => ({ expr: d.substringExpr(a[0], p.start, p.len), type: 'string' }) },
  replace: { args: 1, needs: ['search', 'replacement'], sql: ({ d, a, p }) => ({ expr: `replace(${a[0]}, ${d.sqlLiteral(p.search)}, ${d.sqlLiteral(p.replacement)})`, type: 'string' }) },
  // An unnested struct element is already JSON-typed; a flattened payload column holding JSON is
  // TEXT and has to be parsed first, or the json operators do not apply to it.
  json_field: { args: 1, needs: ['field'], may: ['type'], sql: ({ d, a, t, p }) => ({ expr: t[0] === 'json' ? d.jsonColumnField(a[0], p.field, p.type) : d.jsonColumnStructField(a[0], p.field, p.type), type: p.type || 'string' }) },
  element_at: { args: 1, needs: ['index'], may: ['type'], sql: ({ d, a, t, p }) => { needsArray('element_at', t[0]); return { expr: d.arrayElementAt(a[0], p.index), type: p.type || 'string' }; } },
  array_last: { args: 1, may: ['type'], sql: ({ d, a, t, p }) => { needsArray('array_last', t[0]); return { expr: d.arrayLast(a[0]), type: p.type || 'string' }; } },
  date_diff: { args: 2, title: '[from, to]', needs: ['unit'], sql: ({ d, a, p }) => ({ expr: d.dateDiff(p.unit, a[0], a[1]), type: p.unit === 'day' ? 'int' : 'numeric' }) },
  date_trunc: { args: 1, needs: ['grain'], sql: ({ d, a, p }) => ({ expr: d.dateTrunc(p.grain, a[0]), type: 'time' }) },
  date_part: { args: 1, needs: ['part'], sql: ({ d, a, p }) => ({ expr: d.datePart(p.part, a[0]), type: 'int' }) },
  // Whole 24-HOUR days between `from` and `to` (retention-day) — floor of the span in 24h buckets,
  // NOT calendar days. Default clamp_zero folds negatives (pre-`from` events) AND NULLs (e.g. a
  // missing install_date on a left join) to 0, so the result is a clean day 0+.
  elapsed_days: {
    args: 2, title: '[from, to]', may: ['clamp_zero'],
    sql: ({ d, a, p }) => {
      const inner = d.fullDaysBetween(a[0], a[1]);
      return { expr: p.clamp_zero === false ? inner : `COALESCE(GREATEST(${inner}, 0), 0)`, type: 'int' };
    },
  },
  case: {
    args: 0, needs: ['cases'], may: ['else', 'type'],
    sql: ({ d, cols, p, sub, opts }) => {
      const branches = p.cases.map((cs) => `WHEN ${conditionsSql(cs.when, (c) => condPred(d, cols, c, opts)).join(' AND ')} THEN ${sub(cs.then, 'then').sql}`);
      return { expr: `CASE ${branches.join(' ')}${p.else !== undefined ? ` ELSE ${sub(p.else, 'else').sql}` : ''} END`, type: p.type || 'string' };
    },
  },
  // escape hatch: verbatim dialect SQL — over columns that exist at this point
  raw: {
    args: 0, needs: ['sql'], may: ['type'],
    sql: ({ d, cols, p, opts }) => {
      // a raw window is still a window: where SQL takes none, it is refused as the structured one is
      if (opts.windows === false && RAW_OVER.test(unquotedSql(p.sql))) throw new Error('a raw expression with OVER (…) is a window function, and a where cannot compare one — a where keeps rows before any window is computed. Compute it into a column first (a compute stage), then filter on that column');
      if (opts.inWindow && RAW_OVER.test(unquotedSql(p.sql))) throw new Error('a raw expression with OVER (…) is a window function, and it cannot be an argument of another window function — compute it into a column first (a compute stage), then use that column');
      const unknown = rawUnknownColumns(p.sql, cols);
      if (unknown.length) throw new Error(`pipeline: a raw expression names ${unknown.map((n) => `'${n}'`).join(', ')}, not ${unknown.length === 1 ? 'a column' : 'columns'} at this stage (available: ${[...cols.keys()].join(', ')}) — a raw expression reads the columns the steps before it produced`);
      const reserved = rawReservedColumns(p.sql, cols, d.reservedWords);
      if (reserved.length) throw new Error(`pipeline: a raw expression names ${reserved.map((n) => `'${n}'`).join(', ')} bare, and ${reserved.length === 1 ? 'that is a reserved word' : 'those are reserved words'} of ${d.name} SQL — it would be read as a keyword and the run fails. Quote ${reserved.length === 1 ? 'it' : 'them'} in the raw SQL: ${reserved.map((n) => d.quoteIdent(n)).join(', ')} (every other stage quotes a column itself)`);
      return { expr: `(${p.sql})`, type: p.type || 'string' };
    },
  },
  // window functions: each over its `over` — the rank of a row, the value of a neighbour, an aggregate of a frame
  row_number: { args: 0, needs: ['over'], window: true, sql: ({ d, cols, p }) => ({ expr: `row_number() ${overSql(d, cols, p.over)}`, type: 'int' }) },
  rank: { args: 0, needs: ['over'], window: true, sql: ({ d, cols, p }) => ({ expr: `rank() ${overSql(d, cols, p.over)}`, type: 'int' }) },
  dense_rank: { args: 0, needs: ['over'], window: true, sql: ({ d, cols, p }) => ({ expr: `dense_rank() ${overSql(d, cols, p.over)}`, type: 'int' }) },
  lag: { args: 1, needs: ['over'], may: ['offset', 'default'], window: true, sql: ({ d, cols, a, t, p }) => ({ expr: `lag(${a[0]}, ${p.offset ?? 1}${p.default !== undefined ? `, ${d.sqlLiteral(p.default)}` : ''}) ${overSql(d, cols, p.over)}`, type: t[0] || 'unknown' }) },
  lead: { args: 1, needs: ['over'], may: ['offset', 'default'], window: true, sql: ({ d, cols, a, t, p }) => ({ expr: `lead(${a[0]}, ${p.offset ?? 1}${p.default !== undefined ? `, ${d.sqlLiteral(p.default)}` : ''}) ${overSql(d, cols, p.over)}`, type: t[0] || 'unknown' }) },
  ...Object.fromEntries(['sum', 'average', 'min', 'max'].map((fn) => [fn, {
    args: 1, needs: ['over_frame'], window: true,
    sql: ({ d, cols, a, t, p }) => ({ expr: `${sqlAgg(fn)}(${a[0]}) ${overSql(d, cols, p.over, { frame: true })}`, type: ['min', 'max'].includes(fn) ? (t[0] || 'unknown') : 'numeric' }),
  }])),
  // a count of the rows (no argument) or of the non-NULL values of one
  count: { args: { min: 0, max: 1 }, needs: ['over_frame'], window: true, sql: ({ d, cols, a, p }) => ({ expr: `count(${a.length ? a[0] : '*'}) ${overSql(d, cols, p.over, { frame: true })}`, type: 'int' }) },
};

/** The parameter a function's spec names, as the caller writes it (`over_frame` is written `over`). */
const written = (name) => (name === 'over_frame' ? 'over' : name);

/**
 * The expression's SQL and type over the columns at this step. `at` names it in a refusal. `opts`:
 * `windows: false` where SQL takes no window function (a where condition — it filters rows before
 * any window is computed), `inWindow` inside a window function's own arguments (SQL nests none).
 */
export function exprSql(d, cols, e, at = 'expression', opts = {}) {
  if (e === null || typeof e !== 'object' || Array.isArray(e)) throw new Error(`${at}: must be { column } | { value } | { now: true } | { fn, … }`);
  if (e.column !== undefined) { requireCol(cols, e.column); return { sql: d.quoteIdent(e.column), type: cols.get(e.column)?.type || null }; }
  if (e.now) return { sql: d.nowExpr(), type: 'time' };
  if (e.fn === undefined) {
    if (!Object.hasOwn(e, 'value')) throw new Error(`${at}: needs column | value | now | fn`);
    const v = e.value;
    // a list is a condition's constant (in / not_in / between: its `value`), never a value of its own
    if (Array.isArray(v) || (v !== null && typeof v === 'object')) throw new Error(`${at}: a constant is a string, a number, a boolean or null — a list belongs in a condition's \`value\` (in / not_in / between)`);
    return { sql: d.sqlLiteral(v), type: typeof v === 'number' ? 'numeric' : typeof v === 'boolean' ? 'boolean' : v === null ? null : 'string' };
  }
  const spec = Object.hasOwn(FNS, e.fn) ? FNS[e.fn] : null;
  if (!spec) throw new Error(`${at}: unknown function '${e.fn}' (known: ${Object.keys(FNS).join(', ')})`);
  const args = e.args || [];
  const { min, max } = typeof spec.args === 'number' ? { min: spec.args, max: spec.args } : { min: spec.args.min, max: spec.args.max ?? Infinity };
  if (args.length < min || args.length > max) throw new Error(`${at}: ${e.fn} takes ${min === max ? min : max === Infinity ? `at least ${min}` : `${min} to ${max}`} argument${max === 1 ? '' : 's'}${spec.title ? ` ${spec.title}` : ''}, not ${args.length}`);
  for (const n of spec.needs || []) if (e[written(n)] === undefined) throw new Error(`${at}: ${e.fn} needs \`${written(n)}\``);
  if (spec.window && opts.windows === false) throw new Error(`${at}: a window function (${e.fn}) cannot be compared in a where — a where keeps rows before any window is computed. Compute it into a column first (a compute stage), then filter on that column`);
  if (spec.window && opts.inWindow) throw new Error(`${at}: a window function (${e.fn}) cannot be an argument of another window function — compute the inner one into a column first (a compute stage), then use that column`);
  const inner = spec.window ? { ...opts, inWindow: true } : opts;
  const rendered = args.map((x, i) => exprSql(d, cols, x, `${at} ${e.fn} args[${i}]`, inner));
  const out = spec.sql({ d, cols, p: e, opts: inner, a: rendered.map((r) => r.sql), t: rendered.map((r) => r.type), sub: (x, what) => exprSql(d, cols, x, `${at} ${e.fn} ${what}`, inner) });
  return { sql: out.expr, type: out.type || 'numeric' };
}

/** Every function an expression calls, nested ones included — in arguments, a CASE's branches and
 *  the conditions they test (to find a window, a raw SQL). */
export function exprCalls(e, out = []) {
  if (!e || typeof e !== 'object') return out;
  if (e.fn !== undefined) {
    out.push(e);
    for (const x of e.args || []) exprCalls(x, out);
    for (const cs of e.cases || []) {
      conditionCalls(cs.when, out);
      exprCalls(cs.then, out);
    }
    if (e.else) exprCalls(e.else, out);
  }
  return out;
}

/** Every function the expressions of a list of conditions call (their left and right sides). */
export function conditionCalls(list, out = []) {
  eachCondition(list, (c) => { exprCalls(c.left, out); exprCalls(c.right, out); });
  return out;
}

/**
 * The expression's schema — $defs.expr, recursive through its arguments: the three leaves, and one
 * form per function SHAPE (the functions that take the same arguments and parameters share a form,
 * tagged by all of them), each with exactly its own fields.
 */
export function exprSchema() {
  const PARAMS = params();
  const byShape = new Map();
  for (const [fn, s] of Object.entries(FNS)) {
    const shape = { args: s.args, title: s.title || null, needs: s.needs || [], may: s.may || [] };
    const key = JSON.stringify(shape);
    if (!byShape.has(key)) byShape.set(key, { ...shape, fns: [] });
    byShape.get(key).fns.push(fn);
  }
  const argsOf = (n) => {
    const { min, max } = typeof n === 'number' ? { min: n, max: n } : { min: n.min, max: n.max };
    return { type: 'array', minItems: min, ...(max !== undefined ? { maxItems: max } : {}), items: EXPR };
  };
  const forms = [...byShape.values()].map(({ args, title, needs, may, fns }) => {
    const takesArgs = args !== 0;
    const required = typeof args === 'number' ? args > 0 : args.min > 0;
    const fields = Object.fromEntries([...needs, ...may].map((n) => [written(n), PARAMS[n]]));
    return form({
      title: `fn: ${fns.join(' | ')}${title ? ` — args ${title}` : ''}`,
      tag: ['fn', fns],
      required: [...(takesArgs && required ? ['args'] : []), ...needs.map(written)],
      properties: { ...(takesArgs ? { args: argsOf(args) } : {}), ...fields },
    });
  });
  return {
    type: 'object',
    description: 'An expression: { column }, a constant { value }, the current time { now: true }, or a function { fn, args: [expressions], …its parameters } — arguments are expressions themselves, so a formula nests in one place (e.g. round((a - b) / b, 2): { fn: "round", args: [{ fn: "div", args: [{ fn: "sub", args: [{ column: "a" }, { column: "b" }] }, { column: "b" }] }], places: 2 }). Window functions (row_number, rank, dense_rank, lag, lead, and sum / average / count / min / max of a frame) take `over`. raw is the escape hatch: dialect SQL in `sql`.',
    anyOf: [
      form({ title: 'a column', required: ['column'], properties: { column: { type: 'string' } } }),
      form({ title: 'a constant', required: ['value'], properties: { value: SCALAR } }),
      form({ title: 'the current time', required: ['now'], properties: { now: { const: true } } }),
      ...forms,
    ],
  };
}
