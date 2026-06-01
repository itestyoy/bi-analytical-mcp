# Analytics Research → Test Task Formulations

> Purpose: a realistic catalog of the analytics questions product & game analytics
> teams MOST COMMONLY run, turned into concrete task formulations for a **dbt
> Semantic Layer / MetricFlow** test suite. Every formulation is cross-checked
> for feasibility against:
> - `docs/dbt-semantic-layer-spec.md` (metric types, join rules, time spine, filters)
> - `config/catalog.json` (the only events, properties, and attributes that exist)
>
> Scope of the underlying model (from `catalog.json`):
> - **`events`** (`fct_analytics_events`, fact) — entities `user` (foreign,
>   `user_id`), `session` (foreign, `session_id`); time `event_timestamp` (day);
>   `event_name` ∈ {`session_start`, `session_end`, `level_start`,
>   `level_complete`, `level_fail`, `purchase`, `ad_impression`, `ad_click`,
>   `tutorial_step`, `item_acquired`}; properties `level`(int), `score`(int),
>   `attempt`(int), `moves`(int), `revenue`(numeric), `currency`(str),
>   `result`(win/lose), `item_id`(str), `product_id`(str), `ad_network`(str),
>   `step_id`(str).
> - **`users`** (`dim_users`, dimension) — primary entity `user` (`user_id`),
>   foreign entity `campaign` (`campaign_id`); dimensions `install_date`(time/day),
>   `platform`, `os_version`, `device_model`, `country`, `region`, `language`,
>   `media_source`, `acquisition_type`(organic/paid), `app_version`; measure
>   `users_count`.
> - **`campaigns`** (`dim_campaigns`, dimension) — primary entity `campaign`
>   (`campaign_id`); dimensions `channel`, `network`, `cost_model`.
>
> **Join graph:** `events.user (foreign) → users.user (primary)` is a valid left
> join. `events.user → users.campaign (foreign) → campaigns.campaign (primary)`
> is a valid **2-hop** path, so event metrics can be grouped by
> `user__campaign__channel` / `user__campaign__network` / `user__campaign__cost_model`.
>
> **Hard feasibility constraints baked into every task below:**
> - **No cost/spend/impression-cost data exists** → CPI, ROAS, eCPM, CAC payback
>   are **NOT computable** (no campaign cost columns). They appear only as
>   "out of scope" notes, never as buildable tasks.
> - `count_distinct(user_id)` is the activity primitive for DAU/WAU/MAU/payers.
> - **D-N retention, cohort grids, LTV, and "first-event" timing** are only
>   approximable in MetricFlow: there is no per-user first-event/anchor measure
>   except `users.install_date`. Retention vs `install_date` is the honest path;
>   `conversion` metrics cover funnels within an entity+window. Limitations are
>   stated per task.
> - `cumulative` and `conversion` metrics **require the materialized time spine**.
> - `ratio`/`derived` reference **metrics**, not measures (wrap measures in
>   `simple` first). Percentile/median via `agg: percentile`/`median`.

---

## Summary table

| # | Family | Formulations | Dominant metric types | JOIN depth |
|---|---|---|---|---|
| A | Acquisition / UA | 5 | simple, ratio | 1–2 hop |
| B | Activation / Onboarding (tutorial funnel) | 5 | conversion, ratio, simple | 0–1 hop |
| C | Engagement (DAU/WAU/MAU, stickiness, sessions) | 6 | simple, derived, cumulative, ratio | 0–1 hop |
| D | Retention (D1/D7/D30, rolling, cohorts) | 5 | conversion, ratio, cumulative, simple | 0–1 hop |
| E | Monetization (ARPU/ARPPU/LTV/payers/AOV/whales) | 7 | ratio, derived, simple | 0–2 hop |
| F | Progression / Difficulty (level funnels, win-rate, churn-at-level) | 6 | ratio, conversion, simple, derived | 0–1 hop |
| G | Behavioral segmentation (did/didn't X, RFM-ish) | 4 | simple + Metric() filter, ratio | 1 hop |
| H | Conversion (visit→purchase, step funnels) | 4 | conversion, ratio | 0–1 hop |
| I | Ads (impressions/clicks/CTR, ad revenue) | 4 | simple, ratio, derived | 0–1 hop |
| J | Cross-cutting segmentation (JOIN-heavy) | 4 | simple, ratio, derived | 1–2 hop |
| **Total** | | **50** | | |

Legend for assertion types used below: **exact** (deterministic value on seed),
**range [0,1]** (a rate/ratio must stay a proportion), **monotonic** (funnel
counts non-increasing; cumulative non-decreasing), **invariant** (e.g. grouped
sum == ungrouped total; numerator ≤ denominator).

---

## A. Acquisition / User Acquisition

> Real-world framing from AppsFlyer/Adjust UA dashboards. **Cost-based UA KPIs
> (CPI, eCPI, ROAS, CAC) are intentionally absent — no cost columns exist.** What
> IS feasible: install volumes, paid/organic split, channel mix, and value-per-
> channel using in-app revenue (a "ROAS numerator-only" proxy).

### A1. Installs by acquisition channel over time
- **(a) Question:** "How many installs did we get per channel each week last quarter?"
- **(b) Metrics:** `installs` = `count_distinct(user_id)` on `users` (or `count` of `users_count`), one row per installed user.
- **(c) Dims / JOIN:** group by `metric_time__week` (on `users.install_date`) and `user__campaign__channel` (**2-hop**: users→campaigns).
- **(d) Filters/window:** `install_date` in the quarter.
- **(e) MetricFlow type:** `simple`. Limitation: "installs" = distinct users in `dim_users`; no dedicated install event.
- **(f) Assertion:** **invariant** — sum of per-channel installs == total installs (no double counting); **exact** counts on seed.

### A2. Paid vs organic install share
- **(a) Question:** "What share of new users came from paid vs organic this month?"
- **(b) Metrics:** `installs` (simple); `paid_share` = ratio.
- **(c) Dims / JOIN:** group by `user__acquisition_type` (1-hop, on `users`). No campaign hop needed.
- **(d) Filters/window:** `install_date` = current month.
- **(e) MetricFlow type:** `ratio` (paid installs ÷ total installs). Each side a `simple` metric, denominator filtered to all, numerator filtered `acquisition_type='paid'`.
- **(f) Assertion:** **range [0,1]**; **invariant** paid_share + organic_share == 1.

### A3. Top media sources by acquired users
- **(a) Question:** "Which media_sources brought the most users last 30 days?"
- **(b) Metrics:** `installs` (simple, count_distinct user).
- **(c) Dims / JOIN:** group by `user__media_source` (1-hop). Order desc, limit 10.
- **(d) Filters/window:** `install_date` last 30 days.
- **(e) MetricFlow type:** `simple`. No approximation.
- **(f) Assertion:** **exact** top-N ordering on seed; **invariant** grouped sum == total.

### A4. Revenue per acquired user by channel (LTV-proxy / value-per-channel)
- **(a) Question:** "Which acquisition channel delivers the highest revenue per user?"
- **(b) Metrics:** `total_revenue` = `sum(revenue)` filtered `event_name='purchase'`; `installs` = distinct users; `rev_per_user` = ratio.
- **(c) Dims / JOIN:** group by `user__campaign__channel` (**2-hop**). Revenue lives on `events`, channel on `campaigns` → MetricFlow stitches events→users→campaigns.
- **(d) Filters/window:** purchases within window; cohort by `install_date` optional.
- **(e) MetricFlow type:** `ratio` (revenue metric ÷ installs metric). Limitation: this is **value-per-channel**, NOT ROAS (no spend) and NOT projected LTV (observed-to-date only).
- **(f) Assertion:** **range** rev_per_user ≥ 0; **invariant** Σ(channel revenue) == total revenue.

### A5. Channel × platform acquisition matrix
- **(a) Question:** "Break down new users by channel and platform."
- **(b) Metrics:** `installs` (simple).
- **(c) Dims / JOIN:** group by `user__campaign__channel` (2-hop) **and** `user__platform` (1-hop) simultaneously.
- **(d) Filters/window:** `install_date` window.
- **(e) MetricFlow type:** `simple`. Tests two join paths from the same fact in one query.
- **(f) Assertion:** **invariant** double-grouped sum == ungrouped total; **exact** cell counts.

> Out of scope (no data): CPI, eCPI, ROAS, CAC, payback period, click→install rate from ad impressions (ad impressions in `events` are *in-app* ads, not UA ads).

---

## B. Activation / Onboarding (tutorial funnel)

> FTUE funnel from GameAnalytics/Amplitude onboarding analyses. The only tutorial
> signal is `event_name='tutorial_step'` with property `step_id`. "Tutorial
> complete" must be defined as reaching a designated terminal `step_id` (config-
> driven), since there is no explicit `tutorial_complete` event.

### B1. Tutorial step drop-off funnel
- **(a) Question:** "Where in the tutorial do players drop off?"
- **(b) Metrics:** `tutorial_users_at_step` = `count_distinct(user_id)` filtered `event_name='tutorial_step'`, grouped per step.
- **(c) Dims / JOIN:** group by `event__step_id` (0-hop). Optionally segment by `user__platform`.
- **(d) Filters/window:** install cohort / date window.
- **(e) MetricFlow type:** `simple` per step. Limitation: step ordering is enforced by `step_id` sort, not by MetricFlow; funnel is "users who reached step X" not strictly sequential.
- **(f) Assertion:** **monotonic** — distinct users non-increasing across ordered steps.

### B2. Tutorial completion rate
- **(a) Question:** "What % of new users complete the tutorial?"
- **(b) Metrics:** `tutorial_completers` = distinct users reaching terminal `step_id`; `tutorial_starters` = distinct users with first `step_id`; `completion_rate` = ratio.
- **(c) Dims / JOIN:** optional segment by `user__country` / `user__platform` (1-hop).
- **(d) Filters/window:** install cohort window.
- **(e) MetricFlow type:** `ratio` (completers ÷ starters), each a `simple` with a `step_id` filter.
- **(f) Assertion:** **range [0,1]**; **invariant** completers ≤ starters.

### B3. Tutorial-step → first-purchase conversion
- **(a) Question:** "What's conversion from finishing the tutorial to first purchase?"
- **(b) Metrics:** base = `tutorial_step` (terminal step), conversion = `purchase`.
- **(c) Dims / JOIN:** entity `user`; optional segment by `user__acquisition_type`.
- **(d) Filters/window:** conversion `window: "7 days"` (config).
- **(e) MetricFlow type:** **`conversion`** (`base_measure`=tutorial-complete count, `conversion_measure`=purchase count, `entity: user`, `calculation: conversion_rate`). **Requires time spine.** Limitation: counts any purchase in window, not strictly the user's first.
- **(f) Assertion:** **range [0,1]**; conversions ≤ base.

### B4. Tutorial → first-level-start (activation) conversion
- **(a) Question:** "Do tutorial finishers actually start playing levels?"
- **(b) Metrics:** base = tutorial complete, conversion = `level_start`.
- **(c) Dims / JOIN:** entity `user`; optional `user__platform`.
- **(d) Filters/window:** `window: "1 day"`.
- **(e) MetricFlow type:** **`conversion`** (time spine required).
- **(f) Assertion:** **range [0,1]**; monotonic across longer windows (1d ≤ 7d).

### B5. Activation rate (reached core value)
- **(a) Question:** "What share of new users reach activation = completed level 1?"
- **(b) Metrics:** `activated_users` = distinct users with `event_name='level_complete'` and `level=1`; `installs`; `activation_rate` = ratio.
- **(c) Dims / JOIN:** segment by `user__media_source` / `user__country` (1-hop).
- **(d) Filters/window:** install cohort.
- **(e) MetricFlow type:** `ratio`. Limitation: "activation" definition is a config choice (level_complete level=1).
- **(f) Assertion:** **range [0,1]**; activated ≤ installs.

---

## C. Engagement (DAU/WAU/MAU, stickiness, session depth)

### C1. DAU / WAU / MAU trend
- **(a) Question:** "What are our daily / weekly / monthly active users over time?"
- **(b) Metrics:** `active_users` = `count_distinct(user_id)` over `events`.
- **(c) Dims / JOIN:** group by `metric_time__day` / `__week` / `__month`.
- **(d) Filters/window:** date range. Active = any event (or `event_name='session_start'`).
- **(e) MetricFlow type:** `simple`. WAU/MAU come from the **same** measure at coarser grain (count_distinct is non-additive across days but correct when computed at the requested grain).
- **(f) Assertion:** **invariant** DAU ≤ WAU ≤ MAU for an overlapping window; **exact** on seed.

### C2. Stickiness (DAU/MAU ratio)
- **(a) Question:** "How sticky is the game — DAU÷MAU?"
- **(b) Metrics:** `dau` (simple, count_distinct user at day grain), `mau` (same measure at month grain); `stickiness` = derived/ratio.
- **(c) Dims / JOIN:** group by `metric_time__day` (DAU) against monthly MAU.
- **(d) Filters/window:** rolling month.
- **(e) MetricFlow type:** `derived` `dau / nullif(mau,0)`. Limitation: mixing grains across two metrics is the standard but approximate MF stickiness pattern.
- **(f) Assertion:** **range [0,1]**.

### C3. New vs returning active users
- **(a) Question:** "How many active users today are new vs returning?"
- **(b) Metrics:** `active_users` split by whether `install_date` == `metric_time`.
- **(c) Dims / JOIN:** dimension `is_new` = `case when user__install_date = metric_time` (1-hop to users).
- **(d) Filters/window:** day.
- **(e) MetricFlow type:** `simple` with categorical split. Limitation: "new" defined via install_date equality at day grain.
- **(f) Assertion:** **invariant** new + returning == total DAU.

### C4. Sessions per user
- **(a) Question:** "How many sessions does an active user start per day?"
- **(b) Metrics:** `sessions` = `count_distinct(session_id)` (or count of `session_start`); `active_users`; `sessions_per_user` = ratio.
- **(c) Dims / JOIN:** group by `metric_time__day`; optional `user__platform`.
- **(d) Filters/window:** day range.
- **(e) MetricFlow type:** `ratio` (sessions ÷ users).
- **(f) Assertion:** **range** ≥ 1 typically; **invariant** sessions ≥ users.

### C5. Average session length
- **(a) Question:** "What is the average session duration?"
- **(b) Metrics:** `avg_session_seconds` = `average` of per-session duration. Duration = `session_end.event_timestamp − session_start.event_timestamp`.
- **(c) Dims / JOIN:** group by `metric_time__day`, optional `user__platform`.
- **(d) Filters/window:** sessions with both start and end.
- **(e) MetricFlow type:** `simple` (`agg: average`). **Honest limitation:** MetricFlow cannot pair start/end rows across two events within one measure; this requires duration to be **pre-computed in the dbt model** (e.g. a `session_duration` column). If absent, **not computable** — flag as model-dependent.
- **(f) Assertion:** **range** > 0; median ≤ p95 (if percentile variant added).

### C6. Rolling 7-day active users (engagement momentum)
- **(a) Question:** "What's our rolling-7-day unique active user count?"
- **(b) Metrics:** `active_users` measure wrapped in cumulative.
- **(c) Dims / JOIN:** `metric_time__day`.
- **(d) Filters/window:** `window: "7 days"`.
- **(e) MetricFlow type:** **`cumulative`** (`window: "7 days"`, period_agg implied). **Requires time spine.** Limitation: count_distinct over a rolling window is approximate in MF (re-aggregation caveat) — document.
- **(f) Assertion:** **monotonic-ish** rolling series smoother than daily; rolling7 ≥ DAU on each day.

---

## D. Retention (D1 / D7 / D30, rolling, cohorts)

> The canonical product-analytics question family. **Honest limitation:** true
> per-user "day-since-install" retention requires a date-diff between
> `users.install_date` and event day. MetricFlow has no native cohort-grid; the
> two feasible patterns are (1) **conversion metrics** (install→return-in-window)
> and (2) a derived **install_date vs metric_time** dimension. Both are
> documented as approximations of classic D-N retention.

### D1. D1 retention by acquisition channel
- **(a) Question:** "What is D1 retention by acquisition channel?"
- **(b) Metrics:** `installs` (cohort denominator); `retained_d1` = distinct users active exactly/at least 1 day after install; `d1_retention` = ratio.
- **(c) Dims / JOIN:** group by `user__campaign__channel` (**2-hop**) or `user__acquisition_type` (1-hop).
- **(d) Filters/window:** `metric_time = install_date + 1 day` (via derived day-offset dimension).
- **(e) MetricFlow type:** `ratio`, OR **`conversion`** (base=install, conversion=any event, `window:"1 day"`, entity user). Limitation: requires a day-offset dimension or conversion window; classic "exactly D1" vs "D1+" definition must be fixed in config.
- **(f) Assertion:** **range [0,1]**; retained ≤ installs.

### D2. D7 retention
- **(a) Question:** "What is our D7 retention this cohort?"
- **(b) Metrics:** as D1 but `window:"7 days"` / offset 7.
- **(c) Dims / JOIN:** segment by `user__platform` / `user__country`.
- **(d) Filters/window:** 7-day offset.
- **(e) MetricFlow type:** `conversion` (window 7d) or ratio with offset dim. Time spine required.
- **(f) Assertion:** **range [0,1]**; **monotonic** D1 ≥ D7 ≥ D30 for same cohort.

### D3. D30 retention
- **(a) Question:** "What is D30 retention — our LTV predictor?"
- **(b) Metrics:** retained_d30 ÷ installs.
- **(c) Dims / JOIN:** by `user__media_source` (1-hop) or channel (2-hop).
- **(d) Filters/window:** 30-day offset.
- **(e) MetricFlow type:** `conversion` / ratio. Time spine required.
- **(f) Assertion:** **range [0,1]**; D30 ≤ D7 ≤ D1 (cross-task invariant).

### D4. Rolling retention (returned on or after day N)
- **(a) Question:** "What's rolling D7 retention (came back any day ≥ 7)?"
- **(b) Metrics:** `installs`; `rolling_retained` = users with any event with day-offset ≥ N; ratio.
- **(c) Dims / JOIN:** optional segment by channel (2-hop).
- **(d) Filters/window:** offset ≥ N.
- **(e) MetricFlow type:** `ratio`/`cumulative`. Limitation: "rolling/unbounded" retention vs "classic N-day" must be config-distinguished.
- **(f) Assertion:** **range [0,1]**; rolling-DN ≥ classic-DN (rolling is more permissive).

### D5. Cohort retention grid (install week × weeks-since-install)
- **(a) Question:** "Show the cohort retention triangle by install week."
- **(b) Metrics:** `installs` per cohort; `retained_users`; `retention_rate`.
- **(c) Dims / JOIN:** rows = `user__install_date` (week grain), columns = weeks-since-install derived dim (`date_diff(event_week, install_week)`).
- **(d) Filters/window:** full history.
- **(e) MetricFlow type:** `ratio`. **Honest limitation:** the classic triangle is built by **two time axes**; MetricFlow needs a pre-computed `weeks_since_install` dimension in the model to express the column axis. Without it the grid is **not buildable**; flag as model-dependent.
- **(f) Assertion:** **monotonic** retention non-increasing along each cohort row; **invariant** week-0 == 100% (== cohort size).

---

## E. Monetization (ARPU / ARPPU / LTV / payer share / AOV / whales)

### E1. ARPU (average revenue per user)
- **(a) Question:** "What's ARPU by country last 30 days?"
- **(b) Metrics:** `total_revenue` = `sum(revenue)` filter `event_name='purchase'`; `active_users` (or installs); `arpu` = ratio.
- **(c) Dims / JOIN:** group by `user__country` (1-hop).
- **(d) Filters/window:** last 30 days.
- **(e) MetricFlow type:** `ratio` (revenue metric ÷ users metric).
- **(f) Assertion:** **range** ≥ 0; **invariant** Σ(country revenue) == total revenue.

### E2. ARPPU (per paying user) for paid users
- **(a) Question:** "ARPPU by country for paid-acquired users last 30 days?"
- **(b) Metrics:** `total_revenue`; `payers` = `count_distinct(user_id)` filter `event_name='purchase'`; `arppu` = ratio.
- **(c) Dims / JOIN:** group by `user__country`, filter `user__acquisition_type='paid'` (1-hop).
- **(d) Filters/window:** last 30 days, paid users only.
- **(e) MetricFlow type:** `ratio` (revenue ÷ payers).
- **(f) Assertion:** **invariant** ARPPU ≥ ARPU (payers ≤ users); range ≥ 0.

### E3. ARPDAU (revenue per daily active user)
- **(a) Question:** "What's our ARPDAU trend (IAP + ad revenue combined)?"
- **(b) Metrics:** `revenue_iap` (purchase) + `revenue_ad` (ad_impression revenue, if populated); `dau`; `arpdau` = derived.
- **(c) Dims / JOIN:** `metric_time__day`, optional `user__platform`.
- **(d) Filters/window:** day range.
- **(e) MetricFlow type:** `derived` `(iap_rev + ad_rev) / nullif(dau,0)`. Limitation: ad revenue only if `revenue` is set on `ad_impression` rows; else IAP-only.
- **(f) Assertion:** **range** ≥ 0; arpdau == arpu when computed at day grain (consistency check).

### E4. Payer conversion rate (payer share)
- **(a) Question:** "What % of active users are payers?"
- **(b) Metrics:** `payers` = distinct users with purchase; `active_users`; `payer_rate` = ratio.
- **(c) Dims / JOIN:** segment by `user__country` / `user__platform` (1-hop).
- **(d) Filters/window:** window.
- **(e) MetricFlow type:** `ratio`.
- **(f) Assertion:** **range [0,1]**; payers ≤ active_users.

### E5. AOV (average order value) and purchases per payer
- **(a) Question:** "What's average order value and orders-per-payer?"
- **(b) Metrics:** `total_revenue`; `orders` = `count` filter purchase; `aov` = revenue ÷ orders; `orders_per_payer` = orders ÷ payers.
- **(c) Dims / JOIN:** group by `user__platform`, optional `event__product_id`.
- **(d) Filters/window:** window.
- **(e) MetricFlow type:** two `ratio` metrics.
- **(f) Assertion:** **range** AOV > 0; **invariant** total_revenue == aov × orders.

### E6. Whales vs minnows revenue share
- **(a) Question:** "What share of revenue comes from whales (top spenders)?"
- **(b) Metrics:** `revenue_from_whales` ÷ `total_revenue`; whale = user whose lifetime spend exceeds a threshold/percentile.
- **(c) Dims / JOIN:** segment dimension `spender_tier` ∈ {whale, dolphin, minnow}.
- **(d) Filters/window:** lifetime / window.
- **(e) MetricFlow type:** `ratio`, with a `Metric('total_user_revenue', group_by=['user']) > threshold` style filter **or** a pre-computed `spender_tier` dimension. **Honest limitation:** per-user spend tiering via `Metric()` filter is constrained to one group-by entity (`user`) — feasible — but percentile-based dynamic whale cutoffs are easier with a model-side `spender_tier` column.
- **(f) Assertion:** **range [0,1]**; **invariant** Σ(tier revenue) == total revenue; whale_share typically ≫ whale_population_share.

### E7. Cumulative / running revenue (LTV-to-date curve)
- **(a) Question:** "Show cumulative revenue per install cohort over time (LTV curve proxy)."
- **(b) Metrics:** `total_revenue` wrapped cumulative; `cumulative_revenue_per_user` = derived ÷ cohort installs.
- **(c) Dims / JOIN:** cohort by `user__install_date` (week), x-axis `metric_time__day`.
- **(d) Filters/window:** unbounded accumulation or `grain_to_date`.
- **(e) MetricFlow type:** **`cumulative`** (no window = all-time accumulation), then `derived` for per-user. **Requires time spine.** Limitation: this is **observed LTV-to-date**, not a projected/predicted LTV.
- **(f) Assertion:** **monotonic** non-decreasing over time; cumulative ≥ any single-day revenue.

> Out of scope (no data): predicted/modeled LTV, ROAS, LTV:CAC ratio (no cost).

---

## F. Progression / Difficulty (level funnels, win-rate, churn-at-level)

> Uses `level_start`/`level_complete`/`level_fail` events with `level`, `attempt`,
> `result`(win/lose), `moves`, `score` properties.

### F1. Level progression funnel (where do players drop?)
- **(a) Question:** "Which level has the steepest drop-off?"
- **(b) Metrics:** `players_reaching_level` = `count_distinct(user_id)` filter `event_name='level_start'`, per `level`.
- **(c) Dims / JOIN:** group by `event__level` (0-hop). Optional `user__platform`.
- **(d) Filters/window:** window.
- **(e) MetricFlow type:** `simple` per level; drop-off = derived diff between consecutive levels (computed downstream).
- **(f) Assertion:** **monotonic** distinct players non-increasing as level increases; identify max negative delta.

### F2. Level completion / win rate
- **(a) Question:** "What's the win rate per level?"
- **(b) Metrics:** `level_wins` = count filter `event_name='level_complete'` (or `result='win'`); `level_attempts` = count `level_start`; `win_rate` = ratio.
- **(c) Dims / JOIN:** group by `event__level`.
- **(d) Filters/window:** window.
- **(e) MetricFlow type:** `ratio` (completes ÷ starts).
- **(f) Assertion:** **range [0,1]**; completes ≤ starts; flag levels with win_rate below a threshold (difficulty spike).

### F3. Level fail rate / difficulty hotspots
- **(a) Question:** "Which levels have the highest fail rate?"
- **(b) Metrics:** `fail_rate` = `level_fail` count ÷ (`level_complete` + `level_fail`) count, per level.
- **(c) Dims / JOIN:** group by `event__level`.
- **(d) Filters/window:** window.
- **(e) MetricFlow type:** `ratio`.
- **(f) Assertion:** **range [0,1]**; **invariant** win_rate-ish + fail-ish split consistent; order by desc to find hotspots.

### F4. Average attempts to clear a level
- **(a) Question:** "How many attempts does it take to beat each level?"
- **(b) Metrics:** `avg_attempts` = `average` of `attempt` on `level_complete` rows; optional `median`/`p90`.
- **(c) Dims / JOIN:** group by `event__level`.
- **(d) Filters/window:** window.
- **(e) MetricFlow type:** `simple` (`agg: average`/`median`/`percentile`).
- **(f) Assertion:** **range** ≥ 1; median ≤ p90; rising trend with level = harder progression.

### F5. Churn-at-level (last level reached before quitting)
- **(a) Question:** "At which level do most players churn out?"
- **(b) Metrics:** `players_whose_max_level_is_L` = distinct users whose highest reached `level` == L.
- **(c) Dims / JOIN:** dimension `max_level` (per-user max).
- **(d) Filters/window:** churned users (no recent activity).
- **(e) MetricFlow type:** `simple` over a **model-side `max_level_reached` per-user column**. **Honest limitation:** per-user max-level and a churn flag aren't expressible as a single MetricFlow measure → requires precomputed columns; flag model-dependent.
- **(f) Assertion:** **invariant** Σ over levels == churned population; spike at the churn level.

### F6. Level completion → next-level-start conversion
- **(a) Question:** "Of players who clear level N, how many start level N+1?"
- **(b) Metrics:** base = `level_complete` (level N), conversion = `level_start` (level N+1), entity user.
- **(c) Dims / JOIN:** entity `user`; `constant_properties` not directly usable for N→N+1 offset.
- **(d) Filters/window:** `window: "1 day"`.
- **(e) MetricFlow type:** **`conversion`** (time spine). Limitation: the "+1" relation can't be expressed in a single conversion metric across all levels at once; do per-level pairs or precompute. Document.
- **(f) Assertion:** **range [0,1]**; conversions ≤ base.

---

## G. Behavioral segmentation (did / didn't do X, RFM-ish)

### G1. Users who did vs didn't make a purchase
- **(a) Question:** "Compare engagement of buyers vs non-buyers."
- **(b) Metrics:** `active_users` split by `has_purchased` flag; `sessions` per group.
- **(c) Dims / JOIN:** dimension `is_payer` via `Metric('purchases', group_by=['user']) > 0` filter (1-hop user).
- **(d) Filters/window:** window.
- **(e) MetricFlow type:** `simple` + **`Metric()` filter** (group_by single entity `user` — allowed per spec §6.6).
- **(f) Assertion:** **invariant** buyers + non-buyers == total users.

### G2. Users who reached level X but never purchased
- **(a) Question:** "How many engaged-but-unmonetized users (cleared level 10, 0 purchases)?"
- **(b) Metrics:** `count_distinct(user_id)` with two `Metric()` filters: reached level ≥ 10 AND purchases == 0.
- **(c) Dims / JOIN:** segment by `user__country`.
- **(d) Filters/window:** window.
- **(e) MetricFlow type:** `simple` + `Metric()` filters. Limitation: each `Metric()` filter allows only one group-by entity (`user`) — both qualify; stacking two such filters is the edge to test.
- **(f) Assertion:** **invariant** ≤ users who reached level 10; ≤ non-payers.

### G3. Frequency segmentation (sessions per user buckets)
- **(a) Question:** "Segment users into low/med/high frequency by session count."
- **(b) Metrics:** `users` grouped by `frequency_bucket`.
- **(c) Dims / JOIN:** dimension `frequency_bucket` from `Metric('sessions', group_by=['user'])` thresholds, or model-side bucket column.
- **(d) Filters/window:** window.
- **(e) MetricFlow type:** `simple` + `Metric()` filter or precomputed bucket. Limitation: bucketing on a metric is cleaner as a model-side column.
- **(f) Assertion:** **invariant** Σ buckets == total users.

### G4. RFM-style monetary tier (recency/frequency/monetary proxy)
- **(a) Question:** "Group payers by RFM tier — recent big spenders vs lapsed."
- **(b) Metrics:** `users` grouped by `monetary_tier` (lifetime spend) × `recency_bucket` (days since last event).
- **(c) Dims / JOIN:** dimensions `monetary_tier`, `recency_bucket` (model-side per-user columns).
- **(d) Filters/window:** payers only.
- **(e) MetricFlow type:** `simple`. **Honest limitation:** full RFM (3 per-user aggregates + bucketing) is **not expressible** purely in MetricFlow measures/filters — requires precomputed per-user R/F/M columns; flag model-dependent.
- **(f) Assertion:** **invariant** Σ over RFM cells == payer population; monetary tiers ordered.

---

## H. Conversion (visit → purchase, step funnels)

### H1. Session-start → purchase conversion
- **(a) Question:** "What's conversion from opening the game to making a purchase?"
- **(b) Metrics:** base = `session_start`, conversion = `purchase`, entity user.
- **(c) Dims / JOIN:** segment by `user__platform` / `user__country` (1-hop).
- **(d) Filters/window:** `window: "1 day"` (same-session-ish) or 7d.
- **(e) MetricFlow type:** **`conversion`** (`calculation: conversion_rate`). Time spine required.
- **(f) Assertion:** **range [0,1]**; **monotonic** rate increases with longer window.

### H2. Store-view → purchase with matching product (constant property)
- **(a) Question:** "Of users who acquire/view item X, how many buy the same product?"
- **(b) Metrics:** base = `item_acquired` (or session_start), conversion = `purchase`, with `constant_properties` matching `product_id`.
- **(c) Dims / JOIN:** entity user; product match via `constant_properties: product_id`.
- **(d) Filters/window:** `window: "7 days"`.
- **(e) MetricFlow type:** **`conversion`** with `constant_properties`. Time spine required. Limitation: requires `product_id` present on both event rows.
- **(f) Assertion:** **range [0,1]**; constrained conversion ≤ unconstrained conversion (H1-style).

### H3. Multi-step onboarding funnel (install → level_start → level_complete → purchase)
- **(a) Question:** "Full funnel from install to first purchase — step conversions?"
- **(b) Metrics:** distinct users at each stage: installs → `level_start` → `level_complete` → `purchase`.
- **(c) Dims / JOIN:** chain spans `users` (install) + `events`; segment by `user__acquisition_type`.
- **(d) Filters/window:** cohort window.
- **(e) MetricFlow type:** chained `conversion` metrics or sequence of `simple` counts. Limitation: MetricFlow conversion is **pairwise** (base→conversion); a 4-step funnel is modeled as 3 pairwise conversions, not one native multi-step funnel — document.
- **(f) Assertion:** **monotonic** stage counts non-increasing; each step rate in [0,1].

### H4. Ad-click → purchase conversion (in-app ad to IAP)
- **(a) Question:** "Do players who click in-app ads also purchase?"
- **(b) Metrics:** base = `ad_click`, conversion = `purchase`, entity user.
- **(c) Dims / JOIN:** segment by `user__platform`.
- **(d) Filters/window:** `window: "1 day"`.
- **(e) MetricFlow type:** **`conversion`**. Time spine required.
- **(f) Assertion:** **range [0,1]**.

---

## I. Ads (impressions / clicks / CTR, ad revenue)

> In-app ad events: `ad_impression`, `ad_click` with `ad_network` property and
> (optionally) `revenue` on impressions. **No ad cost/eCPM source revenue split
> beyond `revenue` on the event** — eCPM is computable only if `revenue` on
> impressions is populated.

### I1. Ad impressions and clicks volume
- **(a) Question:** "How many ad impressions and clicks per day by network?"
- **(b) Metrics:** `impressions` = count filter `event_name='ad_impression'`; `clicks` = count filter `ad_click`.
- **(c) Dims / JOIN:** group by `metric_time__day`, `event__ad_network`.
- **(d) Filters/window:** date range.
- **(e) MetricFlow type:** two `simple` metrics.
- **(f) Assertion:** **exact** counts; **invariant** clicks ≤ impressions (typically).

### I2. Ad CTR (click-through rate)
- **(a) Question:** "What's our in-app ad CTR by network?"
- **(b) Metrics:** `clicks` ÷ `impressions` = `ctr`.
- **(c) Dims / JOIN:** group by `event__ad_network`, optional `user__platform`.
- **(d) Filters/window:** window.
- **(e) MetricFlow type:** `ratio`.
- **(f) Assertion:** **range [0,1]**; clicks ≤ impressions.

### I3. Ad revenue and Ad ARPDAU
- **(a) Question:** "What's ad revenue per DAU (Ad ARPDAU) by platform?"
- **(b) Metrics:** `ad_revenue` = `sum(revenue)` filter `event_name='ad_impression'`; `dau`; `ad_arpdau` = ratio/derived.
- **(c) Dims / JOIN:** group by `metric_time__day`, `user__platform`.
- **(d) Filters/window:** day range.
- **(e) MetricFlow type:** `ratio` (ad_revenue ÷ dau). Limitation: only valid if impressions carry `revenue`; else not computable.
- **(f) Assertion:** **range** ≥ 0; **invariant** ad_revenue ≤ total_revenue.

### I4. eCPM (revenue per 1000 impressions)
- **(a) Question:** "What's our eCPM by ad network?"
- **(b) Metrics:** `ad_revenue`; `impressions`; `ecpm` = derived `1000 * ad_revenue / nullif(impressions,0)`.
- **(c) Dims / JOIN:** group by `event__ad_network`.
- **(d) Filters/window:** window.
- **(e) MetricFlow type:** `derived`. Limitation: this is **publisher-side eCPM** from in-app `revenue` on impressions (NOT UA-side eCPM/cost).
- **(f) Assertion:** **range** ≥ 0; eCPM × impressions / 1000 == ad_revenue (consistency).

---

## J. Cross-cutting segmentation (JOIN-heavy)

> These exist to stress the entity-graph: 1-hop (events→users) and 2-hop
> (events→users→campaigns), plus multi-dimension group-bys. They re-use metrics
> from other families but force the join paths.

### J1. Revenue by campaign channel (2-hop)
- **(a) Question:** "Total revenue by campaign channel last quarter."
- **(b) Metrics:** `total_revenue` (simple, purchase filter).
- **(c) Dims / JOIN:** group by `user__campaign__channel` (**2-hop**: events→users→campaigns).
- **(d) Filters/window:** quarter.
- **(e) MetricFlow type:** `simple`. Tests the full 2-hop path on a fact measure.
- **(f) Assertion:** **invariant** Σ(channel revenue) == total revenue; **exact** on seed.

### J2. Retention by campaign network (2-hop) × platform
- **(a) Question:** "D7 retention by campaign network and platform."
- **(b) Metrics:** `d7_retention` ratio (from D2).
- **(c) Dims / JOIN:** group by `user__campaign__network` (2-hop) **and** `user__platform` (1-hop).
- **(d) Filters/window:** cohort.
- **(e) MetricFlow type:** `ratio`/`conversion`. Two join paths + time spine.
- **(f) Assertion:** **range [0,1]**; **invariant** weighted avg of cells ≈ overall D7.

### J3. ARPPU by country × acquisition_type (1-hop, dual filter)
- **(a) Question:** "ARPPU by country split by paid vs organic."
- **(b) Metrics:** `arppu` ratio (from E2).
- **(c) Dims / JOIN:** group by `user__country` **and** `user__acquisition_type` (both 1-hop on users).
- **(d) Filters/window:** window.
- **(e) MetricFlow type:** `ratio`.
- **(f) Assertion:** **invariant** ARPPU ≥ ARPU per cell; range ≥ 0.

### J4. Payer rate by cost_model × channel (2-hop, two campaign dims)
- **(a) Question:** "Payer conversion by campaign cost_model and channel."
- **(b) Metrics:** `payer_rate` ratio (from E4).
- **(c) Dims / JOIN:** group by `user__campaign__cost_model` and `user__campaign__channel` (both **2-hop** through the same campaign entity).
- **(d) Filters/window:** window.
- **(e) MetricFlow type:** `ratio`. Tests two dimensions reached via the same 2-hop join.
- **(f) Assertion:** **range [0,1]**; **invariant** grouped payers ≤ grouped actives.

---

## Cross-cutting feasibility notes (apply to all tasks)

1. **Time spine is mandatory** for every `conversion` and `cumulative` task
   (B3, B4, C6, D1–D4, E7, F6, H1–H4) and for any `metric_time__*` grain.
2. **Model-dependent (not pure-MetricFlow) tasks** — need precomputed columns in
   the dbt model, flag in tests: C5 (session_duration), D5 (weeks_since_install),
   F5 (max_level_reached + churn flag), G4 (RFM per-user R/F/M).
3. **`ratio`/`derived` reference metrics, not measures** — wrap each measure in a
   `simple` metric first (spec §6.2/§6.4).
4. **`Metric()` filters** (G1–G3, E6) allow exactly **one** group-by entity
   (`user`) per spec §6.6 — valid here, but stacking multiples (G2) is an edge.
5. **Never assume cost data.** All CPI/ROAS/eCPI/CAC/LTV-prediction questions are
   excluded by design; revenue-per-X is the honest substitute.
6. **count_distinct is non-additive across time** — DAU/WAU/MAU and rolling
   active users (C1, C6) must be computed at the requested grain, not summed.

---

## Sources

- GameAnalytics — [How to calculate ARPU, ARPPU, ARPDAU and more](https://www.gameanalytics.com/blog/how-to-calculate-arpu-arppu-arpdau-and-more); [A Deep Dive into Funnel Reporting for Games](https://www.gameanalytics.com/blog/exploring-gaming-funnels); [Funnels documentation](https://docs.gameanalytics.com/products-and-features/analytics-iq/funnels/)
- Amplitude — [Retention Analysis](https://amplitude.com/docs/analytics/charts/retention-analysis); [Cohort Retention Analysis](https://amplitude.com/explore/analytics/cohort-retention-analysis); [Funnel Analysis guide](https://amplitude.com/guides/funnel-analysis); [User Sessions](https://amplitude.com/docs/analytics/charts/user-sessions/user-sessions-track-engagement-frequency); [Guide to Product Metrics (PDF)](https://info.amplitude.com/rs/138-CDN-550/images/The%20Amplitude%20Guide%20to%20Product%20Metrics.pdf)
- Mixpanel — [MAU definition & benchmarks](https://mixpanel.com/blog/mau/); [Cohorts](https://docs.mixpanel.com/docs/users/cohorts); [Behavioral segmentation](https://mixpanel.com/blog/behavioral-segmentation/); [Cohort analysis guide](https://mixpanel.com/blog/cohort-analysis/)
- PostHog — [PostHog vs Mixpanel (cohorts/funnels/retention)](https://posthog.com/blog/posthog-vs-mixpanel)
- AppsFlyer — [Optimizing the path to install conversion (CTI/IPM)](https://www.appsflyer.com/blog/trends-insights/optimizing-path-install-conversion/); [App campaign marketing analytics](https://www.appsflyer.com/blog/measurement-analytics/app-campaigns-marketing-analytics/); [CVR vs CPI](https://www.appsflyer.com/metrics-comparison/conversion-rate-vs-cpi/)
- Adjust — [Data science & difficulty tuning in mobile games](https://www.adjust.com/blog/askblu-data-science-mobile-games-difficulty-tuning/)
- Mobile-game KPI guides — [Game Growth Advisor: 20 Mobile Game KPIs & 2026 benchmarks](https://gamegrowthadvisor.com/blog/2026-03-17-mobile-game-kpis-benchmarks-2026/); [MetricFire: Mobile Game KPIs](https://www.metricfire.com/blog/the-most-important-kpis-for-monitoring-mobile-games/); [Udonis: Key mobile game metrics](https://www.blog.udonis.co/mobile-marketing/mobile-games/key-mobile-game-metrics); [maf.ad retention benchmarks](https://maf.ad/en/blog/mobile-game-retention-benchmarks/)
- Whales/spender segmentation — [Udonis: What is a Whale in Gaming](https://www.blog.udonis.co/mobile-marketing/mobile-games/mobile-games-whales); [devtodev: Paying audience segmentation](https://www.devtodev.com/resources/articles/4-simple-methods-of-paying-audience-segmentation)
- Progression/difficulty — [devtodev: Game Level Progression](https://www.devtodev.com/resources/articles/game-level-progression); [Number Analytics: Funnel analysis in game design](https://www.numberanalytics.com/blog/mastering-funnel-analysis-game-design)
- Ad monetization — [GameBiz Consulting: Mobile ad monetization metrics](https://www.gamebizconsulting.com/blog/mobile-ad-monetization-metrics); [devtodev: Best ad metrics](https://www.devtodev.com/resources/articles/best-ad-metrics-to-maximize-app-s-revenue); [Chartboost: 35 essential ad metrics](https://www.chartboost.com/resources/guides/35-essential-ad-metrics-mobile-game-developers-are-monitoring-right-now/)
- First-purchase conversion / activation — [SolarEngine: Cracking first-purchase conversion](https://blog.solar-engine.com/en-blog/docs/From-Player-to-Payer-The-Guide-to-Cracking-FirstPurchase-Conversion-in-Mobile-Games); [DAU/MAU stickiness guide (Gainsight)](https://www.gainsight.com/essential-guide/product-management-metrics/dau-mau/)
- Session metrics — [devtodev: Average Session Length](https://www.devtodev.com/education/articles/en/402/main-metrics-average-session-length)
- dbt Semantic Layer / MetricFlow — official docs as cited in `docs/dbt-semantic-layer-spec.md`
