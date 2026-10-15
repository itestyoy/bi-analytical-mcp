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
in-progress — audit done, defects and wave 1 fixed; the redesign (below) is being implemented.

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

## Fixed (behaviour defects)
- F2: a constant compared with a source's event-name column is checked against the catalog's events in
  a pipeline where and a metric query's where (refused with the same casing / close names, or the
  source that records it); the semantic model's where and funnels say the same did-you-mean
  (`Catalog.eventNameRefusal`).
- F3: a declaration whose every metric reads a measure on a slowly-changing model is refused in the
  call (nothing created); the drop warning is in the caller's words with the events-source count written
  out; `next` is never built from an empty metric list.
- F4: a function given a parameter under another name is refused as that function, naming the parameter
  (`DISCRIMINATORS` in src/validate.js).
- F43: a NULL metric of a one-metric query is null, not ''.
- F48 / F65: an unknown context_id names the way out (context list); deleting one says it named none; a
  refused pipeline start leaves no draft.
- Texts: F10 (`fill_nulls_with` adds no rows), F6 (python trigger examples; served only with a python
  runtime), F59 (serverInfo.description), F69 (dead recipe references).

## Wave 1 (done)
- F34: tool results are compact JSON. F22: folded `$defs` are named by the field that uses them
  (`users_column`, `context_id`, a form's title) — 12 of 148 still generic. F7/F23: one minimal call per
  grammar tool in its description (`EXAMPLES`, src/tools/core.js; held valid by
  test/unit/tool-examples.test.js) and a "use it for / for … use" sentence on the query tools; F21.
- F42: an earlier spelling whose conversion the place refuses too is not offered as the value to write.
  F71: an event view marks samples pooled across events (`sample_values_also_from`). F18: the overview
  carries `today`. Texts: F28 (frame, not clarify), F25 (count_distinct is the default; HLL to combine
  buckets), F26 / F52 (recipe titles: step reach; retention).
- F13 (metric names in the start answer) is NOT done: a start answers with its task only (HARD RULE);
  the description's example shows the `<name>_<metric>` naming instead.

## Redesign: one builder, one query, one join contract
The owner asked for a plain, strict schema instead of more fixes; the accepted design is the decision
note `docs/knowledge/decisions/2026/10/2026-10-15-20-30-00-one-builder-one-query-one-join-contract.md`,
implemented step by step.
- Step 1 (done): `query_semantic_model` + `query_pipeline_model` → `query_model`. A query with a metrics
  step is a metric query, one without reads the stored pipeline table; one tool reads every task back.
  Task kinds stay `query_semantic_model` / `query_pipeline_model` internally (`QUERY_KINDS`) and are said
  as `query_model` (`TaskRunner.toolOf`). Tool list 251,942 → 223,543 chars.
- Step 2 (done): join contracts. A joinable model declares `meta.mcp.join` (src/catalog/joins.js); the
  pipeline join is `{ source, on, attrs }`, one closed form per joinable model, amounts not carried, a
  select value checked against the value index. `with` / `via` / `between` and fact-to-fact joins are gone;
  a kept draft's join is converted on read (`storedJoin`). The experiments contract has no time part
  (CUPED needs the pre-assignment events — see the decision note). Tool list → 214,738 chars.

## Not done
- Evals with a model (no API key); the golden-question probes (the probe server went down with a
  container restart); independent verification of F17–F74.

## Source Of Truth
- The files above; AGENTS.md (Protocol surface).
