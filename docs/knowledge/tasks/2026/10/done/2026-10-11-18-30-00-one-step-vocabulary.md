---
title: One step vocabulary across the build and query tools
status: done
last_reviewed: 2026-10-11
last_used: 2026-10-11
tags: [schema, pipeline, semantic, retentioneering, read]
source_of_truth: [src/schema.js, src/pipeline.js, src/engine/semantic-query.js, src/retentioneering/schema.js, AGENTS.md]
---

# One step vocabulary across the build and query tools

## Status

done

## Last Reviewed

2026-10-11

## Context

After the one expression grammar (2026-10-11-13-17-43-one-expression-grammar), the tools still name
the same things differently: the pipeline builder's actions say `add_steps` / `edit_step` but its
fields say `stages` / `stage`; the retentioneering builder says `steps`; query_pipeline_model reads
with `stages`, query_semantic_model has its own `order_by`; the retentioneering read has `detail`
where the others page with `offset` / `limit`; `fork`, the answer flags and `dry_run` differ between
tools. The user chose the recommended package (1 + 2 + 4 + 5 of the proposal); NOT in it: one list of
SQL and library steps in the retentioneering build (3), and renaming a where stage's `conditions` /
an order_by stage's `keys` (both stay).

## Objective

Every build and query tool names its list of steps, its post-processing, its read of a task and its
common flags the same way.

## Expected Result

### 1. `steps` — the one word for a list a tool runs in order

- build_pipeline_model: `start` and `add_steps` take `steps` (was `stages`); `edit_step` /
  `insert_step` take `step` (was `stage`). An item is unchanged: `{ stage: "where", … }`.
- query_pipeline_model: `steps` (was `stages`), a batch's queries alike.
- build_retentioneering_model: `start` takes `steps` (was `stages`) — its items the pipeline's SQL
  stages `{ stage }`; `add_steps` keeps `steps` of library ops `{ type, … }` (the library's op model).
- query_semantic_model: `steps` (§2).
- Rule: a list a tool runs in order is `steps` (one: `step`); each item is tagged by what it is — a SQL
  stage by `stage`, a library op by `type`.
- Answers a model reads say `steps` too (a draft's steps, steps_count — already), never `stages`.
- Refusals: CROSS_PATH_SPELLING `stages → steps`, `stage → step` (hinted only where that field is
  allowed, so a stage item's own `stage` tag is untouched).
- Carry-over (src/earlier-spelling.js; src/retentioneering/earlier.js for an eventstream spec): a
  stored input in the earlier spelling — a query task's input re-read for paging or drawing (`stages`,
  `transform`), a retentioneering start spec (`stages`) — is read as `steps`. Recipes are rewritten.
  The store's internal names may stay as they are; only what a caller writes and reads changes.

### 2. One query tail — the read steps after a metric query

- query_semantic_model start form: `{ context_id, metrics, group_by?, where?, time_range?, steps?,
  limit?, materialize?, dry_run?, include_plan? }` — `order_by` goes (it is an `order_by` step).
- `steps`: the read steps query_pipeline_model takes (READ_STAGES: where, compute, aggregate, pivot,
  unpivot, order_by, limit, sample, project), over the metric result's columns as the caller names
  them (the metrics, the group_by items' result columns). The metric query itself (metrics, group_by,
  where, time_range) stays MetricFlow's: its `where` filters rows before aggregation, the steps work
  on the result (a where step on a metric is a having).
- Execution: what MetricFlow says itself — the query with no steps, or steps that are only a trailing
  `order_by` (with the query's `limit`) — runs through `mf query` as today. Any other step: the SQL
  MetricFlow compiles for the query (its explain) becomes a relation, its columns renamed to the
  caller's names, the steps are rendered over it by the read compiler (src/pipeline.js renderRead)
  and run with the dbt client's `show` on the context's project; the answer has the same shape,
  paging and KEPT_ROWS. `materialize: true` stores the result after the steps; `dry_run` returns the
  SQL after the steps, in the caller's spelling (`_callerSpelling`); `include_plan` MetricFlow's plan.
- The project's own semantic contexts (context_id = a semantic model) and batch queries alike.
- A stored query input with `order_by` is carried over as an `order_by` step.

### 4. One read of a task in every query tool

- query_retentioneering_model reads `{ task_ids, wait_seconds?, offset?, limit? }` like the other two:
  each analysis's tables paged by their row numbers (READ_PAGE rows unless `limit` says), the rows in
  the order its summary ranks them (the biggest transitions first, …); what the summary computes
  beyond rows (a group's profile) stays in the answer. `detail` goes (a refusal says to page with
  offset / limit). A card still draws every row.

### 5. The same small things the same way

- query_pipeline_model takes `dry_run: true`: the read's compiled SQL, without running (it waits for
  the context's build only) — as query_semantic_model.
- `fork`: `name` is required in both builders (a fork is a new thing with a name of its own).
- Both builders answer alike: by default what the steps changed (columns / the eventstream's shape
  added and removed) and the steps just added + `steps_count`; `include_columns: true` adds the full
  columns (the pipeline's columns; the eventstream's events, path columns, segments with levels);
  `include_steps: true` every step. The retentioneering builder takes both flags.

## Scope

src/schema.js, src/schema/*, src/pipeline.js, src/engine/*, src/earlier-spelling.js, src/validate.js,
src/retentioneering/*, src/display-check.js, src/apps/result-view-model.js (only if it builds inputs
with these fields), config/recipes.json, evals/cases.js, texts and descriptions, AGENTS.md, docs,
test/**.

## Out Of Scope

One list of SQL and library steps in the retentioneering build; renaming a where stage's
`conditions` / an order_by stage's `keys`; anything in the expression grammar.

## Verification

All edits first; then ONE run: `npm run lint:names`, `npm test`, `npm run test:integration`,
`npm run eval:check`; fix; commit; push. Tests assert on data.

Result (2026-10-12, dbt-v2): lint:names clean; unit 775/775; integration 312/312; eval:check — all
14 cases hold.
