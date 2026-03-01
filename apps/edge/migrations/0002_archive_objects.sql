PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS archive_objects (
  archive_key TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  start_hour INTEGER NOT NULL,
  end_hour INTEGER NOT NULL,
  granularity TEXT NOT NULL,
  format TEXT NOT NULL,
  row_count INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_archive_objects_site_hour
  ON archive_objects(site_id, start_hour, end_hour);

CREATE INDEX IF NOT EXISTS idx_archive_objects_created_at
  ON archive_objects(created_at);

