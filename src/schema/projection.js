// A READ-ONLY PROJECTION OVER A STORED TABLE — what query_pipeline_model runs over a built model and
// what a drill-down card reads one view with: filter, group, aggregate, filter the aggregates, sort, and
// the same once more over that result (src/projection.js renders it).

import { AGGS as PROJECTION_AGGS } from '../projection.js';
import { OPS } from '../conditions.js';
import { conditionList, CONSTANT } from '../schema-kit.js';
import { measureSchema } from '../pipeline/sql.js';

// A read-only projection over a stored table — what query_pipeline_model runs over a built model
// and what a drill-down card reads one view with. The row cap is the tool's own `limit`.
const rowCondition = { type: 'object', additionalProperties: false, required: ['column', 'op'], properties: { column: { type: 'string' }, op: { enum: OPS }, value: { ...CONSTANT, description: 'An array for in/not_in, [low, high] for between, none for is_null/is_not_null.' } } };
export const rowFilter = conditionList(rowCondition, 'Row filters on result columns: all of them hold — an item may be { or: [...] }, any of its conditions holds.');

export const onlyWhere = { ...conditionList(rowCondition), description: 'A CONDITIONAL aggregate: fold only the rows these conditions hold for (sum/count of the loads that succeeded, the distinct cycles that reached a show) — sum(case when …) without writing it.' };

// ONE MEASURE, as a pipeline's aggregate stage takes it (src/pipeline/sql.js measureSchema), over the
// functions a read computes — in a list called `measures`, as there. Its names are a stored table's
// columns, which may carry the project's mixed-case names.
const IDENT = '^[a-zA-Z_][a-zA-Z0-9_]*$';
const measure = measureSchema({ aggs: [...PROJECTION_AGGS], column: { type: 'string', pattern: IDENT }, where: onlyWhere, pattern: IDENT });

export const projectionLevel = (withThen) => ({
  type: 'object', additionalProperties: false,
  description: withThen
    ? 'A read-only projection over the stored table: filter rows, group, aggregate (the measures of a pipeline\'s aggregate stage), keep result rows (having), sort — nothing upstream is recomputed. `then` aggregates the result once more: count the groups that passed, sum a per-group flag.'
    : 'The second level: the same projection over the first level\'s result — its group_by columns and measure names are the columns here (count the groups: measures: [{ agg: "count", name: "groups" }]).',
  properties: {
    where: rowFilter,
    group_by: { type: 'array', uniqueItems: true, items: { type: 'string' }, description: 'Result columns to group by before aggregating.' },
    measures: { type: 'array', description: 'The measures to compute over the (grouped) result — as a pipeline\'s aggregate stage takes them.', items: measure },
    having: conditionList(rowCondition, 'Keep the rows of the result these conditions hold for — on its group_by columns and measure names.'),
    order_by: { type: 'array', description: 'Sort the projected output.', items: { type: 'object', additionalProperties: false, required: ['key'], properties: { key: { type: 'string', description: 'Column/alias to sort by.' }, direction: { enum: ['asc', 'desc'], description: 'Sort direction.' }, nulls: { enum: ['first', 'last'], description: 'Where NULLs go. Omitted: the warehouse\'s default (which differs between warehouses).' } } } },
    ...(withThen ? { then: projectionLevel(false) } : {}),
  },
});

export const projection = projectionLevel(true);
