import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { afterAll, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { createD1SiteProviderRegistry } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import {
  prepareScopedQuery,
  type QueryInput,
  type QueryTime,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { createQueryTime } from "@/lib/edge/analytics/contract/helpers";
import {
  d1AdvancedFilterMiddleware,
  deferredPagesAggregatePageQualificationFromQuery,
  prepareDeferredEventQualificationFallback,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import {
  compilePagesAggregateQualificationProgram,
  type EventSummaryQualificationCompilationEvidence,
  type PagesAggregateQualificationReportQuery,
} from "@/lib/edge/analytics/providers/d1/internal/analytics-qualification-program";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import {
  decodePagesCursor,
  queryPagesPageFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/pages";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import type { FilterDocument } from "@/lib/filter-contract/filters";
import { InvalidCursorError } from "@/lib/pagination";

const SITE = "wave96b-pages-aggregate";
const TIME = createQueryTime(100, 200, "UTC", 300);
const WINDOW = {
  startMs: 100,
  endExclusiveMs: 200,
  nowMs: 300,
  timeZone: "UTC",
} as const;
const CURSOR_SECRET = "wave96b-pages-aggregate-test-secret";
const BASE_FILTER =
  'page.path neq "/excluded" and count(event { event.name eq "qualifier" }) eq 1';
const databases = new Set<DatabaseSync>();
const sqlEvidence: Array<Record<string, unknown>> = [];

interface TestSite {
  readonly id: string;
  readonly pk: number;
}

interface PagesTestQuery extends QueryInput {
  readonly time: QueryTime;
  readonly limit: number;
  readonly includeDetails: boolean;
  readonly includeTabs?: boolean;
  readonly variant?: "list" | "tabs";
  readonly page: { readonly limit: number; readonly cursor?: string };
}

interface PageItem {
  readonly pathname: string;
  readonly query: string;
  readonly hash: string;
  readonly views: number;
  readonly sessions: number;
}

interface PagesPage {
  readonly items: readonly PageItem[];
  readonly pagination: {
    readonly limit: number;
    readonly returned: number;
    readonly hasMore: boolean;
    readonly nextCursor: string | null;
  };
}

interface PageKey {
  readonly pathname: string;
  readonly query: string;
  readonly hash: string;
}

const pageKeys: readonly PageKey[] = [
  { pathname: "/same", query: "", hash: "" },
  { pathname: "/same", query: "q=one", hash: "#one" },
  { pathname: "/same", query: "q=two", hash: "#two" },
  { pathname: "/unicode/雪", query: "σ=值", hash: "#雪" },
  { pathname: "/nul\u0000path", query: "a\u0000b", hash: "h\u0000" },
  { pathname: "   ", query: "   ", hash: "   " },
  { pathname: "", query: "", hash: "" },
  { pathname: "/empty-query", query: "", hash: "#nonempty" },
  { pathname: "/empty-hash", query: "?x=y", hash: "" },
  { pathname: "/excluded", query: "filtered=yes", hash: "#filtered" },
];

function traceFor(): SqliteD1Trace {
  return { preparedSql: [], bindings: [] };
}

function addSite(database: DatabaseSync): TestSite {
  database
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .run(SITE);
  const identity = database
    .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
    .get(SITE) as { readonly site_pk: number };
  database
    .prepare(
      `INSERT INTO sites (id, team_id, name, domain, created_at)
       VALUES (?, 'wave96b-team', 'Pages aggregate', 'pages.test', 0)`,
    )
    .run(SITE);
  return { id: SITE, pk: Number(identity.site_pk) };
}

function addVisit(
  database: DatabaseSync,
  site: TestSite,
  input: {
    readonly id: string;
    readonly visitorId: string;
    readonly sessionId: string;
    readonly page: PageKey;
    readonly at: number;
  },
): void {
  database
    .prepare(
      `INSERT INTO visits (
        visit_id, site_id, site_pk, visitor_id, session_id, status,
        started_at, last_activity_at, pathname, query_string, hash_fragment,
        hostname, duration_ms
      ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, ?, ?, 'pages.test', 10)`,
    )
    .run(
      input.id,
      site.id,
      site.pk,
      input.visitorId,
      input.sessionId,
      input.at,
      input.at,
      input.page.pathname,
      input.page.query,
      input.page.hash,
    );
}

function addQualifier(database: DatabaseSync, site: TestSite, visitId: string) {
  database
    .prepare(
      `INSERT INTO custom_event_names (id, site_id, name, last_seen_at, site_pk)
       VALUES (1, ?, 'qualifier', 150, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .run(site.id, site.pk);
  database
    .prepare(
      `INSERT INTO custom_events (
        event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
        received_at, sequence, node_count, value_count
      ) VALUES (?, ?, ?, ?, 1, 150, 150, 1, 0, 0)`,
    )
    .run(`qualifier-${visitId}`, site.id, site.pk, visitId);
}

function createFixture(): DatabaseSync {
  const database = createMigratedDatabase();
  databases.add(database);
  database.exec("PRAGMA foreign_keys = OFF");
  const site = addSite(database);
  for (let visitorIndex = 0; visitorIndex < 7; visitorIndex += 1) {
    const visitorId = `visitor-${visitorIndex}`;
    const qualifyingSession = `${visitorId}-session-qualified`;
    const qualifierVisitId = `${visitorId}-qualifier-source`;
    addVisit(database, site, {
      id: qualifierVisitId,
      visitorId,
      sessionId: qualifyingSession,
      page: {
        pathname: "/qualifier-source",
        query: "source=qualifier",
        hash: "#source",
      },
      at: 120 + visitorIndex,
    });
    addQualifier(database, site, qualifierVisitId);
    addVisit(database, site, {
      id: `${visitorId}-report-page`,
      visitorId,
      sessionId: qualifyingSession,
      page: pageKeys[(visitorIndex * 2) % pageKeys.length]!,
      at: 121 + visitorIndex,
    });
    addVisit(database, site, {
      id: `${visitorId}-session-two-page`,
      visitorId,
      sessionId: `${visitorId}-session-two`,
      page: pageKeys[(visitorIndex * 2 + 1) % pageKeys.length]!,
      at: 122 + visitorIndex,
    });
    addVisit(database, site, {
      id: `${visitorId}-session-three-page`,
      visitorId,
      sessionId: `${visitorId}-session-three`,
      page: pageKeys[(visitorIndex * 2 + 3) % pageKeys.length]!,
      at: 123 + visitorIndex,
    });
  }
  return database;
}

function createWholeBooleanFixture(): DatabaseSync {
  const database = createMigratedDatabase();
  databases.add(database);
  database.exec("PRAGMA foreign_keys = OFF");
  const site = addSite(database);
  const visit = (
    id: string,
    visitorId: string,
    sessionId: string,
    pathname: string,
    at: number,
    qualifier = false,
  ) => {
    addVisit(database, site, {
      id,
      visitorId,
      sessionId,
      page: { pathname, query: "", hash: "" },
      at,
    });
    if (qualifier) addQualifier(database, site, id);
  };

  visit("whole-a-native", "whole-a", "whole-a-session", "/native", 120);
  visit(
    "whole-a-expanded",
    "whole-a",
    "whole-a-session",
    "/native-expanded",
    121,
  );
  visit(
    "whole-a-other-session",
    "whole-a",
    "whole-a-session-two",
    "/visitor-expansion",
    122,
  );
  visit(
    "whole-b-event",
    "whole-b",
    "whole-b-session",
    "/count-event",
    123,
    true,
  );
  visit("whole-b-report", "whole-b", "whole-b-session", "/count-report", 124);
  visit("whole-c-neither", "whole-c", "whole-c-session", "/neither", 125);
  return database;
}

function testEnv(database: DatabaseSync, trace: SqliteD1Trace): Env {
  return {
    DB: createSqliteD1Database(database, trace),
    MAIN_SECRET: CURSOR_SECRET,
  } as unknown as Env;
}

function queryFor(
  scope: "session" | "visitor" | "event",
  input: {
    readonly limit?: number;
    readonly cursor?: string | null;
    readonly includeDetails?: boolean;
    readonly includeTabs?: boolean;
    readonly variant?: "list" | "tabs";
    readonly audience?: "private-dashboard" | "public-share";
    readonly filterDsl?: string;
    readonly time?: QueryTime;
  } = {},
): PagesTestQuery {
  const limit = input.limit ?? 2;
  const prepared = prepareScopedQuery("pages", {
    context: siteQueryContext(SITE, input.audience ?? "private-dashboard"),
    time: input.time ?? TIME,
    filters: parseFilterDsl(
      input.filterDsl ?? BASE_FILTER,
      analyticsFilterRegistry,
    ),
    scopePreference: scope,
  } as QueryInput & { readonly time: QueryTime });
  return {
    ...prepared,
    time: input.time ?? TIME,
    limit,
    includeDetails: input.includeDetails ?? false,
    includeTabs: input.includeTabs ?? false,
    ...(input.variant !== undefined ? { variant: input.variant } : {}),
    page: {
      limit,
      ...(input.cursor !== undefined && input.cursor !== null
        ? { cursor: input.cursor }
        : {}),
    },
  } as PagesTestQuery;
}

async function providerPage(
  database: DatabaseSync,
  query: PagesTestQuery,
  trace = traceFor(),
  env = testEnv(database, trace),
): Promise<{
  readonly page: PagesPage;
  readonly source: string | undefined;
  readonly trace: SqliteD1Trace;
}> {
  const provider = createD1SiteProviderRegistry({
    env,
    siteId: SITE,
    diagnostics: createD1ReadDiagnostics(),
  }).resolve("pages");
  if (!provider) throw new Error("wave96b_pages_provider_missing");
  const result = await provider.execute(query);
  return {
    page: result.value as PagesPage,
    source: result.source,
    trace,
  };
}

async function independentLegacyOracleWithTrace(
  database: DatabaseSync,
  query: PagesTestQuery,
): Promise<{ readonly page: PagesPage; readonly trace: SqliteD1Trace }> {
  const trace = traceFor();
  const env = testEnv(database, trace);
  const forwarded = await d1AdvancedFilterMiddleware(env, undefined, SITE)(
    "performance",
    query,
    async (prepared) => prepared,
  );
  const filters =
    (forwarded as PagesTestQuery).filters ?? query.filters ?? EMPTY_FILTERS;
  if (!scopedFilterMetadata(filters)?.plan.preparedMembership)
    throw new Error("wave96b_legacy_oracle_did_not_prepare_selected_matches");
  if (deferredPagesAggregatePageQualificationFromQuery(forwarded))
    throw new Error("wave96b_legacy_oracle_used_deferred_pages_path");
  const cursorText = query.page.cursor ?? null;
  const cursor = await decodePagesCursor(
    env,
    SITE,
    WINDOW,
    filters,
    query.includeDetails,
    cursorText,
    query.context.policy.audience,
  );
  if (cursorText && !cursor) throw new InvalidCursorError("pages");
  const page = await queryPagesPageFromD1(
    env,
    SITE,
    WINDOW,
    filters,
    query.page.limit,
    query.includeDetails,
    cursor,
    query.context.policy.audience,
  );
  return { page, trace };
}

async function independentLegacyOracle(
  database: DatabaseSync,
  query: PagesTestQuery,
): Promise<PagesPage> {
  return (await independentLegacyOracleWithTrace(database, query)).page;
}

const EMPTY_FILTERS: FilterDocument = { version: 1, root: null };

async function compilePagesProgram(
  database: DatabaseSync,
  query: PagesTestQuery,
  trace = traceFor(),
) {
  const env = testEnv(database, trace);
  const forwarded = await d1AdvancedFilterMiddleware(env, undefined, SITE)(
    "pages",
    query,
    async (prepared) => prepared,
  );
  const deferred = deferredPagesAggregatePageQualificationFromQuery(forwarded);
  if (!deferred) throw new Error("wave96b_pages_deferred_brand_missing");
  const filters = (forwarded as PagesTestQuery).filters ?? EMPTY_FILTERS;
  const queryTime = scopedFilterMetadata(filters)?.time ?? query.time;
  const reportQuery: PagesAggregateQualificationReportQuery = {
    env,
    siteId: SITE,
    queryTime,
    filters,
    ...(query.scopePlan ? { scopePlan: query.scopePlan } : {}),
    limit: query.page.limit,
    includeDetails: query.includeDetails,
    cursor: null,
    cursorToken: query.page.cursor ?? null,
    audience: query.context.policy.audience,
    variant: query.variant,
    includeTabs: query.includeTabs,
  };
  return compilePagesAggregateQualificationProgram({
    deferred,
    query: reportQuery,
  });
}

async function compileEvidence(
  database: DatabaseSync,
  query: PagesTestQuery,
): Promise<EventSummaryQualificationCompilationEvidence> {
  const compilation = await compilePagesProgram(database, query);
  if (compilation.kind !== "compiled")
    throw new Error("wave96b_pages_compile_unavailable");
  return compilation.evidence;
}

async function assertCursorChain(
  database: DatabaseSync,
  scope: "session" | "visitor",
  includeDetails: boolean,
  limit: number,
): Promise<{ readonly pageCount: number; readonly returned: number }> {
  let cursor: string | null = null;
  let pageCount = 0;
  let returned = 0;
  const keys = new Set<string>();
  for (;;) {
    if (pageCount > 64) throw new Error("wave96b_page_cursor_chain_unbounded");
    const query = queryFor(scope, {
      limit,
      cursor,
      includeDetails,
    });
    const trace = traceFor();
    const actual = await providerPage(database, query, trace);
    const expected = await independentLegacyOracle(database, query);
    expect(actual.page).toEqual(expected);
    expect(actual.source).toBe("raw");
    expect(actual.page.pagination.limit).toBe(limit);
    expect(actual.trace.preparedSql).toHaveLength(2);
    for (const item of actual.page.items) {
      const key = JSON.stringify([
        item.pathname,
        includeDetails ? item.query : "",
        includeDetails ? item.hash : "",
      ]);
      expect(keys.has(key)).toBe(false);
      keys.add(key);
      returned += 1;
    }
    pageCount += 1;
    const page = actual.page.pagination;
    if (!page.hasMore) {
      expect(page.nextCursor).toBeNull();
      break;
    }
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(page.nextCursor).not.toBe(cursor);
    cursor = page.nextCursor;
  }
  expect(pageCount).toBeGreaterThan(1);
  expect(returned).toBe(keys.size);
  return { pageCount, returned };
}

type SqlBehavior =
  | "missing-control"
  | "duplicate-control"
  | "wrong-control-scope"
  | "malformed-report"
  | "database-error"
  | "post-abort";

function testEnvWithBehavior(
  database: DatabaseSync,
  trace: SqliteD1Trace,
  behavior: SqlBehavior,
  controller?: AbortController,
): Env {
  const baseDatabase = createSqliteD1Database(database, trace);
  let prepareCount = 0;
  const DB = {
    prepare(sql: string) {
      prepareCount += 1;
      const statement = baseDatabase.prepare(sql);
      if (prepareCount !== 2) return statement;
      const replacement = Object.create(statement) as D1PreparedStatement;
      Object.defineProperty(replacement, "bind", {
        value: (...values: SQLInputValue[]) => {
          statement.bind(...values);
          return replacement;
        },
      });
      const originalAll = statement.all.bind(statement);
      Object.defineProperty(replacement, "all", {
        value: async () => {
          if (behavior === "database-error")
            throw new Error("wave96b injected D1 read failure");
          const result = await originalAll<Record<string, unknown>>();
          if (behavior === "post-abort") {
            controller?.abort();
            return result;
          }
          const control = result.results.find(
            (row) => row.rowKind === "control",
          );
          if (behavior === "missing-control")
            return {
              ...result,
              results: result.results.filter(
                (row) => row.rowKind !== "control",
              ),
            };
          if (behavior === "duplicate-control" && control)
            return { ...result, results: [...result.results, control] };
          if (behavior === "wrong-control-scope")
            return {
              ...result,
              results: result.results.map((row) =>
                row.rowKind === "control"
                  ? { ...row, entityKind: "visitor" }
                  : row,
              ),
            };
          if (behavior === "malformed-report")
            return {
              ...result,
              results: result.results.map((row) =>
                row.rowKind === "report" ? { ...row, pathname: 123 } : row,
              ),
            };
          return result;
        },
      });
      return replacement;
    },
  } as unknown as D1Database;
  return { DB, MAIN_SECRET: CURSOR_SECRET } as unknown as Env;
}

async function bulkInsertQualifiers(
  database: DatabaseSync,
  site: TestSite,
  visitId: string,
  count: number,
): Promise<void> {
  const insert = database.prepare(
    `INSERT INTO custom_events (
      event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
      received_at, sequence, node_count, value_count
    ) VALUES (?, ?, ?, ?, 1, 150, 150, ?, 0, 0)`,
  );
  database.exec("BEGIN");
  try {
    for (let index = 0; index < count; index += 1)
      insert.run(`bulk-qualifier-${index}`, site.id, site.pk, visitId, index);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

afterAll(() => {
  for (const database of databases) database.close();
});

describe("Pages whole Boolean qualification", () => {
  it.each(["session", "visitor"] as const)(
    "expands the independent OR owner set and preserves %s scope pagination",
    async (scope) => {
      const database = createWholeBooleanFixture();
      const filterDsl =
        'page.path eq "/native" or count(event { event.name eq "qualifier" }) eq 1';
      const expectedPathnames =
        scope === "session"
          ? ["/count-event", "/count-report", "/native", "/native-expanded"]
          : [
              "/count-event",
              "/count-report",
              "/native",
              "/native-expanded",
              "/visitor-expansion",
            ];
      const expectedItems = expectedPathnames.map((pathname) => ({
        pathname,
        query: "",
        hash: "",
        views: 1,
        sessions: 1,
      }));
      const actualItems: PageItem[] = [];
      let cursor: string | null = null;
      const pages: Array<Record<string, unknown>> = [];
      try {
        for (let pageIndex = 0; pageIndex < 4; pageIndex += 1) {
          const query = queryFor(scope, {
            filterDsl,
            limit: 2,
            cursor,
          });
          const trace = traceFor();
          const actual = await providerPage(database, query, trace);
          const legacy = await independentLegacyOracleWithTrace(
            database,
            query,
          );
          expect(actual.source).toBe("raw");
          expect(trace.preparedSql).toHaveLength(2);
          const reportSql = trace.preparedSql[1]!;
          const reportBindings = trace.bindings[1]!;
          expect(
            new TextEncoder().encode(reportSql).length,
          ).toBeLessThanOrEqual(100_000);
          expect(reportBindings.length).toBeLessThanOrEqual(100);
          expect(actual.page).toEqual(legacy.page);
          actualItems.push(...actual.page.items);
          pages.push({
            pageIndex,
            cursor,
            dto: actual.page,
            sql: trace.preparedSql,
            bindings: trace.bindings,
            legacyDto: legacy.page,
            legacySql: legacy.trace.preparedSql,
            legacyBindings: legacy.trace.bindings,
          });
          if (!actual.page.pagination.hasMore) {
            expect(actual.page.pagination.nextCursor).toBeNull();
            break;
          }
          expect(actual.page.pagination.nextCursor).toEqual(expect.any(String));
          expect(actual.page.pagination.nextCursor).not.toBe(cursor);
          cursor = actual.page.pagination.nextCursor;
        }

        expect(actualItems).toEqual(expectedItems);
        expect(pages.length).toBeGreaterThan(1);
        expect(pages.length).toBe(Math.ceil(expectedItems.length / 2));
        sqlEvidence.push({
          scenario: "whole-boolean-or-owner-expansion",
          scope,
          expectedItems,
          actualPages: pages,
          qualifiedEnvelopeCountPerPage: 1,
          metadataStatementCountPerPage: 1,
        });
      } finally {
        database.close();
        databases.delete(database);
      }
    },
  );
});

describe("Wave96B qualified ordinary Pages aggregate pagination", () => {
  it.each([
    ["session", false],
    ["session", true],
    ["visitor", false],
    ["visitor", true],
  ] as const)(
    "matches the independent old reader across full %s / details=%s cursor chains",
    async (scope, includeDetails) => {
      const database = createFixture();
      const firstQuery = queryFor(scope, { limit: 2, includeDetails });
      const evidence = await compileEvidence(database, firstQuery);
      const legacy = await independentLegacyOracleWithTrace(
        database,
        firstQuery,
      );
      expect(evidence.statementTag).toBe(
        "analytics.pages_aggregate_qualification",
      );
      expect(evidence.groupWidth).toBeGreaterThan(0);
      expect(evidence.sharedRelationCount).toBeGreaterThan(0);
      const firstTrace = traceFor();
      const firstPage = await providerPage(database, firstQuery, firstTrace);
      expect(firstTrace.preparedSql).toHaveLength(2);
      expect(firstTrace.preparedSql[1]).toBe(evidence.sql);
      expect(firstTrace.bindings[1]).toEqual(evidence.bindings);
      expect(firstPage.page).toEqual(legacy.page);
      expect(firstPage.page.pagination.hasMore).toBe(true);
      const chains = [
        await assertCursorChain(database, scope, includeDetails, 2),
        await assertCursorChain(database, scope, includeDetails, 3),
      ];
      expect(chains.every((chain) => chain.pageCount > 1)).toBe(true);
      sqlEvidence.push({
        scope,
        includeDetails,
        evidence,
        firstPageSql: firstTrace.preparedSql,
        firstPageBindings: firstTrace.bindings,
        qualifiedStatementCount: firstTrace.preparedSql.length,
        legacyOracleSql: legacy.trace.preparedSql,
        legacyOracleBindings: legacy.trace.bindings,
        legacyOracleStatementCount: legacy.trace.preparedSql.length,
        completeCursorChains: chains.map((chain, index) => ({
          limit: index === 0 ? 2 : 3,
          pageCount: chain.pageCount,
          returnedRows: chain.returned,
        })),
      });
    },
  );

  it.each(["session", "event"] as const)(
    "runs the complete legacy operation after numeric-domain fallback for %s scope",
    async (scope) => {
      const database = createFixture();
      database
        .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
        .run("invalid-duration", "visitor-0-qualifier-source");
      const query = queryFor(scope, {
        filterDsl: "count(page { page.durationMs gt 5 }) eq 2",
        limit: 4,
      });
      const expected = await independentLegacyOracle(database, query);
      const compilation = await compilePagesProgram(database, query);
      expect(compilation.kind).toBe("compiled");
      if (compilation.kind !== "compiled")
        throw new Error("wave96b_pages_numeric_compatibility_unavailable");
      const trace = traceFor();
      const diagnostics = createD1ReadDiagnostics();
      const provider = createD1SiteProviderRegistry({
        env: testEnv(database, trace),
        siteId: SITE,
        diagnostics,
      }).resolve("pages");
      if (!provider) throw new Error("wave96b_pages_provider_missing");
      const actual = await provider.execute(query);
      expect(actual.value).toEqual(expected);
      expect(diagnostics.advancedCountSqlFallbackReason).toEqual({
        kind: "numeric-data-domain",
        fieldIds: ["page.durationMs"],
      });
      expect(trace.preparedSql).toContain(compilation.evidence.sql);
      const guardRows = database
        .prepare(compilation.evidence.sql)
        .all(...(compilation.evidence.bindings as SQLInputValue[])) as Record<
        string,
        unknown
      >[];
      expect(guardRows.filter((row) => row.rowKind === "control")).toHaveLength(
        1,
      );
      expect(guardRows.filter((row) => row.rowKind === "report")).toHaveLength(
        0,
      );
      const compatibilitySql = trace.preparedSql.at(-1);
      expect(compatibilitySql).toContain("visit_id");
      expect(compatibilitySql).not.toContain("entity_id");
      expect(compatibilitySql).not.toBe(compilation.evidence.sql);
      sqlEvidence.push({
        scenario: "numeric-data-domain-fallback",
        scope,
        statementCount: trace.preparedSql.length,
        sql: trace.preparedSql,
        bindings: trace.bindings,
        nativeGuardRows: guardRows,
        finalCompatibilitySql: compatibilitySql,
        fallbackReason: diagnostics.advancedCountSqlFallbackReason,
      });
    },
  );

  it("falls back before fused D1 when the complete 24-Count summary exceeds the shared width bound", async () => {
    const conditions = Array.from(
      { length: 24 },
      (_, index) => `count(page { page.path eq "/budget-${index}" }) eq 0`,
    ).join(" and ");
    const database = createFixture();
    const query = queryFor("session", {
      filterDsl: `${BASE_FILTER} and ${conditions}`,
      limit: 4,
    });
    const expected = await independentLegacyOracle(database, query);
    const compilation = await compilePagesProgram(database, query);
    expect(compilation.kind).toBe("unavailable");
    if (compilation.kind !== "unavailable")
      throw new Error("wave96b_expected_pages_summary_width_fallback");
    expect(compilation.fallbackReason).toMatchObject({
      kind: "grouped-summary-unavailable",
      groupWidth: expect.any(Number),
    });
    const reason = compilation.fallbackReason;
    if (reason.kind !== "grouped-summary-unavailable")
      throw new Error("wave96b_expected_pages_summary_width_fallback");
    const trace = traceFor();
    const provider = createD1SiteProviderRegistry({
      env: testEnv(database, trace),
      siteId: SITE,
    }).resolve("pages");
    if (!provider) throw new Error("wave96b_pages_provider_missing");
    const actual = await provider.execute(query);
    expect(actual.value).toEqual(expected);
    expect(
      trace.preparedSql.some((sql) =>
        sql.includes("analytics.pages_aggregate_qualification"),
      ),
    ).toBe(false);
    sqlEvidence.push({
      scenario: "24-count-grouped-summary-width-fallback",
      countConditions: 24,
      fallbackReason: reason,
      fusedD1ExecutionBeforeFallback: false,
      matchesIndependentLegacyOracle: true,
    });
  }, 60_000);

  it("retains the independent control row when the Pages report is empty", async () => {
    const database = createFixture();
    const query = queryFor("session", {
      filterDsl: "count(page { page.durationMs gt 5 }) eq 99",
    });
    const expected = await independentLegacyOracle(database, query);
    const trace = traceFor();
    const diagnostics = createD1ReadDiagnostics();
    const provider = createD1SiteProviderRegistry({
      env: testEnv(database, trace),
      siteId: SITE,
      diagnostics,
    }).resolve("pages");
    if (!provider) throw new Error("wave96b_pages_provider_missing");
    const actual = await provider.execute(query);
    expect(actual.value).toEqual(expected);
    expect((actual.value as PagesPage).items).toEqual([]);
    expect((actual.value as PagesPage).pagination).toMatchObject({
      returned: 0,
      hasMore: false,
      nextCursor: null,
    });
    expect(trace.preparedSql).toHaveLength(2);
    expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
  });

  it.each([
    ["missing-control", "control_row_invalid"],
    ["duplicate-control", "control_row_invalid"],
    ["wrong-control-scope", "control_kind_mismatch"],
    ["malformed-report", "report_row_invalid"],
    ["database-error", "injected D1 read failure"],
  ] as const)("fails closed for %s", async (behavior, message) => {
    const database = createFixture();
    const trace = traceFor();
    const env = testEnvWithBehavior(database, trace, behavior);
    const diagnostics = createD1ReadDiagnostics();
    const provider = createD1SiteProviderRegistry({
      env,
      siteId: SITE,
      diagnostics,
    }).resolve("pages");
    if (!provider) throw new Error("wave96b_pages_provider_missing");
    await expect(provider.execute(queryFor("session"))).rejects.toThrow(
      message,
    );
    expect(trace.preparedSql.length).toBe(2);
    expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
  });

  it("keeps the 20001 activity cap ahead of a malformed cursor", async () => {
    const database = createMigratedDatabase();
    databases.add(database);
    database.exec("PRAGMA foreign_keys = OFF");
    const site = addSite(database);
    addVisit(database, site, {
      id: "bulk-owner",
      visitorId: "bulk-visitor",
      sessionId: "bulk-session",
      page: { pathname: "/bulk", query: "", hash: "" },
      at: 150,
    });
    addQualifier(database, site, "bulk-owner");
    await bulkInsertQualifiers(database, site, "bulk-owner", 20000);
    const query = queryFor("session", {
      cursor: "malformed.cursor.token",
      limit: 5,
    });
    const provider = createD1SiteProviderRegistry({
      env: testEnv(database, traceFor()),
      siteId: SITE,
    }).resolve("pages");
    if (!provider) throw new Error("wave96b_pages_provider_missing");
    await expect(provider.execute(query)).rejects.toMatchObject({
      domainError: {
        kind: "invalid-input",
        issues: [{ path: "filters", code: "filter_activity_limit_exceeded" }],
      },
    });
  }, 30000);

  it("does not defer public, tabs, includeTabs, unsupported-limit, or other-operation requests", async () => {
    const database = createFixture();
    const trace = traceFor();
    const env = testEnv(database, trace);
    const middleware = d1AdvancedFilterMiddleware(env, undefined, SITE);
    const base = queryFor("session");
    const variants = [
      queryFor("session", { audience: "public-share" }),
      queryFor("session", { variant: "tabs" }),
      queryFor("session", { includeTabs: true }),
      queryFor("session", { limit: 1.5 }),
    ];
    for (const query of variants) {
      const forwarded = await middleware(
        "pages",
        query,
        async (value) => value,
      );
      expect(
        deferredPagesAggregatePageQualificationFromQuery(forwarded),
      ).toBeUndefined();
    }
    const otherOperation = await middleware(
      "performance",
      base,
      async (value) => value,
    );
    expect(
      deferredPagesAggregatePageQualificationFromQuery(otherOperation),
    ).toBeUndefined();
    const inconsistentTime = {
      ...base,
      time: createQueryTime(101, 200, "UTC", 300),
    } as PagesTestQuery;
    const inconsistentTimeForwarded = await middleware(
      "pages",
      inconsistentTime,
      async (value) => value,
    );
    expect(
      deferredPagesAggregatePageQualificationFromQuery(
        inconsistentTimeForwarded,
      ),
    ).toBeUndefined();
    await expect(
      d1AdvancedFilterMiddleware(env, undefined, "another-site")(
        "pages",
        base,
        async (value) => value,
      ),
    ).rejects.toMatchObject({
      domainError: {
        issues: [
          {
            path: "siteId",
            code: "pages_aggregate_page_request_context_mismatch",
          },
        ],
      },
    });
  });

  it("protects the private request brand and propagates aborts without fallback", async () => {
    const database = createFixture();
    const preAbortTrace = traceFor();
    const preAbortDiagnostics = createD1ReadDiagnostics();
    const preAbortProvider = createD1SiteProviderRegistry({
      env: testEnv(database, preAbortTrace),
      siteId: SITE,
      diagnostics: preAbortDiagnostics,
    }).resolve("pages");
    if (!preAbortProvider) throw new Error("wave96b_pages_provider_missing");
    const preAbort = new AbortController();
    preAbort.abort();
    await expect(
      preAbortProvider.execute(queryFor("session"), {
        signal: preAbort.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(preAbortTrace.preparedSql).toHaveLength(0);
    expect(preAbortDiagnostics.advancedCountSqlFallbackReason).toBeUndefined();

    const forwarded = await d1AdvancedFilterMiddleware(
      testEnv(database, traceFor()),
      undefined,
      SITE,
    )("pages", queryFor("session"), async (value) => value);
    expect(
      deferredPagesAggregatePageQualificationFromQuery(forwarded),
    ).toBeDefined();
    const forwardedRecord = forwarded as Record<string, unknown>;
    const originalPage = forwardedRecord.page as { limit: number };
    const mutablePage = originalPage as { limit: number };
    mutablePage.limit += 1;
    expect(() =>
      deferredPagesAggregatePageQualificationFromQuery(forwarded),
    ).toThrow("deferred_pages_aggregate_page_request_changed");

    const postAbortTrace = traceFor();
    const postAbortDiagnostics = createD1ReadDiagnostics();
    const postAbort = new AbortController();
    const postAbortProvider = createD1SiteProviderRegistry({
      env: testEnvWithBehavior(
        database,
        postAbortTrace,
        "post-abort",
        postAbort,
      ),
      siteId: SITE,
      diagnostics: postAbortDiagnostics,
    }).resolve("pages");
    if (!postAbortProvider) throw new Error("wave96b_pages_provider_missing");
    await expect(
      postAbortProvider.execute(queryFor("session"), {
        signal: postAbort.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(postAbortTrace.preparedSql).toHaveLength(2);
    expect(postAbortDiagnostics.advancedCountSqlFallbackReason).toBeUndefined();
  });

  it("surfaces malformed cursors after controls and does not fabricate a valid cursor", async () => {
    const database = createFixture();
    const provider = createD1SiteProviderRegistry({
      env: testEnv(database, traceFor()),
      siteId: SITE,
    }).resolve("pages");
    if (!provider) throw new Error("wave96b_pages_provider_missing");
    await expect(
      provider.execute(queryFor("session", { cursor: "bad.cursor" })),
    ).rejects.toBeInstanceOf(InvalidCursorError);
  });
});

afterAll(() => {
  if (sqlEvidence.length > 0)
    console.log(`WAVE96B_PAGES_SQL_EVIDENCE=${JSON.stringify(sqlEvidence)}`);
});
