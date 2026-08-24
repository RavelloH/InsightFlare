import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  FunnelEvent,
  FunnelStepConfig,
} from "@/lib/edge/analytics/providers/d1/internal/funnels";
import {
  analyzeFunnelEvents,
  handleFunnel,
  normalizeFunnelSteps,
} from "@/lib/edge/analytics/providers/d1/internal/funnels";
import type { Env } from "@/lib/edge/types";

vi.mock("@/lib/edge/analytics/providers/d1/internal/core", () => ({
  badRequest: vi.fn(
    (msg: string) =>
      new Response(JSON.stringify({ ok: false, error: msg }), { status: 400 }),
  ),
  notAllowed: vi.fn(
    () =>
      new Response(JSON.stringify({ ok: false, error: "not allowed" }), {
        status: 405,
      }),
  ),
  notFound: vi.fn(
    () =>
      new Response(JSON.stringify({ ok: false, error: "not found" }), {
        status: 404,
      }),
  ),
  jsonResponseWith: vi.fn(
    (_ctx: unknown, data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status }),
  ),
  parseWindow: vi.fn(),
  parseFilters: vi.fn(() => ({ clause: "", bindings: [] })),
  queryD1All: vi.fn(),
  buildVisitSourceCte: vi.fn(() => "visit_source AS (...)"),
  buildVisitFilterSql: vi.fn(() => ({ clause: "", bindings: [] })),
  buildEventFilterSql: vi.fn(() => ({ clause: "", bindings: [] })),
  buildEventAnalyticsSourceCte: vi.fn(() => "event_source AS (...)"),
  visitSourceBindings: vi.fn(() => []),
  eventSourceBindings: vi.fn(() => []),
}));

vi.mock("@/lib/edge/analytics/providers/d1/internal/core-time", () => ({
  buildTimeBuckets: vi.fn(),
  timeBucketTimestamp: vi.fn(),
}));

import {
  parseWindow,
  queryD1All,
} from "@/lib/edge/analytics/providers/d1/internal/core";

const queryD1AllMock = vi.mocked(queryD1All);
const parseWindowMock = vi.mocked(parseWindow);

function makeEnv(): Env {
  return {
    DB: {
      prepare: vi.fn().mockReturnThis(),
      bind: vi.fn().mockReturnThis(),
      first: vi.fn(),
      all: vi.fn(),
      run: vi.fn(),
      batch: vi.fn(),
    },
  } as unknown as Env;
}

function makeUrl(path: string, params?: Record<string, string>): URL {
  const url = new URL(`https://app.test${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }
  return url;
}

describe("normalizeFunnelSteps", () => {
  it("returns empty array for non-array input", () => {
    expect(normalizeFunnelSteps(null)).toEqual([]);
    expect(normalizeFunnelSteps(undefined)).toEqual([]);
    expect(normalizeFunnelSteps("string")).toEqual([]);
    expect(normalizeFunnelSteps(123)).toEqual([]);
  });

  it("skips non-object items", () => {
    expect(
      normalizeFunnelSteps([
        null,
        123,
        "str",
        { type: "pageview", value: "/home" },
      ]),
    ).toEqual([{ type: "pageview", value: "/home" }]);
  });

  it("skips items with invalid type", () => {
    expect(
      normalizeFunnelSteps([
        { type: "invalid", value: "/home" },
        { type: "pageview", value: "/about" },
      ]),
    ).toEqual([{ type: "pageview", value: "/about" }]);
  });

  it("skips items with empty value", () => {
    expect(
      normalizeFunnelSteps([
        { type: "pageview", value: "" },
        { type: "pageview", value: "  " },
        { type: "event", value: "click" },
      ]),
    ).toEqual([{ type: "event", value: "click" }]);
  });

  it("trims whitespace from value", () => {
    expect(
      normalizeFunnelSteps([{ type: "pageview", value: "  /home  " }]),
    ).toEqual([{ type: "pageview", value: "/home" }]);
  });

  it("caps at MAX_FUNNEL_STEPS (12)", () => {
    const steps = Array.from({ length: 15 }, (_, i) => ({
      type: "pageview" as const,
      value: `/page-${i}`,
    }));
    expect(normalizeFunnelSteps(steps)).toHaveLength(12);
  });

  it("handles value as number via String()", () => {
    expect(normalizeFunnelSteps([{ type: "event", value: 42 }])).toEqual([
      { type: "event", value: "42" },
    ]);
  });
});

describe("analyzeFunnelEvents", () => {
  const steps: FunnelStepConfig[] = [
    { type: "pageview", value: "/landing" },
    { type: "pageview", value: "/pricing" },
    { type: "event", value: "signup" },
  ];

  it("returns zeroed analysis for empty events", () => {
    const result = analyzeFunnelEvents(steps, []);
    expect(result.summary.totalSessions).toBe(0);
    expect(result.steps).toHaveLength(3);
    expect(result.steps[0].sessions).toBe(0);
    expect(result.steps[0].conversionRate).toBe(0);
  });

  it("handles single-step funnel", () => {
    const singleStep: FunnelStepConfig[] = [
      { type: "pageview", value: "/home" },
    ];
    const events: FunnelEvent[] = [
      {
        sessionId: "s1",
        visitorId: "v1",
        type: "pageview",
        value: "/home",
        timestampMs: 100,
        sourceOrder: 0,
        sourceId: "a",
      },
    ];
    const result = analyzeFunnelEvents(singleStep, events);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].sessions).toBe(1);
    expect(result.steps[0].conversionRate).toBe(1);
    expect(result.summary.overallConversionRate).toBe(1);
  });

  it("computes drop-off correctly", () => {
    const events: FunnelEvent[] = [
      {
        sessionId: "s1",
        visitorId: "v1",
        type: "pageview",
        value: "/landing",
        timestampMs: 100,
        sourceOrder: 0,
        sourceId: "a",
      },
      {
        sessionId: "s1",
        visitorId: "v1",
        type: "pageview",
        value: "/pricing",
        timestampMs: 200,
        sourceOrder: 0,
        sourceId: "b",
      },
      {
        sessionId: "s2",
        visitorId: "v2",
        type: "pageview",
        value: "/landing",
        timestampMs: 100,
        sourceOrder: 0,
        sourceId: "c",
      },
    ];
    const result = analyzeFunnelEvents(
      [
        { type: "pageview", value: "/landing" },
        { type: "pageview", value: "/pricing" },
      ],
      events,
    );
    expect(result.steps[0].sessions).toBe(2);
    expect(result.steps[1].sessions).toBe(1);
    expect(result.steps[1].dropOffSessions).toBe(1);
    expect(result.steps[1].dropOffRate).toBe(0.5);
    expect(result.summary.largestDropOffStepIndex).toBe(1);
  });

  it("ignores events with empty sessionId", () => {
    const events: FunnelEvent[] = [
      {
        sessionId: "",
        visitorId: "v1",
        type: "pageview",
        value: "/landing",
        timestampMs: 100,
        sourceOrder: 0,
        sourceId: "a",
      },
    ];
    const result = analyzeFunnelEvents(
      [{ type: "pageview", value: "/landing" }],
      events,
    );
    expect(result.steps[0].sessions).toBe(0);
  });

  it("does not match steps when events are in reverse order", () => {
    const events: FunnelEvent[] = [
      {
        sessionId: "s1",
        visitorId: "v1",
        type: "pageview",
        value: "/pricing",
        timestampMs: 100,
        sourceOrder: 0,
        sourceId: "a",
      },
      {
        sessionId: "s1",
        visitorId: "v1",
        type: "pageview",
        value: "/landing",
        timestampMs: 200,
        sourceOrder: 0,
        sourceId: "b",
      },
    ];
    const result = analyzeFunnelEvents(
      [
        { type: "pageview", value: "/landing" },
        { type: "pageview", value: "/pricing" },
      ],
      events,
    );
    // /pricing appears first in sorted order, but /landing (step 0) is found at index 1
    // cursor advances to 2, so /pricing (step 1) at index 0 is not found
    expect(result.steps[0].sessions).toBe(1);
    expect(result.steps[1].sessions).toBe(0);
  });

  it("sets largestDropOffStepIndex to null when no drop-off", () => {
    const events: FunnelEvent[] = [
      {
        sessionId: "s1",
        visitorId: "v1",
        type: "pageview",
        value: "/a",
        timestampMs: 100,
        sourceOrder: 0,
        sourceId: "a",
      },
      {
        sessionId: "s1",
        visitorId: "v1",
        type: "pageview",
        value: "/b",
        timestampMs: 200,
        sourceOrder: 0,
        sourceId: "b",
      },
    ];
    const result = analyzeFunnelEvents(
      [
        { type: "pageview", value: "/a" },
        { type: "pageview", value: "/b" },
      ],
      events,
    );
    expect(result.summary.largestDropOffStepIndex).toBeNull();
  });

  it("handles stepConversionRate when previousSessions is 0", () => {
    const events: FunnelEvent[] = [
      {
        sessionId: "s1",
        visitorId: "v1",
        type: "pageview",
        value: "/b",
        timestampMs: 200,
        sourceOrder: 0,
        sourceId: "b",
      },
    ];
    const result = analyzeFunnelEvents(
      [
        { type: "pageview", value: "/a" },
        { type: "pageview", value: "/b" },
      ],
      events,
    );
    expect(result.steps[0].sessions).toBe(0);
    expect(result.steps[1].sessions).toBe(0);
    expect(result.steps[1].stepConversionRate).toBe(0);
  });
});

describe("handleFunnel", () => {
  beforeEach(() => {
    queryD1AllMock.mockReset();
    parseWindowMock.mockReset();
  });

  it("returns notAllowed for unsupported methods", async () => {
    const env = makeEnv();
    const url = makeUrl("/api/private/funnels");
    const request = new Request("https://app.test/api/private/funnels", {
      method: "PUT",
    });

    const response = await handleFunnel(env, "site-1", url, undefined, request);
    expect(response.status).toBe(405);
  });

  it("returns badRequest for invalid JSON body on POST", async () => {
    const env = makeEnv();
    const url = makeUrl("/api/private/funnels");
    const request = new Request("https://app.test/api/private/funnels", {
      method: "POST",
      body: "not-json",
    });

    const response = await handleFunnel(env, "site-1", url, undefined, request);
    expect(response.status).toBe(400);
    const body = (await response.json()) as any;
    expect(body.error).toContain("Invalid JSON");
  });

  it("returns badRequest when name is missing on POST", async () => {
    const env = makeEnv();
    const url = makeUrl("/api/private/funnels");
    const request = new Request("https://app.test/api/private/funnels", {
      method: "POST",
      body: JSON.stringify({ steps: [{ type: "pageview", value: "/a" }] }),
    });

    const response = await handleFunnel(env, "site-1", url, undefined, request);
    expect(response.status).toBe(400);
    const body = (await response.json()) as any;
    expect(body.error).toContain("Name");
  });

  it("returns badRequest when fewer than 2 steps on POST", async () => {
    const env = makeEnv();
    const url = makeUrl("/api/private/funnels");
    const request = new Request("https://app.test/api/private/funnels", {
      method: "POST",
      body: JSON.stringify({
        name: "Test Funnel",
        steps: [{ type: "pageview", value: "/a" }],
      }),
    });

    const response = await handleFunnel(env, "site-1", url, undefined, request);
    expect(response.status).toBe(400);
    const body = (await response.json()) as any;
    expect(body.error).toContain("2 steps");
  });

  it("returns badRequest when DELETE has no funnelId", async () => {
    const env = makeEnv();
    const url = makeUrl("/api/private/funnels");
    const request = new Request("https://app.test/api/private/funnels", {
      method: "DELETE",
    });

    const response = await handleFunnel(env, "site-1", url, undefined, request);
    expect(response.status).toBe(400);
    const body = (await response.json()) as any;
    expect(body.error).toContain("id");
  });
});
