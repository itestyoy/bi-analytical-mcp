# Project conventions

## Data model (HARD RULE)
- There are EXACTLY TWO data sources, period:
  1. the analytical **events** fact (`fct_analytics_events`)
  2. the **user attributes** dimension (`dim_users`)
- NOTHING else. No campaigns table, no orders/customers/Jaffle fixtures, no
  "step" tables, no extra dimensions. Do not invent tables or fixtures.
- Funnels (incl. multi-step) are built ONLY from events: a step is an event +
  an `event_data` property value (e.g. event_name=tutorial AND step_id=step_1).
- Segmentation/joins use ONLY user attributes on `dim_users` (country, platform,
  media_source, acquisition_type, campaign_id, …) joined to events by user.

## Testing (HARD RULE)
- Tests MUST assert on DATA — real query result values from running the model
  against the warehouse (PGlite + dbt + MetricFlow).
- NEVER assert on generated text: no string/regex matching of generated SQL,
  YAML, Jinja (`Dimension(...)`/`--where`), `mf`/`dbt` command strings, or runner
  args. Correctness is proven by the NUMBERS returned, not by the query text.
- Only non-data checks allowed: input-validation guards (bad input rejected) and
  context lifecycle (files/registry).
