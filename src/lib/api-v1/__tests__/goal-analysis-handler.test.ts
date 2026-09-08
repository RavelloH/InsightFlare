import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTestProviderRegistry } from "@/lib/api-v1/__tests__/provider-registry";
import { AnalysisDefinitionReadCancelledError } from "@/lib/api-v1/analysis-definition-reader";
import {
  handlePlannedSiteGoalSummary,
  handlePlannedSiteGoalTimeseries,
} from "@/lib/api-v1/goal-analysis-handler";
import { goalAggregateCache } from "@/lib/api-v1/goal-analysis-handler";
import { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
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

const body = {
  goalId: "goal-1",
  timeRange: {
    kind: "absolute" as const,
    from: "2026-08-01T00:00:00.000Z",
    to: "2026-08-02T00:00:00.000Z",
    timeZone: "UTC",
  },
};

function request(
  input: unknown,
  method = "POST",
  headers: HeadersInit = { "content-type": "application/json" },
  rawBody?: string,
): Request {
  return new Request("https://app.test/api/v1/sites/site-1/analytics/goals", {
    method,
    headers,
    ...(method === "GET" || method === "HEAD"
      ? {}
      : { body: rawBody ?? JSON.stringify(input) }),
  });
}

function goalRow(filterDsl = 'event.name eq "purchase"', name = "Purchase") {
  return {
    id: "goal-1",
    site_id: "site-1",
    name,
    config_json: JSON.stringify({ filterDslVersion: 1, filterDsl }),
    config_version: 1,
    created_at: 1,
    updated_at: 2,
  };
}

function envWithGoal(row: Record<string, unknown> | null) {
  return {
    DB: {
      prepare: vi.fn((sql: string) => ({
        bind: (..._bindings: unknown[]) => ({
          all: async <T extends object>() => ({
            results:
              row && sql.includes("analysis_definitions") ? [row as T] : [],
          }),
        }),
      })),
    },
  } as never;
}

describe("typed Goal analytics HTTP adapter", () => {
  beforeEach(() => goalAggregateCache.clear());

  it("validates the persisted Goal, caches by semantic identity, and keeps timeseries interval in the key", async () => {
    const env = envWithGoal(goalRow());
    const reader = vi.fn(async (input: Record<string, unknown>) => {
      const goal = {
        ...goalRow(),
        semanticFingerprint: "goal-v1-purchase",
      };
      if (input.interval) {
        return {
          goal,
          interval: input.interval,
          timeseries: [],
        };
      }
      return {
        goal,
        summary: {
          sessions: { total: 10, converted: 2, conversionRate: 0.2 },
          visitors: { total: 8, converted: 1, conversionRate: 0.125 },
        },
      };
    });
    const registry = createTestProviderRegistry(reader as never);

    await expect(
      handlePlannedSiteGoalSummary(
        env,
        request(body),
        principal(),
        "site-1",
        registry,
        undefined,
        { capturedAtMs: Date.parse(body.timeRange.to) },
      ),
    ).resolves.toHaveProperty("status", 200);
    await expect(
      handlePlannedSiteGoalSummary(
        env,
        request(body),
        principal(),
        "site-1",
        registry,
        undefined,
        { capturedAtMs: Date.parse(body.timeRange.to) },
      ),
    ).resolves.toHaveProperty("status", 200);
    expect(reader).toHaveBeenCalledTimes(1);

    await expect(
      handlePlannedSiteGoalTimeseries(
        env,
        request({ ...body, interval: "day" }),
        principal(),
        "site-1",
        registry,
        undefined,
        { capturedAtMs: Date.parse(body.timeRange.to) },
      ),
    ).resolves.toHaveProperty("status", 200);
    expect(reader).toHaveBeenCalledTimes(2);

    await expect(
      handlePlannedSiteGoalSummary(
        env,
        request(body),
        principal({ scopes: [] }),
        "site-1",
        registry,
      ),
    ).resolves.toHaveProperty("status", 403);
  });

  it("returns 404 for an unknown Goal before invoking analytics", async () => {
    const reader = vi.fn();
    const response = await handlePlannedSiteGoalSummary(
      envWithGoal(null),
      request(body),
      principal(),
      "site-1",
      createTestProviderRegistry(reader as never),
    );
    expect(response.status).toBe(404);
    expect(reader).not.toHaveBeenCalled();
  });

  it("handles HTTP negotiation, body, scope, and time-range validation", async () => {
    const env = envWithGoal(goalRow());
    const registry = createTestProviderRegistry(vi.fn() as never);
    const cases: Array<[Request, ApiKeyPrincipal, number]> = [
      [request(body, "GET"), principal(), 405],
      [
        request(body, "POST", {
          "content-type": "application/json",
          "content-encoding": "gzip",
        }),
        principal(),
        415,
      ],
      [
        request(body, "POST", { "content-type": "text/plain" }),
        principal(),
        415,
      ],
      [
        request(body, "POST", {
          "content-type": "application/json",
          accept: "text/html",
        }),
        principal(),
        406,
      ],
      [request(body), principal({ scopes: [] }), 403],
      [request(body), principal({ siteIds: ["other-site"] }), 404],
      [
        request(
          body,
          "POST",
          { "content-type": "application/json" },
          "not-json",
        ),
        principal(),
        422,
      ],
      [request({}, "POST"), principal(), 400],
      [
        request({
          ...body,
          timeRange: { ...body.timeRange, from: body.timeRange.to },
        }),
        principal(),
        400,
      ],
    ];

    for (const [input, key, status] of cases) {
      await expect(
        handlePlannedSiteGoalSummary(env, input, key, "site-1", registry),
      ).resolves.toHaveProperty("status", status);
    }
  });

  it("resolves saved filters and reports their lookup failures", async () => {
    const env = envWithGoal(goalRow());
    const saved = {
      resolveTeamVisibleSavedFilter: vi.fn(),
    };
    const reader = vi.fn(async () => ({ goal: goalRow(), summary: {} }));
    const registry = createTestProviderRegistry(reader as never);
    const savedBody = {
      ...body,
      filter: { type: "saved" as const, id: "saved-1" },
    };

    saved.resolveTeamVisibleSavedFilter.mockResolvedValue(null);
    await expect(
      handlePlannedSiteGoalSummary(
        env,
        request(savedBody),
        principal({ scopes: ["analytics:read", "analysis:read"] }),
        "site-1",
        registry,
        saved,
      ),
    ).resolves.toHaveProperty("status", 404);

    saved.resolveTeamVisibleSavedFilter.mockRejectedValue(
      new AnalysisDefinitionReadCancelledError(),
    );
    await expect(
      handlePlannedSiteGoalSummary(
        env,
        request(savedBody),
        principal({ scopes: ["analytics:read", "analysis:read"] }),
        "site-1",
        registry,
        saved,
      ),
    ).resolves.toHaveProperty("status", 499);

    saved.resolveTeamVisibleSavedFilter.mockRejectedValue(new Error("db"));
    await expect(
      handlePlannedSiteGoalSummary(
        env,
        request(savedBody),
        principal({ scopes: ["analytics:read", "analysis:read"] }),
        "site-1",
        registry,
        saved,
      ),
    ).resolves.toHaveProperty("status", 500);

    await expect(
      handlePlannedSiteGoalSummary(
        env,
        request(savedBody),
        principal({ scopes: ["analytics:read", "analysis:read"] }),
        "site-1",
        registry,
      ),
    ).resolves.toHaveProperty("status", 404);

    saved.resolveTeamVisibleSavedFilter.mockResolvedValue({
      document: { version: 1, root: null },
      fingerprint: "saved-filter-v1:test",
      scopePreference: "auto",
    });
    await expect(
      handlePlannedSiteGoalSummary(
        env,
        request(savedBody),
        principal({ scopes: ["analytics:read", "analysis:read"] }),
        "site-1",
        registry,
        saved,
      ),
    ).resolves.toHaveProperty("status", 200);

    saved.resolveTeamVisibleSavedFilter.mockResolvedValue({
      document: { version: 1, root: null },
      fingerprint: "saved-filter-v1:session",
      scopePreference: "session",
    });
    await expect(
      handlePlannedSiteGoalSummary(
        env,
        request({ ...savedBody, scope: "visitor" }),
        principal({ scopes: ["analytics:read", "analysis:read"] }),
        "site-1",
        registry,
        saved,
      ),
    ).resolves.toHaveProperty("status", 400);

    await expect(
      handlePlannedSiteGoalSummary(
        env,
        request(savedBody),
        principal(),
        "site-1",
        registry,
      ),
    ).resolves.toHaveProperty("status", 403);

    const inline = {
      ...body,
      filter: {
        type: "inline" as const,
        expression: {
          kind: "condition" as const,
          target: { kind: "field" as const, field: "page.path" },
          operator: "eq",
          value: "/checkout",
        },
      },
    };
    await expect(
      handlePlannedSiteGoalSummary(
        env,
        request(inline),
        principal(),
        "site-1",
        registry,
      ),
    ).resolves.toHaveProperty("status", 200);

    await expect(
      handlePlannedSiteGoalSummary(
        env,
        request({
          ...body,
          filter: { type: "dsl", expression: "not valid" },
        }),
        principal(),
        "site-1",
        registry,
      ),
    ).resolves.toHaveProperty("status", 400);

    await expect(
      handlePlannedSiteGoalSummary(
        env,
        request({
          ...body,
          filter: {
            type: "inline",
            expression: {
              kind: "condition",
              target: { kind: "field", field: "not-a-real-field" },
              operator: "eq",
              value: "x",
            },
          },
        }),
        principal(),
        "site-1",
        registry,
      ),
    ).resolves.toHaveProperty("status", 400);
  });

  it("maps query cost, cancellation, provider, and missing-result outcomes", async () => {
    const env = envWithGoal(goalRow());
    const goalReader = vi.fn(async () => ({ goal: goalRow(), summary: {} }));
    const registry = createTestProviderRegistry(goalReader as never);

    await expect(
      handlePlannedSiteGoalTimeseries(
        env,
        request({
          ...body,
          interval: "minute",
          timeRange: {
            kind: "absolute",
            from: "2020-01-01T00:00:00.000Z",
            to: "2026-01-01T00:00:00.000Z",
            timeZone: "UTC",
          },
        }),
        principal(),
        "site-1",
        registry,
      ),
    ).resolves.toHaveProperty("status", 422);

    await expect(
      handlePlannedSiteGoalSummary(
        env,
        request(body),
        principal(),
        "site-1",
        registry,
        undefined,
        { deadlineMs: 0 },
      ),
    ).resolves.toHaveProperty("status", 504);

    const controller = new AbortController();
    controller.abort();
    await expect(
      handlePlannedSiteGoalSummary(
        env,
        request(body),
        principal(),
        "site-1",
        registry,
        undefined,
        { signal: controller.signal },
      ),
    ).resolves.toHaveProperty("status", 499);

    await expect(
      handlePlannedSiteGoalSummary(
        env,
        request(body),
        principal(),
        "site-1",
        new AnalyticsProviderRegistry(),
      ),
    ).resolves.toHaveProperty("status", 422);

    const throwing = new AnalyticsProviderRegistry().register("goal-summary", {
      execute: vi.fn(async () => {
        throw new Error("provider failed");
      }),
    });
    await expect(
      handlePlannedSiteGoalSummary(
        env,
        request(body),
        principal(),
        "site-1",
        throwing,
      ),
    ).resolves.toHaveProperty("status", 503);

    const nullReader = createTestProviderRegistry(
      vi.fn(async () => null) as never,
    );
    await expect(
      handlePlannedSiteGoalSummary(
        env,
        request(body),
        principal(),
        "site-1",
        nullReader,
      ),
    ).resolves.toHaveProperty("status", 404);

    const failingEnv = {
      DB: {
        prepare: vi.fn(() => {
          throw new Error("db");
        }),
      },
    } as never;
    await expect(
      handlePlannedSiteGoalSummary(
        failingEnv,
        request(body),
        principal(),
        "site-1",
        registry,
      ),
    ).resolves.toHaveProperty("status", 503);
  });
});
