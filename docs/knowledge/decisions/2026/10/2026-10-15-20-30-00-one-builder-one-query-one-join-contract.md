---
title: One builder, one query tool, one join contract
status: Active
last_reviewed: 2026-10-16
tags: [mcp, tools, schema, joins, semantic-layer, pipeline]
source_of_truth:
  - src/tools/core.js
  - src/schema.js
  - config/catalog.yml
  - AGENTS.md
supersedes: []
---

# One builder, one query tool, one join contract

## Status
Active — accepted by the owner on 2026-10-15; implemented step by step (see Order).

## Last Reviewed
2026-10-16

## Source Of Truth
The tool definitions (src/tools/core.js), their schemas (src/schema.js), the catalog (config/catalog.yml)
and the HARD RULES in AGENTS.md, as each step lands.

## Problem
After many surface fixes the schema kept two parallel paths for one job — two builders, two query tools,
three join spellings (`via`, `on: [...]`, `between`) — and a layer of hidden rules around it (earlier
spellings, `<task>_<metric>` names, joins that only warn). The owner asked for a schema that is plain,
transparent and strict.

## Decision

### Tools (14 → 11)
| was | becomes |
|---|---|
| `build_semantic_model`, `build_pipeline_model` | `build_model` |
| `query_semantic_model`, `query_pipeline_model` | `query_model` |
| `preview_semantic_model` | `context({ action: "describe" })` |

The old tools are removed at once — no aliases. The rest stays: `semantic_index`, `context`,
`delete_context`, `memory`, `experiment`, `display_model_result`, `drill_result`, `explore_errors`, `time`.

### `build_model`
A pipeline of steps, as `build_pipeline_model` is now. Actions: `start` (from a source or a task),
`add_steps`, `edit_step`, `fork`, `preview` (`validate: true` checks on the warehouse), `materialize`;
`insert_step`, `delete_step`, `truncate` go. Every expression function stays.

A new LAST-ONLY stage `semantic_model`. Its main model is implicit: the table the steps before it built,
or the source when it is the only step (today's `build_semantic_model`). Fields:
- `time` — the main model's time column (metric_time); required when steps precede it;
- `dimensions` — of the main model;
- `join` — joined models, by contract (below);
- `measures` — `{ name, expr, source? }`; with `source`, over a joined model;
- `metrics` — named as declared, unique in the context; a derived metric names metrics.
No `where` on the stage: filter the rows with a where step before it, or fold a `case` in the measure.

### `query_model`
A query is its steps. With a `metrics` step it computes the context's metrics (where steps before it, the
read stages after it); without one it reads the stored pipeline table in the read stages. Forms: start,
batch (`queries`, kinds mixed), read (`task_ids`), cancel. `limit` keeps its three meanings.

### The join contract — one form everywhere
`{ source, on: { <part>: <main-model column | value> } }`, in the `semantic_model` stage and in a
pipeline's join step alike.
1. Only a model whose catalog DECLARES a unique join key is joinable; uniqueness is trusted, not checked.
2. The catalog names the parts; every part is required, no other is taken, each model's form is closed.
3. A part is a key (equality on a main-model column), a time (a main-model column compared by the
   catalog's rule: a validity window, a period, the same day) or a select (a string value filtering the
   joined model first, checked against the value index).
4. The engine writes the join and says what it wrote.

In a pipeline join `with`, `via`, `on: [...]` and `between` go; fact-to-fact many-to-many joins go; a
joined model's amounts (`measure` columns) are not carried by `attrs` — they are measures of the stage.

Catalog, per joinable model (`config.meta.mcp.join`):
```yaml
join:
  unique: true
  key:    { user: player_id_of_internal }          # parts compared by equality
  time:   { within: [valid_from, valid_until] }    # or { same_day: <column> }
  select: { experiment: experiment_name }          # a value part, filtered before the join
```
`users` (user + time within its validity window), `experiments` (user + experiment), `acquisition` (user +
time on spend_date's day), `crashlytics` (user + funnel by the format's tracking id + format); an events
source declares none and is not joinable.

Amended while implementing (step 2): the experiments contract has NO time part. One row per player ×
experiment is already unique on (user, experiment), and a time window there would hide the
pre-assignment events CUPED reads as its covariate; the assignment window stays a where step on
assigned_at / ended_at, as the experiment recipes write it. Adding `time: { within: [assigned_at,
ended_at] }` to the catalog later is a one-line change.

Amended while implementing (step 3, agreed with the owner on 2026-10-16):
- `measures[].source` names any model of the semantic layer, not only a joined one. MetricFlow folds such a
  measure over that model's own rows and compares it beside the main model's on metric_time and the
  group-by; it joins no rows for it. So spend, events and crashes stay side by side, and `acquisition` is
  no `join`.
- `join` lists the models whose attributes the metrics are grouped and filtered by. Each is a model that
  owns a key another model carries, which is what MetricFlow joins onto (today: `users`). Its `on` is
  checked against that key when the step is added: each key part is the main model's column of the key, and
  the time part is the main model's time axis, because MetricFlow matches a slowly-changing model at the
  metric's time. A select part that filters the joined model is refused there; that join belongs to a step
  before the semantic_model step.
- A context holds one semantic layer: its build's semantic_model step. The step is changed by `edit_step`
  and `materialize` again, which replaces the layer the context held. `build_semantic_model`'s
  `action: "update"`, its `remove` and `cascade`, and a second task in one context are gone.
- The step is compiled when it is added and written and parsed by `materialize` (a task). Before that,
  `preview` shows its YAML.
- 3a (the step alone, over a catalog source) landed first; 3b (the step over a table the steps before it
  built) in its own commit. That table is a model of the context's own catalog (src/catalog/built-model.js):
  its time axis is the step's `time` (required there), its foreign keys are its joins' `on` columns, and it
  owns no key, so nothing joins onto it. A query names its columns `{ semantic_model: [<the build's name>],
  dimension }`. `materialize` builds the steps first, or reads the table that already stands for them,
  and then writes and parses the layer. The build is named apart from the catalog's models and keys.

Amended while implementing (step 4, 2026-10-16):
- The draft keeps `add_steps`, `edit_step` and `fork`; going back to step N is `fork` with `after: N`.
- `context({ action: "describe" })` adds the semantic layer as dbt parsed it to a context that holds one
  (narrowed by `metric` or `semantic_model`); with `validate: true` it starts the task the preview did. The
  task kind keeps its stored name, `preview_semantic_model`.
- Names are stored as declared. What MetricFlow refuses of a name is refused when the step is added: its
  spelling in the schema (two characters at least, no `__`, no trailing `_`), a time grain or a reserved
  word, a governed measure's name, and a name another element of the layer holds as another kind. A
  dimension declared over a column takes that column's own place.
- An input in an earlier spelling is refused by the schema like any value it does not take. Only kept
  state is converted: a draft's steps, an eventstream, a stored declaration or display, a recipe file. A
  `ratio` metric kind is hinted as `derived`.

### Removed
Input-side earlier-spelling converters (a stored draft still reads), the `<task>_<metric>` prefix, the five
old tools, the pipeline join's `via` / `between` / `on: [...]`.

## Order
Each step its own commit, with the full checks and the tool-list size before and after:
1. `query_model`; 2. the catalog `join` block and the pipeline join contract; 3. `build_model` with the
`semantic_model` stage; 4. cleanup (draft actions, converters, metric-name prefix, preview into
`context describe`); 5. recipes, guides, evals, tests, AGENTS.md, docs — then data tests for the new design.

## Consequences
- AGENTS.md HARD RULES rewritten: two sides → one builder and one query (sides stay inside the engine);
  the SCD `between` rule → the contract's time part; "a relationship nobody owns is a pipeline join" →
  removed; join keys stay declared in the schema, now with the parts and uniqueness; the earlier-spelling
  paragraph → removed; ONE VOCABULARY gains `{ source, on }`.
- MetricFlow's limits stay: no measure on a slowly-changing model, no conversion metric,
  `require_time_range` where the catalog asks for it.
