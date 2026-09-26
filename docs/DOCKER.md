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
| Warehouse | a DuckDB file on the `warehouse` volume (`DUCKDB_PATH`), or BigQuery via `docker-compose.bigquery.yml` | local DuckDB |
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
- `WAREHOUSE_DIALECT` — `duckdb` | `bigquery`.
- `DBT_PROJECT_DIR` — host path to your dbt project (mounted at `/dbt_project`; used as both `DBT_BASE_PROJECT` and `DBT_PROFILES_DIR`; the catalog is discovered from its model YAMLs).
- `CONFIG_DIR` — host path mounted read-only at `/config` for optional `recipes.json` (and a standalone `catalog.yml` if you set `CATALOG_PATH`).
- `CATALOG_PATH` — optional; set to a standalone catalog file instead of project discovery.
- `QUERY_TIMEOUT_SECONDS` — how long a WAREHOUSE READ that merely enriches an answer may hold the
  call (default **20 s**) — the physical column set a source is grounded to, the freshness of its
  time column, a row estimate: past it the call answers without that extra (exactly as it does when
  there is no runner at all) while the read finishes in the background and is cached for the next
  call. Otherwise the first such call after a restart, with a cold dbt process, would sit on dbt's
  own 10-minute timeout (`DBT_TIMEOUT_SECONDS`) and the client would report a generic tool failure.
  **Values above 30 s are capped at 30**, with a line on stderr saying so — a longer wait inside one
  tool call outlives the calling client's own timeout, which this server cannot raise. (A query or a
  build never holds a call at all: it is a task — the call returns its `task_id` at once and
  the query tool of its side, given `{ task_id }`, waits for it, at most 30 s per call.)
- `CONTEXT_TTL_MS` — context GC tuning.
- `MCP_ALLOWED_ORIGINS` — comma-separated browser origin HOSTNAMES allowed to call the endpoint
  (port-agnostic, e.g. `console.example.com`). The spec requires a server to validate `Origin`
  (DNS-rebinding protection): a request **without** an Origin (every native client, every hosted
  connector calling from its backend) always passes, a loopback origin (`localhost`, `127.0.0.1`,
  the MCP Inspector) passes, and any other origin gets **403** unless it is listed here. Every
  refused request is logged with its origin (`http ✗ refused 403 POST /mcp rpc=… origin=…`), so a
  host that reports it "cannot reach" the server shows up with the exact origin to list.
- `MCP_ALLOWED_HOSTS` — optional comma-separated hostnames the `Host` header must match (a second
  fence against DNS rebinding). Unset = no Host check, which is what you want behind a proxy.
- `MCP_TASK_AFTER_MS` (default 3000) — for a client that declared the Tasks extension, a call that
  has not finished in this long comes back as a task the host polls; `MCP_TASK_TTL_SECONDS` (default
  3600) — how long a finished task stays readable.
- `MCP_PROGRESS_INTERVAL_MS` (default 5000) — how often a call that carries a `progressToken` hears
  it is still working (clients may reset their request timeout on it).
- `DUCKDB_PATH` — the DuckDB database file, consumed by your `profiles.yml` via `env_var(...)`. One process at a time can hold a DuckDB file, so the server queues its dbt/MetricFlow processes on it (src/dbt/process.js).

Your `profiles.yml` should read the database path from env, e.g.:
```yaml
analytics:
  target: dev
  outputs:
    dev:
      type: duckdb
      path: "{{ env_var('DUCKDB_PATH') }}"
      threads: 1
```

## Notes
- dbt runs in named environments — one virtualenv each under `/opt/dbt-envs` (`DBT_ENVS_DIR`), picked by `DBT_ENV`: `dbt-v2` is dbt v2, `dbt-v1` is dbt 1.x with the DuckDB and BigQuery adapters. MetricFlow is an environment of its own, `metricflow` (`MF_ENV` names another), which every dbt environment queries metrics through. The build installs each with `scripts/dbt-env.mjs create`: exactly the packages, at exactly the versions, `src/dbt/environment-specs.js` names — there is no requirements file to pass. Every environment carries both warehouses' adapters, so the image is the same for DuckDB and BigQuery; dbt picks the adapter from your profile. `docker-compose.yml` runs `dbt-v2`, the BigQuery setup `dbt-v1` until the python stage is proven on v2 there. The server runs dbt only from these environments — one built with other versions than the spec names, or a venv not built by `create`, is refused, and there is no binary to name from outside — and reads the dbt version from the binary (`DBT_VERSION` pins it). On v2 the semantic layer is written in dbt's latest YAML spec, and the python stage is not offered on DuckDB. v2 downloads its ADBC driver from dbt's CDN on the first run — allow that once, or warm it at build time.
- For BigQuery, use `docker-compose.bigquery.yml` (and `.env.bigquery.example`).
- A dbt project (or an explicit `CATALOG_PATH`) is required — the image bakes no catalog. With a project mounted, build/query work via the bundled `dbt`/`mf` runner.
- **Restarting the container loses nothing a client holds.** The server keeps no sessions (the SDK
  serves each request from a fresh server instance), so a client connected before a deploy keeps
  calling after it with no new handshake; a stale `Mcp-Session-Id` is ignored. (This replaced a
  session table that lived in the process: after a restart, clients got errors for a session id the
  new process had never issued until the connector was re-added by hand.)

## Path analysis: the retentioneering feature (off unless turned on)

`MCP_RETENTIONEERING=on` adds a side of its own — three tools, a view, a guide and a skill — for
path analysis with [retentioneering](https://github.com/retentioneering/retentioneering-tools) 5.x
(Apache-2.0). Off (the default), none of it exists: not listed, not callable, not described.

- **`build_retentioneering_model`** — the DATA: the eventstream an analysis reads (events source,
  time window, events kept / dropped / merged into groups (optionally the most frequent N names with
  the rest as `other`), user attributes carried as segments through the declared relationship, optional
  sessions split at a gap, and a user sample by a hash of the key — the same users on every build).
  It is built in SQL where the data lives and materialized; the call returns a task.
- **`query_retentioneering_model`** — the COMPUTATION: `{ context_id, preprocess?, analyses: [...] }`
  runs every listed analysis — each a library method with its own parameters under the library's
  names: transition graph, step matrix, step sankey, funnel, path clusters, segment overview,
  conversion rate, metric distribution, path metrics, describe, and diff between two segment levels —
  after the library's own preprocessing steps (`{ type, ...params }`: filter_paths, truncate_paths,
  collapse_events, split_sessions, add_segment, add_clusters, …), for the whole call or per analysis.
  It is ONE dbt Python model: in the dbt process on DuckDB, on the warehouse's Python runtime on
  BigQuery (Colab Enterprise through `submission_method: bigframes`). One call = one run = one cold
  start. `{ task_id }` reads it back, summarized for the model (`detail: "full"`: every record). The
  feature sets no limits of its own; what a call cannot carry — a Python callable, a DuckDB statement
  for the runtime — is not offered.
- **`display_retentioneering_result`** — the SHOW: one analysis of a finished task drawn as a card
  (`ui://betti/retentioneering-view.html`), once per analysis. The graph opens on each event's
  strongest exits (retentioneering's own default) and switches weights and how many exits it shows
  on the page itself — no recomputation; every card gives its scope (users, period, sample) and
  counts next to shares, and has a table view of its numbers. A distribution is drawn as a histogram
  and a diff as heatmaps (the difference shaded above and below zero); an analysis with no visual
  shape (describe, a conversion rate, per-path metrics) is not drawn — its numbers come back for the
  model to answer in words.

Nothing heavy runs in the server: a call starts a task, the warehouse computes, and a small result
table comes back. Configuration:

- The feature runs on its own dbt environment, **`retentioneering`** (dbt 1.x, both adapters and
  the library with its numerical dependencies at exact versions — `src/dbt/environment-specs.js`);
  the image builds it. `MCP_RETENTIONEERING_ENV` names another environment of the specs.
- **BigQuery / Colab Enterprise:** dbt installs `retentioneering==<the pinned version>` on the
  runtime at every run (the model's `packages`). The runtime template dbt creates by itself has **no
  internet access**, so that install fails there: give a template with access to PyPI (or with the
  package preinstalled) through `MCP_RETENTIONEERING_MODEL_CONFIG`, a JSON of extra `dbt.config`
  keys, e.g. `{"notebook_template_id": "<id>", "timeout": 3600}`. The profile supplies `gcs_bucket`
  and `compute_region` as for any bigframes model.
- The library's telemetry is switched off in every model it runs in (`RETENTIONEERING_NO_TRACK=1`).
- What the tools offer — the analyses and ops with their parameters and types, each path metric's
  arguments, the condition grammar, the edge weights, the clustering methods — is generated from the
  installed library into
  `config/retentioneering-facts.json` (`scripts/retentioneering-facts.py --write | --check`).

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

A deploy that changes what the server offers reaches a client three ways: the tool and resource
lists (and `server/discover`) may be cached for one minute only; a start whose surface differs from
the previous process's (a fingerprint kept in the database) sends `notifications/tools/list_changed`
and `notifications/resources/list_changed` to every `subscriptions/listen` stream opened in the next
hour; and the fingerprint is part of `serverInfo.version` (`0.1.0+<fingerprint>`). The log says it
at startup (`surface <fingerprint> — changed since the last start …`). A host that ignores all three
still needs its tool list refreshed by hand after a deploy.

Each extension below is offered ONLY to a client that declares it in the request being served —
its capabilities in the 2026-07-28 envelope. A 2025 client declares capabilities once, in
`initialize`, and this server keeps no sessions, so its later requests carry nothing to go by: it is
offered none of them (src/client-extensions.js). The listings that differ by client are cached
`private`.

- **Tasks** (`io.modelcontextprotocol/tasks`) — for a client that declares it, a call that has not
  finished in `MCP_TASK_AFTER_MS` comes back as a task (`resultType: "task"`) the HOST polls; a call
  that waits on an engine task (a query tool with `{ task_id }`, `display_model_result`) is followed to its end, so the
  protocol task's result is the rows, not "still running". A call that starts work still answers
  with its `task_id` at once.
  `tasks/cancel` stops the call's dbt process. (The TypeScript SDK does not implement this extension
  yet and routes `tasks/get` / `tasks/cancel` as methods of the older revision, so those two are
  answered in front of it — `src/mcp-tasks.js`, with the SDK's own request classifier — until it does.)
- **Skills** (`io.modelcontextprotocol/skills`) — the analyst procedure, every recipe and (where
  python models run) the python-stage guide, served as Agent Skills (`skills/list`, `skills/get`,
  files via `resources/read` with sha256 digests). Generated at startup from the same objects
  `semantic_index({ guide })` and `semantic_index({ recipe })` return — never a second copy. A client
  that does not declare it gets `skills/list` / `skills/get` refused (-32021), no skill files in the
  resource listings or reads, and no SKILLS pointer in the instructions — the same content stays
  reachable through `semantic_index`.
- **Apps** (`io.modelcontextprotocol/ui`) — drawing is offered ONLY to a client that declares the extension
  (with the view's MIME type) in the request being served, i.e. a 2026-07-28 client, whose every
  request carries its capabilities. Every other client — including a 2025 client that declared it in
  `initialize`, whose later requests carry nothing (this server keeps no sessions) — gets no card
  instructions and no `show_to_user` hint, and a call that would draw (`display_model_result`, `card`
  on `experiment`) is refused. The tool list (with `_meta.ui`) and the view page are the same for
  every client, as the official ext-apps `registerAppTool` serves them: a host re-draws a card
  already in a conversation — reopened, or on another device — by finding its tool and page on
  requests that need not carry the declaration, and hiding them made every stored card "Connector
  not found". For a client that declares it, two tools draw, each its own kind of result, in the host's
  conversation as an interactive view (`ui://betti/result-view.html`):
  `display_model_result({ task_id, display })` a finished MODEL result — a semantic query or a
  pipeline — and `experiment` (a separate process: statistics over the numbers the caller brings, no
  task) its own card when called with `card: true`:
  a CHART (a time series or a breakdown — the chart alone; the only table is the pivot below),
  a FUNNEL (steps, share of the first and of the previous, the biggest drop) and the A/B family — the
  TEST (one variant: a stat card — lift, interval, verdict, the groups; several: ONE card, the control
  as the baseline row and a row per variant with its value, lift, interval and verdict, every interval
  on one shared axis; an interval across zero reads "Inconclusive" with the effect the sample could
  have detected, and `expected_ratio` on the analyze call adds the split check, whose mismatch puts
  an alert over the card and withholds every verdict — a significant change coloured
  by what it means for the metric: green an improvement, red a regression; `good: down` on the
  analyze call marks a metric where lower is better, such as crash rate or churn, and the card says
  "lower is better"). A card is drawn only for a VISUAL SHAPE — a trend of three points or more,
  three or more bars or slices, a funnel of three steps or more, a flow, a drill-down, KPI tiles with
  a trend, the A/B test: a single number, a row or two, the standalone sample-ratio check or the
  sample-size plan is answered in words (the drawing call says `drawn: false` and returns the numbers;
  an explicit request is answered the same way). What a result with rows IS is
  declared by the caller: `display` on `display_model_result`, a union of closed
  forms tagged by `kind` — each form's schema says which question it fits and what it needs (required
  fields, bounds, enums, if/then), so nothing about a form lives in prose: `line` (a trend; several
  `y`, or one `y` with a `series_column`, is a multi-line), `area` (a total split into parts over time,
  stacked), `bar` (a comparison: grouped by several `y` or a `series_column`, `stacked`, `horizontal` —
  the default past 8 categories), `pie` (shares of one total as a donut; past 6 slices the smallest
  fold into "Other"; negative values or a single row are refused), `funnel` (`steps` as columns of one
  row, or `{ label_column, value_column }` over a row per step), `kpi` (1–4 headline tiles from one
  row with the change against a `previous_column`, coloured only when `good: up|down` says which way
  is good — or, with an `x` axis, the last row, its change and a sparkline), `sankey` (a row per
  link source → target with an amount; links that loop back are refused) and `pivot` (a drill-down
  table over a STORED result (a query run with `materialize: true`, or a pipeline build), `levels: [{ column, label }]`: the card gets the top level —
  the header names only that one, and an opened row names the level under it ("US · by Platform") —
  and each row it opens reads the next level from the stored table, filtered to that row — 200 rows
  a level; each level re-aggregates
  with the value's agg, so sums and counts add up while distinct counts, averages and ratios do not).
  `line`, `area`, `bar` and `pie` may declare `drill: { levels: [{ column, label }], agg }` over a
  stored result grouped by those columns too: the chart is drawn folded over them, a click on
  a bar, slice or point opens a menu of the dimensions left ("by Platform"; a point also "by Platform
  over time"), and the chart redraws in the same card filtered to what was clicked — a breadcrumb
  ("All › US › ios") over it and a back button beside fullscreen step back without a read. Each
  takes a title;
  the server checks the columns exist and the card draws exactly that, in the declared order. Without it
  the card is inferred from the shape. A spinner shows until the
  result arrives. A result that is gone — its table or context deleted, a result held in memory
  expired or lost to a restart, a task_id the server does not know — is `error.code: result_gone`
  (a card of it reads "This result is no longer available", not "Error").
  BUILD, QUERY, SHOW: two sides with one naming — `build_semantic_model` / `query_semantic_model`
  and `build_pipeline_model` / `query_pipeline_model`. A call that starts warehouse work (a build, a
  query) returns only `{ task_id }` and never waits; the query tool of the same side, given
  `{ task_id }`, waits for it (up to 30 s per call) and returns the rows — and never draws;
  `display_model_result` is the only tool that draws a model result, for either side: it reads the
  task the same way and draws each task ONCE (a second call is refused). So one question gets one
  card by construction: `structuredContent` (what a host draws a card from) is carried only by a
  `display_model_result` that drew, or an `experiment` called with `card: true`; every other answer,
  of every tool, is text alone. A task still running
  is refused by display_model_result (wait with its query tool), and so is a column the result lacks.
  Beyond that the view ONLY DRAWS. Every tool declares `_meta.ui.visibility: ["model"]` (a view may
  not call it) except `drill_result`, `["model", "app"]` (served only for a drawn task); the view resource declares
  an empty `csp` (no connect, resource or frame origin) and the page carries the same
  Content-Security-Policy itself; and the view's code makes that one call — drill_result for its own
  task: the next view of its stored table when a pivot row opens or a chart mark is drilled into
  (served only for a task that was drawn) — and calls no other tool, resource, model message or link.
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
compose file (the same image — every environment carries the BigQuery adapter too) and a GCP
service-account key:
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

