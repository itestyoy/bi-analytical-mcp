---
title: Task Title
status: new
last_reviewed: YYYY-MM-DD
last_used: YYYY-MM-DD
review_after: YYYY-MM-DD
tags: []
source_of_truth: []
---

> Fill the YAML frontmatter first.
> Remove optional sections that do not add useful information.

# Task Title

## Status

new

## Last Reviewed

YYYY-MM-DD

## Last Used

YYYY-MM-DD

## Review After

YYYY-MM-DD

Optional - use only when the task will be revisited or review automation exists.

## Context

Current state, problem, trigger, and why the task matters.

## Objective

One concrete and verifiable outcome.

Describe the expected result before proposing an implementation.

## Expected Result

Describe the final, observable state that should exist when the task is accepted.

Focus on what will be true, visible, or delivered at the end of the work.

## Scope

- Repositories, modules, entities, workflows, or documentation included.

## Out Of Scope

Optional - important adjacent work that is intentionally excluded.

## Known Facts

Optional - confirmed facts with links or other evidence.

## Assumptions

Optional - relevant statements that have not yet been verified.

## Open Questions

Optional - missing information or decisions that may affect the solution.

## Hypothesis

Optional - initial testable explanation or proposed direction before
investigation.

## Reasoning Pattern

- For non-trivial work, follow [Agent Planning and Reflection Pattern](../../../../patterns/2026-08-12-11-39-23-agent-planning-reflection-pattern.md): decompose the task, take the next smallest safe action, record the observation, and refine the plan.

## Acceptance Criteria

- [ ] Observable condition that must be satisfied.
- [ ] Existing behavior that must not regress.
- [ ] Required source-of-truth update.

Define acceptance criteria before implementation steps.

## By Status

- `new`: `Context`, `Objective`, `Expected Result`, `Scope`, `Acceptance Criteria`.
- `in-progress`: the above plus `Hypothesis`, `Investigation`, `Steps`.
- `blocked`: the blocker and what is needed to unblock work.
- `done`: `Verification`, `Solution`, `Result`, `Source Of Truth`,
  `Durable Knowledge Updates`.
- `cancelled`: why the task stopped and what useful conclusions remain.

## Investigation

Optional - what was inspected, tested, measured, or learned.

Record evidence separately from assumptions.

## Dead Ends

Optional - rejected approaches and why they were rejected.

## Decision

Optional - chosen direction, rationale, constraints, and trade-offs.

Create or update a durable decision note when the decision has long-term or
cross-project impact.

## Steps

1. First action.
2. Next action.
3. Verification and documentation update.

## Verification

Checks performed against the acceptance criteria and their actual results.

## Solution

The implemented approach and why it was selected.

## Result

Final state, completed work, limitations, and remaining follow-up.

## Source Of Truth

- Current code or durable documentation that owns the resulting behavior.

Completed task notes must not remain the primary source of truth.

## Durable Knowledge Updates

- Decisions:
- Gotchas:
- Invariants:
- Patterns:
- Runbooks:
- Project or architecture documentation:

Use `None` when the task produced no durable conclusions.

## Error / Prevention

Optional - root cause and prevention when the task was triggered by an error.

## Follow-Up

Optional - intentionally deferred work, preferably linked to separate tasks.

## Related Notes

- Relevant decisions, runbooks, gotchas, patterns, projects, or previous tasks.
