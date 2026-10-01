// ONE COMPARISON — `<lhs> <op> <constant(s)>` — written the same way wherever the server writes one:
// a pipeline stage's condition, a funnel step's and its prefilter, a semantic measure's scope, a
// MetricFlow where, a read's projection, a scan's window. The left side is whatever the caller has
// already made safe (a quoted column, a JSON read, a Jinja Dimension); this module only chooses the
// operator's SQL and writes the constants, through the dialect's one literal writer. What the
// constant's TYPE should be is the other half of the rule, typedLiteral below, used where the type
// of what is compared is known.

import { sqlLiteral } from './dialects/base.js';

/** The comparison operators, as the tools spell them → SQL. */
export const COMPARE_SQL = { eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' };

/** A text pattern operator → the LIKE pattern of its constant. */
const PATTERN = { like: (v) => v, not_like: (v) => v, contains: (v) => `%${v}%`, starts_with: (v) => `${v}%`, ends_with: (v) => `%${v}` };

/** EVERY operator a condition takes — one vocabulary, the same in every place a condition is written. */
export const OPS = [...Object.keys(COMPARE_SQL), 'in', 'not_in', 'between', 'is_null', 'is_not_null', ...Object.keys(PATTERN)];

/**
 * A list of conditions (src/schema-kit.js conditionList) → one SQL per item, all of which hold: a
 * condition is written by `leaf`, { or: [...] } / { and: [...] } around their items.
 */
export function conditionsSql(list, leaf) {
  const one = (c) => (c.or ? `(${c.or.map(one).join(' OR ')})` : c.and ? `(${c.and.map(one).join(' AND ')})` : leaf(c));
  return (list || []).map(one);
}

/** The same list with each condition replaced by `fn(condition)` — its groups kept as they are. */
export function mapConditions(list, fn) {
  const one = (c) => (c.or ? { or: c.or.map(one) } : c.and ? { and: c.and.map(one) } : fn(c));
  return (list || []).map(one);
}

/** Every condition of a list, groups opened (to check or resolve what each one names). */
export function eachCondition(list, fn) {
  for (const c of list || []) {
    if (c.or) eachCondition(c.or, fn);
    else if (c.and) eachCondition(c.and, fn);
    else fn(c);
  }
}

/**
 * `lhs op value` → SQL. `op`: eq | neq | gt | gte | lt | lte, in | not_in (a list, or one value),
 * between ([low, high]), is_null | is_not_null, like | not_like | contains | starts_with | ends_with
 * (a string). `lit` writes one constant (sqlLiteral unless the
 * caller binds a type to it — typedLiteral); an operator outside this set is refused.
 */
export function comparison(lhs, op, value, { lit = sqlLiteral } = {}) {
  if (op === 'is_null') return `${lhs} IS NULL`;
  if (op === 'is_not_null') return `${lhs} IS NOT NULL`;
  if (op === 'in' || op === 'not_in') {
    const list = Array.isArray(value) ? value : [value];
    return `${lhs} ${op === 'in' ? 'IN' : 'NOT IN'} (${list.map((v) => lit(v)).join(', ')})`;
  }
  if (op === 'between') {
    if (!Array.isArray(value) || value.length !== 2) throw new Error("'between' needs value: [low, high]");
    return `${lhs} BETWEEN ${lit(value[0])} AND ${lit(value[1])}`;
  }
  // a pattern is text whatever the column is: written as a string, never typed to the column
  if (PATTERN[op]) {
    if (typeof value !== 'string') throw new Error(`${op} needs a string value`);
    return `${lhs} ${op === 'not_like' ? 'NOT LIKE' : 'LIKE'} ${sqlLiteral(PATTERN[op](value))}`;
  }
  if (!COMPARE_SQL[op]) throw new Error(`unsupported comparison op: ${op}`);
  return `${lhs} ${COMPARE_SQL[op]} ${lit(value)}`;
}

// A constant compared with a column of a KNOWN type is written in that type. A warehouse compares a
// value only with its own type — BigQuery refuses BOOL = STRING and INT64 = STRING outright — and the
// caller often spells a flag "true" or a number "5". So a boolean column takes true / false (written
// either way, or 1 / 0) and a numeric one a number (or a numeric string); anything else is refused
// HERE, when the stage is added, rather than by the warehouse when it runs. A column typed 'string'
// is left as it is: that is also the type of what nothing more is known about.
const BOOL_TEXT = new Map([['true', true], ['false', false], ['1', true], ['0', false]]);
const NUMERIC_TYPES = new Set(['numeric', 'int', 'integer', 'float']);

/** A constant as a literal of `type` (the compared column's; null for unknown). `where` names it in a refusal. */
export function typedLiteral(type, v, where) {
  if (v === null) return sqlLiteral(v);
  if (type === 'boolean') {
    const b = typeof v === 'boolean' ? v : typeof v === 'number' && (v === 0 || v === 1) ? v === 1 : typeof v === 'string' ? BOOL_TEXT.get(v.trim().toLowerCase()) : undefined;
    if (b === undefined) throw new Error(`${where} is a boolean column: compare it with true or false, not ${JSON.stringify(v)}`);
    return sqlLiteral(b);
  }
  if (NUMERIC_TYPES.has(type)) {
    if (typeof v === 'number') return sqlLiteral(v);
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return sqlLiteral(Number(v));
    throw new Error(`${where} is a numeric column: compare it with a number, not ${JSON.stringify(v)}`);
  }
  return sqlLiteral(v);
}

/** The literal writer for constants compared with a column of `type`, named `name` in a refusal. */
export const typedAs = (type, name) => (v) => typedLiteral(type, v, `'${name}'`);
