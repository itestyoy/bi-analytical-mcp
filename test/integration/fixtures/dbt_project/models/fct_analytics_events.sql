{{ config(materialized='table') }}
select
    event_id,
    appsflyer_id,
    session_number,
    event_name,
    device_time,
    event_data
from {{ ref('seed_events') }}
