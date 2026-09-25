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
(and the live shape lives in the **catalog** via `semantic_index`). They CHANGE over time,
so this skill does **not** copy them — it is a persistent **navigator + procedure**: it tells
you which Confluence pages to read and how to drive the MCP. Always open the linked page and
run `semantic_index` for current definitions; never trust a value memorized here. Cite the
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

## Workflow & routing — served live by the MCP (single source of truth)
The generic analyst **procedure** (clarify → discover → prefer governed → bound/exclude →
adversarial review → report with provenance) and the **IF/DO routing triggers** (which tool
to use when) are served by the server itself — **call `semantic_index({ guide: true })`** and
follow it (narrow to a family with `semantic_index({ guide: "retention" })`). This skill does
**not** copy them, so the two never drift; it adds only the **OMG-specific** layer below.

For an **open research question** — why a metric moved, what drives it, whether a change
worked, a product / monetization / UA deep dive — read **`semantic_index({ guide: "research" })`**
first (also served as the server's `research` skill): the investigation sequence, the checks
before presenting, the report shape, and a guide per domain — `research/product`,
`research/monetization`, `research/ua`. Apply the OMG cautions below on top of it.

OMG cautions on top of the generic procedure:
- **Complete periods**: "last week" = last full calendar week; anchor freshness on the latest
  event time, not "today".
- **Governed first**: if the ask matches a named OMG metric (*Game Completion Rate*,
  *Resource Income/Outcome*, *Cumulative Sessions*, …), reproduce it via `build_semantic_model`
  — same definition as the BI dashboards. Confirm the definition in Confluence (below).
- **Reinstalls / ATT / test users** distort cohorts, revenue and coverage — exclude/flag per
  the gotchas in `reference/playbooks.md`.
- **Report** with the Confluence definition you relied on, and separate observation from
  interpretation.
- **Record what you learn**: when you track a fuzzy OMG term down to a real field, hit a
  non-obvious gotcha, or rely on a specific Confluence page, save it with the **`memory`** tool
  — linked to the field/event it concerns (`targets`) and the words the user used (`aliases`),
  with the page as a `link`. It resurfaces through `semantic_index` (the linked views + search)
  next time, turning one investigation into durable shared knowledge. (Put findings in the live
  memory store, NOT as copied definitions in this skill — same no-drift reason.)

## Reference (pointers — read the Confluence pages they link, don't trust copies)
- `reference/confluence-map.md` — **start here**: which Confluence space/page holds what, the
  anchor pages (master Events Schema, QA rules, A/B process), and how to find a specific
  event/dimension/metric (search patterns + labels) and confirm it via `semantic_index`.
- `reference/events.md` — **the events foundation**: where to read event meaning/params/when
  (the master schema), an orientation map of the event families, and how to use events in the
  MCP + traps to avoid.
- `reference/data-model.md` — where the dimension/metric definitions live (BI space), how to
  find one, an index of the common pages, and how to reproduce a governed metric in the MCP.
- `reference/playbooks.md` — analysis patterns → exact MCP tool sequences (trends, funnels,
  retention, monetization IAP+ads, in-game economy, A/B), each pointing at the relevant page.

When OMG ships data-model changes, the Confluence `[Metric]`/`[Dimension]` pages are
updated first — re-read them (and `semantic_index`) rather than trusting memory.
