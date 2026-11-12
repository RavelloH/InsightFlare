import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { createD1SiteQueryRuntime } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import type {
  AnalyticsResult,
  CanonicalQuery,
  CanonicalResult,
  FilterDocument,
  QueryInput,
  QueryTime,
  ScopedFilterPlan,
} from "@/lib/edge/analytics/contract";
import {
  createQueryTime,
  EMPTY_FILTER_DOCUMENT,
  prepareScopedQuery,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import type { AdvancedCountFilterMatchPlanInput } from "@/lib/edge/analytics/engine/advanced-count-filter-plan";
import { JOURNEY_SESSION_LIST_REPORT_OUTPUT } from "@/lib/edge/analytics/engine/journey-entity-list-report-plan";
import { buildJourneySessionListQualificationPlan } from "@/lib/edge/analytics/engine/journey-session-list-qualification-plan";
import { PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT } from "@/lib/edge/analytics/engine/page-dimension-qualification-plan";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import {
  d1AdvancedFilterMiddleware,
  prepareDeferredEventQualificationFallback,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { queryD1CompiledAll } from "@/lib/edge/analytics/providers/d1/internal/core";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import {
  queryJourneyTargetExistsFromD1,
  type SessionListCursor,
  sessionListPageFromRecords,
} from "@/lib/edge/analytics/providers/d1/internal/journey-list-queries";
import { compileQualificationProgramEnvelope } from "@/lib/edge/analytics/providers/d1/internal/qualification-program-envelope";
import {
  deferredSessionListQualificationFromQuery,
  sessionListQualificationConfigurationFromQuery,
} from "@/lib/edge/analytics/providers/d1/internal/session-list-qualification-request";
import { readSiteVisitorSessions } from "@/lib/edge/analytics/providers/d1/operations/site-journeys";
import {
  decodeSiteJourneyEventPageCursor,
  decodeSiteVisitorSessionsCursor,
  encodeSiteJourneyEventPageCursor,
  encodeSiteVisitorSessionsCursor,
} from "@/lib/edge/analytics/providers/d1/operations/site-journeys";
import type { Env } from "@/lib/edge/types";
import { parseFilterDsl } from "@/lib/filter-contract";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";
import { analyzeFilterDocument } from "@/lib/filter-contract/filter-semantics";

const SITE_ID = "wave97w-visitor-sessions";
const OTHER_SITE_ID = `${SITE_ID}-other-site`;
const VISITOR_ID = "visitor-a";
const OTHER_SITE_ONLY_VISITOR_ID = "visitor-only-other-site";
const BASE = Date.UTC(2026, 9, 1);
const END = BASE + 24 * 60 * 60 * 1000;
const FILTER_DSL = 'count(page { page.path eq "/match" }) gte 1';
const NATIVE_FILTER_DSL = 'page.path eq "/match"';
const EVIDENCE_DIRECTORY = process.env.INSIGHTFLARE_QUERY_EVIDENCE_DIR?.trim();
const EVIDENCE_FILENAME =
  process.env.INSIGHTFLARE_QUERY_EVIDENCE_FILENAME?.trim() ||
  "current-runtime.json";
const EVIDENCE_STATE =
  process.env.INSIGHTFLARE_QUERY_EVIDENCE_STATE?.trim() || "current-runtime";

type Scope = "session" | "visitor";
type VisitorSessionsPaginationScenario = {
  readonly name: string;
  readonly scope?: Scope;
  readonly filterKind: "empty" | "native" | "count";
};
const VISITOR_SESSIONS_PAGINATION_SCENARIOS: readonly VisitorSessionsPaginationScenario[] =
  [
    { name: "ordinary-empty", filterKind: "empty" },
    { name: "ordinary-native", filterKind: "native" },
    { name: "count-session", scope: "session", filterKind: "count" },
    { name: "count-visitor", scope: "visitor", filterKind: "count" },
  ];
type VisitorSessionsQuery = CanonicalQuery<"visitor-sessions">;
type VisitorSessionsResult = AnalyticsResult<
  CanonicalResult<"visitor-sessions">
>;

function writeEvidence(
  filename: string,
  value: unknown,
  state = EVIDENCE_STATE,
): void {
  if (!EVIDENCE_DIRECTORY) return;
  mkdirSync(EVIDENCE_DIRECTORY, { recursive: true });
  writeFileSync(
    join(EVIDENCE_DIRECTORY, filename),
    `${JSON.stringify({ state, value }, null, 2)}\n`,
    "utf8",
  );
}

function seedDatabase(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = OFF");
  database
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .run(SITE_ID);
  const site = database
    .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
    .get(SITE_ID) as { readonly site_pk: number };
  database
    .prepare(
      `INSERT INTO sites (id, team_id, name, domain, created_at)
       VALUES (?, 'wave97w-team', 'Visitor sessions qualification', 'wave97w.test', 0)`,
    )
    .run(SITE_ID);
  const insertVisit = database.prepare(
    `INSERT INTO visits (
      visit_id, site_id, site_pk, visitor_id, session_id, status,
      started_at, last_activity_at, pathname, hostname
    ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, 'wave97w.test')`,
  );
  for (const visit of [
    {
      id: "session-a-tie-1",
      sessionId: "session-a-tie-1",
      startedAt: BASE + 3_000,
      path: "/match",
    },
    {
      id: "session-a-tie-2",
      sessionId: "session-a-tie-2",
      startedAt: BASE + 3_000,
      path: "/match",
    },
    {
      id: "session-a-old",
      sessionId: "session-a-old",
      startedAt: BASE + 1_000,
      path: "/match",
    },
  ]) {
    insertVisit.run(
      visit.id,
      SITE_ID,
      site.site_pk,
      VISITOR_ID,
      visit.sessionId,
      visit.startedAt,
      visit.startedAt + 500,
      visit.path,
    );
  }

  database
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .run(OTHER_SITE_ID);
  const otherSite = database
    .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
    .get(OTHER_SITE_ID) as { readonly site_pk: number };
  database
    .prepare(
      `INSERT INTO sites (id, team_id, name, domain, created_at)
       VALUES (?, 'wave97w-team', 'Other site visitor isolation', 'other.wave97w.test', 0)`,
    )
    .run(OTHER_SITE_ID);
  insertVisit.run(
    "cross-site-same-visitor-session",
    OTHER_SITE_ID,
    otherSite.site_pk,
    VISITOR_ID,
    "cross-site-same-visitor-session",
    BASE + 4_000,
    BASE + 4_500,
    "/match",
  );
  insertVisit.run(
    "other-site-only-visitor-session",
    OTHER_SITE_ID,
    otherSite.site_pk,
    OTHER_SITE_ONLY_VISITOR_ID,
    "other-site-only-visitor-session",
    BASE + 5_000,
    BASE + 5_500,
    "/match",
  );

  insertVisit.run(
    "event-owner-outside-window",
    SITE_ID,
    site.site_pk,
    "visitor-event-only",
    "session-event-only",
    BASE - 24 * 60 * 60 * 1_000,
    BASE - 24 * 60 * 60 * 1_000 + 250,
    "/outside-window",
  );
  database
    .prepare(
      `INSERT INTO custom_event_names (site_id, name, last_seen_at, site_pk)
       VALUES (?, 'signup', ?, ?)
       ON CONFLICT(site_pk, name) DO NOTHING`,
    )
    .run(SITE_ID, BASE + 1_000, site.site_pk);
  const eventName = database
    .prepare(
      "SELECT id FROM custom_event_names WHERE site_pk = ? AND name = 'signup'",
    )
    .get(site.site_pk) as { readonly id: number };
  database
    .prepare(
      `INSERT INTO custom_events (
        event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
        received_at, node_count, value_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)`,
    )
    .run(
      "event-only-signup",
      SITE_ID,
      site.site_pk,
      "event-owner-outside-window",
      eventName.id,
      BASE + 1_000,
      BASE + 1_000,
    );
  insertVisit.run(
    "visitor-a-event-owner-outside-window",
    SITE_ID,
    site.site_pk,
    VISITOR_ID,
    "session-a-event-only",
    BASE - 24 * 60 * 60 * 1_000,
    BASE - 24 * 60 * 60 * 1_000 + 250,
    "/outside-window",
  );
  database
    .prepare(
      `INSERT INTO custom_events (
        event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
        received_at, node_count, value_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)`,
    )
    .run(
      "visitor-a-event-only-signup",
      SITE_ID,
      site.site_pk,
      "visitor-a-event-owner-outside-window",
      eventName.id,
      BASE + 1_500,
      BASE + 1_500,
    );
}

function queryInput(input: {
  readonly scope?: Scope;
  readonly filterKind: "empty" | "native" | "count";
  readonly cursor?: string | null;
  readonly visitorId?: string;
}): VisitorSessionsQuery {
  return {
    context: siteQueryContext(SITE_ID, "private-dashboard"),
    time: createQueryTime(BASE, END, "UTC", END),
    filters:
      input.filterKind === "count"
        ? parseFilterDsl(FILTER_DSL, analyticsFilterRegistry)
        : input.filterKind === "native"
          ? parseFilterDsl(NATIVE_FILTER_DSL, analyticsFilterRegistry)
          : EMPTY_FILTER_DOCUMENT,
    ...(input.scope ? { scopePreference: input.scope } : {}),
    visitorId: input.visitorId ?? VISITOR_ID,
    page: { limit: 1, cursor: input.cursor ?? null },
  } as VisitorSessionsQuery;
}

async function visitorSessionsMiddlewareQuery(
  env: Env,
  request: VisitorSessionsQuery,
): Promise<QueryInput & Record<string, unknown>> {
  const prepared = prepareScopedQuery(
    "visitor-sessions",
    request as never,
  ) as unknown as QueryInput & Record<string, unknown>;
  let middlewareQuery: unknown;
  await d1AdvancedFilterMiddleware(env, undefined, SITE_ID)(
    "visitor-sessions",
    prepared,
    async (query) => {
      middlewareQuery = query;
      return query;
    },
  );
  if (!middlewareQuery || typeof middlewareQuery !== "object")
    throw new Error("visitor_sessions_middleware_query_missing");
  return middlewareQuery as QueryInput & Record<string, unknown>;
}

async function legacyCountFilters(
  env: Env,
  scope: Scope,
): Promise<FilterDocument> {
  const middlewareQuery = await visitorSessionsMiddlewareQuery(
    env,
    queryInput({ scope, filterKind: "count" }),
  );
  const deferred = deferredSessionListQualificationFromQuery(middlewareQuery);
  if (!deferred || deferred.operation !== "visitor-sessions")
    throw new Error("visitor_sessions_qualification_request_missing");
  return prepareDeferredEventQualificationFallback(deferred.qualification);
}

function callsSince(trace: SqliteD1Trace, start: number) {
  return trace.preparedSql.slice(start).map((sql, index) => ({
    sql,
    bindings: trace.bindings[start + index] ?? [],
    sqlBytes: new TextEncoder().encode(sql).byteLength,
  }));
}

interface CapturedSqliteQuery {
  readonly sql: string;
  readonly rows: readonly unknown[];
}

function isQualificationEnvelopeSql(sql: string): boolean {
  return sql.includes('"rowKind"') && sql.includes('"outputId"');
}

function isJourneyTargetPresenceSql(sql: string): boolean {
  return !isQualificationEnvelopeSql(sql) && sql.includes('"present"');
}

function createVisitorSessionsTestDatabase(input: {
  readonly database: DatabaseSync;
  readonly trace: SqliteD1Trace;
  readonly captures: CapturedSqliteQuery[];
  readonly transformEnvelopeRow?: (
    row: Record<string, unknown>,
  ) => Record<string, unknown>;
}): NonNullable<Env["DB"]> {
  const base = createSqliteD1Database(input.database, input.trace);
  return {
    prepare(sql: string) {
      const statement = base.prepare(sql);
      const prepared = {
        bind(...values: Parameters<typeof statement.bind>) {
          statement.bind(...values);
          return prepared;
        },
        first<Row>() {
          return statement.first<Row>();
        },
        async all<Row>() {
          const result = await statement.all<Row>();
          const rows = result.results.map((row) =>
            isQualificationEnvelopeSql(sql) && input.transformEnvelopeRow
              ? (input.transformEnvelopeRow(
                  row as Record<string, unknown>,
                ) as Row)
              : row,
          );
          input.captures.push({ sql, rows });
          return { ...result, results: rows };
        },
        run() {
          return statement.run();
        },
      };
      return prepared as unknown as D1PreparedStatement;
    },
    batch(statements: D1PreparedStatement[]) {
      return base.batch(statements);
    },
  } as NonNullable<Env["DB"]>;
}

function visitorSessionsCountInput(scope: Scope) {
  const filters = parseFilterDsl(FILTER_DSL, analyticsFilterRegistry);
  const prepared = prepareScopedQuery("visitor-sessions", {
    context: siteQueryContext(SITE_ID, "private-dashboard"),
    time: createQueryTime(BASE, END, "UTC", END),
    filters,
    scopePreference: scope,
    visitorId: VISITOR_ID,
    page: { limit: 1, cursor: null },
  } as never) as VisitorSessionsQuery & {
    readonly time: QueryTime;
    readonly filters: FilterDocument;
    readonly scopePlan: ScopedFilterPlan;
  };
  const readRange = prepared.time.readRange ?? prepared.time.range;
  const count: AdvancedCountFilterMatchPlanInput = {
    subject: createSemanticSubjectDomain({
      origin: "site",
      siteIds: [SITE_ID as never],
    }),
    candidateRange: { ...prepared.time.range },
    readRange: { ...readRange },
    expressionRange: { ...prepared.time.range },
    expressionUsesExplicitRange: false,
    lowerBounds: [{ siteId: SITE_ID, startMs: readRange.startMs }],
    scope,
    reportingTimeZone: prepared.time.reportingTimeZone,
    capturedAtMs: prepared.time.capturedAtMs,
    analysis: analyzeFilterDocument(prepared.filters, analyticsFilterRegistry),
  };
  return { prepared, count };
}

function compileVisitorSessionsEnvelope(input: {
  readonly plan: ReturnType<typeof buildJourneySessionListQualificationPlan>;
  readonly siteId: string;
}) {
  const report = input.plan.plan.outputs.find(
    ({ id }) => id === JOURNEY_SESSION_LIST_REPORT_OUTPUT,
  );
  const controls = input.plan.plan.outputs.find(
    ({ id }) => id === PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT,
  );
  if (!report || !controls)
    throw new Error("visitor_sessions_qualification_outputs_missing");
  const reportFields = report.fields.map(({ name }) => name);
  const controlFields = controls.fields.map(({ name }) => name);
  return compileQualificationProgramEnvelope({
    qualification: input.plan,
    siteId: input.siteId,
    reports: [
      { output: report, fields: reportFields, rowType: "session-list" },
    ],
    controlsOutput: controls,
    reportFields,
    controlFields,
    ordering: [
      {
        outputId: JOURNEY_SESSION_LIST_REPORT_OUTPUT,
        field: "startedAt",
        direction: "desc",
        nulls: "last",
      },
      {
        outputId: JOURNEY_SESSION_LIST_REPORT_OUTPUT,
        field: "sessionId",
        direction: "asc",
        nulls: "last",
      },
    ],
    errorPrefix: "visitor_sessions_qualification",
    fallbackTag: "analytics.visitor_sessions_qualification",
  });
}

describe("visitor sessions qualification migration", () => {
  it.each(VISITOR_SESSIONS_PAGINATION_SCENARIOS)(
    "paginates visitor sessions through the canonical runtime ($name)",
    async (scenario) => {
      const database = createMigratedDatabase();
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const env = {
        DB: createSqliteD1Database(database, trace),
        MAIN_SECRET: "wave97w-visitor-sessions-cursor-secret",
      } as unknown as Env;
      try {
        seedDatabase(database);
        const diagnostics = createD1ReadDiagnostics();
        const runtime = createD1SiteQueryRuntime({
          env,
          siteId: SITE_ID,
          diagnostics,
        });
        const providerErrors: Array<{
          phase: string;
          name: string;
          message: string;
        }> = [];
        const pages: Array<{
          result: VisitorSessionsResult;
          calls: ReturnType<typeof callsSince>;
          qualificationEnvelopeCount: number;
          signedNextCursor: string | null;
        }> = [];
        let cursor: string | null = null;
        for (let pageIndex = 0; pageIndex < 6; pageIndex += 1) {
          const pageStart = trace.preparedSql.length;
          const result: VisitorSessionsResult = await runtime.execute(
            "visitor-sessions",
            queryInput({
              scope: scenario.scope,
              filterKind: scenario.filterKind,
              cursor,
            }),
            {
              onProviderError(error) {
                providerErrors.push({
                  phase: `page-${pageIndex + 1}`,
                  name: error instanceof Error ? error.name : typeof error,
                  message:
                    error instanceof Error ? error.message : String(error),
                });
              },
            },
          );
          const nextCursor: string | null = result.ok
            ? result.data.pagination.nextCursor
            : null;
          const calls = callsSince(trace, pageStart);
          pages.push({
            result,
            calls,
            qualificationEnvelopeCount: calls.filter(({ sql }) =>
              isQualificationEnvelopeSql(sql),
            ).length,
            signedNextCursor: nextCursor,
          });
          cursor = nextCursor;
          if (!cursor) break;
        }
        const records: Array<Record<string, unknown>> = [
          {
            scenario: scenario.name,
            scope: scenario.scope ?? "auto",
            providerErrors,
            fallbackReason: diagnostics.advancedCountSqlFallbackReason,
            pages,
          },
        ];

        writeEvidence(`${EVIDENCE_FILENAME}.${scenario.name}.json`, {
          siteId: SITE_ID,
          visitorId: VISITOR_ID,
          records,
        });

        const expectedIds = [
          "session-a-tie-1",
          "session-a-tie-2",
          "session-a-event-only",
          "session-a-old",
        ];
        for (const record of records) {
          const pages = record.pages as Array<{
            result: VisitorSessionsResult;
            qualificationEnvelopeCount: number;
            signedNextCursor: string | null;
          }>;
          const scenarioExpectedIds =
            record.scenario === "count-session"
              ? expectedIds.filter(
                  (sessionId) => sessionId !== "session-a-event-only",
                )
              : expectedIds;
          expect(
            pages.map(({ result }) => result.ok),
            JSON.stringify(record),
          ).toEqual(scenarioExpectedIds.map(() => true));
          const resultPages = pages.map(({ result }) => {
            if (!result.ok) throw new Error("visitor_sessions_page_failed");
            return result.data;
          });
          expect(
            resultPages.flatMap(({ items }) =>
              items.map(({ sessionId }) => sessionId),
            ),
          ).toEqual(scenarioExpectedIds);
          const eventOnly = resultPages
            .flatMap(({ items }) => items)
            .find(({ sessionId }) => sessionId === "session-a-event-only");
          if (eventOnly)
            expect(eventOnly).toMatchObject({ views: 0, events: 1 });
          expect(
            pages.map(({ signedNextCursor }) => signedNextCursor !== null),
          ).toEqual(
            scenarioExpectedIds.map(
              (_, index) => index < scenarioExpectedIds.length - 1,
            ),
          );
          expect(record.fallbackReason).toBeUndefined();
          expect(
            pages.map(
              ({ qualificationEnvelopeCount }) => qualificationEnvelopeCount,
            ),
          ).toEqual(
            scenarioExpectedIds.map(() =>
              record.scenario === "count-session" ||
              record.scenario === "count-visitor"
                ? 1
                : 0,
            ),
          );
        }
      } finally {
        database.close();
      }
    },
  );

  it("falls back once for actual TEXT numeric Count data and preserves the DTO", async () => {
    const database = createMigratedDatabase();
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const captures: CapturedSqliteQuery[] = [];
    const env = {
      DB: createVisitorSessionsTestDatabase({ database, trace, captures }),
      MAIN_SECRET: "wave97w-visitor-sessions-cursor-secret",
    } as unknown as Env;
    try {
      seedDatabase(database);
      database
        .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
        .run("invalid-duration", "session-a-tie-1");
      const filters = parseFilterDsl(
        'page.path eq "/match" and count(page { page.durationMs gt 5 }) eq 99',
        analyticsFilterRegistry,
      );
      const request = {
        ...queryInput({ scope: "session", filterKind: "count" }),
        filters,
      } as VisitorSessionsQuery;
      const diagnostics = createD1ReadDiagnostics();
      const result: VisitorSessionsResult = await createD1SiteQueryRuntime({
        env,
        siteId: SITE_ID,
        diagnostics,
      }).execute("visitor-sessions", request);
      const routeCalls = callsSince(trace, 0);
      const routeCaptures = [...captures];

      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok)
        throw new Error("visitor_sessions_numeric_fallback_failed");
      expect(diagnostics.advancedCountSqlFallbackReason).toEqual({
        kind: "numeric-data-domain",
        fieldIds: ["page.durationMs"],
      });
      const envelopeCaptures = routeCaptures.filter(({ sql }) =>
        isQualificationEnvelopeSql(sql),
      );
      const envelopeRows = envelopeCaptures.flatMap(({ rows }) => rows);
      expect(envelopeCaptures).toHaveLength(1);
      expect(
        envelopeRows.filter(
          (row) =>
            (row as Record<string, unknown>).rowKind === "report" &&
            (row as Record<string, unknown>).outputId ===
              JOURNEY_SESSION_LIST_REPORT_OUTPUT,
        ),
      ).toHaveLength(0);
      expect(
        envelopeRows.filter(
          (row) => (row as Record<string, unknown>).rowKind === "control",
        ),
      ).toHaveLength(1);
      expect(
        routeCaptures.filter(({ sql }) => isJourneyTargetPresenceSql(sql)),
      ).toHaveLength(1);

      const middlewareQuery = await visitorSessionsMiddlewareQuery(
        env,
        request,
      );
      const deferred =
        deferredSessionListQualificationFromQuery(middlewareQuery);
      expect(deferred?.operation).toBe("visitor-sessions");
      if (!deferred)
        throw new Error("visitor_sessions_fallback_request_missing");
      const postRouteLegacyReaderControl = await readSiteVisitorSessions({
        env,
        siteId: SITE_ID,
        visitorId: VISITOR_ID,
        window: {
          startMs: BASE,
          endExclusiveMs: END,
          nowMs: END,
          timeZone: "UTC",
        },
        filters: await prepareDeferredEventQualificationFallback(
          deferred.qualification,
        ),
        page: { limit: 1, cursor: null },
        audience: "private-dashboard",
      });
      expect(result.data).toEqual(postRouteLegacyReaderControl);
      expect(result.data.items).toEqual([]);

      writeEvidence(
        "numeric-text-count-fallback.json",
        {
          contract: "actual-SQLite-TEXT-numeric-whole-fallback",
          fallbackReason: diagnostics.advancedCountSqlFallbackReason,
          request: {
            operation: "visitor-sessions",
            visitorId: VISITOR_ID,
            scope: "session",
            filterDsl:
              'page.path eq "/match" and count(page { page.durationMs gt 5 }) eq 99',
            page: request.page,
          },
          route: {
            result: result.data,
            sqlCalls: routeCalls,
            envelopeCount: envelopeCaptures.length,
            reportRowCount: envelopeRows.filter(
              (row) => (row as Record<string, unknown>).rowKind === "report",
            ).length,
            targetPresenceQueryCount: routeCaptures.filter(({ sql }) =>
              isJourneyTargetPresenceSql(sql),
            ).length,
          },
          control: {
            label: "post-route-legacy-reader-control",
            result: postRouteLegacyReaderControl,
          },
        },
        "current-runtime-numeric-text-whole-fallback",
      );
    } finally {
      database.close();
    }
  });

  it("reads the entity membership instead of the legacy ID bridge for a numeric fallback", async () => {
    const database = createMigratedDatabase();
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const legacyTrace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const secret = "wave97w-visitor-sessions-cursor-secret";
    const env = {
      DB: createVisitorSessionsTestDatabase({
        database,
        trace,
        captures: [],
      }),
      MAIN_SECRET: secret,
    } as unknown as Env;
    const legacyEnv = {
      DB: createVisitorSessionsTestDatabase({
        database,
        trace: legacyTrace,
        captures: [],
      }),
      MAIN_SECRET: secret,
    } as unknown as Env;
    try {
      seedDatabase(database);
      database
        .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
        .run("invalid-duration", "session-a-tie-1");
      const filters = parseFilterDsl(
        'page.path eq "/match" and count(page { page.durationMs gt 5 }) eq 0',
        analyticsFilterRegistry,
      );
      const request = {
        ...queryInput({ scope: "session", filterKind: "count" }),
        filters,
      } as VisitorSessionsQuery;
      const diagnostics = createD1ReadDiagnostics();
      const result: VisitorSessionsResult = await createD1SiteQueryRuntime({
        env,
        siteId: SITE_ID,
        diagnostics,
      }).execute("visitor-sessions", request);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) throw new Error("visitor_sessions_membership_failed");
      expect(diagnostics.advancedCountSqlFallbackReason).toEqual({
        kind: "numeric-data-domain",
        fieldIds: ["page.durationMs"],
      });
      const deferred = deferredSessionListQualificationFromQuery(
        await visitorSessionsMiddlewareQuery(legacyEnv, request),
      );
      if (!deferred) throw new Error("visitor_sessions_deferred_missing");
      const legacy = await readSiteVisitorSessions({
        env: legacyEnv,
        siteId: SITE_ID,
        visitorId: VISITOR_ID,
        window: {
          startMs: BASE,
          endExclusiveMs: END,
          nowMs: END,
          timeZone: "UTC",
        },
        filters: await prepareDeferredEventQualificationFallback(
          deferred.qualification,
        ),
        page: { limit: 1, cursor: null },
        audience: "private-dashboard",
      });
      expect(legacy.items.length).toBeGreaterThan(0);
      expect(result.data).toEqual(legacy);
      // The legacy ID bridge binds the entity kind next to every identity;
      // the request-private entity membership binds only (site, id) pairs.
      expect(legacyTrace.bindings.at(-1) ?? []).toContain("session");
      expect(trace.bindings.at(-1) ?? []).not.toContain("session");
    } finally {
      database.close();
    }
  });

  it("checks a mutated Count cap before missing-target presence and bad cursor", async () => {
    const database = createMigratedDatabase();
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const captures: CapturedSqliteQuery[] = [];
    const env = {
      DB: createVisitorSessionsTestDatabase({
        database,
        trace,
        captures,
        transformEnvelopeRow(row) {
          return row.rowKind === "control" ? { ...row, rawCount: 20_001 } : row;
        },
      }),
      MAIN_SECRET: "wave97w-visitor-sessions-cursor-secret",
    } as unknown as Env;
    try {
      seedDatabase(database);
      const diagnostics = createD1ReadDiagnostics();
      const request = queryInput({
        scope: "session",
        filterKind: "count",
        visitorId: OTHER_SITE_ONLY_VISITOR_ID,
        cursor: "not-a-signed-cursor",
      });
      const result: VisitorSessionsResult = await createD1SiteQueryRuntime({
        env,
        siteId: SITE_ID,
        diagnostics,
      }).execute("visitor-sessions", request);
      const routeCalls = callsSince(trace, 0);
      const envelopeCaptures = captures.filter(({ sql }) =>
        isQualificationEnvelopeSql(sql),
      );

      expect(result).toMatchObject({
        ok: false,
        error: {
          kind: "invalid-input",
          issues: [{ path: "filters", code: "filter_activity_limit_exceeded" }],
        },
      });
      expect(envelopeCaptures).toHaveLength(1);
      expect(
        captures.filter(({ sql }) => isJourneyTargetPresenceSql(sql)),
      ).toHaveLength(0);
      expect(
        routeCalls.filter(({ sql }) => isQualificationEnvelopeSql(sql)),
      ).toHaveLength(1);
      expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();

      writeEvidence(
        "count-cap-missing-target-bad-cursor.json",
        {
          contract: "control-protocol-boundary-not-large-seed-test",
          controlMutation: { rowKind: "control", rawCount: 20_001 },
          request: {
            operation: "visitor-sessions",
            visitorId: OTHER_SITE_ONLY_VISITOR_ID,
            scope: "session",
            filterKind: "count",
            cursor: "not-a-signed-cursor",
          },
          expectedPriority: "filter_activity_limit_exceeded",
          result,
          sqlCalls: routeCalls,
          envelopeRows: envelopeCaptures.flatMap(({ rows }) => rows),
          targetPresenceQueryCount: captures.filter(({ sql }) =>
            isJourneyTargetPresenceSql(sql),
          ).length,
        },
        "control-row-mutation-rawCount-20001-not-large-seed",
      );
    } finally {
      database.close();
    }
  });

  it("returns an empty qualified page for a present event-only visitor", async () => {
    const database = createMigratedDatabase();
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const captures: CapturedSqliteQuery[] = [];
    const env = {
      DB: createVisitorSessionsTestDatabase({ database, trace, captures }),
      MAIN_SECRET: "wave97w-visitor-sessions-cursor-secret",
    } as unknown as Env;
    try {
      seedDatabase(database);
      const diagnostics = createD1ReadDiagnostics();
      const request = queryInput({
        scope: "session",
        filterKind: "count",
        visitorId: "visitor-event-only",
      });
      const result: VisitorSessionsResult = await createD1SiteQueryRuntime({
        env,
        siteId: SITE_ID,
        diagnostics,
      }).execute("visitor-sessions", request);
      const routeCalls = callsSince(trace, 0);
      const envelopeCaptures = captures.filter(({ sql }) =>
        isQualificationEnvelopeSql(sql),
      );
      const envelopeRows = envelopeCaptures.flatMap(({ rows }) => rows);
      const presenceCaptures = captures.filter(({ sql }) =>
        isJourneyTargetPresenceSql(sql),
      );

      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok)
        throw new Error("visitor_sessions_empty_qualified_page_failed");
      expect(result.data.items).toEqual([]);
      expect(result.data.pagination).toMatchObject({
        limit: 1,
        returned: 0,
        hasMore: false,
        nextCursor: null,
      });
      expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
      expect(envelopeCaptures).toHaveLength(1);
      expect(
        envelopeRows.filter(
          (row) => (row as Record<string, unknown>).rowKind === "report",
        ),
      ).toHaveLength(0);
      expect(
        envelopeRows.filter(
          (row) => (row as Record<string, unknown>).rowKind === "control",
        ),
      ).toHaveLength(1);
      expect(presenceCaptures).toHaveLength(1);
      expect(presenceCaptures[0]?.rows).toEqual([{ present: 1 }]);

      writeEvidence(
        "existing-target-qualified-empty-page.json",
        {
          contract: "present-event-only-visitor-with-no-qualified-session",
          request: {
            operation: "visitor-sessions",
            visitorId: "visitor-event-only",
            scope: "session",
            filterKind: "count",
            page: request.page,
          },
          result: result.data,
          fallbackReason: diagnostics.advancedCountSqlFallbackReason,
          sqlCalls: routeCalls,
          envelopeRows,
          typedPresenceRows: presenceCaptures[0]?.rows,
          targetPresenceQueryCount: presenceCaptures.length,
        },
        "current-runtime-existing-target-qualified-empty-page",
      );
    } finally {
      database.close();
    }
  });

  it("shares corrected Session cursors and preserves target-first errors", async () => {
    const database = createMigratedDatabase();
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const env = {
      DB: createSqliteD1Database(database, trace),
      MAIN_SECRET: "wave97w-visitor-sessions-cursor-secret",
    } as unknown as Env;
    try {
      seedDatabase(database);
      const window = {
        startMs: BASE,
        endExclusiveMs: END,
        nowMs: END,
        timeZone: "UTC",
      } as const;
      expect(
        await queryJourneyTargetExistsFromD1(
          env,
          SITE_ID,
          { type: "visitor", value: "visitor-event-only" },
          window,
        ),
      ).toBe(true);
      expect(
        await queryJourneyTargetExistsFromD1(
          env,
          SITE_ID,
          { type: "visitor", value: OTHER_SITE_ONLY_VISITOR_ID },
          window,
        ),
      ).toBe(false);
      const eventOnly = await readSiteVisitorSessions({
        env,
        siteId: SITE_ID,
        visitorId: "visitor-event-only",
        window,
        filters: EMPTY_FILTER_DOCUMENT,
        page: { limit: 1, cursor: null },
        audience: "private-dashboard",
      });
      expect(eventOnly.items).toHaveLength(0);

      const filters = await legacyCountFilters(env, "session");
      const legacyInput = {
        env,
        siteId: SITE_ID,
        visitorId: VISITOR_ID,
        window,
        filters,
        page: { limit: 1, cursor: null },
        audience: "private-dashboard" as const,
      };
      const legacyFirst = await readSiteVisitorSessions(legacyInput);
      const legacyCursor = legacyFirst.pagination.nextCursor;
      expect(legacyFirst.items.map(({ sessionId }) => sessionId)).toEqual([
        "session-a-tie-1",
      ]);
      expect(legacyCursor).not.toBeNull();
      const legacyCursorValue = await decodeSiteVisitorSessionsCursor({
        ...legacyInput,
        page: { limit: 1, cursor: legacyCursor },
      });
      expect(legacyCursorValue).toMatchObject({
        sortValue: BASE + 3_000,
        sessionId: "session-a-tie-1",
      });

      const diagnostics = createD1ReadDiagnostics();
      const runtime = createD1SiteQueryRuntime({
        env,
        siteId: SITE_ID,
        diagnostics,
      });
      const qualifiedAfterLegacy: VisitorSessionsResult = await runtime.execute(
        "visitor-sessions",
        queryInput({
          scope: "session",
          filterKind: "count",
          cursor: legacyCursor,
        }),
      );
      expect(qualifiedAfterLegacy.ok).toBe(true);
      if (!qualifiedAfterLegacy.ok)
        throw new Error("visitor_sessions_legacy_cursor_rejected");
      expect(
        qualifiedAfterLegacy.data.items.map(({ sessionId }) => sessionId),
      ).toEqual(["session-a-tie-2"]);
      const qualifiedCursor = qualifiedAfterLegacy.data.pagination.nextCursor;
      expect(qualifiedCursor).not.toBeNull();
      const legacyAfterQualified = await readSiteVisitorSessions({
        ...legacyInput,
        page: { limit: 1, cursor: qualifiedCursor },
      });
      expect(
        legacyAfterQualified.items.map(({ sessionId }) => sessionId),
      ).toEqual(["session-a-old"]);
      const qualifiedCursorValue = await decodeSiteVisitorSessionsCursor({
        ...legacyInput,
        page: { limit: 1, cursor: qualifiedCursor },
      });
      expect(qualifiedCursorValue).toMatchObject({
        sortValue: BASE + 3_000,
        sessionId: "session-a-tie-2",
      });

      const eventCursor = await encodeSiteJourneyEventPageCursor(
        { ...legacyInput, page: { limit: 1, cursor: null } },
        "visitor-events",
        VISITOR_ID,
        { occurredAt: BASE + 3_000, id: "event-shaped-token" },
      );
      expect(eventCursor).not.toBeNull();
      await expect(
        decodeSiteVisitorSessionsCursor({
          ...legacyInput,
          page: { limit: 1, cursor: eventCursor },
        }),
      ).rejects.toThrow("invalid-cursor");
      await expect(
        decodeSiteVisitorSessionsCursor({
          ...legacyInput,
          page: { limit: 1, cursor: legacyCursor },
          visitorId: "visitor-b",
        }),
      ).rejects.toThrow("invalid-cursor");
      await expect(
        decodeSiteVisitorSessionsCursor({
          ...legacyInput,
          siteId: OTHER_SITE_ID,
          page: { limit: 1, cursor: legacyCursor },
        }),
      ).rejects.toThrow("invalid-cursor");
      await expect(
        decodeSiteVisitorSessionsCursor({
          ...legacyInput,
          filters: parseFilterDsl(NATIVE_FILTER_DSL, analyticsFilterRegistry),
          page: { limit: 1, cursor: legacyCursor },
        }),
      ).rejects.toThrow("invalid-cursor");
      await expect(
        decodeSiteJourneyEventPageCursor(
          { ...legacyInput, page: { limit: 1, cursor: legacyCursor } },
          "visitor-events",
          VISITOR_ID,
        ),
      ).rejects.toThrow("invalid-cursor");

      const targetOrderErrors: string[] = [];
      const missingTarget: VisitorSessionsResult = await runtime.execute(
        "visitor-sessions",
        queryInput({
          scope: "session",
          filterKind: "count",
          visitorId: OTHER_SITE_ONLY_VISITOR_ID,
          cursor: "not-a-signed-cursor",
        }),
        {
          onProviderError(error) {
            targetOrderErrors.push(
              error instanceof Error ? error.message : String(error),
            );
          },
        },
      );
      expect(missingTarget.ok).toBe(false);
      expect(targetOrderErrors).toContain("resource-not-found");
      expect(targetOrderErrors).not.toContain("invalid-cursor");

      const cursorOrderErrors: string[] = [];
      const invalidCursor: VisitorSessionsResult = await runtime.execute(
        "visitor-sessions",
        queryInput({
          scope: "session",
          filterKind: "count",
          cursor: "not-a-signed-cursor",
        }),
        {
          onProviderError(error) {
            cursorOrderErrors.push(
              error instanceof Error ? error.message : String(error),
            );
          },
        },
      );
      expect(invalidCursor.ok).toBe(false);
      expect(cursorOrderErrors).toContain("invalid-cursor");
      expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
    } finally {
      database.close();
    }
  });
});

describe("visitor sessions qualification request boundary", () => {
  it("binds the branded request to its own visitor-sessions page shape", async () => {
    const database = createMigratedDatabase();
    const env = {
      DB: createSqliteD1Database(database),
      MAIN_SECRET: "wave97w-visitor-sessions-request-secret",
    } as unknown as Env;
    try {
      seedDatabase(database);
      const prepared = prepareScopedQuery(
        "visitor-sessions",
        queryInput({ scope: "visitor", filterKind: "count" }) as never,
      ) as unknown as QueryInput & Record<string, unknown>;
      expect(
        sessionListQualificationConfigurationFromQuery(
          prepared,
          "visitor-sessions",
        ),
      ).toMatchObject({
        operation: "visitor-sessions",
        visitorId: VISITOR_ID,
        sort: { field: "startedAt", direction: "desc" },
        page: { limit: 1, cursor: null },
        audience: "private-dashboard",
      });
      const pageLess = { ...prepared };
      delete pageLess.page;
      expect(
        sessionListQualificationConfigurationFromQuery(
          pageLess,
          "visitor-sessions",
        )?.page,
      ).toEqual({ limit: 100, cursor: null });
      for (const ignoredField of [
        { limit: 5 },
        { cursor: "ignored" },
        { search: "ignored" },
        { sort: { key: "views", direction: "asc" } },
      ])
        expect(
          sessionListQualificationConfigurationFromQuery(
            { ...prepared, ...ignoredField },
            "visitor-sessions",
          ),
        ).toBeUndefined();

      const getterRequest = { ...prepared };
      let visitorGetterRead = false;
      Object.defineProperty(getterRequest, "visitorId", {
        enumerable: true,
        configurable: true,
        get() {
          visitorGetterRead = true;
          throw new Error("visitor getter must not run");
        },
      });
      expect(
        sessionListQualificationConfigurationFromQuery(
          getterRequest,
          "visitor-sessions",
        ),
      ).toBeUndefined();
      expect(visitorGetterRead).toBe(false);

      const original = await visitorSessionsMiddlewareQuery(
        env,
        queryInput({ scope: "visitor", filterKind: "count" }),
      );
      expect(
        deferredSessionListQualificationFromQuery(original)?.operation,
      ).toBe("visitor-sessions");
      const clone = Object.defineProperties(
        {},
        Object.getOwnPropertyDescriptors(original),
      );
      expect(() => deferredSessionListQualificationFromQuery(clone)).toThrow(
        "session_list_qualification_request_untrusted",
      );

      const mutated = await visitorSessionsMiddlewareQuery(
        env,
        queryInput({ scope: "visitor", filterKind: "count" }),
      );
      Object.defineProperty(mutated, "visitorId", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: "visitor-b",
      });
      expect(() => deferredSessionListQualificationFromQuery(mutated)).toThrow(
        "session_list_qualification_request_changed",
      );

      const runtime = createD1SiteQueryRuntime({ env, siteId: SITE_ID });
      const defaultScope: VisitorSessionsResult = await runtime.execute(
        "visitor-sessions",
        queryInput({ filterKind: "empty" }),
      );
      const explicitVisitor: VisitorSessionsResult = await runtime.execute(
        "visitor-sessions",
        queryInput({ scope: "visitor", filterKind: "empty" }),
      );
      expect(defaultScope.ok).toBe(true);
      expect(explicitVisitor.ok).toBe(true);
      if (!defaultScope.ok || !explicitVisitor.ok)
        throw new Error("visitor_sessions_default_scope_query_failed");
      expect(explicitVisitor.data.items).toEqual(defaultScope.data.items);
      expect(explicitVisitor.data.pagination).toEqual(
        defaultScope.data.pagination,
      );
    } finally {
      database.close();
    }
  });
});

describe("visitor sessions pre-route qualification budgets", () => {
  it("executes first/next pages for both Count scopes within D1 budgets", async () => {
    const database = createMigratedDatabase();
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const env = {
      DB: createSqliteD1Database(database, trace),
      MAIN_SECRET: "wave97w-visitor-sessions-budget-secret",
    } as unknown as Env;
    try {
      seedDatabase(database);
      const window = {
        startMs: BASE,
        endExclusiveMs: END,
        nowMs: END,
        timeZone: "UTC",
      } as const;
      expect(
        await queryJourneyTargetExistsFromD1(
          env,
          SITE_ID,
          {
            type: "visitor",
            value: VISITOR_ID,
          },
          window,
        ),
      ).toBe(true);
      const scenarios: Array<Record<string, unknown>> = [];
      for (const scope of ["session", "visitor"] as const) {
        const { prepared, count } = visitorSessionsCountInput(scope);
        const pages: Array<Record<string, unknown>> = [];
        let cursor: SessionListCursor | null = null;
        for (let pageIndex = 0; pageIndex < 6; pageIndex += 1) {
          const plan = buildJourneySessionListQualificationPlan({
            siteId: SITE_ID,
            queryTime: prepared.time,
            filters: prepared.filters,
            scopePlan: prepared.scopePlan,
            count,
            limit: 1,
            sort: { key: "startedAt", direction: "desc" },
            cursor,
            preparedPlanOperation: "visitor-sessions",
            sessionTarget: { type: "visitor", value: VISITOR_ID },
          });
          const compilation = compileVisitorSessionsEnvelope({
            plan,
            siteId: SITE_ID,
          });
          if (compilation.kind !== "compiled")
            throw new Error(
              `visitor_sessions_qualification_budget_unavailable:${scope}:${JSON.stringify(compilation.fallbackReason)}`,
            );
          const callStart = trace.preparedSql.length;
          const rows = await queryD1CompiledAll<Record<string, unknown>>(
            env,
            compilation.query,
          );
          const calls = callsSince(trace, callStart);
          const reportRows = rows.filter(
            (row) =>
              row.rowKind === "report" &&
              row.outputId === JOURNEY_SESSION_LIST_REPORT_OUTPUT,
          );
          const controls = rows.filter(
            (row) =>
              row.rowKind === "control" &&
              row.outputId === PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT,
          );
          expect(controls).toHaveLength(1);
          expect(reportRows.length).toBeGreaterThan(0);
          expect(compilation.evidence.sqlBytes).toBeLessThanOrEqual(100_000);
          expect(compilation.evidence.bindingCount).toBeLessThanOrEqual(100);
          expect(compilation.evidence.groupWidth).toBeLessThanOrEqual(16);
          expect(compilation.evidence.groupedSummaryProof).toMatchObject({
            source: "local-plan",
            nodeKind: "aggregate",
            groupKeyCount: 2,
            materialization: "materialized",
            matchingSharedRelationCount: 1,
          });
          expect(calls).toHaveLength(1);
          const page = sessionListPageFromRecords(reportRows, 1, {
            key: "startedAt",
            direction: "desc",
          });
          expect(page.rows).toHaveLength(1);
          pages.push({
            page: pageIndex + 1,
            dto: page.rows[0],
            hasMore: page.nextCursor !== null,
            control: controls[0],
            sql: calls[0]?.sql,
            bindings: calls[0]?.bindings,
            evidence: compilation.evidence,
          });
          cursor = page.nextCursor;
          if (!cursor) break;
        }
        expect(pages).toHaveLength(scope === "session" ? 3 : 4);
        scenarios.push({ scope, pages });
      }
      writeEvidence(
        "pre-route-qualified-budget.json",
        {
          state:
            "actual-pre-route-sqlite-qualification-count-first-next-budget-proof-and-dto",
          siteId: SITE_ID,
          visitorId: VISITOR_ID,
          scenarios,
        },
        "actual-pre-route-sqlite-qualification-count-first-next-budget-proof-and-dto",
      );
    } finally {
      database.close();
    }
  });
});
