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
- `MCP_ALLOWED_ORIGINS` — comma-separated browser origin HOSTNAMES allowed to call the endpoint
  (port-agnostic, e.g. `console.example.com`). The spec requires a server to validate `Origin`
  (DNS-rebinding protection): a request **without** an Origin (every native client, every hosted
  connector calling from its backend) always passes, a loopback origin (`localhost`, `127.0.0.1`,
  the MCP Inspector) passes, and any other origin gets **403** unless it is listed here.
- `MCP_ALLOWED_HOSTS` — optional comma-separated hostnames the `Host` header must match (a second
  fence against DNS rebinding). Unset = no Host check, which is what you want behind a proxy.
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
- **Restarting the container loses nothing a client holds.** The server keeps no sessions (the SDK
  serves each request from a fresh server instance), so a client connected before a deploy keeps
  calling after it with no new handshake; a stale `Mcp-Session-Id` is ignored. (This replaced a
  session table that lived in the process: after a restart, clients got errors for a session id the
  new process had never issued until the connector was re-added by hand.)

## Protocol: MCP 2026-07-28 on the official SDK, plus three extensions
The server is built on the official MCP TypeScript SDK **v2** (`@modelcontextprotocol/server`), the
stable line that implements protocol revision **2026-07-28**. The same SDK — not a second code path
in this server — also answers clients that still open with the 2025 `initialize` handshake, which
is what today's hosts send; the SDK calls those two request shapes "eras", decides per request, and
serves both from one server factory (`createMcpHandler` → `src/mcp-server.js`). Nothing to configure.

What the SDK handles per the 2026-07-28 spec: `server/discover`, the per-request `_meta` envelope,
`MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` header checks (HeaderMismatch `-32020`),
`resultType` and `ttlMs`/`cacheScope` on results, `-32022` for an unknown version, progress on the
request's own stream, cancellation when the stream closes.

Three extensions are declared and served; each switches on the moment a client declares it, and
the plain tools stay exactly as they were for every client that does not:

- **Tasks** (`io.modelcontextprotocol/tasks`) — for a client that declares it, a call that has not
  finished in `MCP_TASK_AFTER_MS` comes back as a task (`resultType: "task"`) the HOST polls; a build
  the engine hands back as a `query_id` is followed to its end, so the task's result is the rows.
  `tasks/cancel` stops the call's dbt process. (The TypeScript SDK does not implement this extension
  yet and routes `tasks/get` / `tasks/cancel` as methods of the older revision, so those two are
  answered in front of it — `src/mcp-tasks.js`, with the SDK's own request classifier — until it does.)
- **Skills** (`io.modelcontextprotocol/skills`) — the analyst procedure, every recipe and (where
  python models run) the python-stage guide, served as Agent Skills (`skills/list`, `skills/get`,
  files via `resources/read` with sha256 digests). Generated at startup from the same objects
  `semantic_index({ guide })` and `semantic_index({ recipe })` return — never a second copy.
- **Apps** (`io.modelcontextprotocol/ui`) — `query_semantic_model`, `get_query_result` and
  `experiment` render in the host's conversation as an interactive view (`ui://betti/result-view.html`):
  a CHART (a time series or a breakdown, its rows folded underneath as a filterable, sortable table),
  a FUNNEL (steps, share of the first and of the previous, the biggest drop) and the A/B family — the
  TEST (a stat card per variant: lift, interval, verdict, the groups), the SAMPLE-RATIO CHECK (the
  observed split against the intended one) and the SAMPLE-SIZE PLAN. A spinner shows until the
  result arrives. Any other result — a failure (shown only as "Error"; the reason is in the reply),
  a build still running, SQL, rows with no chart shape — gets one quiet status line (the host keeps a minimum frame for the view, so drawing
  nothing would leave an empty box) and the text answer carries the rest.
  The view ONLY DRAWS: it reads the result the host hands it and nothing else. Every tool declares
  `_meta.ui.visibility: ["model"]` (a view may not call it), the view resource declares an empty
  `csp` (no connect, resource or frame origin) and the page carries the same Content-Security-Policy
  itself, and the view's code calls no server tool, resource, model message or link.
  (`semantic_index` has no view on purpose: it is the most frequent call and a view on every
  exploration step would bury the conversation.) The view is built like the official MCP Apps
  examples — the ext-apps `App` class, host theme and style variables, shadcn/ui components,
  Chart.js, one self-contained file from vite (`npm run build:app`, output checked in under
  `src/apps/result-view/dist/`).

Also: `Origin` is always validated (403), every refusal is a JSON-RPC error body (including a body
that is not JSON, `-32700`), every tool declares `readOnlyHint` / `destructiveHint` /
`idempotentHint` / `openWorldHint`, and every result carries `structuredContent` next to its text.

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

