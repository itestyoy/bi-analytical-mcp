{{ config(materialized='table') }}
select
    customer_id,
    customer_type,
    first_ordered_at
from {{ ref('raw_customers') }}
