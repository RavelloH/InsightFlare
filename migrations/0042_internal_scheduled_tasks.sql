-- The Worker keeps one external 30-minute Cron and dispatches these system
-- tasks internally.  next_run_at is stored in Unix seconds.
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

CREATE INDEX idx_notification_messages_expires_at
  ON notification_messages(expires_at);

INSERT INTO scheduled_task_schedule_state (task_key, next_run_at)
VALUES
  ('visit_hourly_rollup', 0),
  ('notification_tick', 0),
  ('database_maintenance', 0);
