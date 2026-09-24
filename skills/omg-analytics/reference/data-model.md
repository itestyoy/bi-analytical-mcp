# Dimensions & metrics — where to read the definitions

The governed dimensions and metrics are defined in Confluence (**BI & Integration** space)
as `[Dimension] …` / `[Metric] …` pages, each with a Description + Calculation (the event +
parameter it derives from). **This file does not copy those definitions** (they change) — it
points you to them and shows how to find and use them. Read the page for the authoritative
calculation, then reproduce it in the MCP with `build_semantic_model`.

## How to find a definition
- **By name:** search the BI space for `[Metric] <name>` or `[Dimension] <name>`
  (CQL: `space = BI AND title ~ "<name>"`).
- **By area (label):** browse BI by label — `bi-metric`, `bi-dimension`,
  `bi-economics-dimension`, `bi-ad-quality-dimension`, `bi-player-dynamic-dimension`,
  `bi-stability-dimension`, `mtz-dimension`.
- **Events feeding it:** the page's Calculation names the event + param; cross-check the
  master Events Schema (see `reference/events.md`) and `semantic_index`.
- **Player attributes** (country/platform/ATT/GDPR/language/device/skill, …) resolve via the
  **users** dimension; **event-scoped** ones via `event_data` on the relevant event.

## Index of common pages (open for the definition)
Metrics:
- Game Completion Rate — `https://openmygame.atlassian.net/wiki/spaces/BI/pages/4502290434`
- Resource Income / Outcome (+ "in Coins" / Cumulative / per Player) —
  `…/pages/4207280165`, `…/pages/4207018040` (and the per-player/coins/cumulative variants)
- Resources Balance / Resource Return Ratio — `…/pages/4503273523`, `…/pages/4503240730`
- Cumulative Sessions / Session Duration — `…/pages/4503207971`, `…/pages/4503207937`
- Players Completed N Games — `…/pages/4493312113`
- Non-ATT Ad Impressions / Revenue — `…/pages/4503076865`, `…/pages/4503011329`

Dimensions:
- Ad Network — `…/pages/4826890654`; Inapp Placement — `…/pages/4748869633`;
  Inapp Product Category — `…/pages/4748836871`; Inapp Subscription Sequence — `…/pages/4748345359`
- Source Type / Source Name / Resource Currency — `…/pages/4207181856`, `…/pages/4207116344`, `…/pages/4206919739`
- Session Number — `…/pages/4508418049`; ATT Status — `…/pages/4469194769`;
  GDPR Applies — `…/pages/4469456913`; Install Time Zone — `…/pages/4469424144`
- Device Language Family / Device System Memory — `…/pages/4469456897`, `…/pages/4469194754`;
  Player Skill — `…/pages/4214849558`; Issue Title / Subtitle — `…/pages/4235788325`, `…/pages/4237197313`

(`…` = `https://openmygame.atlassian.net/wiki/spaces/BI`.) The complete, current set is the
BI space filtered by label — this index is a starting map, not the authority.

## Using them in the MCP
1. Read the metric/dimension page for its Calculation (event + param + filters/grain).
2. Reproduce the metric with `build_semantic_model` (measure over the right event scope),
   query with `query_semantic_model`; segment by a `users` attribute or an `event_data`
   dimension. Prefer governed metrics over ad-hoc aggregates.
3. Confirm the exact field name + real values with `semantic_index` before relying on them.
