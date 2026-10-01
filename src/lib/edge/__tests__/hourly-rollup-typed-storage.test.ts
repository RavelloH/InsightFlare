import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  assertD1StatementBudget,
  type CompiledQuery,
  createD1DatabaseClient,
} from "@/lib/db";
import { explainQueryPlan } from "@/lib/db/__tests__/query-plan";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import type { StoredRollupRow } from "@/lib/edge/analytics/contract/hourly-rollup";
import { queryOverviewForSitesFromHourlyRollupsPartial } from "@/lib/edge/analytics/providers/d1/internal/hourly-rollup-queries";
import {
  aggregationCandidateQuery,
  aggregationStatesQuery,
  detailVisitsQuery,
  firstClosedHourQuery,
  firstOpenHourQuery,
  storedRollupsQuery,
} from "@/lib/edge/analytics/providers/d1/internal/hourly-rollup-read-plans";
import {
  prepareAggregationFailureMutation,
  prepareAggregationSuccessMutations,
  prepareFinalizeStaleOpenVisitsMutation,
} from "@/lib/edge/scheduled-tasks/hourly-rollup-persistence";
import type { Env } from "@/lib/edge/types";

const HOUR_MS = 60 * 60 * 1000;
const DATABASE_NOW = 1_800_000_000;
const databases = new Set<DatabaseSync>();
type Row = Record<string, unknown>;

function createFixture() {
  const database = createMigratedDatabase();
  databases.add(database);
  database.function("unixepoch", () => DATABASE_NOW);
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
  const trace: SqliteD1Trace = {
    preparedSql: [],
    bindings: [],
    batchStatements: [],
  };
  const d1 = createSqliteD1Database(database, trace);
  const sitePks = new Map<string, number>();
  const addSite = (siteId: string) => {
    database
      .prepare(
        "INSERT INTO sites (id, team_id, name, domain) VALUES (?, 'team', ?, ?)",
      )
      .run(siteId, siteId, `${siteId}.example.test`);
    database
      .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
      .run(siteId);
    const sitePk = Number(
      database
        .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
        .get(siteId)?.site_pk,
    );
    sitePks.set(siteId, sitePk);
    return sitePk;
  };
  return { database, d1, trace, sitePks, addSite };
}

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

function queryRows<RowType extends object>(
  database: DatabaseSync,
  query: CompiledQuery<RowType>,
): RowType[] {
  return database
    .prepare(query.sql)
    .all(...((query.bindings ?? []) as SQLInputValue[])) as RowType[];
}

function legacyRows(
  database: DatabaseSync,
  sql: string,
  ...bindings: SQLInputValue[]
): Row[] {
  return database.prepare(sql).all(...bindings) as Row[];
}

function insertVisit(
  database: DatabaseSync,
  input: {
    readonly visitId: string;
    readonly siteId: string;
    readonly sitePk: number;
    readonly startedAt: number;
    readonly status?: string;
    readonly lastActivityAt?: number;
    readonly visitorId?: string;
    readonly sessionId?: string;
    readonly durationMs?: number | null;
    readonly perfTtfbMs?: number | null;
    readonly exitReason?: string | null;
    readonly updatedAt?: number;
  },
): void {
  database
    .prepare(
      `
        INSERT INTO visits (
          visit_id, site_id, site_pk, visitor_id, session_id, status, started_at,
          last_activity_at, duration_ms, duration_source, exit_reason, pathname,
          hostname, perf_ttfb_ms, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'client', ?, '/docs', 'example.test', ?, ?)
      `,
    )
    .run(
      input.visitId,
      input.siteId,
      input.sitePk,
      input.visitorId ?? "visitor-1",
      input.sessionId ?? "session-1",
      input.status ?? "complete",
      input.startedAt,
      input.lastActivityAt ?? input.startedAt,
      input.durationMs ?? null,
      input.exitReason ?? null,
      input.perfTtfbMs ?? null,
      input.updatedAt ?? 10,
    );
}

function storedRollup(
  siteId: string,
  hourBucket: number,
  overrides: Partial<StoredRollupRow> = {},
): StoredRollupRow {
  return {
    siteId,
    hourBucket,
    views: 3,
    sessions: 2,
    visitors: 2,
    bounces: 1,
    durationMsSum: 700,
    durationMsCount: 2,
    visitorSetJson: '["visitor-a","visitor-b"]',
    sessionCountsJson: '[["session-a",2],["session-b",1]]',
    perfTtfbSum: 11.5,
    perfTtfbCount: 2,
    perfFcpSum: 22,
    perfFcpCount: 2,
    perfLcpSum: 33,
    perfLcpCount: 2,
    perfClsSum: 0.25,
    perfClsCount: 2,
    perfInpSum: 44,
    perfInpCount: 2,
    ...overrides,
  };
}

function insertLegacyRollup(
  database: DatabaseSync,
  siteId: string,
  sitePk: number,
  row: StoredRollupRow,
  inputCutoffMs: number,
  schemaVersion: number,
  aggregatedAt: number,
): void {
  database
    .prepare(
      `
        INSERT INTO visit_hourly_rollups (
          site_id, site_pk, hour_bucket, views, sessions, visitors, bounces,
          duration_ms_sum, duration_ms_count, visitor_set_json,
          session_counts_json, perf_ttfb_sum, perf_ttfb_count,
          perf_fcp_sum, perf_fcp_count, perf_lcp_sum, perf_lcp_count,
          perf_cls_sum, perf_cls_count, perf_inp_sum, perf_inp_count,
          input_cutoff_ms, aggregated_at, schema_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(site_pk, hour_bucket) DO UPDATE SET
          site_pk = excluded.site_pk,
          views = excluded.views,
          sessions = excluded.sessions,
          visitors = excluded.visitors,
          bounces = excluded.bounces,
          duration_ms_sum = excluded.duration_ms_sum,
          duration_ms_count = excluded.duration_ms_count,
          visitor_set_json = excluded.visitor_set_json,
          session_counts_json = excluded.session_counts_json,
          perf_ttfb_sum = excluded.perf_ttfb_sum,
          perf_ttfb_count = excluded.perf_ttfb_count,
          perf_fcp_sum = excluded.perf_fcp_sum,
          perf_fcp_count = excluded.perf_fcp_count,
          perf_lcp_sum = excluded.perf_lcp_sum,
          perf_lcp_count = excluded.perf_lcp_count,
          perf_cls_sum = excluded.perf_cls_sum,
          perf_cls_count = excluded.perf_cls_count,
          perf_inp_sum = excluded.perf_inp_sum,
          perf_inp_count = excluded.perf_inp_count,
          input_cutoff_ms = excluded.input_cutoff_ms,
          aggregated_at = excluded.aggregated_at,
          schema_version = excluded.schema_version
      `,
    )
    .run(
      siteId,
      sitePk,
      row.hourBucket,
      row.views,
      row.sessions,
      row.visitors,
      row.bounces,
      row.durationMsSum,
      row.durationMsCount,
      row.visitorSetJson,
      row.sessionCountsJson,
      row.perfTtfbSum,
      row.perfTtfbCount,
      row.perfFcpSum,
      row.perfFcpCount,
      row.perfLcpSum,
      row.perfLcpCount,
      row.perfClsSum,
      row.perfClsCount,
      row.perfInpSum,
      row.perfInpCount,
      inputCutoffMs,
      aggregatedAt,
      schemaVersion,
    );
}

describe("hourly rollup typed storage plans", () => {
  it("matches candidate SQL and probes visits through the site/time index", () => {
    const { database, addSite } = createFixture();
    const stateSite = addSite("site-state-null");
    const visitSite = addSite("site-many-visits");
    const emptySite = addSite("site-empty");
    const boundarySite = addSite("site-at-boundary");
    const lateStateSite = addSite("site-state-late");
    database
      .prepare(
        `INSERT INTO visit_hourly_aggregation_state
          (site_id, site_pk, aggregated_until_hour, lag_hours, last_success_at, last_error)
         VALUES (?, ?, 1, 12, NULL, NULL), (?, ?, 3, 12, 20, 'retry')`,
      )
      .run("site-state-null", stateSite, "site-state-late", lateStateSite);
    insertVisit(database, {
      visitId: "visit-many-1",
      siteId: "site-many-visits",
      sitePk: visitSite,
      startedAt: 100,
      status: "open",
    });
    insertVisit(database, {
      visitId: "visit-many-2",
      siteId: "site-many-visits",
      sitePk: visitSite,
      startedAt: 200,
      status: "hidden_pending",
    });
    insertVisit(database, {
      visitId: "visit-boundary",
      siteId: "site-at-boundary",
      sitePk: boundarySite,
      startedAt: 500,
    });
    const endExclusiveMs = 500;
    const query = aggregationCandidateQuery(endExclusiveMs);
    const actual = queryRows(database, query);
    const expected = legacyRows(
      database,
      `
        SELECT
          s.id AS siteId,
          si.site_pk AS sitePk,
          st.aggregated_until_hour AS aggregatedUntilHour,
          st.last_error AS lastError
        FROM sites s
        INNER JOIN site_identities si ON si.site_id = s.id
        LEFT JOIN visit_hourly_aggregation_state st ON st.site_pk = si.site_pk
        WHERE st.site_pk IS NOT NULL
          OR EXISTS (
            SELECT 1 FROM visits v
            WHERE v.site_pk = si.site_pk AND v.started_at < ?
            LIMIT 1
          )
        ORDER BY COALESCE(st.last_success_at, 0) ASC, s.id ASC
      `,
      endExclusiveMs,
    );
    expect(actual).toEqual(expected);
    expect(actual.map((row) => row.siteId)).toEqual([
      "site-many-visits",
      "site-state-null",
      "site-state-late",
    ]);
    expect(new Set(actual.map((row) => row.siteId)).size).toBe(actual.length);
    expect(actual.map((row) => row.siteId)).not.toContain("site-empty");
    expect(actual.map((row) => row.siteId)).not.toContain("site-at-boundary");
    const plan = explainQueryPlan(database, query);
    expect(
      plan.some((line) => line.includes("CORRELATED SCALAR SUBQUERY")),
    ).toBe(true);
    expect(
      plan.some(
        (line) =>
          line.includes("idx_visits_site_pk_started_at") &&
          line.includes("site_pk=? AND started_at<?"),
      ),
    ).toBe(true);
  });

  it("keeps closed/open status boundaries and SQLite bucket truncation", () => {
    const { database, addSite } = createFixture();
    const sitePk = addSite("site-hours");
    insertVisit(database, {
      visitId: "negative-closed",
      siteId: "site-hours",
      sitePk,
      startedAt: -HOUR_MS - 1,
      status: "hidden_pending",
    });
    insertVisit(database, {
      visitId: "later-closed",
      siteId: "site-hours",
      sitePk,
      startedAt: 30,
      status: "complete",
    });
    insertVisit(database, {
      visitId: "open-hour",
      siteId: "site-hours",
      sitePk,
      startedAt: 60,
      status: "open",
    });
    insertVisit(database, {
      visitId: "open-at-end",
      siteId: "site-hours",
      sitePk,
      startedAt: HOUR_MS,
      status: "open",
    });

    const endExclusiveMs = HOUR_MS;
    const closed = queryRows(
      database,
      firstClosedHourQuery(sitePk, endExclusiveMs),
    );
    const open = queryRows(
      database,
      firstOpenHourQuery(sitePk, endExclusiveMs),
    );
    const legacyClosed = legacyRows(
      database,
      `SELECT CAST(started_at / ? AS INTEGER) AS hourBucket FROM visits
       WHERE site_pk = ? AND started_at < ? AND status != 'open'
       ORDER BY started_at ASC LIMIT 1`,
      HOUR_MS,
      sitePk,
      endExclusiveMs,
    );
    const legacyOpen = legacyRows(
      database,
      `SELECT CAST(started_at / ? AS INTEGER) AS hourBucket FROM visits
       WHERE site_pk = ? AND status = 'open' AND started_at < ?
       ORDER BY started_at ASC LIMIT 1`,
      HOUR_MS,
      sitePk,
      endExclusiveMs,
    );
    expect(closed).toEqual(legacyClosed);
    expect(open).toEqual(legacyOpen);
    expect(closed).toEqual([{ hourBucket: -1 }]);
    expect(open).toEqual([{ hourBucket: 0 }]);
  });

  it("preserves detail, state, and rollup read projections and half-open windows", () => {
    const { database, addSite } = createFixture();
    const siteA = addSite("site-a");
    const siteB = addSite("site-b");
    database
      .prepare(
        `INSERT INTO visit_hourly_aggregation_state
          (site_id, site_pk, aggregated_until_hour, lag_hours)
         VALUES ('site-a', ?, 4, 12), ('site-b', ?, 7, 12)`,
      )
      .run(siteA, siteB);
    insertVisit(database, {
      visitId: "detail-b",
      siteId: "site-b",
      sitePk: siteB,
      startedAt: 2 * HOUR_MS + 2,
      visitorId: "",
      sessionId: "session-b",
      durationMs: null,
      perfTtfbMs: null,
    });
    insertVisit(database, {
      visitId: "detail-a",
      siteId: "site-a",
      sitePk: siteA,
      startedAt: 2 * HOUR_MS + 1,
      visitorId: "visitor-a",
      sessionId: "",
      durationMs: 45,
      perfTtfbMs: 12.5,
    });
    insertVisit(database, {
      visitId: "detail-end",
      siteId: "site-a",
      sitePk: siteA,
      startedAt: 4 * HOUR_MS,
    });
    const insertRollup = database.prepare(
      `INSERT INTO visit_hourly_rollups (
        site_id, site_pk, hour_bucket, views, sessions, visitors, bounces,
        duration_ms_sum, duration_ms_count, visitor_set_json, session_counts_json,
        perf_ttfb_sum, perf_ttfb_count, perf_fcp_sum, perf_fcp_count,
        perf_lcp_sum, perf_lcp_count, perf_cls_sum, perf_cls_count,
        perf_inp_sum, perf_inp_count, input_cutoff_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    );
    insertRollup.run(
      "site-a",
      siteA,
      2,
      5,
      2,
      2,
      1,
      120,
      3,
      '["v-a","v-b"]',
      '[["s-a",2]]',
      12.5,
      3,
      0,
      0,
      30,
      1,
      0.5,
      1,
      40,
      2,
      10,
    );
    insertRollup.run(
      "site-b",
      siteB,
      4,
      7,
      3,
      4,
      2,
      240,
      6,
      '["v-c"]',
      '[["s-b",3]]',
      8,
      2,
      4,
      1,
      16,
      2,
      0.25,
      1,
      20,
      1,
      10,
    );
    insertRollup.run(
      "site-a",
      siteA,
      4,
      99,
      99,
      99,
      99,
      99,
      99,
      "[]",
      "[]",
      99,
      99,
      99,
      99,
      99,
      99,
      99,
      99,
      99,
      99,
      10,
    );

    const siteIds = ["site-b", "site-a"];
    const window = {
      startMs: 2 * HOUR_MS,
      endExclusiveMs: 4 * HOUR_MS,
      nowMs: 5 * HOUR_MS,
      timeZone: "UTC",
    };
    const stateQuery = aggregationStatesQuery(siteIds);
    const detailQuery = detailVisitsQuery(siteIds, window);
    const orderedDetailQuery = detailVisitsQuery(siteIds, window, true);
    const rollupQuery = storedRollupsQuery(siteIds, 2, 4);
    expect(stateQuery.tag).toBe("analytics.visit_hourly_aggregation_state.all");
    expect(detailQuery.tag).toBe("analytics.visits.all");
    expect(rollupQuery.tag).toBe("analytics.visit_hourly_rollups.all");
    expect(stateQuery.bindings).toHaveLength(2);
    expect(detailQuery.bindings).toHaveLength(6);
    expect(rollupQuery.bindings).toHaveLength(4);
    expect(queryRows(database, stateQuery)).toEqual(
      legacyRows(
        database,
        `SELECT site_id AS siteId, aggregated_until_hour AS aggregatedUntilHour
         FROM visit_hourly_aggregation_state
         WHERE site_pk IN (SELECT site_pk FROM site_identities WHERE site_id IN (?, ?))`,
        ...siteIds,
      ),
    );
    const actualDetailRows = queryRows(database, detailQuery).sort(
      (left, right) =>
        left.startedAt - right.startedAt ||
        left.siteId.localeCompare(right.siteId),
    );
    const expectedDetailRows = legacyRows(
      database,
      `SELECT site_id AS siteId, started_at AS startedAt,
           COALESCE(visitor_id, '') AS visitorId,
           COALESCE(session_id, '') AS sessionId,
           duration_ms AS durationMs, perf_ttfb_ms AS perfTtfbMs,
           perf_fcp_ms AS perfFcpMs, perf_lcp_ms AS perfLcpMs,
           perf_cls AS perfCls, perf_inp_ms AS perfInpMs
         FROM visits
         WHERE site_pk IN (SELECT site_pk FROM site_identities WHERE site_id IN (?, ?))
           AND started_at >= ? AND started_at < ?`,
      ...siteIds,
      window.startMs,
      window.endExclusiveMs,
    ).sort(
      (left, right) =>
        Number(left.startedAt) - Number(right.startedAt) ||
        String(left.siteId).localeCompare(String(right.siteId)),
    );
    expect(actualDetailRows).toEqual(expectedDetailRows);
    expect(
      queryRows(database, orderedDetailQuery).map((row) => row.startedAt),
    ).toEqual([2 * HOUR_MS + 1, 2 * HOUR_MS + 2]);
    expect(queryRows(database, rollupQuery)).toEqual(
      legacyRows(
        database,
        `SELECT site_id AS siteId, hour_bucket AS hourBucket, views, sessions,
           visitors, bounces, duration_ms_sum AS durationMsSum,
           duration_ms_count AS durationMsCount, visitor_set_json AS visitorSetJson,
           session_counts_json AS sessionCountsJson, perf_ttfb_sum AS perfTtfbSum,
           perf_ttfb_count AS perfTtfbCount, perf_fcp_sum AS perfFcpSum,
           perf_fcp_count AS perfFcpCount, perf_lcp_sum AS perfLcpSum,
           perf_lcp_count AS perfLcpCount, perf_cls_sum AS perfClsSum,
           perf_cls_count AS perfClsCount, perf_inp_sum AS perfInpSum,
           perf_inp_count AS perfInpCount
         FROM visit_hourly_rollups
         WHERE site_pk IN (SELECT site_pk FROM site_identities WHERE site_id IN (?, ?))
           AND hour_bucket >= ? AND hour_bucket < ?
         ORDER BY hour_bucket ASC`,
        ...siteIds,
        2,
        4,
      ),
    );
    expect(
      queryRows(database, detailQuery).find((row) => row.siteId === "site-b"),
    ).toMatchObject({
      durationMs: null,
      perfTtfbMs: null,
    });
  });

  it("keeps final detail-query plans within the optimized membership budget", async () => {
    const fixture = createFixture();
    const siteIds = Array.from(
      { length: 100 },
      (_, index) => `budget-${index}`,
    );
    const sitePks = new Map(
      siteIds.map((siteId) => [siteId, fixture.addSite(siteId)]),
    );
    insertVisit(fixture.database, {
      visitId: "budget-target",
      siteId: siteIds[96]!,
      sitePk: sitePks.get(siteIds[96]!)!,
      startedAt: HOUR_MS + 1,
      visitorId: "budget-visitor",
      sessionId: "budget-session",
      durationMs: 25,
    });

    const window = {
      startMs: HOUR_MS,
      endExclusiveMs: 2 * HOUR_MS,
      nowMs: 3 * HOUR_MS,
      timeZone: "UTC",
    };
    const expectedBySiteCount = new Map([
      [2, { bindings: 6, jsonMembership: false }],
      [96, { bindings: 100, jsonMembership: false }],
      [97, { bindings: 5, jsonMembership: true }],
      [98, { bindings: 5, jsonMembership: true }],
      [99, { bindings: 5, jsonMembership: true }],
      [100, { bindings: 5, jsonMembership: true }],
    ]);

    for (const [count, expected] of expectedBySiteCount) {
      const query = detailVisitsQuery(siteIds.slice(0, count), window);
      assertD1StatementBudget(query);
      expect(query.bindings).toHaveLength(expected.bindings);
      expect(query.sql.includes("json_each(?)")).toBe(expected.jsonMembership);
    }

    const requestedIds = siteIds.slice(0, 98);
    const query = detailVisitsQuery(requestedIds, window, true);
    const actual = await createD1DatabaseClient(fixture.d1).all(query);
    const placeholders = requestedIds.map(() => "?").join(", ");
    const expected = legacyRows(
      fixture.database,
      `SELECT site_id AS siteId, started_at AS startedAt FROM visits
       WHERE site_pk IN (
         SELECT site_pk FROM site_identities WHERE site_id IN (${placeholders})
       ) AND started_at >= ? AND started_at < ? ORDER BY started_at ASC`,
      ...requestedIds,
      window.startMs,
      window.endExclusiveMs,
    );
    expect(
      actual.results.map(({ siteId, startedAt }) => ({ siteId, startedAt })),
    ).toEqual(expected);
    expect(fixture.trace.preparedSql.at(-1)).toBe(query.sql);
    expect(fixture.trace.bindings.at(-1)).toHaveLength(5);
    expect(
      fixture.trace.bindings
        .at(-1)
        ?.some(
          (binding) =>
            typeof binding === "string" &&
            binding.startsWith("[") &&
            JSON.parse(binding).length === requestedIds.length,
        ),
    ).toBe(true);
  });

  it("executes state and rollup chunks across 197 sites on migrated SQLite", async () => {
    const fixture = createFixture();
    const siteIds = Array.from({ length: 197 }, (_, index) => `chunk-${index}`);
    const insertState = fixture.database.prepare(
      `INSERT INTO visit_hourly_aggregation_state
        (site_id, site_pk, aggregated_until_hour, lag_hours, last_run_at,
         last_success_at, last_error)
       VALUES (?, ?, 2, 12, 10, 11, NULL)`,
    );

    for (const siteId of siteIds) {
      const sitePk = fixture.addSite(siteId);
      insertState.run(siteId, sitePk);
      insertLegacyRollup(
        fixture.database,
        siteId,
        sitePk,
        storedRollup(siteId, 1),
        2 * HOUR_MS,
        1,
        DATABASE_NOW,
      );
    }

    const result = await queryOverviewForSitesFromHourlyRollupsPartial(
      { DB: fixture.d1 } as unknown as Env,
      siteIds,
      {
        startMs: HOUR_MS,
        endExclusiveMs: 3 * HOUR_MS,
        nowMs: 4 * HOUR_MS,
        timeZone: "UTC",
      },
    );

    expect(result).toHaveLength(197);
    expect(result.get("chunk-0")).toEqual({
      views: 3,
      sessions: 2,
      visitors: 2,
      bounces: 1,
      totalDuration: 700,
      durationViews: 2,
    });
    expect(result.get("chunk-196")).toEqual(result.get("chunk-0"));
    expect(fixture.trace.preparedSql).toHaveLength(5);
    expect(fixture.trace.bindings.map((bindings) => bindings.length)).toEqual([
      100, 97, 100, 100, 3,
    ]);
    const stateQueries = [
      aggregationStatesQuery(siteIds.slice(0, 100)),
      aggregationStatesQuery(siteIds.slice(100)),
    ];
    const rollupQueries = [
      storedRollupsQuery(siteIds.slice(0, 98), 1, 3),
      storedRollupsQuery(siteIds.slice(98, 196), 1, 3),
      storedRollupsQuery(siteIds.slice(196), 1, 3),
    ];
    [...stateQueries, ...rollupQueries].forEach(assertD1StatementBudget);
  });

  it("matches success batch upserts and writes state for an empty-hour batch", async () => {
    const typed = createFixture();
    const legacy = createFixture();
    const typedPk = typed.addSite("site-write");
    const legacyPk = legacy.addSite("site-write");
    const initial = storedRollup("legacy-rollup-id", 10, {
      views: 1,
      visitorSetJson: '["old"]',
    });
    insertLegacyRollup(
      typed.database,
      "legacy-rollup-id",
      typedPk,
      initial,
      1,
      7,
      2,
    );
    insertLegacyRollup(
      legacy.database,
      "legacy-rollup-id",
      legacyPk,
      initial,
      1,
      7,
      2,
    );
    const seedState = (database: DatabaseSync, sitePk: number) =>
      database
        .prepare(
          `INSERT INTO visit_hourly_aggregation_state
            (site_id, site_pk, aggregated_until_hour, lag_hours, last_run_at,
             last_success_at, last_error)
           VALUES ('state-original-id', ?, 8, 3, 5, 6, 'previous')`,
        )
        .run(sitePk);
    seedState(typed.database, typedPk);
    seedState(legacy.database, legacyPk);

    const rows = new Map<number, StoredRollupRow>([
      [10, storedRollup("site-write", 10, { views: 4 })],
      [
        11,
        storedRollup("site-write", 11, { views: 7, visitorSetJson: '["new"]' }),
      ],
    ]);
    const mutations = prepareAggregationSuccessMutations(
      "site-write",
      typedPk,
      11,
      1_700_000_000_000,
      rows,
    );
    expect(mutations.map((mutation) => mutation.tag)).toEqual([
      "scheduled_tasks.hourly_rollup.upsert_hour",
      "scheduled_tasks.hourly_rollup.upsert_hour",
      "scheduled_tasks.hourly_rollup.update_state",
    ]);
    expect(mutations.map((mutation) => mutation.sql)).not.toContain(
      expect.stringContaining("site_id = excluded.site_id"),
    );
    mutations.forEach(assertD1StatementBudget);
    await createD1DatabaseClient(typed.d1).batch(mutations);
    for (const row of rows.values()) {
      insertLegacyRollup(
        legacy.database,
        "site-write",
        legacyPk,
        row,
        1_700_000_000_000,
        1,
        DATABASE_NOW,
      );
    }
    legacy.database
      .prepare(
        `INSERT INTO visit_hourly_aggregation_state (
          site_id, site_pk, aggregated_until_hour, lag_hours, last_run_at,
          last_success_at, last_error
        ) VALUES (?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(site_pk) DO UPDATE SET
          site_pk = excluded.site_pk,
          aggregated_until_hour = excluded.aggregated_until_hour,
          lag_hours = excluded.lag_hours,
          last_run_at = excluded.last_run_at,
          last_success_at = excluded.last_success_at,
          last_error = NULL`,
      )
      .run("site-write", legacyPk, 11, 12, DATABASE_NOW, DATABASE_NOW);

    const rollupSelect = `SELECT * FROM visit_hourly_rollups ORDER BY hour_bucket`;
    const stateSelect = `SELECT * FROM visit_hourly_aggregation_state`;
    expect(typed.database.prepare(rollupSelect).all()).toEqual(
      legacy.database.prepare(rollupSelect).all(),
    );
    expect(typed.database.prepare(stateSelect).all()).toEqual(
      legacy.database.prepare(stateSelect).all(),
    );
    expect(typed.trace.batchStatements?.[0]).toHaveLength(3);
    expect(
      typed.database
        .prepare(
          "SELECT site_id, aggregated_until_hour, lag_hours, last_run_at, last_success_at, last_error FROM visit_hourly_aggregation_state",
        )
        .get(),
    ).toEqual({
      site_id: "state-original-id",
      aggregated_until_hour: 11,
      lag_hours: 12,
      last_run_at: DATABASE_NOW,
      last_success_at: DATABASE_NOW,
      last_error: null,
    });

    const emptySitePk = typed.addSite("site-empty-rollup");
    const emptyMutations = prepareAggregationSuccessMutations(
      "site-empty-rollup",
      emptySitePk,
      15,
      1_700_000_000_000,
      new Map(),
    );
    expect(emptyMutations).toHaveLength(1);
    await createD1DatabaseClient(typed.d1).batch(emptyMutations);
    expect(
      typed.database
        .prepare(
          "SELECT aggregated_until_hour, last_run_at, last_success_at FROM visit_hourly_aggregation_state WHERE site_pk = ?",
        )
        .get(emptySitePk),
    ).toEqual({
      aggregated_until_hour: 15,
      last_run_at: DATABASE_NOW,
      last_success_at: DATABASE_NOW,
    });
  });

  it("retains the 169-mutation maximum hour batch and budgets each statement", async () => {
    const fixture = createFixture();
    const sitePk = fixture.addSite("site-full-week");
    const rows = new Map<number, StoredRollupRow>();
    for (let index = 0; index < 168; index += 1) {
      rows.set(index, storedRollup("site-full-week", index));
    }
    const mutations = prepareAggregationSuccessMutations(
      "site-full-week",
      sitePk,
      167,
      1_700_000_000_000,
      rows,
    );
    expect(mutations).toHaveLength(169);
    mutations.forEach(assertD1StatementBudget);
    await createD1DatabaseClient(fixture.d1).batch(mutations);
    expect(fixture.trace.batchStatements?.[0]).toHaveLength(169);
    expect(
      fixture.database
        .prepare("SELECT COUNT(*) AS count FROM visit_hourly_rollups")
        .get(),
    ).toEqual({ count: 168 });
    expect(
      fixture.database
        .prepare(
          "SELECT aggregated_until_hour FROM visit_hourly_aggregation_state WHERE site_pk = ?",
        )
        .get(sitePk),
    ).toEqual({ aggregated_until_hour: 167 });
  });

  it("preserves stale visit boundaries and only failure-state conflict fields", async () => {
    const fixture = createFixture();
    const sitePk = fixture.addSite("site-state");
    insertVisit(fixture.database, {
      visitId: "stale-open",
      siteId: "site-state",
      sitePk,
      startedAt: 10,
      lastActivityAt: 99,
      status: "open",
      exitReason: "keep-on-timeout",
      updatedAt: 50,
    });
    insertVisit(fixture.database, {
      visitId: "at-cutoff-open",
      siteId: "site-state",
      sitePk,
      startedAt: 11,
      lastActivityAt: 100,
      status: "open",
      updatedAt: 51,
    });
    insertVisit(fixture.database, {
      visitId: "later-open",
      siteId: "site-state",
      sitePk,
      startedAt: 12,
      lastActivityAt: 101,
      status: "open",
      updatedAt: 52,
    });
    const finalized = await createD1DatabaseClient(fixture.d1).run(
      prepareFinalizeStaleOpenVisitsMutation(100, 999),
    );
    expect(finalized.meta?.changes).toBe(1);
    expect(
      fixture.database
        .prepare(
          `SELECT status, last_activity_at, ended_at, finalized_at, duration_ms,
             duration_source, exit_reason, updated_at FROM visits
           WHERE visit_id = 'stale-open'`,
        )
        .get(),
    ).toEqual({
      status: "timeout",
      last_activity_at: 999,
      ended_at: 999,
      finalized_at: 999,
      duration_ms: null,
      duration_source: "timeout",
      exit_reason: "keep-on-timeout",
      updated_at: 50,
    });
    expect(
      fixture.database
        .prepare(
          "SELECT status, last_activity_at FROM visits WHERE visit_id = 'at-cutoff-open'",
        )
        .get(),
    ).toEqual({ status: "open", last_activity_at: 100 });

    fixture.database
      .prepare(
        `INSERT INTO visit_hourly_aggregation_state
          (site_id, site_pk, aggregated_until_hour, lag_hours, last_run_at,
           last_success_at, last_error)
         VALUES ('state-original', ?, 17, 4, 10, 11, 'old-error')`,
      )
      .run(sitePk);
    await createD1DatabaseClient(fixture.d1).run(
      prepareAggregationFailureMutation("site-state", sitePk, "new-error"),
    );
    expect(
      fixture.database
        .prepare(
          "SELECT * FROM visit_hourly_aggregation_state WHERE site_pk = ?",
        )
        .get(sitePk),
    ).toEqual({
      site_id: "state-original",
      aggregated_until_hour: 17,
      lag_hours: 4,
      last_run_at: DATABASE_NOW,
      last_success_at: 11,
      last_error: "new-error",
      site_pk: sitePk,
    });

    const newSitePk = fixture.addSite("site-first-failure");
    await createD1DatabaseClient(fixture.d1).run(
      prepareAggregationFailureMutation(
        "site-first-failure",
        newSitePk,
        "first",
      ),
    );
    expect(
      fixture.database
        .prepare(
          "SELECT aggregated_until_hour, lag_hours, last_run_at, last_success_at, last_error FROM visit_hourly_aggregation_state WHERE site_pk = ?",
        )
        .get(newSitePk),
    ).toEqual({
      aggregated_until_hour: 0,
      lag_hours: 12,
      last_run_at: DATABASE_NOW,
      last_success_at: null,
      last_error: "first",
    });
  });
});
