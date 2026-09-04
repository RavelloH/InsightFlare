import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { createTestProviderRegistry } from "@/lib/api-v1/__tests__/provider-registry";
import {
  handlePlannedTeamSites,
  type TeamSitesReader,
} from "@/lib/api-v1/team-sites-handler";
import {
  ApiV1ErrorEnvelopeSchema,
  TeamAnalyticsSitesResponseSchema,
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
  return vi.fn<TeamSitesReader>().mockResolvedValue({
    source: "raw",
    approximateVisitors: false,
    data: {
      sites: [
        {
          siteId: "site-1",
          name: "Example",
          domain: "example.test",
          publicEnabled: false,
          publicSlug: null,
          createdAt: 0,
          updatedAt: 1,
          metrics: {
            views: 10,
            sessions: 4,
            visitors: 3,
            bounces: 1,
            totalDurationMs: 1200,
            durationViews: 10,
          },
          trend: [
            {
              bucket: 0,
              timestampMs: 0 as never,
              views: 10,
              sessions: 4,
              visitors: 3,
              bounces: 1,
              totalDurationMs: 1200,
              durationViews: 10,
            },
          ],
          lastEventAtMs: 0,
        },
      ],
      pagination: {
        limit: 20,
        returned: 1,
        hasMore: false,
        nextCursor: null,
      },
    },
  });
}

function request(
  body: BodyInit | null = JSON.stringify(input),
  init: RequestInit = {},
) {
  const method = init.method ?? "POST";
  return new Request("https://app.test/api/v1/team/analytics/sites", {
    ...init,
    method,
    headers: { "Content-Type": "application/json", ...init.headers },
    ...(method === "GET" || method === "HEAD" ? {} : { body }),
  });
}

describe("planned team sites HTTP adapter", () => {
  it("returns an independent typed composite through a live Hono route", async () => {
    const provider = reader();
    const app = new Hono();
    app.post("/api/v1/team/analytics/sites", (context) =>
      handlePlannedTeamSites(
        context.req.raw,
        principal,
        createTestProviderRegistry(provider),
      ),
    );
    const response = await app.fetch(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(TeamAnalyticsSitesResponseSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      data: {
        sites: [
          {
            siteId: "site-1",
            metrics: { avgDurationMs: 300, bounceRate: 0.25 },
            trend: [{ avgDurationMs: 300, bounceRate: 0.25 }],
            lastEventAt: "1970-01-01T00:00:00.000Z",
          },
        ],
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

  it("rejects invalid protocol, principal, time, cancellation, and deadlines", async () => {
    const provider = reader();
    const cancelled = new AbortController();
    cancelled.abort();
    for (const candidate of [
      request(null),
      request(JSON.stringify({ ...input, unexpected: true })),
      request(
        JSON.stringify({
          ...input,
          timeRange: { ...input.timeRange, timeZone: "Nope/Nowhere" },
        }),
      ),
      request(JSON.stringify(input), { headers: { Accept: "text/plain" } }),
      request(JSON.stringify(input), {
        headers: { "Content-Type": "text/plain" },
      }),
      request(JSON.stringify(input), { method: "GET" }),
    ]) {
      const response = await handlePlannedTeamSites(
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
        await handlePlannedTeamSites(
          request(),
          { ...principal, scopes: [] },
          createTestProviderRegistry(provider),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handlePlannedTeamSites(
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
        await handlePlannedTeamSites(
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

  it("maps approximate, null activity, post-provider deadline, and failures", async () => {
    const approximate = reader();
    approximate.mockResolvedValueOnce({
      source: "mixed",
      approximateVisitors: true,
      data: {
        sites: [
          {
            siteId: "site-1",
            name: "Example",
            domain: "example.test",
            publicEnabled: false,
            publicSlug: null,
            createdAt: 0,
            updatedAt: 1,
            metrics: {
              views: 0,
              sessions: 0,
              visitors: 0,
              bounces: 0,
              totalDurationMs: 0,
              durationViews: 0,
            },
            lastEventAtMs: null,
          },
        ],
      },
    });
    const success = await handlePlannedTeamSites(
      request(),
      principal,
      createTestProviderRegistry(approximate),
    );
    await expect(success.json()).resolves.toMatchObject({
      data: {
        sites: [{ lastEventAt: null, metrics: { approximateVisitors: true } }],
      },
      meta: { source: "mixed", accuracy: "approximate" },
    });

    let calls = 0;
    const deadline = await handlePlannedTeamSites(
      request(),
      principal,
      createTestProviderRegistry(reader()),
      {
        deadlineMs: 1,
        now: () => calls++,
      },
    );
    expect(deadline.status).toBe(504);
    const failed = await handlePlannedTeamSites(
      request(),
      principal,
      createTestProviderRegistry(
        vi.fn<TeamSitesReader>().mockRejectedValue(new Error("provider down")),
      ),
    );
    expect(failed.status).toBe(500);
  });

  it("omits an unrequested trend, handles zero denominators, and observes post-provider cancellation", async () => {
    const zero = reader();
    zero.mockResolvedValueOnce({
      source: "raw",
      approximateVisitors: false,
      data: {
        sites: [
          {
            siteId: "site-1",
            name: "Example",
            domain: "example.test",
            publicEnabled: false,
            publicSlug: null,
            createdAt: 0,
            updatedAt: 0,
            metrics: {
              views: 0,
              sessions: 0,
              visitors: 0,
              bounces: 0,
              totalDurationMs: 0,
              durationViews: 0,
            },
            lastEventAtMs: 1,
          },
        ],
      },
    });
    const response = await handlePlannedTeamSites(
      request(JSON.stringify({ timeRange: input.timeRange })),
      { ...principal, siteIds: [] },
      createTestProviderRegistry(zero),
    );
    await expect(response.json()).resolves.toMatchObject({
      data: {
        sites: [
          {
            metrics: { avgDurationMs: 0, bounceRate: 0 },
            lastEventAt: "1970-01-01T00:00:00.001Z",
          },
        ],
      },
    });

    const controller = new AbortController();
    const cancelled = reader();
    cancelled.mockImplementationOnce(async () => {
      controller.abort();
      return { source: "raw", approximateVisitors: false, data: { sites: [] } };
    });
    expect(
      (
        await handlePlannedTeamSites(
          request(),
          principal,
          createTestProviderRegistry(cancelled),
          {
            signal: controller.signal,
          },
        )
      ).status,
    ).toBe(499);
    expect(
      (
        await handlePlannedTeamSites(
          request(),
          { ...principal, status: "revoked" },
          createTestProviderRegistry(reader()),
        )
      ).status,
    ).toBe(403);
  });

  it("honors method, content encoding, key status, and JSON wildcard negotiation", async () => {
    const provider = reader();
    const method = await handlePlannedTeamSites(
      request(JSON.stringify(input), { method: "GET" }),
      principal,
      createTestProviderRegistry(provider),
    );
    expect(method.headers.get("Allow")).toBe("POST");
    expect(
      (
        await handlePlannedTeamSites(
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
        await handlePlannedTeamSites(
          request(),
          { ...principal, status: "revoked" },
          createTestProviderRegistry(provider),
        )
      ).status,
    ).toBe(403);
    for (const accept of ["application/*", "*/*"]) {
      expect(
        (
          await handlePlannedTeamSites(
            request(JSON.stringify(input), { headers: { accept } }),
            principal,
            createTestProviderRegistry(reader()),
          )
        ).status,
      ).toBe(200);
    }
  });
});
