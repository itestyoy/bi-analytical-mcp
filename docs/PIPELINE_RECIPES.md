# Pipeline Recipes — analytical task → stages

How to express common games-analytics questions as a **pipeline** (a `source` + an
ordered list of stages). Modeled on BigQuery pipe syntax; each recipe shows the
declarative stages and the pipe-syntax it lowers to on BigQuery (Postgres lowers
the same op list to a chained CTE). Reference:
[BigQuery pipe syntax by example](https://medium.com/google-cloud/bigquery-pipe-syntax-by-example-blasetta-0f3df50ba331).

Stages: `where · derive · compute · unnest · join · aggregate · pivot · unpivot ·
order_by · limit · project · match_recognize`. See `src/pipeline.js` (top-of-file
catalog) and each stage's `description` in the tool schema for the authoritative
contract.

---

### Revenue by country
```jsonc
[ {stage:"where",  conditions:[{column:"event_name",op:"eq",value:"iap_purchase_completed"}]},
  {stage:"derive", name:"price", op:"extract", source:"price_in_usd", type:"numeric"},
  {stage:"join",   with:"users", on:"appsflyer_id", attrs:["country"]},
  {stage:"aggregate", group_by:["country"], measures:[{name:"revenue",fn:"sum",column:"price"}]} ]
```
`FROM events |> WHERE event_name='iap_purchase_completed' |> EXTEND … AS price |> JOIN dim_users USING(appsflyer_id) |> AGGREGATE SUM(price) AS revenue GROUP BY country`

### Price distribution (median / percentiles / spread)
```jsonc
[ {stage:"where",  conditions:[{column:"event_name",op:"eq",value:"iap_purchase_completed"}]},
  {stage:"derive", name:"price", op:"extract", source:"price_in_usd", type:"numeric"},
  {stage:"aggregate", group_by:[], measures:[
     {name:"med",fn:"median",column:"price"},
     {name:"p90",fn:"percentile",column:"price",q:0.9},
     {name:"sd", fn:"stddev",column:"price"}]} ]
```

### Revenue pivoted to per-country columns (dashboard matrix)
```jsonc
[ …where+derive(price)+join(country)…,
  {stage:"pivot", group_by:[], on:"country", fn:"sum", value_column:"price", values:["US","GB","BR"]} ]
```
`|> PIVOT(SUM(price) FOR country IN ('US','GB','BR'))`

### Days-since-install (retention-day building block)
```jsonc
[ {stage:"join", with:"users", on:"appsflyer_id", attrs:["install_date"]},
  {stage:"compute", name:"dsi", op:"date_diff", from:{column:"install_date"}, to:{column:"device_time"}, unit:"day"} ]
```
Then `where dsi=1` + `aggregate count_distinct(appsflyer_id)` ⇒ **D1 active users**;
`group_by dsi` ⇒ a retention curve.

### Repeat purchasers / N-th purchase  (window)
```jsonc
[ {stage:"where", conditions:[{column:"event_name",op:"eq",value:"iap_purchase_completed"}]},
  {stage:"compute", name:"pseq", op:"window", fn:"row_number", partition_by:["appsflyer_id"], order_by:[{key:"device_time"}]},
  {stage:"where", conditions:[{column:"pseq",op:"gte",value:2}]},
  {stage:"aggregate", group_by:[], measures:[{name:"repeat_buyers",fn:"count_distinct",column:"appsflyer_id"}]} ]
```
`|> EXTEND ROW_NUMBER() OVER(PARTITION BY appsflyer_id ORDER BY device_time) AS pseq |> WHERE pseq>=2 …`

### Period-over-period (WoW change)  (window lag)
```jsonc
[ …aggregate by week into (wk, revenue)…,
  {stage:"compute", name:"prev", op:"window", fn:"lag", column:"revenue", order_by:[{key:"wk"}]},
  {stage:"compute", name:"wow",  op:"sub", left:{column:"revenue"}, right:{column:"prev"}} ]
```
`|> EXTEND revenue - LAG(revenue) OVER(ORDER BY wk) AS wow`

### Price tiers (bucketing)  (CASE)
```jsonc
[ …derive(price)…,
  {stage:"compute", name:"tier", op:"case",
     cases:[{when:[{column:"price",op:"lt",value:10}], then:{value:"low"}}], else:{value:"high"}},
  {stage:"aggregate", group_by:["tier"], measures:[{name:"n",fn:"count"}]} ]
```

### Item / reward frequency  (unnest)
```jsonc
[ {stage:"where",  conditions:[{column:"event_name",op:"eq",value:"level_completed"}]},
  {stage:"unnest", source:"words_collected", as:"word"},
  {stage:"aggregate", group_by:["word"], measures:[{name:"n",fn:"count"}]},
  {stage:"order_by", keys:[{key:"n",direction:"desc"}]}, {stage:"limit", n:10} ]
```

### Multi-step funnel  (match_recognize — via register_native_model)
```jsonc
{ sequence:{ partition_by:"user", mode:"ordered",
  steps:[{name:"launch",event_name:["first_launch"]},
         {name:"purchase",event_name:["iap_purchase_completed"]}],
  metrics:[{name:"conv",type:"conversion",from:"launch",to:"purchase"}] } }
```
Lowers to a per-user CTE chain (Postgres) / `|> MATCH_RECOGNIZE` (BigQuery); the
resulting model is then sliced by user attributes through MetricFlow.

---

**Composition notes.** `unnest` expands grain; `aggregate`/`pivot`/`match_recognize`
collapse it; references are validated against the live column set at each stage, so
a later stage can only use columns that exist at that point. `compute` adds columns
without changing grain — put `window`/`date_diff`/`case` before the `aggregate` that
consumes them, and put a post-aggregate `where` after `aggregate` to filter on a
computed measure.
