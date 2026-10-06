import { createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { afterAll, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { compileD1Query, lowerLogicalPlan } from "@/lib/db";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import {
  buildJourneySessionDetailPlan,
  buildJourneyVisitorDetailPlan,
} from "@/lib/edge/analytics/engine/journey-entity-detail-plan";
import { AnalyticsLogicalToDbLowerer } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";
import {
  buildDetailCustomEventSourceCte,
  buildTargetVisitSourceCte,
  detailCustomEventSourceBindings,
  targetVisitSourceBindings,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  buildSessionAggregationSql,
  buildVisitorAggregationSql,
} from "@/lib/edge/analytics/providers/d1/internal/journey-aggregation-sql";
import {
  querySessionsForDetailFromD1,
  queryVisitorForDetailFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/journey-detail-queries";
import { queryJourneyEntityDetailRowsFromD1 } from "@/lib/edge/analytics/providers/d1/internal/journey-entity-detail-query";
import {
  mapSessionRow,
  mapVisitorRow,
} from "@/lib/edge/analytics/providers/d1/internal/journey-helpers";
import type { Env } from "@/lib/edge/types";

interface FixtureSite {
  readonly id: string;
  readonly pk: number;
}

interface VisitFixture {
  readonly visitId: string | null;
  readonly visitorId: string;
  readonly sessionId: string;
  readonly startedAt: number;
  readonly lastActivityAt?: number;
  readonly endedAt?: number | null;
  readonly durationMs?: number | null;
  readonly status?: string;
  readonly pathname?: string;
  readonly userId?: string | null;
  readonly userName?: string | null;
  readonly country?: string;
  readonly region?: string;
  readonly regionCode?: string;
  readonly city?: string;
  readonly referrerHost?: string;
  readonly referrerUrl?: string;
  readonly browser?: string;
  readonly browserVersion?: string;
  readonly os?: string;
  readonly osVersion?: string;
  readonly deviceType?: string;
  readonly screenWidth?: number | null;
  readonly screenHeight?: number | null;
  readonly latitude?: number | null;
  readonly longitude?: number | null;
}

type LegacyReportRow = Record<string, unknown>;
type JourneyDetailPlan = ReturnType<typeof buildJourneyVisitorDetailPlan>;
type PhysicalPlanShape = Extract<
  NonNullable<ReturnType<typeof compileD1Query>["physicalPlanShape"]>,
  { readonly version: 4 }
>;

const databases = new Set<DatabaseSync>();
const SITE_A = "journey-detail-site-a";
const SITE_B = "journey-detail-site-b";
const TARGET_VISITOR = "visitor-main";
const SHARED_SESSION = "session-shared";
const UNRELATED_FIXTURE_ROWS = 1_024;

interface ExplainQueryPlanRow {
  readonly detail: string;
}

interface DetailQueryEvidence {
  readonly statementCount: number;
  readonly sqlBytes: number;
  readonly bindingCount: number;
  readonly sqlSha256: string;
  readonly physicalPlanHash?: string;
  readonly physicalPlanShape?: PhysicalPlanShape;
  readonly explainDetails: readonly string[];
  readonly rawTableScanDetails: readonly string[];
  readonly intermediateRelationScanCount: number;
}

function createFixture(): DatabaseSync {
  const database = createMigratedDatabase();
  databases.add(database);
  if (
    (database.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number })
      .foreign_keys !== 0
  ) {
    database.exec("PRAGMA foreign_keys = OFF");
  }
  return database;
}

function addSite(database: DatabaseSync, siteId: string): FixtureSite {
  database
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .run(siteId);
  const row = database
    .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
    .get(siteId) as { readonly site_pk: number };
  return { id: siteId, pk: row.site_pk };
}

function addVisit(
  database: DatabaseSync,
  site: FixtureSite,
  visit: VisitFixture,
): void {
  const columns = [
    "visit_id",
    "site_id",
    "visitor_id",
    "session_id",
    "status",
    "started_at",
    "last_activity_at",
    "ended_at",
    "duration_ms",
    "pathname",
    "hostname",
    "user_id",
    "user_name",
    "country",
    "region",
    "region_code",
    "city",
    "referrer_host",
    "referrer_url",
    "browser",
    "browser_version",
    "os",
    "os_version",
    "device_type",
    "screen_width",
    "screen_height",
    "latitude",
    "longitude",
    "site_pk",
  ];
  const values: SQLInputValue[] = [
    visit.visitId,
    site.id,
    visit.visitorId,
    visit.sessionId,
    visit.status ?? "closed",
    visit.startedAt,
    visit.lastActivityAt ?? visit.startedAt,
    visit.endedAt ?? null,
    visit.durationMs ?? null,
    visit.pathname ?? `/${visit.visitId}`,
    "journey-detail.fixture",
    visit.userId ?? null,
    visit.userName ?? null,
    visit.country ?? "",
    visit.region ?? "",
    visit.regionCode ?? "",
    visit.city ?? "",
    visit.referrerHost ?? "",
    visit.referrerUrl ?? "",
    visit.browser ?? "",
    visit.browserVersion ?? "",
    visit.os ?? "",
    visit.osVersion ?? "",
    visit.deviceType ?? "",
    visit.screenWidth ?? null,
    visit.screenHeight ?? null,
    visit.latitude ?? null,
    visit.longitude ?? null,
    site.pk,
  ];
  database
    .prepare(
      `INSERT INTO visits (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    )
    .run(...values);
}

function addEventName(
  database: DatabaseSync,
  site: FixtureSite,
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
  site: FixtureSite,
  input: {
    readonly eventId: string;
    readonly visitId: string;
    readonly eventNameId: number;
    readonly occurredAt: number;
    readonly eventSitePk?: number;
  },
): void {
  database
    .prepare(
      "INSERT INTO custom_events (event_id, site_id, visit_id, event_name_id, occurred_at, received_at, node_count, value_count, site_pk) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)",
    )
    .run(
      input.eventId,
      site.id,
      input.visitId,
      input.eventNameId,
      input.occurredAt,
      input.occurredAt,
      input.eventSitePk ?? site.pk,
    );
}

function seedDetailFixture(database: DatabaseSync): {
  readonly siteA: FixtureSite;
  readonly siteB: FixtureSite;
} {
  const siteA = addSite(database, SITE_A);
  const siteB = addSite(database, SITE_B);
  addEventName(database, siteA, 41, "signup");
  addEventName(database, siteB, 42, "foreign-site-dictionary");

  addVisit(database, siteA, {
    visitId: "visit-a",
    visitorId: TARGET_VISITOR,
    sessionId: SHARED_SESSION,
    startedAt: 100,
    lastActivityAt: 160,
    endedAt: 140,
    durationMs: -30,
    pathname: "/a-entry",
    userId: "alpha-user",
    userName: "Alpha",
    country: "A-first",
    region: "region-a",
    referrerHost: "first.example",
    referrerUrl: "https://first.example/ref",
    browser: "Browser-A",
    browserVersion: "1.0",
    os: "OS-A",
    deviceType: "desktop",
    latitude: 95,
    longitude: 20,
  });
  addVisit(database, siteA, {
    visitId: null,
    visitorId: TARGET_VISITOR,
    sessionId: SHARED_SESSION,
    startedAt: 100,
    lastActivityAt: 170,
    durationMs: 0,
    pathname: "/null-id-entry",
    userId: "null-page-id-user",
    userName: "Null page id",
    country: "Null-id first",
    referrerHost: "null-id-first.example",
    referrerUrl: "https://null-id-first.example/ref",
    browser: "Browser-null-id",
    latitude: null,
    longitude: null,
  });
  addVisit(database, siteA, {
    visitId: "visit-b",
    visitorId: TARGET_VISITOR,
    sessionId: SHARED_SESSION,
    startedAt: 100,
    lastActivityAt: 150,
    endedAt: 200,
    durationMs: 5,
    status: "OPEN",
    pathname: "/b-middle",
    userId: "beta-user",
    userName: "Beta",
    country: "B-middle",
    referrerHost: "middle.example",
    browser: "Browser-B",
    browserVersion: "2.0",
    latitude: 40,
    longitude: 70,
  });
  addVisit(database, siteA, {
    visitId: "visit-c",
    visitorId: TARGET_VISITOR,
    sessionId: SHARED_SESSION,
    startedAt: 100,
    lastActivityAt: 180,
    durationMs: 10,
    pathname: "/c-exit",
    userId: "charlie-user",
    userName: "Charlie",
    country: "C-last",
    referrerHost: "last.example",
    browser: "Browser-C",
    browserVersion: "3.0",
    latitude: 35,
    longitude: 80,
  });
  addVisit(database, siteA, {
    visitId: "visit-other-same-session",
    visitorId: "visitor-other",
    sessionId: SHARED_SESSION,
    startedAt: 120,
    lastActivityAt: 180,
    durationMs: 2,
    pathname: "/other-visitor",
    userId: "other-user",
    country: "Other",
    latitude: 30,
    longitude: 50,
  });
  addVisit(database, siteA, {
    visitId: "visit-z",
    visitorId: TARGET_VISITOR,
    sessionId: "session-z",
    startedAt: 300,
    lastActivityAt: 350,
    durationMs: -4,
    status: "ＯＰＥＮ",
    pathname: "/z-latest",
    userId: "\t",
    userName: "Tab is nonblank under ASCII-space trim",
    country: "Z-country",
    browser: "Browser-Z",
    latitude: 91,
    longitude: 181,
  });
  addVisit(database, siteA, {
    visitId: "visit-alpha-session",
    visitorId: TARGET_VISITOR,
    sessionId: "session-alpha",
    startedAt: 300,
    lastActivityAt: 330,
    durationMs: null,
    status: " OPEN ",
    pathname: "/alpha-session",
    userId: "\u00a0",
    userName: "NBSP is nonblank under ASCII-space trim",
    country: "Alpha-session",
    screenWidth: 1_440,
    screenHeight: 900,
    latitude: 42,
    longitude: null,
  });
  addVisit(database, siteA, {
    visitId: "visit-space-session",
    visitorId: TARGET_VISITOR,
    sessionId: " ",
    startedAt: 350,
    lastActivityAt: 360,
    durationMs: 10,
    status: "OpEn",
    pathname: "/space-session",
    userId: "  ",
    country: "Space-session",
    latitude: -45,
    longitude: -120,
  });
  addVisit(database, siteA, {
    visitId: "visit-empty-session",
    visitorId: TARGET_VISITOR,
    sessionId: "",
    startedAt: 400,
    lastActivityAt: 430,
    durationMs: 1,
    pathname: "/empty-session",
    userId: "latest-user",
    userName: "Latest user",
    country: "Empty-session latest page",
    browser: "Browser-latest",
  });
  addVisit(database, siteA, {
    visitId: "visit-empty-visitor",
    visitorId: "",
    sessionId: "empty-visitor-session",
    startedAt: 500,
    pathname: "/empty-visitor",
  });
  addVisit(database, siteA, {
    visitId: "visit-space-visitor",
    visitorId: " ",
    sessionId: "space-visitor-session",
    startedAt: 520,
    pathname: "/space-visitor",
    userId: "space-visitor-user",
  });
  addVisit(database, siteA, {
    visitId: "visit-identity-spaces",
    visitorId: "visitor-identities",
    sessionId: "identity-session",
    startedAt: 300,
    pathname: "/identity-spaces",
    userId: "   ",
    userName: "ASCII spaces only",
  });
  addVisit(database, siteA, {
    visitId: "visit-identity-tab",
    visitorId: "visitor-identities",
    sessionId: "identity-session",
    startedAt: 100,
    pathname: "/identity-tab",
    userId: "\t",
    userName: "ASCII tab",
  });
  addVisit(database, siteA, {
    visitId: "visit-identity-nbsp",
    visitorId: "visitor-identities",
    sessionId: "identity-session",
    startedAt: 200,
    pathname: "/identity-nbsp",
    userId: "\u00a0",
    userName: "NBSP",
  });
  addVisit(database, siteB, {
    visitId: "visit-site-b-same-visitor",
    visitorId: TARGET_VISITOR,
    sessionId: SHARED_SESSION,
    startedAt: 600,
    pathname: "/other-site",
  });

  addEvent(database, siteA, {
    eventId: "event-a-before-page-time",
    visitId: "visit-a",
    eventNameId: 41,
    occurredAt: -1_000,
  });
  addEvent(database, siteA, {
    eventId: "event-a-foreign-dictionary-id",
    visitId: "visit-a",
    eventNameId: 42,
    occurredAt: 1_000_000,
  });
  addEvent(database, siteA, {
    eventId: "event-b",
    visitId: "visit-b",
    eventNameId: 41,
    occurredAt: 900_000,
  });
  addEvent(database, siteA, {
    eventId: "event-same-session-other-visitor",
    visitId: "visit-other-same-session",
    eventNameId: 41,
    occurredAt: 120,
  });
  addEvent(database, siteA, {
    eventId: "event-empty-session",
    visitId: "visit-empty-session",
    eventNameId: 41,
    occurredAt: 500,
  });
  addEvent(database, siteA, {
    eventId: "event-missing-name",
    visitId: "visit-a",
    eventNameId: 99_999,
    occurredAt: 150,
  });
  addEvent(database, siteA, {
    eventId: "event-orphan-owner",
    visitId: "missing-visit",
    eventNameId: 41,
    occurredAt: 150,
  });
  addEvent(database, siteA, {
    eventId: "event-cross-site-owner",
    visitId: "visit-site-b-same-visitor",
    eventNameId: 41,
    occurredAt: 150,
  });
  addEvent(database, siteB, {
    eventId: "event-other-site",
    visitId: "visit-site-b-same-visitor",
    eventNameId: 42,
    occurredAt: 700,
  });

  for (let index = 0; index < UNRELATED_FIXTURE_ROWS; index += 1) {
    const visitId = `unrelated-visit-${index}`;
    const startedAt = 10_000 + index;
    addVisit(database, siteA, {
      visitId,
      visitorId: `unrelated-visitor-${index}`,
      sessionId: `unrelated-session-${index}`,
      startedAt,
      pathname: `/unrelated/${index}`,
    });
    addEvent(database, siteA, {
      eventId: `unrelated-event-${index}`,
      visitId,
      eventNameId: 41,
      occurredAt: startedAt + 1,
    });
  }
  return { siteA, siteB };
}

function collectQueryEvidence(
  database: DatabaseSync,
  sql: string,
  bindings: readonly SQLInputValue[],
  statementCount: number,
  physicalPlanShape?: PhysicalPlanShape,
): DetailQueryEvidence {
  const explainDetails = (
    database
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...bindings) as unknown as ExplainQueryPlanRow[]
  ).map((row) => row.detail);
  const physicalPlanPayload = physicalPlanShape
    ? JSON.stringify([
        "d1-query-shape-v4",
        sql,
        physicalPlanShape.cteCount,
        physicalPlanShape.directScanProjectionCount,
        physicalPlanShape.nativeMembershipCount,
        physicalPlanShape.jsonMembershipCount,
        physicalPlanShape.nativeRowRelationCount,
        physicalPlanShape.jsonRowRelationCount,
        physicalPlanShape.rightAnchorJoinOrderCount,
        physicalPlanShape.uniqueLookupJoinOrderCount,
        physicalPlanShape.parameterStrategy ?? null,
        physicalPlanShape.parameterOccurrenceCount ?? null,
        physicalPlanShape.parameterSlotCount ?? null,
      ])
    : undefined;
  return {
    statementCount,
    sqlBytes: Buffer.byteLength(sql, "utf8"),
    bindingCount: bindings.length,
    sqlSha256: createHash("sha256").update(sql, "utf8").digest("hex"),
    ...(physicalPlanShape
      ? {
          physicalPlanShape,
          physicalPlanHash: `v4:${createHash("sha256").update(physicalPlanPayload!, "utf8").digest("hex")}`,
        }
      : {}),
    explainDetails,
    rawTableScanDetails: explainDetails.filter((detail) =>
      /^SCAN (?:t\d+|visits|custom_events)\b/u.test(detail),
    ),
    intermediateRelationScanCount: explainDetails.filter((detail) =>
      /^SCAN (?:q\d+|\(subquery-\d+\))/u.test(detail),
    ).length,
  };
}

function compileJourneyDetailQuery(plan: JourneyDetailPlan, outputId: string) {
  const output = plan.outputs.find((candidate) => candidate.id === outputId);
  if (!output) throw new Error(`missing journey detail output: ${outputId}`);
  const siteIds = plan.context.subject.siteIds;
  const lowerer = new AnalyticsLogicalToDbLowerer(
    plan,
    siteIds.length === 1
      ? { siteId: siteIds[0]!, time: plan.context.time }
      : { siteIds, time: plan.context.time },
  );
  const lowered = lowerer.lower(output);
  const relation = lowerer.projectOutput(
    lowered,
    output.fields.map((field) => ({ name: field.name, slot: field.slot })),
  );
  return compileD1Query(lowerLogicalPlan(relation));
}

function assertDetailQueryEvidence(
  database: DatabaseSync,
  trace: SqliteD1Trace,
  plan: JourneyDetailPlan,
  outputId: string,
  label: string,
  targetIndexes: readonly string[],
  legacyTargetIndex: string,
  legacyEvidence: DetailQueryEvidence,
): void {
  const sql = trace.preparedSql[0];
  const bindings = trace.bindings[0];
  expect(trace.preparedSql).toHaveLength(1);
  expect(trace.bindings).toHaveLength(1);
  expect(sql).toBeDefined();
  expect(bindings).toBeDefined();

  const typedQuery = compileJourneyDetailQuery(plan, outputId);
  expect(typedQuery.sql).toBe(sql);
  expect(typedQuery.bindings).toEqual(bindings);
  expect(typedQuery.physicalPlanShape?.version).toBe(4);
  const typedShape =
    typedQuery.physicalPlanShape?.version === 4
      ? typedQuery.physicalPlanShape
      : undefined;
  const evidence = collectQueryEvidence(
    database,
    sql!,
    bindings!,
    trace.preparedSql.length,
    typedShape,
  );
  const failureContext = `${label} legacy/typed SQL comparison: ${JSON.stringify({ legacy: legacyEvidence, typed: evidence })}`;
  const explainText = evidence.explainDetails.join("\n");

  expect(evidence.statementCount, failureContext).toBe(1);
  expect(evidence.sqlBytes, failureContext).toBeLessThanOrEqual(100_000);
  expect(evidence.bindingCount, failureContext).toBeLessThanOrEqual(100);
  expect(evidence.sqlSha256, failureContext).toMatch(/^[a-f0-9]{64}$/u);
  expect(evidence.physicalPlanHash, failureContext).toMatch(
    /^v4:[a-f0-9]{64}$/u,
  );
  expect(evidence.physicalPlanShape?.rightAnchorJoinOrderCount).toBe(1);
  expect(evidence.physicalPlanShape?.uniqueLookupJoinOrderCount).toBe(1);
  expect(legacyEvidence.statementCount, failureContext).toBe(1);
  expect(legacyEvidence.sqlSha256, failureContext).toMatch(/^[a-f0-9]{64}$/u);
  expect(legacyEvidence.explainDetails.join("\n"), failureContext).toContain(
    legacyTargetIndex,
  );
  expect(explainText, failureContext).toMatch(
    /SEARCH \w+ USING COVERING INDEX sqlite_autoindex_site_identities_1 \(site_id=\?\)/u,
  );
  for (const targetIndex of targetIndexes) {
    expect(explainText, failureContext).toContain(targetIndex);
    expect(
      explainText.split("\n").find((detail) => detail.includes(targetIndex)),
      failureContext,
    ).toMatch(/\(site_pk=\?/u);
  }
  expect(explainText, failureContext).toMatch(
    /SEARCH \w+ USING INDEX idx_custom_events_site_pk_visit_time \(site_pk=\? AND visit_id=\?\)/u,
  );
  expect(explainText, failureContext).toMatch(
    /SEARCH \w+ USING INTEGER PRIMARY KEY \(rowid=\?\)/u,
  );
  expect(evidence.rawTableScanDetails, failureContext).toEqual([]);
}

function legacyVisitorSql(): string {
  return `
WITH
${buildTargetVisitSourceCte("visitor_id")},
filtered_visits AS (
  SELECT visit_source.*, 1 AS is_visit_observation
  FROM visit_source
),
${buildDetailCustomEventSourceCte()},
${buildVisitorAggregationSql({
  orderBy: "lastSeenAt DESC, visitorId ASC",
  limitOffset: "LIMIT 1",
})}`;
}

function legacySessionSql(targetColumn: "visitor_id" | "session_id"): string {
  return `
WITH
${buildTargetVisitSourceCte(targetColumn)},
filtered_visits AS (
  SELECT visit_source.*, 1 AS is_visit_observation
  FROM visit_source
),
${buildDetailCustomEventSourceCte()},
${buildSessionAggregationSql({
  orderBy: "startedAt DESC, sessionId ASC",
})}`;
}

function collectLegacyVisitorEvidence(
  database: DatabaseSync,
  siteId: string,
  visitorId: string,
): DetailQueryEvidence {
  const sql = legacyVisitorSql();
  const bindings = [
    ...targetVisitSourceBindings(siteId, visitorId),
    ...detailCustomEventSourceBindings(siteId),
  ];
  return collectQueryEvidence(database, sql, bindings, 1);
}

function collectLegacySessionEvidence(
  database: DatabaseSync,
  siteId: string,
  target: { readonly type: "visitor" | "session"; readonly value: string },
): DetailQueryEvidence {
  const targetColumn = target.type === "visitor" ? "visitor_id" : "session_id";
  const sql = legacySessionSql(targetColumn);
  const bindings = [
    ...targetVisitSourceBindings(siteId, target.value),
    ...detailCustomEventSourceBindings(siteId),
  ];
  return collectQueryEvidence(database, sql, bindings, 1);
}

function legacyVisitorRows(
  database: DatabaseSync,
  siteId: string,
  visitorId: string,
): LegacyReportRow[] {
  return database
    .prepare(legacyVisitorSql())
    .all(
      ...targetVisitSourceBindings(siteId, visitorId),
      ...detailCustomEventSourceBindings(siteId),
    ) as LegacyReportRow[];
}

function legacySessionRows(
  database: DatabaseSync,
  siteId: string,
  target: { readonly type: "visitor" | "session"; readonly value: string },
): LegacyReportRow[] {
  const targetColumn = target.type === "visitor" ? "visitor_id" : "session_id";
  return database
    .prepare(legacySessionSql(targetColumn))
    .all(
      ...targetVisitSourceBindings(siteId, target.value),
      ...detailCustomEventSourceBindings(siteId),
    ) as LegacyReportRow[];
}

function sqliteEnv(database: DatabaseSync, trace: SqliteD1Trace): Env {
  return { DB: createSqliteD1Database(database, trace) } as unknown as Env;
}

async function actualVisitorRows(
  database: DatabaseSync,
  siteId: string,
  visitorId: string,
): Promise<{
  readonly rows: LegacyReportRow[];
  readonly trace: SqliteD1Trace;
  readonly plan: JourneyDetailPlan;
}> {
  const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
  const plan = buildJourneyVisitorDetailPlan({ siteId, visitorId });
  const rows = await queryJourneyEntityDetailRowsFromD1(
    sqliteEnv(database, trace),
    plan,
    "journey-visitor-detail",
  );
  return { rows: rows as LegacyReportRow[], trace, plan };
}

async function actualSessionRows(
  database: DatabaseSync,
  siteId: string,
  target: { readonly type: "visitor" | "session"; readonly value: string },
): Promise<{
  readonly rows: LegacyReportRow[];
  readonly trace: SqliteD1Trace;
  readonly plan: JourneyDetailPlan;
}> {
  const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
  const plan = buildJourneySessionDetailPlan({ siteId, target });
  const rows = await queryJourneyEntityDetailRowsFromD1(
    sqliteEnv(database, trace),
    plan,
    "journey-session-detail",
  );
  return { rows: rows as LegacyReportRow[], trace, plan };
}

async function actualVisitorDto(
  database: DatabaseSync,
  siteId: string,
  visitorId: string,
) {
  const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
  const row = await queryVisitorForDetailFromD1(
    sqliteEnv(database, trace),
    siteId,
    visitorId,
  );
  return { row, trace };
}

async function actualSessionDtos(
  database: DatabaseSync,
  siteId: string,
  target: { readonly type: "visitor" | "session"; readonly value: string },
) {
  const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
  const rows = await querySessionsForDetailFromD1(
    sqliteEnv(database, trace),
    siteId,
    target,
  );
  return { rows, trace };
}

afterAll(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("journey entity detail report differential", () => {
  it("matches all legacy visitor raw fields and DTOs while scoping Pages and ID-only Events", async () => {
    const database = createFixture();
    const { siteA, siteB } = seedDetailFixture(database);

    const legacyEvidence = collectLegacyVisitorEvidence(
      database,
      siteA.id,
      TARGET_VISITOR,
    );
    const expected = legacyVisitorRows(database, siteA.id, TARGET_VISITOR);
    expect(expected[0]).toMatchObject({
      visitorId: TARGET_VISITOR,
      sessionId: "",
      userId: "latest-user",
      firstSeenAt: 100,
      lastSeenAt: 400,
      views: 8,
      sessions: 4,
      events: 4,
      referrerHost: "null-id-first.example",
      referrerUrl: "https://null-id-first.example/ref",
      country: "Empty-session latest page",
      browser: "Browser-latest",
    });

    const raw = await actualVisitorRows(database, siteA.id, TARGET_VISITOR);
    expect(raw.rows).toEqual(expected);
    expect(raw.rows).toHaveLength(1);
    expect(raw.trace.preparedSql).toHaveLength(1);
    expect(raw.trace.bindings).toHaveLength(1);
    assertDetailQueryEvidence(
      database,
      raw.trace,
      raw.plan,
      "journey-visitor-detail",
      "visitor",
      ["idx_visits_site_pk_visitor_started_at"],
      "idx_visits_site_pk_visitor_started_at",
      legacyEvidence,
    );

    const dto = await actualVisitorDto(database, siteA.id, TARGET_VISITOR);
    expect(dto.row).toEqual(mapVisitorRow(expected[0]!));
    expect(dto.trace.preparedSql).toHaveLength(1);
    expect(dto.trace.bindings).toHaveLength(1);

    for (const visitorId of [
      "",
      " ",
      "visitor-identities",
      "visitor-does-not-exist",
    ] as const) {
      const expectedRows = legacyVisitorRows(database, siteA.id, visitorId);
      const actual = await actualVisitorRows(database, siteA.id, visitorId);
      expect(actual.rows).toEqual(expectedRows);
      const actualDto = await actualVisitorDto(database, siteA.id, visitorId);
      expect(actualDto.row).toEqual(
        expectedRows[0] ? mapVisitorRow(expectedRows[0]) : null,
      );
      if (visitorId === "") {
        expect(expectedRows).toEqual([]);
        expect(actualDto.row).toBeNull();
      } else if (visitorId === " ") {
        expect(expectedRows).toHaveLength(1);
        expect(expectedRows[0]).toMatchObject({ visitorId: " " });
      } else if (visitorId === "visitor-identities") {
        expect(expectedRows[0]).toMatchObject({
          visitorId: "visitor-identities",
          userId: "\u00a0",
          userName: "NBSP",
        });
      } else {
        expect(expectedRows).toEqual([]);
      }
    }

    for (const siteId of [siteB.id, "journey-detail-site-unknown"] as const) {
      const expectedAtSite = legacyVisitorRows(
        database,
        siteId,
        TARGET_VISITOR,
      );
      const rawAtSite = await actualVisitorRows(
        database,
        siteId,
        TARGET_VISITOR,
      );
      expect(rawAtSite.rows).toEqual(expectedAtSite);
      const dtoAtSite = await actualVisitorDto(
        database,
        siteId,
        TARGET_VISITOR,
      );
      expect(dtoAtSite.row).toEqual(
        expectedAtSite[0] ? mapVisitorRow(expectedAtSite[0]) : null,
      );
      if (siteId === siteB.id) {
        expect(expectedAtSite).toHaveLength(1);
        expect(expectedAtSite[0]).toMatchObject({
          visitorId: TARGET_VISITOR,
          views: 1,
          events: 1,
        });
      } else {
        expect(expectedAtSite).toEqual([]);
      }
    }
  });

  it("matches legacy Session raw fields and DTOs for Visitor/Session targets, ties, geo, status, and duration", async () => {
    const database = createFixture();
    const { siteA, siteB } = seedDetailFixture(database);
    const visitorTarget = { type: "visitor", value: TARGET_VISITOR } as const;
    const legacyEvidence = collectLegacySessionEvidence(
      database,
      siteA.id,
      visitorTarget,
    );
    const expected = legacySessionRows(database, siteA.id, visitorTarget);
    expect(expected.map((row) => row.sessionId)).toEqual([
      " ",
      "session-alpha",
      "session-z",
      SHARED_SESSION,
    ]);
    expect(expected.map((row) => row.sessionId)).not.toContain("");
    expect(
      expected.find((row) => row.sessionId === SHARED_SESSION),
    ).toMatchObject({
      visitorId: TARGET_VISITOR,
      views: 4,
      events: 3,
      totalDurationMs: -15,
      active: 1,
      bounce: 0,
      entryPath: "/null-id-entry",
      exitPath: "/c-exit",
      referrerHost: "null-id-first.example",
      latitude: 40,
      longitude: 70,
      browser: "Browser-null-id",
    });
    expect(expected.find((row) => row.sessionId === "session-z")).toMatchObject(
      {
        active: 0,
        views: 1,
        bounce: 1,
        totalDurationMs: -4,
        endedAt: 350,
        latitude: null,
        longitude: null,
      },
    );
    expect(
      expected.find((row) => row.sessionId === "session-alpha"),
    ).toMatchObject({
      active: 0,
      totalDurationMs: 0,
      latitude: null,
      longitude: null,
    });
    expect(expected.find((row) => row.sessionId === " ")).toMatchObject({
      sessionId: " ",
      active: 1,
      latitude: -45,
      longitude: -120,
    });

    const raw = await actualSessionRows(database, siteA.id, visitorTarget);
    expect(raw.rows).toEqual(expected);
    expect(raw.trace.preparedSql).toHaveLength(1);
    expect(raw.trace.bindings).toHaveLength(1);
    assertDetailQueryEvidence(
      database,
      raw.trace,
      raw.plan,
      "journey-session-detail",
      "session",
      ["idx_visits_site_pk_visitor_started_at"],
      "idx_visits_site_pk_session_started_at",
      legacyEvidence,
    );

    const dtos = await actualSessionDtos(database, siteA.id, visitorTarget);
    expect(dtos.rows).toEqual(expected.map(mapSessionRow));
    expect(dtos.trace.preparedSql).toHaveLength(1);
    expect(dtos.trace.bindings).toHaveLength(1);
    expect(
      dtos.rows.find((row) => row.sessionId === SHARED_SESSION)?.durationMs,
    ).toBe(0);
    expect(
      dtos.rows.find((row) => row.sessionId === "session-z")?.durationMs,
    ).toBe(0);

    for (const target of [
      { type: "session", value: SHARED_SESSION },
      { type: "visitor", value: "" },
      { type: "visitor", value: " " },
      { type: "session", value: "" },
      { type: "session", value: " " },
      { type: "visitor", value: "visitor-does-not-exist" },
      { type: "session", value: "session-does-not-exist" },
    ] as const) {
      const expectedTargetRows = legacySessionRows(database, siteA.id, target);
      const actual = await actualSessionRows(database, siteA.id, target);
      expect(actual.rows).toEqual(expectedTargetRows);
      const actualTargetDtos = await actualSessionDtos(
        database,
        siteA.id,
        target,
      );
      expect(actualTargetDtos.rows).toEqual(
        expectedTargetRows.map(mapSessionRow),
      );
      if (target.type === "session" && target.value === SHARED_SESSION) {
        expect(expectedTargetRows).toHaveLength(1);
        expect(expectedTargetRows[0]).toMatchObject({
          sessionId: SHARED_SESSION,
          views: 5,
          events: 4,
        });
        assertDetailQueryEvidence(
          database,
          actual.trace,
          actual.plan,
          "journey-session-detail",
          "session target",
          ["idx_visits_site_pk_session_started_at"],
          "idx_visits_site_pk_session_started_at",
          collectLegacySessionEvidence(database, siteA.id, target),
        );
      }
      if (target.type === "visitor" && target.value === "") {
        expect(expectedTargetRows).toHaveLength(1);
        expect(expectedTargetRows[0]).toMatchObject({
          sessionId: "empty-visitor-session",
          visitorId: "",
        });
      }
      if (target.type === "session" && target.value === "")
        expect(expectedTargetRows).toEqual([]);
      if (target.type === "session" && target.value === " ") {
        expect(expectedTargetRows).toHaveLength(1);
        expect(expectedTargetRows[0]?.sessionId).toBe(" ");
      }
    }

    for (const siteId of [siteB.id, "journey-detail-site-unknown"] as const) {
      const expectedAtSite = legacySessionRows(database, siteId, visitorTarget);
      const rawAtSite = await actualSessionRows(
        database,
        siteId,
        visitorTarget,
      );
      expect(rawAtSite.rows).toEqual(expectedAtSite);
      const dtosAtSite = await actualSessionDtos(
        database,
        siteId,
        visitorTarget,
      );
      expect(dtosAtSite.rows).toEqual(expectedAtSite.map(mapSessionRow));
      if (siteId === siteB.id) {
        expect(expectedAtSite).toHaveLength(1);
        expect(expectedAtSite[0]).toMatchObject({
          sessionId: SHARED_SESSION,
          visitorId: TARGET_VISITOR,
          views: 1,
          events: 1,
        });
      } else {
        expect(expectedAtSite).toEqual([]);
      }
    }
  });
});
