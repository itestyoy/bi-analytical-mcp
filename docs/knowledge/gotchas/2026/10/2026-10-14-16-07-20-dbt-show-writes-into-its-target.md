---
title: A dbt show writes into the target/ it runs in
status: Active
occurrences: 1
last_reviewed: 2026-10-14
tags: [dbt, dbt-v2, target, context-lifecycle]
source_of_truth:
  - src/dbt/v2.js
  - src/dbt/v1.js
  - test/integration/target-files.test.js
---

# A dbt show writes into the target/ it runs in

## Reasoning Pattern

- For multi-step debugging or prevention work, follow [Agent Planning and Reflection Pattern](../../../patterns/2026-08-12-11-39-23-agent-planning-reflection-pattern.md): isolate the issue, test the smallest change, observe the result, and update the prevention note.

## Status

Active

## Occurrences

1

## Last Reviewed

2026-10-14

## Problem

`dbt show --inline` is a read, but dbt treats it as a command with artifacts, written to the
target/ it runs in:

- **dbt v2 (2.0.6)** writes the query under a fresh id on every call — `target/inline_<id>.sql`,
  `target/compiled/target/inline_<id>.sql` and `…/inline_<id>.macro_spans.json` — and no later
  `show`, `parse` or `run` removes them. Every read of a context added three files: a page of a
  task, a drill-down, a probe. A context lives until CONTEXT_TTL_MS retires it, which by default
  is never. The internal `_warehouse` context, through which the value index and the probes read,
  is pinned, and each indexing pass runs many shows in it.
- **Both majors** rewrite `target/manifest.json` and `target/semantic_manifest.json` on a show. The
  semantic manifest is what MetricFlow reads, and on the latest spec `parse()` corrects its
  percentiles afterwards (`restorePercentiles`, src/dbt/v1.js). A show writes it again without the
  correction: `use_approximate_percentile` goes back to `true` (v2 also rounds 0.9 to
  0.8999999761581421). Seen in the manifest file on dbt 1.12.5 and 2.0.6. Not traced to a metric
  query's result.
- dbt 1.x (1.12.5) writes only one file per show, `compiled/<project>/…/sql/inline_query`, and
  rewrites it in place, so the file count stays the same.

## Prevention

A command whose artifacts nobody reads runs in a throwaway target: `DBT_TARGET_PATH` set to a temp
directory that is removed afterwards (`_dbt`, src/dbt/v1.js — the batch members' isolation). dbt
v2's client runs every show that way (src/dbt/v2.js). It costs nothing there, because v2 keeps no
partial-parse cache and parses the whole project on every call anyway. Measured on DuckDB: a
400-model project, 1101 ms vs 1042 ms, 12 interleaved CLI calls each; a context's reads, median
734 ms vs 738 ms. The lifecycle check is test/integration/target-files.test.js. It counts the
files in a context's target/ before and after repeated reads of a stored pipeline table, on the
test environment and on `dbt-v2`.

Still open: dbt v2's `dbt run` adds two parquet files per invocation under
`target/private/metadata/run/{invocations,results}/` and never compacts them. That is per build,
not per read. On 1.x, a show still rewrites the context's semantic manifest.

## Source Of Truth

- `src/dbt/v2.js` (`show`), `src/dbt/v1.js` (`_dbt`)
- `test/integration/target-files.test.js`, `test/unit/dbt-client.test.js`

## Sources

- [src/dbt/v2.js](../../../../../src/dbt/v2.js)
- [src/dbt/v1.js](../../../../../src/dbt/v1.js)
- [test/integration/target-files.test.js](../../../../../test/integration/target-files.test.js)
