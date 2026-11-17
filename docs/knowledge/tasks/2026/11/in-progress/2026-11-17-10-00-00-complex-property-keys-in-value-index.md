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
