import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import {
  teamById,
  teamMembershipAccess,
  toSlug,
  uniqueTeamSlug,
} from "@/lib/edge/admin/access";
import type { Env } from "@/lib/edge/types";

const databases = new Set<DatabaseSync>();

function createFixture() {
  const database = createMigratedDatabase();
  database.function("unixepoch", () => 1_800_000_000);
  databases.add(database);

  const insertUser = database.prepare(
    "INSERT INTO users (id, email, name, username) VALUES (?, ?, ?, ?)",
  );
  insertUser.run("owner-1", "owner@example.test", "Owner", "owner");
  insertUser.run("member-1", "member@example.test", "Member", "member");
  insertUser.run("owner-2", "owner2@example.test", "Other Owner", "owner2");

  const insertTeam = database.prepare(
    "INSERT INTO teams (id, name, slug, owner_user_id) VALUES (?, ?, ?, ?)",
  );
  insertTeam.run("team-1", "Team One", "team-one", "owner-1");
  insertTeam.run("team-2", "Team Two", "team-two", "owner-2");

  database
    .prepare(
      "INSERT INTO team_members (team_id, user_id, role, site_ids_json) VALUES (?, ?, ?, ?)",
    )
    .run("team-1", "member-1", "member", '["site-1"]');
  database
    .prepare(
      "INSERT INTO sites (id, team_id, name, domain) VALUES (?, ?, ?, ?)",
    )
    .run("site-1", "team-1", "Site One", "one.example.test");

  const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
  const env = {
    MAIN_SECRET: "identity-dal-test-secret",
    DB: createSqliteD1Database(database, trace),
  } as Env;
  return { database, env, trace };
}

function legacyUniqueTeamSlug(
  database: DatabaseSync,
  raw: string,
  excludeTeamId?: string,
): string {
  const base = toSlug(raw) || "team-test-fallback";
  let slug = base;
  let suffix = 2;
  while (true) {
    const existing = excludeTeamId
      ? database
          .prepare("SELECT 1 AS ok FROM teams WHERE slug=? AND id<>? LIMIT 1")
          .get(slug, excludeTeamId)
      : database
          .prepare("SELECT 1 AS ok FROM teams WHERE slug=? LIMIT 1")
          .get(slug);
    if (!existing) return slug;
    slug = `${base}-${suffix}`;
    suffix += 1;
  }
}

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("admin access Typed DAL differential checks", () => {
  it("matches team membership projection and missing-row behavior", async () => {
    const { database, env, trace } = createFixture();
    const legacyRow = database
      .prepare(
        "SELECT role,site_ids_json AS siteIdsJson FROM team_members WHERE team_id=? AND user_id=? LIMIT 1",
      )
      .get("team-1", "member-1") as {
      role: string;
      siteIdsJson: string;
    };

    await expect(
      teamMembershipAccess(env, "team-1", "member-1"),
    ).resolves.toEqual({ role: legacyRow.role, siteIds: ["site-1"] });
    expect(trace.preparedSql).toHaveLength(1);
    expect(trace.bindings[0]).toEqual(["team-1", "member-1", 1]);
    await expect(
      teamMembershipAccess(env, "team-2", "member-1"),
    ).resolves.toBeNull();
    expect(trace.preparedSql).toHaveLength(2);
  });

  it("matches team lookup row shape and indexed absence behavior", async () => {
    const { database, env, trace } = createFixture();
    const legacyRow = database
      .prepare(
        "SELECT id,owner_user_id AS ownerUserId FROM teams WHERE id=? LIMIT 1",
      )
      .get("team-1");

    await expect(teamById(env, "team-1")).resolves.toEqual(legacyRow);
    await expect(teamById(env, "missing-team")).resolves.toBeNull();
    expect(trace.preparedSql).toHaveLength(2);
  });

  it("matches slug selection for no collision, collision, and current-team exclusion", async () => {
    const noCollision = createFixture();
    const expectedAvailable = legacyUniqueTeamSlug(
      noCollision.database,
      "Available Team",
    );
    await expect(
      uniqueTeamSlug(noCollision.env, "Available Team"),
    ).resolves.toBe(expectedAvailable);
    expect(noCollision.trace.preparedSql).toHaveLength(1);

    const collision = createFixture();
    collision.database
      .prepare(
        "INSERT INTO teams (id, name, slug, owner_user_id) VALUES (?, ?, ?, ?)",
      )
      .run("team-collision", "New Team", "new-team", "owner-2");
    const expectedCollision = legacyUniqueTeamSlug(
      collision.database,
      "New Team",
    );
    await expect(uniqueTeamSlug(collision.env, "New Team")).resolves.toBe(
      expectedCollision,
    );
    expect(collision.trace.preparedSql).toHaveLength(2);

    const exclusion = createFixture();
    const expectedExcluded = legacyUniqueTeamSlug(
      exclusion.database,
      "Team One",
      "team-1",
    );
    await expect(
      uniqueTeamSlug(exclusion.env, "Team One", "team-1"),
    ).resolves.toBe(expectedExcluded);
    expect(exclusion.trace.preparedSql).toHaveLength(1);
  });
});
