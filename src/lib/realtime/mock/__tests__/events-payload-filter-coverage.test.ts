import { describe, expect, it } from "vitest";

import type {
  CanonicalJsonPath,
  FilterCondition,
  FilterDocument,
  FilterExpression,
  FilterOperator,
} from "@/lib/filter-contract";
import { createDemoCustomEventFacts } from "@/lib/realtime/mock/events-facts";
import { filterDemoCustomEventsByPayload } from "@/lib/realtime/mock/events-payload-filter";
import { buildCanonicalDemoFacts } from "@/lib/realtime/mock/fact-filters";
import type { DemoFactDataset, DemoVisitFact } from "@/lib/realtime/mock/types";

const path = (value: string) => value as CanonicalJsonPath;

function payloadCondition(
  targetPath: string,
  operator: FilterOperator,
  value?: FilterCondition["value"],
): FilterCondition {
  return {
    kind: "condition",
    target: { kind: "event-payload", path: path(targetPath) },
    operator,
    ...(value === undefined ? {} : { value }),
  };
}

function fieldCondition(
  field: string,
  operator: FilterOperator,
  value?: FilterCondition["value"],
): FilterCondition {
  return {
    kind: "condition",
    target: { kind: "field", field: field as never },
    operator,
    ...(value === undefined ? {} : { value }),
  };
}

function document(root: FilterExpression | null): FilterDocument {
  return { version: 1, root };
}

function withPayload(
  condition: FilterCondition,
  payloadValue = "home",
): FilterDocument {
  return document({
    kind: "and",
    children: [
      condition,
      payloadCondition("/page/path", "eq", `/${payloadValue}`),
    ],
  });
}

describe("events payload filter complete operator coverage", () => {
  it("evaluates payload scalar, set, string, ordering, and presence operators", () => {
    const visit = makeVisit({
      pathname: "/home",
      title: "",
      screenSize: "1920x1080",
      eventType: "signup",
    });
    const [event] = createDemoCustomEventFacts([visit]);
    if (!event) throw new Error("Expected custom event");
    const events = [event];
    const matching = (condition: FilterCondition) =>
      expect(
        filterDemoCustomEventsByPayload(events, withPayload(condition)),
      ).toHaveLength(1);
    const missing = (condition: FilterCondition) =>
      expect(
        filterDemoCustomEventsByPayload(events, withPayload(condition)),
      ).toHaveLength(0);

    matching(payloadCondition("/page/path", "eq", "/home"));
    matching(payloadCondition("/page/path", "neq", "/pricing"));
    matching(payloadCondition("/page/path", "in", ["/pricing", "/home"]));
    matching(payloadCondition("/page/path", "notIn", ["/pricing"]));
    matching(payloadCondition("/page/path", "contains", "om"));
    matching(payloadCondition("/page/path", "startsWith", "/"));
    matching(payloadCondition("/page/path", "endsWith", "home"));
    matching(payloadCondition("/device/screen/width", "gt", 1919));
    matching(payloadCondition("/device/screen/width", "gte", 1920));
    matching(payloadCondition("/device/screen/width", "lt", 1921));
    matching(payloadCondition("/device/screen/width", "lte", 1920));
    matching(payloadCondition("/device/screen/width", "between", [1900, 2000]));
    matching(payloadCondition("/device/screen/width", "in", [1, 1920]));
    matching(payloadCondition("/device/screen/width", "notIn", [1, 2]));
    matching(payloadCondition("/page/path", "exists"));
    matching(payloadCondition("/items/*", "isNull"));
    matching(payloadCondition("/items/*", "notNull"));
    matching(payloadCondition("/page/title", "isEmpty"));
    matching(payloadCondition("/page/path", "notEmpty"));
    missing(payloadCondition("/missing", "exists"));
    matching(payloadCondition("/missing", "notExists"));
    missing(payloadCondition("/page/path", "contains", "pricing"));
    missing(payloadCondition("/device/screen/width", "gt", 1920));
    missing(payloadCondition("/device/screen/width", "between", [2000, 3000]));
    missing(payloadCondition("/page/path", "eq", 123));
    missing({
      ...payloadCondition("/page/path", "eq", "/home"),
      operator: "unsupported" as FilterOperator,
    });
  });

  it("evaluates event-context fields and nested event expressions", () => {
    const visit = makeVisit({
      pathname: "/home",
      title: "Home",
      durationMs: 100,
      eventType: "signup",
      userId: undefined,
    });
    const [event] = createDemoCustomEventFacts([visit]);
    if (!event) throw new Error("Expected custom event");
    const events = [event];
    const facts = buildCanonicalDemoFacts(makeDataset([visit]));
    const payload = payloadCondition("/page/path", "eq", "/home");
    const matches = (condition: FilterCondition) =>
      filterDemoCustomEventsByPayload(events, withPayload(condition)).length;

    expect(matches(fieldCondition("page.path", "exists"))).toBe(1);
    expect(matches(fieldCondition("page.path", "notNull"))).toBe(1);
    expect(matches(fieldCondition("event.name", "eq", "signup"))).toBe(1);
    expect(matches(fieldCondition("event.name", "neq", "purchase"))).toBe(1);
    expect(matches(fieldCondition("page.path", "in", ["/home"]))).toBe(1);
    expect(matches(fieldCondition("page.path", "notIn", ["/pricing"]))).toBe(1);
    expect(matches(fieldCondition("page.path", "contains", "om"))).toBe(1);
    expect(matches(fieldCondition("page.path", "startsWith", "/"))).toBe(1);
    expect(matches(fieldCondition("page.path", "endsWith", "home"))).toBe(1);
    expect(
      matches(fieldCondition("page.durationMs", "between", [90, 110])),
    ).toBe(1);
    expect(matches(fieldCondition("page.durationMs", "gt", 99))).toBe(1);
    expect(matches(fieldCondition("page.durationMs", "gte", 100))).toBe(1);
    expect(matches(fieldCondition("page.durationMs", "lt", 101))).toBe(1);
    expect(matches(fieldCondition("page.durationMs", "lte", 100))).toBe(1);
    expect(matches(fieldCondition("user.id", "notExists"))).toBe(1);
    expect(matches(fieldCondition("page.path", "notEmpty"))).toBe(1);
    expect(matches(fieldCondition("page.path", "isEmpty"))).toBe(0);
    expect(matches(fieldCondition("page.path", "gt", "z"))).toBe(0);
    expect(matches(fieldCondition("user.id", "eq", "missing"))).toBe(0);
    expect(
      filterDemoCustomEventsByPayload(
        events,
        document({
          kind: "not",
          child: {
            kind: "and",
            children: [fieldCondition("page.path", "eq", "/pricing"), payload],
          },
        }),
      ),
    ).toHaveLength(1);
    expect(facts.sessions.size).toBe(1);
  });

  it("preserves no-op filters and uses all events as scoped payload witnesses", () => {
    const candidateVisit = makeVisit({
      visitId: "candidate",
      sessionId: "shared",
      visitorId: "visitor",
      eventType: "signup",
    });
    const witnessVisit = makeVisit({
      visitId: "witness",
      sessionId: "shared",
      visitorId: "visitor",
      eventType: "purchase",
    });
    const candidate = createDemoCustomEventFacts([candidateVisit])[0]!;
    const candidates = [candidate];
    expect(filterDemoCustomEventsByPayload(candidates, document(null))).toBe(
      candidates,
    );
    expect(
      filterDemoCustomEventsByPayload(candidates, {
        version: 1,
        root: fieldCondition("page.path", "eq", "/home"),
      }),
    ).toBe(candidates);

    const payload = document(payloadCondition("/order/currency", "eq", "USD"));
    expect(
      filterDemoCustomEventsByPayload(
        candidates,
        { filterDocument: payload, scope: "session" },
        { allVisits: [candidateVisit, witnessVisit] },
      ),
    ).toHaveLength(1);
    expect(
      filterDemoCustomEventsByPayload(
        candidates,
        { filterDocument: payload, scope: "visitor" },
        { allVisits: [candidateVisit, witnessVisit] },
      ),
    ).toHaveLength(1);
    expect(
      filterDemoCustomEventsByPayload(
        candidates,
        {
          filterDocument: document({
            kind: "or",
            children: [
              fieldCondition("page.path", "eq", "/missing"),
              payload.root!,
            ],
          }),
          scope: "session",
        },
        { allVisits: [candidateVisit, witnessVisit] },
      ),
    ).toHaveLength(1);
  });
});

function makeDataset(visits: DemoVisitFact[]): DemoFactDataset {
  return {
    from: 0,
    to: 1,
    viewWeight: 1,
    visits,
    sessions: new Map(),
    visitors: new Map(),
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
    regionCode: "CA",
    regionName: "California",
    region: "US::CA::California",
    cityName: "San Francisco",
    city: "US::CA::California::San Francisco",
    continent: "North America",
    timezone: "UTC",
    organization: "Example ISP",
    latitude: 0,
    longitude: 0,
    eventType: "signup",
    durationMs: 1000,
    ...overrides,
  };
}
