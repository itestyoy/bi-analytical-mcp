// A READ-ONLY PROJECTION OVER A STORED TABLE — what query_pipeline_model runs over a built model and
// what a drill-down card reads one view with: filter, group, aggregate, filter the aggregates, sort, and
// the same once more over that result (src/projection.js renders it).

import { AGGS as PROJECTION_AGGS } from '../projection.js';
import { OPS } from '../conditions.js';
import { conditionList } from '../schema-kit.js';

// A read-only projection over a stored table — what query_pipeline_model runs over a built model
// and what a drill-down card reads one view with. The row cap is the tool's own `limit`.
const rowCondition = { type: 'object', additionalProperties: false, required: ['column', 'op'], properties: { column: { type: 'string', description: 'Result column to filter.' }, op: { enum: OPS, description: 'Comparison operator.' }, value: { description: 'Comparison value (an array for in/not_in, [low, high] for between, a string for the text operators, none for is_null/is_not_null).' } } };
export const rowFilter = conditionList(rowCondition, 'Row filters on result columns: all of them hold — an item may be { or: [...] }, any of its conditions holds.');

export const onlyWhere = { ...conditionList(rowCondition), description: 'A CONDITIONAL aggregate: fold only the rows these conditions hold for (sum/count of the loads that succeeded, the distinct cycles that reached a show) — sum(case when …) without writing it.' };

// an aggregation, in two forms told apart by `agg`: a count, which may leave the column out (a row
// count), and every other function, which reads one
const aggFields = {
  where: onlyWhere,
  name: { type: 'string', pattern: '^[a-zA-Z_][a-zA-Z0-9_]*$', description: 'The name of the column it produces (default: <agg>_<column>, or the function alone for a row count).' },
};
const nonCount = [...PROJECTION_AGGS].filter((f) => f !== 'count');
const aggregation = {
  type: 'object',
  anyOf: [
    { title: 'agg: count', type: 'object', additionalProperties: false, required: ['agg'], properties: { agg: { const: 'count', description: 'Count the rows (or the non-NULL values of `column`).' }, column: { type: 'string', pattern: '^[a-zA-Z_][a-zA-Z0-9_]*$', description: 'Column whose non-NULL values to count (omit for a row count).' }, ...aggFields } },
    { title: `agg: ${nonCount.join(' | ')}`, type: 'object', additionalProperties: false, required: ['agg', 'column'], properties: { agg: { enum: nonCount, description: 'Aggregate function.' }, column: { type: 'string', pattern: '^[a-zA-Z_][a-zA-Z0-9_]*$', description: 'Column to aggregate.' }, ...aggFields } },
  ],
};

export const projectionLevel = (withThen) => ({
  type: 'object', additionalProperties: false,
  description: withThen
    ? 'A read-only projection over the stored table: filter rows, group, aggregate (each aggregate optionally over the rows a where holds for), filter the aggregates, sort — nothing upstream is recomputed. `then` aggregates the grouped result once more: count the groups that passed the having, sum a per-group flag.'
    : 'The second level: the same projection over the first level\'s result — its group_by columns and aggregate aliases are the columns here (count the groups: aggregations: [{ agg: "count" }]).',
  properties: {
    where: rowFilter,
    group_by: { type: 'array', items: { type: 'string' }, description: 'Result columns to group by before aggregating.' },
    aggregations: { type: 'array', description: 'Aggregations to compute over the (grouped) result.', items: aggregation },
    having: conditionList({ type: 'object', additionalProperties: false, required: ['agg', 'op'], properties: { agg: { enum: [...PROJECTION_AGGS], description: 'Aggregate function to test.' }, column: { type: 'string', description: 'Column the aggregate applies to.' }, where: onlyWhere, op: { enum: OPS, description: 'Comparison operator.' }, value: { description: 'Threshold value (an array for in/not_in and between).' } } }, 'Post-aggregation filters on aggregate values: all of them hold (an item may be { or: [...] }).'),
    order_by: { type: 'array', description: 'Sort the projected output.', items: { type: 'object', additionalProperties: false, required: ['key'], properties: { key: { type: 'string', description: 'Column/alias to sort by.' }, direction: { enum: ['asc', 'desc'], description: 'Sort direction.' }, nulls: { enum: ['first', 'last'], description: 'Where NULLs go. Omitted: the warehouse\'s default (which differs between warehouses).' } } } },
    ...(withThen ? { then: projectionLevel(false) } : {}),
  },
});

export const projection = projectionLevel(true);
