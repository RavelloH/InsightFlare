import { describe, expect, it } from "vitest";

import { demoEventRecordPayload } from "@/lib/realtime/mock/events-payload";
import type { DemoCustomEventFact } from "@/lib/realtime/mock/events-facts";
import type { DemoVisitFact } from "@/lib/realtime/mock/types";

describe("mock/events-payload", () => {
  it("attaches a product block for cart events", () => {
    const payload = demoEventRecordPayload(makeEvent("cart-1", "cart"));
    expect(payload.product).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        category: expect.any(String),
        price: expect.any(Number),
      }),
    );
    expect(payload.order).toBeUndefined();
  });

  it("returns only the base payload for unrelated events", () => {
    const payload = demoEventRecordPayload(makeEvent("click-1", "click"));
    expect(payload).toEqual(
      expect.objectContaining({
        plan: expect.any(String),
        items: expect.any(Array),
      }),
    );
    expect(payload.order).toBeUndefined();
    expect(payload.product).toBeUndefined();
  });
});

function makeEvent(eventId: string, eventName: string): DemoCustomEventFact {
  return {
    eventId,
    eventName,
    occurredAt: 1000,
    receivedAt: 1120,
    sequence: 1,
    visit: makeVisit(),
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
