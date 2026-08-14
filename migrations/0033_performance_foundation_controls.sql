CREATE TABLE IF NOT EXISTS performance_rollout_controls (
  name TEXT PRIMARY KEY,
  route_scope TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('disabled','shadow','enabled')) DEFAULT 'disabled',
  generation TEXT NOT NULL DEFAULT 'foundation-0',
  cutover_started_at INTEGER,
  bridge_version TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_by TEXT NOT NULL DEFAULT 'migration',
  current_request_id TEXT NOT NULL DEFAULT 'migration'
);

CREATE TABLE IF NOT EXISTS performance_rollout_control_audit (
  id INTEGER PRIMARY KEY,
  control_name TEXT NOT NULL,
  prior_state TEXT,
  next_state TEXT NOT NULL,
  prior_revision INTEGER,
  next_revision INTEGER NOT NULL,
  actor_user_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_performance_rollout_audit_control_created
  ON performance_rollout_control_audit(control_name, created_at DESC);

CREATE TRIGGER IF NOT EXISTS performance_rollout_control_audit_update
AFTER UPDATE OF state, generation, revision ON performance_rollout_controls
WHEN NEW.revision = OLD.revision + 1
BEGIN
  INSERT INTO performance_rollout_control_audit (
    control_name, prior_state, next_state, prior_revision, next_revision,
    actor_user_id, request_id
  ) VALUES (
    NEW.name, OLD.state, NEW.state, OLD.revision, NEW.revision,
    NEW.updated_by, NEW.current_request_id
  );
END;

CREATE TABLE IF NOT EXISTS performance_maintenance_jobs (
  job_key TEXT PRIMARY KEY,
  owner TEXT,
  lease_token TEXT,
  lease_until INTEGER,
  cursor_json TEXT NOT NULL DEFAULT '{}',
  high_water_json TEXT NOT NULL DEFAULT '{}',
  phase TEXT NOT NULL DEFAULT 'idle',
  attempt INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT OR IGNORE INTO performance_rollout_controls (
  name, route_scope, state, generation, updated_by, current_request_id
) VALUES ('foundation', 'foundation', 'disabled', 'foundation-0', 'migration', 'migration');
