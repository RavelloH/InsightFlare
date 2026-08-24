-- Contraction phase for the compact internal site references introduced in
-- 0039 and switched to by 0040.
--
-- site_id remains as an external projection for API responses and archive
-- metadata. site_pk is now the required relational key: old text indexes,
-- text-key primary/unique constraints, and compatibility triggers are removed.
-- Rebuild the affected tables so the NOT NULL and key changes are enforced by
-- SQLite itself rather than by application code.

PRAGMA defer_foreign_keys = ON;

DROP TRIGGER IF EXISTS trg_archive_objects_site_pk_insert;
DROP TRIGGER IF EXISTS trg_archive_objects_site_pk_update;
DROP TRIGGER IF EXISTS trg_custom_event_json_keys_site_pk_insert;
DROP TRIGGER IF EXISTS trg_custom_event_json_keys_site_pk_update;
DROP TRIGGER IF EXISTS trg_custom_event_json_paths_site_pk_insert;
DROP TRIGGER IF EXISTS trg_custom_event_json_paths_site_pk_update;
DROP TRIGGER IF EXISTS trg_custom_event_json_values_site_pk_insert;
DROP TRIGGER IF EXISTS trg_custom_event_json_values_site_pk_update;
DROP TRIGGER IF EXISTS trg_custom_event_names_site_pk_insert;
DROP TRIGGER IF EXISTS trg_custom_event_names_site_pk_update;
DROP TRIGGER IF EXISTS trg_custom_events_site_pk_insert;
DROP TRIGGER IF EXISTS trg_custom_events_site_pk_update;
DROP TRIGGER IF EXISTS trg_visit_hourly_aggregation_state_site_pk_insert;
DROP TRIGGER IF EXISTS trg_visit_hourly_aggregation_state_site_pk_update;
DROP TRIGGER IF EXISTS trg_visit_hourly_rollups_site_pk_insert;
DROP TRIGGER IF EXISTS trg_visit_hourly_rollups_site_pk_update;
DROP TRIGGER IF EXISTS trg_visits_site_pk_insert;
DROP TRIGGER IF EXISTS trg_visits_site_pk_update;

ALTER TABLE archive_objects RENAME TO archive_objects_old;
ALTER TABLE custom_event_json_keys RENAME TO custom_event_json_keys_old;
ALTER TABLE custom_event_json_paths RENAME TO custom_event_json_paths_old;
ALTER TABLE custom_event_json_values RENAME TO custom_event_json_values_old;
ALTER TABLE custom_event_json_nodes RENAME TO custom_event_json_nodes_old;
ALTER TABLE custom_event_names RENAME TO custom_event_names_old;
ALTER TABLE custom_events RENAME TO custom_events_old;
ALTER TABLE visit_hourly_aggregation_state RENAME TO visit_hourly_aggregation_state_old;
ALTER TABLE visit_hourly_rollups RENAME TO visit_hourly_rollups_old;
ALTER TABLE visits RENAME TO visits_old;

CREATE TABLE archive_objects (
  archive_key TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  start_hour INTEGER NOT NULL,
  end_hour INTEGER NOT NULL,
  granularity TEXT NOT NULL,
  format TEXT NOT NULL,
  row_count INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  site_pk INTEGER NOT NULL REFERENCES site_identities(site_pk)
);

CREATE TABLE custom_event_json_keys (
  id INTEGER PRIMARY KEY,
  site_id TEXT NOT NULL,
  key TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen_at INTEGER NOT NULL,
  site_pk INTEGER NOT NULL REFERENCES site_identities(site_pk)
);

CREATE TABLE custom_event_json_paths (
  id INTEGER PRIMARY KEY,
  site_id TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen_at INTEGER NOT NULL,
  site_pk INTEGER NOT NULL REFERENCES site_identities(site_pk)
);

CREATE TABLE custom_event_names (
  id INTEGER PRIMARY KEY,
  site_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen_at INTEGER NOT NULL,
  site_pk INTEGER NOT NULL REFERENCES site_identities(site_pk)
);

CREATE TABLE visits (
  visit_id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  ended_at INTEGER,
  finalized_at INTEGER,
  duration_ms INTEGER,
  duration_source TEXT,
  exit_reason TEXT,
  pathname TEXT NOT NULL,
  query_string TEXT NOT NULL DEFAULT '',
  hash_fragment TEXT NOT NULL DEFAULT '',
  hostname TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  referrer_url TEXT NOT NULL DEFAULT '',
  referrer_host TEXT NOT NULL DEFAULT '',
  utm_source TEXT NOT NULL DEFAULT '',
  utm_medium TEXT NOT NULL DEFAULT '',
  utm_campaign TEXT NOT NULL DEFAULT '',
  utm_term TEXT NOT NULL DEFAULT '',
  utm_content TEXT NOT NULL DEFAULT '',
  is_eu INTEGER NOT NULL DEFAULT 0,
  country TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT '',
  region_code TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  continent TEXT NOT NULL DEFAULT '',
  latitude REAL,
  longitude REAL,
  postal_code TEXT NOT NULL DEFAULT '',
  metro_code TEXT NOT NULL DEFAULT '',
  timezone TEXT NOT NULL DEFAULT '',
  as_organization TEXT NOT NULL DEFAULT '',
  ua_raw TEXT NOT NULL DEFAULT '',
  browser TEXT NOT NULL DEFAULT '',
  browser_version TEXT NOT NULL DEFAULT '',
  os TEXT NOT NULL DEFAULT '',
  os_version TEXT NOT NULL DEFAULT '',
  device_type TEXT NOT NULL DEFAULT '',
  screen_width INTEGER,
  screen_height INTEGER,
  language TEXT NOT NULL DEFAULT '',
  ae_synced_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  perf_ttfb_ms REAL,
  perf_fcp_ms REAL,
  perf_lcp_ms REAL,
  perf_cls REAL,
  perf_inp_ms REAL,
  user_id TEXT,
  user_name TEXT,
  site_pk INTEGER NOT NULL REFERENCES site_identities(site_pk)
);

CREATE TABLE custom_events (
  event_pk INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  site_id TEXT NOT NULL,
  visit_id TEXT NOT NULL,
  event_name_id INTEGER NOT NULL,
  occurred_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  sequence INTEGER NOT NULL DEFAULT 0,
  node_count INTEGER NOT NULL,
  value_count INTEGER NOT NULL,
  ae_synced_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  user_id TEXT,
  site_pk INTEGER NOT NULL REFERENCES site_identities(site_pk),
  FOREIGN KEY(visit_id) REFERENCES visits(visit_id) ON DELETE CASCADE,
  FOREIGN KEY(event_name_id) REFERENCES custom_event_names(id)
);

CREATE TABLE custom_event_json_nodes (
  event_pk INTEGER NOT NULL,
  node_id INTEGER NOT NULL,
  parent_node_id INTEGER,
  key_id INTEGER,
  path_id INTEGER NOT NULL,
  value_type INTEGER NOT NULL,
  member_order INTEGER,
  array_index INTEGER,
  depth INTEGER NOT NULL,
  PRIMARY KEY(event_pk, node_id),
  FOREIGN KEY(event_pk) REFERENCES custom_events(event_pk) ON DELETE CASCADE,
  FOREIGN KEY(key_id) REFERENCES custom_event_json_keys(id),
  FOREIGN KEY(path_id) REFERENCES custom_event_json_paths(id)
);

CREATE TABLE custom_event_json_values (
  event_pk INTEGER NOT NULL,
  node_id INTEGER NOT NULL,
  site_id TEXT NOT NULL,
  event_name_id INTEGER NOT NULL,
  path_id INTEGER NOT NULL,
  occurred_at INTEGER NOT NULL,
  scope_node_id INTEGER,
  value_type INTEGER NOT NULL,
  string_value TEXT,
  string_hash TEXT,
  number_value REAL,
  boolean_value INTEGER,
  site_pk INTEGER NOT NULL REFERENCES site_identities(site_pk),
  PRIMARY KEY(event_pk, node_id),
  FOREIGN KEY(event_pk, node_id) REFERENCES custom_event_json_nodes(event_pk, node_id) ON DELETE CASCADE,
  FOREIGN KEY(event_name_id) REFERENCES custom_event_names(id),
  FOREIGN KEY(path_id) REFERENCES custom_event_json_paths(id)
);

CREATE TABLE visit_hourly_aggregation_state (
  site_id TEXT NOT NULL,
  aggregated_until_hour INTEGER NOT NULL DEFAULT 0,
  lag_hours INTEGER NOT NULL DEFAULT 12,
  last_run_at INTEGER,
  last_success_at INTEGER,
  last_error TEXT,
  site_pk INTEGER PRIMARY KEY NOT NULL REFERENCES site_identities(site_pk)
);

CREATE TABLE visit_hourly_rollups (
  site_id TEXT NOT NULL,
  hour_bucket INTEGER NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  sessions INTEGER NOT NULL DEFAULT 0,
  visitors INTEGER NOT NULL DEFAULT 0,
  bounces INTEGER NOT NULL DEFAULT 0,
  duration_ms_sum INTEGER NOT NULL DEFAULT 0,
  duration_ms_count INTEGER NOT NULL DEFAULT 0,
  visitor_set_json TEXT NOT NULL DEFAULT '[]',
  session_counts_json TEXT NOT NULL DEFAULT '[]',
  perf_ttfb_sum REAL NOT NULL DEFAULT 0,
  perf_ttfb_count INTEGER NOT NULL DEFAULT 0,
  perf_fcp_sum REAL NOT NULL DEFAULT 0,
  perf_fcp_count INTEGER NOT NULL DEFAULT 0,
  perf_lcp_sum REAL NOT NULL DEFAULT 0,
  perf_lcp_count INTEGER NOT NULL DEFAULT 0,
  perf_cls_sum REAL NOT NULL DEFAULT 0,
  perf_cls_count INTEGER NOT NULL DEFAULT 0,
  perf_inp_sum REAL NOT NULL DEFAULT 0,
  perf_inp_count INTEGER NOT NULL DEFAULT 0,
  input_cutoff_ms INTEGER NOT NULL,
  aggregated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  schema_version INTEGER NOT NULL DEFAULT 1,
  site_pk INTEGER NOT NULL REFERENCES site_identities(site_pk),
  PRIMARY KEY (site_pk, hour_bucket)
);

INSERT INTO archive_objects (
  archive_key, site_id, start_hour, end_hour, granularity, format,
  row_count, size_bytes, created_at, updated_at, site_pk
)
SELECT
  archive_key, site_id, start_hour, end_hour, granularity, format,
  row_count, size_bytes, created_at, updated_at, site_pk
FROM archive_objects_old;

INSERT INTO custom_event_json_keys (
  id, site_id, key, created_at, last_seen_at, site_pk
)
SELECT id, site_id, key, created_at, last_seen_at, site_pk
FROM custom_event_json_keys_old;

INSERT INTO custom_event_json_paths (
  id, site_id, path, created_at, last_seen_at, site_pk
)
SELECT id, site_id, path, created_at, last_seen_at, site_pk
FROM custom_event_json_paths_old;

INSERT INTO custom_event_names (
  id, site_id, name, created_at, last_seen_at, site_pk
)
SELECT id, site_id, name, created_at, last_seen_at, site_pk
FROM custom_event_names_old;

INSERT INTO visits (
  visit_id, site_id, visitor_id, session_id, status, started_at,
  last_activity_at, ended_at, finalized_at, duration_ms, duration_source,
  exit_reason, pathname, query_string, hash_fragment, hostname, title,
  referrer_url, referrer_host, utm_source, utm_medium, utm_campaign,
  utm_term, utm_content, is_eu, country, region, region_code, city,
  continent, latitude, longitude, postal_code, metro_code, timezone,
  as_organization, ua_raw, browser, browser_version, os, os_version,
  device_type, screen_width, screen_height, language, ae_synced_at,
  created_at, updated_at, perf_ttfb_ms, perf_fcp_ms, perf_lcp_ms,
  perf_cls, perf_inp_ms, user_id, user_name, site_pk
)
SELECT
  visit_id, site_id, visitor_id, session_id, status, started_at,
  last_activity_at, ended_at, finalized_at, duration_ms, duration_source,
  exit_reason, pathname, query_string, hash_fragment, hostname, title,
  referrer_url, referrer_host, utm_source, utm_medium, utm_campaign,
  utm_term, utm_content, is_eu, country, region, region_code, city,
  continent, latitude, longitude, postal_code, metro_code, timezone,
  as_organization, ua_raw, browser, browser_version, os, os_version,
  device_type, screen_width, screen_height, language, ae_synced_at,
  created_at, updated_at, perf_ttfb_ms, perf_fcp_ms, perf_lcp_ms,
  perf_cls, perf_inp_ms, user_id, user_name, site_pk
FROM visits_old;

INSERT INTO custom_events (
  event_pk, event_id, site_id, visit_id, event_name_id, occurred_at,
  received_at, sequence, node_count, value_count, ae_synced_at, created_at,
  user_id, site_pk
)
SELECT
  event_pk, event_id, site_id, visit_id, event_name_id, occurred_at,
  received_at, sequence, node_count, value_count, ae_synced_at, created_at,
  user_id, site_pk
FROM custom_events_old;

INSERT INTO custom_event_json_nodes (
  event_pk, node_id, parent_node_id, key_id, path_id, value_type,
  member_order, array_index, depth
)
SELECT
  event_pk, node_id, parent_node_id, key_id, path_id, value_type,
  member_order, array_index, depth
FROM custom_event_json_nodes_old;

INSERT INTO custom_event_json_values (
  event_pk, node_id, site_id, event_name_id, path_id, occurred_at,
  scope_node_id, value_type, string_value, string_hash, number_value,
  boolean_value, site_pk
)
SELECT
  event_pk, node_id, site_id, event_name_id, path_id, occurred_at,
  scope_node_id, value_type, string_value, string_hash, number_value,
  boolean_value, site_pk
FROM custom_event_json_values_old;

INSERT INTO visit_hourly_aggregation_state (
  site_id, aggregated_until_hour, lag_hours, last_run_at, last_success_at,
  last_error, site_pk
)
SELECT
  site_id, aggregated_until_hour, lag_hours, last_run_at, last_success_at,
  last_error, site_pk
FROM visit_hourly_aggregation_state_old;

INSERT INTO visit_hourly_rollups (
  site_id, hour_bucket, views, sessions, visitors, bounces,
  duration_ms_sum, duration_ms_count, visitor_set_json, session_counts_json,
  perf_ttfb_sum, perf_ttfb_count, perf_fcp_sum, perf_fcp_count,
  perf_lcp_sum, perf_lcp_count, perf_cls_sum, perf_cls_count,
  perf_inp_sum, perf_inp_count, input_cutoff_ms, aggregated_at,
  schema_version, site_pk
)
SELECT
  site_id, hour_bucket, views, sessions, visitors, bounces,
  duration_ms_sum, duration_ms_count, visitor_set_json, session_counts_json,
  perf_ttfb_sum, perf_ttfb_count, perf_fcp_sum, perf_fcp_count,
  perf_lcp_sum, perf_lcp_count, perf_cls_sum, perf_cls_count,
  perf_inp_sum, perf_inp_count, input_cutoff_ms, aggregated_at,
  schema_version, site_pk
FROM visit_hourly_rollups_old;

DROP TABLE custom_event_json_values_old;
DROP TABLE custom_event_json_nodes_old;
DROP TABLE custom_events_old;
DROP TABLE custom_event_names_old;
DROP TABLE custom_event_json_paths_old;
DROP TABLE custom_event_json_keys_old;
DROP TABLE visit_hourly_rollups_old;
DROP TABLE visit_hourly_aggregation_state_old;
DROP TABLE visits_old;
DROP TABLE archive_objects_old;

CREATE UNIQUE INDEX idx_custom_event_json_keys_site_pk_key
  ON custom_event_json_keys(site_pk, "key");
CREATE UNIQUE INDEX idx_custom_event_json_paths_site_pk_path
  ON custom_event_json_paths(site_pk, path);
CREATE UNIQUE INDEX idx_custom_event_names_site_pk_name
  ON custom_event_names(site_pk, name);

CREATE INDEX idx_custom_event_nodes_event_parent
  ON custom_event_json_nodes(event_pk, parent_node_id, member_order, array_index);
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

CREATE INDEX idx_custom_events_created_at_site_pk_performance
  ON custom_events(created_at, site_pk, occurred_at, event_pk);
CREATE INDEX idx_custom_events_site_pk_name_time
  ON custom_events(site_pk, event_name_id, occurred_at, event_pk);
CREATE INDEX idx_custom_events_site_pk_time
  ON custom_events(site_pk, occurred_at, event_pk);
CREATE INDEX idx_custom_events_site_pk_visit_time
  ON custom_events(site_pk, visit_id, occurred_at, event_pk);

CREATE INDEX idx_archive_objects_site_pk_hour
  ON archive_objects(site_pk, start_hour, end_hour);

CREATE INDEX idx_visits_created_at_site_pk_performance
  ON visits(created_at, site_pk, started_at, visit_id);
CREATE INDEX idx_visits_open_last_activity
  ON visits(last_activity_at)
  WHERE status = 'open';
CREATE INDEX idx_visits_open_site_pk_started_at
  ON visits(site_pk, started_at)
  WHERE status = 'open';
CREATE INDEX idx_visits_site_pk_last_activity
  ON visits(site_pk, last_activity_at);
CREATE INDEX idx_visits_site_pk_session_started_at
  ON visits(site_pk, session_id, started_at);
CREATE INDEX idx_visits_site_pk_started_at
  ON visits(site_pk, started_at);
CREATE INDEX idx_visits_site_pk_visitor_last_activity
  ON visits(site_pk, visitor_id, last_activity_at);
CREATE INDEX idx_visits_site_pk_visitor_started_at
  ON visits(site_pk, visitor_id, started_at);

PRAGMA optimize;
