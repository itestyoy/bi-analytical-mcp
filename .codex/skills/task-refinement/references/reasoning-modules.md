# Task Refinement Reasoning Modules

Use these atomic modules during `SELECT`, then adapt the chosen ones to the task during `ADAPT`, and finally turn them into a task-specific review plan during `IMPLEMENT`.

## Module Bank

### Granularity Check

Break work into pieces a junior engineer can complete in 4-8 hours. Reject any task that likely exceeds 16 hours without subtasks.

### Implementability Check

Make the plan executable without guesswork. Require explicit file paths, behaviors, and deliverables.

### Success Criteria Check

Require measurable, testable acceptance criteria. Reject vague phrases like "works well" or "is implemented".

### Dependency Check

Confirm blocking relationships are logical, complete, and non-circular.

### Safety Check

Call out missing error handling, TODOs, stubs, panic paths, and swallowed errors.

### Edge Case Check

Check malformed input, empty values, Unicode, concurrency, dependencies failing, and large inputs.

### Red Flag Check

Reject placeholder text, vague instructions, missing tests, and unclear completion rules.

### Test Meaningfulness Check

Make sure tests catch real bugs and exercise realistic scenarios.

### Scope Boundary Check

Verify what is in scope and what is intentionally excluded.

### Source of Truth Check

Ensure the task points to the canonical file, note, or contract that owns the behavior.

### Verification Check

Require the smallest useful verification for the changed surface.

### Task Note Handoff Check

If the plan becomes durable work memory, hand it off to `docs/knowledge/templates/task-template.md`.

### Working Memory Check

Keep one or more local working-note files with conclusions, open questions, dead ends, and next steps so you can move back and forth without losing context.

### Reflection Check

Ask what was missed, what could fail, and what should be updated after implementation.

## Reasoning Modes

Use the lightest mode that fits the task, then combine it with the module bank above.

| Mode | Trigger | Output Shape |
|---|---|---|
| `CoT` | Linear task, low branching. | Ordered reasoning trail and checklist. |
| `Self-Ask` | Need to drill into sub-questions. | Question/answer chain that narrows scope. |
| `Self-Discover` | Need to pick and adapt reasoning modules. | Task-specific reasoning structure. |
| `ToT` | Multiple viable branches. | Branch tree with evaluation and pruning. |
| `LATS` | Agentic task with external feedback. | Search states, feedback, and next actions. |
| `Reflexion` | Retry after failure. | Reflection note plus corrected plan. |
| `MRKL` | Need routing across reasoning/tool modules. | Routed plan with module handoffs. |
| `PAL` | Code is the safest solver for part of the task. | Executable steps or code-backed reasoning. |
| `Toolformer` | Tool use is itself a decision to be made. | Explicit tool call and integration points. |

## Memory Guidance

- Write down selected mode, rejected modes, and the reason for the choice.
- Keep a short working-note trail for conclusions, dead ends, and next steps.
- Revisit the notes when the plan changes or the task gets stuck.

## Suggested Selection Heuristics

- Always select: Granularity, Implementability, Success Criteria, Safety, Edge Case, Red Flag, Test Meaningfulness, Verification.
- Select Dependency Check when the plan spans more than one step or module.
- Select Scope Boundary Check when the request is ambiguous or broad.
- Select Source of Truth Check whenever the result should outlive the conversation.
- Select Task Note Handoff Check when the work needs durable memory.
- Select Working Memory Check when the task is complex enough that you need a reversible trail of notes, decisions, and dead ends.
- Select Reflection Check for multi-step or risky tasks.
