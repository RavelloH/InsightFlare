import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { createD1SiteQueryRuntime } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import type {
  AnalyticsResult,
  CanonicalQuery,
  CanonicalResult,
  FilterDocument,
  QueryInput,
  QueryTime,
  ScopedFilterPlan,
} from "@/lib/edge/analytics/contract";
import {
  createQueryTime,
  prepareScopedQuery,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import {
  decodeGoalConfig,
  GoalConfigDecodeError,
} from "@/lib/edge/analytics/contract/goal-config";
import type { AdvancedCountFilterMatchPlanInput } from "@/lib/edge/analytics/engine/advanced-count-filter-plan";
import { JOURNEY_SESSION_LIST_REPORT_OUTPUT } from "@/lib/edge/analytics/engine/journey-entity-list-report-plan";
import {
  buildJourneySessionGoalListQualificationPlan,
  buildJourneySessionListQualificationPlan,
  type JourneySessionListQualificationPlan,
} from "@/lib/edge/analytics/engine/journey-session-list-qualification-plan";
import { PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT } from "@/lib/edge/analytics/engine/page-dimension-qualification-plan";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { d1AdvancedFilterMiddleware } from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { queryD1CompiledAll } from "@/lib/edge/analytics/providers/d1/internal/core";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import * as goalDefinitionReader from "@/lib/edge/analytics/providers/d1/internal/goals";
import type { SessionListCursor } from "@/lib/edge/analytics/providers/d1/internal/journey-list-queries";
import { sessionListPageFromRecords } from "@/lib/edge/analytics/providers/d1/internal/journey-list-queries";
import { compileQualificationProgramEnvelope } from "@/lib/edge/analytics/providers/d1/internal/qualification-program-envelope";
import * as sessionListQualificationRequest from "@/lib/edge/analytics/providers/d1/internal/session-list-qualification-request";
import { readSiteSessions } from "@/lib/edge/analytics/providers/d1/operations/site-journeys";
import type { Env } from "@/lib/edge/types";
import { parseFilterDsl } from "@/lib/filter-contract";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";
import { analyzeFilterDocument } from "@/lib/filter-contract/filter-semantics";

const SITE_ID = "wave97y-session-goal-qualified";
const BASE = Date.UTC(2026, 9, 1);
const END = BASE + 24 * 60 * 60 * 1000;
const TIME: QueryTime = createQueryTime(BASE, END, "UTC", END);
const EVIDENCE_DIRECTORY = process.env.INSIGHTFLARE_QUERY_EVIDENCE_DIR?.trim();
const COUNT_FILTER =
  'page.path neq "/excluded" and count(event { event.name eq "qualifier" }) gte 1';
const GOAL_FILTERS = {
  page: 'page.path eq "/page-goal"',
  event: 'event.name eq "purchase"',
} as const;
type Scope = "session" | "visitor";
type GoalKind = keyof typeof GOAL_FILTERS;
type SortKey = "startedAt" | "durationMs" | "views";
type Sort = { readonly key: SortKey; readonly direction: "desc" };

function makeDatabase(includeSecondGoalSession = true): DatabaseSync {
  const database = createMigratedDatabase();
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
      "INSERT INTO sites (id, team_id, name, domain, created_at) VALUES (?, 'wave97y-team', 'Session Goal qualified', 'goal.test', 0)",
    )
    .run(SITE_ID);

  const visits = [
    ["a-count", "visitor-a", "session-a-count", 1_000, "/count"],
    ["a-page-goal", "visitor-a", "session-a-page-goal", 2_000, "/page-goal"],
    ["a-event-goal", "visitor-a", "session-a-event-goal", 3_000, "/event-goal"],
    ["b-count-goal", "visitor-b", "session-b-count-goal", 4_000, "/page-goal"],
    ["c-no-match", "visitor-c", "session-c-no-match", 5_000, "/ordinary"],
    ["d-excluded", "visitor-d", "session-d-excluded", 6_000, "/excluded"],
    ...(includeSecondGoalSession
      ? ([
          [
            "e-count-goal",
            "visitor-e",
            "session-e-count-goal",
            7_000,
            "/page-goal",
          ],
        ] as const)
      : []),
  ] as const;
  for (const [visitId, visitorId, sessionId, startOffset, pathname] of visits) {
    const startedAt = BASE + startOffset;
    database
      .prepare(
        "INSERT INTO visits (visit_id, site_id, site_pk, visitor_id, session_id, status, started_at, last_activity_at, pathname, hostname) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, 'goal.test')",
      )
      .run(
        visitId,
        SITE_ID,
        sitePk,
        visitorId,
        sessionId,
        startedAt,
        startedAt + 500,
        pathname,
      );
  }

  const eventNameId = (name: string): number => {
    database
      .prepare(
        "INSERT INTO custom_event_names (site_id, name, last_seen_at, site_pk) VALUES (?, ?, ?, ?) ON CONFLICT(site_pk, name) DO NOTHING",
      )
      .run(SITE_ID, name, BASE + 10_000, sitePk);
    return Number(
      (
        database
          .prepare(
            "SELECT id FROM custom_event_names WHERE site_pk = ? AND name = ?",
          )
          .get(sitePk, name) as { readonly id: number }
      ).id,
    );
  };
  const qualifierId = eventNameId("qualifier");
  const purchaseId = eventNameId("purchase");
  const events = [
    ["a-count", qualifierId, 1_100],
    ["a-event-goal", purchaseId, 3_100],
    ["b-count-goal", qualifierId, 4_100],
    ["b-count-goal", purchaseId, 4_200],
    ...(includeSecondGoalSession
      ? ([
          ["e-count-goal", qualifierId, 7_100],
          ["e-count-goal", purchaseId, 7_200],
        ] as const)
      : []),
  ] as const;
  for (const [visitId, nameId, occurredOffset] of events) {
    const occurredAt = BASE + occurredOffset;
    database
      .prepare(
        "INSERT INTO custom_events (event_id, site_id, site_pk, visit_id, event_name_id, occurred_at, received_at, sequence, node_count, value_count) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 0)",
      )
      .run(
        `event-${visitId}-${nameId}`,
        SITE_ID,
        sitePk,
        visitId,
        nameId,
        occurredAt,
        occurredAt,
      );
  }

  for (const [id, filterDsl] of [
    ["goal-page", GOAL_FILTERS.page],
    ["goal-event", GOAL_FILTERS.event],
    ["goal-no-match", 'page.path eq "/never"'],
    ["goal-invalid", 'page.path eq "'],
  ] as const) {
    database
      .prepare(
        "INSERT INTO analysis_definitions (id, site_id, kind, name, config_json, config_version, created_at, updated_at) VALUES (?, ?, 'goal', ?, ?, 1, ?, ?)",
      )
      .run(
        id,
        SITE_ID,
        id,
        JSON.stringify({ filterDslVersion: 1, filterDsl }),
        BASE,
        BASE,
      );
  }

  return database;
}

function preparedQualificationInput(scope: Scope) {
  const filters = parseFilterDsl(COUNT_FILTER, analyticsFilterRegistry);
  const prepared = prepareScopedQuery("sessions", {
    context: siteQueryContext(SITE_ID, "private-dashboard"),
    time: TIME,
    filters,
    scopePreference: scope,
  } as never) as QueryInput & {
    readonly time: QueryTime;
    readonly filters: FilterDocument;
    readonly scopePlan: ScopedFilterPlan;
  };
  const readRange = prepared.time.readRange ?? prepared.time.range;
  const count: AdvancedCountFilterMatchPlanInput = {
    subject: createSemanticSubjectDomain({
      origin: "site",
      siteIds: [SITE_ID as never],
    }),
    candidateRange: { ...prepared.time.range },
    readRange: { ...readRange },
    expressionRange: { ...prepared.time.range },
    expressionUsesExplicitRange: false,
    lowerBounds: [{ siteId: SITE_ID, startMs: readRange.startMs }],
    scope,
    reportingTimeZone: prepared.time.reportingTimeZone,
    capturedAtMs: prepared.time.capturedAtMs,
    analysis: analyzeFilterDocument(prepared.filters, analyticsFilterRegistry),
  };
  return { prepared, count };
}

function compileSessionEnvelope(input: {
  readonly plan: JourneySessionListQualificationPlan;
  readonly siteId: string;
  readonly sort: Sort;
}) {
  const report = input.plan.plan.outputs.find(
    ({ id }) => id === JOURNEY_SESSION_LIST_REPORT_OUTPUT,
  );
  const controls = input.plan.plan.outputs.find(
    ({ id }) => id === PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT,
  );
  if (!report || !controls) throw new Error("session_goal_outputs_missing");
  const reportFields = report.fields.map(({ name }) => name);
  const primaryField =
    input.sort.key === "durationMs" ? "totalDurationMs" : input.sort.key;
  const ordering = [
    {
      outputId: JOURNEY_SESSION_LIST_REPORT_OUTPUT,
      field: primaryField,
      direction: input.sort.direction,
      nulls: "last" as const,
    },
    ...(input.sort.key === "startedAt"
      ? []
      : [
          {
            outputId: JOURNEY_SESSION_LIST_REPORT_OUTPUT,
            field: "startedAt",
            direction: "desc" as const,
            nulls: "last" as const,
          },
        ]),
    {
      outputId: JOURNEY_SESSION_LIST_REPORT_OUTPUT,
      field: "sessionId",
      direction: "asc" as const,
      nulls: "last" as const,
    },
  ];
  return compileQualificationProgramEnvelope({
    qualification: input.plan,
    siteId: input.siteId,
    reports: [
      { output: report, fields: reportFields, rowType: "session-list" },
    ],
    controlsOutput: controls,
    reportFields,
    controlFields: controls.fields.map(({ name }) => name),
    ordering,
    errorPrefix: "session_list_qualification",
    fallbackTag: "analytics.session_list_qualification",
  });
}

function buildPlan(input: {
  readonly scope: Scope;
  readonly goalKind: GoalKind;
  readonly sort: Sort;
  readonly limit: number;
  readonly cursor?: SessionListCursor | null;
}) {
  const { prepared, count } = preparedQualificationInput(input.scope);
  const analysisFilter = parseFilterDsl(
    GOAL_FILTERS[input.goalKind],
    analyticsFilterRegistry,
  );
  const plan = buildJourneySessionGoalListQualificationPlan({
    siteId: SITE_ID,
    queryTime: prepared.time,
    filters: prepared.filters,
    scopePlan: prepared.scopePlan,
    count,
    limit: input.limit,
    sort: input.sort,
    cursor: input.cursor,
    analysisFilter,
  });
  return { plan, prepared, analysisFilter };
}

async function executePlanPage(input: {
  readonly database: DatabaseSync;
  readonly trace: SqliteD1Trace;
  readonly scope: Scope;
  readonly goalKind: GoalKind;
  readonly sort: Sort;
  readonly limit: number;
  readonly cursor?: SessionListCursor | null;
}) {
  const env = {
    DB: createSqliteD1Database(input.database, input.trace),
    MAIN_SECRET: "wave97y-session-goal-qualified-secret",
  } as unknown as Env;
  const { plan } = buildPlan(input);
  const compilation = compileSessionEnvelope({
    plan,
    siteId: SITE_ID,
    sort: input.sort,
  });
  if (compilation.kind !== "compiled")
    throw new Error(
      `session_goal_plan_unavailable:${JSON.stringify(compilation.fallbackReason)}`,
    );
  const start = input.trace.preparedSql.length;
  const bindingStart = input.trace.bindings.length;
  const rows = await queryD1CompiledAll(env, compilation.query);
  const calls = input.trace.preparedSql.slice(start).map((sql, index) => ({
    sql,
    bindings: input.trace.bindings[bindingStart + index] ?? [],
  }));
  const reportFields = compilation.evidence.outputDescriptors.find(
    ({ outputId }) => outputId === JOURNEY_SESSION_LIST_REPORT_OUTPUT,
  )?.fields;
  if (!reportFields) throw new Error("session_goal_report_fields_missing");
  const reportRows = rows.filter(
    (row) =>
      row.rowKind === "report" &&
      row.outputId === JOURNEY_SESSION_LIST_REPORT_OUTPUT,
  );
  const records = reportRows.map((row) =>
    Object.fromEntries(reportFields.map((field) => [field, row[field]])),
  );
  const page = sessionListPageFromRecords(records, input.limit, input.sort);
  return {
    compilation: compilation.evidence,
    calls,
    reportRows: records,
    page,
    controls: rows.filter(
      (row) =>
        row.rowKind === "control" &&
        row.outputId === PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT,
    ),
  };
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

function runtimeQuery(input: {
  readonly goalId: string;
  readonly scope: Scope;
  readonly limit?: number;
  readonly cursor?: string | null;
  readonly countFilter?: FilterDocument;
  readonly sort?: Sort;
}): CanonicalQuery<"sessions"> {
  return {
    context: siteQueryContext(SITE_ID, "private-dashboard"),
    time: TIME,
    filters:
      input.countFilter ??
      parseFilterDsl(COUNT_FILTER, analyticsFilterRegistry),
    scopePreference: input.scope,
    analysisContext: { type: "goal", goalId: input.goalId },
    page: { limit: input.limit ?? 1, cursor: input.cursor ?? null },
    sort: input.sort ?? { key: "startedAt", direction: "desc" },
  } as CanonicalQuery<"sessions">;
}

interface GoalBranchSqlObservation {
  readonly sqlBytes: number;
  readonly bindingCount: number;
  readonly controlRowCount: number;
  readonly reportRowCount: number;
  readonly rawCountBeforeMutation: unknown;
  readonly rawCountAfterMutation: unknown;
}

interface GoalBranchObservations {
  goalLookupAttempts: number;
  readonly envelopes: GoalBranchSqlObservation[];
}

interface GoalBranchFaults {
  readonly controlRawCount?: number;
  readonly goalLookupError?: Error;
  readonly afterGoalLookup?: () => void;
}

function instrumentedSqliteD1Database(input: {
  readonly database: DatabaseSync;
  readonly trace: SqliteD1Trace;
  readonly faults?: GoalBranchFaults;
  readonly observations: GoalBranchObservations;
}): Env["DB"] {
  const sqlite = createSqliteD1Database(input.database, input.trace);
  const wrapPrepared = (
    sql: string,
    prepared: D1PreparedStatement,
  ): D1PreparedStatement =>
    new Proxy(prepared, {
      get(target, property) {
        const member = Reflect.get(target, property, target);
        if (property === "bind")
          return (...values: unknown[]) => {
            const bound = Reflect.apply(
              member as (...args: unknown[]) => unknown,
              target,
              values,
            ) as D1PreparedStatement;
            return wrapPrepared(sql, bound);
          };
        if (property === "all")
          return async (...args: unknown[]) => {
            const isGoalLookup = sql.includes('"analysis_definitions"');
            if (isGoalLookup) {
              input.observations.goalLookupAttempts += 1;
              if (input.faults?.goalLookupError)
                throw input.faults.goalLookupError;
            }
            const result = (await Reflect.apply(
              member as (...values: unknown[]) => Promise<unknown>,
              target,
              args,
            )) as {
              readonly results: readonly Record<string, unknown>[];
              readonly [key: string]: unknown;
            };
            if (isGoalLookup) {
              input.faults?.afterGoalLookup?.();
              return result;
            }
            if (!sql.includes("rowKind")) return result;

            const controls = result.results.filter(
              (row) =>
                row.rowKind === "control" &&
                row.outputId === PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT,
            );
            const reportRowCount = result.results.filter(
              (row) => row.rowKind === "report",
            ).length;
            const rawCountBeforeMutation = controls[0]?.rawCount;
            const rawCountAfterMutation =
              input.faults?.controlRawCount ?? rawCountBeforeMutation;
            const sqlIndex = input.trace.preparedSql.lastIndexOf(sql);
            input.observations.envelopes.push({
              sqlBytes: new TextEncoder().encode(sql).byteLength,
              bindingCount: input.trace.bindings[sqlIndex]?.length ?? 0,
              controlRowCount: controls.length,
              reportRowCount,
              rawCountBeforeMutation,
              rawCountAfterMutation,
            });
            if (input.faults?.controlRawCount === undefined) return result;
            return {
              ...result,
              results: result.results.map((row) =>
                row.rowKind === "control" &&
                row.outputId === PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT
                  ? { ...row, rawCount: input.faults!.controlRawCount }
                  : row,
              ),
            };
          };
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
  return {
    prepare(sql: string) {
      return wrapPrepared(sql, sqlite.prepare(sql));
    },
    batch(statements: D1PreparedStatement[]) {
      return sqlite.batch(statements);
    },
  } as Env["DB"];
}

function routeHarness(
  database: DatabaseSync,
  trace: SqliteD1Trace,
  routedDatabase: Env["DB"] = createSqliteD1Database(database, trace),
) {
  const diagnostics = createD1ReadDiagnostics();
  const runtime = createD1SiteQueryRuntime({
    env: {
      DB: routedDatabase,
      MAIN_SECRET: "wave97y-session-goal-qualified-secret",
    } as unknown as Env,
    siteId: SITE_ID,
    diagnostics,
  });
  return { runtime, diagnostics };
}

function invalidGoalReaderError(): GoalConfigDecodeError {
  try {
    decodeGoalConfig(
      1,
      JSON.stringify({
        filterDslVersion: 1,
        filterDsl: 'page.path eq "',
      }),
    );
  } catch (error) {
    if (error instanceof GoalConfigDecodeError) return error;
    throw error;
  }
  throw new Error("session_goal_expected_invalid_reader_config");
}

function goalLookupSqlCalls(trace: SqliteD1Trace): string[] {
  return trace.preparedSql.filter((sql) =>
    sql.includes('"analysis_definitions"'),
  );
}

function qualificationEnvelopeSqlCalls(trace: SqliteD1Trace): string[] {
  return trace.preparedSql.filter((sql) => sql.includes("rowKind"));
}

function legacySessionFallbackSqlCalls(trace: SqliteD1Trace): string[] {
  return trace.preparedSql.filter(
    (sql) => sql.includes('"visits"') && !sql.includes("rowKind"),
  );
}

async function readLegacyPage(input: {
  readonly database: DatabaseSync;
  readonly trace: SqliteD1Trace;
  readonly goalId: string;
  readonly scope: Scope;
  readonly sort: Sort;
  readonly cursor: string | null;
  readonly pageIndex: number;
  readonly evidenceCase: "matrix" | "numeric-fallback";
  readonly limit?: number;
  readonly countFilter?: FilterDocument;
}) {
  const env = {
    DB: createSqliteD1Database(input.database, input.trace),
    MAIN_SECRET: "wave97y-session-goal-qualified-secret",
  } as unknown as Env;
  const request = runtimeQuery({
    goalId: input.goalId,
    scope: input.scope,
    cursor: input.cursor,
    sort: input.sort,
    limit: input.limit,
    countFilter: input.countFilter,
  });
  const prepared = prepareScopedQuery("sessions", request) as QueryInput;
  let forwarded: QueryInput | undefined;
  const traceStart = input.trace.preparedSql.length;
  const bindingStart = input.trace.bindings.length;
  const parserSpy = vi.spyOn(
    sessionListQualificationRequest,
    "sessionListQualificationConfigurationFromQuery",
  );
  parserSpy.mockReturnValue(undefined);
  try {
    await d1AdvancedFilterMiddleware(env, undefined, SITE_ID)(
      "sessions",
      prepared,
      async (query) => {
        forwarded = query as QueryInput;
        return query;
      },
    );
    expect(parserSpy).toHaveBeenCalled();
  } finally {
    parserSpy.mockRestore();
  }
  if (!forwarded?.filters)
    throw new Error("session_goal_legacy_count_bridge_missing");
  const metadata = scopedFilterMetadata(forwarded.filters);
  const advancedMatches = metadata?.plan.advancedMatches;
  const entityIds = advancedMatches?.entityIds;
  expect(
    sessionListQualificationRequest.deferredSessionListQualificationFromQuery(
      forwarded,
    ),
  ).toBeUndefined();
  expect(request.analysisContext).toEqual({
    type: "goal",
    goalId: input.goalId,
  });
  expect(
    (forwarded as QueryInput & { readonly analysisContext?: unknown })
      .analysisContext,
  ).toEqual(request.analysisContext);
  expect(forwarded.filters.root).toEqual(request.filters?.root);
  expect(metadata?.time).toEqual(request.time);
  expect(metadata?.plan.scope).toBe(input.scope);
  expect(metadata?.siteIds).toEqual([SITE_ID]);
  expect(entityIds).toBeDefined();
  expect(
    entityIds?.every(({ siteId, id }) => siteId === SITE_ID && id.length > 0),
  ).toBe(true);

  const legacyPage = await readSiteSessions({
    env,
    siteId: SITE_ID,
    window: {
      startMs: BASE,
      endExclusiveMs: END,
      nowMs: END,
      timeZone: "UTC",
    },
    filters: forwarded.filters,
    sort: { field: input.sort.key, direction: input.sort.direction },
    page: { limit: input.limit ?? 1, cursor: input.cursor },
    audience: "private-dashboard",
    analysisContext: { type: "goal", goalId: input.goalId },
  });
  const sql = input.trace.preparedSql.slice(traceStart).map((query, index) => ({
    sql: query,
    bindings: input.trace.bindings[bindingStart + index] ?? [],
  }));
  expect(sql.length).toBeGreaterThan(0);
  writeEvidence(
    `legacy-${input.evidenceCase}-${input.scope}-${input.goalId}-${input.sort.key}-page-${input.pageIndex}.json`,
    {
      kind: "session-goal-legacy-count-bridge-old-reader",
      middleware: {
        parserSpyUsed: true,
        deferredSessionListQualification: false,
        metadata: {
          requestedScope: metadata?.requestedScope,
          resolvedScope: metadata?.resolvedScope,
          siteIds: metadata?.siteIds,
          advancedMatches: { entityIds },
        },
      },
      request: {
        siteId: SITE_ID,
        audience: request.context.policy.audience,
        analysisContext: request.analysisContext,
        filtersRoot: request.filters?.root,
        time: request.time,
        scopePreference: request.scopePreference,
        sort: input.sort,
        page: { limit: input.limit ?? 1, cursor: input.cursor },
      },
      oldReader: "readSiteSessions",
      sql,
      legacyDto: legacyPage,
    },
  );
  return legacyPage;
}

const candidateCases = (["session", "visitor"] as const).flatMap((scope) =>
  (["page", "event"] as const).flatMap((goalKind) =>
    (["startedAt", "durationMs", "views"] as const).map((sortKey) => ({
      scope,
      goalKind,
      sortKey,
    })),
  ),
);

describe("Sessions Goal fused qualification plan", () => {
  it.each(candidateCases)(
    "$scope Count + $goalKind Goal + $sortKey runs first and next pages within D1 budgets",
    async ({ scope, goalKind, sortKey }) => {
      const database = makeDatabase();
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const sort: Sort = { key: sortKey, direction: "desc" };
      try {
        const first = await executePlanPage({
          database,
          trace,
          scope,
          goalKind,
          sort,
          limit: 1,
        });
        expect(first.controls).toHaveLength(1);
        expect(first.page.rows).toHaveLength(1);
        expect(first.page.nextCursor).not.toBeNull();
        expect(first.compilation.sqlBytes).toBeLessThanOrEqual(100_000);
        expect(first.compilation.bindingCount).toBeLessThanOrEqual(100);
        expect(first.compilation.groupWidth).toBeLessThanOrEqual(16);
        expect(first.compilation.groupedSummaryProof).toMatchObject({
          source: "local-plan",
          nodeKind: "aggregate",
          groupKeyCount: 2,
          materialization: "materialized",
        });
        expect(first.calls).toHaveLength(1);

        const next = await executePlanPage({
          database,
          trace,
          scope,
          goalKind,
          sort,
          limit: 1,
          cursor: first.page.nextCursor,
        });
        expect(next.controls).toHaveLength(1);
        expect(next.page.rows).toHaveLength(1);
        expect(next.compilation.sqlBytes).toBeLessThanOrEqual(100_000);
        expect(next.compilation.bindingCount).toBeLessThanOrEqual(100);
        expect(next.compilation.groupWidth).toBeLessThanOrEqual(16);
        expect(next.compilation.groupedSummaryProof).toMatchObject({
          source: "local-plan",
          nodeKind: "aggregate",
          groupKeyCount: 2,
          materialization: "materialized",
        });
        expect(next.calls).toHaveLength(1);

        writeEvidence(`candidate-${scope}-${goalKind}-${sortKey}.json`, {
          state: "pre-route-real-sqlite-fused-plan",
          node: process.version,
          scope,
          goalKind,
          sort,
          pages: [first, next].map((page) => ({
            dto: page.page.rows,
            cursor: page.page.nextCursor,
            sqlBytes: page.compilation.sqlBytes,
            bindingCount: page.compilation.bindingCount,
            groupWidth: page.compilation.groupWidth,
            groupedSummaryProof: page.compilation.groupedSummaryProof,
            calls: page.calls,
          })),
        });
      } finally {
        database.close();
      }
    },
  );

  it.each([
    {
      scope: "session",
      goalKind: "page",
      expected: ["session-b-count-goal", "session-e-count-goal"],
    },
    {
      scope: "visitor",
      goalKind: "page",
      expected: [
        "session-a-page-goal",
        "session-b-count-goal",
        "session-e-count-goal",
      ],
    },
    {
      scope: "session",
      goalKind: "event",
      expected: ["session-b-count-goal", "session-e-count-goal"],
    },
    {
      scope: "visitor",
      goalKind: "event",
      expected: [
        "session-a-event-goal",
        "session-b-count-goal",
        "session-e-count-goal",
      ],
    },
  ] as const)(
    "$scope Count scope keeps the $goalKind Goal Session identity restriction",
    async ({ scope, goalKind, expected }) => {
      const database = makeDatabase();
      try {
        const result = await executePlanPage({
          database,
          trace: { preparedSql: [], bindings: [] },
          scope,
          goalKind,
          sort: { key: "startedAt", direction: "desc" },
          limit: 20,
        });
        expect(result.controls).toHaveLength(1);
        expect(result.page.rows.map((row) => row.sessionId).sort()).toEqual(
          [...expected].sort(),
        );
      } finally {
        database.close();
      }
    },
  );
});

describe("Sessions Goal qualified runtime", () => {
  it.each([
    {
      scope: "session",
      goalKind: "page",
      expected: ["session-e-count-goal", "session-b-count-goal"],
    },
    {
      scope: "visitor",
      goalKind: "page",
      expected: [
        "session-e-count-goal",
        "session-b-count-goal",
        "session-a-page-goal",
      ],
    },
    {
      scope: "session",
      goalKind: "event",
      expected: ["session-e-count-goal", "session-b-count-goal"],
    },
    {
      scope: "visitor",
      goalKind: "event",
      expected: [
        "session-e-count-goal",
        "session-b-count-goal",
        "session-a-event-goal",
      ],
    },
  ] as const)(
    "$scope Count + $goalKind Goal uses one lookup and a fused paged report",
    async ({ scope, goalKind, expected }) => {
      const database = makeDatabase();
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const { runtime, diagnostics } = routeHarness(database, trace);
      const goalId = goalKind === "page" ? "goal-page" : "goal-event";
      const actual: string[] = [];
      let cursor: string | null = null;
      const pageEvidence: unknown[] = [];
      try {
        for (let pageIndex = 0; pageIndex < 4; pageIndex += 1) {
          const start = trace.preparedSql.length;
          let providerError: unknown;
          const result = (await runtime.execute(
            "sessions",
            runtimeQuery({ goalId, scope, cursor }),
            {
              onProviderError(error) {
                providerError = error;
              },
            },
          )) as AnalyticsResult<CanonicalResult<"sessions">>;
          expect(providerError).toBeUndefined();
          expect(result.ok).toBe(true);
          if (!result.ok) throw new Error("session_goal_runtime_failed");
          actual.push(...result.data.items.map((row) => row.sessionId));
          const calls = trace.preparedSql.slice(start);
          const goalLookups = calls.filter((sql) =>
            sql.includes('"analysis_definitions"'),
          );
          const fusedReports = calls.filter((sql) => sql.includes("rowKind"));
          expect(goalLookups).toHaveLength(1);
          expect(fusedReports).toHaveLength(1);
          pageEvidence.push({
            items: result.data.items,
            pagination: result.data.pagination,
            calls: calls.map((sql, index) => ({
              sql,
              bindings: trace.bindings[start + index] ?? [],
            })),
          });
          cursor = result.data.pagination.nextCursor;
          if (!cursor) break;
        }
        expect(cursor).toBeNull();
        expect(actual).toEqual(expected);
        expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
        writeEvidence(`runtime-${scope}-${goalKind}.json`, {
          state: "post-route-real-sqlite-fused-runtime",
          node: process.version,
          scope,
          goalKind,
          actual,
          pages: pageEvidence,
        });
      } finally {
        database.close();
      }
    },
  );

  it.each(candidateCases)(
    "$scope Count + $goalKind Goal + $sortKey matches the legacy bridge DTO and signed cursor",
    async ({ scope, goalKind, sortKey }) => {
      const legacyDatabase = makeDatabase(false);
      const qualifiedDatabase = makeDatabase(false);
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const legacyTrace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const { runtime, diagnostics } = routeHarness(qualifiedDatabase, trace);
      const goalId = goalKind === "page" ? "goal-page" : "goal-event";
      const sort: Sort = { key: sortKey, direction: "desc" };
      let cursor: string | null = null;
      const pages: unknown[] = [];
      try {
        for (let pageIndex = 0; pageIndex < 4; pageIndex += 1) {
          const legacy = await readLegacyPage({
            database: legacyDatabase,
            trace: legacyTrace,
            goalId,
            scope,
            sort,
            cursor,
            pageIndex,
            evidenceCase: "matrix",
          });
          const start = trace.preparedSql.length;
          let providerError: unknown;
          const qualified = await runtime.execute(
            "sessions",
            runtimeQuery({ goalId, scope, sort, cursor }),
            {
              onProviderError(error) {
                providerError = error;
              },
            },
          );
          expect(providerError).toBeUndefined();
          expect(qualified.ok).toBe(true);
          if (!qualified.ok)
            throw new Error("session_goal_qualified_runtime_failed");
          expect(qualified.data).toEqual(legacy);
          const calls = trace.preparedSql.slice(start);
          expect(
            calls.filter((sql) => sql.includes('"analysis_definitions"')),
          ).toHaveLength(1);
          expect(calls.filter((sql) => sql.includes("rowKind"))).toHaveLength(
            1,
          );
          pages.push({ legacy, qualified: qualified.data });
          cursor = legacy.pagination.nextCursor;
          if (!cursor) break;
        }
        expect(cursor).toBeNull();
        expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
        writeEvidence(
          `runtime-legacy-parity-${scope}-${goalKind}-${sortKey}.json`,
          {
            state:
              "post-route-runtime-matches-pre-route-legacy-dto-and-cursors",
            node: process.version,
            scope,
            goalKind,
            sort,
            pages,
          },
        );
      } finally {
        legacyDatabase.close();
        qualifiedDatabase.close();
      }
    },
  );

  it.each([
    { label: "missing Goal", goalId: "missing-goal" },
    { label: "invalid Goal DSL", goalId: "goal-invalid" },
  ])(
    "prioritizes Count cap over $label and a bad cursor using a mutated SQLite control row",
    async ({ goalId }) => {
      const database = makeDatabase();
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const observations: GoalBranchObservations = {
        goalLookupAttempts: 0,
        envelopes: [],
      };
      const routedDatabase = instrumentedSqliteD1Database({
        database,
        trace,
        observations,
        faults: { controlRawCount: 20_001 },
      });
      const { runtime, diagnostics } = routeHarness(
        database,
        trace,
        routedDatabase,
      );
      let providerError: unknown;
      try {
        const result = await runtime.execute(
          "sessions",
          runtimeQuery({
            goalId,
            scope: "session",
            cursor: "invalid-cursor",
          }),
          {
            onProviderError(error) {
              providerError = error;
            },
          },
        );
        expect(result).toMatchObject({
          ok: false,
          error: {
            kind: "invalid-input",
            issues: [
              { path: "filters", code: "filter_activity_limit_exceeded" },
            ],
          },
        });
        expect(providerError).toMatchObject({
          name: "AnalyticsProviderDomainError",
          domainError: {
            kind: "invalid-input",
            issues: [
              { path: "filters", code: "filter_activity_limit_exceeded" },
            ],
          },
        });
        expect(observations.goalLookupAttempts).toBe(1);
        expect(goalLookupSqlCalls(trace)).toHaveLength(1);
        expect(qualificationEnvelopeSqlCalls(trace)).toHaveLength(1);
        expect(observations.envelopes).toHaveLength(1);
        expect(observations.envelopes[0]).toMatchObject({
          controlRowCount: 1,
          reportRowCount: 0,
          rawCountAfterMutation: 20_001,
        });
        expect(observations.envelopes[0]?.rawCountBeforeMutation).not.toBe(
          20_001,
        );
        expect(legacySessionFallbackSqlCalls(trace)).toHaveLength(0);
        expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
        writeEvidence(`goal-cap-${goalId}.json`, {
          state: "sqlite-envelope-control-row-mutated-for-cap-priority",
          node: process.version,
          goalId,
          cursor: "invalid-cursor",
          publicError: result.ok ? null : result.error,
          observedError: {
            name: (providerError as Error)?.name,
            message: (providerError as Error)?.message,
          },
          mutation: {
            seededLargeFixture: false,
            sqliteRawCount: observations.envelopes[0]?.rawCountBeforeMutation,
            mutatedRawCount: 20_001,
          },
          goalLookupAttempts: observations.goalLookupAttempts,
          envelopes: observations.envelopes,
          sqlCallCounts: {
            total: trace.preparedSql.length,
            goalLookup: goalLookupSqlCalls(trace).length,
            qualificationEnvelope: qualificationEnvelopeSqlCalls(trace).length,
            legacySessionFallback: legacySessionFallbackSqlCalls(trace).length,
          },
        });
      } finally {
        database.close();
      }
    },
  );

  it("matches the actual stored-Goal reader error for invalid DSL and suppresses report rows", async () => {
    const database = makeDatabase();
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const observations: GoalBranchObservations = {
      goalLookupAttempts: 0,
      envelopes: [],
    };
    const routedDatabase = instrumentedSqliteD1Database({
      database,
      trace,
      observations,
    });
    const { runtime, diagnostics } = routeHarness(
      database,
      trace,
      routedDatabase,
    );
    const expectedReaderError = invalidGoalReaderError();
    let providerError: unknown;
    try {
      const result = await runtime.execute(
        "sessions",
        runtimeQuery({ goalId: "goal-invalid", scope: "session" }),
        {
          onProviderError(error) {
            providerError = error;
          },
        },
      );
      expect(result).toMatchObject({
        ok: false,
        error: { kind: "internal", operation: "sessions" },
      });
      expect(providerError).toBeInstanceOf(GoalConfigDecodeError);
      expect(providerError).toMatchObject({
        name: expectedReaderError.name,
        message: expectedReaderError.message,
      });
      expect(observations.goalLookupAttempts).toBe(1);
      expect(goalLookupSqlCalls(trace)).toHaveLength(1);
      expect(qualificationEnvelopeSqlCalls(trace)).toHaveLength(1);
      expect(observations.envelopes).toHaveLength(1);
      expect(observations.envelopes[0]).toMatchObject({
        controlRowCount: 1,
        reportRowCount: 0,
      });
      expect(legacySessionFallbackSqlCalls(trace)).toHaveLength(0);
      expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
      writeEvidence("goal-invalid-dsl-reader-error.json", {
        state: "stored-goal-reader-error-matches-direct-decode",
        node: process.version,
        expectedReaderError: {
          name: expectedReaderError.name,
          message: expectedReaderError.message,
        },
        observedError: {
          name: (providerError as Error).name,
          message: (providerError as Error).message,
        },
        envelopes: observations.envelopes,
        sqlCallCounts: {
          total: trace.preparedSql.length,
          goalLookup: goalLookupSqlCalls(trace).length,
          qualificationEnvelope: qualificationEnvelopeSqlCalls(trace).length,
          legacySessionFallback: legacySessionFallbackSqlCalls(trace).length,
        },
      });
    } finally {
      database.close();
    }
  });

  it("returns the fixed Goal typed-lookup error only after real Count controls finish", async () => {
    const database = makeDatabase();
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const lookupCause = new Error("wave97y_goal_lookup_cause");
    const lookupError = new Error("wave97y_goal_lookup_failed", {
      cause: lookupCause,
    });
    const observations: GoalBranchObservations = {
      goalLookupAttempts: 0,
      envelopes: [],
    };
    const routedDatabase = instrumentedSqliteD1Database({
      database,
      trace,
      observations,
      faults: { goalLookupError: lookupError },
    });
    const { runtime, diagnostics } = routeHarness(
      database,
      trace,
      routedDatabase,
    );
    let providerError: unknown;
    try {
      const result = await runtime.execute(
        "sessions",
        runtimeQuery({ goalId: "goal-page", scope: "session" }),
        {
          onProviderError(error) {
            providerError = error;
          },
        },
      );
      expect(result).toMatchObject({
        ok: false,
        error: { kind: "internal", operation: "sessions" },
      });
      expect(providerError).toBe(lookupError);
      expect((providerError as Error).cause).toBe(lookupCause);
      expect((providerError as Error).message).not.toBe("resource-not-found");
      expect(observations.goalLookupAttempts).toBe(1);
      expect(goalLookupSqlCalls(trace)).toHaveLength(1);
      expect(qualificationEnvelopeSqlCalls(trace)).toHaveLength(1);
      expect(observations.envelopes).toHaveLength(1);
      expect(observations.envelopes[0]).toMatchObject({
        controlRowCount: 1,
        reportRowCount: 0,
      });
      expect(
        trace.preparedSql.findIndex((sql) => sql.includes("rowKind")),
      ).toBeGreaterThan(
        trace.preparedSql.findIndex((sql) =>
          sql.includes('"analysis_definitions"'),
        ),
      );
      expect(legacySessionFallbackSqlCalls(trace)).toHaveLength(0);
      expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
      writeEvidence("goal-typed-lookup-error-after-count.json", {
        state: "goal-typed-lookup-error-identity-after-real-sqlite-controls",
        node: process.version,
        observedSameErrorInstance: providerError === lookupError,
        observedCauseIdentity: (providerError as Error).cause === lookupCause,
        observedError: {
          name: (providerError as Error).name,
          message: (providerError as Error).message,
          cause: {
            name: lookupCause.name,
            message: lookupCause.message,
          },
        },
        goalLookupAttempts: observations.goalLookupAttempts,
        envelopes: observations.envelopes,
        sqlCallCounts: {
          total: trace.preparedSql.length,
          goalLookup: goalLookupSqlCalls(trace).length,
          qualificationEnvelope: qualificationEnvelopeSqlCalls(trace).length,
          legacySessionFallback: legacySessionFallbackSqlCalls(trace).length,
        },
      });
    } finally {
      database.close();
    }
  });

  it("lets Count cap override a thrown Goal typed-lookup error", async () => {
    const database = makeDatabase();
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const lookupError = new Error("wave97y_goal_lookup_failed_under_cap");
    const observations: GoalBranchObservations = {
      goalLookupAttempts: 0,
      envelopes: [],
    };
    const routedDatabase = instrumentedSqliteD1Database({
      database,
      trace,
      observations,
      faults: {
        controlRawCount: 20_001,
        goalLookupError: lookupError,
      },
    });
    const { runtime, diagnostics } = routeHarness(
      database,
      trace,
      routedDatabase,
    );
    let providerError: unknown;
    try {
      const result = await runtime.execute(
        "sessions",
        runtimeQuery({
          goalId: "goal-page",
          scope: "session",
          cursor: "invalid-cursor",
        }),
        {
          onProviderError(error) {
            providerError = error;
          },
        },
      );
      expect(result).toMatchObject({
        ok: false,
        error: {
          kind: "invalid-input",
          issues: [{ path: "filters", code: "filter_activity_limit_exceeded" }],
        },
      });
      expect(providerError).not.toBe(lookupError);
      expect(providerError).toMatchObject({
        name: "AnalyticsProviderDomainError",
        domainError: {
          kind: "invalid-input",
          issues: [{ path: "filters", code: "filter_activity_limit_exceeded" }],
        },
      });
      expect(observations.goalLookupAttempts).toBe(1);
      expect(goalLookupSqlCalls(trace)).toHaveLength(1);
      expect(qualificationEnvelopeSqlCalls(trace)).toHaveLength(1);
      expect(observations.envelopes).toHaveLength(1);
      expect(observations.envelopes[0]).toMatchObject({
        controlRowCount: 1,
        reportRowCount: 0,
        rawCountAfterMutation: 20_001,
      });
      expect(observations.envelopes[0]?.rawCountBeforeMutation).not.toBe(
        20_001,
      );
      expect(legacySessionFallbackSqlCalls(trace)).toHaveLength(0);
      expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
      writeEvidence("goal-cap-typed-lookup-error.json", {
        state: "sqlite-envelope-cap-overrides-thrown-goal-lookup-error",
        node: process.version,
        mutation: {
          seededLargeFixture: false,
          sqliteRawCount: observations.envelopes[0]?.rawCountBeforeMutation,
          mutatedRawCount: 20_001,
        },
        lookupError: {
          name: lookupError.name,
          message: lookupError.message,
        },
        observedError: {
          name: (providerError as Error)?.name,
          message: (providerError as Error)?.message,
        },
        goalLookupAttempts: observations.goalLookupAttempts,
        envelopes: observations.envelopes,
        sqlCallCounts: {
          total: trace.preparedSql.length,
          goalLookup: goalLookupSqlCalls(trace).length,
          qualificationEnvelope: qualificationEnvelopeSqlCalls(trace).length,
          legacySessionFallback: legacySessionFallbackSqlCalls(trace).length,
        },
      });
    } finally {
      database.close();
    }
  });

  it("maps an abort after the Goal typed lookup without running Count or legacy reads", async () => {
    const database = makeDatabase();
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const observations: GoalBranchObservations = {
      goalLookupAttempts: 0,
      envelopes: [],
    };
    const routedDatabase = instrumentedSqliteD1Database({
      database,
      trace,
      observations,
    });
    const { runtime, diagnostics } = routeHarness(
      database,
      trace,
      routedDatabase,
    );
    const controller = new AbortController();
    const originalLookup = goalDefinitionReader.queryGoalDefinition;
    const lookupSpy = vi
      .spyOn(goalDefinitionReader, "queryGoalDefinition")
      .mockImplementation(async (env, siteId, goalId) => {
        const goal = await originalLookup(env, siteId, goalId);
        controller.abort();
        return goal;
      });
    let providerError: unknown;
    try {
      const result = await runtime.execute(
        "sessions",
        runtimeQuery({ goalId: "goal-page", scope: "session" }),
        {
          signal: controller.signal,
          onProviderError(error) {
            providerError = error;
          },
        },
      );
      expect(controller.signal.aborted).toBe(true);
      expect(result).toMatchObject({
        ok: false,
        error: { kind: "request-cancelled" },
      });
      expect(providerError).toMatchObject({
        name: "AbortError",
        message: "Aborted",
      });
      expect(lookupSpy).toHaveBeenCalledTimes(1);
      expect(observations.goalLookupAttempts).toBe(1);
      expect(goalLookupSqlCalls(trace)).toHaveLength(1);
      expect(qualificationEnvelopeSqlCalls(trace)).toHaveLength(0);
      expect(observations.envelopes).toHaveLength(0);
      expect(legacySessionFallbackSqlCalls(trace)).toHaveLength(0);
      expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
      writeEvidence("goal-abort-after-typed-lookup.json", {
        state: "abort-after-real-goal-lookup-before-count-envelope",
        node: process.version,
        publicError: result.ok ? null : result.error,
        observedError: {
          name: (providerError as Error)?.name,
          message: (providerError as Error)?.message,
        },
        goalLookupAttempts: observations.goalLookupAttempts,
        qualificationEnvelopeCount: qualificationEnvelopeSqlCalls(trace).length,
        legacySessionFallbackCount: legacySessionFallbackSqlCalls(trace).length,
      });
    } finally {
      lookupSpy.mockRestore();
      database.close();
    }
  });

  it("rejects a page cursor when the Goal ID changes", async () => {
    const database = makeDatabase();
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const { runtime } = routeHarness(database, trace);
    let providerError: unknown;
    try {
      const first = await runtime.execute(
        "sessions",
        runtimeQuery({
          goalId: "goal-page",
          scope: "session",
          limit: 1,
        }),
      );
      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error("session_goal_runtime_failed");
      expect(first.data.pagination.nextCursor).not.toBeNull();
      const start = trace.preparedSql.length;
      const changedGoal = await runtime.execute(
        "sessions",
        runtimeQuery({
          goalId: "goal-event",
          scope: "session",
          limit: 1,
          cursor: first.data.pagination.nextCursor,
        }),
        {
          onProviderError(error) {
            providerError = error;
          },
        },
      );
      expect(changedGoal.ok).toBe(false);
      expect(providerError).toMatchObject({
        name: "InvalidCursorError",
        message: "invalid-cursor",
      });
      const calls = trace.preparedSql.slice(start);
      expect(
        calls.filter((sql) => sql.includes('"analysis_definitions"')),
      ).toHaveLength(1);
      expect(calls.filter((sql) => sql.includes("rowKind"))).toHaveLength(1);
      writeEvidence("runtime-cross-goal-cursor-rejected.json", {
        state:
          "post-route-real-sqlite-cross-goal-token-rejected-after-count-controls",
        node: process.version,
        firstGoalId: "goal-page",
        secondGoalId: "goal-event",
        error: providerError,
        calls: calls.map((sql, index) => ({
          sql,
          bindings: trace.bindings[start + index] ?? [],
        })),
      });
    } finally {
      database.close();
    }
  });

  it("keeps the original missing Goal error after numeric Count fallback without a second lookup", async () => {
    const database = makeDatabase();
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "b-count-goal");
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const { runtime, diagnostics } = routeHarness(database, trace);
    let providerError: unknown;
    try {
      const result = await runtime.execute(
        "sessions",
        runtimeQuery({
          goalId: "missing-goal",
          scope: "session",
          countFilter: parseFilterDsl(
            "count(page { page.durationMs gt 5 }) eq 1",
            analyticsFilterRegistry,
          ),
        }),
        {
          onProviderError(error) {
            providerError = error;
          },
        },
      );
      expect(result.ok).toBe(false);
      expect((providerError as Error)?.message).toBe("resource-not-found");
      expect(
        trace.preparedSql.filter((sql) =>
          sql.includes('"analysis_definitions"'),
        ),
      ).toHaveLength(1);
      expect(diagnostics.advancedCountSqlFallbackReason).toMatchObject({
        kind: "numeric-data-domain",
        fieldIds: ["page.durationMs"],
      });
      writeEvidence("runtime-numeric-fallback-missing-goal.json", {
        state: "post-route-real-sqlite-controls-then-legacy-count-fallback",
        node: process.version,
        error: (providerError as Error)?.message,
        fallbackReason: diagnostics.advancedCountSqlFallbackReason,
        calls: trace.preparedSql.map((sql, index) => ({
          sql,
          bindings: trace.bindings[index] ?? [],
        })),
      });
    } finally {
      database.close();
    }
  });

  it("reuses the resolved Goal through numeric Count fallback", async () => {
    const database = makeDatabase();
    const legacyDatabase = makeDatabase();
    const legacyTrace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const countFilter = parseFilterDsl(
      "count(page { page.durationMs gt 5 }) eq 1",
      analyticsFilterRegistry,
    );
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "e-count-goal");
    legacyDatabase
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "e-count-goal");
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const { runtime, diagnostics } = routeHarness(database, trace);
    let providerError: unknown;
    try {
      const result = await runtime.execute(
        "sessions",
        runtimeQuery({
          goalId: "goal-page",
          scope: "session",
          limit: 20,
          countFilter,
        }),
        {
          onProviderError(error) {
            providerError = error;
          },
        },
      );
      expect(providerError).toBeUndefined();
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("session_goal_numeric_fallback_failed");
      const legacy = await readLegacyPage({
        database: legacyDatabase,
        trace: legacyTrace,
        goalId: "goal-page",
        scope: "session",
        sort: { key: "startedAt", direction: "desc" },
        cursor: null,
        pageIndex: 0,
        evidenceCase: "numeric-fallback",
        limit: 20,
        countFilter,
      });
      expect(result.data).toEqual(legacy);
      expect(
        trace.preparedSql.filter((sql) =>
          sql.includes('"analysis_definitions"'),
        ),
      ).toHaveLength(1);
      expect(diagnostics.advancedCountSqlFallbackReason).toMatchObject({
        kind: "numeric-data-domain",
        fieldIds: ["page.durationMs"],
      });
      writeEvidence("runtime-numeric-fallback-goal-reused.json", {
        state: "post-route-real-sqlite-whole-count-fallback-reuses-parsed-goal",
        node: process.version,
        items: result.data.items,
        fallbackReason: diagnostics.advancedCountSqlFallbackReason,
        calls: trace.preparedSql.map((sql, index) => ({
          sql,
          bindings: trace.bindings[index] ?? [],
        })),
      });
    } finally {
      database.close();
      legacyDatabase.close();
    }
  });

  it("treats a valid Goal with no matching Session as an empty successful result", async () => {
    const database = makeDatabase();
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const { runtime } = routeHarness(database, trace);
    try {
      const result = await runtime.execute(
        "sessions",
        runtimeQuery({
          goalId: "goal-no-match",
          scope: "session",
          limit: 20,
        }),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("session_goal_runtime_failed");
      expect(result.data.items).toEqual([]);
      expect(result.data.pagination.nextCursor).toBeNull();
      expect(
        trace.preparedSql.filter((sql) =>
          sql.includes('"analysis_definitions"'),
        ),
      ).toHaveLength(1);
      expect(
        trace.preparedSql.filter((sql) => sql.includes("rowKind")),
      ).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it("admits exact Goal and Funnel analysis contexts for Sessions", () => {
    const query = runtimeQuery({
      goalId: "goal-page",
      scope: "session",
    });
    const prepared = prepareScopedQuery("sessions", query);
    expect(
      sessionListQualificationRequest.sessionListQualificationConfigurationFromQuery(
        prepared,
      ),
    ).toMatchObject({ analysisContext: { type: "goal", goalId: "goal-page" } });
    const funnelContext = {
      type: "funnel",
      funnelId: "funnel-1",
      stepId: "step-1",
    } as const;
    const funnelWithoutOutcome =
      sessionListQualificationRequest.sessionListQualificationConfigurationFromQuery(
        { ...prepared, analysisContext: funnelContext },
      );
    expect(funnelWithoutOutcome?.analysisContext).toEqual(funnelContext);
    const funnelWithOutcome =
      sessionListQualificationRequest.sessionListQualificationConfigurationFromQuery(
        {
          ...prepared,
          analysisContext: { ...funnelContext, outcome: "converted" },
        },
      );
    expect(funnelWithOutcome?.analysisContext).toEqual({
      ...funnelContext,
      outcome: "converted",
    });
    expect(
      sessionListQualificationRequest.sessionListQualificationConfigurationFromQuery(
        {
          ...prepared,
          analysisContext: { ...funnelContext, extra: true },
        },
      ),
    ).toBeUndefined();
    expect(
      sessionListQualificationRequest.sessionListQualificationConfigurationFromQuery(
        {
          ...prepared,
          analysisContext: { ...funnelContext, outcome: "invalid" },
        },
      ),
    ).toBeUndefined();
    expect(
      sessionListQualificationRequest.sessionListQualificationConfigurationFromQuery(
        {
          ...prepared,
          analysisContext: funnelContext,
          visitorId: "visitor-a",
        },
        "visitor-sessions",
      ),
    ).toBeUndefined();
  });

  it("executes Count controls with the report rows suppressed", async () => {
    const database = makeDatabase();
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const env = {
      DB: createSqliteD1Database(database, trace),
      MAIN_SECRET: "wave97y-session-goal-qualified-secret",
    } as unknown as Env;
    try {
      const { prepared, count } = preparedQualificationInput("session");
      const plan = buildJourneySessionListQualificationPlan({
        siteId: SITE_ID,
        queryTime: prepared.time,
        filters: prepared.filters,
        scopePlan: prepared.scopePlan,
        count,
        limit: 1,
        sort: { key: "startedAt", direction: "desc" },
        suppressReportRows: true,
      });
      const compilation = compileSessionEnvelope({
        plan,
        siteId: SITE_ID,
        sort: { key: "startedAt", direction: "desc" },
      });
      expect(compilation.kind).toBe("compiled");
      if (compilation.kind !== "compiled")
        throw new Error("session_goal_controls_compile_unavailable");
      const rows = await queryD1CompiledAll(env, compilation.query);
      expect(
        rows.filter(
          (row) =>
            row.rowKind === "control" &&
            row.outputId === PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT,
        ),
      ).toHaveLength(1);
      expect(
        rows.filter(
          (row) =>
            row.rowKind === "report" &&
            row.outputId === JOURNEY_SESSION_LIST_REPORT_OUTPUT,
        ),
      ).toHaveLength(0);
      writeEvidence("controls-only-count-envelope.json", {
        state: "pre-route-real-sqlite-controls-only",
        node: process.version,
        sqlBytes: compilation.evidence.sqlBytes,
        bindingCount: compilation.evidence.bindingCount,
        rows,
        call: {
          sql: trace.preparedSql[0],
          bindings: trace.bindings[0],
        },
      });
    } finally {
      database.close();
    }
  });
});
