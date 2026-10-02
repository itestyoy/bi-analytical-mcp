---
title: Commit Preflight Review
status: Active
last_reviewed: 2026-07-22
tags: [commit, review, workflow]
source_of_truth:
  - AGENTS.md
  - docs/knowledge/decisions/2026/07/2026-07-22-09-44-02-commit-preflight-review-rule.md
---

# Commit Preflight Review

## Status

Active

## Last Reviewed

2026-07-22

## Context

Use this runbook before every commit. The goal is to review the diff like a reviewer and catch problems before the commit is finalized.

## Trigger

Run this procedure immediately before creating a commit, regardless of whether the change is code, docs, or workflow-related.

## Steps

1. Inspect the staged and unstaged diff.
2. Check the change against the current code, tests, schemas, docs, and `AGENTS.md` rules.
3. Look for:
   - contradictions with existing behavior or rules;
   - broken contracts;
   - possible regressions;
   - missing tests or checks;
   - accidental deletions or scope creep;
   - documentation that disagrees with the implemented behavior.
4. Adjust review depth to risk:
   - large or risky changes require deeper review;
   - small docs-only changes can be reviewed faster, but not mechanically.
5. If you find a problem, show it to the user first and fix it before committing.
6. If no problems remain, proceed with the commit.

## Verification

- No unresolved contradictions or regressions remain in the diff.
- Any needed tests or checks were run, or the missing checks were explicitly explained.
- The commit message follows the repository commit rules.

## Rollback

- If the review shows the change is too risky or unclear, pause and ask the user before committing.
- If the diff is wrong, fix the files and repeat the review before retrying the commit.

## Source Of Truth

- [AGENTS.md](../../../AGENTS.md)
- [docs/knowledge/decisions/2026/07/2026-07-22-09-44-02-commit-preflight-review-rule.md](../decisions/2026/07/2026-07-22-09-44-02-commit-preflight-review-rule.md)

## Sources

- [AGENTS.md](../../../AGENTS.md)
- [docs/knowledge/decisions/2026/07/2026-07-22-09-44-02-commit-preflight-review-rule.md](../decisions/2026/07/2026-07-22-09-44-02-commit-preflight-review-rule.md)
