---
title: dbt v2 show files accumulate in a context's target/
status: done
last_reviewed: 2026-10-14
last_used: 2026-10-14
tags: [dbt, dbt-v2, target, context-lifecycle]
source_of_truth:
  - src/dbt/v2.js
  - docs/knowledge/gotchas/2026/10/2026-10-14-16-07-20-dbt-show-writes-into-its-target.md
---

# dbt v2 show files accumulate in a context's target/

## Status

done

## Last Reviewed

2026-10-14

## Last Used

2026-10-14

## Context

Under dbt v2, every `dbt show --inline` left three new files in the context project's target/,
named for a fresh id, and nothing removed them. Reads of a task, drill-downs, probes and the value
index all take that path. Only batch members escaped, because they run with an isolated
`DBT_TARGET_PATH`.

## Objective

Repeated reads of one stored pipeline table under dbt v2 leave the context's target/ with a constant
number of files.

## Expected Result

The v2 client's show writes nothing that stays in the context's target/. A lifecycle check holds
that, and the AGENTS.md verification set passes.

## Scope

- `src/dbt/v2.js` (the change), with doc comments in `src/dbt/v1.js` and `src/request-context.js`
- `test/integration/target-files.test.js` (new) and `test/unit/dbt-client.test.js`

## Acceptance Criteria

- [x] Repeated reads under dbt v2 leave target/ at a constant file count.
- [x] dbt 1.x checked for per-call files.
- [x] A lifecycle check counts target/ files before and after several reads.
- [x] lint:names, unit, integration and eval:check pass. Integration has 2 failures that also
  happen on the base commit (see Verification).

## Investigation

- Reproduced with dbt 2.0.6 on a scratch DuckDB project: each show added `target/inline_<id>.sql`,
  `target/compiled/target/inline_<id>.sql` and `…/inline_<id>.macro_spans.json` (57 → 60 → 63 → 66).
- The same show also rewrites `target/manifest.json`, `run_results.json` and
  `semantic_manifest.json`. A marker put into the semantic manifest was gone after one show. After
  `parse()` and one show, the percentile in the file read back as approximate:
  `0.8999999761581421, use_approximate_percentile: true`. With the fix, it stays as `parse()`
  restored it.
- `--no-write-json` stops the manifest rewrites, but the three inline files are still written, so
  it does not fix the growth.
- dbt 1.12.5 writes `compiled/<project>/…/sql/inline_query` once and rewrites it in place: the file
  count stays the same. It does rewrite `semantic_manifest.json` on each show, and that also turns
  `use_approximate_percentile` back to `true` there. This was not fixed (see Follow-Up).
- Cost of a throwaway target on v2 (DuckDB): a 400-model project, 12 interleaved CLI calls, 1101 ms
  in the own target vs 1042 ms in a throwaway one. Through the engine, 18 reads each, median 734 ms
  without the fix and 738 ms with it. v2 does no partial parsing by default (`--partial-parse` is
  opt-in), so a show parses in full either way.
- v2's `dbt run` adds two parquet files per call under `target/private/metadata/run/` and never
  compacts them (19 after 19 runs). That is per build, not per read, and out of scope.

## Dead Ends

- Option (a), deleting the `inline_*` files a call added: the warehouse turn is released before
  the call returns. On BigQuery, which has no turn, two shows on one project run at once, so a
  before/after diff can delete another show's file while it is still running. It also leaves the
  manifest rewrite in place.

## Decision

Option (b). `DbtV2.show` runs inside `isolatedTarget`, the same throwaway `DBT_TARGET_PATH` that
batch members already use (`_dbt`, src/dbt/v1.js). The change stays inside src/dbt/, with no
branching on the dbt version anywhere else.

## Verification

- test/integration/target-files.test.js without the fix: dbt-v1 passes, and dbt-v2 fails with 78
  files before six reads and 96 after. With the fix, both pass.
- The new unit test in test/unit/dbt-client.test.js fails without the fix and passes with it.
- `npm run lint:names`: clean.
- `npm test`: 594 pass. The 2 skips need the `retentioneering` environment.
- `npm run test:integration` (dbt-v1): 455 pass, 43 skipped (`retentioneering`), and 2 fail. The
  same 2 fail on the base commit without this change: condition-grammar (the test writes `op: 'ne'`,
  which the schema refuses) and cumulative-window (`mf` cannot load the semantic manifest).
- `npm run eval:check`: all 14 cases hold.
- `DBT_ENV=dbt-v2 npm run test:integration`, with the fix: 455 pass, 43 skipped, and 1 fail (the
  same condition-grammar test, which fails before any dbt call).

## Result

A context's target/ no longer grows with reads under dbt v2, and its semantic manifest keeps
`parse()`'s percentile correction across reads.

A failed show now cites `inline_<id>.sql` from the throwaway directory. That file is gone by the
time an error record is written, so the record no longer picks up the inline query's compiled SQL.
Batch members already behaved this way. The warehouse's own message still quotes the failing line.

## Source Of Truth

- `src/dbt/v2.js`
- [The gotcha](../../../../gotchas/2026/10/2026-10-14-16-07-20-dbt-show-writes-into-its-target.md)

## Durable Knowledge Updates

- Gotchas: [A dbt show writes into the target/ it runs in](../../../../gotchas/2026/10/2026-10-14-16-07-20-dbt-show-writes-into-its-target.md)
- Decisions: None
- Invariants: None
- Patterns: None
- Runbooks: None
- Project or architecture documentation: None

## Follow-Up

- dbt 1.x: a show into the context's own target/ rewrites `semantic_manifest.json` and drops
  `restorePercentiles`' correction (`use_approximate_percentile: true`). This is the default
  environment, so a percentile metric queried after a read on the same context may be computed
  approximately. Not yet traced to a query result.
- dbt v2: run metadata grows by two parquet files per `dbt run`.
