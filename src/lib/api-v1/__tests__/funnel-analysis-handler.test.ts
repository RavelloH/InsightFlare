import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTestProviderRegistry } from "@/lib/api-v1/__tests__/provider-registry";
import { AnalysisDefinitionReadCancelledError } from "@/lib/api-v1/analysis-definition-reader";
import { handlePlannedSiteFunnelAnalysis } from "@/lib/api-v1/funnel-analysis-handler";
import type { ApiKeyPrincipal } from "@/lib/edge/api-key-auth";

const principal = (
  overrides: Partial<ApiKeyPrincipal> = {},
): ApiKeyPrincipal => ({
  keyId: "key-1",
  teamId: "team-1",
  prefix: "prefix",
  scopes: ["analytics:read"],
  siteIds: ["site-1"],
  status: "active",
  ...overrides,
});

function request(body: unknown, init: RequestInit = {}): Request {
  return new Request(
    "https://app.test/api/v1/sites/site-1/analytics/funnel-analysis",
    {
      method: "POST",
      headers: { "content-type": "application/json", ...init.headers },
      body: JSON.stringify(body),
      ...init,
    },
  );
}

const body = {
  funnelId: "funnel-1",
  timeRange: {
    kind: "absolute",
    from: "2026-08-01T00:00:00.000Z",
    to: "2026-08-02T00:00:00.000Z",
    timeZone: "UTC",
  },
};

const provider = vi.fn();

describe("typed site funnel-analysis HTTP adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("executes an authorized canonical query and serializes analytics metadata", async () => {
    provider.mockResolvedValue({
      funnel: {
        id: "funnel-1",
        siteId: "site-1",
        name: "Checkout",
        steps: [
          { type: "pageview", value: "/start" },
          { type: "event", value: "purchase" },
        ],
        createdAt: 1,
        updatedAt: 2,
      },
      analysis: {
        steps: [],
        summary: {
          totalSessions: 0,
          convertedSessions: 0,
          totalVisitors: 0,
          convertedVisitors: 0,
          overallConversionRate: 0,
          largestDropOffStepIndex: null,
        },
      },
    });

    const response = await handlePlannedSiteFunnelAnalysis(
      request(body),
      principal(),
      "site-1",
      createTestProviderRegistry(provider),
      undefined,
      { capturedAtMs: Date.parse("2026-08-02T00:00:00.000Z") },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { funnel: { id: "funnel-1" } },
      meta: {
        source: "raw",
        accuracy: "exact",
        timeRange: {
          from: body.timeRange.from,
          to: body.timeRange.to,
          timeZone: body.timeRange.timeZone,
        },
      },
    });
    expect(provider).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: "site-1", funnelId: "funnel-1" }),
    );
    await expect(
      handlePlannedSiteFunnelAnalysis(
        request(body, {
          headers: {
            "content-type": "application/json",
            accept: "application/json",
          },
        }),
        principal(),
        "site-1",
        createTestProviderRegistry(provider),
      ),
    ).resolves.toHaveProperty("status", 200);
  });

  it("enforces JSON, scope, site and saved-filter policy before provider execution", async () => {
    await expect(
      handlePlannedSiteFunnelAnalysis(
        request(body, { headers: { "content-type": "text/plain" } }),
        principal(),
        "site-1",
        createTestProviderRegistry(provider),
      ),
    ).resolves.toHaveProperty("status", 415);
    await expect(
      handlePlannedSiteFunnelAnalysis(
        request(body),
        principal({ scopes: [] }),
        "site-1",
        createTestProviderRegistry(provider),
      ),
    ).resolves.toHaveProperty("status", 403);
    await expect(
      handlePlannedSiteFunnelAnalysis(
        request(body),
        principal({ siteIds: ["site-2"] }),
        "site-1",
        createTestProviderRegistry(provider),
      ),
    ).resolves.toHaveProperty("status", 404);
    await expect(
      handlePlannedSiteFunnelAnalysis(
        request({ ...body, filter: { type: "saved", id: "filter-1" } }),
        principal(),
        "site-1",
        createTestProviderRegistry(provider),
      ),
    ).resolves.toHaveProperty("status", 403);
    expect(provider).not.toHaveBeenCalled();
  });

  it("resolves saved filters before the provider and preserves 404 semantics", async () => {
    provider.mockResolvedValue(null);
    const definitions = {
      resolveTeamVisibleSavedFilter: vi.fn().mockResolvedValue({
        document: { version: 1, root: null },
        fingerprint: "safe",
      }),
    };
    const response = await handlePlannedSiteFunnelAnalysis(
      request({ ...body, filter: { type: "saved", id: "filter-1" } }),
      principal({ scopes: ["analytics:read", "analysis:read"] }),
      "site-1",
      createTestProviderRegistry(provider),
      definitions,
    );
    expect(response.status).toBe(404);
    expect(definitions.resolveTeamVisibleSavedFilter).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: "site-1", id: "filter-1" }),
    );
  });

  it("maps transport, parsing, saved-filter, deadline, and provider failures to stable errors", async () => {
    await expect(
      handlePlannedSiteFunnelAnalysis(
        new Request("https://app.test", { method: "GET" }),
        principal(),
        "site-1",
        createTestProviderRegistry(provider),
      ),
    ).resolves.toHaveProperty("status", 405);
    await expect(
      handlePlannedSiteFunnelAnalysis(
        request(body, { headers: { "content-encoding": "gzip" } }),
        principal(),
        "site-1",
        createTestProviderRegistry(provider),
      ),
    ).resolves.toHaveProperty("status", 415);
    await expect(
      handlePlannedSiteFunnelAnalysis(
        request(body, {
          headers: { "content-type": "application/json", accept: "text/html" },
        }),
        principal(),
        "site-1",
        createTestProviderRegistry(provider),
      ),
    ).resolves.toHaveProperty("status", 406);
    await expect(
      handlePlannedSiteFunnelAnalysis(
        request({}),
        principal(),
        "site-1",
        createTestProviderRegistry(provider),
      ),
    ).resolves.toHaveProperty("status", 400);
    await expect(
      handlePlannedSiteFunnelAnalysis(
        request({ ...body, filter: { type: "saved", id: "missing" } }),
        principal({ scopes: ["analytics:read", "analysis:read"] }),
        "site-1",
        createTestProviderRegistry(provider),
      ),
    ).resolves.toHaveProperty("status", 404);
    await expect(
      handlePlannedSiteFunnelAnalysis(
        request({
          ...body,
          filter: {
            type: "dsl",
            expression: 'page.path unsupportedOperator "/docs"',
          },
        }),
        principal(),
        "site-1",
        createTestProviderRegistry(provider),
      ),
    ).resolves.toHaveProperty("status", 400);

    const cancelledDefinitions = {
      resolveTeamVisibleSavedFilter: vi
        .fn()
        .mockRejectedValue(new AnalysisDefinitionReadCancelledError()),
    };
    await expect(
      handlePlannedSiteFunnelAnalysis(
        request({ ...body, filter: { type: "saved", id: "cancelled" } }),
        principal({ scopes: ["analytics:read", "analysis:read"] }),
        "site-1",
        createTestProviderRegistry(provider),
        cancelledDefinitions,
      ),
    ).resolves.toHaveProperty("status", 499);
    await expect(
      handlePlannedSiteFunnelAnalysis(
        request(body),
        principal(),
        "site-1",
        createTestProviderRegistry(provider),
        undefined,
        { deadlineMs: Date.now() - 1 },
      ),
    ).resolves.toHaveProperty("status", 504);

    provider.mockRejectedValueOnce(new Error("provider down"));
    await expect(
      handlePlannedSiteFunnelAnalysis(
        request(body),
        principal(),
        "site-1",
        createTestProviderRegistry(provider),
      ),
    ).resolves.toHaveProperty("status", 503);
  });

  it("fails closed for corrupt filters, oversized input, resolver errors, invalid ranges, and cancellation", async () => {
    await expect(
      handlePlannedSiteFunnelAnalysis(
        request({
          ...body,
          filter: { type: "inline", expression: { kind: "invalid" } },
        }),
        principal(),
        "site-1",
        createTestProviderRegistry(provider),
      ),
    ).resolves.toHaveProperty("status", 400);
    await expect(
      handlePlannedSiteFunnelAnalysis(
        new Request(
          "https://app.test/api/v1/sites/site-1/analytics/funnel-analysis",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "x".repeat(65 * 1024),
          },
        ),
        principal(),
        "site-1",
        createTestProviderRegistry(provider),
      ),
    ).resolves.toHaveProperty("status", 422);
    await expect(
      handlePlannedSiteFunnelAnalysis(
        request({
          ...body,
          timeRange: { ...body.timeRange, to: "2026-07-31T00:00:00.000Z" },
        }),
        principal(),
        "site-1",
        createTestProviderRegistry(provider),
      ),
    ).resolves.toHaveProperty("status", 400);

    const failingDefinitions = {
      resolveTeamVisibleSavedFilter: vi
        .fn()
        .mockRejectedValue(new Error("definition store unavailable")),
    };
    await expect(
      handlePlannedSiteFunnelAnalysis(
        request({ ...body, filter: { type: "saved", id: "broken" } }),
        principal({ scopes: ["analytics:read", "analysis:read"] }),
        "site-1",
        createTestProviderRegistry(provider),
        failingDefinitions,
      ),
    ).resolves.toHaveProperty("status", 500);

    const controller = new AbortController();
    controller.abort();
    await expect(
      handlePlannedSiteFunnelAnalysis(
        request(body),
        principal(),
        "site-1",
        createTestProviderRegistry(provider),
        undefined,
        { signal: controller.signal },
      ),
    ).resolves.toHaveProperty("status", 499);
  });
});
