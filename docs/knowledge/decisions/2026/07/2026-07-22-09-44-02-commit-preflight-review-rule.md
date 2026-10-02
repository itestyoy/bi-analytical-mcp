---
title: Rule for Pre-Commit Self-Review
status: Active
last_reviewed: 2026-07-22
tags: [commit, review, workflow]
source_of_truth:
  - AGENTS.md
  - docs/knowledge/runbooks/2026-07-22-09-51-45-commit-preflight-review.md
---

# Pre-Commit Self-Review Rule

## Status

Active

## Last Reviewed

2026-07-22

## Context

Before every commit, the agent needs an explicit self-review step so that contradictions, regressions, and missed checks do not get hidden behind a quick `git commit`.

## Decision

Before every commit, the agent must follow the commit preflight review runbook and inspect its diff like a reviewer.

The runbook covers contradictions with current code and rules, broken contracts, possible regressions, missing tests or checks, and mismatches with documentation when documentation is the source of behavior.

If problems are found, the agent must show them to the user and fix them before committing.

## Consequences

- Commits become safer and more transparent.
- The user sees risks before the changes are finalized.
- Large changes take longer before commit, but the tradeoff is fewer mistakes.

## Affected Scope

- [AGENTS.md](../../../../../AGENTS.md)
- Commit workflow in workspace repositories

## Source Of Truth

- [AGENTS.md](../../../../../AGENTS.md)
- [docs/knowledge/runbooks/2026-07-22-09-51-45-commit-preflight-review.md](../../../runbooks/2026-07-22-09-51-45-commit-preflight-review.md)

## Sources

- [AGENTS.md](../../../../../AGENTS.md)
