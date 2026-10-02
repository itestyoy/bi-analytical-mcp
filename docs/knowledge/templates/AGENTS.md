# Templates

Reusable note templates.

- Keep templates aligned with current structure.
- Update them when fields or sections change.
- Use a template instead of copying by hand.
- Keep the folder-to-template mapping here so agents can pick the right template faster.
- When a template is used for multi-step work, add a short link to the shared `Agent Planning and Reflection Pattern` note instead of restating the whole loop inline.

## Folder Map

| Folder | Template |
|--------|----------|
| `decisions/` | `decision-template.md` |
| `gotchas/` | `gotcha-template.md` |
| `invariants/` | `invariant-template.md` |
| `patterns/` | `pattern-template.md` |
| `projects/` | `project-index-template.md` |
| `runbooks/` | `runbook-template.md` |
| `summaries/` | `summary-template.md` |
| `tasks/` | `task-template.md` |
| `architecture/` | `architecture-template.md` |
| `navigation/` | `navigation-template.md` |

## Frontmatter

- Note templates in this directory must start with YAML frontmatter.
- When creating a new note, copy the matching template so the frontmatter is included automatically.
- The template body should make the frontmatter-first workflow obvious to the agent.
- Keep the frontmatter small, stable, and parseable.
- Do not add frontmatter to router or index files.

## Files

- `decision-template.md`
- `gotcha-template.md`
- `invariant-template.md`
- `pattern-template.md`
- `project-index-template.md`
- `runbook-template.md`
- `summary-template.md`
- `task-template.md`
- `architecture-template.md`
- `navigation-template.md`

Navigation templates are intentionally the exception to the frontmatter rule:
their target files are fixed entrypoint maps, not dated knowledge notes.
