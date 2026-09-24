import { describe, expect, it } from "vitest";

import {
  demoLoginTurnstileConfig,
  demoNotFoundResponse,
  demoNotificationPreferences,
  demoShareTrendDimension,
  paginateDemoDetailCollection,
  paginateDemoEnvelope,
  validateDemoAnalyticsRequest,
} from "./shared";

const rows = [
  {
    label: "New",
    views: 12,
    visitors: 3,
    sessions: 8,
    reference: { views: 0, visitors: 1 },
    change: { views: { relative: 2 }, visitors: { relative: 1 } },
  },
  {
    label: "Existing",
    value: "existing-value",
    views: 8,
    visitors: 9,
    sessions: 4,
    reference: { views: 3, visitors: 2 },
    change: { views: { relative: 1 }, visitors: { relative: 3 } },
  },
  {
    pathname: "/missing-metrics",
    views: Number.NaN,
    visitors: 0,
    sessions: 0,
    reference: null,
    change: { views: { relative: Number.NaN } },
  },
];

describe("demo runtime shared helpers", () => {
  it("paginates envelopes and sorts normal and comparison metrics", () => {
    expect(paginateDemoEnvelope(null, {}, 10)).toBeNull();
    expect(paginateDemoEnvelope([], {}, 10)).toEqual([]);
    expect(paginateDemoEnvelope({ data: "not rows" }, {}, 10)).toEqual({
      data: "not rows",
    });

    const plain = paginateDemoEnvelope({ ok: true, data: rows }, {}, 10) as {
      data: { items: typeof rows; pagination: { returned: number } };
    };
    expect(plain.data.items).toEqual(rows);
    expect(plain.data.pagination.returned).toBe(3);

    const sessions = paginateDemoEnvelope(
      { data: rows },
      { sort: "sessions", direction: "asc", limit: 1 },
      10,
    ) as { data: { items: typeof rows; pagination: { hasMore: boolean } } };
    expect(sessions.data.items[0]?.pathname).toBe("/missing-metrics");
    expect(sessions.data.pagination.hasMore).toBe(true);
    const visitors = paginateDemoEnvelope(
      { data: rows },
      { sort: "visitors", direction: "desc" },
      10,
    ) as { data: { items: typeof rows } };
    expect(visitors.data.items[0]?.label).toBe("Existing");

    const reference = paginateDemoEnvelope(
      { data: rows },
      {
        compare: "same",
        metric: "visitors",
        sortBy: "reference",
        direction: "desc",
      },
      10,
    ) as { data: { items: typeof rows } };
    expect(reference.data.items[0]?.label).toBe("Existing");
    const change = paginateDemoEnvelope(
      { data: rows },
      { compare: "previous", sortBy: "change", direction: "desc" },
      10,
    ) as { data: { items: typeof rows } };
    expect(change.data.items[0]?.label).toBe("New");
    const searched = paginateDemoEnvelope(
      { data: rows },
      { q: "existing", sort: "views" },
      10,
    ) as { data: { items: typeof rows } };
    expect(searched.data.items).toHaveLength(1);
    expect(searched.data.items[0]?.label).toBe("Existing");
  });

  it("normalizes share dimensions and paginates detail collections", () => {
    expect(demoShareTrendDimension(null)).toEqual({ series: [], data: [] });
    expect(demoShareTrendDimension({ series: [1], data: "bad" })).toEqual({
      series: [1],
      data: [],
    });
    expect(demoShareTrendDimension({ series: null, data: [2] })).toEqual({
      series: [],
      data: [2],
    });
    expect(demoNotFoundResponse()).toMatchObject({ ok: false });
    expect(demoNotificationPreferences).toMatchObject({
      inApp: true,
      email: true,
      webPush: false,
      attention: { alertsCreateUnread: true },
    });

    expect(paginateDemoDetailCollection(null, "events", {})).toMatchObject({
      ok: true,
      data: { items: [] },
    });
    expect(
      paginateDemoDetailCollection(
        { ok: false, data: { events: rows, sessions: ["a", "b"] } },
        "events",
        { visitorId: "visitor-1", siteId: "site-1", limit: 1 },
      ),
    ).toMatchObject({
      ok: false,
      data: { items: [rows[0]], pagination: { hasMore: true } },
    });
    expect(
      paginateDemoDetailCollection(
        { ok: true, data: { sessions: ["a", "b"] } },
        "sessions",
        { visitorId: "visitor-2" },
      ),
    ).toMatchObject({ ok: true, data: { items: ["a", "b"] } });
  });

  it("validates analytics query parameters and permits valid combinations", () => {
    const invalidWindowPath = "/api/private/overview";
    expect(validateDemoAnalyticsRequest("/unrelated", { from: -1 })).toBeNull();
    expect(
      validateDemoAnalyticsRequest(invalidWindowPath, { from: "bad" }),
    ).toMatchObject({ ok: false });
    expect(
      validateDemoAnalyticsRequest(invalidWindowPath, { to: "bad" }),
    ).toMatchObject({ ok: false });
    expect(
      validateDemoAnalyticsRequest(invalidWindowPath, { from: -1, to: 1 }),
    ).toMatchObject({ ok: false });
    expect(
      validateDemoAnalyticsRequest(invalidWindowPath, { from: 10, to: 10 }),
    ).toMatchObject({ ok: false });
    const validWindow = { from: 10, to: 20 };

    expect(
      validateDemoAnalyticsRequest("/api/private/client-dimension-trend", {
        ...validWindow,
        dimension: "unsupported",
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateDemoAnalyticsRequest("/api/private/client-dimension-trend", {
        ...validWindow,
        dimension: "browser",
      }),
    ).toBeNull();
    expect(
      validateDemoAnalyticsRequest("/api/private/utm-dimension-trend", {
        ...validWindow,
        dimension: "unsupported",
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateDemoAnalyticsRequest("/api/private/utm-dimension-trend", {
        ...validWindow,
        dimension: "campaign",
      }),
    ).toBeNull();
    expect(
      validateDemoAnalyticsRequest("/api/private/client-cross-breakdown", {
        ...validWindow,
        primaryDimension: "bad",
        secondaryDimension: "browser",
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateDemoAnalyticsRequest("/api/private/client-cross-breakdown", {
        ...validWindow,
        primaryDimension: "browser",
        secondaryDimension: "bad",
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateDemoAnalyticsRequest("/api/private/client-cross-breakdown", {
        ...validWindow,
        primaryDimension: "browser",
        secondaryDimension: "browser",
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateDemoAnalyticsRequest("/api/private/client-cross-breakdown", {
        ...validWindow,
        primaryDimension: "browser",
        secondaryDimension: "geo.country",
      }),
    ).toBeNull();

    const validCards =
      "path,query,title,hostname,entry,exit,sourceDomain,sourceLink,browser,osVersion,deviceType,language,screenSize,country,region,city,continent,timezone,organization";
    expect(
      validateDemoAnalyticsRequest("/api/private/event-type-context", {
        ...validWindow,
        cards: validCards,
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateDemoAnalyticsRequest("/api/private/event-type-context", {
        ...validWindow,
        eventName: "Purchase",
        cards: "",
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateDemoAnalyticsRequest("/api/private/event-type-context", {
        ...validWindow,
        eventName: "Purchase",
        cards: `${validCards},unknown`,
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateDemoAnalyticsRequest("/api/private/event-type-context", {
        ...validWindow,
        eventName: "Purchase",
        cards: validCards,
      }),
    ).toBeNull();
    expect(
      validateDemoAnalyticsRequest(
        "/api/private/event-type-detail",
        validWindow,
      ),
    ).toMatchObject({ ok: false });
    expect(
      validateDemoAnalyticsRequest("/api/private/event-type-detail", {
        ...validWindow,
        eventName: "Purchase",
      }),
    ).toBeNull();

    expect(
      validateDemoAnalyticsRequest("/api/private/event-type-field-values", {
        ...validWindow,
        fieldValueType: "string",
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateDemoAnalyticsRequest("/api/private/event-type-field-values", {
        ...validWindow,
        fieldPath: "/x",
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateDemoAnalyticsRequest("/api/private/event-type-field-values", {
        ...validWindow,
        fieldPath: "/x",
        fieldValueType: "bad",
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateDemoAnalyticsRequest("/api/private/event-fields/values", {
        ...validWindow,
        fieldPath: "/x",
        fieldValueType: "array",
      }),
    ).toBeNull();
    expect(
      validateDemoAnalyticsRequest(
        "/api/private/event-record-detail",
        validWindow,
      ),
    ).toMatchObject({ ok: false });
    expect(
      validateDemoAnalyticsRequest("/api/private/event-record-detail", {
        ...validWindow,
        eventId: "event-1",
      }),
    ).toBeNull();

    expect(
      validateDemoAnalyticsRequest(
        "/api/private/journey-event-detail",
        validWindow,
      ),
    ).toMatchObject({ ok: false });
    expect(
      validateDemoAnalyticsRequest("/api/private/journey-event-detail", {
        ...validWindow,
        eventId: "event-1",
        eventKind: "bad",
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateDemoAnalyticsRequest("/api/private/journey-events/detail", {
        ...validWindow,
        eventId: "event-1",
        eventKind: "leave",
      }),
    ).toBeNull();
    expect(
      validateDemoAnalyticsRequest("/api/private/visitor-detail", validWindow),
    ).toMatchObject({ ok: false });
    expect(
      validateDemoAnalyticsRequest("/api/private/visitor-detail", {
        ...validWindow,
        visitorId: "visitor-1",
      }),
    ).toBeNull();
    expect(
      validateDemoAnalyticsRequest("/api/private/session-detail", validWindow),
    ).toMatchObject({ ok: false });
    expect(
      validateDemoAnalyticsRequest("/api/private/session-detail", {
        ...validWindow,
        sessionId: "session-1",
      }),
    ).toBeNull();
    expect(
      validateDemoAnalyticsRequest("/api/private/visitor-events", validWindow),
    ).toMatchObject({ ok: false });
    expect(
      validateDemoAnalyticsRequest("/api/private/visitor-sessions", {
        ...validWindow,
        visitorId: "visitor-1",
      }),
    ).toBeNull();
    expect(
      validateDemoAnalyticsRequest("/api/private/session-events", validWindow),
    ).toMatchObject({ ok: false });
    expect(
      validateDemoAnalyticsRequest("/api/private/session-events", {
        ...validWindow,
        sessionId: "session-1",
      }),
    ).toBeNull();
    expect(
      validateDemoAnalyticsRequest("/api/v1/events", validWindow),
    ).toBeNull();
  });

  it("normalizes Turnstile settings and secret hints", () => {
    expect(demoLoginTurnstileConfig()).toMatchObject({
      enabled: false,
      siteKey: "",
      mode: "invisible",
      secretKeyConfigured: false,
      secretKeyHint: "",
      updatedAt: 0,
    });
    expect(
      demoLoginTurnstileConfig({
        secretKey: "   ",
        enabled: "yes",
        siteKey: 1,
      }),
    ).toMatchObject({
      enabled: false,
      siteKey: "",
      secretKeyConfigured: false,
      secretKeyHint: "",
    });
    expect(
      demoLoginTurnstileConfig({
        secretKey: "  secret1234  ",
        enabled: true,
        siteKey: "site-key",
      }),
    ).toMatchObject({
      enabled: true,
      siteKey: "site-key",
      secretKeyConfigured: true,
      secretKeyHint: "••••1234",
    });
  });
});
