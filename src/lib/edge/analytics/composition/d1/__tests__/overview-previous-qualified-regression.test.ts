import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterAll, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import { createD1SiteProviderRegistry } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import { overviewProvider } from "@/lib/edge/analytics/composition/d1/overview";
import {
  type CanonicalQuery,
  createQueryTime,
  prepareScopedQuery,
  type QueryInput,
  type QueryTime,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { ADVANCED_FILTER_MAX_ACTIVITIES } from "@/lib/edge/analytics/engine/advanced-filter-activity-plan";
import type { OverviewPreviousConfiguration } from "@/lib/edge/analytics/engine/overview-previous-qualification-plan";
import { buildOverviewPreviousQualificationPlan } from "@/lib/edge/analytics/engine/overview-previous-qualification-plan";
import {
  d1AdvancedFilterMiddleware,
  type DeferredOverviewTrendQualification,
  deferredOverviewTrendQualificationFromQuery,
  prepareDeferredEventQualificationFallback,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import type { AnalysisResultQualificationBinding } from "@/lib/edge/analytics/providers/d1/internal/lowering/comparison-page-admission";
import {
  compileOverviewPreviousQualificationProgram,
  executeOverviewPreviousQualificationProgram,
} from "@/lib/edge/analytics/providers/d1/internal/overview-previous-qualification-program";
import {
  compileQualificationProgramEnvelope,
  type QualificationEnvelopeImportedGroupedSummaryReference,
} from "@/lib/edge/analytics/providers/d1/internal/qualification-program-envelope";
import { createOverviewReader } from "@/lib/edge/analytics/providers/d1/operations/overview-reader";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";

const SITE_ID = "wave97b-overview-previous";
const BASE = Date.UTC(2024, 0, 1);
const DAY = 24 * 60 * 60 * 1000;
const TIME_ZONE = "America/Los_Angeles";
const CURRENT_TIME = createQueryTime(
  BASE,
  BASE + 21 * DAY,
  TIME_ZONE,
  BASE + 21 * DAY,
);
const PREVIOUS_TIME = createQueryTime(
  BASE - 21 * DAY,
  BASE,
  TIME_ZONE,
  BASE + 21 * DAY,
);
const ORDINARY_FILTER_DSL = 'page.path neq "/excluded"';
const ARTIFACT_DIRECTORY = process.env.WAVE97B_ARTIFACT_DIR?.trim();
const ARTIFACT_PHASE = process.env.WAVE97B_ARTIFACT_PHASE?.trim() || "after";
const databases = new Set<DatabaseSync>();

type Scope = "session" | "visitor";

const AGGREGATE_FIELDS = [
  "views",
  "sessions",
  "visitors",
  "bounces",
  "totalDuration",
  "durationViews",
] as const;
const TREND_FIELDS = [
  "bucket",
  "views",
  "visitors",
  "sessions",
  "bounces",
  "totalDuration",
  "durationViews",
] as const;
const ENVELOPE_REPORT_FIELDS = [
  "bucket",
  "views",
  "visitors",
  "sessions",
  "bounces",
  "totalDuration",
  "durationViews",
] as const;

function trace(): SqliteD1Trace {
  return { preparedSql: [], bindings: [] };
}

function createFixture(): DatabaseSync {
  const database = createMigratedDatabase();
  databases.add(database);
  database.exec("PRAGMA foreign_keys = OFF");
  database
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .run(SITE_ID);
  const identity = database
    .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
    .get(SITE_ID) as { readonly site_pk: number };
  const sitePk = Number(identity.site_pk);
  database
    .prepare(
      `INSERT INTO sites (id, team_id, name, domain, created_at)
       VALUES (?, 'wave97b-team', 'Overview Previous Cohort', 'wave97b.test', 0)`,
    )
    .run(SITE_ID);

  const visits = [
    [
      "shared-current-a1",
      "shared-a",
      "shared-visitor",
      2,
      1000,
      "/shared-current-a1",
    ],
    [
      "shared-current-a2",
      "shared-a",
      "shared-visitor",
      3,
      2000,
      "/shared-current-a2",
    ],
    [
      "current-only",
      "current-only",
      "current-only-visitor",
      5,
      5000,
      "/current-only",
    ],
    [
      "shared-current-b",
      "shared-b",
      "shared-visitor",
      8,
      4000,
      "/shared-current-b",
    ],
    [
      "shared-previous-a",
      "shared-a",
      "shared-visitor",
      -2,
      7000,
      "/shared-previous-a",
    ],
    [
      "shared-previous-a-excluded",
      "shared-a",
      "shared-visitor",
      -1,
      11000,
      "/excluded",
    ],
    [
      "shared-previous-b",
      "shared-b",
      "shared-visitor",
      -10,
      9000,
      "/shared-previous-b",
    ],
    [
      "previous-only",
      "previous-only",
      "previous-only-visitor",
      -3,
      8000,
      "/previous-only",
    ],
  ] as const;
  const insertVisit = database.prepare(
    `INSERT INTO visits (
      visit_id, site_id, site_pk, visitor_id, session_id, status,
      started_at, last_activity_at, duration_ms, pathname, hostname
    ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, ?, 'wave97b.test')`,
  );
  for (const [id, sessionId, visitorId, day, durationMs, path] of visits) {
    const startedAt = BASE + day * DAY;
    insertVisit.run(
      id,
      SITE_ID,
      sitePk,
      visitorId,
      sessionId,
      startedAt,
      startedAt,
      durationMs,
      path,
    );
  }

  const insertEvent = (
    id: string,
    visitId: string,
    name: string,
    day: number,
  ) => {
    const occurredAt = BASE + day * DAY + 1000;
    database
      .prepare(
        `INSERT OR IGNORE INTO custom_event_names (site_id, name, last_seen_at, site_pk)
         VALUES (?, ?, ?, ?)`,
      )
      .run(SITE_ID, name, occurredAt, sitePk);
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
      .run(id, SITE_ID, sitePk, visitId, eventName.id, occurredAt, occurredAt);
  };
  insertEvent("shared-current-qualifier", "shared-current-a1", "qualifier", 2);
  insertEvent("current-only-qualifier", "current-only", "qualifier", 5);
  insertEvent("previous-only-qualifier", "previous-only", "qualifier", -3);
  insertEvent(
    "shared-previous-engagement",
    "shared-previous-b",
    "engagement",
    -10,
  );
  return database;
}

function testEnv(database: DatabaseSync, queryTrace: SqliteD1Trace): Env {
  return {
    DB: createSqliteD1Database(database, queryTrace),
    MAIN_SECRET: "wave97b-overview-previous-test-secret",
  } as unknown as Env;
}

function ordinaryQuery(scope: Scope, includeDetail: boolean) {
  const time = CURRENT_TIME;
  const filters = parseFilterDsl(ORDINARY_FILTER_DSL, analyticsFilterRegistry);
  const prepared = prepareScopedQuery("overview", {
    context: siteQueryContext(SITE_ID, "private-dashboard"),
    time,
    filters,
    scopePreference: scope,
  } as QueryInput & { readonly time: QueryTime });
  return {
    ...prepared,
    time,
    previousTime: PREVIOUS_TIME,
    ...(includeDetail ? { detailInterval: "week" as const } : {}),
  };
}

function qualifiedQuery(
  scope: Scope,
  detailInterval: "week" | "month" | null,
  countEventName = "qualifier",
  includeNumericCount = false,
  timeZone = TIME_ZONE,
) {
  const time =
    timeZone === TIME_ZONE
      ? CURRENT_TIME
      : createQueryTime(
          CURRENT_TIME.range.startMs,
          CURRENT_TIME.range.endExclusiveMs,
          timeZone,
          CURRENT_TIME.capturedAtMs,
        );
  const previousTime =
    timeZone === TIME_ZONE
      ? PREVIOUS_TIME
      : createQueryTime(
          PREVIOUS_TIME.range.startMs,
          PREVIOUS_TIME.range.endExclusiveMs,
          timeZone,
          PREVIOUS_TIME.capturedAtMs,
        );
  const filters = parseFilterDsl(
    `page.path neq "/excluded" and count(event { event.name eq "${countEventName}" }) eq 1${includeNumericCount ? " and count(page { page.durationMs gt 5 }) eq 1" : ""}`,
    analyticsFilterRegistry,
  );
  const prepared = prepareScopedQuery("overview", {
    context: siteQueryContext(SITE_ID, "private-dashboard"),
    time,
    filters,
    scopePreference: scope,
  } as QueryInput & { readonly time: QueryTime });
  return {
    ...prepared,
    time,
    previousTime,
    ...(detailInterval ? { detailInterval } : {}),
  };
}

async function captureDeferredOverview(
  database: DatabaseSync,
  query: ReturnType<typeof qualifiedQuery>,
  execution?: { readonly signal?: AbortSignal },
) {
  const preparationTrace = trace();
  const diagnostics = createD1ReadDiagnostics();
  const env = testEnv(database, preparationTrace);
  let forwarded: CanonicalQuery<"overview"> | undefined;
  let deferred: DeferredOverviewTrendQualification | undefined;
  const middleware = d1AdvancedFilterMiddleware(env, diagnostics, SITE_ID);
  await middleware(
    "overview",
    query,
    (nextInput) => {
      forwarded = nextInput as CanonicalQuery<"overview">;
      deferred = deferredOverviewTrendQualificationFromQuery(
        forwarded,
        "overview",
      );
      return Promise.resolve(undefined);
    },
    execution,
  );
  if (!forwarded || !deferred)
    throw new Error("wave97b_test_deferred_overview_missing");
  const configuration = deferred.configuration;
  if (
    configuration.kind !== "overview-with-previous" &&
    configuration.kind !== "overview-with-previous-and-detail"
  )
    throw new Error("wave97b_test_previous_configuration_missing");
  const compilation = compileOverviewPreviousQualificationProgram({
    query: forwarded,
    deferred,
    configuration,
  });
  if (compilation.kind !== "compiled")
    throw new Error("wave97b_test_previous_compilation_unavailable");
  return {
    env,
    preparationTrace,
    diagnostics,
    forwarded,
    deferred,
    configuration: configuration as OverviewPreviousConfiguration,
    compilation,
  };
}

function compilePreviousWithGroupedReference(
  captured: Awaited<ReturnType<typeof captureDeferredOverview>>,
  badReference: "wrong-child" | "non-aggregate",
) {
  const qualification = buildOverviewPreviousQualificationPlan({
    siteId: captured.deferred.qualification.siteId,
    queryTime: captured.deferred.qualification.requestTime,
    filters: captured.deferred.qualification.filters,
    scopePlan: captured.deferred.qualification.metadata.plan,
    count: captured.deferred.qualification.countInput,
    configuration: captured.configuration,
  });
  const childQualification = qualification.childQualification;
  const childPlan = qualification.plan.nodes.find(
    (node) => node.kind === "analysis-result",
  )?.childPlan;
  if (!childPlan || !Object.isFrozen(childPlan))
    throw new Error("wave97b_test_imported_child_snapshot_not_frozen");
  const parentOutputs = qualification.reportOutputIds.map((outputId) => {
    const output = qualification.plan.outputs.find(
      (candidate) => candidate.id === outputId,
    );
    if (!output) throw new Error("wave97b_test_parent_report_output_missing");
    return output;
  });
  const parentControls = qualification.plan.outputs.find(
    (output) => output.id === qualification.controlOutputId,
  );
  const childControls = childPlan.outputs.find(
    (output) => output.id === childQualification.controlOutputId,
  );
  if (!parentControls || !childControls)
    throw new Error("wave97b_test_controls_output_missing");
  const childReportOutputs = childQualification.reportOutputIds.map(
    (outputId) => {
      const output = childPlan.outputs.find(
        (candidate) => candidate.id === outputId,
      );
      if (!output) throw new Error("wave97b_test_child_report_output_missing");
      return output;
    },
  );
  const childBinding: AnalysisResultQualificationBinding = {
    childPlan,
    reportOutputIds: childQualification.reportOutputIds,
    controlsOutputId: childQualification.controlOutputId,
    policy: {
      primaryReportSourceRelationId:
        childQualification.primaryReportSourceRelationId,
      reportSourceRelations: childQualification.reportSourceRelations,
      reportRelationIds: childReportOutputs.map(({ relation }) => relation),
      controlsRelationId: childControls.relation,
      controlSlots: childControls.fields.map(({ name, slot }) => ({
        name,
        slot,
      })),
      scope: childQualification.scope,
      maximumActivities: ADVANCED_FILTER_MAX_ACTIVITIES,
      numericCompatibilityControlNames:
        childQualification.numericCompatibilityFields.map(
          ({ invalidCountOutput }) => invalidCountOutput,
        ),
    },
  };
  const reference: QualificationEnvelopeImportedGroupedSummaryReference =
    Object.freeze({
      kind: "imported-child",
      childPlan:
        badReference === "wrong-child"
          ? Object.freeze(qualification.plan)
          : childPlan,
      relationId:
        badReference === "wrong-child"
          ? childQualification.groupedSummaryRelationId
          : childQualification.reportSourceRelations[0]!.relationId,
    });
  return compileQualificationProgramEnvelope({
    qualification: {
      plan: qualification.plan,
      primaryReportSourceRelationId:
        qualification.primaryReportSourceRelationId,
      controlsRelationId: parentControls.relation,
      controlOutputId: qualification.controlOutputId,
      numericCompatibilityFields: childQualification.numericCompatibilityFields,
      scope: childQualification.scope,
      reportSourceRelations: qualification.reportSourceRelations,
    },
    siteId: captured.deferred.qualification.siteId,
    reports: parentOutputs.map((output) => ({
      output,
      fields: output.id === "overview-trend" ? TREND_FIELDS : AGGREGATE_FIELDS,
      rowType: output.id === "overview-trend" ? "trend" : "aggregate",
    })),
    controlsOutput: parentControls,
    reportFields: ENVELOPE_REPORT_FIELDS,
    controlFields: parentControls.fields.map(({ name }) => name),
    errorPrefix: "wave97b_grouped_reference_test",
    fallbackTag: "analytics.wave97b_grouped_reference_test",
    signal: captured.deferred.qualification.signal,
    analysisResultQualificationBindings: [childBinding],
    importedGroupedSummaryReference: reference,
  });
}

function adapterEnvForRows(
  env: Env,
  reportSql: string,
  mutate: (
    rows: readonly Record<string, unknown>[],
  ) => readonly Record<string, unknown>[],
): Env {
  const base = env.DB;
  const DB = {
    prepare(sql: string) {
      const prepared = base.prepare(sql);
      if (sql !== reportSql) return prepared;
      return {
        bind(...values: Parameters<typeof prepared.bind>) {
          const bound = prepared.bind(...values);
          return {
            first: bound.first.bind(bound),
            run: bound.run.bind(bound),
            async all() {
              const result = await bound.all();
              return {
                ...result,
                results: mutate(result.results ?? []),
              };
            },
          };
        },
      };
    },
    batch: base.batch.bind(base),
  } as unknown as D1Database;
  return { ...env, DB };
}

function adapterEnvForReportError(
  env: Env,
  reportSql: string,
  error: Error,
): Env {
  const base = env.DB;
  const DB = {
    prepare(sql: string) {
      if (sql === reportSql) throw error;
      return base.prepare(sql);
    },
    batch: base.batch.bind(base),
  } as unknown as D1Database;
  return { ...env, DB };
}

function numericCountQuery(scope: Scope, detailInterval: "week" | "month") {
  const time = CURRENT_TIME;
  const filters = parseFilterDsl(
    'page.path neq "/excluded" and count(page { page.durationMs gt 5 }) eq 1',
    analyticsFilterRegistry,
  );
  const prepared = prepareScopedQuery("overview", {
    context: siteQueryContext(SITE_ID, "private-dashboard"),
    time,
    filters,
    scopePreference: scope,
  } as QueryInput & { readonly time: QueryTime });
  return {
    ...prepared,
    time,
    previousTime: PREVIOUS_TIME,
    detailInterval,
  };
}

function unsupportedPreviousQuery() {
  const time = CURRENT_TIME;
  const filters = parseFilterDsl(
    'page.path eq "/current-only" or count(event { event.name eq "qualifier" }) eq 1',
    analyticsFilterRegistry,
  );
  const prepared = prepareScopedQuery("overview", {
    context: siteQueryContext(SITE_ID, "private-dashboard"),
    time,
    filters,
    scopePreference: "session",
  } as QueryInput & { readonly time: QueryTime });
  return {
    ...prepared,
    time,
    previousTime: PREVIOUS_TIME,
    detailInterval: "week" as const,
  };
}

function writeEvidence(name: string, evidence: unknown): void {
  if (!ARTIFACT_DIRECTORY) return;
  mkdirSync(ARTIFACT_DIRECTORY, { recursive: true });
  writeFileSync(
    join(ARTIFACT_DIRECTORY, `${name}.json`),
    `${JSON.stringify(
      evidence,
      (_key, value: unknown) =>
        typeof value === "number" && !Number.isFinite(value)
          ? Number.isNaN(value)
            ? "NaN"
            : value > 0
              ? "+Infinity"
              : "-Infinity"
          : value,
      2,
    )}\n`,
    { flag: "w" },
  );
}

afterAll(() => {
  for (const database of databases) database.close();
});

describe("Overview previous qualified regression", () => {
  it.each([
    { scope: "session", detail: false },
    { scope: "session", detail: true },
    { scope: "visitor", detail: false },
    { scope: "visitor", detail: true },
  ] as const)(
    "captures the ordinary registry SQL, bindings, and complete DTO baseline (%s, detail=%s)",
    async ({ scope, detail }) => {
      const database = createFixture();
      const queryTrace = trace();
      try {
        const registry = createD1SiteProviderRegistry({
          env: testEnv(database, queryTrace),
          siteId: SITE_ID,
        });
        const provider = registry.resolve("overview");
        if (!provider) throw new Error("wave97b_overview_provider_missing");
        const query = ordinaryQuery(scope, detail);
        const result = await provider.execute(
          query as CanonicalQuery<"overview">,
        );
        expect(result.value).toHaveProperty("current");
        expect(result.value).toHaveProperty("previous");
        if (detail)
          expect(result.value).toHaveProperty("detail.interval", "week");
        else expect(result.value).not.toHaveProperty("detail");
        writeEvidence(
          `ordinary-${ARTIFACT_PHASE}-${scope}-${detail ? "detail" : "aggregate"}`,
          {
            case: `ordinary-${scope}-${detail ? "detail" : "aggregate"}`,
            query: {
              time: CURRENT_TIME,
              previousTime: PREVIOUS_TIME,
              detailInterval: detail ? "week" : null,
              filterDsl: ORDINARY_FILTER_DSL,
              scope,
              timezone: TIME_ZONE,
            },
            fullDto: result,
            sql: queryTrace.preparedSql,
            bindings: queryTrace.bindings,
            sqlBytes: queryTrace.preparedSql.map((statement) =>
              Buffer.byteLength(statement, "utf8"),
            ),
            bindingCounts: queryTrace.bindings.map((values) => values.length),
            statementCount: queryTrace.preparedSql.length,
          },
        );
      } finally {
        database.close();
        databases.delete(database);
      }
    },
  );

  it.each([
    { scope: "session", detailInterval: null, countEventName: "qualifier" },
    { scope: "session", detailInterval: "week", countEventName: "qualifier" },
    { scope: "visitor", detailInterval: null, countEventName: "qualifier" },
    { scope: "visitor", detailInterval: "week", countEventName: "qualifier" },
    { scope: "session", detailInterval: "month", countEventName: "qualifier" },
    { scope: "visitor", detailInterval: "month", countEventName: "qualifier" },
    {
      scope: "session",
      detailInterval: "week",
      countEventName: "qualifier",
      timeZone: "UTC",
    },
    {
      scope: "visitor",
      detailInterval: "month",
      countEventName: "qualifier",
      timeZone: "UTC",
    },
    { scope: "session", detailInterval: null, countEventName: "never-seen" },
    { scope: "visitor", detailInterval: "month", countEventName: "never-seen" },
  ] as const)(
    "executes one previous-cohort report SQL and matches the legacy Count oracle (%s, interval=%s, event=%s)",
    async ({ scope, detailInterval, countEventName, ...options }) => {
      const database = createFixture();
      const queryTrace = trace();
      const diagnostics = createD1ReadDiagnostics();
      const env = testEnv(database, queryTrace);
      const reader = createOverviewReader(env, SITE_ID, diagnostics);
      const middleware = d1AdvancedFilterMiddleware(env, diagnostics, SITE_ID);
      let forwarded: CanonicalQuery<"overview"> | undefined;
      let deferred: DeferredOverviewTrendQualification | undefined;
      const registry = new AnalyticsProviderRegistry()
        .register(
          "overview",
          overviewProvider(reader, { env, siteId: SITE_ID, diagnostics }),
        )
        .useMiddleware((operation, input, next, execution) =>
          middleware(
            operation,
            input,
            (nextInput) => {
              forwarded = nextInput as CanonicalQuery<"overview">;
              deferred = deferredOverviewTrendQualificationFromQuery(
                forwarded,
                "overview",
              );
              return next(nextInput);
            },
            execution,
          ),
        );
      try {
        const provider = registry.resolve("overview");
        if (!provider)
          throw new Error("wave97b_qualified_overview_provider_missing");
        const timeZone = "timeZone" in options ? options.timeZone : TIME_ZONE;
        const query = qualifiedQuery(
          scope,
          detailInterval,
          countEventName,
          false,
          timeZone,
        );
        const result = await provider.execute(
          query as CanonicalQuery<"overview">,
        );
        expect(deferred).toBeDefined();
        if (!deferred || !forwarded)
          throw new Error("wave97b_deferred_overview_missing");
        const configuration = deferred.configuration;
        const hasDetail = detailInterval !== null;
        expect(configuration.kind).toBe(
          hasDetail
            ? "overview-with-previous-and-detail"
            : "overview-with-previous",
        );
        if (
          configuration.kind !== "overview-with-previous" &&
          configuration.kind !== "overview-with-previous-and-detail"
        )
          throw new Error("wave97b_previous_overview_configuration_missing");

        const compilation = compileOverviewPreviousQualificationProgram({
          query: forwarded,
          deferred,
          configuration,
        });
        expect(compilation.kind).toBe("compiled");
        if (compilation.kind !== "compiled")
          throw new Error("wave97b_previous_overview_not_compiled");
        expect(compilation.evidence.sqlBytes).toBeLessThanOrEqual(100_000);
        expect(compilation.evidence.bindingCount).toBeLessThanOrEqual(100);
        expect(compilation.evidence.groupWidth).toBeGreaterThan(0);
        expect(compilation.evidence.groupWidth).toBeLessThanOrEqual(16);
        expect(compilation.evidence.sharedRelationCount).toBeGreaterThan(0);
        const importedOutputs = compilation.evidence.logicalPlan.nodes.filter(
          (node) => node.kind === "analysis-result",
        );
        expect(importedOutputs.length).toBeGreaterThan(1);
        expect(
          new Set(importedOutputs.map((node) => node.childPlan)).size,
        ).toBe(1);
        const childPlan = importedOutputs[0]?.childPlan;
        if (!childPlan)
          throw new Error("wave97b_grouped_proof_child_plan_missing");
        expect(Object.isFrozen(childPlan)).toBe(true);
        const groupedLogicalNode = childPlan.nodes.find(
          (node) =>
            node.id === compilation.evidence.groupedSummaryProof.relationId,
        );
        expect(groupedLogicalNode).toMatchObject({
          kind: "aggregate",
          groups: expect.arrayContaining([
            expect.anything(),
            expect.anything(),
          ]),
        });
        expect(compilation.evidence.groupedSummaryProof).toMatchObject({
          source: "imported-child",
          nodeKind: "aggregate",
          groupKeyCount: 2,
          fieldCount: compilation.evidence.groupWidth,
          matchingSharedRelationCount: 1,
          materialization: "materialized",
        });
        expect(
          compilation.evidence.groupedSummaryProof.sharedRelations.filter(
            ({ sameNode }) => sameNode,
          ),
        ).toHaveLength(1);
        expect(
          compilation.evidence.outputDescriptors.some(
            ({ outputId }) => outputId === "overview-current-cohort",
          ),
        ).toBe(false);
        const bindingText = compilation.evidence.bindings
          .filter((value): value is string => typeof value === "string")
          .join("\n");
        expect(bindingText).not.toContain("shared-a");
        expect(bindingText).not.toContain("shared-visitor");
        expect(queryTrace.preparedSql.at(-1)).toBe(compilation.evidence.sql);
        expect(queryTrace.bindings.at(-1)).toEqual(
          compilation.evidence.bindings,
        );
        expect(
          queryTrace.preparedSql.filter(
            (sql) => sql === compilation.evidence.sql,
          ),
        ).toHaveLength(1);

        const fallbackFilters = await prepareDeferredEventQualificationFallback(
          deferred.qualification,
        );
        const legacyTrace = trace();
        const legacyReader = createOverviewReader(
          testEnv(database, legacyTrace),
          SITE_ID,
          createD1ReadDiagnostics(),
        );
        const current = await legacyReader.readOverview({
          time: forwarded.time,
          filters: fallbackFilters,
        });
        const previous = await legacyReader.readOverview({
          time: forwarded.previousTime!,
          filters: fallbackFilters,
        });
        const legacyDetail = detailInterval
          ? await legacyReader.readTrend({
              time: forwarded.time,
              filters: fallbackFilters,
              interval: detailInterval,
            })
          : undefined;
        expect(result.value).toEqual({
          current: current.value,
          previous: previous.value,
          ...(legacyDetail
            ? {
                detail: {
                  interval: detailInterval,
                  points: legacyDetail.value,
                },
              }
            : {}),
        });
        if (countEventName === "never-seen") {
          expect(result.value).toMatchObject({
            current: {
              views: 0,
              sessions: 0,
              visitors: 0,
              bounces: 0,
              totalDurationMs: 0,
              durationViews: 0,
            },
            previous: {
              views: 0,
              sessions: 0,
              visitors: 0,
              bounces: 0,
              totalDurationMs: 0,
              durationViews: 0,
            },
          });
          if (detailInterval)
            expect(result.value).toHaveProperty("detail.points", []);
        }
        expect(result.source).toBe("raw");
        expect(result.approximateVisitors).toBe(false);
        expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();

        const deferredSymbol = Reflect.ownKeys(forwarded).find(
          (key) => typeof key === "symbol",
        );
        if (deferredSymbol === undefined)
          throw new Error("wave97b_overview_brand_missing");
        const clonedQuery = { ...forwarded } as Record<PropertyKey, unknown>;
        Object.defineProperty(clonedQuery, deferredSymbol, {
          value: deferred,
          enumerable: false,
        });
        expect(() =>
          deferredOverviewTrendQualificationFromQuery(clonedQuery, "overview"),
        ).toThrow("overview_trend_qualification_request_changed");
        const originalPreviousTime = Object.getOwnPropertyDescriptor(
          forwarded,
          "previousTime",
        );
        Object.defineProperty(forwarded, "previousTime", {
          value: createQueryTime(
            PREVIOUS_TIME.range.startMs,
            PREVIOUS_TIME.range.endExclusiveMs - 1,
            TIME_ZONE,
            PREVIOUS_TIME.capturedAtMs,
          ),
          enumerable: true,
          configurable: true,
          writable: true,
        });
        expect(() =>
          deferredOverviewTrendQualificationFromQuery(forwarded, "overview"),
        ).toThrow("overview_trend_qualification_request_changed");
        if (!originalPreviousTime)
          throw new Error("wave97b_previous_time_descriptor_missing");
        Object.defineProperty(forwarded, "previousTime", originalPreviousTime);
        if (detailInterval) {
          const originalInterval = Object.getOwnPropertyDescriptor(
            forwarded,
            "detailInterval",
          );
          Object.defineProperty(forwarded, "detailInterval", {
            value: detailInterval === "week" ? "month" : "week",
            enumerable: true,
            configurable: true,
            writable: true,
          });
          expect(() =>
            deferredOverviewTrendQualificationFromQuery(forwarded, "overview"),
          ).toThrow("overview_trend_qualification_request_changed");
          if (!originalInterval)
            throw new Error("wave97b_detail_interval_descriptor_missing");
          Object.defineProperty(forwarded, "detailInterval", originalInterval);
        }
        let accessorReads = 0;
        const accessorQuery = { ...forwarded } as Record<PropertyKey, unknown>;
        Object.defineProperty(accessorQuery, deferredSymbol, {
          value: deferred,
          enumerable: false,
        });
        Object.defineProperty(accessorQuery, "previousTime", {
          get() {
            accessorReads += 1;
            throw new Error("previousTime getter must stay inert");
          },
          enumerable: true,
        });
        expect(() =>
          deferredOverviewTrendQualificationFromQuery(
            accessorQuery,
            "overview",
          ),
        ).toThrow("overview_trend_qualification_request_changed");
        expect(accessorReads).toBe(0);
        const hostileConfiguration = { ...configuration };
        Object.defineProperty(hostileConfiguration, "toJSON", {
          get() {
            accessorReads += 1;
            throw new Error("configuration toJSON getter must stay inert");
          },
          enumerable: true,
        });
        Object.freeze(hostileConfiguration);
        expect(() =>
          compileOverviewPreviousQualificationProgram({
            query: forwarded!,
            deferred: deferred!,
            configuration:
              hostileConfiguration as unknown as typeof configuration,
          }),
        ).toThrow("overview_previous_qualification_request_untrusted");
        expect(accessorReads).toBe(0);

        writeEvidence(
          `qualified-${scope}-${detailInterval ?? "aggregate"}-${countEventName}-${timeZone === "UTC" ? "utc" : "la"}`,
          {
            case: `qualified-${scope}-${detailInterval ?? "aggregate"}-${countEventName}`,
            queryTime: {
              current: forwarded.time,
              previous: forwarded.previousTime,
              timeZone,
            },
            reportSql: compilation.evidence.sql,
            bindings: compilation.evidence.bindings,
            sqlBytes: compilation.evidence.sqlBytes,
            bindingCount: compilation.evidence.bindingCount,
            groupWidth: compilation.evidence.groupWidth,
            groupedSummaryProof: compilation.evidence.groupedSummaryProof,
            sharedRelationCount: compilation.evidence.sharedRelationCount,
            dto: result,
            legacyOracle: {
              current: current.value,
              previous: previous.value,
              ...(legacyDetail
                ? {
                    detail: {
                      interval: detailInterval,
                      points: legacyDetail.value,
                    },
                  }
                : {}),
            },
            countFallback: diagnostics.advancedCountSqlFallbackReason ?? null,
            statementCount: queryTrace.preparedSql.length,
            scope,
          },
        );
      } finally {
        database.close();
        databases.delete(database);
      }
    },
  );

  it.each([
    { reference: "wrong-child", expectedNodeKind: null },
    { reference: "non-aggregate", expectedNodeKind: "semi-join" },
  ] as const)(
    "rejects a %s grouped reference before compiling SQL",
    async ({ reference, expectedNodeKind }) => {
      const database = createFixture();
      try {
        const captured = await captureDeferredOverview(
          database,
          qualifiedQuery("session", null),
        );
        const compilation = compilePreviousWithGroupedReference(
          captured,
          reference,
        );
        expect(compilation.kind).toBe("unavailable");
        if (compilation.kind !== "unavailable")
          throw new Error("wave97b_invalid_grouped_reference_compiled");
        expect(compilation.fallbackReason).toMatchObject({
          kind: "grouped-summary-unavailable",
        });
        expect(
          compilation.admissionEvidence?.groupedSummaryProof,
        ).toMatchObject({
          source: "imported-child",
          nodeKind: expectedNodeKind,
        });
        if (reference === "wrong-child")
          expect(compilation.admissionEvidence?.groupWidth).toBeNull();
        else
          expect(compilation.admissionEvidence?.groupWidth).toBeGreaterThan(0);
        expect(captured.preparationTrace.preparedSql).not.toContain(
          captured.compilation.evidence.sql,
        );
      } finally {
        database.close();
        databases.delete(database);
      }
    },
  );

  it.each([
    {
      name: "missing control",
      error: "overview_previous_qualification_control_row_invalid",
      mutate: (rows: readonly Record<string, unknown>[]) =>
        rows.filter((row) => row.rowKind !== "control"),
    },
    {
      name: "duplicate control",
      error: "overview_previous_qualification_control_row_invalid",
      mutate: (rows: readonly Record<string, unknown>[]) => [
        ...rows,
        { ...rows.find((row) => row.rowKind === "control")! },
      ],
    },
    {
      name: "unknown row kind",
      error: "overview_previous_qualification_control_row_invalid",
      mutate: (rows: readonly Record<string, unknown>[]) =>
        rows.map((row) =>
          row.rowKind === "control" ? { ...row, rowKind: "unknown" } : row,
        ),
    },
    {
      name: "malformed raw count",
      error: "overview_previous_qualification_control_invalid:rawCount",
      mutate: (rows: readonly Record<string, unknown>[]) =>
        rows.map((row) =>
          row.rowKind === "control" ? { ...row, rawCount: "invalid" } : row,
        ),
    },
    {
      name: "missing report rows",
      error: "overview_previous_qualification_report_cardinality_invalid",
      mutate: (rows: readonly Record<string, unknown>[]) =>
        rows.filter((row) => row.rowKind === "control"),
    },
  ] as const)("rejects malformed compiled protocol: %s", async (testCase) => {
    const database = createFixture();
    try {
      const captured = await captureDeferredOverview(
        database,
        qualifiedQuery("session", null),
      );
      const env = adapterEnvForRows(
        captured.env,
        captured.compilation.evidence.sql,
        testCase.mutate,
      );
      await expect(
        executeOverviewPreviousQualificationProgram({
          env,
          query: captured.forwarded,
          deferred: captured.deferred,
          configuration: captured.configuration,
          diagnostics: captured.diagnostics,
        }),
      ).rejects.toThrow(testCase.error);
    } finally {
      database.close();
      databases.delete(database);
    }
  });

  it("falls back to the legacy evaluator when mixed OR filters cannot share one previous cohort", async () => {
    const database = createFixture();
    const query = unsupportedPreviousQuery();
    const queryTrace = trace();
    const diagnostics = createD1ReadDiagnostics();
    const env = testEnv(database, queryTrace);
    const reader = createOverviewReader(env, SITE_ID, diagnostics);
    const middleware = d1AdvancedFilterMiddleware(env, diagnostics, SITE_ID);
    let forwarded: CanonicalQuery<"overview"> | undefined;
    let deferred: DeferredOverviewTrendQualification | undefined;
    const registry = new AnalyticsProviderRegistry()
      .register(
        "overview",
        overviewProvider(reader, { env, siteId: SITE_ID, diagnostics }),
      )
      .useMiddleware((operation, input, next, execution) =>
        middleware(
          operation,
          input,
          (nextInput) => {
            forwarded = nextInput as CanonicalQuery<"overview">;
            deferred = deferredOverviewTrendQualificationFromQuery(
              forwarded,
              "overview",
            );
            return next(nextInput);
          },
          execution,
        ),
      );
    try {
      const provider = registry.resolve("overview");
      if (!provider) throw new Error("wave97b_unsupported_provider_missing");
      const actual = await provider.execute(
        query as CanonicalQuery<"overview">,
      );
      expect(deferred).toBeUndefined();
      if (!forwarded)
        throw new Error("wave97b_unsupported_forwarded_query_missing");
      const filters = forwarded.filters;
      if (!filters) throw new Error("wave97b_unsupported_filters_missing");
      const legacyReader = createOverviewReader(
        testEnv(database, trace()),
        SITE_ID,
        createD1ReadDiagnostics(),
      );
      const current = await legacyReader.readOverview({
        time: forwarded.time,
        filters,
      });
      const previous = await legacyReader.readOverview({
        time: forwarded.previousTime!,
        filters,
      });
      const detail = await legacyReader.readTrend({
        time: forwarded.time,
        filters,
        interval: "week",
      });
      expect(actual.value).toEqual({
        current: current.value,
        previous: previous.value,
        detail: { interval: "week", points: detail.value },
      });
      expect(
        queryTrace.preparedSql.filter((sql) =>
          sql.includes("overview-current-aggregate"),
        ),
      ).toHaveLength(0);
    } finally {
      database.close();
      databases.delete(database);
    }
  });

  it("enforces the raw Count cap before numeric fallback and report admission", async () => {
    const database = createFixture();
    try {
      const captured = await captureDeferredOverview(
        database,
        numericCountQuery("session", "week"),
      );
      const env = adapterEnvForRows(
        captured.env,
        captured.compilation.evidence.sql,
        (rows) =>
          rows.map((row) =>
            row.rowKind === "control" ? { ...row, rawCount: 20_001 } : row,
          ),
      );
      await expect(
        executeOverviewPreviousQualificationProgram({
          env,
          query: captured.forwarded,
          deferred: captured.deferred,
          configuration: captured.configuration,
        }),
      ).rejects.toMatchObject({
        domainError: {
          issues: [{ path: "filters", code: "filter_activity_limit_exceeded" }],
        },
      });
    } finally {
      database.close();
      databases.delete(database);
    }
  });

  it("rejects numeric fallback controls when report rows escaped the Count gate", async () => {
    const database = createFixture();
    try {
      const captured = await captureDeferredOverview(
        database,
        numericCountQuery("session", "week"),
      );
      const numericControl =
        captured.compilation.evidence.compatibilityFields[0];
      if (!numericControl) throw new Error("wave97b_numeric_control_missing");
      const env = adapterEnvForRows(
        captured.env,
        captured.compilation.evidence.sql,
        (rows) =>
          rows.map((row) =>
            row.rowKind === "control"
              ? { ...row, [numericControl.outputName]: 1 }
              : row,
          ),
      );
      await expect(
        executeOverviewPreviousQualificationProgram({
          env,
          query: captured.forwarded,
          deferred: captured.deferred,
          configuration: captured.configuration,
        }),
      ).rejects.toThrow("overview_previous_qualification_gate_violation");
    } finally {
      database.close();
      databases.delete(database);
    }
  });

  it("propagates D1 failures and observes cancellation before preparing the report", async () => {
    const database = createFixture();
    try {
      const captured = await captureDeferredOverview(
        database,
        qualifiedQuery("visitor", "week"),
      );
      const failure = new Error("wave97b_report_read_failed");
      const failingEnv = adapterEnvForReportError(
        captured.env,
        captured.compilation.evidence.sql,
        failure,
      );
      await expect(
        executeOverviewPreviousQualificationProgram({
          env: failingEnv,
          query: captured.forwarded,
          deferred: captured.deferred,
          configuration: captured.configuration,
        }),
      ).rejects.toBe(failure);

      const abort = new AbortController();
      const aborted = await captureDeferredOverview(
        database,
        qualifiedQuery("visitor", "week"),
        { signal: abort.signal },
      );
      abort.abort();
      const beforeReport = aborted.preparationTrace.preparedSql.length;
      await expect(
        executeOverviewPreviousQualificationProgram({
          env: aborted.env,
          query: aborted.forwarded,
          deferred: aborted.deferred,
          configuration: aborted.configuration,
        }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(aborted.preparationTrace.preparedSql).toHaveLength(beforeReport);
      expect(aborted.preparationTrace.preparedSql).not.toContain(
        aborted.compilation.evidence.sql,
      );
    } finally {
      database.close();
      databases.delete(database);
    }
  });

  it("matches the legacy oracle with SQLite reverse_unordered_selects enabled", async () => {
    const database = createFixture();
    database.exec("PRAGMA reverse_unordered_selects = ON");
    try {
      const captured = await captureDeferredOverview(
        database,
        qualifiedQuery("visitor", "month"),
      );
      const reader = createOverviewReader(
        captured.env,
        SITE_ID,
        captured.diagnostics,
      );
      const actual = await overviewProvider(reader, {
        env: captured.env,
        siteId: SITE_ID,
        diagnostics: captured.diagnostics,
      }).execute(captured.forwarded);
      const filters = await prepareDeferredEventQualificationFallback(
        captured.deferred.qualification,
      );
      const legacyReader = createOverviewReader(
        testEnv(database, trace()),
        SITE_ID,
        createD1ReadDiagnostics(),
      );
      const current = await legacyReader.readOverview({
        time: captured.forwarded.time,
        filters,
      });
      const previous = await legacyReader.readOverview({
        time: captured.forwarded.previousTime!,
        filters,
      });
      const detail = await legacyReader.readTrend({
        time: captured.forwarded.time,
        filters,
        interval: "month",
      });
      expect(actual.value).toEqual({
        current: current.value,
        previous: previous.value,
        detail: { interval: "month", points: detail.value },
      });
    } finally {
      database.exec("PRAGMA reverse_unordered_selects = OFF");
      database.close();
      databases.delete(database);
    }
  });

  it("falls back the whole previous-time request once for an incompatible numeric Count domain", async () => {
    const database = createFixture();
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "current-only");
    const query = numericCountQuery("session", "week");
    const queryTrace = trace();
    const diagnostics = createD1ReadDiagnostics();
    const env = testEnv(database, queryTrace);
    const reader = createOverviewReader(env, SITE_ID, diagnostics);
    const middleware = d1AdvancedFilterMiddleware(env, diagnostics, SITE_ID);
    let deferred: DeferredOverviewTrendQualification | undefined;
    const registry = new AnalyticsProviderRegistry()
      .register(
        "overview",
        overviewProvider(reader, { env, siteId: SITE_ID, diagnostics }),
      )
      .useMiddleware((operation, input, next, execution) =>
        middleware(
          operation,
          input,
          (nextInput) => {
            deferred = deferredOverviewTrendQualificationFromQuery(
              nextInput as CanonicalQuery<"overview">,
              "overview",
            );
            return next(nextInput);
          },
          execution,
        ),
      );
    try {
      const provider = registry.resolve("overview");
      if (!provider) throw new Error("wave97b_numeric_provider_missing");
      const actual = await provider.execute(
        query as CanonicalQuery<"overview">,
      );
      expect(deferred).toBeDefined();
      expect(diagnostics.advancedCountSqlFallbackReason).toEqual({
        kind: "numeric-data-domain",
        fieldIds: ["page.durationMs"],
      });
      if (!deferred) throw new Error("wave97b_numeric_deferred_missing");
      const filters = await prepareDeferredEventQualificationFallback(
        deferred.qualification,
      );
      const legacyReader = createOverviewReader(
        testEnv(database, trace()),
        SITE_ID,
        createD1ReadDiagnostics(),
      );
      const current = await legacyReader.readOverview({
        time: query.time,
        filters,
      });
      const previous = await legacyReader.readOverview({
        time: query.previousTime!,
        filters,
      });
      const detail = await legacyReader.readTrend({
        time: query.time,
        filters,
        interval: "week",
      });
      expect(actual.value).toEqual({
        current: current.value,
        previous: previous.value,
        detail: { interval: "week", points: detail.value },
      });
      expect(queryTrace.preparedSql.length).toBeGreaterThan(1);
      expect(
        queryTrace.preparedSql.filter((sql) =>
          sql.includes("overview-current-aggregate"),
        ),
      ).toHaveLength(1);
    } finally {
      database.close();
      databases.delete(database);
    }
  });

  it("records finite REAL SUM overflow against the legacy previous-time oracle", async () => {
    const database = createFixture();
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id IN (?, ?)")
      .run(1.7e308, "shared-current-a1", "shared-current-a2");
    const query = qualifiedQuery("session", "week");
    try {
      const captured = await captureDeferredOverview(database, query);
      const filters = await prepareDeferredEventQualificationFallback(
        captured.deferred.qualification,
      );
      const legacyReader = createOverviewReader(
        testEnv(database, trace()),
        SITE_ID,
        createD1ReadDiagnostics(),
      );
      const current = await legacyReader.readOverview({
        time: captured.forwarded.time,
        filters,
      });
      const previous = await legacyReader.readOverview({
        time: captured.forwarded.previousTime!,
        filters,
      });
      const detail = await legacyReader.readTrend({
        time: captured.forwarded.time,
        filters,
        interval: "week",
      });
      const raw = database
        .prepare(
          `SELECT COUNT(*) AS page_count,
                  COUNT(DISTINCT session_id) AS session_count,
                  SUM(duration_ms) AS raw_sum,
                  typeof(SUM(duration_ms)) AS raw_type
           FROM visits
           WHERE visit_id IN (?, ?)
             AND session_id = (SELECT session_id FROM visits WHERE visit_id = ?)`,
        )
        .get("shared-current-a1", "shared-current-a2", "shared-current-a1") as {
        readonly page_count: number;
        readonly session_count: number;
        readonly raw_sum: number;
        readonly raw_type: string;
      };
      const qualifiedEvents = database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM custom_events AS event
           JOIN custom_event_names AS name ON name.id = event.event_name_id
           WHERE event.visit_id = ? AND name.name = 'qualifier'`,
        )
        .get("shared-current-a1") as { readonly count: number };
      const reader = createOverviewReader(
        captured.env,
        SITE_ID,
        captured.diagnostics,
      );
      const actual = await overviewProvider(reader, {
        env: captured.env,
        siteId: SITE_ID,
        diagnostics: captured.diagnostics,
      }).execute(captured.forwarded);
      const legacy = {
        value: {
          current: current.value,
          previous: previous.value,
          detail: { interval: "week", points: detail.value },
        },
        source: "raw" as const,
        approximateVisitors: false,
      };
      const rawEvidence = {
        pageCount: raw.page_count,
        sessionCount: raw.session_count,
        rawSum: Number.isFinite(raw.raw_sum)
          ? raw.raw_sum
          : raw.raw_sum > 0
            ? "+Infinity"
            : "-Infinity",
        sqlType: raw.raw_type,
        isPositiveInfinity: raw.raw_sum === Number.POSITIVE_INFINITY,
        qualifiedEventsForSharedCurrentPage: qualifiedEvents.count,
      };
      writeEvidence("numeric-overflow-green", {
        reportSql: captured.compilation.evidence.sql,
        bindings: captured.compilation.evidence.bindings,
        rawAggregate: rawEvidence,
        legacyDto: legacy,
        newPathDto: actual,
        previousRedRunError:
          "overview_previous_qualification_value_invalid:totalDuration",
      });
      expect(rawEvidence).toMatchObject({
        pageCount: 2,
        sessionCount: 1,
        rawSum: "+Infinity",
        sqlType: "real",
        isPositiveInfinity: true,
        qualifiedEventsForSharedCurrentPage: 1,
      });
      expect(current.value.totalDurationMs).toBe(Number.POSITIVE_INFINITY);
      expect(Number.isFinite(previous.value.totalDurationMs)).toBe(true);
      expect(
        detail.value.some(
          (point) => point.totalDurationMs === Number.POSITIVE_INFINITY,
        ),
      ).toBe(true);
      expect(actual).toEqual(legacy);
      expect(actual.source).toBe("raw");
      expect(captured.preparationTrace.preparedSql).toContain(
        captured.compilation.evidence.sql,
      );
    } finally {
      database.close();
      databases.delete(database);
    }
  });
});
