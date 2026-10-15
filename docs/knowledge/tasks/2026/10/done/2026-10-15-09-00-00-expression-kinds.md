---
title: Expression kinds in the tool schemas
status: done
last_reviewed: 2026-10-15
last_used: 2026-10-15
tags: [schema, expressions, semantic-layer]
source_of_truth:
  - src/pipeline/compute.js
  - src/schema.js
  - src/schema/fields.js
  - src/validate.js
  - AGENTS.md
---
# Expression kinds in the tool schemas

## Status
done

## Last Reviewed
2026-10-15

## Context
A tool's `$defs.expr` was the union of every place of the tool, so a schema accepted more than a field's
own description promised: a derived metric's `expr` took `{ column }`, a semantic measure took a bare
column or a formula over aggregates, a dimension took an aggregate — each refused only at build. A
proposed "universal build grammar" (one strict document for both builders, typed expression kinds) was
weighed: its kinds were taken, the shared document and its fixed-grain semantic profile were not (they
widen each tool's schema and change the semantic layer's model; it was also outside the portable subset).

## Decision
- An expression has one definition PER KIND a tool takes, all built by `exprSchema` (`exprDefs`,
  `EXPR_KINDS`) from `FNS` and `PLACES`: the row expression `$defs.expr`; in build_semantic_model a
  semantic measure's `$defs.aggregate` (exactly one aggregate, its args row expressions — a case inside
  stays) and a derived metric's `$defs.metric_expr` (`{ metric }`, `{ value }`, its arithmetic).
- A window is `$defs.over` (partition, order) for row_number / rank / dense_rank / lag / lead and
  `$defs.over_frame` (with `frame`) for an aggregate over a window — no more inline copies.
- A function refused where another titled kind takes it is named with where it belongs (src/validate.js:
  a row formula written as a measure is told to wrap it in an aggregate).
- query_semantic_model keeps one union (its split would cost ~8k characters of the list's budget).
- AGENTS.md lists what the schema does not say and the build checks.

## Verification
Tool list on config/catalog.yml: 249,767 → 250,780 characters (budget 260,000). Unit 844/844, the
semantic integration files, the shipped recipes and eval reference declarations validate; the full set
on dbt-v2 before the commit. Evals with a model were not run (no API key here).

## Source Of Truth
- The files above; AGENTS.md (Protocol surface: one definition per kind).
