-- Remove indexes that have no dedicated query path in the repository.
DROP INDEX IF EXISTS idx_visits_site_user_id;
DROP INDEX IF EXISTS idx_configs_updated_at;
DROP INDEX IF EXISTS idx_archive_objects_created_at;
DROP INDEX IF EXISTS idx_custom_events_site_user_id;
DROP INDEX IF EXISTS idx_custom_events_ae_synced_at;
DROP INDEX IF EXISTS idx_analysis_definitions_site_id;
