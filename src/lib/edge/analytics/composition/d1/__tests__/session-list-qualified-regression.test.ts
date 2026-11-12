import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

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
  EMPTY_FILTER_DOCUMENT,
  prepareScopedQuery,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import type { AdvancedCountFilterMatchPlanInput } from "@/lib/edge/analytics/engine/advanced-count-filter-plan";
import { JOURNEY_SESSION_LIST_REPORT_OUTPUT } from "@/lib/edge/analytics/engine/journey-entity-list-report-plan";
import { buildJourneySessionListQualificationPlan } from "@/lib/edge/analytics/engine/journey-session-list-qualification-plan";
import { PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT } from "@/lib/edge/analytics/engine/page-dimension-qualification-plan";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import {
  d1AdvancedFilterMiddleware,
  prepareDeferredEventQualificationFallback,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { queryD1CompiledAll } from "@/lib/edge/analytics/providers/d1/internal/core";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import { mapSessionRow } from "@/lib/edge/analytics/providers/d1/internal/journey-helpers";
import { compileQualificationProgramEnvelope } from "@/lib/edge/analytics/providers/d1/internal/qualification-program-envelope";
import {
  deferredSessionListQualificationFromQuery,
  sessionListQualificationConfigurationFromQuery,
} from "@/lib/edge/analytics/providers/d1/internal/session-list-qualification-request";
import {
  readSiteSessions,
  type SessionSort,
} from "@/lib/edge/analytics/providers/d1/operations/site-journeys";
import type { Env } from "@/lib/edge/types";
import { parseFilterDsl } from "@/lib/filter-contract";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";
import { analyzeFilterDocument } from "@/lib/filter-contract/filter-semantics";

const SITE_ID = "wave97q-session-list";
const BASE = Date.UTC(2026, 9, 1);
const END = BASE + 24 * 60 * 60 * 1000;
const SEARCH = "baseline.test";
const FILTER_DSL =
  'page.path eq "/match" and count(page { page.path eq "/match" }) gte 1';
const EVIDENCE_DIRECTORY = process.env.INSIGHTFLARE_QUERY_EVIDENCE_DIR?.trim();

type Scope = "session" | "visitor";
type SortKey = "startedAt" | "durationMs" | "views";

function writeEvidence(value: unknown): void {
  if (!EVIDENCE_DIRECTORY) return;
  mkdirSync(EVIDENCE_DIRECTORY, { recursive: true });
  const baselineCapture =
    process.env.INSIGHTFLARE_SESSION_LIST_CAPTURE_BEFORE === "1";
  writeFileSync(
    join(
      EVIDENCE_DIRECTORY,
      baselineCapture
        ? "provider-before.json"
        : "legacy-control-after-source-refactor.json",
    ),
    `${JSON.stringify(
      {
        ...(value as Record<string, unknown>),
        state: baselineCapture
          ? "actual-pre-rewire-runtime-capture"
          : "legacy-direct-provider-control-reference-after-source-refactor",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function writeNamedEvidence(filename: string, value: unknown): void {
  if (!EVIDENCE_DIRECTORY) return;
  mkdirSync(EVIDENCE_DIRECTORY, { recursive: true });
  writeFileSync(
    join(EVIDENCE_DIRECTORY, filename),
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
}

function preparedQualificationInput(scope: Scope) {
  const filters = parseFilterDsl(FILTER_DSL, analyticsFilterRegistry);
  const prepared = prepareScopedQuery("sessions", {
    context: siteQueryContext(SITE_ID, "private-dashboard"),
    time: createQueryTime(BASE, END, "UTC", END),
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

function sessionCursor(
  row: ReturnType<typeof mapSessionRow>,
  sort: { readonly key: SortKey; readonly direction: "asc" | "desc" },
) {
  const sortValue =
    sort.key === "startedAt"
      ? row.startedAt
      : sort.key === "durationMs"
        ? row.durationMs
        : row.views;
  return sort.key === "startedAt"
    ? { sortValue, sessionId: row.sessionId }
    : { sortValue, startedAt: row.startedAt, sessionId: row.sessionId };
}

function compileSessionEnvelope(input: {
  readonly plan: ReturnType<typeof buildJourneySessionListQualificationPlan>;
  readonly sort: { readonly key: SortKey; readonly direction: "asc" | "desc" };
}) {
  const report = input.plan.plan.outputs.find(
    ({ id }) => id === JOURNEY_SESSION_LIST_REPORT_OUTPUT,
  );
  const controls = input.plan.plan.outputs.find(
    ({ id }) => id === PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT,
  );
  if (!report || !controls) throw new Error("session_list_outputs_missing");
  const reportFields = report.fields.map(({ name }) => name);
  const primaryField =
    input.sort.key === "durationMs" ? "totalDurationMs" : input.sort.key;
  const ordering = [
    {
      outputId: JOURNEY_SESSION_LIST_REPORT_OUTPUT,
      field: primaryField,
      direction: input.sort.direction,
      nulls:
        input.sort.direction === "asc" ? ("first" as const) : ("last" as const),
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
    siteId: SITE_ID,
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

function seedSite(database: DatabaseSync): number {
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
       VALUES (?, 'wave97q-team', 'Session list baseline', 'baseline.test', 0)`,
    )
    .run(SITE_ID);
  return Number(site.site_pk);
}

function seedVisit(
  database: DatabaseSync,
  sitePk: number,
  input: {
    readonly visitId: string;
    readonly visitorId: string;
    readonly sessionId: string;
    readonly startedAt: number;
    readonly durationMs: number;
    readonly pathname: string;
  },
): void {
  database
    .prepare(
      `INSERT INTO visits (
        visit_id, site_id, site_pk, visitor_id, session_id, status,
        started_at, last_activity_at, pathname, hostname
      ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, 'baseline.test')`,
    )
    .run(
      input.visitId,
      SITE_ID,
      sitePk,
      input.visitorId,
      input.sessionId,
      input.startedAt,
      input.startedAt + input.durationMs,
      input.pathname,
    );
}

function seedFixture(database: DatabaseSync): void {
  const sitePk = seedSite(database);
  const visits = [
    {
      visitId: "a-match-1",
      visitorId: "visitor-a",
      sessionId: "session-a-match",
      startedAt: BASE + 1_000,
      durationMs: 400,
      pathname: "/match",
    },
    {
      visitId: "a-extra-1",
      visitorId: "visitor-a",
      sessionId: "session-a-extra",
      startedAt: BASE + 2_000,
      durationMs: 600,
      pathname: "/extra",
    },
    {
      visitId: "a-extra-2",
      visitorId: "visitor-a",
      sessionId: "session-a-extra",
      startedAt: BASE + 2_500,
      durationMs: 800,
      pathname: "/extra-2",
    },
    {
      visitId: "b-match-1",
      visitorId: "visitor-b",
      sessionId: "session-b-match",
      startedAt: BASE + 3_000,
      durationMs: 200,
      pathname: "/match",
    },
    {
      visitId: "b-extra-1",
      visitorId: "visitor-b",
      sessionId: "session-b-extra",
      startedAt: BASE + 4_000,
      durationMs: 1_000,
      pathname: "/extra",
    },
    {
      visitId: "c-other-1",
      visitorId: "visitor-c",
      sessionId: "session-c-other",
      startedAt: BASE + 5_000,
      durationMs: 300,
      pathname: "/other",
    },
    {
      visitId: "c-match-1",
      visitorId: "visitor-c",
      sessionId: "session-c-match",
      startedAt: BASE + 6_000,
      durationMs: 500,
      pathname: "/match",
    },
  ] as const;
  for (const visit of visits) seedVisit(database, sitePk, visit);
}

function d1WithEnvelopeRowTransform(
  database: DatabaseSync,
  trace: SqliteD1Trace,
  transform: (row: Record<string, unknown>) => Record<string, unknown>,
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
          if (!sql.includes('"rowKind"') || !sql.includes('"outputId"'))
            return result;
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

function seedEventOnlyOwnerOutsideWindow(database: DatabaseSync): void {
  const sitePk = database
    .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
    .get(SITE_ID) as { readonly site_pk: number };
  database
    .prepare(
      `INSERT INTO custom_event_names (site_id, name, last_seen_at, site_pk)
       VALUES (?, 'signup', ?, ?)
       ON CONFLICT(site_pk, name) DO NOTHING`,
    )
    .run(SITE_ID, BASE + 1_000, sitePk.site_pk);
  const eventName = database
    .prepare(
      "SELECT id FROM custom_event_names WHERE site_pk = ? AND name = 'signup'",
    )
    .get(sitePk.site_pk) as { readonly id: number };
  database
    .prepare(
      `INSERT INTO visits (
        visit_id, site_id, site_pk, visitor_id, session_id, status,
        started_at, last_activity_at, pathname, hostname
      ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, 'baseline.test')`,
    )
    .run(
      "event-owner-outside-window",
      SITE_ID,
      sitePk.site_pk,
      "visitor-event-only",
      "session-event-only",
      BASE - 24 * 60 * 60 * 1000,
      BASE - 24 * 60 * 60 * 1000 + 250,
      "/outside-window",
    );
  database
    .prepare(
      `INSERT INTO custom_events (
        event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
        received_at, node_count, value_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)`,
    )
    .run(
      "event-only-signup",
      SITE_ID,
      sitePk.site_pk,
      "event-owner-outside-window",
      eventName.id,
      BASE + 1_000,
      BASE + 1_000,
    );
}

function queryInput(input: {
  readonly scope?: Scope;
  readonly sortKey: SortKey;
  readonly direction: "asc" | "desc";
  readonly advanced: boolean;
  readonly cursor?: string | null;
  readonly search?: string;
  readonly limit?: number;
  readonly filterDsl?: string;
}): CanonicalQuery<"sessions"> {
  return {
    context: siteQueryContext(SITE_ID, "private-dashboard"),
    time: createQueryTime(BASE, END, "UTC", END),
    filters: input.advanced
      ? parseFilterDsl(input.filterDsl ?? FILTER_DSL, analyticsFilterRegistry)
      : EMPTY_FILTER_DOCUMENT,
    ...(input.scope ? { scopePreference: input.scope } : {}),
    page: { limit: input.limit ?? 1, cursor: input.cursor ?? null },
    search: input.search ?? SEARCH,
    sort: { key: input.sortKey, direction: input.direction },
  } as CanonicalQuery<"sessions">;
}

async function legacySessionPage(
  env: Env,
  request: CanonicalQuery<"sessions">,
) {
  const middlewareQuery = await sessionMiddlewareQuery(env, request);
  const deferred = deferredSessionListQualificationFromQuery(middlewareQuery);
  if (!deferred)
    throw new Error("legacy_control_session_qualification_missing");
  const filters = await prepareDeferredEventQualificationFallback(
    deferred.qualification,
  );
  const sort: SessionSort = {
    field: (request.sort?.key as SortKey | undefined) ?? "startedAt",
    direction: request.sort?.direction === "asc" ? "asc" : "desc",
  };
  return readSiteSessions({
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
  });
}

async function sessionMiddlewareQuery(
  env: Env,
  request: CanonicalQuery<"sessions">,
): Promise<QueryInput & Record<string, unknown>> {
  const prepared = prepareScopedQuery(
    "sessions",
    request,
  ) as unknown as QueryInput & Record<string, unknown>;
  let middlewareQuery: unknown;
  await d1AdvancedFilterMiddleware(env, undefined, SITE_ID)(
    "sessions",
    prepared,
    async (nextQuery) => {
      middlewareQuery = nextQuery;
      return nextQuery;
    },
  );
  if (!middlewareQuery || typeof middlewareQuery !== "object")
    throw new Error("session_middleware_query_missing");
  return middlewareQuery as QueryInput & Record<string, unknown>;
}

// The actual pre-rewire capture is archived in plan/.../run-1/provider-before.json.
// Keep its one-time harness inert after production route wiring to avoid relabeling data.
describe.skip("Sessions provider pre-rewire runtime reference", () => {
  it("captures actual legacy DTO, SQL, binds, and cursors before source changes", async () => {
    const database = createMigratedDatabase();
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const db = createSqliteD1Database(database, trace);
    const env = {
      DB: db,
      MAIN_SECRET: "wave97q-session-list-baseline-secret",
    } as unknown as Env;
    try {
      seedFixture(database);
      const runtime = createD1SiteQueryRuntime({ env, siteId: SITE_ID });
      const scenarios: Array<Record<string, unknown>> = [];
      const scopes: readonly Scope[] = ["session", "visitor"];
      const sortKeys: readonly SortKey[] = ["startedAt", "durationMs", "views"];
      const directions = ["desc"] as const;

      for (const scope of scopes) {
        for (const sortKey of sortKeys) {
          for (const direction of directions) {
            let cursor: string | null = null;
            for (const page of [1, 2] as const) {
              const sqlStart = trace.preparedSql.length;
              const bindingsStart = trace.bindings.length;
              const result: AnalyticsResult<CanonicalResult<"sessions">> =
                await runtime.execute(
                  "sessions",
                  queryInput({
                    scope,
                    sortKey,
                    direction,
                    advanced: true,
                    cursor,
                  }),
                );
              expect(
                result.ok,
                `advanced ${scope}/${sortKey}/${direction}`,
              ).toBe(true);
              if (!result.ok) throw new Error("baseline_provider_query_failed");
              const calls = trace.preparedSql
                .slice(sqlStart)
                .map((sql, index) => ({
                  sql,
                  bindings: trace.bindings[bindingsStart + index] ?? [],
                }));
              expect(calls.length).toBeGreaterThan(0);
              scenarios.push({
                kind: "advanced",
                scope,
                sort: { key: sortKey, direction },
                search: SEARCH,
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
            }
          }
        }
      }

      for (const sortKey of sortKeys) {
        for (const direction of directions) {
          let cursor: string | null = null;
          for (const page of [1, 2] as const) {
            const sqlStart = trace.preparedSql.length;
            const bindingsStart = trace.bindings.length;
            const result: AnalyticsResult<CanonicalResult<"sessions">> =
              await runtime.execute(
                "sessions",
                queryInput({ sortKey, direction, advanced: false, cursor }),
              );
            expect(result.ok, `ordinary ${sortKey}/${direction}`).toBe(true);
            if (!result.ok) throw new Error("baseline_provider_query_failed");
            const calls = trace.preparedSql
              .slice(sqlStart)
              .map((sql, index) => ({
                sql,
                bindings: trace.bindings[bindingsStart + index] ?? [],
              }));
            expect(calls.length).toBeGreaterThan(0);
            scenarios.push({
              kind: "ordinary-no-advanced-filter",
              sort: { key: sortKey, direction },
              search: SEARCH,
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
          }
        }
      }

      const evidence = {
        route:
          "createD1SiteQueryRuntime -> sessions -> d1AdvancedFilterMiddleware -> readSiteSessions -> querySessionListPageFromD1",
        head: "cb4720d7cd24c0dbda81cdef479b5905065c1421",
        siteId: SITE_ID,
        window: { startMs: BASE, endExclusiveMs: END, timeZone: "UTC" },
        filterDsl: FILTER_DSL,
        pageLimit: 1,
        scenarios,
      };
      writeEvidence(evidence);
      expect(scenarios).toHaveLength(18);
    } finally {
      database.close();
    }
  });
});

describe("Sessions qualified list pre-route finite budgets", () => {
  it.each(
    (["session", "visitor"] as const).flatMap((scope) =>
      (["startedAt", "durationMs", "views"] as const).map(
        (sortKey) => [scope, sortKey] as const,
      ),
    ),
  )(
    "executes a nonempty %s scoped %s first/next-page qualification within D1 budgets",
    async (scope, sortKey) => {
      const database = createMigratedDatabase();
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const env = {
        DB: createSqliteD1Database(database, trace),
        MAIN_SECRET: "wave97q-session-list-baseline-secret",
      } as unknown as Env;
      try {
        seedFixture(database);
        const { prepared, count } = preparedQualificationInput(scope);
        const sort = { key: sortKey, direction: "desc" as const };
        const compilePage = async (
          cursor: ReturnType<typeof sessionCursor> | null,
        ) => {
          const plan = buildJourneySessionListQualificationPlan({
            siteId: SITE_ID,
            queryTime: prepared.time,
            filters: prepared.filters,
            scopePlan: prepared.scopePlan,
            count,
            limit: 1,
            sort,
            search: SEARCH,
            cursor,
          });
          const compilation = compileSessionEnvelope({ plan, sort });
          if (compilation.kind !== "compiled") {
            writeNamedEvidence(`budget-${scope}-${sortKey}.json`, {
              state: "pre-route-qualified-plan-budget-unavailable",
              scope,
              sort,
              fallbackReason: compilation.fallbackReason,
              admissionEvidence: compilation.admissionEvidence,
            });
            throw new Error(
              `session_list_qualification_budget_unavailable:${scope}:${sortKey}:${JSON.stringify(compilation.fallbackReason)}`,
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
              row.outputId === JOURNEY_SESSION_LIST_REPORT_OUTPUT,
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
          expect(compilation.evidence.groupedSummaryProof).toMatchObject({
            source: "local-plan",
            nodeKind: "aggregate",
            groupKeyCount: 2,
            materialization: "materialized",
          });
          expect(calls).toHaveLength(1);
          const resultRows = reportRows.map(mapSessionRow);
          return {
            plan,
            compilation: compilation.evidence,
            envelopeRows,
            calls,
            resultRows,
          };
        };

        const first = await compilePage(null);
        const legacyFirst = await legacySessionPage(
          env,
          queryInput({
            scope,
            sortKey,
            direction: "desc",
            advanced: true,
          }),
        );
        expect(first.resultRows[0]).toEqual(legacyFirst.items[0]);
        expect(first.resultRows.length).toBeGreaterThan(1);
        const cursor = sessionCursor(first.resultRows[0]!, sort);
        const second = await compilePage(cursor);
        const legacySecond = await legacySessionPage(
          env,
          queryInput({
            scope,
            sortKey,
            direction: "desc",
            advanced: true,
            cursor: legacyFirst.pagination.nextCursor,
          }),
        );
        expect(second.resultRows[0]).toEqual(legacySecond.items[0]);

        writeNamedEvidence(`budget-${scope}-${sortKey}.json`, {
          state: "pre-route-qualified-plan-budget-executed",
          scope,
          sort,
          search: SEARCH,
          pageLimit: 1,
          firstPage: {
            dto: first.resultRows,
            legacyDto: legacyFirst,
            cursor: cursor,
            evidence: first.compilation,
            envelopeRows: first.envelopeRows,
            calls: first.calls,
          },
          nextPage: {
            dto: second.resultRows,
            legacyDto: legacySecond,
            requestCursor: legacyFirst.pagination.nextCursor,
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

describe("Sessions qualified runtime DTO and cursor compatibility", () => {
  it.each(
    (["startedAt", "durationMs", "views"] as const).flatMap((sortKey) =>
      (["asc", "desc"] as const).map(
        (direction) => [sortKey, direction] as const,
      ),
    ),
  )(
    "preserves the public %s/%s DTO and signed next cursor",
    async (sortKey, direction) => {
      const database = createMigratedDatabase();
      const env = {
        DB: createSqliteD1Database(database),
        MAIN_SECRET: "wave97q-session-list-baseline-secret",
      } as unknown as Env;
      try {
        seedFixture(database);
        const request = queryInput({
          scope: "session",
          sortKey,
          direction,
          advanced: true,
        });
        const [actual, legacy] = await Promise.all([
          createD1SiteQueryRuntime({ env, siteId: SITE_ID }).execute(
            "sessions",
            request,
          ),
          legacySessionPage(env, request),
        ]);
        expect(actual.ok, JSON.stringify(actual)).toBe(true);
        if (!actual.ok) throw new Error("session_list_runtime_query_failed");
        expect(actual.data).toEqual(legacy);
      } finally {
        database.close();
      }
    },
  );

  it.each(["session", "visitor"] as const)(
    "keeps three-page old-to-new-to-old cursors valid for %s scope",
    async (scope) => {
      const database = createMigratedDatabase();
      const env = {
        DB: createSqliteD1Database(database),
        MAIN_SECRET: "wave97q-session-list-baseline-secret",
      } as unknown as Env;
      try {
        seedFixture(database);
        const runtime = createD1SiteQueryRuntime({ env, siteId: SITE_ID });
        const request = (cursor: string | null) =>
          queryInput({
            scope,
            sortKey: "startedAt",
            direction: "desc",
            advanced: true,
            cursor,
          });
        const oldFirst = await legacySessionPage(env, request(null));
        expect(oldFirst.items).toHaveLength(1);
        expect(oldFirst.pagination.nextCursor).toEqual(expect.any(String));

        const newSecond = await runtime.execute(
          "sessions",
          request(oldFirst.pagination.nextCursor),
        );
        expect(newSecond.ok, JSON.stringify(newSecond)).toBe(true);
        if (!newSecond.ok) throw new Error("session_list_runtime_query_failed");
        const oldSecond = await legacySessionPage(
          env,
          request(oldFirst.pagination.nextCursor),
        );
        expect(newSecond.data).toEqual(oldSecond);
        expect(newSecond.data.pagination.nextCursor).toEqual(
          expect.any(String),
        );

        const oldThird = await legacySessionPage(
          env,
          request(newSecond.data.pagination.nextCursor),
        );
        expect(oldThird.items).toHaveLength(1);
        expect(oldThird.items[0]?.sessionId).not.toBe(
          oldFirst.items[0]?.sessionId,
        );
        expect(oldThird.items[0]?.sessionId).not.toBe(
          newSecond.data.items[0]?.sessionId,
        );
      } finally {
        database.close();
      }
    },
  );

  it("preserves visitor-scope expansion to the visitor's other sessions", async () => {
    const database = createMigratedDatabase();
    const env = {
      DB: createSqliteD1Database(database),
      MAIN_SECRET: "wave97q-session-list-baseline-secret",
    } as unknown as Env;
    try {
      seedFixture(database);
      const request = queryInput({
        scope: "visitor",
        sortKey: "startedAt",
        direction: "desc",
        advanced: true,
        limit: 20,
      });
      const actual = await createD1SiteQueryRuntime({
        env,
        siteId: SITE_ID,
      }).execute("sessions", request);
      expect(actual.ok, JSON.stringify(actual)).toBe(true);
      if (!actual.ok) throw new Error("session_list_runtime_query_failed");
      const legacy = await legacySessionPage(env, request);
      expect(actual.data).toEqual(legacy);
      expect(actual.data.items.map(({ sessionId }) => sessionId)).toEqual(
        expect.arrayContaining([
          "session-a-extra",
          "session-b-extra",
          "session-c-other",
        ]),
      );
    } finally {
      database.close();
    }
  });

  it("keeps same-named cross-site entities isolated in the qualification join", async () => {
    const database = createMigratedDatabase();
    const env = {
      DB: createSqliteD1Database(database),
      MAIN_SECRET: "wave97q-session-list-baseline-secret",
    } as unknown as Env;
    try {
      seedFixture(database);
      const otherSiteId = `${SITE_ID}-other`;
      database
        .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
        .run(otherSiteId);
      const otherSitePk = database
        .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
        .get(otherSiteId) as { readonly site_pk: number };
      database
        .prepare(
          `INSERT INTO sites (id, team_id, name, domain, created_at)
           VALUES (?, 'wave97q-team', 'Other site', 'other.test', 0)`,
        )
        .run(otherSiteId);
      database
        .prepare(
          `INSERT INTO visits (
            visit_id, site_id, site_pk, visitor_id, session_id, status,
            started_at, last_activity_at, pathname, hostname
          ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, 'other.test')`,
        )
        .run(
          "other-site-colliding-page",
          otherSiteId,
          otherSitePk.site_pk,
          "visitor-a",
          "session-a-match",
          BASE + 1_000,
          BASE + 9_000,
          "/match",
        );
      const request = queryInput({
        scope: "session",
        sortKey: "startedAt",
        direction: "desc",
        advanced: true,
        limit: 10,
      });
      const actual = await createD1SiteQueryRuntime({
        env,
        siteId: SITE_ID,
      }).execute("sessions", request);
      expect(actual.ok, JSON.stringify(actual)).toBe(true);
      if (!actual.ok) throw new Error("session_list_runtime_query_failed");
      const legacy = await legacySessionPage(env, request);
      expect(actual.data).toEqual(legacy);
      expect(
        actual.data.items.find(
          ({ sessionId }) => sessionId === "session-a-match",
        )?.views,
      ).toBe(1);
      expect(actual.data.items.map(({ sessionId }) => sessionId)).not.toContain(
        "other-site-colliding-page",
      );
    } finally {
      database.close();
    }
  });

  it("keeps Event-only owners whose Page observation is outside the window", async () => {
    const database = createMigratedDatabase();
    const env = {
      DB: createSqliteD1Database(database),
      MAIN_SECRET: "wave97q-session-list-baseline-secret",
    } as unknown as Env;
    try {
      seedFixture(database);
      seedEventOnlyOwnerOutsideWindow(database);
      const request = queryInput({
        scope: "session",
        sortKey: "startedAt",
        direction: "desc",
        advanced: true,
        filterDsl: 'count(event { event.name eq "signup" }) gte 1',
      });
      const actual = await createD1SiteQueryRuntime({
        env,
        siteId: SITE_ID,
      }).execute("sessions", request);
      expect(actual.ok, JSON.stringify(actual)).toBe(true);
      if (!actual.ok) throw new Error("session_list_runtime_query_failed");
      const legacy = await legacySessionPage(env, request);
      expect(actual.data).toEqual(legacy);
      expect(actual.data.items).toContainEqual(
        expect.objectContaining({
          sessionId: "session-event-only",
          views: 0,
          events: 1,
        }),
      );
    } finally {
      database.close();
    }
  });

  it("preserves Unicode search, equal-key order, duration rounding and empty IDs", async () => {
    const database = createMigratedDatabase();
    const env = {
      DB: createSqliteD1Database(database),
      MAIN_SECRET: "wave97q-session-list-baseline-secret",
    } as unknown as Env;
    try {
      seedFixture(database);
      const sitePk = database
        .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
        .get(SITE_ID) as { readonly site_pk: number };
      for (const [visitId, sessionId] of [
        ["unicode-a", "session-unicode-a"],
        ["unicode-b", "session-unicode-b"],
        ["unicode-empty", ""],
      ] as const) {
        seedVisit(database, sitePk.site_pk, {
          visitId,
          visitorId: `visitor-${visitId}`,
          sessionId,
          startedAt: BASE + 10_000,
          durationMs: -1.6,
          pathname: "/München/Über",
        });
      }
      const request = queryInput({
        scope: "session",
        sortKey: "durationMs",
        direction: "asc",
        advanced: true,
        filterDsl: 'count(page { page.path eq "/München/Über" }) gte 1',
        search: "MÜNCHEN",
        limit: 10,
      });
      const actual = await createD1SiteQueryRuntime({
        env,
        siteId: SITE_ID,
      }).execute("sessions", request);
      expect(actual.ok, JSON.stringify(actual)).toBe(true);
      if (!actual.ok) throw new Error("session_list_runtime_query_failed");
      const legacy = await legacySessionPage(env, request);
      expect(actual.data).toEqual(legacy);
      expect(actual.data.items.map(({ sessionId }) => sessionId)).toEqual([
        "session-unicode-a",
        "session-unicode-b",
      ]);
      expect(actual.data.items.map(({ durationMs }) => durationMs)).toEqual([
        0, 0,
      ]);
    } finally {
      database.close();
    }
  });
});

describe("Sessions qualified guards and request admission", () => {
  it("performs one whole legacy fallback for actual TEXT numeric Count data", async () => {
    const database = createMigratedDatabase();
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const env = {
      DB: createSqliteD1Database(database, trace),
      MAIN_SECRET: "wave97q-session-list-baseline-secret",
    } as unknown as Env;
    try {
      seedFixture(database);
      database
        .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
        .run("invalid-duration", "a-match-1");
      const diagnostics = createD1ReadDiagnostics();
      const request = queryInput({
        scope: "session",
        sortKey: "startedAt",
        direction: "desc",
        advanced: true,
        filterDsl:
          'page.path eq "/match" and count(page { page.durationMs gt 5 }) eq 1',
      });
      const result = await createD1SiteQueryRuntime({
        env,
        siteId: SITE_ID,
        diagnostics,
      }).execute("sessions", request);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) throw new Error("session_list_numeric_fallback_failed");
      expect(diagnostics.advancedCountSqlFallbackReason).toEqual({
        kind: "numeric-data-domain",
        fieldIds: ["page.durationMs"],
      });
      expect(
        trace.preparedSql.filter(
          (sql) => sql.includes('"rowKind"') && sql.includes('"outputId"'),
        ),
      ).toHaveLength(1);
      const legacy = await legacySessionPage(env, request);
      expect(result.data).toEqual(legacy);
    } finally {
      database.close();
    }
  });

  it("reads the entity membership instead of the legacy ID bridge for a numeric fallback", async () => {
    const database = createMigratedDatabase();
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const legacyTrace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const env = {
      DB: createSqliteD1Database(database, trace),
      MAIN_SECRET: "wave97q-session-list-baseline-secret",
    } as unknown as Env;
    const legacyEnv = {
      DB: createSqliteD1Database(database, legacyTrace),
      MAIN_SECRET: "wave97q-session-list-baseline-secret",
    } as unknown as Env;
    try {
      seedFixture(database);
      database
        .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
        .run("invalid-duration", "a-match-1");
      const request = queryInput({
        scope: "session",
        sortKey: "startedAt",
        direction: "desc",
        advanced: true,
        limit: 10,
        filterDsl:
          'page.path eq "/match" and count(page { page.durationMs gt 5 }) eq 0',
      });
      const diagnostics = createD1ReadDiagnostics();
      const result = await createD1SiteQueryRuntime({
        env,
        siteId: SITE_ID,
        diagnostics,
      }).execute("sessions", request);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) throw new Error("session_list_membership_failed");
      expect(diagnostics.advancedCountSqlFallbackReason).toEqual({
        kind: "numeric-data-domain",
        fieldIds: ["page.durationMs"],
      });
      const legacy = await legacySessionPage(legacyEnv, request);
      expect(legacy.items.length).toBeGreaterThan(0);
      expect(result.data).toEqual(legacy);
      // The legacy ID bridge binds the entity kind next to every identity;
      // the request-private entity membership binds only (site, id) pairs.
      expect(trace.bindings.at(-1) ?? []).not.toContain("session");
    } finally {
      database.close();
    }
  });

  it("does not invoke getters and admits exact Sessions Goal or Funnel analysis", () => {
    const request = prepareScopedQuery(
      "sessions",
      queryInput({
        scope: "session",
        sortKey: "startedAt",
        direction: "desc",
        advanced: true,
      }),
    ) as unknown as Record<string, unknown>;
    let getterCalls = 0;
    const getterRequest = { ...request };
    Object.defineProperty(getterRequest, "analysisContext", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return undefined;
      },
    });
    expect(
      sessionListQualificationConfigurationFromQuery(getterRequest),
    ).toBeUndefined();
    expect(getterCalls).toBe(0);

    expect(
      sessionListQualificationConfigurationFromQuery({
        ...request,
        analysisContext: { type: "goal", goalId: "personal-only" },
      }),
    ).toMatchObject({
      analysisContext: { type: "goal", goalId: "personal-only" },
    });
    const funnelContext = {
      type: "funnel",
      funnelId: "funnel-1",
      stepId: "step-1",
    } as const;
    expect(
      sessionListQualificationConfigurationFromQuery({
        ...request,
        analysisContext: { ...funnelContext, outcome: "dropoff" },
      }),
    ).toMatchObject({
      analysisContext: { ...funnelContext, outcome: "dropoff" },
    });
    expect(
      sessionListQualificationConfigurationFromQuery({
        ...request,
        analysisContext: funnelContext,
      }),
    ).toMatchObject({ analysisContext: funnelContext });
    expect(
      sessionListQualificationConfigurationFromQuery({
        ...request,
        analysisContext: { ...funnelContext, outcome: "invalid" },
      }),
    ).toBeUndefined();
    expect(
      sessionListQualificationConfigurationFromQuery({
        ...request,
        analysisContext: {
          type: "goal",
          goalId: "personal-only",
          extra: true,
        },
      }),
    ).toBeUndefined();
    expect(
      sessionListQualificationConfigurationFromQuery({
        ...request,
        visitorId: "visitor-a",
      }),
    ).toBeUndefined();
    expect(
      sessionListQualificationConfigurationFromQuery({
        ...request,
        context: siteQueryContext(SITE_ID, "public-share"),
      }),
    ).toBeUndefined();
  });

  it("rejects cloned and mutated middleware-branded requests", async () => {
    const database = createMigratedDatabase();
    const env = {
      DB: createSqliteD1Database(database),
      MAIN_SECRET: "wave97q-session-list-baseline-secret",
    } as unknown as Env;
    try {
      seedFixture(database);
      const request = queryInput({
        scope: "session",
        sortKey: "startedAt",
        direction: "desc",
        advanced: true,
      });
      const branded = await sessionMiddlewareQuery(env, request);
      expect(deferredSessionListQualificationFromQuery(branded)).toBeDefined();

      const clone = { ...branded } as QueryInput & Record<string, unknown>;
      for (const key of Reflect.ownKeys(branded)) {
        if (typeof key !== "symbol") continue;
        const descriptor = Object.getOwnPropertyDescriptor(branded, key);
        if (descriptor) Object.defineProperty(clone, key, descriptor);
      }
      expect(() => deferredSessionListQualificationFromQuery(clone)).toThrow(
        /untrusted/,
      );

      const mutated = await sessionMiddlewareQuery(env, request);
      mutated.search = "changed-after-middleware";
      expect(() => deferredSessionListQualificationFromQuery(mutated)).toThrow(
        /changed/,
      );
    } finally {
      database.close();
    }
  });

  it("checks Count controls before returning a malformed cursor error", async () => {
    const database = createMigratedDatabase();
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const env = {
      DB: createSqliteD1Database(database, trace),
      MAIN_SECRET: "wave97q-session-list-baseline-secret",
    } as unknown as Env;
    try {
      seedFixture(database);
      const result = await createD1SiteQueryRuntime({
        env,
        siteId: SITE_ID,
      }).execute(
        "sessions",
        queryInput({
          scope: "session",
          sortKey: "startedAt",
          direction: "desc",
          advanced: true,
          cursor: "malformed-cursor",
        }),
      );
      expect(result).toMatchObject({
        ok: false,
        error: { kind: "invalid-cursor", cursorKind: "journey-sessions" },
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

  it("lets real numeric fallback controls outrank a malformed cursor", async () => {
    const database = createMigratedDatabase();
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const env = {
      DB: createSqliteD1Database(database, trace),
      MAIN_SECRET: "wave97q-session-list-baseline-secret",
    } as unknown as Env;
    try {
      seedFixture(database);
      database
        .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
        .run("invalid-duration", "a-match-1");
      const diagnostics = createD1ReadDiagnostics();
      const result = await createD1SiteQueryRuntime({
        env,
        siteId: SITE_ID,
        diagnostics,
      }).execute(
        "sessions",
        queryInput({
          scope: "session",
          sortKey: "startedAt",
          direction: "desc",
          advanced: true,
          cursor: "malformed-cursor",
          filterDsl:
            'page.path eq "/match" and count(page { page.durationMs gt 5 }) eq 1',
        }),
      );
      expect(result).toMatchObject({
        ok: false,
        error: { kind: "invalid-cursor", cursorKind: "journey-sessions" },
      });
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

  it("checks the actual activity cap before a malformed cursor", async () => {
    const database = createMigratedDatabase();
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const env = {
      DB: d1WithEnvelopeRowTransform(database, trace, (row) =>
        row.rowKind === "control" ? { ...row, rawCount: 20_001 } : row,
      ),
      MAIN_SECRET: "wave97q-session-list-baseline-secret",
    } as unknown as Env;
    try {
      seedFixture(database);
      const result = await createD1SiteQueryRuntime({
        env,
        siteId: SITE_ID,
      }).execute(
        "sessions",
        queryInput({
          scope: "session",
          sortKey: "startedAt",
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

  it("rejects an unknown row kind even when the guard requests fallback", async () => {
    const database = createMigratedDatabase();
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const env = {
      DB: d1WithEnvelopeRowTransform(database, trace, (row) =>
        row.rowKind === "control"
          ? { ...row, nullActivityIdCount: 1 }
          : { ...row, rowKind: "unknown" },
      ),
      MAIN_SECRET: "wave97q-session-list-baseline-secret",
    } as unknown as Env;
    try {
      seedFixture(database);
      const result = await createD1SiteQueryRuntime({
        env,
        siteId: SITE_ID,
      }).execute(
        "sessions",
        queryInput({
          scope: "session",
          sortKey: "startedAt",
          direction: "desc",
          advanced: true,
        }),
      );
      expect(result).toMatchObject({
        ok: false,
        error: { kind: "internal", operation: "sessions" },
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

  it.each([null, 42, "", "repeated-session"])(
    "rejects malformed report session identity %s without coercion or retry",
    async (sessionId) => {
      const database = createMigratedDatabase();
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const env = {
        DB: d1WithEnvelopeRowTransform(database, trace, (row) =>
          row.rowKind === "report" ? { ...row, sessionId } : row,
        ),
        MAIN_SECRET: "wave97q-session-list-baseline-secret",
      } as unknown as Env;
      try {
        seedFixture(database);
        const result = await createD1SiteQueryRuntime({
          env,
          siteId: SITE_ID,
        }).execute(
          "sessions",
          queryInput({
            scope: "session",
            sortKey: "startedAt",
            direction: "desc",
            advanced: true,
          }),
        );
        expect(result).toMatchObject({
          ok: false,
          error: { kind: "internal", operation: "sessions" },
        });
        expect(trace.preparedSql).toHaveLength(2);
      } finally {
        database.close();
      }
    },
  );

  it("propagates a failed qualification read without retrying the legacy reader", async () => {
    const database = createMigratedDatabase();
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const env = {
      DB: d1WithEnvelopeRowTransform(database, trace, () => {
        throw new Error("session_list_qualification_d1_failed");
      }),
      MAIN_SECRET: "wave97q-session-list-baseline-secret",
    } as unknown as Env;
    try {
      seedFixture(database);
      const result = await createD1SiteQueryRuntime({
        env,
        siteId: SITE_ID,
      }).execute(
        "sessions",
        queryInput({
          scope: "session",
          sortKey: "startedAt",
          direction: "desc",
          advanced: true,
        }),
      );
      expect(result).toMatchObject({
        ok: false,
        error: { kind: "internal", operation: "sessions" },
      });
      const envelopeSql = trace.preparedSql.filter(
        (sql) => sql.includes('"rowKind"') && sql.includes('"outputId"'),
      );
      expect(envelopeSql).toHaveLength(1);
      expect(trace.preparedSql).toHaveLength(2);
    } finally {
      database.close();
    }
  });
});
