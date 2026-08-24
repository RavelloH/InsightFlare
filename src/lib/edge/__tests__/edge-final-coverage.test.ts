import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  geoTabLabel,
  mapEventField,
  mapGeoRowsToFilterOptions,
} from "@/lib/edge/analytics/providers/d1/internal/core-mappers";
import {
  customEventJsonTypeCode,
  customEventJsonTypeLabel,
  parseEventRecordSort,
  parseFilterOptionKey,
  parseListSearch,
  parseSessionListSort,
} from "@/lib/edge/analytics/providers/d1/internal/core-parsers";
import { withDashboardCache } from "@/lib/edge/dashboard-cache";
import { insertVisit } from "@/lib/edge/ingest-buffer-store";
import { flushCustomEventRowIndividually } from "@/lib/edge/ingest-custom-event-flush";
import { flushPendingToD1 } from "@/lib/edge/ingest-flush";
import type { IngestFlushContext } from "@/lib/edge/ingest-flush-types";
import type {
  BufferedCustomEventRow,
  BufferedVisitRow,
} from "@/lib/edge/ingest-types";
import {
  readSiteScriptSettings,
  readSiteTrackingConfig,
} from "@/lib/edge/site-settings-store";
import type { Env, NormalizedPageview } from "@/lib/edge/types";

type SqlBinding = string | number | null;

const NOW = Date.UTC(2026, 4, 25, 12, 0, 0);

function envWithKv(kv: Partial<KVNamespace>): Env {
  return { SITE_SETTINGS_KV: kv as KVNamespace } as Env;
}

function pageview(overrides: Partial<NormalizedPageview> = {}) {
  return {
    kind: "pageview",
    traceId: "trace-1",
    siteId: "site-1",
    visitId: "visit-1",
    visitorId: "visitor-1",
    sessionId: "session-1",
    previousVisitId: "",
    previousVisitStartedAt: null,
    startedAt: NOW - 1_000,
    pathname: "/docs",
    queryString: "",
    hashFragment: "",
    hostname: "example.com",
    title: "Docs",
    referrerUrl: "",
    referrerHost: "",
    utmSource: "",
    utmMedium: "",
    utmCampaign: "",
    utmTerm: "",
    utmContent: "",
    isEU: false,
    country: "US",
    region: "California",
    regionCode: "CA",
    city: "San Francisco",
    continent: "NA",
    latitude: 37.77,
    longitude: -122.42,
    postalCode: "94105",
    metroCode: "807",
    timezone: "America/Los_Angeles",
    asOrganization: "Example ISP",
    uaRaw: "Mozilla/5.0",
    browser: "Chrome",
    browserVersion: "120",
    os: "Windows",
    osVersion: "11",
    deviceType: "desktop",
    screenWidth: 1440,
    screenHeight: 900,
    language: "en-US",
    receivedAt: NOW,
    ...overrides,
  } satisfies NormalizedPageview;
}

function bufferedVisit(
  overrides: Partial<BufferedVisitRow> = {},
): BufferedVisitRow {
  return {
    visitId: "visit-1",
    status: "complete",
    siteId: "site-1",
    visitorId: "visitor-1",
    sessionId: "session-1",
    startedAt: NOW - 31 * 60 * 1000,
    lastActivityAt: NOW - 30 * 60 * 1000,
    endedAt: null,
    finalizedAt: null,
    durationMs: null,
    durationSource: "",
    exitReason: "",
    pathname: "/docs",
    queryString: "",
    hashFragment: "",
    hostname: "example.com",
    title: "Docs",
    referrerUrl: "",
    referrerHost: "",
    utmSource: "",
    utmMedium: "",
    utmCampaign: "",
    utmTerm: "",
    utmContent: "",
    isEU: 0,
    country: "US",
    region: "",
    regionCode: "",
    city: "",
    continent: "",
    latitude: null,
    longitude: null,
    postalCode: "",
    metroCode: "",
    timezone: "UTC",
    asOrganization: "",
    uaRaw: "",
    browser: "",
    browserVersion: "",
    os: "",
    osVersion: "",
    deviceType: "",
    screenWidth: null,
    screenHeight: null,
    language: "",
    userId: "",
    userName: "",
    perfTtfbMs: null,
    perfFcpMs: null,
    perfLcpMs: null,
    perfCls: null,
    perfInpMs: null,
    dirty: 1,
    flushAttempts: 0,
    createdAt: Math.floor((NOW - 31 * 60 * 1000) / 1000),
    updatedAt: Math.floor((NOW - 30 * 60 * 1000) / 1000),
    ...overrides,
  };
}

function bufferedCustomEvent(
  overrides: Partial<BufferedCustomEventRow> = {},
): BufferedCustomEventRow {
  return {
    eventId: "event-1",
    siteId: "site-1",
    visitId: "visit-1",
    occurredAt: NOW - 1_000,
    receivedAt: NOW,
    sequence: 0,
    eventName: "Signup",
    eventDataJson: '{"plan":"pro"}',
    userId: "",
    dirty: 1,
    flushAttempts: 0,
    createdAt: Math.floor(NOW / 1000),
    ...overrides,
  };
}

function flushContext(
  visitRows: BufferedVisitRow[] = [],
  eventRows: BufferedCustomEventRow[] = [],
): IngestFlushContext & { sqlRun: ReturnType<typeof vi.fn> } {
  const sqlRun = vi.fn(() => 1);
  return {
    env: {
      DB: {
        prepare: vi.fn(() => ({
          bind: vi.fn(() => ({})),
        })),
        batch: vi.fn(async () => []),
      } as unknown as D1Database,
    },
    dictionaryIds: new Map(),
    sitePks: new Map([["site-1", 1]]),
    sqlAll: vi
      .fn()
      .mockReturnValueOnce(visitRows)
      .mockReturnValueOnce(eventRows)
      .mockReturnValue([]),
    sqlOne: vi.fn(() => null),
    sqlRun,
    readPersistedVisitRow: vi.fn(async () => null),
    insertBufferedVisitRow: vi.fn(),
    hasOpenVisitsForVisitor: vi.fn(() => false),
    pushRealtimeRecord: vi.fn(async () => undefined),
  };
}

describe("edge cache fallback coverage", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    vi.unstubAllGlobals();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("generates dashboard responses when the global cache binding is malformed or fails to open", async () => {
    const generate = vi.fn(async () => new Response("fresh"));

    vi.stubGlobal("caches", {});
    await expect(
      withDashboardCache(
        undefined,
        new URL("https://example.test/api"),
        generate,
      ).then((response) => response.text()),
    ).resolves.toBe("fresh");

    vi.stubGlobal("caches", {
      open: vi.fn().mockRejectedValue(new Error("cache unavailable")),
    });
    await expect(
      withDashboardCache(
        undefined,
        new URL("https://example.test/api"),
        generate,
      ).then((response) => response.text()),
    ).resolves.toBe("fresh");
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("falls back from malformed site-settings cache entries and missing script configs", async () => {
    const cache = {
      match: vi
        .fn()
        .mockResolvedValueOnce(new Response("{bad json"))
        .mockResolvedValueOnce(null),
      put: vi.fn().mockResolvedValue(undefined),
    };
    vi.stubGlobal("caches", {
      open: vi.fn().mockResolvedValue(cache),
    });
    const kv = {
      get: vi.fn().mockResolvedValue(null),
    };

    await expect(readSiteTrackingConfig(envWithKv(kv), "site-1")).resolves.toBe(
      null,
    );
    await expect(readSiteScriptSettings(envWithKv(kv), "site-2")).resolves.toBe(
      null,
    );
    expect(kv.get).toHaveBeenCalledTimes(2);
  });

  it("reads site settings from KV when cache storage is malformed or cannot open", async () => {
    const kv = {
      get: vi.fn().mockResolvedValue(JSON.stringify({ siteDomain: "Docs.EX" })),
    };

    vi.stubGlobal("caches", {});
    await expect(
      readSiteTrackingConfig(envWithKv(kv), "site-1"),
    ).resolves.toMatchObject({ siteId: "site-1", siteDomain: "docs.ex" });

    vi.stubGlobal("caches", {
      open: vi.fn().mockRejectedValue(new Error("cache unavailable")),
    });
    await expect(
      readSiteTrackingConfig(envWithKv(kv), "site-2"),
    ).resolves.toMatchObject({ siteId: "site-2", siteDomain: "docs.ex" });
    expect(kv.get).toHaveBeenCalledTimes(2);
  });
});

describe("edge ingest flush edge coverage", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("rethrows buffered pageview insert failures without a standalone log", async () => {
    const error = new Error("insert failed");
    const context = {
      sqlRun: vi.fn(() => {
        throw error;
      }),
    };

    await expect(insertVisit(context, pageview())).rejects.toThrow(error);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("deletes custom events when dictionary ids cannot be resolved", async () => {
    const first = vi
      .fn()
      .mockResolvedValueOnce({ ok: 1 })
      .mockResolvedValueOnce(null);
    const run = vi.fn().mockResolvedValue({});
    const prepare = vi.fn(() => ({
      bind: vi.fn(() => ({ first, run })),
    }));
    const context = flushContext() as IngestFlushContext & {
      sqlRun: ReturnType<typeof vi.fn>;
    };
    context.env.DB = {
      prepare,
      batch: vi.fn(async () => []),
    } as unknown as D1Database;
    const observability = {
      increment: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    context.observability = observability;

    await expect(
      flushCustomEventRowIndividually(context, bufferedCustomEvent()),
    ).resolves.toBe(false);

    expect(context.sqlRun).toHaveBeenCalledWith(
      "DELETE FROM buffered_custom_events WHERE event_id IN (?)",
      "event-1",
    );
    expect(observability.increment).toHaveBeenCalledWith("failedStatements", 1);
    expect(observability.error).toHaveBeenCalledWith(
      "do.flush.custom_event_failed",
    );
  });

  it("deletes old flushed visits using startedAt when ended timestamps are absent", async () => {
    const context = flushContext([bufferedVisit()], []);

    await flushPendingToD1(context);

    expect(context.env.DB.batch).toHaveBeenCalledTimes(1);
    expect(context.sqlRun).toHaveBeenCalledWith(
      "DELETE FROM buffered_visits WHERE visit_id IN (?)",
      "visit-1",
    );
  });
});

describe("edge query parser and mapper edge coverage", () => {
  function url(params: Record<string, string>) {
    const parsed = new URL("https://edge.test/query");
    for (const [key, value] of Object.entries(params)) {
      parsed.searchParams.set(key, value);
    }
    return parsed;
  }

  it("maps event field examples and geo fallback labels", () => {
    expect(
      mapEventField({
        path: "/total",
        valueType: 2,
        events: 1,
        occurrences: 1,
        firstSeenAt: 10,
        lastSeenAt: 20,
        stringValue: null,
        numberValue: 12.5,
        booleanValue: null,
      }),
    ).toMatchObject({ valueType: "number", exampleValue: 12.5 });
    expect(
      mapGeoRowsToFilterOptions(
        [
          { value: "", views: 1, sessions: 1, visitors: 1 },
          { value: "::::", views: 1, sessions: 1, visitors: 1 },
        ],
        "city",
      ),
    ).toEqual([{ value: "::::", label: "::::", group: "city" }]);
    expect(geoTabLabel("unknown", "organization")).toBe("unknown");
  });
});
