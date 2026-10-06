import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

import {
  compileD1Query,
  D1_MAX_BOUND_PARAMETERS,
  D1_MAX_SQL_UTF8_BYTES,
  lowerLogicalPlan,
} from "@/lib/db";
import { D1StatementBudgetError } from "@/lib/db/d1-budget";
import {
  attachScopedFilterMetadata,
  createQueryTime,
  EMPTY_FILTER_DOCUMENT,
  type FilterDocument,
  type FilterExpression,
  prepareScopedQuery,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import {
  buildJourneySessionListReportPlan,
  buildJourneyVisitorListReportPlan,
} from "@/lib/edge/analytics/engine/journey-entity-list-report-plan";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import { printLogicalPlan } from "@/lib/edge/analytics/engine/logical/printer";
import {
  handleSessionDetailContract as handleSessionDetail,
  handleSessionsContract as handleSessions,
  handleVisitorDetailContract as handleVisitorDetail,
  handleVisitorsContract as handleVisitors,
} from "@/lib/edge/analytics/interfaces/dashboard/protocol/journeys";
import {
  querySessionListPageFromD1 as querySessionListPageFromParentOracle,
  queryVisitorListPageFromD1 as queryVisitorListPageFromParentOracle,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/journey-list-parent-oracle";
import { AnalyticsLogicalToDbLowerer } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";
import type { QueryWindow } from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  buildSessionAggregationSql,
  buildVisitorAggregationSql,
} from "@/lib/edge/analytics/providers/d1/internal/journey-aggregation-sql";
import {
  querySessionListPageFromD1,
  querySessionsFromD1,
  queryVisitorListPageFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/journey-list-queries";
import {
  queryGeoPointAggregate,
  queryGeoPointsFromD1,
  queryJourneyEventDetailFromD1,
  queryJourneyEventsForDetailFromD1,
  queryJourneyEventsFromD1,
  querySessionDetailFromD1,
  querySessionLocationPointsFromD1,
  querySessionsForDetailFromD1,
  queryVisitorDetailFromD1,
  queryVisitorForDetailFromD1,
  queryVisitorsFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/journeys";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import type { CanonicalJsonPath } from "@/lib/filter-contract/filters";

import { filterFixture } from "./filter-fixtures";
type D1Row = Record<string, unknown>;
type QueryBinding = string | number | boolean | null;
interface QueryCall {
  sql: string;
  bindings: QueryBinding[];
}
const siteId = "site-journey";
const secondSiteId = "site-journey-secondary";
const baseMs = Date.UTC(2026, 0, 1);
function queryWindow(): QueryWindow {
  return {
    startMs: baseMs,
    endExclusiveMs: baseMs + 2 * 60 * 60 * 1000,
    nowMs: baseMs + 24 * 60 * 60 * 1000,
    timeZone: "UTC",
  };
}
function createD1Env(resultSets: D1Row[][]): {
  env: Env;
  calls: QueryCall[];
} {
  const calls: QueryCall[] = [];
  const pendingResults = [...resultSets];
  const prepare = vi.fn((sql: string) => ({
    bind: vi.fn((...bindings: QueryBinding[]) => ({
      all: vi.fn(async () => {
        calls.push({ sql, bindings });
        return { results: pendingResults.shift() ?? [] };
      }),
    })),
  }));

  return {
    env: {
      DB: { prepare } as unknown as D1Database,
      DAILY_SALT_SECRET: "test-secret",
      INGEST_DO: {} as DurableObjectNamespace,
    },
    calls,
  };
}
function createSqliteDetailEnv(
  options: {
    readonly completeLegacyEmptyEventSequenceProjection?: boolean;
    readonly siteIds?: readonly string[];
  } = {},
): {
  env: Env;
  calls: QueryCall[];
  database: DatabaseSync;
  close: () => void;
  explain: (call: QueryCall) => string[];
} {
  const executableSql = (sql: string) =>
    options.completeLegacyEmptyEventSequenceProjection
      ? sql
          .replace(
            "CAST(NULL AS INTEGER) AS occurred_at,\n    CAST(NULL AS TEXT) AS visitor_id",
            "CAST(NULL AS INTEGER) AS occurred_at,\n    CAST(NULL AS INTEGER) AS sequence,\n    CAST(NULL AS TEXT) AS visitor_id",
          )
          .replace(
            "ce.occurred_at,\n    v.visitor_id",
            "ce.occurred_at,\n    ce.sequence AS sequence,\n    v.visitor_id",
          )
      : sql;
  const runSqlite = (sql: string, bindings: readonly QueryBinding[]) => {
    const prepared = database.prepare(executableSql(sql));
    const sqliteBindings = bindings.map(
      (value) =>
        (typeof value === "boolean" ? Number(value) : value) as SQLInputValue,
    );
    if (!/\?\d+/u.test(sql)) return prepared.all(...sqliteBindings) as D1Row[];
    const named = Object.fromEntries(
      sqliteBindings.map((value, index) => [`?${index + 1}`, value]),
    );
    return prepared.all(named) as D1Row[];
  };
  const database = new DatabaseSync(":memory:");
  for (const migration of [
    "migrations/0008_rebuild_analytics.sql",
    "migrations/0013_add_visit_performance_metrics.sql",
    "migrations/0017_structured_custom_events.sql",
    "migrations/0019_add_user_identity.sql",
  ]) {
    database.exec(readFileSync(migration, "utf8"));
  }
  database.exec(`
    CREATE TABLE site_identities (
      site_pk INTEGER PRIMARY KEY,
      site_id TEXT NOT NULL UNIQUE
    );
    CREATE TABLE sites (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );

    ALTER TABLE visits ADD COLUMN site_pk INTEGER;
    ALTER TABLE custom_event_names ADD COLUMN site_pk INTEGER;
    ALTER TABLE custom_events ADD COLUMN site_pk INTEGER;
    ALTER TABLE custom_event_json_paths ADD COLUMN site_pk INTEGER;
    ALTER TABLE custom_event_json_values ADD COLUMN site_pk INTEGER;

    CREATE TRIGGER test_visits_site_pk
    AFTER INSERT ON visits
    BEGIN
      UPDATE visits
      SET site_pk = (
        SELECT site_pk FROM site_identities WHERE site_id = NEW.site_id
      )
      WHERE visit_id = NEW.visit_id;
    END;
    CREATE TRIGGER test_custom_event_names_site_pk
    AFTER INSERT ON custom_event_names
    BEGIN
      UPDATE custom_event_names
      SET site_pk = (
        SELECT site_pk FROM site_identities WHERE site_id = NEW.site_id
      )
      WHERE id = NEW.id;
    END;
    CREATE TRIGGER test_custom_events_site_pk
    AFTER INSERT ON custom_events
    BEGIN
      UPDATE custom_events
      SET site_pk = (
        SELECT site_pk FROM site_identities WHERE site_id = NEW.site_id
      )
      WHERE event_pk = NEW.event_pk;
    END;

    CREATE INDEX idx_visits_site_pk_visitor_started_at
      ON visits(site_pk, visitor_id, started_at);
    CREATE INDEX idx_visits_site_pk_session_started_at
      ON visits(site_pk, session_id, started_at);
    CREATE INDEX idx_custom_events_site_pk_visit_time
      ON custom_events(site_pk, visit_id, occurred_at, event_pk);
    CREATE INDEX idx_custom_event_json_paths_site_pk_path
      ON custom_event_json_paths(site_pk, path);
    CREATE INDEX idx_custom_event_values_site_pk_path_time
      ON custom_event_json_values(site_pk, path_id, occurred_at, event_pk);
  `);
  for (const [index, fixtureSiteId] of (
    options.siteIds ?? [siteId]
  ).entries()) {
    database
      .prepare("INSERT INTO site_identities (site_pk, site_id) VALUES (?, ?)")
      .run(index + 1, fixtureSiteId);
    database
      .prepare("INSERT INTO sites (id, created_at) VALUES (?, 0)")
      .run(fixtureSiteId);
  }
  const calls: QueryCall[] = [];
  const env = {
    DB: {
      prepare: (sql: string) => ({
        bind: (...bindings: QueryBinding[]) => {
          const call = { sql, bindings };
          calls.push(call);
          return {
            all: async () => ({
              results: runSqlite(sql, bindings),
            }),
          };
        },
      }),
    } as unknown as D1Database,
  } as Env;
  return {
    env,
    calls,
    database,
    close: () => database.close(),
    explain: (call) =>
      runSqlite(`EXPLAIN QUERY PLAN ${call.sql}`, call.bindings).map((row) =>
        String((row as { detail?: unknown }).detail ?? ""),
      ),
  };
}
function visitBindings(window: QueryWindow): QueryBinding[] {
  return [siteId, window.startMs, window.endExclusiveMs];
}
function eventBindings(window: QueryWindow): QueryBinding[] {
  return [siteId, window.startMs, window.endExclusiveMs];
}
function condition(
  field: string,
  value: string,
  operator: "eq" | "neq" = "eq",
): FilterExpression {
  return {
    kind: "condition",
    target: { kind: "field", field: field as never },
    operator,
    value,
  };
}
function prepareScopedFilters(
  operation: "sessions" | "visitors",
  scope: "session" | "visitor",
  root: FilterExpression,
  targetWindow: QueryWindow,
): FilterDocument {
  const prepared = prepareScopedQuery(operation, {
    context: siteQueryContext(siteId, "private-dashboard"),
    time: createQueryTime(
      targetWindow.startMs,
      targetWindow.endExclusiveMs,
      targetWindow.timeZone,
      targetWindow.nowMs,
    ),
    filters: { version: 1, root },
    scopePreference: scope,
  } as never);
  return prepared.filters!;
}
function preparedSessionIdentityFilters(
  preparationWindow: QueryWindow,
  entityIds: readonly { readonly siteId: string; readonly id: string }[],
): FilterDocument {
  const prepared = prepareScopedQuery("sessions", {
    context: siteQueryContext(siteId, "private-dashboard"),
    time: createQueryTime(
      preparationWindow.startMs,
      preparationWindow.endExclusiveMs,
      preparationWindow.timeZone,
      preparationWindow.nowMs,
    ),
    filters: parseFilterDsl("count(page) gte 1", analyticsFilterRegistry),
    scopePreference: "session",
  } as never);
  if (!prepared.filters)
    throw new Error("journey_contract_prepared_filter_missing");
  const metadata = scopedFilterMetadata(prepared.filters);
  if (!metadata) throw new Error("journey_contract_prepared_metadata_missing");
  return attachScopedFilterMetadata(prepared.filters, {
    ...metadata,
    siteIds: [siteId, secondSiteId],
    plan: {
      ...metadata.plan,
      advancedMatches: { entityIds },
    },
  });
}
function compileJourneyReport(plan: ValidatedLogicalPlan) {
  const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
    siteId: plan.context.subject.siteIds[0]!,
    time: plan.context.time,
  });
  const output = plan.outputs[0]!;
  const relation = lowerer.projectOutput(
    lowerer.lower(output),
    output.fields.map((field) => ({ name: field.name, slot: field.slot })),
  );
  return compileD1Query(lowerLogicalPlan(relation));
}

function d1PhysicalPlanHash(
  statement: ReturnType<typeof compileD1Query>,
): string | undefined {
  const shape = statement.physicalPlanShape;
  if (!shape) return undefined;
  const payload: unknown[] = [
    `d1-query-shape-v${shape.version}`,
    statement.sql,
    shape.cteCount,
    shape.directScanProjectionCount,
    shape.nativeMembershipCount,
    shape.jsonMembershipCount,
  ];
  if (shape.version === 2 || shape.version === 3)
    payload.push(shape.nativeRowRelationCount, shape.jsonRowRelationCount);
  if (shape.version === 3)
    payload.push(
      shape.parameterStrategy,
      shape.parameterOccurrenceCount,
      shape.parameterSlotCount,
    );
  return `v${shape.version}:${createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex")}`;
}

function sqliteQueryEvidence(
  sqlite: ReturnType<typeof createSqliteDetailEnv>,
  call: QueryCall,
  physicalPlanHash?: string,
) {
  const queryPlan = sqlite.explain(call);
  const aliasCandidates = new Map<string, Set<string>>();
  const tableReference =
    /\b(?:FROM|JOIN)\s+(?:"([^"]+)"|([A-Za-z_][\w$]*))(?:\s+(?:AS\s+)?(?:"([^"]+)"|([A-Za-z_][\w$]*)))?/giu;
  const reservedAlias = new Set([
    "CROSS",
    "FULL",
    "GROUP",
    "INNER",
    "JOIN",
    "LEFT",
    "LIMIT",
    "ORDER",
    "OUTER",
    "RIGHT",
    "WHERE",
    "WINDOW",
  ]);
  for (const match of call.sql.matchAll(tableReference)) {
    const table = match[1] ?? match[2];
    const candidateAlias = match[3] ?? match[4];
    if (!table) continue;
    const alias =
      candidateAlias && !reservedAlias.has(candidateAlias.toUpperCase())
        ? candidateAlias
        : table;
    const candidates = aliasCandidates.get(alias) ?? new Set<string>();
    candidates.add(table);
    aliasCandidates.set(alias, candidates);
  }
  const rawAccess = queryPlan.flatMap((line) => {
    const match = line.match(/\b(SCAN|SEARCH)\s+([^\s]+)/iu);
    if (!match?.[1] || !match[2]) return [];
    const planObject = match[2].replaceAll('"', "");
    const candidates = [...(aliasCandidates.get(planObject) ?? [])];
    return [
      {
        line,
        operation: match[1].toUpperCase(),
        planObject,
        tableCandidates: candidates,
        tableMapping:
          candidates.length === 1
            ? "unique-sql-alias-candidate"
            : candidates.length > 1
              ? "ambiguous-sql-alias-candidate"
              : "unknown",
      },
    ];
  });
  const byIndex: Record<string, number> = {};
  for (const line of queryPlan) {
    const match = line.match(/\bUSING (?:COVERING )?INDEX ([^\s]+)/iu);
    if (match?.[1]) byIndex[match[1]] = (byIndex[match[1]] ?? 0) + 1;
  }
  const indexes = Object.keys(byIndex).sort();
  return {
    ...sqliteStatementEvidence(call),
    ...(physicalPlanHash ? { physicalPlanHash } : {}),
    sql: call.sql,
    bindings: call.bindings,
    eqpRows: queryPlan.length,
    eqp: queryPlan,
    rawAccess,
    byIndex,
    planOperations: {
      scans: queryPlan.filter((line) => /\bSCAN\b/iu.test(line)).length,
      searches: queryPlan.filter((line) => /\bSEARCH\b/iu.test(line)).length,
      materialized: queryPlan.filter((line) => /\bMATERIALIZE\b/iu.test(line))
        .length,
      coRoutines: queryPlan.filter((line) => /CO-ROUTINE/iu.test(line)).length,
      tempBtrees: queryPlan.filter((line) => /USE TEMP B-TREE/iu.test(line))
        .length,
    },
    indexes,
  };
}

const wave70CostEvidencePath = "plan/root-wave70/cost-evidence.json";
function persistWave70CostEvidence(update: Record<string, unknown>): void {
  const previous = existsSync(wave70CostEvidencePath)
    ? (JSON.parse(readFileSync(wave70CostEvidencePath, "utf8")) as Record<
        string,
        unknown
      >)
    : {};
  writeFileSync(
    wave70CostEvidencePath,
    `${JSON.stringify(
      {
        ...previous,
        ...update,
        schemaVersion: 1,
        interpretation:
          "SQLite EXPLAIN QUERY PLAN is structural evidence, not D1 rows-read telemetry. Alias-to-table mappings are candidates inferred from SQL text and may be unknown or ambiguous.",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}
function sqliteStatementEvidence(call: QueryCall) {
  return {
    sqlBytes: new TextEncoder().encode(call.sql).byteLength,
    sqlSha256: createHash("sha256").update(call.sql).digest("hex"),
    bindingCount: call.bindings.length,
    statements: 1,
  };
}
function url(path: string, params: Record<string, string | number | boolean>) {
  const parsed = new URL(`https://edge.test${path}`);
  for (const [key, value] of Object.entries(params)) {
    parsed.searchParams.set(key, String(value));
  }
  return parsed;
}
function visitorRow(overrides: D1Row = {}): D1Row {
  return {
    visitorId: "visitor-1",
    sessionId: "session-1",
    firstSeenAt: baseMs,
    lastSeenAt: baseMs + 60_000,
    views: 3,
    sessions: 2,
    events: 1,
    country: "US",
    region: "California",
    regionCode: "CA",
    city: "San Francisco",
    referrerHost: "ref.example",
    referrerUrl: "https://ref.example/start",
    browser: "Chrome",
    browserVersion: "124",
    os: "macOS",
    osVersion: "14",
    deviceType: "desktop",
    screenWidth: 1440,
    screenHeight: 900,
    ...overrides,
  };
}
function sessionRow(overrides: D1Row = {}): D1Row {
  return {
    sessionId: "session-1",
    visitorId: "visitor-1",
    startedAt: baseMs,
    endedAt: baseMs + 60_000,
    totalDurationMs: 60_000,
    active: 0,
    views: 2,
    events: 1,
    bounce: 0,
    entryPath: "/home",
    exitPath: "/pricing",
    referrerHost: "ref.example",
    referrerUrl: "https://ref.example/start",
    country: "US",
    region: "California",
    regionCode: "CA",
    city: "San Francisco",
    latitude: 37.77,
    longitude: -122.42,
    browser: "Chrome",
    browserVersion: "124",
    os: "macOS",
    osVersion: "14",
    deviceType: "desktop",
    screenWidth: 1440,
    screenHeight: 900,
    perfTtfbMs: 120,
    perfFcpMs: 300,
    perfLcpMs: 1200,
    perfCls: 0.02,
    perfInpMs: 90,
    ...overrides,
  };
}
function journeyEventRow(overrides: D1Row = {}): D1Row {
  return {
    id: "visit-1",
    kind: "pageview",
    eventType: "pageview",
    occurredAt: baseMs + 10_000,
    visitId: "visit-1",
    sessionId: "session-1",
    visitorId: "visitor-1",
    pathname: "/home",
    hash: "",
    title: "Home",
    hostname: "example.com",
    referrerHost: "ref.example",
    referrerUrl: "https://ref.example/start",
    country: "US",
    region: "California",
    city: "San Francisco",
    browser: "Chrome",
    browserVersion: "124",
    os: "macOS",
    osVersion: "14",
    deviceType: "desktop",
    screenWidth: 1440,
    screenHeight: 900,
    durationMs: 40_000,
    perfTtfbMs: 100,
    perfFcpMs: 250,
    perfLcpMs: 1100,
    perfCls: 0.01,
    perfInpMs: 80,
    ...overrides,
  };
}
function visitorDetailVisitRow(overrides: D1Row = {}): D1Row {
  return {
    sourceType: "visit",
    visitId: "visit-1",
    visitorId: "visitor-1",
    sessionId: "session-1",
    status: "closed",
    startedAt: baseMs + 10_000,
    lastActivityAt: baseMs + 50_000,
    endedAt: baseMs + 50_000,
    durationMs: 40_000,
    pathname: "/home",
    hash: "",
    title: "Home",
    hostname: "example.com",
    referrerHost: "ref.example",
    referrerUrl: "https://ref.example/start",
    country: "US",
    region: "California",
    regionCode: "CA",
    city: "San Francisco",
    latitude: 37.77,
    longitude: -122.42,
    browser: "Chrome",
    browserVersion: "124",
    os: "macOS",
    osVersion: "14",
    deviceType: "desktop",
    screenWidth: 1440,
    screenHeight: 900,
    perfTtfbMs: 100,
    perfFcpMs: 250,
    perfLcpMs: 1100,
    perfCls: 0.01,
    perfInpMs: 80,
    ...overrides,
  };
}
function visitorDetailCustomEventRow(overrides: D1Row = {}): D1Row {
  return {
    ...visitorDetailVisitRow(),
    sourceType: "custom",
    eventId: "event-1",
    eventType: "signup",
    occurredAt: baseMs + 20_000,
    ...overrides,
  };
}
describe("edge journey detail D1 queries", () => {
  it("supports aggregation SQL callers without pagination", () => {
    expect(
      buildVisitorAggregationSql({ orderBy: "lastSeenAt DESC" }),
    ).not.toContain("LIMIT ?");
    expect(buildSessionAggregationSql({ orderBy: "startedAt DESC" })).toContain(
      "session_metrics AS",
    );
  });

  it("returns null for a missing visitor detail row and captures target bindings", async () => {
    const { env, calls } = createD1Env([[]]);

    await expect(
      queryVisitorForDetailFromD1(env, siteId, "visitor-missing"),
    ).resolves.toBeNull();

    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toMatch(/visitor_id/u);
    expect(calls[0].bindings).toContain(siteId);
    expect(calls[0].bindings).toContain("visitor-missing");
  });

  it("combines visitor, session, and event rows into visitor detail metrics", async () => {
    const secondSessionStart = baseMs + 24 * 60 * 60 * 1000;
    const { env, calls } = createD1Env([
      [
        visitorDetailVisitRow(),
        visitorDetailVisitRow({
          visitId: "visit-2",
          sessionId: "session-2",
          startedAt: secondSessionStart + 10_000,
          endedAt: secondSessionStart + 40_000,
          lastActivityAt: secondSessionStart + 40_000,
          durationMs: 30_000,
          pathname: "/checkout",
        }),
        visitorDetailCustomEventRow({ pathname: "/signup" }),
      ],
    ]);

    const detail = await queryVisitorDetailFromD1(
      env,
      siteId,
      "visitor-1",
      "UTC",
    );

    expect(detail?.metrics).toMatchObject({
      totalEvents: 1,
      sessions: 2,
      views: 2,
      avgEventsPerSession: 0.5,
      bounceRate: 1,
      avgDurationMs: 35_000,
      p90DurationMs: 40_000,
      daysActive: 2,
      conversionEvents: 1,
      avgTimeBetweenSessionsMs: 24 * 60 * 60 * 1000,
    });
    expect(detail?.visitedPages).toEqual([
      { pathname: "/checkout", views: 1 },
      { pathname: "/home", views: 1 },
    ]);
    expect(detail?.eventDistribution).toEqual([
      { eventType: "pageview", count: 2 },
      { eventType: "session start", count: 2 },
      { eventType: "signup", count: 1 },
    ]);
    expect(detail?.performance.ttfb).toMatchObject({
      avg: 100,
      p75: 100,
      samples: 2,
    });
    expect(detail?.events.map((event) => event.id)).toContain(
      "session-start:session-2",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.bindings).toContain(siteId);
    expect(calls[0]?.bindings).toContain("visitor-1");
    expect(calls[0]?.sql).toContain("UNION ALL");
    expect(calls[0]?.sql).toContain("custom_event_names");
  });

  it("ignores custom events without a session when grouping visitor details", async () => {
    const { env } = createD1Env([
      [visitorDetailVisitRow(), visitorDetailCustomEventRow({ sessionId: "" })],
    ]);

    await expect(
      queryVisitorDetailFromD1(env, siteId, "visitor-1", "UTC"),
    ).resolves.toMatchObject({
      visitor: { visitorId: "visitor-1" },
      sessions: [{ sessionId: "session-1", events: 0 }],
      metrics: { totalEvents: 1 },
    });
  });

  it("handles multi-view sessions and ties session ordering by id", async () => {
    const { env } = createD1Env([
      [
        visitorDetailVisitRow({
          visitId: "visit-a-1",
          sessionId: "session-a",
          startedAt: baseMs,
        }),
        visitorDetailVisitRow({
          visitId: "visit-a-2",
          sessionId: "session-a",
          startedAt: baseMs + 1_000,
        }),
        visitorDetailVisitRow({
          visitId: "visit-b-1",
          sessionId: "session-b",
          startedAt: baseMs,
        }),
      ],
    ]);

    const detail = await queryVisitorDetailFromD1(
      env,
      siteId,
      "visitor-1",
      "UTC",
    );

    expect(detail?.sessions).toEqual([
      expect.objectContaining({ sessionId: "session-a", bounce: false }),
      expect.objectContaining({ sessionId: "session-b", bounce: true }),
    ]);
  });

  it("maps a pageview detail without custom event payload fields", async () => {
    const { env, calls } = createD1Env([
      [
        visitorDetailVisitRow({
          visitId: "visit-detail",
          startedAt: baseMs + 10_000,
        }),
      ],
    ]);

    const detail = await queryJourneyEventDetailFromD1(
      env,
      siteId,
      "visit-detail",
      queryWindow(),
      "pageview",
    );

    expect(detail).toMatchObject({
      event: {
        eventId: "visit-detail",
        eventName: "pageview",
        eventKind: "pageview",
        occurredAt: baseMs + 10_000,
        visitId: "visit-detail",
        nodeCount: 0,
        valueCount: 0,
      },
      context: {
        visitId: "visit-detail",
        sessionId: "session-1",
        visitorId: "visitor-1",
        pathname: "/home",
        browser: "Chrome",
      },
    });
    expect(detail).not.toHaveProperty("eventData");
    expect(calls[0]?.bindings).toContain(siteId);
    expect(calls[0]?.bindings).toContain("visit-detail");
    expect(calls[0]?.bindings).toContain(baseMs);
    expect(calls[0]?.bindings).toContain(baseMs + 2 * 60 * 60 * 1000);
    expect(calls[0]?.sql).not.toMatch(/custom_events|custom_event_names/u);
  });

  it("resolves session boundary details and rejects mismatched boundary ids", async () => {
    const startEnv = createD1Env([[visitorDetailVisitRow()]]);
    await expect(
      queryJourneyEventDetailFromD1(
        startEnv.env,
        siteId,
        "session-start:session-1",
        queryWindow(),
        "session_start",
      ),
    ).resolves.toMatchObject({
      event: {
        eventId: "session-start:session-1",
        eventKind: "session_start",
        visitId: "",
      },
      context: {
        status: "complete",
        durationMs: 40_000,
      },
    });

    const leaveEnv = createD1Env([[visitorDetailVisitRow()]]);
    await expect(
      queryJourneyEventDetailFromD1(
        leaveEnv.env,
        siteId,
        "session-leave:session-1",
        queryWindow(),
        "leave",
      ),
    ).resolves.toMatchObject({
      event: {
        eventId: "session-leave:session-1",
        eventKind: "leave",
        visitId: "visit-1",
      },
    });

    await expect(
      queryJourneyEventDetailFromD1(
        createD1Env([[]]).env,
        siteId,
        "session-start:missing",
        queryWindow(),
        "session_start",
      ),
    ).resolves.toBeNull();
    await expect(
      queryJourneyEventDetailFromD1(
        createD1Env([[]]).env,
        siteId,
        "session-start:",
        queryWindow(),
        "session_start",
      ),
    ).resolves.toBeNull();
    await expect(
      queryJourneyEventDetailFromD1(
        createD1Env([[]]).env,
        siteId,
        "session-start:session-1",
        queryWindow(),
        "leave",
      ),
    ).resolves.toBeNull();
  });

  it("applies the standard event window and active session status", async () => {
    const activeEnv = createD1Env([
      [visitorDetailVisitRow({ status: "open", endedAt: null })],
    ]);
    await expect(
      queryJourneyEventDetailFromD1(
        activeEnv.env,
        siteId,
        "session-start:session-1",
        queryWindow(),
        "session_start",
      ),
    ).resolves.toMatchObject({
      context: { status: "open" },
    });

    const outsideWindow = createD1Env([[visitorDetailVisitRow()]]);
    await expect(
      queryJourneyEventDetailFromD1(
        outsideWindow.env,
        siteId,
        "session-start:session-1",
        {
          ...queryWindow(),
          endExclusiveMs: baseMs + 5_000,
        },
        "session_start",
      ),
    ).resolves.toBeNull();
  });

  it("returns null visitor detail from an empty shared source", async () => {
    const { env, calls } = createD1Env([[]]);

    await expect(
      queryVisitorDetailFromD1(env, siteId, "visitor-missing", "UTC"),
    ).resolves.toBeNull();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.bindings).toContain(siteId);
    expect(calls[0]?.bindings).toContain("visitor-missing");
  });

  it("constrains visitor and session details to an explicit half-open query window", async () => {
    const { env, calls } = createD1Env([[], []]);
    const window = {
      startMs: baseMs,
      endExclusiveMs: baseMs + 60_000,
      nowMs: baseMs + 60_000,
      timeZone: "UTC",
    };

    await expect(
      queryVisitorDetailFromD1(env, siteId, "visitor-outside", "UTC", window),
    ).resolves.toBeNull();
    await expect(
      querySessionDetailFromD1(env, siteId, "session-outside", window),
    ).resolves.toBeNull();

    expect(calls).toHaveLength(2);
    expect(calls[0]?.sql).toContain("started_at");
    expect(calls[0]?.bindings).toContain("visitor-outside");
    expect(calls[0]?.bindings).toContain(baseMs);
    expect(calls[0]?.bindings).toContain(baseMs + 60_000);
    expect(calls[1]?.sql).toContain("started_at");
    expect(calls[1]?.bindings).toContain("session-outside");
    expect(calls[1]?.bindings).toContain(baseMs);
    expect(calls[1]?.bindings).toContain(baseMs + 60_000);
  });

  it("uses target-visit and target-event indexes from the shared detail source", async () => {
    const sqlite = createSqliteDetailEnv();
    try {
      sqlite.database
        .prepare(
          `INSERT INTO visits (
            visit_id, site_id, visitor_id, session_id, status, started_at,
            last_activity_at, pathname, hostname
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "visit-plan",
          siteId,
          "visitor-plan",
          "session-plan",
          "closed",
          baseMs,
          baseMs,
          "/target",
          "example.test",
        );
      sqlite.database
        .prepare(
          `INSERT INTO visits (
            visit_id, site_id, visitor_id, session_id, status, started_at,
            last_activity_at, pathname, hostname
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "visit-noise",
          siteId,
          "visitor-noise",
          "session-noise",
          "closed",
          baseMs,
          baseMs,
          "/noise",
          "example.test",
        );
      sqlite.database
        .prepare(
          "INSERT INTO custom_event_names (id, site_id, name, last_seen_at) VALUES (?, ?, ?, ?)",
        )
        .run(1, siteId, "signup", baseMs);
      sqlite.database
        .prepare(
          `INSERT INTO custom_events (
            event_pk, event_id, site_id, visit_id, event_name_id, occurred_at,
            received_at, sequence, node_count, value_count
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(1, "event-plan", siteId, "visit-plan", 1, baseMs, baseMs, 0, 0, 0);
      sqlite.database.exec(`
        WITH RECURSIVE sequence(value) AS (
          VALUES(2)
          UNION ALL
          SELECT value + 1 FROM sequence WHERE value < 5001
        )
        INSERT INTO visits (
          visit_id, site_id, visitor_id, session_id, status, started_at,
          last_activity_at, pathname, hostname
        )
        SELECT
          'visit-noise-' || value,
          '${siteId}',
          'visitor-noise-' || value,
          'session-noise-' || value,
          'closed',
          ${baseMs} + value,
          ${baseMs} + value,
          '/noise',
          'example.test'
        FROM sequence;

        WITH RECURSIVE sequence(value) AS (
          VALUES(2)
          UNION ALL
          SELECT value + 1 FROM sequence WHERE value < 5001
        )
        INSERT INTO custom_events (
          event_pk, event_id, site_id, visit_id, event_name_id, occurred_at,
          received_at, sequence, node_count, value_count
        )
        SELECT
          value,
          'event-noise-' || value,
          '${siteId}',
          'visit-noise',
          1,
          ${baseMs} + value,
          ${baseMs} + value,
          value,
          0,
          0
        FROM sequence;
        ANALYZE;
      `);

      await expect(
        queryVisitorDetailFromD1(sqlite.env, siteId, "visitor-plan", "UTC"),
      ).resolves.toMatchObject({
        visitor: { visitorId: "visitor-plan" },
        metrics: { totalEvents: 1 },
      });

      expect(sqlite.calls).toHaveLength(1);
      const plan = sqlite.explain(sqlite.calls[0]!);
      expect(
        plan.some((detail) =>
          detail.includes("idx_visits_site_pk_visitor_started_at"),
        ),
      ).toBe(true);
      expect(
        plan.some((detail) =>
          detail.includes("idx_custom_events_site_pk_visit_time"),
        ),
      ).toBe(true);
      expect(plan.some((detail) => /SCAN ce(?:\s|$)/.test(detail))).toBe(false);
    } finally {
      sqlite.close();
    }
  });

  it("uses session-target indexes from the shared session detail source", async () => {
    const sqlite = createSqliteDetailEnv();
    try {
      await expect(
        querySessionDetailFromD1(sqlite.env, siteId, "session-plan"),
      ).resolves.toBeNull();

      expect(sqlite.calls).toHaveLength(1);
      const plan = sqlite.explain(sqlite.calls[0]!);
      expect(
        plan.some((detail) =>
          detail.includes("idx_visits_site_pk_session_started_at"),
        ),
      ).toBe(true);
      expect(
        plan.some((detail) =>
          detail.includes("idx_custom_events_site_pk_visit_time"),
        ),
      ).toBe(true);
    } finally {
      sqlite.close();
    }
  });

  it("uses custom-event time for event-only scoped session and visitor rows", async () => {
    const sqlite = createSqliteDetailEnv();
    const targetWindow = queryWindow();
    const eventAt = baseMs + 30_000;
    try {
      sqlite.database
        .prepare(
          `INSERT INTO visits (
            visit_id, site_id, visitor_id, session_id, status, started_at,
            last_activity_at, pathname, hostname, user_id, user_name
          ) VALUES (?, ?, ?, ?, 'closed', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "event-only-visit",
          siteId,
          "event-only-visitor",
          "event-only-session",
          baseMs - 60 * 60 * 1000,
          baseMs - 60 * 60 * 1000,
          "/event-only",
          "example.test",
          "event-user",
          "Event User",
        );
      sqlite.database
        .prepare(
          "INSERT INTO custom_event_names (id, site_id, name, last_seen_at) VALUES (?, ?, ?, ?)",
        )
        .run(1, siteId, "signup", eventAt);
      sqlite.database
        .prepare(
          `INSERT INTO custom_events (
            event_pk, event_id, site_id, visit_id, event_name_id, occurred_at,
            received_at, sequence, node_count, value_count
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          1,
          "event-only-event",
          siteId,
          "event-only-visit",
          1,
          eventAt,
          eventAt,
          0,
          0,
          0,
        );

      const eventFilter = condition("event.name", "signup");
      const sessionRows = await querySessionsFromD1(
        sqlite.env,
        siteId,
        targetWindow,
        prepareScopedFilters("sessions", "session", eventFilter, targetWindow),
        10,
      );
      const visitorRows = await queryVisitorsFromD1(
        sqlite.env,
        siteId,
        targetWindow,
        prepareScopedFilters("visitors", "visitor", eventFilter, targetWindow),
        10,
      );

      expect(sessionRows).toHaveLength(1);
      expect(sessionRows[0]).toMatchObject({
        sessionId: "event-only-session",
        startedAt: eventAt,
        endedAt: eventAt,
        views: 0,
        events: 1,
        bounce: false,
        userId: "event-user",
        userName: "Event User",
      });
      expect(sessionRows[0]?.startedAt).not.toBe(0);
      expect(visitorRows).toHaveLength(1);
      expect(visitorRows[0]).toMatchObject({
        visitorId: "event-only-visitor",
        firstSeenAt: eventAt,
        lastSeenAt: eventAt,
        views: 0,
        sessions: 1,
        events: 1,
        userId: "event-user",
        userName: "Event User",
      });
      expect(visitorRows[0]?.firstSeenAt).not.toBe(0);
    } finally {
      sqlite.close();
    }
  });

  it("keeps identity pairs consistent, ignores anonymous rows, and searches identity", async () => {
    const sqlite = createSqliteDetailEnv();
    const targetWindow = queryWindow();
    try {
      const insertVisit = sqlite.database.prepare(`
        INSERT INTO visits (
          visit_id, site_id, visitor_id, session_id, status, started_at,
          last_activity_at, pathname, hostname, user_id, user_name
        ) VALUES (?, ?, ?, ?, 'closed', ?, ?, ?, 'example.test', ?, ?)
      `);
      const addVisit = (
        visitId: string,
        visitorId: string,
        sessionId: string,
        pathname: string,
        offset: number,
        userId: string,
        userName: string,
      ) => {
        const startedAt = baseMs + offset;
        insertVisit.run(
          visitId,
          siteId,
          visitorId,
          sessionId,
          startedAt,
          startedAt,
          pathname,
          userId,
          userName,
        );
      };

      addVisit(
        "identity-first",
        "identity-visitor",
        "identity-session",
        "/first",
        1_000,
        "user-z",
        "Old User",
      );
      addVisit(
        "identity-paired",
        "identity-visitor",
        "identity-session",
        "/identified",
        2_000,
        "user-a",
        "New User",
      );
      addVisit(
        "identity-tie-a",
        "identity-visitor",
        "identity-session",
        "/tie-a",
        2_000,
        "user-tie-a",
        "Tie A",
      );
      addVisit(
        "identity-tie-z",
        "identity-visitor",
        "identity-session",
        "/tie-z",
        2_000,
        "user-tie-z",
        "Tie Z",
      );
      addVisit(
        "identity-latest-anonymous",
        "identity-visitor",
        "identity-session",
        "/latest",
        3_000,
        "",
        "Stale Name",
      );
      addVisit(
        "anonymous-only",
        "anonymous-visitor",
        "anonymous-session",
        "/anonymous",
        4_000,
        "",
        "",
      );

      const visitors = await queryVisitorsFromD1(
        sqlite.env,
        siteId,
        targetWindow,
        EMPTY_FILTER_DOCUMENT,
        10,
      );
      const sessions = await querySessionsFromD1(
        sqlite.env,
        siteId,
        targetWindow,
        EMPTY_FILTER_DOCUMENT,
        10,
      );
      expect(visitors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            visitorId: "identity-visitor",
            userId: "user-tie-z",
            userName: "Tie Z",
            firstSeenAt: baseMs + 1_000,
            lastSeenAt: baseMs + 3_000,
          }),
          expect.objectContaining({
            visitorId: "anonymous-visitor",
            userId: "",
            userName: "",
          }),
        ]),
      );
      expect(sessions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sessionId: "identity-session",
            userId: "user-tie-z",
            userName: "Tie Z",
            entryPath: "/first",
            exitPath: "/latest",
          }),
          expect.objectContaining({
            sessionId: "anonymous-session",
            userId: "",
            userName: "",
          }),
        ]),
      );

      await expect(
        queryVisitorsFromD1(
          sqlite.env,
          siteId,
          targetWindow,
          EMPTY_FILTER_DOCUMENT,
          10,
          undefined,
          undefined,
          "new user",
        ),
      ).resolves.toEqual([
        expect.objectContaining({
          visitorId: "identity-visitor",
          userId: "user-tie-z",
          userName: "Tie Z",
        }),
      ]);
      await expect(
        querySessionsFromD1(
          sqlite.env,
          siteId,
          targetWindow,
          EMPTY_FILTER_DOCUMENT,
          10,
          undefined,
          undefined,
          "new user",
        ),
      ).resolves.toEqual([
        expect.objectContaining({
          sessionId: "identity-session",
          userId: "user-tie-z",
          userName: "Tie Z",
        }),
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("evaluates Session and Visitor AND/OR/NOT membership on real SQLite data", async () => {
    const sqlite = createSqliteDetailEnv();
    const targetWindow = queryWindow();
    try {
      const insertVisit = sqlite.database.prepare(`
        INSERT INTO visits (
          visit_id, site_id, visitor_id, session_id, status, started_at,
          last_activity_at, pathname, hostname
        ) VALUES (?, ?, ?, ?, 'closed', ?, ?, ?, 'example.test')
      `);
      const insertEvent = sqlite.database.prepare(`
        INSERT INTO custom_events (
          event_pk, event_id, site_id, visit_id, event_name_id, occurred_at,
          received_at, sequence, node_count, value_count
        ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, 0, 0)
      `);
      sqlite.database
        .prepare(
          "INSERT INTO custom_event_names (id, site_id, name, last_seen_at) VALUES (?, ?, ?, ?)",
        )
        .run(1, siteId, "signup", baseMs);

      const addVisit = (
        visitId: string,
        visitorId: string,
        sessionId: string,
        pathname: string,
        offset: number,
      ) => {
        const startedAt = baseMs + offset;
        insertVisit.run(
          visitId,
          siteId,
          visitorId,
          sessionId,
          startedAt,
          startedAt,
          pathname,
        );
      };
      const addEvent = (eventPk: number, eventId: string, visitId: string) => {
        const occurredAt = baseMs + 10_000 + eventPk;
        insertEvent.run(
          eventPk,
          eventId,
          siteId,
          visitId,
          occurredAt,
          occurredAt,
          eventPk,
        );
      };

      // Sessions: A is /a, B is signup.
      addVisit("session-a-visit", "visitor-a", "session-a", "/a", 1_000);
      addEvent(1, "session-a-event", "session-a-visit");
      addVisit("session-b-visit", "visitor-b", "session-b", "/a", 2_000);
      addVisit("session-c-visit", "visitor-c", "session-c", "/c", 3_000);
      addEvent(2, "session-c-event", "session-c-visit");
      addVisit("session-d-visit", "visitor-d", "session-d", "/d", 4_000);

      const sessionA = condition("page.path", "/a");
      const sessionB = condition("event.name", "signup");
      const sessionIds = async (root: FilterExpression) =>
        (
          await querySessionsFromD1(
            sqlite.env,
            siteId,
            targetWindow,
            prepareScopedFilters("sessions", "session", root, targetWindow),
            20,
          )
        ).map((row) => row.sessionId);

      await expect(
        sessionIds({ kind: "and", children: [sessionA, sessionB] }),
      ).resolves.toEqual(["session-a"]);
      await expect(
        sessionIds({ kind: "or", children: [sessionA, sessionB] }),
      ).resolves.toEqual(["session-c", "session-b", "session-a"]);
      await expect(
        sessionIds({ kind: "not", child: sessionB }),
      ).resolves.toEqual(["session-d", "session-b"]);
      await expect(
        sessionIds({ kind: "and", children: [sessionA, sessionA] }),
      ).resolves.toEqual(["session-b", "session-a"]);

      // Visitors: A and B deliberately occur in different sessions for the
      // same visitor, while visitor-c only has B and visitor-d has neither.
      addVisit(
        "visitor-a-first",
        "visitor-1",
        "visitor-session-a",
        "/a",
        5_000,
      );
      addVisit(
        "visitor-a-second",
        "visitor-1",
        "visitor-session-b",
        "/neutral",
        6_000,
      );
      addEvent(3, "visitor-a-event", "visitor-a-second");
      addVisit(
        "visitor-b-only-a",
        "visitor-2",
        "visitor-session-c",
        "/a",
        7_000,
      );
      addVisit(
        "visitor-c-only-b",
        "visitor-3",
        "visitor-session-d",
        "/c",
        8_000,
      );
      addEvent(4, "visitor-c-event", "visitor-c-only-b");
      addVisit(
        "visitor-d-neither",
        "visitor-4",
        "visitor-session-e",
        "/d",
        9_000,
      );

      const visitorA = condition("page.path", "/a");
      const visitorB = condition("event.name", "signup");
      const visitorIds = async (root: FilterExpression) =>
        (
          await queryVisitorsFromD1(
            sqlite.env,
            siteId,
            targetWindow,
            prepareScopedFilters("visitors", "visitor", root, targetWindow),
            20,
          )
        ).map((row) => row.visitorId);

      await expect(
        visitorIds({ kind: "and", children: [visitorA, visitorB] }),
      ).resolves.toEqual(["visitor-1", "visitor-a"]);
      await expect(
        visitorIds({ kind: "or", children: [visitorA, visitorB] }),
      ).resolves.toEqual([
        "visitor-3",
        "visitor-2",
        "visitor-1",
        "visitor-c",
        "visitor-b",
        "visitor-a",
      ]);
      await expect(
        visitorIds({ kind: "not", child: visitorA }),
      ).resolves.toEqual(["visitor-4", "visitor-3", "visitor-d", "visitor-c"]);
    } finally {
      sqlite.close();
    }
  });

  it("freezes goal-summary no-fact compatibility with a nonempty global filter", async () => {
    // The historical Funnel membership SQL reads sequence although the
    // no-fact compatibility Event CTE omits it. Complete that empty typed
    // schema only in this SQLite oracle adapter; captured legacy SQL is kept.
    const sqlite = createSqliteDetailEnv({
      completeLegacyEmptyEventSequenceProjection: true,
    });
    const targetWindow = queryWindow();
    try {
      sqlite.database
        .prepare(
          `
          INSERT INTO custom_event_names (id, site_id, name, last_seen_at)
          VALUES (1, ?, 'signup', ?)
        `,
        )
        .run(siteId, baseMs);
      const insertVisit = sqlite.database.prepare(`
        INSERT INTO visits (
          visit_id, site_id, visitor_id, session_id, status, started_at,
          last_activity_at, pathname, hostname, country
        ) VALUES (?, ?, 'visitor-compat', 'session-compat', 'closed', ?, ?, ?, 'example.test', 'US')
      `);
      insertVisit.run(
        "compat-docs",
        siteId,
        baseMs + 1_000,
        baseMs + 1_000,
        "/docs",
      );
      insertVisit.run(
        "compat-other",
        siteId,
        baseMs + 2_000,
        baseMs + 2_000,
        "/other",
      );
      sqlite.database
        .prepare(
          `
          INSERT INTO custom_events (
            event_pk, event_id, site_id, visit_id, event_name_id, occurred_at,
            received_at, sequence, node_count, value_count
          ) VALUES (1, 'compat-event', ?, 'compat-docs', 1, ?, ?, 1, 0, 0)
        `,
        )
        .run(siteId, baseMs + 3_000, baseMs + 3_000);

      const globalFilters = filterFixture({ country: "US" });
      const analysis = {
        type: "goal" as const,
        filter: filterFixture({ path: "/docs" }),
      };
      const visitorOptions = {
        limit: 10,
        sort: { key: "lastSeenAt" as const, direction: "desc" as const },
        analysis,
      };
      const sessionOptions = {
        limit: 10,
        sort: { key: "startedAt" as const, direction: "desc" as const },
        analysis,
      };

      const parentVisitor = await queryVisitorListPageFromParentOracle(
        sqlite.env,
        siteId,
        targetWindow,
        globalFilters,
        visitorOptions,
      );
      const parentVisitorCall = sqlite.calls.at(-1)!;
      expect(parentVisitor).toMatchObject({
        rows: [
          { visitorId: "visitor-compat", views: 2, sessions: 1, events: 0 },
        ],
        nextCursor: null,
      });
      expect(parentVisitorCall.bindings.length).toBeLessThanOrEqual(100);
      expect(
        new TextEncoder().encode(parentVisitorCall.sql).length,
      ).toBeLessThanOrEqual(100_000);
      expect(sqlite.explain(parentVisitorCall).length).toBeGreaterThan(0);

      const parentSession = await querySessionListPageFromParentOracle(
        sqlite.env,
        siteId,
        targetWindow,
        globalFilters,
        sessionOptions,
      );
      const parentSessionCall = sqlite.calls.at(-1)!;
      expect(parentSession).toMatchObject({
        rows: [{ sessionId: "session-compat", views: 2, events: 0 }],
        nextCursor: null,
      });
      expect(parentSessionCall.bindings.length).toBeLessThanOrEqual(100);
      expect(
        new TextEncoder().encode(parentSessionCall.sql).length,
      ).toBeLessThanOrEqual(100_000);
      expect(sqlite.explain(parentSessionCall).length).toBeGreaterThan(0);

      const sessionFactFilters: FilterDocument = {
        version: 1,
        root: {
          kind: "condition",
          target: { kind: "field", field: "session.views" as never },
          operator: "gte",
          value: 2,
        },
      };
      const visitorFactFilters: FilterDocument = {
        version: 1,
        root: {
          kind: "condition",
          target: { kind: "field", field: "visitor.sessions" as never },
          operator: "gte",
          value: 1,
        },
      };
      const parentFactSession = await querySessionListPageFromParentOracle(
        sqlite.env,
        siteId,
        targetWindow,
        sessionFactFilters,
        sessionOptions,
      );
      const parentFactSessionCall = sqlite.calls.at(-1)!;
      expect(parentFactSession.rows).toMatchObject([
        { sessionId: "session-compat", views: 2, events: 1 },
      ]);
      expect(parentFactSessionCall.bindings.length).toBeLessThanOrEqual(100);
      expect(
        new TextEncoder().encode(parentFactSessionCall.sql).length,
      ).toBeLessThanOrEqual(100_000);
      expect(sqlite.explain(parentFactSessionCall).length).toBeGreaterThan(0);

      const parentFactVisitor = await queryVisitorListPageFromParentOracle(
        sqlite.env,
        siteId,
        targetWindow,
        visitorFactFilters,
        visitorOptions,
      );
      const parentFactVisitorCall = sqlite.calls.at(-1)!;
      expect(parentFactVisitor.rows).toMatchObject([
        { visitorId: "visitor-compat", views: 2, sessions: 1, events: 1 },
      ]);
      expect(parentFactVisitorCall.bindings.length).toBeLessThanOrEqual(100);
      expect(
        new TextEncoder().encode(parentFactVisitorCall.sql).length,
      ).toBeLessThanOrEqual(100_000);
      expect(sqlite.explain(parentFactVisitorCall).length).toBeGreaterThan(0);

      const compareParentAndCurrent = async (
        scenario: string,
        run: (source: "parent" | "current") => Promise<unknown>,
      ) => {
        const callStart = sqlite.calls.length;
        const parent = await run("parent");
        const parentCall = sqlite.calls[callStart]!;
        const current = await run("current");
        const currentCall = sqlite.calls[callStart + 1]!;
        expect(current).toEqual(parent);
        expect(parentCall.bindings.length).toBeLessThanOrEqual(100);
        expect(
          new TextEncoder().encode(parentCall.sql).length,
        ).toBeLessThanOrEqual(100_000);
        expect(sqlite.explain(parentCall).length).toBeGreaterThan(0);
        expect(currentCall.bindings.length).toBeLessThanOrEqual(100);
        expect(
          new TextEncoder().encode(currentCall.sql).length,
        ).toBeLessThanOrEqual(100_000);
        expect(sqlite.explain(currentCall).length).toBeGreaterThan(0);
      };
      const directDefaultVisitorOptions = {
        limit: 10,
        sort: { key: "lastSeenAt" as const, direction: "desc" as const },
      };
      await compareParentAndCurrent("direct-default-visitor", (source) => {
        const query =
          source === "parent"
            ? queryVisitorListPageFromParentOracle
            : queryVisitorListPageFromD1;
        return query(
          sqlite.env,
          siteId,
          targetWindow,
          EMPTY_FILTER_DOCUMENT,
          directDefaultVisitorOptions,
        );
      });

      const directSearchSessionOptions = {
        limit: 10,
        sort: { key: "durationMs" as const, direction: "desc" as const },
        search: "docs",
        target: { type: "session" as const, value: "session-compat" },
      };
      await compareParentAndCurrent(
        "direct-filter-search-session",
        (source) => {
          const query =
            source === "parent"
              ? querySessionListPageFromParentOracle
              : querySessionListPageFromD1;
          return query(
            sqlite.env,
            siteId,
            targetWindow,
            globalFilters,
            directSearchSessionOptions,
          );
        },
      );

      const preparedVisitorFilters = prepareScopedFilters(
        "visitors",
        "visitor",
        condition("geo.country", "US"),
        targetWindow,
      );
      await compareParentAndCurrent("prepared-filter-visitor", (source) => {
        const query =
          source === "parent"
            ? queryVisitorListPageFromParentOracle
            : queryVisitorListPageFromD1;
        return query(
          sqlite.env,
          siteId,
          targetWindow,
          preparedVisitorFilters,
          directDefaultVisitorOptions,
        );
      });

      const funnelAnalysis = {
        type: "funnel" as const,
        config: {
          filterDslVersion: 1 as const,
          progressionScope: "visitor" as const,
          conversionWindowMs: 5_000,
          steps: [
            { id: "page", filterDsl: 'page.path eq "/docs"' },
            { id: "event", filterDsl: 'event.name eq "signup"' },
          ],
        },
        stepIndex: 1,
      };
      await compareParentAndCurrent("funnel-analysis-visitor", (source) => {
        const query =
          source === "parent"
            ? queryVisitorListPageFromParentOracle
            : queryVisitorListPageFromD1;
        return query(sqlite.env, siteId, targetWindow, globalFilters, {
          ...directDefaultVisitorOptions,
          analysis: funnelAnalysis,
        });
      });

      // The migrated public readers must preserve the frozen parent result.
      expect(
        await queryVisitorListPageFromD1(
          sqlite.env,
          siteId,
          targetWindow,
          globalFilters,
          visitorOptions,
        ),
      ).toEqual(parentVisitor);
      expect(
        await querySessionListPageFromD1(
          sqlite.env,
          siteId,
          targetWindow,
          globalFilters,
          sessionOptions,
        ),
      ).toEqual(parentSession);
    } finally {
      sqlite.close();
    }
  });

  it("matches real SQLite Journey sort cursors, Funnel membership, and query evidence", async () => {
    const sqlite = createSqliteDetailEnv({
      completeLegacyEmptyEventSequenceProjection: true,
    });
    const targetWindow = queryWindow();
    const countryFilter = filterFixture({ country: "US" });
    const globalFilters: FilterDocument = {
      version: 1,
      root: {
        kind: "and",
        children: [
          {
            kind: "condition",
            target: { kind: "field", field: "session.views" as never },
            operator: "gte",
            value: 1,
          },
          countryFilter.root!,
        ],
      },
    };
    try {
      sqlite.database
        .prepare(
          `INSERT INTO custom_event_names (id, site_id, name, last_seen_at)
           VALUES (1, ?, 'signup', ?)`,
        )
        .run(siteId, baseMs + 60_000);
      const insertVisit = sqlite.database.prepare(`
        INSERT INTO visits (
          visit_id, site_id, visitor_id, session_id, status, started_at,
          last_activity_at, ended_at, duration_ms, pathname, hostname, country
        ) VALUES (?, ?, ?, ?, 'closed', ?, ?, ?, ?, ?, 'journey.test', ?)
      `);
      const addVisit = (input: {
        readonly visitId: string;
        readonly visitorId: string;
        readonly sessionId: string;
        readonly offset: number;
        readonly durationMs: number;
        readonly pathname: string;
        readonly lastActivityOffset?: number;
        readonly country?: string;
      }) => {
        const startedAt = baseMs + input.offset;
        const lastActivityAt =
          baseMs + (input.lastActivityOffset ?? input.offset);
        insertVisit.run(
          input.visitId,
          siteId,
          input.visitorId,
          input.sessionId,
          startedAt,
          lastActivityAt,
          startedAt + Math.max(0, input.durationMs),
          input.durationMs,
          input.pathname,
          input.country ?? "US",
        );
      };
      const insertEvent = sqlite.database.prepare(`
        INSERT INTO custom_events (
          event_pk, event_id, site_id, visit_id, event_name_id, occurred_at,
          received_at, sequence, node_count, value_count
        ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, 0, 0)
      `);
      const addSignup = (
        eventPk: number,
        eventId: string,
        ownerVisitId: string,
        offset: number,
      ) =>
        insertEvent.run(
          eventPk,
          eventId,
          siteId,
          ownerVisitId,
          baseMs + offset,
          baseMs + offset,
          eventPk,
        );

      // Two visitors tie on all four list sort values. The remaining rows add
      // independent primary ties, while sessions retain negative/fractional
      // aggregate durations for the SEM065 raw-sort/display-mapper contract.
      addVisit({
        visitId: "alpha-docs-first",
        visitorId: "visitor-alpha",
        sessionId: "session-alpha-main",
        offset: 10_000,
        lastActivityOffset: 50_000,
        durationMs: 0.4,
        pathname: "/docs",
      });
      addVisit({
        visitId: "alpha-docs-second",
        visitorId: "visitor-alpha",
        sessionId: "session-alpha-main",
        offset: 20_000,
        lastActivityOffset: 50_000,
        durationMs: 0.2,
        pathname: "/docs",
      });
      addVisit({
        visitId: "alpha-pricing-third",
        visitorId: "visitor-alpha",
        sessionId: "session-alpha-main",
        offset: 50_000,
        lastActivityOffset: 50_000,
        durationMs: 0.3,
        pathname: "/pricing",
      });
      addVisit({
        visitId: "alpha-pricing-extra-session",
        visitorId: "visitor-alpha",
        sessionId: "session-alpha-extra",
        offset: 30_000,
        lastActivityOffset: 50_000,
        durationMs: -1.4,
        pathname: "/pricing",
      });
      addVisit({
        visitId: "beta-docs-first",
        visitorId: "visitor-beta",
        sessionId: "session-beta-main",
        offset: 10_000,
        lastActivityOffset: 50_000,
        durationMs: 0.6,
        pathname: "/docs",
      });
      addVisit({
        visitId: "beta-docs-second",
        visitorId: "visitor-beta",
        sessionId: "session-beta-main",
        offset: 25_000,
        lastActivityOffset: 50_000,
        durationMs: 0.1,
        pathname: "/docs",
      });
      addVisit({
        visitId: "beta-docs-third",
        visitorId: "visitor-beta",
        sessionId: "session-beta-main",
        offset: 50_000,
        lastActivityOffset: 50_000,
        durationMs: 0.1,
        pathname: "/pricing",
      });
      addVisit({
        visitId: "beta-pricing-extra-session",
        visitorId: "visitor-beta",
        sessionId: "session-beta-extra",
        offset: 30_000,
        lastActivityOffset: 50_000,
        durationMs: 0.8,
        pathname: "/pricing",
      });
      addVisit({
        visitId: "gamma-pricing",
        visitorId: "visitor-gamma",
        sessionId: "session-gamma",
        offset: 30_000,
        durationMs: 2.5,
        pathname: "/pricing",
      });
      addVisit({
        visitId: "cross-pricing-session",
        visitorId: "visitor-cross-session",
        sessionId: "session-cross-event",
        offset: 39_000,
        durationMs: -0.6,
        pathname: "/pricing",
      });
      addVisit({
        visitId: "cross-docs-session",
        visitorId: "visitor-cross-session",
        sessionId: "session-cross-page",
        offset: 40_000,
        durationMs: 1.25,
        pathname: "/docs",
      });
      addVisit({
        visitId: "dropoff-docs",
        visitorId: "visitor-dropoff",
        sessionId: "session-dropoff",
        offset: 60_000,
        durationMs: 0.8,
        pathname: "/docs",
      });
      addVisit({
        visitId: "filtered-docs",
        visitorId: "visitor-filtered",
        sessionId: "session-filtered",
        offset: 65_000,
        durationMs: 0.8,
        pathname: "/docs",
        country: "CA",
      });
      addSignup(1, "alpha-signup-tied-page", "alpha-docs-first", 10_000);
      addSignup(2, "gamma-signup-without-docs", "gamma-pricing", 35_000);
      addSignup(3, "cross-signup-tied-page", "cross-pricing-session", 40_000);
      addSignup(4, "filtered-signup", "filtered-docs", 66_000);
      addSignup(
        5,
        "alpha-extra-session-payload",
        "alpha-pricing-extra-session",
        40_000,
      );

      const payloadEvents = [
        "alpha-signup-tied-page",
        "gamma-signup-without-docs",
        "alpha-extra-session-payload",
      ].map(
        (eventId) =>
          sqlite.database
            .prepare(
              "SELECT event_pk, event_name_id FROM custom_events WHERE event_id = ?",
            )
            .get(eventId) as {
            readonly event_pk: number;
            readonly event_name_id: number;
          },
      );
      for (let index = 0; index < 40; index += 1) {
        const path = `/wave70/payload-${index}`;
        sqlite.database
          .prepare(
            `INSERT INTO custom_event_json_paths
             (site_id, path, last_seen_at, site_pk) VALUES (?, ?, ?, 1)`,
          )
          .run(siteId, path, baseMs + 10_000);
        const pathRow = sqlite.database
          .prepare(
            "SELECT id FROM custom_event_json_paths WHERE site_pk = 1 AND path = ?",
          )
          .get(path) as { readonly id: number };
        for (const payloadEvent of payloadEvents) {
          sqlite.database
            .prepare(
              `INSERT INTO custom_event_json_nodes
               (event_pk, node_id, path_id, value_type, depth)
               VALUES (?, ?, ?, 1, 1)`,
            )
            .run(payloadEvent.event_pk, index + 1, pathRow.id);
          sqlite.database
            .prepare(
              `INSERT INTO custom_event_json_values (
                 event_pk, node_id, site_id, event_name_id, path_id,
                 occurred_at, value_type, string_value, site_pk
               ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, 1)`,
            )
            .run(
              payloadEvent.event_pk,
              index + 1,
              siteId,
              payloadEvent.event_name_id,
              pathRow.id,
              baseMs + 10_000,
              `payload-${index}`,
            );
        }
      }

      for (const key of [
        "firstSeenAt",
        "lastSeenAt",
        "sessions",
        "views",
      ] as const) {
        for (const direction of ["asc", "desc"] as const) {
          for (const limit of [1, 2] as const) {
            const sort = { key, direction } as const;
            const options = { limit, sort };
            const callStart = sqlite.calls.length;
            const parentFirst = await queryVisitorListPageFromParentOracle(
              sqlite.env,
              siteId,
              targetWindow,
              EMPTY_FILTER_DOCUMENT,
              options,
            );
            const parentCall = sqlite.calls[callStart]!;
            const currentFirst = await queryVisitorListPageFromD1(
              sqlite.env,
              siteId,
              targetWindow,
              EMPTY_FILTER_DOCUMENT,
              options,
            );
            const currentCall = sqlite.calls[callStart + 1]!;
            expect(currentFirst).toEqual(parentFirst);
            expect(parentFirst.rows).toHaveLength(limit);
            expect(parentFirst.nextCursor).not.toBeNull();

            const parentAfter = await queryVisitorListPageFromParentOracle(
              sqlite.env,
              siteId,
              targetWindow,
              EMPTY_FILTER_DOCUMENT,
              { ...options, cursor: parentFirst.nextCursor },
            );
            const currentAfter = await queryVisitorListPageFromD1(
              sqlite.env,
              siteId,
              targetWindow,
              EMPTY_FILTER_DOCUMENT,
              { ...options, cursor: currentFirst.nextCursor },
            );
            expect(currentAfter).toEqual(parentAfter);
            expect(parentAfter.rows).toHaveLength(limit);
            expect(parentAfter.nextCursor).not.toBeNull();
            if (key === "firstSeenAt" && direction === "asc" && limit === 1) {
              expect(parentFirst.rows[0]?.visitorId).toBe("visitor-alpha");
              expect(parentAfter.rows[0]?.visitorId).toBe("visitor-beta");
            }
            void parentCall;
            void currentCall;
          }
        }
      }

      for (const key of ["startedAt", "durationMs", "views"] as const) {
        for (const direction of ["asc", "desc"] as const) {
          for (const limit of [1, 2] as const) {
            const sort = { key, direction } as const;
            const options = { limit, sort };
            const callStart = sqlite.calls.length;
            const parentFirst = await querySessionListPageFromParentOracle(
              sqlite.env,
              siteId,
              targetWindow,
              EMPTY_FILTER_DOCUMENT,
              options,
            );
            const parentCall = sqlite.calls[callStart]!;
            const currentFirst = await querySessionListPageFromD1(
              sqlite.env,
              siteId,
              targetWindow,
              EMPTY_FILTER_DOCUMENT,
              options,
            );
            const currentCall = sqlite.calls[callStart + 1]!;
            expect(currentFirst).toEqual(parentFirst);
            expect(parentFirst.rows).toHaveLength(limit);
            expect(parentFirst.nextCursor).not.toBeNull();

            const parentAfter = await querySessionListPageFromParentOracle(
              sqlite.env,
              siteId,
              targetWindow,
              EMPTY_FILTER_DOCUMENT,
              { ...options, cursor: parentFirst.nextCursor },
            );
            const currentAfter = await querySessionListPageFromD1(
              sqlite.env,
              siteId,
              targetWindow,
              EMPTY_FILTER_DOCUMENT,
              { ...options, cursor: currentFirst.nextCursor },
            );
            expect(currentAfter).toEqual(parentAfter);
            expect(parentAfter.rows).toHaveLength(limit);
            expect(parentAfter.nextCursor).not.toBeNull();
            if (key === "durationMs" && direction === "asc" && limit === 1) {
              expect(parentFirst.rows[0]).toMatchObject({
                sessionId: "session-alpha-extra",
                durationMs: 0,
              });
              expect(parentFirst.nextCursor?.sortValue).toBe(0);
              expect(
                parentAfter.rows.some(
                  (row) => row.sessionId === "session-cross-event",
                ),
              ).toBe(false);
            }
            void parentCall;
            void currentCall;
          }
        }
      }

      const rawDurations = sqlite.database
        .prepare(
          `SELECT session_id, SUM(COALESCE(duration_ms, 0)) AS raw_ms
           FROM visits WHERE site_id = ? GROUP BY session_id`,
        )
        .all(siteId) as Array<{ session_id: string; raw_ms: number }>;
      expect(rawDurations).toContainEqual({
        session_id: "session-alpha-main",
        raw_ms: 0.9,
      });
      expect(rawDurations).toContainEqual({
        session_id: "session-alpha-extra",
        raw_ms: -1.4,
      });

      for (const target of [
        { type: "visitor" as const, value: "visitor-alpha" },
        { type: "session" as const, value: "session-alpha-main" },
      ]) {
        const options = {
          limit: 20,
          sort: { key: "startedAt" as const, direction: "desc" as const },
          target,
        };
        const parent = await querySessionListPageFromParentOracle(
          sqlite.env,
          siteId,
          targetWindow,
          EMPTY_FILTER_DOCUMENT,
          options,
        );
        const current = await querySessionListPageFromD1(
          sqlite.env,
          siteId,
          targetWindow,
          EMPTY_FILTER_DOCUMENT,
          options,
        );
        expect(current).toEqual(parent);
        expect(parent.rows.length).toBeGreaterThan(0);
      }

      const funnelConfig = (progressionScope: "visitor" | "session") => ({
        filterDslVersion: 1 as const,
        progressionScope,
        conversionWindowMs: progressionScope === "visitor" ? 5_000 : null,
        steps: [
          { id: "docs", filterDsl: 'page.path eq "/docs"' },
          { id: "signup", filterDsl: 'event.name eq "signup"' },
        ],
      });
      const expected = {
        visitor: {
          visitor: {
            step0: [
              "visitor-alpha",
              "visitor-beta",
              "visitor-cross-session",
              "visitor-dropoff",
            ],
            converted: ["visitor-alpha", "visitor-cross-session"],
            dropoff: ["visitor-beta", "visitor-dropoff"],
          },
          session: {
            step0: [
              "session-alpha-main",
              "session-alpha-extra",
              "session-beta-main",
              "session-beta-extra",
              "session-cross-page",
              "session-cross-event",
              "session-dropoff",
            ],
            converted: [
              "session-alpha-main",
              "session-alpha-extra",
              "session-cross-page",
              "session-cross-event",
            ],
            dropoff: [
              "session-beta-main",
              "session-beta-extra",
              "session-dropoff",
            ],
          },
        },
        session: {
          visitor: {
            step0: [
              "visitor-alpha",
              "visitor-beta",
              "visitor-cross-session",
              "visitor-dropoff",
            ],
            converted: ["visitor-alpha"],
            dropoff: [
              "visitor-beta",
              "visitor-cross-session",
              "visitor-dropoff",
            ],
          },
          session: {
            step0: [
              "session-alpha-main",
              "session-beta-main",
              "session-cross-page",
              "session-dropoff",
            ],
            converted: ["session-alpha-main"],
            dropoff: [
              "session-beta-main",
              "session-cross-page",
              "session-dropoff",
            ],
          },
        },
      } as const;
      const funnelEvidence: Array<Record<string, unknown>> = [];
      for (const progressionScope of ["visitor", "session"] as const) {
        for (const entity of ["visitor", "session"] as const) {
          const query =
            entity === "visitor"
              ? (
                  source: "parent" | "current",
                  analysis: NonNullable<
                    Parameters<typeof queryVisitorListPageFromD1>[4]["analysis"]
                  >,
                ) => {
                  const reader =
                    source === "parent"
                      ? queryVisitorListPageFromParentOracle
                      : queryVisitorListPageFromD1;
                  return reader(
                    sqlite.env,
                    siteId,
                    targetWindow,
                    globalFilters,
                    {
                      limit: 100,
                      sort: { key: "lastSeenAt", direction: "desc" },
                      analysis,
                    },
                  );
                }
              : (
                  source: "parent" | "current",
                  analysis: NonNullable<
                    Parameters<typeof querySessionListPageFromD1>[4]["analysis"]
                  >,
                ) => {
                  const reader =
                    source === "parent"
                      ? querySessionListPageFromParentOracle
                      : querySessionListPageFromD1;
                  return reader(
                    sqlite.env,
                    siteId,
                    targetWindow,
                    globalFilters,
                    {
                      limit: 100,
                      sort: { key: "startedAt", direction: "desc" },
                      analysis,
                    },
                  );
                };
          const cases = [
            {
              label: "step0-converted",
              analysis: {
                type: "funnel" as const,
                config: funnelConfig(progressionScope),
                stepIndex: 0,
              },
              ids: expected[progressionScope][entity].step0,
            },
            {
              label: "later-converted",
              analysis: {
                type: "funnel" as const,
                config: funnelConfig(progressionScope),
                stepIndex: 1,
                outcome: "converted" as const,
              },
              ids: expected[progressionScope][entity].converted,
            },
            {
              label: "later-dropoff",
              analysis: {
                type: "funnel" as const,
                config: funnelConfig(progressionScope),
                stepIndex: 1,
                outcome: "dropoff" as const,
              },
              ids: expected[progressionScope][entity].dropoff,
            },
          ];
          for (const testCase of cases) {
            const start = sqlite.calls.length;
            const parent = await query("parent", testCase.analysis);
            const parentCall = sqlite.calls[start]!;
            const current = await query("current", testCase.analysis);
            const currentCall = sqlite.calls[start + 1]!;
            expect(current).toEqual(parent);
            const actualIds = parent.rows
              .map((row) =>
                entity === "visitor"
                  ? (row as { visitorId: string }).visitorId
                  : (row as { sessionId: string }).sessionId,
              )
              .sort();
            expect(
              actualIds,
              `${progressionScope}/${entity}/${testCase.label}: ${JSON.stringify(parent.rows)}`,
            ).toEqual([...testCase.ids].sort());
            if (testCase.label === "later-converted")
              expect(parent.rows.length).toBeGreaterThan(0);
            funnelEvidence.push({
              progressionScope,
              entity,
              case: testCase.label,
              resultCount: parent.rows.length,
              parent: sqliteStatementEvidence(parentCall),
              current: sqliteStatementEvidence(currentCall),
            });
          }
        }
      }

      const highConditionGlobalFilter: FilterDocument = {
        version: 1,
        root: {
          kind: "or",
          children: Array.from({ length: 40 }, (_unused, index) =>
            condition(
              "page.path",
              index === 0 ? "/docs" : `/unmatched-${index}`,
            ),
          ),
        },
      };
      const globalFilterChildren =
        globalFilters.root?.kind === "and" ? globalFilters.root.children : [];
      const direct40PayloadGlobalFilter = prepareScopedFilters(
        "visitors",
        "visitor",
        {
          kind: "and",
          children: [
            ...globalFilterChildren,
            ...Array.from({ length: 40 }, (_unused, index) => ({
              kind: "condition" as const,
              target: {
                kind: "event-payload" as const,
                path: `/wave70/payload-${index}` as CanonicalJsonPath,
              },
              operator: "exists" as const,
            })),
          ],
        },
        targetWindow,
      );
      const costCases = [
        {
          name: "default",
          filters: EMPTY_FILTER_DOCUMENT,
          options: {
            limit: 20,
            sort: { key: "lastSeenAt" as const, direction: "desc" as const },
          },
        },
        {
          name: "search",
          filters: EMPTY_FILTER_DOCUMENT,
          options: {
            limit: 20,
            sort: { key: "lastSeenAt" as const, direction: "desc" as const },
            search: "visitor-alpha",
          },
        },
        {
          name: "direct-global-40-condition",
          filters: highConditionGlobalFilter,
          options: {
            limit: 20,
            sort: { key: "lastSeenAt" as const, direction: "desc" as const },
          },
        },
        {
          name: "direct-global-40-payload-list",
          filters: direct40PayloadGlobalFilter,
          options: {
            limit: 20,
            sort: { key: "lastSeenAt" as const, direction: "desc" as const },
          },
        },
        {
          name: "analysis",
          filters: globalFilters,
          options: {
            limit: 20,
            sort: { key: "lastSeenAt" as const, direction: "desc" as const },
            analysis: {
              type: "funnel" as const,
              config: {
                filterDslVersion: 1 as const,
                progressionScope: "visitor" as const,
                conversionWindowMs: 5_000,
                steps: [{ id: "docs", filterDsl: 'page.path eq "/docs"' }],
              },
              stepIndex: 0,
            },
          },
        },
      ];
      const costEvidence: Array<Record<string, unknown>> = [];
      for (const testCase of costCases) {
        console.info("wave70_journey_list_cost_case", testCase.name);
        const start = sqlite.calls.length;
        const parent = await queryVisitorListPageFromParentOracle(
          sqlite.env,
          siteId,
          targetWindow,
          testCase.filters,
          testCase.options,
        );
        const parentCall = sqlite.calls[start]!;
        const parentEvidence = sqliteQueryEvidence(sqlite, parentCall);
        let current;
        try {
          current = await queryVisitorListPageFromD1(
            sqlite.env,
            siteId,
            targetWindow,
            testCase.filters,
            testCase.options,
          );
        } catch (error) {
          if (
            testCase.name !== "direct-global-40-payload-list" ||
            !(error instanceof D1StatementBudgetError)
          )
            throw error;
          const logicalPlan = buildJourneyVisitorListReportPlan({
            siteId,
            window: targetWindow,
            filters: testCase.filters,
            limit: testCase.options.limit,
            sort: testCase.options.sort,
          });
          const blockedCase = {
            scenario: testCase.name,
            parent: parentEvidence,
            current: {
              guard: error.code,
              budgetItem: error.item,
              actual: error.actual,
              limit: error.limit,
              tag: error.tag,
              sqlUnavailableBecauseTheGuardRunsBeforePrepare: true,
            },
            logicalPlanDiagram: printLogicalPlan(logicalPlan),
          };
          costEvidence.push(blockedCase);
          persistWave70CostEvidence({
            costCases: costEvidence,
            funnelContracts: funnelEvidence,
          });
          console.info(
            "wave70_journey_list_budget_blocked_case",
            JSON.stringify({
              scenario: testCase.name,
              parentRows: parent.rows.length,
              guard: error.code,
              budgetItem: error.item,
              actual: error.actual,
              limit: error.limit,
              logicalNodes: logicalPlan.nodes.length,
              logicalDiagramCharacters: blockedCase.logicalPlanDiagram.length,
            }),
          );
          continue;
        }
        const currentCall = sqlite.calls[start + 1]!;
        expect(current).toEqual(parent);
        expect(parent.rows.length).toBeGreaterThan(0);
        let currentPhysicalPlanHash: string | undefined;
        if (testCase.name === "direct-global-40-payload-list") {
          expect(parent.rows.map((row) => row.visitorId).sort()).toEqual([
            "visitor-alpha",
            "visitor-gamma",
          ]);
          const productionPlan = buildJourneyVisitorListReportPlan({
            siteId,
            window: targetWindow,
            filters: testCase.filters,
            limit: testCase.options.limit,
            sort: testCase.options.sort,
          });
          const compiled = compileJourneyReport(productionPlan);
          expect(compiled.sql).toBe(currentCall.sql);
          currentPhysicalPlanHash = d1PhysicalPlanHash(compiled);
          expect(currentPhysicalPlanHash).toMatch(/^v[123]:/u);
        }
        const currentEvidence = sqliteQueryEvidence(
          sqlite,
          currentCall,
          currentPhysicalPlanHash,
        );
        expect(currentEvidence.bindingCount).toBeLessThanOrEqual(100);
        expect(currentEvidence.sqlBytes).toBeLessThanOrEqual(100_000);
        costEvidence.push({
          scenario: testCase.name,
          parent: parentEvidence,
          current: currentEvidence,
        });
      }

      const payloadSessionFilters = prepareScopedFilters(
        "sessions",
        "session",
        {
          kind: "and",
          children: [
            ...globalFilterChildren,
            ...Array.from({ length: 40 }, (_unused, index) => ({
              kind: "condition" as const,
              target: {
                kind: "event-payload" as const,
                path: `/wave70/payload-${index}` as CanonicalJsonPath,
              },
              operator: "exists" as const,
            })),
          ],
        },
        targetWindow,
      );
      const visitorPayloadOptions = {
        limit: 1,
        sort: { key: "lastSeenAt" as const, direction: "desc" as const },
      };
      const visitorFirstStart = sqlite.calls.length;
      const parentVisitorFirst = await queryVisitorListPageFromParentOracle(
        sqlite.env,
        siteId,
        targetWindow,
        direct40PayloadGlobalFilter,
        visitorPayloadOptions,
      );
      const parentVisitorFirstCall = sqlite.calls[visitorFirstStart]!;
      const currentVisitorFirst = await queryVisitorListPageFromD1(
        sqlite.env,
        siteId,
        targetWindow,
        direct40PayloadGlobalFilter,
        visitorPayloadOptions,
      );
      const currentVisitorFirstCall = sqlite.calls[visitorFirstStart + 1]!;
      expect(currentVisitorFirst).toEqual(parentVisitorFirst);
      expect(parentVisitorFirst.rows).toHaveLength(1);
      expect(parentVisitorFirst.nextCursor).not.toBeNull();

      const visitorAfterOptions = {
        ...visitorPayloadOptions,
        cursor: parentVisitorFirst.nextCursor,
      };
      const parentVisitorAfter = await queryVisitorListPageFromParentOracle(
        sqlite.env,
        siteId,
        targetWindow,
        direct40PayloadGlobalFilter,
        visitorAfterOptions,
      );
      const parentVisitorAfterCall = sqlite.calls.at(-1)!;
      const currentVisitorAfter = await queryVisitorListPageFromD1(
        sqlite.env,
        siteId,
        targetWindow,
        direct40PayloadGlobalFilter,
        { ...visitorPayloadOptions, cursor: currentVisitorFirst.nextCursor },
      );
      const currentVisitorAfterCall = sqlite.calls.at(-1)!;
      expect(currentVisitorAfter).toEqual(parentVisitorAfter);
      expect(parentVisitorAfter.rows).toHaveLength(1);
      expect(
        [...parentVisitorFirst.rows, ...parentVisitorAfter.rows].map(
          (row) => row.visitorId,
        ),
      ).toEqual(["visitor-alpha", "visitor-gamma"]);

      const visitorCursorPlan = (
        cursor?: typeof parentVisitorFirst.nextCursor | null,
      ) =>
        buildJourneyVisitorListReportPlan({
          siteId,
          window: targetWindow,
          filters: direct40PayloadGlobalFilter,
          limit: visitorPayloadOptions.limit,
          sort: visitorPayloadOptions.sort,
          ...(cursor ? { cursor } : {}),
        });
      const visitorCursorFirstCompiled =
        compileJourneyReport(visitorCursorPlan());
      const visitorCursorAfterCompiled = compileJourneyReport(
        visitorCursorPlan(currentVisitorFirst.nextCursor),
      );
      expect(visitorCursorFirstCompiled.sql).toBe(currentVisitorFirstCall.sql);
      expect(visitorCursorAfterCompiled.sql).toBe(currentVisitorAfterCall.sql);
      const visitorCursorEvidence = [
        {
          scenario: "payload40-visitor-first",
          parent: sqliteQueryEvidence(sqlite, parentVisitorFirstCall),
          current: sqliteQueryEvidence(
            sqlite,
            currentVisitorFirstCall,
            d1PhysicalPlanHash(visitorCursorFirstCompiled),
          ),
        },
        {
          scenario: "payload40-visitor-after-cursor",
          parent: sqliteQueryEvidence(sqlite, parentVisitorAfterCall),
          current: sqliteQueryEvidence(
            sqlite,
            currentVisitorAfterCall,
            d1PhysicalPlanHash(visitorCursorAfterCompiled),
          ),
        },
      ];

      const sessionPayloadOptions = {
        limit: 1,
        sort: { key: "durationMs" as const, direction: "asc" as const },
        target: { type: "visitor" as const, value: "visitor-alpha" },
      };
      const sessionFirstStart = sqlite.calls.length;
      const parentSessionFirst = await querySessionListPageFromParentOracle(
        sqlite.env,
        siteId,
        targetWindow,
        payloadSessionFilters,
        sessionPayloadOptions,
      );
      const parentSessionFirstCall = sqlite.calls[sessionFirstStart]!;
      const currentSessionFirst = await querySessionListPageFromD1(
        sqlite.env,
        siteId,
        targetWindow,
        payloadSessionFilters,
        sessionPayloadOptions,
      );
      const currentSessionFirstCall = sqlite.calls[sessionFirstStart + 1]!;
      expect(currentSessionFirst).toEqual(parentSessionFirst);
      expect(parentSessionFirst.rows).toHaveLength(1);
      expect(parentSessionFirst.nextCursor).not.toBeNull();

      const sessionAfterOptions = {
        ...sessionPayloadOptions,
        cursor: parentSessionFirst.nextCursor,
      };
      const parentSessionAfter = await querySessionListPageFromParentOracle(
        sqlite.env,
        siteId,
        targetWindow,
        payloadSessionFilters,
        sessionAfterOptions,
      );
      const parentSessionAfterCall = sqlite.calls.at(-1)!;
      const currentSessionAfter = await querySessionListPageFromD1(
        sqlite.env,
        siteId,
        targetWindow,
        payloadSessionFilters,
        {
          ...sessionPayloadOptions,
          cursor: currentSessionFirst.nextCursor,
        },
      );
      const currentSessionAfterCall = sqlite.calls.at(-1)!;
      expect(currentSessionAfter).toEqual(parentSessionAfter);
      expect(parentSessionAfter.rows).toHaveLength(1);
      expect(
        [...parentSessionFirst.rows, ...parentSessionAfter.rows].map(
          (row) => row.sessionId,
        ),
      ).toEqual(["session-alpha-extra", "session-alpha-main"]);

      const sessionCursorPlan = (
        cursor?: typeof parentSessionFirst.nextCursor | null,
      ) =>
        buildJourneySessionListReportPlan({
          siteId,
          window: targetWindow,
          filters: payloadSessionFilters,
          limit: sessionPayloadOptions.limit,
          sort: sessionPayloadOptions.sort,
          sessionTarget: sessionPayloadOptions.target,
          ...(cursor ? { cursor } : {}),
        });
      const sessionCursorFirstCompiled =
        compileJourneyReport(sessionCursorPlan());
      const sessionCursorAfterCompiled = compileJourneyReport(
        sessionCursorPlan(currentSessionFirst.nextCursor),
      );
      expect(sessionCursorFirstCompiled.sql).toBe(currentSessionFirstCall.sql);
      expect(sessionCursorAfterCompiled.sql).toBe(currentSessionAfterCall.sql);
      const sessionCursorEvidence = [
        {
          scenario: "payload40-session-duration-target-visitor-first",
          parent: sqliteQueryEvidence(sqlite, parentSessionFirstCall),
          current: sqliteQueryEvidence(
            sqlite,
            currentSessionFirstCall,
            d1PhysicalPlanHash(sessionCursorFirstCompiled),
          ),
        },
        {
          scenario: "payload40-session-duration-target-visitor-after-cursor",
          parent: sqliteQueryEvidence(sqlite, parentSessionAfterCall),
          current: sqliteQueryEvidence(
            sqlite,
            currentSessionAfterCall,
            d1PhysicalPlanHash(sessionCursorAfterCompiled),
          ),
        },
      ];
      for (const evidence of [
        ...visitorCursorEvidence,
        ...sessionCursorEvidence,
      ]) {
        const current = evidence.current;
        expect(current.sqlBytes).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
        expect(current.bindingCount).toBeLessThanOrEqual(
          D1_MAX_BOUND_PARAMETERS,
        );
        expect(current.physicalPlanHash).toMatch(/^v[123]:/u);
        costEvidence.push(evidence);
      }

      persistWave70CostEvidence({
        costCases: costEvidence,
        funnelContracts: funnelEvidence,
      });
      console.info(
        "wave70_journey_list_sqlite_evidence",
        JSON.stringify({
          funnel: funnelEvidence.map((entry) => ({
            progressionScope: entry.progressionScope,
            entity: entry.entity,
            case: entry.case,
            resultCount: entry.resultCount,
          })),
          queryCosts: costEvidence.map((entry) => {
            const parent = entry.parent as ReturnType<
              typeof sqliteQueryEvidence
            >;
            const current = entry.current as Record<string, unknown>;
            if ("guard" in current)
              return {
                scenario: entry.scenario,
                parent: {
                  sqlBytes: parent.sqlBytes,
                  bindings: parent.bindings.length,
                  eqpRows: parent.eqpRows,
                  byIndex: parent.byIndex,
                },
                current: {
                  guard: current.guard,
                  budgetItem: current.budgetItem,
                  actual: current.actual,
                  limit: current.limit,
                },
              };
            const query = current as ReturnType<typeof sqliteQueryEvidence>;
            return {
              scenario: entry.scenario,
              parent: {
                sqlBytes: parent.sqlBytes,
                bindings: parent.bindings.length,
                eqpRows: parent.eqpRows,
                byIndex: parent.byIndex,
              },
              current: {
                sqlBytes: query.sqlBytes,
                bindings: query.bindings.length,
                eqpRows: query.eqpRows,
                byIndex: query.byIndex,
              },
            };
          }),
        }),
      );
    } finally {
      sqlite.close();
    }
  }, 120_000);

  it("executes a prepared-128 identity snapshot against previous-window SQLite rows", async () => {
    const sqlite = createSqliteDetailEnv({ siteIds: [siteId, secondSiteId] });
    const previousWindow = {
      ...queryWindow(),
      endExclusiveMs: baseMs + 60_000,
    };
    const preparationWindow = {
      ...queryWindow(),
      startMs: baseMs + 120_000,
      endExclusiveMs: baseMs + 180_000,
    };
    try {
      sqlite.database
        .prepare(
          `INSERT INTO custom_event_names (id, site_id, name, last_seen_at)
           VALUES (1, ?, 'signup', ?)`,
        )
        .run(siteId, baseMs + 160_000);
      const insertVisit = sqlite.database.prepare(`
        INSERT INTO visits (
          visit_id, site_id, visitor_id, session_id, status, started_at,
          last_activity_at, pathname, hostname, country
        ) VALUES (?, ?, ?, ?, 'closed', ?, ?, ?, 'prepared.test', 'US')
      `);
      const addVisit = (
        visitId: string,
        ownerSite: string,
        visitorId: string,
        sessionId: string,
        offset: number,
        pathname: string,
      ) =>
        insertVisit.run(
          visitId,
          ownerSite,
          visitorId,
          sessionId,
          baseMs + offset,
          baseMs + offset,
          pathname,
        );
      addVisit(
        "prepared-page-selected",
        siteId,
        "visitor-selected-page",
        "session-selected-page",
        12_000,
        "/selected",
      );
      addVisit(
        "prepared-page-owner-outside",
        siteId,
        "visitor-owner-outside",
        "session-owner-outside",
        130_000,
        "/prepared-only",
      );
      addVisit(
        "prepared-page-cross-window-read",
        siteId,
        "visitor-cross-window",
        "session-cross-window",
        20_000,
        "/previous",
      );
      addVisit(
        "prepared-page-cross-window-match",
        siteId,
        "visitor-cross-window",
        "session-cross-window",
        135_000,
        "/prepared",
      );
      addVisit(
        "prepared-page-shared-site-a",
        siteId,
        "visitor-site-a-shared",
        "session-shared-raw-id",
        30_000,
        "/site-a",
      );
      addVisit(
        "prepared-page-shared-site-b",
        secondSiteId,
        "visitor-site-b-shared",
        "session-shared-raw-id",
        30_000,
        "/site-b",
      );
      const insertEvent = sqlite.database.prepare(`
        INSERT INTO custom_events (
          event_pk, event_id, site_id, visit_id, event_name_id, occurred_at,
          received_at, sequence, node_count, value_count
        ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, 0, 0)
      `);
      for (const [eventPk, eventId, ownerVisitId, offset] of [
        [1, "prepared-event-selected", "prepared-page-selected", 14_000],
        [
          2,
          "prepared-event-owner-outside",
          "prepared-page-owner-outside",
          25_000,
        ],
      ] as const) {
        insertEvent.run(
          eventPk,
          eventId,
          siteId,
          ownerVisitId,
          baseMs + offset,
          baseMs + offset,
          eventPk,
        );
      }
      const identities = [
        { siteId, id: "session-selected-page" },
        { siteId, id: "session-selected-page" },
        { siteId, id: "session-owner-outside" },
        { siteId, id: "session-cross-window" },
        { siteId, id: "session-shared-raw-id" },
        ...Array.from({ length: 123 }, (_unused, index) => ({
          siteId,
          id: `missing-prepared-session-${index}`,
        })),
        { siteId: secondSiteId, id: "session-shared-raw-id" },
      ];
      expect(
        identities.filter((identity) => identity.siteId === siteId),
      ).toHaveLength(128);
      const filters = preparedSessionIdentityFilters(
        preparationWindow,
        identities,
      );
      const options = {
        limit: 2,
        sort: { key: "startedAt" as const, direction: "desc" as const },
      };
      // The frozen parent statement can exceed production D1's 100-bind
      // guard for this identity list. Execute that oracle SQL directly in the
      // local SQLite fixture; only the new reader is a production-budget pass.
      const executeParentOffline = async (
        sql: string,
        bindings: Array<string | number | null>,
      ): Promise<D1Row[]> => {
        sqlite.calls.push({ sql, bindings });
        return sqlite.database
          .prepare(sql)
          .all(...bindings.map((value) => value as SQLInputValue)) as D1Row[];
      };
      const firstStart = sqlite.calls.length;
      const parentFirst = await querySessionListPageFromParentOracle(
        sqlite.env,
        siteId,
        previousWindow,
        filters,
        options,
        executeParentOffline,
      );
      const parentFirstCall = sqlite.calls[firstStart]!;
      const currentFirst = await querySessionListPageFromD1(
        sqlite.env,
        siteId,
        previousWindow,
        filters,
        options,
      );
      const currentFirstCall = sqlite.calls[firstStart + 1]!;
      expect(currentFirst).toEqual(parentFirst);
      expect(parentFirst.rows).toHaveLength(2);
      expect(parentFirst.nextCursor).not.toBeNull();

      const parentAfter = await querySessionListPageFromParentOracle(
        sqlite.env,
        siteId,
        previousWindow,
        filters,
        { ...options, cursor: parentFirst.nextCursor },
        executeParentOffline,
      );
      const parentAfterCall = sqlite.calls.at(-1)!;
      const currentAfter = await querySessionListPageFromD1(
        sqlite.env,
        siteId,
        previousWindow,
        filters,
        { ...options, cursor: currentFirst.nextCursor },
      );
      const currentAfterCall = sqlite.calls.at(-1)!;
      expect(currentAfter).toEqual(parentAfter);
      const allRows = [...parentFirst.rows, ...parentAfter.rows];
      expect(allRows.map((row) => row.sessionId).sort()).toEqual(
        [
          "session-cross-window",
          "session-owner-outside",
          "session-selected-page",
          "session-shared-raw-id",
        ].sort(),
      );
      expect(allRows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sessionId: "session-selected-page",
            views: 1,
            events: 1,
          }),
          expect.objectContaining({
            sessionId: "session-owner-outside",
            views: 0,
            events: 1,
          }),
          expect.objectContaining({
            sessionId: "session-shared-raw-id",
            visitorId: "visitor-site-a-shared",
            views: 1,
          }),
        ]),
      );
      const newEvidence = sqliteQueryEvidence(sqlite, currentFirstCall);
      const oldEvidence = sqliteQueryEvidence(sqlite, parentFirstCall);
      const parentCursorEvidence = sqliteQueryEvidence(sqlite, parentAfterCall);
      const currentCursorEvidence = sqliteQueryEvidence(
        sqlite,
        currentAfterCall,
      );
      expect(newEvidence.bindingCount).toBeLessThanOrEqual(100);
      expect(newEvidence.sqlBytes).toBeLessThanOrEqual(100_000);
      persistWave70CostEvidence({
        prepared128: {
          semantics:
            "Offline prepared identity snapshot: 128 distinct identities in metadata (129 source rows including one duplicate and 123 missing IDs), manually attached advancedMatches; preparation window differs from actual read window. This is not end-to-end advanced-filter evaluation.",
          preparationWindow,
          actualReadWindow: previousWindow,
          distinctPreparedIdentities: 128,
          rawIdentityRows: identities.length,
          returnedRows: allRows.length,
          parentProductionBudget:
            oldEvidence.bindingCount > 100 || oldEvidence.sqlBytes > 100_000
              ? "offline-only-over-budget"
              : "within-budget",
          parent: oldEvidence,
          current: newEvidence,
          parentCursor: parentCursorEvidence,
          currentCursor: currentCursorEvidence,
        },
      });
      console.info("wave70_journey_prepared128_sqlite_evidence", {
        preparationWindow,
        actualReadWindow: previousWindow,
        distinctPreparedIdentities: 128,
        rawIdentityRows: identities.length,
        returnedRows: allRows.length,
        parent: oldEvidence,
        current: newEvidence,
        parentCursor: parentCursorEvidence,
        currentCursor: currentCursorEvidence,
        parentProductionBudget:
          oldEvidence.bindingCount > 100 || oldEvidence.sqlBytes > 100_000
            ? "offline-only-over-budget"
            : "within-budget",
      });
    } finally {
      sqlite.close();
    }
  });

  it("distinguishes neq from NOT(eq) for Session and Visitor scopes on real SQLite data", async () => {
    const sqlite = createSqliteDetailEnv();
    const targetWindow = queryWindow();
    try {
      const insertVisit = sqlite.database.prepare(`
        INSERT INTO visits (
          visit_id, site_id, visitor_id, session_id, status, started_at,
          last_activity_at, pathname, hostname
        ) VALUES (?, ?, ?, ?, 'closed', ?, ?, ?, 'example.test')
      `);
      const addVisit = (
        visitId: string,
        visitorId: string,
        sessionId: string,
        pathname: string,
        offset: number,
      ) => {
        const startedAt = baseMs + offset;
        insertVisit.run(
          visitId,
          siteId,
          visitorId,
          sessionId,
          startedAt,
          startedAt,
          pathname,
        );
      };

      // Visitor A / Session A has both observations. Visitor B / Session B
      // has only /home, so the entity-level predicates have different sets.
      addVisit("neq-not-a-home", "visitor-a", "session-a", "/home", 1_000);
      addVisit(
        "neq-not-a-pricing",
        "visitor-a",
        "session-a",
        "/pricing",
        2_000,
      );
      addVisit("neq-not-b-home", "visitor-b", "session-b", "/home", 3_000);

      const neqRoot = condition("page.path", "/pricing", "neq");
      const notEqRoot: FilterExpression = {
        kind: "not",
        child: condition("page.path", "/pricing"),
      };
      const sessionIds = async (root: FilterExpression) =>
        (
          await querySessionsFromD1(
            sqlite.env,
            siteId,
            targetWindow,
            prepareScopedFilters("sessions", "session", root, targetWindow),
            20,
          )
        ).map((row) => row.sessionId);
      const visitorIds = async (root: FilterExpression) =>
        (
          await queryVisitorsFromD1(
            sqlite.env,
            siteId,
            targetWindow,
            prepareScopedFilters("visitors", "visitor", root, targetWindow),
            20,
          )
        ).map((row) => row.visitorId);

      const neqSessionIds = await sessionIds(neqRoot);
      expect(neqSessionIds).toEqual(
        expect.arrayContaining(["session-a", "session-b"]),
      );
      expect(neqSessionIds).toHaveLength(2);
      await expect(sessionIds(notEqRoot)).resolves.toEqual(["session-b"]);
      const neqVisitorIds = await visitorIds(neqRoot);
      expect(neqVisitorIds).toEqual(
        expect.arrayContaining(["visitor-a", "visitor-b"]),
      );
      expect(neqVisitorIds).toHaveLength(2);
      await expect(visitorIds(notEqRoot)).resolves.toEqual(["visitor-b"]);
    } finally {
      sqlite.close();
    }
  });

  it("keeps pageview metrics when a visitor has no session or custom event", async () => {
    const { env } = createD1Env([
      [
        visitorDetailVisitRow({
          sessionId: "",
          startedAt: baseMs,
          durationMs: 0,
        }),
      ],
    ]);

    const detail = await queryVisitorDetailFromD1(
      env,
      siteId,
      "visitor-1",
      "UTC",
    );

    expect(detail).toMatchObject({
      metrics: {
        totalEvents: 0,
        sessions: 0,
        views: 1,
        avgEventsPerSession: 0,
        bounceRate: 0,
        avgDurationMs: 0,
        p90DurationMs: 0,
        daysActive: 1,
        conversionEvents: 0,
        avgTimeBetweenSessionsMs: 0,
      },
      sessions: [],
      events: [expect.objectContaining({ id: "visit-1", kind: "pageview" })],
      visitedPages: [{ pathname: "/home", views: 1 }],
      eventDistribution: [{ eventType: "pageview", count: 1 }],
      activity: [expect.objectContaining({ count: 1 })],
    });
  });

  it("returns session detail with synthetic start and leave events", async () => {
    const { env } = createD1Env([
      [
        visitorDetailVisitRow({
          durationMs: 60_000,
          latitude: "37.7",
          longitude: "-122.4",
        }),
      ],
    ]);

    const detail = await querySessionDetailFromD1(env, siteId, "session-1");

    expect(detail?.session).toMatchObject({
      sessionId: "session-1",
      durationMs: 60_000,
    });
    expect(detail?.locationPoints).toEqual([
      {
        latitude: 37.7,
        longitude: -122.4,
        timestampMs: baseMs + 10_000,
        country: "US",
        region: "California",
        regionCode: "CA",
        city: "San Francisco",
        pointCount: 1,
      },
    ]);
    expect(detail?.events.map((event) => event.id)).toEqual([
      "session-leave:session-1",
      "visit-1",
      "session-start:session-1",
    ]);
    expect(detail?.eventDistribution).toEqual([
      { eventType: "leave", count: 1 },
      { eventType: "pageview", count: 1 },
      { eventType: "session start", count: 1 },
    ]);
  });

  it("sorts session detail events with id tie-breakers", async () => {
    const { env } = createD1Env([
      [
        visitorDetailVisitRow({
          status: "open",
          startedAt: baseMs,
          eventId: undefined,
          eventType: undefined,
          occurredAt: baseMs + 10_000,
          visitId: "visit-1",
        }),
        visitorDetailCustomEventRow({
          eventId: "z-event",
          occurredAt: baseMs + 10_000,
        }),
        visitorDetailCustomEventRow({
          eventId: "a-event",
          occurredAt: baseMs + 10_000,
          pathname: "/a",
        }),
      ],
    ]);

    const detail = await querySessionDetailFromD1(env, siteId, "session-1");

    expect(detail?.events.map((event) => event.id)).toEqual([
      "z-event",
      "a-event",
      "visit-1",
      "session-start:session-1",
    ]);
  });

  it("returns null when a session detail lookup has no matching session row", async () => {
    const { env } = createD1Env([[]]);

    await expect(
      querySessionDetailFromD1(env, siteId, "session-missing"),
    ).resolves.toBeNull();
  });

  it("omits leave events for active session detail rows", async () => {
    const { env } = createD1Env([
      [
        visitorDetailVisitRow({
          status: "open",
          endedAt: baseMs + 60_000,
        }),
      ],
    ]);

    const detail = await querySessionDetailFromD1(env, siteId, "session-1");

    expect(detail?.events.map((event) => event.kind)).toEqual([
      "pageview",
      "session_start",
    ]);
    expect(detail?.eventDistribution).toEqual([
      { eventType: "pageview", count: 1 },
      { eventType: "session start", count: 1 },
    ]);
  });

  it("maps direct detail query rows for sessions, events, and location points", async () => {
    const { env, calls } = createD1Env([
      [sessionRow({ sessionId: "session-2", totalDurationMs: "1500" })],
      [journeyEventRow({ id: "event-2", kind: "custom", eventType: "paid" })],
      [{ latitude: 1, longitude: 2, timestampMs: 3 }],
    ]);

    await expect(
      querySessionsForDetailFromD1(env, siteId, {
        type: "session",
        value: "session-2",
      }),
    ).resolves.toMatchObject([{ sessionId: "session-2", durationMs: 1500 }]);
    await expect(
      queryJourneyEventsForDetailFromD1(env, siteId, {
        type: "session",
        value: "session-2",
      }),
    ).resolves.toMatchObject([{ id: "event-2", kind: "custom" }]);
    await expect(
      querySessionLocationPointsFromD1(env, siteId, "session-2"),
    ).resolves.toEqual([
      {
        latitude: 1,
        longitude: 2,
        timestampMs: 3,
        country: "",
        region: "",
        regionCode: "",
        city: "",
        pointCount: 1,
      },
    ]);

    expect(calls[0].sql).toMatch(/session_id/u);
    expect(calls[0].bindings).toContain(siteId);
    expect(calls[0].bindings).toContain("session-2");
    expect(calls[1].sql).toContain("UNION ALL");
    expect(calls[2].bindings).toContain(siteId);
    expect(calls[2].bindings).toContain("session-2");
    expect(calls[2].sql).toContain("ABS(");
    expect(calls[2].sql).not.toMatch(/custom_events|custom_event_names/u);
  });
});
describe("edge journey list D1 queries", () => {
  it("uses the canonical visitor list query with default sorting", async () => {
    const window = queryWindow();
    const { env, calls } = createD1Env([
      [visitorRow({ visitorId: "visitor-2" })],
    ]);

    await expect(
      queryVisitorsFromD1(env, siteId, window, EMPTY_FILTER_DOCUMENT, 6),
    ).resolves.toMatchObject([{ visitorId: "visitor-2" }]);

    expect(calls[0].sql).toContain("ORDER BY");
    expect(calls[0].sql).toContain("LIMIT");
    expect(calls[0].bindings.at(-1)).toBe(7);
  });

  it("builds visitor list SQL with target, search, sorting, and pagination", async () => {
    const window = queryWindow();
    const { env, calls } = createD1Env([[visitorRow({ visitorId: 123 })]]);

    await expect(
      queryVisitorsFromD1(
        env,
        siteId,
        window,
        filterFixture({ country: "US" }),
        5,
        "123",
        { key: "views", direction: "asc" },
        "Chrome",
      ),
    ).resolves.toMatchObject([{ visitorId: "123", views: 3 }]);

    expect(calls[0].sql).toContain("ORDER BY");
    expect(calls[0].sql).toContain("LIMIT");
    expect(
      calls[0].bindings.some(
        (value) => typeof value === "string" && /chrome|pricing/iu.test(value),
      ),
    ).toBe(true);
    expect(calls[0].bindings.at(-1)).toBe(6);
  });

  it("builds session list SQL with session target and search filters", async () => {
    const window = queryWindow();
    const { env, calls } = createD1Env([[sessionRow()]]);

    await expect(
      querySessionsFromD1(
        env,
        siteId,
        window,
        filterFixture({ device: "desktop" }),
        7,
        { type: "session", value: "session-1" },
        { key: "durationMs", direction: "asc" },
        "pricing",
      ),
    ).resolves.toMatchObject([{ sessionId: "session-1", durationMs: 60_000 }]);

    expect(calls[0].sql).toContain("ORDER BY");
    expect(calls[0].sql).toContain("LIMIT");
    expect(
      calls[0].bindings.some(
        (value) => typeof value === "string" && /chrome|pricing/iu.test(value),
      ),
    ).toBe(true);
    expect(calls[0].bindings.at(-1)).toBe(8);
  });

  it("queries a target journey event list with visit filters and limit", async () => {
    const window = queryWindow();
    const { env, calls } = createD1Env([
      [journeyEventRow({ id: "event-3", kind: "custom", eventType: "paid" })],
    ]);

    await expect(
      queryJourneyEventsFromD1(
        env,
        siteId,
        window,
        filterFixture({ path: "/pricing" }),
        { type: "session", value: "session-1" },
        20,
      ),
    ).resolves.toMatchObject([{ id: "event-3", kind: "custom" }]);

    expect(calls[0].sql).toContain("ORDER BY");
    expect(calls[0].sql).toContain("LIMIT");
    expect(calls[0].sql).not.toContain("OFFSET");
    expect(calls[0].bindings).toContain("session-1");
    expect(calls[0].bindings).toContain("/pricing");
    expect(calls[0].bindings.at(-1)).toBe(21);
  });
});
describe("edge journey geo D1 queries", () => {
  it("passes geo aggregate calls through to the D1 implementation", async () => {
    const window = queryWindow();
    const { env } = createD1Env([
      [{ latitude: 1, longitude: 2, timestampMs: 3 }],
      [],
    ]);

    await expect(
      queryGeoPointAggregate(env, siteId, window, EMPTY_FILTER_DOCUMENT, 5),
    ).resolves.toEqual({
      points: [
        {
          latitude: 1,
          longitude: 2,
          timestampMs: 3,
          country: "",
          region: "",
          regionCode: "",
          city: "",
          pointCount: 1,
        },
      ],
      countryCounts: [],
      regionCounts: [],
      cityCounts: [],
    });
  });

  it("returns point data and country counts when no geo drilldown is active", async () => {
    const window = queryWindow();
    const { env, calls } = createD1Env([
      [
        {
          latitude: "42.5",
          longitude: "13.5",
          timestampMs: "100",
          country: "IT",
        },
      ],
      [{ country: "IT", views: "8", sessions: "4", visitors: "3" }],
    ]);

    await expect(
      queryGeoPointsFromD1(env, siteId, window, EMPTY_FILTER_DOCUMENT, 25),
    ).resolves.toEqual({
      points: [
        {
          latitude: 42.5,
          longitude: 13.5,
          timestampMs: 100,
          country: "IT",
          region: "",
          regionCode: "",
          city: "",
          pointCount: 1,
        },
      ],
      countryCounts: [{ country: "IT", views: 8, sessions: 4, visitors: 3 }],
      regionCounts: [],
      cityCounts: [],
    });
    expect(calls[0].bindings.slice(0, 3)).toEqual(visitBindings(window));
    expect(calls[0].bindings.slice(-1)).toEqual([25]);
  });

  it("defaults missing geo country count fields", async () => {
    const window = queryWindow();
    const { env } = createD1Env([[], [{ country: null }]]);

    await expect(
      queryGeoPointsFromD1(env, siteId, window, EMPTY_FILTER_DOCUMENT, 10),
    ).resolves.toMatchObject({
      countryCounts: [{ country: "", views: 0, sessions: 0, visitors: 0 }],
      regionCounts: [],
      cityCounts: [],
    });
  });

  it("returns region counts when drilled into a country", async () => {
    const window = queryWindow();
    const { env } = createD1Env([
      [],
      [
        {
          country: "us",
          regionCode: "ca",
          region: "California",
          views: "5",
          sessions: "3",
          visitors: "2",
        },
        { country: "", regionCode: "", region: "", views: 1 },
      ],
    ]);

    await expect(
      queryGeoPointsFromD1(
        env,
        siteId,
        window,
        filterFixture({ geo: "US" }),
        10,
      ),
    ).resolves.toMatchObject({
      countryCounts: [],
      regionCounts: [
        {
          value: "US::CA::California",
          label: "California",
          views: 5,
          sessions: 3,
          visitors: 2,
        },
      ],
      cityCounts: [],
    });
  });

  it("returns city counts when drilled into a region or city scope", async () => {
    const window = queryWindow();
    const { env, calls } = createD1Env([
      [],
      [
        {
          country: "us",
          regionCode: "ca",
          region: "California",
          city: "San Francisco",
          views: "6",
          sessions: "4",
          visitors: "3",
        },
        { country: "US", city: "", views: 100 },
      ],
    ]);

    await expect(
      queryGeoPointsFromD1(
        env,
        siteId,
        window,
        filterFixture({ geo: "US::CA::California" }),
        10,
      ),
    ).resolves.toMatchObject({
      countryCounts: [],
      regionCounts: [],
      cityCounts: [
        {
          value: "US::CA::California::San Francisco",
          label: "San Francisco",
          views: 6,
          sessions: 4,
          visitors: 3,
        },
      ],
    });
    expect(calls).toHaveLength(2);
  });

  it("defaults missing geo dimension count fields", async () => {
    const window = queryWindow();
    const regionEnv = createD1Env([
      [],
      [
        {
          country: "us",
          regionCode: "ny",
        },
      ],
    ]);

    await expect(
      queryGeoPointsFromD1(
        regionEnv.env,
        siteId,
        window,
        filterFixture({ geo: "US" }),
        10,
      ),
    ).resolves.toMatchObject({
      regionCounts: [
        {
          value: "US::NY::NY",
          label: "NY",
          views: 0,
          sessions: 0,
          visitors: 0,
        },
      ],
      cityCounts: [],
    });

    const cityEnv = createD1Env([
      [],
      [
        {
          country: "us",
          city: "New York",
        },
      ],
    ]);

    await expect(
      queryGeoPointsFromD1(
        cityEnv.env,
        siteId,
        window,
        filterFixture({ geo: "US::NY::NY" }),
        10,
      ),
    ).resolves.toMatchObject({
      regionCounts: [],
      cityCounts: [
        {
          value: "US::New York",
          label: "New York",
          views: 0,
          sessions: 0,
          visitors: 0,
        },
      ],
    });
  });

  it("falls back to region names when building geo aggregate values", async () => {
    const window = queryWindow();
    const regionEnv = createD1Env([
      [],
      [
        {
          country: "ca",
          regionCode: "",
          region: "Ontario",
          views: "4",
          sessions: "2",
          visitors: "1",
        },
      ],
    ]);

    await expect(
      queryGeoPointsFromD1(
        regionEnv.env,
        siteId,
        window,
        filterFixture({ geo: "CA" }),
        10,
      ),
    ).resolves.toMatchObject({
      regionCounts: [
        {
          value: "CA::ONTARIO::Ontario",
          label: "Ontario",
          views: 4,
          sessions: 2,
          visitors: 1,
        },
      ],
      cityCounts: [],
    });

    const cityEnv = createD1Env([
      [],
      [
        {
          country: "ca",
          regionCode: "",
          region: "",
          city: "Toronto",
          views: "7",
          sessions: "3",
          visitors: "2",
        },
      ],
    ]);

    await expect(
      queryGeoPointsFromD1(
        cityEnv.env,
        siteId,
        window,
        filterFixture({ geo: "CA::ON::Ontario" }),
        10,
      ),
    ).resolves.toMatchObject({
      regionCounts: [],
      cityCounts: [
        {
          value: "CA::Toronto",
          label: "Toronto",
          views: 7,
          sessions: 3,
          visitors: 2,
        },
      ],
    });
  });
});
describe("edge journey handlers", () => {
  it("paginates visitors with a keyset cursor and trims hasMore rows", async () => {
    const window = queryWindow();
    const { env, calls } = createD1Env([
      [
        visitorRow({ visitorId: "visitor-1" }),
        visitorRow({ visitorId: "visitor-2" }),
      ],
    ]);

    const response = await handleVisitors(
      env,
      siteId,
      url("/visitors", {
        from: window.startMs,
        to: window.endExclusiveMs,
        limit: 1,
        sortBy: "views",
        sortDir: "asc",
        search: "Chrome",
      }),
    );

    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: {
        items: [{ visitorId: "visitor-1", views: 3, sessions: 2 }],
        pagination: {
          limit: 1,
          returned: 1,
          hasMore: true,
          nextCursor: expect.any(String),
        },
      },
    });
    expect(calls[0].sql).toContain("ORDER BY");
    expect(calls[0].sql).toContain("LIMIT");
    expect(calls[0].sql).not.toContain("OFFSET");
    expect(calls[0].bindings.at(-1)).toBe(2);
  });

  it("rejects invalid and mismatched journey cursors before querying D1", async () => {
    const window = queryWindow();
    const visitors = createD1Env([]);
    const sessions = createD1Env([]);
    const visitorCursor = "invalid-visitor-cursor";
    const sessionCursor = "invalid-session-cursor";

    await expect(
      handleVisitors(
        visitors.env,
        siteId,
        url("/visitors", {
          from: window.startMs,
          to: window.endExclusiveMs,
          limit: 120,
          cursor: visitorCursor,
          sortBy: "sessions",
        }),
      ),
    ).resolves.toMatchObject({ status: 400 });
    await expect(
      handleSessions(
        sessions.env,
        siteId,
        url("/sessions", {
          from: window.startMs,
          to: window.endExclusiveMs,
          limit: 120,
          cursor: sessionCursor,
          sortBy: "durationMs",
        }),
      ),
    ).resolves.toMatchObject({ status: 400 });
    expect(visitors.calls).toHaveLength(0);
    expect(sessions.calls).toHaveLength(0);
  });

  it("returns non-paged sessions with search and default metadata", async () => {
    const window = queryWindow();
    const { env, calls } = createD1Env([[sessionRow()]]);

    const response = await handleSessions(
      env,
      siteId,
      url("/sessions", {
        from: window.startMs,
        to: window.endExclusiveMs,
        limit: 3,
        search: "pricing",
      }),
    );

    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: {
        items: [{ sessionId: "session-1", visitorId: "visitor-1" }],
        pagination: {
          limit: 3,
          returned: 1,
          hasMore: false,
          nextCursor: null,
        },
      },
    });
    expect(
      calls[0].bindings.some(
        (value) => typeof value === "string" && /chrome|pricing/iu.test(value),
      ),
    ).toBe(true);
    expect(calls[0].bindings.at(-1)).toBe(4);
  });

  it("paginates sessions with a keyset cursor and trims the extra row", async () => {
    const window = queryWindow();
    const { env, calls } = createD1Env([
      [
        sessionRow({ sessionId: "session-1" }),
        sessionRow({ sessionId: "session-2" }),
      ],
    ]);

    const response = await handleSessions(
      env,
      siteId,
      url("/sessions", {
        from: window.startMs,
        to: window.endExclusiveMs,
        limit: 1,
        sortBy: "views",
        sortDir: "asc",
      }),
    );

    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: {
        items: [{ sessionId: "session-1" }],
        pagination: {
          limit: 1,
          returned: 1,
          hasMore: true,
          nextCursor: expect.any(String),
        },
      },
    });
    expect(calls[0].sql).toContain("ORDER BY");
    expect(calls[0].sql).toContain("LIMIT");
    expect(calls[0].sql).not.toContain("OFFSET");
    expect(calls[0].bindings.at(-1)).toBe(2);
  });

  it("adds a seek predicate after Journey aggregation for a supplied cursor", async () => {
    const window = queryWindow();
    const { env, calls } = createD1Env([
      [visitorRow({ visitorId: "visitor-2" })],
    ]);
    const cursor = "invalid-visitor-cursor";

    await expect(
      handleVisitors(
        env,
        siteId,
        url("/visitors", {
          from: window.startMs,
          to: window.endExclusiveMs,
          limit: 1,
          cursor,
          sortBy: "views",
          sortDir: "asc",
        }),
      ),
    ).resolves.toMatchObject({ status: 400 });
    expect(calls).toEqual([]);
  });

  it("rejects invalid list windows before querying D1", async () => {
    const { env, calls } = createD1Env([]);

    const visitors = await handleVisitors(
      env,
      siteId,
      new URL("https://edge.test/visitors?from=20&to=10"),
    );
    const sessions = await handleSessions(
      env,
      siteId,
      new URL("https://edge.test/sessions?from=20&to=10"),
    );

    expect(visitors.status).toBe(400);
    expect(sessions.status).toBe(400);
    await expect(visitors.json()).resolves.toMatchObject({
      ok: false,
      error: { message: "Invalid time window" },
    });
    await expect(sessions.json()).resolves.toMatchObject({
      ok: false,
      error: { message: "Invalid time window" },
    });
    expect(calls).toEqual([]);
  });

  it("validates missing detail ids before querying D1", async () => {
    const { env, calls } = createD1Env([]);

    const visitor = await handleVisitorDetail(
      env,
      siteId,
      new URL("https://edge.test/visitor-detail"),
    );
    const session = await handleSessionDetail(
      env,
      siteId,
      new URL("https://edge.test/session-detail"),
    );

    expect(visitor.status).toBe(400);
    expect(session.status).toBe(400);
    await expect(visitor.json()).resolves.toMatchObject({
      ok: false,
      error: { message: "Missing visitorId" },
    });
    await expect(session.json()).resolves.toMatchObject({
      ok: false,
      error: { message: "Missing sessionId" },
    });
    expect(calls).toEqual([]);
  });

  it("returns visitor and session detail handler payloads", async () => {
    const window = queryWindow();
    const { env } = createD1Env([
      [visitorDetailVisitRow()],
      [visitorDetailVisitRow({ latitude: 1, longitude: 2, startedAt: 3 })],
    ]);

    const visitor = await handleVisitorDetail(
      env,
      siteId,
      url("/visitor-detail", {
        visitorId: "visitor-1",
        timeZone: "Bad/Zone",
        from: window.startMs,
        to: window.endExclusiveMs,
      }),
    );
    const session = await handleSessionDetail(
      env,
      siteId,
      url("/session-detail", {
        sessionId: "session-1",
        from: window.startMs,
        to: window.endExclusiveMs,
      }),
    );

    await expect(visitor.json()).resolves.toMatchObject({
      ok: true,
      data: {
        visitor: { visitorId: "visitor-1" },
        metrics: { sessions: 1 },
      },
    });
    await expect(session.json()).resolves.toMatchObject({
      ok: true,
      data: {
        session: { sessionId: "session-1" },
        locationPoints: [{ latitude: 1, longitude: 2, timestampMs: 3 }],
      },
    });
  });
});
