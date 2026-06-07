# OMG data model — events, properties, dimensions, metrics

Canonical definitions live in Confluence, **BI & Integration** space
(`https://openmygame.atlassian.net/wiki/spaces/BI`). Each metric/dimension is a
`[Metric] …` / `[Dimension] …` page with **Description + Calculation (event + param path)**.
Always confirm the exact entity with `describe_catalog` (it reflects the live warehouse),
and cite the Confluence page as the definition of record.

> The actual column/property names in this deployment are catalog-enumerated — use
> `describe_catalog({ event })` / `({ property })` / `({ search })` to get the exact names
> and real values. The names below describe the *business* concept + where it lives.

## Events (the events fact) — see `reference/events.md`
Events are the foundation; the full event catalogue, envelope structure
(`main_data`/`device_info`/`state`/`event_data`/`additional_info`), per-project
applicability and the event-level gotchas live in **`reference/events.md`**. In short, the
events most analyses touch: lifecycle (`first_launch`/`new_session`/`end_session`; install
attrs live in `main_data`), progression (`level_started`/`level_completed`, `puzzle_*`),
economy (`currency_income`/`currency_outcome`), ads (`ad_started`/`ad_finished`, …),
IAP (`iap_purchase_completed`). The dimensions and metrics below are built on top of these
events.

## Dimensions (segment / group-by) — Confluence `[Dimension] …`
Player attributes resolve via the **users** dimension; event-scoped ones via `event_data`.

| Dimension | Where it comes from | Confluence |
| --- | --- | --- |
| Ad Network | `network` in `additional_info` of `ad_finished` (linked to MAX by `tracking_id`) | [page](https://openmygame.atlassian.net/wiki/spaces/BI/pages/4826890654) |
| Inapp Placement | `location` in `event_data` of `iap_purchase_completed` | [page](https://openmygame.atlassian.net/wiki/spaces/BI/pages/4748869633) |
| Inapp Product Category | grouping of product ids | [page](https://openmygame.atlassian.net/wiki/spaces/BI/pages/4748836871) |
| Source Type / Source Name / Resource Currency | params on `currency_income` / `currency_outcome` | [type](https://openmygame.atlassian.net/wiki/spaces/BI/pages/4207181856) · [name](https://openmygame.atlassian.net/wiki/spaces/BI/pages/4207116344) · [currency](https://openmygame.atlassian.net/wiki/spaces/BI/pages/4206919739) |
| Session Number | derived from in-game events | [page](https://openmygame.atlassian.net/wiki/spaces/BI/pages/4508418049) |
| ATT Status | `att` from AppsFlyer (authorized / denied / not_determined) | [page](https://openmygame.atlassian.net/wiki/spaces/BI/pages/4469194769) |
| GDPR Applies | `gdpr_applies` from AppsFlyer | [page](https://openmygame.atlassian.net/wiki/spaces/BI/pages/4469456913) |
| Install Time Zone | `time_zone` in `main_data` | [page](https://openmygame.atlassian.net/wiki/spaces/BI/pages/4469424144) |
| Device Language Family / Device System Memory | device attributes | [lang](https://openmygame.atlassian.net/wiki/spaces/BI/pages/4469456897) · [mem](https://openmygame.atlassian.net/wiki/spaces/BI/pages/4469194754) |
| Player Skill | `chosen_skill_level` in `main_data` (Sudoku Master) | [page](https://openmygame.atlassian.net/wiki/spaces/BI/pages/4214849558) |
| Issue Title / Subtitle | Crashlytics (stability) | [title](https://openmygame.atlassian.net/wiki/spaces/BI/pages/4235788325) |

## Metrics (governed) — Confluence `[Metric] …`
Prefer these over hand-rolled aggregates; reproduce them with `create_semantic_model`.

| Metric | Meaning | Confluence |
| --- | --- | --- |
| Game Completion Rate | % of successful level-completion attempts (completed ÷ started ×100%) | [page](https://openmygame.atlassian.net/wiki/spaces/BI/pages/4502290434) |
| Resource Income / Outcome (+ "in Coins", Cumulative, per Player) | in-game resource flow from `currency_income`/`currency_outcome` | [income](https://openmygame.atlassian.net/wiki/spaces/BI/pages/4207280165) · [outcome](https://openmygame.atlassian.net/wiki/spaces/BI/pages/4207018040) |
| Resources Balance (+ in Coins, per Player) | resource balance at end of level/day/session | [page](https://openmygame.atlassian.net/wiki/spaces/BI/pages/4503273523) |
| Resource Return Ratio | payback ratio of a day/level/session | [page](https://openmygame.atlassian.net/wiki/spaces/BI/pages/4503240730) |
| Cumulative Sessions / Session Duration | session counts/length (AppsFlyer session logic) | [sessions](https://openmygame.atlassian.net/wiki/spaces/BI/pages/4503207971) · [duration](https://openmygame.atlassian.net/wiki/spaces/BI/pages/4503207937) |
| Players Completed N Games | players who finished ≥ N levels | [page](https://openmygame.atlassian.net/wiki/spaces/BI/pages/4493312113) |
| Non-ATT Ad Impressions / Revenue | ad impressions/revenue for users without IDFA (Applovin MAX) | [imp](https://openmygame.atlassian.net/wiki/spaces/BI/pages/4503076865) · [rev](https://openmygame.atlassian.net/wiki/spaces/BI/pages/4503011329) |

The full, current list is the BI space (filter by labels `bi-metric` / `bi-dimension`).

## Gotchas (wrong-answer modes — read before querying)
- **event_data properties are event-specific.** A property is populated only on the
  event(s) that emit it; on other events it reads NULL. ALWAYS scope a measure/step to the
  right `event_name` (`describe_catalog({ property })` lists which events carry it).
- **Nested params.** Ad `network` is in `additional_info`, IAP `location` is in
  `event_data`, `time_zone`/`chosen_skill_level` are in `main_data`. Use `{ search }` to
  find the envelope; don't assume top-level.
- **Player attributes are NOT on the event payload.** Country/platform/ATT/GDPR/language
  live on the **users** dimension — join/group by it, don't look for them in `event_data`.
- **Grain.** Decide per-event vs per-player vs per-session. "per Player" metrics
  `count_distinct` the player key; counting rows over-counts. Funnels: `one_per_partition`
  (players) vs `one_per_match` (situations).
- **Rates need a guarded denominator** (e.g. Game Completion Rate = completed ÷ started).
  A zero or wrong-scoped denominator silently breaks the rate.
- **Monetization reconciliation.** IAP ties to AppsFlyer by `order_id`/`transaction_id`;
  ad data ties to MAX by `tracking_id`. In-event values ≠ reconciled revenue — say which
  you used.
- **ATT / Non-ATT.** iOS revenue/impressions split by IDFA availability (ATT). "Ad revenue"
  may be Non-ATT-only (Applovin MAX) — check the metric definition before comparing.
- **Reinstalls** can distort cohort/revenue metrics — flag the assumption when relevant
  (see the BI note on reinstalls' impact on revenue/cohort metrics).
