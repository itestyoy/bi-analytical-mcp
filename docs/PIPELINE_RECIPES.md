# Pipeline Recipes — analytical task → stages

How to express common games-analytics questions as a **pipeline** (a `source` + an
ordered list of stages: its `steps`, each tagged by its `stage`). Modeled on BigQuery pipe syntax; each recipe shows the
declarative stages and the pipe-syntax it lowers to on BigQuery (DuckDB lowers
the same op list to a chained CTE). Reference:
[BigQuery pipe syntax by example](https://medium.com/google-cloud/bigquery-pipe-syntax-by-example-blasetta-0f3df50ba331).

Stages: `where · compute · unnest · join · aggregate · pivot · unpivot · sample ·
order_by · limit · project · match_recognize`. What a stage holds — a condition, a
measure, a computed value — is ONE expression grammar: `{ fn, args: [expressions], …params }`
over leaves (`{ column }`, `{ property }` — an event property read where it is stored —,
`{ value }`, `{ now: true }`), nested to any depth. A `where` is a list of conditions that all
hold (a comparison, `in`, `between`, `is_null`, a text test, `and` / `or` / `not`); a measure is
`{ name, expr }` whose expression folds rows. See `src/pipeline.js` (top-of-file catalog) and each
stage's `description` in the tool schema for the authoritative contract.

---

### Revenue by country
```jsonc
[ {stage:"where",  conditions:[{fn:"eq", args:[{column:"event_name"}, {value:"iap_purchase_completed"}]}]},
  {stage:"compute", name:"price", expr:{ property:"price_in_usd_of_event_data", type:"numeric" }},
  {stage:"join",   with:"users", via:"user", attrs:[{ column: "country" }]},   // `via` = the relationship the schema declares; add
  //                                                                 between:{column:"device_time",from:…,to:…} if the
  //                                                                 install record is slowly-changing (validity window)
  {stage:"aggregate", group_by:["country"], measures:[{name:"revenue", expr:{fn:"sum", args:[{column:"price"}]}}]} ]
```
`FROM events |> WHERE event_name='iap_purchase_completed' |> EXTEND … AS price |> JOIN dim_users USING(appsflyer_id) |> AGGREGATE SUM(price) AS revenue GROUP BY country`

### Price distribution (median / percentiles / spread)
```jsonc
[ {stage:"where",  conditions:[{fn:"eq", args:[{column:"event_name"}, {value:"iap_purchase_completed"}]}]},
  {stage:"compute", name:"price", expr:{ property:"price_in_usd_of_event_data", type:"numeric" }},
  {stage:"aggregate", measures:[
     {name:"med", expr:{fn:"median", args:[{column:"price"}]}},
     {name:"p90", expr:{fn:"percentile", args:[{column:"price"}], percentile:0.9}},
     {name:"sd",  expr:{fn:"stddev", args:[{column:"price"}]}}]} ]
```

### A formula over aggregates, and a conditional count (ARPPU, failures)
```jsonc
[ …where+compute(price)…,
  {stage:"aggregate", group_by:["country"], measures:[
     {name:"arppu", expr:{fn:"div", args:[{fn:"sum", args:[{column:"price"}]}, {fn:"count_distinct", args:[{column:"appsflyer_id"}]}]}},
     {name:"big_purchases", expr:{fn:"count", where:[{fn:"gte", args:[{column:"price"}, {value:20}]}]}}]} ]
```
`|> AGGREGATE SUM(price) / NULLIF(COUNT(DISTINCT appsflyer_id), 0) AS arppu, COUNT(CASE WHEN price >= 20 THEN 1 END) AS big_purchases GROUP BY country`
— a `count` with no args counts rows; an aggregate's `where` folds only the rows it holds for.

### Revenue pivoted to per-country columns (dashboard matrix)
```jsonc
[ …where+compute(price)+join(country)…,
  {stage:"pivot", on:"country", measure:{fn:"sum", args:[{column:"price"}]},
   values:[{value:"US",name:"us"}, {value:"GB",name:"gb"}, {value:"BR",name:"br"}]} ]
```
`|> AGGREGATE SUM(CASE WHEN country = 'US' THEN price END) AS us, …` — `measure` is an aggregate
expression; each value's condition (`on` equals it) is added to the `where` of every aggregate in
it, and the column is named by the value's `name`.

### Days-since-install (retention-day building block)
```jsonc
[ {stage:"join", with:"users", via:"user", attrs:[{ column: "install_date" }]},
  {stage:"compute", name:"dsi", expr:{ fn: "date_diff", args: [{column:"install_date"}, {column:"device_time"}], unit: "day" }} ]
```
Then a `where` with `{fn:"eq", args:[{column:"dsi"}, {value:1}]}` + an aggregate of
`count_distinct(appsflyer_id)` ⇒ **D1 active users**; `group_by dsi` ⇒ a retention curve.

### Repeat purchasers / N-th purchase  (window)
```jsonc
[ {stage:"where", conditions:[{fn:"eq", args:[{column:"event_name"}, {value:"iap_purchase_completed"}]}]},
  {stage:"compute", name:"pseq", expr:{ fn: "row_number", over: { partition_by: ["appsflyer_id"], order_by: [{key:"device_time"}] } }},
  {stage:"where", conditions:[{fn:"gte", args:[{column:"pseq"}, {value:2}]}]},
  {stage:"aggregate", measures:[{name:"repeat_buyers", expr:{fn:"count_distinct", args:[{column:"appsflyer_id"}]}}]} ]
```
`|> EXTEND ROW_NUMBER() OVER(PARTITION BY appsflyer_id ORDER BY device_time) AS pseq |> WHERE pseq>=2 …`

### Period-over-period (WoW change)  (window lag)
```jsonc
[ …aggregate by week into (wk, revenue)…,
  {stage:"compute", name:"prev", expr:{ fn: "lag", args: [{ column: "revenue" }], over: { order_by: [{key:"wk"}] } }},
  {stage:"compute", name:"wow", expr:{ fn: "sub", args: [{column:"revenue"}, {column:"prev"}] }} ]
```
`|> EXTEND revenue - LAG(revenue) OVER(ORDER BY wk) AS wow`

### Rolling N-day sum  (window RANGE frame + unix_date)
```jsonc
[ …compute(amount)…,
  {stage:"compute", name:"day", expr:{ fn: "unix_date", args: [{ column: "order_completed_at" }] }},
  {stage:"compute", name:"roll", expr:{ fn: "sum", args: [{ column: "amount" }], over: { partition_by: ["customer_id"], order_by: [{key:"day"}], frame: {mode:"range", preceding:10, following:0} } }} ]
```
Lowers to a value-based RANGE frame on an integer day key (so "10 PRECEDING" = 10
days), matching the BigQuery idiom — order by `UNIX_DATE(CAST(... AS DATE))` (DuckDB:
`date_diff('day', DATE '1970-01-01', CAST(... AS DATE))`), then `RANGE BETWEEN 10 PRECEDING AND CURRENT ROW`:
```
SUM(amount) OVER (PARTITION BY customer_id ORDER BY day RANGE BETWEEN 10 PRECEDING AND CURRENT ROW)
```
Use `frame.mode:"rows"` for physical row offsets instead, or `preceding:"unbounded"`
for a running total. `sum`, `average`, `min`, `max` and `count` with `over` are windows, and
stand only in a compute stage.

### Additive distinct counts / rolling uniques  (HLL++ sketches)
Distinct counts aren't additive — you can't sum daily uniques. HLL++ sketches are:
build per-bucket sketches with `hll_init`, then `hll_merge` (→ cardinality) or
`hll_merge_partial` (→ a coarser sketch) across buckets/windows, and `hll_extract`
to read a sketch's cardinality.
```jsonc
// distinct buyers across products, deduped (merge), without rescanning raw events:
[ {stage:"where", conditions:[{fn:"eq", args:[{column:"event_name"}, {value:"iap_purchase_completed"}]}]},
  {stage:"compute", name:"pid", expr:{ property:"product_id_of_event_data" }},
  {stage:"aggregate", group_by:["pid"], measures:[{name:"sk", expr:{fn:"hll_init", args:[{column:"appsflyer_id"}]}}]},
  {stage:"aggregate", measures:[{name:"buyers", expr:{fn:"hll_merge", args:[{column:"sk"}]}}]} ]
```
BigQuery → `HLL_COUNT.INIT/MERGE/MERGE_PARTIAL/EXTRACT`; DuckDB → an exact,
mergeable distinct-set fallback. For a rolling N-day unique: `hll_init` per day,
then merge the trailing-N days' sketches.

### Price tiers (bucketing)  (CASE)
```jsonc
[ …compute(price)…,
  {stage:"compute", name:"tier", expr:{ fn: "case", cases: [{when:[{fn:"lt", args:[{column:"price"}, {value:10}]}], then:{value:"low"}}], else: {value:"high"} }},
  {stage:"aggregate", group_by:["tier"], measures:[{name:"n", expr:{fn:"count"}}]} ]
```

### Item / reward frequency  (unnest)
```jsonc
[ {stage:"where",  conditions:[{fn:"eq", args:[{column:"event_name"}, {value:"level_completed"}]}]},
  {stage:"unnest", expr:{property:"words_collected"}, name:"word"},
  {stage:"aggregate", group_by:["word"], measures:[{name:"n", expr:{fn:"count"}}]},
  {stage:"order_by", keys:[{key:"n",direction:"desc"}]}, {stage:"limit", limit:10} ]
```

### Multi-step funnel  (match_recognize)
```jsonc
[ {stage:"match_recognize", partition_by:[{entity:"user"}],   // between_steps: "any" (the default)
   steps:[{name:"launch",event_name:["first_launch"]},
          {name:"purchase",event_name:["iap_purchase_completed"]}]},
  {stage:"aggregate", measures:[
     {name:"started",   expr:{fn:"count"}},
     {name:"converted", expr:{fn:"count", where:[{column:"reached_purchase"}]}}]} ]
```
Lowers to a per-user CTE chain (DuckDB) / `|> MATCH_RECOGNIZE` (BigQuery); a `join`
with users before the `aggregate` slices the conversion by a user attribute. A boolean
column (`reached_purchase`) stands in a condition slot as it is.

---

**Composition notes.** `unnest` expands grain; `aggregate`/`pivot`/`match_recognize`
collapse it; references are validated against the live column set at each stage, so
a later stage can only use columns that exist at that point. `compute` adds columns
without changing grain — put window functions / `date_diff` / `case` before the `aggregate` that
consumes them, and put a post-aggregate `where` after `aggregate` to filter on a
computed measure. A built table is read later in the same stages:
`query_pipeline_model({ request: { context_id, steps: [...] } })` runs where, compute,
aggregate, pivot, unpivot, order_by, limit, sample and project over it, storing nothing
(`dry_run: true` returns that read's SQL instead); a metric query takes the same `steps` over
its result (`query_semantic_model`).
