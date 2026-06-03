{{ config(materialized='table') }}
select
    appsflyer_id as player_id_of_internal,
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
