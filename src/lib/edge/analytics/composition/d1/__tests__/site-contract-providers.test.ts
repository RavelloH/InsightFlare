import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/edge/analytics/providers/d1/internal/channels", () => ({
  queryChannelAggregate: vi.fn(),
}));
vi.mock(
  "@/lib/edge/analytics/providers/d1/internal/comparison-dimensions",
  () => ({
    decodeComparisonDimensionCursor: vi.fn(),
    queryComparisonDimensionPageFromD1: vi.fn(),
    queryComparisonSessionPathPageFromD1: vi.fn(),
  }),
);
vi.mock("@/lib/edge/analytics/providers/d1/internal/dimensions", () => ({
  decodeDimensionCursor: vi.fn(),
  decodeSessionPathDimensionCursor: vi.fn(),
  queryDimensionPageFromD1: vi.fn(),
  querySessionPathDimensionPageFromD1: vi.fn(),
}));
vi.mock("@/lib/edge/analytics/providers/d1/internal/filter-values", () => ({
  queryFilterValuesFromD1: vi.fn(),
  queryFilterValuesPageFromD1: vi.fn(),
}));
vi.mock("@/lib/edge/analytics/providers/d1/internal/journey-retention", () => ({
  parseRetentionGranularity: vi.fn((value) => value),
  queryRetentionFromD1: vi.fn(),
}));
vi.mock("@/lib/edge/analytics/providers/d1/internal/journeys", () => ({
  queryGeoPointAggregate: vi.fn(),
}));
vi.mock("@/lib/edge/analytics/providers/d1/internal/pages", () => ({
  decodePagesCursor: vi.fn(),
  queryDimensionAggregate: vi.fn(),
  queryPageCardMetricsFromD1: vi.fn(),
  queryPageTabsAggregate: vi.fn(),
  queryPagesAggregate: vi.fn(),
  queryPagesPageFromD1: vi.fn(),
}));
vi.mock("@/lib/edge/analytics/providers/d1/internal/referrers", () => ({
  decodeReferrersCursor: vi.fn(),
  queryReferrerAggregate: vi.fn(),
  queryReferrerSummaryFromD1: vi.fn(),
  queryReferrersPageFromD1: vi.fn(),
}));
vi.mock("@/lib/edge/analytics/providers/d1/internal/pages-dashboard", () => ({
  queryPagesDashboard: vi.fn(),
}));
vi.mock("@/lib/edge/analytics/providers/d1/internal/performance", () => ({
  queryPerformanceDashboardFromD1: vi.fn(),
}));
vi.mock(
  "@/lib/edge/analytics/providers/d1/operations/site-performance",
  () => ({
    readSitePerformanceBreakdown: vi.fn(),
    readSitePerformanceSummary: vi.fn(),
    readSitePerformanceTimeseries: vi.fn(),
  }),
);
import { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import {
  dimensionSelection,
  registerSiteContractProviders,
} from "@/lib/edge/analytics/composition/d1/site";
import {
  createQueryTime,
  EMPTY_FILTER_DOCUMENT,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { PAGE_DIMENSION_SELECTIONS } from "@/lib/edge/analytics/engine/dimension-report-plan";
import { queryChannelAggregate } from "@/lib/edge/analytics/providers/d1/internal/channels";
import {
  decodeComparisonDimensionCursor,
  queryComparisonDimensionPageFromD1,
  queryComparisonSessionPathPageFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/comparison-dimensions";
import {
  decodeDimensionCursor,
  decodeSessionPathDimensionCursor,
  queryDimensionPageFromD1,
  querySessionPathDimensionPageFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/dimensions";
import {
  queryFilterValuesFromD1,
  queryFilterValuesPageFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/filter-values";
import { queryGeoPointAggregate } from "@/lib/edge/analytics/providers/d1/internal/journeys";
import {
  decodePagesCursor,
  queryDimensionAggregate,
  queryPagesAggregate,
  queryPagesPageFromD1,
  queryPageTabsAggregate,
} from "@/lib/edge/analytics/providers/d1/internal/pages";
import { queryPagesDashboard } from "@/lib/edge/analytics/providers/d1/internal/pages-dashboard";
import { queryPerformanceDashboardFromD1 } from "@/lib/edge/analytics/providers/d1/internal/performance";
import {
  decodeReferrersCursor,
  queryReferrerAggregate,
  queryReferrersPageFromD1,
  queryReferrerSummaryFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/referrers";
import {
  readSitePerformanceBreakdown,
  readSitePerformanceSummary,
  readSitePerformanceTimeseries,
} from "@/lib/edge/analytics/providers/d1/operations/site-performance";
import type { Env } from "@/lib/edge/types";
const env = {} as Env;
const siteId = "site-provider";
const time = createQueryTime(0, 100, "UTC", 100);
const context = siteQueryContext(siteId, "public-share");
const dimensionPage = {
  items: [{ value: "Chrome", views: 5, sessions: 3, visitors: 2 }],
  pagination: {
    limit: 1,
    returned: 1,
    hasMore: true,
    nextCursor: "dimension-next",
  },
};
const pathPage = {
  items: [{ value: "/docs", views: 4, sessions: 3, visitors: 2 }],
  pagination: {
    limit: 1,
    returned: 1,
    hasMore: false,
    nextCursor: null,
  },
};
const referrerPage = {
  items: [{ referrer: "google.com", views: 8, sessions: 5, visitors: 4 }],
  pagination: {
    limit: 1,
    returned: 1,
    hasMore: false,
    nextCursor: null,
  },
};
function input(fields: Record<string, unknown> = {}) {
  return {
    context,
    time,
    filters: EMPTY_FILTER_DOCUMENT,
    ...fields,
  } as never;
}
function providers() {
  const registry = new AnalyticsProviderRegistry();
  registerSiteContractProviders(registry, { env, siteId });
  return registry;
}
describe("D1 site contract provider pagination routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(decodeComparisonDimensionCursor).mockResolvedValue(null);
    vi.mocked(queryComparisonDimensionPageFromD1).mockResolvedValue({
      items: [],
      pagination: pathPage.pagination,
    } as never);
    vi.mocked(queryComparisonSessionPathPageFromD1).mockResolvedValue({
      items: [],
      pagination: pathPage.pagination,
    } as never);
    vi.mocked(decodeDimensionCursor).mockResolvedValue(null);
    vi.mocked(decodeSessionPathDimensionCursor).mockResolvedValue(null);
    vi.mocked(decodePagesCursor).mockResolvedValue(null);
    vi.mocked(decodeReferrersCursor).mockResolvedValue(null);
    vi.mocked(queryDimensionPageFromD1).mockResolvedValue(dimensionPage);
    vi.mocked(querySessionPathDimensionPageFromD1).mockResolvedValue(pathPage);
    vi.mocked(queryFilterValuesPageFromD1).mockResolvedValue({
      items: [{ value: "US", occurrences: 4 }],
      pagination: pathPage.pagination,
    });
    vi.mocked(queryPagesPageFromD1).mockResolvedValue({
      items: [
        { pathname: "/docs", query: "", hash: "", views: 4, sessions: 3 },
      ],
      pagination: pathPage.pagination,
    });
    vi.mocked(queryReferrersPageFromD1).mockResolvedValue(referrerPage);
    vi.mocked(queryChannelAggregate).mockResolvedValue([
      { channel: "organic_search", views: 5, sessions: 3, visitors: 2 },
    ]);
    vi.mocked(queryFilterValuesFromD1).mockResolvedValue([
      { value: "US", occurrences: 4 },
    ]);
    vi.mocked(queryDimensionAggregate).mockResolvedValue([
      { value: "Chrome", views: 5, sessions: 3, visitors: 2 },
    ]);
    vi.mocked(queryPageTabsAggregate).mockResolvedValue({
      path: [],
      title: [],
      hostname: [],
      entry: [],
      exit: [],
    });
    vi.mocked(queryPagesAggregate).mockResolvedValue([
      { pathname: "/docs", query: "", hash: "", views: 4, sessions: 3 },
    ]);
    vi.mocked(queryReferrerAggregate).mockResolvedValue([
      { referrer: "google.com", views: 4, sessions: 3, visitors: 2 },
    ]);
    vi.mocked(queryReferrerSummaryFromD1).mockResolvedValue({
      totalViews: 5,
      directViews: 1,
      externalViews: 4,
      uniqueDomains: 2,
      uniqueLinks: 2,
      truncated: false,
      topSources: [],
    });
    vi.mocked(queryPagesDashboard).mockResolvedValue({
      interval: "day",
      items: [],
      pagination: {
        limit: 12,
        returned: 0,
        hasMore: false,
        nextCursor: null,
      },
    });
    vi.mocked(queryGeoPointAggregate).mockResolvedValue({
      points: [],
      countryCounts: [],
      regionCounts: [],
      cityCounts: [],
    });
    vi.mocked(queryPerformanceDashboardFromD1).mockResolvedValue({} as never);
    vi.mocked(readSitePerformanceSummary).mockResolvedValue({} as never);
    vi.mocked(readSitePerformanceTimeseries).mockResolvedValue({} as never);
    vi.mocked(readSitePerformanceBreakdown).mockResolvedValue({} as never);
  });

  it("routes overview tabs to the matching paginated reader", async () => {
    const provider = providers().resolve("dimension")!;
    for (const tab of [
      "page.path",
      "page.entry",
      "source.domain",
      "source.link",
      "source.channel",
      "client.browser",
      "geo.country",
    ]) {
      await provider.execute(input({ mode: "overview-tab", tab, limit: 1 }));
    }
    expect(queryDimensionPageFromD1).toHaveBeenCalled();
    expect(querySessionPathDimensionPageFromD1).toHaveBeenCalled();
    expect(queryReferrersPageFromD1).toHaveBeenCalled();
  });

  it("maps every admitted Comparison tab to its registered Logical selection", async () => {
    const provider = providers().resolve("dimension")!;
    const comparison = {
      metric: "views",
      sortBy: "current",
      direction: "desc",
    };
    const referenceTime = createQueryTime(100, 200, "UTC", 250);
    const tabs = [
      ["page.path", PAGE_DIMENSION_SELECTIONS.pagePathTrimmed],
      ["page.query", PAGE_DIMENSION_SELECTIONS.pageQueryTrimmed],
      ["page.title", PAGE_DIMENSION_SELECTIONS.pageTitleTrimmed],
      ["page.hostname", PAGE_DIMENSION_SELECTIONS.pageHostnameTrimmed],
      ["source.domain", PAGE_DIMENSION_SELECTIONS.referrerDomain],
      ["source.link", PAGE_DIMENSION_SELECTIONS.referrerUrl],
      ["source.channel", PAGE_DIMENSION_SELECTIONS.trafficChannel],
      ["client.browser", PAGE_DIMENSION_SELECTIONS.browser],
      ["client.osVersion", PAGE_DIMENSION_SELECTIONS.osVersion],
      ["client.deviceType", PAGE_DIMENSION_SELECTIONS.deviceType],
      ["client.language", PAGE_DIMENSION_SELECTIONS.language],
      ["client.screenSize", PAGE_DIMENSION_SELECTIONS.screenSize],
      ["utm.source", PAGE_DIMENSION_SELECTIONS.utmSource],
      ["utm.medium", PAGE_DIMENSION_SELECTIONS.utmMedium],
      ["utm.campaign", PAGE_DIMENSION_SELECTIONS.utmCampaign],
      ["utm.term", PAGE_DIMENSION_SELECTIONS.utmTerm],
      ["utm.content", PAGE_DIMENSION_SELECTIONS.utmContent],
      ["geo.country", PAGE_DIMENSION_SELECTIONS.countryTrimmed],
      ["geo.region", PAGE_DIMENSION_SELECTIONS.region],
      ["geo.city", PAGE_DIMENSION_SELECTIONS.city],
      ["geo.continent", PAGE_DIMENSION_SELECTIONS.continentTrimmed],
      ["geo.timezone", PAGE_DIMENSION_SELECTIONS.timezoneTrimmed],
      ["geo.organization", PAGE_DIMENSION_SELECTIONS.organizationTrimmed],
    ] as const;

    for (const [tab] of tabs) {
      await provider.execute(
        input({
          mode: "overview-tab",
          tab,
          limit: 1,
          comparison,
          current: { time, filters: EMPTY_FILTER_DOCUMENT },
          reference: { time: referenceTime, filters: EMPTY_FILTER_DOCUMENT },
        }),
      );
    }

    const calls = vi.mocked(queryComparisonDimensionPageFromD1).mock.calls;
    expect(calls).toHaveLength(tabs.length);
    for (const [index, [tab, selection]] of tabs.entries()) {
      expect(calls[index]?.[7]).toEqual(expect.any(String));
      expect(calls[index]?.[8]).toMatchObject({
        selection: { id: selection.id },
      });
      expect(
        vi.mocked(decodeComparisonDimensionCursor).mock.calls[index]?.[6],
      ).toBe(calls[index]?.[7]);
      expect(tab).toBeTruthy();
    }
  });

  it("dispatches typed performance modes through one canonical provider", async () => {
    const provider = providers().resolve("performance")!;
    await provider.execute(input({ mode: "summary" }));
    await provider.execute(input({ mode: "timeseries", interval: "day" }));
    await provider.execute(
      input({
        mode: "breakdown",
        dimension: "page.path",
        metric: "lcp",
        limit: 10,
      }),
    );
    await provider.execute(input({ mode: "dashboard", interval: "day" }));

    expect(readSitePerformanceSummary).toHaveBeenCalledWith(
      expect.objectContaining({ env, siteId }),
    );
    expect(readSitePerformanceTimeseries).toHaveBeenCalledWith(
      expect.objectContaining({ interval: "day" }),
    );
    expect(readSitePerformanceBreakdown).toHaveBeenCalledWith(
      expect.objectContaining({ dimension: "page.path", metric: "lcp" }),
    );
    expect(queryPerformanceDashboardFromD1).toHaveBeenCalled();
  });

  it("keeps bounded list and summary requests on their explicit paths", async () => {
    const registry = providers();
    await registry
      .resolve("dimension")!
      .execute(input({ dimension: "country" }));
    await registry
      .resolve("dimension")!
      .execute(input({ dimension: "utm.source", page: { limit: 1 } }));
    await registry.resolve("channels")!.execute(input());
    await registry
      .resolve("channels")!
      .execute(input({ tab: "source.channel" }));
    await registry
      .resolve("filter-values")!
      .execute(input({ field: "country" }));
    await registry
      .resolve("filter-values")!
      .execute(input({ field: "country", search: "us", page: { limit: 1 } }));
    await registry.resolve("pages")!.execute(input({ variant: "tabs" }));
    await registry.resolve("pages")!.execute(input({ includeDetails: true }));
    await registry
      .resolve("pages")!
      .execute(input({ includeDetails: true, page: { limit: 1 } }));
    await registry
      .resolve("referrers")!
      .execute(input({ variant: "summary", topN: 2 }));
    await registry
      .resolve("referrers")!
      .execute(input({ includeFullUrl: true }));
    await registry.resolve("referrers")!.execute(
      input({
        includeFullUrl: true,
        page: { limit: 1 },
        sort: "visitors",
        direction: "asc",
      }),
    );
    await registry
      .resolve("pages-dashboard")!
      .execute(input({ page: { limit: 3 } }));

    expect(queryDimensionPageFromD1).toHaveBeenCalled();
    expect(queryChannelAggregate).toHaveBeenCalled();
    expect(queryFilterValuesPageFromD1).toHaveBeenCalled();
    expect(queryPageTabsAggregate).toHaveBeenCalled();
    expect(queryPagesPageFromD1).toHaveBeenCalled();
    expect(queryReferrerSummaryFromD1).toHaveBeenCalledWith(
      env,
      siteId,
      expect.anything(),
      EMPTY_FILTER_DOCUMENT,
      2,
      undefined,
    );
    expect(queryReferrersPageFromD1).toHaveBeenCalled();
    expect(queryPagesDashboard).toHaveBeenCalled();
  });

  it("uses the audience-bound cursor and rejects malformed page cursors", async () => {
    const registry = providers();
    vi.mocked(decodePagesCursor).mockResolvedValue({
      views: 4,
      sessions: 3,
      pathname: "/docs",
      query: "",
      hash: "",
    });
    await registry
      .resolve("pages")!
      .execute(input({ page: { limit: 1, cursor: "signed" } }));
    expect(queryPagesPageFromD1).toHaveBeenCalledWith(
      env,
      siteId,
      expect.anything(),
      EMPTY_FILTER_DOCUMENT,
      1,
      false,
      expect.objectContaining({ pathname: "/docs" }),
      "public-share",
    );

    vi.mocked(decodeDimensionCursor).mockResolvedValue(null);
    await expect(
      registry
        .resolve("dimension")!
        .execute(
          input({ dimension: "country", page: { limit: 1, cursor: "bad" } }),
        ),
    ).rejects.toThrow("invalid-cursor");
  });

  it("maps dimension aliases used by API v1 and shared clients", () => {
    expect(dimensionSelection("country")).toMatchObject({
      id: "country",
      kind: "stored",
      attribute: "page.report.country",
      normalization: "raw",
    });
    expect(dimensionSelection("page.query")).toMatchObject({
      id: "pageQuery",
      normalization: "raw",
    });
    expect(dimensionSelection("page.hash")).toMatchObject({
      id: "pageHash",
      normalization: "raw",
    });
    expect(dimensionSelection("utm.source")).toMatchObject({
      id: "utmSource",
      normalization: "trim-ascii-space",
    });
    expect(dimensionSelection("custom.dimension")).toBeNull();
  });
});
