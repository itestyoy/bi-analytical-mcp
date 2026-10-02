---
title: Knowledge Frontmatter Standard
status: Active
last_reviewed: 2026-07-22
tags: [knowledge, frontmatter, templates]
source_of_truth:
  - docs/knowledge/README.md
  - docs/knowledge/templates/AGENTS.md
  - docs/knowledge/templates/task-template.md
  - docs/knowledge/templates/decision-template.md
---

# Knowledge Frontmatter Standard

## Status

Active

## Last Reviewed

2026-07-22

## Context

The knowledge base needs a machine-readable metadata layer so notes can be parsed, filtered, and maintained without relying only on free-form prose.

## Decision

Use YAML frontmatter at the top of knowledge notes that represent durable or operational content.

Keep the frontmatter small and stable, and place note-specific details in the body sections that already exist in each template.

Always create new notes from the matching template so the frontmatter is included automatically.

Do not add frontmatter to router or index files such as `AGENTS.md`, `README.md`, or the `navigation/` files.

## Consequences

- Notes become easier to parse by code and scripts.
- Metadata can be indexed consistently across note types.
- Template authors need to keep both frontmatter and body sections aligned.
- Agents need to follow templates instead of free-typing note headers.

## Affected Scope

- `docs/knowledge/templates/*.md`
- `docs/knowledge/README.md`
- `docs/knowledge/templates/AGENTS.md`
- Knowledge notes in `decisions/`, `gotchas/`, `invariants/`, `patterns/`, `runbooks/`, `summaries/`, and `tasks/`

## Source Of Truth

- [docs/knowledge/README.md](../../../README.md)
- [docs/knowledge/templates/AGENTS.md](../../../templates/AGENTS.md)
- [docs/knowledge/templates/task-template.md](../../../templates/task-template.md)
- [docs/knowledge/templates/decision-template.md](../../../templates/decision-template.md)

## Supersedes

- None.

## Sources

- [docs/knowledge/README.md](../../../README.md)
- [docs/knowledge/templates/AGENTS.md](../../../templates/AGENTS.md)
- [docs/knowledge/templates/task-template.md](../../../templates/task-template.md)
- [docs/knowledge/templates/decision-template.md](../../../templates/decision-template.md)
