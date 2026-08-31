-- D1 schema (generated). Do not edit by hand; run `npm run generate:schema`

-- Regenerates the current table structure by replaying migrations/.

CREATE TABLE account_action_tokens (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('team_invite', 'password_reset')),
  token_hash TEXT NOT NULL UNIQUE,
  team_id TEXT,
  user_id TEXT,
  email TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_by_user_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  used_by_user_id TEXT,
  revoked_at INTEGER,
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (used_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_account_action_tokens_email
  ON account_action_tokens(email, type, created_at DESC);
CREATE INDEX idx_account_action_tokens_expires
  ON account_action_tokens(expires_at);
CREATE INDEX idx_account_action_tokens_team
  ON account_action_tokens(team_id, type, created_at DESC);
CREATE INDEX idx_account_action_tokens_user
  ON account_action_tokens(user_id, type, created_at DESC);

CREATE TABLE analysis_definitions (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  config_json TEXT NOT NULL DEFAULT '{}',
  config_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  archived_at INTEGER
);

CREATE INDEX idx_analysis_definitions_site_archived
  ON analysis_definitions(site_id, archived_at);
CREATE INDEX idx_analysis_definitions_site_kind
  ON analysis_definitions(site_id, kind);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL UNIQUE,
  key_hash TEXT NOT NULL UNIQUE,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  site_ids_json TEXT NOT NULL DEFAULT '[]',
  created_by_user_id TEXT,
  expires_at INTEGER,
  revoked_at INTEGER,
  revoked_by_user_id TEXT,
  rotated_from_key_id TEXT,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (revoked_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (rotated_from_key_id) REFERENCES api_keys(id) ON DELETE SET NULL
);

CREATE INDEX idx_api_keys_active
  ON api_keys(team_id, revoked_at, expires_at);

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

CREATE INDEX idx_archive_objects_site_pk_hour
  ON archive_objects(site_pk, start_hour, end_hour);

CREATE TABLE configs (
  config_key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE custom_event_json_keys (
  id INTEGER PRIMARY KEY,
  site_id TEXT NOT NULL,
  key TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen_at INTEGER NOT NULL,
  site_pk INTEGER NOT NULL REFERENCES site_identities(site_pk)
);

CREATE UNIQUE INDEX idx_custom_event_json_keys_site_pk_key
  ON custom_event_json_keys(site_pk, "key");

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

CREATE INDEX idx_custom_event_nodes_event_parent
  ON custom_event_json_nodes(event_pk, parent_node_id, member_order, array_index);

CREATE TABLE custom_event_json_paths (
  id INTEGER PRIMARY KEY,
  site_id TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen_at INTEGER NOT NULL,
  site_pk INTEGER NOT NULL REFERENCES site_identities(site_pk)
);

CREATE UNIQUE INDEX idx_custom_event_json_paths_site_pk_path
  ON custom_event_json_paths(site_pk, path);

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

CREATE TABLE custom_event_names (
  id INTEGER PRIMARY KEY,
  site_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen_at INTEGER NOT NULL,
  site_pk INTEGER NOT NULL REFERENCES site_identities(site_pk)
);

CREATE UNIQUE INDEX idx_custom_event_names_site_pk_name
  ON custom_event_names(site_pk, name);

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

CREATE INDEX idx_custom_events_created_at_site_pk_performance
  ON custom_events(created_at, site_pk, occurred_at, event_pk);
CREATE INDEX idx_custom_events_site_pk_name_time
  ON custom_events(site_pk, event_name_id, occurred_at, event_pk);
CREATE INDEX idx_custom_events_site_pk_time
  ON custom_events(site_pk, occurred_at, event_pk);
CREATE INDEX idx_custom_events_site_pk_visit_time
  ON custom_events(site_pk, visit_id, occurred_at, event_pk);

CREATE TABLE notification_messages (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  site_id TEXT,
  user_id TEXT NOT NULL,
  rule_id TEXT,
  run_id TEXT,
  batch_id TEXT,
  type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  requires_attention INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  summary TEXT,
  body_text TEXT,
  body_html TEXT,
  data_json TEXT NOT NULL DEFAULT '{}',
  channels_json TEXT NOT NULL DEFAULT '{}',
  delivery_status TEXT NOT NULL DEFAULT 'created',
  delivery_results_json TEXT NOT NULL DEFAULT '{}',
  error_message TEXT,
  read_at INTEGER,
  dismissed_at INTEGER,
  archived_at INTEGER,
  triggered_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  sent_at INTEGER,
  failed_at INTEGER,
  expires_at INTEGER,
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
  FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (rule_id) REFERENCES notification_rules(id) ON DELETE SET NULL
);

CREATE INDEX idx_notification_messages_batch
  ON notification_messages(batch_id);
CREATE INDEX idx_notification_messages_expires_at
  ON notification_messages(expires_at);
CREATE INDEX idx_notification_messages_rule_created
  ON notification_messages(rule_id, created_at DESC);
CREATE INDEX idx_notification_messages_run
  ON notification_messages(run_id);
CREATE INDEX idx_notification_messages_site_created
  ON notification_messages(site_id, created_at DESC);
CREATE INDEX idx_notification_messages_team_created
  ON notification_messages(team_id, created_at DESC);
CREATE INDEX idx_notification_messages_user_attention
  ON notification_messages(user_id, requires_attention, read_at, created_at DESC);
CREATE INDEX idx_notification_messages_user_created
  ON notification_messages(user_id, created_at DESC);

CREATE TABLE notification_rules (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  site_id TEXT,
  name TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  schedule_json TEXT NOT NULL DEFAULT '{}',
  condition_json TEXT NOT NULL DEFAULT '{}',
  recipient_json TEXT NOT NULL DEFAULT '{}',
  last_checked_at INTEGER,
  last_triggered_at INTEGER,
  next_run_at INTEGER,
  cooldown_until INTEGER,
  created_by_user_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  state_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
  FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_notification_rules_next_run
  ON notification_rules(enabled, next_run_at);
CREATE INDEX idx_notification_rules_site
  ON notification_rules(site_id, enabled, updated_at DESC);
CREATE INDEX idx_notification_rules_team
  ON notification_rules(team_id, enabled, updated_at DESC);
CREATE INDEX idx_notification_rules_type
  ON notification_rules(type, enabled);

CREATE TABLE saved_filters (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'team')),
  name TEXT NOT NULL
    CHECK (length(trim(name)) BETWEEN 1 AND 120),
  description TEXT NOT NULL DEFAULT ''
    CHECK (length(description) <= 2000),
  -- This is the exact user-authored expression. Never normalize it in storage.
  filter_dsl TEXT NOT NULL
    CHECK (length(filter_dsl) <= 65536),
  filter_dsl_version INTEGER NOT NULL DEFAULT 1
    CHECK (filter_dsl_version >= 1),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE RESTRICT
);

CREATE INDEX idx_saved_filters_site_owner_updated
  ON saved_filters(site_id, owner_user_id, updated_at DESC, id DESC);
CREATE INDEX idx_saved_filters_site_visibility_updated
  ON saved_filters(site_id, visibility, updated_at DESC, id DESC);

CREATE TABLE scheduled_task_run_logs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_key TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  level TEXT NOT NULL,
  event TEXT NOT NULL,
  message TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at_ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL
);

CREATE INDEX idx_scheduled_task_run_logs_expires_at
  ON scheduled_task_run_logs(expires_at);
CREATE INDEX idx_scheduled_task_run_logs_run_sequence
  ON scheduled_task_run_logs(run_id, sequence);

CREATE TABLE scheduled_task_runs (
  id TEXT PRIMARY KEY,
  invocation_id TEXT NOT NULL,
  task_key TEXT NOT NULL,
  task_name TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  status TEXT NOT NULL,
  scheduled_at_ms INTEGER,
  started_at_ms INTEGER NOT NULL,
  finished_at_ms INTEGER,
  duration_ms INTEGER,
  scope_type TEXT NOT NULL DEFAULT 'system',
  scope_id TEXT,
  summary_json TEXT NOT NULL DEFAULT '{}',
  error_name TEXT,
  error_message TEXT,
  error_stack TEXT,
  worker_version TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL
);

CREATE INDEX idx_scheduled_task_runs_expires_at
  ON scheduled_task_runs(expires_at);
CREATE INDEX idx_scheduled_task_runs_status_started
  ON scheduled_task_runs(status, started_at_ms);
CREATE INDEX idx_scheduled_task_runs_task_started
  ON scheduled_task_runs(task_key, started_at_ms);

CREATE TABLE scheduled_task_schedule_state (
  task_key TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_run_at INTEGER NOT NULL,
  last_run_at INTEGER,
  claim_token TEXT,
  claim_expires_at INTEGER,
  last_error TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_scheduled_task_schedule_due
  ON scheduled_task_schedule_state(enabled, next_run_at);

CREATE TABLE site_identities (
  site_pk INTEGER PRIMARY KEY,
  site_id TEXT NOT NULL UNIQUE
);

CREATE TABLE sites (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  name TEXT NOT NULL,
  domain TEXT NOT NULL,
  public_enabled INTEGER NOT NULL DEFAULT 0,
  public_slug TEXT UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
);

CREATE INDEX idx_sites_domain ON sites(domain);
CREATE INDEX idx_sites_team ON sites(team_id);

CREATE TABLE team_members (
  team_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  joined_at INTEGER NOT NULL DEFAULT (unixepoch()),
  site_ids_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (team_id, user_id),
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_team_members_user ON team_members(user_id);
CREATE UNIQUE INDEX idx_team_single_owner ON team_members(team_id)
WHERE role = 'owner';

CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  owner_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (owner_user_id) REFERENCES users(id)
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  password_hash TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  username TEXT,
  system_role TEXT NOT NULL DEFAULT 'user',
  timezone TEXT NOT NULL DEFAULT '',
  notification_preferences_json TEXT NOT NULL DEFAULT '{}',
  preferred_locale TEXT NOT NULL DEFAULT ''
);

CREATE INDEX idx_users_system_role ON users(system_role);
CREATE UNIQUE INDEX idx_users_username ON users(username);

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

CREATE TABLE widgets (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_widgets_site_type ON widgets(site_id, type);
