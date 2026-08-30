import { describe, expect, it } from "vitest";

import { normalizeIngestRecord } from "@/lib/edge/ingest-record-normalize";
import type {
  RecentVisitorSession,
  StoredOpenVisit,
} from "@/lib/edge/ingest-types";
import type {
  IngestEnvelopePayload,
  TrackerClientPayload,
} from "@/lib/edge/types";
import { deriveEuVisitorId } from "@/lib/edge/utils";
import { visitorDailySaltSecret } from "@/lib/secrets";

const receivedAt = 1_700_000_000_000;

function makeEnvelope(
  client: Record<string, unknown>,
  request?: Partial<IngestEnvelopePayload["request"]>,
): IngestEnvelopePayload {
  return {
    trace: {
      id: "trace-1",
      source: "test",
      acceptedAt: receivedAt,
    },
    request: {
      method: "POST",
      url: "https://collector.example/ingest",
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        "cf-connecting-ip": "203.0.113.10",
      },
      cf: {
        country: "US",
        region: "California",
        regionCode: "CA",
        city: "San Francisco",
        continent: "NA",
        latitude: "bad",
        longitude: Number.POSITIVE_INFINITY,
        postalCode: "94105",
        metroCode: "807",
        timezone: "America/Los_Angeles",
        asOrganization: "Example ISP",
      },
      body: "",
      receivedAt,
      ...request,
    },
    client: {
      siteId: "site-1",
      timestamp: receivedAt - 1_000,
      startedAt: receivedAt - 2_000,
      ...client,
    } as TrackerClientPayload,
  };
}

function makeVisit(overrides: Partial<StoredOpenVisit> = {}): StoredOpenVisit {
  return {
    siteId: "site-1",
    visitId: "visit-1",
    visitorId: "visitor-from-visit",
    sessionId: "session-from-visit",
    startedAt: receivedAt - 5_000,
    lastActivityAt: receivedAt - 100,
    pathname: "/from-visit",
    queryString: "utm_source=visit",
    hashFragment: "#visit",
    hostname: "example.com",
    title: "Visit title",
    referrerUrl: "https://ref.example/start",
    referrerHost: "ref.example",
    utmSource: "visit",
    utmMedium: "",
    utmCampaign: "",
    utmTerm: "",
    utmContent: "",
    isEU: false,
    country: "US",
    region: "CA",
    regionCode: "CA",
    city: "San Francisco",
    continent: "NA",
    latitude: 37.7,
    longitude: -122.4,
    postalCode: "94105",
    metroCode: "807",
    timezone: "America/Los_Angeles",
    asOrganization: "Example ISP",
    uaRaw: "UA",
    browser: "Chrome",
    browserVersion: "120",
    os: "Windows",
    osVersion: "11",
    deviceType: "desktop",
    screenWidth: 1440,
    screenHeight: 900,
    language: "en-US",
    userId: "visit-user",
    userName: "Visit User",
    ...overrides,
  };
}

function makeContext(
  options: {
    visit?: StoredOpenVisit | null;
    recentSession?: RecentVisitorSession | null;
    inserted?: boolean;
  } = {},
) {
  const buffered: unknown[] = [];
  let alarmCount = 0;

  return {
    context: {
      env: { DAILY_SALT_SECRET: "test-secret" },
      getVisitContext: async () => options.visit ?? null,
      findRecentVisitorSession: async () => options.recentSession ?? null,
      insertBufferedCustomEvent: (record: never) => {
        buffered.push(record);
        return options.inserted ?? true;
      },
      ensureAlarm: async () => {
        alarmCount += 1;
      },
    },
    buffered,
    get alarmCount() {
      return alarmCount;
    },
  };
}

async function expectedVisitorSecret(): Promise<string> {
  return (await visitorDailySaltSecret({ DAILY_SALT_SECRET: "test-secret" }))!;
}

describe("normalizeIngestRecord rejection reasons", () => {
  it("throws when visitor identity needs a secret but no root secret is configured", async () => {
    const { context } = makeContext();
    context.env = {} as typeof context.env;

    await expect(
      normalizeIngestRecord(
        makeEnvelope(
          {
            kind: "pageview",
            visitId: "visit-1",
            visitorId: "",
            hostname: "example.com",
          },
          { cf: { isEUCountry: true } },
        ),
        context,
      ),
    ).rejects.toThrow(
      "MAIN_SECRET or DAILY_SALT_SECRET is required for visitor identity",
    );
  });

  it("rejects records missing required site, visit, hostname, user, or event fields", async () => {
    const { context } = makeContext();

    await expect(
      normalizeIngestRecord(
        makeEnvelope({ siteId: "", kind: "pageview" }),
        context,
      ),
    ).resolves.toMatchObject({ record: null, reason: "missing_site_id" });
    await expect(
      normalizeIngestRecord(
        makeEnvelope({ kind: "pageview", visitId: "" }),
        context,
      ),
    ).resolves.toMatchObject({ record: null, reason: "missing_visit_id" });
    await expect(
      normalizeIngestRecord(
        makeEnvelope({ kind: "pageview", visitId: "visit-1", hostname: "" }),
        context,
      ),
    ).resolves.toMatchObject({ record: null, reason: "missing_hostname" });
    await expect(
      normalizeIngestRecord(
        makeEnvelope({ kind: "identify", visitId: "visit-1" }),
        context,
      ),
    ).resolves.toMatchObject({ record: null, reason: "missing_user_id" });
    await expect(
      normalizeIngestRecord(
        makeEnvelope({
          kind: "custom_event",
          visitId: "visit-1",
          eventName: "",
        }),
        context,
      ),
    ).resolves.toMatchObject({ record: null, reason: "missing_event_name" });
    await expect(
      normalizeIngestRecord(makeEnvelope({ kind: "not_real" }), context),
    ).resolves.toMatchObject({
      record: null,
      reason: "unsupported_kind",
      detail: { kind: "not_real" },
    });
  });

  it("handles a missing client payload as a missing site id", async () => {
    const { context } = makeContext();
    const envelope = makeEnvelope({ kind: "pageview" });
    delete (envelope as { client?: unknown }).client;

    await expect(normalizeIngestRecord(envelope, context)).resolves.toEqual({
      record: null,
      reason: "missing_site_id",
    });
  });
});

describe("normalizeIngestRecord pageview records", () => {
  it("normalizes pageview URL, user, geo, viewport, and EU visitor fields", async () => {
    const { context } = makeContext();
    const envelope = makeEnvelope(
      {
        kind: "pageview",
        visitId: "visit-1",
        sessionId: "",
        visitorId: "client-visitor",
        hostname: "EXAMPLE.COM",
        pathname: "",
        query:
          "utm_source=newsletter&utm_medium=email&utm_campaign=launch&utm_term=term&utm_content=hero",
        hash: "#section",
        title: "Hello",
        referrerUrl: "https://example.com/previous",
        userId: "user-1",
        userName: "Ada",
        screenWidth: "wide",
        screenHeight: Number.NaN,
        language: "en-US",
      },
      {
        cf: {
          isEUCountry: true,
          country: "DE",
          latitude: "bad",
          longitude: "also-bad",
        },
      },
    );
    const expectedVisitorId = await deriveEuVisitorId({
      ip: "203.0.113.10",
      ua: envelope.request.headers["user-agent"]!,
      eventAtMs: receivedAt - 1_000,
      secret: await expectedVisitorSecret(),
    });

    const result = await normalizeIngestRecord(envelope, context);

    expect(result.record).toMatchObject({
      kind: "pageview",
      traceId: "trace-1",
      siteId: "site-1",
      visitId: "visit-1",
      visitorId: expectedVisitorId,
      startedAt: receivedAt - 2_000,
      pathname: "/",
      hostname: "example.com",
      queryString:
        "utm_source=newsletter&utm_medium=email&utm_campaign=launch&utm_term=term&utm_content=hero",
      hashFragment: "#section",
      title: "Hello",
      referrerUrl: "",
      referrerHost: "",
      utmSource: "newsletter",
      utmMedium: "email",
      utmCampaign: "launch",
      utmTerm: "term",
      utmContent: "hero",
      userId: "user-1",
      userName: "Ada",
      screenWidth: null,
      screenHeight: null,
      language: "en-US",
      isEU: true,
      country: "DE",
      latitude: null,
      longitude: null,
    });
    if (result.record?.kind !== "pageview") {
      throw new Error("Expected a pageview record");
    }
    expect(result.record.sessionId).not.toBe("");
    expect(result.record.previousVisitId).toBe("");
    expect(result.record.previousVisitStartedAt).toBeNull();
  });

  it("preserves non-EU visitor fields, parses cross-site referrers, and prefers client timezone", async () => {
    const { context } = makeContext();

    const result = await normalizeIngestRecord(
      makeEnvelope(
        {
          kind: "pageview",
          visitId: "visit-1",
          visitorId: "visitor-1",
          previousVisitId: "previous-visit-1",
          hostname: "Blog.Example.COM",
          pathname: "/docs",
          query: "",
          referrerUrl: "https://search.example/results?q=docs",
          timezone: "Europe/Paris",
          screenWidth: 1440,
          screenHeight: "900",
          uaClientHints: {
            brands: [{ brand: "Chromium", version: "120" }],
            fullVersionList: [{ brand: "Chromium", version: "120.0.0.0" }],
            mobile: false,
            platform: "Windows",
            platformVersion: "15.0.0",
            formFactors: ["Desktop"],
          },
        },
        {
          cf: {
            isEUCountry: false,
            country: "FR",
            region: "Ile-de-France",
            regionCode: "IDF",
            city: "Paris",
            continent: "EU",
            latitude: "48.8566",
            longitude: "2.3522",
            postalCode: "75001",
            metroCode: 0,
            timezone: "Europe/London",
            asOrganization: "Transit ISP",
          },
        },
      ),
      context,
    );

    expect(result.record).toMatchObject({
      kind: "pageview",
      visitorId: "visitor-1",
      previousVisitId: "",
      previousVisitStartedAt: null,
      pathname: "/docs",
      hostname: "blog.example.com",
      referrerUrl: "https://search.example/results?q=docs",
      referrerHost: "search.example",
      utmSource: "",
      utmMedium: "",
      utmCampaign: "",
      utmTerm: "",
      utmContent: "",
      isEU: false,
      country: "FR",
      region: "Ile-de-France",
      regionCode: "IDF",
      city: "Paris",
      continent: "EU",
      latitude: 48.8566,
      longitude: 2.3522,
      postalCode: "75001",
      metroCode: "",
      timezone: "Europe/Paris",
      asOrganization: "Transit ISP",
      screenWidth: 1440,
      screenHeight: 900,
      browser: "Chromium",
      os: "Windows",
    });
    if (result.record?.kind !== "pageview") {
      throw new Error("Expected a pageview record");
    }
    expect(result.record.sessionId).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reuses a recent server-side visitor session", async () => {
    const { context } = makeContext({
      recentSession: {
        sessionId: "server-session-1",
        visitId: "visit-1",
        status: "open",
        routeMatch: 1,
        startedAt: receivedAt - 10_000,
        lastActivityAt: receivedAt - 5_000,
      },
    });

    await expect(
      normalizeIngestRecord(
        makeEnvelope({
          kind: "pageview",
          visitId: "visit-2",
          visitorId: "visitor-1",
          previousVisitId: "visit-1",
          navigation: "route",
          referrerUrl: "https://example.com/previous",
          hostname: "example.com",
        }),
        context,
      ),
    ).resolves.toMatchObject({
      record: {
        kind: "pageview",
        sessionId: "server-session-1",
        previousVisitId: "visit-1",
        previousVisitStartedAt: receivedAt - 10_000,
      },
    });
  });

  it("derives missing non-EU visitor ids from forwarded IP and clamps long payload fields", async () => {
    const { context } = makeContext();
    const long = "x".repeat(3000);
    const longUtm = "u".repeat(300);
    const envelope = makeEnvelope(
      {
        kind: "pageview",
        siteId: "s".repeat(140),
        visitId: "v".repeat(160),
        previousVisitId: "previous-visit-1",
        visitorId: "",
        hostname: `${"h".repeat(260)}.EXAMPLE.COM`,
        pathname: long,
        query: `utm_source=${longUtm}&utm_medium=${longUtm}&pad=${long}`,
        hash: long,
        title: long,
        referrerUrl: "not a url",
        userId: "",
        userName: "",
        language: long,
      },
      {
        headers: {
          "user-agent": "TestAgent/1.0",
          "x-forwarded-for": "198.51.100.42",
        },
        cf: null,
        receivedAt: receivedAt + 0.8,
      },
    );
    const expectedVisitorId = await deriveEuVisitorId({
      ip: "198.51.100.42",
      ua: "TestAgent/1.0",
      eventAtMs: receivedAt - 1_000,
      secret: await expectedVisitorSecret(),
    });

    const result = await normalizeIngestRecord(envelope, context);

    expect(result.record).toMatchObject({
      kind: "pageview",
      receivedAt,
      siteId: "s".repeat(120),
      visitId: "v".repeat(128),
      visitorId: expectedVisitorId,
      previousVisitId: "",
      previousVisitStartedAt: null,
      referrerUrl: "not a url",
      referrerHost: "",
      utmSource: longUtm.slice(0, 255),
      utmMedium: longUtm.slice(0, 255),
      userId: undefined,
      userName: undefined,
      country: "",
      region: "",
      timezone: "",
      uaRaw: "TestAgent/1.0",
    });
    if (result.record?.kind !== "pageview") {
      throw new Error("Expected a pageview record");
    }
    expect(result.record.pathname).toHaveLength(2048);
    expect(result.record.sessionId).toMatch(/^[0-9a-f]{64}$/);
    expect(result.record.queryString).toHaveLength(2048);
    expect(result.record.hashFragment).toHaveLength(1024);
    expect(result.record.title).toHaveLength(1024);
    expect(result.record.hostname).toHaveLength(255);
    expect(result.record.language).toHaveLength(120);
  });

  it("clamps stale, future, and out-of-order pageview timestamps to trusted bounds", async () => {
    const { context } = makeContext();

    const staleResult = await normalizeIngestRecord(
      makeEnvelope({
        kind: "pageview",
        visitId: "visit-1",
        visitorId: "visitor-1",
        hostname: "example.com",
        timestamp: receivedAt - 31_000,
        startedAt: receivedAt + 10_000,
      }),
      context,
    );
    const futureResult = await normalizeIngestRecord(
      makeEnvelope({
        kind: "pageview",
        visitId: "visit-1",
        visitorId: "visitor-1",
        hostname: "example.com",
        timestamp: receivedAt + 10_000,
        startedAt: receivedAt - 5_000,
      }),
      context,
    );
    const startedAfterEventResult = await normalizeIngestRecord(
      makeEnvelope({
        kind: "pageview",
        visitId: "visit-1",
        visitorId: "visitor-1",
        hostname: "example.com",
        timestamp: receivedAt - 2_000,
        startedAt: receivedAt - 1_000,
      }),
      context,
    );

    expect(staleResult.record).toMatchObject({
      kind: "pageview",
      startedAt: receivedAt,
    });
    expect(futureResult.record).toMatchObject({
      kind: "pageview",
      startedAt: receivedAt - 5_000,
    });
    expect(startedAfterEventResult.record).toMatchObject({
      kind: "pageview",
      startedAt: receivedAt - 2_000,
    });
  });
});

describe("normalizeIngestRecord leave and identify records", () => {
  it("rejects leave and identify records missing visit ids", async () => {
    const { context } = makeContext();

    await expect(
      normalizeIngestRecord(makeEnvelope({ kind: "leave" }), context),
    ).resolves.toMatchObject({ record: null, reason: "missing_visit_id" });
    await expect(
      normalizeIngestRecord(makeEnvelope({ kind: "identify" }), context),
    ).resolves.toMatchObject({ record: null, reason: "missing_visit_id" });
  });

  it("normalizes leave duration, performance visit lookup, and sparse performance data", async () => {
    const { context } = makeContext();

    const result = await normalizeIngestRecord(
      makeEnvelope({
        kind: "leave",
        visitId: "visit-1",
        durationMs: "bad",
        performance: {
          ttfb: 10.1234,
          fcp: -1,
          cls: "bad",
        },
      }),
      context,
    );

    expect(result.record).toEqual({
      kind: "leave",
      traceId: "trace-1",
      siteId: "site-1",
      visitId: "visit-1",
      performanceVisitId: "visit-1",
      receivedAt,
      leaveAt: receivedAt - 1_000,
      durationMs: null,
      exitReason: "pagehide",
      performance: {
        ttfb: 10.123,
      },
    });
  });

  it("uses explicit leave performance visit ids and nulls empty performance objects", async () => {
    const { context } = makeContext();

    await expect(
      normalizeIngestRecord(
        makeEnvelope({
          kind: "leave",
          visitId: "visit-1",
          performanceVisitId: "perf-1",
          durationMs: 1234.5,
          performance: {
            ttfb: -1,
            fcp: Number.POSITIVE_INFINITY,
          },
        }),
        context,
      ),
    ).resolves.toEqual({
      record: {
        kind: "leave",
        traceId: "trace-1",
        siteId: "site-1",
        visitId: "visit-1",
        performanceVisitId: "perf-1",
        receivedAt,
        leaveAt: receivedAt - 1_000,
        durationMs: 1234.5,
        exitReason: "pagehide",
        performance: null,
      },
    });
  });

  it("normalizes identify user fields", async () => {
    const { context } = makeContext();

    await expect(
      normalizeIngestRecord(
        makeEnvelope({
          kind: "identify",
          visitId: "visit-1",
          userId: "user-1",
          userName: "Ada",
        }),
        context,
      ),
    ).resolves.toMatchObject({
      record: {
        kind: "identify",
        siteId: "site-1",
        visitId: "visit-1",
        userId: "user-1",
        userName: "Ada",
        receivedAt,
      },
    });
  });

  it("clamps identify fields and defaults missing optional user names", async () => {
    const { context } = makeContext();

    const result = await normalizeIngestRecord(
      makeEnvelope({
        kind: "identify",
        visitId: "v".repeat(160),
        userId: "u".repeat(300),
        userName: "",
      }),
      context,
    );

    expect(result.record).toMatchObject({
      kind: "identify",
      visitId: "v".repeat(128),
      userId: "u".repeat(255),
      userName: "",
    });
  });

  it("normalizes visibility records", async () => {
    const { context } = makeContext();

    await expect(
      normalizeIngestRecord(
        makeEnvelope({
          kind: "visibility",
          visitId: "visit-1",
          visibilityState: "hidden",
        }),
        context,
      ),
    ).resolves.toEqual({
      record: {
        kind: "visibility",
        traceId: "trace-1",
        siteId: "site-1",
        visitId: "visit-1",
        visibilityState: "hidden",
        receivedAt,
        eventAt: receivedAt - 1_000,
      },
    });

    await expect(
      normalizeIngestRecord(
        makeEnvelope({
          kind: "visibility",
          visitId: "visit-1",
          visibilityState: "minimized",
        }),
        context,
      ),
    ).resolves.toMatchObject({
      record: null,
      reason: "invalid_visibility_state",
    });
  });
});

describe("normalizeIngestRecord custom event records", () => {
  it("rejects custom events missing visit ids", async () => {
    const { context } = makeContext();

    await expect(
      normalizeIngestRecord(
        makeEnvelope({
          kind: "custom_event",
          eventName: "signup",
          eventData: {},
        }),
        context,
      ),
    ).resolves.toMatchObject({ record: null, reason: "missing_visit_id" });
  });

  it("rejects invalid eventData before visit lookup", async () => {
    const { context } = makeContext({ visit: makeVisit() });

    await expect(
      normalizeIngestRecord(
        makeEnvelope({
          kind: "custom_event",
          visitId: "visit-1",
          eventName: "signup",
        }),
        context,
      ),
    ).resolves.toMatchObject({
      record: null,
      reason: "invalid_custom_event_data",
      detail: { error: "eventData is required" },
    });
  });

  it("rejects non-object custom event data", async () => {
    const { context } = makeContext({ visit: makeVisit() });

    await expect(
      normalizeIngestRecord(
        makeEnvelope({
          kind: "custom_event",
          visitId: "visit-1",
          eventName: "signup",
          eventData: [],
        }),
        context,
      ),
    ).resolves.toMatchObject({
      record: null,
      reason: "invalid_custom_event_data",
      detail: { error: "eventData must be a JSON object" },
    });
  });

  it("reports duplicate buffered custom events without scheduling an alarm", async () => {
    const state = makeContext({ inserted: false });

    const result = await normalizeIngestRecord(
      makeEnvelope({
        kind: "custom_event",
        visitId: "visit-1",
        eventId: "event-1",
        sequence: 1,
        eventName: "signup",
        eventData: { plan: "pro" },
      }),
      state.context,
    );

    expect(result).toMatchObject({
      record: null,
      reason: "waiting_for_visit",
      detail: {
        eventId: "event-1",
        eventName: "signup",
        buffered: false,
      },
    });
    expect(state.alarmCount).toBe(0);
    expect(state.buffered).toEqual([
      {
        eventId: "event-1",
        siteId: "site-1",
        visitId: "visit-1",
        occurredAt: receivedAt - 1_000,
        receivedAt,
        sequence: 0,
        eventName: "signup",
        eventDataJson: '{"plan":"pro"}',
        userId: "",
      },
    ]);
  });

  it("buffers valid custom events until the visit is available", async () => {
    const state = makeContext({ inserted: true });

    const result = await normalizeIngestRecord(
      makeEnvelope({
        kind: "custom_event",
        visitId: "visit-1",
        eventId: "event-1",
        sequence: -5,
        eventName: "signup",
        eventData: { plan: "pro", nested: { ok: true } },
        userId: "user-1",
      }),
      state.context,
    );

    expect(result).toMatchObject({
      record: null,
      reason: "waiting_for_visit",
      detail: {
        eventId: "event-1",
        eventName: "signup",
        buffered: true,
      },
    });
    expect(state.alarmCount).toBe(0);
    expect(state.buffered).toEqual([
      {
        eventId: "event-1",
        siteId: "site-1",
        visitId: "visit-1",
        occurredAt: receivedAt - 1_000,
        receivedAt,
        sequence: 0,
        eventName: "signup",
        eventDataJson: '{"plan":"pro","nested":{"ok":true}}',
        userId: "user-1",
      },
    ]);
  });

  it("maps custom events from stored visit context and overrides user fields", async () => {
    const { context } = makeContext({ visit: makeVisit() });

    const result = await normalizeIngestRecord(
      makeEnvelope({
        kind: "custom_event",
        visitId: "visit-1",
        eventId: "event-1",
        sequence: 2.9,
        eventName: "signup",
        eventData: { amount: 12, tags: ["new"] },
        userId: "client-user",
        userName: "Client User",
      }),
      context,
    );

    expect(result.record).toMatchObject({
      kind: "custom_event",
      eventId: "event-1",
      sequence: 0,
      eventAt: receivedAt - 1_000,
      eventName: "signup",
      eventDataJson: '{"amount":12,"tags":["new"]}',
      siteId: "site-1",
      visitId: "visit-1",
      visitorId: "visitor-from-visit",
      sessionId: "session-from-visit",
      pathname: "/from-visit",
      hostname: "example.com",
      userId: "client-user",
      userName: "Client User",
    });
  });

  it("uses stored visit user fields when custom event client user fields are blank", async () => {
    const { context } = makeContext({
      visit: makeVisit({
        userId: "visit-user",
        userName: "Visit User",
        utmMedium: "email",
        utmCampaign: "launch",
      }),
    });

    const result = await normalizeIngestRecord(
      makeEnvelope({
        kind: "custom_event",
        visitId: "visit-1",
        eventId: "",
        sequence: Number.NaN,
        eventName: "purchase",
        eventData: { amount: 20 },
        userId: "",
        userName: "",
      }),
      context,
    );

    expect(result.record).toMatchObject({
      kind: "custom_event",
      sequence: 0,
      eventName: "purchase",
      eventDataJson: '{"amount":20}',
      userId: "visit-user",
      userName: "Visit User",
      utmSource: "visit",
      utmMedium: "email",
      utmCampaign: "launch",
    });
    if (result.record?.kind !== "custom_event") {
      throw new Error("Expected a custom event record");
    }
    expect(result.record.eventId).toEqual(expect.any(String));
    expect(result.record.eventId).not.toBe("");
  });
});
