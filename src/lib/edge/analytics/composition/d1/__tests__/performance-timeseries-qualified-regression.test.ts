import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  type FilterDocument,
  prepareScopedQuery,
  type QueryInput,
  type QueryTime,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import type {
  Interval,
  QueryWindow,
} from "@/lib/edge/analytics/contract/types";
import {
  PERFORMANCE_ALL_TRENDS_OUTPUT_IDS,
  PERFORMANCE_REPORT_OUTPUT_FIELDS,
} from "@/lib/edge/analytics/engine/performance-sample-statistics-report-plan";
import { PERFORMANCE_TIMESERIES_QUALIFICATION_CONTROL_OUTPUT } from "@/lib/edge/analytics/engine/performance-timeseries-qualification-plan";
import {
  d1AdvancedFilterMiddleware,
  type DeferredPerformanceSummaryQualification,
  deferredPerformanceSummaryQualificationFromQuery,
  prepareDeferredEventQualificationFallback,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { buildTimeBuckets } from "@/lib/edge/analytics/providers/d1/internal/core-time";
import {
  createD1ReadDiagnostics,
  type D1ReadDiagnostics,
} from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import {
  compilePerformanceTimeseriesQualificationProgram,
  executePerformanceTimeseriesQualificationProgram,
} from "@/lib/edge/analytics/providers/d1/internal/performance-timeseries-qualification-program";
import {
  readSitePerformanceTimeseries,
  serializePerformanceTimeseries,
} from "@/lib/edge/analytics/providers/d1/operations/site-performance";
import type { Env } from "@/lib/edge/types";
import { parseFilterDsl } from "@/lib/filter-contract";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";

const SITE_ID = "wave96t-performance-timeseries";
const OTHER_SITE_ID = "wave96t-performance-timeseries-other";
const BASE = Date.UTC(2026, 9, 5, 0);
const TIME: QueryTime = createQueryTime(
  BASE,
  BASE + 2 * 24 * 60 * 60 * 1000,
  "UTC",
  BASE + 2 * 24 * 60 * 60 * 1000,
);
const LA_WEEK_START = Date.UTC(2026, 9, 4, 7);
const LA_TIME: QueryTime = createQueryTime(
  LA_WEEK_START,
  LA_WEEK_START + 14 * 24 * 60 * 60 * 1000,
  "America/Los_Angeles",
  LA_WEEK_START + 14 * 24 * 60 * 60 * 1000,
);
const MIXED_NOT_FILTER_DSL =
  'not (page.path eq "/qualified" and count(event { event.name eq "qualifier" }) gte 1)';
const EVIDENCE_DIRECTORY = process.env.INSIGHTFLARE_QUERY_EVIDENCE_DIR?.trim();
const EVIDENCE_PHASE = process.env.INSIGHTFLARE_QUERY_EVIDENCE_PHASE?.trim();

type Scope = "session" | "visitor" | "event";
type PreparedPerformanceQuery = QueryInput & Record<string, unknown>;

function windowFromTime(time: QueryTime): QueryWindow {
  return {
    startMs: time.range.startMs,
    endExclusiveMs: time.range.endExclusiveMs,
    nowMs: time.capturedAtMs,
    timeZone: time.reportingTimeZone,
  };
}

interface PageSeed {
  readonly id: string;
  readonly siteId?: string;
  readonly sitePk?: number;
  readonly visitor: string;
  readonly session: string;
  readonly startedAt: number;
  readonly pathname: string;
  readonly ttfb: number | null;
  readonly fcp: number | null;
  readonly lcp: number | null;
  readonly cls: number | null;
  readonly inp: number | null;
  readonly durationMs?: number | string | null;
  readonly events?: readonly string[];
}

const FIXTURE: readonly PageSeed[] = [
  {
    id: "range-start",
    visitor: "visitor-start",
    session: "session-start",
    startedAt: BASE,
    pathname: "/qualified",
    ttfb: 60,
    fcp: 70,
    lcp: 80,
    cls: 0.06,
    inp: 90,
    durationMs: 10,
    events: ["qualifier"],
  },
  {
    id: "a1",
    visitor: "visitor-a",
    session: "session-a",
    startedAt: BASE + 10 * 60_000,
    pathname: "/qualified",
    ttfb: 100,
    fcp: 200,
    lcp: 300,
    cls: 0.1,
    inp: 400,
    durationMs: 10,
    events: ["qualifier"],
  },
  {
    id: "a2",
    visitor: "visitor-a",
    session: "session-a",
    startedAt: BASE + 65 * 60_000,
    pathname: "/qualified",
    ttfb: 110,
    fcp: null,
    lcp: 330,
    cls: 0.2,
    inp: null,
    durationMs: 10,
  },
  {
    id: "b1",
    visitor: "visitor-a",
    session: "session-b",
    startedAt: BASE + 125 * 60_000,
    pathname: "/qualified",
    ttfb: null,
    fcp: 220,
    lcp: null,
    cls: 0.3,
    inp: 420,
    durationMs: 10,
  },
  {
    id: "c1",
    visitor: "visitor-b",
    session: "session-c",
    startedAt: Date.UTC(2026, 9, 6, 0, 30),
    pathname: "/qualified",
    ttfb: 300,
    fcp: 400,
    lcp: 500,
    cls: null,
    inp: 600,
    durationMs: 12,
    events: ["qualifier"],
  },
  {
    id: "d1",
    visitor: "visitor-c",
    session: "session-d",
    startedAt: Date.UTC(2026, 9, 6, 23, 59, 50),
    pathname: "/qualified",
    ttfb: 500,
    fcp: null,
    lcp: 700,
    cls: 0.5,
    inp: 800,
    durationMs: 12,
  },
  {
    id: "null1",
    visitor: "visitor-null",
    session: "session-null",
    startedAt: BASE + 90 * 60_000,
    pathname: "/qualified",
    ttfb: null,
    fcp: null,
    lcp: null,
    cls: null,
    inp: null,
    durationMs: 8,
    events: ["qualifier"],
  },
  {
    id: "other-path",
    visitor: "visitor-other",
    session: "session-other",
    startedAt: BASE + 30 * 60_000,
    pathname: "/other",
    ttfb: 999,
    fcp: 999,
    lcp: 999,
    cls: 0.9,
    inp: 999,
    durationMs: 15,
    events: ["qualifier"],
  },
  {
    id: "shared",
    visitor: "visitor-shared",
    session: "session-shared",
    startedAt: BASE + 15 * 60_000,
    pathname: "/shared",
    ttfb: 55,
    fcp: 65,
    lcp: 75,
    cls: 0.05,
    inp: 85,
    durationMs: 5,
  },
  {
    id: "week-before",
    visitor: "visitor-week-before",
    session: "session-week-before",
    startedAt: LA_WEEK_START + 7 * 24 * 60 * 60 * 1000 - 1000,
    pathname: "/qualified",
    ttfb: 210,
    fcp: 310,
    lcp: 410,
    cls: 0.21,
    inp: 510,
    durationMs: 10,
    events: ["qualifier"],
  },
  {
    id: "week-after",
    visitor: "visitor-week-after",
    session: "session-week-after",
    startedAt: LA_WEEK_START + 7 * 24 * 60 * 60 * 1000 + 1000,
    pathname: "/qualified",
    ttfb: 220,
    fcp: 320,
    lcp: 420,
    cls: 0.22,
    inp: 520,
    durationMs: 10,
    events: ["qualifier"],
  },
  {
    id: "range-end",
    visitor: "visitor-end",
    session: "session-end",
    startedAt: BASE + 2 * 24 * 60 * 60 * 1000,
    pathname: "/qualified",
    ttfb: 900,
    fcp: 910,
    lcp: 920,
    cls: 0.91,
    inp: 930,
    durationMs: 10,
    events: ["qualifier"],
  },
  {
    id: "other-site",
    siteId: OTHER_SITE_ID,
    visitor: "visitor-decoy",
    session: "session-decoy",
    startedAt: BASE + 20 * 60_000,
    pathname: "/qualified",
    ttfb: 1,
    fcp: 1,
    lcp: 1,
    cls: 0.01,
    inp: 1,
    durationMs: 10,
    events: ["qualifier"],
  },
];

let database: DatabaseSync;
let sitePk: number;
let otherSitePk: number;

function trace(): SqliteD1Trace {
  return { preparedSql: [], bindings: [] };
}

function envFor(queryTrace: SqliteD1Trace): Env {
  return { DB: createSqliteD1Database(database, queryTrace) } as unknown as Env;
}

function seedPage(page: PageSeed): void {
  const pageSitePk =
    page.sitePk ?? (page.siteId === OTHER_SITE_ID ? otherSitePk : sitePk);
  database
    .prepare(
      `INSERT INTO visits (
        visit_id, site_id, site_pk, visitor_id, session_id, status,
        started_at, last_activity_at, pathname, hostname, country, latitude,
        perf_ttfb_ms, perf_fcp_ms, perf_lcp_ms, perf_cls, perf_inp_ms,
        duration_ms
      ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, 'timeseries.test', 'US', 1, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      page.id,
      page.siteId ?? SITE_ID,
      pageSitePk,
      page.visitor,
      page.session,
      page.startedAt,
      page.startedAt + 5,
      page.pathname,
      page.ttfb,
      page.fcp,
      page.lcp,
      page.cls,
      page.inp,
      page.durationMs ?? null,
    );
  for (const name of page.events ?? []) {
    database
      .prepare(
        `INSERT OR IGNORE INTO custom_event_names (site_id, name, last_seen_at, site_pk)
         VALUES (?, ?, ?, ?)`,
      )
      .run(page.siteId ?? SITE_ID, name, page.startedAt, pageSitePk);
    const eventName = database
      .prepare(
        "SELECT id FROM custom_event_names WHERE site_pk = ? AND name = ?",
      )
      .get(pageSitePk, name) as { readonly id: number };
    database
      .prepare(
        `INSERT INTO custom_events (
          event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
          received_at, sequence, node_count, value_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 0)`,
      )
      .run(
        `event-${page.id}-${name}`,
        page.siteId ?? SITE_ID,
        pageSitePk,
        page.id,
        eventName.id,
        page.startedAt,
        page.startedAt,
      );
  }
}

function filtersFor(dsl: string): FilterDocument {
  return parseFilterDsl(dsl, analyticsFilterRegistry);
}

function qualifiedFilters(): FilterDocument {
  return filtersFor(
    'page.path eq "/qualified" and count(event { event.name eq "qualifier" }) gte 1',
  );
}

function performanceQuery(
  scope: Scope,
  filters: FilterDocument,
  options: { readonly time?: QueryTime; readonly interval?: Interval } = {},
): QueryInput {
  const time = options.time ?? TIME;
  const prepared = prepareScopedQuery("performance", {
    context: siteQueryContext(SITE_ID, "private-dashboard"),
    time,
    filters,
    scopePreference: scope,
  } as QueryInput & { readonly time: QueryTime });
  return {
    ...prepared,
    time,
    mode: "timeseries",
    interval: options.interval ?? "hour",
  } as QueryInput;
}

async function executePerformance(
  query: QueryInput,
  queryTrace: SqliteD1Trace,
  options: {
    readonly env?: Env;
    readonly diagnostics?: D1ReadDiagnostics;
  } = {},
) {
  const registry = createD1SiteProviderRegistry({
    env: options.env ?? envFor(queryTrace),
    siteId: SITE_ID,
    ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
  });
  const provider = registry.resolve("performance");
  if (!provider) throw new Error("performance_timeseries_provider_missing");
  return provider.execute(query as never);
}

function envWithWrongReportMetric(queryTrace: SqliteD1Trace): Env {
  const baseDatabase = createSqliteD1Database(database, queryTrace);
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
          const result = await originalAll<Record<string, unknown>>();
          return {
            ...result,
            results: (result.results ?? []).map((row) =>
              row.rowKind === "report" ? { ...row, metric: "invalid" } : row,
            ),
          };
        },
      });
      return replacement;
    },
    batch: (statements: D1PreparedStatement[]) =>
      baseDatabase.batch(statements),
  };
  return { DB } as unknown as Env;
}

async function prepareQualifiedQuery(
  scope: Scope,
  filters: FilterDocument,
  time: QueryTime = TIME,
  interval: "minute" | "hour" | "day" | "week" | "month" = "hour",
  queryTrace = trace(),
) {
  const middleware = d1AdvancedFilterMiddleware(
    envFor(queryTrace),
    undefined,
    SITE_ID,
  );
  const query = (await middleware(
    "performance",
    performanceQuery(scope, filters, { time, interval }),
    async (value) => value,
  )) as PreparedPerformanceQuery;
  const deferred = deferredPerformanceSummaryQualificationFromQuery(query);
  if (!deferred) throw new Error("performance_timeseries_not_prepared");
  return { query, deferred, queryTrace };
}

async function legacyTimeseries(
  deferred: DeferredPerformanceSummaryQualification,
  interval: "minute" | "hour" | "day" | "week" | "month",
  time: QueryTime,
  queryTrace = trace(),
) {
  const filters = await prepareDeferredEventQualificationFallback(
    deferred.qualification,
  );
  const value = await readSitePerformanceTimeseries({
    env: envFor(queryTrace),
    siteId: SITE_ID,
    window: windowFromTime(time),
    interval,
    filters,
  });
  return { filters, value, queryTrace };
}

function oracleQualifiedPageIds(scope: Scope, time: QueryTime): string[] {
  const qualifiers = new Set(
    FIXTURE.filter((page) => page.events?.includes("qualifier")).map((page) =>
      scope === "visitor" ? page.visitor : page.session,
    ),
  );
  return FIXTURE.filter((page) => {
    const pageSiteId = page.siteId ?? SITE_ID;
    const identity = scope === "visitor" ? page.visitor : page.session;
    return (
      pageSiteId === SITE_ID &&
      page.pathname === "/qualified" &&
      page.startedAt >= time.range.startMs &&
      page.startedAt < time.range.endExclusiveMs &&
      qualifiers.has(identity)
    );
  }).map((page) => page.id);
}

function expectedTimeseries(
  scope: Scope,
  interval: Interval,
  time: QueryTime,
): { readonly interval: Interval; readonly series: Record<string, unknown[]> } {
  const qualifiedIds = new Set(oracleQualifiedPageIds(scope, time));
  const selectedPages = FIXTURE.filter((page) => qualifiedIds.has(page.id));
  return expectedTimeseriesForPages(selectedPages, interval, time);
}

function expectedTimeseriesForPages(
  selectedPages: readonly PageSeed[],
  interval: Interval,
  time: QueryTime,
): { readonly interval: Interval; readonly series: Record<string, unknown[]> } {
  const window = windowFromTime(time);
  const buckets = buildTimeBuckets(window, interval);
  const series: Record<string, unknown[]> = {};
  for (const metric of ["ttfb", "fcp", "lcp", "cls", "inp"] as const) {
    const points: unknown[] = [];
    for (const bucket of buckets) {
      const values = selectedPages
        .filter(
          (page) =>
            page.startedAt >= bucket.startMs &&
            page.startedAt < bucket.endExclusiveMs,
        )
        .flatMap((page) => {
          const value = page[metric];
          return value === null ? [] : [value];
        })
        .sort((left, right) => left - right);
      if (values.length === 0) continue;
      const percentile = (fraction: number) =>
        values[Math.ceil(values.length * fraction) - 1] ?? null;
      const avg =
        Math.round(
          (values.reduce((sum, value) => sum + value, 0) / values.length) *
            1000,
        ) / 1000;
      points.push({
        timestamp: new Date(bucket.timestampMs).toISOString(),
        avg,
        p50: percentile(0.5),
        p75: percentile(0.75),
        p95: percentile(0.95),
        samples: values.length,
      });
    }
    series[metric] = points;
  }
  return { interval, series };
}

function writeEvidence(filename: string, value: unknown): void {
  if (!EVIDENCE_DIRECTORY) return;
  mkdirSync(EVIDENCE_DIRECTORY, { recursive: true });
  writeFileSync(
    join(EVIDENCE_DIRECTORY, filename),
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
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

describe("Performance Timeseries qualified regression", () => {
  beforeAll(() => {
    database = createMigratedDatabase();
    database.exec("PRAGMA foreign_keys = OFF");
    for (const id of [SITE_ID, OTHER_SITE_ID])
      database
        .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
        .run(id);
    database
      .prepare(
        "INSERT INTO sites (id, team_id, name, domain, created_at) VALUES (?, ?, ?, ?, 0)",
      )
      .run(
        SITE_ID,
        "wave96t-team",
        "Performance timeseries",
        "timeseries.test",
      );
    database
      .prepare(
        "INSERT INTO sites (id, team_id, name, domain, created_at) VALUES (?, ?, ?, ?, 0)",
      )
      .run(
        OTHER_SITE_ID,
        "wave96t-team",
        "Performance timeseries other",
        "other-timeseries.test",
      );
    sitePk = Number(
      (
        database
          .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
          .get(SITE_ID) as { readonly site_pk: number }
      ).site_pk,
    );
    otherSitePk = Number(
      (
        database
          .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
          .get(OTHER_SITE_ID) as { readonly site_pk: number }
      ).site_pk,
    );
    FIXTURE.forEach(seedPage);
  });

  afterAll(() => database.close());

  it("qualifies the default hour report within the live D1 SQL budgets", async () => {
    const queryTrace = trace();
    const prepared = await prepareQualifiedQuery(
      "session",
      qualifiedFilters(),
      TIME,
      "hour",
      queryTrace,
    );
    const compilation = compilePerformanceTimeseriesQualificationProgram({
      query: prepared.query,
      deferred: prepared.deferred,
    });
    expect(compilation.kind).toBe("compiled");
    if (compilation.kind !== "compiled")
      throw new Error("performance_timeseries_default_hour_budget_unavailable");
    const evidence = compilation.evidence;
    expect(evidence.sqlBytes).toBe(
      new TextEncoder().encode(evidence.sql).byteLength,
    );
    expect(evidence.sqlBytes).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
    expect(evidence.bindingCount).toBe(evidence.bindings.length);
    expect(evidence.bindingCount).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
    expect(evidence.outputDescriptors).toHaveLength(5);
    expect(
      evidence.outputDescriptors.map(({ outputId, rowType }) => ({
        outputId,
        rowType,
      })),
    ).toEqual(
      PERFORMANCE_ALL_TRENDS_OUTPUT_IDS.map((outputId) => ({
        outputId,
        rowType: "trend",
      })),
    );
    expect(
      evidence.outputDescriptors.every(
        ({ fields }) =>
          JSON.stringify(fields) ===
          JSON.stringify(PERFORMANCE_REPORT_OUTPUT_FIELDS),
      ),
    ).toBe(true);
    expect(evidence.controlOutputId).toBe(
      PERFORMANCE_TIMESERIES_QUALIFICATION_CONTROL_OUTPUT,
    );
    expect(evidence.ordering.slice(-2)).toEqual([
      { field: "metric", direction: "asc", nulls: "first" },
      { field: "bucket", direction: "asc", nulls: "first" },
    ]);

    const executed = await executePerformanceTimeseriesQualificationProgram({
      query: prepared.query,
      deferred: prepared.deferred,
      env: envFor(queryTrace),
    });
    expect(executed.kind).toBe("executed");
    if (executed.kind !== "executed")
      throw new Error(
        "performance_timeseries_default_hour_execution_unavailable",
      );
    const value = serializePerformanceTimeseries("hour", executed.trends);
    const oracle = expectedTimeseries("session", "hour", TIME);
    const executionTrace = {
      preparedSql: [...queryTrace.preparedSql],
      bindings: queryTrace.bindings.map((values) => [...values]),
    };
    const legacy = await legacyTimeseries(
      prepared.deferred,
      "hour",
      TIME,
      trace(),
    );
    expect(value).toEqual(legacy.value);
    expect(value).toEqual(oracle);
    writeEvidence("default-hour-budget-smoke.json", {
      request: { scope: "session", mode: "timeseries", interval: "hour" },
      outputDescriptors: evidence.outputDescriptors,
      controlOutputId: evidence.controlOutputId,
      controlFields: evidence.controlFields,
      sql: evidence.sql,
      bindings: evidence.bindings,
      sqlBytes: evidence.sqlBytes,
      bindingCount: evidence.bindingCount,
      limits: {
        sqlUtf8Bytes: D1_MAX_SQL_UTF8_BYTES,
        boundParameters: D1_MAX_BOUND_PARAMETERS,
      },
      groupWidth: evidence.groupWidth,
      sharedRelationCount: evidence.sharedRelationCount,
      ordering: evidence.ordering,
      output: value,
      oraclePageIds: oracleQualifiedPageIds("session", TIME),
      oracle,
      executionTrace,
    });
  });

  it("qualifies the complete mixed NOT tree for private performance timeseries", async () => {
    const filters = filtersFor(MIXED_NOT_FILTER_DSL);
    const prepared = await prepareQualifiedQuery(
      "visitor",
      filters,
      TIME,
      "hour",
    );
    expect(prepared.deferred.qualification.performanceFilterMode).toBe(
      "allow-whole-filter",
    );
    expect(
      prepared.deferred.qualification.requestScopePlan?.advancedMatches,
    ).toBeUndefined();
    expect(prepared.deferred.qualification.metadata.plan.advancedMatches).toBe(
      undefined,
    );

    const diagnostics = createD1ReadDiagnostics();
    const actualTrace = trace();
    const actual = await executePerformance(
      performanceQuery("visitor", filters, { time: TIME, interval: "hour" }),
      actualTrace,
      { diagnostics },
    );
    const legacyTrace = trace();
    const legacy = await legacyTimeseries(
      prepared.deferred,
      "hour",
      TIME,
      legacyTrace,
    );
    const includedPages = FIXTURE.filter(({ id }) =>
      ["d1", "other-path", "shared"].includes(id),
    );
    const oracle = expectedTimeseriesForPages(includedPages, "hour", TIME);
    expect(actual.value).toEqual(legacy.value);
    expect(actual.value).toEqual(oracle);
    expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
    const ttfbValues = (
      actual.value as {
        readonly series: { readonly ttfb: readonly { readonly avg: number }[] };
      }
    ).series.ttfb.map(({ avg }) => avg);
    expect(ttfbValues).toEqual([527, 500]);

    const statements = performanceStatementEvidence(actualTrace);
    const envelopes = statements.filter(({ envelope }) => envelope);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]!.utf8Bytes).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
    expect(envelopes[0]!.slotCount).toBeLessThanOrEqual(
      D1_MAX_BOUND_PARAMETERS,
    );
    writeEvidence("whole-not-timeseries.json", {
      request: {
        siteId: SITE_ID,
        mode: "timeseries",
        interval: "hour",
        scope: "visitor",
        filters: MIXED_NOT_FILTER_DSL,
      },
      filterMode: prepared.deferred.qualification.performanceFilterMode,
      advancedMatchesPresent: false,
      nativeOnlyOwnerPageIds: ["d1"],
      countOnlyOwnerPageIds: ["other-path"],
      includedPageIds: includedPages.map(({ id }) => id),
      statementCount: statements.length,
      envelopeCount: envelopes.length,
      factQueryCount: statements.filter(({ queryKind }) => queryKind === "fact")
        .length,
      metadataQueryCount: statements.filter(
        ({ queryKind }) => queryKind === "metadata",
      ).length,
      otherQueryCount: statements.filter(
        ({ queryKind }) => queryKind === "other",
      ).length,
      sql: statements,
      output: actual.value,
      legacyOutput: legacy.value,
      oracle,
      legacySql: legacyTrace.preparedSql,
      legacyBindings: legacyTrace.bindings,
    });
  });

  it.each([
    ["session", "hour"],
    ["session", "day"],
    ["visitor", "hour"],
    ["visitor", "day"],
    ["event", "hour"],
    ["event", "day"],
  ] as const)(
    "matches the legacy report and sample oracle for %s scope at %s intervals",
    async (scope, interval) => {
      const prepared = await prepareQualifiedQuery(
        scope,
        qualifiedFilters(),
        TIME,
        interval,
      );
      const legacy = await legacyTimeseries(
        prepared.deferred,
        interval,
        TIME,
        trace(),
      );
      const queryTrace = trace();
      const result = await executePerformance(
        performanceQuery(scope, qualifiedFilters(), { time: TIME, interval }),
        queryTrace,
      );
      expect(result.value).toEqual(legacy.value);
      const oracle = expectedTimeseries(scope, interval, TIME);
      expect(result.value).toEqual(oracle);
      expect(queryTrace.preparedSql).toHaveLength(2);
      writeEvidence(`route-${scope}-${interval}.json`, {
        request: { scope, mode: "timeseries", interval, time: TIME },
        sql: queryTrace.preparedSql,
        bindings: queryTrace.bindings,
        statementCount: queryTrace.preparedSql.length,
        output: result.value,
        legacyOutput: legacy.value,
        oraclePageIds: oracleQualifiedPageIds(scope, TIME),
        oracle,
      });
    },
  );

  it.each(["week", "month"] as const)(
    "preserves Los Angeles calendar %s boundaries",
    async (interval) => {
      const scope = "visitor" as const;
      const filters = qualifiedFilters();
      const prepared = await prepareQualifiedQuery(
        scope,
        filters,
        LA_TIME,
        interval,
      );
      const legacy = await legacyTimeseries(
        prepared.deferred,
        interval,
        LA_TIME,
        trace(),
      );
      const queryTrace = trace();
      const result = await executePerformance(
        performanceQuery(scope, filters, { time: LA_TIME, interval }),
        queryTrace,
      );
      expect(result.value).toEqual(legacy.value);
      const oracle = expectedTimeseries(scope, interval, LA_TIME);
      expect(result.value).toEqual(oracle);
      expect(queryTrace.preparedSql).toHaveLength(2);
      writeEvidence(`calendar-${interval}-los-angeles.json`, {
        interval,
        time: LA_TIME,
        window: windowFromTime(LA_TIME),
        boundaryRows: FIXTURE.filter((page) => page.id.startsWith("week-")),
        output: result.value,
        oraclePageIds: oracleQualifiedPageIds(scope, LA_TIME),
        oracle,
        sql: queryTrace.preparedSql,
        bindings: queryTrace.bindings,
      });
    },
  );

  it("orders qualification output with reverse_unordered_selects enabled", async () => {
    database.exec("PRAGMA reverse_unordered_selects = ON");
    try {
      const queryTrace = trace();
      const result = await executePerformance(
        performanceQuery("visitor", qualifiedFilters(), {
          time: TIME,
          interval: "hour",
        }),
        queryTrace,
      );
      const oracle = expectedTimeseries("visitor", "hour", TIME);
      expect(result.value).toEqual(oracle);
      expect(queryTrace.preparedSql).toHaveLength(2);
      writeEvidence("reverse-unordered-selects.json", {
        enabled: true,
        sql: queryTrace.preparedSql,
        bindings: queryTrace.bindings,
        output: result.value,
        oraclePageIds: oracleQualifiedPageIds("visitor", TIME),
        oracle,
      });
    } finally {
      database.exec("PRAGMA reverse_unordered_selects = OFF");
    }
  });

  it("returns all five empty series when no pages qualify", async () => {
    const filters = filtersFor(
      'page.path eq "/missing" and count(event { event.name eq "qualifier" }) gte 1',
    );
    const queryTrace = trace();
    const result = await executePerformance(
      performanceQuery("session", filters, { time: TIME, interval: "hour" }),
      queryTrace,
    );
    expect(result.value).toEqual({
      interval: "hour",
      series: { ttfb: [], fcp: [], lcp: [], cls: [], inp: [] },
    });
    expect(queryTrace.preparedSql).toHaveLength(2);
    writeEvidence("empty-qualified-timeseries.json", {
      sql: queryTrace.preparedSql,
      bindings: queryTrace.bindings,
      output: result.value,
      oraclePageIds: [],
      oracle: {
        interval: "hour",
        series: { ttfb: [], fcp: [], lcp: [], cls: [], inp: [] },
      },
    });
  });

  it("rejects malformed report protocol rows without a legacy read", async () => {
    const queryTrace = trace();
    await expect(
      executePerformance(
        performanceQuery("session", qualifiedFilters(), {
          time: TIME,
          interval: "hour",
        }),
        queryTrace,
        { env: envWithWrongReportMetric(queryTrace) },
      ),
    ).rejects.toThrow(
      "performance_timeseries_qualification_report_row_invalid",
    );
    expect(queryTrace.preparedSql).toHaveLength(2);
    writeEvidence("protocol-error.json", {
      expectedError: "performance_timeseries_qualification_report_row_invalid",
      sql: queryTrace.preparedSql,
      bindings: queryTrace.bindings,
      legacyReadIssued: false,
    });
  });

  it("uses the legacy route once when numeric qualification data is invalid", async () => {
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "a1");
    try {
      const filters = filtersFor(
        'page.path eq "/qualified" and count(page { page.durationMs gt 5 }) eq 1',
      );
      const queryTrace = trace();
      const diagnostics: D1ReadDiagnostics = {
        rowsRead: 0,
        rowsReadAvailable: true,
      };
      const result = await executePerformance(
        performanceQuery("session", filters, { time: TIME, interval: "hour" }),
        queryTrace,
        { diagnostics },
      );
      const legacyReadTrace = trace();
      const prepared = await prepareQualifiedQuery(
        "session",
        filters,
        TIME,
        "hour",
      );
      const legacy = await legacyTimeseries(
        prepared.deferred,
        "hour",
        TIME,
        legacyReadTrace,
      );
      expect(result.value).toEqual(legacy.value);
      expect(legacyReadTrace.preparedSql).toHaveLength(1);
      expect(
        queryTrace.preparedSql.filter(
          (sql) => sql === legacyReadTrace.preparedSql[0],
        ),
      ).toHaveLength(1);
      expect(diagnostics.advancedCountSqlFallbackReason).toEqual({
        kind: "numeric-data-domain",
        fieldIds: ["page.durationMs"],
      });
      writeEvidence("numeric-data-fallback.json", {
        diagnostics: diagnostics.advancedCountSqlFallbackReason,
        request: { scope: "session", interval: "hour" },
        statementCount: queryTrace.preparedSql.length,
        sql: queryTrace.preparedSql,
        bindings: queryTrace.bindings,
        exactlyOneLegacyAllTrendsRead: true,
        legacyAllTrendsSql: legacyReadTrace.preparedSql[0],
        output: result.value,
        legacyOutput: legacy.value,
      });
    } finally {
      database
        .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
        .run(10, "a1");
    }
  });

  it("rejects cloned, mismatched, and mutated deferred requests before report SQL", async () => {
    const firstTrace = trace();
    const first = await prepareQualifiedQuery(
      "session",
      qualifiedFilters(),
      TIME,
      "hour",
      firstTrace,
    );
    const second = await prepareQualifiedQuery(
      "visitor",
      qualifiedFilters(),
      TIME,
      "hour",
      trace(),
    );
    expect(() =>
      compilePerformanceTimeseriesQualificationProgram({
        query: first.query,
        deferred: { ...first.deferred },
      }),
    ).toThrow("performance_timeseries_qualification_request_invalid");
    expect(() =>
      compilePerformanceTimeseriesQualificationProgram({
        query: first.query,
        deferred: second.deferred,
      }),
    ).toThrow("performance_timeseries_qualification_request_changed");
    expect(() =>
      compilePerformanceTimeseriesQualificationProgram({
        query: first.query,
        deferred: first.deferred,
      }),
    ).not.toThrow();
    first.query.interval = "day";
    await expect(
      executePerformanceTimeseriesQualificationProgram({
        query: first.query,
        deferred: first.deferred,
        env: envFor(firstTrace),
      }),
    ).rejects.toThrow("performance_summary_qualification_request_changed");
    expect(firstTrace.preparedSql).toHaveLength(1);
    writeEvidence("public-query-safety.json", {
      invalidCloneRejected: true,
      mismatchedRequestRejected: true,
      mutatedIntervalRejected: true,
      sqlBeforeRejectedExecution: firstTrace.preparedSql,
      noReportSqlAfterRejection: firstTrace.preparedSql.length === 1,
    });
  });

  it("records the trusted ordinary timeseries route for the unchanged fixture", async () => {
    const queryTrace = trace();
    const query = performanceQuery(
      "session",
      filtersFor('page.path eq "/shared"'),
      {
        time: TIME,
        interval: "hour",
      },
    );
    const result = await executePerformance(query, queryTrace);
    const value = result.value as {
      readonly interval: string;
      readonly series: Record<string, readonly unknown[]>;
    };
    expect(value.interval).toBe("hour");
    expect(queryTrace.preparedSql).toHaveLength(1);
    const phase = EVIDENCE_PHASE === "before" ? "before" : "after";
    writeEvidence(`ordinary-timeseries-${phase}.json`, {
      fixture: FIXTURE.map((page) => ({
        ...page,
        siteId: page.siteId ?? SITE_ID,
      })),
      request: {
        mode: "timeseries",
        scope: "session",
        interval: "hour",
        time: TIME,
        filters: 'page.path eq "/shared"',
      },
      statementCount: queryTrace.preparedSql.length,
      sql: queryTrace.preparedSql,
      bindings: queryTrace.bindings,
      value,
    });
  });
});
