# Knowledge Note Naming Standard

## Status

Active

## Last Reviewed

2026-07-22

## Context

The knowledge base had inconsistent instructions for creating notes: some folders only referenced the year, some did not specify a path, and the templates did not show a single filename format. That increased the risk that new documents would be created in different schemes.

## Decision

All new knowledge notes in dated sections must be created in `YYYY/MM` subfolders and named `YYYY-MM-DD-HH-MM-SS-short-title.md`.

For `tasks`, status remains a separate subfolder, so the path becomes `docs/knowledge/tasks/YYYY/MM/<status>/YYYY-MM-DD-HH-MM-SS-short-title.md`.
For `runbooks`, `YYYY/MM` subfolders are not used; runbook files live directly in `docs/knowledge/runbooks/` and are named `YYYY-MM-DD-HH-MM-SS-short-title.md`.

Fixed router and index files such as `AGENTS.md`, `README.md`, and the current navigation map files are not renamed.
The `navigation` section remains a set of fixed map files and does not move to a dated layout.
The template-selection instructions live in `docs/knowledge/templates/AGENTS.md`, and the templates themselves remain without duplicated creation paths.

## Consequences

- The note format becomes consistent and predictable.
- Searching and sorting by time become easier.
- There are explicit exceptions for fixed files that cannot move to date-based names without breaking links.
- `navigation` remains a stable entry point and does not gain unnecessary nesting.
- Template selection becomes faster because it is centralized in one index file.
- Runbooks become easier to find manually and do not require an extra year/month level.

## Affected Scope

- [docs/knowledge/AGENTS.md](../../../AGENTS.md)
- [docs/knowledge/templates/AGENTS.md](../../../templates/AGENTS.md)
- [docs/knowledge/templates/gotcha-template.md](../../../templates/gotcha-template.md)
- [docs/knowledge/templates/task-template.md](../../../templates/task-template.md)
- [docs/knowledge/{summaries,architecture,decisions,invariants,runbooks,patterns,gotchas,tasks,projects}/AGENTS.md](../../..)
- [docs/knowledge/navigation/AGENTS.md](../../../navigation/AGENTS.md)

## Source Of Truth

- Current instructions in [docs/knowledge/AGENTS.md](../../../AGENTS.md).
- Templates in [docs/knowledge/templates/AGENTS.md](../../../templates/AGENTS.md) and the note templates themselves.
- Folder instructions in [docs/knowledge/gotchas/AGENTS.md](../../../gotchas/AGENTS.md) and [docs/knowledge/tasks/AGENTS.md](../../../tasks/AGENTS.md).

## Sources

- [docs/knowledge/AGENTS.md](../../../AGENTS.md)
- [docs/knowledge/templates/gotcha-template.md](../../../templates/gotcha-template.md)
- [docs/knowledge/templates/task-template.md](../../../templates/task-template.md)
- [docs/knowledge/decisions/AGENTS.md](../../AGENTS.md)
