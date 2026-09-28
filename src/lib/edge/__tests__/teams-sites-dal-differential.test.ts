import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { toTeamRole } from "@/lib/dashboard/permissions";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import {
  handleSiteConfigAdmin,
  handleSitesAdmin,
} from "@/lib/edge/admin/sites/handler";
import { teamDeletionMutations } from "@/lib/edge/admin/teams/deletion";
import {
  handleMembersAdmin,
  handleTeamsAdmin,
} from "@/lib/edge/admin/teams/handlers";
import { siteDeletionMutations } from "@/lib/edge/sites/site-deletion";
import type { Env } from "@/lib/edge/types";

const mocks = vi.hoisted(() => ({
  requireActor: vi.fn(),
  byId: vi.fn(),
  byIdentifier: vi.fn(),
  canAdministerTeam: vi.fn(),
  canManageSite: vi.fn(),
  canManageTeam: vi.fn(),
  canReadSite: vi.fn(),
  canReadTeam: vi.fn(),
  teamById: vi.fn(),
  teamMembershipAccess: vi.fn(),
  uniqueTeamSlug: vi.fn(),
  toSlug: vi.fn(),
  upsertSiteScriptSettings: vi.fn(),
  deleteSiteScriptSettings: vi.fn(),
  readSiteTrackingConfig: vi.fn(),
  upsertSiteTrackingConfig: vi.fn(),
  siteSettingsFailure: null as Error | null,
}));

vi.mock("@/lib/edge/admin/auth", () => ({
  requireActor: mocks.requireActor,
  byId: mocks.byId,
  byIdentifier: mocks.byIdentifier,
}));
vi.mock("@/lib/edge/admin/access", () => ({
  canAdministerTeam: mocks.canAdministerTeam,
  canManageSite: mocks.canManageSite,
  canManageTeam: mocks.canManageTeam,
  canReadSite: mocks.canReadSite,
  canReadTeam: mocks.canReadTeam,
  teamById: mocks.teamById,
  teamMembershipAccess: mocks.teamMembershipAccess,
  uniqueTeamSlug: mocks.uniqueTeamSlug,
  toSlug: mocks.toSlug,
}));
vi.mock("@/lib/edge/sites/settings-store", () => ({
  upsertSiteScriptSettings: mocks.upsertSiteScriptSettings,
  deleteSiteScriptSettings: mocks.deleteSiteScriptSettings,
  readSiteTrackingConfig: mocks.readSiteTrackingConfig,
  upsertSiteTrackingConfig: mocks.upsertSiteTrackingConfig,
}));

const FIXED_TIME = 1_800_000_000;
const teamDeletionTableOrder = [
  "custom_event_json_values",
  "custom_event_json_nodes",
  "custom_events",
  "custom_event_names",
  "custom_event_json_keys",
  "custom_event_json_paths",
  "visits",
  "visit_hourly_rollups",
  "visit_hourly_aggregation_state",
  "configs",
] as const;
const databases = new Set<DatabaseSync>();
const actor = {
  user: {
    id: "owner-1",
    username: "owner",
    email: "owner@example.test",
    name: "Owner",
    password_hash: null,
    system_role: "admin",
    timezone: "UTC",
    created_at: 10,
    updated_at: 10,
  },
  isAdmin: true,
};
const member = {
  id: "member-2",
  username: "member2",
  email: "member2@example.test",
  name: "Member Two",
  password_hash: null,
  system_role: "user",
  timezone: "UTC",
  created_at: 20,
  updated_at: 20,
};

interface Fixture {
  database: DatabaseSync;
  env: Env;
  trace: SqliteD1Trace;
}

function createFixture(options: { previousOwnerRole?: string } = {}): Fixture {
  const database = createMigratedDatabase();
  database.function("unixepoch", () => FIXED_TIME);
  databases.add(database);
  const insertUser = database.prepare(
    "INSERT INTO users (id,email,name,username,system_role,timezone,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
  );
  insertUser.run(
    "owner-1",
    "owner@example.test",
    "Owner",
    "owner",
    "admin",
    "UTC",
    10,
    10,
  );
  insertUser.run(
    "member-1",
    "member@example.test",
    "Member",
    "member",
    "user",
    "UTC",
    20,
    20,
  );
  insertUser.run(
    "member-2",
    "member2@example.test",
    "Member Two",
    "member2",
    "user",
    "UTC",
    30,
    30,
  );
  database
    .prepare(
      "INSERT INTO teams (id,name,slug,owner_user_id,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    )
    .run("team-1", "Team One", "team-one", "owner-1", 100, 100);
  const insertMembership = database.prepare(
    "INSERT INTO team_members (team_id,user_id,role,site_ids_json,joined_at) VALUES (?,?,?,?,?)",
  );
  insertMembership.run(
    "team-1",
    "owner-1",
    options.previousOwnerRole ?? "owner",
    "[]",
    101,
  );
  insertMembership.run("team-1", "member-1", "member", '["site-1"]', 102);
  const insertSite = database.prepare(
    "INSERT INTO sites (id,team_id,name,domain,public_enabled,public_slug,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
  );
  insertSite.run(
    "site-1",
    "team-1",
    "Site One",
    "one.example.test",
    1,
    "site-one",
    201,
    201,
  );
  insertSite.run(
    "site-2",
    "team-1",
    "Site Two",
    "two.example.test",
    0,
    null,
    202,
    202,
  );

  const trace: SqliteD1Trace = {
    preparedSql: [],
    bindings: [],
    batchStatements: [],
  };
  return {
    database,
    env: {
      MAIN_SECRET: "teams-sites-dal-test-secret",
      DB: createSqliteD1Database(database, trace),
    } as Env,
    trace,
  };
}

function request(path: string, method = "GET", body?: unknown): Request {
  return new Request(`https://app.test${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
}

async function responseData(response: Response): Promise<unknown> {
  const json = (await response.json()) as { data?: unknown };
  return json.data;
}

function seedSiteDeletionRows(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = ON");
  const insertIdentity = database.prepare(
    "INSERT INTO site_identities (site_id) VALUES (?)",
  );
  insertIdentity.run("site-1");
  insertIdentity.run("site-2");
  const sitePk = (siteId: string) =>
    (
      database
        .prepare("SELECT site_pk FROM site_identities WHERE site_id=?")
        .get(siteId) as { site_pk: number }
    ).site_pk;
  const targetPk = sitePk("site-1");
  const controlPk = sitePk("site-2");

  const insertConfig = database.prepare(
    "INSERT INTO configs (config_key,value_json) VALUES (?,?)",
  );
  insertConfig.run("site:site-1", "{}");
  insertConfig.run("site:site-2", "{}");
  const insertVisit = database.prepare(
    "INSERT INTO visits (visit_id,site_id,visitor_id,session_id,status,started_at,last_activity_at,pathname,hostname,site_pk) VALUES (?,?,?,?,?,?,?,?,?,?)",
  );
  insertVisit.run(
    "visit-site-1",
    "site-1",
    "visitor-1",
    "session-1",
    "open",
    100,
    100,
    "/",
    "one.example.test",
    targetPk,
  );
  insertVisit.run(
    "visit-site-2",
    "site-2",
    "visitor-2",
    "session-2",
    "open",
    200,
    200,
    "/",
    "two.example.test",
    controlPk,
  );

  const insertEventName = database.prepare(
    "INSERT INTO custom_event_names (id,site_id,name,last_seen_at,site_pk) VALUES (?,?,?,?,?)",
  );
  insertEventName.run(301, "site-1", "target", 100, targetPk);
  insertEventName.run(302, "site-2", "control", 200, controlPk);
  const insertEvent = database.prepare(
    "INSERT INTO custom_events (event_pk,event_id,site_id,visit_id,event_name_id,occurred_at,received_at,node_count,value_count,site_pk) VALUES (?,?,?,?,?,?,?,?,?,?)",
  );
  insertEvent.run(
    401,
    "event-site-1",
    "site-1",
    "visit-site-1",
    301,
    100,
    100,
    1,
    1,
    targetPk,
  );
  insertEvent.run(
    402,
    "event-site-2",
    "site-2",
    "visit-site-2",
    302,
    200,
    200,
    1,
    1,
    controlPk,
  );
  const insertKey = database.prepare(
    "INSERT INTO custom_event_json_keys (id,site_id,key,last_seen_at,site_pk) VALUES (?,?,?,?,?)",
  );
  insertKey.run(501, "site-1", "target-key", 100, targetPk);
  insertKey.run(502, "site-2", "control-key", 200, controlPk);
  const insertPath = database.prepare(
    "INSERT INTO custom_event_json_paths (id,site_id,path,last_seen_at,site_pk) VALUES (?,?,?,?,?)",
  );
  insertPath.run(601, "site-1", "$.target", 100, targetPk);
  insertPath.run(602, "site-2", "$.control", 200, controlPk);
  const insertNode = database.prepare(
    "INSERT INTO custom_event_json_nodes (event_pk,node_id,key_id,path_id,value_type,depth) VALUES (?,?,?,?,?,?)",
  );
  insertNode.run(401, 1, 501, 601, 1, 1);
  insertNode.run(402, 1, 502, 602, 1, 1);
  const insertValue = database.prepare(
    "INSERT INTO custom_event_json_values (event_pk,node_id,site_id,event_name_id,path_id,occurred_at,value_type,string_value,site_pk) VALUES (?,?,?,?,?,?,?,?,?)",
  );
  insertValue.run(401, 1, "site-1", 301, 601, 100, 1, "target", targetPk);
  insertValue.run(402, 1, "site-2", 302, 602, 200, 1, "control", controlPk);
  const insertRollup = database.prepare(
    "INSERT INTO visit_hourly_rollups (site_id,hour_bucket,input_cutoff_ms,site_pk) VALUES (?,?,?,?)",
  );
  insertRollup.run("site-1", 1, 1000, targetPk);
  insertRollup.run("site-2", 2, 1000, controlPk);
  const insertAggregationState = database.prepare(
    "INSERT INTO visit_hourly_aggregation_state (site_id,site_pk) VALUES (?,?)",
  );
  insertAggregationState.run("site-1", targetPk);
  insertAggregationState.run("site-2", controlPk);
}

const siteDeletionSnapshotTables = [
  "configs",
  "custom_event_json_values",
  "custom_event_json_nodes",
  "custom_events",
  "custom_event_names",
  "custom_event_json_keys",
  "custom_event_json_paths",
  "visits",
  "visit_hourly_rollups",
  "visit_hourly_aggregation_state",
  "sites",
  "site_identities",
  "teams",
  "team_members",
] as const;

function siteDeletionSnapshot(database: DatabaseSync): Record<string, unknown> {
  return Object.fromEntries(
    siteDeletionSnapshotTables.map((table) => [
      table,
      database.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all(),
    ]),
  );
}

function applyLegacySiteDeletion(database: DatabaseSync, siteId: string): void {
  const sitePk = "(SELECT site_pk FROM site_identities WHERE site_id=?)";
  database
    .prepare("DELETE FROM configs WHERE config_key=?")
    .run(`site:${siteId}`);
  database
    .prepare(`DELETE FROM custom_event_json_values WHERE site_pk=${sitePk}`)
    .run(siteId);
  database
    .prepare(
      `DELETE FROM custom_event_json_nodes WHERE event_pk IN (SELECT event_pk FROM custom_events WHERE site_pk=${sitePk})`,
    )
    .run(siteId);
  database
    .prepare(`DELETE FROM custom_events WHERE site_pk=${sitePk}`)
    .run(siteId);
  database
    .prepare(`DELETE FROM custom_event_names WHERE site_pk=${sitePk}`)
    .run(siteId);
  database
    .prepare(`DELETE FROM custom_event_json_keys WHERE site_pk=${sitePk}`)
    .run(siteId);
  database
    .prepare(`DELETE FROM custom_event_json_paths WHERE site_pk=${sitePk}`)
    .run(siteId);
  database.prepare(`DELETE FROM visits WHERE site_pk=${sitePk}`).run(siteId);
  database
    .prepare(`DELETE FROM visit_hourly_rollups WHERE site_pk=${sitePk}`)
    .run(siteId);
  database
    .prepare(
      `DELETE FROM visit_hourly_aggregation_state WHERE site_pk=${sitePk}`,
    )
    .run(siteId);
  database.prepare("DELETE FROM sites WHERE id=?").run(siteId);
}

function applyLegacyTeamDeletion(database: DatabaseSync, teamId: string): void {
  const siteIds = (
    database
      .prepare("SELECT id FROM sites WHERE team_id=?")
      .all(teamId) as Array<{ id: string }>
  ).map(({ id }) => id);
  const siteStatements = [
    (placeholders: string) =>
      `DELETE FROM custom_event_json_values WHERE site_pk IN (SELECT site_pk FROM site_identities WHERE site_id IN (${placeholders}))`,
    (placeholders: string) =>
      `DELETE FROM custom_event_json_nodes WHERE event_pk IN (SELECT event_pk FROM custom_events WHERE site_pk IN (SELECT site_pk FROM site_identities WHERE site_id IN (${placeholders})))`,
    (placeholders: string) =>
      `DELETE FROM custom_events WHERE site_pk IN (SELECT site_pk FROM site_identities WHERE site_id IN (${placeholders}))`,
    (placeholders: string) =>
      `DELETE FROM custom_event_names WHERE site_pk IN (SELECT site_pk FROM site_identities WHERE site_id IN (${placeholders}))`,
    (placeholders: string) =>
      `DELETE FROM custom_event_json_keys WHERE site_pk IN (SELECT site_pk FROM site_identities WHERE site_id IN (${placeholders}))`,
    (placeholders: string) =>
      `DELETE FROM custom_event_json_paths WHERE site_pk IN (SELECT site_pk FROM site_identities WHERE site_id IN (${placeholders}))`,
    (placeholders: string) =>
      `DELETE FROM visits WHERE site_pk IN (SELECT site_pk FROM site_identities WHERE site_id IN (${placeholders}))`,
    (placeholders: string) =>
      `DELETE FROM visit_hourly_rollups WHERE site_pk IN (SELECT site_pk FROM site_identities WHERE site_id IN (${placeholders}))`,
    (placeholders: string) =>
      `DELETE FROM visit_hourly_aggregation_state WHERE site_pk IN (SELECT site_pk FROM site_identities WHERE site_id IN (${placeholders}))`,
    (placeholders: string) =>
      `DELETE FROM configs WHERE config_key IN (${placeholders})`,
  ];
  for (const statement of siteStatements) {
    for (let offset = 0; offset < siteIds.length; offset += 100) {
      const chunk = siteIds.slice(offset, offset + 100);
      const bindings =
        statement === siteStatements[9]
          ? chunk.map((siteId) => `site:${siteId}`)
          : chunk;
      database
        .prepare(statement(chunk.map(() => "?").join(",")))
        .run(...bindings);
    }
  }
  database.prepare("DELETE FROM teams WHERE id=?").run(teamId);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases) database.close();
  databases.clear();
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.siteSettingsFailure = null;
  mocks.requireActor.mockResolvedValue(actor);
  mocks.byId.mockImplementation(async (_env: Env, id: string) =>
    id === "owner-1" ? actor.user : id === "member-2" ? member : null,
  );
  mocks.byIdentifier.mockResolvedValue(member);
  mocks.canAdministerTeam.mockResolvedValue(true);
  mocks.canManageSite.mockResolvedValue(true);
  mocks.canManageTeam.mockResolvedValue(true);
  mocks.canReadSite.mockResolvedValue(true);
  mocks.canReadTeam.mockResolvedValue(true);
  mocks.teamById.mockResolvedValue({ id: "team-1", ownerUserId: "owner-1" });
  mocks.teamMembershipAccess.mockResolvedValue(null);
  mocks.uniqueTeamSlug.mockResolvedValue("team-slug");
  mocks.toSlug.mockImplementation((value: string) =>
    value.toLowerCase().replace(/\s+/g, "-"),
  );
  mocks.upsertSiteScriptSettings.mockImplementation(async () => {
    if (mocks.siteSettingsFailure) throw mocks.siteSettingsFailure;
    return {};
  });
  mocks.deleteSiteScriptSettings.mockResolvedValue(undefined);
  mocks.readSiteTrackingConfig.mockResolvedValue(null);
  mocks.upsertSiteTrackingConfig.mockImplementation(
    async (_env, siteId, input) => ({
      siteId,
      siteDomain: input.siteDomain,
      allowedHostnames: [],
    }),
  );
});

describe("Teams and Sites admin Typed DAL differential checks", () => {
  it("matches legacy site cleanup and preserves sequential statement order", async () => {
    const actual = createFixture();
    const legacy = createFixture();
    seedSiteDeletionRows(actual.database);
    seedSiteDeletionRows(legacy.database);

    const typedVisitDelete = siteDeletionMutations("site-1")[7]!;
    const legacyVisitSql =
      "DELETE FROM visits WHERE site_pk=(SELECT site_pk FROM site_identities WHERE site_id=?)";
    const typedVisitPlan = actual.database
      .prepare(`EXPLAIN QUERY PLAN ${typedVisitDelete.sql}`)
      .all(...(typedVisitDelete.bindings as SQLInputValue[])) as Array<{
      detail: string;
    }>;
    const legacyVisitPlan = actual.database
      .prepare(`EXPLAIN QUERY PLAN ${legacyVisitSql}`)
      .all("site-1") as Array<{ detail: string }>;
    expect(typedVisitPlan.map(({ detail }) => detail).join(" ")).toContain(
      "idx_visits_site_pk_started_at",
    );
    expect(legacyVisitPlan.map(({ detail }) => detail).join(" ")).toContain(
      "idx_visits_site_pk_started_at",
    );

    const typedNodeDelete = siteDeletionMutations("site-1")[2]!;
    const legacyNodeSql =
      "DELETE FROM custom_event_json_nodes WHERE event_pk IN (SELECT event_pk FROM custom_events WHERE site_pk=(SELECT site_pk FROM site_identities WHERE site_id=?))";
    const typedNodePlan = actual.database
      .prepare(`EXPLAIN QUERY PLAN ${typedNodeDelete.sql}`)
      .all(...(typedNodeDelete.bindings as SQLInputValue[])) as Array<{
      detail: string;
    }>;
    const legacyNodePlan = actual.database
      .prepare(`EXPLAIN QUERY PLAN ${legacyNodeSql}`)
      .all("site-1") as Array<{ detail: string }>;
    expect(typedNodePlan.map(({ detail }) => detail).join(" ")).toContain(
      "sqlite_autoindex_custom_event_json_nodes_1",
    );
    expect(legacyNodePlan.map(({ detail }) => detail).join(" ")).toContain(
      "sqlite_autoindex_custom_event_json_nodes_1",
    );

    applyLegacySiteDeletion(legacy.database, "site-1");
    actual.trace.preparedSql.length = 0;
    mocks.deleteSiteScriptSettings.mockImplementation(async (_env, siteId) => {
      expect(siteId).toBe("site-1");
      expect(actual.trace.preparedSql).toHaveLength(12);
      expect(
        actual.database.prepare("SELECT id FROM sites WHERE id=?").get(siteId),
      ).toBeUndefined();
    });
    const response = await handleSitesAdmin(
      request("/admin/sites", "PATCH", {
        siteId: "site-1",
        intent: "remove",
      }),
      actual.env,
      new URL("https://app.test/admin/sites"),
    );

    expect(response.status).toBe(200);
    expect(actual.trace.batchStatements).toEqual([]);
    const deletionSql = actual.trace.preparedSql.slice(-11);
    expect(
      deletionSql.map((sql) => sql.match(/DELETE FROM "([^"]+)"/)?.[1]),
    ).toEqual([
      "configs",
      "custom_event_json_values",
      "custom_event_json_nodes",
      "custom_events",
      "custom_event_names",
      "custom_event_json_keys",
      "custom_event_json_paths",
      "visits",
      "visit_hourly_rollups",
      "visit_hourly_aggregation_state",
      "sites",
    ]);
    expect(siteDeletionSnapshot(actual.database)).toEqual(
      siteDeletionSnapshot(legacy.database),
    );
    expect(
      actual.database.prepare("SELECT 1 FROM sites WHERE id=?").get("site-2"),
    ).toBeDefined();
    expect(
      actual.database.prepare("SELECT 1 FROM sites WHERE id=?").get("site-1"),
    ).toBeUndefined();
    expect(mocks.deleteSiteScriptSettings).toHaveBeenCalledWith(
      actual.env,
      "site-1",
    );
    legacy.database.close();
    databases.delete(legacy.database);
  });

  it("matches legacy team cleanup, chunk grouping, KV timing, and D1 plans", async () => {
    const actual = createFixture();
    const legacy = createFixture();
    seedSiteDeletionRows(actual.database);
    seedSiteDeletionRows(legacy.database);

    const typedMutations = teamDeletionMutations(["site-1", "site-2"]);
    const typedVisitDelete = typedMutations.find((mutation) =>
      mutation.sql.startsWith('DELETE FROM "visits"'),
    )!;
    const legacyVisitSql =
      "DELETE FROM visits WHERE site_pk IN (SELECT site_pk FROM site_identities WHERE site_id IN (?,?))";
    const typedVisitPlan = actual.database
      .prepare(`EXPLAIN QUERY PLAN ${typedVisitDelete.sql}`)
      .all(...(typedVisitDelete.bindings as SQLInputValue[])) as Array<{
      detail: string;
    }>;
    const legacyVisitPlan = actual.database
      .prepare(`EXPLAIN QUERY PLAN ${legacyVisitSql}`)
      .all("site-1", "site-2") as Array<{ detail: string }>;
    expect(typedVisitPlan.map(({ detail }) => detail).join(" ")).toContain(
      "idx_visits_site_pk_started_at",
    );
    expect(legacyVisitPlan.map(({ detail }) => detail).join(" ")).toContain(
      "idx_visits_site_pk_started_at",
    );

    const typedNodeDelete = typedMutations.find((mutation) =>
      mutation.sql.startsWith('DELETE FROM "custom_event_json_nodes"'),
    )!;
    const legacyNodeSql =
      "DELETE FROM custom_event_json_nodes WHERE event_pk IN (SELECT event_pk FROM custom_events WHERE site_pk IN (SELECT site_pk FROM site_identities WHERE site_id IN (?,?)))";
    const typedNodePlan = actual.database
      .prepare(`EXPLAIN QUERY PLAN ${typedNodeDelete.sql}`)
      .all(...(typedNodeDelete.bindings as SQLInputValue[])) as Array<{
      detail: string;
    }>;
    const legacyNodePlan = actual.database
      .prepare(`EXPLAIN QUERY PLAN ${legacyNodeSql}`)
      .all("site-1", "site-2") as Array<{ detail: string }>;
    expect(typedNodePlan.map(({ detail }) => detail).join(" ")).toContain(
      "sqlite_autoindex_custom_event_json_nodes_1",
    );
    expect(legacyNodePlan.map(({ detail }) => detail).join(" ")).toContain(
      "sqlite_autoindex_custom_event_json_nodes_1",
    );

    applyLegacyTeamDeletion(legacy.database, "team-1");
    actual.trace.preparedSql.length = 0;
    const dependentTables = siteDeletionSnapshotTables.filter(
      (table) =>
        !["site_identities", "sites", "teams", "team_members"].includes(table),
    );
    mocks.deleteSiteScriptSettings.mockImplementation(async () => {
      expect(
        actual.database
          .prepare("SELECT id FROM teams WHERE id=?")
          .get("team-1"),
      ).toBeDefined();
      for (const table of dependentTables) {
        expect(
          actual.database
            .prepare(`SELECT COUNT(*) AS count FROM "${table}"`)
            .get(),
        ).toEqual({ count: 0 });
      }
    });
    const response = await handleTeamsAdmin(
      request("/admin/teams", "PATCH", {
        teamId: "team-1",
        intent: "delete",
      }),
      actual.env,
    );

    expect(response.status).toBe(200);
    expect(actual.trace.batchStatements).toEqual([]);
    const deletionSql = actual.trace.preparedSql.filter((sql) =>
      sql.startsWith("DELETE FROM "),
    );
    expect(
      deletionSql.map((sql) => sql.match(/DELETE FROM "([^"]+)"/)?.[1]),
    ).toEqual([...teamDeletionTableOrder, "teams"]);
    expect(siteDeletionSnapshot(actual.database)).toEqual(
      siteDeletionSnapshot(legacy.database),
    );
    expect(mocks.deleteSiteScriptSettings).toHaveBeenNthCalledWith(
      1,
      actual.env,
      "site-1",
    );
    expect(mocks.deleteSiteScriptSettings).toHaveBeenNthCalledWith(
      2,
      actual.env,
      "site-2",
    );
    expect(
      actual.database.prepare("SELECT 1 FROM teams WHERE id=?").get("team-1"),
    ).toBeUndefined();
    legacy.database.close();
    databases.delete(legacy.database);
  });

  it("stops at the first failed team cleanup statement without rolling back prior runs", async () => {
    const actual = createFixture();
    seedSiteDeletionRows(actual.database);
    actual.trace.preparedSql.length = 0;
    const delegate = actual.env.DB;
    const failingDatabase = {
      prepare(sql: string) {
        const prepared = delegate.prepare(sql);
        if (!sql.startsWith('DELETE FROM "custom_event_json_nodes"'))
          return prepared;
        return new Proxy(prepared, {
          get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver);
            if (property !== "bind") return value;
            return (...bindings: SQLInputValue[]) => {
              const bound = Reflect.apply(
                value,
                target,
                bindings,
              ) as D1PreparedStatement;
              return new Proxy(bound, {
                get(boundTarget, boundProperty, boundReceiver) {
                  if (boundProperty === "run")
                    return async () => {
                      throw new Error("simulated_team_cleanup_failure");
                    };
                  return Reflect.get(boundTarget, boundProperty, boundReceiver);
                },
              });
            };
          },
        }) as D1PreparedStatement;
      },
      batch(statements: D1PreparedStatement[]) {
        return delegate.batch(statements);
      },
    } as D1Database;
    const failingEnv = { ...actual.env, DB: failingDatabase } as Env;

    await expect(
      handleTeamsAdmin(
        request("/admin/teams", "PATCH", {
          teamId: "team-1",
          intent: "delete",
        }),
        failingEnv,
      ),
    ).rejects.toThrow("simulated_team_cleanup_failure");

    const attemptedDeletes = actual.trace.preparedSql.filter((sql) =>
      sql.startsWith("DELETE FROM "),
    );
    expect(
      attemptedDeletes.map((sql) => sql.match(/DELETE FROM "([^"]+)"/)?.[1]),
    ).toEqual(["custom_event_json_values", "custom_event_json_nodes"]);
    expect(actual.trace.batchStatements).toEqual([]);
    expect(
      actual.database
        .prepare("SELECT 1 FROM custom_event_json_values WHERE event_pk=401")
        .get(),
    ).toBeUndefined();
    expect(
      actual.database
        .prepare("SELECT 1 FROM custom_event_json_nodes WHERE event_pk=401")
        .get(),
    ).toBeDefined();
    expect(
      actual.database
        .prepare("SELECT 1 FROM custom_events WHERE event_pk=401")
        .get(),
    ).toBeDefined();
    expect(
      actual.database.prepare("SELECT 1 FROM teams WHERE id=?").get("team-1"),
    ).toBeDefined();
    expect(mocks.deleteSiteScriptSettings).not.toHaveBeenCalled();
  });

  it("matches legacy admin team counts, projections, and ordering", async () => {
    const { database, env } = createFixture();
    const expected = database
      .prepare(
        "SELECT t.id,t.name,t.slug,t.owner_user_id AS ownerUserId,t.created_at AS createdAt,t.updated_at AS updatedAt,'owner' AS membershipRole,(SELECT COUNT(*) FROM sites s WHERE s.team_id=t.id) AS siteCount,(SELECT COUNT(*) FROM team_members x WHERE x.team_id=t.id) AS memberCount FROM teams t ORDER BY t.created_at DESC",
      )
      .all();
    const response = await handleTeamsAdmin(request("/admin/teams"), env);
    const actual = (await responseData(response)) as Array<
      Record<string, unknown>
    >;
    expect(actual).toEqual(
      expected.map((row) => ({
        ...(row as Record<string, unknown>),
        membershipRole: toTeamRole("owner"),
      })),
    );
  });

  it("matches legacy member JOIN fields and order", async () => {
    const { database, env } = createFixture();
    const expected = database
      .prepare(
        "SELECT tm.team_id AS teamId,tm.user_id AS userId,tm.role,tm.site_ids_json AS siteIdsJson,tm.joined_at AS joinedAt,u.username,u.email,u.name FROM team_members tm INNER JOIN users u ON u.id=tm.user_id WHERE tm.team_id=? ORDER BY tm.joined_at ASC",
      )
      .all("team-1") as Array<Record<string, unknown>>;
    const response = await handleMembersAdmin(
      request("/admin/members?teamId=team-1"),
      env,
      new URL("https://app.test/admin/members?teamId=team-1"),
    );
    const actual = (await responseData(response)) as Array<
      Record<string, unknown>
    >;
    expect(actual).toEqual(
      expected.map(({ siteIdsJson, ...row }) => ({
        ...row,
        role: toTeamRole(row.role),
        siteIds: JSON.parse(String(siteIdsJson)),
      })),
    );
  });

  it("keeps ownership transfer as one three-statement batch in legacy order", async () => {
    const { database, env, trace } = createFixture({
      previousOwnerRole: "admin",
    });
    const legacy = createFixture({ previousOwnerRole: "admin" });
    const run = legacy.database.prepare.bind(legacy.database);
    legacy.database.exec("BEGIN");
    run(
      "UPDATE teams SET owner_user_id=?,updated_at=unixepoch() WHERE id=?",
    ).run("member-1", "team-1");
    run(
      "INSERT INTO team_members (team_id,user_id,role,joined_at) VALUES (?,?,'owner',unixepoch()) ON CONFLICT(team_id,user_id) DO UPDATE SET role='owner'",
    ).run("team-1", "member-1");
    run(
      "UPDATE team_members SET role='admin' WHERE team_id=? AND user_id=?",
    ).run("team-1", "owner-1");
    legacy.database.exec("COMMIT");

    const response = await handleTeamsAdmin(
      request("/admin/teams", "PATCH", {
        teamId: "team-1",
        intent: "transfer_owner",
        newOwnerUserId: "member-1",
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(trace.batchStatements).toHaveLength(1);
    expect(trace.batchStatements?.[0]).toHaveLength(3);
    expect(trace.batchStatements?.[0]?.[0]).toMatch(/^UPDATE "teams"/);
    expect(trace.batchStatements?.[0]?.[1]).toMatch(
      /^INSERT INTO "team_members".*ON CONFLICT/,
    );
    expect(trace.batchStatements?.[0]?.[2]).toMatch(/^UPDATE "team_members"/);
    const memberStates = (db: DatabaseSync) =>
      db
        .prepare(
          "SELECT user_id AS userId,role,joined_at AS joinedAt FROM team_members WHERE team_id=? ORDER BY user_id",
        )
        .all("team-1");
    expect(memberStates(database)).toEqual(memberStates(legacy.database));
    expect(
      database
        .prepare("SELECT owner_user_id FROM teams WHERE id=?")
        .get("team-1"),
    ).toEqual(
      legacy.database
        .prepare("SELECT owner_user_id FROM teams WHERE id=?")
        .get("team-1"),
    );
    legacy.database.close();
    databases.delete(legacy.database);
  });

  it("preserves the legacy single-owner index failure and rolls back the batch", async () => {
    const { database, env, trace } = createFixture();
    const legacy = createFixture();
    const snapshot = (db: DatabaseSync) => ({
      owner: db
        .prepare("SELECT owner_user_id AS ownerUserId FROM teams WHERE id=?")
        .get("team-1"),
      members: db
        .prepare(
          "SELECT user_id AS userId,role FROM team_members WHERE team_id=? ORDER BY user_id",
        )
        .all("team-1"),
    });
    const expectedBefore = snapshot(legacy.database);
    legacy.database.exec("BEGIN");
    try {
      legacy.database
        .prepare(
          "UPDATE teams SET owner_user_id=?,updated_at=unixepoch() WHERE id=?",
        )
        .run("member-1", "team-1");
      legacy.database
        .prepare(
          "INSERT INTO team_members (team_id,user_id,role,joined_at) VALUES (?,?,'owner',unixepoch()) ON CONFLICT(team_id,user_id) DO UPDATE SET role='owner'",
        )
        .run("team-1", "member-1");
      legacy.database
        .prepare(
          "UPDATE team_members SET role='admin' WHERE team_id=? AND user_id=?",
        )
        .run("team-1", "owner-1");
      legacy.database.exec("COMMIT");
    } catch (error) {
      legacy.database.exec("ROLLBACK");
      expect(error).toBeInstanceOf(Error);
    }
    await expect(
      handleTeamsAdmin(
        request("/admin/teams", "PATCH", {
          teamId: "team-1",
          intent: "transfer_owner",
          newOwnerUserId: "member-1",
        }),
        env,
      ),
    ).rejects.toThrow();
    expect(trace.batchStatements).toHaveLength(1);
    expect(trace.batchStatements?.[0]).toHaveLength(3);
    expect(snapshot(database)).toEqual(expectedBefore);
    expect(snapshot(database)).toEqual(snapshot(legacy.database));
    legacy.database.close();
    databases.delete(legacy.database);
  });

  it("matches simple team create/update and member upsert, update, removal state", async () => {
    const { database, env } = createFixture();
    const legacy = createFixture();
    const teamId = "00000000-0000-4000-8000-000000000701";
    vi.spyOn(crypto, "randomUUID").mockReturnValue(teamId);
    mocks.uniqueTeamSlug.mockResolvedValue("created-team");
    const created = await handleTeamsAdmin(
      request("/admin/teams", "POST", { name: "Created Team" }),
      env,
    );
    expect(created.status).toBe(200);
    expect(
      database
        .prepare("SELECT id,name,slug,owner_user_id FROM teams WHERE id=?")
        .get(teamId),
    ).toEqual({
      id: teamId,
      name: "Created Team",
      slug: "created-team",
      owner_user_id: "owner-1",
    });
    expect(
      database
        .prepare("SELECT role FROM team_members WHERE team_id=? AND user_id=?")
        .get(teamId, "owner-1"),
    ).toEqual({ role: "owner" });
    legacy.database
      .prepare(
        "INSERT INTO teams (id,name,slug,owner_user_id,created_at,updated_at) VALUES (?,?,?,?,unixepoch(),unixepoch())",
      )
      .run(teamId, "Created Team", "created-team", "owner-1");
    legacy.database
      .prepare(
        "INSERT INTO team_members (team_id,user_id,role,joined_at) VALUES (?,?,'owner',unixepoch())",
      )
      .run(teamId, "owner-1");
    expect(
      database.prepare("SELECT * FROM teams WHERE id=?").get(teamId),
    ).toEqual(
      legacy.database.prepare("SELECT * FROM teams WHERE id=?").get(teamId),
    );
    expect(
      database
        .prepare("SELECT * FROM team_members WHERE team_id=? AND user_id=?")
        .get(teamId, "owner-1"),
    ).toEqual(
      legacy.database
        .prepare("SELECT * FROM team_members WHERE team_id=? AND user_id=?")
        .get(teamId, "owner-1"),
    );

    mocks.uniqueTeamSlug.mockResolvedValue("renamed");
    await handleTeamsAdmin(
      request("/admin/teams", "PATCH", {
        teamId: "team-1",
        name: "Renamed",
        slug: "renamed",
      }),
      env,
    );
    expect(
      database
        .prepare(
          "SELECT name,slug,updated_at AS updatedAt FROM teams WHERE id=?",
        )
        .get("team-1"),
    ).toEqual({ name: "Renamed", slug: "renamed", updatedAt: FIXED_TIME });
    legacy.database
      .prepare(
        "UPDATE teams SET name=?,slug=?,updated_at=unixepoch() WHERE id=?",
      )
      .run("Renamed", "renamed", "team-1");
    expect(
      database.prepare("SELECT * FROM teams WHERE id=?").get("team-1"),
    ).toEqual(
      legacy.database.prepare("SELECT * FROM teams WHERE id=?").get("team-1"),
    );

    const ensuredOwner = await handleMembersAdmin(
      request("/admin/members", "POST", {
        teamId: "team-1",
        userId: "owner-1",
      }),
      env,
      new URL("https://app.test/admin/members"),
    );
    expect(ensuredOwner.status).toBe(200);

    await handleMembersAdmin(
      request("/admin/members", "POST", {
        teamId: "team-1",
        userId: "member-2",
        role: "admin",
      }),
      env,
      new URL("https://app.test/admin/members"),
    );
    legacy.database
      .prepare(
        "INSERT INTO team_members (team_id,user_id,role,site_ids_json,joined_at) VALUES (?,?,?, ?,unixepoch()) ON CONFLICT(team_id,user_id) DO UPDATE SET role=excluded.role,site_ids_json=excluded.site_ids_json",
      )
      .run("team-1", "member-2", "admin", "[]");
    expect(
      database
        .prepare(
          "SELECT role,site_ids_json AS siteIdsJson FROM team_members WHERE team_id=? AND user_id=?",
        )
        .get("team-1", "member-2"),
    ).toEqual({ role: "admin", siteIdsJson: "[]" });

    await handleMembersAdmin(
      request("/admin/members", "PATCH", {
        teamId: "team-1",
        userId: "member-2",
        intent: "update_role",
        role: "member",
      }),
      env,
      new URL("https://app.test/admin/members"),
    );
    await handleMembersAdmin(
      request("/admin/members", "PATCH", {
        teamId: "team-1",
        userId: "member-2",
        intent: "update_site_access",
        siteIds: ["site-1"],
      }),
      env,
      new URL("https://app.test/admin/members"),
    );
    expect(
      database
        .prepare(
          "SELECT role,site_ids_json AS siteIdsJson FROM team_members WHERE team_id=? AND user_id=?",
        )
        .get("team-1", "member-2"),
    ).toEqual({ role: "member", siteIdsJson: '["site-1"]' });
    legacy.database
      .prepare("UPDATE team_members SET role=? WHERE team_id=? AND user_id=?")
      .run("member", "team-1", "member-2");
    legacy.database
      .prepare(
        "UPDATE team_members SET site_ids_json=? WHERE team_id=? AND user_id=?",
      )
      .run('["site-1"]', "team-1", "member-2");
    expect(
      database
        .prepare("SELECT * FROM team_members WHERE team_id=? AND user_id=?")
        .get("team-1", "member-2"),
    ).toEqual(
      legacy.database
        .prepare("SELECT * FROM team_members WHERE team_id=? AND user_id=?")
        .get("team-1", "member-2"),
    );

    const ownerMutation = await handleMembersAdmin(
      request("/admin/members", "PATCH", {
        teamId: "team-1",
        userId: "owner-1",
        intent: "update_role",
        role: "member",
      }),
      env,
      new URL("https://app.test/admin/members"),
    );
    expect(ownerMutation.status).toBe(400);

    await handleMembersAdmin(
      request("/admin/members", "PATCH", {
        teamId: "team-1",
        userId: "member-2",
        intent: "remove",
      }),
      env,
      new URL("https://app.test/admin/members"),
    );
    expect(
      database
        .prepare("SELECT 1 FROM team_members WHERE team_id=? AND user_id=?")
        .get("team-1", "member-2"),
    ).toBeUndefined();
    legacy.database
      .prepare("DELETE FROM team_members WHERE team_id=? AND user_id=?")
      .run("team-1", "member-2");
    expect(
      database
        .prepare("SELECT * FROM team_members WHERE team_id=? ORDER BY user_id")
        .all("team-1"),
    ).toEqual(
      legacy.database
        .prepare("SELECT * FROM team_members WHERE team_id=? ORDER BY user_id")
        .all("team-1"),
    );
    const ownerRemoval = await handleMembersAdmin(
      request("/admin/members", "PATCH", {
        teamId: "team-1",
        userId: "owner-1",
        intent: "remove",
      }),
      env,
      new URL("https://app.test/admin/members"),
    );
    expect(ownerRemoval.status).toBe(400);
    legacy.database.close();
    databases.delete(legacy.database);
  });

  it("matches slug checks, site listing and site/domain lookup", async () => {
    const { database, env } = createFixture();
    expect(
      await import("@/lib/edge/admin/sites/handler").then(
        ({ ensurePublicSlugAvailable }) =>
          ensurePublicSlugAvailable(env, "site-one"),
      ),
    ).toBe(false);
    const { ensurePublicSlugAvailable } =
      await import("@/lib/edge/admin/sites/handler");
    expect(await ensurePublicSlugAvailable(env, "site-one", "site-1")).toBe(
      true,
    );
    expect(await ensurePublicSlugAvailable(env, "fresh-slug")).toBe(true);

    const expected = database
      .prepare(
        "SELECT id,team_id AS teamId,name,domain,public_enabled AS publicEnabled,public_slug AS publicSlug,created_at AS createdAt,updated_at AS updatedAt FROM sites WHERE team_id=? ORDER BY created_at DESC",
      )
      .all("team-1");
    const listed = await handleSitesAdmin(
      request("/admin/sites?teamId=team-1"),
      env,
      new URL("https://app.test/admin/sites?teamId=team-1"),
    );
    expect(await responseData(listed)).toEqual(expected);

    mocks.upsertSiteTrackingConfig.mockImplementation(
      async (_env, siteId, input) => ({
        siteId,
        siteDomain: input.siteDomain,
        allowedHostnames: [],
      }),
    );
    const config = await handleSiteConfigAdmin(
      request("/admin/site-config", "POST", { siteId: "site-1", config: {} }),
      env,
      new URL("https://app.test/admin/site-config"),
    );
    expect(config.status).toBe(200);
    expect(mocks.upsertSiteTrackingConfig).toHaveBeenCalledWith(
      env,
      "site-1",
      expect.objectContaining({ siteDomain: "one.example.test" }),
    );
  });

  it("preserves site create, compensation, and update-before-KV ordering", async () => {
    const { database, env, trace } = createFixture();
    const legacy = createFixture();
    const siteId = "00000000-0000-4000-8000-000000000702";
    const siteUuid = vi.spyOn(crypto, "randomUUID").mockReturnValue(siteId);
    mocks.upsertSiteScriptSettings.mockImplementation(async () => {
      expect(
        database.prepare("SELECT domain FROM sites WHERE id=?").get(siteId),
      ).toEqual({ domain: "created.example.test" });
      return {};
    });
    const created = await handleSitesAdmin(
      request("/admin/sites", "POST", {
        teamId: "team-1",
        name: "Created",
        domain: "created.example.test",
      }),
      env,
      new URL("https://app.test/admin/sites"),
    );
    expect(created.status).toBe(200);
    expect(
      database
        .prepare("SELECT team_id,name,domain FROM sites WHERE id=?")
        .get(siteId),
    ).toEqual({
      team_id: "team-1",
      name: "Created",
      domain: "created.example.test",
    });
    legacy.database
      .prepare(
        "INSERT INTO sites (id,team_id,name,domain,public_enabled,public_slug,created_at,updated_at) VALUES (?,?,?,?,?,?,unixepoch(),unixepoch())",
      )
      .run(siteId, "team-1", "Created", "created.example.test", 0, null);
    expect(
      database.prepare("SELECT * FROM sites WHERE id=?").get(siteId),
    ).toEqual(
      legacy.database.prepare("SELECT * FROM sites WHERE id=?").get(siteId),
    );

    const failure = new Error("kv write failed");
    mocks.siteSettingsFailure = failure;
    const compensatedSiteId = "00000000-0000-4000-8000-000000000703";
    siteUuid.mockReturnValue(compensatedSiteId);
    mocks.upsertSiteScriptSettings.mockImplementation(async () => {
      expect(
        database
          .prepare("SELECT domain FROM sites WHERE id=?")
          .get(compensatedSiteId),
      ).toEqual({ domain: "failure.example.test" });
      if (mocks.siteSettingsFailure) throw mocks.siteSettingsFailure;
      return {};
    });
    await expect(
      handleSitesAdmin(
        request("/admin/sites", "POST", {
          teamId: "team-1",
          name: "Failure",
          domain: "failure.example.test",
        }),
        env,
        new URL("https://app.test/admin/sites"),
      ),
    ).rejects.toBe(failure);
    expect(
      database.prepare("SELECT 1 FROM sites WHERE id=?").get(compensatedSiteId),
    ).toBeUndefined();
    legacy.database
      .prepare(
        "INSERT INTO sites (id,team_id,name,domain,public_enabled,public_slug,created_at,updated_at) VALUES (?,?,?,?,?,?,unixepoch(),unixepoch())",
      )
      .run(
        compensatedSiteId,
        "team-1",
        "Failure",
        "failure.example.test",
        0,
        null,
      );
    legacy.database
      .prepare("DELETE FROM sites WHERE id=?")
      .run(compensatedSiteId);
    expect(
      database.prepare("SELECT * FROM sites WHERE id=?").get(compensatedSiteId),
    ).toEqual(
      legacy.database
        .prepare("SELECT * FROM sites WHERE id=?")
        .get(compensatedSiteId),
    );
    expect(trace.preparedSql.at(-1)).toMatch(/^DELETE FROM "sites"/);

    mocks.siteSettingsFailure = null;
    mocks.upsertSiteScriptSettings.mockImplementation(
      async (_env, siteId, input) => {
        expect(siteId).toBe("site-1");
        expect(input.siteDomain).toBe("updated.example.test");
        expect(
          database.prepare("SELECT domain FROM sites WHERE id=?").get(siteId),
        ).toEqual({ domain: "updated.example.test" });
        return {};
      },
    );
    const updated = await handleSitesAdmin(
      request("/admin/sites", "PATCH", {
        siteId: "site-1",
        domain: "updated.example.test",
      }),
      env,
      new URL("https://app.test/admin/sites"),
    );
    expect(updated.status).toBe(200);
    expect(
      database.prepare("SELECT domain FROM sites WHERE id=?").get("site-1"),
    ).toEqual({ domain: "updated.example.test" });
    legacy.database
      .prepare(
        "UPDATE sites SET team_id=?,name=?,domain=?,public_enabled=?,public_slug=?,updated_at=unixepoch() WHERE id=?",
      )
      .run(
        "team-1",
        "Site One",
        "updated.example.test",
        1,
        "site-one",
        "site-1",
      );
    expect(
      database.prepare("SELECT * FROM sites WHERE id=?").get("site-1"),
    ).toEqual(
      legacy.database.prepare("SELECT * FROM sites WHERE id=?").get("site-1"),
    );
    legacy.database.close();
    databases.delete(legacy.database);
  });
});
