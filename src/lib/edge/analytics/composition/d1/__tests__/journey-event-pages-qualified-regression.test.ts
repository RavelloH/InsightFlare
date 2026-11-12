import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterAll, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { createD1SiteQueryRuntime } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import {
  createQueryTime,
  EMPTY_FILTER_DOCUMENT,
  type FilterDocument,
  prepareScopedQuery,
  type QueryInput,
  type QueryTime,
  type ScopedFilterPlan,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import {
  effectiveScopeForPagination,
  scopedFilterMetadata,
} from "@/lib/edge/analytics/contract/scoped-filter";
import type { AdvancedCountFilterMatchPlanInput } from "@/lib/edge/analytics/engine/advanced-count-filter-plan";
import { buildJourneyEventPageQualificationPlan } from "@/lib/edge/analytics/engine/journey-event-page-qualification-plan";
import { JOURNEY_EVENT_PAGE_REPORT_OUTPUT } from "@/lib/edge/analytics/engine/journey-event-page-report-plan";
import { PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT } from "@/lib/edge/analytics/engine/page-dimension-qualification-plan";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import {
  d1AdvancedFilterMiddleware,
  deferredEventQualificationFromQuery,
  prepareDeferredEventQualificationFallback,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { queryD1CompiledAll } from "@/lib/edge/analytics/providers/d1/internal/core-sources";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import { executeJourneyEventPageQualificationProgram } from "@/lib/edge/analytics/providers/d1/internal/journey-event-page-qualification-program";
import {
  deferredJourneyEventPageQualificationFromQuery,
  journeyEventPageQualificationConfigurationFromQuery,
} from "@/lib/edge/analytics/providers/d1/internal/journey-event-page-qualification-request";
import { compileQualificationProgramEnvelope } from "@/lib/edge/analytics/providers/d1/internal/qualification-program-envelope";
import {
  readSiteSessionEvents,
  readSiteVisitorEvents,
} from "@/lib/edge/analytics/providers/d1/operations/site-journeys";
import {
  createInvocationLogger,
  runWithInvocationLogger,
} from "@/lib/edge/observability/logger";
import type { Env } from "@/lib/edge/types";
import { parseFilterDsl } from "@/lib/filter-contract";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";
import { analyzeFilterDocument } from "@/lib/filter-contract/filter-semantics";
import { filterFingerprint } from "@/lib/filter-contract/filters";

const SITE_ID = "wave97s-event-pages";
const OTHER_SITE_ID = "wave97s-event-pages-other";
const TARGET_VISITOR_ID = "visitor-target";
const TARGET_SESSION_ID = "session-target";
const EVENT_ONLY_VISITOR_ID = "visitor-event-only";
const EVENT_ONLY_SESSION_ID = "session-event-only";
const NATIVE_ONLY_VISITOR_ID = "visitor-native-only";
const NATIVE_ONLY_SESSION_ID = "session-native-only";
const COUNT_ONLY_VISITOR_ID = "visitor-count-only";
const COUNT_ONLY_SESSION_ID = "session-count-only";
const BASE = Date.UTC(2026, 9, 1);
const END = BASE + 24 * 60 * 60 * 1000;
const FILTER_DSL =
  'page.path eq "/native" and count(page { page.path eq "/qualify" }) gte 1';
const MIXED_OR_FILTER_DSL =
  'page.path eq "/native" or count(page { page.path eq "/qualify" }) gte 1';
const MIXED_NOT_FILTER_DSL =
  'not (page.path eq "/native" and count(page { page.path eq "/qualify" }) gte 1)';
const STAGE_A_EVIDENCE_DIRECTORY =
  process.env.INSIGHTFLARE_JOURNEY_EVENT_STAGE_A_EVIDENCE_DIR;
const POST_ROUTE_EVIDENCE_DIRECTORY =
  process.env.INSIGHTFLARE_JOURNEY_EVENT_POST_ROUTE_EVIDENCE_DIR;
const pendingPostRouteEvidence: Array<{
  readonly directory: string;
  readonly filename: string;
  readonly value: unknown;
}> = [];

afterAll(() => {
  for (const evidence of pendingPostRouteEvidence) {
    mkdirSync(evidence.directory, { recursive: true });
    writeFileSync(
      join(evidence.directory, evidence.filename),
      `${JSON.stringify(evidence.value, null, 2)}\n`,
      "utf8",
    );
  }
});

type EventPageOperation = "visitor-events" | "session-events";
type CountScope = "session" | "visitor";
type JourneyEventQuery = QueryInput & {
  readonly time: QueryTime;
  readonly filters?: FilterDocument;
  readonly page: { readonly limit: number; readonly cursor: string | null };
  readonly visitorId?: string;
  readonly sessionId?: string;
  readonly scopePreference?: CountScope;
};

interface CapturedRuntimePage {
  readonly scenario: string;
  readonly requestCursor: string | null;
  readonly requestIdentity: Readonly<Record<string, unknown>>;
  readonly data?: {
    readonly items: readonly unknown[];
    readonly pagination: { readonly nextCursor: string | null };
  };
  readonly error?: unknown;
  readonly calls: ReturnType<typeof callsSince>;
  readonly diagnostics: ReturnType<typeof createD1ReadDiagnostics>;
  readonly applicationLogs?: readonly unknown[];
}

interface FixtureSite {
  readonly siteId: string;
  readonly sitePk: number;
  readonly eventNameId: number;
}

function insertSite(database: DatabaseSync, siteId: string): FixtureSite {
  database
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .run(siteId);
  const identity = database
    .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
    .get(siteId) as { readonly site_pk: number };
  database
    .prepare(
      "INSERT INTO custom_event_names (site_id, name, last_seen_at, site_pk) VALUES (?, ?, ?, ?)",
    )
    .run(siteId, "purchase", BASE, identity.site_pk);
  const name = database
    .prepare("SELECT id FROM custom_event_names WHERE site_pk = ? AND name = ?")
    .get(identity.site_pk, "purchase") as { readonly id: number };
  database
    .prepare(
      "INSERT INTO sites (id, team_id, name, domain, created_at) VALUES (?, 'wave97s-team', 'Journey Events baseline', 'wave97s.test', 0)",
    )
    .run(siteId);
  return {
    siteId,
    sitePk: Number(identity.site_pk),
    eventNameId: Number(name.id),
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
    readonly browserVersion?: string | null;
    readonly perfTtfbMs?: number | null;
  },
): void {
  database
    .prepare(
      `INSERT INTO visits (
        visit_id, site_id, site_pk, visitor_id, session_id, status,
        started_at, last_activity_at, pathname, hostname, duration_ms,
        browser, browser_version, perf_ttfb_ms
      ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, 'wave97s.test', ?, 'Firefox', ?, ?)`,
    )
    .run(
      input.visitId,
      site.siteId,
      site.sitePk,
      input.visitorId,
      input.sessionId,
      input.startedAt,
      input.startedAt,
      input.pathname ?? "/native",
      input.durationMs ?? null,
      input.browserVersion ?? "130.2",
      input.perfTtfbMs ?? null,
    );
}

function insertEvent(
  database: DatabaseSync,
  site: FixtureSite,
  input: {
    readonly eventId: string;
    readonly visitId: string;
    readonly occurredAt: number;
  },
): void {
  database
    .prepare(
      `INSERT INTO custom_events (
        event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
        received_at, node_count, value_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)`,
    )
    .run(
      input.eventId,
      site.siteId,
      site.sitePk,
      input.visitId,
      site.eventNameId,
      input.occurredAt,
      input.occurredAt,
    );
}

function seedFixture(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = OFF");
  const site = insertSite(database, SITE_ID);
  const otherSite = insertSite(database, OTHER_SITE_ID);

  insertVisit(database, site, {
    visitId: "page-qualifier",
    visitorId: TARGET_VISITOR_ID,
    sessionId: TARGET_SESSION_ID,
    startedAt: BASE + 500,
    pathname: "/qualify",
  });
  for (const [index, startedAt] of [1_000, 2_000, 3_000, 4_000].entries()) {
    const visitId = `page-${index + 1}`;
    insertVisit(database, site, {
      visitId,
      visitorId: TARGET_VISITOR_ID,
      sessionId: TARGET_SESSION_ID,
      startedAt: BASE + startedAt,
      durationMs: index === 0 ? 0 : index === 1 ? 12.5 : null,
      browserVersion: index === 2 ? "130.2.7" : "130.2",
      perfTtfbMs: index === 3 ? 0.5 : null,
    });
    insertEvent(database, site, {
      eventId: `event-${index + 1}`,
      visitId,
      occurredAt: BASE + startedAt,
    });
  }
  insertVisit(database, site, {
    visitId: "page-owner-outside-window",
    visitorId: TARGET_VISITOR_ID,
    sessionId: TARGET_SESSION_ID,
    startedAt: BASE - 1_000,
  });
  insertEvent(database, site, {
    eventId: "event-owner-outside-window",
    visitId: "page-owner-outside-window",
    occurredAt: BASE + 5_000,
  });
  insertVisit(database, site, {
    visitId: "page-second-session",
    visitorId: TARGET_VISITOR_ID,
    sessionId: "session-second",
    startedAt: BASE + 6_000,
  });
  insertEvent(database, site, {
    eventId: "event-second-session",
    visitId: "page-second-session",
    occurredAt: BASE + 6_000,
  });
  for (const [index, startedAt] of [10_000, 11_000].entries()) {
    const nativeVisitId = `page-native-only-${index + 1}`;
    insertVisit(database, site, {
      visitId: nativeVisitId,
      visitorId: NATIVE_ONLY_VISITOR_ID,
      sessionId: NATIVE_ONLY_SESSION_ID,
      startedAt: BASE + startedAt,
      pathname: "/native",
    });
    insertEvent(database, site, {
      eventId: `event-native-only-${index + 1}`,
      visitId: nativeVisitId,
      occurredAt: BASE + startedAt,
    });

    const countVisitId = `page-count-only-${index + 1}`;
    insertVisit(database, site, {
      visitId: countVisitId,
      visitorId: COUNT_ONLY_VISITOR_ID,
      sessionId: COUNT_ONLY_SESSION_ID,
      startedAt: BASE + startedAt + 500,
      pathname: "/qualify",
    });
    insertEvent(database, site, {
      eventId: `event-count-only-${index + 1}`,
      visitId: countVisitId,
      occurredAt: BASE + startedAt + 500,
    });
  }

  insertVisit(database, site, {
    visitId: "page-event-only-owner-outside",
    visitorId: EVENT_ONLY_VISITOR_ID,
    sessionId: EVENT_ONLY_SESSION_ID,
    startedAt: BASE - 60_000,
  });
  insertEvent(database, site, {
    eventId: "event-only-in-window",
    visitId: "page-event-only-owner-outside",
    occurredAt: BASE + 7_000,
  });
  insertEvent(database, site, {
    eventId: "event-orphan-owner",
    visitId: "missing-owner",
    occurredAt: BASE + 8_000,
  });

  insertVisit(database, otherSite, {
    visitId: "page-other-site-same-visitor-session",
    visitorId: TARGET_VISITOR_ID,
    sessionId: TARGET_SESSION_ID,
    startedAt: BASE + 9_000,
  });
  insertEvent(database, otherSite, {
    eventId: "event-other-site-same-visitor-session",
    visitId: "page-other-site-same-visitor-session",
    occurredAt: BASE + 9_000,
  });
}

function eventQuery(
  operation: EventPageOperation,
  input: {
    readonly scope?: CountScope;
    readonly target?: string;
    readonly cursor?: string | null;
    readonly limit?: number;
    readonly advanced?: boolean;
    readonly filterDsl?: string;
  } = {},
) {
  const target =
    input.target ??
    (operation === "visitor-events" ? TARGET_VISITOR_ID : TARGET_SESSION_ID);
  return {
    context: siteQueryContext(SITE_ID, "private-dashboard"),
    time: createQueryTime(BASE, END, "UTC", END),
    ...(input.advanced
      ? {
          filters: parseFilterDsl(
            input.filterDsl ?? FILTER_DSL,
            analyticsFilterRegistry,
          ),
        }
      : {}),
    ...(input.scope ? { scopePreference: input.scope } : {}),
    ...(operation === "visitor-events"
      ? { visitorId: target }
      : { sessionId: target }),
    page: { limit: input.limit ?? 1, cursor: input.cursor ?? null },
  } as unknown as JourneyEventQuery;
}

function callsSince(trace: SqliteD1Trace, offset: number) {
  return trace.preparedSql.slice(offset).map((sql, index) => ({
    sql,
    bindings: trace.bindings[offset + index] ?? [],
  }));
}

function isEnvelopeSql(sql: string): boolean {
  return sql.includes('"rowKind"') && sql.includes('"outputId"');
}

function isCoverageMetadataSql(sql: string): boolean {
  return (
    /\b(?:FROM|JOIN)\s+["`]?sites["`]?\b/i.test(sql) &&
    !/\b(?:visits|custom_events)\b/i.test(sql)
  );
}

function interceptEnvelopeResults(
  database: ReturnType<typeof createSqliteD1Database>,
  intercept: (result: unknown) => unknown,
): ReturnType<typeof createSqliteD1Database> {
  const basePrepare = database.prepare.bind(database);
  return new Proxy(database, {
    get(target, property) {
      if (property !== "prepare") {
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (sql: string) => {
        const statement = basePrepare(sql) as object;
        if (!isEnvelopeSql(sql)) return statement;
        const wrapped = new Proxy(statement, {
          get(prepared, method) {
            const value = Reflect.get(prepared, method, prepared) as unknown;
            if (method === "bind" && typeof value === "function")
              return (...args: unknown[]) => {
                Reflect.apply(value, prepared, args);
                return wrapped;
              };
            if (method === "all" && typeof value === "function")
              return async (...args: unknown[]) =>
                intercept(await Reflect.apply(value, prepared, args));
            return typeof value === "function" ? value.bind(prepared) : value;
          },
        });
        return wrapped;
      };
    },
  });
}

function mapEnvelopeRows(
  result: unknown,
  map: (row: Record<string, unknown>) => Record<string, unknown>,
): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result))
    throw new Error("test_envelope_result_invalid");
  const record = result as Record<string, unknown>;
  if (!Array.isArray(record.results))
    throw new Error("test_envelope_rows_invalid");
  return {
    ...record,
    results: record.results.map((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row))
        throw new Error("test_envelope_row_invalid");
      return map({ ...(row as Record<string, unknown>) });
    }),
  };
}

function preparedQualificationInput(
  operation: EventPageOperation,
  scope: CountScope,
) {
  const prepared = prepareScopedQuery(
    operation,
    eventQuery(operation, { scope, advanced: true }),
  ) as JourneyEventQuery & {
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

function writeStageAEvidence(filename: string, value: unknown): void {
  if (!STAGE_A_EVIDENCE_DIRECTORY) return;
  mkdirSync(STAGE_A_EVIDENCE_DIRECTORY, { recursive: true });
  writeFileSync(
    join(STAGE_A_EVIDENCE_DIRECTORY, filename),
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
}

function writePostRouteEvidence(filename: string, value: unknown): void {
  if (!POST_ROUTE_EVIDENCE_DIRECTORY) return;
  pendingPostRouteEvidence.push({
    directory: POST_ROUTE_EVIDENCE_DIRECTORY,
    filename,
    value,
  });
}

async function capturePages(input: {
  readonly operation: EventPageOperation;
  readonly scope?: CountScope;
  readonly target?: string;
  readonly cursor?: string | null;
  readonly advanced?: boolean;
  readonly filterDsl?: string;
  readonly limit?: number;
  readonly pages: number;
  readonly scenario: string;
  readonly interceptEnvelope?: (result: unknown) => unknown;
  readonly signal?: AbortSignal;
}) {
  const database = createMigratedDatabase();
  const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
  const env = {
    DB: input.interceptEnvelope
      ? interceptEnvelopeResults(
          createSqliteD1Database(database, trace),
          input.interceptEnvelope,
        )
      : createSqliteD1Database(database, trace),
    MAIN_SECRET: "wave97s-event-pages-baseline-secret",
  } as unknown as Env;
  try {
    seedFixture(database);
    const diagnostics = createD1ReadDiagnostics();
    const runtime = createD1SiteQueryRuntime({
      env,
      siteId: SITE_ID,
      diagnostics,
    });
    const pages: CapturedRuntimePage[] = [];
    let cursor: string | null = input.cursor ?? null;
    for (let index = 0; index < input.pages; index += 1) {
      const query = eventQuery(input.operation, {
        scope: input.scope,
        target: input.target,
        cursor,
        advanced: input.advanced,
        filterDsl: input.filterDsl,
        limit: input.limit,
      });
      const preparedQuery = prepareScopedQuery(
        input.operation,
        query,
      ) as JourneyEventQuery;
      const queryFilters = preparedQuery.filters ?? EMPTY_FILTER_DOCUMENT;
      const requestIdentity = {
        filterFingerprint: filterFingerprint(
          queryFilters,
          analyticsFilterRegistry,
        ),
        paginationScope: effectiveScopeForPagination(queryFilters),
        resolvedScope: scopedFilterMetadata(queryFilters)?.resolvedScope,
      };
      const offset = trace.preparedSql.length;
      const invocationLogger = createInvocationLogger({
        source: "worker",
        trigger: "request",
      });
      const result = await runWithInvocationLogger(invocationLogger, () =>
        runtime.execute(
          input.operation,
          query,
          input.signal ? { signal: input.signal } : undefined,
        ),
      );
      const calls = callsSince(trace, offset);
      if (!result.ok) {
        pages.push({
          scenario: input.scenario,
          requestCursor: cursor,
          requestIdentity,
          error: result.error,
          calls,
          diagnostics: { ...diagnostics },
          applicationLogs: invocationLogger.build().logs,
        });
        break;
      }
      const data = result.data as {
        readonly items: readonly unknown[];
        readonly pagination: { readonly nextCursor: string | null };
      };
      pages.push({
        scenario: input.scenario,
        requestCursor: cursor,
        requestIdentity,
        data,
        calls,
        diagnostics: { ...diagnostics },
      });
      cursor = data.pagination.nextCursor;
      if (!cursor && index + 1 < input.pages) break;
    }
    return pages;
  } finally {
    database.close();
  }
}

async function captureLegacyReaderPages(input: {
  readonly operation: EventPageOperation;
  readonly scope: CountScope;
  readonly target: string;
  readonly filterDsl: string;
  readonly pages: number;
  readonly limit?: number;
}) {
  const database = createMigratedDatabase();
  const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
  const env = {
    DB: createSqliteD1Database(database, trace),
    MAIN_SECRET: "wave97s-event-pages-baseline-secret",
  } as unknown as Env;
  try {
    seedFixture(database);
    const prepared = prepareScopedQuery(
      input.operation,
      eventQuery(input.operation, {
        scope: input.scope,
        target: input.target,
        advanced: true,
        filterDsl: input.filterDsl,
        limit: input.limit,
      }),
    ) as unknown as JourneyEventQuery & QueryInput & Record<string, unknown>;
    let forwarded: unknown;
    await d1AdvancedFilterMiddleware(env, undefined, SITE_ID)(
      input.operation,
      prepared,
      async (query) => {
        forwarded = query;
        return query;
      },
    );
    if (!forwarded || typeof forwarded !== "object")
      throw new Error("journey_event_page_legacy_middleware_query_missing");
    const qualification = deferredEventQualificationFromQuery(
      forwarded,
      input.operation,
    );
    if (!qualification)
      throw new Error("journey_event_page_legacy_qualification_missing");
    const preparedFilters = prepared.filters;
    if (!preparedFilters)
      throw new Error("journey_event_page_legacy_filters_missing");
    const beforeFallbackIdentity = {
      filterFingerprint: filterFingerprint(
        preparedFilters,
        analyticsFilterRegistry,
      ),
      paginationScope: effectiveScopeForPagination(preparedFilters),
      resolvedScope: scopedFilterMetadata(preparedFilters)?.resolvedScope,
    };
    const producerOffset = trace.preparedSql.length;
    const filters =
      await prepareDeferredEventQualificationFallback(qualification);
    const afterFallbackIdentity = {
      filterFingerprint: filterFingerprint(filters, analyticsFilterRegistry),
      paginationScope: effectiveScopeForPagination(filters),
      resolvedScope: scopedFilterMetadata(filters)?.resolvedScope,
    };
    if (!scopedFilterMetadata(filters)?.plan.preparedMembership)
      throw new Error("journey_event_page_legacy_matches_missing");
    const producerCalls = callsSince(trace, producerOffset);

    const pages: Array<{
      readonly data: unknown;
      readonly calls: ReturnType<typeof callsSince>;
    }> = [];
    let cursor: string | null = null;
    for (let index = 0; index < input.pages; index += 1) {
      const offset = trace.preparedSql.length;
      const page: { readonly limit: number; readonly cursor: string | null } = {
        limit: input.limit ?? 1,
        cursor,
      };
      const data: {
        readonly items: readonly unknown[];
        readonly pagination: { readonly nextCursor: string | null };
      } =
        input.operation === "visitor-events"
          ? await readSiteVisitorEvents({
              env,
              siteId: SITE_ID,
              visitorId: input.target,
              window: {
                startMs: prepared.time.range.startMs,
                endExclusiveMs: prepared.time.range.endExclusiveMs,
                nowMs: prepared.time.capturedAtMs,
                timeZone: prepared.time.reportingTimeZone,
              },
              filters,
              audience: "private-dashboard",
              page,
            })
          : await readSiteSessionEvents({
              env,
              siteId: SITE_ID,
              sessionId: input.target,
              window: {
                startMs: prepared.time.range.startMs,
                endExclusiveMs: prepared.time.range.endExclusiveMs,
                nowMs: prepared.time.capturedAtMs,
                timeZone: prepared.time.reportingTimeZone,
              },
              filters,
              audience: "private-dashboard",
              page,
            });
      pages.push({ data, calls: callsSince(trace, offset) });
      cursor = data.pagination.nextCursor;
      if (!cursor && index + 1 < input.pages) break;
    }
    return {
      producerCalls,
      pages,
      beforeFallbackIdentity,
      afterFallbackIdentity,
    };
  } finally {
    database.close();
  }
}

async function middlewareQualifiedEventPageQuery(
  env: Env,
  operation: EventPageOperation,
  input: {
    readonly scope?: CountScope;
    readonly target?: string;
    readonly filterDsl?: string;
  } = {},
): Promise<QueryInput & Record<string, unknown>> {
  const prepared = prepareScopedQuery(
    operation,
    eventQuery(operation, {
      scope: input.scope ?? "session",
      target: input.target,
      advanced: true,
      filterDsl: input.filterDsl,
    }),
  ) as unknown as QueryInput & Record<string, unknown>;
  let forwarded: unknown;
  await d1AdvancedFilterMiddleware(env, undefined, SITE_ID)(
    operation,
    prepared,
    async (query) => {
      forwarded = query;
      return query;
    },
  );
  if (!forwarded || typeof forwarded !== "object")
    throw new Error("journey_event_page_middleware_query_missing");
  return forwarded as QueryInput & Record<string, unknown>;
}

describe("Journey visitor/session Events qualified-plan Stage A budgets", () => {
  it.each(
    (
      [
        ["visitor-events", "session"],
        ["visitor-events", "visitor"],
        ["session-events", "session"],
        ["session-events", "visitor"],
      ] as const
    ).map(([operation, scope]) => ({ operation, scope })),
  )(
    "executes first and next pages within D1 budgets for $operation/$scope",
    async ({ operation, scope }) => {
      const database = createMigratedDatabase();
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const env = {
        DB: createSqliteD1Database(database, trace),
        MAIN_SECRET: "wave97s-event-pages-stage-a-secret",
      } as unknown as Env;
      try {
        seedFixture(database);
        const { prepared, count } = preparedQualificationInput(
          operation,
          scope,
        );
        const target =
          operation === "visitor-events"
            ? { type: "visitor" as const, value: TARGET_VISITOR_ID }
            : { type: "session" as const, value: TARGET_SESSION_ID };
        const runPage = async (
          cursor: { readonly occurredAt: number; readonly id: string } | null,
        ) => {
          const plan = buildJourneyEventPageQualificationPlan({
            operation,
            siteId: SITE_ID,
            queryTime: prepared.time,
            filters: prepared.filters,
            scopePlan: prepared.scopePlan,
            count,
            target,
            limit: 1,
            cursor,
          });
          const report = plan.plan.outputs.find(
            ({ id }) => id === JOURNEY_EVENT_PAGE_REPORT_OUTPUT,
          );
          const controls = plan.plan.outputs.find(
            ({ id }) => id === PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT,
          );
          if (!report || !controls)
            throw new Error("journey_event_page_stage_a_outputs_missing");
          const reportFields = report.fields.map(({ name }) => name);
          const controlFields = controls.fields.map(({ name }) => name);
          const compilation = compileQualificationProgramEnvelope({
            qualification: plan,
            siteId: SITE_ID,
            reports: [
              {
                output: report,
                fields: reportFields,
                rowType: "journey-event-page",
              },
            ],
            controlsOutput: controls,
            reportFields,
            controlFields,
            ordering: [
              {
                outputId: JOURNEY_EVENT_PAGE_REPORT_OUTPUT,
                field: "occurredAt",
                direction: "desc",
                nulls: "last",
              },
              {
                outputId: JOURNEY_EVENT_PAGE_REPORT_OUTPUT,
                field: "id",
                direction: "desc",
                nulls: "last",
              },
            ],
            errorPrefix: "journey_event_page_qualification",
            fallbackTag: "analytics.journey_event_page_qualification",
          });
          if (compilation.kind !== "compiled")
            throw new Error(
              `journey_event_page_stage_a_budget_unavailable:${operation}:${scope}:${JSON.stringify(compilation.fallbackReason)}`,
            );
          const callStart = trace.preparedSql.length;
          const rows = (await queryD1CompiledAll(
            env,
            compilation.query,
          )) as Array<Record<string, unknown>>;
          const calls = callsSince(trace, callStart);
          const reportRows = rows.filter(
            (row) =>
              row.rowKind === "report" &&
              row.outputId === JOURNEY_EVENT_PAGE_REPORT_OUTPUT,
          );
          const controlRows = rows.filter(
            (row) =>
              row.rowKind === "control" &&
              row.outputId === PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT,
          );
          expect(controlRows).toHaveLength(1);
          expect(reportRows.length).toBeGreaterThan(0);
          expect(compilation.evidence.sqlBytes).toBeLessThanOrEqual(100_000);
          expect(compilation.evidence.bindingCount).toBeLessThanOrEqual(100);
          expect(compilation.evidence.groupWidth).toBeLessThanOrEqual(16);
          expect(compilation.evidence.groupedSummaryProof).toMatchObject({
            source: "local-plan",
            nodeKind: "aggregate",
            groupKeyCount: 2,
            matchingSharedRelationCount: 1,
            materialization: "materialized",
          });
          expect(
            compilation.evidence.groupedSummaryProof.sharedRelations.filter(
              ({ sameNode }) => sameNode,
            ),
          ).toHaveLength(1);
          expect(compilation.evidence.reportSourceRelations).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ entity: "page" }),
              expect.objectContaining({ entity: "event" }),
            ]),
          );
          expect(calls).toHaveLength(1);
          const row = reportRows[0]!;
          const nextCursor = {
            occurredAt: Number(row.occurredAt),
            id: String(row.id),
          };
          return {
            compilation: compilation.evidence,
            rows,
            calls,
            reportRows,
            nextCursor,
          };
        };

        const first = await runPage(null);
        const next = await runPage(first.nextCursor);
        expect(first.reportRows[0]?.id).toBeTruthy();
        expect(next.reportRows[0]?.id).toBeTruthy();
        expect(next.reportRows[0]?.id).not.toBe(first.reportRows[0]?.id);
        writeStageAEvidence(`stageA-${operation}-${scope}.json`, {
          state: "pre-route-qualified-plan-budget-executed",
          operation,
          scope,
          filterDsl: FILTER_DSL,
          pageLimit: 1,
          firstPage: {
            reportRows: first.reportRows,
            cursor: first.nextCursor,
            evidence: first.compilation,
            envelopeRows: first.rows,
            calls: first.calls,
          },
          nextPage: {
            reportRows: next.reportRows,
            requestCursor: first.nextCursor,
            evidence: next.compilation,
            envelopeRows: next.rows,
            calls: next.calls,
          },
        });
      } finally {
        database.close();
      }
    },
  );
});

describe("Journey visitor/session Events qualified runtime", () => {
  it("admits only operation-specific own-data private event-page requests", () => {
    const prepared = prepareScopedQuery(
      "visitor-events",
      eventQuery("visitor-events", { scope: "session", advanced: true }),
    );
    expect(
      journeyEventPageQualificationConfigurationFromQuery(
        prepared,
        "visitor-events",
      ),
    ).toEqual({
      operation: "visitor-events",
      target: TARGET_VISITOR_ID,
      page: { limit: 1, cursor: null },
      audience: "private-dashboard",
    });
    const wholeFilter = prepareScopedQuery(
      "visitor-events",
      eventQuery("visitor-events", {
        scope: "session",
        advanced: true,
        filterDsl: MIXED_OR_FILTER_DSL,
      }),
    );
    expect(
      journeyEventPageQualificationConfigurationFromQuery(
        wholeFilter,
        "visitor-events",
      )?.filterMode,
    ).toBe("allow-whole-filter");
    const unsupportedAudience = {
      ...(wholeFilter as unknown as Record<string, unknown>),
      context: siteQueryContext(SITE_ID, "api-v1"),
    };
    expect(
      journeyEventPageQualificationConfigurationFromQuery(
        unsupportedAudience,
        "visitor-events",
      ),
    ).toBeUndefined();
    expect(
      journeyEventPageQualificationConfigurationFromQuery(
        prepared,
        "session-events",
      ),
    ).toBeUndefined();
    const defaultPageQuery = Object.assign({}, prepared) as unknown as Record<
      string,
      unknown
    >;
    delete defaultPageQuery.page;
    expect(
      journeyEventPageQualificationConfigurationFromQuery(
        defaultPageQuery,
        "visitor-events",
      )?.page,
    ).toEqual({ limit: 100, cursor: null });

    const accessorTarget = Object.assign({}, prepared);
    Object.defineProperty(accessorTarget, "visitorId", {
      enumerable: true,
      get() {
        throw new Error("unexpected_target_getter");
      },
    });
    expect(
      journeyEventPageQualificationConfigurationFromQuery(
        accessorTarget,
        "visitor-events",
      ),
    ).toBeUndefined();
  });

  it.each(["visitor-events", "session-events"] as const)(
    "authenticates the middleware request before reading copied or fake $operation brands",
    async (operation) => {
      const database = createMigratedDatabase();
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const env = {
        DB: createSqliteD1Database(database, trace),
        MAIN_SECRET: "wave97s-event-pages-contract-secret",
      } as unknown as Env;
      try {
        seedFixture(database);
        const query = await middlewareQualifiedEventPageQuery(env, operation);
        const request = deferredJourneyEventPageQualificationFromQuery(
          query,
          operation,
        );
        expect(request).toBeDefined();

        const requestBrand = Reflect.ownKeys(query).find((key) => {
          if (typeof key !== "symbol") return false;
          const descriptor = Object.getOwnPropertyDescriptor(query, key);
          return (
            descriptor && "value" in descriptor && descriptor.value === request
          );
        });
        expect(typeof requestBrand).toBe("symbol");
        const requestDescriptor = Object.getOwnPropertyDescriptor(
          query,
          requestBrand!,
        );
        expect(requestDescriptor && "value" in requestDescriptor).toBe(true);

        const clone = Object.assign({}, query);
        for (const key of Reflect.ownKeys(query)) {
          if (typeof key !== "symbol") continue;
          const descriptor = Object.getOwnPropertyDescriptor(query, key);
          if (descriptor) Object.defineProperty(clone, key, descriptor);
        }
        const queryCount = trace.preparedSql.length;
        expect(() =>
          deferredJourneyEventPageQualificationFromQuery(clone, operation),
        ).toThrow(/changed/);
        expect(trace.preparedSql).toHaveLength(queryCount);

        let candidateOperationReads = 0;
        const fakeCandidate = Object.create(null) as Record<string, unknown>;
        Object.defineProperty(fakeCandidate, "operation", {
          enumerable: true,
          get() {
            candidateOperationReads += 1;
            return operation;
          },
        });
        const forgedQuery = Object.assign({}, query);
        Object.defineProperty(forgedQuery, requestBrand!, {
          ...requestDescriptor,
          value: fakeCandidate,
        });
        expect(() =>
          deferredJourneyEventPageQualificationFromQuery(
            forgedQuery,
            operation,
          ),
        ).toThrow();
        expect.soft(candidateOperationReads).toBe(0);
        expect(trace.preparedSql).toHaveLength(queryCount);

        let deferredOperationReads = 0;
        const fakeDeferred = Object.create(null) as Record<string, unknown>;
        Object.defineProperty(fakeDeferred, "operation", {
          enumerable: true,
          get() {
            deferredOperationReads += 1;
            return operation;
          },
        });
        await expect(
          executeJourneyEventPageQualificationProgram({
            query,
            deferred: fakeDeferred as never,
            env,
          }),
        ).rejects.toThrow(/request_invalid/);
        expect.soft(deferredOperationReads).toBe(0);
        expect(trace.preparedSql).toHaveLength(queryCount);
      } finally {
        database.close();
      }
    },
  );

  it.each(["target", "page", "time", "operation"] as const)(
    "rejects middleware request %s mutation without another database query",
    async (mutation) => {
      const database = createMigratedDatabase();
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const env = {
        DB: createSqliteD1Database(database, trace),
        MAIN_SECRET: "wave97s-event-pages-mutation-secret",
      } as unknown as Env;
      try {
        seedFixture(database);
        const operation = "visitor-events" as const;
        const query = await middlewareQualifiedEventPageQuery(env, operation);
        const queryCount = trace.preparedSql.length;
        const mutableQuery = query as Record<string, unknown>;
        if (mutation === "target")
          mutableQuery.visitorId = "changed-after-middleware";
        if (mutation === "page") {
          const page = mutableQuery.page as {
            readonly limit: number;
            readonly cursor: string | null;
          };
          mutableQuery.page = { limit: 2, cursor: page.cursor };
        }
        if (mutation === "time") {
          const time = mutableQuery.time as QueryTime;
          mutableQuery.time = {
            ...time,
            capturedAtMs: time.capturedAtMs + 1,
          };
        }
        expect(() =>
          deferredJourneyEventPageQualificationFromQuery(
            query,
            mutation === "operation" ? "session-events" : operation,
          ),
        ).toThrow(/changed/);
        expect(trace.preparedSql).toHaveLength(queryCount);
      } finally {
        database.close();
      }
    },
  );

  it.each(
    (
      [
        [
          "visitor-events",
          "session",
          ["event-owner-outside-window", "page-4", "event-4"],
        ],
        [
          "visitor-events",
          "visitor",
          [
            "page-second-session",
            "event-second-session",
            "event-owner-outside-window",
          ],
        ],
        [
          "session-events",
          "session",
          ["event-owner-outside-window", "page-4", "event-4"],
        ],
        [
          "session-events",
          "visitor",
          ["event-owner-outside-window", "page-4", "event-4"],
        ],
      ] as const
    ).map(([operation, scope, expectedIds]) => ({
      operation,
      scope,
      expectedIds,
    })),
  )(
    "routes $operation/$scope through the qualified envelope for first, next, and third pages",
    async ({ operation, scope, expectedIds }) => {
      const pages = await capturePages({
        operation,
        scope,
        advanced: true,
        pages: 3,
        scenario: "qualified-runtime-first-next-third",
      });
      expect(pages, JSON.stringify(pages, null, 2)).toHaveLength(3);
      const ids = pages.map((page) => {
        const data = page.data as
          { readonly items: readonly { readonly id: string }[] } | undefined;
        expect(data).toBeDefined();
        expect(data!.items).toHaveLength(1);
        return data!.items[0]!.id;
      });
      expect(ids).toEqual(expectedIds);
      for (const page of pages) {
        const calls = page.calls as readonly {
          readonly sql: string;
          readonly bindings: readonly unknown[];
        }[];
        const envelopeCalls = calls.filter(
          ({ sql }) => sql.includes('"rowKind"') && sql.includes('"outputId"'),
        );
        expect(envelopeCalls, JSON.stringify(page, null, 2)).toHaveLength(1);
        expect(
          new TextEncoder().encode(envelopeCalls[0]!.sql).byteLength,
        ).toBeLessThanOrEqual(100_000);
        expect(envelopeCalls[0]!.bindings.length).toBeLessThanOrEqual(100);
        expect(
          (
            page.diagnostics as {
              readonly advancedCountSqlFallbackReason?: unknown;
            }
          ).advancedCountSqlFallbackReason,
        ).toBeUndefined();
      }
      writePostRouteEvidence(`post-${operation}-${scope}.json`, {
        state: "actual-post-route-runtime-qualified-envelope",
        operation,
        scope,
        expectedIds,
        pages,
      });
    },
  );

  it.each([
    {
      operation: "visitor-events",
      scope: "session",
      target: NATIVE_ONLY_VISITOR_ID,
      filterDsl: MIXED_OR_FILTER_DSL,
      booleanShape: "native-only OR Count-only owner",
    },
    {
      operation: "session-events",
      scope: "visitor",
      target: COUNT_ONLY_SESSION_ID,
      filterDsl: MIXED_NOT_FILTER_DSL,
      booleanShape: "NOT over mixed native AND Count tree",
    },
  ] as const)(
    "executes whole-filter $operation/$scope via the qualified envelope ($booleanShape)",
    async ({ operation, scope, target, filterDsl, booleanShape }) => {
      const legacy = await captureLegacyReaderPages({
        operation,
        scope,
        target,
        filterDsl,
        pages: 6,
        limit: 1,
      });
      const legacyFirst = legacy.pages[0]?.data as
        | { readonly pagination: { readonly nextCursor: string | null } }
        | undefined;
      expect(legacyFirst?.pagination.nextCursor).toEqual(expect.any(String));

      const newFirstPage = await capturePages({
        operation,
        scope,
        target,
        filterDsl,
        advanced: true,
        pages: 1,
        limit: 1,
        scenario: "whole-boolean-first-page",
      });
      const newContinuation = await capturePages({
        operation,
        scope,
        target,
        filterDsl,
        advanced: true,
        cursor: legacyFirst!.pagination.nextCursor,
        pages: 6,
        limit: 1,
        scenario: "whole-boolean-old-cursor-continuation",
      });
      const newPages = [...newFirstPage, ...newContinuation];
      expect(newPages).toHaveLength(legacy.pages.length);
      expect(legacy.beforeFallbackIdentity).toEqual(
        legacy.afterFallbackIdentity,
      );
      expect(legacy.afterFallbackIdentity).toEqual(
        newFirstPage[0]?.requestIdentity,
      );
      expect(newContinuation[0]?.requestCursor).toBe(
        legacyFirst!.pagination.nextCursor,
      );
      expect(newPages.map(({ data }) => data)).toEqual(
        legacy.pages.map(({ data }) => data),
      );

      const itemIds = newPages.flatMap((page) => {
        const data = page.data as
          { readonly items: readonly { readonly id: string }[] } | undefined;
        expect(data).toBeDefined();
        return data!.items.map(({ id }) => id);
      });
      expect(itemIds).toHaveLength(4);
      expect(new Set(itemIds).size).toBe(4);
      expect(itemIds).toEqual(
        expect.arrayContaining(
          operation === "visitor-events"
            ? [
                "page-native-only-1",
                "event-native-only-1",
                "page-native-only-2",
                "event-native-only-2",
              ]
            : [
                "page-count-only-1",
                "event-count-only-1",
                "page-count-only-2",
                "event-count-only-2",
              ],
        ),
      );

      const middlewareDatabase = createMigratedDatabase();
      const middlewareTrace: SqliteD1Trace = {
        preparedSql: [],
        bindings: [],
      };
      const middlewareEnv = {
        DB: createSqliteD1Database(middlewareDatabase, middlewareTrace),
        MAIN_SECRET: "wave97s-event-pages-whole-filter-contract-secret",
      } as unknown as Env;
      let requestConfiguration: unknown;
      let advancedMatchesPresent = true;
      try {
        seedFixture(middlewareDatabase);
        const middlewareQuery = await middlewareQualifiedEventPageQuery(
          middlewareEnv,
          operation,
          { scope, target, filterDsl },
        );
        const request = deferredJourneyEventPageQualificationFromQuery(
          middlewareQuery,
          operation,
        );
        expect(request).toBeDefined();
        requestConfiguration = request?.configuration;
        advancedMatchesPresent =
          request?.qualification.requestScopePlan?.preparedMembership !==
            undefined ||
          scopedFilterMetadata(request?.qualification.filters)?.plan
            .preparedMembership !== undefined;
        expect(request?.configuration.filterMode).toBe("allow-whole-filter");
        expect(advancedMatchesPresent).toBe(false);
      } finally {
        middlewareDatabase.close();
      }

      const newCalls = newPages.flatMap(({ calls }) => calls);
      const compiledEnvelopes = newCalls
        .filter(({ sql }) => isEnvelopeSql(sql))
        .map(({ sql, bindings }) => ({
          sql,
          bindings,
          utf8Bytes: new TextEncoder().encode(sql).byteLength,
          slotCount: bindings.length,
          envelope: true,
        }));
      const metadataQueryCount = newCalls.filter(({ sql }) =>
        isCoverageMetadataSql(sql),
      ).length;
      const factQueryCount = newCalls.length - metadataQueryCount;
      for (const page of newPages) {
        const calls = page.calls as readonly {
          readonly sql: string;
          readonly bindings: readonly unknown[];
        }[];
        const envelopeCalls = calls.filter(({ sql }) => isEnvelopeSql(sql));
        expect(envelopeCalls).toHaveLength(1);
        expect(
          new TextEncoder().encode(envelopeCalls[0]!.sql).byteLength,
        ).toBeLessThanOrEqual(100_000);
        expect(envelopeCalls[0]!.bindings.length).toBeLessThanOrEqual(100);
        expect(
          (
            page.diagnostics as {
              readonly advancedCountSqlFallbackReason?: unknown;
            }
          ).advancedCountSqlFallbackReason,
        ).toBeUndefined();
      }
      writePostRouteEvidence(`post-whole-boolean-${operation}-${scope}.json`, {
        state: "actual-post-route-whole-filter-envelope-matches-legacy-reader",
        operation,
        scope,
        target,
        booleanShape,
        filterDsl,
        requestConfiguration,
        advancedMatchesPresent,
        legacyProducerCalls: legacy.producerCalls,
        legacyBeforeFallbackIdentity: legacy.beforeFallbackIdentity,
        legacyAfterFallbackIdentity: legacy.afterFallbackIdentity,
        legacyReaderPages: legacy.pages,
        newPages,
        compiledEnvelopes,
        metadataQueryCount,
        factQueryCount,
        limits: { maxUtf8Bytes: 100_000, maxSlots: 100 },
      });
    },
  );

  it.each(
    (
      [
        [
          "visitor-events",
          [
            ["page-second-session", BASE + 6_000],
            ["event-second-session", BASE + 6_000],
            ["event-owner-outside-window", BASE + 5_000],
          ],
        ],
        [
          "session-events",
          [
            ["event-owner-outside-window", BASE + 5_000],
            ["page-4", BASE + 4_000],
            ["event-4", BASE + 4_000],
          ],
        ],
      ] as const
    ).map(([operation, expectedRows]) => ({ operation, expectedRows })),
  )(
    "serves ordinary $operation through the prepared runtime for three signed-cursor pages",
    async ({ operation, expectedRows }) => {
      const database = createMigratedDatabase();
      const env = {
        DB: createSqliteD1Database(database),
        MAIN_SECRET: "wave97s-event-pages-baseline-secret",
      } as unknown as Env;
      let directItems: readonly unknown[] = [];
      try {
        seedFixture(database);
        const request = eventQuery(operation);
        const window = {
          startMs: request.time.range.startMs,
          endExclusiveMs: request.time.range.endExclusiveMs,
          nowMs: request.time.capturedAtMs,
          timeZone: request.time.reportingTimeZone,
        };
        const direct =
          operation === "visitor-events"
            ? await readSiteVisitorEvents({
                env,
                siteId: SITE_ID,
                visitorId: TARGET_VISITOR_ID,
                window,
                filters: EMPTY_FILTER_DOCUMENT,
                audience: "private-dashboard",
                page: { limit: 1, cursor: null },
              })
            : await readSiteSessionEvents({
                env,
                siteId: SITE_ID,
                sessionId: TARGET_SESSION_ID,
                window,
                filters: EMPTY_FILTER_DOCUMENT,
                audience: "private-dashboard",
                page: { limit: 1, cursor: null },
              });
        directItems = direct.items;
      } finally {
        database.close();
      }
      expect(directItems).toHaveLength(1);
      writePostRouteEvidence(`ordinary-direct-control-${operation}.json`, {
        directReader: "readSiteVisitorEvents/readSiteSessionEvents",
        filters: "EMPTY_FILTER_DOCUMENT, passed without middleware metadata",
        directItemCount: directItems.length,
        directFirstItem: directItems[0],
        note: "This unprepared control does not replace prepared runtime semantics.",
      });

      const pages = await capturePages({
        operation,
        advanced: false,
        pages: 3,
        scenario: "ordinary-no-advanced-three-page-after-routing",
      });
      writePostRouteEvidence(
        `ordinary-runtime-three-page-${operation}.json`,
        pages,
      );
      expect(pages[0]?.error).toBeUndefined();
      expect(pages).toHaveLength(3);
      const actualRows = pages.flatMap((page) => {
        const data = page.data as
          | {
              readonly items: readonly {
                readonly id: string;
                readonly occurredAt: number;
                readonly eventType: string;
              }[];
              readonly pagination: { readonly nextCursor: string | null };
            }
          | undefined;
        expect(data).toBeDefined();
        expect(data!.items).toHaveLength(1);
        expect(data!.items[0]?.eventType).toEqual(expect.any(String));
        return data!.items.map(({ id, occurredAt }) => ({ id, occurredAt }));
      });
      expect(actualRows).toEqual(
        expectedRows.map(([id, occurredAt]) => ({ id, occurredAt })),
      );
      expect(actualRows).toEqual(
        [...actualRows].sort(
          (left, right) =>
            right.occurredAt - left.occurredAt ||
            right.id.localeCompare(left.id),
        ),
      );
      for (const [index, page] of pages.entries()) {
        const calls = page.calls as readonly { readonly sql: string }[];
        expect(calls).toHaveLength(2);
        expect(calls.some(({ sql }) => isEnvelopeSql(sql))).toBe(false);
        const data = page.data as {
          readonly pagination: { readonly nextCursor: string | null };
        };
        expect(data.pagination.nextCursor).toEqual(expect.any(String));
        if (index > 0) expect(page.requestCursor).toEqual(expect.any(String));
      }
    },
  );

  it.each([
    "unknown-row-kind",
    "illegal-report-id",
    "illegal-report-kind",
  ] as const)(
    "rejects envelope protocol mutation %s without fallback or presence probe",
    async (mutation) => {
      const pages = await capturePages({
        operation: "visitor-events",
        scope: "session",
        advanced: true,
        pages: 1,
        scenario: `envelope-protocol-${mutation}`,
        interceptEnvelope: (result) =>
          mapEnvelopeRows(result, (row) => {
            if (mutation === "unknown-row-kind" && row.rowKind === "report")
              return { ...row, rowKind: "unrecognized" };
            if (mutation === "illegal-report-id" && row.rowKind === "report")
              return { ...row, id: "" };
            if (mutation === "illegal-report-kind" && row.rowKind === "report")
              return { ...row, kind: "unknown" };
            return row;
          }),
      });
      expect(pages[0]?.error).toMatchObject({ kind: "internal" });
      const applicationLogs = pages[0]?.applicationLogs as
        | readonly {
            readonly data?: { readonly errorMessage?: string };
          }[]
        | undefined;
      const expectedProtocolError =
        mutation === "unknown-row-kind"
          ? "journey_event_page_qualification_envelope_kind_invalid"
          : "journey_event_page_qualification_report_identity_invalid";
      expect(
        applicationLogs?.some(({ data }) =>
          data?.errorMessage?.includes(expectedProtocolError),
        ),
      ).toBe(true);
      const calls = pages[0]?.calls as readonly { readonly sql: string }[];
      expect(calls).toHaveLength(2);
      expect(calls.filter(({ sql }) => isEnvelopeSql(sql))).toHaveLength(1);
    },
  );

  it.each(
    (
      [
        [
          "visitor-events",
          "session",
          [
            ["page-second-session", BASE + 6_000],
            ["event-second-session", BASE + 6_000],
            ["event-owner-outside-window", BASE + 5_000],
          ],
        ],
        [
          "session-events",
          "visitor",
          [
            ["event-owner-outside-window", BASE + 5_000],
            ["page-4", BASE + 4_000],
            ["event-4", BASE + 4_000],
          ],
        ],
      ] as const
    ).map(([operation, scope, expectedRows]) => ({
      operation,
      scope,
      expectedRows,
    })),
  )(
    "serves native-only $operation with explicit non-default $scope scope",
    async ({ operation, scope, expectedRows }) => {
      const pages = await capturePages({
        operation,
        scope,
        advanced: true,
        filterDsl: 'page.path eq "/native"',
        pages: 3,
        scenario: `native-only-${operation}-explicit-${scope}-three-pages`,
      });
      expect(pages).toHaveLength(3);
      const actualRows = pages.flatMap((page) => {
        const data = page.data as
          | {
              readonly items: readonly {
                readonly id: string;
                readonly occurredAt: number;
                readonly kind: string;
              }[];
            }
          | undefined;
        expect(data).toBeDefined();
        expect(data!.items).toHaveLength(1);
        return data!.items.map(({ id, occurredAt, kind }) => ({
          id,
          occurredAt,
          kind,
        }));
      });
      expect(actualRows).toEqual(
        expectedRows.map(([id, occurredAt]) => ({
          id,
          occurredAt,
          kind: id.startsWith("page-") ? "pageview" : "custom",
        })),
      );
      for (const page of pages) {
        const calls = page.calls as readonly { readonly sql: string }[];
        expect(calls.some(({ sql }) => isEnvelopeSql(sql))).toBe(false);
      }
      writePostRouteEvidence(
        `ordinary-native-${operation}-explicit-${scope}.json`,
        pages,
      );
    },
  );

  it.each(["visitor-events", "session-events"] as const)(
    "keeps native-only $operation auto scope equivalent to its explicit default",
    async (operation) => {
      const defaultScope =
        operation === "visitor-events" ? "visitor" : "session";
      const auto = await capturePages({
        operation,
        advanced: true,
        filterDsl: 'page.path eq "/native"',
        pages: 3,
        scenario: `native-only-${operation}-auto-three-pages`,
      });
      const explicit = await capturePages({
        operation,
        scope: defaultScope,
        advanced: true,
        filterDsl: 'page.path eq "/native"',
        pages: 3,
        scenario: `native-only-${operation}-default-scope-three-pages`,
      });
      const summarize = (pages: readonly CapturedRuntimePage[]) =>
        pages.flatMap((page) => {
          const data = page.data as
            | {
                readonly items: readonly {
                  readonly id: string;
                  readonly kind: string;
                  readonly occurredAt: number;
                }[];
              }
            | undefined;
          expect(data).toBeDefined();
          return data!.items.map(({ id, kind, occurredAt }) => ({
            id,
            kind,
            occurredAt,
          }));
        });
      expect(auto).toHaveLength(3);
      expect(explicit).toHaveLength(3);
      expect(summarize(auto)).toEqual(summarize(explicit));
      for (const page of [...auto, ...explicit]) {
        const calls = page.calls as readonly { readonly sql: string }[];
        expect(calls.some(({ sql }) => isEnvelopeSql(sql))).toBe(false);
      }
    },
  );

  it("surfaces envelope D1 failure without legacy fallback or target presence", async () => {
    const pages = await capturePages({
      operation: "visitor-events",
      scope: "session",
      advanced: true,
      pages: 1,
      scenario: "envelope-d1-failure",
      interceptEnvelope: () => {
        throw new Error("test_envelope_d1_failure");
      },
    });
    expect(pages[0]?.error).toMatchObject({ kind: "internal" });
    const calls = pages[0]?.calls as readonly { readonly sql: string }[];
    expect(calls).toHaveLength(2);
    expect(calls.filter(({ sql }) => isEnvelopeSql(sql))).toHaveLength(1);
  });

  it("honors a pre-aborted request without entering envelope, fallback, or presence", async () => {
    const controller = new AbortController();
    controller.abort();
    const pages = await capturePages({
      operation: "visitor-events",
      scope: "session",
      advanced: true,
      pages: 1,
      scenario: "pre-aborted-request",
      signal: controller.signal,
    });
    expect(pages[0]?.error).toMatchObject({ kind: "request-cancelled" });
    const calls = pages[0]?.calls as readonly { readonly sql: string }[];
    expect(calls.some(({ sql }) => isEnvelopeSql(sql))).toBe(false);
    expect(calls.length).toBeLessThanOrEqual(1);
  });

  it("honors abort at envelope completion without continuing to target presence", async () => {
    const controller = new AbortController();
    const pages = await capturePages({
      operation: "visitor-events",
      scope: "session",
      advanced: true,
      pages: 1,
      scenario: "abort-after-envelope-before-presence",
      signal: controller.signal,
      interceptEnvelope: (result) => {
        controller.abort();
        return result;
      },
    });
    expect(pages[0]?.error).toMatchObject({ kind: "request-cancelled" });
    const calls = pages[0]?.calls as readonly { readonly sql: string }[];
    expect(calls).toHaveLength(2);
    expect(calls.filter(({ sql }) => isEnvelopeSql(sql))).toHaveLength(1);
  });

  it("enforces the control rawCount cap before missing-target and bad-cursor checks", async () => {
    const pages = await capturePages({
      operation: "visitor-events",
      scope: "session",
      advanced: true,
      target: "missing-target",
      cursor: "malformed-cursor",
      pages: 1,
      scenario: "control-protocol-raw-count-cap-not-a-large-seed",
      interceptEnvelope: (result) =>
        mapEnvelopeRows(result, (row) =>
          row.rowKind === "control" ? { ...row, rawCount: 20_001 } : row,
        ),
    });
    expect(pages[0]?.error).toMatchObject({ kind: "invalid-input" });
    const calls = pages[0]?.calls as readonly { readonly sql: string }[];
    expect(calls).toHaveLength(2);
    expect(calls.filter(({ sql }) => isEnvelopeSql(sql))).toHaveLength(1);
  });

  it("preserves legal Page/custom rows with the same bare id", async () => {
    let assignedPage = false;
    let assignedCustom = false;
    const sharedId = "legal-shared-page-custom-id";
    const pages = await capturePages({
      operation: "visitor-events",
      scope: "session",
      advanced: true,
      limit: 20,
      pages: 1,
      scenario: "legal-page-custom-shared-bare-id",
      interceptEnvelope: (result) =>
        mapEnvelopeRows(result, (row) => {
          if (row.rowKind !== "report") return row;
          if (row.kind === "pageview" && !assignedPage) {
            assignedPage = true;
            return { ...row, id: sharedId };
          }
          if (row.kind === "custom" && !assignedCustom) {
            assignedCustom = true;
            return { ...row, id: sharedId };
          }
          return row;
        }),
    });
    const data = pages[0]?.data as
      | {
          readonly items: readonly {
            readonly id: string;
            readonly kind: string;
          }[];
        }
      | undefined;
    expect(data).toBeDefined();
    expect(assignedPage).toBe(true);
    expect(assignedCustom).toBe(true);
    expect(
      data!.items.filter(({ id }) => id === sharedId).map(({ kind }) => kind),
    ).toEqual(expect.arrayContaining(["pageview", "custom"]));
  });

  it("rejects signed cursors bound to another operation or target", async () => {
    const first = await capturePages({
      operation: "visitor-events",
      scope: "session",
      advanced: true,
      pages: 1,
      scenario: "signed-cursor-source",
    });
    const firstData = first[0]?.data as
      | { readonly pagination: { readonly nextCursor: string | null } }
      | undefined;
    const cursor = firstData?.pagination.nextCursor;
    expect(cursor).toEqual(expect.any(String));

    const wrongOperation = await capturePages({
      operation: "session-events",
      scope: "session",
      advanced: true,
      cursor,
      pages: 1,
      scenario: "signed-cursor-wrong-operation",
    });
    const wrongTarget = await capturePages({
      operation: "visitor-events",
      scope: "session",
      advanced: true,
      target: EVENT_ONLY_VISITOR_ID,
      cursor,
      pages: 1,
      scenario: "signed-cursor-wrong-target",
    });
    expect(wrongOperation[0]?.error).toMatchObject({ kind: "invalid-cursor" });
    expect(wrongTarget[0]?.error).toMatchObject({ kind: "invalid-cursor" });
    for (const page of [wrongOperation[0]!, wrongTarget[0]!]) {
      const calls = page.calls as readonly { readonly sql: string }[];
      expect(calls).toHaveLength(3);
    }
  });

  it.each(["visitor-events", "session-events"] as const)(
    "returns a filtered-empty page for a present target in $operation",
    async (operation) => {
      const pages = await capturePages({
        operation,
        scope: "visitor",
        advanced: true,
        filterDsl:
          'page.path eq "/impossible" and count(page { page.path eq "/qualify" }) gte 1',
        pages: 1,
        scenario: "present-target-filtered-empty-after-routing",
      });
      expect(pages).toHaveLength(1);
      expect(pages[0]?.data).toMatchObject({ items: [] });
      const calls = pages[0]?.calls as readonly { readonly sql: string }[];
      expect(
        calls.filter(
          ({ sql }) => sql.includes('"rowKind"') && sql.includes('"outputId"'),
        ),
      ).toHaveLength(1);
      expect(
        (
          pages[0]?.diagnostics as {
            readonly advancedCountSqlFallbackReason?: unknown;
          }
        ).advancedCountSqlFallbackReason,
      ).toBeUndefined();
      writePostRouteEvidence(`post-filtered-empty-${operation}.json`, pages);
    },
  );

  it.each(["visitor-events", "session-events"] as const)(
    "checks target presence before surfacing a malformed cursor in $operation",
    async (operation) => {
      const missing = await capturePages({
        operation,
        scope: "visitor",
        advanced: true,
        target: "missing-target",
        cursor: "malformed-cursor",
        pages: 1,
        scenario: "missing-target-malformed-cursor-after-routing",
      });
      const present = await capturePages({
        operation,
        scope: "visitor",
        advanced: true,
        cursor: "malformed-cursor",
        pages: 1,
        scenario: "present-target-malformed-cursor-after-routing",
      });
      expect(missing[0]?.error).toMatchObject({ kind: "internal" });
      expect(present[0]?.error).toMatchObject({ kind: "invalid-cursor" });
      for (const page of [missing[0]!, present[0]!]) {
        const calls = page.calls as readonly { readonly sql: string }[];
        expect(calls).toHaveLength(3);
        expect(
          calls.filter(
            ({ sql }) =>
              sql.includes('"rowKind"') && sql.includes('"outputId"'),
          ),
        ).toHaveLength(1);
        expect(calls.at(-1)?.sql).toContain('"present"');
        expect(
          (
            page.diagnostics as {
              readonly advancedCountSqlFallbackReason?: unknown;
            }
          ).advancedCountSqlFallbackReason,
        ).toBeUndefined();
      }
      writePostRouteEvidence(`post-cursor-priority-${operation}.json`, {
        missingTarget: missing,
        presentTarget: present,
      });
    },
  );

  it.each(["visitor-events", "session-events"] as const)(
    "reads the entity membership instead of the legacy ID bridge in %s",
    async (operation) => {
      const database = createMigratedDatabase();
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const legacyTrace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const secret = "wave97s-event-pages-membership-secret";
      const env = {
        DB: createSqliteD1Database(database, trace),
        MAIN_SECRET: secret,
      } as unknown as Env;
      const legacyEnv = {
        DB: createSqliteD1Database(database, legacyTrace),
        MAIN_SECRET: secret,
      } as unknown as Env;
      const diagnostics = createD1ReadDiagnostics();
      try {
        seedFixture(database);
        database
          .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
          .run("invalid-duration", "page-1");
        const query = eventQuery(operation, {
          scope: "visitor",
          advanced: true,
          limit: 10,
          filterDsl:
            'page.path eq "/native" and count(page { page.path eq "/qualify" }) gte 1 and count(page { page.durationMs gt 5 }) gte 0',
        });
        const result = await createD1SiteQueryRuntime({
          env,
          siteId: SITE_ID,
          diagnostics,
        }).execute(operation, query);
        expect(result.ok, JSON.stringify(result)).toBe(true);
        if (!result.ok) throw new Error("event_page_membership_failed");
        expect(diagnostics.advancedCountSqlFallbackReason).toEqual({
          kind: "numeric-data-domain",
          fieldIds: ["page.durationMs"],
        });

        const prepared = prepareScopedQuery(
          operation,
          query,
        ) as unknown as JourneyEventQuery &
          QueryInput &
          Record<string, unknown>;
        let forwarded: unknown;
        await d1AdvancedFilterMiddleware(legacyEnv, undefined, SITE_ID)(
          operation,
          prepared,
          async (value) => {
            forwarded = value;
            return value;
          },
        );
        const qualification = deferredEventQualificationFromQuery(
          forwarded as QueryInput & Record<string, unknown>,
          operation,
        );
        if (!qualification) throw new Error("event_page_legacy_missing");
        const legacyFilters =
          await prepareDeferredEventQualificationFallback(qualification);
        const window = {
          startMs: prepared.time.range.startMs,
          endExclusiveMs: prepared.time.range.endExclusiveMs,
          nowMs: prepared.time.capturedAtMs,
          timeZone: prepared.time.reportingTimeZone,
        };
        const page = { limit: 10, cursor: null };
        const legacy =
          operation === "visitor-events"
            ? await readSiteVisitorEvents({
                env: legacyEnv,
                siteId: SITE_ID,
                visitorId: TARGET_VISITOR_ID,
                window,
                filters: legacyFilters,
                audience: "private-dashboard",
                page,
              })
            : await readSiteSessionEvents({
                env: legacyEnv,
                siteId: SITE_ID,
                sessionId: TARGET_SESSION_ID,
                window,
                filters: legacyFilters,
                audience: "private-dashboard",
                page,
              });
        expect(legacy.items.length).toBeGreaterThan(0);
        expect(result.data).toEqual(legacy);
        // The legacy ID bridge binds the entity kind next to every identity;
        // the request-private entity membership binds only (site, id) pairs.
        const tokens = (bindings: readonly (readonly unknown[])[]) =>
          bindings.some(
            (values) =>
              values.includes("visitor") || values.includes("session"),
          );
        expect(tokens(trace.bindings.slice(-1))).toBe(false);
      } finally {
        database.close();
      }
    },
  );

  it.each(["visitor-events", "session-events"] as const)(
    "uses the original whole-reader fallback for actual TEXT numeric Count data in $operation",
    async (operation) => {
      const database = createMigratedDatabase();
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const env = {
        DB: createSqliteD1Database(database, trace),
        MAIN_SECRET: "wave97s-event-pages-numeric-fallback-secret",
      } as unknown as Env;
      const diagnostics = createD1ReadDiagnostics();
      try {
        seedFixture(database);
        database
          .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
          .run("invalid-duration", "page-1");
        const query = eventQuery(operation, {
          scope: "visitor",
          advanced: true,
          filterDsl:
            'page.path eq "/native" and count(page { page.durationMs gt 5 }) eq 1',
        });
        const result = await createD1SiteQueryRuntime({
          env,
          siteId: SITE_ID,
          diagnostics,
        }).execute(operation, query);
        expect(result.ok, JSON.stringify(result)).toBe(true);
        expect(diagnostics.advancedCountSqlFallbackReason).toEqual({
          kind: "numeric-data-domain",
          fieldIds: ["page.durationMs"],
        });
        expect(
          trace.preparedSql.filter(
            (sql) => sql.includes('"rowKind"') && sql.includes('"outputId"'),
          ),
        ).toHaveLength(1);
        writePostRouteEvidence(`post-numeric-fallback-${operation}.json`, {
          state: "actual-text-numeric-domain-triggered-whole-reader-fallback",
          operation,
          result,
          diagnostics,
          calls: trace.preparedSql.map((sql, index) => ({
            sql,
            bindings: trace.bindings[index] ?? [],
          })),
        });
      } finally {
        database.close();
      }
    },
  );
});
