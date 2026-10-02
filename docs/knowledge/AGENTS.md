# Agent Workspace

Use this directory as the knowledge router.

- Do not read everything.
- For each task: determine the repo and domain, open the repo-level `AGENTS.md`, read only what is needed, trust code and tests, and expand scope only when local context is not enough.

## Directory Roles

- `navigation/` - entry points
- `projects/` - repo maps
- `architecture/` - top-down maps
- `decisions/` - durable choices
- `patterns/` - reusable approaches
- `gotchas/` - recurring failures
- `invariants/` - always-on rules
- `runbooks/` - procedures
- `summaries/` - quick hints
- `tasks/` - temporary working memory
- `templates/` - note templates
- `README.md` - human-readable map of the knowledge layout

## Naming Standard

- New knowledge notes in dated sections use `docs/knowledge/<section>/YYYY/MM/YYYY-MM-DD-HH-MM-SS-short-title.md`.
- Runbooks use `docs/knowledge/runbooks/YYYY-MM-DD-HH-MM-SS-short-title.md` without year/month subfolders.
- Keep fixed router and index files, such as `AGENTS.md`, `README.md`, and the existing navigation map filenames, at their current names.
- `navigation/` stays a fixed entry-point set (`SYSTEM.md`, `REPOSITORY_MAP.md`, `API.md`, `DATABASE.md`, `EVENTS.md`) and does not use the dated note layout.

## Notes

- Use `README.md` as the human-readable map and `AGENTS.md` as the procedural router.
- When creating a new knowledge note, start from the matching template so YAML frontmatter is added automatically.
- Do not create a new durable note without the template frontmatter.
