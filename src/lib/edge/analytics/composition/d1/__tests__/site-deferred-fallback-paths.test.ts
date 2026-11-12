import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    deferredEventNameDimensionQualificationFromQuery: vi.fn(),
    deferredPageDimensionQualificationFromQuery: vi.fn(),
    deferredPagesAggregatePageQualificationFromQuery: vi.fn(),
    deferredPagesTabsQualificationFromQuery: vi.fn(),
    deferredPerformanceSummaryQualificationFromQuery: vi.fn(),
    deferredSessionBoundaryOverviewPageQualificationFromQuery: vi.fn(),
    prepareDeferredEventQualificationFallback: vi.fn(),
    prepareDeferredPageVisitQualification: vi.fn(),
  }),
);
vi.mock(
  "@/lib/edge/analytics/providers/d1/internal/dimensions",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    decodeDimensionCursor: vi.fn(),
    decodeSessionPathDimensionCursor: vi.fn(),
    preflightQualifiedDimensionPageCursorFromD1: vi.fn(),
    queryDimensionPageFromD1: vi.fn(),
    querySessionPathDimensionPageFromD1: vi.fn(),
  }),
);
vi.mock(
  "@/lib/edge/analytics/providers/d1/internal/referrers",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    decodeReferrersCursor: vi.fn(),
    queryReferrersPageFromD1: vi.fn(),
  }),
);
vi.mock(
  "@/lib/edge/analytics/providers/d1/internal/events-summary",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    queryEventTypeAggregate: vi.fn(),
  }),
);
vi.mock(
  "@/lib/edge/analytics/providers/d1/internal/pages",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    decodePagesCursor: vi.fn(),
    pagesAggregatePageQualificationConsumerKey: vi.fn(() => "aggregate-key"),
    pagesTabsQualificationConsumerKey: vi.fn(() => "tabs-key"),
    queryPageTabsAggregate: vi.fn(),
    queryPagesPageFromD1: vi.fn(),
    queryPagesWithTabsFromD1: vi.fn(),
    queryQualifiedPagesAggregatePageFromD1: vi.fn(),
    queryQualifiedPagesTabsFromD1: vi.fn(),
  }),
);
vi.mock(
  "@/lib/edge/analytics/providers/d1/internal/performance",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    mapPerformanceSummaries: vi.fn(() => ({ mapped: true })),
    performancePageVisitQualificationConsumerKey: vi.fn(
      () => "performance-key",
    ),
    queryPerformanceDashboardFromD1: vi.fn(),
  }),
);
vi.mock(
  "@/lib/edge/analytics/providers/d1/internal/performance-summary-qualification-program",
  () => ({ executePerformanceSummaryQualificationProgram: vi.fn() }),
);
vi.mock(
  "@/lib/edge/analytics/providers/d1/internal/performance-timeseries-qualification-program",
  () => ({ executePerformanceTimeseriesQualificationProgram: vi.fn() }),
);
vi.mock(
  "@/lib/edge/analytics/providers/d1/internal/performance-breakdown-dashboard-qualification-program",
  () => ({
    executePerformanceBreakdownDashboardQualificationProgram: vi.fn(),
  }),
);
vi.mock(
  "@/lib/edge/analytics/providers/d1/operations/site-performance",
  () => ({
    readSitePerformanceBreakdown: vi.fn(),
    readSitePerformanceSummary: vi.fn(),
    readSitePerformanceTimeseries: vi.fn(),
    serializePerformanceBreakdown: vi.fn(),
    serializePerformanceTimeseries: vi.fn(),
  }),
);
vi.mock(
  "@/lib/edge/analytics/providers/d1/internal/geo-points-qualification-program",
  () => ({ executeGeoPointsQualificationProgram: vi.fn() }),
);
vi.mock(
  "@/lib/edge/analytics/providers/d1/internal/geo-points-qualification-request",
  () => ({
    deferredGeoPointsQualificationFromQuery: vi.fn(),
    geoPointsLimitFromQuery: vi.fn(() => 50),
  }),
);
vi.mock("@/lib/edge/analytics/providers/d1/internal/journeys", () => ({
  queryGeoPointAggregate: vi.fn(),
}));
vi.mock(
  "@/lib/edge/analytics/providers/d1/internal/retention-qualification-request",
  () => ({ deferredRetentionQualificationFromQuery: vi.fn() }),
);

import { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import { registerSiteContractProviders } from "@/lib/edge/analytics/composition/d1/site";
import {
  createQueryTime,
  EMPTY_FILTER_DOCUMENT,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import {
  deferredEventNameDimensionQualificationFromQuery,
  deferredPageDimensionQualificationFromQuery,
  deferredPagesAggregatePageQualificationFromQuery,
  deferredPagesTabsQualificationFromQuery,
  deferredPerformanceSummaryQualificationFromQuery,
  deferredSessionBoundaryOverviewPageQualificationFromQuery,
  prepareDeferredEventQualificationFallback,
  prepareDeferredPageVisitQualification,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import {
  decodeDimensionCursor,
  decodeSessionPathDimensionCursor,
  preflightQualifiedDimensionPageCursorFromD1,
  queryDimensionPageFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/dimensions";
import { queryEventTypeAggregate } from "@/lib/edge/analytics/providers/d1/internal/events-summary";
import { executeGeoPointsQualificationProgram } from "@/lib/edge/analytics/providers/d1/internal/geo-points-qualification-program";
import { deferredGeoPointsQualificationFromQuery } from "@/lib/edge/analytics/providers/d1/internal/geo-points-qualification-request";
import { queryGeoPointAggregate } from "@/lib/edge/analytics/providers/d1/internal/journeys";
import {
  decodePagesCursor,
  queryPagesPageFromD1,
  queryPagesWithTabsFromD1,
  queryPageTabsAggregate,
  queryQualifiedPagesAggregatePageFromD1,
  queryQualifiedPagesTabsFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/pages";
import { queryPerformanceDashboardFromD1 } from "@/lib/edge/analytics/providers/d1/internal/performance";
import { executePerformanceBreakdownDashboardQualificationProgram } from "@/lib/edge/analytics/providers/d1/internal/performance-breakdown-dashboard-qualification-program";
import { executePerformanceSummaryQualificationProgram } from "@/lib/edge/analytics/providers/d1/internal/performance-summary-qualification-program";
import { executePerformanceTimeseriesQualificationProgram } from "@/lib/edge/analytics/providers/d1/internal/performance-timeseries-qualification-program";
import {
  decodeReferrersCursor,
  queryReferrersPageFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/referrers";
import { deferredRetentionQualificationFromQuery } from "@/lib/edge/analytics/providers/d1/internal/retention-qualification-request";
import {
  readSitePerformanceBreakdown,
  readSitePerformanceSummary,
  readSitePerformanceTimeseries,
} from "@/lib/edge/analytics/providers/d1/operations/site-performance";
import type { Env } from "@/lib/edge/types";
import { InvalidCursorError } from "@/lib/pagination";

const env = {} as Env;
const siteId = "site-deferred";
const time = createQueryTime(0, 100, "UTC", 100);
const context = siteQueryContext(siteId, "public-share");
const emptyPagination = {
  limit: 1,
  returned: 0,
  hasMore: false,
  nextCursor: null,
};

function input(fields: Record<string, unknown> = {}) {
  return { context, time, filters: EMPTY_FILTER_DOCUMENT, ...fields } as never;
}

function provider(name: string) {
  const registry = new AnalyticsProviderRegistry();
  registerSiteContractProviders(registry, { env, siteId });
  return registry.resolve(name as never)!;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(decodeDimensionCursor).mockResolvedValue(null);
  vi.mocked(decodeSessionPathDimensionCursor).mockResolvedValue(null);
  vi.mocked(decodeReferrersCursor).mockResolvedValue(null);
  vi.mocked(decodePagesCursor).mockResolvedValue(null);
  vi.mocked(queryDimensionPageFromD1).mockResolvedValue({
    items: [{ value: "x", views: 1, sessions: 1, visitors: 1 }],
    pagination: emptyPagination,
  } as never);
  vi.mocked(queryReferrersPageFromD1).mockResolvedValue({
    items: [],
    pagination: emptyPagination,
  } as never);
});

describe("overview tab routing guards", () => {
  it("serves non-table page tabs through the legacy dimension reader", async () => {
    const result = (await provider("dimension").execute(
      input({ mode: "overview-tab", tab: "page.hash", limit: 1 }),
    )) as { data?: unknown };
    expect(queryDimensionPageFromD1).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).toContain('"views":1');
    await expect(
      provider("dimension").execute(
        input({
          mode: "overview-tab",
          tab: "page.hash",
          cursor: "bad-cursor",
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidCursorError);
  });

  it("rejects unknown page, client and geo tabs and returns empty UTM pages", async () => {
    const dimension = provider("dimension");
    await expect(
      dimension.execute(input({ mode: "overview-tab", tab: "page.bogus" })),
    ).rejects.toThrow("unsupported-dimension:page.bogus");
    await expect(
      dimension.execute(input({ mode: "overview-tab", tab: "client.bogus" })),
    ).rejects.toThrow("unsupported-dimension:client.bogus");
    await expect(
      dimension.execute(input({ mode: "overview-tab", tab: "geo.bogus" })),
    ).rejects.toThrow("unsupported-dimension:geo.bogus");
    expect(
      await dimension.execute(
        input({ mode: "overview-tab", tab: "utm.bogus", limit: 7 }),
      ),
    ).toMatchObject({
      value: {
        data: {
          items: [],
          pagination: { limit: 7, returned: 0, hasMore: false },
        },
      },
    });
  });

  it("rejects stale cursors on legacy channel and referrer readers", async () => {
    await expect(
      provider("dimension").execute(
        input({ mode: "overview-tab", tab: "source.channel", cursor: "stale" }),
      ),
    ).rejects.toBeInstanceOf(InvalidCursorError);
    await expect(
      provider("dimension").execute(
        input({
          mode: "overview-tab",
          tab: "source.link",
          cursor: "stale",
          comparison: {},
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidCursorError);
    expect(queryReferrersPageFromD1).not.toHaveBeenCalled();
    expect(queryDimensionPageFromD1).not.toHaveBeenCalled();
  });

  it("rejects stale session boundary cursors unless a deferred qualification can recover", async () => {
    const dimension = provider("dimension");
    vi.mocked(decodeSessionPathDimensionCursor).mockRejectedValueOnce(
      new InvalidCursorError("overview-tab"),
    );
    await expect(
      dimension.execute(input({ mode: "overview-tab", tab: "page.entry" })),
    ).rejects.toBeInstanceOf(InvalidCursorError);
    await expect(
      dimension.execute(
        input({ mode: "overview-tab", tab: "page.exit", cursor: "stale" }),
      ),
    ).rejects.toBeInstanceOf(InvalidCursorError);
    vi.mocked(decodeSessionPathDimensionCursor).mockRejectedValueOnce(
      new Error("storage"),
    );
    await expect(
      dimension.execute(input({ mode: "overview-tab", tab: "page.exit" })),
    ).rejects.toThrow("storage");
    expect(
      vi.mocked(deferredSessionBoundaryOverviewPageQualificationFromQuery),
    ).toHaveBeenCalled();
  });
});

describe("dimension list routing guards", () => {
  it("reads non-breakdown event name lists through the event type aggregate", async () => {
    vi.mocked(queryEventTypeAggregate).mockResolvedValue([
      { value: "signup", views: 3, sessions: 2, visitors: 2 },
    ] as never);
    const result = await provider("dimension").execute(
      input({ dimension: "event.name", limit: 4, search: "sign" }),
    );
    expect(queryEventTypeAggregate).toHaveBeenCalledWith(
      env,
      siteId,
      expect.anything(),
      EMPTY_FILTER_DOCUMENT,
      4,
      "sign",
    );
    expect(
      deferredEventNameDimensionQualificationFromQuery,
    ).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).toContain("signup");
  });

  it("preflights deferred dimension cursors before rejecting stale cursors", async () => {
    vi.mocked(deferredPageDimensionQualificationFromQuery).mockReturnValue({
      qualification: "deferred",
    } as never);
    await expect(
      provider("dimension").execute(
        input({
          dimension: "country",
          page: { limit: 1, cursor: "stale" },
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidCursorError);
    expect(preflightQualifiedDimensionPageCursorFromD1).toHaveBeenCalledTimes(
      1,
    );
    expect(queryDimensionPageFromD1).not.toHaveBeenCalled();
  });
});

describe("pages provider deferred fallbacks", () => {
  const plan = { id: "plan" };
  const tabsDeferred = (configuration: string) => ({
    pagesTabsRequest: { configuration },
    metadata: { plan },
  });
  const pagination = emptyPagination;

  beforeEach(() => {
    vi.mocked(prepareDeferredEventQualificationFallback).mockResolvedValue(
      "FALLBACK" as never,
    );
    vi.mocked(queryPageTabsAggregate).mockResolvedValue({
      tabs: true,
    } as never);
    vi.mocked(queryPagesWithTabsFromD1).mockResolvedValue({
      withTabs: true,
    } as never);
    vi.mocked(queryPagesPageFromD1).mockResolvedValue({
      items: [],
      pagination,
    } as never);
  });

  it("falls back for tabs-only requests with and without a Page visit preparation", async () => {
    vi.mocked(deferredPagesTabsQualificationFromQuery).mockReturnValue(
      tabsDeferred("tabs-only") as never,
    );
    vi.mocked(queryQualifiedPagesTabsFromD1).mockResolvedValue({
      kind: "fallback",
    } as never);
    vi.mocked(prepareDeferredPageVisitQualification).mockResolvedValueOnce({
      prepared: true,
    } as never);
    await provider("pages").execute(input({ variant: "tabs", limit: 5 }));
    expect(queryPageTabsAggregate).toHaveBeenLastCalledWith(
      env,
      siteId,
      expect.anything(),
      EMPTY_FILTER_DOCUMENT,
      5,
      expect.objectContaining({
        preparation: { prepared: true },
        scopePlan: plan,
        consumerKey: "tabs-key",
      }),
    );
    vi.mocked(prepareDeferredPageVisitQualification).mockResolvedValueOnce(
      null as never,
    );
    await provider("pages").execute(input({ variant: "tabs", limit: 5 }));
    expect(queryPageTabsAggregate).toHaveBeenLastCalledWith(
      env,
      siteId,
      expect.anything(),
      "FALLBACK",
      5,
    );
    vi.mocked(queryQualifiedPagesTabsFromD1).mockResolvedValue({
      kind: "executed",
      configuration: "pages-with-tabs",
    } as never);
    await expect(
      provider("pages").execute(input({ variant: "tabs" })),
    ).rejects.toThrow("pages_tabs_qualification_configuration_mismatch");
  });

  it("falls back for pages-with-tabs requests and validates cursors on each path", async () => {
    vi.mocked(deferredPagesTabsQualificationFromQuery).mockReturnValue(
      tabsDeferred("pages-with-tabs") as never,
    );
    vi.mocked(queryQualifiedPagesTabsFromD1).mockResolvedValue({
      kind: "fallback",
    } as never);
    const request = (cursor?: string) =>
      input({ includeTabs: true, page: { limit: 2, cursor } });

    vi.mocked(prepareDeferredPageVisitQualification).mockResolvedValue({
      prepared: true,
    } as never);
    await provider("pages").execute(request());
    expect(queryPagesWithTabsFromD1).toHaveBeenLastCalledWith(
      env,
      siteId,
      expect.anything(),
      EMPTY_FILTER_DOCUMENT,
      2,
      false,
      null,
      "public-share",
      expect.objectContaining({ consumerKey: "tabs-key", scopePlan: plan }),
    );
    await expect(provider("pages").execute(request("stale"))).rejects.toThrow(
      "invalid-cursor",
    );

    vi.mocked(prepareDeferredPageVisitQualification).mockResolvedValue(
      null as never,
    );
    await provider("pages").execute(request());
    expect(queryPagesWithTabsFromD1).toHaveBeenLastCalledWith(
      env,
      siteId,
      expect.anything(),
      "FALLBACK",
      2,
      false,
      null,
      "public-share",
    );
    await expect(provider("pages").execute(request("stale"))).rejects.toThrow(
      "invalid-cursor",
    );

    vi.mocked(queryQualifiedPagesTabsFromD1).mockResolvedValue({
      kind: "executed",
      configuration: "tabs-only",
    } as never);
    await expect(provider("pages").execute(request())).rejects.toThrow(
      "pages_tabs_qualification_configuration_mismatch",
    );
  });

  it("falls back for aggregate Page requests and validates cursors on each path", async () => {
    vi.mocked(deferredPagesAggregatePageQualificationFromQuery).mockReturnValue(
      {
        pagesAggregatePageRequest: {},
        metadata: { plan },
      } as never,
    );
    vi.mocked(queryQualifiedPagesAggregatePageFromD1).mockResolvedValue({
      kind: "fallback",
    } as never);
    const request = (cursor?: string) => input({ page: { limit: 3, cursor } });

    vi.mocked(prepareDeferredPageVisitQualification).mockResolvedValue({
      prepared: true,
    } as never);
    await provider("pages").execute(request());
    expect(queryPagesPageFromD1).toHaveBeenLastCalledWith(
      env,
      siteId,
      expect.anything(),
      EMPTY_FILTER_DOCUMENT,
      3,
      false,
      null,
      "public-share",
      expect.objectContaining({
        consumerKey: "aggregate-key",
        scopePlan: plan,
      }),
    );
    await expect(provider("pages").execute(request("stale"))).rejects.toThrow(
      "invalid-cursor",
    );

    vi.mocked(prepareDeferredPageVisitQualification).mockResolvedValue(
      null as never,
    );
    await provider("pages").execute(request());
    expect(queryPagesPageFromD1).toHaveBeenLastCalledWith(
      env,
      siteId,
      expect.anything(),
      "FALLBACK",
      3,
      false,
      null,
      "public-share",
    );
    await expect(provider("pages").execute(request("stale"))).rejects.toThrow(
      "invalid-cursor",
    );
  });

  it("rejects stale cursors on the unqualified pages readers", async () => {
    await expect(
      provider("pages").execute(
        input({ includeTabs: true, page: { limit: 2, cursor: "stale" } }),
      ),
    ).rejects.toThrow("invalid-cursor");
    await expect(
      provider("pages").execute(input({ page: { limit: 2, cursor: "stale" } })),
    ).rejects.toThrow("invalid-cursor");
  });
});

describe("performance provider deferred fallbacks", () => {
  const plan = { id: "perf-plan" };
  const configuration = (mode: string) => ({ mode, limit: 9 });
  const deferred = (mode: string) => ({
    configuration: configuration(mode),
    qualification: { metadata: { plan } },
  });

  beforeEach(() => {
    vi.mocked(prepareDeferredEventQualificationFallback).mockResolvedValue(
      "FALLBACK" as never,
    );
    vi.mocked(readSitePerformanceSummary).mockResolvedValue("summary" as never);
    vi.mocked(readSitePerformanceTimeseries).mockResolvedValue(
      "timeseries" as never,
    );
    vi.mocked(readSitePerformanceBreakdown).mockResolvedValue(
      "breakdown" as never,
    );
    vi.mocked(queryPerformanceDashboardFromD1).mockResolvedValue(
      "dashboard" as never,
    );
    for (const program of [
      executePerformanceSummaryQualificationProgram,
      executePerformanceTimeseriesQualificationProgram,
      executePerformanceBreakdownDashboardQualificationProgram,
    ])
      vi.mocked(program).mockResolvedValue({ kind: "fallback" } as never);
  });

  const modes = [
    ["summary", { mode: "summary" }, readSitePerformanceSummary],
    [
      "timeseries",
      { mode: "timeseries", interval: "day" },
      readSitePerformanceTimeseries,
    ],
    [
      "breakdown",
      { mode: "breakdown", dimension: "page.path", metric: "lcp" },
      readSitePerformanceBreakdown,
    ],
  ] as const;

  it.each(modes)(
    "%s uses the prepared Page visit qualification when available",
    async (mode, request, reader) => {
      vi.mocked(
        deferredPerformanceSummaryQualificationFromQuery,
      ).mockReturnValue(deferred(mode) as never);
      vi.mocked(prepareDeferredPageVisitQualification).mockResolvedValue({
        prepared: true,
      } as never);
      const value = await provider("performance").execute(input(request));
      expect(value).toEqual({ value: mode });
      expect(reader).toHaveBeenLastCalledWith(
        expect.objectContaining({
          filters: EMPTY_FILTER_DOCUMENT,
          qualification: expect.objectContaining({
            preparation: { prepared: true },
            scopePlan: plan,
          }),
        }),
      );
    },
  );

  it.each(modes)(
    "%s falls back to event-qualified filters without a preparation",
    async (mode, request, reader) => {
      vi.mocked(
        deferredPerformanceSummaryQualificationFromQuery,
      ).mockReturnValue(deferred(mode) as never);
      vi.mocked(prepareDeferredPageVisitQualification).mockResolvedValue(
        null as never,
      );
      const value = await provider("performance").execute(input(request));
      expect(value).toEqual({ value: mode });
      expect(reader).toHaveBeenLastCalledWith(
        expect.objectContaining({ filters: "FALLBACK" }),
      );
      expect(vi.mocked(reader).mock.calls.at(-1)?.[0]).not.toHaveProperty(
        "qualification",
      );
    },
  );

  it("dashboard falls back with and without a preparation", async () => {
    vi.mocked(deferredPerformanceSummaryQualificationFromQuery).mockReturnValue(
      deferred("dashboard") as never,
    );
    vi.mocked(prepareDeferredPageVisitQualification).mockResolvedValueOnce({
      prepared: true,
    } as never);
    await provider("performance").execute(
      input({ mode: "dashboard", interval: "day" }),
    );
    expect(queryPerformanceDashboardFromD1).toHaveBeenLastCalledWith(
      env,
      siteId,
      expect.anything(),
      "day",
      EMPTY_FILTER_DOCUMENT,
      18,
      expect.objectContaining({ preparation: { prepared: true } }),
    );
    vi.mocked(prepareDeferredPageVisitQualification).mockResolvedValueOnce(
      null as never,
    );
    await provider("performance").execute(
      input({ mode: "dashboard", interval: "day" }),
    );
    expect(queryPerformanceDashboardFromD1).toHaveBeenLastCalledWith(
      env,
      siteId,
      expect.anything(),
      "day",
      "FALLBACK",
      18,
    );
  });
});

describe("geo points and retention deferred fallbacks", () => {
  it("falls back from a deferred geo points program with and without a preparation", async () => {
    const diagnostics = { advancedCountSqlFallbackReason: undefined } as never;
    vi.mocked(deferredGeoPointsQualificationFromQuery).mockReturnValue({
      configuration: { limit: 11 },
      qualification: { metadata: { plan: "geo-plan" } },
    } as never);
    vi.mocked(executeGeoPointsQualificationProgram).mockResolvedValue({
      kind: "fallback",
      fallbackReason: "too-wide",
    } as never);
    vi.mocked(prepareDeferredEventQualificationFallback).mockResolvedValue(
      "FALLBACK" as never,
    );
    vi.mocked(queryGeoPointAggregate).mockResolvedValue({
      points: [],
      countryCounts: [],
      regionCounts: [],
      cityCounts: [],
    } as never);
    vi.mocked(prepareDeferredPageVisitQualification).mockResolvedValueOnce(
      null as never,
    );
    const registry = new AnalyticsProviderRegistry();
    registerSiteContractProviders(registry, { env, siteId, diagnostics });
    await registry.resolve("geo-points" as never)!.execute(input());
    expect(
      (diagnostics as { advancedCountSqlFallbackReason?: string })
        .advancedCountSqlFallbackReason,
    ).toBe("too-wide");
    expect(queryGeoPointAggregate).toHaveBeenLastCalledWith(
      env,
      siteId,
      expect.anything(),
      "FALLBACK",
      11,
    );
  });

  it("rejects a retention qualification that changed between classifications", async () => {
    vi.mocked(deferredRetentionQualificationFromQuery).mockReturnValue(
      undefined as never,
    );
    const events =
      await import("@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution");
    vi.spyOn(events, "deferredEventQualificationFromQuery").mockReturnValue({
      metadata: {},
    } as never);
    await expect(
      provider("retention").execute(input({ granularity: "week" })),
    ).rejects.toThrow("retention_qualification_request_changed");
  });
});
