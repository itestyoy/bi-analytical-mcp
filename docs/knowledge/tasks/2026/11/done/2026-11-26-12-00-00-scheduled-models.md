---
title: Scheduled models — a build refreshed daily, kept with what its columns mean
status: done
last_reviewed: 2026-11-26
last_used: 2026-11-26
tags: [build_model, scheduled, value-index, dashboards]
source_of_truth: [AGENTS.md, src/engine/scheduled.js, src/scheduled-models.js, test/integration/scheduled-models.test.js]
---

# Scheduled models

## Status

done

## Last Reviewed

2026-11-26

## Last Used

2026-11-26

## Context

A build's table was computed once and expired with MCP_TABLE_EXPIRATION_DAYS. Dashboards need tables
the server keeps fresh, readable by id from any chat, with the meaning of every column kept with them.

## Objective

`build_model({ action: "schedule" })` makes a built draft a scheduled model, refreshed daily.

## Decisions (the user's)

- Refresh only DAILY, with no time of its own: after each value-index sync (which follows the `dbt run`
  of the source models), at most once a UTC day.
- Same dataset as other tables; one server instance (no locking); no cost step.
- Steps are fixed: a change is delete + a new one. Whoever holds the context id may delete it.
- Any build can be scheduled; from_task only from another scheduled model (refreshed base first).
- At container start the start-up sync triggers the refresh of models not refreshed today.
- Unqueried for MCP_SCHEDULED_IDLE_DAYS (7): asleep; the next query answers from the table as it is,
  says so (`scheduled.woken`, `note`), and its refresh starts once that query is answered.

## Verification

- test/integration/scheduled-models.test.js (DuckDB): counts before / after rows are added, once a day,
  sleep and wake, a semantic layer over the scheduled table, the table dropped on delete.
- test/unit/scheduled-models.test.js: order (base first), once a day, sleep, idle 0.
- Not run on BigQuery: persist_docs of the descriptions onto the table.

## Open

- A dashboard reading the table directly is no query the server sees: such a model falls asleep after
  the idle period unless something queries it through query_model.
