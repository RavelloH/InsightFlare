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

  it("contracts site identity keys and removes the compatibility layer", () => {
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
      "INSERT INTO sites (id, team_id, name, domain) VALUES ('site-contract', 'team-1', 'Contract', 'contract.example.com')",
    ).run();
    insertVisit(db, "visit-contract", "site-contract");
    db.prepare(
      `
        INSERT INTO archive_objects (
          archive_key, site_id, start_hour, end_hour, granularity, format
        ) VALUES ('cold/site-contract/1.parquet', 'site-contract', 1, 1, 'hour', 'parquet')
      `,
    ).run();

    db.exec(
      readFileSync(join(MIGRATIONS_DIR, "0039_site_identity_keys.sql"), "utf8"),
    );
    db.exec(
      readFileSync(
        join(MIGRATIONS_DIR, "0040_switch_site_identity_indexes.sql"),
        "utf8",
      ),
    );

    const sitePk = (
      db
        .prepare(
          "SELECT site_pk AS sitePk FROM site_identities WHERE site_id = ?",
        )
        .get("site-contract") as { sitePk: number }
    ).sitePk;
    db.prepare(
      "INSERT INTO custom_event_names (site_id, name, created_at, last_seen_at, site_pk) VALUES (?, ?, 1, 1, ?)",
    ).run("site-contract", "page_view", sitePk);
    db.prepare(
      "INSERT INTO custom_event_json_keys (site_id, key, created_at, last_seen_at, site_pk) VALUES (?, ?, 1, 1, ?)",
    ).run("site-contract", "plan", sitePk);
    db.prepare(
      "INSERT INTO custom_event_json_paths (site_id, path, created_at, last_seen_at, site_pk) VALUES (?, ?, 1, 1, ?)",
    ).run("site-contract", "$.plan", sitePk);
    db.prepare(
      `
        INSERT INTO custom_events (
          event_id, site_id, visit_id, event_name_id, occurred_at, received_at,
          node_count, value_count, site_pk
        ) VALUES (?, ?, ?, (SELECT id FROM custom_event_names WHERE site_pk = ?), 1, 1, 1, 1, ?)
      `,
    ).run("event-contract", "site-contract", "visit-contract", sitePk, sitePk);
    const eventPk = Number(
      (
        db.prepare("SELECT event_pk AS eventPk FROM custom_events").get() as {
          eventPk: number;
        }
      ).eventPk,
    );
    const pathId = Number(
      (
        db
          .prepare("SELECT id FROM custom_event_json_paths WHERE site_pk = ?")
          .get(sitePk) as { id: number }
      ).id,
    );
    db.prepare(
      `
        INSERT INTO custom_event_json_nodes (
          event_pk, node_id, path_id, value_type, depth
        ) VALUES (?, 1, ?, 1, 0)
      `,
    ).run(eventPk, pathId);
    db.prepare(
      `
        INSERT INTO custom_event_json_values (
          event_pk, node_id, site_id, event_name_id, path_id, occurred_at,
          value_type, string_value, string_hash, site_pk
        ) VALUES (?, 1, ?, (SELECT id FROM custom_event_names WHERE site_pk = ?), ?, 1, 1, 'pro', 'hash', ?)
      `,
    ).run(eventPk, "site-contract", sitePk, pathId, sitePk);
    db.prepare(
      `
        INSERT INTO visit_hourly_aggregation_state (
          site_id, aggregated_until_hour, site_pk
        ) VALUES (?, 1, ?)
      `,
    ).run("site-contract", sitePk);
    db.prepare(
      `
        INSERT INTO visit_hourly_rollups (
          site_id, hour_bucket, input_cutoff_ms, site_pk
        ) VALUES (?, 1, 1, ?)
      `,
    ).run("site-contract", sitePk);

    db.exec(
      readFileSync(
        join(MIGRATIONS_DIR, "0041_contract_site_identity_keys.sql"),
        "utf8",
      ),
    );

    const contractedTables = [
      "archive_objects",
      "custom_event_json_keys",
      "custom_event_json_paths",
      "custom_event_json_values",
      "custom_event_names",
      "custom_events",
      "visit_hourly_aggregation_state",
      "visit_hourly_rollups",
      "visits",
    ];
    for (const table of contractedTables) {
      const sitePkColumn = (
        db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
          name: string;
          notnull: number;
        }>
      ).find((column) => column.name === "site_pk");
      expect(sitePkColumn?.notnull, `${table}.site_pk`).toBe(1);
    }

    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'trigger' AND name LIKE '%site_pk%'",
        )
        .get(),
    ).toEqual({ count: 0 });
    expect(
      db
        .prepare(
          `
            SELECT COUNT(*) AS count
            FROM sqlite_schema
            WHERE type = 'index'
              AND tbl_name IN (${contractedTables.map(() => "?").join(", ")})
              AND sql LIKE '%site_id%'
          `,
        )
        .get(...contractedTables),
    ).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM visits").get()).toEqual({
      count: 1,
    });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM custom_events").get(),
    ).toEqual({ count: 1 });
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM custom_event_json_values")
        .get(),
    ).toEqual({ count: 1 });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM visit_hourly_rollups").get(),
    ).toEqual({ count: 1 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(() =>
      db
        ?.prepare(
          `
            INSERT INTO visits (
              visit_id, site_id, visitor_id, session_id, status, started_at,
              last_activity_at, pathname, hostname
            ) VALUES ('visit-missing-pk', 'site-contract', 'visitor', 'session', 'complete', 1, 1, '/', 'example.com')
          `,
        )
        .run(),
    ).toThrow(/NOT NULL/);
  });
});
