// RESEARCH GUIDES — how to run an analytical investigation with this server, and what matters in
// three domains of a free-to-play product: engagement / retention, monetization, user acquisition.
//
// Served by semantic_index({ guide: "research" }) and ({ guide: "research/<domain>" }), and as the
// `research` skill (src/skills.js renders these same objects — no second copy of the text). They
// are METHOD, not data: no column, event or model is named here — the catalog says what exists
// (semantic_index), and every "how" points at a tool or a shipped recipe (config/recipes.json;
// test/unit/research-guides.test.js holds each recipe id named here to that file).
//
// Where the method comes from — adapted and rewritten for this server, not copied:
//   * the analysis / validation / statistics skills of Anthropic's knowledge-work-plugins "data"
//     plugin (Apache-2.0, github.com/anthropics/knowledge-work-plugins) and its product-management
//     and marketing plugins;
//   * the metric-diagnostics / product-business-analysis / validate-data / analyze-data-quality /
//     design-kpis skills of OpenAI's Data Analytics plugin (MIT,
//     github.com/openai/role-specific-plugins);
//   * the domain practice cited per guide under `sources`.

const SOURCES_METHOD = [
  'Anthropic knowledge-work-plugins, data plugin (analyze, explore-data, statistical-analysis, validate-data) — github.com/anthropics/knowledge-work-plugins (Apache-2.0)',
  'OpenAI Data Analytics plugin (metric-diagnostics, product-business-analysis, validate-data, analyze-data-quality, design-kpis) — github.com/openai/role-specific-plugins (MIT)',
];

const RESEARCH = {
  title: 'How to run an analytical investigation',
  when_to_use: 'An open question rather than a lookup: why a metric moved, what drives an outcome, whether a change worked, where to invest, a product / monetization / UA deep dive. A single known number ("DAU yesterday") needs none of this — query it.',
  principles: [
    'Start from the decision: who will act on the answer and what they will do differently. The decision sets the depth — a quick answer, a full analysis, or a formal report — and keeps the work from turning into open-ended exploration.',
    'Ask only when a missing input would change the frame (the metric, the population, the window); otherwise state the assumption and proceed.',
    'Verify the size, timing and scope of a pattern before looking for its causes — most "drops" that dissolve on inspection are incomplete periods, tracking changes or a different definition.',
    'Treat a measurement change (a new app version\'s logging, late data, a filter) as a candidate explanation, on equal footing with a behaviour change.',
    'Timing alone is not causation: a change that coincides with a release is a hypothesis until an experiment or a variation the user did not choose supports it.',
  ],
  sequence: [
    { step: 'Frame', do: 'Write the question as one sentence with its decision, the metric, the population and the comparison ("D7 retention of new Android installs, last complete week vs the 4 weeks before"). Resolve relative dates to complete periods. List 2–4 hypotheses before querying, each with the number that would confirm or reject it.', why: 'Hypotheses turn exploration into a few focused queries; a vague frame produces many queries and no answer.' },
    { step: 'Lock the metric contract', do: 'Find the real fields with semantic_index (overview → { source, event } → { source, property } / { search }), and fix the definition: numerator, denominator, grain (per event / per user / per day), filters, timezone of the day boundary, window. Prefer a governed metric (build_semantic_model) — its definition is reusable and reviewable; a pipeline only when no metric can express it.', why: 'Two analysts who disagree usually measured two different things. The catalog is the starting map of what exists, not the edge of what can be asked.' },
    { step: 'Check the data before the behaviour', do: 'Volume and NULL coverage per day, per app version and per platform around the period (recipe pipeline_volume_and_coverage_check); the latest data time (freshness); duplicates; test / internal users excluded. A break confined to one version or platform is usually tracking.', why: 'A tracking change looks exactly like a behaviour change in the aggregate.' },
    { step: 'Reproduce the headline', do: 'Recompute the number the question is about, with the contract above, and compare it with the figure the person saw. Compare against the right baseline: the same weekday a week earlier, the same period a year earlier, complete periods only.', why: 'An investigation of a number you cannot reproduce investigates the wrong thing; seasonality and weekday mix explain many "changes".' },
    { step: 'Decompose', do: 'Split the metric into its drivers and find which one moved: a rate into numerator vs denominator; a total into its multiplicative factors (revenue = DAU × payer conversion × ARPPU + ad revenue; DAU = new + retained + resurrected). Then segment the driver that moved, in a fixed order — platform → app version → country → acquisition source → install cohort → payer status — with one breakdown per query (several at once in one batch: query_semantic_model({ queries })).', why: 'A driver tree localises the change; a fixed segment order keeps you from stopping at the first plausible cut.' },
    { step: 'Separate mix from rate', do: 'For each segment show both its share of the population and its own value, in the base and the current period. A total can move while every segment stays flat (the mix shifted) — or against every segment (Simpson\'s paradox). Reconcile: the segment contributions should add up to the total change, or size the residual.', why: 'A burst of low-quality installs lowers total retention with no segment getting worse; the fix is in acquisition, not in the product.' },
    { step: 'Localise in the product', do: 'Where in the journey it happens: a funnel over the steps (recipe funnel_from_event_property_steps, or an ordered sequence: pipeline_ordered_sequence), time between steps, per segment.', why: 'The drop sits at one step far more often than everywhere at once.' },
    { step: 'Test the explanation', do: 'An experiment answers causation: per-group aggregates in a pipeline, then experiment({ action: "check_split" }) and ({ action: "analyze" }) (recipes ab_test_*). Two groups that are not an experiment: two_sample_significance. Without either, look for variation the user did not choose (a staged rollout, a region, a date), and say what the evidence cannot rule out.', why: 'Users who adopt a feature are already different users — a comparison of adopters and non-adopters measures selection, not the feature.' },
    { step: 'Review, then report', do: 'Run the checks below, rate the result (ready / share with caveats / needs revision), and report as described under `report`.', why: 'The first plausible story is rarely the whole one; a result that confirms the hypothesis without friction deserves a second look.' },
  ],
  checks: [
    'Row counts after every join: a join that multiplies rows inflates every sum after it — count entities with count_distinct, and join a slowly-changing model point-in-time (pipeline_point_in_time_join).',
    'No average of averages: compute a rate from summed numerators and denominators (ratio_metric), not by averaging per-segment rates.',
    'Complete periods and mature cohorts only: a cohort that has not reached day N has no day-N value yet.',
    'Denominators: the same population in the base and the current period; a changed filter changes the answer.',
    'Distributions: mean next to median and percentiles for amounts (revenue, sessions); outliers reported, not silently dropped.',
    'Multiple comparisons: with many segments, one will look significant by chance — correct (holm / bonferroni in experiment) or treat it as a hypothesis.',
    'Segments defined before the outcome: grouping users by something the outcome caused (spent money → "payers retain better") builds the conclusion into the groups.',
    'Recompute the key numbers a second way (another grain, another query path, one day by hand) before presenting them.',
  ],
  report: [
    'The answer first, in one or two sentences, sized ("D7 fell 2.1 pp; 1.6 pp of it is the Android 5.2 cohort").',
    'The evidence: the decomposition, with each driver\'s share of the change, and what was ruled out.',
    'Method and provenance: governed metric or pipeline, grain, filters, time window (complete periods), data freshness.',
    'Caveats next to the claims they qualify; ranges rather than false precision; observation kept apart from interpretation.',
    'Recommendation and next step — an experiment, an instrumentation fix, a deeper cut — marked provisional when the evidence is incomplete.',
  ],
  domains: {
    'research/product': 'engagement and retention: why DAU or retention moved, what drives retention, feature impact, stickiness.',
    'research/monetization': 'IAP and ad revenue: why revenue moved, cohort value (cumulative ARPU / LTV), payer conversion, concentration, offers.',
    'research/ua': 'user acquisition: CPI, ROAS, payback, channel / campaign quality, organic vs paid, incrementality.',
  },
  sources: SOURCES_METHOD,
};

const PRODUCT = {
  title: 'Product analytics: engagement and retention',
  when_to_use: 'Why DAU, sessions or retention moved; what behaviour predicts retention; whether a feature or release helped; how healthy engagement is.',
  sequence: [
    'Frame and lock the metric: what counts as "active" (any event, a session, a core action), the day boundary\'s timezone, which retention (below).',
    'Check tracking by app version and platform over the period (pipeline_volume_and_coverage_check) before reading behaviour.',
    'Rule out calendar effects: same weekday a week earlier, the same period a year earlier, holidays, weekday/weekend mix.',
    'Growth accounting for DAU: new + retained + resurrected users, minus those who churned — is the change coming from acquisition (new) or from the product (retained)?',
    'Segment the component that moved: platform → app version → country → acquisition source (paid / organic, network) → install cohort → payer status; show the mix next to each segment\'s value.',
    'Localise with a funnel over the first session / onboarding / the core loop, per segment (funnel_from_event_property_steps, pipeline_ordered_sequence).',
    'Test: an experiment or a staged rollout; otherwise state the self-selection risk.',
  ],
  metrics: [
    { metric: 'N-day retention ("return on day N")', definition: 'Share of an install cohort active on exactly day N after install (D1, D3, D7, D14, D30). The standard for games. Build it on two time axes — the cohort\'s install date and the activity date (recipe cohort_grid_two_time_axes; an age axis: pipeline_age_offset_axis).' },
    { metric: 'Rolling / unbounded retention', definition: 'Share active on day N or any later day. Always higher than N-day; state which one a number is.' },
    { metric: 'Day boundary', definition: '24-hour windows since install or calendar days in a timezone — pick one and say it; they differ most for D1.' },
    { metric: 'Retention curve shape', definition: 'Keeps falling (no habit forms), flattens (a retained base — the plateau level is what to compare), or rises again (users come back). A drop at D1 points at onboarding / activation, a steady decline at the core loop.' },
    { metric: 'Stickiness', definition: 'DAU / MAU as one blunt number; better the distribution of days active per month (L28/L30): a "smile" with a power-user bump is healthy, an L-shape is not.' },
    { metric: 'Growth accounting', definition: 'DAU(t) = new + retained + resurrected; quick ratio = (new + resurrected) / churned — above 1 grows.' },
  ],
  questions: [
    { question: 'Why did DAU drop?', approach: 'Growth accounting → segment the component that moved → mix vs rate decomposition.' },
    { question: 'Why did D1 retention drop?', approach: 'Tracking check by version → install-cohort retention by source and country → onboarding funnel per segment.' },
    { question: 'What drives retention?', approach: 'Retention of users who did / did not do behaviour X in their first session or day — a hypothesis until an experiment confirms it (engaged users do more of everything).' },
    { question: 'Did the feature / release help?', approach: 'An experiment if there was one (ab_test_* recipes). Otherwise compare cohorts before / after the release at the same cohort age, and a region or rollout that did not get it; say what the comparison cannot rule out.' },
    { question: 'Is engagement healthy?', approach: 'DAU/MAU plus the days-active distribution, per cohort age.' },
  ],
  pitfalls: [
    'Immature cohorts: a cohort installed 10 days ago has no D30 — compare at equal cohort age only.',
    'Mix shift read as behaviour: a UA burst of low-intent installs lowers total retention while every channel stays flat.',
    'Self-selection in feature impact: adopters differ before they adopt; without an experiment it is correlation.',
    'An engagement metric alone can reward friction (more sessions because the flow got harder) — pair it with an outcome.',
    'UTC vs local date: an event date in the property\'s timezone and an event timestamp in UTC split days differently.',
  ],
  sources: [
    ...SOURCES_METHOD,
    'Amplitude — retention analysis and growth accounting: amplitude.com/docs/analytics/charts/retention-analysis/retention-analysis-interpret, amplitude.com/blog/growth-accounting',
    'Reforge — evaluating retention cohorts: reforge.com/guides/evaluate-retention-cohorts',
    'Andrew Chen — the power user curve: andrewchen.com/power-user-curve',
    'devtodev game analytics glossary: devtodev.com/resources/articles/game-analytics-metrics-glossary',
    'Google — mix effects / Simpson\'s paradox in metric changes: research.google.com/pubs/archive/42901.pdf',
  ],
};

const MONETIZATION = {
  title: 'Monetization: in-app purchases and ads',
  when_to_use: 'Why revenue moved; how much a cohort is worth; payer conversion and first-purchase timing; dependence on a few payers; whether an offer, price or ad-load change worked.',
  sequence: [
    'Validate revenue first: test / sandbox purchases excluded, refunds handled (sign and timing), duplicates removed, one currency at the transaction-date rate, and gross vs net stated (store fees of 15–30 %, taxes).',
    'Decompose: revenue = DAU × ARPDAU; IAP ARPDAU = payer conversion × ARPPU; ad ARPDAU = impressions per DAU × eCPM / 1000. Find the factor that moved.',
    'Segment that factor: platform, country, payer tier, cohort age — with the mix next to each value.',
    'Choose the view by the question: calendar (what happened this week, across all users) or cohort (what users acquired in a period are worth by day N).',
    'Concentration: share of revenue from the top 1 / 5 / 10 % of payers; ARPPU with and without them.',
    'Offer / price analysis and first-purchase timing; an experiment for any change (ab_test_revenue, ab_test_ratio, ab_test_cuped).',
  ],
  metrics: [
    { metric: 'ARPDAU', definition: 'Revenue on a day ÷ that day\'s DAU. Weekday and weekend differ — compare like with like.' },
    { metric: 'ARPU / ARPPU', definition: 'Revenue ÷ active users in a period / revenue ÷ paying users in the period. Say which period.' },
    { metric: 'Payer conversion — two definitions', definition: 'Paying share (payers ÷ active users in the period) vs first-payment conversion (share of an install cohort that has paid at least once by day N). State which one.' },
    { metric: '"Paying user"', definition: 'Purchasers only, or also ad viewers — define it; ARPPU changes meaning with it.' },
    { metric: 'Cumulative ARPU by cohort day (empirical LTV)', definition: 'Revenue to date of an install cohort ÷ its installs, at day 0, 1, 7, 30… — compare cohorts at the same age (cohort_grid_two_time_axes, cumulative_metric).' },
    { metric: 'LTV', definition: 'Revenue per user over the lifetime — observed to date plus a projection; the projection is the uncertain part.' },
    { metric: 'First purchase timing', definition: 'Days from install to the first purchase; most first purchases happen in the first week, so early conversion is the lead indicator.' },
    { metric: 'eCPM, impressions per DAU, ad ARPDAU', definition: 'eCPM = ad revenue ÷ impressions × 1000; impressions per DAU = share of DAU that sees ads × impressions per viewer; ad ARPDAU = impressions per DAU × eCPM / 1000. User-level ad revenue needs impression-level revenue data; otherwise per-user ad revenue is an average.' },
  ],
  questions: [
    { question: 'Why did revenue fall?', approach: 'Validate → DAU × conversion × ARPPU + impressions/DAU × eCPM → segment the factor that moved (a derived metric per factor: derived_metric_formula, ratio_metric).' },
    { question: 'Is a cohort monetizing better?', approach: 'Cumulative ARPU curves by install week at equal cohort ages.' },
    { question: 'Did the offer / price change work?', approach: 'Conversion and ARPPU by price point and segment in an experiment (ab_test_revenue; CUPED for variance), watching for cannibalisation of other products.' },
    { question: 'Are we dependent on a few payers?', approach: 'Revenue share of the top 1 / 5 / 10 % of payers (a pipeline: rank payers by revenue, then aggregate by tier); medians alongside means.' },
    { question: 'Does ad load hurt retention?', approach: 'Retention by band of impressions per user — correlation (heavy players see more ads); confirm with an experiment.' },
  ],
  pitfalls: [
    'Client-side purchase events are usually gross and may miss refunds and renewals — reconcile with store / server receipts where the catalog has them.',
    'Test and sandbox purchases reach the event stream even though the stores exclude them from their own reports.',
    'A few payers move ARPPU and ARPDAU: report medians and tiers, and an average per payer tier rather than one mean.',
    'Refund sign, duplicate transactions and currency conversion — each silently shifts every revenue metric after it.',
    'Comparing cohorts at different ages, or calendar revenue with cohort revenue.',
  ],
  sources: [
    ...SOURCES_METHOD,
    'GameAnalytics — ARPU, ARPPU, ARPDAU: gameanalytics.com/blog/how-to-calculate-arpu-arppu-arpdau-and-more',
    'devtodev game analytics glossary: devtodev.com/resources/articles/game-analytics-metrics-glossary',
    'Mobile Dev Memo (Eric Seufert) — LTV and marketing P&L: mobiledevmemo.com/ltv-roas-marketing-p-and-l',
    'AppsFlyer — measurement for gaming apps: appsflyer.com/blog/measurement-analytics/measurement-analytics-gaming-apps',
    'AppLovin — user-level ad revenue (ILRD): applovin.com/blog/three-ways-you-can-measure-user-level-ad-revenue-with-max',
  ],
};

const UA = {
  title: 'User acquisition: cost, return and incrementality',
  when_to_use: 'Which channel, campaign or creative to scale; when a cohort pays back; paid vs organic; whether paid spend is incremental; how iOS measurement limits the answer.',
  sequence: [
    'Join spend and installs at the SAME grain (day × network × campaign × country × platform) before bringing revenue in: spend joined to user or event rows multiplies it. Aggregate each source to that grain first (metrics_from_two_sources for side by side; a pipeline join by the declared relationship only to carry an attribute).',
    'Compute CPI, then cohort ROAS at D0 / D7 / D30, then payback, per channel → campaign → creative, with a minimum install count per row.',
    'Compare paid with organic, and check whether organic installs move with spend (uplift or cannibalisation).',
    'Project LTV and payback, and treat everything beyond the observed cohort age as uncertain.',
    'Validate attribution with an incrementality test (geo-lift, a holdout, a pause) where the decision is large.',
  ],
  metrics: [
    { metric: 'CPI / CAC / blended CPI', definition: 'Spend ÷ attributed installs / spend ÷ acquired payers / spend ÷ all installs (paid + organic) — judge a channel on its own CPI, the business on the blended one.' },
    { metric: 'ROAS Dn', definition: 'Revenue of an install cohort up to day n ÷ that cohort\'s spend (D7 ROAS 50 % = half the spend back by day 7). Include ad revenue for ad-monetized titles.' },
    { metric: 'Payback day', definition: 'The cohort day where cumulative revenue per user crosses CPI (or CAC); for IAP-heavy games often months.' },
    { metric: 'Organic uplift', definition: '(Total installs − organic baseline − attributed paid installs) ÷ attributed paid installs — the organics paid spend brings along.' },
    { metric: 'Attribution windows', definition: 'Click and view-through lookback windows of the MMP (commonly 7 days / 24 hours); on iOS, SKAdNetwork / AdAttributionKit postbacks arrive in windows with coarse values and a privacy threshold that hides small campaigns.' },
  ],
  questions: [
    { question: 'Which channel / campaign / creative to scale?', approach: 'CPI, D7 / D30 ROAS and retention per row with a minimum volume, cohorts compared at equal age.' },
    { question: 'When do we pay back?', approach: 'Cumulative revenue per user (IAP + ads) against CPI by cohort day; the crossing day, with the projection marked.' },
    { question: 'Is paid incremental?', approach: 'A geo-lift or holdout test, plus the organic-uplift relation between spend and organic installs over time.' },
    { question: 'How to split the budget?', approach: 'A media-mix model calibrated with lift tests — outside this server; bring its inputs (spend and installs by channel and day) from here.' },
    { question: 'Is iOS worse after ATT?', approach: 'SKAN / AdAttributionKit postback data and coarse-value distributions next to blended ROAS; attributed iOS numbers are a lower bound.' },
  ],
  pitfalls: [
    'Spend fan-out: joining daily spend onto user or event rows multiplies it — aggregate both sides to one grain first.',
    'Small cohorts give noisy ROAS: pool, or set a minimum install count before ranking.',
    'Attribution bias: last-touch and self-reporting networks over-claim; organic cannibalisation looks like paid performance.',
    'LTV projection error grows with cohort age — few old users, old behaviour; do not extend the payback window to justify spend.',
    'Ad revenue without impression-level data understates ROAS for ad-heavy cohorts.',
  ],
  sources: [
    ...SOURCES_METHOD,
    'AppsFlyer — lookback windows and organic uplift: support.appsflyer.com/hc/en-us/articles/208338403, appsflyer.com/blog/measurement-analytics/organic-uplift-multiplier-app-marketing',
    'Adjust — how SKAdNetwork 4 works: help.adjust.com/en/article/how-skadnetwork-4-works',
    'Liftoff — ROAS and casual gaming benchmarks: liftoff.ai/blog/what-is-a-good-roas',
    'Mobile Dev Memo — payback windows and media-mix models: mobiledevmemo.com/the-danger-of-extending-marketing-payback-windows',
    'Meta GeoLift: github.com/facebookincubator/GeoLift; Google Meridian: github.com/google/meridian',
  ],
};

export const RESEARCH_GUIDES = { research: RESEARCH, 'research/product': PRODUCT, 'research/monetization': MONETIZATION, 'research/ua': UA };

/** Whether `name` names a research guide (research, research/<domain>). */
export function isResearchGuide(name) {
  return typeof name === 'string' && (name === 'research' || name.startsWith('research/'));
}

/** The research guide `name`, or a refusal-shaped answer naming the ones that exist. */
export function researchGuide(name) {
  const g = RESEARCH_GUIDES[name];
  if (g) return { guide: name, ...g, ...(name === 'research' ? {} : { start_with: 'semantic_index({ guide: "research" }) — the investigation sequence, the checks and the report this domain guide plugs into.' }) };
  return { guide: name, note: `No research guide '${name}'. Known: ${Object.keys(RESEARCH_GUIDES).join(', ')}.` };
}
