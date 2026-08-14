-- Migration number: 0034 	 2026-08-14T11:35:48.314Z
-- The Foundation runtime was removed from all Workers. These objects were
-- created exclusively for it and are not business data.
DROP TRIGGER IF EXISTS performance_rollout_control_audit_update;
DROP TABLE IF EXISTS performance_maintenance_jobs;
DROP TABLE IF EXISTS performance_rollout_control_audit;
DROP TABLE IF EXISTS performance_rollout_controls;
