import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { afterAll, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  compileD1Query,
  D1_MAX_BOUND_PARAMETERS,
  D1_MAX_SQL_UTF8_BYTES,
  lowerLogicalPlan,
} from "@/lib/db";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { createD1SiteProviderRegistry } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import {
  overviewProvider,
  trendProvider,
} from "@/lib/edge/analytics/composition/d1/overview";
import {
  type CanonicalQuery,
  type FilterDocument,
  prepareScopedQuery,
  type QueryInput,
  type QueryTime,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { createQueryTime } from "@/lib/edge/analytics/contract/helpers";
import { buildOverviewAggregatePlan } from "@/lib/edge/analytics/engine/overview-aggregate-report-plan";
import type { LegacyOverviewTrendQualificationConfiguration } from "@/lib/edge/analytics/engine/overview-trend-qualification-plan";
import { buildOverviewTrendPlan } from "@/lib/edge/analytics/engine/overview-trend-report-plan";
import {
  d1AdvancedFilterMiddleware,
  deferredOverviewTrendQualificationFromQuery,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { AnalyticsLogicalToDbLowerer } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import {
  compileOverviewTrendQualificationProgram,
  executeOverviewTrendQualificationProgram,
} from "@/lib/edge/analytics/providers/d1/internal/overview-trend-qualification-program";
import { createOverviewReader } from "@/lib/edge/analytics/providers/d1/operations/overview-reader";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";

const SITE = "wave96f-overview-trend";
const BASE = Date.UTC(2024, 0, 1);
const HOUR = 60 * 60 * 1000;
const WINDOW_TIME = createQueryTime(
  BASE,
  BASE + 4 * HOUR,
  "UTC",
  BASE + 4 * HOUR,
);
const FILTER_DSL =
  'page.path neq "/excluded" and count(event { event.name eq "qualifier" }) eq 1';
const CURSOR_SECRET = "wave96f-overview-trend-test-secret";
const databases = new Set<DatabaseSync>();
const sqlEvidence: Array<Record<string, unknown>> = [];
const nativeEvidence: Array<Record<string, unknown>> = [];
const evidenceDirectory = process.env.INSIGHTFLARE_QUERY_EVIDENCE_DIR?.trim();
const nativePreimageSha256 = {
  aggregate: "de0910f7bd3dddefa489519ce0df4a723152264581b02e0c4d51ca0d08534885",
  trend: "1238efa70557ac4dc6187a93af98aba7a67eb6bea74c4af2ff1853e7aa203a38",
} as const;

interface TestSite {
  readonly id: string;
  readonly pk: number;
}

type Scope = "session" | "visitor";
type Operation = "overview" | "trend";

type TestQuery = CanonicalQuery<"overview"> | CanonicalQuery<"trend">;

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
       VALUES (?, 'wave96f-team', 'Overview trend qualification', 'overview-trend.test', 0)`,
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
    readonly durationMs: number | null;
  },
): void {
  database
    .prepare(
      `INSERT INTO visits (
        visit_id, site_id, site_pk, visitor_id, session_id, status,
        started_at, last_activity_at, duration_ms, pathname, hostname
      ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, ?, 'overview-trend.test')`,
    )
    .run(
      input.id,
      site.id,
      site.pk,
      input.visitorId,
      input.sessionId,
      input.startedAt,
      input.startedAt,
      input.durationMs,
      input.path,
    );
}

function addEvent(
  database: DatabaseSync,
  site: TestSite,
  input: {
    readonly id: string;
    readonly visitId: string;
    readonly name: string;
    readonly occurredAt: number;
  },
): void {
  database
    .prepare(
      `INSERT OR IGNORE INTO custom_event_names (site_id, name, last_seen_at, site_pk)
       VALUES (?, ?, ?, ?)`,
    )
    .run(site.id, input.name, input.occurredAt, site.pk);
  const eventName = database
    .prepare("SELECT id FROM custom_event_names WHERE site_pk = ? AND name = ?")
    .get(site.pk, input.name) as { readonly id: number };
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
      eventName.id,
      input.occurredAt,
      input.occurredAt,
    );
}

function createFixture(): DatabaseSync {
  const database = createMigratedDatabase();
  databases.add(database);
  database.exec("PRAGMA foreign_keys = OFF");
  const site = addSite(database);
  const visits = [
    {
      id: "alpha-qualified-one",
      sessionId: "alpha-qualified",
      visitorId: "alpha",
      path: "/alpha/one",
      startedAt: BASE + 5 * 60_000,
      durationMs: 10_000,
    },
    {
      id: "alpha-qualified-two",
      sessionId: "alpha-qualified",
      visitorId: "alpha",
      path: "/alpha/two",
      startedAt: BASE + 65 * 60_000,
      durationMs: -5,
    },
    {
      id: "alpha-page-only",
      sessionId: "alpha-page-only",
      visitorId: "alpha",
      path: "/alpha/page-only",
      startedAt: BASE + 130 * 60_000,
      durationMs: null,
    },
    {
      id: "beta-qualified",
      sessionId: "beta-qualified",
      visitorId: "beta",
      path: "/beta",
      startedAt: BASE + 125 * 60_000,
      durationMs: 2_000,
    },
    {
      id: "delta-outside-page-window",
      sessionId: "delta-event-only",
      visitorId: "delta",
      path: "/delta/outside",
      startedAt: BASE - 10 * 60_000,
      durationMs: 1_000,
    },
    {
      id: "excluded-page",
      sessionId: "excluded-session",
      visitorId: "excluded-visitor",
      path: "/excluded",
      startedAt: BASE + 190 * 60_000,
      durationMs: 1_000,
    },
  ] as const;
  for (const visit of visits) addVisit(database, site, visit);
  const events = [
    {
      id: "alpha-qualifier",
      visitId: "alpha-qualified-one",
      name: "qualifier",
      occurredAt: BASE + 105 * 60_000,
    },
    {
      id: "alpha-noise",
      visitId: "alpha-qualified-two",
      name: "engagement",
      occurredAt: BASE + 155 * 60_000,
    },
    {
      id: "beta-qualifier",
      visitId: "beta-qualified",
      name: "qualifier",
      occurredAt: BASE + 20 * 60_000,
    },
    {
      id: "delta-qualifier",
      visitId: "delta-outside-page-window",
      name: "qualifier",
      occurredAt: BASE + 185 * 60_000,
    },
    {
      id: "excluded-qualifier",
      visitId: "excluded-page",
      name: "qualifier",
      occurredAt: BASE + 190 * 60_000,
    },
  ] as const;
  for (const event of events) addEvent(database, site, event);
  return database;
}

function testEnv(database: DatabaseSync, trace: SqliteD1Trace): Env {
  return {
    DB: createSqliteD1Database(database, trace),
    MAIN_SECRET: CURSOR_SECRET,
  } as unknown as Env;
}

type ControlledDatabaseBehavior =
  | "missing-control"
  | "duplicate-control"
  | "unknown-output"
  | "missing-scalar"
  | "unknown-row-kind"
  | "duplicate-report"
  | "database-error"
  | "post-abort"
  | "activity-cap-and-numeric-domain";

function testEnvWithBehavior(
  database: DatabaseSync,
  trace: SqliteD1Trace,
  behavior: ControlledDatabaseBehavior,
  options: {
    readonly controller?: AbortController;
    readonly numericControlField?: string;
  } = {},
): Env {
  const baseDatabase = createSqliteD1Database(database, trace);
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
            throw new Error("wave96f_sqlite_report_failure");
          const result = await originalAll<Record<string, unknown>>();
          if (behavior === "post-abort") options.controller?.abort();
          let rows = result.results;
          const control = rows.find((row) => row.rowKind === "control");
          if (behavior === "missing-control")
            rows = rows.filter((row) => row.rowKind !== "control");
          if (behavior === "duplicate-control" && control)
            rows = [...rows, control];
          if (behavior === "unknown-output")
            rows = rows.map((row) =>
              row.rowKind === "report" ? { ...row, outputId: "unknown" } : row,
            );
          if (behavior === "missing-scalar")
            rows = rows.map((row) => {
              if (row.rowKind !== "report") return row;
              const missing = { ...row };
              delete missing.views;
              return missing;
            });
          if (behavior === "unknown-row-kind")
            rows = rows.map((row) =>
              row.rowKind === "report" ? { ...row, rowKind: "unknown" } : row,
            );
          if (behavior === "duplicate-report") {
            const aggregate = rows.find(
              (row) =>
                row.rowKind === "report" &&
                row.outputId === "overview-aggregate",
            );
            if (aggregate) rows = [...rows, aggregate];
          }
          if (behavior === "activity-cap-and-numeric-domain")
            rows = rows.map((row) =>
              row.rowKind === "control"
                ? {
                    ...row,
                    rawCount: 20_001,
                    ...(options.numericControlField
                      ? { [options.numericControlField]: 1 }
                      : {}),
                  }
                : row,
            );
          return { ...result, results: rows };
        },
      });
      return replacement;
    },
  } as unknown as D1Database;
  return { DB, MAIN_SECRET: CURSOR_SECRET } as unknown as Env;
}

function nativePlanSnapshot(
  plan:
    | ReturnType<typeof buildOverviewAggregatePlan>
    | ReturnType<typeof buildOverviewTrendPlan>,
) {
  const output = plan.outputs[0];
  if (!output) throw new Error("wave96f_native_overview_output_missing");
  const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
    siteId: SITE,
    time: plan.context.time,
  });
  const lowered = lowerer.lower(output);
  const relation = lowerer.projectOutput(
    lowered,
    output.fields.map(({ name, slot }) => ({ name, slot })),
  );
  const physical = lowerLogicalPlan(relation);
  const query = compileD1Query(physical, {
    tag: "analytics.overview_native_preimage",
  });
  const snapshot = {
    logicalPlan: plan,
    physicalPlan: physical,
    physicalPlanShape: query.physicalPlanShape ?? null,
    sql: query.sql,
    bindings: [...(query.bindings ?? [])],
  };
  // Prepared memberships carry a process-local label; normalize it so the
  // pinned preimage does not depend on how many memberships ran before.
  const serialized = JSON.stringify(snapshot).replace(
    /prepared-membership-d+/g,
    "prepared-membership",
  );
  return {
    sha256: createHash("sha256").update(serialized).digest("hex"),
    snapshot,
  };
}

function queryFor(
  operation: Operation,
  scope: Scope,
  config: "aggregate" | "trend" | "detail",
  time: QueryTime = WINDOW_TIME,
  filterDsl = FILTER_DSL,
): TestQuery {
  const prepared = prepareScopedQuery(operation, {
    context: siteQueryContext(SITE, "private-dashboard"),
    time,
    filters: parseFilterDsl(filterDsl, analyticsFilterRegistry),
    scopePreference: scope,
  } as QueryInput & { readonly time: QueryTime });
  return {
    ...prepared,
    time,
    ...(operation === "trend" ? { interval: "hour" as const } : {}),
    ...(operation === "overview" && config === "detail"
      ? { detailInterval: "hour" as const }
      : {}),
  } as TestQuery;
}

async function legacyOracle(
  database: DatabaseSync,
  operation: Operation,
  query: TestQuery,
  trace: SqliteD1Trace,
) {
  const diagnostics = createD1ReadDiagnostics();
  const env = testEnv(database, trace);
  const forwarded = await d1AdvancedFilterMiddleware(env, diagnostics, SITE)(
    "performance",
    query,
    async (prepared) => prepared,
  );
  if (
    deferredOverviewTrendQualificationFromQuery(forwarded, operation) !==
    undefined
  )
    throw new Error("wave96f_legacy_oracle_received_deferred_brand");
  const filters = (forwarded as QueryInput).filters as
    FilterDocument | undefined;
  if (!filters) throw new Error("wave96f_legacy_oracle_filters_missing");
  const metadata = scopedFilterMetadata(filters);
  if (!metadata?.plan.preparedMembership)
    throw new Error("wave96f_legacy_oracle_advanced_matches_missing");
  const reader = createOverviewReader(env, SITE, diagnostics);
  const result =
    operation === "overview"
      ? await overviewProvider(reader).execute({
          ...query,
          filters,
        } as CanonicalQuery<"overview">)
      : await trendProvider(reader).execute({
          ...query,
          filters,
        } as CanonicalQuery<"trend">);
  return { result, filters, diagnostics, forwarded, trace };
}

async function prepareActualQualification(
  database: DatabaseSync,
  operation: Operation,
  query: TestQuery,
) {
  const trace = traceFor();
  const diagnostics = createD1ReadDiagnostics();
  const forwarded = await d1AdvancedFilterMiddleware(
    testEnv(database, trace),
    diagnostics,
    SITE,
  )(operation, query, async (prepared) => prepared);
  const deferred = deferredOverviewTrendQualificationFromQuery(
    forwarded,
    operation,
  );
  if (!deferred) throw new Error("wave96f_actual_qualification_missing");
  return { deferred, trace, diagnostics, forwarded };
}

describe("qualified D1 Overview and Trend", () => {
  afterAll(() => {
    for (const database of databases) database.close();
    if (evidenceDirectory && sqlEvidence.length > 0) {
      mkdirSync(evidenceDirectory, { recursive: true });
      const serialized = JSON.stringify(sqlEvidence, null, 2);
      const artifactPath = join(
        evidenceDirectory,
        "wave96i-overview-trend-sqlite-evidence.json",
      );
      writeFileSync(artifactPath, serialized, "utf8");
      writeFileSync(
        `${artifactPath}.sha256`,
        `${createHash("sha256").update(serialized).digest("hex")}  ${artifactPath}\n`,
        "utf8",
      );
    }
    if (evidenceDirectory && nativeEvidence.length > 0) {
      mkdirSync(evidenceDirectory, { recursive: true });
      writeFileSync(
        join(evidenceDirectory, "wave96i-native-overview-snapshot.json"),
        JSON.stringify(nativeEvidence, null, 2),
        "utf8",
      );
    }
  });

  const sixConfigurations = (["session", "visitor"] as const).flatMap((scope) =>
    (["aggregate", "trend", "detail"] as const).map((config) => ({
      scope,
      config,
    })),
  );

  it.each(sixConfigurations)(
    "matches the legacy full DTO for $scope/$config",
    async ({ scope, config }) => {
      const database = createFixture();
      const operation: Operation = config === "trend" ? "trend" : "overview";
      const query = queryFor(operation, scope, config);
      const actualTrace = traceFor();
      const actualDiagnostics = createD1ReadDiagnostics();
      const registry = createD1SiteProviderRegistry({
        env: testEnv(database, actualTrace),
        siteId: SITE,
        diagnostics: actualDiagnostics,
      });
      const actual =
        operation === "overview"
          ? await registry
              .resolve("overview")!
              .execute(query as CanonicalQuery<"overview">)
          : await registry
              .resolve("trend")!
              .execute(query as CanonicalQuery<"trend">);

      const actualQualification = await prepareActualQualification(
        database,
        operation,
        query,
      );
      const legacyTrace = traceFor();
      const legacy = await legacyOracle(
        database,
        operation,
        query,
        legacyTrace,
      );
      expect(actual).toEqual(legacy.result);
      expect(actual.source).toBe("raw");
      expect(actual.approximateVisitors).toBe(false);
      expect(actualTrace.preparedSql).toHaveLength(2);
      expect(actualDiagnostics.advancedCountSqlFallbackReason).toBeUndefined();
      expect(
        scopedFilterMetadata(legacy.filters)?.plan.preparedMembership,
      ).toBeDefined();
      expect(
        deferredOverviewTrendQualificationFromQuery(
          legacy.forwarded,
          operation,
        ),
      ).toBeUndefined();

      const configuration: LegacyOverviewTrendQualificationConfiguration =
        config === "aggregate"
          ? { kind: "aggregate" }
          : config === "trend"
            ? { kind: "trend", interval: "hour" }
            : { kind: "overview-with-detail", interval: "hour" };
      const compilation = compileOverviewTrendQualificationProgram({
        deferred: actualQualification.deferred,
        configuration,
      });
      expect(compilation.kind).toBe("compiled");
      if (compilation.kind !== "compiled")
        throw new Error("wave96f_default_configuration_not_admitted");
      expect(compilation.evidence.sqlBytes).toBeLessThanOrEqual(
        D1_MAX_SQL_UTF8_BYTES,
      );
      expect(compilation.evidence.bindingCount).toBeLessThanOrEqual(
        D1_MAX_BOUND_PARAMETERS,
      );
      expect(compilation.evidence.groupWidth).toBeLessThanOrEqual(16);
      expect(compilation.evidence.sharedRelationCount).toBeGreaterThan(0);
      expect(
        compilation.evidence.reportSourceRelations.map(({ entity }) => entity),
      ).toEqual(["page", "event"]);
      expect(actualTrace.preparedSql.at(-1)).toBe(compilation.evidence.sql);
      expect(actualTrace.bindings.at(-1)).toEqual(
        compilation.evidence.bindings,
      );
      sqlEvidence.push({
        operation,
        scope,
        configuration,
        dtoEqual: true,
        actualDto: actual,
        legacyDto: legacy.result,
        actualSource: actual.source,
        legacySource: legacy.result.source,
        actualApproximateVisitors: actual.approximateVisitors,
        legacyApproximateVisitors: legacy.result.approximateVisitors,
        sql: compilation.evidence.sql,
        bindings: compilation.evidence.bindings,
        compilationEvidence: compilation.evidence,
        statements: actualTrace.preparedSql.map((sql, index) => ({
          sql,
          bindings: actualTrace.bindings[index],
        })),
        actualQualificationStatements:
          actualQualification.trace.preparedSql.map((sql, index) => ({
            sql,
            bindings: actualQualification.trace.bindings[index],
          })),
        independentLegacyStatements: legacyTrace.preparedSql.map(
          (sql, index) => ({
            sql,
            bindings: legacyTrace.bindings[index],
          }),
        ),
        legacyAdvancedMatches: scopedFilterMetadata(legacy.filters)?.plan
          .preparedMembership,
        reportTime: query.time,
        controlMetadata: {
          reportSources: ["page", "event"],
          controlOutput: "overview-trend-qualification-controls",
          fallbackReason: actualDiagnostics.advancedCountSqlFallbackReason,
        },
      });
    },
  );

  it("keeps Event-only owners when the Page source is empty", async () => {
    const database = createFixture();
    const time = createQueryTime(
      BASE + 180 * 60_000,
      BASE + 190 * 60_000,
      "UTC",
      BASE + 190 * 60_000,
    );
    const query = queryFor("overview", "session", "aggregate", time);
    const actualTrace = traceFor();
    const actual = await createD1SiteProviderRegistry({
      env: testEnv(database, actualTrace),
      siteId: SITE,
    })
      .resolve("overview")!
      .execute(query as CanonicalQuery<"overview">);
    const aggregateQualification = await prepareActualQualification(
      database,
      "overview",
      query,
    );
    const legacyTrace = traceFor();
    const legacy = await legacyOracle(database, "overview", query, legacyTrace);
    expect(actual).toEqual(legacy.result);
    expect(actual.value).toEqual({
      current: {
        views: 0,
        sessions: 1,
        visitors: 1,
        bounces: 0,
        totalDurationMs: 0,
        durationViews: 0,
      },
    });
    const aggregateCompilation = compileOverviewTrendQualificationProgram({
      deferred: aggregateQualification.deferred,
      configuration: { kind: "aggregate" },
    });
    expect(aggregateCompilation.kind).toBe("compiled");
    if (aggregateCompilation.kind !== "compiled")
      throw new Error("wave96f_event_only_aggregate_not_admitted");
    expect(actualTrace.preparedSql.at(-1)).toBe(
      aggregateCompilation.evidence.sql,
    );
    const trendQuery = queryFor("trend", "session", "trend", time);
    const trendTrace = traceFor();
    const actualTrend = await createD1SiteProviderRegistry({
      env: testEnv(database, trendTrace),
      siteId: SITE,
    })
      .resolve("trend")!
      .execute(trendQuery as CanonicalQuery<"trend">);
    const trendQualification = await prepareActualQualification(
      database,
      "trend",
      trendQuery,
    );
    const legacyTrendTrace = traceFor();
    const legacyTrend = await legacyOracle(
      database,
      "trend",
      trendQuery,
      legacyTrendTrace,
    );
    expect(actualTrend).toEqual(legacyTrend.result);
    expect(actualTrend.value).toEqual({
      interval: "hour",
      points: [
        {
          bucket: 0,
          timestampMs: BASE + 3 * HOUR,
          views: 0,
          visitors: 1,
          sessions: 1,
          bounces: 0,
          totalDurationMs: 0,
          durationViews: 0,
        },
      ],
    });
    const trendCompilation = compileOverviewTrendQualificationProgram({
      deferred: trendQualification.deferred,
      configuration: { kind: "trend", interval: "hour" },
    });
    expect(trendCompilation.kind).toBe("compiled");
    if (trendCompilation.kind !== "compiled")
      throw new Error("wave96f_event_only_trend_not_admitted");
    expect(trendTrace.preparedSql.at(-1)).toBe(trendCompilation.evidence.sql);
    sqlEvidence.push({
      operation: "overview",
      scope: "session",
      configuration: { kind: "aggregate", case: "event-only-page-empty" },
      dtoEqual: true,
      actualDto: actual,
      legacyDto: legacy.result,
      actualSource: actual.source,
      legacySource: legacy.result.source,
      actualApproximateVisitors: actual.approximateVisitors,
      legacyApproximateVisitors: legacy.result.approximateVisitors,
      sql: aggregateCompilation.evidence.sql,
      bindings: aggregateCompilation.evidence.bindings,
      compilationEvidence: aggregateCompilation.evidence,
      statements: actualTrace.preparedSql.map((sql, index) => ({
        sql,
        bindings: actualTrace.bindings[index],
      })),
      actualQualificationStatements: aggregateQualification.trace.preparedSql,
      independentLegacyStatements: legacyTrace.preparedSql,
      controlMetadata: {
        reportSources: ["page", "event"],
        controlOutput: "overview-trend-qualification-controls",
      },
      legacyAdvancedMatches: scopedFilterMetadata(legacy.filters)?.plan
        .preparedMembership,
    });
    sqlEvidence.push({
      operation: "trend",
      scope: "session",
      configuration: {
        kind: "trend",
        interval: "hour",
        case: "event-only-page-empty",
      },
      dtoEqual: true,
      actualDto: actualTrend,
      legacyDto: legacyTrend.result,
      actualSource: actualTrend.source,
      legacySource: legacyTrend.result.source,
      actualApproximateVisitors: actualTrend.approximateVisitors,
      legacyApproximateVisitors: legacyTrend.result.approximateVisitors,
      sql: trendCompilation.evidence.sql,
      bindings: trendCompilation.evidence.bindings,
      compilationEvidence: trendCompilation.evidence,
      statements: trendTrace.preparedSql.map((sql, index) => ({
        sql,
        bindings: trendTrace.bindings[index],
      })),
      actualQualificationStatements: trendQualification.trace.preparedSql,
      independentLegacyStatements: legacyTrendTrace.preparedSql,
      controlMetadata: {
        reportSources: ["page", "event"],
        controlOutput: "overview-trend-qualification-controls",
      },
      legacyAdvancedMatches: scopedFilterMetadata(legacyTrend.filters)?.plan
        .preparedMembership,
    });
  });

  it("returns zero aggregate and no trend rows when both sources are empty", async () => {
    const database = createFixture();
    const time = createQueryTime(
      BASE + 8 * HOUR,
      BASE + 9 * HOUR,
      "UTC",
      BASE + 9 * HOUR,
    );
    const aggregateQuery = queryFor("overview", "visitor", "aggregate", time);
    const aggregateTrace = traceFor();
    const aggregate = await createD1SiteProviderRegistry({
      env: testEnv(database, aggregateTrace),
      siteId: SITE,
    })
      .resolve("overview")!
      .execute(aggregateQuery as CanonicalQuery<"overview">);
    const aggregateLegacyTrace = traceFor();
    const aggregateLegacy = await legacyOracle(
      database,
      "overview",
      aggregateQuery,
      aggregateLegacyTrace,
    );
    const trendQuery = queryFor("trend", "visitor", "trend", time);
    const trendTrace = traceFor();
    const trend = await createD1SiteProviderRegistry({
      env: testEnv(database, trendTrace),
      siteId: SITE,
    })
      .resolve("trend")!
      .execute(trendQuery as CanonicalQuery<"trend">);
    const trendLegacyTrace = traceFor();
    const trendLegacy = await legacyOracle(
      database,
      "trend",
      trendQuery,
      trendLegacyTrace,
    );
    expect(aggregate).toEqual(aggregateLegacy.result);
    expect(trend).toEqual(trendLegacy.result);
    expect(aggregate.value).toEqual({
      current: {
        views: 0,
        sessions: 0,
        visitors: 0,
        bounces: 0,
        totalDurationMs: 0,
        durationViews: 0,
      },
    });
    expect(trend.value).toEqual({ interval: "hour", points: [] });
    expect(aggregate.approximateVisitors).toBe(false);
    expect(trend.approximateVisitors).toBe(false);
    sqlEvidence.push(
      {
        operation: "overview",
        scope: "visitor",
        configuration: { kind: "aggregate", case: "both-sources-empty" },
        dtoEqual: true,
        actualDto: aggregate,
        legacyDto: aggregateLegacy.result,
        actualSource: aggregate.source,
        legacySource: aggregateLegacy.result.source,
        actualApproximateVisitors: aggregate.approximateVisitors,
        legacyApproximateVisitors: aggregateLegacy.result.approximateVisitors,
        actualStatements: aggregateTrace.preparedSql.map((sql, index) => ({
          sql,
          bindings: aggregateTrace.bindings[index],
        })),
        independentLegacyStatements: aggregateLegacyTrace.preparedSql.map(
          (sql, index) => ({
            sql,
            bindings: aggregateLegacyTrace.bindings[index],
          }),
        ),
        legacyAdvancedMatches: scopedFilterMetadata(aggregateLegacy.filters)
          ?.plan.preparedMembership,
      },
      {
        operation: "trend",
        scope: "visitor",
        configuration: {
          kind: "trend",
          interval: "hour",
          case: "both-sources-empty",
        },
        dtoEqual: true,
        actualDto: trend,
        legacyDto: trendLegacy.result,
        actualSource: trend.source,
        legacySource: trendLegacy.result.source,
        actualApproximateVisitors: trend.approximateVisitors,
        legacyApproximateVisitors: trendLegacy.result.approximateVisitors,
        actualStatements: trendTrace.preparedSql.map((sql, index) => ({
          sql,
          bindings: trendTrace.bindings[index],
        })),
        independentLegacyStatements: trendLegacyTrace.preparedSql.map(
          (sql, index) => ({
            sql,
            bindings: trendLegacyTrace.bindings[index],
          }),
        ),
        legacyAdvancedMatches: scopedFilterMetadata(trendLegacy.filters)?.plan
          .preparedMembership,
      },
    );
  });

  it("falls back the whole detail request when a Count numeric domain is incompatible", async () => {
    const database = createFixture();
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "alpha-qualified-one");
    const query = queryFor(
      "overview",
      "session",
      "detail",
      WINDOW_TIME,
      'page.path neq "/excluded" and count(page { page.durationMs gt 5 }) eq 1',
    );
    const trace = traceFor();
    const diagnostics = createD1ReadDiagnostics();
    const actual = await createD1SiteProviderRegistry({
      env: testEnv(database, trace),
      siteId: SITE,
      diagnostics,
    })
      .resolve("overview")!
      .execute(query as CanonicalQuery<"overview">);
    const legacyTrace = traceFor();
    const legacy = await legacyOracle(database, "overview", query, legacyTrace);
    expect(actual).toEqual(legacy.result);
    expect(diagnostics.advancedCountSqlFallbackReason).toMatchObject({
      kind: "numeric-data-domain",
      fieldIds: ["page.durationMs"],
    });
    expect(
      (actual.value as { readonly detail?: unknown }).detail,
    ).toBeDefined();
    expect(trace.preparedSql.length).toBeGreaterThan(2);
    sqlEvidence.push({
      operation: "overview",
      scope: "session",
      configuration: { kind: "overview-with-detail", interval: "hour" },
      scenario: "numeric-data-domain-falls-back-whole-detail",
      dtoEqual: true,
      actualDto: actual,
      legacyDto: legacy.result,
      actualSource: actual.source,
      legacySource: legacy.result.source,
      actualApproximateVisitors: actual.approximateVisitors,
      legacyApproximateVisitors: legacy.result.approximateVisitors,
      fallbackReason: diagnostics.advancedCountSqlFallbackReason,
      statements: trace.preparedSql.map((sql, index) => ({
        sql,
        bindings: trace.bindings[index],
      })),
      independentLegacyStatements: legacyTrace.preparedSql.map(
        (sql, index) => ({
          sql,
          bindings: legacyTrace.bindings[index],
        }),
      ),
      legacyAdvancedMatches: scopedFilterMetadata(legacy.filters)?.plan
        .preparedMembership,
    });
  });

  it("binds the deferred brand to its operation and interval snapshot", async () => {
    const database = createFixture();
    const diagnostics = createD1ReadDiagnostics();
    const middleware = d1AdvancedFilterMiddleware(
      testEnv(database, traceFor()),
      diagnostics,
      SITE,
    );
    const overviewQuery = queryFor("overview", "session", "detail");
    const forwardedOverview = await middleware(
      "overview",
      overviewQuery,
      async (prepared) => prepared,
    );
    const deferredOverview = deferredOverviewTrendQualificationFromQuery(
      forwardedOverview,
      "overview",
    );
    expect(deferredOverview?.configuration).toEqual({
      kind: "overview-with-detail",
      interval: "hour",
    });
    expect(() =>
      deferredOverviewTrendQualificationFromQuery(forwardedOverview, "trend"),
    ).toThrow("overview_trend_qualification_request_changed");

    const trendQuery = queryFor("trend", "session", "trend");
    const forwardedTrend = await middleware(
      "trend",
      trendQuery,
      async (prepared) => prepared,
    );
    const deferredTrend = deferredOverviewTrendQualificationFromQuery(
      forwardedTrend,
      "trend",
    );
    expect(deferredTrend?.configuration).toEqual({
      kind: "trend",
      interval: "hour",
    });
    const symbolKey = Reflect.ownKeys(forwardedTrend as object).find(
      (key) => typeof key === "symbol",
    );
    if (typeof symbolKey !== "symbol")
      throw new Error("wave96f_deferred_brand_symbol_missing");
    const branded = forwardedTrend as Record<PropertyKey, unknown>;
    const changedTrend = {
      ...(forwardedTrend as Record<string, unknown>),
      interval: "day",
    };
    Object.defineProperty(changedTrend, symbolKey, {
      value: branded[symbolKey],
      enumerable: false,
    });
    expect(() =>
      deferredOverviewTrendQualificationFromQuery(changedTrend, "trend"),
    ).toThrow("overview_trend_qualification_request_changed");
  });

  it("rejects untrusted or changed compile configurations before D1", async () => {
    const database = createFixture();
    const trend = await prepareActualQualification(
      database,
      "trend",
      queryFor("trend", "session", "trend"),
    );
    const aggregate = await prepareActualQualification(
      database,
      "overview",
      queryFor("overview", "session", "aggregate"),
    );
    const copiedOuter = {
      ...trend.deferred,
    } as typeof trend.deferred;
    const rejectionCases: Array<{
      readonly name: string;
      readonly deferred: typeof trend.deferred;
      readonly configuration: unknown;
    }> = [
      {
        name: "hour trend replaced by day trend",
        deferred: trend.deferred,
        configuration: { kind: "trend", interval: "day" },
      },
      {
        name: "aggregate replaced by aggregate plus detail",
        deferred: aggregate.deferred,
        configuration: { kind: "overview-with-detail", interval: "hour" },
      },
      {
        name: "extra configuration key",
        deferred: trend.deferred,
        configuration: { kind: "trend", interval: "hour", extra: true },
      },
      {
        name: "unknown configuration kind",
        deferred: trend.deferred,
        configuration: { kind: "other" },
      },
      {
        name: "invalid interval",
        deferred: trend.deferred,
        configuration: { kind: "trend", interval: "year" },
      },
      {
        name: "copied outer object retaining the branded inner request",
        deferred: copiedOuter,
        configuration: { kind: "trend", interval: "hour" },
      },
    ];

    for (const testCase of rejectionCases) {
      const configuration =
        testCase.configuration as LegacyOverviewTrendQualificationConfiguration;
      expect(
        () =>
          compileOverviewTrendQualificationProgram({
            deferred: testCase.deferred,
            configuration,
          }),
        testCase.name,
      ).toThrow("overview_trend_qualification_request_untrusted");

      const trace = traceFor();
      await expect(
        executeOverviewTrendQualificationProgram({
          env: testEnv(database, trace),
          deferred: testCase.deferred,
          configuration,
        }),
        testCase.name,
      ).rejects.toThrow("overview_trend_qualification_request_untrusted");
      expect(trace.preparedSql, testCase.name).toEqual([]);
      sqlEvidence.push({
        scenario: "untrusted-qualification-rejected-before-d1",
        case: testCase.name,
        configuration: testCase.configuration,
        outerObject: testCase.name.startsWith("copied outer")
          ? "copied outer; trusted inner brand retained"
          : "request-local branded outer",
        compileRejected: true,
        executeRejected: true,
        preparedStatementCount: trace.preparedSql.length,
      });
    }

    const reorderedConfiguration = Object.freeze({
      interval: "hour",
      kind: "trend",
    }) as LegacyOverviewTrendQualificationConfiguration;
    expect(
      compileOverviewTrendQualificationProgram({
        deferred: trend.deferred,
        configuration: reorderedConfiguration,
      }).kind,
    ).toBe("compiled");
  });

  const malformedControlCases = [
    {
      behavior: "missing-control",
      expectedError: "overview_trend_qualification_control_row_invalid",
    },
    {
      behavior: "duplicate-control",
      expectedError: "overview_trend_qualification_control_row_invalid",
    },
    {
      behavior: "unknown-output",
      expectedError: "overview_trend_qualification_report_row_invalid",
    },
    {
      behavior: "missing-scalar",
      expectedError: "overview_trend_qualification_report_row_invalid",
    },
    {
      behavior: "unknown-row-kind",
      expectedError: "overview_trend_qualification_envelope_kind_invalid",
    },
    {
      behavior: "duplicate-report",
      expectedError: "overview_trend_qualification_report_cardinality_invalid",
    },
  ] as const;

  it.each(malformedControlCases)(
    "rejects $behavior qualification rows without falling back",
    async ({ behavior, expectedError }) => {
      const database = createFixture();
      const trace = traceFor();
      const diagnostics = createD1ReadDiagnostics();
      const provider = createD1SiteProviderRegistry({
        env: testEnvWithBehavior(database, trace, behavior),
        siteId: SITE,
        diagnostics,
      }).resolve("overview");
      if (!provider)
        throw new Error("wave96f_malformed_control_provider_missing");
      await expect(
        provider.execute(
          queryFor(
            "overview",
            "session",
            "aggregate",
          ) as CanonicalQuery<"overview">,
        ),
      ).rejects.toThrow(expectedError);
      expect(trace.preparedSql).toHaveLength(2);
      expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
      sqlEvidence.push({
        operation: "overview",
        scope: "session",
        configuration: { kind: "aggregate" },
        scenario: behavior,
        expectedError,
        rejected: true,
        sql: trace.preparedSql.at(-1),
        bindings: trace.bindings.at(-1),
        controlOutput: "overview-trend-qualification-controls",
        fallbackReason: diagnostics.advancedCountSqlFallbackReason,
      });
    },
  );

  it("propagates database failures and pre/post execution aborts", async () => {
    const database = createFixture();
    const query = queryFor("overview", "session", "aggregate");
    const preAbortTrace = traceFor();
    const preAbortDiagnostics = createD1ReadDiagnostics();
    const preAbortProvider = createD1SiteProviderRegistry({
      env: testEnv(database, preAbortTrace),
      siteId: SITE,
      diagnostics: preAbortDiagnostics,
    }).resolve("overview");
    if (!preAbortProvider)
      throw new Error("wave96f_pre_abort_provider_missing");
    const preAbort = new AbortController();
    preAbort.abort();
    await expect(
      preAbortProvider.execute(query as CanonicalQuery<"overview">, {
        signal: preAbort.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(preAbortTrace.preparedSql).toHaveLength(0);
    expect(preAbortDiagnostics.advancedCountSqlFallbackReason).toBeUndefined();

    const databaseFailureTrace = traceFor();
    const databaseFailureDiagnostics = createD1ReadDiagnostics();
    const databaseFailureProvider = createD1SiteProviderRegistry({
      env: testEnvWithBehavior(
        database,
        databaseFailureTrace,
        "database-error",
      ),
      siteId: SITE,
      diagnostics: databaseFailureDiagnostics,
    }).resolve("overview");
    if (!databaseFailureProvider)
      throw new Error("wave96f_database_failure_provider_missing");
    await expect(
      databaseFailureProvider.execute(query as CanonicalQuery<"overview">),
    ).rejects.toThrow("wave96f_sqlite_report_failure");
    expect(databaseFailureTrace.preparedSql).toHaveLength(2);
    expect(
      databaseFailureDiagnostics.advancedCountSqlFallbackReason,
    ).toBeUndefined();

    const postAbortTrace = traceFor();
    const postAbortDiagnostics = createD1ReadDiagnostics();
    const postAbort = new AbortController();
    const postAbortProvider = createD1SiteProviderRegistry({
      env: testEnvWithBehavior(database, postAbortTrace, "post-abort", {
        controller: postAbort,
      }),
      siteId: SITE,
      diagnostics: postAbortDiagnostics,
    }).resolve("overview");
    if (!postAbortProvider)
      throw new Error("wave96f_post_abort_provider_missing");
    await expect(
      postAbortProvider.execute(query as CanonicalQuery<"overview">, {
        signal: postAbort.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(postAbortTrace.preparedSql).toHaveLength(2);
    expect(postAbortDiagnostics.advancedCountSqlFallbackReason).toBeUndefined();
    sqlEvidence.push(
      {
        operation: "overview",
        scenario: "pre-abort",
        preparedStatementCount: preAbortTrace.preparedSql.length,
        rejection: "AbortError",
        fallbackReason: preAbortDiagnostics.advancedCountSqlFallbackReason,
      },
      {
        operation: "overview",
        scenario: "database-error",
        statements: databaseFailureTrace.preparedSql.map((sql, index) => ({
          sql,
          bindings: databaseFailureTrace.bindings[index],
        })),
        rejection: "wave96f_sqlite_report_failure",
        fallbackReason:
          databaseFailureDiagnostics.advancedCountSqlFallbackReason,
      },
      {
        operation: "overview",
        scenario: "post-abort",
        preparedStatementCount: postAbortTrace.preparedSql.length,
        rejection: "AbortError",
        fallbackReason: postAbortDiagnostics.advancedCountSqlFallbackReason,
      },
    );
  });

  it("gives the 20,001 Count cap priority over numeric-domain fallback", async () => {
    const database = createFixture();
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "alpha-qualified-one");
    const query = queryFor(
      "overview",
      "session",
      "aggregate",
      WINDOW_TIME,
      'page.path neq "/excluded" and count(page { page.durationMs gt 5 }) eq 1',
    );
    const proofForwarded = await d1AdvancedFilterMiddleware(
      testEnv(database, traceFor()),
      undefined,
      SITE,
    )("overview", query, async (prepared) => prepared);
    const proofDeferred = deferredOverviewTrendQualificationFromQuery(
      proofForwarded,
      "overview",
    );
    if (!proofDeferred) throw new Error("wave96f_numeric_cap_deferred_missing");
    const proof = compileOverviewTrendQualificationProgram({
      deferred: proofDeferred,
      configuration: { kind: "aggregate" },
    });
    if (proof.kind !== "compiled")
      throw new Error("wave96f_numeric_cap_compile_missing");
    const numericControlField =
      proof.evidence.compatibilityFields[0]?.outputName;
    if (!numericControlField)
      throw new Error("wave96f_numeric_cap_control_missing");
    const trace = traceFor();
    const diagnostics = createD1ReadDiagnostics();
    const provider = createD1SiteProviderRegistry({
      env: testEnvWithBehavior(
        database,
        trace,
        "activity-cap-and-numeric-domain",
        { numericControlField },
      ),
      siteId: SITE,
      diagnostics,
    }).resolve("overview");
    if (!provider) throw new Error("wave96f_numeric_cap_provider_missing");
    await expect(
      provider.execute(query as CanonicalQuery<"overview">),
    ).rejects.toMatchObject({
      domainError: {
        kind: "invalid-input",
        issues: [{ path: "filters", code: "filter_activity_limit_exceeded" }],
      },
    });
    expect(trace.preparedSql).toHaveLength(2);
    expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
    sqlEvidence.push({
      operation: "overview",
      scope: "session",
      configuration: { kind: "aggregate" },
      scenario: "activity-cap-overrides-numeric-fallback",
      controlOutput: proof.evidence.controlOutputId,
      injectedControl: {
        rawCount: 20_001,
        [numericControlField]: 1,
      },
      rejection: "filter_activity_limit_exceeded",
      fallbackReason: diagnostics.advancedCountSqlFallbackReason,
      sql: trace.preparedSql.at(-1),
      bindings: trace.bindings.at(-1),
    });
  });

  it("captures aggregate and trend native logical/SQL/physical preimages", async () => {
    const database = createFixture();
    const query = queryFor("overview", "session", "aggregate");
    const legacy = await legacyOracle(database, "overview", query, traceFor());
    const filters = legacy.filters;
    const aggregate = buildOverviewAggregatePlan({
      siteId: SITE,
      queryTime: query.time,
      filters,
    });
    const trend = buildOverviewTrendPlan({
      siteId: SITE,
      queryTime: query.time,
      filters,
      interval: "hour",
    });
    const aggregateSnapshot = nativePlanSnapshot(aggregate);
    const trendSnapshot = nativePlanSnapshot(trend);
    nativeEvidence.push(
      {
        kind: "aggregate",
        sourceRevision: "cb4720d7cd24c0dbda81cdef479b5905065c1421",
        preimageSha256: nativePreimageSha256.aggregate,
        sha256: aggregateSnapshot.sha256,
        ...aggregateSnapshot.snapshot,
      },
      {
        kind: "trend",
        sourceRevision: "cb4720d7cd24c0dbda81cdef479b5905065c1421",
        preimageSha256: nativePreimageSha256.trend,
        sha256: trendSnapshot.sha256,
        ...trendSnapshot.snapshot,
      },
    );
    expect(aggregateSnapshot.sha256).toBe(nativePreimageSha256.aggregate);
    expect(trendSnapshot.sha256).toBe(nativePreimageSha256.trend);
    expect(aggregate.outputs[0]?.id).toBe("overview-aggregate");
    expect(trend.outputs[0]?.id).toBe("overview-trend");
  });
});
