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

## What you provide
| What | How | Default |
|---|---|---|
| Your dbt project (profiles.yml + the events fact & users dim models) | volume `DBT_PROJECT_DIR` → `/dbt_project` | `./dbt_project` |
| Catalog + recipes describing those models | volume `CONFIG_DIR` → `/app/config` | bundled `./config` |
| Warehouse | the bundled `warehouse` Postgres service, or point profiles.yml at your own | local Postgres |
| Per-context workspace (generated models, results, jobs) | named volume `mcp_workspace` → `/workspace` | persisted |

## Configuration (env vars)
- `PORT` — published port (default 3000). The container always binds `0.0.0.0`.
- `WAREHOUSE_DIALECT` — `postgres` | `bigquery`.
- `DBT_PROJECT_DIR` — host path to your dbt project (mounted at `/dbt_project`; used as both `DBT_BASE_PROJECT` and `DBT_PROFILES_DIR`).
- `CONFIG_DIR` — host path with `catalog.yml` + `recipes.json` (mounted read-only).
- `QUERY_TIMEOUT_SECONDS`, `CONTEXT_TTL_MS` — query/GC tuning.
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
- Without a dbt project mounted the server still starts and validates inputs (dry-run), but build/query need the runner.

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

