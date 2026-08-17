import { describe, expect, it, vi } from "vitest";

import {
  analyticsFilterRegistry,
  buildCalendarBucketPlan,
  createQueryTime,
  createTimeRange,
  EMPTY_FILTER_DOCUMENT,
  exclusiveRangeToInclusive,
  executeOverview,
  executePages,
  executeQueryOperation,
  executeReferrers,
  executeTrend,
  hasFilters,
  inclusiveRangeToExclusive,
  normalizeFilterDocument,
  normalizeReportingTimeZone,
  previousComparableRange,
  siteQueryContext,
} from "@/lib/edge/query-contract/index";

describe("query contract time helpers", () => {
  it("enforces half-open range boundaries", () => {
    const range = createTimeRange(100, 200);
    expect(range.startMs).toBe(100);
    expect(range.endExclusiveMs).toBe(200);
    expect(inclusiveRangeToExclusive(100, 199)).toEqual(range);
    expect(() => createTimeRange(100, 100)).toThrow();
    expect(() => createTimeRange(200, 100)).toThrow();
  });

  it("builds a comparable range immediately before the current range", () => {
    expect(previousComparableRange(createTimeRange(1_000, 2_000))).toEqual({
      startMs: 0,
      endExclusiveMs: 1_000,
    });
  });

  it("creates query time only from valid captured instants", () => {
    expect(createQueryTime(100, 200, "UTC", 250)).toMatchObject({
      range: { startMs: 100, endExclusiveMs: 200 },
      reportingTimeZone: "UTC",
      capturedAtMs: 250,
    });
    expect(() => createQueryTime(100, 200, "UTC", 1.5)).toThrow(
      "Query capture time",
    );
    expect(exclusiveRangeToInclusive(createTimeRange(100, 200))).toEqual({
      startMs: 100,
      endMs: 199,
    });
    expect(() =>
      inclusiveRangeToExclusive(100, Number.MAX_SAFE_INTEGER),
    ).toThrow("Inclusive range end");
  });

  it("normalizes invalid timezones to UTC and preserves valid zones", () => {
    expect(normalizeReportingTimeZone("America/New_York")).toBe(
      "America/New_York",
    );
    expect(normalizeReportingTimeZone("not/a-zone")).toBe("UTC");
  });

  it("keeps DST calendar days half-open with a 23-hour day", () => {
    const zone = normalizeReportingTimeZone("America/New_York");
    const start = Date.UTC(2024, 2, 10, 5);
    const plan = buildCalendarBucketPlan({
      range: createTimeRange(start, Date.UTC(2024, 2, 12, 4)),
      granularity: "day",
      reportingTimeZone: zone,
    });
    expect(plan.buckets).toHaveLength(2);
    expect(plan.buckets[0].endExclusiveMs - plan.buckets[0].startMs).toBe(
      23 * 3_600_000,
    );
    expect(plan.buckets[0].endExclusiveMs).toBe(plan.buckets[1].startMs);
  });

  it("reports bucket truncation and rejects invalid bucket limits", () => {
    const plan = buildCalendarBucketPlan({
      range: createTimeRange(0, 4 * 3_600_000),
      granularity: "hour",
      reportingTimeZone: normalizeReportingTimeZone("UTC"),
      maxBuckets: 2,
    });
    expect(plan).toMatchObject({
      truncated: true,
      hourAligned: true,
    });
    expect(plan.buckets).toHaveLength(2);
    expect(() =>
      buildCalendarBucketPlan({
        range: createTimeRange(0, 3_600_000),
        granularity: "hour",
        reportingTimeZone: normalizeReportingTimeZone("UTC"),
        maxBuckets: 0,
      }),
    ).toThrow("maxBuckets");
  });

  it("uses typed document filter presence", () => {
    expect(hasFilters(undefined)).toBe(false);
    expect(hasFilters(EMPTY_FILTER_DOCUMENT)).toBe(false);
    expect(
      hasFilters(
        normalizeFilterDocument(
          {
            version: 1,
            root: {
              kind: "condition",
              target: { kind: "field", field: "geo.country" },
              operator: "eq",
              value: "US",
            },
          },
          analyticsFilterRegistry,
        ),
      ),
    ).toBe(true);
  });

  it("normalizes typed documents and rejects invalid versions", () => {
    const normalized = normalizeFilterDocument(
      {
        version: 1,
        root: {
          kind: "and",
          children: [
            {
              kind: "condition",
              target: { kind: "field", field: "geo.country" },
              operator: "eq",
              value: "US",
            },
          ],
        },
      },
      analyticsFilterRegistry,
    );
    expect(normalized.root).toMatchObject({ kind: "condition", value: "us" });
    expect(() =>
      normalizeFilterDocument(
        { version: 0, root: null },
        analyticsFilterRegistry,
      ),
    ).toThrow("Expected filter document version 1");
  });

  it("denies public page and referrer detail before a reader is invoked", async () => {
    const reader = {
      readPages: async () => {
        throw new Error("reader must not be called");
      },
      readReferrers: async () => {
        throw new Error("reader must not be called");
      },
    };
    const time = {
      range: createTimeRange(100, 200),
      reportingTimeZone: normalizeReportingTimeZone("UTC"),
      capturedAtMs: 200 as never,
    };
    const context = siteQueryContext("site-1", "public-share");

    await expect(
      executePages(reader, {
        context,
        time,
        limit: 20,
        includeDetails: true,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: "capability-denied", capability: "page.query" },
    });
    await expect(
      executeReferrers(reader, {
        context,
        time,
        limit: 20,
        includeFullUrl: true,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: "capability-denied", capability: "referrer.url" },
    });
  });

  it("gates opaque query families before invoking their reader", async () => {
    const time = {
      range: createTimeRange(100, 200),
      reportingTimeZone: normalizeReportingTimeZone("UTC"),
      capturedAtMs: 200 as never,
    };
    const reader = vi.fn(async () => ({ value: { rows: [] } }));
    const result = await executeQueryOperation(
      "event-records",
      {
        context: siteQueryContext("site-1", "public-share"),
        time,
      },
      reader,
    );
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "capability-denied", capability: "event-records" },
    });
    expect(reader).not.toHaveBeenCalled();
  });

  it("validates typed filters and maps reader failures to domain errors", async () => {
    const time = createQueryTime(100, 200, "UTC", 200);
    const context = siteQueryContext("site-1", "private-dashboard");
    const tooMany = await executeQueryOperation(
      "event-records",
      {
        context: {
          ...context,
          policy: {
            ...context.policy,
            limits: { ...context.policy.limits, maxFilterClauses: 1 },
          },
        },
        time,
        filters: { version: 1, root: { kind: "invalid" } } as never,
      },
      vi.fn(async () => ({ value: {} })),
    );
    expect(tooMany).toMatchObject({
      ok: false,
      error: {
        kind: "invalid-input",
        issues: [{ code: "invalid_or_unauthorized_filter" }],
      },
    });

    await expect(
      executeQueryOperation("event-records", { context, time }, async () => {
        throw new Error("D1 unavailable");
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: "internal", operation: "event-records" },
    });
  });

  it("combines overview sources and embeds typed trend detail", async () => {
    const time = createQueryTime(100, 200, "UTC", 200);
    const previousTime = createQueryTime(0, 100, "UTC", 200);
    const reader = {
      readOverview: vi
        .fn()
        .mockResolvedValueOnce({
          value: {
            views: 4,
            sessions: 3,
            visitors: 2,
            bounces: 1,
            totalDurationMs: 40,
            durationViews: 2,
          },
          source: "raw",
          approximateVisitors: false,
        })
        .mockResolvedValueOnce({
          value: {
            views: 2,
            sessions: 2,
            visitors: 1,
            bounces: 1,
            totalDurationMs: 10,
            durationViews: 1,
          },
          source: "rollup",
          approximateVisitors: true,
        }),
      readTrend: vi.fn().mockResolvedValue({
        value: [
          {
            bucket: 0,
            timestampMs: 100,
            views: 4,
            sessions: 3,
            visitors: 2,
            bounces: 1,
            totalDurationMs: 40,
            durationViews: 2,
          },
        ],
        source: "raw",
        approximateVisitors: false,
      }),
    };
    const result = await executeOverview(reader, {
      context: siteQueryContext("site-1", "private-dashboard"),
      time,
      previousTime,
      detailInterval: "hour",
    });
    expect(result).toMatchObject({
      ok: true,
      data: { previous: { views: 2 }, detail: { interval: "hour" } },
      meta: { source: "mixed", approximateVisitors: true },
    });
    expect(reader.readTrend).toHaveBeenCalledOnce();
  });

  it("returns successful typed trend, pages, and referrer results", async () => {
    const time = createQueryTime(100, 200, "UTC", 200);
    const context = siteQueryContext("site-1", "private-dashboard");
    const reader = {
      readOverview: vi.fn(),
      readTrend: vi.fn().mockResolvedValue({
        value: [],
        source: "rollup",
        approximateVisitors: true,
      }),
      readPages: vi.fn().mockResolvedValue({
        value: [
          {
            pathname: "/docs",
            query: "",
            hash: "",
            views: 3,
            sessions: 2,
          },
        ],
        source: "raw",
      }),
      readReferrers: vi.fn().mockResolvedValue({
        value: [
          { referrer: "example.com", views: 3, sessions: 2, visitors: 2 },
        ],
        source: "raw",
      }),
    };
    await expect(
      executeTrend(reader, { context, time, interval: "hour" }),
    ).resolves.toMatchObject({
      ok: true,
      data: { interval: "hour", points: [] },
      meta: { source: "rollup", approximateVisitors: true },
    });
    await expect(
      executePages(reader, {
        context,
        time,
        limit: 20,
        includeDetails: true,
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: { items: [{ pathname: "/docs" }] },
    });
    await expect(
      executeReferrers(reader, {
        context,
        time,
        limit: 20,
        includeFullUrl: true,
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: { items: [{ referrer: "example.com" }] },
    });
  });
});
