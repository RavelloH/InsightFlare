import { describe, expect, it } from "vitest";

import {
  patchPerformanceSearch,
  performanceRequestWindow,
  readPerformanceState,
} from "@/components/dashboard/admin/system-performance/performance-url-state";

describe("system performance URL state", () => {
  it("restores the tab, route, hotspot kind, version and source", () => {
    const state = readPerformanceState(
      new URLSearchParams(
        "perfTab=hotspots&hotspotKind=scan&routeKey=api%3A%2Fcollect&appVersion=1.2.3%2Babcdef123456&perfSource=worker",
      ),
    );
    expect(state).toMatchObject({
      tab: "hotspots",
      kind: "scan",
      routeKey: "api:/collect",
      appVersion: "1.2.3+abcdef123456",
      source: "worker",
    });
  });

  it("drops values the API would reject", () => {
    const state = readPerformanceState(
      new URLSearchParams(
        "perfTab=nope&hotspotKind=x&routeKey=%2Fadmin&appVersion=latest&perfSource=edge&sampleQueryId=Bad%20Id&sampleErrorCode=BAD&sampleResult=maybe&sampleTrigger=cron",
      ),
    );
    expect(state).toEqual({
      tab: "overview",
      source: "all",
      kind: "api-hot",
      routeKey: "",
      appVersion: "",
      sampleQueryId: "",
      sampleKind: "",
      sampleErrorCode: "",
      sampleResult: "",
      sampleTrigger: "",
    });
  });

  it("patches search params and keeps the default tab implicit", () => {
    const next = patchPerformanceSearch(
      new URLSearchParams("perfTab=samples&routeKey=api%3A%2Fcollect&range=7d"),
      { perfTab: "overview", routeKey: null, appVersion: "1.2.3" },
    );
    expect(next.get("perfTab")).toBeNull();
    expect(next.get("routeKey")).toBeNull();
    expect(next.get("appVersion")).toBe("1.2.3");
    expect(next.get("range")).toBe("7d");
  });
});

describe("system performance request window", () => {
  const now = Date.UTC(2026, 10, 22, 6, 0);

  it("never asks for a window that ends in the future", () => {
    const window = performanceRequestWindow(
      {
        from: now - 3_600_000,
        to: now + 3_600_000,
        interval: "minute",
        timeZone: "UTC",
      },
      now,
    );
    expect(window).toEqual({
      from: now - 3_600_000,
      to: now - 1000,
      interval: "minute",
      timeZone: "UTC",
    });
  });

  it("maps week and month buckets to day buckets", () => {
    for (const interval of ["day", "week", "month"] as const) {
      expect(
        performanceRequestWindow(
          { from: now - 30 * 86_400_000, to: now, interval, timeZone: "UTC" },
          now,
        ).interval,
      ).toBe("day");
    }
  });
});
