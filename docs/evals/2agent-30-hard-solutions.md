# Two-Agent Eval — HARD Solutions (Agent B, tools-only)

Agent B saw ONLY the tool JSON-Schemas and solved the 30 HARD tasks from
`2agent-30-hard-tasks.md`.

**Tally: 24 Solvable · 5 Partial · 1 Not solvable.**

Reusable hard limits Agent B identified: `join` is 1-hop to `users` only (no
event↔event join); window functions have **no count_distinct**; `match_recognize`
partitions only per user/session; `pivot` needs values listed; there is no
cost/spend data (two-source rule); no causal/incrementality primitives.

---

1. **Retention by media_source cohort** — Solvable. new_session → join users(install_date,media_source) → compute date_diff days_since_install → case d1/d7/d30 → aggregate group_by[media_source,bucket] count_distinct(user) ÷ cohort size.
2. **Time-to-first-purchase survival by install week** — Solvable. where iap → window row_number(user, by time)=1 → join users → date_diff(install→first) → date_trunc week → aggregate count_distinct by (week,days); survival = cumulative complement; censored base from a second users query.
3. **Rolling 7-day distinct active users** — **Not solvable.** A sliding-window COUNT(DISTINCT) — window fns have no count_distinct and daily distinct counts can't be summed across days (double counts). Per-day DAU is trivial; the rolling unique is the gap.
4. **DAU/MAU stickiness by platform** — Solvable. daily distinct ÷ monthly distinct by platform (ratio metric / compute div); each is a single count_distinct (no cross-window summing).
5. **Level give-up curve** — Solvable. per user×level window max(attempt) + never-won flag (window max of win) → aggregate give-up dist by level_id.
6. **Funnel conditioned on tutorial completion** — Solvable. derive per-user tutorial_completed flag (window max) → split arms → match_recognize/conversion to first purchase by arm.
7. **Churn+resurrection by cohort** — Solvable. window lag(event_day) per user → date_diff gap → where gap>14 (churn) / row after gap (resurrection) → aggregate gap dist + rate by cohort.
8. **LTV-to-date by install week** — Solvable. compute case revenue = price_in_usd (iap) / revenue (ad) → join users → date_diff dsi → aggregate group_by[week,dsi] sum → window running sum (cumulative curve).
9. **Reward economy net + faucet/sink by source_type** — Solvable. currency_income/outcome → aggregate by source_type sum(income)/sum(outcome) via case-split → compute net + ratio.
10. **Pay-after-rewarded-ad ≤N min vs baseline** — Solvable. match_recognize ad_finished(rewarded)→iap with avg_seconds_between → downstream where ≤N·60; baseline = overall conversion.
11. **Price-tier migration matrix** — Solvable. where iap → case price_tier → window lag(tier) per user → aggregate group_by[prev,tier] count → pivot.
12. **Whale concentration top-x%** — Solvable. aggregate per-user revenue → window row_number + total count (percentile rank) + running sum ÷ total → where rank ≤1/5/10%.
13. **Session-depth p50/p90 by acquisition_type** — Solvable. count events per session → join users → aggregate percentile by acquisition_type.
14. **First-session funnel** — Solvable. match_recognize partition=session, filter session_number=1, steps first_launch→tutorial→level_started→level_completed(win).
15. **Median complete_time by level (win)** — Solvable. where level_completed&win → aggregate group_by level_id median/percentile(complete_time).
16. **Ad revenue-per-impression decay** — Solvable. where ad_finished → window row_number(session, by time)=ordinal → aggregate group_by ordinal avg(revenue).
17. **Payers-vs-nonpayers D14 retention** — Solvable. join users → date_diff dsi → window max(iap where dsi≤3)=payer flag → active@d14 flag → aggregate by flag.
18. **Resurrection incrementality of rewarded ads** — **Partial.** The associational rate (resurrected users who saw a rewarded ad vs not) is expressible via gap+adjacency windows; true causal **incrementality/lift** (matched control) is not a tool capability.
19. **Per-user running coin balance** — Solvable. case signed_delta (+/−) → window running sum per user by device_time → window min (hit-0) + last (end balance) → aggregate distribution + share min≤0.
20. **shop_opened→purchase by preceding placement/screen_from** — Solvable. match_recognize/window lag(screen_from) → conversion grouped by attributed context.
21. **IAP failure→retry recovery by product_id** — Solvable. match_recognize iap_failed→iap_completed (step where same product_id, partition user) → recovery rate; lost revenue = unrecovered failures sum.
22. **Reward-struct item yield** — Solvable. unnest rewards (struct element) → compute json_field item+qty → aggregate group_by[item,level_id] sum(qty).
23. **Vocabulary breadth × D7 retention** — **Partial.** distinct words/user (unnest+count_distinct) and D7 retention each computable, but cross-tabbing two derived PER-USER tables needs an event↔event join — join is 1-hop to `users` only, so combining them in one pass (unnest changes grain vs ungrained retention) isn't clean.
24. **Screen transition graph; paths never reaching shop** — **Partial.** 1-hop edges via window lag + per-session "never opened shop" flag = solvable; arbitrary-length **path mining / longest popular paths** isn't (match_recognize needs predefined steps).
25. **Cohort payback period** — **Partial.** cumulative paid-cohort revenue curve = solvable; "break-even/payback" needs **CAC/spend**, which isn't in the two-source data model (events+users), so ROI/payback is unanswerable.
26. **Fail→rewarded-ad adjacency by level** — Solvable. match_recognize level_completed(lose)→ad_finished(placement=level_fail), strict adjacency, capture level_id → rate by level_id.
27. **Weekly active composition new/retained/resurrected** — Solvable. aggregate user×week active → window lag(week) per user → date_diff → case classify (install week = new, gap=1wk = retained, gap>1wk = resurrected).
28. **Ratio-of-ratios paid/organic lift by country** — Solvable. conversion per (country×acquisition_type) → pivot acquisition_type → compute paid/organic ratio per country.
29. **Hour×weekday heatmap by region** — Solvable. compute date_part hour + dow → join users(region) → aggregate group_by[region,dow,hour] count_distinct → pivot hour.
30. **Spend-velocity (change-in-gap)** — Solvable. where iap → window row_number=ordinal → window lag(time)→gap → window lag(gap)→delta → aggregate median(gap) by ordinal + share delta<0.

---

## Top gaps to add (ranked by Agent B)
1. **Windowed / rolling DISTINCT count** (count_distinct as a window fn, or rolling-unique-users-over-N-days) — unblocks #3 and any sliding-window uniqueness. The one genuinely-blocking, in-scope gap.
2. **Event↔event (model↔model) join** — join is 1-hop to `users` only; blocks cross-tabbing two derived per-user tables (#23).
3. **Cost/spend data** — out of scope by the two-source rule (events+users only); without it, payback/ROAS/break-even (#25) is unanswerable.
4. **Open-ended path/sequence mining** — match_recognize needs predefined steps; only 1-hop lag transitions (#24).
5. **Causal / incrementality primitives** — only associational rates are expressible (#18).
6. **Dynamic pivot** (no pre-listed values) — minor (#11/#29 enumerate tiers/hours by hand).

### Read-out
On a deliberately brutal, all-hard set the surface still answers **24/30 outright**
and partially handles **5** more, with only **1** truly out of reach (rolling
distinct). Of the 6 gaps, three are out-of-scope by design (cost data, causal lift,
arbitrary path mining); the actionable in-scope ones are **windowed distinct
count**, **event↔event join**, and **dynamic pivot**.
