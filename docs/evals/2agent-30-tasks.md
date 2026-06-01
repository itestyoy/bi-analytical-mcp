# Two-Agent Eval — 30 Analytical Tasks

Independent **fresh-eyes** exercise to gauge how well the tool surface covers real
games-analytics work.

- **Agent A** (analyst) saw ONLY the events/table schema (`config/catalog.yml`) — no
  tools, no code — and drafted 30 diverse business tasks (≈10 easy / 12 medium / 8 hard).
- **Agent B** (engineer) saw ONLY the tool JSON-Schemas (`get_query_result`,
  `register_native_model` pipeline, `create_semantic_model`, `query_semantic_model`,
  `time`, …) and solved them. Verdicts in `2agent-30-solutions.md`.

---

## Easy (1–10)

**1. Daily Active Users** — *easy.* How many distinct users open the game each day? — `new_session`, distinct `appsflyer_id` by `device_time` (day). Output: daily series.

**2. Total installs** — *easy.* How many new users did we acquire in total? — `first_launch` distinct `appsflyer_id` (or `dim_users.users_count`). Output: one number.

**3. Users by country** — *easy.* Which countries hold the largest share of users? — `dim_users.country`, `users_count`. Output: rows by country.

**4. Platform split** — *easy.* Android vs iOS split? — `dim_users.platform`, `users_count`. Output: two rows.

**5. Top 10 acquisition channels** — *easy.* Which media sources bring the most users? — `dim_users.media_source`, `users_count`. Output: top-10 ranking.

**6. Total IAP revenue** — *easy.* Total in-app-purchase revenue? — `iap_purchase_completed`, sum `event_data.price_in_usd`. Output: one number.

**7. Level completions by level** — *easy.* How many completions per level? — `level_completed`, count by `event_data.level_id`. Output: rows by level_id.

**8. Ad views by network** — *easy.* Which network serves the most finished ads? — `ad_finished`, count by `event_data.ad_network`. Output: rows by network.

**9. Win vs lose rate** — *easy.* Fraction of completed levels that are wins? — `level_completed`, `event_data.result`. Output: counts + win-rate %.

**10. Shop opens per day** — *easy.* How often is the shop opened daily? — `shop_opened`, count by `device_time` (day). Output: daily series.

## Medium (11–22)

**11. ARPU and ARPPU** — *medium.* Avg revenue per user / per paying user? — `iap_purchase_completed.price_in_usd`; distinct payers vs total users. Output: two numbers.

**12. Paying-user conversion by channel** — *medium.* Which media sources deliver users most likely to pay? — payers (`iap_purchase_completed`) ÷ users by `dim_users.media_source`. Output: rows by media_source with conversion %.

**13. Tutorial onboarding funnel** — *medium.* Where do players drop off in the tutorial? — `tutorial` with `event_data.step_id` (step_1→…), distinct users per step. Output: multi-step funnel.

**14. Level-difficulty funnel (start → complete → win)** — *medium.* How many starters complete and win a level? — `level_started` → `level_completed` (`result=win`) by `event_data.level_id`. Output: 3-step funnel.

**15. IAP price distribution (percentiles)** — *medium.* What price points do payers buy at? — `iap_purchase_completed.price_in_usd`. Output: p25/p50/p90/p99.

**16. Revenue period-over-period** — *medium.* Is IAP revenue growing WoW? — `price_in_usd` by `device_time` (week) with prior-period delta. Output: weekly series + WoW %.

**17. Sessions-per-user distribution** — *medium.* How many sessions do users accumulate? — `new_session` (or max `session_number`) per `appsflyer_id`. Output: distribution + p50/p90.

**18. Ad placement performance** — *medium.* Which placements generate the most revenue? — `ad_finished` sum `event_data.revenue` by `event_data.placement` × `event_data.ad_type`. Output: rows by placement.

**19. Country × platform revenue matrix** — *medium.* Which country×platform combos monetize best? — `price_in_usd` by `dim_users.country` × `platform`. Output: pivot matrix.

**20. Avg level completion time by level** — *medium.* Which levels take longest to finish? — `level_completed` avg `event_data.complete_time` by `event_data.level_id`. Output: rows by level_id.

**21. IAP success vs failure rate** — *medium.* How often do purchase attempts fail? — `iap_purchase_completed` vs `iap_purchase_failed` (opt. `event_data.status`) by day/platform. Output: failure rate %.

**22. Organic vs paid engagement** — *medium.* Do paid users engage like organic? — `dim_users.acquisition_type` × per-user `new_session`/`iap_purchase_completed`. Output: 2-group comparison.

## Hard (23–30)

**23. D1/D7/D30 retention by install cohort** — *hard.* How well do we retain users over 30 days? — `dim_users.install_date` anchor; `new_session` days-since-install per user. Output: cohort grid (install-date × Dn).

**24. Retention by acquisition-channel cohort** — *hard.* Which media sources retain best past D7? — `install_date` + `media_source`; `new_session` days-since-install. Output: cohort grid by media_source.

**25. Economy sources vs sinks balance** — *hard.* Is the economy inflating or deflating? — `currency_income.amount` by `source_type` vs `currency_outcome.amount` by `source_type`. Output: net-flow table.

**26. Nth-purchase repeat behavior** — *hard.* What share of payers make a 2nd/3rd purchase, how fast? — `iap_purchase_completed` per user ordered by `device_time` (window/rank), inter-purchase gaps. Output: rows by purchase ordinal (users reaching N, median days between).

**27. Level-attempt churn / abandonment** — *hard.* At which attempt do players give up on a level? — `level_started`/`level_completed` with `event_data.level_id` + `event_data.attempt`; last attempt per user/level. Output: rows by level_id × attempt with abandonment %.

**28. Screen navigation flow matrix** — *hard.* What are the dominant screen-to-screen transitions? — `screen_changed` with `event_data.screen_from`/`screen_to`. Output: from×to matrix, top paths.

**29. Reward-item economy (array-of-struct unnest)** — *hard.* Which reward items/quantities are granted most? — `level_completed`, unnest `event_data.rewards` (array<struct{item,qty}>), aggregate count + sum(qty) by item. Output: rows by reward item.

**30. Words-collected breadth (array unnest)** — *hard.* Which words are most common, how many per level? — `level_completed`, `event_data.words_collected` (array<string>) — unnest for frequency, `array_length` for breadth, by `event_data.level_id`. Output: top words + words-per-completion p50/p90.
