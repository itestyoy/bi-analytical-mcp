# EVENTS

Fast entrypoint for asynchronous work: tasks, background indexing, protocol notifications, timers.

## Parent

- [`AGENTS.md`](AGENTS.md)

## Children

- `src/task-runner.js` - the task runtime (`engine.tasks`).
- `src/value-indexer.js` - the background value index.

## Related

- [`API.md`](API.md)
- [`SYSTEM.md`](SYSTEM.md)

## Map

| Area | Location | Purpose |
|------|----------|---------|
| Tasks | `src/task-runner.js`, `src/jobs.js` | Every build and query is a task: started in the call, run in order per context (a batch side by side), read with `{ task_ids }`, cancelled with `{ task_ids, cancel: true }`; persisted in `jobs` |
| Protocol tasks | `src/mcp-tasks.js`, `src/tasks.js` | The Tasks extension: a long call becomes a protocol task the host polls |
| dbt processes | `src/dbt/process.js` | One process per warehouse turn (DuckDB is one file); a task's AbortController stops its process |
| Value index | `src/value-index.js`, `src/value-indexer.js`, timer in `src/server.js` | Profiles property values per `(source, property)` at start and every `VALUE_INDEX_REFRESH_MS` |
| Context GC | `src/server.js` (`engine.gc`) | Drops contexts idle longer than `CONTEXT_TTL_MS` (0: never); the project's own contexts are pinned |
| Sessions | `src/legacy-sessions.js` | 2025 clients' sessions; idle ones closed after `MCP_SESSION_IDLE_SECONDS` |
| Surface change | `src/surface-change.js` | Announces `tools/list_changed` / `resources/list_changed` after a deploy that changed the surface |
| Progress | `src/mcp-surface.js` | Heartbeats for a call carrying a progress token (`MCP_PROGRESS_INTERVAL_MS`) |

## Notes

- A call never waits inside the call that starts work; reading waits at most 30 s per call.
- Every failure (a refused call, a failed task, a start that could not serve) is kept in the store's `errors` table.

## Source Of Truth

- `src/task-runner.js`, `src/mcp-tasks.js`, `src/server.js` and their tests (`test/unit/task-lifecycle.test.js`, `test/unit/mcp-tasks.test.js`, `test/unit/server-restart.test.js`).
