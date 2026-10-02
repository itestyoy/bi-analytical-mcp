# DATABASE

Fast entrypoint for the data: the catalog the analytics read, the warehouses they run on, and the server's own store.

## Parent

- [`AGENTS.md`](AGENTS.md)

## Children

- [`../../SCHEMA_AUTHORING.md`](../../SCHEMA_AUTHORING.md) - how a catalog is written (`config.meta.mcp`).
- [`../../SCHEMA_ACQUISITION_CRASHLYTICS.md`](../../SCHEMA_ACQUISITION_CRASHLYTICS.md) - the measures and second events source, worked through.

## Related

- [`../../../AGENTS.md`](../../../AGENTS.md#data-model-hard-rule) - the data model HARD RULES (roles, joins, point-in-time).
- [`REPOSITORY_MAP.md`](REPOSITORY_MAP.md)

## Map

| Area | Location | Purpose |
|------|----------|---------|
| Catalog | `config/catalog.yml`, loaded by `src/catalog.js` + `src/catalog/` | The sources by role: events sources, users, experiments, a measures source; their entities (join keys), measures, time axes |
| Test catalog and warehouse | `test/integration/fixtures/catalog.yml`, `test/integration/fixtures/dbt_project/` | The fixture world: seeds and dbt models every integration test and eval reads |
| Warehouses | `src/dialects/{duckdb,bigquery}.js`, profiles via `src/dbt/` | DuckDB (local, tests) and BigQuery (production) |
| Generated models | `src/context-manager.js` | Each context is a dbt project copy with its generated semantic YAML / pipeline models |
| Server store | `src/store.js` (SQLite at `MCP_DB`; the memory may have a file of its own, `MCP_MEMORY_DB`) | `jobs` (tasks), `prop_*` + `index_run*` (the value index; cache), `memory` + `memory_vec_meta` (kept), `server_meta` (surface fingerprint; kept), `errors` (kept) |

## Notes

- A source is identified by its `meta.mcp.role`, never by its name; join keys are declared in the schema, never passed at the call site.
- Cache tables are rebuilt by indexing; `kept` tables survive `MCP_DB_RESET`.

## Source Of Truth

- `src/catalog.js`, `src/store.js` and their tests (`test/unit/catalog-*.test.js`, `test/unit/store.test.js`).
