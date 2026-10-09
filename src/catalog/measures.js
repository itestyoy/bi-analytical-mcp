// WHAT MAY BE AGGREGATED — the aggregations a measure may use, and a column's or a model's measure
// declaration brought to one shape. The schema marks an amount; the caller picks the function.

// Aggregations a catalog measure may declare — dbt/MetricFlow's set. Any column or model
// measure may use ANY of these; nothing here is specific to a role or a column name.
export const MEASURE_AGGS = new Set(['count', 'count_distinct', 'sum', 'average', 'median', 'min', 'max', 'percentile', 'sum_boolean']);

// The aggregations that compute a NUMBER out of the values — the ones a non-numeric field has to be
// cast for. (count / count_distinct count rows, sum_boolean counts trues: any type will do.)
export const NUMERIC_AGGS = new Set(['sum', 'average', 'median', 'min', 'max', 'percentile']);

// The aggregations a TASK's measure chooses from (build_semantic_model): every one above but
// sum_boolean, which is a count with a `where` under another name — the pipeline's measure has no
// such function, and one measure is written alike wherever rows are aggregated. A governed catalog
// measure may still fix sum_boolean: it is dbt's own word, rendered as the catalog declares it.
export const TASK_MEASURE_AGGS = new Set([...MEASURE_AGGS].filter((a) => a !== 'sum_boolean'));

/**
 * Normalise one GOVERNED measure — the opt-in case where a declaration also fixes its
 * aggregation for everyone (model-level meta.mcp.measures entry, or a column-level
 * meta.mcp.measure) into the dbt shape. `expr` defaults to the column it is declared on.
 * Validates the aggregation so a typo fails at load with the allowed set, not at dbt parse.
 */
export function normalizeMeasure(name, decl, { model, column } = {}) {
  const where = column ? `column '${column}' of model '${model}'` : `measure '${name}' of model '${model}'`;
  const agg = decl.agg;
  if (!MEASURE_AGGS.has(agg)) throw new Error(`${where}: unknown aggregation '${agg}' — use one of: ${[...MEASURE_AGGS].join(', ')}`);
  const expr = decl.expr ?? column;
  if (!expr) throw new Error(`${where}: a model-level measure needs an 'expr' (a SQL expression over the model's columns)`);
  const out = { agg, expr };
  if (agg === 'percentile') {
    const q = decl.percentile;
    if (!(typeof q === 'number' && q > 0 && q < 1)) throw new Error(`${where}: agg 'percentile' needs a 'percentile' between 0 and 1`);
    out.agg_params = { percentile: q, use_discrete_percentile: !!decl.use_discrete_percentile };
  }
  if (decl.label) out.label = decl.label;
  if (decl.description) out.description = decl.description;
  if (decl.unit) out.unit = decl.unit;
  return out;
}

/**
 * Normalise an AGGREGATABLE field: a column (or an expression over columns) the schema marks as
 * an AMOUNT rather than an attribute. It carries NO aggregation — which function to apply is the
 * caller's decision at build time, per question (a sum today, an average or a p90 tomorrow).
 * The schema only says WHAT may be aggregated, and what it means.
 */
export function normalizeAggregatable(name, decl, { model, column, type } = {}) {
  const where = column ? `column '${column}' of model '${model}'` : `aggregatable '${name}' of model '${model}'`;
  const expr = decl.expr ?? column;
  if (!expr) throw new Error(`${where}: needs an 'expr' (a SQL expression over the model's columns) when it is not declared on a column`);
  return {
    name, expr, ...(column ? { column } : {}), ...(type ? { type } : {}),
    ...(decl.unit ? { unit: decl.unit } : {}),
    ...(decl.label ? { label: decl.label } : {}),
    ...(decl.description ? { description: decl.description } : {}),
  };
}
