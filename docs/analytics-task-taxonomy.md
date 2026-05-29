# Analytics Task Taxonomy — dbt Semantic Layer (MetricFlow)

> Authoritative taxonomy of common product/game-analytics task types, mapped onto a
> dbt Semantic Layer (MetricFlow) built over two base dbt models plus one optional
> dimension:
>
> - **`fct_analytics_events`** — events fact (semantic model `events`, synthetic
>   `primary_entity: event`; `user` and `session` as `foreign`; time = `event_timestamp` @ day).
> - **`dim_users`** — user-attributes dimension (semantic model `users`, `user` as
>   `primary`; `campaign` as `foreign`).
> - **`dim_campaigns`** — optional campaign dimension (semantic model `campaigns`,
>   `campaign` as `primary`).
>
> Everything below is constrained to the columns/properties in
> [`config/catalog.json`](../config/catalog.json) and the constructs in
> [`dbt-semantic-layer-spec.md`](./dbt-semantic-layer-spec.md). No invented columns.

## Conventions (implementation-aligned)

- **Namespacing:** single-underscore between semantic-model qualifier and field;
  **double-underscore** in group-by / filter paths (`user__country`,
  `event__event_name`, `metric_time__day`). Multi-hop up to 2 joins:
  `user__campaign__channel`.
- **JSON unpacking happens in `measure.expr`** (Postgres dialect), e.g.
  `(event_properties->>'level')::int`, `(event_properties->>'revenue')::numeric`.
  Event-name filtering happens via `event__event_name` in a measure/metric `filter`.
- **Joins are implicit:** events → users via shared entity `user`
  (`foreign`→`primary`, valid left join); users → campaigns via `campaign`.
- **Time spine is a hard precondition** for `metric_time`, any grain, `cumulative`,
  and `conversion`. Assumed materialized in the base project.
- **Ratios reference metrics, not measures** — wrap a measure in a `simple` metric
  first, then build `ratio`/`derived`.

---

## Summary table — task → metric type(s) + key aggregations

| # | id | Title | Metric type(s) | Key aggregations |
|---|---|---|---|---|
| 1 | `active_users_trend` | DAU/WAU/MAU & events over time | simple, derived (ARPDAU) | `count_distinct(user_id)`, `count`, `sum(revenue)` |
| 2 | `metric_by_user_segment` | Segmentation by user property | simple, ratio | `count_distinct`, `count`, `sum` |
| 3 | `step_conversion_funnel` | Step / funnel conversion | conversion (2-step), derived (multi-step) | `count_distinct`, `count` |
| 4 | `nday_retention` | N-day / unbounded / rolling retention | conversion (N-day), cumulative (rolling) | `count_distinct(user_id)` |
| 5 | `cohort_retention_grid` | Acquisition cohort × age grid | ratio/conversion + derived | `count_distinct(user_id)`, `sum(revenue)` |
| 6 | `behavioral_cohort` | Did/didn't do event X | simple + metric-in-filter, ratio | `count_distinct`, `sum_boolean` |
| 7 | `visit_to_purchase_conversion` | Visit→purchase conversion | conversion | `count_distinct`/`count` base & conversion |
| 8 | `level_progression` | Win rate / attempts / churn per level | ratio, simple, derived | `count`, `count_distinct`, `average`, `sum_boolean` |
| 9 | `monetization_metrics` | ARPU/ARPPU/payer share/LTV/revenue mix | simple, ratio, derived, cumulative | `sum(revenue)`, `count_distinct`, `average` |
| 10 | `stickiness_lifecycle` | DAU/MAU stickiness & lifecycle states | derived (ratio of metrics), simple, conversion | `count_distinct(user_id)` |

> Honest limits up front: MetricFlow has **no native multi-step funnel or path
> analysis** and **no exact "active again on day N" retention** primitive. The
> supported approximations are: **`conversion` metric** for 2-event/2-step rates and
> N-day "returned within window" retention; **chained `conversion` + `derived`** for
> multi-step funnels; **`cumulative` + time spine** for rolling/unbounded windows;
> **`ratio`/`derived`** for all rate metrics; **`Metric(...)` in `--where`** for
> behavioral cohorts. Each section notes where the fit is approximate.

---

## 1. `active_users_trend` — Trends / time-series active users & ARPDAU

- **Business question:** How do DAU/WAU/MAU, total events, and ARPDAU move over time?
- **Required events:** `session_start` (or any event) for activity; `purchase` for ARPDAU revenue.
- **Required event_properties:** `revenue` (numeric) for ARPDAU.
- **Required user attributes:** none mandatory (optional split by `platform`, `country`).
- **Semantic Layer constructs:**
  - Measures: `dau = count_distinct(user_id)`, `events_count = count (expr: 1)`,
    `revenue_usd = sum((event_properties->>'revenue')::numeric)` filtered to `purchase`.
  - Dimensions: time `metric_time` at grains `__day` / `__week` / `__month`.
  - Metric types: `simple` (each active-user count and events); `derived` for ARPDAU
    = `revenue / nullif(dau, 0)`.
- **MetricFlow mapping:** DAU/WAU/MAU are the *same* `count_distinct(user_id)` measure
  queried at `metric_time__day/week/month` (the grain defines the window, no separate
  metrics needed). ARPDAU is a `derived` metric over `revenue_usd` and `dau`. WAU/MAU
  this way are calendar-window distinct counts, not trailing-7/28-day rolling — for a
  true rolling 7d/28d active count use a `cumulative` metric with `window: "7 days"`
  over a per-user activity measure.
- **Data needs:** multiple days spanning at least several weeks/2+ months; events from
  many distinct users per day; some `purchase` rows with `revenue` to make ARPDAU non-trivial.

---

## 2. `metric_by_user_segment` — Segmentation by user property

- **Business question:** How does a metric (users, events, revenue) break down by
  `country` / `platform` / `media_source` / `acquisition_type` (and campaign `channel`)?
- **Required events:** any (e.g. `session_start`, `purchase`).
- **Required event_properties:** `revenue` (numeric) if segmenting revenue.
- **Required user attributes:** `country`, `platform`, `media_source`,
  `acquisition_type` (enum organic/paid); optional `user__campaign__channel` (multi-hop).
- **Semantic Layer constructs:**
  - Measures: `unique_users = count_distinct(user_id)`, `events_count = count`,
    `revenue_usd = sum(revenue)`.
  - Dimensions: categorical from `users` accessed as `user__country`, `user__platform`,
    `user__media_source`, `user__acquisition_type`; `campaigns` as `user__campaign__channel`.
  - Metric types: `simple`; `ratio` for share-of-total style breakdowns.
- **MetricFlow mapping:** A metric defined on `events` is grouped by a dimension that
  physically lives in `dim_users` — MetricFlow auto-joins `events.user (foreign)` →
  `dim_users.user (primary)` and exposes it as `user__country` etc. Campaign attributes
  require the 2-hop path `user__campaign__channel` (events→users→campaigns).
- **Data needs:** users spread across multiple countries, both platforms, organic+paid,
  several `media_source` values, and 2+ campaigns mapped to distinct `channel`s.

---

## 3. `step_conversion_funnel` — Step / funnel conversion

- **Business question:** What fraction of users progress from one step to the next
  (e.g. `level_start` → `level_complete`; tutorial `tutorial_step` progression; path to
  first `purchase`)?
- **Required events:** `level_start`, `level_complete` (level funnel); `tutorial_step`
  (tutorial funnel); `session_start` → `purchase` (path-to-purchase).
- **Required event_properties:** `level` (int) to pin a step to a level;
  `step_id` (string) for tutorial step ordering.
- **Required user attributes:** none (optional segmentation as in §2).
- **Semantic Layer constructs:**
  - Measures: `step_users = count_distinct(user_id)` per step (filtered by
    `event__event_name` and, for levels, `level` via `constant_properties`).
  - Dimensions: optional `metric_time` and user segments.
  - Metric types: **`conversion`** for any single 2-step pair; **`derived`** to chain
    multiple 2-step conversions into a multi-step funnel.
- **MetricFlow mapping (honest):** MetricFlow has **no native N-step funnel**. A single
  step pair maps cleanly to a `conversion` metric (`base_measure` = step-A users,
  `conversion_measure` = step-B users, `entity: user`, a `window`, optional
  `constant_properties` to hold `level`/`product_id` fixed). A 3+ step funnel is
  approximated by defining each adjacent pair as its own `conversion` metric and
  composing overall completion with a `derived` metric (product of stage rates) —
  ordering/strict sequencing is not enforced beyond the conversion window, so it is an
  approximation, not exact path analysis.
- **Data needs:** users who start but do not complete (so rate < 100%), users who
  complete within the window, multiple `level` values, and a tutorial sequence with
  several `step_id`s and drop-off.

---

## 4. `nday_retention` — N-day / unbounded / rolling retention

- **Business question:** What % of an install cohort is active on day N (D1/D7/D30),
  or within a rolling window?
- **Required events:** `session_start` (the "active" signal) — also acceptable: any event.
- **Required event_properties:** none.
- **Required user attributes:** `install_date` (time @ day) as the cohort anchor.
- **Semantic Layer constructs:**
  - Measures: `installs = count_distinct(user_id)` (cohort base, anchored on
    `user__install_date`), `returned_users = count_distinct(user_id)` from later activity.
  - Dimensions: time `user__install_date__day` (cohort), `metric_time__day` (activity).
  - Metric types: **`conversion`** with `window: "1 day"`/`"7 days"`/`"30 days"` for
    N-day "returned within"; **`cumulative`** with a window for rolling / unbounded
    retained-active counts; **`ratio`** to express retained ÷ cohort.
- **MetricFlow mapping (honest):** Exact "active *exactly* on day N" is **not a native
  primitive**. The supported approximation is a `conversion` metric (install event →
  any activity event, `entity: user`, `window: "N days"`), which yields "returned within
  N days" (cumulative-style retention), not the classic point-in-time D-N curve. True
  rolling/unbounded retention uses a `cumulative` measure + the time spine. Building the
  full D0/D1/.../DN curve requires one conversion metric per N (or post-query pivoting),
  not a single MetricFlow object.
- **Data needs:** multiple `install_date` cohorts (several days/weeks), users with
  activity on later days (and some who never return), enough span to populate D1/D7/D30.

---

## 5. `cohort_retention_grid` — Acquisition cohort × age grid (revenue/retention)

- **Business question:** For each install cohort (by `install_date`, sliced by
  `acquisition_type`/`media_source`/campaign `channel`), what is retention and revenue
  at each age (days/weeks since install)?
- **Required events:** `session_start` (retention signal), `purchase` (cohort revenue).
- **Required event_properties:** `revenue` (numeric).
- **Required user attributes:** `install_date` (time @ day), `acquisition_type`,
  `media_source`, and `user__campaign__channel`.
- **Semantic Layer constructs:**
  - Measures: `cohort_users = count_distinct(user_id)`, `active_users = count_distinct(user_id)`,
    `revenue_usd = sum(revenue)`.
  - Dimensions: cohort axis `user__install_date__week`/`__day`; age comes from
    `metric_time` grain relative to install; segment axis `user__acquisition_type`.
  - Metric types: `ratio`/`conversion` for retained share, `simple`/`cumulative` for
    cumulative revenue per cohort, `derived` for cohort ARPU.
- **MetricFlow mapping (honest):** The grid is produced by grouping a metric on **both**
  the cohort dimension (`user__install_date__week`) **and** an activity time grain
  (`metric_time__week`); the "age" axis is the offset between the two and is computed in
  presentation/post-processing, since MetricFlow does not emit a native
  `days_since_install` dimension (no such column in the schema). Cumulative cohort
  revenue uses a `cumulative` metric (grain_to_date or unbounded). This is the standard
  cohort matrix assembled from a 2-time-dimension query, not a single bespoke object.
- **Data needs:** several install cohorts × multiple activity periods; payers within
  cohorts; organic vs paid and multiple campaigns so cohort segments differ.

---

## 6. `behavioral_cohort` — Segmentation by event history (did / didn't do X)

- **Business question:** How do users who performed event X (e.g. made a `purchase`,
  reached level ≥ K, clicked an ad) differ from those who didn't, on some metric?
- **Required events:** the behavior event (`purchase`, `level_complete`, `ad_click`,
  `item_acquired`) plus the metric event.
- **Required event_properties:** `level` (int) for "reached level ≥ K"; `revenue` for
  spend-based cohorts.
- **Required user attributes:** none required (combine with §2 segments freely).
- **Semantic Layer constructs:**
  - Measures: behavior flag `did_event = sum_boolean(case when event_name='purchase' then true else false end)` or a
    per-user `purchases = count_distinct(user_id) filter purchase`; the outcome measure
    (e.g. `revenue_usd`, `events_count`).
  - Dimensions: optional time/segments; the cohort split is expressed as a **filter**.
  - Metric types: `simple` outcome metrics; `ratio` to compare cohort sizes;
    **`Metric(...)` wrapper in `--where`** to slice by event history.
- **MetricFlow mapping (honest):** "Did event X" is encoded either as a boolean
  categorical/measure (`sum_boolean`) or, more powerfully, by filtering with
  `{{ Metric('purchases', group_by=['user']) }} > 0` in `--where` — note the documented
  constraint that `Metric(...)` filters allow **exactly one entity** in `group_by`
  (`['user']` is valid) and must aggregate without fan-out. There is no native "user
  segment" object, so the cohort is materialized as a filter/flag, not a stored cohort.
- **Data needs:** a mix of users who did vs didn't perform the behavior, varied
  `level`/`revenue` values so the two cohorts diverge measurably.

---

## 7. `visit_to_purchase_conversion` — Conversion metric (visit → purchase)

- **Business question:** What share of visiting/active users convert to a purchase
  within a window, optionally on the same `product_id`?
- **Required events:** `session_start` (the visit/base) and `purchase` (the conversion).
- **Required event_properties:** `product_id` (string) for `constant_properties`;
  `revenue` (numeric) if also reporting converted value.
- **Required user attributes:** none (optional segmentation by `user__country`, etc.).
- **Semantic Layer constructs:**
  - Measures: `visits = count_distinct(user_id)` filtered to `session_start`;
    `purchases = count_distinct(user_id)` filtered to `purchase`.
  - Dimensions: `metric_time` grain; optional user segments.
  - Metric types: **`conversion`** (`calculation: conversion_rate` default, or
    `conversion` for raw count).
- **MetricFlow mapping:** This is the canonical native fit — a `conversion` metric with
  `base_measure: visits`, `conversion_measure: purchases`, `entity: user`,
  `window: "7 days"`, and optional `constant_properties: [{base_property: product_id,
  conversion_property: product_id}]` to require same-product conversion. Requires the
  materialized time spine.
- **Data needs:** visitors who never purchase, visitors who purchase inside the window
  and outside it (to exercise window cutoff), multiple `product_id`s for constant-property tests.

---

## 8. `level_progression` — Level / progression analysis

- **Business question:** Per level — what is the win rate, average attempts/moves/score,
  completion vs fail, and where do players churn?
- **Required events:** `level_start`, `level_complete`, `level_fail`.
- **Required event_properties:** `level` (int), `result` (string win/lose),
  `attempt` (int), `moves` (int), `score` (int).
- **Required user attributes:** none (optional segmentation).
- **Semantic Layer constructs:**
  - Measures: `starts = count filter level_start`, `completes = count filter level_complete`,
    `fails = count filter level_fail`, `wins = sum_boolean((event_properties->>'result')='win')`,
    `avg_attempts = average((event_properties->>'attempt')::int)`,
    `avg_moves = average((event_properties->>'moves')::int)`,
    `p50_score = median((event_properties->>'score')::int)` or `percentile`.
  - Dimensions: categorical `level` exposed via
    `expr: (event_properties->>'level')::int`; `result`; optional `metric_time`.
  - Metric types: `simple` (counts/averages), `ratio` (`win_rate = wins / starts`,
    `churn = 1 - completes/starts` as a `derived`).
- **MetricFlow mapping:** `level` and `result` are declared as categorical dimensions
  with JSON-unpack `expr` on the `events` model, so every measure can be grouped by
  `event__level`. Win rate and churn are `ratio`/`derived` metrics over the count
  measures; attempts/moves/score use `average`/`median`/`percentile` aggs. Funnel-style
  level-to-level drop-off reuses §3's `conversion` approach with `level` held via
  `constant_properties`.
- **Data needs:** several distinct `level` values, both win and lose `result`s, multiple
  `attempt` numbers, varying `moves`/`score`, and visible drop-off across levels.

---

## 9. `monetization_metrics` — ARPU / ARPPU / payer conversion / LTV / revenue mix

- **Business question:** What are ARPU, ARPPU, payer share, conversion-to-payer, the
  cumulative LTV curve, and revenue split by `product_id` / `ad_network` / campaign `channel`?
- **Required events:** `purchase` (IAP revenue), `ad_impression`/`ad_click` (ad revenue context).
- **Required event_properties:** `revenue` (numeric), `currency` (string),
  `product_id` (string), `ad_network` (string).
- **Required user attributes:** `acquisition_type`, `media_source`, `country`,
  `user__campaign__channel` for revenue-by-channel.
- **Semantic Layer constructs:**
  - Measures: `revenue_usd = sum(revenue) filter purchase`,
    `payers = count_distinct(user_id) filter purchase`,
    `all_users = count_distinct(user_id)`, `purchases_count = count filter purchase`.
  - Dimensions: `event__product_id`, `event__ad_network`, `metric_time` grains,
    user/campaign segments.
  - Metric types: `simple` (revenue, payers); `ratio` (`arpu = revenue/all_users`,
    `arppu = revenue/payers`, `payer_share = payers/all_users`); `derived` (avg
    transaction value = revenue/purchases_count); **`cumulative`** for the LTV curve
    (cumulative revenue per cohort over time, unbounded or `grain_to_date`).
- **MetricFlow mapping:** ARPU/ARPPU/payer-share are `ratio` metrics over `simple`
  wrappers (numerator/denominator are metrics, per spec §6.2). Conversion-to-payer can
  also be modeled as a `conversion` metric (install/visit → purchase) per §7. The LTV
  curve is a `cumulative` revenue metric grouped by cohort × `metric_time` (time spine
  required). Revenue mix is plain `simple` revenue grouped by `event__product_id` /
  `event__ad_network` / `user__campaign__channel`.
- **Data needs:** payers and non-payers; multiple `product_id`s and `ad_network`s; a
  range of `revenue` amounts; multiple cohorts/periods so the LTV curve accumulates;
  paid+organic and multi-campaign coverage for revenue-by-channel.

---

## 10. `stickiness_lifecycle` — Stickiness (DAU/MAU) & lifecycle states

- **Business question:** What is the DAU/MAU stickiness ratio, and how do users split
  across lifecycle states (new / active / resurrected / dormant)?
- **Required events:** `session_start` (activity signal).
- **Required event_properties:** none.
- **Required user attributes:** `install_date` (to identify "new" users).
- **Semantic Layer constructs:**
  - Measures: `dau = count_distinct(user_id)`, `mau = count_distinct(user_id)`
    (same measure, different query grain), `new_users = count_distinct(user_id)`
    filtered where `user__install_date` falls in the period.
  - Dimensions: `metric_time__day` and `metric_time__month`; `user__install_date`.
  - Metric types: **`derived`** stickiness = `dau / nullif(mau, 0)` (inputs are the same
    distinct-user metric at different grains); `simple` for new users; **`conversion`**
    (prior-period activity → current-period activity) to approximate
    resurrected/retained states.
- **MetricFlow mapping (honest):** Stickiness is a `derived` metric dividing the
  daily-grain active count by the monthly-grain active count of the *same* measure.
  Lifecycle states (new/active/resurrected/dormant) have **no native primitive**:
  "new" = active AND `install_date` in period (a filter), and resurrected/dormant are
  approximated with `conversion` metrics comparing activity across adjacent windows
  (e.g. inactive last month → active this month). Exact state machines need
  post-processing; MetricFlow supplies the component counts and conversion rates.
- **Data needs:** users active across consecutive days and months; some new installs in
  each period; users who go dormant and some who resurrect (gaps then return) so
  conversion-based lifecycle splits are non-empty.

---

## Cross-cutting notes

- **Where MetricFlow is awkward (recap):** multi-step funnels (no native N-step → chain
  `conversion` + `derived`); exact point-in-time N-day retention (use `conversion`
  "returned within N" or `cumulative`); path/sequence analysis (unsupported — only
  windowed 2-event conversion); lifecycle state machines and cohort "age" axis
  (assembled in post-processing from multi-time-dimension queries).
- **What is a clean native fit:** simple counts/sums over time; segmentation via entity
  joins; 2-event conversion with windows and constant properties; ratio/derived rate
  metrics; cumulative/rolling windows with the time spine.
