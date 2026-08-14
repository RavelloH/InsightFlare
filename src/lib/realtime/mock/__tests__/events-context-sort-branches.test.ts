import { describe, expect, it } from "vitest";

import {
  demoEventContextCards,
  demoEventDimensionRows,
  demoEventSummaryCards,
} from "@/lib/realtime/mock/events-context";
import type { DemoCustomEventFact } from "@/lib/realtime/mock/events-facts";
import { filterDemoCustomEventsByPayload } from "@/lib/realtime/mock/events-payload-filter";
import {
  parseDemoEventRecordSort,
  sortDemoEventRecords,
} from "@/lib/realtime/mock/events-sort";
import type { DemoFactDataset, DemoVisitFact } from "@/lib/realtime/mock/types";

describe("mock/events-sort branch behavior", () => {
  it("parses supported sort keys, asc direction, and default fallbacks", () => {
    expect(
      parseDemoEventRecordSort({ sortBy: "eventName", sortDir: "ASC" }),
    ).toEqual({
      key: "eventName",
      direction: "asc",
    });
    expect(parseDemoEventRecordSort({ sortBy: "pathname" })).toEqual({
      key: "pathname",
      direction: "desc",
    });
    expect(
      parseDemoEventRecordSort({ sortBy: "unknown", sortDir: "up" }),
    ).toEqual({
      key: "occurredAt",
      direction: "desc",
    });
  });

  it("sorts by event name and uses newest occurrence as the tie breaker", () => {
    const rows = [
      makeEvent("purchase-old", "purchase", 100, makeVisit({ pathname: "/b" })),
      makeEvent("signup", "signup", 150, makeVisit({ pathname: "/a" })),
      makeEvent("purchase-new", "purchase", 300, makeVisit({ pathname: "/c" })),
    ];

    expect(
      sortDemoEventRecords(rows, { key: "eventName", direction: "asc" }).map(
        (event) => event.eventId,
      ),
    ).toEqual(["purchase-new", "purchase-old", "signup"]);
  });

  it("sorts by pathname descending and uses newest occurrence for path ties", () => {
    const rows = [
      makeEvent(
        "pricing-old",
        "view",
        100,
        makeVisit({ pathname: "/pricing" }),
      ),
      makeEvent("settings", "view", 250, makeVisit({ pathname: "/settings" })),
      makeEvent(
        "pricing-new",
        "view",
        300,
        makeVisit({ pathname: "/pricing" }),
      ),
    ];

    expect(
      sortDemoEventRecords(rows, { key: "pathname", direction: "desc" }).map(
        (event) => event.eventId,
      ),
    ).toEqual(["settings", "pricing-new", "pricing-old"]);
  });

  it("sorts by occurrence time in either direction", () => {
    const rows = [
      makeEvent("middle", "view", 200),
      makeEvent("latest", "view", 300),
      makeEvent("earliest", "view", 100),
    ];

    expect(
      sortDemoEventRecords(rows, { key: "occurredAt", direction: "asc" }).map(
        (event) => event.eventId,
      ),
    ).toEqual(["earliest", "middle", "latest"]);
    expect(
      sortDemoEventRecords(rows, { key: "occurredAt", direction: "desc" }).map(
        (event) => event.eventId,
      ),
    ).toEqual(["latest", "middle", "earliest"]);
  });
});

describe("mock/events-context branch behavior", () => {
  it("dedupes sessions and visitors, drops blank labels, sorts ties, and limits rows", () => {
    const dataset = makeDataset({
      sessions: [
        ["s1", 2],
        ["s2", 3],
        ["s3", 1],
      ],
      visitors: [
        ["u1", 1.4],
        ["u2", 2.6],
        ["u3", 1],
      ],
    });
    const events = [
      makeEvent(
        "alpha-1",
        "click",
        100,
        makeVisit({ sessionId: "s1", visitorId: "u1" }),
      ),
      makeEvent(
        "alpha-2",
        "click",
        200,
        makeVisit({ sessionId: "s2", visitorId: "u2" }),
      ),
      makeEvent(
        "beta-1",
        "click",
        300,
        makeVisit({ sessionId: "s3", visitorId: "u3" }),
      ),
      makeEvent(
        "beta-2",
        "click",
        400,
        makeVisit({ sessionId: "s3", visitorId: "u3" }),
      ),
      makeEvent("blank", "click", 500, makeVisit({ pathname: "" })),
      makeEvent("gamma", "click", 600, makeVisit({ pathname: "/gamma" })),
    ];

    expect(
      demoEventDimensionRows(dataset, events, 2, (event) =>
        event.eventId === "blank" ? "   " : event.visit.pathname,
      ),
    ).toEqual([
      { label: "/home", views: 4, sessions: 6, visitors: 5 },
      { label: "/gamma", views: 1, sessions: 2, visitors: 1 },
    ]);
  });

  it("clamps negative weighted session and visitor totals to zero", () => {
    const dataset = makeDataset({
      sessions: [["s1", -2.4]],
      visitors: [["u1", -1.6]],
    });

    expect(
      demoEventDimensionRows(
        dataset,
        [makeEvent("negative", "click", 100)],
        10,
        () => "negative weights",
      ),
    ).toEqual([
      { label: "negative weights", views: 1, sessions: 0, visitors: 0 },
    ]);
  });

  it("skips null labels and sparse geo values while falling back to generated geo labels", () => {
    const dataset = makeDataset();
    expect(
      demoEventDimensionRows(
        dataset,
        [makeEvent("null-label", "click", 100)],
        10,
        () => null as never,
      ),
    ).toEqual([]);

    const cards = demoEventContextCards(
      dataset,
      [
        makeEvent(
          "empty-geo",
          "signup",
          100,
          makeVisit({
            country: null as never,
            regionCode: "",
            regionName: "",
            region: "",
            cityName: "",
            city: "Austin",
          }),
        ),
        makeEvent(
          "blank-region-label",
          "signup",
          200,
          makeVisit({
            country: "US",
            regionCode: "CA",
            regionName: "",
            region: "   ",
            cityName: "",
            city: "   ",
          }),
        ),
        makeEvent(
          "city-name-only",
          "signup",
          300,
          makeVisit({
            country: "",
            regionCode: "",
            regionName: "",
            region: "",
            cityName: "Austin",
            city: "",
          }),
        ),
      ],
      10,
    );

    expect(cards.geo.country).toEqual([
      { value: "US", label: "US", views: 1, sessions: 1, visitors: 1 },
    ]);
    expect(cards.geo.region).toEqual([
      {
        value: "US::CA::CA",
        label: "US::CA::CA",
        views: 1,
        sessions: 1,
        visitors: 1,
      },
    ]);
    expect(cards.geo.city).toEqual(
      expect.arrayContaining([
        {
          value: "::::::Austin",
          label: "Austin",
          views: 1,
          sessions: 1,
          visitors: 1,
        },
        {
          value: "US::CA::CA::",
          label: "US::CA::CA::",
          views: 1,
          sessions: 1,
          visitors: 1,
        },
      ]),
    );
  });

  it("builds context cards with page/session fallbacks and geo value fallbacks", () => {
    const dataset = makeDataset({
      sessions: [["known-session", 1]],
      visitors: [["known-visitor", 1]],
    });
    dataset.sessions.set("known-session", {
      sessionId: "known-session",
      visitorId: "known-visitor",
      entryPath: "/campaign",
      exitPath: "/checkout",
      weight: 1,
    });
    const events = [
      makeEvent(
        "known",
        "purchase",
        200,
        makeVisit({
          sessionId: "known-session",
          visitorId: "known-visitor",
          pathname: "/pricing",
          title: "Pricing",
          hostname: "app.example.test",
          referrerHost: "search.example",
          referrerUrl: "https://search.example/result",
          browser: "Safari",
          osVersion: "iOS 18",
          deviceType: "Mobile",
          language: "en-US",
          screenSize: "390x844",
          country: "US",
          regionCode: "CA",
          regionName: "California",
          region: "US::CA::California",
          cityName: "San Francisco",
          city: "US::CA::California::San Francisco",
          continent: "North America",
          timezone: "America/Los_Angeles",
          organization: "Example ISP",
        }),
      ),
      makeEvent(
        "missing-session",
        "signup",
        100,
        makeVisit({
          sessionId: "missing-session",
          visitorId: "missing-visitor",
          pathname: "/signup",
          country: "",
          regionCode: "Berlin",
          regionName: "",
          region: "Berlin",
          cityName: "",
          city: "Berlin",
        }),
      ),
    ];

    const cards = demoEventContextCards(dataset, events, 5);

    expect(cards.page.entry.map((row) => row.label)).toEqual([
      "/campaign",
      "/signup",
    ]);
    expect(cards.page.exit.map((row) => row.label)).toEqual([
      "/checkout",
      "/signup",
    ]);
    expect(cards.source.domain[0]).toMatchObject({
      label: "search.example",
      views: 1,
    });
    expect(cards.geo.region.map((row) => row.label)).toEqual([
      "California",
      "Berlin",
    ]);
    expect(cards.geo.region.map((row) => row.value)).toEqual([
      "US::CA::California",
      "::Berlin::Berlin",
    ]);
    expect(cards.geo.city.map((row) => row.label)).toEqual([
      "San Francisco",
      "Berlin",
    ]);
    expect(cards.geo.city.map((row) => row.value)).toEqual([
      "US::CA::California::San Francisco",
      "::Berlin::Berlin::Berlin",
    ]);
  });

  it("builds summary cards from event names and page fields", () => {
    const dataset = makeDataset();
    const events = [
      makeEvent("purchase", "purchase", 200, makeVisit({ title: "Checkout" })),
      makeEvent("signup", "signup", 100, makeVisit({ title: "Signup" })),
      makeEvent(
        "purchase-2",
        "purchase",
        300,
        makeVisit({ title: "Checkout" }),
      ),
    ];

    const summary = demoEventSummaryCards(dataset, events, 10);

    expect(summary.event.name[0]).toMatchObject({
      label: "purchase",
      views: 2,
    });
    expect(summary.page.title.map((row) => row.label)).toEqual([
      "Checkout",
      "Signup",
    ]);
    expect(summary.page.hostname[0]).toMatchObject({
      label: "example.test",
      views: 3,
    });
  });
});

describe("mock/events-payload-filter branch behavior", () => {
  it("filters boolean payload values and rejects mismatched expected types", () => {
    const signedIn = makeEvent("signed-in", "signup", 200);
    const signedOut = makeEvent("alpha", "signup", 100);
    const events = [signedIn, signedOut];

    expect(
      filterDemoCustomEventsByPayload(events, {
        eventPayloadFilters: [
          { path: "/flags/signedIn", operator: "eq", value: true },
        ],
      }).map((event) => event.eventId),
    ).toEqual(["signed-in"]);

    expect(
      filterDemoCustomEventsByPayload(events, {
        eventPayloadFilters: [
          { path: "/flags/signedIn", operator: "ne", value: false },
        ],
      }).map((event) => event.eventId),
    ).toEqual(["signed-in"]);

    expect(
      filterDemoCustomEventsByPayload(events, {
        eventPayloadFilters: [
          { path: "/flags/signedIn", operator: "eq", value: "true" },
        ],
      }),
    ).toEqual([]);
  });
});

function makeDataset(
  options: {
    sessions?: Array<[string, number]>;
    visitors?: Array<[string, number]>;
  } = {},
): DemoFactDataset {
  const dataset: DemoFactDataset = {
    from: 0,
    to: 1_000,
    viewWeight: 1,
    visits: [],
    sessions: new Map(),
    visitors: new Map(),
  };

  for (const [sessionId, weight] of options.sessions ?? [["s1", 1]]) {
    dataset.sessions.set(sessionId, {
      sessionId,
      visitorId: visitorIdForSession(sessionId),
      entryPath: "/home",
      exitPath: "/home",
      weight,
    });
  }
  for (const [visitorId, weight] of options.visitors ?? [["u1", 1]]) {
    dataset.visitors.set(visitorId, { visitorId, weight });
  }

  return dataset;
}

function visitorIdForSession(sessionId: string): string {
  if (sessionId.startsWith("s")) return `u${sessionId.slice(1)}`;
  return sessionId.replace("session", "visitor");
}

function makeEvent(
  eventId: string,
  eventName: string,
  occurredAt: number,
  visit: DemoVisitFact = makeVisit(),
): DemoCustomEventFact {
  return {
    eventId,
    eventName,
    occurredAt,
    receivedAt: occurredAt + 120,
    sequence: 1,
    visit,
  };
}

function makeVisit(overrides: Partial<DemoVisitFact> = {}): DemoVisitFact {
  return {
    visitId: "visit-1",
    sessionId: "s1",
    visitorId: "u1",
    startedAt: 0,
    pathname: "/home",
    title: "Home",
    hostname: "example.test",
    referrerHost: "",
    referrerUrl: "",
    browser: "Chrome",
    browserVersion: "138",
    osVersion: "Windows 11",
    deviceType: "Desktop",
    language: "en-US",
    screenSize: "1920x1080",
    country: "US",
    regionCode: "",
    regionName: "",
    region: "",
    cityName: "",
    city: "",
    continent: "",
    timezone: "",
    organization: "",
    latitude: 0,
    longitude: 0,
    eventType: "pageview",
    durationMs: 0,
    ...overrides,
  };
}
