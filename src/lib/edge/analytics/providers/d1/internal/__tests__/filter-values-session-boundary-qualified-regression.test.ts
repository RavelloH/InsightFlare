import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

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
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { createQueryTime } from "@/lib/edge/analytics/contract/helpers";
import { ADVANCED_FILTER_MAX_ACTIVITIES } from "@/lib/edge/analytics/engine/advanced-filter-activity-plan";
import { PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT } from "@/lib/edge/analytics/engine/page-dimension-qualification-plan";
import { buildSessionBoundaryOverviewPageQualificationPlan } from "@/lib/edge/analytics/engine/session-boundary-dimension-qualification-plan";
import { SESSION_PATH_PAGE_REPORT_OUTPUT } from "@/lib/edge/analytics/engine/session-path-report-plan";
import {
  d1AdvancedFilterMiddleware,
  deferredEventQualificationFromQuery,
  prepareDeferredEventQualificationFallback,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { queryD1CompiledAll } from "@/lib/edge/analytics/providers/d1/internal/core";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import {
  mapFilterValueRows,
  queryFilterValuesPageFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/filter-values";
import { queryFilterValuesPageWithQualification } from "@/lib/edge/analytics/providers/d1/internal/filter-values-qualification-program";
import { filterValuesQualificationConfigurationFromQuery } from "@/lib/edge/analytics/providers/d1/internal/filter-values-qualification-request";
import { compileQualificationProgramEnvelope } from "@/lib/edge/analytics/providers/d1/internal/qualification-program-envelope";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import { InvalidCursorError } from "@/lib/pagination";

const SITE = "wave97m-filter-values-session-boundary";
const TEAM = "wave97m-filter-values-team";
const TIME = createQueryTime(100, 200, "UTC", 300);
const WINDOW = {
  startMs: TIME.range.startMs,
  endExclusiveMs: TIME.range.endExclusiveMs,
  nowMs: TIME.capturedAtMs,
  timeZone: TIME.reportingTimeZone,
} as const;
const FILTER_DSL =
  'page.path neq "/native-excluded" and count(event { event.name eq "qualifier" }) gte 1';
const REPORT_FIELDS = ["value", "views", "sessions", "visitors"] as const;
const databases = new Set<DatabaseSync>();
const baselineEvidence: Array<Record<string, unknown>> = [];
const preflightEvidence: Array<Record<string, unknown>> = [];
const routeEvidence: Array<Record<string, unknown>> = [];
const searchEvidence: Array<Record<string, unknown>> = [];
const wave97dvEvidence: Array<Record<string, unknown>> = [];

interface QueryOptions {
  readonly limit?: number;
  readonly cursor?: string | null;
  readonly search?: string;
  readonly filterDsl?: string;
  readonly scopePreference?: "session" | "visitor" | "event";
}

interface FilterValuesResponse {
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
}

interface TestSite {
  readonly id: string;
  readonly pk: number;
}

function traceFor(): SqliteD1Trace {
  return { preparedSql: [], bindings: [] };
}

function traceEvidence(trace: SqliteD1Trace) {
  return trace.preparedSql.map((sql, index) => ({
    sql,
    bindings: trace.bindings[index] ?? [],
  }));
}

function isFusedSessionBoundaryFilterValuesReport(sql: string): boolean {
  return (
    sql.includes("rowKind") &&
    sql.includes(SESSION_PATH_PAGE_REPORT_OUTPUT) &&
    sql.includes(PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT)
  );
}

function wave97dvStatementClass(sql: string): string {
  if (isFusedSessionBoundaryFilterValuesReport(sql)) return "fact-envelope";
  if (/\bfrom\s+(?:["`]sites["`]|sites)(?:\s|$)/i.test(sql))
    return "site-metadata";
  return "other";
}

function addSite(database: DatabaseSync, id: string, team: string): TestSite {
  database.prepare("INSERT INTO site_identities (site_id) VALUES (?)").run(id);
  const pk = Number(
    (
      database
        .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
        .get(id) as { readonly site_pk: number }
    ).site_pk,
  );
  database
    .prepare(
      `INSERT INTO sites (id, team_id, name, domain, created_at)
       VALUES (?, ?, 'Filter values Session boundary', 'wave97m.test', 0)`,
    )
    .run(id, team);
  return { id, pk };
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
    readonly hostname?: string;
  },
): void {
  database
    .prepare(
      `INSERT INTO visits (
        visit_id, site_id, site_pk, visitor_id, session_id, status,
        started_at, last_activity_at, pathname, hostname, duration_ms
      ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, ?, 0)`,
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
      input.hostname ?? "included.test",
    );
}

function addEvent(
  database: DatabaseSync,
  site: TestSite,
  input: { readonly id: string; readonly visitId: string; readonly at: number },
): void {
  database
    .prepare(
      `INSERT INTO custom_event_names (id, site_id, name, last_seen_at, site_pk)
       VALUES (?, ?, 'qualifier', ?, ?) ON CONFLICT(id) DO NOTHING`,
    )
    .run(site.pk, site.id, input.at, site.pk);
  database
    .prepare(
      `INSERT INTO custom_events (
        event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
        received_at, sequence, node_count, value_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 0)`,
    )
    .run(
      input.id,
      site.id,
      site.pk,
      input.visitId,
      site.pk,
      input.at,
      input.at,
    );
}

function createFixture(): DatabaseSync {
  const database = createMigratedDatabase();
  databases.add(database);
  database.exec("PRAGMA foreign_keys = OFF");
  const site = addSite(database, SITE, TEAM);
  const otherSite = addSite(database, `${SITE}-other`, `${TEAM}-other`);
  const visits = [
    ["outside-before", "session-a", "visitor-shared", "/outside-before", 99],
    ["a-entry", "session-a", "visitor-shared", "\u00a0/entry", 110],
    ["a-middle", "session-a", "visitor-shared", "/middle", 120],
    ["a-exit", "session-a", "visitor-shared", "/exit", 130],
    [
      "a-native-excluded",
      "session-a",
      "visitor-shared",
      "/native-excluded",
      140,
    ],
    ["outside-after", "session-a", "visitor-shared", "/outside-after", 200],
    ["display-entry", "session-display", "visitor-display", "/entry", 115],
    ["display-middle", "session-display", "visitor-display", "/middle", 125],
    ["display-exit", "session-display", "visitor-display", "  /end  ", 135],
    ["tie-a", "session-tie", "visitor-tie", "/tie-entry", 125],
    ["tie-z", "session-tie", "visitor-tie", "/tie-exit", 125],
    [
      "visitor-cross-entry",
      "session-cross",
      "visitor-shared",
      "/cross-session-entry",
      118,
    ],
    [
      "visitor-cross-exit",
      "session-cross",
      "visitor-shared",
      "/cross-session-exit",
      150,
    ],
    ["no-count", "session-no-count", "visitor-no-count", "/no-count", 125],
    ["other-site", "other-session", "other-visitor", "/cross-site", 125],
  ] as const;
  for (const [id, sessionId, visitorId, path, startedAt] of visits) {
    addVisit(database, id === "other-site" ? otherSite : site, {
      id,
      sessionId,
      visitorId,
      path,
      startedAt,
    });
  }
  for (const visitId of ["a-middle", "display-middle", "tie-z"])
    addEvent(database, site, {
      id: `event-${visitId}`,
      visitId,
      at: 126,
    });
  addEvent(database, otherSite, {
    id: "event-other-site",
    visitId: "other-site",
    at: 126,
  });
  return database;
}

function envFor(
  database: DatabaseSync,
  trace: SqliteD1Trace,
  interceptAll?: (
    sql: string,
    rows: Record<string, unknown>[],
  ) => Record<string, unknown>[],
): Env {
  const sqlite = createSqliteD1Database(database, trace);
  const DB = interceptAll
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
        batch(statements: Parameters<typeof sqlite.batch>[0]) {
          return sqlite.batch(statements);
        },
      } as unknown as Env["DB"])
    : sqlite;
  return {
    DB,
    MAIN_SECRET: "wave97m-session-boundary-test-secret",
    DAILY_SALT_SECRET: "wave97m-session-boundary-daily-secret",
  } as unknown as Env;
}

function queryFor(
  scope: "session" | "visitor",
  field: string,
  options: QueryOptions = {},
) {
  const prepared = prepareScopedQuery("filter-values", {
    context: siteQueryContext(SITE, "private-dashboard"),
    time: TIME,
    filters: parseFilterDsl(
      options.filterDsl ?? FILTER_DSL,
      analyticsFilterRegistry,
    ),
    scopePreference: options.scopePreference ?? scope,
  } as QueryInput & { readonly time: QueryTime });
  return {
    ...prepared,
    field,
    ...(options.search !== undefined ? { search: options.search } : {}),
    page: {
      limit: options.limit ?? 2,
      cursor: options.cursor ?? null,
    },
  };
}

function outputById(
  plan: ReturnType<
    typeof buildSessionBoundaryOverviewPageQualificationPlan
  >["plan"],
  id: string,
) {
  const matches = plan.outputs.filter((output) => output.id === id);
  if (matches.length !== 1)
    throw new Error(`wave97m_session_boundary_output_missing:${id}`);
  return matches[0]!;
}

async function legacyPage(
  database: DatabaseSync,
  scope: "session" | "visitor",
  field: "session.entryPath" | "session.exitPath",
  options: QueryOptions = {},
  trace = traceFor(),
) {
  const env = envFor(database, trace);
  const query = queryFor(scope, field, options);
  const prepared = await d1AdvancedFilterMiddleware(env, undefined, SITE)(
    "filter-values",
    query,
    async (value) => value,
  );
  const deferred = deferredEventQualificationFromQuery(
    prepared,
    "filter-values",
  );
  const filters = deferred
    ? await prepareDeferredEventQualificationFallback(deferred)
    : (prepared as typeof query).filters;
  if (!filters) throw new Error("wave97m_legacy_filters_missing");
  const page = (cursor?: string | null) =>
    queryFilterValuesPageFromD1(
      env,
      SITE,
      WINDOW,
      filters,
      field,
      options.limit ?? 2,
      cursor,
      options.search,
      "private-dashboard",
    );
  return { page, trace, query, prepared, filters };
}

async function preflight(
  scope: "session" | "visitor",
  field: "session.entryPath" | "session.exitPath",
  search?: string,
): Promise<Record<string, unknown>> {
  const database = createFixture();
  const trace = traceFor();
  const env = envFor(database, trace);
  const countQuery = queryFor(scope, "event.name", {
    limit: 2,
    ...(search !== undefined ? { search } : {}),
  });
  const prepared = await d1AdvancedFilterMiddleware(env, undefined, SITE)(
    "filter-values",
    countQuery,
    async (value) => value,
  );
  const deferred = deferredEventQualificationFromQuery(
    prepared,
    "filter-values",
  );
  if (!deferred?.requestTime)
    throw new Error("wave97m_preflight_request_missing");
  const kind = field === "session.entryPath" ? "entry" : "exit";
  const plan = buildSessionBoundaryOverviewPageQualificationPlan({
    semanticOperation: "filter-values",
    siteId: SITE,
    queryTime: deferred.requestTime,
    filters: deferred.filters,
    scopePlan: deferred.metadata.plan,
    count: deferred.countInput,
    kind,
    limit: 2,
    ...(search !== undefined ? { search } : {}),
    sortBy: "views",
    sortDirection: "desc",
    cursor: null,
  });
  const report = outputById(plan.plan, SESSION_PATH_PAGE_REPORT_OUTPUT);
  const controls = outputById(
    plan.plan,
    PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT,
  );
  const compilation = compileQualificationProgramEnvelope({
    qualification: plan,
    siteId: SITE,
    reports: [
      {
        output: report,
        fields: REPORT_FIELDS,
        rowType: "filter-values-session-boundary-page",
      },
    ],
    controlsOutput: controls,
    reportFields: REPORT_FIELDS,
    controlFields: controls.fields.map(({ name }) => name),
    ordering: [
      {
        field: "views",
        outputId: SESSION_PATH_PAGE_REPORT_OUTPUT,
        direction: "desc",
        nulls: "last",
      },
      {
        field: "value",
        outputId: SESSION_PATH_PAGE_REPORT_OUTPUT,
        direction: "asc",
        nulls: "first",
      },
    ],
    errorPrefix: "wave97m_session_boundary_preflight",
    fallbackTag: "analytics.filter_values_session_boundary_preflight",
    signal: deferred.signal,
  });
  if (compilation.kind !== "compiled")
    throw new Error("wave97m_session_boundary_preflight_unavailable");
  const rows = await queryD1CompiledAll<Record<string, unknown>>(
    env,
    compilation.query,
  );
  const evidence = compilation.evidence;
  expect(evidence.sqlBytes).toBeLessThanOrEqual(100_000);
  expect(evidence.bindingCount).toBeLessThanOrEqual(100);
  expect(evidence.groupWidth).toBeLessThanOrEqual(16);
  expect(evidence.groupedSummaryProof).toMatchObject({
    source: "local-plan",
    nodeKind: "aggregate",
    groupKeyCount: 2,
    matchingSharedRelationCount: 1,
    materialization: "materialized",
  });
  expect(evidence.groupedSummaryProof.fieldCount).toBeLessThanOrEqual(16);

  const expectedFilters =
    await prepareDeferredEventQualificationFallback(deferred);
  const expected = await queryFilterValuesPageFromD1(
    envFor(database, traceFor()),
    SITE,
    WINDOW,
    expectedFilters,
    field,
    2,
    null,
    search,
    "private-dashboard",
  );
  const reportRows = rows.filter(
    (row) =>
      row.rowKind === "report" &&
      row.outputId === SESSION_PATH_PAGE_REPORT_OUTPUT,
  );
  expect(
    reportRows.slice(0, 2).map(({ value, views }) => ({
      value: String(value ?? "").trim(),
      occurrences: Number(views ?? 0),
    })),
  ).toEqual(expected.items);
  expect(reportRows.length).toBe(
    expected.items.length + Number(expected.pagination.hasMore),
  );
  const result = {
    case: `${field}/${scope}${search === undefined ? "" : `/search=${search}`}`,
    sql: evidence.sql,
    bindings: evidence.bindings,
    sqlBytes: evidence.sqlBytes,
    bindingCount: evidence.bindingCount,
    groupWidth: evidence.groupWidth,
    groupedSummaryProof: evidence.groupedSummaryProof,
    sharedRelationCount: evidence.sharedRelationCount,
    reportSourceRelations: evidence.reportSourceRelations,
    outputDescriptors: evidence.outputDescriptors,
    ordering: evidence.ordering,
    rows,
    expected,
    tracedStatements: traceEvidence(trace),
  };
  preflightEvidence.push(result);
  return result;
}

function response(value: unknown): FilterValuesResponse {
  return value as FilterValuesResponse;
}

async function runActual(
  database: DatabaseSync,
  scope: "session" | "visitor",
  field: "session.entryPath" | "session.exitPath",
  options: QueryOptions,
  trace: SqliteD1Trace,
) {
  const diagnostics = createD1ReadDiagnostics();
  const provider = createD1SiteProviderRegistry({
    env: envFor(database, trace),
    siteId: SITE,
    diagnostics,
  }).resolve("filter-values");
  if (!provider) throw new Error("wave97m_filter_values_provider_missing");
  return {
    value: response(
      (await provider.execute(queryFor(scope, field, options))).value,
    ),
    diagnostics,
  };
}

describe("Filter Values Session boundary Count qualification", () => {
  it.each(["session.entryPath", "session.exitPath"] as const)(
    "matches the Core fallback across Event candidate cursor pages for %s",
    async (field) => {
      const database = createFixture();
      const options = { limit: 1, scopePreference: "event" } as const;
      const oracle = await legacyPage(database, "session", field, options);
      const deferred = deferredEventQualificationFromQuery(
        oracle.prepared,
        "filter-values",
      );
      expect(deferred?.countInput.scope).toBe("event");
      expect(
        deferred && "eventCandidateReportProjection" in deferred
          ? deferred.eventCandidateReportProjection
          : undefined,
      ).toBe("page-visits");

      let cursor: string | null = null;
      let finished = false;
      let pageCount = 0;
      for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
        const expected = await oracle.page(cursor);
        const trace = traceFor();
        const actual = await runActual(
          database,
          "session",
          field,
          { ...options, cursor },
          trace,
        );
        expect(actual.value).toEqual({
          field,
          data: {
            items: expected.items.map((row) => ({
              value: row.value,
              label: row.value,
              occurrences: row.occurrences,
            })),
            pagination: expected.pagination,
          },
        });
        expect(trace.preparedSql).toHaveLength(2);
        pageCount += 1;
        if (expected.pagination.nextCursor === null) {
          finished = true;
          break;
        }
        cursor = expected.pagination.nextCursor;
      }
      expect(finished).toBe(true);
      expect(pageCount).toBeGreaterThan(1);
    },
  );

  it("97DV preserves whole OR/NOT ownership for the session-boundary report", async () => {
    const filterDsl =
      'page.path eq "/no-count" or not (count(event { event.name eq "qualifier" }) eq 0)';
    const wrongAndDsl =
      'page.path eq "/no-count" and not (count(event { event.name eq "qualifier" }) eq 0)';
    const database = createFixture();
    const query = queryFor("visitor", "session.entryPath", {
      limit: 30,
      filterDsl,
    });
    const trace = traceFor();
    const diagnostics = createD1ReadDiagnostics();
    const provider = createD1SiteProviderRegistry({
      env: envFor(database, trace),
      siteId: SITE,
      diagnostics,
    }).resolve("filter-values");
    if (!provider)
      throw new Error("wave97dv_session_boundary_provider_missing");
    const actualResult = await provider.execute(query);
    const actual = response(actualResult.value);

    const oracle = await legacyPage(
      createFixture(),
      "visitor",
      "session.entryPath",
      { limit: 30, filterDsl },
    );
    const expected = await oracle.page(null);
    const legacyDto = {
      field: "session.entryPath",
      data: {
        items: expected.items.map((row) => ({
          value: row.value,
          label: row.value,
          occurrences: row.occurrences,
        })),
        pagination: expected.pagination,
      },
    };
    const wrongAndOracle = await legacyPage(
      createFixture(),
      "visitor",
      "session.entryPath",
      { limit: 30, filterDsl: wrongAndDsl },
    );
    const wrongAnd = await wrongAndOracle.page(null);
    const factStatements = trace.preparedSql.filter(
      isFusedSessionBoundaryFilterValuesReport,
    );
    const statementClasses = trace.preparedSql.map(wave97dvStatementClass);

    wave97dvEvidence.push({
      contract: "session-boundary-visitor-whole-or-not",
      filterDsl,
      countOnlyOwner: "visitor-shared (qualifier event; no /no-count page)",
      nativeOnlyOwner: "visitor-no-count (/no-count page; no qualifier event)",
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
      expect.arrayContaining(["/entry", "/cross-session-entry", "/no-count"]),
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

  it("captures independent legacy DTOs and proves all four field/scope plans", async () => {
    for (const scope of ["session", "visitor"] as const) {
      for (const field of ["session.entryPath", "session.exitPath"] as const) {
        const database = createFixture();
        const trace = traceFor();
        const actual = await runActual(
          database,
          scope,
          field,
          { limit: 2 },
          trace,
        );
        const oracle = await legacyPage(database, scope, field, {
          limit: 2,
        });
        const expected = await oracle.page(null);
        expect(actual.value.field).toBe(field);
        expect(actual.value.data.items).toEqual(
          expected.items.map((row) => ({
            value: row.value,
            label: row.value,
            occurrences: row.occurrences,
          })),
        );
        expect(actual.value.data.pagination).toEqual(expected.pagination);
        baselineEvidence.push({
          case: `${field}/${scope}`,
          legacyDto: {
            field,
            data: {
              items: expected.items.map((row) => ({
                value: row.value,
                label: row.value,
                occurrences: row.occurrences,
              })),
              pagination: expected.pagination,
            },
          },
          routedDto: actual.value,
          routeStatements: traceEvidence(trace),
          legacyStatements: traceEvidence(oracle.trace),
        });
      }
    }
    const ordinaryDatabase = createFixture();
    const ordinaryTrace = traceFor();
    const ordinaryProvider = createD1SiteProviderRegistry({
      env: envFor(ordinaryDatabase, ordinaryTrace),
      siteId: SITE,
    }).resolve("filter-values");
    if (!ordinaryProvider) throw new Error("wave97m_ordinary_provider_missing");
    const ordinaryOptions = {
      limit: 2,
      filterDsl: 'page.path neq "/not-present"',
    } as const;
    const ordinaryActual = response(
      (
        await ordinaryProvider.execute(
          queryFor("session", "session.entryPath", ordinaryOptions),
        )
      ).value,
    );
    const ordinaryOracle = await legacyPage(
      ordinaryDatabase,
      "session",
      "session.entryPath",
      ordinaryOptions,
    );
    const ordinaryExpected = await ordinaryOracle.page(null);
    expect(ordinaryActual.data.items).toEqual(
      ordinaryExpected.items.map((row) => ({
        value: row.value,
        label: row.value,
        occurrences: row.occurrences,
      })),
    );
    expect(ordinaryActual.data.pagination).toEqual(ordinaryExpected.pagination);
    baselineEvidence.push({
      case: "session.entryPath/session/ordinary-no-count",
      legacyDto: {
        field: ordinaryActual.field,
        data: {
          items: ordinaryExpected.items.map((row) => ({
            value: row.value,
            label: row.value,
            occurrences: row.occurrences,
          })),
          pagination: ordinaryExpected.pagination,
        },
      },
      routedDto: ordinaryActual,
      routeStatements: traceEvidence(ordinaryTrace),
      legacyStatements: traceEvidence(ordinaryOracle.trace),
    });
    for (const scope of ["session", "visitor"] as const)
      for (const field of ["session.entryPath", "session.exitPath"] as const)
        await preflight(scope, field);
    expect(preflightEvidence).toHaveLength(4);
  });

  it("preserves boundary rules, visitor expansion, exact cursors, and legacy display mapping", async () => {
    const completed: Record<string, string[]> = {};
    for (const scope of ["session", "visitor"] as const) {
      for (const field of ["session.entryPath", "session.exitPath"] as const) {
        const database = createFixture();
        const oracle = await legacyPage(database, scope, field, {
          limit: 1,
        });
        const values: string[] = [];
        const pageEvidence: Array<Record<string, unknown>> = [];
        let firstPageStatements: ReturnType<typeof traceEvidence> = [];
        let cursor: string | null = null;
        let finished = false;
        for (let pageIndex = 0; pageIndex < 24; pageIndex += 1) {
          const routeTrace = traceFor();
          const actual = await runActual(
            database,
            scope,
            field,
            { limit: 1, cursor },
            routeTrace,
          );
          const expected = await oracle.page(cursor);
          expect(actual.value.field).toBe(field);
          expect(actual.value.data.items).toEqual(
            expected.items.map((row) => ({
              value: row.value,
              label: row.value,
              occurrences: row.occurrences,
            })),
          );
          expect(actual.value.data.pagination).toEqual(expected.pagination);
          values.push(...actual.value.data.items.map(({ value }) => value));
          const nextCursor = actual.value.data.pagination.nextCursor;
          if (pageIndex === 0) firstPageStatements = traceEvidence(routeTrace);
          pageEvidence.push({
            pageIndex,
            cursorIn: cursor,
            actualDto: actual.value,
            legacyDto: {
              items: expected.items.map((row) => ({
                value: row.value,
                label: row.value,
                occurrences: row.occurrences,
              })),
              pagination: expected.pagination,
            },
            cursorOut: nextCursor,
          });
          if (nextCursor === null) {
            expect(actual.value.data.pagination.hasMore).toBe(false);
            expect(actual.value.data.pagination.nextCursor).toBeNull();
            finished = true;
            break;
          }
          // A cursor emitted by the candidate remains usable by the old reader.
          expect((await oracle.page(nextCursor)).pagination.limit).toBe(1);
          cursor = nextCursor;
          if (pageIndex === 23)
            throw new Error("wave97m_session_boundary_cursor_unbounded");
        }
        expect(finished).toBe(true);
        expect(values).not.toContain("/outside-before");
        expect(values).not.toContain("/outside-after");
        expect(values).not.toContain("/no-count");
        expect(values).not.toContain("/cross-site");
        if (field === "session.entryPath") {
          expect(values).toContain("/tie-entry");
          expect(values).not.toContain("/tie-exit");
          if (scope === "visitor")
            expect(values).toContain("/cross-session-entry");
          else expect(values).not.toContain("/cross-session-entry");
        } else {
          expect(values).toContain("/tie-exit");
          expect(values).not.toContain("/tie-entry");
          expect(values).toContain("/native-excluded");
          if (scope === "visitor")
            expect(values).toContain("/cross-session-exit");
          else expect(values).not.toContain("/cross-session-exit");
        }
        completed[`${field}/${scope}`] = values;
        routeEvidence.push({
          case: `${field}/${scope}`,
          values,
          pages: pageEvidence,
          firstPageStatements,
        });

        for (const search of ["  ENTRY  ", "\u00a0entry\u00a0"] as const) {
          const searchTrace = traceFor();
          const filtered = await runActual(
            database,
            scope,
            field,
            { limit: 10, search },
            searchTrace,
          );
          const searchOracle = await legacyPage(database, scope, field, {
            limit: 10,
            search,
          });
          const searched = await searchOracle.page(null);
          expect(filtered.value.data.items).toEqual(
            searched.items.map((row) => ({
              value: row.value,
              label: row.value,
              occurrences: row.occurrences,
            })),
          );
          expect(filtered.value.data.pagination).toEqual(searched.pagination);
          searchEvidence.push({
            case: `${field}/${scope}`,
            search,
            actualDto: filtered.value,
            legacyDto: {
              items: searched.items.map((row) => ({
                value: row.value,
                label: row.value,
                occurrences: row.occurrences,
              })),
              pagination: searched.pagination,
            },
            statementCount: searchTrace.preparedSql.length,
            sqlSha256: searchTrace.preparedSql.map((sql) =>
              createHash("sha256").update(sql).digest("hex"),
            ),
            bindings: searchTrace.bindings,
          });
        }
      }
    }
    expect(completed["session.entryPath/session"]).toContain("/entry");
  });

  it("keeps Count cap precedence and rejects invalid cursors after a valid control", async () => {
    const database = createFixture();
    const capTrace = traceFor();
    const diagnostics = createD1ReadDiagnostics();
    const provider = createD1SiteProviderRegistry({
      env: envFor(database, capTrace, (sql, rows) => {
        if (!sql.includes("rowKind")) return rows;
        return rows
          .filter((row) => row.rowKind === "control")
          .map((row) => ({
            ...row,
            rawCount: ADVANCED_FILTER_MAX_ACTIVITIES + 1,
          }));
      }),
      siteId: SITE,
      diagnostics,
    }).resolve("filter-values");
    if (!provider) throw new Error("wave97m_filter_values_provider_missing");
    const cappedQuery = queryFor("session", "session.entryPath", {
      limit: 2,
      cursor: "malformed-cursor",
    });
    await expect(provider.execute(cappedQuery)).rejects.toMatchObject({
      domainError: {
        kind: "invalid-input",
        issues: [{ path: "filters", code: "filter_activity_limit_exceeded" }],
      },
    });
    expect(capTrace.preparedSql).toHaveLength(2);
    expect(capTrace.preparedSql[1]).toContain("rowKind");
    expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();

    const invalidCursorProvider = createD1SiteProviderRegistry({
      env: envFor(createFixture(), traceFor()),
      siteId: SITE,
    }).resolve("filter-values");
    if (!invalidCursorProvider)
      throw new Error("wave97m_invalid_cursor_provider_missing");
    await expect(
      invalidCursorProvider.execute(
        queryFor("session", "session.exitPath", {
          limit: 2,
          cursor: "malformed-cursor",
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidCursorError);

    const bindingDatabase = createFixture();
    const firstEntry = await runActual(
      bindingDatabase,
      "session",
      "session.entryPath",
      { limit: 1 },
      traceFor(),
    );
    const entryCursor = firstEntry.value.data.pagination.nextCursor;
    expect(entryCursor).not.toBeNull();
    const bindingProvider = createD1SiteProviderRegistry({
      env: envFor(bindingDatabase, traceFor()),
      siteId: SITE,
    }).resolve("filter-values");
    if (!bindingProvider)
      throw new Error("wave97m_cursor_binding_provider_missing");
    for (const [scope, field] of [
      ["session", "session.exitPath"],
      ["visitor", "session.entryPath"],
    ] as const) {
      await expect(
        bindingProvider.execute(
          queryFor(scope, field, {
            limit: 1,
            cursor: entryCursor,
          }),
        ),
      ).rejects.toBeInstanceOf(InvalidCursorError);
    }
  });

  it("falls back once for a numeric-domain guard and preserves the legacy DTO", async () => {
    const database = createFixture();
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run(10, "a-entry");
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "a-middle");
    const options = {
      limit: 2,
      filterDsl: "count(page { page.durationMs gt 5 }) eq 1",
    } as const;
    const actualTrace = traceFor();
    const actual = await runActual(
      database,
      "session",
      "session.entryPath",
      options,
      actualTrace,
    );
    const oracle = await legacyPage(
      database,
      "session",
      "session.entryPath",
      options,
    );
    const expected = await oracle.page(null);
    expect(actual.value.data.items).toEqual(
      expected.items.map((row) => ({
        value: row.value,
        label: row.value,
        occurrences: row.occurrences,
      })),
    );
    expect(actual.value.data.pagination).toEqual(expected.pagination);
    expect(actual.diagnostics.advancedCountSqlFallbackReason).toMatchObject({
      kind: "numeric-data-domain",
    });
    expect(actualTrace.preparedSql.length).toBe(
      oracle.trace.preparedSql.length + 1,
    );
  });

  it("retains duplicate values after legacy display trimming", () => {
    expect(
      mapFilterValueRows([
        { value: "\u00a0/path\u00a0", views: 1, sessions: 1, visitors: 1 },
        { value: "/path", views: 2, sessions: 1, visitors: 1 },
      ]),
    ).toEqual([
      { value: "/path", occurrences: 1 },
      { value: "/path", occurrences: 2 },
    ]);
  });

  it("derives the boundary from field and keeps the default page limit", async () => {
    const query = {
      ...queryFor("session", "session.exitPath"),
      page: { cursor: null },
      limit: 1,
      sort: { key: "sessions", direction: "asc" },
      kind: "entry",
    };
    const configuration =
      filterValuesQualificationConfigurationFromQuery(query);
    expect(configuration).toMatchObject({
      reportKind: "session-boundary",
      field: "session.exitPath",
      limit: 50,
      cursorToken: null,
      audience: "private-dashboard",
    });
    expect(configuration).not.toHaveProperty("kind");
    const accessor = Object.defineProperty({ ...query }, "field", {
      enumerable: true,
      get: () => "session.entryPath",
    });
    expect(
      filterValuesQualificationConfigurationFromQuery(accessor),
    ).toBeUndefined();
    expect(
      filterValuesQualificationConfigurationFromQuery({
        ...query,
        context: siteQueryContext(SITE, "public-share"),
      }),
    ).toBeUndefined();

    const database = createFixture();
    const provider = createD1SiteProviderRegistry({
      env: envFor(database, traceFor()),
      siteId: SITE,
    }).resolve("filter-values");
    if (!provider) throw new Error("wave97m_default_provider_missing");
    const actual = response(
      (
        await provider.execute(
          query as unknown as Parameters<typeof provider.execute>[0],
        )
      ).value,
    );
    const oracle = await legacyPage(database, "session", "session.exitPath", {
      limit: 50,
    });
    const expected = await oracle.page(null);
    expect(actual.data.pagination.limit).toBe(50);
    expect(actual.data.items).toEqual(
      expected.items.map((row) => ({
        value: row.value,
        label: row.value,
        occurrences: row.occurrences,
      })),
    );
    expect(actual.data.pagination).toEqual(expected.pagination);
  });
});

afterAll(() => {
  for (const database of databases) database.close();
  const wave97dvDirectory = process.env.WAVE97DV_ARTIFACT_DIR;
  if (wave97dvDirectory) {
    mkdirSync(wave97dvDirectory, { recursive: true });
    if (wave97dvEvidence.length > 0)
      writeFileSync(
        `${wave97dvDirectory}/filter-values-session-boundary-whole-boolean.json`,
        JSON.stringify(
          {
            wave: "97DV",
            reportKind: "session-boundary",
            evidence: wave97dvEvidence,
          },
          null,
          2,
        ),
        "utf8",
      );
    return;
  }
  const directory =
    "plan/execution-wave97m-filter-values-session-boundary-qualification/run-1";
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    `${directory}/filter-values-session-boundary-before.json`,
    JSON.stringify(
      {
        source:
          "independent legacy Filter Values Session boundary oracle and Count preflight plans",
        sourceHash: createHash("sha256")
          .update(
            "queryFilterValuesPageFromD1 + buildSessionBoundaryOverviewPageQualificationPlan",
          )
          .digest("hex"),
        baselineEvidence: baselineEvidence.map((item) => ({
          case: item.case,
          legacyDto: item.legacyDto,
          legacyStatements: item.legacyStatements,
        })),
        preflightEvidence,
      },
      null,
      2,
    ),
    "utf8",
  );
  if (routeEvidence.length > 0)
    writeFileSync(
      `${directory}/filter-values-session-boundary-after.json`,
      JSON.stringify(
        {
          source: "actual Filter Values Session boundary route",
          routeEvidence,
          searchEvidence,
        },
        null,
        2,
      ),
      "utf8",
    );
});
