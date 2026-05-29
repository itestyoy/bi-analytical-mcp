# Seed Data — Exact Totals for Test Assertions

This document records the EXACT counts and totals contained in the dbt seed CSVs
under `dbt_project/seeds/`. The numbers below are derived directly from the CSV
files and are intended to be asserted verbatim by integration tests. If you edit
any seed CSV, regenerate this document.

Seed files:
- `dbt_project/seeds/seed_campaigns.csv` -> `dim_campaigns`
- `dbt_project/seeds/seed_users.csv` -> `dim_users`
- `dbt_project/seeds/seed_events.csv` -> `fct_analytics_events`

Vocabulary is restricted to `config/catalog.json` (events, event_data property
keys, and user/campaign attributes). All monetary values are integers.

---

## 1. Campaigns (`seed_campaigns.csv`)

3 campaigns.

| campaign_id | channel | network  | cost_model |
|-------------|---------|----------|------------|
| c1          | social  | meta     | cpi        |
| c2          | search  | google   | cpc        |
| c3          | video   | applovin | cpm        |

---

## 2. Users (`seed_users.csv`)

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
- campaign_id: c1 = 5, c2 = 4, c3 = 3
- install_date: 2026-01-01 = 2 (u1,u2), 2026-01-02 = 2 (u3,u4),
  2026-01-03 = 2 (u5,u6), 2026-01-04 = 3 (u7,u8,u9), 2026-01-05 = 3 (u10,u11,u12)

### Campaign -> channel mapping (via user.campaign_id join to dim_campaigns)

- c1 (social/meta/cpi): u1, u3, u5, u9, u11
- c2 (search/google/cpc): u2, u4, u8, u10
- c3 (video/applovin/cpm): u6, u7, u12

---

## 3. Events (`seed_events.csv`)

Total event rows: **184**

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

## 4. IAP / Monetization

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

## 5. Levels Funnel

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

## 6. Ads

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

## 7. Currency

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

## 8. Tutorial Drop-off

`tutorial` carries `step_id` in {step_1, step_2, step_3}. Total tutorial rows = 16.

| step_id | distinct users | users |
|---------|----------------|-------|
| step_1 | 8 | u1, u2, u3, u4, u5, u6, u7, u8 |
| step_2 | 5 | u1, u2, u3, u4, u5 |
| step_3 | 3 | u1, u2, u3 |

Each user appears once per step they reached, so row count = 8 + 5 + 3 = 16.

---

## 9. Screen Changes

`screen_changed`: 3 rows, with `screen_from` / `screen_to`.

| user | screen_from | screen_to |
|------|-------------|-----------|
| u1 | main_menu | shop     |
| u3 | main_menu | levels   |
| u5 | levels    | gameplay |

---

## 10. Sessions / Retention / DAU / MAU

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

## Notes for test authors

- All `event_data` values are valid JSON objects; inner double quotes are
  CSV-escaped by doubling. Empty payloads (`first_launch`) are `{}`.
- `appsflyer_id` joins events to users; `campaign_id` joins users to campaigns.
- All monetary fields are integers: `price_in_usd` (whole USD),
  `ad_finished.revenue` (cents), `amount` / `value_in_coins` (coins).
- `session_number` is a per-user integer (1..n) and is reused across event types
  within the same session.
