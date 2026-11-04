import type { DatabaseSync } from "node:sqlite";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  compileD1Query,
  createD1DatabaseClient,
  D1_MAX_BOUND_PARAMETERS,
  D1_MAX_SQL_UTF8_BYTES,
  lowerLogicalPlan,
} from "@/lib/db";
import { explainQueryPlan } from "@/lib/db/__tests__/query-plan";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import type {
  EpochMs,
  ReportingTimeZone,
  SiteId,
} from "@/lib/edge/analytics/contract/types";
import { buildJourneyPageviewDetailPlan } from "@/lib/edge/analytics/engine/journey-page-report-plan";
import { buildJourneySessionLocationPlan } from "@/lib/edge/analytics/engine/journey-page-report-plan";
import { LogicalPlanBuilder } from "@/lib/edge/analytics/engine/logical/builder";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import { resolveAnalyticsScope } from "@/lib/edge/analytics/engine/semantic/entities";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { createSemanticTemporalDomains } from "@/lib/edge/analytics/engine/semantic/time";
import { AnalyticsLogicalToDbLowerer } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";
import { AnalyticsRelationalStorage } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-storage";
import {
  mapJourneyPageviewDetail,
  queryJourneyEventDetailFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/journey-detail-queries";
import { querySessionLocationPointsFromD1 } from "@/lib/edge/analytics/providers/d1/internal/journey-geo-queries";
import { mapGeoPointRow } from "@/lib/edge/analytics/providers/d1/internal/journey-helpers";
import { queryJourneyPageReportRowsFromD1 } from "@/lib/edge/analytics/providers/d1/internal/journey-page-report-query";
import { instrumentEnv } from "@/lib/edge/observability/bindings";
import {
  createInvocationLogger,
  runWithD1Operation,
  runWithInvocationLogger,
} from "@/lib/edge/observability/logger";
import type { Env } from "@/lib/edge/types";

const SITE_A = "journey-page-report-a";
const SITE_B = "journey-page-report-b";
const WINDOW = {
  startMs: 100,
  endExclusiveMs: 200,
  nowMs: 500,
  timeZone: "UTC",
} as const;

interface Site {
  readonly id: string;
  readonly pk: number;
}

let db: DatabaseSync;
let siteA: Site;
let siteB: Site;

function addSite(database: DatabaseSync, id: string): Site {
  database.prepare("INSERT INTO site_identities (site_id) VALUES (?)").run(id);
  const row = database
    .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
    .get(id) as { readonly site_pk: number };
  return { id, pk: Number(row.site_pk) };
}

function addVisit(
  database: DatabaseSync,
  site: Site,
  input: {
    readonly id: string | null;
    readonly session: string;
    readonly time: number;
    readonly latitude?: number | string | null;
    readonly longitude?: number | string | null;
    readonly pathname?: string;
    readonly country?: string;
    readonly region?: string;
    readonly regionCode?: string;
    readonly city?: string;
    readonly userId?: string | null;
    readonly userName?: string | null;
  },
): void {
  database
    .prepare(
      `INSERT INTO visits
        (visit_id, site_id, site_pk, visitor_id, session_id, status,
         started_at, last_activity_at, pathname, hostname, latitude, longitude,
         country, region, region_code, city, user_id, user_name)
       VALUES (?, ?, ?, 'visitor', ?, 'closed', ?, ?, ?, 'journey.test', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      site.id,
      site.pk,
      input.session,
      input.time,
      input.time,
      input.pathname ?? `/${input.id ?? "null"}`,
      input.latitude ?? null,
      input.longitude ?? null,
      input.country ?? "",
      input.region ?? "",
      input.regionCode ?? "",
      input.city ?? "",
      input.userId ?? null,
      input.userName ?? null,
    );
}

function sqliteEnv(database: DatabaseSync, trace?: SqliteD1Trace): Env {
  return { DB: createSqliteD1Database(database, trace) } as unknown as Env;
}

function createPageBuilder(siteId: string): LogicalPlanBuilder {
  const range = {
    startMs: WINDOW.startMs as EpochMs,
    endExclusiveMs: WINDOW.endExclusiveMs as EpochMs,
  };
  return new LogicalPlanBuilder({
    subject: createSemanticSubjectDomain({
      origin: "site",
      siteIds: [siteId as SiteId],
    }),
    time: createSemanticTemporalDomains({
      candidate: range,
      read: { kind: "bounded", range },
      reportingTimeZone: WINDOW.timeZone as ReportingTimeZone,
      capturedAtMs: WINDOW.nowMs as EpochMs,
    }),
    scope: resolveAnalyticsScope("auto"),
  });
}

function rawPreviousPagePlan(siteId: string, eventId: string) {
  const builder = createPageBuilder(siteId);
  const pages = builder.source("page", {
    temporalDomain: "read",
    attributes: [
      "page.report.localId",
      "page.report.previousVisitId",
      "page.report.previousVisitStartedAt",
    ],
  });
  const current = builder.filter(
    pages,
    builder.compare(
      "eq",
      builder.slot(pages, "attribute:page.report.localId"),
      builder.literal(eventId, { kind: "scalar", scalar: "string" }),
    ),
  );
  const one = builder.limit(current, 1);
  builder.output("raw-previous", one, [
    {
      name: "previousVisitId",
      slot: "attribute:page.report.previousVisitId",
    },
    {
      name: "previousVisitStartedAt",
      slot: "attribute:page.report.previousVisitStartedAt",
    },
  ]);
  return builder.finish();
}

async function executeLogicalOutput(
  database: DatabaseSync,
  plan: ValidatedLogicalPlan,
  outputId: string,
): Promise<Record<string, unknown>[]> {
  const output = plan.outputs.find((candidate) => candidate.id === outputId);
  if (!output) throw new Error(`missing_test_output:${outputId}`);
  const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
    siteId: plan.context.subject.siteIds[0]!,
    time: plan.context.time,
  });
  const relation = lowerer.projectOutput(
    lowerer.lower(output),
    output.fields.map((field) => ({ name: field.name, slot: field.slot })),
  );
  const query = compileD1Query(lowerLogicalPlan(relation));
  const result = await createD1DatabaseClient(
    createSqliteD1Database(database),
  ).all(query);
  return result.results as Record<string, unknown>[];
}

const LEGACY_LOCATION_SQL = `
SELECT latitude, longitude, started_at AS timestampMs, country, region,
       region_code AS regionCode, city
FROM visits
WHERE site_pk = (SELECT site_pk FROM site_identities WHERE site_id = ?)
  AND session_id = ?
  AND latitude IS NOT NULL
  AND longitude IS NOT NULL
  AND ABS(latitude) <= 90
  AND ABS(longitude) <= 180
ORDER BY timestampMs ASC, visit_id ASC`;

function legacyLocationRows(sessionId: string): Record<string, unknown>[] {
  return db.prepare(LEGACY_LOCATION_SQL).all(SITE_A, sessionId) as Record<
    string,
    unknown
  >[];
}

const LEGACY_PAGEVIEW_SQL = `
SELECT
  v.visit_id AS visitId, v.session_id AS sessionId, v.visitor_id AS visitorId,
  COALESCE(v.user_id, '') AS userId, COALESCE(v.user_name, '') AS userName,
  COALESCE((SELECT pv.visit_id FROM visits pv
    WHERE pv.site_pk = v.site_pk AND pv.session_id = v.session_id
      AND pv.started_at < v.started_at
    ORDER BY pv.started_at DESC, pv.visit_id DESC LIMIT 1), '') AS previousVisitId,
  (SELECT pv.started_at FROM visits pv
    WHERE pv.site_pk = v.site_pk AND pv.session_id = v.session_id
      AND pv.started_at < v.started_at
    ORDER BY pv.started_at DESC, pv.visit_id DESC LIMIT 1) AS previousVisitStartedAt,
  v.started_at AS startedAt, v.last_activity_at AS lastActivityAt,
  v.ended_at AS endedAt, v.finalized_at AS finalizedAt, v.duration_ms AS durationMs,
  COALESCE(v.duration_source, '') AS durationSource, COALESCE(v.exit_reason, '') AS exitReason,
  v.pathname, v.query_string AS queryString, v.hash_fragment AS hash, v.title,
  v.hostname, v.referrer_url AS referrerUrl, v.referrer_host AS referrerHost,
  v.utm_source AS utmSource, v.utm_medium AS utmMedium,
  v.utm_campaign AS utmCampaign, v.utm_term AS utmTerm, v.utm_content AS utmContent,
  v.is_eu AS isEU, v.country, v.region, v.region_code AS regionCode, v.city, v.continent,
  v.latitude, v.longitude, v.postal_code AS postalCode, v.metro_code AS metroCode,
  v.timezone, v.as_organization AS organization, v.browser,
  v.browser_version AS browserVersion, v.os, v.os_version AS osVersion,
  v.device_type AS deviceType, v.ua_raw AS userAgent, v.language,
  v.screen_width AS screenWidth, v.screen_height AS screenHeight, v.status,
  v.perf_ttfb_ms AS perfTtfbMs, v.perf_fcp_ms AS perfFcpMs,
  v.perf_lcp_ms AS perfLcpMs, v.perf_cls AS perfCls, v.perf_inp_ms AS perfInpMs
FROM visits v
WHERE v.site_pk = ? AND v.visit_id = ? AND v.started_at >= ? AND v.started_at < ?
LIMIT 1`;

beforeAll(() => {
  db = createMigratedDatabase();
  siteA = addSite(db, SITE_A);
  siteB = addSite(db, SITE_B);

  addVisit(db, siteA, {
    id: "previous-old",
    session: "detail-session",
    time: 80,
  });
  addVisit(db, siteA, {
    id: "previous-a",
    session: "detail-session",
    time: 90,
  });
  addVisit(db, siteA, {
    id: "previous-z",
    session: "detail-session",
    time: 90,
  });
  addVisit(db, siteA, {
    id: "same-time-later-id",
    session: "detail-session",
    time: 100,
  });
  addVisit(db, siteA, {
    id: "page-current",
    session: "detail-session",
    time: 100,
    pathname: "/current?source=test",
    userId: "user-1",
    userName: "Ada",
  });
  addVisit(db, siteA, { id: "page-no-previous", session: "alone", time: 120 });
  addVisit(db, siteA, {
    id: null,
    session: "nullable-previous",
    time: 130,
  });
  addVisit(db, siteA, {
    id: "page-null-previous-id",
    session: "nullable-previous",
    time: 150,
  });
  addVisit(db, siteA, { id: "blank-prev", session: "", time: 160 });
  addVisit(db, siteA, { id: "blank-current", session: "", time: 170 });
  addVisit(db, siteA, { id: "page-Case", session: "case", time: 180 });
  addVisit(db, siteA, { id: "page-case", session: "case", time: 181 });
  addVisit(db, siteA, { id: "page-end", session: "end", time: 200 });
  // Migration 0041 makes visit_id a global primary key, so the foreign-site
  // row uses its own id while retaining the same session and competing time.
  addVisit(db, siteB, {
    id: "foreign-site",
    session: "detail-session",
    time: 95,
  });

  addVisit(db, siteA, {
    id: "geo-z",
    session: "geo-session",
    time: 10,
    latitude: -90,
    longitude: 180,
    country: "US",
  });
  addVisit(db, siteA, {
    id: "geo-a",
    session: "geo-session",
    time: 10,
    latitude: 1,
    longitude: 2,
    country: "CA",
  });
  addVisit(db, siteA, {
    id: "geo-repeat",
    session: "geo-session",
    time: 10,
    latitude: 1,
    longitude: 2,
    country: "CA",
  });
  addVisit(db, siteA, {
    id: null,
    session: "geo-session",
    time: 9,
    latitude: 4,
    longitude: 5,
  });
  addVisit(db, siteA, {
    id: "geo-coercion",
    session: "geo-session",
    time: 11,
    latitude: "not-a-number",
    longitude: 5,
  });
  addVisit(db, siteA, {
    id: "geo-negative-time",
    session: "geo-session",
    time: -10,
    latitude: 0,
    longitude: -180,
  });
  addVisit(db, siteA, {
    id: "geo-future-time",
    session: "geo-session",
    time: 1_000_000_000,
    latitude: 90,
    longitude: 0,
  });
  addVisit(db, siteA, {
    id: "geo-zero",
    session: "geo-session",
    time: 12,
    latitude: 0,
    longitude: 0,
  });
  addVisit(db, siteA, {
    id: "geo-outside",
    session: "geo-session",
    time: 12,
    latitude: 91,
    longitude: 0,
  });
  addVisit(db, siteA, {
    id: "geo-null",
    session: "geo-session",
    time: 13,
    latitude: null,
    longitude: 0,
  });
  addVisit(db, siteB, {
    id: "geo-foreign",
    session: "geo-session",
    time: 1,
    latitude: 1,
    longitude: 1,
  });
  addVisit(db, siteA, {
    id: "geo-case-upper",
    session: "CaseSession",
    time: 1,
    latitude: 2,
    longitude: 3,
  });
  addVisit(db, siteA, {
    id: "geo-case-lower",
    session: "casesession",
    time: 2,
    latitude: 4,
    longitude: 5,
  });
  addVisit(db, siteA, {
    id: "geo-unicode",
    session: "会话🚀",
    time: 3,
    latitude: 6,
    longitude: 7,
  });
  addVisit(db, siteA, {
    id: "geo-empty",
    session: "",
    time: 4,
    latitude: 8,
    longitude: 9,
  });
  db.exec("ANALYZE");
});

afterAll(() => db.close());

describe("Journey Page report D1 lowering", () => {
  it("matches legacy Session location rows, order, and numeric coercion", async () => {
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
    });
    const env = instrumentEnv(sqliteEnv(db, trace), logger);
    const rows = await runWithInvocationLogger(logger, () =>
      runWithD1Operation("site_journeys.session_location_points", () =>
        querySessionLocationPointsFromD1(env, SITE_A, "geo-session"),
      ),
    );
    const record = await logger.emitWhenComplete();
    const observation = record.logs.find((entry) =>
      entry.message.startsWith("db.query.v1.all.success"),
    );
    const legacyRows = legacyLocationRows("geo-session");
    const typedRaw = await executeLogicalOutput(
      db,
      buildJourneySessionLocationPlan({
        siteId: SITE_A,
        sessionId: "geo-session",
      }),
      "journey-session-location-points",
    );
    expect(typedRaw).toEqual(legacyRows);
    expect(rows).toEqual(legacyRows.map(mapGeoPointRow));
    expect(rows.map((row) => row.timestampMs)).toEqual([
      -10, 9, 10, 10, 10, 11, 12, 1_000_000_000,
    ]);
    expect(Number.isNaN(rows[5]?.latitude)).toBe(true);
    expect(trace.preparedSql).toHaveLength(1);
    expect(trace.preparedSql[0]).not.toMatch(
      /custom_events|custom_event_names/u,
    );
    expect(
      new TextEncoder().encode(trace.preparedSql[0]!).byteLength,
    ).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
    expect(trace.bindings[0]!.length).toBeLessThanOrEqual(
      D1_MAX_BOUND_PARAMETERS,
    );
    expect(
      new TextEncoder().encode(LEGACY_LOCATION_SQL).byteLength,
    ).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
    expect(2).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
    expect(trace.preparedSql[0]).toContain("ABS(");
    expect(observation?.data).toMatchObject({
      tag: "site_journeys.session_location_points",
      operation: "all",
      status: "success",
      sqlBytes: new TextEncoder().encode(trace.preparedSql[0]!).byteLength,
      bindings: trace.bindings[0]!.length,
      physicalPlanHash: expect.stringMatching(/^v8:/u),
    });
    expect(
      record.performance.operations?.["site_journeys.session_location_points"],
    ).toMatchObject({ d1Statements: 1, d1RowsReadAvailable: false });
    const explain = explainQueryPlan(db, {
      sql: trace.preparedSql[0]!,
      bindings: trace.bindings[0]!,
    });
    expect(explain.join("\n")).toMatch(
      /idx_visits_site_pk_session_started_at/u,
    );
    for (const sessionId of ["CaseSession", "casesession", "会话🚀", ""]) {
      await expect(
        querySessionLocationPointsFromD1(sqliteEnv(db), SITE_A, sessionId),
      ).resolves.toHaveLength(1);
    }
    await expect(
      querySessionLocationPointsFromD1(
        sqliteEnv(db),
        "unknown-site",
        "geo-session",
      ),
    ).resolves.toEqual([]);
  });

  it("matches the complete legacy Pageview DTO and paired previous Page rule", async () => {
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
    });
    const env = instrumentEnv(sqliteEnv(db, trace), logger);
    const typed = await runWithInvocationLogger(logger, () =>
      runWithD1Operation("site_journeys.event_detail", () =>
        queryJourneyEventDetailFromD1(
          env,
          SITE_A,
          "page-current",
          WINDOW,
          "pageview",
        ),
      ),
    );
    const record = await logger.emitWhenComplete();
    const observation = record.logs.find((entry) =>
      entry.message.startsWith("db.query.v1.all.success"),
    );
    const oldRows = db
      .prepare(LEGACY_PAGEVIEW_SQL)
      .all(
        siteA.pk,
        "page-current",
        WINDOW.startMs,
        WINDOW.endExclusiveMs,
      ) as Record<string, unknown>[];
    const typedRaw = await executeLogicalOutput(
      db,
      buildJourneyPageviewDetailPlan({
        siteId: SITE_A,
        eventId: "page-current",
        window: WINDOW,
      }),
      "journey-pageview-detail",
    );
    expect(typedRaw).toEqual(oldRows);
    expect(oldRows[0]?.previousVisitId).toBe("previous-z");
    expect(oldRows[0]?.previousVisitStartedAt).toBe(90);
    expect(typed).toEqual(mapJourneyPageviewDetail(oldRows[0]!));
    expect(trace.preparedSql).toHaveLength(1);
    expect(trace.preparedSql[0]).not.toMatch(
      /custom_events|custom_event_names/u,
    );
    expect(
      new TextEncoder().encode(trace.preparedSql[0]!).byteLength,
    ).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
    expect(trace.bindings[0]!.length).toBeLessThanOrEqual(
      D1_MAX_BOUND_PARAMETERS,
    );
    expect(
      new TextEncoder().encode(LEGACY_PAGEVIEW_SQL).byteLength,
    ).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
    expect(4).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
    expect(observation?.data).toMatchObject({
      tag: "site_journeys.event_detail",
      operation: "all",
      status: "success",
      sqlBytes: new TextEncoder().encode(trace.preparedSql[0]!).byteLength,
      bindings: trace.bindings[0]!.length,
      physicalPlanHash: expect.stringMatching(/^v8:/u),
    });
    expect(
      record.performance.operations?.["site_journeys.event_detail"],
    ).toMatchObject({
      d1Statements: 1,
      d1RowsReadAvailable: false,
    });
    const explain = explainQueryPlan(db, {
      sql: trace.preparedSql[0]!,
      bindings: trace.bindings[0]!,
    });
    expect(explain.join("\n")).toContain(
      "idx_visits_site_pk_session_started_at",
    );
    expect(explain.join("\n")).toContain("sqlite_autoindex_visits_1");

    const implicitKindTrace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    await expect(
      queryJourneyEventDetailFromD1(
        sqliteEnv(db, implicitKindTrace),
        SITE_A,
        "page-current",
        WINDOW,
      ),
    ).resolves.toEqual(typed);
    expect(implicitKindTrace.preparedSql).toHaveLength(1);

    const noPrevious = await queryJourneyEventDetailFromD1(
      sqliteEnv(db),
      SITE_A,
      "page-no-previous",
      WINDOW,
      "pageview",
    );
    const noPreviousRaw = db
      .prepare(LEGACY_PAGEVIEW_SQL)
      .all(
        siteA.pk,
        "page-no-previous",
        WINDOW.startMs,
        WINDOW.endExclusiveMs,
      ) as Record<string, unknown>[];
    expect(noPrevious).toEqual(mapJourneyPageviewDetail(noPreviousRaw[0]!));
    expect(noPrevious?.context.previousVisitId).toBe("");
    expect(noPrevious?.context.previousVisitStartedAt).toBeNull();

    const nullIdPrevious = await queryJourneyEventDetailFromD1(
      sqliteEnv(db),
      SITE_A,
      "page-null-previous-id",
      WINDOW,
      "pageview",
    );
    expect(nullIdPrevious?.context.previousVisitId).toBe("");
    expect(nullIdPrevious?.context.previousVisitStartedAt).toBe(130);

    const rawPreviousPlan = rawPreviousPagePlan(
      SITE_A,
      "page-null-previous-id",
    );
    const rawPreviousOutput = rawPreviousPlan.outputs[0]!;
    const rawPreviousLowerer = new AnalyticsLogicalToDbLowerer(
      rawPreviousPlan,
      { siteId: SITE_A, time: rawPreviousPlan.context.time },
    );
    const rawPreviousRelation = rawPreviousLowerer.projectOutput(
      rawPreviousLowerer.lower(rawPreviousOutput),
      rawPreviousOutput.fields.map((field) => ({
        name: field.name,
        slot: field.slot,
      })),
    );
    const rawPreviousQuery = compileD1Query(
      lowerLogicalPlan(rawPreviousRelation),
    );
    const rawPreviousRows = await createD1DatabaseClient(
      createSqliteD1Database(db),
    ).all(rawPreviousQuery);
    expect(rawPreviousRows.results).toEqual([
      { previousVisitId: null, previousVisitStartedAt: 130 },
    ]);

    const blankSession = await queryJourneyEventDetailFromD1(
      sqliteEnv(db),
      SITE_A,
      "blank-current",
      WINDOW,
      "pageview",
    );
    expect(blankSession?.context.previousVisitId).toBe("blank-prev");

    for (const missingId of ["foreign-site", "page-end", "PAGE-Case"]) {
      await expect(
        queryJourneyEventDetailFromD1(
          sqliteEnv(db),
          SITE_A,
          missingId,
          WINDOW,
          "pageview",
        ),
      ).resolves.toBeNull();
    }

    const fallbackTrace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const fallback = await queryJourneyEventDetailFromD1(
      sqliteEnv(db, fallbackTrace),
      SITE_A,
      "session-start:detail-session",
      WINDOW,
    );
    expect(fallback?.event.eventId).toBe("session-start:detail-session");
    expect(fallbackTrace.preparedSql).toHaveLength(2);

    const explicitBoundaryTrace: SqliteD1Trace = {
      preparedSql: [],
      bindings: [],
    };
    const explicitBoundary = await queryJourneyEventDetailFromD1(
      sqliteEnv(db, explicitBoundaryTrace),
      SITE_A,
      "session-start:detail-session",
      WINDOW,
      "session_start",
    );
    expect(explicitBoundary?.event.eventId).toBe(
      "session-start:detail-session",
    );
    expect(explicitBoundaryTrace.preparedSql).toHaveLength(1);

    for (const missingBoundaryId of ["unknown:detail", "session-start:"]) {
      const missingBoundaryTrace: SqliteD1Trace = {
        preparedSql: [],
        bindings: [],
      };
      await expect(
        queryJourneyEventDetailFromD1(
          sqliteEnv(db, missingBoundaryTrace),
          SITE_A,
          missingBoundaryId,
          WINDOW,
        ),
      ).resolves.toBeNull();
      expect(missingBoundaryTrace.preparedSql).toHaveLength(1);
    }
  });

  it("keeps predecessor selection independent of current read bounds", () => {
    expect(() =>
      buildJourneyPageviewDetailPlan({
        siteId: SITE_A,
        eventId: "page-current",
        window: { ...WINDOW, startMs: Number.NaN },
      }),
    ).toThrow("journey_page_report_invalid_window");
    expect(() =>
      buildJourneyPageviewDetailPlan({
        siteId: SITE_A,
        eventId: "page-current",
        window: { ...WINDOW, startMs: WINDOW.endExclusiveMs },
      }),
    ).toThrow("journey_page_report_invalid_window");
    const plan = buildJourneyPageviewDetailPlan({
      siteId: SITE_A,
      eventId: "page-current",
      window: WINDOW,
    });
    const output = plan.outputs.find(
      (candidate) => candidate.id === "journey-pageview-detail",
    )!;
    const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
      siteId: SITE_A,
      time: plan.context.time,
    });
    const relation = lowerer.projectOutput(
      lowerer.lower(output),
      output.fields.map((field) => ({ name: field.name, slot: field.slot })),
    );
    const query = compileD1Query(lowerLogicalPlan(relation));
    expect(query.sql).toContain("started_at");
    expect(query.sql).toContain("DESC");
    expect(query.sql).not.toMatch(/custom_events|custom_event_names/u);
    expect(query.physicalPlanShape).toMatchObject({ version: 8 });
  });

  it("rejects mixing internal Page report and primitive field bindings", () => {
    const builder = createPageBuilder(SITE_A);
    const pages = builder.source("page", {
      attributes: ["page.report.country", "page.path"],
    });
    builder.output("mixed-page-source", pages, [
      { name: "page", slot: "entity" },
    ]);
    const plan = builder.finish();
    const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
      siteId: SITE_A,
      time: plan.context.time,
    });
    expect(() => lowerer.lower(plan.outputs[0]!)).toThrow(
      "Internal Page report attributes cannot be mixed with native primitive fields.",
    );
  });

  it("reuses the cached Page report carrier for independent matching sources", () => {
    const builder = createPageBuilder(SITE_A);
    const first = builder.source("page", {
      temporalDomain: "read",
      attributes: ["page.report.country"],
    });
    const second = builder.source("page", {
      temporalDomain: "read",
      attributes: ["page.report.country"],
    });
    for (const [id, relation] of [
      ["first-page-report", first],
      ["second-page-report", second],
    ] as const) {
      builder.output(id, relation, [
        { name: "page", slot: "entity" },
        { name: "country", slot: "attribute:page.report.country" },
      ]);
    }
    const plan = builder.finish();
    const storage = new AnalyticsRelationalStorage({
      siteId: SITE_A,
      time: plan.context.time,
    });
    const sources = plan.nodes.filter((node) => node.kind === "source");
    expect(sources).toHaveLength(2);
    expect(storage.lowerSource(sources[0]!, "sources[0]").relation).toBe(
      storage.lowerSource(sources[1]!, "sources[1]").relation,
    );
  });

  it("locates a missing output at the shared typed-query boundary", async () => {
    const plan = buildJourneyPageviewDetailPlan({
      siteId: SITE_A,
      eventId: "page-current",
      window: WINDOW,
    });
    await expect(
      queryJourneyPageReportRowsFromD1(
        sqliteEnv(db),
        plan,
        "not-a-page-report-output",
      ),
    ).rejects.toThrow(
      "journey_page_report_output_missing:not-a-page-report-output",
    );
  });
});
