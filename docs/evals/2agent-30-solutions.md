# Two-Agent Eval — Solutions (Agent B, tools-only)

Agent B saw ONLY the tool JSON-Schemas (`/tmp/tool_schema.json`) and solved the 30
tasks from `2agent-30-tasks.md`. Verdict per task + how (tool + stages/metrics).

**Tally: 29 Solvable · 1 Partial (#29) · 0 Not solvable.**

(Big jump vs the earlier 10-task run, where retention was only Partial — date_diff /
window / pivot / unix_date now make retention, cohorts, rolling, nth-event solvable.)

---

## Easy
1. **DAU** — Solvable. register_native_model: where event_name=new_session → compute event_day=date_trunc(event_ts,day) → aggregate group_by[event_day] count_distinct(appsflyer_id). (Or create_semantic_model count_distinct + query group_by metric_time/day.)
2. **Total installs** — Solvable. Semantic measure count_distinct(appsflyer_id) scoped first_launch (or users count_distinct).
3. **Users by country** — Solvable. Pipeline source=users → aggregate group_by[country] count_distinct(appsflyer_id).
4. **Platform split** — Solvable. As #3, group_by[platform].
5. **Top-10 media_source** — Solvable. users → aggregate group_by[media_source] count_distinct → order_by desc → limit 10.
6. **Total IAP revenue** — Solvable. Semantic sum(price_in_usd) scoped iap_purchase_completed (price_in_usd is a numeric field).
7. **Completions by level** — Solvable. where level_completed → derive level_id → aggregate group_by[level_id] count(*).
8. **Ad views by network** — Solvable. derive ad_network → aggregate group_by[ad_network] count.
9. **Win rate** — Solvable. Semantic ratio wins/total scoped level_completed (result=win), or pipeline count(*) + sum(case result=win).
10. **Shop opens/day** — Solvable. where shop_opened → date_trunc day → aggregate group_by[day] count.

## Medium
11. **ARPU & ARPPU** — Solvable. Two ratio metrics: revenue ÷ count_distinct(all users); revenue ÷ count_distinct(payers = users on iap_purchase_completed).
12. **Payer conversion by channel** — Solvable. conversion metric (base=distinct users first_launch, conversion=distinct users iap_purchase_completed, window) grouped by user__media_source; or ratio payers/users by media_source.
13. **Tutorial funnel** — Solvable. match_recognize partition_by user, steps tutorial+step_id=step_1/2/3, reached per step; or 3 sum_boolean measures + conversion.
14. **Level funnel start→complete→win** — Solvable. match_recognize steps level_started, level_completed(result=win); per-level via captured level_id / constant_properties.
15. **IAP price percentiles** — Solvable. where iap_purchase_completed → derive price → aggregate percentile q=0.25/0.5/0.9/0.99 (one row, all four).
16. **Revenue WoW** — Solvable. derive price → compute week=date_trunc(week) → aggregate group_by[week] sum=rev → compute prev=window lag(rev) order week → compute delta=sub(rev,prev).
17. **Sessions/user distribution** — Solvable. where new_session → aggregate group_by[appsflyer_id] count=sessions → aggregate group_by[] percentile 0.5/0.9 (+ optional histogram).
18. **Ad revenue by placement×ad_type** — Solvable. derive revenue/placement/ad_type → aggregate group_by[placement,ad_type] sum(revenue).
19. **Country×platform revenue matrix** — Solvable. where iap → derive price → join users(country,platform) → pivot group_by[country] on=platform fn=sum value=price (values listed).
20. **Avg complete_time by level** — Solvable. where level_completed → derive complete_time,level_id → aggregate group_by[level_id] avg.
21. **IAP success vs failure** — Solvable. count measures on iap_purchase_completed vs iap_purchase_failed → derived/ratio success rate.
22. **Organic vs paid** — Solvable. join users(acquisition_type) → ratio metrics (sessions/user, payer %, ARPU) grouped by user__acquisition_type.

## Hard
23. **D1/D7/D30 retention by install cohort** — Solvable (pipeline). where new_session → join users(install_date) → compute days_since=date_diff(install_date→event_day,day) → case/flags or pivot on [1,7,30] → aggregate group_by[install_date] count_distinct(user); ratios via compute div.
24. **Retention by media_source cohort** — Solvable. As #23, join/group by media_source.
25. **Economy sources vs sinks** — Solvable. where event_name in[currency_income,currency_outcome] → derive amount,source_type → compute signed amount via case → aggregate group_by[source_type,event_name] sum → pivot income/outcome → compute net.
26. **Nth-purchase repeat** — Solvable. where iap → compute ordinal=window row_number(partition user order ts), prev=window lag(ts), gap_days=date_diff(prev→ts,day) → aggregate group_by[ordinal] median(gap_days)+count.
27. **Level-attempt abandonment** — Solvable. derive level_id,attempt → aggregate group_by[level_id,attempt] count + completed → compute abandonment=1−ratio (or match_recognize per level).
28. **Screen navigation matrix** — Solvable. where screen_changed → derive screen_from,screen_to → aggregate group_by[from,to] count (optional pivot on to).
29. **Reward-item economy (array<struct>)** — **Partial.** unnest binds ONE struct `field`, and derive op=struct_field reads the event_data array property (not an already-unnested element) — so extracting BOTH `item` and `qty` from one exploded `rewards` row isn't cleanly expressible. Count-by-item works (unnest field=item → aggregate count); sum(qty)-by-item is the gap.
30. **Words-collected** — Solvable. Frequency: unnest words_collected as word → aggregate group_by[word] count. Breadth: derive array_length(words_collected)=n_words → aggregate percentile 0.5/0.9.

---

## Top remaining gaps (from Agent B)
1. **Array-of-struct multi-field unnest (#29):** can't bind two struct fields (`item` + `qty`) from one exploded element; `struct_field` targets the array property, not the unnested row. Count-by-item works; sum(qty)-by-item does not.
2. **Pivot requires explicitly listed values** (no dynamic pivot) — fine when the value domain is known.
3. **get_query_result.transform lacks percentile/median/stddev** — but those are available in the pipeline `aggregate`, so no task is blocked (compute them in the original pipeline).
4. **Event-time column** is load-bearing for date_trunc/date_diff (consistent with `metric_time`/`as_type:time` in the schema).
