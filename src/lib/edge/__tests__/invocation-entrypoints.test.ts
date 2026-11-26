import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as PrivateDashboardModule from "@/lib/edge/analytics/interfaces/dashboard/private";
import type { InvocationMetricsPoint } from "@/lib/edge/analytics-engine/invocation-schema";
import type * as SiteAccessModule from "@/lib/edge/auth/site-access";
import type { Env } from "@/lib/edge/types";
import type { AppEnv } from "@/lib/hono/types";

vi.mock("@tanstack/react-start/server-entry", () => ({
  default: {
    fetch: vi.fn(async () => new Response("page response")),
  },
}));
vi.mock("@/middleware", () => ({
  localeCookie: vi.fn(() => "if_locale=en"),
  resolvePageRequest: vi.fn(async () => ({ response: null, locale: null })),
}));
vi.mock("@/lib/hono/app", async () => {
  const { Hono } = await import("hono");
  const { observabilityMiddleware } =
    await import("@/lib/hono/middleware/observability");
  const app = new Hono<AppEnv>();
  app.use("*", observabilityMiddleware());
  app.all("/api/*", (c) => c.text("api"));
  return {
    default: {
      fetch: vi.fn((request: Request, env: Env, ctx: ExecutionContext) =>
        app.fetch(request, env, ctx),
      ),
    },
  };
});
vi.mock("@/lib/edge/scheduled-tasks/dispatcher", () => ({
  dispatchInternalScheduledTasks: vi.fn(async () => {}),
}));
vi.mock("@/lib/edge/ingest/alarm-sweep", () => ({
  sweepIngestAlarms: vi.fn(async () => {}),
}));

vi.mock("@/lib/edge/auth/site-access", async (importOriginal) => ({
  ...(await importOriginal<typeof SiteAccessModule>()),
  resolvePrivateSite: vi.fn(),
}));
vi.mock(
  "@/lib/edge/analytics/interfaces/dashboard/private",
  async (importOriginal) => ({
    ...(await importOriginal<typeof PrivateDashboardModule>()),
    executePrivateQuery: vi.fn(),
    executePrivateTeamDashboard: vi.fn(),
  }),
);
const { readCachedSidebarTeamDashboard, startSiteAnalyticsStream } =
  await import("@/lib/dashboard/server/query");
const { resolvePrivateSite } = await import("@/lib/edge/auth/site-access");
const { executePrivateQuery, executePrivateTeamDashboard } =
  await import("@/lib/edge/analytics/interfaces/dashboard/private");
const { default: server } = await import("@/server");
const { default: startHandler } =
  await import("@tanstack/react-start/server-entry");
const { resolvePageRequest } = await import("@/middleware");
const { default: apiApp } = await import("@/lib/hono/app");
const { dispatchInternalScheduledTasks } =
  await import("@/lib/edge/scheduled-tasks/dispatcher");

function setup() {
  const points: InvocationMetricsPoint[] = [];
  const work: Promise<unknown>[] = [];
  const env = {
    DB: {} as D1Database,
    INGEST_DO: {} as DurableObjectNamespace,
    MAIN_SECRET: "test-secret",
    INVOCATION_METRICS: {
      writeDataPoint: vi.fn((point: InvocationMetricsPoint) =>
        points.push(point),
      ),
    },
  } as Env;
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => {
      work.push(promise);
    },
    passThroughOnException: () => {},
  } as ExecutionContext;
  const finish = async () => {
    while (work.length) await Promise.all(work.splice(0));
  };
  return { points, env, ctx, work, finish };
}

describe("actual Worker top-level invocation entrypoints", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("shares the HTTP team dashboard cache only with the exact authenticated audience and site ACL", async () => {
    const f = setup();
    const { withDashboardCache } =
      await import("@/lib/edge/analytics/composition/dashboard-cache");
    const entries = new Map<string, Response>();
    vi.stubGlobal("caches", {
      open: async () => ({
        match: async (request: Request) => entries.get(request.url)?.clone(),
        put: async (request: Request, response: Response) => {
          entries.set(request.url, response.clone());
        },
      }),
    });
    const window = {
      preset: "custom" as const,
      from: 100,
      to: 300,
      interval: "day" as const,
      timeZone: "UTC",
    };
    const resolved = {
      env: f.env,
      request: new Request("https://app.test/en/app/team/site"),
      session: { userId: "user-a" } as never,
      teamId: "team-a",
      allowedSiteIds: ["site-a"],
      timeZone: "UTC",
    };
    const data = { sites: [], trend: [] };
    try {
      await withDashboardCache(
        f.ctx,
        new URL(
          "https://app.test/api/private/team-dashboard?teamId=team-a&from=100&to=300&interval=day&timeZone=UTC",
        ),
        async () => Response.json({ ok: true, data }),
        {
          identity: {
            scope: "private-team",
            tenantId: "team-a",
            route: "team-dashboard",
            audienceId: "user-a",
            allowedSiteIds: ["site-a"],
          },
        },
      );
      await f.finish();
      await expect(
        readCachedSidebarTeamDashboard(resolved, window),
      ).resolves.toEqual(data);
      expect(executePrivateTeamDashboard).not.toHaveBeenCalled();
      vi.mocked(executePrivateTeamDashboard)
        .mockResolvedValueOnce(Response.json({ ok: true, data }))
        .mockResolvedValueOnce(new Response("forbidden", { status: 403 }));
      await expect(
        readCachedSidebarTeamDashboard(
          { ...resolved, session: { userId: "user-b" } as never },
          window,
        ),
      ).resolves.toEqual(data);
      await expect(
        readCachedSidebarTeamDashboard(
          { ...resolved, allowedSiteIds: ["site-b"] },
          window,
        ),
      ).resolves.toBeNull();
      expect(executePrivateTeamDashboard).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("records one page invocation for the workspace without a profile dispatch", async () => {
    const f = setup();
    vi.mocked(resolvePageRequest).mockResolvedValueOnce({
      response: null,
      locale: null,
      pathname: "/en/app",
    });
    const response = await server.fetch(
      new Request("https://app.test/en/app?private=secret"),
      f.env,
      f.ctx,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("page response");
    await f.finish();
    expect(f.points).toHaveLength(1);
    expect(f.points[0].indexes).toEqual(["page.other:ok"]);
    expect(f.points[0].blobs[2]).toBe("page");
    expect(JSON.stringify(f.points)).not.toContain("private=secret");
    expect(vi.mocked(apiApp.fetch)).not.toHaveBeenCalled();
    expect(vi.mocked(startHandler.fetch)).toHaveBeenCalledOnce();
  });

  it("keeps one page invocation open for tracked deferred analytics after returning the response", async () => {
    const f = setup();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    f.env.DB = {
      prepare: () => ({
        all: async () => ({
          success: true,
          results: [],
          meta: {
            rows_read: 7,
            rows_written: 0,
            timings: { sql_duration_ms: 1 },
            total_attempts: 1,
          },
        }),
      }),
    } as unknown as D1Database;
    vi.mocked(resolvePrivateSite).mockResolvedValueOnce({
      id: "site-a",
      name: "A",
      domain: "a.test",
      canManage: true,
    } as never);
    vi.mocked(executePrivateQuery).mockImplementation(async (input) => {
      if (input.pathname === "overview-geo-points") {
        await gate;
        await input.env.DB.prepare("SELECT 1").all();
      }
      if (input.pathname === "overview-source-domain")
        return new Response("failure", { status: 500 });
      return Response.json({
        ok: true,
        data: {
          items: [],
          pagination: {
            limit: 100,
            returned: 0,
            hasMore: false,
            nextCursor: null,
          },
        },
      });
    });
    let reads: Awaited<ReturnType<typeof startSiteAnalyticsStream>> | undefined;
    vi.mocked(startHandler.fetch).mockImplementationOnce(
      async (request, options) => {
        reads = await startSiteAnalyticsStream({
          request,
          env: options!.context!.env,
          siteId: "site-a",
          window: {
            preset: "custom",
            from: 100,
            to: 300,
            interval: "day",
            timeZone: "UTC",
          },
          search: "",
        });
        return new Response("shell");
      },
    );
    const response = await server.fetch(
      new Request("https://app.test/en/app/team/site"),
      f.env,
      f.ctx,
    );
    expect(await response.text()).toBe("shell");
    expect(Object.keys(reads!)).toHaveLength(6);
    const source = Object.keys(reads!).find((key) =>
      key.includes("overview-source-domain"),
    )!;
    const page = Object.keys(reads!).find((key) =>
      key.includes("overview-page-path"),
    )!;
    await expect(reads![source]).resolves.toBeNull();
    await expect(reads![page]).resolves.toHaveProperty("value");
    expect(f.points).toHaveLength(0);
    expect(f.work.length).toBeGreaterThan(0);
    finish();
    await f.finish();
    expect(f.points).toHaveLength(1);
    expect(f.points[0]!.blobs[3]).toBe("page.dashboard.analytics.overview");
    expect(f.points[0]!.doubles[3]).toBe(1);
    expect(f.points[0]!.doubles[5]).toBe(7);
    expect(f.points[0]!.doubles[19]).toBe(2);
    expect(vi.mocked(executePrivateQuery)).toHaveBeenCalledTimes(6);
    expect(vi.mocked(resolvePrivateSite)).toHaveBeenCalledTimes(1);
  });
  it("streams referrer cards independently and isolates a failed radar", async () => {
    const f = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(resolvePrivateSite).mockResolvedValueOnce({
      id: "site-a",
      name: "A",
      domain: "a.test",
      canManage: true,
    } as never);
    vi.mocked(executePrivateQuery).mockImplementation(async (input) => {
      if (input.pathname === "referrer-radar") {
        await gate;
        return new Response("failure", { status: 500 });
      }
      return Response.json({
        ok: true,
        data: {
          items: [],
          pagination: {
            limit: 100,
            returned: 0,
            hasMore: false,
            nextCursor: null,
          },
        },
      });
    });
    let reads: Awaited<ReturnType<typeof startSiteAnalyticsStream>> | undefined;
    vi.mocked(startHandler.fetch).mockImplementationOnce(
      async (request, options) => {
        reads = await startSiteAnalyticsStream({
          request,
          env: options!.context!.env,
          siteId: "site-a",
          page: "referrers",
          window: {
            preset: "custom",
            from: 100,
            to: 300,
            interval: "day",
            timeZone: "UTC",
          },
          search: "",
        });
        return new Response("shell");
      },
    );
    const response = await server.fetch(
      new Request("https://app.test/en/app/team/site/referrers"),
      f.env,
      f.ctx,
    );
    expect(await response.text()).toBe("shell");
    expect(Object.keys(reads!)).toHaveLength(5);
    const radar = Object.keys(reads!).find((key) =>
      key.includes("referrer-radar"),
    )!;
    for (const [key, promise] of Object.entries(reads!))
      if (key !== radar) await expect(promise).resolves.toHaveProperty("value");
    expect(f.points).toHaveLength(0);
    release();
    await expect(reads![radar]).resolves.toBeNull();
    await f.finish();
    expect(f.points).toHaveLength(1);
    expect(executePrivateQuery).toHaveBeenCalledTimes(5);
    expect(resolvePrivateSite).toHaveBeenCalledTimes(1);
  });
  it("streams geo dimension data while points remain pending and tracks late failure", async () => {
    const f = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(resolvePrivateSite).mockResolvedValueOnce({
      id: "site-a",
      name: "A",
      domain: "a.test",
      canManage: true,
    } as never);
    vi.mocked(executePrivateQuery).mockImplementation(async (input) => {
      if (input.pathname === "overview-geo-points") {
        await gate;
        return new Response("failed", { status: 500 });
      }
      return Response.json({
        ok: true,
        data: {
          items: [],
          pagination: {
            limit: 400,
            returned: 0,
            hasMore: false,
            nextCursor: null,
          },
        },
      });
    });
    let reads: Awaited<ReturnType<typeof startSiteAnalyticsStream>> | undefined;
    vi.mocked(startHandler.fetch).mockImplementationOnce(
      async (request, options) => {
        reads = await startSiteAnalyticsStream({
          request,
          env: options!.context!.env,
          siteId: "site-a",
          page: "geo",
          window: {
            preset: "custom",
            from: 100,
            to: 300,
            interval: "day",
            timeZone: "UTC",
          },
          search: "location=JP",
        });
        return new Response("shell");
      },
    );
    const response = await server.fetch(
      new Request("https://app.test/en/app/team/site/geo?location=JP"),
      f.env,
      f.ctx,
    );
    expect(await response.text()).toBe("shell");
    expect(Object.keys(reads!)).toHaveLength(2);
    const stats = Object.keys(reads!).find((key) =>
      key.includes("overview-geo-region"),
    )!;
    const points = Object.keys(reads!).find((key) =>
      key.includes("overview-geo-points"),
    )!;
    await expect(reads![stats]).resolves.toHaveProperty("value");
    expect(f.points).toHaveLength(0);
    release();
    await expect(reads![points]).resolves.toBeNull();
    await f.finish();
    expect(f.points).toHaveLength(1);
    expect(executePrivateQuery).toHaveBeenCalledTimes(2);
    expect(resolvePrivateSite).toHaveBeenCalledTimes(1);
  });
  it("streams event summary and records before a slow failed trend and tracks all work", async () => {
    const f = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(resolvePrivateSite).mockResolvedValueOnce({
      id: "site-a",
      name: "A",
      domain: "a.test",
      canManage: true,
    } as never);
    vi.mocked(executePrivateQuery).mockImplementation(async (input) => {
      if (input.pathname === "events-trend") {
        await gate;
        return new Response("failed", { status: 500 });
      }
      return Response.json({
        ok: true,
        data: {
          items: [],
          pagination: {
            limit: 50,
            returned: 0,
            hasMore: false,
            nextCursor: null,
          },
        },
      });
    });
    let reads: Awaited<ReturnType<typeof startSiteAnalyticsStream>> | undefined;
    vi.mocked(startHandler.fetch).mockImplementationOnce(
      async (request, options) => {
        reads = await startSiteAnalyticsStream({
          request,
          env: options!.context!.env,
          siteId: "site-a",
          page: "events",
          window: {
            preset: "custom",
            from: 100,
            to: 300,
            interval: "day",
            timeZone: "UTC",
          },
          search: "detail=clicked",
        });
        return new Response("shell");
      },
    );
    const response = await server.fetch(
      new Request("https://app.test/en/app/team/site/events"),
      f.env,
      f.ctx,
    );
    expect(await response.text()).toBe("shell");
    expect(Object.keys(reads!)).toHaveLength(3);
    const trend = Object.keys(reads!).find((key) =>
      key.includes("events-trend"),
    )!;
    for (const [key, promise] of Object.entries(reads!))
      if (key !== trend) await expect(promise).resolves.toHaveProperty("value");
    expect(f.points).toHaveLength(0);
    release();
    await expect(reads![trend]).resolves.toBeNull();
    await f.finish();
    expect(f.points).toHaveLength(1);
    expect(executePrivateQuery).toHaveBeenCalledTimes(3);
    expect(resolvePrivateSite).toHaveBeenCalledTimes(1);
  });
  it.each([
    "overview",
    "pages",
    "referrers",
    "campaigns",
    "browsers",
    "devices",
    "geo",
    "performance",
    "events",
    "visitors",
    "sessions",
  ] as const)(
    "does not start any analytics for denied SSR site access on %s",
    async (page) => {
      vi.mocked(resolvePrivateSite).mockResolvedValueOnce(
        new Response(null, { status: 404 }),
      );
      const reads = await startSiteAnalyticsStream({
        request: new Request("https://app.test/en/app/team/site"),
        env: setup().env,
        siteId: "forbidden",
        page,
        window: {
          preset: "custom",
          from: 100,
          to: 300,
          interval: "day",
          timeZone: "UTC",
        },
        search: "",
      });
      expect(reads).toEqual({});
      expect(executePrivateQuery).not.toHaveBeenCalled();
    },
  );

  it("records an actual external /api request despite forged internal headers", async () => {
    const f = setup();
    for (const headerValue of ["1", "true"]) {
      const response = await server.fetch(
        new Request("https://app.test/api/internal?token=CANARY_private", {
          headers: { "x-insightflare-internal-page-request": headerValue },
        }),
        f.env,
        f.ctx,
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("api");
      await f.finish();
      expect(f.points).toHaveLength(headerValue === "1" ? 1 : 2);
      expect(f.points.at(-1)?.indexes).toEqual(["api:/api/*:ok"]);
    }
    expect(vi.mocked(apiApp.fetch)).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(f.points)).not.toContain("CANARY_private");
  });

  it("uses a distinct trusted Server Function route key", async () => {
    const f = setup();
    const response = await server.fetch(
      new Request("https://app.test/_serverFn/sensitive-function", {
        method: "POST",
      }),
      f.env,
      f.ctx,
    );
    expect(response.status).toBe(200);
    await f.finish();
    expect(f.points).toHaveLength(1);
    expect(f.points[0].indexes).toEqual(["server_function.handler:ok"]);
    expect(f.points[0].blobs[4]).toBe("POST");
    expect(JSON.stringify(f.points)).not.toContain("sensitive-function");
  });

  it("records scheduled invocation once with and without a task dispatch", async () => {
    const disabled = setup();
    disabled.env.DISABLE_CRON_TASKS = "1";
    await server.scheduled(
      { scheduledTime: 123 } as ScheduledController,
      disabled.env,
      disabled.ctx,
    );
    await disabled.finish();
    expect(disabled.points).toHaveLength(1);
    expect(disabled.points[0].indexes).toEqual(["scheduled.tasks:ok"]);
    expect(dispatchInternalScheduledTasks).not.toHaveBeenCalled();

    const enabled = setup();
    await server.scheduled(
      { scheduledTime: 124 } as ScheduledController,
      enabled.env,
      enabled.ctx,
    );
    await enabled.finish();
    expect(enabled.points).toHaveLength(1);
    expect(enabled.points[0].indexes).toEqual(["scheduled.tasks:ok"]);
    expect(dispatchInternalScheduledTasks).toHaveBeenCalledOnce();
  });

  it("preserves scheduled retry rejection when its AE writer fails", async () => {
    const f = setup();
    const failure = new Error("scheduler retry original");
    vi.mocked(dispatchInternalScheduledTasks).mockRejectedValueOnce(failure);
    vi.mocked(f.env.INVOCATION_METRICS!.writeDataPoint).mockImplementation(
      () => {
        throw new Error("AE writer offline");
      },
    );
    await server.scheduled(
      { scheduledTime: 125 } as ScheduledController,
      f.env,
      f.ctx,
    );
    const results = await Promise.allSettled(f.work);
    expect(results[0]).toMatchObject({ status: "rejected", reason: failure });
    expect(f.points).toHaveLength(0);
    expect(f.env.INVOCATION_METRICS!.writeDataPoint).toHaveBeenCalledOnce();
  });
});
