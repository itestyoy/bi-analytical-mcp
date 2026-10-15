# Tool & SQL-Generation Architecture — the Pipeline Model

Status: **design (target architecture)**. Parts are already implemented (the
`prepare` stage registry, the chained-CTE lowering, the catalog, MetricFlow on
top, SQL config headers); the rest is the migration target this document defines.

## 1. Principle: one linear pipeline of stages (pipe syntax)

Everything the tool builds is a **linear pipeline**: a `source` followed by an
ordered list of **stages**, each transforming the table produced by the previous
one. This is exactly the shape of
[BigQuery pipe syntax](https://docs.cloud.google.com/bigquery/docs/reference/standard-sql/pipe-syntax):

```
FROM events
|> WHERE device_time >= '2026-01-01'
|> EXTEND ARRAY_LENGTH(...) AS n_words           -- compute
|> JOIN dim_users USING (user)                   -- join
|> MATCH_RECOGNIZE (...)                          -- sequence
|> AGGREGATE COUNT(*) AS users GROUP BY country   -- group_by
|> ORDER BY users DESC
|> LIMIT 100
```

We take pipe syntax as the **design basis** because it is:
- **linear & composable** — no nesting; each step reads the previous step's output. This maps 1:1 to a declarative JSON array of stages and to a chain of CTEs.
- **uniform** — `WHERE`, `EXTEND`, `AGGREGATE`, `JOIN`, `MATCH_RECOGNIZE`, `ORDER BY`, `LIMIT` are all just operators in the same chain. So **MATCH_RECOGNIZE is not special — it is one stage among many**, exactly as requested.
- **schema-threading** — each operator has a well-defined input table shape and output table shape, which is what makes validation and safety tractable.

The declarative tool input is a direct transcription of that pipe chain — its `steps`, each a
stage tagged by its `stage`:

```jsonc
{
  "source": "events",
  "steps": [
    { "stage": "where",  "conditions": [ ... ] },
    { "stage": "compute", "name": "n_words", "expr": { "fn": "array_length", "args": [ { "property": "words_collected" } ] } },
    { "stage": "unnest", "expr": { "property": "words_collected" }, "name": "word" },
    { "stage": "join",   "source": "users", "on": { "user": "player_id_of_internal", "time": "device_time" },
      "attrs": [ { "column": "country" } ] },
    { "stage": "match_recognize", "partition_by": [ { "entity": "user" }, "country" ], "steps": [ ... ] },
    { "stage": "aggregate", "group_by": ["country"], "measures": [ ... ] },
    { "stage": "order_by", "keys": [ ... ] },
    { "stage": "limit", "limit": 100 }
  ]
}
```

There is **no raw SQL** anywhere in the input — only stage objects with
catalog-constrained, enum/typed parameters. The engine generates the SQL. (`fn: "raw"` is the one
escape hatch, a build's — a read's schema has none —, its columns structured as arguments and quoted by
the server.)

What a stage holds — a condition, a measure, a computed value — is ONE expression grammar:
`{ fn, args: [expressions], …params }` over leaves (`{ column }`, `{ property, field? }`,
`{ value }`, `{ now: true }`), nested to any depth. A value has the type of what it is read from (a
property the catalog's declared type, a JSON field text, an array element the type it is stored as — a
native array's items, the warehouse's where it was asked, a JSON array's text) and is converted by one
function, `cast` — to `int` the number a value or a text holds, rounded half away from zero, alike on
both warehouses (each dialect's `castExpr` / `fromText`; a text only where it is written as a number
BigQuery reads, a value of no known type — a raw's — read as its text). Only `cast`, `case` and `raw`
say a type: a case's value is converted to it, a raw's is its caller's word, and a raw that says none
claims none. A constant is written in the type of what it is compared with (a number against a text is
its text; a text is not ordered against a number — cast it). A condition is an expression with a boolean value
(`eq`, `in`, `between`, `is_null`, a text test, `and` / `or` / `not`); a `where` is a list of them that
all hold; a measure is `{ name, expr }` whose expression folds rows (`sum`, `count`, `percentile` with
its `percentile`, a formula over several, an aggregate over a `case` for a conditional one — the case
missing on the rows it leaves out; an `else` folds them as its value, `average` of `then: 1, else: 0`
a share of the rows, and is refused only under `count` / `count_distinct` and their approximations:
`count` would count those rows, `count_distinct` their else value as one more). Every
tool that takes an expression carries ONE definition of each KIND of it its places take (`EXPR_KINDS`)
— the row expression `$defs.expr`; a semantic measure's `$defs.aggregate`, exactly one aggregate over
row expressions; a derived metric's `$defs.metric_expr` — a window function's `over` the window
`$defs.over`, an aggregate over a window's `$defs.over_frame` (with its frame), all built by one builder (`exprSchema`) for the tool's places: what a PLACE takes (a step over a source's rows, a read of stored
rows, a semantic model, a where before a metric query's metrics step, a derived metric) is one table, `PLACES`, and a tool's
definition holds the union of what its places take (`TOOL_PLACES`, `src/schema.js`) — of the leaves,
the rows' and the refs that name a value (`{ source, column }`, `{ source, property }`,
`{ semantic_model, dimension }`, `{ entity }`, `{ time }`, `{ metric }`), and of the functions — and
nothing else, so a read's has no `raw` and no event property and its schema refuses them. It is never
split per place inside a tool: where two places of one kind take different parts, each is checked as
the value is built by the one writer (`exprSql`), whose refusal names the place and what it takes —
both in `src/pipeline/compute.js`. A step is likewise one `$defs.stage` (its places in `STAGE_PLACES`,
`src/pipeline/stages.js`: a read's has no join, unnest, funnel or python stage) and a name of a catalog
or semantic-layer thing one `$defs.ref` (`REF_PLACES`, `src/schema/refs.js`: semantic_index's and
memory's hold the catalog's forms alone), each built the same way.

## 2. The stage registry (the "Lego")

A single registry defines every stage. Adding a stage = adding **one entry**;
nothing else in the engine changes. This already exists for `prepare`
(`src/prepare.js`) and is generalized here to the whole pipeline.

```
Stage = {
  name,                         // pipe operator name
  schema(catalog),              // JSON-Schema for its params (projected into the tool schema)
  plan({ inSchema, catalog }, params) -> { outSchema, requires },  // column/grain contract
  emit({ prev, dialect, catalog, columns }, params) -> SqlStep,    // SQL contribution
}
```

| stage | pipe operator | purpose | grain |
|---|---|---|---|
| `scan` (implicit source) | `FROM` | the events fact or users dim (catalog model) | rows of the source |
| `where` | `\|> WHERE` | row filter (scalar event_data props, columns, metric_time) | unchanged |
| `compute` | `\|> EXTEND` | add a column computed by one expression (`expr`, nested to any depth): an event property read where it is stored (the `{ property }` leaf, a field of a JSON object with `field`; `array_length` / `array_contains` on an array), a condition (stored as a boolean), arithmetic, round/floor/ceil/abs, coalesce/least/greatest, cast, **date_diff / date_trunc / date_part**, **CASE**, **window functions** (row_number/rank/lag/lead/running sum…) | unchanged |
| `unnest` | `\|> JOIN UNNEST` | explode an array (or array-of-struct field) into rows; the element has the type it is stored as (a native array's items, the warehouse's where it was asked; a JSON array's text; a native struct not claimed), converted by `cast` | **expands** |
| `join` | `\|> JOIN` | join a model on the JOIN CONTRACT it declares (`meta.mcp.join`): `{ source, on: { <part>: <a column of the rows \| a value> }, attrs }` — the key, the time (a validity window or the same day) and a select value; stages stack, so a chain can reach several models | unchanged (the contract's key is unique on the joined side) |
| `aggregate` | `\|> AGGREGATE … GROUP BY` | group + measures | **collapses** to group keys |
| `pivot` | `\|> AGGREGATE` | turn listed values of a column into columns — one aggregate expression (`measure`) per value, each cell folding only its rows — its condition a `case` over the aggregates' argument | **collapses** to group keys |
| `unpivot` | `\|> UNPIVOT` | fold listed columns into (name_column, value_column) rows; the result is `keep` + those two | **expands** |
| `match_recognize` | `\|> MATCH_RECOGNIZE` | row-pattern sequence → one row per match (per user/session) | **collapses** to one row per partition match |
| `project` | `\|> SELECT` | keep a column set (`keep`) or drop some (`drop`) | unchanged |
| `sample` | `\|> TABLESAMPLE` | keep a `share` of the rows (0 < share ≤ 1) for a fast approximate estimate (BigQuery TABLESAMPLE SYSTEM; DuckDB row-level random()) | unchanged |
| `order_by` | `\|> ORDER BY` | sort | unchanged |
| `limit` | `\|> LIMIT` | cap rows | unchanged |

**Implemented**: the registry is `src/pipeline/stages.js` (the functions of the one expression
grammar are one table in `src/pipeline/compute.js`, the pieces every stage is written with in
`src/pipeline/sql.js`), rendering is `src/pipeline.js`, and each warehouse lowers the op list
in `src/dialects/{base,duckdb,bigquery}.js`: `where`, `compute`, `unnest`, `join`,
`aggregate`, `pivot`, `unpivot`, `order_by`, `limit`, `sample`, `project`, plus
`match_recognize` (`src/match-recognize.js`) and `python` (`src/python-model.js`), which
register themselves — lowered to a DuckDB CTE chain and to BigQuery pipe syntax. A stage
declares what the machinery needs to know about it (`available` on this warehouse,
`keepsSourceRows`, the next-step hints it `recommend`s), so nothing outside the registry
names a stage.

A metric query's `metrics` step — its metrics broken down by `group_by`, one row per
combination, computed by MetricFlow — is in `query_model`'s `$defs.stage` beside these
stages, but it is no stage of the registry: a build never reaches it. Its one definition
(`METRICS_STEP`, `src/schema/fields.js`: its form, its group, what another place says of it) is
offered by the place that takes it (`STAGE_PLACES.metric_scope`: the steps up to it, `where` steps and
it), and every other place — a build's, a read's, the steps after it — refuses it in the words of
that definition, naming the place that refuses it.

New stages the request adds — `aggregate` (group_by), `join`, and
`match_recognize` (promoted from a bespoke renderer to a registry stage) — slot
in with no change to the pipeline machinery.

## 3. Column & grain tracking (consistency)

Each stage has a **plan()** contract that, given the input table's column set
(`inSchema`), returns the output column set (`outSchema`) and what it `requires`.
The engine folds `plan()` across the pipeline to compute, at each step, exactly
which columns are available — and **validates every reference against the schema
at that point in the chain** (no forward references, no vanished columns):

- `compute`/`unnest` **add** named columns (validated unique, valid identifier).
- `aggregate`/`match_recognize` **replace** the schema with their outputs (group keys + measures, or the per-match columns) — references after them must use the new names.
- `where`/`join`/`order_by` reference only columns present at that step.

This is the single source of truth for "what can I reference here", and it is
what `describe_*` reports back to the AI. Grain changes (`unnest` expands,
`aggregate`/`match_recognize` collapse) are explicit in the contract, so the
engine can reject nonsensical compositions (e.g. ordering by a column dropped by
an aggregate) before generating SQL.

## 4. Safety model (unchanged guarantees, applied per stage)

- **No raw SQL in, ever.** Inputs are stage objects; identifiers come from
  catalog enums (events, properties, attributes, entities) or are validated
  against the live pipeline schema; values are bound via `sqlLiteral`
  (escaped). JSON keys / column names pass strict identifier regexes.
- **Catalog is the boundary.** Scalar vs complex (array/struct) properties are
  distinguished: the catalog says which a property is, and a function that needs an
  array checks it when the stage is added — `array_length` / `array_contains` refuse a
  property not declared as an array, `element_at` / `array_last` an argument of a known
  non-array type. A complex prop is read in an expression — `array_length`,
  `array_contains`, the `{ property }` leaf (a struct's field with `field`; without it the
  whole value) — or expanded with `unnest`. `element_at` / `array_last`
  take an array of scalars (a native one, or what `json_parse_array` makes); an array of
  structs is read a field at a time, by `unnest` then `json_field`. A comparison or a
  grouping is not checked against the type: a condition comparing a whole array with a
  scalar is accepted and fails or misbehaves only at run time. A `join` can only target
  a model that declares a join contract (`meta.mcp.join`, src/catalog/joins.js), named in
  full: `on` names every part — a key or the time a column of the rows at that step, a
  select part a value. Its `attrs` are attributes, never amounts. Stages stack, so a chain
  reaches several models.
- **Per-stage validation** happens on the threaded schema (§3): unknown column →
  rejected at the boundary, with a clear message, before any SQL runs.
- **Generated SQL is read-only** and confined to the context overlay; results are
  materialized only as intended `qr_<id>` / `seq_<name>_<ctx>` relations.
- **Every generated SQL carries a `/* … */` header** with the source pipeline as
  YAML (already implemented), so output is auditable and reproducible.

## 5. SQL generation: one plan, two lowerings

The pipeline is lowered to SQL by walking the stages. The **same stage `emit()`**
targets either dialect:

Exactly **two dialects** are supported — `duckdb` and `bigquery` — each a class
in its own file (`src/dialects/duckdb.js`, `src/dialects/bigquery.js`)
implementing the abstract `Dialect` (`src/dialects/base.js`); callers take one
with `getDialect(name)` (`src/dialects/index.js`). The same op IR lowers two ways:

- **BigQuery → native pipe syntax.** Each stage emits its `|>` operator; the
  result is the pipeline verbatim (`FROM … |> WHERE … |> AGGREGATE … |> UNPIVOT …`).
- **DuckDB → nested CTE lowering.** Each stage becomes a CTE `p0, p1, …`, each
  `SELECT … FROM p{i-1}`. `unnest` → `CROSS JOIN LATERAL jsonb_array_elements*`;
  `aggregate` → `GROUP BY`; `unpivot` → a `UNION ALL` of one branch per folded column.
  `pivot` is the aggregate stage's conditional aggregates on both — each cell its aggregate over a case
  (`sum(CASE WHEN on = v THEN val END)`).
  Semantics match the BigQuery pipe lowering step-for-step — one meaning on both warehouses: a week
  is the ISO week (Monday start), `date_part` dow is ISO (Monday 1 … Sunday 7), `date_diff` counts
  whole units elapsed, and NULLs sort last unless a sort key says first.

A dialect that supports a stage natively uses it; one that does not uses the
lowering (or the choice is not offered for that dialect, and refused with a clear error — as a
funnel's `between_steps: "none"`, each step the immediately next event, is on DuckDB).

## 6. Where dbt + MetricFlow fit

The pipeline produces a **dbt model** (view by default, table when materialized),
with the YAML config header. Two consumption modes, unchanged:

1. **Semantic layer on top.** A MetricFlow semantic model is declared over the
   pipeline's output (shared `user` entity → joins to `dim_users` at query time).
   Metrics/dimensions are queried via `query_model`, a query of `steps`: where steps,
   one `metrics` step, then the same read stages re-slicing the metric result (a where step on a
   metric is a having). This is
   how the `match_recognize` pipeline is consumed today.
2. **Direct materialization.** `query_model(materialize:true)` stores a
   result (after its steps) as a table named after its task; a pipeline started from that task
   (`build_pipeline_model({ action: 'start', name, from_task })`) re-slices it with the same
   stage vocabulary (`where` / `aggregate` / `order_by` / `limit` …), reused.

`build_semantic_model` stays the declarative way to define measures/metrics over
the **scalar** two-source models. **A pipeline built in one call (`_buildPipeline`) is the pipeline
creator**: it accepts a `pipeline` (`source` + ordered stages — where/compute/unnest/join/
aggregate/pivot/unpivot/sample/order_by/limit/project and the `match_recognize` funnel stage;
window functions are compute expressions). A `pipeline` is materialized as a dbt model whose rows ARE the
result (the build is a task: `query_model({ task_ids: [id] })` returns and pages its rows,
`query_model({ context_id, steps })` filters and regroups the built model in steps of the
pipeline's own stages — where, compute, aggregate, pivot, unpivot, order_by, limit, sample, project,
rendered by `renderRead` into one statement over the stored table; `dry_run: true` returns that
statement instead of its rows — and a pipeline started from it
with `from_task` re-slices them with every stage).

### 6.1 Continuing a pipeline on top of what it already built (checkpoints)

`materialize` does not end the incremental builder's draft. The table it built
STANDS FOR the steps taken so far, and the draft records that as a **checkpoint**
(`{ at, model, owner, columns, built_at, index_run_id }`). The steps added next are
rendered from `{{ ref(<checkpoint model>) }}` with the checkpoint's columns as their
starting set — the same cut `renderPipeline` already makes at a python stage, for a
second reason. An expensive prefix (a per-player aggregate, a python model with a
clustering) is therefore paid for once, and several materializations chain into
several checkpoints.

Because the draft owns the edit sequence, invalidation is **positional** and needs
no hashing: `edit_step(i)` / `insert_step(i)` / `delete_step(i)` retire every
checkpoint with `at >= i`, `truncate(after)` those with `at > after`, and appending
retires none. Freshness is not positional, so it rides on the value index's own run
marker: a completed index scan (whatever it found) means the source data may have
moved, and every checkpoint taken before it is retired. Each build takes its own
model name (`_c2`, `_c3`, …) so a rebuild never overwrites the table it reads.

What may FOLLOW a checkpoint is decided by the columns that survived into it, by the
same rule every stage already obeys: a funnel needs the source's event-name and time
columns, a payload read needs the flattened column or the blob. After a checkpoint
built from an aggregate they are gone and such a stage is refused, naming what
dropped out; after one that only filtered/joined events they are intact and the
funnel runs over the materialized slice. The checkpoint records `carries_source` so
that question is answerable from it alone.

`fork` inherits the checkpoints it keeps (`at <= after`) and copies their model
definitions into the fork's overlay — a context is a copy of the BASE project, so
`ref` would not otherwise resolve there; nothing is rebuilt, because every build
selects its own models by name. Both contexts then read the SAME physical table (the
model name carries its owner's context id, so there is no collision), which makes
branching variants over an expensive prefix cheap — and makes dropping the owner a
refusal that names the consumers, unless forced.

## 7. Migration path (from today's code)

Already in place: the stage registry pattern (`src/prepare.js`), chained-CTE
lowering, dialect array/struct helpers (`src/dialects/`), catalog complex-type
declarations + scalar guards, SQL config headers (`src/sql-header.js`), and
MATCH_RECOGNIZE as a generator with a CTE equivalent (DuckDB).

Steps to reach the target:
1. **Generalize `prepare` → `pipeline`**: lift the `src/prepare.js` registry to
   the top-level pipeline; give each stage a `plan()` (schema/grain contract)
   alongside `emit()`.
2. **Promote `match_recognize` to a stage** (`emit` = current renderers; `plan`
   = its per-match output columns). The bespoke one-call pipeline path (`_buildPipeline`)
   becomes "pipeline ending in a `match_recognize` stage".
3. **Add `aggregate` (group_by) and `join` stages** to the registry.
4. **Add the BigQuery pipe-syntax emitter** next to the CTE lowering; pick per
   dialect.
5. **Thread the schema** (§3) so every stage validates references against the
   live column set, and `describe_*` reports it.

## 8. Worked example — activation funnel for US users, by platform

Declarative pipeline:
```jsonc
{
  "source": "events",
  "time_range": { "start": "2026-01-01" },
  "steps": [
    { "stage": "join",   "source": "users", "on": { "user": "player_id_of_internal", "time": "device_time" },
      "attrs": [ { "column": "country" }, { "column": "platform" } ] },
    { "stage": "where",  "conditions": [ { "fn": "eq", "args": [ { "column": "country" }, { "value": "US" } ] } ] },
    { "stage": "compute", "name": "n_words", "expr": { "fn": "array_length", "args": [ { "property": "words_collected" } ] } },
    { "stage": "match_recognize", "partition_by": [ { "entity": "user" }, "platform" ],
      "steps": [ { "name": "launch", "event_name": ["first_launch"] },
                 { "name": "lvl1",   "event_name": ["level_completed"], "where": [ { "fn": "eq", "args": [ { "property": "level_id_of_event_data" }, { "value": 1 } ] } ] } ],
      "capture": [ { "name": "words_at_lvl1", "step": "lvl1", "column": "n_words" } ] },
    { "stage": "aggregate", "group_by": ["furthest_step_name", "platform"],
      "measures": [ { "name": "users", "expr": { "fn": "count" } }, { "name": "avg_words", "expr": { "fn": "average", "args": [ { "column": "words_at_lvl1" } ] } } ] }
  ]
}
```
`users` holds several versions of a player (a validity window per install record), so the
join states the point in time it reads them at: `between` keeps the version valid at the
event's `device_time`; without it every version matches and the counts inflate.

The `time_range` is applied first, as a leading `where` on the source's time column. The
pipeline lowers to BigQuery pipe syntax directly, or to a CTE chain
`p0 (where: the time_range window) → p1 (join) → p2 (where) → p3 (extend n_words) →
p4 (match_recognize per user and platform) → p5 (aggregate)` on DuckDB — with a
`/* <this config as YAML> */` header.

---

### Summary

One **linear, pipe-syntax-shaped pipeline**; **every transform is a stage** in a
single registry (filter, compute, unnest, join, aggregate/group_by, and
match_recognize alike); a **threaded schema** gives per-stage validation and
consistency; **safety** comes from catalog-enum params + literal binding + no raw
SQL + per-stage reference checks; and the same plan **lowers to BigQuery pipe
syntax natively or to nested CTEs elsewhere**, emitted as a dbt model with a YAML
config header and consumed by MetricFlow. This unifies `prepare`, the native
sequence model, and the reads of a stored result (the same stages, run read-only) under one
extensible, safe, consistent model, written in one expression grammar.
