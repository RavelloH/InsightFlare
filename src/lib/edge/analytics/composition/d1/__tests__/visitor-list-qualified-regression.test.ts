import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { createD1SiteQueryRuntime } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import {
  type CanonicalQuery,
  createQueryTime,
  EMPTY_FILTER_DOCUMENT,
  type FilterDocument,
  prepareScopedQuery,
  type QueryInput,
  type QueryTime,
  type ScopedFilterPlan,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import type { VisitorListSortKey } from "@/lib/edge/analytics/contract/types";
import type { AdvancedCountFilterMatchPlanInput } from "@/lib/edge/analytics/engine/advanced-count-filter-plan";
import { JOURNEY_VISITOR_LIST_REPORT_OUTPUT } from "@/lib/edge/analytics/engine/journey-entity-list-report-plan";
import {
  buildJourneyVisitorGoalListQualificationPlan,
  buildJourneyVisitorListQualificationPlan,
} from "@/lib/edge/analytics/engine/journey-visitor-list-qualification-plan";
import { PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT } from "@/lib/edge/analytics/engine/page-dimension-qualification-plan";
import { splitPageDimensionNativeFilters } from "@/lib/edge/analytics/engine/qualified-page-source";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { classifyAdvancedCountFilter } from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-count-support";
import {
  d1AdvancedFilterMiddleware,
  deferredEventQualificationFromQuery,
  prepareDeferredEventQualificationFallback,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { queryD1CompiledAll } from "@/lib/edge/analytics/providers/d1/internal/core";
import { mapVisitors } from "@/lib/edge/analytics/providers/d1/internal/core-mappers";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import { mapVisitorRow } from "@/lib/edge/analytics/providers/d1/internal/journey-helpers";
import { visitorListPageFromRecords } from "@/lib/edge/analytics/providers/d1/internal/journey-list-queries";
import { compileQualificationProgramEnvelope } from "@/lib/edge/analytics/providers/d1/internal/qualification-program-envelope";
import { executeVisitorListQualificationProgram } from "@/lib/edge/analytics/providers/d1/internal/visitor-list-qualification-program";
import {
  deferredVisitorListQualificationFromQuery,
  visitorListQualificationConfigurationFromQuery,
} from "@/lib/edge/analytics/providers/d1/internal/visitor-list-qualification-request";
import {
  readSiteVisitors,
  readSiteVisitorsWithResolvedAnalysis,
  type VisitorSort,
} from "@/lib/edge/analytics/providers/d1/operations/site-journeys";
import type { Env } from "@/lib/edge/types";
import { parseFilterDsl } from "@/lib/filter-contract";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";

const SITE_ID = "wave97r-visitor-list";
const BASE = Date.UTC(2026, 9, 1);
const END = BASE + 24 * 60 * 60 * 1000;
const FILTER_DSL =
  'page.path eq "/match" and count(page { page.path eq "/match" }) gte 1';
const GOAL_COUNT_FILTER_DSL =
  'page.hostname eq "baseline.test" and count(page { page.path eq "/match" }) gte 1';
const GOAL_NUMERIC_COUNT_FILTER_DSL =
  "count(page { page.durationMs gt 5 }) eq 1";
const EVIDENCE_DIRECTORY = process.env.INSIGHTFLARE_VISITOR_LIST_EVIDENCE_DIR;
const GOAL_EVIDENCE_DIRECTORY =
  process.env.INSIGHTFLARE_VISITOR_GOAL_EVIDENCE_DIR?.trim();
const SORT_KEYS: readonly VisitorListSortKey[] = [
  "firstSeenAt",
  "lastSeenAt",
  "sessions",
  "views",
];

function visitorQuery(input: {
  readonly scope?: "session" | "visitor";
  readonly sortKey: VisitorListSortKey;
  readonly direction: "asc" | "desc";
  readonly cursor?: string | null;
  readonly advanced: boolean;
  readonly search?: string;
  readonly limit?: number;
  readonly filterDsl?: string;
  readonly goalId?: string;
}): CanonicalQuery<"visitors"> {
  return {
    context: siteQueryContext(SITE_ID, "private-dashboard"),
    time: createQueryTime(BASE, END, "UTC", END),
    filters: input.advanced
      ? parseFilterDsl(input.filterDsl ?? FILTER_DSL, analyticsFilterRegistry)
      : EMPTY_FILTER_DOCUMENT,
    ...(input.scope ? { scopePreference: input.scope } : {}),
    ...(input.goalId
      ? { analysisContext: { type: "goal" as const, goalId: input.goalId } }
      : {}),
    page: { limit: input.limit ?? 1, cursor: input.cursor ?? null },
    ...(input.search !== undefined ? { search: input.search } : {}),
    sort: { key: input.sortKey, direction: input.direction },
  } as CanonicalQuery<"visitors">;
}

function preparedQualificationInput(
  scope: "session" | "visitor",
  filterDsl = FILTER_DSL,
) {
  const prepared = prepareScopedQuery(
    "visitors",
    visitorQuery({
      scope,
      sortKey: "lastSeenAt",
      direction: "desc",
      advanced: true,
      filterDsl,
    }),
  ) as QueryInput & {
    readonly time: QueryTime;
    readonly filters: FilterDocument;
    readonly scopePlan: ScopedFilterPlan;
  };
  const readRange = prepared.time.readRange ?? prepared.time.range;
  const split = splitPageDimensionNativeFilters(prepared.filters);
  if (split.kind !== "supported")
    throw new Error("visitor_list_test_native_split_unavailable");
  const support = classifyAdvancedCountFilter(split.advancedFilters, scope);
  if (support.kind !== "supported")
    throw new Error(
      `visitor_list_test_count_support_unavailable:${support.code}`,
    );
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
    analysis: support.analysis,
    numericCompatibilityRequirements: support.numericCompatibilityRequirements,
  };
  return { prepared, count };
}

function visitorCursor(
  row: ReturnType<typeof mapVisitorRow>,
  sortKey: VisitorListSortKey,
) {
  const sortValue = row[sortKey];
  return sortKey === "lastSeenAt"
    ? { sortValue, visitorId: row.visitorId }
    : { sortValue, lastSeenAt: row.lastSeenAt, visitorId: row.visitorId };
}

function compileVisitorEnvelope(input: {
  readonly plan: ReturnType<typeof buildJourneyVisitorListQualificationPlan>;
  readonly sortKey: VisitorListSortKey;
}) {
  const report = input.plan.plan.outputs.find(
    ({ id }) => id === JOURNEY_VISITOR_LIST_REPORT_OUTPUT,
  );
  const controls = input.plan.plan.outputs.find(
    ({ id }) => id === PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT,
  );
  if (!report || !controls) throw new Error("visitor_list_outputs_missing");
  const reportFields = report.fields.map(({ name }) => name);
  const ordering = [
    {
      outputId: JOURNEY_VISITOR_LIST_REPORT_OUTPUT,
      field: input.sortKey,
      direction: "desc" as const,
      nulls: "last" as const,
    },
    ...(input.sortKey === "lastSeenAt"
      ? []
      : [
          {
            outputId: JOURNEY_VISITOR_LIST_REPORT_OUTPUT,
            field: "lastSeenAt",
            direction: "desc" as const,
            nulls: "last" as const,
          },
        ]),
    {
      outputId: JOURNEY_VISITOR_LIST_REPORT_OUTPUT,
      field: "visitorId",
      direction: "asc" as const,
      nulls: "last" as const,
    },
  ];
  return compileQualificationProgramEnvelope({
    qualification: input.plan,
    siteId: SITE_ID,
    reports: [
      { output: report, fields: reportFields, rowType: "visitor-list" },
    ],
    controlsOutput: controls,
    reportFields,
    controlFields: controls.fields.map(({ name }) => name),
    ordering,
    errorPrefix: "visitor_list_qualification",
    fallbackTag: "analytics.visitor_list_qualification",
  });
}

function writeStageAEvidence(filename: string, value: unknown): void {
  if (!EVIDENCE_DIRECTORY) return;
  mkdirSync(EVIDENCE_DIRECTORY, { recursive: true });
  writeFileSync(
    join(EVIDENCE_DIRECTORY, filename),
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
}

function d1WithEnvelopeRowTransform(
  database: DatabaseSync,
  trace: SqliteD1Trace,
  transform: (row: Record<string, unknown>) => Record<string, unknown>,
  options: {
    readonly goalLookupError?: Error;
    readonly afterGoalLookup?: () => void;
    readonly onEnvelopeRows?: (
      rows: readonly Record<string, unknown>[],
    ) => void;
  } = {},
): NonNullable<Env["DB"]> {
  const base = createSqliteD1Database(database, trace);
  const proxy = {
    prepare(sql: string) {
      const statement = base.prepare(sql);
      const prepared = {
        bind(...values: Parameters<typeof statement.bind>) {
          statement.bind(...values);
          return prepared;
        },
        first<Row>() {
          return statement.first<Row>();
        },
        async all<Row>() {
          const result = await statement.all<Row>();
          if (sql.includes('"analysis_definitions"')) {
            if (options.goalLookupError) throw options.goalLookupError;
            options.afterGoalLookup?.();
          }
          if (!sql.includes('"rowKind"') || !sql.includes('"outputId"'))
            return result;
          options.onEnvelopeRows?.(
            result.results as readonly Record<string, unknown>[],
          );
          return {
            ...result,
            results: result.results.map(
              (row) => transform(row as Record<string, unknown>) as Row,
            ),
          };
        },
        run() {
          return statement.run();
        },
      };
      return prepared;
    },
    batch(statements: Parameters<typeof base.batch>[0]) {
      return base.batch(statements);
    },
  };
  return proxy as unknown as NonNullable<Env["DB"]>;
}

async function visitorMiddlewareQuery(
  env: Env,
  request: CanonicalQuery<"visitors">,
  execution?: { readonly signal?: AbortSignal },
): Promise<QueryInput & Record<string, unknown>> {
  const prepared = prepareScopedQuery(
    "visitors",
    request,
  ) as unknown as QueryInput & Record<string, unknown>;
  let middlewareQuery: unknown;
  await d1AdvancedFilterMiddleware(env, undefined, SITE_ID)(
    "visitors",
    prepared,
    async (nextQuery) => {
      middlewareQuery = nextQuery;
      return nextQuery;
    },
    execution,
  );
  if (!middlewareQuery || typeof middlewareQuery !== "object")
    throw new Error("visitor_middleware_query_missing");
  return middlewareQuery as QueryInput & Record<string, unknown>;
}

async function directVisitorGoalProgramInput(input: {
  readonly env: Env;
  readonly scope: "session" | "visitor";
  readonly goalId: string;
  readonly sortKey?: VisitorListSortKey;
  readonly cursor?: string | null;
  readonly filterDsl?: string;
  readonly execution?: { readonly signal?: AbortSignal };
}) {
  const request = visitorQuery({
    scope: input.scope,
    sortKey: input.sortKey ?? "lastSeenAt",
    direction: "desc",
    cursor: input.cursor,
    advanced: true,
    filterDsl: input.filterDsl ?? GOAL_COUNT_FILTER_DSL,
    goalId: input.goalId,
  });
  const query = await visitorMiddlewareQuery(
    input.env,
    request,
    input.execution,
  );
  const deferred = deferredVisitorListQualificationFromQuery(query);
  if (!deferred) throw new Error("visitor_goal_pre_route_request_not_branded");
  return { request, query, deferred, goalId: input.goalId };
}

async function executeDirectVisitorGoalProgram(input: {
  readonly env: Env;
  readonly query: QueryInput & Record<string, unknown>;
  readonly deferred: NonNullable<
    ReturnType<typeof deferredVisitorListQualificationFromQuery>
  >;
}) {
  return executeVisitorListQualificationProgram({
    env: input.env,
    query: input.query,
    deferred: input.deferred,
  });
}

function visitorGoalRuntimeRequest(input: {
  readonly goalId: string;
  readonly scope: "session" | "visitor";
  readonly cursor?: string | null;
  readonly sortKey?: VisitorListSortKey;
  readonly filterDsl?: string;
}): CanonicalQuery<"visitors"> {
  return visitorQuery({
    scope: input.scope,
    sortKey: input.sortKey ?? "lastSeenAt",
    direction: "desc",
    cursor: input.cursor,
    advanced: true,
    filterDsl: input.filterDsl ?? GOAL_COUNT_FILTER_DSL,
    goalId: input.goalId,
    limit: 1,
  });
}

function goalLookupSqlCalls(trace: SqliteD1Trace): string[] {
  return trace.preparedSql.filter((sql) =>
    sql.includes('"analysis_definitions"'),
  );
}

function qualificationEnvelopeSqlCalls(trace: SqliteD1Trace): string[] {
  return trace.preparedSql.filter(
    (sql) => sql.includes('"rowKind"') && sql.includes('"outputId"'),
  );
}

async function legacyVisitorPage(
  env: Env,
  request: CanonicalQuery<"visitors">,
) {
  const middlewareQuery = await visitorMiddlewareQuery(env, request);
  const deferred = deferredEventQualificationFromQuery(
    middlewareQuery,
    "visitors",
  );
  if (!deferred)
    throw new Error("legacy_control_visitor_qualification_missing");
  const filters = await prepareDeferredEventQualificationFallback(deferred);
  const sort: VisitorSort = {
    field:
      (request.sort?.key as VisitorListSortKey | undefined) ?? "lastSeenAt",
    direction: request.sort?.direction === "asc" ? "asc" : "desc",
  };
  return readSiteVisitors({
    env,
    siteId: SITE_ID,
    window: {
      startMs: request.time.range.startMs,
      endExclusiveMs: request.time.range.endExclusiveMs,
      nowMs: request.time.capturedAtMs,
      timeZone: request.time.reportingTimeZone,
    },
    filters,
    sort,
    search:
      typeof request.search === "string" && request.search
        ? request.search
        : undefined,
    page: {
      limit: request.page?.limit ?? request.limit ?? 80,
      cursor: request.page?.cursor ?? request.cursor ?? null,
    },
    audience: request.context.policy.audience,
    analysisContext: request.analysisContext,
  });
}

async function ordinaryVisitorPage(
  env: Env,
  request: CanonicalQuery<"visitors">,
) {
  const sort: VisitorSort = {
    field:
      (request.sort?.key as VisitorListSortKey | undefined) ?? "lastSeenAt",
    direction: request.sort?.direction === "asc" ? "asc" : "desc",
  };
  return readSiteVisitors({
    env,
    siteId: SITE_ID,
    window: {
      startMs: request.time.range.startMs,
      endExclusiveMs: request.time.range.endExclusiveMs,
      nowMs: request.time.capturedAtMs,
      timeZone: request.time.reportingTimeZone,
    },
    filters: request.filters ?? EMPTY_FILTER_DOCUMENT,
    sort,
    search:
      typeof request.search === "string" && request.search
        ? request.search
        : undefined,
    page: {
      limit: request.page?.limit ?? request.limit ?? 80,
      cursor: request.page?.cursor ?? request.cursor ?? null,
    },
    audience: request.context.policy.audience,
    analysisContext: request.analysisContext,
  });
}

function seedFixture(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = OFF");
  database
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .run(SITE_ID);
  const site = database
    .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
    .get(SITE_ID) as { readonly site_pk: number };
  database
    .prepare(
      `INSERT INTO sites (id, team_id, name, domain, created_at)
       VALUES (?, 'wave97r-team', 'Visitor list baseline', 'baseline.test', 0)`,
    )
    .run(SITE_ID);

  const visits = [
    ["v1-match-1", "visitor-1", "session-1", BASE + 1_000, "/match"],
    ["v1-extra-1", "visitor-1", "session-1", BASE + 2_000, "/extra"],
    ["v1-extra-2", "visitor-1", "session-1-extra", BASE + 3_000, "/extra"],
    ["v2-match-1", "visitor-2", "session-2", BASE + 4_000, "/match"],
    ["v3-match-1", "visitor-3", "session-3", BASE + 5_000, "/match"],
    ["v4-other-1", "visitor-4", "session-4", BASE + 6_000, "/other"],
  ] as const;
  const insert = database.prepare(
    `INSERT INTO visits (
      visit_id, site_id, site_pk, visitor_id, session_id, status,
      started_at, last_activity_at, pathname, hostname
    ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, 'baseline.test')`,
  );
  for (const [visitId, visitorId, sessionId, startedAt, pathname] of visits) {
    insert.run(
      visitId,
      SITE_ID,
      site.site_pk,
      visitorId,
      sessionId,
      startedAt,
      startedAt + 500,
      pathname,
    );
  }
}

function seedGoalFixture(database: DatabaseSync): void {
  seedFixture(database);
  const sitePk = (
    database
      .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
      .get(SITE_ID) as { readonly site_pk: number }
  ).site_pk;
  const goalVisits = [
    [
      "v1-match-goal-page",
      "visitor-1",
      "session-1",
      BASE + 6_500,
      "/goal-page",
    ],
    [
      "v2-match-goal-page",
      "visitor-2",
      "session-2",
      BASE + 6_750,
      "/goal-page",
    ],
    [
      "v1-goal-page",
      "visitor-1",
      "session-1-goal-page",
      BASE + 7_000,
      "/goal-page",
    ],
    [
      "v2-goal-page",
      "visitor-2",
      "session-2-goal-page",
      BASE + 8_000,
      "/goal-page",
    ],
    [
      "v4-goal-page",
      "visitor-4",
      "session-4-goal-page",
      BASE + 9_000,
      "/goal-page",
    ],
    [
      "v2-goal-event",
      "visitor-2",
      "session-2-goal-event",
      BASE + 10_000,
      "/goal-event",
    ],
    [
      "v3-goal-event",
      "visitor-3",
      "session-3-goal-event",
      BASE + 11_000,
      "/goal-event",
    ],
    [
      "v4-goal-event",
      "visitor-4",
      "session-4-goal-event",
      BASE + 12_000,
      "/goal-event",
    ],
    ["v5-match-1", "visitor-5", "session-5", BASE + 13_000, "/match"],
    [
      "v5-goal-page",
      "visitor-5",
      "session-5-goal-page",
      BASE + 14_000,
      "/goal-page",
    ],
    [
      "v5-goal-event",
      "visitor-5",
      "session-5-goal-event",
      BASE + 15_000,
      "/goal-event",
    ],
  ] as const;
  for (const [visitId, visitorId, sessionId, startedAt, pathname] of goalVisits)
    insertVisit(database, {
      sitePk,
      visitId,
      visitorId,
      sessionId,
      startedAt,
      pathname,
    });

  database
    .prepare(
      `INSERT INTO custom_event_names (site_id, name, last_seen_at, site_pk)
       VALUES (?, 'signup', ?, ?)
       ON CONFLICT(site_pk, name) DO NOTHING`,
    )
    .run(SITE_ID, BASE + 12_000, sitePk);
  const eventNameId = (
    database
      .prepare(
        "SELECT id FROM custom_event_names WHERE site_pk = ? AND name = 'signup'",
      )
      .get(sitePk) as { readonly id: number }
  ).id;
  const insertEvent = database.prepare(
    `INSERT INTO custom_events (
      event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
      received_at, sequence, node_count, value_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 0)`,
  );
  for (const visitId of [
    "v2-match-1",
    "v3-match-1",
    "v2-goal-event",
    "v3-goal-event",
    "v4-goal-event",
    "v5-goal-event",
  ])
    insertEvent.run(
      `event-${visitId}`,
      SITE_ID,
      sitePk,
      visitId,
      eventNameId,
      BASE + 13_000,
      BASE + 13_000,
    );

  const insertGoal = database.prepare(
    `INSERT INTO analysis_definitions (
      id, site_id, kind, name, config_json, config_version, created_at, updated_at
    ) VALUES (?, ?, 'goal', ?, ?, 1, ?, ?)`,
  );
  for (const [id, filterDsl] of [
    ["goal-page", 'page.path eq "/goal-page"'],
    ["goal-event", 'event.name eq "signup"'],
  ] as const)
    insertGoal.run(
      id,
      SITE_ID,
      id,
      JSON.stringify({ filterDslVersion: 1, filterDsl }),
      BASE,
      BASE,
    );
}

function insertInvalidGoalDefinition(database: DatabaseSync): void {
  database
    .prepare(
      `INSERT INTO analysis_definitions (
        id, site_id, kind, name, config_json, config_version, created_at, updated_at
      ) VALUES (?, ?, 'goal', ?, ?, 1, ?, ?)`,
    )
    .run(
      "goal-invalid",
      SITE_ID,
      "goal-invalid",
      JSON.stringify({ filterDslVersion: 1, filterDsl: 'page.path eq "' }),
      BASE,
      BASE,
    );
}

function insertVisit(
  database: DatabaseSync,
  input: {
    readonly siteId?: string;
    readonly sitePk?: number;
    readonly visitId: string;
    readonly visitorId: string;
    readonly sessionId: string;
    readonly startedAt: number;
    readonly pathname: string;
    readonly hostname?: string;
  },
): void {
  const siteId = input.siteId ?? SITE_ID;
  const sitePk =
    input.sitePk ??
    (
      database
        .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
        .get(siteId) as { readonly site_pk: number }
    ).site_pk;
  database
    .prepare(
      `INSERT INTO visits (
        visit_id, site_id, site_pk, visitor_id, session_id, status,
        started_at, last_activity_at, pathname, hostname
      ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, ?)`,
    )
    .run(
      input.visitId,
      siteId,
      sitePk,
      input.visitorId,
      input.sessionId,
      input.startedAt,
      input.startedAt + 500,
      input.pathname,
      input.hostname ?? "baseline.test",
    );
}

function seedEventOnlyOwnerOutsideWindow(database: DatabaseSync): void {
  const sitePk = (
    database
      .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
      .get(SITE_ID) as { readonly site_pk: number }
  ).site_pk;
  database
    .prepare(
      `INSERT INTO custom_event_names (site_id, name, last_seen_at, site_pk)
       VALUES (?, 'signup', ?, ?)
       ON CONFLICT(site_pk, name) DO NOTHING`,
    )
    .run(SITE_ID, BASE + 1_000, sitePk);
  const eventName = database
    .prepare(
      "SELECT id FROM custom_event_names WHERE site_pk = ? AND name = 'signup'",
    )
    .get(sitePk) as { readonly id: number };
  insertVisit(database, {
    sitePk,
    visitId: "visitor-event-owner-outside-window",
    visitorId: "visitor-event-only",
    sessionId: "",
    startedAt: BASE - 24 * 60 * 60 * 1_000,
    pathname: "/outside-window",
  });
  database
    .prepare(
      `INSERT INTO custom_events (
        event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
        received_at, node_count, value_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)`,
    )
    .run(
      "visitor-event-only-signup",
      SITE_ID,
      sitePk,
      "visitor-event-owner-outside-window",
      eventName.id,
      BASE + 1_000,
      BASE + 1_000,
    );
}

function writeBeforeEvidence(value: unknown): void {
  if (!EVIDENCE_DIRECTORY) return;
  mkdirSync(EVIDENCE_DIRECTORY, { recursive: true });
  const path = join(EVIDENCE_DIRECTORY, "provider-before.json");
  if (existsSync(path))
    throw new Error("visitor_before_capture_already_exists");
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeGoalBeforeEvidence(filename: string, value: unknown): void {
  if (!GOAL_EVIDENCE_DIRECTORY) return;
  mkdirSync(GOAL_EVIDENCE_DIRECTORY, { recursive: true });
  const path = join(GOAL_EVIDENCE_DIRECTORY, filename);
  if (existsSync(path))
    throw new Error("visitor_goal_before_capture_already_exists");
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeGoalStageEvidence(filename: string, value: unknown): void {
  if (!GOAL_EVIDENCE_DIRECTORY) return;
  mkdirSync(GOAL_EVIDENCE_DIRECTORY, { recursive: true });
  const path = join(GOAL_EVIDENCE_DIRECTORY, filename);
  if (existsSync(path)) return;
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

// This one-time harness is disabled immediately after the actual legacy runtime
// capture so future runs cannot replace the pre-rewire evidence.
describe.skip("Visitors provider pre-rewire runtime reference", () => {
  it("captures actual legacy DTO, SQL, binds, and signed cursors before rewiring", async () => {
    const database = createMigratedDatabase();
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const env = {
      DB: createSqliteD1Database(database, trace),
      MAIN_SECRET: "wave97r-visitor-list-baseline-secret",
    } as unknown as Env;
    try {
      seedFixture(database);
      const runtime = createD1SiteQueryRuntime({ env, siteId: SITE_ID });
      const scenarios: Array<Record<string, unknown>> = [];
      const capture = async (input: {
        readonly kind: "advanced" | "ordinary-no-advanced-filter";
        readonly scope?: "session" | "visitor";
        readonly sortKey: VisitorListSortKey;
      }) => {
        let cursor: string | null = null;
        for (const page of [1, 2] as const) {
          const sqlStart = trace.preparedSql.length;
          const bindingsStart = trace.bindings.length;
          const request = visitorQuery({
            ...(input.scope ? { scope: input.scope } : {}),
            sortKey: input.sortKey,
            direction: "desc",
            cursor,
            advanced: input.kind === "advanced",
          });
          const prepared = prepareScopedQuery("visitors", request);
          const result = await runtime.execute("visitors", prepared);
          expect(
            result.ok,
            `${input.kind}/${input.scope}/${input.sortKey}`,
          ).toBe(true);
          if (!result.ok)
            throw new Error("visitor_before_provider_query_failed");
          const calls = trace.preparedSql.slice(sqlStart).map((sql, index) => ({
            sql,
            bindings: trace.bindings[bindingsStart + index] ?? [],
          }));
          expect(calls.length).toBeGreaterThan(0);
          scenarios.push({
            kind: input.kind,
            ...(input.scope ? { scope: input.scope } : {}),
            sort: { key: input.sortKey, direction: "desc" },
            page,
            requestCursor: cursor,
            dto: result.data,
            nextCursor: result.data.pagination.nextCursor,
            sqlBytes: calls.map(
              (call) => new TextEncoder().encode(call.sql).byteLength,
            ),
            bindCounts: calls.map((call) => call.bindings.length),
            calls,
          });
          cursor = result.data.pagination.nextCursor;
          if (page === 1) expect(cursor).toEqual(expect.any(String));
          else expect(result.data.pagination.returned).toBeGreaterThan(0);
        }
      };

      for (const scope of ["session", "visitor"] as const)
        for (const sortKey of SORT_KEYS)
          await capture({ kind: "advanced", scope, sortKey });
      for (const sortKey of SORT_KEYS)
        await capture({ kind: "ordinary-no-advanced-filter", sortKey });

      writeBeforeEvidence({
        state: "actual-pre-rewire-runtime-capture",
        route:
          "createD1SiteQueryRuntime -> visitors -> d1AdvancedFilterMiddleware -> readSiteVisitors -> queryVisitorListPageFromD1",
        head: process.env.INSIGHTFLARE_VISITOR_LIST_BASELINE_HEAD ?? null,
        nodeVersion: process.version,
        cwd: process.cwd(),
        siteId: SITE_ID,
        window: { startMs: BASE, endExclusiveMs: END, timeZone: "UTC" },
        filterDsl: FILTER_DSL,
        pageLimit: 1,
        scenarios,
      });
      expect(scenarios).toHaveLength(24);
    } finally {
      database.close();
    }
  });
});

describe.skip("Visitors Goal context before-route public runtime baseline", () => {
  it.each([
    ["page", "session"],
    ["page", "visitor"],
    ["event", "session"],
    ["event", "visitor"],
  ] as const)(
    "captures the old Count bridge and same-secret %s/%s DTOs and cursors",
    async (goalKind, scope) => {
      expect(GOAL_EVIDENCE_DIRECTORY).toEqual(expect.any(String));
      const database = createMigratedDatabase();
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const env = {
        DB: createSqliteD1Database(database, trace),
        MAIN_SECRET: "wave97r-visitor-list-baseline-secret",
      } as unknown as Env;
      try {
        seedGoalFixture(database);
        const runtime = createD1SiteQueryRuntime({ env, siteId: SITE_ID });
        const goal =
          goalKind === "page"
            ? { goalId: "goal-page", filterDsl: 'page.path eq "/goal-page"' }
            : { goalId: "goal-event", filterDsl: 'event.name eq "signup"' };
        const bridgeRequest = visitorQuery({
          goalId: goal.goalId,
          scope,
          sortKey: "lastSeenAt",
          direction: "desc",
          advanced: true,
          filterDsl: GOAL_COUNT_FILTER_DSL,
        });
        const bridgeQuery = await visitorMiddlewareQuery(env, bridgeRequest);
        const advancedMatches = bridgeQuery.scopePlan?.advancedMatches;
        expect(
          visitorListQualificationConfigurationFromQuery(bridgeRequest),
        ).toBeUndefined();
        expect(
          deferredEventQualificationFromQuery(bridgeQuery, "visitors"),
        ).toBeUndefined();
        expect(advancedMatches?.entityIds?.length).toBeGreaterThan(0);
        const bridge = {
          requestConfiguration: "visitor-list-goal-context-not-admitted",
          countBridge:
            "evaluateForSites -> scopePlan.advancedMatches.entityIds",
          advancedMatchEntityIds: advancedMatches?.entityIds ?? [],
        };

        const scenarios: Array<Record<string, unknown>> = [];
        const capture = async (input: {
          readonly goalKind: "page" | "event";
          readonly goalId: string;
          readonly goalMode: "count-and-goal" | "ordinary-goal";
          readonly scope?: "session" | "visitor";
          readonly sortKey: VisitorListSortKey;
        }) => {
          let cursor: string | null = null;
          const pages: Array<Record<string, unknown>> = [];
          for (const pageIndex of [0, 1] as const) {
            const sqlStart = trace.preparedSql.length;
            const bindingsStart = trace.bindings.length;
            const request = visitorQuery({
              goalId: input.goalId,
              ...(input.scope ? { scope: input.scope } : {}),
              sortKey: input.sortKey,
              direction: "desc",
              advanced: input.goalMode === "count-and-goal",
              ...(input.goalMode === "count-and-goal"
                ? { filterDsl: GOAL_COUNT_FILTER_DSL }
                : {}),
              limit: 1,
              cursor,
            });
            let providerError: unknown;
            const result = await runtime.execute("visitors", request, {
              onProviderError(error) {
                providerError = error;
              },
            });
            const providerErrorMessage =
              providerError instanceof Error
                ? `${providerError.name}:${providerError.message}`
                : String(providerError ?? "none");
            const calls = trace.preparedSql
              .slice(sqlStart)
              .map((sql, index) => ({
                sql,
                bindings: trace.bindings[bindingsStart + index] ?? [],
              }));
            const goalLookupCount = calls.filter((call) =>
              call.sql.includes('"analysis_definitions"'),
            ).length;
            if (!result.ok && input.goalMode === "ordinary-goal") {
              const cause =
                providerError instanceof Error
                  ? Reflect.get(providerError, "cause")
                  : undefined;
              pages.push({
                page: pageIndex + 1,
                requestCursor: cursor,
                error: result.error,
                providerError:
                  providerError instanceof Error
                    ? {
                        name: providerError.name,
                        message: providerError.message,
                        cause:
                          cause instanceof Error
                            ? { name: cause.name, message: cause.message }
                            : (cause ?? null),
                      }
                    : providerErrorMessage,
                goalLookupCount,
                calls,
              });
              break;
            }
            expect(
              result.ok,
              `${input.goalKind}/${input.goalMode}/${input.scope}/${input.sortKey}/page-${pageIndex + 1}: ${JSON.stringify(result)} providerError=${providerErrorMessage}`,
            ).toBe(true);
            if (!result.ok)
              throw new Error("visitor_goal_before_runtime_query_failed");
            expect(result.data.items).toHaveLength(1);
            if (pageIndex === 0)
              expect(result.data.pagination.nextCursor).toEqual(
                expect.any(String),
              );
            expect(goalLookupCount).toBe(1);
            pages.push({
              page: pageIndex + 1,
              requestCursor: cursor,
              dto: result.data,
              nextCursor: result.data.pagination.nextCursor,
              goalLookupCount,
              sqlBytes: calls.map(
                ({ sql }) => new TextEncoder().encode(sql).byteLength,
              ),
              bindCounts: calls.map(({ bindings }) => bindings.length),
              calls,
            });
            cursor = result.data.pagination.nextCursor;
            if (pageIndex === 0 && !cursor)
              throw new Error("visitor_goal_before_next_cursor_missing");
          }
          scenarios.push({
            goalKind: input.goalKind,
            goalId: input.goalId,
            goalMode: input.goalMode,
            ...(input.scope ? { countScope: input.scope } : {}),
            sort: { key: input.sortKey, direction: "desc" },
            pages,
          });
        };

        for (const sortKey of SORT_KEYS)
          await capture({
            goalKind,
            goalId: goal.goalId,
            goalMode: "count-and-goal",
            scope,
            sortKey,
          });
        if (scope === "session")
          await capture({
            goalKind,
            goalId: goal.goalId,
            goalMode: "ordinary-goal",
            sortKey: "lastSeenAt",
          });

        expect(scenarios).toHaveLength(scope === "session" ? 5 : 4);
        writeGoalBeforeEvidence(
          `provider-before-production-profile-${goalKind}-${scope}.json`,
          {
            state: "actual-public-runtime-before-visitor-goal-route",
            route:
              "createD1SiteQueryRuntime -> visitors -> d1AdvancedFilterMiddleware/evaluateForSites -> readSiteVisitors -> queryVisitorListPageFromD1",
            nodeVersion: process.version,
            cwd: process.cwd(),
            siteId: SITE_ID,
            secretId: "wave97r-visitor-list-baseline-secret",
            window: { startMs: BASE, endExclusiveMs: END, timeZone: "UTC" },
            countFilterDsl: GOAL_COUNT_FILTER_DSL,
            goal,
            countScope: scope,
            independentVisitorSets: {
              count: ["visitor-1", "visitor-2", "visitor-3", "visitor-5"],
              pageGoal: ["visitor-1", "visitor-2", "visitor-4", "visitor-5"],
              eventGoal: ["visitor-2", "visitor-3", "visitor-4", "visitor-5"],
              countAndPageGoal: ["visitor-1", "visitor-2"],
              countAndEventGoal: ["visitor-2", "visitor-3"],
              countVisitorAndPageGoal: ["visitor-1", "visitor-2", "visitor-5"],
              countVisitorAndEventGoal: ["visitor-2", "visitor-3", "visitor-5"],
              countAndGoalInDifferentSessions: ["visitor-5"],
            },
            oldAdvancedMatchesBridge: bridge,
            errors: [],
            pageLimit: 1,
            scenarios,
          },
        );
      } finally {
        database.close();
      }
    },
  );
});

describe.skip("Visitors Goal-only corrected source-selection reference", () => {
  it.each(["page", "event"] as const)(
    "captures the corrected ordinary %s Goal first/next-page reference",
    async (goalKind) => {
      expect(GOAL_EVIDENCE_DIRECTORY).toEqual(expect.any(String));
      const database = createMigratedDatabase();
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const env = {
        DB: createSqliteD1Database(database, trace),
        MAIN_SECRET: "wave97r-visitor-list-baseline-secret",
      } as unknown as Env;
      const goal =
        goalKind === "page"
          ? { goalId: "goal-page", filterDsl: 'page.path eq "/goal-page"' }
          : { goalId: "goal-event", filterDsl: 'event.name eq "signup"' };
      try {
        seedGoalFixture(database);
        const runtime = createD1SiteQueryRuntime({ env, siteId: SITE_ID });
        let cursor: string | null = null;
        const pages: Array<Record<string, unknown>> = [];
        for (const page of [1, 2] as const) {
          const sqlStart = trace.preparedSql.length;
          const bindingsStart = trace.bindings.length;
          const request = visitorQuery({
            goalId: goal.goalId,
            sortKey: "lastSeenAt",
            direction: "desc",
            advanced: false,
            limit: 1,
            cursor,
          });
          let providerError: unknown;
          const result = await runtime.execute("visitors", request, {
            onProviderError(error) {
              providerError = error;
            },
          });
          expect(
            result.ok,
            `${goalKind}/ordinary-goal/page-${page}: ${JSON.stringify(result)} providerError=${String(providerError)}`,
          ).toBe(true);
          if (!result.ok)
            throw new Error("visitor_goal_corrected_reference_failed");
          expect(result.data.items).toHaveLength(1);
          if (page === 1)
            expect(result.data.pagination.nextCursor).toEqual(
              expect.any(String),
            );
          const calls = trace.preparedSql.slice(sqlStart).map((sql, index) => ({
            sql,
            bindings: trace.bindings[bindingsStart + index] ?? [],
          }));
          const goalLookupCount = calls.filter((call) =>
            call.sql.includes('"analysis_definitions"'),
          ).length;
          expect(goalLookupCount).toBe(1);
          pages.push({
            page,
            requestCursor: cursor,
            dto: result.data,
            nextCursor: result.data.pagination.nextCursor,
            goalLookupCount,
            calls,
          });
          cursor = result.data.pagination.nextCursor;
        }
        writeGoalBeforeEvidence(
          `provider-before-corrected-ordinary-goal-${goalKind}.json`,
          {
            state:
              "corrected-public-runtime-reference-after-visitor-operation-source-selection-fix",
            nodeVersion: process.version,
            cwd: process.cwd(),
            siteId: SITE_ID,
            secretId: "wave97r-visitor-list-baseline-secret",
            window: { startMs: BASE, endExclusiveMs: END, timeZone: "UTC" },
            goal,
            sort: { key: "lastSeenAt", direction: "desc" },
            pageLimit: 1,
            pages,
          },
        );
      } finally {
        database.close();
      }
    },
  );
});

describe("Visitors qualified list pre-route finite budgets", () => {
  it.each(
    (["session", "visitor"] as const).flatMap((scope) =>
      SORT_KEYS.map((sortKey) => [scope, sortKey] as const),
    ),
  )(
    "executes a nonempty %s scoped %s first/next-page qualification within D1 budgets",
    async (scope, sortKey) => {
      const database = createMigratedDatabase();
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const env = {
        DB: createSqliteD1Database(database, trace),
        MAIN_SECRET: "wave97r-visitor-list-baseline-secret",
      } as unknown as Env;
      try {
        seedFixture(database);
        const { prepared, count } = preparedQualificationInput(scope);
        const sort = { key: sortKey, direction: "desc" as const };
        const compilePage = async (
          cursor: ReturnType<typeof visitorCursor> | null,
        ) => {
          const plan = buildJourneyVisitorListQualificationPlan({
            siteId: SITE_ID,
            queryTime: prepared.time,
            filters: prepared.filters,
            scopePlan: prepared.scopePlan,
            count,
            limit: 1,
            sort,
            cursor,
          });
          const compilation = compileVisitorEnvelope({ plan, sortKey });
          const filename = `stageA-${scope}-${sortKey}.json`;
          if (compilation.kind !== "compiled") {
            writeStageAEvidence(filename, {
              state: "pre-route-qualified-plan-budget-unavailable",
              scope,
              sort,
              fallbackReason: compilation.fallbackReason,
              admissionEvidence: compilation.admissionEvidence,
            });
            throw new Error(
              `visitor_list_qualification_budget_unavailable:${scope}:${sortKey}:${JSON.stringify(compilation.fallbackReason)}`,
            );
          }
          const sqlStart = trace.preparedSql.length;
          const bindingsStart = trace.bindings.length;
          const rows = await queryD1CompiledAll(env, compilation.query);
          const calls = trace.preparedSql.slice(sqlStart).map((sql, index) => ({
            sql,
            bindings: trace.bindings[bindingsStart + index] ?? [],
          }));
          const envelopeRows = rows as Array<Record<string, unknown>>;
          const reportRows = envelopeRows.filter(
            (row) =>
              row.rowKind === "report" &&
              row.outputId === JOURNEY_VISITOR_LIST_REPORT_OUTPUT,
          );
          const controls = envelopeRows.filter(
            (row) =>
              row.rowKind === "control" &&
              row.outputId === PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT,
          );
          expect(controls).toHaveLength(1);
          expect(reportRows.length).toBeGreaterThan(0);
          expect(compilation.evidence.sqlBytes).toBeLessThanOrEqual(100_000);
          expect(compilation.evidence.bindingCount).toBeLessThanOrEqual(100);
          expect(compilation.evidence.groupWidth).toBeLessThanOrEqual(16);
          expect(compilation.evidence.groupedSummaryProof).toMatchObject({
            source: "local-plan",
            nodeKind: "aggregate",
            groupKeyCount: 2,
            matchingSharedRelationCount: 1,
            materialization: "materialized",
          });
          expect(
            compilation.evidence.groupedSummaryProof.sharedRelations.filter(
              ({ sameNode }) => sameNode,
            ),
          ).toHaveLength(1);
          expect(compilation.evidence.reportSourceRelations).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ entity: "page" }),
              expect.objectContaining({ entity: "event" }),
            ]),
          );
          expect(calls).toHaveLength(1);
          const row = mapVisitorRow(reportRows[0]!);
          const dto = mapVisitors([row])[0]!;
          return {
            plan,
            compilation: compilation.evidence,
            envelopeRows,
            calls,
            row,
            dto,
            cursor: visitorCursor(row, sortKey),
          };
        };

        const first = await compilePage(null);
        const second = await compilePage(first.cursor);
        expect(first.dto.visitorId).toBeTruthy();
        expect(second.dto.visitorId).toBeTruthy();
        expect(second.dto.visitorId).not.toBe(first.dto.visitorId);
        writeStageAEvidence(`stageA-${scope}-${sortKey}.json`, {
          state: "pre-route-qualified-plan-budget-executed",
          scope,
          sort,
          filterDsl: FILTER_DSL,
          pageLimit: 1,
          firstPage: {
            dto: first.dto,
            cursor: first.cursor,
            evidence: first.compilation,
            envelopeRows: first.envelopeRows,
            calls: first.calls,
          },
          nextPage: {
            dto: second.dto,
            requestCursor: first.cursor,
            evidence: second.compilation,
            envelopeRows: second.envelopeRows,
            calls: second.calls,
          },
        });
      } finally {
        database.close();
      }
    },
  );
});

describe("Visitors Goal direct SQLite pre-route qualification proofs", () => {
  it.each(
    (["page", "event"] as const).flatMap((goalKind) =>
      (["session", "visitor"] as const).flatMap((scope) =>
        SORT_KEYS.map((sortKey) => [goalKind, scope, sortKey] as const),
      ),
    ),
  )(
    "executes the %s Goal under %s Count scope for %s within the direct SQL budget",
    async (goalKind, scope, sortKey) => {
      const database = createMigratedDatabase();
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const env = {
        DB: createSqliteD1Database(database, trace),
        MAIN_SECRET: "wave97r-visitor-list-baseline-secret",
      } as unknown as Env;
      const goal =
        goalKind === "page"
          ? {
              goalId: "goal-page",
              filterDsl: 'page.path eq "/goal-page"',
            }
          : { goalId: "goal-event", filterDsl: 'event.name eq "signup"' };
      const expectedVisitorIds =
        goalKind === "page"
          ? scope === "session"
            ? ["visitor-1", "visitor-2"]
            : ["visitor-1", "visitor-2", "visitor-5"]
          : scope === "session"
            ? ["visitor-2", "visitor-3"]
            : ["visitor-2", "visitor-3", "visitor-5"];
      try {
        seedGoalFixture(database);
        const { prepared, count } = preparedQualificationInput(
          scope,
          GOAL_COUNT_FILTER_DSL,
        );
        const analysisFilter = parseFilterDsl(
          goal.filterDsl,
          analyticsFilterRegistry,
        );
        const scenarios: Array<Record<string, unknown>> = [];
        {
          const sort = { key: sortKey, direction: "desc" as const };
          const compilePage = async (
            cursor: ReturnType<typeof visitorCursor> | null,
            suppressReportRows = false,
          ) => {
            const plan = buildJourneyVisitorGoalListQualificationPlan({
              siteId: SITE_ID,
              queryTime: prepared.time,
              filters: prepared.filters,
              scopePlan: prepared.scopePlan,
              count,
              limit: 1,
              sort,
              cursor,
              analysisFilter,
              ...(suppressReportRows ? { suppressReportRows: true } : {}),
            });
            const compilation = compileVisitorEnvelope({ plan, sortKey });
            if (compilation.kind !== "compiled") {
              writeGoalStageEvidence(
                `pre-route-${goalKind}-${scope}-${sortKey}-unavailable.json`,
                {
                  state: "pre-route-goal-budget-unavailable",
                  goal,
                  scope,
                  sort,
                  suppressReportRows,
                  fallbackReason: compilation.fallbackReason,
                  admissionEvidence: compilation.admissionEvidence,
                },
              );
              throw new Error(
                `visitor_goal_qualification_budget_unavailable:${goalKind}:${scope}:${sortKey}:${JSON.stringify(compilation.fallbackReason)}`,
              );
            }
            expect(compilation.evidence.sqlBytes).toBeLessThanOrEqual(100_000);
            expect(compilation.evidence.bindingCount).toBeLessThanOrEqual(100);
            expect(compilation.evidence.groupWidth).toBeLessThanOrEqual(16);
            expect(compilation.evidence.groupedSummaryProof).toMatchObject({
              source: "local-plan",
              nodeKind: "aggregate",
              groupKeyCount: 2,
              matchingSharedRelationCount: 1,
              materialization: "materialized",
            });
            expect(
              compilation.evidence.groupedSummaryProof.sharedRelations.filter(
                ({ sameNode }) => sameNode,
              ),
            ).toHaveLength(1);
            const sqlStart = trace.preparedSql.length;
            const bindingsStart = trace.bindings.length;
            const rows = await queryD1CompiledAll(env, compilation.query);
            const calls = trace.preparedSql
              .slice(sqlStart)
              .map((sql, index) => ({
                sql,
                bindings: trace.bindings[bindingsStart + index] ?? [],
              }));
            const envelopeRows = rows as Array<Record<string, unknown>>;
            const reportRows = envelopeRows.filter(
              (row) =>
                row.rowKind === "report" &&
                row.outputId === JOURNEY_VISITOR_LIST_REPORT_OUTPUT,
            );
            const controls = envelopeRows.filter(
              (row) =>
                row.rowKind === "control" &&
                row.outputId === PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT,
            );
            expect(calls).toHaveLength(1);
            expect(controls).toHaveLength(1);
            if (suppressReportRows) expect(reportRows).toHaveLength(0);
            else expect(reportRows.length).toBeGreaterThan(0);
            expect(compilation.evidence.reportSourceRelations).toEqual(
              expect.arrayContaining([
                expect.objectContaining({ entity: "page" }),
                expect.objectContaining({ entity: "event" }),
              ]),
            );
            const control = controls[0]!;
            expect(control.entityKind).toBe(scope);
            expect(control.rawCount).toEqual(expect.any(Number));
            const report = reportRows[0];
            if (!report) {
              return {
                plan,
                evidence: compilation.evidence,
                envelopeRows,
                calls,
                dto: undefined,
                cursor: undefined,
              };
            }
            const page = visitorListPageFromRecords(reportRows, 1, {
              key: sortKey,
              direction: "desc",
            });
            expect(page.rows).toHaveLength(1);
            const row = page.rows[0]!;
            return {
              plan,
              evidence: compilation.evidence,
              envelopeRows,
              calls,
              dto: mapVisitors([row])[0]!,
              cursor: page.nextCursor,
            };
          };

          const first = await compilePage(null);
          const second = await compilePage(first.cursor ?? null);
          expect(first.dto?.visitorId).toBeTruthy();
          expect(second.dto?.visitorId).toBeTruthy();
          expect(second.dto?.visitorId).not.toBe(first.dto?.visitorId);
          let third: Awaited<ReturnType<typeof compilePage>> | undefined;
          if (sortKey === "lastSeenAt" && expectedVisitorIds.length === 3) {
            third = await compilePage(second.cursor ?? null);
            expect(third.dto?.visitorId).toBeTruthy();
            expect(third.dto?.visitorId).not.toBe(first.dto?.visitorId);
            expect(third.dto?.visitorId).not.toBe(second.dto?.visitorId);
            expect(
              [
                first.dto!.visitorId,
                second.dto!.visitorId,
                third.dto!.visitorId,
              ].sort(),
            ).toEqual([...expectedVisitorIds].sort());
          } else if (sortKey === "lastSeenAt") {
            expect(
              [first.dto!.visitorId, second.dto!.visitorId].sort(),
            ).toEqual([...expectedVisitorIds].sort());
          }
          const suppressReport = await compilePage(null, true);
          expect(suppressReport.dto).toBeUndefined();
          expect(
            suppressReport.envelopeRows.filter(
              (row) => row.rowKind === "report",
            ),
          ).toHaveLength(0);
          expect(
            suppressReport.envelopeRows.filter(
              (row) => row.rowKind === "control",
            ),
          ).toHaveLength(1);
          scenarios.push({
            sort,
            expectedVisitorIds,
            first: {
              dto: first.dto,
              cursor: first.cursor,
              evidence: first.evidence,
              envelopeRows: first.envelopeRows,
              calls: first.calls,
            },
            next: {
              dto: second.dto,
              requestCursor: first.cursor,
              cursor: second.cursor,
              evidence: second.evidence,
              envelopeRows: second.envelopeRows,
              calls: second.calls,
            },
            ...(third
              ? {
                  third: {
                    dto: third.dto,
                    requestCursor: second.cursor,
                    cursor: third.cursor,
                    evidence: third.evidence,
                    envelopeRows: third.envelopeRows,
                    calls: third.calls,
                  },
                }
              : {}),
            suppressReport: {
              evidence: suppressReport.evidence,
              envelopeRows: suppressReport.envelopeRows,
              calls: suppressReport.calls,
            },
          });
        }
        writeGoalStageEvidence(
          `pre-route-${goalKind}-${scope}-${sortKey}.json`,
          {
            state: "pre-route-goal-qualified-sqlite-budget-proofs",
            nodeVersion: process.version,
            cwd: process.cwd(),
            siteId: SITE_ID,
            secretId: "wave97r-visitor-list-baseline-secret",
            window: { startMs: BASE, endExclusiveMs: END, timeZone: "UTC" },
            countFilterDsl: GOAL_COUNT_FILTER_DSL,
            goal,
            countScope: scope,
            reportIdentity: "visitorId",
            goalSourceMembershipScope: scope,
            expectedVisitorIds,
            scenarios,
          },
        );
      } finally {
        database.close();
      }
    },
  );
});

describe("Visitors Goal direct program errors before route wiring", () => {
  it.each([
    { label: "missing Goal", goalId: "missing-goal" },
    { label: "invalid stored Goal DSL", goalId: "goal-invalid" },
  ])(
    "runs real Count controls before returning a $label error",
    async ({ goalId, label }) => {
      const database = createMigratedDatabase();
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const envelopeRows: Record<string, unknown>[] = [];
      const env = {
        DB: d1WithEnvelopeRowTransform(database, trace, (row) => row, {
          onEnvelopeRows: (rows) => envelopeRows.push(...rows),
        }),
        MAIN_SECRET: "wave97r-visitor-list-baseline-secret",
      } as unknown as Env;
      let observedError: unknown;
      try {
        seedGoalFixture(database);
        if (goalId === "goal-invalid") insertInvalidGoalDefinition(database);
        const direct = await directVisitorGoalProgramInput({
          env,
          scope: "session",
          goalId,
          cursor: "malformed-cursor",
        });
        try {
          await executeDirectVisitorGoalProgram({
            env,
            query: direct.query,
            deferred: direct.deferred,
          });
        } catch (error) {
          observedError = error;
        }
        expect(observedError).toBeInstanceOf(Error);
        if (label === "missing Goal")
          expect((observedError as Error).message).toBe("resource-not-found");
        else
          expect((observedError as Error).message).toContain(
            "goal_filter_dsl_invalid",
          );
        expect(goalLookupSqlCalls(trace)).toHaveLength(1);
        expect(qualificationEnvelopeSqlCalls(trace)).toHaveLength(1);
        expect(envelopeRows).toHaveLength(1);
        expect(envelopeRows[0]).toMatchObject({
          rowKind: "control",
          outputId: PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT,
        });
        writeGoalStageEvidence(`pre-route-${goalId}-error-controls.json`, {
          state: "pre-route-goal-error-after-count-control-envelope",
          nodeVersion: process.version,
          goalId,
          countScope: "session",
          observedError: {
            name: (observedError as Error).name,
            message: (observedError as Error).message,
            cause:
              (observedError as Error).cause instanceof Error
                ? {
                    name: ((observedError as Error).cause as Error).name,
                    message: ((observedError as Error).cause as Error).message,
                  }
                : ((observedError as Error).cause ?? null),
          },
          goalLookupCount: goalLookupSqlCalls(trace).length,
          qualificationEnvelopeCount:
            qualificationEnvelopeSqlCalls(trace).length,
          envelopeRows,
          calls: trace.preparedSql.map((sql, index) => ({
            sql,
            bindings: trace.bindings[index] ?? [],
          })),
        });
      } finally {
        database.close();
      }
    },
  );

  it("preserves the typed Goal lookup error and cause after Count controls", async () => {
    const database = createMigratedDatabase();
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const lookupCause = new Error("wave97z_goal_lookup_cause");
    const lookupError = new Error("wave97z_goal_lookup_failed", {
      cause: lookupCause,
    });
    const envelopeRows: Record<string, unknown>[] = [];
    const env = {
      DB: d1WithEnvelopeRowTransform(database, trace, (row) => row, {
        goalLookupError: lookupError,
        onEnvelopeRows: (rows) => envelopeRows.push(...rows),
      }),
      MAIN_SECRET: "wave97r-visitor-list-baseline-secret",
    } as unknown as Env;
    let observedError: unknown;
    try {
      seedGoalFixture(database);
      const direct = await directVisitorGoalProgramInput({
        env,
        scope: "visitor",
        goalId: "goal-page",
      });
      try {
        await executeDirectVisitorGoalProgram({
          env,
          query: direct.query,
          deferred: direct.deferred,
        });
      } catch (error) {
        observedError = error;
      }
      expect(observedError).toBe(lookupError);
      expect((observedError as Error).cause).toBe(lookupCause);
      expect(goalLookupSqlCalls(trace)).toHaveLength(1);
      expect(qualificationEnvelopeSqlCalls(trace)).toHaveLength(1);
      expect(envelopeRows).toHaveLength(1);
      expect(envelopeRows[0]?.rowKind).toBe("control");
      writeGoalStageEvidence("pre-route-goal-lookup-error-controls.json", {
        state: "pre-route-exact-goal-lookup-error-after-controls",
        nodeVersion: process.version,
        countScope: "visitor",
        observedSameErrorInstance: observedError === lookupError,
        observedCauseIdentity: (observedError as Error).cause === lookupCause,
        observedError: {
          name: (observedError as Error).name,
          message: (observedError as Error).message,
          cause: {
            name: lookupCause.name,
            message: lookupCause.message,
          },
        },
        goalLookupCount: goalLookupSqlCalls(trace).length,
        qualificationEnvelopeCount: qualificationEnvelopeSqlCalls(trace).length,
        envelopeRows,
      });
    } finally {
      database.close();
    }
  });

  it("lets Count cap outrank a Goal lookup error and malformed cursor", async () => {
    const database = createMigratedDatabase();
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const lookupError = new Error("wave97z_goal_lookup_failed_under_cap");
    const envelopeRows: Record<string, unknown>[] = [];
    let rawCountBeforeMutation: unknown;
    const env = {
      DB: d1WithEnvelopeRowTransform(
        database,
        trace,
        (row) => {
          if (row.rowKind !== "control") return row;
          rawCountBeforeMutation = row.rawCount;
          return { ...row, rawCount: 20_001 };
        },
        {
          goalLookupError: lookupError,
          onEnvelopeRows: (rows) => envelopeRows.push(...rows),
        },
      ),
      MAIN_SECRET: "wave97r-visitor-list-baseline-secret",
    } as unknown as Env;
    let observedError: unknown;
    try {
      seedGoalFixture(database);
      const direct = await directVisitorGoalProgramInput({
        env,
        scope: "session",
        goalId: "goal-page",
        cursor: "malformed-cursor",
      });
      try {
        await executeDirectVisitorGoalProgram({
          env,
          query: direct.query,
          deferred: direct.deferred,
        });
      } catch (error) {
        observedError = error;
      }
      expect(observedError).not.toBe(lookupError);
      expect(observedError).toMatchObject({
        name: "AnalyticsProviderDomainError",
        domainError: {
          kind: "invalid-input",
          issues: [{ path: "filters", code: "filter_activity_limit_exceeded" }],
        },
      });
      expect(rawCountBeforeMutation).toEqual(expect.any(Number));
      expect(rawCountBeforeMutation).not.toBe(20_001);
      expect(goalLookupSqlCalls(trace)).toHaveLength(1);
      expect(qualificationEnvelopeSqlCalls(trace)).toHaveLength(1);
      expect(envelopeRows).toHaveLength(1);
      expect(envelopeRows[0]?.rowKind).toBe("control");
      writeGoalStageEvidence("pre-route-goal-cap-priority.json", {
        state: "pre-route-count-cap-overrides-goal-error-and-cursor",
        nodeVersion: process.version,
        countScope: "session",
        cursor: "malformed-cursor",
        lookupError: {
          name: lookupError.name,
          message: lookupError.message,
        },
        observedError: {
          name: (observedError as Error).name,
          message: (observedError as Error).message,
        },
        controlMutation: {
          seededLargeFixture: false,
          rawCountBeforeMutation,
          rawCountAfterMutation: 20_001,
        },
        goalLookupCount: goalLookupSqlCalls(trace).length,
        qualificationEnvelopeCount: qualificationEnvelopeSqlCalls(trace).length,
        envelopeRows,
      });
    } finally {
      database.close();
    }
  });

  it("honors abort after the Goal definition lookup without running Count SQL", async () => {
    const database = createMigratedDatabase();
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const controller = new AbortController();
    const env = {
      DB: d1WithEnvelopeRowTransform(database, trace, (row) => row, {
        afterGoalLookup: () => controller.abort(),
      }),
      MAIN_SECRET: "wave97r-visitor-list-baseline-secret",
    } as unknown as Env;
    let observedError: unknown;
    try {
      seedGoalFixture(database);
      const direct = await directVisitorGoalProgramInput({
        env,
        scope: "visitor",
        goalId: "goal-page",
        execution: { signal: controller.signal },
      });
      try {
        await executeDirectVisitorGoalProgram({
          env,
          query: direct.query,
          deferred: direct.deferred,
        });
      } catch (error) {
        observedError = error;
      }
      expect(controller.signal.aborted).toBe(true);
      expect(observedError).toMatchObject({
        name: "AbortError",
        message: "Aborted",
      });
      expect(goalLookupSqlCalls(trace)).toHaveLength(1);
      expect(qualificationEnvelopeSqlCalls(trace)).toHaveLength(0);
      writeGoalStageEvidence("pre-route-goal-abort-after-lookup.json", {
        state: "pre-route-abort-after-goal-lookup-before-count-envelope",
        nodeVersion: process.version,
        goalLookupCount: goalLookupSqlCalls(trace).length,
        qualificationEnvelopeCount: qualificationEnvelopeSqlCalls(trace).length,
        observedError: {
          name: (observedError as Error).name,
          message: (observedError as Error).message,
        },
        calls: trace.preparedSql.map((sql, index) => ({
          sql,
          bindings: trace.bindings[index] ?? [],
        })),
      });
    } finally {
      database.close();
    }
  });

  it.each(["session", "visitor"] as const)(
    "reads the %s entity membership instead of the legacy ID bridge for a numeric fallback",
    async (scope) => {
      const database = createMigratedDatabase();
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const legacyTrace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const secret = "wave97r-visitor-list-baseline-secret";
      const env = {
        DB: createSqliteD1Database(database, trace),
        MAIN_SECRET: secret,
      } as unknown as Env;
      const legacyEnv = {
        DB: createSqliteD1Database(database, legacyTrace),
        MAIN_SECRET: secret,
      } as unknown as Env;
      try {
        seedFixture(database);
        database
          .prepare("UPDATE visits SET duration_ms = ?")
          .run("invalid-duration");
        const request = visitorQuery({
          scope,
          sortKey: "lastSeenAt",
          direction: "desc",
          advanced: true,
          limit: 10,
          filterDsl: "count(page { page.durationMs gt 5 }) eq 0",
        });
        const diagnostics = createD1ReadDiagnostics();
        const result = await createD1SiteQueryRuntime({
          env,
          siteId: SITE_ID,
          diagnostics,
        }).execute("visitors", request);
        expect(result.ok, JSON.stringify(result)).toBe(true);
        if (!result.ok) throw new Error("visitor_list_membership_failed");
        expect(diagnostics.advancedCountSqlFallbackReason).toEqual({
          kind: "numeric-data-domain",
          fieldIds: ["page.durationMs"],
        });
        const legacy = await legacyVisitorPage(legacyEnv, request);
        expect(legacy.items.length).toBeGreaterThan(0);
        expect(result.data).toEqual(legacy);
        // The legacy ID bridge binds the entity kind next to every identity;
        // the request-private entity membership binds only (site, id) pairs.
        expect(legacyTrace.bindings.at(-1) ?? []).toContain(scope);
        expect(trace.bindings.at(-1) ?? []).not.toContain(scope);
      } finally {
        database.close();
      }
    },
  );

  it("keeps the original missing Goal error through numeric Count fallback", async () => {
    const database = createMigratedDatabase();
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const env = {
      DB: createSqliteD1Database(database, trace),
      MAIN_SECRET: "wave97r-visitor-list-baseline-secret",
    } as unknown as Env;
    try {
      seedGoalFixture(database);
      database
        .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
        .run("invalid-duration", "v1-match-1");
      const direct = await directVisitorGoalProgramInput({
        env,
        scope: "session",
        goalId: "missing-goal",
        filterDsl: GOAL_NUMERIC_COUNT_FILTER_DSL,
      });
      const qualified = await executeDirectVisitorGoalProgram({
        env,
        query: direct.query,
        deferred: direct.deferred,
      });
      expect(qualified.kind).toBe("fallback");
      if (qualified.kind !== "fallback")
        throw new Error("visitor_goal_missing_numeric_fallback_missing");
      expect(qualified.fallbackReason).toMatchObject({
        kind: "numeric-data-domain",
        fieldIds: ["page.durationMs"],
      });
      expect(qualified.resolvedAnalysis).toBeUndefined();
      expect(qualified.postFallbackError?.error).toMatchObject({
        name: "Error",
        message: "resource-not-found",
      });
      const goalLookupsBeforeFallback = goalLookupSqlCalls(trace).length;
      expect(goalLookupsBeforeFallback).toBe(1);
      const fallbackSqlStart = trace.preparedSql.length;
      await prepareDeferredEventQualificationFallback(
        direct.deferred.qualification,
      );
      const fallbackCalls = trace.preparedSql.slice(fallbackSqlStart);
      expect(fallbackCalls.length).toBeGreaterThan(0);
      expect(
        fallbackCalls.some((sql) => sql.includes('"analysis_definitions"')),
      ).toBe(false);
      expect(goalLookupSqlCalls(trace)).toHaveLength(1);
      writeGoalStageEvidence("pre-route-missing-goal-numeric-fallback.json", {
        state: "pre-route-numeric-count-fallback-preserves-original-goal-error",
        nodeVersion: process.version,
        goalId: "missing-goal",
        goalLookupCount: goalLookupSqlCalls(trace).length,
        qualificationEnvelopeCount: qualificationEnvelopeSqlCalls(trace).length,
        fallbackReason: qualified.fallbackReason,
        deferredError: {
          name: (qualified.postFallbackError?.error as Error).name,
          message: (qualified.postFallbackError?.error as Error).message,
        },
        legacyCountPreparationCalls: fallbackCalls.map((sql, index) => ({
          sql,
          bindings: trace.bindings[fallbackSqlStart + index] ?? [],
        })),
      });
    } finally {
      database.close();
    }
  });

  it("reuses the resolved Goal across a whole numeric Count fallback", async () => {
    const database = createMigratedDatabase();
    const legacyDatabase = createMigratedDatabase();
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const legacyTrace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const env = {
      DB: createSqliteD1Database(database, trace),
      MAIN_SECRET: "wave97r-visitor-list-baseline-secret",
    } as unknown as Env;
    const legacyEnv = {
      DB: createSqliteD1Database(legacyDatabase, legacyTrace),
      MAIN_SECRET: "wave97r-visitor-list-baseline-secret",
    } as unknown as Env;
    try {
      seedGoalFixture(database);
      seedGoalFixture(legacyDatabase);
      database
        .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
        .run("invalid-duration", "v1-match-1");
      legacyDatabase
        .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
        .run("invalid-duration", "v1-match-1");
      const direct = await directVisitorGoalProgramInput({
        env,
        scope: "session",
        goalId: "goal-page",
        filterDsl: GOAL_NUMERIC_COUNT_FILTER_DSL,
      });
      const qualified = await executeDirectVisitorGoalProgram({
        env,
        query: direct.query,
        deferred: direct.deferred,
      });
      expect(qualified.kind).toBe("fallback");
      if (qualified.kind !== "fallback")
        throw new Error("visitor_goal_numeric_fallback_missing");
      expect(qualified.fallbackReason).toMatchObject({
        kind: "numeric-data-domain",
        fieldIds: ["page.durationMs"],
      });
      expect(qualified.resolvedAnalysis?.type).toBe("goal");
      expect(qualified.postFallbackError).toBeUndefined();
      const fallbackFilters = await prepareDeferredEventQualificationFallback(
        direct.deferred.qualification,
      );
      const fallbackWindow = {
        startMs: direct.request.time.range.startMs,
        endExclusiveMs: direct.request.time.range.endExclusiveMs,
        nowMs: direct.request.time.capturedAtMs,
        timeZone: direct.request.time.reportingTimeZone,
      };
      const actual = await readSiteVisitorsWithResolvedAnalysis(
        {
          env,
          siteId: SITE_ID,
          window: fallbackWindow,
          filters: fallbackFilters,
          sort: { field: "lastSeenAt", direction: "desc" },
          page: { limit: 1, cursor: null },
          audience: "private-dashboard",
          analysisContext: { type: "goal", goalId: "goal-page" },
        },
        qualified.resolvedAnalysis,
      );
      const legacyRequest = visitorQuery({
        scope: "session",
        sortKey: "lastSeenAt",
        direction: "desc",
        advanced: true,
        filterDsl: GOAL_NUMERIC_COUNT_FILTER_DSL,
        goalId: "goal-page",
        limit: 1,
      });
      const expected = await createD1SiteQueryRuntime({
        env: legacyEnv,
        siteId: SITE_ID,
      }).execute("visitors", legacyRequest);
      expect(expected.ok, JSON.stringify(expected)).toBe(true);
      if (!expected.ok)
        throw new Error("visitor_goal_numeric_legacy_reference_failed");
      expect(actual).toEqual(expected.data);
      expect(goalLookupSqlCalls(trace)).toHaveLength(1);
      expect(qualificationEnvelopeSqlCalls(trace)).toHaveLength(1);
      writeGoalStageEvidence("pre-route-goal-numeric-fallback-reuse.json", {
        state: "pre-route-numeric-count-fallback-reuses-parsed-goal",
        nodeVersion: process.version,
        goalLookupCount: goalLookupSqlCalls(trace).length,
        qualificationEnvelopeCount: qualificationEnvelopeSqlCalls(trace).length,
        fallbackReason: qualified.fallbackReason,
        actual,
        expected: expected.data,
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
});

describe("Visitors Goal qualified runtime parity", () => {
  it.each(
    (["page", "event"] as const).flatMap((goalKind) =>
      (["session", "visitor"] as const).flatMap((scope) =>
        SORT_KEYS.map((sortKey) => [goalKind, scope, sortKey] as const),
      ),
    ),
  )(
    "matches old DTOs and signed cursors for %s Goal, %s Count scope, %s sort",
    async (goalKind, scope, sortKey) => {
      const database = createMigratedDatabase();
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const env = {
        DB: createSqliteD1Database(database, trace),
        MAIN_SECRET: "wave97r-visitor-list-baseline-secret",
      } as unknown as Env;
      const diagnostics = createD1ReadDiagnostics();
      const goal =
        goalKind === "page"
          ? { goalId: "goal-page", filterDsl: 'page.path eq "/goal-page"' }
          : { goalId: "goal-event", filterDsl: 'event.name eq "signup"' };
      try {
        seedGoalFixture(database);
        const runtime = createD1SiteQueryRuntime({
          env,
          siteId: SITE_ID,
          diagnostics,
        });
        const requestFor = (cursor: string | null) =>
          visitorQuery({
            scope,
            sortKey,
            direction: "desc",
            cursor,
            advanced: true,
            filterDsl: GOAL_COUNT_FILTER_DSL,
            goalId: goal.goalId,
            limit: 1,
          });

        const firstStart = trace.preparedSql.length;
        const first = await runtime.execute("visitors", requestFor(null));
        expect(first.ok, JSON.stringify(first)).toBe(true);
        if (!first.ok)
          throw new Error("visitor_goal_runtime_first_page_failed");
        const firstCalls = trace.preparedSql.slice(firstStart);
        writeGoalStageEvidence(
          `post-route-debug-${goalKind}-${scope}-${sortKey}.json`,
          { firstCalls },
        );
        expect(
          firstCalls.filter((sql) => sql.includes('"analysis_definitions"')),
        ).toHaveLength(1);
        expect(
          firstCalls.filter(
            (sql) => sql.includes('"rowKind"') && sql.includes('"outputId"'),
          ),
        ).toHaveLength(1);
        const firstOtherCalls = firstCalls.filter(
          (sql) =>
            !sql.includes('"analysis_definitions"') &&
            !(sql.includes('"rowKind"') && sql.includes('"outputId"')),
        );
        expect(firstOtherCalls).toHaveLength(1);
        expect(firstOtherCalls[0]).toContain('FROM "sites"');
        const oldFirst = await legacyVisitorPage(env, requestFor(null));
        expect(first.data).toEqual(oldFirst);
        expect(first.data.pagination.nextCursor).toEqual(expect.any(String));

        const secondStart = trace.preparedSql.length;
        const second = await runtime.execute(
          "visitors",
          requestFor(first.data.pagination.nextCursor),
        );
        expect(second.ok, JSON.stringify(second)).toBe(true);
        if (!second.ok)
          throw new Error("visitor_goal_runtime_next_page_failed");
        const secondCalls = trace.preparedSql.slice(secondStart);
        expect(
          secondCalls.filter((sql) => sql.includes('"analysis_definitions"')),
        ).toHaveLength(1);
        expect(
          secondCalls.filter(
            (sql) => sql.includes('"rowKind"') && sql.includes('"outputId"'),
          ),
        ).toHaveLength(1);
        const oldSecond = await legacyVisitorPage(
          env,
          requestFor(oldFirst.pagination.nextCursor),
        );
        expect(second.data).toEqual(oldSecond);
        expect(second.data.pagination.nextCursor).toEqual(
          oldSecond.pagination.nextCursor,
        );
        expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
        writeGoalStageEvidence(
          `post-route-${goalKind}-${scope}-${sortKey}.json`,
          {
            state: "post-route-goal-dto-and-signed-cursor-match-legacy",
            nodeVersion: process.version,
            siteId: SITE_ID,
            goal,
            countFilterDsl: GOAL_COUNT_FILTER_DSL,
            countScope: scope,
            sort: { key: sortKey, direction: "desc" },
            secretId: "wave97r-visitor-list-baseline-secret",
            first: {
              actual: first.data,
              legacy: oldFirst,
              newRouteCalls: firstCalls,
            },
            next: {
              actual: second.data,
              legacy: oldSecond,
              newRouteCalls: secondCalls,
            },
          },
        );
      } finally {
        database.close();
      }
    },
  );
});

describe("Visitors Goal-only public runtime after route wiring", () => {
  it.each(["page", "event"] as const)(
    "preserves first/next DTOs and cursors for ordinary %s Goals",
    async (goalKind) => {
      const database = createMigratedDatabase();
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const env = {
        DB: createSqliteD1Database(database, trace),
        MAIN_SECRET: "wave97r-visitor-list-baseline-secret",
      } as unknown as Env;
      const goal =
        goalKind === "page"
          ? { goalId: "goal-page", filterDsl: 'page.path eq "/goal-page"' }
          : { goalId: "goal-event", filterDsl: 'event.name eq "signup"' };
      try {
        seedGoalFixture(database);
        const runtime = createD1SiteQueryRuntime({ env, siteId: SITE_ID });
        const requestFor = (cursor: string | null) =>
          visitorQuery({
            sortKey: "lastSeenAt",
            direction: "desc",
            cursor,
            advanced: false,
            goalId: goal.goalId,
            limit: 1,
          });
        const firstStart = trace.preparedSql.length;
        const first = await runtime.execute("visitors", requestFor(null));
        expect(first.ok, JSON.stringify(first)).toBe(true);
        if (!first.ok)
          throw new Error("visitor_ordinary_goal_first_page_failed");
        const firstCalls = trace.preparedSql.slice(firstStart);
        expect(
          firstCalls.filter((sql) => sql.includes('"analysis_definitions"')),
        ).toHaveLength(1);
        expect(
          firstCalls.filter(
            (sql) => sql.includes('"rowKind"') && sql.includes('"outputId"'),
          ),
        ).toHaveLength(0);
        const oldFirst = await ordinaryVisitorPage(env, requestFor(null));
        expect(first.data).toEqual(oldFirst);
        expect(first.data.pagination.nextCursor).toEqual(expect.any(String));
        const second = await runtime.execute(
          "visitors",
          requestFor(first.data.pagination.nextCursor),
        );
        expect(second.ok, JSON.stringify(second)).toBe(true);
        if (!second.ok)
          throw new Error("visitor_ordinary_goal_next_page_failed");
        const oldSecond = await ordinaryVisitorPage(
          env,
          requestFor(oldFirst.pagination.nextCursor),
        );
        expect(second.data).toEqual(oldSecond);
        expect(second.data.pagination.nextCursor).toEqual(
          oldSecond.pagination.nextCursor,
        );
        writeGoalStageEvidence(`post-route-ordinary-goal-${goalKind}.json`, {
          state: "post-route-ordinary-goal-dto-and-token-match",
          nodeVersion: process.version,
          goal,
          siteId: SITE_ID,
          secretId: "wave97r-visitor-list-baseline-secret",
          first: { actual: first.data, legacy: oldFirst, calls: firstCalls },
          next: { actual: second.data, legacy: oldSecond },
        });
      } finally {
        database.close();
      }
    },
  );
});

describe("Visitors Goal qualified runtime special branches", () => {
  it.each([
    { label: "missing Goal", goalId: "missing-goal" },
    { label: "invalid stored Goal DSL", goalId: "goal-invalid" },
  ])(
    "returns the original $label error after Count controls and before cursor error",
    async ({ goalId, label }) => {
      const database = createMigratedDatabase();
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const envelopeRows: Record<string, unknown>[] = [];
      const env = {
        DB: d1WithEnvelopeRowTransform(database, trace, (row) => row, {
          onEnvelopeRows: (rows) => envelopeRows.push(...rows),
        }),
        MAIN_SECRET: "wave97r-visitor-list-baseline-secret",
      } as unknown as Env;
      const runtime = createD1SiteQueryRuntime({ env, siteId: SITE_ID });
      let providerError: unknown;
      try {
        seedGoalFixture(database);
        if (goalId === "goal-invalid") insertInvalidGoalDefinition(database);
        const result = await runtime.execute(
          "visitors",
          visitorGoalRuntimeRequest({
            goalId,
            scope: "session",
            cursor: "malformed-cursor",
          }),
          {
            onProviderError(error) {
              providerError = error;
            },
          },
        );
        expect(result).toMatchObject({
          ok: false,
          error: { kind: "internal", operation: "visitors" },
        });
        expect(providerError).toBeInstanceOf(Error);
        if (label === "missing Goal")
          expect((providerError as Error).message).toBe("resource-not-found");
        else
          expect((providerError as Error).message).toContain(
            "goal_filter_dsl_invalid",
          );
        expect(goalLookupSqlCalls(trace)).toHaveLength(1);
        expect(qualificationEnvelopeSqlCalls(trace)).toHaveLength(1);
        expect(envelopeRows).toHaveLength(1);
        expect(envelopeRows[0]).toMatchObject({
          rowKind: "control",
          outputId: PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT,
        });
        writeGoalStageEvidence(`post-route-${goalId}-control-error.json`, {
          state: "post-route-count-controls-before-original-goal-error",
          nodeVersion: process.version,
          goalId,
          malformedCursor: true,
          observedError: {
            name: (providerError as Error).name,
            message: (providerError as Error).message,
          },
          goalLookupCount: goalLookupSqlCalls(trace).length,
          qualificationEnvelopeCount:
            qualificationEnvelopeSqlCalls(trace).length,
          envelopeRows,
        });
      } finally {
        database.close();
      }
    },
  );

  it("preserves the typed Goal lookup error and cause after public Count controls", async () => {
    const database = createMigratedDatabase();
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const lookupCause = new Error("wave97z_route_goal_lookup_cause");
    const lookupError = new Error("wave97z_route_goal_lookup_failed", {
      cause: lookupCause,
    });
    const envelopeRows: Record<string, unknown>[] = [];
    const env = {
      DB: d1WithEnvelopeRowTransform(database, trace, (row) => row, {
        goalLookupError: lookupError,
        onEnvelopeRows: (rows) => envelopeRows.push(...rows),
      }),
      MAIN_SECRET: "wave97r-visitor-list-baseline-secret",
    } as unknown as Env;
    let providerError: unknown;
    try {
      seedGoalFixture(database);
      const result = await createD1SiteQueryRuntime({
        env,
        siteId: SITE_ID,
      }).execute(
        "visitors",
        visitorGoalRuntimeRequest({ goalId: "goal-page", scope: "visitor" }),
        {
          onProviderError(error) {
            providerError = error;
          },
        },
      );
      expect(result).toMatchObject({
        ok: false,
        error: { kind: "internal", operation: "visitors" },
      });
      expect(providerError).toBe(lookupError);
      expect((providerError as Error).cause).toBe(lookupCause);
      expect(goalLookupSqlCalls(trace)).toHaveLength(1);
      expect(qualificationEnvelopeSqlCalls(trace)).toHaveLength(1);
      expect(envelopeRows).toHaveLength(1);
      expect(envelopeRows[0]?.rowKind).toBe("control");
      writeGoalStageEvidence("post-route-goal-lookup-error-controls.json", {
        state: "post-route-exact-goal-lookup-error-after-count-controls",
        nodeVersion: process.version,
        observedSameErrorInstance: providerError === lookupError,
        observedCauseIdentity: (providerError as Error).cause === lookupCause,
        observedError: {
          name: (providerError as Error).name,
          message: (providerError as Error).message,
          cause: { name: lookupCause.name, message: lookupCause.message },
        },
        goalLookupCount: goalLookupSqlCalls(trace).length,
        qualificationEnvelopeCount: qualificationEnvelopeSqlCalls(trace).length,
        envelopeRows,
      });
    } finally {
      database.close();
    }
  });

  it("lets Count cap outrank a thrown Goal lookup error and malformed cursor", async () => {
    const database = createMigratedDatabase();
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const lookupError = new Error("wave97z_route_lookup_failed_under_cap");
    const envelopeRows: Record<string, unknown>[] = [];
    let rawCountBeforeMutation: unknown;
    const env = {
      DB: d1WithEnvelopeRowTransform(
        database,
        trace,
        (row) => {
          if (row.rowKind !== "control") return row;
          rawCountBeforeMutation = row.rawCount;
          return { ...row, rawCount: 20_001 };
        },
        {
          goalLookupError: lookupError,
          onEnvelopeRows: (rows) => envelopeRows.push(...rows),
        },
      ),
      MAIN_SECRET: "wave97r-visitor-list-baseline-secret",
    } as unknown as Env;
    let providerError: unknown;
    try {
      seedGoalFixture(database);
      const result = await createD1SiteQueryRuntime({
        env,
        siteId: SITE_ID,
      }).execute(
        "visitors",
        visitorGoalRuntimeRequest({
          goalId: "goal-page",
          scope: "session",
          cursor: "malformed-cursor",
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
      expect(rawCountBeforeMutation).toEqual(expect.any(Number));
      expect(rawCountBeforeMutation).not.toBe(20_001);
      expect(goalLookupSqlCalls(trace)).toHaveLength(1);
      expect(qualificationEnvelopeSqlCalls(trace)).toHaveLength(1);
      expect(envelopeRows).toHaveLength(1);
      expect(envelopeRows[0]?.rowKind).toBe("control");
      writeGoalStageEvidence("post-route-goal-cap-priority.json", {
        state: "post-route-count-cap-overrides-goal-error-and-cursor",
        nodeVersion: process.version,
        observedError: {
          name: (providerError as Error).name,
          message: (providerError as Error).message,
        },
        controlMutation: {
          rawCountBeforeMutation,
          rawCountAfterMutation: 20_001,
        },
        goalLookupCount: goalLookupSqlCalls(trace).length,
        qualificationEnvelopeCount: qualificationEnvelopeSqlCalls(trace).length,
        envelopeRows,
      });
    } finally {
      database.close();
    }
  });

  it("maps abort after Goal lookup without opening the Count envelope or legacy reader", async () => {
    const database = createMigratedDatabase();
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const controller = new AbortController();
    const env = {
      DB: d1WithEnvelopeRowTransform(database, trace, (row) => row, {
        afterGoalLookup: () => controller.abort(),
      }),
      MAIN_SECRET: "wave97r-visitor-list-baseline-secret",
    } as unknown as Env;
    let providerError: unknown;
    try {
      seedGoalFixture(database);
      const result = await createD1SiteQueryRuntime({
        env,
        siteId: SITE_ID,
      }).execute(
        "visitors",
        visitorGoalRuntimeRequest({ goalId: "goal-page", scope: "visitor" }),
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
      expect(goalLookupSqlCalls(trace)).toHaveLength(1);
      expect(qualificationEnvelopeSqlCalls(trace)).toHaveLength(0);
      writeGoalStageEvidence("post-route-goal-abort-after-lookup.json", {
        state: "post-route-abort-after-goal-lookup-before-count-envelope",
        nodeVersion: process.version,
        observedError: {
          name: (providerError as Error).name,
          message: (providerError as Error).message,
        },
        goalLookupCount: goalLookupSqlCalls(trace).length,
        qualificationEnvelopeCount: qualificationEnvelopeSqlCalls(trace).length,
        calls: trace.preparedSql.map((sql, index) => ({
          sql,
          bindings: trace.bindings[index] ?? [],
        })),
      });
    } finally {
      database.close();
    }
  });

  it("reuses the parsed Goal in a public numeric Count fallback", async () => {
    const database = createMigratedDatabase();
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const diagnostics = createD1ReadDiagnostics();
    const env = {
      DB: createSqliteD1Database(database, trace),
      MAIN_SECRET: "wave97r-visitor-list-baseline-secret",
    } as unknown as Env;
    try {
      seedGoalFixture(database);
      database
        .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
        .run("invalid-duration", "v1-match-1");
      const request = visitorGoalRuntimeRequest({
        goalId: "goal-page",
        scope: "session",
        filterDsl: GOAL_NUMERIC_COUNT_FILTER_DSL,
      });
      const routeStart = trace.preparedSql.length;
      const actual = await createD1SiteQueryRuntime({
        env,
        siteId: SITE_ID,
        diagnostics,
      }).execute("visitors", request);
      expect(actual.ok, JSON.stringify(actual)).toBe(true);
      if (!actual.ok)
        throw new Error("visitor_goal_numeric_route_fallback_failed");
      const routeCalls = trace.preparedSql.slice(routeStart);
      expect(
        routeCalls.filter((sql) => sql.includes('"analysis_definitions"')),
      ).toHaveLength(1);
      expect(
        routeCalls.filter(
          (sql) => sql.includes('"rowKind"') && sql.includes('"outputId"'),
        ),
      ).toHaveLength(1);
      expect(diagnostics.advancedCountSqlFallbackReason).toMatchObject({
        kind: "numeric-data-domain",
        fieldIds: ["page.durationMs"],
      });
      const legacy = await legacyVisitorPage(env, request);
      expect(actual.data).toEqual(legacy);
      expect(goalLookupSqlCalls(trace)).toHaveLength(2);
      writeGoalStageEvidence("post-route-goal-numeric-fallback-reuse.json", {
        state: "post-route-whole-count-fallback-reuses-resolved-goal",
        nodeVersion: process.version,
        result: actual.data,
        legacy,
        routeCalls,
        totalGoalLookupsWithOneExplicitLegacyReference:
          goalLookupSqlCalls(trace).length,
        fallbackReason: diagnostics.advancedCountSqlFallbackReason,
      });
    } finally {
      database.close();
    }
  });

  it("prepares Count fallback once then returns the saved missing Goal error", async () => {
    const database = createMigratedDatabase();
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const diagnostics = createD1ReadDiagnostics();
    const env = {
      DB: createSqliteD1Database(database, trace),
      MAIN_SECRET: "wave97r-visitor-list-baseline-secret",
    } as unknown as Env;
    let providerError: unknown;
    try {
      seedGoalFixture(database);
      database
        .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
        .run("invalid-duration", "v1-match-1");
      const result = await createD1SiteQueryRuntime({
        env,
        siteId: SITE_ID,
        diagnostics,
      }).execute(
        "visitors",
        visitorGoalRuntimeRequest({
          goalId: "missing-goal",
          scope: "session",
          filterDsl: GOAL_NUMERIC_COUNT_FILTER_DSL,
        }),
        {
          onProviderError(error) {
            providerError = error;
          },
        },
      );
      expect(result).toMatchObject({
        ok: false,
        error: { kind: "internal", operation: "visitors" },
      });
      expect((providerError as Error).message).toBe("resource-not-found");
      expect(goalLookupSqlCalls(trace)).toHaveLength(1);
      expect(qualificationEnvelopeSqlCalls(trace)).toHaveLength(1);
      expect(diagnostics.advancedCountSqlFallbackReason).toMatchObject({
        kind: "numeric-data-domain",
        fieldIds: ["page.durationMs"],
      });
      writeGoalStageEvidence("post-route-missing-goal-numeric-fallback.json", {
        state: "post-route-count-fallback-then-saved-goal-error-no-second-read",
        nodeVersion: process.version,
        observedError: {
          name: (providerError as Error).name,
          message: (providerError as Error).message,
        },
        goalLookupCount: goalLookupSqlCalls(trace).length,
        qualificationEnvelopeCount: qualificationEnvelopeSqlCalls(trace).length,
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

  it("rejects a cursor signed for a different Goal after Count controls", async () => {
    const database = createMigratedDatabase();
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const envelopeRows: Record<string, unknown>[] = [];
    const env = {
      DB: d1WithEnvelopeRowTransform(database, trace, (row) => row, {
        onEnvelopeRows: (rows) => envelopeRows.push(...rows),
      }),
      MAIN_SECRET: "wave97r-visitor-list-baseline-secret",
    } as unknown as Env;
    let providerError: unknown;
    try {
      seedGoalFixture(database);
      const runtime = createD1SiteQueryRuntime({ env, siteId: SITE_ID });
      const first = await runtime.execute(
        "visitors",
        visitorGoalRuntimeRequest({
          goalId: "goal-page",
          scope: "session",
        }),
      );
      expect(first.ok, JSON.stringify(first)).toBe(true);
      if (!first.ok) throw new Error("visitor_goal_cursor_seed_failed");
      const start = trace.preparedSql.length;
      const changed = await runtime.execute(
        "visitors",
        visitorGoalRuntimeRequest({
          goalId: "goal-event",
          scope: "session",
          cursor: first.data.pagination.nextCursor,
        }),
        {
          onProviderError(error) {
            providerError = error;
          },
        },
      );
      expect(changed.ok).toBe(false);
      expect(providerError).toMatchObject({
        name: "InvalidCursorError",
        message: "invalid-cursor",
      });
      const changedCalls = trace.preparedSql.slice(start);
      expect(
        changedCalls.filter((sql) => sql.includes('"analysis_definitions"')),
      ).toHaveLength(1);
      expect(
        changedCalls.filter(
          (sql) => sql.includes('"rowKind"') && sql.includes('"outputId"'),
        ),
      ).toHaveLength(1);
      expect(envelopeRows.at(-1)?.rowKind).toBe("control");
      writeGoalStageEvidence("post-route-cross-goal-cursor.json", {
        state: "post-route-cross-goal-token-rejected-after-count-controls",
        nodeVersion: process.version,
        firstGoalId: "goal-page",
        requestedGoalId: "goal-event",
        providerError: {
          name: (providerError as Error).name,
          message: (providerError as Error).message,
        },
        changedCalls,
        envelopeRows: envelopeRows.slice(-1),
      });
    } finally {
      database.close();
    }
  });
});

describe("Visitors qualified runtime DTO and cursor compatibility", () => {
  it.each(
    SORT_KEYS.flatMap((sortKey) =>
      (["asc", "desc"] as const).map(
        (direction) => [sortKey, direction] as const,
      ),
    ),
  )(
    "preserves the public %s/%s DTO and signed next cursor",
    async (sortKey, direction) => {
      const database = createMigratedDatabase();
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const env = {
        DB: createSqliteD1Database(database, trace),
        MAIN_SECRET: "wave97r-visitor-list-baseline-secret",
      } as unknown as Env;
      const diagnostics = createD1ReadDiagnostics();
      try {
        seedFixture(database);
        const runtime = createD1SiteQueryRuntime({
          env,
          siteId: SITE_ID,
          diagnostics,
        });
        const request = visitorQuery({
          scope: "visitor",
          sortKey,
          direction,
          advanced: true,
        });
        const sqlStart = trace.preparedSql.length;
        const actual = await runtime.execute("visitors", request);
        expect(actual.ok, JSON.stringify(actual)).toBe(true);
        if (!actual.ok) throw new Error("visitor_list_runtime_query_failed");
        const actualSql = trace.preparedSql.slice(sqlStart);
        expect(
          actualSql.filter(
            (sql) => sql.includes('"rowKind"') && sql.includes('"outputId"'),
          ),
        ).toHaveLength(1);
        expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
        expect(actual.data.pagination.nextCursor).toEqual(expect.any(String));
        expect(actual.data.items).toHaveLength(1);
        expect(actual.data).toEqual(await legacyVisitorPage(env, request));
      } finally {
        database.close();
      }
    },
  );

  it.each(["session", "visitor"] as const)(
    "keeps a three-page old-to-new-to-old cursor chain for %s Count scope",
    async (scope) => {
      const database = createMigratedDatabase();
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const env = {
        DB: createSqliteD1Database(database, trace),
        MAIN_SECRET: "wave97r-visitor-list-baseline-secret",
      } as unknown as Env;
      try {
        seedFixture(database);
        const runtime = createD1SiteQueryRuntime({ env, siteId: SITE_ID });
        const request = (cursor: string | null) =>
          visitorQuery({
            scope,
            sortKey: "lastSeenAt",
            direction: "desc",
            advanced: true,
            cursor,
          });
        const oldFirst = await legacyVisitorPage(env, request(null));
        expect(oldFirst.items).toHaveLength(1);
        expect(oldFirst.pagination.nextCursor).toEqual(expect.any(String));

        const sqlStart = trace.preparedSql.length;
        const newSecond = await runtime.execute(
          "visitors",
          request(oldFirst.pagination.nextCursor),
        );
        expect(newSecond.ok, JSON.stringify(newSecond)).toBe(true);
        if (!newSecond.ok) throw new Error("visitor_list_runtime_query_failed");
        expect(
          trace.preparedSql
            .slice(sqlStart)
            .filter(
              (sql) => sql.includes('"rowKind"') && sql.includes('"outputId"'),
            ),
        ).toHaveLength(1);
        const oldSecond = await legacyVisitorPage(
          env,
          request(oldFirst.pagination.nextCursor),
        );
        expect(newSecond.data).toEqual(oldSecond);
        expect(newSecond.data.pagination.nextCursor).toEqual(
          expect.any(String),
        );

        const oldThird = await legacyVisitorPage(
          env,
          request(newSecond.data.pagination.nextCursor),
        );
        expect(oldThird.items).toHaveLength(1);
        expect(oldThird.items[0]?.visitorId).not.toBe(
          oldFirst.items[0]?.visitorId,
        );
        expect(oldThird.items[0]?.visitorId).not.toBe(
          newSecond.data.items[0]?.visitorId,
        );
      } finally {
        database.close();
      }
    },
  );

  it("preserves ordinary Visitors sorting and cursor behavior on the legacy route", async () => {
    for (const sortKey of SORT_KEYS) {
      const database = createMigratedDatabase();
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const env = {
        DB: createSqliteD1Database(database, trace),
        MAIN_SECRET: "wave97r-visitor-list-baseline-secret",
      } as unknown as Env;
      try {
        seedFixture(database);
        const runtime = createD1SiteQueryRuntime({ env, siteId: SITE_ID });
        const request = (cursor: string | null) =>
          visitorQuery({
            sortKey,
            direction: "desc",
            advanced: false,
            cursor,
          });
        const first = await runtime.execute("visitors", request(null));
        expect(first.ok, JSON.stringify(first)).toBe(true);
        if (!first.ok) throw new Error("visitor_list_runtime_query_failed");
        expect(first.data).toEqual(
          await ordinaryVisitorPage(env, request(null)),
        );
        expect(first.data.pagination.nextCursor).toEqual(expect.any(String));
        const second = await runtime.execute(
          "visitors",
          request(first.data.pagination.nextCursor),
        );
        expect(second.ok, JSON.stringify(second)).toBe(true);
        if (!second.ok) throw new Error("visitor_list_runtime_query_failed");
        expect(second.data).toEqual(
          await ordinaryVisitorPage(
            env,
            request(first.data.pagination.nextCursor),
          ),
        );
        expect(
          trace.preparedSql.filter(
            (sql) => sql.includes('"rowKind"') && sql.includes('"outputId"'),
          ),
        ).toHaveLength(0);
      } finally {
        database.close();
      }
    }
  });

  it("keeps session-scope visitor rows narrow and visitor-scope activity expanded", async () => {
    const database = createMigratedDatabase();
    const env = {
      DB: createSqliteD1Database(database),
      MAIN_SECRET: "wave97r-visitor-list-baseline-secret",
    } as unknown as Env;
    try {
      seedFixture(database);
      const runtime = createD1SiteQueryRuntime({ env, siteId: SITE_ID });
      const request = (scope: "session" | "visitor") =>
        visitorQuery({
          scope,
          sortKey: "lastSeenAt",
          direction: "desc",
          advanced: true,
          limit: 20,
        });
      const sessionScope = await runtime.execute(
        "visitors",
        request("session"),
      );
      const visitorScope = await runtime.execute(
        "visitors",
        request("visitor"),
      );
      expect(sessionScope.ok, JSON.stringify(sessionScope)).toBe(true);
      expect(visitorScope.ok, JSON.stringify(visitorScope)).toBe(true);
      if (!sessionScope.ok || !visitorScope.ok)
        throw new Error("visitor_list_runtime_query_failed");
      expect(sessionScope.data).toEqual(
        await legacyVisitorPage(env, request("session")),
      );
      expect(visitorScope.data).toEqual(
        await legacyVisitorPage(env, request("visitor")),
      );
      const sessionAlpha = sessionScope.data.items.find(
        ({ visitorId }) => visitorId === "visitor-1",
      );
      const visitorAlpha = visitorScope.data.items.find(
        ({ visitorId }) => visitorId === "visitor-1",
      );
      expect(sessionAlpha).toBeDefined();
      expect(visitorAlpha).toBeDefined();
      expect(visitorAlpha!.views).toBeGreaterThan(sessionAlpha!.views);
      expect(visitorAlpha!.sessions).toBeGreaterThan(sessionAlpha!.sessions);
    } finally {
      database.close();
    }
  });

  it("preserves Unicode search, case folding, and visitor tie ordering", async () => {
    const database = createMigratedDatabase();
    const env = {
      DB: createSqliteD1Database(database),
      MAIN_SECRET: "wave97r-visitor-list-baseline-secret",
    } as unknown as Env;
    try {
      seedFixture(database);
      insertVisit(database, {
        visitId: "unicode-a-visit",
        visitorId: "visitor-unicode-a",
        sessionId: "unicode-session-a",
        startedAt: BASE + 10_000,
        pathname: "/München/Über",
      });
      insertVisit(database, {
        visitId: "unicode-b-visit",
        visitorId: "visitor-unicode-b",
        sessionId: "unicode-session-b",
        startedAt: BASE + 10_000,
        pathname: "/München/Über",
      });
      const runtime = createD1SiteQueryRuntime({ env, siteId: SITE_ID });
      const request = visitorQuery({
        scope: "visitor",
        sortKey: "views",
        direction: "desc",
        advanced: true,
        search: "MÜNCHEN",
        limit: 10,
        filterDsl:
          'page.path eq "/München/Über" and count(page { page.path eq "/München/Über" }) gte 1',
      });
      const actual = await runtime.execute("visitors", request);
      expect(actual.ok, JSON.stringify(actual)).toBe(true);
      if (!actual.ok) throw new Error("visitor_list_runtime_query_failed");
      expect(actual.data).toEqual(await legacyVisitorPage(env, request));
      expect(actual.data.items.map(({ visitorId }) => visitorId)).toEqual([
        "visitor-unicode-a",
        "visitor-unicode-b",
      ]);
    } finally {
      database.close();
    }
  });

  it("keeps Event-only visitor owners when the owner Page is outside the window", async () => {
    const database = createMigratedDatabase();
    const env = {
      DB: createSqliteD1Database(database),
      MAIN_SECRET: "wave97r-visitor-list-baseline-secret",
    } as unknown as Env;
    try {
      seedFixture(database);
      seedEventOnlyOwnerOutsideWindow(database);
      const runtime = createD1SiteQueryRuntime({ env, siteId: SITE_ID });
      const request = visitorQuery({
        scope: "visitor",
        sortKey: "lastSeenAt",
        direction: "desc",
        advanced: true,
        limit: 10,
        filterDsl: 'count(event { event.name eq "signup" }) gte 1',
      });
      const actual = await runtime.execute("visitors", request);
      expect(actual.ok, JSON.stringify(actual)).toBe(true);
      if (!actual.ok) throw new Error("visitor_list_runtime_query_failed");
      expect(actual.data).toEqual(await legacyVisitorPage(env, request));
      expect(actual.data.items).toContainEqual(
        expect.objectContaining({
          visitorId: "visitor-event-only",
          sessionId: "",
          views: 0,
          sessions: 0,
          events: 1,
        }),
      );
    } finally {
      database.close();
    }
  });

  it("keeps same-named cross-site visitor identities isolated", async () => {
    const database = createMigratedDatabase();
    const env = {
      DB: createSqliteD1Database(database),
      MAIN_SECRET: "wave97r-visitor-list-baseline-secret",
    } as unknown as Env;
    try {
      seedFixture(database);
      const otherSiteId = `${SITE_ID}-other`;
      database
        .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
        .run(otherSiteId);
      const otherSitePk = (
        database
          .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
          .get(otherSiteId) as { readonly site_pk: number }
      ).site_pk;
      database
        .prepare(
          `INSERT INTO sites (id, team_id, name, domain, created_at)
           VALUES (?, 'wave97r-team', 'Other site', 'other.test', 0)`,
        )
        .run(otherSiteId);
      insertVisit(database, {
        siteId: otherSiteId,
        sitePk: otherSitePk,
        visitId: "other-site-colliding-visitor",
        visitorId: "visitor-1",
        sessionId: "other-site-session",
        startedAt: BASE + 1_000,
        pathname: "/match",
        hostname: "other.test",
      });
      const runtime = createD1SiteQueryRuntime({ env, siteId: SITE_ID });
      const request = visitorQuery({
        scope: "visitor",
        sortKey: "views",
        direction: "desc",
        advanced: true,
        limit: 20,
      });
      const actual = await runtime.execute("visitors", request);
      expect(actual.ok, JSON.stringify(actual)).toBe(true);
      if (!actual.ok) throw new Error("visitor_list_runtime_query_failed");
      expect(actual.data).toEqual(await legacyVisitorPage(env, request));
      expect(
        actual.data.items.find(({ visitorId }) => visitorId === "visitor-1")
          ?.views,
      ).toBe(3);
    } finally {
      database.close();
    }
  });

  it("excludes empty identities and returns an empty page for no Count matches", async () => {
    const database = createMigratedDatabase();
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const env = {
      DB: createSqliteD1Database(database, trace),
      MAIN_SECRET: "wave97r-visitor-list-baseline-secret",
    } as unknown as Env;
    try {
      seedFixture(database);
      insertVisit(database, {
        visitId: "empty-visitor-id",
        visitorId: "",
        sessionId: "empty-owner-session",
        startedAt: BASE + 7_000,
        pathname: "/match",
      });
      const runtime = createD1SiteQueryRuntime({ env, siteId: SITE_ID });
      const ordinaryRequest = visitorQuery({
        sortKey: "lastSeenAt",
        direction: "desc",
        advanced: false,
        limit: 20,
      });
      const ordinary = await runtime.execute("visitors", ordinaryRequest);
      expect(ordinary.ok, JSON.stringify(ordinary)).toBe(true);
      if (!ordinary.ok) throw new Error("visitor_list_runtime_query_failed");
      expect(ordinary.data).toEqual(
        await ordinaryVisitorPage(env, ordinaryRequest),
      );
      expect(
        ordinary.data.items.map(({ visitorId }) => visitorId),
      ).not.toContain("");

      const noMatchRequest = visitorQuery({
        scope: "visitor",
        sortKey: "views",
        direction: "desc",
        advanced: true,
        limit: 10,
        filterDsl:
          'page.path eq "/missing" and count(page { page.path eq "/missing" }) gte 1',
      });
      const noMatch = await runtime.execute("visitors", noMatchRequest);
      expect(noMatch.ok, JSON.stringify(noMatch)).toBe(true);
      if (!noMatch.ok) throw new Error("visitor_list_runtime_query_failed");
      expect(noMatch.data.items).toEqual([]);
      expect(noMatch.data.pagination).toMatchObject({
        returned: 0,
        hasMore: false,
        nextCursor: null,
      });
    } finally {
      database.close();
    }
  });
});

describe("Visitors qualified guards and request admission", () => {
  it("brands the canonical Visitors request produced by the real middleware", async () => {
    const database = createMigratedDatabase();
    const env = {
      DB: createSqliteD1Database(database),
      MAIN_SECRET: "wave97r-visitor-list-baseline-secret",
    } as unknown as Env;
    try {
      seedGoalFixture(database);
      const query = await visitorMiddlewareQuery(
        env,
        visitorQuery({
          scope: "visitor",
          sortKey: "lastSeenAt",
          direction: "desc",
          advanced: true,
          goalId: "goal-page",
        }),
      );
      expect(
        deferredEventQualificationFromQuery(query, "visitors"),
      ).toBeDefined();
      expect(deferredVisitorListQualificationFromQuery(query)).toBeDefined();
      expect(
        deferredVisitorListQualificationFromQuery(query)?.configuration
          .analysisContext,
      ).toEqual({ type: "goal", goalId: "goal-page" });
    } finally {
      database.close();
    }
  });

  it("admits only an exact own-data Goal analysis context", () => {
    const valid = prepareScopedQuery(
      "visitors",
      visitorQuery({
        scope: "visitor",
        sortKey: "lastSeenAt",
        direction: "desc",
        advanced: true,
        goalId: "goal-page",
      }),
    ) as unknown as QueryInput & Record<string, unknown>;
    expect(
      visitorListQualificationConfigurationFromQuery(valid)?.analysisContext,
    ).toEqual({ type: "goal", goalId: "goal-page" });

    const funnelContext = {
      ...valid,
      analysisContext: { type: "funnel", funnelId: "funnel-1" },
    } as QueryInput & Record<string, unknown>;
    expect(
      visitorListQualificationConfigurationFromQuery(funnelContext),
    ).toBeUndefined();

    const accessorContext = { ...valid } as QueryInput &
      Record<string, unknown>;
    let getterCalls = 0;
    Object.defineProperty(accessorContext, "analysisContext", {
      enumerable: true,
      configurable: true,
      value: Object.defineProperties(
        {},
        {
          type: { enumerable: true, value: "goal" },
          goalId: {
            enumerable: true,
            get() {
              getterCalls += 1;
              return "goal-page";
            },
          },
        },
      ),
    });
    expect(
      visitorListQualificationConfigurationFromQuery(accessorContext),
    ).toBeUndefined();
    expect(getterCalls).toBe(0);
  });

  it("performs one whole legacy fallback for actual TEXT numeric Count data", async () => {
    const database = createMigratedDatabase();
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const env = {
      DB: createSqliteD1Database(database, trace),
      MAIN_SECRET: "wave97r-visitor-list-baseline-secret",
    } as unknown as Env;
    const diagnostics = createD1ReadDiagnostics();
    try {
      seedFixture(database);
      database
        .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
        .run("invalid-duration", "v1-match-1");
      const request = visitorQuery({
        scope: "visitor",
        sortKey: "lastSeenAt",
        direction: "desc",
        advanced: true,
        filterDsl:
          'page.path eq "/match" and count(page { page.durationMs gt 5 }) eq 1',
      });
      const result = await createD1SiteQueryRuntime({
        env,
        siteId: SITE_ID,
        diagnostics,
      }).execute("visitors", request);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) throw new Error("visitor_list_runtime_query_failed");
      expect(result.data).toEqual(await legacyVisitorPage(env, request));
      expect(diagnostics.advancedCountSqlFallbackReason).toEqual({
        kind: "numeric-data-domain",
        fieldIds: ["page.durationMs"],
      });
      expect(
        trace.preparedSql.filter(
          (sql) => sql.includes('"rowKind"') && sql.includes('"outputId"'),
        ),
      ).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it("checks Count controls before returning a malformed cursor error", async () => {
    const database = createMigratedDatabase();
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const env = {
      DB: createSqliteD1Database(database, trace),
      MAIN_SECRET: "wave97r-visitor-list-baseline-secret",
    } as unknown as Env;
    try {
      seedFixture(database);
      const result = await createD1SiteQueryRuntime({
        env,
        siteId: SITE_ID,
      }).execute(
        "visitors",
        visitorQuery({
          scope: "visitor",
          sortKey: "lastSeenAt",
          direction: "desc",
          advanced: true,
          cursor: "malformed-cursor",
        }),
      );
      expect(result).toMatchObject({
        ok: false,
        error: { kind: "invalid-cursor", cursorKind: "journey-visitors" },
      });
      expect(
        trace.preparedSql.filter(
          (sql) => sql.includes('"rowKind"') && sql.includes('"outputId"'),
        ),
      ).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it("lets the real activity cap outrank a malformed cursor", async () => {
    const database = createMigratedDatabase();
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const env = {
      DB: d1WithEnvelopeRowTransform(database, trace, (row) =>
        row.rowKind === "control" ? { ...row, rawCount: 20_001 } : row,
      ),
      MAIN_SECRET: "wave97r-visitor-list-baseline-secret",
    } as unknown as Env;
    try {
      seedFixture(database);
      const result = await createD1SiteQueryRuntime({
        env,
        siteId: SITE_ID,
      }).execute(
        "visitors",
        visitorQuery({
          scope: "visitor",
          sortKey: "lastSeenAt",
          direction: "desc",
          advanced: true,
          cursor: "malformed-cursor",
        }),
      );
      expect(result).toMatchObject({
        ok: false,
        error: {
          kind: "invalid-input",
          issues: [{ path: "filters", code: "filter_activity_limit_exceeded" }],
        },
      });
      expect(
        trace.preparedSql.filter(
          (sql) => sql.includes('"rowKind"') && sql.includes('"outputId"'),
        ),
      ).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it("rejects an unknown report kind when a valid fallback control is present", async () => {
    const database = createMigratedDatabase();
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const env = {
      DB: d1WithEnvelopeRowTransform(database, trace, (row) =>
        row.rowKind === "control"
          ? { ...row, nullActivityIdCount: 1 }
          : row.rowKind === "report"
            ? { ...row, rowKind: "unknown" }
            : row,
      ),
      MAIN_SECRET: "wave97r-visitor-list-baseline-secret",
    } as unknown as Env;
    try {
      seedFixture(database);
      const result = await createD1SiteQueryRuntime({
        env,
        siteId: SITE_ID,
      }).execute(
        "visitors",
        visitorQuery({
          scope: "visitor",
          sortKey: "lastSeenAt",
          direction: "desc",
          advanced: true,
        }),
      );
      expect(result).toMatchObject({
        ok: false,
        error: { kind: "internal", operation: "visitors" },
      });
      expect(
        trace.preparedSql.filter(
          (sql) => sql.includes('"rowKind"') && sql.includes('"outputId"'),
        ),
      ).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it.each([
    ["empty", ""],
    ["null", null],
    ["number", 19],
    ["duplicate", "duplicate-visitor"],
  ] as const)(
    "rejects a %s report visitor identity before mapping",
    async (kind, value) => {
      const database = createMigratedDatabase();
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      let seenReportRows = 0;
      const env = {
        DB: d1WithEnvelopeRowTransform(database, trace, (row) => {
          if (row.rowKind !== "report") return row;
          if (kind === "duplicate") {
            seenReportRows += 1;
            return { ...row, visitorId: value };
          }
          return { ...row, visitorId: value };
        }),
        MAIN_SECRET: "wave97r-visitor-list-baseline-secret",
      } as unknown as Env;
      try {
        seedFixture(database);
        const result = await createD1SiteQueryRuntime({
          env,
          siteId: SITE_ID,
        }).execute(
          "visitors",
          visitorQuery({
            scope: "visitor",
            sortKey: "lastSeenAt",
            direction: "desc",
            advanced: true,
          }),
        );
        expect(result).toMatchObject({
          ok: false,
          error: { kind: "internal", operation: "visitors" },
        });
        if (kind === "duplicate") expect(seenReportRows).toBeGreaterThan(1);
        expect(
          trace.preparedSql.filter(
            (sql) => sql.includes('"rowKind"') && sql.includes('"outputId"'),
          ),
        ).toHaveLength(1);
      } finally {
        database.close();
      }
    },
  );

  it("propagates D1 failures without retrying the legacy reader", async () => {
    const database = createMigratedDatabase();
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const env = {
      DB: d1WithEnvelopeRowTransform(database, trace, () => {
        throw new Error("visitor_list_qualification_d1_failed");
      }),
      MAIN_SECRET: "wave97r-visitor-list-baseline-secret",
    } as unknown as Env;
    try {
      seedFixture(database);
      const result = await createD1SiteQueryRuntime({
        env,
        siteId: SITE_ID,
      }).execute(
        "visitors",
        visitorQuery({
          scope: "visitor",
          sortKey: "lastSeenAt",
          direction: "desc",
          advanced: true,
        }),
      );
      expect(result).toMatchObject({
        ok: false,
        error: { kind: "internal", operation: "visitors" },
      });
      expect(
        trace.preparedSql.filter(
          (sql) => sql.includes('"rowKind"') && sql.includes('"outputId"'),
        ),
      ).toHaveLength(1);
      expect(trace.preparedSql.at(-1)).toContain('"rowKind"');
    } finally {
      database.close();
    }
  });

  it("honors an abort without opening the qualification query", async () => {
    const database = createMigratedDatabase();
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const env = {
      DB: createSqliteD1Database(database, trace),
      MAIN_SECRET: "wave97r-visitor-list-baseline-secret",
    } as unknown as Env;
    try {
      seedFixture(database);
      const controller = new AbortController();
      controller.abort();
      const result = await createD1SiteQueryRuntime({
        env,
        siteId: SITE_ID,
      }).execute(
        "visitors",
        visitorQuery({
          scope: "visitor",
          sortKey: "lastSeenAt",
          direction: "desc",
          advanced: true,
        }),
        { signal: controller.signal },
      );
      expect(result).toMatchObject({
        ok: false,
        error: { kind: "request-cancelled" },
      });
      expect(
        trace.preparedSql.filter(
          (sql) => sql.includes('"rowKind"') && sql.includes('"outputId"'),
        ),
      ).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  it("rejects cloned and mutated branded requests without evaluating getters", async () => {
    const database = createMigratedDatabase();
    const env = {
      DB: createSqliteD1Database(database),
      MAIN_SECRET: "wave97r-visitor-list-baseline-secret",
    } as unknown as Env;
    try {
      seedFixture(database);
      const request = visitorQuery({
        scope: "visitor",
        sortKey: "lastSeenAt",
        direction: "desc",
        advanced: true,
        goalId: "goal-page",
      });
      const branded = await visitorMiddlewareQuery(env, request);
      expect(deferredVisitorListQualificationFromQuery(branded)).toBeDefined();
      expect(
        visitorListQualificationConfigurationFromQuery(branded)
          ?.analysisContext,
      ).toEqual({ type: "goal", goalId: "goal-page" });

      const clone = { ...branded } as QueryInput & Record<string, unknown>;
      for (const key of Reflect.ownKeys(branded)) {
        if (typeof key !== "symbol") continue;
        const descriptor = Object.getOwnPropertyDescriptor(branded, key);
        if (descriptor) Object.defineProperty(clone, key, descriptor);
      }
      expect(() => deferredVisitorListQualificationFromQuery(clone)).toThrow(
        /untrusted/,
      );

      const mutated = await visitorMiddlewareQuery(env, request);
      mutated.search = "changed-after-middleware";
      expect(() => deferredVisitorListQualificationFromQuery(mutated)).toThrow(
        /changed/,
      );

      const accessorBacked = await visitorMiddlewareQuery(env, request);
      let getterCalls = 0;
      Object.defineProperty(accessorBacked, "search", {
        enumerable: true,
        configurable: true,
        get() {
          getterCalls += 1;
          return "München";
        },
      });
      expect(
        visitorListQualificationConfigurationFromQuery(accessorBacked),
      ).toBeUndefined();
      expect(() =>
        deferredVisitorListQualificationFromQuery(accessorBacked),
      ).toThrow(/changed/);
      expect(getterCalls).toBe(0);
    } finally {
      database.close();
    }
  });
});
