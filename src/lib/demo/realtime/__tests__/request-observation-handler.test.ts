import { beforeEach, describe, expect, it, vi } from "vitest";

const { generateData } = vi.hoisted(() => ({
  generateData: vi.fn(),
}));

vi.mock("@/lib/demo/realtime/request-observation", () => ({
  generateDemoRequestObservationData: generateData,
}));

import { demoRequestObservationResponse } from "@/lib/demo/realtime/request-observation-handler";

const baseEvent = {
  timestamp: "2026-09-24T00:00:00.000Z",
  receivedAt: 1_790_193_600_100,
  eventAt: 1_790_193_600_000,
  siteId: "site-1",
  siteName: "Example",
  siteDomain: "example.com",
  kind: "pageview",
  category: "bot",
  disposition: "blocked",
  reasons: ["bot score", "user-agent"],
  ip: "203.0.113.10",
  userAgent: "ExampleBot",
  origin: "https://example.com",
  hostname: "example.com",
  pathname: "/admin",
  country: "US",
  region: "CA",
  city: "San Francisco",
  continent: "NA",
  colo: "SFO",
  asn: 13335,
  asOrganization: "Example Network",
  verifiedBotCategory: "Search Engine Crawler",
  rayId: "ray-1",
  traceId: "trace-1",
  requestMethod: "GET",
  httpProtocol: "HTTP/2",
  metadataJson: "{}",
  latitude: 37.77,
  longitude: -122.41,
  botScore: 25,
  userAgentLength: 10,
  edgeLatencyMs: 32,
  sampleWeight: 2,
};

const events = [
  baseEvent,
  {
    ...baseEvent,
    traceId: "trace-2",
    rayId: "ray-2",
    botScore: 5,
    userAgentLength: 80,
    reasons: "single reason",
  },
  {
    ...baseEvent,
    traceId: "trace-3",
    rayId: "ray-3",
    botScore: 45,
    userAgentLength: 160,
    ip: "2001:db8:1:2:3::1",
  },
  {
    ...baseEvent,
    traceId: "trace-4",
    rayId: "ray-4",
    botScore: 65,
    userAgentLength: 256,
    ip: "not-an-ip",
  },
  {
    ...baseEvent,
    traceId: "trace-5",
    rayId: "ray-5",
    botScore: 95,
    userAgentLength: 512,
  },
  {
    ...baseEvent,
    traceId: "trace-6",
    rayId: "ray-6",
    botScore: null,
    userAgentLength: 0,
    reasons: [],
    category: "custom_block",
  },
];
const includedEvent = {
  ...baseEvent,
  traceId: "trace-included",
  rayId: "ray-included",
  category: "normal",
  disposition: "included",
  sampleWeight: 1,
};

const demoData = {
  ok: true,
  configured: true,
  generatedAt: 1_790_193_600_000,
  sampling: { provider: "demo", mode: "automatic" },
  window: { minutes: 60, from: 1_790_190_000_000, to: 1_790_193_600_000 },
  summary: { total: 13 },
  mapPoints: [],
  trend: [],
  reasons: [],
  countries: [],
  asns: [],
  events,
  normalEvents: [],
  blockedEvents: events,
  includedEvents: [includedEvent],
  blocked: { summary: { total: 12 }, events, mapPoints: [] },
  included: { summary: { total: 1 }, events: [includedEvent], mapPoints: [] },
};

beforeEach(() => {
  generateData.mockReturnValue(demoData);
});

describe("demo request observation response handler", () => {
  it("caps requested windows and serializes detail, source lists, and combined events", () => {
    const invalidWindow = demoRequestObservationResponse({
      from: "bad",
      to: "0",
    }) as Record<string, any>;
    expect(generateData).toHaveBeenLastCalledWith(60, undefined);
    expect(invalidWindow.events[0]).not.toHaveProperty("sampleWeight");
    expect(invalidWindow.blocked.events).toHaveLength(6);
    expect(invalidWindow.included.events).toHaveLength(1);
    expect(
      invalidWindow.normalEvents.map((event: any) => event.category),
    ).toEqual(["normal"]);

    demoRequestObservationResponse({ from: 0, to: 61 * 60_000 });
    expect(generateData).toHaveBeenLastCalledWith(1440, 61 * 60_000);
    demoRequestObservationResponse({ from: 0, to: 7 * 24 * 60 * 60_000 });
    expect(generateData).toHaveBeenLastCalledWith(10080, 7 * 24 * 60 * 60_000);
    demoRequestObservationResponse({ from: 0, to: 31 * 24 * 60 * 60_000 });
    expect(generateData).toHaveBeenLastCalledWith(43200, 31 * 24 * 60 * 60_000);

    const missing = demoRequestObservationResponse({
      detail: "1",
      traceId: "missing",
    }) as Record<string, any>;
    expect(missing.detail).toBeNull();
    const detail = demoRequestObservationResponse({
      detail: "1",
      traceId: "trace-1",
    }) as Record<string, any>;
    expect(detail.detail).toMatchObject({ traceId: "trace-1" });
    expect(detail.detail).not.toHaveProperty("sampleWeight");
    const detailByRay = demoRequestObservationResponse({
      detail: "1",
      rayId: "ray-included",
    }) as Record<string, any>;
    expect(detailByRay.detail.disposition).toBe("included");

    const blocked = demoRequestObservationResponse({
      source: "abnormal",
      limit: "0",
    }) as Record<string, any>;
    expect(blocked.source).toBe("blocked");
    expect(blocked.data.pagination.limit).toBe(1);
    expect(blocked.data.items[0]).toHaveProperty("reasons");
    expect(blocked.data.items[0]).not.toHaveProperty("hostname");
    const included = demoRequestObservationResponse({
      source: "normal",
      limit: "999",
    }) as Record<string, any>;
    expect(included.source).toBe("included");
    expect(included.data.pagination.limit).toBe(100);
    expect(included.data.items[0]).toHaveProperty("hostname");
    expect(included.data.items[0]).not.toHaveProperty("ip");
  });

  it("groups supported dimensions with source aliases, weighted counts, and unknown fallbacks", () => {
    const dimensions: Array<[string, string]> = [
      ["detection", "reason"],
      ["detection", "category"],
      ["detection", "kind"],
      ["detection", "botScoreBucket"],
      ["detection", "verifiedBotCategory"],
      ["target", "site"],
      ["target", "hostname"],
      ["target", "pathname"],
      ["target", "origin"],
      ["network", "asOrganization"],
      ["network", "asn"],
      ["network", "country"],
      ["network", "region"],
      ["network", "city"],
      ["network", "colo"],
      ["client", "ip"],
      ["client", "userAgent"],
      ["client", "userAgentLengthBucket"],
      ["client", "ipPrefix"],
      ["other", "customField"],
    ];
    for (const [dimensionGroup, dimensionTab] of dimensions) {
      const result = demoRequestObservationResponse({
        dimensionGroup,
        dimensionTab,
      }) as Record<string, any>;
      expect(result.dimension).toMatchObject({
        group: dimensionGroup,
        tab: dimensionTab,
        source: "blocked",
      });
      expect(result.dimension.rows.length).toBeGreaterThan(0);
    }

    const included = demoRequestObservationResponse({
      dimensionGroup: "target",
      dimensionTab: "site",
      dimensionSource: "normal",
    }) as Record<string, any>;
    expect(included.dimension.source).toBe("included");
    expect(included.dimension.rows[0].count).toBe(1);
    const explicitIncluded = demoRequestObservationResponse({
      dimensionGroup: "client",
      dimensionTab: "ip",
      dimensionSource: "included",
    }) as Record<string, any>;
    expect(explicitIncluded.dimension.source).toBe("included");
    const unknownSource = demoRequestObservationResponse({
      dimensionGroup: "client",
      dimensionTab: "ip",
      dimensionSource: "unexpected",
    }) as Record<string, any>;
    expect(unknownSource.dimension.source).toBe("blocked");
  });
});
