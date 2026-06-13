# Playbooks — analysis pattern → MCP tool sequence

Each pattern: when to use it, the tool sequence, and the gotcha to check. Always
**clarify** (window/project/segment) and **discover** (`semantic_index`) first, and check
its recipe list (overview) + `semantic_index({ recipe: id })` — a recipe often carries the
ready payload + the reusable technique (`hack`). Report the tier (governed metric › pipeline) + freshness + Confluence link.

---
## 1. Trends (DAU/WAU/MAU, sessions, event volume)
Governed metric path. Define once, query by time grain.
1. `create_semantic_model` — measure = `count_distinct(player)` over the relevant event;
   or use the governed *Cumulative Sessions* / *Session Duration* definitions.
2. `query_semantic_model` — `group_by: [{ time: "metric_time", grain: "day" }]`; for a
   series `order_by: [{ key: "metric_time" }]` (alias resolves to the grained token).
- **Gotcha:** "last week/month" = last **complete** period; DAU ≤ MAU; distinct players,
  not rows. Sessions follow AppsFlyer logic ([Cumulative Sessions](https://openmygame.atlassian.net/wiki/spaces/BI/pages/4503207971)).

## 2. Progression funnel / conversion (events-only)
Use a pipeline with a `match_recognize` stage.
1. `build_native_model { action: "start", name, source: "events" }`.
2. `add_step` a `match_recognize` stage: `partition_by: ["<player key>"]`, ordered `steps`
   (each = event + an `event_data` value), e.g. `level_started → level_completed (result=win)`
   or a tutorial chain. Add `between_steps` if repeats may occur.
3. (optional) `add_step` a downstream `join` (users) / `aggregate` to slice conversion by a
   player attribute (country/platform).
4. `materialize`, then `get_query_result` — read `reached_*` / `completed` / `furthest_step_name`.
- **Governed sibling:** *Game Completion Rate* = completed ÷ started ×100%
  ([def](https://openmygame.atlassian.net/wiki/spaces/BI/pages/4502290434)) — prefer it for the
  headline rate; use the funnel for step-by-step drop-off.
- **Gotcha:** scope each step to its event; `one_per_partition` (players) vs `one_per_match`
  (attempts); guarded denominator for the rate.

## 3. Retention / cohorts
1. Cohort = players by install date (users dimension). 
2. Returner = a qualifying event on day D after install. Build per-(cohort, day) counts with
   a pipeline (join users for install_date, aggregate), or the governed retention recipe.
3. Retention(D) = returners(D) ÷ cohort size.
- **Gotcha:** anchor "day N" on install, not calendar; **reinstalls** distort cohorts/revenue
  — flag it (BI note on reinstalls); incomplete latest cohort ⇒ exclude or mark partial.

## 4. Monetization — IAP
1. Revenue/buyers from `iap_purchase_completed`; segment by *Inapp Placement* (`location`
   in `event_data`) / *Product Category*.
2. Metric via `create_semantic_model` (sum revenue, `count_distinct` payers) →
   `query_semantic_model`; or a pipeline for bespoke cuts.
- **Gotcha:** reconcile to AppsFlyer by `order_id`/`transaction_id` — in-event amount ≠
  reconciled revenue; state which. Subscriptions have a sequence number
  ([dim](https://openmygame.atlassian.net/wiki/spaces/BI/pages/4748345359)).

## 5. Monetization — Ads
1. Impressions/revenue from `ad_finished`; segment by *Ad Network* (`network` in
   `additional_info`, linked to MAX by `tracking_id`).
2. Prefer governed *Non-ATT Ad Impressions/Revenue* when comparing iOS without IDFA.
- **Gotcha:** ATT split (IDFA availability) changes coverage; ad `network` is nested in
  `additional_info`, not top-level.

## 6. In-game economy (resources / coins)
1. Flows from `currency_income` / `currency_outcome`; dimensions *Source Type*, *Source
   Name*, *Resource Currency*.
2. Use governed *Resource Income/Outcome* (+ "in Coins", Cumulative, per Player) and
   *Resources Balance* / *Resource Return Ratio*; reproduce with `create_semantic_model`
   (sum amounts, group by source) or a pipeline.
- **Gotcha:** income vs outcome are different events; "in Coins" applies a conversion; "per
  Player" divides by distinct players. ([Income](https://openmygame.atlassian.net/wiki/spaces/BI/pages/4207280165) · [Outcome](https://openmygame.atlassian.net/wiki/spaces/BI/pages/4207018040))

## 7. A/B-test analysis
Process + naming conventions: **Product Analytics** space
(`https://openmygame.atlassian.net/wiki/spaces/PA` — [A/B тестирование](https://openmygame.atlassian.net/wiki/spaces/PA/pages/4661444646),
[Пайплайн A/B (DEV)](https://openmygame.atlassian.net/wiki/spaces/PA/pages/4881940484)).
1. **Compute per-variant aggregates first** with a pipeline: join `experiments` (variant_group),
   window events to the assignment period, aggregate per `variant_group` (n + the metric's
   stat fields).
2. **Guardrail:** `experiment({ action: check_split, groups })` — if `srm_detected` (p < 0.001), the split is
   broken → STOP, the test is invalid.
3. **Significance:** `experiment({ action: analyze })`:
   - conversion → `metric: "proportion"` (n + conversions);
   - revenue/ARPU → `metric: "mean"` (n + mean + stddev);
   - per-attempt ratios (e.g. wins/attempts randomized by player) → `metric: "ratio"` (the 5 sums);
   - variance reduction with a pre-period covariate → `metric: "cuped"` (the 5 sums).
   Read `lift` (with relative-lift CI), `p_value`, CI, `significant`, and the
   multiplicity-adjusted p-value across variants.
4. **Planning / power:** `experiment({ action: plan })` (give `mde` → n per group, or `n` → MDE; needs
   `baseline` for proportion / `stddev` for mean).
- **Gotcha:** always SRM before lift; pick the analysis unit (per-player vs per-attempt) —
  use `ratio` when the analysis unit is finer than the randomization unit; exclude the
  campaigns/cohorts the test design excludes; one test card per the naming convention.

---
## Provenance footer (end every answer with)
- **Tier:** governed metric (name + Confluence link) ▸ or custom pipeline.
- **Scope:** grain, filters, segment, time window (complete period), project/platform.
- **Freshness:** latest event time used (and `semantic_index` sync state if values were used).
- **Caveats:** any gotcha that applies (reconciliation, ATT split, reinstalls, partial cohort).
- Separate **observation** from **interpretation**.
