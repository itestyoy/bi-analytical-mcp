# SEED_DATA — dbt seed dataset for the Postgres test warehouse

This documents the **exact** contents of the dbt seeds so integration tests can assert
precise numbers. The dataset is intentionally small but exercises every task type in
[`docs/analytics-task-taxonomy.md`](../../../docs/analytics-task-taxonomy.md).

Seeds live in `dbt_project/seeds/`:

- `seed_campaigns.csv` -> model `dim_campaigns`
- `seed_users.csv` -> model `dim_users`
- `seed_events.csv` -> model `fct_analytics_events`

Load with `dbt seed` then `dbt run`. Column types are pinned in `dbt_project.yml`
(`seed_events.event_timestamp` = `timestamp`, `seed_events.event_properties` = `jsonb`,
`seed_users.install_date` = `date`).

All values use only columns / `event_name`s / `event_properties` keys defined in
`config/catalog.json`. Revenue values are integers (no float noise).

---

## Row counts

| Table / model | Rows |
|---|---|
| `seed_campaigns` / `dim_campaigns` | 3 |
| `seed_users` / `dim_users` | 12 |
| `seed_events` / `fct_analytics_events` | 74 |

### Event rows by `event_name`

| event_name | count |
|---|---|
| session_start | 22 |
| purchase | 10 |
| level_start | 14 |
| level_complete | 9 |
| level_fail | 6 |
| tutorial_step | 7 |
| ad_impression | 4 |
| ad_click | 2 |
| **total** | **74** |

(`session_end` and `item_acquired` are valid catalog events but are not present.)

---

## Campaigns (`dim_campaigns`)

| campaign_id | channel | network | cost_model |
|---|---|---|---|
| c1 | social | meta | cpi |
| c2 | search | google | cpc |
| c3 | video | applovin | cpm |

Distinct channels: social, search, video.

---

## Users (`dim_users`)

| user_id | install_date | platform | os_version | device_model | country | region | language | media_source | acquisition_type | app_version | campaign_id |
|---|---|---|---|---|---|---|---|---|---|---|---|
| u1 | 2026-01-01 | ios | 17 | iphone | US | NA | en | meta | paid | 1.0 | c1 |
| u2 | 2026-01-01 | android | 14 | pixel | US | NA | en | organic | organic | 1.0 | c2 |
| u3 | 2026-01-02 | ios | 17 | iphone | GB | EU | en | meta | paid | 1.0 | c1 |
| u4 | 2026-01-02 | android | 13 | galaxy | DE | EU | de | google | paid | 1.0 | c2 |
| u5 | 2026-01-03 | ios | 16 | iphone | BR | LATAM | pt | organic | organic | 1.0 | c1 |
| u6 | 2026-01-03 | android | 14 | pixel | US | NA | en | applovin | paid | 1.0 | c3 |
| u7 | 2026-01-04 | ios | 17 | iphone | GB | EU | en | applovin | paid | 1.0 | c3 |
| u8 | 2026-01-04 | android | 13 | galaxy | DE | EU | de | organic | organic | 1.0 | c2 |
| u9 | 2026-01-04 | ios | 16 | iphone | BR | LATAM | pt | meta | paid | 1.0 | c1 |
| u10 | 2026-01-05 | android | 14 | pixel | US | NA | en | google | paid | 1.0 | c2 |
| u11 | 2026-01-05 | ios | 17 | iphone | GB | EU | en | organic | organic | 1.0 | c1 |
| u12 | 2026-01-05 | android | 13 | galaxy | DE | EU | de | applovin | paid | 1.0 | c3 |

### Install cohorts (users per `install_date`)

| install_date | users | user_ids |
|---|---|---|
| 2026-01-01 | 2 | u1, u2 |
| 2026-01-02 | 2 | u3, u4 |
| 2026-01-03 | 2 | u5, u6 |
| 2026-01-04 | 3 | u7, u8, u9 |
| 2026-01-05 | 3 | u10, u11, u12 |

### User attribute distributions

- **acquisition_type:** paid = 8 (u1,u3,u4,u6,u7,u9,u10,u12), organic = 4 (u2,u5,u8,u11)
- **platform:** ios = 6 (u1,u3,u5,u7,u9,u11), android = 6 (u2,u4,u6,u8,u10,u12)
- **country:** US = 4 (u1,u2,u6,u10), GB = 3 (u3,u7,u11), DE = 3 (u4,u8,u12), BR = 2 (u5,u9)
- **media_source:** meta = 3 (u1,u3,u9), organic = 4 (u2,u5,u8,u11), google = 2 (u4,u10), applovin = 3 (u6,u7,u12)
- **campaign_id:** c1 = 5 (u1,u3,u5,u9,u11), c2 = 4 (u2,u4,u8,u10), c3 = 3 (u6,u7,u12)

---

## Monetization (purchases)

10 `purchase` events. All revenue is integer USD.

| event_id | user_id | timestamp | revenue | product_id | level |
|---|---|---|---|---|---|
| e1 | u1 | 2026-01-03 10:00:00 | 100 | p1 | 5 |
| e2 | u1 | 2026-01-03 11:00:00 | 50 | p2 | 6 |
| e3 | u3 | 2026-01-04 09:00:00 | 200 | p1 | 9 |
| e4 | u2 | 2026-01-03 12:00:00 | 999 | p1 | 3 |
| e33 | u4 | 2026-01-05 10:30:00 | 50 | p2 | 2 |
| e42 | u6 | 2026-01-04 12:30:00 | 20 | p3 | 3 |
| e44 | u6 | 2026-01-11 12:30:00 | 100 | p1 | 4 |
| e58 | u9 | 2026-01-05 15:30:00 | 30 | p3 | 4 |
| e60 | u9 | 2026-01-06 15:30:00 | 50 | p2 | 5 |
| e65 | u10 | 2026-01-06 16:30:00 | 100 | p1 | 2 |

### Total purchase revenue = **1699**

### Revenue by `acquisition_type`

| acquisition_type | revenue |
|---|---|
| paid | 700 |
| organic | 999 |
| **total** | **1699** |

(organic revenue is entirely u2's single 999 purchase.)

### Revenue by `country`

| country | revenue |
|---|---|
| US | 1369 |
| GB | 200 |
| DE | 50 |
| BR | 80 |
| **total** | **1699** |

### Revenue by `product_id`

| product_id | revenue | purchase count |
|---|---|---|
| p1 | 1499 | 5 |
| p2 | 150 | 3 |
| p3 | 50 | 2 |
| **total** | **1699** | **10** |

Products present: **p1, p2, p3**.

### Payers vs non-payers

- **Distinct payers = 7:** u1, u2, u3, u4, u6, u9, u10
- **Non-payers = 5:** u5, u7, u8, u11, u12
- **Payer share** = 7 / 12.

Revenue per payer:

| user_id | revenue | acquisition_type | country |
|---|---|---|---|
| u1 | 150 | paid | US |
| u2 | 999 | organic | US |
| u3 | 200 | paid | GB |
| u4 | 50 | paid | DE |
| u6 | 120 | paid | US |
| u9 | 80 | paid | BR |
| u10 | 100 | paid | US |

Derived monetization figures:
- ARPU = 1699 / 12 distinct users.
- ARPPU = 1699 / 7 payers.
- Avg transaction value = 1699 / 10 purchases = 169.9.

---

## Behavioral cohorts (did / didn't do event X)

Distinct users who performed each event (for `behavioral_cohort` and `visit_to_purchase`):

| event | users who did it | count | users who did NOT (of 12) | count |
|---|---|---|---|---|
| purchase | u1,u2,u3,u4,u6,u9,u10 | 7 | u5,u7,u8,u11,u12 | 5 |
| level_complete | u1,u2,u3,u4,u6,u7,u9,u10 | 8 | u5,u8,u11,u12 | 4 |
| ad_click | u6,u9 | 2 | the other 10 | 10 |
| tutorial_step | u1,u3,u4,u8,u11 | 5 | the other 7 | 7 |
| session_start | all except none with sessions: u1..u12 minus none | 12 | 0 | 0 |

Note: every user has at least one `session_start` (all 12 are "visitors").

---

## Level progression (`level_start` / `level_complete` / `level_fail`)

Per-level event counts:

| level | level_start | level_complete | level_fail |
|---|---|---|---|
| 1 | 7 | 4 | 3 |
| 2 | 2 | 1 | 1 |
| 3 | 1 | 1 | 0 |
| 4 | 1 | 1 | 0 |
| 5 | 0 | 1 | 0 |
| 6 | 0 | 0 | 0 |
| 7 | 1 | 0 | 1 |
| 9 | 1 | 1 | 0 |
| 10 | 1 | 0 | 1 |
| **total** | **14** | **9** | **6** |

Notes:
- Level 5 has a `level_complete` with **no** matching `level_start` (this is the
  preserved event `e5`, u1, score 1200). This is intentional — useful for testing
  joins/measures that don't assume a 1:1 start/complete pairing.
- Levels 6 and 8 never appear in level_* events (level 6 only appears as a purchase
  property on e2). No level_* rows exist for them.
- `result` values present: `win` (on level_complete rows) and `lose` (on level_fail rows).
- `attempt` ranges 1..2; multi-attempt levels: level 1 (u2: fail attempt 1 then
  complete attempt 2) and level 2 (u4: fail attempt 1 then complete attempt 2).
- `moves` and `score` are populated on level_start/complete/fail and on e5.

Win rate per started level (level_complete / level_start), ignoring level 5's orphan
complete:
- L1 = 4/7, L2 = 1/2, L3 = 1/1, L4 = 1/1, L7 = 0/1, L9 = 1/1, L10 = 0/1.

---

## Tutorial funnel (`tutorial_step`)

`step_id` values present: **ts1, ts2**.

| step_id | distinct users | users |
|---|---|---|
| ts1 | 5 | u1, u3, u4, u8, u11 |
| ts2 | 2 | u1, u4 |

Drop-off ts1 -> ts2: 5 reach ts1, 2 reach ts2.

---

## Ad events (`ad_impression` / `ad_click`)

`ad_network` values present: **admob, unity, applovin, ironsource**.

| ad_network | ad_impression | ad_click |
|---|---|---|
| admob | 1 (u6) | 1 (u6) |
| unity | 1 (u7) | 0 |
| applovin | 1 (u9) | 1 (u9) |
| ironsource | 1 (u12) | 0 |
| **total** | **4** | **2** |

---

## Activity, sessions, retention & stickiness

"Active" = a `session_start` event. There are 22 `session_start` rows across 20
distinct session ids (s1..s20). Each (user, day) below has exactly one session_start
(one session per user per day), so sessions-per-user-per-day = 1 on every active day.

### Distinct active users per day (DAU via session_start)

| day | active users | count |
|---|---|---|
| 2026-01-01 | u1, u2 | 2 |
| 2026-01-02 | u1, u2, u3, u4 | 4 |
| 2026-01-03 | u5 | 1 |
| 2026-01-04 | u3, u6, u7, u8, u9 | 5 |
| 2026-01-05 | u4, u10, u11, u12 | 4 |
| 2026-01-06 | u9, u10 | 2 |
| 2026-01-08 | u1 | 1 |
| 2026-01-09 | u3 | 1 |
| 2026-01-11 | u6 | 1 |
| 2026-01-12 | u12 | 1 |

(Note: u6 installs 2026-01-03 but first `session_start` is 2026-01-04 — first activity
is on day +1, not install day.)

### Per-user activity offsets from install (for N-day retention)

Offset = (active day − install_date) in days, based on `session_start`.

| user | install | active-day offsets |
|---|---|---|
| u1 | 2026-01-01 | 0, 1, 7 |
| u2 | 2026-01-01 | 0, 1 |
| u3 | 2026-01-02 | 0, 2, 7 |
| u4 | 2026-01-02 | 0, 3 |
| u5 | 2026-01-03 | 0 |
| u6 | 2026-01-03 | 1, 8 |
| u7 | 2026-01-04 | 0 |
| u8 | 2026-01-04 | 0 |
| u9 | 2026-01-04 | 0, 2 |
| u10 | 2026-01-05 | 0, 1 |
| u11 | 2026-01-05 | 0 |
| u12 | 2026-01-05 | 0, 7 |

Retention summary (cohort = install_date, "returned within / on offset"):
- **Returned on day +1 exactly:** u1, u2, u10 -> 3 users.
- **Active again on offset +7 exactly:** u1 (1/1), u3 (2/9), u12 (5/12). u6 returns at
  offset +8 (not +7). -> 3 users at exactly +7.
- **Returned within 7 days (offset 1..7):** u1, u2, u3, u4, u9, u10, u12 -> 7 users.
  (u6's only return is +8, just outside the 7-day window — useful for window-cutoff tests.)
- **Never returned after install day (single active day):** u5, u7, u8, u11 -> 4 users.

### Stickiness (DAU/MAU)

All activity falls in the single month 2026-01, so MAU (distinct users with a
`session_start` in 2026-01) = **12** (every user has at least one session_start).
DAU/MAU per day = (active-users-that-day) / 12 using the per-day table above.

---

## Coverage map: which rows exercise which task type

| Taxonomy task | Exercised by |
|---|---|
| 1 active_users_trend | multi-day session_start (10 active days), purchases with revenue for ARPDAU |
| 2 metric_by_user_segment | users across US/GB/DE/BR, ios/android, paid/organic, 3 media_sources, 3 campaigns/channels |
| 3 step_conversion_funnel | level_start->level_complete pairs; tutorial ts1->ts2 drop-off; session_start->purchase |
| 4 nday_retention | 5 install cohorts, offsets incl. exact +1/+7 and +8 (window cutoff), never-returners |
| 5 cohort_retention_grid | cohorts x activity days x revenue, organic/paid + multi-campaign |
| 6 behavioral_cohort | did/didn't purchase (7 vs 5), level_complete (8 vs 4), ad_click (2 vs 10) |
| 7 visit_to_purchase_conversion | all 12 visit; 7 convert; multiple product_ids; same-day & later-day purchases |
| 8 level_progression | levels 1..10, win/lose results, multi-attempt, moves/score populated |
| 9 monetization_metrics | revenue by product/network/channel/country/acq; payers vs non-payers; multi-day LTV |
| 10 stickiness_lifecycle | DAU per day + MAU=12; new installs each day; dormant/resurrected (gaps then return) |
