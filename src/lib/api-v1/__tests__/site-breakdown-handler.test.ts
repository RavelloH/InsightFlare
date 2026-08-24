import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { createTestProviderRegistry } from "@/lib/api-v1/__tests__/provider-registry";
import {
  AnalysisDefinitionIntegrityError,
  AnalysisDefinitionReadCancelledError,
  type AnalysisDefinitionReader,
} from "@/lib/api-v1/analysis-definition-reader";
import {
  handlePlannedSiteBreakdown,
  type SiteBreakdownReader,
} from "@/lib/api-v1/site-breakdown-handler";
import {
  AnalyticsBreakdownResponseSchema,
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
  limit: 10,
};

function reader() {
  return vi.fn<SiteBreakdownReader>().mockResolvedValue({
    items: [
      {
        key: "/pricing",
        label: "/pricing",
        views: 10,
        sessions: 4,
        visitors: 3,
      },
    ],
  });
}

function request(
  body: BodyInit | null = JSON.stringify(input),
  init: RequestInit = {},
) {
  const method = init.method ?? "POST";
  return new Request(
    "https://app.test/api/v1/sites/site-1/analytics/breakdowns/page.path",
    {
      ...init,
      method,
      headers: { "Content-Type": "application/json", ...init.headers },
      ...(method === "GET" || method === "HEAD" ? {} : { body }),
    },
  );
}

describe("planned site breakdown HTTP adapter", () => {
  it("serves typed path-scoped breakdowns through a live Hono route", async () => {
    const provider = reader();
    const app = new Hono();
    app.post(
      "/api/v1/sites/:siteId/analytics/breakdowns/:dimension",
      (context) =>
        handlePlannedSiteBreakdown(
          context.req.raw,
          principal,
          context.req.param("siteId"),
          context.req.param("dimension"),
          createTestProviderRegistry(provider),
        ),
    );
    const response = await app.fetch(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(AnalyticsBreakdownResponseSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      data: { dimension: "page.path", items: [{ key: "/pricing", views: 10 }] },
      meta: { source: "raw", accuracy: "exact" },
    });
    expect(provider).toHaveBeenCalledWith(
      expect.objectContaining({
        siteId: "site-1",
        dimension: "page.path",
        limit: 10,
      }),
    );
  });

  it("fails closed before the provider for protocol, scope, site, dimension, and time failures", async () => {
    const provider = reader();
    for (const candidate of [
      request(null),
      request(JSON.stringify({ ...input, unexpected: true })),
      request(
        JSON.stringify({
          ...input,
          timeRange: { ...input.timeRange, to: input.timeRange.from },
        }),
      ),
      request(JSON.stringify(input), { headers: { Accept: "text/plain" } }),
      request(JSON.stringify(input), {
        headers: { "Content-Type": "text/plain" },
      }),
      request(JSON.stringify(input), { method: "GET" }),
    ]) {
      const response = await handlePlannedSiteBreakdown(
        candidate,
        principal,
        "site-1",
        "page.path",
        createTestProviderRegistry(provider),
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(
        ApiV1ErrorEnvelopeSchema.safeParse(await response.json()).success,
      ).toBe(true);
    }
    expect(
      (
        await handlePlannedSiteBreakdown(
          request(),
          { ...principal, scopes: [] },
          "site-1",
          "page.path",
          createTestProviderRegistry(provider),
        )
      ).status,
    ).toBe(403);

    const hidden = await handlePlannedSiteBreakdown(
      request(
        JSON.stringify({
          ...input,
          filter: { type: "saved", id: "missing-filter" },
        }),
      ),
      { ...principal, scopes: ["analytics:read", "analysis:read"] },
      "site-1",
      "page.path",
      createTestProviderRegistry(provider),
      {},
      { resolveTeamVisibleSavedFilter: vi.fn().mockResolvedValue(null) },
    );
    expect(hidden.status).toBe(404);
    expect(
      (
        await handlePlannedSiteBreakdown(
          request(),
          principal,
          "site-2",
          "page.path",
          createTestProviderRegistry(provider),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await handlePlannedSiteBreakdown(
          request(),
          principal,
          "site-1",
          "not.real",
          createTestProviderRegistry(provider),
        )
      ).status,
    ).toBe(400);
    expect(provider).not.toHaveBeenCalled();
  });

  it("resolves saved filters after its conditional scope gate and retains cancellation/deadline semantics", async () => {
    const provider = reader();
    const definitions: AnalysisDefinitionReader = {
      resolveTeamVisibleSavedFilter: vi.fn().mockResolvedValue({
        document: { version: 1, root: null },
        fingerprint: "saved-filter-v1:test",
      }),
    };
    const saved = request(
      JSON.stringify({ ...input, filter: { type: "saved", id: "filter-1" } }),
    );
    await expect(
      handlePlannedSiteBreakdown(
        saved,
        { ...principal, scopes: ["analytics:read", "analysis:read"] },
        "site-1",
        "page.path",
        createTestProviderRegistry(provider),
        {},
        definitions,
      ),
    ).resolves.toMatchObject({ status: 200 });
    expect(definitions.resolveTeamVisibleSavedFilter).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: "site-1", id: "filter-1" }),
    );
    expect(
      (
        await handlePlannedSiteBreakdown(
          request(
            JSON.stringify({
              ...input,
              filter: { type: "saved", id: "filter-1" },
            }),
          ),
          principal,
          "site-1",
          "page.path",
          createTestProviderRegistry(provider),
          {},
          definitions,
        )
      ).status,
    ).toBe(403);

    const cancelled = new AbortController();
    cancelled.abort();
    expect(
      (
        await handlePlannedSiteBreakdown(
          request(),
          principal,
          "site-1",
          "page.path",
          createTestProviderRegistry(provider),
          { signal: cancelled.signal },
        )
      ).status,
    ).toBe(499);
    expect(
      (
        await handlePlannedSiteBreakdown(
          request(),
          principal,
          "site-1",
          "page.path",
          createTestProviderRegistry(provider),
          { deadlineMs: 1, now: () => 1 },
        )
      ).status,
    ).toBe(504);
  });

  it("uses DTO defaults and fails closed for definition and provider failures", async () => {
    const provider = reader();
    const defaulted = await handlePlannedSiteBreakdown(
      request(
        JSON.stringify({
          timeRange: {
            kind: "absolute",
            from: input.timeRange.from,
            to: input.timeRange.to,
          },
        }),
      ),
      principal,
      "site-1",
      "page.path",
      createTestProviderRegistry(provider),
    );
    expect(defaulted.status).toBe(200);
    expect(provider).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: 20, timeZone: "UTC" }),
    );

    const savedPrincipal: ApiKeyPrincipal = {
      ...principal,
      scopes: ["analytics:read", "analysis:read"],
    };
    const savedRequest = () =>
      request(
        JSON.stringify({
          ...input,
          filter: { type: "saved", id: "filter-1" },
        }),
      );
    for (const error of [
      new AnalysisDefinitionIntegrityError(),
      new Error("database unavailable"),
    ]) {
      const response = await handlePlannedSiteBreakdown(
        savedRequest(),
        savedPrincipal,
        "site-1",
        "page.path",
        createTestProviderRegistry(provider),
        {},
        { resolveTeamVisibleSavedFilter: vi.fn().mockRejectedValue(error) },
      );
      expect(response.status).toBe(500);
    }
    const cancelled = await handlePlannedSiteBreakdown(
      savedRequest(),
      savedPrincipal,
      "site-1",
      "page.path",
      createTestProviderRegistry(provider),
      {},
      {
        resolveTeamVisibleSavedFilter: vi
          .fn()
          .mockRejectedValue(new AnalysisDefinitionReadCancelledError()),
      },
    );
    expect(cancelled.status).toBe(499);

    const deadlineProvider = reader();
    let nowCalls = 0;
    const deadlineAfterProvider = await handlePlannedSiteBreakdown(
      request(),
      principal,
      "site-1",
      "page.path",
      createTestProviderRegistry(deadlineProvider),
      { deadlineMs: 1, now: () => (nowCalls++ === 0 ? 0 : 1) },
    );
    expect(deadlineAfterProvider.status).toBe(504);

    const controller = new AbortController();
    const abortingProvider: SiteBreakdownReader = async () => {
      controller.abort();
      return { items: [] };
    };
    expect(
      (
        await handlePlannedSiteBreakdown(
          request(),
          principal,
          "site-1",
          "page.path",
          createTestProviderRegistry(abortingProvider),
          { signal: controller.signal },
        )
      ).status,
    ).toBe(499);

    const failingProvider = vi
      .fn<SiteBreakdownReader>()
      .mockRejectedValue(new Error("provider failure"));
    expect(
      (
        await handlePlannedSiteBreakdown(
          request(),
          principal,
          "site-1",
          "page.path",
          createTestProviderRegistry(failingProvider),
        )
      ).status,
    ).toBe(500);
  });

  it("exposes method and encoding semantics while failing closed for unavailable saved definitions", async () => {
    const provider = reader();
    const method = await handlePlannedSiteBreakdown(
      request(JSON.stringify(input), { method: "GET" }),
      principal,
      "site-1",
      "page.path",
      createTestProviderRegistry(provider),
    );
    expect(method.headers.get("Allow")).toBe("POST");
    expect(
      (
        await handlePlannedSiteBreakdown(
          request(JSON.stringify(input), {
            headers: { "content-encoding": "gzip" },
          }),
          principal,
          "site-1",
          "page.path",
          createTestProviderRegistry(provider),
        )
      ).status,
    ).toBe(415);
    expect(
      (
        await handlePlannedSiteBreakdown(
          request(),
          { ...principal, status: "revoked" },
          "site-1",
          "page.path",
          createTestProviderRegistry(provider),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handlePlannedSiteBreakdown(
          request(
            JSON.stringify({
              ...input,
              filter: { type: "saved", id: "filter-1" },
            }),
          ),
          { ...principal, scopes: ["analytics:read", "analysis:read"] },
          "site-1",
          "page.path",
          createTestProviderRegistry(provider),
        )
      ).status,
    ).toBe(404);

    const controller = new AbortController();
    const aborting: SiteBreakdownReader = async () => {
      controller.abort();
      throw new Error("cancelled after provider start");
    };
    expect(
      (
        await handlePlannedSiteBreakdown(
          request(),
          principal,
          "site-1",
          "page.path",
          createTestProviderRegistry(aborting),
          { signal: controller.signal },
        )
      ).status,
    ).toBe(499);
  });
});
