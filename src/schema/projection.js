// A READ-ONLY PROJECTION OVER A STORED TABLE — what query_pipeline_model runs over a built model and
// what a drill-down card reads one view with: filter, group, aggregate, filter the aggregates, sort, and
// the same once more over that result (src/projection.js renders it).

import { AGGS as PROJECTION_AGGS } from '../projection.js';

// A read-only projection over a stored table — what query_pipeline_model runs over a built model
// and what a drill-down card reads one view with. The row cap is the tool's own `limit`.
export const rowFilter = { type: 'array', description: 'Row filters on result columns.', items: { type: 'object', additionalProperties: false, required: ['column', 'op'], properties: { column: { type: 'string', description: 'Result column to filter.' }, op: { enum: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'is_null', 'is_not_null'], description: 'Comparison operator.' }, value: { description: 'Comparison value (array for in/not_in).' } } } };

export const onlyWhere = { ...rowFilter, description: 'A CONDITIONAL aggregate: fold only the rows these conditions hold for (sum/count of the loads that succeeded, the distinct cycles that reached a show) — sum(case when …) without writing it.' };

export const projectionLevel = (withThen) => ({
  type: 'object', additionalProperties: false,
  description: withThen
    ? 'A read-only projection over the stored table: filter rows, group, aggregate (each aggregate optionally over the rows a where holds for), filter the aggregates, sort — nothing upstream is recomputed. `then` aggregates the grouped result once more: count the groups that passed the having, sum a per-group flag.'
    : 'The second level: the same projection over the first level\'s result — its group_by columns and aggregate aliases are the columns here (count the groups: aggregations: [{ fn: "count" }]).',
  properties: {
    where: rowFilter,
    group_by: { type: 'array', items: { type: 'string' }, description: 'Result columns to group by before aggregating.' },
    aggregations: { type: 'array', description: 'Aggregations to compute over the (grouped) result.', items: { type: 'object', additionalProperties: false, required: ['fn'], properties: { fn: { enum: [...PROJECTION_AGGS], description: 'Aggregate function.' }, column: { type: 'string', description: 'Column to aggregate (omit, or \'*\', for a row count).' }, where: onlyWhere, as: { type: 'string', pattern: '^[a-zA-Z_][a-zA-Z0-9_]*$', description: 'Output column alias (default: <fn>_<column>, or the function alone for a row count).' } }, if: { properties: { fn: { not: { const: 'count' } } } }, then: { required: ['column'] } } },
    having: { type: 'array', description: 'Post-aggregation filters on aggregate values.', items: { type: 'object', additionalProperties: false, required: ['fn', 'op', 'value'], properties: { fn: { enum: [...PROJECTION_AGGS], description: 'Aggregate function to test.' }, column: { type: 'string', description: 'Column the aggregate applies to.' }, where: onlyWhere, op: { enum: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'], description: 'Comparison operator.' }, value: { description: 'Threshold value.' } } } },
    order_by: { type: 'array', description: 'Sort the projected output.', items: { type: 'object', additionalProperties: false, required: ['key'], properties: { key: { type: 'string', description: 'Column/alias to sort by.' }, direction: { enum: ['asc', 'desc'], description: 'Sort direction.' }, nulls: { enum: ['first', 'last'], description: 'Where NULLs go. Omitted: the warehouse\'s default (which differs between warehouses).' } } } },
    ...(withThen ? { then: projectionLevel(false) } : {}),
  },
});

export const projection = projectionLevel(true);
