{{ config(materialized='table') }}
select
    event_id,
    user_id,
    session_id,
    event_name,
    event_timestamp,
    event_properties
from {{ ref('seed_events') }}
