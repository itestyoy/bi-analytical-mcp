# Project conventions

## Data model (HARD RULE)
- Sources are identified by their `meta.mcp.role` — NOT by name. The dbt model /
  SQL file can be named anything; the role is the identity, and exactly one model
  per role. Sanctioned roles:
  1. **an events FACT** — one row per event, detected by its event_name/event_data/
     time columns. There may be SEVERAL (e.g. `events` for product analytics and
     `crashlytics` for crash reports); each is a separate stream with its OWN
     `known_events` and its OWN event-scoped `*_of_event_data` properties, and its
     own `meta.mcp.primary_entity`. `meta.mcp.anchor: true` marks the PRIMARY fact
     (default pipeline source, unqualified names); the others are addressed
     `<role>.<event>` / `<role>.<property>` outside a pipeline or semantic model
     built FROM them, and bare inside one. Facts are NEVER mixed in one query
     stream — pick the fact that records what the question is about.
  2. **users** — the user-attributes dimension (one row per user).
  3. **experiments** — A/B-test assignments (one row per user×experiment:
     experiment_name, variant_group, assigned_at, ended_at); joined to events by
     the user entity for A/B analysis.
- Do NOT invent other tables/fixtures (no orders/customers/Jaffle, no "step"
  tables). Only the roles above.
- An events fact is EXTENDED, never duplicated: a new fact reuses the same event
  machinery (`Catalog.eventNames/eventProps/eventNameFor/propertyFor` take the fact
  as an argument). Do NOT add a parallel code path for a specific role.
- Funnels (incl. multi-step) are built ONLY from events: a step is an event +
  an `event_data` property value (e.g. event_name=tutorial AND step_id=step_1).
  A funnel runs over ONE fact (a row-pattern match scans one table); measures from
  different facts can still be compared side by side over `metric_time`.
- Segmentation/joins use user attributes on `dim_users` and experiment assignments
  on the experiments source, joined to events by the user entity — from ANY fact
  that carries the user entity.
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
