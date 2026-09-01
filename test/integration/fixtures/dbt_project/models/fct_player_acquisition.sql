{{ config(materialized='table') }}
-- Player-level acquisition spend: one row per (player, day). NOT an events source — it has
-- no event_name — but it does have a TIME AXIS and its own MEASURES, both declared in the
-- catalog. `acquisition_id` is the surrogate key that makes the grain explicit.
select
    row_id            as acquisition_id,
    player_id         as player_id_of_internal,
    spend_date,
    media_source,
    campaign,
    campaign_id,
    ingest_batch_id,
    cost,
    impressions,
    clicks
from {{ ref('seed_acquisition') }}
