# Project conventions

## Data model (HARD RULE)
- Sources are identified by their `meta.mcp.role` — NOT by name. The dbt model /
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
     — never glued into a name. Within a source, names are used as-is. A source may
     be omitted only when the catalog has exactly one.
  2. **users** — the user-attributes dimension (one row per user).
  3. **experiments** — A/B-test assignments (one row per user×experiment:
     experiment_name, variant_group, assigned_at, ended_at); joined to events by
     the user entity for A/B analysis.
- Do NOT invent other tables/fixtures (no orders/customers/Jaffle, no "step"
  tables). Only the roles above.
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
- A/B significance is computed in JS via the `ab_test` tool over per-group
  aggregates (proportion → z-test; mean → Welch t-test).

## Testing (HARD RULE)
- Tests MUST assert on DATA — real query result values from running the model
  against the warehouse (PGlite + dbt + MetricFlow).
- NEVER assert on generated text: no string/regex matching of generated SQL,
  YAML, Jinja (`Dimension(...)`/`--where`), `mf`/`dbt` command strings, or runner
  args. Correctness is proven by the NUMBERS returned, not by the query text.
- Only non-data checks allowed: input-validation guards (bad input rejected) and
  context lifecycle (files/registry).
