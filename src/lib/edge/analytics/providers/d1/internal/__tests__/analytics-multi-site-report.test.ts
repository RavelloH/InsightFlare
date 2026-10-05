import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { D1_MAX_BOUND_PARAMETERS, D1_MAX_SQL_UTF8_BYTES } from "@/lib/db";
import { explainQueryPlan } from "@/lib/db/__tests__/query-plan";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import type {
  EpochMs,
  ReportingTimeZone,
  SiteId,
  TeamId,
} from "@/lib/edge/analytics/contract/types";
import { buildEventRecordDetailPlan } from "@/lib/edge/analytics/engine/event-record-detail-plan";
import { buildJourneyObservationPlan } from "@/lib/edge/analytics/engine/journey-observation-plan";
import { buildJourneyPageviewDetailPlan } from "@/lib/edge/analytics/engine/journey-page-report-plan";
import { LogicalPlanBuilder } from "@/lib/edge/analytics/engine/logical/builder";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import { resolveAnalyticsScope } from "@/lib/edge/analytics/engine/semantic/entities";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { createSemanticTemporalDomains } from "@/lib/edge/analytics/engine/semantic/time";
import { AnalyticsLogicalToDbLowerer } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";
import { queryAnalyticsReportOutputRowsFromD1 } from "@/lib/edge/analytics/providers/d1/internal/analytics-report-query";
import { instrumentEnv } from "@/lib/edge/observability/bindings";
import {
  createInvocationLogger,
  runWithD1Operation,
  runWithInvocationLogger,
} from "@/lib/edge/observability/logger";
import type { Env } from "@/lib/edge/types";

const SITE_A = "wave25-report-a";
const SITE_B = "wave25-report-b";
const SITE_OUTSIDE = "wave25-report-outside";
const MISSING_SITE = "wave25-report-missing";
const RANGE = { startMs: 100, endExclusiveMs: 200 } as const;
const WINDOW = {
  ...RANGE,
  nowMs: 500,
  timeZone: "UTC",
} as const;

interface Site {
  readonly id: string;
  readonly pk: number;
}

interface QueryMetric {
  readonly tag?: string | null;
  readonly sqlBytes?: number | null;
  readonly bindings?: number | null;
  readonly physicalPlanHash?: string | null;
}

interface QueryResult {
  readonly rows: Record<string, unknown>[];
  readonly statementCount: number;
  readonly sql: string;
  readonly bindings: SQLInputValue[];
  readonly metric: QueryMetric;
}

let db: DatabaseSync;
let siteA: Site;
let siteB: Site;
let siteOutside: Site;

function addSite(database: DatabaseSync, siteId: string): Site {
  database
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .run(siteId);
  const row = database
    .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
    .get(siteId) as { readonly site_pk: number };
  return { id: siteId, pk: Number(row.site_pk) };
}

function addVisit(
  database: DatabaseSync,
  site: Site,
  input: {
    readonly id: string;
    readonly session: string;
    readonly startedAt: number;
    readonly pathname: string;
  },
): void {
  database
    .prepare(
      "INSERT INTO visits (visit_id, site_id, site_pk, visitor_id, session_id, status, started_at, last_activity_at, pathname, hostname) " +
        "VALUES (?, ?, ?, 'CaseVisitor', ?, 'closed', ?, ?, ?, 'wave25.test')",
    )
    .run(
      input.id,
      site.id,
      site.pk,
      input.session,
      input.startedAt,
      input.startedAt,
      input.pathname,
    );
}

function addName(
  database: DatabaseSync,
  site: Site,
  id: number,
  name: string,
): void {
  database
    .prepare(
      "INSERT INTO custom_event_names (id, site_id, name, last_seen_at, site_pk) VALUES (?, ?, ?, 1, ?)",
    )
    .run(id, site.id, name, site.pk);
}

function addEvent(
  database: DatabaseSync,
  site: Site,
  input: {
    readonly id: string;
    readonly visitId: string;
    readonly nameId: number;
    readonly occurredAt: number;
  },
): void {
  database
    .prepare(
      "INSERT INTO custom_events (event_id, site_id, visit_id, event_name_id, occurred_at, received_at, sequence, node_count, value_count, site_pk) " +
        "VALUES (?, ?, ?, ?, ?, 777, 3, 4, 5, ?)",
    )
    .run(
      input.id,
      site.id,
      input.visitId,
      input.nameId,
      input.occurredAt,
      site.pk,
    );
}

function createReportPlan(siteIds: readonly string[]): ValidatedLogicalPlan {
  const range = {
    startMs: RANGE.startMs as EpochMs,
    endExclusiveMs: RANGE.endExclusiveMs as EpochMs,
  };
  const builder = new LogicalPlanBuilder({
    subject: createSemanticSubjectDomain({
      origin: "team",
      teamId: "wave25-team" as TeamId,
      siteIds: siteIds.map((siteId) => siteId as SiteId),
    }),
    time: createSemanticTemporalDomains({
      candidate: range,
      read: { kind: "bounded", range },
      reportingTimeZone: "UTC" as ReportingTimeZone,
      capturedAtMs: 500 as EpochMs,
    }),
    scope: resolveAnalyticsScope("auto"),
  });

  const pages = builder.source("page", {
    temporalDomain: "read",
    attributes: [
      "page.report.localId",
      "page.report.sessionId",
      "page.report.startedAt",
      "page.report.pathname",
      "page.report.previousVisitId",
      "page.report.previousVisitStartedAt",
    ],
  });
  builder.output("page-report", pages, [
    { name: "visitId", slot: "attribute:page.report.localId" },
    { name: "sessionId", slot: "attribute:page.report.sessionId" },
    { name: "startedAt", slot: "attribute:page.report.startedAt" },
    { name: "pathname", slot: "attribute:page.report.pathname" },
    {
      name: "previousVisitId",
      slot: "attribute:page.report.previousVisitId",
    },
    {
      name: "previousVisitStartedAt",
      slot: "attribute:page.report.previousVisitStartedAt",
    },
  ]);

  const events = builder.source("event", {
    temporalDomain: "read",
    relationships: ["event.observation"],
    attributes: [
      "event.report.localId",
      "event.report.eventName",
      "event.report.occurredAt",
      "event.report.ownerVisitId",
      "event.report.ownerSessionId",
      "event.report.ownerPathname",
      "event.report.ownerPreviousVisitId",
      "event.report.ownerPreviousVisitStartedAt",
    ],
  });
  builder.output("event-report", events, [
    { name: "eventId", slot: "attribute:event.report.localId" },
    { name: "eventName", slot: "attribute:event.report.eventName" },
    { name: "occurredAt", slot: "attribute:event.report.occurredAt" },
    { name: "visitId", slot: "attribute:event.report.ownerVisitId" },
    {
      name: "ownerSessionId",
      slot: "attribute:event.report.ownerSessionId",
    },
    { name: "ownerPathname", slot: "attribute:event.report.ownerPathname" },
    {
      name: "ownerPreviousVisitId",
      slot: "attribute:event.report.ownerPreviousVisitId",
    },
    {
      name: "ownerPreviousVisitStartedAt",
      slot: "attribute:event.report.ownerPreviousVisitStartedAt",
    },
  ]);

  const observations = builder.source("observation", {
    temporalDomain: "read",
    attributes: ["observation.kind", "observation.id"],
    includeOccurrenceTime: true,
  });
  builder.output("observation-report", observations, [
    { name: "kind", slot: "attribute:observation.kind" },
    { name: "id", slot: "attribute:observation.id" },
    { name: "occurredAt", slot: "time" },
  ]);
  return builder.finish();
}

function sqliteEnv(database: DatabaseSync, trace?: SqliteD1Trace): Env {
  return { DB: createSqliteD1Database(database, trace) } as unknown as Env;
}

async function queryOutput(
  database: DatabaseSync,
  plan: ValidatedLogicalPlan,
  outputId: string,
): Promise<QueryResult> {
  const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
  const logger = createInvocationLogger({
    source: "worker",
    trigger: "request",
  });
  const env = instrumentEnv(sqliteEnv(database, trace), logger);
  const rows = await runWithInvocationLogger(logger, () =>
    runWithD1Operation("wave25.analytics_report." + outputId, () =>
      queryAnalyticsReportOutputRowsFromD1(env, plan, outputId),
    ),
  );
  const emitted = await logger.emitWhenComplete();
  const metric = emitted.logs.find((entry) =>
    entry.message.startsWith("db.query.v1.all.success"),
  )?.data as QueryMetric | undefined;
  const sql = trace.preparedSql[0];
  const bindings = trace.bindings[0];
  if (!metric || !sql || !bindings)
    throw new Error("wave25_report_query_diagnostics_missing:" + outputId);
  return {
    rows,
    statementCount: trace.preparedSql.length,
    sql,
    bindings,
    metric,
  };
}

function rowsByJson(rows: readonly Record<string, unknown>[]) {
  return rows.map((row) => JSON.stringify(row)).sort();
}

function legacyPageRows(sitePks: readonly number[]) {
  const placeholders = sitePks.map(() => "?").join(", ");
  return db
    .prepare(
      "SELECT v.visit_id AS visitId, v.session_id AS sessionId, v.started_at AS startedAt, v.pathname, " +
        "(SELECT p.visit_id FROM visits p WHERE p.site_pk = v.site_pk AND p.session_id = v.session_id AND p.started_at < v.started_at ORDER BY p.started_at DESC, p.visit_id DESC LIMIT 1) AS previousVisitId, " +
        "(SELECT p.started_at FROM visits p WHERE p.site_pk = v.site_pk AND p.session_id = v.session_id AND p.started_at < v.started_at ORDER BY p.started_at DESC, p.visit_id DESC LIMIT 1) AS previousVisitStartedAt " +
        "FROM visits v WHERE v.site_pk IN (" +
        placeholders +
        ") AND v.started_at >= ? AND v.started_at < ?",
    )
    .all(...sitePks, RANGE.startMs, RANGE.endExclusiveMs) as Record<
    string,
    unknown
  >[];
}

function legacyEventRows(sitePks: readonly number[]) {
  const placeholders = sitePks.map(() => "?").join(", ");
  return db
    .prepare(
      "SELECT ce.event_id AS eventId, cen.name AS eventName, ce.occurred_at AS occurredAt, ce.visit_id AS visitId, " +
        "v.session_id AS ownerSessionId, v.pathname AS ownerPathname, " +
        "(SELECT p.visit_id FROM visits p WHERE p.site_pk = v.site_pk AND p.session_id = v.session_id AND p.started_at < v.started_at ORDER BY p.started_at DESC, p.visit_id DESC LIMIT 1) AS ownerPreviousVisitId, " +
        "(SELECT p.started_at FROM visits p WHERE p.site_pk = v.site_pk AND p.session_id = v.session_id AND p.started_at < v.started_at ORDER BY p.started_at DESC, p.visit_id DESC LIMIT 1) AS ownerPreviousVisitStartedAt " +
        "FROM custom_events ce LEFT JOIN custom_event_names cen ON cen.id = ce.event_name_id " +
        "LEFT JOIN visits v ON v.site_pk = ce.site_pk AND v.visit_id = ce.visit_id " +
        "WHERE ce.site_pk IN (" +
        placeholders +
        ") AND ce.occurred_at >= ? AND ce.occurred_at < ?",
    )
    .all(...sitePks, RANGE.startMs, RANGE.endExclusiveMs) as Record<
    string,
    unknown
  >[];
}

function legacyObservationRows(sitePks: readonly number[]) {
  const placeholders = sitePks.map(() => "?").join(", ");
  return db
    .prepare(
      "SELECT 'page' AS kind, visit_id AS id, started_at AS occurredAt FROM visits WHERE site_pk IN (" +
        placeholders +
        ") AND started_at >= ? AND started_at < ? UNION ALL " +
        "SELECT 'event' AS kind, ce.event_id AS id, ce.occurred_at AS occurredAt FROM custom_events ce " +
        "INNER JOIN visits v ON v.site_pk = ce.site_pk AND v.visit_id = ce.visit_id WHERE ce.site_pk IN (" +
        placeholders +
        ") AND ce.occurred_at >= ? AND ce.occurred_at < ?",
    )
    .all(
      ...sitePks,
      RANGE.startMs,
      RANGE.endExclusiveMs,
      ...sitePks,
      RANGE.startMs,
      RANGE.endExclusiveMs,
    ) as Record<string, unknown>[];
}

function insertFixtures(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = OFF");
  siteA = addSite(database, SITE_A);
  siteB = addSite(database, SITE_B);
  siteOutside = addSite(database, SITE_OUTSIDE);

  addVisit(database, siteA, {
    id: "a-prior",
    session: "shared-session",
    startedAt: 90,
    pathname: "/a-prior",
  });
  addVisit(database, siteB, {
    id: "b-nearest-prior",
    session: "shared-session",
    startedAt: 115,
    pathname: "/b-prior",
  });
  addVisit(database, siteA, {
    id: "a-current",
    session: "shared-session",
    startedAt: 120,
    pathname: "/a-current",
  });
  addVisit(database, siteB, {
    id: "b-current",
    session: "shared-session",
    startedAt: 125,
    pathname: "/b-current",
  });
  addVisit(database, siteA, {
    id: "a-boundary",
    session: "shared-session",
    startedAt: 200,
    pathname: "/a-boundary",
  });
  addVisit(database, siteOutside, {
    id: "outside-current",
    session: "shared-session",
    startedAt: 150,
    pathname: "/outside",
  });

  addName(database, siteA, 11, "A event name");
  addName(database, siteB, 12, "B foreign dictionary name");
  addEvent(database, siteA, {
    id: "a-current",
    visitId: "a-current",
    nameId: 11,
    occurredAt: 120,
  });
  addEvent(database, siteB, {
    id: "b-event",
    visitId: "b-current",
    nameId: 12,
    occurredAt: 125,
  });
  addEvent(database, siteA, {
    id: "a-foreign-name",
    visitId: "a-current",
    nameId: 12,
    occurredAt: 126,
  });
  addEvent(database, siteA, {
    id: "a-orphan-name",
    visitId: "a-current",
    nameId: 99,
    occurredAt: 127,
  });
  addEvent(database, siteA, {
    id: "a-cross-site-owner",
    visitId: "b-current",
    nameId: 11,
    occurredAt: 128,
  });
  addEvent(database, siteA, {
    id: "a-owner-outside-window",
    visitId: "a-prior",
    nameId: 11,
    occurredAt: 129,
  });
  addEvent(database, siteA, {
    id: "a-event-boundary",
    visitId: "a-current",
    nameId: 11,
    occurredAt: 200,
  });
  addEvent(database, siteOutside, {
    id: "outside-event",
    visitId: "outside-current",
    nameId: 11,
    occurredAt: 150,
  });
}

beforeAll(() => {
  db = createMigratedDatabase();
  insertFixtures(db);
});

afterAll(() => db.close());

describe("authorized multi-site Analytics report lowering", () => {
  it("matches Page, Event, and Observation rows and keeps A/B/A outputs isolated", async () => {
    const siteIds = [SITE_A, SITE_B, MISSING_SITE];
    const plan = createReportPlan(siteIds);
    const expectedPages = legacyPageRows([siteA.pk, siteB.pk]);
    const expectedEvents = legacyEventRows([siteA.pk, siteB.pk]);
    const expectedObservations = legacyObservationRows([siteA.pk, siteB.pk]);

    const pageA = await queryOutput(db, plan, "page-report");
    const eventB = await queryOutput(db, plan, "event-report");
    const pageAAgain = await queryOutput(db, plan, "page-report");
    const observations = await queryOutput(db, plan, "observation-report");

    expect(rowsByJson(pageA.rows)).toEqual(rowsByJson(expectedPages));
    expect(rowsByJson(eventB.rows)).toEqual(rowsByJson(expectedEvents));
    expect(rowsByJson(pageAAgain.rows)).toEqual(rowsByJson(expectedPages));
    expect(rowsByJson(observations.rows)).toEqual(
      rowsByJson(expectedObservations),
    );
    expect(pageA.sql).toBe(pageAAgain.sql);
    expect(pageA.metric.physicalPlanHash).toBe(
      pageAAgain.metric.physicalPlanHash,
    );
    for (const result of [pageA, eventB, pageAAgain, observations]) {
      expect(result.statementCount).toBe(1);
      expect(result.metric.tag).toBe(
        "wave25.analytics_report." +
          (result === eventB
            ? "event-report"
            : result === observations
              ? "observation-report"
              : "page-report"),
      );
      expect(result.metric.sqlBytes).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
      expect(result.metric.bindings).toBeLessThanOrEqual(
        D1_MAX_BOUND_PARAMETERS,
      );
    }
    expect(pageA.metric.physicalPlanHash).toMatch(/^v1:/u);
    expect(eventB.metric.physicalPlanHash).toMatch(/^v1:/u);
    expect(observations.metric.physicalPlanHash).toMatch(/^v1:/u);
    expect(
      [pageA, eventB, observations].map((result) => ({
        tag: result.metric.tag,
        sqlBytes: result.metric.sqlBytes,
        bindings: result.metric.bindings,
        physicalPlanHash: result.metric.physicalPlanHash,
        statements: result.statementCount,
      })),
    ).toEqual([
      {
        tag: "wave25.analytics_report.page-report",
        sqlBytes: 6323,
        bindings: 7,
        physicalPlanHash:
          "v1:431901ecd4b4fefc78ad5d2c72120ed1bf8c137c50de63706a0a23c3a08e6107",
        statements: 1,
      },
      {
        tag: "wave25.analytics_report.event-report",
        sqlBytes: 5949,
        bindings: 7,
        physicalPlanHash:
          "v1:2f8aa6552bb6e150707a87b2ca3a0dd7b7cdc98f46a18b9f8653f76fe79358a6",
        statements: 1,
      },
      {
        tag: "wave25.analytics_report.observation-report",
        sqlBytes: 3823,
        bindings: 9,
        physicalPlanHash:
          "v1:61de2d201592fda458f79ac2cddb0af383d349df73ca51b51e79e6b82e884423",
        statements: 1,
      },
    ]);

    expect(pageA.rows.find((row) => row.visitId === "a-current")).toMatchObject(
      {
        previousVisitId: "a-prior",
        previousVisitStartedAt: 90,
      },
    );
    expect(
      eventB.rows.find((row) => row.eventId === "a-foreign-name"),
    ).toMatchObject({
      eventName: "B foreign dictionary name",
      ownerSessionId: "shared-session",
    });
    expect(
      eventB.rows.find((row) => row.eventId === "a-cross-site-owner"),
    ).toMatchObject({
      visitId: "b-current",
      ownerSessionId: null,
      ownerPathname: null,
    });
    expect(
      eventB.rows.find((row) => row.eventId === "a-owner-outside-window"),
    ).toMatchObject({
      ownerPathname: "/a-prior",
      ownerPreviousVisitId: null,
    });
    expect(observations.rows).toContainEqual({
      kind: "page",
      id: "a-current",
      occurredAt: 120,
    });
    expect(observations.rows).toContainEqual({
      kind: "event",
      id: "a-current",
      occurredAt: 120,
    });
  });

  it("rejects empty and mismatched report subject site sets", async () => {
    const multiSitePlan = createReportPlan([SITE_A, SITE_B]);
    expect(
      () =>
        new AnalyticsLogicalToDbLowerer(multiSitePlan, {
          siteIds: [SITE_A],
          time: multiSitePlan.context.time,
        }),
    ).toThrow(
      "Storage site IDs must exactly match the authorized Semantic subject.",
    );

    const emptySitePlan = {
      ...multiSitePlan,
      context: {
        ...multiSitePlan.context,
        subject: createSemanticSubjectDomain({
          origin: "team",
          teamId: "wave25-team" as TeamId,
          siteIds: [],
        }),
      },
    } as ValidatedLogicalPlan;
    await expect(
      queryAnalyticsReportOutputRowsFromD1(
        sqliteEnv(db),
        emptySitePlan,
        "page-report",
      ),
    ).rejects.toThrow("analytics_report_site_subject_unsupported:0");
  });

  it.each([90, 91])(
    "uses one bounded indexed site-set query for %i authorized IDs",
    async (siteCount) => {
      const fillers = Array.from(
        { length: siteCount - 2 },
        (_unused, index) => "wave25-unprovisioned-" + index.toString(),
      );
      const siteIds = [SITE_A, SITE_B, ...fillers];
      const plan = createReportPlan(siteIds);
      const result = await queryOutput(db, plan, "page-report");

      expect(result.rows.map((row) => row.visitId).sort()).toEqual(
        ["a-current", "b-current", "b-nearest-prior"].sort(),
      );
      expect(result.metric.sqlBytes).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
      expect(result.metric.bindings).toBeLessThanOrEqual(
        D1_MAX_BOUND_PARAMETERS,
      );
      expect({
        sqlBytes: result.metric.sqlBytes,
        bindings: result.metric.bindings,
        physicalPlanHash: result.metric.physicalPlanHash,
        statements: result.statementCount,
      }).toEqual(
        siteCount === 90
          ? {
              sqlBytes: 6584,
              bindings: 94,
              physicalPlanHash:
                "v1:2d5fde37b9522d7a0345bc1e2d03900ca908f7cbd6cf51a202dff6f0af9df6c0",
              statements: 1,
            }
          : {
              sqlBytes: 6587,
              bindings: 95,
              physicalPlanHash:
                "v1:59fb9e8ad2f6bcf185861c87a8a20a1bdf45565095bafe72ddf77ba61310f641",
              statements: 1,
            },
      );
      expect(
        explainQueryPlan(db, {
          sql: result.sql,
          bindings: result.bindings,
        }).join(" "),
      ).toContain("sqlite_autoindex_site_identities_1");
    },
  );

  it("preserves the single-site production Page, Event, and Observation budgets", async () => {
    const probes = [
      {
        plan: buildJourneyPageviewDetailPlan({
          siteId: "journey-page-report-a",
          eventId: "page-current",
          window: WINDOW,
        }),
        output: "journey-pageview-detail",
        bytes: 11252,
        bindings: 7,
        hash: "v1:bfde1227b37718ab2d690d4544ecca1d32bfb118d74cd8dee98073c309e966d6",
      },
      {
        plan: buildEventRecordDetailPlan({
          siteId: "event-record-detail-a",
          eventId: "event-main",
          window: {
            startMs: 120,
            endExclusiveMs: 130,
            nowMs: 500,
            timeZone: "UTC",
          },
        }),
        output: "event-record-detail",
        bytes: 15793,
        bindings: 7,
        hash: "v1:fb839d3e3dcd4262ecf1e6bd3eeda80c485d19833724b03f7f47851f3c442bfb",
      },
      {
        plan: buildJourneyObservationPlan({
          siteId: "journey-observation-a",
          target: { type: "visitor", value: "CaseVisitor" },
          shape: "detail-source",
          window: WINDOW,
        }),
        output: "journey-observation-detail-source",
        bytes: 14042,
        bindings: 21,
        hash: "v1:d7039ee2bcba513f1d402ab10537e594f628670ab5d13af94d9ebbbdbdfc85b7",
      },
    ];

    for (const probe of probes) {
      const result = await queryOutput(db, probe.plan, probe.output);
      expect(result.metric.sqlBytes).toBe(probe.bytes);
      expect(result.metric.bindings).toBe(probe.bindings);
      expect(result.metric.physicalPlanHash).toBe(probe.hash);
    }
  });
});
