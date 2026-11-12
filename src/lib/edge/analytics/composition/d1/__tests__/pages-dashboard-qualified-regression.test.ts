import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { afterAll, describe, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { createD1SiteProviderRegistry } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import {
  EMPTY_FILTER_DOCUMENT,
  prepareScopedQuery,
  type QueryAudience,
  siteQueryContext,
  teamQueryContext,
} from "@/lib/edge/analytics/contract";
import { createQueryTime } from "@/lib/edge/analytics/contract/helpers";
import type {
  PagesDashboardQuery,
  QueryTime,
} from "@/lib/edge/analytics/contract/types";
import {
  d1AdvancedFilterMiddleware,
  deferredEventQualificationFromQuery,
  prepareDeferredEventQualificationFallback,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import * as advancedFilterExecution from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import { queryPagesDashboard } from "@/lib/edge/analytics/providers/d1/internal/pages-dashboard";
import {
  deferredPagesDashboardQualificationFromQuery,
  pagesDashboardQualificationConfigurationFromQuery,
} from "@/lib/edge/analytics/providers/d1/internal/pages-dashboard-qualification-request";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import { InvalidCursorError } from "@/lib/pagination";

const SITE = "wave97e-pages-dashboard-production";
const START = Date.UTC(2026, 9, 1);
const END = Date.UTC(2026, 9, 8);
const TIME = createQueryTime(START, END, "UTC", Date.UTC(2026, 9, 10));
const PREVIOUS_TIME = createQueryTime(
  START - (END - START),
  START,
  "UTC",
  Date.UTC(2026, 9, 10),
);
const FILTERS = parseFilterDsl(
  'page.path neq "/excluded" and count(event { event.name eq "qualifier" }) eq 1',
  analyticsFilterRegistry,
);
const MAIN_SECRET = "wave97e-pages-dashboard-cursor-secret";
const DATABASES = new Set<DatabaseSync>();
type PagesDashboardCompiler = NonNullable<
  Parameters<
    typeof createD1SiteProviderRegistry
  >[0]["pagesDashboardQualificationCompile"]
>;

type StatementEvidence = ReturnType<typeof takeTrace>;

const legacyRouteRecords: Array<{
  readonly key: string;
  readonly query: PagesDashboardQuery;
  readonly value: Awaited<ReturnType<typeof queryPagesDashboard>>;
  readonly statements: StatementEvidence;
}> = [];
const registryRouteRecords: Array<{
  readonly key: string;
  readonly query: PagesDashboardQuery;
  readonly value: Awaited<ReturnType<typeof queryPagesDashboard>>;
  readonly statements: StatementEvidence;
}> = [];
const completedRouteTests = new Set<string>();
const completedCursorPageTests = new Set<string>();
const protocolEvidence: Array<Record<string, unknown>> = [];
const routeTestIds = [
  "ordinary-default-first",
  "nondefault-old-new-old-cursor",
  "ordinary-nondefault-sort-search-interval",
  "ordinary-zero-limit",
  "comparison-representative",
  "visitor-scope-default",
  "visitor-scope-count-sort",
  "visitor-scope-count-duration-sort",
  "timezone-los-angeles-week-trend",
  "timezone-los-angeles-month-trend",
  "legacy-no-count",
  "legacy-public-audience",
  "reverse-unordered-selects",
];
const cursorPageTestIds = (
  [
    "views",
    "visitors",
    "sessions",
    "bounceRate",
    "pagesPerSession",
    "avgDurationMs",
  ] as const
).flatMap((metric) =>
  (["asc", "desc"] as const).flatMap((direction) =>
    [0, 1, 2, 3].map(
      (pageIndex) => `sort-${metric}-${direction}-page-${pageIndex}`,
    ),
  ),
);
const expectedTestIds = [...routeTestIds, ...cursorPageTestIds];

afterAll(async () => {
  for (const database of DATABASES) database.close();
  DATABASES.clear();
  const artifactDir = process.env.WAVE97E_REVIEW_ARTIFACT_DIR;
  if (!artifactDir) return;
  await mkdir(artifactDir, { recursive: true });
  const sourceHashes = Object.fromEntries(
    await Promise.all(
      [
        "src/lib/edge/analytics/composition/d1/site.ts",
        "src/lib/edge/analytics/providers/d1/internal/pages-dashboard.ts",
        "src/lib/edge/analytics/providers/d1/internal/advanced-filter-execution.ts",
        "src/lib/edge/analytics/providers/d1/internal/pages-dashboard-qualification-program.ts",
        "src/lib/edge/analytics/composition/d1/__tests__/pages-dashboard-qualified-regression.test.ts",
      ].map(async (path) => [
        path,
        createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
      ]),
    ),
  );
  const completion = {
    state:
      routeTestIds.every((id) => completedRouteTests.has(id)) &&
      cursorPageTestIds.every((id) => completedCursorPageTests.has(id))
        ? "complete"
        : "partial",
    expectedTestIds,
    completedTestIds: [
      ...completedRouteTests,
      ...completedCursorPageTests,
    ].sort(),
    legacyRequestCount: legacyRouteRecords.length,
    registryRequestCount: registryRouteRecords.length,
  };
  await writeFile(
    `${artifactDir}/legacy-before.json`,
    JSON.stringify(
      {
        kind: "pages-dashboard-legacy-reader-before-review",
        createdAt: new Date().toISOString(),
        completion,
        sourceHashes,
        requests: legacyRouteRecords,
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(
    `${artifactDir}/registry-after.json`,
    JSON.stringify(
      {
        kind: "pages-dashboard-production-registry-after-review",
        createdAt: new Date().toISOString(),
        completion,
        sourceHashes,
        requests: registryRouteRecords,
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(
    `${artifactDir}/protocol-cases.json`,
    JSON.stringify(
      {
        kind: "real-sqlite-protocol-adapter-cases",
        createdAt: new Date().toISOString(),
        cases: protocolEvidence,
      },
      null,
      2,
    ),
    "utf8",
  );
  const registryKeys = new Set(registryRouteRecords.map(({ key }) => key));
  await writeFile(
    `${artifactDir}/matrix-case-mapping.json`,
    JSON.stringify(
      {
        kind: "pages-dashboard-original-matrix-case-mapping",
        createdAt: new Date().toISOString(),
        state:
          completion.state === "complete" && registryRouteRecords.length === 62
            ? "complete"
            : "partial",
        originalRegistryRequestCount: 62,
        observedRegistryRequestCount: registryRouteRecords.length,
        observedLegacyReaderRequestCount: legacyRouteRecords.length,
        expectedTestIds,
        completedTestIds: completion.completedTestIds,
        registryCaseKeys: registryRouteRecords.map(({ key }) => key),
        legacyOnlyCaseKeys: legacyRouteRecords
          .filter(({ key }) => !registryKeys.has(key))
          .map(({ key }) => key),
      },
      null,
      2,
    ),
    "utf8",
  );
});

describe("Pages dashboard whole Boolean qualification", () => {
  it.each(["session", "visitor"] as const)(
    "keeps the %s current Count cohort for complete current and previous DTOs",
    async (scope) => {
      const fixture = createFixture({ seedDefaultData: false });
      const day = 86_400_000;
      const add = (
        id: string,
        at: number,
        path: string,
        session: string,
        visitor: string,
        qualifier = false,
      ) => {
        fixture.addVisit({
          id,
          at,
          path,
          title: path,
          duration: 100,
          session,
          visitor,
        });
        if (qualifier)
          fixture.addQualifier(id, at + 1, 900 + Number(id.replace(/\D/g, "")));
      };

      add("9001", START + day, "/native", "cohort-a", "cohort-a-visitor");
      add(
        "9002",
        START + day + 60_000,
        "/native-detail",
        "cohort-a",
        "cohort-a-visitor",
      );
      add(
        "9003",
        START + 2 * day,
        "/visitor-expansion",
        "cohort-a-extra",
        "cohort-a-visitor",
      );
      add("9004", START - day, "/native", "cohort-a", "cohort-a-visitor");
      add(
        "9005",
        START - day + 60_000,
        "/native-detail",
        "cohort-a",
        "cohort-a-visitor",
      );

      add(
        "9010",
        START + day,
        "/count-event",
        "cohort-b",
        "cohort-b-visitor",
        true,
      );
      add(
        "9011",
        START + day + 60_000,
        "/count-report",
        "cohort-b",
        "cohort-b-visitor",
      );
      add("9012", START - day, "/count-report", "cohort-b", "cohort-b-visitor");
      add(
        "9013",
        START - day + 60_000,
        "/old-only",
        "cohort-b",
        "cohort-b-visitor",
      );

      add("9020", START + day, "/neither", "cohort-c", "cohort-c-visitor");
      add(
        "9030",
        START - day,
        "/native",
        "previous-only",
        "previous-only-visitor",
        true,
      );

      const filters = parseFilterDsl(
        'page.path eq "/native" or count(event { event.name eq "qualifier" }) eq 1',
        analyticsFilterRegistry,
      );
      try {
        const query = queryFor({
          scope,
          filters,
          page: { limit: 20, cursor: null },
        });
        const actualResult = await providerFor(fixture).execute(query);
        const actualStatements = takeTrace(fixture);
        expect(actualStatements).toHaveLength(2);
        const reportStatements = actualStatements.filter(({ sql }) =>
          sql.toLowerCase().includes("rowkind"),
        );
        expect(reportStatements).toHaveLength(1);
        expect(
          new TextEncoder().encode(reportStatements[0]!.sql).length,
        ).toBeLessThanOrEqual(100_000);
        expect(reportStatements[0]!.bindings.length).toBeLessThanOrEqual(100);

        const expected = await executeLegacyDashboard(fixture, query);
        const expectedStatements = takeTrace(fixture);
        expect(actualResult.value).toEqual(expected);
        const actual = actualResult.value as Awaited<
          ReturnType<typeof queryPagesDashboard>
        >;
        const expectedPathnames =
          scope === "session"
            ? ["/count-event", "/count-report", "/native", "/native-detail"]
            : [
                "/count-event",
                "/count-report",
                "/native",
                "/native-detail",
                "/visitor-expansion",
              ];
        expect(actual.items.map(({ pathname }) => pathname).sort()).toEqual(
          [...expectedPathnames].sort(),
        );
        expect(actual.items.some((item) => item.pathname === "/old-only")).toBe(
          false,
        );
        protocolEvidence.push({
          scenario: "whole-boolean-pages-dashboard-current-cohort",
          scope,
          expectedCurrentCohort:
            scope === "session"
              ? ["cohort-a", "cohort-b"]
              : ["cohort-a-visitor", "cohort-b-visitor"],
          excludedPreviousOnlyOwner: "previous-only-visitor",
          actualDto: actualResult.value,
          independentOldReaderDto: expected,
          actualStatements,
          expectedStatements,
          qualifiedEnvelopeCount: reportStatements.length,
          metadataStatementCount: 1,
        });
      } finally {
        fixture.close();
      }
    },
  );
});

interface DashboardFixture {
  readonly database: DatabaseSync;
  readonly env: Env;
  readonly trace: SqliteD1Trace;
  addVisit(input: {
    readonly id: string;
    readonly at: number;
    readonly path: string;
    readonly title: string;
    readonly duration: number;
    readonly session?: string;
    readonly visitor?: string;
  }): void;
  addQualifier(visitId: string, at: number, eventId: number): void;
  close(): void;
}

function createFixture(
  options: { readonly seedDefaultData?: boolean } = {},
): DashboardFixture {
  const database = createMigratedDatabase();
  DATABASES.add(database);
  database.exec("PRAGMA foreign_keys = OFF");
  database
    .prepare("INSERT INTO users (id, email) VALUES (?, ?)")
    .run("wave97e-user", "wave97e@example.test");
  database
    .prepare(
      "INSERT INTO teams (id, name, slug, owner_user_id) VALUES (?, ?, ?, ?)",
    )
    .run("wave97e-team", "Wave97E", "wave97e-team", "wave97e-user");
  database
    .prepare(
      "INSERT INTO sites (id, team_id, name, domain, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(SITE, "wave97e-team", "Dashboard production", "wave97e.test", 0);
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

  const addVisit = (input: {
    readonly id: string;
    readonly at: number;
    readonly path: string;
    readonly title: string;
    readonly duration: number;
    readonly session?: string;
    readonly visitor?: string;
  }) => {
    database
      .prepare(
        `INSERT INTO visits (
          visit_id, site_id, site_pk, visitor_id, session_id, status, started_at,
          last_activity_at, pathname, hostname, duration_ms, title
        ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, 'wave97e.test', ?, ?)`,
      )
      .run(
        input.id,
        SITE,
        sitePk,
        input.visitor ?? "qualified-visitor",
        input.session ?? "qualified-session",
        input.at,
        input.at,
        input.path,
        input.duration,
        input.title,
      );
  };
  const addQualifier = (visitId: string, at: number, eventId: number) => {
    database
      .prepare(
        `INSERT INTO custom_event_names (id, site_id, name, last_seen_at, site_pk)
         VALUES (1, ?, 'qualifier', ?, ?) ON CONFLICT(site_pk, name) DO NOTHING`,
      )
      .run(SITE, at, sitePk);
    database
      .prepare(
        `INSERT INTO custom_events (
          event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
          received_at, sequence, node_count, value_count
        ) VALUES (?, ?, ?, ?, 1, ?, ?, 1, 0, 0)`,
      )
      .run(`wave97e-event-${eventId}`, SITE, sitePk, visitId, at, at);
  };

  if (options.seedDefaultData !== false) {
    const names = [
      "/docs/a",
      "/docs/b",
      "/docs/c",
      "/docs/d",
      "/docs/e",
      "/docs/f",
      "/docs/g",
      "/docs/h",
      "/docs/i",
      "/docs/j",
      "/docs/k",
      "/docs/l",
      "/docs/m",
      "/docs/n",
      "/docs/o",
      "/docs/p",
    ];
    let currentId = 0;
    names.forEach((path, index) => {
      const count = 1 + (index % 3);
      for (let visitIndex = 0; visitIndex < count; visitIndex += 1) {
        const at = START + ((index * 3 + visitIndex) % 7) * 86_400_000 + 60_000;
        const id = `current-${currentId++}`;
        addVisit({
          id,
          at,
          path,
          title: index % 2 === 0 ? `Title ${index}` : `Title ${index} `,
          duration: 100 + index * 17 + visitIndex,
        });
        if (index === 0 && visitIndex === 0) addQualifier(id, at + 1, 1);
      }
    });

    // Prior-period rows and Count membership exercise the previous-window branch.
    for (const [index, path] of ["/docs/a", "/docs/c", "/docs/f"].entries()) {
      const at = START - 6 * 86_400_000 + index * 86_400_000 + 60_000;
      const id = `previous-${index}`;
      addVisit({
        id,
        at,
        path,
        title: `Previous ${index}`,
        duration: 400 + index,
      });
      if (index === 0) addQualifier(id, at + 1, 2);
    }
  }

  const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
  const env = {
    DB: createSqliteD1Database(database, trace),
    MAIN_SECRET,
    MAIN_SECRET_PREVIOUS: "",
    DAILY_SALT_SECRET: "wave97e-pages-dashboard-daily-secret",
  } as unknown as Env;
  return {
    database,
    env,
    trace,
    addVisit,
    addQualifier,
    close() {
      database.close();
      DATABASES.delete(database);
    },
  };
}

interface RequestOptions {
  readonly scope?: "session" | "visitor";
  readonly filters?: PagesDashboardQuery["filters"];
  readonly interval?: PagesDashboardQuery["interval"];
  readonly search?: string;
  readonly sort?: PagesDashboardQuery["sort"];
  readonly page?: PagesDashboardQuery["page"];
  readonly comparison?: PagesDashboardQuery["comparison"];
  readonly audience?: QueryAudience;
  readonly time?: QueryTime;
}

function queryFor(options: RequestOptions = {}): PagesDashboardQuery {
  const prepared = prepareScopedQuery("pages-dashboard", {
    context: siteQueryContext(SITE, options.audience ?? "private-dashboard"),
    time: options.time ?? TIME,
    filters: options.filters ?? FILTERS,
    scopePreference: options.scope ?? "session",
  });
  return {
    ...prepared,
    interval: options.interval ?? "week",
    ...(options.search !== undefined ? { search: options.search } : {}),
    ...(options.sort !== undefined ? { sort: options.sort } : {}),
    ...(options.page !== undefined ? { page: options.page } : {}),
    ...(options.comparison !== undefined
      ? { comparison: options.comparison }
      : {}),
    ...(options.audience !== undefined ? { audience: options.audience } : {}),
  } as PagesDashboardQuery;
}

function providerFor(fixture: DashboardFixture) {
  const provider = createD1SiteProviderRegistry({
    env: fixture.env,
    siteId: SITE,
  }).resolve("pages-dashboard");
  if (!provider) throw new Error("wave97e_pages_dashboard_provider_missing");
  return provider;
}

function serializedBindings(bindings: readonly SQLInputValue[]): unknown[] {
  return bindings.map((value) =>
    value instanceof Uint8Array ? Array.from(value) : value,
  );
}

function clearTrace(fixture: DashboardFixture): void {
  fixture.trace.preparedSql.length = 0;
  fixture.trace.bindings.length = 0;
}

function takeTrace(fixture: DashboardFixture) {
  const statements = fixture.trace.preparedSql.map((sql, index) => ({
    sql,
    bindings: serializedBindings(fixture.trace.bindings[index] ?? []),
  }));
  clearTrace(fixture);
  return statements;
}

function statementMatches(
  left: StatementEvidence[number],
  right: StatementEvidence[number],
) {
  return (
    left.sql === right.sql &&
    JSON.stringify(left.bindings) === JSON.stringify(right.bindings)
  );
}

function statementsPreserveOrder(
  expected: StatementEvidence,
  actual: StatementEvidence,
) {
  let index = 0;
  for (const statement of actual) {
    if (
      index < expected.length &&
      statementMatches(expected[index]!, statement)
    )
      index += 1;
  }
  return index === expected.length;
}

function statementsAbsentFrom(
  actual: StatementEvidence,
  reference: StatementEvidence,
) {
  return actual.filter(
    (statement) =>
      !reference.some((candidate) => statementMatches(statement, candidate)),
  );
}

async function executeLegacyDashboard(
  fixture: DashboardFixture,
  query: PagesDashboardQuery,
): Promise<Awaited<ReturnType<typeof queryPagesDashboard>>> {
  const forwarded = await forwardMiddlewareQuery(fixture, query);
  const deferred = deferredEventQualificationFromQuery(
    forwarded,
    "pages-dashboard",
  );
  const filters = deferred
    ? await prepareDeferredEventQualificationFallback(deferred)
    : (query.filters ?? EMPTY_FILTER_DOCUMENT);
  const time = query.time;
  return queryPagesDashboard(fixture.env, SITE, {
    window: {
      startMs: time.range.startMs,
      endExclusiveMs: time.range.endExclusiveMs,
      nowMs: time.capturedAtMs,
      timeZone: time.reportingTimeZone,
    },
    filters,
    interval: query.interval,
    page: {
      limit: query.page?.limit ?? 12,
      cursor: query.page?.cursor ?? null,
    },
    ...(query.search !== undefined ? { search: query.search } : {}),
    ...(query.sort ? { sort: query.sort } : {}),
    ...(query.comparison ? { comparison: query.comparison } : {}),
    audience: query.audience ?? query.context.policy.audience,
  });
}

async function forwardMiddlewareQuery(
  fixture: DashboardFixture,
  query: PagesDashboardQuery,
): Promise<unknown> {
  let forwarded: unknown;
  await d1AdvancedFilterMiddleware(fixture.env, undefined, SITE)(
    "pages-dashboard",
    query,
    async (input) => {
      forwarded = input;
      return undefined;
    },
  );
  if (!forwarded) throw new Error("wave97e_middleware_forward_missing");
  return forwarded;
}

async function runParity(
  fixture: DashboardFixture,
  key: string,
  query: PagesDashboardQuery,
) {
  const expected = await runLegacyPage(fixture, key, query);
  return runRegistryParity(
    fixture,
    key,
    query,
    expected.value,
    expected.statements,
  );
}

async function runLegacyPage(
  fixture: DashboardFixture,
  key: string,
  query: PagesDashboardQuery,
) {
  const value = await executeLegacyDashboard(fixture, query);
  const statements = takeTrace(fixture);
  legacyRouteRecords.push({ key, query, value, statements });
  return { value, statements };
}

async function runRegistryParity(
  fixture: DashboardFixture,
  key: string,
  query: PagesDashboardQuery,
  expected: Awaited<ReturnType<typeof queryPagesDashboard>>,
  expectedStatements: StatementEvidence,
) {
  const actual = await providerFor(fixture).execute(query);
  const statements = takeTrace(fixture);
  registryRouteRecords.push({ key, query, value: actual.value, statements });
  expect(actual.value).toEqual(expected);
  const qualifiedCountRequest =
    query.context.policy.audience === "private-dashboard" &&
    !query.comparison &&
    query.time.fullHistory !== true &&
    query.filters?.root !== null &&
    query.filters?.root !== undefined;
  if (qualifiedCountRequest) {
    const reportStatements = statements.filter(({ sql }) =>
      sql.toLowerCase().includes("rowkind"),
    );
    expect(statements).toHaveLength(2);
    expect(reportStatements).toHaveLength(1);
    expect(
      new TextEncoder().encode(reportStatements[0]!.sql).length,
    ).toBeLessThanOrEqual(100_000);
    expect(reportStatements[0]!.bindings.length).toBeLessThanOrEqual(100);
    const dto = JSON.stringify(actual.value);
    expect(dto).not.toContain("qualified-session");
    expect(dto).not.toContain("qualified-visitor");
    expect(dto).not.toContain("current-");
  } else {
    const prefixLength = statements.length - expectedStatements.length;
    expect([0, 1]).toContain(prefixLength);
    expect(statements.slice(prefixLength)).toEqual(expectedStatements);
  }
  return { actual: actual.value, expected };
}

async function runLegacy(
  fixture: DashboardFixture,
  key: string,
  query: PagesDashboardQuery,
) {
  const value = await executeLegacyDashboard(fixture, query);
  const statements = takeTrace(fixture);
  legacyRouteRecords.push({ key, query, value, statements });
  return value;
}

async function withFixture(run: (fixture: DashboardFixture) => Promise<void>) {
  const fixture = createFixture();
  try {
    await run(fixture);
  } finally {
    fixture.close();
  }
}

function installReportResultMutation(
  fixture: DashboardFixture,
  mutate: (rows: Record<string, unknown>[]) => Record<string, unknown>[],
) {
  let reportReads = 0;
  let nativeRows: Record<string, unknown>[] = [];
  const originalDb = fixture.env.DB as unknown as object;
  const wrapStatement = (statement: object, isReport: boolean): object =>
    new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property, target) as unknown;
        if (property === "bind" && typeof value === "function")
          return (...bindings: unknown[]) =>
            wrapStatement(
              Reflect.apply(value, target, bindings) as object,
              isReport,
            );
        if (property === "all" && typeof value === "function" && isReport)
          return async (...args: unknown[]) => {
            const result = (await Reflect.apply(value, target, args)) as {
              readonly results?: Record<string, unknown>[];
              readonly [key: string]: unknown;
            };
            const rows = result.results ?? [];
            reportReads += 1;
            nativeRows = rows.map((row) => ({ ...row }));
            return {
              ...result,
              results: mutate(rows.map((row) => ({ ...row }))),
            };
          };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const adaptedDb = new Proxy(originalDb, {
    get(target, property) {
      if (property !== "prepare") return Reflect.get(target, property, target);
      const prepare = Reflect.get(target, property, target) as (
        sql: string,
      ) => object;
      return (sql: string) =>
        wrapStatement(
          Reflect.apply(prepare, target, [sql]) as object,
          sql.toLowerCase().includes("rowkind"),
        );
    },
  });
  (fixture.env as unknown as { DB: unknown }).DB = adaptedDb;
  return {
    get reportReads() {
      return reportReads;
    },
    get nativeRows() {
      return nativeRows;
    },
  };
}

interface ReportProtocolCase {
  readonly id: string;
  readonly expectedError: string;
  readonly mutate: (
    rows: Record<string, unknown>[],
  ) => Record<string, unknown>[];
}

function reportRows(rows: Record<string, unknown>[]) {
  return rows.filter((row) => row.rowKind === "report");
}

function controlRow(rows: Record<string, unknown>[]) {
  const control = rows.find((row) => row.rowKind === "control");
  if (!control) throw new Error("wave97e_protocol_control_missing");
  return control;
}

function rowsForProtocolMutation(
  rows: Record<string, unknown>[],
  mutate: ReportProtocolCase["mutate"],
) {
  return mutate(rows.map((row) => ({ ...row })));
}

const reportProtocolCases: readonly ReportProtocolCase[] = [
  {
    id: "missing-control",
    expectedError: "pages_dashboard_qualification_control_row_invalid",
    mutate: (rows) => rows.filter((row) => row.rowKind !== "control"),
  },
  {
    id: "duplicate-control",
    expectedError: "pages_dashboard_qualification_control_row_invalid",
    mutate: (rows) => [...rows, { ...controlRow(rows) }],
  },
  {
    id: "unknown-row-kind",
    expectedError: "pages_dashboard_qualification_row_kind_invalid",
    mutate: (rows) => {
      const report = rows.find((row) => row.rowKind === "report");
      if (!report) throw new Error("wave97e_protocol_report_rows_missing");
      const index = rows.indexOf(report);
      return rows.map((row, rowIndex) =>
        rowIndex === index ? { ...row, rowKind: "unknown" } : row,
      );
    },
  },
  {
    id: "unknown-output-kind",
    expectedError: "pages_dashboard_qualification_report_output_invalid",
    mutate: (rows) =>
      rows.map((row) =>
        row.rowKind === "report" ? { ...row, outputId: "unknown-output" } : row,
      ),
  },
  {
    id: "invalid-raw-count-control",
    expectedError: "pages_dashboard_qualification_control_invalid:rawCount",
    mutate: (rows) =>
      rows.map((row) =>
        row.rowKind === "control" ? { ...row, rawCount: "not-a-count" } : row,
      ),
  },
  {
    id: "wrong-control-entity-kind",
    expectedError: "pages_dashboard_qualification_control_kind_mismatch",
    mutate: (rows) =>
      rows.map((row) =>
        row.rowKind === "control" ? { ...row, entityKind: "page" } : row,
      ),
  },
  {
    id: "invalid-identity-count-control",
    expectedError:
      "pages_dashboard_qualification_control_invalid:invalidIdentityCount",
    mutate: (rows) =>
      rows.map((row) =>
        row.rowKind === "control"
          ? { ...row, invalidIdentityCount: "bad" }
          : row,
      ),
  },
  {
    id: "invalid-duplicate-identity-count-control",
    expectedError:
      "pages_dashboard_qualification_control_invalid:duplicateIdentityCount",
    mutate: (rows) =>
      rows.map((row) =>
        row.rowKind === "control"
          ? { ...row, duplicateIdentityCount: -1 }
          : row,
      ),
  },
  {
    id: "duplicate-current-raw-key",
    expectedError: "pages_dashboard_qualification_report_duplicate",
    mutate: (rows) => {
      const current = rows.filter(
        (row) => row.outputId === "pages-dashboard-qualified-current",
      );
      if (current.length < 2)
        throw new Error("wave97e_protocol_current_rows_missing");
      const second = rows.indexOf(current[1]!);
      return rows.map((row, index) =>
        index === second ? { ...row, pathname: current[0]!.pathname } : row,
      );
    },
  },
  {
    id: "duplicate-current-rank",
    expectedError: "pages_dashboard_qualification_report_duplicate",
    mutate: (rows) => {
      const current = rows.filter(
        (row) => row.outputId === "pages-dashboard-qualified-current",
      );
      if (current.length < 2)
        throw new Error("wave97e_protocol_current_rows_missing");
      const second = rows.indexOf(current[1]!);
      return rows.map((row, index) =>
        index === second ? { ...row, rowOrder: current[0]!.rowOrder } : row,
      );
    },
  },
  {
    id: "zero-current-rank",
    expectedError: "pages_dashboard_qualification_report_duplicate",
    mutate: (rows) =>
      rows.map((row) =>
        row.outputId === "pages-dashboard-qualified-current" &&
        row.rowOrder === 1
          ? { ...row, rowOrder: 0 }
          : row,
      ),
  },
  {
    id: "jumped-current-rank",
    expectedError: "pages_dashboard_qualification_report_duplicate",
    mutate: (rows) => {
      const current = rows.filter(
        (row) => row.outputId === "pages-dashboard-qualified-current",
      );
      if (current.length < 2)
        throw new Error("wave97e_protocol_current_rows_missing");
      const second = rows.indexOf(current[1]!);
      return rows.map((row, index) =>
        index === second
          ? { ...row, rowOrder: Number(current[0]!.rowOrder) + 2 }
          : row,
      );
    },
  },
  {
    id: "title-over-three",
    expectedError: "pages_dashboard_qualification_title_cardinality_invalid",
    mutate: (rows) => {
      const title = rows.find(
        (row) => row.outputId === "pages-dashboard-qualified-titles",
      );
      if (!title) throw new Error("wave97e_protocol_title_rows_missing");
      return [
        ...rows,
        ...[10, 11, 12].map((rowOrder) => ({ ...title, rowOrder })),
      ];
    },
  },
  {
    id: "duplicate-title-rank",
    expectedError: "pages_dashboard_qualification_report_duplicate",
    mutate: (rows) => {
      const title = rows.find(
        (row) => row.outputId === "pages-dashboard-qualified-titles",
      );
      if (!title) throw new Error("wave97e_protocol_title_rows_missing");
      return [...rows, { ...title }];
    },
  },
  {
    id: "duplicate-trend-bucket",
    expectedError: "pages_dashboard_qualification_report_duplicate",
    mutate: (rows) => {
      const trend = rows.find(
        (row) => row.outputId === "pages-dashboard-qualified-trend",
      );
      if (!trend) throw new Error("wave97e_protocol_trend_rows_missing");
      return [...rows, { ...trend }];
    },
  },
  {
    id: "out-of-range-trend-bucket",
    expectedError: "pages_dashboard_qualification_trend_shape_invalid",
    mutate: (rows) =>
      rows.map((row) =>
        row.outputId === "pages-dashboard-qualified-trend"
          ? { ...row, bucket: 999 }
          : row,
      ),
  },
  {
    id: "unrelated-detail-path",
    expectedError: "pages_dashboard_qualification_report_duplicate",
    mutate: (rows) => {
      const title = rows.find(
        (row) => row.outputId === "pages-dashboard-qualified-titles",
      );
      if (!title) throw new Error("wave97e_protocol_title_rows_missing");
      return [
        ...rows,
        { ...title, pathname: "/not-related-to-a-displayed-path" },
      ];
    },
  },
];

describe("Pages Dashboard production qualification", () => {
  const independentRoutes = [
    {
      id: "ordinary-default-first",
      key: "ordinary-default-first",
      query: queryFor(),
    },
    {
      id: "ordinary-nondefault-sort-search-interval",
      key: "ordinary-nondefault-sort-search-interval",
      query: queryFor({
        interval: "day",
        search: "/docs",
        sort: { key: "sessions", direction: "asc" },
        page: { limit: 5, cursor: null },
      }),
    },
    {
      id: "ordinary-zero-limit",
      key: "ordinary-zero-limit",
      query: queryFor({ page: { limit: 0, cursor: null } }),
    },
    {
      id: "comparison-representative",
      key: "comparison-representative",
      query: queryFor({
        filters: EMPTY_FILTER_DOCUMENT,
        page: { limit: 5, cursor: null },
        comparison: {
          current: { time: TIME, filters: EMPTY_FILTER_DOCUMENT },
          reference: { time: PREVIOUS_TIME, filters: EMPTY_FILTER_DOCUMENT },
          metric: "views",
          sortBy: "current",
          direction: "desc",
        },
      }),
    },
    {
      id: "visitor-scope-default",
      key: "visitor-scope-default",
      query: queryFor({ scope: "visitor" }),
    },
    {
      id: "visitor-scope-count-sort",
      key: "visitor-scope-count-sort",
      query: queryFor({
        scope: "visitor",
        page: { limit: 5, cursor: null },
        sort: { key: "visitors", direction: "desc" },
      }),
    },
    {
      id: "visitor-scope-count-duration-sort",
      key: "visitor-scope-count-duration-sort",
      query: queryFor({
        scope: "visitor",
        page: { limit: 5, cursor: null },
        sort: { key: "avgDurationMs", direction: "asc" },
      }),
    },
    {
      id: "timezone-los-angeles-week-trend",
      key: "timezone-los-angeles-week-trend",
      query: queryFor({
        time: createQueryTime(
          START,
          END,
          "America/Los_Angeles",
          Date.UTC(2026, 9, 10),
        ),
        interval: "week",
      }),
    },
    {
      id: "timezone-los-angeles-month-trend",
      key: "timezone-los-angeles-month-trend",
      query: queryFor({
        time: createQueryTime(
          START,
          END,
          "America/Los_Angeles",
          Date.UTC(2026, 9, 10),
        ),
        interval: "month",
      }),
    },
    {
      id: "legacy-no-count",
      key: "legacy-no-count",
      query: queryFor({
        filters: EMPTY_FILTER_DOCUMENT,
        page: { limit: 5, cursor: null },
      }),
    },
    {
      id: "legacy-public-audience",
      key: "legacy-public-audience",
      query: queryFor({
        audience: "public-share",
        filters: EMPTY_FILTER_DOCUMENT,
        page: { limit: 5, cursor: null },
      }),
    },
  ] as const;

  it.each(independentRoutes)(
    "route contract: $id",
    async ({ id, key, query }) => {
      await withFixture(async (fixture) => {
        await runParity(fixture, key, query);
        completedRouteTests.add(id);
      });
    },
  );

  it("keeps the nondefault old-new-old cursor chain compatible", async () => {
    await withFixture(async (fixture) => {
      const options = {
        interval: "month" as const,
        search: "  /DOCS  ",
        sort: { key: "avgDurationMs" as const, direction: "asc" as const },
        page: { limit: 4, cursor: null },
      };
      const firstPage = await runParity(
        fixture,
        "ordinary-nondefault-search-sort-page-interval-first",
        queryFor(options),
      );
      const oldCursor = firstPage.expected.pagination.nextCursor;
      expect(firstPage.actual.pagination.nextCursor).toBe(oldCursor);
      if (!oldCursor) throw new Error("wave97e_nondefault_cursor_missing");

      const secondPage = await runParity(
        fixture,
        "ordinary-nondefault-search-sort-page-interval-next-cursor",
        queryFor({ ...options, page: { limit: 4, cursor: oldCursor } }),
      );
      const nextCursor = secondPage.actual.pagination.nextCursor;
      expect(nextCursor).toBe(secondPage.expected.pagination.nextCursor);
      const oldReaderAfterNew = await runLegacy(
        fixture,
        "ordinary-nondefault-search-sort-page-interval-new-token-to-legacy",
        queryFor({ ...options, page: { limit: 4, cursor: nextCursor } }),
      );
      expect(oldReaderAfterNew.pagination.limit).toBe(4);
      expect(oldReaderAfterNew.pagination.returned).toBe(
        oldReaderAfterNew.items.length,
      );
      expect(
        oldReaderAfterNew.items.some(
          (item) =>
            ![...firstPage.actual.items, ...secondPage.actual.items].some(
              (previous) => previous.pathname === item.pathname,
            ),
        ),
      ).toBe(true);
      if (oldReaderAfterNew.pagination.hasMore)
        expect(oldReaderAfterNew.pagination.nextCursor).not.toBeNull();
      else expect(oldReaderAfterNew.pagination.nextCursor).toBeNull();
      completedRouteTests.add("nondefault-old-new-old-cursor");
    });
  });

  const metricDirections = (
    [
      "views",
      "visitors",
      "sessions",
      "bounceRate",
      "pagesPerSession",
      "avgDurationMs",
    ] as const
  ).flatMap((metric) =>
    (["asc", "desc"] as const).map((direction) => ({ metric, direction })),
  );
  const cursorPageCases = metricDirections.flatMap(({ metric, direction }) =>
    [0, 1, 2, 3].map((pageIndex) => ({ metric, direction, pageIndex })),
  );
  it.each(cursorPageCases)(
    "sort cursor page: $metric $direction page $pageIndex",
    async ({ metric, direction, pageIndex }) => {
      const id = `sort-${metric}-${direction}`;
      await withFixture(async (fixture) => {
        let cursor: string | null = null;
        let expectedPage:
          Awaited<ReturnType<typeof queryPagesDashboard>> | undefined;
        let expectedStatements: StatementEvidence = [];
        let inputCursor: string | null = null;
        for (let oraclePage = 0; oraclePage <= pageIndex; oraclePage += 1) {
          if (oraclePage === pageIndex) inputCursor = cursor;
          const query = queryFor({
            page: { limit: 4, cursor },
            sort: { key: metric, direction },
          });
          const oracle = await runLegacyPage(
            fixture,
            `${id}-page-${pageIndex}-oracle-${oraclePage}`,
            query,
          );
          expectedPage = oracle.value;
          expectedStatements = oracle.statements;
          if (oraclePage < pageIndex) {
            expect(oracle.value.pagination.hasMore).toBe(true);
            expect(oracle.value.pagination.nextCursor).toEqual(
              expect.any(String),
            );
          }
          cursor = oracle.value.pagination.nextCursor;
        }
        if (!expectedPage)
          throw new Error("wave97e_cursor_oracle_page_missing");
        expect(expectedPage.pagination.limit).toBe(4);
        expect(expectedPage.pagination.returned).toBe(
          expectedPage.items.length,
        );
        if (pageIndex < 3) {
          expect(expectedPage.pagination.hasMore).toBe(true);
          expect(expectedPage.pagination.nextCursor).toEqual(
            expect.any(String),
          );
        } else {
          expect(pageIndex).toBe(3);
          expect(expectedPage.pagination.hasMore).toBe(false);
          expect(expectedPage.pagination.nextCursor).toBeNull();
        }
        const actualQuery = queryFor({
          page: { limit: 4, cursor: inputCursor },
          sort: { key: metric, direction },
        });
        const result = await runRegistryParity(
          fixture,
          `${id}-page-${pageIndex}`,
          actualQuery,
          expectedPage,
          expectedStatements,
        );
        expect(result.actual.pagination.hasMore).toBe(
          expectedPage.pagination.hasMore,
        );
        expect(result.actual.pagination.nextCursor).toBe(
          expectedPage.pagination.nextCursor,
        );
        expect(result.actual).toEqual(expectedPage);
        completedCursorPageTests.add(`${id}-page-${pageIndex}`);
      });
    },
  );

  it("restores reverse_unordered_selects in finally", async () => {
    await withFixture(async (fixture) => {
      fixture.database.exec("PRAGMA reverse_unordered_selects = ON");
      try {
        await runParity(
          fixture,
          "reverse-unordered-selects",
          queryFor({
            page: { limit: 5, cursor: null },
            sort: { key: "bounceRate", direction: "desc" },
          }),
        );
      } finally {
        fixture.database.exec("PRAGMA reverse_unordered_selects = OFF");
      }
      completedRouteTests.add("reverse-unordered-selects");
    });
  });

  it("keeps a full-history time Count request on the legacy reader", async () => {
    const fixture = createFixture();
    try {
      const filters = parseFilterDsl(
        'time lt @now-30s and count(event { event.name eq "qualifier" }) eq 1',
        analyticsFilterRegistry,
      );
      const query = queryFor({ filters });
      expect(query.time.fullHistory).toBe(true);
      const result = await providerFor(fixture).execute(query);
      expect(Array.isArray(result.value.items)).toBe(true);
      expect(fixture.trace.preparedSql.length).toBeGreaterThan(0);
      expect(
        fixture.trace.preparedSql.some((sql) =>
          sql.includes("pages-dashboard-qualified-current"),
        ),
      ).toBe(false);
    } finally {
      fixture.close();
    }
  });

  it("keeps SQL-trimmed detail rows for an off-page raw pathname variant", async () => {
    const fixture = createFixture({ seedDefaultData: false });
    try {
      let eventId = 100;
      for (const [path, count, title] of [
        ["/x", 3, "Canonical title"],
        [" /x", 2, "Leading-space title"],
        ["/x ", 1, "Trailing-space title"],
      ] as const) {
        for (let visitIndex = 0; visitIndex < count; visitIndex += 1) {
          const at = START + 60_000 + visitIndex * 1_000;
          const visitId = `collision-${eventId}`;
          fixture.addVisit({
            id: visitId,
            at,
            path,
            title,
            duration: 100,
            session: `collision-session-${eventId}`,
            visitor: `collision-visitor-${eventId}`,
          });
          fixture.addQualifier(visitId, at + 1, eventId);
          eventId += 1;
        }
      }

      const query = queryFor({
        page: { limit: 1, cursor: null },
        interval: "day",
      });
      const expected = await executeLegacyDashboard(fixture, query);
      const legacyStatements = takeTrace(fixture);
      const reportCapture = installReportResultMutation(
        fixture,
        (rows) => rows,
      );
      let actualValue: unknown;
      let actualError: string | undefined;
      try {
        actualValue = (await providerFor(fixture).execute(query)).value;
      } catch (error) {
        actualError = error instanceof Error ? error.message : String(error);
      }
      const registryStatements = takeTrace(fixture);
      const qualifiedStatements = registryStatements.filter(({ sql }) =>
        sql.toLowerCase().includes("rowkind"),
      );
      const rawReportRows = reportCapture.nativeRows;
      const currentPaths = rawReportRows
        .filter(
          (row) =>
            row.rowKind === "report" &&
            row.title === null &&
            row.bucket === null &&
            typeof row.rowOrder === "number",
        )
        .map((row) => row.pathname);
      const extraTitleRows = rawReportRows.filter(
        (row) =>
          row.rowKind === "report" && row.title === "Trailing-space title",
      );
      const extraTrendRows = rawReportRows.filter(
        (row) =>
          row.rowKind === "report" &&
          row.bucket !== null &&
          row.pathname === "/x ",
      );
      const evidencePath = process.env.WAVE97E_REVIEW_ARTIFACT_DIR;
      if (evidencePath) {
        await mkdir(evidencePath, { recursive: true });
        await writeFile(
          `${evidencePath}/${actualError ? "pathname-collision-red" : "pathname-collision-green"}.json`,
          JSON.stringify(
            {
              kind: actualError
                ? "real-sqlite-pathname-collision-red"
                : "real-sqlite-pathname-collision-green",
              pageLimit: 1,
              rawPathVariants: ["/x", " /x", "/x "],
              normalizedPath: "/x",
              legacyDto: expected,
              registryDto: actualValue ?? null,
              registryError: actualError ?? null,
              legacyStatements,
              registryStatements,
              rawReportRows,
              currentLimitAndSentinelRawPaths: currentPaths,
              offPageExtraTitleRows: extraTitleRows,
              offPageExtraTrendRows: extraTrendRows,
              reportStatementCount: qualifiedStatements.length,
              capturedAt: new Date().toISOString(),
            },
            null,
            2,
          ),
          "utf8",
        );
      }

      expect(expected.items).toHaveLength(1);
      expect(expected.items[0]?.pathname.trim()).toBe("/x");
      expect(currentPaths).toContain("/x");
      expect(currentPaths).not.toContain("/x ");
      expect(extraTitleRows).toHaveLength(1);
      expect(extraTrendRows).toHaveLength(1);
      expect(actualError).toBeUndefined();
      expect(actualValue).toEqual(expected);
      expect(registryStatements).toHaveLength(2);
      expect(qualifiedStatements).toHaveLength(1);
      expect(reportCapture.reportReads).toBe(1);
    } finally {
      fixture.close();
    }
  });

  it("records JavaScript and SQLite ASCII trim behavior for Unicode path whitespace", async () => {
    const fixture = createFixture({ seedDefaultData: false });
    try {
      const unicodePath = "\u00a0/x\u00a0";
      let eventId = 300;
      for (const [path, count, title] of [
        ["/x", 3, "Canonical title"],
        [unicodePath, 2, "Unicode boundary title"],
      ] as const) {
        for (let visitIndex = 0; visitIndex < count; visitIndex += 1) {
          const at = START + 90_000 + visitIndex * 1_000;
          const visitId = `unicode-${eventId}`;
          fixture.addVisit({
            id: visitId,
            at,
            path,
            title,
            duration: 100,
            session: `unicode-session-${eventId}`,
            visitor: `unicode-visitor-${eventId}`,
          });
          fixture.addQualifier(visitId, at + 1, eventId);
          eventId += 1;
        }
      }
      const sqliteTrim = (
        fixture.database
          .prepare("SELECT TRIM(?) AS value")
          .get(unicodePath) as {
          value: string;
        }
      ).value;
      const query = queryFor({
        page: { limit: 1, cursor: null },
        interval: "day",
      });
      const expected = await executeLegacyDashboard(fixture, query);
      const legacyStatements = takeTrace(fixture);
      const reportCapture = installReportResultMutation(
        fixture,
        (rows) => rows,
      );
      const actual = await providerFor(fixture).execute(query);
      const registryStatements = takeTrace(fixture);
      const qualifiedStatements = registryStatements.filter(({ sql }) =>
        sql.toLowerCase().includes("rowkind"),
      );
      const rawReportRows = reportCapture.nativeRows;
      const unicodeDetailRows = rawReportRows.filter(
        (row) =>
          row.rowKind === "report" &&
          row.pathname === unicodePath &&
          (row.title !== null || row.bucket !== null),
      );
      const evidencePath = process.env.WAVE97E_REVIEW_ARTIFACT_DIR;
      if (evidencePath) {
        await mkdir(evidencePath, { recursive: true });
        await writeFile(
          `${evidencePath}/unicode-trim-contrast.json`,
          JSON.stringify(
            {
              kind: "real-sqlite-unicode-trim-contrast",
              rawPath: unicodePath,
              javascriptTrim: unicodePath.trim(),
              sqliteDefaultTrim: sqliteTrim,
              legacyDto: expected,
              registryDto: actual.value,
              rawReportRows,
              unicodeDetailRows,
              reportStatementCount: qualifiedStatements.length,
              legacyStatementCount: legacyStatements.length,
              registryStatementCount: registryStatements.length,
              capturedAt: new Date().toISOString(),
            },
            null,
            2,
          ),
          "utf8",
        );
      }
      expect(unicodePath.trim()).toBe("/x");
      expect(sqliteTrim).toBe(unicodePath);
      expect(actual.value).toEqual(expected);
      expect(expected.items).toHaveLength(1);
      expect(expected.items[0]?.pathname).toBe("/x");
      expect(unicodeDetailRows).toHaveLength(0);
      expect(registryStatements).toHaveLength(2);
      expect(qualifiedStatements).toHaveLength(1);
      expect(reportCapture.reportReads).toBe(1);
    } finally {
      fixture.close();
    }
  });

  it("binds qualification to the original request and rejects unsupported shapes", async () => {
    const fixture = createFixture();
    try {
      const query = queryFor({ page: { limit: 4, cursor: null } });
      const forwarded = await forwardMiddlewareQuery(fixture, query);
      expect(
        deferredPagesDashboardQualificationFromQuery(forwarded),
      ).toBeDefined();

      const copied = { ...(forwarded as Record<string, unknown>) };
      expect(
        deferredPagesDashboardQualificationFromQuery(copied),
      ).toBeUndefined();
      for (const key of Reflect.ownKeys(forwarded as object)) {
        if (typeof key !== "symbol") continue;
        const descriptor = Object.getOwnPropertyDescriptor(
          forwarded as object,
          key,
        );
        if (descriptor) Object.defineProperty(copied, key, descriptor);
      }
      expect(() =>
        deferredPagesDashboardQualificationFromQuery(copied),
      ).toThrow("pages_dashboard_qualification_request_untrusted");

      const request = forwarded as Record<string, unknown>;
      const originalPage = request.page;
      const originalTime = request.time;
      const originalFilters = request.filters;
      const originalScopePlan = request.scopePlan;
      const originalContext = request.context;
      const originalSort = request.sort;
      const originalSearch = request.search;
      const originalInterval = request.interval;
      const changedValues: ReadonlyArray<readonly [string, unknown]> = [
        ["page", { limit: 5, cursor: "old-token" }],
        ["time", { ...(originalTime as object), capturedAtMs: 1 }],
        ["filters", EMPTY_FILTER_DOCUMENT],
        ["scopePlan", undefined],
        [
          "context",
          {
            ...(originalContext as Record<string, unknown>),
            policy: {
              ...((originalContext as Record<string, unknown>)
                .policy as object),
              audience: "public-share",
            },
          },
        ],
        ["sort", { key: "views", direction: "desc" }],
        ["search", "/changed"],
        ["interval", "day"],
      ];
      for (const [key, value] of changedValues) {
        const descriptor = Object.getOwnPropertyDescriptor(request, key);
        Object.defineProperty(request, key, {
          configurable: true,
          enumerable: true,
          writable: true,
          value,
        });
        expect(() =>
          deferredPagesDashboardQualificationFromQuery(request),
        ).toThrow("pages_dashboard_qualification_request_changed");
        if (descriptor) Object.defineProperty(request, key, descriptor);
        else Reflect.deleteProperty(request, key);
      }
      expect(originalPage).toBeDefined();
      expect(originalTime).toBeDefined();
      expect(originalFilters).toBeDefined();
      expect(originalScopePlan).toBeDefined();
      expect(originalContext).toBeDefined();
      expect(originalSort).toBeUndefined();
      expect(originalSearch).toBeUndefined();
      expect(originalInterval).toBe("week");

      let getterReads = 0;
      const hostilePage = { ...query };
      Object.defineProperty(hostilePage, "page", {
        configurable: true,
        enumerable: true,
        get() {
          getterReads += 1;
          return { limit: 3, cursor: null };
        },
      });
      expect(
        pagesDashboardQualificationConfigurationFromQuery(hostilePage),
      ).toBeUndefined();
      expect(getterReads).toBe(0);
    } finally {
      fixture.close();
    }
  });

  it("keeps unsupported audience, comparison, scope, site set, and filter shapes off the brand", async () => {
    const fixture = createFixture();
    try {
      const query = queryFor({ page: { limit: 4, cursor: null } });
      const publicQuery = queryFor({
        audience: "public-share",
        filters: EMPTY_FILTER_DOCUMENT,
      });
      const comparisonQuery = queryFor({
        filters: EMPTY_FILTER_DOCUMENT,
        comparison: {
          current: { time: TIME, filters: EMPTY_FILTER_DOCUMENT },
          reference: { time: PREVIOUS_TIME, filters: EMPTY_FILTER_DOCUMENT },
          metric: "views",
          sortBy: "current",
          direction: "desc",
        },
      });
      const teamQuery = {
        ...query,
        context: teamQueryContext("wave97e-team", "private-dashboard", [
          SITE,
          "wave97e-secondary-site",
        ]),
      } as PagesDashboardQuery;
      const multiSiteQuery = {
        ...query,
        context: {
          ...query.context,
          subject: {
            kind: "site",
            siteId: SITE,
            siteIds: [SITE, "wave97e-secondary-site"],
          },
        },
      } as unknown as PagesDashboardQuery;
      for (const unsupported of [
        publicQuery,
        comparisonQuery,
        teamQuery,
        multiSiteQuery,
      ]) {
        expect(
          pagesDashboardQualificationConfigurationFromQuery(unsupported),
        ).toBeUndefined();
        expect(
          deferredPagesDashboardQualificationFromQuery(
            await forwardMiddlewareQuery(fixture, unsupported),
          ),
        ).toBeUndefined();
      }

      const mixedOrFilters = parseFilterDsl(
        'page.path eq "/docs/a" or count(event { event.name eq "qualifier" }) eq 1',
        analyticsFilterRegistry,
      );
      const mixedOrQuery = queryFor({ filters: mixedOrFilters });
      const mixedOrForwarded = await forwardMiddlewareQuery(
        fixture,
        mixedOrQuery,
      );
      const mixedOrDeferred =
        deferredPagesDashboardQualificationFromQuery(mixedOrForwarded);
      expect(mixedOrDeferred).toBeDefined();
      expect(mixedOrDeferred?.qualification.filters.root).toEqual(
        mixedOrFilters.root,
      );
      expect(
        mixedOrDeferred?.qualification.countInput.analysis.document.root,
      ).toEqual(mixedOrFilters.root);

      const payloadCountFilters = parseFilterDsl(
        'page.path eq "/docs/a" and count(event { event.payload("/kind") eq "sale" }) gte 1',
        analyticsFilterRegistry,
      );
      const payloadCountQuery = queryFor({ filters: payloadCountFilters });
      expect(
        pagesDashboardQualificationConfigurationFromQuery(payloadCountQuery),
      ).toBeDefined();
      expect(
        deferredPagesDashboardQualificationFromQuery(
          await forwardMiddlewareQuery(fixture, payloadCountQuery),
        ),
      ).toBeUndefined();
    } finally {
      fixture.close();
    }
  });

  it("keeps a valid controls row from hiding an invalid cursor", async () => {
    await withFixture(async (fixture) => {
      const query = queryFor({
        page: { limit: 4, cursor: "not-a-valid-cursor" },
      });
      const fallbackSpy = vi.spyOn(
        advancedFilterExecution,
        "prepareDeferredEventQualificationFallback",
      );
      fallbackSpy.mockClear();
      try {
        await expect(
          providerFor(fixture).execute(query),
        ).rejects.toBeInstanceOf(InvalidCursorError);
        const statements = takeTrace(fixture);
        expect(statements).toHaveLength(2);
        expect(
          statements.filter(({ sql }) => sql.toLowerCase().includes("rowkind")),
        ).toHaveLength(1);
        expect(fallbackSpy).not.toHaveBeenCalled();
      } finally {
        fallbackSpy.mockRestore();
      }
    });
  });

  it("keeps zero-limit cursor validation after the controls query", async () => {
    await withFixture(async (fixture) => {
      const query = queryFor({
        page: { limit: 0, cursor: "not-a-valid-cursor" },
      });
      await expect(providerFor(fixture).execute(query)).rejects.toBeInstanceOf(
        InvalidCursorError,
      );
      expect(
        takeTrace(fixture).filter(({ sql }) =>
          sql.toLowerCase().includes("rowkind"),
        ),
      ).toHaveLength(1);
    });
  });

  it("stops before report SQL for an aborted request", async () => {
    await withFixture(async (fixture) => {
      const controller = new AbortController();
      controller.abort();
      const fallbackSpy = vi.spyOn(
        advancedFilterExecution,
        "prepareDeferredEventQualificationFallback",
      );
      fallbackSpy.mockClear();
      try {
        await expect(
          providerFor(fixture).execute(queryFor(), {
            signal: controller.signal,
          }),
        ).rejects.toHaveProperty("name", "AbortError");
        const statements = takeTrace(fixture);
        expect(
          statements.filter(({ sql }) => sql.toLowerCase().includes("rowkind")),
        ).toHaveLength(0);
        expect(fallbackSpy).not.toHaveBeenCalled();
      } finally {
        fallbackSpy.mockRestore();
      }
    });
  });

  it("propagates unexpected D1 report errors without fallback", async () => {
    await withFixture(async (fixture) => {
      const originalDb = fixture.env.DB as unknown as object;
      const marker = new Error("wave97e_report_query_failed");
      let reportQueryAttempts = 0;
      const fallbackSpy = vi.spyOn(
        advancedFilterExecution,
        "prepareDeferredEventQualificationFallback",
      );
      fallbackSpy.mockClear();
      const failingDb = new Proxy(originalDb, {
        get(target, property) {
          if (property !== "prepare")
            return Reflect.get(target, property, target);
          const prepare = Reflect.get(target, property, target) as (
            sql: string,
          ) => unknown;
          return (sql: string) => {
            if (sql.toLowerCase().includes("rowkind")) {
              reportQueryAttempts += 1;
              throw marker;
            }
            return Reflect.apply(prepare, target, [sql]);
          };
        },
      });
      (fixture.env as unknown as { DB: unknown }).DB = failingDb;
      try {
        await expect(providerFor(fixture).execute(queryFor())).rejects.toBe(
          marker,
        );
        expect(reportQueryAttempts).toBe(1);
        expect(fallbackSpy).not.toHaveBeenCalled();
        expect(
          takeTrace(fixture).filter(({ sql }) =>
            sql.toLowerCase().includes("rowkind"),
          ),
        ).toHaveLength(0);
      } finally {
        fallbackSpy.mockRestore();
      }
    });
  });

  it.each(reportProtocolCases)(
    "rejects report protocol mutation: $id",
    async ({ id, expectedError, mutate }) => {
      await withFixture(async (fixture) => {
        const adapter = installReportResultMutation(fixture, (rows) =>
          rowsForProtocolMutation(rows, mutate),
        );
        let observedError: string | undefined;
        try {
          await providerFor(fixture).execute(
            queryFor({ page: { limit: 4, cursor: null } }),
          );
        } catch (error) {
          observedError =
            error instanceof Error ? error.message : String(error);
        }
        const statements = takeTrace(fixture);
        expect(observedError).toContain(expectedError);
        expect(adapter.reportReads).toBe(1);
        expect(adapter.nativeRows.length).toBeGreaterThan(0);
        expect(
          statements.filter(({ sql }) => sql.toLowerCase().includes("rowkind")),
        ).toHaveLength(1);
        expect(statements).toHaveLength(2);
        protocolEvidence.push({
          id,
          expectedError,
          observedError,
          actualSqlExecutedBeforeMutation: true,
          nativeSqlRowCount: adapter.nativeRows.length,
          reportReads: adapter.reportReads,
          statementCount: statements.length,
          fallback: false,
        });
      });
    },
  );

  it("enforces the raw activity cap before invalid-cursor reporting", async () => {
    await withFixture(async (fixture) => {
      const adapter = installReportResultMutation(fixture, (rows) =>
        rows
          .filter((row) => row.rowKind === "control")
          .map((row) => ({ ...row, rawCount: 20_001 })),
      );
      await expect(
        providerFor(fixture).execute(
          queryFor({ page: { limit: 4, cursor: "not-a-valid-cursor" } }),
        ),
      ).rejects.toMatchObject({
        domainError: {
          kind: "invalid-input",
          issues: [{ path: "filters", code: "filter_activity_limit_exceeded" }],
        },
      });
      const statements = takeTrace(fixture);
      expect(adapter.reportReads).toBe(1);
      expect(
        adapter.nativeRows.filter((row) => row.rowKind === "report"),
      ).not.toHaveLength(0);
      expect(statements).toHaveLength(2);
      protocolEvidence.push({
        id: "activity-cap-20001-invalid-cursor-precedence",
        injectedRawCount: 20_001,
        nativeSqlReportRows: reportRows(adapter.nativeRows).length,
        mutatedReportRows: 0,
        actualSqlExecutedBeforeMutation: true,
        reportReads: adapter.reportReads,
        statementCount: statements.length,
        fallback: false,
        errorCode: "filter_activity_limit_exceeded",
      });
    });
  });

  it("rejects report rows that leak with a numeric incompatibility control", async () => {
    await withFixture(async (fixture) => {
      const filters = parseFilterDsl(
        'page.path neq "/excluded" and count(event { event.name eq "qualifier" }) eq 1 and count(page { page.durationMs gt 5 }) gte 1',
        analyticsFilterRegistry,
      );
      const adapter = installReportResultMutation(fixture, (rows) => {
        const control = controlRow(rows);
        const numericField = Object.keys(control).find(
          (name) =>
            name.toLowerCase().includes("invalid") &&
            name.toLowerCase().includes("duration") &&
            name.toLowerCase().includes("count"),
        );
        if (!numericField)
          throw new Error("wave97e_protocol_numeric_control_missing");
        return rows.map((row) =>
          row.rowKind === "control" ? { ...row, [numericField]: 1 } : row,
        );
      });
      const fallbackSpy = vi.spyOn(
        advancedFilterExecution,
        "prepareDeferredEventQualificationFallback",
      );
      fallbackSpy.mockClear();
      try {
        await expect(
          providerFor(fixture).execute(
            queryFor({ filters, page: { limit: 4, cursor: null } }),
          ),
        ).rejects.toThrow("pages_dashboard_qualification_gate_violation");
        expect(reportRows(adapter.nativeRows).length).toBeGreaterThan(0);
        expect(adapter.reportReads).toBe(1);
        expect(fallbackSpy).not.toHaveBeenCalled();
        const statements = takeTrace(fixture);
        expect(statements).toHaveLength(2);
        protocolEvidence.push({
          id: "numeric-incompatibility-control-with-leaked-report-rows",
          simulation: true,
          nativeSqlReportRows: reportRows(adapter.nativeRows).length,
          reportReads: adapter.reportReads,
          error: "pages_dashboard_qualification_gate_violation",
          fallbackCalls: fallbackSpy.mock.calls.length,
          statementCount: statements.length,
        });
      } finally {
        fallbackSpy.mockRestore();
      }
    });
  });

  it("uses the actual numeric Count control to fall back for the whole dashboard DTO", async () => {
    await withFixture(async (fixture) => {
      fixture.database
        .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
        .run("invalid-duration", "current-0");
      const filters = parseFilterDsl(
        'page.path neq "/excluded" and count(event { event.name eq "qualifier" }) eq 1 and count(page { page.durationMs gt 5 }) gte 1',
        analyticsFilterRegistry,
      );
      const query = queryFor({ filters, page: { limit: 4, cursor: null } });
      const expected = await executeLegacyDashboard(fixture, query);
      const legacyStatements = takeTrace(fixture);
      const diagnostics = createD1ReadDiagnostics();
      const fallbackSpy = vi.spyOn(
        advancedFilterExecution,
        "prepareDeferredEventQualificationFallback",
      );
      fallbackSpy.mockClear();
      try {
        const actual = await createD1SiteProviderRegistry({
          env: fixture.env,
          siteId: SITE,
          diagnostics,
        })
          .resolve("pages-dashboard")!
          .execute(query);
        expect(actual.value).toEqual(expected);
        expect(diagnostics.advancedCountSqlFallbackReason).toMatchObject({
          kind: "numeric-data-domain",
        });
        expect(fallbackSpy).toHaveBeenCalledTimes(0);
        const statements = takeTrace(fixture);
        // Only the fused qualification statement carries the control rows; the
        // fallback reads the request-private entity membership instead of the
        // legacy ID bridge, so its report statements legitimately differ.
        const reportStatements = statementsAbsentFrom(
          statements,
          legacyStatements,
        ).filter(
          ({ sql }) =>
            sql.toLowerCase().includes("rowkind") &&
            sql.toLowerCase().includes("control"),
        );
        expect(reportStatements).toHaveLength(1);
        const rawRows = fixture.database
          .prepare(reportStatements[0]!.sql)
          .all(...(reportStatements[0]!.bindings as SQLInputValue[])) as Record<
          string,
          unknown
        >[];
        const rawControls = rawRows.filter((row) => row.rowKind === "control");
        expect(rawControls).toHaveLength(1);
        const numericMismatch = Object.entries(rawControls[0]!).find(
          ([name, value]) =>
            name.toLowerCase().includes("duration") &&
            typeof value === "number" &&
            value > 0,
        );
        expect(numericMismatch).toBeDefined();
        expect(reportRows(rawRows)).toHaveLength(0);
        protocolEvidence.push({
          id: "real-numeric-data-domain-whole-request-fallback",
          actualStoredDurationType: typeof (
            fixture.database
              .prepare("SELECT duration_ms FROM visits WHERE visit_id = ?")
              .get("current-0") as { duration_ms: unknown }
          ).duration_ms,
          numericControl: numericMismatch,
          fallbackReason: diagnostics.advancedCountSqlFallbackReason,
          fallbackCalls: fallbackSpy.mock.calls.length,
          expectedDto: expected,
          actualDto: actual.value,
          statementCount: statements.length,
          legacyStatementCount: legacyStatements.length,
          reportRows: 0,
          legacySqlSequenceParity: true,
        });
      } finally {
        fallbackSpy.mockRestore();
      }
    });
  });

  it("falls back once when compiler admission is unavailable", async () => {
    await withFixture(async (fixture) => {
      const query = queryFor({ page: { limit: 4, cursor: null } });
      const expected = await executeLegacyDashboard(fixture, query);
      const legacyStatements = takeTrace(fixture);
      const fallbackSpy = vi.spyOn(
        advancedFilterExecution,
        "prepareDeferredEventQualificationFallback",
      );
      fallbackSpy.mockClear();
      const simulatedUnavailable = {
        kind: "unavailable",
        fallbackReason: {
          kind: "compile-budget",
          item: "simulated-pages-dashboard-admission",
          actual: 100_001,
          limit: 100_000,
        },
        qualification: {},
      } as unknown as ReturnType<PagesDashboardCompiler>;
      let compilerCalls = 0;
      const compilerSimulation: PagesDashboardCompiler = () => {
        compilerCalls += 1;
        return simulatedUnavailable;
      };
      try {
        const actual = await createD1SiteProviderRegistry({
          env: fixture.env,
          siteId: SITE,
          pagesDashboardQualificationCompile: compilerSimulation,
        })
          .resolve("pages-dashboard")!
          .execute(query);
        expect(actual.value).toEqual(expected);
        expect(compilerCalls).toBe(1);
        expect(fallbackSpy).toHaveBeenCalledTimes(0);
        const statements = takeTrace(fixture);
        expect(
          statementsAbsentFrom(statements, legacyStatements).filter(
            ({ sql }) =>
              sql.toLowerCase().includes("rowkind") &&
              sql.toLowerCase().includes("control"),
          ),
        ).toHaveLength(0);
        protocolEvidence.push({
          id: "simulated-compiler-admission-unavailable",
          simulation: true,
          compilerCalls,
          fallbackCalls: fallbackSpy.mock.calls.length,
          expectedDto: expected,
          actualDto: actual.value,
          reportSqlExecutions: 0,
          legacySqlSequenceParity: true,
        });
      } finally {
        fallbackSpy.mockRestore();
      }
    });
  });
});
