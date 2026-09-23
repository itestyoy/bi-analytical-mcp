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
     source, event })`, `build_native_model({ source })`, `semantic_models[].from`
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
- ONE SURFACE, TWO ERAS. `/mcp` serves the legacy session protocol (SDK, `initialize`) and the
  stateless 2026-07-28 revision (`src/mcp-modern.js`). WHAT is offered — tool definitions, how a call
  runs, resources, skills, the Apps view, tasks — lives once in `src/mcp-surface.js` (+ `tasks.js`,
  `skills.js`, `apps.js`); an era module only translates the wire. A new capability is added to the
  surface, never to one era.
- Skills and the Apps view RENDER existing objects (buildGuide, `engine.get_recipe`, the python
  guide, a tool's result); they never carry text or numbers of their own.

## Testing (HARD RULE)
- Tests MUST assert on DATA — real query result values from running the model
  against the warehouse (PGlite + dbt + MetricFlow).
- NEVER assert on generated text: no string/regex matching of generated SQL,
  YAML, Jinja (`Dimension(...)`/`--where`), `mf`/`dbt` command strings, or runner
  args. Correctness is proven by the NUMBERS returned, not by the query text.
- Only non-data checks allowed: input-validation guards (bad input rejected) and
  context lifecycle (files/registry).
