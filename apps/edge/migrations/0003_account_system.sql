PRAGMA foreign_keys = ON;

ALTER TABLE users ADD COLUMN username TEXT;
ALTER TABLE users ADD COLUMN system_role TEXT NOT NULL DEFAULT 'user';

UPDATE users
SET username = lower(
  CASE
    WHEN coalesce(nullif(username, ''), '') <> '' THEN username
    ELSE email
  END
)
WHERE username IS NULL OR username = '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_system_role ON users(system_role);

CREATE UNIQUE INDEX IF NOT EXISTS idx_team_single_owner ON team_members(team_id)
WHERE role = 'owner';
