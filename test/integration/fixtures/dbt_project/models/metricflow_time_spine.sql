{{ config(materialized='table') }}
select d::date as date_day
from generate_series(
    '2026-01-01'::date,
    '2026-12-31'::date,
    interval '1 day'
) as d
