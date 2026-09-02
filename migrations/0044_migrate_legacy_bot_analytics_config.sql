INSERT INTO configs (
  config_key,
  value_json,
  created_at,
  updated_at
)
SELECT
  'system.analytics_engine_reader.v1',
  value_json,
  created_at,
  unixepoch()
FROM configs
WHERE config_key = 'system.bot_analytics_reader.v1'
  AND NOT EXISTS (
    SELECT 1
    FROM configs
    WHERE config_key = 'system.analytics_engine_reader.v1'
  );
