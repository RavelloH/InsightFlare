import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  AnalysisDefinitionReadCancelledError,
  createAnalysisDefinitionReader,
  parseSavedFilterDsl,
} from "@/lib/api-v1/analytics/analysis-definition-reader";
import { dispatchApiV1CoreRoute } from "@/lib/api-v1/application/core-dispatcher";
import type { SavedFilterDefinition } from "@/lib/api-v1/contract/resources";
import { createSavedFilterApplicationService } from "@/lib/api-v1/resources/saved-filters-service";
import { explainQueryPlan } from "@/lib/db/__tests__/query-plan";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { attachSavedFilterScopePreference } from "@/lib/edge/analytics/contract";
import type { ApiKeyPrincipal } from "@/lib/edge/auth/api-key-auth";

interface LegacySavedFilterRow {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly visibility: "private" | "team";
  readonly scopePreference: "auto" | "event" | "session" | "visitor";
  readonly filterDsl: string;
  readonly filterDslVersion: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

const databases = new Set<DatabaseSync>();

function createFixture(): DatabaseSync {
  const database = createMigratedDatabase();
  databases.add(database);

  const insertUser = database.prepare(
    "INSERT INTO users (id, email, name) VALUES (?, ?, ?)",
  );
  insertUser.run("owner-1", "owner-1@example.test", "Owner One");
  insertUser.run("owner-2", "owner-2@example.test", "Owner Two");

  const insertTeam = database.prepare(
    "INSERT INTO teams (id, name, slug, owner_user_id, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  insertTeam.run("team-1", "Team One", "team-one", "owner-1", 1_700_000_000);
  insertTeam.run("team-2", "Team Two", "team-two", "owner-2", 1_700_000_100);

  const insertSite = database.prepare(
    "INSERT INTO sites (id, team_id, name, domain) VALUES (?, ?, ?, ?)",
  );
  insertSite.run("site-1", "team-1", "Site One", "one.example.test");
  insertSite.run("site-2", "team-1", "Site Two", "two.example.test");
  insertSite.run("site-other", "team-2", "Other Site", "other.example.test");

  return database;
}

function insertSavedFilter(
  database: DatabaseSync,
  input: {
    readonly id: string;
    readonly siteId?: string;
    readonly ownerUserId?: string;
    readonly visibility?: "private" | "team";
    readonly updatedAt: number;
  },
): void {
  database
    .prepare(
      `INSERT INTO saved_filters (
        id, site_id, owner_user_id, visibility, name, description,
        filter_dsl, filter_dsl_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.siteId ?? "site-1",
      input.ownerUserId ?? "owner-1",
      input.visibility ?? "team",
      `Filter ${input.id}`,
      "Team filter",
      'geo.country eq "CN"',
      1,
      input.updatedAt - 10,
      input.updatedAt,
    );
}

function legacySavedFilterRow(
  database: DatabaseSync,
  id: string,
): LegacySavedFilterRow | null {
  return (
    (database
      .prepare(
        `SELECT sf.id, sf.name, sf.description,
                sf.visibility,
                sf.scope_preference AS scopePreference,
                sf.filter_dsl AS filterDsl,
                sf.filter_dsl_version AS filterDslVersion,
                sf.created_at AS createdAt, sf.updated_at AS updatedAt
         FROM saved_filters sf
         INNER JOIN sites s ON s.id = sf.site_id
         WHERE sf.site_id = ? AND sf.id = ?
           AND sf.visibility = 'team' AND s.team_id = ?
         LIMIT 1`,
      )
      .get("site-1", id, "team-1") as LegacySavedFilterRow | undefined) ?? null
  );
}

function legacySavedFilterList(
  database: DatabaseSync,
  cursor: { readonly updatedAt: number; readonly id: string } | null,
  limit: number,
): LegacySavedFilterRow[] {
  const cursorClause = cursor
    ? "AND (sf.updated_at < ? OR (sf.updated_at = ? AND sf.id < ?))"
    : "";
  const bindings = cursor
    ? ["site-1", "team-1", cursor.updatedAt, cursor.updatedAt, cursor.id, limit]
    : ["site-1", "team-1", limit];
  return database
    .prepare(
      `SELECT sf.id, sf.name, sf.description,
              sf.visibility,
              sf.scope_preference AS scopePreference,
              sf.filter_dsl AS filterDsl,
              sf.filter_dsl_version AS filterDslVersion,
              sf.created_at AS createdAt, sf.updated_at AS updatedAt
       FROM saved_filters sf
       INNER JOIN sites s ON s.id = sf.site_id
       WHERE sf.site_id = ? AND sf.visibility = 'team' AND s.team_id = ?
         ${cursorClause}
       ORDER BY sf.updated_at DESC, sf.id DESC
       LIMIT ?`,
    )
    .all(...bindings) as unknown as LegacySavedFilterRow[];
}

function legacyDefinition(row: LegacySavedFilterRow): SavedFilterDefinition {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    visibility: "team",
    scopePreference: row.scopePreference ?? "auto",
    filter: parseSavedFilterDsl(row),
    createdAt: new Date(row.createdAt * 1000).toISOString(),
    updatedAt: new Date(row.updatedAt * 1000).toISOString(),
  };
}

function parseCursor(cursor: string | null): {
  readonly updatedAt: number;
  readonly id: string;
} | null {
  if (!cursor) return null;
  const payload = cursor.split(".")[0]!;
  const base64 = payload.replaceAll("-", "+").replaceAll("_", "/");
  const json = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  const envelope = JSON.parse(json) as {
    key: { updatedAt: number; id: string };
  };
  const value = envelope.key;
  return { updatedAt: value.updatedAt, id: value.id };
}

async function responseData(
  response: Response,
): Promise<Record<string, unknown>> {
  return ((await response.json()) as { data: Record<string, unknown> }).data;
}

const principal: ApiKeyPrincipal = {
  keyId: "key-1",
  teamId: "team-1",
  prefix: "prefix",
  name: "Primary key",
  scopes: ["analytics:read"],
  siteIds: ["site-1"],
  status: "active",
  createdAt: 55,
};

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("API v1 ordinary read differential checks", () => {
  it("matches legacy team lookup, fallback, and visible-site filtering", async () => {
    const database = createFixture();
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const env = { DB: createSqliteD1Database(database, trace) } as never;

    const legacyTeam = database
      .prepare(
        "SELECT id, name, created_at AS createdAt FROM teams WHERE id=? LIMIT 1",
      )
      .get("team-1") as { id: string; name: string; createdAt: number };
    const legacySites = database
      .prepare("SELECT id FROM sites WHERE team_id=?")
      .all("team-1") as Array<{ id: string }>;
    const restrictedCount = legacySites.filter((site) =>
      principal.siteIds.includes(site.id),
    ).length;

    const teamResponse = await dispatchApiV1CoreRoute({
      routeId: "core.team.get",
      request: new Request("https://app.test/api/v1/team"),
      env,
      principal,
    });
    const team = await responseData(teamResponse);
    expect(team).toMatchObject({
      id: legacyTeam.id,
      name: legacyTeam.name,
      createdAt: new Date(legacyTeam.createdAt * 1000).toISOString(),
    });

    const usage = await dispatchApiV1CoreRoute({
      routeId: "core.team.usage",
      request: new Request("https://app.test/api/v1/team/usage"),
      env,
      principal,
    });
    expect(await responseData(usage)).toEqual({ sites: restrictedCount });

    const unrestrictedUsage = await dispatchApiV1CoreRoute({
      routeId: "core.team.usage",
      request: new Request("https://app.test/api/v1/team/usage"),
      env,
      principal: { ...principal, siteIds: [] },
    });
    expect(await responseData(unrestrictedUsage)).toEqual({
      sites: legacySites.length,
    });

    const absentTeamResponse = await dispatchApiV1CoreRoute({
      routeId: "core.team.get",
      request: new Request("https://app.test/api/v1/team"),
      env,
      principal: { ...principal, teamId: "removed-team" },
    });
    expect(await responseData(absentTeamResponse)).toMatchObject({
      id: "removed-team",
      name: "removed-team",
      createdAt: new Date(principal.createdAt! * 1000).toISOString(),
    });
    expect(trace.preparedSql).toHaveLength(4);
  });

  it("matches the legacy team-visible analysis-definition join and abort behavior", async () => {
    const database = createFixture();
    insertSavedFilter(database, { id: "filter-1", updatedAt: 100 });
    insertSavedFilter(database, {
      id: "private-filter",
      visibility: "private",
      updatedAt: 200,
    });
    insertSavedFilter(database, {
      id: "other-team-filter",
      siteId: "site-other",
      ownerUserId: "owner-2",
      updatedAt: 300,
    });
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const reader = createAnalysisDefinitionReader(
      { DB: createSqliteD1Database(database, trace) } as never,
      { teamId: "team-1" },
    );

    const legacy = database
      .prepare(
        `SELECT sf.filter_dsl AS filterDsl,
                sf.filter_dsl_version AS filterDslVersion,
                COALESCE(sf.scope_preference, 'auto') AS scopePreference
         FROM saved_filters sf
         INNER JOIN sites s ON s.id = sf.site_id
         WHERE sf.site_id = ? AND sf.id = ?
           AND sf.visibility = 'team' AND s.team_id = ?
         LIMIT 1`,
      )
      .get("site-1", "filter-1", "team-1") as {
      filterDsl: string;
      filterDslVersion: number;
      scopePreference: "auto" | "event" | "session" | "visitor";
    };
    const expectedDocument = attachSavedFilterScopePreference(
      parseSavedFilterDsl(legacy),
      legacy.scopePreference,
    );
    const expectedFingerprint = await (async () => {
      const value = JSON.stringify([legacy.filterDslVersion, legacy.filterDsl]);
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(value),
      );
      return `saved-filter-v1:${legacy.filterDslVersion}:${Array.from(
        new Uint8Array(digest),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("")}`;
    })();

    const resolved = await reader.resolveTeamVisibleSavedFilter({
      siteId: "site-1",
      id: "filter-1",
    });
    expect(resolved).toEqual({
      document: expectedDocument,
      scopePreference: legacy.scopePreference,
      fingerprint: expectedFingerprint,
    });
    await expect(
      reader.resolveTeamVisibleSavedFilter({
        siteId: "site-other",
        id: "other-team-filter",
      }),
    ).resolves.toBeNull();
    expect(trace.preparedSql).toHaveLength(2);

    const aborted = new AbortController();
    aborted.abort();
    await expect(
      reader.resolveTeamVisibleSavedFilter({
        siteId: "site-1",
        id: "filter-1",
        signal: aborted.signal,
      }),
    ).rejects.toBeInstanceOf(AnalysisDefinitionReadCancelledError);
    expect(trace.preparedSql).toHaveLength(2);
  });

  it("matches legacy saved-filter get and keyset pages including the tie-breaker", async () => {
    const database = createFixture();
    insertSavedFilter(database, { id: "filter-z", updatedAt: 100 });
    insertSavedFilter(database, { id: "filter-b", updatedAt: 100 });
    insertSavedFilter(database, { id: "filter-a", updatedAt: 100 });
    insertSavedFilter(database, { id: "filter-d", updatedAt: 90 });
    insertSavedFilter(database, { id: "filter-c", updatedAt: 90 });
    insertSavedFilter(database, {
      id: "private-filter",
      visibility: "private",
      updatedAt: 200,
    });
    insertSavedFilter(database, {
      id: "other-team-filter",
      siteId: "site-other",
      ownerUserId: "owner-2",
      updatedAt: 300,
    });

    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const service = createSavedFilterApplicationService(
      { DB: createSqliteD1Database(database, trace) } as never,
      "cursor-secret",
    );
    const context = { teamId: "team-1", siteIds: [] };

    const expectedGet = legacySavedFilterRow(database, "filter-b");
    const actualGet = await service.execute(
      context,
      "savedFilters.get",
      { siteId: "site-1", id: "filter-b" },
      {},
    );
    expect(actualGet).toEqual({
      ok: true,
      value: legacyDefinition(expectedGet!),
    });
    const typedGetPlan = explainQueryPlan(database, {
      sql: trace.preparedSql[0]!,
      bindings: trace.bindings[0]!,
    });
    const legacyGetPlan = explainQueryPlan(database, {
      sql: `SELECT sf.id AS id, sf.name AS name, sf.description AS description,
                   sf.scope_preference AS scopePreference, sf.filter_dsl AS filterDsl,
                   sf.filter_dsl_version AS filterDslVersion,
                   sf.created_at AS createdAt, sf.updated_at AS updatedAt
            FROM saved_filters sf
            INNER JOIN sites s ON s.id = sf.site_id
            WHERE sf.site_id = ? AND sf.id = ? AND sf.visibility = 'team'
              AND s.team_id = ? LIMIT 1`,
      bindings: ["site-1", "filter-b", "team-1"],
    });
    const usedIndexes = (plan: readonly string[]) =>
      plan.flatMap((detail) => {
        const match = detail.match(/USING (?:COVERING )?INDEX ([^\s(]+)/);
        return match ? [match[1]] : [];
      });
    expect(usedIndexes(typedGetPlan)).toEqual(usedIndexes(legacyGetPlan));

    const legacyFirst = legacySavedFilterList(database, null, 3);
    const first = await service.execute(
      context,
      "savedFilters.list",
      { siteId: "site-1", page: { limit: 2, cursor: null } },
      {},
    );
    expect(first).toMatchObject({
      ok: true,
      value: {
        items: legacyFirst.slice(0, 2).map(legacyDefinition),
        pagination: { limit: 2, hasMore: true, returned: 2 },
      },
    });
    const firstCursor = first.ok ? first.value.pagination.nextCursor : null;
    expect(parseCursor(firstCursor)).toEqual({
      updatedAt: legacyFirst[1]!.updatedAt,
      id: legacyFirst[1]!.id,
    });

    const legacySecond = legacySavedFilterList(
      database,
      parseCursor(firstCursor),
      3,
    );
    const second = await service.execute(
      context,
      "savedFilters.list",
      { siteId: "site-1", page: { limit: 2, cursor: firstCursor } },
      {},
    );
    expect(second).toMatchObject({
      ok: true,
      value: {
        items: legacySecond.slice(0, 2).map(legacyDefinition),
        pagination: { limit: 2, hasMore: true, returned: 2 },
      },
    });
    const secondCursor = second.ok ? second.value.pagination.nextCursor : null;
    expect(parseCursor(secondCursor)).toEqual({
      updatedAt: legacySecond[1]!.updatedAt,
      id: legacySecond[1]!.id,
    });

    const legacyThird = legacySavedFilterList(
      database,
      parseCursor(secondCursor),
      3,
    );
    const third = await service.execute(
      context,
      "savedFilters.list",
      { siteId: "site-1", page: { limit: 2, cursor: secondCursor } },
      {},
    );
    expect(third).toMatchObject({
      ok: true,
      value: {
        items: legacyThird.map(legacyDefinition),
        pagination: { limit: 2, hasMore: false, returned: 1, nextCursor: null },
      },
    });

    await expect(
      service.execute(
        context,
        "savedFilters.get",
        { siteId: "site-1", id: "private-filter" },
        {},
      ),
    ).resolves.toEqual({ ok: false, error: { code: "not_found" } });
    expect(trace.preparedSql).toHaveLength(5);
  });
});
