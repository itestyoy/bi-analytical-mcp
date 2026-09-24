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

Protocol: MCP **2026-07-28** on the official TypeScript SDK v2 (which also answers clients that
still open with the 2025 handshake — no second code path here), plus the **Tasks**, **Skills** and
**Apps** extensions, active for a client that declares them and invisible to one that does not.
See [`docs/DOCKER.md`](docs/DOCKER.md#protocol-mcp-2026-07-28-on-the-official-sdk-plus-three-extensions).

Design docs:
- [`docs/dbt-semantic-layer-spec.md`](docs/dbt-semantic-layer-spec.md) — dbt SL spec
- [`docs/dbt-semantic-model-mcp-tool-design.md`](docs/dbt-semantic-model-mcp-tool-design.md) — tool design

## Tools

| Tool | Purpose |
|---|---|
| `semantic_index` | registry + discovery: models, events, properties, attributes, real values, recipes (`{ recipe: id }`), index status |
| `build_semantic_model` | declaratively create/augment SMs + metrics in an isolated context (one SM per table); `action: "update"` edits the task already there (add/remove measures, dimensions, metrics) |
| `build_pipeline_model` | compose a pipeline incrementally (start → add_step* → materialize) whose rows are the result; a `python` stage — anywhere, any number of times — is a dbt **Python model** of its own run on the warehouse's Python runtime; the pipeline builds as a chain of dbt models reading each other via `ref`, and steps work on the frame `dbt.ref()` returns there (BigFrames / Snowpark / PySpark), nothing is converted for them |
| `query_semantic_model` | run `mf query` against a context (metrics + group_by + where) |
| `context` | manage contexts: `{ action: list \| describe \| drop \| delete_model \| delete_semantic_model }` |

## Architecture

```
AI ──► build_semantic_model (enum-constrained)
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
returns one in full — ready-to-run, warehouse-proven payloads.

The recipes shipped with the server are per TECHNIQUE, not per business task: a
business shape differs per product, the technique does not. Five technical
families — `metric_types` (ratio, derived, cumulative, conversion window,
boolean measure, the aggregation chosen per question, a governed measure),
`joins` (an attribute of another model, a cohort grid on two time axes, two
independent sources, a pipeline join by relationship name, a point-in-time
join), `pipeline` (window lag, episodes by gap, an age axis, an ordered
sequence, unnest, reshape, a volume/coverage check), `ab_test` (proportion,
mean, CUPED, ratio, SRM, power) and `bigframes` (below). A real question
combines two or three of them. Domain recipes — your events, your funnels, your
conventions — go in a deployment file via `RECIPES_PATH`, which is merged on top
of the shipped set (your id wins on a collision).

One family is deliberately NOT organised by business task: `bigframes` recipes
(`bf_*`, offered only where dbt runs python models on that runtime) are one per
APPROACH — the correct form of a single move on the frame `dbt.ref()` returns
(a lookup, a per-group value, top-N, a threshold, `cache()`) and one per ML
capability (an estimator's parameters and where scaling goes, a prediction per
row, a supervised `fit(X, y)`, an evaluation with a split, PCA, categorical
features) — each carrying `approach` (the form that works) next to `instead_of`
(the form that raises, and why). A real question combines several, so the python
stage description is an INDEX of them — every id with the move it covers, under
an instruction to study them before writing a function — and the code forms
themselves live in the recipes and in `semantic_index({ guide: "python" })`.

Two entries in that family are GENERATED rather than written: a fact about an
external library belongs to the library, so `scripts/bigframes-facts.py` reads
the installed one into `config/bigframes-facts.json` and it is published as
`bf_ml_signatures` (every `bigframes.ml` constructor, positional vs
keyword-only) and `bf_frame_method_rules` (which methods need an ordering or an
index, and the signatures that surprise) — fetchable by id mid-write, and the
one source the guide, the failure hints and the recipes all render from. Where
each python text lives is written at the top of `src/python-guide.js`.

A deployment ADDS its own recipes via `RECIPES_PATH` (comma-separated files);
the shipped ones stay, and an id collision lets an operator override one
deliberately. See `config/recipes.json`, `docs/SCHEMA_AUTHORING.md` (§2d) and
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

A `python` stage may sit anywhere in the pipeline (first: it reads the source itself) and repeat: the
pipeline renders as a chain `pipe_<name>_s1 → _s2 → … → pipe_<name>` of SQL and Python dbt models,
each reading the previous via `ref`; a python stage declares `output.columns` so SQL stages after it
know its columns. The `python` stage exists in the tool schemas only where dbt can run Python models — decided
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
`build_semantic_model` → `dbt parse` → `mf query` and checks the returned rows.

Prerequisites for integration tests: `dbt-core`, `dbt-postgres`,
`dbt-metricflow[dbt-postgres]` available as `dbt`/`mf` (or via `DBT_BIN`/`MF_BIN`).
