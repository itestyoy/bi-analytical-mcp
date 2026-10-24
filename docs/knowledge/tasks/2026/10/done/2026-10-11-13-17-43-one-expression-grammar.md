---
title: One expression grammar — conditions, aggregates and reads as expressions and stages
status: done
last_reviewed: 2026-10-11
last_used: 2026-10-11
tags: [schema, grammar, pipeline, semantic, retentioneering, read]
source_of_truth: [src/pipeline/compute.js, src/conditions.js, src/pipeline/stages.js, AGENTS.md]
---

# One expression grammar — conditions, aggregates and reads as expressions and stages

## Status

done

## Last Reviewed

2026-10-11

## Context

A condition (`{ column | left, op, value | right }`, groups `{ or }` / `{ and }`), a measure
(`{ name, agg, column | field, percentile?, where? }`), a computed expression (`{ fn, args }`), a read's
`transform` (`where / group_by / measures / having / order_by / then`) and the retentioneering start
(`where`, `events.split`, `segments` forms) are several grammars for what is one thing: a FUNCTION OF
EXPRESSIONS placed in different stages. The user asked to make them one structure and one grammar in
every tool ("Сделай все следуя этой идеи и унификация упростит схему за счет единой структуры и
грамматики во всех тулах"). `where` slots stay LISTS (all hold) — the recommended default.

## Objective

Every tool writes conditions, measures and computed values in ONE expression grammar — `{ fn, args,
…params }` over leaves — and every read of a stored table is written in the pipeline's own stages.

## Expected Result

The surface after the change, stated as the rules each part follows. Old spellings are refused with
the converted value shown; what a store holds in an old spelling is carried over on read.

---

## 1. The expression (`$defs.expr`, built by ONE builder)

`exprSchema(catalog, { leaves, fns })` (src/pipeline/compute.js) builds every level's expression
schema: one closed form per LEAF the level takes, and one form per FUNCTION SHAPE (functions with the
same args/params share a form, tagged by `fn`), `args` items `$ref` to the same def (recursive). Each
level gets its def under its own `$defs` name; the pipeline's (and a read's, and the semantic tool's)
is `$defs.expr`.

### Leaves

| leaf | where | meaning |
|---|---|---|
| `{ column: name }` | pipeline, read, semantic model, retentioneering stages and filter_events | a column of the rows here (pipeline step / stored table / the model / the eventstream). On a semantic model it is a real column, an entity key column, or an amount the catalog declares (`meta.mcp.measures`). Open string in the schema, checked when built (with "did you mean") |
| `{ property: name, field?, type? }` | pipeline over a source while its rows are that source's events; semantic model on an events source | an event property read where it is stored (flat column or payload key). `field` reads one field of a JSON object, `type` what it is read as. REPLACES the function `event_property` (gone) and the semantic `field` naming a property. Enum of the catalog's event properties |
| `{ value: scalar }` | everywhere | a constant: string, number, boolean or null. Never a list |
| `{ now: true }` | pipeline, read | the current time |
| `{ metric: name }` | a derived metric's `expr` only | a metric of this call or the context (as declared or as stored) |
| dimension references `{ time: "metric_time", grain? }`, `{ model, attribute, via? }`, `{ semantic_model, dimension, grain? }`, `{ entity }` | a metric query's `where` only | exactly as that query's `group_by` names them |

### Functions (src/pipeline/compute.js `FNS`, one table)

- Scalar functions as today (add … elapsed_days, case, raw, coalesce …), minus `event_property`.
  `array_length` takes `args: [array]`, `array_contains` takes `args: [array, { value }]` — the array a
  `{ property }` leaf (read where it is stored, as today) or an array-typed expression.
- CONDITIONS (boolean result):
  - `eq neq gt gte lt lte` — `args: [a, b]`
  - `like not_like contains starts_with ends_with` — `args: [text, pattern]` (a constant pattern is a string; LIKE wildcards only for like/not_like; substrings matched as written — STRPOS/STARTS_WITH/ENDS_WITH, empty substring holds)
  - `in not_in` — `args: [a, member, member, …]` (≥ 2; each member its own argument)
  - `between` — `args: [a, low, high]` (both included)
  - `is_null is_not_null` — `args: [a]`
- LOGIC (boolean): `and`, `or` — `args: [≥ 2 booleans]`; `not` — `args: [boolean]`. Nest to any depth.
- AGGREGATES: `sum average min max count count_distinct approx_count_distinct median percentile stddev variance hll_init hll_merge hll_merge_partial`.
  `count` takes 0..1 args (none = rows), the rest 1; `percentile` needs the param `percentile` in (0,1);
  optional param `where: [booleans]` — a conditional aggregate (only without `over`);
  `over` (as today, with a frame) makes `sum average min max count` a WINDOW (the other aggregates take no `over`).
  `row_number rank dense_rank lag lead` as today.

### Where each function may stand (checked when built; the refusal names the rule)

1. ROW context — a compute stage's `expr`, every condition slot, a CASE's branches, an aggregate's
   argument: no aggregate without `over`. A window (anything with `over`) only in a compute stage —
   never in a condition slot, an aggregate's argument, or another window's argument.
2. AGGREGATE context — an aggregate stage's measure `expr`, a pivot's `measure`: aggregates (no `over`)
   combined by scalar functions and constants; a column outside an aggregate must be a `group_by`
   column; at least one aggregate. An aggregate's args are row expressions.
3. CONDITION slot — a LIST of expressions that all hold; each must be boolean: a condition or logic
   function, a boolean column, or a function typed boolean (array_contains). Anything else is refused:
   "a where takes conditions — a comparison ({ fn: "eq", args: [...] }), and / or / not, or a boolean column".
4. SEMANTIC MEASURE `expr` — exactly ONE aggregate at the top, of the task aggregates (sum average min
   max count count_distinct median percentile); its args row expressions over the model's leaves; its
   `where` is the measure's scope. A formula over several aggregates is several measures + a derived metric.
5. METRIC QUERY `where` — leaves: dimension references and constants; functions: conditions, logic,
   scalar (no aggregate, no window, no column/property leaf). Written by the dialect around MetricFlow's
   Jinja references.
6. READ (query_pipeline_model stages) — leaves `{ column }` of the stored table, constants, now; no `{ property }`.
7. RETENTIONEERING `filter_events.where` — leaves `{ column }` of the eventstream and constants;
   conditions, logic, scalar; written in DuckDB; a column compared with a constant is read as the
   constant's kind (TRY_CAST, as today: a segment is text, a threshold on it a number's).

### Typing (one rule, the comparison writer)

A constant is written in the type of the first argument that is not a constant (typedLiteral): a flag
spelled "true" meets a boolean column, "5" a numeric one. A boolean constant beside a physical TEXT
column holding a flag matches every spelling of it (eq / neq / in / not_in only). Two non-constant
arguments where one is a moment: a number or boolean on the other side is refused; otherwise both are
compared as timestamps (`d.timeOperand`). A `{ value: null }` in a comparison, in/not_in, between or a
text test is refused: "a missing value is tested with is_null / is_not_null".

### Missing values — two-valued, the same at every level

- A comparison (and in, between, a text test) with a missing operand does NOT hold.
- `neq`, `not_in`, `not_like` mean "present and different" — they do not hold for a missing value.
- `not(c)` holds wherever `c` does not, a missing value included: `NOT COALESCE(c, FALSE)`.
- A boolean a compute stage stores (its `expr` a condition or logic function) is never NULL: `COALESCE(c, FALSE)`.
- In SQL condition slots plain comparisons stay as they are (partition pruning).
- filter_events follows the same rule (today its negations keep a missing value: a stored step's
  neq / not_in / not_like is carried over as not(eq / in / like), so its meaning does not change).

## 2. Slots that take conditions

Every slot is a LIST of boolean expressions that all hold — `conditions` of a where stage, `where` of
an aggregate (conditional aggregate), a CASE branch's `when`, a funnel step's `where`, a semantic
model's `where`, a metric query's `where`, the retentioneering stages' and filter_events' `where`.
`{ or: [...] }` / `{ and: [...] }` groups are gone: `{ fn: "or" | "and" | "not", args }`.

```js
{ stage: "where", conditions: [
  { fn: "eq", args: [{ column: "event_name" }, { value: "purchase" }] },
  { fn: "or", args: [
    { fn: "in", args: [{ column: "country" }, { value: "US" }, { value: "DE" }] },
    { fn: "gt", args: [{ column: "revenue" }, { value: 10 }] } ] } ] }
```

## 3. Measures — `{ name, expr }`

The measure form of every place that aggregates (aggregate stage, pivot, a read's aggregate stage,
semantic model) is `{ name, expr }` (+ `label` on a semantic model). `agg`, `column`, `field`,
`percentile` (as a measure field) and `cast` are gone; `measureSchema` goes.

```js
{ stage: "aggregate", group_by: ["country"], measures: [
  { name: "revenue", expr: { fn: "sum", args: [{ column: "price" }] } },
  { name: "arppu", expr: { fn: "div", args: [{ fn: "sum", args: [{ column: "price" }] }, { fn: "count_distinct", args: [{ column: "user_id" }] }] } },
  { name: "p90_load", expr: { fn: "percentile", args: [{ column: "load_ms" }], percentile: 0.9 } },
  { name: "failed_loads", expr: { fn: "count", args: [], where: [{ fn: "eq", args: [{ column: "status" }, { value: "error" }] }] } } ] }
```

- Pivot: `{ stage: "pivot", group_by?, on, measure: <aggregate expression>, values: [{ value, name }] }` —
  each cell is `measure` with the cell's condition (`eq(on, value)`, `is_null(on)` for null) added to
  the `where` of every aggregate inside it.
- A measure's type: the aggregate's (count → int; sum/average/… → numeric; min/max → the arg's), a
  formula's what its top function returns.
- statAccuracyNote (approximate stats) unchanged.

## 4. Reads are stages — query_pipeline_model

`query_pipeline_model({ context_id, stages?, limit? })` replaces `transform`. The stages are the
pipeline's own, run read-only over the context's stored table (nothing materialized, the rows are the
answer). Allowed in a read: `where compute aggregate pivot unpivot order_by limit sample project`
(others — join, unnest, match_recognize, python — are a build from the task: `from_task`). Built by
the pipeline's stage builders over the table's columns (no source: a `{ property }` is refused) and
rendered by the dialect into one SELECT; paging (`offset`/`limit` of a `{ task_ids }` read) unchanged.
`src/projection.js` and `src/schema/projection.js` go. The display's pivot levels and drill views are
built as stages (`pivotTransform` / `drillView` → stages). `having` = a where after the aggregate;
`then` = a second aggregate.

```js
query_pipeline_model({ request: { context_id, stages: [
  { stage: "where", conditions: [{ fn: "gte", args: [{ column: "day" }, { value: "2026-09-01" }] }] },
  { stage: "aggregate", group_by: ["country"], measures: [{ name: "rev", expr: { fn: "sum", args: [{ column: "revenue" }] } }] },
  { stage: "where", conditions: [{ fn: "gt", args: [{ column: "rev" }, { value: 1000 }] }] },
  { stage: "order_by", keys: [{ key: "rev", direction: "desc" }] } ] } })
```

Display (display_model_result `display`): the aggregate a card folds a value with is `fn` (was `agg`),
the same aggregate names.

## 5. Semantic side

- `semantic_models[]`: `{ from, where?, dimensions?, measures? }`.
  - `where`: list of booleans over the model's leaves (`{ column }`, `{ property }` on an events source).
  - `dimensions` items (closed forms): `{ column: <time column>, grain?, label? }`, `{ column: <other groupable column>, label? }`, `{ property: <scalar property>, label? }`, `{ name, expr, label? }` — a computed categorical dimension, its expr a row expression compiled into the dbt dimension's `expr`.
  - `measures`: `{ name, expr, label? }` (rule 4).
- `metrics`: `simple { name, measure, label?, fill_nulls_with? }` and `cumulative` as today; `derived { name, expr, label?, fill_nulls_with? }` with `expr` an expression of `{ metric }` leaves, constants and `add sub mul div round floor ceil abs coalesce least greatest` — its input metrics read off the leaves (the `metrics` list goes), compiled into MetricFlow's derived `expr` over stored names as today (no aliases, cycles refused; `div` is the pipeline's NULLIF division). `ratio` is NOT offered any more (a ratio is `div` of two metrics); a kept declaration holding one still compiles, as does a kept derived metric's string `expr`.
- `query_semantic_model` `where` (rule 5): `{ fn: "eq", args: [{ model: "users", attribute: "country" }, { value: "US" }] }`, `{ fn: "in", args: [{ fn: "date_part", args: [{ time: "metric_time", grain: "day" }], part: "dow" }, { value: 6 }, { value: 7 }] }`. The filter value guard checks a constant compared with a reference, as today. The caller-spelling rewrite (`_callerSpelling`) keeps working on the rendered tokens.

## 6. Retentioneering start — a pipeline + the eventstream's roles

Both starts take the same fields: `{ action: "start", name, (source + time_range?) | from_task, stages?, columns?: { event, time }, path?: [column names], segments?: [column names], sessions?, sample?, top?, description?, context_id? }`.

- `stages`: the pipeline's own stages that keep the rows events (where, compute, join — not sample:
  that stage draws at random, and the eventstream is deterministic, sampling users by a hash with its
  own `sample`) over the source (or the task's table), rendered through the pipeline as today's start is.
- `columns`: which columns are the event and the time — for a source they default to its own; a
  compute stage that renames events (what `events.split` / `events.groups` did: a `case`, a `concat`)
  makes a column and `columns.event` names it. Required with from_task.
- `path`: column names (default: the user key); `task_path` merges into it.
- `segments`: column names of the prepared rows (an attribute arrives by a join stage; a property by a compute stage).
- `top` (was `events.top`), `sessions`, `sample` (its `events` keys are event names as the rows hold them) stay the eventstream's own.
- Gone: `where`, `events.include/exclude/split/groups`, the segment forms `{ model, attribute } | { column } | { property }`, the path forms.
- filter_events `where`: rule 7 + the missing-value rule.
- A kept eventstream spec / step in the old spelling is carried over (src/retentioneering/earlier.js):
  where → a where stage; include/exclude → a where stage (in / not_in on the event column); split /
  groups → compute stage(s) and `columns.event`; a segment `{ model, attribute, via?, name? }` → a join
  stage (+ its name); `{ column, name }` → a compute copy when renamed; `{ property, name? }` → a
  compute reading it; path items → column names (a property → a compute); filter_events neq /
  not_in / not_like → not(eq / in / like).

## 7. Other unifications

- `unnest`: `{ stage: "unnest", expr, name, field?, type? }` — `expr` an array (a `{ property }` leaf of an array property, or an array-typed expression). `{ property }` / `{ column }` forms go.
- The vocabulary rule "an aggregation is `agg`" becomes "an aggregation is a function": CROSS_PATH_SPELLING drops `fn → agg`; `avg/mean → average`, `q/quantile → percentile` still hinted (as `fn` values and the param).

## 8. The earlier spelling — one converter table

`src/earlier-spelling.js` (new) holds every converter from an earlier spelling to this one — a
condition / group (`{ column | left | field | property, op, value | right }`, `{ or }`, `{ and }`), a
measure (`{ name, agg, column | field, percentile?, where?, cast? }`), `{ fn: "event_property", … }`,
an unnest's `{ property }` / `{ column }`, a pivot's `{ agg, column }` measure, a read's `transform`.
Used by: src/pipeline/earlier.js (kept drafts), src/retentioneering/earlier.js, the semantic
declaration carry-over (a stored declaration merged by action:update), and src/validate.js — a
refusal of a value in an earlier spelling shows the converted value ("write { fn: "eq", args: […] }").
Never an alias: a new call in the old spelling is refused.

## Scope

src/** (pipeline, compute, conditions, schema-kit, validate, stages, match-recognize, time-range,
engine/*, projection, display, apps view model + checked-in build, schema/*, compile, yaml-render,
semantic-latest, predicate, project-semantics, retentioneering/*), config/recipes.json,
evals/cases.js, test/**, AGENTS.md, docs/knowledge, docs/*.md where they describe the grammar.

## Out Of Scope

- `time_range` (timezone, whole last day, partition pruning, require_time_range, MetricFlow's time constraint).
- join `via` / `between` (point-in-time stays explicit), a funnel step's `event_name`, the retentioneering library's own grammars, `experiment`, merging compute and aggregate stages.

## Verification

All edits first; then ONE run: `npm run lint:names`, `npm test`, `npm run test:integration`,
`npm run eval:check`; fix; commit; push. Tests assert on data.

Result (2026-10-11, dbt-v2): lint:names clean; unit 762/762; integration 310/311 — the one failure
was a refusal naming every source's properties for `semantic_index({ source: 'users', property })`
(the unknown-value shortcut in src/validate.js ignored the other pinned fields given); fixed, and
value-index re-run 27/27; eval:check — all 14 cases hold.
