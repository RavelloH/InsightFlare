import { beforeEach, describe, expect, it, vi } from "vitest";

import type { routeQuery as routeQueryFn } from "@/lib/edge/query/router";
import type { Env } from "@/lib/edge/types";

const handlerMocks = vi.hoisted(() => {
  const respond = (name: string) => async (): Promise<Response> =>
    new Response(name);

  return {
    core: {
      notFound: vi.fn(() => new Response("not-found", { status: 404 })),
      utmDimensionDefinition: vi.fn((key: string) => ({
        labelExpr: `utm_${key}_expr`,
      })),
    },
    events: {
      handleEventRecordDetail: vi.fn(respond("event-record-detail")),
      handleEventsRecords: vi.fn(respond("events-records")),
      handleEventsSummary: vi.fn(respond("events-summary")),
      handleEventsTrend: vi.fn(respond("events-trend")),
      handleEventTypeDetail: vi.fn(respond("event-type-detail")),
      handleEventTypeFieldValues: vi.fn(respond("event-type-field-values")),
      handleEventTypes: vi.fn(respond("event-types")),
    },
    journeys: {
      handleRetention: vi.fn(respond("retention")),
      handleSessionDetail: vi.fn(respond("session-detail")),
      handleSessions: vi.fn(respond("sessions")),
      handleVisitorDetail: vi.fn(respond("visitor-detail")),
      handleVisitors: vi.fn(respond("visitors")),
    },
    overview: {
      handleFilterOptions: vi.fn(respond("filter-options")),
      handleOverview: vi.fn(respond("overview")),
      handleOverviewClientTab: vi.fn(respond("overview-client-tab")),
      handleOverviewGeoPoints: vi.fn(respond("overview-geo-points")),
      handleOverviewGeoTab: vi.fn(respond("overview-geo-tab")),
      handleOverviewPageTab: vi.fn(respond("overview-page-tab")),
      handleOverviewSourceTab: vi.fn(respond("overview-source-tab")),
      handleTrend: vi.fn(respond("trend")),
    },
    pages: {
      handleDimension: vi.fn(respond("dimension")),
      handlePages: vi.fn(respond("pages")),
      handlePagesDashboard: vi.fn(respond("pages-dashboard")),
      handleReferrers: vi.fn(respond("referrers")),
    },
    funnels: {
      handleFunnel: vi.fn(respond("funnel")),
    },
    performance: {
      handlePerformance: vi.fn(respond("performance")),
    },
    technology: {
      handleBrowserCrossBreakdown: vi.fn(respond("browser-cross-breakdown")),
      handleBrowserEngineTrend: vi.fn(respond("browser-engine-trend")),
      handleBrowserRadar: vi.fn(respond("browser-radar")),
      handleBrowserTrend: vi.fn(respond("browser-trend")),
      handleBrowserVersionBreakdown: vi.fn(
        respond("browser-version-breakdown"),
      ),
      handleClientCrossBreakdown: vi.fn(respond("client-cross-breakdown")),
      handleClientDimensionTrend: vi.fn(respond("client-dimension-trend")),
      handleReferrerDimensionTrend: vi.fn(respond("referrer-dimension-trend")),
      handleReferrerRadar: vi.fn(respond("referrer-radar")),
      handleUtmDimensionTrend: vi.fn(respond("utm-dimension-trend")),
    },
  };
});

vi.mock("@/lib/edge/query/core", () => handlerMocks.core);
vi.mock("@/lib/edge/query/events", () => handlerMocks.events);
vi.mock("@/lib/edge/query/funnels", () => handlerMocks.funnels);
vi.mock("@/lib/edge/query/journeys", () => handlerMocks.journeys);
vi.mock("@/lib/edge/query/overview", () => handlerMocks.overview);
vi.mock("@/lib/edge/query/pages", () => handlerMocks.pages);
vi.mock("@/lib/edge/query/performance", () => handlerMocks.performance);
vi.mock("@/lib/edge/query/technology", () => handlerMocks.technology);

const { routeQuery } = (await import("@/lib/edge/query/router")) as {
  routeQuery: typeof routeQueryFn;
};

const env = {} as Env;
const siteId = "site-1";
const url = new URL("https://edge.test/api/private/overview");

async function route(pathname: string, publicMode = false) {
  return routeQuery(env, siteId, pathname, url, { publicMode });
}

async function responseText(pathname: string, publicMode = false) {
  return (await route(pathname, publicMode)).text();
}

describe("edge query router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps overview and trend available to public queries", async () => {
    await expect(responseText("overview", true)).resolves.toBe("overview");
    await expect(responseText("trend", true)).resolves.toBe("trend");

    expect(handlerMocks.overview.handleOverview).toHaveBeenCalledWith(
      env,
      siteId,
      url,
      undefined,
    );
    expect(handlerMocks.overview.handleTrend).toHaveBeenCalledWith(
      env,
      siteId,
      url,
      undefined,
    );
    expect(handlerMocks.core.notFound).not.toHaveBeenCalled();
  });

  it("blocks all non-public routes before dispatching handlers", async () => {
    const response = await route("sessions", true);

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("not-found");
    expect(handlerMocks.journeys.handleSessions).not.toHaveBeenCalled();
    expect(handlerMocks.core.notFound).toHaveBeenCalledTimes(1);
  });

  it("keeps campaign, retention, and page detail support queries available to public routes", async () => {
    await expect(responseText("retention", true)).resolves.toBe("retention");
    await expect(responseText("utm-source", true)).resolves.toBe("dimension");
    await expect(responseText("utm-dimension-trend", true)).resolves.toBe(
      "utm-dimension-trend",
    );
    await expect(responseText("event-types", true)).resolves.toBe(
      "event-types",
    );

    expect(handlerMocks.journeys.handleRetention).toHaveBeenCalledTimes(1);
    expect(handlerMocks.pages.handleDimension).toHaveBeenCalledTimes(1);
    expect(
      handlerMocks.technology.handleUtmDimensionTrend,
    ).toHaveBeenCalledTimes(1);
    expect(handlerMocks.events.handleEventTypes).toHaveBeenCalledTimes(1);
    expect(handlerMocks.core.notFound).not.toHaveBeenCalled();
  });

  it("routes private dashboard, event, journey, performance, and technology paths", async () => {
    await expect(responseText("pages-dashboard")).resolves.toBe(
      "pages-dashboard",
    );
    await expect(responseText("events-summary")).resolves.toBe(
      "events-summary",
    );
    await expect(responseText("sessions")).resolves.toBe("sessions");
    await expect(responseText("performance")).resolves.toBe("performance");
    await expect(responseText("browser-radar")).resolves.toBe("browser-radar");

    expect(handlerMocks.pages.handlePagesDashboard).toHaveBeenCalledTimes(1);
    expect(handlerMocks.events.handleEventsSummary).toHaveBeenCalledTimes(1);
    expect(handlerMocks.journeys.handleSessions).toHaveBeenCalledTimes(1);
    expect(handlerMocks.performance.handlePerformance).toHaveBeenCalledTimes(1);
    expect(handlerMocks.technology.handleBrowserRadar).toHaveBeenCalledTimes(1);
  });

  it("passes dimension expressions and fixed tab keys to shared handlers", async () => {
    await expect(responseText("page-hash")).resolves.toBe("dimension");
    await expect(responseText("page-query")).resolves.toBe("dimension");
    await expect(responseText("utm-medium")).resolves.toBe("dimension");
    await expect(responseText("utm-campaign")).resolves.toBe("dimension");
    await expect(responseText("utm-term")).resolves.toBe("dimension");
    await expect(responseText("utm-content")).resolves.toBe("dimension");
    await expect(responseText("countries")).resolves.toBe("dimension");
    await expect(responseText("overview-page-title")).resolves.toBe(
      "overview-page-tab",
    );
    await expect(responseText("overview-page-hostname")).resolves.toBe(
      "overview-page-tab",
    );
    await expect(responseText("overview-page-entry")).resolves.toBe(
      "overview-page-tab",
    );
    await expect(responseText("overview-page-exit")).resolves.toBe(
      "overview-page-tab",
    );
    await expect(responseText("overview-source-link")).resolves.toBe(
      "overview-source-tab",
    );
    await expect(responseText("overview-client-browser")).resolves.toBe(
      "overview-client-tab",
    );
    await expect(responseText("overview-client-os-version")).resolves.toBe(
      "overview-client-tab",
    );
    await expect(responseText("overview-client-device-type")).resolves.toBe(
      "overview-client-tab",
    );
    await expect(responseText("overview-client-language")).resolves.toBe(
      "overview-client-tab",
    );
    await expect(responseText("overview-client-screen-size")).resolves.toBe(
      "overview-client-tab",
    );
    await expect(responseText("overview-geo-city")).resolves.toBe(
      "overview-geo-tab",
    );
    await expect(responseText("overview-geo-continent")).resolves.toBe(
      "overview-geo-tab",
    );
    await expect(responseText("overview-geo-timezone")).resolves.toBe(
      "overview-geo-tab",
    );
    await expect(responseText("overview-geo-organization")).resolves.toBe(
      "overview-geo-tab",
    );

    expect(handlerMocks.pages.handleDimension).toHaveBeenNthCalledWith(
      1,
      env,
      siteId,
      url,
      "hash_fragment",
      undefined,
      undefined,
    );
    expect(handlerMocks.pages.handleDimension).toHaveBeenNthCalledWith(
      2,
      env,
      siteId,
      url,
      "query_string",
      undefined,
      undefined,
    );
    expect(handlerMocks.core.utmDimensionDefinition).toHaveBeenCalledWith(
      "medium",
    );
    expect(handlerMocks.core.utmDimensionDefinition).toHaveBeenCalledWith(
      "campaign",
    );
    expect(handlerMocks.core.utmDimensionDefinition).toHaveBeenCalledWith(
      "term",
    );
    expect(handlerMocks.core.utmDimensionDefinition).toHaveBeenCalledWith(
      "content",
    );
    expect(handlerMocks.pages.handleDimension).toHaveBeenNthCalledWith(
      4,
      env,
      siteId,
      url,
      "utm_campaign_expr",
      undefined,
      undefined,
    );
    expect(handlerMocks.pages.handleDimension).toHaveBeenNthCalledWith(
      7,
      env,
      siteId,
      url,
      "country",
      { ignoreGeo: true },
      undefined,
    );
    expect(handlerMocks.overview.handleOverviewPageTab).toHaveBeenCalledWith(
      env,
      siteId,
      url,
      "title",
      undefined,
    );
    expect(handlerMocks.overview.handleOverviewPageTab).toHaveBeenCalledWith(
      env,
      siteId,
      url,
      "hostname",
      undefined,
    );
    expect(handlerMocks.overview.handleOverviewPageTab).toHaveBeenCalledWith(
      env,
      siteId,
      url,
      "entry",
      undefined,
    );
    expect(handlerMocks.overview.handleOverviewPageTab).toHaveBeenCalledWith(
      env,
      siteId,
      url,
      "exit",
      undefined,
    );
    expect(handlerMocks.overview.handleOverviewSourceTab).toHaveBeenCalledWith(
      env,
      siteId,
      url,
      "link",
      undefined,
    );
    expect(handlerMocks.overview.handleOverviewClientTab).toHaveBeenCalledWith(
      env,
      siteId,
      url,
      "browser",
      undefined,
    );
    expect(handlerMocks.overview.handleOverviewClientTab).toHaveBeenCalledWith(
      env,
      siteId,
      url,
      "osVersion",
      undefined,
    );
    expect(handlerMocks.overview.handleOverviewClientTab).toHaveBeenCalledWith(
      env,
      siteId,
      url,
      "deviceType",
      undefined,
    );
    expect(handlerMocks.overview.handleOverviewClientTab).toHaveBeenCalledWith(
      env,
      siteId,
      url,
      "language",
      undefined,
    );
    expect(handlerMocks.overview.handleOverviewClientTab).toHaveBeenCalledWith(
      env,
      siteId,
      url,
      "screenSize",
      undefined,
    );
    expect(handlerMocks.overview.handleOverviewGeoTab).toHaveBeenCalledWith(
      env,
      siteId,
      url,
      "city",
      undefined,
    );
    expect(handlerMocks.overview.handleOverviewGeoTab).toHaveBeenCalledWith(
      env,
      siteId,
      url,
      "continent",
      undefined,
    );
    expect(handlerMocks.overview.handleOverviewGeoTab).toHaveBeenCalledWith(
      env,
      siteId,
      url,
      "timezone",
      undefined,
    );
    expect(handlerMocks.overview.handleOverviewGeoTab).toHaveBeenCalledWith(
      env,
      siteId,
      url,
      "organization",
      undefined,
    );
  });

  it("routes public pages and referrers advertised by the edge client", async () => {
    await expect(responseText("pages", true)).resolves.toBe("pages");
    await expect(responseText("referrers", true)).resolves.toBe("referrers");

    expect(handlerMocks.pages.handlePages).toHaveBeenCalledWith(
      env,
      siteId,
      url,
      false,
      undefined,
    );
    expect(handlerMocks.pages.handleReferrers).toHaveBeenCalledWith(
      env,
      siteId,
      url,
      8,
      false,
      undefined,
    );
  });

  it("routes the private funnel resource to its handler", async () => {
    await expect(responseText("funnels")).resolves.toBe("funnel");

    expect(handlerMocks.funnels.handleFunnel).toHaveBeenCalledWith(
      env,
      siteId,
      url,
      undefined,
      undefined,
    );
  });

  it("returns not found for unknown private routes", async () => {
    const response = await route("missing-route");

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("not-found");
  });
});
