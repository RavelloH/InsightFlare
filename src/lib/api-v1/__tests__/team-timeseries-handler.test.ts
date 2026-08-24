import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { createTestProviderRegistry } from "@/lib/api-v1/__tests__/provider-registry";
import {
  handlePlannedTeamTimeseries,
  type TeamTimeseriesReader,
} from "@/lib/api-v1/team-timeseries-handler";
import {
  AnalyticsTimeseriesResponseSchema,
  ApiV1ErrorEnvelopeSchema,
} from "@/lib/api-v1/wire";
import type { ApiKeyPrincipal } from "@/lib/edge/api-key-auth";

const principal: ApiKeyPrincipal = {
  keyId: "key-1",
  teamId: "team-1",
  prefix: "prefix",
  scopes: ["analytics:read"],
  siteIds: ["site-1"],
  status: "active",
};
const input = {
  timeRange: {
    kind: "absolute",
    from: "2026-08-01T00:00:00.000Z",
    to: "2026-08-02T00:00:00.000Z",
    timeZone: "UTC",
  },
  interval: "hour" as const,
};

function reader() {
  return vi.fn<TeamTimeseriesReader>().mockResolvedValue({
    source: "raw",
    approximateVisitors: false,
    data: {
      interval: "hour",
      points: [
        {
          bucket: 0,
          timestampMs: Date.parse("2026-08-01T00:00:00.000Z") as never,
          views: 10,
          sessions: 4,
          visitors: 3,
          bounces: 1,
          totalDurationMs: 1200,
          durationViews: 10,
        },
      ],
    },
  });
}

function request(
  body: BodyInit | null = JSON.stringify(input),
  init: RequestInit = {},
) {
  const method = init.method ?? "POST";
  return new Request("https://app.test/api/v1/team/analytics/timeseries", {
    ...init,
    method,
    headers: { "Content-Type": "application/json", ...init.headers },
    ...(method === "GET" || method === "HEAD" ? {} : { body }),
  });
}

describe("planned team timeseries HTTP adapter", () => {
  it("serves a typed Hono response with team-derived scope", async () => {
    const provider = reader();
    const app = new Hono();
    app.post("/api/v1/team/analytics/timeseries", (c) =>
      handlePlannedTeamTimeseries(
        c.req.raw,
        principal,
        createTestProviderRegistry(provider),
      ),
    );
    const response = await app.fetch(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(AnalyticsTimeseriesResponseSchema.safeParse(body).success).toBe(
      true,
    );
    expect(body).toMatchObject({
      data: {
        interval: "hour",
        points: [{ sessions: 4, avgDurationMs: 300, bounceRate: 0.25 }],
      },
      meta: { source: "raw", accuracy: "exact" },
    });
    expect(provider).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: "team-1",
        allowedSiteIds: ["site-1"],
        interval: "hour",
      }),
    );
  });

  it("rejects protocol, scope, time, cancellation, and deadline failures before provider access", async () => {
    const provider = reader();
    const cancelled = new AbortController();
    cancelled.abort();
    for (const candidate of [
      request(null),
      request(JSON.stringify({ ...input, interval: "bad" })),
      request(
        JSON.stringify({
          ...input,
          timeRange: { ...input.timeRange, timeZone: "Nope/Nowhere" },
        }),
      ),
      request(
        JSON.stringify({
          ...input,
          filter: {
            type: "inline",
            expression: {
              kind: "condition",
              target: { kind: "field", field: "page.path" },
              operator: "not-a-real-operator",
              value: "/pricing",
            },
          },
        }),
      ),
      request(JSON.stringify(input), {
        headers: { "Content-Type": "text/plain" },
      }),
      request(JSON.stringify(input), { headers: { Accept: "text/plain" } }),
      request(JSON.stringify(input), { method: "GET" }),
    ]) {
      const response = await handlePlannedTeamTimeseries(
        candidate,
        principal,
        createTestProviderRegistry(provider),
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(
        ApiV1ErrorEnvelopeSchema.safeParse(await response.json()).success,
      ).toBe(true);
    }
    expect(
      (
        await handlePlannedTeamTimeseries(
          request(),
          { ...principal, scopes: [] },
          createTestProviderRegistry(provider),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handlePlannedTeamTimeseries(
          request(),
          { ...principal, status: "revoked" },
          createTestProviderRegistry(provider),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handlePlannedTeamTimeseries(
          request(),
          principal,
          createTestProviderRegistry(provider),
          {
            signal: cancelled.signal,
          },
        )
      ).status,
    ).toBe(499);
    expect(
      (
        await handlePlannedTeamTimeseries(
          request(),
          principal,
          createTestProviderRegistry(provider),
          {
            deadlineMs: 1,
            now: () => 1,
          },
        )
      ).status,
    ).toBe(504);
    expect(provider).not.toHaveBeenCalled();
  });

  it("preserves post-provider deadline, approximate, zero-denominator, and failure semantics", async () => {
    const approximate = reader();
    approximate.mockResolvedValueOnce({
      source: "mixed",
      approximateVisitors: true,
      data: {
        interval: "hour",
        points: [
          {
            bucket: 0,
            timestampMs: 0 as never,
            views: 0,
            sessions: 0,
            visitors: 0,
            bounces: 0,
            totalDurationMs: 0,
            durationViews: 0,
          },
        ],
      },
    });
    const success = await handlePlannedTeamTimeseries(
      request(),
      principal,
      createTestProviderRegistry(approximate),
    );
    await expect(success.json()).resolves.toMatchObject({
      data: { points: [{ avgDurationMs: 0, bounceRate: 0 }] },
      meta: { source: "mixed", accuracy: "approximate" },
    });

    let calls = 0;
    const deadline = await handlePlannedTeamTimeseries(
      request(),
      principal,
      createTestProviderRegistry(reader()),
      { deadlineMs: 1, now: () => calls++ },
    );
    expect(deadline.status).toBe(504);

    const failed = await handlePlannedTeamTimeseries(
      request(),
      principal,
      createTestProviderRegistry(
        vi
          .fn<TeamTimeseriesReader>()
          .mockRejectedValue(new Error("provider down")),
      ),
    );
    expect(failed.status).toBe(500);
  });

  it("defaults the reporting time zone and returns cancellation after provider work", async () => {
    const controller = new AbortController();
    const provider = reader();
    provider.mockImplementationOnce(async () => {
      controller.abort();
      return {
        source: "raw",
        approximateVisitors: false,
        data: { interval: "hour", points: [] },
      };
    });
    const response = await handlePlannedTeamTimeseries(
      request(
        JSON.stringify({
          timeRange: {
            kind: "absolute",
            from: "2026-08-01T00:00:00.000Z",
            to: "2026-08-02T00:00:00.000Z",
          },
          interval: "hour",
        }),
      ),
      { ...principal, siteIds: [] },
      createTestProviderRegistry(provider),
      { signal: controller.signal },
    );
    expect(response.status).toBe(499);
  });

  it("exposes the remaining transport, scope, budget, and wildcard semantics", async () => {
    const provider = reader();
    const method = await handlePlannedTeamTimeseries(
      request(JSON.stringify(input), { method: "GET" }),
      principal,
      createTestProviderRegistry(provider),
    );
    expect(method.headers.get("Allow")).toBe("POST");
    expect(
      (
        await handlePlannedTeamTimeseries(
          request(JSON.stringify(input), {
            headers: { "content-encoding": "gzip" },
          }),
          principal,
          createTestProviderRegistry(provider),
        )
      ).status,
    ).toBe(415);
    expect(
      (
        await handlePlannedTeamTimeseries(
          request(),
          { ...principal, status: "revoked" },
          createTestProviderRegistry(provider),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handlePlannedTeamTimeseries(
          request(
            JSON.stringify({
              timeRange: {
                kind: "absolute",
                from: "1970-01-01T00:00:00.000Z",
                to: "9999-01-01T00:00:00.000Z",
                timeZone: "UTC",
              },
              interval: "day",
            }),
          ),
          principal,
          createTestProviderRegistry(provider),
        )
      ).status,
    ).toBe(422);
    for (const accept of ["application/*", "*/*"]) {
      const response = await handlePlannedTeamTimeseries(
        request(JSON.stringify(input), { headers: { accept } }),
        { ...principal, siteIds: [] },
        createTestProviderRegistry(reader()),
      );
      expect(response.status).toBe(200);
    }
  });
});
