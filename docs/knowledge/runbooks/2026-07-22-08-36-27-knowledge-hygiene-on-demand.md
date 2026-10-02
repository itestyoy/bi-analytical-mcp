# Knowledge Hygiene on Demand

## Status

Active

## Last Reviewed

2026-07-22

## Context

Use this runbook when the user explicitly asks to clean up, compress, or tighten `docs/knowledge/`.

The goal is to remove noise and duplicates without spending tokens on an automatic full rewrite of the knowledge base.

## Trigger

Treat this runbook as active when the user writes something like:

- `compact knowledge`
- `knowledge compact`
- `clean docs/knowledge`
- `compress knowledge`
- `remove duplicates in knowledge`

## Steps

1. Clarify the scope if the user did not name it.
2. Open only the relevant `docs/knowledge/` sections and the linked source of truth.
3. Look for:
   - duplicate notes;
   - stale wording;
   - notes that are too long or too broad;
   - durable knowledge that still lives in a task note and should be promoted.
4. Compress only what is actually repeated or stale.
5. If there is one obvious source of truth, keep it and remove copies or references to it.
6. If the meaning changes in a durable way, update the matching decision, pattern, invariant, or summary.
7. If needed, update index files and templates, but only inside the affected scope.

## Verification

- There are no unnecessary duplicates in the affected scope.
- Durable conclusions have been promoted into the correct note type.
- Index files stayed short and did not turn into a dumping ground.
- The user scope was respected, and no extra repo-wide sweep was done.

## Rollback

- If the scope turned out to be too broad, stop and clarify it with the user.
- If the cleanup touched the wrong note, restore from git and reapply the change narrowly.

## Source Of Truth

- [docs/knowledge/AGENTS.md](../AGENTS.md)
- [docs/knowledge/templates/AGENTS.md](../templates/AGENTS.md)
- [docs/knowledge/runbooks/AGENTS.md](AGENTS.md)

## Sources

- [docs/knowledge/AGENTS.md](../AGENTS.md)
- [docs/knowledge/runbooks/AGENTS.md](AGENTS.md)
