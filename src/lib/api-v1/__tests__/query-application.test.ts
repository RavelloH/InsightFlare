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
import { InvalidCursorError } from "@/lib/pagination";

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

    await expect(
      executeApiV1Query(undefined, invocation(registry, null as never), {}),
    ).resolves.toEqual({
      ok: false,
      error: {
        kind: "operation-not-allowed",
        operation: "site.analytics.overview",
      },
    });

    await expect(
      executeApiV1Query(
        undefined,
        invocation(registry, {
          window: { startMs: 2_000, endExclusiveMs: 1_000, timeZone: "UTC" },
        }),
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

  it("uses the original request view when creating the pagination binding", async () => {
    let receivedQuery: Record<string, unknown> | undefined;
    const registry = new AnalyticsProviderRegistry().register(
      canonicalQueryOperationFor("site.analytics.overview"),
      {
        execute: async (query) => {
          receivedQuery = query as unknown as Record<string, unknown>;
          return { value: { views: 1 } };
        },
      },
    );

    await expect(
      executeApiV1Query(
        undefined,
        {
          ...invocation(registry),
          rawRequest: "original-request",
        },
        {},
      ),
    ).resolves.toMatchObject({ ok: true, value: { views: 1 } });
    expect(
      (receivedQuery?.time as { paginationBinding?: unknown })
        ?.paginationBinding,
    ).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("does not bind API v1 cursors to the requested page size", async () => {
    const bindings: string[] = [];
    const registry = new AnalyticsProviderRegistry().register(
      canonicalQueryOperationFor("site.analytics.overview"),
      {
        execute: async (query) => {
          const binding = (
            query as unknown as { time: { paginationBinding: string } }
          ).time.paginationBinding;
          bindings.push(binding);
          return { value: { views: 1 } };
        },
      },
    );
    const query = {
      context,
      time,
      filters: EMPTY_FILTER_DOCUMENT,
    };

    await executeApiV1Query(
      undefined,
      {
        ...invocation(registry, query),
        rawRequest: { page: { limit: 10, cursor: null }, search: "docs" },
      },
      {},
    );
    await executeApiV1Query(
      undefined,
      {
        ...invocation(registry, query),
        rawRequest: {
          page: { limit: 100, cursor: "previous-page-cursor" },
          search: "docs",
        },
      },
      {},
    );

    expect(bindings).toHaveLength(2);
    expect(bindings[0]).toBe(bindings[1]);
  });

  it("translates provider cursor failures to the typed API v1 error", async () => {
    const registry = new AnalyticsProviderRegistry().register(
      canonicalQueryOperationFor("site.analytics.overview"),
      {
        execute: async () => {
          throw new InvalidCursorError("pages");
        },
      },
    );

    await expect(
      executeApiV1Query(undefined, invocation(registry), {}),
    ).resolves.toEqual({
      ok: false,
      error: { kind: "invalid-cursor", cursorKind: "pages" },
    });
  });

  it("normalizes Error and non-Error provider failures", async () => {
    for (const thrown of [new Error("provider-failed"), "provider-failed"]) {
      const registry = new AnalyticsProviderRegistry().register(
        canonicalQueryOperationFor("site.analytics.overview"),
        {
          execute: async () => {
            throw thrown;
          },
        },
      );

      await expect(
        executeApiV1Query(undefined, invocation(registry), {}),
      ).rejects.toThrow(
        thrown instanceof Error ? "provider-failed" : "data-unavailable",
      );
    }
  });
});
