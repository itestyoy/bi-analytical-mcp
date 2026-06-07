# Events — the foundation of OMG analytics

Almost every analysis starts from the **events fact**: a measure or funnel step is an
`event_name` + a value inside that event's payload. Get the events right and the rest
follows; get the event scope or the payload nesting wrong and the number is wrong.

## Sources of truth
- **Master Events Schema** (single source of truth for ALL custom analytics events across
  OMG projects — global structure, the full event catalogue, per-parameter type/values, and
  per-project applicability): `https://openmygame.atlassian.net/wiki/spaces/PA/pages/2602991642`.
- **Dimensions / Metrics** built on those events: BI & Integration space
  (`https://openmygame.atlassian.net/wiki/spaces/BI`, `[Dimension] …` / `[Metric] …`).
- **QA / validation rules** (authoritative event-quality checks): BI "[BI Agent] Prompt –
  QA Events Check" (`https://openmygame.atlassian.net/wiki/spaces/BI/pages/4797726777`).
  Realtime QA export table: `bi_data_export.qa_export__analytical_events_realtime`.

**Always confirm against the live catalog** — `describe_catalog({ event })` lists the
properties actually populated on an event in THIS deployment; `({ property })` shows a
property's real values + cardinality; `({ search })` finds which event/envelope a field is in.

## Event structure (envelopes)
Every event carries common blocks plus its own fields. Property names are prefixed by block:

| Block | Prefix | What it holds |
| --- | --- | --- |
| `main_data` | `main_data__…` | identifiers (appsflyer_id, appmetrica_id), app info (app_id, bundle_id, app_version), `platform`, timestamps (`device_time_ms`), install attrs, traffic source, time_zone |
| `device_info` | `device_info__…` | device characteristics (e.g. `system_memory_size`, language) |
| `state` | `state_…` | in-game state at emit time (progress, balances, hints, language) |
| `event_data` | `event_data_…` | the event's own parameters |
| `additional_info` | `additional_info…` | extra block, notably ads `network` / `tracking_id` |

**Required on EVERY event:** `event_name`, `main_data__appsflyer_id`,
`main_data__appmetrica_id`, `bundle_id`, `main_data__app_id`, `main_data__platform`.

In this MCP the catalog flattens these to property names (e.g. `*_of_event_data`,
`*_of_additional_info`, `*_of_main_data`). Use `describe_catalog({ search })` to find the
exact flattened name and which envelope a field came from.

## Event catalogue (by domain)
Names from the master schema. Availability differs per project (Fillwords, Word Pizza,
Sky Words, Sudoku Master, Tile Trip, Word Search Sea, Relax Puzzles, Jigsawgram, Word
Spells, …) — verify with `describe_catalog`.

- **Lifecycle / sessions:** `first_launch`, `install` (once on first launch: install_date,
  country, app_version), `new_session` / `end_session` (paired by `session_number`).
  → DAU/MAU, *Cumulative Sessions* / *Session Duration*, `session_number`.
- **Progression (the core funnel):** `level_started` → `level_completed` (result win/lose,
  level id, attempt, score, complete_time); word/puzzle variants `puzzle_started` /
  `puzzle_part_completed` / `puzzle_completed`, `fragment_started/finished`,
  `battle_of_wits_started/finished`; `words_selected` (mistakes_from_previous,
  time_from_previous). → *Game Completion Rate* (completed ÷ started), step funnels,
  difficulty/balance.
- **In-game economy:** `currency_income` / `currency_outcome` (some clients send a single
  `currency` event with `earn`/`spend`). Params: `currency`/`currency_type` (coins,
  hint_lamp, …), amount/`coins`, `source_type`/`monetization_type` (free / coins / ads),
  `source_name`/`place` (screen_final, screen_game, screen_shop, …). → *Resource
  Income/Outcome*, *Resources Balance*, *Resource Return Ratio*. ([currency spec](https://openmygame.atlassian.net/wiki/spaces/JCS/pages/4915429445))
- **Ads:** request→show funnel `ad_requested`, `ad_loaded`, `ad_available`, `ad_blocked`,
  `ad_incident`, `ad_analyzed`, `ad_started`, `ad_finished`, `ad_freezed`, `ad_redirected`.
  Key params: ad type (rewarded/interstitial/banner), `network` (in `additional_info`,
  linked to MAX by `tracking_id`), placement, revenue, is_reward_received, is_clicked.
  Per-level ad LTV: revenue events `lvl_range_revenue` / `puzzle_range_revenue`
  (revenue + currency by level range). → *Non-ATT Ad Impressions/Revenue*, *Ad Network*.
- **IAP:** `shop_opened`, `iap_started`, `iap_purchase_failed`, `iap_purchase_completed`
  (`location` in `event_data` = placement; product_id; price_in_usd; `order_id` (Android) /
  `transaction_id` (iOS) for AppsFlyer reconciliation). → IAP revenue/payers, *Inapp
  Placement*, *Product Category*, subscription sequence.
- **Feature / UI:** `screen_changed`, `tutorial`, `wheel_spin`, `piggy_bank_opened`,
  `event_start` / `event_prize` / `event_end` (in-game live events), etc.

## Event gotchas (wrong-answer modes — read before querying)
- **Event-scoped payload.** An `event_data` property is populated only on the event(s) that
  emit it; on others it's NULL. ALWAYS scope a measure/step to the right `event_name`
  (`describe_catalog({ property })` lists which events carry it). NULL-heavy column ⇒ wrong scope.
- **Envelope nesting.** Don't assume top-level: ad `network` is in `additional_info`,
  IAP `location` is in `event_data`, `time_zone` is in `main_data`, `system_memory_size` in
  `device_info`. Use `{ search }` to locate the block.
- **Banner ads emit only `ad_finished`** — `ad_loaded`/`ad_started`/`ad_clicked` are not
  expected for `ad_type = banner`; don't treat their absence as missing data.
- **Enums are case- and whitespace-exact** (`android` ≠ `Android`, `purchase` ≠ `Purchase`).
  Match values exactly when filtering.
- **NULL semantics.** Empty string `""`, the literal `"null"`, and `"0"` are NOT NULL — a
  field is missing only when it's a true database NULL.
- **Single vs paired events.** `new_session`/`end_session` pair by `session_number`
  (orphans happen); `currency` may be one event with both `earn` and `spend`.
- **Per-project + versioned.** The same event can be implemented, partial, or absent per
  game, and parameters were added over versions (`monetization_type`, `tracking_id`,
  extended `additional_info`). Deprecated params are struck through (`~~…~~`) in the schema.
  Confirm per project with `describe_catalog`, not memory.
- **Reconciliation ≠ in-event values.** IAP ties to AppsFlyer by `order_id`/`transaction_id`;
  ad data to MAX by `tracking_id`; AppsFlyer revenue events (`lvl_range_revenue`) are a
  separate stream. Say which source a revenue number came from.
- **Timestamps.** Prefer `main_data__device_time_ms` if `event_timestamp` has near-zero
  variance; order funnels by the event time axis (`describe_catalog({ model })` → `time`).
- **Grain.** Per-event vs per-player vs per-session — "per Player" metrics
  `count_distinct` the player key; counting event rows over-counts.

## How to work with events in this MCP
1. `describe_catalog()` → event_names; `({ event })` → its properties (+ index hints);
   `({ property })` → real values/cardinality; `({ search })` → map a term/value to its
   event + envelope.
2. Funnels/paths: a `build_native_model` pipeline with a `match_recognize` stage (steps =
   event + `event_data` value), then `get_query_result`.
3. Governed rates/volumes: `create_semantic_model` + `query_semantic_model` (e.g. *Game
   Completion Rate*, DAU, economy metrics) — prefer these over hand-rolled aggregates.
4. Check `describe_index` for whether the value index (real per-property values/cardinality)
   is fresh before relying on sampled values.
