# API

Fast entrypoint for the external surface: one HTTP endpoint serving the Model Context Protocol.

## Parent

- [`AGENTS.md`](AGENTS.md)

## Children

- [`../../CAPABILITIES.md`](../../CAPABILITIES.md) - what each capability does and which tests prove it.
- [`../../DOCKER.md`](../../DOCKER.md) - running the server, settings, the client-facing contract.

## Related

- [`SYSTEM.md`](SYSTEM.md)
- [`EVENTS.md`](EVENTS.md) - how a started task is read back.
- [`../../../AGENTS.md`](../../../AGENTS.md#protocol-surface) - the protocol HARD RULES.

## Map

| Area | Location | Purpose |
|------|----------|---------|
| HTTP | `src/server.js` | `POST/GET /mcp` (MCP), `GET /healthz`; Origin check |
| Protocol | `src/mcp-server.js` | 2026-07-28 per-request handler + 2025 sessions (`src/legacy-sessions.js`) |
| Tools | `src/tools/core.js`, `src/retentioneering/index.js` | One definition each; input `{ request }`, schema from `src/schema.js` |
| Answer schemas | `src/schema/outputs.js` | `outputSchema` of the tools whose answer has one shape |
| Resources | `src/apps.js`, `src/skills.js` | The `ui://` view pages; skill files (Skills extension) |
| Extensions | `src/client-extensions.js` | Apps, Skills, Tasks — offered only to a client that declares them |

### Tools

| Tool | Role |
|------|------|
| `semantic_index` | The catalog: overview, a source's events and properties, models, search, guides, recipes |
| `build_semantic_model` / `query_semantic_model` / `preview_semantic_model` | The governed side: named metrics, their queries (tasks), inspection |
| `build_pipeline_model` / `query_pipeline_model` | The pipeline side: one-off tables built stage by stage, read with projections |
| `display_model_result` / `drill_result` | Draw a model result as a card (once); a drawn card's drill-down read |
| `experiment` | A/B statistics over numbers the caller brings |
| `context` / `delete_context` | Read / remove the contexts builds produce |
| `memory` | Durable analyst notes linked to catalog entities |
| `explore_errors` | The kept failures, with what reproduces them |
| `time` | A timer |
| `build_retentioneering_model` / `query_retentioneering_model` / `display_retentioneering_result` | The retentioneering feature (only with `MCP_RETENTIONEERING=on`) |

## Notes

- A call that starts warehouse work returns `{ task_id }` at once; the same side's query tool reads it with `{ task_ids }`.
- `structuredContent` rides on a drawn card and on the answers of tools with an `outputSchema`; everything else is text.

## Source Of Truth

- `src/tools/`, `src/schema.js`, `src/mcp-surface.js` and their tests (`test/unit/tool-*.test.js`, `test/unit/mcp-*.test.js`, `test/unit/schema-portability.test.js`).
