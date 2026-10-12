---
title: One expr, one stage, one ref, one include — a definition per concept, the place checks
status: done
last_reviewed: 2026-10-12
last_used: 2026-10-12
tags: [schema, grammar, pipeline, semantic, retentioneering, index]
source_of_truth: [src/pipeline/compute.js, src/pipeline/stages.js, src/schema.js, src/validate.js, AGENTS.md]
---

# One expr, one stage, one ref, one include

## Status

done

## Last Reviewed

2026-10-12

## Context

After the one expression grammar and the one step vocabulary, the schemas still hold several
definitions for one concept: five expression defs (`expr`, `read_expr`, the metric where's `expr`,
`metric_expr`, `eventstream_expr`) that differ only by which leaves and functions a place takes, three
stage defs (`pipeline_stage`, `read_stage`, `eventstream_stage`), two spellings of one catalog name
(`{ source, property }` in semantic_index / memory vs `{ model, attribute }` in a metric query), six
"show more" flags, `from` vs `source`, `name` vs `task`. Function placement is ALREADY checked when a
value is built (a window in a where, an aggregate in a row), so leaves and stage kinds can be checked
the same way. The user asked to do the whole recommended package ("Сделай все с учетом рекомендаций").

## Objective

One definition per concept in every tool — `expr`, `stage`, `ref`, `include` — grouped inside by what an
item needs to work; what a PLACE accepts is checked when the value is built, and the refusal names what
the place takes.

## Expected Result

### The rule (AGENTS.md, ONE VOCABULARY)

A concept has ONE definition — one builder, one name, the same groups — its forms grouped by what they
need to work. A place that takes the concept accepts a subset. In each tool's schema the definition
holds what THAT tool's places take — their union, nothing else (§9) — so a read's schema has no `raw`
again; it is never split per place inside a tool, and where the places of one tool take different
parts, each subset is checked when the value is built (the same way function placement already is),
and a refusal names the place and what it takes. A list of
a table's OWN columns stays a list of names (group_by of an aggregate, project, unpivot, segments,
path); anything else names a thing through `ref` / an `expr` leaf.

### 1. One `expr` (`$defs.expr` in every tool that takes an expression)

- Leaves, each one closed form (told apart by required keys):
  - rows: `{ column }`, `{ property, field?, type? }`, `{ value }`, `{ now: true }`;
  - the `ref` forms that name a VALUE (§3): `{ source, column, via? }`, `{ source, property }`,
    `{ semantic_model, dimension, grain? }`, `{ entity }`, `{ time: "metric_time", grain? }`, `{ metric }`.
- Functions: every `FNS` entry (scalar, condition, logic, aggregate, window, raw). A tool's
  `$defs.expr` holds the leaves and functions its places take (§9).
- What each PLACE takes (checked at build; the refusal lists the leaves / functions the place takes):

| place | leaves | functions |
|---|---|---|
| a source's rows: build stages, a semantic model's where / dimensions / measures | `column`, `property`, `value`, `now` | all, by the placement rules |
| rows without a payload: a read, the steps after a metric query, a drill, filter_events | `column`, `value`, `now` | all but `raw`, by the placement rules |
| a metric query's where | `{ source, column }`, `{ source, property }`, `{ semantic_model, dimension }`, `{ entity }`, `{ time }`, `value` | conditions, logic, scalar |
| a derived metric's expr | `metric`, `value` | add sub mul div round floor ceil abs coalesce least greatest |

- `eventstream_expr`, `read_expr`, `metric_expr` and the metric query's own `expr` go: one `expr`.
- filter_events is a where over rows without a payload; how it is WRITTEN (DuckDB inside the library,
  a column read as its constants' kind) stays the writer's detail.

### 2. One `stage` (`$defs.stage`), grouped by what a step needs

| group | members | needs |
|---|---|---|
| SQL over rows | where, compute, join, aggregate, pivot, unpivot, order_by, limit, sample, project, unnest | a table |
| over a source's events | match_recognize | the rows still a source's events |
| on a runtime, not SQL | python (`{ stage: "python" }`); in the retentioneering tool's schema also the library's ops (`{ type, … }`) | a Python runtime after SQL preparation |

- Each tool's `$defs.stage` holds the stages its places take, under the same group titles (§9): the
  core tools the core stages; the retentioneering tool (a feature: nothing of it in a core schema, on or
  off) its start's stages + its library ops as a runtime group.
- What each place takes (checked at build, refusal names the place and what it takes): the pipeline
  build — every core group; a read and the steps after a metric query — SQL minus join / unnest (a
  build from the task, from_task, for those); the retentioneering start — where, compute, join;
  retentioneering add_steps / edit_step / insert_step — the library ops only.
- `pipeline_stage`, `read_stage`, `eventstream_stage` go.

### 3. One `ref` (`$defs.ref`) — every name of a thing of the catalog or the semantic layer

| group | forms |
|---|---|
| the catalog: a source and what it has | `{ source }`, `{ source, event }`, `{ source, column, via? }`, `{ source, property }` |
| the semantic layer | `{ semantic_model, dimension, grain? }`, `{ entity }`, `{ metric }`, `{ time: "metric_time", grain? }` |

- A model's column is `column` (users.country is `{ source: "users", column: "country" }`), an event's
  payload property is `property` — as the `expr` leaves name them. `{ model, attribute }` goes
  (`via` stays where several relationships lead to the model).
- Who takes which (checked at build): semantic_index's views — `{ source }`, `{ source, event }`,
  `{ source, column }`, `{ source, property }`; memory's `about` — the same; a metric query's
  `group_by` and `where` — `{ source, column }`, `{ source, property }` (a payload property the task
  declared a dimension), `{ semantic_model, dimension }`, `{ entity }`, `{ time }`; a derived metric —
  `{ metric }`.
- Answers speak the same spelling (semantic_index views and value_matches, memory notes' about,
  result column provenance): `column` for a model column, `property` for a payload property.

### 4. One `include` — "show me more"

`include: [...]` (uniqueItems, an enum per tool) replaces `include_columns`, `include_steps`
(both builders → `columns`, `steps`), `include_yaml` (build_semantic_model → `yaml`), `include_plan`
(query_semantic_model → `plan`), `include_coverage` (semantic_index property view → `coverage`) and
explore_errors' `detail: summary | full` (→ `include: ["details"]`).

### 5. Names of a source and of a build

- `semantic_models[]` items: `{ source, where?, dimensions?, measures? }` (was `from`).
- build_semantic_model update addresses the task by `name` (was `task`).

### 6. Checks — two words by what they need

`dry_run`: compile and show, reading nothing (build_semantic_model; both query tools — after the
build). `validate`: check on the warehouse reading no data, a task (the pipeline preview: dbt run
--empty; preview_semantic_model: MetricFlow, over a time_range the warehouse). Descriptions and
AGENTS.md say this one rule.

### 7. delete_context — one form per kind of build a context holds

Adds `{ what: "eventstream", context_id, eventstream }` — contributed by the retentioneering feature
through the feature registry (the core never names a feature; off, the form does not exist).

### 8. display — one shape

display_retentioneering_result takes `{ task_id, display: { analysis, title?, edge_weight? } }`, as
display_model_result takes `{ task_id, display }`.

### 9. A tool's definition holds what its places take (decided 2026-10-12, after the first full run)

The first build put EVERY leaf, function and stage in every tool's def: the production tool list
grew from 244 KB to 316 KB (+29 %), and the size budget test was raised to pass — a regression the
user was shown before any commit. Decision ("давай твою рекомендацию"): ONE builder, ONE name and
the SAME groups per concept stay, but a tool's `$defs.expr` / `$defs.stage` / `$defs.ref` holds only
the forms that at least one PLACE OF THAT TOOL takes — the union of its places (`PLACES`,
`STAGE_PLACES`, `REF_PLACES`), never split per place inside a tool. Places that differ inside one
tool (a metric query's where vs its steps; the retentioneering start vs filter_events vs add_steps)
are still checked when the value is built. So a read's schema shows no join / unnest /
match_recognize / python stage, no `{ property }` and no `raw` (refused by the schema itself again),
a semantic declaration no window, and so on. The size budget goes back to its earlier ceiling.

| tool | expr places | stage places | ref places |
|---|---|---|---|
| build_pipeline_model | source_rows | build | — |
| query_pipeline_model | stored_rows | read | — |
| build_semantic_model | semantic_model, derived_metric | — | — |
| query_semantic_model | metric_where, stored_rows | read | group_by |
| semantic_index | — | — | index_view, about (the notes view's filter) |
| memory | — | — | about |
| build_retentioneering_model | source_rows (start), stored_rows (filter_events) | its start + its library ops | — |

### Earlier spellings

Every renamed field or reshaped value is refused with its hint or converted value
(src/validate.js CROSS_PATH_SPELLING / src/earlier-spelling.js): `{ model, attribute }`,
`include_*` / `detail`, `from`, `task`, the old display shape. What a store holds in an earlier
spelling — a semantic declaration (`from`), a query input re-read (`{ model, attribute }`,
`include_plan`), an eventstream spec — is carried over on read.

## Scope

src/** (schema builders, pipeline, engine, semantic, retentioneering, index views, memory, errors,
display), config/recipes.json, evals/cases.js, skills/**, AGENTS.md, docs, test/**.

## Out Of Scope

The join stage's `with` (not proposed); renaming a where stage's `conditions` / an order_by stage's
`keys`; merging tools.

## Verification

All edits first; then ONE run: `npm run lint:names`, `npm test`, `npm run test:integration`,
`npm run eval:check`; fix; commit; push. Tests assert on data.

Result (2026-10-12, dbt-v2, after §9): lint:names clean; unit 795/795; integration 312/312;
eval:check — all 14 cases hold. Tool list on the production catalog: 248,944 characters (244,014 at
the commit before this change; 315,688 with every form in every tool; budget < 260,000).
