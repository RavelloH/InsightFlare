import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { afterAll, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { D1_MAX_BOUND_PARAMETERS, D1_MAX_SQL_UTF8_BYTES } from "@/lib/db";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { createD1SiteProviderRegistry } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import {
  prepareScopedQuery,
  type QueryInput,
  type QueryTime,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { createQueryTime } from "@/lib/edge/analytics/contract/helpers";
import { EVENT_QUALIFICATION_CONTROL_OUTPUT } from "@/lib/edge/analytics/engine/event-qualified-source-plan";
import { EVENT_RECORD_PAGE_OUTPUT_ID } from "@/lib/edge/analytics/engine/event-record-page-plan";
import {
  d1AdvancedFilterMiddleware,
  deferredEventRecordsQualificationFromQuery,
  prepareDeferredEventQualificationFallback,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import type { EventRecordsQualificationCompilationEvidence } from "@/lib/edge/analytics/providers/d1/internal/analytics-event-record-qualification-program";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import { readSiteEventRecords } from "@/lib/edge/analytics/providers/d1/operations/site-event-records";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import type { FilterDocument } from "@/lib/filter-contract/filters";

const SITE_ID = "wave95a-event-records-runtime";
const WINDOW = {
  startMs: Date.UTC(2026, 0, 1, 8),
  endExclusiveMs: Date.UTC(2026, 0, 4, 8),
  nowMs: Date.UTC(2026, 0, 5, 8),
  timeZone: "America/Los_Angeles",
} as const;
const QUERY_TIME = createQueryTime(
  WINDOW.startMs,
  WINDOW.endExclusiveMs,
  WINDOW.timeZone,
  WINDOW.nowMs,
);
const ARTIFACT_DIR = process.env.WAVE97EI_ARTIFACT_DIR
  ? resolve(process.env.WAVE97EI_ARTIFACT_DIR)
  : resolve("plan/execution-wave95a-name-gate-repair/run-1/runtime");
const databases = new Set<DatabaseSync>();
const runtimeEvidence: unknown[] = [];
const nameGateEvidence: unknown[] = [];
const compileBudgetEvidence: unknown[] = [];
const compilationEvidence: Array<{
  readonly scope: "session" | "visitor" | "event";
  readonly evidence: unknown;
}> = [];

interface RecordsQuery extends QueryInput {
  readonly filters: FilterDocument;
  readonly time: QueryTime;
  readonly sort: {
    readonly key: "occurredAt";
    readonly direction: "asc" | "desc";
  };
  readonly search?: string;
  readonly eventName?: string;
  readonly page: { readonly limit: number; readonly cursor: string | null };
}

function newTrace(): SqliteD1Trace {
  return { preparedSql: [], bindings: [] };
}

function clearTrace(trace: SqliteD1Trace): void {
  trace.preparedSql.length = 0;
  trace.bindings.length = 0;
}

function statementEvidence(trace: SqliteD1Trace) {
  return trace.preparedSql.map((sql, index) => ({
    sql,
    bindings: trace.bindings[index],
    sqlBytes: new TextEncoder().encode(sql).byteLength,
    bindingCount: trace.bindings[index]?.length ?? 0,
    sha256: createHash("sha256").update(sql, "utf8").digest("hex"),
  }));
}

function testEnv(database: DatabaseSync, trace: SqliteD1Trace): Env {
  return {
    DB: createSqliteD1Database(database, trace),
    MAIN_SECRET: "wave95a-event-records-runtime-test-secret",
  } as unknown as Env;
}

function createFixture(): DatabaseSync {
  const database = createMigratedDatabase();
  databases.add(database);
  database.exec("PRAGMA foreign_keys = OFF");
  database
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .run(SITE_ID);
  const sitePk = Number(
    (
      database
        .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
        .get(SITE_ID) as { readonly site_pk: number }
    ).site_pk,
  );
  database
    .prepare(
      `INSERT INTO sites (id, team_id, name, domain, created_at)
       VALUES (?, ?, ?, ?, 0)`,
    )
    .run(SITE_ID, "wave95a-team", "Event records", "records.test");
  database
    .prepare(
      `INSERT INTO custom_event_names (id, site_id, name, last_seen_at, site_pk)
       VALUES (1, ?, 'purchase', ?, ?), (2, ?, 'signup', ?, ?)`,
    )
    .run(
      SITE_ID,
      WINDOW.endExclusiveMs - 1,
      sitePk,
      SITE_ID,
      WINDOW.endExclusiveMs - 1,
      sitePk,
    );
  const insertVisit = database.prepare(
    `INSERT INTO visits (
      visit_id, site_id, site_pk, visitor_id, session_id, status,
      started_at, last_activity_at, pathname, hostname, title, country,
      browser, device_type
    ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, 'records.test', ?, 'US', 'Chrome', 'desktop')`,
  );
  insertVisit.run(
    "visit-scoped",
    SITE_ID,
    sitePk,
    "visitor-a",
    "session-a",
    WINDOW.startMs + 1,
    WINDOW.startMs + 1,
    "/scoped",
    "Scoped page",
  );
  insertVisit.run(
    "visit-other-page",
    SITE_ID,
    sitePk,
    "visitor-a",
    "session-b",
    WINDOW.startMs + 2,
    WINDOW.startMs + 2,
    "/other",
    "Other page",
  );
  const insertEvent = database.prepare(
    `INSERT INTO custom_events (
      event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
      received_at, sequence, node_count, value_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
  );
  insertEvent.run(
    "event-a",
    SITE_ID,
    sitePk,
    "visit-scoped",
    1,
    WINDOW.startMs + 1000,
    WINDOW.startMs + 1000,
    1,
  );
  insertEvent.run(
    "event-b",
    SITE_ID,
    sitePk,
    "visit-scoped",
    2,
    WINDOW.startMs + 1000,
    WINDOW.startMs + 1000,
    2,
  );
  insertEvent.run(
    "event-c",
    SITE_ID,
    sitePk,
    "visit-other-page",
    1,
    WINDOW.startMs + 2000,
    WINDOW.startMs + 2000,
    1,
  );
  return database;
}

function prepareQuery(
  scope: "session" | "visitor" | "event",
  direction: "asc" | "desc",
  overrides: Partial<Pick<RecordsQuery, "search" | "eventName" | "page">> & {
    readonly filterDsl?: string;
  } = {},
  audience:
    "private-dashboard" | "public-share" | "api-v1" = "private-dashboard",
): RecordsQuery {
  const filters = parseFilterDsl(
    overrides.filterDsl ?? 'count(page { page.path eq "/scoped" }) eq 1',
    analyticsFilterRegistry,
  );
  const prepared = prepareScopedQuery("event-records", {
    context: siteQueryContext(SITE_ID, audience),
    time: QUERY_TIME,
    filters,
    scopePreference: scope,
  } as QueryInput & { readonly time: QueryTime }) as QueryInput & {
    readonly filters?: FilterDocument;
    readonly time?: QueryTime;
  };
  if (!prepared.filters || !prepared.time)
    throw new Error("wave95a_event_records_query_preparation_failed");
  return {
    ...prepared,
    filters: prepared.filters,
    time: prepared.time,
    sort: { key: "occurredAt", direction },
    page: overrides.page ?? { limit: 1, cursor: null },
    ...(overrides.search !== undefined ? { search: overrides.search } : {}),
    ...(overrides.eventName !== undefined
      ? { eventName: overrides.eventName }
      : {}),
  } as RecordsQuery;
}

function timeWindow(time: QueryTime) {
  return {
    startMs: time.range.startMs,
    endExclusiveMs: time.range.endExclusiveMs,
    nowMs: time.capturedAtMs,
    timeZone: time.reportingTimeZone,
  };
}

async function legacyPage(env: Env, query: RecordsQuery) {
  const deferredQuery = await d1AdvancedFilterMiddleware(env)(
    "event-records",
    query,
    async (value) => value,
  );
  const deferred = deferredEventRecordsQualificationFromQuery(deferredQuery);
  if (!deferred)
    throw new Error("wave95a_event_records_deferred_query_missing");
  const filters = await prepareDeferredEventQualificationFallback(deferred);
  return readSiteEventRecords({
    env,
    siteId: SITE_ID,
    window: timeWindow(query.time),
    filters,
    queryTime: query.time,
    search: query.search,
    eventName: query.eventName,
    sort: { field: "occurredAt", direction: query.sort.direction },
    audience: query.context.policy.audience,
    page: query.page,
  });
}

async function legacyCorePage(env: Env, query: RecordsQuery) {
  const preparedQuery = await d1AdvancedFilterMiddleware(
    env,
    undefined,
    SITE_ID,
  )("event-records", query, async (value) => value);
  if (deferredEventRecordsQualificationFromQuery(preparedQuery))
    throw new Error("wave97ei_expected_api_v1_event_records_core_path");
  const filters = (
    preparedQuery as QueryInput & {
      readonly filters?: FilterDocument;
    }
  ).filters;
  if (!filters)
    throw new Error("wave97ei_api_v1_event_records_core_filters_missing");
  return readSiteEventRecords({
    env,
    siteId: SITE_ID,
    window: timeWindow(query.time),
    filters,
    queryTime: query.time,
    search: query.search,
    eventName: query.eventName,
    sort: { field: "occurredAt", direction: query.sort.direction },
    audience: query.context.policy.audience,
    page: query.page,
  });
}

function evidenceFileName(scope: string): string {
  return `${scope}-default-qualification.json`;
}

afterAll(() => {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  for (const database of databases) database.close();
  writeFileSync(
    resolve(ARTIFACT_DIR, "runtime-dto-and-call-counts.json"),
    JSON.stringify(runtimeEvidence, null, 2),
    "utf8",
  );
  writeFileSync(
    resolve(ARTIFACT_DIR, "prepared-name-gate-differential.json"),
    JSON.stringify(nameGateEvidence, null, 2),
    "utf8",
  );
  writeFileSync(
    resolve(ARTIFACT_DIR, "compile-budget-probe.json"),
    JSON.stringify(compileBudgetEvidence, null, 2),
    "utf8",
  );
  for (const { scope, evidence } of compilationEvidence) {
    const logicalPlan = (evidence as { logicalPlan: unknown }).logicalPlan;
    const graph = JSON.stringify(logicalPlan, null, 2);
    writeFileSync(
      resolve(ARTIFACT_DIR, evidenceFileName(scope)),
      JSON.stringify(
        {
          scope,
          graphSha256: createHash("sha256").update(graph, "utf8").digest("hex"),
          graph,
          evidence,
        },
        null,
        2,
      ),
      "utf8",
    );
  }
});

describe("event records runtime qualification", () => {
  it.each([
    ["session", "asc", ["event-a", "event-b"]],
    ["visitor", "desc", ["event-c", "event-b", "event-a"]],
  ] as const)(
    "matches the complete legacy DTO and cursor pages for %s scope",
    async (scope, direction, expectedIds) => {
      const database = createFixture();
      const trace = newTrace();
      const env = testEnv(database, trace);
      const defaultQuery = prepareQuery(scope, direction, {
        page: { limit: 80, cursor: null },
      });
      const expectedDefaultPage = await legacyPage(env, defaultQuery);
      clearTrace(trace);

      const diagnostics = createD1ReadDiagnostics();
      diagnostics.onEventRecordsQualificationCompile = (evidence) => {
        compilationEvidence.push({ scope, evidence });
      };
      const registry = createD1SiteProviderRegistry({
        env,
        siteId: SITE_ID,
        diagnostics,
      });
      const provider = registry.resolve("event-records");
      if (!provider) throw new Error("wave95a_event_records_provider_missing");
      const actualDefaultPage = (await provider.execute(defaultQuery)).value;
      expect(actualDefaultPage).toEqual(expectedDefaultPage);
      expect(actualDefaultPage.items.map(({ eventId }) => eventId)).toEqual(
        expectedIds,
      );
      expect(actualDefaultPage.pagination.hasMore).toBe(false);
      expect(trace.preparedSql).toHaveLength(2);
      expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
      diagnostics.onEventRecordsQualificationCompile = undefined;

      const defaultCall = {
        scope,
        direction,
        kind: "compared",
        actualDto: actualDefaultPage,
        legacyDto: expectedDefaultPage,
        statementCount: trace.preparedSql.length,
        statementMetrics: trace.preparedSql.map((sql, index) => ({
          index,
          sqlBytes: new TextEncoder().encode(sql).byteLength,
          sha256: createHash("sha256").update(sql, "utf8").digest("hex"),
          bindingCount: trace.bindings[index]?.length ?? null,
        })),
      };

      const paginationQuery = prepareQuery(scope, direction, {
        page: { limit: 1, cursor: null },
      });
      const expectedFirstPage = await legacyPage(env, paginationQuery);
      clearTrace(trace);
      const actualFirstPage = (await provider.execute(paginationQuery)).value;
      expect(actualFirstPage).toEqual(expectedFirstPage);
      expect(actualFirstPage.items.map(({ eventId }) => eventId)).toEqual([
        expectedIds[0],
      ]);
      expect(actualFirstPage.pagination.hasMore).toBe(true);
      expect(trace.preparedSql).toHaveLength(2);

      const followingPages: unknown[] = [];
      const returnedIds = actualFirstPage.items.map(({ eventId }) => eventId);
      let cursor = actualFirstPage.pagination.nextCursor;
      let pageNumber = 1;
      while (cursor) {
        const nextQuery = {
          ...paginationQuery,
          page: { limit: paginationQuery.page.limit, cursor },
        } as RecordsQuery;
        const expectedPage = await legacyPage(env, nextQuery);
        clearTrace(trace);
        const actualPage = (await provider.execute(nextQuery)).value;
        expect(actualPage).toEqual(expectedPage);
        expect(trace.preparedSql).toHaveLength(2);
        returnedIds.push(...actualPage.items.map(({ eventId }) => eventId));
        followingPages.push({
          pageNumber,
          actualDto: actualPage,
          legacyDto: expectedPage,
          statementCount: trace.preparedSql.length,
          cursor,
        });
        cursor = actualPage.pagination.nextCursor;
        pageNumber += 1;
        if (pageNumber > expectedIds.length + 1)
          throw new Error("wave95a_event_records_cursor_did_not_terminate");
      }
      expect(returnedIds).toEqual(expectedIds);
      expect(followingPages.at(-1)).toMatchObject({
        actualDto: { pagination: { hasMore: false, nextCursor: null } },
      });

      runtimeEvidence.push({
        defaultCall,
        firstPage: {
          actualDto: actualFirstPage,
          legacyDto: expectedFirstPage,
          statementCount: 2,
        },
        followingPages,
        totalReturnedIds: returnedIds,
      });
    },
  );

  it.each([
    {
      label: "top-level Count AND bare Event",
      filterDsl:
        'count(page { page.path eq "/scoped" }) eq 1 AND event.name eq "signup"',
      expectedIds: ["event-b"],
    },
    {
      label: "top-level Count OR NOT bare Event",
      filterDsl:
        'count(page { page.path eq "/scoped" }) eq 1 OR NOT event.name eq "purchase"',
      expectedIds: ["event-a", "event-b"],
    },
  ] as const)(
    "executes complete Event candidate record pages for $label",
    async ({ label, filterDsl, expectedIds }) => {
      const actualDatabase = createFixture();
      const legacyDatabase = createFixture();
      const query = prepareQuery("event", "asc", {
        filterDsl,
        page: { limit: 1, cursor: null },
      });
      const diagnostics = createD1ReadDiagnostics();
      const compilations: EventRecordsQualificationCompilationEvidence[] = [];
      diagnostics.onEventRecordsQualificationCompile = (evidence) => {
        compilationEvidence.push({ scope: "event", evidence });
        compilations.push(
          evidence as EventRecordsQualificationCompilationEvidence,
        );
      };

      const actualTrace = newTrace();
      const actualEnv = testEnv(actualDatabase, actualTrace);
      const provider = createD1SiteProviderRegistry({
        env: actualEnv,
        siteId: SITE_ID,
        diagnostics,
      }).resolve("event-records");
      if (!provider)
        throw new Error("wave97ei_event_candidate_records_provider_missing");
      const legacyFirstTrace = newTrace();
      const expectedFirst = await legacyPage(
        testEnv(legacyDatabase, legacyFirstTrace),
        query,
      );
      const actualFirst = (await provider.execute(query)).value;
      expect(actualFirst).toEqual(expectedFirst);
      expect(actualFirst.items.map(({ eventId }) => eventId)).toEqual([
        expectedIds[0],
      ]);
      expect(actualFirst.pagination.nextCursor).toBe(
        expectedFirst.pagination.nextCursor,
      );
      expect(actualFirst.pagination.hasMore).toBe(expectedIds.length > 1);
      expect(actualTrace.preparedSql).toHaveLength(2);
      expect(compilations).toHaveLength(1);

      const compilation = compilations[0]!;
      expect(actualTrace.preparedSql[1]).toBe(compilation.sql);
      expect(actualTrace.bindings[1]).toEqual(compilation.bindings);
      expect(compilation.sqlBytes).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
      expect(compilation.bindingCount).toBeLessThanOrEqual(
        D1_MAX_BOUND_PARAMETERS,
      );
      expect(compilation.groupWidth).toBeLessThanOrEqual(16);
      expect(compilation.groupedSummaryMaterializations).toHaveLength(2);
      expect(
        compilation.groupedSummaryMaterializations.every(
          (summary) =>
            summary.materialization === "materialized" &&
            summary.groupWidth <= 16,
        ),
      ).toBe(true);

      const rawRows = actualDatabase
        .prepare(compilation.sql)
        .all(...(compilation.bindings as SQLInputValue[])) as Record<
        string,
        unknown
      >[];
      const controls = rawRows.filter((row) => row.rowKind === "control");
      const reportRows = rawRows.filter((row) => row.rowKind === "record");
      expect(controls).toHaveLength(1);
      expect(controls[0]).toMatchObject({
        outputId: EVENT_QUALIFICATION_CONTROL_OUTPUT,
        entityKind: "event",
        nullActivityIdCount: 0,
        siteIdentityMismatchCount: 0,
        invalidIdentityCount: 0,
        duplicateIdentityCount: 0,
      });
      expect(Number(controls[0]?.rawCount)).toBeGreaterThan(0);
      expect(reportRows.length).toBe(Math.min(expectedIds.length, 2));
      expect(
        reportRows.every((row) => row.outputId === EVENT_RECORD_PAGE_OUTPUT_ID),
      ).toBe(true);

      const pageRuns: Array<Record<string, unknown>> = [
        {
          cursor: null,
          dto: actualFirst,
          legacyDto: expectedFirst,
          statements: statementEvidence(actualTrace),
          legacyStatements: statementEvidence(legacyFirstTrace),
        },
      ];
      const returnedIds = actualFirst.items.map(({ eventId }) => eventId);
      let cursor = actualFirst.pagination.nextCursor;
      let pageNumber = 2;
      while (cursor) {
        const nextQuery = {
          ...query,
          page: { limit: query.page.limit, cursor },
        } as RecordsQuery;
        const legacyPageTrace = newTrace();
        const expectedPage = await legacyPage(
          testEnv(legacyDatabase, legacyPageTrace),
          nextQuery,
        );
        clearTrace(actualTrace);
        const actualPage = (await provider.execute(nextQuery)).value;
        expect(actualPage).toEqual(expectedPage);
        expect(actualPage.pagination.nextCursor).toBe(
          expectedPage.pagination.nextCursor,
        );
        expect(actualTrace.preparedSql).toHaveLength(2);
        expect(actualPage.items.map(({ eventId }) => eventId)).toEqual([
          expectedIds[pageNumber - 1],
        ]);
        returnedIds.push(...actualPage.items.map(({ eventId }) => eventId));
        pageRuns.push({
          pageNumber,
          cursor,
          dto: actualPage,
          legacyDto: expectedPage,
          statements: statementEvidence(actualTrace),
          legacyStatements: statementEvidence(legacyPageTrace),
        });
        cursor = actualPage.pagination.nextCursor;
        pageNumber += 1;
        if (pageNumber > expectedIds.length + 1)
          throw new Error("wave97ei_event_candidate_cursor_did_not_terminate");
      }
      expect(returnedIds).toEqual(expectedIds);
      expect(new Set(returnedIds).size).toBe(expectedIds.length);
      expect(pageRuns.at(-1)?.dto).toMatchObject({
        pagination: { hasMore: false, nextCursor: null },
      });

      runtimeEvidence.push({
        kind: "wave97ei-event-candidate-record-pages-v1",
        label,
        filterDsl,
        expectedIds,
        firstCompilation: compilation,
        rawRows,
        controls,
        reportRows,
        pages: pageRuns,
        returnedIds,
        dtoEqualToLegacyCore: true,
      });
    },
  );

  it("keeps normalized Event search separate from the Count candidate universe", async () => {
    const filterDsl =
      'count(page { page.path eq "/scoped" }) eq 1 OR NOT event.name eq "purchase"';
    const query = prepareQuery("event", "desc", {
      filterDsl,
      search: " EVENT-B ",
      eventName: "   ",
      page: { limit: 10, cursor: null },
    });
    const actualDatabase = createFixture();
    const legacyDatabase = createFixture();
    const actualTrace = newTrace();
    const diagnostics = createD1ReadDiagnostics();
    let compilation:
      | Parameters<
          NonNullable<typeof diagnostics.onEventRecordsQualificationCompile>
        >[0]
      | undefined;
    diagnostics.onEventRecordsQualificationCompile = (evidence) => {
      compilation = evidence;
      compilationEvidence.push({ scope: "event", evidence });
    };
    const provider = createD1SiteProviderRegistry({
      env: testEnv(actualDatabase, actualTrace),
      siteId: SITE_ID,
      diagnostics,
    }).resolve("event-records");
    if (!provider)
      throw new Error("wave97ei_event_candidate_search_provider_missing");
    const legacyTrace = newTrace();
    const expected = await legacyPage(
      testEnv(legacyDatabase, legacyTrace),
      query,
    );
    const actual = (await provider.execute(query)).value;
    expect(actual).toEqual(expected);
    expect(actual.items.map(({ eventId }) => eventId)).toEqual(["event-b"]);
    expect(actual.pagination.hasMore).toBe(false);
    expect(actualTrace.preparedSql).toHaveLength(2);
    expect(compilation).toBeDefined();
    if (!compilation)
      throw new Error("wave97ei_event_candidate_search_compile_missing");
    const rawRows = actualDatabase
      .prepare(compilation.sql)
      .all(...(compilation.bindings as SQLInputValue[])) as Record<
      string,
      unknown
    >[];
    const controls = rawRows.filter((row) => row.rowKind === "control");
    const reportRows = rawRows.filter((row) => row.rowKind === "record");
    expect(controls).toHaveLength(1);
    expect(Number(controls[0]?.rawCount)).toBe(5);
    expect(reportRows).toHaveLength(1);
    runtimeEvidence.push({
      kind: "wave97ei-event-candidate-record-search-v1",
      filterDsl,
      search: query.search,
      normalizedSearch: query.search?.trim(),
      eventName: query.eventName,
      normalizedEventName: undefined,
      compilation,
      rawRows,
      actualDto: actual,
      legacyCoreDto: expected,
      actualStatements: statementEvidence(actualTrace),
      legacyCoreStatements: statementEvidence(legacyTrace),
      dtoEqualToLegacyCore: true,
    });
  });

  it("uses whole-operation Core fallback for Event candidate numeric anomalies", async () => {
    const filterDsl = "count(page { page.durationMs gt 5 }) eq 1";
    const actualDatabase = createFixture();
    actualDatabase
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "visit-scoped");
    const legacyDatabase = createFixture();
    legacyDatabase
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "visit-scoped");
    const query = prepareQuery("event", "desc", {
      filterDsl,
      page: { limit: 10, cursor: null },
    });
    const actualTrace = newTrace();
    const diagnostics = createD1ReadDiagnostics();
    let compilation:
      | Parameters<
          NonNullable<typeof diagnostics.onEventRecordsQualificationCompile>
        >[0]
      | undefined;
    diagnostics.onEventRecordsQualificationCompile = (evidence) => {
      compilation = evidence;
      compilationEvidence.push({ scope: "event", evidence });
    };
    const provider = createD1SiteProviderRegistry({
      env: testEnv(actualDatabase, actualTrace),
      siteId: SITE_ID,
      diagnostics,
    }).resolve("event-records");
    if (!provider)
      throw new Error("wave97ei_event_candidate_numeric_provider_missing");
    const legacyTrace = newTrace();
    const expected = await legacyPage(
      testEnv(legacyDatabase, legacyTrace),
      query,
    );
    const actual = (await provider.execute(query)).value;
    expect(actual).toEqual(expected);
    expect(diagnostics.advancedCountSqlFallbackReason).toEqual({
      kind: "numeric-data-domain",
      fieldIds: ["page.durationMs"],
    });
    expect(actualTrace.preparedSql.length).toBeGreaterThanOrEqual(4);
    expect(compilation).toBeDefined();
    if (!compilation)
      throw new Error("wave97ei_event_candidate_numeric_compile_missing");
    const rawRows = actualDatabase
      .prepare(compilation.sql)
      .all(...(compilation.bindings as SQLInputValue[])) as Record<
      string,
      unknown
    >[];
    const controls = rawRows.filter((row) => row.rowKind === "control");
    const reportRows = rawRows.filter((row) => row.rowKind === "record");
    const numericControl = Object.entries(controls[0] ?? {}).find(
      ([name]) =>
        name.toLowerCase().includes("duration") && name.endsWith("Count"),
    );
    expect(controls).toHaveLength(1);
    expect(controls[0]).toMatchObject({
      outputId: EVENT_QUALIFICATION_CONTROL_OUTPUT,
      entityKind: "event",
      rawCount: 5,
    });
    expect(Number(numericControl?.[1])).toBeGreaterThan(0);
    expect(reportRows).toHaveLength(0);
    runtimeEvidence.push({
      kind: "wave97ei-event-candidate-record-numeric-fallback-v1",
      filterDsl,
      compilation,
      rawRows,
      controls,
      reportRowCount: reportRows.length,
      fallbackReason: diagnostics.advancedCountSqlFallbackReason,
      actualDto: actual,
      legacyCoreDto: expected,
      actualStatements: statementEvidence(actualTrace),
      legacyCoreStatements: statementEvidence(legacyTrace),
      dtoEqualToLegacyCore: true,
    });
  });

  it("rejects accessor and context-mismatched Event requests before reads", async () => {
    const query = prepareQuery("event", "asc");
    const accessorTrace = newTrace();
    const accessorRequest = { ...query } as RecordsQuery;
    let getterReads = 0;
    let accessorNextEntered = false;
    Object.defineProperty(accessorRequest, "search", {
      enumerable: true,
      get() {
        getterReads += 1;
        return query.search;
      },
    });
    const accessorMiddleware = d1AdvancedFilterMiddleware(
      testEnv(createFixture(), accessorTrace),
      undefined,
      SITE_ID,
    );
    await expect(
      accessorMiddleware("event-records", accessorRequest, async (value) => {
        accessorNextEntered = true;
        return value;
      }),
    ).rejects.toMatchObject({
      domainError: {
        kind: "invalid-input",
        issues: [
          {
            path: "query",
            code: "event_records_qualification_request_own_data_required",
          },
        ],
      },
    });
    expect(getterReads).toBe(0);
    expect(accessorNextEntered).toBe(false);
    expect(accessorTrace.preparedSql).toHaveLength(0);

    const mismatchTrace = newTrace();
    const mismatchRequest = {
      ...query,
      context: siteQueryContext(`${SITE_ID}-mismatch`, "private-dashboard"),
    } as RecordsQuery;
    let mismatchNextEntered = false;
    const mismatchMiddleware = d1AdvancedFilterMiddleware(
      testEnv(createFixture(), mismatchTrace),
      undefined,
      SITE_ID,
    );
    await expect(
      mismatchMiddleware("event-records", mismatchRequest, async (value) => {
        mismatchNextEntered = true;
        return value;
      }),
    ).rejects.toMatchObject({
      domainError: {
        kind: "invalid-input",
        issues: [
          {
            path: "query",
            code: "event_records_qualification_request_context_mismatch",
          },
        ],
      },
    });
    expect(mismatchNextEntered).toBe(false);
    expect(mismatchTrace.preparedSql).toHaveLength(0);
    runtimeEvidence.push({
      kind: "wave97ei-event-record-request-safety-v1",
      accessor: {
        getterReads,
        nextEntered: accessorNextEntered,
        statementCount: accessorTrace.preparedSql.length,
        rejectionCode: "event_records_qualification_request_own_data_required",
      },
      contextMismatch: {
        nextEntered: mismatchNextEntered,
        statementCount: mismatchTrace.preparedSql.length,
        rejectionCode: "event_records_qualification_request_context_mismatch",
      },
    });
  });

  it("preserves api-v1 Event Count requests on the legacy Core records path", async () => {
    const query = prepareQuery(
      "event",
      "desc",
      { page: { limit: 20, cursor: null } },
      "api-v1",
    );
    const actualDatabase = createFixture();
    const legacyDatabase = createFixture();
    const actualTrace = newTrace();
    const diagnostics = createD1ReadDiagnostics();
    let compileCalls = 0;
    diagnostics.onEventRecordsQualificationCompile = () => {
      compileCalls += 1;
    };
    const provider = createD1SiteProviderRegistry({
      env: testEnv(actualDatabase, actualTrace),
      siteId: SITE_ID,
      diagnostics,
    }).resolve("event-records");
    if (!provider)
      throw new Error("wave97ei_api_v1_event_records_provider_missing");

    const expected = await legacyCorePage(
      testEnv(legacyDatabase, newTrace()),
      query,
    );
    const actual = (await provider.execute(query)).value;
    expect(actual).toEqual(expected);
    expect(actual.items.map(({ eventId }) => eventId).sort()).toEqual([
      "event-a",
      "event-b",
    ]);
    expect(actual.pagination).toMatchObject({
      hasMore: false,
      nextCursor: null,
    });
    expect(compileCalls).toBe(0);
    runtimeEvidence.push({
      kind: "wave97ei-api-v1-event-count-core-compatibility-v1",
      audience: query.context.policy.audience,
      scope: "event",
      actualDto: actual,
      legacyCoreDto: expected,
      actualStatements: statementEvidence(actualTrace),
      compileCalls,
      dtoEqualToLegacyCore: true,
    });
  });

  it("preserves normalized search and blank-name behavior", async () => {
    const database = createFixture();
    const trace = newTrace();
    const env = testEnv(database, trace);
    const query = prepareQuery("visitor", "asc", {
      search: " EVENT- ",
      eventName: "   ",
      page: { limit: 10, cursor: null },
    });
    const expected = await legacyPage(env, query);
    clearTrace(trace);
    const actual = await createD1SiteProviderRegistry({
      env,
      siteId: SITE_ID,
    })
      .resolve("event-records")!
      .execute(query);
    expect(actual.value).toEqual(expected);
    expect(actual.value.items).toHaveLength(3);
    expect(trace.preparedSql).toHaveLength(2);
  });

  it("preserves prepared trimmed-label semantics for stored event names", async () => {
    const database = createFixture();
    const sitePk = Number(
      (
        database
          .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
          .get(SITE_ID) as { readonly site_pk: number }
      ).site_pk,
    );
    database
      .prepare("UPDATE custom_event_names SET name = ? WHERE id = 1")
      .run(" purchase ");
    database
      .prepare(
        `INSERT INTO custom_event_names (id, site_id, name, last_seen_at, site_pk)
         VALUES (3, ?, '   ', ?, ?)`,
      )
      .run(SITE_ID, WINDOW.endExclusiveMs - 1, sitePk);
    database
      .prepare(
        `INSERT INTO custom_events (
          event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
          received_at, sequence, node_count, value_count
        ) VALUES (?, ?, ?, ?, 3, ?, ?, 3, 0, 0)`,
      )
      .run(
        "event-whitespace-name",
        SITE_ID,
        sitePk,
        "visit-scoped",
        WINDOW.startMs + 3000,
        WINDOW.startMs + 3000,
      );

    const cases = [
      { label: "ordinary parameter", eventName: "purchase" },
      { label: "padded parameter", eventName: " purchase " },
      { label: "ordinary stored label", eventName: "signup" },
      { label: "empty parameter", eventName: "" },
      { label: "whitespace parameter", eventName: "   " },
    ] as const;

    for (const scope of ["session", "visitor"] as const) {
      for (const nameCase of cases) {
        const trace = newTrace();
        const env = testEnv(database, trace);
        const query = prepareQuery(scope, "asc", {
          eventName: nameCase.eventName,
          page: { limit: 20, cursor: null },
        });
        const legacyDto = await legacyPage(env, query);
        clearTrace(trace);
        const actualDto = (
          await createD1SiteProviderRegistry({ env, siteId: SITE_ID })
            .resolve("event-records")!
            .execute(query)
        ).value;
        nameGateEvidence.push({
          scope,
          case: nameCase.label,
          eventNameInput: nameCase.eventName,
          legacyDto,
          actualDto,
          qualifiedStatementCount: trace.preparedSql.length,
        });
        expect(actualDto).toEqual(legacyDto);
        expect(trace.preparedSql).toHaveLength(2);
      }
    }
  });

  it("falls back safely when public maximum conditions exceed the grouped-summary width", async () => {
    const clauses = Array.from(
      { length: 64 },
      (_, index) =>
        `count(page { page.path eq "/wave95a-budget-${index}" }) eq 1`,
    );
    const filterDsl = clauses.join(" AND ");
    const query = prepareQuery("session", "asc", {
      filterDsl,
      page: { limit: 20, cursor: null },
    });

    const expectedTrace = newTrace();
    const expectedDatabase = createFixture();
    const expected = await legacyPage(
      testEnv(expectedDatabase, expectedTrace),
      query,
    );
    const trace = newTrace();
    const diagnostics = createD1ReadDiagnostics();
    let compileMetrics:
      | {
          readonly sqlBytes: number;
          readonly bindingCount: number;
          readonly sharedRelationCount: number;
          readonly groupWidth: number;
        }
      | undefined;
    diagnostics.onEventRecordsQualificationCompile = (evidence) => {
      compileMetrics = {
        sqlBytes: evidence.sqlBytes,
        bindingCount: evidence.bindingCount,
        sharedRelationCount: evidence.sharedRelationCount,
        groupWidth: evidence.groupWidth,
      };
    };
    const database = createFixture();
    const env = testEnv(database, trace);
    const provider = createD1SiteProviderRegistry({
      env,
      siteId: SITE_ID,
      diagnostics,
    }).resolve("event-records");
    if (!provider) throw new Error("wave95a_event_records_provider_missing");
    const actual = (await provider.execute(query)).value;

    compileBudgetEvidence.push({
      legalConditionCount: clauses.length * 2,
      independentCountClauses: clauses.length,
      filterDslLength: filterDsl.length,
      fallbackReason: diagnostics.advancedCountSqlFallbackReason,
      compileMetrics,
      actualDto: actual,
      legacyDto: expected,
      actualStatementCount: trace.preparedSql.length,
      legacyStatementCount: expectedTrace.preparedSql.length,
    });
    expect(diagnostics.advancedCountSqlFallbackReason).toMatchObject({
      kind: "grouped-summary-unavailable",
      groupWidth: 70,
    });
    expect(actual).toEqual(expected);
    expect(trace.preparedSql).toHaveLength(expectedTrace.preparedSql.length);
  });

  it("keeps empty match pages and fails closed on a deferred binding mismatch", async () => {
    const database = createFixture();
    const trace = newTrace();
    const env = testEnv(database, trace);
    const query = prepareQuery("session", "desc", {
      page: { limit: 10, cursor: null },
    });
    const emptyFilters = parseFilterDsl(
      'count(page { page.path eq "/missing" }) eq 1',
      analyticsFilterRegistry,
    );
    const emptyQuery = {
      ...prepareScopedQuery("event-records", {
        context: siteQueryContext(SITE_ID, "private-dashboard"),
        time: QUERY_TIME,
        filters: emptyFilters,
        scopePreference: "session",
      } as QueryInput & { readonly time: QueryTime }),
      sort: query.sort,
      page: query.page,
    } as RecordsQuery;
    const empty = await createD1SiteProviderRegistry({ env, siteId: SITE_ID })
      .resolve("event-records")!
      .execute(emptyQuery);
    expect(empty.value).toMatchObject({
      items: [],
      pagination: { returned: 0, hasMore: false, nextCursor: null },
    });
    expect(trace.preparedSql).toHaveLength(2);

    const mismatchedTrace = newTrace();
    const mismatchedEnv = testEnv(database, mismatchedTrace);
    const deferredQuery = await d1AdvancedFilterMiddleware(mismatchedEnv)(
      "event-records",
      query,
      async (value) => value,
    );
    const deferred = deferredEventRecordsQualificationFromQuery(deferredQuery);
    if (!deferred)
      throw new Error("wave95a_event_records_mismatch_deferred_missing");
    clearTrace(mismatchedTrace);
    const mismatch = await readSiteEventRecords({
      env: mismatchedEnv,
      siteId: SITE_ID,
      window: timeWindow(query.time),
      filters: query.filters,
      scopePlan: query.scopePlan,
      queryTime: query.time,
      search: query.search,
      eventName: query.eventName,
      sort: { field: "occurredAt", direction: query.sort.direction },
      audience: query.context.policy.audience,
      deferredQualification: deferred,
      page: { ...query.page, limit: query.page.limit + 1 },
    }).catch((error: unknown) => error);
    expect(mismatch).toMatchObject({
      message: "event_records_deferred_request_binding_mismatch",
    });
    expect(mismatchedTrace.preparedSql).toHaveLength(0);
  });

  it("uses one whole-operation legacy fallback for numeric compatibility", async () => {
    const database = createFixture();
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "visit-scoped");
    const trace = newTrace();
    const env = testEnv(database, trace);
    const query = prepareQuery("session", "desc", {
      filterDsl: "count(page { page.durationMs gt 5 }) eq 1",
      page: { limit: 10, cursor: null },
    });
    const expected = await legacyPage(env, query);
    clearTrace(trace);
    const diagnostics = createD1ReadDiagnostics();
    const actual = await createD1SiteProviderRegistry({
      env,
      siteId: SITE_ID,
      diagnostics,
    })
      .resolve("event-records")!
      .execute(query);
    expect(actual.value).toEqual(expected);
    expect(diagnostics.advancedCountSqlFallbackReason).toMatchObject({
      kind: "numeric-data-domain",
    });
    expect(trace.preparedSql.length).toBeGreaterThanOrEqual(4);
    runtimeEvidence.push({
      scenario: "numeric-compatibility-whole-operation-fallback",
      actualDto: actual.value,
      legacyDto: expected,
      fallbackReason: diagnostics.advancedCountSqlFallbackReason,
      statementCount: trace.preparedSql.length,
      statementMetrics: trace.preparedSql.map((sql, index) => ({
        index,
        sqlBytes: new TextEncoder().encode(sql).byteLength,
        sha256: createHash("sha256").update(sql, "utf8").digest("hex"),
        bindingCount: trace.bindings[index]?.length ?? null,
      })),
    });
  });

  it("enforces the real 20001 activity cap before numeric fallback", async () => {
    const database = createFixture();
    const sitePk = Number(
      (
        database
          .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
          .get(SITE_ID) as { readonly site_pk: number }
      ).site_pk,
    );
    database
      .prepare("DELETE FROM custom_events WHERE site_id = ?")
      .run(SITE_ID);
    database.prepare("DELETE FROM visits WHERE site_id = ?").run(SITE_ID);
    database
      .prepare(
        `WITH RECURSIVE generated(n) AS (
           SELECT 1
           UNION ALL SELECT n + 1 FROM generated WHERE n < 20001
         )
         INSERT INTO visits (
           visit_id, site_id, site_pk, visitor_id, session_id, status,
           started_at, last_activity_at, pathname, hostname, duration_ms
         )
         SELECT 'wave95a-cap-activity-' || n, ?, ?,
           'wave95a-cap-visitor', 'wave95a-cap-session', 'closed',
           ?, ?, '/cap-page', 'records.test', 1
         FROM generated`,
      )
      .run(SITE_ID, sitePk, WINDOW.startMs + 500, WINDOW.startMs + 500);
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "wave95a-cap-activity-1");
    const fixtureActivityCount = Number(
      (
        database
          .prepare("SELECT COUNT(*) AS count FROM visits WHERE site_id = ?")
          .get(SITE_ID) as { readonly count: number }
      ).count,
    );
    expect(fixtureActivityCount).toBe(20_001);

    const trace = newTrace();
    const env = testEnv(database, trace);
    const query = prepareQuery("session", "desc", {
      filterDsl: "count(page { page.durationMs gt 5 }) eq 1",
      page: { limit: 10, cursor: null },
    });
    const diagnostics = createD1ReadDiagnostics();
    let compilation:
      | Parameters<
          NonNullable<typeof diagnostics.onEventRecordsQualificationCompile>
        >[0]
      | undefined;
    diagnostics.onEventRecordsQualificationCompile = (evidence) => {
      compilation = evidence;
    };
    let failure: unknown;
    try {
      await createD1SiteProviderRegistry({
        env,
        siteId: SITE_ID,
        diagnostics,
      })
        .resolve("event-records")!
        .execute(query);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      domainError: {
        kind: "invalid-input",
        issues: [{ path: "filters", code: "filter_activity_limit_exceeded" }],
      },
    });
    expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
    expect(compilation).toBeDefined();
    expect(trace.preparedSql).toHaveLength(2);
    expect(trace.preparedSql[1]).toBe(compilation?.sql);
    const rawRows = database
      .prepare(compilation!.sql)
      .all(...(compilation!.bindings as SQLInputValue[])) as Record<
      string,
      unknown
    >[];
    const controls = rawRows.filter((row) => row.rowKind === "control");
    const records = rawRows.filter((row) => row.rowKind === "record");
    expect(controls).toHaveLength(1);
    expect(controls[0]).toMatchObject({
      outputId: "event-summary-qualification-controls",
      entityKind: "session",
      rawCount: 20_001,
    });
    expect(
      Object.entries(controls[0]!).some(
        ([name, value]) =>
          name.toLowerCase().includes("duration") &&
          name.endsWith("Count") &&
          typeof value === "number" &&
          value > 0,
      ),
    ).toBe(true);
    expect(records).toHaveLength(0);
    runtimeEvidence.push({
      scenario: "activity-cap-before-numeric-fallback-session",
      fixtureActivityCount,
      failure: {
        kind: "invalid-input",
        path: "filters",
        code: "filter_activity_limit_exceeded",
      },
      statementCount: trace.preparedSql.length,
      compilation: {
        sqlBytes: compilation!.sqlBytes,
        bindingCount: compilation!.bindingCount,
        graph: compilation!.logicalPlan,
      },
      output: {
        rowCount: rawRows.length,
        controlRowCount: controls.length,
        reportRowCount: records.length,
        control: controls[0],
      },
    });

    const invalidCursorTrace = newTrace();
    const invalidCursorEnv = testEnv(database, invalidCursorTrace);
    const invalidCursorQuery = {
      ...query,
      page: { limit: query.page.limit, cursor: "not-a-signed-cursor" },
    } as RecordsQuery;
    let invalidCursorFailure: unknown;
    try {
      await createD1SiteProviderRegistry({
        env: invalidCursorEnv,
        siteId: SITE_ID,
      })
        .resolve("event-records")!
        .execute(invalidCursorQuery);
    } catch (error) {
      invalidCursorFailure = error;
    }
    expect(invalidCursorFailure).toMatchObject({
      domainError: {
        kind: "invalid-input",
        issues: [{ path: "filters", code: "filter_activity_limit_exceeded" }],
      },
    });
    expect(invalidCursorTrace.preparedSql).toHaveLength(2);
    expect(invalidCursorTrace.preparedSql).not.toContain(compilation!.sql);
    runtimeEvidence.push({
      scenario: "invalid-cursor-retains-cap-first-legacy-preparation-sem088",
      failure: {
        kind: "invalid-input",
        path: "filters",
        code: "filter_activity_limit_exceeded",
      },
      statementCount: invalidCursorTrace.preparedSql.length,
      callKinds: invalidCursorTrace.preparedSql.map((sql) =>
        sql.includes("COUNT(")
          ? "legacy-activity-preparation"
          : "site-coverage",
      ),
    });
  }, 45_000);

  it("keeps payload Count queries outside records deferral", async () => {
    const database = createFixture();
    const trace = newTrace();
    const env = testEnv(database, trace);
    const query = prepareQuery("session", "desc", {
      filterDsl:
        'count(event { event.name eq "purchase" AND event.payload("/value") eq "match" }) gte 1',
    });
    const output = await d1AdvancedFilterMiddleware(env)(
      "event-records",
      query,
      async (value) => value,
    );
    expect(deferredEventRecordsQualificationFromQuery(output)).toBeUndefined();
    expect(trace.preparedSql.length).toBeGreaterThan(0);
  });

  it("does not hide abort, database, or malformed-control failures", async () => {
    const abortDatabase = createFixture();
    const abortTrace = newTrace();
    const abortEnv = testEnv(abortDatabase, abortTrace);
    const abortQuery = prepareQuery("session", "desc");
    const controller = new AbortController();
    controller.abort();
    let abortFailure: unknown;
    try {
      await createD1SiteProviderRegistry({ env: abortEnv, siteId: SITE_ID })
        .resolve("event-records")!
        .execute(abortQuery, { signal: controller.signal });
    } catch (error) {
      abortFailure = error;
    }
    expect(abortFailure).toMatchObject({ name: "AbortError" });
    expect(abortTrace.preparedSql).toHaveLength(0);

    const dbDatabase = createFixture();
    const dbTrace = newTrace();
    const baseEnv = testEnv(dbDatabase, dbTrace);
    const baseBinding = baseEnv.DB;
    const dbFailure = new Error("wave95a_fixture_database_failure");
    let prepareCalls = 0;
    const failingEnv = {
      ...baseEnv,
      DB: {
        prepare(sql: string) {
          prepareCalls += 1;
          if (prepareCalls === 2) throw dbFailure;
          return baseBinding.prepare(sql);
        },
      },
    } as unknown as Env;
    let databaseFailure: unknown;
    try {
      await createD1SiteProviderRegistry({ env: failingEnv, siteId: SITE_ID })
        .resolve("event-records")!
        .execute(prepareQuery("session", "desc"));
    } catch (error) {
      databaseFailure = error;
    }
    expect(databaseFailure).toBe(dbFailure);
    expect(prepareCalls).toBe(2);
    expect(dbTrace.preparedSql).toHaveLength(1);

    const malformedDatabase = createFixture();
    const malformedTrace = newTrace();
    const sqliteBinding = createSqliteD1Database(
      malformedDatabase,
      malformedTrace,
    );
    let statementNumber = 0;
    const malformedEnv = {
      MAIN_SECRET: "wave95a-event-records-runtime-test-secret",
      DB: {
        prepare(sql: string) {
          statementNumber += 1;
          const statement = sqliteBinding.prepare(sql);
          if (statementNumber !== 2) return statement;
          return {
            bind(...values: SQLInputValue[]) {
              malformedTrace.bindings.push(values);
              return {
                async all() {
                  return {
                    success: true,
                    results: [
                      {
                        rowKind: "control",
                        outputId: "event-summary-qualification-controls",
                      },
                    ],
                  };
                },
              };
            },
          };
        },
      },
    } as unknown as Env;
    let malformedFailure: unknown;
    try {
      await createD1SiteProviderRegistry({
        env: malformedEnv,
        siteId: SITE_ID,
      })
        .resolve("event-records")!
        .execute(prepareQuery("session", "desc"));
    } catch (error) {
      malformedFailure = error;
    }
    expect(malformedFailure).toMatchObject({
      message: "event_records_qualification_control_row_invalid",
    });
    expect(malformedTrace.preparedSql).toHaveLength(2);
    runtimeEvidence.push({
      scenario: "abort-database-error-and-malformed-control",
      abort: {
        name: (abortFailure as Error).name,
        statementCount: abortTrace.preparedSql.length,
      },
      databaseError: {
        message: (databaseFailure as Error).message,
        prepareCalls,
      },
      malformedControl: {
        message: (malformedFailure as Error).message,
        statementCount: malformedTrace.preparedSql.length,
        fallbackReason: null,
      },
    });
  });
});
