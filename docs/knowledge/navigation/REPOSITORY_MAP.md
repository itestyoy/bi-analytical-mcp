# REPOSITORY_MAP

Fast entrypoint for the repository: one line per area.

## Parent

- [`AGENTS.md`](AGENTS.md)

## Children

- [`API.md`](API.md)
- [`DATABASE.md`](DATABASE.md)
- [`EVENTS.md`](EVENTS.md)

## Related

- [`../projects/bi-analytical-mcp/AGENTS.md`](../projects/bi-analytical-mcp/AGENTS.md)
- [`SYSTEM.md`](SYSTEM.md)

## Map

| Area | Location | Purpose |
|------|----------|---------|
| Server entry | `src/server.js` | HTTP endpoint `/mcp`, 2025 sessions, health check, timers |
| Protocol surface | `src/mcp-server.js`, `src/mcp-surface.js`, `src/mcp-tasks.js`, `src/legacy-sessions.js`, `src/client-extensions.js`, `src/surface-change.js` | What is offered and to which client |
| Tool definitions | `src/tools/` | One definition per tool (`defineTool`); the core's in `core.js` |
| Input schemas | `src/schema.js`, `src/schema/`, `src/schema-kit.js` | Built from the catalog; `outputs.js` for answers of one shape |
| Validation | `src/validate.js` | Ajv over the published schema, refusals in words |
| Engine | `src/engine.js`, `src/engine/` | One file per tool family; services (`tasks`, `notes`, `advisor`, `probe`, `indexViews`) |
| Task runtime | `src/task-runner.js`, `src/jobs.js`, `src/tasks.js` | Tasks, batches, reads, cancel |
| Catalog | `src/catalog.js`, `src/catalog/` | Roles, entities, measures, grounding against the warehouse |
| Semantic layer | `src/compile.js`, `src/yaml-render.js`, `src/semantic-latest.js`, `src/semantic-manifest.js`, `src/project-semantics.js`, `src/group-by-items.js`, `src/predicate.js` | Declarations → YAML → MetricFlow; the project's own layer |
| Pipelines | `src/pipeline.js`, `src/pipeline/`, `src/match-recognize.js`, `src/projection.js`, `src/python-model.js` | Stages, expressions, conditions, funnels, reads of stored tables |
| Conditions | `src/conditions.js` | The one comparison writer and condition-list rendering |
| dbt | `src/dbt/` | dbt client (v1 / v2), environments and their pinned specs |
| Dialects | `src/dialects/` | DuckDB and BigQuery SQL |
| Store | `src/store.js`, `src/error-log.js`, `src/memory.js`, `src/value-index*.js` | SQLite store: tasks, value index, memory, errors |
| Guides | `src/guide.js`, `src/research-guides.js`, `src/python-guide.js`, `src/recipes.js`, `config/recipes.json` | What `semantic_index({ guide | recipe })` serves |
| Apps views | `src/apps/` | Result and retentioneering cards (vite build, checked in) |
| Feature | `src/retentioneering/`, `python/retentioneering_*.py` | Path analysis feature |
| Settings | `src/settings.js`, `src/config.js`, `.env.example` | Every environment variable, one row each |
| Config | `config/` | Catalog, recipes, generated facts sheets |
| Python | `python/` | MetricFlow group-bys, the python-stage AST gate, retentioneering models |
| Scripts | `scripts/` | Facts generators, dbt environments, name lint, `.env.example` |
| Tests | `test/unit/`, `test/integration/`, `test/helpers/` | Unit guards; integration on DuckDB + dbt + MetricFlow |
| Evals | `evals/` | Golden questions through the tools; `eval:check` holds their truths |
| Docs | `docs/` | Long-form docs (architecture, capabilities, schema authoring, Docker); `docs/knowledge/` is the agent knowledge router |

## Notes

- Generated: `node_modules/`, the Apps build output under `src/apps/*/dist`, `python/__pycache__/`.
- `temp/` holds copies of production files sent for validation (`schema.yml`, `recipes.json`) and the record of how they were checked (`VALIDATION.md`); `config/catalog.yml` is the production catalog the tests hold the surface to.

## Source Of Truth

- Current source code and tests.
- [`../projects/bi-analytical-mcp/AGENTS.md`](../projects/bi-analytical-mcp/AGENTS.md).
