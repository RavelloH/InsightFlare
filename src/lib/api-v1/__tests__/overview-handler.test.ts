import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTestProviderRegistry } from "@/lib/api-v1/__tests__/provider-registry";
import { aggregateCache } from "@/lib/api-v1/analytics-overview";
import { handlePlannedSiteOverview } from "@/lib/api-v1/overview-handler";
import {
  AnalyticsOverviewResponseSchema,
  ApiV1ErrorEnvelopeSchema,
} from "@/lib/api-v1/wire";
import {
  EMPTY_FILTER_DOCUMENT,
  type OverviewReader,
} from "@/lib/edge/analytics/contract";
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
};

beforeEach(() => aggregateCache.clear());

function reader(): OverviewReader {
  return {
    readOverview: vi.fn().mockResolvedValue({
      value: {
        views: 10,
        sessions: 4,
        visitors: 3,
        bounces: 1,
        totalDurationMs: 1200,
        durationViews: 10,
      },
      source: "raw",
      approximateVisitors: false,
    }),
    readTrend: vi.fn(),
  };
}

describe("planned site overview HTTP adapter", () => {
  it("returns the typed analytics envelope and request headers", async () => {
    const app = new Hono();
    app.post("/api/v1/sites/:siteId/analytics/overview", (c) =>
      handlePlannedSiteOverview(
        c.req.raw,
        principal,
        c.req.param("siteId"),
        createTestProviderRegistry(reader()),
        {},
      ),
    );
    const request = new Request(
      "https://app.test/api/v1/sites/site-1/analytics/overview",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Request-Id": "client-id",
        },
        body: JSON.stringify(input),
      },
    );
    const response = await app.fetch(request);
    const body = (await response.json()) as {
      readonly data: Record<string, unknown>;
      readonly meta: { readonly requestId: string } & Record<string, unknown>;
    };
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Request-Id")).not.toBe("client-id");
    expect(body).toMatchObject({
      data: {
        views: 10,
        sessions: 4,
        avgDurationMs: 300,
        bounceRate: 0.25,
      },
      meta: {
        timeRange: { timeZone: "UTC" },
        source: "raw",
        accuracy: "exact",
      },
    });
    expect(body.meta.requestId).toBe(response.headers.get("X-Request-Id"));
    expect(AnalyticsOverviewResponseSchema.safeParse(body).success).toBe(true);
  });

  it("fails before provider access for invalid method/body and scope", async () => {
    const provider = reader();
    const getResponse = await handlePlannedSiteOverview(
      new Request("https://app.test/api/v1/sites/site-1/analytics/overview"),
      principal,
      "site-1",
      createTestProviderRegistry(provider),
      {},
    );
    expect(getResponse.status).toBe(405);
    expect(getResponse.headers.get("Allow")).toBe("POST");
    expect(provider.readOverview).not.toHaveBeenCalled();

    const invalid = await handlePlannedSiteOverview(
      new Request("https://app.test/api/v1/sites/site-1/analytics/overview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      }),
      principal,
      "site-1",
      createTestProviderRegistry(provider),
      {},
    );
    expect(invalid.status).toBe(400);

    const denied = await handlePlannedSiteOverview(
      new Request("https://app.test/api/v1/sites/site-1/analytics/overview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
      { ...principal, scopes: [] },
      "site-1",
      createTestProviderRegistry(provider),
      {},
    );
    expect(denied.status).toBe(403);
    expect(provider.readOverview).not.toHaveBeenCalled();

    const unsupported = await handlePlannedSiteOverview(
      new Request("https://app.test/api/v1/sites/site-1/analytics/overview", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify(input),
      }),
      principal,
      "site-1",
      createTestProviderRegistry(provider),
      {},
    );
    expect(unsupported.status).toBe(415);
    expect(
      ApiV1ErrorEnvelopeSchema.safeParse(await unsupported.json()).success,
    ).toBe(true);

    const unacceptable = await handlePlannedSiteOverview(
      new Request("https://app.test/api/v1/sites/site-1/analytics/overview", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/plain",
        },
        body: JSON.stringify(input),
      }),
      principal,
      "site-1",
      createTestProviderRegistry(provider),
      {},
    );
    expect(unacceptable.status).toBe(406);
  });

  it("resolves saved filters through the injected scoped reader", async () => {
    const definitions = {
      resolveTeamVisibleSavedFilter: vi.fn().mockResolvedValue({
        document: EMPTY_FILTER_DOCUMENT,
        fingerprint: "filter-fingerprint",
      }),
    };
    const response = await handlePlannedSiteOverview(
      new Request("https://app.test/api/v1/sites/site-1/analytics/overview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...input,
          filter: { type: "saved", id: "filter-1" },
        }),
      }),
      { ...principal, scopes: ["analytics:read", "analysis:read"] },
      "site-1",
      createTestProviderRegistry(reader()),
      {},
      definitions,
    );
    expect(response.status).toBe(200);
    expect(definitions.resolveTeamVisibleSavedFilter).toHaveBeenCalledWith({
      siteId: "site-1",
      id: "filter-1",
      signal: undefined,
    });
  });

  it("returns zero derived metrics when no sessions are present", async () => {
    const provider = reader();
    provider.readOverview = vi.fn().mockResolvedValue({
      value: {
        views: 0,
        sessions: 0,
        visitors: 0,
        bounces: 0,
        totalDurationMs: 0,
        durationViews: 0,
      },
      source: "raw",
      approximateVisitors: false,
    });
    const response = await handlePlannedSiteOverview(
      new Request("https://app.test/api/v1/sites/site-1/analytics/overview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
      principal,
      "site-1",
      createTestProviderRegistry(provider),
      {},
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { avgDurationMs: 0, bounceRate: 0 },
    });
  });

  it("uses stable protocol and policy errors for boundary failures", async () => {
    const jsonRequest = (body: BodyInit | null, init: RequestInit = {}) => {
      const { headers, ...rest } = init;
      return new Request(
        "https://app.test/api/v1/sites/site-1/analytics/overview",
        {
          ...rest,
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body,
        },
      );
    };

    expect(
      (
        await handlePlannedSiteOverview(
          jsonRequest(null),
          principal,
          "site-1",
          createTestProviderRegistry(reader()),
          {},
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handlePlannedSiteOverview(
          jsonRequest("x".repeat(70_000)),
          principal,
          "site-1",
          createTestProviderRegistry(reader()),
          {},
        )
      ).status,
    ).toBe(400);

    const controller = new AbortController();
    controller.abort();
    expect(
      (
        await handlePlannedSiteOverview(
          jsonRequest(JSON.stringify(input)),
          principal,
          "site-1",
          createTestProviderRegistry(reader()),
          { signal: controller.signal },
        )
      ).status,
    ).toBe(499);
    expect(
      (
        await handlePlannedSiteOverview(
          jsonRequest(JSON.stringify(input)),
          principal,
          "site-1",
          createTestProviderRegistry(reader()),
          { now: () => 1, deadlineMs: 1 },
        )
      ).status,
    ).toBe(504);
    expect(
      (
        await handlePlannedSiteOverview(
          jsonRequest(JSON.stringify(input)),
          { ...principal, siteIds: ["other-site"] },
          "site-1",
          createTestProviderRegistry(reader()),
          {},
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await handlePlannedSiteOverview(
          jsonRequest(JSON.stringify(input)),
          { ...principal, status: "revoked" },
          "site-1",
          createTestProviderRegistry(reader()),
          {},
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handlePlannedSiteOverview(
          jsonRequest(
            JSON.stringify({
              ...input,
              filter: { type: "saved", id: "filter-1" },
            }),
          ),
          { ...principal, scopes: ["analytics:read", "analysis:read"] },
          "site-1",
          createTestProviderRegistry(reader()),
          {},
        )
      ).status,
    ).toBe(404);
    for (const accept of ["application/json", "application/*", "*/*"]) {
      expect(
        (
          await handlePlannedSiteOverview(
            jsonRequest(JSON.stringify(input), { headers: { Accept: accept } }),
            principal,
            "site-1",
            createTestProviderRegistry(reader()),
            {},
          )
        ).status,
      ).toBe(200);
    }
    expect(
      (
        await handlePlannedSiteOverview(
          jsonRequest(
            JSON.stringify({
              ...input,
              filter: { type: "saved", id: "filter-1" },
            }),
          ),
          { ...principal, scopes: ["analytics:read", "analysis:read"] },
          "site-1",
          createTestProviderRegistry(reader()),
          {},
          {
            resolveTeamVisibleSavedFilter: vi
              .fn()
              .mockRejectedValue(new Error("failed")),
          },
        )
      ).status,
    ).toBe(500);
  });

  it("rejects content encoding and provider completion after cancellation", async () => {
    expect(
      (
        await handlePlannedSiteOverview(
          new Request("https://app.test", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "content-encoding": "gzip",
            },
            body: JSON.stringify(input),
          }),
          principal,
          "site-1",
          createTestProviderRegistry(reader()),
          {},
        )
      ).status,
    ).toBe(415);
    const controller = new AbortController();
    const provider = reader();
    provider.readOverview = vi.fn().mockImplementation(async () => {
      controller.abort();
      return {
        value: {
          views: 0,
          sessions: 0,
          visitors: 0,
          bounces: 0,
          totalDurationMs: 0,
          durationViews: 0,
        },
        source: "raw",
        approximateVisitors: false,
      };
    });
    expect(
      (
        await handlePlannedSiteOverview(
          new Request("https://app.test", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(input),
          }),
          principal,
          "site-1",
          createTestProviderRegistry(provider),
          { signal: controller.signal },
        )
      ).status,
    ).toBe(499);
  });
});
