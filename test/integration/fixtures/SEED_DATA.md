# Seed Data — Exact Totals for Test Assertions

This document records the EXACT counts and totals contained in the dbt seed CSVs
under `dbt_project/seeds/`. The numbers below are derived directly from the CSV
files and are intended to be asserted verbatim by integration tests. If you edit
any seed CSV, regenerate this document.

Seed files:
- `dbt_project/seeds/seed_users.csv` -> `dim_users` (role: users)
- `dbt_project/seeds/seed_events.csv` -> `fct_analytics_events` (role: events — the product-analytics events source)
- `dbt_project/seeds/seed_experiments.csv` -> `fct_experiment_assignments` (role: experiments)
- `dbt_project/seeds/seed_crashlytics.csv` -> `fct_crashlytics_events` (role: crashlytics — a
  SECOND events source; see §10)
- `dbt_project/seeds/seed_acquisition.csv` -> `fct_player_acquisition` (role: acquisition — a
  NON-events source with its own measures; see §11)

Vocabulary is restricted to `config/catalog.yml` (events, event_data property
keys, and user attributes). All monetary values are integers. `campaign_id` is a
plain string attribute on `dim_users` (like country/platform) — there is NO
separate campaigns table.

---

## 1. Users (`seed_users.csv`)

12 users (`u1`..`u12`). `app_id` = `com.omg.wordsearch` for all. `app_version` = `1.0` for all.

| user | install_date | platform | os | device | country | region | language | media_source | acquisition_type | campaign |
|------|--------------|----------|----|--------|---------|--------|----------|--------------|------------------|----------|
| u1  | 2026-01-01 | ios     | 17 | iphone | US | NA    | en | meta     | paid    | c1 |
| u2  | 2026-01-01 | android | 14 | pixel  | US | NA    | en | organic  | organic | c2 |
| u3  | 2026-01-02 | ios     | 17 | iphone | GB | EU    | en | meta     | paid    | c1 |
| u4  | 2026-01-02 | android | 13 | galaxy | DE | EU    | de | google   | paid    | c2 |
| u5  | 2026-01-03 | ios     | 16 | iphone | BR | LATAM | pt | organic  | organic | c1 |
| u6  | 2026-01-03 | android | 14 | pixel  | US | NA    | en | applovin | paid    | c3 |
| u7  | 2026-01-04 | ios     | 17 | iphone | GB | EU    | en | applovin | paid    | c3 |
| u8  | 2026-01-04 | android | 13 | galaxy | DE | EU    | de | organic  | organic | c2 |
| u9  | 2026-01-04 | ios     | 16 | iphone | BR | LATAM | pt | meta     | paid    | c1 |
| u10 | 2026-01-05 | android | 14 | pixel  | US | NA    | en | google   | paid    | c2 |
| u11 | 2026-01-05 | ios     | 17 | iphone | GB | EU    | en | organic  | organic | c1 |
| u12 | 2026-01-05 | android | 13 | galaxy | DE | EU    | de | applovin | paid    | c3 |

### User attribute distributions

- platform: ios = 6, android = 6
- country: US = 4, GB = 3, DE = 3, BR = 2
- media_source: meta = 3, organic = 4, google = 2, applovin = 3
- acquisition_type: paid = 8, organic = 4
- campaign_id (plain user attribute on dim_users): c1 = 5, c2 = 4, c3 = 3
- install_date: 2026-01-01 = 2 (u1,u2), 2026-01-02 = 2 (u3,u4),
  2026-01-03 = 2 (u5,u6), 2026-01-04 = 3 (u7,u8,u9), 2026-01-05 = 3 (u10,u11,u12)

---

## 2. Events (`seed_events.csv`)

Total event rows: **184**

### `bundle_id` (app) split

Every event carries a `bundle_id` (the app), marked `meta.mcp.dimension: { bundle: true }`
on the events fact — it drives `semantic_index({ bundle })` per-app coverage. The split is
by event family (row-count neutral — no rows added):

- `com.omg.colorfit` = **53** rows — ONLY `level_started` + `level_completed` (so `level_id_of_event_data`
  is populated, `ad_type_of_event_data` is EMPTY for this app).
- `com.omg.wordsearch` = **131** rows — everything else incl. ad/iap events (so `ad_type_of_event_data`
  is populated, `level_id_of_event_data` is EMPTY for this app).

### Row counts per `event_name`

| event_name             | count |
|------------------------|-------|
| first_launch           | 12    |
| new_session            | 21    |
| end_session            | 21    |
| level_started          | 28    |
| level_completed        | 25    |
| currency_income        | 8     |
| currency_outcome       | 5     |
| shop_opened            | 10    |
| iap_purchase_completed | 8     |
| iap_purchase_failed    | 3     |
| ad_started             | 12    |
| ad_finished            | 12    |
| tutorial               | 16    |
| screen_changed         | 3     |
| **TOTAL**              | **184** |

---

## 3. IAP / Monetization

`iap_purchase_completed`: 8 rows. `iap_purchase_failed`: 3 rows. `shop_opened`: 10 rows.
Product prices (integer USD): p1 = 5, p2 = 10, p3 = 20. currency = `USD`, status = `success`.

### Completed purchases

| order_id | user | product | price_usd |
|----------|------|---------|-----------|
| o1 | u1  | p1 | 5  |
| o2 | u1  | p2 | 10 |
| o3 | u3  | p1 | 5  |
| o4 | u5  | p3 | 20 |
| o5 | u7  | p2 | 10 |
| o6 | u9  | p1 | 5  |
| o7 | u10 | p3 | 20 |
| o8 | u11 | p2 | 10 |

- **Total IAP revenue = 85 USD**
- Revenue by acquisition_type: paid = 55, organic = 30
- Revenue by country: US = 35, GB = 25, BR = 25  (DE = 0)
- Revenue by product: p1 = 15, p2 = 30, p3 = 40
- **Distinct payers = 7**: u1, u3, u5, u7, u9, u10, u11  (u1 purchased twice)
- Purchase count (completed) = 8

### Failed purchases (`iap_purchase_failed`, status = `failed`)

| order_id | user | product | price_usd |
|----------|------|---------|-----------|
| of1 | u2 | p1 | 5  |
| of2 | u4 | p2 | 10 |
| of3 | u1 | p3 | 20 |

---

## 4. Levels Funnel

level_id range 1..10. `level_completed` carries `result` (win/lose),
`complete_time` (int sec), `attempt` (int).

- Total `level_started` = 28
- Total `level_completed` = 25
- Total wins = 20  (losses = 5)

### Per-level counts

| level_id | started | completed | wins |
|----------|---------|-----------|------|
| 1  | 12 | 12 | 12 |
| 2  | 6  | 4  | 2  |
| 3  | 3  | 3  | 2  |
| 4  | 1  | 1  | 1  |
| 5  | 1  | 1  | 0  |
| 6  | 1  | 0  | 0  |
| 7  | 1  | 1  | 1  |
| 8  | 1  | 1  | 1  |
| 9  | 1  | 1  | 0  |
| 10 | 1  | 1  | 1  |
| **TOTAL** | **28** | **25** | **20** |

Funnel note: started (28) > completed (25). Level 1 is fully completed by all 12
users (12/12 win). Level 6 has 1 start and 0 completions (drop-off).

---

## 5. Ads

`ad_started`: 12 rows. `ad_finished`: 12 rows (one finish per start).
ad_type in {rewarded, interstitial, banner}; placement in {store, level_fail, main_menu};
ad_network in {admob, unity, applovin, ironsource}. `ad_finished.revenue` is integer cents,
plus `is_reward_received` and `is_clicked`.

### ad_finished rows

| user | ad_type      | placement  | network    | revenue_cents | reward | clicked |
|------|--------------|------------|------------|---------------|--------|---------|
| u1  | rewarded     | level_fail | admob      | 3 | true  | false |
| u1  | interstitial | main_menu  | unity      | 2 | false | true  |
| u2  | banner       | main_menu  | applovin   | 1 | false | false |
| u3  | rewarded     | store      | ironsource | 4 | true  | true  |
| u4  | interstitial | level_fail | admob      | 2 | false | false |
| u5  | rewarded     | level_fail | unity      | 3 | true  | false |
| u6  | banner       | main_menu  | applovin   | 1 | false | false |
| u7  | rewarded     | store      | admob      | 5 | true  | true  |
| u8  | interstitial | main_menu  | ironsource | 2 | false | false |
| u9  | rewarded     | level_fail | unity      | 3 | true  | false |
| u10 | banner       | main_menu  | applovin   | 1 | false | false |
| u11 | interstitial | store      | admob      | 2 | false | true  |

- **Total ad revenue = 29 cents**
- By network: admob = 12, unity = 8, ironsource = 6, applovin = 3

---

## 6. Currency

currency = `coins`. `amount` and `value_in_coins` are equal integers per row.

### currency_income (8 rows)

| user | source_type  | source_name    | amount |
|------|--------------|----------------|--------|
| u1 | level_reward | level_complete | 100 |
| u1 | level_reward | level_complete | 100 |
| u2 | level_reward | level_complete | 50  |
| u3 | level_reward | level_complete | 100 |
| u3 | daily_bonus  | login          | 25  |
| u5 | level_reward | level_complete | 75  |
| u7 | ad_reward    | rewarded_ad    | 30  |
| u9 | ad_reward    | rewarded_ad    | 30  |

- **Total coins in = 510**

### currency_outcome (5 rows)

| user | source_type   | source_name | amount |
|------|---------------|-------------|--------|
| u1 | hint_spend    | gameplay | 20 |
| u1 | hint_spend    | gameplay | 20 |
| u3 | hint_spend    | gameplay | 40 |
| u5 | powerup_spend | gameplay | 50 |
| u7 | hint_spend    | gameplay | 10 |

- **Total coins out = 140**
- Net coins = 510 - 140 = 370

---

## 7. Tutorial Drop-off

`tutorial` carries `step_id` in {step_1, step_2, step_3}. Total tutorial rows = 16.

| step_id | distinct users | users |
|---------|----------------|-------|
| step_1 | 8 | u1, u2, u3, u4, u5, u6, u7, u8 |
| step_2 | 5 | u1, u2, u3, u4, u5 |
| step_3 | 3 | u1, u2, u3 |

Each user appears once per step they reached, so row count = 8 + 5 + 3 = 16.

---

## 8. Screen Changes

`screen_changed`: 3 rows, with `screen_from` / `screen_to`.

| user | screen_from | screen_to |
|------|-------------|-----------|
| u1 | main_menu | shop     |
| u3 | main_menu | levels   |
| u5 | levels    | gameplay |

---

## 9. Sessions / Retention / DAU / MAU

`new_session` events drive activity. Each new_session is paired with an
`end_session` on the same day, so end_session counts equal new_session counts (21 each).

### new_session days per user (offset = days since install)

| user | install    | session day offsets |
|------|------------|---------------------|
| u1  | 2026-01-01 | 0, 1, 4, 7 |
| u2  | 2026-01-01 | 0, 7       |
| u3  | 2026-01-02 | 0, 1, 7    |
| u4  | 2026-01-02 | 0, 3       |
| u5  | 2026-01-03 | 0, 1       |
| u6  | 2026-01-03 | 0          |
| u7  | 2026-01-04 | 0, 1       |
| u8  | 2026-01-04 | 0          |
| u9  | 2026-01-04 | 0          |
| u10 | 2026-01-05 | 0          |
| u11 | 2026-01-05 | 0          |
| u12 | 2026-01-05 | 0          |

### Retention return sets

- **D1 returners (offset 1) = {u1, u3, u5, u7}** -> 4 users
- **D7 returners (offset 7) = {u1, u2, u3}** -> 3 users
- Never-returners (only install-day session, offset {0}) = {u6, u8, u9, u10, u11, u12} -> 6 users

### DAU per day

DAU computed as distinct users with a `new_session` on that day (identical to
distinct users with any event on that day in this dataset).

| date       | DAU | users |
|------------|-----|-------|
| 2026-01-01 | 2 | u1, u2 |
| 2026-01-02 | 3 | u1, u3, u4 |
| 2026-01-03 | 3 | u3, u5, u6 |
| 2026-01-04 | 4 | u5, u7, u8, u9 |
| 2026-01-05 | 6 | u1, u4, u7, u10, u11, u12 |
| 2026-01-08 | 2 | u1, u2 |
| 2026-01-09 | 1 | u3 |

- **MAU (Jan 2026) = 12** (all users have at least one event in January 2026)
- Stickiness reference: mean DAU over the 7 active days = (2+3+3+4+6+2+1)/7 = 21/7 = 3;
  DAU/MAU on peak day (2026-01-05) = 6/12 = 0.50.

---

## 10. Crash reports (`seed_crashlytics.csv`) — the SECOND events source

`dbt_project/seeds/seed_crashlytics.csv` -> `fct_crashlytics_events` (`role: crashlytics`).
A separate events fact with its OWN event vocabulary (`fatal_crash` / `non_fatal` / `anr`)
and its OWN event-scoped payload — nothing is shared with `fct_analytics_events`. Joined to
`dim_users` on `player_id_of_internal`, so the same user attributes segment it.

| id | player | event_name | event_time | issue_title | is_fatal | anr_duration | crash_message | app_version | device_model |
|----|--------|------------|------------|-------------|----------|--------------|---------------|-------------|--------------|
| k1  | u1 | fatal_crash | 2026-01-05 10:00 | NullPointer       | true  |      | npe at level | 1.0.0 | iphone |
| k2  | u1 | fatal_crash | 2026-01-05 11:00 | NullPointer       | true  |      | npe at level | 1.0.0 | iphone |
| k3  | u1 | fatal_crash | 2026-01-06 10:00 | OutOfMemory       | true  |      | oom          | 1.0.0 | iphone |
| k4  | u2 | fatal_crash | 2026-01-05 12:00 | NullPointer       | true  |      | npe at shop  | 1.0.0 | pixel  |
| k5  | u2 | fatal_crash | 2026-01-07 09:00 | NullPointer       | true  |      | npe at shop  | 1.1.0 | pixel  |
| k6  | u3 | fatal_crash | 2026-01-06 15:00 | OutOfMemory       | true  |      | oom          | 1.1.0 | iphone |
| k7  | u4 | non_fatal   | 2026-01-05 09:00 | NetworkTimeout    | false |      |              | 1.0.0 | galaxy |
| k8  | u4 | non_fatal   | 2026-01-06 09:00 | NetworkTimeout    | false |      |              | 1.0.0 | galaxy |
| k9  | u5 | non_fatal   | 2026-01-06 12:00 | NetworkTimeout    | false |      |              | 1.1.0 | iphone |
| k10 | u1 | non_fatal   | 2026-01-07 08:00 | DecodeError       | false |      |              | 1.1.0 | iphone |
| k11 | u6 | anr         | 2026-01-05 14:00 | MainThreadBlocked |       | 5.5  |              | 1.0.0 | pixel  |
| k12 | u6 | anr         | 2026-01-08 14:00 | MainThreadBlocked |       | 8.0  |              | 1.1.0 | pixel  |
| k13 | u7 | anr         | 2026-01-08 16:00 | MainThreadBlocked |       | 12.5 |              | 1.1.0 | iphone |

Total crash rows: **13**

### Row counts per `event_name`

| event_name  | count |
|-------------|-------|
| fatal_crash | 6     |
| non_fatal   | 4     |
| anr         | 3     |
| **TOTAL**   | **13** |

### Event-scoped payload (the reason this fact needs the full events machinery)

Each payload column carries a value ONLY on the events in its `meta.mcp.events` list and is
NULL elsewhere — exactly like the analytics fact:

- `issue_title_of_event_data` — all 3 events, non-null on **13** rows.
  Distribution: NullPointer 4, OutOfMemory 2, NetworkTimeout 3, DecodeError 1, MainThreadBlocked 3.
- `is_fatal_of_event_data` — `fatal_crash` + `non_fatal` only: non-null on **10** rows, NULL on the 3 `anr` rows.
- `anr_duration_of_event_data` — `anr` ONLY: non-null on **3** rows, NULL on the other 10.
  Sum = **26.0** seconds (5.5 + 8.0 + 12.5), mean = 26/3 ≈ 8.6667.
- `crash_message_of_event_data` — `fatal_crash` ONLY: non-null on **6** rows.
- `breadcrumbs_of_event_data` — a COMPLEX (JSON array of strings) property, all 3 events.
  **20** elements across the 13 rows; exploded with an `unnest` stage they count:
  level_start 4, net_retry 4, ui_freeze 3, gc_pause 3, ad_shown 2, shop_open 2,
  iap_start 1, decode 1. Per row: k1 [level_start, ad_shown], k2 [level_start],
  k3 [shop_open, iap_start], k4 [level_start, ad_shown], k5 [shop_open], k6 [level_start],
  k7 [net_retry], k8 [net_retry, net_retry], k9 [net_retry], k10 [decode],
  k11 [ui_freeze, gc_pause], k12 [ui_freeze], k13 [gc_pause, ui_freeze, gc_pause].

### Aggregates asserted by the tests

- `fatal_crash` = **6** rows from **3** distinct players (u1×3, u2×2, u3×1).
- Fatal crashes by `issue_title`: NullPointer = **4**, OutOfMemory = **2**.
- Fatal crashes by `user__country` (join to `dim_users`; u1,u2 = US, u3 = GB): US = **5**, GB = **1**.
- All 13 rows by `app_version`: `1.0.0` = **7**, `1.1.0` = **6**.
- All 13 rows by `device_model`: iphone = **7**, pixel = **4**, galaxy = **2**.
- Repeated-crash funnel (`fatal_crash` -> `fatal_crash`, partitioned by player):
  **3** players crashed at all, **2** of them (u1, u2) reached a second crash.
- Cross-fact, one query: `first_launch` on the analytics fact = **12** (§2) alongside
  `fatal_crash` on this fact = **6**.

`app_version` is written as a three-part version string (`1.0.0`, not `1.0`) so the seed
loader keeps it TEXT — a two-part value is coerced to a number and comes back as `1`.

---

## 11. Acquisition spend (`seed_acquisition.csv`) — a NON-events source with measures

`dbt_project/seeds/seed_acquisition.csv` -> `fct_player_acquisition` (`role: acquisition`).
One row per (player, day). It has no `event_name`, so it is not an events source — but it has
its own TIME AXIS (`spend_date`) and its own MEASURES, all declared in `meta.mcp`, and it joins
to `dim_users` / the events sources on `player_id_of_internal`.

| id | player | day | media_source | campaign | cost | impressions | clicks |
|----|--------|-----|--------------|----------|------|-------------|--------|
| a1  | u1  | 2026-01-01 | meta     | winter_promo | 1.50 | 100 | 5  |
| a2  | u2  | 2026-01-01 | organic  | none         | 0.00 | 0   | 0  |
| a3  | u3  | 2026-01-02 | meta     | winter_promo | 2.00 | 150 | 8  |
| a4  | u4  | 2026-01-02 | google   | search_brand | 1.25 | 120 | 6  |
| a5  | u5  | 2026-01-03 | organic  | none         | 0.00 | 0   | 0  |
| a6  | u6  | 2026-01-03 | applovin | ua_scale     | 3.00 | 200 | 10 |
| a7  | u1  | 2026-01-03 | meta     | winter_promo | 0.50 | 40  | 2  |
| a8  | u7  | 2026-01-04 | applovin | ua_scale     | 2.50 | 180 | 9  |
| a9  | u8  | 2026-01-04 | organic  | none         | 0.00 | 0   | 0  |
| a10 | u9  | 2026-01-04 | meta     | winter_promo | 1.75 | 140 | 7  |
| a11 | u10 | 2026-01-05 | google   | search_brand | 2.25 | 160 | 8  |
| a12 | u11 | 2026-01-05 | organic  | none         | 0.00 | 0   | 0  |
| a13 | u12 | 2026-01-05 | applovin | ua_scale     | 2.75 | 190 | 9  |

Total rows: **13**. **u1 appears twice** (2026-01-01 and 2026-01-03) — that is what makes the
grain (player, day) rather than player, and what a single-key join fans out on.

### Amounts (MARKED in the catalog; the aggregation is the caller's choice)

The schema marks `cost`, `impressions` and `clicks` aggregatable, plus the model-level
expression `cost_per_click = cost / nullif(clicks, 0)`. No aggregation is fixed anywhere —
these are the values a task gets by asking for one:

| field | agg the task chose | value over all 13 rows |
|---|---|---|
| `cost` | `sum` | **17.50** |
| `impressions` | `sum` | **1280** |
| `clicks` | `sum` | **64** |
| `cost` | `max` | **3.00** |
| `cost` | `average` | **17.50 / 13** |
| `cost` | `percentile 0.9` | **2.70** (percentile_cont interpolates 2.50→2.75) |
| `cost_per_click` | `average` | mean over the **9** rows that have clicks (4 organic rows are NULL) |

- CPC as a ratio metric (`sum(cost) / sum(clicks)`) = 17.50 / 64 = **0.2734375**
- cost by `media_source`: meta **5.75**, applovin **8.25**, google **3.50**, organic **0**
- cost by `user__country` (join to `dim_users`): US **7.25**, GB **4.50**, DE **4.00**, BR **1.75**
- cost by day (`metric_time`): 01-01 **1.50**, 01-02 **3.25**, 01-03 **3.50**, 01-04 **4.25**, 01-05 **5.00**

### Schema opt-outs exercised here

- `campaign_id` — groupable, but `meta.mcp.index: false`: it is NOT a value-index target
  (the indexer's targets for this source are exactly `media_source` and `campaign`).
- `ingest_batch_id` — `meta.mcp.dimension: false`: not an attribute, still a real column a
  pipeline can read (grouping a pipeline by it yields all **13** rows, one per batch).
- The three measure columns are neither attributes nor value-index targets.

### Composite join key

Joining the 12 `first_launch` events to this table on `player_id_of_internal` **+ the day**
yields **12** rows (one cost row per event); joining on the player alone yields **13**, because
u1's event matches both of u1's spend days. That difference is the fan-out a composite key
prevents.

---

## 12. Declared join keys (`tracking_id`) — the relationships the schema sanctions

Two relationships are declared in `fixtures/catalog.yml` under `meta.mcp.entities`, and both
paths — metric queries and pipeline joins — use them without ever restating a column.

| relationship | key | owner (the join target) | declared foreign on |
|---|---|---|---|
| `player_day` | player + the DAY of that source's time column | `fct_player_acquisition` (one row per pair) | the two events sources, `dim_users` (on its install day) |
| `tracked_install` | `tracking_id` + player | `dim_users` (one install record per pair) | the two events sources |

### `tracking_id` in the seeds

Every player's install record carries one canonical track: `u<N>` -> `t<N>`. Two places carry a
**stale** track (`t_stale`) that is on no install record — a re-attributed / mis-reported track:

- all **7** events of `u12` in `seed_events.csv` (whose install record has `t12`);
- crash **k13** (player `u7`) in `seed_crashlytics.csv`.

That is what makes a composite-key join provably different from a join on the player alone.

### Key VARIANTS: one tracking column per ad format on the crash source

`fct_crashlytics_events` also carries `rewarded_tracking_id`, `interstitial_tracking_id` and
`banner_tracking_id`; only the one for the format in play is populated, and it holds the same
value as that row's `tracking_id`. They are declared as `variants` of one relationship
`tracked_ad`, which expands to `tracked_ad_rewarded` / `_interstitial` / `_banner` — the caller
picks. `dim_users` OWNS the key and declares its single `tracking_id` column once, for all three.

| rows | variant | crashes matched to an install record |
|---|---|---|
| k1..k5 | `tracked_ad_rewarded` | **5** (u1 x3 US, u2 x2 US) |
| k6..k9 | `tracked_ad_interstitial` | **4** (u3 GB, u4 x2 DE, u5 BR) |
| k10..k13 | `tracked_ad_banner` | **3** (u1 US, u6 x2 US) — k13's track is stale |

### Numbers these produce

| join | on the declared key | on the player alone |
|---|---|---|
| crash reports x analytics events (`tracked_install`, inner) | **266** | **282** (k13 pulls in all 16 of u7's events) |
| analytics events x installs (`tracked_install`, inner) | **177** | **184** (u12's 7 events) |
| analytics events x acquisition (`player_day`, inner) | **150** | **220** (u1's events x both spend days) |
| crash reports x acquisition (`player_day`, inner) | **0** — no crash is on a spend day | **17** |
| installs x acquisition (`player_day`, inner) | **12** — one spend row per install | — |
| acquisition x installs (`user`, inner) | **13** — every spend row has a player | — |

In the semantic layer the same keys give:

- events counted by `player_day__media_source`: meta **47**, organic **50**, applovin **30**,
  google **23**, NULL **34** (a day with no spend row) — **184** in total, no fan-out.
- crash reports by `tracked_install__country`: US **8**, DE **2**, GB **1**, BR **1**, NULL **1**
  (k13's stale track); by `user__country` the same 13 reports give GB **2** and no NULL.
- installs by `player_day__media_source`: meta **3**, organic **4**, google **2**, applovin **3**
  — **12**, one spend row each.

---

## Notes for test authors

- All `event_data` values are valid JSON objects; inner double quotes are
  CSV-escaped by doubling. Empty payloads (`first_launch`) are `{}`.
- `appsflyer_id` joins events to users. `campaign_id` is a plain string attribute
  on `dim_users` (no separate campaigns table).
- All monetary fields are integers: `price_in_usd` (whole USD),
  `ad_finished.revenue` (cents), `amount` / `value_in_coins` (coins).
- `session_number` is a per-user integer (1..n) and is reused across event types
  within the same session.
