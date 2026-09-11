# dbt Semantic Layer MCP server

A **streamable-HTTP MCP server** that lets an AI **declaratively** build *virtual*
dbt semantic models on the fly (fully JSON-Schema / enum constrained), render the
YAML, run `dbt parse`, and query them via **MetricFlow (`mf`, dbt Core)** — all
isolated per execution **context**.

SQL generation and joins are delegated to dbt/MetricFlow; the AI only declares
typed semantic objects whose column/property/event names come from a **catalog**
(two+ dbt models: one or more events facts — each with its own event vocabulary, e.g.
product-analytics events and crash reports — a user-attributes dimension, and optional
dimension models such as experiment assignments).

Design docs:
- [`docs/dbt-semantic-layer-spec.md`](docs/dbt-semantic-layer-spec.md) — dbt SL spec
- [`docs/dbt-semantic-model-mcp-tool-design.md`](docs/dbt-semantic-model-mcp-tool-design.md) — tool design

## Tools

| Tool | Purpose |
|---|---|
| `semantic_index` | registry + discovery: models, events, properties, attributes, real values, recipes (`{ recipe: id }`), index status |
| `create_semantic_model` | declaratively create/augment SMs + metrics in an isolated context (one SM per table) |
| `build_native_model` | compose a pipeline incrementally (start → add_step* → materialize) whose rows are the result; a final `python` stage turns the pipeline into a dbt **Python model** run on the warehouse's Python runtime — steps work on the frame `dbt.ref()` returns there (BigFrames / Snowpark / PySpark), nothing is converted for them |
| `query_semantic_model` | run `mf query` against a context (metrics + group_by + where) |
| `update_semantic_model` | add/remove task measures, dimensions, metrics in a context |
| `context` | manage contexts: `{ action: list \| describe \| drop \| delete_model \| delete_semantic_model }` |

## Architecture

```
AI ──► create_semantic_model (enum-constrained)
          └─ compile → render YAML → .mcp/ctx/<id>/models/generated/context.yml → dbt parse
AI ──► query_semantic_model (enum-constrained)
          └─ mf query (dbt Core) in the context overlay → rows
```

- **Catalog → enums** (`src/catalog.js`, `src/schema.js`): every column/property/
  event name is a JSON-Schema enum projected from the catalog; ajv rejects unknown
  names at the boundary (`src/validate.js`).
- **Compile** (`src/compile.js`): declaration → dbt measures/dimensions/metrics.
  Event scope is baked into each measure `expr` (`CASE WHEN …`); `ratio` operands
  are auto-wrapped in `simple` metrics (dbt requires metric refs). Namespacing
  uses a single underscore (dbt 1.11 forbids `__` in names).
- **Render** (`src/yaml-render.js`): exactly one semantic model per dbt model per
  context (base template + task additions).
- **Contexts** (`src/context-manager.js`): per-context overlay dbt project +
  persistent, disk-reconciled registry, leases, teardown.
- **Runner** (`src/dbt-runner.js`): shells `dbt parse` and `mf query` (NOT
  `dbt sl query`, which is dbt-platform/remote and incompatible with local
  per-context isolation). A warm-process programmatic backend
  (`src/backends/mf-engine.js` + `python/mf_sidecar.py`) is a drop-in alternative.
- **Time spine** is a predefined model **always present** in every context:
  `ContextManager.ensureTimeSpine` writes a dialect-aware `metricflow_time_spine`
  if the base project doesn't already define one (required for `metric_time`,
  cumulative and conversion metrics). It must be materialized once in the
  warehouse (`dbt run --select metricflow_time_spine`).
- **Errors** are surfaced clearly: tool results carry
  `error: { stage: 'validate'|'compile'|'parse'|'query', message, field }`,
  with dbt/MetricFlow output cleaned (ANSI + log timestamps stripped, the
  meaningful Error/Database Error/Parsing Error portion surfaced). Path/metric
  validation errors are actionable (e.g. "add use_base_models including 'users'").

## Recipes

The `semantic_index` overview lists recipe ids and `semantic_index({ recipe: id })`
returns one in full — ready-to-run templates for common analytics task types
(trends, segmentation, funnel, retention, cohort, behavioral, conversion, level
progression, monetization, stickiness) — each a valid `create_semantic_model`
payload + example queries. See `config/recipes.json` and
`docs/analytics-task-taxonomy.md`.

## Run

```bash
npm install
# point at a dbt Core project whose fact/dim tables + metricflow_time_spine are built
DBT_BASE_PROJECT=/path/to/dbt_project \
DBT_PROFILES_DIR=/path/to/dbt_project \
DBT_BIN=dbt MF_BIN=mf \
CATALOG_PATH=./config/catalog.json \
npm start            # streamable-HTTP MCP on :3000/mcp
```

## Tests

```bash
npm test                 # unit tests (pure JS, no dbt needed)
npm run test:integration # end-to-end: dbt Core + MetricFlow against PGlite (auto-skips if dbt/mf absent)
```

The `python` stage exists in the tool schemas only where dbt can run Python models — decided
from the active dbt profile (BigQuery with `submission_method` / a Dataproc or BigFrames region,
Snowflake, Databricks, DuckDB); on Postgres it is absent and `semantic_index()` says why under
`python_models`. `MCP_PYTHON_MODELS=on|off` overrides the decision.

The `python` pipeline stage is proven on **dbt-duckdb** — the one adapter that runs dbt Python
models locally (dbt-postgres cannot). It lives in its own venv so it never touches the
MetricFlow one:

```bash
python3 -m venv .duckvenv && .duckvenv/bin/pip install "dbt-duckdb>=1.9" pandas pyarrow
node --test test/integration/python-stage.test.js   # auto-skips when .duckvenv is absent
```

The integration suite boots an in-process **PGlite** database exposed over a TCP
socket (`@electric-sql/pglite-socket`), so the Python `dbt-postgres` adapter
connects without a real Postgres server. It builds the base project, then runs
`create_semantic_model` → `dbt parse` → `mf query` and checks the returned rows.

Prerequisites for integration tests: `dbt-core`, `dbt-postgres`,
`dbt-metricflow[dbt-postgres]` available as `dbt`/`mf` (or via `DBT_BIN`/`MF_BIN`).
