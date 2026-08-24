import { describe, expect, it, vi } from "vitest";

import { OperationResultCache } from "@/lib/edge/analytics/application/cache";
import { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import { TypedQueryApplicationService } from "@/lib/edge/analytics/application/service";
import { createQueryService } from "@/lib/edge/analytics/composition/create-query-service";
import {
  createQueryTime,
  EMPTY_FILTER_DOCUMENT,
  type OverviewQuery,
  type OverviewReader,
  type QueryContext,
  type QueryOperation,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";

const time = createQueryTime(1_000, 2_000, "UTC", 2_000);

function reader(): OverviewReader {
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

function overviewInvocation(
  overviewReader: OverviewReader,
  options: {
    readonly context?: QueryContext;
    readonly cache?: {
      readonly key: string;
      readonly policy: { readonly ttlMs: number; readonly maxEntries: number };
    };
  } = {},
) {
  const context =
    options.context ?? siteQueryContext("site-1", "private-dashboard");
  const query: OverviewQuery = {
    context,
    time,
    filters: EMPTY_FILTER_DOCUMENT,
  };
  return {
    kind: "typed-query" as const,
    operation: "overview" as const,
    query,
    providerRegistry: new AnalyticsProviderRegistry().registerQuery(
      "overview",
      {
        execute: (input) => overviewReader.readOverview(input as never),
      },
    ),
    resultMode: "value" as const,
    ...(options.cache ? { cache: options.cache } : {}),
  };
}

function trendInvocation(overviewReader: OverviewReader) {
  const context = siteQueryContext("site-1", "private-dashboard");
  const query = {
    context,
    time,
    filters: EMPTY_FILTER_DOCUMENT,
    interval: "hour" as const,
  };
  return {
    kind: "typed-query" as const,
    operation: "trend" as const,
    query,
    providerRegistry: new AnalyticsProviderRegistry().registerQuery("trend", {
      execute: (input) => overviewReader.readTrend(input as typeof query),
    }),
    resultMode: "value" as const,
  };
}

function invocation<T>(
  operation: QueryOperation,
  run: () => Promise<T>,
  context = siteQueryContext("site-1", "private-dashboard"),
) {
  return {
    kind: "typed-query" as const,
    operation,
    query: { context, time, filters: EMPTY_FILTER_DOCUMENT },
    providerRegistry: new AnalyticsProviderRegistry().registerQuery(operation, {
      execute: async () => ({ value: await run() }),
    }),
    resultMode: "value" as const,
  };
}

describe("TypedQueryApplicationService", () => {
  it("creates the application service from the composition boundary", () => {
    expect(createQueryService()).toBeInstanceOf(TypedQueryApplicationService);
  });

  it("executes a canonical typed query through the registry", async () => {
    const service = new TypedQueryApplicationService();
    const context = siteQueryContext("site-1", "private-dashboard");
    const run = vi.fn().mockResolvedValue({
      value: { views: 3 },
      source: "rollup",
      approximateVisitors: true,
    });
    const providerRegistry = new AnalyticsProviderRegistry().registerQuery(
      "overview",
      { execute: run },
    );

    await expect(
      service.execute({
        kind: "typed-query",
        operation: "overview",
        query: {
          context,
          time,
          filters: EMPTY_FILTER_DOCUMENT,
        } as OverviewQuery,
        providerRegistry,
        resultMode: "value",
      }),
    ).resolves.toEqual({
      ok: true,
      data: { views: 3 },
      meta: {
        time,
        source: "rollup",
        approximateVisitors: true,
      },
    });
    expect(run).toHaveBeenCalledOnce();
  });

  it("returns an internal error when a result provider is missing", async () => {
    await expect(
      new TypedQueryApplicationService().execute({
        kind: "typed-query",
        operation: "overview",
        query: {
          context: siteQueryContext("site-1", "private-dashboard"),
          time,
          filters: EMPTY_FILTER_DOCUMENT,
        } as OverviewQuery,
        providerRegistry: new AnalyticsProviderRegistry(),
        resultMode: "result",
      }),
    ).resolves.toEqual({
      ok: false,
      error: { kind: "internal", operation: "overview" },
    });
  });

  it("executes an already-enveloped result provider", async () => {
    const result = {
      ok: true as const,
      data: { views: 9 },
      meta: { time, source: "raw" as const, approximateVisitors: false },
    };
    const providerRegistry = new AnalyticsProviderRegistry().registerResult(
      "overview",
      { execute: async () => result },
    );

    await expect(
      new TypedQueryApplicationService().execute({
        kind: "typed-query",
        operation: "overview",
        query: {
          context: siteQueryContext("site-1", "private-dashboard"),
          time,
        } as OverviewQuery,
        providerRegistry,
        resultMode: "result",
      }),
    ).resolves.toEqual(result);
  });

  it("checks the deadline after an enveloped provider finishes", async () => {
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(1);
    const providerRegistry = new AnalyticsProviderRegistry().registerResult(
      "overview",
      {
        execute: async () => ({
          ok: true as const,
          data: { views: 1 },
          meta: { time, source: "raw" as const, approximateVisitors: false },
        }),
      },
    );

    await expect(
      new TypedQueryApplicationService().execute(
        {
          kind: "typed-query",
          operation: "overview",
          query: {
            context: siteQueryContext("site-1", "private-dashboard"),
            time,
          } as OverviewQuery,
          providerRegistry,
          resultMode: "result",
        },
        { deadlineMs: 1, now },
      ),
    ).resolves.toEqual({
      ok: false,
      error: { kind: "deadline-exceeded" },
    });
  });

  it("requires a canonical time before producing a value envelope", async () => {
    const providerRegistry = new AnalyticsProviderRegistry().registerQuery(
      "pages",
      { execute: async () => ({ value: { items: [] } }) },
    );

    await expect(
      new TypedQueryApplicationService().execute({
        kind: "typed-query",
        operation: "pages",
        query: { context: siteQueryContext("site-1", "private-dashboard") },
        providerRegistry,
        resultMode: "value",
      }),
    ).resolves.toEqual({
      ok: false,
      error: { kind: "internal", operation: "pages" },
    });
  });

  it("keeps provider failures inside the AnalyticsResult envelope", async () => {
    const failure = new Error("provider-down");
    await expect(
      new TypedQueryApplicationService().execute(
        invocation("pages", () => Promise.reject(failure)),
        {},
      ),
    ).resolves.toEqual({
      ok: false,
      error: { kind: "internal", operation: "pages" },
    });
  });

  it("rejects policy-denied operations before provider execution", async () => {
    const run = vi.fn().mockResolvedValue("unreachable");
    const context = {
      ...siteQueryContext("site-1", "private-dashboard"),
      policy: {
        ...siteQueryContext("site-1", "private-dashboard").policy,
        allowedOperations: new Set<QueryOperation>(),
      },
    };

    await expect(
      new TypedQueryApplicationService().execute(
        invocation("pages", run, context),
        {},
      ),
    ).resolves.toEqual({
      ok: false,
      error: { kind: "capability-denied", capability: "pages" },
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects abort, deadline, and cost before provider execution", async () => {
    const service = new TypedQueryApplicationService(undefined, {
      rangeUnitMs: 1,
      maxCost: 2,
      providerWeights: { d1: 1, rollup: 1, realtime: 1, mixed: 1 },
    });
    const run = vi.fn().mockResolvedValue("unreachable");
    const controller = new AbortController();
    controller.abort();

    await expect(
      service.execute(invocation("pages", run), { signal: controller.signal }),
    ).resolves.toEqual({
      ok: false,
      error: { kind: "request-cancelled" },
    });
    await expect(
      service.execute(invocation("pages", run), {
        deadlineMs: 10,
        now: () => 10,
      }),
    ).resolves.toEqual({
      ok: false,
      error: { kind: "deadline-exceeded" },
    });
    await expect(
      service.execute(invocation("pages", run), {
        cost: { rangeMs: 2, provider: "d1" },
      }),
    ).resolves.toEqual({
      ok: false,
      error: { kind: "query-cost-exceeded", cost: 2 },
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("records lifecycle events without allowing telemetry to alter results", async () => {
    const events: Array<{ phase: string; operation: string }> = [];
    const service = new TypedQueryApplicationService();
    await service.execute(
      invocation("pages", () => Promise.resolve(1)),
      {
        operation: "pages",
        onEvent: (event) => {
          events.push(event);
          throw new Error("telemetry failure");
        },
      },
    );

    expect(events.map((event) => `${event.operation}:${event.phase}`)).toEqual([
      "pages:start",
      "pages:success",
    ]);
  });

  it("executes overview and timeseries through ordinary registry entries", async () => {
    const overviewReader = reader();
    vi.mocked(overviewReader.readTrend).mockResolvedValue({
      value: [],
      source: "raw",
      approximateVisitors: false,
    });
    const service = new TypedQueryApplicationService();

    const overview = await service.execute(overviewInvocation(overviewReader));
    const trend = await service.execute(trendInvocation(overviewReader));

    expect(overview).toMatchObject({ ok: true, data: { views: 1 } });
    expect(trend).toMatchObject({ ok: true, data: [] });
    expect(overviewReader.readOverview).toHaveBeenCalledOnce();
    expect(overviewReader.readTrend).toHaveBeenCalledOnce();
  });

  it("returns cancellation and deadline after provider completion", async () => {
    const service = new TypedQueryApplicationService();
    const overviewReader = reader();
    const cancelled = new AbortController();
    overviewReader.readOverview = vi.fn(async () => {
      cancelled.abort();
      return {
        value: {
          views: 1,
          sessions: 1,
          visitors: 1,
          bounces: 0,
          totalDurationMs: 0,
          durationViews: 0,
        },
        source: "raw" as const,
        approximateVisitors: false,
      };
    });

    await expect(
      service.execute(overviewInvocation(overviewReader), {
        signal: cancelled.signal,
      }),
    ).resolves.toEqual({
      ok: false,
      error: { kind: "request-cancelled" },
    });
    await expect(
      service.execute(overviewInvocation(reader()), {
        deadlineMs: 2,
        now: () => 3,
      }),
    ).resolves.toEqual({
      ok: false,
      error: { kind: "deadline-exceeded" },
    });
  });

  it("caches successful provider values behind an opaque key", async () => {
    const overviewReader = reader();
    const service = new TypedQueryApplicationService(
      new OperationResultCache(),
    );
    const cache = {
      key: "__query_cache/v1/overview/opaque",
      policy: { ttlMs: 1_000, maxEntries: 4 },
    } as const;

    await service.execute(overviewInvocation(overviewReader, { cache }));
    await service.execute(overviewInvocation(overviewReader, { cache }));

    expect(overviewReader.readOverview).toHaveBeenCalledOnce();
  });

  it("does not cache policy-denied results", async () => {
    const overviewReader = reader();
    const service = new TypedQueryApplicationService(
      new OperationResultCache(),
    );
    const context = {
      ...siteQueryContext("site-1", "private-dashboard"),
      policy: {
        ...siteQueryContext("site-1", "private-dashboard").policy,
        allowedOperations: new Set<QueryOperation>(),
      },
    } as const;

    const result = await service.execute(
      overviewInvocation(overviewReader, {
        context,
        cache: {
          key: "__query_cache/v1/overview/denied",
          policy: { ttlMs: 1_000, maxEntries: 4 },
        },
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "capability-denied", capability: "overview" },
    });
    expect(overviewReader.readOverview).not.toHaveBeenCalled();
  });

  it("rejects a weighted cost at the policy ceiling", async () => {
    const overviewReader = reader();
    const service = new TypedQueryApplicationService(undefined, {
      rangeUnitMs: 1,
      maxCost: 10,
      providerWeights: { d1: 1, rollup: 1, realtime: 1, mixed: 1 },
    });
    const result = await service.execute(overviewInvocation(overviewReader), {
      cost: { rangeMs: 10, provider: "d1" },
    });

    expect(result).toEqual({
      ok: false,
      error: { kind: "query-cost-exceeded", cost: 10 },
    });
    expect(overviewReader.readOverview).not.toHaveBeenCalled();
  });
});
