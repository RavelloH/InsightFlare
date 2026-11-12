import { createHash } from "node:crypto";
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
import { EMPTY_FILTER_DOCUMENT } from "@/lib/edge/analytics/contract";
import {
  attachScopedFilterMetadata,
  createQueryTime,
  prepareScopedQuery,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import {
  buildJourneyEventPageReportPlan,
  JOURNEY_EVENT_PAGE_REPORT_OUTPUT,
} from "@/lib/edge/analytics/engine/journey-event-page-report-plan";
import { buildJourneyObservationPlan } from "@/lib/edge/analytics/engine/journey-observation-plan";
import { LogicalPlanBuilder } from "@/lib/edge/analytics/engine/logical/builder";
import { scopedDatasetFor } from "@/lib/edge/analytics/providers/d1/internal/__tests__/journey-list-parent-scoped-oracle";
import { buildVisitFilterSql } from "@/lib/edge/analytics/providers/d1/internal/__tests__/legacy-core-filters";
import {
  buildCustomEventSourceCte,
  buildDetailCustomEventSourceCte,
  buildTargetVisitSourceCte,
  buildVisitSourceCte,
  detailCustomEventSourceBindings,
  eventSourceBindings,
  targetVisitSourceBindings,
  visitSourceBindings,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/legacy-core-sources";
import type { PreparedMembershipFixture } from "@/lib/edge/analytics/providers/d1/internal/__tests__/prepared-membership-fixture";
import { preparedMembershipFromIds } from "@/lib/edge/analytics/providers/d1/internal/__tests__/prepared-membership-fixture";
import { AnalyticsLogicalToDbLowerer } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";
import { AnalyticsRelationalStorage } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-storage";
import type { QueryWindow } from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  queryJourneyEventsForDetailFromD1,
  querySessionDetailFromD1,
  queryVisitorDetailFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/journey-detail-queries";
import {
  mapJourneyEventRow,
  whereClauseWithTarget,
} from "@/lib/edge/analytics/providers/d1/internal/journey-helpers";
import { queryJourneyEventsPageFromD1 } from "@/lib/edge/analytics/providers/d1/internal/journey-list-queries";
import { instrumentEnv } from "@/lib/edge/observability/bindings";
import {
  createInvocationLogger,
  runWithD1Operation,
  runWithInvocationLogger,
} from "@/lib/edge/observability/logger";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";
import {
  type FilterDocument,
  type FilterExpression,
  normalizeFilterDocument,
} from "@/lib/filter-contract/filters";

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
    readonly hash?: string;
    readonly title?: string;
    readonly durationMs?: number | null;
    readonly screenWidth?: number | null;
    readonly screenHeight?: number | null;
    readonly perfTtfbMs?: number | null;
    readonly perfFcpMs?: number | null;
    readonly perfLcpMs?: number | null;
    readonly perfCls?: number | null;
    readonly perfInpMs?: number | null;
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
      input.hash ?? `#${input.visitId}`,
      "journey.test",
      input.title ?? `Title ${input.visitId}`,
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
      input.screenWidth ?? null,
      input.screenHeight ?? null,
      input.userId ?? null,
      input.userName ?? null,
      input.perfTtfbMs ?? null,
      input.perfFcpMs ?? null,
      input.perfLcpMs ?? null,
      input.perfCls ?? null,
      input.perfInpMs ?? null,
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

function filtersFor(root: FilterExpression | null): FilterDocument {
  return normalizeFilterDocument({ version: 1, root }, analyticsFilterRegistry);
}

function pagePathFilter(pathname: string): FilterDocument {
  return filtersFor({
    kind: "condition",
    target: { kind: "field", field: "page.path" },
    operator: "eq",
    value: pathname,
  } as never);
}

function eventNameFilter(name: string): FilterDocument {
  return filtersFor({
    kind: "condition",
    target: { kind: "field", field: "event.name" },
    operator: "eq",
    value: name,
  } as never);
}

function payloadExists40(): FilterDocument {
  return filtersFor({
    kind: "and",
    children: Array.from({ length: 40 }, (_unused, index) => ({
      kind: "condition" as const,
      target: {
        kind: "event-payload" as const,
        path: `/wave67/payload-${index}`,
      },
      operator: "exists" as const,
    })),
  } as never);
}

function preparedFilters(
  filters: FilterDocument,
  scopePreference: "event" | "session" | "visitor" = "event",
): { readonly filters: FilterDocument; readonly scopePlan: ScopedFilterPlan } {
  const prepared = prepareScopedQuery("event-records", {
    context: siteQueryContext(SITE_A, "private-dashboard"),
    time: createQueryTime(
      WINDOW.startMs,
      WINDOW.endExclusiveMs,
      WINDOW.timeZone,
      WINDOW.nowMs,
    ),
    filters,
    scopePreference,
  } as never) as {
    readonly filters?: FilterDocument;
    readonly scopePlan?: ScopedFilterPlan;
  };
  if (!prepared.filters || !prepared.scopePlan)
    throw new Error("journey_event_page_prepare_failed");
  return { filters: prepared.filters, scopePlan: prepared.scopePlan };
}

function withAdvancedMatches(
  prepared: {
    readonly filters: FilterDocument;
    readonly scopePlan: ScopedFilterPlan;
  },
  matches: PreparedMembershipFixture,
): FilterDocument {
  const metadata = scopedFilterMetadata(prepared.filters);
  if (!metadata) throw new Error("journey_event_page_metadata_missing");
  return attachScopedFilterMetadata(prepared.filters, {
    ...metadata,
    plan: {
      ...prepared.scopePlan,
      preparedMembership: preparedMembershipFromIds(matches),
    },
  });
}

function addPayload(
  database: DatabaseSync,
  site: FixtureSite,
  eventId: string,
  path: string,
  occurredAt: number,
): void {
  const event = database
    .prepare(
      "SELECT event_pk, event_name_id FROM custom_events WHERE event_id = ?",
    )
    .get(eventId) as {
    readonly event_pk: number;
    readonly event_name_id: number;
  };
  database
    .prepare(
      `INSERT OR IGNORE INTO custom_event_json_paths
       (site_id, site_pk, path, last_seen_at) VALUES (?, ?, ?, ?)`,
    )
    .run(site.siteId, site.sitePk, path, occurredAt);
  const pathRow = database
    .prepare(
      "SELECT id FROM custom_event_json_paths WHERE site_pk = ? AND path = ?",
    )
    .get(site.sitePk, path) as { readonly id: number };
  const node = database
    .prepare(
      `SELECT COALESCE(MAX(node_id), 0) + 1 AS node_id
       FROM custom_event_json_nodes WHERE event_pk = ?`,
    )
    .get(event.event_pk) as { readonly node_id: number };
  database
    .prepare(
      `INSERT INTO custom_event_json_nodes
       (event_pk, node_id, path_id, value_type, depth)
       VALUES (?, ?, ?, 1, 1)`,
    )
    .run(event.event_pk, node.node_id, pathRow.id);
  database
    .prepare(
      `INSERT INTO custom_event_json_values (
        event_pk, node_id, site_id, event_name_id, path_id, occurred_at,
        value_type, string_value, number_value, boolean_value, site_pk
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, NULL, NULL, ?)`,
    )
    .run(
      event.event_pk,
      node.node_id,
      site.siteId,
      event.event_name_id,
      pathRow.id,
      occurredAt,
      `payload:${path}`,
      site.sitePk,
    );
}

function testEnv(database: DatabaseSync, trace?: SqliteD1Trace): Env {
  return {
    DB: createSqliteD1Database(database, trace),
  } as unknown as Env;
}

function legacySourceEnv(
  database: DatabaseSync,
  source: {
    readonly sql: string;
    readonly bindings: readonly (string | number)[];
  },
): Env {
  const backing = createSqliteD1Database(database);
  const prepared = backing
    .prepare(source.sql)
    .bind(...(source.bindings as SQLInputValue[]));
  return {
    DB: {
      prepare: () => ({ bind: () => prepared }),
    },
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

/** Frozen test-only copy of the complete pre-Logical Journey Events page SQL. */
function legacyJourneyEventsPageQuery(input: {
  readonly siteId: string;
  readonly window: QueryWindow;
  readonly filters: Parameters<typeof buildVisitFilterSql>[0];
  readonly target: {
    readonly type: "visitor" | "session";
    readonly value: string;
  };
  readonly limit: number;
  readonly cursor?: { readonly occurredAt: number; readonly id: string } | null;
}): { readonly sql: string; readonly bindings: readonly SQLInputValue[] } {
  const scopedDataset = scopedDatasetFor(
    input.siteId,
    input.window,
    input.filters,
  );
  const filter = scopedDataset
    ? null
    : buildVisitFilterSql(input.filters, "visit_source", {
        window: input.window,
      });
  const targetColumn =
    input.target.type === "visitor" ? "visitor_id" : "session_id";
  const targetClause = scopedDataset
    ? `WHERE ${targetColumn} = ?`
    : whereClauseWithTarget(filter?.clause ?? "", {
        column: targetColumn,
        value: input.target.value,
      });
  const eventTargetClause = scopedDataset ? `WHERE es.${targetColumn} = ?` : "";
  const customEventProjection = scopedDataset
    ? `
    es.session_id AS sessionId,
    es.visitor_id AS visitorId,
    es.pathname AS pathname,
    es.hash_fragment AS hash,
    es.title AS title,
    es.hostname AS hostname,
    es.referrer_host AS referrerHost,
    es.referrer_url AS referrerUrl,
    es.country AS country,
    es.region AS region,
    es.city AS city,
    es.browser AS browser,
    es.browser_version AS browserVersion,
    es.os AS os,
    es.os_version AS osVersion,
    es.device_type AS deviceType,
    es.screen_width AS screenWidth,
    es.screen_height AS screenHeight,
    0 AS durationMs,
    NULL AS perfTtfbMs,
    NULL AS perfFcpMs,
    NULL AS perfLcpMs,
    NULL AS perfCls,
    NULL AS perfInpMs`
    : `
    fv.session_id AS sessionId,
    fv.visitor_id AS visitorId,
    COALESCE(NULLIF(es.pathname, ''), fv.pathname) AS pathname,
    COALESCE(NULLIF(es.hash_fragment, ''), fv.hash_fragment) AS hash,
    COALESCE(NULLIF(es.title, ''), fv.title) AS title,
    COALESCE(NULLIF(es.hostname, ''), fv.hostname) AS hostname,
    COALESCE(NULLIF(es.referrer_host, ''), fv.referrer_host) AS referrerHost,
    COALESCE(NULLIF(es.referrer_url, ''), fv.referrer_url) AS referrerUrl,
    COALESCE(NULLIF(es.country, ''), fv.country) AS country,
    COALESCE(NULLIF(es.region, ''), fv.region) AS region,
    COALESCE(NULLIF(es.city, ''), fv.city) AS city,
    COALESCE(NULLIF(es.browser, ''), fv.browser) AS browser,
    fv.browser_version AS browserVersion,
    COALESCE(NULLIF(es.os, ''), fv.os) AS os,
    COALESCE(NULLIF(es.os_version, ''), fv.os_version) AS osVersion,
    COALESCE(NULLIF(es.device_type, ''), fv.device_type) AS deviceType,
    COALESCE(es.screen_width, fv.screen_width) AS screenWidth,
    COALESCE(es.screen_height, fv.screen_height) AS screenHeight,
    0 AS durationMs,
    fv.perf_ttfb_ms AS perfTtfbMs,
    fv.perf_fcp_ms AS perfFcpMs,
    fv.perf_lcp_ms AS perfLcpMs,
    fv.perf_cls AS perfCls,
    fv.perf_inp_ms AS perfInpMs`;
  const cursorClause = input.cursor
    ? "WHERE occurredAt < ? OR (occurredAt = ? AND id < ?)"
    : "";
  const sql = `
WITH
${scopedDataset?.ctes ?? `${buildVisitSourceCte()},\n${buildCustomEventSourceCte()}`},
${scopedDataset ? `event_source AS (SELECT * FROM ${scopedDataset.eventRelation}),` : ""}
filtered_visits AS (
  SELECT *
  FROM ${scopedDataset?.visitRelation ?? "visit_source"}
  ${targetClause}
),
page_events AS (
  SELECT
    visit_id AS id,
    'pageview' AS kind,
    'pageview' AS eventType,
    started_at AS occurredAt,
    visit_id AS visitId,
    session_id AS sessionId,
    visitor_id AS visitorId,
    pathname,
    hash_fragment AS hash,
    title,
    hostname,
    referrer_host AS referrerHost,
    referrer_url AS referrerUrl,
    country,
    region,
    city,
    browser,
    browser_version AS browserVersion,
    os,
    os_version AS osVersion,
    device_type AS deviceType,
    screen_width AS screenWidth,
    screen_height AS screenHeight,
    COALESCE(duration_ms, 0) AS durationMs,
    perf_ttfb_ms AS perfTtfbMs,
    perf_fcp_ms AS perfFcpMs,
    perf_lcp_ms AS perfLcpMs,
    perf_cls AS perfCls,
    perf_inp_ms AS perfInpMs
  FROM filtered_visits
),
custom_event_rows AS (
  SELECT
    es.event_id AS id,
    'custom' AS kind,
    es.event_name AS eventType,
    es.occurred_at AS occurredAt,
    es.visit_id AS visitId,
    ${customEventProjection}
  FROM event_source es
  ${scopedDataset ? "LEFT JOIN" : "INNER JOIN"} filtered_visits fv
    ON fv.visit_id = es.visit_id
  ${eventTargetClause}
)
SELECT *
FROM (
  SELECT * FROM page_events
  UNION ALL
  SELECT * FROM custom_event_rows
)
AS journey_events
${cursorClause}
ORDER BY occurredAt DESC, id DESC
LIMIT ?
`;
  return {
    sql,
    bindings: [
      ...(scopedDataset
        ? scopedDataset.bindings.map((binding) => binding.value)
        : [
            ...visitSourceBindings(input.siteId, input.window),
            ...eventSourceBindings(input.siteId, input.window),
          ]),
      input.target.value,
      ...(filter?.bindings ?? []),
      ...(scopedDataset ? [input.target.value] : []),
      ...(input.cursor
        ? [input.cursor.occurredAt, input.cursor.occurredAt, input.cursor.id]
        : []),
      input.limit + 1,
    ],
  };
}

function legacyJourneyEventsPageRows(
  database: DatabaseSync,
  input: Parameters<typeof legacyJourneyEventsPageQuery>[0],
): Record<string, unknown>[] {
  const query = legacyJourneyEventsPageQuery(input);
  return database.prepare(query.sql).all(...query.bindings) as Record<
    string,
    unknown
  >[];
}

function physicalGraphSummary(root: unknown): {
  readonly rootChain: readonly {
    readonly kind: string;
    readonly fields: number;
  }[];
  readonly multiplyReferenced: readonly {
    readonly kind: string;
    readonly fields: number;
    readonly incoming: number;
    readonly parents: readonly string[];
  }[];
} {
  const nodeIds = new Map<object, string>();
  const incoming = new Map<object, number>();
  const parents = new Map<object, string[]>();
  const expanded = new WeakSet<object>();
  const nodes = new Map<object, Record<string, unknown>>();
  let nextId = 0;
  const nodeFor = (source: unknown): Record<string, unknown> | null => {
    if (typeof source !== "object" || source === null) return null;
    const record = source as Record<string, unknown>;
    const nested = record.node;
    if (typeof nested === "object" && nested !== null)
      return nested as Record<string, unknown>;
    return record;
  };
  const idFor = (node: object): string => {
    const existing = nodeIds.get(node);
    if (existing) return existing;
    const id = `g${nextId++}`;
    nodeIds.set(node, id);
    return id;
  };
  const childSources = (node: Record<string, unknown>): unknown[] => {
    if (
      node.kind === "filter" ||
      node.kind === "project" ||
      node.kind === "sort" ||
      node.kind === "limit" ||
      node.kind === "distinct" ||
      node.kind === "aggregate" ||
      node.kind === "window" ||
      node.kind === "recursive-closure"
    )
      return [node.input];
    if (
      node.kind === "join" ||
      node.kind === "semi-join" ||
      node.kind === "anti-join"
    )
      return [node.left, node.right];
    if (node.kind === "union") return [node.left, node.right];
    return [];
  };
  const visit = (source: unknown, parent?: Record<string, unknown>): void => {
    const node = nodeFor(source);
    if (!node) return;
    nodes.set(node, node);
    idFor(node);
    if (parent) {
      incoming.set(node, (incoming.get(node) ?? 0) + 1);
      const parentLabel = `${String(parent.kind)}:${idFor(parent)}`;
      parents.set(node, [...(parents.get(node) ?? []), parentLabel]);
    }
    if (expanded.has(node)) return;
    expanded.add(node);
    for (const child of childSources(node)) visit(child, node);
  };
  visit(root);
  const rootNode = nodeFor(root);
  const rootChain: { kind: string; fields: number }[] = [];
  let current = rootNode;
  const chainSeen = new WeakSet<object>();
  while (current && !chainSeen.has(current)) {
    chainSeen.add(current);
    rootChain.push({
      kind: String(current.kind),
      fields: Array.isArray(current.fields) ? current.fields.length : 0,
    });
    const next =
      current.input === undefined ? undefined : nodeFor(current.input);
    current = next ?? null;
  }
  return {
    rootChain,
    multiplyReferenced: [...nodes.entries()]
      .filter(([node]) => (incoming.get(node) ?? 0) > 1)
      .map(([node]) => {
        const record = nodes.get(node)!;
        return {
          kind: String(record.kind),
          fields: Array.isArray(record.fields) ? record.fields.length : 0,
          incoming: incoming.get(node) ?? 0,
          parents: parents.get(node) ?? [],
        };
      })
      .sort(
        (left, right) =>
          right.fields - left.fields || right.incoming - left.incoming,
      ),
  };
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

  it("freezes the full parent Journey Events page assembly before migration", async () => {
    for (const target of [
      { type: "visitor", value: TARGET_VISITOR },
      { type: "session", value: TARGET_SESSION },
    ] as const) {
      const input = {
        siteId: SITE_A,
        window: WINDOW,
        filters: EMPTY_FILTER_DOCUMENT,
        target,
        limit: 100,
      };
      const query = legacyJourneyEventsPageQuery(input);
      const parentRaw = legacyJourneyEventsPageRows(db, input);
      const parent = parentRaw.map(mapJourneyEventRow);
      const actual = await queryJourneyEventsPageFromD1(
        testEnv(db),
        input.siteId,
        input.window,
        input.filters,
        target,
        input.limit,
      );

      expect(query.sql).toContain("UNION ALL");
      expect(query.sql).toContain("INNER JOIN filtered_visits fv");
      expect(query.sql).toContain("ORDER BY occurredAt DESC, id DESC");
      expect(actual.items).toEqual(parent);
      expect(actual.pagination).toEqual({
        limit: input.limit,
        returned: parent.length,
        hasMore: false,
        nextCursor: null,
      });
    }
  });

  it("keeps direct Page eligibility, duplicate bags, and the exact cursor", async () => {
    db.exec("SAVEPOINT wave67_journey_direct_eligibility");
    try {
      insertEvent(db, {
        eventId: "owner-in-window",
        site: siteA,
        visitId: "owner-in-window",
        eventNameId: siteA.purchaseNameId,
        occurredAt: 100,
      });
      const filters = pagePathFilter("/inside");
      const target = { type: "visitor", value: TARGET_VISITOR } as const;
      const firstInput = {
        siteId: SITE_A,
        window: WINDOW,
        filters,
        target,
        limit: 2,
      };
      const parentFirst = legacyJourneyEventsPageRows(db, firstInput).map(
        mapJourneyEventRow,
      );
      const actualFirst = await queryJourneyEventsPageFromD1(
        testEnv(db),
        SITE_A,
        WINDOW,
        filters,
        target,
        firstInput.limit,
      );
      expect(actualFirst.items).toEqual(parentFirst.slice(0, firstInput.limit));
      expect(actualFirst.pagination).toEqual({
        limit: firstInput.limit,
        returned: Math.min(parentFirst.length, firstInput.limit),
        hasMore: parentFirst.length > firstInput.limit,
        nextCursor:
          parentFirst.length > firstInput.limit
            ? {
                occurredAt: parentFirst[firstInput.limit - 1]!.occurredAt,
                id: parentFirst[firstInput.limit - 1]!.id,
              }
            : null,
      });
      expect(actualFirst.items.map((row) => row.id)).not.toContain(
        "event-owner-outside-window",
      );
      expect(actualFirst.items.map((row) => row.id)).not.toContain(
        "event-missing-dictionary",
      );

      if (!actualFirst.pagination.nextCursor) return;
      const secondInput = {
        ...firstInput,
        cursor: actualFirst.pagination.nextCursor,
      };
      const parentSecond = legacyJourneyEventsPageRows(db, secondInput).map(
        mapJourneyEventRow,
      );
      const actualSecond = await queryJourneyEventsPageFromD1(
        testEnv(db),
        SITE_A,
        WINDOW,
        filters,
        target,
        firstInput.limit,
        secondInput.cursor,
      );
      expect(actualSecond.items).toEqual(
        parentSecond.slice(0, firstInput.limit),
      );
      expect(actualSecond.items.map((row) => row.id)).not.toContain(
        "event-owner-outside-window",
      );
    } finally {
      db.exec("ROLLBACK TO wave67_journey_direct_eligibility");
      db.exec("RELEASE wave67_journey_direct_eligibility");
    }
  });

  it("keeps prepared Event ownership independent from filtered Page rows and uses the actual reader window", async () => {
    db.exec("SAVEPOINT wave67_journey_prepared_ownership");
    try {
      insertEvent(db, {
        eventId: "event-previous-reader-window",
        site: siteA,
        visitId: "owner-in-window",
        eventNameId: siteA.purchaseNameId,
        occurredAt: 75,
      });
      const prepared = preparedFilters(eventNameFilter("purchase"));
      const target = { type: "visitor", value: TARGET_VISITOR } as const;
      const currentInput = {
        siteId: SITE_A,
        window: WINDOW,
        filters: prepared.filters,
        target,
        limit: 100,
      };
      const parentCurrent = legacyJourneyEventsPageRows(db, currentInput).map(
        mapJourneyEventRow,
      );
      const actualCurrent = await queryJourneyEventsPageFromD1(
        testEnv(db),
        SITE_A,
        WINDOW,
        prepared.filters,
        target,
        currentInput.limit,
      );
      expect(actualCurrent.items).toEqual(parentCurrent);
      expect(actualCurrent.items.map((row) => row.id)).toContain(
        "event-owner-outside-window",
      );

      const previousWindow: QueryWindow = {
        ...WINDOW,
        startMs: 0,
        endExclusiveMs: 100,
      };
      const previousInput = {
        ...currentInput,
        window: previousWindow,
      };
      const parentPrevious = legacyJourneyEventsPageRows(db, previousInput).map(
        mapJourneyEventRow,
      );
      const actualPrevious = await queryJourneyEventsPageFromD1(
        testEnv(db),
        SITE_A,
        previousWindow,
        prepared.filters,
        target,
        previousInput.limit,
      );
      expect(actualPrevious.items).toEqual(parentPrevious);
      expect(actualPrevious.items.map((row) => row.id)).toContain(
        "event-previous-reader-window",
      );
      expect(actualPrevious.items.map((row) => row.id)).not.toContain(
        "owner-in-window",
      );

      const metricVisit = "journey-event-page-perf-owner";
      const metricEvent = "journey-event-page-perf-event";
      insertVisit(db, siteA, {
        visitId: metricVisit,
        visitorId: "MetricVisitor",
        sessionId: "MetricSession",
        startedAt: 130,
        pathname: "",
        title: "",
        durationMs: -9,
        screenWidth: null,
        screenHeight: null,
        perfTtfbMs: 51,
        perfFcpMs: 102,
        perfLcpMs: 203,
        perfCls: 0.125,
        perfInpMs: 7,
      });
      insertEvent(db, {
        eventId: metricEvent,
        site: siteA,
        visitId: metricVisit,
        eventNameId: siteA.purchaseNameId,
        occurredAt: 140,
      });
      const metricTarget = { type: "visitor", value: "MetricVisitor" } as const;
      const directMetricRows = await queryJourneyEventsPageFromD1(
        testEnv(db),
        SITE_A,
        WINDOW,
        EMPTY_FILTER_DOCUMENT,
        metricTarget,
        100,
      );
      const directMetricPage = directMetricRows.items.find(
        (row) => row.id === metricVisit,
      );
      const directMetricEvent = directMetricRows.items.find(
        (row) => row.id === metricEvent,
      );
      expect(directMetricPage).toMatchObject({
        pathname: "",
        title: "",
        durationMs: 0,
        screenWidth: null,
        performance: { ttfb: 51, fcp: 102, lcp: 203, cls: 0.125, inp: 7 },
      });
      expect(directMetricEvent).toMatchObject({
        pathname: "",
        title: "",
        durationMs: 0,
        screenWidth: null,
        performance: { ttfb: 51, fcp: 102, lcp: 203, cls: 0.125, inp: 7 },
      });

      const preparedMetric = preparedFilters(eventNameFilter("purchase"));
      const preparedMetricRows = await queryJourneyEventsPageFromD1(
        testEnv(db),
        SITE_A,
        WINDOW,
        preparedMetric.filters,
        metricTarget,
        100,
      );
      const preparedMetricPage = preparedMetricRows.items.find(
        (row) => row.id === metricVisit,
      );
      const preparedMetricEvent = preparedMetricRows.items.find(
        (row) => row.id === metricEvent,
      );
      expect(preparedMetricPage).toMatchObject({
        durationMs: 0,
        performance: { ttfb: 51, fcp: 102, lcp: 203, cls: 0.125, inp: 7 },
      });
      expect(preparedMetricEvent).toMatchObject({
        durationMs: 0,
        performance: { ttfb: null, fcp: null, lcp: null, cls: null, inp: null },
      });
    } finally {
      db.exec("ROLLBACK TO wave67_journey_prepared_ownership");
      db.exec("RELEASE wave67_journey_prepared_ownership");
    }
  });

  it("matches direct 40/39 payload membership and prepared-128 scopes within D1 budgets", async () => {
    db.exec("SAVEPOINT wave67_journey_page_budget");
    try {
      const visit40 = "journey-page-payload-40";
      const visit39 = "journey-page-payload-39";
      insertVisit(db, siteA, {
        visitId: visit40,
        visitorId: "PayloadVisitor",
        sessionId: "PayloadSession",
        startedAt: 120,
        pathname: "/payload-full",
      });
      insertVisit(db, siteA, {
        visitId: visit39,
        visitorId: "PayloadVisitor",
        sessionId: "PayloadSession",
        startedAt: 130,
        pathname: "/payload-partial",
      });
      insertEvent(db, {
        eventId: "journey-page-payload-event-40",
        site: siteA,
        visitId: visit40,
        eventNameId: siteA.purchaseNameId,
        occurredAt: 140,
      });
      insertEvent(db, {
        eventId: "journey-page-payload-event-39",
        site: siteA,
        visitId: visit39,
        eventNameId: siteA.purchaseNameId,
        occurredAt: 150,
      });
      for (let index = 0; index < 40; index += 1)
        addPayload(
          db,
          siteA,
          "journey-page-payload-event-40",
          `/wave67/payload-${index}`,
          140,
        );
      for (let index = 0; index < 39; index += 1)
        addPayload(
          db,
          siteA,
          "journey-page-payload-event-39",
          `/wave67/payload-${index}`,
          150,
        );

      const direct40 = payloadExists40();
      const payloadTarget = {
        type: "visitor",
        value: "PayloadVisitor",
      } as const;
      const directInput = {
        siteId: SITE_A,
        window: WINDOW,
        filters: direct40,
        target: payloadTarget,
        limit: 100,
      };
      const parentDirectQuery = legacyJourneyEventsPageQuery(directInput);
      const parentDirect = legacyJourneyEventsPageRows(db, directInput).map(
        mapJourneyEventRow,
      );
      const logicalPlan = buildJourneyEventPageReportPlan(directInput);
      const reportOutput = logicalPlan.outputs.find(
        (output) => output.id === JOURNEY_EVENT_PAGE_REPORT_OUTPUT,
      )!;
      const lowerer = new AnalyticsLogicalToDbLowerer(logicalPlan, {
        siteId: SITE_A,
        time: logicalPlan.context.time,
      });
      const loweredOutput = lowerer.lower(reportOutput);
      const genericRelation = lowerer.projectOutput(
        loweredOutput,
        reportOutput.fields.map((field) => ({
          name: field.name,
          slot: field.slot,
        })),
      );
      const physicalPlan = lowerLogicalPlan(genericRelation);
      const logicalNodeCounts = logicalPlan.nodes.reduce<
        Record<string, number>
      >((counts, node) => {
        counts[node.kind] = (counts[node.kind] ?? 0) + 1;
        return counts;
      }, {});
      console.info("wave67_direct40_parent_budget", {
        sqlBytes: new TextEncoder().encode(parentDirectQuery.sql).byteLength,
        sqlSha256: createHash("sha256")
          .update(parentDirectQuery.sql)
          .digest("hex"),
        bindings: parentDirectQuery.bindings.length,
        statements: 1,
      });
      console.info(
        "wave67_direct40_plan_shape",
        JSON.stringify({
          logicalNodeCounts,
          genericRootKind: physicalPlan.root.kind,
          genericGraph: physicalGraphSummary(physicalPlan.root),
          sharedRelations: physicalPlan.sharedRelations.map((relation) => ({
            name: relation.name,
            columns: relation.node.fields.length,
          })),
          outputFields: physicalPlan.fields.length,
        }),
      );
      const defaultTarget = { type: "visitor", value: TARGET_VISITOR } as const;
      const defaultInput = {
        siteId: SITE_A,
        window: WINDOW,
        filters: EMPTY_FILTER_DOCUMENT,
        target: defaultTarget,
        limit: 100,
      };
      const defaultParentQuery = legacyJourneyEventsPageQuery(defaultInput);
      const defaultTrace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      await queryJourneyEventsPageFromD1(
        testEnv(db, defaultTrace),
        SITE_A,
        WINDOW,
        EMPTY_FILTER_DOCUMENT,
        defaultTarget,
        defaultInput.limit,
      );
      const cursor = {
        occurredAt: 150,
        id: "event-foreign-dictionary-site",
      } as const;
      const cursorInput = { ...defaultInput, cursor };
      const cursorParentQuery = legacyJourneyEventsPageQuery(cursorInput);
      const cursorTrace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      await queryJourneyEventsPageFromD1(
        testEnv(db, cursorTrace),
        SITE_A,
        WINDOW,
        EMPTY_FILTER_DOCUMENT,
        defaultTarget,
        defaultInput.limit,
        cursor,
      );
      console.info("wave67_default_cursor_budget", [
        {
          profile: "default",
          parentSqlBytes: new TextEncoder().encode(defaultParentQuery.sql)
            .byteLength,
          parentSqlSha256: createHash("sha256")
            .update(defaultParentQuery.sql)
            .digest("hex"),
          parentBindings: defaultParentQuery.bindings.length,
          logicalSqlBytes: new TextEncoder().encode(
            defaultTrace.preparedSql[0]!,
          ).byteLength,
          logicalSqlSha256: createHash("sha256")
            .update(defaultTrace.preparedSql[0]!)
            .digest("hex"),
          logicalBindings: defaultTrace.bindings[0]!.length,
          statements: defaultTrace.preparedSql.length,
        },
        {
          profile: "cursor",
          parentSqlBytes: new TextEncoder().encode(cursorParentQuery.sql)
            .byteLength,
          parentSqlSha256: createHash("sha256")
            .update(cursorParentQuery.sql)
            .digest("hex"),
          parentBindings: cursorParentQuery.bindings.length,
          logicalSqlBytes: new TextEncoder().encode(cursorTrace.preparedSql[0]!)
            .byteLength,
          logicalSqlSha256: createHash("sha256")
            .update(cursorTrace.preparedSql[0]!)
            .digest("hex"),
          logicalBindings: cursorTrace.bindings[0]!.length,
          statements: cursorTrace.preparedSql.length,
        },
      ]);
      const directTrace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const actualDirect = await queryJourneyEventsPageFromD1(
        testEnv(db, directTrace),
        SITE_A,
        WINDOW,
        direct40,
        payloadTarget,
        directInput.limit,
      );
      expect(actualDirect.items).toEqual(parentDirect);
      expect(actualDirect.items.map((row) => row.id).sort()).toEqual(
        [visit40, "journey-page-payload-event-40"].sort(),
      );
      expect(directTrace.preparedSql).toHaveLength(1);
      const parentDirectExplain = explainQueryPlan(db, parentDirectQuery);
      const logicalDirectExplain = explainQueryPlan(db, {
        sql: directTrace.preparedSql[0]!,
        bindings: directTrace.bindings[0]!,
      });
      console.info("wave67_direct40_sqlite_eqp", {
        parentIdentityReads: parentDirectExplain.filter((line) =>
          /(?:site_identities|sqlite_autoindex_site_identities_1)/u.test(line),
        ).length,
        logicalIdentityReads: logicalDirectExplain.filter((line) =>
          /(?:site_identities|sqlite_autoindex_site_identities_1)/u.test(line),
        ).length,
        parentVisitIndexReads: parentDirectExplain.filter((line) =>
          /idx_visits_site_pk_(?:visitor_)?started_at/u.test(line),
        ).length,
        logicalVisitIndexReads: logicalDirectExplain.filter((line) =>
          /idx_visits_site_pk_(?:visitor_)?started_at/u.test(line),
        ).length,
        parentEventIndexReads: parentDirectExplain.filter((line) =>
          /idx_custom_events_site_pk_(?:name|visit)?_?time/u.test(line),
        ).length,
        logicalEventIndexReads: logicalDirectExplain.filter((line) =>
          /idx_custom_events_site_pk_(?:name|visit)?_?time/u.test(line),
        ).length,
        parentPayloadPathIndexReads: parentDirectExplain.filter((line) =>
          /idx_custom_event_json_paths_site_pk_path/u.test(line),
        ).length,
        logicalPayloadPathIndexReads: logicalDirectExplain.filter((line) =>
          /idx_custom_event_json_paths_site_pk_path/u.test(line),
        ).length,
        parentPayloadValueIndexReads: parentDirectExplain.filter((line) =>
          /idx_custom_event_values_site_pk_path_time/u.test(line),
        ).length,
        logicalPayloadValueIndexReads: logicalDirectExplain.filter((line) =>
          /idx_custom_event_values_site_pk_path_time/u.test(line),
        ).length,
      });

      const target = { type: "visitor", value: TARGET_VISITOR } as const;
      const preparedBase = preparedFilters(eventNameFilter("purchase"));
      const eventIds = [
        { siteId: SITE_A, id: "event-owner-outside-window" },
        { siteId: SITE_A, id: "event-owner-outside-window" },
        { siteId: SITE_A, id: "event-previous-reader-window" },
        ...Array.from({ length: 125 }, (_unused, index) => ({
          siteId: SITE_A,
          id: `journey-event-page-missing-event-${index}`,
        })),
      ];
      const visitIds = [
        { siteId: SITE_A, id: "owner-in-window" },
        { siteId: SITE_A, id: "owner-outside-window" },
        { siteId: SITE_A, id: "owner-in-window" },
        ...Array.from({ length: 125 }, (_unused, index) => ({
          siteId: SITE_A,
          id: `journey-event-page-missing-visit-${index}`,
        })),
      ];
      const prepared128 = withAdvancedMatches(preparedBase, {
        eventIds,
        visitIds,
      });
      const preparedEmpty = preparedFilters(EMPTY_FILTER_DOCUMENT).filters;
      const preparedProfiles = [
        {
          name: "prepared-empty-current",
          window: WINDOW,
          filters: preparedEmpty,
        },
        { name: "prepared-128-current", window: WINDOW, filters: prepared128 },
        {
          name: "prepared-128-previous",
          window: { ...WINDOW, startMs: 0, endExclusiveMs: 100 },
          filters: prepared128,
        },
      ] as const;
      const budgetRows: Array<Record<string, unknown>> = [];
      for (const profile of preparedProfiles) {
        const input = {
          siteId: SITE_A,
          window: profile.window,
          filters: profile.filters,
          target,
          limit: 100,
        };
        const parentQuery = legacyJourneyEventsPageQuery(input);
        const parent = legacyJourneyEventsPageRows(db, input).map(
          mapJourneyEventRow,
        );
        const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
        const actual = await queryJourneyEventsPageFromD1(
          testEnv(db, trace),
          SITE_A,
          profile.window,
          profile.filters,
          target,
          input.limit,
        );
        expect(actual.items).toEqual(parent);
        expect(trace.preparedSql).toHaveLength(1);
        const newSqlBytes = new TextEncoder().encode(
          trace.preparedSql[0]!,
        ).byteLength;
        const newBindings = trace.bindings[0]!.length;
        const parentSqlBytes = new TextEncoder().encode(
          parentQuery.sql,
        ).byteLength;
        const parentBindings = parentQuery.bindings.length;
        expect(newSqlBytes).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
        expect(newBindings).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
        budgetRows.push({
          profile: profile.name,
          parentSqlBytes,
          parentSqlSha256: createHash("sha256")
            .update(parentQuery.sql)
            .digest("hex"),
          parentBindings,
          logicalSqlBytes: newSqlBytes,
          logicalSqlSha256: createHash("sha256")
            .update(trace.preparedSql[0]!)
            .digest("hex"),
          logicalBindings: newBindings,
          statements: trace.preparedSql.length,
        });
      }

      const directSqlBytes = new TextEncoder().encode(
        directTrace.preparedSql[0]!,
      ).byteLength;
      const directBindings = directTrace.bindings[0]!.length;
      const parentDirectSqlBytes = new TextEncoder().encode(
        parentDirectQuery.sql,
      ).byteLength;
      const parentDirectBindings = parentDirectQuery.bindings.length;
      expect(directSqlBytes).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
      expect(directBindings).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
      budgetRows.unshift({
        profile: "direct-40-payload",
        parentSqlBytes: parentDirectSqlBytes,
        parentSqlSha256: createHash("sha256")
          .update(parentDirectQuery.sql)
          .digest("hex"),
        parentBindings: parentDirectBindings,
        logicalSqlBytes: directSqlBytes,
        logicalSqlSha256: createHash("sha256")
          .update(directTrace.preparedSql[0]!)
          .digest("hex"),
        logicalBindings: directBindings,
        statements: directTrace.preparedSql.length,
      });
      console.info("wave67_journey_event_page_budget", budgetRows);
    } finally {
      db.exec("ROLLBACK TO wave67_journey_page_budget");
      db.exec("RELEASE wave67_journey_page_budget");
    }
  });

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
    const targets = [
      { type: "visitor", value: TARGET_VISITOR },
      { type: "session", value: TARGET_SESSION },
    ] as const;
    for (const target of targets) {
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
        expect(
          rowBag(actual),
          `${target.type}:${String(window !== undefined)}`,
        ).toEqual(rowBag(expected));
      }
    }

    const windowRows = (
      await createD1DatabaseClient(createSqliteD1Database(db)).all(
        compileTypedObservationQuery(
          SITE_A,
          { type: "visitor", value: TARGET_VISITOR },
          "detail-source",
          WINDOW,
        ),
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

  it("matches complete production Visitor and Session DTOs to legacy source SQL", async () => {
    for (const window of [undefined, WINDOW]) {
      const typedVisitor = await queryVisitorDetailFromD1(
        testEnv(db),
        SITE_A,
        TARGET_VISITOR,
        "UTC",
        window,
      );
      const legacyVisitor = await queryVisitorDetailFromD1(
        legacySourceEnv(
          db,
          legacyDetailSourceQuery(
            SITE_A,
            { type: "visitor", value: TARGET_VISITOR },
            window,
          ),
        ),
        SITE_A,
        TARGET_VISITOR,
        "UTC",
        window,
      );
      expect(typedVisitor).toEqual(legacyVisitor);

      const typedSession = await querySessionDetailFromD1(
        testEnv(db),
        SITE_A,
        TARGET_SESSION,
        window,
      );
      const legacySession = await querySessionDetailFromD1(
        legacySourceEnv(
          db,
          legacyDetailSourceQuery(
            SITE_A,
            { type: "session", value: TARGET_SESSION },
            window,
          ),
        ),
        SITE_A,
        TARGET_SESSION,
        window,
      );
      expect(typedSession).toEqual(legacySession);
    }

    const visitor = await queryVisitorDetailFromD1(
      testEnv(db),
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
      physicalPlanHash: expect.stringMatching(/^v8:/u),
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
      physicalPlanHash: expect.stringMatching(/^v8:/u),
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

  it("keeps identity and owner-window reads selective with deep history and fan-out", async () => {
    const historicalPages = 512;
    const eventsPerHistoricalPage = 4;
    for (let pageIndex = 0; pageIndex < historicalPages; pageIndex += 1) {
      const visitId = `history-${pageIndex}`;
      insertVisit(db, siteA, {
        visitId,
        visitorId: TARGET_VISITOR,
        sessionId: TARGET_SESSION,
        startedAt: -10_000 - pageIndex,
      });
      for (
        let eventIndex = 0;
        eventIndex < eventsPerHistoricalPage;
        eventIndex += 1
      )
        insertEvent(db, {
          eventId: `${visitId}-event-${eventIndex}`,
          site: siteA,
          visitId,
          eventNameId: siteA.purchaseNameId,
          occurredAt: 150 + eventIndex,
        });
    }
    db.exec("ANALYZE");

    const targets = [
      { type: "visitor", value: TARGET_VISITOR },
      { type: "session", value: TARGET_SESSION },
    ] as const;
    for (const target of targets) {
      const indexName =
        target.type === "visitor"
          ? "idx_visits_site_pk_visitor_started_at"
          : "idx_visits_site_pk_session_started_at";
      const identityColumn =
        target.type === "visitor" ? "visitor_id" : "session_id";
      const identityPages = Number(
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM visits WHERE site_pk = ? AND ${identityColumn} = ?`,
          )
          .get(siteA.sitePk, target.value)?.count,
      );
      const identityEvents = Number(
        db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM custom_events AS events
             INNER JOIN visits AS owner
               ON owner.site_pk = events.site_pk
              AND owner.visit_id = events.visit_id
             WHERE events.site_pk = ? AND owner.${identityColumn} = ?`,
          )
          .get(siteA.sitePk, target.value)?.count,
      );
      const windowPages = Number(
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM visits
             WHERE site_pk = ? AND ${identityColumn} = ?
               AND started_at >= ? AND started_at < ?`,
          )
          .get(
            siteA.sitePk,
            target.value,
            WINDOW.startMs,
            WINDOW.endExclusiveMs,
          )?.count,
      );
      const windowEvents = Number(
        db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM custom_events AS events
             INNER JOIN visits AS owner
               ON owner.site_pk = events.site_pk
              AND owner.visit_id = events.visit_id
             WHERE events.site_pk = ? AND owner.${identityColumn} = ?
               AND owner.started_at >= ? AND owner.started_at < ?`,
          )
          .get(
            siteA.sitePk,
            target.value,
            WINDOW.startMs,
            WINDOW.endExclusiveMs,
          )?.count,
      );
      expect(identityPages).toBe(516);
      expect(identityEvents).toBe(2_054);
      expect(windowPages).toBe(1);
      expect(windowEvents).toBe(4);

      const client = createD1DatabaseClient(createSqliteD1Database(db));
      const timeline = compileTypedObservationQuery(SITE_A, target, "timeline");
      const legacyTimeline = legacyTimelineQuery(SITE_A, target);
      const timelineRows = (await client.all(timeline)).results as Record<
        string,
        unknown
      >[];
      expect(timelineRows.map(mapJourneyEventRow)).toEqual(
        legacyTimelineRows(db, SITE_A, target).map(mapJourneyEventRow),
      );
      expect(timelineRows).toHaveLength(2_569);
      const timelineExplain = explainQueryPlan(db, {
        sql: timeline.sql,
        bindings: timeline.bindings as readonly SQLInputValue[],
      });
      const legacyTimelineExplain = explainQueryPlan(db, legacyTimeline);
      for (const explain of [timelineExplain, legacyTimelineExplain]) {
        const pageSearches = explain.filter((line) => line.includes(indexName));
        expect(pageSearches).toHaveLength(2);
        for (const search of pageSearches)
          expect(search).toContain(`site_pk=? AND ${identityColumn}=?`);
        expect(
          explain.find((line) =>
            line.includes("idx_custom_events_site_pk_visit_time"),
          ),
        ).toContain("site_pk=? AND visit_id=?");
      }
      for (const statement of [
        { sql: timeline.sql, bindings: timeline.bindings ?? [] },
        legacyTimeline,
      ]) {
        expect(
          new TextEncoder().encode(statement.sql).byteLength,
        ).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
        expect(statement.bindings.length).toBeLessThanOrEqual(
          D1_MAX_BOUND_PARAMETERS,
        );
      }

      for (const window of [undefined, WINDOW]) {
        const typedQuery = compileTypedObservationQuery(
          SITE_A,
          target,
          "detail-source",
          window,
        );
        const legacyQuery = legacyDetailSourceQuery(SITE_A, target, window);
        const typedRows = (await client.all(typedQuery)).results as Record<
          string,
          unknown
        >[];
        expect(rowBag(typedRows)).toEqual(
          rowBag(legacyDetailSourceRows(db, SITE_A, target, window)),
        );
        expect(
          typedRows.filter((row) => row.sourceType === "visit"),
        ).toHaveLength(window ? 1 : 516);
        expect(
          typedRows.filter((row) => row.sourceType === "custom"),
        ).toHaveLength(window ? 3 : 2_053);

        const detailExplain = explainQueryPlan(db, {
          sql: typedQuery.sql,
          bindings: typedQuery.bindings as readonly SQLInputValue[],
        });
        const legacyDetailExplain = explainQueryPlan(db, legacyQuery);
        const pageSearches = detailExplain.filter((line) =>
          line.includes(indexName),
        );
        const legacyPageSearches = legacyDetailExplain.filter((line) =>
          line.includes(indexName),
        );
        expect(pageSearches).toHaveLength(2);
        expect(legacyPageSearches).toHaveLength(1);
        for (const search of pageSearches) {
          expect(search).toContain(`site_pk=? AND ${identityColumn}=?`);
          if (window) expect(search).toContain("started_at>? AND started_at<?");
          else expect(search).not.toContain("AND started_at>");
        }
        const eventSearch = detailExplain.find((line) =>
          line.includes("idx_custom_events_site_pk_visit_time"),
        );
        expect(eventSearch).toContain("site_pk=? AND visit_id=?");
        expect(
          detailExplain.findIndex((line) =>
            line.includes("idx_custom_events_site_pk_visit_time"),
          ),
        ).toBeGreaterThan(
          Math.max(
            ...pageSearches.map((search) => detailExplain.indexOf(search)),
          ),
        );

        for (const statement of [
          { sql: typedQuery.sql, bindings: typedQuery.bindings ?? [] },
          legacyQuery,
        ]) {
          expect(
            new TextEncoder().encode(statement.sql).byteLength,
          ).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
          expect(statement.bindings.length).toBeLessThanOrEqual(
            D1_MAX_BOUND_PARAMETERS,
          );
        }
      }
    }
  });
});
