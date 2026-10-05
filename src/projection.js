// Build a safe, read-only projection SQL over a materialized result table:
// optional WHERE, GROUP BY, aggregations and HAVING — so a caller can compress /
// re-slice the stored results from different angles without recomputing the
// underlying analytics query. No raw SQL from the caller: identifiers are
// validated and QUOTED by the warehouse's dialect (a column may be named with a
// reserved word — rows, current, new), operators come from a fixed set, values
// are literal-escaped.

import { comparison, conditionsSql, eachCondition } from './conditions.js';

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
/** The aggregations a projection (a read's transform, a drill-down) takes — the one list its schema offers. */
export const AGGS = new Set(['sum', 'average', 'min', 'max', 'count', 'count_distinct', 'stddev', 'variance']);
// the sample statistics, as a pipeline's aggregate stage computes them (both warehouses spell them so)
const SQL_FN = { average: 'avg', stddev: 'stddev_samp', variance: 'var_samp' };
/** The column an aggregation produces: its own name, else <agg>_<column> (the function alone for a row count). */
export const aggName = (a) => a.name || (a.column ? `${a.agg}_${a.column}` : a.agg);

function ident(x) {
  if (!IDENT.test(String(x || ''))) throw new Error(`unsafe identifier: ${x}`);
  return x;
}

/** The SQL of one projection, its identifiers written by `q` (the dialect's quoteIdent). */
function writer(q) {
  const col = (x) => q(ident(x));
  const predicate = (c) => comparison(col(c.column), c.op, c.value);
  const aggSql = (a) => {
    if (!AGGS.has(a.agg)) throw new Error(`unsupported agg: ${a.agg}`);
    // only a count may go without a column (it counts rows); every other function folds one
    if (a.agg !== 'count' && !a.column) throw new Error(`${a.agg} needs a column to fold`);
    // a CONDITIONAL aggregate folds only the rows its `where` holds for: the value becomes NULL on
    // every other row, which every aggregate skips — sum(case when …), count(case when …) — the same
    // on every warehouse
    const cond = a.where?.length ? conditionsSql(a.where, predicate).join(' and ') : null;
    const val = (expr) => (cond ? `case when ${cond} then ${expr} end` : expr);
    // count(*) counts rows; count(<column>) counts NON-NULL values of that column. Honour the
    // column when given (no column means row count) — otherwise a NULL check via
    // { agg:'count', column } silently returns COUNT(*) and reports zero NULLs.
    if (a.agg === 'count') return a.column ? `count(${val(col(a.column))})` : cond ? `count(${val('1')})` : 'count(*)';
    if (a.agg === 'count_distinct') return `count(distinct ${val(col(a.column))})`;
    return `${SQL_FN[a.agg] || a.agg}(${val(col(a.column))})`;
  };
  const havingPredicate = (h) => comparison(aggSql(h), h.op, h.value);
  return { col, predicate, aggSql, havingPredicate };
}

/**
 * @param relation  SQL relation expression (e.g. `{{ ref('qr_x') }}`).
 * @param t         { where[], group_by[], aggregations[{agg,column,name}], having[], order_by[{key,direction,nulls}], limit }
 * @param quote     the warehouse's quoteIdent (getDialect(..).quoteIdent) — every name is written quoted
 */
export function buildProjection(relation, t = {}, quote) {
  if (typeof quote !== 'function') throw new Error('buildProjection needs the dialect\'s quoteIdent');
  // a SECOND level (then): the same projection over this one's result — the groups it made, counted,
  // summed or filtered again (how many cycles passed the having; how many reached a step)
  if (t.then) {
    const { then, limit, ...inner } = t;
    return buildProjection(`(${buildProjection(relation, inner, quote)}) level1`, { ...then, ...(typeof limit === 'number' ? { limit } : {}) }, quote);
  }
  const { col, predicate, aggSql, havingPredicate } = writer(quote);
  const groupCols = (t.group_by || []).map(col);
  // the default name of a row count is its function alone (`count`), never `count_*`
  const aggCols = (t.aggregations || []).map((a) => `${aggSql(a)} as ${col(aggName(a))}`);
  const select = [...groupCols, ...aggCols];
  let sql = `select ${select.length ? select.join(', ') : '*'} from ${relation}`;
  if (t.where?.length) sql += ` where ${conditionsSql(t.where, predicate).join(' and ')}`;
  if (groupCols.length) sql += ` group by ${groupCols.join(', ')}`;
  if (t.having?.length) sql += ` having ${conditionsSql(t.having, havingPredicate).join(' and ')}`;
  if (t.order_by?.length) sql += ` order by ${t.order_by.map((o) => `${col(o.key)} ${o.direction === 'desc' ? 'desc' : 'asc'}${o.nulls === 'first' ? ' nulls first' : o.nulls === 'last' ? ' nulls last' : ''}`).join(', ')}`;
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
  const need = (c, where) => { if (columns && c && !have.has(c)) problems.push(`${at}${where}: '${c}' is not a column of ${at ? 'the first level\'s result' : 'this model'}`); };
  eachCondition(t.where, (w) => need(w.column, 'where'));
  for (const g of t.group_by || []) need(g, 'group_by');
  for (const a of t.aggregations || []) { need(a.column, `aggregations.${a.agg}`); eachCondition(a.where, (w) => need(w.column, `aggregations.${a.agg}.where`)); }
  eachCondition(t.having, (h) => { need(h.column, `having.${h.agg}`); eachCondition(h.where, (w) => need(w.column, `having.${h.agg}.where`)); });
  // what the projection returns is what it can be sorted by — and what a second level reads
  const aggregated = (t.group_by || []).length || (t.aggregations || []).length;
  const out = aggregated
    ? new Set([...(t.group_by || []), ...(t.aggregations || []).map(aggName)])
    : have;
  if (t.then && (t.order_by || []).length) problems.push(`${at}order_by: with a second level (then), the order is the second level's — move order_by into then`);
  else for (const o of t.order_by || []) if ((columns || aggregated) && !out.has(o.key)) problems.push(`${at}order_by: '${o.key}' is not a column of what this query returns (${[...out].join(', ')})`);
  if (t.then) {
    if (t.then.then) problems.push(`${at}then: one second level at most`);
    else problems.push(...projectionProblems(t.then, (columns || aggregated) ? [...out] : null, 'then.'));
  }
  if (!at) { try { buildProjection('x', t, (x) => x); } catch (e) { problems.push(e.message); } }
  return problems;
}
