# bi-analytical-mcp — Capabilities & Readiness Overview

A declarative **dbt Semantic Layer / MetricFlow** MCP server for product analytics.
An AI declares "virtual" semantic models (measures, dimensions, metrics) on the fly
over a **fixed set of two data sources**, and dbt + MetricFlow compile and run the
SQL — the AI never writes SQL by hand. Everything referenceable (events, properties,
user attributes, join paths) is enumerated by the catalog and enforced by JSON-Schema,
so an unknown field name is rejected at the boundary.

This overview is the consolidated result of three independent audits
(analytical-task coverage, code quality, production readiness) run against the
codebase, the catalog (`config/catalog.yml`), the recipes (`config/recipes.json`),
and the integration tests.

- **Data model (exactly two sources):**
  - `fct_analytics_events` — one row per event: user id, session id, event time, `event_name`, and a typed JSON `event_data` payload.
  - `dim_users` — one row per user: categorical attributes (country, platform, media_source, acquisition_type, campaign_id, install_date, …).
  - Funnels are built **only** from events (a step = event + an `event_data` property value). Segmentation joins user attributes to events by the `user` entity at query time (MetricFlow generates the join).

**Evidence legend:** **PROVEN** = exact-value data test against dbt+MetricFlow+PGlite ·
**RUN-PROVEN** = recipe parses and its example query returns rows · **BY DESIGN** = code path exists, no test.

---

## 1. What the server can solve **now**

| Analytics family | How | Status |
|---|---|---|
| **Active-user trends (DAU/WAU/MAU), event volume** | `count_distinct(user)` scoped to `new_session`, grouped by `metric_time` (day/week/month) | **PROVEN** (`active_users_trend`; DAU=12, 7 active days, peak=6, MAU=12) |
| **Segmentation by user attribute** (1-hop join) | `use_base_models:["users"]` → `events.user → dim_users.user`; group_by `{ model: 'users', attribute: 'country' | 'platform' | 'media_source' | 'acquisition_type/…` | **PROVEN** (revenue US35/GB25/BR25, ios65/android20, paid55/organic30, ARPPU per segment) |
| **Nested `where` filters (AND/OR)** | typed predicate tree on dimensions / metric_time | **PROVEN** (US∧paid=50, US∨BR=60, time_range=45) |
| **2-step conversion funnel** | `conversion` metric (count_distinct base/conversion, entity=user, window) | **PROVEN** (`step_conversion_funnel`) |
| **Multi-step funnel (step = event + property value)** | per-step measures (`event_name` + `where` on event_data), chained as 2-step conversions | **PROVEN** (`multistep_funnel`; tutorial 8/5/3, conv≈5/8, 3/5; level_id 12/6/3) |
| **Ordered sequence funnel (row-pattern)** | `register_native_model`: per-user sequence model + semantic model over it; metrics `reached`/`completed`/`conversion`; user-attribute join at the semantic layer; `time_range` / `event_name` / `user_segment` pre-filter | **PROVEN** (12/8/5/3; conv 8/12; group by local dim **and** joined `dim_users` attr in one query; US-segment slice → 4) |
| **N-day retention (D1/D7)** | `conversion` metric, cohort=`first_launch`, returned=`new_session`, window=N days | **PROVEN as window approximation** (see §2) |
| **Acquisition-cohort grid** | group by `{ model: 'users', attribute: 'install_date' }` × `metric_time` | **PROVEN** (`cohort_retention_grid`) |
| **Behavioral cohort (did / didn't do X)** | `sum_boolean` measure + `Metric()`-in-`where` split | **PROVEN** (purchases=8, sessions=21, 7+5 partition) |
| **Visit→purchase conversion** | native `conversion` metric within a window | **PROVEN** (visits=12, rate≈7/12, sliceable) |
| **Level progression / difficulty** | `event_property` dim `level_id` + ratio completes/starts + `average` time | **PROVEN** (starts=28, completes=25, rate=25/28, L1=1.0, L6=0.0) |
| **Python inside a pipeline (statistics, clustering, scoring)** | a `python` stage in `build_native_model` / `register_native_model`, anywhere and any number of times: the pipeline renders as a CHAIN of dbt models (`pipe_<name>_s1 → … → pipe_<name>`) — SQL stages as SQL models, each python stage as a dbt Python model (`def model(dbt, session)`, `dbt.ref` to the previous model, or to the source when first) that dbt runs on the warehouse's Python runtime (BigQuery BigFrames/Dataproc, Snowpark, PySpark; DuckDB locally); a python stage declares `output.columns` for the SQL stages after it. The stage description carries the platform's own rules from its docs — on BigFrames: `bigframes.ml` (scikit-learn API run as BigQuery ML) instead of sklearn, vectorized column ops instead of `apply`/`iterrows` (a Python `apply` becomes a Cloud Run remote function), deferred execution, `cache()` only for a reused intermediate, no reliance on row order, and NO INDEX on the frame `dbt.ref()` returns — so a lookup is a `merge`, never `Series.map(dict)`, and filtering one frame by another frame's Series raises `NullIndexError`. These are RULES the stage description carries, not static refusals (whether a line trips them depends on how it is written); the FULL authoring guide for the runtime — the constraints with why they exist, plus one worked do/avoid example per task (lookups, per-group aggregates, distinct values, top-N, CASE, caching, struct/array accessors, `bbq` SQL functions, `bigframes.ml`) — is served through `semantic_index({ guide: "python" })`, and a run that fails with `NullIndexError` / `OrderRequiredError` comes back with what that error class is about on this runtime; on Spark `pyspark.ml`; on Snowflake `snowflake.ml.modeling`. Caller declares allowlisted imports (an enum in the schema), its own functions over the frame `dbt.ref()` returns on that warehouse — BigFrames / Snowpark / PySpark / a DuckDB relation, untouched; pandas only if a function converts explicitly (body = nested arrays, nesting = indentation, one recursive `$defs.py_block`) and the ordered calls; bodies pass a static AST gate; `dbt.ref`/`dbt.config`/`return` are generated. The stage is in the schemas only where the dbt profile can run Python models (BigQuery with a submission set up, Snowflake, Databricks, DuckDB; `MCP_PYTHON_MODELS=on|off` overrides), and the overview reports `python_models`. Result read with `get_query_result` as any pipeline | **PROVEN on dbt-duckdb** (`python-stage.test.js`: per-player z-scores −0.1355/−1.1514/+1.2869, tiers low/low/high/low; a python → SQL → python → SQL chain of four models yields the one positive-z player p3 with n=2, revenue 65; runtime error surfaced from dbt) |
| **Monetization: revenue / ARPPU / AOV** | sum + count_distinct + ratios, by product/segment/day | **PROVEN** (revenue=85, payers=7, AOV=85/8, product 15/30/40) |
| **Ad monetization** | revenue on `ad_finished.revenue`, dims network/placement/ad_type, rev-per-impression | **PROVEN** (ad rev=29, impr=12, rev_per_imp=29/12) |
| **In-game economy (sources vs sinks)** | `derived` metric net = coins_in − coins_out | **PROVEN** components (510/140/370); derived metric itself **RUN-PROVEN** |
| **Stickiness (DAU/MAU)** | active users at day vs month grain (ratio post-computed) | **PROVEN** (active=12, peak=6, DAU≤MAU) |
| **Continuing a pipeline on what it already built (checkpoints)** | `materialize` keeps the draft open and records the built table as the pipeline's PREFIX: the steps added next read that table (`from_checkpoint` / `steps_recomputed` in every response) instead of recomputing an expensive prefix, and several materializations chain. Invalidation is positional — an edit at or before a prefix retires it (`checkpoints_dropped`), an edit after it keeps it — plus the value index's run marker for freshness. `fork` inherits the prefixes it keeps and reads the SAME table (its definition is copied into the fork's overlay so `ref` resolves; nothing is rebuilt), so dropping the owner is refused while a fork reads it. What may follow a prefix is decided by the columns that survived into it (a funnel needs the source's event columns) | **PROVEN** (`pipeline-checkpoint.test.js`: a continued pipeline returns the same rows as the same pipeline built in one go; an edit after the prefix keeps it and still matches a full recompute; changing the DATA in the prefix's table changes the continuation — so the table is read, not recomputed; a fork matches an independent recompute and reads the inherited table) |
| **Result materialization & re-slicing** | `materialize:true` persists a result table; `get_query_result` polls by `query_id` or reads the table; `transform` re-slices (where/group_by/agg/having) without recompute | **PROVEN** |
| **All 13 recipes build & run** | `get_recipe → create_semantic_model → query` | **PROVEN** (every recipe parses + runs) |

**Example questions it answers well:**
- DAU/WAU/MAU and total events over a period; peak DAU.
- IAP revenue / payers / ARPPU / AOV by country / platform / media_source / acquisition_type / product.
- Level completion rate and starts/completes per level; where users drop off.
- Tutorial step_1→step_2→step_3 drop-off and step-to-step conversion.
- Activation funnel `first_launch → tutorial steps` per-user, sliced by country/platform, or built for US users only.
- Visit-to-purchase conversion within 7 days, by country.
- D1/D7 return rate (within window).
- Ad revenue & impressions by network/placement/type; rev-per-impression.
- Coins earned vs spent by source; net coins.
- Revenue by install-date cohort × activity day.
- Sessions of users who purchased vs who didn't.

---

## 2. Partial / works with caveats

- **N-day retention is a conversion-window approximation, not point-in-time D-N.** "Returned within N days," not "active exactly on day N." Documented in the recipe note.
- **Per-day conversion rate is NOT bounded by 1.** Grouped by `metric_time`, returns are attributed across day boundaries within the window, so a single day's numerator can exceed that day's cohort. Only the **aggregate** rate is a true [0,1] rate (the test asserts per-day values are finite & non-negative, not ≤1).
- **Cumulative metrics / LTV curves — BY DESIGN, untested.** The `cumulative` type compiles and a daily time spine is always materialized, but there is no cumulative recipe or data test; LTV is described only as a post-hoc layer.
- **Native-sequence time/value metrics (`avg_seconds_between`, `agg_at_step`) — BY DESIGN, untested.** Generated for both dialects and exposed as measures, but no test exercises them.
- **`percentile` measures — input-validated only.** Compiles, but no value is asserted on data.
- **N-step funnel in pure MetricFlow is composed, not native.** Chain 2-step conversions, or use the row-pattern native model (the true multi-step engine).
- **`strict` (contiguous-adjacency) funnels — only on the production warehouse target, rejected on the Postgres test path** (honest guardrail rather than wrong numbers). Therefore unverified by tests.

---

## 3. Hard boundaries — not possible

- **Anything needing a source the catalog does not declare.** The schema enums are the boundary: the AI cannot name a table that is not a catalog role. What IS available is whatever the catalog declares — several events sources (product analytics, crash reports), the install record, experiment assignments, and a measures source such as acquisition spend, whose amounts the schema marks aggregatable (so ad-spend / ROAS questions ARE in scope once that source is in the catalog). A table nobody declared, and a role no catalog defines, stay out of scope.
- **Exact point-in-time D-N retention** (active precisely on day N): only window-approximated.
- **Open-ended path / flow discovery** (top user paths, Sankey over `screen_changed`): only fixed, hand-built sequences are expressible; there is no path-discovery / top-N-path engine.
- **Window functions or raw SQL inside semantic models** (`LAG/LEAD/ROW_NUMBER/RANK`, subqueries): not expressible; `derived` metrics are limited to safe arithmetic over other metrics. The row-pattern native model is the only escape hatch, and only for ordered sequences.
- **A self-join of ONE source** (event-to-event inside the same table): only via conversion metrics or the sequence engine — a join stage always targets a DIFFERENT model. Joins BETWEEN sources are no longer 1-hop-limited: join stages stack, so one pipeline chains several declared relationships (crash reports → the ad funnel's events → the install record valid at that moment → that player's spend). In a metric query the reach is the declared entity graph: only a relationship some model OWNS has a `<relationship>__<attribute>` path; one nobody owns (a many-to-many match, e.g. an ad-funnel id shared by several events) is a pipeline join, by nature.

---

## 4. Open questions & known issues (before production)

Consolidated from the code-quality and production-readiness audits. Severity is the auditors'.

### ✅ Fixed in the post-audit pass (proven by tests)
- **Funnel `where`/`order_by` now applied** (was silently dropped) — `match_recognize` queries translate `where` to the shared-entity paths and pass `order_by` to MetricFlow. Proven: `match-recognize.test.js` "where on a view dim is applied" (furthest=tut3 → 3 users) and "order_by is applied".
- **Deterministic paging + meaningful `has_more`** — core path over-fetches one row so `has_more` is real; materialized reads page in JS over a single read (no non-deterministic SQL `OFFSET`) and return `page.has_more`. Proven: `materialize.test.js` "materialized paging … reconstruct the full stored result".
- **Process lifecycle** — `SIGTERM`/`SIGINT` handlers close the warm sidecar + SQLite (`Engine.close`/`JobManager.close`); per-query `mf` temp dirs are removed in a `finally`.
- **Context GC** — `ContextManager.gc(maxIdleMs)` reclaims idle, **lease-free** contexts; optional periodic sweep via `CONTEXT_TTL_MS`.
- **Smaller fixes** — constant-time auth-token compare (`crypto.timingSafeEqual`); `update_semantic_model` no longer mutates state/files on `dry_run`; `get_query_result` requires `context_id` only with `table` (poll-by-`query_id` needs no context).

### Still open — production-readiness
- **[CRITICAL] The production query runner is untested.** Production wires the `mf`/`dbt` **CLI runner** (`src/server.js` `makeEngine` → `DbtRunner`), but every integration test injects the **Python sidecar** (`MfEngineBackend`). The two have divergent error/result contracts (the CLI extracts SQL by scanning stdout; the sidecar returns structured SQL, which the materialize flow writes verbatim into a dbt model). → Run the suite against `DbtRunner` too, or default production to the tested sidecar.
- **[CRITICAL — verify] BigQuery `MATCH_RECOGNIZE` path has zero test coverage.** The native funnel's BigQuery SQL is only exercised via the Postgres equivalent in tests. One audit flagged that **GoogleSQL may not support `MATCH_RECOGNIZE`** — validate on a live BigQuery instance before relying on native funnels in production; if unsupported, add a window-function / ordered self-join fallback (the same logical shape the Postgres path already produces).
- **[unverified on BigQuery/Snowflake]** `jsonExtract` (`JSON_VALUE`/`CAST … AS INT64`; Snowflake `col:key::type`) and the time-spine SQL (`generate_date_array` / `seq4()`) are code-complete but only the Postgres branches are executed by tests.
- **[MEDIUM] No warehouse `qr_*` result-table sweeper.** Context overlay GC now bounds the workspace, but materialized result tables in the warehouse are still only reclaimed when their context is dropped. → Add a sweeper for completed/aged jobs.

### Still open — smaller
- **[MEDIUM]** `describe_context` for a native model still lists bare attribute names while the query path qualifies them as `entity__attr` — cosmetic reconcile.
- **[LOW]** No response-size cap (rows are bounded by `limit ≤ 100000` only); unknown logical types fall through `jsonExtract` uncast (validate types at catalog load); some dead/unused code (`MfEngineBackend` is wired in tests but not in `makeEngine`; single-row `renderBigQuery`/`renderPostgres`/`renderSequence`; `DbtRunner.validate`).

### What is solid (all three audits agreed)
- **Injection defense is consistent and layered** — typed predicate trees, strict identifier/path/JSON-key regexes, `sqlLiteral` everywhere, catalog-enum-bounded schemas, and a safe-arithmetic allowlist for `derived` metrics. No injection or path-traversal holes found (injection/escaping is even proven on data in the materialize suite).
- **Context isolation is real** — per-context overlay projects with isolated `target/`, registry reconciliation against disk, and leases that prevent drop-during-build.
- **Background-job machinery is durable** — timeout→background, SQLite persistence with restart reconciliation, graceful in-memory fallback, results re-fetchable by table even if the job record is gone.
- **The MetricFlow-over-a-generated-view funnel architecture is elegant** and proven on data (the `dim_users` join happens at SQL-generation via a shared entity, not baked into the view). The Postgres path honestly rejects `strict` mode rather than returning wrong numbers.

---

## 5. Readiness verdict

> **Pilot-ready on Postgres; prototype against the stated BigQuery production target.**

The semantic-layer/MetricFlow integration, context isolation, materialization/job machinery, and injection safety are well-built and **proven on data** for the full set of two-source mobile-game analytics. The dominant gap is the distance between *what is tested* (Postgres via the sidecar runner) and *what ships* (BigQuery via the CLI runner): both the production runner and the BigQuery funnel SQL are currently unexercised.

**Top recommendations before production** (the funnel `where`/`order_by`, deterministic paging, lifecycle handlers, and context GC from the original list are now done — see §4):
1. Validate the whole stack against a real BigQuery instance — especially `register_native_model` (the `MATCH_RECOGNIZE` SQL), `jsonExtract`, the time spine, and metric_time/cumulative/conversion metrics.
2. Test the production CLI runner (or default production to the already-tested sidecar).
3. Provide a BigQuery funnel that does not depend on `MATCH_RECOGNIZE` if it proves unsupported.
4. Add a warehouse `qr_*` result-table sweeper to complement the new context GC.
