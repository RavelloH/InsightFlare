import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTestProviderRegistry } from "@/lib/api-v1/__tests__/provider-registry";
import {
  AnalysisDefinitionIntegrityError,
  AnalysisDefinitionReadCancelledError,
} from "@/lib/api-v1/analysis-definition-reader";
import {
  aggregateCache,
  type AnalysisDefinitionReader,
  executeApiV1SiteOverview,
} from "@/lib/api-v1/analytics-overview";
import {
  EMPTY_FILTER_DOCUMENT,
  type OverviewReader,
} from "@/lib/edge/analytics/contract";
import type { ApiKeyPrincipal } from "@/lib/edge/api-key-auth";

beforeEach(() => aggregateCache.clear());

const principal = (
  overrides: Partial<ApiKeyPrincipal> = {},
): ApiKeyPrincipal => ({
  keyId: "key-1",
  teamId: "team-1",
  prefix: "prefix",
  scopes: ["analytics:read"],
  siteIds: [],
  status: "active",
  ...overrides,
});

const body = {
  timeRange: {
    kind: "absolute",
    from: "2026-08-01T00:00:00.000Z",
    to: "2026-08-02T00:00:00.000Z",
    timeZone: "UTC",
  },
};

function overviewReader(): OverviewReader {
  return {
    readOverview: vi.fn().mockResolvedValue({
      value: {
        views: 1,
        sessions: 1,
        visitors: 1,
        bounces: 0,
        totalDurationMs: 0,
        durationViews: 0,
      },
      source: "raw",
      approximateVisitors: false,
    }),
    readTrend: vi.fn(),
  };
}

describe("API v1 overview adapter", () => {
  it("authorizes before resolving definitions or reading analytics", async () => {
    const reader = overviewReader();
    const definitions: AnalysisDefinitionReader = {
      resolveTeamVisibleSavedFilter: vi.fn(),
    };

    const result = await executeApiV1SiteOverview(
      { ...body, filter: { type: "saved", id: "filter-1" } },
      principal({ scopes: [] }),
      "site-1",
      createTestProviderRegistry(reader),
      {},
      definitions,
    );

    expect(result).toEqual({ ok: false, error: { kind: "missing_scope" } });
    expect(definitions.resolveTeamVisibleSavedFilter).not.toHaveBeenCalled();
    expect(reader.readOverview).not.toHaveBeenCalled();
  });

  it("executes a saved filter only after a site-scoped definition lookup", async () => {
    const reader = overviewReader();
    const definitions: AnalysisDefinitionReader = {
      resolveTeamVisibleSavedFilter: vi.fn().mockResolvedValue({
        document: EMPTY_FILTER_DOCUMENT,
        fingerprint: "filter-1:abc",
      }),
    };

    const result = await executeApiV1SiteOverview(
      { ...body, filter: { type: "saved", id: "filter-1" } },
      principal({
        scopes: ["analytics:read", "analysis:read"],
        siteIds: ["site-1"],
      }),
      "site-1",
      createTestProviderRegistry(reader),
      {},
      definitions,
    );

    expect(result).toMatchObject({ ok: true, value: { ok: true } });
    expect(definitions.resolveTeamVisibleSavedFilter).toHaveBeenCalledWith({
      siteId: "site-1",
      id: "filter-1",
      signal: undefined,
    });
    expect(reader.readOverview).toHaveBeenCalledOnce();
  });

  it("accepts inline filters and defaults the reporting time zone", async () => {
    const reader = overviewReader();
    const result = await executeApiV1SiteOverview(
      {
        timeRange: {
          kind: "absolute",
          from: body.timeRange.from,
          to: body.timeRange.to,
        },
        filter: {
          type: "inline",
          expression: {
            kind: "condition",
            target: { kind: "field", field: "geo.country" },
            operator: "eq",
            value: "US",
          },
        },
      },
      principal(),
      "site-1",
      createTestProviderRegistry(reader),
      {},
    );
    expect(result).toMatchObject({ ok: true, value: { ok: true } });
  });

  it("parses DSL filters into the canonical API filter document", async () => {
    const reader = overviewReader();
    const result = await executeApiV1SiteOverview(
      {
        ...body,
        filter: {
          type: "dsl",
          expression: 'geo.country eq "US" AND page.path startsWith "/docs"',
        },
      },
      principal(),
      "site-1",
      createTestProviderRegistry(reader),
      {},
    );

    expect(result).toMatchObject({ ok: true, value: { ok: true } });
    expect(reader.readOverview).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: {
          version: 1,
          root: {
            kind: "and",
            children: [
              {
                kind: "condition",
                target: { kind: "field", field: "geo.country" },
                operator: "eq",
                value: "us",
              },
              {
                kind: "condition",
                target: { kind: "field", field: "page.path" },
                operator: "startsWith",
                value: "/docs",
              },
            ],
          },
        },
      }),
    );
  });

  it("rejects invalid DSL filters with the API filter error", async () => {
    const reader = overviewReader();
    const result = await executeApiV1SiteOverview(
      {
        ...body,
        filter: {
          type: "dsl",
          expression: 'page.path unsupportedOperator "/docs"',
        },
      },
      principal(),
      "site-1",
      createTestProviderRegistry(reader),
      {},
    );

    expect(result).toEqual({
      ok: false,
      error: { kind: "invalid_input", reason: "invalid_filter" },
    });
    expect(reader.readOverview).not.toHaveBeenCalled();
  });

  it("requires analysis:read in addition to analytics:read for saved filters", async () => {
    const reader = overviewReader();
    const definitions: AnalysisDefinitionReader = {
      resolveTeamVisibleSavedFilter: vi.fn(),
    };

    const result = await executeApiV1SiteOverview(
      { ...body, filter: { type: "saved", id: "filter-1" } },
      principal(),
      "site-1",
      createTestProviderRegistry(reader),
      {},
      definitions,
    );

    expect(result).toEqual({ ok: false, error: { kind: "missing_scope" } });
    expect(definitions.resolveTeamVisibleSavedFilter).not.toHaveBeenCalled();
    expect(reader.readOverview).not.toHaveBeenCalled();
  });

  it("rejects oversized nested JSON before recursive schema parsing", async () => {
    let expression: Record<string, unknown> = {
      kind: "condition",
      target: { kind: "field", field: "geo.country" },
      operator: "eq",
      value: "US",
    };
    for (let index = 0; index < 18; index += 1) {
      expression = { kind: "not", child: expression };
    }
    const reader = overviewReader();

    const result = await executeApiV1SiteOverview(
      { ...body, filter: { type: "inline", expression } },
      principal(),
      "site-1",
      createTestProviderRegistry(reader),
      {},
    );

    expect(result).toEqual({
      ok: false,
      error: { kind: "invalid_input", reason: "body_too_deep" },
    });
    expect(reader.readOverview).not.toHaveBeenCalled();
  });

  it("enforces serialization, byte, and node budgets before validation", async () => {
    const reader = overviewReader();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(
      await executeApiV1SiteOverview(
        cyclic,
        principal(),
        "site-1",
        createTestProviderRegistry(reader),
        {},
      ),
    ).toEqual({
      ok: false,
      error: { kind: "invalid_input", reason: "body_not_serializable" },
    });
    expect(
      await executeApiV1SiteOverview(
        { payload: "x".repeat(70_000) },
        principal(),
        "site-1",
        createTestProviderRegistry(reader),
        {},
      ),
    ).toEqual({
      ok: false,
      error: { kind: "invalid_input", reason: "body_too_large" },
    });
    expect(
      await executeApiV1SiteOverview(
        Array.from({ length: 520 }, () => null),
        principal(),
        "site-1",
        createTestProviderRegistry(reader),
        {},
      ),
    ).toEqual({
      ok: false,
      error: { kind: "invalid_input", reason: "body_too_complex" },
    });
  });

  it("rejects schema, cancellation, deadline, inactive-token, and site access failures", async () => {
    const reader = overviewReader();
    expect(
      await executeApiV1SiteOverview(
        { ...body, unexpected: true },
        principal(),
        "site-1",
        createTestProviderRegistry(reader),
        {},
      ),
    ).toEqual({
      ok: false,
      error: { kind: "invalid_input", reason: "schema_validation_failed" },
    });
    const controller = new AbortController();
    controller.abort();
    expect(
      await executeApiV1SiteOverview(
        body,
        principal(),
        "site-1",
        createTestProviderRegistry(reader),
        {
          signal: controller.signal,
        },
      ),
    ).toEqual({ ok: false, error: { kind: "request_cancelled" } });
    expect(
      await executeApiV1SiteOverview(
        body,
        principal(),
        "site-1",
        createTestProviderRegistry(reader),
        {
          now: () => 100,
          deadlineMs: 100,
        },
      ),
    ).toEqual({ ok: false, error: { kind: "deadline_exceeded" } });
    expect(
      await executeApiV1SiteOverview(
        body,
        principal({ status: "revoked" }),
        "site-1",
        createTestProviderRegistry(reader),
        {},
      ),
    ).toEqual({ ok: false, error: { kind: "token_inactive" } });
    expect(
      await executeApiV1SiteOverview(
        body,
        principal({ siteIds: ["other-site"] }),
        "site-1",
        createTestProviderRegistry(reader),
        {},
      ),
    ).toEqual({ ok: false, error: { kind: "site_not_found" } });
  });

  it("fails closed for saved-filter lookup and inline-filter errors", async () => {
    const reader = overviewReader();
    expect(
      await executeApiV1SiteOverview(
        { ...body, timeRange: { ...body.timeRange, to: body.timeRange.from } },
        principal(),
        "site-1",
        createTestProviderRegistry(reader),
        {},
      ),
    ).toEqual({
      ok: false,
      error: { kind: "invalid_input", reason: "invalid_time_range" },
    });
    expect(
      await executeApiV1SiteOverview(
        { ...body, timeRange: { ...body.timeRange, timeZone: "Not/AZone" } },
        principal(),
        "site-1",
        createTestProviderRegistry(reader),
        {},
      ),
    ).toEqual({
      ok: false,
      error: { kind: "invalid_input", reason: "invalid_time_zone" },
    });
    const missingDefinitions = await executeApiV1SiteOverview(
      { ...body, filter: { type: "saved", id: "filter-1" } },
      principal({ scopes: ["analytics:read", "analysis:read"] }),
      "site-1",
      createTestProviderRegistry(reader),
      {},
    );
    expect(missingDefinitions).toEqual({
      ok: false,
      error: { kind: "saved_filter_not_available" },
    });

    const notFound = await executeApiV1SiteOverview(
      { ...body, filter: { type: "saved", id: "filter-1" } },
      principal({ scopes: ["analytics:read", "analysis:read"] }),
      "site-1",
      createTestProviderRegistry(reader),
      {},
      { resolveTeamVisibleSavedFilter: vi.fn().mockResolvedValue(null) },
    );
    expect(notFound).toEqual({ ok: false, error: { kind: "site_not_found" } });

    const cancelledLookup = await executeApiV1SiteOverview(
      { ...body, filter: { type: "saved", id: "filter-1" } },
      principal({ scopes: ["analytics:read", "analysis:read"] }),
      "site-1",
      createTestProviderRegistry(reader),
      {},
      {
        resolveTeamVisibleSavedFilter: vi
          .fn()
          .mockRejectedValue(new Error("definition failed")),
      },
    );
    expect(cancelledLookup).toEqual({
      ok: false,
      error: { kind: "internal_error" },
    });

    for (const error of [
      new AnalysisDefinitionReadCancelledError(),
      new AnalysisDefinitionIntegrityError(),
    ]) {
      const failedLookup = await executeApiV1SiteOverview(
        { ...body, filter: { type: "saved", id: "filter-1" } },
        principal({ scopes: ["analytics:read", "analysis:read"] }),
        "site-1",
        createTestProviderRegistry(reader),
        {},
        { resolveTeamVisibleSavedFilter: vi.fn().mockRejectedValue(error) },
      );
      expect(failedLookup.ok).toBe(false);
    }
  });
});
