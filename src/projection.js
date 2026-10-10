// Build a safe, read-only projection SQL over a materialized result table:
// optional WHERE, GROUP BY, measures and HAVING — so a caller can compress /
// re-slice the stored results from different angles without recomputing the
// underlying analytics query. No raw SQL from the caller: identifiers are
// validated and QUOTED by the warehouse's dialect (a column may be named with a
// reserved word — rows, current, new), operators come from a fixed set, values
// are literal-escaped.

import { comparison, conditionsSql, eachCondition } from './conditions.js';
import { AGG_FNS, SKETCH_FNS, aggExpr } from './pipeline/sql.js';

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
/**
 * The aggregations a projection's measure (a read's transform, a drill-down) takes — the one list its
 * schema offers: the aggregate stage's functions, but for those that PRODUCE a sketch (a read returns
 * values; a sketch a pipeline stored is merged here with hll_merge).
 */
export const AGGS = new Set(AGG_FNS.filter((a) => !SKETCH_FNS.has(a)));
/** The column a measure produces: its name. */
export const aggName = (a) => a.name;

// a dialect that writes names as they are — for checking a projection's shape, never for running it
const PLAIN = {
  quoteIdent: (x) => x,
  statAggExpr: (fn, c) => `${fn}(${c})`,
  approxCountDistinct: (c) => `approx_count_distinct(${c})`,
  hllMerge: (c) => `hll_merge(${c})`,
  orderKey: (sql, direction, nulls) => `${sql} ${direction || 'asc'} nulls ${nulls || 'last'}`,
};

function ident(x) {
  if (!IDENT.test(String(x || ''))) throw new Error(`unsafe identifier: ${x}`);
  return x;
}

/** The SQL of one projection, written by the warehouse's dialect `d` (its quoteIdent, its functions). */
function writer(d) {
  const col = (x) => d.quoteIdent(ident(x));
  const predicate = (c) => comparison(col(c.column), c.op, c.value);
  // ONE WRITER PER FUNCTION: a measure here is the aggregate stage's, written by its aggExpr, which
  // holds the measure's own rules (a column for every function but a count, a percentile in (0,1)).
  // What a read checks first is only what is its own: the list it takes and the name a measure produces.
  const aggSql = (a) => {
    if (!AGGS.has(a.agg)) throw new Error(`unsupported agg: ${a.agg}`);
    if (!a.name) throw new Error(`${a.agg}: every measure names the column it produces (name)`);
    // a CONDITIONAL aggregate folds only the rows its `where` holds for
    const cond = a.where?.length ? conditionsSql(a.where, predicate).join(' and ') : null;
    try { return aggExpr(d, a.agg, a.column ? ident(a.column) : null, a.percentile, cond); }
    catch (e) { throw new Error(`measure '${a.name}': ${e.message}`); } // the rule's own words, named by the measure they refuse
  };
  return { col, predicate, aggSql };
}

/**
 * @param relation  SQL relation expression (e.g. `{{ ref('qr_x') }}`).
 * @param t         { where[], group_by[], measures[{ name, agg, column?, percentile?, where? }], having[], order_by[{ key, direction?, nulls? }], limit, offset }
 *                  (`limit` and `offset` are the read's page, not the caller's: the rows `offset`.. of the result)
 * @param d         the warehouse's dialect — every name is written quoted, every statistic its way
 */
export function buildProjection(relation, t = {}, d) {
  if (typeof d?.quoteIdent !== 'function') throw new Error('buildProjection needs the warehouse\'s dialect');
  // a SECOND level (then): the same projection over this one's result — the groups it made, counted,
  // summed or filtered again (how many cycles passed the having; how many reached a step)
  if (t.then) {
    const { then, limit, offset, ...inner } = t;
    return buildProjection(`(${buildProjection(relation, inner, d)}) level1`, { ...then, ...(typeof limit === 'number' ? { limit, offset } : {}) }, d);
  }
  const { col, predicate, aggSql } = writer(d);
  const groupCols = (t.group_by || []).map(col);
  const aggCols = (t.measures || []).map((a) => `${aggSql(a)} as ${col(aggName(a))}`);
  const select = [...groupCols, ...aggCols];
  let sql = `select ${select.length ? select.join(', ') : '*'} from ${relation}`;
  if (t.where?.length) sql += ` where ${conditionsSql(t.where, predicate).join(' and ')}`;
  if (groupCols.length) sql += ` group by ${groupCols.join(', ')}`;
  // `having` keeps the rows of the result — conditions on its own names, the grammar of `where`
  if (t.having?.length) sql = `select * from (${sql}) grouped where ${conditionsSql(t.having, predicate).join(' and ')}`;
  // a sort key as the order_by stage writes it: NULLs last unless asked first, on every warehouse
  if (t.order_by?.length) sql += ` order by ${t.order_by.map((o) => d.orderKey(col(o.key), o.direction, o.nulls)).join(', ')}`;
  // the page, at the level that orders the rows (an offset goes with a limit on every warehouse)
  if (typeof t.limit === 'number') sql += ` limit ${Math.trunc(t.limit)}${t.offset > 0 ? ` offset ${Math.trunc(t.offset)}` : ''}`;
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
  for (const a of t.measures || []) { need(a.column, `measures.${a.agg}`); eachCondition(a.where, (w) => need(w.column, `measures.${a.agg}.where`)); }
  // what the projection returns is what it can be sorted by — and what a second level reads
  const aggregated = (t.group_by || []).length || (t.measures || []).length;
  const out = aggregated
    ? new Set([...(t.group_by || []), ...(t.measures || []).map(aggName)])
    : have;
  eachCondition(t.having, (h) => { if ((columns || aggregated) && !out.has(h.column)) problems.push(`${at}having: '${h.column}' is not a column of what this query returns (${[...out].join(', ')})`); });
  if (t.then && (t.order_by || []).length) problems.push(`${at}order_by: with a second level (then), the order is the second level's — move order_by into then`);
  else for (const o of t.order_by || []) if ((columns || aggregated) && !out.has(o.key)) problems.push(`${at}order_by: '${o.key}' is not a column of what this query returns (${[...out].join(', ')})`);
  if (t.then) {
    if (t.then.then) problems.push(`${at}then: one second level at most`);
    else problems.push(...projectionProblems(t.then, (columns || aggregated) ? [...out] : null, 'then.'));
  }
  if (!at) { try { buildProjection('x', t, PLAIN); } catch (e) { problems.push(e.message); } }
  return problems;
}
