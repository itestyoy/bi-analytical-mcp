{{ config(materialized='table') }}
select
    campaign_id,
    channel,
    network,
    cost_model
from raw_campaigns
