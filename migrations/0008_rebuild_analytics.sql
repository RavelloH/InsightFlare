PRAGMA foreign_keys = OFF;

DROP TABLE IF EXISTS pageviews_archive_hourly;
DROP TABLE IF EXISTS pageviews;
DROP TABLE IF EXISTS visits_archive;
DROP TABLE IF EXISTS visits;
DROP TABLE IF EXISTS custom_events_archive;
DROP TABLE IF EXISTS custom_events;

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS visits (
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
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_visits_site_started_at
  ON visits(site_id, started_at);
CREATE INDEX IF NOT EXISTS idx_visits_site_status_started_at
  ON visits(site_id, status, started_at);
CREATE INDEX IF NOT EXISTS idx_visits_site_session_started_at
  ON visits(site_id, session_id, started_at);
CREATE INDEX IF NOT EXISTS idx_visits_site_visitor_started_at
  ON visits(site_id, visitor_id, started_at);
CREATE INDEX IF NOT EXISTS idx_visits_site_path_started_at
  ON visits(site_id, pathname, started_at);
CREATE INDEX IF NOT EXISTS idx_visits_site_referrer_started_at
  ON visits(site_id, referrer_host, started_at);
CREATE INDEX IF NOT EXISTS idx_visits_site_browser_started_at
  ON visits(site_id, browser, started_at);
CREATE INDEX IF NOT EXISTS idx_visits_site_device_started_at
  ON visits(site_id, device_type, started_at);
CREATE INDEX IF NOT EXISTS idx_visits_site_country_started_at
  ON visits(site_id, country, started_at);
CREATE INDEX IF NOT EXISTS idx_visits_site_finalized_at
  ON visits(site_id, finalized_at);
CREATE INDEX IF NOT EXISTS idx_visits_ae_synced_at
  ON visits(ae_synced_at);

CREATE TABLE IF NOT EXISTS visits_archive (
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
  archived_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_visits_archive_site_started_at
  ON visits_archive(site_id, started_at);
CREATE INDEX IF NOT EXISTS idx_visits_archive_site_session_started_at
  ON visits_archive(site_id, session_id, started_at);
CREATE INDEX IF NOT EXISTS idx_visits_archive_site_visitor_started_at
  ON visits_archive(site_id, visitor_id, started_at);
CREATE INDEX IF NOT EXISTS idx_visits_archive_site_path_started_at
  ON visits_archive(site_id, pathname, started_at);
CREATE INDEX IF NOT EXISTS idx_visits_archive_site_referrer_started_at
  ON visits_archive(site_id, referrer_host, started_at);
CREATE INDEX IF NOT EXISTS idx_visits_archive_site_browser_started_at
  ON visits_archive(site_id, browser, started_at);
CREATE INDEX IF NOT EXISTS idx_visits_archive_site_device_started_at
  ON visits_archive(site_id, device_type, started_at);
CREATE INDEX IF NOT EXISTS idx_visits_archive_site_country_started_at
  ON visits_archive(site_id, country, started_at);

CREATE TABLE IF NOT EXISTS custom_events (
  event_id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  visit_id TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  event_name TEXT NOT NULL,
  event_data_json TEXT NOT NULL DEFAULT '{}',
  pathname TEXT NOT NULL,
  query_string TEXT NOT NULL DEFAULT '',
  hash_fragment TEXT NOT NULL DEFAULT '',
  hostname TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  referrer_url TEXT NOT NULL DEFAULT '',
  referrer_host TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  browser TEXT NOT NULL DEFAULT '',
  os TEXT NOT NULL DEFAULT '',
  os_version TEXT NOT NULL DEFAULT '',
  device_type TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT '',
  timezone TEXT NOT NULL DEFAULT '',
  screen_width INTEGER,
  screen_height INTEGER,
  ae_synced_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_custom_events_site_occurred_at
  ON custom_events(site_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_custom_events_site_name_occurred_at
  ON custom_events(site_id, event_name, occurred_at);
CREATE INDEX IF NOT EXISTS idx_custom_events_site_session_occurred_at
  ON custom_events(site_id, session_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_custom_events_site_visit_occurred_at
  ON custom_events(site_id, visit_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_custom_events_ae_synced_at
  ON custom_events(ae_synced_at);

CREATE TABLE IF NOT EXISTS custom_events_archive (
  event_id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  visit_id TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  event_name TEXT NOT NULL,
  event_data_json TEXT NOT NULL DEFAULT '{}',
  pathname TEXT NOT NULL,
  query_string TEXT NOT NULL DEFAULT '',
  hash_fragment TEXT NOT NULL DEFAULT '',
  hostname TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  referrer_url TEXT NOT NULL DEFAULT '',
  referrer_host TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  browser TEXT NOT NULL DEFAULT '',
  os TEXT NOT NULL DEFAULT '',
  os_version TEXT NOT NULL DEFAULT '',
  device_type TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT '',
  timezone TEXT NOT NULL DEFAULT '',
  screen_width INTEGER,
  screen_height INTEGER,
  ae_synced_at INTEGER,
  archived_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_custom_events_archive_site_occurred_at
  ON custom_events_archive(site_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_custom_events_archive_site_name_occurred_at
  ON custom_events_archive(site_id, event_name, occurred_at);
CREATE INDEX IF NOT EXISTS idx_custom_events_archive_site_session_occurred_at
  ON custom_events_archive(site_id, session_id, occurred_at);
