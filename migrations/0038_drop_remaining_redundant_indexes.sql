-- Remove exact duplicate, left-prefix, and unused indexes whose access paths
-- are already covered by UNIQUE constraints, composite indexes, or the table PK.
DROP INDEX IF EXISTS idx_account_action_tokens_hash;
DROP INDEX IF EXISTS idx_api_keys_hash;
DROP INDEX IF EXISTS idx_api_keys_team;
DROP INDEX IF EXISTS idx_widgets_site_id;
DROP INDEX IF EXISTS idx_visit_hourly_rollups_hour;
