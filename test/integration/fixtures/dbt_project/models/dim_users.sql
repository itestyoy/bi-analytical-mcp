{{ config(materialized='table') }}
select
    user_id,
    install_date,
    platform,
    os_version,
    device_model,
    country,
    region,
    language,
    media_source,
    acquisition_type,
    app_version,
    campaign_id
from raw_users
