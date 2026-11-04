import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterAll, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  compileD1Query,
  D1_MAX_BOUND_PARAMETERS,
  D1_MAX_SQL_UTF8_BYTES,
} from "@/lib/db";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import {
  prepareScopedQuery,
  type QueryInput,
  type QueryTime,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { createQueryTime } from "@/lib/edge/analytics/contract/helpers";
import { EVENT_QUALIFICATION_CONTROL_OUTPUT } from "@/lib/edge/analytics/engine/event-qualified-source-plan";
import { buildEventTypeDetailQualificationPlan } from "@/lib/edge/analytics/engine/event-type-detail-plan";
import { EVENT_TYPE_OVERVIEW_OUTPUTS } from "@/lib/edge/analytics/engine/event-type-overview-plan";
import { LogicalPlanBuilder } from "@/lib/edge/analytics/engine/logical/builder";
import {
  d1AdvancedFilterMiddleware,
  deferredEventTypeDetailQualificationFromQuery,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import {
  compileEventTypeDetailQualificationProgram,
  executeEventTypeDetailQualificationProgram,
} from "@/lib/edge/analytics/providers/d1/internal/analytics-qualification-program";
import { AnalyticsLogicalToDbLowerer } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import type { AnalyticsQualificationAdmissionPolicy } from "@/lib/edge/analytics/providers/d1/internal/lowering/event-summary-admission";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import type { FilterDocument } from "@/lib/filter-contract/filters";

const SITE_ID = "wave94h-event-type-detail";
const WINDOW = {
  startMs: Date.UTC(2026, 0, 1, 8),
  endExclusiveMs: Date.UTC(2026, 0, 4, 8),
  nowMs: Date.UTC(2026, 0, 5, 8),
  timeZone: "America/Los_Angeles",
} as const;
const QUERY_TIME = createQueryTime(
  WINDOW.startMs,
  WINDOW.endExclusiveMs,
  WINDOW.timeZone,
  WINDOW.nowMs,
);
const databases = new Set<DatabaseSync>();
const evidence: unknown[] = [];

interface PreparedDetailQuery extends QueryInput {
  readonly filters: FilterDocument;
  readonly time: QueryTime;
  readonly eventName: string;
  readonly interval: "day";
  readonly includeBreakdowns?: boolean;
  readonly includeContext?: boolean;
}

function newTrace(): SqliteD1Trace {
  return { preparedSql: [], bindings: [] };
}

function testEnv(database: DatabaseSync, trace: SqliteD1Trace): Env {
  return {
    DB: createSqliteD1Database(database, trace),
    MAIN_SECRET: "wave94h-event-type-detail-qualified-test-secret",
  } as unknown as Env;
}

function testEnvWithResultMutation(
  database: DatabaseSync,
  trace: SqliteD1Trace,
  mutateRows: (
    rows: readonly Record<string, unknown>[],
  ) => readonly Record<string, unknown>[],
): Env {
  const adapter = createSqliteD1Database(database, trace);
  const DB = {
    ...adapter,
    prepare(sql: string) {
      const statement = adapter.prepare(sql);
      const wrapped = {
        ...statement,
        bind(...values: Parameters<typeof statement.bind>) {
          statement.bind(...values);
          return this;
        },
        async all<Row>() {
          const result = await statement.all<Row>();
          const rows = Array.isArray(result.results) ? result.results : [];
          return {
            ...result,
            results: mutateRows(
              rows as unknown as readonly Record<string, unknown>[],
            ) as Row[],
          };
        },
      };
      return wrapped as unknown as D1PreparedStatement;
    },
  };
  return {
    DB,
    MAIN_SECRET: "wave94h-event-type-detail-qualified-test-secret",
  } as unknown as Env;
}

function createFixture(): DatabaseSync {
  const database = createMigratedDatabase();
  databases.add(database);
  database.exec("PRAGMA foreign_keys = OFF");
  database
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .run(SITE_ID);
  database
    .prepare(
      `INSERT INTO sites (id, team_id, name, domain, created_at)
       VALUES (?, ?, ?, ?, 0)`,
    )
    .run(SITE_ID, "wave94h-team", "Event type detail", "detail.test");
  return database;
}

function prepareQuery(input: {
  readonly scope: "session" | "visitor";
  readonly includeBreakdowns?: boolean;
  readonly includeContext?: boolean;
}): PreparedDetailQuery {
  const filters = parseFilterDsl(
    'count(page { page.path eq "/scoped" }) eq 1',
    analyticsFilterRegistry,
  );
  const prepared = prepareScopedQuery("event-type-detail", {
    context: siteQueryContext(SITE_ID, "private-dashboard"),
    time: QUERY_TIME,
    filters,
    scopePreference: input.scope,
  } as QueryInput & { readonly time: QueryTime }) as QueryInput & {
    readonly filters?: FilterDocument;
    readonly time?: QueryTime;
  };
  if (!prepared.filters || !prepared.time)
    throw new Error("wave94h_event_type_detail_preparation_failed");
  return {
    ...prepared,
    filters: prepared.filters,
    time: prepared.time,
    eventName: "purchase",
    interval: "day",
    ...(input.includeBreakdowns !== undefined
      ? { includeBreakdowns: input.includeBreakdowns }
      : {}),
    ...(input.includeContext !== undefined
      ? { includeContext: input.includeContext }
      : {}),
  } as PreparedDetailQuery;
}

async function compileScenario(
  database: DatabaseSync,
  input: {
    readonly scope: "session" | "visitor";
    readonly includeBreakdowns?: boolean;
    readonly includeContext?: boolean;
  },
) {
  const prepared = prepareQuery(input);
  const forwarded = await d1AdvancedFilterMiddleware(
    testEnv(database, newTrace()),
  )("event-type-detail", prepared, async (value) => value);
  const deferred = deferredEventTypeDetailQualificationFromQuery(forwarded);
  if (!deferred) throw new Error("wave94h_deferred_event_type_detail_missing");
  const query = deferred.eventTypeDetailRequest;
  const plan = buildEventTypeDetailQualificationPlan({
    siteId: SITE_ID,
    count: deferred.countInput,
    ...query,
  });
  let compilation;
  try {
    compilation = compileEventTypeDetailQualificationProgram({
      deferred,
      query,
    });
  } catch (error) {
    evidence.push({
      scope: input.scope,
      includeBreakdowns: query.includeBreakdowns,
      includeContext: query.includeContext,
      kind: "threw",
      error:
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error),
      graph: {
        scope: plan.scope,
        reportOutputIds: plan.reportOutputIds,
        sourceCount: plan.plan.nodes.filter((node) => node.kind === "source")
          .length,
        reportSourceRelations: plan.reportSourceRelations,
      },
    });
    throw error;
  }
  evidence.push({
    scope: input.scope,
    includeBreakdowns: query.includeBreakdowns,
    includeContext: query.includeContext,
    kind: compilation.kind,
    ...(compilation.kind === "compiled"
      ? { evidence: compilation.evidence }
      : { fallbackReason: compilation.fallbackReason }),
    graph: {
      scope: plan.scope,
      reportOutputIds: plan.reportOutputIds,
      sourceCount: plan.plan.nodes.filter((node) => node.kind === "source")
        .length,
      reportSourceRelations: plan.reportSourceRelations,
    },
  });
  return { compilation, plan };
}

afterAll(() => {
  for (const database of databases) database.close();
  const evidencePath = process.env.WAVE94H_EVENT_TYPE_DETAIL_EVIDENCE_PATH;
  if (!evidencePath) return;
  const absolutePath = resolve(evidencePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(
    absolutePath,
    JSON.stringify(
      { kind: "wave94h-event-type-detail-compilation-v1", evidence },
      null,
      2,
    ),
    "utf8",
  );
});

describe("Wave94H event type detail compilation budget", () => {
  it("compiles the full default operation for session and visitor scopes", async () => {
    const database = createFixture();
    for (const scope of ["session", "visitor"] as const) {
      const { compilation, plan } = await compileScenario(database, { scope });
      expect(compilation.kind).toBe("compiled");
      if (compilation.kind !== "compiled")
        throw new Error("wave94h_default_detail_compile_unavailable");
      expect(compilation.evidence.groupWidth).toBeLessThanOrEqual(16);
      expect(compilation.evidence.groupedSummaryMaterialization).toBe(
        "materialized",
      );
      expect(compilation.evidence.sqlBytes).toBeLessThanOrEqual(
        D1_MAX_SQL_UTF8_BYTES,
      );
      expect(compilation.evidence.bindingCount).toBeLessThanOrEqual(
        D1_MAX_BOUND_PARAMETERS,
      );
      expect(plan.reportOutputIds).toHaveLength(7);
      expect(plan.reportSourceRelations?.map(({ entity }) => entity)).toEqual([
        "event",
        "page",
      ]);
    }
  });

  it("prunes disabled optional output groups", async () => {
    const database = createFixture();
    const noOptionalOutputs = await compileScenario(database, {
      scope: "session",
      includeBreakdowns: false,
      includeContext: false,
    });
    expect(noOptionalOutputs.plan.reportOutputIds).toEqual([
      "event-type-overview-summary",
      "event-type-trend-points",
    ]);
    expect(noOptionalOutputs.plan.reportSourceRelations).toEqual([
      expect.objectContaining({ entity: "event" }),
    ]);
    if (noOptionalOutputs.compilation.kind === "compiled")
      expect(
        noOptionalOutputs.compilation.evidence.sqlBytes,
      ).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
  });

  it("executes one side through the shared qualification runtime", async () => {
    const database = createFixture();
    const trace = newTrace();
    const prepared = prepareQuery({ scope: "session" });
    const forwarded = await d1AdvancedFilterMiddleware(
      testEnv(database, trace),
    )("event-type-detail", prepared, async (value) => value);
    const deferred = deferredEventTypeDetailQualificationFromQuery(forwarded);
    if (!deferred) throw new Error("wave95w_single_side_deferred_missing");

    const qualificationPreparationCount = trace.preparedSql.length;
    const diagnostics = createD1ReadDiagnostics();
    const execution = await executeEventTypeDetailQualificationProgram({
      env: testEnv(database, trace),
      deferred,
      query: deferred.eventTypeDetailRequest,
      diagnostics,
    });
    expect(execution.kind).toBe("executed");
    expect(trace.preparedSql).toHaveLength(qualificationPreparationCount + 1);
    expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
    evidence.push({
      kind: "single-side-shared-runtime-execution",
      scope: deferred.countInput.scope,
      statementCount: trace.preparedSql.length,
      executionKind: execution.kind,
    });
  });

  it("binds qualification to the exact imported child snapshot", async () => {
    const database = createFixture();
    const prepared = prepareQuery({
      scope: "session",
      includeBreakdowns: false,
      includeContext: false,
    });
    const forwarded = await d1AdvancedFilterMiddleware(
      testEnv(database, newTrace()),
    )("event-type-detail", prepared, async (value) => value);
    const deferred = deferredEventTypeDetailQualificationFromQuery(forwarded);
    if (!deferred) throw new Error("wave95w_import_binding_deferred_missing");
    const qualification = buildEventTypeDetailQualificationPlan({
      siteId: SITE_ID,
      count: deferred.countInput,
      ...deferred.eventTypeDetailRequest,
    });
    const reportOutputId = EVENT_TYPE_OVERVIEW_OUTPUTS.summary;
    const controlsOutputId = EVENT_QUALIFICATION_CONTROL_OUTPUT;
    const reportOutput = qualification.plan.outputs.find(
      ({ id }) => id === reportOutputId,
    );
    const controlsOutput = qualification.plan.outputs.find(
      ({ id }) => id === controlsOutputId,
    );
    if (!reportOutput || !controlsOutput)
      throw new Error("wave95w_import_binding_child_outputs_missing");

    const createParent = () => {
      const builder = new LogicalPlanBuilder(qualification.plan.context);
      const reportImport = builder.importAnalysisResult(
        qualification.plan,
        reportOutputId,
        reportOutput.fields.map(({ name }) => ({ field: name })),
      );
      const controlsImport = builder.importAnalysisResult(
        qualification.plan,
        controlsOutputId,
        controlsOutput.fields.map(({ name }) => ({ field: name })),
      );
      builder.output(
        "imported-report",
        reportImport,
        reportOutput.fields.map(({ name }) => ({ name, slot: name })),
      );
      builder.output(
        "imported-controls",
        controlsImport,
        controlsOutput.fields.map(({ name }) => ({ name, slot: name })),
      );
      const plan = builder.finish();
      const imports = plan.nodes.filter(
        (node) => node.kind === "analysis-result",
      );
      if (imports.length !== 2)
        throw new Error("wave95w_import_binding_parent_outputs_missing");
      return { plan, snapshot: imports[0]!.childPlan };
    };
    const parent = createParent();
    const otherParent = createParent();
    expect(parent.snapshot).not.toBe(otherParent.snapshot);
    const policy: AnalyticsQualificationAdmissionPolicy = {
      primaryReportSourceRelationId:
        qualification.primaryReportSourceRelationId,
      reportSourceRelations: qualification.reportSourceRelations,
      reportRelationIds: [reportOutput.relation],
      controlsRelationId: controlsOutput.relation,
      controlSlots: controlsOutput.fields.map(({ name, slot }) => ({
        name,
        slot,
      })),
      scope: qualification.scope,
      maximumActivities: 20_000,
      numericCompatibilityControlNames:
        qualification.numericCompatibilityFields.map(
          ({ invalidCountOutput }) => invalidCountOutput,
        ),
    };
    const binding = {
      childPlan: parent.snapshot,
      reportOutputIds: [reportOutputId],
      controlsOutputId,
      policy,
    };
    const compileParent = (bindings?: readonly (typeof binding)[]): string => {
      const lowerer = new AnalyticsLogicalToDbLowerer(
        parent.plan,
        { siteId: SITE_ID, time: parent.plan.context.time },
        bindings
          ? { analysisResultQualificationBindings: bindings }
          : undefined,
      );
      const lowered = lowerer.lowerMany(parent.plan.outputs);
      const report = lowerer.projectOutput(
        lowered[0]!,
        parent.plan.outputs[0]!.fields.map(({ name, slot }) => ({
          name,
          slot,
        })),
      );
      return compileD1Query(report).sql;
    };

    const qualifiedSql = compileParent([binding]);
    const noPolicySql = compileParent();
    expect(qualifiedSql).not.toBe(noPolicySql);
    expect(() => compileParent()).not.toThrow();
    expect(() =>
      compileParent([{ ...binding, childPlan: otherParent.snapshot }]),
    ).toThrow(
      "Each qualification binding must approve imported report outputs and controls from the exact child snapshot, with an exact report relation policy.",
    );
    expect(() =>
      compileParent([{ ...binding, controlsOutputId: "unimported-controls" }]),
    ).toThrow(
      "Each qualification binding must approve imported report outputs and controls from the exact child snapshot, with an exact report relation policy.",
    );
    evidence.push({
      kind: "imported-child-snapshot-admission-binding",
      sameChildSnapshotForBothOutputs: true,
      qualifiedSqlDiffersFromDefault: true,
      foreignChildSnapshotRejected: true,
      unimportedOutputBindingRejected: true,
      defaultNoPolicyImportCompiles: true,
    });
  });

  it("rejects a detail query that differs from its trusted deferred request", async () => {
    const database = createFixture();
    const prepared = prepareQuery({ scope: "session" });
    const forwarded = await d1AdvancedFilterMiddleware(
      testEnv(database, newTrace()),
    )("event-type-detail", prepared, async (value) => value);
    const deferred = deferredEventTypeDetailQualificationFromQuery(forwarded);
    if (!deferred)
      throw new Error("wave94o_deferred_event_type_detail_missing");

    expect(() =>
      compileEventTypeDetailQualificationProgram({
        deferred,
        query: { ...deferred.eventTypeDetailRequest, eventName: "refund" },
      }),
    ).toThrow("event_type_detail_qualification_request_mismatch");
  });

  it("fails closed on malformed controls without falling back to another query", async () => {
    const faults = [
      {
        name: "missing-control",
        mutate: () => [],
      },
      {
        name: "duplicate-control",
        mutate: (rows: readonly Record<string, unknown>[]) => [
          ...rows,
          ...rows.filter((row) => row.rowKind === "control"),
        ],
      },
      {
        name: "wrong-control-schema",
        mutate: (rows: readonly Record<string, unknown>[]) =>
          rows.map((row) =>
            row.rowKind === "control"
              ? { ...row, unexpectedField: "unexpected" }
              : row,
          ),
      },
    ] as const;

    for (const fault of faults) {
      const database = createFixture();
      const prepared = prepareQuery({ scope: "session" });
      const forwarded = await d1AdvancedFilterMiddleware(
        testEnv(database, newTrace()),
      )("event-type-detail", prepared, async (value) => value);
      const deferred = deferredEventTypeDetailQualificationFromQuery(forwarded);
      if (!deferred) throw new Error(`wave94o_${fault.name}_deferred_missing`);

      const trace = newTrace();
      await expect(
        executeEventTypeDetailQualificationProgram({
          env: testEnvWithResultMutation(database, trace, fault.mutate),
          deferred,
          query: deferred.eventTypeDetailRequest,
        }),
      ).rejects.toThrow(
        "analytics_event_summary_qualification_control_row_invalid",
      );
      expect(trace.preparedSql).toHaveLength(1);
    }
  });
});
