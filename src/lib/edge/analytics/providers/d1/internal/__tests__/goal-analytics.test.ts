import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  analyticsFilterRegistry,
  attachScopedFilterMetadata,
  createQueryTime,
  createScopedFilterPlan,
  type FilterDocument,
  type FilterFieldId,
  normalizeFilterDocument,
  type ScopedDatasetSql,
} from "@/lib/edge/analytics/contract";
import type { QueryWindow } from "@/lib/edge/analytics/providers/d1/internal/core-types";
import { queryGoalSummaryFromD1 } from "@/lib/edge/analytics/providers/d1/internal/goal-summary";
import {
  queryGoalTimeseriesFromD1,
  withGoalTimeseriesTimestamps,
} from "@/lib/edge/analytics/providers/d1/internal/goal-timeseries";
import { parseFilterDsl } from "@/lib/filter-contract";

type Binding = string | number | null;

class SqliteD1Database {
  readonly database = new DatabaseSync(":memory:");
  readonly calls: string[] = [];

  prepare(sql: string) {
    this.calls.push(sql);
    return {
      bind: (...bindings: Binding[]) => ({
        all: async <T extends object>() => ({
          results: this.database
            .prepare(sql)
            .all(...bindings)
            .map((row) => ({ ...row }) as T),
        }),
      }),
    };
  }
}

const window: QueryWindow = {
  startMs: 0,
  endExclusiveMs: 180_000,
  nowMs: 180_000,
  timeZone: "UTC",
};

const emptyFilter: FilterDocument = { version: 1, root: null };

function goalFilter(root: NonNullable<FilterDocument["root"]>): FilterDocument {
  return normalizeFilterDocument({ version: 1, root }, analyticsFilterRegistry);
}

function dsl(source: string): FilterDocument {
  return parseFilterDsl(source, analyticsFilterRegistry);
}

function field(field: "page.path", value: string) {
  return {
    kind: "condition" as const,
    target: { kind: "field" as const, field: field as FilterFieldId },
    operator: "eq" as const,
    value,
  };
}

function dataset(): ScopedDatasetSql {
  return {
    ctes: `
base_visits AS (
  SELECT 1 AS site_pk, 'visit-1' AS visit_id, 'session-1' AS session_id,
    'visitor-1' AS visitor_id, 1 AS started_at, '/home' AS pathname,
    '' AS event_name, '{}' AS event_data_json
  UNION ALL
  SELECT 1, 'visit-2', 'session-1', 'visitor-1', 61000, '/buy', '', '{}'
  UNION ALL
  SELECT 1, 'visit-3', 'session-2', 'visitor-2', 61001, '/buy', '', '{}'
),
base_events AS (
  SELECT 1 AS site_pk, 'event-1' AS event_id, 'session-1' AS session_id,
    'visitor-1' AS visitor_id, 121000 AS occurred_at, 1 AS sequence,
    '/buy' AS pathname, 'purchase' AS event_name, '{"plan":"pro"}' AS event_data_json
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
    scope: "event",
  };
}

describe("Goal D1 analytics", () => {
  it("reuses a prepared dataset compiled from scoped filter metadata", async () => {
    const d1 = {
      prepare: () => ({
        bind: () => ({
          all: async () => ({ results: [] }),
        }),
      }),
    };
    const plan = createScopedFilterPlan("goal-summary", emptyFilter, "event")!;
    const filters = attachScopedFilterMetadata(emptyFilter, {
      requestedScope: "auto",
      resolvedScope: "event",
      plan,
      time: createQueryTime(0, 180_000, "UTC", 180_000),
      siteIds: ["site-1"],
    });

    await expect(
      queryGoalSummaryFromD1(
        { DB: d1 } as never,
        "site-1",
        window,
        filters,
        emptyFilter,
      ),
    ).resolves.toEqual({
      totalSessions: 0,
      convertedSessions: 0,
      totalVisitors: 0,
      convertedVisitors: 0,
    });
  });

  it("supports the unprepared empty-filter compatibility path and zero-fills empty SQL results", async () => {
    const d1 = {
      prepare: () => ({
        bind: () => ({
          all: async () => ({ results: [] }),
        }),
      }),
    };
    const env = { DB: d1 } as never;

    await expect(
      queryGoalSummaryFromD1(env, "site-1", window, emptyFilter, emptyFilter),
    ).resolves.toEqual({
      totalSessions: 0,
      convertedSessions: 0,
      totalVisitors: 0,
      convertedVisitors: 0,
    });
    await expect(
      queryGoalTimeseriesFromD1(
        env,
        "site-1",
        window,
        "minute",
        emptyFilter,
        emptyFilter,
      ),
    ).resolves.toEqual([
      {
        bucket: 0,
        totalSessions: 0,
        convertedSessions: 0,
        totalVisitors: 0,
        convertedVisitors: 0,
      },
      {
        bucket: 1,
        totalSessions: 0,
        convertedSessions: 0,
        totalVisitors: 0,
        convertedVisitors: 0,
      },
      {
        bucket: 2,
        totalSessions: 0,
        convertedSessions: 0,
        totalVisitors: 0,
        convertedVisitors: 0,
      },
    ]);
  });

  it("normalizes malformed aggregate values and resolves sparse timestamps", async () => {
    const d1 = {
      prepare: () => ({
        bind: () => ({
          all: async () => ({
            results: [
              {
                bucket: null,
                totalSessions: "not-a-number",
                convertedSessions: -1,
                totalVisitors: Number.POSITIVE_INFINITY,
                convertedVisitors: null,
              },
            ],
          }),
        }),
      }),
    };
    const rows = await queryGoalTimeseriesFromD1(
      { DB: d1 } as never,
      "site-1",
      window,
      "minute",
      emptyFilter,
      emptyFilter,
      dataset(),
    );
    expect(rows[0]).toEqual({
      bucket: 0,
      totalSessions: 0,
      convertedSessions: 0,
      totalVisitors: 0,
      convertedVisitors: 0,
    });

    expect(
      withGoalTimeseriesTimestamps(
        [
          {
            bucket: 1,
            totalSessions: 1,
            convertedSessions: 1,
            totalVisitors: 1,
            convertedVisitors: 1,
          },
          {
            bucket: 99,
            totalSessions: 0,
            convertedSessions: 0,
            totalVisitors: 0,
            convertedVisitors: 0,
          },
        ],
        window,
        "minute",
      ),
    ).toEqual([
      {
        bucket: 1,
        totalSessions: 1,
        convertedSessions: 1,
        totalVisitors: 1,
        convertedVisitors: 1,
        timestampMs: 60_000,
      },
      {
        bucket: 99,
        totalSessions: 0,
        convertedSessions: 0,
        totalVisitors: 0,
        convertedVisitors: 0,
        timestampMs: 0,
      },
    ]);
  });

  it("returns one summary row with unique identities and empty identities excluded", async () => {
    const d1 = new SqliteD1Database();
    const result = await queryGoalSummaryFromD1(
      { DB: d1 } as never,
      "site-1",
      window,
      emptyFilter,
      goalFilter(field("page.path", "/buy")),
      dataset(),
    );

    expect(result).toEqual({
      totalSessions: 2,
      convertedSessions: 2,
      totalVisitors: 2,
      convertedVisitors: 2,
    });
    expect(d1.calls).toHaveLength(1);
    expect(d1.calls[0]).toContain("goal_matched_visits");
  });

  it("deduplicates session and visitor independently in every bucket", async () => {
    const d1 = new SqliteD1Database();
    const result = await queryGoalTimeseriesFromD1(
      { DB: d1 } as never,
      "site-1",
      window,
      "minute",
      emptyFilter,
      goalFilter(field("page.path", "/buy")),
      dataset(),
    );

    expect(result).toEqual([
      {
        bucket: 0,
        totalSessions: 1,
        convertedSessions: 0,
        totalVisitors: 1,
        convertedVisitors: 0,
      },
      {
        bucket: 1,
        totalSessions: 2,
        convertedSessions: 2,
        totalVisitors: 2,
        convertedVisitors: 2,
      },
      {
        bucket: 2,
        totalSessions: 1,
        convertedSessions: 1,
        totalVisitors: 1,
        convertedVisitors: 1,
      },
    ]);
    expect(d1.calls).toHaveLength(1);
    expect(d1.calls[0]).toContain("base_bucket_observations");
    expect(d1.calls[0]).toContain("goal_bucket_observations");
  });

  it("keeps a non-empty unprepared global filter from bypassing the scoped dataset", async () => {
    await expect(
      queryGoalSummaryFromD1(
        { DB: new SqliteD1Database() } as never,
        "site-1",
        window,
        goalFilter(field("page.path", "/global")),
        emptyFilter,
      ),
    ).rejects.toThrow("scoped_dataset_required");
    await expect(
      queryGoalTimeseriesFromD1(
        { DB: new SqliteD1Database() } as never,
        "site-1",
        window,
        "minute",
        goalFilter(field("page.path", "/global")),
        emptyFilter,
      ),
    ).rejects.toThrow("scoped_dataset_required");
  });

  it("keeps Goal truth on the shared observation primitive across event, page, payload, boolean, and nested filters", async () => {
    const cases = [
      {
        source: 'event.name eq "purchase"',
        convertedSessions: 2,
        convertedVisitors: 2,
      },
      {
        source: 'event.payload("/plan") eq "pro"',
        convertedSessions: 2,
        convertedVisitors: 2,
      },
      {
        source: 'page.path eq "/checkout"',
        convertedSessions: 1,
        convertedVisitors: 1,
      },
      {
        source: 'page.path eq "/checkout" AND event.name eq "purchase"',
        convertedSessions: 1,
        convertedVisitors: 1,
      },
      {
        source: 'page.path eq "/pricing" OR event.name eq "purchase"',
        convertedSessions: 3,
        convertedVisitors: 3,
      },
      {
        source: 'NOT event.name eq "purchase"',
        convertedSessions: 1,
        convertedVisitors: 1,
      },
      {
        source:
          'AND(OR(page.path eq "/pricing" OR event.name eq "purchase") AND NOT event.name eq "signup")',
        convertedSessions: 2,
        convertedVisitors: 2,
      },
    ] as const;

    for (const testCase of cases) {
      const result = await queryGoalSummaryFromD1(
        { DB: new SqliteD1Database() } as never,
        "site-1",
        window,
        emptyFilter,
        dsl(testCase.source),
        truthDataset(),
      );
      expect(result, testCase.source).toMatchObject({
        totalSessions: 4,
        totalVisitors: 4,
        convertedSessions: testCase.convertedSessions,
        convertedVisitors: testCase.convertedVisitors,
      });
      expect(result.convertedSessions).toBeLessThanOrEqual(
        result.totalSessions,
      );
      expect(result.convertedVisitors).toBeLessThanOrEqual(
        result.totalVisitors,
      );
    }
  });

  it("counts event-only identities, excludes empty identities, and preserves the summary denominator invariant", async () => {
    const d1 = new SqliteD1Database();
    const goal = dsl('event.name eq "purchase"');
    const result = await queryGoalSummaryFromD1(
      { DB: d1 } as never,
      "site-1",
      window,
      emptyFilter,
      goal,
      truthDataset(),
    );
    expect(result).toEqual({
      totalSessions: 4,
      convertedSessions: 2,
      totalVisitors: 4,
      convertedVisitors: 2,
    });
    expect(d1.calls).toHaveLength(1);
    expect(d1.calls[0]).toContain("SELECT COUNT(*) FROM goal_sessions");
  });

  it("keeps identical session and visitor ids separate across site identities", async () => {
    const result = await queryGoalSummaryFromD1(
      { DB: new SqliteD1Database() } as never,
      "site-1",
      window,
      emptyFilter,
      dsl('event.name eq "purchase"'),
      compositeIdentityDataset(),
    );

    expect(result).toEqual({
      totalSessions: 2,
      convertedSessions: 2,
      totalVisitors: 2,
      convertedVisitors: 2,
    });
  });

  it("uses half-open, bucket-local identity sets, including a parent visit outside the window", async () => {
    const d1 = new SqliteD1Database();
    const result = await queryGoalTimeseriesFromD1(
      { DB: d1 } as never,
      "site-1",
      window,
      "minute",
      emptyFilter,
      dsl('event.name eq "purchase"'),
      truthDataset(),
    );
    expect(result).toEqual([
      {
        bucket: 0,
        totalSessions: 1,
        convertedSessions: 1,
        totalVisitors: 1,
        convertedVisitors: 1,
      },
      {
        bucket: 1,
        totalSessions: 3,
        convertedSessions: 2,
        totalVisitors: 3,
        convertedVisitors: 2,
      },
      {
        bucket: 2,
        totalSessions: 2,
        convertedSessions: 0,
        totalVisitors: 2,
        convertedVisitors: 0,
      },
    ]);
    const summary = await queryGoalSummaryFromD1(
      { DB: new SqliteD1Database() } as never,
      "site-1",
      window,
      emptyFilter,
      dsl('event.name eq "purchase"'),
      truthDataset(),
    );
    expect(
      result.reduce((sum, row) => sum + row.convertedVisitors, 0),
    ).toBeGreaterThan(summary.convertedVisitors);
    expect(result[2]?.totalSessions).toBe(2);
  });

  it("supports calendar buckets in a reporting timezone across the DST spring transition", async () => {
    const dstWindow: QueryWindow = {
      startMs: Date.parse("2026-03-08T00:00:00-05:00"),
      endExclusiveMs: Date.parse("2026-03-10T00:00:00-04:00"),
      nowMs: Date.parse("2026-03-10T00:00:00-04:00"),
      timeZone: "America/New_York",
    };
    const result = await queryGoalTimeseriesFromD1(
      { DB: new SqliteD1Database() } as never,
      "site-1",
      dstWindow,
      "day",
      emptyFilter,
      dsl('event.name eq "purchase"'),
      dstDataset(),
    );
    expect(result).toHaveLength(2);
    expect(result.map((row) => row.bucket)).toEqual([0, 1]);
    expect(
      result.every((row) => row.convertedVisitors <= row.totalVisitors),
    ).toBe(true);
  });
});

function truthDataset(): ScopedDatasetSql {
  return {
    ctes: `
base_visits AS (
  SELECT 1 AS site_pk, 'visit-1' AS visit_id, 'session-1' AS session_id,
    'visitor-1' AS visitor_id, 10000 AS started_at, '/home' AS pathname,
    '' AS event_name, '{}' AS event_data_json
  UNION ALL SELECT 1, 'visit-parent-outside', 'session-4', 'visitor-4', -10000, '/parent', '', '{}'
  UNION ALL SELECT 1, 'visit-2', 'session-1', 'visitor-1', 70000, '/checkout', '', '{}'
  UNION ALL SELECT 1, 'visit-3', 'session-2', 'visitor-2', 70000, '/pricing', '', '{}'
  UNION ALL SELECT 1, 'visit-4', 'session-3', 'visitor-3', 130000, '/other', '', '{}'
  UNION ALL SELECT 1, 'visit-empty', '', '', 130000, '/checkout', '', '{}'
),
base_events AS (
  SELECT 1 AS site_pk, 1 AS event_pk, 'event-1' AS event_id, 'session-1' AS session_id,
    'visitor-1' AS visitor_id, 30000 AS occurred_at, 1 AS sequence,
    '/checkout' AS pathname, 'purchase' AS event_name, '{"plan":"pro"}' AS event_data_json
  UNION ALL SELECT 1, 2, 'event-2', 'session-1', 'visitor-1', 90000, 2, '/checkout', 'purchase', '{"plan":"pro"}'
  UNION ALL SELECT 1, 3, 'event-3', 'session-2', 'visitor-2', 120000, 1, '/pricing', 'signup', '{"plan":"basic"}'
  UNION ALL SELECT 1, 4, 'event-4', 'session-4', 'visitor-4', 90000, 1, '/purchase', 'purchase', '{"plan":"pro"}'
  UNION ALL SELECT 1, 5, 'event-empty', '', '', 90000, 1, '/checkout', 'purchase', '{"plan":"pro"}'
),
custom_event_json_paths AS (
  SELECT 1 AS id, 1 AS site_pk, '/plan' AS path
),
custom_event_json_values AS (
  SELECT 1 AS event_pk, 1 AS site_pk, 1 AS path_id, 1 AS value_type, 'pro' AS string_value
  UNION ALL SELECT 2, 1, 1, 1, 'pro'
  UNION ALL SELECT 4, 1, 1, 1, 'pro'
  UNION ALL SELECT 5, 1, 1, 1, 'pro'
),
base_sessions AS (
  SELECT DISTINCT site_pk, session_id FROM base_visits WHERE TRIM(COALESCE(session_id, '')) != ''
  UNION SELECT DISTINCT site_pk, session_id FROM base_events WHERE TRIM(COALESCE(session_id, '')) != ''
),
base_visitors AS (
  SELECT DISTINCT site_pk, visitor_id FROM base_visits WHERE TRIM(COALESCE(visitor_id, '')) != ''
  UNION SELECT DISTINCT site_pk, visitor_id FROM base_events WHERE TRIM(COALESCE(visitor_id, '')) != ''
)`,
    bindings: [],
    visitRelation: "base_visits",
    eventRelation: "base_events",
    sessionRelation: "base_sessions",
    visitorRelation: "base_visitors",
    scope: "event",
  };
}

function dstDataset(): ScopedDatasetSql {
  const first = Date.parse("2026-03-08T16:00:00.000Z");
  const second = Date.parse("2026-03-09T16:00:00.000Z");
  return {
    ctes: `
base_visits AS (
  SELECT 1 AS site_pk, 'dst-visit-1' AS visit_id, 'dst-session-1' AS session_id,
    'dst-visitor-1' AS visitor_id, ${first} AS started_at, '/' AS pathname,
    '' AS event_name, '{}' AS event_data_json
  UNION ALL SELECT 1, 'dst-visit-2', 'dst-session-2', 'dst-visitor-2', ${second}, '/', '', '{}'
),
base_events AS (
  SELECT 1 AS site_pk, 11 AS event_pk, 'dst-event-1' AS event_id, 'dst-session-1' AS session_id,
    'dst-visitor-1' AS visitor_id, ${first} AS occurred_at, 1 AS sequence,
    '/' AS pathname, 'purchase' AS event_name, '{}' AS event_data_json
  UNION ALL SELECT 1, 12, 'dst-event-2', 'dst-session-2', 'dst-visitor-2', ${second}, 1, '/', 'purchase', '{}'
),
base_sessions AS (SELECT DISTINCT site_pk, session_id FROM base_visits),
base_visitors AS (SELECT DISTINCT site_pk, visitor_id FROM base_visits)`,
    bindings: [],
    visitRelation: "base_visits",
    eventRelation: "base_events",
    sessionRelation: "base_sessions",
    visitorRelation: "base_visitors",
    scope: "event",
  };
}

function compositeIdentityDataset(): ScopedDatasetSql {
  return {
    ctes: `
base_visits AS (
  SELECT 1 AS site_pk, 'site-1-visit' AS visit_id, 'same-session' AS session_id,
    'same-visitor' AS visitor_id, 1000 AS started_at, '/' AS pathname,
    '' AS event_name, '{}' AS event_data_json
  UNION ALL SELECT 2, 'site-2-visit', 'same-session', 'same-visitor', 1000, '/', '', '{}'
),
base_events AS (
  SELECT 1 AS site_pk, 21 AS event_pk, 'site-1-event' AS event_id,
    'same-session' AS session_id, 'same-visitor' AS visitor_id, 2000 AS occurred_at,
    1 AS sequence, '/' AS pathname, 'purchase' AS event_name, '{}' AS event_data_json
  UNION ALL SELECT 2, 22, 'site-2-event', 'same-session', 'same-visitor', 2000, 1, '/', 'purchase', '{}'
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
    scope: "event",
  };
}
