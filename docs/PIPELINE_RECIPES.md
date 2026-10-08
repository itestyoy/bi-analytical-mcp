# Pipeline Recipes — analytical task → stages

How to express common games-analytics questions as a **pipeline** (a `source` + an
ordered list of stages). Modeled on BigQuery pipe syntax; each recipe shows the
declarative stages and the pipe-syntax it lowers to on BigQuery (DuckDB lowers
the same op list to a chained CTE). Reference:
[BigQuery pipe syntax by example](https://medium.com/google-cloud/bigquery-pipe-syntax-by-example-blasetta-0f3df50ba331).

Stages: `where · compute · unnest · join · aggregate · pivot · unpivot · sample ·
order_by · limit · project · match_recognize`. A computed column — an event property
read out of the payload, arithmetic, a CASE, a window function — is one `compute` stage
with an expression (`expr`). See `src/pipeline.js` (top-of-file
catalog) and each stage's `description` in the tool schema for the authoritative
contract.

---

### Revenue by country
```jsonc
[ {stage:"where",  conditions:[{column:"event_name",op:"eq",value:"iap_purchase_completed"}]},
  {stage:"compute", name:"price", expr:{ fn:"event_property", property:"price_in_usd_of_event_data", type:"numeric" }},
  {stage:"join",   with:"users", via:"user", attrs:[{ column: "country" }]},   // `via` = the relationship the schema declares; add
  //                                                                 between:{column:"device_time",from:…,to:…} if the
  //                                                                 install record is slowly-changing (validity window)
  {stage:"aggregate", group_by:["country"], measures:[{name:"revenue",agg:"sum",column:"price"}]} ]
```
`FROM events |> WHERE event_name='iap_purchase_completed' |> EXTEND … AS price |> JOIN dim_users USING(appsflyer_id) |> AGGREGATE SUM(price) AS revenue GROUP BY country`

### Price distribution (median / percentiles / spread)
```jsonc
[ {stage:"where",  conditions:[{column:"event_name",op:"eq",value:"iap_purchase_completed"}]},
  {stage:"compute", name:"price", expr:{ fn:"event_property", property:"price_in_usd_of_event_data", type:"numeric" }},
  {stage:"aggregate", group_by:[], measures:[
     {name:"med",agg:"median",column:"price"},
     {name:"p90",agg:"percentile",column:"price",percentile:0.9},
     {name:"sd", agg:"stddev",column:"price"}]} ]
```

### Revenue pivoted to per-country columns (dashboard matrix)
```jsonc
[ …where+compute(price)+join(country)…,
  {stage:"pivot", group_by:[], on:"country", measure:{agg:"sum", column:"price"},
   values:[{value:"US",name:"us"}, {value:"GB",name:"gb"}, {value:"BR",name:"br"}]} ]
```
`|> AGGREGATE SUM(CASE WHEN country = 'US' THEN price END) AS us, …` — each value one measure of the
aggregate stage over its rows (a count counts them), named by the value's `name`.

### Days-since-install (retention-day building block)
```jsonc
[ {stage:"join", with:"users", via:"user", attrs:[{ column: "install_date" }]},
  {stage:"compute", name:"dsi", expr:{ fn: "date_diff", args: [{column:"install_date"}, {column:"device_time"}], unit: "day" }} ]
```
Then `where dsi=1` + `aggregate count_distinct(appsflyer_id)` ⇒ **D1 active users**;
`group_by dsi` ⇒ a retention curve.

### Repeat purchasers / N-th purchase  (window)
```jsonc
[ {stage:"where", conditions:[{column:"event_name",op:"eq",value:"iap_purchase_completed"}]},
  {stage:"compute", name:"pseq", expr:{ fn: "row_number", over: { partition_by: ["appsflyer_id"], order_by: [{key:"device_time"}] } }},
  {stage:"where", conditions:[{column:"pseq",op:"gte",value:2}]},
  {stage:"aggregate", group_by:[], measures:[{name:"repeat_buyers",agg:"count_distinct",column:"appsflyer_id"}]} ]
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
for a running total.

### Additive distinct counts / rolling uniques  (HLL++ sketches)
Distinct counts aren't additive — you can't sum daily uniques. HLL++ sketches are:
build per-bucket sketches with `hll_init`, then `hll_merge` (→ cardinality) or
`hll_merge_partial` (→ a coarser sketch) across buckets/windows, and `hll_extract`
to read a sketch's cardinality.
```jsonc
// distinct buyers across products, deduped (merge), without rescanning raw events:
[ {stage:"where", conditions:[{column:"event_name",op:"eq",value:"iap_purchase_completed"}]},
  {stage:"compute", name:"pid", expr:{ fn:"event_property", property:"product_id_of_event_data" }},
  {stage:"aggregate", group_by:["pid"], measures:[{name:"sk", agg:"hll_init", column:"appsflyer_id"}]},
  {stage:"aggregate", group_by:[],      measures:[{name:"buyers", agg:"hll_merge", column:"sk"}]} ]
```
BigQuery → `HLL_COUNT.INIT/MERGE/MERGE_PARTIAL/EXTRACT`; DuckDB → an exact,
mergeable distinct-set fallback. For a rolling N-day unique: `hll_init` per day,
then merge the trailing-N days' sketches.

### Price tiers (bucketing)  (CASE)
```jsonc
[ …compute(price)…,
  {stage:"compute", name:"tier", expr:{ fn: "case", cases: [{when:[{column:"price",op:"lt",value:10}], then:{value:"low"}}], else: {value:"high"} }},
  {stage:"aggregate", group_by:["tier"], measures:[{name:"n",agg:"count"}]} ]
```

### Item / reward frequency  (unnest)
```jsonc
[ {stage:"where",  conditions:[{column:"event_name",op:"eq",value:"level_completed"}]},
  {stage:"unnest", property:"words_collected", name:"word"},
  {stage:"aggregate", group_by:["word"], measures:[{name:"n",agg:"count"}]},
  {stage:"order_by", keys:[{key:"n",direction:"desc"}]}, {stage:"limit", limit:10} ]
```

### Multi-step funnel  (match_recognize)
```jsonc
[ {stage:"match_recognize", partition_by:[{entity:"user"}],   // between_steps: "any" (the default)
   steps:[{name:"launch",event_name:["first_launch"]},
          {name:"purchase",event_name:["iap_purchase_completed"]}]},
  {stage:"aggregate", group_by:[], measures:[
     {name:"started",agg:"count"},
     {name:"converted",agg:"count",where:[{column:"reached_purchase",op:"eq",value:true}]}]} ]
```
Lowers to a per-user CTE chain (DuckDB) / `|> MATCH_RECOGNIZE` (BigQuery); a `join`
with users before the `aggregate` slices the conversion by a user attribute.

---

**Composition notes.** `unnest` expands grain; `aggregate`/`pivot`/`match_recognize`
collapse it; references are validated against the live column set at each stage, so
a later stage can only use columns that exist at that point. `compute` adds columns
without changing grain — put window functions / `date_diff` / `case` before the `aggregate` that
consumes them, and put a post-aggregate `where` after `aggregate` to filter on a
computed measure.
