{{ config(materialized='table') }}
select
    internal_player_id,
    country,
    platform,
    install_time_valid_from,
    install_time_valid_until
from {{ ref('seed_users_scd') }}
