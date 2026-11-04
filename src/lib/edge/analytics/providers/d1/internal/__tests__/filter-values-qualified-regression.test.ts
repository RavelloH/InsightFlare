import type { DatabaseSync } from "node:sqlite";

import { afterAll, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { createD1SiteProviderRegistry } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import {
  EMPTY_FILTER_DOCUMENT,
  type FilterValuesQuery,
  prepareScopedQuery,
  type QueryInput,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import type { CanonicalDimensionQuery } from "@/lib/edge/analytics/contract/canonical-operation-map";
import { createQueryTime } from "@/lib/edge/analytics/contract/helpers";
import {
  d1AdvancedFilterMiddleware,
  deferredEventQualificationFromQuery,
  deferredPageDimensionQualificationFromQuery,
  prepareDeferredEventQualificationFallback,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { compilePageDimensionQualificationProgram } from "@/lib/edge/analytics/providers/d1/internal/analytics-qualification-program";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import { queryFilterValuesPageFromD1 } from "@/lib/edge/analytics/providers/d1/internal/filter-values";
import { queryFilterValuesPageWithQualification } from "@/lib/edge/analytics/providers/d1/internal/filter-values-qualification-program";
import {
  deferredFilterValuesQualificationFromQuery,
  filterValuesQualificationConfigurationFromQuery,
} from "@/lib/edge/analytics/providers/d1/internal/filter-values-qualification-request";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import { InvalidCursorError } from "@/lib/pagination";

const SITE = "wave97j-filter-values";
const TIME = createQueryTime(120, 130, "UTC", 500);
const FILTER_DSL =
  'page.path neq "/excluded" and count(event { event.name eq "qualifier" }) eq 1';
const DATABASES = new Set<DatabaseSync>();
const currentRouteEvidence: Array<Record<string, unknown>> = [];
const wave97dvEvidence: Array<Record<string, unknown>> = [];

interface TestSite {
  readonly id: string;
  readonly pk: number;
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
       VALUES (?, 'wave97j-team', 'Filter values', 'filter.test', 0)`,
    )
    .run(SITE);
  return { id: SITE, pk: Number(identity.site_pk) };
}

function addVisit(
  database: DatabaseSync,
  site: TestSite,
  input: {
    readonly id: string;
    readonly sessionId: string;
    readonly visitorId: string;
    readonly path: string;
    readonly startedAt: number;
  },
): void {
  database
    .prepare(
      `INSERT INTO visits (
         visit_id, site_id, site_pk, visitor_id, session_id, status,
         started_at, last_activity_at, pathname, hostname, country
       ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, 'filter.test', 'US')`,
    )
    .run(
      input.id,
      site.id,
      site.pk,
      input.visitorId,
      input.sessionId,
      input.startedAt,
      input.startedAt,
      input.path,
    );
}

function createFixture(): {
  readonly database: DatabaseSync;
  readonly site: TestSite;
} {
  const database = createMigratedDatabase();
  DATABASES.add(database);
  database.exec("PRAGMA foreign_keys = OFF");
  const site = addSite(database);
  const visits = [
    {
      id: "visit-1",
      sessionId: "session-1",
      visitorId: "visitor-1",
      path: "/landing",
      startedAt: 125,
    },
    {
      id: "visit-2",
      sessionId: "session-1",
      visitorId: "visitor-1",
      path: "/other",
      startedAt: 126,
    },
    {
      id: "visit-3",
      sessionId: "session-2",
      visitorId: "visitor-1",
      path: "/contact",
      startedAt: 127,
    },
    {
      id: "visit-4",
      sessionId: "session-3",
      visitorId: "visitor-2",
      path: "/pricing",
      startedAt: 128,
    },
  ] as const;
  for (const visit of visits) addVisit(database, site, visit);

  const update = database.prepare(
    "UPDATE visits SET referrer_host = ?, utm_source = ?, utm_medium = ? WHERE visit_id = ?",
  );
  update.run("www.google.com", "", "", "visit-1");
  update.run("facebook.com", "", "", "visit-2");
  update.run("partner.example", "", "", "visit-3");
  update.run("", "google", "cpc", "visit-4");

  database
    .prepare(
      `INSERT INTO custom_event_names (id, site_id, name, last_seen_at, site_pk)
       VALUES (1, ?, 'qualifier', 129, ?)`,
    )
    .run(site.id, site.pk);
  database
    .prepare(
      `INSERT INTO custom_events (
         event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
         received_at, sequence, node_count, value_count
       ) VALUES ('event-1', ?, ?, 'visit-1', 1, 129, 129, 1, 0, 0)`,
    )
    .run(site.id, site.pk);
  return { database, site };
}

function testEnv(
  database: DatabaseSync,
  trace: SqliteD1Trace,
  interceptAll?: (
    sql: string,
    rows: Record<string, unknown>[],
  ) => Record<string, unknown>[],
): Env {
  const sqlite = createSqliteD1Database(database, trace);
  const adapter = interceptAll
    ? ({
        prepare(sql: string) {
          let statement = sqlite.prepare(sql);
          const prepared = {
            bind(...values: Parameters<typeof statement.bind>) {
              statement = statement.bind(...values);
              return prepared;
            },
            first<Row>() {
              return statement.first<Row>();
            },
            async all<Row>() {
              const result = await statement.all<Row>();
              return {
                ...result,
                results: interceptAll(
                  sql,
                  (result.results ?? []) as Record<string, unknown>[],
                ) as Row[],
              };
            },
            run() {
              return statement.run();
            },
          };
          return prepared;
        },
        batch(statements: D1PreparedStatement[]) {
          return sqlite.batch(statements);
        },
      } as unknown as Env["DB"])
    : sqlite;
  return {
    DB: adapter,
    MAIN_SECRET: "wave97j-filter-values-test-secret",
    DAILY_SALT_SECRET: "wave97j-filter-values-daily-secret",
  } as unknown as Env;
}

function queryFor(
  scope: "session" | "visitor",
  field: string,
  options: {
    readonly limit?: number;
    readonly cursor?: string | null;
    readonly search?: string;
    readonly filterDsl?: string;
  } = {},
): FilterValuesQuery {
  const prepared = prepareScopedQuery("filter-values", {
    context: siteQueryContext(SITE, "private-dashboard"),
    time: TIME,
    filters: parseFilterDsl(
      options.filterDsl ?? FILTER_DSL,
      analyticsFilterRegistry,
    ),
    scopePreference: scope,
  } as QueryInput & { readonly time: typeof TIME });
  return {
    ...prepared,
    field,
    ...(options.search !== undefined ? { search: options.search } : {}),
    page: {
      limit: options.limit ?? 1,
      cursor: options.cursor ?? null,
    },
  } as FilterValuesQuery;
}

function dimensionQueryFor(
  scope: "session" | "visitor",
  dimension: string,
): CanonicalDimensionQuery {
  const prepared = prepareScopedQuery("dimension", {
    context: siteQueryContext(SITE, "private-dashboard"),
    time: TIME,
    filters: parseFilterDsl(FILTER_DSL, analyticsFilterRegistry),
    scopePreference: scope,
  } as QueryInput & { readonly time: typeof TIME });
  return {
    ...prepared,
    mode: "breakdown",
    dimension,
    page: { limit: 20, cursor: null },
    sort: { key: "views", direction: "desc" },
    search: "",
  } as unknown as CanonicalDimensionQuery;
}

function resultValue(value: unknown) {
  return value as {
    readonly field: string;
    readonly data: {
      readonly items: readonly {
        readonly value: string;
        readonly label: string;
        readonly occurrences: number;
      }[];
      readonly pagination: {
        readonly limit: number;
        readonly returned: number;
        readonly hasMore: boolean;
        readonly nextCursor: string | null;
      };
    };
  };
}

function traceEvidence(trace: SqliteD1Trace) {
  return trace.preparedSql.map((sql, index) => ({
    sql,
    bindings: trace.bindings[index] ?? [],
  }));
}

function wave97dvStatementClass(sql: string): string {
  if (isFusedFilterValuesPageReport(sql)) return "fact-envelope";
  if (/\bfrom\s+(?:["`]sites["`]|sites)(?:\s|$)/i.test(sql))
    return "site-metadata";
  return "other";
}

function isFusedFilterValuesPageReport(sql: string): boolean {
  return (
    sql.includes("rowKind") &&
    sql.includes("outputId") &&
    sql.includes("dimension-page")
  );
}

function isFusedFilterValuesEventReport(sql: string): boolean {
  return (
    sql.includes("rowKind") &&
    sql.includes("outputId") &&
    sql.includes("event-type-page") &&
    sql.includes("event-summary-qualification-controls")
  );
}

function queryWindowForTest() {
  return {
    startMs: TIME.range.startMs,
    endExclusiveMs: TIME.range.endExclusiveMs,
    nowMs: TIME.capturedAtMs,
    timeZone: TIME.reportingTimeZone,
  };
}

async function legacyOracle(
  database: DatabaseSync,
  scope: "session" | "visitor",
  field: string,
  limit: number,
  search?: string,
  filterDsl = FILTER_DSL,
) {
  const trace = traceFor();
  const env = testEnv(database, trace);
  const query = queryFor(scope, field, {
    limit,
    ...(search !== undefined ? { search } : {}),
    filterDsl,
  });
  const prepared = await d1AdvancedFilterMiddleware(env, undefined, SITE)(
    "filter-values",
    query,
    async (value) => value,
  );
  const deferred = deferredEventQualificationFromQuery(
    prepared,
    "filter-values",
  );
  if (!deferred)
    throw new Error("wave97j_filter_values_legacy_oracle_deferred_missing");
  const filters = await prepareDeferredEventQualificationFallback(deferred);
  return {
    trace,
    page: (cursor?: string | null) =>
      queryFilterValuesPageFromD1(
        env,
        SITE,
        queryWindowForTest(),
        filters,
        field,
        limit,
        cursor,
        search,
        "private-dashboard",
      ),
  };
}

const pageProfiles = (["session", "visitor"] as const).flatMap((scope) =>
  (["page.path", "traffic.channel"] as const).map((field) => ({
    scope,
    field,
  })),
);

afterAll(async () => {
  for (const database of DATABASES) database.close();
  const artifactDir = process.env.WAVE97J_ARTIFACT_DIR;
  if (process.env.WAVE97J_CAPTURE_CURRENT_AFTER === "1" && artifactDir) {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(artifactDir, { recursive: true });
    await writeFile(
      `${artifactDir}/filter-values-qualified-current.json`,
      JSON.stringify(
        {
          source:
            "actual filter-values provider execution after Wave97J routing",
          evidence: currentRouteEvidence,
        },
        null,
        2,
      ),
      "utf8",
    );
  }
  const wave97dvDirectory = process.env.WAVE97DV_ARTIFACT_DIR;
  if (wave97dvDirectory && wave97dvEvidence.length > 0) {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(wave97dvDirectory, { recursive: true });
    await writeFile(
      `${wave97dvDirectory}/filter-values-page-whole-boolean.json`,
      JSON.stringify(
        { wave: "97DV", reportKind: "page", evidence: wave97dvEvidence },
        null,
        2,
      ),
      "utf8",
    );
  }
});

describe("filter-values Page qualification baseline and route", () => {
  it("97DV preserves whole OR/NOT ownership for the Page report", async () => {
    const filterDsl =
      'page.path eq "/pricing" or not (count(event { event.name eq "qualifier" }) eq 0)';
    const wrongAndDsl =
      'page.path eq "/pricing" and not (count(event { event.name eq "qualifier" }) eq 0)';

    const fixture = createFixture();
    const query = queryFor("session", "page.path", {
      limit: 10,
      filterDsl,
    });
    const trace = traceFor();
    const diagnostics = createD1ReadDiagnostics();
    const provider = createD1SiteProviderRegistry({
      env: testEnv(fixture.database, trace),
      siteId: SITE,
      diagnostics,
    }).resolve("filter-values");
    if (!provider) throw new Error("wave97dv_filter_values_provider_missing");
    const actualResult = await provider.execute(query);
    const actual = resultValue(actualResult.value);

    const oracleFixture = createFixture();
    const oracle = await legacyOracle(
      oracleFixture.database,
      "session",
      "page.path",
      10,
      undefined,
      filterDsl,
    );
    const expected = await oracle.page(null);
    const legacyDto = {
      field: "page.path",
      data: {
        items: expected.items.map((row) => ({
          value: row.value,
          label: row.value,
          occurrences: row.occurrences,
        })),
        pagination: expected.pagination,
      },
    };
    const wrongAndOracle = await legacyOracle(
      createFixture().database,
      "session",
      "page.path",
      10,
      undefined,
      wrongAndDsl,
    );
    const wrongAnd = await wrongAndOracle.page(null);
    const factStatements = trace.preparedSql.filter(
      isFusedFilterValuesPageReport,
    );
    const statementClasses = trace.preparedSql.map(wave97dvStatementClass);

    wave97dvEvidence.push({
      contract: "page-session-whole-or-not",
      filterDsl,
      countOnlyOwner: "session-1 (qualifier event; no /pricing page)",
      nativeOnlyOwner: "session-3 (/pricing page; no qualifier event)",
      actualResult,
      actualDto: actual,
      legacyDto,
      wrongAndDto: wrongAnd,
      compiledFactEnvelopeHits: factStatements.length,
      statementClasses,
      statements: traceEvidence(trace),
      legacyStatements: traceEvidence(oracle.trace),
      fallbackDiagnostics: diagnostics,
    });

    expect(actual).toEqual(legacyDto);
    expect(actual.data.items.map((row) => row.value)).toEqual(
      expect.arrayContaining(["/landing", "/pricing"]),
    );
    expect(actual.data.items).not.toEqual(
      wrongAnd.items.map((row) => ({
        value: row.value,
        label: row.value,
        occurrences: row.occurrences,
      })),
    );
    expect(factStatements).toHaveLength(1);
    expect(statementClasses).not.toContain("other");
    expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
  });

  it("97DV keeps split-only AND as default and rejects a changed branded request", async () => {
    const middlewareFixture = createFixture();
    const middlewareTrace = traceFor();
    const middlewareEnv = testEnv(middlewareFixture.database, middlewareTrace);
    const prepared = await d1AdvancedFilterMiddleware(
      middlewareEnv,
      undefined,
      SITE,
    )(
      "filter-values",
      queryFor("session", "page.path", { limit: 10 }),
      async (value) => value,
    );
    const branded = deferredFilterValuesQualificationFromQuery(prepared);
    if (!branded)
      throw new Error("wave97dv_filter_values_default_request_missing");
    expect(branded.filterMode).toBe("split-only");

    const tampered = prepared as Record<string, unknown>;
    tampered.search = "changed after qualification";
    await expect(
      queryFilterValuesPageWithQualification({
        env: middlewareEnv,
        query: prepared,
        request: branded,
      }),
    ).rejects.toThrow("filter_values_qualification_request_changed");

    const fixture = createFixture();
    const trace = traceFor();
    const diagnostics = createD1ReadDiagnostics();
    const provider = createD1SiteProviderRegistry({
      env: testEnv(fixture.database, trace),
      siteId: SITE,
      diagnostics,
    }).resolve("filter-values");
    if (!provider) throw new Error("wave97dv_filter_values_provider_missing");
    const actual = resultValue(
      (await provider.execute(queryFor("session", "page.path", { limit: 10 })))
        .value,
    );
    expect(actual.data.items.map((row) => row.value)).toEqual(
      expect.arrayContaining(["/landing", "/other"]),
    );
    expect(
      trace.preparedSql.filter(isFusedFilterValuesPageReport),
    ).toHaveLength(1);
    expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
  });

  it("97DV preserves the whole Boolean DTO on a numeric-domain Count fallback", async () => {
    const filterDsl =
      '(page.path eq "/pricing" or not (count(event { event.name eq "qualifier" }) eq 0)) and count(page { page.durationMs gt 5 }) eq 1';
    const { database } = createFixture();
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run(10, "visit-1");
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "visit-2");
    const trace = traceFor();
    const diagnostics = createD1ReadDiagnostics();
    const capturedFusedRows: Record<string, unknown>[][] = [];
    const provider = createD1SiteProviderRegistry({
      env: testEnv(database, trace, (sql, rows) => {
        if (isFusedFilterValuesPageReport(sql)) capturedFusedRows.push(rows);
        return rows;
      }),
      siteId: SITE,
      diagnostics,
    }).resolve("filter-values");
    if (!provider) throw new Error("wave97dv_filter_values_provider_missing");
    const actualResult = await provider.execute(
      queryFor("session", "page.path", { limit: 10, filterDsl }),
    );
    const actual = resultValue(actualResult.value);

    const oracleFixture = createFixture();
    oracleFixture.database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run(10, "visit-1");
    oracleFixture.database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "visit-2");
    const oracle = await legacyOracle(
      oracleFixture.database,
      "session",
      "page.path",
      10,
      undefined,
      filterDsl,
    );
    const expected = await oracle.page(null);
    const legacyDto = {
      field: "page.path",
      data: {
        items: expected.items.map((row) => ({
          value: row.value,
          label: row.value,
          occurrences: row.occurrences,
        })),
        pagination: expected.pagination,
      },
    };
    const factStatements = trace.preparedSql.filter(
      isFusedFilterValuesPageReport,
    );
    wave97dvEvidence.push({
      contract: "page-whole-or-not-numeric-domain-fallback",
      filterDsl,
      actualResult,
      actualDto: actual,
      legacyDto,
      compiledFactEnvelopeHits: factStatements.length,
      fusedRows: capturedFusedRows[0],
      statements: traceEvidence(trace),
      legacyStatements: traceEvidence(oracle.trace),
      fallbackDiagnostics: diagnostics,
    });
    expect(actual).toEqual(legacyDto);
    expect(diagnostics.advancedCountSqlFallbackReason).toMatchObject({
      kind: "numeric-data-domain",
    });
    expect(factStatements).toHaveLength(1);
    expect(capturedFusedRows).toHaveLength(1);
    expect(
      capturedFusedRows[0]!.filter((row) => row.rowKind === "report"),
    ).toHaveLength(0);
  });

  it.each(pageProfiles)(
    "preflights the real qualified Page report budget for $scope/$field",
    async ({ scope, field }) => {
      const { database } = createFixture();
      const compileTrace = traceFor();
      const env = testEnv(database, compileTrace);
      const query = dimensionQueryFor(scope, field);
      const forwarded = await d1AdvancedFilterMiddleware(env, undefined, SITE)(
        "dimension",
        query,
        async (prepared) => prepared,
      );
      const deferred = deferredPageDimensionQualificationFromQuery(forwarded);
      if (!deferred)
        throw new Error("wave97j_page_dimension_preflight_missing");
      const request = deferred.pageDimensionRequest;
      const compiled = compilePageDimensionQualificationProgram({
        deferred,
        query: {
          siteId: SITE,
          queryTime: query.time!,
          filters: query.filters!,
          ...(query.scopePlan ? { scopePlan: query.scopePlan } : {}),
          dimension: request.dimension,
          selection: request.selection,
          limit: request.limit,
          cursor: null,
          cursorToken: request.cursorText,
          ...(request.search !== undefined ? { search: request.search } : {}),
          sortBy: request.sortBy,
          sortDirection: request.sortDirection,
          excludeEmpty: false,
          audience: request.audience,
        },
      });
      expect(compiled.kind).toBe("compiled");
      if (compiled.kind !== "compiled")
        throw new Error("wave97j_page_dimension_preflight_unavailable");

      const trace = traceFor();
      const diagnostics = createD1ReadDiagnostics();
      const provider = createD1SiteProviderRegistry({
        env: testEnv(database, trace),
        siteId: SITE,
        diagnostics,
      }).resolve("dimension");
      if (!provider) throw new Error("wave97j_dimension_provider_missing");
      await provider.execute(query);
      expect(trace.preparedSql).toContain(compiled.evidence.sql);
      expect(
        trace.preparedSql.filter((sql) => sql === compiled.evidence.sql),
      ).toHaveLength(1);
      expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
      expect(compiled.evidence.sqlBytes).toBeLessThan(100_000);
      expect(compiled.evidence.bindingCount).toBeLessThanOrEqual(100);

      currentRouteEvidence.push({
        case: `budget-preflight/${scope}/${field}`,
        source:
          "existing qualified Page dimension operation used for the budget preflight",
        sqlBytes: compiled.evidence.sqlBytes,
        bindingCount: compiled.evidence.bindingCount,
        rootKind: compiled.evidence.rootKind,
        physicalScanKinds: compiled.evidence.physicalScanKinds,
        sharedRelationCount: compiled.evidence.sharedRelationCount,
        groupWidth: compiled.evidence.groupWidth,
        reportStatementCount: 1,
        statements: traceEvidence(trace),
      });
    },
  );

  it.each(pageProfiles)(
    "keeps first/next Page DTO and cursor compatibility for $scope/$field",
    async ({ scope, field }) => {
      const { database } = createFixture();
      const trace = traceFor();
      const provider = createD1SiteProviderRegistry({
        env: testEnv(database, trace),
        siteId: SITE,
      }).resolve("filter-values");
      if (!provider) throw new Error("wave97j_filter_values_provider_missing");

      const firstQuery = queryFor(scope, field, { limit: 1 });
      const firstResult = resultValue(
        (await provider.execute(firstQuery)).value,
      );
      const legacy = await legacyOracle(
        createFixture().database,
        scope,
        field,
        1,
      );
      const legacyFirst = await legacy.page(null);
      expect(firstResult.data.pagination.limit).toBe(1);
      expect(firstResult.data.items).toHaveLength(1);
      expect(firstResult.data.pagination.hasMore).toBe(true);
      expect(firstResult.data.items).toEqual(
        legacyFirst.items.map((row) => ({
          value: row.value,
          label: row.value,
          occurrences: row.occurrences,
        })),
      );
      expect(firstResult.data.pagination).toEqual(legacyFirst.pagination);
      const nextCursor = firstResult.data.pagination.nextCursor;
      expect(nextCursor).toEqual(expect.any(String));
      const legacyNext = await legacy.page(legacyFirst.pagination.nextCursor);
      const nextResult = resultValue(
        (
          await provider.execute(
            queryFor(scope, field, { limit: 1, cursor: nextCursor }),
          )
        ).value,
      );
      expect(nextResult.data.items).toHaveLength(1);
      expect(nextResult.data.items[0]?.value).not.toBe(
        firstResult.data.items[0]?.value,
      );
      expect(nextResult.data.items).toEqual(
        legacyNext.items.map((row) => ({
          value: row.value,
          label: row.value,
          occurrences: row.occurrences,
        })),
      );
      expect(nextResult.data.pagination).toEqual(legacyNext.pagination);
      const fusedReports = trace.preparedSql.filter(
        isFusedFilterValuesPageReport,
      );
      expect(fusedReports).toHaveLength(2);
      expect(fusedReports.every((sql) => sql.includes("rowKind"))).toBe(true);
      expect(trace.preparedSql).toHaveLength(4);

      currentRouteEvidence.push({
        case: `${scope}/${field}`,
        source: "actual filter-values provider execution after Wave97J routing",
        firstPage: firstResult,
        nextPage: nextResult,
        firstCursor: nextCursor,
        legacyStatementCount: legacy.trace.preparedSql.length,
        legacyStatements: traceEvidence(legacy.trace),
        statementCount: trace.preparedSql.length,
        fusedReportCount: fusedReports.length,
        statements: traceEvidence(trace),
      });
    },
  );

  it.each(["page.path", "traffic.channel"] as const)(
    "accepts legacy cursors and returns new cursors to the legacy reader for visitor/%s",
    async (field) => {
      const { database } = createFixture();
      const routeTrace = traceFor();
      const provider = createD1SiteProviderRegistry({
        env: testEnv(database, routeTrace),
        siteId: SITE,
      }).resolve("filter-values");
      if (!provider) throw new Error("wave97j_filter_values_provider_missing");
      const oracle = await legacyOracle(
        createFixture().database,
        "visitor",
        field,
        1,
      );

      const legacyFirst = await oracle.page(null);
      expect(legacyFirst.pagination.nextCursor).toEqual(expect.any(String));
      const newSecond = resultValue(
        (
          await provider.execute(
            queryFor("visitor", field, {
              limit: 1,
              cursor: legacyFirst.pagination.nextCursor,
            }),
          )
        ).value,
      );
      const oldSecond = await oracle.page(legacyFirst.pagination.nextCursor);
      expect(newSecond.data.items).toEqual(
        oldSecond.items.map((row) => ({
          value: row.value,
          label: row.value,
          occurrences: row.occurrences,
        })),
      );
      expect(newSecond.data.pagination).toEqual(oldSecond.pagination);
      expect(newSecond.data.pagination.nextCursor).toEqual(expect.any(String));
      const legacyThird = await oracle.page(
        newSecond.data.pagination.nextCursor,
      );
      expect(legacyThird.pagination.hasMore).toBe(false);
      expect(legacyThird.items.length).toBeGreaterThan(0);
      expect(
        routeTrace.preparedSql.filter(isFusedFilterValuesPageReport),
      ).toHaveLength(1);
      currentRouteEvidence.push({
        case: `cursor-interoperability/visitor/${field}`,
        legacyFirst,
        newSecond,
        legacyThird,
        legacyStatementCount: oracle.trace.preparedSql.length,
        legacyStatements: traceEvidence(oracle.trace),
        routeStatements: traceEvidence(routeTrace),
      });
    },
  );

  it("derives decoded cursor and window only from the branded request", async () => {
    const { database } = createFixture();
    const oracle = await legacyOracle(database, "visitor", "page.path", 1);
    const legacyFirst = await oracle.page(null);
    const expected = await oracle.page(legacyFirst.pagination.nextCursor);
    const trace = traceFor();
    const env = testEnv(database, trace);
    const query = queryFor("visitor", "page.path", {
      limit: 1,
      cursor: legacyFirst.pagination.nextCursor,
    });
    const prepared = await d1AdvancedFilterMiddleware(env, undefined, SITE)(
      "filter-values",
      query,
      async (value) => value,
    );
    const request = deferredFilterValuesQualificationFromQuery(prepared);
    if (!request)
      throw new Error("wave97j_filter_values_request_brand_missing");

    const forgedExecutionOverrides = {
      env,
      query: prepared,
      request,
      cursor: null,
      window: {
        startMs: 0,
        endExclusiveMs: 1,
        nowMs: 1,
        timeZone: "UTC",
      },
    } as unknown as Parameters<
      typeof queryFilterValuesPageWithQualification
    >[0];
    const actual = await queryFilterValuesPageWithQualification(
      forgedExecutionOverrides,
    );

    expect(actual).toEqual(expected);
    expect(actual.items).not.toEqual(legacyFirst.items);
    expect(trace.preparedSql).toHaveLength(2);
    expect(
      trace.preparedSql.filter(isFusedFilterValuesPageReport),
    ).toHaveLength(1);
    currentRouteEvidence.push({
      case: "branded-cursor-window-overrides-ignored",
      legacyCursor: legacyFirst.pagination.nextCursor,
      injectedCursor: null,
      injectedWindow: {
        startMs: 0,
        endExclusiveMs: 1,
        nowMs: 1,
        timeZone: "UTC",
      },
      actual,
      expected,
      statements: traceEvidence(trace),
    });
  });

  it("preserves the post-page Unicode whitespace filter and pagination sentinel", async () => {
    const { database } = createFixture();
    database
      .prepare("UPDATE visits SET pathname = ? WHERE visit_id = ?")
      .run("\u00a0", "visit-2");
    const oracleFixture = createFixture();
    oracleFixture.database
      .prepare("UPDATE visits SET pathname = ? WHERE visit_id = ?")
      .run("\u00a0", "visit-2");
    const routeTrace = traceFor();
    const provider = createD1SiteProviderRegistry({
      env: testEnv(database, routeTrace),
      siteId: SITE,
    }).resolve("filter-values");
    if (!provider) throw new Error("wave97j_filter_values_provider_missing");
    const oracle = await legacyOracle(
      oracleFixture.database,
      "session",
      "page.path",
      1,
    );
    const oldFirst = await oracle.page(null);
    const first = resultValue(
      (await provider.execute(queryFor("session", "page.path", { limit: 1 })))
        .value,
    );
    expect(first.data.pagination).toEqual(oldFirst.pagination);
    expect(first.data.pagination.hasMore).toBe(true);
    const oldLast = await oracle.page(oldFirst.pagination.nextCursor);
    const last = resultValue(
      (
        await provider.execute(
          queryFor("session", "page.path", {
            limit: 1,
            cursor: oldFirst.pagination.nextCursor,
          }),
        )
      ).value,
    );
    expect(last.data.items).toEqual([]);
    expect(last.data.pagination.returned).toBe(1);
    expect(last.data.pagination.hasMore).toBe(false);
    expect(last.data.pagination).toEqual(oldLast.pagination);
    expect(last.data.items).toEqual(
      oldLast.items.map((row) => ({
        value: row.value,
        label: row.value,
        occurrences: row.occurrences,
      })),
    );
    currentRouteEvidence.push({
      case: "post-page-unicode-whitespace",
      first,
      oldLast,
      last,
      legacyStatementCount: oracle.trace.preparedSql.length,
      legacyStatements: traceEvidence(oracle.trace),
      statements: traceEvidence(routeTrace),
    });
  });

  it("keeps distinct raw groups that trim to the same filter value", async () => {
    const { database } = createFixture();
    database
      .prepare("UPDATE visits SET pathname = ? WHERE visit_id = ?")
      .run("\u00a0/landing\u00a0", "visit-2");
    const oracleFixture = createFixture();
    oracleFixture.database
      .prepare("UPDATE visits SET pathname = ? WHERE visit_id = ?")
      .run("\u00a0/landing\u00a0", "visit-2");
    const trace = traceFor();
    const provider = createD1SiteProviderRegistry({
      env: testEnv(database, trace),
      siteId: SITE,
    }).resolve("filter-values");
    if (!provider) throw new Error("wave97j_filter_values_provider_missing");
    const oracle = await legacyOracle(
      oracleFixture.database,
      "visitor",
      "page.path",
      10,
    );
    const expected = await oracle.page(null);
    const actual = resultValue(
      (await provider.execute(queryFor("visitor", "page.path", { limit: 10 })))
        .value,
    );
    expect(actual.data.items).toEqual(
      expected.items.map((row) => ({
        value: row.value,
        label: row.value,
        occurrences: row.occurrences,
      })),
    );
    expect(
      actual.data.items.filter((row) => row.value === "/landing"),
    ).toHaveLength(2);
    expect(actual.data.pagination).toEqual(expected.pagination);
    expect(
      trace.preparedSql.filter(isFusedFilterValuesPageReport),
    ).toHaveLength(1);
    currentRouteEvidence.push({
      case: "distinct-raw-values-same-trimmed-label",
      expected,
      actual,
      statementCount: trace.preparedSql.length,
      statements: traceEvidence(trace),
    });
  });

  it("uses one whole-operation legacy fallback for a real TEXT numeric guard", async () => {
    const numericDsl = `${FILTER_DSL} and count(page { page.durationMs gt 5 }) eq 1`;
    const { database } = createFixture();
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run(10, "visit-1");
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "visit-2");
    const capturedFusedRows: Record<string, unknown>[][] = [];
    const trace = traceFor();
    const diagnostics = createD1ReadDiagnostics();
    const env = testEnv(database, trace, (sql, rows) => {
      if (isFusedFilterValuesPageReport(sql)) capturedFusedRows.push(rows);
      return rows;
    });
    const provider = createD1SiteProviderRegistry({
      env,
      siteId: SITE,
      diagnostics,
    }).resolve("filter-values");
    if (!provider) throw new Error("wave97j_filter_values_provider_missing");

    const oracleFixture = createFixture();
    oracleFixture.database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run(10, "visit-1");
    oracleFixture.database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "visit-2");
    const oracle = await legacyOracle(
      oracleFixture.database,
      "session",
      "page.path",
      10,
      undefined,
      numericDsl,
    );
    const expected = await oracle.page(null);
    const actual = resultValue(
      (
        await provider.execute(
          queryFor("session", "page.path", {
            limit: 10,
            filterDsl: numericDsl,
          }),
        )
      ).value,
    );
    expect(actual.data.items).toEqual(
      expected.items.map((row) => ({
        value: row.value,
        label: row.value,
        occurrences: row.occurrences,
      })),
    );
    expect(actual.data.pagination).toEqual(expected.pagination);
    expect(diagnostics.advancedCountSqlFallbackReason).toMatchObject({
      kind: "numeric-data-domain",
    });
    expect(capturedFusedRows).toHaveLength(1);
    expect(
      capturedFusedRows[0]!.filter((row) => row.rowKind === "report"),
    ).toHaveLength(0);
    expect(
      trace.preparedSql.filter(isFusedFilterValuesPageReport),
    ).toHaveLength(1);
    currentRouteEvidence.push({
      case: "numeric-text-whole-legacy-fallback",
      actual,
      expected,
      fallbackReason: diagnostics.advancedCountSqlFallbackReason,
      fusedReportRows: capturedFusedRows[0],
      legacyStatementCount: oracle.trace.preparedSql.length,
      legacyStatements: traceEvidence(oracle.trace),
      statements: traceEvidence(trace),
    });
  });

  it("checks Count cap before an invalid cursor and does not retry D1 errors", async () => {
    const { database } = createFixture();
    const validTrace = traceFor();
    const validProvider = createD1SiteProviderRegistry({
      env: testEnv(database, validTrace),
      siteId: SITE,
    }).resolve("filter-values");
    if (!validProvider)
      throw new Error("wave97j_filter_values_provider_missing");
    await expect(
      validProvider.execute(
        queryFor("session", "page.path", {
          limit: 1,
          cursor: "malformed-cursor",
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidCursorError);
    expect(validTrace.preparedSql).toHaveLength(2);
    expect(
      validTrace.preparedSql.filter(isFusedFilterValuesPageReport),
    ).toHaveLength(1);

    const trace = traceFor();
    const env = testEnv(database, trace, (sql, rows) => {
      if (!isFusedFilterValuesPageReport(sql)) return rows;
      const controls = rows.filter((row) => row.rowKind === "control");
      return controls.map((row) => ({ ...row, rawCount: 20_001 }));
    });
    const provider = createD1SiteProviderRegistry({
      env,
      siteId: SITE,
    }).resolve("filter-values");
    if (!provider) throw new Error("wave97j_filter_values_provider_missing");
    await expect(
      provider.execute(
        queryFor("session", "page.path", {
          limit: 1,
          cursor: "malformed-cursor",
        }),
      ),
    ).rejects.toMatchObject({
      domainError: {
        kind: "invalid-input",
        issues: [{ path: "filters", code: "filter_activity_limit_exceeded" }],
      },
    });
    expect(trace.preparedSql).toHaveLength(2);
    expect(
      trace.preparedSql.filter(isFusedFilterValuesPageReport),
    ).toHaveLength(1);

    const failure = new Error("wave97j_injected_d1_failure");
    const failingTrace = traceFor();
    const failingProvider = createD1SiteProviderRegistry({
      env: testEnv(database, failingTrace, (sql, rows) => {
        if (isFusedFilterValuesPageReport(sql)) throw failure;
        return rows;
      }),
      siteId: SITE,
    }).resolve("filter-values");
    if (!failingProvider)
      throw new Error("wave97j_filter_values_provider_missing");
    await expect(
      failingProvider.execute(queryFor("session", "page.path", { limit: 2 })),
    ).rejects.toBe(failure);
    expect(failingTrace.preparedSql).toHaveLength(2);
    expect(
      failingTrace.preparedSql.filter(isFusedFilterValuesPageReport),
    ).toHaveLength(1);
  });

  it.each([
    "missing-control",
    "repeated-control",
    "unknown-output",
    "invalid-control-scalar",
    "gate-leak",
  ] as const)(
    "rejects the %s fused response without falling back",
    async (kind) => {
      const { database } = createFixture();
      database
        .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
        .run(10, "visit-1");
      const numericDsl = `${FILTER_DSL} and count(page { page.durationMs gt 5 }) eq 1`;
      const trace = traceFor();
      const env = testEnv(database, trace, (sql, rows) => {
        if (!isFusedFilterValuesPageReport(sql)) return rows;
        const controls = rows.filter((row) => row.rowKind === "control");
        const reports = rows.filter((row) => row.rowKind === "report");
        const control = controls[0];
        if (!control) return rows;
        if (kind === "missing-control") return reports;
        if (kind === "repeated-control") return [...rows, control];
        if (kind === "unknown-output")
          return rows.map((row) =>
            row.rowKind === "report"
              ? { ...row, outputId: "unknown-output" }
              : row,
          );
        if (kind === "invalid-control-scalar")
          return rows.map((row) =>
            row.rowKind === "control" ? { ...row, rawCount: "opaque" } : row,
          );
        const durationControl = Object.keys(control).find((name) =>
          name.toLowerCase().includes("duration"),
        );
        if (!durationControl)
          throw new Error("wave97j_numeric_control_field_missing");
        return rows.map((row) =>
          row.rowKind === "control" ? { ...row, [durationControl]: 1 } : row,
        );
      });
      const provider = createD1SiteProviderRegistry({
        env,
        siteId: SITE,
      }).resolve("filter-values");
      if (!provider) throw new Error("wave97j_filter_values_provider_missing");
      const expectedMessage =
        kind === "missing-control" || kind === "repeated-control"
          ? "filter_values_qualification_control_row_invalid"
          : kind === "unknown-output"
            ? "filter_values_qualification_report_row_invalid"
            : kind === "invalid-control-scalar"
              ? "filter_values_qualification_control_invalid:rawCount"
              : "filter_values_qualification_gate_violation";
      await expect(
        provider.execute(
          queryFor("session", "page.path", {
            limit: 10,
            filterDsl: numericDsl,
          }),
        ),
      ).rejects.toThrow(expectedMessage);
      expect(trace.preparedSql).toHaveLength(2);
      expect(
        trace.preparedSql.filter(isFusedFilterValuesPageReport),
      ).toHaveLength(1);
    },
  );

  it("rejects malformed report values and counts without retrying", async () => {
    const { database } = createFixture();
    const corruptions: readonly {
      readonly field: string;
      readonly value: unknown;
      readonly message: string;
    }[] = [
      {
        field: "value",
        value: 7,
        message: "filter_values_qualification_report_value_invalid",
      },
      {
        field: "views",
        value: "1",
        message: "filter_values_qualification_report_views_invalid",
      },
      {
        field: "sessions",
        value: Number.NaN,
        message: "filter_values_qualification_report_sessions_invalid",
      },
      {
        field: "visitors",
        value: -1,
        message: "filter_values_qualification_report_visitors_invalid",
      },
      {
        field: "views",
        value: 1.5,
        message: "filter_values_qualification_report_views_invalid",
      },
      {
        field: "views",
        value: Number.MAX_SAFE_INTEGER + 1,
        message: "filter_values_qualification_report_views_invalid",
      },
      {
        field: "views",
        value: 0,
        message: "filter_values_qualification_report_views_invalid",
      },
    ];
    for (const corruption of corruptions) {
      const trace = traceFor();
      const provider = createD1SiteProviderRegistry({
        env: testEnv(database, trace, (sql, rows) => {
          if (!isFusedFilterValuesPageReport(sql)) return rows;
          return rows.map((row) =>
            row.rowKind === "report"
              ? { ...row, [corruption.field]: corruption.value }
              : row,
          );
        }),
        siteId: SITE,
      }).resolve("filter-values");
      if (!provider) throw new Error("wave97j_filter_values_provider_missing");
      await expect(
        provider.execute(queryFor("session", "page.path", { limit: 10 })),
      ).rejects.toThrow(corruption.message);
      expect(trace.preparedSql).toHaveLength(2);
      expect(
        trace.preparedSql.filter(isFusedFilterValuesPageReport),
      ).toHaveLength(1);
    }
  });

  it("rejects only repeated exact raw report values", async () => {
    const { database } = createFixture();
    const trace = traceFor();
    const provider = createD1SiteProviderRegistry({
      env: testEnv(database, trace, (sql, rows) => {
        if (!isFusedFilterValuesPageReport(sql)) return rows;
        const first = rows.find((row) => row.rowKind === "report");
        if (!first)
          throw new Error("wave97j_report_row_missing_for_duplicate_test");
        return [...rows, { ...first }];
      }),
      siteId: SITE,
    }).resolve("filter-values");
    if (!provider) throw new Error("wave97j_filter_values_provider_missing");
    await expect(
      provider.execute(queryFor("session", "page.path", { limit: 10 })),
    ).rejects.toThrow("filter_values_qualification_report_value_repeated");
    expect(trace.preparedSql).toHaveLength(2);
    expect(
      trace.preparedSql.filter(isFusedFilterValuesPageReport),
    ).toHaveLength(1);
  });

  it("preserves Page and Event search through their qualified report paths", async () => {
    for (const [field, search] of [
      ["page.path", "LAND"],
      ["event.name", "qual"],
    ] as const) {
      const { database } = createFixture();
      const trace = traceFor();
      const provider = createD1SiteProviderRegistry({
        env: testEnv(database, trace),
        siteId: SITE,
      }).resolve("filter-values");
      if (!provider) throw new Error("wave97j_filter_values_provider_missing");
      const result = resultValue(
        (
          await provider.execute(
            queryFor("session", field, { limit: 5, search }),
          )
        ).value,
      );
      expect(result.field).toBe(field);
      expect(result.data.pagination.limit).toBe(5);
      if (field === "page.path")
        expect(result.data.items.map(({ value }) => value)).toContain(
          "/landing",
        );
      else
        expect(result.data.items.map(({ value }) => value)).toContain(
          "qualifier",
        );
      const fusedReports = trace.preparedSql.filter(
        isFusedFilterValuesPageReport,
      );
      expect(fusedReports).toHaveLength(field === "page.path" ? 1 : 0);
      expect(
        trace.preparedSql.filter(isFusedFilterValuesEventReport),
      ).toHaveLength(field === "event.name" ? 1 : 0);
      currentRouteEvidence.push({
        case: `session/${field}/search`,
        search,
        result,
        statementCount: trace.preparedSql.length,
        statements: traceEvidence(trace),
      });
    }
  });

  it("keeps no-advanced and special-field requests on their original readers", async () => {
    const { database } = createFixture();
    const trace = traceFor();
    const provider = createD1SiteProviderRegistry({
      env: testEnv(database, trace),
      siteId: SITE,
    }).resolve("filter-values");
    if (!provider) throw new Error("wave97j_filter_values_provider_missing");
    const prepared = prepareScopedQuery("filter-values", {
      context: siteQueryContext(SITE, "private-dashboard"),
      time: TIME,
      filters: EMPTY_FILTER_DOCUMENT,
      scopePreference: "session",
    } as QueryInput & { readonly time: typeof TIME });
    const noAdvanced = {
      ...prepared,
      field: "page.path",
      page: { limit: 10, cursor: null },
    } as FilterValuesQuery;
    await provider.execute(noAdvanced);
    expect(trace.preparedSql.some(isFusedFilterValuesPageReport)).toBe(false);

    for (const field of [
      "referrer.domain",
      "referrer.url",
      "session.entryPath",
      "session.exitPath",
    ]) {
      const { database: specialDatabase } = createFixture();
      const specialTrace = traceFor();
      const specialProvider = createD1SiteProviderRegistry({
        env: testEnv(specialDatabase, specialTrace),
        siteId: SITE,
      }).resolve("filter-values");
      if (!specialProvider)
        throw new Error("wave97j_filter_values_provider_missing");
      const result = resultValue(
        (
          await specialProvider.execute(
            queryFor("session", field, { limit: 5 }),
          )
        ).value,
      );
      expect(result.field).toBe(field);
      expect(specialTrace.preparedSql.some(isFusedFilterValuesPageReport)).toBe(
        false,
      );
    }
    const publicQuery = {
      ...queryFor("session", "page.path"),
      context: siteQueryContext(SITE, "public-share"),
    } as FilterValuesQuery;
    expect(
      filterValuesQualificationConfigurationFromQuery(publicQuery),
    ).toBeUndefined();
  });

  it("rejects cloned or changed requests without evaluating accessors", async () => {
    let searchGetterReads = 0;
    let toJsonGetterReads = 0;
    const accessorQuery = {
      ...queryFor("session", "page.path"),
    } as Record<string, unknown>;
    Object.defineProperty(accessorQuery, "search", {
      enumerable: true,
      get() {
        searchGetterReads += 1;
        throw new Error("search getter must not run");
      },
    });
    Object.defineProperty(accessorQuery, "toJSON", {
      enumerable: true,
      get() {
        toJsonGetterReads += 1;
        throw new Error("toJSON getter must not run");
      },
    });
    expect(
      filterValuesQualificationConfigurationFromQuery(accessorQuery),
    ).toBeUndefined();
    expect(searchGetterReads).toBe(0);
    expect(toJsonGetterReads).toBe(0);

    const { database } = createFixture();
    const trace = traceFor();
    const env = testEnv(database, trace);
    const middleware = d1AdvancedFilterMiddleware(env, undefined, SITE);
    const query = queryFor("session", "page.path", { limit: 2 });
    const prepared = await middleware(
      "filter-values",
      query,
      async (value) => value,
    );
    const request = deferredEventQualificationFromQuery(
      prepared,
      "filter-values",
    );
    const branded = deferredFilterValuesQualificationFromQuery(prepared);
    if (!request || !branded)
      throw new Error("wave97j_filter_values_request_brand_missing");
    const clone = { ...(prepared as Record<string, unknown>) };
    await expect(
      queryFilterValuesPageWithQualification({
        env,
        query: clone,
        request: branded,
      }),
    ).rejects.toThrow("filter_values_qualification_request_changed");

    (prepared as Record<string, unknown>).search = "changed";
    await expect(
      queryFilterValuesPageWithQualification({
        env,
        query: prepared,
        request: branded,
      }),
    ).rejects.toThrow("filter_values_qualification_request_changed");
    expect(trace.preparedSql.some(isFusedFilterValuesPageReport)).toBe(false);
  });

  it("propagates an aborted execution without issuing a fused or fallback query", async () => {
    const { database } = createFixture();
    const trace = traceFor();
    const env = testEnv(database, trace);
    const controller = new AbortController();
    const prepared = await d1AdvancedFilterMiddleware(env, undefined, SITE)(
      "filter-values",
      queryFor("session", "page.path", { limit: 2 }),
      async (value) => value,
      { signal: controller.signal },
    );
    const request = deferredFilterValuesQualificationFromQuery(prepared);
    if (!request)
      throw new Error("wave97j_filter_values_request_brand_missing");
    controller.abort();
    await expect(
      queryFilterValuesPageWithQualification({
        env,
        query: prepared,
        request,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(trace.preparedSql).toHaveLength(1);
    expect(trace.preparedSql.some(isFusedFilterValuesPageReport)).toBe(false);
  });
});
