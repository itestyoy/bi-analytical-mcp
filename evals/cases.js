// THE GOLDEN SET — questions an analyst asks, put to a model that has only this server's tools.
//
// A case is { id, kind, prompt, expect, answer, ref }:
//   kind    'direct'   — the question names what to compute;
//           'indirect' — it states the need and leaves the model to find the metric;
//           'negative' — the server has nothing to do with it (or the data does not exist), and
//                        the right behaviour is to not build or query anything.
//   expect  what a good run looks like at the tool level: `any` — at least one of these tools is
//           called; `forbid` — none of these is ('*': no tool at all); `max_calls` — a budget.
//   answer  what a correct final answer states, COMPUTED FROM THE WAREHOUSE, never written down:
//           `sql` runs against the fixture database (the relations dbt built from the seeds) and
//           returns column `v` (and `k` for a map). { kind: 'number', sql, tolerance? } — the
//           answer names the number; { kind: 'label', sql } — it names the label (the top one);
//           { kind: 'map', sql } — it names every key and its value; { kind: 'none' } — nothing
//           to state (a negative case, graded on its tools).
//   ref     a path through the tools that reaches the same answer — a pipeline over `source`,
//           read at `column` (number), or at `key`/`value` (label: the row with the largest
//           value; map: every row). `npm run eval:check` runs it and holds it to `answer.sql`, so
//           every positive case is known to be answerable with the tools as they are.
//
// The vocabulary is the fixture catalog's (test/integration/fixtures/catalog.yml): the sources
// events, crashlytics, acquisition, users and experiments. Nothing here names a column the model
// could not find through semantic_index.

export const CASES = [
  {
    id: 'iap_revenue_total',
    kind: 'direct',
    prompt: 'What is the total revenue from completed in-app purchases, in USD, across all the data?',
    expect: { any: ['query_semantic_model', 'query_pipeline_model', 'build_pipeline_model'], max_calls: 12 },
    answer: { kind: 'number', sql: "SELECT SUM(price_in_usd_of_event_data) AS v FROM fct_analytics_events WHERE event_name = 'iap_purchase_completed'" },
    ref: {
      source: 'events',
      stages: [
        { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] },
        { stage: 'derive', name: 'price', op: 'extract', source: 'price_in_usd_of_event_data', type: 'numeric' },
        { stage: 'aggregate', measures: [{ name: 'revenue', fn: 'sum', column: 'price' }] },
      ],
      column: 'revenue',
    },
  },
  {
    id: 'distinct_payers',
    kind: 'direct',
    prompt: 'How many distinct players completed at least one in-app purchase?',
    expect: { any: ['query_semantic_model', 'query_pipeline_model', 'build_pipeline_model'], max_calls: 12 },
    answer: { kind: 'number', sql: "SELECT COUNT(DISTINCT player_id_of_internal) AS v FROM fct_analytics_events WHERE event_name = 'iap_purchase_completed'" },
    ref: {
      source: 'events',
      stages: [
        { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] },
        { stage: 'aggregate', measures: [{ name: 'payers', fn: 'count_distinct', column: 'player_id_of_internal' }] },
      ],
      column: 'payers',
    },
  },
  {
    id: 'events_total',
    kind: 'direct',
    prompt: 'How many rows does the product-analytics events source hold in total?',
    expect: { any: ['query_semantic_model', 'query_pipeline_model', 'build_pipeline_model'], max_calls: 10 },
    answer: { kind: 'number', sql: 'SELECT COUNT(*) AS v FROM fct_analytics_events' },
    ref: { source: 'events', stages: [{ stage: 'aggregate', measures: [{ name: 'n', fn: 'count' }] }], column: 'n' },
  },
  {
    id: 'fatal_crashes',
    kind: 'direct',
    prompt: 'How many fatal crashes were reported to Crashlytics?',
    expect: { any: ['query_semantic_model', 'query_pipeline_model', 'build_pipeline_model'], max_calls: 12 },
    answer: { kind: 'number', sql: 'SELECT COUNT(*) AS v FROM fct_crashlytics_events WHERE is_fatal_of_event_data' },
    ref: {
      source: 'crashlytics',
      stages: [
        { stage: 'derive', name: 'fatal', op: 'extract', source: 'is_fatal_of_event_data', type: 'string' },
        { stage: 'where', conditions: [{ column: 'fatal', op: 'eq', value: 'true' }] },
        { stage: 'aggregate', measures: [{ name: 'n', fn: 'count' }] },
      ],
      column: 'n',
    },
  },
  {
    id: 'acquisition_spend_total',
    kind: 'direct',
    prompt: 'What was our total user-acquisition spend (cost) over the whole period?',
    expect: { any: ['query_semantic_model', 'query_pipeline_model', 'build_pipeline_model'], max_calls: 10 },
    answer: { kind: 'number', sql: 'SELECT SUM(cost) AS v FROM fct_player_acquisition' },
    ref: { source: 'acquisition', stages: [{ stage: 'aggregate', measures: [{ name: 'spend', fn: 'sum', column: 'cost' }] }], column: 'spend' },
  },
  {
    id: 'experiment_split',
    kind: 'direct',
    prompt: 'How many players are assigned to each variant of the checkout_flow experiment?',
    expect: { any: ['query_semantic_model', 'query_pipeline_model', 'build_pipeline_model'], max_calls: 12 },
    answer: { kind: 'map', sql: "SELECT variant_group AS k, COUNT(DISTINCT player_id_of_internal) AS v FROM fct_experiment_assignments WHERE experiment_name = 'checkout_flow' GROUP BY 1" },
    ref: {
      source: 'events',
      stages: [
        { stage: 'join', with: 'experiments', via: 'user', kind: 'inner', attrs: ['variant_group', 'experiment_name'] },
        { stage: 'where', conditions: [{ column: 'experiment_name', op: 'eq', value: 'checkout_flow' }] },
        { stage: 'aggregate', group_by: ['variant_group'], measures: [{ name: 'players', fn: 'count_distinct', column: 'player_id_of_internal' }] },
      ],
      key: 'variant_group',
      value: 'players',
    },
  },
  {
    id: 'top_product',
    kind: 'indirect',
    prompt: 'Which of our products brings in the most money?',
    expect: { any: ['query_semantic_model', 'query_pipeline_model', 'build_pipeline_model'], max_calls: 14 },
    answer: { kind: 'label', sql: "SELECT product_id_of_event_data AS v FROM fct_analytics_events WHERE event_name = 'iap_purchase_completed' GROUP BY 1 ORDER BY SUM(price_in_usd_of_event_data) DESC LIMIT 1" },
    ref: {
      source: 'events',
      stages: [
        { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] },
        { stage: 'derive', name: 'product', op: 'extract', source: 'product_id_of_event_data', type: 'string' },
        { stage: 'derive', name: 'price', op: 'extract', source: 'price_in_usd_of_event_data', type: 'numeric' },
        { stage: 'aggregate', group_by: ['product'], measures: [{ name: 'revenue', fn: 'sum', column: 'price' }] },
      ],
      key: 'product',
      value: 'revenue',
    },
  },
  {
    id: 'ads_watched',
    kind: 'indirect',
    prompt: 'How many ads did players watch all the way to the end?',
    expect: { any: ['query_semantic_model', 'query_pipeline_model', 'build_pipeline_model'], max_calls: 12 },
    answer: { kind: 'number', sql: "SELECT COUNT(*) AS v FROM fct_analytics_events WHERE event_name = 'ad_finished'" },
    ref: {
      source: 'events',
      stages: [
        { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'ad_finished' }] },
        { stage: 'aggregate', measures: [{ name: 'n', fn: 'count' }] },
      ],
      column: 'n',
    },
  },
  {
    id: 'top_spend_source',
    kind: 'indirect',
    prompt: 'Where did most of our marketing budget go — which media source?',
    expect: { any: ['query_semantic_model', 'query_pipeline_model', 'build_pipeline_model'], max_calls: 12 },
    answer: { kind: 'label', sql: 'SELECT media_source AS v FROM fct_player_acquisition GROUP BY 1 ORDER BY SUM(cost) DESC LIMIT 1' },
    ref: {
      source: 'acquisition',
      stages: [{ stage: 'aggregate', group_by: ['media_source'], measures: [{ name: 'spend', fn: 'sum', column: 'cost' }] }],
      key: 'media_source',
      value: 'spend',
    },
  },
  {
    id: 'level_funnel',
    kind: 'indirect',
    prompt: 'Of the players who started a level, how many went on to complete one?',
    expect: { any: ['query_pipeline_model', 'build_pipeline_model', 'query_semantic_model'], max_calls: 14 },
    answer: {
      kind: 'number',
      sql: `SELECT COUNT(DISTINCT s.player_id_of_internal) AS v FROM fct_analytics_events s
            WHERE s.event_name = 'level_started' AND EXISTS (
              SELECT 1 FROM fct_analytics_events c WHERE c.player_id_of_internal = s.player_id_of_internal
                AND c.event_name = 'level_completed' AND c.device_time > s.device_time)`,
    },
    ref: {
      source: 'events',
      stages: [
        { stage: 'match_recognize', partition_by: ['player_id_of_internal'], mode: 'ordered', steps: [
          { name: 'started', event_name: ['level_started'] },
          { name: 'done', event_name: ['level_completed'] },
        ] },
        { stage: 'where', conditions: [{ column: 'reached_done', op: 'eq', value: true }] },
        { stage: 'aggregate', measures: [{ name: 'n', fn: 'count' }] },
      ],
      column: 'n',
    },
  },
  {
    id: 'weather',
    kind: 'negative',
    prompt: 'What is the weather like in Paris right now?',
    expect: { forbid: '*' },
    answer: { kind: 'none' },
  },
  {
    id: 'string_reverse',
    kind: 'negative',
    prompt: 'Write a JavaScript function that reverses a string.',
    expect: { forbid: '*' },
    answer: { kind: 'none' },
  },
  {
    id: 'absent_orders',
    kind: 'negative',
    prompt: 'How many orders did customers place in our online shop last month? Use the orders table.',
    // looking is right (the catalog says what exists); building or querying something that is not
    // there, or answering with a number, is not
    expect: { forbid: ['build_semantic_model', 'build_pipeline_model', 'query_semantic_model', 'query_pipeline_model', 'display_model_result'] },
    answer: { kind: 'none' },
  },
];
