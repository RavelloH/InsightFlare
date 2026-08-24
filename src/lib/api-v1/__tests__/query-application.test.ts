import { describe, expect, it } from "vitest";

import { executeApiV1Query } from "@/lib/api-v1/query-application";
import { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import { canonicalQueryOperationFor } from "@/lib/edge/analytics/application/query-operation-map";
import {
  createQueryTime,
  EMPTY_FILTER_DOCUMENT,
  type QueryOperation,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";

const context = siteQueryContext("site-1", "api-v1");
const time = createQueryTime(1_000, 2_000, "UTC", 2_000);

function invocation(
  providerRegistry: AnalyticsProviderRegistry,
  query: Record<string, unknown> = {
    context,
    time,
    filters: EMPTY_FILTER_DOCUMENT,
  },
) {
  return {
    operation: "site.analytics.overview" as const,
    context,
    query,
    providerRegistry,
  };
}

describe("API v1 query application adapter", () => {
  it("fails closed when the external provider is missing", async () => {
    await expect(
      executeApiV1Query(
        undefined,
        invocation(new AnalyticsProviderRegistry()),
        {},
      ),
    ).resolves.toEqual({
      ok: false,
      error: {
        kind: "operation-not-allowed",
        operation: "site.analytics.overview",
      },
    });
  });

  it("requires a legacy query to expose a canonical time", async () => {
    const registry = new AnalyticsProviderRegistry().register(
      canonicalQueryOperationFor("site.analytics.overview"),
      { execute: async () => ({ value: { views: 1 } }) },
    );

    await expect(
      executeApiV1Query(undefined, invocation(registry, { context }), {}),
    ).resolves.toEqual({
      ok: false,
      error: {
        kind: "operation-not-allowed",
        operation: "site.analytics.overview",
      },
    });
  });

  it("translates canonical cost failures back to the API v1 error shape", async () => {
    const registry = new AnalyticsProviderRegistry().register(
      canonicalQueryOperationFor("site.analytics.overview"),
      { execute: async () => ({ value: { views: 1 } }) },
    );

    await expect(
      executeApiV1Query(undefined, invocation(registry), {
        cost: { rangeMs: Number.POSITIVE_INFINITY, provider: "d1" },
      }),
    ).resolves.toEqual({
      ok: false,
      error: { kind: "query-cost-exceeded", cost: 10_000 },
    });
  });

  it("translates canonical policy failures back to the external operation", async () => {
    const registry = new AnalyticsProviderRegistry().register(
      canonicalQueryOperationFor("site.analytics.overview"),
      { execute: async () => ({ value: { views: 1 } }) },
    );
    const deniedContext = {
      ...context,
      policy: {
        ...context.policy,
        allowedOperations: new Set<QueryOperation>(),
      },
    };

    await expect(
      executeApiV1Query(
        undefined,
        {
          ...invocation(registry),
          context: deniedContext,
          query: { context: deniedContext, time },
        },
        {},
      ),
    ).resolves.toEqual({
      ok: false,
      error: {
        kind: "operation-not-allowed",
        operation: "site.analytics.overview",
      },
    });
  });
});
