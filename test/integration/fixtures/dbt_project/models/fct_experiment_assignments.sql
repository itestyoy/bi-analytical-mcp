{{ config(materialized='table') }}
select
    appsflyer_id as player_id_of_internal,
    experiment_name,
    variant_group,
    assigned_at,
    ended_at
from {{ ref('seed_experiments') }}
