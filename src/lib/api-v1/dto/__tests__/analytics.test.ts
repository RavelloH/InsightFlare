import { describe, expect, it } from "vitest";

import {
  SiteComparisonBreakdownQueryDtoSchema,
  SiteComparisonTimeseriesQueryDtoSchema,
  SiteEventFieldsQueryDtoSchema,
  SiteEventFieldValuesQueryDtoSchema,
  SiteEventTypeDetailQueryDtoSchema,
  SiteEventTypesQueryDtoSchema,
  SiteOverviewComparisonQueryDtoSchema,
  SiteOverviewQueryDtoSchema,
  SiteRealtimeActiveVisitorsQueryDtoSchema,
  SiteRealtimeEventsQueryDtoSchema,
  SiteRealtimeSessionsQueryDtoSchema,
  SiteRealtimeSnapshotQueryDtoSchema,
  SiteSessionDetailQueryDtoSchema,
  SiteSessionEventsQueryDtoSchema,
  SiteSessionsSearchQueryDtoSchema,
  SiteVisitorDetailQueryDtoSchema,
  SiteVisitorEventsQueryDtoSchema,
  SiteVisitorSessionsQueryDtoSchema,
  SiteVisitorsSearchQueryDtoSchema,
  TeamAnalyticsQueryBaseDtoSchema,
  TeamComparisonOverviewQueryDtoSchema,
} from "@/lib/api-v1/dto/analytics";

const timeRange = {
  kind: "absolute" as const,
  from: "2026-08-01T00:00:00.000Z",
  to: "2026-08-02T00:00:00.000Z",
  timeZone: "UTC",
};

describe("API v1 analytics DTOs", () => {
  it("requires an explicit absolute/preset time-range discriminator", () => {
    expect(
      SiteOverviewQueryDtoSchema.safeParse({
        timeRange: {
          from: "2026-08-01T00:00:00.000Z",
          to: "2026-08-02T00:00:00.000Z",
        },
        metrics: ["views"],
      }).success,
    ).toBe(false);
    expect(
      SiteOverviewQueryDtoSchema.safeParse({
        timeRange: { kind: "preset", preset: "last_7_days" },
        metrics: ["views"],
      }).success,
    ).toBe(true);
  });

  it("accepts a strict site overview query with an inline AST", () => {
    const parsed = SiteOverviewQueryDtoSchema.safeParse({
      timeRange,
      metrics: ["views", "sessions"],
      filter: {
        type: "inline",
        expression: {
          kind: "condition",
          target: { kind: "field", field: "geo.country" },
          operator: "eq",
          value: "US",
        },
      },
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects unknown fields and ambiguous timestamp values", () => {
    expect(
      SiteOverviewQueryDtoSchema.safeParse({
        timeRange: { ...timeRange, from: "2026-08-01" },
        unexpected: true,
      }).success,
    ).toBe(false);
  });

  it("permits saved references only for site queries", () => {
    const saved = { type: "saved", id: "filter-1" };
    expect(
      SiteOverviewQueryDtoSchema.safeParse({ timeRange, filter: saved })
        .success,
    ).toBe(true);
    expect(
      TeamAnalyticsQueryBaseDtoSchema.safeParse({ timeRange, filter: saved })
        .success,
    ).toBe(false);
  });

  it("uses explicit variants for comparison and keeps the timezone top-level", () => {
    const explicit = {
      mode: "explicit",
      timeZone: "Asia/Shanghai",
      a: { timeRange: { kind: "preset", preset: "last_7_days" } },
      b: {
        timeRange: {
          kind: "absolute",
          from: "2026-08-01T00:00:00.000Z",
          to: "2026-08-08T00:00:00.000Z",
        },
      },
      query: { interval: "day" },
    };
    expect(
      SiteComparisonTimeseriesQueryDtoSchema.safeParse(explicit).success,
    ).toBe(true);
    expect(
      SiteComparisonTimeseriesQueryDtoSchema.safeParse({
        ...explicit,
        a: { timeRange: { ...explicit.a.timeRange, timeZone: "UTC" } },
      }).success,
    ).toBe(false);
    expect(
      SiteComparisonBreakdownQueryDtoSchema.safeParse({
        ...explicit,
        query: { limit: 20 },
      }).success,
    ).toBe(true);
  });

  it("only allows the previous-period variant for site overview", () => {
    const previous = {
      mode: "previous-period",
      timeRange,
      query: { metrics: ["views"] },
    };
    expect(
      SiteOverviewComparisonQueryDtoSchema.safeParse(previous).success,
    ).toBe(true);
    expect(
      SiteComparisonTimeseriesQueryDtoSchema.safeParse({
        ...previous,
        query: { interval: "day" },
      }).success,
    ).toBe(false);
    expect(
      TeamComparisonOverviewQueryDtoSchema.safeParse({
        mode: "explicit",
        timeZone: "UTC",
        a: { timeRange: { kind: "preset", preset: "today" } },
        b: { timeRange: { kind: "preset", preset: "yesterday" } },
        query: {},
      }).success,
    ).toBe(true);
    expect(
      TeamComparisonOverviewQueryDtoSchema.safeParse({
        mode: "explicit",
        timeZone: "UTC",
        a: {
          timeRange: { kind: "preset", preset: "today" },
          filter: { type: "saved", id: "filter-1" },
        },
        b: { timeRange: { kind: "preset", preset: "yesterday" } },
        query: {},
      }).success,
    ).toBe(false);
  });

  it("keeps event type query bodies strict and uses opaque names in the body", () => {
    expect(
      SiteEventTypesQueryDtoSchema.safeParse({ timeRange, page: { limit: 20 } })
        .success,
    ).toBe(true);
    expect(
      SiteEventTypeDetailQueryDtoSchema.safeParse({
        timeRange,
        eventName: "detail",
        interval: "day",
      }).success,
    ).toBe(true);
    expect(
      SiteEventFieldsQueryDtoSchema.safeParse({
        timeRange,
        eventName: "signup",
        unexpected: true,
      }).success,
    ).toBe(false);
    expect(
      SiteEventFieldValuesQueryDtoSchema.safeParse({
        timeRange,
        eventName: "signup",
        fieldPath: "plan",
        fieldValueType: "string",
      }).success,
    ).toBe(true);
  });

  it("keeps opaque visitor and session IDs in strict time-scoped bodies", () => {
    expect(
      SiteVisitorDetailQueryDtoSchema.safeParse({
        timeRange,
        visitorId: "detail",
      }).success,
    ).toBe(true);
    expect(
      SiteSessionDetailQueryDtoSchema.safeParse({
        timeRange,
        sessionId: "session-1",
        filter: null,
      }).success,
    ).toBe(false);
  });

  it("defines bounded typed keyset searches for visitors and sessions", () => {
    expect(
      SiteVisitorsSearchQueryDtoSchema.safeParse({ timeRange }).success,
    ).toBe(true);
    expect(
      SiteSessionsSearchQueryDtoSchema.safeParse({
        timeRange,
        sort: { field: "durationMs", direction: "desc" },
        page: { limit: 20 },
      }).success,
    ).toBe(true);
    expect(
      SiteVisitorsSearchQueryDtoSchema.safeParse({
        timeRange,
        page: { cursor: "x", unexpected: true },
      }).success,
    ).toBe(false);
  });

  it("defines strict bounded trajectory queries", () => {
    expect(
      SiteVisitorEventsQueryDtoSchema.safeParse({
        timeRange,
        visitorId: "visitor-1",
      }).data,
    ).toMatchObject({ limit: 100 });
    expect(
      SiteVisitorSessionsQueryDtoSchema.safeParse({
        timeRange,
        visitorId: "visitor-1",
        limit: 500,
      }).success,
    ).toBe(true);
    expect(
      SiteSessionEventsQueryDtoSchema.safeParse({
        timeRange,
        sessionId: "session-1",
        limit: 501,
      }).success,
    ).toBe(false);
    expect(
      SiteVisitorEventsQueryDtoSchema.safeParse({
        timeRange,
        visitorId: "visitor-1",
        unexpected: true,
      }).success,
    ).toBe(false);
  });

  it("defines strict POST-only realtime query bodies", () => {
    expect(
      SiteRealtimeSnapshotQueryDtoSchema.safeParse({ timeRange }).data,
    ).toMatchObject({ limit: 100 });
    expect(
      SiteRealtimeActiveVisitorsQueryDtoSchema.safeParse({ timeRange }).success,
    ).toBe(true);
    expect(
      SiteRealtimeEventsQueryDtoSchema.safeParse({ timeRange, limit: 501 })
        .success,
    ).toBe(false);
    expect(
      SiteRealtimeSessionsQueryDtoSchema.safeParse({ timeRange, unknown: true })
        .success,
    ).toBe(false);
  });
});
