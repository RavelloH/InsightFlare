import { describe, expect, it } from "vitest";

import {
  type ApiV1WireResult,
  createApiV1AnalyticsResultAdapter,
  executeApiV1Query,
} from "@/lib/api-v1/analytics/query-application";
import type { AnalyticsFilterValuesData } from "@/lib/api-v1/contract/wire";
import { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import type { ApiV1CanonicalResult } from "@/lib/edge/analytics/application/query-operation-map";
import { canonicalQueryOperationFor } from "@/lib/edge/analytics/application/query-operation-map";
import { createAnalyticsQueryRuntime } from "@/lib/edge/analytics/composition/query-runtime";
import {
  createQueryTime,
  EMPTY_FILTER_DOCUMENT,
  type QueryOperation,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { InvalidCursorError } from "@/lib/pagination";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;
type Assert<Value extends true> = Value;

type _FilterValuesWireResultUsesFlattenedResponseShape = Assert<
  Equal<
    ApiV1WireResult<"site.analytics.filterValues">,
    AnalyticsFilterValuesData
  >
>;
type _FilterValuesWireResultDoesNotExposeCanonicalDataWrapper = Assert<
  Equal<
    "data" extends keyof ApiV1WireResult<"site.analytics.filterValues">
      ? true
      : false,
    false
  >
>;
type _OverviewWireResultRemainsCanonical = Assert<
  Equal<
    ApiV1WireResult<"site.analytics.overview">,
    ApiV1CanonicalResult<"site.analytics.overview">
  >
>;

const context = siteQueryContext("site-1", "api-v1");
const time = createQueryTime(1_000, 2_000, "UTC", 2_000);
const overviewData = {
  current: {
    views: 1,
    sessions: 0,
    visitors: 0,
    bounces: 0,
    totalDurationMs: 0,
    durationViews: 0,
  },
};
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
    executor: createAnalyticsQueryRuntime(providerRegistry),
  };
}
describe("API v1 query application adapter", () => {
  it("requires runtime metadata when preserving the AnalyticsResult envelope", async () => {
    const adapter = createApiV1AnalyticsResultAdapter();
    const noMetadataExecutor = {
      execute: async () => ({ ok: true, data: overviewData }),
    } as never;

    await expect(
      adapter.execute(
        {
          ...invocation(new AnalyticsProviderRegistry()),
          executor: noMetadataExecutor,
        },
        {},
      ),
    ).rejects.toThrow("analytics_result_metadata_missing");
  });

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
      { execute: async () => ({ value: overviewData }) },
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
      { execute: async () => ({ value: overviewData }) },
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
      { execute: async () => ({ value: overviewData }) },
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
          return { value: overviewData };
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
    ).resolves.toMatchObject({ ok: true, value: { current: { views: 1 } } });
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
          return { value: overviewData };
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

  it("serializes canonical provider results at the API v1 boundary", async () => {
    const cases = [
      {
        operation: "site.analytics.breakdown",
        result: {
          items: [
            null,
            { key: "US", views: 4 },
            { key: "canonical", value: "ignored", views: 2 },
          ],
        },
        expected: {
          items: [
            null,
            { key: "US", views: 4 },
            { key: "canonical", views: 2 },
          ],
        },
      },
      {
        operation: "site.analytics.channels",
        result: {
          items: [
            { channel: "organic_search", views: 3, sessions: 2, visitors: 1 },
            { channel: "direct", views: 2 },
          ],
        },
        expected: {
          items: [
            { channel: "organic_search", views: 3, sessions: 2, visitors: 1 },
            { channel: "direct", views: 2 },
          ],
        },
      },
      {
        operation: "site.analytics.filterValues",
        result: {
          field: "country",
          data: {
            items: [{ value: "US", label: "US", occurrences: 4 }],
            pagination: {
              limit: 20,
              returned: 1,
              hasMore: false,
              nextCursor: null,
            },
          },
        },
        expected: {
          field: "country",
          items: [{ value: "US", label: "US", occurrences: 4 }],
          pagination: {
            limit: 20,
            returned: 1,
            hasMore: false,
            nextCursor: null,
          },
        },
      },
      {
        operation: "site.analytics.eventTypes",
        result: {
          items: [
            { key: "canonical", label: "label", events: 8, views: 5 },
            { label: "signup", views: 5, sessions: 3, visitors: 2 },
            {},
            null,
          ],
          pagination: {
            limit: 20,
            returned: 1,
            hasMore: false,
            nextCursor: null,
          },
        },
        expected: {
          items: [
            {
              key: "canonical",
              label: "label",
              events: 8,
            },
            {
              key: "signup",
              label: "signup",
              events: 5,
              sessions: 3,
              visitors: 2,
            },
            { key: "", events: 0 },
            null,
          ],
          pagination: {
            limit: 20,
            returned: 1,
            hasMore: false,
            nextCursor: null,
          },
        },
      },
      {
        operation: "site.analytics.retentionCohorts",
        result: {
          granularity: "day",
          cohorts: [
            "unknown",
            { bucket: 1_000, sessions: 2 },
            { bucket: "legacy", start: "2026-01-01T00:00:00.000Z" },
          ],
        },
        expected: {
          granularity: "day",
          cohorts: [
            "unknown",
            {
              sessions: 2,
              start: "1970-01-01T00:00:01.000Z",
            },
            { start: "2026-01-01T00:00:00.000Z" },
          ],
        },
      },
      {
        operation: "site.analytics.retentionCohorts",
        result: { granularity: "day" },
        expected: { granularity: "day", cohorts: [] },
      },
      {
        operation: "site.analytics.eventFields",
        result: {
          eventName: "signup",
          data: { items: [{ path: "user.plan" }], pagination: { limit: 20 } },
        },
        expected: {
          eventName: "signup",
          items: [{ path: "user.plan" }],
          pagination: { limit: 20 },
        },
      },
      {
        operation: "site.analytics.eventsTimeseries",
        result: {
          interval: "hour",
          series: [{ key: "signup", label: "Signup" }],
          data: [
            null,
            { timestampMs: 1_000, totalEvents: 3 },
            { timestamp: "legacy", totalEvents: 1 },
          ],
        },
        expected: {
          interval: "hour",
          series: [{ key: "signup", label: "Signup" }],
          points: [
            null,
            {
              totalEvents: 3,
              timestamp: "1970-01-01T00:00:01.000Z",
            },
            { timestamp: "legacy", totalEvents: 1 },
          ],
        },
      },
      {
        operation: "site.analytics.eventFieldValues",
        result: {
          eventName: "signup",
          fieldPath: "user.plan",
          fieldValueType: "string",
          data: { items: [{ value: "pro" }], pagination: { limit: 20 } },
        },
        expected: {
          eventName: "signup",
          fieldPath: "user.plan",
          fieldValueType: "string",
          items: [{ value: "pro" }],
          pagination: { limit: 20 },
        },
      },
      {
        operation: "site.analytics.eventTypeDetail",
        result: {
          trend: {
            interval: "day",
            data: [
              null,
              { timestampMs: 1_000, events: 3 },
              { timestamp: "legacy", events: 1 },
            ],
          },
        },
        expected: {
          trend: {
            interval: "day",
            data: [
              null,
              {
                events: 3,
                timestamp: "1970-01-01T00:00:01.000Z",
              },
              { timestamp: "legacy", events: 1 },
            ],
          },
        },
      },
      {
        operation: "site.analytics.eventTypeDetail",
        result: { trend: {} },
        expected: { trend: { data: [] } },
      },
      {
        operation: "site.analytics.eventTypeDetail",
        result: { trend: null },
        expected: { trend: null },
      },
      {
        operation: "site.analytics.funnelAnalysis",
        result: { funnel: null },
        expected: null,
      },
    ] as const;

    for (const entry of cases) {
      const registry = new AnalyticsProviderRegistry().register(
        canonicalQueryOperationFor(entry.operation),
        { execute: async () => ({ value: entry.result }) } as never,
      );
      const result = await executeApiV1Query(
        undefined,
        {
          operation: entry.operation,
          context,
          query: { context, time, filters: EMPTY_FILTER_DOCUMENT },
          executor: createAnalyticsQueryRuntime(registry),
        },
        {},
      );
      expect(result).toMatchObject({ ok: true, value: entry.expected });
    }
  });
});
