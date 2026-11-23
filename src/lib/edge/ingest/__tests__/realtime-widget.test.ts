import { describe, expect, it, vi } from "vitest";

import { readRealtimeWidgetAggregate } from "@/lib/edge/ingest/realtime-widget";

describe("public realtime widget aggregation", () => {
  it("deduplicates active visitors and suppresses sparse country/page buckets", () => {
    const now = Date.UTC(2026, 10, 23, 13, 30);
    const visits = [
      { visitorId: "one", country: "US", pathname: "/docs" },
      { visitorId: "one", country: "US", pathname: "/docs" },
      { visitorId: "two", country: "US", pathname: "/docs" },
      { visitorId: "three", country: "US", pathname: "/docs" },
      { visitorId: "four", country: "JP", pathname: "/pricing" },
      { visitorId: "five", country: "ZZ", pathname: "/private" },
    ];
    const query = vi.fn((sql: string, ..._bindings: number[]) =>
      sql.includes("status = 'open'")
        ? visits
        : [{ minute: Math.floor(now / 60000) - 1, visitors: 2, views: 3 }],
    );
    const data = readRealtimeWidgetAggregate(
      {
        sqlAll: <T>(sql: string, ...bindings: number[]): T[] =>
          query(sql, ...bindings) as T[],
      },
      now,
    );
    expect(data.activeNow).toBe(5);
    expect(data.countries).toEqual([{ country: "US", activeVisitors: 3 }]);
    expect(data.pages).toEqual([{ path: "/docs", activeVisitors: 3 }]);
    expect(data.bars).toHaveLength(30);
    expect(data.bars.at(-2)).toMatchObject({ visitors: 2, views: 3 });
    expect(data.bars.at(-1)).toMatchObject({ visitors: 0, views: 0 });
    expect(JSON.stringify(data)).not.toContain("visitorId");
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("returns an empty 30-minute chart and zero count when site is idle", () => {
    const data = readRealtimeWidgetAggregate(
      {
        sqlAll: <T>(): T[] => [],
      },
      Date.UTC(2026, 10, 23, 13),
    );
    expect(data.activeNow).toBe(0);
    expect(data.bars).toHaveLength(30);
    expect(data.bars.every((b) => b.visitors === 0)).toBe(true);
    expect(data.countries).toEqual([]);
  });
});
