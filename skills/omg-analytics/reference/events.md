# Events — meaning, trigger, parameters

The events fact is the basis of every analysis. This page documents WHAT each event means,
WHEN it fires, and its PARAMETERS. **Source of truth:** the master "Кастомные аналитические
события (с девайса игрока)" schema — `https://openmygame.atlassian.net/wiki/spaces/PA/pages/2602991642`
(global structure, full catalogue, per-parameter type/values, per-project applicability,
and version history). QA rules + realtime export: `BI/4797726777`
(`bi_data_export.qa_export__analytical_events_realtime`).

> Availability and parameters differ **per project** and **per event version** — always
> confirm against the live catalog: `describe_catalog({ event })` lists the properties
> actually populated on an event here; `({ property })` shows real values + cardinality;
> `({ search })` finds which event/envelope a field lives in. The names below are the
> business fields; this MCP exposes them flattened (e.g. `*_of_event_data`, `*_of_main_data`,
> `*_of_additional_info`).

## Global blocks (every event carries these)
Property names are prefixed by block: `main_data__…`, `device_info__…`, `state_…`,
`event_data_…`, plus the `additional_info` JSON (mainly ads).

**`main_data`** — common metadata on every event. Key params:
- identity: `appsflyer_id`, `appmetrica_id`, `app_id` (`fillwords` `relax_puzzles` `sky_words`
  `tile_trip` `word_pizza` `word_search_sea` `word_spells`), `event_id`, `firestore_id`
- app/build: `build_version` (e.g. `4.18.9`), `build_number`, `client_version`, `platform`
  (lowercase `android`/`ios`)
- geo/locale: `country` (ISO-3166 alpha-2 uppercase, e.g. `BY`), `time_zone` (`±hh:mm`)
- time: `device_time` (client-local UNIX), `server_time` (server-side, NOT from client),
  `first_launch` (UNIX, first launch)
- counters: `session_number`, `active_day` (n-th unique calendar day of activity), `playtime`
  (total seconds incl. ads)
- install attrs (NO separate `install` event — install lives here): `install_build_version`
  (**new players only**), `install_build_number`, `install_package` (**Android only**, empty
  on iOS, `undefined` if dev/unknown), `is_valid_install` (= `install_package` ==
  `com.android.vending`), `media_source` (Appsflyer traffic source, server-set)
- misc: `ab_test_group`, `is_test`, `chosen_skill_level` (Sudoku: `not_assigned`/`novice`/
  `intermediate`/`expert`)

**`device_info`** — `device_model`, `os_version`, `cpu_type`, `gpu`, `system_memory_size`
(MB), `graphics_memory_size` (MB), `resolution`.

**`state`** — player state at emit time (only sent if the entity exists in the project):
`coins_balance`, `language` (IETF lowercase: `de en es fr it kr ru pt-br pt-pt`),
`level_number` (last **started** main-progression level — **starts at 0**, legacy),
`level_fragment`, `puzzles_completed`, `skill_points`, `relax_level`, `active_segments`, and
the hint-balance family (`hint_open_first_letter_balance`, `hint_open_any_letter_balance`,
`hint_open_several_letters_balance`, `auto_openers_balance`, `hint_open_cell_balance`,
`hint_shuffle_balance`, `hint_cancel_balance`, `hint_magnet_balance`, `hint_extra_slot_balance`).

**`event_data`** — the event's own params (below). Also `event_name`, and `event_version`
(absent for an event's first iteration; otherwise a counter from 1 — watch versioned param
additions).

**Required on EVERY event:** `event_name`, `main_data__appsflyer_id`,
`main_data__appmetrica_id`, `bundle_id`, `main_data__app_id`, `main_data__platform`.

---
## Activity / sessions
- **`first_launch`** — very first launch; **no params**. Fires once per player **before the
  SDK loads**, and **re-fires on reinstall** (the client can't tell install from reinstall).
- **`new_session`** — start of a session. On first launch both `first_launch` and
  `new_session` fire. Param `state`: `default` (fresh launch) / `background` (resumed).
  Sent only if the app was backgrounded **≥ 10 min**.
- **`end_session`** — end of a session. Param `session_duration` (seconds, **must include ad
  views**). Sent before the next session if the app was closed > 10 min.

## Levels / puzzles / games (the core funnel)
Dual numbering: `state.level_number` = last started main-progression level; other chains use
the event params `chain` + `chain_level_number`. `chain=common` (main) numbers from **0**;
other chains from 1.

- **`level_started`** — opening/re-opening any level (auto-open at session start counts and
  bumps `open_number`). Key params: `chain` (`common`/`daily`/`repeated`),
  `chain_level_number`, `level_id`, `open_number` (which open, resets per playthrough),
  `start_number` (which attempt), `method` (`free`/`ad`/`coins` — only where launch varies),
  `mechanics`, `pattern`, `total_words`, `level_size`, `active_event`/`active_quest`/
  `event_objects` (omitted if none), `line_levels_id`.
- **`level_completed`** — completion of any level (last word / last tiles). `result`
  (`win`/`lose`/`exit`), `complete_time` (clean seconds, excludes ads/fade), hint-usage
  counters (`hint_open_first_letter_used`, `hint_open_any_letter_used`,
  `hint_open_several_letters_used`, `auto_openers_used`, `hints_for_ad_used`,
  `hints_shuffle_used`, `hints_cancel_used`, `hints_magnet_used`, `hints_extra_slot_used`),
  word tallies (`main_words_found`, `additional_words_found`, `bonus_words_found`,
  `wrong_words_found`), `daily_level_score` (daily only), `continue_by_ad`/`continue_by_coin`,
  `combo_points_earned`, `level_skip`, plus the `level_started` identity params and the
  `words_selected` array (see below). SW "test mode" adds resource fields
  (`resource_start`/`resource_left`/`resource_added_ad`/`resource_added_coin`/
  `resource_loss_type`, `loss_condition`, `words_left`).
- **`fragment_started` / `fragment_finished`** — sublevel start/finish (Fillwords, WSS; some
  Tile Trip/WP). `fragment_finished` carries `complete_time`, hint counters, `result`
  (Tile Trip), `tiles_count`/`tiles_left`, word tallies, and the `words_selected` array. If
  it's the last sublevel and passed, `fragment_finished` then `level_completed` fire in order.
- **`words_selected`** (array on level/fragment_finished) — one object per collected word:
  `{ word_number, word_name, time_from_previous, mistakes_from_previous, word_dictionary }`
  (`word_dictionary` ∈ `main`/`additional`, only where dictionaries are mixed).
- **`word_selected`** — per-word event (Word Spells, level 0 of main chain only): `word_name`,
  `word_number`, `time_from_previous`, `word_dictionary` (`main`/`already_found`/`wrong`),
  `chain`, `chain_level_number`, `level_id`, `pattern`.
- **`puzzle_started` / `puzzle_part_completed` / `puzzle_completed`** — Relax Puzzles,
  Jigsawgram, Sudoku Master. Params: `complete_time`, `open_number`, `start_number`,
  `result` (Sudoku `win`/`restart`/`new_game`; `mistakes_count`, `hint_open_cell_used`,
  `difficulty`, `game_mode` `common`/`daily`), and Relax puzzle details (`parts_count`,
  `part_number`, `puzzle_class`, `puzzle_number`, `puzzle_pack`, `puzzle_size`,
  `reward_coins`, `reward_relax`, `rotate`).
- **`battle_of_wits_started` / `battle_of_wits_finished`** — Fillwords. `opponent_type`
  (`bot`/`real_opponent`), `bot_level`, `player_rating`, `cup_difference` (real opponents
  only), `time_to_match` (ms), `result` (`win`/`lose`), `score`, `complete_time`,
  `chain_level_number` (battle #), `total_words`, `level_size`, `method`.

## In-game events
- **`event_start`** — `event_name`, `event_number` (player's n-th run of this event),
  `event_duration` (hours).
- **`event_prize`** — `event_name`, `event_number`, `prize_number`.
- **`event_end`** — `event_name`, `event_number`, `goals_completed`, `result`
  (`completed` / `place_#` / `timeout`).

## Economy
- **`currency_income`** — resource gain (also fires at game start for any positive balance).
  Params: `amount`, `currency` (resource name), `monetization_type` (`free`/`rewarded`/`iap`),
  `source_type`, `source_name`, `value_in_coins` (coin value for soft/hints/auto-openers,
  else 0). **v0** has no `monetization_type`; **v1** adds it.
- **`currency_outcome`** — resource spend (balance decreases). Same params, where
  `source_type`/`source_name` = the spend point. Same v0/v1 versioning.

## Ads
Chain (tied by `tracking_id`): `ad_requested` → `ad_loaded` → `ad_started` → `ad_finished`,
with AppHarbr quality events `ad_analyzed` / `ad_incident` / `ad_blocked` in between, plus
`ad_available`, `ad_freezed`, `ad_redirected`. `additional_info` (JSON, lowercase keys)
carries `ad_unit`, `network`, `creative_id`, `test_name`, `waterfall_name`,
`waterfall_latency` (ms), and on `ad_loaded` the failure codes. There is **no `ad_clicked`
event** — clicks are the `is_clicked` flag on `ad_finished`. Ad LTV-by-level lives in
separate AppsFlyer/Firebase revenue events (game-specific), not in this client schema.

- **`ad_requested`** — load request to AppLovin (1:1 with `ad_loaded`). `ad_type`
  (`interstitial`/`rewarded`), `tracking_id`, `additional_info.ad_unit`.
- **`ad_loaded`** — load result. `status` (`success`/`failure`/`expired`), `revenue` (0 on
  failure), `ad_type`, `tracking_id`, `additional_info` (creative_id/network on success;
  max_code/network_code on failure). **Not sent for banners.**
- **`ad_available`** — availability on the button (`status` `ready`/`no_advertise`/
  `no_internet`), `placement`. Only rewarded + interstitials that replace unloaded rewarded.
- **`ad_started`** — start of display (interstitial/rewarded only). `ad_type`, `tracking_id`,
  `placement`, `revenue` (USD), `substitution_reason` (`higher_cost`/`no_fill`, when an
  interstitial replaces a rewarded), `additional_info`. **v0** sent at view end without
  `revenue`/`tracking_id`; **v1** adds them; **v2** adds `substitution_reason`.
- **`ad_finished`** — end of view (success or not); `ad_type` here also allows **`banner`**.
  `status` (`success`/`display_failed`/`crash`), `revenue` (0 if failed), `placement`,
  `display_duration` (s from start), `start_watch_time` (UNIX), `is_clicked`,
  `is_reward_received`, `is_user_returned` (the three are **always False for banners** /
  next-session returns), `crash_info`, `substitution_reason`, `tracking_id`,
  `additional_info` (incl. `network`). Network analyses use `additional_info.network`
  (linked to Applovin MAX by `tracking_id`).
- **`ad_blocked` / `ad_incident` / `ad_analyzed`** — AppHarbr ad-quality (block / report /
  cleared). `additional_info` adds `step` (`load`/`ready`/`show`), `block_reasons`,
  `report_reasons`, `analyze_results`. (WSS, from v5.12.)
- **`ad_freezed`** — forced close of a stuck ad (reward still granted). `placement`,
  `is_reward_received`. (Fillwords, Word Pizza.)
- **`ad_redirected`** — banner redirect/minimize at end of show. `ad_type` (`banner`),
  `tracking_id`, `is_clicked`, `additional_info`.

## IAP
- **`shop_opened`** — shop opened. `location_from` (`button_on_main_screen`,
  `upper_panel_on_level`, `upper_panel_on_main_screen`, … per project), `with_elements`.
- **`iap_started`** — buy initiated (not yet confirmed). `product_id` (**without the
  `com.openmygame.…` bundle prefix**, e.g. `bundle.goldfish`), `location` (`main_shop` or a
  dialog id), `price_in_usd`, `price_in_currency`, `currency` (ISO-4217 uppercase, e.g.
  `BYN`), `discount` (%).
- **`iap_purchase_failed`** — same params + `reason`.
- **`iap_purchase_completed`** — validated purchase. Adds `order_id` (Android) /
  `transaction_id` (iOS) — the AppsFlyer **reconciliation keys**. (`tracking_id` is the
  *ad* chain key, NOT IAP.)

## Mechanics / UI
- **`piggy_bank_opened`** — `coins_in_bank`, `coins_limit`, `method` (`ad`/`iap`),
  `purchase_number`.
- **`tutorial`** — `action` (`show`/`close`), `chain` (which tutorial), `element`.
- **`wheel_spin`** — `method` (`ad`/`free`), `reward_item`, `reward_amount`, `spin_number`.
- **`progress_restored`** — restored from firestore: `previous_appsflyer_id`,
  `previous_appmetrica_id`, `progress_restoration_level_number` (old level; `state.level_number`
  already jumps to the restored level).
- **`screen_changed`** — UI transition (`method` `auto`/`manual`, `screen_from`, `screen_to`)
  — tentative / not widely implemented.

---
## Gotchas / rules (read before querying)
- **Counters start at 1**, EXCEPT main-progression level numbering (`chain=common`), which
  starts at **0** (legacy) — affects `level_number` and `chain_level_number`.
- **Omission, not null.** Params are OMITTED when the entity doesn't exist (state params,
  `active_event`/`active_quest`/`event_objects`/`quest_progress`/`with_elements`,
  conditional `method`/`tiles_left`). And a field counts as NULL only when truly NULL —
  `""`, `"null"`, `"0"` are not NULL.
- **Event-scoped payload.** A property is populated only on the event(s) that emit it; scope
  measures/steps to the right `event_name` or you read NULLs.
- **Envelope nesting.** Ad `network` → `additional_info`; IAP `location` → `event_data`;
  `time_zone`/install attrs → `main_data`; `system_memory_size` → `device_info`. Use
  `{ search }` to locate the block — don't assume top-level.
- **Banner ads** emit only `ad_finished` (no `ad_loaded`/`ad_started`/`ad_available`), and
  `is_clicked`/`is_reward_received` are always False for banners; `ad_redirected` is
  banner-only.
- **Enum case is exact**: `platform` lowercase; `additional_info` keys lowercase; IAP
  `currency` ISO-4217 uppercase; `country` ISO-3166 uppercase; `language` IETF lowercase.
- **Versioning.** `event_version` absent on first iteration. Watch added params:
  `monetization_type` (currency v1), `tracking_id`+`ad_unit` (ad_* v1), `revenue`
  (`ad_started` v1), `display_duration`/`is_clicked`/`is_user_returned`/`status`/
  `start_watch_time` (`ad_finished` v1), `substitution_reason` (ad v2). Deprecated params are
  struck through in the schema (e.g. state `lives_balance`/`hint_clear_balance`; level
  `fragments_count`/`level_difficulty`/`pattern_length`; `method=lives`).
- **Reconciliation ≠ in-event values.** IAP → AppsFlyer by `order_id`/`transaction_id`; ads →
  MAX by `tracking_id`. Say which source a revenue number came from.
- **`product_id`** is always WITHOUT the bundle prefix.
- **Reinstalls** re-fire `first_launch` → distort cohort/revenue; flag it.
- **Timestamps.** `device_time`/`first_launch` are client-local UNIX; `server_time` is
  server-side; prefer a non-zero-variance time field when ordering. `time_zone` is `±hh:mm`.
- **Grain.** Per-event vs per-player vs per-session; "per Player" metrics `count_distinct`
  the player key. Funnels: `one_per_partition` (players) vs `one_per_match` (attempts).

## Working with events in this MCP
1. Discover: `describe_catalog()` → event_names; `({ event })` → its properties (+ value
   hints); `({ property })` → real values/cardinality; `({ search })` → map a term/value to
   its event + envelope. Check `describe_index` for value-index freshness.
2. Funnels/paths: a `build_native_model` pipeline with a `match_recognize` stage (a step =
   event + an `event_data` value, e.g. `level_started → level_completed (result=win)`), then
   `get_query_result`.
3. Governed rates/volumes: `create_semantic_model` + `query_semantic_model` (e.g. *Game
   Completion Rate*, DAU, economy) — prefer these over hand-rolled aggregates.
