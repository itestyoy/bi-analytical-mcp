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
  guide, a tool's result); they never carry text or numbers of their own. The Apps view follows the
  official ext-apps templates and draws shadcn/ui components (Card, Badge, Button, Table — the
  pivot's only, Alert, Accordion, Chart) over the HOST's style variables, whose fallbacks are the shadcn neutral
  theme; its build is checked in and held to its sources by a test. THE VIEW DRAWS, AND READS ONLY ITS OWN RESULT:
  every tool is `visibility: ["model"]` except `drill_result` (`["app"]` — the card's, never the
  model's), the view resource declares an empty `csp` and the page its own CSP, and the view's ONE
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
  never waits (`Engine._startTask`; tasks on one context run in order). The query tool of the SAME
  side reads a task back: `{ task_id }` waits (≤ MAX_WAIT_SECONDS per call) and returns the result
  (and pages a stored one); it refuses a task of the other side, and it never draws.
  `display_model_result` is the ONLY tool that draws, for either side: it reads the task the way the
  query tools do (`_awaitRead`), validates `display` against the result's columns, and draws each
  task AT MOST ONCE (a second call is refused) — so one question gets one card by construction.
  `structuredContent` is carried only by a display_model_result that drew (`drawn: true` and
  `buildViewModel(...).kind !== 'none'`); every other answer is the text alone. An experiment's
  statistics come back at once with a task_id display_model_result can draw. A stored result is
  built on by a pipeline started from its task (`build_pipeline_model({ action: 'start', from_task
  })`); `time` is a pure timer. Do NOT add a second tool that draws, a tool that waits inside a
  starting call, a reader shared by both sides, or a read by table name.
- AN EXTENSION IS OFFERED ONLY TO A CLIENT THAT DECLARES IT, IN THE REQUEST BEING SERVED — its
  envelope's capabilities carry `extensions[<id>]` (src/client-extensions.js, the one source):
  * Apps (`io.modelcontextprotocol/ui`, with the view's MIME type): `_meta.ui`, the view resource,
    display_model_result and drill_result (not even listed otherwise, and refused if called), the RESULT
    CARDS instructions, the `show_to_user` hint;
  * Skills (`io.modelcontextprotocol/skills`): skills/list and skills/get (-32021 otherwise), the
    skill files in resources/list, templates and resources/read, the SKILLS pointer in the
    instructions;
  * Tasks (`io.modelcontextprotocol/tasks`): a long call becoming a task, tasks/get|cancel|update
    (-32021 otherwise).
  A 2025 client declares capabilities once, in `initialize`, and is served statelessly, so its later
  requests carry nothing to go by — it gets none of them. The lists that differ are cached `private`.

## Testing (HARD RULE)
- Tests MUST assert on DATA — real query result values from running the model
  against the warehouse (PGlite + dbt + MetricFlow).
- NEVER assert on generated text: no string/regex matching of generated SQL,
  YAML, Jinja (`Dimension(...)`/`--where`), `mf`/`dbt` command strings, or runner
  args. Correctness is proven by the NUMBERS returned, not by the query text.
- Only non-data checks allowed: input-validation guards (bad input rejected) and
  context lifecycle (files/registry).
