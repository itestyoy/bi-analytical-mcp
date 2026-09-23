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
Tag your source models in their normal dbt schema YAML under `config.meta.mcp` — the
server discovers them (no separate catalog file). Exactly ONE model per role:
```yaml
models:
  - name: fct_analytics_events
    config:
      meta: { mcp: { role: events, primary_entity: event, known_events: [...] } }
    columns:
      - name: appsflyer_id
        data_type: string
        config: { meta: { mcp: { entity: { name: user, type: foreign } } } }
      - name: device_time
        data_type: timestamp
        config: { meta: { mcp: { is_time: true } } }
      - name: event_name
        data_type: string
        config: { meta: { mcp: { is_event_name: true } } }
      - name: event_data
        data_type: json
        config: { meta: { mcp: { is_event_data: true, properties: { ... } } } }
  - name: dim_users
    config:
      meta: { mcp: { role: users } }
    columns:
      - name: appsflyer_id
        data_type: string
        config: { meta: { mcp: { entity: { name: user, type: primary } } } }
      - name: country
        data_type: string
```
`meta` sits under `config:` because **dbt 1.10 moved it there**: dbt Core 1.11 still reads the old
top-level `meta:` and only warns, but dbt Fusion calls that key unknown (`UnusedConfigKey`, dbt1060)
and drops it — which would leave this server with an empty catalog. The loader accepts both places
(`config` wins per key), and `python3 scripts/meta-to-config.py --check <path>` moves an existing
project (`--write` to apply; it keeps your comments and verifies the result before writing).
Two models claiming the same role is a config error. Prefer a standalone catalog
file instead? Mount it and set `CATALOG_PATH=/config/catalog.yml`.

## Configuration (env vars)
- `PORT` — published port (default 3000). The container always binds `0.0.0.0`.
- `WAREHOUSE_DIALECT` — `postgres` | `bigquery`.
- `DBT_PROJECT_DIR` — host path to your dbt project (mounted at `/dbt_project`; used as both `DBT_BASE_PROJECT` and `DBT_PROFILES_DIR`; the catalog is discovered from its model YAMLs).
- `CONFIG_DIR` — host path mounted read-only at `/config` for optional `recipes.json` (and a standalone `catalog.yml` if you set `CATALOG_PATH`).
- `CATALOG_PATH` — optional; set to a standalone catalog file instead of project discovery.
- `QUERY_TIMEOUT_SECONDS` — how long an **SQL** build may hold the tool call before it hands back a
  `query_id` to poll (default **20 s**). It cancels nothing: past it the build runs on in the
  background and the caller polls `get_query_result`. **Values above 30 s are capped at 30**, with a
  line on stderr saying so — a longer wait inside one tool call outlives the calling client's own
  timeout, which this server cannot raise, and the caller then sees "the server is not responding"
  while the build it started keeps running unseen. The same window bounds the WAREHOUSE READS that
  merely enrich an answer — the physical column set a source is grounded to, the freshness of its
  time column, a row estimate: past it the call answers without that extra (exactly as it does when
  there is no runner at all) while the read finishes in the background and is cached for the next
  call. Otherwise the first such call after a restart, with a cold dbt process, would sit on dbt's
  own 10-minute timeout (`DBT_TIMEOUT_SECONDS`) and the client would report a generic tool failure.
- `CONTEXT_TTL_MS` — context GC tuning.
- `PYTHON_BUILD_GRACE_SECONDS` — the same window for a build that includes a **Python** model, which
  is a different figure. Unset, the RUNTIME decides: a remote one (BigFrames in a Colab Enterprise
  notebook, Spark on Dataproc, Snowpark) hands the `query_id` back after 5 s, because it cold-starts
  for minutes; a local one (DuckDB) keeps `QUERY_TIMEOUT_SECONDS`, because it finishes in seconds and
  returning the rows beats returning a job id. Set this to override both; the same 30 s ceiling
  applies.
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
- **Restarting the container ends every MCP session, and clients recover by themselves.** Sessions
  (`Mcp-Session-Id`) live in the process, so a redeploy makes every id a client is holding unknown.
  An unknown id is answered with **404** — the status the spec reserves for exactly this, and the one
  that makes a client open a new session — and `initialize` ignores the header entirely, so a client
  that keeps sending the dead id still gets a fresh session on its next call. Both answers are a
  JSON-RPC error body, not an HTML page. (Before that, an unknown id was a 400: the client could only
  retry the same doomed request, and the connector had to be removed and re-added by hand.)

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

