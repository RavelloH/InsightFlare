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
import { buildEventRecordDetailPlan } from "@/lib/edge/analytics/engine/event-record-detail-plan";
import { LogicalPlanBuilder } from "@/lib/edge/analytics/engine/logical/builder";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import type { SemanticAttributeId } from "@/lib/edge/analytics/engine/semantic/attributes";
import { resolveAnalyticsScope } from "@/lib/edge/analytics/engine/semantic/entities";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { createSemanticTemporalDomains } from "@/lib/edge/analytics/engine/semantic/time";
import { AnalyticsLogicalToDbLowerer } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";
import { AnalyticsRelationalStorage } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-storage";
import { queryAnalyticsReportOutputRowsFromD1 } from "@/lib/edge/analytics/providers/d1/internal/analytics-report-query";
import { mapEventRecord } from "@/lib/edge/analytics/providers/d1/internal/core-mappers";
import { mapVisitPerformanceMetrics } from "@/lib/edge/analytics/providers/d1/internal/core-performance";
import { queryEventRecordDetailOutputRowsFromD1 } from "@/lib/edge/analytics/providers/d1/internal/event-record-detail-output";
import { queryEventRecordDetailFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-records";
import { instrumentEnv } from "@/lib/edge/observability/bindings";
import {
  createInvocationLogger,
  runWithD1Operation,
  runWithInvocationLogger,
} from "@/lib/edge/observability/logger";
import type { Env } from "@/lib/edge/types";

const SITE_A = "event-record-detail-a";
const SITE_B = "event-record-detail-b";
const WINDOW = {
  startMs: 120,
  endExclusiveMs: 130,
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
    readonly id: string;
    readonly session: string;
    readonly startedAt: number;
    readonly userId?: string | null;
    readonly userName?: string | null;
    readonly pathname?: string;
  },
): void {
  database
    .prepare(
      `INSERT INTO visits (
        visit_id, site_id, visitor_id, session_id, status, started_at,
        last_activity_at, pathname, hostname, user_id, user_name, site_pk
      ) VALUES (?, ?, 'visitor-a', ?, 'closed', ?, ?, ?, 'events.test', ?, ?, ?)`,
    )
    .run(
      input.id,
      site.id,
      input.session,
      input.startedAt,
      input.startedAt,
      input.pathname ?? `/${input.id}`,
      input.userId ?? null,
      input.userName ?? null,
      site.pk,
    );
}

function addName(database: DatabaseSync, site: Site, id: number, name: string) {
  database
    .prepare(
      `INSERT INTO custom_event_names (id, site_id, name, last_seen_at, site_pk)
       VALUES (?, ?, ?, 1, ?)`,
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
    readonly occurredAt: number | string;
    readonly userId?: string | null;
  },
): void {
  database
    .prepare(
      `INSERT INTO custom_events (
        event_id, site_id, visit_id, event_name_id, occurred_at, received_at,
        sequence, node_count, value_count, user_id, site_pk
      ) VALUES (?, ?, ?, ?, ?, 777, 3, 4, 5, ?, ?)`,
    )
    .run(
      input.id,
      site.id,
      input.visitId,
      input.nameId,
      input.occurredAt,
      input.userId ?? null,
      site.pk,
    );
}

function sqliteEnv(database: DatabaseSync, trace?: SqliteD1Trace): Env {
  return { DB: createSqliteD1Database(database, trace) } as unknown as Env;
}

const LEGACY_EVENT_DETAIL_SQL = `
SELECT
  ce.event_id AS eventId, cen.name AS eventName,
  ce.occurred_at AS occurredAt, ce.received_at AS receivedAt,
  ce.sequence, ce.visit_id AS visitId, v.session_id AS sessionId,
  v.visitor_id AS visitorId,
  COALESCE(ce.user_id, v.user_id, '') AS userId,
  COALESCE(v.user_name, '') AS userName, v.status,
  v.started_at AS startedAt,
  COALESCE((SELECT pv.visit_id FROM visits pv
    WHERE pv.site_pk = v.site_pk AND pv.session_id = v.session_id
      AND pv.started_at < v.started_at
    ORDER BY pv.started_at DESC, pv.visit_id DESC LIMIT 1), '') AS previousVisitId,
  (SELECT pv.started_at FROM visits pv
    WHERE pv.site_pk = v.site_pk AND pv.session_id = v.session_id
      AND pv.started_at < v.started_at
    ORDER BY pv.started_at DESC, pv.visit_id DESC LIMIT 1) AS previousVisitStartedAt,
  v.last_activity_at AS lastActivityAt, v.ended_at AS endedAt,
  v.finalized_at AS finalizedAt, v.duration_ms AS durationMs,
  COALESCE(v.duration_source, '') AS durationSource,
  COALESCE(v.exit_reason, '') AS exitReason,
  v.pathname, v.query_string AS queryString,
  v.hash_fragment AS hash, v.title, v.hostname,
  v.referrer_url AS referrerUrl, v.referrer_host AS referrerHost,
  v.utm_source AS utmSource, v.utm_medium AS utmMedium,
  v.utm_campaign AS utmCampaign, v.utm_term AS utmTerm,
  v.utm_content AS utmContent, v.is_eu AS isEU, v.country, v.region,
  v.region_code AS regionCode, v.city, v.continent, v.latitude, v.longitude,
  v.postal_code AS postalCode, v.metro_code AS metroCode, v.timezone,
  v.as_organization AS organization, v.browser,
  v.browser_version AS browserVersion, v.os, v.os_version AS osVersion,
  v.device_type AS deviceType, v.ua_raw AS userAgent, v.language,
  v.screen_width AS screenWidth, v.screen_height AS screenHeight,
  v.perf_ttfb_ms AS perfTtfbMs, v.perf_fcp_ms AS perfFcpMs,
  v.perf_lcp_ms AS perfLcpMs, v.perf_cls AS perfCls, v.perf_inp_ms AS perfInpMs,
  ce.node_count AS nodeCount, ce.value_count AS valueCount
FROM custom_events ce
INNER JOIN custom_event_names cen ON cen.id = ce.event_name_id
INNER JOIN visits v ON v.site_pk = ce.site_pk AND v.visit_id = ce.visit_id
WHERE ce.site_pk = ? AND ce.event_id = ?
  AND ce.occurred_at >= ? AND ce.occurred_at < ?
LIMIT 1`;

function legacyDetailRow(
  eventId: string,
  window?: { readonly startMs: number; readonly endExclusiveMs: number },
): Record<string, unknown> | undefined {
  const sql = window
    ? LEGACY_EVENT_DETAIL_SQL
    : LEGACY_EVENT_DETAIL_SQL.replace(
        /\s+AND ce\.occurred_at >= \? AND ce\.occurred_at < \?/u,
        "",
      );
  const bindings = window
    ? [siteA.pk, eventId, window.startMs, window.endExclusiveMs]
    : [siteA.pk, eventId];
  return db.prepare(sql).get(...bindings) as
    Record<string, unknown> | undefined;
}

async function executeOutput(
  database: DatabaseSync,
  plan: ValidatedLogicalPlan,
  outputId: string,
): Promise<Record<string, unknown>[]> {
  const output = plan.outputs.find((candidate) => candidate.id === outputId);
  if (!output) throw new Error(`test_output_missing:${outputId}`);
  const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
    siteId: plan.context.subject.siteIds[0]!,
    time: plan.context.time,
  });
  const lowered = lowerer.lower(output);
  const relation = lowerer.projectOutput(
    lowered,
    output.fields.map((field) => ({ name: field.name, slot: field.slot })),
  );
  const query = compileD1Query(lowerLogicalPlan(relation), {
    tag: "test.event-record-detail",
  });
  const result = await createD1DatabaseClient(
    createSqliteD1Database(database),
  ).all(query);
  return result.results.map((row) => Object.fromEntries(Object.entries(row)));
}

function sourceProbePlan(
  siteIds: string | readonly string[],
  attributes: readonly SemanticAttributeId[],
): ValidatedLogicalPlan {
  const range = {
    startMs: 0 as EpochMs,
    endExclusiveMs: 10 as EpochMs,
  };
  const builder = new LogicalPlanBuilder({
    subject: createSemanticSubjectDomain({
      origin: "site",
      siteIds: (typeof siteIds === "string" ? [siteIds] : siteIds).map(
        (siteId) => siteId as SiteId,
      ),
    }),
    time: createSemanticTemporalDomains({
      candidate: range,
      read: { kind: "retained-history" },
      reportingTimeZone: "UTC" as ReportingTimeZone,
      capturedAtMs: 10 as EpochMs,
    }),
    scope: resolveAnalyticsScope("auto"),
  });
  const event = builder.source("event", {
    temporalDomain: "read",
    relationships: ["event.observation"],
    attributes,
  });
  builder.output(
    "event-source-probe",
    event,
    attributes.map((attributeId) => ({
      name: attributeId,
      slot: `attribute:${attributeId}`,
    })),
  );
  return builder.finish();
}

function compileProbeSql(plan: ValidatedLogicalPlan): string {
  const output = plan.outputs[0]!;
  const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
    siteId: SITE_A,
    time: plan.context.time,
  });
  const lowered = lowerer.lower(output);
  return compileD1Query(
    lowerLogicalPlan(
      lowerer.projectOutput(
        lowered,
        output.fields.map((field) => ({ name: field.name, slot: field.slot })),
      ),
    ),
    { tag: "test.event-source-probe" },
  ).sql;
}

beforeAll(() => {
  db = createMigratedDatabase();
  db.exec("PRAGMA foreign_keys = OFF");
  siteA = addSite(db, SITE_A);
  siteB = addSite(db, SITE_B);
  addName(db, siteA, 11, "Event Name");
  addName(db, siteB, 12, "Foreign Dictionary Name");
  addVisit(db, siteA, { id: "before-old", session: "shared", startedAt: 70 });
  addVisit(db, siteA, { id: "before-a", session: "shared", startedAt: 90 });
  addVisit(db, siteA, { id: "before-z", session: "shared", startedAt: 90 });
  addVisit(db, siteA, {
    id: "owner-current",
    session: "shared",
    startedAt: 100,
    userId: "owner-user",
    userName: "Owner Name",
    pathname: "/owner?from=test",
  });
  addVisit(db, siteA, {
    id: "same-time-later",
    session: "shared",
    startedAt: 100,
  });
  addVisit(db, siteA, {
    id: "after-current",
    session: "shared",
    startedAt: 110,
  });
  addVisit(db, siteB, {
    id: "foreign-owner",
    session: "shared",
    startedAt: 95,
  });
  addEvent(db, siteA, {
    id: "event-main",
    visitId: "owner-current",
    nameId: 12,
    occurredAt: 125,
    userId: "",
  });
  addEvent(db, siteA, {
    id: "event-owner-user-fallback",
    visitId: "owner-current",
    nameId: 11,
    occurredAt: 126,
  });
  addEvent(db, siteA, {
    id: "event-at-start",
    visitId: "owner-current",
    nameId: 11,
    occurredAt: 120,
  });
  addEvent(db, siteA, {
    id: "event-at-end",
    visitId: "owner-current",
    nameId: 11,
    occurredAt: 130,
  });
  addEvent(db, siteA, {
    id: "event-retained",
    visitId: "owner-current",
    nameId: 11,
    occurredAt: 80,
  });
  addEvent(db, siteA, {
    id: "event-missing-name",
    visitId: "owner-current",
    nameId: 99_999,
    occurredAt: 125,
  });
  addEvent(db, siteA, {
    id: "event-orphan-owner",
    visitId: "does-not-exist",
    nameId: 11,
    occurredAt: 125,
  });
  addEvent(db, siteA, {
    id: "event-cross-site-owner",
    visitId: "foreign-owner",
    nameId: 11,
    occurredAt: 125,
  });
  addEvent(db, siteA, {
    id: "event-odd-affinity",
    visitId: "owner-current",
    nameId: 11,
    occurredAt: "raw-clock",
  });
  addEvent(db, siteA, {
    id: "会话🚀",
    visitId: "owner-current",
    nameId: 11,
    occurredAt: 127,
  });
});

afterAll(() => db.close());

describe("Event record detail report D1 lowering", () => {
  it("matches the complete legacy row and DTO while retaining JSON payload reads", async () => {
    const plan = buildEventRecordDetailPlan({
      siteId: SITE_A,
      eventId: "event-main",
      window: WINDOW,
    });
    const expectedRow = legacyDetailRow("event-main", WINDOW)!;
    const typedRaw = await executeOutput(db, plan, "event-record-detail");
    expect(typedRaw).toEqual([expectedRow]);

    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
    });
    const env = instrumentEnv(sqliteEnv(db, trace), logger);
    const result = await runWithInvocationLogger(logger, () =>
      runWithD1Operation("site_events.record_detail", () =>
        queryEventRecordDetailFromD1(env, SITE_A, "event-main", WINDOW),
      ),
    );
    const logs = await logger.emitWhenComplete();
    const queryLogs = logs.logs
      .filter(
        (entry) =>
          entry.message.startsWith("db.query.v1.") &&
          entry.message.endsWith(".success"),
      )
      .map((entry) => entry.data);
    const row = expectedRow as Parameters<typeof mapEventRecord>[0] &
      Record<string, unknown>;
    expect(result).toEqual({
      event: { ...mapEventRecord(row), eventKind: "custom_event" },
      context: {
        visitId: row.visitId,
        sessionId: row.sessionId,
        visitorId: row.visitorId,
        userId: row.userId,
        userName: row.userName,
        pathname: row.pathname,
        queryString: row.queryString,
        hash: row.hash,
        title: row.title,
        hostname: row.hostname,
        referrerUrl: row.referrerUrl,
        referrerHost: row.referrerHost,
        utmSource: row.utmSource,
        utmMedium: row.utmMedium,
        utmCampaign: row.utmCampaign,
        utmTerm: row.utmTerm,
        utmContent: row.utmContent,
        isEU: row.isEU === true || row.isEU === 1 || row.isEU === "1",
        country: row.country,
        region: row.region,
        regionCode: row.regionCode,
        city: row.city,
        continent: row.continent,
        latitude: row.latitude,
        longitude: row.longitude,
        postalCode: row.postalCode,
        metroCode: row.metroCode,
        timezone: row.timezone,
        organization: row.organization,
        browser: row.browser,
        browserVersion: row.browserVersion,
        os: row.os,
        osVersion: row.osVersion,
        deviceType: row.deviceType,
        userAgent: row.userAgent,
        language: row.language,
        screenWidth: row.screenWidth,
        screenHeight: row.screenHeight,
        status: row.status,
        startedAt: row.startedAt,
        previousVisitId: row.previousVisitId,
        previousVisitStartedAt: row.previousVisitStartedAt,
        lastActivityAt: row.lastActivityAt,
        endedAt: row.endedAt,
        finalizedAt: row.finalizedAt,
        durationMs: row.durationMs,
        durationSource: row.durationSource,
        exitReason: row.exitReason,
        performance: mapVisitPerformanceMetrics(expectedRow),
      },
      eventData: {},
    });
    expect(result?.context.previousVisitId).toBe("before-z");
    expect(result?.context.userId).toBe("");
    expect(trace.preparedSql).toHaveLength(3);
    expect(queryLogs.map((entry) => entry?.tag)).toEqual([
      "site_events.record_detail",
      "analytics.custom_events.first",
      "analytics.custom_event_json_nodes.all",
    ]);
    expect(trace.bindings[0]).toHaveLength(12);
    expect(trace.bindings[0]).toEqual(
      expect.arrayContaining([SITE_A, "event-main", 120, 130]),
    );
    expect(
      new TextEncoder().encode(trace.preparedSql[0]!).byteLength,
    ).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
    expect(trace.bindings[0]!.length).toBeLessThanOrEqual(
      D1_MAX_BOUND_PARAMETERS,
    );
    const mainQueryLog = logs.logs.find(
      (entry) =>
        entry.message === "db.query.v1.all.success" &&
        entry.data?.tag === "site_events.record_detail",
    );
    expect(mainQueryLog?.data).toMatchObject({
      operation: "all",
      status: "success",
      sqlBytes: 29_021,
      bindings: 12,
      physicalPlanHash:
        "v1:37640936520cc10d692d05082587090ddf32859487c9536d7be1f1e9aa4791bf",
    });
    expect(
      new TextEncoder().encode(LEGACY_EVENT_DETAIL_SQL).byteLength,
    ).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
    expect(4).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
    const explain = explainQueryPlan(db, {
      sql: trace.preparedSql[0]!,
      bindings: trace.bindings[0]!,
    });
    const explainText = explain.join("\n");
    expect(explainText).toContain(
      "SEARCH t0 USING INDEX sqlite_autoindex_custom_events_1 (event_id=?)",
    );
    expect(explainText).toContain(
      "SEARCH t3 USING INDEX sqlite_autoindex_visits_1 (visit_id=?) LEFT-JOIN",
    );
    expect(
      explain.filter((entry) =>
        entry.includes("idx_visits_site_pk_session_started_at"),
      ),
    ).toHaveLength(2);
    expect(explainText).toContain("USE TEMP B-TREE FOR LAST TERM OF ORDER BY");
    expect(explain.length).toBeGreaterThan(0);
    expect(trace.preparedSql[0]).toContain("LEFT JOIN");
    expect(trace.preparedSql[0]).toContain("custom_event_names");
    expect(trace.preparedSql[0]).toContain("visits");
  });

  it("uses half-open event-time bounds and leaves owner/previous pages unbounded", async () => {
    await expect(
      queryEventRecordDetailFromD1(
        sqliteEnv(db),
        SITE_A,
        "event-at-start",
        WINDOW,
      ),
    ).resolves.toMatchObject({ event: { eventId: "event-at-start" } });
    await expect(
      queryEventRecordDetailFromD1(
        sqliteEnv(db),
        SITE_A,
        "event-at-end",
        WINDOW,
      ),
    ).resolves.toBeNull();
    await expect(
      queryEventRecordDetailFromD1(sqliteEnv(db), SITE_A, "event-retained"),
    ).resolves.toMatchObject({
      event: { eventId: "event-retained", occurredAt: 80 },
      context: { startedAt: 100, previousVisitId: "before-z" },
    });
    const odd = await queryEventRecordDetailFromD1(
      sqliteEnv(db),
      SITE_A,
      "event-odd-affinity",
    );
    expect(odd?.event.occurredAt).toBe("raw-clock");
    expect(legacyDetailRow("event-odd-affinity")?.occurredAt).toBe("raw-clock");
    await expect(
      queryEventRecordDetailFromD1(sqliteEnv(db), SITE_A, "会话🚀"),
    ).resolves.toMatchObject({ event: { eventId: "会话🚀" } });
    await expect(
      queryEventRecordDetailFromD1(sqliteEnv(db), SITE_A, "会话🚀 "),
    ).resolves.toBeNull();
  });

  it("preserves legacy name and same-site owner presence semantics", async () => {
    for (const eventId of [
      "event-missing-name",
      "event-orphan-owner",
      "event-cross-site-owner",
    ]) {
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      await expect(
        queryEventRecordDetailFromD1(sqliteEnv(db, trace), SITE_A, eventId),
      ).resolves.toBeNull();
      expect(trace.preparedSql).toHaveLength(1);
      expect(legacyDetailRow(eventId)).toBeUndefined();
    }
    await expect(
      queryEventRecordDetailFromD1(
        sqliteEnv(db),
        SITE_A,
        "event-owner-user-fallback",
      ),
    ).resolves.toMatchObject({ context: { userId: "owner-user" } });
  });

  it("joins only report relationships required by the source demand", () => {
    const localId = compileProbeSql(
      sourceProbePlan(SITE_A, ["event.report.localId"]),
    );
    const eventName = compileProbeSql(
      sourceProbePlan(SITE_A, ["event.report.eventName"]),
    );
    const owner = compileProbeSql(
      sourceProbePlan(SITE_A, ["event.report.ownerStatus"]),
    );
    const previous = compileProbeSql(
      sourceProbePlan(SITE_A, ["event.report.ownerPreviousVisitId"]),
    );
    expect(localId).not.toContain("custom_event_names");
    expect(localId).not.toContain("visits");
    expect(eventName).toContain("LEFT JOIN");
    expect(eventName).toContain("custom_event_names");
    expect(eventName).not.toContain("visits");
    expect(owner).toContain("LEFT JOIN");
    expect(owner).toContain("visits");
    expect(owner).not.toContain("custom_event_names");
    expect(previous).toContain("ORDER BY");
    expect(previous.match(/DESC/gu)).toHaveLength(2);
  });

  it("reuses identical report demand without sharing different demand shapes", () => {
    const localPlan = sourceProbePlan(SITE_A, ["event.report.localId"]);
    const namePlan = sourceProbePlan(SITE_A, ["event.report.eventName"]);
    const localSource = localPlan.nodes.find((node) => node.kind === "source");
    const nameSource = namePlan.nodes.find((node) => node.kind === "source");
    if (!localSource || localSource.kind !== "source")
      throw new Error("event_source_missing");
    if (!nameSource || nameSource.kind !== "source")
      throw new Error("event_name_source_missing");
    const storage = new AnalyticsRelationalStorage({
      siteId: SITE_A,
      time: localPlan.context.time,
    });
    const localSlots = new Set(localSource.output);
    const firstLocal = storage.lowerSource(
      localSource,
      "test.event.local",
      localSlots,
    );
    const repeatedLocal = storage.lowerSource(
      localSource,
      "test.event.local",
      localSlots,
    );
    const eventName = storage.lowerSource(
      nameSource,
      "test.event.name",
      new Set(nameSource.output),
    );
    expect(firstLocal.relation).toBe(repeatedLocal.relation);
    expect(firstLocal.relation).not.toBe(eventName.relation);
  });

  it("executes report outputs across the authorized multi-site subject", async () => {
    const plan = sourceProbePlan(SITE_A, ["event.report.localId"]);
    const multiSitePlan = {
      ...plan,
      context: {
        ...plan.context,
        subject: {
          ...plan.context.subject,
          siteIds: [SITE_A as SiteId, SITE_B as SiteId],
        },
      },
    } as ValidatedLogicalPlan;
    const rows = await queryAnalyticsReportOutputRowsFromD1(
      sqliteEnv(db),
      multiSitePlan,
      "event-source-probe",
    );
    const expected = db
      .prepare(
        "SELECT event_id AS eventId FROM custom_events WHERE site_pk IN (?, ?) ORDER BY event_id",
      )
      .all(siteA.pk, siteB.pk) as { readonly eventId: string }[];
    expect(
      rows.map((row) => row["event.report.localId"] as string).sort(),
    ).toEqual(expected.map((row) => row.eventId).sort());
  });

  it("rejects malformed detail output contracts before database execution", async () => {
    const plan = buildEventRecordDetailPlan({
      siteId: SITE_A,
      eventId: "event-main",
      window: WINDOW,
    });
    const output = plan.outputs.find(
      (candidate) => candidate.id === "event-record-detail",
    );
    if (!output) throw new Error("event_record_detail_output_missing");

    const missingAliasPlan = {
      ...plan,
      outputs: plan.outputs.map((candidate) =>
        candidate.id === output.id
          ? {
              ...candidate,
              fields: candidate.fields.filter(
                (field) => field.name !== "eventName",
              ),
            }
          : candidate,
      ),
    } as ValidatedLogicalPlan;
    const duplicateAliasPlan = {
      ...plan,
      outputs: plan.outputs.map((candidate) =>
        candidate.id === output.id
          ? {
              ...candidate,
              fields: [...candidate.fields, candidate.fields[0]!],
            }
          : candidate,
      ),
    } as ValidatedLogicalPlan;
    const occurredAtSlot = output.fields.find(
      (field) => field.name === "occurredAt",
    )!.slot;
    const wrongScalarPlan = {
      ...plan,
      slots: plan.slots.map((slot) =>
        slot.id === occurredAtSlot
          ? { ...slot, type: { kind: "scalar", scalar: "string" } }
          : slot,
      ),
    } as ValidatedLogicalPlan;
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const env = sqliteEnv(db, trace);

    await expect(
      queryEventRecordDetailOutputRowsFromD1(env, missingAliasPlan),
    ).rejects.toThrow(
      "event_record_detail_output_contract:missing_alias:eventName",
    );
    await expect(
      queryEventRecordDetailOutputRowsFromD1(env, duplicateAliasPlan),
    ).rejects.toThrow(
      "event_record_detail_output_contract:duplicate_alias:eventId",
    );
    await expect(
      queryEventRecordDetailOutputRowsFromD1(env, wrongScalarPlan),
    ).rejects.toThrow(
      "event_record_detail_output_contract:value_type:occurredAt:expected=datetime",
    );
    expect(trace.preparedSql).toHaveLength(0);
  });
});
