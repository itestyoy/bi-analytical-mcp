---
title: Adopt the knowledge-router agent kit
status: done
last_reviewed: 2026-10-02
last_used: 2026-10-02
tags: [agents, knowledge]
source_of_truth:
  - AGENTS.md
  - docs/knowledge/decisions/2026/10/
---

# Adopt the knowledge-router agent kit

## Status

done

## Last Reviewed

2026-10-02

## Last Used

2026-10-02

## Context

The repository was asked to follow the knowledge-router standard (https://gitlab.com/my-group7744714/knowledge-router).

## Objective

The repository carries the kit, adapted to it, with `AGENTS.md` as the one rule file every agent reads.

## Expected Result

`AGENTS.md`, `CURSOR.md`, `.cursor/rules/workspace.mdc`, `.codex/skills/` and `docs/knowledge/` in place;
`CLAUDE.md` importing `AGENTS.md`; navigation maps and a project index describing this repository; no
broken relative links; the checks green.

## Scope

- Root agent files, `.cursor/`, `.codex/`, `docs/knowledge/`, the three in-repo references to `CLAUDE.md`.

## Out Of Scope

- Moving or rewriting the long-form docs in `docs/`.
- Rewriting earlier commit messages to Conventional Commits.

## Reasoning Pattern

- For non-trivial work, follow [Agent Planning and Reflection Pattern](../../../../patterns/2026-08-12-11-39-23-agent-planning-reflection-pattern.md): decompose the task, take the next smallest safe action, record the observation, and refine the plan.

## Acceptance Criteria

- [x] The kit is installed with its own script.
- [x] `AGENTS.md` carries the kit workflow and the project conventions; `CLAUDE.md` imports it.
- [x] Every relative link in the agent files and `docs/knowledge/` resolves.
- [x] Navigation maps and the project index describe this repository.
- [x] `npm run lint:names` and `npm test` pass.

## Verification

- Link check over `AGENTS.md`, `CLAUDE.md`, `CURSOR.md`, `.cursor/`, `.codex/`, `docs/knowledge/`: no broken
  link besides the templates' own links, which are relative to where a new note will live.
- `npm run lint:names`, `npm test`.

## Solution

Installed with `scripts/install-agent.sh` from the kit; adapted `AGENTS.md` (purpose, edit tool, skills
ownership, this repository's checks) and appended the project conventions from `CLAUDE.md`; dropped the
kit's maintenance notes; made the kit's absolute links relative; fixed the kit's `tasks/AGENTS.md`
template link; wrote the navigation maps and the project index.

## Result

The repository follows the kit; see the decision note for what was adapted and why.

## Source Of Truth

- [`AGENTS.md`](../../../../../../AGENTS.md)

## Durable Knowledge Updates

- Decisions: `docs/knowledge/decisions/2026/10/` (adopt the kit; AGENTS.md is the single source).
- Gotchas: None.
- Invariants: None.
- Patterns: None.
- Runbooks: None.
- Project or architecture documentation: `docs/knowledge/navigation/*`, `docs/knowledge/projects/bi-analytical-mcp/AGENTS.md`.
