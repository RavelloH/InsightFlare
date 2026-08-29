import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  canAdministerTeam,
  canManageSite,
  canManageTeam,
  canReadSite,
  canReadTeam,
  teamById,
  uniqueTeamSlug,
} from "@/lib/edge/admin-access";
import {
  byId,
  byIdentifier,
  ensureDefaultTeam,
  hashPassword,
  requireActor,
  teamGroupsForSession,
  teamsFor,
  verifyPassword,
} from "@/lib/edge/admin-auth";
import { handleSitesAdmin } from "@/lib/edge/admin-sites";
import {
  handleDoDiagnosticAdmin,
  handleSystemPerformanceAdmin,
} from "@/lib/edge/admin-system";
import { handleMembersAdmin, handleTeamsAdmin } from "@/lib/edge/admin-teams";
import { handleProfileAdmin, handleUsersAdmin } from "@/lib/edge/admin-users";
import {
  deleteSiteScriptSettings,
  readSiteScriptSettings,
  readSiteTrackingConfig,
  upsertSiteScriptSettings,
  upsertSiteTrackingConfig,
} from "@/lib/edge/site-settings-store";
import type { Env } from "@/lib/edge/types";
import { DEFAULT_SITE_SCRIPT_SETTINGS } from "@/lib/site-settings";

vi.mock("@/lib/edge/admin-auth", () => ({
  byId: vi.fn(),
  byIdentifier: vi.fn(),
  ensureDefaultTeam: vi.fn(),
  hashPassword: vi.fn(),
  normE: (s: string) => s.trim().toLowerCase().slice(0, 200),
  normU: (s: string) => s.trim().toLowerCase().slice(0, 80),
  requireActor: vi.fn(),
  teamGroupsForSession: vi.fn(),
  teamsFor: vi.fn(),
  toPublicUser: (u: {
    id: string;
    username: string;
    email: string;
    name: string | null;
    system_role: string;
    timezone: string;
    created_at: number;
    updated_at: number;
  }) => ({
    id: u.id,
    username: u.username,
    email: u.email,
    name: u.name || "",
    systemRole: u.system_role === "admin" ? "admin" : "user",
    timeZone: u.timezone || "",
    createdAt: u.created_at,
    updatedAt: u.updated_at,
  }),
  verifyPassword: vi.fn(),
}));

vi.mock("@/lib/edge/admin-access", () => ({
  canAdministerTeam: vi.fn(),
  canManageSite: vi.fn(),
  canManageTeam: vi.fn(),
  canReadSite: vi.fn(),
  canReadTeam: vi.fn(),
  teamById: vi.fn(),
  toSlug: (value: string) =>
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80),
  uniqueTeamSlug: vi.fn(),
}));

vi.mock("@/lib/edge/site-settings-store", () => ({
  deleteSiteScriptSettings: vi.fn(),
  readSiteTrackingConfig: vi.fn(),
  readSiteScriptSettings: vi.fn(),
  upsertSiteTrackingConfig: vi.fn(),
  upsertSiteScriptSettings: vi.fn(),
}));

type Actor = {
  user: {
    id: string;
    username: string;
    email: string;
    name: string | null;
    password_hash: string | null;
    system_role: string;
    timezone: string;
    created_at: number;
    updated_at: number;
  };
  isAdmin: boolean;
};

interface MockStatement {
  sql?: string;
  bind: ReturnType<typeof vi.fn>;
  first: ReturnType<typeof vi.fn>;
  all: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
}

const actor: Actor = {
  user: {
    id: "actor-1",
    username: "actor",
    email: "actor@example.test",
    name: "Actor",
    password_hash: "hash",
    system_role: "admin",
    timezone: "UTC",
    created_at: 100,
    updated_at: 200,
  },
  isAdmin: true,
};

const userActor: Actor = {
  ...actor,
  isAdmin: false,
  user: {
    ...actor.user,
    id: "member-1",
    username: "member",
    email: "member@example.test",
    system_role: "user",
  },
};

const requireActorMock = vi.mocked(requireActor);
const canAdministerTeamMock = vi.mocked(canAdministerTeam);
const canManageSiteMock = vi.mocked(canManageSite);
const canManageTeamMock = vi.mocked(canManageTeam);
const canReadSiteMock = vi.mocked(canReadSite);
const canReadTeamMock = vi.mocked(canReadTeam);
const teamByIdMock = vi.mocked(teamById);
const uniqueTeamSlugMock = vi.mocked(uniqueTeamSlug);
const byIdMock = vi.mocked(byId);
const byIdentifierMock = vi.mocked(byIdentifier);
const ensureDefaultTeamMock = vi.mocked(ensureDefaultTeam);
const hashPasswordMock = vi.mocked(hashPassword);
const teamGroupsForSessionMock = vi.mocked(teamGroupsForSession);
const teamsForMock = vi.mocked(teamsFor);
const verifyPasswordMock = vi.mocked(verifyPassword);
const deleteSiteScriptSettingsMock = vi.mocked(deleteSiteScriptSettings);
const readSiteTrackingConfigMock = vi.mocked(readSiteTrackingConfig);
const readSiteScriptSettingsMock = vi.mocked(readSiteScriptSettings);
const upsertSiteTrackingConfigMock = vi.mocked(upsertSiteTrackingConfig);
const upsertSiteScriptSettingsMock = vi.mocked(upsertSiteScriptSettings);

function statement(
  input: {
    first?: unknown;
    all?: Record<string, unknown>[];
    run?: unknown;
  } = {},
): MockStatement {
  const stmt = {
    bind: vi.fn(function (this: MockStatement) {
      return this;
    }),
    first: vi.fn().mockResolvedValue("first" in input ? input.first : null),
    all: vi.fn().mockResolvedValue({ results: input.all ?? [] }),
    run: vi.fn().mockResolvedValue(input.run ?? { success: true }),
  } satisfies MockStatement;
  return stmt;
}

function createEnv(statements: MockStatement[] = []): {
  env: Env;
  prepare: ReturnType<typeof vi.fn>;
  batch: ReturnType<typeof vi.fn>;
} {
  let index = 0;
  const prepare = vi.fn((sql: string) => {
    const stmt = statements[index];
    index += 1;
    if (!stmt) {
      throw new Error(`Unexpected SQL #${index}: ${sql}`);
    }
    stmt.sql = sql;
    return stmt;
  });
  const batch = vi.fn().mockResolvedValue([]);
  return {
    env: {
      DB: { prepare, batch } as unknown as D1Database,
      DAILY_SALT_SECRET: "daily-salt",
    } as Env,
    prepare,
    batch,
  };
}

function request(path: string, init?: RequestInit): Request {
  return new Request(`https://edge.test${path}`, init);
}

function jsonInit(
  body: unknown,
  method: "POST" | "PATCH" = "POST",
): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe("admin handler low branches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireActorMock.mockResolvedValue(actor);
    canAdministerTeamMock.mockResolvedValue(true);
    canManageSiteMock.mockResolvedValue(true);
    canManageTeamMock.mockResolvedValue(true);
    canReadSiteMock.mockResolvedValue(true);
    canReadTeamMock.mockResolvedValue(true);
    teamByIdMock.mockResolvedValue({ id: "team-1", ownerUserId: "actor-1" });
    uniqueTeamSlugMock.mockResolvedValue("team-slug");
    byIdMock.mockResolvedValue(actor.user);
    byIdentifierMock.mockResolvedValue(actor.user);
    ensureDefaultTeamMock.mockResolvedValue();
    hashPasswordMock.mockResolvedValue("new-hash");
    teamGroupsForSessionMock.mockResolvedValue({
      teams: [],
      teamGroups: { created: [], managed: [], member: [], system: [] },
    });
    teamsForMock.mockResolvedValue([]);
    verifyPasswordMock.mockResolvedValue(true);
    deleteSiteScriptSettingsMock.mockResolvedValue(undefined);
    readSiteTrackingConfigMock.mockResolvedValue(null);
    readSiteScriptSettingsMock.mockResolvedValue(null);
    upsertSiteTrackingConfigMock.mockResolvedValue({
      siteId: "site-1",
      siteDomain: "example.com",
      allowedHostnames: [],
      ...DEFAULT_SITE_SCRIPT_SETTINGS,
    });
    upsertSiteScriptSettingsMock.mockResolvedValue(
      DEFAULT_SITE_SCRIPT_SETTINGS,
    );
  });

  it("passes through actor responses before users, teams, members, and sites do work", async () => {
    const authResponse = new Response(JSON.stringify({ ok: false }), {
      status: 401,
    });
    requireActorMock.mockResolvedValue(authResponse);
    const env = createEnv();

    await expect(
      handleUsersAdmin(request("/admin/users"), env.env),
    ).resolves.toBe(authResponse);
    await expect(
      handleProfileAdmin(request("/admin/profile"), env.env),
    ).resolves.toBe(authResponse);
    await expect(
      handleTeamsAdmin(request("/admin/teams"), env.env),
    ).resolves.toBe(authResponse);
    await expect(
      handleMembersAdmin(
        request("/admin/members?teamId=team-1"),
        env.env,
        new URL("https://edge.test/admin/members?teamId=team-1"),
      ),
    ).resolves.toBe(authResponse);
    await expect(
      handleSitesAdmin(
        request("/admin/sites?teamId=team-1"),
        env.env,
        new URL("https://edge.test/admin/sites?teamId=team-1"),
      ),
    ).resolves.toBe(authResponse);
    expect(env.prepare).not.toHaveBeenCalled();
  });

  it("lists non-admin teams via memberships and rejects unsupported profile methods", async () => {
    requireActorMock.mockResolvedValue(userActor);
    teamsForMock.mockResolvedValue([{ id: "team-1", membershipRole: "admin" }]);

    const teamsResponse = await handleTeamsAdmin(
      request("/admin/teams", { method: "GET" }),
      createEnv().env,
    );
    await expect(jsonOf(teamsResponse)).resolves.toMatchObject({
      ok: true,
      data: [{ id: "team-1", membershipRole: "admin" }],
    });
    expect(teamsForMock).toHaveBeenCalledWith(expect.anything(), "member-1");

    const profileResponse = await handleProfileAdmin(
      request("/admin/profile", { method: "DELETE" }),
      createEnv().env,
    );
    expect(profileResponse.status).toBe(405);
  });

  it("uses fallback profile values without hashing when no password is supplied", async () => {
    const updateStatement = statement();
    const updatedUser = {
      ...actor.user,
      timezone: "UTC",
      updated_at: 300,
    };
    byIdMock.mockResolvedValueOnce(updatedUser);

    const response = await handleProfileAdmin(
      request(
        "/admin/profile",
        jsonInit({
          name: "Updated Actor",
          timeZone: "UTC",
        }),
      ),
      createEnv([
        statement({ first: null }),
        statement({ first: null }),
        updateStatement,
      ]).env,
    );

    expect(response.status).toBe(200);
    expect(verifyPasswordMock).not.toHaveBeenCalled();
    expect(hashPasswordMock).not.toHaveBeenCalled();
    expect(updateStatement.bind).toHaveBeenCalledWith(
      "actor",
      "actor@example.test",
      "Updated Actor",
      "hash",
      "UTC",
      "",
      "actor-1",
    );
  });

  it("hashes user update passwords and supports deletes after owned-team checks", async () => {
    byIdMock.mockResolvedValueOnce(actor.user);
    const usernameConflict = statement({ first: null });
    const emailConflict = statement({ first: null });
    const updateUser = statement();
    const updated = await handleUsersAdmin(
      request(
        "/admin/users",
        jsonInit({ userId: "target-1", password: "updated-password" }, "PATCH"),
      ),
      createEnv([usernameConflict, emailConflict, updateUser]).env,
    );
    expect(updated.status).toBe(200);
    expect(usernameConflict.bind).toHaveBeenCalledWith("actor", "target-1");
    expect(emailConflict.bind).toHaveBeenCalledWith(
      "actor@example.test",
      "target-1",
    );
    expect(hashPasswordMock).toHaveBeenCalledWith("updated-password");
    expect(updateUser.bind).toHaveBeenCalledWith(
      "actor",
      "actor@example.test",
      "Actor",
      "new-hash",
      "admin",
      "target-1",
    );

    const targetUser = {
      ...actor.user,
      id: "target-1",
      username: "target",
      email: "target@example.test",
    };
    byIdMock.mockResolvedValueOnce(targetUser);
    const ownedTeams = statement({ first: { count: null } });
    const deleteUser = statement();
    const removed = await handleUsersAdmin(
      request(
        "/admin/users",
        jsonInit({ userId: "target-1", intent: "delete" }, "PATCH"),
      ),
      createEnv([ownedTeams, deleteUser]).env,
    );
    expect(removed.status).toBe(200);
    expect(ownedTeams.bind).toHaveBeenCalledWith("target-1");
    expect(deleteUser.bind).toHaveBeenCalledWith("target-1");
    await expect(jsonOf(removed)).resolves.toMatchObject({
      data: { userId: "target-1", removed: true },
    });
  });

  it("rejects short replacement passwords when admins update users", async () => {
    byIdMock.mockResolvedValueOnce(actor.user);
    const usernameConflict = statement({ first: null });
    const emailConflict = statement({ first: null });
    const updateUser = statement();
    const env = createEnv([usernameConflict, emailConflict, updateUser]);

    const response = await handleUsersAdmin(
      request(
        "/admin/users",
        jsonInit({ userId: "target-1", password: "short" }, "PATCH"),
      ),
      env.env,
    );

    expect(response.status).toBe(400);
    await expect(jsonOf(response)).resolves.toMatchObject({
      ok: false,
      error: { message: "Password must be at least 8 characters" },
    });
    expect(env.prepare).not.toHaveBeenCalled();
    expect(hashPasswordMock).not.toHaveBeenCalled();
  });

  it("handles team create slugs, transfer ownership authorization, and no-op delete cleanup", async () => {
    const uuidSpy = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValue("00000000-0000-4000-8000-000000000123");
    const insertTeam = statement();
    const insertMember = statement();

    const created = await handleTeamsAdmin(
      request("/admin/teams", jsonInit({ name: "Analytics Team" })),
      createEnv([insertTeam, insertMember]).env,
    );
    expect(created.status).toBe(200);
    expect(uniqueTeamSlugMock).toHaveBeenCalledWith(
      expect.anything(),
      "analytics-team",
    );
    expect(insertTeam.bind).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000123",
      "Analytics Team",
      "team-slug",
      "actor-1",
    );
    expect(uuidSpy).toHaveBeenCalled();

    canManageTeamMock.mockResolvedValue(true);
    const existingTeam = statement({
      first: {
        id: "team-1",
        name: "Team",
        slug: "team",
        ownerUserId: "other-owner",
        createdAt: 1,
        updatedAt: 2,
      },
    });
    const transfer = await handleTeamsAdmin(
      request(
        "/admin/teams",
        jsonInit(
          {
            teamId: "team-1",
            intent: "transfer_owner",
            newOwnerUserId: "member-1",
          },
          "PATCH",
        ),
      ),
      createEnv([existingTeam]).env,
    );
    expect(transfer.status).toBe(403);
    expect(await jsonOf(transfer)).toMatchObject({
      error: { message: "Only the team owner can transfer ownership" },
    });

    const siteList = statement({ all: [] });
    const deleteTeam = statement();
    const deleted = await handleTeamsAdmin(
      request(
        "/admin/teams",
        jsonInit({ teamId: "team-1", intent: "delete" }, "PATCH"),
      ),
      createEnv([
        statement({
          first: {
            id: "team-1",
            name: "Team",
            slug: "team",
            ownerUserId: "actor-1",
            createdAt: 1,
            updatedAt: 2,
          },
        }),
        siteList,
        deleteTeam,
      ]).env,
    );
    expect(deleted.status).toBe(200);
    expect(deleteSiteScriptSettingsMock).not.toHaveBeenCalled();
    expect(deleteTeam.bind).toHaveBeenCalledWith("team-1");
  });

  it("adds members by identifier with default role and rejects missing member targets", async () => {
    const memberUser = {
      ...actor.user,
      id: "member-2",
      username: "teammate",
      email: "teammate@example.test",
      name: null,
      system_role: "user",
    };
    byIdentifierMock.mockResolvedValueOnce(memberUser);
    const existingRole = statement({ first: null });
    const upsertMember = statement();

    const added = await handleMembersAdmin(
      request(
        "/admin/members",
        jsonInit({ teamId: "team-1", email: "teammate@example.test" }),
      ),
      createEnv([existingRole, upsertMember]).env,
      new URL("https://edge.test/admin/members"),
    );
    expect(added.status).toBe(200);
    expect(byIdentifierMock).toHaveBeenCalledWith(
      expect.anything(),
      "teammate@example.test",
    );
    expect(upsertMember.bind).toHaveBeenCalledWith(
      "team-1",
      "member-2",
      "member",
      "[]",
    );
    await expect(jsonOf(added)).resolves.toMatchObject({
      data: { role: "member", name: "" },
    });

    teamByIdMock.mockResolvedValueOnce(null);
    canManageTeamMock.mockClear();
    const missingTeam = await handleMembersAdmin(
      request(
        "/admin/members",
        jsonInit({ teamId: "missing-team", userId: "member-2" }, "PATCH"),
      ),
      createEnv().env,
      new URL("https://edge.test/admin/members"),
    );
    expect(missingTeam.status).toBe(404);
    expect(canManageTeamMock).not.toHaveBeenCalled();
  });

  it("covers site defaults, public slug fallback, config fallback, and snippet base trimming", async () => {
    const siteUuid = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValue("00000000-0000-4000-8000-000000000456");
    const slugCheck = statement({ first: null });
    const insertSite = statement();

    const created = await handleSitesAdmin(
      request(
        "/admin/sites",
        jsonInit({
          teamId: "team-1",
          name: "Docs Site",
          domain: "docs.example.test",
          publicEnabled: "on",
        }),
      ),
      createEnv([slugCheck, insertSite]).env,
      new URL("https://edge.test/admin/sites"),
    );
    expect(created.status).toBe(200);
    expect(siteUuid).toHaveBeenCalled();
    expect(insertSite.bind).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000456",
      "team-1",
      "Docs Site",
      "docs.example.test",
      1,
      "docs-site",
    );
    expect(upsertSiteScriptSettingsMock).toHaveBeenCalledWith(
      expect.anything(),
      "00000000-0000-4000-8000-000000000456",
      {
        siteDomain: "docs.example.test",
        settings: DEFAULT_SITE_SCRIPT_SETTINGS,
      },
    );

    const existingSite = statement({
      first: {
        id: "site-1",
        teamId: "team-1",
        name: "Docs",
        domain: "docs.example.test",
        publicEnabled: 0,
        publicSlug: null,
      },
    });
    const slugCheckUpdate = statement({ first: null });
    const updateSite = statement();
    const published = await handleSitesAdmin(
      request(
        "/admin/sites",
        jsonInit({ siteId: "site-1", publicEnabled: true }, "PATCH"),
      ),
      createEnv([existingSite, slugCheckUpdate, updateSite]).env,
      new URL("https://edge.test/admin/sites"),
    );
    expect(published.status).toBe(200);
    expect(updateSite.bind).toHaveBeenCalledWith(
      "team-1",
      "Docs",
      "docs.example.test",
      1,
      "docs",
      "site-1",
    );

    const configResponse = await handleSitesAdmin(
      request("/admin/sites?teamId=team-1", { method: "OPTIONS" }),
      createEnv().env,
      new URL("https://edge.test/admin/sites?teamId=team-1"),
    );
    expect(configResponse.status).toBe(405);
  });

  it("returns default site config and builds script snippets from trimmed edge base URLs", async () => {
    const { handleSiteConfigAdmin, handleScriptSnippetAdmin } =
      await import("@/lib/edge/admin-sites");

    readSiteTrackingConfigMock.mockResolvedValueOnce(null);
    const config = await handleSiteConfigAdmin(
      request("/admin/site-config?siteId=site-1", { method: "GET" }),
      createEnv().env,
      new URL("https://edge.test/admin/site-config?siteId=site-1"),
    );
    expect(config.status).toBe(200);
    await expect(jsonOf(config)).resolves.toMatchObject({
      ok: true,
      data: expect.objectContaining(DEFAULT_SITE_SCRIPT_SETTINGS),
    });

    const snippet = await handleScriptSnippetAdmin(
      request("/admin/script-snippet?siteId=site 1", { method: "GET" }),
      createEnv().env,
      new URL("https://edge.test/admin/script-snippet?siteId=site%201"),
    );
    expect(snippet.status).toBe(200);
    await expect(jsonOf(snippet)).resolves.toMatchObject({
      ok: true,
      data: {
        siteId: "site 1",
        src: "https://edge.test/script.js?siteId=site%201",
        snippet:
          '<script defer src="https://edge.test/script.js?siteId=site%201"></script>',
      },
    });
  });

  it("rejects non-admin and unsupported methods before system admin database work", async () => {
    const env = createEnv();
    const nonAdminResolver = vi.fn().mockResolvedValue({ isAdmin: false });
    const adminResolver = vi.fn().mockResolvedValue({ isAdmin: true });
    const performanceUrl = new URL(
      "https://edge.test/admin/system-performance",
    );
    const diagnosticUrl = new URL("https://edge.test/admin/do-diagnostic");

    const performanceForbidden = await handleSystemPerformanceAdmin(
      request("/admin/system-performance", { method: "GET" }),
      env.env,
      performanceUrl,
      nonAdminResolver,
    );
    expect(performanceForbidden.status).toBe(403);
    await expect(jsonOf(performanceForbidden)).resolves.toMatchObject({
      error: { message: "Only system admin can view system performance" },
    });

    const performanceMethod = await handleSystemPerformanceAdmin(
      request("/admin/system-performance", { method: "POST" }),
      env.env,
      performanceUrl,
      adminResolver,
    );
    expect(performanceMethod.status).toBe(405);

    const diagnosticForbidden = await handleDoDiagnosticAdmin(
      request("/admin/do-diagnostic", { method: "GET" }),
      env.env,
      diagnosticUrl,
      nonAdminResolver,
    );
    expect(diagnosticForbidden.status).toBe(403);
    await expect(jsonOf(diagnosticForbidden)).resolves.toMatchObject({
      error: { message: "Only system admin can view DO diagnostics" },
    });

    const diagnosticMethod = await handleDoDiagnosticAdmin(
      request("/admin/do-diagnostic", { method: "POST" }),
      env.env,
      diagnosticUrl,
      adminResolver,
    );
    expect(diagnosticMethod.status).toBe(405);
    expect(env.prepare).not.toHaveBeenCalled();
  });
});
