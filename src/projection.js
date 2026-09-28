// Build a safe, read-only projection SQL over a materialized result table:
// optional WHERE, GROUP BY, aggregations and HAVING — so a caller can compress /
// re-slice the stored results from different angles without recomputing the
// underlying analytics query. No raw SQL from the caller: identifiers are
// validated, operators come from a fixed set, values are literal-escaped.

import { sqlLiteral } from './dialect.js';

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const OPS = { eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' };
const AGGS = new Set(['sum', 'avg', 'min', 'max', 'count', 'count_distinct']);

function ident(x) {
  if (!IDENT.test(String(x || ''))) throw new Error(`unsafe identifier: ${x}`);
  return x;
}

function predicate(c) {
  const col = ident(c.column);
  if (c.op === 'is_null') return `${col} is null`;
  if (c.op === 'is_not_null') return `${col} is not null`;
  if (c.op === 'in' || c.op === 'not_in') {
    const arr = Array.isArray(c.value) ? c.value : [c.value];
    return `${col} ${c.op === 'in' ? 'in' : 'not in'} (${arr.map(sqlLiteral).join(', ')})`;
  }
  if (!OPS[c.op]) throw new Error(`unsupported where op: ${c.op}`);
  return `${col} ${OPS[c.op]} ${sqlLiteral(c.value)}`;
}

function aggSql(a) {
  if (!AGGS.has(a.fn)) throw new Error(`unsupported agg: ${a.fn}`);
  // only a count may go without a column (it counts rows); every other function folds one
  if (a.fn !== 'count' && (!a.column || a.column === '*')) throw new Error(`${a.fn} needs a column to fold`);
  // a CONDITIONAL aggregate folds only the rows its `where` holds for: the value becomes NULL on
  // every other row, which every aggregate skips — sum(case when …), count(case when …) — the same
  // on every warehouse
  const cond = a.where?.length ? a.where.map(predicate).join(' and ') : null;
  const val = (expr) => (cond ? `case when ${cond} then ${expr} end` : expr);
  // count(*) counts rows; count(<column>) counts NON-NULL values of that column. Honour the
  // column when given (a `column:'*'` or no column means row count) — otherwise a NULL check via
  // { fn:'count', column } silently returns COUNT(*) and reports zero NULLs.
  if (a.fn === 'count') return (a.column && a.column !== '*') ? `count(${val(ident(a.column))})` : cond ? `count(${val('1')})` : 'count(*)';
  if (a.fn === 'count_distinct') return `count(distinct ${val(ident(a.column))})`;
  return `${a.fn}(${val(ident(a.column))})`;
}

function havingPredicate(h) {
  if (!OPS[h.op]) throw new Error(`unsupported having op: ${h.op}`);
  return `${aggSql(h)} ${OPS[h.op]} ${sqlLiteral(h.value)}`;
}

/**
 * @param relation  SQL relation expression (e.g. `{{ ref('qr_x') }}`).
 * @param t         { where[], group_by[], aggregations[{fn,column,as}], having[], order_by[{key,direction,nulls}], limit }
 */
export function buildProjection(relation, t = {}) {
  // a SECOND level (then): the same projection over this one's result — the groups it made, counted,
  // summed or filtered again (how many cycles passed the having; how many reached a step)
  if (t.then) {
    const { then, limit, ...inner } = t;
    return buildProjection(`(${buildProjection(relation, inner)}) level1`, { ...then, ...(typeof limit === 'number' ? { limit } : {}) });
  }
  const groupCols = (t.group_by || []).map(ident);
  // the default name of a row count is its function alone (`count`), never `count_*`
  const aggCols = (t.aggregations || []).map((a) => `${aggSql(a)} as ${ident(a.as || (a.column && a.column !== '*' ? `${a.fn}_${a.column}` : a.fn))}`);
  const select = [...groupCols, ...aggCols];
  let sql = `select ${select.length ? select.join(', ') : '*'} from ${relation}`;
  if (t.where?.length) sql += ` where ${t.where.map(predicate).join(' and ')}`;
  if (groupCols.length) sql += ` group by ${groupCols.join(', ')}`;
  if (t.having?.length) sql += ` having ${t.having.map(havingPredicate).join(' and ')}`;
  if (t.order_by?.length) sql += ` order by ${t.order_by.map((o) => `${ident(o.key)} ${o.direction === 'desc' ? 'desc' : 'asc'}${o.nulls === 'first' ? ' nulls first' : o.nulls === 'last' ? ' nulls last' : ''}`).join(', ')}`;
  if (typeof t.limit === 'number') sql += ` limit ${Math.trunc(t.limit)}`;
  return sql;
}

/**
 * What is wrong with a projection over a table with these columns — checked in the CALL, before a
 * task is started, so a mistake is refused with the list instead of failing in the warehouse later.
 * Empty = it can run.
 */
export function projectionProblems(t = {}, columns = null, at = '') {
  // columns null = not known: only the projection's own shape is checked
  const have = new Set(columns || []);
  const problems = [];
  const need = (c, where) => { if (columns && c && c !== '*' && !have.has(c)) problems.push(`${at}${where}: '${c}' is not a column of ${at ? 'the first level\'s result' : 'this model'}`); };
  for (const w of t.where || []) need(w.column, 'where');
  for (const g of t.group_by || []) need(g, 'group_by');
  for (const a of t.aggregations || []) { need(a.column, `aggregations.${a.fn}`); for (const w of a.where || []) need(w.column, `aggregations.${a.fn}.where`); }
  for (const h of t.having || []) { need(h.column, `having.${h.fn}`); for (const w of h.where || []) need(w.column, `having.${h.fn}.where`); }
  // what the projection returns is what it can be sorted by — and what a second level reads
  const aggregated = (t.group_by || []).length || (t.aggregations || []).length;
  const out = aggregated
    ? new Set([...(t.group_by || []), ...(t.aggregations || []).map((a) => a.as || (a.column && a.column !== '*' ? `${a.fn}_${a.column}` : a.fn))])
    : have;
  if (t.then && (t.order_by || []).length) problems.push(`${at}order_by: with a second level (then), the order is the second level's — move order_by into then`);
  else for (const o of t.order_by || []) if ((columns || aggregated) && !out.has(o.key)) problems.push(`${at}order_by: '${o.key}' is not a column of what this query returns (${[...out].join(', ')})`);
  if (t.then) {
    if (t.then.then) problems.push(`${at}then: one second level at most`);
    else problems.push(...projectionProblems(t.then, (columns || aggregated) ? [...out] : null, 'then.'));
  }
  if (!at) { try { buildProjection('x', t); } catch (e) { problems.push(e.message); } }
  return problems;
}
