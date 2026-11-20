import { describe, expect, it, vi } from "vitest";

import {
  queryOverviewAggregate,
  queryOverviewFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/overview";
import { registerInvocationMetrics } from "@/lib/edge/analytics-engine/invocation-writer";
import {
  QUERY_REGISTRY,
  registeredProviderQuery,
  runWithQueryIdentity,
} from "@/lib/edge/analytics-engine/query-registry";
import { instrumentEnv } from "@/lib/edge/observability/bindings";
import {
  createInvocationLogger,
  runWithInvocationLogger,
} from "@/lib/edge/observability/logger";
import type { Env } from "@/lib/edge/types";

const WINDOW = {
  startMs: 1_700_000_000_000,
  endExclusiveMs: 1_700_003_600_000,
  nowMs: 1_700_003_600_000,
  timeZone: "UTC",
};
const NO_FILTER = { version: 1 as const, root: null };
function fixture(options: { rollupThroughHour?: number } = {}) {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const points: Array<{
    blobs: string[];
    doubles: number[];
    indexes: string[];
  }> = [];
  const work: Promise<unknown>[] = [];
  const logger = createInvocationLogger({
    source: "worker",
    trigger: "request",
    waitUntil: (task) => work.push(task),
  });
  const calls: string[] = [];
  const db = {
    prepare: (sql: string) => {
      calls.push(sql);
      return {
        bind() {
          return this;
        },
        async all() {
          const state = sql.includes("visit_hourly_aggregation_state");
          return {
            results: state
              ? options.rollupThroughHour === undefined
                ? []
                : [
                    {
                      siteId: "site-safe",
                      aggregatedUntilHour: options.rollupThroughHour,
                    },
                  ]
              : sql.includes("visit_hourly_rollups")
                ? []
                : [
                    {
                      views: 3,
                      sessions: 1,
                      visitors: 1,
                      bounces: 0,
                      totalDuration: 9,
                      durationViews: 1,
                    },
                  ],
            meta: {
              rows_read: state ? 1 : 55,
              rows_written: 0,
              timings: { sql_duration_ms: 5 },
              total_attempts: 1,
            },
          };
        },
      };
    },
  };
  const env = {
    DB: db,
    INVOCATION_METRICS: {
      writeDataPoint: (point: (typeof points)[number]) => points.push(point),
    },
  } as unknown as Env;
  registerInvocationMetrics(env, logger);
  return {
    env: instrumentEnv(env, logger),
    logger,
    calls,
    emit: async () => {
      logger.emit();
      await Promise.all(work);
      expect(points).toHaveLength(1);
      return points[0];
    },
  };
}

describe("review R1 F3: production SQL entrypoints emit template identities and real variants", () => {
  it("maps the actual raw overview SQL to a concrete versioned template", async () => {
    const f = fixture();
    await runWithInvocationLogger(f.logger, () =>
      runWithQueryIdentity(
        { id: registeredProviderQuery("overview"), variant: "unknown" },
        () => queryOverviewFromD1(f.env, "site-safe", WINDOW, NO_FILTER),
      ),
    );
    const p = await f.emit();
    expect(f.calls).toHaveLength(1);
    expect(QUERY_REGISTRY.has("analytics.overview.raw.summary")).toBe(true);
    expect(p.blobs[13]).toBe("analytics.overview.raw.summary");
    expect(p.blobs[14]).toBe("raw.unfiltered");
    expect(JSON.parse(p.blobs[18]).coverage.queryGranularity).toBe(
      "sql-template",
    );
  });

  it("identifies an actual hourly-rollup execution with only rollup SQL templates", async () => {
    const hour = 3_600_000;
    const startMs = Math.ceil(WINDOW.startMs / hour) * hour;
    const endExclusiveMs = startMs + 2 * hour;
    const f = fixture({ rollupThroughHour: endExclusiveMs / hour - 1 });
    const actual = await runWithInvocationLogger(f.logger, () =>
      runWithQueryIdentity(
        { id: registeredProviderQuery("overview"), variant: "unknown" },
        () =>
          queryOverviewAggregate(
            f.env,
            "site-safe",
            {
              ...WINDOW,
              startMs,
              endExclusiveMs,
              nowMs: endExclusiveMs,
            },
            NO_FILTER,
          ),
      ),
    );
    expect(actual.diagnosticSource).toBe("rollup");
    const point = await f.emit();
    const details = JSON.parse(point.blobs[18]);
    expect(details.queries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "analytics.rollup.aggregation_state",
          variant: "rollup",
          granularity: "sql-template",
        }),
        expect.objectContaining({
          id: "analytics.rollup.hourly_rows",
          variant: "rollup",
          granularity: "sql-template",
        }),
      ]),
    );
    expect(
      details.queries.every((q: { variant: string }) => q.variant === "rollup"),
    ).toBe(true);
    expect(details.coverage.queryGranularity).toBe("sql-template");
    expect(f.calls).toHaveLength(2);
  });

  it("labels real rollup-state SQL separately from raw fallback without misclassifying either", async () => {
    const f = fixture();
    await runWithInvocationLogger(f.logger, () =>
      runWithQueryIdentity(
        { id: registeredProviderQuery("overview"), variant: "unknown" },
        () => queryOverviewAggregate(f.env, "site-safe", WINDOW, NO_FILTER),
      ),
    );
    const p = await f.emit();
    const queries = JSON.parse(p.blobs[18]).queries as Array<{
      id: string;
      variant: string;
    }>;
    expect(
      f.calls.some((sql) => sql.includes("visit_hourly_aggregation_state")),
    ).toBe(true);
    expect(queries).toContainEqual(
      expect.objectContaining({
        id: "analytics.rollup.aggregation_state",
        variant: "rollup",
      }),
    );
    expect(queries).toContainEqual(
      expect.objectContaining({
        id: "analytics.overview.raw.summary",
        variant: "raw.unfiltered",
      }),
    );
  });
});
