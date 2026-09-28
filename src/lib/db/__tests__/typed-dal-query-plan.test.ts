import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  aggregate,
  and,
  callFunction,
  compileD1Query,
  count,
  eq,
  filter,
  join,
  limit,
  param,
  project,
  scalar,
  scan,
  schema,
  sort,
} from "@/lib/db";
import { explainQueryPlan } from "@/lib/db/__tests__/query-plan";

const databases = new Set<DatabaseSync>();

function createFixture(): DatabaseSync {
  const database = createMigratedDatabase();
  databases.add(database);

  const insertUser = database.prepare(
    "INSERT INTO users (id, email, username) VALUES (?, ?, ?)",
  );
  const insertTeam = database.prepare(
    "INSERT INTO teams (id, name, slug, owner_user_id) VALUES (?, ?, ?, ?)",
  );
  const insertMembership = database.prepare(
    "INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, ?)",
  );
  const insertSite = database.prepare(
    "INSERT INTO sites (id, team_id, name, domain) VALUES (?, ?, ?, ?)",
  );

  for (let index = 0; index < 240; index += 1) {
    const userId = `user-${index}`;
    const teamId = `team-${index}`;
    insertUser.run(userId, `${userId}@example.test`, `user-${index}`);
    insertTeam.run(teamId, `Team ${index}`, `team-${index}`, userId);
    insertMembership.run(teamId, userId, "owner");
    insertSite.run(`site-${index}`, teamId, `Site ${index}`, `${index}.test`);
  }
  for (let index = 0; index < 240; index += 1) {
    for (let offset = 1; offset <= 8; offset += 1) {
      const memberIndex = (index + offset) % 240;
      insertMembership.run(`team-${index}`, `user-${memberIndex}`, "member");
    }
  }
  database.exec("ANALYZE");
  return database;
}

function expectIndexSearch(plan: readonly string[], indexName: string): void {
  expect(
    plan.some(
      (detail) => detail.includes("SEARCH") && detail.includes(indexName),
    ),
    plan.join("\n"),
  ).toBe(true);
}

function expectEquivalentScan(
  legacy: readonly string[],
  typed: readonly string[],
): void {
  const hasLegacyScan = legacy.some((detail) => detail.includes("SCAN"));
  const hasTypedScan = typed.some((detail) => detail.includes("SCAN"));
  expect(hasTypedScan, JSON.stringify({ legacy, typed })).toBe(hasLegacyScan);
}

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("Typed DAL SQLite query-plan guards", () => {
  it("keeps token, API key, and public-site lookups on their existing indexes", () => {
    const database = createFixture();

    const apiKeys = scan(schema.api_keys);
    const apiKeyPrefixRows = filter(
      apiKeys,
      eq(apiKeys.columns.key_prefix, param("prefix-1")),
    );
    const apiKeyByPrefix = compileD1Query(
      limit(project(apiKeyPrefixRows, { id: apiKeyPrefixRows.columns.id }), 1),
    );
    expectIndexSearch(
      explainQueryPlan(database, apiKeyByPrefix),
      "sqlite_autoindex_api_keys_2",
    );

    const tokens = scan(schema.account_action_tokens);
    const tokenHashRows = filter(
      tokens,
      eq(tokens.columns.token_hash, param("token-hash")),
    );
    const tokenByHash = compileD1Query(
      limit(project(tokenHashRows, { id: tokenHashRows.columns.id }), 1),
    );
    expectIndexSearch(
      explainQueryPlan(database, tokenByHash),
      "sqlite_autoindex_account_action_tokens_2",
    );

    const sites = scan(schema.sites);
    const publicSlugRows = filter(
      sites,
      eq(sites.columns.public_slug, param("public-slug")),
    );
    const siteByPublicSlug = compileD1Query(
      limit(project(publicSlugRows, { id: publicSlugRows.columns.id }), 1),
    );
    expectIndexSearch(
      explainQueryPlan(database, siteByPublicSlug),
      "sqlite_autoindex_sites_2",
    );
  });

  it("keeps private-site authorization joins and membership lookups indexed", () => {
    const database = createFixture();

    const sites = scan(schema.sites);
    const teams = scan(schema.teams);
    const members = scan(schema.team_members);
    const siteTeams = join(
      sites,
      teams,
      eq(sites.columns.team_id, teams.columns.id),
    );
    const siteTeamMembers = join(
      siteTeams,
      members,
      eq(siteTeams.columns.right_id, members.columns.team_id),
    );
    const access = filter(
      siteTeamMembers,
      and(
        eq(siteTeamMembers.columns.left_left_id, param("site-1")),
        eq(siteTeamMembers.columns.right_user_id, param("user-1")),
      ),
    );
    const typedPrivateSiteJoin = compileD1Query(
      project(access, {
        siteId: access.columns.left_left_id,
        ownerUserId: access.columns.left_right_owner_user_id,
      }),
    );
    const privateSiteJoinPlan = explainQueryPlan(
      database,
      typedPrivateSiteJoin,
    );
    expectIndexSearch(privateSiteJoinPlan, "sqlite_autoindex_sites_1");
    expectIndexSearch(privateSiteJoinPlan, "sqlite_autoindex_teams_1");
    expectIndexSearch(privateSiteJoinPlan, "sqlite_autoindex_team_members_1");

    const membership = scan(schema.team_members);
    const memberByTeamAndUserRows = filter(
      membership,
      and(
        eq(membership.columns.team_id, param("team-1")),
        eq(membership.columns.user_id, param("user-1")),
      ),
    );
    const memberByTeamAndUser = compileD1Query(
      limit(
        project(memberByTeamAndUserRows, {
          role: memberByTeamAndUserRows.columns.role,
        }),
        1,
      ),
    );
    expectIndexSearch(
      explainQueryPlan(database, memberByTeamAndUser),
      "sqlite_autoindex_team_members_1",
    );
  });

  it("guards new identity lookups against legacy plan regressions", () => {
    const database = createFixture();

    const users = scan(schema.users);
    const userByIdRows = filter(users, eq(users.columns.id, param("user-1")));
    const userById = compileD1Query(
      limit(project(userByIdRows, { id: userByIdRows.columns.id }), 1),
    );
    expectIndexSearch(
      explainQueryPlan(database, userById),
      "sqlite_autoindex_users_1",
    );

    const lowerUsernameRows = filter(
      users,
      eq(callFunction("lower", users.columns.username), param("user-1")),
    );
    const lowerUsername = compileD1Query(
      limit(
        project(lowerUsernameRows, { id: lowerUsernameRows.columns.id }),
        1,
      ),
    );
    const legacyLowerUsername = database
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id FROM users WHERE lower(username)=? LIMIT 1",
      )
      .all("user-1") as Array<{ detail: string }>;
    const legacyLowerPlan = legacyLowerUsername.map((row) => row.detail);
    const typedLowerPlan = explainQueryPlan(database, lowerUsername);
    expectEquivalentScan(legacyLowerPlan, typedLowerPlan);

    const teams = scan(schema.teams);
    const teamByOwnerRows = filter(
      teams,
      eq(teams.columns.owner_user_id, param("user-1")),
    );
    const teamByOwner = compileD1Query(
      limit(project(teamByOwnerRows, { id: teamByOwnerRows.columns.id }), 1),
    );
    const legacyOwnerPlan = database
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id FROM teams WHERE owner_user_id=? LIMIT 1",
      )
      .all("user-1") as Array<{ detail: string }>;
    expectEquivalentScan(
      legacyOwnerPlan.map((row) => row.detail),
      explainQueryPlan(database, teamByOwner),
    );

    const members = scan(schema.team_members);
    const teamList = join(
      members,
      teams,
      eq(members.columns.team_id, teams.columns.id),
    );
    const memberTeams = filter(
      teamList,
      eq(teamList.columns.left_user_id, param("user-1")),
    );
    const projectedTeamList = project(memberTeams, {
      id: memberTeams.columns.right_id,
      createdAt: memberTeams.columns.right_created_at,
    });
    const teamListQuery = compileD1Query(
      sort(projectedTeamList, [
        { expression: projectedTeamList.columns.createdAt, direction: "DESC" },
      ]),
    );
    expectIndexSearch(
      explainQueryPlan(database, teamListQuery),
      "idx_team_members_user",
    );
    expectIndexSearch(
      explainQueryPlan(database, teamListQuery),
      "sqlite_autoindex_teams_1",
    );
  });

  it("keeps correlated team-count lookups on legacy access paths", () => {
    const database = createFixture();

    const teams = scan(schema.teams);
    const members = scan(schema.team_members);
    const membershipJoin = join(
      teams,
      members,
      eq(teams.columns.id, members.columns.team_id),
    );
    const memberTeams = filter(
      membershipJoin,
      eq(membershipJoin.columns.right_user_id, param("user-1")),
    );
    const sites = scan(schema.sites);
    const sitesCount = scalar(
      aggregate(
        filter(sites, eq(sites.columns.team_id, memberTeams.columns.left_id)),
        { groupBy: {}, aggregates: { count: count() } },
      ),
    );
    const memberCountRows = scan(schema.team_members);
    const memberCount = scalar(
      aggregate(
        filter(
          memberCountRows,
          eq(memberCountRows.columns.team_id, memberTeams.columns.left_id),
        ),
        { groupBy: {}, aggregates: { count: count() } },
      ),
    );
    const projectedTeams = project(memberTeams, {
      id: memberTeams.columns.left_id,
      createdAt: memberTeams.columns.left_created_at,
      siteCount: sitesCount,
      memberCount,
    });
    const typedTeamList = compileD1Query(
      sort(projectedTeams, [
        {
          expression: projectedTeams.columns.createdAt,
          direction: "DESC",
        },
      ]),
    );
    const legacyTeamListSql = `SELECT t.id,t.created_at,
      (SELECT COUNT(*) FROM sites s WHERE s.team_id=t.id) AS siteCount,
      (SELECT COUNT(*) FROM team_members x WHERE x.team_id=t.id) AS memberCount
      FROM teams t INNER JOIN team_members tm ON tm.team_id=t.id
      WHERE tm.user_id=? ORDER BY t.created_at DESC`;
    const legacyPlan = explainQueryPlan(database, {
      sql: legacyTeamListSql,
      bindings: ["user-1"],
    });
    const typedPlan = explainQueryPlan(database, typedTeamList);

    expectIndexSearch(legacyPlan, "idx_team_members_user");
    expectIndexSearch(typedPlan, "idx_team_members_user");
    expectIndexSearch(legacyPlan, "idx_sites_team");
    expectIndexSearch(typedPlan, "idx_sites_team");
    expectIndexSearch(legacyPlan, "sqlite_autoindex_team_members_1");
    expectIndexSearch(typedPlan, "sqlite_autoindex_team_members_1");
  });
});
