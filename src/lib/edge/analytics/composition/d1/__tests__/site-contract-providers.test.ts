import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/edge/analytics/providers/d1/internal/channels", () => ({
  queryChannelAggregate: vi.fn(),
}));
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
  decodeReferrersCursor: vi.fn(),
  queryDimensionAggregate: vi.fn(),
  queryPageCardMetricsFromD1: vi.fn(),
  queryPageTabsAggregate: vi.fn(),
  queryPagesAggregate: vi.fn(),
  queryPagesDashboard: vi.fn(),
  queryPagesPageFromD1: vi.fn(),
  queryReferrerAggregate: vi.fn(),
  queryReferrerSummaryFromD1: vi.fn(),
  queryReferrersPageFromD1: vi.fn(),
}));
vi.mock("@/lib/edge/analytics/providers/d1/internal/performance", () => ({
  queryPerformanceDashboardFromD1: vi.fn(),
}));

import { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import {
  dimensionExpression,
  registerSiteContractProviders,
} from "@/lib/edge/analytics/composition/d1/site";
import {
  createQueryTime,
  EMPTY_FILTER_DOCUMENT,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { queryChannelAggregate } from "@/lib/edge/analytics/providers/d1/internal/channels";
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
  decodeReferrersCursor,
  queryDimensionAggregate,
  queryPagesAggregate,
  queryPagesDashboard,
  queryPagesPageFromD1,
  queryPageTabsAggregate,
  queryReferrerAggregate,
  queryReferrersPageFromD1,
  queryReferrerSummaryFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/pages";
import { queryPerformanceDashboardFromD1 } from "@/lib/edge/analytics/providers/d1/internal/performance";
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
      data: [],
      meta: {
        page: 1,
        pageSize: 12,
        returned: 0,
        hasMore: false,
        nextPage: null,
      },
    });
    vi.mocked(queryGeoPointAggregate).mockResolvedValue({
      points: [],
      countryCounts: [],
      regionCounts: [],
      cityCounts: [],
    });
    vi.mocked(queryPerformanceDashboardFromD1).mockResolvedValue({} as never);
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
      await provider.execute(input({ tab, limit: 1 }));
    }
    expect(queryDimensionPageFromD1).toHaveBeenCalled();
    expect(querySessionPathDimensionPageFromD1).toHaveBeenCalled();
    expect(queryReferrersPageFromD1).toHaveBeenCalled();
  });

  it("keeps aggregate and page requests on their explicit paths", async () => {
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
      .execute(input({ page: 2, pageSize: 3 }));

    expect(queryDimensionAggregate).toHaveBeenCalled();
    expect(queryDimensionPageFromD1).toHaveBeenCalled();
    expect(queryChannelAggregate).toHaveBeenCalled();
    expect(queryFilterValuesFromD1).toHaveBeenCalled();
    expect(queryFilterValuesPageFromD1).toHaveBeenCalled();
    expect(queryPageTabsAggregate).toHaveBeenCalled();
    expect(queryPagesAggregate).toHaveBeenCalled();
    expect(queryPagesPageFromD1).toHaveBeenCalled();
    expect(queryReferrerSummaryFromD1).toHaveBeenCalledWith(
      env,
      siteId,
      expect.anything(),
      EMPTY_FILTER_DOCUMENT,
      2,
    );
    expect(queryReferrerAggregate).toHaveBeenCalled();
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
    expect(dimensionExpression("country")).toBe("country");
    expect(dimensionExpression("page.query")).toBe("query_string");
    expect(dimensionExpression("page.hash")).toBe("hash_fragment");
    expect(dimensionExpression("utm.source")).not.toBe("utm.source");
    expect(dimensionExpression("custom.dimension")).toBe("custom.dimension");
  });
});
