-- System performance is an all-site, short-window administrative query. Its
-- predicates start with created_at, unlike dashboard queries which start with
-- site_id and started_at/occurred_at.
CREATE INDEX IF NOT EXISTS idx_visits_created_at_system_performance
  ON visits(created_at, site_id, started_at);

CREATE INDEX IF NOT EXISTS idx_custom_events_created_at_system_performance
  ON custom_events(created_at, site_id, occurred_at);
