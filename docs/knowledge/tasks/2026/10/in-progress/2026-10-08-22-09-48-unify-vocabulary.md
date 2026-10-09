---
title: Unify the tools' vocabulary and fix the surviving review findings
status: in-progress
last_reviewed: 2026-10-08
last_used: 2026-10-08
tags: [schema, vocabulary, pipeline, dialects, breaking-change]
source_of_truth:
  - AGENTS.md
  - src/pipeline/
  - src/dialects/
  - src/pipeline/earlier.js
---

# Unify the tools' vocabulary and fix the surviving review findings

## Status

in-progress

## Last Reviewed

2026-10-08

## Last Used

2026-10-08

## Context

An adversarial review of every tool's schema found the same concept spelled several ways across tools
(a context id, a measure list, a sort key, a share, a condition's sides, stage-local names) and a set of
defects where the two warehouses give different results for the same request. The owner asked for
every proposal and fix that survived the review to be implemented, with these decisions:

- `semantic_models: [{ from }]` is the one loader of a model's attributes (create and update);
  `use_base_models` is removed; an item with `where` and no measures is refused.
- query_semantic_model's `order_by` keys stay the result column names; the `"metric_time"` alias and
  the dead object-key branch are removed.
- Pipeline stage payload keys `conditions` and `keys` stay; only the limit stage's `n` becomes `limit`.
- The pivot is redesigned (one measure form, typed values), not patched.
- experiment's ratio / cuped arms reuse the mean arm's names (`n`, `sum`, `sum_squares`,
  `sum_products`, nested `numerator` / `denominator` / `covariate`).
- explore_errors keeps the field name `source`.
- retentioneering `filter_events.where` takes the one condition grammar and keeps today's NULL rule.
- Earlier decisions still hold: raw stays positional; one query form beside the batch form;
  catalog-known names stay enums; no merged tools; no shared reader; no app-only drill_result; the
  library's own retentioneering grammars stay.

## Objective

Every tool speaks one vocabulary per concept, and a pipeline gives the same rows on DuckDB and BigQuery.

## Expected Result

The schemas, descriptions, guides, skills, recipes, evals and docs use only the current spelling; an
earlier spelling is refused with a hint (src/validate.js `CROSS_PATH_SPELLING`) or, for a step a draft
kept from an earlier version, carried over on read (src/pipeline/earlier.js); `npm run lint:names`,
`npm test`, the touched integration files and `npm run eval:check` pass.

## Scope

- Batch committed as 9b9cbf8: `draft_id` → `context_id` on build_pipeline_model; a recipe's
  `pipeline_payload` is the start request itself; a read's transform lists `measures` (was
  `aggregations`).
- Batch A, pipeline stages and warehouse parity:
  - pivot `{ group_by?, on, measure: { agg, column?, percentile? }, values: [{ value, name }] }`, built
    as the aggregate stage's conditional measures on both warehouses (the dialect PIVOT ops are gone);
  - dates: the ISO week (Monday) everywhere, `date_part` dow ISO 1–7 (Monday = 1), `date_diff` whole
    elapsed units truncated toward zero, an integer;
  - match_recognize: one `between_steps: 'any' | 'gap' | 'none'` (default `any` on both, `none` only
    where a row-pattern match runs), `mode` removed;
  - unpivot `name_column` / `value_column`, exactly `keep` + the two produced columns, NULL values kept;
  - conditions: four closed forms, `value` and `right` never together, a column is `column` (never
    `left: { column }`), a constant is `value` (never `right: { value }`);
  - one sort item `{ key, direction?, nulls? }` for the order_by stage, a window and a read, NULLs last
    unless said, written explicitly on both warehouses;
  - unnest `{ property }` (an enum of the catalog's array properties) | `{ column }`; sample `share`
    (0 < share ≤ 1); a join window's `between.column`; project `{ keep } | { drop }`; limit `{ limit }`;
    a window's `partition_by` takes a column or `{ entity }`; one TYPE schema.
- Batch C, semantic build, query and preview:
  - `use_base_models` is gone: an item of `semantic_models` loads its model, `{ from }` alone for its
    attributes, in a declaration and an update alike; an item with a `where` and no measures is
    refused (its where scopes nothing); every hint names `semantic_models: [{ from }]`; only a model
    a semantic layer can load is offered there and in `remove.dimensions` (`Catalog.semanticModelKeys`:
    a fact, or a model with a primary entity — experiments is a pipeline join's), and compile refuses
    another on `semantic_models.from`;
  - what a metric reads is a string: `measure`, `numerator`, `denominator`, a derived metric's
    `metrics: [names]` (no alias; `expr` is written over the names as listed, declared or stored);
  - `label` on a dimension, a measure and a metric reaches the manifest;
  - a dimension's type comes from the catalog (`as_type` is gone): a time column is a time dimension
    at `grain` (default the catalog's granularity), anything else categorical and takes no grain; a
    group_by on a time attribute asks MetricFlow for it at its grain, so its column is
    `<model>_<attribute>` (it came back as MetricFlow's `<path>__<grain>`);
  - a task measure's `agg` has no `sum_boolean` (a count with a where; governed catalog measures keep
    it; no `sum_boolean → count` refusal hint — a count of a column counts its non-NULL rows, a
    different number), and `cast` sits only on the forms that fold a number (sum, average, median, min, max,
    percentile), its enum the compute TYPES without string;
  - cumulative is two forms (all history / a trailing `window` in days…years, or `grain_to_date`);
  - update's `task` is a task the context holds (another name is refused, pointing at a declaration
    with context_id); `remove.dimensions` is one closed form per model with its fields as an enum;
  - query_semantic_model: no `task`; the single query requires `metrics`; `group_by` items unique;
    an `order_by` key is a result column (the `metric_time` alias and the object-key branch are
    gone); `materialize` with `dry_run` is refused; a dry run compiles with the caller's own limit;
  - preview_semantic_model: two forms — show, and validate over a window (`validate: true` with
    `time_range`); `semantic_model` is an enum of the models a semantic layer loads
    (`Catalog.semanticModelKeys`) and the project's semantic models;
  - texts: the overview's `enums` are keyed `{ agg, type, grain }` (agg: the task aggs); "Queried as
    <task>_<name>"; a semantic measure's name says it is read by metrics.
- Batch D, reads, paging and cards:
  - paging is the read's: neither query tool's start takes `offset`; a start's `limit` is how many
    rows of its result the task keeps (`KEPT_ROWS`, 1000), a materialized query storing every row (its
    `limit` then the rows the task keeps for a plain card — kept with the task, the jobs table's
    `kept_rows`, so a card drawn after a restart draws as many; a build keeps the 50 it answers with);
    a read's `offset`/`limit` are row numbers of the result (`READ_PAGE`, 50, unless `limit` says),
    alike for rows held and a stored table — a stored task's held first answer included, a page past
    it read from the table with the answer's order flag and where its rows come from (model,
    provenance, a sample's note), not the build's SQL and notes; a page that starts past the end
    counts the rows there are; a page past what a query kept says so, with no `next_offset`, and
    points at a larger limit or `materialize`; a read of a stored result whose table is gone is
    `result_gone` — every page and a card's read alike (the rows still held are not drawn); a
    pipeline declared and built in one call records the context its work created on its task, so its
    table pages, draws and starts a pipeline like any build's;
  - a read's measure is written by the aggregate stage's `aggExpr` (one writer per function) over
    `AGG_FNS` minus the sketch producers: `approx_count_distinct` and `hll_merge` join the read;
  - a read's condition (where, having, a measure's where) is the column-and-constant form, titled as
    the pipeline's first CONDITION form;
  - display: a pivot value is written in the KPI tile's two closed format forms (a currency only with
    `format: currency`); one card aggregation list (`CARD_AGGS`: a read's functions but percentile)
    for `drill.agg` and pivot `values[].agg`; one `level` item for pivot and drill levels; a column is
    described without listing spellings.
- Later batches of the same job (catalog tools, experiment, retentioneering) are recorded here as
  they land.

## Out Of Scope

BigQuery runs: the BigQuery renderings are reasoned from the code and MetricFlow's BigQuery renderer;
the behaviour is proven with data on DuckDB.

## Reasoning Pattern

- For non-trivial work, follow [Agent Planning and Reflection Pattern](../../../../patterns/2026-08-12-11-39-23-agent-planning-reflection-pattern.md): decompose the task, take the next smallest safe action, record the observation, and refine the plan.

## Acceptance Criteria

- [ ] No earlier spelling left in schemas, texts, recipes, evals or docs, outside earlier.js carry-overs
      and `CROSS_PATH_SPELLING` hints.
- [ ] A step a draft kept from an earlier version builds what its current spelling builds.
- [ ] Each changed stage is proven on data (DuckDB), never on generated text.
- [ ] `npm run lint:names`, `npm test`, the touched integration files and `npm run eval:check` pass.

## Result Changes On Rebuild

A pipeline built again after this job can return different numbers than before, by warehouse:

- BigQuery
  - a `week` grain (date_trunc, a join key's grain) starts on Monday (ISOWEEK; was Sunday);
  - `date_part` dow is 1–7 with Monday = 1 (was DAYOFWEEK, Sunday = 1), and `week` is the ISO week;
  - a funnel with `between_steps` unset matches `any` (the next later occurrence; was a single GAP
    pattern, which let no step event in between);
  - an ascending sort (the order_by stage, a window's order, a read) puts NULLs last unless told
    otherwise (BigQuery's own default puts them first there; DuckDB's already put them last);
  - a pivot's `count` counts the rows per cell (it was the count of an already aggregated value — 1
    per group);
  - unpivot returns exactly `keep` + the two produced columns, with a row for a NULL value too;
  - `date_diff` reads a DATE side as its midnight TIMESTAMP.
- DuckDB
  - `date_diff` is an integer of whole elapsed units truncated toward zero: hour, minute and second
    were fractional, and day was calendar days (now whole 24-hour days, as BigQuery's TIMESTAMP_DIFF);
  - `date_part` dow is 1–7 with Monday = 1 (was 0–6 with Sunday = 0);
  - unchanged on DuckDB: the week (already ISO) and the NULL placement (already last).

A semantic task declared again after Batch C:

- a dimension declared over a column the catalog types as time (users.install_date, …) is a time
  dimension at its grain (it was categorical unless `as_type: time`), and a group_by on a time
  attribute returns its column as `<model>_<attribute>` (it was MetricFlow's `<path>__<grain>`);
- a dry run's SQL carries the caller's limit (it carried limit + offset + 1, or 1001 by default).

## Verification

Recorded per batch in the job's run (lint:names, unit tests, the touched integration files).

- Batch A: `npm run lint:names` clean; `npm test` 658/658; integration 445/445 over pipeline,
  declared-joins, match-recognize, crashlytics-complex-types, condition-grammar, scd-e2e,
  recipes-parse, multistep-funnel, behavior-funnels, jinja-inert, scd-open-window, mcp-end-to-end,
  materialize, crashlytics-fact, pipeline-checkpoint, audit-regressions, retentioneering,
  batch-queries, analytics-tasks, end-to-end, acquisition-source, task-results, python-stage;
  `npm run eval:check` 14/14 cases hold. BigQuery not run (see Out Of Scope).
- Batch C: `npm run lint:names` clean; `npm test` 669/669; integration 378/378 over recipes-parse,
  end-to-end, cumulative-window, declared-joins, project-semantics, analytics-tasks,
  audit-regressions, behavior-funnels, batch-queries, crashlytics-fact, ab-test, scd-e2e,
  mcp-end-to-end, task-results, materialize, acquisition-source, duckdb-dbt, jinja-inert,
  multistep-funnel, condition-grammar, value-index; `npm run eval:check` 14/14 cases hold.

## Source Of Truth

- AGENTS.md (Protocol surface: ONE VOCABULARY PER CONCEPT).
- src/pipeline/sql.js (`CONDITION`, `SORT_KEY`, `TYPE`, `measureSchema`), src/pipeline/stages.js,
  src/match-recognize.js, src/dialects/{bigquery,duckdb}.js, src/pipeline/earlier.js.

## Related Notes

- [Adopt the knowledge-router agent kit](../done/2026-10-02-08-24-48-adopt-knowledge-router-kit.md)
