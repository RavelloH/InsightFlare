import type { DatabaseSync } from "node:sqlite";

import { afterAll, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { createD1SiteProviderRegistry } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import {
  prepareScopedQuery,
  type QueryInput,
  type QueryTime,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { createQueryTime } from "@/lib/edge/analytics/contract/helpers";
import { ADVANCED_FILTER_MAX_ACTIVITIES } from "@/lib/edge/analytics/engine/advanced-filter-activity-plan";
import {
  DIMENSION_PAGE_REPORT_OUTPUT,
  dimensionPageSelection,
  overviewPageTableDescriptor,
} from "@/lib/edge/analytics/engine/dimension-report-plan";
import { buildEventTypeSummaryQualificationPlan } from "@/lib/edge/analytics/engine/event-type-summary-plan";
import type { RelationId } from "@/lib/edge/analytics/engine/logical/ids";
import {
  buildPageDimensionQualificationPlan,
  buildPagesAggregateQualificationPlan,
  PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT,
  type PageDimensionQualificationPlan,
} from "@/lib/edge/analytics/engine/page-dimension-qualification-plan";
import {
  d1AdvancedFilterMiddleware,
  deferredEventQualificationFromQuery,
  deferredOverviewPageTableQualificationFromQuery,
  deferredPageDimensionQualificationFromQuery,
  deferredPagesAggregatePageQualificationFromQuery,
  prepareDeferredEventQualificationFallback,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { AnalyticsLogicalToDbLowerer } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";
import { mapDimensionRows } from "@/lib/edge/analytics/providers/d1/internal/core";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import {
  decodeDimensionCursor,
  queryDimensionPageFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/dimensions";
import { queryFilterValuesPageFromD1 } from "@/lib/edge/analytics/providers/d1/internal/filter-values";
import type { AnalyticsQualificationAdmissionPolicy } from "@/lib/edge/analytics/providers/d1/internal/lowering/event-summary-admission";
import {
  decodePagesCursor,
  queryPagesPageFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/pages";
import type { Env } from "@/lib/edge/types";
import {
  analyticsFilterRegistry,
  evaluateFilterDocument,
  normalizeFilterDocument,
  parseFilterDsl,
} from "@/lib/filter-contract";

const SITE = "wave97eo-event-candidate-page";
const TIME = createQueryTime(120, 130, "UTC", 500);
const WINDOW = {
  startMs: 120,
  endExclusiveMs: 130,
  nowMs: 500,
  timeZone: "UTC",
} as const;
const CURSOR_SECRET = "wave97eo-event-candidate-page-test-secret";
const BOOLEAN_FILTERS = {
  and: 'count(event { event.name eq "qualifier" }) gt 0 and event.name eq "qualifier"',
  orNot:
    '(count(event { event.name eq "qualifier" }) gt 0 and event.name eq "qualifier") or not (page.path neq "/page-only")',
} as const;
const NUMERIC_FALLBACK_FILTER =
  'count(page { page.durationMs gt 5 }) gt 0 and event.name eq "qualifier"';
const DATABASES = new Set<DatabaseSync>();
const runtimeEvidence: Array<Record<string, unknown>> = [];

type ReportFamily =
  | "dimension-breakdown"
  | "dimension-overview-tab"
  | "pages-aggregate"
  | "page-filter-values";
type FilterKind = keyof typeof BOOLEAN_FILTERS;
type Operation = "dimension" | "pages" | "filter-values";
type CandidateQuery = QueryInput & Record<string, unknown>;
type DeferredQualification = Parameters<
  typeof prepareDeferredEventQualificationFallback
>[0];

interface CandidateRequest {
  readonly family: ReportFamily;
  readonly operation: Operation;
  readonly query: CandidateQuery;
  readonly limit: number;
  readonly cursorToken: string | null;
}

interface TestSite {
  readonly id: string;
  readonly pk: number;
}

interface CapturedSql {
  readonly sql: string;
  readonly rows: readonly Record<string, unknown>[];
}

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
       VALUES (?, 'wave97eo-team', 'Event candidate Page reports', 'page.test', 0)`,
    )
    .run(SITE);
  return { id: SITE, pk: Number(identity.site_pk) };
}

function addVisit(
  database: DatabaseSync,
  site: TestSite,
  input: {
    readonly id: string;
    readonly visitorId: string;
    readonly sessionId: string;
    readonly path: string;
    readonly at: number;
  },
): void {
  database
    .prepare(
      `INSERT INTO visits (
        visit_id, site_id, site_pk, visitor_id, session_id, status,
        started_at, last_activity_at, pathname, query_string, hash_fragment,
        hostname, duration_ms
      ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, '', '', 'page.test', 10)`,
    )
    .run(
      input.id,
      site.id,
      site.pk,
      input.visitorId,
      input.sessionId,
      input.at,
      input.at,
      input.path,
    );
}

function addEvent(
  database: DatabaseSync,
  site: TestSite,
  input: { readonly id: string; readonly visitId: string },
): void {
  database
    .prepare(
      `INSERT INTO custom_event_names (id, site_id, name, last_seen_at, site_pk)
       VALUES (1, ?, 'qualifier', 125, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .run(site.id, site.pk);
  database
    .prepare(
      `INSERT INTO custom_events (
        event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
        received_at, sequence, node_count, value_count
      ) VALUES (?, ?, ?, ?, 1, 125, 125, 1, 0, 0)`,
    )
    .run(input.id, site.id, site.pk, input.visitId);
}

function createFixture(): {
  readonly database: DatabaseSync;
  readonly site: TestSite;
} {
  const database = createMigratedDatabase();
  DATABASES.add(database);
  database.exec("PRAGMA foreign_keys = OFF");
  const site = addSite(database);
  addVisit(database, site, {
    id: "visit-event-only",
    visitorId: "visitor-event-only",
    sessionId: "session-event-only",
    path: "/event-only",
    at: 125,
  });
  addVisit(database, site, {
    id: "visit-page-only",
    visitorId: "visitor-page-only",
    sessionId: "session-page-only",
    path: "/page-only",
    at: 126,
  });
  addVisit(database, site, {
    id: "visit-collision",
    visitorId: "visitor-event-only",
    sessionId: "session-event-only",
    path: "/collision",
    at: 127,
  });
  addVisit(database, site, {
    id: "visit-neither",
    visitorId: "visitor-event-only",
    sessionId: "session-event-only",
    path: "/neither",
    at: 128,
  });
  addEvent(database, site, {
    id: "event-qualifier-one",
    visitId: "visit-event-only",
  });
  addEvent(database, site, {
    // Deliberately collides with another Page's local ID. Membership must use
    // visitId, not the Event entity's local ID.
    id: "visit-collision",
    visitId: "visit-event-only",
  });
  return { database, site };
}

function testEnv(
  database: DatabaseSync,
  trace: SqliteD1Trace,
  captured?: CapturedSql[],
): Env {
  const sqlite = createSqliteD1Database(database, trace);
  const DB = {
    prepare(sql: string) {
      let statement = sqlite.prepare(sql);
      const prepared = {
        bind(...values: Parameters<typeof statement.bind>) {
          statement = statement.bind(...values);
          return prepared;
        },
        first<Row>() {
          return statement.first<Row>();
        },
        async all<Row>() {
          const result = await statement.all<Row>();
          captured?.push({
            sql,
            rows: (result.results ?? []) as Record<string, unknown>[],
          });
          return result;
        },
        run() {
          return statement.run();
        },
      };
      return prepared;
    },
    batch(statements: D1PreparedStatement[]) {
      return sqlite.batch(statements);
    },
  } as unknown as Env["DB"];
  return {
    DB,
    MAIN_SECRET: CURSOR_SECRET,
    DAILY_SALT_SECRET: "wave97eo-daily-secret",
  } as unknown as Env;
}

function candidateQuery(
  family: ReportFamily,
  filterDsl: string,
  limit = 10,
  cursorToken: string | null = null,
): CandidateRequest {
  const operation: Operation =
    family === "pages-aggregate"
      ? "pages"
      : family === "page-filter-values"
        ? "filter-values"
        : "dimension";
  const prepared = prepareScopedQuery(operation, {
    context: siteQueryContext(SITE, "private-dashboard"),
    time: TIME,
    filters: parseFilterDsl(filterDsl, analyticsFilterRegistry),
    scopePreference: "event",
  } as QueryInput & { readonly time: QueryTime });
  let query: CandidateQuery;
  if (family === "dimension-breakdown") {
    query = {
      ...prepared,
      mode: "breakdown",
      dimension: "page.path",
      page: { limit, cursor: cursorToken },
      sort: { key: "views", direction: "desc" },
      search: "",
    } as CandidateQuery;
  } else if (family === "dimension-overview-tab") {
    query = {
      ...prepared,
      mode: "overview-tab",
      tab: "page.path",
      limit,
      cursor: cursorToken,
      sort: "views",
      direction: "desc",
      search: "",
    } as CandidateQuery;
  } else if (family === "pages-aggregate") {
    query = {
      ...prepared,
      limit,
      includeDetails: false,
      includeTabs: false,
      page: { limit, cursor: cursorToken },
    } as CandidateQuery;
  } else {
    query = {
      ...prepared,
      field: "page.path",
      page: { limit, cursor: cursorToken },
    } as CandidateQuery;
  }
  return { family, operation, query, limit, cursorToken };
}

async function deferredFor(
  env: Env,
  request: CandidateRequest,
): Promise<{
  readonly forwarded: CandidateQuery;
  readonly deferred: DeferredQualification;
}> {
  const forwarded = (await d1AdvancedFilterMiddleware(env, undefined, SITE)(
    request.operation,
    request.query,
    async (prepared) => prepared,
  )) as CandidateQuery;
  const deferred =
    request.family === "dimension-breakdown"
      ? deferredPageDimensionQualificationFromQuery(forwarded)
      : request.family === "dimension-overview-tab"
        ? deferredOverviewPageTableQualificationFromQuery(forwarded)
        : request.family === "pages-aggregate"
          ? deferredPagesAggregatePageQualificationFromQuery(forwarded)
          : deferredEventQualificationFromQuery(forwarded, "filter-values");
  if (!deferred) throw new Error(`wave97eo_${request.family}_deferred_missing`);
  return { forwarded, deferred };
}

function requestPageCursor(request: CandidateRequest): string | null {
  if (request.family === "dimension-overview-tab")
    return typeof request.query.cursor === "string"
      ? request.query.cursor
      : null;
  const page = request.query.page as { readonly cursor?: unknown } | undefined;
  return typeof page?.cursor === "string" ? page.cursor : null;
}

async function coreOracle(
  database: DatabaseSync,
  request: CandidateRequest,
): Promise<{
  readonly dto: unknown;
  readonly trace: SqliteD1Trace;
  readonly statements: CapturedSql[];
  readonly graph: Record<string, unknown>;
  readonly deferred: DeferredQualification;
}> {
  const trace = traceFor();
  const statements: CapturedSql[] = [];
  const env = testEnv(database, trace, statements);
  const { deferred } = await deferredFor(env, request);
  const filters = await prepareDeferredEventQualificationFallback(deferred);
  let dto: unknown;
  let graph: Record<string, unknown>;
  if (
    request.family === "dimension-breakdown" ||
    request.family === "dimension-overview-tab"
  ) {
    const selection = dimensionPageSelection("page.path");
    if (!selection) throw new Error("wave97eo_page_path_selection_missing");
    const overview =
      request.family === "dimension-overview-tab"
        ? overviewPageTableDescriptor("page.path")
        : undefined;
    const cursor = await decodeDimensionCursor(
      env,
      SITE,
      WINDOW,
      filters,
      selection,
      "",
      requestPageCursor(request),
      "private-dashboard",
      "views",
      "desc",
    );
    const page = await queryDimensionPageFromD1(
      env,
      SITE,
      WINDOW,
      filters,
      request.limit,
      selection,
      {
        excludeEmpty: overview?.excludeEmpty ?? false,
        search: "",
        sortBy: "views",
        sortDirection: "desc",
      },
      cursor,
      undefined,
      "private-dashboard",
    );
    dto =
      request.family === "dimension-breakdown"
        ? {
            items: mapDimensionRows([...page.items]),
            pagination: page.pagination,
          }
        : {
            data: {
              items: page.items.map(({ value, ...metrics }) => ({
                label: value,
                ...metrics,
              })),
              pagination: page.pagination,
            },
          };
    if (
      deferred.countInput.scope !== "event" ||
      deferred.countInput.candidateAnchor.kind !== "event-candidate"
    )
      throw new Error("wave97eo_page_dimension_candidate_count_missing");
    const plan = buildPageDimensionQualificationPlan({
      semanticOperation: "dimension",
      siteId: SITE,
      queryTime: deferred.requestTime ?? (request.query.time as QueryTime),
      filters: deferred.filters,
      scopePlan: deferred.metadata.plan,
      count: deferred.countInput,
      eventCandidateReportProjection: "page-visits",
      options: {
        selection,
        limit: request.limit,
        cursor: null,
        search: "",
        sortBy: "views",
        sortDirection: "desc",
        excludeEmpty: overview?.excludeEmpty ?? false,
      },
    });
    graph = graphEvidence(plan);
  } else if (request.family === "pages-aggregate") {
    const cursor = await decodePagesCursor(
      env,
      SITE,
      WINDOW,
      filters,
      false,
      requestPageCursor(request),
      "private-dashboard",
    );
    const page = await queryPagesPageFromD1(
      env,
      SITE,
      WINDOW,
      filters,
      request.limit,
      false,
      cursor,
      "private-dashboard",
    );
    dto = page;
    if (
      deferred.countInput.scope !== "event" ||
      deferred.countInput.candidateAnchor.kind !== "event-candidate"
    )
      throw new Error("wave97eo_pages_candidate_count_missing");
    graph = graphEvidence(
      buildPagesAggregateQualificationPlan({
        siteId: SITE,
        queryTime: deferred.requestTime ?? (request.query.time as QueryTime),
        filters: deferred.filters,
        scopePlan: deferred.metadata.plan,
        count: deferred.countInput,
        eventCandidateReportProjection: "page-visits",
        limit: request.limit,
        includeDetails: false,
        cursor: null,
      }),
    );
  } else {
    const field = String(request.query.field);
    const pageRequest = request.query.page as {
      readonly limit: number;
      readonly cursor?: string | null;
    };
    const page = await queryFilterValuesPageFromD1(
      env,
      SITE,
      WINDOW,
      filters,
      field,
      request.limit,
      pageRequest.cursor,
      undefined,
      "private-dashboard",
    );
    dto = {
      field,
      data: {
        items: page.items.map((row) => ({
          value: row.value,
          label: row.value,
          occurrences: row.occurrences,
        })),
        pagination: page.pagination,
      },
    };
    if (
      deferred.countInput.scope !== "event" ||
      deferred.countInput.candidateAnchor.kind !== "event-candidate"
    )
      throw new Error("wave97eo_filter_values_candidate_count_missing");
    const selection = dimensionPageSelection(field);
    if (!selection) throw new Error("wave97eo_filter_values_selection_missing");
    graph = graphEvidence(
      buildPageDimensionQualificationPlan({
        semanticOperation: "filter-values",
        siteId: SITE,
        queryTime: deferred.requestTime ?? (request.query.time as QueryTime),
        filters: deferred.filters,
        scopePlan: deferred.metadata.plan,
        count: deferred.countInput,
        eventCandidateReportProjection: "page-visits",
        options: {
          selection,
          limit: request.limit,
          cursor: null,
          search: undefined,
          sortBy: "views",
          sortDirection: "desc",
          excludeEmpty: true,
        },
      }),
    );
  }
  return { dto, trace, statements, graph, deferred };
}

function graphEvidence(plan: {
  readonly primaryReportSourceRelationId: RelationId;
  readonly reportSourceRelations: readonly unknown[];
  readonly groupedSummaryRelationId?: RelationId;
  readonly additionalGroupedSummaryRelationIds?: readonly RelationId[];
  readonly eventCandidateReportProjection?: string;
  readonly candidateGrain?: string;
  readonly scope: string;
}): Record<string, unknown> {
  return {
    primaryReportSourceRelationId: plan.primaryReportSourceRelationId,
    reportSourceRelations: plan.reportSourceRelations,
    groupedSummaryRelationIds: [
      ...(plan.groupedSummaryRelationId ? [plan.groupedSummaryRelationId] : []),
      ...(plan.additionalGroupedSummaryRelationIds ?? []),
    ],
    scope: plan.scope,
    candidateGrain: plan.candidateGrain,
    eventCandidateReportProjection: plan.eventCandidateReportProjection,
  };
}

function admissionPolicyForPagePlan(
  plan: PageDimensionQualificationPlan<"event">,
): AnalyticsQualificationAdmissionPolicy {
  const report = plan.plan.outputs.find(
    (output) => output.id === DIMENSION_PAGE_REPORT_OUTPUT,
  );
  const controls = plan.plan.outputs.find(
    (output) => output.id === PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT,
  );
  if (!report || !controls)
    throw new Error("wave97eo_page_plan_outputs_missing");
  return {
    primaryReportSourceRelationId: plan.primaryReportSourceRelationId,
    reportSourceRelations: plan.reportSourceRelations,
    reportRelationIds: [report.relation],
    controlsRelationId: plan.controlsRelationId,
    controlSlots: controls.fields.map(({ name, slot }) => ({
      name,
      slot,
    })),
    scope: plan.scope,
    ...(plan.candidateGrain ? { candidateGrain: plan.candidateGrain } : {}),
    ...(plan.eventCandidateReportProjection
      ? {
          eventCandidateReportProjection: plan.eventCandidateReportProjection,
        }
      : {}),
    maximumActivities: ADVANCED_FILTER_MAX_ACTIVITIES,
    numericCompatibilityControlNames: [],
  };
}

function lowerPagePlanWithAdmission(
  plan: PageDimensionQualificationPlan<"event">,
  policy: AnalyticsQualificationAdmissionPolicy,
): void {
  const report = plan.plan.outputs.find(
    (output) => output.id === DIMENSION_PAGE_REPORT_OUTPUT,
  );
  const controls = plan.plan.outputs.find(
    (output) => output.id === PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT,
  );
  if (!report || !controls)
    throw new Error("wave97eo_page_plan_outputs_missing");
  const lowerer = new AnalyticsLogicalToDbLowerer(
    plan.plan,
    { siteId: SITE, time: plan.plan.context.time },
    { analyticsQualificationAdmissionPolicy: policy },
  );
  lowerer.lowerMany([report, controls]);
}

async function actualPage(
  database: DatabaseSync,
  request: CandidateRequest,
): Promise<{
  readonly dto: unknown;
  readonly trace: SqliteD1Trace;
  readonly statements: CapturedSql[];
  readonly diagnostics: ReturnType<typeof createD1ReadDiagnostics>;
}> {
  const trace = traceFor();
  const statements: CapturedSql[] = [];
  const diagnostics = createD1ReadDiagnostics();
  const provider = createD1SiteProviderRegistry({
    env: testEnv(database, trace, statements),
    siteId: SITE,
    diagnostics,
  }).resolve(request.operation);
  if (!provider)
    throw new Error(`wave97eo_${request.operation}_provider_missing`);
  const result = await provider.execute(request.query as never);
  return { dto: result.value, trace, statements, diagnostics };
}

function valueKeys(family: ReportFamily, dto: unknown): string[] {
  const value = dto as Record<string, unknown>;
  if (family === "page-filter-values") {
    const data = value.data as {
      readonly items: readonly { readonly value: string }[];
    };
    return data.items.map((row) => row.value);
  }
  const items = (
    family === "dimension-overview-tab"
      ? (value.data as Record<string, unknown>).items
      : value.items
  ) as readonly Record<string, unknown>[];
  return items.map((row) =>
    String(row.key ?? row.value ?? row.pathname ?? row.label ?? ""),
  );
}

function paginationOf(family: ReportFamily, dto: unknown) {
  const value = dto as Record<string, unknown>;
  if (family === "page-filter-values" || family === "dimension-overview-tab")
    return (value.data as { readonly pagination: Record<string, unknown> })
      .pagination;
  return value.pagination as Record<string, unknown>;
}

function sqlEvidence(trace: SqliteD1Trace) {
  return trace.preparedSql.map((sql, index) => ({
    sql,
    bindings: trace.bindings[index] ?? [],
    utf8Bytes: Buffer.byteLength(sql, "utf8"),
  }));
}

function executionEvidence(
  trace: SqliteD1Trace,
  statements: readonly CapturedSql[],
) {
  const envelopes = statements.filter(
    ({ sql, rows }) =>
      sql.includes("rowKind") &&
      sql.includes("outputId") &&
      rows.some((row) => row.rowKind === "control" || row.rowKind === "report"),
  );
  const firstEnvelope = envelopes[0];
  const reportsByOutputId = new Map<string, Record<string, unknown>[]>();
  const controls =
    firstEnvelope?.rows.filter((row) => row.rowKind === "control") ?? [];
  for (const row of firstEnvelope?.rows ?? []) {
    if (row.rowKind !== "report" || typeof row.outputId !== "string") continue;
    const rows = reportsByOutputId.get(row.outputId) ?? [];
    rows.push(row);
    reportsByOutputId.set(row.outputId, rows);
  }
  return {
    statements: sqlEvidence(trace),
    actualRows: statements,
    envelopeCount: envelopes.length,
    controls,
    reportsByOutputId: Object.fromEntries(reportsByOutputId),
  };
}

const consumerCases: readonly {
  readonly title: string;
  readonly family: ReportFamily;
  readonly filterKind: FilterKind;
}[] = [
  {
    title: "dimension breakdown — AND bare Event",
    family: "dimension-breakdown",
    filterKind: "and",
  },
  {
    title: "dimension breakdown — OR/NOT bare Page",
    family: "dimension-breakdown",
    filterKind: "orNot",
  },
  {
    title: "dimension overview-tab — AND bare Event",
    family: "dimension-overview-tab",
    filterKind: "and",
  },
  {
    title: "dimension overview-tab — OR/NOT bare Page",
    family: "dimension-overview-tab",
    filterKind: "orNot",
  },
  {
    title: "ordinary Pages aggregate — AND bare Event",
    family: "pages-aggregate",
    filterKind: "and",
  },
  {
    title: "ordinary Pages aggregate — OR/NOT bare Page",
    family: "pages-aggregate",
    filterKind: "orNot",
  },
  {
    title: "Page FilterValues — AND bare Event",
    family: "page-filter-values",
    filterKind: "and",
  },
  {
    title: "Page FilterValues — OR/NOT bare Page",
    family: "page-filter-values",
    filterKind: "orNot",
  },
];

afterAll(async () => {
  for (const database of DATABASES) database.close();
  const artifactDirectory = process.env.WAVE97EO_ARTIFACT_DIR;
  if (!artifactDirectory) return;
  const [{ mkdir, writeFile }, path] = await Promise.all([
    import("node:fs/promises"),
    import("node:path"),
  ]);
  const outputDirectory = path.resolve(artifactDirectory);
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    path.join(outputDirectory, "event-candidate-page-report-regression.json"),
    JSON.stringify(runtimeEvidence, null, 2),
    { encoding: "utf8", flag: "wx" },
  );
});

describe("Event candidate Page report projections", () => {
  it("keeps synthetic Core activity identity separate from truthy visit membership", () => {
    const nullVisit = {
      kind: "event" as const,
      id: "null-event",
      time: 125,
      fields: {},
    };
    Object.defineProperty(nullVisit, "visitId", { value: null });
    const result = evaluateFilterDocument(
      parseFilterDsl(
        "count(event) eq 0 OR count(event) gt 0",
        analyticsFilterRegistry,
      ),
      {
        pages: [
          {
            kind: "page",
            id: "shared-entity",
            visitId: "page-visit",
            time: 125,
            fields: {},
          },
          { kind: "page", id: "missing-page", time: 125, fields: {} },
          {
            kind: "page",
            id: "empty-page",
            visitId: "",
            time: 125,
            fields: {},
          },
        ],
        events: [
          {
            kind: "event",
            id: "shared-entity",
            visitId: "event-visit",
            time: 125,
            fields: {},
          },
          { kind: "event", id: "missing-event", time: 125, fields: {} },
          {
            kind: "event",
            id: "empty-event",
            visitId: "",
            time: 125,
            fields: {},
          },
          {
            kind: "event",
            id: "space-event",
            visitId: " ",
            time: 125,
            fields: {},
          },
          nullVisit,
        ],
        coverageRange: TIME.range,
      },
      {
        scope: "event",
        candidateRange: TIME.range,
        reportingTimeZone: "UTC",
        capturedAtMs: 500,
      },
    );
    expect(result.matchingVisitIds).toEqual(
      new Set(["page-visit", "event-visit", " "]),
    );
    runtimeEvidence.push({
      title: "Synthetic Core visit identity/truthiness",
      matchingVisitIds: [...result.matchingVisitIds],
    });
  });
  it.each(consumerCases)("$title", async ({ family, filterKind, title }) => {
    const { database } = createFixture();
    const limit =
      filterKind === "orNot" &&
      (family === "pages-aggregate" || family === "page-filter-values")
        ? 1
        : 10;
    const request = candidateQuery(family, BOOLEAN_FILTERS[filterKind], limit);
    const legacy = await coreOracle(database, request);
    const actual = await actualPage(database, request);
    const expectedPaths =
      filterKind === "and" ? ["/event-only"] : ["/event-only", "/page-only"];

    if (legacy.deferred.countInput.scope !== "event")
      throw new Error("wave97eo_candidate_scope_missing");
    expect(legacy.deferred.countInput.candidateAnchor.kind).toBe(
      "event-candidate",
    );
    expect(
      "eventCandidateReportProjection" in legacy.deferred
        ? legacy.deferred.eventCandidateReportProjection
        : undefined,
    ).toBe("page-visits");
    expect(
      normalizeFilterDocument(
        legacy.deferred.countInput.analysis.document,
        analyticsFilterRegistry,
      ),
    ).toEqual(
      normalizeFilterDocument(legacy.deferred.filters, analyticsFilterRegistry),
    );
    expect(legacy.graph).toMatchObject({
      scope: "event",
      candidateGrain: "event-candidate",
      eventCandidateReportProjection: "page-visits",
      reportSourceRelations: [
        {
          relationId: legacy.graph.primaryReportSourceRelationId,
          entity: "page",
        },
      ],
      groupedSummaryRelationIds: expect.arrayContaining([
        expect.any(Number),
        expect.any(Number),
      ]),
    });
    expect(legacy.graph.groupedSummaryRelationIds).toHaveLength(2);
    expect(actual.dto).toEqual(legacy.dto);
    expect(valueKeys(family, actual.dto).sort()).toEqual(
      expectedPaths.slice(0, limit),
    );
    expect(
      executionEvidence(actual.trace, actual.statements).envelopeCount,
    ).toBe(1);
    expect(actual.trace.preparedSql.length).toBeLessThanOrEqual(2);
    expect(
      Math.max(
        ...actual.trace.preparedSql.map((sql) =>
          Buffer.byteLength(sql, "utf8"),
        ),
      ),
    ).toBeLessThanOrEqual(100_000);
    expect(
      Math.max(...actual.trace.bindings.map((bindings) => bindings.length)),
    ).toBeLessThanOrEqual(100);
    expect(actual.diagnostics.advancedCountSqlFallbackReason).toBeUndefined();

    if (filterKind === "orNot" && limit === 1) {
      const first = paginationOf(family, actual.dto);
      expect(first.hasMore).toBe(true);
      expect(first.nextCursor).toEqual(expect.any(String));
      const cursor = first.nextCursor as string;
      const nextRequest = candidateQuery(
        family,
        BOOLEAN_FILTERS[filterKind],
        limit,
        cursor,
      );
      const nextLegacy = await coreOracle(database, nextRequest);
      const nextActual = await actualPage(database, nextRequest);
      expect(nextActual.dto).toEqual(nextLegacy.dto);
      expect(valueKeys(family, nextActual.dto)).toHaveLength(1);
      expect(
        [
          ...valueKeys(family, actual.dto),
          ...valueKeys(family, nextActual.dto),
        ].sort(),
      ).toEqual(expectedPaths);
      expect(paginationOf(family, nextActual.dto)).toMatchObject({
        hasMore: false,
        nextCursor: null,
      });
      runtimeEvidence.push({
        title: `${title} first/next signed cursor chain`,
        first: actual.dto,
        firstLegacy: legacy.dto,
        next: nextActual.dto,
        nextLegacy: nextLegacy.dto,
        firstExecution: executionEvidence(actual.trace, actual.statements),
        nextExecution: executionEvidence(
          nextActual.trace,
          nextActual.statements,
        ),
        corePrepareAndReport: [
          sqlEvidence(legacy.trace),
          sqlEvidence(nextLegacy.trace),
        ],
        projectionGraph: legacy.graph,
      });
    } else {
      runtimeEvidence.push({
        title,
        family,
        filterKind,
        filterDsl: BOOLEAN_FILTERS[filterKind],
        expectedPagePaths: expectedPaths,
        actualDto: actual.dto,
        coreDto: legacy.dto,
        actualExecution: executionEvidence(actual.trace, actual.statements),
        corePrepareAndReport: sqlEvidence(legacy.trace),
        projectionGraph: legacy.graph,
      });
    }
  });

  it.each([
    ["ordinary Pages aggregate", "pages-aggregate"],
    ["Page FilterValues", "page-filter-values"],
  ] as const)(
    "runs the full Core operation after %s numeric-domain rejection",
    async (_label, family) => {
      const { database } = createFixture();
      database
        .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
        .run("invalid-duration", "visit-neither");
      const request = candidateQuery(
        family,
        NUMERIC_FALLBACK_FILTER,
        family === "page-filter-values" ? 10 : 10,
      );
      const expected = await coreOracle(database, request);
      const actual = await actualPage(database, request);
      expect(actual.dto).toEqual(expected.dto);
      expect(valueKeys(family, actual.dto)).toEqual(["/event-only"]);
      expect(actual.diagnostics.advancedCountSqlFallbackReason).toMatchObject({
        kind: "numeric-data-domain",
        fieldIds: ["page.durationMs"],
      });
      const attemptedEnvelopes = executionEvidence(
        actual.trace,
        actual.statements,
      );
      expect(attemptedEnvelopes.envelopeCount).toBe(1);
      expect(Object.values(attemptedEnvelopes.reportsByOutputId)).toHaveLength(
        0,
      );
      expect(actual.trace.preparedSql.length).toBeGreaterThan(2);
      runtimeEvidence.push({
        title: `${family} numeric-data-domain complete-operation fallback`,
        filterDsl: NUMERIC_FALLBACK_FILTER,
        actualDto: actual.dto,
        coreDto: expected.dto,
        fallbackReason: actual.diagnostics.advancedCountSqlFallbackReason,
        attemptedEnvelope: attemptedEnvelopes,
        actualPrepareAndFallback: sqlEvidence(actual.trace),
        corePrepareAndReport: sqlEvidence(expected.trace),
        projectionGraph: expected.graph,
      });
    },
  );

  it("rejects invalid Page projection roles against the current source graph", async () => {
    const { database } = createFixture();
    const request = candidateQuery(
      "dimension-breakdown",
      BOOLEAN_FILTERS.orNot,
    );
    const trace = traceFor();
    const env = testEnv(database, trace);
    const { deferred } = await deferredFor(env, request);
    if (
      deferred.countInput.scope !== "event" ||
      deferred.countInput.candidateAnchor.kind !== "event-candidate"
    )
      throw new Error("wave97eo_admission_candidate_count_missing");
    const selection = dimensionPageSelection("page.path");
    if (!selection) throw new Error("wave97eo_admission_selection_missing");
    const plan = buildPageDimensionQualificationPlan({
      semanticOperation: "dimension",
      siteId: SITE,
      queryTime: deferred.requestTime ?? TIME,
      filters: deferred.filters,
      scopePlan: deferred.metadata.plan,
      count: deferred.countInput,
      eventCandidateReportProjection: "page-visits",
      options: {
        selection,
        limit: 10,
        cursor: null,
        sortBy: "views",
        sortDirection: "desc",
        excludeEmpty: false,
      },
    });
    const policy = admissionPolicyForPagePlan(plan);
    expect(() => lowerPagePlanWithAdmission(plan, policy)).not.toThrow();

    const { eventCandidateReportProjection: role, ...missingRole } = policy;
    expect(role).toBe("page-visits");
    expect(() =>
      lowerPagePlanWithAdmission(
        plan,
        missingRole as AnalyticsQualificationAdmissionPolicy,
      ),
    ).toThrow();

    const {
      candidateGrain: _candidateGrain,
      eventCandidateReportProjection,
      ...ownerPolicyBase
    } = policy;
    void _candidateGrain;
    expect(eventCandidateReportProjection).toBe("page-visits");
    const ownerWithPageRole = {
      ...ownerPolicyBase,
      scope: "session" as const,
      eventCandidateReportProjection: "page-visits" as const,
    };
    expect(() => lowerPagePlanWithAdmission(plan, ownerWithPageRole)).toThrow();

    const eventPlan = buildEventTypeSummaryQualificationPlan({
      siteId: SITE,
      count: deferred.countInput,
      query: { kind: "page", limit: 10 },
    });
    const eventReports = eventPlan.plan.outputs.filter((output) =>
      eventPlan.reportOutputIds.includes(output.id),
    );
    const eventControls = eventPlan.plan.outputs.find(
      (output) => output.id === eventPlan.controlOutputId,
    );
    if (!eventControls || eventReports.length !== 1)
      throw new Error("wave97eo_admission_event_outputs_missing");
    const eventPolicy: AnalyticsQualificationAdmissionPolicy = {
      primaryReportSourceRelationId: eventPlan.primaryReportSourceRelationId,
      reportSourceRelations: eventPlan.reportSourceRelations,
      reportRelationIds: eventReports.map((output) => output.relation),
      controlsRelationId: eventPlan.controlsRelationId,
      controlSlots: eventControls.fields.map(({ name, slot }) => ({
        name,
        slot,
      })),
      scope: "event",
      candidateGrain: "event-candidate",
      maximumActivities: ADVANCED_FILTER_MAX_ACTIVITIES,
      numericCompatibilityControlNames: [],
    };
    const lowerEvent = (policy: AnalyticsQualificationAdmissionPolicy) =>
      new AnalyticsLogicalToDbLowerer(
        eventPlan.plan,
        { siteId: SITE, time: eventPlan.plan.context.time },
        { analyticsQualificationAdmissionPolicy: policy },
      ).lowerMany([...eventReports, eventControls]);
    expect(() => lowerEvent(eventPolicy)).not.toThrow();
    expect(() =>
      lowerEvent({
        ...eventPolicy,
        eventCandidateReportProjection: "page-visits",
      }),
    ).toThrow();

    expect(() =>
      lowerPagePlanWithAdmission(plan, {
        ...policy,
        reportSourceRelations: [
          ...policy.reportSourceRelations,
          policy.reportSourceRelations[0]!,
        ],
      }),
    ).toThrow();
    runtimeEvidence.push({
      title: "Page projection current-graph admission rejection",
      accepted: graphEvidence(plan),
      rejectedPolicies: [
        "missing-page-visits-role",
        "owner-with-page-role",
        "event-primary-with-page-role",
        "duplicate-report-source",
      ],
    });
  });

  it("preserves whitespace visit IDs and excludes empty or orphan Event membership", async () => {
    const { database, site } = createFixture();
    addVisit(database, site, {
      id: " ",
      visitorId: "visitor-whitespace-id",
      sessionId: "session-whitespace-id",
      path: "/whitespace-id",
      at: 129,
    });
    addEvent(database, site, { id: "visit-neither", visitId: "" });
    addEvent(database, site, {
      id: "event-whitespace-id",
      visitId: " ",
    });
    addEvent(database, site, {
      id: "event-orphan-visit",
      visitId: "orphan-visit",
    });

    const request = candidateQuery(
      "dimension-breakdown",
      BOOLEAN_FILTERS.orNot,
      10,
    );
    const legacy = await coreOracle(database, request);
    const actual = await actualPage(database, request);
    expect(actual.dto).toEqual(legacy.dto);
    expect(valueKeys("dimension-breakdown", actual.dto).sort()).toEqual([
      "/event-only",
      "/page-only",
      "/whitespace-id",
    ]);
    expect(valueKeys("dimension-breakdown", actual.dto)).not.toContain(
      "/empty-id",
    );
    expect(valueKeys("dimension-breakdown", actual.dto)).not.toContain(
      "/collision",
    );
    expect(valueKeys("dimension-breakdown", actual.dto)).not.toContain(
      "/neither",
    );
    runtimeEvidence.push({
      title: "empty, whitespace and orphan visit-ID D1 membership",
      actualDto: actual.dto,
      coreDto: legacy.dto,
      expectedPagePaths: ["/event-only", "/page-only", "/whitespace-id"],
      actualExecution: executionEvidence(actual.trace, actual.statements),
      corePrepareAndReport: sqlEvidence(legacy.trace),
      projectionGraph: legacy.graph,
    });
  });

  it("rejects unsafe raw properties and refuses mismatched Page projections before SQL", async () => {
    const { database } = createFixture();
    const request = candidateQuery(
      "dimension-breakdown",
      BOOLEAN_FILTERS.orNot,
    );
    const getterTrace = traceFor();
    const getterEnv = testEnv(database, getterTrace);
    let getterReads = 0;
    const getterQuery = Object.defineProperty({ ...request.query }, "filters", {
      enumerable: true,
      get() {
        getterReads += 1;
        return request.query.filters;
      },
    }) as CandidateQuery;
    await expect(
      d1AdvancedFilterMiddleware(getterEnv, undefined, SITE)(
        "dimension",
        getterQuery,
        async (prepared) => prepared,
      ),
    ).rejects.toThrow();
    expect(getterReads).toBe(0);
    expect(getterTrace.preparedSql).toHaveLength(0);

    const mismatches: Array<{
      readonly label: string;
      readonly query: CandidateQuery;
      readonly expectedSiteId?: string;
    }> = [
      {
        label: "site",
        query: request.query,
        expectedSiteId: `${SITE}-other`,
      },
      {
        label: "time",
        query: {
          ...request.query,
          time: {
            ...TIME,
            range: { ...TIME.range, startMs: 121 },
          },
        },
      },
      {
        label: "scope",
        query: {
          ...request.query,
          scopePlan: {
            ...request.query.scopePlan!,
            scope: "session",
          },
        },
      },
    ];
    for (const mismatch of mismatches) {
      const trace = traceFor();
      const env = testEnv(database, trace);
      await expect(
        d1AdvancedFilterMiddleware(env, undefined, mismatch.expectedSiteId)(
          "dimension",
          mismatch.query,
          async (prepared) => prepared,
        ),
      ).rejects.toThrow();
      expect(trace.preparedSql).toHaveLength(0);
      runtimeEvidence.push({
        title: `pre-SQL Page request ${mismatch.label} mismatch`,
        invalidRequestRejectedBeforeSql: true,
      });
    }
  });
});
