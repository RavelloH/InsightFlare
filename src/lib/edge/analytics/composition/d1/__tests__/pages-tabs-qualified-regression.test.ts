import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
import { buildPagesTabsQualificationPlan } from "@/lib/edge/analytics/engine/page-dimension-qualification-plan";
import {
  d1AdvancedFilterMiddleware,
  deferredPagesAggregatePageQualificationFromQuery,
  deferredPagesTabsQualificationFromQuery,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import {
  compilePagesTabsQualificationProgram,
  type EventSummaryQualificationCompilationEvidence,
  type PagesTabsQualificationReportQuery,
} from "@/lib/edge/analytics/providers/d1/internal/analytics-qualification-program";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import {
  decodePagesCursor,
  queryPagesWithTabsFromD1,
  queryPageTabsAggregate,
} from "@/lib/edge/analytics/providers/d1/internal/pages";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import type { FilterDocument } from "@/lib/filter-contract/filters";
import { InvalidCursorError } from "@/lib/pagination";

const SITE = "wave96c-pages-tabs";
const TIME = createQueryTime(100, 200, "UTC", 300);
const WINDOW = {
  startMs: 100,
  endExclusiveMs: 200,
  nowMs: 300,
  timeZone: "UTC",
} as const;
const CURSOR_SECRET = "wave96c-pages-tabs-test-secret";
const BASE_FILTER =
  'page.path neq "/qualifier-source" and count(event { event.name eq "qualifier" }) eq 1';
const EMPTY_FILTERS: FilterDocument = { version: 1, root: null };
const databases = new Set<DatabaseSync>();
const evidence: Array<Record<string, unknown>> = [];

interface TestSite {
  readonly id: string;
  readonly pk: number;
}

type PagesTabsQuery = QueryInput & {
  readonly time: QueryTime;
  readonly limit: number;
  readonly includeDetails: boolean;
  readonly includeTabs: boolean;
  readonly variant?: "tabs";
  readonly page: { readonly limit: number; readonly cursor?: string };
};

interface PageKey {
  readonly pathname: string;
  readonly query: string;
  readonly hash: string;
}

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
       VALUES (?, 'wave96c-team', 'Page tabs', 'pages-tabs.test', 0)`,
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
    readonly duration?: string | number;
  },
): void {
  database
    .prepare(
      `INSERT INTO visits (
        visit_id, site_id, site_pk, visitor_id, session_id, status,
        started_at, last_activity_at, pathname, query_string, hash_fragment,
        hostname, duration_ms
      ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, ?, ?, 'pages-tabs.test', ?)`,
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
      input.duration ?? 10,
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
  const visit = (
    id: string,
    visitorId: string,
    sessionId: string,
    pathname: string,
    at: number,
    query = "",
    hash = "",
    qualifier = false,
  ) => {
    addVisit(database, site, {
      id,
      visitorId,
      sessionId,
      page: { pathname, query, hash },
      at,
    });
    if (qualifier) addQualifier(database, site, id);
  };

  visit(
    "a-source",
    "visitor-a",
    "session-a",
    "/qualifier-source",
    100,
    "",
    "",
    true,
  );
  visit("a-entry", "visitor-a", "session-a", "/entry-a", 110);
  visit("a-same-one", "visitor-a", "session-a", "/same", 120, "sort=1", "#one");
  visit("a-exit", "visitor-z", "session-a", "/shared-exit", 130);
  visit(
    "b-source",
    "visitor-b",
    "session-b",
    "/qualifier-source",
    100,
    "",
    "",
    true,
  );
  visit("b-entry", "visitor-b", "session-b", "/entry-b", 110);
  visit("b-same-two", "visitor-b", "session-b", "/same", 120, "sort=1", "#two");
  visit("b-exit", "visitor-z", "session-b", "/shared-exit", 135);
  visit(
    "z-source",
    "visitor-z",
    "session-z-source",
    "/qualifier-source",
    100,
    "",
    "",
    true,
  );
  visit(
    "a-expansion",
    "visitor-a",
    "session-a-extra",
    "/visitor-expansion",
    140,
  );
  for (const [visitor, session, pathname, at] of [
    ["visitor-c", "session-c", "/single-c", 140],
    ["visitor-d", "session-d", "/single-d", 141],
    ["visitor-e", "session-e", "/single-e", 142],
    ["visitor-f", "session-f", "/single-f", 143],
  ] as const) {
    visit(
      `${visitor}-source`,
      visitor,
      session,
      "/qualifier-source",
      100,
      "",
      "",
      true,
    );
    visit(`${visitor}-page`, visitor, session, pathname, at);
  }
  visit("empty-values", "", "", "", 180);
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
    database
      .prepare("UPDATE visits SET title = ? WHERE visit_id = ?")
      .run(pathname, id);
    if (qualifier) addQualifier(database, site, id);
  };

  visit("whole-a-native", "visitor-a", "session-a", "/native", 110, true);
  visit("whole-a-entry", "visitor-a", "session-a", "/a-entry", 120);
  visit("whole-a-exit", "visitor-a", "session-a", "/a-exit", 130);
  visit(
    "whole-a-other-session",
    "visitor-a",
    "session-a-extra",
    "/visitor-expansion",
    140,
  );
  visit("whole-b-event", "visitor-b", "session-b", "/count-event", 110, true);
  visit("whole-b-report", "visitor-b", "session-b", "/count-report", 120);
  visit("whole-c-neither", "visitor-c", "session-c", "/neither", 110);
  return database;
}

function testEnv(database: DatabaseSync, trace: SqliteD1Trace): Env {
  return {
    DB: createSqliteD1Database(database, trace),
    MAIN_SECRET: CURSOR_SECRET,
  } as unknown as Env;
}

type QualificationBehavior =
  | "missing-control"
  | "duplicate-control"
  | "wrong-control-scope"
  | "unknown-card"
  | "wrong-row-type"
  | "malformed-type"
  | "extra-schema"
  | "database-error"
  | "post-abort";

function testEnvWithBehavior(
  database: DatabaseSync,
  trace: SqliteD1Trace,
  behavior: QualificationBehavior,
  controller?: AbortController,
): Env {
  const baseDatabase = createSqliteD1Database(database, trace);
  const DB = {
    prepare(sql: string) {
      const statement = baseDatabase.prepare(sql);
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
          const result = await originalAll<Record<string, unknown>>();
          const hasControls = result.results.some(
            (row) => row.rowKind === "control",
          );
          if (!hasControls) return result;
          if (behavior === "database-error")
            throw new Error("wave96c injected D1 read failure");
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
                  ? { ...row, entityKind: "site" }
                  : row,
              ),
            };
          if (behavior === "unknown-card")
            return {
              ...result,
              results: result.results.map((row) =>
                row.rowKind === "report" && row.rowType === "tab"
                  ? { ...row, cardType: "unknown-card" }
                  : row,
              ),
            };
          if (behavior === "wrong-row-type")
            return {
              ...result,
              results: result.results.map((row) =>
                row.rowKind === "report" && row.rowType === "tab"
                  ? { ...row, rowType: "page" }
                  : row,
              ),
            };
          if (behavior === "malformed-type")
            return {
              ...result,
              results: result.results.map((row) =>
                row.rowKind === "report" ? { ...row, views: "invalid" } : row,
              ),
            };
          if (behavior === "extra-schema")
            return {
              ...result,
              results: result.results.map((row) =>
                row.rowKind === "report" ? { ...row, unexpected: true } : row,
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

function queryFor(
  scope: "session" | "visitor" | "event",
  input: {
    readonly configuration?: "tabs-only" | "pages-with-tabs";
    readonly limit?: number;
    readonly cursor?: string | null;
    readonly includeDetails?: boolean;
    readonly audience?: "private-dashboard" | "public-share";
    readonly filterDsl?: string;
  } = {},
): PagesTabsQuery {
  const configuration = input.configuration ?? "pages-with-tabs";
  const limit = input.limit ?? 2;
  const prepared = prepareScopedQuery("pages", {
    context: siteQueryContext(SITE, input.audience ?? "private-dashboard"),
    time: TIME,
    filters: parseFilterDsl(
      input.filterDsl ?? BASE_FILTER,
      analyticsFilterRegistry,
    ),
    scopePreference: scope,
  } as QueryInput & { readonly time: QueryTime });
  return {
    ...prepared,
    time: TIME,
    limit,
    includeDetails: input.includeDetails ?? false,
    includeTabs: true,
    ...(configuration === "tabs-only" ? { variant: "tabs" as const } : {}),
    page: {
      limit,
      ...(input.cursor !== undefined && input.cursor !== null
        ? { cursor: input.cursor }
        : {}),
    },
  } as PagesTabsQuery;
}

async function providerValue(
  database: DatabaseSync,
  query: PagesTabsQuery,
  trace = traceFor(),
) {
  const diagnostics = createD1ReadDiagnostics();
  const provider = createD1SiteProviderRegistry({
    env: testEnv(database, trace),
    siteId: SITE,
    diagnostics,
  }).resolve("pages");
  if (!provider) throw new Error("wave96c_pages_provider_missing");
  const result = await provider.execute(query);
  return { value: result.value, source: result.source, trace, diagnostics };
}

async function legacyOracle(
  database: DatabaseSync,
  query: PagesTabsQuery,
  trace = traceFor(),
) {
  const env = testEnv(database, trace);
  const forwarded = await d1AdvancedFilterMiddleware(env, undefined, SITE)(
    "performance",
    query,
    async (prepared) => prepared,
  );
  const filters =
    (forwarded as PagesTabsQuery).filters ?? query.filters ?? EMPTY_FILTERS;
  if (!scopedFilterMetadata(filters)?.plan.advancedMatches)
    throw new Error("wave96c_legacy_path_did_not_prepare_selected_matches");
  if (
    deferredPagesTabsQualificationFromQuery(forwarded) ||
    deferredPagesAggregatePageQualificationFromQuery(forwarded)
  )
    throw new Error("wave96c_legacy_path_used_deferred_pages_qualification");
  const configuration =
    query.variant === "tabs" ? "tabs-only" : "pages-with-tabs";
  if (configuration === "tabs-only")
    return {
      value: await queryPageTabsAggregate(
        env,
        SITE,
        WINDOW,
        filters,
        query.limit,
      ),
      trace,
    };
  const cursorText = query.page.cursor ?? null;
  const cursor = await decodePagesCursor(
    env,
    SITE,
    WINDOW,
    filters,
    query.includeDetails === true,
    cursorText,
    query.context.policy.audience,
  );
  if (cursorText && !cursor) throw new InvalidCursorError("pages");
  return {
    value: await queryPagesWithTabsFromD1(
      env,
      SITE,
      WINDOW,
      filters,
      query.page.limit,
      query.includeDetails === true,
      cursor,
      query.context.policy.audience,
    ),
    trace,
  };
}

async function compileEvidence(
  database: DatabaseSync,
  query: PagesTabsQuery,
): Promise<
  EventSummaryQualificationCompilationEvidence & {
    readonly logicalPlan: unknown;
  }
> {
  const env = testEnv(database, traceFor());
  const forwarded = await d1AdvancedFilterMiddleware(env, undefined, SITE)(
    "pages",
    query,
    async (prepared) => prepared,
  );
  const deferred = deferredPagesTabsQualificationFromQuery(forwarded);
  if (!deferred) throw new Error("wave96c_pages_tabs_brand_missing");
  const filters = (forwarded as PagesTabsQuery).filters ?? EMPTY_FILTERS;
  const configuration = deferred.pagesTabsRequest.configuration;
  const reportQuery: PagesTabsQualificationReportQuery = {
    env,
    siteId: SITE,
    queryTime: scopedFilterMetadata(filters)?.time ?? TIME,
    filters,
    configuration,
    limit: deferred.pagesTabsRequest.limit,
    includeDetails: deferred.pagesTabsRequest.includeDetails,
    cursor: null,
    cursorToken: null,
    audience: query.context.policy.audience,
    variant: query.variant,
    includeTabs: query.includeTabs,
  };
  const result = compilePagesTabsQualificationProgram({
    deferred,
    query: reportQuery,
  });
  if (result.kind !== "compiled")
    throw new Error(
      `wave96c_pages_tabs_compile_unavailable:${result.fallbackReason.kind}`,
    );
  const logicalPlan = buildPagesTabsQualificationPlan({
    configuration,
    siteId: SITE,
    queryTime: scopedFilterMetadata(filters)?.time ?? TIME,
    filters,
    scopePlan: deferred.metadata.plan,
    count: deferred.countInput,
    limit: deferred.pagesTabsRequest.limit,
    includeDetails: deferred.pagesTabsRequest.includeDetails,
    cursor: null,
  }).plan;
  return { ...result.evidence, logicalPlan };
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
  let fullTabs: unknown;
  const keys = new Set<string>();
  const pathnames = new Set<string>();
  let compilationEvidence:
    EventSummaryQualificationCompilationEvidence | undefined;
  for (;;) {
    if (pageCount > 32) throw new Error("wave96c_pages_cursor_chain_unbounded");
    const query = queryFor(scope, {
      configuration: "pages-with-tabs",
      limit,
      cursor,
      includeDetails,
    });
    const actualTrace = traceFor();
    const actual = await providerValue(database, query, actualTrace);
    const legacyTrace = traceFor();
    const expected = await legacyOracle(database, query, legacyTrace);
    expect(actual.value).toEqual(expected.value);
    expect(actual.source).toBe("raw");
    const actualResult = actual.value as {
      pages: {
        items: readonly PageKey[];
        pagination: {
          limit: number;
          returned: number;
          hasMore: boolean;
          nextCursor: string | null;
        };
      };
      tabs: unknown;
    };
    expect(actualResult.pages.pagination.limit).toBe(limit);
    if (fullTabs === undefined) fullTabs = actualResult.tabs;
    expect(actualResult.tabs).toEqual(fullTabs);
    for (const item of actualResult.pages.items) {
      const key = JSON.stringify([
        item.pathname,
        includeDetails ? item.query : "",
        includeDetails ? item.hash : "",
      ]);
      expect(keys.has(key)).toBe(false);
      keys.add(key);
      pathnames.add(item.pathname);
      returned += 1;
    }
    if (pageCount === 0)
      compilationEvidence = await compileEvidence(database, query);
    evidence.push({
      configuration: "pages-with-tabs",
      scope,
      includeDetails,
      limit,
      cursor: cursor === null ? "first" : "continuation",
      actualSql: actualTrace.preparedSql,
      actualBindings: actualTrace.bindings,
      actualStatementCount: actualTrace.preparedSql.length,
      legacySql: legacyTrace.preparedSql,
      legacyBindings: legacyTrace.bindings,
      legacyStatementCount: legacyTrace.preparedSql.length,
      ...(pageCount === 0 && compilationEvidence
        ? {
            compiledEvidence: {
              statementTag: compilationEvidence.statementTag,
              sql: compilationEvidence.sql,
              bindings: compilationEvidence.bindings,
              sqlBytes: compilationEvidence.sqlBytes,
              bindingCount: compilationEvidence.bindingCount,
              sharedRelationCount: compilationEvidence.sharedRelationCount,
              rootKind: compilationEvidence.rootKind,
              physicalScanKinds: compilationEvidence.physicalScanKinds,
              physicalPlanShape: compilationEvidence.physicalPlanShape,
            },
          }
        : {}),
    });
    pageCount += 1;
    const pagination = actualResult.pages.pagination;
    if (!pagination.hasMore) {
      expect(pagination.nextCursor).toBeNull();
      break;
    }
    expect(pagination.nextCursor).toEqual(expect.any(String));
    expect(pagination.nextCursor).not.toBe(cursor);
    cursor = pagination.nextCursor;
  }
  expect(pageCount).toBeGreaterThan(1);
  expect(returned).toBe(keys.size);
  expect(pathnames.has("/visitor-expansion")).toBe(scope === "visitor");
  const samePathKeys = [...keys].filter(
    (key) => (JSON.parse(key) as string[])[0] === "/same",
  );
  expect(samePathKeys).toHaveLength(includeDetails ? 2 : 1);
  return { pageCount, returned };
}

afterAll(() => {
  for (const database of databases) database.close();
  if (process.env.WAVE96C_CAPTURE_SQL === "1" && evidence.length > 0) {
    const output = resolve(
      process.env.WAVE96C_CAPTURE_SQL_PATH ??
        "plan/execution-wave96c-pages-tabs-qualification/run-1/evidence/test-evidence.json",
    );
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify(evidence, null, 2), "utf8");
  }
});

describe("Pages whole Boolean qualification", () => {
  it("qualifies all five tabs from the mixed OR visitor cohort", async () => {
    const database = createWholeBooleanFixture();
    const filterDsl =
      'page.path eq "/native" or count(event { event.name eq "qualifier" }) eq 1';
    const query = queryFor("visitor", {
      configuration: "tabs-only",
      filterDsl,
      limit: 20,
    });
    const trace = traceFor();
    try {
      const actual = await providerValue(database, query, trace);
      const legacy = await legacyOracle(database, query);
      expect(actual.diagnostics.advancedCountSqlFallbackReason ?? null).toBe(
        null,
      );
      expect(trace.preparedSql).toHaveLength(2);
      const reportSql = trace.preparedSql[1]!;
      const reportBindings = trace.bindings[1]!;
      expect(new TextEncoder().encode(reportSql).length).toBeLessThanOrEqual(
        100_000,
      );
      expect(reportBindings.length).toBeLessThanOrEqual(100);
      expect(actual.value).toEqual(legacy.value);
      const expected = legacy.value as Record<
        "path" | "title" | "hostname" | "entry" | "exit",
        readonly unknown[]
      >;
      const actualTabs = actual.value as unknown as Record<
        "path" | "title" | "hostname" | "entry" | "exit",
        readonly unknown[]
      >;
      for (const tab of ["path", "title", "hostname", "entry", "exit"] as const)
        expect(actualTabs[tab].length).toBeGreaterThan(0);
      evidence.push({
        scenario: "whole-boolean-or-tabs-only",
        scope: "visitor",
        dto: actual.value,
        expected: { qualifiedOwners: ["visitor-a", "visitor-b"], ...expected },
        sql: trace.preparedSql,
        bindings: trace.bindings,
        expectedSql: legacy.trace.preparedSql,
        expectedBindings: legacy.trace.bindings,
        qualifiedEnvelopeCount: 1,
      });
    } finally {
      database.close();
      databases.delete(database);
    }
  });

  it("keeps a mixed NOT session cohort through Pages-with-tabs cursor pages", async () => {
    const database = createWholeBooleanFixture();
    const filterDsl =
      'not (page.path eq "/native" and count(event { event.name eq "qualifier" }) eq 1)';
    const actualItems: Array<Record<string, unknown>> = [];
    const actualPages: Array<Record<string, unknown>> = [];
    const legacyPages: Array<Record<string, unknown>> = [];
    let cursor: string | null = null;
    try {
      for (let pageIndex = 0; pageIndex < 8; pageIndex += 1) {
        const query = queryFor("session", {
          configuration: "pages-with-tabs",
          filterDsl,
          limit: 2,
          cursor,
        });
        const trace = traceFor();
        const actual = await providerValue(database, query, trace);
        const legacy = await legacyOracle(database, query);
        expect(actual.diagnostics.advancedCountSqlFallbackReason ?? null).toBe(
          null,
        );
        expect(trace.preparedSql).toHaveLength(2);
        const reportSql = trace.preparedSql[1]!;
        const reportBindings = trace.bindings[1]!;
        expect(new TextEncoder().encode(reportSql).length).toBeLessThanOrEqual(
          100_000,
        );
        expect(reportBindings.length).toBeLessThanOrEqual(100);
        expect(actual.value).toEqual(legacy.value);
        const value = actual.value as unknown as {
          pages: {
            items: Array<Record<string, unknown>>;
            pagination: { hasMore: boolean; nextCursor: string | null };
          };
          tabs: Record<string, readonly unknown[]>;
        };
        actualItems.push(...value.pages.items);
        actualPages.push({
          pageIndex,
          cursor,
          dto: actual.value,
          sql: trace.preparedSql,
          bindings: trace.bindings,
          legacyDto: legacy.value,
          legacySql: legacy.trace.preparedSql,
          legacyBindings: legacy.trace.bindings,
        });
        legacyPages.push(legacy.value as unknown as Record<string, unknown>);
        if (!value.pages.pagination.hasMore) {
          expect(value.pages.pagination.nextCursor).toBeNull();
          break;
        }
        expect(value.pages.pagination.nextCursor).toEqual(expect.any(String));
        expect(value.pages.pagination.nextCursor).not.toBe(cursor);
        cursor = value.pages.pagination.nextCursor;
      }

      const expectedPathnames = [
        "/count-event",
        "/count-report",
        "/neither",
        "/visitor-expansion",
      ];
      expect(actualItems.map(({ pathname }) => pathname).sort()).toEqual(
        expectedPathnames.sort(),
      );
      const lastActual = actualPages.at(-1)?.dto as {
        tabs: Record<string, readonly unknown[]>;
      };
      const lastLegacy = legacyPages.at(-1) as {
        tabs: Record<string, readonly unknown[]>;
      };
      expect(lastActual.tabs).toEqual(lastLegacy.tabs);
      for (const tab of ["path", "title", "hostname", "entry", "exit"] as const)
        expect(lastLegacy.tabs[tab].length).toBeGreaterThan(0);
      expect(actualPages.length).toBeGreaterThan(1);
      evidence.push({
        scenario: "whole-boolean-not-pages-with-tabs",
        scope: "session",
        expectedQualifiedOwners: ["session-a-extra", "session-b", "session-c"],
        actualPages,
        expectedOldReaderPages: legacyPages,
        qualifiedEnvelopeCountPerPage: 1,
        metadataStatementCountPerPage: 1,
      });
    } finally {
      database.close();
      databases.delete(database);
    }
  });
});

describe("Wave96C qualified Page tabs and Pages-with-tabs", () => {
  it("keeps all five tabs complete and matches the independent native oracle across eight cursor chains", async () => {
    const database = createFixture();
    const chains: Array<{
      scope: "session" | "visitor";
      includeDetails: boolean;
      limit: number;
      pageCount: number;
      returned: number;
    }> = [];
    for (const scope of ["session", "visitor"] as const)
      for (const includeDetails of [false, true])
        for (const limit of [2, 3]) {
          const result = await assertCursorChain(
            database,
            scope,
            includeDetails,
            limit,
          );
          chains.push({ scope, includeDetails, limit, ...result });
        }
    expect(chains).toHaveLength(8);
    evidence.push({ completeCursorChains: chains });
  }, 30000);

  it("qualifies tabs-only for both scopes and preserves entry-visitor exit aggregation", async () => {
    const database = createFixture();
    for (const scope of ["session", "visitor"] as const)
      for (const limit of [20, 3]) {
        const query = queryFor(scope, { configuration: "tabs-only", limit });
        const actualTrace = traceFor();
        const actual = await providerValue(database, query, actualTrace);
        const legacyTrace = traceFor();
        const expected = await legacyOracle(database, query, legacyTrace);
        expect(actual.value).toEqual(expected.value);
        const tabs = actual.value as {
          exit: readonly {
            value: string;
            sessions: number;
            visitors: number;
          }[];
        };
        expect(tabs.exit).toContainEqual({
          value: "/shared-exit",
          views: 2,
          sessions: 2,
          visitors: 2,
        });
        const compiledEvidence = await compileEvidence(database, query);
        evidence.push({
          configuration: "tabs-only",
          scope,
          limit,
          actualSql: actualTrace.preparedSql,
          actualBindings: actualTrace.bindings,
          actualStatementCount: actualTrace.preparedSql.length,
          legacySql: legacyTrace.preparedSql,
          legacyBindings: legacyTrace.bindings,
          legacyStatementCount: legacyTrace.preparedSql.length,
          compiledEvidence: {
            statementTag: compiledEvidence.statementTag,
            sql: compiledEvidence.sql,
            bindings: compiledEvidence.bindings,
            sqlBytes: compiledEvidence.sqlBytes,
            bindingCount: compiledEvidence.bindingCount,
            sharedRelationCount: compiledEvidence.sharedRelationCount,
            rootKind: compiledEvidence.rootKind,
            physicalScanKinds: compiledEvidence.physicalScanKinds,
            physicalPlanShape: compiledEvidence.physicalPlanShape,
            logicalPlan: compiledEvidence.logicalPlan,
          },
        });
      }
  });

  it("keeps the qualification control when the report outputs are empty", async () => {
    const database = createFixture();
    const query = queryFor("session", {
      configuration: "pages-with-tabs",
      filterDsl:
        'page.path eq "/no-such-page" and count(event { event.name eq "qualifier" }) eq 1',
    });
    const trace = traceFor();
    const actual = await providerValue(database, query, trace);
    const legacyTrace = traceFor();
    const expected = await legacyOracle(database, query, legacyTrace);
    expect(actual.value).toEqual(expected.value);
    expect(
      (actual.value as unknown as { pages: { items: unknown[] } }).pages.items,
    ).toEqual([]);
    expect(
      Object.values(
        (actual.value as unknown as { tabs: Record<string, unknown> }).tabs,
      ),
    ).toEqual([[], [], [], [], []]);
    evidence.push({
      scenario: "empty-report-control-retained",
      statementCount: trace.preparedSql.length,
      sql: trace.preparedSql,
      bindings: trace.bindings,
    });
  });

  it.each([
    "missing-control",
    "duplicate-control",
    "wrong-control-scope",
    "unknown-card",
    "wrong-row-type",
    "malformed-type",
    "extra-schema",
    "database-error",
  ] as const)(
    "rejects %s without falling back to native report reads",
    async (behavior) => {
      const database = createFixture();
      const query = queryFor("session", { configuration: "pages-with-tabs" });
      const baseline = await providerValue(database, query);
      const trace = traceFor();
      const diagnostics = createD1ReadDiagnostics();
      const provider = createD1SiteProviderRegistry({
        env: testEnvWithBehavior(database, trace, behavior),
        siteId: SITE,
        diagnostics,
      }).resolve("pages");
      if (!provider) throw new Error("wave96c_pages_provider_missing");
      await expect(provider.execute(query)).rejects.toThrow();
      expect(trace.preparedSql).toHaveLength(baseline.trace.preparedSql.length);
      expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
      evidence.push({
        scenario: behavior,
        statementCount: trace.preparedSql.length,
        sql: trace.preparedSql,
        bindings: trace.bindings,
        fallbackReason: diagnostics.advancedCountSqlFallbackReason,
      });
    },
  );

  it.each(["session", "event"] as const)(
    "uses Page compatibility for numeric Page data on a signed %s-scope continuation",
    async (scope) => {
      const database = createFixture();
      database
        .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
        .run("invalid-duration", "a-source");
      const firstQuery = queryFor(scope, {
        configuration: "pages-with-tabs",
        filterDsl: "count(page { page.durationMs gt 5 }) eq 2",
        limit: 2,
      });
      const firstExpected = await legacyOracle(database, firstQuery);
      const firstActual = await providerValue(database, firstQuery);
      expect(firstActual.value).toEqual(firstExpected.value);
      const firstPages = firstActual.value as {
        readonly pages: {
          readonly pagination: { readonly nextCursor: string | null };
        };
      };
      const signedCursor = firstPages.pages.pagination.nextCursor;
      expect(signedCursor).toEqual(expect.any(String));
      expect(signedCursor).not.toBe("");

      const continuationQuery = queryFor(scope, {
        configuration: "pages-with-tabs",
        filterDsl: "count(page { page.durationMs gt 5 }) eq 2",
        limit: 2,
        cursor: signedCursor,
      });
      const legacyTrace = traceFor();
      const expected = await legacyOracle(
        database,
        continuationQuery,
        legacyTrace,
      );
      const actual = await providerValue(database, continuationQuery);
      expect(actual.value).toEqual(expected.value);
      expect(actual.diagnostics.advancedCountSqlFallbackReason).toEqual({
        kind: "numeric-data-domain",
        fieldIds: ["page.durationMs"],
      });
      const guardIndex = actual.trace.preparedSql.findIndex((sql) =>
        sql.includes('AS "outputId"'),
      );
      expect(guardIndex).toBeGreaterThanOrEqual(0);
      const guardSql = actual.trace.preparedSql[guardIndex]!;
      const guardRows = database
        .prepare(guardSql)
        .all(...(actual.trace.bindings[guardIndex] ?? [])) as Record<
        string,
        unknown
      >[];
      expect(guardRows.filter((row) => row.rowKind === "control")).toHaveLength(
        1,
      );
      expect(guardRows.filter((row) => row.rowKind === "report")).toHaveLength(
        0,
      );
      const compatibilitySql = actual.trace.preparedSql.at(-1);
      expect(compatibilitySql).toContain("visit_id");
      expect(compatibilitySql).not.toContain("entity_id");
      expect(compatibilitySql).not.toBe(guardSql);
      evidence.push({
        scenario: "numeric-data-domain-full-pages-tabs-fallback",
        scope,
        signedCursorContinuation: signedCursor,
        statementCount: actual.trace.preparedSql.length,
        sql: actual.trace.preparedSql,
        bindings: actual.trace.bindings,
        nativeGuardSql: guardSql,
        nativeGuardRows: guardRows,
        finalCompatibilitySql: compatibilitySql,
        nativeFallbackSql: legacyTrace.preparedSql,
        nativeFallbackBindings: legacyTrace.bindings,
        nativeFallbackStatementCount: legacyTrace.preparedSql.length,
        fallbackReason: actual.diagnostics.advancedCountSqlFallbackReason,
      });
    },
  );

  it("checks the activity cap before reporting a malformed cursor", async () => {
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
    const insert = database.prepare(
      `INSERT INTO custom_events (
        event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
        received_at, sequence, node_count, value_count
      ) VALUES (?, ?, ?, ?, 1, 150, 150, ?, 0, 0)`,
    );
    database.exec("BEGIN");
    for (let index = 0; index < 20000; index += 1)
      insert.run(
        `wave96c-bulk-${index}`,
        site.id,
        site.pk,
        "bulk-owner",
        index + 2,
      );
    database.exec("COMMIT");
    const query = queryFor("session", {
      configuration: "pages-with-tabs",
      cursor: "malformed.cursor.token",
      limit: 5,
    });
    const trace = traceFor();
    const provider = createD1SiteProviderRegistry({
      env: testEnv(database, trace),
      siteId: SITE,
    }).resolve("pages");
    if (!provider) throw new Error("wave96c_pages_provider_missing");
    await expect(provider.execute(query)).rejects.toMatchObject({
      domainError: {
        kind: "invalid-input",
        issues: [{ path: "filters", code: "filter_activity_limit_exceeded" }],
      },
    });
    evidence.push({
      scenario: "activity-cap-before-malformed-cursor",
      statementCount: trace.preparedSql.length,
      sql: trace.preparedSql,
      bindings: trace.bindings,
    });
  }, 30000);

  it("preserves request brands, scope boundaries, and abort behavior", async () => {
    const database = createFixture();
    const middleware = d1AdvancedFilterMiddleware(
      testEnv(database, traceFor()),
      undefined,
      SITE,
    );
    const withTabs = queryFor("session", { configuration: "pages-with-tabs" });
    const attachedWithTabs = await middleware(
      "pages",
      withTabs,
      async (value) => value,
    );
    const pagesTabs = deferredPagesTabsQualificationFromQuery(attachedWithTabs);
    expect(pagesTabs?.pagesTabsRequest.configuration).toBe("pages-with-tabs");
    const changedWithTabs = attachedWithTabs as Record<string, unknown>;
    changedWithTabs.includeDetails = true;
    expect(() =>
      deferredPagesTabsQualificationFromQuery(changedWithTabs),
    ).toThrow("deferred_pages_tabs_request_changed");

    const attachedTabsOnly = await middleware(
      "pages",
      queryFor("session", { configuration: "tabs-only" }),
      async (value) => value,
    );
    const changedTabsConfiguration = attachedTabsOnly as Record<
      string,
      unknown
    >;
    changedTabsConfiguration.variant = undefined;
    expect(() =>
      deferredPagesTabsQualificationFromQuery(changedTabsConfiguration),
    ).toThrow("deferred_pages_tabs_request_changed");

    const changedToTabs = await middleware(
      "pages",
      withTabs,
      async (value) => value,
    );
    (changedToTabs as Record<string, unknown>).variant = "tabs";
    expect(() =>
      deferredPagesTabsQualificationFromQuery(changedToTabs),
    ).toThrow("deferred_pages_tabs_request_changed");

    const flat = {
      ...queryFor("session", { configuration: "pages-with-tabs" }),
      includeTabs: false,
    } as PagesTabsQuery;
    const attachedFlat = await middleware(
      "pages",
      flat,
      async (value) => value,
    );
    expect(
      deferredPagesAggregatePageQualificationFromQuery(attachedFlat),
    ).toBeDefined();
    expect(
      deferredPagesTabsQualificationFromQuery(attachedFlat),
    ).toBeUndefined();

    for (const query of [
      queryFor("session", {
        configuration: "pages-with-tabs",
        audience: "public-share",
      }),
      queryFor("session", { configuration: "tabs-only", limit: 1.5 }),
    ]) {
      const forwarded = await middleware(
        "pages",
        query,
        async (value) => value,
      );
      expect(
        deferredPagesTabsQualificationFromQuery(forwarded),
      ).toBeUndefined();
    }

    const invalidTimeQuery = {
      ...withTabs,
      time: { ...TIME, fullHistory: true },
    } as PagesTabsQuery;
    const invalidTimeForwarded = await middleware(
      "pages",
      invalidTimeQuery,
      async (value) => value,
    );
    expect(
      deferredPagesTabsQualificationFromQuery(invalidTimeForwarded),
    ).toBeUndefined();

    const nativeRoute = await middleware(
      "performance",
      withTabs,
      async (value) => value,
    );
    expect(
      deferredPagesTabsQualificationFromQuery(nativeRoute),
    ).toBeUndefined();
    expect(
      scopedFilterMetadata((nativeRoute as PagesTabsQuery).filters)?.plan
        .advancedMatches,
    ).toBeDefined();

    const preAbortTrace = traceFor();
    const preAbortProvider = createD1SiteProviderRegistry({
      env: testEnv(database, preAbortTrace),
      siteId: SITE,
    }).resolve("pages");
    if (!preAbortProvider) throw new Error("wave96c_pages_provider_missing");
    const preAbort = new AbortController();
    preAbort.abort();
    await expect(
      preAbortProvider.execute(withTabs, { signal: preAbort.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(preAbortTrace.preparedSql).toHaveLength(0);

    const postAbortTrace = traceFor();
    const postAbort = new AbortController();
    const postAbortProvider = createD1SiteProviderRegistry({
      env: testEnvWithBehavior(
        database,
        postAbortTrace,
        "post-abort",
        postAbort,
      ),
      siteId: SITE,
    }).resolve("pages");
    if (!postAbortProvider) throw new Error("wave96c_pages_provider_missing");
    await expect(
      postAbortProvider.execute(withTabs, { signal: postAbort.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    evidence.push({
      scenario: "pre-post-abort",
      preAbortStatementCount: preAbortTrace.preparedSql.length,
      postAbortStatementCount: postAbortTrace.preparedSql.length,
      postAbortSql: postAbortTrace.preparedSql,
    });
  });
});
