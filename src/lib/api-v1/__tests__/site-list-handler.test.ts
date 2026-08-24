import { describe, expect, it, vi } from "vitest";

import { createTestProviderRegistry } from "@/lib/api-v1/__tests__/provider-registry";
import {
  AnalysisDefinitionIntegrityError,
  AnalysisDefinitionReadCancelledError,
} from "@/lib/api-v1/analysis-definition-reader";
import {
  handlePlannedSiteEventDetail,
  handlePlannedSiteEventFields,
  handlePlannedSiteEventFieldValues,
  handlePlannedSiteEventsSearch,
  handlePlannedSiteEventsSummary,
  handlePlannedSiteEventsTimeseries,
  handlePlannedSiteEventTypeDetail,
  handlePlannedSiteEventTypes,
  handlePlannedSiteFilterValues,
  handlePlannedSitePages,
  handlePlannedSitePerformanceSummary,
  handlePlannedSitePerformanceTimeseries,
  handlePlannedSiteRealtimeActiveVisitors,
  handlePlannedSiteRealtimeEvents,
  handlePlannedSiteRealtimeSessions,
  handlePlannedSiteRealtimeSnapshot,
  handlePlannedSiteReferrers,
  handlePlannedSiteRetention,
  handlePlannedSiteSessionDetail,
  handlePlannedSiteSessionEvents,
  handlePlannedSiteSessionsSearch,
  handlePlannedSiteVisitorDetail,
  handlePlannedSiteVisitorEvents,
  handlePlannedSiteVisitorSessions,
  handlePlannedSiteVisitorsSearch,
  type SiteEventDetailReader,
  type SiteEventFieldsReader,
  type SiteEventFieldValuesReader,
  type SiteEventsSearchReader,
  type SiteEventsSummaryReader,
  type SiteEventsTimeseriesReader,
  type SiteEventTypeDetailReader,
  type SiteEventTypesReader,
  type SiteFilterValuesReader,
  type SitePagesReader,
  type SitePerformanceSummaryReader,
  type SitePerformanceTimeseriesReader,
  type SiteRealtimeActiveVisitorsReader,
  type SiteRealtimeEventsReader,
  type SiteRealtimeSessionsReader,
  type SiteRealtimeSnapshotReader,
  type SiteReferrersReader,
  type SiteRetentionReader,
  type SiteSessionDetailReader,
  type SiteSessionEventsReader,
  type SiteSessionsSearchReader,
  type SiteVisitorDetailReader,
  type SiteVisitorEventsReader,
  type SiteVisitorSessionsReader,
  type SiteVisitorsSearchReader,
} from "@/lib/api-v1/site-list-handler";
import {
  AnalyticsEventDetailResponseSchema,
  AnalyticsEventFieldsResponseSchema,
  AnalyticsEventFieldValuesResponseSchema,
  AnalyticsEventsSearchResponseSchema,
  AnalyticsEventsSummaryResponseSchema,
  AnalyticsEventsTimeseriesResponseSchema,
  AnalyticsEventTypeDetailResponseSchema,
  AnalyticsEventTypesResponseSchema,
  AnalyticsFilterValuesResponseSchema,
  AnalyticsPagesResponseSchema,
  AnalyticsPerformanceSummaryResponseSchema,
  AnalyticsPerformanceTimeseriesResponseSchema,
  AnalyticsRealtimeActiveVisitorsResponseSchema,
  AnalyticsRealtimeEventsResponseSchema,
  AnalyticsRealtimeSessionsResponseSchema,
  AnalyticsRealtimeSnapshotResponseSchema,
  AnalyticsReferrersResponseSchema,
  AnalyticsRetentionCohortsResponseSchema,
  ApiV1ErrorEnvelopeSchema,
} from "@/lib/api-v1/wire";
import type { ApiKeyPrincipal } from "@/lib/edge/api-key-auth";

const principal: ApiKeyPrincipal = {
  keyId: "key-1",
  teamId: "team-1",
  prefix: "prefix",
  status: "active",
  scopes: ["analytics:read"],
  siteIds: ["site-1"],
};
const timeRange = {
  kind: "absolute" as const,
  from: "2026-08-01T00:00:00.000Z",
  to: "2026-08-02T00:00:00.000Z",
};

function request(
  path:
    | "pages"
    | "referrers"
    | "filter-values"
    | "retention/cohorts"
    | "performance/summary"
    | "performance/timeseries"
    | "events/summary"
    | "events/timeseries"
    | "events/search"
    | "events/detail"
    | "event-types"
    | "event-types/detail"
    | "event-types/fields"
    | "event-types/field-values"
    | "realtime/snapshot"
    | "realtime/active-visitors"
    | "realtime/events"
    | "realtime/sessions"
    | "visitors/detail"
    | "sessions/detail"
    | "visitors/search"
    | "sessions/search"
    | "visitors/events"
    | "visitors/sessions"
    | "sessions/events",
  body: unknown,
  init: RequestInit = {},
) {
  const method = init.method ?? "POST";
  return new Request(`https://app.test/api/v1/sites/site-1/analytics/${path}`, {
    ...init,
    method,
    headers: { "Content-Type": "application/json", ...init.headers },
    ...(method === "GET" || method === "HEAD"
      ? {}
      : { body: JSON.stringify(body) }),
  });
}

describe("planned site list analytics adapters", () => {
  it("serves strict page and referrer envelopes with DTO defaults", async () => {
    const pages = vi.fn<SitePagesReader>().mockResolvedValue({
      items: [
        { pathname: "/pricing", query: "", hash: "", views: 10, sessions: 4 },
      ],
    });
    const referrers = vi.fn<SiteReferrersReader>().mockResolvedValue({
      items: [
        { referrer: "search.example", views: 10, sessions: 4, visitors: 3 },
      ],
    });
    const filterValues = vi.fn<SiteFilterValuesReader>().mockResolvedValue({
      field: "page.path",
      items: [{ value: "/pricing", label: "/pricing", occurrences: 10 }],
      page: { limit: 50, hasMore: false, nextCursor: null },
    });
    const pageResponse = await handlePlannedSitePages(
      request("pages", { timeRange }),
      principal,
      "site-1",
      createTestProviderRegistry(pages),
    );
    const referrerResponse = await handlePlannedSiteReferrers(
      request("referrers", { timeRange }),
      principal,
      "site-1",
      createTestProviderRegistry(referrers),
    );
    const filterValuesResponse = await handlePlannedSiteFilterValues(
      request("filter-values", { timeRange, field: "page.path" }),
      principal,
      "site-1",
      createTestProviderRegistry(filterValues),
    );
    expect(
      AnalyticsPagesResponseSchema.safeParse(await pageResponse.json()).success,
    ).toBe(true);
    expect(
      AnalyticsReferrersResponseSchema.safeParse(await referrerResponse.json())
        .success,
    ).toBe(true);
    const filterValuesBody = AnalyticsFilterValuesResponseSchema.parse(
      await filterValuesResponse.json(),
    );
    expect(filterValuesBody.data.field).toBe("page.path");
    expect(pages).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 20, includeDetails: false }),
    );
    expect(referrers).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 20, includeFullUrl: false }),
    );
    expect(filterValues).toHaveBeenCalledWith(
      expect.objectContaining({ field: "page.path", page: { limit: 50 } }),
    );
    const retention = vi.fn<SiteRetentionReader>().mockResolvedValue({
      granularity: "week",
      cohorts: [],
    });
    const retentionResponse = await handlePlannedSiteRetention(
      request("retention/cohorts", { timeRange, granularity: "week" }),
      principal,
      "site-1",
      createTestProviderRegistry(retention),
    );
    expect(
      AnalyticsRetentionCohortsResponseSchema.safeParse(
        await retentionResponse.json(),
      ).success,
    ).toBe(true);
    expect(retention).toHaveBeenCalledWith(
      expect.objectContaining({ granularity: "week" }),
    );
    const metrics = {
      ttfb: { avg: null, p50: null, p75: null, p95: null, samples: 0 },
      fcp: { avg: null, p50: null, p75: null, p95: null, samples: 0 },
      lcp: { avg: null, p50: null, p75: null, p95: null, samples: 0 },
      cls: { avg: null, p50: null, p75: null, p95: null, samples: 0 },
      inp: { avg: null, p50: null, p75: null, p95: null, samples: 0 },
    };
    const performanceSummary = vi
      .fn<SitePerformanceSummaryReader>()
      .mockResolvedValue({ metrics });
    const performanceTimeseries = vi
      .fn<SitePerformanceTimeseriesReader>()
      .mockResolvedValue({
        interval: "day",
        series: { ttfb: [], fcp: [], lcp: [], cls: [], inp: [] },
      });
    const performanceSummaryResponse =
      await handlePlannedSitePerformanceSummary(
        request("performance/summary", { timeRange }),
        principal,
        "site-1",
        createTestProviderRegistry(performanceSummary),
      );
    const performanceTimeseriesResponse =
      await handlePlannedSitePerformanceTimeseries(
        request("performance/timeseries", { timeRange, interval: "day" }),
        principal,
        "site-1",
        createTestProviderRegistry(performanceTimeseries),
      );
    expect(
      AnalyticsPerformanceSummaryResponseSchema.safeParse(
        await performanceSummaryResponse.json(),
      ).success,
    ).toBe(true);
    expect(
      AnalyticsPerformanceTimeseriesResponseSchema.safeParse(
        await performanceTimeseriesResponse.json(),
      ).success,
    ).toBe(true);
    const eventsSummary = vi.fn<SiteEventsSummaryReader>().mockResolvedValue({
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
    });
    const eventsTimeseries = vi
      .fn<SiteEventsTimeseriesReader>()
      .mockResolvedValue({
        interval: "day",
        series: [],
        points: [],
      });
    const eventsSummaryResponse = await handlePlannedSiteEventsSummary(
      request("events/summary", { timeRange }),
      principal,
      "site-1",
      createTestProviderRegistry(eventsSummary),
    );
    const eventsTimeseriesResponse = await handlePlannedSiteEventsTimeseries(
      request("events/timeseries", { timeRange, interval: "day" }),
      principal,
      "site-1",
      createTestProviderRegistry(eventsTimeseries),
    );
    expect(
      AnalyticsEventsSummaryResponseSchema.safeParse(
        await eventsSummaryResponse.json(),
      ).success,
    ).toBe(true);
    expect(
      AnalyticsEventsTimeseriesResponseSchema.safeParse(
        await eventsTimeseriesResponse.json(),
      ).success,
    ).toBe(true);
    expect(eventsTimeseries).toHaveBeenCalledWith(
      expect.objectContaining({ interval: "day", limit: 8 }),
    );
    const record = {
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
      browser: "",
      browserVersion: "",
      os: "",
      osVersion: "",
      deviceType: "",
      nodeCount: 0,
      valueCount: 0,
    };
    const search = vi.fn<SiteEventsSearchReader>().mockResolvedValue({
      items: [record],
      page: { limit: 80, hasMore: false, nextCursor: null },
    });
    const detail = vi.fn<SiteEventDetailReader>().mockResolvedValue({
      event: record,
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
    });
    const searchResponse = await handlePlannedSiteEventsSearch(
      request("events/search", { timeRange }),
      principal,
      "site-1",
      createTestProviderRegistry(search),
    );
    const detailResponse = await handlePlannedSiteEventDetail(
      request("events/detail", { timeRange, eventId: "evt" }),
      principal,
      "site-1",
      createTestProviderRegistry(detail),
    );
    expect(
      AnalyticsEventsSearchResponseSchema.safeParse(await searchResponse.json())
        .success,
    ).toBe(true);
    expect(
      AnalyticsEventDetailResponseSchema.safeParse(await detailResponse.json())
        .success,
    ).toBe(true);
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({
        sort: { field: "occurredAt", direction: "desc" },
        page: { limit: 80 },
      }),
    );
    const eventTypes = vi.fn<SiteEventTypesReader>().mockResolvedValue({
      items: [
        { key: "signup", label: "signup", events: 3, sessions: 2, visitors: 2 },
      ],
      page: { limit: 20 },
    });
    const eventFields = vi.fn<SiteEventFieldsReader>().mockResolvedValue({
      eventName: "signup",
      fields: [],
      page: { limit: 100 },
    });
    const eventFieldValues = vi
      .fn<SiteEventFieldValuesReader>()
      .mockResolvedValue({
        eventName: "signup",
        fieldPath: "plan",
        fieldValueType: "string",
        items: [],
        page: { limit: 25 },
      });
    const eventTypeDetail = vi
      .fn<SiteEventTypeDetailReader>()
      .mockResolvedValue({
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
      });
    const eventTypesResponse = await handlePlannedSiteEventTypes(
      request("event-types", { timeRange }),
      principal,
      "site-1",
      createTestProviderRegistry(eventTypes),
    );
    const eventFieldsResponse = await handlePlannedSiteEventFields(
      request("event-types/fields", { timeRange, eventName: "signup" }),
      principal,
      "site-1",
      createTestProviderRegistry(eventFields),
    );
    const eventFieldValuesResponse = await handlePlannedSiteEventFieldValues(
      request("event-types/field-values", {
        timeRange,
        eventName: "signup",
        fieldPath: "plan",
        fieldValueType: "string",
      }),
      principal,
      "site-1",
      createTestProviderRegistry(eventFieldValues),
    );
    const eventTypeDetailResponse = await handlePlannedSiteEventTypeDetail(
      request("event-types/detail", { timeRange, eventName: "signup" }),
      principal,
      "site-1",
      createTestProviderRegistry(eventTypeDetail),
    );
    expect(
      AnalyticsEventTypesResponseSchema.safeParse(
        await eventTypesResponse.json(),
      ).success,
    ).toBe(true);
    expect(
      AnalyticsEventFieldsResponseSchema.safeParse(
        await eventFieldsResponse.json(),
      ).success,
    ).toBe(true);
    expect(
      AnalyticsEventFieldValuesResponseSchema.safeParse(
        await eventFieldValuesResponse.json(),
      ).success,
    ).toBe(true);
    expect(
      AnalyticsEventTypeDetailResponseSchema.safeParse(
        await eventTypeDetailResponse.json(),
      ).success,
    ).toBe(true);
    expect(eventTypes).toHaveBeenCalledWith(
      expect.objectContaining({ page: { limit: 20 } }),
    );
    expect(eventFields).toHaveBeenCalledWith(
      expect.objectContaining({ page: { limit: 100 } }),
    );
    expect(eventFieldValues).toHaveBeenCalledWith(
      expect.objectContaining({ page: { limit: 25 } }),
    );
  });

  it("rejects protocol, scope, site, saved-filter, cancellation, and deadline failures before readers", async () => {
    const pages = vi.fn<SitePagesReader>();
    const referrers = vi.fn<SiteReferrersReader>();
    for (const candidate of [
      new Request("https://app.test/api/v1/sites/site-1/analytics/pages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
      request("pages", {}, { method: "GET" }),
      request("pages", { timeRange }, { headers: { Accept: "text/plain" } }),
      request(
        "pages",
        { timeRange },
        { headers: { "Content-Type": "text/plain" } },
      ),
      request(
        "pages",
        { timeRange },
        { headers: { "Content-Encoding": "gzip" } },
      ),
      request("pages", { timeRange, unexpected: true }),
    ]) {
      const response = await handlePlannedSitePages(
        candidate,
        principal,
        "site-1",
        createTestProviderRegistry(pages),
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(
        ApiV1ErrorEnvelopeSchema.safeParse(await response.json()).success,
      ).toBe(true);
    }
    expect(
      (
        await handlePlannedSitePages(
          request("pages", { timeRange }),
          { ...principal, scopes: [] },
          "site-1",
          createTestProviderRegistry(pages),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handlePlannedSiteReferrers(
          request("referrers", { timeRange }),
          principal,
          "site-2",
          createTestProviderRegistry(referrers),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await handlePlannedSitePages(
          request("pages", {
            timeRange,
            filter: { type: "saved", id: "filter-1" },
          }),
          principal,
          "site-1",
          createTestProviderRegistry(pages),
        )
      ).status,
    ).toBe(403);
    const controller = new AbortController();
    controller.abort();
    expect(
      (
        await handlePlannedSitePages(
          request("pages", { timeRange }),
          principal,
          "site-1",
          createTestProviderRegistry(pages),
          { signal: controller.signal },
        )
      ).status,
    ).toBe(499);
    expect(
      (
        await handlePlannedSiteReferrers(
          request("referrers", { timeRange }),
          principal,
          "site-1",
          createTestProviderRegistry(referrers),
          { deadlineMs: 1, now: () => 1 },
        )
      ).status,
    ).toBe(504);
    expect(pages).not.toHaveBeenCalled();
    expect(referrers).not.toHaveBeenCalled();
  });

  it("uses saved filters only after the conditional scope gate and fails closed for reader errors", async () => {
    const savedPrincipal: ApiKeyPrincipal = {
      ...principal,
      scopes: ["analytics:read", "analysis:read"],
    };
    const pages = vi.fn<SitePagesReader>().mockResolvedValue({ items: [] });
    const saved = request("pages", {
      timeRange,
      filter: { type: "saved", id: "filter-1" },
    });
    await expect(
      handlePlannedSitePages(
        saved,
        savedPrincipal,
        "site-1",
        createTestProviderRegistry(pages),
        {},
        {
          resolveTeamVisibleSavedFilter: vi.fn().mockResolvedValue({
            document: { version: 1, root: null },
            fingerprint: "test",
          }),
        },
      ),
    ).resolves.toMatchObject({ status: 200 });
    const hidden = await handlePlannedSitePages(
      request("pages", { timeRange, filter: { type: "saved", id: "missing" } }),
      savedPrincipal,
      "site-1",
      createTestProviderRegistry(pages),
      {},
      { resolveTeamVisibleSavedFilter: vi.fn().mockResolvedValue(null) },
    );
    expect(hidden.status).toBe(404);
    expect(
      (
        await handlePlannedSitePages(
          request("pages", {
            timeRange,
            filter: { type: "saved", id: "missing" },
          }),
          savedPrincipal,
          "site-1",
          createTestProviderRegistry(pages),
        )
      ).status,
    ).toBe(404);
    for (const error of [
      new AnalysisDefinitionIntegrityError(),
      new Error("definition unavailable"),
    ]) {
      expect(
        (
          await handlePlannedSitePages(
            request("pages", {
              timeRange,
              filter: { type: "saved", id: "filter-1" },
            }),
            savedPrincipal,
            "site-1",
            createTestProviderRegistry(pages),
            {},
            { resolveTeamVisibleSavedFilter: vi.fn().mockRejectedValue(error) },
          )
        ).status,
      ).toBe(500);
    }
    expect(
      (
        await handlePlannedSitePages(
          request("pages", {
            timeRange,
            filter: { type: "saved", id: "filter-1" },
          }),
          savedPrincipal,
          "site-1",
          createTestProviderRegistry(pages),
          {},
          {
            resolveTeamVisibleSavedFilter: vi
              .fn()
              .mockRejectedValue(new AnalysisDefinitionReadCancelledError()),
          },
        )
      ).status,
    ).toBe(499);
    const failed = vi
      .fn<SiteReferrersReader>()
      .mockRejectedValue(new Error("provider"));
    expect(
      (
        await handlePlannedSiteReferrers(
          request("referrers", { timeRange }),
          principal,
          "site-1",
          createTestProviderRegistry(failed),
        )
      ).status,
    ).toBe(500);
    const invalidCursor = vi
      .fn<SiteReferrersReader>()
      .mockRejectedValue(new Error("invalid-cursor"));
    const unavailable = vi
      .fn<SiteReferrersReader>()
      .mockRejectedValue(new Error("data-unavailable"));
    expect(
      (
        await handlePlannedSiteReferrers(
          request("referrers", { timeRange }),
          principal,
          "site-1",
          createTestProviderRegistry(invalidCursor),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handlePlannedSiteReferrers(
          request("referrers", { timeRange }),
          principal,
          "site-1",
          createTestProviderRegistry(unavailable),
        )
      ).status,
    ).toBe(503);
    let nowCalls = 0;
    expect(
      (
        await handlePlannedSitePages(
          request("pages", { timeRange }),
          principal,
          "site-1",
          createTestProviderRegistry(pages),
          { deadlineMs: 1, now: () => (nowCalls++ === 0 ? 0 : 1) },
        )
      ).status,
    ).toBe(504);
  });

  it("rejects inactive keys and enforces cancellation at reader boundaries", async () => {
    const filterValues = vi.fn<SiteFilterValuesReader>().mockResolvedValue({
      field: "page.path",
      items: [],
      page: { limit: 50, hasMore: false, nextCursor: null },
    });
    expect(
      (
        await handlePlannedSiteFilterValues(
          request("filter-values", { timeRange, field: "page.path" }),
          { ...principal, status: "revoked" },
          "site-1",
          createTestProviderRegistry(filterValues),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handlePlannedSiteFilterValues(
          request("filter-values", {
            timeRange: {
              kind: "absolute",
              from: timeRange.to,
              to: timeRange.from,
            },
            field: "page.path",
          }),
          principal,
          "site-1",
          createTestProviderRegistry(filterValues),
        )
      ).status,
    ).toBe(400);

    const controller = new AbortController();
    const abortingReader = vi
      .fn<SiteFilterValuesReader>()
      .mockImplementation(async () => {
        controller.abort();
        return {
          field: "page.path",
          items: [],
          page: { limit: 50, hasMore: false, nextCursor: null },
        };
      });
    expect(
      (
        await handlePlannedSiteFilterValues(
          request("filter-values", { timeRange, field: "page.path" }),
          principal,
          "site-1",
          createTestProviderRegistry(abortingReader),
          { signal: controller.signal },
        )
      ).status,
    ).toBe(499);
  });

  it("serves realtime adapters with realtime source metadata", async () => {
    const snapshot = vi.fn<SiteRealtimeSnapshotReader>().mockResolvedValue({
      activeNow: 0,
      events: [],
      visits: [],
    });
    const activeVisitors = vi
      .fn<SiteRealtimeActiveVisitorsReader>()
      .mockResolvedValue({
        activeNow: 2,
      });
    const events = vi
      .fn<SiteRealtimeEventsReader>()
      .mockResolvedValue({ items: [] });
    const sessions = vi
      .fn<SiteRealtimeSessionsReader>()
      .mockResolvedValue({ items: [] });

    const responses = await Promise.all([
      handlePlannedSiteRealtimeSnapshot(
        request("realtime/snapshot", { timeRange }),
        principal,
        "site-1",
        createTestProviderRegistry(snapshot),
      ),
      handlePlannedSiteRealtimeActiveVisitors(
        request("realtime/active-visitors", { timeRange }),
        principal,
        "site-1",
        createTestProviderRegistry(activeVisitors),
      ),
      handlePlannedSiteRealtimeEvents(
        request("realtime/events", { timeRange }),
        principal,
        "site-1",
        createTestProviderRegistry(events),
      ),
      handlePlannedSiteRealtimeSessions(
        request("realtime/sessions", { timeRange }),
        principal,
        "site-1",
        createTestProviderRegistry(sessions),
      ),
    ]);
    const bodies = await Promise.all(
      responses.map((response) => response.json()),
    );
    expect(responses.map((response) => response.status)).toEqual([
      200, 200, 200, 200,
    ]);
    expect(
      AnalyticsRealtimeSnapshotResponseSchema.safeParse(bodies[0]).success,
    ).toBe(true);
    expect(
      AnalyticsRealtimeActiveVisitorsResponseSchema.safeParse(bodies[1])
        .success,
    ).toBe(true);
    expect(
      AnalyticsRealtimeEventsResponseSchema.safeParse(bodies[2]).success,
    ).toBe(true);
    expect(
      AnalyticsRealtimeSessionsResponseSchema.safeParse(bodies[3]).success,
    ).toBe(true);
    for (const body of bodies)
      expect((body as { meta: { source: string } }).meta.source).toBe(
        "realtime",
      );
    expect(snapshot).toHaveBeenCalledWith(
      expect.objectContaining({ timeRange }),
    );
    expect(activeVisitors).toHaveBeenCalledWith(
      expect.objectContaining({ timeRange }),
    );
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ timeRange }));
    expect(sessions).toHaveBeenCalledWith(
      expect.objectContaining({ timeRange }),
    );
  });

  it("invokes the planned visitor and session adapters", async () => {
    const detail = vi
      .fn<SiteVisitorDetailReader>()
      .mockResolvedValue({} as never);
    const sessionDetail = vi
      .fn<SiteSessionDetailReader>()
      .mockResolvedValue({} as never);
    const visitors = vi
      .fn<SiteVisitorsSearchReader>()
      .mockResolvedValue({ items: [], page: {} });
    const sessions = vi
      .fn<SiteSessionsSearchReader>()
      .mockResolvedValue({ items: [], page: {} });
    const visitorEvents = vi
      .fn<SiteVisitorEventsReader>()
      .mockResolvedValue({ items: [] });
    const visitorSessions = vi
      .fn<SiteVisitorSessionsReader>()
      .mockResolvedValue({ items: [] });
    const sessionEvents = vi
      .fn<SiteSessionEventsReader>()
      .mockResolvedValue({ items: [] });
    const responses = await Promise.all([
      handlePlannedSiteVisitorDetail(
        request("visitors/detail", { timeRange, visitorId: "visitor-1" }),
        principal,
        "site-1",
        createTestProviderRegistry(detail),
      ),
      handlePlannedSiteSessionDetail(
        request("sessions/detail", { timeRange, sessionId: "session-1" }),
        principal,
        "site-1",
        createTestProviderRegistry(sessionDetail),
      ),
      handlePlannedSiteVisitorsSearch(
        request("visitors/search", { timeRange }),
        principal,
        "site-1",
        createTestProviderRegistry(visitors),
      ),
      handlePlannedSiteSessionsSearch(
        request("sessions/search", { timeRange }),
        principal,
        "site-1",
        createTestProviderRegistry(sessions),
      ),
      handlePlannedSiteVisitorEvents(
        request("visitors/events", { timeRange, visitorId: "visitor-1" }),
        principal,
        "site-1",
        createTestProviderRegistry(visitorEvents),
      ),
      handlePlannedSiteVisitorSessions(
        request("visitors/sessions", { timeRange, visitorId: "visitor-1" }),
        principal,
        "site-1",
        createTestProviderRegistry(visitorSessions),
      ),
      handlePlannedSiteSessionEvents(
        request("sessions/events", { timeRange, sessionId: "session-1" }),
        principal,
        "site-1",
        createTestProviderRegistry(sessionEvents),
      ),
    ]);
    expect(responses).toHaveLength(7);
    for (const response of responses)
      expect(response.status).toBeGreaterThanOrEqual(200);
  });
});
