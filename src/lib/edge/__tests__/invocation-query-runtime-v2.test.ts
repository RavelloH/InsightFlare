import { afterEach, describe, expect, it, vi } from "vitest";

import { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import { createAnalyticsQueryRuntime } from "@/lib/edge/analytics/composition/query-runtime";
import {
  createQueryTime,
  type OverviewQuery,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { registerInvocationMetrics } from "@/lib/edge/analytics-engine/invocation-writer";
import { instrumentEnv } from "@/lib/edge/observability/bindings";
import {
  createInvocationLogger,
  runWithInvocationLogger,
} from "@/lib/edge/observability/logger";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";

afterEach(() => vi.restoreAllMocks());

describe("v2 Filter-SQL pipeline → trusted Query ID → AE", () => {
  it("captures normalized shape only after validation and attributes actual provider D1 result", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const canary = "CANARY_secret-user-input@private.example";
    const points: Array<{
      indexes: string[];
      blobs: string[];
      doubles: number[];
    }> = [];
    const waits: Promise<unknown>[] = [];
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
      waitUntil: (work) => waits.push(work),
    });
    const statement = {
      all: vi.fn(async () => ({
        results: [],
        meta: {
          rows_read: 450,
          rows_written: 0,
          timings: { sql_duration_ms: 8.5 },
          total_attempts: 1,
        },
      })),
    };
    const env = {
      DB: { prepare: () => statement },
      INVOCATION_METRICS: {
        writeDataPoint: (p: (typeof points)[number]) => points.push(p),
      },
    } as unknown as Env;
    registerInvocationMetrics(env, logger);
    const instrumented = instrumentEnv(env, logger);
    const provider = new AnalyticsProviderRegistry().register("overview", {
      execute: async () => {
        await instrumented.DB.prepare("SELECT 1 WHERE country = ?").all();
        return {
          value: {
            current: {
              views: 1,
              sessions: 1,
              visitors: 1,
              bounces: 0,
              totalDurationMs: 0,
              durationViews: 0,
            },
          },
        };
      },
    });
    const query = {
      context: siteQueryContext("site-1", "private-dashboard"),
      time: createQueryTime(1000, 2000, "UTC", 2000),
      filters: parseFilterDsl(
        `geo.country eq "${canary}"`,
        analyticsFilterRegistry,
      ),
    } as OverviewQuery;
    const result = await runWithInvocationLogger(logger, () =>
      createAnalyticsQueryRuntime(provider).execute("overview", query),
    );
    expect(result.ok).toBe(true);
    logger.emit();
    await Promise.all(waits);
    expect(points).toHaveLength(1);
    const point = points[0];
    expect(point.blobs[13]).toBe("analytics.overview");
    expect(point.blobs[19]).not.toBe("none");
    const details = JSON.parse(point.blobs[18]);
    expect(details.filter.conditionsBucket).toBe("1");
    expect(details.filter.fieldGroups).toContain("geo");
    expect(point.doubles[5]).toBe(450);
    expect(JSON.stringify(point)).not.toContain(canary);
    expect(JSON.stringify(point)).not.toContain("geo.country");
    expect(JSON.stringify(point)).not.toContain("site-1");
  });
});
