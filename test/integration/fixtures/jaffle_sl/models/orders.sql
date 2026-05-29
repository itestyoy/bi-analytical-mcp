{{ config(materialized='table') }}
select
    order_id,
    customer_id,
    ordered_at,
    order_total,
    is_food_order,
    is_drink_order
from {{ ref('raw_orders') }}
