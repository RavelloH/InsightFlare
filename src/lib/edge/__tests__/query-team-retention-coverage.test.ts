import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleRetentionContract as handleRetention } from "@/lib/edge/query/analysis-contract-adapter";
import {
  badRequest,
  normalizePathname,
  parseWindow,
  resolvePrivateTeam,
} from "@/lib/edge/query/core";
import {
  browserMajorVersionExpr,
  clientDimensionDefinition,
  formatPageLabel,
  referrerDomainDimensionDefinition,
  utmDimensionDefinition,
} from "@/lib/edge/query/core-dimensions";
import {
  parseLimit,
  parseQueryLimit,
  parseSessionListSort,
  parseVisitorListSort,
} from "@/lib/edge/query/core-parsers";
import {
  queryTeamOverviewFromD1,
  queryTeamTrendFromD1,
} from "@/lib/edge/query/team";
import { executePrivateTeamDashboard } from "@/lib/edge/query-adapters/private";
import type { EdgeSessionClaims } from "@/lib/edge/session-auth";
import type { Env } from "@/lib/edge/types";

const requireSessionMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/edge/session-auth", () => ({
  requireSession: requireSessionMock,
}));

type D1Row = Record<string, unknown>;
type QueryBinding = string | number | null;

interface QueryCall {
  kind: "all" | "first";
  sql: string;
  bindings: QueryBinding[];
}

const siteId = "site-team-retention";
const baseMs = Date.UTC(2026, 0, 5, 0);
const window = {
  startMs: baseMs,
  endExclusiveMs: baseMs + 2 * 60 * 60 * 1000,
  nowMs: baseMs + 3 * 60 * 60 * 1000,
  timeZone: "UTC",
};

const adminSession: EdgeSessionClaims = {
  userId: "admin-1",
  username: "admin",
  displayName: "Admin",
  systemRole: "admin",
  exp: 9_999_999_999,
};

function createD1Env(resultSets: D1Row[][], firstRows: D1Row[] = []) {
  const calls: QueryCall[] = [];
  const pendingAll = [...resultSets];
  const pendingFirst = [...firstRows];
  const prepare = vi.fn((sql: string) => ({
    bind: vi.fn((...bindings: QueryBinding[]) => ({
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
      DAILY_SALT_SECRET: "test-secret",
      INGEST_DO: {} as DurableObjectNamespace,
    } as Env,
    calls,
    prepare,
  };
}

function visitBindingsForSites(siteIds: string[]) {
  return [...siteIds, window.startMs, window.endExclusiveMs];
}

function visitBindings(targetWindow = window) {
  return [siteId, targetWindow.startMs, targetWindow.endExclusiveMs];
}

function url(path: string, params: Record<string, string | number | boolean>) {
  const parsed = new URL(`https://edge.test${path}`);
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

describe("edge query core dimension and parser edge coverage", () => {
  it("normalizes page labels and dimension SQL definitions", () => {
    expect(normalizePathname("  ")).toBe("/");
    expect(formatPageLabel(" /docs ", "?q=1", "#intro", false)).toBe("/docs");
    expect(formatPageLabel("", "?q=1", "#intro", true)).toBe("/?q=1#intro");
    expect(browserMajorVersionExpr("v")).toContain("v.browser_version");
    expect(clientDimensionDefinition("operatingSystem", "v")).toEqual({
      labelExpr: "TRIM(COALESCE(v.os, ''))",
      fallbackKeyBase: "os",
    });
    expect(clientDimensionDefinition("screenSize").fallbackKeyBase).toBe(
      "screen",
    );
    expect(utmDimensionDefinition("term", "v")).toEqual({
      labelExpr: "TRIM(COALESCE(v.utm_term, ''))",
      fallbackKeyBase: "utm-term",
    });
    expect(utmDimensionDefinition("content").fallbackKeyBase).toBe(
      "utm-content",
    );
    expect(referrerDomainDimensionDefinition("v").labelExpr).toContain(
      "v.referrer_host",
    );
  });

  it("parses and clamps query inputs defensively", () => {
    expect(parseLimit(url("/x", { limit: 999 }), 10, 25)).toBe(25);
    expect(parseLimit(url("/x", { limit: 0 }), 10, 25)).toBe(10);
    expect(
      parseQueryLimit(url("/x", { pageSize: -10 }), "pageSize", 20, 1, 50),
    ).toBe(1);
    expect(
      parseQueryLimit(url("/x", { pageSize: 100 }), "pageSize", 20, 1, 50),
    ).toBe(50);
    expect(
      parseVisitorListSort(
        url("/x", { sortBy: "firstSeenAt", sortDir: "asc" }),
      ),
    ).toEqual({ key: "firstSeenAt", direction: "asc" });
    expect(parseVisitorListSort(url("/x", { sortBy: "bad" }))).toEqual({
      key: "lastSeenAt",
      direction: "desc",
    });
    expect(
      parseSessionListSort(url("/x", { sortBy: "durationMs", sortDir: "asc" })),
    ).toEqual({ key: "durationMs", direction: "asc" });
  });
});

describe("edge team query coverage", () => {
  beforeEach(() => {
    requireSessionMock.mockReset();
  });

  it("returns empty team aggregates without touching D1 when site IDs are empty", async () => {
    const { env, prepare } = createD1Env([]);

    await expect(queryTeamOverviewFromD1(env, [], window)).resolves.toEqual(
      new Map(),
    );
    await expect(
      queryTeamTrendFromD1(env, [], window, "hour"),
    ).resolves.toEqual([]);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("maps team overview and trend rows with multi-site bindings", async () => {
    const siteIds = ["site-a", "site-b"];
    const { env, calls } = createD1Env([
      [
        {
          siteId: "site-a",
          views: "12",
          sessions: "5",
          visitors: "4",
          bounces: "1",
          totalDuration: "9000",
          durationViews: "3",
        },
      ],
      [
        { siteId: "site-b", bucket: "1", views: "7", visitors: "2" },
        { siteId: null, bucket: null, views: null, visitors: null },
      ],
    ]);

    await expect(
      queryTeamOverviewFromD1(env, siteIds, window),
    ).resolves.toEqual(
      new Map([
        [
          "site-a",
          {
            views: 12,
            sessions: 5,
            visitors: 4,
            bounces: 1,
            totalDuration: 9000,
            durationViews: 3,
          },
        ],
      ]),
    );
    await expect(
      queryTeamTrendFromD1(env, siteIds, window, "hour"),
    ).resolves.toEqual([
      {
        siteId: "",
        bucket: 0,
        timestampMs: baseMs,
        views: 0,
        visitors: 0,
      },
      {
        siteId: "site-b",
        bucket: 1,
        timestampMs: baseMs + 60 * 60 * 1000,
        views: 7,
        visitors: 2,
      },
    ]);

    expect(calls.map((call) => call.bindings)).toEqual([
      visitBindingsForSites(siteIds),
      visitBindingsForSites(siteIds),
    ]);
    expect(calls[0].sql).toContain("WHERE site_id IN (?, ?)");
    expect(calls[1].sql).toContain("ORDER BY bucket ASC, siteId ASC");
  });

  it("materializes the narrow team overview source once", async () => {
    const database = new DatabaseSync(":memory:");
    for (const migration of [
      "migrations/0008_rebuild_analytics.sql",
      "migrations/0013_add_visit_performance_metrics.sql",
    ]) {
      database.exec(readFileSync(migration, "utf8"));
    }
    const calls: Array<{ sql: string; bindings: QueryBinding[] }> = [];
    const env = {
      DB: {
        prepare: (sql: string) => ({
          bind: (...bindings: QueryBinding[]) => {
            const call = { sql, bindings };
            calls.push(call);
            return {
              all: async () => ({
                results: database.prepare(sql).all(...bindings) as D1Row[],
              }),
            };
          },
        }),
      } as unknown as D1Database,
    } as Env;
    const insert = database.prepare(`
      INSERT INTO visits (
        visit_id, site_id, visitor_id, session_id, status, started_at,
        last_activity_at, pathname, hostname, duration_ms
      ) VALUES (?, ?, ?, ?, 'closed', ?, ?, '/', 'example.test', ?)
    `);

    try {
      insert.run(
        "site-a-first",
        "site-a",
        "visitor-a",
        "session-a",
        baseMs,
        baseMs,
        20,
      );
      insert.run(
        "site-a-last",
        "site-a",
        "visitor-a",
        "session-a",
        baseMs + 1,
        baseMs + 1,
        30,
      );
      insert.run(
        "site-b-only",
        "site-b",
        "visitor-b",
        "session-b",
        baseMs + 2,
        baseMs + 2,
        40,
      );
      insert.run(
        "outside-window",
        "site-a",
        "visitor-out",
        "session-out",
        window.endExclusiveMs,
        window.endExclusiveMs,
        999,
      );

      await expect(
        queryTeamOverviewFromD1(env, ["site-a", "site-b"], window),
      ).resolves.toEqual(
        new Map([
          [
            "site-a",
            {
              views: 2,
              sessions: 1,
              visitors: 1,
              bounces: 0,
              totalDuration: 50,
              durationViews: 2,
            },
          ],
          [
            "site-b",
            {
              views: 1,
              sessions: 1,
              visitors: 1,
              bounces: 1,
              totalDuration: 40,
              durationViews: 1,
            },
          ],
        ]),
      );

      expect(calls).toHaveLength(1);
      expect(calls[0]?.sql).toContain("visit_source AS MATERIALIZED");
      expect(calls[0]?.sql).toContain(
        "SELECT site_id, visitor_id, session_id, duration_ms",
      );
      const plan = database
        .prepare(`EXPLAIN QUERY PLAN ${calls[0]?.sql ?? "SELECT 1"}`)
        .all(...(calls[0]?.bindings ?? [])) as Array<{ detail: string }>;
      expect(
        plan.filter((row) => row.detail.includes("SEARCH visits USING INDEX")),
      ).toHaveLength(1);
      expect(
        plan.some((row) => row.detail.includes("idx_visits_site_started_at")),
      ).toBe(true);
    } finally {
      database.close();
    }
  });

  it("splits large team overview queries before D1 reaches 100 bindings", async () => {
    const siteIds = Array.from({ length: 99 }, (_, index) => `site-${index}`);
    const { env, calls } = createD1Env([
      [{ siteId: "site-0", views: 1, sessions: 1, visitors: 1 }],
      [{ siteId: "site-98", views: 2, sessions: 2, visitors: 2 }],
    ]);

    const rows = await queryTeamOverviewFromD1(env, siteIds, window);

    expect(rows.get("site-0")?.views).toBe(1);
    expect(rows.get("site-98")?.views).toBe(2);
    expect(calls).toHaveLength(2);
    expect(calls[0].bindings).toHaveLength(100);
    expect(calls[1].bindings).toHaveLength(3);
  });

  it("shapes team dashboard payloads with previous comparisons and grouped trends", async () => {
    requireSessionMock.mockResolvedValue(adminSession);
    const { env, calls } = createD1Env(
      [
        [
          {
            id: "site-a",
            teamId: "team-1",
            name: "Alpha",
            domain: "alpha.example",
            publicEnabled: 1,
            publicSlug: "alpha",
            createdAt: 10,
            updatedAt: 20,
          },
          {
            id: "site-b",
            teamId: "team-1",
            name: "Beta",
            domain: "beta.example",
            publicEnabled: 0,
            publicSlug: null,
            createdAt: 8,
            updatedAt: 18,
          },
        ],
        [],
        [],
        [
          {
            siteId: "site-a",
            views: 10,
            sessions: 5,
            visitors: 4,
            bounces: 1,
            totalDuration: 20000,
            durationViews: 5,
          },
        ],
        [
          {
            siteId: "site-a",
            views: 5,
            sessions: 5,
            visitors: 2,
            bounces: 2,
            totalDuration: 5000,
            durationViews: 5,
          },
        ],
        [
          { siteId: "site-b", bucket: 1, views: 3, visitors: 2 },
          { siteId: "site-a", bucket: 0, views: 6, visitors: 3 },
        ],
      ],
      [{ id: "team-1" }],
    );

    const response = await handleTeamDashboard(
      new Request("https://edge.test/api/private/team-dashboard"),
      env,
      url("/api/private/team-dashboard", {
        teamId: "team-1",
        from: window.startMs,
        to: window.endExclusiveMs,
        interval: "hour",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: {
        sites: [
          {
            id: "site-a",
            overview: {
              views: 10,
              sessions: 5,
              visitors: 4,
              bounces: 1,
              totalDurationMs: 20000,
              avgDurationMs: 4000,
              bounceRate: 0.2,
            },
            changeRates: {
              views: 100,
              visitors: 100,
              sessions: 0,
              bounceRate: -50,
              avgDurationMs: 300,
              pagesPerSession: 100,
            },
          },
          {
            id: "site-b",
            overview: {
              views: 0,
              sessions: 0,
              visitors: 0,
            },
            changeRates: {
              views: null,
              visitors: null,
              sessions: null,
            },
          },
        ],
        trend: [
          {
            bucket: 0,
            timestampMs: window.startMs,
            sites: [{ siteId: "site-a", views: 6, visitors: 3 }],
          },
          {
            bucket: 1,
            timestampMs: window.startMs + 60 * 60 * 1000,
            sites: [{ siteId: "site-b", views: 3, visitors: 2 }],
          },
        ],
      },
    });
    expect(calls[0]).toMatchObject({
      kind: "first",
      bindings: ["team-1"],
    });
    expect(calls[1]).toMatchObject({
      kind: "all",
      bindings: ["team-1"],
    });
    expect(calls[2]).toMatchObject({
      kind: "all",
      bindings: ["site-a", "site-b"],
    });
    expect(calls[3]).toMatchObject({
      kind: "all",
      bindings: ["site-a", "site-b"],
    });
    expect(calls[4]).toMatchObject({
      kind: "all",
      bindings: ["site-a", "site-b", window.startMs, window.endExclusiveMs],
    });
    expect(calls[5]).toMatchObject({
      kind: "all",
      bindings: [
        "site-a",
        "site-b",
        window.startMs - (window.endExclusiveMs - window.startMs),
        window.startMs,
      ],
    });
    expect(calls[6]).toMatchObject({
      kind: "all",
    });
    expect(calls[6].bindings.slice(0, 4)).toEqual([
      "site-a",
      "site-b",
      window.startMs,
      window.endExclusiveMs,
    ]);
  });

  it("rejects invalid team dashboard windows before auth or database access", async () => {
    const { env, prepare } = createD1Env([]);

    const response = await handleTeamDashboard(
      new Request("https://edge.test/api/private/team-dashboard"),
      env,
      url("/api/private/team-dashboard", {
        teamId: "team-1",
        from: "bad",
        to: window.endExclusiveMs,
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { message: "Invalid time window" },
    });
    expect(requireSessionMock).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it("passes through private team resolution failures without querying sites", async () => {
    requireSessionMock.mockResolvedValue(null);
    const { env, prepare } = createD1Env([]);

    const response = await handleTeamDashboard(
      new Request("https://edge.test/api/private/team-dashboard"),
      env,
      url("/api/private/team-dashboard", {
        teamId: "team-1",
        from: window.startMs,
        to: window.endExclusiveMs,
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { message: "Unauthorized" },
    });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("returns an empty team dashboard when the resolved team has no sites", async () => {
    requireSessionMock.mockResolvedValue(adminSession);
    const { env, calls } = createD1Env([[]], [{ id: "team-empty" }]);

    const response = await handleTeamDashboard(
      new Request("https://edge.test/api/private/team-dashboard"),
      env,
      url("/api/private/team-dashboard", {
        teamId: "team-empty",
        from: window.startMs,
        to: window.endExclusiveMs,
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: {
        sites: [],
        trend: [],
      },
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      kind: "first",
      bindings: ["team-empty"],
    });
    expect(calls[1]).toMatchObject({
      kind: "all",
      bindings: ["team-empty"],
    });
  });

  it("propagates database errors from team site listing", async () => {
    requireSessionMock.mockResolvedValue(adminSession);
    const failingEnv = {
      DB: {
        prepare: vi
          .fn()
          .mockReturnValueOnce({
            bind: vi.fn().mockReturnValue({
              first: vi.fn().mockResolvedValue({ id: "team-1" }),
            }),
          })
          .mockReturnValueOnce({
            bind: vi.fn().mockReturnValue({
              all: vi.fn().mockRejectedValue(new Error("sites unavailable")),
            }),
          }),
      } as unknown as D1Database,
      DAILY_SALT_SECRET: "test-secret",
      INGEST_DO: {} as DurableObjectNamespace,
    } as Env;

    const response = await handleTeamDashboard(
      new Request("https://edge.test/api/private/team-dashboard"),
      failingEnv,
      url("/api/private/team-dashboard", {
        teamId: "team-1",
        from: window.startMs,
        to: window.endExclusiveMs,
      }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "internal" },
    });
  });
});

describe("edge journey retention coverage", () => {
  it("rejects invalid retention windows before querying D1", async () => {
    const { env, prepare } = createD1Env([]);

    const response = await handleRetention(
      env,
      siteId,
      new URL("https://edge.test/retention?from=20&to=10"),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { message: "Invalid time window" },
    });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("maps cohort periods, zero-size rates, fallback granularity, and filters", async () => {
    const { env, calls } = createD1Env([
      [
        { cohortBucket: 0, visitBucket: 0, visitors: 4 },
        { cohortBucket: 0, visitBucket: 1, visitors: 2 },
        { cohortBucket: 2, visitBucket: 3, visitors: 1 },
      ],
    ]);

    const response = await handleRetention(
      env,
      siteId,
      url("/retention", {
        from: window.startMs,
        to: window.endExclusiveMs,
        granularity: "bad",
        "filter[geo.country]": "US",
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      granularity: "week",
      cohorts: [
        {
          bucket: window.startMs,
          size: 4,
          periods: [
            { index: 0, visitors: 4, rate: 1 },
            { index: 1, visitors: 2, rate: 0.5 },
          ],
        },
        {
          bucket: 0,
          size: 0,
          periods: [{ index: 1, visitors: 1, rate: 0 }],
        },
      ],
    });
    expect(calls[0].sql).toContain("MIN(bucket) AS cohort_bucket");
    expect(calls[0].bindings).toEqual([...visitBindings(), "us"]);
  });

  it("materializes retention visits once while preserving cohort results", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(
      readFileSync("migrations/0008_rebuild_analytics.sql", "utf8"),
    );
    database.exec(
      readFileSync("migrations/0013_add_visit_performance_metrics.sql", "utf8"),
    );
    const calls: Array<{ sql: string; bindings: QueryBinding[] }> = [];
    const env = {
      DB: {
        prepare: (sql: string) => ({
          bind: (...bindings: QueryBinding[]) => {
            calls.push({ sql, bindings });
            return {
              all: async () => ({
                results: database.prepare(sql).all(...bindings) as D1Row[],
              }),
            };
          },
        }),
      } as unknown as D1Database,
    } as Env;
    const insert = database.prepare(`
      INSERT INTO visits (
        visit_id, site_id, visitor_id, session_id, status, started_at,
        last_activity_at, pathname, hostname
      ) VALUES (?, ?, ?, ?, 'closed', ?, ?, '/', 'example.test')
    `);

    try {
      insert.run(
        "visitor-a-first",
        siteId,
        "visitor-a",
        "session-a",
        baseMs + 1,
        baseMs + 1,
      );
      insert.run(
        "visitor-a-return",
        siteId,
        "visitor-a",
        "session-b",
        baseMs + 60 * 60 * 1000 + 1,
        baseMs + 60 * 60 * 1000 + 1,
      );
      insert.run(
        "visitor-b-first",
        siteId,
        "visitor-b",
        "session-c",
        baseMs + 60 * 60 * 1000 + 2,
        baseMs + 60 * 60 * 1000 + 2,
      );
      insert.run(
        "outside-window",
        siteId,
        "visitor-outside",
        "session-d",
        window.endExclusiveMs,
        window.endExclusiveMs,
      );

      const response = await handleRetention(
        env,
        siteId,
        url("/retention", {
          from: window.startMs,
          to: window.endExclusiveMs,
          granularity: "hour",
        }),
      );
      await expect(response.json()).resolves.toEqual({
        ok: true,
        granularity: "hour",
        cohorts: [
          {
            bucket: baseMs,
            size: 1,
            periods: [
              { index: 0, visitors: 1, rate: 1 },
              { index: 1, visitors: 1, rate: 1 },
            ],
          },
          {
            bucket: baseMs + 60 * 60 * 1000,
            size: 1,
            periods: [{ index: 0, visitors: 1, rate: 1 }],
          },
        ],
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]?.sql).toContain("filtered_visits AS MATERIALIZED");
      const plan = database
        .prepare(`EXPLAIN QUERY PLAN ${calls[0]?.sql ?? "SELECT 1"}`)
        .all(...(calls[0]?.bindings ?? [])) as Array<{ detail: string }>;
      expect(
        plan.filter((row) => row.detail.includes("SEARCH visits USING")),
      ).toHaveLength(1);
      expect(
        plan.some((row) => row.detail.includes("idx_visits_site_started_at")),
      ).toBe(true);
    } finally {
      database.close();
    }
  });

  it("accepts interval as granularity and normalizes sparse cohort rows", async () => {
    const { env } = createD1Env([
      [
        { cohortBucket: null, visitBucket: undefined, visitors: null },
        { cohortBucket: 3, visitBucket: 1, visitors: 2 },
      ],
    ]);

    const response = await handleRetention(
      env,
      siteId,
      url("/retention", {
        from: window.startMs,
        to: window.endExclusiveMs,
        interval: "day",
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      granularity: "day",
      cohorts: [
        {
          bucket: window.startMs,
          size: 0,
          periods: [{ index: 0, visitors: 0, rate: 0 }],
        },
        {
          bucket: 0,
          size: 0,
          periods: [{ index: 0, visitors: 2, rate: 0 }],
        },
      ],
    });
  });

  it("defaults retention granularity to week when no interval is provided", async () => {
    const { env } = createD1Env([[]]);

    const response = await handleRetention(
      env,
      siteId,
      url("/retention", {
        from: window.startMs,
        to: window.endExclusiveMs,
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      granularity: "week",
      cohorts: [],
    });
  });
});
