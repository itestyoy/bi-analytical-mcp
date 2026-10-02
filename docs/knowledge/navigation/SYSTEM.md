# SYSTEM

Fast entrypoint for the system: what bi-analytical-mcp is and how a question flows through it.

## Parent

- [`../architecture/AGENTS.md`](../architecture/AGENTS.md)

## Children

- [`REPOSITORY_MAP.md`](REPOSITORY_MAP.md) - where each part of the code lives.
- [`API.md`](API.md) - the MCP surface: tools, resources, skills, the Apps view, the HTTP endpoint.
- [`DATABASE.md`](DATABASE.md) - the catalog, the warehouses, the server's own store.
- [`EVENTS.md`](EVENTS.md) - tasks, background indexing, notifications, timers.

## Related

- [`../projects/bi-analytical-mcp/AGENTS.md`](../projects/bi-analytical-mcp/AGENTS.md) - project index: stack, commands, hotspots.
- [`../../../AGENTS.md`](../../../AGENTS.md#project-conventions) - the project's conventions and HARD RULES.
- [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) - the long-form architecture.

## Map

| Area | Location | Purpose |
|------|----------|---------|
| MCP server | `src/server.js`, `src/mcp-server.js`, `src/mcp-surface.js` | Serves the tools over the official SDK v2 (2026-07-28 and 2025 clients) |
| Engine | `src/engine.js`, `src/engine/` | Validates calls, builds contexts, starts and reads tasks |
| Catalog | `src/catalog.js`, `src/catalog/`, `config/catalog.yml` | The sources by role (events, users, experiments, measures) and their joins |
| Semantic side | `src/compile.js`, `src/yaml-render.js`, `src/semantic-*.js` | Named metrics through dbt + MetricFlow |
| Pipeline side | `src/pipeline.js`, `src/pipeline/`, `src/match-recognize.js` | One-off derived tables: stages rendered to SQL |
| dbt client | `src/dbt/` | The only way to reach dbt / `mf`, per major version and named environment |
| Result cards | `src/apps/` | The MCP Apps views (built, checked in) |
| Feature | `src/retentioneering/` | Path analysis; on only with `MCP_RETENTIONEERING=on` |

## Notes

- A question flows: `semantic_index` (what exists) → `build_semantic_model` (reusable metrics) or `build_pipeline_model` (a one-off table) → `query_*` starts a task and returns its `task_id` at once → the same side's query tool reads it back with `{ task_ids }` → `display_model_result` draws a card, once.
- Two warehouses, two dialects: BigQuery (production) and DuckDB (local work and tests).
- Every tool takes one field, `request`; its schema is the portable subset and is never cut.

## Source Of Truth

- Current source code and tests.
- [`AGENTS.md`](../../../AGENTS.md) Project Conventions.
