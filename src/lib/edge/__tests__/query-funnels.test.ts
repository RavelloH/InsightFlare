import { afterEach, describe, expect, it, vi } from "vitest";

import {
  analyzeFunnelEvents,
  handleFunnel,
  normalizeFunnelSteps,
} from "@/lib/edge/query/funnels";
import type { Env } from "@/lib/edge/types";

interface PreparedCall {
  bindings: unknown[];
  method: "all" | "run";
  sql: string;
}

function createEnv(
  selectResults: (
    sql: string,
    bindings: unknown[],
  ) => Record<string, unknown>[] = () => [],
) {
  const calls: PreparedCall[] = [];
  const env = {
    DB: {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn((...bindings: unknown[]) => ({
          all: vi.fn(async () => {
            calls.push({ sql, bindings, method: "all" });
            return { results: selectResults(sql, bindings) };
          }),
          run: vi.fn(async () => {
            calls.push({ sql, bindings, method: "run" });
            return { success: true };
          }),
        })),
      })),
    },
  } as unknown as Env;

  return { calls, env };
}

function makeRequest(
  path: string,
  init?: RequestInit,
): { request: Request; url: URL } {
  const request = new Request(`https://edge.test${path}`, init);
  return { request, url: new URL(request.url) };
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("funnel query handler", () => {
  it("lists funnel definitions from the unified resource endpoint", async () => {
    const steps = [
      { type: "pageview", value: "/pricing" },
      { type: "event", value: "signup_started" },
    ];
    const legacySteps = [
      { type: "pageview", value: "/docs" },
      { type: "pageview", value: "/docs/install" },
    ];
    const { calls, env } = createEnv((sql) =>
      sql.includes("analysis_definitions")
        ? [
            {
              id: "funnel-1",
              site_id: "site-1",
              kind: "funnel",
              name: "Signup",
              config_json: JSON.stringify({ steps }),
              created_at: 10,
              updated_at: 20,
            },
            {
              id: "funnel-legacy",
              site_id: "site-1",
              kind: "funnel",
              name: "Docs",
              config_json: JSON.stringify(legacySteps),
              created_at: 30,
              updated_at: 40,
            },
          ]
        : [],
    );
    const { request, url } = makeRequest("/api/private/funnel");

    const response = await handleFunnel(env, "site-1", url, undefined, request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: {
        funnels: [
          {
            id: "funnel-1",
            siteId: "site-1",
            name: "Signup",
            steps,
            createdAt: 10,
            updatedAt: 20,
          },
          {
            id: "funnel-legacy",
            siteId: "site-1",
            name: "Docs",
            steps: legacySteps,
            createdAt: 30,
            updatedAt: 40,
          },
        ],
      },
    });
    expect(calls[0]?.sql).toContain("FROM analysis_definitions");
    expect(calls[0]?.sql).not.toContain("widgets");
    expect(calls[0]?.bindings).toEqual(["site-1", "funnel"]);
  });

  it("creates funnel definitions with normalized step input", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T00:00:00Z"));
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(
      "00000000-0000-4000-8000-000000000001",
    );
    const steps = [
      { type: "pageview", value: " /pricing " },
      { type: "unknown", value: "/ignored" },
      { type: "event", value: "signup_started" },
    ];
    const normalizedSteps = [
      { type: "pageview", value: "/pricing" },
      { type: "event", value: "signup_started" },
    ];
    const { calls, env } = createEnv();
    const { request, url } = makeRequest("/api/private/funnel", {
      body: JSON.stringify({ name: " Signup ", steps }),
      method: "POST",
    });

    const response = await handleFunnel(env, "site-1", url, undefined, request);

    const now = nowSeconds();
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: {
        funnel: {
          id: "00000000-0000-4000-8000-000000000001",
          siteId: "site-1",
          name: "Signup",
          steps: normalizedSteps,
          createdAt: now,
          updatedAt: now,
        },
      },
    });
    expect(calls[0]?.sql).toContain("INSERT INTO analysis_definitions");
    expect(calls[0]?.sql).not.toContain("widgets");
    expect(calls[0]?.bindings).toEqual([
      "00000000-0000-4000-8000-000000000001",
      "site-1",
      "funnel",
      "Signup",
      JSON.stringify({ steps: normalizedSteps }),
      now,
      now,
    ]);
  });

  it("archives funnel definitions through DELETE", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T00:00:00Z"));
    const { calls, env } = createEnv();
    const { request, url } = makeRequest("/api/private/funnel?id=funnel-1", {
      method: "DELETE",
    });

    const response = await handleFunnel(env, "site-1", url, undefined, request);

    const now = nowSeconds();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(calls[0]?.sql).toContain("UPDATE analysis_definitions");
    expect(calls[0]?.sql).not.toContain("widgets");
    expect(calls[0]?.bindings).toEqual([
      now,
      now,
      "funnel-1",
      "site-1",
      "funnel",
    ]);
  });

  it("loads a funnel detail and applies visit filters to pageview and event queries", async () => {
    const steps = [
      { type: "pageview", value: "/pricing" },
      { type: "event", value: "signup_started" },
    ];
    const { calls, env } = createEnv((sql) => {
      if (sql.includes("analysis_definitions")) {
        return [
          {
            id: "funnel-1",
            site_id: "site-1",
            name: "Signup",
            config_json: JSON.stringify({ steps }),
            created_at: 10,
            updated_at: 20,
          },
        ];
      }
      if (sql.includes("FROM visit_source vs")) {
        return [
          {
            sessionId: "session-1",
            visitorId: "visitor-1",
            value: "/pricing",
            timestampMs: 100,
            sourceId: "visit-1",
          },
        ];
      }
      if (sql.includes("FROM event_source es")) {
        return [
          {
            sessionId: "session-1",
            visitorId: "visitor-1",
            value: "signup_started",
            timestampMs: 100,
            sequence: 1,
            sourceId: "event-1",
          },
        ];
      }
      return [];
    });
    const { request, url } = makeRequest(
      "/api/private/funnel?id=funnel-1&from=1&to=1000&filter[client.deviceType]=desktop",
    );

    const response = await handleFunnel(env, "site-1", url, undefined, request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: {
        funnel: {
          id: "funnel-1",
          siteId: "site-1",
          name: "Signup",
          steps,
          createdAt: 10,
          updatedAt: 20,
        },
        analysis: {
          steps: [
            {
              index: 0,
              label: "/pricing",
              type: "pageview",
              sessions: 1,
              visitors: 1,
              conversionRate: 1,
              stepConversionRate: 1,
              dropOffSessions: 0,
              dropOffRate: 0,
            },
            {
              index: 1,
              label: "signup_started",
              type: "event",
              sessions: 1,
              visitors: 1,
              conversionRate: 1,
              stepConversionRate: 1,
              dropOffSessions: 0,
              dropOffRate: 0,
            },
          ],
          summary: {
            totalSessions: 1,
            convertedSessions: 1,
            totalVisitors: 1,
            convertedVisitors: 1,
            overallConversionRate: 1,
            largestDropOffStepIndex: null,
          },
        },
      },
    });

    const pageviewCall = calls.find((call) =>
      call.sql.includes("FROM visit_source vs"),
    );
    const eventCall = calls.find((call) =>
      call.sql.includes("FROM event_source es"),
    );
    expect(pageviewCall?.sql).toContain("vs.device_type");
    expect(eventCall?.sql).toContain("es.device_type");
    expect(pageviewCall?.bindings).toContain("desktop");
    expect(eventCall?.bindings).toContain("desktop");
  });

  it("returns zero drop-off for empty analysis instead of treating missing prior steps as 100 percent loss", async () => {
    const steps = [
      { type: "pageview" as const, value: "/pricing" },
      { type: "event" as const, value: "signup_started" },
    ];

    expect(analyzeFunnelEvents(steps, [])).toEqual({
      steps: [
        {
          index: 0,
          label: "/pricing",
          type: "pageview",
          sessions: 0,
          visitors: 0,
          conversionRate: 0,
          stepConversionRate: 0,
          dropOffSessions: 0,
          dropOffRate: 0,
        },
        {
          index: 1,
          label: "signup_started",
          type: "event",
          sessions: 0,
          visitors: 0,
          conversionRate: 0,
          stepConversionRate: 0,
          dropOffSessions: 0,
          dropOffRate: 0,
        },
      ],
      summary: {
        totalSessions: 0,
        convertedSessions: 0,
        totalVisitors: 0,
        convertedVisitors: 0,
        overallConversionRate: 0,
        largestDropOffStepIndex: null,
      },
    });
  });

  it("matches same-timestamp pageviews before custom events with stable event ordering", () => {
    const steps = [
      { type: "pageview" as const, value: "/pricing" },
      { type: "event" as const, value: "signup_started" },
      { type: "event" as const, value: "signup_finished" },
    ];

    expect(
      analyzeFunnelEvents(steps, [
        {
          sessionId: "session-1",
          visitorId: "visitor-1",
          type: "event",
          value: "signup_finished",
          timestampMs: 100,
          sourceOrder: 1,
          sourceId: "event-2",
        },
        {
          sessionId: "session-1",
          visitorId: "visitor-1",
          type: "pageview",
          value: "/pricing",
          timestampMs: 100,
          sourceOrder: 0,
          sourceId: "visit-1",
        },
        {
          sessionId: "session-1",
          visitorId: "visitor-1",
          type: "event",
          value: "signup_started",
          timestampMs: 100,
          sourceOrder: 1,
          sourceId: "event-1",
        },
      ]).summary,
    ).toMatchObject({
      totalSessions: 1,
      convertedSessions: 1,
      overallConversionRate: 1,
    });
  });

  it("limits normalized funnel steps", () => {
    const steps = Array.from({ length: 20 }, (_, index) => ({
      type: "pageview",
      value: `/step-${index}`,
    }));

    expect(normalizeFunnelSteps(steps)).toHaveLength(12);
  });
});
