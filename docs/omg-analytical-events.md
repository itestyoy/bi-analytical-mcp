# Real analytical-events structure (OpenMyGame) — grounding for the seed & models

Sourced from Confluence (site `openmygame.atlassian.net`):
- **SSOT:** `PA/2602991642` — *single source of truth for all custom analytics events*.
- `BI/4797726777` — *[BI Agent] Prompt - QA Events Check* (required fields, enums, business rules).
- `WO/2076409861` — *Analytical events* (event catalogue per area).
- Realtime export table: `bi_data_export.qa_export__analytical_events_realtime`.

This document grounds the **test seed** and the **semantic models / recipes** in the
real event shape, so the analytics agent learns to build models the way the data
actually looks.

---

## 1. Global event structure (four blocks)

Every event is one row in a wide table. Parameters are namespaced by block:

| Block | Column prefix | Holds |
|---|---|---|
| `main_data` | `main_data__*` | user/device ids, app info, **platform**, timestamps, **install attributes & traffic source** (media_source, campaign, install_time), geo |
| `device_info` | `device_info__*` | device_model, os_version, gpu/cpu, ram, resolution, network class, vpn |
| `state` | `state_*` | in-game state at event time: current level, coin/hint balances, language, progress |
| `event_data` | `event_data_*` | **event-specific** parameters (revenue, product, ad_type, result, attempt, moves, delta, placement, …) |

### Required on EVERY event
`event_name`, `main_data__appsflyer_id`, `main_data__appmetrica_id`, `bundle_id`,
`main_data__app_id`, `main_data__platform`.

> `main_data__appsflyer_id` is the **user identifier** (join key). Install
> attributes (media_source, campaign, install date, platform, country) ride on
> `main_data` of every event → a **`dim_users`** can be derived as the first-touch
> (install) row per `appsflyer_id`, and the events fact joins to it on `user`.

---

## 2. Event catalogue (the events that matter for analytics)

Grouped by the analytics task family they feed. Names are the production event
names (current, non-deprecated).

| Family | Events |
|---|---|
| Lifecycle / sessions | `first_launch`, `new_session`, `end_session` |
| Onboarding | `tutorial` (+ tutorial mechanic opens) |
| Progression / levels | `level_start`, `level_end`, `complete_level` (`event_data__total_time_sec`), `fragment_started`/`fragment_finished`, `puzzle_started`/`puzzle_part_completed`/`puzzle_completed`, `pack_complete_N` |
| Economy | `currency_income`, `currency_outcome` (delta, placement, balance) |
| Monetization (IAP) | `shop_open`/`shop_opened`, `store_start_buy_product`, `store_finish_buy_product` (pack_id, status: success/failed/closed), `in_app_purchase`, `iap_purchase_completed`/`iap_purchase_failed` |
| Ads | `ad_requested`/`ad_loaded`/`ad_available`, `ad_started`/`ad_finished`, `ad_impression`, `ad_click`, `ad_inters_shown`/`ad_inters_click`, `rewarded_video_finished[_Placement]`, `apd_ad_impression` (ad revenue) |
| Retention markers | `Retention_1..Retention_180`, `sessions_count_5/10/15/20` |
| Screens / UI | `game_screen`, `main_menu_screen`, `final_screen`, `screen_changed` |

### Representative `event_data` parameters (per event)

| Event | Key `event_data` fields | Types / values |
|---|---|---|
| `complete_level` / `level_end` | `level`, `result` (`win`/`lose`), `attempt`, `moves`, `total_time_sec`, `score` | int / enum / int |
| `level_start` | `level`, `attempt` | int |
| `in_app_purchase` / `store_finish_buy_product` | `revenue`, `currency`, `product_id`/`pack_id`, `status` (`success`/`failed`/`closed`) | numeric / string |
| `ad_finished` / `rewarded_video_finished` | `ad_type` (`rewarded`/`interstitial`/`banner`), `placement`, `ad_network`, `monetization_type` | string |
| `apd_ad_impression` | `revenue` (ad revenue), `ad_network`, `ad_type` | numeric / string |
| `currency_income` / `currency_outcome` | `delta`, `placement`, `balance`, `currency_type` (`coins`/`hints`) | int / string |
| `tutorial` | `step_id`, `status` (`start`/`complete`) | string |

### Enum hygiene (from QA rules)
- `event_name` must match the allowed list exactly; values are case-sensitive
  (`android` not `Android`, `purchase` ≠ `Purchase`); no whitespace inside enums.
- Business rules: temporal ordering (`new_session` ≤ event_time), conditional
  presence (field X required when Y = Z), duplicates = same `event_name` +
  `appsflyer_id` + timestamp (±1s), orphaned sessions (`new_session` without
  `end_session`).

---

## 3. How this maps to our two-model semantic layer

The MCP server models **one events fact + one user dimension joined by `user`**.
Mapping the real OMG table onto that:

| Logical (catalog) | Real column |
|---|---|
| events `user` entity | `main_data__appsflyer_id` |
| events `event_name` | `event_name` |
| events time | `event_timestamp` (or `main_data__device_time_ms`) |
| events numeric/categorical props | `event_data_*` (revenue, level, result, attempt, moves, total_time_sec, ad_type, ad_network, placement, delta, …) |
| users `user` primary | `main_data__appsflyer_id` (first-touch row) |
| user attributes | `main_data__platform`, `main_data__media_source`, `main_data__campaign`, install date, geo; `device_info__device_model`, `device_info__os_version` |
| campaigns (optional) | `main_data__campaign` → campaign dim |

So the existing architecture holds; only the **names** become production-realistic:
events expose `event_data_*` as JSON/columns, `dim_users` is the install-time
projection of `main_data` per `appsflyer_id`. The seed and recipes are aligned to
these names so the agent learns the real mapping.

---

## 4. Task classes to formalize as tested models

(Backed by the seed + recipes + integration tests.) Each must be expressible as a
dbt semantic model and verified by a query:

1. Acquisition / UA — installs & quality by `media_source`/`campaign`/channel.
2. Activation / onboarding — `tutorial` funnel (step drop-off), first-session depth.
3. Engagement — DAU/WAU/MAU (`new_session`), session count, stickiness DAU/MAU.
4. Retention — D1/D7/D30 by cohort & channel (conversion-window approximation).
5. Cohort grids — install cohort × age × revenue/retention.
6. Behavioral cohorts — did/didn't `in_app_purchase` / `complete_level` / `ad_click`.
7. Conversion — visit → first purchase; level_start → complete; tutorial → level.
8. Progression / difficulty — per-level win-rate, attempts, churn-at-level, time.
9. Monetization — ARPU/ARPPU/payer-share/AOV/LTV by product/network/channel; ad revenue (`apd_ad_impression`).
10. Economy — coin sources/sinks (`currency_income`/`currency_outcome`) by placement.

> These map 1:1 to recipes (`config/recipes.json`) and are exercised by the
> integration suites (`behavior-funnels.test.js`, `analytics-tasks.test.js`,
> per-task families). The point: a fixed, **tested** way to build each model and
> compute each metric, so the agent can assemble them reliably.
