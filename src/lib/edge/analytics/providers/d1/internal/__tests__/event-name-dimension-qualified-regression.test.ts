import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { D1_MAX_BOUND_PARAMETERS, D1_MAX_SQL_UTF8_BYTES } from "@/lib/db";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import {
  createD1SiteProviderRegistry,
  createD1SiteQueryRuntime,
} from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import {
  prepareScopedQuery,
  type QueryInput,
  type QueryTime,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { createQueryTime } from "@/lib/edge/analytics/contract/helpers";
import { ADVANCED_FILTER_MAX_ACTIVITIES } from "@/lib/edge/analytics/engine/advanced-filter-activity-plan";
import { EVENT_QUALIFICATION_CONTROL_OUTPUT } from "@/lib/edge/analytics/engine/event-qualified-source-plan";
import {
  buildEventTypeSummaryQualificationPlan,
  EVENT_TYPE_SUMMARY_OUTPUTS,
  type EventNameDimensionListRequest,
  normalizeEventNameDimensionListRequest,
} from "@/lib/edge/analytics/engine/event-type-summary-plan";
import {
  d1AdvancedFilterMiddleware,
  deferredEventNameDimensionQualificationFromQuery,
  prepareDeferredEventQualificationFallback,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { compileEventNameDimensionQualificationProgram } from "@/lib/edge/analytics/providers/d1/internal/analytics-qualification-program";
import type { QueryWindow } from "@/lib/edge/analytics/providers/d1/internal/core";
import { mapDimensionRows } from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  createD1ReadDiagnostics,
  type D1ReadDiagnostics,
} from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import {
  queryEventNameDimensionFromD1,
  queryEventTypeAggregate,
} from "@/lib/edge/analytics/providers/d1/internal/events-summary";
import { hasWholeOriginalCompletion } from "@/lib/edge/analytics/providers/d1/internal/whole-filter-reader-preparation";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";

const SITE = "wave95i-event-name-dimension";
const TEAM = "wave95i-team";
const WINDOW: QueryWindow = {
  startMs: 120,
  endExclusiveMs: 130,
  nowMs: 500,
  timeZone: "UTC",
};
const QUERY_TIME = createQueryTime(120, 130, "UTC", 500);
const COUNT_FILTER = 'count(event { event.name eq "qualifier" }) gte 1';
const MIXED_FILTER =
  'event.name neq "qualifier" AND count(event { event.name eq "qualifier" }) gte 1';

type EventNameDimensionQuery = QueryInput & {
  readonly time: QueryTime;
  readonly mode: "breakdown";
  readonly dimension: string;
  readonly limit?: number;
  readonly page?: { readonly limit?: number; readonly cursor?: string | null };
  readonly search?: string;
  readonly sort?: { readonly key: string; readonly direction: "asc" | "desc" };
  readonly cursor?: string | null;
};

interface TestQueryOptions {
  readonly dsl?: string;
  readonly pageLimit?: number;
  readonly limit?: number;
  readonly pageCursor?: string | null;
  readonly cursor?: string | null;
  readonly search?: string;
  readonly sort?: { readonly key: string; readonly direction: "asc" | "desc" };
  readonly dimension?: string;
}

let database: DatabaseSync;
let sitePk: number;

function traceFor(): SqliteD1Trace {
  return { preparedSql: [], bindings: [] };
}

function testEnv(
  trace: SqliteD1Trace,
  targetDatabase: DatabaseSync = database,
): Env {
  return {
    DB: createSqliteD1Database(targetDatabase, trace),
    MAIN_SECRET: "wave95i-event-name-test-secret",
  } as unknown as Env;
}

function addName(id: number, name: string | null): void {
  database
    .prepare(
      `INSERT INTO custom_event_names
       (id, site_id, name, last_seen_at, site_pk) VALUES (?, ?, ?, 1, ?)`,
    )
    .run(id, SITE, name, sitePk);
}

function addVisit(input: {
  readonly id: string;
  readonly sessionId: string;
  readonly visitorId: string;
  readonly path: string;
}): void {
  database
    .prepare(
      `INSERT INTO visits (
        visit_id, site_id, site_pk, visitor_id, session_id, status,
        started_at, last_activity_at, pathname, hostname
      ) VALUES (?, ?, ?, ?, ?, 'closed', 125, 125, ?, 'wave95i.test')`,
    )
    .run(input.id, SITE, sitePk, input.visitorId, input.sessionId, input.path);
}

function addEvent(id: string, visitId: string, nameId: number): void {
  database
    .prepare(
      `INSERT INTO custom_events (
        event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
        received_at, sequence, node_count, value_count
      ) VALUES (?, ?, ?, ?, ?, 125, 125, 1, 0, 0)`,
    )
    .run(id, SITE, sitePk, visitId, nameId);
}

function createFixture(): void {
  database = createMigratedDatabase();
  database.exec("PRAGMA foreign_keys = OFF");
  database.exec(`
    ALTER TABLE custom_event_names RENAME TO custom_event_names_not_null;
    CREATE TABLE custom_event_names (
      id INTEGER PRIMARY KEY,
      site_id TEXT NOT NULL,
      name TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      last_seen_at INTEGER NOT NULL,
      site_pk INTEGER NOT NULL REFERENCES site_identities(site_pk),
      UNIQUE(site_pk, name)
    );
    DROP TABLE custom_event_names_not_null;
  `);
  database
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .run(SITE);
  sitePk = Number(
    (
      database
        .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
        .get(SITE) as { readonly site_pk: number }
    ).site_pk,
  );
  database
    .prepare(
      `INSERT INTO sites (id, team_id, name, domain, created_at)
       VALUES (?, ?, ?, ?, 0)`,
    )
    .run(SITE, TEAM, "Event name qualification", "wave95i.test");

  addName(1, "qualifier");
  addName(2, "Alpha");
  addName(3, "alpha");
  addName(4, "Beta");
  addName(5, "beta");
  addName(6, "   ");
  addName(7, "");
  addName(8, null);

  addVisit({
    id: "visit-one",
    sessionId: "session-one",
    visitorId: "visitor-shared",
    path: "/qualified",
  });
  addVisit({
    id: "visit-two",
    sessionId: "session-two",
    visitorId: "visitor-shared",
    path: "/other",
  });
  addVisit({
    id: "visit-three",
    sessionId: "session-three",
    visitorId: "visitor-excluded",
    path: "/other",
  });

  let eventId = 0;
  const add = (visitId: string, nameId: number, count = 1) => {
    for (let index = 0; index < count; index += 1)
      addEvent(`event-${++eventId}`, visitId, nameId);
  };
  add("visit-one", 1);
  add("visit-two", 1);
  add("visit-one", 2, 2);
  add("visit-two", 2);
  add("visit-one", 3);
  add("visit-two", 3);
  add("visit-one", 4);
  add("visit-two", 4);
  add("visit-one", 5);
  add("visit-two", 5);
  add("visit-one", 6);
  add("visit-one", 7);
  add("visit-one", 8);
  add("visit-three", 2, 4);
}

function createIsolatedEventFixture(options?: {
  readonly durationMs?: number | string | null;
}): { readonly database: DatabaseSync; readonly sitePk: number } {
  const isolatedDatabase = createMigratedDatabase();
  isolatedDatabase.exec("PRAGMA foreign_keys = OFF");
  isolatedDatabase
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .run(SITE);
  const sitePk = Number(
    (
      isolatedDatabase
        .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
        .get(SITE) as { readonly site_pk: number }
    ).site_pk,
  );
  isolatedDatabase
    .prepare(
      `INSERT INTO sites (id, team_id, name, domain, created_at)
       VALUES (?, ?, ?, ?, 0)`,
    )
    .run(SITE, TEAM, "Isolated event-name qualification", "isolated.test");
  isolatedDatabase
    .prepare(
      `INSERT INTO custom_event_names
       (id, site_id, name, last_seen_at, site_pk) VALUES (1, ?, 'qualifier', 1, ?)`,
    )
    .run(SITE, sitePk);
  isolatedDatabase
    .prepare(
      `INSERT INTO visits (
        visit_id, site_id, site_pk, visitor_id, session_id, status,
        started_at, last_activity_at, pathname, hostname, duration_ms
      ) VALUES ('visit-isolated', ?, ?, 'visitor-isolated', 'session-isolated',
        'closed', 125, 125, '/isolated', 'isolated.test', ?)`,
    )
    .run(SITE, sitePk, options?.durationMs ?? null);
  isolatedDatabase
    .prepare(
      `INSERT INTO custom_events (
        event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
        received_at, sequence, node_count, value_count
      ) VALUES ('event-isolated', ?, ?, 'visit-isolated', 1, 125, 125, 1, 0, 0)`,
    )
    .run(SITE, sitePk);
  return { database: isolatedDatabase, sitePk };
}

function queryFor(
  scope: "session" | "visitor" | "event",
  options: TestQueryOptions = {},
): EventNameDimensionQuery {
  const prepared = prepareScopedQuery("dimension", {
    context: siteQueryContext(SITE, "private-dashboard"),
    time: QUERY_TIME,
    filters: parseFilterDsl(
      options.dsl ?? COUNT_FILTER,
      analyticsFilterRegistry,
    ),
    scopePreference: scope,
  } as QueryInput & { readonly time: QueryTime });
  return {
    ...prepared,
    mode: "breakdown",
    dimension: options.dimension ?? "event.name",
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    ...(options.pageLimit !== undefined || options.pageCursor !== undefined
      ? {
          page: {
            ...(options.pageLimit !== undefined
              ? { limit: options.pageLimit }
              : {}),
            ...(options.pageCursor !== undefined
              ? { cursor: options.pageCursor }
              : {}),
          },
        }
      : {}),
    ...(options.search !== undefined ? { search: options.search } : {}),
    ...(options.sort ? { sort: options.sort } : {}),
    ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
  } as EventNameDimensionQuery;
}

function eventNameListLimit(query: EventNameDimensionQuery): number {
  const pageLimit = query.page?.limit;
  return typeof pageLimit === "number" && Number.isFinite(pageLimit)
    ? pageLimit
    : typeof query.limit === "number" && Number.isFinite(query.limit)
      ? query.limit
      : 20;
}

function searchText(query: EventNameDimensionQuery): string | undefined {
  return typeof query.search === "string" ? query.search : undefined;
}

async function runPublicQuery(
  query: EventNameDimensionQuery,
  trace: SqliteD1Trace,
) {
  const runtime = createD1SiteQueryRuntime({
    env: testEnv(trace),
    siteId: SITE,
  });
  const result = await runtime.execute("dimension", query as never);
  if (!result.ok)
    throw new Error(
      `public_dimension_query_failed:${JSON.stringify(result.error)}`,
    );
  return result.data as { readonly items: ReturnType<typeof mapDimensionRows> };
}

interface PublicProviderRunOptions {
  readonly database?: DatabaseSync;
  readonly diagnostics?: D1ReadDiagnostics;
  readonly env?: Env;
  readonly onPrepared?: (input: unknown) => void;
  readonly signal?: AbortSignal;
  readonly siteId?: string;
}

async function runPublicProviderQuery(
  query: EventNameDimensionQuery,
  trace: SqliteD1Trace,
  options: PublicProviderRunOptions = {},
) {
  const registry = createD1SiteProviderRegistry({
    env: options.env ?? testEnv(trace, options.database),
    siteId: options.siteId ?? SITE,
    ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
  });
  if (options.onPrepared) {
    registry.useMiddleware(async (_operation, input, next) => {
      options.onPrepared?.(input);
      return next(input);
    });
  }
  const provider = registry.resolve("dimension");
  if (!provider)
    throw new Error("wave95i_event_name_dimension_provider_missing");
  const result = await provider.execute(
    query as never,
    options.signal ? { signal: options.signal } : undefined,
  );
  return result.value as {
    readonly items: ReturnType<typeof mapDimensionRows>;
  };
}

function testEnvWithControlResultBehavior(
  trace: SqliteD1Trace,
  behavior:
    "missing-control" | "duplicate-control" | "wrong-control-scope" | "observe",
  targetDatabase: DatabaseSync = database,
  observeRows?: (rows: readonly Record<string, unknown>[]) => void,
): Env {
  const baseDatabase = createSqliteD1Database(targetDatabase, trace);
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
          const rows = result.results.map((row) => ({ ...row }));
          observeRows?.(rows);
          if (behavior === "missing-control")
            return {
              ...result,
              results: rows.filter((row) => row.rowKind !== "control"),
            };
          const control = rows.find((row) => row.rowKind === "control");
          if (behavior === "duplicate-control" && control)
            return { ...result, results: [...rows, control] };
          if (behavior === "wrong-control-scope")
            return {
              ...result,
              results: rows.map((row) =>
                row.rowKind === "control"
                  ? { ...row, entityKind: "visitor" }
                  : row,
              ),
            };
          return result;
        },
      });
      return replacement;
    },
  } as unknown as D1Database;
  return {
    DB,
    MAIN_SECRET: "wave95i-event-name-test-secret",
  } as unknown as Env;
}

// Current generic-route comparison; the frozen pre-migration runtime oracle lives separately.
async function runLegacyList(
  query: EventNameDimensionQuery,
  trace: SqliteD1Trace,
  targetDatabase: DatabaseSync = database,
): Promise<{ readonly items: ReturnType<typeof mapDimensionRows> }> {
  const env = testEnv(trace, targetDatabase);
  const forwarded = await d1AdvancedFilterMiddleware(env, undefined, SITE)(
    "dimension",
    query,
    async (value) => value,
  );
  const deferred = deferredEventNameDimensionQualificationFromQuery(forwarded);
  const filters = deferred
    ? await prepareDeferredEventQualificationFallback(deferred)
    : (forwarded as EventNameDimensionQuery).filters;
  if (!filters) throw new Error("wave95i_legacy_filter_preparation_missing");
  const rows = await queryEventTypeAggregate(
    env,
    SITE,
    WINDOW,
    filters,
    eventNameListLimit(query),
    searchText(query),
    ...(hasWholeOriginalCompletion(forwarded as object, "event-name-dimension")
      ? ([forwarded as object] as const)
      : ([] as const)),
  );
  return { items: mapDimensionRows(rows) };
}

async function captureOutcome<T>(
  action: () => Promise<T>,
): Promise<
  | { readonly kind: "fulfilled"; readonly value: T }
  | { readonly kind: "rejected"; readonly message: string }
> {
  try {
    return { kind: "fulfilled", value: await action() };
  } catch (error) {
    return {
      kind: "rejected",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function tracedStatements(trace: SqliteD1Trace) {
  return trace.preparedSql.map((sql, index) => ({
    sql,
    bindings: trace.bindings[index],
    sqlUtf8Bytes: new TextEncoder().encode(sql).byteLength,
    sha256: createHash("sha256").update(sql, "utf8").digest("hex"),
  }));
}

async function writeEvidence(name: string, value: unknown): Promise<void> {
  const directory = process.env.WAVE95I_ARTIFACT_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, name),
    JSON.stringify(value, null, 2),
    "utf8",
  );
}

async function writeWave97ebEvidence(
  name: string,
  value: unknown,
): Promise<void> {
  const directory = process.env.WAVE97EB_ARTIFACT_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, name),
    JSON.stringify(value, null, 2),
    "utf8",
  );
}

beforeAll(() => createFixture());
afterAll(() => database?.close());

describe("event.name dimension Count qualification", () => {
  it.each(["session", "visitor"] as const)(
    "compiles the default event.name list for %s scope before report execution",
    async (scope) => {
      const query = queryFor(scope, { dsl: MIXED_FILTER });
      const trace = traceFor();
      const env = testEnv(trace);
      const forwarded = await d1AdvancedFilterMiddleware(env, undefined, SITE)(
        "dimension",
        query,
        async (value) => value,
      );
      const deferred =
        deferredEventNameDimensionQualificationFromQuery(forwarded);
      if (!deferred)
        throw new Error(
          "wave95i_event_name_dimension_deferred_request_missing",
        );
      const request = normalizeEventNameDimensionListRequest({
        mode: query.mode,
        dimension: query.dimension,
        page: query.page,
        limit: query.limit,
        search: query.search,
        audience: query.context.policy.audience,
      });
      if (!request)
        throw new Error(
          "wave95i_event_name_dimension_request_normalization_failed",
        );
      const qualification = buildEventTypeSummaryQualificationPlan({
        siteId: SITE,
        count: deferred.countInput,
        query: {
          kind: "list",
          limit: request.limit,
          ...(request.search !== undefined ? { search: request.search } : {}),
        },
        reportFilters: deferred.eventNameDimensionReportFilters,
      });
      const compiled = compileEventNameDimensionQualificationProgram(deferred);
      if (compiled.kind !== "compiled")
        throw new Error(
          `wave95i_event_name_dimension_default_compile_unavailable:${JSON.stringify(compiled.fallbackReason)}`,
        );
      expect(trace.preparedSql).toHaveLength(1);
      expect(compiled.evidence.statementTag).toBe(
        "analytics.event_types_qualification",
      );
      expect(compiled.evidence.sqlBytes).toBeLessThanOrEqual(
        D1_MAX_SQL_UTF8_BYTES,
      );
      expect(compiled.evidence.bindingCount).toBeLessThanOrEqual(
        D1_MAX_BOUND_PARAMETERS,
      );
      expect(qualification.scope).toBe(scope);
      expect(qualification.primaryReportSourceRelationId).toBe(
        qualification.eventSourceRelationId,
      );
      expect(qualification.reportSourceRelations).toEqual([
        { relationId: qualification.eventSourceRelationId, entity: "event" },
      ]);
      expect(qualification.reportOutputIds).toEqual([
        EVENT_TYPE_SUMMARY_OUTPUTS.list,
      ]);
      expect(qualification.controlOutputId).toBe(
        EVENT_QUALIFICATION_CONTROL_OUTPUT,
      );
      const logicalGraph = JSON.stringify(qualification.plan, null, 2);
      const physicalGraph = JSON.stringify(
        {
          sql: compiled.evidence.sql,
          bindings: compiled.evidence.bindings,
          shape: compiled.evidence.physicalPlanShape,
        },
        null,
        2,
      );
      await writeEvidence(`compile-${scope}.json`, {
        scope,
        deferredOperation: deferred.operation,
        request: deferred.eventNameDimensionRequest,
        sourceGates: qualification.reportSourceRelations,
        primaryReportSourceRelationId:
          qualification.primaryReportSourceRelationId,
        reportOutputIds: qualification.reportOutputIds,
        controlOutputId: qualification.controlOutputId,
        statementTag: compiled.evidence.statementTag,
        sql: compiled.evidence.sql,
        bindings: compiled.evidence.bindings,
        sqlUtf8Bytes: compiled.evidence.sqlBytes,
        bindingCount: compiled.evidence.bindingCount,
        groupWidth: compiled.evidence.groupWidth,
        sharedRelationCount: compiled.evidence.sharedRelationCount,
        physicalScanKinds: compiled.evidence.physicalScanKinds,
        physicalPlanShape: compiled.evidence.physicalPlanShape,
        logicalGraphSha256: createHash("sha256")
          .update(logicalGraph, "utf8")
          .digest("hex"),
        compiledPhysicalGraphSha256: createHash("sha256")
          .update(physicalGraph, "utf8")
          .digest("hex"),
        preparationStatements: tracedStatements(trace),
      });
    },
  );

  it("uses a request-bound Event candidate for the event.name list and matches Core", async () => {
    const query = queryFor("event", { dsl: COUNT_FILTER });
    const actualTrace = traceFor();
    let observedDeferred:
      | ReturnType<typeof deferredEventNameDimensionQualificationFromQuery>
      | undefined;
    const actual = await runPublicProviderQuery(query, actualTrace, {
      onPrepared: (input) => {
        observedDeferred =
          deferredEventNameDimensionQualificationFromQuery(input);
      },
    });
    const legacyTrace = traceFor();
    const legacy = await runLegacyList(query, legacyTrace);
    expect(observedDeferred).toBeDefined();
    expect(observedDeferred?.countInput.scope).toBe("event");
    expect(observedDeferred?.countInput.candidateAnchor).toEqual({
      kind: "event-candidate",
    });
    expect(observedDeferred?.eventNameDimensionReportFilters).toBeUndefined();
    expect(actual).toEqual(legacy);
    expect(actualTrace.preparedSql).toHaveLength(2);
    expect(legacyTrace.preparedSql.length).toBeGreaterThan(2);

    const sessionTrace = traceFor();
    const sessionForwarded = await d1AdvancedFilterMiddleware(
      testEnv(sessionTrace),
      undefined,
      SITE,
    )(
      "dimension",
      queryFor("session", { dsl: COUNT_FILTER }),
      async (value) => value,
    );
    const sessionDeferred =
      deferredEventNameDimensionQualificationFromQuery(sessionForwarded);
    expect(sessionDeferred?.countInput.scope).toBe("session");
    expect(sessionDeferred?.countInput.candidateAnchor).toBeUndefined();
    await writeWave97ebEvidence("event-name-dimension-event-candidate.json", {
      request: {
        mode: query.mode,
        dimension: query.dimension,
        audience: query.context.policy.audience,
      },
      candidateAnchor: observedDeferred?.countInput.candidateAnchor,
      countScope: observedDeferred?.countInput.scope,
      reportFilters: observedDeferred?.eventNameDimensionReportFilters,
      actualDto: actual,
      coreDto: legacy,
      sessionOwnerScope: sessionDeferred?.countInput.scope,
      dtoMatchesCore: JSON.stringify(actual) === JSON.stringify(legacy),
      ownerRouteRemainedSessionScoped:
        sessionDeferred?.countInput.scope === "session",
      fusedStatements: tracedStatements(actualTrace),
      coreStatements: tracedStatements(legacyTrace),
    });
  });

  it.each(["session", "visitor"] as const)(
    "matches the old full Count-plus-list DTO and order for %s scope",
    async (scope) => {
      const query = queryFor(scope, {
        dsl: MIXED_FILTER,
        pageLimit: 20,
        pageCursor: "ignored-invalid-cursor",
        cursor: "ignored-top-level-cursor",
        sort: { key: "sessions", direction: "asc" },
      });
      const actualTrace = traceFor();
      const actual = await runPublicQuery(query, actualTrace);
      const legacyTrace = traceFor();
      const legacy = await runLegacyList(query, legacyTrace);
      expect(actual).toEqual(legacy);
      expect(Object.keys(actual)).toEqual(["items"]);
      expect(actual.items.map((row) => row.key)).toContain("qualifier");
      expect(actualTrace.preparedSql).toHaveLength(2);
      expect(legacyTrace.preparedSql.length).toBeGreaterThan(2);
      const tied = actual.items
        .filter((row) => row.views === 2 && row.sessions === 2)
        .map((row) => row.key);
      expect(tied).toEqual(["Beta", "alpha", "beta", "qualifier"]);
      await writeEvidence(`runtime-${scope}-mixed.json`, {
        scope,
        request: {
          mode: query.mode,
          dimension: query.dimension,
          limit: eventNameListLimit(query),
          search: searchText(query),
          sort: query.sort,
          page: query.page,
          cursor: query.cursor,
        },
        oldRouteStatementCount: legacyTrace.preparedSql.length,
        fusedRouteStatementCount: actualTrace.preparedSql.length,
        legacyStatements: tracedStatements(legacyTrace),
        fusedStatements: tracedStatements(actualTrace),
        oldDto: legacy,
        fusedDto: actual,
        dtoEqual: true,
      });
    },
  );

  it("preserves list defaults, limit precedence, raw search, and empty results", async () => {
    const cases: Array<{
      readonly name: string;
      readonly options: TestQueryOptions;
      readonly expectedCount: number;
    }> = [
      {
        name: "default-limit",
        options: { dsl: MIXED_FILTER },
        expectedCount: 5,
      },
      {
        name: "page-limit-precedence",
        options: { dsl: MIXED_FILTER, pageLimit: 2, limit: 3 },
        expectedCount: 2,
      },
      {
        name: "one-row",
        options: { dsl: MIXED_FILTER, pageLimit: 1 },
        expectedCount: 1,
      },
      {
        name: "whitespace-search",
        options: { dsl: MIXED_FILTER, search: "   " },
        expectedCount: 5,
      },
      {
        name: "trimmed-case-insensitive-search",
        options: { dsl: MIXED_FILTER, search: "  aLpH  " },
        expectedCount: 2,
      },
      {
        name: "no-results",
        options: { dsl: MIXED_FILTER, search: "missing-name" },
        expectedCount: 0,
      },
    ];
    const observations = [];
    for (const testCase of cases) {
      const query = queryFor("session", {
        ...testCase.options,
        sort: { key: "sessions", direction: "asc" },
        pageCursor: "still-ignored",
      });
      const actualTrace = traceFor();
      const actual = await runPublicQuery(query, actualTrace);
      const legacyTrace = traceFor();
      const legacy = await runLegacyList(query, legacyTrace);
      expect(actual, testCase.name).toEqual(legacy);
      expect(actual.items, testCase.name).toHaveLength(testCase.expectedCount);
      observations.push({
        name: testCase.name,
        limit: eventNameListLimit(query),
        search: searchText(query),
        fusedStatementCount: actualTrace.preparedSql.length,
        legacyStatementCount: legacyTrace.preparedSql.length,
        dto: actual,
      });
    }
    await writeEvidence("runtime-list-compatibility.json", observations);
  });

  it("keeps unsupported mixed OR on the complete old route", async () => {
    const query = queryFor("session", {
      dsl: 'event.name eq "Alpha" OR count(event { event.name eq "qualifier" }) gte 1',
      pageLimit: 20,
    });
    const actualTrace = traceFor();
    const actual = await runPublicQuery(query, actualTrace);
    const legacyTrace = traceFor();
    const legacy = await runLegacyList(query, legacyTrace);
    expect(actual).toEqual(legacy);
    expect(actualTrace.preparedSql.length).toBeGreaterThan(2);
    await writeEvidence("runtime-mixed-or-fallback.json", {
      oldRouteStatementCount: legacyTrace.preparedSql.length,
      publicRouteStatementCount: actualTrace.preparedSql.length,
      oldStatements: tracedStatements(legacyTrace),
      publicStatements: tracedStatements(actualTrace),
      dto: actual,
      dtoEqual: true,
    });
  });

  it("rejects every branded request mismatch and public context abort before SQL", async () => {
    const query = queryFor("session", { dsl: MIXED_FILTER });
    if (!query.filters)
      throw new Error("wave95i_event_name_dimension_filters_missing");
    const request = normalizeEventNameDimensionListRequest({
      mode: query.mode,
      dimension: query.dimension,
      page: query.page,
      limit: query.limit,
      search: query.search,
      audience: query.context.policy.audience,
    });
    if (!request)
      throw new Error("wave95i_event_name_dimension_request_missing");
    const alteredScopePlan = {
      ...((query as QueryInput & { readonly scopePlan?: object }).scopePlan ??
        {}),
      scope: "visitor",
    };
    const alteredReadRangeTime = {
      ...query.time,
      readRange: {
        startMs: query.time.range.startMs + 1,
        endExclusiveMs: query.time.range.endExclusiveMs,
      },
    } as QueryTime;
    const mismatches: Array<{
      readonly name: string;
      readonly siteId?: string;
      readonly queryTime?: QueryTime;
      readonly filters?: NonNullable<EventNameDimensionQuery["filters"]>;
      readonly request?: EventNameDimensionListRequest;
      readonly scopePlan?: unknown;
    }> = [
      { name: "site", siteId: `${SITE}-other` },
      { name: "range", queryTime: createQueryTime(121, 130, "UTC", 500) },
      { name: "read-range", queryTime: alteredReadRangeTime },
      {
        name: "reporting-timezone",
        queryTime: createQueryTime(120, 130, "America/Los_Angeles", 500),
      },
      { name: "captured-at", queryTime: createQueryTime(120, 130, "UTC", 501) },
      { name: "scope-plan", scopePlan: alteredScopePlan },
      { name: "limit", request: { ...request, limit: request.limit + 1 } },
      { name: "search", request: { ...request, search: "changed-search" } },
      {
        name: "audience",
        request: { ...request, audience: "public-share" },
      },
      {
        name: "mode",
        request: {
          ...request,
          mode: "overview-tab",
        } as unknown as EventNameDimensionListRequest,
      },
      {
        name: "dimension",
        request: {
          ...request,
          dimension: "session.entryPath",
        } as unknown as EventNameDimensionListRequest,
      },
      {
        name: "filter-document-identity",
        filters: { ...query.filters } as NonNullable<
          EventNameDimensionQuery["filters"]
        >,
      },
    ];
    const observations: Array<{
      readonly name: string;
      readonly sqlCount: number;
    }> = [];
    for (const mismatch of mismatches) {
      const trace = traceFor();
      const env = testEnv(trace);
      const forwarded = await d1AdvancedFilterMiddleware(env, undefined, SITE)(
        "dimension",
        query,
        async (value) => value,
      );
      const deferred =
        deferredEventNameDimensionQualificationFromQuery(forwarded);
      if (!deferred)
        throw new Error(
          "wave95i_event_name_dimension_deferred_request_missing",
        );

      // Brand setup is real middleware; reset its site-coverage trace so this
      // assertion measures only the mismatched direct helper call.
      trace.preparedSql.length = 0;
      trace.bindings.length = 0;
      const scopePlan = mismatch.scopePlan;
      await expect(
        queryEventNameDimensionFromD1(
          env,
          mismatch.siteId ?? SITE,
          WINDOW,
          mismatch.queryTime ?? query.time,
          mismatch.filters ?? query.filters,
          mismatch.request ?? deferred.eventNameDimensionRequest,
          {
            deferredQualification: deferred,
            ...(scopePlan !== undefined
              ? { scopePlan: scopePlan as never }
              : query.scopePlan
                ? { scopePlan: query.scopePlan }
                : {}),
          },
        ),
      ).rejects.toThrow("event_name_dimension_qualification_request_mismatch");
      expect(trace.preparedSql, mismatch.name).toHaveLength(0);
      observations.push({
        name: mismatch.name,
        sqlCount: trace.preparedSql.length,
      });
    }

    const wrongSiteTrace = traceFor();
    const wrongSiteProvider = createD1SiteProviderRegistry({
      env: testEnv(wrongSiteTrace),
      siteId: `${SITE}-other`,
    }).resolve("dimension");
    if (!wrongSiteProvider)
      throw new Error("wave95i_event_name_wrong_site_provider_missing");
    await expect(wrongSiteProvider.execute(query as never)).rejects.toThrow();
    expect(wrongSiteTrace.preparedSql).toHaveLength(0);

    const abortTrace = traceFor();
    const abortProvider = createD1SiteProviderRegistry({
      env: testEnv(abortTrace),
      siteId: SITE,
    }).resolve("dimension");
    if (!abortProvider)
      throw new Error("wave95i_event_name_abort_provider_missing");
    const controller = new AbortController();
    controller.abort();
    await expect(
      abortProvider.execute(query as never, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(abortTrace.preparedSql).toHaveLength(0);

    await writeEvidence("request-mismatch-and-public-guards.json", {
      directMismatchCases: observations,
      directMismatchStatementCount: observations.reduce(
        (total, observation) => total + observation.sqlCount,
        0,
      ),
      wrongExpectedSiteStatementCount: wrongSiteTrace.preparedSql.length,
      preAbortedStatementCount: abortTrace.preparedSql.length,
      brandSource: "real d1AdvancedFilterMiddleware output; no brand forgery",
    });
  });

  it("keeps noneligible limits on the legacy list path and excludes adjacent dimension families", async () => {
    const limitCases: Array<{
      readonly name: string;
      readonly options: TestQueryOptions;
    }> = [
      {
        name: "page-limit-zero-precedes-positive-outer-limit",
        options: { dsl: MIXED_FILTER, pageLimit: 0, limit: 3 },
      },
      { name: "negative-limit", options: { dsl: MIXED_FILTER, limit: -1 } },
      {
        name: "non-safe-positive-limit",
        options: { dsl: MIXED_FILTER, limit: Number.MAX_SAFE_INTEGER + 1 },
      },
    ];
    const limitObservations = [];
    for (const testCase of limitCases) {
      const query = queryFor("session", testCase.options);
      let observedDeferred: ReturnType<
        typeof deferredEventNameDimensionQualificationFromQuery
      >;
      const actualTrace = traceFor();
      const actual = await captureOutcome(() =>
        runPublicProviderQuery(query, actualTrace, {
          onPrepared: (input) => {
            observedDeferred =
              deferredEventNameDimensionQualificationFromQuery(input);
          },
        }),
      );
      const legacyTrace = traceFor();
      const legacy = await captureOutcome(() =>
        runLegacyList(query, legacyTrace),
      );
      expect(actual, testCase.name).toEqual(legacy);
      expect(observedDeferred, testCase.name).toBeUndefined();
      expect(actualTrace.preparedSql, testCase.name).toEqual(
        legacyTrace.preparedSql,
      );
      expect(actualTrace.bindings, testCase.name).toEqual(legacyTrace.bindings);
      limitObservations.push({
        name: testCase.name,
        effectiveLimit: eventNameListLimit(query),
        outcome: actual,
        statementCount: actualTrace.preparedSql.length,
        legacyStatementCount: legacyTrace.preparedSql.length,
        deferredOptimizationUsed: false,
      });
    }

    const baseQuery = queryFor("session", { dsl: MIXED_FILTER });
    const excludedFamilies = [
      {
        name: "overview-tab",
        query: { ...baseQuery, mode: "overview-tab" },
      },
      {
        name: "session-boundary",
        query: { ...baseQuery, dimension: "session.entryPath" },
      },
      {
        name: "unknown-selection",
        query: { ...baseQuery, dimension: "future.unknownSelection" },
      },
    ];
    const excludedObservations = [];
    for (const excluded of excludedFamilies) {
      const trace = traceFor();
      const forwarded = await d1AdvancedFilterMiddleware(
        testEnv(trace),
        undefined,
        SITE,
      )(
        "dimension",
        excluded.query as unknown as EventNameDimensionQuery,
        async (value) => value,
      );
      expect(
        deferredEventNameDimensionQualificationFromQuery(forwarded),
        excluded.name,
      ).toBeUndefined();
      excludedObservations.push({
        name: excluded.name,
        deferredEventNameDimension: false,
        middlewareStatementCount: trace.preparedSql.length,
      });
    }
    await writeEvidence("noneligible-limits-and-excluded-families.json", {
      limits: limitObservations,
      excludedFamilies: excludedObservations,
    });
  });

  it("falls back once to the complete old list after a real numeric-domain control", async () => {
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run(10, "visit-one");
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "visit-two");
    const query = queryFor("session", {
      dsl: `${MIXED_FILTER} AND count(page { page.durationMs gt 5 }) eq 1`,
    });
    const legacyTrace = traceFor();
    const legacy = await runLegacyList(query, legacyTrace);
    const actualTrace = traceFor();
    const diagnostics = createD1ReadDiagnostics();
    let fusedRows: readonly Record<string, unknown>[] = [];
    const env = testEnvWithControlResultBehavior(
      actualTrace,
      "observe",
      database,
      (rows) => {
        fusedRows = rows;
      },
    );
    try {
      const actual = await runPublicProviderQuery(query, actualTrace, {
        diagnostics,
        env,
      });
      expect(actual).toEqual(legacy);
      expect(diagnostics.advancedCountSqlFallbackReason).toEqual({
        kind: "numeric-data-domain",
        fieldIds: ["page.durationMs"],
      });
      const controls = fusedRows.filter((row) => row.rowKind === "control");
      const reports = fusedRows.filter((row) => row.rowKind === "report");
      expect(controls).toHaveLength(1);
      expect(reports).toHaveLength(0);
      const numericControl = Object.entries(controls[0]!).find(
        ([name, value]) =>
          name.toLowerCase().includes("duration") && Number(value) > 0,
      );
      expect(numericControl).toBeDefined();
      expect(actualTrace.preparedSql).toHaveLength(
        legacyTrace.preparedSql.length + 1,
      );
      const fusedOnlyStatements = actualTrace.preparedSql.filter(
        (sql) => !legacyTrace.preparedSql.includes(sql),
      );
      // Both routes read the same prepared membership relation, so only the
      // fused attempt differs from the legacy statements.
      expect(fusedOnlyStatements).toHaveLength(1);
      const legacyPreparationStatementCount =
        legacyTrace.preparedSql.length - 2;
      expect(legacyPreparationStatementCount).toBeGreaterThanOrEqual(1);
      expect(actualTrace.preparedSql.length).toBe(
        1 + 1 + legacyPreparationStatementCount + 1,
      );
      await writeEvidence("numeric-whole-list-fallback.json", {
        numericFixture: {
          fieldId: "page.durationMs",
          visitId: "visit-two",
          storedValue: "invalid-duration",
        },
        fallbackReason: diagnostics.advancedCountSqlFallbackReason,
        numericControl,
        reportRowsFromRejectedFusedAttempt: reports.length,
        legacyDto: legacy,
        actualDto: actual,
        statementAccounting: {
          coverage: 1,
          fusedAttempt: 1,
          legacyPreparation: legacyPreparationStatementCount,
          report: 1,
          legacyTotal: legacyTrace.preparedSql.length,
          actualTotal: actualTrace.preparedSql.length,
          actualStatements: tracedStatements(actualTrace),
          legacyStatements: tracedStatements(legacyTrace),
        },
      });
    } finally {
      database
        .prepare(
          "UPDATE visits SET duration_ms = NULL WHERE visit_id IN (?, ?)",
        )
        .run("visit-one", "visit-two");
    }
  });

  it("runs the event-candidate numeric fallback through the request-private Event membership relation", async () => {
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "visit-two");
    try {
      const query = queryFor("event", {
        dsl: "count(page { page.durationMs gt 5 }) eq 0",
      });
      const legacyTrace = traceFor();
      const legacy = await runLegacyList(query, legacyTrace);
      expect(legacy.items.length).toBeGreaterThan(0);

      const actualTrace = traceFor();
      const diagnostics = createD1ReadDiagnostics();
      let observedDeferred:
        | ReturnType<typeof deferredEventNameDimensionQualificationFromQuery>
        | undefined;
      const actual = await runPublicProviderQuery(query, actualTrace, {
        diagnostics,
        onPrepared: (input) => {
          observedDeferred =
            deferredEventNameDimensionQualificationFromQuery(input);
        },
      });
      expect(actual).toEqual(legacy);
      expect(observedDeferred?.countInput.scope).toBe("event");
      expect(
        observedDeferred?.metadata.plan.preparedMembership,
      ).toBeUndefined();
      expect(diagnostics.advancedCountSqlFallbackReason).toEqual({
        kind: "numeric-data-domain",
        fieldIds: ["page.durationMs"],
      });
      // The legacy ID bridge binds a (site, "event", id) kind column.
      expect(actualTrace.bindings.at(-1) ?? []).not.toContain("event");
    } finally {
      database
        .prepare("UPDATE visits SET duration_ms = NULL WHERE visit_id = ?")
        .run("visit-two");
    }
  });

  it("enforces the activity cap before a simultaneous numeric fallback on the public list", async () => {
    const fixture = createIsolatedEventFixture({
      durationMs: "invalid-duration",
    });
    try {
      const bulkCount = ADVANCED_FILTER_MAX_ACTIVITIES + 1;
      fixture.database
        .prepare(
          `WITH RECURSIVE generated(n) AS (
             SELECT 1
             UNION ALL SELECT n + 1 FROM generated WHERE n < ?
           )
           INSERT INTO custom_events (
             event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
             received_at, sequence, node_count, value_count
           )
           SELECT 'wave95i-cap-' || n, ?, ?, 'visit-isolated', 1, 125,
             125, 1, 0, 0 FROM generated`,
        )
        .run(bulkCount, SITE, fixture.sitePk);
      const query = queryFor("session", {
        dsl: `${MIXED_FILTER} AND count(page { page.durationMs gt 5 }) eq 1`,
      });
      const trace = traceFor();
      const diagnostics = createD1ReadDiagnostics();
      let fusedRows: readonly Record<string, unknown>[] = [];
      const env = testEnvWithControlResultBehavior(
        trace,
        "observe",
        fixture.database,
        (rows) => {
          fusedRows = rows;
        },
      );
      await expect(
        runPublicProviderQuery(query, trace, { diagnostics, env }),
      ).rejects.toMatchObject({
        domainError: {
          kind: "invalid-input",
          issues: [{ path: "filters", code: "filter_activity_limit_exceeded" }],
        },
      });
      const controls = fusedRows.filter((row) => row.rowKind === "control");
      const reports = fusedRows.filter((row) => row.rowKind === "report");
      expect(controls).toHaveLength(1);
      expect(Number(controls[0]!.rawCount)).toBeGreaterThan(
        ADVANCED_FILTER_MAX_ACTIVITIES,
      );
      const numericControl = Object.entries(controls[0]!).find(
        ([name, value]) =>
          name.toLowerCase().includes("duration") && Number(value) > 0,
      );
      expect(numericControl).toBeDefined();
      expect(reports).toHaveLength(0);
      expect(trace.preparedSql).toHaveLength(2);
      expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
      await writeEvidence("activity-cap-before-numeric-fallback.json", {
        activityLimit: ADVANCED_FILTER_MAX_ACTIVITIES,
        rawCount: Number(controls[0]!.rawCount),
        numericControl,
        reportRows: reports.length,
        error: "filter_activity_limit_exceeded",
        fallbackReason: diagnostics.advancedCountSqlFallbackReason,
        statementCount: trace.preparedSql.length,
        statements: tracedStatements(trace),
      });
    } finally {
      fixture.database.close();
    }
  });

  it("propagates malformed controls and SQLite failures without falling back", async () => {
    const query = queryFor("session", { dsl: MIXED_FILTER });
    const malformedCases = [
      {
        kind: "missing-control" as const,
        error: "analytics_event_summary_qualification_control_row_invalid",
      },
      {
        kind: "duplicate-control" as const,
        error: "analytics_event_summary_qualification_control_row_invalid",
      },
      {
        kind: "wrong-control-scope" as const,
        error: "analytics_event_summary_qualification_control_kind_mismatch",
      },
    ];
    const observations = [];
    for (const testCase of malformedCases) {
      const trace = traceFor();
      const diagnostics = createD1ReadDiagnostics();
      const env = testEnvWithControlResultBehavior(trace, testCase.kind);
      await expect(
        runPublicProviderQuery(query, trace, { diagnostics, env }),
      ).rejects.toThrow(testCase.error);
      expect(trace.preparedSql).toHaveLength(2);
      expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
      observations.push({
        kind: testCase.kind,
        expectedError: testCase.error,
        statementCount: trace.preparedSql.length,
        fallbackReason: diagnostics.advancedCountSqlFallbackReason,
        statements: tracedStatements(trace),
      });
    }

    const fixture = createIsolatedEventFixture();
    try {
      fixture.database.exec("DROP TABLE visits");
      const trace = traceFor();
      const diagnostics = createD1ReadDiagnostics();
      await expect(
        runPublicProviderQuery(query, trace, {
          diagnostics,
          database: fixture.database,
        }),
      ).rejects.toThrow("no such table: visits");
      expect(trace.preparedSql).toHaveLength(2);
      expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
      await writeEvidence("control-and-database-errors.json", {
        malformedControls: observations,
        sqliteError: "no such table: visits",
        sqliteStatementCount: trace.preparedSql.length,
        sqliteFallbackReason: diagnostics.advancedCountSqlFallbackReason,
        sqliteStatements: tracedStatements(trace),
      });
    } finally {
      fixture.database.close();
    }
  });
});
