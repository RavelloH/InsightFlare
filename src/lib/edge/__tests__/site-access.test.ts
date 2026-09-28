import type { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import type { EdgeSessionClaims } from "@/lib/edge/auth/session-auth";
import {
  fetchPublicSite,
  resolvePrivateSiteForSession,
  resolvePrivateTeamForSession,
} from "@/lib/edge/auth/site-access";
import type { Env } from "@/lib/edge/types";

const adminSession: EdgeSessionClaims = {
  userId: "admin-user",
  username: "admin",
  displayName: "Admin",
  systemRole: "admin",
  exp: 9_999_999_999,
};

const ownerSession: EdgeSessionClaims = {
  userId: "owner-user",
  username: "owner",
  displayName: "Owner",
  systemRole: "user",
  exp: 9_999_999_999,
};

const teamAdminSession: EdgeSessionClaims = {
  userId: "team-admin",
  username: "team-admin",
  displayName: "Team Admin",
  systemRole: "user",
  exp: 9_999_999_999,
};

const memberSession: EdgeSessionClaims = {
  userId: "site-member",
  username: "member",
  displayName: "Member",
  systemRole: "user",
  exp: 9_999_999_999,
};

const limitedMemberSession: EdgeSessionClaims = {
  userId: "other-site-member",
  username: "limited",
  displayName: "Limited Member",
  systemRole: "user",
  exp: 9_999_999_999,
};

const unrelatedSession: EdgeSessionClaims = {
  userId: "unrelated-user",
  username: "unrelated",
  displayName: "Unrelated",
  systemRole: "user",
  exp: 9_999_999_999,
};

describe("typed site access DAL", () => {
  let database: DatabaseSync;
  let env: Env;
  let trace: SqliteD1Trace;

  beforeEach(() => {
    database = createMigratedDatabase();
    trace = { preparedSql: [], bindings: [] };
    env = { DB: createSqliteD1Database(database, trace) } as Env;

    const insertUser = database.prepare(
      "INSERT INTO users (id, email, name) VALUES (?, ?, ?)",
    );
    for (const [id, email, name] of [
      ["owner-user", "owner@example.test", "Owner"],
      ["team-admin", "admin@example.test", "Team Admin"],
      ["site-member", "member@example.test", "Member"],
      ["other-site-member", "limited@example.test", "Limited Member"],
    ]) {
      insertUser.run(id, email, name);
    }

    database
      .prepare(
        "INSERT INTO teams (id, name, slug, owner_user_id) VALUES (?, ?, ?, ?)",
      )
      .run("team-1", "Team One", "team-one", "owner-user");
    const insertMember = database.prepare(
      "INSERT INTO team_members (team_id, user_id, role, site_ids_json) VALUES (?, ?, ?, ?)",
    );
    insertMember.run("team-1", "team-admin", "admin", "[]");
    insertMember.run("team-1", "site-member", "member", '["site-1"]');
    insertMember.run("team-1", "other-site-member", "member", '["site-2"]');

    const insertSite = database.prepare(
      "INSERT INTO sites (id, team_id, name, domain, public_enabled, public_slug) VALUES (?, ?, ?, ?, ?, ?)",
    );
    insertSite.run("site-1", "team-1", "Private One", "one.example", 0, null);
    insertSite.run(
      "site-2",
      "team-1",
      "Public Two",
      "two.example",
      1,
      "public-two",
    );
  });

  afterEach(() => {
    database.close();
  });

  it("preserves admin, owner, team-admin, limited-member, and unrelated access", async () => {
    const request = new Request("https://app.test/api/private/site");
    const siteUrl = new URL("https://app.test/api/private/site?siteId=site-1");

    await expect(
      resolvePrivateSiteForSession(request, env, siteUrl, adminSession),
    ).resolves.toEqual({
      id: "site-1",
      name: "Private One",
      domain: "one.example",
      canManage: true,
    });
    await expect(
      resolvePrivateSiteForSession(request, env, siteUrl, ownerSession),
    ).resolves.toEqual({
      id: "site-1",
      name: "Private One",
      domain: "one.example",
      ownerUserId: "owner-user",
      role: null,
      siteIdsJson: null,
      canManage: true,
    });
    await expect(
      resolvePrivateSiteForSession(request, env, siteUrl, teamAdminSession),
    ).resolves.toMatchObject({ canManage: true, role: "admin" });
    await expect(
      resolvePrivateSiteForSession(request, env, siteUrl, memberSession),
    ).resolves.toMatchObject({
      id: "site-1",
      role: "member",
      siteIdsJson: '["site-1"]',
      canManage: false,
    });

    const unrelated = await resolvePrivateSiteForSession(
      request,
      env,
      siteUrl,
      unrelatedSession,
    );
    expect(unrelated).toBeInstanceOf(Response);
    expect((unrelated as Response).status).toBe(404);
    expect(trace.preparedSql).toHaveLength(5);
  });

  it("preserves private team authorization and allowed-site scope", async () => {
    const request = new Request("https://app.test/api/private/team");
    const url = new URL("https://app.test/api/private/team?teamId=team-1");

    await expect(
      resolvePrivateTeamForSession(request, env, url, adminSession),
    ).resolves.toEqual({ id: "team-1" });
    await expect(
      resolvePrivateTeamForSession(request, env, url, ownerSession),
    ).resolves.toEqual({ id: "team-1" });
    await expect(
      resolvePrivateTeamForSession(request, env, url, teamAdminSession),
    ).resolves.toEqual({ id: "team-1" });
    await expect(
      resolvePrivateTeamForSession(request, env, url, memberSession),
    ).resolves.toEqual({ id: "team-1", allowedSiteIds: ["site-1"] });

    const unrelated = await resolvePrivateTeamForSession(
      request,
      env,
      url,
      unrelatedSession,
    );
    expect(unrelated).toBeInstanceOf(Response);
    expect((unrelated as Response).status).toBe(404);
    expect(trace.preparedSql).toHaveLength(5);
  });

  it("returns not found for missing sites and teams", async () => {
    const request = new Request("https://app.test/api/private/resource");
    const missingSite = await resolvePrivateSiteForSession(
      request,
      env,
      new URL("https://app.test/api/private/resource?siteId=missing"),
      adminSession,
    );
    const missingTeam = await resolvePrivateTeamForSession(
      request,
      env,
      new URL("https://app.test/api/private/resource?teamId=missing"),
      adminSession,
    );

    expect(missingSite).toBeInstanceOf(Response);
    expect((missingSite as Response).status).toBe(404);
    expect(missingTeam).toBeInstanceOf(Response);
    expect((missingTeam as Response).status).toBe(404);
    expect(trace.preparedSql).toHaveLength(2);
  });

  it("exposes enabled public sites by slug and hides disabled or missing sites", async () => {
    await expect(
      fetchPublicSite(
        env,
        new URL("https://app.test/api/public-sites/share/public-two/overview"),
      ),
    ).resolves.toEqual({
      id: "site-2",
      name: "Public Two",
      domain: "two.example",
    });

    const disabled = await fetchPublicSite(
      env,
      new URL("https://app.test/api/public-sites/share/site-1/overview"),
    );
    const missing = await fetchPublicSite(
      env,
      new URL("https://app.test/api/public-sites/share/missing/overview"),
    );
    expect(disabled).toBeInstanceOf(Response);
    expect((disabled as Response).status).toBe(404);
    expect(missing).toBeInstanceOf(Response);
    expect((missing as Response).status).toBe(404);
    expect(trace.preparedSql).toHaveLength(3);
  });

  it("matches the legacy site and team join results", async () => {
    const request = new Request("https://app.test/api/private/site");
    const siteUrl = new URL("https://app.test/api/private/site?siteId=site-1");
    const legacySite = database
      .prepare(
        `SELECT
          s.id, s.name, s.domain,
          t.owner_user_id AS ownerUserId,
          tm.role,
          tm.site_ids_json AS siteIdsJson
        FROM sites s
        INNER JOIN teams t ON t.id = s.team_id
        LEFT JOIN team_members tm ON tm.team_id = s.team_id AND tm.user_id = ?
        WHERE s.id = ?
        LIMIT 1`,
      )
      .get("site-member", "site-1");
    const compiledSite = await resolvePrivateSiteForSession(
      request,
      env,
      siteUrl,
      memberSession,
    );
    expect(compiledSite).toEqual({ ...legacySite, canManage: false });

    const legacyTeam = database
      .prepare(
        `SELECT
          t.id,
          t.owner_user_id AS ownerUserId,
          tm.role,
          tm.site_ids_json AS siteIdsJson
        FROM teams t
        LEFT JOIN team_members tm ON tm.team_id = t.id AND tm.user_id = ?
        WHERE t.id = ?
        LIMIT 1`,
      )
      .get("site-member", "team-1") as {
      id: string;
      siteIdsJson: string;
    };
    const compiledTeam = await resolvePrivateTeamForSession(
      request,
      env,
      new URL("https://app.test/api/private/team?teamId=team-1"),
      memberSession,
    );
    expect(compiledTeam).toEqual({
      id: legacyTeam.id,
      allowedSiteIds: JSON.parse(legacyTeam.siteIdsJson),
    });
    expect(trace.preparedSql).toHaveLength(2);
  });
});
