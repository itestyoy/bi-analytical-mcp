# Events — where to read them, how to use them

Events are the foundation of OMG analytics: a measure or funnel step is an `event_name` +
a value in that event's payload. This file does NOT copy the event definitions (they live in
Confluence and change) — it points you to the source and shows how to use events in the MCP.
For what each event MEANS, WHEN it fires, and its PARAMETERS → **read the master Events
Schema** and confirm against the live catalog.

## Read these
- **Master Events Schema** — the single source of truth: every custom event's meaning,
  trigger, parameters (name/format/values), per-project status, and version history.
  → `https://openmygame.atlassian.net/wiki/spaces/PA/pages/2602991642`
- **Event QA rules** — required fields, enum/null rules, banner-ad exceptions, anomaly checks.
  → `https://openmygame.atlassian.net/wiki/spaces/BI/pages/4797726777`
- **Game-specific event spec** — search the game's space (e.g. `space = JCS AND title ~ "currency"`).
- **What's live here** — `semantic_index({ event })` / `({ property })` / `({ search })`
  for the exact (flattened) field names, real values and cardinality in this deployment.

## Orientation (so you know what to look for in the schema)
Confirm names/params/availability in the schema + `semantic_index` — this is just a map of
the families and roughly where each event's data sits.
- **Sessions / lifecycle:** `first_launch`, `new_session`, `end_session`. Install attributes
  are NOT a separate event — they're parameters in the `main_data` block.
- **Progression (the core funnel):** `level_started`, `level_completed`, plus variants
  `fragment_started/finished`, `puzzle_started/part_completed/completed`,
  `battle_of_wits_*`, `word_selected` (+ the `words_selected` array on completion events).
- **Economy:** `currency_income`, `currency_outcome`.
- **Ads:** the chain `ad_requested → ad_loaded → ad_started → ad_finished` (+ AppHarbr
  quality events `ad_analyzed`/`ad_incident`/`ad_blocked`, and `ad_available`/`ad_freezed`/
  `ad_redirected`).
- **IAP:** `shop_opened`, `iap_started`, `iap_purchase_failed`, `iap_purchase_completed`.
- **In-game events & UI:** `event_start/prize/end`, `tutorial`, `wheel_spin`,
  `piggy_bank_opened`, `progress_restored`, `screen_changed`.

Event payloads are organized into blocks (flattened in the catalog): `main_data`,
`device_info`, `state`, `event_data`, `additional_info` — the schema page is authoritative
on which block holds which field; `semantic_index({ search })` finds it in the live data.

## Using events in the MCP (procedure)
1. Discover: `semantic_index()` → events; `({ event })` → its properties; `({ property })`
   → real values/cardinality; `({ search })` → map a term/value to its event + block. Check
   `semantic_index` for value-index freshness.
2. Funnels/paths: a `build_native_model` pipeline with a `match_recognize` stage (a step =
   event + an `event_data` value), then read rows with `get_query_result`.
3. Governed rates/volumes: `create_semantic_model` + `query_semantic_model` (after reading
   the metric's definition page) — prefer governed metrics over hand-rolled aggregates.

## Traps to avoid (verify specifics in the schema)
- **Scope to `event_name`.** A payload property is populated only on the event(s) that emit
  it; unscoped, it reads NULL. `semantic_index({ property })` lists which events carry it.
- **Find the block, don't assume top-level.** Fields nest in `event_data` / `additional_info`
  / `main_data` / `device_info`; use `semantic_index({ search })`.
- **Per-project + versioned.** The same event may be implemented/partial/absent per game, and
  parameters were added across versions (and some deprecated). The schema page is the
  authority — re-read it, don't rely on memory.
- **Banner ads** emit only `ad_finished`; there is no `ad_clicked` event (it's the
  `is_clicked` flag). **Reconciliation:** IAP by `order_id`/`transaction_id`, ads by
  `tracking_id` — in-event values ≠ reconciled revenue. **Grain:** per-event vs per-player
  vs per-session. **Reinstalls** re-fire `first_launch`. Confirm the details in the schema.
