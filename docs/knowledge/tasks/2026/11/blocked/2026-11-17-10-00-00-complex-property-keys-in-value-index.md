---
title: Index the keys and values of complex properties (JSON, array, struct)
status: blocked
last_reviewed: 2026-11-17
last_used: 2026-11-17
tags: [value-index, complex-properties, incremental]
source_of_truth: [src/value-indexer.js, src/value-index.js, src/catalog.js]
---

# Index the keys and values of complex properties (JSON, array, struct)

## Status

blocked — on the decisions in Open Questions and on a BigQuery dry-run measurement (needs the owner's go-ahead: no BigQuery runs from an agent session unless asked).

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

## Open Questions

1. Keys: from the catalog's `fields` only (no data read, but a key added to the payload appears only after
   `fields` is updated), or discovered from data (`JSON_KEYS` over the delta, BigQuery) — the acceptance
   criterion "a new key appears after the next sync without manual edits" needs discovery.
2. Percentiles of a numeric key are not additive across deltas: keep min / max (additive) and percentiles of a
   mergeable sketch (BigQuery KLL_QUANTILES; DuckDB has none — percentiles of the latest full scan there), or
   recompute them on a schedule (e.g. weekly full scan of that key).
3. The time budget the sync may grow by.
4. The address of a key: `{ source, property, field }` (the grammar's `{ property, field }` — what a pipeline
   already reads) or a property name of its own (`words_selected[].word_dictionary`).

## Decision (proposed)

- Batch the complex pass like the scalar one: ONE coverage query per source for all its complex properties
  and ONE examples query, instead of two per property — 22 dbt calls become 2–4, which pays for the key pass.
- Per complex property, one key-stats query over the delta: `UNNEST(JSON_QUERY_ARRAY(col))`, per key
  `APPROX_TOP_COUNT`, `APPROX_COUNT_DISTINCT`, `COUNTIF(… IS NOT NULL)`, numeric MIN / MAX / KLL, grouped by
  event and app for coverage (or a GROUPING SETS), merged into the store as a scalar's delta is.
- A key's row in the store is keyed (source, property, field); a key not seen for N syncs is marked inactive.

## Steps

1. Measure on BigQuery (owner's go-ahead): dry-run bytes of the key-stats query on one partition for
   `words_selected`; the current coverage + examples queries for comparison.
2. Batch the complex pass (one query per source) — measure the sync time before/after.
3. Key discovery + key stats + merge; the store's key rows; inactivity.
4. semantic_index: the key's view, search hits on keys; tests on DuckDB data.

## Verification

Not started.
