import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  assertD1StatementBudget,
  type DatabaseQueryObservation,
  registerDatabaseQueryObserver,
} from "@/lib/db";
import { explainQueryPlan } from "@/lib/db/__tests__/query-plan";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";
import { compileD1QueryUnoptimizedForTest } from "@/lib/db/query/compiler";
import { lowerLogicalPlan } from "@/lib/db/query/physical-plan";
import { schema } from "@/lib/db/schema";
import { runHourlyAggregation } from "@/lib/edge/scheduled-tasks/hourly-rollup";
import {
  buildHourlyRollupMetricPlan,
  buildHourlyRollupMetricRelation,
} from "@/lib/edge/scheduled-tasks/hourly-rollup-metric-plan";
import type { Env } from "@/lib/edge/types";
import { ONE_HOUR_MS } from "@/lib/edge/utils";

const databases = new Set<DatabaseSync>();
type Row = Record<string, unknown>;

function createFixture() {
  const database = createMigratedDatabase();
  databases.add(database);
  database.exec("PRAGMA foreign_keys = ON");
  database
    .prepare(
      "INSERT INTO users (id, email, name, username) VALUES ('owner', 'owner@example.test', 'Owner', 'owner')",
    )
    .run();
  database
    .prepare(
      "INSERT INTO teams (id, name, slug, owner_user_id) VALUES ('team', 'Team', 'team', 'owner')",
    )
    .run();
  const addSite = (siteId: string) => {
    database
      .prepare(
        "INSERT INTO sites (id, team_id, name, domain) VALUES (?, 'team', ?, ?)",
      )
      .run(siteId, siteId, `${siteId}.example.test`);
    database
      .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
      .run(siteId);
    return Number(
      database
        .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
        .get(siteId)?.site_pk,
    );
  };
  const insertVisit = (input: {
    readonly visitId: string;
    readonly siteId: string;
    readonly sitePk: number;
    readonly startedAt: number;
    readonly visitorId?: string;
    readonly sessionId?: string;
    readonly status?: string;
    readonly durationMs?: number | null;
    readonly perf?: readonly [
      number | null,
      number | null,
      number | null,
      number | null,
      number | null,
    ];
  }) => {
    const [ttfb, fcp, lcp, cls, inp] = input.perf ?? [
      null,
      null,
      null,
      null,
      null,
    ];
    database
      .prepare(
        `INSERT INTO visits (
          visit_id, site_id, visitor_id, session_id, status, started_at,
          last_activity_at, duration_ms, pathname, hostname, perf_ttfb_ms,
          perf_fcp_ms, perf_lcp_ms, perf_cls, perf_inp_ms, site_pk
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '/sample', 'example.test', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.visitId,
        input.siteId,
        input.visitorId ?? "",
        input.sessionId ?? "",
        input.status ?? "complete",
        input.startedAt,
        input.startedAt,
        input.durationMs ?? null,
        ttfb,
        fcp,
        lcp,
        cls,
        inp,
        input.sitePk,
      );
  };
  return { database, addSite, insertVisit };
}

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

function legacyMetricsQuery() {
  return `
    WITH base_visits AS MATERIALIZED (
      SELECT site_id AS siteId,
        CAST(started_at / ? AS INTEGER) AS hourBucket,
        duration_ms, perf_ttfb_ms, perf_fcp_ms, perf_lcp_ms,
        perf_cls, perf_inp_ms, visitor_id, session_id
      FROM visits
      WHERE site_pk = ? AND started_at >= ? AND started_at < ?
        AND status != 'open'
    )
    SELECT 'basic' AS metric, siteId, hourBucket, COUNT(*) AS views,
      COALESCE(SUM(CASE WHEN duration_ms IS NOT NULL AND duration_ms >= 0 THEN duration_ms ELSE 0 END), 0) AS durationMsSum,
      COALESCE(SUM(CASE WHEN duration_ms IS NOT NULL AND duration_ms >= 0 THEN 1 ELSE 0 END), 0) AS durationMsCount,
      COALESCE(SUM(CASE WHEN perf_ttfb_ms IS NOT NULL THEN perf_ttfb_ms ELSE 0 END), 0) AS perfTtfbSum,
      COALESCE(SUM(CASE WHEN perf_ttfb_ms IS NOT NULL THEN 1 ELSE 0 END), 0) AS perfTtfbCount,
      COALESCE(SUM(CASE WHEN perf_fcp_ms IS NOT NULL THEN perf_fcp_ms ELSE 0 END), 0) AS perfFcpSum,
      COALESCE(SUM(CASE WHEN perf_fcp_ms IS NOT NULL THEN 1 ELSE 0 END), 0) AS perfFcpCount,
      COALESCE(SUM(CASE WHEN perf_lcp_ms IS NOT NULL THEN perf_lcp_ms ELSE 0 END), 0) AS perfLcpSum,
      COALESCE(SUM(CASE WHEN perf_lcp_ms IS NOT NULL THEN 1 ELSE 0 END), 0) AS perfLcpCount,
      COALESCE(SUM(CASE WHEN perf_cls IS NOT NULL THEN perf_cls ELSE 0 END), 0) AS perfClsSum,
      COALESCE(SUM(CASE WHEN perf_cls IS NOT NULL THEN 1 ELSE 0 END), 0) AS perfClsCount,
      COALESCE(SUM(CASE WHEN perf_inp_ms IS NOT NULL THEN perf_inp_ms ELSE 0 END), 0) AS perfInpSum,
      COALESCE(SUM(CASE WHEN perf_inp_ms IS NOT NULL THEN 1 ELSE 0 END), 0) AS perfInpCount,
      CAST(NULL AS TEXT) AS visitorId, CAST(NULL AS TEXT) AS sessionId,
      CAST(NULL AS INTEGER) AS visitCount
    FROM base_visits GROUP BY siteId, hourBucket
    UNION ALL
    SELECT 'visitor' AS metric, siteId, hourBucket,
      CAST(NULL AS INTEGER), CAST(NULL AS INTEGER), CAST(NULL AS INTEGER),
      CAST(NULL AS INTEGER), CAST(NULL AS INTEGER), CAST(NULL AS INTEGER),
      CAST(NULL AS INTEGER), CAST(NULL AS INTEGER), CAST(NULL AS INTEGER),
      CAST(NULL AS INTEGER), CAST(NULL AS INTEGER), CAST(NULL AS INTEGER),
      CAST(NULL AS INTEGER), visitor_id AS visitorId,
      CAST(NULL AS TEXT) AS sessionId, CAST(NULL AS INTEGER) AS visitCount
    FROM base_visits WHERE TRIM(COALESCE(visitor_id, '')) != ''
    GROUP BY siteId, hourBucket, visitor_id
    UNION ALL
    SELECT 'session' AS metric, siteId, hourBucket,
      CAST(NULL AS INTEGER), CAST(NULL AS INTEGER), CAST(NULL AS INTEGER),
      CAST(NULL AS INTEGER), CAST(NULL AS INTEGER), CAST(NULL AS INTEGER),
      CAST(NULL AS INTEGER), CAST(NULL AS INTEGER), CAST(NULL AS INTEGER),
      CAST(NULL AS INTEGER), CAST(NULL AS INTEGER), CAST(NULL AS INTEGER),
      CAST(NULL AS INTEGER), CAST(NULL AS TEXT) AS visitorId,
      session_id AS sessionId, COUNT(*) AS visitCount
    FROM base_visits WHERE TRIM(COALESCE(session_id, '')) != ''
    GROUP BY siteId, hourBucket, session_id
    ORDER BY metric ASC, hourBucket ASC, visitorId ASC, sessionId ASC
  `;
}

function allRows(
  database: DatabaseSync,
  sql: string,
  bindings: readonly unknown[],
): Row[] {
  return database.prepare(sql).all(...(bindings as SQLInputValue[])) as Row[];
}

function virtualMachineSteps(
  database: DatabaseSync,
  sql: string,
  bindings: readonly unknown[],
): number {
  return database
    .prepare(`EXPLAIN ${sql}`)
    .all(...(bindings as SQLInputValue[])).length;
}

function recordObservations(events: DatabaseQueryObservation[]) {
  return {
    begin({
      operation,
      statementCount,
    }: {
      operation: "all" | "first" | "run" | "batch" | "exec";
      statementCount: number;
    }) {
      return {
        statementIndexes:
          operation === "batch"
            ? Array.from(
                { length: Math.min(statementCount, 32) },
                (_unused, index) => index,
              )
            : [0],
        includeBatchSummary: operation === "batch",
        record(event: DatabaseQueryObservation) {
          events.push(event);
        },
        release() {},
      };
    },
  };
}

describe("hourly rollup shared aggregate", () => {
  it("matches legacy rows and shares the filtered source once", () => {
    const { database, addSite, insertVisit } = createFixture();
    const sitePk = addSite("site-a");
    const otherSitePk = addSite("site-b");
    const startHour = 10;
    const endHour = 11;
    const hourStart = startHour * ONE_HOUR_MS;
    const data = [
      {
        visitId: "complete-first",
        startedAt: hourStart + 10,
        visitorId: "visitor-shared",
        sessionId: "session-shared",
        durationMs: 100,
        perf: [-2.5, 0, null, 0.25, -1],
      },
      {
        visitId: "hidden-pending-same-hour",
        startedAt: hourStart + 20,
        visitorId: "visitor-shared",
        sessionId: "session-shared",
        status: "hidden_pending",
        durationMs: -5,
        perf: [1.25, -3, 0, null, 2],
      },
      {
        visitId: "timeout-next-hour",
        startedAt: hourStart + ONE_HOUR_MS + 30,
        visitorId: "visitor-shared",
        sessionId: "session-next-hour",
        status: "timeout",
        durationMs: null,
        perf: [null, null, 0.5, -0.25, null],
      },
      {
        visitId: "space-identities",
        startedAt: hourStart + ONE_HOUR_MS + 40,
        visitorId: "  ",
        sessionId: "  ",
        durationMs: 0,
        perf: [0, 0, 0, 0, 0],
      },
      {
        visitId: "tab-identities",
        startedAt: hourStart + ONE_HOUR_MS + 50,
        visitorId: "\t",
        sessionId: "\n",
      },
      {
        visitId: "nbsp-identities",
        startedAt: hourStart + ONE_HOUR_MS + 60,
        visitorId: "\u00a0",
        sessionId: "session-nbsp",
      },
    ] as const;
    for (const visit of data) {
      insertVisit({ ...visit, siteId: "site-a", sitePk });
    }
    insertVisit({
      visitId: "open-visit",
      siteId: "site-a",
      sitePk,
      startedAt: hourStart + 1,
      status: "open",
      visitorId: "open-visitor",
      sessionId: "open-session",
    });
    insertVisit({
      visitId: "before-window",
      siteId: "site-a",
      sitePk,
      startedAt: hourStart - 1,
      visitorId: "before",
      sessionId: "before",
    });
    insertVisit({
      visitId: "end-exclusive",
      siteId: "site-a",
      sitePk,
      startedAt: (endHour + 1) * ONE_HOUR_MS,
      visitorId: "after",
      sessionId: "after",
    });
    insertVisit({
      visitId: "other-site",
      siteId: "site-b",
      sitePk: otherSitePk,
      startedAt: hourStart + 1,
      visitorId: "other-visitor",
      sessionId: "other-session",
    });

    const query = buildHourlyRollupMetricPlan(sitePk, startHour, endHour);
    assertD1StatementBudget(query);
    const physical = lowerLogicalPlan(
      buildHourlyRollupMetricRelation(sitePk, startHour, endHour),
    );
    expect(physical.sharedRelations).toHaveLength(1);
    expect(physical.sharedRelations[0]?.fields.map(({ name }) => name)).toEqual(
      [
        "siteId",
        "hourBucket",
        "durationMs",
        "perfTtfbMs",
        "perfFcpMs",
        "perfLcpMs",
        "perfCls",
        "perfInpMs",
        "visitorId",
        "sessionId",
      ],
    );
    expect(physical.sharedRelations[0]?.materialization).toBe("materialized");
    const unoptimized = compileD1QueryUnoptimizedForTest(
      buildHourlyRollupMetricRelation(sitePk, startHour, endHour),
      { tag: "scheduled-tasks.visits.all" },
    );
    const legacySql = legacyMetricsQuery();
    const legacyBindings = [
      ONE_HOUR_MS,
      sitePk,
      hourStart,
      (endHour + 1) * ONE_HOUR_MS,
    ];
    const legacyRows = allRows(database, legacySql, legacyBindings);
    const typedRows = allRows(database, query.sql, query.bindings ?? []);
    const typedBaselineRows = allRows(
      database,
      unoptimized.sql,
      unoptimized.bindings ?? [],
    );
    expect(typedRows).toEqual(legacyRows);
    expect(typedBaselineRows).toEqual(legacyRows);
    expect(query.tag).toBe("scheduled-tasks.visits.all");
    expect(query.physicalPlanShape?.cteCount).toBe(1);
    expect(query.physicalPlanShape?.directScanProjectionCount).toBe(1);
    expect(query.sql).not.toContain("exit_reason");

    const legacyPlan = explainQueryPlan(database, {
      sql: legacySql,
      bindings: legacyBindings,
    });
    const typedBaselinePlan = explainQueryPlan(database, unoptimized);
    const optimizedPlan = explainQueryPlan(database, query);
    const sourceSearches = (plan: readonly string[]) =>
      plan.filter(
        (line) =>
          line.includes("SEARCH") &&
          line.includes("USING INDEX idx_visits_site_pk_started_at") &&
          line.includes("site_pk=? AND started_at>? AND started_at<?"),
      ).length;
    expect(
      legacyPlan.some((line) => line.includes("MATERIALIZE base_visits")),
    ).toBe(true);
    expect(sourceSearches(legacyPlan)).toBe(1);
    expect(sourceSearches(typedBaselinePlan)).toBe(3);
    expect(sourceSearches(optimizedPlan)).toBe(1);
    expect(
      optimizedPlan.some((line) => line.includes("MATERIALIZE _d1_shared_")),
    ).toBe(true);
    const measurements = {
      legacySqlBytes: new TextEncoder().encode(legacySql).length,
      typedBaselineSqlBytes: new TextEncoder().encode(unoptimized.sql).length,
      optimizedSqlBytes: new TextEncoder().encode(query.sql).length,
      legacyBindings: legacyBindings.length,
      typedBaselineBindings: unoptimized.bindings?.length,
      optimizedBindings: query.bindings?.length,
      legacyVirtualMachineSteps: virtualMachineSteps(
        database,
        legacySql,
        legacyBindings,
      ),
      typedBaselineVirtualMachineSteps: virtualMachineSteps(
        database,
        unoptimized.sql,
        unoptimized.bindings ?? [],
      ),
      optimizedVirtualMachineSteps: virtualMachineSteps(
        database,
        query.sql,
        query.bindings ?? [],
      ),
    };
    expect(measurements.legacyVirtualMachineSteps).toBeGreaterThan(0);
    expect(measurements.typedBaselineVirtualMachineSteps).toBeGreaterThan(0);
    expect(measurements.optimizedVirtualMachineSteps).toBeGreaterThan(0);
    expect(measurements.optimizedVirtualMachineSteps).toBeLessThan(
      measurements.legacyVirtualMachineSteps,
    );
    expect(measurements.optimizedVirtualMachineSteps).toBeLessThan(
      measurements.typedBaselineVirtualMachineSteps,
    );
  });

  it("keeps the three metric branches equivalent for a multi-hour workload", () => {
    const { database, addSite, insertVisit } = createFixture();
    const sitePk = addSite("site-many");
    const startHour = 10;
    const endHour = startHour + 23;
    const startMs = startHour * ONE_HOUR_MS;
    for (let hourOffset = 0; hourOffset < 24; hourOffset += 1) {
      for (let visitOffset = 0; visitOffset < 12; visitOffset += 1) {
        const index = hourOffset * 12 + visitOffset;
        insertVisit({
          visitId: `many-${index}`,
          siteId: "site-many",
          sitePk,
          startedAt: startMs + hourOffset * ONE_HOUR_MS + visitOffset + 1,
          visitorId: `visitor-${visitOffset % 4}`,
          sessionId: `session-${visitOffset % 3}`,
          status:
            index % 17 === 0
              ? "hidden_pending"
              : index % 19 === 0
                ? "timeout"
                : "complete",
          durationMs:
            index % 7 === 0 ? null : index % 11 === 0 ? -1 : index % 251,
          perf: [
            index % 5 === 0 ? null : index / 7,
            index % 6 === 0 ? null : index / 9,
            index % 8 === 0 ? null : index / 11,
            index % 10 === 0 ? null : index / 13,
            index % 12 === 0 ? null : index / 15,
          ],
        });
      }
    }

    const query = buildHourlyRollupMetricPlan(sitePk, startHour, endHour);
    assertD1StatementBudget(query);
    const baseline = compileD1QueryUnoptimizedForTest(
      buildHourlyRollupMetricRelation(sitePk, startHour, endHour),
      { tag: "scheduled-tasks.visits.all" },
    );
    const legacySql = legacyMetricsQuery();
    const legacyBindings = [
      ONE_HOUR_MS,
      sitePk,
      startMs,
      (endHour + 1) * ONE_HOUR_MS,
    ];
    const legacyRows = allRows(database, legacySql, legacyBindings);
    expect(allRows(database, baseline.sql, baseline.bindings ?? [])).toEqual(
      legacyRows,
    );
    expect(allRows(database, query.sql, query.bindings ?? [])).toEqual(
      legacyRows,
    );

    const legacyPlan = explainQueryPlan(database, {
      sql: legacySql,
      bindings: legacyBindings,
    });
    const baselinePlan = explainQueryPlan(database, baseline);
    const optimizedPlan = explainQueryPlan(database, query);
    const sourceSearches = (plan: readonly string[]) =>
      plan.filter(
        (line) =>
          line.includes("SEARCH") &&
          line.includes("USING INDEX idx_visits_site_pk_started_at") &&
          line.includes("site_pk=? AND started_at>? AND started_at<?"),
      ).length;
    expect(sourceSearches(legacyPlan)).toBe(1);
    expect(sourceSearches(baselinePlan)).toBe(3);
    expect(sourceSearches(optimizedPlan)).toBe(1);
    const sourceRows = Number(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM visits
          WHERE site_pk = ? AND started_at >= ? AND started_at < ?
            AND status != 'open'`,
        )
        .get(sitePk, startMs, (endHour + 1) * ONE_HOUR_MS)?.count,
    );
    expect(sourceRows).toBe(288);
    expect(sourceRows * sourceSearches(baselinePlan)).toBe(864);
    expect(sourceRows * sourceSearches(optimizedPlan)).toBe(288);
    const legacySteps = virtualMachineSteps(
      database,
      legacySql,
      legacyBindings,
    );
    const baselineSteps = virtualMachineSteps(
      database,
      baseline.sql,
      baseline.bindings ?? [],
    );
    const optimizedSteps = virtualMachineSteps(
      database,
      query.sql,
      query.bindings ?? [],
    );
    expect(optimizedSteps).toBeLessThan(legacySteps);
    expect(optimizedSteps).toBeLessThan(baselineSteps);
  });

  it("writes the existing rollup, state, and query observation through typed D1", async () => {
    const { database, addSite, insertVisit } = createFixture();
    database.function("unixepoch", () => 1_800_000_000);
    const sitePk = addSite("site-e2e");
    const hourStart = 10 * ONE_HOUR_MS;
    const data = [
      {
        visitId: "hour-10-a",
        startedAt: hourStart + 10,
        visitorId: "visitor-a",
        sessionId: "session-a",
        durationMs: 100,
        perf: [2, 10, 20, 0.1, 30],
      },
      {
        visitId: "hour-10-a-duplicate",
        startedAt: hourStart + 20,
        visitorId: "visitor-a",
        sessionId: "session-a",
        durationMs: null,
        perf: [null, 0, 30, 0.2, null],
      },
      {
        visitId: "hour-10-b",
        startedAt: hourStart + 30,
        visitorId: "visitor-b",
        sessionId: "session-b",
        status: "hidden_pending",
        durationMs: -4,
        perf: [-1, null, 0, -0.1, 40],
      },
      {
        visitId: "hour-11-a",
        startedAt: hourStart + ONE_HOUR_MS + 10,
        visitorId: "visitor-a",
        sessionId: "session-a",
        durationMs: 0,
        perf: [1, 2, null, 0.3, 50],
      },
      {
        visitId: "hour-11-space-control",
        startedAt: hourStart + ONE_HOUR_MS + 20,
        visitorId: "  ",
        sessionId: "  ",
      },
      {
        visitId: "hour-11-unicode-whitespace",
        startedAt: hourStart + ONE_HOUR_MS + 30,
        visitorId: "\t",
        sessionId: "\u00a0",
        durationMs: -1,
      },
    ] as const;
    for (const visit of data)
      insertVisit({ ...visit, siteId: "site-e2e", sitePk });

    const trace = {
      preparedSql: [] as string[],
      bindings: [] as SQLInputValue[][],
      batchStatements: [] as string[][],
    };
    const d1 = createSqliteD1Database(database, trace);
    const events: DatabaseQueryObservation[] = [];
    registerDatabaseQueryObserver(d1, recordObservations(events));
    const env = {
      DB: d1,
      INGEST_DO: {} as Env["INGEST_DO"],
      DAILY_SALT_SECRET: "secret",
    } satisfies Env;
    const metricsQuery = buildHourlyRollupMetricPlan(sitePk, 10, 11);
    assertD1StatementBudget(metricsQuery);
    const scheduledTime = 24 * ONE_HOUR_MS;

    const outcome = await runHourlyAggregation(env, scheduledTime);

    expect(outcome).toMatchObject({
      status: "success",
      summary: {
        candidateSites: 1,
        sitesProcessed: 1,
        hoursAggregated: 2,
        rollupRowsWritten: 2,
      },
    });
    const readIndex = trace.preparedSql.indexOf(metricsQuery.sql);
    expect(readIndex).toBeGreaterThanOrEqual(0);
    expect(
      trace.preparedSql.filter((sql) => sql === metricsQuery.sql),
    ).toHaveLength(1);
    expect(trace.bindings[readIndex]).toEqual(metricsQuery.bindings);

    const rollups = database
      .prepare(
        `SELECT site_id AS siteId, hour_bucket AS hourBucket, views, sessions,
          visitors, bounces, duration_ms_sum AS durationMsSum,
          duration_ms_count AS durationMsCount,
          visitor_set_json AS visitorSetJson,
          session_counts_json AS sessionCountsJson,
          perf_ttfb_sum AS perfTtfbSum, perf_ttfb_count AS perfTtfbCount,
          perf_fcp_sum AS perfFcpSum, perf_fcp_count AS perfFcpCount,
          perf_lcp_sum AS perfLcpSum, perf_lcp_count AS perfLcpCount,
          perf_cls_sum AS perfClsSum, perf_cls_count AS perfClsCount,
          perf_inp_sum AS perfInpSum, perf_inp_count AS perfInpCount,
          input_cutoff_ms AS inputCutoffMs, aggregated_at AS aggregatedAt,
          schema_version AS schemaVersion
        FROM visit_hourly_rollups ORDER BY hour_bucket`,
      )
      .all();
    expect(rollups).toEqual([
      {
        siteId: "site-e2e",
        hourBucket: 10,
        views: 3,
        sessions: 2,
        visitors: 2,
        bounces: 1,
        durationMsSum: 100,
        durationMsCount: 1,
        visitorSetJson: '["visitor-a","visitor-b"]',
        sessionCountsJson: '[["session-a",2],["session-b",1]]',
        perfTtfbSum: 1,
        perfTtfbCount: 2,
        perfFcpSum: 10,
        perfFcpCount: 2,
        perfLcpSum: 50,
        perfLcpCount: 3,
        perfClsSum: 0.2,
        perfClsCount: 3,
        perfInpSum: 70,
        perfInpCount: 2,
        inputCutoffMs: 12 * ONE_HOUR_MS,
        aggregatedAt: 1_800_000_000,
        schemaVersion: 1,
      },
      {
        siteId: "site-e2e",
        hourBucket: 11,
        views: 3,
        sessions: 1,
        visitors: 1,
        bounces: 1,
        durationMsSum: 0,
        durationMsCount: 1,
        visitorSetJson: '["visitor-a"]',
        sessionCountsJson: '[["session-a",1]]',
        perfTtfbSum: 1,
        perfTtfbCount: 1,
        perfFcpSum: 2,
        perfFcpCount: 1,
        perfLcpSum: 0,
        perfLcpCount: 0,
        perfClsSum: 0.3,
        perfClsCount: 1,
        perfInpSum: 50,
        perfInpCount: 1,
        inputCutoffMs: 12 * ONE_HOUR_MS,
        aggregatedAt: 1_800_000_000,
        schemaVersion: 1,
      },
    ]);
    const state = database
      .prepare(
        `SELECT site_id AS siteId, site_pk AS sitePk,
          aggregated_until_hour AS aggregatedUntilHour, lag_hours AS lagHours,
          last_run_at AS lastRunAt, last_success_at AS lastSuccessAt,
          last_error AS lastError
        FROM visit_hourly_aggregation_state`,
      )
      .get();
    expect(state).toEqual({
      siteId: "site-e2e",
      sitePk,
      aggregatedUntilHour: 11,
      lagHours: 12,
      lastRunAt: 1_800_000_000,
      lastSuccessAt: 1_800_000_000,
      lastError: null,
    });
    await vi.waitFor(() =>
      expect(
        events.filter(
          (event) =>
            event.operation === "all" &&
            event.tag === "scheduled-tasks.visits.all",
        ),
      ).toHaveLength(1),
    );
    const metricsObservation = events.find(
      (event) =>
        event.operation === "all" && event.tag === "scheduled-tasks.visits.all",
    );
    expect(metricsObservation).toMatchObject({
      status: "success",
      bindings: metricsQuery.bindings?.length,
      sqlBytes: new TextEncoder().encode(metricsQuery.sql).byteLength,
      physicalPlanHash: expect.stringMatching(/^v12:/u),
    });
    expect(metricsQuery.sql).not.toContain("site-e2e");
    expect(metricsQuery.sql).not.toContain("visitor-a");
    expect(metricsQuery.sql).not.toContain("session-a");
    expect(metricsQuery.bindings).not.toContain("site-e2e");
    expect(metricsQuery.bindings).not.toContain("visitor-a");
    expect(metricsQuery.bindings).not.toContain("session-a");
  });
});
