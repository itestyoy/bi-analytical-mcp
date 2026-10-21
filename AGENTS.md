# AGENTS.md

## Purpose

This repository is **bi-analytical-mcp**: an MCP server (the official SDK v2) that serves product analytics over a fixed data catalog — a dbt semantic layer and one-off pipeline models built and queried on DuckDB or BigQuery, with result cards for MCP Apps hosts. This file is the single source of agent rules for every agent that works in it: Codex reads it directly, Cursor through [`.cursor/rules/workspace.mdc`](.cursor/rules/workspace.mdc) ([CURSOR.md](CURSOR.md)), and Claude Code through [CLAUDE.md](CLAUDE.md), which imports it.

The workflow sections below come from the knowledge-router agent kit (https://gitlab.com/my-group7744714/knowledge-router); the [Project Conventions](#project-conventions) section is this repository's own, and its HARD RULES win wherever the two meet. Start orientation at [`docs/knowledge/navigation/SYSTEM.md`](docs/knowledge/navigation/SYSTEM.md) and the project index [`docs/knowledge/projects/bi-analytical-mcp/AGENTS.md`](docs/knowledge/projects/bi-analytical-mcp/AGENTS.md).

## Default Language

Write responses and notes in English by default unless the target project requires another language. Keep technical identifiers, file names, and product names in their original form.

## Workflow

- First identify the target repository and read its local `AGENTS.md` or project index, if present.
- Before broad search, inspect the smallest local scope first; expand only through direct dependencies or a concrete hypothesis.
- Keep changes minimal and focused.
- Do not refactor related code unless there is a clear need.
- Preserve user changes that you did not make.
- Use the agent's own patch/edit tool for manual edits (`apply_patch` in Codex).
- If the task is non-trivial, record it in a task note under `docs/knowledge/tasks/`.
- After a meaningful result, update the relevant notes in `docs/knowledge/` and the project index if structure or process changed.
- Keep `.codex/skills/` small and focused; they come from the knowledge-router kit, which owns their source.
- For user-requested cleanup or compression of `docs/knowledge/`, use the runbook, keep the scope narrow, and do not run that cleanup automatically.
- Treat short phrases like `compact knowledge`, `knowledge compact`, `compress knowledge`, `clean docs/knowledge`, and `remove duplicates in knowledge` as triggers for that runbook.

## Quality Bar

- Prioritize accuracy over speed.
- When in doubt, retrieve fresh data rather than relying on prior context.
- Use just-in-time context: fetch only the files, docs, and tool results needed for the current step.
- If a request is ambiguous, clarify before acting.
- Before finalizing important work, verify claims against current sources.
- For multi-step investigation or tool-backed analysis, use the [ReAct Pattern](docs/knowledge/patterns/2026-08-12-12-04-48-react-pattern.md) together with the shared [Agent Planning and Reflection Pattern](docs/knowledge/patterns/2026-08-12-11-39-23-agent-planning-reflection-pattern.md).
- For iterative improvement after a failed attempt, use the [Reflexion Pattern](docs/knowledge/patterns/2026-08-12-12-04-48-reflexion-pattern.md).

## Scope and Repository Exploration

Always start from the smallest area needed to complete the task.

### Work Order

1. First open the files directly named by the user.
2. Then check only their direct imports, call sites, types, schemas, tests, and used database models.
3. Search by specific identifiers: function name, endpoint, model, table, type, event, config key.
4. Expand to the full domain or repository only when local context is not enough.

### Do Not Do By Default

- do not scan the entire repository;
- do not read all documents in `docs`;
- do not cross into sibling repositories;
- do not investigate unrelated business domains;
- do not read generated, build, or dependency directories;
- do not fix unrelated code you find along the way;
- do not create documentation just to record the research process.

### Relevance Criterion

Open an additional file only when there is a concrete connection to the task:

- direct import or call site;
- shared contract, type, or schema;
- related test;
- used table or relation;
- producer/consumer of the same event;
- explicit link from a project index or task note.

A match only by similar name or a broad shared term is not enough.

### Stop Condition

Stop the investigation when you have found:

- the source of behavior;
- the affected contract;
- the direct consumers;
- the relevant tests.

Do not continue collecting context that will not change the decision.

## Knowledge Growth Rules

- Task notes are temporary working memory and are not a source of truth after completion.
- Do not create durable notes automatically after every task; promote task knowledge only when it is reusable, expensive to rediscover, non-obvious, and still valid after completion.
- Update an existing domain summary instead of creating another summary for the same subject.
- Keep project indexes compact navigation routers; move detailed material into topic-specific files.
- Do not duplicate knowledge across decisions, patterns, gotchas, invariants, and summaries. Link to the source document instead.

## Evidence Priority

When sources disagree, prefer:

1. current executable code and tests;
2. current schemas and public contracts;
3. active decisions and runbooks;
4. navigation maps and summaries;
5. completed task notes;
6. archived notes.

Documentation must not override observable current behavior unless the task is explicitly to implement the documented target state.

## Note Lifecycle

Every durable note should include:

- `Status`
- `Last Reviewed`
- `Source Of Truth`

`Review After` is optional and should be used only when a note is actively maintained or review automation exists.

Suggested statuses:

- `Active`
- `Deprecated`
- `Superseded`
- `Archived`

Completed task notes should not be treated as source of truth. Search archived tasks only when current documentation is insufficient or historical context is explicitly required.

## Verification

- Run the smallest useful check for the affected area.
- If checks are skipped or unavailable, say so clearly in the final message.
- This repository's checks: while working, `npm run test:quick` (lint:names, the unit tests and the integration files with the most coverage per minute, about 5 min) and `npm run test:integration -- <name>` for the integration files of the area touched (those whose file name contains `<name>`); once at the end, the full set — `npm run lint:names` and `npm test` (unit), `npm run test:integration` (every DuckDB + dbt + MetricFlow file on the named dbt environments, heaviest first, four side by side: `scripts/run-tests.mjs`), `npm run eval:check` (every eval case's SQL against the fixture warehouse). Tests assert on data, never on generated text — see [Testing](#testing-hard-rule).

## Git

- Use Conventional Commits.
- If there is a task key, put it at the beginning of the subject.
- Before every commit, follow the commit preflight review runbook in `docs/knowledge/runbooks/`.
- If the review finds a problem, show it to the user first and only commit after it is fixed.

## Safety

- Do not use destructive commands without explicit request.
- Do not revert user changes that you did not make.

## Notes

- If the target repository has `docs/knowledge/`, use it as the project memory store.
- If the target repository has `.cursor/rules/`, keep `workspace.mdc` as a thin reference to `AGENTS.md`.

## Project Conventions

The rules of this codebase. HARD RULE marks an invariant a change must not break; tests hold most of them (named beside each rule).

### Data model (HARD RULE)
- Sources are identified by their `meta.mcp.role` — NOT by name. (That block lives under `config:`
  on the model and on every column — `config.meta.mcp` — the place dbt 1.10+ and dbt Fusion read,
  and the only place the loader reads; a block at the top-level `meta:`, or a key the loader does not
  read, is refused at load, naming where it sits.) The dbt model /
  SQL file can be named anything; the role is the identity, and exactly one model
  per role. Sanctioned roles:
  1. **an events SOURCE** — one row per event, detected by its event_name/
     event_data/time columns. There may be SEVERAL (e.g. `events` for product
     analytics and `crashlytics` for crash reports). They are INDEPENDENT AND
     EQUAL: each owns its `known_events`, its event-scoped `*_of_event_data`
     properties, its `meta.mcp.primary_entity` and its own space in the value
     index (keyed by `(source, property)`), and they are never mixed. No source is
     privileged: the SOURCE is always a separate argument — `semantic_index({
     source, event })`, `build_model({ source })`, a semantic_model measure's `source`
     — never glued into a name. Within a source, names are used as-is. A source is
     named ALWAYS, in every catalog, including one that declares a single source:
     one address for one thing, so no name ever has a second, owner-less spelling
     that a reader has to trace back to a source.
  2. **users** — the user-attributes dimension (one row per user).
  3. **experiments** — A/B-test assignments (one row per user×experiment:
     experiment_name, variant_group, assigned_at, ended_at); joined onto events by
     its join contract — the user AND the experiment named (a value) — for A/B analysis.
  4. **a MEASURES source** — a non-events fact whose columns are amounts, not
     events (e.g. `acquisition`: one row per player×day with cost/impressions/
     clicks). It has no `event_name`; it declares its own time axis
     (`meta.mcp.is_time`) and its own measures, and joins to users by the user
     entity; onto other rows by its join contract — the player AND the day
     (`time: { same_day: <its day column> }`), so the daily rows do not fan out.
- Do NOT invent other tables/fixtures (no orders/customers/Jaffle, no "step"
  tables). Only the roles above.
- THE SCHEMA MARKS WHAT MAY BE AGGREGATED; THE CALLER PICKS THE FUNCTION. Any
  column of any source may carry `meta.mcp.measure: true` (or an object with
  `unit`/`label`/`description`) to mark it an AMOUNT, and any model may carry
  `meta.mcp.measures: { <name>: { expr, ... } }` for an aggregatable expression.
  NEITHER fixes an aggregation: a task writes a measure `{ name, expr }` whose
  expression is the aggregate function it chooses per question over that column
  (`{ fn: sum | average | min | max | count | count_distinct | median | percentile,
  args: [{ column }] }`; the rows where a condition holds are folded by the aggregate
  over a `case` that yields its argument there — `count` of `{ fn: "case", cases: [{ when:
  [c], then: { value: 1 } }] }`) — the same column is summed for one question and read at
  a p90 for the next. Adding `agg` to a catalog declaration is the OPT-IN exception: it additionally
  publishes a governed measure whose function is fixed for everyone (any of dbt's,
  sum_boolean included, validated at catalog load); the free choice over the raw
  column remains.
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
  A CONVERSION (B within a window of A: retention, start-to-complete) is a pipeline too —
  match_recognize + the seconds between the steps (recipe `conversion_metric_window`); a
  generated context declares no conversion metric, since MetricFlow filters only its base
  side (dbt-labs/metricflow#1199) and compares its window at the time dimension's grain. The
  project's own conversion metrics are queried with that said in the answer.
- Segmentation/joins use user attributes on `dim_users` and experiment assignments
  on the experiments source, joined to events by the user entity — from ANY events
  source that carries the user entity.
- JOINS ARE DECLARED IN THE SCHEMA (HARD RULE). For the SEMANTIC LAYER a model declares
  `meta.mcp.entities: { <relationship>: { type, key: [...] } }`; a key may span SEVERAL
  columns, and the two sides may name their columns differently — only the relationship
  name and the NUMBER of key parts have to agree. `primary`/`unique` makes the model the
  join TARGET (exactly one owner, unique per row there); `foreign` points at the owner; a
  metric query groups by `{ source, column, via? }` (MetricFlow's `<relationship>__<column>`
  underneath), and a relationship nobody owns has no governed path (MetricFlow joins only
  onto a unique key). A side may declare `variants` when one relationship is carried by
  SEVERAL alternative key columns.
  ONTO A PIPELINE'S ROWS a model is joined only by the JOIN CONTRACT it declares —
  `meta.mcp.join` (src/catalog/joins.js): `unique: true` (the authors' word that the key
  is unique on that model — trusted, never checked on data), `key: { <part>: <column> }`
  (a part may be `{ by: <select part>, columns: { <word>: <column> } }`: the column a
  word picks), `time: { within: [<from>, <to>] } | { same_day: <column> }`, `select:
  { <part>: <column> | [<words>] }` (a value the model is filtered to before the join, or
  a choice among words). A model without one is not joinable (an events source usually declares
  none), and a contract naming a column the warehouse lacks is dropped at grounding. The
  join step names EVERY part and nothing else — `{ stage: "join", source, on: { <part>:
  <a column of the rows | a value> }, attrs }`, one closed form per joinable model — each
  key part and the time a column of the rows AT THAT STEP; a select value is checked
  against the value index as a where's constant is. `attrs` carries attributes only: a
  joined model's amounts (its `measure` columns) would repeat on every row that meets it,
  so they are measures of the semantic layer. Do NOT hardcode a pair of column names in
  `src/` for a particular join, and do NOT add a per-role join path: a new join is a
  schema key, not code.
- JOINING A SLOWLY-CHANGING MODEL IS POINT-IN-TIME. A model with a validity window
  (`meta.mcp.dimension.validity: start|end`) holds several versions per key, so the
  key ALONE matches every historical version and inflates counts. The governed path
  applies the window itself; a pipeline names the moment in the join contract's `time`
  part — required, so the time being asked about is visible at the call
  site. MetricFlow allows such a model exactly one join key, as its natural key: a
  second `primary`/`unique` key there is rejected at catalog load, and measures on it
  are dropped with a warning (count on an events source instead) — a declaration whose every metric
  would be dropped so is refused in the call, nothing created.
- A/B significance is computed in JS by `experiment({ action: "analyze" })` (src/experiment.js) over
  per-group aggregates (proportion → z-test; mean →
  Welch t-test; ratio → delta method; cuped → variance reduction). A group's sums of one value are
  `{ sum, sum_squares }` wherever a test reads them — a mean group's, a ratio's numerator and
  denominator, a CUPED group's own and its covariate's — with `sum_products` beside a pair; they are
  mapped onto src/stats.js's internals at the edge (src/experiment.js) and nowhere else.
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

### Protocol surface
- THE OFFICIAL SDK OWNS THE PROTOCOL. The server is built on `@modelcontextprotocol/server` v2
  (protocol 2026-07-28; it also serves clients that open with the 2025 `initialize`, from the same
  factory). `src/mcp-server.js` only says WHAT is offered — tools, resources, skills, the Apps view,
  tasks — using `src/mcp-surface.js` (+ `tasks.js`, `skills.js`, `apps.js`). A TOOL IS ONE DEFINITION
  (`defineTool`, src/tools/define.js — name, title, description, annotations, side /
  reads, waits / precheck, view / appsOnly / appCallable / cardField, run): the core's in
  src/tools/core.js, a feature's in its own module, all in the engine's one registry (`engine.tools`),
  and the surface reads nothing else — no table of titles, hints or hidden names beside it; a core
  tool's input schema is built with the others from the catalog (src/schema.js) under its name, and
  test/unit/tool-definitions.test.js holds the two to each other. A tool that only reads is never
  merged with one that removes (`context` lists and describes; `delete_context` removes): a client asks
  before a destructive call, and must not have to before a read. Do NOT hand-roll wire
  behaviour the SDK provides (headers, envelope, discover, sessions, error codes); the one exception
  is `src/mcp-tasks.js`, which exists only until the SDK serves the Tasks extension.
- EVERY TOOL TAKES ONE FIELD, `request`, AND ITS SCHEMA IS NEVER CUT (HARD RULE). What a client is
  shown is `wireSchema(engine.schemas[name])` (src/schema/transport.js): a closed root object whose one
  required field is `request`, the tool's own schema as its value, `$defs` at the root — the one root
  every host's API takes (Anthropic's refuses a union there, OpenAI's strict mode a root anyOf). The
  surface unwraps it at ONE point (`requestOf`, runTool) and the engine validates `request` against
  the same schema it published, so what the model sees and what is checked are one schema. There are no
  old names: every tool is listed and called by its one name (no alias, no unlisted tool). What a tool
  hands its input to is a private engine METHOD (`_analyzeExperiment`, `_buildPipeline`, `_dropContext` …)
  with an input contract named `<tool>.<mode>` (`experiment.analyze`, `build_model.pipeline`,
  `delete_context.context` …; `METHOD_CONTRACTS`, src/schema.js), validated and never offered. A tool's
  modes are an `anyOf` of CLOSED forms (`form` in src/schema-kit.js: a pinned `const`/`enum` tag or
  distinct required keys, `additionalProperties: false`), pairwise disjoint so the anyOf means oneOf —
  a field a mode does not read is refused, not ignored; a union of VALUES (a pattern, an enum, a type)
  is the other kind, and a bare `{ required: [...] }` branch beside open properties is neither (an "at
  least one of" is written as its forms: one, the other, both). The portable subset is the only one used:
  `anyOf`, `$defs`/`$ref`, `enum`/`const`, `pattern` — no oneOf / allOf / not / if-then-else /
  discriminator, in a core or a feature schema, or in the generated facts sheet
  (test/unit/schema-portability.test.js holds every listed schema to it, and every union to being
  closed and disjoint). A refusal names the form the value meant and its fields (`explain`,
  src/validate.js). Do NOT strip or simplify a schema for a client: a host that cannot take a
  construct is served by writing the schema in the subset, never by showing less than is checked.
  Every call shape written in this file, the descriptions and the guides is the CONTENT of `request`
  unless it is spelled `tool({ request: { … } })`. `MIN_FOLD` (100) is the smallest repeated subtree
  the transport folds into `$defs`.
- ONE VOCABULARY PER CONCEPT, IN EVERY TOOL (HARD RULE): an aggregation is a FUNCTION (`fn`:
  `average`, a quantile `percentile` with its `percentile` parameter), the name a step produces is
  `name`, a time bucket is `grain`, a list a tool runs in order is `steps` (one of them: `step`) — the
  pipeline builder's and a read's, a metric query's (its metrics step among them), an eventstream's
  start and its library steps — each item tagged by what it is (a SQL stage by `stage`, a library op by `type`),
  tasks are read with `task_ids` and paged by `offset` / `limit` in every query tool, and a condition,
  a measure and a computed value are ONE EXPRESSION GRAMMAR — `{ fn, args: [expressions], …its parameters }` over
  leaves, nested to any depth. A CONCEPT HAS ONE DEFINITION — built by ONE builder, under ONE name in
  `$defs`, its groups titled alike in every tool — its forms grouped by what they need to work: an
  expression one definition PER KIND a tool takes (`EXPR_KINDS`, src/pipeline/compute.js) — the row
  expression `$defs.expr`, a semantic measure's `$defs.aggregate` (exactly ONE aggregate, its `args` row
  expressions), a derived metric's `$defs.metric_expr` — all built by `exprSchema` from `FNS` and
  `PLACES` (one closed form per leaf, the rows' and the refs that name a value, one per function shape,
  `args` recursive through the kind's own def, a measure's through `$defs.expr`), a window function's
  `over` the window `$defs.over`, an aggregate over a window's `$defs.over_frame` (the same and its
  `frame`), both by `overSchema`, `$defs.stage` (`stageDefs`,
  src/pipeline/stages.js — titled groups, `STAGE_GROUPS`: SQL over rows, over a source's events
  (match_recognize), on a runtime (python; in the retentioneering tool also
  the library's ops, the feature's own runtime group), in the semantic layer (the metrics step — no
  pipeline stage, so not in the registry a build reads: its one definition, `METRICS_STEP`
  (src/schema/fields.js — its form, its group, what another place says of it), is offered by the place
  that takes it, query_model's `STAGE_PLACES.metric_scope`, as a feature passes its runtime
  group)), `$defs.ref` (`refSchema`, src/schema/refs.js —
  the catalog: `{ source }`, `{ source, event }`, `{ source, column, via? }` a model's column (`via`
  where a place reads one), `{ source, property }` an event property; the semantic layer:
  `{ semantic_model, dimension, grain? }`,
  `{ entity }`, `{ metric }`, `{ time: "metric_time", grain? }`) and `include: [...]` (what an answer
  adds — `columns`, `steps`, `yaml`, `plan`, `coverage`, `details`, an enum per tool). What a PLACE
  takes of it is one table each — `PLACES` (src/pipeline/compute.js), `STAGE_PLACES`
  (src/pipeline/stages.js), `REF_PLACES` (src/schema/refs.js), a feature passing a place of the same
  shape. IN EACH TOOL'S SCHEMA THE DEFINITION HOLDS WHAT THAT TOOL'S PLACES TAKE — the union of its
  places (`TOOL_PLACES`, src/schema.js; a feature passes its own), nothing else, a group none of them
  takes left out: a read's has no join, unnest, funnel or python stage, no event property and no `raw`,
  a semantic declaration's no window and no aggregate in a row (its measures are their own kind),
  semantic_index's and memory's ref no form of the semantic layer.
  So what a tool cannot take is refused by its own schema, and its listing carries no form it has no use
  for (every request carries the tool list: test/unit/schema-portability.test.js holds its size). It is
  NEVER SPLIT PER PLACE inside a tool (no second definition of a kind beside it — a kind is a closed part
  of the grammar, `EXPR_KINDS`, not a place): where the places of
  one kind take different parts (a metric query's steps before its metrics step and after it; an eventstream's start,
  filter_events and its library steps), each is checked when the value is built, as a function's
  placement is, and the refusal names the place and what it takes. What the schema does not say, the
  build checks: a name's existence and scope at its step, types (text against a number, a property of
  another source), a column outside an aggregate only when grouped by, a function's placement (an
  aggregate in a row only with `over`, a window only in a compute stage — the schema holds it only where a
  kind is its own, a semantic measure's), name collisions, metric cycles, the order of stages. A list of
  a table's OWN columns stays a list of names (an aggregate's `group_by`,
  project, unpivot, an eventstream's segments and path); anything else names a thing through a ref or
  an expression leaf. Its SQL comes from ONE writer (`exprSql`, and `conditionListSql` for a slot, each
  told the place); the
  functions are one table (`FNS`, src/pipeline/compute.js — scalar, condition, logic, aggregate,
  window; a function is added there once, its schema form and its SQL beside each other). A CONDITION
  is an expression with a boolean value: a comparison (`eq neq gt gte lt lte`, `in not_in` with each
  member its own argument, `between`, `is_null is_not_null`, the text tests — `OPS`, src/conditions.js,
  typed and written by its one `predicateSql`), `and` / `or` / `not` over conditions, a boolean column;
  every slot that takes conditions — a where stage's `conditions` (a metric query's among them), a CASE
  branch's `when`, a funnel step's `where`, a semantic model's `where`, the
  retentioneering stages' and filter_events' — is a LIST of them that all hold (`conditionSlot`,
  src/schema-kit.js). A missing value is two-valued everywhere: a comparison with one does not hold
  (`neq`, `not_in`, `not_like` mean present and different), `not(c)` holds wherever `c` does not, a
  `concat` is missing where any part is (each part read as its text), a missing array's length is 0 on
  both warehouses, and a boolean a compute stage (or a computed semantic dimension) stores is never
  NULL. A VALUE'S TYPE IS WHERE IT IS READ, AND CONVERTING IS
  `cast`: a column has the warehouse's type (where the warehouse was asked: ONE rule of grounding,
  `groundedType`, src/catalog/column-types.js — the catalog's, a build's and a join's), a `{ property }`
  the type the catalog declares (text where it declares none; an array as it is stored — a native one of
  its items, as its column is tracked (`nativeArrayType`, the one reader — a `{ property }` read's and an
  unnest's): the warehouse's where it was asked, else the catalog's `items`; JSON text otherwise, a
  payload key's read as its JSON), a JSON object's `field` (the leaf's, json_field's) text, an array's
  element (element_at, array_last, an unnested one) the type it is stored as — a native array's items
  (not claimed where they are not known; a native struct is no JSON, so not claimed either), a JSON
  array's text, an unpivot's value column the one type of the columns it folds (numbers of any kind
  one — folded through one on BigQuery —, any other mix refused, saying to cast); another type is
  `{ fn: "cast", args: [x], type }` (SAFE: what will not convert is
  missing). ONE CONVERSION ON BOTH WAREHOUSES (`castExpr` / `fromText` of each dialect): to `int`, the
  number a value holds — a number's, a text's alike — rounded half away from zero ('9.99' → 10, '2.5' →
  3, a word missing), a flag 1 / 0; a text read only where it is written as BigQuery reads a number (so
  '1_000' and '0x1F' are missing on both) and through an exact decimal of NUMERIC's 38 digits and 9
  places, as a flag where it says 'true' / 'false' (any case), as a moment where it is written as one
  (with a zone the instant it names, else UTC) (`fromText`: cast's and every typed read of JSON, the
  payload's one read under a cast included); a value of no known type (a raw's) read as its text, a
  flag's true / false as 1 / 0. Only
  what MAKES a value says its `type` — `cast`, `case`, `raw` (nothing else knows what its SQL returns): a
  case's value is converted to the type it says where its branches are of another, a raw's type is its
  caller's word (taken where it is compared, read as of no known type where it is converted), and a raw
  that says none claims none; a read never does. What each place takes (`PLACES`): a step over a
  source's rows (a pipeline build, an eventstream's start) `{ column }`, `{ property, field? }`
  (an event property read where it is stored, while the rows are that source's events), `{ value }` (a
  scalar, never a list) and `{ now: true }`, every function; a read of stored rows (query_model without a metrics step,
  a drill) the same without `{ property }` and `raw`; the steps after a metrics step (`metric_result`)
  those and the refs its group_by takes and `{ metric }`; filter_events (the feature's `FILTER_PLACE`)
  a column, a constant and the conditions; a semantic model's where, dimensions and measures `{ column }` (a
  column, an entity key, a declared amount), `{ property }` on an events source, `{ value }` and
  `{ now: true }`, no window and no `raw`; a where step before a metric query's metrics step
  (`metric_where`) the refs its group_by takes and
  `{ value }`, with conditions, logic and scalar functions; a derived metric's `expr` `{ metric }` and
  `{ value }`, with add sub mul div round floor ceil abs coalesce least greatest.
  Where a function may stand is checked when the value is built, and the refusal names the rule: no
  aggregate in a row place without `over`, a window only in a compute stage, a column outside every
  aggregate of a measure only when it is grouped by. A MEASURE is ONE form wherever rows are
  aggregated — a pipeline's aggregate stage (a read's alike), a semantic model (`+ label`) —
  `{ name, expr }` (`measureForm`, src/schema-kit.js): in a pipeline any formula over aggregates (a
  `count` with no args counts rows), in a
  semantic model exactly ONE aggregate of the task's functions (a formula over several is several
  measures and a derived metric). A CONDITIONAL AGGREGATE IS AN AGGREGATE OVER A `case` — an aggregate
  takes no `where`: the rows where `c` holds are counted by `count` of `{ fn: "case", cases: [{ when:
  [c], then: { value: 1 } }] }`, their revenue is `sum` of the case that yields the price there; the case
  is missing on every other row, and every aggregate skips a missing value. An `else` gives the other
  rows a value, which every aggregate folds as the value it is — `average` of `then: 1, else: 0` is the
  share of the rows where `c` holds, `max` of it whether any row holds it, `sum` with `else: 0` adds
  nothing. Under `count`, `count_distinct` (and its approximations: `approx_count_distinct`, and the
  sketch `hll_init` builds for one — `COUNTING_FNS`) an else
  always changes what is counted — they count any value, so every other row is counted, or the else's
  value is one more distinct value — so there it is refused when the value is built, folding or
  windowed, saying to leave it out (`else: { value: null }` says nothing). A pivot's `measure` is such an
  aggregate expression, each cell folding only its rows the same way — its condition (`on` = the value)
  a case over the aggregate's argument, or added to every branch of the case already there and to its
  else (the cell's rows keep the else's value): `foldWhere`, src/pipeline/compute.js, the ONE builder of
  a conditional fold, which an earlier aggregate's `where` is converted by too; a semantic measure is
  written the same way (MetricFlow is handed the case as its expr). What a semantic metric
  reads is named by a string — a simple or cumulative metric's `measure` — or by `{ metric }` leaves:
  a derived metric's `expr` (its inputs read off the leaves; a ratio is `div` of two metrics) — and a
  model is loaded into a semantic layer by its semantic_model step: a measure of it (`source`), or a join
  of it for its columns (`join: [{ source, on }]`). A SORT KEY over a table's rows (the
  order_by stage — a build's, a read's, the steps after a metrics step — and a window's order) is ONE
  item `{ key, direction?, nulls? }` (`SORT_KEY`),
  NULLs last unless it says first, written explicitly on every warehouse; a partition (a window's, a
  funnel's) is a column, or `{ entity }` where the rows are a source's (a build, an eventstream's start
  — `entities` in `PLACES`); a share kept is a fraction (`share`, 0–1); a time window is
  `time_range` `{ start, end, timezone }` (ONE builder, `timeRange` in src/schema-kit.js, read by
  src/time-range.js `resolveTimeRange` — the error log's too); a substring filter is `search`; a join of a model onto rows is `{ source, on }` — its join contract's parts, the one form of every join step; a thing
  of the catalog or the semantic layer is named by the one ref (`REF_PLACES`) — semantic_index's views
  and what a memory note is `about` take `{ source }`, `{ source, event }`, `{ source, column }`,
  `{ source, property }`, a metric query's group_by `{ source, column }`, `{ source, property }`,
  `{ semantic_model, dimension }`, `{ entity }`, `{ time }` — and their answers speak it alike (a
  model's column is `column`, an event's payload property `property`; `via` only where several
  relationships lead to the model); a variant of a build is a `fork` under a `name` of its own;
  both builders answer a step with what it changed (the columns, the eventstream's shape: added and
  removed) and `steps_count` — `include: ["columns", "steps"]` for all of them; the checks are two
  words by what they need, said in one wording (`DRY_RUN` / `VALIDATE`, src/schema/fields.js):
  `dry_run` compiles and shows, reading nothing and building nothing (a declaration; a query, after
  the context's build — its SQL after the steps with its `output_columns`, a pipeline read's written
  over `{{ ref('<model>') }}`, as a preview's `model_sql`), `validate` checks on the warehouse, a task
  (the pipeline preview: dbt run --empty; a context's describe: MetricFlow, over a time_range the
  warehouse); a week is the ISO
  week, and a date part or a difference of moments means the same on every warehouse. A computed column is ONE
  expression of that grammar (a compute stage's `expr`; one that is a condition is stored as a boolean),
  under a name of its own — a compute or an unnest naming a column the rows already have is refused; a
  window function takes `over` (`sum average min max count` with it are windows), and
  `raw` stays the escape hatch — its columns STRUCTURED, items of its `args` with `{1}`, `{2}`, … in its SQL
  where each goes, written quoted by the server — POSITIONAL: a word of its text spelled exactly as a
  column of the step is refused, with no list of words beside it; the rest goes as written, as ONE
  expression — a `;`, a comment or a parenthesis that does not balance outside quoted text is refused —
  and with no Jinja opener (`{{`, `{%`, `{#` — dbt would run it); a text holding one is a constant in
  `args`. It is a
  build's escape hatch: a read (query_model without a metrics step, the steps after a metrics step, a drill) takes
  no raw (`PLACES.stored_rows`), and the query tool's schema does not hold it. A constant
  is written in the type of the first argument that is not a constant, one rule for every comparison
  (`typedValue`, src/conditions.js — a number or a flag against a text is its text, a moment written
  with an offset of its own (Z, ±hh[:mm]) against a moment the UTC instant it names, to the microsecond
  — and a partition bound from one its UTC day; a date-time in a spelling the warehouses read apart (a
  zone name, a one-digit offset) refused —, and a text is not ORDERED against a number, which would order it as
  text: refused, saying to cast), and the value array_contains
  looks for in the type of the array's elements (a native array's items, a JSON array's text).
  Every column name the server writes into SQL is quoted by the warehouse's dialect, in every stage and
  every read. A caller who brings another tool's spelling (`avg`, `q`, `agg`, `as`, `targets`, `text`, a
  `ratio` metric) is told this server's (src/validate.js) — a hint, never an alias; a field only renamed
  (`stages`, `stage`, a model column written `property`) is told its name (`steps`, `step`, `column`). A
  value in an EARLIER spelling of this server is no form of its schema and is refused as any value it does
  not take — nothing converts a call's input; what a store KEPT in one (a draft's steps, a kept eventstream,
  a stored declaration or display, a deployment's recipe file) is carried over on read, and every such
  converter is in ONE table (src/earlier-spelling.js; a draft's steps src/pipeline/earlier.js, an
  eventstream's src/retentioneering/earlier.js). The
  retentioneering steps keep the LIBRARY's own grammars (its facts sheet), not this one.
- Skills and the Apps view RENDER existing objects (buildGuide, `engine._recipe`, the python
  guide, the research guides of `src/research-guides.js`, a tool's result); they never carry text or numbers of their own. The Apps view follows the
  official ext-apps templates and draws shadcn/ui components (Card, Badge, Button, Table — the
  pivot's only, Alert, Accordion, Chart) over the HOST's style variables, whose fallbacks are the shadcn neutral
  theme; its build is checked in and held to its sources by a test. THE VIEW DRAWS, AND READS ONLY ITS OWN RESULT:
  every tool is `visibility: ["model"]` except `drill_result` (`["model", "app"]` — hosts refused a
  card's call to an app-only tool; the server answers it only for a DRAWN task), the view resource declares an empty `csp` and the page its own CSP, and the view's ONE
  server call is drill_result for the task it was drawn from — a drill-down's next view — a pivot
  row opening (`display.kind: pivot`) or a chart mark clicked (`display.drill`): the card sends the
  path taken and the level chosen ({ task_id, path, level?, mode? }), and the SERVER makes the read —
  its task's stored table filtered to the path and grouped by the level, in the pipeline's own read
  stages (a where, an aggregate folding each value with the display's `fn`, an order_by) — by the view
  model's one definition of a view over the display the card was DRAWN with (kept with the task), so a card reads
  only the views of what it drew (no other tools/call, resource, model message, link or network) — a
  test holds its sources to that; the server serves it only for a task that was drawn.
  Everything else interactive stays on the data already in the page.
- BUILD, QUERY, SHOW (HARD RULE). ONE builder, `build_model` — a build of steps: the pipeline's stages,
  and as its LAST step a `semantic_model` step, the semantic layer over the build's source, or over the
  table the steps before it built (src/pipeline/semantic-stage.js; its form `SEMANTIC_MODEL_STEP`,
  src/schema/fields.js, offered by `STAGE_PLACES.build`). That table is a model of the CONTEXT's catalog
  (`Engine._catalogOf`, src/catalog/built-model.js) — its time axis the step's `time`, its foreign keys
  its joins', named `{ semantic_model: [<the build's name>], dimension }` in a query, no model of the
  server's catalog — built first by the same materialize, the layer parsed once it stands — and ONE query tool,
  `query_model`, for both sides; the sides stay inside the engine (`TASK_KINDS`, src/engine.js: a
  semantic layer's parse and a pipeline's build are build_model's tasks, a metric query and a read
  query_model's). A context holds ONE semantic layer, its build's step: it is changed by edit_step and
  materialized again, which replaces what the context held. Its measures fold the main model's rows, or —
  with `source` — another model's own, compared beside them on metric_time; its `join` names the models
  whose attributes the metrics are grouped by, each on its join contract, checked against the key
  MetricFlow joins it on. Its metrics, measures and computed dimensions are stored under the names they
  are declared by (no prefix: nothing else in the context shares them), so what MetricFlow refuses of a
  name — a grain or a reserved word, a name another element of the layer holds as another kind, a
  governed measure's — is refused when the step is added (src/compile.js, src/yaml-render.js); a
  dimension declared over a column takes the place of that column's own. A call that
  STARTS warehouse work — a build (a materialize, a semantic layer's included) or a query
  (`query_model({ context_id, steps })` — a QUERY IS ITS STEPS: with a metrics step it is a METRIC
  QUERY (a semantic task), without one a READ of the context's stored pipeline table (a pipeline task;
  `time_range`, `materialize` and `include` belong to a metric query and are refused there). A metric
  query's steps hold ONE metrics step `{ stage: "metrics",
  metrics, group_by? }` — what the semantic layer computes (`STAGE_PLACES.metric_scope`, its own group of
  `$defs.stage`); before it only where steps, the rows its metrics fold (their leaves what group_by names
  — `PLACES.metric_where` —, every one ANDed into MetricFlow's where); after it a read
  (`STAGE_PLACES.metric_result`, `PLACES.metric_result`) over its result, NAMED AS THE QUERY NAMES IT — a
  group_by item by the same ref group_by takes (in an expression and as an order_by key), a metric as
  `{ metric }`, a column a step there made by its name — each resolved to the result's column it gave
  (`_metricTail`), so no caller learns how result columns are spelled; one the query is not grouped by
  is refused (add it to group_by, or filter before the metrics step), a where there filtering the result
  (a having). A read in `steps` is of the pipeline's own stages, those that keep it one table: where,
  compute, aggregate, pivot, unpivot, order_by, limit, sample, project — of the stored table, or of a
  metric query's result; a join, an unnest, a
  funnel or a python step is a build from the task) — validates its input in the call and returns ONLY `{ task_id, context_id? }`; it
  never waits (the task runtime, src/task-runner.js — `engine.tasks`; tasks on one context run in order, except a query only compiled — dry_run, on either side: its SQL after the steps and its `output_columns` — which waits for the context's build alone). A metric query with no step after its
  metrics step, or a lone order_by step there MetricFlow orders as asked (its ORDER BY writes no NULLS), runs as `mf
  query`; any other steps after it run over the SQL MetricFlow compiles for it, its columns renamed to the
  caller's names, rendered by the one read compiler (`renderRead`, src/pipeline.js) and run through
  the dbt client's `show` — the same answer, paging and KEPT_ROWS either way, and `materialize: true`
  stores the result after the steps. The query tool also takes a
  BATCH — `{ context_id, queries: [...] }`, of any size, metric queries and reads mixed — which checks EVERY query before
  any starts (one mistake refuses the batch), starts one task per query and returns ONLY
  `{ task_ids, context_id }` (`engine.tasks.startBatch`); the members run side by side (each dbt process
  with a target directory of its own), after what was queued before them and before what is
  queued after. query_model reads tasks of both sides back (the started answer names it in
  `read_with`) with ONE form, `{ task_ids }` —
  one id or several: it waits (≤ MAX_WAIT_SECONDS per call) and returns each one's result under
  `results`, in the order asked (`TaskRunner.readAnswer`; a read whose every task failed is a tool
  error), `offset`/`limit` paging each one's result by its row numbers (READ_PAGE rows unless
  `limit` says) — a query keeps the first `limit` rows of its result (KEPT_ROWS by default), a stored
  table (materialize, a pipeline build) pages to its last row; a start takes no `offset`;
  `{ task_ids, cancel: true }` stops them at once (the task's own AbortController kills its
  dbt process; its work still runs down its failure path, so a build clears its in-flight marker); it
  refuses a task of a feature's side — before any wait — and it never draws. The side is
  the kind of work that started the task, persisted with it (the jobs table's `tool`: a builder's name,
  or a query's kind — `QUERY_KINDS`, src/engine.js), never guessed.
  `context({ action: "describe" })` is also the semantic side's INSPECTOR, for the project's own layer (no
  build to report it) and a task's context alike: where a context holds a semantic layer it reads the context's PARSED manifest
  (`src/semantic-manifest.js`, one reader for both YAML specs) and answers in the call — semantic
  models, each metric's definition and its `group_by` — what it can be grouped by, spelled as that
  context's query takes it
  (a metric of several semantic models only what every input reaches), the declaration's own
  mistakes; with `validate` it starts a semantic task instead (read with query_model), in
  which MetricFlow compiles each metric and, over a time_range, the warehouse runs each metric and
  each semantic model's dimensions, one by one where all at once fails, to name what fails.
  NOTHING HANDED BACK SPELLS METRICFLOW'S `entity__dimension__grain`: a query names what and where
  ({ source, column }, { source, property }, { semantic_model, dimension }, { entity },
  { time: "metric_time" } — the one ref, checked by `REF_PLACES.group_by`; in a task's context
  { semantic_model: [<its source>], dimension } names a dimension the task computed, { source, property }
  an event property it declared a dimension, { entity } a key its measure sources carry) and the server
  resolves it; result
  columns are the caller's names, and an explained query's SQL and plan and every failure message go
  through `Engine._callerSpelling`, which rewrites EXACT tokens only — each MetricFlow item's token
  for the query's metrics, the query's own references, `__<metric>` aliases, metric_time grains, the
  declared time dimensions' `<dimension>__<grain>` — never a pattern: a project's own columns may be
  named with `__` (measure__…), and SQL with them renamed would not run. Each occurrence is renamed
  alike, so the SQL as shown runs to the same rows.
  `display_model_result` is the ONLY tool that draws a MODEL result, for either side: it reads the task the way the
  query tool does (`_awaitRead`), validates `display` against the result's columns, and draws each
  task AT MOST ONCE (a second call is refused) — so one question gets one card by construction.
  `structuredContent` is carried by a display_model_result that drew (`drawn: true`) or an
  experiment called with `card: true`, only when `buildViewModel(...).kind !== 'none'` — and by every
  successful answer of a tool that declares an `outputSchema` (`output` on its definition,
  src/schema/outputs.js: time, context, delete_context, memory, explore_errors —
  an answer of one shape, from a tool with no view, since a host draws a card for every answer that
  carries structuredContent). A tool that answers with a result's rows (the query tool, a pipeline
  build) declares none: the rows would be carried twice. Every other answer is the text alone. A CARD EXISTS PER KIND, never per the size of a result: a kind that
  fits a picture has its card, a kind that does not has no card code at all (no view-model branch, no
  renderer, no field asking for it) and is answered in words. THE EXPERIMENT IS A SEPARATE PROCESS,
  NOT MIXED WITH display: it is statistics over numbers the caller brings — no task, no task_id —
  returned at once, and it draws its own card (the A/B test; the split check and the plan have none)
  only when asked with `card: true` on analyze (a card offered to an Apps client alone: `card: true`
  from any other is refused, `false` — no card — is what it gets anyway). A stored result is
  built on by a pipeline started from its task (`build_model({ action: 'start', name,
  from_task })`); `time` is a pure timer. Do NOT add a second tool that draws, a tool that waits inside a
  starting call, a reader shared by both sides, a read by table name, or route an experiment
  through tasks or display_model_result. The one sanctioned exception is a FEATURE's side (below):
  it has the same three roles — its builder, its query tool that starts AND reads back its own tasks
  in the same read (`{ task_ids, wait_seconds?, offset?, limit? }`; its side registered with the engine, a task of
  another side refused), and its OWN drawing tool,
  which draws only that side's finished tasks, each analysis at most once; display_model_result stays
  the only tool that draws a semantic or pipeline result. A feature is written against the engine's
  public surface — `engine.tasks` (the task runtime), `engine.host` (validation, a context, the time
  window, a source's columns, a model's config), `engine.ctxs`, the catalog and the job registry —
  never against the engine's private `_` members.
- A FEATURE IS SWITCHED ON AS A WHOLE, OR IS NOT THERE (src/features.js). A part of the server that a
  deployment may not want — today only retentioneering — is a feature: off unless its flag says on
  (`MCP_RETENTIONEERING=on`), and left out WITH ITS REASON (in the overview) when asked for where it
  cannot run. Off, nothing of it exists: no schema (so neither listed nor callable), no view page, no
  guide name, no routing trigger, no skill, no line of the instructions — the surface is exactly what
  it is without it. The core never names a feature: engine, surface, apps, guide, skills and
  overview each walk `engine.features` at ONE point (its tools become definitions in the same registry
  as the core's, a guide name + triggers, a skill, an instructions line, an overview entry, a form of
  delete_context — `deletes`, collected by `featureDeletes`). Do NOT add an
  `if (feature)` branch in the core, and do NOT let a feature reach into another side's tools.
- RETENTIONEERING (src/retentioneering/, the first feature): build = the DATA, SHAPED STEP BY STEP LIKE A
  PIPELINE — `start` declares the eventstream: the rows of an events source (its own columns, within a
  window) or of a task's table — a build_model pipeline's, where the rows are PREPARED (where, compute,
  join: a start takes no steps, so the tool carries no stage of the pipeline and no row expression of
  its own; its one `$defs.stage` is the core's with the library's ops as its runtime group, taken by
  add_steps / edit_step / insert_step, a SQL stage there refused naming build_model and from_task),
  then the columns it names (`columns.event` / `time`,
  `path`, `segments` — column names of the rows), rendered in SQL, materialized, its
  summary carrying the vocabulary and every segment's levels; then the library's own steps
  (`add_steps` / `edit_step` / `insert_step` / `delete_step` / `truncate` / `fork` /
  `preview`, the pipeline builder's own words), each CHECKED BY THE LIBRARY ITSELF as it is added
  (below) and answered at once with what it changed and `steps_count`, as the pipeline builder answers
  (`include: ["columns", "steps"]` for the whole shape / every step); `materialize` runs the steps not yet materialized
  in one dbt Python model and stores the eventstream after them (its columns' roles and each event's
  order carried in the table), a checkpoint an edit at or before it retires. Every start builds a table
  of its own (a fork of an earlier one keeps reading its rows), one build action at a time runs on a
  context, and a column a step makes must be an identifier the warehouse stores (quoted wherever SQL
  names it); query = the COMPUTATION —
  every analysis of one call over the eventstream AS MATERIALIZED (a query takes no steps of its own:
  a variant is a fork), read back a page of each table by its row numbers (`offset` / `limit`,
  READ_PAGE rows unless `limit` says, in the order its summary ranks them — the biggest transitions
  first — with what it computes beyond rows, a group's profile, whole; a page past the rows a task
  holds is read from the stored table), the card that draws it reading every row, and its card's
  scope from the table it read, in ONE dbt Python model (python/retentioneering_model.py, THIS server's code
  inlined; the caller's input is data, never code), on its own dbt environment (`retentioneering`); show = its own view (`ui://betti/retentioneering-view.html`, src/apps/
  retentioneering-view/, drawn with the result view's theme and shared pieces, src/apps/shared/) —
  display_retentioneering_result takes `{ task_id, display: { analysis, title?, edge_weight? } }`, as
  display_model_result takes `{ task_id, display }`; delete_context removes one eventstream in the
  feature's own form `{ what: "eventstream", context_id, eventstream }`, its tables kept until the
  context is dropped. It is
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
  What the library would take only as code gets a structured parameter of this tool's (`ADDED`,
  src/retentioneering/schema.js — today `filter_events.where`, a condition slot of the one expression
  grammar at its own place (the one `$defs.expr`, at filter_events' place — `FILTER_PLACE`: a column of
  the eventstream, a constant or the current time, the conditions and `and` / `or` / `not` — no scalar
  function, no raw, no event property, no window: a value computed from columns is a column build_model
  makes), written into the library's
  `sql` by the one writer for DuckDB with every name and constant quoted, a column compared as its
  constants' kind, and a comparison with a missing value not holding (neq / not_in / not_like mean
  present and different; `not(…)` keeps one, as the library's drop does; a kept step's negation is
  carried over as `not(…)`, so it keeps what it kept). The path-pattern
  language (path_pattern, an anchor's pattern, matches_pattern) is the library's parser's own, extracted
  into the sheet (`path_patterns`) and rendered in the guide; the library's relative doc links are made
  absolute in the sheet. WHAT EVERY REQUEST CARRIES IS KEPT SMALL: a library parameter is said in its
  docstring's first sentence in the schema (`firstSentence`), its whole docstring in the guide
  (`parameters`); a path metric's condition is ONE form per metric (`compactCondition` — a comparison and
  a membership, its value a constant or a list), the pairing of `op` and value checked in the call
  (`checkConditionPairs`).
  WHAT THE LIBRARY REFUSES, THE LIBRARY SAYS BEFORE THE RUN: every step as it is added, and every
  analysis of a query, is run by the library itself on the feature's environment — one warm process
  (python/retentioneering_check.py --serve, src/retentioneering/checker.js) — over two stand-in
  eventstreams of the SHAPE the eventstream has at that point (its event names, path columns, segments
  with their levels, custom columns); what both raise alike as a configuration error is refused in a
  fraction of a second with the library's own message, instead of minutes into the warehouse run, and a
  step that passes returns the shape it leaves, read off the stand-ins by the library's own schema — what
  the next step is checked against, as a pipeline stage is checked against the columns before it. It
  does not restate the library's checks in JS; a check that cannot run refuses nothing. No cap on analyses, steps, rows or
  tasks: nothing the library computes or returns is cut — only what a task holds in memory is bounded
  (a table's first rows, `keptRows`): a read pages every row by `offset` / `limit`, and the card that
  draws it reads every row. Left out, each for the
  reason in `NOT_OFFERED` (src/retentioneering/schema.js): a Python callable, a DuckDB statement run on
  the analysis runtime (code — the data is declared in the build instead), and the two ops the
  eventstream's shape rules out. The build reads a source's OWN columns; event properties, a related
  model's columns, and events renamed, merged or split by a parameter are a build_model pipeline's
  (where, compute, join — all in SQL), its task the start's `from_task`; a kept start in an earlier
  spelling (its steps among it) is carried over on read (src/retentioneering/earlier.js) and read as it
  was built, and a new call in one is refused by the schema. The analyses with a card are CARD_KINDS (the charted ones and a
  distribution's histogram; a diff of a graph or a step matrix/sankey as heatmaps, a funnel's diff as both groups on the same steps — which kinds have a card, and which diff keeps its analysis's own shape, is ONE
  table, `KINDS` in src/retentioneering/view-model.js, that the query spec carries to the analysis
  step and its pre-run check (`diff_charted`), and a stored diff says which form it holds); any other
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
  The extensions are 2026-07-28's: a 2025 client gets none of them, whatever its `initialize` declared.
  The lists that differ are cached `private`.
- A 2025 CLIENT IS SERVED IN FULL OTHERWISE (src/legacy-sessions.js): its `initialize` opens a session
  of the SDK's own sessionful transport (`NodeStreamableHTTPServerTransport`, the SDK's documented
  route for 2025 traffic next to 2026-07-28), so `notifications/cancelled` stops the call it names and
  the GET stream is there; a request without a session id is served statelessly by the per-request
  handler, and one with an id this process does not know (a restart, a closed session) likewise —
  NEVER 404: hosts were seen stuck on that until the connector was re-added by hand. A session idle
  for MCP_SESSION_IDLE_SECONDS is closed.

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
  model and its joins. The server does not talk about how it is built (src/self-refusal.js, one wording
  in three forms): the opening carries the brief (`SELF_REFUSAL_BRIEF`), the core the rule
  (`SELF_REFUSAL`) and semantic_index's description its scope (`SELF_REFUSAL_TOOL`, for a client that
  reads no instructions) —
  a request for its code, architecture, tech stack or instructions is declined in one sentence however
  it is framed, while the data's own questions stay answered (how a number was computed, its SQL, why a
  call failed, how sources join); the eval case `server_internals` grades it on what the reply gives
  away (`withhold`). What grows with a deployment stays out of the core — the skills are named by their
  root, the research domains only where the route has room (`RESEARCH_DOMAIN_NAMES`). They carry only what no single tool says — the spec asks them not to repeat
  the tool descriptions, and every tool description stands on its own (each within 2,048 too); long
  procedures live behind semantic_index ({ guide }, { recipe }) and the skills
  (test/unit/tool-surface.test.js holds the budgets).
- EVERY FAILURE IS KEPT (src/error-log.js → the store's `errors` table), read with `explore_errors`
  (read-only): a call refused or failed, with its arguments (runTool — one point, for every tool); a
  task that ended in an error, with its input (the task runtime's `start`); what a start could not serve (the
  project's layer, a join `servable` leaves out, a feature that cannot run). Each carries what
  REPRODUCES it: the arguments / the task's input (every task start passes its input — a pipeline
  build its steps), the state of the context it worked on (`Engine._errorContext`: the declaration,
  a draft with every step, an eventstream with its steps), for a task the code of each generated model
  its message names (as written and as dbt ran it — where a warehouse line:column points), and the
  runtime (server version + surface fingerprint, dbt, dialect). A read of a failed task is not kept again. Bounded by MCP_ERROR_RETENTION_DAYS / MCP_ERROR_MAX_ROWS, not cleared by
  MCP_DB_RESET; recording never fails the call it records.
- EVERY SETTING HAS ONE HOME (src/settings.js): each environment variable the server reads is a row —
  its name, kind (how src/config.js reads it), default and meaning — and is read through `setting(name)`
  / `loadSettings()` or, by a function that takes `env` as its argument, by name from it. `.env.example`
  is rendered from the table (`npm run settings:example`), and test/unit/settings.test.js holds the table
  to that file and to every variable src/ reads. Do NOT read `process.env.X` for a new setting without its row.
- THE ENGINE IS A FACADE OVER SERVICES (src/engine.js). A concern that stands on its own is a class
  whose constructor names every dependency it reaches — the value index as semantic_index shows it
  (`engine.indexViews`), the memory tool (`engine.notes`), a pipeline step's advice (`engine.advisor`),
  the best-effort warehouse reads with their caches (`engine.probe`), the task runtime (`engine.tasks`).
  The tool families that call each other and run through the context, the validation and the task start
  (semantic build / query / preview, the pipeline draft and its materialization, reading a task back,
  semantic_index's catalog views) stay the engine's own methods, one file per family under src/engine/.
  A new concern with a dependency set of its own is a service, not another mixin.
- A CHANGED SURFACE IS ANNOUNCED, NEVER LEFT TO A CACHE (src/surface-change.js). A host re-draws the
  cards in a conversation from its cached tool list, so a deploy that changes a tool must reach it:
  (1) the cacheable results (lists, resources/read, server/discover) carry a SHORT `ttlMs`
  (LIST_TTL_MS, one minute); (2) `tools.listChanged` / `resources.listChanged` are declared, and a
  start whose surface fingerprint differs from the one persisted by the previous process (the store's
  `meta`) announces `notifications/tools/list_changed` + `…/resources/list_changed` to every
  `subscriptions/listen` stream that subscribes within CHANGE_WINDOW_MS; (3) the fingerprint rides in
  `serverInfo.version` (`0.1.0+<fingerprint>`). Do NOT lengthen the list TTLs back to hours.

### Warehouses and dbt
- TWO WAREHOUSES, TWO DIALECTS: `bigquery` (production) and `duckdb` (local work, the tests, the
  default compose setup) — `src/dialects/{bigquery,duckdb}.js`. There is no Postgres. A DuckDB
  database is a FILE one process at a time may hold, so every dbt process and every request to
  MetricFlow on it takes the warehouse's turn (`src/dbt/process.js`, keyed by the database file read
  from the profile), MetricFlow kept warm (python/mf_server.py) lets go of it after every request, and
  a batch's members run one after another there (side by side on BigQuery).
- dbt IS REACHED ONLY THROUGH THE dbt CLIENT (`src/dbt/index.js` → `createDbt`, version read from
  the CLI): one contract (parse / run / seed / show / relationColumns / query / validate / warehouse
  / semanticSpec / semanticManifest / semanticModelSources / groupBys / pythonModelsOn / unparsedSqlConfig) over the installed dbt, each major version its own implementation
  — `src/dbt/v1.js` (dbt 1.x) and `src/dbt/v2.js` (dbt v2). Do NOT spawn dbt or `mf` anywhere else,
  and do NOT branch on the dbt version outside `src/dbt/`.
- ONE SEMANTIC LAYER, TWO YAML SPECS: the context is rendered once (`src/yaml-render.js`, legacy
  shape) and, for a dbt whose `semanticSpec` is 'latest' (v2, and 1.x from 1.12), converted by `src/semantic-latest.js`
  — the semantic model joins its dbt model's entry (merged with the project's own entry by
  `ContextManager.writeSemanticYaml`), keeping OUR semantic-model names so paths and metric names
  do not change. What the latest spec's parse writes differently into the manifest is corrected in
  the client's parse (a percentile is always approximate there: `config.meta.mcp_percentile` puts the
  request back).
  Metric queries go through MetricFlow's `mf query` on either version, KEPT WARM
  (`src/dbt/metricflow-server.js` → python/mf_server.py): a long-lived process per MetricFlow
  environment runs the CLI's own `query` command with the arguments built for the CLI — its CSV, its
  SQL and plan, its errors and exit code are `mf query`'s, read back as before — keeping each project's
  `dbt debug` setup and its parsed manifest (reloaded when the file changes) and building the engine
  anew for every query (its node numbering, the SQL's aliases, is a fresh `mf`'s). It is the ONE path:
  no fallback to a process; a server that cannot start fails the query with the reason, and a request
  cancelled or past its timeout kills its process (MetricFlow cannot interrupt a query).
- THE PROJECT'S OWN SEMANTIC LAYER IS READ AT START, NEVER BUILT (`src/project-semantics.js`): the
  semantic models and metrics DBT_BASE_PROJECT declares itself (either spec, any file names and
  layout under its model-paths — a model's only entry may be the one that carries its semantic model;
  NOTHING is keyed on a name: every name is read from the manifest dbt writes) are parsed once, before the tools are served, into ONE
  internal copy (`PROJECT_STORE`, never addressed or listed; re-read on every start), and EACH
  SEMANTIC MODEL IS A CONTEXT OF ITS OWN, ADDRESSED BY ITS NAME (context_id: "<semantic model>";
  `ContextManager.createShared` — no copy or parse per model; pinned: never gc'd, built on or
  dropped). There is no context for the layer as a whole. Where one of them is a valid context_id
  (query_model, context), the schema offers them as an enum next to
  the pattern any built context's id matches (`anyOf`). A context offers the metrics that read its
  semantic model (a metric of several models is in each of theirs), queried with
  query_model({ context_id: "<semantic model>", steps }) — `{ semantic_model, dimension, grain? }`,
  `semantic_model` ALWAYS a list: the chain of models the dimension is reached through (`["<own>"]` for
  the context's own model, `["X"]` for one joined to directly, `["A", "X"]` through a chain of joins),
  one spelling per item — and `{ entity }` in the metrics step's group_by and a where step before it:
  what a dimension is and where it lives (the steps after the metrics step name the result column a
  group_by item gives, as in every context). MetricFlow makes every join; what it needs is its own name for the
  item, which always carries the entity path (`media_source__label` — it takes no bare `label`, even
  with one path). WHAT A METRIC CAN BE GROUPED BY IS METRICFLOW'S WORD, NEVER WORKED OUT HERE (HARD
  RULE): at start the server asks MetricFlow (`groupBys`, its `list_group_bys`) for every metric's
  items — each dimension with its semantic model and entity path, each entity, metric_time with its
  grain — and finds the item a reference names in that list (src/group-by-items.js); each hop of
  MetricFlow's entity path is named by the model it joins onto (the one model unique on that entity
  carrying the next — `annotateChains`), so a chain is written in models, and a reference carries no
  path of keys (no `via`). A join no chain of models can name is NOT SERVED (`servable`): a model
  joined onto through several keys (a role — a buyer's and a seller's country, both of users) or a hop
  that lands on no single model. Its items are left out of every metric's list, and it is reported —
  in the overview (`joins_not_served`), as an error in the preview, and in the refusal of a query that
  names it — with how to declare it so it is served: one semantic model per key, each a dbt model of
  its own over the same one. Anything else not naming one listed item is refused with the ways it can
  be named. Do NOT re-derive joins from the manifest. Checked before anything runs, the
  project's names kept, and the catalog's require_time_range holding on a semantic model over a dbt
  model the catalog requires a window for (the dbt model dbt itself records the semantic model reads —
  manifest.json depends_on, `semanticModelSources` in the dbt client). Their queries run side by side (nothing writes to them)
  in the SAME shell as a task's (`_metricTail` / `_metricWindow` / `_metricPaging` /
  `_metricEarlyAnswer` / `_metricTask` — only how a reference resolves differs); their stored
  results are carried over a restart (a start that parses nothing keeps them for the next) and
  retired by CONTEXT_TTL_MS by age unless a live pipeline reads them. A semantic model no metric
  reads is no context (`dimension_only` in the overview). A GENERATED context holds its OWN
  layer only: its copy of the project leaves the project's semantic keys out
  (`withoutSemanticLayer`, src/context-manager.js) — the latest spec allows one semantic model per
  dbt model, and a name of one layer could shadow the other's. The overview
  (`semantic_index().project_semantic_layer.contexts`) lists each context with its dimensions and its
  metrics, each with its meta (the project's notes on reading it) and the semantic models whose
  dimensions cut it; context({ action: "describe", context_id, metric }) gives one metric's definition
  and its full group_by.
- dbt RUNS IN NAMED ENVIRONMENTS (`src/dbt/environments.js`): a virtualenv per environment under
  DBT_ENVS_DIR (`.venvs` locally, `/opt/dbt-envs` in the image), named for what is in it — `dbt-v1`
  (used unless DBT_ENV names another — TEMPORARILY: every dbt v2 on PyPI lists a BigQuery dataset one
  object at a time, dbt-labs/dbt#16423; `DEFAULT_ENV` says when to go back), `dbt-v2`, `metricflow`; `createDbt({ environment })` takes its binaries. MetricFlow is an environment of its own
  (`metricflow`, or MF_ENV) that every dbt environment queries through — `mf`'s Python, which
  python/mf_server.py runs on — since dbt-metricflow brings the Python dbt-core, which cannot share a
  venv with a dbt v2 binary. `npm run dbt:env -- create|list` manages them.
- WHAT IS IN AN ENVIRONMENT IS THIS TOOL'S DECISION (HARD RULE): `src/dbt/environment-specs.js` names
  each one's packages at EXACT versions and `create` installs exactly those; the image builds them at
  `docker build`. Every environment carries the adapters of BOTH warehouses (dbt picks one from the
  profile), so the image is one for DuckDB and BigQuery — there is no warehouse build argument.
  ONLY OURS RUN: `resolveEnvironment` refuses a name the specs do not define, one asked for as what
  its spec's `role` is not (DBT_ENV must be a `dbt` environment, MF_ENV a `metricflow` one), and a
  directory whose mcp-env.json does not record the spec's pip and packages as they are now. NOTHING IS
  TAKEN FROM PATH: no DBT_BIN / MF_BIN / PYTHON_BIN, and `createDbt` and the AST gate refuse without
  a named binary (tests name theirs from the same environments; a refused environment fails the test
  run instead of skipping it).
  Do NOT add a requirements file, a `pip install <pkg>` in the Dockerfile, or an option to hand the
  tool packages, versions or a dbt of one's own: a version change is a spec change, reviewed as code.
- The retentioneering feature has an environment of its own, `retentioneering` (dbt 1.x, both
  adapters, the library and the numerical packages that decide its results, all pinned), and a dbt
  client of its own over it, so turning the feature on changes nothing the core runs; its test file
  (test/integration/retentioneering.test.js) runs on it and skips when it is not built.
- The integration tests query through the server's own dbt client contract (`testDbt`, test/helpers/
  dbt-env.js → `createDbt` over `TEST_ENV`): the numbers they prove come from `mf query` (kept warm,
  as production runs it) and `dbt show` as the server calls them — on the test environment's dbt, so the client of another major version
  (production's `DEFAULT_ENV`) is proven only by a run with DBT_ENV naming it. Do NOT add a query
  backend only the tests use.
- THE EVALS ARE THE PRODUCTION SURFACE WITH A MODEL IN IT (evals/): golden questions — direct,
  indirect, negative — put to a model through the listed tools over MCP, on the engine production
  builds (`makeEngine`) over the fixture warehouse, EACH CASE IN A WORLD OF ITS OWN (a fresh engine and
  store copied from one indexed template), `npm run eval` with Anthropic credentials. Graded on the
  DATA — the model's stated `Answer:` line against the truth a case's own SQL reads from the warehouse
  — and on the tools (required, forbidden, a call budget), with calls, failed calls, turns and tokens
  recorded. A truth is never typed in, and never a NULL read as zero: `npm run eval:check` runs every
  case's SQL, holds it to a reference path through the tools, and requires its DECOY (the answer of
  the obvious wrong reading) to differ, with no model. A new question is a case in evals/cases.js,
  never a number in a test. The fixture world (`buildWarehouse`, `connectMcp`,
  test/integration/warehouse-harness.js) and the task-following call (`settleMcp`, test/helpers/
  settle.js) have one definition, shared by the integration tests and the evals.
- Tests run on `dbt-v2` (test/helpers/dbt-env.js `TEST_ENV`; DBT_ENV picks another), not on the
  server's `DEFAULT_ENV`, which stays `dbt-v1` only for BigQuery's sake: on the DuckDB fixtures v2
  answers each dbt call several times faster, and a server a test builds runs on the same
  environment; the python stage's file runs on `dbt-v1` (dbt 1.x) whatever it is, since v2 runs no Python
  models on DuckDB — there the stage is not offered (`gatePythonRuntime`).

### Testing (HARD RULE)
- Tests MUST assert on DATA — real query result values from running the model
  against the warehouse (DuckDB + dbt + MetricFlow).
- NEVER assert on generated text: no string/regex matching of generated SQL,
  YAML, Jinja (`Dimension(...)`/`--where`), `mf`/`dbt` command strings, or runner
  args. Correctness is proven by the NUMBERS returned, not by the query text.
- Only non-data checks allowed: input-validation guards (bad input rejected) and
  context lifecycle (files/registry).
- A test or an eval makes a temporary directory only with `tempDir(prefix)` (test/helpers/temp-dir.js):
  it goes when the process that made it ends — for a test file, when the file ends, after its
  after() hooks — so a store or an engine on a file in it is closed there. Runs that left theirs
  behind once filled a disk; test/unit/temp-dir.test.js holds test/ and evals/ to it. Around them, a run of
  scripts/run-tests.mjs or an eval has ONE temporary directory of its own (`runTempDir`, the same file) as the
  TMPDIR of every process under it, removed when the run ends — so what a process makes there goes too.
