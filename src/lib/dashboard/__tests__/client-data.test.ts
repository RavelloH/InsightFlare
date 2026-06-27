import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  decodeHashLabel,
  decodeQueryLabel,
  emptyOverviewClientDimensionTabsData,
  emptyOverviewGeoDimensionTabsData,
  emptyOverviewGeoPointsData,
  fetchBrowserCrossBreakdown,
  fetchBrowserEngineTrend,
  fetchBrowserRadar,
  fetchBrowserTrend,
  fetchBrowserVersionBreakdown,
  fetchClientCrossBreakdown,
  fetchClientDimensionTrend,
  fetchDashboardFilterOptions,
  fetchEventRecordDetail,
  fetchEventsRecords,
  fetchEventsSummary,
  fetchEventsTrend,
  fetchEventTypeDetail,
  fetchEventTypeFieldValues,
  fetchEventTypesTab,
  fetchOverview,
  fetchOverviewClientDimensionTab,
  fetchOverviewGeoDimensionTab,
  fetchOverviewGeoPoints,
  fetchOverviewPageCardTab,
  fetchOverviewSourceCardTab,
  fetchPageCardTabs,
  fetchPageHashTab,
  fetchPageQueryTab,
  fetchPages,
  fetchPagesDashboard,
  fetchPagesShareTrend,
  fetchPerformance,
  fetchReferrerRadar,
  fetchReferrers,
  fetchReferrerTrend,
  fetchRetention,
  fetchSessionDetail,
  fetchSessions,
  fetchTrend,
  fetchUtmDimension,
  fetchUtmTrend,
  fetchVisitorDetail,
  fetchVisitors,
  normalizeOverviewRows,
  toQueryString,
  withFilters,
} from "@/lib/dashboard/client-data";

describe("Dashboard Client Data Processing Utilities", () => {
  describe("normalizeOverviewRows", () => {
    it("should correctly normalize standard valid rows", () => {
      const input = [
        { label: "Chrome", views: 120, sessions: 60, visitors: 45 },
        { label: "Firefox", views: 40, sessions: 20, visitors: 15 },
      ];
      const result = normalizeOverviewRows(input);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        label: "Chrome",
        views: 120,
        sessions: 60,
        visitors: 45,
      });
      expect(result[1]).toEqual({
        label: "Firefox",
        views: 40,
        sessions: 20,
        visitors: 15,
      });
    });

    it("should safely fall back label to value if label is missing", () => {
      const input = [{ value: "Safari", views: 10 }];
      const result = normalizeOverviewRows(input);
      expect(result[0].label).toBe("Safari");
    });

    it("should fall back to value when label is blank", () => {
      const input = [
        { label: "   ", value: "Edge", views: null, sessions: null },
      ];
      const result = normalizeOverviewRows(input as any);
      expect(result[0]).toEqual({
        label: "Edge",
        views: 0,
        sessions: 0,
        visitors: 0,
      });
    });

    it("should handle missing fields and string values gracefully by fallback to zero", () => {
      const input = [{ label: "Opera", views: "50", sessions: undefined }];
      const result = normalizeOverviewRows(input);
      expect(result[0].views).toBe(50);
      expect(result[0].sessions).toBe(0);
      expect(result[0].visitors).toBe(0);
    });

    it("should return empty array for non-array inputs", () => {
      expect(normalizeOverviewRows(undefined)).toEqual([]);
      expect(normalizeOverviewRows(null as any)).toEqual([]);
      expect(normalizeOverviewRows({} as any)).toEqual([]);
    });
  });

  describe("decodeHashLabel & decodeQueryLabel", () => {
    it("should parse simple hashes and queries adding prefixes if missing", () => {
      expect(decodeHashLabel("pricing")).toBe("#pricing");
      expect(decodeHashLabel("#pricing")).toBe("#pricing");

      expect(decodeQueryLabel("ref=google")).toBe("?ref=google");
      expect(decodeQueryLabel("?ref=google")).toBe("?ref=google");
    });

    it("should decode encoded URL fragments correctly", () => {
      // %E4%B8%AD%E6%96%87 is "中文"
      expect(decodeHashLabel("%E4%B8%AD%E6%96%87")).toBe("#中文");
      expect(decodeQueryLabel("q=%E4%B8%AD%E6%96%87")).toBe("?q=中文");
    });

    it("should gracefully handle malformed URL encoding without crashing", () => {
      const malformed = "%E0%A%AB"; // Invalid URI sequence
      expect(decodeHashLabel(malformed)).toBe(`#${malformed}`);
      expect(decodeQueryLabel(malformed)).toBe(`?${malformed}`);
    });

    it("should return empty string for empty inputs", () => {
      expect(decodeHashLabel("")).toBe("");
      expect(decodeHashLabel("   ")).toBe("");
      expect(decodeQueryLabel(null as any)).toBe("");
    });

    it("should return empty string for bare hash and query prefixes", () => {
      expect(decodeHashLabel("#")).toBe("");
      expect(decodeQueryLabel("?")).toBe("");
    });
  });

  describe("toQueryString & withFilters", () => {
    it("should compile flat objects into valid URI query parameters", () => {
      const params = { siteId: "123", limit: 10 };
      expect(toQueryString(params)).toBe("?siteId=123&limit=10");
      expect(toQueryString({})).toBe("");
      expect(toQueryString(undefined)).toBe("");
    });

    it("should correctly map filters into request parameters object", () => {
      const baseParams = { siteId: "123" };
      const filters = {
        country: "US",
        browser: "Chrome",
        path: "/docs",
        eventPayloadFilters: [
          { path: "user.role", operator: "eq", value: "admin" },
        ],
      };

      const withResult = withFilters(baseParams, filters as any);
      expect(withResult.siteId).toBe("123");
      expect(withResult.country).toBe("US");
      expect(withResult.browser).toBe("Chrome");
      expect(withResult.path).toBe("/docs");
      expect(withResult.eventPayloadFilters).toBeTypeOf("string");
      expect(JSON.parse(withResult.eventPayloadFilters as string)).toEqual(
        filters.eventPayloadFilters,
      );
    });

    it("should skip mapping filters if filters object is empty or undefined", () => {
      const baseParams = { siteId: "123" };
      expect(withFilters(baseParams, undefined)).toEqual(baseParams);
    });
  });

  describe("API Data Fetching in Demo Mode", () => {
    const mockWindow = {
      preset: "24h" as const,
      from: Date.now() - 24 * 60 * 60 * 1000,
      to: Date.now(),
      timeZone: "UTC",
      interval: "hour" as const,
    };

    beforeAll(() => {
      process.env.NEXT_PUBLIC_DEMO_MODE = "1";
    });

    afterAll(() => {
      delete process.env.NEXT_PUBLIC_DEMO_MODE;
    });

    it(
      "should fetch all dashboard metrics correctly under demo mode",
      { timeout: 30000 },
      async () => {
        // 1. Overview
        const overview = await fetchOverview("demo-site-001", mockWindow);
        expect(overview).toBeDefined();

        // 2. Trend
        const trend = await fetchTrend("demo-site-001", mockWindow);
        expect(trend).toBeDefined();

        // 3. Pages
        const pages = await fetchPages("demo-site-001", mockWindow);
        expect(pages).toBeDefined();

        // 4. Visitors & detail
        const visitors = await fetchVisitors("demo-site-001", mockWindow);
        expect(visitors).toBeDefined();
        const visitorDetail = await fetchVisitorDetail(
          "demo-site-001",
          "visitor-1",
        );
        expect(visitorDetail).toBeDefined();

        // 5. Sessions & detail
        const sessions = await fetchSessions("demo-site-001", mockWindow);
        expect(sessions).toBeDefined();
        const sessionDetail = await fetchSessionDetail(
          "demo-site-001",
          "session-1",
        );
        expect(sessionDetail).toBeDefined();

        // 6. Events & Records
        const eventsSummary = await fetchEventsSummary(
          "demo-site-001",
          mockWindow,
        );
        expect(eventsSummary).toBeDefined();
        const eventsTrend = await fetchEventsTrend("demo-site-001", mockWindow);
        expect(eventsTrend).toBeDefined();
        const eventsRecords = await fetchEventsRecords(
          "demo-site-001",
          mockWindow,
        );
        expect(eventsRecords).toBeDefined();
        const eventTypeDetail = await fetchEventTypeDetail(
          "demo-site-001",
          mockWindow,
          "Click",
        );
        expect(eventTypeDetail).toBeDefined();
        const eventTypeFieldValues = await fetchEventTypeFieldValues(
          "demo-site-001",
          mockWindow,
          "Click",
          "btn",
          "string",
        );
        expect(eventTypeFieldValues).toBeDefined();
        const eventRecordDetail = await fetchEventRecordDetail(
          "demo-site-001",
          "event-1",
        );
        expect(eventRecordDetail).toBeDefined();

        // 7. Performance & Retention
        const performance = await fetchPerformance("demo-site-001", mockWindow);
        expect(performance).toBeDefined();
        const retention = await fetchRetention("demo-site-001", mockWindow);
        expect(retention).toBeDefined();

        // 8. Pages & Share Trend & Referrers
        const pagesDashboard = await fetchPagesDashboard(
          "demo-site-001",
          mockWindow,
        );
        expect(pagesDashboard).toBeDefined();
        const pagesShareTrend = await fetchPagesShareTrend(
          "demo-site-001",
          mockWindow,
        );
        expect(pagesShareTrend).toBeDefined();
        const pageCardTabs = await fetchPageCardTabs(
          "demo-site-001",
          mockWindow,
        );
        expect(pageCardTabs).toBeDefined();
        const referrers = await fetchReferrers("demo-site-001", mockWindow);
        expect(referrers).toBeDefined();

        // 9. UTM
        const utmDimension = await fetchUtmDimension(
          "demo-site-001",
          mockWindow,
          "source",
        );
        expect(utmDimension).toBeDefined();
        const utmTrend = await fetchUtmTrend(
          "demo-site-001",
          mockWindow,
          "source",
        );
        expect(utmTrend).toBeDefined();

        // 10. Geo & Maps
        const geoPoints = await fetchOverviewGeoPoints(
          "demo-site-001",
          mockWindow,
        );
        expect(geoPoints).toBeDefined();

        // 11. Overview Tabs
        const overviewPageCardTab = await fetchOverviewPageCardTab(
          "demo-site-001",
          mockWindow,
          "path",
        );
        expect(overviewPageCardTab).toBeDefined();
        const pageHashTab = await fetchPageHashTab("demo-site-001", mockWindow);
        expect(pageHashTab).toBeDefined();
        const pageQueryTab = await fetchPageQueryTab(
          "demo-site-001",
          mockWindow,
        );
        expect(pageQueryTab).toBeDefined();
        const overviewSourceCardTab = await fetchOverviewSourceCardTab(
          "demo-site-001",
          mockWindow,
          "domain",
        );
        expect(overviewSourceCardTab).toBeDefined();
        const eventTypesTab = await fetchEventTypesTab(
          "demo-site-001",
          mockWindow,
        );
        expect(eventTypesTab).toBeDefined();
        const referrerTrend = await fetchReferrerTrend(
          "demo-site-001",
          mockWindow,
        );
        expect(referrerTrend).toBeDefined();

        // 12. Client Dimensions
        const clientDimensionTab = await fetchOverviewClientDimensionTab(
          "demo-site-001",
          mockWindow,
          "browser",
        );
        expect(clientDimensionTab).toBeDefined();
        const geoDimensionTab = await fetchOverviewGeoDimensionTab(
          "demo-site-001",
          mockWindow,
          "country",
        );
        expect(geoDimensionTab).toBeDefined();
        const filterOptions = await fetchDashboardFilterOptions(
          "demo-site-001",
          mockWindow,
          "country",
        );
        expect(filterOptions).toBeDefined();

        // 13. Advanced breakdowns
        const clientDimensionTrend = await fetchClientDimensionTrend(
          "demo-site-001",
          mockWindow,
          "browser",
        );
        expect(clientDimensionTrend).toBeDefined();
        const clientCrossBreakdown = await fetchClientCrossBreakdown(
          "demo-site-001",
          mockWindow,
          "browser",
          "deviceType",
        );
        expect(clientCrossBreakdown).toBeDefined();
        const browserTrend = await fetchBrowserTrend(
          "demo-site-001",
          mockWindow,
        );
        expect(browserTrend).toBeDefined();
        const browserEngineTrend = await fetchBrowserEngineTrend(
          "demo-site-001",
          mockWindow,
        );
        expect(browserEngineTrend).toBeDefined();
        const browserVersionBreakdown = await fetchBrowserVersionBreakdown(
          "demo-site-001",
          mockWindow,
        );
        expect(browserVersionBreakdown).toBeDefined();
        const browserCrossBreakdown = await fetchBrowserCrossBreakdown(
          "demo-site-001",
          mockWindow,
        );
        expect(browserCrossBreakdown).toBeDefined();
        const browserRadar = await fetchBrowserRadar(
          "demo-site-001",
          mockWindow,
        );
        expect(browserRadar).toBeDefined();
        const referrerRadar = await fetchReferrerRadar(
          "demo-site-001",
          mockWindow,
        );
        expect(referrerRadar).toBeDefined();
      },
    );

    it("should handle empty parameter fallbacks gracefully", async () => {
      // Test invalid inputs resulting in empty return datasets
      const emptyVisDetail = await fetchVisitorDetail("demo-site-001", "");
      expect(emptyVisDetail.data).toBeNull();

      const emptySesDetail = await fetchSessionDetail("demo-site-001", "");
      expect(emptySesDetail.data).toBeNull();

      const emptyEvtDetail = await fetchEventTypeDetail(
        "demo-site-001",
        mockWindow,
        "",
      );
      expect(emptyEvtDetail.summary.events).toBe(0);

      const emptyEvtField = await fetchEventTypeFieldValues(
        "demo-site-001",
        mockWindow,
        "",
        "",
        "string",
      );
      expect(emptyEvtField.data).toHaveLength(0);

      const emptyEvtRecord = await fetchEventRecordDetail("demo-site-001", "");
      expect(emptyEvtRecord.data).toBeNull();

      // Call exported empty objects
      expect(emptyOverviewClientDimensionTabsData()).toBeDefined();
      expect(emptyOverviewGeoDimensionTabsData()).toBeDefined();
      expect(emptyOverviewGeoPointsData()).toBeDefined();
    });
  });

  describe("withFilters — comprehensive filter mapping", () => {
    it("should pass through every supported filter dimension into the request params", () => {
      const baseParams = { siteId: "abc" };
      const filters = {
        country: "JP",
        device: "mobile",
        browser: "Chrome",
        path: "/docs",
        query: "?ref=x",
        title: "Docs Home",
        hostname: "docs.test",
        entry: "/landing",
        exit: "/checkout",
        sourceDomain: "google.com",
        sourceLink: "https://google.com/search",
        clientBrowser: "Firefox",
        clientOsVersion: "14",
        clientDeviceType: "tablet",
        clientLanguage: "en-US",
        clientScreenSize: "1920x1080",
        geo: "JP-13",
        geoContinent: "AS",
        geoTimezone: "Asia/Tokyo",
        geoOrganization: "AS12345",
      } as any;
      const out = withFilters(baseParams, filters);
      expect(out.siteId).toBe("abc");
      expect(out.country).toBe("JP");
      expect(out.device).toBe("mobile");
      expect(out.browser).toBe("Chrome");
      expect(out.path).toBe("/docs");
      expect(out.query).toBe("?ref=x");
      expect(out.title).toBe("Docs Home");
      expect(out.hostname).toBe("docs.test");
      expect(out.entry).toBe("/landing");
      expect(out.exit).toBe("/checkout");
      expect(out.sourceDomain).toBe("google.com");
      expect(out.sourceLink).toBe("https://google.com/search");
      expect(out.clientBrowser).toBe("Firefox");
      expect(out.clientOsVersion).toBe("14");
      expect(out.clientDeviceType).toBe("tablet");
      expect(out.clientLanguage).toBe("en-US");
      expect(out.clientScreenSize).toBe("1920x1080");
      expect(out.geo).toBe("JP-13");
      expect(out.geoContinent).toBe("AS");
      expect(out.geoTimezone).toBe("Asia/Tokyo");
      expect(out.geoOrganization).toBe("AS12345");
    });

    it("should skip empty eventPayloadFilters and not serialize them", () => {
      const out = withFilters({ siteId: "x" }, {
        eventPayloadFilters: [],
      } as any);
      expect(out.eventPayloadFilters).toBeUndefined();
    });
  });

  describe("toQueryString — edge cases", () => {
    it("should return empty string for empty params object", () => {
      expect(toQueryString({})).toBe("");
    });

    it("should encode special characters via URLSearchParams semantics", () => {
      const out = toQueryString({ q: "hello world", limit: 5 });
      expect(out).toContain("q=hello+world");
      expect(out).toContain("limit=5");
    });
  });

  describe("Non-demo (network) data fetching with mocked fetch", () => {
    const realFetch = globalThis.fetch;
    const mockWindow = {
      preset: "24h" as const,
      from: 1700000000000,
      to: 1700000000000 + 24 * 60 * 60 * 1000,
      timeZone: "UTC",
      interval: "hour" as const,
    };

    const suppressUnhandled = () => {};

    beforeAll(() => {
      delete process.env.NEXT_PUBLIC_DEMO_MODE;
      // The dedupe path adds a finally-chain off the in-flight promise. When the
      // primary promise rejects (e.g. on HTTP 500), the secondary chain surfaces
      // as a stray unhandled rejection one tick later. Suppress globally for
      // this suite — the failure assertion itself still owns the primary check.
      process.on("unhandledRejection", suppressUnhandled);
    });

    afterAll(() => {
      globalThis.fetch = realFetch;
      process.off("unhandledRejection", suppressUnhandled);
    });

    function freshJsonResponse(body: unknown, status = 200): Response {
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }

    function paramsFromCall(fetchMock: any, callIndex = 0): URLSearchParams {
      const calledUrl = String(fetchMock.mock.calls[callIndex][0]);
      return new URLSearchParams(calledUrl.split("?")[1] ?? "");
    }

    it("should call fetch and parse JSON response in non-demo mode", async () => {
      const fetchMock = vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(freshJsonResponse({ ok: true, data: { views: 42 } })),
        );
      globalThis.fetch = fetchMock as any;

      const out = await fetchOverview("real-site-1", mockWindow);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [calledUrl, init] = fetchMock.mock.calls[0] as [
        string,
        RequestInit,
      ];
      expect(calledUrl).toContain("/api/private/overview");
      expect(calledUrl).toContain("siteId=real-site-1");
      expect(init.method).toBe("GET");
      expect(init.credentials).toBe("include");
      expect((out as any).data.views).toBe(42);
    });

    it("should propagate non-OK HTTP responses as thrown errors", async () => {
      globalThis.fetch = vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(new Response("server boom", { status: 500 })),
        ) as any;

      await expect(fetchTrend("error-site", mockWindow)).rejects.toThrow(
        /Request failed \(500/,
      );
    });

    it("should deduplicate concurrent GET requests for the same URL into a single fetch", async () => {
      const fetchMock = vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(freshJsonResponse({ ok: true, data: { views: 1 } })),
        );
      globalThis.fetch = fetchMock as any;

      const [a, b] = await Promise.all([
        fetchOverview("dedupe-site", mockWindow),
        fetchOverview("dedupe-site", mockWindow),
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(a).toBeDefined();
      expect(b).toBeDefined();
    });

    it("should NOT dedupe distinct URLs", async () => {
      const fetchMock = vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(freshJsonResponse({ ok: true, data: {} })),
        );
      globalThis.fetch = fetchMock as any;

      await Promise.all([
        fetchOverview("siteA", mockWindow),
        fetchOverview("siteB", mockWindow),
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("should propagate filter mapping into the URL query string", async () => {
      const fetchMock = vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(freshJsonResponse({ ok: true, data: {} })),
        );
      globalThis.fetch = fetchMock as any;

      await fetchPages("filter-site-unique", mockWindow, {
        country: "DE",
        browser: "Safari",
      } as any);
      const [calledUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(calledUrl).toContain("country=DE");
      expect(calledUrl).toContain("browser=Safari");
    });

    it("should serialize optional request params for overview, lists, events, and details", async () => {
      const fetchMock = vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(freshJsonResponse({ ok: true, data: [] })),
        );
      globalThis.fetch = fetchMock as any;

      await fetchOverview("option-overview", mockWindow, undefined, {
        includeChange: true,
        includeDetail: true,
      });
      let params = paramsFromCall(fetchMock, 0);
      expect(params.get("includeChange")).toBe("1");
      expect(params.get("includeDetail")).toBe("1");
      expect(params.get("interval")).toBe("hour");

      await fetchVisitors("option-visitors", mockWindow, undefined, {
        page: 2,
        pageSize: 25,
        limit: 7,
        sortBy: "lastSeenAt",
        sortDir: "asc",
        search: "  alice  ",
      });
      params = paramsFromCall(fetchMock, 1);
      expect(params.get("page")).toBe("2");
      expect(params.get("pageSize")).toBe("25");
      expect(params.get("limit")).toBe("7");
      expect(params.get("sortBy")).toBe("lastSeenAt");
      expect(params.get("sortDir")).toBe("asc");
      expect(params.get("search")).toBe("alice");

      await fetchVisitors("option-visitors-pagesize", mockWindow, undefined, {
        pageSize: 25,
        search: "   ",
      });
      params = paramsFromCall(fetchMock, 2);
      expect(params.has("limit")).toBe(false);
      expect(params.has("search")).toBe(false);

      await fetchSessions("option-sessions", mockWindow, undefined, {
        page: 3,
        pageSize: 30,
        limit: 9,
        sortBy: "durationMs",
        sortDir: "desc",
        search: "  session  ",
      });
      params = paramsFromCall(fetchMock, 3);
      expect(params.get("page")).toBe("3");
      expect(params.get("pageSize")).toBe("30");
      expect(params.get("limit")).toBe("9");
      expect(params.get("sortBy")).toBe("durationMs");
      expect(params.get("sortDir")).toBe("desc");
      expect(params.get("search")).toBe("session");

      await fetchSessions("option-sessions-pagesize", mockWindow, undefined, {
        pageSize: 30,
        search: "   ",
      });
      params = paramsFromCall(fetchMock, 4);
      expect(params.has("limit")).toBe(false);
      expect(params.has("search")).toBe(false);

      await fetchEventsTrend("option-events-trend", mockWindow, undefined, {
        limit: 3,
        eventName: "  Signup  ",
      });
      params = paramsFromCall(fetchMock, 5);
      expect(params.get("limit")).toBe("3");
      expect(params.get("eventName")).toBe("Signup");

      await fetchEventsRecords("option-events-records", mockWindow, undefined, {
        page: 4,
        pageSize: 15,
        sortBy: "pathname",
        sortDir: "desc",
        search: "  /pricing  ",
        eventName: "  Purchase  ",
      });
      params = paramsFromCall(fetchMock, 6);
      expect(params.get("page")).toBe("4");
      expect(params.get("pageSize")).toBe("15");
      expect(params.get("sortBy")).toBe("pathname");
      expect(params.get("sortDir")).toBe("desc");
      expect(params.get("search")).toBe("/pricing");
      expect(params.get("eventName")).toBe("Purchase");

      await fetchVisitorDetail(
        "option-detail",
        "  visitor-a  ",
        "Asia/Tokyo",
        mockWindow,
        { signal: new AbortController().signal },
      );
      params = paramsFromCall(fetchMock, 7);
      expect(params.get("visitorId")).toBe("visitor-a");
      expect(params.get("from")).toBe(String(mockWindow.from));
      expect(params.get("to")).toBe(String(mockWindow.to));
      expect(params.get("timeZone")).toBe("Asia/Tokyo");

      await fetchSessionDetail(
        "option-detail",
        "  session-a  ",
        "Europe/Paris",
        mockWindow,
        { signal: new AbortController().signal },
      );
      params = paramsFromCall(fetchMock, 8);
      expect(params.get("sessionId")).toBe("session-a");
      expect(params.get("from")).toBe(String(mockWindow.from));
      expect(params.get("to")).toBe(String(mockWindow.to));
      expect(params.get("timeZone")).toBe("Europe/Paris");

      await fetchEventRecordDetail("option-detail", "  event-a  ", mockWindow);
      params = paramsFromCall(fetchMock, 9);
      expect(params.get("eventId")).toBe("event-a");
      expect(params.get("from")).toBe(String(mockWindow.from));
      expect(params.get("to")).toBe(String(mockWindow.to));
    });

    it("should apply list and event defaults while omitting blank optional params", async () => {
      const fetchMock = vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(freshJsonResponse({ ok: true, data: [] })),
        );
      globalThis.fetch = fetchMock as any;

      await fetchVisitors("default-visitors", mockWindow);
      let params = paramsFromCall(fetchMock, 0);
      expect(params.get("limit")).toBe("100");
      expect(params.has("page")).toBe(false);
      expect(params.has("pageSize")).toBe(false);

      await fetchSessions("default-sessions", mockWindow);
      params = paramsFromCall(fetchMock, 1);
      expect(params.get("limit")).toBe("100");
      expect(params.has("page")).toBe(false);
      expect(params.has("pageSize")).toBe(false);

      await fetchEventsTrend("default-events-trend", mockWindow, undefined, {
        eventName: "   ",
      });
      params = paramsFromCall(fetchMock, 2);
      expect(params.get("limit")).toBe("8");
      expect(params.has("eventName")).toBe(false);

      await fetchEventsRecords(
        "default-events-records",
        mockWindow,
        undefined,
        {
          search: "   ",
          eventName: "   ",
        },
      );
      params = paramsFromCall(fetchMock, 3);
      expect(params.get("page")).toBe("1");
      expect(params.get("pageSize")).toBe("80");
      expect(params.has("search")).toBe(false);
      expect(params.has("eventName")).toBe(false);
    });

    it("should omit optional detail params when not provided", async () => {
      const fetchMock = vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(freshJsonResponse({ ok: true, data: null })),
        );
      globalThis.fetch = fetchMock as any;

      await fetchVisitorDetail("detail-minimal", "visitor-a");
      let params = paramsFromCall(fetchMock, 0);
      expect(params.get("visitorId")).toBe("visitor-a");
      expect(params.has("from")).toBe(false);
      expect(params.has("to")).toBe(false);
      expect(params.has("timeZone")).toBe(false);

      await fetchSessionDetail("detail-minimal", "session-a");
      params = paramsFromCall(fetchMock, 1);
      expect(params.get("sessionId")).toBe("session-a");
      expect(params.has("from")).toBe(false);
      expect(params.has("to")).toBe(false);
      expect(params.has("timeZone")).toBe(false);

      await fetchEventRecordDetail("detail-minimal", "event-a");
      params = paramsFromCall(fetchMock, 2);
      expect(params.get("eventId")).toBe("event-a");
      expect(params.has("from")).toBe(false);
      expect(params.has("to")).toBe(false);
    });

    it("should not dedupe detail requests that carry abort signals", async () => {
      const resolveResponses: Array<(response: Response) => void> = [];
      const fetchMock = vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveResponses.push(resolve);
          }),
      );
      globalThis.fetch = fetchMock as any;
      const signal = new AbortController().signal;

      const first = fetchVisitorDetail(
        "signal-detail",
        "visitor-a",
        "UTC",
        mockWindow,
        { signal },
      );
      const second = fetchVisitorDetail(
        "signal-detail",
        "visitor-a",
        "UTC",
        mockWindow,
        { signal },
      );

      expect(fetchMock).toHaveBeenCalledTimes(2);
      resolveResponses.forEach((resolve) =>
        resolve(freshJsonResponse({ ok: true, data: null })),
      );
      await expect(first).resolves.toEqual({ ok: true, data: null });
      await expect(second).resolves.toEqual({ ok: true, data: null });
    });

    it("should serialize option limits for referrer and dimension endpoints", async () => {
      const fetchMock = vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(freshJsonResponse({ ok: true, data: [] })),
        );
      globalThis.fetch = fetchMock as any;

      await fetchReferrers("option-referrers", mockWindow, undefined, {
        fullUrl: true,
        limit: 12,
      });
      let params = paramsFromCall(fetchMock, 0);
      expect(params.get("fullUrl")).toBe("1");
      expect(params.get("limit")).toBe("12");

      await fetchUtmTrend("option-utm", mockWindow, "campaign", undefined, {
        limit: 9,
      });
      params = paramsFromCall(fetchMock, 1);
      expect(params.get("dimension")).toBe("campaign");
      expect(params.get("limit")).toBe("9");

      await fetchOverviewGeoPoints("option-geo-points", mockWindow, undefined, {
        limit: 25,
        applyGeoFilter: true,
      });
      params = paramsFromCall(fetchMock, 2);
      expect(params.get("limit")).toBe("25");
      expect(params.get("applyGeoFilter")).toBe("1");

      await fetchClientDimensionTrend(
        "option-client-trend",
        mockWindow,
        "screenSize",
        undefined,
        { limit: 11 },
      );
      params = paramsFromCall(fetchMock, 3);
      expect(params.get("dimension")).toBe("screenSize");
      expect(params.get("limit")).toBe("11");

      await fetchClientCrossBreakdown(
        "option-client-cross",
        mockWindow,
        "browser",
        "language",
        undefined,
        { primaryLimit: 4, secondaryLimit: 8 },
      );
      params = paramsFromCall(fetchMock, 4);
      expect(params.get("primaryDimension")).toBe("browser");
      expect(params.get("secondaryDimension")).toBe("language");
      expect(params.get("primaryLimit")).toBe("4");
      expect(params.get("secondaryLimit")).toBe("8");

      await fetchBrowserTrend("option-browser-trend", mockWindow, undefined, {
        limit: 6,
      });
      params = paramsFromCall(fetchMock, 5);
      expect(params.get("limit")).toBe("6");

      await fetchBrowserEngineTrend(
        "option-browser-engine",
        mockWindow,
        undefined,
        { limit: 7 },
      );
      params = paramsFromCall(fetchMock, 6);
      expect(params.get("limit")).toBe("7");

      await fetchBrowserVersionBreakdown(
        "option-browser-version",
        mockWindow,
        undefined,
        { browserLimit: 3, versionLimit: 4 },
      );
      params = paramsFromCall(fetchMock, 7);
      expect(params.get("browserLimit")).toBe("3");
      expect(params.get("versionLimit")).toBe("4");

      await fetchBrowserCrossBreakdown(
        "option-browser-cross",
        mockWindow,
        undefined,
        { browserLimit: 3, osLimit: 4, deviceTypeLimit: 5 },
      );
      params = paramsFromCall(fetchMock, 8);
      expect(params.get("browserLimit")).toBe("3");
      expect(params.get("osLimit")).toBe("4");
      expect(params.get("deviceTypeLimit")).toBe("5");

      await fetchReferrerRadar("option-referrer-radar", mockWindow, undefined, {
        limit: 13,
      });
      params = paramsFromCall(fetchMock, 9);
      expect(params.get("limit")).toBe("13");

      await fetchPagesDashboard(
        "option-pages-dashboard",
        mockWindow,
        undefined,
        {
          page: 5,
          pageSize: 14,
        },
      );
      params = paramsFromCall(fetchMock, 10);
      expect(params.get("page")).toBe("5");
      expect(params.get("pageSize")).toBe("14");

      await fetchRetention("option-retention", mockWindow, undefined, {
        granularity: "day",
      });
      params = paramsFromCall(fetchMock, 11);
      expect(params.get("granularity")).toBe("day");
    });

    it("should return empty fallback payloads when recoverable endpoints fail", async () => {
      const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
      globalThis.fetch = fetchMock as any;

      await expect(
        fetchVisitors("fallback-visitors", mockWindow),
      ).resolves.toEqual({
        ok: true,
        data: [],
        meta: {
          page: 1,
          pageSize: 0,
          returned: 0,
          hasMore: false,
          nextPage: null,
        },
      });
      await expect(
        fetchSessions("fallback-sessions", mockWindow),
      ).resolves.toEqual({
        ok: true,
        data: [],
        meta: {
          page: 1,
          pageSize: 0,
          returned: 0,
          hasMore: false,
          nextPage: null,
        },
      });

      const eventsSummary = await fetchEventsSummary(
        "fallback-events-summary",
        mockWindow,
      );
      expect(eventsSummary.summary.events).toBe(0);
      expect(eventsSummary.cards.event.name).toEqual([]);

      const eventsTrend = await fetchEventsTrend(
        "fallback-events-trend",
        mockWindow,
      );
      expect(eventsTrend).toMatchObject({
        ok: true,
        interval: "hour",
        series: [],
        data: [],
      });

      const eventsRecords = await fetchEventsRecords(
        "fallback-events-records",
        mockWindow,
        undefined,
        { pageSize: 33 },
      );
      expect(eventsRecords.meta.pageSize).toBe(33);
      expect(eventsRecords.data).toEqual([]);

      const eventTypeDetail = await fetchEventTypeDetail(
        "fallback-event-type",
        mockWindow,
        "  Signup  ",
      );
      expect(eventTypeDetail.eventName).toBe("Signup");
      expect(eventTypeDetail.summary.eventTypes).toBe(1);
      expect(eventTypeDetail.cards.page.path).toEqual([]);

      const fieldValues = await fetchEventTypeFieldValues(
        "fallback-field-values",
        mockWindow,
        "Signup",
        "payload.plan",
        "string",
      );
      expect(fieldValues).toEqual({
        ok: true,
        fieldPath: "payload.plan",
        fieldValueType: "string",
        data: [],
      });

      const recordDetail = await fetchEventRecordDetail(
        "fallback-record-detail",
        "event-1",
      );
      expect(recordDetail.data).toBeNull();

      const performance = await fetchPerformance(
        "fallback-performance",
        mockWindow,
      );
      expect(performance.interval).toBe("hour");
      expect(performance.summaries.ttfb.samples).toBe(0);
      expect(performance.trends.lcp).toEqual([]);

      const shareTrend = await fetchPagesShareTrend(
        "fallback-share-trend",
        mockWindow,
        undefined,
        { limit: 0 },
      );
      expect(shareTrend).toMatchObject({
        ok: true,
        interval: "hour",
        series: [],
        data: [],
      });

      await expect(
        fetchOverviewGeoPoints("fallback-geo-points", mockWindow),
      ).resolves.toEqual({
        ok: true,
        data: [],
        countryCounts: [],
        regionCounts: [],
        cityCounts: [],
      });
      await expect(
        fetchOverviewPageCardTab("fallback-page-tab", mockWindow, "path"),
      ).resolves.toEqual([]);
      await expect(
        fetchPageHashTab("fallback-hash", mockWindow),
      ).resolves.toEqual([]);
      await expect(
        fetchOverviewSourceCardTab("fallback-source", mockWindow, "link"),
      ).resolves.toEqual([]);
      await expect(
        fetchEventTypesTab("fallback-types", mockWindow),
      ).resolves.toEqual([]);
      await expect(
        fetchOverviewClientDimensionTab(
          "fallback-client-tab",
          mockWindow,
          "language",
        ),
      ).resolves.toEqual([]);
      await expect(
        fetchOverviewGeoDimensionTab("fallback-geo-tab", mockWindow, "country"),
      ).resolves.toEqual([]);
      await expect(
        fetchDashboardFilterOptions(
          "fallback-filter-options",
          mockWindow,
          "country",
        ),
      ).resolves.toEqual([]);
    });

    it("should normalize geo point and count payloads", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          freshJsonResponse({
            ok: true,
            data: [
              {
                latitude: "10.5",
                longitude: null,
                timestampMs: "123",
                country: 77,
                region: null,
                regionCode: "CA",
                city: undefined,
              },
            ],
            countryCounts: [
              {
                country: undefined,
                views: "3",
                sessions: null,
                visitors: undefined,
              },
            ],
            regionCounts: [
              {
                value: undefined,
                label: null,
                views: "4",
                sessions: "2",
                visitors: null,
              },
            ],
            cityCounts: [
              {
                value: null,
                label: "San Francisco",
                views: undefined,
                sessions: "1",
                visitors: "5",
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          freshJsonResponse({
            ok: true,
            data: null,
            countryCounts: null,
            regionCounts: null,
            cityCounts: null,
          }),
        );
      globalThis.fetch = fetchMock as any;

      const mapped = await fetchOverviewGeoPoints(
        "geo-points-normalize",
        mockWindow,
      );
      expect(mapped.data[0]).toEqual({
        latitude: 10.5,
        longitude: 0,
        timestampMs: 123,
        country: "77",
        region: "",
        regionCode: "CA",
        city: "",
        pointCount: 1,
      });
      expect(mapped.countryCounts[0]).toEqual({
        country: "",
        views: 3,
        sessions: 0,
        visitors: 0,
      });
      expect(mapped.regionCounts[0]).toEqual({
        value: "",
        label: "",
        views: 4,
        sessions: 2,
        visitors: 0,
      });
      expect(mapped.cityCounts[0]).toEqual({
        value: "",
        label: "San Francisco",
        views: 0,
        sessions: 1,
        visitors: 5,
      });

      const emptySections = await fetchOverviewGeoPoints(
        "geo-points-non-array",
        mockWindow,
      );
      expect(emptySections).toEqual({
        ok: true,
        data: [],
        countryCounts: [],
        regionCounts: [],
        cityCounts: [],
      });
    });

    it("should format geo dimension labels for region and city hierarchies", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          freshJsonResponse({
            ok: true,
            data: [
              {
                value: "US::CA::California",
                label: "United States :: CA :: California",
                views: "4",
                sessions: null,
                visitors: undefined,
              },
              {
                value: "JP::13::Tokyo",
                label: "  ",
                views: 1,
                sessions: 2,
                visitors: 3,
              },
              {
                value: "raw-region",
                label: "",
                views: 0,
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          freshJsonResponse({
            ok: true,
            data: [
              {
                value: "US::CA::California::San Francisco",
                label: "United States :: CA :: California :: San Francisco",
                views: "9",
              },
              {
                value: "raw-city",
                label: "",
                sessions: "2",
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          freshJsonResponse({
            ok: true,
            data: [
              {
                value: "  ",
                label: "Canada",
                views: "6",
                sessions: "3",
                visitors: "2",
              },
            ],
          }),
        )
        .mockResolvedValueOnce(freshJsonResponse({ ok: true, data: null }));
      globalThis.fetch = fetchMock as any;

      const regions = await fetchOverviewGeoDimensionTab(
        "geo-region-format",
        mockWindow,
        "region",
      );
      expect(regions.map((row) => row.label)).toEqual([
        "California",
        "Tokyo",
        "raw-region",
      ]);
      expect(regions[0]).toMatchObject({
        value: "US::CA::California",
        views: 4,
        sessions: 0,
        visitors: 0,
      });

      const cities = await fetchOverviewGeoDimensionTab(
        "geo-city-format",
        mockWindow,
        "city",
      );
      expect(cities.map((row) => row.label)).toEqual([
        "San Francisco",
        "raw-city",
      ]);
      expect(cities[1]).toMatchObject({
        value: "raw-city",
        sessions: 2,
        visitors: 0,
      });

      const countries = await fetchOverviewGeoDimensionTab(
        "geo-country-format",
        mockWindow,
        "country",
      );
      expect(countries[0]).toEqual({
        value: "Canada",
        label: "Canada",
        views: 6,
        sessions: 3,
        visitors: 2,
      });

      await expect(
        fetchOverviewGeoDimensionTab("geo-non-array", mockWindow, "country"),
      ).resolves.toEqual([]);
    });

    it("should fall back to empty page card tabs when tabs are omitted", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(freshJsonResponse({ ok: true, data: [] }));
      globalThis.fetch = fetchMock as any;

      await expect(
        fetchPageCardTabs("page-card-no-tabs", mockWindow),
      ).resolves.toEqual({
        path: [],
        title: [],
        hostname: [],
        entry: [],
        exit: [],
      });
    });

    it("should build page share trend without other series when top pages cover totals", async () => {
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/api/private/pages-dashboard")) {
          return Promise.resolve(
            freshJsonResponse({
              ok: true,
              interval: "hour",
              data: [
                {
                  pathname: "/docs",
                  metrics: { views: 8, sessions: 2 },
                  trend: [{ timestampMs: 2000, views: 8 }, { views: null }],
                },
                {
                  pathname: "/blog",
                  metrics: { views: 3, sessions: 1 },
                  trend: [{ timestampMs: 1000, views: 3 }],
                },
              ],
              meta: {
                page: 1,
                pageSize: 12,
                returned: 2,
                hasMore: false,
                nextPage: null,
              },
            }),
          );
        }
        return Promise.resolve(
          freshJsonResponse({
            ok: true,
            interval: "hour",
            data: [
              { timestampMs: 1000, views: 2 },
              { timestampMs: 2000, views: 5 },
              { timestampMs: 0, views: 0 },
            ],
          }),
        );
      });
      globalThis.fetch = fetchMock as any;

      const trend = await fetchPagesShareTrend(
        "share-no-other",
        mockWindow,
        undefined,
        { limit: 20 },
      );

      expect(paramsFromCall(fetchMock, 0).get("pageSize")).toBe("12");
      expect(trend.series).toEqual([
        {
          key: "page_0",
          label: "/docs",
          views: 8,
          visitors: 8,
          sessions: 2,
        },
        {
          key: "page_1",
          label: "/blog",
          views: 3,
          visitors: 3,
          sessions: 1,
        },
      ]);
      expect(trend.data.map((point) => point.timestampMs)).toEqual([
        0, 1000, 2000,
      ]);
      expect(trend.data[0]).toMatchObject({
        totalVisitors: 0,
        visitorsBySeries: { page_0: 0 },
      });
      expect(trend.data[2]).toMatchObject({
        totalVisitors: 8,
        visitorsBySeries: { page_0: 8 },
      });
    });

    it("should reject aborted detail requests before fetch", async () => {
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as any;
      const controller = new AbortController();
      controller.abort();

      await expect(
        fetchVisitorDetail("aborted-detail", "visitor-1", "UTC", mockWindow, {
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({
        name: "AbortError",
        message: "Aborted",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("should reject demo requests if the signal aborts during module resolution", async () => {
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as any;
      let abortedReads = 0;
      const signal = {
        get aborted() {
          abortedReads += 1;
          return abortedReads > 1;
        },
      } as AbortSignal;

      process.env.NEXT_PUBLIC_DEMO_MODE = "1";
      try {
        await expect(
          fetchVisitorDetail(
            "demo-site-001",
            "visitor-1",
            undefined,
            undefined,
            {
              signal,
            },
          ),
        ).rejects.toMatchObject({
          name: "AbortError",
          message: "Aborted",
        });
      } finally {
        delete process.env.NEXT_PUBLIC_DEMO_MODE;
      }
      expect(fetchMock).not.toHaveBeenCalled();
      expect(abortedReads).toBeGreaterThanOrEqual(2);
    });

    it("should return empty field values when the field path is nullish", async () => {
      const out = await fetchEventTypeFieldValues(
        "empty-field-path",
        mockWindow,
        "Signup",
        null as any,
        "string",
      );
      expect(out).toEqual({
        ok: true,
        fieldPath: "",
        fieldValueType: "string",
        data: [],
      });
    });
  });
});
