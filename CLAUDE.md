# Project conventions

## Data model (HARD RULE)
- Sources are identified by their `meta.mcp.role` — NOT by name. (Since dbt 1.10 that block lives
  under `config:` on the model and on every column — `config.meta.mcp` — which is the only place dbt
  Fusion reads; the loader still accepts the pre-1.10 top-level `meta:`, with `config` winning per
  key, and `scripts/meta-to-config.py` moves an existing file.) The dbt model /
  SQL file can be named anything; the role is the identity, and exactly one model
  per role. Sanctioned roles:
  1. **an events SOURCE** — one row per event, detected by its event_name/
     event_data/time columns. There may be SEVERAL (e.g. `events` for product
     analytics and `crashlytics` for crash reports). They are INDEPENDENT AND
     EQUAL: each owns its `known_events`, its event-scoped `*_of_event_data`
     properties, its `meta.mcp.primary_entity` and its own space in the value
     index (keyed by `(source, property)`), and they are never mixed. No source is
     privileged: the SOURCE is always a separate argument — `semantic_index({
     source, event })`, `build_pipeline_model({ source })`, `semantic_models[].from`
     — never glued into a name. Within a source, names are used as-is. A source is
     named ALWAYS, in every catalog, including one that declares a single source:
     one address for one thing, so no name ever has a second, owner-less spelling
     that a reader has to trace back to a source.
  2. **users** — the user-attributes dimension (one row per user).
  3. **experiments** — A/B-test assignments (one row per user×experiment:
     experiment_name, variant_group, assigned_at, ended_at); joined to events by
     the user entity for A/B analysis.
  4. **a MEASURES source** — a non-events fact whose columns are amounts, not
     events (e.g. `acquisition`: one row per player×day with cost/impressions/
     clicks). It has no `event_name`; it declares its own time axis
     (`meta.mcp.is_time`) and its own measures, and joins to users / an events
     source by the user entity — on a per-day grain with a COMPOSITE join key
     (`on: [<user column>, <day column>]`) so the daily rows do not fan out.
- Do NOT invent other tables/fixtures (no orders/customers/Jaffle, no "step"
  tables). Only the roles above.
- THE SCHEMA MARKS WHAT MAY BE AGGREGATED; THE CALLER PICKS THE FUNCTION. Any
  column of any source may carry `meta.mcp.measure: true` (or an object with
  `unit`/`label`/`description`) to mark it an AMOUNT, and any model may carry
  `meta.mcp.measures: { <name>: { expr, ... } }` for an aggregatable expression.
  NEITHER fixes an aggregation: a task names the field in a measure's `field` and
  chooses `agg` per question (sum | average | min | max | count | count_distinct |
  sum_boolean | median | percentile, validated at catalog load) — the same column is
  summed for one question and read at a p90 for the next. Adding `agg` to a
  declaration is the OPT-IN exception: it additionally publishes a governed measure
  whose function is fixed for everyone; the free choice over the raw field remains.
  Do NOT special-case a measure, a column name or a role in `src/` — if a new source
  needs something, it becomes a schema key that every source can use. Two opt-outs
  go with it: `meta.mcp.dimension: false` (a real column that is not a groupable
  attribute) and `meta.mcp.index: false` (groupable, not profiled by the value index).
- An events source is EXTENDED, never duplicated: a new source reuses the same
  machinery — the catalog accessors (`eventNames/eventProps/eventNameFor/propertyFor`),
  the indexer worklist and the value-index API all take the source as an argument.
  Do NOT add a parallel code path, or a fallback to some "default" source, for a role.
- Funnels (incl. multi-step) are built ONLY from events: a step is an event +
  an `event_data` property value (e.g. event_name=tutorial AND step_id=step_1).
  A funnel runs over ONE source (a row-pattern match scans one table); measures from
  different sources can still be compared side by side over `metric_time`.
- Segmentation/joins use user attributes on `dim_users` and experiment assignments
  on the experiments source, joined to events by the user entity — from ANY events
  source that carries the user entity.
- JOIN KEYS ARE DECLARED IN THE SCHEMA, NEVER PASSED IN AT THE CALL SITE. A model
  declares `meta.mcp.entities: { <relationship>: { type, key: [...] } }`; a key may
  span SEVERAL columns, and the two sides may name their columns differently — only
  the relationship name and the NUMBER of key parts have to agree.
  `primary`/`unique` makes the model the join TARGET
  (exactly one owner, unique per row there); `foreign` points at the owner. Both
  paths consume the SAME declaration — `<relationship>__<attribute>` in a metric
  query, `join { with, via }` in a pipeline. A side may declare `variants` when the
  same relationship is carried by SEVERAL alternative key columns (one tracking id
  per ad format): each expands to `<relationship>_<variant>` and the CALLER picks
  which to use, while the side with one such column declares it plainly once. Do NOT
  hardcode a pair of column names in `src/` for a particular join, and do NOT add a
  per-role join path: a new relationship is a schema key, not code. `on:` in a
  pipeline join stays only as the ad-hoc fallback for a column both sides name
  identically.
- A relationship NOBODY owns is a legitimate PIPELINE join (a many-to-many match —
  an ad funnel spans several events, so neither side is unique on it). It has no
  governed path, and that is correct: MetricFlow only joins onto a unique key.
- JOINING A SLOWLY-CHANGING MODEL IS POINT-IN-TIME. A model with a validity window
  (`meta.mcp.dimension.validity: start|end`) holds several versions per key, so the
  key ALONE matches every historical version and inflates counts. The governed path
  applies the window itself; a pipeline states it EXPLICITLY in the join stage's
  `between` — deliberately, so the time being asked about is visible at the call
  site. MetricFlow allows such a model exactly one join key, as its natural key: a
  second `primary`/`unique` key there is rejected at catalog load, and measures on it
  are dropped with a warning (count on an events source instead).
- A/B significance is computed in JS via the `ab_test` tool over per-group
  aggregates (proportion → z-test; mean → Welch t-test).
- A FACT ABOUT AN EXTERNAL LIBRARY IS GENERATED FROM THAT LIBRARY, NEVER WRITTEN IN PROSE (HARD
  RULE). Signatures, which methods raise, what a class returns: extracted by a script into a
  checked-in sheet (`scripts/bigframes-facts.py` → `config/bigframes-facts.json`), and every text
  that states one renders it from there — the guide, the failure hints, the reference recipes, the
  frame profile's one-liner. Two copies of a list is how one of them goes stale. Each kind of text
  has ONE home, and the division is written at the top of `src/python-guide.js` (facts → rules →
  hints → reference → runtime mechanics → stage mechanics → routing → worked payloads); a
  description INTERPOLATES the rule instead of restating it, and `test/unit/python-surface-layering.test.js`
  is the guard on that.
- WHAT SQL CAN COMPUTE IS COMPUTED IN SQL (HARD RULE). A `python` stage carries ONLY
  what SQL cannot say — a statistical test, clustering, scoring, a forecast, a model.
  Everything else is SQL stages BEFORE it, and that INCLUDES PREPARING THE DATASET the
  python analysis reads: scoping to the events and the time window, extracting the
  payload columns, joining the attributes, aggregating to the grain the analysis works
  on. The python stage receives a prepared table at that grain, never a raw source —
  SQL runs where the data lives and is exact, a python model is a separate dbt model on
  the warehouse's python runtime (cold start, and its frame carries that runtime's own
  limits), and a SQL stage stays readable to the next reader. This is stated in the
  stage description, the python guide, the routing triggers and the recipes (every
  shipped one prepares in SQL first), and the server NUDGES when a python stage has
  nothing before it — a recommendation, never a refusal: the shape is legitimate when
  the analysis really is per source row.

## Protocol surface
- THE OFFICIAL SDK OWNS THE PROTOCOL. The server is built on `@modelcontextprotocol/server` v2
  (protocol 2026-07-28; it also serves clients that open with the 2025 `initialize`, from the same
  factory). `src/mcp-server.js` only says WHAT is offered — tools, resources, skills, the Apps view,
  tasks — using `src/mcp-surface.js` (+ `tasks.js`, `skills.js`, `apps.js`). Do NOT hand-roll wire
  behaviour the SDK provides (headers, envelope, discover, sessions, error codes); the one exception
  is `src/mcp-tasks.js`, which exists only until the SDK serves the Tasks extension.
- Skills and the Apps view RENDER existing objects (buildGuide, `engine.get_recipe`, the python
  guide, the research guides of `src/research-guides.js`, a tool's result); they never carry text or numbers of their own. The Apps view follows the
  official ext-apps templates and draws shadcn/ui components (Card, Badge, Button, Table — the
  pivot's only, Alert, Accordion, Chart) over the HOST's style variables, whose fallbacks are the shadcn neutral
  theme; its build is checked in and held to its sources by a test. THE VIEW DRAWS, AND READS ONLY ITS OWN RESULT:
  every tool is `visibility: ["model"]` except `drill_result` (`["model", "app"]` — hosts refused a
  card's call to an app-only tool; the server answers it only for a DRAWN task), the view resource declares an empty `csp` and the page its own CSP, and the view's ONE
  server call is drill_result for the task it was drawn from — a drill-down's next view — a pivot
  row opening (`display.kind: pivot`) or a chart mark clicked (`display.drill`): its task's stored
  table, filtered to the path taken and grouped by the dimension chosen, each read built by the view
  model's one definition of a view (no other tools/call, resource, model message, link or network)
  — a test holds its sources to that; the server serves it only for a task that was drawn.
  Everything else interactive stays on the data already in the page.
- BUILD, QUERY, SHOW — TWO SIDES, ONE NAMING (HARD RULE). Each side has a builder and a query
  tool: `build_semantic_model` / `query_semantic_model` and `build_pipeline_model` /
  `query_pipeline_model`. A call that STARTS warehouse work — a build (incl. action:update, a
  pipeline materialize, the hidden register_native_model/update_semantic_model) or a query
  (`query_semantic_model({ context_id, metrics… })`, `query_pipeline_model({ context_id,
  transform })`) — validates its input in the call and returns ONLY `{ task_id, context_id? }`; it
  never waits (`Engine._startTask`; tasks on one context run in order). A query tool also takes a
  BATCH — `{ context_id, queries: [...] }`, up to MAX_BATCH (5) — which checks EVERY query before
  any starts (one mistake refuses the batch), starts one task per query and returns ONLY
  `{ task_ids, context_id }` (`Engine._startBatch`); the members run side by side (each dbt process
  with a target directory of its own), after what was queued before them and before what is
  queued after. The query tool of the SAME
  side reads a task back (the started answer names it in `read_with`): `{ task_id }` waits
  (≤ MAX_WAIT_SECONDS per call) and returns the result, paging a stored table or the rows held in
  memory; `{ task_ids }` waits for several and returns each one's result as `{ task_id }` would;
  `{ task_id | task_ids, cancel: true }` stops them at once (the task's own AbortController kills its
  dbt process; its work still runs down its failure path, so a build clears its in-flight marker); it
  refuses a task of the other side — before any wait — and it never draws. The side is
  the tool that started the task, persisted with it (the jobs table's `tool`), never guessed.
  `preview_semantic_model` is the semantic side's INSPECTOR, for the project's own layer (no build
  to report it) and a task's context alike: it reads the context's PARSED manifest
  (`src/semantic-manifest.js`, one reader for both YAML specs) and answers in the call — semantic
  models, each metric's definition and its `group_by` — what it can be grouped by, spelled as that
  context's query takes it
  (a metric of several semantic models only what every input reaches), the declaration's own
  mistakes; with `validate` it starts a semantic task instead (read with query_semantic_model), in
  which MetricFlow compiles each metric and, over a time_range, the warehouse runs each metric and
  each semantic model's dimensions, one by one where all at once fails, to name what fails.
  `display_model_result` is the ONLY tool that draws a MODEL result, for either side: it reads the task the way the
  query tools do (`_awaitRead`), validates `display` against the result's columns, and draws each
  task AT MOST ONCE (a second call is refused) — so one question gets one card by construction.
  `structuredContent` is carried only by a display_model_result that drew (`drawn: true`) or an
  experiment called with `card: true`, and only when `buildViewModel(...).kind !== 'none'`; every
  other answer is the text alone. A CARD EXISTS PER KIND, never per the size of a result: a kind that
  fits a picture has its card, a kind that does not has no card code at all (no view-model branch, no
  renderer, no field asking for it) and is answered in words. THE EXPERIMENT IS A SEPARATE PROCESS,
  NOT MIXED WITH display: it is statistics over numbers the caller brings — no task, no task_id —
  returned at once, and it draws its own card (the A/B test; the split check and the plan have none)
  only when asked with `card: true` on analyze (a field offered to an Apps client alone, refused from
  any other). A stored result is
  built on by a pipeline started from its task (`build_pipeline_model({ action: 'start', from_task
  })`); `time` is a pure timer. Do NOT add a second tool that draws, a tool that waits inside a
  starting call, a reader shared by both sides, a read by table name, or route an experiment
  through tasks or display_model_result. The one sanctioned exception is a FEATURE's side (below):
  it has the same three roles — its builder, its query tool that starts AND reads back its own tasks
  (its side registered with the engine, a task of another side refused), and its OWN drawing tool,
  which draws only that side's finished tasks, each analysis at most once; display_model_result stays
  the only tool that draws a semantic or pipeline result.
- A FEATURE IS SWITCHED ON AS A WHOLE, OR IS NOT THERE (src/features.js). A part of the server that a
  deployment may not want — today only retentioneering — is a feature: off unless its flag says on
  (`MCP_RETENTIONEERING=on`), and left out WITH ITS REASON (in the overview) when asked for where it
  cannot run. Off, nothing of it exists: no schema (so neither listed nor callable), no view page, no
  guide name, no routing trigger, no skill, no line of the instructions — the surface is exactly what
  it is without it. The core never names a feature: engine, surface, apps, guide, skills and
  overview each walk `engine.features` at ONE point (a tool's schema/method/side/description/view,
  a guide name + triggers, a skill, an instructions line, an overview entry). Do NOT add an
  `if (feature)` branch in the core, and do NOT let a feature reach into another side's tools.
- RETENTIONEERING (src/retentioneering/, the first feature): build = the DATA, SHAPED STEP BY STEP LIKE A
  PIPELINE — `start` declares the eventstream, rendered in SQL through the pipeline's own stages (scope,
  the declared relationship for segments, point-in-time for a slowly-changing model), materialized, its
  summary carrying the vocabulary and every segment's levels; then the library's own steps
  (`add_step` / `add_steps` / `edit_step` / `insert_step` / `delete_step` / `truncate` / `fork` /
  `preview`, the pipeline builder's own words), each CHECKED BY THE LIBRARY ITSELF as it is added
  (below) and answered at once with what it changed; `materialize` runs the steps not yet materialized
  in one dbt Python model and stores the eventstream after them (its columns' roles and each event's
  order carried in the table), a checkpoint an edit at or before it retires. Every start builds a table
  of its own (a fork of an earlier one keeps reading its rows), one build action at a time runs on a
  context, and a column a step makes must be an identifier the warehouse stores (quoted wherever SQL
  names it); query = the COMPUTATION —
  every analysis of one call over the eventstream AS MATERIALIZED (a query takes no steps of its own:
  a variant is a fork), read back with a table's first rows kept (the whole of it on detail: "full" or
  for the card that draws it) and its card's scope from the table it read, in ONE dbt Python model (python/retentioneering_model.py, THIS server's code
  inlined; the caller's input is data, never code), on its own dbt environment (`retentioneering`); show = its own view (`ui://betti/retentioneering-view.html`, src/apps/
  retentioneering-view/, drawn with the result view's theme and shared pieces, src/apps/shared/). It is
  deterministic (a user sample by a hash of the key, ordered rows, the library's fixed seeds and a fixed
  one for a draw the caller left unseeded, ties in code-point order — never the locale's), and
  every choice it offers comes from `config/retentioneering-facts.json`, generated from the library.
  IT IS A WRAPPER OVER THE WHOLE LIBRARY, WITH NO LIMITS OF ITS OWN: every analysis and every
  registered preprocessing op (the library's own `{ type, ...params }` op model, applied with
  `apply_ops`), each with its own parameters under the library's names, typed as far as the library
  says — each path metric with exactly its arguments, the condition grammar, where `agg` applies (the
  sheet PROBES the library for what its prose does not state). A parameter the library takes as PARALLEL LISTS whose lengths must
  agree is asked for as ONE list of items and translated back (`RESHAPED`, src/retentioneering/schema.js —
  today `add_segment.metric_bins` as `bins`), so a count that disagrees cannot be written; a condition's
  constant is typed by what the metric's value is (probed: kind and unit). A parameter the library
  pastes into SQL is reshaped the same way, into constants this tool quotes (`add_segment.rules` as
  `{ cases, else }`, the operator from the library's condition grammar) — the caller's input stays data.
  WHAT THE LIBRARY REFUSES, THE LIBRARY SAYS BEFORE THE RUN: every step as it is added, and every
  analysis of a query, is run by the library itself on the feature's environment — one warm process
  (python/retentioneering_check.py --serve, src/retentioneering/checker.js) — over two stand-in
  eventstreams of the SHAPE the eventstream has at that point (its event names, path columns, segments
  with their levels, custom columns); what both raise alike as a configuration error is refused in a
  fraction of a second with the library's own message, instead of minutes into the warehouse run, and a
  step that passes returns the shape it leaves, read off the stand-ins by the library's own schema — what
  the next step is checked against, as a pipeline stage is checked against the columns before it. It
  does not restate the library's checks in JS; a check that cannot run refuses nothing. No cap on analyses, steps, rows or
  tasks: nothing the library computes or returns is cut — only what a READ holds in memory is bounded
  (a table's first rows, `keptRows`), and every row is there on detail: "full" and for the card that
  draws it. The schema carries the catalog's own events and attributes as enums. Left out, each for the
  reason in `NOT_OFFERED` (src/retentioneering/schema.js): a Python callable, a DuckDB statement run on
  the analysis runtime (code — the data is declared in the build instead), and the two ops the
  eventstream's shape rules out. The build reaches the source's OWN columns (every real column, the
  warehouse read like a pipeline reads it) and its scalar event properties — to filter, to carry as a
  segment, and to make events out of an event's parameters (`events.split`: by a value, or by
  conditions) — all in SQL through the pipeline's stages. The analyses with a card are CARD_KINDS (the charted ones and a
  distribution's histogram; a diff of a graph or a step matrix/sankey as heatmaps); any other
  (describe, a conversion rate, per-path metrics) comes back as the tables and values the library
  returned, has no card, and is answered in words.
- AN EXTENSION IS OFFERED ONLY TO A CLIENT THAT DECLARES IT, IN THE REQUEST BEING SERVED — its
  envelope's capabilities carry `extensions[<id>]` (src/client-extensions.js, the one source):
  * Apps (`io.modelcontextprotocol/ui`, with the view's MIME type): what speaks to the MODEL — the
    RESULT CARDS instructions, the `show_to_user` hint — and what DRAWS — a call to
    display_model_result, `card` on experiment (refused otherwise). The tool list (with `_meta.ui`,
    display_model_result and drill_result) and the view page (listed and read) are the SAME for every
    client, as the official ext-apps registerAppTool serves them: a host re-draws a card already in a
    conversation — reopened, or on another device — by finding its tool and page on requests that
    need not carry the declaration, and hiding them broke every stored card ("Connector not
    found"). drill_result is served for a DRAWN task whatever envelope the host puts on the card's
    proxied read, the drawn mark persisted with the task so a card outlives a restart;
  * Skills (`io.modelcontextprotocol/skills`): skills/list and skills/get (-32021 otherwise), the
    skill files in resources/list, templates and resources/read, the SKILLS pointer in the
    instructions;
  * Tasks (`io.modelcontextprotocol/tasks`): a long call becoming a task, tasks/get|cancel|update
    (-32021 otherwise).
  A 2025 client declares capabilities once, in `initialize`, and is served statelessly, so its later
  requests carry nothing to go by — it gets none of them. The lists that differ are cached `private`.

- RESEARCH GUIDES ARE METHOD, NOT DATA (`src/research-guides.js`): how to run an investigation
  (sequence, checks, report) and what matters in product, monetization and UA — served by
  semantic_index({ guide: "research" | "research/<domain>" }) — reserved names that buildGuide
  dispatches next to "python", an unknown one refused — and as the `research` skill rendered from the
  same `researchGuide()` objects. ONE routing line (`RESEARCH_SCOPE` + `RESEARCH_ROUTE`) is
  interpolated by the guide's trigger, the semantic_index description, the schema's `guide` field,
  the core instructions and the skill description; the domain list is derived from the guide set.
  They name no column, event or model (the catalog says what exists), every "how" points at a tool
  or a recipe written `recipe "<id>"` (test/unit/research-guides.test.js holds each to the loaded
  recipes), and they are adapted from Anthropic's (Apache-2.0) and OpenAI's (MIT) analytics skills
  with the sources listed.
- WHAT THE MODEL READS IS WRITTEN FOR THE CURRENT MODELS (Anthropic's and OpenAI's prompting guidance):
  a tool description opens with what the tool does and when to use it, says when another tool fits
  instead, and gives the reason behind a rule rather than stressing it — plain wording, no emphatic
  capitals or blanket ALWAYS/NEVER (newer models follow instructions literally and over-apply
  shouted ones; keep absolutes for true invariants). The server instructions (the spec's
  `instructions`: InitializeResult in 2025, DiscoverResult in 2026-07-28 — a hint a client MAY add to
  the system prompt) are cut differently by each client, and some read none, so they are layered:
  an OPENING paragraph of at most 512 characters that stands alone (what the server is for, how a
  question flows — ChatGPT and Codex), then a CORE BLOCK (`coreInstructions`, src/mcp-surface.js)
  within 2,048 (the rules that span several tools, when to stop — Claude Code's cut), then the data
  model and its joins. They carry only what no single tool says — the spec asks them not to repeat
  the tool descriptions, and every tool description stands on its own (each within 2,048 too); long
  procedures live behind semantic_index ({ guide }, { recipe }) and the skills
  (test/unit/tool-surface.test.js holds the budgets).
- A CHANGED SURFACE IS ANNOUNCED, NEVER LEFT TO A CACHE (src/surface-change.js). A host re-draws the
  cards in a conversation from its cached tool list, so a deploy that changes a tool must reach it:
  (1) the cacheable results (lists, resources/read, server/discover) carry a SHORT `ttlMs`
  (LIST_TTL_MS, one minute); (2) `tools.listChanged` / `resources.listChanged` are declared, and a
  start whose surface fingerprint differs from the one persisted by the previous process (the store's
  `meta`) announces `notifications/tools/list_changed` + `…/resources/list_changed` to every
  `subscriptions/listen` stream that subscribes within CHANGE_WINDOW_MS; (3) the fingerprint rides in
  `serverInfo.version` (`0.1.0+<fingerprint>`). Do NOT lengthen the list TTLs back to hours.

## Warehouses and dbt
- TWO WAREHOUSES, TWO DIALECTS: `bigquery` (production) and `duckdb` (local work, the tests, the
  default compose setup) — `src/dialects/{bigquery,duckdb}.js`. There is no Postgres. A DuckDB
  database is a FILE one process at a time may hold, so every dbt / MetricFlow process on it takes
  the warehouse's turn (`src/dbt/process.js`, keyed by the database file read from the profile), the
  MetricFlow sidecar lets go of it after each request, and a batch's members run one after another
  there (side by side on BigQuery).
- dbt IS REACHED ONLY THROUGH THE dbt CLIENT (`src/dbt/index.js` → `createDbt`, version read from
  the CLI): one contract (parse / run / seed / show / relationColumns / query / validate / warehouse
  / semanticSpec / semanticManifest / pythonModelsOn) over the installed dbt, each major version its own implementation
  — `src/dbt/v1.js` (dbt 1.x) and `src/dbt/v2.js` (dbt v2). Do NOT spawn dbt or `mf` anywhere else,
  and do NOT branch on the dbt version outside `src/dbt/`.
- ONE SEMANTIC LAYER, TWO YAML SPECS: the context is rendered once (`src/yaml-render.js`, legacy
  shape) and, for a dbt whose `semanticSpec` is 'latest' (v2), converted by `src/semantic-latest.js`
  — the semantic model joins its dbt model's entry (merged with the project's own entry by
  `ContextManager.writeSemanticYaml`), keeping OUR semantic-model names so paths and metric names
  do not change. What v2 writes differently into the manifest is corrected in its client (a
  percentile is always approximate there: `config.meta.mcp_percentile` puts the request back).
  Metric queries go through MetricFlow's `mf` on either version.
- THE PROJECT'S OWN SEMANTIC LAYER IS READ AT START, NEVER BUILT (`src/project-semantics.js`): the
  semantic models and metrics DBT_BASE_PROJECT declares itself (either spec, any file names and
  layout under its model-paths — a model's only entry may be the one that carries its semantic model;
  NOTHING is keyed on a name: every name is read from the manifest dbt writes) are parsed once, before the tools are served, into ONE
  internal copy (`PROJECT_STORE`, never addressed or listed; re-read on every start), and EACH
  SEMANTIC MODEL IS A CONTEXT OF ITS OWN, ADDRESSED BY ITS NAME (context_id: "<semantic model>";
  `ContextManager.createShared` — no copy or parse per model; pinned: never gc'd, built on or
  dropped). There is no context for the layer as a whole. Where one of them is a valid context_id
  (query_semantic_model, preview_semantic_model, context), the schema offers them as an enum next to
  the pattern any built context's id matches (`anyOf`). A context offers the metrics that read its
  semantic model (a metric of several models is in each of theirs), queried with
  query_semantic_model({ context_id: "<semantic model>" }) — `{ dimension, grain? }` of its own model,
  `{ semantic_model, dimension, via? }` of one it reaches, and `{ entity }` (a key the project
  declares only as an entity) in group_by / where / order_by,
  checked against the manifest before anything runs (one hop through a primary entity), the
  project's names kept. Their queries run side by side (nothing writes to them); their stored results
  are carried over a restart and retired by CONTEXT_TTL_MS by age. A GENERATED context holds its OWN
  layer only: its copy of the project leaves the project's semantic keys out
  (`withoutSemanticLayer`, src/context-manager.js) — the latest spec allows one semantic model per
  dbt model, and a name of one layer could shadow the other's. The overview
  (`semantic_index().project_semantic_layer.contexts`) lists each context with its dimensions and its
  metrics, each with its meta (the project's notes on reading it) and the semantic models whose
  dimensions cut it; preview_semantic_model({ context_id, metric }) gives one metric's definition
  and its full group_by.
- dbt RUNS IN NAMED ENVIRONMENTS (`src/dbt/environments.js`): a virtualenv per environment under
  DBT_ENVS_DIR (`.venvs` locally, `/opt/dbt-envs` in the image), named for what is in it — `dbt-v2`
  (used unless DBT_ENV names another), `dbt-v1`, `metricflow`; `createDbt({ environment })` takes its binaries. MetricFlow is an environment of its own
  (`metricflow`, or MF_ENV) that every dbt environment queries through — `mf` and the sidecar's
  Python — since dbt-metricflow brings the Python dbt-core, which cannot share a venv with a dbt v2
  binary. `npm run dbt:env -- create|list` manages them.
- WHAT IS IN AN ENVIRONMENT IS THIS TOOL'S DECISION (HARD RULE): `src/dbt/environment-specs.js` names
  each one's packages at EXACT versions and `create` installs exactly those; the image builds them at
  `docker build`. Every environment carries the adapters of BOTH warehouses (dbt picks one from the
  profile), so the image is one for DuckDB and BigQuery — there is no warehouse build argument.
  ONLY OURS RUN: `resolveEnvironment` refuses a name the specs do not define, one asked for as what
  its spec's `role` is not (DBT_ENV must be a `dbt` environment, MF_ENV a `metricflow` one), and a
  directory whose mcp-env.json does not record the spec's pip and packages as they are now. NOTHING IS
  TAKEN FROM PATH: no DBT_BIN / MF_BIN / PYTHON_BIN, and `createDbt`, `MfEngineBackend` and the AST
  gate refuse without a named binary (tests name theirs from the same environments; a refused
  environment fails the test run instead of skipping it).
  Do NOT add a requirements file, a `pip install <pkg>` in the Dockerfile, or an option to hand the
  tool packages, versions or a dbt of one's own: a version change is a spec change, reviewed as code.
- The retentioneering feature has an environment of its own, `retentioneering` (dbt 1.x, both
  adapters, the library and the numerical packages that decide its results, all pinned), and a dbt
  client of its own over it, so turning the feature on changes nothing the core runs; its test file
  (test/integration/retentioneering.test.js) runs on it and skips when it is not built.
- Tests run on the `dbt-v2` environment; the python stage's file runs on `dbt-v1` (dbt 1.x),
  since v2 runs no Python models on DuckDB — there the stage is not offered (`gatePythonRuntime`).

## Testing (HARD RULE)
- Tests MUST assert on DATA — real query result values from running the model
  against the warehouse (DuckDB + dbt + MetricFlow).
- NEVER assert on generated text: no string/regex matching of generated SQL,
  YAML, Jinja (`Dimension(...)`/`--where`), `mf`/`dbt` command strings, or runner
  args. Correctness is proven by the NUMBERS returned, not by the query text.
- Only non-data checks allowed: input-validation guards (bad input rejected) and
  context lifecycle (files/registry).
