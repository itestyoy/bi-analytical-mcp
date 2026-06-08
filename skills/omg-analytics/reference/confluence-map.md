# Confluence map — where to read the source of truth

This skill is **persistent navigation + procedure**, not a copy of Confluence. Definitions
of events, dimensions and metrics live in Confluence (and change over time) and the live
shape lives in the catalog — so **don't trust copied values; open the page and run
`describe_catalog`**. This file tells you WHICH pages to read and HOW to find them.

Site: `https://openmygame.atlassian.net/wiki`. If the Atlassian/Confluence MCP tools are
available, search/read directly; otherwise open the links in a browser.

## Spaces (what lives where)
| Space | Key | What you'll find |
| --- | --- | --- |
| BI & Integration | `BI` | The governed **semantic layer**: `[Dimension] …` and `[Metric] …` definition pages (Description + Calculation = event + param), plus QA/integration docs. |
| Product Analytics | `PA` | The **master Events Schema** (event catalogue + parameters), the **A/B-test** process/pipeline, and per-test analyses. |
| Per-game spaces | e.g. `Sudoku`, `MW` (Sky Words), `JCS` (Cardscapes), `YVOTY` (Fillwords), `WO` (Word Search Sea), `WP`, `Jigsawgram`, `RLXPZL`, … | Game-specific event specs ("Параметры события" tables), feature TЗ, and that game's A/B tests. |

## Anchor pages (start here)
- **Master Events Schema** (single source of truth for every custom analytics event — meaning,
  trigger, parameters, formats/values, per-project status, version history):
  `https://openmygame.atlassian.net/wiki/spaces/PA/pages/2602991642`.
- **Event QA rules** (required fields, enum/null rules, banner-ad exceptions, anomaly checks;
  realtime export `bi_data_export.qa_export__analytical_events_realtime`):
  `https://openmygame.atlassian.net/wiki/spaces/BI/pages/4797726777`.
- **A/B testing** (approach + Jira pipeline + naming rules):
  `https://openmygame.atlassian.net/wiki/spaces/PA/pages/4661444646` and
  `https://openmygame.atlassian.net/wiki/spaces/PA/pages/4881940484`.
- **Dimensions / Metrics index**: browse the BI space and filter by label —
  `bi-dimension`, `bi-metric`, `bi-economics-dimension`, `bi-ad-quality-dimension`,
  `bi-player-dynamic-dimension`, `bi-stability-dimension`, `mtz-dimension`.

## How to FIND a specific definition (don't guess — look it up)
- **A metric** (e.g. "Game Completion Rate"): search the BI space for the page titled
  `[Metric] <name>`; read its Description + Calculation. CQL: `space = BI AND title ~ "<name>"`.
- **A dimension** (e.g. "Ad Network", "Inapp Placement"): search BI for `[Dimension] <name>`,
  or browse by the relevant `bi-…-dimension` label.
- **An event / its parameters / when it fires**: read the master Events Schema (PA/2602991642)
  — it's the catalogue. For a game-specific spec, search that game's space for the event name
  (e.g. `space = JCS AND title ~ "currency"`).
- **What's actually live here / exact field names + real values**: `describe_catalog` —
  `({ event })` for an event's properties, `({ property })` for values + cardinality,
  `({ search })` to map a business term/value to its property and the event(s) carrying it.
  This is the runtime source of truth that the Confluence pages describe.

## When you cite a number
Link the Confluence definition you relied on (the `[Metric]`/`[Dimension]` page or the
events-schema section) and state the tier (governed metric › custom pipeline) + freshness —
see the provenance footer in `reference/playbooks.md`.
