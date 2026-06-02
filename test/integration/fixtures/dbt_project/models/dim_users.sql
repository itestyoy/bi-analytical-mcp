{{ config(materialized='table') }}
select
    appsflyer_id as internal__player_id,
    install_date,
    platform,
    os_version,
    device_model,
    country,
    region,
    language,
    media_source,
    acquisition_type,
    app_id,
    app_version,
    campaign_id
from {{ ref('seed_users') }}
