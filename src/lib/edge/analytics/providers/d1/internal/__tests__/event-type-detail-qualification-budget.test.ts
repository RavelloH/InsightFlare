import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterAll, describe, expect, it, vi } from "vitest";

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
import { createD1SiteProviderRegistry } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import { emptyEventContextCards } from "@/lib/edge/analytics/composition/d1/shared";
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
import { EVENT_CONTEXT_CARD_KEYS } from "@/lib/edge/analytics/engine/semantic/event-context-cards";
import {
  d1AdvancedFilterMiddleware,
  deferredEventTypeDetailQualificationFromQuery,
  prepareDeferredEventQualificationFallback,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import * as qualificationProgram from "@/lib/edge/analytics/providers/d1/internal/analytics-qualification-program";
import {
  compileEventTypeDetailQualificationProgram,
  executeEventTypeDetailQualificationProgram,
} from "@/lib/edge/analytics/providers/d1/internal/analytics-qualification-program";
import { AnalyticsLogicalToDbLowerer } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";
import {
  mapEventAnalyticsContextCards,
  mapTabs,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import { queryEventAnalyticsContextCardsFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-context";
import { queryEventTypeOverviewFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-overview";
import { queryEventTypeTrendFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-trend";
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

function testEnvWithRowsCapture(
  database: DatabaseSync,
  trace: SqliteD1Trace,
  batches: Record<string, unknown>[][],
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
          batches.push(rows as unknown as Record<string, unknown>[]);
          return result;
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

function createCandidateFixture(): DatabaseSync {
  const database = createFixture();
  const sitePk = Number(
    (
      database
        .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
        .get(SITE_ID) as { readonly site_pk: number }
    ).site_pk,
  );
  for (const [id, name] of [
    [1, "purchase"],
    [2, "refund"],
  ] as const)
    database
      .prepare(
        `INSERT INTO custom_event_names
         (id, site_id, name, last_seen_at, site_pk)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, SITE_ID, name, WINDOW.startMs, sitePk);
  const insertVisit = database.prepare(
    `INSERT INTO visits (
       visit_id, site_id, site_pk, visitor_id, session_id, status,
       started_at, last_activity_at, pathname, hostname
     ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, 'detail.test')`,
  );
  for (const visit of [
    {
      id: "detail-match",
      sessionId: "detail-shared-session",
      visitorId: "detail-shared-visitor",
      startedAt: WINDOW.startMs + 20,
      pathname: "/match-page",
    },
    {
      id: "detail-other",
      sessionId: "detail-shared-session",
      visitorId: "detail-shared-visitor",
      startedAt: WINDOW.startMs + 30,
      pathname: "/other-page",
    },
    {
      id: "detail-page-only",
      sessionId: "detail-shared-session",
      visitorId: "detail-shared-visitor",
      startedAt: WINDOW.startMs + 10,
      pathname: "/page-only",
    },
    {
      id: "detail-scoped",
      sessionId: "detail-scoped-session",
      visitorId: "detail-scoped-visitor",
      startedAt: WINDOW.startMs + 40,
      pathname: "/scoped",
    },
    {
      id: "detail-empty-visit-event",
      sessionId: "detail-empty-visit-page-session",
      visitorId: "detail-empty-visit-page-visitor",
      startedAt: WINDOW.startMs + 50,
      pathname: "/entity-id-must-not-fallback",
    },
  ])
    insertVisit.run(
      visit.id,
      SITE_ID,
      sitePk,
      visit.visitorId,
      visit.sessionId,
      visit.startedAt,
      visit.startedAt,
      visit.pathname,
    );
  const insertEvent = database.prepare(
    `INSERT INTO custom_events (
       event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
       received_at, sequence, node_count, value_count
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, 1)`,
  );
  for (const event of [
    {
      id: "detail-other",
      visitId: "detail-match",
      eventNameId: 1,
      occurredAt: WINDOW.startMs + 100,
    },
    {
      id: "detail-event-match-two",
      visitId: "detail-match",
      eventNameId: 1,
      occurredAt: WINDOW.startMs + 101,
    },
    {
      id: "detail-event-other",
      visitId: "detail-other",
      eventNameId: 2,
      occurredAt: WINDOW.startMs + 200,
    },
    {
      id: "detail-scoped-event",
      visitId: "detail-scoped",
      eventNameId: 1,
      occurredAt: WINDOW.startMs + 300,
    },
    {
      id: "detail-empty-visit-event",
      visitId: "",
      eventNameId: 1,
      occurredAt: WINDOW.startMs + 400,
    },
    {
      id: "detail-orphan-event",
      visitId: "detail-orphan-missing-page",
      eventNameId: 1,
      occurredAt: WINDOW.startMs + 500,
    },
  ])
    insertEvent.run(
      event.id,
      SITE_ID,
      sitePk,
      event.visitId,
      event.eventNameId,
      event.occurredAt,
      WINDOW.nowMs,
    );
  return database;
}

function prepareQuery(input: {
  readonly scope: "session" | "visitor" | "event";
  readonly includeBreakdowns?: boolean;
  readonly includeContext?: boolean;
  readonly countDsl?: string;
}): PreparedDetailQuery {
  const filters = parseFilterDsl(
    input.countDsl ?? 'count(page { page.path eq "/scoped" }) eq 1',
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
    readonly scope: "session" | "visitor" | "event";
    readonly includeBreakdowns?: boolean;
    readonly includeContext?: boolean;
    readonly countDsl?: string;
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

function statementEvidence(trace: SqliteD1Trace) {
  return trace.preparedSql.map((sql, index) => ({
    sql,
    bindings: trace.bindings[index],
    sqlUtf8Bytes: new TextEncoder().encode(sql).byteLength,
    bindingCount: trace.bindings[index]?.length ?? 0,
  }));
}

async function runCandidateScenario(
  database: DatabaseSync,
  input: {
    readonly label: string;
    readonly countDsl: string;
    readonly includeBreakdowns?: boolean;
    readonly includeContext?: boolean;
  },
) {
  const prepared = prepareQuery({
    scope: "event",
    countDsl: input.countDsl,
    ...(input.includeBreakdowns !== undefined
      ? { includeBreakdowns: input.includeBreakdowns }
      : {}),
    ...(input.includeContext !== undefined
      ? { includeContext: input.includeContext }
      : {}),
  });
  const prepareTrace = newTrace();
  const forwarded = await d1AdvancedFilterMiddleware(
    testEnv(database, prepareTrace),
  )("event-type-detail", prepared, async (value) => value);
  const deferred = deferredEventTypeDetailQualificationFromQuery(forwarded);
  if (!deferred) throw new Error(`wave97em_${input.label}_deferred_missing`);
  const reportPlan = buildEventTypeDetailQualificationPlan({
    siteId: SITE_ID,
    count: deferred.countInput,
    ...deferred.eventTypeDetailRequest,
  });

  const coreTrace = newTrace();
  const reportFilters =
    await prepareDeferredEventQualificationFallback(deferred);
  const coreEnv = testEnv(database, coreTrace);
  const includeBreakdowns = prepared.includeBreakdowns !== false;
  const includeContext = prepared.includeContext !== false;
  const [overview, trend, cards] = await Promise.all([
    queryEventTypeOverviewFromD1(
      coreEnv,
      SITE_ID,
      WINDOW,
      reportFilters,
      prepared.eventName,
      { includeBreakdowns },
    ),
    queryEventTypeTrendFromD1(
      coreEnv,
      SITE_ID,
      WINDOW,
      prepared.interval,
      reportFilters,
      prepared.eventName,
    ),
    includeContext
      ? queryEventAnalyticsContextCardsFromD1(
          coreEnv,
          SITE_ID,
          WINDOW,
          reportFilters,
          100,
          prepared.eventName,
          EVENT_CONTEXT_CARD_KEYS,
        )
      : Promise.resolve(emptyEventContextCards()),
  ]);
  const baseline = {
    eventName: prepared.eventName,
    summary: overview.summary,
    trend,
    breakdowns: {
      pages: mapTabs(overview.breakdowns.pages),
      countries: mapTabs(overview.breakdowns.countries),
      devices: mapTabs(overview.breakdowns.devices),
      browsers: mapTabs(overview.breakdowns.browsers),
    },
    cards: mapEventAnalyticsContextCards(cards),
  };

  const actualTrace = newTrace();
  const actualRowsByQuery: Record<string, unknown>[][] = [];
  const diagnostics = createD1ReadDiagnostics();
  const executionSpy = vi.spyOn(
    qualificationProgram,
    "executeEventTypeDetailQualificationProgram",
  );
  let executionCallCount = 0;
  let actual: { readonly value: unknown } | undefined;
  let execution:
    | Awaited<ReturnType<typeof executeEventTypeDetailQualificationProgram>>
    | undefined;
  try {
    const provider = createD1SiteProviderRegistry({
      env: testEnvWithRowsCapture(database, actualTrace, actualRowsByQuery),
      siteId: SITE_ID,
      diagnostics,
    }).resolve("event-type-detail");
    if (!provider) throw new Error(`wave97em_${input.label}_provider_missing`);
    actual = await provider.execute(prepared as never);
    executionCallCount = executionSpy.mock.calls.length;
    const originalCall = executionSpy.mock.results[0]?.value;
    if (!originalCall)
      throw new Error(`wave97em_${input.label}_qualification_not_called`);
    execution = (await Promise.resolve(originalCall)) as Awaited<
      ReturnType<typeof executeEventTypeDetailQualificationProgram>
    >;
  } finally {
    executionCallCount = executionSpy.mock.calls.length;
    executionSpy.mockRestore();
  }
  expect(executionCallCount).toBe(1);
  expect(actual!.value).toEqual(baseline);
  const actualQueries = actualRowsByQuery.map((rows, index) => ({
    ...statementEvidence(actualTrace)[index],
    rows,
  }));
  const result = {
    label: input.label,
    scope: deferred.countInput.scope,
    candidateAnchor:
      deferred.countInput.scope === "event"
        ? deferred.countInput.candidateAnchor
        : null,
    reportSourceRelations: reportPlan.reportSourceRelations,
    reportOutputIds: reportPlan.reportOutputIds,
    groupedSummaryRelationIds: [
      reportPlan.groupedSummaryRelationId,
      ...(reportPlan.additionalGroupedSummaryRelationIds ?? []),
    ],
    executionKind: execution?.kind,
    executionFallbackReason:
      execution && "fallbackReason" in execution
        ? execution.fallbackReason
        : null,
    executionEvidence:
      execution && "evidence" in execution ? execution.evidence : null,
    executionReportRows: execution && "rows" in execution ? execution.rows : [],
    controls: actualQueries.flatMap(({ rows }) =>
      rows.filter((row) => row.rowKind === "control"),
    ),
    reportRowsByOutput: Object.fromEntries(
      [
        ...new Set(
          actualQueries
            .flatMap(({ rows }) => rows)
            .filter((row) => typeof row.outputId === "string")
            .map((row) => String(row.outputId)),
        ),
      ].map((outputId) => [
        outputId,
        actualQueries
          .flatMap(({ rows }) => rows)
          .filter((row) => row.outputId === outputId),
      ]),
    ),
    actualTrace: statementEvidence(actualTrace),
    actualQueries,
    corePreparationTrace: statementEvidence(prepareTrace),
    corePreparationQueryCount: prepareTrace.preparedSql.length,
    coreReportTrace: statementEvidence(coreTrace),
    coreReportQueryCount: coreTrace.preparedSql.length,
    coreTotalQueryCount:
      prepareTrace.preparedSql.length + coreTrace.preparedSql.length,
    dto: actual!.value,
    coreDto: baseline,
    dtoEqual: true,
    diagnosticsFallback: diagnostics.advancedCountSqlFallbackReason ?? null,
  };
  evidence.push(result);
  return result;
}

afterAll(() => {
  for (const database of databases) database.close();
  for (const [evidencePath, kind] of [
    [
      process.env.WAVE94H_EVENT_TYPE_DETAIL_EVIDENCE_PATH,
      "wave94h-event-type-detail-compilation-v1",
    ],
    [
      process.env.WAVE97EM_TYPE_DETAIL_EVIDENCE_PATH,
      "wave97em-event-type-detail-evidence-v1",
    ],
  ] as const) {
    if (!evidencePath) continue;
    const absolutePath = resolve(evidencePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(
      absolutePath,
      JSON.stringify({ kind, evidence }, null, 2),
      "utf8",
    );
  }
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

  it.each([
    {
      label: "top-level AND with full default outputs",
      countDsl:
        'count(event { event.name eq "purchase" }) eq 2 AND event.name eq "purchase"',
      includeBreakdowns: true,
      includeContext: true,
      expectedSources: ["event", "page"],
      expectedOutputCount: 7,
      expectedBoundary: { entry: "/match-page", exit: "/match-page" },
    },
    {
      label: "top-level OR/NOT with a Page-only visit",
      countDsl:
        '(count(event { event.name eq "purchase" }) eq 2 AND event.name eq "purchase") OR NOT (page.path neq "/page-only")',
      includeBreakdowns: false,
      includeContext: true,
      expectedSources: ["event", "page"],
      expectedOutputCount: 3,
      expectedBoundary: { entry: "/page-only", exit: "/match-page" },
    },
    {
      label: "disabled optional outputs",
      countDsl:
        'count(event { event.name eq "purchase" }) eq 1 AND event.name eq "purchase"',
      includeBreakdowns: false,
      includeContext: false,
      expectedSources: ["event"],
      expectedOutputCount: 2,
      expectedBoundary: null,
    },
  ] as const)(
    "executes Event-candidate Type Detail: $label",
    async (scenario) => {
      const database = createCandidateFixture();
      const result = await runCandidateScenario(database, {
        label: scenario.label,
        countDsl: scenario.countDsl,
        includeBreakdowns: scenario.includeBreakdowns,
        includeContext: scenario.includeContext,
      });
      expect(result.scope).toBe("event");
      expect(result.candidateAnchor).toEqual({ kind: "event-candidate" });
      expect(result.executionKind).toBe("executed");
      expect(result.controls).toHaveLength(1);
      expect(result.controls[0]).toMatchObject({
        rowKind: "control",
        entityKind: "event",
      });
      expect(result.dto).toEqual(result.coreDto);
      expect(result.reportSourceRelations.map(({ entity }) => entity)).toEqual(
        scenario.expectedSources,
      );
      expect(result.reportOutputIds).toHaveLength(scenario.expectedOutputCount);
      const executionEvidence = result.executionEvidence as {
        readonly sqlBytes: number;
        readonly bindingCount: number;
        readonly groupWidth: number;
        readonly groupedSummaryMaterializations?: readonly unknown[];
      };
      expect(executionEvidence.sqlBytes).toBeLessThanOrEqual(100_000);
      expect(executionEvidence.bindingCount).toBeLessThanOrEqual(100);
      expect(executionEvidence.groupWidth).toBeLessThanOrEqual(16);
      expect(executionEvidence.groupedSummaryMaterializations).toHaveLength(2);
      if (scenario.expectedBoundary) {
        const dto = result.dto as {
          readonly summary: { readonly events: number };
          readonly trend: {
            readonly data: readonly { readonly events: number }[];
          };
          readonly cards: {
            readonly page: {
              readonly entry: readonly {
                readonly label: string;
                readonly views: number;
              }[];
              readonly exit: readonly {
                readonly label: string;
                readonly views: number;
              }[];
            };
          };
        };
        expect(dto.summary.events).toBe(2);
        expect(
          dto.trend.data.reduce((sum, point) => sum + point.events, 0),
        ).toBe(2);
        expect(dto.cards.page.entry).toEqual([
          expect.objectContaining({
            label: scenario.expectedBoundary.entry,
            views: 2,
          }),
        ]);
        expect(dto.cards.page.exit).toEqual([
          expect.objectContaining({
            label: scenario.expectedBoundary.exit,
            views: 2,
          }),
        ]);
      }
      evidence.push({
        kind: "wave97em-event-type-detail-candidate-dto-contract-v1",
        scenario: result,
        localIdCollision: {
          eventLocalId: "detail-other",
          eventVisitId: "detail-match",
          pageLocalId: "detail-other",
        },
        sharedEventVisitId: "detail-match",
      });
    },
  );

  it("keeps empty and orphan Event visit IDs out of Page boundary membership", async () => {
    const database = createCandidateFixture();
    const result = await runCandidateScenario(database, {
      label: "event-detail-empty-orphan-visit-ids",
      countDsl:
        'count(event { event.name eq "purchase" }) eq 1 AND event.name eq "purchase"',
    });
    expect(result.executionKind).toBe("executed");
    expect(result.dto).toEqual(result.coreDto);
    const dto = result.dto as {
      readonly cards: {
        readonly page: {
          readonly entry: readonly { readonly label: string }[];
          readonly exit: readonly { readonly label: string }[];
        };
      };
    };
    expect(dto.cards.page.entry.map(({ label }) => label)).toEqual(["/scoped"]);
    expect(dto.cards.page.exit.map(({ label }) => label)).toEqual(["/scoped"]);
    expect(result.reportSourceRelations.map(({ entity }) => entity)).toEqual([
      "event",
      "page",
    ]);
    evidence.push({
      kind: "wave97em-event-type-detail-empty-orphan-visit-evidence-v1",
      scenario: result,
      entityIdCollisionPage: "/entity-id-must-not-fallback",
      orphanVisitId: "detail-orphan-missing-page",
    });
  });

  it("falls back as a whole Event-candidate operation for numeric domain data", async () => {
    const database = createCandidateFixture();
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "detail-match");
    const result = await runCandidateScenario(database, {
      label: "event-detail-numeric-domain-fallback",
      countDsl:
        'count(page { page.durationMs gt 5 }) eq 1 AND event.name eq "purchase"',
    });
    expect(result.executionKind).toBe("legacy");
    expect(
      (result.diagnosticsFallback as { readonly kind?: string } | null)?.kind,
    ).toBe("numeric-data-domain");
    expect(result.dto).toEqual(result.coreDto);
    expect(result.actualTrace.length).toBeGreaterThan(2);
    expect(result.controls).toHaveLength(1);
    const controlQueries = result.actualQueries.filter(({ rows }) =>
      rows.some((row) => row.rowKind === "control"),
    );
    expect(controlQueries).toHaveLength(1);
    expect(
      controlQueries[0]!.rows.filter((row) => row.rowKind === "report"),
    ).toEqual([]);
    evidence.push({
      kind: "wave97em-event-type-detail-numeric-fallback-evidence-v1",
      scenario: result,
    });
  });

  it("rejects Event-candidate getters and context mismatches before SQL", async () => {
    const database = createCandidateFixture();
    const prepared = prepareQuery({
      scope: "event",
      countDsl:
        'count(event { event.name eq "purchase" }) eq 2 AND event.name eq "purchase"',
    });
    let includeContextReads = 0;
    const getterRequest = { ...prepared };
    Object.defineProperty(getterRequest, "includeContext", {
      enumerable: true,
      get() {
        includeContextReads += 1;
        return true;
      },
    });
    const getterTrace = newTrace();
    await expect(
      d1AdvancedFilterMiddleware(testEnv(database, getterTrace))(
        "event-type-detail",
        getterRequest,
        async (value) => value,
      ),
    ).rejects.toMatchObject({
      domainError: {
        issues: [
          { code: "event_type_detail_qualification_request_own_data_required" },
        ],
      },
    });
    expect(includeContextReads).toBe(0);
    expect(getterTrace.preparedSql).toHaveLength(0);

    const mismatchTrace = newTrace();
    const mismatchedTime = createQueryTime(
      WINDOW.startMs + 1,
      WINDOW.endExclusiveMs,
      WINDOW.timeZone,
      WINDOW.nowMs,
    );
    await expect(
      d1AdvancedFilterMiddleware(testEnv(database, mismatchTrace))(
        "event-type-detail",
        { ...prepared, time: mismatchedTime },
        async (value) => value,
      ),
    ).rejects.toMatchObject({
      domainError: {
        issues: [
          { code: "event_type_detail_qualification_request_context_mismatch" },
        ],
      },
    });
    expect(mismatchTrace.preparedSql).toHaveLength(0);
    evidence.push({
      kind: "wave97em-event-type-detail-request-safety-v1",
      getterReads: includeContextReads,
      getterSqlCount: getterTrace.preparedSql.length,
      contextMismatchSqlCount: mismatchTrace.preparedSql.length,
    });
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
