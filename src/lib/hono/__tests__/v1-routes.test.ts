import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { handlePlannedResourceRoute } from "@/lib/api-v1/resource-handler";
import type * as SiteListHandlerModule from "@/lib/api-v1/site-list-handler";
import type * as ApiKeyAuthModule from "@/lib/edge/api-key-auth";
import { authenticateApiKey } from "@/lib/edge/api-key-auth";
import { v1Routes } from "@/lib/hono/routes/v1";
import type { AppEnv } from "@/lib/hono/types";

const typedReaderMock = vi.hoisted(() => {
  const input = {
    siteId: "site-1",
    teamId: "team-1",
    allowedSiteIds: ["site-1"],
    interval: "day",
    primaryDimension: "page.path",
    secondaryDimension: "country",
    primaryLimit: 10,
    secondaryLimit: 10,
    dimension: "page.path",
    metric: "lcp",
    field: "page.path",
    search: undefined,
    includeDetails: false,
    includeFullUrl: false,
    granularity: "week",
    eventName: "signup",
    eventId: "event-1",
    fieldPath: "plan",
    fieldValueType: "string",
    visitorId: "visitor-1",
    sessionId: "session-1",
    page: { limit: 10 },
    limit: 10,
    sort: undefined,
    startMs: 0,
    endExclusiveMs: 1,
    timeZone: "UTC",
    filters: { version: 1, root: null },
    signal: undefined,
  };
  return {
    invoke: (...args: unknown[]) => {
      const request = args[0] as Request;
      if (request.method !== "POST") {
        return Promise.resolve(
          new Response(null, { status: 405, headers: { Allow: "POST" } }),
        );
      }
      if (!request.headers.get("content-type")) {
        return Promise.resolve(new Response(null, { status: 415 }));
      }
      const reader = args.find(
        (value): value is (input: unknown) => Promise<unknown> =>
          typeof value === "function",
      );
      if (reader) void reader(input).catch(() => undefined);
      return Promise.resolve(new Response("typed-reader"));
    },
  };
});

vi.mock("@/lib/edge/api-key-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiKeyAuthModule>()),
  authenticateApiKey: vi.fn(),
}));

vi.mock("@/lib/api-v1/resource-handler", () => ({
  handlePlannedResourceRoute: vi.fn(),
}));

vi.mock("@/lib/api-v1/funnel-analysis-handler", () => ({
  handlePlannedSiteFunnelAnalysis: vi.fn(typedReaderMock.invoke),
}));

vi.mock("@/lib/api-v1/overview-handler", () => ({
  handlePlannedSiteOverview: vi.fn(typedReaderMock.invoke),
}));

vi.mock("@/lib/api-v1/site-breakdown-handler", () => ({
  handlePlannedSiteBreakdown: vi.fn(typedReaderMock.invoke),
}));

vi.mock("@/lib/api-v1/team-timeseries-handler", () => ({
  handlePlannedTeamTimeseries: vi.fn(typedReaderMock.invoke),
}));

vi.mock("@/lib/api-v1/team-overview-handler", () => ({
  handlePlannedTeamOverview: vi.fn(typedReaderMock.invoke),
}));

vi.mock("@/lib/api-v1/team-sites-handler", () => ({
  handlePlannedTeamSites: vi.fn(typedReaderMock.invoke),
}));

vi.mock("@/lib/api-v1/team-breakdown-handler", () => ({
  handleTeamBreakdown: vi.fn(typedReaderMock.invoke),
}));

vi.mock("@/lib/api-v1/team-comparison-handler", () => ({
  handleTeamComparisonBreakdown: vi.fn(typedReaderMock.invoke),
  handleTeamComparisonOverview: vi.fn(typedReaderMock.invoke),
  handleTeamComparisonTimeseries: vi.fn(typedReaderMock.invoke),
}));

vi.mock("@/lib/api-v1/site-cross-breakdown-handler", () => ({
  handlePlannedSiteCrossBreakdown: vi.fn(typedReaderMock.invoke),
}));

vi.mock("@/lib/api-v1/comparison-handler", () => ({
  handleSiteOverviewComparison: vi.fn(typedReaderMock.invoke),
}));

vi.mock("@/lib/api-v1/comparison-timeseries-handler", () => ({
  handleSiteTimeseriesComparison: vi.fn(typedReaderMock.invoke),
}));

vi.mock("@/lib/edge/analytics/api-v1-provider", async (importOriginal) => ({
  ...(await importOriginal()),
  readSiteBreakdown: vi.fn().mockResolvedValue({ items: [] }),
}));

vi.mock("@/lib/api-v1/timeseries-handler", () => ({
  handlePlannedSiteTimeseries: vi.fn(typedReaderMock.invoke),
}));

vi.mock("@/lib/api-v1/site-list-handler", async (importOriginal) => ({
  ...(await importOriginal<typeof SiteListHandlerModule>()),
  handlePlannedSitePages: vi.fn(typedReaderMock.invoke),
  handlePlannedSiteReferrers: vi.fn(typedReaderMock.invoke),
  handlePlannedSiteFilterValues: vi.fn(typedReaderMock.invoke),
  handlePlannedSiteRetention: vi.fn(typedReaderMock.invoke),
  handlePlannedSitePerformanceSummary: vi.fn(typedReaderMock.invoke),
  handlePlannedSitePerformanceTimeseries: vi.fn(typedReaderMock.invoke),
  handlePlannedSitePerformanceBreakdown: vi.fn(typedReaderMock.invoke),
  handlePlannedSiteEventsSummary: vi.fn(typedReaderMock.invoke),
  handlePlannedSiteEventsTimeseries: vi.fn(typedReaderMock.invoke),
  handlePlannedSiteEventTypes: vi.fn(typedReaderMock.invoke),
  handlePlannedSiteEventTypeDetail: vi.fn(typedReaderMock.invoke),
  handlePlannedSiteEventFields: vi.fn(typedReaderMock.invoke),
  handlePlannedSiteEventFieldValues: vi.fn(typedReaderMock.invoke),
  handlePlannedSiteEventsSearch: vi.fn(typedReaderMock.invoke),
  handlePlannedSiteEventDetail: vi.fn(typedReaderMock.invoke),
  handlePlannedSiteRealtimeSnapshot: vi.fn(typedReaderMock.invoke),
  handlePlannedSiteRealtimeActiveVisitors: vi.fn(typedReaderMock.invoke),
  handlePlannedSiteRealtimeEvents: vi.fn(typedReaderMock.invoke),
  handlePlannedSiteRealtimeSessions: vi.fn(typedReaderMock.invoke),
  handlePlannedSiteVisitorDetail: vi.fn(typedReaderMock.invoke),
  handlePlannedSiteSessionDetail: vi.fn(typedReaderMock.invoke),
  handlePlannedSiteVisitorsSearch: vi.fn(typedReaderMock.invoke),
  handlePlannedSiteSessionsSearch: vi.fn(typedReaderMock.invoke),
  handlePlannedSiteVisitorEvents: vi.fn(typedReaderMock.invoke),
  handlePlannedSiteVisitorSessions: vi.fn(typedReaderMock.invoke),
  handlePlannedSiteSessionEvents: vi.fn(typedReaderMock.invoke),
}));

const principal = {
  keyId: "key-1",
  teamId: "team-1",
  prefix: "if_123",
  scopes: ["analytics:read" as const],
  siteIds: ["site-1"],
};
const env = {
  DB: {
    prepare: vi.fn(() => ({
      bind: vi.fn(() => ({
        first: vi.fn().mockResolvedValue({
          id: "team-1",
          name: "Test team",
          createdAt: 0,
        }),
        all: vi.fn().mockResolvedValue({ results: [{ id: "site-1" }] }),
      })),
    })),
  },
};
const ctx = {
  passThroughOnException: vi.fn(),
  waitUntil: vi.fn(),
} as unknown as ExecutionContext;

function request(path: string, init?: RequestInit): Request {
  return new Request(`https://app.test${path}`, init);
}

function createApp() {
  const app = new Hono<AppEnv>();
  app.route("/api/v1", v1Routes);
  return app;
}

describe("Hono API v1 routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateApiKey).mockResolvedValue(principal);
    vi.mocked(handlePlannedResourceRoute).mockResolvedValue(
      new Response("resource"),
    );
  });

  it("serves the API v1 root without API key auth", async () => {
    const response = await createApp().fetch(
      request("/api/v1"),
      env as never,
      ctx,
    );

    await expect(response.json()).resolves.toMatchObject({
      data: { service: "insightflare" },
    });
    expect(authenticateApiKey).not.toHaveBeenCalled();
  });

  it("authenticates non-root routes and dispatches capabilities directly", async () => {
    const response = await createApp().fetch(
      request("/api/v1/capabilities"),
      env as never,
      ctx,
    );

    await expect(response.json()).resolves.toMatchObject({
      data: { apiVersion: expect.any(String) },
    });
    expect(authenticateApiKey).toHaveBeenCalled();
  });

  it("dispatches the typed token and team core routes", async () => {
    const app = createApp();
    const token = await app.fetch(request("/api/v1/token"), env as never, ctx);
    const check = await app.fetch(
      request("/api/v1/token/check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ checks: [{ scope: "analytics:read" }] }),
      }),
      env as never,
      ctx,
    );
    const team = await app.fetch(request("/api/v1/team"), env as never, ctx);
    const usage = await app.fetch(
      request("/api/v1/team/usage"),
      env as never,
      ctx,
    );

    await expect(token.json()).resolves.toMatchObject({
      data: { id: "key-1", team: { id: "team-1" } },
    });
    await expect(check.json()).resolves.toMatchObject({
      data: { checks: [{ allowed: true }] },
    });
    await expect(team.json()).resolves.toMatchObject({
      data: { id: "team-1" },
    });
    await expect(usage.json()).resolves.toMatchObject({ data: { sites: 1 } });
  });

  it("throws when the api principal context is missing", async () => {
    vi.mocked(authenticateApiKey).mockResolvedValueOnce(undefined as never);
    const app = createApp();

    const response = await app.fetch(
      request("/api/v1/capabilities"),
      env as never,
      ctx,
    );

    expect(response.status).toBe(500);
  });

  it("returns 404 for an unregistered legacy analytics path", async () => {
    const response = await createApp().fetch(
      request("/api/v1/sites/site-1/analytics/legacy"),
      env as never,
      ctx,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "resource_not_found" },
    });
  });

  it.each([
    "/api/v1/sites/site-1/analytics/comparison/overview",
    "/api/v1/sites/site-1/analytics/comparison/timeseries",
    "/api/v1/sites/site-1/analytics/comparison/breakdowns/page.path",
    "/api/v1/sites/site-1/analytics/overview",
    "/api/v1/sites/site-1/analytics/timeseries",
    "/api/v1/sites/site-1/analytics/breakdowns/page.path",
    "/api/v1/sites/site-1/analytics/cross-breakdowns",
    "/api/v1/sites/site-1/analytics/pages",
    "/api/v1/sites/site-1/analytics/referrers",
    "/api/v1/sites/site-1/analytics/filter-values",
    "/api/v1/sites/site-1/analytics/retention/cohorts",
    "/api/v1/sites/site-1/analytics/funnel-analysis",
    "/api/v1/sites/site-1/analytics/performance/summary",
    "/api/v1/sites/site-1/analytics/performance/timeseries",
    "/api/v1/sites/site-1/analytics/events/summary",
    "/api/v1/sites/site-1/analytics/events/timeseries",
    "/api/v1/sites/site-1/analytics/event-types",
    "/api/v1/sites/site-1/analytics/event-types/detail",
    "/api/v1/sites/site-1/analytics/event-types/fields",
    "/api/v1/sites/site-1/analytics/event-types/field-values",
    "/api/v1/sites/site-1/analytics/events/search",
    "/api/v1/sites/site-1/analytics/events/detail",
    "/api/v1/sites/site-1/analytics/realtime/snapshot",
    "/api/v1/sites/site-1/analytics/realtime/active-visitors",
    "/api/v1/sites/site-1/analytics/realtime/events",
    "/api/v1/sites/site-1/analytics/realtime/sessions",
    "/api/v1/sites/site-1/analytics/performance/breakdowns/page.path",
    "/api/v1/sites/site-1/analytics/visitors/detail",
    "/api/v1/sites/site-1/analytics/sessions/detail",
    "/api/v1/sites/site-1/analytics/visitors/search",
    "/api/v1/sites/site-1/analytics/sessions/search",
    "/api/v1/sites/site-1/analytics/visitors/events",
    "/api/v1/sites/site-1/analytics/visitors/sessions",
    "/api/v1/sites/site-1/analytics/sessions/events",
  ])("uses the typed POST boundary for %s", async (route) => {
    const response = await createApp().fetch(
      request(route, { method: "POST" }),
      env as never,
      ctx,
    );

    expect(response.status).toBe(415);
  });

  it("uses typed schema and saved-filter boundaries without legacy wildcards", async () => {
    const siteSchema = await createApp().fetch(
      request("/api/v1/sites/site-1/analytics/schema"),
      env as never,
      ctx,
    );
    const teamSchema = await createApp().fetch(
      request("/api/v1/team/analytics/schema"),
      env as never,
      ctx,
    );
    const savedFilters = await createApp().fetch(
      request("/api/v1/sites/site-1/saved-filters"),
      env as never,
      ctx,
    );

    expect(siteSchema.status).toBe(200);
    expect(teamSchema.status).toBe(200);
    expect(savedFilters.status).toBe(403);
  });

  it("rejects legacy GET analytics routes while preserving typed method guards", async () => {
    const overview = await createApp().fetch(
      request("/api/v1/sites/site-1/analytics/overview", { method: "GET" }),
      env as never,
      ctx,
    );
    expect(overview.status).toBe(404);

    const schema = await createApp().fetch(
      request("/api/v1/sites/site-1/analytics/schema", { method: "POST" }),
      env as never,
      ctx,
    );
    expect(schema.status).toBe(405);
    expect(schema.headers.get("allow")).toBe("GET");

    const savedFilters = await createApp().fetch(
      request("/api/v1/sites/site-1/saved-filters", { method: "POST" }),
      env as never,
      ctx,
    );
    expect(savedFilters.status).toBe(405);
    expect(savedFilters.headers.get("allow")).toBe("GET");
  });

  it("enters typed readers for valid JSON query bodies", async () => {
    const body = JSON.stringify({
      timeRange: {
        kind: "absolute",
        from: "2026-08-01T00:00:00.000Z",
        to: "2026-08-02T00:00:00.000Z",
        timeZone: "UTC",
      },
    });
    const routes = [
      "/api/v1/sites/site-1/analytics/overview",
      "/api/v1/sites/site-1/analytics/timeseries",
      "/api/v1/sites/site-1/analytics/breakdowns/page.path",
      "/api/v1/sites/site-1/analytics/cross-breakdowns",
      "/api/v1/sites/site-1/analytics/pages",
      "/api/v1/sites/site-1/analytics/referrers",
      "/api/v1/sites/site-1/analytics/filter-values",
      "/api/v1/sites/site-1/analytics/retention/cohorts",
      "/api/v1/sites/site-1/analytics/funnel-analysis",
      "/api/v1/sites/site-1/analytics/performance/summary",
      "/api/v1/sites/site-1/analytics/performance/timeseries",
      "/api/v1/sites/site-1/analytics/performance/breakdowns/page.path",
      "/api/v1/sites/site-1/analytics/events/summary",
      "/api/v1/sites/site-1/analytics/events/timeseries",
      "/api/v1/sites/site-1/analytics/event-types",
      "/api/v1/sites/site-1/analytics/event-types/detail",
      "/api/v1/sites/site-1/analytics/event-types/fields",
      "/api/v1/sites/site-1/analytics/event-types/field-values",
      "/api/v1/sites/site-1/analytics/events/search",
      "/api/v1/sites/site-1/analytics/events/detail",
      "/api/v1/sites/site-1/analytics/realtime/snapshot",
      "/api/v1/sites/site-1/analytics/realtime/active-visitors",
      "/api/v1/sites/site-1/analytics/realtime/events",
      "/api/v1/sites/site-1/analytics/realtime/sessions",
      "/api/v1/sites/site-1/analytics/visitors/detail",
      "/api/v1/sites/site-1/analytics/sessions/detail",
      "/api/v1/sites/site-1/analytics/visitors/search",
      "/api/v1/sites/site-1/analytics/sessions/search",
      "/api/v1/sites/site-1/analytics/visitors/events",
      "/api/v1/sites/site-1/analytics/visitors/sessions",
      "/api/v1/sites/site-1/analytics/sessions/events",
    ];
    for (const route of routes) {
      const response = await createApp().fetch(
        request(route, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        }),
        env as never,
        ctx,
      );
      expect(response.status).not.toBe(415);
    }
  });

  it("executes the site comparison breakdown composition callback", async () => {
    const response = await createApp().fetch(
      request(
        "/api/v1/sites/site-1/analytics/comparison/breakdowns/page.path",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            mode: "explicit",
            timeZone: "UTC",
            a: {
              timeRange: {
                kind: "absolute",
                from: "2026-08-01T00:00:00.000Z",
                to: "2026-08-02T00:00:00.000Z",
              },
            },
            b: {
              timeRange: {
                kind: "absolute",
                from: "2026-08-02T00:00:00.000Z",
                to: "2026-08-03T00:00:00.000Z",
              },
            },
            query: { limit: 10 },
          }),
        },
      ),
      env as never,
      ctx,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { dimension: "page.path", items: [] },
    });
  });

  it("enters team typed readers and application item boundaries", async () => {
    const body = JSON.stringify({
      timeRange: {
        kind: "absolute",
        from: "2026-08-01T00:00:00.000Z",
        to: "2026-08-02T00:00:00.000Z",
        timeZone: "UTC",
      },
    });
    for (const route of [
      "/api/v1/team/analytics/overview",
      "/api/v1/team/analytics/timeseries",
      "/api/v1/team/analytics/sites",
      "/api/v1/team/analytics/breakdowns/page.path",
      "/api/v1/team/analytics/comparison/overview",
      "/api/v1/team/analytics/comparison/timeseries",
      "/api/v1/team/analytics/comparison/breakdowns/page.path",
    ]) {
      const response = await createApp().fetch(
        request(route, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        }),
        env as never,
        ctx,
      );
      expect(response.status).not.toBe(415);
    }
    const item = await createApp().fetch(
      request("/api/v1/sites/site-1/saved-filters/filter-1"),
      env as never,
      ctx,
    );
    expect(item.status).toBe(403);
  });

  it.each([
    ["/api/v1/sites", "GET", "sites.list"],
    ["/api/v1/sites", "POST", "sites.create"],
    ["/api/v1/sites/site-1", "GET", "sites.get"],
    ["/api/v1/sites/site-1", "PATCH", "sites.update"],
    ["/api/v1/sites/site-1", "DELETE", "sites.delete"],
    ["/api/v1/sites/site-1/settings/tracking", "GET", "settings.tracking.get"],
    [
      "/api/v1/sites/site-1/settings/tracking",
      "PATCH",
      "settings.tracking.update",
    ],
    ["/api/v1/sites/site-1/settings/privacy", "GET", "settings.privacy.get"],
    [
      "/api/v1/sites/site-1/settings/privacy",
      "PATCH",
      "settings.privacy.update",
    ],
    ["/api/v1/sites/site-1/settings/sharing", "GET", "settings.sharing.get"],
    [
      "/api/v1/sites/site-1/settings/sharing",
      "PATCH",
      "settings.sharing.update",
    ],
    [
      "/api/v1/sites/site-1/settings/tracking-script",
      "GET",
      "settings.trackingScript.get",
    ],
    ["/api/v1/sites/site-1/funnels", "GET", "funnels.list"],
    ["/api/v1/sites/site-1/funnels", "POST", "funnels.create"],
    ["/api/v1/sites/site-1/funnels/funnel-1", "GET", "funnels.get"],
    ["/api/v1/sites/site-1/funnels/funnel-1", "PATCH", "funnels.update"],
    ["/api/v1/sites/site-1/funnels/funnel-1", "DELETE", "funnels.delete"],
  ])(
    "dispatches resource %s %s through the typed application adapter",
    async (path, method, routeId) => {
      const response = await createApp().fetch(
        request(path, { method }),
        env as never,
        ctx,
      );

      await expect(response.text()).resolves.toBe("resource");
      expect(handlePlannedResourceRoute).toHaveBeenCalledWith(
        expect.objectContaining({ routeId }),
      );
    },
  );

  it.each([
    "/api/v1/sites/site-1/tracking",
    "/api/v1/sites/site-1/tracking/script",
    "/api/v1/sites/site-1/privacy",
    "/api/v1/sites/site-1/sharing",
    "/api/v1/sites/site-1/event-types",
    "/api/v1/sites/site-1/event-types/signup",
    "/api/v1/sites/site-1/events",
    "/api/v1/sites/site-1/events/event-1",
    "/api/v1/sites/site-1/event-fields",
    "/api/v1/sites/site-1/event-fields/values",
    "/api/v1/sites/site-1/visitors",
    "/api/v1/sites/site-1/visitors/visitor-1",
    "/api/v1/sites/site-1/visitors/visitor-1/sessions",
    "/api/v1/sites/site-1/visitors/visitor-1/events",
    "/api/v1/sites/site-1/sessions",
    "/api/v1/sites/site-1/sessions/session-1",
    "/api/v1/sites/site-1/sessions/session-1/events",
    "/api/v1/sites/site-1/performance",
    "/api/v1/sites/site-1/performance/summary",
    "/api/v1/sites/site-1/realtime",
    "/api/v1/sites/site-1/realtime/snapshot",
  ])("returns 404 for removed legacy API v1 path %s", async (route) => {
    const response = await createApp().fetch(request(route), env as never, ctx);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "resource_not_found" },
    });
  });
  it("returns the API v1 resource_not_found envelope for unknown resources", async () => {
    const response = await createApp().fetch(
      request("/api/v1/nope"),
      env as never,
      ctx,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "resource_not_found" },
    });
  });

  it("rejects legacy GET and non-registry children at the typed batch boundary", async () => {
    const response = await createApp().fetch(
      request("/api/v1/batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requests: [
            {
              id: "capabilities",
              method: "GET",
              path: "/api/v1/capabilities",
            },
          ],
        }),
      }),
      env as never,
      ctx,
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "batch_child_not_allowed" },
    });
    expect(authenticateApiKey).toHaveBeenCalledTimes(1);
  });

  it("keeps the batch outer response successful when a typed child fails", async () => {
    const response = await createApp().fetch(
      request("/api/v1/batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requests: [
            {
              id: "overview",
              method: "POST",
              path: "/api/v1/sites/site-1/analytics/overview",
              body: {
                timeRange: {
                  kind: "absolute",
                  from: "2026-08-01T00:00:00.000Z",
                  to: "2026-08-02T00:00:00.000Z",
                  timeZone: "UTC",
                },
                metrics: ["views"],
              },
            },
          ],
        }),
      }),
      env as never,
      ctx,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { responses: [{ id: "overview", status: expect.any(Number) }] },
      meta: { partialFailure: true },
    });
    expect(authenticateApiKey).toHaveBeenCalledOnce();
  });

  it("returns 405 and Allow: POST for non-POST batch requests", async () => {
    const response = await createApp().fetch(
      request("/api/v1/batch"),
      env as never,
      ctx,
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("applies the 413 size guard before media-type validation", async () => {
    const oversized = JSON.stringify({
      requests: [
        {
          id: "large",
          method: "POST",
          path: "/api/v1/sites/site-1/analytics/overview",
          body: { value: "x".repeat(300 * 1024) },
        },
      ],
    });
    const response = await createApp().fetch(
      request("/api/v1/batch", {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          "content-encoding": "gzip",
          "content-length": String(
            new TextEncoder().encode(oversized).byteLength,
          ),
        },
        body: oversized,
      }),
      env as never,
      ctx,
    );
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "payload_too_large" },
    });
  });

  it("rejects unsupported Content-Encoding after the bounded size check", async () => {
    const response = await createApp().fetch(
      request("/api/v1/batch", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-encoding": "gzip",
        },
        body: JSON.stringify({ requests: [] }),
      }),
      env as never,
      ctx,
    );
    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "unsupported_media_type" },
    });
  });

  it.each([
    ["a missing content type", {}, JSON.stringify({ requests: [] }), 415],
    [
      "an empty JSON body",
      { "content-type": "application/json" },
      undefined,
      400,
    ],
    ["malformed JSON", { "content-type": "application/json" }, "{", 400],
    [
      "a schema-invalid JSON document",
      { "content-type": "application/json" },
      JSON.stringify({ requests: [] }),
      422,
    ],
    [
      "a structurally oversized JSON document",
      { "content-type": "application/json" },
      JSON.stringify({ requests: Array.from({ length: 1_001 }, () => null) }),
      413,
    ],
  ])(
    "rejects %s before dispatching batch children",
    async (_caseName, headers, body, expectedStatus) => {
      const response = await createApp().fetch(
        request("/api/v1/batch", { method: "POST", headers, body }),
        env as never,
        ctx,
      );

      expect(response.status).toBe(expectedStatus);
    },
  );

  it("requires analytics:read before reading a batch body", async () => {
    vi.mocked(authenticateApiKey).mockResolvedValueOnce({
      ...principal,
      scopes: [],
    });

    const response = await createApp().fetch(
      request("/api/v1/batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
      env as never,
      ctx,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "insufficient_scope" },
    });
  });

  it("accepts a registry-backed GET child without a JSON body", async () => {
    const response = await createApp().fetch(
      request("/api/v1/batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requests: [
            {
              id: "saved-filters",
              method: "GET",
              path: "/api/v1/sites/site-1/saved-filters",
            },
          ],
        }),
      }),
      env as never,
      ctx,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { responses: [{ id: "saved-filters", status: 403 }] },
      meta: { partialFailure: true },
    });
  });

  it("rejects an oversized individual batch item body", async () => {
    const response = await createApp().fetch(
      request("/api/v1/batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requests: [
            {
              id: "item-large",
              method: "POST",
              path: "/api/v1/sites/site-1/analytics/overview",
              body: { value: "x".repeat(65 * 1024) },
            },
          ],
        }),
      }),
      env as never,
      ctx,
    );
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "payload_too_large" },
    });
  });
});
