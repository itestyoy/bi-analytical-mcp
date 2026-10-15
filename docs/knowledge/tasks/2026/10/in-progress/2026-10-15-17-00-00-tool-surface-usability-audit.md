---
title: Audit of the tool surface for model usability
status: in-progress
last_reviewed: 2026-10-15
last_used: 2026-10-15
tags: [mcp, tools, descriptions, schema, errors, responses]
source_of_truth:
  - src/tools/core.js
  - src/mcp-surface.js
  - src/schema/transport.js
  - src/validate.js
  - src/guide.js
---
# Audit of the tool surface for model usability

## Status
in-progress — preliminary audit done (read-only, no code changed); waiting for the owner to pick what to change.

## Last Reviewed
2026-10-15

## Context
Goal: a model finds its way around the server easily and answers correctly. A checklist of tool-design
standards (Anthropic, OpenAI, the MCP spec, large implementers, empirical studies, host limits) was
built, and the served surface (tools/list, instructions, answers, refusals, guides, recipes) was
audited against it on a live server over the fixture warehouse, with cold-start usability probes.
74 findings; F1–F15 checked by two independent verifiers, F16 by one, F17–F74 single-pass (nine
re-checked by hand). The full report (in Russian) was handed to the owner in the session.

## Main results
- Silently wrong but well-formed answers: event-name constants unchecked in pipeline / metric-query
  where (F2); an SCD join without `between` warns only (F1); a semantic build answers done with every
  metric dropped (F3); missing time buckets and a `fill_nulls_with` description that promises zeros (F10).
- Answer size: no byte budget per page (a default page of a wide table ≈84K chars), display_model_result
  returns every kept row to the model (F12); pretty-printed JSON adds 25–106 % (F34); repeated
  navigation lists, step echoes, model_sql in reads (F30–F32).
- Refusals: 56 % of 98 live refusals carry a concrete fix; misnamed function parameters point at the
  wrong function (F4); compile-stage lookups give no did-you-mean (F41); unknown context_id has no way
  out (F48); a refused pipeline start leaks a draft (F65).
- Readability: 146 of 164 `$defs` have generated names (F22); 376 of 1,147 properties have no
  description (F60); no example call in any description, while Codex compacts schemas over 5,000 bytes
  to skeletons (F7, F23).
- Routing and texts: the project's semantic layer is promised but not listed (F5); no today / data span
  (F18); guide triggers contradict SQL-first (F6) and push HLL (F25); several recipe texts mislead
  (F26, F27, F45, F52, F69).
- Size: ≈57.7K tokens of tool definitions; ≈9.2K chars left of the 260K budget on config/catalog.yml.

## Not done
- Evals with a model (no API key); the golden-question probes (the probe server went down with a
  container restart); independent verification of F17–F74.

## Source Of Truth
- The files above; AGENTS.md (Protocol surface).
