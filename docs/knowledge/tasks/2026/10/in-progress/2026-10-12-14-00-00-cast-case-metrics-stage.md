---
title: Types from the catalog, conditional aggregates as case, a metric query as steps
status: in-progress
last_reviewed: 2026-10-12
last_used: 2026-10-12
tags: [schema, grammar, pipeline, semantic]
source_of_truth: [src/pipeline/compute.js, src/pipeline/stages.js, src/engine/semantic-query.js, src/earlier-spelling.js, AGENTS.md]
---

# Types from the catalog, conditional aggregates as case, a metric query as steps

## Status

in-progress

## Last Reviewed

2026-10-12

## Context

After "one definition per concept" (docs/knowledge/tasks/2026/10/done/2026-10-12-09-00-00-one-expr-one-stage-one-ref.md)
three things still say one thing two ways (the user's questions, answered and accepted — "Да делай"):

1. `{ property, type }`: the catalog declares every scalar property's type (production 149/149, the
   fixture 29/29) and the read already uses it; `type` is a second way to convert, beside `cast`.
2. An aggregate's `where` is `case` inside the aggregate — `sum(x) where c` = `sum(case when c then x end)`,
   which is how it is written to SQL anyway.
3. query_semantic_model keeps its own `metrics` / `group_by` / `where` beside `steps`; the metric query
   itself can be a step, so the whole query is one list of steps, as query_pipeline_model's is.

## Objective

One way to convert a type (`cast`), one way to fold some rows (`case`), one structure for a query (`steps`).

## Expected Result

### 1. A value's type comes from where it is read; converting is `cast`

- The `{ property }` leaf is `{ property, field? }`: its type is the catalog's (declared `data_type`; a
  catalog that declares none reads text). `field` reads one field of a JSON object property (text).
- `type` goes from `json_field`, `element_at`, `array_last` and the `unnest` stage as well; what they
  yield is converted with `{ fn: "cast", args: [...], type }`. `raw` keeps `type` (nothing else knows
  what its SQL returns); `cast` and `case` keep theirs (it is what they make).
- Earlier spelling: a new call with `type` on those is refused with the converted value (the read
  wrapped in `cast`, or `type` dropped when it equals the catalog's). A KEPT draft carries over the same
  way; a kept `unnest` with `type` builds as it did (its element type kept internally — renaming its
  column would break the steps after it).

### 2. A conditional aggregate is `case` inside the aggregate

- Aggregates take no `where`. `count` of the rows where `c` holds:
  `{ fn: "count", args: [{ fn: "case", cases: [{ when: [c], then: { value: 1 } }] }] }`; the revenue of
  them: `{ fn: "sum", args: [{ fn: "case", cases: [{ when: [c], then: { column: "price" } }] }] }`.
- The `else` trap is refused when the value is built: an aggregate other than `sum` whose argument is a
  `case` with an `else` that yields a value (not `{ value: null }`) — count, count_distinct,
  approx_count_distinct, average, min, max, median, percentile, stddev, variance, the sketches — would
  fold the other rows too; the refusal says to leave `else` out. `sum` may keep `else: 0`.
- A pivot's cell, a semantic measure, the display's drill fold: built the same way (case), internally.
- Earlier spelling: `{ fn, args, where }` → the same aggregate over `case` (count with no args →
  `then: { value: 1 }`); new calls refused with the converted value; kept drafts, stored semantic
  declarations and query inputs carried over.

### 3. A metric query is steps

- query_semantic_model's start form: `{ context_id, steps, time_range?, limit?, materialize?, dry_run?,
  include? }` (a batch's queries alike). `metrics`, `group_by`, `where` go.
- A new stage `{ stage: "metrics", metrics: [names], group_by?: [refs] }` — its own group in
  `$defs.stage`, "in the semantic layer — needs MetricFlow", offered only by query_semantic_model.
- Places (checked when built, the refusal naming the place): exactly one `metrics` step; before it only
  `where` steps — their leaves the refs a metric query's where takes (`PLACES.metric_where`), all of
  them ANDed into MetricFlow's where; after it the read steps over the result's columns as the caller
  names them (`PLACES.stored_rows`, as today). A where after it on a dimension the result does not
  carry is refused with "put it before the metrics step".
- Execution unchanged: no step after `metrics`, or only a trailing order_by → `mf query`; anything else
  → MetricFlow's compiled SQL, renamed, the read compiler over it.
- Earlier spelling: `{ metrics, group_by?, where?, steps? }` → `steps: [where…, { stage: "metrics", … },
  …steps]`; new calls refused with the converted value; stored query inputs (re-read for paging,
  drawn displays) carried over.

## Scope

src/pipeline/compute.js, src/pipeline/stages.js, src/pipeline/earlier.js, src/earlier-spelling.js,
src/validate.js, src/compile.js (semantic measures), src/engine/semantic-query.js and its readers,
src/engine/task-results.js, src/schema.js / src/schema/*.js, src/retentioneering (filter_events
and start steps read properties too), config/recipes.json, evals/cases.js, skills/**, AGENTS.md,
docs, test/**.

## Out Of Scope

The semantic model's own `where` (a model-level scope, not an aggregate's), `time_range`, the join's
`between`, raw's `type`.

## Verification

All edits first; then ONE run: `npm run lint:names`, `npm test`, `npm run test:integration`,
`npm run eval:check`; fix; commit; push. Tests assert on data. The tool list stays within its budget.
