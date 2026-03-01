PRAGMA foreign_keys = ON;

-- Keep owner semantics aligned with teams.owner_user_id:
-- one and only one owner member row per team.
UPDATE team_members
SET role = 'member'
WHERE role = 'owner'
  AND user_id <> (
    SELECT t.owner_user_id
    FROM teams t
    WHERE t.id = team_members.team_id
  );

UPDATE team_members
SET role = 'owner'
WHERE (team_id, user_id) IN (
  SELECT t.id, t.owner_user_id
  FROM teams t
);

INSERT OR IGNORE INTO team_members (team_id, user_id, role, joined_at)
SELECT t.id, t.owner_user_id, 'owner', unixepoch()
FROM teams t;

UPDATE team_members
SET role = 'member'
WHERE role <> 'owner'
  AND role <> 'member';
