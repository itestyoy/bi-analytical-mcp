---
title: Index the keys and values of complex properties (JSON, array, struct)
status: in-progress
last_reviewed: 2026-11-17
last_used: 2026-11-17
tags: [value-index, complex-properties, incremental]
source_of_truth: [src/complex-keys.js, src/value-indexer.js, src/value-index.js, src/catalog.js, src/engine/semantic-index.js, src/search.js]
---

# Index the keys and values of complex properties (JSON, array, struct)

## Status

in-progress — implemented and tested on DuckDB; the BigQuery SQL has not been run (dry-run bytes on one partition and the sync time on production still to measure, with the owner's go-ahead).

## Last Reviewed

2026-11-17

## Context

The value index keeps, for a complex event property (array / struct / JSON), only 5–10 unranked example
values cut at ~200 characters (`complex: true`, `examples_only: true`, `distinct_count: null`), plus its
presence coverage per event and per app. The keys inside are not entities of their own: a search finds a key
only when it shows in a visible example or in the property's description / `fields`. Example:
`words_selected_of_event_data` (array of structs as JSON text, 1.26 B non-null rows, event `level_completed`) —
`word_dictionary` never shows in the examples; `semantic_index({ search: "word_dictionary" })` finds the
scalar `word_dictionary_of_event_data` (event `word_selected`) and the array only as `mentioned`.

## Objective

Every key path of a complex property (`words_selected[].word_dictionary`, …) is indexed by the same incremental
sync as a scalar property: top values with frequencies, distinct count, NULL share, coverage per event and per
app; min / max / percentiles for a numeric key — found by search and readable as a view of its own.

## Scope

- src/value-indexer.js (`_indexComplexCoverage`, the merge path), the store's value tables, semantic_index's
  property view and search, the catalog's complex property spec (`fields`, `encoding`).

## Out Of Scope

- Materializing one-row-per-element tables (≈10 B rows for `words_selected`).

## Known Facts (production, read through semantic_index { status } / { run: 269 } / { source, property }, 2026-11-17)

- A daily sync takes 8.7–10.6 min (runs 265–269: 521–637 s), 251 properties.
- **The sync IS incremental.** `words_selected` total grows by ~3.8–8.7 M a day (1,237,703,579 → 1,262,099,763 over
  runs 264–269) — one day's delta added to what is stored (`MCP_INDEX_MERGE`, default on: rows newer than the
  stored watermark, bounded on the partition column too).
- **A complex property's 20–30 s is per-call overhead, not scan size.** `block_reasons_of_additional_info` (8,290
  non-null rows) takes 24.9 s, `words_selected` (1.26 B) 24.6 s, `analyze_results` (0 rows) 23.3 s. Each complex
  property makes two sequential `dbt show` calls (coverage, then examples), each a dbt process (start, parse,
  compile) plus a BigQuery job. 11 complex properties ≈ 265 s ≈ 45 % of the run; the 240 scalar properties are
  batched (40 per query) and cost little each.
- The catalog already declares the struct's keys for `words_selected` (`fields`: word_number int, word_name string,
  time_from_previous numeric, mistakes_from_previous int, word_dictionary string; `encoding: json`).
- The watermark is MAX of the source's time column (device_time — the client's clock). An event arriving late
  with a time at or before the watermark is never counted (the delta is `time > watermark`).

## Decisions (owner: "everything from the data, nothing by hand")

1. Keys are discovered from the data every sync: a native struct's fields off the warehouse type
   (`structFieldsOfType`), a JSON element's keys by `JSON_KEYS` (BigQuery) / `json_keys` (DuckDB) over the
   rows read (the delta on a merge). A key that is not an identifier is skipped with a run note.
2. Incremental: a delta's values, coverage and numeric summary are merged into what is kept; min / max add
   up exactly; quantiles (101 points) merge approximately as weighted points (`mergeQuantiles`). A key first
   seen in a delta is counted over the whole history once (replace), then merged like the rest.
3. A key unseen for 30 days (`KEY_STALE_MS`) is shown `active: false`; it is never deleted while its
   property is complex.
4. Address `{ source, property, field }`; store id `<property>[].<field>` (`<property>[]` for an array of
   scalars' elements), internal.
5. A JSON object (not an array) is one element, and so is one native struct: its keys are indexed the same
   way. A text property the catalog declares plain whose indexed values are all JSON (`holdsJson` — e.g. the
   crash custom keys) gets its keys indexed too, with no declaration; its own row stays the scalar pass's,
   so its keys keep their own watermark (`prop_keys.watermark`).
6. The complex pass is batched per source: a key discovery query, one coverage query, one stats query and one
   examples query for all its complex properties (was two dbt calls per property).

## Production findings after deploy (2026-11-20)

- Runs 273/274: the REPEATED JSON ad-unit lists failed with "Invalid cast from JSON to STRING" — the project's
  `mcp_relation_columns` reports a REPEATED column by its element's type (JSON), not ARRAY<JSON>; fixed
  (a native array whose type reads JSON is an array of JSON). Run 277: they index, element values correct.
- Run 277: words_selected keys found (4; `word_dictionary` is declared but absent in the data) with coverage,
  but `values_counted: 0` for all. Cause (BigQuery query over one prod day): 240 of 82.5 M `word_name` values
  cast to NaN/±inf (`nan`, `inf`, …), so MIN/MAX of the numeric read were NaN; dbt prints them as bare `NaN`,
  the answer was unparseable and read as no rows. Fixed: a numeric read is finite only (`finiteNumber`);
  `parseShowJson` reads bare NaN/Infinity as null; keys the coverage found with no row of values fail the
  group (nothing written); a kept key with no values whose rows carry it is recounted over the whole history.
- Run 277's batch fell back to per-property; its reason went to the server log only — now a run note.

## BigQuery dry run (2026-11-17, production `bi.fct_analytics_events`, the indexer's own SQL, one day)

Run with the owner's go-ahead; dry run only (nothing billed). Estimates are BigQuery's upper bounds.

- The generated SQL compiles — after one fix: a native `ARRAY<JSON>` column (the ad-unit lists,
  `block_reasons`, …) was read with `CAST(JSON AS STRING)`, which BigQuery refuses ("Invalid cast from JSON to
  STRING"). Its elements are now read as JSON (`itemsJson` in `complexStorage`: JSON_VALUE / JSON_KEYS).
- The events view is a UNION ALL of the prod table (partitioned by `event_date`) and a dev view that parses
  raw JSON and cannot be pruned: ~64 GB of every query on the view is the dev branch, whatever the window.
  `environment = 'prod'` drops that branch (a one-day `COUNT(*)` of words_selected: 80 GB → 16.4 GB). The
  indexer puts no such filter — this is true of every index query today (the scalar pass too), not only of
  the key pass. Decision for the owner: index prod only (a filter on the catalog's required column), or not.
- One day, prod only: key discovery 16.4 GB, coverage 48.5 GB (event_name / bundle_id / time of every row),
  key values ≈ 16 GB, examples ≈ 16 GB. As run today (no environment filter) each is ~80–112 GB.
- The old pass ran a coverage query PER complex property (~112 GB each as run today, ~40 GB prod-only, even
  for the smallest column) plus an examples query each: 11 properties ≈ 2 TB a day by these estimates; the
  batched pass is ~4 queries per source.
- The first sync after deploy counts every key over the whole window once: words_selected alone is ~2.7 TB
  over 180 days (prod only) per query that reads it (coverage, values).

## Review fixes (2026-11-17)

- All of a group's queries run before any write (a failed whole-history count of a new key no longer loses
  it behind the advanced watermark); a refused batch is scanned again per property.
- A native struct's keys are its type's current fields only (a dropped field is not read; it goes inactive);
  a struct whose type is not read falls back to the declared `fields`, and is never read as a scalar element.
- A key is "seen" only when some element holds a value of it (a native field the data stopped filling goes
  inactive).
- BigQuery: an unknown column type gets SQL that compiles over JSON and text alike (`_jsonOf`); top values
  skip NULL (as DuckDB's exact top does).
- A text holding JSON keeps its key pass's watermark in a registry row of no key (`KEY_PASS`), so one with no
  keys (`[]`, double-encoded JSON) is not rescanned over the whole window every sync.
- search: a value of a key recommends the key's own view.
- Open: BigQuery does not see a nested object in the event payload as JSON (its scalar read is JSON_VALUE,
  NULL for an object); the coverage query reads each property's elements once per key (cost — measure on
  BigQuery).

## Steps

1. [ ] Measure on BigQuery (owner's go-ahead): dry-run bytes of the batched queries on one partition; the
   sync time before / after on production.
2. [x] Batch the complex pass (one query per kind per source).
3. [x] Key discovery + key stats + merge; the store's `prop_keys`; inactivity.
4. [x] semantic_index: the property view lists `keys` / `element_values`, the key view
   (`{ source, property, field }`), search hits on keys; tests on DuckDB data.

## Verification

- test/integration/complex-keys.test.js (4) — keys, values, coverage per event, numeric count / min / max,
  views, search, a delta with a new key — against SQL run on the DuckDB fixture.
- the same file: a text column holding a JSON object (custom keys) — its keys, values and coverage, also
  after a delta; the native one-struct SQL run by hand on DuckDB (no fixture column of that type).
- test/unit/complex-keys.test.js — key ids, JSON detection, struct type parsing, quantile / numeric merge, the store's key
  registry on both backends.
- Not verified: the BigQuery dialect's SQL has not been run anywhere.
