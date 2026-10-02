---
title: Architecture Map Title
last_reviewed: YYYY-MM-DD
scope: system-or-domain
tags: []
source_of_truth: []
related: []
---

> Fill the YAML frontmatter first, then complete the sections below.

# Architecture Map Title

## Purpose

- What this map explains.
- Which questions it should answer.

## Scope and Boundaries

### In scope

- Systems, repositories, domains, or flows covered by this map.

### Out of scope

- Details intentionally documented elsewhere.

## System Context

Describe the system's role, external actors, and major dependencies.

```mermaid
flowchart LR
    actor[Actor] --> system[System]
    system --> dependency[External dependency]
```

## Main Components

| Component | Responsibility | Repository or path | Depends on |
|-----------|----------------|-------------------|------------|
| Component | Responsibility | `path/` | Component or service |

## Key Flows

### Flow name

1. Actor or component starts the flow.
2. The request, event, or data moves through the main components.
3. The system produces the result or side effect.

## Interfaces and Data Ownership

- Public API or event contracts:
- Data stores and owning components:
- Cross-repository boundaries:
- Compatibility constraints:

## Operational View

- Deployment/runtime topology:
- Configuration and secrets:
- Observability and failure handling:
- Scaling or performance constraints:

## Invariants and Decisions

- Invariant or architectural constraint — link to the source note.
- Decision that shapes this map — link to the decision note.

## Open Questions and Known Gaps

- Question or missing evidence.
- Deferred detail and where it should be documented.

## Source Of Truth

- Current source code and tests.
- Project index or navigation map.
- Linked decisions, invariants, and operational notes.
