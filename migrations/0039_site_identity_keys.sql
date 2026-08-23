-- Expansion phase for compact internal site references.  Keep the external
-- site_id columns and their existing indexes until a later contraction phase.
CREATE TABLE IF NOT EXISTS site_identities (
  site_pk INTEGER PRIMARY KEY,
  site_id TEXT NOT NULL UNIQUE
);

-- Populate the dictionary from every current site_id-bearing table, including
-- historical rows whose site row has since been deleted.  The JSON access
-- lists are included because they are also persisted site-id sources.
INSERT OR IGNORE INTO site_identities (site_id)
SELECT DISTINCT id FROM sites WHERE id IS NOT NULL;
INSERT OR IGNORE INTO site_identities (site_id)
SELECT DISTINCT site_id FROM analysis_definitions WHERE site_id IS NOT NULL;
INSERT OR IGNORE INTO site_identities (site_id)
SELECT DISTINCT site_id FROM archive_objects WHERE site_id IS NOT NULL;
INSERT OR IGNORE INTO site_identities (site_id)
SELECT DISTINCT site_id FROM custom_event_json_keys WHERE site_id IS NOT NULL;
INSERT OR IGNORE INTO site_identities (site_id)
SELECT DISTINCT site_id FROM custom_event_json_paths WHERE site_id IS NOT NULL;
INSERT OR IGNORE INTO site_identities (site_id)
SELECT DISTINCT site_id FROM custom_event_json_values WHERE site_id IS NOT NULL;
INSERT OR IGNORE INTO site_identities (site_id)
SELECT DISTINCT site_id FROM custom_event_names WHERE site_id IS NOT NULL;
INSERT OR IGNORE INTO site_identities (site_id)
SELECT DISTINCT site_id FROM custom_events WHERE site_id IS NOT NULL;
INSERT OR IGNORE INTO site_identities (site_id)
SELECT DISTINCT site_id FROM notification_messages WHERE site_id IS NOT NULL;
INSERT OR IGNORE INTO site_identities (site_id)
SELECT DISTINCT site_id FROM notification_rules WHERE site_id IS NOT NULL;
INSERT OR IGNORE INTO site_identities (site_id)
SELECT DISTINCT site_id FROM saved_filters WHERE site_id IS NOT NULL;
INSERT OR IGNORE INTO site_identities (site_id)
SELECT DISTINCT site_id FROM visit_hourly_aggregation_state
WHERE site_id IS NOT NULL;
INSERT OR IGNORE INTO site_identities (site_id)
SELECT DISTINCT site_id FROM visit_hourly_rollups WHERE site_id IS NOT NULL;
INSERT OR IGNORE INTO site_identities (site_id)
SELECT DISTINCT site_id FROM visits WHERE site_id IS NOT NULL;
INSERT OR IGNORE INTO site_identities (site_id)
SELECT DISTINCT site_id FROM widgets WHERE site_id IS NOT NULL;
INSERT OR IGNORE INTO site_identities (site_id)
SELECT DISTINCT json_each.value
FROM api_keys
JOIN json_each(
  CASE WHEN json_valid(api_keys.site_ids_json)
    THEN api_keys.site_ids_json ELSE '[]' END
)
WHERE json_each.type = 'text' AND json_each.value IS NOT NULL;
INSERT OR IGNORE INTO site_identities (site_id)
SELECT DISTINCT json_each.value
FROM team_members
JOIN json_each(
  CASE WHEN json_valid(team_members.site_ids_json)
    THEN team_members.site_ids_json ELSE '[]' END
)
WHERE json_each.type = 'text' AND json_each.value IS NOT NULL;

ALTER TABLE archive_objects
  ADD COLUMN site_pk INTEGER REFERENCES site_identities(site_pk);
ALTER TABLE custom_event_json_keys
  ADD COLUMN site_pk INTEGER REFERENCES site_identities(site_pk);
ALTER TABLE custom_event_json_paths
  ADD COLUMN site_pk INTEGER REFERENCES site_identities(site_pk);
ALTER TABLE custom_event_json_values
  ADD COLUMN site_pk INTEGER REFERENCES site_identities(site_pk);
ALTER TABLE custom_event_names
  ADD COLUMN site_pk INTEGER REFERENCES site_identities(site_pk);
ALTER TABLE custom_events
  ADD COLUMN site_pk INTEGER REFERENCES site_identities(site_pk);
ALTER TABLE visit_hourly_aggregation_state
  ADD COLUMN site_pk INTEGER REFERENCES site_identities(site_pk);
ALTER TABLE visit_hourly_rollups
  ADD COLUMN site_pk INTEGER REFERENCES site_identities(site_pk);
ALTER TABLE visits
  ADD COLUMN site_pk INTEGER REFERENCES site_identities(site_pk);

UPDATE archive_objects
SET site_pk = (SELECT site_pk FROM site_identities WHERE site_id = archive_objects.site_id)
WHERE site_id IS NOT NULL;
UPDATE custom_event_json_keys
SET site_pk = (SELECT site_pk FROM site_identities WHERE site_id = custom_event_json_keys.site_id)
WHERE site_id IS NOT NULL;
UPDATE custom_event_json_paths
SET site_pk = (SELECT site_pk FROM site_identities WHERE site_id = custom_event_json_paths.site_id)
WHERE site_id IS NOT NULL;
UPDATE custom_event_json_values
SET site_pk = (SELECT site_pk FROM site_identities WHERE site_id = custom_event_json_values.site_id)
WHERE site_id IS NOT NULL;
UPDATE custom_event_names
SET site_pk = (SELECT site_pk FROM site_identities WHERE site_id = custom_event_names.site_id)
WHERE site_id IS NOT NULL;
UPDATE custom_events
SET site_pk = (SELECT site_pk FROM site_identities WHERE site_id = custom_events.site_id)
WHERE site_id IS NOT NULL;
UPDATE visit_hourly_aggregation_state
SET site_pk = (SELECT site_pk FROM site_identities WHERE site_id = visit_hourly_aggregation_state.site_id)
WHERE site_id IS NOT NULL;
UPDATE visit_hourly_rollups
SET site_pk = (SELECT site_pk FROM site_identities WHERE site_id = visit_hourly_rollups.site_id)
WHERE site_id IS NOT NULL;
UPDATE visits
SET site_pk = (SELECT site_pk FROM site_identities WHERE site_id = visits.site_id)
WHERE site_id IS NOT NULL;

-- The triggers are a compatibility guard for writers deployed before the
-- integer key is known.  New ingest writes site_pk directly and avoids these
-- follow-up UPDATEs.
CREATE TRIGGER IF NOT EXISTS trg_archive_objects_site_pk_insert
AFTER INSERT ON archive_objects
WHEN NEW.site_id IS NOT NULL AND NEW.site_pk IS NULL
BEGIN
  INSERT OR IGNORE INTO site_identities (site_id) VALUES (NEW.site_id);
  UPDATE archive_objects
  SET site_pk = (SELECT site_pk FROM site_identities WHERE site_id = NEW.site_id)
  WHERE archive_key = NEW.archive_key AND site_pk IS NULL;
END;
CREATE TRIGGER IF NOT EXISTS trg_archive_objects_site_pk_update
AFTER UPDATE OF site_id ON archive_objects
WHEN NEW.site_id IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO site_identities (site_id) VALUES (NEW.site_id);
  UPDATE archive_objects
  SET site_pk = (SELECT site_pk FROM site_identities WHERE site_id = NEW.site_id)
  WHERE archive_key = NEW.archive_key;
END;

CREATE TRIGGER IF NOT EXISTS trg_custom_event_json_keys_site_pk_insert
AFTER INSERT ON custom_event_json_keys
WHEN NEW.site_id IS NOT NULL AND NEW.site_pk IS NULL
BEGIN
  INSERT OR IGNORE INTO site_identities (site_id) VALUES (NEW.site_id);
  UPDATE custom_event_json_keys
  SET site_pk = (SELECT site_pk FROM site_identities WHERE site_id = NEW.site_id)
  WHERE id = NEW.id AND site_pk IS NULL;
END;
CREATE TRIGGER IF NOT EXISTS trg_custom_event_json_keys_site_pk_update
AFTER UPDATE OF site_id ON custom_event_json_keys
WHEN NEW.site_id IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO site_identities (site_id) VALUES (NEW.site_id);
  UPDATE custom_event_json_keys
  SET site_pk = (SELECT site_pk FROM site_identities WHERE site_id = NEW.site_id)
  WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_custom_event_json_paths_site_pk_insert
AFTER INSERT ON custom_event_json_paths
WHEN NEW.site_id IS NOT NULL AND NEW.site_pk IS NULL
BEGIN
  INSERT OR IGNORE INTO site_identities (site_id) VALUES (NEW.site_id);
  UPDATE custom_event_json_paths
  SET site_pk = (SELECT site_pk FROM site_identities WHERE site_id = NEW.site_id)
  WHERE id = NEW.id AND site_pk IS NULL;
END;
CREATE TRIGGER IF NOT EXISTS trg_custom_event_json_paths_site_pk_update
AFTER UPDATE OF site_id ON custom_event_json_paths
WHEN NEW.site_id IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO site_identities (site_id) VALUES (NEW.site_id);
  UPDATE custom_event_json_paths
  SET site_pk = (SELECT site_pk FROM site_identities WHERE site_id = NEW.site_id)
  WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_custom_event_json_values_site_pk_insert
AFTER INSERT ON custom_event_json_values
WHEN NEW.site_id IS NOT NULL AND NEW.site_pk IS NULL
BEGIN
  INSERT OR IGNORE INTO site_identities (site_id) VALUES (NEW.site_id);
  UPDATE custom_event_json_values
  SET site_pk = (SELECT site_pk FROM site_identities WHERE site_id = NEW.site_id)
  WHERE event_pk = NEW.event_pk AND node_id = NEW.node_id AND site_pk IS NULL;
END;
CREATE TRIGGER IF NOT EXISTS trg_custom_event_json_values_site_pk_update
AFTER UPDATE OF site_id ON custom_event_json_values
WHEN NEW.site_id IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO site_identities (site_id) VALUES (NEW.site_id);
  UPDATE custom_event_json_values
  SET site_pk = (SELECT site_pk FROM site_identities WHERE site_id = NEW.site_id)
  WHERE event_pk = NEW.event_pk AND node_id = NEW.node_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_custom_event_names_site_pk_insert
AFTER INSERT ON custom_event_names
WHEN NEW.site_id IS NOT NULL AND NEW.site_pk IS NULL
BEGIN
  INSERT OR IGNORE INTO site_identities (site_id) VALUES (NEW.site_id);
  UPDATE custom_event_names
  SET site_pk = (SELECT site_pk FROM site_identities WHERE site_id = NEW.site_id)
  WHERE id = NEW.id AND site_pk IS NULL;
END;
CREATE TRIGGER IF NOT EXISTS trg_custom_event_names_site_pk_update
AFTER UPDATE OF site_id ON custom_event_names
WHEN NEW.site_id IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO site_identities (site_id) VALUES (NEW.site_id);
  UPDATE custom_event_names
  SET site_pk = (SELECT site_pk FROM site_identities WHERE site_id = NEW.site_id)
  WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_custom_events_site_pk_insert
AFTER INSERT ON custom_events
WHEN NEW.site_id IS NOT NULL AND NEW.site_pk IS NULL
BEGIN
  INSERT OR IGNORE INTO site_identities (site_id) VALUES (NEW.site_id);
  UPDATE custom_events
  SET site_pk = (SELECT site_pk FROM site_identities WHERE site_id = NEW.site_id)
  WHERE event_pk = NEW.event_pk AND site_pk IS NULL;
END;
CREATE TRIGGER IF NOT EXISTS trg_custom_events_site_pk_update
AFTER UPDATE OF site_id ON custom_events
WHEN NEW.site_id IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO site_identities (site_id) VALUES (NEW.site_id);
  UPDATE custom_events
  SET site_pk = (SELECT site_pk FROM site_identities WHERE site_id = NEW.site_id)
  WHERE event_pk = NEW.event_pk;
END;

CREATE TRIGGER IF NOT EXISTS trg_visit_hourly_aggregation_state_site_pk_insert
AFTER INSERT ON visit_hourly_aggregation_state
WHEN NEW.site_id IS NOT NULL AND NEW.site_pk IS NULL
BEGIN
  INSERT OR IGNORE INTO site_identities (site_id) VALUES (NEW.site_id);
  UPDATE visit_hourly_aggregation_state
  SET site_pk = (SELECT site_pk FROM site_identities WHERE site_id = NEW.site_id)
  WHERE site_id = NEW.site_id AND site_pk IS NULL;
END;
CREATE TRIGGER IF NOT EXISTS trg_visit_hourly_aggregation_state_site_pk_update
AFTER UPDATE OF site_id ON visit_hourly_aggregation_state
WHEN NEW.site_id IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO site_identities (site_id) VALUES (NEW.site_id);
  UPDATE visit_hourly_aggregation_state
  SET site_pk = (SELECT site_pk FROM site_identities WHERE site_id = NEW.site_id)
  WHERE site_id = NEW.site_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_visit_hourly_rollups_site_pk_insert
AFTER INSERT ON visit_hourly_rollups
WHEN NEW.site_id IS NOT NULL AND NEW.site_pk IS NULL
BEGIN
  INSERT OR IGNORE INTO site_identities (site_id) VALUES (NEW.site_id);
  UPDATE visit_hourly_rollups
  SET site_pk = (SELECT site_pk FROM site_identities WHERE site_id = NEW.site_id)
  WHERE site_id = NEW.site_id AND hour_bucket = NEW.hour_bucket AND site_pk IS NULL;
END;
CREATE TRIGGER IF NOT EXISTS trg_visit_hourly_rollups_site_pk_update
AFTER UPDATE OF site_id ON visit_hourly_rollups
WHEN NEW.site_id IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO site_identities (site_id) VALUES (NEW.site_id);
  UPDATE visit_hourly_rollups
  SET site_pk = (SELECT site_pk FROM site_identities WHERE site_id = NEW.site_id)
  WHERE site_id = NEW.site_id AND hour_bucket = NEW.hour_bucket;
END;

CREATE TRIGGER IF NOT EXISTS trg_visits_site_pk_insert
AFTER INSERT ON visits
WHEN NEW.site_id IS NOT NULL AND NEW.site_pk IS NULL
BEGIN
  INSERT OR IGNORE INTO site_identities (site_id) VALUES (NEW.site_id);
  UPDATE visits
  SET site_pk = (SELECT site_pk FROM site_identities WHERE site_id = NEW.site_id)
  WHERE visit_id = NEW.visit_id AND site_pk IS NULL;
END;
CREATE TRIGGER IF NOT EXISTS trg_visits_site_pk_update
AFTER UPDATE OF site_id ON visits
WHEN NEW.site_id IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO site_identities (site_id) VALUES (NEW.site_id);
  UPDATE visits
  SET site_pk = (SELECT site_pk FROM site_identities WHERE site_id = NEW.site_id)
  WHERE visit_id = NEW.visit_id;
END;
