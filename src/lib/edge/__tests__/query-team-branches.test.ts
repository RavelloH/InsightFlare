import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { executePrivateTeamDashboard } from "@/lib/edge/analytics/adapters/private";
import {
  badRequest,
  parseWindow,
  resolvePrivateTeam,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import { listTeamSites } from "@/lib/edge/analytics/providers/d1/internal/team";
import type { EdgeSessionClaims } from "@/lib/edge/session-auth";
import type { Env } from "@/lib/edge/types";

const requireSessionMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/edge/session-auth", () => ({
  requireSession: requireSessionMock,
}));

type D1Row = Record<string, unknown>;
type Binding = string | number | null;

interface QueryCall {
  sql: string;
  bindings: Binding[];
  kind: "all" | "first";
}

const NOW = Date.UTC(2026, 4, 25, 12, 0, 0);
const FROM = Date.UTC(2026, 4, 25, 0, 0, 0);
const TO = FROM + 2 * 60 * 60 * 1000;

const adminSession: EdgeSessionClaims = {
  userId: "admin-1",
  username: "admin",
  displayName: "Admin",
  systemRole: "admin",
  exp: 9_999_999_999,
};

const memberSession: EdgeSessionClaims = {
  userId: "user-1",
  username: "member",
  displayName: "Member",
  systemRole: "user",
  exp: 9_999_999_999,
};

function createD1Env(resultSets: D1Row[][], firstRows: Array<D1Row | null>) {
  const calls: QueryCall[] = [];
  const pendingAll = [...resultSets];
  const pendingFirst = [...firstRows];
  const prepare = vi.fn((sql: string) => ({
    bind: vi.fn((...bindings: Binding[]) => ({
      all: vi.fn(async () => {
        calls.push({ kind: "all", sql, bindings });
        return { results: pendingAll.shift() ?? [] };
      }),
      first: vi.fn(async () => {
        calls.push({ kind: "first", sql, bindings });
        return pendingFirst.shift() ?? null;
      }),
    })),
  }));

  return {
    env: {
      DB: { prepare } as unknown as D1Database,
      DAILY_SALT_SECRET: "secret",
      INGEST_DO: {} as DurableObjectNamespace,
    } as Env,
    calls,
    prepare,
  };
}

function url(params: Record<string, string | number>) {
  const parsed = new URL("https://edge.test/api/private/team-dashboard");
  for (const [key, value] of Object.entries(params)) {
    parsed.searchParams.set(key, String(value));
  }
  return parsed;
}

async function handleTeamDashboard(
  request: Request,
  env: Env,
  target: URL,
): Promise<Response> {
  if (!parseWindow(target)) return badRequest("Invalid time window");
  const team = await resolvePrivateTeam(request, env, target);
  if (team instanceof Response) return team;
  return executePrivateTeamDashboard({
    env,
    teamId: team.id,
    allowedSiteIds: team.allowedSiteIds,
    url: target,
  });
}

describe("edge team query low branch coverage", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    requireSessionMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("lists team sites with expected ordering query and bindings", async () => {
    const { env, calls } = createD1Env(
      [
        [
          {
            id: "site-1",
            teamId: "team-1",
            name: "Docs",
            domain: "docs.example",
            publicEnabled: 1,
            publicSlug: "docs",
            createdAt: 20,
            updatedAt: 30,
          },
        ],
      ],
      [],
    );

    await expect(listTeamSites(env, "team-1")).resolves.toEqual([
      {
        id: "site-1",
        teamId: "team-1",
        name: "Docs",
        domain: "docs.example",
        publicEnabled: 1,
        publicSlug: "docs",
        createdAt: 20,
        updatedAt: 30,
      },
    ]);
    expect(calls[0]).toMatchObject({
      kind: "all",
      bindings: ["team-1"],
    });
    expect(calls[0].sql).toContain("ORDER BY created_at DESC");
  });

  it("rejects missing team ids after session validation without querying D1", async () => {
    requireSessionMock.mockResolvedValue(adminSession);
    const { env, prepare } = createD1Env([], []);

    const response = await handleTeamDashboard(
      new Request("https://edge.test/api/private/team-dashboard"),
      env,
      url({ from: FROM, to: TO }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { message: "teamId is required" },
    });
    expect(requireSessionMock).toHaveBeenCalledTimes(1);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("uses membership-aware team resolution for non-admin sessions", async () => {
    requireSessionMock.mockResolvedValue(memberSession);
    const { env, calls } = createD1Env(
      [[]],
      [
        {
          id: "team-1",
          ownerUserId: "owner-1",
          role: "member",
          siteIdsJson: "[]",
        },
      ],
    );

    const response = await handleTeamDashboard(
      new Request("https://edge.test/api/private/team-dashboard"),
      env,
      url({ teamId: " team-1 ", from: FROM, to: TO }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: { sites: [], trend: [] },
    });
    expect(calls[0]).toMatchObject({
      kind: "first",
      bindings: ["user-1", "team-1"],
    });
    expect(calls[0].sql).toContain("LEFT JOIN team_members");
  });

  it("passes through team not found responses before listing sites", async () => {
    requireSessionMock.mockResolvedValue(adminSession);
    const { env, calls } = createD1Env([], [null]);

    const response = await handleTeamDashboard(
      new Request("https://edge.test/api/private/team-dashboard"),
      env,
      url({ teamId: "missing-team", from: FROM, to: TO }),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { message: "Team not found" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      kind: "first",
      bindings: ["missing-team"],
    });
  });

  it("defaults team trend interval to day when interval is omitted", async () => {
    requireSessionMock.mockResolvedValue(adminSession);
    const { env, calls } = createD1Env(
      [
        [
          {
            id: "site-1",
            teamId: "team-1",
            name: "Docs",
            domain: "docs.example",
            publicEnabled: 0,
            publicSlug: null,
            createdAt: 20,
            updatedAt: 30,
          },
        ],
        [],
        [],
        [],
        [],
        [{ siteId: "site-1", bucket: 0, views: 3, visitors: 2 }],
      ],
      [{ id: "team-1" }],
    );

    const response = await handleTeamDashboard(
      new Request("https://edge.test/api/private/team-dashboard"),
      env,
      url({ teamId: "team-1", from: FROM, to: TO }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: {
        sites: [
          {
            id: "site-1",
            overview: { views: 0, sessions: 0, visitors: 0 },
            changeRates: {
              views: null,
              visitors: null,
              sessions: null,
              pagesPerSession: null,
            },
          },
        ],
        trend: [
          {
            bucket: 0,
            timestampMs: FROM,
            sites: [{ siteId: "site-1", views: 3, visitors: 2 }],
          },
        ],
      },
    });
    expect(calls).toHaveLength(7);
    expect(calls[6].sql).toContain(
      `started_at >= ${FROM} AND started_at < ${FROM + 24 * 60 * 60 * 1000}`,
    );
  });
});
