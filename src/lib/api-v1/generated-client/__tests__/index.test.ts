import { describe, expect, it, vi } from "vitest";

import {
  buildSiteAnalyticsSchema,
  buildTeamAnalyticsSchema,
} from "@/lib/api-v1/analytics-schema";
import {
  ApiV1GeneratedAbortError,
  ApiV1GeneratedContractError,
  ApiV1GeneratedTransportError,
  createApiV1GeneratedClient,
} from "@/lib/api-v1/generated-client";
import { AnalyticsTimeseriesResponseSchema } from "@/lib/api-v1/wire";

const overviewInput = {
  timeRange: {
    kind: "absolute" as const,
    from: "2026-08-01T00:00:00.000Z",
    to: "2026-08-02T00:00:00.000Z",
  },
  filter: null,
};

const overviewData = {
  views: 10,
  sessions: 4,
  visitors: 3,
  bounces: 1,
  totalDurationMs: 1200,
  avgDurationMs: 300,
  bounceRate: 0.25,
  approximateVisitors: false,
};

function response(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("API v1 generated client", () => {
  it("routes core and comparison commands through the generated transport", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
      response(
        {
          error: { code: "resource_not_found", message: "missing" },
          meta: { requestId: "req-generated" },
        },
        { status: 404 },
      ),
    );
    const client = createApiV1GeneratedClient({
      baseUrl: "https://api.test",
      fetch: fetcher,
    });
    const comparison = {
      version: 2 as const,
      timeZone: "UTC",
      current: { timeRange: overviewInput.timeRange, filter: null },
      reference: {
        timeRange: { kind: "previous_period" as const },
        filter: null,
      },
      select: {
        metrics: ["views" as const],
        trend: { interval: "day" as const, metrics: ["views" as const] },
      },
    };
    const breakdown = {
      version: 2 as const,
      timeZone: "UTC",
      current: comparison.current,
      reference: comparison.reference,
      limit: 20,
      sort: { by: "current.views" as const, direction: "desc" as const },
    };
    await Promise.all([
      client.getRoot(),
      client.getToken(),
      client.checkToken({ checks: [{ scope: "analytics:read" }] }),
      client.getCapabilities(),
      client.getTeam(),
      client.getTeamUsage(),
      client.listSites(),
      client.siteAnalyticsComparison("site-1", comparison),
      client.siteAnalyticsComparisonBreakdown("site-1", "page.path", breakdown),
      client.teamAnalyticsComparison(comparison),
      client.teamAnalyticsComparisonBreakdown("page.path", breakdown),
      client.teamAnalyticsBreakdown("page.path", {
        ...overviewInput,
        limit: 20,
      }),
    ]);
    expect(fetcher).toHaveBeenCalledTimes(12);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(
      expect.arrayContaining([
        "https://api.test/api/v1",
        "https://api.test/api/v1/token",
        "https://api.test/api/v1/token/check",
        "https://api.test/api/v1/capabilities",
        "https://api.test/api/v1/team",
        "https://api.test/api/v1/team/usage",
        "https://api.test/api/v1/sites",
        "https://api.test/api/v1/sites/site-1/analytics/comparison",
        "https://api.test/api/v1/sites/site-1/analytics/comparison/breakdowns/page.path",
        "https://api.test/api/v1/team/analytics/comparison",
        "https://api.test/api/v1/team/analytics/comparison/breakdowns/page.path",
        "https://api.test/api/v1/team/analytics/breakdowns/page.path",
      ]),
    );
  });

  it("normalizes the base URL, encodes path segments, and keeps bearer in headers", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        data: {
          items: [],
          page: {
            kind: "keyset",
            limit: 100,
            nextCursor: null,
            hasMore: false,
          },
        },
        meta: { requestId: "req-1" },
      }),
    );
    const client = createApiV1GeneratedClient({
      baseUrl: "https://api.example.test///",
      fetch: fetcher,
      bearer: () => "secret-token",
    });

    await client.listSavedFilters("site/a", { cursor: "cursor with/slash" });

    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe(
      "https://api.example.test/api/v1/sites/site%2Fa/saved-filters?cursor=cursor+with%2Fslash",
    );
    expect((init?.headers as Headers).get("Authorization")).toBe(
      "Bearer secret-token",
    );
    expect(url).not.toContain("secret-token");
    expect(init?.redirect).toBe("error");
  });

  it("emits non-default saved-filter page limits in the query string", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        data: {
          items: [],
          page: { kind: "keyset", limit: 20, nextCursor: null, hasMore: false },
        },
        meta: { requestId: "req-page" },
      }),
    );
    const client = createApiV1GeneratedClient({
      baseUrl: "https://api.test",
      fetch: fetcher,
    });

    await client.listSavedFilters("site-1", { limit: 20 });
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://api.test/api/v1/sites/site-1/saved-filters?limit=20",
    );
  });

  it("parses a successful analytics envelope and rejects unknown request fields", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        data: overviewData,
        meta: {
          requestId: "req-2",
          generatedAt: "2026-08-02T00:00:00.000Z",
          timeRange: {
            from: "2026-08-01T00:00:00.000Z",
            to: "2026-08-02T00:00:00.000Z",
            timeZone: "UTC",
          },
          source: "raw",
          accuracy: "exact",
        },
      }),
    );
    const client = createApiV1GeneratedClient({
      baseUrl: "https://api.test",
      fetch: fetcher,
    });
    const result = await client.siteAnalyticsOverview("site-1", overviewInput);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual(overviewData);
    expect(() =>
      client.siteAnalyticsOverview("site-1", {
        ...overviewInput,
        unexpected: true,
      } as never),
    ).toThrow();
  });

  it("sends team overview as a JSON POST without a caller-controlled subject", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        data: overviewData,
        meta: {
          requestId: "req-team",
          generatedAt: "2026-08-02T00:00:00.000Z",
          timeRange: {
            from: "2026-08-01T00:00:00.000Z",
            to: "2026-08-02T00:00:00.000Z",
            timeZone: "UTC",
          },
          source: "raw",
          accuracy: "exact",
        },
      }),
    );
    const client = createApiV1GeneratedClient({
      baseUrl: "https://api.test",
      fetch: fetcher,
    });

    const result = await client.teamAnalyticsOverview(overviewInput);

    expect(result.ok).toBe(true);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://api.test/api/v1/team/analytics/overview",
    );
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
  });

  it("requests the typed analytics schema through the GET catalog operation", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        data: buildSiteAnalyticsSchema("site-1", {
          now: () => "2026-08-02T00:00:00.000Z",
        }),
        meta: { requestId: "req-schema" },
      }),
    );
    const client = createApiV1GeneratedClient({
      baseUrl: "https://api.test",
      fetch: fetcher,
    });

    const result = await client.siteAnalyticsSchema("site-1");
    expect(result.ok).toBe(true);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://api.test/api/v1/sites/site-1/analytics/schema",
    );
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
  });

  it("requests the team analytics schema without accepting a team ID", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        data: buildTeamAnalyticsSchema({
          now: () => "2026-08-02T00:00:00.000Z",
        }),
        meta: { requestId: "req-team-schema" },
      }),
    );
    const client = createApiV1GeneratedClient({
      baseUrl: "https://api.test",
      fetch: fetcher,
    });
    await expect(client.teamAnalyticsSchema()).resolves.toMatchObject({
      ok: true,
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://api.test/api/v1/team/analytics/schema",
    );
  });

  it("requests and validates the typed analytics timeseries operation", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        data: {
          interval: "hour",
          points: [],
        },
        meta: {
          requestId: "req-trend",
          generatedAt: "2026-08-02T00:00:00.000Z",
          timeRange: {
            from: "2026-08-01T00:00:00.000Z",
            to: "2026-08-02T00:00:00.000Z",
            timeZone: "UTC",
          },
          source: "raw",
          accuracy: "exact",
        },
      }),
    );
    const client = createApiV1GeneratedClient({
      baseUrl: "https://api.test",
      fetch: fetcher,
    });
    const result = await client.siteAnalyticsTimeseries("site-1", {
      ...overviewInput,
      interval: "hour",
    });
    expect(result.ok).toBe(true);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://api.test/api/v1/sites/site-1/analytics/timeseries",
    );
    expect(
      AnalyticsTimeseriesResponseSchema.safeParse({
        data: { interval: "hour", points: [] },
        meta: {
          requestId: "req-trend",
          generatedAt: "2026-08-02T00:00:00.000Z",
          timeRange: {
            from: "2026-08-01T00:00:00.000Z",
            to: "2026-08-02T00:00:00.000Z",
            timeZone: "UTC",
          },
          source: "raw",
          accuracy: "exact",
        },
      }).success,
    ).toBe(true);
  });

  it("requests team timeseries without accepting a team subject", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        data: { interval: "hour", points: [] },
        meta: {
          requestId: "req-team-trend",
          generatedAt: "2026-08-02T00:00:00.000Z",
          timeRange: {
            from: "2026-08-01T00:00:00.000Z",
            to: "2026-08-02T00:00:00.000Z",
            timeZone: "UTC",
          },
          source: "raw",
          accuracy: "exact",
        },
      }),
    );
    const client = createApiV1GeneratedClient({
      baseUrl: "https://api.test",
      fetch: fetcher,
    });
    await expect(
      client.teamAnalyticsTimeseries({
        timeRange: overviewInput.timeRange,
        interval: "hour",
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://api.test/api/v1/team/analytics/timeseries",
    );
  });

  it("requests the team-site composite without treating it as a breakdown", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        data: {
          sites: [
            {
              siteId: "site-1",
              name: "Example",
              domain: "example.test",
              publicEnabled: false,
              publicSlug: null,
              createdAt: 0,
              updatedAt: 0,
              metrics: overviewData,
              lastEventAt: null,
            },
          ],
        },
        meta: {
          requestId: "req-team-sites",
          generatedAt: "2026-08-02T00:00:00.000Z",
          timeRange: {
            from: "2026-08-01T00:00:00.000Z",
            to: "2026-08-02T00:00:00.000Z",
            timeZone: "UTC",
          },
          source: "raw",
          accuracy: "exact",
        },
      }),
    );
    const client = createApiV1GeneratedClient({
      baseUrl: "https://api.test",
      fetch: fetcher,
    });
    await expect(
      client.teamAnalyticsSites({ timeRange: overviewInput.timeRange }),
    ).resolves.toMatchObject({
      ok: true,
      data: { sites: [{ siteId: "site-1" }] },
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://api.test/api/v1/team/analytics/sites",
    );
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
  });

  it("encodes the path-scoped breakdown dimension and validates its typed envelope", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        data: {
          dimension: "page.path",
          items: [
            {
              key: "/pricing",
              label: "/pricing",
              views: 10,
              sessions: 4,
              visitors: 3,
            },
          ],
        },
        meta: {
          requestId: "req-breakdown",
          generatedAt: "2026-08-02T00:00:00.000Z",
          timeRange: {
            from: overviewInput.timeRange.from,
            to: overviewInput.timeRange.to,
            timeZone: "UTC",
          },
          source: "raw",
          accuracy: "exact",
        },
      }),
    );
    const client = createApiV1GeneratedClient({
      baseUrl: "https://api.test",
      fetch: fetcher,
    });
    await expect(
      client.siteAnalyticsBreakdown("site/a", "page.path", {
        timeRange: overviewInput.timeRange,
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: { dimension: "page.path", items: [{ key: "/pricing" }] },
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://api.test/api/v1/sites/site%2Fa/analytics/breakdowns/page.path",
    );
  });

  it("posts a typed cross-breakdown query without putting dimensions in the URL", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        data: { columns: [], rows: [], totalVisitors: 0 },
        meta: {
          requestId: "req-cross-breakdown",
          generatedAt: "2026-08-02T00:00:00.000Z",
          timeRange: {
            from: overviewInput.timeRange.from,
            to: overviewInput.timeRange.to,
            timeZone: "UTC",
          },
          source: "raw",
          accuracy: "exact",
        },
      }),
    );
    const client = createApiV1GeneratedClient({
      baseUrl: "https://api.test",
      fetch: fetcher,
    });

    await expect(
      client.siteAnalyticsCrossBreakdown("site/a", {
        timeRange: overviewInput.timeRange,
        primaryDimension: "page.path",
        secondaryDimension: "client.browser",
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: { columns: [], rows: [], totalVisitors: 0 },
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://api.test/api/v1/sites/site%2Fa/analytics/cross-breakdowns",
    );
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
  });

  it("posts distinct typed page and referrer composite queries", async () => {
    const pagesFetch = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        data: { items: [] },
        meta: {
          requestId: "req-pages",
          generatedAt: "2026-08-02T00:00:00.000Z",
          timeRange: {
            from: overviewInput.timeRange.from,
            to: overviewInput.timeRange.to,
            timeZone: "UTC",
          },
          source: "raw",
          accuracy: "exact",
        },
      }),
    );
    const pagesClient = createApiV1GeneratedClient({
      baseUrl: "https://api.test",
      fetch: pagesFetch,
    });
    await expect(
      pagesClient.siteAnalyticsPages("site-1", {
        timeRange: overviewInput.timeRange,
      }),
    ).resolves.toMatchObject({ ok: true, data: { items: [] } });
    expect(pagesFetch.mock.calls[0]?.[0]).toBe(
      "https://api.test/api/v1/sites/site-1/analytics/pages",
    );

    const referrerFetch = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        data: { items: [] },
        meta: {
          requestId: "req-referrers",
          generatedAt: "2026-08-02T00:00:00.000Z",
          timeRange: {
            from: overviewInput.timeRange.from,
            to: overviewInput.timeRange.to,
            timeZone: "UTC",
          },
          source: "raw",
          accuracy: "exact",
        },
      }),
    );
    const referrerClient = createApiV1GeneratedClient({
      baseUrl: "https://api.test",
      fetch: referrerFetch,
    });
    await expect(
      referrerClient.siteAnalyticsReferrers("site-1", {
        timeRange: overviewInput.timeRange,
      }),
    ).resolves.toMatchObject({ ok: true, data: { items: [] } });
    expect(referrerFetch.mock.calls[0]?.[0]).toBe(
      "https://api.test/api/v1/sites/site-1/analytics/referrers",
    );

    const channelFetch = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        data: {
          items: [
            {
              channel: "organic_search",
              views: 10,
              sessions: 4,
              visitors: 3,
            },
          ],
        },
        meta: {
          requestId: "req-channels",
          generatedAt: "2026-08-02T00:00:00.000Z",
          timeRange: {
            from: overviewInput.timeRange.from,
            to: overviewInput.timeRange.to,
            timeZone: "UTC",
          },
          source: "raw",
          accuracy: "exact",
        },
      }),
    );
    const channelClient = createApiV1GeneratedClient({
      baseUrl: "https://api.test",
      fetch: channelFetch,
    });
    await expect(
      channelClient.siteAnalyticsChannels("site-1", {
        timeRange: overviewInput.timeRange,
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: { items: [{ channel: "organic_search" }] },
    });
    expect(channelFetch.mock.calls[0]?.[0]).toBe(
      "https://api.test/api/v1/sites/site-1/analytics/channels",
    );
  });

  it("posts filter-values with a body field and validates its typed envelope", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        data: {
          field: "page.path",
          items: [{ value: "/pricing", label: "/pricing", occurrences: 10 }],
          page: { limit: 50, hasMore: false, nextCursor: null },
        },
        meta: {
          requestId: "req-filter-values",
          generatedAt: "2026-08-02T00:00:00.000Z",
          timeRange: {
            from: overviewInput.timeRange.from,
            to: overviewInput.timeRange.to,
            timeZone: "UTC",
          },
          source: "raw",
          accuracy: "exact",
        },
      }),
    );
    const client = createApiV1GeneratedClient({
      baseUrl: "https://api.test",
      fetch: fetcher,
    });
    const result = await client.siteAnalyticsFilterValues("site-1", {
      timeRange: overviewInput.timeRange,
      field: "page.path",
    });
    expect(result).toMatchObject({
      ok: true,
      data: {
        field: "page.path",
        page: { limit: 50, hasMore: false, nextCursor: null },
      },
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://api.test/api/v1/sites/site-1/analytics/filter-values",
    );
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
    const requestInit = fetcher.mock.calls[0]?.[1];
    expect(JSON.parse(String(requestInit?.body))).toMatchObject({
      field: "page.path",
      page: { limit: 50 },
    });
  });

  it("posts typed retention cohort queries", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        data: {
          granularity: "week",
          cohorts: [
            {
              start: "2026-08-01T00:00:00.000Z",
              size: 10,
              periods: [{ index: 0, visitors: 10, rate: 1 }],
            },
          ],
        },
        meta: {
          requestId: "req-retention",
          generatedAt: "2026-08-02T00:00:00.000Z",
          timeRange: {
            from: overviewInput.timeRange.from,
            to: overviewInput.timeRange.to,
            timeZone: "UTC",
          },
          source: "raw",
          accuracy: "exact",
        },
      }),
    );
    const client = createApiV1GeneratedClient({
      baseUrl: "https://api.test",
      fetch: fetcher,
    });
    await expect(
      client.siteAnalyticsRetentionCohorts("site-1", {
        timeRange: overviewInput.timeRange,
        granularity: "week",
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: { granularity: "week", cohorts: [{ size: 10 }] },
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://api.test/api/v1/sites/site-1/analytics/retention/cohorts",
    );
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
  });

  it("posts funnel analysis with its opaque funnel ID in the JSON body", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        data: {
          funnel: {
            id: "funnel-1",
            siteId: "site-1",
            name: "Checkout",
            steps: [
              { type: "pageview", value: "/start" },
              { type: "event", value: "purchase" },
            ],
            createdAt: 1,
            updatedAt: 2,
          },
          analysis: {
            steps: [],
            summary: {
              totalSessions: 0,
              convertedSessions: 0,
              totalVisitors: 0,
              convertedVisitors: 0,
              overallConversionRate: 0,
              largestDropOffStepIndex: null,
            },
          },
        },
        meta: {
          requestId: "req-funnel",
          generatedAt: "2026-08-02T00:00:00.000Z",
          timeRange: {
            from: overviewInput.timeRange.from,
            to: overviewInput.timeRange.to,
            timeZone: "UTC",
          },
          source: "raw",
          accuracy: "exact",
        },
      }),
    );
    const client = createApiV1GeneratedClient({
      baseUrl: "https://api.test",
      fetch: fetcher,
    });

    await expect(
      client.siteAnalyticsFunnelAnalysis("site-1", {
        timeRange: overviewInput.timeRange,
        funnelId: "funnel-1",
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: { funnel: { id: "funnel-1" } },
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://api.test/api/v1/sites/site-1/analytics/funnel-analysis",
    );
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      funnelId: "funnel-1",
    });
  });

  it("posts typed performance summary and timeseries queries", async () => {
    const metrics = {
      ttfb: { avg: null, p50: null, p75: null, p95: null, samples: 0 },
      fcp: { avg: null, p50: null, p75: null, p95: null, samples: 0 },
      lcp: { avg: null, p50: null, p75: null, p95: null, samples: 0 },
      cls: { avg: null, p50: null, p75: null, p95: null, samples: 0 },
      inp: { avg: null, p50: null, p75: null, p95: null, samples: 0 },
    };
    const meta = {
      requestId: "req-performance",
      generatedAt: "2026-08-02T00:00:00.000Z",
      timeRange: {
        from: overviewInput.timeRange.from,
        to: overviewInput.timeRange.to,
        timeZone: "UTC",
      },
      source: "raw",
      accuracy: "exact",
    };
    const summaryFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ data: { metrics }, meta }));
    const summaryClient = createApiV1GeneratedClient({
      baseUrl: "https://api.test",
      fetch: summaryFetch,
    });
    await expect(
      summaryClient.siteAnalyticsPerformanceSummary("site-1", {
        timeRange: overviewInput.timeRange,
      }),
    ).resolves.toMatchObject({ ok: true, data: { metrics } });
    expect(summaryFetch.mock.calls[0]?.[0]).toBe(
      "https://api.test/api/v1/sites/site-1/analytics/performance/summary",
    );

    const seriesFetch = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        data: {
          interval: "day",
          series: { ttfb: [], fcp: [], lcp: [], cls: [], inp: [] },
        },
        meta,
      }),
    );
    const seriesClient = createApiV1GeneratedClient({
      baseUrl: "https://api.test",
      fetch: seriesFetch,
    });
    await expect(
      seriesClient.siteAnalyticsPerformanceTimeseries("site-1", {
        timeRange: overviewInput.timeRange,
        interval: "day",
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: { interval: "day" },
    });
    expect(seriesFetch.mock.calls[0]?.[0]).toBe(
      "https://api.test/api/v1/sites/site-1/analytics/performance/timeseries",
    );
    const breakdownFetch = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        data: {
          dimension: "page.path",
          metric: "lcp",
          items: [],
        },
        meta,
      }),
    );
    const breakdownClient = createApiV1GeneratedClient({
      baseUrl: "https://api.test",
      fetch: breakdownFetch,
    });
    await expect(
      breakdownClient.siteAnalyticsPerformanceBreakdown("site-1", "page.path", {
        timeRange: overviewInput.timeRange,
      }),
    ).resolves.toMatchObject({ ok: true, data: { dimension: "page.path" } });
    expect(breakdownFetch.mock.calls[0]?.[0]).toBe(
      "https://api.test/api/v1/sites/site-1/analytics/performance/breakdowns/page.path",
    );
  });

  it("posts typed event summary and timeseries queries", async () => {
    const meta = {
      requestId: "req-events",
      generatedAt: "2026-08-02T00:00:00.000Z",
      timeRange: {
        from: overviewInput.timeRange.from,
        to: overviewInput.timeRange.to,
        timeZone: "UTC",
      },
      source: "raw",
      accuracy: "exact",
    };
    const summaryFetch = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        data: {
          summary: {
            events: 3,
            eventTypes: 1,
            sessions: 2,
            visitors: 2,
            avgEventsPerSession: 1.5,
          },
          cards: {
            event: { name: [] },
            page: { path: [], title: [], hostname: [] },
          },
        },
        meta,
      }),
    );
    const summaryClient = createApiV1GeneratedClient({
      baseUrl: "https://api.test",
      fetch: summaryFetch,
    });
    await expect(
      summaryClient.siteAnalyticsEventsSummary("site-1", {
        timeRange: overviewInput.timeRange,
      }),
    ).resolves.toMatchObject({ ok: true, data: { summary: { events: 3 } } });
    expect(summaryFetch.mock.calls[0]?.[0]).toBe(
      "https://api.test/api/v1/sites/site-1/analytics/events/summary",
    );

    const seriesFetch = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        data: { interval: "day", series: [], points: [] },
        meta,
      }),
    );
    const seriesClient = createApiV1GeneratedClient({
      baseUrl: "https://api.test",
      fetch: seriesFetch,
    });
    await expect(
      seriesClient.siteAnalyticsEventsTimeseries("site-1", {
        timeRange: overviewInput.timeRange,
        interval: "day",
      }),
    ).resolves.toMatchObject({ ok: true, data: { interval: "day" } });
    expect(seriesFetch.mock.calls[0]?.[0]).toBe(
      "https://api.test/api/v1/sites/site-1/analytics/events/timeseries",
    );

    const recordsFetch = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        data: {
          items: [],
          page: { limit: 80, hasMore: false, nextCursor: null },
        },
        meta,
      }),
    );
    const recordsClient = createApiV1GeneratedClient({
      baseUrl: "https://api.test",
      fetch: recordsFetch,
    });
    await expect(
      recordsClient.siteAnalyticsEventsSearch("site-1", {
        timeRange: overviewInput.timeRange,
      }),
    ).resolves.toMatchObject({ ok: true, data: { items: [] } });
    expect(recordsFetch.mock.calls[0]?.[0]).toBe(
      "https://api.test/api/v1/sites/site-1/analytics/events/search",
    );

    const detail = {
      eventId: "evt",
      eventName: "signup",
      occurredAt: 1,
      receivedAt: 1,
      sequence: 1,
      visitId: "v",
      sessionId: "s",
      visitorId: "u",
      pathname: "/",
      title: "",
      hostname: "app.test",
      referrerHost: "",
      country: "",
      region: "",
      city: "",
      browser: "",
      browserVersion: "",
      os: "",
      osVersion: "",
      deviceType: "",
      nodeCount: 0,
      valueCount: 0,
    };
    const detailFetch = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        data: {
          event: detail,
          context: {
            visitId: "v",
            sessionId: "s",
            visitorId: "u",
            pathname: "/",
            title: "",
            hostname: "app.test",
            referrerHost: "",
            country: "",
            region: "",
            browser: "",
            browserVersion: "",
            os: "",
            osVersion: "",
            deviceType: "",
          },
          eventData: {},
        },
        meta,
      }),
    );
    const detailClient = createApiV1GeneratedClient({
      baseUrl: "https://api.test",
      fetch: detailFetch,
    });
    await expect(
      detailClient.siteAnalyticsEventDetail("site-1", {
        timeRange: overviewInput.timeRange,
        eventId: "evt",
      }),
    ).resolves.toMatchObject({ ok: true, data: { event: { eventId: "evt" } } });
    expect(detailFetch.mock.calls[0]?.[0]).toBe(
      "https://api.test/api/v1/sites/site-1/analytics/events/detail",
    );

    const eventTypesFetch = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        data: { items: [], page: { limit: 20 } },
        meta,
      }),
    );
    const eventTypesClient = createApiV1GeneratedClient({
      baseUrl: "https://api.test",
      fetch: eventTypesFetch,
    });
    await expect(
      eventTypesClient.siteAnalyticsEventTypes("site-1", {
        timeRange: overviewInput.timeRange,
      }),
    ).resolves.toMatchObject({ ok: true, data: { items: [] } });
    expect(eventTypesFetch.mock.calls[0]?.[0]).toBe(
      "https://api.test/api/v1/sites/site-1/analytics/event-types",
    );

    const eventFieldsFetch = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        data: { eventName: "signup", fields: [], page: { limit: 100 } },
        meta,
      }),
    );
    const eventFieldsClient = createApiV1GeneratedClient({
      baseUrl: "https://api.test",
      fetch: eventFieldsFetch,
    });
    await expect(
      eventFieldsClient.siteAnalyticsEventFields("site-1", {
        timeRange: overviewInput.timeRange,
        eventName: "signup",
      }),
    ).resolves.toMatchObject({ ok: true, data: { eventName: "signup" } });
    expect(eventFieldsFetch.mock.calls[0]?.[0]).toBe(
      "https://api.test/api/v1/sites/site-1/analytics/event-types/fields",
    );

    const fieldValuesFetch = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        data: {
          eventName: "signup",
          fieldPath: "plan",
          fieldValueType: "string",
          items: [],
          page: { limit: 25 },
        },
        meta,
      }),
    );
    const fieldValuesClient = createApiV1GeneratedClient({
      baseUrl: "https://api.test",
      fetch: fieldValuesFetch,
    });
    await expect(
      fieldValuesClient.siteAnalyticsEventFieldValues("site-1", {
        timeRange: overviewInput.timeRange,
        eventName: "signup",
        fieldPath: "plan",
        fieldValueType: "string",
      }),
    ).resolves.toMatchObject({ ok: true, data: { fieldPath: "plan" } });
    expect(fieldValuesFetch.mock.calls[0]?.[0]).toBe(
      "https://api.test/api/v1/sites/site-1/analytics/event-types/field-values",
    );

    const eventTypeDetailFetch = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        data: {
          eventName: "signup",
          summary: {
            events: 3,
            eventTypes: 1,
            sessions: 2,
            visitors: 2,
            avgEventsPerSession: 1.5,
            shareOfAllEvents: 1,
          },
          trend: { data: [] },
          breakdowns: { pages: [], countries: [], devices: [], browsers: [] },
          cards: {
            page: {
              path: [],
              query: [],
              title: [],
              hostname: [],
              entry: [],
              exit: [],
            },
            source: { domain: [], link: [] },
            client: {
              browser: [],
              osVersion: [],
              deviceType: [],
              language: [],
              screenSize: [],
            },
            geo: {
              country: [],
              region: [],
              city: [],
              continent: [],
              timezone: [],
              organization: [],
            },
          },
          fields: [],
        },
        meta,
      }),
    );
    const eventTypeDetailClient = createApiV1GeneratedClient({
      baseUrl: "https://api.test",
      fetch: eventTypeDetailFetch,
    });
    await expect(
      eventTypeDetailClient.siteAnalyticsEventTypeDetail("site-1", {
        timeRange: overviewInput.timeRange,
        eventName: "signup",
      }),
    ).resolves.toMatchObject({ ok: true, data: { eventName: "signup" } });
    expect(eventTypeDetailFetch.mock.calls[0]?.[0]).toBe(
      "https://api.test/api/v1/sites/site-1/analytics/event-types/detail",
    );

    const performance = {
      ttfb: { avg: null, p75: null, min: null, max: null, samples: 0 },
      fcp: { avg: null, p75: null, min: null, max: null, samples: 0 },
      lcp: { avg: null, p75: null, min: null, max: null, samples: 0 },
      cls: { avg: null, p75: null, min: null, max: null, samples: 0 },
      inp: { avg: null, p75: null, min: null, max: null, samples: 0 },
    };
    const session = {
      sessionId: "session-1",
      visitorId: "visitor-1",
      startedAt: 1,
      endedAt: 2,
      durationMs: 1,
      active: false,
      views: 1,
      events: 0,
      bounce: true,
      entryPath: "/",
      exitPath: "/",
      referrerHost: "",
      referrerUrl: "",
      country: "",
      region: "",
      regionCode: "",
      city: "",
      latitude: null,
      longitude: null,
      browser: "",
      browserVersion: "",
      os: "",
      osVersion: "",
      deviceType: "",
      screenWidth: null,
      screenHeight: null,
      performance: { ttfb: null, fcp: null, lcp: null, cls: null, inp: null },
    };
    const visitorDetailFetch = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        data: {
          visitor: {
            visitorId: "visitor-1",
            sessionId: "session-1",
            firstSeenAt: 1,
            lastSeenAt: 2,
            views: 1,
            sessions: 1,
            events: 0,
            country: "",
            region: "",
            regionCode: "",
            city: "",
            referrerHost: "",
            referrerUrl: "",
            browser: "",
            browserVersion: "",
            os: "",
            osVersion: "",
            deviceType: "",
            screenWidth: null,
            screenHeight: null,
          },
          metrics: {
            totalEvents: 0,
            sessions: 1,
            views: 1,
            avgEventsPerSession: 0,
            bounceRate: 1,
            avgDurationMs: 1,
            p90DurationMs: 1,
            firstSeenAt: 1,
            lastSeenAt: 2,
            daysActive: 1,
            conversionEvents: 0,
            avgTimeBetweenSessionsMs: 0,
          },
          sessions: [session],
          events: [],
          visitedPages: [],
          eventDistribution: [],
          activity: [],
          performance,
        },
        meta,
      }),
    );
    const visitorDetailClient = createApiV1GeneratedClient({
      baseUrl: "https://api.test",
      fetch: visitorDetailFetch,
    });
    await expect(
      visitorDetailClient.siteAnalyticsVisitorDetail("site-1", {
        timeRange: overviewInput.timeRange,
        visitorId: "visitor-1",
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: { visitor: { visitorId: "visitor-1" } },
    });
    expect(visitorDetailFetch.mock.calls[0]?.[0]).toBe(
      "https://api.test/api/v1/sites/site-1/analytics/visitors/detail",
    );

    const sessionDetailFetch = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        data: {
          session,
          locationPoints: [],
          events: [],
          visitedPages: [],
          eventDistribution: [],
          performance,
        },
        meta,
      }),
    );
    const sessionDetailClient = createApiV1GeneratedClient({
      baseUrl: "https://api.test",
      fetch: sessionDetailFetch,
    });
    await expect(
      sessionDetailClient.siteAnalyticsSessionDetail("site-1", {
        timeRange: overviewInput.timeRange,
        sessionId: "session-1",
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: { session: { sessionId: "session-1" } },
    });
    expect(sessionDetailFetch.mock.calls[0]?.[0]).toBe(
      "https://api.test/api/v1/sites/site-1/analytics/sessions/detail",
    );

    const visitorsSearchFetch = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        data: {
          items: [],
          page: { limit: 80, hasMore: false, nextCursor: null },
        },
        meta,
      }),
    );
    const visitorsSearchClient = createApiV1GeneratedClient({
      baseUrl: "https://api.test",
      fetch: visitorsSearchFetch,
    });
    await expect(
      visitorsSearchClient.siteAnalyticsVisitorsSearch("site-1", {
        timeRange: overviewInput.timeRange,
      }),
    ).resolves.toMatchObject({ ok: true, data: { items: [] } });
    expect(visitorsSearchFetch.mock.calls[0]?.[0]).toBe(
      "https://api.test/api/v1/sites/site-1/analytics/visitors/search",
    );

    const sessionsSearchFetch = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        data: {
          items: [],
          page: { limit: 80, hasMore: false, nextCursor: null },
        },
        meta,
      }),
    );
    const sessionsSearchClient = createApiV1GeneratedClient({
      baseUrl: "https://api.test",
      fetch: sessionsSearchFetch,
    });
    await expect(
      sessionsSearchClient.siteAnalyticsSessionsSearch("site-1", {
        timeRange: overviewInput.timeRange,
      }),
    ).resolves.toMatchObject({ ok: true, data: { items: [] } });
    expect(sessionsSearchFetch.mock.calls[0]?.[0]).toBe(
      "https://api.test/api/v1/sites/site-1/analytics/sessions/search",
    );
  });

  it("returns typed error envelopes and rejects malformed success envelopes", async () => {
    const errorFetch = vi.fn<typeof fetch>().mockResolvedValue(
      response(
        {
          error: { code: "resource_not_found", message: "missing" },
          meta: { requestId: "req-3" },
        },
        { status: 404 },
      ),
    );
    const errorClient = createApiV1GeneratedClient({
      baseUrl: "https://api.test",
      fetch: errorFetch,
    });
    const failure = await errorClient.getSavedFilter("site-1", "missing");
    expect(failure).toMatchObject({
      ok: false,
      status: 404,
      error: { code: "resource_not_found" },
    });

    const malformedClient = createApiV1GeneratedClient({
      baseUrl: "https://api.test",
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          response({ data: {}, meta: { requestId: "req-4" } }),
        ),
    });
    await expect(
      malformedClient.siteAnalyticsOverview("site-1", overviewInput),
    ).rejects.toBeInstanceOf(ApiV1GeneratedContractError);
  });

  it("fails closed when a JSON operation returns a non-JSON media type", async () => {
    const client = createApiV1GeneratedClient({
      baseUrl: "https://api.test",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({ data: overviewData, meta: { requestId: "req" } }),
          {
            headers: { "Content-Type": "text/plain" },
          },
        ),
      ),
    });
    await expect(
      client.siteAnalyticsOverview("site-1", overviewInput),
    ).rejects.toBeInstanceOf(ApiV1GeneratedContractError);
  });

  it("keeps mutation path parameters out of generated JSON request bodies", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        data: {
          trackPageviews: true,
          trackQuery: false,
          trackHash: false,
          trackCustomEvents: true,
          trackEngagement: true,
          trackWebVitals: false,
          autoTrackOutboundLinks: false,
          trackingStrength: "smart",
          allowedDomains: [],
          excludedPaths: [],
        },
        meta: { requestId: "req-resource" },
      }),
    );
    const client = createApiV1GeneratedClient({
      baseUrl: "https://api.test",
      fetch: fetcher,
    });

    await expect(
      client.updateTrackingSettings("site-1", { trackQuery: false }),
    ).resolves.toMatchObject({ ok: true });
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://api.test/api/v1/sites/site-1/settings/tracking",
    );
    const init = fetcher.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toEqual({ trackQuery: false });
  });

  it("exposes every typed resource command without path parameters in its input", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
      response(
        {
          error: { code: "resource_not_found", message: "missing" },
          meta: { requestId: "req-resource" },
        },
        { status: 404 },
      ),
    );
    const client = createApiV1GeneratedClient({
      baseUrl: "https://api.test",
      fetch: fetcher,
    });
    const funnel = {
      name: "Signup",
      steps: [
        { type: "pageview" as const, value: "/" },
        { type: "event" as const, value: "signup" },
      ],
    };

    await client.createSite({ name: "Example", domain: "example.test" });
    await client.getSite("site-1");
    await client.updateSite("site-1", { name: "Renamed" });
    await client.deleteSite("site-1");
    await client.getTrackingSettings("site-1");
    await client.updatePrivacySettings("site-1", { euMode: true });
    await client.getPrivacySettings("site-1");
    await client.getSharingSettings("site-1");
    await client.updateSharingSettings("site-1", {
      publicSlug: "public-example",
    });
    await client.getTrackingScript("site-1");
    await client.listFunnels("site-1");
    await client.createFunnel("site-1", funnel);
    await client.getFunnel("site-1", "funnel-1");
    await client.updateFunnel("site-1", "funnel-1", { name: "Updated" });
    await client.deleteFunnel("site-1", "funnel-1");

    expect(fetcher).toHaveBeenCalledTimes(15);
    const mutationBodies = fetcher.mock.calls
      .map(([, init]) => init)
      .filter((init) => init?.body)
      .map((init) => JSON.parse(String(init?.body)));
    expect(mutationBodies).not.toContainEqual(
      expect.objectContaining({ siteId: "site-1" }),
    );
    expect(mutationBodies).not.toContainEqual(
      expect.objectContaining({ funnelId: "funnel-1" }),
    );
  });

  it("posts typed journey trajectories and realtime reads to their dedicated paths", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
      response(
        {
          error: { code: "resource_not_found", message: "missing" },
          meta: { requestId: "req-trajectory" },
        },
        { status: 404 },
      ),
    );
    const client = createApiV1GeneratedClient({
      baseUrl: "https://api.test",
      fetch: fetcher,
    });
    const input = { timeRange: overviewInput.timeRange };
    await client.siteAnalyticsVisitorEvents("site-1", {
      ...input,
      visitorId: "visitor-1",
    });
    await client.siteAnalyticsVisitorSessions("site-1", {
      ...input,
      visitorId: "visitor-1",
    });
    await client.siteAnalyticsSessionEvents("site-1", {
      ...input,
      sessionId: "session-1",
    });
    await client.siteAnalyticsRealtimeSnapshot("site-1", input);
    await client.siteAnalyticsRealtimeActiveVisitors("site-1", input);
    await client.siteAnalyticsRealtimeEvents("site-1", input);
    await client.siteAnalyticsRealtimeSessions("site-1", input);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "https://api.test/api/v1/sites/site-1/analytics/visitors/events",
      "https://api.test/api/v1/sites/site-1/analytics/visitors/sessions",
      "https://api.test/api/v1/sites/site-1/analytics/sessions/events",
      "https://api.test/api/v1/sites/site-1/analytics/realtime/snapshot",
      "https://api.test/api/v1/sites/site-1/analytics/realtime/active-visitors",
      "https://api.test/api/v1/sites/site-1/analytics/realtime/events",
      "https://api.test/api/v1/sites/site-1/analytics/realtime/sessions",
    ]);
    for (const [, init] of fetcher.mock.calls)
      expect(init?.method).toBe("POST");
  });

  it("maps aborts and transport failures to stable typed errors", async () => {
    const abortController = new AbortController();
    abortController.abort();
    const aborted = createApiV1GeneratedClient({
      baseUrl: "https://api.test",
      fetch: vi.fn<typeof fetch>().mockRejectedValue(new Error("aborted")),
    });
    await expect(
      aborted.listSavedFilters("site-1", undefined, {
        signal: abortController.signal,
      }),
    ).rejects.toBeInstanceOf(ApiV1GeneratedAbortError);

    const failed = createApiV1GeneratedClient({
      baseUrl: "https://api.test",
      fetch: vi.fn<typeof fetch>().mockRejectedValue(new TypeError("redirect")),
    });
    await expect(failed.listSavedFilters("site-1")).rejects.toBeInstanceOf(
      ApiV1GeneratedTransportError,
    );

    const domAborted = createApiV1GeneratedClient({
      baseUrl: "https://api.test",
      fetch: vi
        .fn<typeof fetch>()
        .mockRejectedValue(new DOMException("aborted", "AbortError")),
    });
    await expect(domAborted.listSavedFilters("site-1")).rejects.toBeInstanceOf(
      ApiV1GeneratedAbortError,
    );
  });

  it("fails closed for invalid base URLs, JSON, metadata, and error envelopes", async () => {
    expect(() =>
      createApiV1GeneratedClient({ baseUrl: "javascript:alert(1)" }),
    ).toThrow(TypeError);

    const invalidJson = createApiV1GeneratedClient({
      baseUrl: "https://api.test",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response("not-json", {
          headers: { "content-type": "application/json" },
        }),
      ),
    });
    await expect(invalidJson.listSavedFilters("site-1")).rejects.toBeInstanceOf(
      ApiV1GeneratedContractError,
    );

    const invalidMeta = createApiV1GeneratedClient({
      baseUrl: "https://api.test",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        response({
          data: {
            items: [],
            page: {
              kind: "keyset",
              limit: 100,
              nextCursor: null,
              hasMore: false,
            },
          },
          meta: [],
        }),
      ),
    });
    await expect(invalidMeta.listSavedFilters("site-1")).rejects.toBeInstanceOf(
      ApiV1GeneratedContractError,
    );

    const invalidError = createApiV1GeneratedClient({
      baseUrl: "https://api.test",
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(response({}, { status: 400 })),
    });
    await expect(
      invalidError.listSavedFilters("site-1"),
    ).rejects.toBeInstanceOf(ApiV1GeneratedContractError);
  });

  it("validates JSON media variants and delete response contracts", async () => {
    const structuredJson = createApiV1GeneratedClient({
      baseUrl: "https://api.test",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        response(
          {
            data: {
              items: [],
              page: {
                kind: "keyset",
                limit: 100,
                nextCursor: null,
                hasMore: false,
              },
            },
            meta: { requestId: "req-json" },
          },
          { headers: { "content-type": "application/problem+json" } },
        ),
      ),
    });
    await expect(
      structuredJson.listSavedFilters("site-1"),
    ).resolves.toMatchObject({
      ok: true,
    });

    const invalidDelete = createApiV1GeneratedClient({
      baseUrl: "https://api.test",
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(response({ data: {} }, { status: 200 })),
    });
    await expect(invalidDelete.deleteSite("site-1")).rejects.toBeInstanceOf(
      ApiV1GeneratedContractError,
    );

    const abortController = new AbortController();
    abortController.abort();
    const abortedDelete = createApiV1GeneratedClient({
      baseUrl: "https://api.test",
      fetch: vi.fn<typeof fetch>().mockRejectedValue(new Error("aborted")),
    });
    await expect(
      abortedDelete.deleteSite("site-1", { signal: abortController.signal }),
    ).rejects.toBeInstanceOf(ApiV1GeneratedAbortError);

    const domAbortedDelete = createApiV1GeneratedClient({
      baseUrl: "https://api.test",
      fetch: vi
        .fn<typeof fetch>()
        .mockRejectedValue(new DOMException("aborted", "AbortError")),
    });
    await expect(domAbortedDelete.deleteSite("site-1")).rejects.toBeInstanceOf(
      ApiV1GeneratedAbortError,
    );

    const failedDelete = createApiV1GeneratedClient({
      baseUrl: "https://api.test",
      fetch: vi.fn<typeof fetch>().mockRejectedValue(new Error("offline")),
    });
    await expect(failedDelete.deleteSite("site-1")).rejects.toBeInstanceOf(
      ApiV1GeneratedTransportError,
    );
  });

  it("sends typed batch requests through the generated transport", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      response({
        data: { responses: [{ id: "one", status: 204, body: null }] },
        meta: { requestId: "req-batch", partialFailure: false },
      }),
    );
    const client = createApiV1GeneratedClient({
      baseUrl: "https://api.test",
      fetch,
      bearer: () => "secret",
    });
    await expect(
      client.batch({
        requests: [
          {
            id: "one",
            method: "POST",
            path: "/api/v1/sites/site-1/analytics/overview",
            body: {},
          },
        ],
      }),
    ).resolves.toMatchObject({
      data: { responses: [{ id: "one", status: 204, body: null }] },
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.test/api/v1/batch",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("accepts real 204 resource deletes without attempting JSON parsing", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const client = createApiV1GeneratedClient({
      baseUrl: "https://api.test",
      fetch,
    });
    await expect(client.deleteSite("site-1")).resolves.toMatchObject({
      ok: true,
      status: 204,
      data: undefined,
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.test/api/v1/sites/site-1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});
