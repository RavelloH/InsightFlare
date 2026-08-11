CREATE INDEX IF NOT EXISTS idx_visits_open_last_activity
  ON visits(last_activity_at)
  WHERE status = 'open';
