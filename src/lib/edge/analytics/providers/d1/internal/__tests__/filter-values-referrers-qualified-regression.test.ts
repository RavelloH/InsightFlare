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
  prepareScopedQuery,
  type QueryInput,
  type QueryTime,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { createQueryTime } from "@/lib/edge/analytics/contract/helpers";
import { ADVANCED_FILTER_MAX_ACTIVITIES } from "@/lib/edge/analytics/engine/advanced-filter-activity-plan";
import { PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT } from "@/lib/edge/analytics/engine/page-dimension-qualification-plan";
import { buildReferrerPageQualificationPlan } from "@/lib/edge/analytics/engine/referrer-page-qualification-plan";
import { REFERRERS_PAGE_REPORT_OUTPUT } from "@/lib/edge/analytics/engine/referrer-report-plan";
import {
  d1AdvancedFilterMiddleware,
  deferredEventQualificationFromQuery,
  deferredFilterValuesQualificationFromQuery,
  prepareDeferredEventQualificationFallback,
  prepareDeferredPageVisitQualification,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { queryD1CompiledAll } from "@/lib/edge/analytics/providers/d1/internal/core";
import { DIRECT_REFERRER_FILTER_VALUE } from "@/lib/edge/analytics/providers/d1/internal/core";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import {
  filterValuesPageQualificationConsumerKey,
  queryFilterValuesPageFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/filter-values";
import { queryFilterValuesPageWithQualification } from "@/lib/edge/analytics/providers/d1/internal/filter-values-qualification-program";
import { filterValuesQualificationConfigurationFromQuery } from "@/lib/edge/analytics/providers/d1/internal/filter-values-qualification-request";
import { compileQualificationProgramEnvelope } from "@/lib/edge/analytics/providers/d1/internal/qualification-program-envelope";
import { queryReferrersPageFromD1 } from "@/lib/edge/analytics/providers/d1/internal/referrers";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import { InvalidCursorError } from "@/lib/pagination";

const SITE = "wave97l-filter-values-referrers";
const TEAM = "wave97l-filter-values-team";
const TIME = createQueryTime(100, 200, "UTC", 300);
const WINDOW = {
  startMs: TIME.range.startMs,
  endExclusiveMs: TIME.range.endExclusiveMs,
  nowMs: TIME.capturedAtMs,
  timeZone: TIME.reportingTimeZone,
} as const;
const FILTER_DSL =
  'page.path neq "/excluded" and count(event { event.name eq "qualifier" }) gte 1';
const NUMERIC_COUNT_DSL = `${FILTER_DSL} and count(page { page.durationMs gt 5 }) eq 1`;
const REFERRER_FIELDS = ["referrer", "views", "sessions", "visitors"] as const;
const databases = new Set<DatabaseSync>();
const baselineEvidence: Array<Record<string, unknown>> = [];
const preflightEvidence: Array<Record<string, unknown>> = [];
const wave97dvEvidence: Array<Record<string, unknown>> = [];

interface QueryOptions {
  readonly limit?: number;
  readonly cursor?: string | null;
  readonly search?: string;
  readonly scopePreference?: "session" | "visitor" | "event";
  readonly filterDsl?: string;
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

function traceFor(): SqliteD1Trace {
  return { preparedSql: [], bindings: [] };
}

function traceEvidence(trace: SqliteD1Trace) {
  return trace.preparedSql.map((sql, index) => ({
    sql,
    bindings: trace.bindings[index] ?? [],
  }));
}

function isFusedReferrerFilterValuesReport(sql: string): boolean {
  return (
    sql.includes("rowKind") &&
    sql.includes(REFERRERS_PAGE_REPORT_OUTPUT) &&
    sql.includes(PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT)
  );
}

function isReferrerCompatibilityPageReport(sql: string): boolean {
  return (
    !sql.includes("rowKind") &&
    sql.includes('AS "referrer"') &&
    sql.includes('AS "views"') &&
    sql.includes('AS "sessions"') &&
    sql.includes('AS "visitors"')
  );
}

function wave97dvStatementClass(sql: string): string {
  if (isFusedReferrerFilterValuesReport(sql)) return "fact-envelope";
  if (/\bfrom\s+(?:["`]sites["`]|sites)(?:\s|$)/i.test(sql))
    return "site-metadata";
  return "other";
}

function setDurationFixture(database: DatabaseSync): void {
  database
    .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
    .run(10, "a-source");
  database
    .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
    .run("invalid-duration", "b-source");
}

function addNumericCursorReferrer(database: DatabaseSync): void {
  const sitePk = Number(
    (
      database
        .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
        .get(SITE) as { readonly site_pk: number }
    ).site_pk,
  );
  database
    .prepare(
      `INSERT INTO visits (
         visit_id, site_id, site_pk, visitor_id, session_id, status,
         started_at, last_activity_at, pathname, hostname, referrer_host,
         referrer_url, duration_ms
       ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, 'wave97l.test', ?, ?, ?)`,
    )
    .run(
      "numeric-cursor-source",
      SITE,
      sitePk,
      "numeric-cursor-visitor",
      "numeric-cursor-session",
      123,
      123,
      "/qualifier",
      "third.example",
      "https://third.example/path",
      10,
    );
  database
    .prepare(
      `INSERT INTO custom_events (
         event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
         received_at, sequence, node_count, value_count
       ) VALUES (?, ?, ?, ?, 1, ?, ?, 1, 0, 0)`,
    )
    .run(
      "event-numeric-cursor-source",
      SITE,
      sitePk,
      "numeric-cursor-source",
      123,
      123,
    );
}

function createFixture(): DatabaseSync {
  const database = createMigratedDatabase();
  databases.add(database);
  database.exec("PRAGMA foreign_keys = OFF");
  database
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .run(SITE);
  const sitePk = Number(
    (
      database
        .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
        .get(SITE) as { readonly site_pk: number }
    ).site_pk,
  );
  database
    .prepare(
      `INSERT INTO sites (id, team_id, name, domain, created_at)
       VALUES (?, ?, 'Referrer filter values', 'wave97l.test', 0)`,
    )
    .run(SITE, TEAM);
  database
    .prepare(
      `INSERT INTO custom_event_names (id, site_id, name, last_seen_at, site_pk)
       VALUES (1, ?, 'qualifier', 150, ?)`,
    )
    .run(SITE, sitePk);

  const visits = [
    [
      "a-source",
      "session-a1",
      "visitor-shared",
      "/qualifier",
      "Host.Example",
      "https://Host.Example/a?x=1",
      110,
      1,
    ],
    [
      "a-page",
      "session-a1",
      "visitor-shared",
      "/same",
      "Host.Example",
      "https://Host.Example/a?x=1",
      111,
      0,
    ],
    [
      "a-url-b",
      "session-a1",
      "visitor-shared",
      "/same",
      "Host.Example",
      "https://Host.Example/b?x=2",
      112,
      0,
    ],
    [
      "a-second-session",
      "session-a2",
      "visitor-shared",
      "/same",
      "Host.Example",
      "https://Host.Example/a2",
      113,
      0,
    ],
    [
      "b-source",
      "session-b",
      "visitor-b",
      "/qualifier",
      "host.example",
      "https://host.example/b",
      114,
      1,
    ],
    [
      "b-page",
      "session-b",
      "visitor-b",
      "/same",
      "host.example",
      "https://host.example/b2",
      115,
      0,
    ],
    [
      "direct-source",
      "session-direct",
      "visitor-direct",
      "/qualifier",
      "",
      "",
      116,
      1,
    ],
    [
      "direct-page",
      "session-direct",
      "visitor-direct",
      "/same",
      "",
      "",
      117,
      0,
    ],
    [
      "literal-direct-source",
      "session-literal",
      "visitor-literal",
      "/qualifier",
      "__direct__",
      "__direct__",
      118,
      1,
    ],
    [
      "literal-direct-page",
      "session-literal",
      "visitor-literal",
      "/same",
      "__direct__",
      "__direct__?q=1",
      119,
      0,
    ],
    [
      "unicode-source",
      "session-unicode",
      "visitor-unicode",
      "/qualifier",
      "例子.test",
      "https://例子.test/路径?q=值",
      120,
      1,
    ],
    [
      "excluded-page",
      "session-excluded",
      "visitor-excluded",
      "/excluded",
      "excluded.example",
      "https://excluded.example/",
      121,
      0,
    ],
    [
      "unqualified",
      "session-unqualified",
      "visitor-unqualified",
      "/unqualified",
      "unqualified.example",
      "https://unqualified.example/",
      122,
      0,
    ],
  ] as const;
  const insertVisit = database.prepare(
    `INSERT INTO visits (
       visit_id, site_id, site_pk, visitor_id, session_id, status,
       started_at, last_activity_at, pathname, hostname, referrer_host,
       referrer_url
     ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, 'wave97l.test', ?, ?)`,
  );
  const insertEvent = database.prepare(
    `INSERT INTO custom_events (
       event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
       received_at, sequence, node_count, value_count
     ) VALUES (?, ?, ?, ?, 1, ?, ?, 1, 0, 0)`,
  );
  for (const [
    id,
    sessionId,
    visitorId,
    path,
    host,
    url,
    at,
    qualifies,
  ] of visits) {
    insertVisit.run(
      id,
      SITE,
      sitePk,
      visitorId,
      sessionId,
      at,
      at,
      path,
      host,
      url,
    );
    if (qualifies) insertEvent.run(`event-${id}`, SITE, sitePk, id, at, at);
  }
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
        batch(statements: Parameters<typeof sqlite.batch>[0]) {
          return sqlite.batch(statements);
        },
      } as unknown as Env["DB"])
    : sqlite;
  return {
    DB: adapter,
    MAIN_SECRET: "wave97l-referrer-test-secret",
    DAILY_SALT_SECRET: "wave97l-referrer-daily-secret",
  } as unknown as Env;
}

function queryFor(
  scope: "session" | "visitor" | "event",
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
  plan: ReturnType<typeof buildReferrerPageQualificationPlan>["plan"],
  id: string,
) {
  const matches = plan.outputs.filter((output) => output.id === id);
  if (matches.length !== 1)
    throw new Error(`wave97l_preflight_output_missing:${id}`);
  return matches[0]!;
}

async function legacyPage(
  database: DatabaseSync,
  scope: "session" | "visitor" | "event",
  field: "referrer.domain" | "referrer.url",
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
    : ((prepared as typeof query).filters ?? EMPTY_FILTER_DOCUMENT);
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
  field: "referrer.domain" | "referrer.url",
): Promise<Record<string, unknown>> {
  const database = createFixture();
  const trace = traceFor();
  const env = envFor(database, trace);
  // event.name currently enters the shared Count preparation path; its Count
  // input is independent of the candidate Referrer report field.
  const query = queryFor(scope, "event.name", { limit: 2 });
  const prepared = await d1AdvancedFilterMiddleware(env, undefined, SITE)(
    "filter-values",
    query,
    async (value) => value,
  );
  const deferred = deferredEventQualificationFromQuery(
    prepared,
    "filter-values",
  );
  if (!deferred?.requestTime)
    throw new Error("wave97l_referrer_preflight_request_missing");
  const plan = buildReferrerPageQualificationPlan({
    semanticOperation: "filter-values",
    siteId: SITE,
    queryTime: deferred.requestTime,
    filters: deferred.filters,
    scopePlan: deferred.metadata.plan,
    count: deferred.countInput,
    options: {
      limit: 2,
      includeFullUrl: field === "referrer.url",
      sortBy: "views",
      sortDirection: "desc",
      cursor: null,
    },
  });
  const report = outputById(plan.plan, REFERRERS_PAGE_REPORT_OUTPUT);
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
        fields: REFERRER_FIELDS,
        rowType: "referrer-page",
      },
    ],
    controlsOutput: controls,
    reportFields: REFERRER_FIELDS,
    controlFields: controls.fields.map(({ name }) => name),
    ordering: [
      {
        field: "views",
        outputId: REFERRERS_PAGE_REPORT_OUTPUT,
        direction: "desc",
        nulls: "last",
      },
      {
        field: "sessions",
        outputId: REFERRERS_PAGE_REPORT_OUTPUT,
        direction: "desc",
        nulls: "last",
      },
      {
        field: "referrer",
        outputId: REFERRERS_PAGE_REPORT_OUTPUT,
        direction: "asc",
        nulls: "first",
      },
    ],
    errorPrefix: "wave97l_referrer_preflight",
    fallbackTag: "analytics.filter_values_referrer_preflight",
    signal: deferred.signal,
  });
  if (compilation.kind !== "compiled")
    throw new Error("wave97l_referrer_preflight_unavailable");
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

  const expectedTrace = traceFor();
  const expectedEnv = envFor(database, expectedTrace);
  const expectedPage = await queryReferrersPageFromD1(
    expectedEnv,
    SITE,
    WINDOW,
    await prepareDeferredEventQualificationFallback(deferred),
    2,
    field === "referrer.url",
    undefined,
    null,
    undefined,
    "private-dashboard",
  );
  const reportRows = rows.filter(
    (row) =>
      row.rowKind === "report" && row.outputId === REFERRERS_PAGE_REPORT_OUTPUT,
  );
  const candidateRows = reportRows.map(
    ({ referrer, views, sessions, visitors }) => ({
      referrer,
      views,
      sessions,
      visitors,
    }),
  );
  expect(candidateRows.slice(0, 2)).toEqual(expectedPage.items);
  expect(candidateRows.length).toBe(
    expectedPage.items.length + Number(expectedPage.pagination.hasMore),
  );
  return {
    case: `${field}/${scope}`,
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
    expectedPage: expectedPage.items,
    tracedStatements: traceEvidence(trace),
  };
}

function response(value: unknown): FilterValuesResponse {
  return value as FilterValuesResponse;
}

describe("filter-values referrer qualification baseline", () => {
  it.each(["referrer.domain", "referrer.url"] as const)(
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

      const actualTrace = traceFor();
      const provider = createD1SiteProviderRegistry({
        env: envFor(database, actualTrace),
        siteId: SITE,
      }).resolve("filter-values");
      if (!provider)
        throw new Error(
          "wave97ep_event_referrer_filter_values_provider_missing",
        );
      let cursor: string | null = null;
      let finished = false;
      let pageCount = 0;
      for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
        const expected = await oracle.page(cursor);
        const actual = response(
          (
            await provider.execute(
              queryFor("session", field, {
                ...options,
                cursor,
              }),
            )
          ).value,
        );
        expect(actual).toEqual({
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
        pageCount += 1;
        if (expected.pagination.nextCursor === null) {
          finished = true;
          break;
        }
        cursor = expected.pagination.nextCursor;
      }
      expect(finished).toBe(true);
      expect(pageCount).toBeGreaterThan(1);
      expect(actualTrace.preparedSql.length).toBe(pageCount * 2);
      expect(actualTrace.bindings.length).toBe(pageCount * 2);
    },
  );

  it("97DV preserves whole OR/NOT ownership for the Referrer report", async () => {
    const filterDsl =
      'page.path eq "/unqualified" or not (count(event { event.name eq "qualifier" }) eq 0)';
    const wrongAndDsl =
      'page.path eq "/unqualified" and not (count(event { event.name eq "qualifier" }) eq 0)';
    const database = createFixture();
    const trace = traceFor();
    const diagnostics = createD1ReadDiagnostics();
    const provider = createD1SiteProviderRegistry({
      env: envFor(database, trace),
      siteId: SITE,
      diagnostics,
    }).resolve("filter-values");
    if (!provider)
      throw new Error("wave97dv_referrer_filter_values_provider_missing");
    const actualResult = await provider.execute(
      queryFor("session", "referrer.domain", { limit: 20, filterDsl }),
    );
    const actual = response(actualResult.value);

    const oracle = await legacyPage(
      createFixture(),
      "session",
      "referrer.domain",
      { limit: 20, filterDsl },
    );
    const expected = await oracle.page(null);
    const legacyDto = {
      field: "referrer.domain",
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
      "session",
      "referrer.domain",
      { limit: 20, filterDsl: wrongAndDsl },
    );
    const wrongAnd = await wrongAndOracle.page(null);
    const factStatements = trace.preparedSql.filter(
      isFusedReferrerFilterValuesReport,
    );
    const statementClasses = trace.preparedSql.map(wave97dvStatementClass);
    const actualValues = actual.data.items.map((row) =>
      row.value.toLowerCase(),
    );

    wave97dvEvidence.push({
      contract: "referrer-session-whole-or-not",
      filterDsl,
      countOnlyOwner: "session-a1 (qualifier event; no /unqualified page)",
      nativeOnlyOwner:
        "session-unqualified (/unqualified page; no qualifier event)",
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
    expect(actualValues).toEqual(
      expect.arrayContaining(["host.example", "unqualified.example"]),
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

  it("captures all four legacy DTOs and proves candidate Count + Referrers plans", async () => {
    for (const scope of ["session", "visitor"] as const) {
      for (const field of ["referrer.domain", "referrer.url"] as const) {
        const actualDatabase = createFixture();
        const actualTrace = traceFor();
        const actualProvider = createD1SiteProviderRegistry({
          env: envFor(actualDatabase, actualTrace),
          siteId: SITE,
        }).resolve("filter-values");
        if (!actualProvider)
          throw new Error("wave97l_filter_values_provider_missing");
        const actual = response(
          (await actualProvider.execute(queryFor(scope, field, { limit: 2 })))
            .value,
        );

        const oracleDatabase = createFixture();
        const oracleTrace = traceFor();
        const oracle = await legacyPage(
          oracleDatabase,
          scope,
          field,
          { limit: 2 },
          oracleTrace,
        );
        const expected = await oracle.page(null);
        expect(actual.field).toBe(field);
        expect(actual.data.items).toEqual(
          expected.items.map((row) => ({
            value: row.value,
            label: row.value,
            occurrences: row.occurrences,
          })),
        );
        expect(actual.data.pagination).toEqual(expected.pagination);
        baselineEvidence.push({
          case: `${field}/${scope}`,
          actual: actual,
          expected,
          actualStatements: traceEvidence(actualTrace),
          actualStatementCount: actualTrace.preparedSql.length,
          legacyStatements: traceEvidence(oracle.trace),
          legacyStatementCount: oracle.trace.preparedSql.length,
        });
      }
    }
    for (const scope of ["session", "visitor"] as const)
      for (const field of ["referrer.domain", "referrer.url"] as const)
        preflightEvidence.push(await preflight(scope, field));
    expect(preflightEvidence).toHaveLength(4);
  });

  it("preserves old-new-old cursor chains, search, and direct display collisions", async () => {
    const complete: Record<
      string,
      readonly { readonly value: string; readonly occurrences: number }[]
    > = {};
    for (const scope of ["session", "visitor"] as const) {
      for (const field of ["referrer.domain", "referrer.url"] as const) {
        const database = createFixture();
        const actualTrace = traceFor();
        const actualProvider = createD1SiteProviderRegistry({
          env: envFor(database, actualTrace),
          siteId: SITE,
        }).resolve("filter-values");
        if (!actualProvider)
          throw new Error("wave97l_filter_values_provider_missing");
        const oracle = await legacyPage(database, scope, field, {
          limit: 2,
        });
        const allItems: Array<{
          readonly value: string;
          readonly occurrences: number;
        }> = [];
        let cursor: string | null = null;
        for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
          const expected = await oracle.page(cursor);
          const actual = response(
            (
              await actualProvider.execute(
                queryFor(scope, field, { limit: 2, cursor }),
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
          allItems.push(
            ...actual.data.items.map(({ value, occurrences }) => ({
              value,
              occurrences,
            })),
          );
          const nextCursor = actual.data.pagination.nextCursor;
          expect(nextCursor).toBe(expected.pagination.nextCursor);
          if (!nextCursor) break;
          cursor = nextCursor;
          if (pageIndex === 19)
            throw new Error("wave97l_referrer_cursor_chain_unbounded");
        }
        complete[`${field}/${scope}`] = allItems;
        const allValues = allItems.map(({ value }) => value);
        expect(allValues).not.toContain("excluded.example");
        expect(allValues).not.toContain("unqualified.example");
        expect(allValues).toContain(
          field === "referrer.domain"
            ? "例子.test"
            : "https://例子.test/路径?q=值",
        );
        if (field === "referrer.domain")
          expect(
            allValues.filter((value) => value === DIRECT_REFERRER_FILTER_VALUE),
          ).toHaveLength(2);
        else {
          expect(allValues).toContain("https://Host.Example/a?x=1");
          if (scope === "visitor")
            expect(allValues).toContain("https://Host.Example/a2");
          else expect(allValues).not.toContain("https://Host.Example/a2");
        }

        for (const search of ["  HOST.Example  ", "例子"] as const) {
          const searchQuery = queryFor(scope, field, {
            limit: 10,
            search,
          });
          const filtered = response(
            (await actualProvider.execute(searchQuery)).value,
          );
          const searchOracle = await legacyPage(database, scope, field, {
            limit: 10,
            search,
          });
          const expected = await searchOracle.page(null);
          expect(filtered.data.items).toEqual(
            expected.items.map((row) => ({
              value: row.value,
              label: row.value,
              occurrences: row.occurrences,
            })),
          );
          expect(filtered.data.pagination).toEqual(expected.pagination);
        }
      }
    }
    expect(
      complete["referrer.domain/session"]!.find(
        ({ value }) => value === "Host.Example",
      )?.occurrences,
    ).toBe(3);
    expect(
      complete["referrer.domain/visitor"]!.find(
        ({ value }) => value === "Host.Example",
      )?.occurrences,
    ).toBe(4);
  });

  it("keeps referrer qualification branded and derives URL mode from field", async () => {
    const query = {
      ...queryFor("session", "referrer.url", { limit: 2 }),
      includeFullUrl: false,
    };
    const configuration =
      filterValuesQualificationConfigurationFromQuery(query);
    expect(configuration).toMatchObject({
      reportKind: "referrer",
      field: "referrer.url",
      limit: 2,
    });
    const database = createFixture();
    const env = envFor(database, traceFor());
    const prepared = await d1AdvancedFilterMiddleware(env, undefined, SITE)(
      "filter-values",
      query,
      async (value) => value,
    );
    const request = deferredFilterValuesQualificationFromQuery(prepared);
    if (!request) throw new Error("wave97l_referrer_brand_missing");
    expect(request.configuration).toMatchObject({
      reportKind: "referrer",
      field: "referrer.url",
    });
    const actualProvider = createD1SiteProviderRegistry({
      env,
      siteId: SITE,
    }).resolve("filter-values");
    if (!actualProvider)
      throw new Error("wave97l_filter_values_provider_missing");
    const overrideResult = response(
      (await actualProvider.execute(query)).value,
    );
    expect(overrideResult.data.items).toContainEqual({
      value: "https://Host.Example/a?x=1",
      label: "https://Host.Example/a?x=1",
      occurrences: 2,
    });
    const cloned = { ...(prepared as Record<string, unknown>) };
    await expect(
      queryFilterValuesPageWithQualification({
        env,
        query: cloned,
        request,
      }),
    ).rejects.toThrow("filter_values_qualification_request_changed");

    const accessor = Object.defineProperty(
      { ...queryFor("session", "referrer.url") },
      "field",
      { enumerable: true, get: () => "referrer.domain" },
    );
    expect(filterValuesQualificationConfigurationFromQuery(accessor)).toBe(
      undefined,
    );
    await expect(
      queryFilterValuesPageWithQualification({
        env,
        query: prepared,
        request: { ...request },
      }),
    ).rejects.toThrow("filter_values_qualification_request_untrusted");

    const invalidCursorQuery = {
      ...queryFor("session", "referrer.domain", { limit: 2 }),
      page: { limit: 2, cursor: "malformed-cursor" },
    };
    const invalidCursorPrepared = await d1AdvancedFilterMiddleware(
      env,
      undefined,
      SITE,
    )("filter-values", invalidCursorQuery, async (value) => value);
    const invalidCursorRequest = deferredFilterValuesQualificationFromQuery(
      invalidCursorPrepared,
    );
    if (!invalidCursorRequest)
      throw new Error("wave97l_invalid_cursor_brand_missing");
    await expect(
      queryFilterValuesPageWithQualification({
        env,
        query: invalidCursorPrepared,
        request: invalidCursorRequest,
      }),
    ).rejects.toBeInstanceOf(InvalidCursorError);
  });

  it("falls back once for an actual TEXT numeric Count guard", async () => {
    const database = createFixture();
    setDurationFixture(database);
    addNumericCursorReferrer(database);
    const trace = traceFor();
    const fusedRows: Record<string, unknown>[][] = [];
    const diagnostics = createD1ReadDiagnostics();
    const env = envFor(database, trace, (sql, rows) => {
      if (isFusedReferrerFilterValuesReport(sql)) fusedRows.push(rows);
      return rows;
    });
    const provider = createD1SiteProviderRegistry({
      env,
      siteId: SITE,
      diagnostics,
    }).resolve("filter-values");
    if (!provider) throw new Error("wave97l_filter_values_provider_missing");

    const oracleDatabase = createFixture();
    setDurationFixture(oracleDatabase);
    addNumericCursorReferrer(oracleDatabase);
    const oracle = await legacyPage(
      oracleDatabase,
      "session",
      "referrer.domain",
      { limit: 1, filterDsl: NUMERIC_COUNT_DSL },
    );
    const expected = await oracle.page(null);
    const actual = response(
      (
        await provider.execute(
          queryFor("session", "referrer.domain", {
            limit: 1,
            filterDsl: NUMERIC_COUNT_DSL,
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
    expect(actual.data.pagination.nextCursor).not.toBeNull();
    const cursor = actual.data.pagination.nextCursor;
    const expectedNext = await oracle.page(cursor);
    const actualNext = response(
      (
        await provider.execute(
          queryFor("session", "referrer.domain", {
            limit: 1,
            cursor,
            filterDsl: NUMERIC_COUNT_DSL,
          }),
        )
      ).value,
    );
    expect(actualNext.data.items).toEqual(
      expectedNext.items.map((row) => ({
        value: row.value,
        label: row.value,
        occurrences: row.occurrences,
      })),
    );
    expect(actualNext.data.pagination).toEqual(expectedNext.pagination);
    expect(diagnostics.advancedCountSqlFallbackReason).toMatchObject({
      kind: "numeric-data-domain",
    });
    expect(fusedRows).toHaveLength(2);
    for (const rows of fusedRows)
      expect(rows.filter((row) => row.rowKind === "report")).toHaveLength(0);
    expect(
      trace.preparedSql.filter(isFusedReferrerFilterValuesReport),
    ).toHaveLength(2);
  });

  it("uses the new Event-scope visit binding for numeric fallback cursor pages", async () => {
    const database = createFixture();
    setDurationFixture(database);
    addNumericCursorReferrer(database);
    const trace = traceFor();
    const guardRowsByExecution: Record<string, unknown>[][] = [];
    const diagnostics = createD1ReadDiagnostics();
    const env = envFor(database, trace, (sql, rows) => {
      if (isFusedReferrerFilterValuesReport(sql))
        guardRowsByExecution.push(rows);
      return rows;
    });
    const provider = createD1SiteProviderRegistry({
      env,
      siteId: SITE,
      diagnostics,
    }).resolve("filter-values");
    if (!provider)
      throw new Error("wave97l_event_numeric_filter_values_provider_missing");

    const oracleDatabase = createFixture();
    setDurationFixture(oracleDatabase);
    addNumericCursorReferrer(oracleDatabase);
    const options = {
      limit: 1,
      scopePreference: "event",
      filterDsl: NUMERIC_COUNT_DSL,
    } as const;
    const oracle = await legacyPage(
      oracleDatabase,
      "event",
      "referrer.domain",
      options,
    );
    const deferred = deferredEventQualificationFromQuery(
      oracle.prepared,
      "filter-values",
    );
    expect(deferred?.countInput.scope).toBe("event");
    expect(deferred?.metadata.plan.scope).toBe("event");

    const firstExpected = await oracle.page(null);
    const firstExecutionSqlOffset = trace.preparedSql.length;
    const firstActual = response(
      (await provider.execute(queryFor("event", "referrer.domain", options)))
        .value,
    );
    const firstExecutionSql = trace.preparedSql.slice(firstExecutionSqlOffset);
    const firstReportSql = firstExecutionSql.find(
      isReferrerCompatibilityPageReport,
    );
    expect(firstReportSql).toBeDefined();
    expect(firstActual.data.items).toEqual(
      firstExpected.items.map((row) => ({
        value: row.value,
        label: row.value,
        occurrences: row.occurrences,
      })),
    );
    expect(firstActual.data.pagination).toEqual(firstExpected.pagination);
    const cursor = firstActual.data.pagination.nextCursor;
    expect(cursor).not.toBeNull();

    const nextExpected = await oracle.page(cursor);
    const nextExecutionSqlOffset = trace.preparedSql.length;
    const nextActual = response(
      (
        await provider.execute(
          queryFor("event", "referrer.domain", { ...options, cursor }),
        )
      ).value,
    );
    const nextExecutionSql = trace.preparedSql.slice(nextExecutionSqlOffset);
    const nextReportSql = nextExecutionSql.find(
      isReferrerCompatibilityPageReport,
    );
    expect(nextReportSql).toBeDefined();
    expect(nextActual.data.items).toEqual(
      nextExpected.items.map((row) => ({
        value: row.value,
        label: row.value,
        occurrences: row.occurrences,
      })),
    );
    expect(nextActual.data.pagination).toEqual(nextExpected.pagination);
    expect(diagnostics.advancedCountSqlFallbackReason).toMatchObject({
      kind: "numeric-data-domain",
    });
    expect(guardRowsByExecution).toHaveLength(2);
    for (const rows of guardRowsByExecution) {
      expect(rows.filter((row) => row.rowKind === "control")).not.toHaveLength(
        0,
      );
      expect(rows.filter((row) => row.rowKind === "report")).toHaveLength(0);
    }
    for (const sql of [firstReportSql, nextReportSql]) {
      expect(sql).toMatch(/\bvisit_id\b/i);
      expect(sql).not.toMatch(/\bentity_id\b/i);
    }
  });

  it.each([
    { changed: "limit", field: "referrer.domain", limit: 2 },
    { changed: "field", field: "referrer.url", limit: 1 },
    {
      changed: "search",
      field: "referrer.domain",
      limit: 1,
      search: "third",
    },
    { changed: "cursor", field: "referrer.domain", limit: 1 },
  ] as const)(
    "rejects a changed FilterValues $changed projection even with its old key",
    async ({ changed, field, limit, search }) => {
      const database = createFixture();
      setDurationFixture(database);
      addNumericCursorReferrer(database);
      const trace = traceFor();
      const env = envFor(database, trace);
      const originalOptions = {
        limit: 1,
        scopePreference: "event",
        filterDsl: NUMERIC_COUNT_DSL,
      } as const;
      const originalQuery = queryFor(
        "event",
        "referrer.domain",
        originalOptions,
      );
      let cursor: string | null = null;
      if (changed === "cursor") {
        const provider = createD1SiteProviderRegistry({
          env,
          siteId: SITE,
        }).resolve("filter-values");
        if (!provider)
          throw new Error("wave97l_changed_cursor_provider_missing");
        cursor = response((await provider.execute(originalQuery)).value).data
          .pagination.nextCursor;
        expect(cursor).not.toBeNull();
      }
      const prepared = await d1AdvancedFilterMiddleware(env, undefined, SITE)(
        "filter-values",
        originalQuery,
        async (value) => value,
      );
      const deferred = deferredEventQualificationFromQuery(
        prepared,
        "filter-values",
      );
      if (!deferred?.requestTime)
        throw new Error("wave97l_changed_projection_deferred_missing");
      const oldKey = filterValuesPageQualificationConsumerKey({
        field: "referrer.domain",
        limit: 1,
        cursorToken: null,
        search: undefined,
        audience: "private-dashboard",
      });
      const preparation = await prepareDeferredPageVisitQualification(
        deferred,
        oldKey,
      );
      if (!preparation)
        throw new Error("wave97l_changed_projection_preparation_missing");
      const statementsBefore = trace.preparedSql.length;
      const qualification = {
        preparation,
        queryTime: deferred.requestTime,
        scopePlan: deferred.metadata.plan,
        consumerKey: oldKey,
      } as never;
      await expect(
        queryFilterValuesPageFromD1(
          env,
          SITE,
          WINDOW,
          deferred.filters,
          field,
          limit,
          changed === "cursor" ? cursor : null,
          search,
          "private-dashboard",
          qualification,
        ),
      ).rejects.toThrow("qualification_execution_plan_snapshot_mismatch");
      expect(trace.preparedSql).toHaveLength(statementsBefore);
    },
  );

  it.each([
    {
      kind: "missing-control",
      message: "filter_values_qualification_control_row_invalid",
    },
    {
      kind: "repeated-control",
      message: "filter_values_qualification_control_row_invalid",
    },
    {
      kind: "unknown-output",
      message: "filter_values_qualification_report_row_invalid",
    },
    {
      kind: "invalid-control-scalar",
      message: "filter_values_qualification_control_invalid:rawCount",
    },
    {
      kind: "gate-leak",
      message: "filter_values_qualification_gate_violation",
    },
    {
      kind: "invalid-value",
      message: "filter_values_qualification_report_value_invalid",
    },
    {
      kind: "invalid-views",
      message: "filter_values_qualification_report_views_invalid",
    },
    {
      kind: "duplicate-raw-value",
      message: "filter_values_qualification_report_value_repeated",
    },
  ] as const)(
    "rejects referrer $kind protocol corruption without retry",
    async ({ kind, message }) => {
      const database = createFixture();
      const trace = traceFor();
      const provider = createD1SiteProviderRegistry({
        env: envFor(database, trace, (sql, rows) => {
          if (!isFusedReferrerFilterValuesReport(sql)) return rows;
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
          if (kind === "gate-leak")
            return rows.map((row) =>
              row.rowKind === "control"
                ? { ...row, nullActivityIdCount: 1 }
                : row,
            );
          if (kind === "invalid-value")
            return rows.map((row) =>
              row.rowKind === "report" ? { ...row, referrer: 7 } : row,
            );
          if (kind === "invalid-views")
            return rows.map((row) =>
              row.rowKind === "report" ? { ...row, views: "1" } : row,
            );
          const second = reports[1];
          if (!second) throw new Error("wave97l_second_referrer_row_missing");
          return rows.map((row) =>
            row === second ? { ...row, referrer: reports[0]!.referrer } : row,
          );
        }),
        siteId: SITE,
      }).resolve("filter-values");
      if (!provider) throw new Error("wave97l_filter_values_provider_missing");
      await expect(
        provider.execute(queryFor("session", "referrer.domain", { limit: 2 })),
      ).rejects.toThrow(message);
      expect(
        trace.preparedSql.filter(isFusedReferrerFilterValuesReport),
      ).toHaveLength(1);
    },
  );

  it("prioritizes Count caps over malformed cursors and propagates aborts and D1 errors", async () => {
    const cappedDatabase = createFixture();
    const cappedTrace = traceFor();
    const cappedProvider = createD1SiteProviderRegistry({
      env: envFor(cappedDatabase, cappedTrace, (sql, rows) =>
        isFusedReferrerFilterValuesReport(sql)
          ? rows.map((row) =>
              row.rowKind === "control"
                ? { ...row, rawCount: ADVANCED_FILTER_MAX_ACTIVITIES + 1 }
                : row,
            )
          : rows,
      ),
      siteId: SITE,
    }).resolve("filter-values");
    if (!cappedProvider)
      throw new Error("wave97l_filter_values_provider_missing");
    await expect(
      cappedProvider.execute(
        queryFor("session", "referrer.domain", {
          limit: 2,
          cursor: "malformed-cursor",
        }),
      ),
    ).rejects.toMatchObject({
      domainError: {
        kind: "invalid-input",
        issues: [{ path: "filters", code: "filter_activity_limit_exceeded" }],
      },
    });
    expect(
      cappedTrace.preparedSql.filter(isFusedReferrerFilterValuesReport),
    ).toHaveLength(1);

    const failure = new Error("wave97l_referrer_d1_failure");
    const failingDatabase = createFixture();
    const failingTrace = traceFor();
    const failingProvider = createD1SiteProviderRegistry({
      env: envFor(failingDatabase, failingTrace, (sql, rows) => {
        if (isFusedReferrerFilterValuesReport(sql)) throw failure;
        return rows;
      }),
      siteId: SITE,
    }).resolve("filter-values");
    if (!failingProvider)
      throw new Error("wave97l_filter_values_provider_missing");
    await expect(
      failingProvider.execute(
        queryFor("session", "referrer.domain", { limit: 2 }),
      ),
    ).rejects.toBe(failure);
    expect(
      failingTrace.preparedSql.filter(isFusedReferrerFilterValuesReport),
    ).toHaveLength(1);

    const abortedDatabase = createFixture();
    const abortedTrace = traceFor();
    const abortedEnv = envFor(abortedDatabase, abortedTrace);
    const controller = new AbortController();
    const prepared = await d1AdvancedFilterMiddleware(
      abortedEnv,
      undefined,
      SITE,
    )(
      "filter-values",
      queryFor("session", "referrer.domain", { limit: 2 }),
      async (value) => value,
      { signal: controller.signal },
    );
    const request = deferredFilterValuesQualificationFromQuery(prepared);
    if (!request) throw new Error("wave97l_referrer_brand_missing");
    controller.abort();
    await expect(
      queryFilterValuesPageWithQualification({
        env: abortedEnv,
        query: prepared,
        request,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(
      abortedTrace.preparedSql.filter(isFusedReferrerFilterValuesReport),
    ).toHaveLength(0);
  });
});

afterAll(async () => {
  for (const database of databases) database.close();
  const directory = process.env.WAVE97L_ARTIFACT_DIR;
  if (directory) {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(directory, { recursive: true });
    if (process.env.WAVE97L_CAPTURE_BEFORE === "1") {
      await writeFile(
        `${directory}/filter-values-referrers-before.json`,
        JSON.stringify(
          {
            source:
              "actual filter-values/referrer.domain and referrer.url routes before Wave97L",
            evidence: baselineEvidence,
          },
          null,
          2,
        ),
        "utf8",
      );
      await writeFile(
        `${directory}/filter-values-referrers-preflight.json`,
        JSON.stringify(
          {
            source:
              "four actual Count + Referrers page preflight plans from SQLite D1 fixture",
            evidence: preflightEvidence,
          },
          null,
          2,
        ),
        "utf8",
      );
    }
    if (process.env.WAVE97L_CAPTURE_AFTER === "1") {
      await writeFile(
        `${directory}/filter-values-referrers-after.json`,
        JSON.stringify(
          {
            source:
              "actual filter-values/referrer.domain and referrer.url routes after Wave97L",
            evidence: baselineEvidence,
          },
          null,
        ),
        "utf8",
      );
    }
  }
  const wave97dvDirectory = process.env.WAVE97DV_ARTIFACT_DIR;
  if (wave97dvDirectory && wave97dvEvidence.length > 0) {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(wave97dvDirectory, { recursive: true });
    await writeFile(
      `${wave97dvDirectory}/filter-values-referrers-whole-boolean.json`,
      JSON.stringify(
        { wave: "97DV", reportKind: "referrer", evidence: wave97dvEvidence },
        null,
        2,
      ),
      "utf8",
    );
  }
});
