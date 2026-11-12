import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { D1_MAX_BOUND_PARAMETERS, D1_MAX_SQL_UTF8_BYTES } from "@/lib/db";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { createD1SiteProviderRegistry } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import {
  createQueryTime,
  EMPTY_FILTER_DOCUMENT,
  type FilterDocument,
  prepareScopedQuery,
  type QueryInput,
  type QueryTime,
  queryWindowToTime,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import type {
  Interval,
  PerformanceMetricKey,
  QueryWindow,
} from "@/lib/edge/analytics/contract/types";
import { printLogicalPlan } from "@/lib/edge/analytics/engine/logical/printer";
import { PERFORMANCE_BREAKDOWN_DASHBOARD_QUALIFICATION_CONTROL_OUTPUT } from "@/lib/edge/analytics/engine/performance-breakdown-dashboard-qualification-plan";
import {
  buildPerformanceCountriesPlan,
  buildPerformanceDashboardPlan,
  buildPerformanceRoutesPlan,
  PERFORMANCE_COUNTRIES_OUTPUT_IDS,
  PERFORMANCE_DASHBOARD_OUTPUT_IDS,
  PERFORMANCE_REPORT_OUTPUT_FIELDS,
  PERFORMANCE_ROUTES_OUTPUT_IDS,
} from "@/lib/edge/analytics/engine/performance-sample-statistics-report-plan";
import {
  d1AdvancedFilterMiddleware,
  deferredPerformanceSummaryQualificationFromQuery,
  prepareDeferredEventQualificationFallback,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import {
  createD1ReadDiagnostics,
  type D1ReadDiagnostics,
} from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import { queryPerformanceDashboardFromD1 } from "@/lib/edge/analytics/providers/d1/internal/performance";
import { compilePerformanceBreakdownDashboardQualificationProgram } from "@/lib/edge/analytics/providers/d1/internal/performance-breakdown-dashboard-qualification-program";
import { readSitePerformanceBreakdown } from "@/lib/edge/analytics/providers/d1/operations/site-performance";
import type { Env } from "@/lib/edge/types";
import { parseFilterDsl } from "@/lib/filter-contract";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";

const SITE_ID = "wave96u-performance-breakdown";
const BASE = Date.UTC(2026, 9, 5, 0);
const TIME: QueryTime = createQueryTime(
  BASE,
  BASE + 2 * 60 * 60_000,
  "UTC",
  BASE + 2 * 60 * 60_000,
);
const WINDOW: QueryWindow = {
  startMs: TIME.range.startMs,
  endExclusiveMs: TIME.range.endExclusiveMs,
  nowMs: TIME.capturedAtMs,
  timeZone: TIME.reportingTimeZone,
};
const MIXED_OR_FILTER_DSL =
  'page.path eq "/beta" or count(event { event.name eq "qualifier" }) gte 1';
const MIXED_NOT_FILTER_DSL =
  'not (page.path eq "/beta" and count(event { event.name eq "qualifier" }) gte 1)';
const EVIDENCE_DIRECTORY = process.env.INSIGHTFLARE_QUERY_EVIDENCE_DIR?.trim();
const BEFORE_BASELINE = process.env.INSIGHTFLARE_QUERY_BASELINE_PATH?.trim();

type Scope = "session" | "visitor" | "event";
type PerformanceRequest = QueryInput & Record<string, unknown>;
type ModeRequest =
  | {
      readonly mode: "breakdown";
      readonly dimension: "page.path" | "geo.country";
      readonly metric: PerformanceMetricKey;
      readonly limit?: number | null;
    }
  | {
      readonly mode: "dashboard";
      readonly interval: Interval;
      readonly limit?: number | null;
    };

interface PageSeed {
  readonly id: string;
  readonly visitor: string;
  readonly session: string;
  readonly startedAt: number;
  readonly pathname: string;
  readonly country: string;
  readonly ttfb: number | null;
  readonly fcp: number | null;
  readonly lcp: number | null;
  readonly cls: number | null;
  readonly inp: number | null;
  readonly events?: readonly string[];
}

const FIXTURE: readonly PageSeed[] = [
  {
    id: "a1",
    visitor: "va",
    session: "sa",
    startedAt: BASE + 10_000,
    pathname: "/alpha",
    country: "US",
    ttfb: 100,
    fcp: 120,
    lcp: 300,
    cls: 0.1,
    inp: 150,
    events: ["qualifier"],
  },
  {
    id: "a2",
    visitor: "va",
    session: "sa",
    startedAt: BASE + 20_000,
    pathname: "/alpha",
    country: "US",
    ttfb: 120,
    fcp: 140,
    lcp: 320,
    cls: 0.2,
    inp: 170,
  },
  {
    id: "b1",
    visitor: "va",
    session: "sb",
    startedAt: BASE + 65 * 60_000,
    pathname: "/beta",
    country: "CA",
    ttfb: 200,
    fcp: 220,
    lcp: 500,
    cls: 0.5,
    inp: 250,
  },
  {
    id: "c1",
    visitor: "va",
    session: "sc",
    startedAt: BASE + 70 * 60_000,
    pathname: "/gamma",
    country: "GB",
    ttfb: null,
    fcp: null,
    lcp: null,
    cls: null,
    inp: null,
  },
  {
    id: "d1",
    visitor: "vd",
    session: "sd",
    startedAt: BASE + 80 * 60_000,
    pathname: "   ",
    country: "",
    ttfb: 300,
    fcp: 320,
    lcp: 700,
    cls: 0.7,
    inp: 350,
    events: ["qualifier"],
  },
  {
    id: "whole-native-only",
    visitor: "whole-native-only-visitor",
    session: "whole-native-only-session",
    startedAt: BASE + 90 * 60_000,
    pathname: "/beta",
    country: "AU",
    ttfb: 21,
    fcp: 31,
    lcp: 41,
    cls: 0.21,
    inp: 51,
  },
  {
    id: "whole-count-only",
    visitor: "whole-count-only-visitor",
    session: "whole-count-only-session",
    startedAt: BASE + 100 * 60_000,
    pathname: "/delta",
    country: "NZ",
    ttfb: 921,
    fcp: 931,
    lcp: 941,
    cls: 0.92,
    inp: 951,
    events: ["qualifier"],
  },
  {
    id: "outside",
    visitor: "va",
    session: "sx",
    startedAt: TIME.range.endExclusiveMs,
    pathname: "/outside",
    country: "JP",
    ttfb: 999,
    fcp: 1019,
    lcp: 999,
    cls: 0.9,
    inp: 1049,
    events: ["qualifier"],
  },
];

let database: DatabaseSync;
let sitePk: number;

function trace(): SqliteD1Trace {
  return { preparedSql: [], bindings: [] };
}

function envFor(queryTrace: SqliteD1Trace): Env {
  return { DB: createSqliteD1Database(database, queryTrace) } as unknown as Env;
}

function seedPage(page: PageSeed): void {
  database
    .prepare(
      `INSERT INTO visits (
        visit_id, site_id, site_pk, visitor_id, session_id, status,
        started_at, last_activity_at, pathname, hostname, country, latitude,
        perf_ttfb_ms, perf_fcp_ms, perf_lcp_ms, perf_cls, perf_inp_ms
      ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, 'wave96u.test', ?, 37, ?, ?, ?, ?, ?)`,
    )
    .run(
      page.id,
      SITE_ID,
      sitePk,
      page.visitor,
      page.session,
      page.startedAt,
      page.startedAt + 5,
      page.pathname,
      page.country,
      page.ttfb,
      page.fcp,
      page.lcp,
      page.cls,
      page.inp,
    );
  for (const name of page.events ?? []) {
    database
      .prepare(
        "INSERT OR IGNORE INTO custom_event_names (site_id, name, last_seen_at, site_pk) VALUES (?, ?, ?, ?)",
      )
      .run(SITE_ID, name, page.startedAt, sitePk);
    const eventName = database
      .prepare(
        "SELECT id FROM custom_event_names WHERE site_pk = ? AND name = ?",
      )
      .get(sitePk, name) as { readonly id: number };
    database
      .prepare(
        `INSERT INTO custom_events (
          event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
          received_at, sequence, node_count, value_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 0)`,
      )
      .run(
        `event-${page.id}-${name}`,
        SITE_ID,
        sitePk,
        page.id,
        eventName.id,
        page.startedAt,
        page.startedAt,
      );
  }
}

function qualifiedFilters(): FilterDocument {
  return parseFilterDsl(
    'count(event { event.name eq "qualifier" }) gte 1',
    analyticsFilterRegistry,
  );
}

function filtersWithoutMatches(): FilterDocument {
  return parseFilterDsl(
    'count(event { event.name eq "missing" }) gte 1',
    analyticsFilterRegistry,
  );
}

function numericCountFilters(): FilterDocument {
  return parseFilterDsl(
    'page.path eq "/alpha" and count(page { page.durationMs gt 5 }) eq 1',
    analyticsFilterRegistry,
  );
}

function eventCountFilters(eventName: string): FilterDocument {
  return parseFilterDsl(
    `count(event { event.name eq ${JSON.stringify(eventName)} }) gte 1`,
    analyticsFilterRegistry,
  );
}

function performanceQuery(
  scope: Scope,
  mode: ModeRequest,
  filters = qualifiedFilters(),
): PerformanceRequest {
  const prepared = prepareScopedQuery("performance", {
    context: siteQueryContext(SITE_ID, "private-dashboard"),
    time: TIME,
    filters,
    scopePreference: scope,
  } as QueryInput & { readonly time: QueryTime });
  return { ...prepared, time: TIME, ...mode } as PerformanceRequest;
}

async function prepareQualifiedQuery(
  scope: Scope,
  mode: ModeRequest,
  filters = qualifiedFilters(),
) {
  const queryTrace = trace();
  const middleware = d1AdvancedFilterMiddleware(
    envFor(queryTrace),
    undefined,
    SITE_ID,
  );
  const query = (await middleware(
    "performance",
    performanceQuery(scope, mode, filters),
    async (value) => value,
  )) as PerformanceRequest;
  const deferred = deferredPerformanceSummaryQualificationFromQuery(query);
  if (!deferred) throw new Error("wave96u_performance_qualification_missing");
  return { query, deferred, queryTrace };
}

async function executePerformance(
  query: PerformanceRequest,
  queryTrace: SqliteD1Trace,
  options: {
    readonly env?: Env;
    readonly diagnostics?: D1ReadDiagnostics;
  } = {},
) {
  const provider = createD1SiteProviderRegistry({
    env: options.env ?? envFor(queryTrace),
    siteId: SITE_ID,
    ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
  }).resolve("performance");
  if (!provider) throw new Error("wave96u_performance_provider_missing");
  return provider.execute(query as never);
}

async function legacyPerformance(
  deferred: Awaited<ReturnType<typeof prepareQualifiedQuery>>["deferred"],
  mode: ModeRequest,
  queryTrace = trace(),
) {
  const filters = await prepareDeferredEventQualificationFallback(
    deferred.qualification,
  );
  if (mode.mode === "breakdown") {
    const value = await readSitePerformanceBreakdown({
      env: envFor(queryTrace),
      siteId: SITE_ID,
      window: WINDOW,
      filters,
      dimension: mode.dimension,
      metric: mode.metric,
      limit: mode.limit ?? 20,
    });
    return { filters, value, queryTrace };
  }
  const value = await queryPerformanceDashboardFromD1(
    envFor(queryTrace),
    SITE_ID,
    WINDOW,
    mode.interval,
    filters,
    mode.limit ?? 18,
  );
  return { filters, value, queryTrace };
}

function writeEvidence(name: string, value: unknown): void {
  if (!EVIDENCE_DIRECTORY) return;
  mkdirSync(EVIDENCE_DIRECTORY, { recursive: true });
  writeFileSync(
    join(EVIDENCE_DIRECTORY, name),
    JSON.stringify(value, null, 2) + "\n",
  );
}

function performanceStatementEvidence(queryTrace: SqliteD1Trace) {
  return queryTrace.preparedSql.map((sql, index) => {
    const readsFact = /\b(?:visits|custom_events)\b/iu.test(sql);
    const readsMetadata = /\b(?:sites|site_identities)\b/iu.test(sql);
    return {
      sql,
      bindings: queryTrace.bindings[index] ?? [],
      utf8Bytes: new TextEncoder().encode(sql).byteLength,
      slotCount: queryTrace.bindings[index]?.length ?? 0,
      envelope: sql.includes('AS "outputId"'),
      queryKind: readsFact ? "fact" : readsMetadata ? "metadata" : "other",
    } as const;
  });
}

function writeEvidenceWithNonFiniteNumbers(name: string, value: unknown): void {
  if (!EVIDENCE_DIRECTORY) return;
  mkdirSync(EVIDENCE_DIRECTORY, { recursive: true });
  writeFileSync(
    join(EVIDENCE_DIRECTORY, name),
    JSON.stringify(
      value,
      (_key, nested: unknown) => {
        if (typeof nested !== "number" || Number.isFinite(nested))
          return nested;
        if (Number.isNaN(nested)) return "NaN";
        return nested > 0 ? "Infinity" : "-Infinity";
      },
      2,
    ) + "\n",
  );
}

function deleteSeededPages(pageIds: readonly string[]): void {
  const placeholders = pageIds.map(() => "?").join(", ");
  database
    .prepare(`DELETE FROM custom_events WHERE visit_id IN (${placeholders})`)
    .run(...pageIds);
  database
    .prepare(`DELETE FROM visits WHERE visit_id IN (${placeholders})`)
    .run(...pageIds);
}

const BINARY_ORDER_PATHS = [
  "/-dash",
  "/Z",
  "/_underscore",
  "/a",
  `/${String.fromCodePoint(0xe000)}`,
  `/${String.fromCodePoint(0x10000)}`,
] as const;

function seedBinaryOrderPages(): readonly string[] {
  const ids: string[] = [];
  BINARY_ORDER_PATHS.forEach((pathname, pathIndex) => {
    for (let copy = 0; copy < 2; copy += 1) {
      const id = `binary-order-${pathIndex}-${copy}`;
      ids.push(id);
      seedPage({
        id,
        visitor: "binary-order-visitor",
        session: "binary-order-session",
        startedAt: BASE + 30_000 + pathIndex * 1_000 + copy * 100,
        pathname,
        country: "US",
        ttfb: 100,
        fcp: 120,
        lcp: 1_000 + pathIndex,
        cls: 0.1,
        inp: 150,
        ...(pathIndex === 0 && copy === 0 ? { events: ["binary-order"] } : {}),
      });
    }
  });
  return ids;
}

function qualifiedPages(scope: Scope): readonly PageSeed[] {
  if (scope === "event")
    return FIXTURE.filter((page) => page.events?.includes("qualifier"));
  const qualifyingIdentity = new Set(
    FIXTURE.filter((page) => page.events?.includes("qualifier")).map((page) =>
      scope === "session" ? page.session : page.visitor,
    ),
  );
  return FIXTURE.filter((page) => {
    const identity = scope === "session" ? page.session : page.visitor;
    return (
      page.startedAt >= TIME.range.startMs &&
      page.startedAt < TIME.range.endExclusiveMs &&
      qualifyingIdentity.has(identity)
    );
  });
}

function routeKeys(value: unknown): string[] {
  const result = value as {
    readonly items?: readonly { readonly key: string }[];
    readonly routes?: readonly { readonly pathname: string }[];
  };
  if (result.items) return result.items.map(({ key }) => key);
  return result.routes?.map(({ pathname }) => pathname) ?? [];
}

function statistic(values: readonly number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0)
    return { avg: null, p50: null, p75: null, p95: null, samples: 0 };
  const percentile = (fraction: number) =>
    sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null;
  return {
    avg:
      Math.round(
        (sorted.reduce((sum, value) => sum + value, 0) / sorted.length) * 1000,
      ) / 1000,
    p50: percentile(0.5),
    p75: percentile(0.75),
    p95: percentile(0.95),
    samples: sorted.length,
  };
}

function expectedBreakdown(
  scope: Scope,
  mode: Extract<ModeRequest, { readonly mode: "breakdown" }>,
) {
  const groups = new Map<string, PageSeed[]>();
  for (const page of qualifiedPages(scope)) {
    const key =
      mode.dimension === "page.path"
        ? page.pathname.replace(/^ +| +$/gu, "") || "/"
        : page.country.trim().toUpperCase();
    if (mode.dimension === "geo.country" && !key) continue;
    const current = groups.get(key) ?? [];
    current.push(page);
    groups.set(key, current);
  }
  let entries = [...groups.entries()].flatMap(([key, pages]) => {
    const values = pages.flatMap((page) => {
      const value = page[mode.metric];
      return value === null ? [] : [value];
    });
    return values.length > 0 ? [{ key, pages, values }] : [];
  });
  entries.sort(
    (left, right) =>
      right.pages.length - left.pages.length ||
      left.key.localeCompare(right.key),
  );
  if (mode.dimension === "page.path")
    entries = entries.slice(0, mode.limit ?? 20);
  return {
    dimension: mode.dimension,
    metric: mode.metric,
    items: entries.map(({ key, pages, values }) => ({
      key,
      label: key,
      views: pages.length,
      ...statistic(values),
    })),
  };
}

function compileEvidence(
  prepared: Awaited<ReturnType<typeof prepareQualifiedQuery>>,
) {
  const result = compilePerformanceBreakdownDashboardQualificationProgram({
    query: prepared.query,
    deferred: prepared.deferred,
  });
  expect(result.kind).toBe("compiled");
  if (result.kind !== "compiled")
    throw new Error("wave96u_performance_candidate_unavailable");
  return result.evidence;
}

function createBadReportOutputEnv(queryTrace: SqliteD1Trace): Env {
  const base = createSqliteD1Database(database, queryTrace);
  let preparedCount = 0;
  const DB = {
    prepare(sql: string) {
      preparedCount += 1;
      const statement = base.prepare(sql);
      if (preparedCount !== 2) return statement;
      const replacement = Object.create(statement) as D1PreparedStatement;
      Object.defineProperty(replacement, "bind", {
        value: (...values: SQLInputValue[]) => {
          statement.bind(...values);
          return replacement;
        },
      });
      Object.defineProperty(replacement, "all", {
        value: async () => {
          const result = await statement.all<Record<string, unknown>>();
          return {
            ...result,
            results: (result.results ?? []).map((row) =>
              row.rowKind === "report"
                ? { ...row, outputId: "unexpected-performance-output" }
                : row,
            ),
          };
        },
      });
      return replacement;
    },
    batch: (statements: D1PreparedStatement[]) => base.batch(statements),
  };
  return { DB } as unknown as Env;
}

describe(
  "Performance breakdown and dashboard qualified regression",
  { timeout: 60_000 },
  () => {
    beforeAll(() => {
      database = createMigratedDatabase();
      database.exec("PRAGMA foreign_keys = OFF");
      database
        .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
        .run(SITE_ID);
      database
        .prepare(
          "INSERT INTO sites (id, team_id, name, domain, created_at) VALUES (?, ?, ?, ?, 0)",
        )
        .run(SITE_ID, "wave96u-team", "Performance breakdown", "wave96u.test");
      sitePk = Number(
        (
          database
            .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
            .get(SITE_ID) as { readonly site_pk: number }
        ).site_pk,
      );
      FIXTURE.forEach(seedPage);
    });

    afterAll(() => database.close());

    it("matches SQLite BINARY ordering for tied routes in breakdown and dashboard", async () => {
      const pageIds = seedBinaryOrderPages();
      try {
        const directOrderSql = `SELECT pathname, COUNT(*) AS views
FROM visits
WHERE site_id = ? AND session_id = ?
GROUP BY pathname
ORDER BY views DESC, pathname COLLATE BINARY ASC`;
        const directOrderRows = database
          .prepare(directOrderSql)
          .all(SITE_ID, "binary-order-session") as {
          readonly pathname: string;
          readonly views: number;
        }[];
        const sqliteBinaryOrder = directOrderRows.map(
          ({ pathname }) => pathname,
        );
        const modes: readonly ModeRequest[] = [
          {
            mode: "breakdown",
            dimension: "page.path",
            metric: "lcp",
            limit: 20,
          },
          { mode: "dashboard", interval: "hour" },
        ];
        const runs: {
          readonly mode: ModeRequest;
          readonly actualValue: unknown;
          readonly legacyValue: unknown;
          readonly actualKeys: readonly string[];
          readonly legacyKeys: readonly string[];
          readonly actualSql: readonly string[];
          readonly legacySql: readonly string[];
        }[] = [];
        for (const mode of modes) {
          const prepared = await prepareQualifiedQuery(
            "session",
            mode,
            eventCountFilters("binary-order"),
          );
          const actualTrace = trace();
          const actual = await executePerformance(prepared.query, actualTrace);
          const legacyTrace = trace();
          const legacy = await legacyPerformance(
            prepared.deferred,
            mode,
            legacyTrace,
          );
          runs.push({
            mode,
            actualValue: actual.value,
            legacyValue: legacy.value,
            actualKeys: routeKeys(actual.value),
            legacyKeys: routeKeys(legacy.value),
            actualSql: actualTrace.preparedSql,
            legacySql: legacyTrace.preparedSql,
          });
        }
        writeEvidence("sqlite-binary-order.json", {
          fixture: {
            sessionId: "binary-order-session",
            pathKeys: BINARY_ORDER_PATHS,
            pagesPerPath: 2,
          },
          directOrderOracle: {
            sql: directOrderSql,
            bindings: [SITE_ID, "binary-order-session"],
            rows: directOrderRows,
            pathnameOrder: sqliteBinaryOrder,
          },
          qualifiedAndLegacy: runs,
        });

        expect(sqliteBinaryOrder).toEqual(BINARY_ORDER_PATHS);
        expect(runs.map(({ legacyKeys }) => legacyKeys)).toEqual([
          sqliteBinaryOrder,
          sqliteBinaryOrder,
        ]);
        for (const run of runs)
          expect(run.actualValue).toEqual(run.legacyValue);
      } finally {
        deleteSeededPages(pageIds);
      }
    });

    it("preserves legacy handling of a finite SQLite AVG overflow", async () => {
      const pathname = "/avg-overflow";
      const pageIds = ["average-overflow-a", "average-overflow-b"];
      try {
        seedPage({
          id: pageIds[0]!,
          visitor: "average-overflow-visitor",
          session: "average-overflow-session",
          startedAt: BASE + 40_000,
          pathname,
          country: "US",
          ttfb: 100,
          fcp: 120,
          lcp: 1.7e308,
          cls: 0.1,
          inp: 150,
          events: ["average-overflow"],
        });
        seedPage({
          id: pageIds[1]!,
          visitor: "average-overflow-visitor",
          session: "average-overflow-session",
          startedAt: BASE + 41_000,
          pathname,
          country: "US",
          ttfb: 100,
          fcp: 120,
          lcp: 1.7e308,
          cls: 0.1,
          inp: 150,
        });
        const mode: ModeRequest = {
          mode: "breakdown",
          dimension: "page.path",
          metric: "lcp",
          limit: 20,
        };
        const prepared = await prepareQualifiedQuery(
          "session",
          mode,
          eventCountFilters("average-overflow"),
        );
        const evidence = compileEvidence(prepared);
        const rawRows = database
          .prepare(evidence.sql)
          .all(...(evidence.bindings as SQLInputValue[])) as Record<
          string,
          unknown
        >[];
        const rawLcpRow = rawRows.find(
          (row) =>
            row.rowKind === "report" &&
            row.rowType === "route" &&
            row.pathname === pathname &&
            row.metric === "lcp",
        );
        const storedSamples = database
          .prepare(
            `SELECT typeof(perf_lcp_ms) AS storageClass, perf_lcp_ms AS value
FROM visits WHERE visit_id IN (?, ?) ORDER BY visit_id`,
          )
          .all(...pageIds) as {
          readonly storageClass: string;
          readonly value: number;
        }[];
        const legacyTrace = trace();
        const legacy = await legacyPerformance(
          prepared.deferred,
          mode,
          legacyTrace,
        );
        const actualTrace = trace();
        let actualValue: unknown;
        let actualError: string | null = null;
        try {
          actualValue = (await executePerformance(prepared.query, actualTrace))
            .value;
        } catch (error) {
          actualError = error instanceof Error ? error.message : String(error);
        }
        const rawAverage = rawLcpRow?.lcpAvgValue;
        writeEvidenceWithNonFiniteNumbers("numeric-avg-compatibility.json", {
          fixture: {
            pageIds,
            pathname,
            lcpValues: [1.7e308, 1.7e308],
          },
          storedSamples,
          compiledReport: {
            sql: evidence.sql,
            bindings: evidence.bindings,
            sqlBytes: evidence.sqlBytes,
            rawLcpRow,
            rawAverage,
            actualAverageIsNonFinite:
              typeof rawAverage === "number" && !Number.isFinite(rawAverage),
          },
          legacyReader: {
            sql: legacyTrace.preparedSql,
            bindings: legacyTrace.bindings,
            value: legacy.value,
          },
          qualifiedRegistry: {
            sql: actualTrace.preparedSql,
            bindings: actualTrace.bindings,
            value: actualValue,
            error: actualError,
          },
        });

        expect(storedSamples).toHaveLength(2);
        expect(
          storedSamples.every(({ storageClass }) => storageClass === "real"),
        ).toBe(true);
        expect(storedSamples.every(({ value }) => value === 1.7e308)).toBe(
          true,
        );
        expect(rawLcpRow).toBeDefined();
        expect(typeof rawAverage).toBe("number");
        expect(Number.isFinite(rawAverage)).toBe(false);
        expect(actualError).toBeNull();
        expect(actualValue).toEqual(legacy.value);
      } finally {
        deleteSeededPages(pageIds);
      }
    });

    it("keeps ordinary path, country, and dashboard plans, SQL, binds, and DTOs unchanged", async () => {
      const input = {
        siteId: SITE_ID,
        queryTime: queryWindowToTime(WINDOW),
        filters: EMPTY_FILTER_DOCUMENT,
      };
      const cases = [
        {
          name: "path",
          plan: buildPerformanceRoutesPlan({ ...input, limit: 20 }),
          run: (queryTrace: SqliteD1Trace) =>
            readSitePerformanceBreakdown({
              env: envFor(queryTrace),
              siteId: SITE_ID,
              window: WINDOW,
              filters: EMPTY_FILTER_DOCUMENT,
              dimension: "page.path",
              metric: "lcp",
              limit: 20,
            }),
        },
        {
          name: "country",
          plan: buildPerformanceCountriesPlan(input),
          run: (queryTrace: SqliteD1Trace) =>
            readSitePerformanceBreakdown({
              env: envFor(queryTrace),
              siteId: SITE_ID,
              window: WINDOW,
              filters: EMPTY_FILTER_DOCUMENT,
              dimension: "geo.country",
              metric: "lcp",
              limit: 20,
            }),
        },
        {
          name: "dashboard-default-hour",
          plan: buildPerformanceDashboardPlan({
            ...input,
            interval: "hour",
            routeLimit: 18,
          }),
          run: (queryTrace: SqliteD1Trace) =>
            queryPerformanceDashboardFromD1(
              envFor(queryTrace),
              SITE_ID,
              WINDOW,
              "hour",
              EMPTY_FILTER_DOCUMENT,
              18,
            ),
        },
      ];
      const results = [];
      for (const item of cases) {
        const queryTrace = trace();
        const dto = await item.run(queryTrace);
        expect(queryTrace.preparedSql).toHaveLength(1);
        results.push({
          name: item.name,
          logicalPlan: printLogicalPlan(item.plan),
          sql: queryTrace.preparedSql[0],
          bindings: queryTrace.bindings[0],
          statementCount: queryTrace.preparedSql.length,
          dto,
        });
      }
      const after = {
        fixture: FIXTURE.map(({ id }) => id),
        siteId: SITE_ID,
        window: WINDOW,
        filters: EMPTY_FILTER_DOCUMENT,
        results,
      };
      if (BEFORE_BASELINE) {
        const before = JSON.parse(
          readFileSync(BEFORE_BASELINE, "utf8"),
        ) as typeof after;
        expect(after).toEqual(before);
      }
      writeEvidence("ordinary-after.json", after);
    });

    it.each(["session", "visitor"] as const)(
      "matches the prepared legacy DTO and independent route/country oracle for %s Count scope",
      async (scope) => {
        const modes: readonly ModeRequest[] = [
          {
            mode: "breakdown",
            dimension: "page.path",
            metric: "lcp",
            limit: 2,
          },
          {
            mode: "breakdown",
            dimension: "geo.country",
            metric: "lcp",
            limit: 1,
          },
          { mode: "dashboard", interval: "hour" },
        ];
        for (const mode of modes) {
          const prepared = await prepareQualifiedQuery(scope, mode);
          const evidence = compileEvidence(prepared);
          const actualTrace = trace();
          const actual = await executePerformance(
            performanceQuery(scope, mode),
            actualTrace,
          );
          const legacyTrace = trace();
          const legacy = await legacyPerformance(
            prepared.deferred,
            mode,
            legacyTrace,
          );
          expect(actual.value, `${scope}:${mode.mode}`).toEqual(legacy.value);
          expect(actualTrace.preparedSql).toHaveLength(2);
          expect(actualTrace.preparedSql[1]).toBe(evidence.sql);
          expect(actualTrace.bindings[1]).toEqual(evidence.bindings);
          expect(evidence.sqlBytes).toBe(
            new TextEncoder().encode(evidence.sql).byteLength,
          );
          expect(evidence.sqlBytes).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
          expect(evidence.bindingCount).toBe(evidence.bindings.length);
          expect(evidence.bindingCount).toBeLessThanOrEqual(
            D1_MAX_BOUND_PARAMETERS,
          );
          expect(evidence.controlOutputId).toBe(
            PERFORMANCE_BREAKDOWN_DASHBOARD_QUALIFICATION_CONTROL_OUTPUT,
          );
          const expectedIds =
            mode.mode === "dashboard"
              ? PERFORMANCE_DASHBOARD_OUTPUT_IDS
              : mode.dimension === "page.path"
                ? PERFORMANCE_ROUTES_OUTPUT_IDS
                : PERFORMANCE_COUNTRIES_OUTPUT_IDS;
          expect(
            evidence.outputDescriptors.map(({ outputId }) => outputId),
          ).toEqual(expectedIds);
          expect(evidence.outputDescriptors).toHaveLength(
            mode.mode === "dashboard" ? 20 : 5,
          );
          expect(
            evidence.outputDescriptors.every(
              ({ fields }) =>
                JSON.stringify(fields) ===
                JSON.stringify(PERFORMANCE_REPORT_OUTPUT_FIELDS),
            ),
          ).toBe(true);
          if (mode.mode === "breakdown")
            expect(actual.value).toEqual(expectedBreakdown(scope, mode));
          writeEvidence(
            `qualified-${scope}-${mode.mode}-${mode.mode === "breakdown" ? mode.dimension : mode.interval}.json`,
            {
              request: { scope, ...mode },
              ordinarySql: legacyTrace.preparedSql,
              ordinaryBindings: legacyTrace.bindings,
              qualifiedSql: actualTrace.preparedSql,
              qualifiedBindings: actualTrace.bindings,
              statementCount: actualTrace.preparedSql.length,
              groupWidth: evidence.groupWidth,
              sharedRelationCount: evidence.sharedRelationCount,
              outputDescriptors: evidence.outputDescriptors,
              controlOutputId: evidence.controlOutputId,
              controlFields: evidence.controlFields,
              sql: evidence.sql,
              bindings: evidence.bindings,
              sqlBytes: evidence.sqlBytes,
              bindingCount: evidence.bindingCount,
              output: actual.value,
              legacyOutput: legacy.value,
              oracle:
                mode.mode === "breakdown"
                  ? expectedBreakdown(scope, mode)
                  : undefined,
            },
          );
        }
      },
    );

    it("qualifies the complete mixed OR tree for private performance breakdown", async () => {
      const mode = {
        mode: "breakdown",
        dimension: "page.path",
        metric: "ttfb",
        limit: 20,
      } as const;
      const filters = parseFilterDsl(
        MIXED_OR_FILTER_DSL,
        analyticsFilterRegistry,
      );
      const prepared = await prepareQualifiedQuery("visitor", mode, filters);
      expect(prepared.deferred.qualification.performanceFilterMode).toBe(
        "allow-whole-filter",
      );
      expect(
        prepared.deferred.qualification.requestScopePlan?.preparedMembership,
      ).toBeUndefined();
      expect(
        prepared.deferred.qualification.metadata.plan.preparedMembership,
      ).toBe(undefined);

      const diagnostics = createD1ReadDiagnostics();
      const actualTrace = trace();
      const actual = await executePerformance(
        performanceQuery("visitor", mode, filters),
        actualTrace,
        { diagnostics },
      );
      const legacyTrace = trace();
      const legacy = await legacyPerformance(
        prepared.deferred,
        mode,
        legacyTrace,
      );
      expect(actual.value).toEqual(legacy.value);
      expect(routeKeys(actual.value)).toEqual(
        expect.arrayContaining(["/beta", "/delta"]),
      );
      expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();

      const statements = performanceStatementEvidence(actualTrace);
      const envelopes = statements.filter(({ envelope }) => envelope);
      expect(envelopes).toHaveLength(1);
      expect(envelopes[0]!.utf8Bytes).toBeLessThanOrEqual(
        D1_MAX_SQL_UTF8_BYTES,
      );
      expect(envelopes[0]!.slotCount).toBeLessThanOrEqual(
        D1_MAX_BOUND_PARAMETERS,
      );
      writeEvidence("whole-or-breakdown.json", {
        request: {
          siteId: SITE_ID,
          scope: "visitor",
          ...mode,
          filters: MIXED_OR_FILTER_DSL,
        },
        filterMode: prepared.deferred.qualification.performanceFilterMode,
        advancedMatchesPresent: false,
        nativeOnlyOwner: {
          visitorId: "whole-native-only-visitor",
          path: "/beta",
        },
        countOnlyOwner: {
          visitorId: "whole-count-only-visitor",
          path: "/delta",
        },
        statementCount: statements.length,
        envelopeCount: envelopes.length,
        factQueryCount: statements.filter(
          ({ queryKind }) => queryKind === "fact",
        ).length,
        metadataQueryCount: statements.filter(
          ({ queryKind }) => queryKind === "metadata",
        ).length,
        otherQueryCount: statements.filter(
          ({ queryKind }) => queryKind === "other",
        ).length,
        sql: statements,
        output: actual.value,
        legacyOutput: legacy.value,
        legacySql: legacyTrace.preparedSql,
        legacyBindings: legacyTrace.bindings,
      });
    });

    it("qualifies the complete mixed NOT tree for private performance dashboard", async () => {
      const mode = { mode: "dashboard", interval: "hour", limit: 3 } as const;
      const filters = parseFilterDsl(
        MIXED_NOT_FILTER_DSL,
        analyticsFilterRegistry,
      );
      const prepared = await prepareQualifiedQuery("visitor", mode, filters);
      expect(prepared.deferred.configuration).toMatchObject({
        mode: "dashboard",
        interval: "hour",
        routeLimitPresent: true,
        routeLimitValue: 3,
      });
      expect(prepared.deferred.qualification.performanceFilterMode).toBe(
        "allow-whole-filter",
      );
      expect(
        prepared.deferred.qualification.requestScopePlan?.preparedMembership,
      ).toBeUndefined();
      expect(
        prepared.deferred.qualification.metadata.plan.preparedMembership,
      ).toBe(undefined);

      const diagnostics = createD1ReadDiagnostics();
      const actualTrace = trace();
      const actual = await executePerformance(
        performanceQuery("visitor", mode, filters),
        actualTrace,
        { diagnostics },
      );
      const legacyTrace = trace();
      const legacy = await legacyPerformance(
        prepared.deferred,
        mode,
        legacyTrace,
      );
      expect(actual.value).toEqual(legacy.value);
      expect(routeKeys(actual.value)).toEqual(
        expect.arrayContaining(["/beta", "/delta"]),
      );
      expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();

      const statements = performanceStatementEvidence(actualTrace);
      const envelopes = statements.filter(({ envelope }) => envelope);
      expect(envelopes).toHaveLength(1);
      expect(envelopes[0]!.utf8Bytes).toBeLessThanOrEqual(
        D1_MAX_SQL_UTF8_BYTES,
      );
      expect(envelopes[0]!.slotCount).toBeLessThanOrEqual(
        D1_MAX_BOUND_PARAMETERS,
      );
      writeEvidence("whole-not-dashboard.json", {
        request: {
          siteId: SITE_ID,
          scope: "visitor",
          ...mode,
          filters: MIXED_NOT_FILTER_DSL,
        },
        configuration: prepared.deferred.configuration,
        filterMode: prepared.deferred.qualification.performanceFilterMode,
        advancedMatchesPresent: false,
        nativeOnlyOwner: {
          visitorId: "whole-native-only-visitor",
          path: "/beta",
        },
        countOnlyOwner: {
          visitorId: "whole-count-only-visitor",
          path: "/delta",
        },
        statementCount: statements.length,
        envelopeCount: envelopes.length,
        factQueryCount: statements.filter(
          ({ queryKind }) => queryKind === "fact",
        ).length,
        metadataQueryCount: statements.filter(
          ({ queryKind }) => queryKind === "metadata",
        ).length,
        otherQueryCount: statements.filter(
          ({ queryKind }) => queryKind === "other",
        ).length,
        sql: statements,
        output: actual.value,
        legacyOutput: legacy.value,
        legacySql: legacyTrace.preparedSql,
        legacyBindings: legacyTrace.bindings,
      });
    });

    it("retains country-limit ignored behavior, empty controls, and exact ordering under reverse_unordered_selects", async () => {
      const countryLimited = {
        mode: "breakdown",
        dimension: "geo.country",
        metric: "lcp",
        limit: 1,
      } as const;
      const countryWide = { ...countryLimited, limit: 20 };
      const limitedTrace = trace();
      const wideTrace = trace();
      const limited = await executePerformance(
        performanceQuery("visitor", countryLimited),
        limitedTrace,
      );
      const wide = await executePerformance(
        performanceQuery("visitor", countryWide),
        wideTrace,
      );
      expect(limited.value).toEqual(wide.value);
      // The qualifier on a1 admits visitor va, so a2 and b1 are in the visitor
      // sample bag too. c1 has no LCP, d1 has no country, and only the added
      // whole-count-only Page contributes the third non-empty country group.
      const expectedLcpSamples = [
        {
          pageId: "a1",
          owner: "va",
          startedAtMs: BASE + 10_000,
          country: "US",
          lcp: 300,
        },
        {
          pageId: "a2",
          owner: "va",
          startedAtMs: BASE + 20_000,
          country: "US",
          lcp: 320,
        },
        {
          pageId: "b1",
          owner: "va",
          startedAtMs: BASE + 65 * 60_000,
          country: "CA",
          lcp: 500,
        },
        {
          pageId: "whole-count-only",
          owner: "whole-count-only-visitor",
          startedAtMs: BASE + 100 * 60_000,
          country: "NZ",
          lcp: 941,
        },
      ] as const;
      expect(
        expectedLcpSamples.every(
          ({ startedAtMs }) =>
            startedAtMs >= TIME.range.startMs &&
            startedAtMs < TIME.range.endExclusiveMs,
        ),
      ).toBe(true);
      expect(
        expectedLcpSamples.map(({ country, lcp }) => ({ country, lcp })),
      ).toEqual([
        { country: "US", lcp: 300 },
        { country: "US", lcp: 320 },
        { country: "CA", lcp: 500 },
        { country: "NZ", lcp: 941 },
      ]);
      const expectedCountryGroups = new Set(
        expectedLcpSamples.map(({ country }) => country),
      );
      expect(
        (limited.value as { readonly items: readonly unknown[] }).items,
      ).toHaveLength(expectedCountryGroups.size);

      const missingTrace = trace();
      const missing = await executePerformance(
        performanceQuery(
          "session",
          { mode: "dashboard", interval: "hour" },
          filtersWithoutMatches(),
        ),
        missingTrace,
      );
      const missingValue = missing.value as {
        readonly summaries: Record<
          PerformanceMetricKey,
          { readonly samples: number }
        >;
        readonly trends: Record<PerformanceMetricKey, readonly unknown[]>;
        readonly routes: readonly unknown[];
        readonly countries: readonly unknown[];
      };
      expect(missingTrace.preparedSql).toHaveLength(2);
      expect(missingValue.routes).toEqual([]);
      expect(missingValue.countries).toEqual([]);
      expect(
        Object.values(missingValue.trends).every(
          (points) => points.length === 0,
        ),
      ).toBe(true);
      expect(
        Object.values(missingValue.summaries).every(
          (summary) => summary.samples === 0,
        ),
      ).toBe(true);

      database.exec("PRAGMA reverse_unordered_selects = ON");
      try {
        const reverseTrace = trace();
        const reverse = await executePerformance(
          performanceQuery("visitor", { mode: "dashboard", interval: "hour" }),
          reverseTrace,
        );
        const prepared = await prepareQualifiedQuery("visitor", {
          mode: "dashboard",
          interval: "hour",
        });
        const legacy = await legacyPerformance(
          prepared.deferred,
          { mode: "dashboard", interval: "hour" },
          trace(),
        );
        expect(reverse.value).toEqual(legacy.value);
        expect(reverseTrace.preparedSql).toHaveLength(2);
        writeEvidence("reverse-unordered-selects.json", {
          enabled: true,
          sql: reverseTrace.preparedSql,
          bindings: reverseTrace.bindings,
          output: reverse.value,
          legacyOutput: legacy.value,
        });
      } finally {
        database.exec("PRAGMA reverse_unordered_selects = OFF");
      }
    });

    it.each([
      ...(["ttfb", "fcp", "lcp", "cls", "inp"] as const).flatMap((metric) => [
        {
          mode: "breakdown" as const,
          dimension: "page.path" as const,
          metric,
          limit: 2,
        },
        {
          mode: "breakdown" as const,
          dimension: "geo.country" as const,
          metric,
          limit: 2,
        },
      ]),
      { mode: "dashboard" as const, interval: "hour" as const },
    ])(
      "matches complete Event-candidate Performance mode %j against Core",
      async (mode) => {
        const prepared = await prepareQualifiedQuery("event", mode);
        const evidence = compileEvidence(prepared);
        const actualTrace = trace();
        const actual = await executePerformance(
          performanceQuery("event", mode),
          actualTrace,
        );
        const legacyTrace = trace();
        const legacy = await legacyPerformance(
          prepared.deferred,
          mode,
          legacyTrace,
        );

        expect(
          actual.value,
          `${mode.mode}:${"metric" in mode ? mode.metric : mode.interval}`,
        ).toEqual(legacy.value);
        expect(actualTrace.preparedSql).toHaveLength(2);
        expect(actualTrace.preparedSql[1]).toBe(evidence.sql);
        expect(actualTrace.bindings[1]).toEqual(evidence.bindings);
        expect(evidence.outputDescriptors).toHaveLength(
          mode.mode === "dashboard" ? 20 : 5,
        );
        expect(
          evidence.outputDescriptors.every(
            ({ fields }) =>
              JSON.stringify(fields) ===
              JSON.stringify(PERFORMANCE_REPORT_OUTPUT_FIELDS),
          ),
        ).toBe(true);
        writeEvidence(
          `qualified-event-${mode.mode}-${"metric" in mode ? mode.dimension + "-" + mode.metric : mode.interval}.json`,
          {
            mode,
            output: actual.value,
            coreOutput: legacy.value,
            outputDescriptors: evidence.outputDescriptors,
            sql: actualTrace.preparedSql,
            bindings: actualTrace.bindings,
          },
        );
      },
    );

    it.each(["session", "event"] as const)(
      "falls back completely for numeric %s Count and rejects malformed dashboard output",
      async (scope) => {
        database
          .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
          .run("invalid-duration", "a1");
        try {
          const prepared = await prepareQualifiedQuery(
            scope,
            {
              mode: "dashboard",
              interval: "hour",
            },
            numericCountFilters(),
          );
          const compilation = compileEvidence(prepared);
          const diagnostics = createD1ReadDiagnostics();
          const fallbackTrace = trace();
          const fallback = await executePerformance(
            performanceQuery(
              scope,
              { mode: "dashboard", interval: "hour" },
              numericCountFilters(),
            ),
            fallbackTrace,
            { env: envFor(fallbackTrace), diagnostics },
          );
          const legacy = await legacyPerformance(
            prepared.deferred,
            { mode: "dashboard", interval: "hour" },
            trace(),
          );
          expect(fallback.value).toEqual(legacy.value);
          expect(fallbackTrace.preparedSql).toContain(compilation.sql);
          const guardRows = database
            .prepare(compilation.sql)
            .all(...(compilation.bindings as SQLInputValue[])) as Record<
            string,
            unknown
          >[];
          expect(
            guardRows.filter((row) => row.rowKind === "control"),
          ).toHaveLength(1);
          expect(
            guardRows.filter((row) => row.rowKind === "report"),
          ).toHaveLength(0);
          expect(compilation.outputDescriptors).toHaveLength(20);
          const compatibilitySql = fallbackTrace.preparedSql.at(-1);
          expect(compatibilitySql).toContain("visit_id");
          expect(compatibilitySql).not.toContain("entity_id");
          expect(compatibilitySql).not.toBe(compilation.sql);
          expect(diagnostics.advancedCountSqlFallbackReason).toMatchObject({
            kind: "numeric-data-domain",
            fieldIds: ["page.durationMs"],
          });
          writeEvidence(`numeric-domain-fallback-${scope}.json`, {
            fallbackReason: diagnostics.advancedCountSqlFallbackReason,
            statementCount: fallbackTrace.preparedSql.length,
            sql: fallbackTrace.preparedSql,
            bindings: fallbackTrace.bindings,
            nativeGuardSql: compilation.sql,
            nativeGuardRows: guardRows,
            finalCompatibilitySql: compatibilitySql,
            output: fallback.value,
            legacyOutput: legacy.value,
          });

          if (scope === "session") {
            const badTrace = trace();
            const badEnv = createBadReportOutputEnv(badTrace);
            const badProvider = createD1SiteProviderRegistry({
              env: badEnv,
              siteId: SITE_ID,
            }).resolve("performance");
            if (!badProvider)
              throw new Error("wave96u_performance_provider_missing");
            await expect(
              badProvider.execute(
                performanceQuery("session", {
                  mode: "dashboard",
                  interval: "hour",
                }) as never,
              ),
            ).rejects.toThrow(
              "performance_breakdown_dashboard_qualification_report_row_invalid",
            );
            expect(badTrace.preparedSql).toHaveLength(2);
          }
        } finally {
          database
            .prepare("UPDATE visits SET duration_ms = NULL WHERE visit_id = ?")
            .run("a1");
        }
      },
    );

    it("binds every public request field to its trusted performance qualification", async () => {
      const pathMode = {
        mode: "breakdown",
        dimension: "page.path",
        metric: "lcp",
        limit: 2,
      } as const;
      const pathPrepared = await prepareQualifiedQuery("session", pathMode);
      expect(compileEvidence(pathPrepared).outputDescriptors).toHaveLength(5);
      const pathClone = { ...pathPrepared.query } as PerformanceRequest;
      expect(() =>
        compilePerformanceBreakdownDashboardQualificationProgram({
          query: pathClone,
          deferred: pathPrepared.deferred,
        }),
      ).toThrow(
        "performance_breakdown_dashboard_qualification_request_changed",
      );
      pathPrepared.query.limit = 1;
      expect(() =>
        deferredPerformanceSummaryQualificationFromQuery(pathPrepared.query),
      ).toThrow("performance_summary_qualification_request_changed");
      pathPrepared.query.dimension = "geo.country";
      expect(() =>
        deferredPerformanceSummaryQualificationFromQuery(pathPrepared.query),
      ).toThrow("performance_summary_qualification_request_changed");
      pathPrepared.query.dimension = "page.path";
      pathPrepared.query.metric = "ttfb";
      expect(() =>
        deferredPerformanceSummaryQualificationFromQuery(pathPrepared.query),
      ).toThrow("performance_summary_qualification_request_changed");
      pathPrepared.query.metric = "lcp";
      pathPrepared.query.limit = 2;
      expect(() =>
        deferredPerformanceSummaryQualificationFromQuery(pathPrepared.query),
      ).not.toThrow();

      const dashboard = await prepareQualifiedQuery("session", {
        mode: "dashboard",
        interval: "hour",
      });
      expect(compileEvidence(dashboard).outputDescriptors).toHaveLength(20);
      dashboard.query.interval = "day";
      expect(() =>
        deferredPerformanceSummaryQualificationFromQuery(dashboard.query),
      ).toThrow("performance_summary_qualification_request_changed");
      dashboard.query.interval = "hour";
      dashboard.query.limit = 18;
      expect(() =>
        deferredPerformanceSummaryQualificationFromQuery(dashboard.query),
      ).toThrow("performance_summary_qualification_request_changed");

      let getterCalls = 0;
      const accessorRequest = performanceQuery("session", pathMode);
      Object.defineProperty(accessorRequest, "metric", {
        enumerable: true,
        configurable: true,
        get() {
          getterCalls += 1;
          return "lcp";
        },
      });
      const accessorTrace = trace();
      const middleware = d1AdvancedFilterMiddleware(
        envFor(accessorTrace),
        undefined,
        SITE_ID,
      );
      const accessorOutput = (await middleware(
        "performance",
        accessorRequest,
        async (value) => value,
      )) as PerformanceRequest;
      expect(getterCalls).toBe(0);
      expect(accessorTrace.preparedSql).toHaveLength(2);
      expect(
        deferredPerformanceSummaryQualificationFromQuery(accessorOutput),
      ).toBeUndefined();
      let toJSONCalls = 0;
      const toJSONRequest = performanceQuery("session", pathMode);
      Object.defineProperty(toJSONRequest, "metric", {
        enumerable: true,
        configurable: true,
        value: { toJSON: () => ((toJSONCalls += 1), "lcp") },
      });
      const toJSONTrace = trace();
      const toJSONMiddleware = d1AdvancedFilterMiddleware(
        envFor(toJSONTrace),
        undefined,
        SITE_ID,
      );
      const toJSONOutput = (await toJSONMiddleware(
        "performance",
        toJSONRequest,
        async (value) => value,
      )) as PerformanceRequest;
      expect(toJSONCalls).toBe(0);
      expect(toJSONTrace.preparedSql).toHaveLength(2);
      expect(
        deferredPerformanceSummaryQualificationFromQuery(toJSONOutput),
      ).toBeUndefined();
    });
  },
);
