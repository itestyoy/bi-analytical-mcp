{{ config(materialized='table') }}
-- Mirror the production shape: rename the user key to player_id_of_internal, keep
-- the raw event_data JSON (for complex array properties), and flatten the scalar
-- payload keys into real, typed event_data__* columns referenced directly.
select
    event_id,
    appsflyer_id                                           as player_id_of_internal,
    tracking_id,
    session_number,
    event_name,
    bundle_id,
    device_time,
    event_data,
    (event_data->>'level_id')::int                         as level_id_of_event_data,
    (event_data->>'result')                                as result_of_event_data,
    (event_data->>'complete_time')::double                as daily_level_score_of_event_data,
    (event_data->>'attempt')::double                      as attempt_of_event_data,
    (event_data->>'amount')::double                       as amount_of_event_data,
    (event_data->>'currency')                              as currency_of_event_data,
    (event_data->>'value_in_coins')::double               as value_in_coins_of_event_data,
    (event_data->>'source_type')                           as source_type_of_event_data,
    (event_data->>'source_name')                           as source_name_of_event_data,
    (event_data->>'monetization_type')                     as monetization_type_of_event_data,
    (event_data->>'price_in_usd')::double                 as price_in_usd_of_event_data,
    (event_data->>'product_id')                            as product_id_of_event_data,
    (event_data->>'order_id')                              as order_id_of_event_data,
    (event_data->>'status')                                as status_of_event_data,
    (event_data->>'ad_type')                               as ad_type_of_event_data,
    (event_data->>'ad_network')                            as network_of_additional_info_of_event_data,
    (event_data->>'placement')                             as placement_of_event_data,
    (event_data->>'revenue')::double                      as revenue_of_event_data,
    (event_data->>'is_reward_received')                    as is_reward_received_of_event_data,
    (event_data->>'is_clicked')                            as is_clicked_of_event_data,
    (event_data->>'screen_from')                           as screen_from_of_event_data,
    (event_data->>'screen_to')                             as screen_to_of_event_data,
    (event_data->>'step_id')                               as element_of_event_data,
    -- payload array stored as a JSON-encoded STRING (mirrors the real warehouse,
    -- where words_selected lands as text like '["cat","dog"]' and must be parsed)
    (event_data->>'words_collected')                       as words_selected_of_event_data,
    -- the SAME array as a native JSON-typed column (mirrors a BigQuery JSON column declared
    -- data_type: json + array.encoding: json): presence/coverage must be measured without
    -- comparing the column to a string literal
    (event_data->'words_collected')                        as words_selected_json_of_event_data,
    -- a numeric value that arrives as STRING upstream (needs a cast to aggregate)
    (event_data->>'complete_time')                         as complete_time_of_event_data
from {{ ref('seed_events') }}
