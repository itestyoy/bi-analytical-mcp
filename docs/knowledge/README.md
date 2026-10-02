# Knowledge Map

This page is a short human-friendly map of `docs/knowledge/`.

## How to Read It

1. First open [docs/knowledge/AGENTS.md](AGENTS.md).
2. Then open the section that matches the note type.
3. For templates, see [docs/knowledge/templates/AGENTS.md](templates/AGENTS.md).

## Structure

- `AGENTS.md` - procedural router and rules for working with knowledge.
- `README.md` - human-readable structure map.
- `navigation/` - fixed entry-point files:
  - `SYSTEM.md`
  - `REPOSITORY_MAP.md`
  - `API.md`
  - `DATABASE.md`
  - `EVENTS.md`
- `templates/` - note templates and the folder-to-template map.
- `runbooks/` - user-requested procedures, without `YYYY/MM`, stored as `YYYY-MM-DD-HH-MM-SS-short-title.md`.
- `decisions/` - durable decisions, dated notes in `YYYY/MM`.
- `gotchas/` - recurring mistakes and prevention, dated notes in `YYYY/MM`.
- `invariants/` - always-true rules, dated notes in `YYYY/MM`.
- `patterns/` - repeatable approaches, dated notes in `YYYY/MM`.
- `summaries/` - short cache-like orientation notes, dated notes in `YYYY/MM`.
- `architecture/` - high-level system maps, dated notes in `YYYY/MM`.
- `projects/` - repo maps; the root index is flat, and additional notes live inside the repo subtree.
- `tasks/` - temporary working memory, dated notes in `YYYY/MM/<status>/`; when work
  starts, the active note should move immediately into its status folder.

## Naming

- Dated notes: `YYYY-MM-DD-HH-MM-SS-short-title.md`.
- For `tasks`: `docs/knowledge/tasks/YYYY/MM/<status>/YYYY-MM-DD-HH-MM-SS-short-title.md`.
- For `runbooks`: `docs/knowledge/runbooks/YYYY-MM-DD-HH-MM-SS-short-title.md`.
- For `navigation/`, `templates/`, `AGENTS.md`, and other index files, use fixed names without dates.

## Frontmatter

Use YAML frontmatter at the top of each note. Create new notes through the matching template so frontmatter is added automatically.

### Minimum Set

```yaml
---
title: Example Title
status: Active
last_reviewed: 2026-07-22
tags: [example, knowledge]
source_of_truth:
  - docs/knowledge/AGENTS.md
---
```

### Where to Use It

- `decisions/`
- `gotchas/`
- `invariants/`
- `patterns/`
- `runbooks/`
- `summaries/`
- `tasks/`

### Where Not to Use It

- `AGENTS.md`
- `README.md`
- `navigation/`
- `templates/`
- flat index files

## Priority

- Code and current tests.
- Active decisions and runbooks.
- Navigation maps and summaries.
- Task notes.

## Note

- If the structure starts to sprawl, update the map here first, then the deeper notes.
