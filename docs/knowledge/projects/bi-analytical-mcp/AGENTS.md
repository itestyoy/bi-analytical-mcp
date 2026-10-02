# bi-analytical-mcp

Project index router for this repository. It keeps orientation short; the rules live in the root
[`AGENTS.md`](../../../../AGENTS.md) (Project Conventions), the maps in [`../../navigation/`](../../navigation/AGENTS.md).

## Snapshot

- Last reviewed: 2026-10-02
- Repository path: `bi-analytical-mcp/`
- Role: an MCP server for product analytics over a fixed data catalog — governed metrics (dbt semantic layer + MetricFlow) and one-off pipeline tables, queried as tasks, drawn as cards in MCP Apps hosts.

## Reasoning Pattern

- For non-trivial repository mapping or onboarding work, follow [Agent Planning and Reflection Pattern](../../patterns/2026-08-12-11-39-23-agent-planning-reflection-pattern.md): map the smallest relevant scope first, check the evidence, and expand only when needed.

## Stack

- Node.js 22, ES modules; `@modelcontextprotocol/server` v2 (+ `node`, `express`, `ext-apps`), Ajv
- dbt (v2 and 1.x) and MetricFlow in named Python environments with pinned packages (`src/dbt/environment-specs.js`)
- Warehouses: DuckDB (local, tests), BigQuery (production)
- Store: SQLite (`node:sqlite`)
- Tests: `node:test`; Apps views built with vite
- Package manager: npm, `package-lock.json`

## Key Commands

- Install: `npm ci`, then `npm run dbt:env -- create` (the dbt / MetricFlow environments)
- Dev: `npm start`
- Build: `npm run build:app` (the Apps views; the build is checked in)
- Test: `npm test` (unit), `npm run test:integration`, `npm run eval:check`
- Lint: `npm run lint:names` (runs before `npm test`)

## Entry Points

- `src/server.js` - HTTP server and the MCP endpoint
- `src/tools/core.js` - the tool definitions; `src/engine.js` + `src/engine/` - what they do
- `src/schema.js` - every input schema, built from the catalog
- `config/catalog.yml` - the production catalog; `test/integration/fixtures/` - the fixture world

## Hotspots

- Schemas and refusals: `src/schema.js`, `src/schema/`, `src/schema-kit.js`, `src/validate.js` — every change is held by `test/unit/schema-portability.test.js` and the size budget.
- Pipelines: `src/pipeline/` (stages, expressions, conditions) and `src/pipeline/earlier.js` (steps stored by an earlier version).
- The semantic side: `src/compile.js`, `src/engine/semantic-query.js`, `src/project-semantics.js`.
- The dbt client: `src/dbt/` — the only place dbt and `mf` are spawned.

## Domain Map

- Catalog and roles → [`../../navigation/DATABASE.md`](../../navigation/DATABASE.md)
- Tools and the protocol → [`../../navigation/API.md`](../../navigation/API.md)
- Tasks and background work → [`../../navigation/EVENTS.md`](../../navigation/EVENTS.md)
- Where code lives → [`../../navigation/REPOSITORY_MAP.md`](../../navigation/REPOSITORY_MAP.md)

## Related Docs

- [`../../../ARCHITECTURE.md`](../../../ARCHITECTURE.md), [`../../../CAPABILITIES.md`](../../../CAPABILITIES.md), [`../../../DOCKER.md`](../../../DOCKER.md), [`../../../SCHEMA_AUTHORING.md`](../../../SCHEMA_AUTHORING.md), [`../../../PIPELINE_RECIPES.md`](../../../PIPELINE_RECIPES.md)
- [`../../../../README.md`](../../../../README.md), [`../../../../evals/README.md`](../../../../evals/README.md)

## Notes

- Tests assert on data from the warehouse, never on generated SQL/YAML text.
- Every environment variable is a row in `src/settings.js`; `.env.example` is rendered from it.

## Source Of Truth

- The repository root `AGENTS.md`, source code, and the most current domain notes.
