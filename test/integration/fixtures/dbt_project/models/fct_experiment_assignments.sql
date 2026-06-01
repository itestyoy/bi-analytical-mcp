{{ config(materialized='table') }}
select
    appsflyer_id,
    experiment_name,
    variant_group,
    assigned_at,
    ended_at
from {{ ref('seed_experiments') }}
