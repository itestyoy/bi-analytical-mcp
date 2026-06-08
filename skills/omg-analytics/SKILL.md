---
name: omg-analytics
description: >-
  Self-service product analytics for OpenMyGame titles via the bi-analytical-mcp
  semantic-layer MCP. Use this whenever a question is about player behavior,
  funnels/conversion, retention, monetization (IAP + ads), in-game economy
  (resources/coins), sessions, or A/B-test analysis over the events fact, the
  user-attributes dimension, and experiment assignments. It teaches the analyst
  workflow (clarify → discover the catalog → prefer governed metrics → query →
  adversarially review → report with provenance), grounds every concept in
  OpenMyGame's canonical definitions in Confluence, and lists the wrong-answer
  modes (gotchas) to avoid.
---

# OMG self-service analytics (bi-analytical-mcp)

You answer product-analytics questions for OpenMyGame games by driving the
**bi-analytical-mcp** tools. You never write raw SQL — you reference catalog-enumerated
events, properties, dimensions and metrics by name, and the engine compiles + runs them.

The **canonical definitions** of every event, metric and dimension live in **Confluence**
(and the live shape lives in the **catalog** via `describe_catalog`). They CHANGE over time,
so this skill does **not** copy them — it is a persistent **navigator + procedure**: it tells
you which Confluence pages to read and how to drive the MCP. Always open the linked page and
run `describe_catalog` for current definitions; never trust a value memorized here. Cite the
page you relied on. Start map: `reference/confluence-map.md`.

> `data ≠ software`: a question usually has ONE correct answer and there is no test that
> proves it. So **reduce ambiguity before you query** — clarify the ask, map words to the
> exact catalog entities, prefer governed metrics, and review the result.

## The data model (three fixed sources — never invent others)
- **events** — the analytical events fact (one row per event: a player id, a session id, a
  timestamp, an `event_name`, and a typed `event_data` payload + envelopes like
  `additional_info` / `main_data` / `device_info`). The anchor for funnels and behavior.
- **users** — one row per player: country, platform, media_source, install date, ATT/GDPR,
  device language/memory, time zone, player skill, …
- **experiments** — A/B assignments (one row per player×experiment: experiment_name,
  variant_group, assigned_at, ended_at), joined to events by the player entity.

Funnels/steps are built **only** from events (a step = an event + an `event_data` value).
**Events are the foundation of every analysis** — a measure/step is an `event_name` + a
payload value — so start from the event taxonomy: `reference/events.md` (the event
catalogue, envelope structure, and event gotchas). Dimensions/metrics built on top:
`reference/data-model.md`.

## Workflow (do this every time)
1. **Clarify** the request before touching data: time window, game/project, platform/geo,
   player segment, and the *decision* behind the question. Resolve relative time to a
   **complete** period ("last week" = last full calendar week, not trailing 7 days), and
   anchor freshness on the latest event time, not "today".
2. **Discover** with `describe_catalog` — call it first with no args (overview), then drill
   down: `{ event }` for an event's properties, `{ property }` for one property's real
   values + cardinality, `{ search }` to map a business word/value to the property and the
   event(s) that carry it. This narrows the entity space before you commit.
3. **Prefer governed metrics** (the semantic layer) — if the ask matches a defined metric
   (e.g. *Game Completion Rate*, *Resource Income/Outcome*, *Cumulative Sessions*), build it
   with `create_semantic_model` and query it with `query_semantic_model`. This is the
   default path: same definition as the BI dashboards. Fall back to a custom
   `build_native_model` pipeline only when no governed metric fits (custom funnels, paths,
   bespoke aggregates).
4. **Query**: `query_semantic_model` for metrics (group_by `metric_time`/grain or a user
   attribute path; `where`; `time_range`). For pipelines, `build_native_model`
   (start → add_step → commit) then read rows with `get_query_result`.
5. **Review** (adversarial): before trusting a number, challenge it — 0 rows? a property
   that's NULL on most events because you didn't scope to its event? a grain mismatch
   (per-event vs per-player)? a rate with a zero denominator? a segment that silently
   dropped most users? Re-run with the fix.
6. **Report with provenance**: state which **tier** the number came from
   (governed metric › custom pipeline), the grain + filters applied, the time window, the
   data freshness (max event time), and link the Confluence definition you relied on.
   Separate observation ("the data shows X") from interpretation ("this likely means Y").

## Tool map
| Need | Tool |
| --- | --- |
| Discover events / properties / values / map a term | `describe_catalog` (overview → `{model\|event\|property\|search}`) |
| Is the value index fresh / what's running | `describe_index` (sync state, per-property timing, jobs) |
| Define + query a governed metric | `create_semantic_model` → `query_semantic_model` |
| Custom funnel / path / bespoke transform | `build_native_model` (start → add_step → commit) → `get_query_result` |
| A/B significance | `ab_test`; guardrail `srm_check`; planning `sample_size` |
| Ready templates (with the reusable technique) | `list_recipes` / `get_recipe` |
| Isolated workspace mgmt | `list_contexts` / `describe_context` / `drop_context` |

## Routing triggers (IF … DO)
- IF the ask is a **named KPI / rate / cumulative metric** → governed metric
  (`create_semantic_model` + `query_semantic_model`), NOT a hand-rolled pipeline.
- IF the ask is an **ordered multi-step funnel / path / "between steps" timing** → a
  `build_native_model` pipeline with a `match_recognize` stage (funnels are events-only).
- IF the ask is **"is variant B better"** → compute per-variant aggregates first (a pipeline
  joining `experiments`), then `ab_test`; ALWAYS run `srm_check` before trusting any lift.
- IF you need to **segment by a player attribute** (country/platform/ATT/…) → join/group by
  the `users` dimension; do NOT look for it on the event payload.
- IF a property reads mostly NULL → you probably didn't **scope to the event(s)** that carry
  it (see gotchas) — most `event_data` properties are event-specific.

## Reference (pointers — read the Confluence pages they link, don't trust copies)
- `reference/confluence-map.md` — **start here**: which Confluence space/page holds what, the
  anchor pages (master Events Schema, QA rules, A/B process), and how to find a specific
  event/dimension/metric (search patterns + labels) and confirm it via `describe_catalog`.
- `reference/events.md` — **the events foundation**: where to read event meaning/params/when
  (the master schema), an orientation map of the event families, and how to use events in the
  MCP + traps to avoid.
- `reference/data-model.md` — where the dimension/metric definitions live (BI space), how to
  find one, an index of the common pages, and how to reproduce a governed metric in the MCP.
- `reference/playbooks.md` — analysis patterns → exact MCP tool sequences (trends, funnels,
  retention, monetization IAP+ads, in-game economy, A/B), each pointing at the relevant page.

When OMG ships data-model changes, the Confluence `[Metric]`/`[Dimension]` pages are
updated first — re-read them (and `describe_catalog`) rather than trusting memory.
