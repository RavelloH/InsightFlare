import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SQLInputValue } from "node:sqlite";

import { afterAll, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { D1_MAX_BOUND_PARAMETERS, D1_MAX_SQL_UTF8_BYTES } from "@/lib/db";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import {
  type PagesDashboardMetric,
  prepareScopedQuery,
  type QueryInput,
  type QueryTime,
  type ScopedFilterPlan,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { createQueryTime } from "@/lib/edge/analytics/contract/helpers";
import { PAGES_DASHBOARD_QUALIFICATION_OUTPUTS } from "@/lib/edge/analytics/engine/pages-dashboard-qualification-plan";
import {
  d1AdvancedFilterMiddleware,
  deferredPageDimensionQualificationFromQuery,
  prepareDeferredEventQualificationFallback,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import {
  buildTimeBuckets,
  timeBucketTimestamp,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  queryPageCardDetailsFromD1,
  queryPageCardMetricsFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/pages";
import { queryPagesDashboard } from "@/lib/edge/analytics/providers/d1/internal/pages-dashboard";
import { compilePagesDashboardQualificationProgram } from "@/lib/edge/analytics/providers/d1/internal/pages-dashboard-qualification-compiler";
import type { Env } from "@/lib/edge/types";
import {
  analyticsFilterRegistry,
  type FilterDocument,
  parseFilterDsl,
} from "@/lib/filter-contract";

const SITE = "wave97d-dashboard-preflight";
const TIME = createQueryTime(120, 130, "UTC", 500);
const FILTERS = parseFilterDsl(
  'page.path eq "/landing" and count(event { event.name eq "qualifier" }) eq 1',
  analyticsFilterRegistry,
);
const ARTIFACT_DIR = process.env.WAVE97D_ARTIFACT_DIR;

const CASES = [
  { scope: "session", sort: "views", direction: "desc" },
  { scope: "session", sort: "avgDurationMs", direction: "asc" },
  { scope: "visitor", sort: "views", direction: "desc" },
  { scope: "visitor", sort: "bounceRate", direction: "desc" },
] as const;

function createPreflightQuery(
  scope: (typeof CASES)[number]["scope"],
  sort: (typeof CASES)[number]["sort"],
  direction: (typeof CASES)[number]["direction"],
  filters: FilterDocument = FILTERS,
  time = TIME,
): QueryInput & Record<string, unknown> {
  const prepared = prepareScopedQuery("dimension", {
    context: siteQueryContext(SITE, "private-dashboard"),
    time,
    filters,
    scopePreference: scope,
  } as QueryInput & { readonly time: typeof TIME });
  return {
    ...prepared,
    mode: "breakdown",
    dimension: "geo.country",
    page: { limit: 12, cursor: null },
    sort: { key: sort, direction },
    search: "",
  } as QueryInput & Record<string, unknown>;
}

const COMPARISON_START = Date.UTC(2026, 9, 1);
const COMPARISON_END = Date.UTC(2026, 10, 1);
const COMPARISON_TIME = createQueryTime(
  COMPARISON_START,
  COMPARISON_END,
  "America/Los_Angeles",
  COMPARISON_END + 86_400_000,
);
const COMPARISON_WINDOW = {
  startMs: COMPARISON_START,
  endExclusiveMs: COMPARISON_END,
  nowMs: COMPARISON_END + 86_400_000,
  timeZone: "America/Los_Angeles",
} as const;
const PREVIOUS_WINDOW = {
  ...COMPARISON_WINDOW,
  startMs: COMPARISON_START - (COMPARISON_END - COMPARISON_START),
  endExclusiveMs: COMPARISON_START,
} as const;
const COMPARISON_FILTERS = parseFilterDsl(
  'page.path neq "/excluded" and count(event { event.name eq "qualifier" }) eq 1',
  analyticsFilterRegistry,
);
const SORT_KEYS = [
  "views",
  "visitors",
  "sessions",
  "bounceRate",
  "pagesPerSession",
  "avgDurationMs",
] as const satisfies readonly PagesDashboardMetric[];
type OracleCase = {
  readonly id: string;
  readonly scenario:
    | "sort"
    | "first-cursor"
    | "next-cursor"
    | "raw-path"
    | "whitespace"
    | "empty";
  readonly sort: PagesDashboardMetric;
  readonly direction: "asc" | "desc";
  readonly interval: "week" | "month";
  readonly timeZone?: "UTC" | "America/Los_Angeles";
  readonly limit: number;
};
const SORT_ORACLE_CASES: OracleCase[] = SORT_KEYS.flatMap((sort) =>
  (["asc", "desc"] as const).map((direction) => ({
    id: `${sort}-${direction}-week-la`,
    scenario: "sort" as const,
    sort,
    direction,
    interval: "week" as const,
    timeZone: "America/Los_Angeles" as const,
    limit: 2,
  })),
);
const ORACLE_CASES: OracleCase[] = [
  ...SORT_ORACLE_CASES,
  {
    id: "views-desc-month-la",
    scenario: "sort",
    sort: "views",
    direction: "desc",
    interval: "month",
    timeZone: "America/Los_Angeles",
    limit: 12,
  },
  {
    id: "views-asc-week-utc",
    scenario: "sort",
    sort: "views",
    direction: "asc",
    interval: "week",
    timeZone: "UTC",
    limit: 2,
  },
  {
    id: "views-desc-month-utc",
    scenario: "sort",
    sort: "views",
    direction: "desc",
    interval: "month",
    timeZone: "UTC",
    limit: 12,
  },
  {
    id: "limit1-first-page",
    scenario: "first-cursor",
    sort: "views",
    direction: "desc",
    interval: "week",
    timeZone: "America/Los_Angeles",
    limit: 1,
  },
  {
    id: "limit1-next-page",
    scenario: "next-cursor",
    sort: "views",
    direction: "desc",
    interval: "week",
    timeZone: "America/Los_Angeles",
    limit: 1,
  },
  {
    id: "raw-path-and-cohort-edge-cases",
    scenario: "raw-path",
    sort: "views",
    direction: "desc",
    interval: "week",
    timeZone: "America/Los_Angeles",
    limit: 50,
  },
  {
    id: "all-whitespace-selected-path",
    scenario: "whitespace",
    sort: "views",
    direction: "desc",
    interval: "week",
    timeZone: "America/Los_Angeles",
    limit: 12,
  },
  {
    id: "empty-current-page",
    scenario: "empty",
    sort: "views",
    direction: "desc",
    interval: "month",
    timeZone: "UTC",
    limit: 12,
  },
];
const completedOracleCases = new Map<string, Record<string, unknown>>();
type PreparedQualificationQuery = QueryInput &
  Record<string, unknown> & {
    readonly time: QueryTime;
    readonly filters: FilterDocument;
    readonly scopePlan: ScopedFilterPlan;
  };

afterAll(() => {
  if (!ARTIFACT_DIR) return;
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const expectedIds = ORACLE_CASES.map(({ id }) => id);
  const completedIds = [...completedOracleCases.keys()].sort();
  writeFileSync(
    join(ARTIFACT_DIR, "oracle-comparisons.json"),
    JSON.stringify(
      {
        source:
          "local node:sqlite execution compared to legacy Dashboard and readers",
        state: expectedIds.every((id) => completedOracleCases.has(id))
          ? "complete"
          : "partial",
        expectedCaseCount: expectedIds.length,
        completedCaseCount: completedIds.length,
        expectedIds,
        completedIds,
        missingIds: expectedIds.filter((id) => !completedOracleCases.has(id)),
        metricSortDirectionCaseCount: 12,
        cases: expectedIds.flatMap((id) => {
          const evidence = completedOracleCases.get(id);
          return evidence ? [{ id, ...evidence }] : [];
        }),
      },
      null,
      2,
    ),
    "utf8",
  );
});

function addDashboardVisit(
  database: ReturnType<typeof createMigratedDatabase>,
  input: {
    readonly id: string;
    readonly at: number;
    readonly pathname: string;
    readonly title: string;
    readonly duration: number;
    readonly sessionId?: string;
    readonly visitorId?: string;
  },
): void {
  database
    .prepare(
      `INSERT INTO visits (
        visit_id, site_id, site_pk, visitor_id, session_id, status, started_at,
        last_activity_at, pathname, hostname, duration_ms, title
      ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, 'dashboard.test', ?, ?)`,
    )
    .run(
      input.id,
      SITE,
      Number(
        (
          database
            .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
            .get(SITE) as { readonly site_pk: number }
        ).site_pk,
      ),
      input.visitorId ?? "wave97d-visitor",
      input.sessionId ?? "wave97d-session",
      input.at,
      input.at,
      input.pathname,
      input.duration,
      input.title,
    );
}

function addDashboardQualifierEvent(
  database: ReturnType<typeof createMigratedDatabase>,
  visitId: string,
  at: number,
): void {
  const sitePk = Number(
    (
      database
        .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
        .get(SITE) as { readonly site_pk: number }
    ).site_pk,
  );
  database
    .prepare(
      `INSERT INTO custom_event_names (id, site_id, name, last_seen_at, site_pk)
       VALUES (1, ?, 'qualifier', ?, ?) ON CONFLICT(id) DO NOTHING`,
    )
    .run(SITE, at, sitePk);
  database
    .prepare(
      `INSERT INTO custom_events (
        event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
        received_at, sequence, node_count, value_count
      ) VALUES (?, ?, ?, ?, 1, ?, ?, 1, 0, 0)`,
    )
    .run(`event-${visitId}`, SITE, sitePk, visitId, at, at);
}

function sqliteNumber(row: Record<string, unknown>, field: string): number {
  return Number(row[field] ?? 0);
}

function currentSortValue(
  metric: PagesDashboardMetric,
  item: {
    readonly metrics: {
      readonly views: number;
      readonly visitors: number;
      readonly sessions: number;
      readonly bounceRate: number;
      readonly pagesPerSession: number;
      readonly avgDurationMs: number;
    };
  },
): number {
  return item.metrics[metric];
}

describe("Pages Dashboard complete compile preflight", () => {
  it.each(CASES)(
    "compiles $scope $sort $direction full current/previous/details shape from the prepared Count input",
    async (smokeCase) => {
      const database = createMigratedDatabase();
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const env = {
        DB: createSqliteD1Database(database, trace),
        MAIN_SECRET: "wave97d-preflight-only",
      } as unknown as Env;
      try {
        database
          .prepare("INSERT INTO users (id, email) VALUES (?, ?)")
          .run("wave97d-user", "wave97d@example.test");
        database
          .prepare(
            "INSERT INTO teams (id, name, slug, owner_user_id) VALUES (?, ?, ?, ?)",
          )
          .run("wave97d-team", "Wave97D", "wave97d-team", "wave97d-user");
        database
          .prepare(
            "INSERT INTO sites (id, team_id, name, domain, created_at) VALUES (?, 'wave97d-team', 'Preflight', 'preflight.test', 0)",
          )
          .run(SITE);
        database
          .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
          .run(SITE);

        const query = createPreflightQuery(
          smokeCase.scope,
          smokeCase.sort,
          smokeCase.direction,
        );
        const forwarded = await d1AdvancedFilterMiddleware(
          env,
          undefined,
          SITE,
        )("dimension", query, async (prepared) => prepared);
        const forwardedQuery = forwarded as PreparedQualificationQuery;
        const deferred =
          deferredPageDimensionQualificationFromQuery(forwardedQuery);
        if (!deferred) throw new Error("wave97d_prepared_count_input_missing");
        const compilation = compilePagesDashboardQualificationProgram({
          query: forwardedQuery,
          qualification: {
            siteId: SITE,
            queryTime: forwardedQuery.time!,
            filters: forwardedQuery.filters!,
            scopePlan: forwardedQuery.scopePlan!,
            count: deferred.countInput,
            interval: "day",
            limit: 12,
            sort: smokeCase.sort,
            direction: smokeCase.direction,
          },
        });
        const record: Record<string, unknown> = {
          scope: smokeCase.scope,
          sort: smokeCase.sort,
          direction: smokeCase.direction,
          resultKind: compilation.kind,
          ...(compilation.kind === "compiled"
            ? {
                sqlBytes: compilation.evidence.sqlBytes,
                bindingCount: compilation.evidence.bindingCount,
                groupWidth: compilation.evidence.groupWidth,
                groupedSummaryProof: compilation.evidence.groupedSummaryProof,
                sharedRelationCount: compilation.evidence.sharedRelationCount,
                rootKind: compilation.evidence.rootKind,
                sql: compilation.evidence.sql,
                bindings: compilation.evidence.bindings,
                physicalPlanShape:
                  compilation.evidence.physicalPlanShape ?? null,
                logicalPlan: compilation.evidence.logicalPlan,
              }
            : {
                fallbackReason: compilation.fallbackReason,
                admissionEvidence:
                  "admissionEvidence" in compilation
                    ? (compilation.admissionEvidence ?? null)
                    : null,
                logicalPlan:
                  "qualification" in compilation
                    ? compilation.qualification.plan
                    : null,
              }),
        };
        expect(record.scope).toBe(smokeCase.scope);
        expect(record.sort).toBe(smokeCase.sort);
        expect(record.direction).toBe(smokeCase.direction);
        if (record.resultKind === "compiled") {
          expect(record.sqlBytes).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
          expect(record.bindingCount).toBeLessThanOrEqual(
            D1_MAX_BOUND_PARAMETERS,
          );
        } else {
          expect(record.fallbackReason).toBeDefined();
        }
        if (ARTIFACT_DIR) {
          mkdirSync(ARTIFACT_DIR, { recursive: true });
          writeFileSync(
            join(
              ARTIFACT_DIR,
              `${smokeCase.scope}-${smokeCase.sort}-${smokeCase.direction}.json`,
            ),
            JSON.stringify(record, null, 2),
            "utf8",
          );
        }
      } finally {
        database.close();
      }
    },
  );

  it.each(ORACLE_CASES)(
    "matches the legacy dashboard: $id",
    async (oracleCase) => {
      const database = createMigratedDatabase();
      database.exec("PRAGMA foreign_keys = OFF");
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const env = {
        DB: createSqliteD1Database(database, trace),
        MAIN_SECRET: "wave97d-dashboard-oracle-secret",
        MAIN_SECRET_PREVIOUS: "",
      } as unknown as Env;
      try {
        database
          .prepare("INSERT INTO users (id, email) VALUES (?, ?)")
          .run("wave97d-user", "wave97d@example.test");
        database
          .prepare(
            "INSERT INTO teams (id, name, slug, owner_user_id) VALUES (?, ?, ?, ?)",
          )
          .run("wave97d-team", "Wave97D", "wave97d-team", "wave97d-user");
        database
          .prepare(
            "INSERT INTO sites (id, team_id, name, domain, created_at) VALUES (?, 'wave97d-team', 'Dashboard Oracle', 'dashboard.test', 0)",
          )
          .run(SITE);
        database
          .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
          .run(SITE);

        const fixtures = [
          ["old-alpha-a", "2026-09-02T12:00:00.000Z", "/alpha", "Alpha", 500],
          ["old-alpha-b", "2026-09-18T12:00:00.000Z", "/alpha", "Alpha", 700],
          ["old-beta", "2026-09-03T12:00:00.000Z", "/beta", "Beta", 300],
          ["old-gamma", "2026-09-05T12:00:00.000Z", "/gamma", "Gamma", 250],
          ["old-delta", "2026-09-08T12:00:00.000Z", "/delta", "Delta", 150],
          ["alpha-a", "2026-10-02T12:00:00.000Z", "/alpha", "Alpha", 100],
          ["alpha-b", "2026-10-06T12:00:00.000Z", "/alpha", "Alpha", 200],
          ["alpha-c", "2026-10-13T12:00:00.000Z", "/alpha", "Alpha", 600],
          ["beta-a", "2026-10-03T12:00:00.000Z", "/beta", "Beta", 300],
          ["beta-b", "2026-10-27T12:00:00.000Z", "/beta", "Beta", 300],
          ["gamma-a", "2026-10-04T12:00:00.000Z", "/gamma", "Gamma", 100],
          ["gamma-b", "2026-10-05T12:00:00.000Z", "/gamma", "Gamma", 200],
          ["gamma-c", "2026-10-20T12:00:00.000Z", "/gamma", "Gamma", 250],
          ["gamma-d", "2026-10-29T12:00:00.000Z", "/gamma", "Gamma", 250],
          ["delta-a", "2026-10-08T12:00:00.000Z", "/delta", "Delta", 1500],
        ] as const;
        for (const [id, timestamp, pathname, title, duration] of fixtures) {
          addDashboardVisit(database, {
            id,
            at: Date.parse(timestamp),
            pathname,
            title,
            duration,
          });
        }
        addDashboardQualifierEvent(
          database,
          "alpha-a",
          Date.parse("2026-10-02T12:01:00.000Z"),
        );

        const baseQuery = createPreflightQuery(
          "session",
          "views",
          "desc",
          COMPARISON_FILTERS,
          COMPARISON_TIME,
        );
        const forwarded = await d1AdvancedFilterMiddleware(
          env,
          undefined,
          SITE,
        )("dimension", baseQuery, async (prepared) => prepared);
        const forwardedQuery = forwarded as PreparedQualificationQuery;
        const deferred =
          deferredPageDimensionQualificationFromQuery(forwardedQuery);
        if (!deferred)
          throw new Error("wave97d_dashboard_oracle_count_input_missing");
        const legacyFilters =
          await prepareDeferredEventQualificationFallback(deferred);
        const oracleEvidence: Array<Record<string, unknown>> = [];
        const contextForZone = async (
          timeZone: "UTC" | "America/Los_Angeles",
        ) => {
          if (timeZone === "America/Los_Angeles")
            return { forwarded: forwardedQuery, deferred, legacyFilters };
          const utcTime = createQueryTime(
            COMPARISON_START,
            COMPARISON_END,
            timeZone,
            COMPARISON_TIME.capturedAtMs,
          );
          const utcQuery = createPreflightQuery(
            "session",
            "views",
            "desc",
            COMPARISON_FILTERS,
            utcTime,
          );
          const value = await d1AdvancedFilterMiddleware(env, undefined, SITE)(
            "dimension",
            utcQuery,
            async (prepared) => prepared,
          );
          const forwarded = value as PreparedQualificationQuery;
          const utcDeferred =
            deferredPageDimensionQualificationFromQuery(forwarded);
          if (!utcDeferred) throw new Error("wave97d_utc_count_input_missing");
          return {
            forwarded,
            deferred: utcDeferred,
            legacyFilters:
              await prepareDeferredEventQualificationFallback(utcDeferred),
          };
        };

        const compareCase = async (input: {
          readonly sort: PagesDashboardMetric;
          readonly direction: "asc" | "desc";
          readonly interval: "week" | "month";
          readonly timeZone?: "UTC" | "America/Los_Angeles";
          readonly limit: number;
          readonly engineCursor?: {
            readonly primary: number;
            readonly secondary: number;
            readonly pathname: string;
          } | null;
          readonly legacyCursor?: string | null;
        }) => {
          const timeZone = input.timeZone ?? "America/Los_Angeles";
          const context = await contextForZone(timeZone);
          const currentWindow = { ...COMPARISON_WINDOW, timeZone };
          const previousWindow = { ...PREVIOUS_WINDOW, timeZone };
          const legacy = await queryPagesDashboard(env, SITE, {
            window: currentWindow,
            filters: context.legacyFilters,
            interval: input.interval,
            page: { limit: input.limit, cursor: input.legacyCursor ?? null },
            sort: { key: input.sort, direction: input.direction },
          });
          const compilation = compilePagesDashboardQualificationProgram({
            query: context.forwarded,
            qualification: {
              siteId: SITE,
              queryTime: context.forwarded.time,
              filters: context.forwarded.filters,
              scopePlan: context.forwarded.scopePlan,
              count: context.deferred.countInput,
              interval: input.interval,
              limit: input.limit,
              sort: input.sort,
              direction: input.direction,
              cursor: input.engineCursor ?? null,
              search: "",
            },
          });
          expect(compilation.kind).toBe("compiled");
          if (compilation.kind !== "compiled")
            throw new Error(
              `wave97d_dashboard_compile_refused:${compilation.fallbackReason}`,
            );
          expect(compilation.evidence.sqlBytes).toBeLessThanOrEqual(
            D1_MAX_SQL_UTF8_BYTES,
          );
          expect(compilation.evidence.bindingCount).toBeLessThanOrEqual(
            D1_MAX_BOUND_PARAMETERS,
          );
          expect(compilation.evidence.groupWidth).toBe(8);
          expect(
            compilation.evidence.groupedSummaryProof
              .matchingSharedRelationCount,
          ).toBe(1);
          expect(compilation.evidence.groupedSummaryProof.materialization).toBe(
            "materialized",
          );

          const rows = database
            .prepare(compilation.evidence.sql)
            .all(
              ...(compilation.evidence.bindings as SQLInputValue[]),
            ) as Record<string, unknown>[];
          const currentRows = rows
            .filter(
              (row) =>
                row.rowKind === "report" &&
                row.outputId ===
                  PAGES_DASHBOARD_QUALIFICATION_OUTPUTS.current &&
                sqliteNumber(row, "rowOrder") <= input.limit,
            )
            .sort(
              (left, right) =>
                sqliteNumber(left, "rowOrder") -
                sqliteNumber(right, "rowOrder"),
            );
          const expectedPathnames = legacy.items.map(
            ({ pathname }) => pathname,
          );
          const legacyCurrentRows = await queryPageCardMetricsFromD1(
            env,
            SITE,
            currentWindow,
            context.legacyFilters,
            { pathnames: expectedPathnames },
          );
          const currentByPath = new Map(
            legacyCurrentRows.map((row) => [row.pathname, row] as const),
          );
          expect(currentRows.map((row) => String(row.pathname))).toEqual(
            expectedPathnames,
          );
          for (const [index, row] of currentRows.entries()) {
            const pathname = String(row.pathname);
            const legacyRaw = currentByPath.get(pathname);
            const publicItem = legacy.items[index]!;
            expect(legacyRaw).toBeDefined();
            expect({
              views: sqliteNumber(row, "views"),
              sessions: sqliteNumber(row, "sessions"),
              visitors: sqliteNumber(row, "visitors"),
              bounces: sqliteNumber(row, "bounces"),
              totalDuration: sqliteNumber(row, "totalDuration"),
              durationViews: sqliteNumber(row, "durationViews"),
            }).toEqual({
              views: legacyRaw!.views,
              sessions: legacyRaw!.sessions,
              visitors: legacyRaw!.visitors,
              bounces: legacyRaw!.bounces,
              totalDuration: legacyRaw!.totalDuration,
              durationViews: legacyRaw!.durationViews,
            });
            expect(publicItem.metrics).toEqual({
              ...publicItem.metrics,
              views: sqliteNumber(row, "views"),
              sessions: sqliteNumber(row, "sessions"),
              visitors: sqliteNumber(row, "visitors"),
              bounceRate:
                sqliteNumber(row, "sessions") > 0
                  ? Number(
                      (
                        sqliteNumber(row, "bounces") /
                        sqliteNumber(row, "sessions")
                      ).toFixed(6),
                    )
                  : 0,
              pagesPerSession:
                sqliteNumber(row, "sessions") > 0
                  ? sqliteNumber(row, "views") / sqliteNumber(row, "sessions")
                  : 0,
              avgDurationMs:
                sqliteNumber(row, "sessions") > 0
                  ? Math.round(
                      sqliteNumber(row, "totalDuration") /
                        sqliteNumber(row, "sessions"),
                    )
                  : 0,
            });
          }

          const priorMetrics = await queryPageCardMetricsFromD1(
            env,
            SITE,
            previousWindow,
            context.legacyFilters,
            { pathnames: expectedPathnames },
          );
          const priorByPath = new Map(
            priorMetrics.map((row) => [row.pathname, row] as const),
          );
          const titleRows = rows.filter(
            (row) =>
              row.rowKind === "report" &&
              row.outputId === PAGES_DASHBOARD_QUALIFICATION_OUTPUTS.titles,
          );
          const trendRows = rows.filter(
            (row) =>
              row.rowKind === "report" &&
              row.outputId === PAGES_DASHBOARD_QUALIFICATION_OUTPUTS.trend,
          );
          const buckets = buildTimeBuckets(currentWindow, input.interval);
          for (const item of legacy.items) {
            const engineRow = currentRows.find(
              (row) => String(row.pathname) === item.pathname,
            )!;
            const prior = priorByPath.get(item.pathname) ?? {
              pathname: item.pathname,
              views: 0,
              sessions: 0,
              visitors: 0,
              bounces: 0,
              totalDuration: 0,
              durationViews: 0,
            };
            expect({
              views: sqliteNumber(engineRow, "previousViews"),
              sessions: sqliteNumber(engineRow, "previousSessions"),
              visitors: sqliteNumber(engineRow, "previousVisitors"),
              bounces: sqliteNumber(engineRow, "previousBounces"),
              totalDuration: sqliteNumber(engineRow, "previousTotalDuration"),
              durationViews: sqliteNumber(engineRow, "previousDurationViews"),
            }).toEqual({
              views: prior.views,
              sessions: prior.sessions,
              visitors: prior.visitors,
              bounces: prior.bounces,
              totalDuration: prior.totalDuration,
              durationViews: prior.durationViews,
            });

            const sortedTitles = titleRows
              .filter((row) => String(row.pathname) === item.pathname)
              .sort(
                (left, right) =>
                  sqliteNumber(left, "rowOrder") -
                  sqliteNumber(right, "rowOrder"),
              )
              .map((row) => String(row.title ?? ""));
            expect(sortedTitles).toEqual(item.titles);

            const sortedTrend = trendRows
              .filter((row) => String(row.pathname) === item.pathname)
              .sort(
                (left, right) =>
                  sqliteNumber(left, "bucket") - sqliteNumber(right, "bucket"),
              )
              .map((row) => ({
                timestampMs: timeBucketTimestamp(
                  buckets,
                  sqliteNumber(row, "bucket"),
                ),
                views: sqliteNumber(row, "views"),
                visitors: sqliteNumber(row, "visitors"),
              }));
            expect(sortedTrend).toEqual(item.trend);

            const currentMetrics = item.metrics;
            const priorMetrics = {
              views: prior.views,
              visitors: prior.visitors,
              sessions: prior.sessions,
              bounceRate:
                prior.sessions > 0
                  ? Number((prior.bounces / prior.sessions).toFixed(6))
                  : 0,
              pagesPerSession:
                prior.sessions > 0 ? prior.views / prior.sessions : 0,
              avgDurationMs:
                prior.sessions > 0
                  ? Math.round(prior.totalDuration / prior.sessions)
                  : 0,
            };
            const derivedChangeRates = Object.fromEntries(
              Object.keys(currentMetrics).map((metric) => {
                const key = metric as keyof typeof currentMetrics;
                const current = currentMetrics[key];
                const previous = priorMetrics[key];
                return [
                  key,
                  !Number.isFinite(current) ||
                  !Number.isFinite(previous) ||
                  previous <= 0
                    ? null
                    : ((current - previous) / previous) * 100,
                ];
              }),
            );
            expect(item.changeRates).toEqual(derivedChangeRates);
          }
          oracleEvidence.push({
            kind: "dashboard-sort-page",
            sort: input.sort,
            direction: input.direction,
            interval: input.interval,
            timeZone,
            limit: input.limit,
            cursorUsed: Boolean(input.engineCursor),
            sqlBytes: compilation.evidence.sqlBytes,
            bindingCount: compilation.evidence.bindingCount,
            currentRows: currentRows.length,
            pageItems: legacy.items.length,
            previousMetricRows: priorMetrics.length,
            titleRows: titleRows.length,
            trendRows: trendRows.length,
          });
          return legacy;
        };

        if (oracleCase.scenario === "sort") {
          await compareCase({
            sort: oracleCase.sort,
            direction: oracleCase.direction,
            interval: oracleCase.interval,
            timeZone: oracleCase.timeZone,
            limit: oracleCase.limit,
          });
        } else if (oracleCase.scenario === "first-cursor") {
          const firstPage = await compareCase({
            sort: oracleCase.sort,
            direction: oracleCase.direction,
            interval: oracleCase.interval,
            timeZone: oracleCase.timeZone,
            limit: oracleCase.limit,
          });
          expect(firstPage.pagination.hasMore).toBe(true);
          expect(firstPage.pagination.nextCursor).toEqual(expect.any(String));
        } else if (oracleCase.scenario === "next-cursor") {
          const timeZone = oracleCase.timeZone ?? "America/Los_Angeles";
          const context = await contextForZone(timeZone);
          const firstPage = await queryPagesDashboard(env, SITE, {
            window: { ...COMPARISON_WINDOW, timeZone },
            filters: context.legacyFilters,
            interval: oracleCase.interval,
            page: { limit: oracleCase.limit, cursor: null },
            sort: { key: oracleCase.sort, direction: oracleCase.direction },
          });
          expect(firstPage.pagination.hasMore).toBe(true);
          expect(firstPage.pagination.nextCursor).toEqual(expect.any(String));
          const firstItem = firstPage.items[0]!;
          await compareCase({
            sort: oracleCase.sort,
            direction: oracleCase.direction,
            interval: oracleCase.interval,
            timeZone,
            limit: oracleCase.limit,
            legacyCursor: firstPage.pagination.nextCursor,
            engineCursor: {
              primary: currentSortValue(oracleCase.sort, firstItem),
              secondary: firstItem.metrics.sessions,
              pathname: firstItem.pathname,
            },
          });
        }

        if (oracleCase.scenario === "raw-path") {
          const edgeFixtures = [
            [
              "edge-ascii-left",
              "2026-10-02T15:00:00.000Z",
              " /collision",
              "Collision",
              10,
            ],
            [
              "edge-ascii-right",
              "2026-10-03T15:00:00.000Z",
              "/collision ",
              "Collision",
              11,
            ],
            [
              "edge-unicode-left",
              "2026-10-04T15:00:00.000Z",
              " \u00a0/collision",
              "Unicode",
              12,
            ],
            [
              "edge-unicode-right",
              "2026-10-05T15:00:00.000Z",
              "\u00a0/collision ",
              "Unicode",
              13,
            ],
            [
              "edge-title-alpha-a",
              "2026-10-06T15:00:00.000Z",
              "/titles",
              "Alpha",
              20,
            ],
            [
              "edge-title-alpha-b",
              "2026-10-07T15:00:00.000Z",
              "/titles",
              "Alpha",
              21,
            ],
            [
              "edge-title-beta-a",
              "2026-10-08T15:00:00.000Z",
              "/titles",
              "Beta",
              22,
            ],
            [
              "edge-title-beta-b",
              "2026-10-09T15:00:00.000Z",
              "/titles",
              "Beta",
              23,
            ],
            [
              "edge-title-delta",
              "2026-10-10T15:00:00.000Z",
              "/titles",
              "Delta",
              24,
            ],
            [
              "edge-title-epsilon",
              "2026-10-11T15:00:00.000Z",
              "/titles",
              "Epsilon",
              25,
            ],
            [
              "edge-empty-identity",
              "2026-10-12T15:00:00.000Z",
              "/empty-identity",
              "Empty identity",
              30,
            ],
            [
              "edge-null-identity",
              "2026-10-13T15:00:00.000Z",
              "/null-identity",
              "Null identity",
              31,
            ],
          ] as const;
          for (const [
            id,
            timestamp,
            pathname,
            title,
            duration,
          ] of edgeFixtures) {
            addDashboardVisit(database, {
              id,
              at: Date.parse(timestamp),
              pathname,
              title,
              duration,
              ...(id === "edge-empty-identity"
                ? { sessionId: "", visitorId: "" }
                : id === "edge-null-identity"
                  ? {
                      sessionId: "__NULL_SESSION__",
                      visitorId: "__NULL_VISITOR__",
                    }
                  : {}),
            });
          }
          for (const [id, timestamp, pathname, title, duration] of [
            [
              "edge-old-ascii-left",
              "2026-09-02T15:00:00.000Z",
              " /collision",
              "Collision",
              5,
            ],
            [
              "edge-old-ascii-right",
              "2026-09-03T15:00:00.000Z",
              "/collision ",
              "Collision",
              6,
            ],
            [
              "edge-old-unicode-left",
              "2026-09-04T15:00:00.000Z",
              " \u00a0/collision",
              "Unicode",
              7,
            ],
            [
              "edge-old-unicode-right",
              "2026-09-05T15:00:00.000Z",
              "\u00a0/collision ",
              "Unicode",
              8,
            ],
            [
              "edge-old-title",
              "2026-09-06T15:00:00.000Z",
              "/titles",
              "Prior title",
              9,
            ],
            [
              "edge-old-empty-identity",
              "2026-09-07T15:00:00.000Z",
              "/empty-identity",
              "Empty identity",
              10,
            ],
            [
              "edge-old-null-identity",
              "2026-09-08T15:00:00.000Z",
              "/null-identity",
              "Null identity",
              11,
            ],
          ] as const) {
            addDashboardVisit(database, {
              id,
              at: Date.parse(timestamp),
              pathname,
              title,
              duration,
              ...(id === "edge-old-empty-identity"
                ? { sessionId: "", visitorId: "" }
                : id === "edge-old-null-identity"
                  ? {
                      sessionId: "__NULL_SESSION__",
                      visitorId: "__NULL_VISITOR__",
                    }
                  : {}),
            });
          }
          addDashboardVisit(database, {
            id: "edge-previous-only-entity",
            at: Date.parse("2026-09-15T15:00:00.000Z"),
            pathname: " /collision",
            title: "Previous-only entity",
            duration: 900,
            sessionId: "wave97d-other-session",
            visitorId: "wave97d-other-visitor",
          });
          addDashboardQualifierEvent(
            database,
            "edge-previous-only-entity",
            Date.parse("2026-09-15T15:01:00.000Z"),
          );

          const edgeCompilation = compilePagesDashboardQualificationProgram({
            query: forwardedQuery,
            qualification: {
              siteId: SITE,
              queryTime: forwardedQuery.time,
              filters: forwardedQuery.filters,
              scopePlan: forwardedQuery.scopePlan,
              count: deferred.countInput,
              interval: "week",
              limit: 50,
              sort: "views",
              direction: "desc",
            },
          });
          expect(edgeCompilation.kind).toBe("compiled");
          if (edgeCompilation.kind !== "compiled")
            throw new Error(
              `wave97d_dashboard_path_edge_compile_refused:${edgeCompilation.fallbackReason}`,
            );
          const edgeRows = database
            .prepare(edgeCompilation.evidence.sql)
            .all(
              ...(edgeCompilation.evidence.bindings as SQLInputValue[]),
            ) as Record<string, unknown>[];
          const edgeCurrentRows = edgeRows.filter(
            (row) =>
              row.rowKind === "report" &&
              row.outputId === PAGES_DASHBOARD_QUALIFICATION_OUTPUTS.current &&
              sqliteNumber(row, "rowOrder") <= 50,
          );
          const edgeLegacyCurrent = await queryPageCardMetricsFromD1(
            env,
            SITE,
            COMPARISON_WINDOW,
            legacyFilters,
          );
          const edgeCurrentByPath = new Map(
            edgeCurrentRows.map((row) => [String(row.pathname), row] as const),
          );
          expect(edgeCurrentByPath.size).toBe(edgeLegacyCurrent.length);
          expect(edgeCurrentByPath.has("/empty-identity")).toBe(false);
          expect(edgeCurrentByPath.has("/null-identity")).toBe(false);
          for (const legacyRow of edgeLegacyCurrent) {
            const row = edgeCurrentByPath.get(legacyRow.pathname);
            expect(row).toBeDefined();
            expect({
              views: sqliteNumber(row!, "views"),
              sessions: sqliteNumber(row!, "sessions"),
              visitors: sqliteNumber(row!, "visitors"),
              bounces: sqliteNumber(row!, "bounces"),
              totalDuration: sqliteNumber(row!, "totalDuration"),
              durationViews: sqliteNumber(row!, "durationViews"),
            }).toEqual({
              views: legacyRow.views,
              sessions: legacyRow.sessions,
              visitors: legacyRow.visitors,
              bounces: legacyRow.bounces,
              totalDuration: legacyRow.totalDuration,
              durationViews: legacyRow.durationViews,
            });
          }
          const edgePaths = edgeLegacyCurrent.map(({ pathname }) => pathname);
          const edgeLegacyPrior = await queryPageCardMetricsFromD1(
            env,
            SITE,
            PREVIOUS_WINDOW,
            legacyFilters,
            { pathnames: edgePaths },
          );
          const edgePriorByPath = new Map(
            edgeLegacyPrior.map((row) => [row.pathname, row] as const),
          );
          for (const [pathname, row] of edgeCurrentByPath) {
            const prior = edgePriorByPath.get(pathname) ?? {
              views: 0,
              sessions: 0,
              visitors: 0,
              bounces: 0,
              totalDuration: 0,
              durationViews: 0,
            };
            expect({
              views: sqliteNumber(row, "previousViews"),
              sessions: sqliteNumber(row, "previousSessions"),
              visitors: sqliteNumber(row, "previousVisitors"),
              bounces: sqliteNumber(row, "previousBounces"),
              totalDuration: sqliteNumber(row, "previousTotalDuration"),
              durationViews: sqliteNumber(row, "previousDurationViews"),
            }).toEqual({
              views: prior.views,
              sessions: prior.sessions,
              visitors: prior.visitors,
              bounces: prior.bounces,
              totalDuration: prior.totalDuration,
              durationViews: prior.durationViews,
            });
          }
          const edgeDetails = await queryPageCardDetailsFromD1(
            env,
            SITE,
            COMPARISON_WINDOW,
            "week",
            legacyFilters,
            edgePaths,
            3,
          );
          const edgeTitles = edgeRows
            .filter(
              (row) =>
                row.rowKind === "report" &&
                row.outputId === PAGES_DASHBOARD_QUALIFICATION_OUTPUTS.titles,
            )
            .map((row) => ({
              pathname: String(row.pathname),
              title: String(row.title),
              views: sqliteNumber(row, "views"),
            }))
            .sort(
              (left, right) =>
                left.pathname.localeCompare(right.pathname) ||
                right.views - left.views ||
                left.title.localeCompare(right.title),
            );
          expect(edgeTitles).toEqual(
            edgeDetails.titles
              .map(({ pathname, title, views }) => ({ pathname, title, views }))
              .sort(
                (left, right) =>
                  left.pathname.localeCompare(right.pathname) ||
                  right.views - left.views ||
                  left.title.localeCompare(right.title),
              ),
          );
          expect(
            edgeTitles
              .filter(({ pathname }) => pathname === "/titles")
              .map(({ title }) => title),
          ).toEqual(["Alpha", "Beta", "Delta"]);
          expect(
            edgeTitles.filter(({ pathname }) => pathname === "/titles"),
          ).toHaveLength(3);
          const edgeBuckets = buildTimeBuckets(COMPARISON_WINDOW, "week");
          const edgeTrend = edgeRows
            .filter(
              (row) =>
                row.rowKind === "report" &&
                row.outputId === PAGES_DASHBOARD_QUALIFICATION_OUTPUTS.trend,
            )
            .map((row) => ({
              pathname: String(row.pathname),
              timestampMs: timeBucketTimestamp(
                edgeBuckets,
                sqliteNumber(row, "bucket"),
              ),
              views: sqliteNumber(row, "views"),
              visitors: sqliteNumber(row, "visitors"),
            }))
            .sort(
              (left, right) =>
                left.pathname.localeCompare(right.pathname) ||
                left.timestampMs - right.timestampMs,
            );
          expect(edgeTrend).toEqual(
            edgeDetails.trend
              .map(({ pathname, timestampMs, views, visitors }) => ({
                pathname,
                timestampMs,
                views,
                visitors,
              }))
              .sort(
                (left, right) =>
                  left.pathname.localeCompare(right.pathname) ||
                  left.timestampMs - right.timestampMs,
              ),
          );
          oracleEvidence.push({
            kind: "raw-path-and-cohort-edge-cases",
            sqlBytes: edgeCompilation.evidence.sqlBytes,
            bindingCount: edgeCompilation.evidence.bindingCount,
            currentRows: edgeCurrentRows.length,
            currentRawPathnames: Array.from(edgeCurrentByPath.keys()).sort(),
            asciiTrimCollisionPathCount:
              edgeCurrentByPath.has(" /collision") &&
              edgeCurrentByPath.has("/collision ")
                ? 2
                : 0,
            unicodeTrimCollisionPathCount:
              edgeCurrentByPath.has(" \u00a0/collision") &&
              edgeCurrentByPath.has("\u00a0/collision ")
                ? 2
                : 0,
            previousOnlyCountEntityExcluded: true,
            emptyAndNullSessionOrVisitorIdentityExcluded: true,
            topThreeTieOrderedTitles: edgeTitles
              .filter(({ pathname }) => pathname === "/titles")
              .map(({ title }) => title),
            trendRows: edgeTrend.length,
          });
        }

        if (oracleCase.scenario === "whitespace") {
          const whitespacePath = "\u00a0\u2003";
          addDashboardVisit(database, {
            id: "edge-whitespace-current",
            at: Date.parse("2026-10-20T12:00:00.000Z"),
            pathname: whitespacePath,
            title: "Invisible current title",
            duration: 60,
          });
          addDashboardQualifierEvent(
            database,
            "edge-whitespace-current",
            Date.parse("2026-10-20T12:01:00.000Z"),
          );
          addDashboardVisit(database, {
            id: "edge-whitespace-previous",
            at: Date.parse("2026-09-20T12:00:00.000Z"),
            pathname: whitespacePath,
            title: "Invisible previous title",
            duration: 90,
          });
          database
            .prepare("DELETE FROM visits WHERE visit_id NOT IN (?, ?)")
            .run("edge-whitespace-current", "edge-whitespace-previous");
          database
            .prepare("DELETE FROM custom_events WHERE visit_id != ?")
            .run("edge-whitespace-current");
          const whitespaceQuery = createPreflightQuery(
            "session",
            "views",
            "desc",
            COMPARISON_FILTERS,
            COMPARISON_TIME,
          );
          const whitespaceValue = await d1AdvancedFilterMiddleware(
            env,
            undefined,
            SITE,
          )("dimension", whitespaceQuery, async (prepared) => prepared);
          const whitespaceForwarded =
            whitespaceValue as PreparedQualificationQuery;
          const whitespaceDeferred =
            deferredPageDimensionQualificationFromQuery(whitespaceForwarded);
          if (!whitespaceDeferred)
            throw new Error("wave97d_empty_selected_path_count_missing");
          const whitespaceLegacyFilters =
            await prepareDeferredEventQualificationFallback(whitespaceDeferred);
          const whitespaceCompilation =
            compilePagesDashboardQualificationProgram({
              query: whitespaceForwarded,
              qualification: {
                siteId: SITE,
                queryTime: whitespaceForwarded.time,
                filters: whitespaceForwarded.filters,
                scopePlan: whitespaceForwarded.scopePlan,
                count: whitespaceDeferred.countInput,
                interval: "week",
                limit: 12,
                sort: "views",
                direction: "desc",
              },
            });
          expect(whitespaceCompilation.kind).toBe("compiled");
          if (whitespaceCompilation.kind !== "compiled")
            throw new Error(
              `wave97d_empty_selected_path_compile_refused:${whitespaceCompilation.fallbackReason}`,
            );
          const whitespaceRows = database
            .prepare(whitespaceCompilation.evidence.sql)
            .all(
              ...(whitespaceCompilation.evidence.bindings as SQLInputValue[]),
            ) as Record<string, unknown>[];
          const whitespaceCurrent = whitespaceRows.find(
            (row) =>
              row.rowKind === "report" &&
              row.outputId === PAGES_DASHBOARD_QUALIFICATION_OUTPUTS.current,
          );
          expect(whitespaceCurrent).toBeDefined();
          expect(String(whitespaceCurrent?.pathname)).toBe(whitespacePath);
          const whitespaceDashboard = await queryPagesDashboard(env, SITE, {
            window: COMPARISON_WINDOW,
            filters: whitespaceLegacyFilters,
            interval: "week",
            page: { limit: 12, cursor: null },
            sort: { key: "views", direction: "desc" },
          });
          expect(whitespaceDashboard.items).toHaveLength(1);
          expect(whitespaceDashboard.items[0]?.pathname).toBe("/");
          expect(whitespaceDashboard.items[0]?.titles).toEqual([]);
          expect(whitespaceDashboard.items[0]?.trend).toEqual([]);
          const whitespacePrevious = await queryPageCardMetricsFromD1(
            env,
            SITE,
            PREVIOUS_WINDOW,
            whitespaceLegacyFilters,
            { pathnames: [whitespacePath] },
          );
          expect(sqliteNumber(whitespaceCurrent!, "previousViews")).toBe(
            whitespacePrevious.find(
              ({ pathname }) => pathname === whitespacePath,
            )?.views,
          );
          expect(
            whitespaceRows.some(
              (row) =>
                row.rowKind === "report" &&
                (row.outputId ===
                  PAGES_DASHBOARD_QUALIFICATION_OUTPUTS.titles ||
                  row.outputId === PAGES_DASHBOARD_QUALIFICATION_OUTPUTS.trend),
            ),
          ).toBe(false);
          oracleEvidence.push({
            kind: "all-whitespace-selected-path",
            sqlBytes: whitespaceCompilation.evidence.sqlBytes,
            bindingCount: whitespaceCompilation.evidence.bindingCount,
            rawPathname: whitespacePath,
            mappedPathname: whitespaceDashboard.items[0]?.pathname,
            legacyPreviousViews:
              whitespacePrevious.find(
                ({ pathname }) => pathname === whitespacePath,
              )?.views ?? 0,
            enginePreviousViews: sqliteNumber(
              whitespaceCurrent!,
              "previousViews",
            ),
            titleRows: 0,
            trendRows: 0,
            legacyDetailsEmpty: true,
          });
        }

        if (oracleCase.scenario === "empty") {
          const emptyTime = createQueryTime(
            Date.UTC(2026, 11, 1),
            Date.UTC(2027, 0, 1),
            "UTC",
            Date.UTC(2027, 0, 2),
          );
          const emptyQuery = createPreflightQuery(
            "session",
            "views",
            "desc",
            COMPARISON_FILTERS,
            emptyTime,
          );
          const emptyValue = await d1AdvancedFilterMiddleware(
            env,
            undefined,
            SITE,
          )("dimension", emptyQuery, async (prepared) => prepared);
          const emptyForwarded = emptyValue as PreparedQualificationQuery;
          const emptyDeferred =
            deferredPageDimensionQualificationFromQuery(emptyForwarded);
          if (!emptyDeferred)
            throw new Error("wave97d_empty_page_count_input_missing");
          const emptyLegacyFilters =
            await prepareDeferredEventQualificationFallback(emptyDeferred);
          const emptyCompilation = compilePagesDashboardQualificationProgram({
            query: emptyForwarded,
            qualification: {
              siteId: SITE,
              queryTime: emptyForwarded.time,
              filters: emptyForwarded.filters,
              scopePlan: emptyForwarded.scopePlan,
              count: emptyDeferred.countInput,
              interval: "month",
              limit: 12,
              sort: "views",
              direction: "desc",
            },
          });
          expect(emptyCompilation.kind).toBe("compiled");
          if (emptyCompilation.kind !== "compiled")
            throw new Error(
              `wave97d_empty_page_compile_refused:${emptyCompilation.fallbackReason}`,
            );
          const emptyRows = database
            .prepare(emptyCompilation.evidence.sql)
            .all(
              ...(emptyCompilation.evidence.bindings as SQLInputValue[]),
            ) as Record<string, unknown>[];
          expect(emptyRows.filter((row) => row.rowKind === "report")).toEqual(
            [],
          );
          const beforeEmptyDashboardReads = trace.preparedSql.length;
          const emptyDashboard = await queryPagesDashboard(env, SITE, {
            window: {
              startMs: emptyTime.range.startMs,
              endExclusiveMs: emptyTime.range.endExclusiveMs,
              nowMs: emptyTime.capturedAtMs,
              timeZone: emptyTime.reportingTimeZone,
            },
            filters: emptyLegacyFilters,
            interval: "month",
            page: { limit: 12, cursor: null },
            sort: { key: "views", direction: "desc" },
          });
          expect(emptyDashboard.items).toEqual([]);
          expect(emptyDashboard.pagination).toEqual({
            limit: 12,
            returned: 0,
            hasMore: false,
            nextCursor: null,
          });
          expect(trace.preparedSql.length - beforeEmptyDashboardReads).toBe(1);
          oracleEvidence.push({
            kind: "empty-current-page",
            sqlBytes: emptyCompilation.evidence.sqlBytes,
            bindingCount: emptyCompilation.evidence.bindingCount,
            reportRows: emptyRows.filter((row) => row.rowKind === "report")
              .length,
            legacyItems: emptyDashboard.items.length,
            legacyReadsAfterCountPreparation:
              trace.preparedSql.length - beforeEmptyDashboardReads,
            previousOrDetailReadSkipped: true,
          });
        }
        expect(oracleEvidence).toHaveLength(1);
        completedOracleCases.set(oracleCase.id, oracleEvidence[0]!);
      } finally {
        database.close();
      }
    },
  );
});
