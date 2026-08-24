import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "@/lib/edge/types";

vi.mock("@/lib/edge/hourly-rollup", () => ({
  queryOverviewAndTrendForSitesFromHourlyRollupsPartial: vi.fn(),
  queryOverviewForSitesFromHourlyRollupsPartial: vi.fn(),
  queryTrendForSitesFromHourlyRollupsPartial: vi.fn(),
}));

vi.mock("@/lib/edge/analytics/providers/d1/internal/core", () => ({
  badRequest: vi.fn(
    (msg: string) =>
      new Response(JSON.stringify({ ok: false, error: msg }), { status: 400 }),
  ),
  buildTimeBuckets: vi.fn(() => ({ buckets: [1, 2, 3], interval: "day" })),
  buildVisitSourceCteForSites: vi.fn(() => "visit_source AS (...)"),
  jsonResponseWith: vi.fn(
    (
      _ctx: unknown,
      data: unknown,
      status = 200,
      headers?: Record<string, string>,
    ) => new Response(JSON.stringify(data), { status, headers }),
  ),
  mapOverviewAggregate: vi.fn((row: Record<string, unknown>) => ({
    views: Number(row.views ?? 0),
    sessions: Number(row.sessions ?? 0),
    visitors: Number(row.visitors ?? 0),
    bounceRate: 0,
    avgDurationMs: 0,
    totalDuration: Number(row.totalDuration ?? 0),
    durationViews: Number(row.durationViews ?? 0),
  })),
  parseInterval: vi.fn(() => "day"),
  parseWindow: vi.fn(),
  percentChange: vi.fn((current: number, previous: number) =>
    previous > 0 ? ((current - previous) / previous) * 100 : null,
  ),
  PRIVATE_CACHE_HEADERS: { "cache-control": "private, max-age=60" },
  queryD1All: vi.fn(),
  resolvePrivateTeam: vi.fn(),
  resolvePrivateTeamForSession: vi.fn(),
  timeBucketCase: vi.fn(() => ({ sql: "CASE ...", bindings: [] })),
  timeBucketTimestamp: vi.fn(
    (_buckets: unknown, bucket: number) => bucket * 86400000,
  ),
  visitSourceBindingsForSites: vi.fn(() => []),
}));

import { executePrivateTeamDashboard } from "@/lib/edge/analytics/adapters/private";
import {
  badRequest,
  parseWindow,
  queryD1All,
  resolvePrivateTeam,
  resolvePrivateTeamForSession,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  listTeamSites,
  queryTeamOverviewFromD1,
  queryTeamTrendFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/team";
import {
  queryOverviewAndTrendForSitesFromHourlyRollupsPartial,
  queryOverviewForSitesFromHourlyRollupsPartial,
  queryTrendForSitesFromHourlyRollupsPartial,
} from "@/lib/edge/hourly-rollup";

const queryOverviewMock = vi.mocked(
  queryOverviewForSitesFromHourlyRollupsPartial,
);
const queryTrendMock = vi.mocked(queryTrendForSitesFromHourlyRollupsPartial);
const queryOverviewAndTrendMock = vi.mocked(
  queryOverviewAndTrendForSitesFromHourlyRollupsPartial,
);
const parseWindowMock = vi.mocked(parseWindow);
const resolvePrivateTeamMock = vi.mocked(resolvePrivateTeam);
const resolvePrivateTeamForSessionMock = vi.mocked(
  resolvePrivateTeamForSession,
);
const queryD1AllMock = vi.mocked(queryD1All);

function makeDbMock() {
  return {
    prepare: vi.fn().mockReturnThis(),
    bind: vi.fn().mockReturnThis(),
    all: vi.fn().mockResolvedValue({ results: [] }),
    first: vi.fn().mockResolvedValue(null),
    run: vi.fn(),
    batch: vi.fn(),
  };
}

function makeEnv(results: Record<string, unknown>[] = []): Env {
  const db = makeDbMock();
  db.all.mockResolvedValue({ results });
  return { DB: db } as unknown as Env;
}

function makeWindow(startMs = 1000, endExclusiveMs = 2000) {
  return { startMs, endExclusiveMs, nowMs: 3000, timeZone: "UTC" };
}

function makeUrl(path: string, params?: Record<string, string>): URL {
  const url = new URL(`https://app.test${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }
  return url;
}

async function handleTeamDashboard(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (!parseWindow(url)) return badRequest("Invalid time window");
  const team = await resolvePrivateTeam(request, env, url);
  if (team instanceof Response) return team;
  return executePrivateTeamDashboard({
    env,
    teamId: team.id,
    allowedSiteIds: team.allowedSiteIds,
    url,
  });
}

async function handleTeamDashboardForSession(
  request: Request,
  env: Env,
  url: URL,
  session: Parameters<typeof resolvePrivateTeamForSession>[3],
): Promise<Response> {
  if (!parseWindow(url)) return badRequest("Invalid time window");
  const team = await resolvePrivateTeamForSession(request, env, url, session);
  if (team instanceof Response) return team;
  return executePrivateTeamDashboard({
    env,
    teamId: team.id,
    allowedSiteIds: team.allowedSiteIds,
    url,
  });
}

function handleTeamDashboardForTeam(
  env: Env,
  url: URL,
  teamId: string,
  _window: ReturnType<typeof parseWindow> extends infer Window
    ? Exclude<Window, null>
    : never,
  allowedSiteIds?: string[],
): Promise<Response> {
  return executePrivateTeamDashboard({
    env,
    teamId,
    allowedSiteIds: allowedSiteIds ?? [],
    url,
  });
}

describe("queryTeamOverviewFromD1", () => {
  it("returns empty Map for empty siteIds", async () => {
    const env = makeEnv();
    const result = await queryTeamOverviewFromD1(env, [], makeWindow());
    expect(result.size).toBe(0);
  });

  it("returns overview data per site", async () => {
    queryD1AllMock.mockResolvedValueOnce([
      {
        siteId: "s1",
        views: 100,
        sessions: 50,
        visitors: 30,
        bounces: 10,
        totalDuration: 5000,
        durationViews: 40,
      },
    ]);
    const env = makeEnv();
    const result = await queryTeamOverviewFromD1(env, ["s1"], makeWindow());
    expect(result.get("s1")?.views).toBe(100);
    expect(result.get("s1")?.sessions).toBe(50);
  });
});

describe("queryTeamTrendFromD1", () => {
  it("returns empty array for empty siteIds", async () => {
    const env = makeEnv();
    const result = await queryTeamTrendFromD1(env, [], makeWindow(), "day");
    expect(result).toEqual([]);
  });
});

describe("listTeamSites", () => {
  it("returns sites for a team", async () => {
    const db = makeDbMock();
    db.all.mockResolvedValue({
      results: [
        {
          id: "s1",
          teamId: "t1",
          name: "Site 1",
          domain: "example.com",
          publicEnabled: 1,
          publicSlug: "s1",
          createdAt: 1000,
          updatedAt: 2000,
        },
      ],
    });
    const env = { DB: db } as unknown as Env;

    const sites = await listTeamSites(env, "t1");
    expect(sites).toHaveLength(1);
    expect(sites[0].id).toBe("s1");
  });
});

describe("handleTeamDashboard", () => {
  beforeEach(() => {
    parseWindowMock.mockReset();
    resolvePrivateTeamMock.mockReset();
    resolvePrivateTeamForSessionMock.mockReset();
    queryOverviewMock.mockReset();
    queryTrendMock.mockReset();
    queryOverviewAndTrendMock.mockReset();
    queryOverviewAndTrendMock.mockResolvedValue({
      overview: new Map(),
      trend: new Map(),
    });
    queryD1AllMock.mockReset();
    queryD1AllMock.mockResolvedValue([]);
  });

  it("returns badRequest for invalid window", async () => {
    parseWindowMock.mockReturnValue(null);
    const req = new Request("https://app.test/api/private/team-dashboard");
    const env = makeEnv();
    const url = makeUrl("/api/private/team-dashboard");

    const response = await handleTeamDashboard(req, env, url);
    expect(response.status).toBe(400);
  });

  it("returns response when resolvePrivateTeam returns a Response", async () => {
    parseWindowMock.mockReturnValue(makeWindow());
    resolvePrivateTeamMock.mockResolvedValue(
      new Response("unauthorized", { status: 401 }),
    );
    const req = new Request("https://app.test/api/private/team-dashboard");
    const env = makeEnv();
    const url = makeUrl("/api/private/team-dashboard");

    const response = await handleTeamDashboard(req, env, url);
    expect(response.status).toBe(401);
  });

  it("reuses pre-authenticated session claims", async () => {
    parseWindowMock.mockReturnValue(makeWindow());
    resolvePrivateTeamForSessionMock.mockResolvedValue(
      new Response("denied", { status: 403 }),
    );
    const req = new Request("https://app.test/api/private/team-dashboard");
    const env = makeEnv();
    const url = makeUrl("/api/private/team-dashboard", { teamId: "team-1" });
    const session = {
      userId: "user-1",
      username: "user",
      displayName: "User",
      systemRole: "user" as const,
      exp: 9999999999,
    };

    const response = await handleTeamDashboardForSession(
      req,
      env,
      url,
      session,
    );

    expect(response.status).toBe(403);
    expect(resolvePrivateTeamForSessionMock).toHaveBeenCalledWith(
      req,
      env,
      url,
      session,
    );
    expect(resolvePrivateTeamMock).not.toHaveBeenCalled();
  });
});

describe("handleTeamDashboardForTeam", () => {
  beforeEach(() => {
    queryOverviewMock.mockReset();
    queryTrendMock.mockReset();
    queryOverviewAndTrendMock.mockReset();
    queryOverviewAndTrendMock.mockResolvedValue({
      overview: new Map(),
      trend: new Map(),
    });
    queryD1AllMock.mockReset();
    queryD1AllMock.mockResolvedValue([]);
  });

  it("returns empty data when team has no sites", async () => {
    const env = makeEnv([]);
    const url = makeUrl("/api/private/team-dashboard");
    const window = makeWindow();

    const response = await handleTeamDashboardForTeam(
      env,
      url,
      "team-1",
      window,
    );
    const body = (await response.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.data.sites).toEqual([]);
    expect(body.data.trend).toEqual([]);
  });

  it("filters sites by allowedSiteIds", async () => {
    const db = makeDbMock();
    db.all.mockResolvedValue({
      results: [
        {
          id: "s1",
          teamId: "t1",
          name: "Site 1",
          domain: "a.com",
          publicEnabled: 1,
          publicSlug: "s1",
          createdAt: 1000,
          updatedAt: 2000,
        },
        {
          id: "s2",
          teamId: "t1",
          name: "Site 2",
          domain: "b.com",
          publicEnabled: 1,
          publicSlug: "s2",
          createdAt: 1000,
          updatedAt: 2000,
        },
      ],
    });
    const env = { DB: db } as unknown as Env;
    queryOverviewMock.mockResolvedValue(new Map());
    queryTrendMock.mockResolvedValue(new Map());
    const url = makeUrl("/api/private/team-dashboard");
    const window = makeWindow();

    const response = await handleTeamDashboardForTeam(
      env,
      url,
      "team-1",
      window,
      ["s1"],
    );
    const body = (await response.json()) as any;
    expect(body.data.sites).toHaveLength(1);
    expect(body.data.sites[0].id).toBe("s1");
  });

  it("falls back to D1 when rollup returns null", async () => {
    const db = makeDbMock();
    db.all.mockResolvedValue({
      results: [
        {
          id: "s1",
          teamId: "t1",
          name: "Site 1",
          domain: "a.com",
          publicEnabled: 1,
          publicSlug: "s1",
          createdAt: 1000,
          updatedAt: 2000,
        },
      ],
    });
    const env = { DB: db } as unknown as Env;
    queryOverviewMock.mockResolvedValue(new Map());
    queryTrendMock.mockResolvedValue(null);
    queryD1AllMock.mockResolvedValue([]);
    const url = makeUrl("/api/private/team-dashboard");
    const window = makeWindow();

    const response = await handleTeamDashboardForTeam(
      env,
      url,
      "team-1",
      window,
    );
    expect(response.status).toBe(200);
  });
});
