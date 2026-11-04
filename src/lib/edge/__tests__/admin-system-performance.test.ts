import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  assertD1StatementBudget,
  compileD1Query,
  type DatabaseQueryObservation,
  registerDatabaseQueryObserver,
} from "@/lib/db";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { compileD1QueryUnoptimizedForTest } from "@/lib/db/query/compiler";
import {
  handleDoDiagnosticAdmin,
  handleE2eFlushAdmin,
  handleSystemPerformanceAdmin,
} from "@/lib/edge/admin/system/handler";
import {
  buildDoDiagnosticSitesQuery,
  buildE2eFlushSiteQuery,
} from "@/lib/edge/admin/system/query-plan";
import {
  buildSystemPerformanceOpenVisitsQuery,
  buildSystemPerformancePercentileQuery,
  buildSystemPerformanceSlowEventsQuery,
  buildSystemPerformanceSummaryQuery,
  buildSystemPerformanceTopSitesQuery,
  buildSystemPerformanceTrendQuery,
} from "@/lib/edge/admin/system/query-plan";
import type { Env } from "@/lib/edge/types";

const NOW_MS = Date.UTC(2026, 9, 1, 12, 0, 0);
const NOW_SECONDS = Math.floor(NOW_MS / 1000);
const TRUSTED_LATENCY_MAX_MS = 24 * 60 * 60 * 1000;
const DELAYED_EVENT_MS = 5 * 60 * 1000;
const FUTURE_SKEW_MS = 30 * 1000;
const databases = new Set<DatabaseSync>();
type Row = Record<string, unknown>;
type Query = {
  readonly sql: string;
  readonly bindings?: readonly unknown[];
};

function createFixture() {
  const database = createMigratedDatabase();
  databases.add(database);
  database.exec("PRAGMA foreign_keys = OFF");
  database
    .prepare(
      `INSERT INTO sites (id, team_id, name, domain, created_at)
     VALUES (?, 'team', ?, ?, ?)`,
    )
    .run("site-a", "Site A", "a.example.test", NOW_SECONDS - 10);
  database
    .prepare(
      `INSERT INTO sites (id, team_id, name, domain, created_at)
     VALUES (?, 'team', ?, ?, ?)`,
    )
    .run("site-b", "Site B", "b.example.test", NOW_SECONDS - 5);

  function addVisit(input: {
    readonly id: string;
    readonly siteId: string;
    readonly createdAtSec: number;
    readonly latencyMs: number;
    readonly status?: string;
    readonly lastActivityAt?: number;
  }) {
    const serverAtMs = input.createdAtSec * 1000;
    database
      .prepare(
        `INSERT INTO visits (
          visit_id, site_id, visitor_id, session_id, status, started_at,
          last_activity_at, pathname, hostname, created_at, site_pk
        ) VALUES (?, ?, ?, ?, ?, ?, ?, '/', 'example.test', ?, 1)`,
      )
      .run(
        input.id,
        input.siteId,
        "visitor",
        `session-${input.id}`,
        input.status ?? "complete",
        serverAtMs - input.latencyMs,
        input.lastActivityAt ?? serverAtMs,
        input.createdAtSec,
      );
  }

  function addCustomEvent(input: {
    readonly id: string;
    readonly siteId: string;
    readonly createdAtSec: number;
    readonly latencyMs: number;
  }) {
    const serverAtMs = input.createdAtSec * 1000;
    database
      .prepare(
        `INSERT INTO custom_events (
          event_id, site_id, visit_id, event_name_id, occurred_at,
          received_at, node_count, value_count, created_at, site_pk
        ) VALUES (?, ?, 'unpersisted-visit', 1, ?, ?, 0, 0, ?, 1)`,
      )
      .run(
        input.id,
        input.siteId,
        serverAtMs - input.latencyMs,
        serverAtMs,
        input.createdAtSec,
      );
  }

  return { database, addVisit, addCustomEvent };
}

function seedContractRows(
  addVisit: ReturnType<typeof createFixture>["addVisit"],
  addCustomEvent: ReturnType<typeof createFixture>["addCustomEvent"],
  fromSec: number,
  toSec: number,
) {
  addVisit({
    id: "visit-from-inclusive",
    siteId: "site-a",
    createdAtSec: fromSec,
    latencyMs: 0,
  });
  addVisit({
    id: "visit-delayed-a",
    siteId: "site-a",
    createdAtSec: toSec - 3,
    latencyMs: DELAYED_EVENT_MS + 1,
  });
  addVisit({
    id: "visit-to-inclusive",
    siteId: "site-b",
    createdAtSec: toSec,
    latencyMs: 1,
  });
  addVisit({
    id: "visit-delayed-b",
    siteId: "site-a",
    createdAtSec: toSec - 3,
    latencyMs: DELAYED_EVENT_MS + 1,
  });
  addVisit({
    id: "visit-future-boundary",
    siteId: "site-b",
    createdAtSec: toSec - 4,
    latencyMs: -FUTURE_SKEW_MS,
  });
  addVisit({
    id: "visit-future-skewed",
    siteId: "unknown-site",
    createdAtSec: toSec - 5,
    latencyMs: -FUTURE_SKEW_MS - 1,
  });
  addVisit({
    id: "visit-trusted-upper-boundary",
    siteId: "site-b",
    createdAtSec: toSec - 6,
    latencyMs: TRUSTED_LATENCY_MAX_MS,
  });
  addVisit({
    id: "visit-untrusted-upper-boundary",
    siteId: "site-b",
    createdAtSec: toSec - 7,
    latencyMs: TRUSTED_LATENCY_MAX_MS + 1,
  });
  addVisit({
    id: "visit-second-bucket",
    siteId: "site-b",
    createdAtSec: fromSec + 5,
    latencyMs: 100,
  });
  addVisit({
    id: "visit-untrusted-only-bucket",
    siteId: "site-b",
    createdAtSec: toSec - 300,
    latencyMs: TRUSTED_LATENCY_MAX_MS + 1,
  });
  addVisit({
    id: "visit-outside-created-at-window",
    siteId: "site-a",
    createdAtSec: fromSec - 1,
    latencyMs: 1,
  });
  addVisit({
    id: "open-exactly-stale",
    siteId: "site-a",
    createdAtSec: toSec - 8,
    latencyMs: 0,
    status: "open",
    lastActivityAt: NOW_MS - 30 * 60 * 1000,
  });
  addVisit({
    id: "open-timed-out",
    siteId: "site-b",
    createdAtSec: toSec - 9,
    latencyMs: 0,
    status: "open",
    lastActivityAt: NOW_MS - 12 * 60 * 60 * 1000 - 1,
  });
  addVisit({
    id: "open-future-activity",
    siteId: "site-a",
    createdAtSec: toSec - 10,
    latencyMs: 0,
    status: "open",
    lastActivityAt: NOW_MS + 1,
  });
  addCustomEvent({
    id: "event-upper-inclusive",
    siteId: "site-a",
    createdAtSec: toSec,
    latencyMs: DELAYED_EVENT_MS,
  });
  addCustomEvent({
    id: "event-from-inclusive",
    siteId: "site-a",
    createdAtSec: fromSec,
    latencyMs: 2,
  });
  addCustomEvent({
    id: "event-future-skewed",
    siteId: "site-a",
    createdAtSec: toSec - 2,
    latencyMs: -FUTURE_SKEW_MS - 1,
  });
  addCustomEvent({
    id: "event-untrusted-upper-boundary",
    siteId: "unknown-site",
    createdAtSec: toSec - 11,
    latencyMs: TRUSTED_LATENCY_MAX_MS + 1,
  });
  addCustomEvent({
    id: "event-outside-created-at-window",
    siteId: "site-a",
    createdAtSec: fromSec - 1,
    latencyMs: 1,
  });
}

function legacyEventCte(fromSec: number, toSec: number, materialized = false) {
  return `
    WITH raw_events AS (
      SELECT
        'visit' AS kind,
        site_id AS siteId,
        started_at AS eventAtMs,
        created_at * 1000 AS serverAtMs,
        created_at AS createdAtSec
      FROM visits
      WHERE created_at >= ? AND created_at <= ?
      UNION ALL
      SELECT
        'custom_event' AS kind,
        site_id AS siteId,
        occurred_at AS eventAtMs,
        created_at * 1000 AS serverAtMs,
        created_at AS createdAtSec
      FROM custom_events
      WHERE created_at >= ? AND created_at <= ?
    ),
    events AS${materialized ? " MATERIALIZED" : ""} (
      SELECT
        kind,
        siteId,
        eventAtMs,
        serverAtMs,
        createdAtSec,
        serverAtMs - eventAtMs AS latencyMs
      FROM raw_events
    )
  `;
}

function legacyQueries(
  fromSec: number,
  toSec: number,
  bucketSizeSec: number,
  generatedAt: number,
): readonly Query[] {
  const eventBindings = [fromSec, toSec, fromSec, toSec];
  return [
    {
      sql: `${legacyEventCte(fromSec, toSec)}
        SELECT
          COUNT(*) AS totalEvents,
          SUM(CASE WHEN kind = 'visit' THEN 1 ELSE 0 END) AS visits,
          SUM(CASE WHEN kind = 'custom_event' THEN 1 ELSE 0 END) AS customEvents,
          COUNT(DISTINCT siteId) AS activeSites,
          AVG(CASE WHEN latencyMs >= 0 AND latencyMs <= ? THEN latencyMs END) AS avgLatencyMs,
          SUM(CASE WHEN latencyMs >= 0 AND latencyMs <= ? THEN 1 ELSE 0 END) AS trustedLatencySamples,
          SUM(CASE WHEN latencyMs > ? THEN 1 ELSE 0 END) AS delayedEvents,
          SUM(CASE WHEN latencyMs < -? THEN 1 ELSE 0 END) AS futureSkewedEvents,
          MAX(createdAtSec) AS latestCreatedAtSec
        FROM events`,
      bindings: [
        ...eventBindings,
        TRUSTED_LATENCY_MAX_MS,
        TRUSTED_LATENCY_MAX_MS,
        DELAYED_EVENT_MS,
        FUTURE_SKEW_MS,
      ],
    },
    {
      sql: `${legacyEventCte(fromSec, toSec)},
        valid_latency AS (
          SELECT latencyMs FROM events
          WHERE latencyMs >= 0 AND latencyMs <= ?
        ),
        ranked_latency AS (
          SELECT
            latencyMs,
            ROW_NUMBER() OVER (ORDER BY latencyMs) AS rn,
            COUNT(*) OVER () AS total
          FROM valid_latency
        )
        SELECT
          MIN(CASE WHEN rn >= total * 0.5 THEN latencyMs END) AS p50LatencyMs,
          MIN(CASE WHEN rn >= total * 0.75 THEN latencyMs END) AS p75LatencyMs,
          MIN(CASE WHEN rn >= total * 0.95 THEN latencyMs END) AS p95LatencyMs
        FROM ranked_latency`,
      bindings: [...eventBindings, TRUSTED_LATENCY_MAX_MS],
    },
    {
      sql: `${legacyEventCte(fromSec, toSec, true)},
        trend_aggregate AS (
          SELECT
            CAST(createdAtSec / ? AS INTEGER) * ? AS bucketSec,
            SUM(CASE WHEN kind = 'visit' THEN 1 ELSE 0 END) AS visits,
            SUM(CASE WHEN kind = 'custom_event' THEN 1 ELSE 0 END) AS customEvents,
            COUNT(*) AS totalEvents,
            AVG(CASE WHEN latencyMs >= 0 AND latencyMs <= ? THEN latencyMs END) AS avgLatencyMs,
            SUM(CASE WHEN latencyMs > ? THEN 1 ELSE 0 END) AS delayedEvents,
            SUM(CASE WHEN latencyMs < -? THEN 1 ELSE 0 END) AS futureSkewedEvents
          FROM events
          GROUP BY bucketSec
        ),
        valid_bucket_latency AS (
          SELECT
            CAST(createdAtSec / ? AS INTEGER) * ? AS bucketSec,
            latencyMs
          FROM events
          WHERE latencyMs >= 0 AND latencyMs <= ?
        ),
        ranked_bucket_latency AS (
          SELECT
            bucketSec,
            latencyMs,
            ROW_NUMBER() OVER (PARTITION BY bucketSec ORDER BY latencyMs) AS rn,
            COUNT(*) OVER (PARTITION BY bucketSec) AS total
          FROM valid_bucket_latency
        ),
        bucket_percentiles AS (
          SELECT
            bucketSec,
            MIN(CASE WHEN rn >= total * 0.5 THEN latencyMs END) AS p50LatencyMs,
            MIN(CASE WHEN rn >= total * 0.75 THEN latencyMs END) AS p75LatencyMs,
            MIN(CASE WHEN rn >= total * 0.95 THEN latencyMs END) AS p95LatencyMs
          FROM ranked_bucket_latency
          GROUP BY bucketSec
        )
        SELECT
          a.bucketSec,
          a.visits,
          a.customEvents,
          a.totalEvents,
          a.avgLatencyMs,
          p.p50LatencyMs,
          p.p75LatencyMs,
          p.p95LatencyMs,
          a.delayedEvents,
          a.futureSkewedEvents
        FROM trend_aggregate a
        LEFT JOIN bucket_percentiles p ON p.bucketSec = a.bucketSec
        ORDER BY a.bucketSec ASC`,
      bindings: [
        ...eventBindings,
        bucketSizeSec,
        bucketSizeSec,
        TRUSTED_LATENCY_MAX_MS,
        DELAYED_EVENT_MS,
        FUTURE_SKEW_MS,
        bucketSizeSec,
        bucketSizeSec,
        TRUSTED_LATENCY_MAX_MS,
      ],
    },
    {
      sql: `${legacyEventCte(fromSec, toSec)}
        SELECT
          e.siteId,
          COALESCE(s.name, e.siteId) AS siteName,
          COALESCE(s.domain, '') AS siteDomain,
          COUNT(*) AS totalEvents,
          SUM(CASE WHEN e.kind = 'visit' THEN 1 ELSE 0 END) AS visits,
          SUM(CASE WHEN e.kind = 'custom_event' THEN 1 ELSE 0 END) AS customEvents,
          AVG(CASE WHEN e.latencyMs >= 0 AND e.latencyMs <= ? THEN e.latencyMs END) AS avgLatencyMs,
          SUM(CASE WHEN e.latencyMs > ? THEN 1 ELSE 0 END) AS delayedEvents,
          SUM(CASE WHEN e.latencyMs < -? THEN 1 ELSE 0 END) AS futureSkewedEvents
        FROM events e
        LEFT JOIN sites s ON s.id = e.siteId
        GROUP BY e.siteId
        ORDER BY totalEvents DESC, delayedEvents DESC
        LIMIT 8`,
      bindings: [
        ...eventBindings,
        TRUSTED_LATENCY_MAX_MS,
        DELAYED_EVENT_MS,
        FUTURE_SKEW_MS,
      ],
    },
    {
      sql: `${legacyEventCte(fromSec, toSec)}
        SELECT
          e.kind,
          e.siteId,
          COALESCE(s.name, e.siteId) AS siteName,
          COALESCE(s.domain, '') AS siteDomain,
          e.eventAtMs,
          e.serverAtMs,
          e.latencyMs
        FROM events e
        LEFT JOIN sites s ON s.id = e.siteId
        WHERE e.latencyMs > 0
        ORDER BY e.latencyMs DESC
        LIMIT 10`,
      bindings: eventBindings,
    },
    {
      sql: `SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN ? - last_activity_at > ? THEN 1 ELSE 0 END) AS stale,
          SUM(CASE WHEN ? - last_activity_at > ? THEN 1 ELSE 0 END) AS timedOut,
          MIN(started_at) AS oldestStartedAt,
          MAX(last_activity_at) AS newestActivityAt
        FROM visits
        WHERE status = 'open'`,
      bindings: [generatedAt, 30 * 60 * 1000, generatedAt, 12 * 60 * 60 * 1000],
    },
  ];
}

function typedQueries(
  fromSec: number,
  toSec: number,
  bucketSizeSec: number,
  generatedAt: number,
) {
  const thresholds = {
    trustedLatencyMaxMs: TRUSTED_LATENCY_MAX_MS,
    delayedEventMs: DELAYED_EVENT_MS,
    futureSkewMs: FUTURE_SKEW_MS,
  };
  return [
    compileD1Query(
      buildSystemPerformanceSummaryQuery(fromSec, toSec, thresholds),
      { tag: "admin.events.first" },
    ),
    compileD1Query(
      buildSystemPerformancePercentileQuery(
        fromSec,
        toSec,
        TRUSTED_LATENCY_MAX_MS,
      ),
      { tag: "admin.events.first" },
    ),
    compileD1Query(
      buildSystemPerformanceTrendQuery(
        fromSec,
        toSec,
        bucketSizeSec,
        thresholds,
      ),
      { tag: "admin.events.all" },
    ),
    compileD1Query(
      buildSystemPerformanceTopSitesQuery(fromSec, toSec, thresholds),
      { tag: "admin.events.all" },
    ),
    compileD1Query(buildSystemPerformanceSlowEventsQuery(fromSec, toSec), {
      tag: "admin.events.all",
    }),
    compileD1Query(
      buildSystemPerformanceOpenVisitsQuery(generatedAt, {
        staleMs: 30 * 60 * 1000,
        timedOutMs: 12 * 60 * 60 * 1000,
      }),
      { tag: "admin.visits.first" },
    ),
  ];
}

function readRows(database: DatabaseSync, query: Query): Row[] {
  return database
    .prepare(query.sql)
    .all(...((query.bindings ?? []) as SQLInputValue[])) as Row[];
}

function queryPlanDetails(database: DatabaseSync, query: Query) {
  return database
    .prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
    .all(...((query.bindings ?? []) as SQLInputValue[])) as Array<{
    detail: string;
  }>;
}

function recordObservations(events: DatabaseQueryObservation[]) {
  return {
    begin({ statementCount }: { operation: string; statementCount: number }) {
      return {
        statementIndexes: Array.from(
          { length: statementCount },
          (_unused, index) => index,
        ),
        includeBatchSummary: false,
        record(event: DatabaseQueryObservation) {
          events.push(event);
        },
        release() {},
      };
    },
  };
}

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
  vi.restoreAllMocks();
});

describe("system performance typed query plans", () => {
  it("matches all six legacy query results and observes the real handler calls", async () => {
    const { database, addVisit, addCustomEvent } = createFixture();
    const fromSec = NOW_SECONDS - 15 * 60;
    const toSec = NOW_SECONDS;
    const bucketSizeSec = 60;
    seedContractRows(addVisit, addCustomEvent, fromSec, toSec);
    vi.spyOn(Date, "now").mockReturnValue(NOW_MS);

    const compiled = typedQueries(fromSec, toSec, bucketSizeSec, NOW_MS);
    const legacy = legacyQueries(fromSec, toSec, bucketSizeSec, NOW_MS);
    expect(compiled).toHaveLength(6);
    expect(legacy).toHaveLength(6);
    compiled.forEach((query, index) => {
      assertD1StatementBudget(query);
      expect(readRows(database, query)).toEqual(
        readRows(database, legacy[index]!),
      );
    });

    const trace: SqliteD1Trace = {
      preparedSql: [],
      bindings: [],
      batchStatements: [],
    };
    const databaseBinding = createSqliteD1Database(database, trace);
    const observations: DatabaseQueryObservation[] = [];
    registerDatabaseQueryObserver(
      databaseBinding,
      recordObservations(observations),
    );
    const response = await handleSystemPerformanceAdmin(
      new Request("https://edge.test/api/private/admin/system-performance"),
      { DB: databaseBinding } as Env,
      new URL(
        "https://edge.test/api/private/admin/system-performance?minutes=15",
      ),
      async () => ({ isAdmin: true }),
    );

    expect(response.status).toBe(200);
    const data = (await response.json()) as {
      summary: Record<string, unknown>;
      openVisits: Record<string, unknown>;
      trend: Array<{
        bucket: number;
        totalEvents: number;
        avgLatencyMs: number | null;
        p50LatencyMs: number | null;
        p75LatencyMs: number | null;
        p95LatencyMs: number | null;
      }>;
      topSites: Array<{ siteId: string }>;
      slowEvents: unknown[];
    };
    expect(data.summary).toMatchObject({
      totalEvents: 17,
      visits: 13,
      customEvents: 4,
      activeSites: 3,
      delayedEvents: 6,
      futureSkewedEvents: 2,
      trustedLatencySamples: 11,
    });
    expect(data.openVisits).toMatchObject({ total: 3, stale: 1, timedOut: 1 });
    expect(data.trend.length).toBeGreaterThan(1);
    expect(
      data.trend.find(
        ({ bucket }) => bucket === Math.trunc((toSec - 300) / 60) * 60,
      ),
    ).toMatchObject({
      totalEvents: 1,
      avgLatencyMs: 0,
      p50LatencyMs: 0,
      p75LatencyMs: 0,
      p95LatencyMs: 0,
    });
    expect(data.topSites.map(({ siteId }) => siteId)).toEqual([
      "site-a",
      "site-b",
      "unknown-site",
    ]);
    expect(data.slowEvents).toHaveLength(10);

    expect(trace.preparedSql).toEqual(compiled.map(({ sql }) => sql));
    expect(trace.bindings).toEqual(
      compiled.map(({ bindings }) => [...(bindings ?? [])]),
    );
    await vi.waitFor(() => expect(observations).toHaveLength(6));
    expect(observations.map(({ tag }) => tag).sort()).toEqual(
      [
        "admin.events.first",
        "admin.events.first",
        "admin.events.all",
        "admin.events.all",
        "admin.events.all",
        "admin.visits.first",
      ].sort(),
    );
    const physicalPlanVersionsByStatement = new Map<string, Set<number>>();
    for (const query of compiled) {
      const version = query.physicalPlanShape?.version;
      if (version === undefined) continue;
      const key = `${query.tag}:${Buffer.byteLength(query.sql, "utf8")}:${query.bindings?.length ?? 0}`;
      const versions = physicalPlanVersionsByStatement.get(key) ?? new Set();
      versions.add(version);
      physicalPlanVersionsByStatement.set(key, versions);
    }
    for (const observation of observations) {
      expect(observation.status).toBe("success");
      expect(observation.sqlBytes).toBeGreaterThan(0);
      expect(observation.bindings).toBeGreaterThan(0);
      const key = `${observation.tag}:${observation.sqlBytes}:${observation.bindings}`;
      const versions = physicalPlanVersionsByStatement.get(key);
      expect(versions?.size).toBeGreaterThan(0);
      expect(observation.physicalPlanHash).toMatch(
        new RegExp(
          `^v(?:${[...(versions ?? [])].join("|")}):[a-f0-9]{64}$`,
          "u",
        ),
      );
    }
  });

  it("matches discrete percentile thresholds for 1, 2, 3, 4, and 20 rows", () => {
    const { database, addVisit } = createFixture();
    for (const count of [1, 2, 3, 4, 20]) {
      database.exec("DELETE FROM custom_events; DELETE FROM visits;");
      const latencies = Array.from(
        { length: count },
        (_unused, index) => Math.floor(index / 2) + 1,
      );
      latencies.forEach((latencyMs, index) => {
        const createdAtSec = 1_000 + index;
        addVisit({
          id: `percentile-${count}-${index}`,
          siteId: "site-a",
          createdAtSec,
          latencyMs,
        });
      });
      const fromSec = 1_000;
      const toSec = 1_000 + count - 1;
      const typed = compileD1Query(
        buildSystemPerformancePercentileQuery(
          fromSec,
          toSec,
          TRUSTED_LATENCY_MAX_MS,
        ),
      );
      const legacy = legacyQueries(fromSec, toSec, 60, NOW_MS)[1]!;
      expect(readRows(database, typed)).toEqual(readRows(database, legacy));

      const [row] = readRows(database, typed);
      expect(row).toEqual({
        p50LatencyMs: latencies[Math.ceil(count * 0.5) - 1],
        p75LatencyMs: latencies[Math.ceil(count * 0.75) - 1],
        p95LatencyMs: latencies[Math.ceil(count * 0.95) - 1],
      });
    }
  });

  it("preserves the legacy empty-window aggregate row and NULL-to-zero mapping", async () => {
    const { database } = createFixture();
    vi.spyOn(Date, "now").mockReturnValue(NOW_MS);
    const fromSec = NOW_SECONDS - 15 * 60;
    const queries = typedQueries(fromSec, NOW_SECONDS, 60, NOW_MS);
    const legacy = legacyQueries(fromSec, NOW_SECONDS, 60, NOW_MS);
    queries.forEach((query, index) => {
      expect(readRows(database, query)).toEqual(
        readRows(database, legacy[index]!),
      );
    });

    const response = await handleSystemPerformanceAdmin(
      new Request("https://edge.test/api/private/admin/system-performance"),
      { DB: createSqliteD1Database(database) } as Env,
      new URL(
        "https://edge.test/api/private/admin/system-performance?minutes=15",
      ),
      async () => ({ isAdmin: true }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      summary: {
        totalEvents: 0,
        avgLatencyMs: 0,
        p50LatencyMs: 0,
        p75LatencyMs: 0,
        p95LatencyMs: 0,
        latestCreatedAt: null,
      },
      openVisits: {
        total: 0,
        stale: 0,
        timedOut: 0,
        oldestStartedAt: 0,
        newestActivityAt: 0,
      },
      trend: [],
      topSites: [],
      slowEvents: [],
    });
  });

  it("materializes one narrow trend input to avoid duplicate event range scans", () => {
    const { database, addVisit, addCustomEvent } = createFixture();
    const fromSec = NOW_SECONDS - 15 * 60;
    const toSec = NOW_SECONDS;
    seedContractRows(addVisit, addCustomEvent, fromSec, toSec);
    for (let index = 0; index < 250; index += 1) {
      const createdAtSec = fromSec + (index % (15 * 60));
      addVisit({
        id: `cost-visit-${index}`,
        siteId: index % 2 === 0 ? "site-a" : "site-b",
        createdAtSec,
        latencyMs: index % 300,
      });
      addCustomEvent({
        id: `cost-event-${index}`,
        siteId: index % 2 === 0 ? "site-a" : "site-b",
        createdAtSec,
        latencyMs: index % 400,
      });
    }

    const typed = compileD1Query(
      buildSystemPerformanceTrendQuery(fromSec, toSec, 60, {
        trustedLatencyMaxMs: TRUSTED_LATENCY_MAX_MS,
        delayedEventMs: DELAYED_EVENT_MS,
        futureSkewMs: FUTURE_SKEW_MS,
      }),
      { tag: "admin.events.all" },
    );
    const unoptimized = compileD1QueryUnoptimizedForTest(
      buildSystemPerformanceTrendQuery(fromSec, toSec, 60, {
        trustedLatencyMaxMs: TRUSTED_LATENCY_MAX_MS,
        delayedEventMs: DELAYED_EVENT_MS,
        futureSkewMs: FUTURE_SKEW_MS,
      }),
    );
    const legacy = legacyQueries(fromSec, toSec, 60, NOW_MS)[2]!;
    assertD1StatementBudget(typed);
    const typedDetails = queryPlanDetails(database, typed).map(
      ({ detail }) => detail,
    );
    const unoptimizedDetails = queryPlanDetails(database, unoptimized).map(
      ({ detail }) => detail,
    );
    const legacyDetails = queryPlanDetails(database, legacy).map(
      ({ detail }) => detail,
    );
    const reads = (details: readonly string[], indexName: string) =>
      details.filter((detail) => detail.includes(indexName)).length;

    expect(
      reads(unoptimizedDetails, "idx_visits_created_at_site_pk_performance"),
    ).toBe(2);
    expect(
      reads(
        unoptimizedDetails,
        "idx_custom_events_created_at_site_pk_performance",
      ),
    ).toBe(2);
    expect(
      reads(legacyDetails, "idx_visits_created_at_site_pk_performance"),
    ).toBe(1);
    expect(
      reads(legacyDetails, "idx_custom_events_created_at_site_pk_performance"),
    ).toBe(1);
    expect(
      reads(typedDetails, "idx_visits_created_at_site_pk_performance"),
    ).toBe(1);
    expect(
      reads(typedDetails, "idx_custom_events_created_at_site_pk_performance"),
    ).toBe(1);
    expect(typed.physicalPlanShape?.cteCount).toBe(1);
    expect(typed.sql).toContain("AS MATERIALIZED (");
    expect(typedDetails.some((detail) => detail.includes("ORDER BY"))).toBe(
      true,
    );
  });

  it("executes the diagnostic and E2E site lookups through tagged typed plans", async () => {
    const { database } = createFixture();
    const trace: SqliteD1Trace = {
      preparedSql: [],
      bindings: [],
      batchStatements: [],
    };
    const databaseBinding = createSqliteD1Database(database, trace);
    const observations: DatabaseQueryObservation[] = [];
    registerDatabaseQueryObserver(
      databaseBinding,
      recordObservations(observations),
    );
    const diagnosticPayload = {
      ok: true,
      thresholds: {
        staleMs: 1,
        timeoutMs: 2,
        hardAgedMs: 3,
        stuckFlushAttempts: 5,
      },
      visits: {
        total: 1,
        open: {
          total: 1,
          stale: 0,
          timedOut: 0,
          hardAged: 0,
          futureSkewed: 0,
          oldestStartedAt: null,
          newestActivityAt: null,
          futureMaxActivityAt: null,
        },
        dirty: { total: 0, stuck: 0, maxFlushAttempts: 0 },
      },
      customEvents: {
        total: 0,
        dirty: 0,
        stuck: 0,
        maxFlushAttempts: 0,
        oldestOccurredAt: null,
      },
      alarm: { scheduledAt: null },
    };
    const doFetch = vi.fn((url: string) =>
      url.endsWith("/diagnostic")
        ? Promise.resolve(Response.json(diagnosticPayload))
        : Promise.resolve(Response.json({ ok: true })),
    );
    const env = {
      DB: databaseBinding,
      INSIGHTFLARE_E2E: "1",
      INGEST_DO: {
        idFromName: vi.fn((siteId: string) => siteId),
        get: vi.fn(() => ({ fetch: doFetch })),
      },
    } as unknown as Env;
    const actor = async () => ({ isAdmin: true });

    const diagnosticResponse = await handleDoDiagnosticAdmin(
      new Request("https://edge.test/api/private/admin/do-diagnostic"),
      env,
      new URL("https://edge.test/api/private/admin/do-diagnostic"),
      actor,
    );
    expect(diagnosticResponse.status).toBe(200);
    await expect(diagnosticResponse.json()).resolves.toMatchObject({
      totalSites: 2,
      reachableSites: 2,
      sites: [{ siteId: "site-a" }, { siteId: "site-b" }],
    });
    expect(doFetch).toHaveBeenCalledTimes(2);
    expect(trace.preparedSql).toEqual([
      compileD1Query(buildDoDiagnosticSitesQuery(), {
        tag: "admin.sites.all",
      }).sql,
    ]);
    await vi.waitFor(() => expect(observations).toHaveLength(1));
    expect(observations[0]).toMatchObject({
      tag: "admin.sites.all",
      operation: "all",
      status: "success",
      sqlBytes: expect.any(Number),
      physicalPlanHash: expect.stringMatching(/^v1:/u),
    });

    const flushResponse = await handleE2eFlushAdmin(
      new Request("https://edge.test/api/private/admin/e2e-flush", {
        method: "POST",
        body: JSON.stringify({ siteId: "site-a" }),
      }),
      env,
      new URL("https://edge.test/api/private/admin/e2e-flush"),
      actor,
    );
    expect(flushResponse.status).toBe(200);
    await expect(flushResponse.json()).resolves.toMatchObject({
      ok: true,
      data: { flushed: true, siteId: "site-a" },
    });
    expect(doFetch).toHaveBeenCalledWith(
      "https://ingest.internal/flush?force=1",
      { method: "POST" },
    );
    expect(trace.preparedSql[1]).toBe(
      compileD1Query(buildE2eFlushSiteQuery("site-a"), {
        tag: "admin.sites.first",
      }).sql,
    );
    await vi.waitFor(() => expect(observations).toHaveLength(2));
    expect(observations.map(({ tag }) => tag)).toEqual([
      "admin.sites.all",
      "admin.sites.first",
    ]);
  });
});
