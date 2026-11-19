// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AnalyticsProviderDomainError } from "@/lib/edge/analytics/application/errors";
import {
  attachScopedFilterMetadata,
  createQueryTime,
  createScopedFilterPlan,
  type QueryTime,
  scopedFilterMetadata,
} from "@/lib/edge/analytics/contract";
import { queryD1All } from "@/lib/edge/analytics/providers/d1/internal/core-sources";
import {
  d1FilterSqlHistoryMiddleware,
  resolveFilterSqlCoverageTime,
} from "@/lib/edge/analytics/providers/d1/internal/filter-sql-history";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";

vi.mock("@/lib/edge/analytics/providers/d1/internal/core-sources", () => ({
  queryD1All: vi.fn(),
}));

const coverage = new Map([
  ["site-a", 0],
  ["site-b", 50],
]);
const clock = createQueryTime(100, 300, "UTC", 400);

function prepared(expression: string, time: QueryTime = clock) {
  const filters = parseFilterDsl(expression, analyticsFilterRegistry);
  const plan = createScopedFilterPlan("overview", filters, "session")!;
  return attachScopedFilterMetadata(filters, {
    requestedScope: "session",
    resolvedScope: "session",
    plan,
    time,
    siteIds: ["site-a"],
  });
}

describe("P5 SQL-only site coverage time resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queryD1All).mockResolvedValue([
      { siteId: "site-a", createdAtSeconds: 0 },
      { siteId: "site-b", createdAtSeconds: 0.05 },
    ]);
  });

  it("resolves complete history and open-ended Filter range from site metadata", () => {
    const resolved = resolveFilterSqlCoverageTime(
      {
        ...clock,
        fullHistory: true,
        filterRange: { endExclusiveMs: 200 },
      },
      ["site-a", "site-b"],
      coverage,
    );
    expect(resolved.readRange).toEqual({
      startMs: 0,
      endExclusiveMs: 401,
    });
    expect(resolved.filterRange).toEqual({
      startMs: 0,
      endExclusiveMs: 200,
    });
    expect(resolved.fullHistory).toBe(true);
  });

  it("rejects missing sites and historical requests before known site creation", () => {
    expect(() =>
      resolveFilterSqlCoverageTime(clock, ["missing"], coverage),
    ).toThrow(AnalyticsProviderDomainError);
    expect(() =>
      resolveFilterSqlCoverageTime(
        {
          ...clock,
          readRange: { startMs: 0, endExclusiveMs: 300 } as QueryTime["range"],
        },
        ["site-a", "site-b"],
        coverage,
      ),
    ).toThrow(AnalyticsProviderDomainError);
    expect(() =>
      resolveFilterSqlCoverageTime(
        {
          ...clock,
          readRange: {
            startMs: 100,
            endExclusiveMs: 500,
          } as QueryTime["range"],
        },
        ["site-a"],
        coverage,
      ),
    ).toThrow(AnalyticsProviderDomainError);
  });

  it("does not read activity or payload when the filter requires no SQL history", async () => {
    const middleware = d1FilterSqlHistoryMiddleware({} as Env);
    const filters = parseFilterDsl(
      'page.path eq "/home"',
      analyticsFilterRegistry,
    );
    const input = {
      context: { subject: { kind: "site", siteId: "site-a" } },
      filters,
      time: clock,
    };
    const next = vi.fn(async (query) => query);
    expect(await middleware("overview", input, next)).toBe(input);
    expect(queryD1All).not.toHaveBeenCalled();
  });

  it("performs exactly one site-metadata query and preserves prepared SQL scope", async () => {
    const middleware = d1FilterSqlHistoryMiddleware({} as Env);
    const filters = prepared('first(EVENT).name eq "purchase"', {
      ...clock,
      fullHistory: true,
    });
    const input = {
      context: { subject: { kind: "site", siteId: "site-a" } },
      filters,
      time: clock,
    };
    const next = vi.fn(async (query) => query);
    const output = (await middleware("overview", input, next)) as typeof input;
    expect(queryD1All).toHaveBeenCalledTimes(1);
    const sql = vi.mocked(queryD1All).mock.calls[0]?.[1] ?? "";
    expect(sql).toContain("FROM sites");
    expect(sql).not.toMatch(
      /FROM visits|FROM custom_events|FROM custom_event_json/,
    );
    expect(scopedFilterMetadata(output.filters)?.time.readRange).toEqual({
      startMs: 0,
      endExclusiveMs: 401,
    });
    expect(scopedFilterMetadata(output.filters)?.plan).toBe(
      scopedFilterMetadata(filters)?.plan,
    );
  });

  it("shares coverage for both Comparison sides instead of reading each twice", async () => {
    const middleware = d1FilterSqlHistoryMiddleware({} as Env);
    const fullHistory = { ...clock, fullHistory: true };
    const first = prepared('first(EVENT).name eq "purchase"', fullHistory);
    const second = prepared('last(EVENT).name eq "signup"', fullHistory);
    const input = {
      context: { subject: { kind: "site", siteId: "site-a" } },
      current: { filters: first, time: fullHistory },
      reference: { filters: second, time: fullHistory },
    };
    const result = (await middleware(
      "comparison",
      input,
      async (query) => query,
    )) as typeof input;
    expect(queryD1All).toHaveBeenCalledTimes(1);
    expect(
      scopedFilterMetadata(result.current.filters)?.time.readRange?.startMs,
    ).toBe(0);
    expect(
      scopedFilterMetadata(result.reference.filters)?.time.readRange?.startMs,
    ).toBe(0);
  });
});
