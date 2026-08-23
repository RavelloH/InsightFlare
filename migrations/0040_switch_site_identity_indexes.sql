-- Switch-phase indexes for the compact internal site key introduced in 0039.
--
-- Keep the site_id indexes during the compatibility window. They are removed
-- only after every reader and writer has been observed on the site_pk path and
-- the tables are rebuilt with site_pk NOT NULL.

CREATE INDEX idx_archive_objects_site_pk_hour
  ON archive_objects(site_pk, start_hour, end_hour);

CREATE INDEX idx_custom_event_json_keys_site_pk_key
  ON custom_event_json_keys(site_pk, "key");

CREATE INDEX idx_custom_event_json_paths_site_pk_path
  ON custom_event_json_paths(site_pk, path);

CREATE INDEX idx_custom_event_names_site_pk_name
  ON custom_event_names(site_pk, name);

CREATE INDEX idx_custom_event_values_site_pk_boolean_eq
  ON custom_event_json_values(site_pk, path_id, boolean_value, occurred_at, event_pk)
  WHERE value_type = 3;

CREATE INDEX idx_custom_event_values_site_pk_number_range
  ON custom_event_json_values(site_pk, path_id, number_value, occurred_at, event_pk)
  WHERE value_type = 2;

CREATE INDEX idx_custom_event_values_site_pk_path_time
  ON custom_event_json_values(site_pk, path_id, occurred_at, event_pk);

CREATE INDEX idx_custom_event_values_site_pk_string_eq
  ON custom_event_json_values(site_pk, path_id, string_hash, occurred_at, event_pk)
  WHERE value_type = 1;

CREATE INDEX idx_custom_events_site_pk_name_time
  ON custom_events(site_pk, event_name_id, occurred_at, event_pk);

CREATE INDEX idx_custom_events_site_pk_time
  ON custom_events(site_pk, occurred_at, event_pk);

CREATE INDEX idx_custom_events_site_pk_visit_time
  ON custom_events(site_pk, visit_id, occurred_at, event_pk);

CREATE INDEX idx_visit_hourly_aggregation_state_site_pk
  ON visit_hourly_aggregation_state(site_pk);

CREATE INDEX idx_visit_hourly_rollups_site_pk_hour
  ON visit_hourly_rollups(site_pk, hour_bucket);

CREATE INDEX idx_visits_open_site_pk_started_at
  ON visits(site_pk, started_at)
  WHERE status = 'open';

CREATE INDEX idx_visits_site_pk_session_started_at
  ON visits(site_pk, session_id, started_at);

CREATE INDEX idx_visits_site_pk_started_at
  ON visits(site_pk, started_at);

CREATE INDEX idx_visits_site_pk_last_activity
  ON visits(site_pk, last_activity_at);

CREATE INDEX idx_visits_site_pk_visitor_last_activity
  ON visits(site_pk, visitor_id, last_activity_at);

CREATE INDEX idx_visits_site_pk_visitor_started_at
  ON visits(site_pk, visitor_id, started_at);

PRAGMA optimize;
