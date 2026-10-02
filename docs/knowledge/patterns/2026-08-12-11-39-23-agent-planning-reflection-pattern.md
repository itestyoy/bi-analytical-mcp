---
title: Agent Planning and Reflection Pattern
status: Active
last_reviewed: 2026-08-12
tags: [knowledge, patterns, agents]
source_of_truth:
  - https://lilianweng.github.io/posts/2023-06-23-agent/
---

> Fill the YAML frontmatter first, then complete the sections below.

# Agent Planning and Reflection Pattern

## Status

Active

## Problem

Multi-step work can drift when the agent jumps straight from request to action without explicitly decomposing the task, checking assumptions, or recording what changed after each step.

## Pattern

- Restate the objective and the expected result before acting.
- Break the task into the smallest safe next step.
- After each action, capture the observation or evidence that came back.
- If the evidence conflicts with the current hypothesis, update the plan before continuing.
- Keep the loop short: plan, act, observe, reflect, repeat.
- Use the pattern for task notes and other multi-step work where planning and verification matter.

## Canonical Source

- The frontmatter `source_of_truth` field points to [LLM Powered Autonomous Agents](https://lilianweng.github.io/posts/2023-06-23-agent/).

## Sources

- https://lilianweng.github.io/posts/2023-06-23-agent/
