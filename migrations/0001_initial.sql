PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  password_hash TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  owner_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (owner_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  joined_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (team_id, user_id),
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);

CREATE TABLE IF NOT EXISTS sites (
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

CREATE INDEX IF NOT EXISTS idx_sites_team ON sites(team_id);
CREATE INDEX IF NOT EXISTS idx_sites_domain ON sites(domain);

CREATE TABLE IF NOT EXISTS configs (
  config_key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_configs_updated_at ON configs(updated_at);

CREATE TABLE IF NOT EXISTS pageviews (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  hour_bucket INTEGER NOT NULL,
  pathname TEXT NOT NULL,
  query_string TEXT,
  hash_fragment TEXT,
  title TEXT,
  hostname TEXT,
  referer TEXT,
  referer_host TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_term TEXT,
  utm_content TEXT,
  visitor_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  is_eu INTEGER NOT NULL DEFAULT 0,
  country TEXT,
  region TEXT,
  region_code TEXT,
  city TEXT,
  continent TEXT,
  latitude REAL,
  longitude REAL,
  postal_code TEXT,
  metro_code TEXT,
  timezone TEXT,
  colo TEXT,
  as_organization TEXT,
  bot_score REAL,
  bot_verified INTEGER NOT NULL DEFAULT 0,
  bot_security_json TEXT,
  ua_raw TEXT,
  browser TEXT,
  browser_version TEXT,
  os TEXT,
  os_version TEXT,
  device_type TEXT,
  screen_width INTEGER,
  screen_height INTEGER,
  language TEXT,
  ip TEXT,
  extra_json TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_pageviews_site_event_at ON pageviews(site_id, event_at);
CREATE INDEX IF NOT EXISTS idx_pageviews_site_session_event_at ON pageviews(site_id, session_id, event_at);
CREATE INDEX IF NOT EXISTS idx_pageviews_site_visitor_event_at ON pageviews(site_id, visitor_id, event_at);
CREATE INDEX IF NOT EXISTS idx_pageviews_site_path_event_at ON pageviews(site_id, pathname, event_at);
CREATE INDEX IF NOT EXISTS idx_pageviews_event_at ON pageviews(event_at);
CREATE INDEX IF NOT EXISTS idx_pageviews_hour_bucket ON pageviews(hour_bucket);

CREATE TABLE IF NOT EXISTS pageviews_archive_hourly (
  site_id TEXT NOT NULL,
  hour_bucket INTEGER NOT NULL,
  total_views INTEGER NOT NULL DEFAULT 0,
  total_sessions INTEGER NOT NULL DEFAULT 0,
  bounces INTEGER NOT NULL DEFAULT 0,
  total_duration INTEGER NOT NULL DEFAULT 0,
  visitors_json TEXT NOT NULL DEFAULT '[]',
  path_stats_json TEXT NOT NULL DEFAULT '{}',
  referer_stats_json TEXT NOT NULL DEFAULT '{}',
  country_stats_json TEXT NOT NULL DEFAULT '{}',
  region_stats_json TEXT NOT NULL DEFAULT '{}',
  city_stats_json TEXT NOT NULL DEFAULT '{}',
  device_stats_json TEXT NOT NULL DEFAULT '{}',
  browser_stats_json TEXT NOT NULL DEFAULT '{}',
  os_stats_json TEXT NOT NULL DEFAULT '{}',
  screen_stats_json TEXT NOT NULL DEFAULT '{}',
  language_stats_json TEXT NOT NULL DEFAULT '{}',
  timezone_stats_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (site_id, hour_bucket)
);

CREATE INDEX IF NOT EXISTS idx_archive_hour_bucket ON pageviews_archive_hourly(hour_bucket);
CREATE INDEX IF NOT EXISTS idx_archive_site_hour ON pageviews_archive_hourly(site_id, hour_bucket);

