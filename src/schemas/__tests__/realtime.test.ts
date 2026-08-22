import { describe, expect, it } from "vitest";

import {
  ActiveVisitorsResponseSchema,
  ActiveVisitorsSchema,
  RealtimeEventSchema,
  RealtimeSnapshotDataSchema,
  RealtimeSnapshotResponseSchema,
} from "@/schemas/realtime";

describe("RealtimeEventSchema", () => {
  const validEvent = {
    id: "evt-1",
    eventType: "pageview" as const,
    eventAt: 1700000000000,
    visitId: "v-1",
    visitorId: "vis-1",
    pathname: "/home",
  };

  it("accepts a valid pageview event", () => {
    expect(RealtimeEventSchema.safeParse(validEvent).success).toBe(true);
  });

  it("accepts a custom_event with eventName", () => {
    expect(
      RealtimeEventSchema.safeParse({
        ...validEvent,
        eventType: "custom_event",
        eventName: "button_click",
      }).success,
    ).toBe(true);
  });

  it("accepts a leave event", () => {
    expect(
      RealtimeEventSchema.safeParse({ ...validEvent, eventType: "leave" })
        .success,
    ).toBe(true);
  });

  it("rejects invalid eventKind", () => {
    expect(
      RealtimeEventSchema.safeParse({ ...validEvent, eventKind: "click" })
        .success,
    ).toBe(false);
  });

  it("accepts optional geo and device fields", () => {
    expect(
      RealtimeEventSchema.safeParse({
        ...validEvent,
        country: "US",
        region: "CA",
        city: "SF",
        latitude: 37.7749,
        longitude: -122.4194,
        browser: "Chrome",
        os: "macOS",
        deviceType: "desktop",
      }).success,
    ).toBe(true);
  });
});

describe("RealtimeSnapshotDataSchema", () => {
  it("accepts valid snapshot", () => {
    expect(
      RealtimeSnapshotDataSchema.safeParse({ activeNow: 5, events: [] })
        .success,
    ).toBe(true);
  });

  it("rejects non-integer activeNow", () => {
    expect(
      RealtimeSnapshotDataSchema.safeParse({ activeNow: 1.5, events: [] })
        .success,
    ).toBe(false);
  });
});

describe("ActiveVisitorsSchema", () => {
  it("accepts valid data", () => {
    expect(ActiveVisitorsSchema.safeParse({ activeNow: 0 }).success).toBe(true);
  });
});

describe("RealtimeSnapshotResponseSchema", () => {
  it("accepts valid envelope", () => {
    expect(
      RealtimeSnapshotResponseSchema.safeParse({
        ok: true,
        requestId: "r",
        timestamp: "t",
        data: { activeNow: 3, events: [] },
      }).success,
    ).toBe(true);
  });
});

describe("ActiveVisitorsResponseSchema", () => {
  it("accepts valid envelope", () => {
    expect(
      ActiveVisitorsResponseSchema.safeParse({
        ok: true,
        requestId: "r",
        timestamp: "t",
        data: { activeNow: 10 },
      }).success,
    ).toBe(true);
  });
});
