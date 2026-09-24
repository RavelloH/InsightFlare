import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateDemoDimension: vi.fn(() => ({ name: "dimension" })),
  generateDemoOverview: vi.fn(() => ({ name: "overview" })),
  generateDemoPages: vi.fn(() => ({ name: "pages" })),
  generateDemoPerformance: vi.fn(() => ({ name: "performance" })),
  generateDemoReferrers: vi.fn(() => ({ name: "referrers" })),
  generateDemoReferrerSummary: vi.fn(() => ({ name: "referrer-summary" })),
  generateDemoTrend: vi.fn(() => ({ name: "trend" })),
  findSiteProfileByPublicSlug: vi.fn(),
  generateDemoBrowserCrossBreakdown: vi.fn(() => ({ name: "browser-cross" })),
  generateDemoBrowserRadar: vi.fn(() => ({ name: "browser-radar" })),
  generateDemoBrowserVersionBreakdown: vi.fn(() => ({
    name: "browser-versions",
  })),
  generateDemoClientCrossBreakdown: vi.fn(() => ({ name: "client-cross" })),
  generateDemoReferrerRadar: vi.fn(() => ({ name: "referrer-radar" })),
  parseDemoInterval: vi.fn(() => "hour"),
  generateDemoBrowserEngineTrend: vi.fn(() => ({ name: "browser-engine" })),
  generateDemoBrowserTrend: vi.fn(() => ({ name: "browser-trend" })),
  generateDemoChannelTrend: vi.fn(() => ({ series: ["channel"], data: [1] })),
  generateDemoClientDimensionTrend: vi.fn(() => ({ name: "client-dimension" })),
  generateDemoReferrerTrend: vi.fn(() => ({ series: ["referrer"], data: [2] })),
  generateDemoOverviewClientTab: vi.fn(
    (_siteId: string, _params: unknown, tab: string) => ({ tab }),
  ),
  generateDemoOverviewGeoTab: vi.fn(
    (_siteId: string, _params: unknown, tab: string) => ({ tab }),
  ),
  generateDemoFilterValues: vi.fn(() => ({ name: "filter-values" })),
  generateDemoGeoPoints: vi.fn(() => ({ name: "geo-points" })),
  demoNotFoundResponse: vi.fn(() => ({ ok: false, status: 404 })),
  demoShareTrendDimension: vi.fn((result: unknown) => ({ result })),
  paginateDemoEnvelope: vi.fn((result: unknown) => ({ paginated: result })),
}));

vi.mock("@/lib/demo/analytics", () => ({
  generateDemoDimension: mocks.generateDemoDimension,
  generateDemoOverview: mocks.generateDemoOverview,
  generateDemoPages: mocks.generateDemoPages,
  generateDemoPerformance: mocks.generateDemoPerformance,
  generateDemoReferrers: mocks.generateDemoReferrers,
  generateDemoReferrerSummary: mocks.generateDemoReferrerSummary,
  generateDemoTrend: mocks.generateDemoTrend,
}));
vi.mock("@/lib/demo/data/site-profiles", () => ({
  findSiteProfileByPublicSlug: mocks.findSiteProfileByPublicSlug,
}));
vi.mock("@/lib/demo/realtime/browser-client", () => ({
  generateDemoBrowserCrossBreakdown: mocks.generateDemoBrowserCrossBreakdown,
  generateDemoBrowserRadar: mocks.generateDemoBrowserRadar,
  generateDemoBrowserVersionBreakdown:
    mocks.generateDemoBrowserVersionBreakdown,
  generateDemoClientCrossBreakdown: mocks.generateDemoClientCrossBreakdown,
  generateDemoReferrerRadar: mocks.generateDemoReferrerRadar,
}));
vi.mock("@/lib/demo/realtime/filters", () => ({
  parseDemoInterval: mocks.parseDemoInterval,
}));
vi.mock("@/lib/demo/realtime/share-trends", () => ({
  generateDemoBrowserEngineTrend: mocks.generateDemoBrowserEngineTrend,
  generateDemoBrowserTrend: mocks.generateDemoBrowserTrend,
  generateDemoChannelTrend: mocks.generateDemoChannelTrend,
  generateDemoClientDimensionTrend: mocks.generateDemoClientDimensionTrend,
  generateDemoReferrerTrend: mocks.generateDemoReferrerTrend,
}));
vi.mock("@/lib/demo/realtime/utm-overview", () => ({
  generateDemoFilterValues: mocks.generateDemoFilterValues,
  generateDemoGeoPoints: mocks.generateDemoGeoPoints,
  generateDemoOverviewClientTab: mocks.generateDemoOverviewClientTab,
  generateDemoOverviewGeoTab: mocks.generateDemoOverviewGeoTab,
}));
vi.mock("./shared", () => ({
  demoNotFoundResponse: mocks.demoNotFoundResponse,
  demoShareTrendDimension: mocks.demoShareTrendDimension,
  paginateDemoEnvelope: mocks.paginateDemoEnvelope,
}));

import type { DemoRuntimeContext } from "./context";
import {
  handleDemoPublicRoutes,
  handleDemoPublicSiteRoute,
} from "./public-routes";

const profile = {
  id: "site-1",
  publicSlug: "public-one",
  name: "Public Site",
  domain: "example.com",
} as never;
const baseContext = {
  path: "",
  method: "GET",
  params: { interval: "hour" },
  body: null,
  bodyRecord: {},
  siteId: "site-1",
  teamId: "team-1",
  locale: "en",
  publicSiteProfile: profile,
} satisfies DemoRuntimeContext;

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockClear();
  mocks.findSiteProfileByPublicSlug.mockReturnValue(null);
});

describe("demo public route dispatch", () => {
  it("resolves the shared-site route and handles missing profiles", () => {
    const path = "/api/public/share/a%20site/site";
    expect(handleDemoPublicSiteRoute({ ...baseContext, path })).toMatchObject({
      ok: true,
      data: { id: "site-1", slug: "a site", name: "Public Site" },
    });
    expect(
      handleDemoPublicSiteRoute({
        ...baseContext,
        path,
        publicSiteProfile: null,
      }),
    ).toMatchObject({ ok: false, status: 404 });
    expect(mocks.findSiteProfileByPublicSlug).toHaveBeenCalledWith("a site");
    mocks.findSiteProfileByPublicSlug.mockReturnValue(profile);
    expect(
      handleDemoPublicSiteRoute({
        ...baseContext,
        path,
        publicSiteProfile: null,
      }),
    ).toMatchObject({ ok: true, data: { id: "site-1" } });
    expect(
      handleDemoPublicSiteRoute({ ...baseContext, path: "/other" }),
    ).toBeUndefined();
  });

  it("dispatches all supported share analytics routes and returns not-found fallbacks", () => {
    const routes = [
      "overview",
      "trend",
      "pages",
      "referrers",
      "referrer-summary",
      "performance",
      "countries",
      "filter-values",
      "overview-geo-points",
      "overview-client-browser",
      "overview-client-os-version",
      "overview-client-device-type",
      "overview-client-language",
      "overview-client-screen-size",
      "overview-geo-country",
      "overview-geo-region",
      "overview-geo-city",
      "overview-geo-continent",
      "overview-geo-timezone",
      "overview-geo-organization",
      "browser-trend",
      "browser-engine-trend",
      "browser-version-breakdown",
      "browser-cross-breakdown",
      "browser-radar",
      "referrer-radar",
      "referrer-channel-dimension-trend",
      "referrer-dimension-trend",
      "client-dimension-trend",
      "client-cross-breakdown",
    ];
    for (const route of routes) {
      expect(
        handleDemoPublicRoutes({
          ...baseContext,
          path: `/api/public/share/public-one/${route}`,
        }),
      ).toBeDefined();
    }
    expect(mocks.generateDemoOverview).toHaveBeenCalledWith(
      "site-1",
      baseContext.params,
    );
    expect(mocks.generateDemoPages).toHaveBeenCalledWith(
      "site-1",
      baseContext.params,
      {
        includeTabs: false,
        defaultLimit: 20,
      },
    );
    expect(mocks.generateDemoReferrers).toHaveBeenCalledWith(
      "site-1",
      baseContext.params,
      {
        allowFullUrl: false,
        defaultLimit: 8,
      },
    );
    expect(mocks.generateDemoDimension).toHaveBeenCalledWith(
      "site-1",
      "countries",
      baseContext.params,
    );
    expect(mocks.generateDemoOverviewClientTab).toHaveBeenCalledTimes(5);
    expect(mocks.generateDemoOverviewGeoTab).toHaveBeenCalledTimes(6);
    expect(mocks.paginateDemoEnvelope).toHaveBeenCalledTimes(6);
    expect(mocks.generateDemoReferrerTrend).toHaveBeenCalledTimes(2);
    expect(mocks.demoShareTrendDimension).toHaveBeenCalledTimes(2);

    expect(
      handleDemoPublicRoutes({
        ...baseContext,
        path: "/api/public/share/public-one/overview-client-unknown",
      }),
    ).toMatchObject({ ok: false, status: 404 });
    expect(
      handleDemoPublicRoutes({
        ...baseContext,
        path: "/api/public/share/public-one/overview-geo-unknown",
      }),
    ).toMatchObject({ ok: false, status: 404 });
    expect(
      handleDemoPublicRoutes({
        ...baseContext,
        path: "/api/public/share/public-one/unknown",
      }),
    ).toMatchObject({ ok: false, status: 404 });
    expect(
      handleDemoPublicRoutes({
        ...baseContext,
        path: "/api/public/share/public-one/overview",
        publicSiteProfile: null,
      }),
    ).toMatchObject({ ok: false, status: 404 });
    expect(
      handleDemoPublicRoutes({ ...baseContext, path: "/other" }),
    ).toBeUndefined();
  });
});
