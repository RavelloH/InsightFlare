DROP INDEX IF EXISTS idx_visits_site_status_started_at;
DROP INDEX IF EXISTS idx_visits_site_path_started_at;
DROP INDEX IF EXISTS idx_visits_site_referrer_started_at;
DROP INDEX IF EXISTS idx_visits_site_browser_started_at;
DROP INDEX IF EXISTS idx_visits_site_device_started_at;
DROP INDEX IF EXISTS idx_visits_site_country_started_at;
DROP INDEX IF EXISTS idx_visits_site_finalized_at;
DROP INDEX IF EXISTS idx_visits_ae_synced_at;

DROP INDEX IF EXISTS idx_visits_archive_site_path_started_at;
DROP INDEX IF EXISTS idx_visits_archive_site_referrer_started_at;
DROP INDEX IF EXISTS idx_visits_archive_site_browser_started_at;
DROP INDEX IF EXISTS idx_visits_archive_site_device_started_at;
DROP INDEX IF EXISTS idx_visits_archive_site_country_started_at;

DROP INDEX IF EXISTS idx_custom_events_site_name_occurred_at;
DROP INDEX IF EXISTS idx_custom_events_site_session_occurred_at;
DROP INDEX IF EXISTS idx_custom_events_site_visit_occurred_at;
DROP INDEX IF EXISTS idx_custom_events_ae_synced_at;

DROP INDEX IF EXISTS idx_custom_events_archive_site_name_occurred_at;
DROP INDEX IF EXISTS idx_custom_events_archive_site_session_occurred_at;
