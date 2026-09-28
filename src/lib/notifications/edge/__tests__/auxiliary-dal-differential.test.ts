import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { explainQueryPlan } from "@/lib/db/__tests__/query-plan";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import {
  loadSiteInfo,
  loadSiteLastSeenAt,
} from "@/lib/notifications/edge/report-data";

const databases = new Set<DatabaseSync>();

function createFixture() {
  const database = createMigratedDatabase();
  database
    .prepare("INSERT INTO users (id, email) VALUES (?, ?)")
    .run("owner-1", "owner@example.test");
  database
    .prepare(
      "INSERT INTO teams (id, name, slug, owner_user_id) VALUES (?, ?, ?, ?)",
    )
    .run("team-1", "Team One", "team-one", "owner-1");
  const insertSite = database.prepare(
    "INSERT INTO sites (id, team_id, name, domain) VALUES (?, ?, ?, ?)",
  );
  insertSite.run("site-1", "team-1", "Site One", "one.example.test");
  insertSite.run("site-2", "team-1", "Site Two", "two.example.test");
  const insertIdentity = database.prepare(
    "INSERT INTO site_identities (site_id) VALUES (?)",
  );
  insertIdentity.run("site-1");
  insertIdentity.run("site-2");

  const insertVisit = database.prepare(`
    INSERT INTO visits (
      visit_id, site_id, visitor_id, session_id, status,
      started_at, last_activity_at, pathname, hostname, site_pk
    ) VALUES (
      ?, ?, ?, ?, 'active', ?, ?, '/', ?,
      (SELECT site_pk FROM site_identities WHERE site_id = ? LIMIT 1)
    )
  `);
  insertVisit.run(
    "visit-1",
    "site-1",
    "visitor-1",
    "session-1",
    1_800_000_000_000,
    1_800_000_100_000,
    "one.example.test",
    "site-1",
  );
  insertVisit.run(
    "visit-2",
    "site-1",
    "visitor-2",
    "session-2",
    1_800_000_001_000,
    1_800_000_123_000,
    "one.example.test",
    "site-1",
  );
  insertVisit.run(
    "visit-3",
    "site-2",
    "visitor-3",
    "session-3",
    1_900_000_000_000,
    2_000_000_000_000,
    "two.example.test",
    "site-2",
  );

  databases.add(database);
  const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
  const env = { DB: createSqliteD1Database(database, trace) } as never;
  return { database, env, trace };
}

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("notification auxiliary reads Typed DAL differential checks", () => {
  it("matches legacy site metadata reads and missing-row behavior", async () => {
    const { database, env, trace } = createFixture();
    const legacy = database
      .prepare("SELECT name, domain FROM sites WHERE id = ? LIMIT 1")
      .get("site-1");

    await expect(loadSiteInfo(env, "site-1")).resolves.toEqual(legacy);
    await expect(loadSiteInfo(env, "missing-site")).resolves.toBeNull();
    expect(trace.preparedSql).toHaveLength(2);
    expect(trace.bindings).toEqual([
      ["site-1", 1],
      ["missing-site", 1],
    ]);
  });

  it("matches legacy site identity MAX reads, empty results, and the visits index", async () => {
    const { database, env, trace } = createFixture();
    const legacySql = `
      SELECT MAX(last_activity_at) AS lastSeenAt
      FROM visits
      WHERE site_pk = (
        SELECT site_pk FROM site_identities WHERE site_id = ? LIMIT 1
      )
    `;
    const legacyRow = database.prepare(legacySql).get("site-1") as {
      lastSeenAt: number | null;
    };
    const expected =
      legacyRow.lastSeenAt === null
        ? null
        : Math.floor(legacyRow.lastSeenAt / 1000);

    await expect(loadSiteLastSeenAt(env, "site-1")).resolves.toBe(expected);
    await expect(loadSiteLastSeenAt(env, "missing-site")).resolves.toBeNull();
    expect(trace.preparedSql).toHaveLength(2);
    expect(trace.bindings).toEqual([["site-1"], ["missing-site"]]);

    const typedPlan = explainQueryPlan(database, {
      sql: trace.preparedSql[0]!,
      bindings: trace.bindings[0]!,
    });
    const legacyPlan = explainQueryPlan(database, {
      sql: legacySql,
      bindings: ["site-1"],
    });
    expect(typedPlan.join(" ")).toContain("idx_visits_site_pk_last_activity");
    expect(legacyPlan.join(" ")).toContain("idx_visits_site_pk_last_activity");
  });
});
