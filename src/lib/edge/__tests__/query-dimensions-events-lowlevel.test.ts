import { describe, expect, it, vi } from "vitest";

import { readCustomEventDetail } from "@/lib/edge/custom-event-read";
import type {
  DashboardFilters,
  EventRecordRow,
  QueryWindow,
} from "@/lib/edge/query/core";
import {
  queryOverviewClientDimensionsFromD1,
  queryOverviewGeoDimensionsFromD1,
  queryPageTabsFromD1,
  queryReferrersFromD1,
  querySessionBoundaryDimensionFromD1,
  querySessionPathDimensionFromD1,
  queryVisitDimensionFromD1,
} from "@/lib/edge/query/dimensions";
import {
  handleEventRecordDetail,
  handleEventsRecords,
  handleEventsSummary,
  handleEventsTrend,
  handleEventTypeDetail,
  handleEventTypeFieldValues,
  handleEventTypes,
} from "@/lib/edge/query/events";
import {
  queryEventFieldsFromD1,
  queryEventFieldValuesFromD1,
} from "@/lib/edge/query/events-fields";
import { queryEventTypeOverviewFromD1 } from "@/lib/edge/query/events-overview";
import { queryEventRecordDetailFromD1 } from "@/lib/edge/query/events-records";
import type { Env } from "@/lib/edge/types";

vi.mock("@/lib/edge/custom-event-read", () => ({
  readCustomEventDetail: vi.fn(),
}));

type D1Row = Record<string, unknown> | EventRecordRow;
type QueryBinding = string | number | null;

interface QueryCall {
  sql: string;
  bindings: QueryBinding[];
}

const readCustomEventDetailMock = vi.mocked(readCustomEventDetail);

const siteId = "site-lowlevel";
const baseMs = Date.UTC(2026, 0, 4, 8);
const window: QueryWindow = {
  fromMs: baseMs,
  toMs: baseMs + 2 * 60 * 60 * 1000,
  nowMs: baseMs + 3 * 60 * 60 * 1000,
  timeZone: "UTC",
};

function createD1Env(resultSets: D1Row[][]): {
  env: Env;
  calls: QueryCall[];
  prepare: ReturnType<typeof vi.fn>;
} {
  const calls: QueryCall[] = [];
  const pendingResults = [...resultSets];
  const prepare = vi.fn((sql: string) => ({
    bind: vi.fn((...bindings: QueryBinding[]) => ({
      all: vi.fn(async () => {
        calls.push({ sql, bindings });
        return { results: pendingResults.shift() ?? [] };
      }),
    })),
  }));

  return {
    env: {
      DB: { prepare } as unknown as D1Database,
      DAILY_SALT_SECRET: "test-secret",
      INGEST_DO: {} as DurableObjectNamespace,
    },
    calls,
    prepare,
  };
}

function visitBindings(targetWindow = window): QueryBinding[] {
  return [siteId, targetWindow.fromMs, targetWindow.toMs];
}

function eventBindings(targetWindow = window): QueryBinding[] {
  return [siteId, targetWindow.fromMs, targetWindow.toMs];
}

function url(
  path: string,
  params: Record<string, string | number | boolean>,
): URL {
  const parsed = new URL(`https://edge.test${path}`);
  for (const [key, value] of Object.entries(params)) {
    parsed.searchParams.set(key, String(value));
  }
  return parsed;
}

function eventRecord(overrides: Partial<EventRecordRow> = {}): EventRecordRow {
  return {
    eventId: "evt-1",
    eventName: "Signup",
    occurredAt: baseMs + 100,
    receivedAt: baseMs + 200,
    sequence: 1,
    visitId: "visit-1",
    sessionId: "session-1",
    visitorId: "visitor-1",
    pathname: "/signup",
    title: "Signup",
    hostname: "example.com",
    referrerHost: "news.example",
    country: "US",
    region: "US::CA::California",
    browser: "Chrome",
    browserVersion: "124",
    os: "Windows",
    osVersion: "11",
    deviceType: "desktop",
    nodeCount: 3,
    valueCount: 2,
    ...overrides,
  };
}

describe("edge query dimensions low-level coverage", () => {
  it("normalizes sparse visit dimension and referrer aggregate rows", async () => {
    const { env, calls } = createD1Env([
      [{ value: null, views: undefined, sessions: null, visitors: undefined }],
      [
        {
          referrer: null,
          views: undefined,
          sessions: null,
          visitors: undefined,
        },
      ],
    ]);

    await expect(
      queryVisitDimensionFromD1(env, siteId, window, {}, 2, "country"),
    ).resolves.toEqual([{ value: "", views: 0, sessions: 0, visitors: 0 }]);
    await expect(
      queryReferrersFromD1(env, siteId, window, {}, 3, false),
    ).resolves.toEqual([{ referrer: "", views: 0, sessions: 0, visitors: 0 }]);

    expect(calls[0].bindings).toEqual([...visitBindings(), 2]);
    expect(calls[1].sql).toContain("COALESCE(referrer_host, '') AS referrer");
    expect(calls[1].bindings).toEqual([...visitBindings(), 3]);
  });

  it("queries session path dimensions in both sort directions and maps fallback row values", async () => {
    const filters: DashboardFilters = { browser: "Chrome" };
    const { env, calls } = createD1Env([
      [{ value: null, views: "4", sessions: undefined, visitors: null }],
      [{ value: "/entry", views: 2, sessions: "1", visitors: "1" }],
    ]);

    await expect(
      querySessionPathDimensionFromD1(env, siteId, window, filters, 5, "exit"),
    ).resolves.toEqual([{ value: "", views: 4, sessions: 0, visitors: 0 }]);
    await expect(
      querySessionBoundaryDimensionFromD1(
        env,
        siteId,
        window,
        filters,
        3,
        "entry",
      ),
    ).resolves.toEqual([
      { value: "/entry", views: 2, sessions: 1, visitors: 1 },
    ]);

    expect(calls).toHaveLength(2);
    expect(calls[0].sql).toContain("ORDER BY fv2.started_at DESC");
    expect(calls[1].sql).toContain("ORDER BY fv2.started_at ASC");
    expect(calls[0].sql).toContain("WHERE TRIM(value) != ''");
    expect(calls[0].bindings).toEqual([...visitBindings(), "Chrome", 5]);
    expect(calls[1].bindings).toEqual([...visitBindings(), "Chrome", 3]);
  });

  it("builds page tab entries while skipping rows without session ids or pathnames", async () => {
    const { env } = createD1Env([
      [
        {},
        {
          cardType: "path",
          value: "/first",
          views: 1,
          sessions: 1,
          visitors: 1,
        },
        {
          cardType: "path",
          value: "/last",
          views: 1,
          sessions: 1,
          visitors: 1,
        },
        {
          cardType: "path",
          value: "/anonymous",
          views: 1,
          sessions: 0,
          visitors: 1,
        },
        {
          cardType: "entry",
          value: "/first",
          views: 1,
          sessions: 1,
          visitors: 1,
        },
        {
          cardType: "exit",
          value: "/last",
          views: 1,
          sessions: 1,
          visitors: 1,
        },
      ],
    ]);

    const tabs = await queryPageTabsFromD1(env, siteId, window, {}, 10);

    expect(tabs.path).toEqual([
      { value: "/first", views: 1, sessions: 1, visitors: 1 },
      { value: "/last", views: 1, sessions: 1, visitors: 1 },
      { value: "/anonymous", views: 1, sessions: 0, visitors: 1 },
    ]);
    expect(tabs.entry).toEqual([
      { value: "/first", views: 1, sessions: 1, visitors: 1 },
    ]);
    expect(tabs.exit).toEqual([
      { value: "/last", views: 1, sessions: 1, visitors: 1 },
    ]);
  });

  it("normalizes client and geo dimensions with missing row values", async () => {
    const { env, calls } = createD1Env([
      [
        {},
        {
          cardType: "browser",
          value: "Safari",
          views: 1,
          sessions: 1,
        },
        {
          cardType: "osVersion",
          value: "15",
          views: 1,
          sessions: 1,
        },
        {
          cardType: "osVersion",
          value: "iOS",
          views: 1,
          sessions: 1,
        },
        {
          cardType: "screenSize",
          value: "390x844",
          views: 1,
          sessions: 1,
        },
      ],
      [
        {},
        {
          cardType: "continent",
          value: "NA",
          views: 1,
          sessions: 1,
          visitors: 1,
        },
      ],
      [
        {
          cardType: "organization",
          value: "Example ISP",
          views: 1,
          sessions: 1,
          visitors: 1,
        },
      ],
    ]);

    await expect(
      queryOverviewClientDimensionsFromD1(env, siteId, window, {}, 10),
    ).resolves.toMatchObject({
      browser: [{ value: "Safari", views: 1, sessions: 1, visitors: 0 }],
      osVersion: [
        { value: "15", views: 1, sessions: 1, visitors: 0 },
        { value: "iOS", views: 1, sessions: 1, visitors: 0 },
      ],
      screenSize: [{ value: "390x844", views: 1, sessions: 1, visitors: 0 }],
    });
    await expect(
      queryOverviewGeoDimensionsFromD1(env, siteId, window, {}, 10),
    ).resolves.toMatchObject({
      country: [],
      continent: [{ value: "NA", label: "NA" }],
      organization: [{ value: "Example ISP", label: "Example ISP" }],
    });
    expect(calls[0].bindings).toEqual([...visitBindings(), 10]);
    expect(calls[1].bindings).toEqual([...visitBindings(), 10]);
    expect(calls[2].bindings).toEqual([...visitBindings(), 10]);
    expect(calls[0].sql).toContain("ranked_cards AS");
    expect(calls[1].sql).toContain("ranked_cards AS");
    expect(calls[2].sql).toContain("ranked_cards AS");
    expect(calls.slice(1)).toHaveLength(2);
    for (const call of calls.slice(1)) {
      expect((call.sql.match(/UNION ALL/g) ?? []).length).toBeLessThan(5);
    }
  });
});

describe("edge query event fields and records low-level coverage", () => {
  it("queries event fields and skips D1 for unsupported field value types", async () => {
    const { env, calls, prepare } = createD1Env([
      [
        {
          path: "/plan",
          valueType: 1,
          events: 2,
          occurrences: 3,
          firstSeenAt: baseMs,
          lastSeenAt: baseMs + 1,
          stringValue: "pro",
          numberValue: null,
          booleanValue: null,
        },
      ],
    ]);

    await expect(
      queryEventFieldsFromD1(env, siteId, window, {}, "Signup", 9),
    ).resolves.toEqual([
      {
        path: "/plan",
        valueType: 1,
        events: 2,
        occurrences: 3,
        firstSeenAt: baseMs,
        lastSeenAt: baseMs + 1,
        stringValue: "pro",
        numberValue: null,
        booleanValue: null,
      },
    ]);
    await expect(
      queryEventFieldValuesFromD1(
        env,
        siteId,
        window,
        {},
        "Signup",
        "/plan",
        "unsupported",
        5,
      ),
    ).resolves.toEqual([]);

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(calls[0].sql).toContain("GROUP BY path, valueType");
    expect(calls[0].bindings).toEqual([
      ...visitBindings(),
      ...eventBindings(),
      "Signup",
      9,
    ]);
  });

  it("binds event field value path, value type, filters, and limit", async () => {
    const { env, calls } = createD1Env([
      [
        {
          valueType: 2,
          events: "4",
          occurrences: "5",
          firstSeenAt: baseMs,
          lastSeenAt: baseMs + 2,
          stringValue: null,
          numberValue: 42,
          booleanValue: null,
        },
      ],
    ]);

    await expect(
      queryEventFieldValuesFromD1(
        env,
        siteId,
        window,
        { clientDeviceType: "mobile" },
        "Purchase",
        "/amount",
        "number",
        7,
      ),
    ).resolves.toEqual([
      {
        valueType: 2,
        events: "4",
        occurrences: "5",
        firstSeenAt: baseMs,
        lastSeenAt: baseMs + 2,
        stringValue: null,
        numberValue: 42,
        booleanValue: null,
      },
    ]);

    expect(calls[0].sql).toContain("WHERE p.path = ? AND v.value_type = ?");
    expect(calls[0].bindings).toEqual([
      ...visitBindings(),
      ...eventBindings(),
      "mobile",
      "Purchase",
      "/amount",
      2,
      7,
    ]);
  });

  it("returns null when an event detail record is missing", async () => {
    const { env, prepare } = createD1Env([[]]);

    await expect(
      queryEventRecordDetailFromD1(env, siteId, "missing-event"),
    ).resolves.toBeNull();

    expect(prepare).toHaveBeenCalledOnce();
    expect(readCustomEventDetailMock).not.toHaveBeenCalled();
  });

  it("defaults missing event detail payloads to an empty object", async () => {
    readCustomEventDetailMock.mockResolvedValueOnce(null);
    const { env } = createD1Env([[eventRecord()]]);

    await expect(
      queryEventRecordDetailFromD1(env, siteId, "evt-1"),
    ).resolves.toMatchObject({
      event: { eventId: "evt-1", eventName: "Signup" },
      context: {
        visitId: "visit-1",
        sessionId: "session-1",
        visitorId: "visitor-1",
      },
      eventData: {},
    });
  });
});

describe("edge query event handlers low-level coverage", () => {
  it("rejects event handler requests with missing identifiers or invalid windows", async () => {
    const { env, prepare } = createD1Env([]);

    const invalidTypes = await handleEventTypes(
      env,
      siteId,
      new URL("https://edge.test/event-types?from=20&to=10"),
    );
    const invalidSummary = await handleEventsSummary(
      env,
      siteId,
      new URL("https://edge.test/events-summary?from=20&to=10"),
    );
    const invalidTrend = await handleEventsTrend(
      env,
      siteId,
      new URL("https://edge.test/events-trend?from=20&to=10"),
    );
    const missingDetailName = await handleEventTypeDetail(
      env,
      siteId,
      url("/event-type-detail", {
        from: window.fromMs,
        to: window.toMs,
      }),
    );
    const invalidDetailWindow = await handleEventTypeDetail(
      env,
      siteId,
      url("/event-type-detail", { eventName: "Signup", from: 20, to: 10 }),
    );
    const missingFieldName = await handleEventTypeFieldValues(
      env,
      siteId,
      url("/event-field-values", {
        fieldPath: "/paid",
        fieldValueType: "boolean",
        from: window.fromMs,
        to: window.toMs,
      }),
    );
    const missingFieldPath = await handleEventTypeFieldValues(
      env,
      siteId,
      url("/event-field-values", {
        eventName: "Signup",
        fieldValueType: "boolean",
        from: window.fromMs,
        to: window.toMs,
      }),
    );
    const missingFieldType = await handleEventTypeFieldValues(
      env,
      siteId,
      url("/event-field-values", {
        eventName: "Signup",
        fieldPath: "/paid",
        from: window.fromMs,
        to: window.toMs,
      }),
    );
    const missingEventId = await handleEventRecordDetail(
      env,
      siteId,
      new URL("https://edge.test/event-detail"),
    );

    await expect(invalidTypes.json()).resolves.toMatchObject({
      ok: false,
      error: { message: "Invalid time window" },
    });
    await expect(invalidSummary.json()).resolves.toMatchObject({
      ok: false,
      error: { message: "Invalid time window" },
    });
    await expect(invalidTrend.json()).resolves.toMatchObject({
      ok: false,
      error: { message: "Invalid time window" },
    });
    await expect(missingDetailName.json()).resolves.toMatchObject({
      ok: false,
      error: { message: "eventName is required" },
    });
    await expect(invalidDetailWindow.json()).resolves.toMatchObject({
      ok: false,
      error: { message: "Invalid time window" },
    });
    await expect(missingFieldName.json()).resolves.toMatchObject({
      ok: false,
      error: { message: "eventName is required" },
    });
    await expect(missingFieldPath.json()).resolves.toMatchObject({
      ok: false,
      error: { message: "fieldPath is required" },
    });
    await expect(missingFieldType.json()).resolves.toMatchObject({
      ok: false,
      error: { message: "fieldValueType is required" },
    });
    await expect(missingEventId.json()).resolves.toMatchObject({
      ok: false,
      error: { message: "eventId is required" },
    });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("maps event types from D1 rows", async () => {
    const { env, calls } = createD1Env([
      [{ value: "Signup", views: "6", sessions: "3", visitors: "2" }],
    ]);

    const response = await handleEventTypes(
      env,
      siteId,
      url("/event-types", {
        from: window.fromMs,
        to: window.toMs,
        limit: 4,
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: [{ label: "Signup", views: 6, sessions: 3, visitors: 2 }],
    });
    expect(calls[0].bindings).toEqual([
      ...visitBindings(),
      ...eventBindings(),
      4,
    ]);
  });

  it("paginates event records and maps current rows", async () => {
    const { env, calls } = createD1Env([
      [eventRecord({ eventId: "evt-1" }), eventRecord({ eventId: "evt-2" })],
    ]);

    const response = await handleEventsRecords(
      env,
      siteId,
      url("/events-records", {
        from: window.fromMs,
        to: window.toMs,
        page: 2,
        pageSize: 1,
        sortBy: "eventName",
        sortDir: "asc",
        search: "signup",
        eventName: "Signup",
      }),
    );

    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: [{ eventId: "evt-1", eventName: "Signup" }],
      meta: {
        page: 2,
        pageSize: 1,
        returned: 1,
        hasMore: true,
        nextPage: 3,
      },
    });
    expect(calls[0].sql).toContain("ORDER BY eventName ASC");
    expect(calls[0].bindings).toEqual([
      ...visitBindings(),
      ...eventBindings(),
      "Signup",
      ...Array<string>(8).fill("%signup%"),
      2,
      1,
    ]);
  });

  it("rejects deep event record pages before querying D1", async () => {
    const { env, calls } = createD1Env([]);

    const response = await handleEventsRecords(
      env,
      siteId,
      url("/events-records", {
        from: window.fromMs,
        to: window.toMs,
        page: 10_000,
        pageSize: 120,
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: expect.stringContaining("Pagination depth") },
    });
    expect(calls).toHaveLength(0);
  });

  it("maps event summaries and final event record pages without more rows", async () => {
    const { env } = createD1Env([
      [
        {
          cardType: "__summary__",
          views: null,
          eventTypes: null,
          sessions: null,
          visitors: null,
        },
      ],
      [eventRecord({ eventId: "evt-final" })],
    ]);

    const summary = await handleEventsSummary(
      env,
      siteId,
      url("/events-summary", {
        from: window.fromMs,
        to: window.toMs,
      }),
    );
    const records = await handleEventsRecords(
      env,
      siteId,
      url("/events-records", {
        from: window.fromMs,
        to: window.toMs,
        page: 1,
        pageSize: 2,
      }),
    );

    await expect(summary.json()).resolves.toMatchObject({
      ok: true,
      summary: {
        events: 0,
        eventTypes: 0,
        sessions: 0,
        visitors: 0,
        avgEventsPerSession: 0,
      },
      cards: {
        event: { name: [] },
        page: { path: [], title: [], hostname: [] },
      },
    });
    await expect(records.json()).resolves.toMatchObject({
      ok: true,
      data: [{ eventId: "evt-final", eventName: "Signup" }],
      meta: {
        page: 1,
        pageSize: 2,
        returned: 1,
        hasMore: false,
        nextPage: null,
      },
    });
  });

  it("returns event field values and event detail handler payloads", async () => {
    readCustomEventDetailMock.mockResolvedValueOnce({
      siteId,
      eventId: "evt-1",
      visitId: "visit-1",
      eventName: "Signup",
      occurredAt: baseMs + 100,
      receivedAt: baseMs + 200,
      sequence: 1,
      nodeCount: 3,
      valueCount: 2,
      eventData: { plan: "pro" },
    });
    const { env } = createD1Env([
      [
        {
          valueType: 3,
          events: 2,
          occurrences: 2,
          firstSeenAt: baseMs,
          lastSeenAt: baseMs + 1,
          stringValue: null,
          numberValue: null,
          booleanValue: 1,
        },
      ],
      [eventRecord()],
    ]);

    const valuesResponse = await handleEventTypeFieldValues(
      env,
      siteId,
      url("/event-field-values", {
        eventName: "Signup",
        fieldPath: "/paid",
        fieldValueType: "boolean",
        from: window.fromMs,
        to: window.toMs,
        limit: 3,
      }),
    );
    const detailResponse = await handleEventRecordDetail(
      env,
      siteId,
      url("/event-detail", { eventId: "evt-1" }),
    );

    await expect(valuesResponse.json()).resolves.toEqual({
      ok: true,
      fieldPath: "/paid",
      fieldValueType: "boolean",
      data: [
        {
          value: true,
          events: 2,
          occurrences: 2,
          firstSeenAt: baseMs,
          lastSeenAt: baseMs + 1,
        },
      ],
    });
    await expect(detailResponse.json()).resolves.toMatchObject({
      ok: true,
      data: {
        event: { eventId: "evt-1", eventName: "Signup" },
        eventData: { plan: "pro" },
      },
    });
  });
});

describe("edge query event type overview low-level coverage", () => {
  it("uses zero summary fallbacks when scoped and event rows are empty", async () => {
    const { env, calls } = createD1Env([[], [], [], [], [], []]);

    await expect(
      queryEventTypeOverviewFromD1(env, siteId, window, {}, "Signup"),
    ).resolves.toEqual({
      summary: {
        events: 0,
        eventTypes: 0,
        sessions: 0,
        visitors: 0,
        avgEventsPerSession: 0,
        shareOfAllEvents: 0,
      },
      breakdowns: {
        pages: [],
        countries: [],
        devices: [],
        browsers: [],
      },
    });

    expect(calls).toHaveLength(6);
  });
});
