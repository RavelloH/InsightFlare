import { createHash } from "node:crypto";
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
  EMPTY_FILTER_DOCUMENT,
  prepareScopedQuery,
  type QueryInput,
  type QueryTime,
  scopedFilterMetadata,
  siteQueryContext,
  teamQueryContext,
} from "@/lib/edge/analytics/contract";
import { queryWindowToTime } from "@/lib/edge/analytics/contract/helpers";
import { printLogicalPlan } from "@/lib/edge/analytics/engine/logical/printer";
import { buildPerformanceSummariesPlan } from "@/lib/edge/analytics/engine/performance-sample-statistics-report-plan";
import {
  d1AdvancedFilterMiddleware,
  type DeferredPerformanceSummaryQualification,
  deferredPerformanceSummaryQualificationFromQuery,
  matchesPerformanceSummaryQualificationConfiguration,
  prepareDeferredEventQualificationFallback,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import {
  queryD1CompiledAll,
  type QueryWindow,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  createD1ReadDiagnostics,
  type D1ReadDiagnostics,
} from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import {
  mapPerformanceSummaries,
  queryPerformanceSummariesFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/performance";
import {
  compilePerformanceSummaryQualificationProgram,
  executePerformanceSummaryQualificationProgram,
} from "@/lib/edge/analytics/providers/d1/internal/performance-summary-qualification-program";
import type { Env } from "@/lib/edge/types";
import { parseFilterDsl } from "@/lib/filter-contract";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";

const SITE_ID = "wave96s-performance-summary";
const OTHER_SITE_ID = "wave96s-performance-summary-other";
const BASE = Date.UTC(2026, 9, 5, 0);
const TIME: QueryTime = createQueryTime(
  BASE,
  BASE + 2 * 60 * 60 * 1000,
  "UTC",
  BASE + 2 * 60 * 60 * 1000,
);
const WINDOW: QueryWindow = {
  startMs: TIME.range.startMs,
  endExclusiveMs: TIME.range.endExclusiveMs,
  nowMs: TIME.capturedAtMs,
  timeZone: TIME.reportingTimeZone,
};
const QUALIFIED_FILTER_DSL =
  'page.path eq "/two" and count(event { event.name eq "qualifier" }) gte 1';
const MIXED_OR_FILTER_DSL =
  'page.path eq "/native-only" or count(event { event.name eq "qualifier" }) gte 1';
const EVIDENCE_DIRECTORY = process.env.INSIGHTFLARE_QUERY_EVIDENCE_DIR?.trim();
const EVIDENCE_PHASE = process.env.INSIGHTFLARE_QUERY_EVIDENCE_PHASE?.trim();

type Scope = "session" | "visitor" | "event";
type PreparedPerformanceSummaryQuery = QueryInput & Record<string, unknown>;
type PublicPerformanceSummaryProgramInput = {
  readonly query: PreparedPerformanceSummaryQuery;
  readonly deferred: DeferredPerformanceSummaryQualification;
};

function compilePreparedPerformanceSummaryProgram(
  input: PublicPerformanceSummaryProgramInput,
) {
  return compilePerformanceSummaryQualificationProgram(input);
}

function executePreparedPerformanceSummaryProgram(
  input: PublicPerformanceSummaryProgramInput & { readonly env: Env },
) {
  return executePerformanceSummaryQualificationProgram(input);
}

interface PageSeed {
  readonly id: string;
  readonly siteId?: string;
  readonly sitePk?: number;
  readonly visitor: string;
  readonly session: string;
  readonly startedAt: number;
  readonly pathname: string;
  readonly country: string;
  readonly latitude: number | null;
  readonly ttfb: number | null;
  readonly fcp: number | null;
  readonly lcp: number | null;
  readonly cls: number | null;
  readonly inp: number | null;
  readonly events?: readonly { readonly name: string; readonly at: number }[];
}

let database: DatabaseSync;
let sitePk: number;
let otherSitePk: number;

function trace(): SqliteD1Trace {
  return { preparedSql: [], bindings: [] };
}

function envFor(queryTrace: SqliteD1Trace): Env {
  return { DB: createSqliteD1Database(database, queryTrace) } as unknown as Env;
}

type QualificationBehavior =
  | "missing-control"
  | "duplicate-control"
  | "wrong-control-kind"
  | "wrong-report-output"
  | "database-error"
  | "post-abort";

function envWithQualificationBehavior(
  queryTrace: SqliteD1Trace,
  behavior: QualificationBehavior,
  controller?: AbortController,
): Env {
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
          if (behavior === "database-error")
            throw new Error("injected performance qualification read failure");
          const result = await originalAll<Record<string, unknown>>();
          if (behavior === "post-abort") controller?.abort();
          const rows = result.results ?? [];
          const control = rows.find((row) => row.rowKind === "control");
          if (behavior === "missing-control")
            return {
              ...result,
              results: rows.filter((row) => row.rowKind !== "control"),
            };
          if (behavior === "duplicate-control" && control)
            return { ...result, results: [...rows, control] };
          if (behavior === "wrong-control-kind")
            return {
              ...result,
              results: rows.map((row) =>
                row.rowKind === "control"
                  ? { ...row, entityKind: "visitor" }
                  : row,
              ),
            };
          if (behavior === "wrong-report-output")
            return {
              ...result,
              results: rows.map((row) =>
                row.rowKind === "report"
                  ? { ...row, outputId: "unexpected-report" }
                  : row,
              ),
            };
          return result;
        },
      });
      return replacement;
    },
    batch: (statements: D1PreparedStatement[]) =>
      baseDatabase.batch(statements),
  };
  return { DB } as unknown as Env;
}

function seedPage(page: PageSeed): void {
  database
    .prepare(
      `INSERT INTO visits (
        visit_id, site_id, site_pk, visitor_id, session_id, status,
        started_at, last_activity_at, pathname, hostname, country, latitude,
        perf_ttfb_ms, perf_fcp_ms, perf_lcp_ms, perf_cls, perf_inp_ms
      ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, 'perf.test', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      page.id,
      page.siteId ?? SITE_ID,
      page.sitePk ?? sitePk,
      page.visitor,
      page.session,
      page.startedAt,
      page.startedAt + 5,
      page.pathname,
      page.country,
      page.latitude,
      page.ttfb,
      page.fcp,
      page.lcp,
      page.cls,
      page.inp,
    );
  for (const event of page.events ?? []) {
    database
      .prepare(
        `INSERT OR IGNORE INTO custom_event_names (site_id, name, last_seen_at, site_pk)
         VALUES (?, ?, ?, ?)`,
      )
      .run(page.siteId ?? SITE_ID, event.name, event.at, page.sitePk ?? sitePk);
    const eventName = database
      .prepare(
        "SELECT id FROM custom_event_names WHERE site_pk = ? AND name = ?",
      )
      .get(page.sitePk ?? sitePk, event.name) as { readonly id: number };
    database
      .prepare(
        `INSERT INTO custom_events (
          event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
          received_at, sequence, node_count, value_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 0)`,
      )
      .run(
        `event-${page.id}-${event.name}`,
        page.siteId ?? SITE_ID,
        page.sitePk ?? sitePk,
        page.id,
        eventName.id,
        event.at,
        event.at,
      );
  }
}

function performanceQuery(
  scope: Scope,
  filters = EMPTY_FILTER_DOCUMENT,
  options: {
    readonly siteId?: string;
    readonly audience?: "private-dashboard" | "public-share";
    readonly mode?: string;
  } = {},
) {
  const prepared = prepareScopedQuery("performance", {
    context: siteQueryContext(
      options.siteId ?? SITE_ID,
      options.audience ?? "private-dashboard",
    ),
    time: TIME,
    filters,
    scopePreference: scope,
  } as QueryInput & { readonly time: QueryTime });
  return {
    ...prepared,
    time: TIME,
    mode: options.mode ?? "summary",
  } as QueryInput & { readonly time: QueryTime; readonly mode: string };
}

async function executePerformance(
  query: QueryInput,
  queryTrace: SqliteD1Trace,
  options: {
    readonly env?: Env;
    readonly diagnostics?: D1ReadDiagnostics;
    readonly signal?: AbortSignal;
  } = {},
) {
  const registry = createD1SiteProviderRegistry({
    env: options.env ?? envFor(queryTrace),
    siteId: SITE_ID,
    ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
  });
  const provider = registry.resolve("performance");
  if (!provider) throw new Error("performance_summary_provider_missing");
  return provider.execute(
    query as never,
    options.signal ? { signal: options.signal } : undefined,
  );
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

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").toUpperCase();
}

function qualifiedFilters() {
  return parseFilterDsl(QUALIFIED_FILTER_DSL, analyticsFilterRegistry);
}

function expectedSampleSets(scope: Scope) {
  return scope === "session"
    ? {
        ttfb: [-5, 999],
        fcp: [30, 999],
        lcp: [70, 999],
        cls: [9],
        inp: [10, 999],
      }
    : {
        ttfb: [0, 100, -5, 999],
        fcp: [10, 30, 999],
        lcp: [50, 30, 70, 999],
        cls: [0.1, 0.2, 9],
        inp: [0, 10, 999],
      };
}

function expectedQualifiedMetrics(scope: Scope) {
  const percentile = (values: readonly number[], fraction: number) => {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.ceil(sorted.length * fraction) - 1] ?? null;
  };
  const metric = (values: readonly number[]) => ({
    avg:
      Math.round(
        (values.reduce((sum, value) => sum + value, 0) / values.length) * 1000,
      ) / 1000,
    p50: percentile(values, 0.5),
    p75: percentile(values, 0.75),
    p95: percentile(values, 0.95),
    samples: values.length,
  });
  const samples = expectedSampleSets(scope);
  return {
    metrics: {
      ttfb: metric(samples.ttfb),
      fcp: metric(samples.fcp),
      lcp: metric(samples.lcp),
      cls: metric(samples.cls),
      inp: metric(samples.inp),
    },
  };
}

async function prepareBrandedPerformanceSummary(
  scope: Scope,
  queryTrace: SqliteD1Trace,
  filters = qualifiedFilters(),
) {
  const middleware = d1AdvancedFilterMiddleware(
    envFor(queryTrace),
    undefined,
    SITE_ID,
  );
  const query = (await middleware(
    "performance",
    performanceQuery(scope, filters),
    async (value) => value,
  )) as PreparedPerformanceSummaryQuery;
  const deferred = deferredPerformanceSummaryQualificationFromQuery(query);
  if (!deferred)
    throw new Error("performance_summary_qualification_not_prepared");
  return { query, deferred };
}

async function compilePerformanceSummaryEvidence(
  scope: Scope,
  filters: ReturnType<typeof qualifiedFilters>,
) {
  const preparationTrace = trace();
  const middleware = d1AdvancedFilterMiddleware(
    envFor(preparationTrace),
    undefined,
    SITE_ID,
  );
  const prepared = (await middleware(
    "performance",
    performanceQuery(scope, filters),
    async (value) => value,
  )) as QueryInput & Record<string, unknown>;
  const deferred = deferredPerformanceSummaryQualificationFromQuery(prepared);
  if (!deferred)
    throw new Error("performance_summary_qualification_not_prepared");
  const compilation = compilePreparedPerformanceSummaryProgram({
    query: prepared,
    deferred,
  });
  if (compilation.kind !== "compiled")
    throw new Error("performance_summary_qualification_plan_unavailable");
  return {
    preparationTrace,
    evidence: compilation.evidence,
    query: compilation.query,
  };
}

async function legacyPreparedSummary(
  scope: Scope,
  filters = qualifiedFilters(),
) {
  const preparationTrace = trace();
  const middleware = d1AdvancedFilterMiddleware(
    envFor(preparationTrace),
    undefined,
    SITE_ID,
  );
  const prepared = (await middleware(
    "performance",
    performanceQuery(scope, filters),
    async (value) => value,
  )) as QueryInput & Record<string, unknown>;
  const deferred = deferredPerformanceSummaryQualificationFromQuery(prepared);
  if (!deferred)
    throw new Error("performance_summary_qualification_not_prepared");
  const preparedFilters = await prepareDeferredEventQualificationFallback(
    deferred.qualification,
  );
  const summaryTrace = trace();
  const metrics = await queryPerformanceSummariesFromD1(
    envFor(summaryTrace),
    SITE_ID,
    WINDOW,
    preparedFilters,
  );
  return { value: { metrics }, preparationTrace, summaryTrace };
}

describe("Performance Summary qualified regression", () => {
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
      .run(SITE_ID, "wave96s-team", "Performance summary", "perf.test");
    database
      .prepare(
        "INSERT INTO sites (id, team_id, name, domain, created_at) VALUES (?, ?, ?, ?, 0)",
      )
      .run(
        OTHER_SITE_ID,
        "wave96s-team",
        "Performance summary other",
        "other-perf.test",
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

    const fixture: PageSeed[] = [
      {
        id: "visitor-a-session-1-page-1",
        visitor: "visitor-a",
        session: "session-a1",
        startedAt: BASE + 10,
        pathname: "/one",
        country: "US",
        latitude: null,
        ttfb: 0,
        fcp: 10,
        lcp: 50,
        cls: 0.1,
        inp: null,
        events: [{ name: "qualifier", at: BASE + 100 }],
      },
      {
        id: "visitor-a-session-1-page-2",
        visitor: "visitor-a",
        session: "session-a1",
        startedAt: BASE + 20,
        pathname: "/one",
        country: "US",
        latitude: null,
        ttfb: 100,
        fcp: null,
        lcp: 30,
        cls: 0.2,
        inp: 0,
      },
      {
        id: "visitor-a-session-2-page-1",
        visitor: "visitor-a",
        session: "session-a2",
        startedAt: BASE + 30,
        pathname: "/two",
        country: "CA",
        latitude: 1,
        ttfb: -5,
        fcp: 30,
        lcp: 70,
        cls: null,
        inp: 10,
        events: [{ name: "qualifier", at: BASE + 200 }],
      },
      {
        id: "visitor-a-session-2-excluded",
        visitor: "visitor-a",
        session: "session-a2",
        startedAt: BASE + 40,
        pathname: "/excluded",
        country: "CA",
        latitude: 1,
        ttfb: 999,
        fcp: 999,
        lcp: 999,
        cls: 9,
        inp: 999,
      },
      {
        id: "visitor-b-session-1-page-1",
        visitor: "visitor-b",
        session: "session-b1",
        startedAt: BASE + 50,
        pathname: "/five",
        country: "GB",
        latitude: 2,
        ttfb: null,
        fcp: 0,
        lcp: 100,
        cls: 0.3,
        inp: 50,
        events: [{ name: "qualifier", at: BASE + 300 }],
      },
      {
        id: "event-only-outside-window",
        visitor: "visitor-event-only",
        session: "session-event-only",
        startedAt: TIME.range.endExclusiveMs + 1000,
        pathname: "/outside-event-owner",
        country: "FR",
        latitude: null,
        ttfb: 1000,
        fcp: 1000,
        lcp: 1000,
        cls: 1,
        inp: 1000,
        events: [{ name: "qualifier", at: BASE + 400 }],
      },
      {
        id: "outside-window-no-event",
        visitor: "visitor-outside",
        session: "session-outside",
        startedAt: TIME.range.endExclusiveMs + 2000,
        pathname: "/outside",
        country: "FR",
        latitude: null,
        ttfb: 2000,
        fcp: 2000,
        lcp: 2000,
        cls: 2,
        inp: 2000,
      },
      {
        id: "other-site-page",
        siteId: OTHER_SITE_ID,
        sitePk: otherSitePk,
        visitor: "other-visitor",
        session: "other-session",
        startedAt: BASE + 60,
        pathname: "/other-site",
        country: "DE",
        latitude: null,
        ttfb: 7000,
        fcp: 7000,
        lcp: 7000,
        cls: 7,
        inp: 7000,
        events: [{ name: "qualifier", at: BASE + 500 }],
      },
      {
        id: "whole-native-only-page",
        visitor: "whole-native-only-visitor",
        session: "whole-native-only-session",
        startedAt: BASE + 70,
        pathname: "/native-only",
        country: "AU",
        latitude: 3,
        ttfb: 41,
        fcp: 51,
        lcp: 61,
        cls: 0.41,
        inp: 71,
      },
      {
        id: "whole-count-only-page",
        visitor: "whole-count-only-visitor",
        session: "whole-count-only-session",
        startedAt: BASE + 80,
        pathname: "/count-only",
        country: "NZ",
        latitude: 4,
        ttfb: 941,
        fcp: 951,
        lcp: 961,
        cls: 0.94,
        inp: 971,
        events: [{ name: "qualifier", at: BASE + 180 }],
      },
    ];
    fixture.forEach(seedPage);
  });

  afterAll(() => database.close());

  it("keeps no-advanced summary on the existing single-statement path", async () => {
    const query = performanceQuery("session");
    const queryTrace = trace();
    const result = await executePerformance(query, queryTrace);
    const value = result.value as { readonly metrics: Record<string, unknown> };
    const filters = query.filters ?? EMPTY_FILTER_DOCUMENT;
    const metadata = scopedFilterMetadata(filters);
    const plan = buildPerformanceSummariesPlan({
      siteId: SITE_ID,
      queryTime: queryWindowToTime(WINDOW),
      filters,
      ...(metadata
        ? {
            scopePlan: metadata.plan,
            preparedTimePolicy: "reader-window-v1" as const,
          }
        : {}),
    });
    const logicalPlan = printLogicalPlan(plan);
    expect(queryTrace.preparedSql).toHaveLength(1);
    expect(Object.keys(value.metrics)).toEqual([
      "ttfb",
      "fcp",
      "lcp",
      "cls",
      "inp",
    ]);
    const phase = EVIDENCE_PHASE === "before" ? "before" : "after";
    writeEvidence(`performance-summary-ordinary-${phase}.json`, {
      request: {
        siteId: SITE_ID,
        mode: "summary",
        scope: "session",
        time: TIME,
        filters: EMPTY_FILTER_DOCUMENT,
      },
      logicalPlan,
      logicalPlanSha256: hash(logicalPlan),
      sql: queryTrace.preparedSql,
      bindings: queryTrace.bindings,
      value,
      statementCount: queryTrace.preparedSql.length,
    });
  });
  it.each(["session", "visitor"] as const)(
    "qualifies the existing Page sample bag for %s scope in one report/control statement",
    async (scope) => {
      const query = performanceQuery(scope, qualifiedFilters());
      const queryTrace = trace();
      const result = await executePerformance(query, queryTrace);
      const expected = expectedQualifiedMetrics(scope);
      const value = result.value as typeof expected;
      expect(value).toEqual(expected);
      expect(queryTrace.preparedSql).toHaveLength(2);

      const compilation = await compilePerformanceSummaryEvidence(
        scope,
        qualifiedFilters(),
      );
      const reportDescriptor = compilation.evidence.outputDescriptors[0];
      expect(reportDescriptor?.outputId).toBe("performance-summaries");
      expect(reportDescriptor?.fields).toHaveLength(25);
      expect(compilation.evidence.ordering.map(({ field }) => field)).toEqual([
        "rowKind",
        "outputId",
      ]);
      expect(queryTrace.preparedSql[1]).toBe(compilation.evidence.sql);
      expect(queryTrace.bindings[1]).toEqual(compilation.evidence.bindings);
      const envelopeTrace = trace();
      const envelopeRows = await queryD1CompiledAll<Record<string, unknown>>(
        envFor(envelopeTrace),
        compilation.query,
      );
      const controlRows = envelopeRows.filter(
        (row) => row.rowKind === "control",
      );
      const reportRows = envelopeRows.filter((row) => row.rowKind === "report");
      expect(envelopeTrace.preparedSql).toHaveLength(1);
      expect(controlRows).toHaveLength(1);
      expect(reportRows).toHaveLength(1);
      expect(controlRows[0]).toMatchObject({
        rowKind: "control",
        outputId: compilation.evidence.controlOutputId,
        entityKind: scope,
        rawCount: expect.any(Number),
        nullActivityIdCount: expect.any(Number),
        siteIdentityMismatchCount: expect.any(Number),
        invalidIdentityCount: expect.any(Number),
        duplicateIdentityCount: expect.any(Number),
      });

      const legacy = await legacyPreparedSummary(scope);
      expect(value).toEqual(legacy.value);
      expect(legacy.summaryTrace.preparedSql).toHaveLength(1);
      expect(legacy.preparationTrace.preparedSql.length).toBeGreaterThan(0);
      writeEvidence("performance-summary-qualified-" + scope + ".json", {
        request: {
          siteId: SITE_ID,
          mode: "summary",
          scope,
          time: TIME,
          filters: QUALIFIED_FILTER_DSL,
        },
        statementCount: queryTrace.preparedSql.length,
        sql: queryTrace.preparedSql,
        bindings: queryTrace.bindings,
        value,
        legacyValue: legacy.value,
        legacyPreparationStatements: legacy.preparationTrace.preparedSql.length,
        legacySummaryStatements: legacy.summaryTrace.preparedSql.length,
        manualSamples: expectedSampleSets(scope),
        compilation: {
          logicalPlan: printLogicalPlan(compilation.evidence.logicalPlan),
          sql: compilation.evidence.sql,
          bindings: compilation.evidence.bindings,
          sqlBytes: compilation.evidence.sqlBytes,
          bindingCount: compilation.evidence.bindingCount,
          groupWidth: compilation.evidence.groupWidth,
          sharedRelationCount: compilation.evidence.sharedRelationCount,
          rootKind: compilation.evidence.rootKind,
          reportSourceRelations: compilation.evidence.reportSourceRelations,
          controlOutputId: compilation.evidence.controlOutputId,
          controlFields: compilation.evidence.controlFields,
          compatibilityFields: compilation.evidence.compatibilityFields,
          outputDescriptors: compilation.evidence.outputDescriptors,
          ordering: compilation.evidence.ordering,
        },
        preparationSql: compilation.preparationTrace.preparedSql,
        controlWitness: {
          rows: envelopeRows,
          sql: envelopeTrace.preparedSql,
          bindings: envelopeTrace.bindings,
        },
      });
    },
  );

  it("qualifies the complete mixed OR tree for private performance summary", async () => {
    const filters = parseFilterDsl(
      MIXED_OR_FILTER_DSL,
      analyticsFilterRegistry,
    );
    const preparationTrace = trace();
    const prepared = await prepareBrandedPerformanceSummary(
      "session",
      preparationTrace,
      filters,
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
      performanceQuery("session", filters),
      actualTrace,
      { diagnostics },
    );
    const legacy = await legacyPreparedSummary("session", filters);
    expect(actual.value).toEqual(legacy.value);
    expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
    expect(
      (
        actual.value as {
          readonly metrics: Record<
            string,
            {
              readonly avg: number;
              readonly p50: number;
              readonly p75: number;
              readonly p95: number;
              readonly samples: number;
            }
          >;
        }
      ).metrics.ttfb,
    ).toEqual({ avg: 346, p50: 41, p75: 941, p95: 999, samples: 6 });

    const statements = performanceStatementEvidence(actualTrace);
    const envelopes = statements.filter(({ envelope }) => envelope);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]!.utf8Bytes).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
    expect(envelopes[0]!.slotCount).toBeLessThanOrEqual(
      D1_MAX_BOUND_PARAMETERS,
    );

    const unsafeQueries: Array<
      QueryInput & {
        readonly audience?: string;
        readonly comparison?: unknown;
        readonly analysisContext?: unknown;
        readonly dimension?: unknown;
      }
    > = [
      performanceQuery("session", filters, { audience: "public-share" }),
      {
        ...performanceQuery("session", filters),
        comparison: {},
      },
      {
        ...performanceQuery("session", filters),
        analysisContext: { kind: "goal", goalId: "goal-private" },
      },
    ];
    let accessorReads = 0;
    const accessorQuery: (typeof unsafeQueries)[number] = {
      ...performanceQuery("session", filters),
    };
    Object.defineProperty(accessorQuery, "dimension", {
      enumerable: true,
      get() {
        accessorReads += 1;
        return "page.path";
      },
    });
    unsafeQueries.push(accessorQuery);
    for (const query of unsafeQueries) {
      const rejectedTrace = trace();
      const forwarded = await d1AdvancedFilterMiddleware(
        envFor(rejectedTrace),
        undefined,
        SITE_ID,
      )("performance", query, async (value) => value);
      expect(
        deferredPerformanceSummaryQualificationFromQuery(
          forwarded as QueryInput & Record<string, unknown>,
        ),
      ).toBeUndefined();
    }
    expect(accessorReads).toBe(0);

    writeEvidence("whole-or-summary.json", {
      request: {
        siteId: SITE_ID,
        mode: "summary",
        scope: "session",
        filters: MIXED_OR_FILTER_DSL,
      },
      filterMode: prepared.deferred.qualification.performanceFilterMode,
      advancedMatchesPresent: false,
      rejectedPermissionShapes: [
        "public-share audience",
        "comparison state",
        "analysisContext",
        "accessor-backed performance configuration",
      ],
      accessorReads,
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
      legacyPreparationSql: legacy.preparationTrace.preparedSql,
      legacySummarySql: legacy.summaryTrace.preparedSql,
    });
  });

  it("uses nearest-rank percentiles for unsorted samples with duplicates", () => {
    const nearestRank = (values: readonly number[], fraction: number) => {
      const sorted = [...values].sort((left, right) => left - right);
      return sorted[Math.ceil(sorted.length * fraction) - 1];
    };
    const values = [9, 1, 9, 4];
    expect(nearestRank(values, 0.5)).toBe(4);
    expect(nearestRank(values, 0.75)).toBe(9);
    expect(nearestRank(values, 0.95)).toBe(9);
  });

  it("compares summary configuration as own data without invoking getters or toJSON", async () => {
    let getterCalls = 0;
    let toJSONCalls = 0;
    const getterConfig = Object.defineProperty({}, "mode", {
      enumerable: true,
      get() {
        getterCalls++;
        return "summary";
      },
    });
    const toJSONConfig = {
      mode: "summary",
      toJSON() {
        toJSONCalls++;
        return { mode: "summary" };
      },
    };
    const expected = Object.freeze({ mode: "summary" as const });
    expect(
      matchesPerformanceSummaryQualificationConfiguration(expected, expected),
    ).toBe(true);
    expect(
      matchesPerformanceSummaryQualificationConfiguration(
        getterConfig,
        expected,
      ),
    ).toBe(false);
    expect(
      matchesPerformanceSummaryQualificationConfiguration(
        toJSONConfig,
        expected,
      ),
    ).toBe(false);
    expect(getterCalls).toBe(0);
    expect(toJSONCalls).toBe(0);

    let modeGetterCalls = 0;
    const malformed = { ...performanceQuery("session") } as QueryInput &
      Record<string, unknown>;
    Object.defineProperty(malformed, "mode", {
      enumerable: true,
      get() {
        modeGetterCalls++;
        return "summary";
      },
    });
    const malformedTrace = trace();
    await expect(
      executePerformance(malformed, malformedTrace),
    ).rejects.toThrow();
    expect(modeGetterCalls).toBe(0);
    expect(malformedTrace.preparedSql).toHaveLength(0);
  });

  it("rejects a frozen structural deferred clone at the public summary program boundary", async () => {
    const queryTrace = trace();
    const { query, deferred } = await prepareBrandedPerformanceSummary(
      "session",
      queryTrace,
    );
    const clone = Object.freeze({ ...deferred });
    const readsBeforeCalls = queryTrace.preparedSql.length;
    let compileError: unknown;
    try {
      compilePreparedPerformanceSummaryProgram({ query, deferred: clone });
    } catch (error) {
      compileError = error;
    }
    let executeError: unknown;
    try {
      await executePreparedPerformanceSummaryProgram({
        env: envFor(queryTrace),
        query,
        deferred: clone,
      });
    } catch (error) {
      executeError = error;
    }
    expect({
      compileError: compileError instanceof Error ? compileError.message : null,
      executeError: executeError instanceof Error ? executeError.message : null,
      reads: queryTrace.preparedSql.length,
    }).toEqual({
      compileError: "performance_summary_qualification_request_invalid",
      executeError: "performance_summary_qualification_request_invalid",
      reads: readsBeforeCalls,
    });
  });

  it("binds the public summary program to the exact prepared query brand", async () => {
    const queryTrace = trace();
    const requestA = await prepareBrandedPerformanceSummary(
      "session",
      queryTrace,
    );
    const requestB = await prepareBrandedPerformanceSummary(
      "visitor",
      queryTrace,
    );
    const readsBeforeCalls = queryTrace.preparedSql.length;
    let compileError: unknown;
    try {
      compilePreparedPerformanceSummaryProgram({
        query: requestB.query,
        deferred: requestA.deferred,
      });
    } catch (error) {
      compileError = error;
    }
    let executeError: unknown;
    try {
      await executePreparedPerformanceSummaryProgram({
        env: envFor(queryTrace),
        query: requestB.query,
        deferred: requestA.deferred,
      });
    } catch (error) {
      executeError = error;
    }
    expect({
      compileError: compileError instanceof Error ? compileError.message : null,
      executeError: executeError instanceof Error ? executeError.message : null,
      reads: queryTrace.preparedSql.length,
    }).toEqual({
      compileError: "performance_summary_qualification_request_changed",
      executeError: "performance_summary_qualification_request_changed",
      reads: readsBeforeCalls,
    });
  });

  it("rejects a prepared query mutated after middleware before compiling or reading", async () => {
    const queryTrace = trace();
    const { query, deferred } = await prepareBrandedPerformanceSummary(
      "session",
      queryTrace,
    );
    const readsBeforeCalls = queryTrace.preparedSql.length;
    query.mode = "timeseries";
    let compileError: unknown;
    try {
      compilePreparedPerformanceSummaryProgram({ query, deferred });
    } catch (error) {
      compileError = error;
    }
    let executeError: unknown;
    try {
      await executePreparedPerformanceSummaryProgram({
        env: envFor(queryTrace),
        query,
        deferred,
      });
    } catch (error) {
      executeError = error;
    }
    expect({
      compileError: compileError instanceof Error ? compileError.message : null,
      executeError: executeError instanceof Error ? executeError.message : null,
      reads: queryTrace.preparedSql.length,
    }).toEqual({
      compileError: "performance_summary_qualification_request_changed",
      executeError: "performance_summary_qualification_request_changed",
      reads: readsBeforeCalls,
    });
  });

  it("executes the registered deferred program for its unchanged prepared query", async () => {
    const preparationTrace = trace();
    const { query, deferred } = await prepareBrandedPerformanceSummary(
      "session",
      preparationTrace,
    );
    const compilation = compilePreparedPerformanceSummaryProgram({
      query,
      deferred,
    });
    if (compilation.kind !== "compiled")
      throw new Error("performance_summary_qualification_plan_unavailable");
    const directTrace = trace();
    const direct = await executePreparedPerformanceSummaryProgram({
      env: envFor(directTrace),
      query,
      deferred,
    });
    expect(direct.kind).toBe("executed");
    if (direct.kind !== "executed") return;
    const providerTrace = trace();
    const provider = await executePerformance(
      performanceQuery("session", qualifiedFilters()),
      providerTrace,
    );
    const providerValue = provider.value as {
      readonly metrics: ReturnType<typeof mapPerformanceSummaries>;
    };
    expect(mapPerformanceSummaries([direct.row])).toEqual(
      providerValue.metrics,
    );
    expect(directTrace.preparedSql).toEqual([compilation.evidence.sql]);
    expect(directTrace.bindings).toEqual([compilation.evidence.bindings]);
  });

  it("rejects a changed branded request before database reads and keeps the no-mode test seam", async () => {
    const query = performanceQuery("session", qualifiedFilters());
    const queryTrace = trace();
    const middleware = d1AdvancedFilterMiddleware(
      envFor(queryTrace),
      undefined,
      SITE_ID,
    );
    const prepared = (await middleware(
      "performance",
      query,
      async (value) => value,
    )) as QueryInput & Record<string, unknown>;
    expect(
      deferredPerformanceSummaryQualificationFromQuery(prepared),
    ).toBeDefined();
    const readsBeforeMismatch = queryTrace.preparedSql.length;
    prepared.mode = "timeseries";
    expect(() =>
      deferredPerformanceSummaryQualificationFromQuery(prepared),
    ).toThrow("performance_summary_qualification_request_changed");
    expect(queryTrace.preparedSql).toHaveLength(readsBeforeMismatch);

    const siteMismatchTrace = trace();
    const siteMismatchMiddleware = d1AdvancedFilterMiddleware(
      envFor(siteMismatchTrace),
      undefined,
      OTHER_SITE_ID,
    );
    await expect(
      siteMismatchMiddleware(
        "performance",
        performanceQuery("session", qualifiedFilters()),
        async (value) => value,
      ),
    ).rejects.toMatchObject({
      domainError: {
        issues: [
          {
            path: "siteId",
            code: "performance_summary_request_context_mismatch",
          },
        ],
      },
    });
    expect(siteMismatchTrace.preparedSql).toHaveLength(0);

    const { mode: _mode, ...legacyQuery } = performanceQuery(
      "session",
      qualifiedFilters(),
    );
    const legacyOutput = (await middleware(
      "performance",
      legacyQuery as QueryInput,
      async (value) => value,
    )) as QueryInput & Record<string, unknown>;
    expect(
      deferredPerformanceSummaryQualificationFromQuery(legacyOutput),
    ).toBeUndefined();
  });

  it("keeps event-only qualification on the Page sample bag and preserves empty summaries", async () => {
    const eventOnlyFilters = parseFilterDsl(
      'count(event { event.name eq "qualifier" }) gte 1',
      analyticsFilterRegistry,
    );
    const eventOnlyTrace = trace();
    const eventOnly = await executePerformance(
      performanceQuery("session", eventOnlyFilters),
      eventOnlyTrace,
    );
    const eventOnlyLegacy = await legacyPreparedSummary(
      "session",
      eventOnlyFilters,
    );
    expect(eventOnly.value).toEqual(eventOnlyLegacy.value);
    expect(eventOnlyTrace.preparedSql).toHaveLength(2);
    expect(
      (eventOnly.value as { metrics: Record<string, { samples: number }> })
        .metrics.ttfb?.samples,
    ).toBe(5);
    // Session owners session-a1/session-a2 qualify from their Page events; the
    // count-only Page contributes one more sample. The b1 Page has null TTFB,
    // while outside-window and other-site Pages contribute no samples.
    const eventOnlyTtfbSamples = [
      {
        pageId: "visitor-a-session-1-page-1",
        owner: "session-a1",
        startedAtMs: BASE + 10,
        value: 0,
      },
      {
        pageId: "visitor-a-session-1-page-2",
        owner: "session-a1",
        startedAtMs: BASE + 20,
        value: 100,
      },
      {
        pageId: "visitor-a-session-2-page-1",
        owner: "session-a2",
        startedAtMs: BASE + 30,
        value: -5,
      },
      {
        pageId: "visitor-a-session-2-excluded",
        owner: "session-a2",
        startedAtMs: BASE + 40,
        value: 999,
      },
      {
        pageId: "whole-count-only-page",
        owner: "whole-count-only-session",
        startedAtMs: BASE + 80,
        value: 941,
      },
    ] as const;
    expect(
      eventOnlyTtfbSamples.every(
        ({ startedAtMs }) =>
          startedAtMs >= TIME.range.startMs &&
          startedAtMs < TIME.range.endExclusiveMs,
      ),
    ).toBe(true);
    expect(eventOnlyTtfbSamples.map(({ value }) => value)).toEqual([
      0, 100, -5, 999, 941,
    ]);
    expect(
      (eventOnly.value as { metrics: Record<string, { samples: number }> })
        .metrics.ttfb?.samples,
    ).toBe(eventOnlyTtfbSamples.length);

    const eventOnlyOwnerWithoutWindowPage = parseFilterDsl(
      'page.path eq "/outside-event-owner" and count(event { event.name eq "qualifier" }) gte 1',
      analyticsFilterRegistry,
    );
    const noPageTrace = trace();
    const noPage = await executePerformance(
      performanceQuery("session", eventOnlyOwnerWithoutWindowPage),
      noPageTrace,
    );
    const noPageLegacy = await legacyPreparedSummary(
      "session",
      eventOnlyOwnerWithoutWindowPage,
    );
    expect(noPage.value).toEqual(noPageLegacy.value);
    expect(noPageTrace.preparedSql).toHaveLength(2);
    expect(noPage.value).toEqual({
      metrics: {
        ttfb: { avg: null, p50: null, p75: null, p95: null, samples: 0 },
        fcp: { avg: null, p50: null, p75: null, p95: null, samples: 0 },
        lcp: { avg: null, p50: null, p75: null, p95: null, samples: 0 },
        cls: { avg: null, p50: null, p75: null, p95: null, samples: 0 },
        inp: { avg: null, p50: null, p75: null, p95: null, samples: 0 },
      },
    });
    const noPageSourceRows = Number(
      (
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM visits WHERE site_pk = ? AND pathname = ? AND started_at >= ? AND started_at < ?",
          )
          .get(
            sitePk,
            "/outside-event-owner",
            TIME.range.startMs,
            TIME.range.endExclusiveMs,
          ) as {
          readonly count: number;
        }
      ).count,
    );
    expect(noPageSourceRows).toBe(0);
    writeEvidence("performance-summary-empty-and-event-only.json", {
      eventOnly: {
        value: eventOnly.value,
        legacyValue: eventOnlyLegacy.value,
        preparedStatementCount: eventOnlyTrace.preparedSql.length,
        sql: eventOnlyTrace.preparedSql,
        bindings: eventOnlyTrace.bindings,
      },
      eventOwnerWithoutPageInWindow: {
        pathname: "/outside-event-owner",
        eventOccurredAt: BASE + 400,
        startedAt: TIME.range.endExclusiveMs + 1000,
        inWindowPageRows: noPageSourceRows,
        value: noPage.value,
        legacyValue: noPageLegacy.value,
        preparedStatementCount: noPageTrace.preparedSql.length,
        sql: noPageTrace.preparedSql,
        bindings: noPageTrace.bindings,
      },
    });

    const emptyFilters = parseFilterDsl(
      'count(event { event.name eq "never-seen" }) gte 1',
      analyticsFilterRegistry,
    );
    const emptyTrace = trace();
    const empty = await executePerformance(
      performanceQuery("session", emptyFilters),
      emptyTrace,
    );
    const emptyLegacy = await legacyPreparedSummary("session", emptyFilters);
    expect(empty.value).toEqual(emptyLegacy.value);
    expect(emptyTrace.preparedSql).toHaveLength(2);
    expect(empty.value).toEqual({
      metrics: {
        ttfb: { avg: null, p50: null, p75: null, p95: null, samples: 0 },
        fcp: { avg: null, p50: null, p75: null, p95: null, samples: 0 },
        lcp: { avg: null, p50: null, p75: null, p95: null, samples: 0 },
        cls: { avg: null, p50: null, p75: null, p95: null, samples: 0 },
        inp: { avg: null, p50: null, p75: null, p95: null, samples: 0 },
      },
    });
  });

  it("does not defer public, team, multi-site, event-scope, unsupported, or non-summary requests", async () => {
    const filters = qualifiedFilters();
    const teamQuery = (authorizedSiteIds: readonly string[]) => {
      const prepared = prepareScopedQuery("performance", {
        context: teamQueryContext(
          "wave96s-team",
          "private-dashboard",
          authorizedSiteIds,
        ),
        time: TIME,
        filters,
        scopePreference: "session",
      } as QueryInput & { readonly time: QueryTime });
      return { ...prepared, time: TIME, mode: "summary" } as QueryInput &
        Record<string, unknown>;
    };
    const unsupportedFilters = parseFilterDsl(
      'geo.country eq "US" or count(event { event.name eq "qualifier" }) gte 1',
      analyticsFilterRegistry,
    );
    const variants: Array<{
      readonly name: string;
      readonly query: QueryInput;
    }> = [
      {
        name: "public",
        query: performanceQuery("session", filters, {
          audience: "public-share",
        }),
      },
      { name: "team", query: teamQuery([SITE_ID]) },
      { name: "multi-site", query: teamQuery([SITE_ID, OTHER_SITE_ID]) },
      { name: "event-scope", query: performanceQuery("event", filters) },
      {
        name: "unsupported-geo-comparison",
        query: performanceQuery("session", unsupportedFilters),
      },
      {
        name: "timeseries",
        query: performanceQuery("session", filters, { mode: "timeseries" }),
      },
      {
        name: "dashboard",
        query: performanceQuery("session", filters, { mode: "dashboard" }),
      },
      { name: "no-advanced-filter", query: performanceQuery("session") },
    ];
    const middleware = d1AdvancedFilterMiddleware(
      envFor(trace()),
      undefined,
      SITE_ID,
    );
    const absent: string[] = [];
    for (const variant of variants) {
      const forwarded = await middleware(
        "performance",
        variant.query,
        async (value) => value,
      );
      if (
        deferredPerformanceSummaryQualificationFromQuery(
          forwarded as QueryInput & Record<string, unknown>,
        ) === undefined
      )
        absent.push(variant.name);
    }
    expect(absent).toEqual(variants.map(({ name }) => name));
    writeEvidence("performance-summary-qualification-boundaries.json", {
      absentDeferredKinds: absent,
      expectedAbsentDeferredKinds: variants.map(({ name }) => name),
    });
  });

  it("falls back to the legacy reader for invalid numeric Count data", async () => {
    const filters = parseFilterDsl(
      'page.path neq "/excluded" and count(page { page.durationMs gt 5 }) eq 1',
      analyticsFilterRegistry,
    );
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "visitor-a-session-2-page-1");
    try {
      const actualTrace = trace();
      const diagnostics = createD1ReadDiagnostics();
      const actual = await executePerformance(
        performanceQuery("session", filters),
        actualTrace,
        { diagnostics },
      );
      const legacy = await legacyPreparedSummary("session", filters);
      expect(actual.value).toEqual(legacy.value);
      expect(diagnostics.advancedCountSqlFallbackReason).toMatchObject({
        kind: "numeric-data-domain",
        fieldIds: ["page.durationMs"],
      });
      const compiledStatements = actualTrace.preparedSql.filter((sql) =>
        sql.includes('AS "outputId"'),
      );
      const legacySummaryStatements = actualTrace.preparedSql.filter(
        (sql) =>
          sql.includes('AS "ttfbSamples"') && !sql.includes('AS "outputId"'),
      );
      expect(compiledStatements).toHaveLength(1);
      expect(legacySummaryStatements).toHaveLength(1);
      writeEvidence("performance-summary-numeric-fallback.json", {
        request: {
          siteId: SITE_ID,
          mode: "summary",
          scope: "session",
          time: TIME,
          filters:
            'page.path neq "/excluded" and count(page { page.durationMs gt 5 }) eq 1',
        },
        invalidStoredValue: "invalid-duration",
        fallbackReason: diagnostics.advancedCountSqlFallbackReason,
        value: actual.value,
        legacyValue: legacy.value,
        preparedStatementCount: actualTrace.preparedSql.length,
        compiledQualificationStatements: compiledStatements.length,
        legacySummaryStatements: legacySummaryStatements.length,
        sql: actualTrace.preparedSql,
        bindings: actualTrace.bindings,
      });
    } finally {
      database
        .prepare("UPDATE visits SET duration_ms = NULL WHERE visit_id = ?")
        .run("visitor-a-session-2-page-1");
    }
  });

  it.each([
    [
      "missing-control",
      "performance_summary_qualification_control_row_invalid",
    ],
    [
      "duplicate-control",
      "performance_summary_qualification_control_row_invalid",
    ],
    [
      "wrong-control-kind",
      "performance_summary_qualification_control_kind_mismatch",
    ],
    [
      "wrong-report-output",
      "performance_summary_qualification_report_row_invalid",
    ],
    ["database-error", "injected performance qualification read failure"],
  ] as const)(
    "fails closed without retrying for %s",
    async (behavior, message) => {
      const queryTrace = trace();
      const diagnostics = createD1ReadDiagnostics();
      const env = envWithQualificationBehavior(queryTrace, behavior);
      await expect(
        executePerformance(
          performanceQuery("session", qualifiedFilters()),
          queryTrace,
          {
            env,
            diagnostics,
          },
        ),
      ).rejects.toThrow(message);
      expect(queryTrace.preparedSql).toHaveLength(2);
      expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
      writeEvidence("performance-summary-protocol-faults.json", {
        behavior,
        expectedError: message,
        preparedStatementCount: queryTrace.preparedSql.length,
        fallbackReason: diagnostics.advancedCountSqlFallbackReason ?? null,
        sql: queryTrace.preparedSql,
        bindings: queryTrace.bindings,
      });
    },
  );

  it("propagates pre- and post-query aborts without retrying", async () => {
    const query = performanceQuery("session", qualifiedFilters());
    const preAbortTrace = trace();
    const preAbort = new AbortController();
    preAbort.abort();
    await expect(
      executePerformance(query, preAbortTrace, { signal: preAbort.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(preAbortTrace.preparedSql).toHaveLength(0);

    const postAbortTrace = trace();
    const postAbort = new AbortController();
    const postAbortDiagnostics = createD1ReadDiagnostics();
    await expect(
      executePerformance(query, postAbortTrace, {
        env: envWithQualificationBehavior(
          postAbortTrace,
          "post-abort",
          postAbort,
        ),
        diagnostics: postAbortDiagnostics,
        signal: postAbort.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(postAbortTrace.preparedSql).toHaveLength(2);
    expect(postAbortDiagnostics.advancedCountSqlFallbackReason).toBeUndefined();
    writeEvidence("performance-summary-abort.json", {
      preAbort: {
        name: "AbortError",
        preparedStatementCount: preAbortTrace.preparedSql.length,
      },
      postAbort: {
        name: "AbortError",
        preparedStatementCount: postAbortTrace.preparedSql.length,
        fallbackReason:
          postAbortDiagnostics.advancedCountSqlFallbackReason ?? null,
        sql: postAbortTrace.preparedSql,
        bindings: postAbortTrace.bindings,
      },
    });
  });
});
