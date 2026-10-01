import type { DatabaseSync, SQLInputValue } from "node:sqlite";

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
import { buildJourneyObservationPlan } from "@/lib/edge/analytics/engine/journey-observation-plan";
import { LogicalPlanBuilder } from "@/lib/edge/analytics/engine/logical/builder";
import { AnalyticsLogicalToDbLowerer } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";
import { AnalyticsRelationalStorage } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-storage";
import type { QueryWindow } from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  buildDetailCustomEventSourceCte,
  buildTargetVisitSourceCte,
  detailCustomEventSourceBindings,
  targetVisitSourceBindings,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  queryJourneyEventsForDetailFromD1,
  querySessionDetailFromD1,
  queryVisitorDetailFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/journey-detail-queries";
import { mapJourneyEventRow } from "@/lib/edge/analytics/providers/d1/internal/journey-helpers";
import { instrumentEnv } from "@/lib/edge/observability/bindings";
import {
  createInvocationLogger,
  runWithD1Operation,
  runWithInvocationLogger,
} from "@/lib/edge/observability/logger";
import type { Env } from "@/lib/edge/types";

const SITE_A = "journey-observation-a";
const SITE_B = "journey-observation-b";
const TARGET_VISITOR = "CaseVisitor";
const TARGET_SESSION = "CaseSession";
const WINDOW: QueryWindow = {
  startMs: 100,
  endExclusiveMs: 200,
  nowMs: 500,
  timeZone: "UTC",
};

interface FixtureSite {
  readonly siteId: string;
  readonly sitePk: number;
  readonly purchaseNameId: number;
}

let db: DatabaseSync;
let siteA: FixtureSite;
let siteB: FixtureSite;

function insertSite(database: DatabaseSync, siteId: string): FixtureSite {
  database
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .run(siteId);
  const row = database
    .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
    .get(siteId) as { readonly site_pk: number };
  database
    .prepare(
      "INSERT INTO custom_event_names (site_id, name, last_seen_at, site_pk) VALUES (?, ?, ?, ?)",
    )
    .run(siteId, "purchase", 1, row.site_pk);
  const name = database
    .prepare("SELECT id FROM custom_event_names WHERE site_pk = ?")
    .get(row.site_pk) as { readonly id: number };
  return {
    siteId,
    sitePk: Number(row.site_pk),
    purchaseNameId: Number(name.id),
  };
}

function insertVisit(
  database: DatabaseSync,
  site: FixtureSite,
  input: {
    readonly visitId: string;
    readonly visitorId: string;
    readonly sessionId: string;
    readonly startedAt: number;
    readonly pathname?: string;
    readonly durationMs?: number | null;
    readonly userId?: string | null;
    readonly userName?: string | null;
  },
): void {
  database
    .prepare(
      `INSERT INTO visits
        (visit_id, site_id, site_pk, visitor_id, session_id, status,
         started_at, last_activity_at, ended_at, duration_ms,
         pathname, hash_fragment, hostname, title, referrer_host, referrer_url,
         country, region, region_code, city, latitude, longitude,
         browser, browser_version, os, os_version, device_type,
         screen_width, screen_height, user_id, user_name,
         perf_ttfb_ms, perf_fcp_ms, perf_lcp_ms, perf_cls, perf_inp_ms)
       VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.visitId,
      site.siteId,
      site.sitePk,
      input.visitorId,
      input.sessionId,
      input.startedAt,
      input.startedAt,
      input.durationMs ?? null,
      input.pathname ?? `/${input.visitId}`,
      `#${input.visitId}`,
      "journey.test",
      `Title ${input.visitId}`,
      "referrer.test",
      `https://referrer.test/${input.visitId}`,
      "US",
      "California",
      "CA",
      "San Francisco",
      null,
      null,
      "Firefox",
      "130",
      "Linux",
      "6",
      "desktop",
      null,
      null,
      input.userId ?? null,
      input.userName ?? null,
      null,
      null,
      null,
      null,
      null,
    );
}

function insertEvent(
  database: DatabaseSync,
  input: {
    readonly eventId: string;
    readonly site: FixtureSite;
    readonly visitId: string;
    readonly eventNameId: number;
    readonly occurredAt: number;
  },
): void {
  database
    .prepare(
      `INSERT INTO custom_events
        (event_id, site_id, visit_id, event_name_id, occurred_at,
         received_at, node_count, value_count, site_pk)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)`,
    )
    .run(
      input.eventId,
      input.site.siteId,
      input.visitId,
      input.eventNameId,
      input.occurredAt,
      input.occurredAt,
      input.site.sitePk,
    );
}

function seed(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = OFF");
  siteA = insertSite(database, SITE_A);
  siteB = insertSite(database, SITE_B);
  insertSite(database, "journey-observation-unknown-name");
  const foreignNameId = Number(
    database
      .prepare("SELECT id FROM custom_event_names WHERE site_id = ?")
      .get("journey-observation-unknown-name")?.id,
  );

  insertVisit(database, siteA, {
    visitId: "owner-in-window",
    visitorId: TARGET_VISITOR,
    sessionId: TARGET_SESSION,
    startedAt: 100,
    pathname: "/inside",
    durationMs: null,
    userId: "user-7",
    userName: "Ada",
  });
  insertVisit(database, siteA, {
    visitId: "owner-outside-window",
    visitorId: TARGET_VISITOR,
    sessionId: TARGET_SESSION,
    startedAt: 50,
  });
  insertVisit(database, siteA, {
    visitId: "owner-window-end",
    visitorId: TARGET_VISITOR,
    sessionId: TARGET_SESSION,
    startedAt: 200,
  });
  insertVisit(database, siteA, {
    visitId: "owner-future",
    visitorId: TARGET_VISITOR,
    sessionId: TARGET_SESSION,
    startedAt: 900_000,
  });
  insertVisit(database, siteB, {
    visitId: "site-b-owner",
    visitorId: TARGET_VISITOR,
    sessionId: TARGET_SESSION,
    startedAt: 110,
  });
  insertVisit(database, siteA, {
    visitId: "unicode-owner",
    visitorId: "访客🌍",
    sessionId: "会话🚀",
    startedAt: -5_000,
  });
  insertVisit(database, siteA, {
    visitId: "empty-owner",
    visitorId: "",
    sessionId: "",
    startedAt: 0,
  });

  insertEvent(database, {
    eventId: "event-before-owner-time",
    site: siteA,
    visitId: "owner-in-window",
    eventNameId: siteA.purchaseNameId,
    occurredAt: -50_000,
  });
  insertEvent(database, {
    eventId: "event-after-owner-time",
    site: siteA,
    visitId: "owner-in-window",
    eventNameId: siteA.purchaseNameId,
    occurredAt: 800_000,
  });
  insertEvent(database, {
    eventId: "event-foreign-dictionary-site",
    site: siteA,
    visitId: "owner-in-window",
    eventNameId: foreignNameId,
    occurredAt: 150,
  });
  insertEvent(database, {
    eventId: "event-missing-dictionary",
    site: siteA,
    visitId: "owner-in-window",
    eventNameId: 9_999_999,
    occurredAt: 175,
  });
  insertEvent(database, {
    eventId: "event-owner-outside-window",
    site: siteA,
    visitId: "owner-outside-window",
    eventNameId: siteA.purchaseNameId,
    occurredAt: 150,
  });
  insertEvent(database, {
    eventId: "event-owner-at-window-end",
    site: siteA,
    visitId: "owner-window-end",
    eventNameId: siteA.purchaseNameId,
    occurredAt: 150,
  });
  insertEvent(database, {
    eventId: "event-orphan-owner",
    site: siteA,
    visitId: "no-owner",
    eventNameId: siteA.purchaseNameId,
    occurredAt: 100,
  });
  insertEvent(database, {
    eventId: "event-cross-site-owner",
    site: siteA,
    visitId: "site-b-owner",
    eventNameId: siteA.purchaseNameId,
    occurredAt: 120,
  });
  insertEvent(database, {
    eventId: "event-unicode-owner",
    site: siteA,
    visitId: "unicode-owner",
    eventNameId: siteA.purchaseNameId,
    occurredAt: -8_000,
  });
  insertEvent(database, {
    eventId: "event-empty-owner",
    site: siteA,
    visitId: "empty-owner",
    eventNameId: siteA.purchaseNameId,
    occurredAt: 1_000_000,
  });
  insertEvent(database, {
    eventId: "event-site-b",
    site: siteB,
    visitId: "site-b-owner",
    eventNameId: siteB.purchaseNameId,
    occurredAt: 300,
  });
}

function seedPlanNoise(database: DatabaseSync): void {
  for (let index = 0; index < 256; index += 1) {
    const visitId = `noise-${index}`;
    insertVisit(database, siteA, {
      visitId,
      visitorId: `noise-visitor-${index}`,
      sessionId: `noise-session-${index}`,
      startedAt: index,
    });
    insertEvent(database, {
      eventId: `noise-event-${index}`,
      site: siteA,
      visitId,
      eventNameId: siteA.purchaseNameId,
      occurredAt: index,
    });
  }
  database.exec("ANALYZE");
}

function testEnv(database: DatabaseSync, trace?: SqliteD1Trace): Env {
  return {
    DB: createSqliteD1Database(database, trace),
  } as unknown as Env;
}

function compileTypedObservationQuery(
  siteId: string,
  target: { readonly type: "visitor" | "session"; readonly value: string },
  shape: "timeline" | "detail-source",
  window?: QueryWindow,
) {
  const plan = buildJourneyObservationPlan({
    siteId,
    target,
    shape,
    ...(window ? { window } : {}),
  });
  const output = plan.outputs[0]!;
  const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
    siteId,
    time: plan.context.time,
  });
  const lowered = lowerer.lower(output);
  const relation = lowerer.projectOutput(
    lowered,
    output.fields.map((field) => ({ name: field.name, slot: field.slot })),
  );
  return compileD1Query(lowerLogicalPlan(relation));
}

function legacyTimelineQuery(
  siteId: string,
  target: { readonly type: "visitor" | "session"; readonly value: string },
): { readonly sql: string; readonly bindings: readonly (string | number)[] } {
  const targetColumn = target.type === "visitor" ? "visitor_id" : "session_id";
  const sql = `
WITH
${buildTargetVisitSourceCte(targetColumn)},
filtered_visits AS (
  SELECT * FROM visit_source
),
${buildDetailCustomEventSourceCte()},
page_events AS (
  SELECT
    visit_id AS id, 'pageview' AS kind, 'pageview' AS eventType,
    started_at AS occurredAt, visit_id AS visitId, session_id AS sessionId,
    visitor_id AS visitorId, pathname, hash_fragment AS hash, title, hostname,
    referrer_host AS referrerHost, referrer_url AS referrerUrl, country, region,
    city, browser, browser_version AS browserVersion, os,
    os_version AS osVersion, device_type AS deviceType,
    screen_width AS screenWidth, screen_height AS screenHeight,
    COALESCE(duration_ms, 0) AS durationMs, perf_ttfb_ms AS perfTtfbMs,
    perf_fcp_ms AS perfFcpMs, perf_lcp_ms AS perfLcpMs,
    perf_cls AS perfCls, perf_inp_ms AS perfInpMs
  FROM filtered_visits
),
custom_event_rows AS (
  SELECT
    event_id AS id, 'custom' AS kind, event_name AS eventType,
    occurred_at AS occurredAt, visit_id AS visitId, session_id AS sessionId,
    visitor_id AS visitorId, pathname, hash_fragment AS hash, title, hostname,
    referrer_host AS referrerHost, referrer_url AS referrerUrl, country, region,
    city, browser, browser_version AS browserVersion, os,
    os_version AS osVersion, device_type AS deviceType,
    screen_width AS screenWidth, screen_height AS screenHeight,
    0 AS durationMs, perf_ttfb_ms AS perfTtfbMs, perf_fcp_ms AS perfFcpMs,
    perf_lcp_ms AS perfLcpMs, perf_cls AS perfCls, perf_inp_ms AS perfInpMs
  FROM event_source
)
SELECT * FROM (
  SELECT * FROM page_events
  UNION ALL
  SELECT * FROM custom_event_rows
)
ORDER BY occurredAt DESC, id DESC`;
  return {
    sql,
    bindings: [
      ...targetVisitSourceBindings(siteId, target.value),
      ...detailCustomEventSourceBindings(siteId),
    ],
  };
}

function legacyTimelineRows(
  database: DatabaseSync,
  siteId: string,
  target: { readonly type: "visitor" | "session"; readonly value: string },
): Record<string, unknown>[] {
  const query = legacyTimelineQuery(siteId, target);
  return database.prepare(query.sql).all(...query.bindings) as Record<
    string,
    unknown
  >[];
}

function legacyDetailSourceQuery(
  siteId: string,
  target: { readonly type: "visitor" | "session"; readonly value: string },
  window?: QueryWindow,
): { readonly sql: string; readonly bindings: readonly (string | number)[] } {
  const targetColumn = target.type === "visitor" ? "visitor_id" : "session_id";
  const sql = `
WITH
${buildTargetVisitSourceCte(targetColumn, {
  withinWindow: Boolean(window),
})},
filtered_visits AS MATERIALIZED (SELECT * FROM visit_source),
${buildDetailCustomEventSourceCte({ materialize: true })}
SELECT
  'visit' AS sourceType, visit_id AS visitId, visitor_id AS visitorId,
  session_id AS sessionId, user_id AS userId, user_name AS userName, status,
  started_at AS startedAt, last_activity_at AS lastActivityAt,
  ended_at AS endedAt, duration_ms AS durationMs, pathname,
  hash_fragment AS hash, title, hostname, referrer_host AS referrerHost,
  referrer_url AS referrerUrl, country, region, region_code AS regionCode,
  city, latitude, longitude, browser, browser_version AS browserVersion,
  os, os_version AS osVersion, device_type AS deviceType,
  screen_width AS screenWidth, screen_height AS screenHeight,
  perf_ttfb_ms AS perfTtfbMs, perf_fcp_ms AS perfFcpMs,
  perf_lcp_ms AS perfLcpMs, perf_cls AS perfCls, perf_inp_ms AS perfInpMs,
  NULL AS eventId, NULL AS eventType, NULL AS occurredAt
FROM filtered_visits
UNION ALL
SELECT
  'custom' AS sourceType, visit_id AS visitId, visitor_id AS visitorId,
  session_id AS sessionId, user_id AS userId, user_name AS userName,
  NULL AS status, NULL AS startedAt, NULL AS lastActivityAt,
  NULL AS endedAt, NULL AS durationMs, pathname,
  hash_fragment AS hash, title, hostname, referrer_host AS referrerHost,
  referrer_url AS referrerUrl, country, region, NULL AS regionCode,
  city, NULL AS latitude, NULL AS longitude, browser,
  browser_version AS browserVersion, os, os_version AS osVersion,
  device_type AS deviceType, screen_width AS screenWidth,
  screen_height AS screenHeight, perf_ttfb_ms AS perfTtfbMs,
  perf_fcp_ms AS perfFcpMs, perf_lcp_ms AS perfLcpMs,
  perf_cls AS perfCls, perf_inp_ms AS perfInpMs,
  event_id AS eventId, event_name AS eventType, occurred_at AS occurredAt
FROM event_source`;
  return {
    sql,
    bindings: [
      ...targetVisitSourceBindings(siteId, target.value, window),
      ...detailCustomEventSourceBindings(siteId),
    ],
  };
}

function legacyDetailSourceRows(
  database: DatabaseSync,
  siteId: string,
  target: { readonly type: "visitor" | "session"; readonly value: string },
  window?: QueryWindow,
): Record<string, unknown>[] {
  const query = legacyDetailSourceQuery(siteId, target, window);
  return database.prepare(query.sql).all(...query.bindings) as Record<
    string,
    unknown
  >[];
}

function rowBag(rows: readonly Record<string, unknown>[]): string[] {
  return rows
    .map((row) =>
      JSON.stringify(
        Object.fromEntries(
          Object.entries(row).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        ),
      ),
    )
    .sort();
}

describe("Journey report Observation D1 lowering", () => {
  beforeAll(() => {
    db = createMigratedDatabase();
    seed(db);
    seedPlanNoise(db);
  });

  afterAll(() => db.close());

  it("rejects malformed Observation plan inputs", () => {
    const valid = {
      siteId: SITE_A,
      target: { type: "visitor", value: TARGET_VISITOR } as const,
      shape: "timeline" as const,
    };
    expect(() =>
      buildJourneyObservationPlan({ ...valid, target: null as never }),
    ).toThrow("journey_observation_invalid_target");
    expect(() =>
      buildJourneyObservationPlan({
        ...valid,
        target: { type: "visitor", value: 1 } as never,
      }),
    ).toThrow("journey_observation_invalid_target");
    expect(() =>
      buildJourneyObservationPlan({
        ...valid,
        target: { type: "account", value: "acct-1" } as never,
      }),
    ).toThrow("journey_observation_unsupported_target");
    expect(() =>
      buildJourneyObservationPlan({ ...valid, shape: "summary" as never }),
    ).toThrow("journey_observation_unsupported_shape");
    expect(() =>
      buildJourneyObservationPlan({ ...valid, window: WINDOW }),
    ).toThrow("journey_observation_timeline_does_not_accept_window");
    expect(() =>
      buildJourneyObservationPlan({
        ...valid,
        shape: "detail-source",
        window: { ...WINDOW, startMs: Number.NaN },
      }),
    ).toThrow("journey_observation_invalid_window");
  });

  it("matches the complete legacy timeline for raw identities and retained history", async () => {
    const env = testEnv(db);
    const targets = [
      { type: "visitor", value: TARGET_VISITOR },
      { type: "visitor", value: "casevisitor" },
      { type: "visitor", value: "访客🌍" },
      { type: "visitor", value: "" },
      { type: "session", value: TARGET_SESSION },
      { type: "session", value: "casesession" },
      { type: "session", value: "会话🚀" },
      { type: "session", value: "" },
    ] as const;

    for (const target of targets) {
      const expected = legacyTimelineRows(db, SITE_A, target).map(
        mapJourneyEventRow,
      );
      const actual = await queryJourneyEventsForDetailFromD1(
        env,
        SITE_A,
        target,
      );
      expect(actual, `${target.type}:${JSON.stringify(target.value)}`).toEqual(
        expected,
      );
    }
    expect(
      await queryJourneyEventsForDetailFromD1(env, "unknown-site", {
        type: "visitor",
        value: TARGET_VISITOR,
      }),
    ).toEqual([]);

    const visitorRows = await queryJourneyEventsForDetailFromD1(env, SITE_A, {
      type: "visitor",
      value: TARGET_VISITOR,
    });
    expect(visitorRows.map((row) => row.id)).toContain(
      "event-foreign-dictionary-site",
    );
    expect(visitorRows.map((row) => row.id)).not.toContain(
      "event-missing-dictionary",
    );
    expect(visitorRows.map((row) => row.id)).not.toContain(
      "event-orphan-owner",
    );
    expect(visitorRows.map((row) => row.id)).not.toContain(
      "event-cross-site-owner",
    );
    expect(
      visitorRows.find((row) => row.id === "owner-in-window"),
    ).toMatchObject({
      durationMs: 0,
      performance: { ttfb: null },
      screenWidth: null,
    });
  });

  it("keeps report Observation carriers separate when consumers request different attributes", () => {
    const semanticPlan = buildJourneyObservationPlan({
      siteId: SITE_A,
      target: { type: "visitor", value: TARGET_VISITOR },
      shape: "timeline",
    });
    const builder = new LogicalPlanBuilder(semanticPlan.context);
    const identityOnly = builder.source("observation", {
      temporalDomain: "read",
      attributes: ["observation.visitorId"],
    });
    const named = builder.source("observation", {
      temporalDomain: "read",
      attributes: ["observation.eventName"],
      includeOccurrenceTime: true,
    });
    builder.output("identity-only", identityOnly, [
      { name: "visitorId", slot: "attribute:observation.visitorId" },
    ]);
    builder.output("named", named, [
      { name: "eventName", slot: "attribute:observation.eventName" },
      { name: "occurredAt", slot: "time" },
    ]);
    const plan = builder.finish();
    const storage = new AnalyticsRelationalStorage({
      siteId: SITE_A,
      time: plan.context.time,
    });
    const sources = plan.nodes.filter((node) => node.kind === "source");
    const queries = sources.map((source, index) => {
      const lowered = storage.lowerSource(
        source,
        `source${index}`,
        new Set(source.output),
      );
      return compileD1Query(lowered.relation);
    });

    expect(queries[0]!.sql).not.toContain("custom_event_names");
    expect(queries[1]!.sql).toContain("custom_event_names");
    expect(queries[1]!.sql).toContain("occurred_at");
  });

  it("keeps candidate Observation sources bounded to their occurrence times", () => {
    const semanticPlan = buildJourneyObservationPlan({
      siteId: SITE_A,
      target: { type: "visitor", value: TARGET_VISITOR },
      shape: "timeline",
    });
    const builder = new LogicalPlanBuilder(semanticPlan.context);
    const observations = builder.source("observation", {
      temporalDomain: "candidate",
      attributes: ["observation.kind"],
      includeOccurrenceTime: true,
    });
    builder.output("candidate-observations", observations, [
      { name: "kind", slot: "attribute:observation.kind" },
    ]);
    const plan = builder.finish();
    const source = plan.nodes.find((node) => node.kind === "source");
    if (!source || source.kind !== "source")
      throw new Error("candidate_observation_source_expected");
    const storage = new AnalyticsRelationalStorage({
      siteId: SITE_A,
      time: plan.context.time,
    });
    const query = compileD1Query(
      storage.lowerSource(source, String(source.id), new Set(source.output))
        .relation,
    );

    expect(query.sql).toContain("started_at");
    expect(query.sql).toContain("occurred_at");
    expect(query.bindings).toEqual(expect.arrayContaining([0, 1]));
  });

  it("matches legacy detail-source bags and filters windows by owner start only", async () => {
    const target = { type: "visitor", value: TARGET_VISITOR } as const;
    for (const window of [undefined, WINDOW]) {
      const expected = legacyDetailSourceRows(db, SITE_A, target, window);
      const query = compileTypedObservationQuery(
        SITE_A,
        target,
        "detail-source",
        window,
      );
      const actual = (
        await createD1DatabaseClient(createSqliteD1Database(db)).all(query)
      ).results as Record<string, unknown>[];
      expect(rowBag(actual)).toEqual(rowBag(expected));
    }

    const windowRows = (
      await createD1DatabaseClient(createSqliteD1Database(db)).all(
        compileTypedObservationQuery(SITE_A, target, "detail-source", WINDOW),
      )
    ).results as Record<string, unknown>[];
    const customIds = windowRows
      .filter((row) => row.sourceType === "custom")
      .map((row) => row.eventId)
      .sort();
    expect(customIds).toEqual([
      "event-after-owner-time",
      "event-before-owner-time",
      "event-foreign-dictionary-site",
    ]);
    const page = windowRows.find((row) => row.visitId === "owner-in-window");
    expect(page).toMatchObject({
      sourceType: "visit",
      durationMs: null,
      latitude: null,
      longitude: null,
    });
    const custom = windowRows.find(
      (row) => row.eventId === "event-before-owner-time",
    );
    expect(custom).toMatchObject({
      sourceType: "custom",
      status: null,
      startedAt: null,
      durationMs: null,
      regionCode: null,
      latitude: null,
      longitude: null,
      occurredAt: -50_000,
    });
  });

  it("keeps the production Visitor and Session detail DTOs on the shared source", async () => {
    const env = testEnv(db);
    const visitor = await queryVisitorDetailFromD1(
      env,
      SITE_A,
      TARGET_VISITOR,
      "UTC",
      WINDOW,
    );
    expect(visitor?.visitor).toMatchObject({
      visitorId: TARGET_VISITOR,
      views: 1,
      sessions: 1,
      events: 3,
      firstSeenAt: 100,
      lastSeenAt: 100,
    });
    expect(
      visitor?.events
        .filter((event) => event.kind === "custom")
        .map((event) => event.id)
        .sort(),
    ).toEqual([
      "event-after-owner-time",
      "event-before-owner-time",
      "event-foreign-dictionary-site",
    ]);

    const session = await querySessionDetailFromD1(
      env,
      SITE_A,
      TARGET_SESSION,
      WINDOW,
    );
    expect(session?.session).toMatchObject({
      sessionId: TARGET_SESSION,
      views: 1,
      events: 3,
      startedAt: 100,
    });
    expect(
      session?.events
        .filter((event) => event.kind === "custom")
        .map((event) => event.id)
        .sort(),
    ).toEqual([
      "event-after-owner-time",
      "event-before-owner-time",
      "event-foreign-dictionary-site",
    ]);
  });

  it("executes one tagged compiled statement and exposes the measured plan", async () => {
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
    });
    const env = instrumentEnv(testEnv(db, trace), logger);
    await runWithInvocationLogger(logger, () =>
      runWithD1Operation("site_journeys.events", () =>
        queryJourneyEventsForDetailFromD1(env, SITE_A, {
          type: "visitor",
          value: TARGET_VISITOR,
        }),
      ),
    );
    const record = await logger.emitWhenComplete();
    const operation = record.logs.find((entry) =>
      entry.message.startsWith("db.query.v1.all.success"),
    );
    expect(trace.preparedSql).toHaveLength(1);
    expect(trace.bindings).toHaveLength(1);
    expect(operation?.data).toMatchObject({
      tag: "site_journeys.events",
      operation: "all",
      status: "success",
      sqlBytes: new TextEncoder().encode(trace.preparedSql[0]!).byteLength,
      bindings: trace.bindings[0]!.length,
      physicalPlanHash: expect.stringMatching(/^v1:/u),
    });
    expect(trace.preparedSql[0]).toContain("UNION ALL");

    const typedQuery = compileTypedObservationQuery(
      SITE_A,
      { type: "visitor", value: TARGET_VISITOR },
      "timeline",
    );
    const legacyQuery = legacyTimelineQuery(SITE_A, {
      type: "visitor",
      value: TARGET_VISITOR,
    });
    const explain = explainQueryPlan(db, {
      sql: typedQuery.sql,
      bindings: typedQuery.bindings as readonly SQLInputValue[],
    });
    const legacyExplain = explainQueryPlan(db, {
      sql: legacyQuery.sql,
      bindings: legacyQuery.bindings,
    });
    expect(explain.length).toBeGreaterThan(0);
    expect(explain.join("\n")).toContain(
      "idx_visits_site_pk_visitor_started_at",
    );
    expect(explain.join("\n")).toContain(
      "idx_custom_events_site_pk_visit_time",
    );
    expect(legacyExplain.join("\n")).toContain(
      "idx_visits_site_pk_visitor_started_at",
    );
    expect(legacyExplain.join("\n")).toContain(
      "idx_custom_events_site_pk_visit_time",
    );
    expect(explain.join("\n")).toContain("USE TEMP B-TREE FOR ORDER BY");
    expect(legacyExplain.join("\n")).toContain("USE TEMP B-TREE FOR ORDER BY");
    expect(typedQuery.bindings?.length ?? 0).toBeGreaterThan(0);

    const detailTrace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const detailLogger = createInvocationLogger({
      source: "worker",
      trigger: "request",
    });
    const detailEnv = instrumentEnv(testEnv(db, detailTrace), detailLogger);
    await runWithInvocationLogger(detailLogger, () =>
      runWithD1Operation("site_journeys.visitor_detail", () =>
        queryVisitorDetailFromD1(
          detailEnv,
          SITE_A,
          TARGET_VISITOR,
          "UTC",
          WINDOW,
        ),
      ),
    );
    const detailRecord = await detailLogger.emitWhenComplete();
    const detailOperation = detailRecord.logs.find((entry) =>
      entry.message.startsWith("db.query.v1.all.success"),
    );
    expect(detailTrace.preparedSql).toHaveLength(1);
    expect(detailTrace.bindings).toHaveLength(1);
    expect(detailOperation?.data).toMatchObject({
      tag: "site_journeys.visitor_detail",
      operation: "all",
      status: "success",
      sqlBytes: new TextEncoder().encode(detailTrace.preparedSql[0]!)
        .byteLength,
      bindings: detailTrace.bindings[0]!.length,
      physicalPlanHash: expect.stringMatching(/^v1:/u),
    });

    const detailTypedQuery = compileTypedObservationQuery(
      SITE_A,
      { type: "visitor", value: TARGET_VISITOR },
      "detail-source",
      WINDOW,
    );
    const detailLegacyQuery = legacyDetailSourceQuery(
      SITE_A,
      { type: "visitor", value: TARGET_VISITOR },
      WINDOW,
    );
    const detailExplain = explainQueryPlan(db, {
      sql: detailTypedQuery.sql,
      bindings: detailTypedQuery.bindings as readonly SQLInputValue[],
    });
    const detailLegacyExplain = explainQueryPlan(db, {
      sql: detailLegacyQuery.sql,
      bindings: detailLegacyQuery.bindings,
    });
    expect(detailExplain.join("\n")).toContain(
      "idx_visits_site_pk_visitor_started_at",
    );
    expect(detailExplain.join("\n")).toContain(
      "idx_custom_events_site_pk_visit_time",
    );
    expect(detailLegacyExplain.join("\n")).toContain(
      "idx_visits_site_pk_visitor_started_at",
    );
    expect(detailLegacyExplain.join("\n")).toContain(
      "idx_custom_events_site_pk_visit_time",
    );
    const searchCount = (lines: readonly string[], index: string) =>
      lines.filter((line) => line.includes(index)).length;
    expect(searchCount(explain, "idx_visits_site_pk_visitor_started_at")).toBe(
      2,
    );
    expect(
      searchCount(legacyExplain, "idx_visits_site_pk_visitor_started_at"),
    ).toBe(2);
    expect(
      searchCount(detailExplain, "idx_visits_site_pk_visitor_started_at"),
    ).toBe(2);
    expect(
      searchCount(detailLegacyExplain, "idx_visits_site_pk_visitor_started_at"),
    ).toBe(1);
    expect(detailTypedQuery.sql).not.toContain("ORDER BY");
    for (const statement of [
      { name: "legacy timeline", ...legacyQuery },
      {
        name: "typed timeline",
        sql: typedQuery.sql,
        bindings: typedQuery.bindings ?? [],
      },
      { name: "legacy detail", ...detailLegacyQuery },
      {
        name: "typed detail",
        sql: detailTypedQuery.sql,
        bindings: detailTypedQuery.bindings ?? [],
      },
    ]) {
      const bytes = new TextEncoder().encode(statement.sql).byteLength;
      expect(bytes, statement.name).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
      expect(statement.bindings.length, statement.name).toBeLessThanOrEqual(
        D1_MAX_BOUND_PARAMETERS,
      );
    }
  });
});
