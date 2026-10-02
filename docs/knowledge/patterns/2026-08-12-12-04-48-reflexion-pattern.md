---
title: Reflexion Pattern
status: Active
last_reviewed: 2026-08-12
tags: [knowledge, patterns, agents]
source_of_truth:
  - https://www.promptingguide.ai/techniques/reflexion
---

> Fill the YAML frontmatter first, then complete the sections below.

# Reflexion Pattern

## Status

Active

## Problem

Repeated attempts can keep making the same mistake if the agent does not convert failure into an explicit lesson and carry that lesson forward.

## Pattern

- After a trial, evaluate the result against the goal.
- Write a short reflection that names the mistake, the cause, and the adjustment.
- Store that reflection so the next attempt can reuse it.
- Use the new reflection to guide the next trajectory instead of repeating the same approach.
- Use this loop when trial-and-error improvement matters more than a one-shot answer.

## Canonical Source

- The frontmatter `source_of_truth` field points to [Reflexion](https://www.promptingguide.ai/techniques/reflexion).

## Sources

- https://www.promptingguide.ai/techniques/reflexion
- [Agent Planning and Reflection Pattern](2026-08-12-11-39-23-agent-planning-reflection-pattern.md)
