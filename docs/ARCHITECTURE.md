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
|> EXTEND ARRAY_LENGTH(...) AS n_words           -- derive
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

The declarative tool input is a direct transcription of that pipe chain:

```jsonc
{
  "source": "events",
  "pipeline": [
    { "stage": "where",  "conditions": [ ... ] },
    { "stage": "derive", "name": "n_words", "source": "words_collected", "op": "array_length" },
    { "stage": "unnest", "source": "words_collected", "as": "word" },
    { "stage": "join",   "with": "users", "on": "user" },
    { "stage": "match_recognize", "partition_by": "user", "steps": [ ... ], "metrics": [ ... ] },
    { "stage": "aggregate", "group_by": ["country"], "measures": [ ... ] },
    { "stage": "order_by", "keys": [ ... ] },
    { "stage": "limit", "n": 100 }
  ]
}
```

There is **no raw SQL** anywhere in the input — only stage objects with
catalog-constrained, enum/typed parameters. The engine generates the SQL.

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
| `derive` | `\|> EXTEND` | add a scalar column from an event_data property (extract / array_length / contains / struct_field) | unchanged |
| `compute` | `\|> EXTEND` | add a column over existing columns: arithmetic, round/floor/ceil/abs, coalesce/least/greatest, cast, **date_diff / date_trunc / date_part**, **CASE**, **window functions** (row_number/rank/lag/lead/running sum…) | unchanged |
| `unnest` | `\|> JOIN UNNEST` | explode an array (or array-of-struct field) into rows | **expands** |
| `join` | `\|> JOIN` | join another catalog model on a shared entity (1-hop) | unchanged (1:1 / many:1) |
| `aggregate` | `\|> AGGREGATE … GROUP BY` | group + measures | **collapses** to group keys |
| `pivot` | `\|> PIVOT` | turn listed values of a column into columns | **collapses** to group keys |
| `unpivot` | `\|> UNPIVOT` | fold listed columns into (name, value) rows | **expands** |
| `match_recognize` | `\|> MATCH_RECOGNIZE` | row-pattern sequence → one row per match (per user/session) | **collapses** to one row per partition match |
| `project` | `\|> SELECT` | keep/rename a column set | unchanged |
| `sample` | `\|> TABLESAMPLE` | keep ~N% of rows for a fast approximate estimate (BigQuery TABLESAMPLE SYSTEM; Postgres row-level random()) | unchanged |
| `order_by` | `\|> ORDER BY` | sort | unchanged |
| `limit` | `\|> LIMIT` | cap rows | unchanged |

**Implemented** (`src/pipeline.js` + `src/dialects/{base,postgres,bigquery}.js`):
`where`, `derive`, `unnest`, `join`, `aggregate`, `pivot`, `unpivot`, `order_by`,
`limit`, `project` — lowered to a Postgres CTE chain (data-tested via `dbt show`:
aggregate / pivot / unpivot) and to BigQuery pipe syntax. Remaining:
`match_recognize` as a registry stage (today a dedicated renderer consuming the
prepared relation).

New stages the request adds — `aggregate` (group_by), `join`, and
`match_recognize` (promoted from a bespoke renderer to a registry stage) — slot
in with no change to the pipeline machinery.

## 3. Column & grain tracking (consistency)

Each stage has a **plan()** contract that, given the input table's column set
(`inSchema`), returns the output column set (`outSchema`) and what it `requires`.
The engine folds `plan()` across the pipeline to compute, at each step, exactly
which columns are available — and **validates every reference against the schema
at that point in the chain** (no forward references, no vanished columns):

- `derive`/`unnest` **add** named columns (validated unique, valid identifier).
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
  distinguished: complex props are rejected where a scalar is required and may
  only be consumed by `derive`/`unnest`. Joins are restricted to 1-hop entity
  paths defined in the catalog (the two-source rule holds — `join` can only
  target a catalog model on a shared entity).
- **Per-stage validation** happens on the threaded schema (§3): unknown column →
  rejected at the boundary, with a clear message, before any SQL runs.
- **Generated SQL is read-only** and confined to the context overlay; results are
  materialized only as intended `qr_<id>` / `seq_<name>_<ctx>` relations.
- **Every generated SQL carries a `/* … */` header** with the source pipeline as
  YAML (already implemented), so output is auditable and reproducible.

## 5. SQL generation: one plan, two lowerings

The pipeline is lowered to SQL by walking the stages. The **same stage `emit()`**
targets either dialect:

Exactly **two dialects** are supported — `postgres` and `bigquery` — each a class
in its own file (`src/dialects/postgres.js`, `src/dialects/bigquery.js`)
implementing the abstract `Dialect` (`src/dialects/base.js`). `src/dialect.js` is
a thin functional facade that delegates to them (so existing callers are
unchanged). The same op IR lowers two ways:

- **BigQuery → native pipe syntax.** Each stage emits its `|>` operator; the
  result is the pipeline verbatim (`FROM … |> WHERE … |> AGGREGATE … |> PIVOT …`).
- **Postgres → nested CTE lowering.** Each stage becomes a CTE `p0, p1, …`, each
  `SELECT … FROM p{i-1}`. `unnest` → `CROSS JOIN LATERAL jsonb_array_elements*`;
  `aggregate` → `GROUP BY`; `pivot` → conditional aggregation
  (`sum(CASE WHEN on = v THEN val END)`); `unpivot` → `CROSS JOIN LATERAL (VALUES …)`.
  Semantics match the BigQuery pipe lowering step-for-step.

A dialect that supports a stage natively uses it; one that does not uses the
lowering (or the stage is rejected for that dialect with a clear error, as
`strict` MATCH_RECOGNIZE already is on Postgres).

## 6. Where dbt + MetricFlow fit

The pipeline produces a **dbt model** (view by default, table when materialized),
with the YAML config header. Two consumption modes, unchanged:

1. **Semantic layer on top.** A MetricFlow semantic model is declared over the
   pipeline's output (shared `user` entity → joins to `dim_users` at query time).
   Metrics/dimensions are queried via `query_semantic_model`. This is how the
   `match_recognize` pipeline is consumed today.
2. **Direct materialization.** `query_semantic_model(materialize:true)` and the
   `get_query_result` transform are themselves a tiny pipeline (`where` /
   `aggregate` / `order_by` / `limit`) over a stored result — the same stage
   vocabulary, reused.

`create_semantic_model` stays the declarative way to define measures/metrics over
the **scalar** two-source models; `register_native_model` becomes "register a
**pipeline** as a model" (its `sequence`+`prepare` today is the pipeline's
`match_recognize`+`derive`/`unnest` stages).

## 7. Migration path (from today's code)

Already in place: the stage registry pattern (`src/prepare.js`), chained-CTE
lowering, dialect array/struct helpers (`src/dialect.js`), catalog complex-type
declarations + scalar guards, SQL config headers (`src/sql-header.js`), and
MATCH_RECOGNIZE as a generator with a Postgres equivalent.

Steps to reach the target:
1. **Generalize `prepare` → `pipeline`**: lift the `src/prepare.js` registry to
   the top-level pipeline; give each stage a `plan()` (schema/grain contract)
   alongside `emit()`.
2. **Promote `match_recognize` to a stage** (`emit` = current renderers; `plan`
   = its per-match output columns). The bespoke `register_native_model` path
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
  "pipeline": [
    { "stage": "where",  "conditions": [ { "field": "metric_time", "op": "gte", "value": "2026-01-01" } ] },
    { "stage": "where",  "user_segment": [ { "property": "country", "op": "eq", "value": "US" } ] },
    { "stage": "derive", "name": "n_words", "source": "words_collected", "op": "array_length" },
    { "stage": "match_recognize", "partition_by": "user", "mode": "ordered",
      "steps": [ { "name": "launch", "event_name": ["first_launch"] },
                 { "name": "lvl1",   "event_name": ["level_completed"], "where": [ { "property": "level_id", "op": "eq", "value": 1 } ] } ],
      "metrics": [ { "name": "avg_words", "type": "agg_at_step", "agg": "avg", "property": "n_words", "step": "lvl1" } ] },
    { "stage": "aggregate", "group_by": ["furthest_step_name", "user__platform"], "measures": [ { "name": "users", "agg": "count" } ] }
  ]
}
```
Lowers to BigQuery pipe syntax directly, or to a CTE chain
`p0 (where) → p1 (where) → p2 (extend n_words) → p3 (match_recognize per-user) →
p4 (aggregate)` on Postgres — with a `/* <this config as YAML> */` header.

---

### Summary

One **linear, pipe-syntax-shaped pipeline**; **every transform is a stage** in a
single registry (filter, derive, unnest, join, aggregate/group_by, and
match_recognize alike); a **threaded schema** gives per-stage validation and
consistency; **safety** comes from catalog-enum params + literal binding + no raw
SQL + per-stage reference checks; and the same plan **lowers to BigQuery pipe
syntax natively or to nested CTEs elsewhere**, emitted as a dbt model with a YAML
config header and consumed by MetricFlow. This unifies `prepare`, the native
sequence model, and the result-transform under one extensible, safe, consistent
model.
