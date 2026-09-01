ALTER TABLE saved_filters
  ADD COLUMN scope_preference TEXT NOT NULL DEFAULT 'auto'
    CHECK (scope_preference IN ('auto', 'event', 'session', 'visitor'));

UPDATE saved_filters
SET scope_preference = 'auto'
WHERE scope_preference IS NULL;
