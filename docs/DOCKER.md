# Running with Docker Compose

The MCP server runs with **no authentication** — put it behind your own network
boundary / proxy. Everything it needs is supplied via environment variables and
volumes (nothing hardcoded).

## Quick start
```bash
cp .env.example .env          # edit as needed
docker compose up --build
# → MCP (streamable HTTP) on http://localhost:3000/mcp   (health: /healthz)
```

The image is **generic** — no catalog, recipes, or dbt project is baked in. Everything
project-specific is supplied at runtime via compose volumes + env.

## What you provide
| What | How | Default |
|---|---|---|
| Your dbt project (profiles.yml + the events fact & users dim models) | volume `DBT_PROJECT_DIR` → `/dbt_project` | `./dbt_project` |
| The **catalog** | discovered from your dbt project's model YAMLs (`meta.mcp.role`) — no separate file | — |
| Recipes (optional) and/or a standalone catalog | volume `CONFIG_DIR` → `/config` | `./config` |
| Warehouse | the bundled `warehouse` Postgres service, or point profiles.yml at your own | local Postgres |
| Per-context workspace (generated models, results, jobs) | named volume `mcp_workspace` → `/workspace` | persisted |

### Catalog = your dbt model YAMLs
Tag your two source models in their normal dbt schema YAML under `meta.mcp` — the
server discovers them (no separate catalog file). Exactly ONE model per role:
```yaml
models:
  - name: fct_analytics_events
    meta: { mcp: { key: events, role: fact, anchor: true, primary_entity: event, known_events: [...] } }
    columns:
      - { name: appsflyer_id, data_type: string, meta: { mcp: { entity: { name: user, type: foreign } } } }
      - { name: device_time,  data_type: timestamp, meta: { mcp: { is_time: true } } }
      - { name: event_name,   data_type: string, meta: { mcp: { is_event_name: true } } }
      - { name: event_data,   data_type: json,   meta: { mcp: { is_event_data: true, properties: { ... } } } }
  - name: dim_users
    meta: { mcp: { key: users, role: dimension } }
    columns:
      - { name: appsflyer_id, data_type: string, meta: { mcp: { entity: { name: user, type: primary } } } }
      - { name: country, data_type: string }
```
Two models claiming the same role is a config error. Prefer a standalone catalog
file instead? Mount it and set `CATALOG_PATH=/config/catalog.yml`.

## Configuration (env vars)
- `PORT` — published port (default 3000). The container always binds `0.0.0.0`.
- `WAREHOUSE_DIALECT` — `postgres` | `bigquery`.
- `DBT_PROJECT_DIR` — host path to your dbt project (mounted at `/dbt_project`; used as both `DBT_BASE_PROJECT` and `DBT_PROFILES_DIR`; the catalog is discovered from its model YAMLs).
- `CONFIG_DIR` — host path mounted read-only at `/config` for optional `recipes.json` (and a standalone `catalog.yml` if you set `CATALOG_PATH`).
- `CATALOG_PATH` — optional; set to a standalone catalog file instead of project discovery.
- `QUERY_TIMEOUT_SECONDS`, `CONTEXT_TTL_MS` — query/GC tuning.
- `PYTHON_BUILD_GRACE_SECONDS` — how long a build that includes a **Python** model may hold the tool
  call before it hands back a `query_id` to poll. Unset, the RUNTIME decides: a remote one (BigFrames
  in a Colab Enterprise notebook, Spark on Dataproc, Snowpark) hands it back after 5 s, because it
  cold-starts for minutes and the calling client's own timeout — which the server cannot raise —
  would expire first (the caller sees "the server is not responding" while the build it started keeps
  running); a local one (DuckDB) keeps `QUERY_TIMEOUT_SECONDS`, because it finishes in seconds and
  returning the rows beats returning a job id. Set this to override both.
- `DBT_PG_HOST/PORT/USER/PASSWORD/DBNAME/SCHEMA` — warehouse connection, consumed by your `profiles.yml` via `env_var(...)`.

Your `profiles.yml` should read the connection from env, e.g.:
```yaml
analytics:
  target: prod
  outputs:
    prod:
      type: postgres
      host: "{{ env_var('DBT_PG_HOST') }}"
      port: "{{ env_var('DBT_PG_PORT') | int }}"
      user: "{{ env_var('DBT_PG_USER') }}"
      password: "{{ env_var('DBT_PG_PASSWORD') }}"
      dbname: "{{ env_var('DBT_PG_DBNAME') }}"
      schema: "{{ env_var('DBT_PG_SCHEMA') }}"
      threads: 4
```

## Notes
- The image bundles the `dbt` + `mf` (MetricFlow) CLIs (see `requirements.txt`); swap `dbt-postgres` for your adapter (e.g. `dbt-bigquery`) and rebuild.
- For an external/managed warehouse, delete the `warehouse` service and set the `DBT_PG_*` (or your profile's) vars to point at it.
- A dbt project (or an explicit `CATALOG_PATH`) is required — the image bakes no catalog. With a project mounted, build/query work via the bundled `dbt`/`mf` runner.

## BigQuery
BigQuery is a managed warehouse — there's no local DB service. Use the dedicated
compose file (it builds the image with the `dbt-bigquery` adapter via the
`DBT_REQUIREMENTS` build arg) and a GCP service-account key:
```bash
cp .env.bigquery.example .env     # set BQ_PROJECT / BQ_DATASET / BQ_KEYFILE
docker compose -f docker-compose.bigquery.yml up --build
```
- `WAREHOUSE_DIALECT=bigquery` (set by the file) so the engine generates BigQuery SQL.
- `BQ_PROJECT`, `BQ_DATASET`, `BQ_LOCATION` and the mounted key (`GOOGLE_APPLICATION_CREDENTIALS=/secrets/bq-key.json`) are consumed by your `profiles.yml`:
```yaml
analytics:
  target: prod
  outputs:
    prod:
      type: bigquery
      method: service-account
      keyfile: "{{ env_var('GOOGLE_APPLICATION_CREDENTIALS') }}"
      project: "{{ env_var('BQ_PROJECT') }}"
      dataset: "{{ env_var('BQ_DATASET') }}"
      location: "{{ env_var('BQ_LOCATION') }}"
      threads: 4
```

