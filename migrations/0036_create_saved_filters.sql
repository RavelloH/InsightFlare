CREATE TABLE IF NOT EXISTS saved_filters (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,

  visibility TEXT NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'team')),
  name TEXT NOT NULL
    CHECK (length(trim(name)) BETWEEN 1 AND 120),
  description TEXT NOT NULL DEFAULT ''
    CHECK (length(description) <= 2000),

  -- This is the exact user-authored expression. Never normalize it in storage.
  filter_dsl TEXT NOT NULL
    CHECK (length(filter_dsl) <= 65536),
  filter_dsl_version INTEGER NOT NULL DEFAULT 1
    CHECK (filter_dsl_version >= 1),

  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),

  FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_saved_filters_site_owner_updated
  ON saved_filters(site_id, owner_user_id, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_saved_filters_site_visibility_updated
  ON saved_filters(site_id, visibility, updated_at DESC, id DESC);
