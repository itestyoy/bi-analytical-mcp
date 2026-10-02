---
title: Adopt the knowledge-router agent kit; AGENTS.md is the single source of agent rules
status: Active
last_reviewed: 2026-10-02
tags: [agents, knowledge, workflow]
source_of_truth:
  - AGENTS.md
  - CLAUDE.md
  - docs/knowledge/AGENTS.md
supersedes: []
---

# Adopt the knowledge-router agent kit; AGENTS.md is the single source of agent rules

## Reasoning Pattern

- For multi-step decisions, follow [Agent Planning and Reflection Pattern](../../../patterns/2026-08-12-11-39-23-agent-planning-reflection-pattern.md): restate the problem, decompose the choice, check the evidence, and record the rationale.

## Status

Active

## Last Reviewed

2026-10-02

## Context

The repository's agent rules lived in `CLAUDE.md`, which only Claude Code reads. The team's standard,
the knowledge-router agent kit (https://gitlab.com/my-group7744714/knowledge-router), puts one rule file,
`AGENTS.md`, at the root for every agent (Codex reads it, Cursor through `.cursor/rules/workspace.mdc`),
and a knowledge router under `docs/knowledge/`.

## Decision

- Install the kit with its own `scripts/install-agent.sh`: `AGENTS.md`, `CURSOR.md`,
  `.cursor/rules/workspace.mdc`, `.codex/skills/`, `docs/knowledge/`.
- `AGENTS.md` is the single source: the kit's workflow sections, adapted to this repository, followed by
  the project's own conventions (moved verbatim from `CLAUDE.md`, under `## Project Conventions`).
  Its HARD RULES win where the two meet.
- `CLAUDE.md` stays as a thin file that imports `AGENTS.md` (`@AGENTS.md`), so Claude Code reads the same rules.
- The kit's own maintenance notes (its task history, the kit-transfer runbook, the "installer ships
  skills" decision) are not carried over: they describe the kit repository, not this one. The kit's
  absolute links (`/Users/.../codex-agent-kit/...`) are made repository-relative.
- The navigation maps (`SYSTEM`, `REPOSITORY_MAP`, `API`, `DATABASE`, `EVENTS`) and the project index
  (`docs/knowledge/projects/bi-analytical-mcp/AGENTS.md`) are written for this repository; the
  long-form docs in `docs/` stay where they are and are linked from the maps.

## Consequences

- Every agent works from one rule file; a rule changes in `AGENTS.md` only.
- New commits follow Conventional Commits and the commit preflight review runbook.
- The kit's `.codex/skills/` are owned by the kit: update them there and re-install, not here.

## Affected Scope

- `AGENTS.md`, `CLAUDE.md`, `CURSOR.md`, `.cursor/`, `.codex/`, `docs/knowledge/`.

## Source Of Truth

- [`AGENTS.md`](../../../../../AGENTS.md)
- [`docs/knowledge/AGENTS.md`](../../../AGENTS.md)

## Supersedes

- None.

## Sources

- https://gitlab.com/my-group7744714/knowledge-router
