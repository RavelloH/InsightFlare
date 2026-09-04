import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiKeyPrincipal } from "@/lib/edge/api-key-auth";
import type { Env } from "@/lib/edge/types";

const mocks = vi.hoisted(() => ({
  createComparisonProviders: vi.fn(),
  listTeamSites: vi.fn(),
}));
const providerCalls = { overview: 0, trend: 0, breakdown: 0 };

vi.mock("@/lib/edge/analytics/providers/d1/comparison", () => ({
  createComparisonProviders: mocks.createComparisonProviders,
}));
vi.mock("@/lib/edge/analytics/providers/d1/internal/team", () => ({
  listTeamSites: mocks.listTeamSites,
}));

import {
  handleSiteComparison,
  handleSiteComparisonBreakdown,
  handleTeamComparison,
  handleTeamComparisonBreakdown,
} from "@/lib/api-v1/comparison-handler";

const env = {} as Env;
const principal: ApiKeyPrincipal = {
  keyId: "key-1",
  teamId: "team-1",
  prefix: "prefix",
  scopes: ["analytics:read"],
  siteIds: ["site-1"],
  status: "active",
};

const baseBody = {
  version: 2,
  timeZone: "UTC",
  current: {
    timeRange: {
      kind: "absolute",
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-03T00:00:00.000Z",
    },
    filter: null,
  },
  reference: { timeRange: { kind: "previous_period" }, filter: null },
  select: {
    metrics: ["views", "sessions", "events"],
    trend: { interval: "day", metrics: ["views"] },
  },
};

function rawMetrics(seed: number) {
  return {
    views: seed,
    sessions: seed / 2,
    visitors: seed / 3,
    bounces: seed / 10,
    totalDurationMs: seed * 100,
    durationViews: seed / 2,
    events: seed * 2,
  };
}

function request(body: unknown, init: RequestInit = {}) {
  const { headers: initHeaders, ...rest } = init;
  return new Request("https://example.test/api/v1/comparison", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(initHeaders ?? {}),
    },
    body: JSON.stringify(body),
    ...rest,
  });
}

function configureProviders() {
  mocks.createComparisonProviders.mockImplementation(() => ({
    overview: vi.fn(async ({ side, query }) => {
      providerCalls.overview += 1;
      return {
        ok: true as const,
        data: rawMetrics(side === "current" ? 120 : 100),
        meta: {
          time: query.time,
          source: "raw" as const,
          approximateVisitors: false,
        },
      };
    }),
    trend: vi.fn(async ({ side, query, comparison }) => {
      providerCalls.trend += 1;
      return {
        ok: true as const,
        data: {
          interval: comparison.interval,
          points: [
            {
              bucket: 0,
              timestampMs: query.time.range.startMs,
              fromMs: query.time.range.startMs,
              toMs: query.time.range.endExclusiveMs,
              ...rawMetrics(side === "current" ? 60 : 50),
            },
          ],
        },
        meta: {
          time: query.time,
          source: "raw" as const,
          approximateVisitors: false,
        },
      };
    }),
    breakdown: vi.fn(async ({ side, query }) => {
      providerCalls.breakdown += 1;
      return {
        ok: true as const,
        data: {
          complete: true,
          items: [
            {
              key: "/pricing",
              label: "/pricing",
              ...rawMetrics(side === "current" ? 60 : 40),
            },
            ...(side === "current"
              ? [{ key: "/new", label: "/new", ...rawMetrics(20) }]
              : []),
          ],
        },
        meta: {
          time: query.time,
          source: "raw" as const,
          approximateVisitors: false,
        },
      };
    }),
  }));
}

async function json(response: Response) {
  return (await response.json()) as {
    readonly data?: Record<string, unknown>;
    readonly error?: { readonly code: string };
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  providerCalls.overview = 0;
  providerCalls.trend = 0;
  providerCalls.breakdown = 0;
  configureProviders();
  mocks.listTeamSites.mockResolvedValue([{ id: "site-1" }, { id: "site-2" }]);
});

describe("API v1 comparison v2 handler", () => {
  it("enforces the JSON POST protocol and strict request schema", async () => {
    const getResponse = await handleSiteComparison(
      new Request("https://example.test", { method: "GET" }),
      principal,
      env,
      "site-1",
    );
    expect(getResponse.status).toBe(405);

    const mediaResponse = await handleSiteComparison(
      request(baseBody, { headers: { "content-type": "text/plain" } }),
      principal,
      env,
      "site-1",
    );
    expect(mediaResponse.status).toBe(415);

    const encodedResponse = await handleSiteComparison(
      request(baseBody, { headers: { "content-encoding": "gzip" } }),
      principal,
      env,
      "site-1",
    );
    expect(encodedResponse.status).toBe(415);

    const acceptResponse = await handleSiteComparison(
      request(baseBody, { headers: { accept: "text/html" } }),
      principal,
      env,
      "site-1",
    );
    expect(acceptResponse.status).toBe(406);

    const invalidResponse = await handleSiteComparison(
      request({ ...baseBody, legacy: true }),
      principal,
      env,
      "site-1",
    );
    expect(invalidResponse.status).toBe(400);
    expect((await json(invalidResponse)).error?.code).toBe("validation_failed");
  });

  it("executes a site report, returns trend boundaries, and reuses the cache", async () => {
    const first = await handleSiteComparison(
      request(baseBody),
      principal,
      env,
      "site-1",
    );
    expect(first.status).toBe(200);
    const firstBody = await json(first);
    expect(firstBody.data?.current).toMatchObject({ metrics: { views: 120 } });
    expect(firstBody.data?.trend).toBeDefined();

    const second = await handleSiteComparison(
      request(baseBody),
      principal,
      env,
      "site-1",
    );
    expect(second.status).toBe(200);
    expect(providerCalls.overview).toBe(2);
    expect(providerCalls.trend).toBe(2);

    mocks.createComparisonProviders.mockImplementationOnce(() => ({
      overview: vi.fn(async ({ query }) => ({
        ok: true as const,
        data: rawMetrics(100),
        meta: {
          time: query.time,
          source: "raw" as const,
          approximateVisitors: false,
        },
      })),
      trend: vi.fn(async ({ query }) => ({
        ok: false as const,
        error: { kind: "comparison-alignment-mismatch" as const },
        meta: {
          time: query.time,
          source: "raw" as const,
          approximateVisitors: false,
        },
      })),
      breakdown: vi.fn(),
    }));
    const trendError = await handleSiteComparison(
      request({
        ...baseBody,
        select: {
          ...baseBody.select,
          trend: { interval: "day", metrics: ["sessions"] },
        },
      }),
      principal,
      env,
      "site-1",
    );
    expect((await json(trendError)).error?.code).toBe(
      "comparison_alignment_mismatch",
    );
  });

  it("executes team reports with the authorized site count and exact breakdowns", async () => {
    const teamResponse = await handleTeamComparison(
      request(baseBody),
      principal,
      env,
    );
    expect(teamResponse.status).toBe(200);
    expect(mocks.listTeamSites).toHaveBeenCalledWith(env, "team-1");

    const breakdownResponse = await handleSiteComparisonBreakdown(
      request({
        ...baseBody,
        select: undefined,
        limit: 20,
        sort: { by: "change.views.absolute", direction: "desc" },
      }),
      principal,
      env,
      "site-1",
      "page.path",
    );
    expect(breakdownResponse.status).toBe(200);
    const breakdown = await json(breakdownResponse);
    expect(breakdown.data?.coverage).toMatchObject({
      complete: true,
      strategy: "full_comparison_aggregate",
    });

    const teamBreakdownResponse = await handleTeamComparisonBreakdown(
      request({
        ...baseBody,
        select: undefined,
        limit: 20,
        sort: { by: "key", direction: "asc" },
      }),
      principal,
      env,
      "page.path",
    );
    expect(teamBreakdownResponse.status).toBe(200);

    mocks.createComparisonProviders.mockImplementationOnce(() => ({
      overview: vi.fn(),
      trend: vi.fn(),
      breakdown: vi.fn(async () => ({
        ok: false as const,
        error: { kind: "query-cost-exceeded" as const, cost: 10_000 },
      })),
    }));
    const breakdownError = await handleSiteComparisonBreakdown(
      request({
        ...baseBody,
        select: undefined,
        limit: 20,
        sort: { by: "key", direction: "asc" },
      }),
      principal,
      env,
      "site-1",
      "page.title",
    );
    expect((await json(breakdownError)).error?.code).toBe(
      "query_too_expensive",
    );

    const unsupported = await handleSiteComparisonBreakdown(
      request({
        ...baseBody,
        select: undefined,
        limit: 20,
        sort: { by: "key", direction: "asc" },
      }),
      principal,
      env,
      "site-1",
      "not-a-dimension",
    );
    expect(unsupported.status).toBe(422);
    expect((await json(unsupported)).error?.code).toBe(
      "dimension_not_supported",
    );
  });

  it("rejects oversized and misaligned comparisons before querying", async () => {
    const invalidRange = await handleSiteComparison(
      request({
        ...baseBody,
        current: {
          ...baseBody.current,
          timeRange: {
            kind: "absolute",
            from: "2026-08-01T00:00:00.000Z",
            to: "2026-08-01T00:00:00.000Z",
          },
        },
      }),
      principal,
      env,
      "site-1",
    );
    expect(invalidRange.status).toBe(400);
    expect((await json(invalidRange)).error?.code).toBe("validation_failed");

    const oversized = await handleSiteComparison(
      request({
        ...baseBody,
        current: {
          ...baseBody.current,
          timeRange: {
            kind: "absolute",
            from: "2020-01-01T00:00:00.000Z",
            to: "2022-01-01T00:00:00.000Z",
          },
        },
      }),
      principal,
      env,
      "site-1",
    );
    expect(oversized.status).toBe(422);
    expect((await json(oversized)).error?.code).toBe("range_too_wide");

    const mismatched = await handleSiteComparison(
      request({
        ...baseBody,
        reference: {
          timeRange: {
            kind: "absolute",
            from: "2026-07-31T00:00:00.000Z",
            to: "2026-08-01T00:00:00.000Z",
          },
          filter: null,
        },
      }),
      principal,
      env,
      "site-1",
    );
    expect(mismatched.status).toBe(422);
    expect((await json(mismatched)).error?.code).toBe(
      "comparison_alignment_mismatch",
    );
  });

  it("maps authorization, timezone, and provider domain errors", async () => {
    const inactive = await handleSiteComparison(
      request(baseBody),
      { ...principal, status: "revoked" },
      env,
      "site-1",
    );
    expect(inactive.status).toBe(403);

    const inaccessible = await handleSiteComparison(
      request(baseBody),
      { ...principal, siteIds: ["site-2"] },
      env,
      "site-1",
    );
    expect(inaccessible.status).toBe(404);

    const invalidTimezone = await handleSiteComparison(
      request({ ...baseBody, timeZone: "Not/AZone" }),
      principal,
      env,
      "site-1",
    );
    expect(invalidTimezone.status).toBe(400);

    mocks.createComparisonProviders.mockImplementationOnce(() => ({
      overview: vi.fn(async () => ({
        ok: false as const,
        error: { kind: "comparison-alignment-mismatch" as const },
      })),
      trend: vi.fn(),
      breakdown: vi.fn(),
    }));
    const domainError = await handleSiteComparison(
      request({ ...baseBody, select: { metrics: ["views"] } }),
      principal,
      env,
      "site-1",
    );
    expect(domainError.status).toBe(422);
    expect((await json(domainError)).error?.code).toBe(
      "comparison_alignment_mismatch",
    );

    const domainCases = [
      ["range-not-supported", "range_too_wide"],
      ["dimension-not-supported", "dimension_not_supported"],
      ["capability-denied", "dimension_not_supported"],
      ["invalid-input", "validation_failed"],
      ["data-unavailable", "data_unavailable"],
      ["query-cost-exceeded", "query_too_expensive"],
      ["request-cancelled", "request_cancelled"],
      ["deadline-exceeded", "deadline_exceeded"],
      ["unexpected", "internal_error"],
    ] as const;
    for (const [kind, expected] of domainCases) {
      mocks.createComparisonProviders.mockImplementationOnce(() => ({
        overview: vi.fn(async () => ({
          ok: false as const,
          error: { kind } as { readonly kind: string },
        })),
        trend: vi.fn(),
        breakdown: vi.fn(),
      }));
      const response = await handleSiteComparison(
        request({
          ...baseBody,
          select: { metrics: ["views", "sessions"] },
        }),
        principal,
        env,
        "site-1",
      );
      expect((await json(response)).error?.code).toBe(expected);
    }

    const conflictDefinitions = {
      resolveTeamVisibleSavedFilter: vi.fn().mockResolvedValue({
        document: { version: 1, root: null },
        fingerprint: "saved-filter-v1:scope-conflict",
        scopePreference: "session",
      }),
    };
    const scopeConflict = await handleSiteComparison(
      request({
        ...baseBody,
        scope: "visitor",
        current: {
          ...baseBody.current,
          filter: { type: "saved", id: "scope-conflict" },
        },
        select: { metrics: ["views", "sessions"] },
      }),
      { ...principal, scopes: ["analytics:read", "analysis:read"] },
      env,
      "site-1",
      conflictDefinitions,
    );
    expect((await json(scopeConflict)).error?.code).toBe("conflict");

    const breakdownScopeConflict = await handleSiteComparisonBreakdown(
      request({
        ...baseBody,
        select: undefined,
        scope: "visitor",
        current: {
          ...baseBody.current,
          filter: { type: "saved", id: "scope-conflict" },
        },
        limit: 20,
      }),
      { ...principal, scopes: ["analytics:read", "analysis:read"] },
      env,
      "site-1",
      "page.path",
      conflictDefinitions,
    );
    expect((await json(breakdownScopeConflict)).error?.code).toBe("conflict");
  });

  it("rejects unavailable saved filters and invalid team inputs", async () => {
    const savedBody = {
      ...baseBody,
      current: {
        ...baseBody.current,
        filter: { type: "saved", id: "saved-1" },
      },
    };
    const missingAnalysisScope = await handleSiteComparison(
      request(savedBody),
      principal,
      env,
      "site-1",
    );
    expect(missingAnalysisScope.status).toBe(403);

    const unavailableSavedFilter = await handleSiteComparison(
      request(savedBody),
      { ...principal, scopes: ["analytics:read", "analysis:read"] },
      env,
      "site-1",
    );
    expect(unavailableSavedFilter.status).toBe(404);

    const invalidFilter = await handleSiteComparison(
      request({
        ...baseBody,
        current: {
          ...baseBody.current,
          filter: {
            type: "inline",
            expression: {
              kind: "condition",
              target: { kind: "field", field: "page.path" },
              operator: "not-a-real-operator",
              value: "value",
            },
          },
        },
      }),
      principal,
      env,
      "site-1",
    );
    expect(invalidFilter.status).toBe(400);

    const invalidTeam = await handleTeamComparison(
      request({ ...baseBody, timeZone: "Not/AZone" }),
      principal,
      env,
    );
    expect(invalidTeam.status).toBe(400);

    const invalidTeamFilter = await handleTeamComparison(
      request({
        ...baseBody,
        current: {
          ...baseBody.current,
          filter: {
            type: "inline",
            expression: {
              kind: "condition",
              target: { kind: "field", field: "page.path" },
              operator: "not-a-real-operator",
              value: "value",
            },
          },
        },
      }),
      principal,
      env,
    );
    expect(invalidTeamFilter.status).toBe(400);

    const filteredTeam = await handleTeamComparison(
      request({
        ...baseBody,
        current: {
          ...baseBody.current,
          filter: {
            type: "inline",
            expression: {
              kind: "condition",
              target: { kind: "field", field: "page.path" },
              operator: "eq",
              value: "/",
            },
          },
        },
      }),
      principal,
      env,
    );
    expect(filteredTeam.status).toBe(200);

    const dslTeam = await handleTeamComparison(
      request({
        ...baseBody,
        current: {
          ...baseBody.current,
          filter: { type: "dsl", expression: 'geo.country eq "US"' },
        },
      }),
      principal,
      env,
    );
    expect(dslTeam.status).toBe(200);

    const tooManyBuckets = await handleSiteComparison(
      request({
        ...baseBody,
        select: {
          metrics: ["views"],
          trend: { interval: "minute", metrics: ["views"] },
        },
      }),
      principal,
      env,
      "site-1",
    );
    expect((await json(tooManyBuckets)).error?.code).toBe("too_many_buckets");

    const malformed = await handleSiteComparison(
      new Request("https://example.test/api/v1/comparison", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
      principal,
      env,
      "site-1",
    );
    expect((await json(malformed)).error?.code).toBe("validation_failed");

    const invalidSiteBreakdown = await handleSiteComparisonBreakdown(
      request({}),
      principal,
      env,
      "site-1",
      "page.path",
    );
    expect((await json(invalidSiteBreakdown)).error?.code).toBe(
      "validation_failed",
    );

    const invalidTeamBreakdown = await handleTeamComparisonBreakdown(
      request({}),
      principal,
      env,
      "page.path",
    );
    expect((await json(invalidTeamBreakdown)).error?.code).toBe(
      "validation_failed",
    );
  });
});
