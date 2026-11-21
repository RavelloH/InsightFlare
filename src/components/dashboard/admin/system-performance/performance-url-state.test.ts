import { describe, expect, it } from "vitest";

import {
  patchPerformanceSearch,
  performanceWindow,
  readPerformanceState,
} from "@/components/dashboard/admin/system-performance/performance-url-state";

describe("system performance URL state and bounded windows", () => {
  const now = Date.UTC(2026, 10, 22, 6, 0);
  it("restores the view, route, hotspot kind, app version and a 6h window", () => {
    const state = readPerformanceState(
      new URLSearchParams(
        "perfTab=hotspots&perfRange=6h&hotspotKind=scan&routeKey=api%3A%2Fcollect&appVersion=1.2.3%2Babcdef123456&perfSource=worker",
      ),
      now,
    );
    expect(state).toMatchObject({
      view: "hotspots",
      kind: "scan",
      routeKey: "api:/collect",
      appVersion: "1.2.3+abcdef123456",
      range: "6h",
      source: "worker",
    });
    const window = performanceWindow(state, now);
    expect(window).toMatchObject({
      to: now - 3000,
      from: now - 3000 - 6 * 3_600_000,
      interval: "hour",
    });
  });
  it("restores a custom historical interval and leaves unrelated dashboard URL params intact", () => {
    const from = now - 3 * 86_400_000;
    const to = now - 86_400_000;
    const p = patchPerformanceSearch(new URLSearchParams("range=7d&foo=keep"), {
      perfRange: "custom",
      perfFrom: String(from),
      perfTo: String(to),
      perfTab: "samples",
      sampleQueryId: "analytics.overview.raw.summary",
      sampleKind: "api-hot",
    });
    const state = readPerformanceState(p, now);
    expect(performanceWindow(state, now)).toMatchObject({
      from,
      to,
      interval: "hour",
    });
    expect(p.get("foo")).toBe("keep");
    expect(p.get("range")).toBe("7d");
    expect(state.view).toBe("samples");
    expect(state.sampleKind).toBe("api-hot");
    expect(
      patchPerformanceSearch(p, { sampleQueryId: null, sampleKind: null }).has(
        "sampleQueryId",
      ),
    ).toBe(false);
  });
  it("rejects invalid or >90-day custom windows and unsafe route/version payloads", () => {
    const invalid = readPerformanceState(
      new URLSearchParams({
        perfRange: "custom",
        perfFrom: String(now - 91 * 86_400_000),
        perfTo: String(now + 1000),
        perfTab: "invalid",
        routeKey: "api:/collect' OR 1=1",
        appVersion: "1.2.3';DROP TABLE",
      }),
      now,
    );
    expect(invalid.range).toBe("24h");
    expect(invalid.view).toBe("overview");
    expect(invalid.routeKey).toBe("");
    expect(invalid.appVersion).toBe("");
  });
});
