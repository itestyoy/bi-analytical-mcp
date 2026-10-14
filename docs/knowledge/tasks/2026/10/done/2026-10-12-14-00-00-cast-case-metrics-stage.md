---
title: Types from the catalog, conditional aggregates as case, a metric query as steps
status: done
last_reviewed: 2026-10-14
last_used: 2026-10-14
tags: [schema, grammar, pipeline, semantic]
source_of_truth: [src/pipeline/compute.js, src/pipeline/stages.js, src/engine/semantic-query.js, src/earlier-spelling.js, AGENTS.md]
---

# Types from the catalog, conditional aggregates as case, a metric query as steps

## Status

done

## Last Reviewed

2026-10-14

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

Result (2026-10-14, dbt-v2): lint:names clean; unit 805/805; integration 312/312; eval:check — all
14 cases hold. Tool list on the production catalog: 248,022 characters (248,944 before; budget
< 260,000). New data assertions: a numeric property summed with no cast; a conditional count and sum
over case (a read, a pipeline aggregate, a pivot cell, a semantic measure); a metric query written as
steps — where steps before the metrics step, a where and an order_by after it — and a lone trailing
order_by (MetricFlow's path), on a task's context and a project semantic model alike.

## Left Out

Recipes' `required_roles` is never read (it predates this change): on a catalog without the
acquisition or crashlytics roles, the recipes that need them are still offered and their payloads are
refused there. Fixing it also needs the research guides to cite only the recipes a deployment offers
(src/research-guides.js names two of them), so it is a change of its own.

## Decisions (expressions, metric query)

- A typed read is converted to the read alone where its `type` is what the read yields now (a property:
  the catalog's type, `opts.propertyType`; a field, json_field, element_at, array_last: text), else to a
  `cast` of the read; with no catalog known the cast stays (equivalent).
- A typed unnest in a list of steps is two steps: the unnest under `<name>_element`, then a compute casting
  it under `<name>` (the steps after it read `<name>` as before); a `type: "string"` just goes. A lone
  `step` (edit_step / insert_step) has no one value: its `type` is refused as a field no unnest takes, with
  the two steps said beside it. A KEPT draft's unnest is not split (indexes and checkpoints count its
  steps): it builds with its type as it did.
- An earlier `{ fn, args, where }` is `fn(case when <where> then <arg> end)` (count with no args:
  `then: { value: 1 }`), so kept drafts and stored inputs build as they did.
- The else trap checks the aggregate's DIRECT argument only, for every aggregate but `sum`, folding and
  windowed; `else: { value: null }` says nothing and is taken.
- A pivot's cell is built by `foldWhere`: the cell's condition prepended to every branch of a case already
  there (its else kept on the direct argument, so the trap still holds), else a case over the argument.
- A semantic measure hands MetricFlow its case as the expr; the semantic model's own `where` is still the
  scope baked into it. The numeric check reads the catalog type of the argument — and of each value a
  case yields, so a sum over a case of a text property is refused in the call, not at the warehouse.
- A cast of an event property stored in the payload reads the payload once, as the cast type (what the
  earlier typed read wrote): a numeric property cast to text is '3', not '3.0'. A flat column is cast as
  any value is.
- The metric query's places: `metric_scope` = where + metrics ("a step up to the metrics step"),
  `metric_result` = the read's own list (`READ_STAGES`, "a step after the metrics step").
- A place that lists no stages (a build) takes every stage but the semantic layer's (`takes()`, one
  helper for stageAt and the schema): build_pipeline_model and retentioneering offer what they did. A
  metrics step met where it is not taken is said to be the semantic layer's, one per metric query.
- A where after the metrics step that names a ref is refused even when the result carries it: the
  refusal names the result's column ({ column }) — accepting the ref there would be a second spelling.
- Several where steps before the metrics step are each resolved at their place and ANDed into
  MetricFlow's where.
- Every refusal of a metric query has field `steps` and names the step (`steps[k]`, `steps[k] group_by[i]`,
  `steps[i] conditions[j]`) — the "model not loaded" refusal too.
- A materialized metric query's header is `{ context_id, steps, time_range }`.
- An earlier metric query is recognised by `metrics` (a list of names) outside a step beside another
  query field, or by position (a batch's item, a kept input); a removal's `{ metrics: [...] }` never is.
  A batch whose every query is earlier is said once, as the whole request (a partial conversion of
  `queries` found first is dropped).
- A deployment's recipe file is converted against the catalog (`loadRecipes(…, catalog)`), so it is
  served in the spelling a new call is told.

## Decisions (texts phase)

- `config/recipes.json` is written in the current spelling, so the loader converts nothing in it (a
  deployment's file is still carried over on load): a typed read loses `type` where it is the catalog's
  (`price_in_usd_of_event_data`, numeric on both catalogs) and is a `cast` where it is not
  (`level_id_of_event_data` as int: numeric on the fixture, text in production — the cast holds on both);
  the typed unnest's `type: "string"` goes; an aggregate's `where` is the aggregate over a case
  (`count` → `then: { value: 1 }`, `count_distinct` → `then:` the key); an example query is
  `{ steps: [{ stage: "metrics", metrics, group_by? }] }`. Checked: every recipe payload, example query
  and eval reference validates as written on both catalogs, renders on both dialects, compiles.
- A conditional aggregate is taught as the aggregate over a case with no `else`; `sum`'s `else: 0` is
  the one exception named, with the reason (the else's rows would be folded too).
- A JSON field read as another type is `cast` over the leaf `{ property, field }` where the property
  is the source's; `json_field` stays for a column that holds JSON (an unnested struct element).
- The TYPE word's description has one home (`TYPE`, src/pipeline/sql.js), taken as it is by the
  expression's `type` parameter: what cast converts to, what raw yields, a CASE's result.
- `PLACES.metric_where` is called "a where before the metrics step" — the words a refusal and the
  expression's description use for it.
