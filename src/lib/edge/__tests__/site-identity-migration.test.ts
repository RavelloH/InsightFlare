import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

const MIGRATIONS_DIR = resolve(process.cwd(), "migrations");

function migrationSqlThrough(name: string): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql") && file <= name)
    .sort()
    .map((file) => readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
}

function insertVisit(db: DatabaseSync, visitId: string, siteId: string): void {
  db.prepare(
    `
      INSERT INTO visits (
        visit_id, site_id, visitor_id, session_id, status, started_at,
        last_activity_at, pathname, hostname
      ) VALUES (?, ?, ?, ?, 'complete', 1, 1, '/', 'example.com')
    `,
  ).run(visitId, siteId, `visitor-${visitId}`, `session-${visitId}`);
}

describe("site identity migration", () => {
  let db: DatabaseSync | null = null;

  afterEach(() => {
    db?.close();
    db = null;
  });

  it("backfills active and orphaned historical site IDs", () => {
    db = new DatabaseSync(":memory:");
    for (const sql of migrationSqlThrough(
      "0038_drop_remaining_redundant_indexes.sql",
    )) {
      db.exec(sql);
    }

    db.prepare(
      "INSERT INTO users (id, email) VALUES ('user-1', 'owner@example.com')",
    ).run();
    db.prepare(
      "INSERT INTO teams (id, name, slug, owner_user_id) VALUES ('team-1', 'Team', 'team', 'user-1')",
    ).run();
    db.prepare(
      "INSERT INTO sites (id, team_id, name, domain) VALUES ('site-live', 'team-1', 'Live', 'example.com')",
    ).run();
    insertVisit(db, "visit-live", "site-live");
    insertVisit(db, "visit-orphan", "site-deleted");
    db.prepare(
      `
        INSERT INTO archive_objects (
          archive_key, site_id, start_hour, end_hour, granularity, format
        ) VALUES ('cold/site-deleted/1.parquet', 'site-deleted', 1, 1, 'hour', 'parquet')
      `,
    ).run();

    db.exec(
      readFileSync(join(MIGRATIONS_DIR, "0039_site_identity_keys.sql"), "utf8"),
    );

    const identities = db
      .prepare("SELECT site_id AS siteId FROM site_identities ORDER BY site_id")
      .all() as Array<{ siteId: string }>;
    expect(identities.map((row) => row.siteId)).toEqual([
      "site-deleted",
      "site-live",
    ]);

    const visits = db
      .prepare(
        `
          SELECT v.visit_id AS visitId, si.site_id AS siteId
          FROM visits v
          INNER JOIN site_identities si ON si.site_pk = v.site_pk
          ORDER BY v.visit_id
        `,
      )
      .all();
    expect(visits).toEqual([
      { visitId: "visit-live", siteId: "site-live" },
      { visitId: "visit-orphan", siteId: "site-deleted" },
    ]);
    expect(
      db
        .prepare(
          `
            SELECT si.site_id AS siteId
            FROM archive_objects ao
            INNER JOIN site_identities si ON si.site_pk = ao.site_pk
          `,
        )
        .get(),
    ).toEqual({ siteId: "site-deleted" });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("uses compatibility triggers for a writer that omits site_pk", () => {
    db = new DatabaseSync(":memory:");
    for (const sql of migrationSqlThrough(
      "0040_switch_site_identity_indexes.sql",
    )) {
      db.exec(sql);
    }

    insertVisit(db, "visit-late", "site-late");

    expect(
      db
        .prepare(
          `
            SELECT si.site_id AS siteId
            FROM visits v
            INNER JOIN site_identities si ON si.site_pk = v.site_pk
            WHERE v.visit_id = 'visit-late'
          `,
        )
        .get(),
    ).toEqual({ siteId: "site-late" });

    db.prepare(
      "UPDATE visits SET site_id = 'site-moved' WHERE visit_id = 'visit-late'",
    ).run();
    expect(
      db
        .prepare(
          `
            SELECT si.site_id AS siteId
            FROM visits v
            INNER JOIN site_identities si ON si.site_pk = v.site_pk
            WHERE v.visit_id = 'visit-late'
          `,
        )
        .get(),
    ).toEqual({ siteId: "site-moved" });

    const indexNames = (
      db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'index' AND name LIKE '%site_pk%'",
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(indexNames).toHaveLength(19);
    expect(indexNames).toEqual(
      expect.arrayContaining([
        "idx_visits_site_pk_started_at",
        "idx_custom_events_site_pk_time",
        "idx_visit_hourly_rollups_site_pk_hour",
        "idx_archive_objects_site_pk_hour",
      ]),
    );

    const plan = db
      .prepare(
        `
          EXPLAIN QUERY PLAN
          SELECT visit_id
          FROM visits
          WHERE site_pk = (
            SELECT site_pk FROM site_identities WHERE site_id = ?
          )
            AND started_at >= ? AND started_at < ?
        `,
      )
      .all("site-moved", 0, 2) as Array<{ detail: string }>;
    expect(
      plan.some((row) => row.detail.includes("idx_visits_site_pk_started_at")),
    ).toBe(true);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
