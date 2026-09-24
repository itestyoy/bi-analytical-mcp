{{ config(materialized='table') }}
select
    event_id,
    internal_player_id,
    event_name,
    device_time,
    event_data,
    (event_data->>'price_in_usd')::double as price_in_usd_of_event_data,
    (event_data->>'product_id')            as product_id_of_event_data
from {{ ref('seed_events_scd') }}
