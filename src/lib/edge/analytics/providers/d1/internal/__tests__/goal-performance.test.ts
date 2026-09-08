import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { GOAL_TIMESERIES_MAX_BUCKETS } from "@/lib/edge/analytics/application/goal-cost";
import {
  analyticsFilterRegistry,
  type FilterDocument,
} from "@/lib/edge/analytics/contract";
import { buildTimeBuckets } from "@/lib/edge/analytics/providers/d1/internal/core-time";
import type { QueryWindow } from "@/lib/edge/analytics/providers/d1/internal/core-types";
import { queryGoalSummaryFromD1 } from "@/lib/edge/analytics/providers/d1/internal/goal-summary";
import { queryGoalTimeseriesFromD1 } from "@/lib/edge/analytics/providers/d1/internal/goal-timeseries";
import { parseFilterDsl } from "@/lib/filter-contract";

type Binding = string | number | null;

class ExplainableSqliteD1 {
  readonly database = new DatabaseSync(":memory:");
  readonly calls: Array<{ sql: string; bindings: Binding[] }> = [];

  prepare(sql: string) {
    return {
      bind: (...bindings: Binding[]) => ({
        all: async <T extends object>() => {
          this.calls.push({ sql, bindings });
          return {
            results: this.database
              .prepare(sql)
              .all(...bindings)
              .map((row) => ({ ...row }) as T),
          };
        },
      }),
    };
  }
}

const window: QueryWindow = {
  startMs: 0,
  endExclusiveMs: 1_000_000,
  nowMs: 1_000_000,
  timeZone: "UTC",
};
const empty: FilterDocument = { version: 1, root: null };

function structuralWindow(bucketCount: number): QueryWindow {
  const endExclusiveMs = bucketCount * 60_000;
  return {
    startMs: 0,
    endExclusiveMs,
    nowMs: endExclusiveMs,
    timeZone: "UTC",
  };
}

function goal(source: string): FilterDocument {
  return parseFilterDsl(source, analyticsFilterRegistry);
}

function highCardinalityDataset() {
  const series = Array.from(
    { length: 1_000 },
    (_, index) => `(${index + 1})`,
  ).join(",");
  return {
    ctes: `
series(n) AS (
  VALUES ${series}
),
base_visits AS (
  SELECT 1 AS site_pk, 'visit-' || n AS visit_id,
    'session-' || n AS session_id, 'visitor-' || n AS visitor_id,
    (n - 1) * 1000 AS started_at, CASE WHEN n % 3 = 0 THEN '/pricing' ELSE '/home' END AS pathname,
    '' AS event_name, '{}' AS event_data_json
  FROM series
),
base_events AS (
  SELECT 1 AS site_pk, n AS event_pk, 'event-' || n AS event_id,
    'session-' || n AS session_id, 'visitor-' || n AS visitor_id,
    (n - 1) * 1000 + 500 AS occurred_at, 1 AS sequence,
    '/checkout' AS pathname,
    CASE WHEN n % 2 = 0 THEN 'purchase' ELSE 'signup' END AS event_name,
    '{"plan":"pro"}' AS event_data_json
  FROM series
),
custom_event_json_paths AS (
  SELECT 1 AS id, 1 AS site_pk, '/plan' AS path
),
custom_event_json_values AS (
  SELECT n AS event_pk, 1 AS site_pk, 1 AS path_id, 1 AS value_type, 'pro' AS string_value
  FROM series
),
base_sessions AS (
  SELECT DISTINCT site_pk, session_id FROM base_visits
  UNION SELECT DISTINCT site_pk, session_id FROM base_events
),
base_visitors AS (
  SELECT DISTINCT site_pk, visitor_id FROM base_visits
  UNION SELECT DISTINCT site_pk, visitor_id FROM base_events
)`,
    bindings: [],
    visitRelation: "base_visits",
    eventRelation: "base_events",
    sessionRelation: "base_sessions",
    visitorRelation: "base_visitors",
    scope: "event" as const,
  };
}

describe("Goal D1 performance fixture", () => {
  it("records SQL shape, bindings, EXPLAIN, and execution for simple/complex summary and timeseries", async () => {
    const d1 = new ExplainableSqliteD1();
    const dataset = highCardinalityDataset();
    const simple = goal('event.name eq "purchase"');
    const complex = goal(
      'event.name eq "purchase" AND event.payload("/plan") eq "pro"',
    );
    const started = performance.now();
    await queryGoalSummaryFromD1(
      { DB: d1 } as never,
      "site-1",
      window,
      empty,
      simple,
      dataset,
    );
    await queryGoalSummaryFromD1(
      { DB: d1 } as never,
      "site-1",
      window,
      empty,
      complex,
      dataset,
    );
    await queryGoalTimeseriesFromD1(
      { DB: d1 } as never,
      "site-1",
      window,
      "hour",
      empty,
      simple,
      dataset,
    );
    await queryGoalTimeseriesFromD1(
      { DB: d1 } as never,
      "site-1",
      window,
      "hour",
      empty,
      complex,
      dataset,
    );
    const elapsedMs = performance.now() - started;

    expect(elapsedMs).toBeGreaterThanOrEqual(0);
    expect(d1.calls).toHaveLength(4);
    expect(d1.calls[0]!.sql).toContain("SELECT COUNT(*) FROM goal_sessions");
    expect(d1.calls[2]!.sql).toContain("base_bucket_observations");
    expect(d1.calls[2]!.sql).toContain("goal_bucket_observations");
    expect(d1.calls[0]!.bindings.length).toBeLessThan(20);
    expect(d1.calls[1]!.bindings.length).toBeGreaterThan(
      d1.calls[0]!.bindings.length,
    );
    for (const call of d1.calls) {
      expect(call.sql.length).toBeLessThan(250_000);
      const plan = d1.database
        .prepare(`EXPLAIN QUERY PLAN ${call.sql}`)
        .all(...call.bindings);
      expect(plan.length).toBeGreaterThan(0);
      expect(
        call.sql.match(/SELECT COUNT\(\*\) FROM/g)?.length ?? 0,
      ).toBeLessThanOrEqual(4);
    }
  });

  it.each([1, 100, 500, GOAL_TIMESERIES_MAX_BUCKETS])(
    "keeps the %i-calendar-bucket Goal timeseries executable",
    async (bucketCount) => {
      const d1 = new ExplainableSqliteD1();
      const fixtureWindow = structuralWindow(bucketCount);
      const calendarBuckets = buildTimeBuckets(fixtureWindow, "minute");
      const dataset = highCardinalityDataset();
      const simple = goal('event.name eq "purchase"');
      const complex = goal(
        'event.name eq "purchase" AND event.payload("/plan") eq "pro"',
      );

      expect(calendarBuckets).toHaveLength(bucketCount);
      expect(calendarBuckets[bucketCount - 1]?.index).toBe(bucketCount - 1);

      const simpleRows = await queryGoalTimeseriesFromD1(
        { DB: d1 } as never,
        "site-1",
        fixtureWindow,
        "minute",
        empty,
        simple,
        dataset,
      );
      const complexRows = await queryGoalTimeseriesFromD1(
        { DB: d1 } as never,
        "site-1",
        fixtureWindow,
        "minute",
        empty,
        complex,
        dataset,
      );

      expect(simpleRows).toHaveLength(bucketCount);
      expect(complexRows).toHaveLength(bucketCount);
      expect(simpleRows.map((row) => row.bucket)).toEqual(
        calendarBuckets.map((bucket) => bucket.index),
      );
      expect(complexRows.map((row) => row.bucket)).toEqual(
        calendarBuckets.map((bucket) => bucket.index),
      );
      expect(d1.calls).toHaveLength(2);
      expect(d1.calls[1]!.bindings.length).toBeGreaterThan(
        d1.calls[0]!.bindings.length,
      );

      for (const call of d1.calls) {
        expect(call.sql.length).toBeLessThan(300_000);
        expect(call.sql.match(/\?/g)?.length ?? 0).toBe(call.bindings.length);
        const plan = d1.database
          .prepare(`EXPLAIN QUERY PLAN ${call.sql}`)
          .all(...call.bindings);
        expect(plan.length).toBeGreaterThan(0);
      }
    },
  );
});
