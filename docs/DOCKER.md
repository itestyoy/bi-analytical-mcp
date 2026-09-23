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
- `MCP_ALLOWED_ORIGINS` — comma-separated browser origins allowed to call the endpoint. The spec
  requires a server to validate `Origin` (DNS-rebinding protection): a request **without** an Origin
  (every native client, every hosted connector calling from its backend) always passes, a loopback
  origin (`http://localhost:…`, the MCP Inspector) passes, and any other origin gets **403** unless it
  is listed here (`*` allows all — do not use it on a machine that also runs a browser).
- `MCP_ALLOWED_HOSTS` — optional comma-separated `host:port` values the `Host` header must match
  (a second fence against DNS rebinding). Unset = no Host check, which is what you want behind a proxy.
- `MCP_SESSION_IDLE_SECONDS` (default 3600) / `MCP_MAX_SESSIONS` (default 500) — a legacy session
  unused for that long is closed, and at most that many are held (least recently used first). A
  client whose session was reclaimed gets the 404 that makes it re-initialize.
- `MCP_TASK_AFTER_MS` (default 3000) — for a client that declared the Tasks extension, a call that
  has not finished in this long comes back as a task the host polls; `MCP_TASK_TTL_SECONDS` (default
  3600) — how long a finished task stays readable.
- `MCP_PROGRESS_INTERVAL_MS` (default 5000) — how often a call that carries a `progressToken` hears
  it is still working (clients may reset their request timeout on it).
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

## Protocol: two eras on one endpoint, three extensions
`/mcp` speaks both generations of MCP, chosen per request:

- **Legacy (2025-11-25 and earlier)** — `initialize`, then an `Mcp-Session-Id` on every call. What
  most clients speak today.
- **Modern (2026-07-28)** — stateless: no `initialize`, no session; every request carries its
  protocol version and the client's capabilities in `_meta`, and mirrors method and target into
  `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` headers (checked against the body —
  HeaderMismatch `-32020`). `server/discover` answers with the supported versions, capabilities and
  instructions; list results carry `ttlMs`/`cacheScope`; an unknown version is `-32022` naming the
  supported ones. A modern client that probes a legacy-only server gets the fallback the spec
  describes, and a legacy client is served as before.

On top of the core, three extensions are declared and served — they switch on the moment a client
declares them, and the plain tools stay exactly as they were for every client that does not:

- **Tasks** (`io.modelcontextprotocol/tasks`; and the 2025-11-25 experimental tasks on legacy
  sessions) — a call that outlives its request becomes a task the HOST polls; a build the engine
  hands back as a `query_id` is followed to its end, so the task's result is the rows. Cancelling a
  task stops its dbt process.
- **Skills** (`io.modelcontextprotocol/skills`) — the analyst procedure, every recipe and (where
  python models run) the python-stage guide, served as Agent Skills (`skills/list`, `skills/get`,
  files via `resources/read` with sha256 digests). Generated at startup from the same objects
  `semantic_index({ guide })` and `semantic_index({ recipe })` return — never a second copy.
- **Apps** (`io.modelcontextprotocol/ui`) — `query_semantic_model`, `get_query_result` and
  `experiment` render in the host's conversation as an interactive view (`ui://betti/result-view`):
  a sortable, filterable table with paging, a chart when the rows are a time series or a breakdown,
  the A/B result with its interval, the sample-size plan. (`semantic_index` has no view on purpose:
  it is the most frequent call and a view on every exploration step would bury the conversation.) The data reaches the view as `structuredContent`,
  sent only to a host that declared the extension (the host keeps it out of the model's context).

In both eras: `Origin` is validated (403), every refusal is a JSON-RPC error body (never an HTML
page — including a body that is not JSON, `-32700`), a client's cancellation (or a closed stream)
stops the call's dbt process, calls with a `progressToken` get heartbeats, and every tool declares
`readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`.

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

