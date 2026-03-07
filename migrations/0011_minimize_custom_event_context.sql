CREATE TABLE custom_events_next (
  event_id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  visit_id TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  event_name TEXT NOT NULL,
  event_data_json TEXT NOT NULL DEFAULT '{}',
  ae_synced_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO custom_events_next (
  event_id,
  site_id,
  visit_id,
  occurred_at,
  event_name,
  event_data_json,
  ae_synced_at,
  created_at
)
SELECT
  event_id,
  site_id,
  visit_id,
  occurred_at,
  event_name,
  COALESCE(event_data_json, '{}'),
  ae_synced_at,
  created_at
FROM custom_events;

DROP TABLE custom_events;

ALTER TABLE custom_events_next RENAME TO custom_events;

CREATE INDEX idx_custom_events_site_occurred_at
  ON custom_events(site_id, occurred_at);
CREATE INDEX idx_custom_events_site_name_occurred_at
  ON custom_events(site_id, event_name, occurred_at);
CREATE INDEX idx_custom_events_site_visit_occurred_at
  ON custom_events(site_id, visit_id, occurred_at);
CREATE INDEX idx_custom_events_ae_synced_at
  ON custom_events(ae_synced_at);

CREATE TABLE custom_events_archive_next (
  event_id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  visit_id TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  event_name TEXT NOT NULL,
  event_data_json TEXT NOT NULL DEFAULT '{}',
  ae_synced_at INTEGER,
  archived_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO custom_events_archive_next (
  event_id,
  site_id,
  visit_id,
  occurred_at,
  event_name,
  event_data_json,
  ae_synced_at,
  archived_at
)
SELECT
  event_id,
  site_id,
  visit_id,
  occurred_at,
  event_name,
  COALESCE(event_data_json, '{}'),
  ae_synced_at,
  archived_at
FROM custom_events_archive;

DROP TABLE custom_events_archive;

ALTER TABLE custom_events_archive_next RENAME TO custom_events_archive;

CREATE INDEX idx_custom_events_archive_site_occurred_at
  ON custom_events_archive(site_id, occurred_at);
CREATE INDEX idx_custom_events_archive_site_name_occurred_at
  ON custom_events_archive(site_id, event_name, occurred_at);
CREATE INDEX idx_custom_events_archive_site_visit_occurred_at
  ON custom_events_archive(site_id, visit_id, occurred_at);
