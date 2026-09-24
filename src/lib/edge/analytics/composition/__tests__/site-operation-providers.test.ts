import { beforeEach, describe, expect, it, vi } from "vitest";

import { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import { createAnalyticsQueryRuntime } from "@/lib/edge/analytics/composition/query-runtime";
import { registerSiteAnalyticsOperations } from "@/lib/edge/analytics/composition/site-operation-providers";
import { registerSiteRealtimeProviders } from "@/lib/edge/analytics/composition/site-realtime-providers";
import {
  createQueryTime,
  EMPTY_FILTER_DOCUMENT,
  type QueryOperation,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import type { Env } from "@/lib/edge/types";

const readSiteOperation = vi.hoisted(() => vi.fn(async () => null));
const readRealtimeOperation = vi.hoisted(() => vi.fn(async () => null));

vi.mock("@/lib/edge/analytics/providers/d1/operations/site-breakdown", () => ({
  readSiteBreakdown: readSiteOperation,
}));
vi.mock("@/lib/edge/analytics/providers/d1/operations/site-channels", () => ({
  readSiteChannels: readSiteOperation,
}));
vi.mock(
  "@/lib/edge/analytics/providers/d1/operations/site-cross-breakdown",
  () => ({ readSiteCrossBreakdown: readSiteOperation }),
);
vi.mock(
  "@/lib/edge/analytics/providers/d1/operations/site-event-records",
  () => ({
    readSiteEventDetail: readSiteOperation,
    readSiteEventRecords: readSiteOperation,
  }),
);
vi.mock("@/lib/edge/analytics/providers/d1/operations/site-events", () => ({
  readSiteEventFields: readSiteOperation,
  readSiteEventFieldValues: readSiteOperation,
  readSiteEventsTimeseries: readSiteOperation,
  readSiteEventTypeDetail: readSiteOperation,
  readSiteEventTypes: readSiteOperation,
}));
vi.mock(
  "@/lib/edge/analytics/providers/d1/operations/site-filter-values",
  () => ({ readSiteFilterValues: readSiteOperation }),
);
vi.mock(
  "@/lib/edge/analytics/providers/d1/operations/site-funnel-analysis",
  () => ({ readSiteFunnelAnalysis: readSiteOperation }),
);
vi.mock(
  "@/lib/edge/analytics/providers/d1/operations/site-goal-summary",
  () => ({ readSiteGoalSummary: readSiteOperation }),
);
vi.mock(
  "@/lib/edge/analytics/providers/d1/operations/site-goal-timeseries",
  () => ({ readSiteGoalTimeseries: readSiteOperation }),
);
vi.mock("@/lib/edge/analytics/providers/d1/operations/site-journeys", () => ({
  readSiteJourneyEventDetail: readSiteOperation,
  readSiteSessionDetail: readSiteOperation,
  readSiteSessionEvents: readSiteOperation,
  readSiteSessions: readSiteOperation,
  readSiteVisitorDetail: readSiteOperation,
  readSiteVisitorEvents: readSiteOperation,
  readSiteVisitors: readSiteOperation,
  readSiteVisitorSessions: readSiteOperation,
}));
vi.mock(
  "@/lib/edge/analytics/providers/d1/operations/site-performance",
  () => ({
    readSitePerformanceBreakdown: readSiteOperation,
    readSitePerformanceSummary: readSiteOperation,
    readSitePerformanceTimeseries: readSiteOperation,
  }),
);
vi.mock("@/lib/edge/analytics/providers/d1/operations/site-retention", () => ({
  readSiteRetention: readSiteOperation,
}));
vi.mock(
  "@/lib/edge/analytics/providers/realtime/operations/site-realtime",
  () => ({
    readSiteRealtimeActiveVisitors: readRealtimeOperation,
    readSiteRealtimeEvents: readRealtimeOperation,
    readSiteRealtimeSessions: readRealtimeOperation,
    readSiteRealtimeSnapshot: readRealtimeOperation,
  }),
);

const env = {} as Env;
const time = createQueryTime(100, 200, "UTC", 200);
const baseQuery = {
  context: siteQueryContext("site-1", "api-v1"),
  time,
  filters: EMPTY_FILTER_DOCUMENT,
  siteId: "site-1",
  interval: "day",
  dimension: "page.path",
  primaryDimension: "page.path",
  secondaryDimension: "country",
  primaryLimit: 10,
  secondaryLimit: 10,
  metric: "lcp",
  eventName: "signup",
  eventId: "event-1",
  fieldPath: "plan",
  fieldValueType: "string",
  visitorId: "visitor-1",
  sessionId: "session-1",
  eventKind: "pageview",
  funnelId: "funnel-1",
  goalId: "goal-1",
  granularity: "day",
  search: "query",
  limit: 10,
  page: { limit: 10, cursor: "cursor-1" },
  sort: { field: "occurredAt", direction: "desc" as const },
};

function runtimeRegistry() {
  const registry = new AnalyticsProviderRegistry();
  for (const operation of [
    "overview",
    "trend",
    "pages",
    "referrers",
    "event-summary",
    "dimension",
    "performance",
  ] as const) {
    registry.register(operation, {
      execute: async () => ({ value: { fallback: true } }),
    });
  }
  return registry;
}

describe("site operation providers", () => {
  beforeEach(() => {
    readSiteOperation.mockClear();
    readRealtimeOperation.mockClear();
  });

  it("registers every site query kind under its canonical operation", async () => {
    const registry = runtimeRegistry();
    const runtime = createAnalyticsQueryRuntime(registry);
    registerSiteAnalyticsOperations(runtime, { env, siteId: "site-1" });

    const cases: readonly {
      readonly operation: QueryOperation;
      readonly queryMode?: string;
    }[] = [
      { operation: "overview" },
      { operation: "trend" },
      { operation: "pages" },
      { operation: "referrers" },
      { operation: "event-summary" },
      { operation: "dimension" },
      { operation: "cross-dimension" },
      { operation: "channels" },
      { operation: "filter-values" },
      { operation: "retention" },
      { operation: "funnel-analysis" },
      { operation: "goal-summary" },
      { operation: "goal-timeseries" },
      { operation: "performance", queryMode: "summary" },
      { operation: "performance", queryMode: "timeseries" },
      { operation: "performance", queryMode: "breakdown" },
      { operation: "event-trend" },
      { operation: "event-types" },
      { operation: "event-type-detail" },
      { operation: "event-fields" },
      { operation: "event-field-values" },
      { operation: "event-records" },
      { operation: "event-record-detail" },
      { operation: "visitor-detail" },
      { operation: "session-detail" },
      { operation: "journey-event-detail" },
      { operation: "visitors" },
      { operation: "sessions" },
      { operation: "visitor-events" },
      { operation: "visitor-sessions" },
      { operation: "session-events" },
    ];

    for (const entry of cases) {
      const provider = registry.resolve(entry.operation);
      expect(provider).toBeDefined();
      await provider!.execute({ ...baseQuery, ...entry } as never);
    }

    const sparseQuery = {
      ...baseQuery,
      time: { ...time, paginationBinding: "bound-page" },
      filters: undefined,
      siteId: undefined,
      limit: undefined,
      page: { limit: 0 },
      sort: undefined,
      search: undefined,
      eventName: undefined,
    };
    await registry.resolve("event-records")!.execute(sparseQuery as never);
    await registry.resolve("filter-values")!.execute(sparseQuery as never);
    await registry.resolve("dimension")!.execute(sparseQuery as never);
    await registry.resolve("event-types")!.execute({
      ...sparseQuery,
      page: null,
    } as never);
    await registry.resolve("event-field-values")!.execute(sparseQuery as never);
    await registry.resolve("visitors")!.execute(sparseQuery as never);

    expect(readSiteOperation).toHaveBeenCalled();
    expect(
      await registry.resolve("dimension")!.execute({
        ...baseQuery,
        context: siteQueryContext("site-1", "private-dashboard"),
      } as never),
    ).toEqual({ value: { fallback: true } });
    expect(
      await registry.resolve("performance")!.execute({
        ...baseQuery,
        queryMode: 42,
      } as never),
    ).toEqual({ value: { fallback: true } });
  });

  it("dispatches all canonical realtime variants", async () => {
    const registry = new AnalyticsProviderRegistry();
    registerSiteRealtimeProviders(registry, { env, siteId: "site-1" });
    const provider = registry.resolve("realtime");

    for (const queryMode of [
      "snapshot",
      "active-visitors",
      "events",
      "sessions",
    ]) {
      await provider!.execute({
        ...baseQuery,
        queryMode,
      } as never);
    }
    await provider!.execute({
      ...baseQuery,
      queryMode: "snapshot",
      siteId: undefined,
      limit: undefined,
    } as never);
    await expect(
      provider!.execute({ ...baseQuery, queryMode: "invalid" } as never),
    ).rejects.toThrow("unsupported-realtime-query-mode");
    expect(readRealtimeOperation).toHaveBeenCalledTimes(5);
  });
});
