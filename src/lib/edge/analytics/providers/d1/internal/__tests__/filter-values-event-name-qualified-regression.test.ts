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
import { EMPTY_FILTER_DOCUMENT } from "@/lib/edge/analytics/contract";
import { createQueryTime } from "@/lib/edge/analytics/contract/helpers";
import { EVENT_QUALIFICATION_CONTROL_OUTPUT } from "@/lib/edge/analytics/engine/event-qualified-source-plan";
import {
  buildEventTypeSummaryQualificationPlan,
  EVENT_TYPE_SUMMARY_OUTPUTS,
} from "@/lib/edge/analytics/engine/event-type-summary-plan";
import {
  d1AdvancedFilterMiddleware,
  deferredEventNameDimensionQualificationFromQuery,
  deferredEventQualificationFromQuery,
  prepareDeferredEventQualificationFallback,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { queryD1CompiledAll } from "@/lib/edge/analytics/providers/d1/internal/core";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import { queryFilterValuesPageFromD1 } from "@/lib/edge/analytics/providers/d1/internal/filter-values";
import { compileFilterValuesQualificationProgram } from "@/lib/edge/analytics/providers/d1/internal/filter-values-qualification-program";
import { queryFilterValuesPageWithQualification } from "@/lib/edge/analytics/providers/d1/internal/filter-values-qualification-program";
import {
  deferredFilterValuesQualificationFromQuery,
  filterValuesQualificationConfigurationFromQuery,
} from "@/lib/edge/analytics/providers/d1/internal/filter-values-qualification-request";
import { compileQualificationProgramEnvelope } from "@/lib/edge/analytics/providers/d1/internal/qualification-program-envelope";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import type { FilterDocument } from "@/lib/filter-contract/filters";
import { InvalidCursorError } from "@/lib/pagination";

const SITE = "wave97k-filter-values-event-name";
const TEAM = "wave97k-filter-values-team";
const TIME = createQueryTime(120, 130, "UTC", 500);
const WINDOW = {
  startMs: TIME.range.startMs,
  endExclusiveMs: TIME.range.endExclusiveMs,
  nowMs: TIME.capturedAtMs,
  timeZone: TIME.reportingTimeZone,
} as const;
const FILTER_DSL =
  'page.path neq "/excluded" and count(event { event.name eq "qualifier" }) eq 1';
const REPORT_FIELDS = ["value", "views", "sessions", "visitors"] as const;
const EXPECTED_EVENT_NAME_VALUES = {
  session: [
    "Alpha",
    "alpha",
    "qualifier",
    "Beta",
    "excluded-only",
    "visitor-y-visible",
    " \u00a0 ",
    "Zeta",
    "delta",
    "with space ",
  ],
  visitor: [
    "Beta",
    "Alpha",
    "alpha",
    "visitor-expansion",
    "qualifier",
    "excluded-expansion",
    "excluded-only",
    "visitor-y-visible",
    " \u00a0 ",
    "Zeta",
    "delta",
    "with space ",
  ],
} as const;
const DATABASES = new Set<DatabaseSync>();
const beforeEvidence: Array<Record<string, unknown>> = [];
const afterEvidence: Array<Record<string, unknown>> = [];
const wave97dvEvidence: Array<Record<string, unknown>> = [];

interface QueryOptions {
  readonly limit?: number;
  readonly cursor?: string | null;
  readonly search?: string;
  readonly filters?: FilterDocument;
  readonly filterDsl?: string;
  readonly scopePreference?: "session" | "visitor";
}

interface SiteFilterValuesPage {
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

function sitePage(value: unknown): SiteFilterValuesPage {
  return value as SiteFilterValuesPage;
}

function setDurationFixture(database: DatabaseSync): void {
  database
    .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
    .run(10, "visit-a-included");
  database
    .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
    .run("invalid-duration", "visit-b-included");
}

const NUMERIC_COUNT_DSL = `${FILTER_DSL} and count(page { page.durationMs gt 5 }) eq 1`;

function traceFor(): SqliteD1Trace {
  return { preparedSql: [], bindings: [] };
}

function traceEvidence(trace: SqliteD1Trace) {
  return trace.preparedSql.map((sql, index) => ({
    sql,
    bindings: trace.bindings[index] ?? [],
  }));
}

function wave97dvStatementClass(sql: string): string {
  if (isFusedEventFilterValuesReport(sql)) return "fact-envelope";
  if (/\bfrom\s+(?:["`]sites["`]|sites)(?:\s|$)/i.test(sql))
    return "site-metadata";
  return "other";
}

function isFusedEventFilterValuesReport(sql: string): boolean {
  return (
    sql.includes("rowKind") &&
    sql.includes("outputId") &&
    sql.includes(EVENT_TYPE_SUMMARY_OUTPUTS.page) &&
    sql.includes(EVENT_QUALIFICATION_CONTROL_OUTPUT)
  );
}

function createFixture(): DatabaseSync {
  const database = createMigratedDatabase();
  DATABASES.add(database);
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
       VALUES (?, ?, 'Event-name filter values', 'wave97k.test', 0)`,
    )
    .run(SITE, TEAM);

  const names = [
    "qualifier",
    "Alpha",
    "alpha",
    "Beta",
    "delta",
    " \u00a0 ",
    "with space ",
    "Zeta",
    "visitor-expansion",
    "excluded-only",
    "excluded-expansion",
    "visitor-y-visible",
    "bad-count-visible",
    "owner-filter-leak-visible",
  ];
  const insertName = database.prepare(
    `INSERT INTO custom_event_names (id, site_id, name, last_seen_at, site_pk)
     VALUES (?, ?, ?, 129, ?)`,
  );
  names.forEach((name, index) => insertName.run(index + 1, SITE, name, sitePk));
  const nameIds = new Map(names.map((name, index) => [name, index + 1]));

  const visits = [
    ["visit-a-included", "session-a", "visitor-shared", "/included"],
    ["visit-a-excluded", "session-a", "visitor-shared", "/excluded"],
    ["visit-b-included", "session-b", "visitor-shared", "/included"],
    ["visit-b-excluded", "session-b", "visitor-shared", "/excluded"],
    ["visit-y-excluded", "session-y", "visitor-y", "/excluded"],
    ["visit-y-included", "session-y", "visitor-y", "/included"],
    ["visit-bad-count", "session-bad", "visitor-bad", "/included"],
    [
      "visit-owner-excluded-only",
      "session-owner-excluded-only",
      "visitor-owner-excluded-only",
      "/excluded",
    ],
  ] as const;
  const insertVisit = database.prepare(
    `INSERT INTO visits (
       visit_id, site_id, site_pk, visitor_id, session_id, status,
       started_at, last_activity_at, pathname, hostname, referrer_host
     ) VALUES (?, ?, ?, ?, ?, 'closed', 125, 125, ?, 'wave97k.test', ?)`,
  );
  for (const [id, sessionId, visitorId, pathname] of visits) {
    insertVisit.run(
      id,
      SITE,
      sitePk,
      visitorId,
      sessionId,
      pathname,
      pathname === "/excluded" ? "excluded.example" : "included.example",
    );
  }

  let sequence = 0;
  const insertEvent = database.prepare(
    `INSERT INTO custom_events (
       event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
       received_at, sequence, node_count, value_count
     ) VALUES (?, ?, ?, ?, ?, 125, 125, ?, 0, 0)`,
  );
  const add = (visitId: string, name: string, count = 1) => {
    const eventNameId = nameIds.get(name);
    if (eventNameId === undefined)
      throw new Error(`wave97k_fixture_event_name_missing:${name}`);
    for (let index = 0; index < count; index += 1) {
      sequence += 1;
      insertEvent.run(
        `event-${sequence}`,
        SITE,
        sitePk,
        visitId,
        eventNameId,
        sequence,
      );
    }
  };
  add("visit-a-included", "qualifier");
  add("visit-a-included", "Alpha", 3);
  add("visit-a-included", "alpha", 3);
  add("visit-a-included", "Beta", 2);
  add("visit-a-included", "delta");
  add("visit-a-included", " \u00a0 ");
  add("visit-a-included", "with space ");
  add("visit-a-included", "Zeta");
  add("visit-a-excluded", "excluded-only", 2);
  add("visit-b-included", "visitor-expansion", 3);
  add("visit-b-included", "Beta");
  add("visit-b-excluded", "excluded-expansion", 2);
  add("visit-y-excluded", "qualifier");
  add("visit-y-included", "visitor-y-visible", 2);
  add("visit-bad-count", "qualifier", 2);
  add("visit-bad-count", "bad-count-visible");
  add("visit-owner-excluded-only", "qualifier");
  add("visit-owner-excluded-only", "owner-filter-leak-visible");
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
    MAIN_SECRET: "wave97k-event-name-test-secret",
    DAILY_SALT_SECRET: "wave97k-event-name-daily-secret",
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
    filters:
      options.filters ??
      parseFilterDsl(options.filterDsl ?? FILTER_DSL, analyticsFilterRegistry),
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

async function legacyPage(
  database: DatabaseSync,
  scope: "session" | "visitor",
  field: string,
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
  return { page, trace, query, prepared };
}

function eventNameDimensionQuery(scope: "session" | "visitor") {
  const prepared = prepareScopedQuery("dimension", {
    context: siteQueryContext(SITE, "private-dashboard"),
    time: TIME,
    filters: parseFilterDsl(FILTER_DSL, analyticsFilterRegistry),
    scopePreference: scope,
  } as QueryInput & { readonly time: QueryTime });
  return {
    ...prepared,
    mode: "breakdown" as const,
    dimension: "event.name" as const,
    limit: 2,
    page: { limit: 2, cursor: null },
  };
}

function outputById(
  plan: ReturnType<typeof buildEventTypeSummaryQualificationPlan>["plan"],
  id: string,
) {
  const matches = plan.outputs.filter((output) => output.id === id);
  if (matches.length !== 1)
    throw new Error(`wave97k_preflight_output_missing:${id}`);
  return matches[0]!;
}

async function preflightEventPage(
  scope: "session" | "visitor",
  database: DatabaseSync,
  limit = 2,
) {
  const trace = traceFor();
  const env = envFor(database, trace);
  const query = eventNameDimensionQuery(scope);
  const prepared = await d1AdvancedFilterMiddleware(env, undefined, SITE)(
    "dimension",
    query,
    async (value) => value,
  );
  const eventDimensionDeferred =
    deferredEventNameDimensionQualificationFromQuery(prepared);
  if (!eventDimensionDeferred)
    throw new Error("wave97k_event_name_dimension_preflight_not_prepared");
  const filterValuesPrepared = await d1AdvancedFilterMiddleware(
    env,
    undefined,
    SITE,
  )(
    "filter-values",
    queryFor(scope, "event.name", { limit }),
    async (value) => value,
  );
  const filterValuesDeferred = deferredEventQualificationFromQuery(
    filterValuesPrepared,
    "filter-values",
  );
  if (!filterValuesDeferred)
    throw new Error("wave97k_filter_values_preflight_not_prepared");
  const plan = buildEventTypeSummaryQualificationPlan({
    siteId: SITE,
    count: filterValuesDeferred.countInput,
    reportFilters: eventDimensionDeferred.eventNameDimensionReportFilters,
    query: {
      kind: "page",
      limit,
      search: "",
    },
  });
  const report = outputById(plan.plan, EVENT_TYPE_SUMMARY_OUTPUTS.page);
  const controls = outputById(plan.plan, EVENT_QUALIFICATION_CONTROL_OUTPUT);
  const compilation = compileQualificationProgramEnvelope({
    qualification: plan,
    siteId: SITE,
    reports: [
      { output: report, fields: REPORT_FIELDS, rowType: "event-type-page" },
    ],
    controlsOutput: controls,
    reportFields: REPORT_FIELDS,
    controlFields: controls.fields.map(({ name }) => name),
    ordering: [
      {
        field: "views",
        outputId: EVENT_TYPE_SUMMARY_OUTPUTS.page,
        direction: "desc",
        nulls: "last",
      },
      {
        field: "sessions",
        outputId: EVENT_TYPE_SUMMARY_OUTPUTS.page,
        direction: "desc",
        nulls: "last",
      },
      {
        field: "value",
        outputId: EVENT_TYPE_SUMMARY_OUTPUTS.page,
        direction: "asc",
        nulls: "last",
      },
    ],
    errorPrefix: "wave97k_event_filter_values_preflight",
    fallbackTag: "analytics.filter_values_event_name_preflight",
    signal: filterValuesDeferred.signal,
  });
  if (compilation.kind !== "compiled")
    throw new Error("wave97k_event_name_page_preflight_unavailable");
  const rows = await queryD1CompiledAll<Record<string, unknown>>(
    env,
    compilation.query,
  );
  expect(compilation.evidence.sqlBytes).toBeLessThan(100_000);
  expect(compilation.evidence.bindingCount).toBeLessThanOrEqual(100);
  return {
    case: `event-preflight/${scope}`,
    sql: compilation.evidence.sql,
    bindings: compilation.evidence.bindings,
    sqlBytes: compilation.evidence.sqlBytes,
    bindingCount: compilation.evidence.bindingCount,
    reportSources: compilation.evidence.reportSourceRelations,
    rootKind: compilation.evidence.rootKind,
    groupWidth: compilation.evidence.groupWidth,
    sharedRelationCount: compilation.evidence.sharedRelationCount,
    groupedSummaryProof: compilation.evidence.groupedSummaryProof,
    controlOutputId: compilation.evidence.controlOutputId,
    controlFields: compilation.evidence.controlFields,
    outputDescriptors: compilation.evidence.outputDescriptors,
    ordering: compilation.evidence.ordering,
    rows,
    tracedStatements: traceEvidence(trace),
  };
}

afterAll(async () => {
  for (const database of DATABASES) database.close();
  const directory = process.env.WAVE97K_ARTIFACT_DIR;
  if (process.env.WAVE97K_CAPTURE_BEFORE === "1" && directory) {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(directory, { recursive: true });
    await writeFile(
      `${directory}/filter-values-event-name-before.json`,
      JSON.stringify(
        {
          source: "actual filter-values/event.name route before Wave97K",
          evidence: beforeEvidence,
        },
        null,
        2,
      ),
      "utf8",
    );
  }
  if (process.env.WAVE97K_CAPTURE_AFTER === "1" && directory) {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(directory, { recursive: true });
    await writeFile(
      `${directory}/filter-values-event-name-after.json`,
      JSON.stringify(
        {
          source: "actual filter-values/event.name route after Wave97K",
          evidence: afterEvidence,
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
      `${wave97dvDirectory}/filter-values-event-name-whole-boolean.json`,
      JSON.stringify(
        { wave: "97DV", reportKind: "event.name", evidence: wave97dvEvidence },
        null,
        2,
      ),
      "utf8",
    );
  }
});

describe("filter-values event.name qualification baseline", () => {
  it("97DV preserves whole OR/NOT ownership for the event.name report", async () => {
    const filterDsl =
      '(page.path eq "/included" and not (count(event { event.name eq "owner-filter-leak-visible" }) eq 1)) or count(event { event.name eq "owner-filter-leak-visible" }) eq 1';
    const wrongAndDsl =
      'page.path eq "/included" and count(event { event.name eq "owner-filter-leak-visible" }) eq 1';
    const database = createFixture();
    const trace = traceFor();
    const diagnostics = createD1ReadDiagnostics();
    const provider = createD1SiteProviderRegistry({
      env: envFor(database, trace),
      siteId: SITE,
      diagnostics,
    }).resolve("filter-values");
    if (!provider)
      throw new Error("wave97dv_event_filter_values_provider_missing");
    const actualResult = await provider.execute(
      queryFor("visitor", "event.name", { limit: 30, filterDsl }),
    );
    const actual = sitePage(actualResult.value);

    const oracle = await legacyPage(createFixture(), "visitor", "event.name", {
      limit: 30,
      filterDsl,
    });
    const expected = await oracle.page(null);
    const legacyDto = {
      field: "event.name",
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
      "event.name",
      { limit: 30, filterDsl: wrongAndDsl },
    );
    const wrongAnd = await wrongAndOracle.page(null);
    const factStatements = trace.preparedSql.filter(
      isFusedEventFilterValuesReport,
    );
    const statementClasses = trace.preparedSql.map(wave97dvStatementClass);

    wave97dvEvidence.push({
      contract: "event-name-visitor-whole-or-not",
      filterDsl,
      countOnlyOwner:
        "visitor-owner-excluded-only (owner-filter-leak-visible; no /included page)",
      nativeOnlyOwner:
        "visitor-bad (/included page; no owner-filter-leak-visible event)",
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
      expect.arrayContaining([
        "owner-filter-leak-visible",
        "bad-count-visible",
      ]),
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

  it("captures actual event, Page, and special-route before evidence", async () => {
    const fixtureForPreflight = createFixture();
    beforeEvidence.push(
      await preflightEventPage("session", fixtureForPreflight),
    );
    const visitorPreflightDatabase = createFixture();
    beforeEvidence.push(
      await preflightEventPage("visitor", visitorPreflightDatabase),
    );
    for (const scope of ["session", "visitor"] as const) {
      const widePreflight = await preflightEventPage(
        scope,
        createFixture(),
        500,
      );
      const reportValues = widePreflight.rows
        .filter((row) => row.rowKind === "report")
        .map((row) => row.value);
      expect(reportValues).toEqual(EXPECTED_EVENT_NAME_VALUES[scope]);
      beforeEvidence.push(widePreflight);
    }

    for (const scope of ["session", "visitor"] as const) {
      const database = createFixture();
      const actualTrace = traceFor();
      const provider = createD1SiteProviderRegistry({
        env: envFor(database, actualTrace),
        siteId: SITE,
      }).resolve("filter-values");
      if (!provider) throw new Error("wave97k_filter_values_provider_missing");
      const query = queryFor(scope, "event.name", { limit: 2 });
      const actual = await provider.execute(query);
      const oracle = await legacyPage(createFixture(), scope, "event.name", {
        limit: 2,
      });
      const expected = await oracle.page(null);
      const actualValue = actual.value as {
        readonly field: string;
        readonly data: {
          readonly items: readonly {
            readonly value: string;
            readonly label: string;
            readonly occurrences: number;
          }[];
          readonly pagination: unknown;
        };
      };
      expect(actualValue.field).toBe("event.name");
      expect(actualValue.data.items).toEqual(
        expected.items.map((row) => ({
          value: row.value,
          label: row.value,
          occurrences: row.occurrences,
        })),
      );
      expect(actualValue.data.pagination).toEqual(expected.pagination);
      const eventEvidence = {
        case: `event-name-before/${scope}`,
        source: "actual site registry and legacy filter-values oracle",
        actual: actualValue,
        expected,
        actualStatements: traceEvidence(actualTrace),
        actualStatementCount: actualTrace.preparedSql.length,
        oracleStatements: traceEvidence(oracle.trace),
        oracleStatementCount: oracle.trace.preparedSql.length,
      };
      beforeEvidence.push(eventEvidence);
      afterEvidence.push({
        ...eventEvidence,
        case: `event-name-after/${scope}`,
      });
    }

    const pageDatabase = createFixture();
    const pageTrace = traceFor();
    const pageProvider = createD1SiteProviderRegistry({
      env: envFor(pageDatabase, pageTrace),
      siteId: SITE,
    }).resolve("filter-values");
    if (!pageProvider) throw new Error("wave97k_page_provider_missing");
    const pageResult = await pageProvider.execute(
      queryFor("session", "page.path", { limit: 2 }),
    );
    const pageEvidence = {
      case: "ordinary-page-before/session",
      result: pageResult.value,
      statementCount: pageTrace.preparedSql.length,
      statements: traceEvidence(pageTrace),
    };
    beforeEvidence.push(pageEvidence);
    afterEvidence.push({
      ...pageEvidence,
      case: "ordinary-page-after/session",
    });

    const specialDatabase = createFixture();
    const specialTrace = traceFor();
    const specialProvider = createD1SiteProviderRegistry({
      env: envFor(specialDatabase, specialTrace),
      siteId: SITE,
    }).resolve("filter-values");
    if (!specialProvider) throw new Error("wave97k_special_provider_missing");
    const specialResult = await specialProvider.execute(
      queryFor("session", "referrer.domain", {
        filters: EMPTY_FILTER_DOCUMENT,
        limit: 2,
      }),
    );
    const specialEvidence = {
      case: "referrer-domain-no-advanced-before",
      result: specialResult.value,
      statementCount: specialTrace.preparedSql.length,
      statements: traceEvidence(specialTrace),
    };
    beforeEvidence.push(specialEvidence);
    afterEvidence.push({
      ...specialEvidence,
      case: "referrer-domain-no-advanced-after",
    });
  });

  it("preserves event.name pages, cursors, search, and native Page ownership", async () => {
    for (const scope of ["session", "visitor"] as const) {
      const database = createFixture();
      const trace = traceFor();
      const provider = createD1SiteProviderRegistry({
        env: envFor(database, trace),
        siteId: SITE,
      }).resolve("filter-values");
      if (!provider) throw new Error("wave97k_filter_values_provider_missing");

      const oracle = await legacyPage(createFixture(), scope, "event.name", {
        limit: 2,
      });
      const values: string[] = [];
      const actualPages: unknown[] = [];
      const legacyPages: unknown[] = [];
      let cursor: string | null = null;
      for (let pageNumber = 0; pageNumber < 8; pageNumber += 1) {
        const actual = await provider.execute(
          queryFor(scope, "event.name", { limit: 2, cursor }),
        );
        const data = (
          actual.value as {
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
        ).data;
        const expected = await oracle.page(cursor);
        expect(data.items).toEqual(
          expected.items.map((row) => ({
            value: row.value,
            label: row.value,
            occurrences: row.occurrences,
          })),
        );
        expect(data.pagination).toEqual(expected.pagination);
        actualPages.push(data);
        legacyPages.push(expected);
        values.push(...data.items.map(({ value }) => value));
        if (!data.pagination.hasMore) break;
        cursor = data.pagination.nextCursor;
        expect(cursor).toEqual(expected.pagination.nextCursor);
        if (pageNumber === 7) throw new Error("wave97k_page_loop_limit");
      }

      if (scope === "session") {
        expect(values).toEqual(EXPECTED_EVENT_NAME_VALUES.session);
      } else {
        expect(values).toEqual(EXPECTED_EVENT_NAME_VALUES.visitor);
      }

      const oldFirst = await oracle.page(null);
      const oldCursor = oldFirst.pagination.nextCursor;
      expect(oldCursor).not.toBeNull();
      const qualifiedSecond = await provider.execute(
        queryFor(scope, "event.name", { limit: 2, cursor: oldCursor }),
      );
      const qualifiedSecondData = (
        qualifiedSecond.value as {
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
      ).data;
      const expectedSecond = await oracle.page(oldCursor);
      expect(qualifiedSecondData.items).toEqual(
        expectedSecond.items.map((row) => ({
          value: row.value,
          label: row.value,
          occurrences: row.occurrences,
        })),
      );
      expect(qualifiedSecondData.pagination).toEqual(expectedSecond.pagination);
      const newCursor = qualifiedSecondData.pagination.nextCursor;
      expect(newCursor).not.toBeNull();
      const oldThird = await oracle.page(newCursor);
      const expectedThird = {
        items: oldThird.items.map((row) => ({
          value: row.value,
          label: row.value,
          occurrences: row.occurrences,
        })),
        pagination: oldThird.pagination,
      };
      const qualifiedThird = await provider.execute(
        queryFor(scope, "event.name", { limit: 2, cursor: newCursor }),
      );
      expect(qualifiedThird.value).toMatchObject({
        field: "event.name",
        data: expectedThird,
      });

      const searched = await provider.execute(
        queryFor(scope, "event.name", { limit: 2, search: "  ALP  " }),
      );
      const searchOracle = await legacyPage(
        createFixture(),
        scope,
        "event.name",
        { limit: 2, search: "  ALP  " },
      );
      const expectedSearch = await searchOracle.page(null);
      const searchedData = (
        searched.value as {
          readonly data: {
            readonly items: readonly {
              readonly value: string;
              readonly label: string;
              readonly occurrences: number;
            }[];
            readonly pagination: unknown;
          };
        }
      ).data;
      expect(searchedData.items).toEqual(
        expectedSearch.items.map((row) => ({
          value: row.value,
          label: row.value,
          occurrences: row.occurrences,
        })),
      );
      expect(searchedData.pagination).toEqual(expectedSearch.pagination);
      expect(trace.preparedSql.length).toBeGreaterThan(0);
      afterEvidence.push({
        case: `event-name-pagination-after/${scope}`,
        values,
        actualPages,
        legacyPages,
        legacyQualifiedLegacy: {
          legacyFirst: oldFirst,
          qualifiedSecond: qualifiedSecondData,
          legacyThird: oldThird,
        },
        searched: searchedData,
        expectedSearch,
        statementCount: trace.preparedSql.length,
        statements: traceEvidence(trace),
      });
    }
  });

  it("brands only the Event report shape and compiles its native owner source", async () => {
    for (const scope of ["session", "visitor"] as const) {
      const database = createFixture();
      const trace = traceFor();
      const env = envFor(database, trace);
      const query = queryFor(scope, "event.name", { limit: 2 });
      const prepared = await d1AdvancedFilterMiddleware(env, undefined, SITE)(
        "filter-values",
        query,
        async (value) => value,
      );
      const request = deferredFilterValuesQualificationFromQuery(prepared);
      if (!request)
        throw new Error("wave97k_filter_values_event_brand_missing");
      const configuration =
        filterValuesQualificationConfigurationFromQuery(prepared);
      expect(configuration).toMatchObject({
        reportKind: "event",
        field: "event.name",
        limit: 2,
        audience: "private-dashboard",
      });
      expect(configuration).not.toHaveProperty("selection");
      expect(request.operation).toBe("filter-values");
      expect(request.qualification.operation).toBe("filter-values");
      expect(
        request.qualification.filterValuesReportFilters?.root,
      ).toBeDefined();

      const clonedQuery = { ...(prepared as Record<string, unknown>) };
      await expect(
        queryFilterValuesPageWithQualification({
          env,
          query: clonedQuery,
          request,
        }),
      ).rejects.toThrow("filter_values_qualification_request_changed");

      const compilation = compileFilterValuesQualificationProgram({
        request,
        cursor: null,
      });
      if (compilation.kind !== "compiled")
        throw new Error("wave97k_event_report_compile_unavailable");
      expect(compilation.evidence.sqlBytes).toBeLessThan(100_000);
      expect(compilation.evidence.bindingCount).toBeLessThanOrEqual(100);
      expect(compilation.evidence.outputDescriptors).toEqual([
        {
          outputId: EVENT_TYPE_SUMMARY_OUTPUTS.page,
          rowType: "event-type-page",
          fields: [...REPORT_FIELDS],
        },
      ]);
      expect(compilation.evidence.controlOutputId).toBe(
        EVENT_QUALIFICATION_CONTROL_OUTPUT,
      );
      expect(compilation.evidence.reportSourceRelations).toHaveLength(1);
      expect(compilation.evidence.reportSourceRelations[0]?.entity).toBe(
        "event",
      );
      expect(compilation.evidence.groupedSummaryProof).toMatchObject({
        source: "local-plan",
        nodeKind: "aggregate",
        groupKeyCount: 2,
        fieldCount: 7,
        matchingSharedRelationCount: 1,
        materialization: "materialized",
      });
      expect(
        trace.preparedSql.filter(isFusedEventFilterValuesReport),
      ).toHaveLength(0);
      let fieldGetterReads = 0;
      const accessorQuery = { ...query } as Record<string, unknown>;
      Object.defineProperty(accessorQuery, "field", {
        enumerable: true,
        get() {
          fieldGetterReads += 1;
          throw new Error("field getter must not run");
        },
      });
      expect(
        filterValuesQualificationConfigurationFromQuery(accessorQuery),
      ).toBeUndefined();
      expect(fieldGetterReads).toBe(0);
      expect(
        filterValuesQualificationConfigurationFromQuery({
          ...query,
          context: siteQueryContext(SITE, "public-share"),
        }),
      ).toBeUndefined();
      afterEvidence.push({
        case: `event-name-compiled-plan/${scope}`,
        configuration,
        operation: request.operation,
        qualificationOperation: request.qualification.operation,
        filterValuesReportFilters:
          request.qualification.filterValuesReportFilters,
        sql: compilation.evidence.sql,
        bindings: compilation.evidence.bindings,
        sqlBytes: compilation.evidence.sqlBytes,
        bindingCount: compilation.evidence.bindingCount,
        outputDescriptors: compilation.evidence.outputDescriptors,
        controlOutputId: compilation.evidence.controlOutputId,
        reportSourceRelations: compilation.evidence.reportSourceRelations,
        groupedSummaryProof: compilation.evidence.groupedSummaryProof,
      });
    }
  });

  it("uses one whole Event fallback for a real TEXT numeric guard", async () => {
    const database = createFixture();
    setDurationFixture(database);
    const capturedFusedRows: Record<string, unknown>[][] = [];
    const trace = traceFor();
    const diagnostics = createD1ReadDiagnostics();
    const env = envFor(database, trace, (sql, rows) => {
      if (isFusedEventFilterValuesReport(sql)) capturedFusedRows.push(rows);
      return rows;
    });
    const provider = createD1SiteProviderRegistry({
      env,
      siteId: SITE,
      diagnostics,
    }).resolve("filter-values");
    if (!provider) throw new Error("wave97k_filter_values_provider_missing");

    const oracleDatabase = createFixture();
    setDurationFixture(oracleDatabase);
    const oracle = await legacyPage(oracleDatabase, "session", "event.name", {
      limit: 2,
      filterDsl: NUMERIC_COUNT_DSL,
    });
    const expected = await oracle.page(null);
    const actual = sitePage(
      (
        await provider.execute(
          queryFor("session", "event.name", {
            limit: 2,
            filterDsl: NUMERIC_COUNT_DSL,
          }),
        )
      ).value,
    );
    expect(actual.field).toBe("event.name");
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
      trace.preparedSql.filter(isFusedEventFilterValuesReport),
    ).toHaveLength(1);
    afterEvidence.push({
      case: "event-name-text-numeric-fallback-after",
      actual,
      expected,
      fallbackReason: diagnostics.advancedCountSqlFallbackReason,
      fusedRows: capturedFusedRows[0],
      legacyStatementCount: oracle.trace.preparedSql.length,
      legacyStatements: traceEvidence(oracle.trace),
      statements: traceEvidence(trace),
    });
  });

  it.each([
    "missing-control",
    "repeated-control",
    "unknown-output",
    "invalid-control-scalar",
    "gate-leak",
  ] as const)(
    "rejects Event %s protocol corruption without falling back",
    async (kind) => {
      const database = createFixture();
      database
        .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
        .run(10, "visit-a-included");
      const trace = traceFor();
      const env = envFor(database, trace, (sql, rows) => {
        if (!isFusedEventFilterValuesReport(sql)) return rows;
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
          throw new Error("wave97k_event_numeric_control_missing");
        return rows.map((row) =>
          row.rowKind === "control" ? { ...row, [durationControl]: 1 } : row,
        );
      });
      const provider = createD1SiteProviderRegistry({
        env,
        siteId: SITE,
      }).resolve("filter-values");
      if (!provider) throw new Error("wave97k_filter_values_provider_missing");
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
          queryFor("session", "event.name", {
            limit: 2,
            filterDsl: NUMERIC_COUNT_DSL,
          }),
        ),
      ).rejects.toThrow(expectedMessage);
      expect(trace.preparedSql).toHaveLength(2);
      expect(
        trace.preparedSql.filter(isFusedEventFilterValuesReport),
      ).toHaveLength(1);
    },
  );

  it.each([
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
    "rejects Event report $kind without retrying",
    async ({ kind, message }) => {
      const database = createFixture();
      const trace = traceFor();
      const provider = createD1SiteProviderRegistry({
        env: envFor(database, trace, (sql, rows) => {
          if (!isFusedEventFilterValuesReport(sql)) return rows;
          const reports = rows.filter((row) => row.rowKind === "report");
          if (!reports[0]) throw new Error("wave97k_event_report_row_missing");
          if (kind === "invalid-value")
            return rows.map((row) =>
              row.rowKind === "report" ? { ...row, value: 7 } : row,
            );
          if (kind === "invalid-views")
            return rows.map((row) =>
              row.rowKind === "report" ? { ...row, views: "1" } : row,
            );
          const second = reports[1];
          if (!second)
            throw new Error("wave97k_event_second_report_row_missing");
          return rows.map((row) =>
            row === second ? { ...row, value: reports[0]!.value } : row,
          );
        }),
        siteId: SITE,
      }).resolve("filter-values");
      if (!provider) throw new Error("wave97k_filter_values_provider_missing");
      await expect(
        provider.execute(queryFor("session", "event.name", { limit: 2 })),
      ).rejects.toThrow(message);
      expect(trace.preparedSql).toHaveLength(2);
      expect(
        trace.preparedSql.filter(isFusedEventFilterValuesReport),
      ).toHaveLength(1);
    },
  );

  it("keeps Event cursor errors, Count cap priority, and D1 failures single-shot", async () => {
    const cursorDatabase = createFixture();
    const cursorTrace = traceFor();
    const cursorProvider = createD1SiteProviderRegistry({
      env: envFor(cursorDatabase, cursorTrace),
      siteId: SITE,
    }).resolve("filter-values");
    if (!cursorProvider)
      throw new Error("wave97k_filter_values_provider_missing");
    await expect(
      cursorProvider.execute(
        queryFor("session", "event.name", {
          limit: 2,
          cursor: "malformed-cursor",
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidCursorError);
    expect(
      cursorTrace.preparedSql.filter(isFusedEventFilterValuesReport),
    ).toHaveLength(1);

    const cappedDatabase = createFixture();
    const cappedTrace = traceFor();
    const cappedProvider = createD1SiteProviderRegistry({
      env: envFor(cappedDatabase, cappedTrace, (sql, rows) =>
        isFusedEventFilterValuesReport(sql)
          ? rows.map((row) =>
              row.rowKind === "control" ? { ...row, rawCount: 20_001 } : row,
            )
          : rows,
      ),
      siteId: SITE,
    }).resolve("filter-values");
    if (!cappedProvider)
      throw new Error("wave97k_filter_values_provider_missing");
    await expect(
      cappedProvider.execute(
        queryFor("session", "event.name", {
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
    expect(cappedTrace.preparedSql).toHaveLength(2);
    expect(
      cappedTrace.preparedSql.filter(isFusedEventFilterValuesReport),
    ).toHaveLength(1);

    const failure = new Error("wave97k_event_filter_values_d1_failure");
    const failingDatabase = createFixture();
    const failingTrace = traceFor();
    const failingProvider = createD1SiteProviderRegistry({
      env: envFor(failingDatabase, failingTrace, (sql, rows) => {
        if (isFusedEventFilterValuesReport(sql)) throw failure;
        return rows;
      }),
      siteId: SITE,
    }).resolve("filter-values");
    if (!failingProvider)
      throw new Error("wave97k_filter_values_provider_missing");
    await expect(
      failingProvider.execute(queryFor("session", "event.name", { limit: 2 })),
    ).rejects.toBe(failure);
    expect(failingTrace.preparedSql).toHaveLength(2);
    expect(
      failingTrace.preparedSql.filter(isFusedEventFilterValuesReport),
    ).toHaveLength(1);
  });
});
