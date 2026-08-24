import { describe, expect, it, vi } from "vitest";

import { OperationResultCache } from "@/lib/edge/analytics/operation-cache";
import {
  analyticsOperationProvider,
  TypedQueryApplicationService,
} from "@/lib/edge/analytics/service";
import {
  createQueryTime,
  EMPTY_FILTER_DOCUMENT,
  type OverviewReader,
  type QueryOperation,
  siteQueryContext,
  teamQueryContext,
} from "@/lib/edge/query-contract";

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

describe("TypedQueryApplicationService", () => {
  function invocation<Result>(run: () => Promise<Result>) {
    return {
      operation: "site.analytics.pages" as const,
      context: siteQueryContext("site-1", "api-v1"),
      query: { siteId: "site-1" },
      provider: analyticsOperationProvider(() => run()),
    };
  }

  it("runs registered typed operations through the same guards", async () => {
    const service = new TypedQueryApplicationService();
    const run = vi.fn().mockResolvedValue({ items: [{ id: "one" }] });
    await expect(
      service.execute(invocation(run), { capturedAtMs: 1, now: () => 1 }),
    ).resolves.toEqual({ ok: true, value: { items: [{ id: "one" }] } });
    expect(run).toHaveBeenCalledOnce();
  });

  it("rejects an operation whose registered subject does not match the trusted context", async () => {
    const service = new TypedQueryApplicationService();
    const run = vi.fn().mockResolvedValue("unreachable");

    await expect(
      service.execute(
        {
          ...invocation(run),
          context: teamQueryContext("team-1", "api-v1"),
        },
        {},
      ),
    ).resolves.toEqual({
      ok: false,
      error: {
        kind: "operation-not-allowed",
        operation: "site.analytics.pages",
      },
    });

    expect(run).not.toHaveBeenCalled();
  });

  it("emits only low-cardinality lifecycle events", async () => {
    const events: unknown[] = [];
    const service = new TypedQueryApplicationService();
    await service.execute(
      invocation(async () => ({ value: 1 })),
      {
        operation: "site.analytics.pages",
        onEvent: (event) => events.push(event),
      },
    );
    expect(events).toEqual([
      { operation: "site.analytics.pages", phase: "start" },
      { operation: "site.analytics.pages", phase: "success" },
    ]);
  });

  it("rejects generic work before the provider for abort, deadline and cost", async () => {
    const service = new TypedQueryApplicationService(undefined, {
      rangeUnitMs: 1,
      maxCost: 2,
      providerWeights: { d1: 1, rollup: 1, realtime: 1, mixed: 1 },
    });
    const run = vi.fn().mockResolvedValue("unreachable");
    const controller = new AbortController();
    controller.abort();
    await expect(
      service.execute(invocation(run), { signal: controller.signal }),
    ).resolves.toEqual({
      ok: false,
      error: { kind: "request-cancelled" },
    });
    await expect(
      service.execute(invocation(run), { deadlineMs: 10, now: () => 10 }),
    ).resolves.toEqual({
      ok: false,
      error: { kind: "deadline-exceeded" },
    });
    await expect(
      service.execute(invocation(run), {
        cost: { rangeMs: 2, provider: "d1" },
      }),
    ).resolves.toEqual({
      ok: false,
      error: { kind: "query-cost-exceeded", cost: 2 },
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("records cancellation, deadline, cost and provider failure without throwing from the hook", async () => {
    const events: Array<{ phase: string; operation: string }> = [];
    const service = new TypedQueryApplicationService(undefined, {
      rangeUnitMs: 1,
      maxCost: 2,
      providerWeights: { d1: 1, rollup: 1, realtime: 1, mixed: 1 },
    });
    const controller = new AbortController();
    controller.abort();
    await service.execute(
      invocation(() => Promise.resolve(1)),
      {
        operation: "cancelled",
        signal: controller.signal,
        onEvent: (event) => {
          events.push(event);
          throw new Error("telemetry failure");
        },
      },
    );
    await service.execute(
      invocation(() => Promise.resolve(1)),
      {
        operation: "costed",
        cost: { rangeMs: 2 },
        onEvent: (event) => events.push(event),
      },
    );
    await expect(
      service.execute(
        invocation(() => Promise.reject(new Error("down"))),
        {
          operation: "failed",
          onEvent: (event) => events.push(event),
        },
      ),
    ).rejects.toThrow("down");
    expect(events.map((event) => `${event.operation}:${event.phase}`)).toEqual([
      "cancelled:start",
      "cancelled:cancelled",
      "costed:start",
      "costed:cost",
      "failed:start",
      "failed:failure",
    ]);
  });

  it("does not swallow provider failures", async () => {
    const service = new TypedQueryApplicationService();
    const failure = new Error("provider-down");
    await expect(
      service.execute(
        invocation(() => Promise.reject(failure)),
        {},
      ),
    ).rejects.toBe(failure);
  });

  it("executes canonical overview input without HTTP dependencies", async () => {
    const service = new TypedQueryApplicationService();
    const overviewReader = reader();
    const result = await service.overview(
      overviewReader,
      {
        context: siteQueryContext("site-1", "api-v1"),
        time,
        filters: EMPTY_FILTER_DOCUMENT,
      },
      {},
    );

    expect(result).toMatchObject({ ok: true, value: { ok: true } });
    expect(overviewReader.readOverview).toHaveBeenCalledOnce();
  });

  it("executes trend through the same cache and lifecycle guards", async () => {
    const overviewReader = reader();
    vi.mocked(overviewReader.readTrend).mockResolvedValue({
      value: [],
      source: "raw",
      approximateVisitors: false,
    });
    const service = new TypedQueryApplicationService();
    const result = await service.trend(
      overviewReader,
      {
        context: siteQueryContext("site-1", "api-v1"),
        time,
        filters: EMPTY_FILTER_DOCUMENT,
        interval: "hour",
      },
      { operation: "site.analytics.timeseries" },
    );
    expect(result).toMatchObject({ ok: true, value: { ok: true } });
    expect(overviewReader.readTrend).toHaveBeenCalledOnce();
  });

  it("does not call a provider after cancellation or deadline expiry", async () => {
    const service = new TypedQueryApplicationService();
    const overviewReader = reader();
    const controller = new AbortController();
    controller.abort();

    const cancelled = await service.overview(
      overviewReader,
      {
        context: siteQueryContext("site-1", "api-v1"),
        time,
        filters: EMPTY_FILTER_DOCUMENT,
      },
      { signal: controller.signal },
    );
    const expired = await service.overview(
      overviewReader,
      {
        context: siteQueryContext("site-1", "api-v1"),
        time,
        filters: EMPTY_FILTER_DOCUMENT,
      },
      { deadlineMs: 10, now: () => 10 },
    );

    expect(cancelled).toEqual({
      ok: false,
      error: { kind: "request-cancelled" },
    });
    expect(expired).toEqual({
      ok: false,
      error: { kind: "deadline-exceeded" },
    });
    expect(overviewReader.readOverview).not.toHaveBeenCalled();
  });

  it("keeps policy denial ahead of provider execution", async () => {
    const service = new TypedQueryApplicationService();
    const overviewReader = reader();
    const context = siteQueryContext("site-1", "api-v1");
    const deniedContext = {
      ...context,
      policy: {
        ...context.policy,
        allowedOperations: new Set<QueryOperation>(),
      },
    };

    const result = await service.overview(
      overviewReader,
      { context: deniedContext, time, filters: EMPTY_FILTER_DOCUMENT },
      {},
    );

    expect(result).toMatchObject({
      ok: true,
      value: { ok: false, error: { kind: "capability-denied" } },
    });
    expect(overviewReader.readOverview).not.toHaveBeenCalled();
  });

  it("caches only successful aggregate results behind an opaque key", async () => {
    const overviewReader = reader();
    const service = new TypedQueryApplicationService(
      new OperationResultCache(),
    );
    const execution = {
      context: siteQueryContext("site-1", "api-v1"),
      time,
      filters: EMPTY_FILTER_DOCUMENT,
      cache: {
        key: "__query_cache/v1/site.analytics.overview/opaque",
        policy: { ttlMs: 1_000, maxEntries: 4 },
      },
    } as const;

    await service.overview(overviewReader, execution, {});
    await service.overview(overviewReader, execution, {});

    expect(overviewReader.readOverview).toHaveBeenCalledOnce();
  });

  it("does not cache policy-denied aggregate results", async () => {
    const overviewReader = reader();
    const service = new TypedQueryApplicationService(
      new OperationResultCache(),
    );
    const execution = {
      context: {
        ...siteQueryContext("site-1", "api-v1"),
        policy: {
          ...siteQueryContext("site-1", "api-v1").policy,
          allowedOperations: new Set<QueryOperation>(),
        },
      },
      time,
      filters: EMPTY_FILTER_DOCUMENT,
      cache: {
        key: "__query_cache/v1/site.analytics.overview/denied",
        policy: { ttlMs: 1_000, maxEntries: 4 },
      },
    } as const;

    const result = await service.overview(overviewReader, execution, {});

    expect(result).toMatchObject({
      ok: true,
      value: { ok: false, error: { kind: "capability-denied" } },
    });
    expect(overviewReader.readOverview).not.toHaveBeenCalled();
  });

  it("returns cancellation/deadline after provider completion", async () => {
    const overviewReader = reader();
    const service = new TypedQueryApplicationService();
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
      service.overview(
        overviewReader,
        {
          context: siteQueryContext("site-1", "api-v1"),
          time,
          filters: EMPTY_FILTER_DOCUMENT,
        },
        { signal: cancelled.signal },
      ),
    ).resolves.toEqual({ ok: false, error: { kind: "request-cancelled" } });

    const afterDeadline = await service.overview(
      reader(),
      {
        context: siteQueryContext("site-1", "api-v1"),
        time,
        filters: EMPTY_FILTER_DOCUMENT,
      },
      { deadlineMs: 2, now: () => 3 },
    );
    expect(afterDeadline).toEqual({
      ok: false,
      error: { kind: "deadline-exceeded" },
    });
  });

  it("rejects a query whose shared weighted cost reaches the policy ceiling before provider execution", async () => {
    const overviewReader = reader();
    const service = new TypedQueryApplicationService(undefined, {
      rangeUnitMs: 1,
      maxCost: 10,
      providerWeights: { d1: 1, rollup: 1, realtime: 1, mixed: 1 },
    });
    const result = await service.overview(
      overviewReader,
      {
        context: siteQueryContext("site-1", "api-v1"),
        time,
        filters: EMPTY_FILTER_DOCUMENT,
      },
      { cost: { rangeMs: 10, provider: "d1" } },
    );
    expect(result).toEqual({
      ok: false,
      error: { kind: "query-cost-exceeded", cost: 10 },
    });
    expect(overviewReader.readOverview).not.toHaveBeenCalled();
  });
});
