import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import {
  handlePlannedTeamOverview,
  type TeamOverviewReader,
} from "@/lib/api-v1/team-overview-handler";
import {
  AnalyticsOverviewResponseSchema,
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
  filter: {
    type: "inline" as const,
    expression: {
      kind: "condition" as const,
      target: { kind: "field" as const, field: "page.path" },
      operator: "eq",
      value: "/pricing",
    },
  },
};

function reader() {
  return vi.fn<TeamOverviewReader>().mockResolvedValue({
    source: "raw",
    approximateVisitors: false,
    data: {
      views: 10,
      sessions: 4,
      visitors: 3,
      bounces: 1,
      totalDurationMs: 1200,
      durationViews: 10,
    },
  });
}

function request(
  body: BodyInit | null = JSON.stringify(input),
  init: RequestInit = {},
) {
  const method = init.method ?? "POST";
  return new Request("https://app.test/api/v1/team/analytics/overview", {
    ...init,
    method,
    headers: { "Content-Type": "application/json", ...init.headers },
    ...(method === "GET" || method === "HEAD" ? {} : { body }),
  });
}

describe("planned team overview HTTP adapter", () => {
  it("serves the typed envelope through a live Hono route", async () => {
    const provider = reader();
    const app = new Hono();
    app.post("/api/v1/team/analytics/overview", (c) =>
      handlePlannedTeamOverview(c.req.raw, principal, provider),
    );
    const response = await app.fetch(request());
    const body = (await response.json()) as {
      readonly data: Record<string, unknown>;
      readonly meta: { readonly requestId: string } & Record<string, unknown>;
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(body).toMatchObject({
      data: { views: 10, sessions: 4, avgDurationMs: 300, bounceRate: 0.25 },
      meta: { source: "raw", accuracy: "exact" },
    });
    expect(body.meta.requestId).toBe(response.headers.get("X-Request-Id"));
    expect(AnalyticsOverviewResponseSchema.safeParse(body).success).toBe(true);
    expect(provider).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: "team-1",
        allowedSiteIds: ["site-1"],
        filters: expect.objectContaining({ version: 1 }),
      }),
    );
  });

  it("rejects invalid protocol, policy, and time inputs before provider access", async () => {
    const provider = reader();
    for (const invalid of [
      request(null),
      request(
        JSON.stringify({
          ...input,
          timeRange: { ...input.timeRange, to: input.timeRange.from },
        }),
      ),
      request(
        JSON.stringify({
          ...input,
          timeRange: { ...input.timeRange, timeZone: "Nope/Nowhere" },
        }),
      ),
      request(JSON.stringify(input), {
        headers: { "Content-Type": "text/plain" },
      }),
      request(JSON.stringify(input), { headers: { Accept: "text/plain" } }),
      request(JSON.stringify(input), { method: "GET" }),
    ]) {
      const response = await handlePlannedTeamOverview(
        invalid,
        principal,
        provider,
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(
        ApiV1ErrorEnvelopeSchema.safeParse(await response.json()).success,
      ).toBe(true);
    }
    const denied = await handlePlannedTeamOverview(
      request(),
      { ...principal, scopes: [] },
      provider,
    );
    expect(denied.status).toBe(403);
    expect(provider).not.toHaveBeenCalled();
  });

  it("preserves cancellation and deadline semantics and protects zero denominators", async () => {
    const provider = reader();
    const cancelled = new AbortController();
    cancelled.abort();
    expect(
      (
        await handlePlannedTeamOverview(request(), principal, provider, {
          signal: cancelled.signal,
        })
      ).status,
    ).toBe(499);
    expect(
      (
        await handlePlannedTeamOverview(request(), principal, provider, {
          deadlineMs: 1,
          now: () => 1,
        })
      ).status,
    ).toBe(504);

    const zero = reader();
    zero.mockResolvedValueOnce({
      source: "raw",
      approximateVisitors: false,
      data: {
        views: 0,
        sessions: 0,
        visitors: 0,
        bounces: 0,
        totalDurationMs: 0,
        durationViews: 0,
      },
    });
    const response = await handlePlannedTeamOverview(
      request(
        JSON.stringify({
          timeRange: {
            kind: "absolute",
            from: "2026-08-01T00:00:00.000Z",
            to: "2026-08-02T00:00:00.000Z",
          },
        }),
      ),
      { ...principal, siteIds: [] },
      zero,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { avgDurationMs: 0, bounceRate: 0 },
    });
  });

  it("uses approximate metadata and returns a stable provider failure", async () => {
    const approximate = reader();
    approximate.mockResolvedValueOnce({
      source: "mixed",
      approximateVisitors: true,
      data: {
        views: 1,
        sessions: 1,
        visitors: 1,
        bounces: 0,
        totalDurationMs: 10,
        durationViews: 1,
      },
    });
    const success = await handlePlannedTeamOverview(
      request(JSON.stringify({ timeRange: input.timeRange })),
      { ...principal, siteIds: [] },
      approximate,
    );
    await expect(success.json()).resolves.toMatchObject({
      data: { approximateVisitors: true },
      meta: { source: "mixed", accuracy: "approximate" },
    });

    const failed = await handlePlannedTeamOverview(
      request(),
      principal,
      vi.fn<TeamOverviewReader>().mockRejectedValue(new Error("provider down")),
    );
    expect(failed.status).toBe(500);
  });

  it("checks the deadline again after the provider finishes", async () => {
    const provider = reader();
    let calls = 0;
    const response = await handlePlannedTeamOverview(
      request(),
      principal,
      provider,
      {
        deadlineMs: 1,
        now: () => calls++,
      },
    );
    expect(response.status).toBe(504);
    expect(provider).toHaveBeenCalledOnce();
  });

  it("enforces method, encoding, key status, cost, and post-provider cancellation", async () => {
    const provider = reader();
    const method = await handlePlannedTeamOverview(
      request(JSON.stringify(input), { method: "GET" }),
      principal,
      provider,
    );
    expect(method.status).toBe(405);
    expect(method.headers.get("Allow")).toBe("POST");
    expect(
      (
        await handlePlannedTeamOverview(
          request(JSON.stringify(input), {
            headers: { "content-encoding": "gzip" },
          }),
          principal,
          provider,
        )
      ).status,
    ).toBe(415);
    expect(
      (
        await handlePlannedTeamOverview(
          request(),
          { ...principal, status: "revoked" },
          provider,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handlePlannedTeamOverview(
          request(
            JSON.stringify({
              timeRange: {
                kind: "absolute",
                from: "1970-01-01T00:00:00.000Z",
                to: "9999-01-01T00:00:00.000Z",
                timeZone: "UTC",
              },
            }),
          ),
          principal,
          provider,
        )
      ).status,
    ).toBe(422);

    const controller = new AbortController();
    const aborting: TeamOverviewReader = async () => {
      controller.abort();
      return {
        source: "raw",
        approximateVisitors: false,
        data: {
          views: 0,
          sessions: 0,
          visitors: 0,
          bounces: 0,
          totalDurationMs: 0,
          durationViews: 0,
        },
      };
    };
    expect(
      (
        await handlePlannedTeamOverview(request(), principal, aborting, {
          signal: controller.signal,
        })
      ).status,
    ).toBe(499);
  });
});
