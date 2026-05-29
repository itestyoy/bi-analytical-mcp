{{ config(materialized='table') }}
select d::date as date_day
from generate_series(
    '2030-01-01'::date,
    '2030-12-31'::date,
    interval '1 day'
) as d
