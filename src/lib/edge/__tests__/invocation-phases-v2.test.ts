import { afterEach, describe, expect, it, vi } from "vitest";

import { HotspotCollector } from "@/lib/edge/analytics-engine/hotspot-collector";
import {
  v2BooleanFlag,
  v2CoverageFlag,
} from "@/lib/edge/analytics-engine/invocation-schema-v2";
import {
  encodeInvocationMetricsPoint,
  encodeInvocationMetricsPointV2,
  registerInvocationMetrics,
} from "@/lib/edge/analytics-engine/invocation-writer";
import { instrumentEnv } from "@/lib/edge/observability/bindings";
import {
  createInvocationLogger,
  runWithInvocationLogger,
} from "@/lib/edge/observability/logger";
import type { Env } from "@/lib/edge/types";

afterEach(() => vi.restoreAllMocks());

describe("v2 actual phases and execution isolation", () => {
  it("measures real DO fetch wait and retains accurate API route classification", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const pending: Promise<unknown>[] = [];
    const points: Array<{
      indexes: string[];
      blobs: string[];
      doubles: number[];
    }> = [];
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
      waitUntil: (p) => pending.push(p),
    });
    const stub = {
      fetch: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 7));
        return new Response(null, { status: 204 });
      }),
    };
    const env = {
      INVOCATION_METRICS: {
        writeDataPoint: (p: (typeof points)[number]) => points.push(p),
      },
      INGEST_DO: { get: () => stub } as unknown as DurableObjectNamespace,
    } as unknown as Env;
    registerInvocationMetrics(env, logger);
    const wrapped = instrumentEnv(env, logger);
    const response = await runWithInvocationLogger(logger, () =>
      wrapped.INGEST_DO.get("mock-id" as never).fetch(
        "https://test.internal/ingest",
      ),
    );
    expect(response.status).toBe(204);
    logger.setRouteKey("api:/collect");
    logger.setRequest({
      route: "unmatched",
      method: "POST",
      status: 204,
      outcome: "ok",
    });
    await logger.emitWhenComplete();
    await Promise.all(pending);
    expect(points).toHaveLength(1);
    const point = points[0];
    expect(point.blobs[2]).toBe("api");
    expect(point.blobs[3]).toBe("api:/collect");
    expect(point.doubles[10]).toBe(1);
    expect(point.doubles[11]).toBeGreaterThan(0);
    expect(point.blobs[17]).toBe("do.fetch");
    expect(v2CoverageFlag(point.doubles[18], "doFetchWall")).toBe("complete");
    expect(v2BooleanFlag(point.doubles[18], "backgroundDrainPresent")).toBe(
      true,
    );
  });

  it("measures actual tracked background drain rather than subtracting handler time", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const pending: Promise<unknown>[] = [];
    const points: Array<{
      indexes: string[];
      blobs: string[];
      doubles: number[];
    }> = [];
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
      waitUntil: (p) => pending.push(p),
    });
    registerInvocationMetrics(
      {
        INVOCATION_METRICS: {
          writeDataPoint: (p: (typeof points)[number]) => points.push(p),
        },
      } as unknown as Env,
      logger,
    );
    logger.setRequest({
      route: "page",
      method: "GET",
      status: 200,
      outcome: "ok",
    });
    logger.track(new Promise((resolve) => setTimeout(resolve, 9)));
    await logger.emitWhenComplete();
    await Promise.all(pending);
    expect(points).toHaveLength(1);
    expect(points[0].doubles[2]).toBeGreaterThanOrEqual(7);
    expect(v2BooleanFlag(points[0].doubles[18], "backgroundDrainPresent")).toBe(
      true,
    );
    const detail = JSON.parse(points[0].blobs[18]);
    expect(
      detail.phases.some((p: { id: string }) => p.id === "background.drain"),
    ).toBe(true);
  });

  it("bounds many trusted query groups, retains hot and scan IDs, and never exposes data canaries", () => {
    const collector = new HotspotCollector();
    const operations = [
      "overview",
      "trend",
      "comparison",
      "dimension",
      "pages",
      "referrers",
      "channels",
      "filter-values",
      "retention",
      "performance",
      "realtime",
      "event-summary",
      "event-trend",
      "event-types",
      "event-type-detail",
      "event-fields",
      "event-field-values",
      "event-context",
      "event-records",
      "visitor-events",
      "visitor-sessions",
      "session-events",
      "event-record-detail",
      "visitors",
      "visitor-detail",
      "sessions",
      "session-detail",
      "funnel-analysis",
      "goal-summary",
      "goal-timeseries",
      "team-dashboard",
      "explore",
      "geo-points",
    ];
    for (let i = 0; i < operations.length; i++)
      collector.record({
        identity: { id: `analytics.${operations[i]}`, variant: "raw.filtered" },
        apiWallMs: i + 1,
        rowsRead: i * 100,
        sqlEngineMs: 0.1,
      });
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
    });
    logger.setPerformance({ d1Statements: operations.length });
    const point = encodeInvocationMetricsPointV2(
      logger.snapshot(),
      collector.snapshot(),
    );
    const json = JSON.parse(point.blobs[18]);
    expect(json.queries.length).toBeLessThanOrEqual(6);
    expect(json.truncation.queriesDropped).toBeGreaterThan(0);
    expect(v2BooleanFlag(point.doubles[18], "detailsTruncated")).toBe(true);
    // The last distinct Query ID is deliberately beyond the old 32-entry cap.
    // It must not disappear merely because earlier, cheaper queries ran first.
    expect(point.blobs[13]).toBe("analytics.geo-points");
    expect(point.blobs[16]).toBe("analytics.geo-points");
    expect(json.coverage.query).toBe("partial");
    expect(json.coverage.queryGranularity).toBe("provider-family");
    expect(v2BooleanFlag(point.doubles[18], "queryAttributionComplete")).toBe(
      false,
    );
    expect(
      new TextEncoder().encode(point.blobs[18]).length,
    ).toBeLessThanOrEqual(4096);
  });

  it("has bounded CPU overhead for typical encoding and only one physical point", () => {
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
    });
    const collector = new HotspotCollector();
    collector.record({
      identity: { id: "analytics.overview", variant: "unknown" },
      apiWallMs: 8,
      rowsRead: 120,
      sqlEngineMs: 5,
    });
    const snapshot = logger.snapshot();
    const hot = collector.snapshot();
    // Compare v1/v2 encoder work on identical safe snapshots, without D1
    // network latency, test assertions, or per-request input allocations.
    for (let i = 0; i < 64; i++) {
      encodeInvocationMetricsPoint(snapshot);
      encodeInvocationMetricsPointV2(snapshot, hot);
    }
    const iterations = 3000;
    const v1Start = performance.now();
    for (let i = 0; i < iterations; i++) encodeInvocationMetricsPoint(snapshot);
    const v1Ms = performance.now() - v1Start;
    const v2Start = performance.now();
    for (let i = 0; i < iterations; i++)
      encodeInvocationMetricsPointV2(snapshot, hot);
    const v2Ms = performance.now() - v2Start;
    const onePoint = encodeInvocationMetricsPointV2(snapshot, hot);
    expect(onePoint.doubles[19]).toBe(2);
    expect(onePoint.blobs).toHaveLength(20);
    expect(onePoint.doubles).toHaveLength(20);
    // Conservative CI safety ceiling, not a guarantee of Worker CPU time.
    expect(v2Ms).toBeLessThan(6000);
    console.info(
      `AE_V2_BENCH iterations=${iterations} v1_ms=${v1Ms.toFixed(2)} v2_ms=${v2Ms.toFixed(2)} v2_ms_per_point=${(v2Ms / iterations).toFixed(4)}`,
    );
  });
});
