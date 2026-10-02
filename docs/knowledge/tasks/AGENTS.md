# Tasks

Task notes are temporary working memory for investigating, planning,
implementing, and verifying non-trivial work.

## When To Create

Create a task note when the work requires one or more of the following:

- investigation across multiple files, modules, repositories, or systems;
- validation of assumptions or hypotheses;
- comparison of implementation approaches;
- coordination of multiple implementation steps;
- preservation of working context between agent sessions;
- explicit verification or knowledge transfer.

Do not create a task note for a trivial isolated change when the problem,
implementation, and verification are already clear from the task description
and code.

## Storage

- Group task notes by `YYYY/MM`.
- Store them in a status subdirectory.
- Create task notes as:

  `docs/knowledge/tasks/YYYY/MM/<status>/YYYY-MM-DD-HH-MM-SS-short-title.md`

- Use [`task-template.md`](../templates/task-template.md) for new task notes.
- Before starting work on an existing task note, move it into the folder for
  its active status. A note being worked on should live in `in-progress`, not
  stay in `new`.
- Move the note again whenever its status changes.
- Avoid completed or cancelled tasks unless they are explicitly relevant.

## Statuses

Use only the statuses needed for task navigation:

- `new` - the task is recorded but work has not started; include `Context`, `Objective`, `Expected Result`, `Scope`, and `Acceptance Criteria`;
- `in-progress` - investigation or implementation is active;
- `blocked` - continuation requires external information, access, or a decision;
- `done` - the result is verified and durable conclusions are transferred;
- `cancelled` - the task will not continue and the reason is recorded.

## Status Transitions

- `new` -> `in-progress`: work has actually started, and the note has moved to
  `in-progress`.
- `new` -> `cancelled`: the task will no longer be worked on before it starts.
- `in-progress` -> `blocked`: continuing requires an external answer, access, or
  decision.
- `blocked` -> `in-progress`: the blocker has been removed and work has resumed.
- `in-progress` -> `done`: the result is verified and durable conclusions have
  moved to the source of truth.
- `in-progress` -> `cancelled`: the work has been intentionally stopped.

## Knowledge Lifecycle

- Treat task notes as temporary working memory.
- Do not use a completed task note as the primary source of truth.
- Move durable conclusions to the appropriate knowledge section.
- Link the resulting source of truth from the task note.
- Keep completed tasks out of the main working path.
