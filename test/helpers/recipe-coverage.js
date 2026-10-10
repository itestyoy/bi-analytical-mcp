// The shipped recipes another integration test builds FROM ITS OWN PAYLOAD and proves on its numbers:
// the recipe's first example query (or one with the same group_by and more metrics), or its pipeline
// started as it is served, asserted on exact values. recipes-parse.test.js skips these — running them
// again there would only re-check that a query that is already proven returns rows — so every recipe
// NOT listed here (a new one included) is still built and run by its loop.
//
// Each value names the test that holds the recipe: '<file under test/integration>:<test title>'.
// test/unit/recipes-layers.test.js holds every id to config/recipes.json, so a recipe removed there
// cannot leave a stale skip behind.

export const DATA_TESTED = {
  measure_over_metric_time: 'analytics-tasks.test.js:TASK measure_over_metric_time: DAU/WAU/MAU & event volume',
  group_by_joined_attribute: 'analytics-tasks.test.js:TASK group_by_joined_attribute: revenue/payers/ARPPU by user attribute (1-hop join)',
  funnel_from_event_property_steps: 'analytics-tasks.test.js:TASK funnel_from_event_property_steps: tutorial step_id drop-off 8 -> 5 -> 3',
  conversion_metric_window: 'analytics-tasks.test.js:TASK conversion_metric_window: a return (a second session) within 48h / 7×24h of the first launch',
  cohort_grid_two_time_axes: 'analytics-tasks.test.js:TASK cohort_grid_two_time_axes: install-cohort x activity revenue/buyers grid',
  boolean_condition_as_measure: 'analytics-tasks.test.js:TASK boolean_condition_as_measure: did-purchase and session counts as counts with a condition (8 of 21)',
  agg_chosen_per_question: 'analytics-tasks.test.js:TASK agg_chosen_per_question: starts/completes/rate per level_id',
  ratio_metric: 'analytics-tasks.test.js:TASK ratio_metric: revenue/ARPPU/AOV by product/day/segment',
  payload_property_measure_and_dimension: 'analytics-tasks.test.js:TASK payload_property_measure_and_dimension: ad revenue & impressions by network/placement',
  two_event_scopes_and_a_net: 'analytics-tasks.test.js:TASK two_event_scopes_and_a_net: coins in (510) vs out (140) & source split',
  experiment_conversion: 'end-to-end.test.js:5a. build_pipeline_model fed the conversion recipe stages → per-variant aggregates (control 6/6, variant 1/6)',
  experiment_revenue: 'model-results.test.js:revenue/user: DB aggregates → Welch t-test (means 10.833 vs 3.333)',
  experiment_cuped: 'model-results.test.js:CUPED: DB sufficient statistics → adjusted t-test (θ=0 with no pre-period)',
  experiment_ratio: 'model-results.test.js:ratio: DB per-user sums → delta-method test (level completion 16/16 vs 10/12)',
  metrics_from_two_sources: 'crashlytics-fact.test.js:metrics from BOTH facts in one query: launches 12, fatal 6',
  governed_measure_by_name: 'acquisition-source.test.js:a governed measure declared in the schema: total_spend = 17.50, applovin 8.25',
};
