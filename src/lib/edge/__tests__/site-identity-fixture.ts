import type { DatabaseSync } from "node:sqlite";

/**
 * Upgrade a focused legacy visits fixture to the post-0039 identity shape.
 * These tests intentionally build only the tables they exercise instead of
 * replaying every application migration.
 */
export function installVisitSiteIdentityFixture(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE site_identities (
      site_pk INTEGER PRIMARY KEY,
      site_id TEXT NOT NULL UNIQUE
    );
    ALTER TABLE visits ADD COLUMN site_pk INTEGER;

    INSERT OR IGNORE INTO site_identities (site_id)
      SELECT DISTINCT site_id FROM visits WHERE site_id IS NOT NULL;
    UPDATE visits
    SET site_pk = (
      SELECT site_pk FROM site_identities WHERE site_id = visits.site_id
    );

    CREATE TRIGGER test_visits_site_pk_insert
    AFTER INSERT ON visits
    WHEN NEW.site_pk IS NULL
    BEGIN
      INSERT OR IGNORE INTO site_identities (site_id) VALUES (NEW.site_id);
      UPDATE visits
      SET site_pk = (
        SELECT site_pk FROM site_identities WHERE site_id = NEW.site_id
      )
      WHERE visit_id = NEW.visit_id;
    END;

    CREATE INDEX idx_visits_site_pk_started_at
      ON visits(site_pk, started_at);
  `);
}
