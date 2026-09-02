{{ config(materialized='table') }}
-- A SECOND events fact (role: crashlytics), independent of fct_analytics_events: its own
-- event vocabulary (fatal_crash / non_fatal / anr) and its own event-scoped payload, with
-- the same flattened `*_of_event_data` shape. Joined to dim_users by player_id_of_internal.
select
    crash_id,
    appsflyer_id  as player_id_of_internal,
    rewarded_tracking_id,
    interstitial_tracking_id,
    banner_tracking_id,
    event_name,
    event_time,
    issue_title   as issue_title_of_event_data,
    is_fatal      as is_fatal_of_event_data,
    anr_duration  as anr_duration_of_event_data,
    crash_message as crash_message_of_event_data,
    breadcrumbs   as breadcrumbs_of_event_data,
    stack_frames  as stack_frames_of_event_data,
    custom_keys   as custom_keys_of_event_data,
    app_version,
    device_model
from {{ ref('seed_crashlytics') }}
