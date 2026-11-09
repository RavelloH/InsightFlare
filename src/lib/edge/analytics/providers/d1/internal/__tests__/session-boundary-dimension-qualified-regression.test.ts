import { createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { D1_MAX_BOUND_PARAMETERS, D1_MAX_SQL_UTF8_BYTES } from "@/lib/db";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { createD1SiteProviderRegistry } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import {
  type PageRequest,
  prepareScopedQuery,
  type QueryAudience,
  type QueryInput,
  type QueryTime,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { createQueryTime } from "@/lib/edge/analytics/contract/helpers";
import { ADVANCED_FILTER_MAX_ACTIVITIES } from "@/lib/edge/analytics/engine/advanced-filter-activity-plan";
import { buildSessionBoundaryDimensionQualificationPlan } from "@/lib/edge/analytics/engine/session-boundary-dimension-qualification-plan";
import { buildSessionBoundaryOverviewPageQualificationPlan } from "@/lib/edge/analytics/engine/session-boundary-dimension-qualification-plan";
import {
  normalizeSessionBoundaryDimensionRequest,
  sessionPathCursorBinding,
} from "@/lib/edge/analytics/engine/session-path-report-plan";
import {
  d1AdvancedFilterMiddleware,
  deferredPageDimensionQualificationFromQuery,
  deferredSessionBoundaryDimensionQualificationFromQuery,
  deferredSessionBoundaryOverviewPageQualificationFromQuery,
  prepareDeferredEventQualificationFallback,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import {
  compileSessionBoundaryDimensionQualificationProgram,
  compileSessionBoundaryOverviewPageQualificationProgram,
} from "@/lib/edge/analytics/providers/d1/internal/analytics-qualification-program";
import {
  mapDimensionRows,
  mapTabs,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import {
  decodeSessionPathDimensionCursor,
  querySessionBoundaryDimensionFromD1,
  querySessionPathDimensionPageFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/dimensions";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import { encodePageCursor, paginationBindingForWindow } from "@/lib/pagination";

const SITE = "wave95j-session-boundary";
const TIME = createQueryTime(120, 130, "UTC", 500);
const WINDOW = {
  startMs: 120,
  endExclusiveMs: 130,
  nowMs: 500,
  timeZone: "UTC",
} as const;
const CURSOR_SECRET = "wave95j-session-boundary-test-secret";
const DATABASES = new Set<DatabaseSync>();
const supplementalEvidence: Array<Record<string, unknown>> = [];
const BASE_FILTER =
  'page.path neq "/excluded" and count(event { event.name eq "qualifier" }) eq 1';

type SessionPathSortKey = "views" | "sessions" | "visitors";
type SessionPathKind = "entry" | "exit";

interface BoundaryTestQuery extends QueryInput {
  readonly time: QueryTime;
  readonly mode: "breakdown" | "overview-tab";
  readonly dimension: string;
  readonly tab?: string;
  readonly page?: PageRequest;
  readonly limit?: number;
  readonly sort: {
    readonly key: SessionPathSortKey;
    readonly direction: "asc" | "desc";
  };
  readonly search: string;
}

type BreakdownTestQuery = BoundaryTestQuery & { readonly mode: "breakdown" };
type OverviewTestQuery = Omit<BoundaryTestQuery, "sort"> & {
  readonly mode: "overview-tab";
  readonly tab: string;
  readonly sort?: string;
  readonly direction?: "asc" | "desc";
  readonly cursor?: string;
};

interface BoundaryQueryOptions {
  readonly dimension?: string;
  readonly mode?: BoundaryTestQuery["mode"];
  readonly tab?: string;
  readonly limit?: number;
  readonly page?: { readonly limit?: number; readonly cursor?: string | null };
  readonly sortBy?: SessionPathSortKey;
  readonly sortDirection?: "asc" | "desc";
  readonly search?: string;
  readonly filterDsl?: string;
  readonly audience?: QueryAudience;
  readonly scopePreference?: "session" | "visitor" | "event";
}

interface TestSite {
  readonly id: string;
  readonly pk: number;
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
       VALUES (?, 'wave95j-team', 'Session boundary qualification', 'boundary.test', 0)`,
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
    readonly hostname?: string;
    readonly durationMs?: number | string;
  },
): void {
  database
    .prepare(
      `INSERT INTO visits (
        visit_id, site_id, site_pk, visitor_id, session_id, status,
        started_at, last_activity_at, pathname, hostname, duration_ms
      ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      site.id,
      site.pk,
      input.visitorId,
      input.sessionId,
      input.startedAt,
      input.startedAt,
      input.path,
      input.hostname ?? "included.test",
      input.durationMs ?? 0,
    );
}

function addEvent(
  database: DatabaseSync,
  site: TestSite,
  input: { readonly id: string; readonly visitId: string; readonly at: number },
): void {
  database
    .prepare(
      `INSERT INTO custom_event_names (id, site_id, name, last_seen_at, site_pk)
       VALUES (1, ?, 'qualifier', ?, ?) ON CONFLICT(id) DO NOTHING`,
    )
    .run(site.id, input.at, site.pk);
  database
    .prepare(
      `INSERT INTO custom_events (
        event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
        received_at, sequence, node_count, value_count
      ) VALUES (?, ?, ?, ?, 1, ?, ?, 1, 0, 0)`,
    )
    .run(input.id, site.id, site.pk, input.visitId, input.at, input.at);
}

function createFixture(): {
  readonly database: DatabaseSync;
  readonly site: TestSite;
} {
  const database = createMigratedDatabase();
  DATABASES.add(database);
  database.exec("PRAGMA foreign_keys = OFF");
  const site = addSite(database);
  const visits = [
    ["outside-low", "session-a", "visitor-a", "/outside-low", 119],
    ["session-a-entry", "session-a", "visitor-a", "/entry", 121],
    ["session-a-middle", "session-a", "visitor-a", "/middle", 124],
    ["session-a-exit", "session-a", "visitor-a", "/exit", 128],
    ["outside-high", "session-a", "visitor-a", "/outside-high", 130],
    ["host-excluded", "session-a", "visitor-a", "/excluded", 126],
    ["visitor-session-b", "session-b", "visitor-a", "/visitor-other", 126],
    ["empty-path", "session-empty-path", "visitor-b", "", 122],
    [
      "empty-path-valid",
      "session-empty-path",
      "visitor-b",
      "/empty-path-valid",
      125,
    ],
    ["space-path", "session-space-path", "visitor-d", "   ", 122],
    [
      "space-path-valid",
      "session-space-path",
      "visitor-d",
      "/whitespace-valid",
      126,
    ],
    ["empty-visitor", "session-empty-visitor", "", "/empty-visitor", 123],
    ["tie-a", "session-tie", "visitor-c", "/tie-a", 125],
    ["tie-z", "session-tie", "visitor-c", "/tie-z", 125],
    [
      "attrib-x-entry",
      "session-attrib-x",
      "visitor-attribution-shared",
      "/attrib-start-x",
      122,
    ],
    [
      "attrib-x-exit",
      "session-attrib-x",
      "visitor-attribution-exit-x",
      "/attribution-exit",
      129,
    ],
    [
      "attrib-y-entry",
      "session-attrib-y",
      "visitor-attribution-shared",
      "/attrib-start-y",
      123,
    ],
    [
      "attrib-y-exit",
      "session-attrib-y",
      "visitor-attribution-exit-y",
      "/attribution-exit",
      128,
    ],
    ["no-session", "", "visitor-a", "/no-session", 124],
  ] as const;
  for (const [id, sessionId, visitorId, path, startedAt] of visits)
    addVisit(database, site, { id, sessionId, visitorId, path, startedAt });
  database
    .prepare("UPDATE visits SET hostname = ? WHERE visit_id = ?")
    .run("excluded.test", "host-excluded");
  addEvent(database, site, {
    id: "event-session-a",
    visitId: "session-a-middle",
    at: 125,
  });
  addEvent(database, site, {
    id: "event-empty-path",
    visitId: "empty-path-valid",
    at: 126,
  });
  addEvent(database, site, {
    id: "event-space-path",
    visitId: "space-path-valid",
    at: 127,
  });
  addEvent(database, site, {
    id: "event-empty-visitor",
    visitId: "empty-visitor",
    at: 124,
  });
  addEvent(database, site, { id: "event-tie", visitId: "tie-a", at: 126 });
  addEvent(database, site, {
    id: "event-attrib-x",
    visitId: "attrib-x-entry",
    at: 123,
  });
  addEvent(database, site, {
    id: "event-attrib-y",
    visitId: "attrib-y-entry",
    at: 124,
  });
  return { database, site };
}

function createEventCandidateBoundaryFixture(options?: {
  readonly invalidateX1Duration?: boolean;
}): {
  readonly database: DatabaseSync;
  readonly site: TestSite;
} {
  const database = createMigratedDatabase();
  DATABASES.add(database);
  database.exec("PRAGMA foreign_keys = OFF");
  const site = addSite(database);
  const visits = [
    ["candidate-x0", "/x0", 121, 0],
    [
      "candidate-x1",
      "/x1",
      122,
      options?.invalidateX1Duration ? "invalid-duration" : 10,
    ],
    ["candidate-x2", "/x2", 124, "invalid-duration"],
    ["candidate-x3", "/x3", 128, 0],
  ] as const;
  for (const [id, path, startedAt, durationMs] of visits)
    addVisit(database, site, {
      id,
      sessionId: "candidate-session",
      visitorId: "candidate-visitor",
      path,
      startedAt,
      durationMs,
    });
  addEvent(database, site, {
    id: "candidate-x1-event",
    visitId: "candidate-x1",
    at: 122,
  });
  addEvent(database, site, {
    id: "candidate-x2-event",
    visitId: "candidate-x2",
    at: 124,
  });
  return { database, site };
}

type SessionBoundaryWholeBooleanKind = "or" | "not";

interface SessionBoundaryWholeBooleanFixtureRow {
  readonly id: string;
  readonly sessionId: string;
  readonly visitorId: string;
  readonly path: string;
  readonly startedAt: number;
  readonly hasQualifier: boolean;
}

const SESSION_BOUNDARY_WHOLE_BOOLEAN_FILTERS = {
  or: 'page.path eq "/native-hit" or count(event { event.name eq "qualifier" }) eq 1',
  not: 'not (page.path eq "/native-hit" and count(event { event.name eq "qualifier" }) eq 1)',
} as const satisfies Record<SessionBoundaryWholeBooleanKind, string>;

function createWholeBooleanFixture(): {
  readonly database: DatabaseSync;
  readonly rows: readonly SessionBoundaryWholeBooleanFixtureRow[];
} {
  const database = createMigratedDatabase();
  DATABASES.add(database);
  database.exec("PRAGMA foreign_keys = OFF");
  const site = addSite(database);
  const records = [
    ["native-blank", "session-native", "visitor-native", "   ", 120],
    ["native-entry", "session-native", "visitor-native", "/native-entry", 121],
    ["native-middle", "session-native", "visitor-native", "/native-hit", 124],
    ["native-exit", "session-native", "visitor-native", "/native-exit", 128],
    [
      "native-sibling-entry",
      "session-native-sibling",
      "visitor-native",
      "/native-sibling-entry",
      122,
    ],
    [
      "native-sibling-exit",
      "session-native-sibling",
      "visitor-native",
      "/native-sibling-exit",
      127,
    ],
    ["count-entry-a", "session-count", "visitor-count", "/count-entry-a", 121],
    ["count-entry-z", "session-count", "visitor-count", "/count-entry-z", 121],
    ["count-middle", "session-count", "visitor-count", "/count-middle", 124],
    ["count-exit-a", "session-count", "visitor-count", "/count-exit-a", 128],
    ["count-exit-z", "session-count", "visitor-count", "/count-exit-z", 128],
    [
      "count-sibling-entry",
      "session-count-sibling",
      "visitor-count",
      "/count-sibling-entry",
      123,
    ],
    [
      "count-sibling-exit",
      "session-count-sibling",
      "visitor-count",
      "/count-sibling-exit",
      129,
    ],
    ["both-entry", "session-both", "visitor-both", "/both-entry", 121],
    ["both-middle", "session-both", "visitor-both", "/native-hit", 124],
    ["both-exit", "session-both", "visitor-both", "/both-exit", 128],
    [
      "neither-entry",
      "session-neither",
      "visitor-neither",
      "/neither-entry",
      121,
    ],
    [
      "neither-exit",
      "session-neither",
      "visitor-neither",
      "/neither-exit",
      128,
    ],
  ] as const;
  const qualifierVisitIds = new Set(["count-middle", "both-middle"]);
  const rows = records.map(([id, sessionId, visitorId, path, startedAt]) => {
    addVisit(database, site, { id, sessionId, visitorId, path, startedAt });
    if (qualifierVisitIds.has(id))
      addEvent(database, site, {
        id: `event-${id}`,
        visitId: id,
        at: startedAt + 1,
      });
    return {
      id,
      sessionId,
      visitorId,
      path,
      startedAt,
      hasQualifier: qualifierVisitIds.has(id),
    } satisfies SessionBoundaryWholeBooleanFixtureRow;
  });
  return { database, rows };
}

function independentWholeBooleanBoundaryItems(input: {
  readonly rows: readonly SessionBoundaryWholeBooleanFixtureRow[];
  readonly scope: "session" | "visitor";
  readonly filterKind: SessionBoundaryWholeBooleanKind;
  readonly kind: SessionPathKind;
}) {
  const compareText = (left: string, right: string) =>
    left < right ? -1 : left > right ? 1 : 0;
  const ownerRows = new Map<string, SessionBoundaryWholeBooleanFixtureRow[]>();
  for (const row of input.rows) {
    const ownerId = input.scope === "session" ? row.sessionId : row.visitorId;
    const values = ownerRows.get(ownerId) ?? [];
    values.push(row);
    ownerRows.set(ownerId, values);
  }
  const selectedOwners = new Set<string>();
  for (const [ownerId, rows] of ownerRows) {
    const nativeMatch = rows.some((row) => row.path === "/native-hit");
    const countMatch = rows.filter((row) => row.hasQualifier).length === 1;
    if (
      input.filterKind === "or"
        ? nativeMatch || countMatch
        : !(nativeMatch && countMatch)
    )
      selectedOwners.add(ownerId);
  }

  const sessionPages = new Map<
    string,
    SessionBoundaryWholeBooleanFixtureRow[]
  >();
  for (const row of input.rows) {
    const ownerId = input.scope === "session" ? row.sessionId : row.visitorId;
    if (!selectedOwners.has(ownerId) || row.sessionId === "") continue;
    const normalizedPath = row.path.replace(/^ +| +$/gu, "");
    if (normalizedPath === "") continue;
    const pages = sessionPages.get(row.sessionId) ?? [];
    pages.push({ ...row, path: normalizedPath });
    sessionPages.set(row.sessionId, pages);
  }

  const boundaryValues: Array<{ value: string; visitorId: string }> = [];
  for (const pages of sessionPages.values()) {
    const ordered = [...pages].sort((left, right) =>
      left.startedAt !== right.startedAt
        ? left.startedAt - right.startedAt
        : compareText(left.id, right.id),
    );
    const first = ordered[0];
    const edge = input.kind === "entry" ? first : ordered[ordered.length - 1];
    if (!first || !edge) continue;
    boundaryValues.push({ value: edge.path, visitorId: first.visitorId });
  }

  const grouped = new Map<string, Set<string>>();
  for (const boundary of boundaryValues) {
    const visitors = grouped.get(boundary.value) ?? new Set<string>();
    if (boundary.visitorId !== "") visitors.add(boundary.visitorId);
    grouped.set(boundary.value, visitors);
  }
  return [...grouped.entries()]
    .map(([value, visitors]) => {
      const sessions = boundaryValues.filter(
        (row) => row.value === value,
      ).length;
      return {
        key: value,
        label: value,
        views: sessions,
        sessions,
        visitors: visitors.size,
      };
    })
    .sort((left, right) =>
      left.views !== right.views
        ? right.views - left.views
        : compareText(left.key, right.key),
    );
}

function testEnv(database: DatabaseSync, trace: SqliteD1Trace): Env {
  return {
    DB: createSqliteD1Database(database, trace),
    MAIN_SECRET: CURSOR_SECRET,
  } as unknown as Env;
}

interface QualificationEnvelopeCapture {
  readonly sql: string;
  readonly rows: readonly Record<string, unknown>[];
}

function testEnvWithQualificationEnvelopeCapture(
  database: DatabaseSync,
  trace: SqliteD1Trace,
  envelopes: QualificationEnvelopeCapture[],
): Env {
  const baseDatabase = createSqliteD1Database(database, trace);
  const DB = {
    prepare(sql: string) {
      const statement = baseDatabase.prepare(sql);
      const replacement = Object.create(statement) as D1PreparedStatement;
      Object.defineProperty(replacement, "bind", {
        value: (...values: SQLInputValue[]) => {
          statement.bind(...values);
          return replacement;
        },
      });
      Object.defineProperty(replacement, "all", {
        value: async () => {
          const result = await statement.all<Record<string, unknown>>();
          if (result.results.some((row) => "rowKind" in row))
            envelopes.push({ sql, rows: result.results });
          return result;
        },
      });
      return replacement;
    },
    batch: baseDatabase.batch.bind(baseDatabase),
  } as unknown as D1Database;
  return { DB, MAIN_SECRET: CURSOR_SECRET } as unknown as Env;
}

function queryFor(
  scope: "session" | "visitor",
  options?: Omit<BoundaryQueryOptions, "mode"> & {
    readonly mode?: "breakdown";
  },
): BreakdownTestQuery;
function queryFor(
  scope: "session" | "visitor",
  options: Omit<BoundaryQueryOptions, "mode"> & {
    readonly mode: "overview-tab";
    readonly tab: string;
  },
): OverviewTestQuery;
function queryFor(
  scope: "session" | "visitor",
  options: BoundaryQueryOptions = {},
): BreakdownTestQuery | OverviewTestQuery {
  const filters = parseFilterDsl(
    options.filterDsl ?? BASE_FILTER,
    analyticsFilterRegistry,
  );
  const prepared = prepareScopedQuery("dimension", {
    context: siteQueryContext(SITE, options.audience ?? "private-dashboard"),
    time: TIME,
    filters,
    scopePreference: options.scopePreference ?? scope,
  } as QueryInput & { readonly time: typeof TIME });
  const shared = {
    ...prepared,
    dimension: options.dimension ?? "session.entryPath",
    ...(options.tab !== undefined ? { tab: options.tab } : {}),
    ...(options.page !== undefined ? { page: options.page } : {}),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    search: options.search ?? "",
  };
  if (options.mode === "overview-tab") {
    if (options.tab === undefined)
      throw new Error("wave95j_overview_tab_missing");
    return {
      ...shared,
      mode: "overview-tab",
      tab: options.tab,
      sort: options.sortBy ?? "views",
      direction: options.sortDirection ?? "desc",
      cursor:
        typeof options.page?.cursor === "string" ? options.page.cursor : "",
    } as OverviewTestQuery;
  }
  return {
    ...shared,
    mode: "breakdown",
    sort: {
      key: options.sortBy ?? "views",
      direction: options.sortDirection ?? "desc",
    },
  } as BreakdownTestQuery;
}

function kindFor(query: BoundaryTestQuery): SessionPathKind {
  return query.dimension === "session.exitPath" ? "exit" : "entry";
}

function normalizedFor(query: BoundaryTestQuery) {
  return normalizeSessionBoundaryDimensionRequest({
    mode: query.mode,
    dimension: query.dimension,
    page: query.page,
    limit: query.limit,
    search: query.search,
    sort: query.sort,
    audience: query.context.policy.audience,
  });
}

function legacyLimit(query: BoundaryTestQuery): number {
  const page = query.page;
  return typeof page?.limit === "number" && Number.isFinite(page.limit)
    ? page.limit
    : typeof query.limit === "number" && Number.isFinite(query.limit)
      ? query.limit
      : 20;
}

async function legacyBoundaryFor(
  database: DatabaseSync,
  query: BoundaryTestQuery,
  trace: SqliteD1Trace,
): Promise<{
  readonly dto: { readonly items: ReturnType<typeof mapDimensionRows> };
  readonly deferred: ReturnType<
    typeof deferredSessionBoundaryDimensionQualificationFromQuery
  >;
  readonly filters: BoundaryTestQuery["filters"];
}> {
  const env = testEnv(database, trace);
  const forwarded = (await d1AdvancedFilterMiddleware(env, undefined, SITE)(
    "dimension",
    query,
    async (prepared) => prepared,
  )) as BoundaryTestQuery;
  const deferred =
    deferredSessionBoundaryDimensionQualificationFromQuery(forwarded);
  const filters = deferred
    ? await prepareDeferredEventQualificationFallback(deferred)
    : forwarded.filters;
  if (!filters) throw new Error("wave95j_legacy_filters_missing");
  const request = normalizedFor(query);
  const rows = await querySessionBoundaryDimensionFromD1(
    env,
    SITE,
    WINDOW,
    filters,
    request?.limit ?? legacyLimit(query),
    kindFor(query),
    undefined,
    typeof query.search === "string" ? query.search : undefined,
    query.sort.key,
    query.sort.direction,
  );
  return {
    dto: { items: mapDimensionRows([...rows]) },
    deferred,
    filters,
  };
}

function sessionQualificationQuery(
  query: BoundaryTestQuery,
  deferred: NonNullable<
    ReturnType<typeof deferredSessionBoundaryDimensionQualificationFromQuery>
  >,
) {
  const request = deferred.sessionBoundaryDimensionRequest;
  return {
    siteId: SITE,
    queryTime: query.time!,
    filters: query.filters!,
    ...(query.scopePlan ? { scopePlan: query.scopePlan } : {}),
    dimension: request.dimension,
    kind: request.kind,
    limit: request.limit,
    ...(request.search !== undefined ? { search: request.search } : {}),
    sortBy: request.sortBy,
    sortDirection: request.sortDirection,
    audience: request.audience,
  } as const;
}

function sessionOverviewQualificationQuery(
  query: OverviewTestQuery,
  deferred: NonNullable<
    ReturnType<typeof deferredSessionBoundaryOverviewPageQualificationFromQuery>
  >,
  cursor: Awaited<ReturnType<typeof decodeSessionPathDimensionCursor>>,
) {
  const request = deferred.sessionBoundaryOverviewPageRequest;
  return {
    siteId: SITE,
    queryTime: query.time!,
    filters: query.filters!,
    ...(query.scopePlan ? { scopePlan: query.scopePlan } : {}),
    mode: request.mode,
    tab: request.tab,
    dimension: request.dimension,
    kind: request.kind,
    limit: request.limit,
    cursor,
    cursorToken: request.cursorToken,
    ...(request.search !== undefined ? { search: request.search } : {}),
    sortBy: request.sortBy,
    sortDirection: request.sortDirection,
    audience: request.audience,
  } as const;
}

async function runActual(
  database: DatabaseSync,
  query: BreakdownTestQuery,
  trace: SqliteD1Trace,
  diagnostics = createD1ReadDiagnostics(),
  envelopes?: QualificationEnvelopeCapture[],
) {
  const provider = createD1SiteProviderRegistry({
    env: envelopes
      ? testEnvWithQualificationEnvelopeCapture(database, trace, envelopes)
      : testEnv(database, trace),
    siteId: SITE,
    diagnostics,
  }).resolve("dimension");
  if (!provider) throw new Error("wave95j_dimension_provider_missing");
  const execution = await provider.execute(query);
  if (!("items" in execution.value))
    throw new Error("wave95j_dimension_result_shape_invalid");
  return {
    result: {
      value: {
        items: execution.value.items as ReturnType<typeof mapDimensionRows>,
      },
    },
    diagnostics,
  };
}

async function legacyOverviewPageFor(
  database: DatabaseSync,
  query: OverviewTestQuery,
  trace: SqliteD1Trace,
) {
  const env = testEnv(database, trace);
  const forwarded = (await d1AdvancedFilterMiddleware(env, undefined, SITE)(
    "dimension",
    query,
    async (prepared) => prepared,
  )) as OverviewTestQuery;
  const deferred =
    deferredSessionBoundaryOverviewPageQualificationFromQuery(forwarded);
  const filters = deferred
    ? await prepareDeferredEventQualificationFallback(deferred)
    : forwarded.filters;
  if (!filters) throw new Error("wave95t_legacy_overview_filters_missing");
  const kind = query.tab === "page.exit" ? "exit" : "entry";
  const limit =
    typeof query.limit === "number" && Number.isFinite(query.limit)
      ? query.limit
      : 100;
  const search = query.search || undefined;
  const sortBy =
    query.sort === "sessions" || query.sort === "visitors"
      ? query.sort
      : "views";
  const sortDirection = query.direction === "asc" ? "asc" : "desc";
  const cursorToken = query.cursor || null;
  const audience = query.context.policy.audience;
  const cursor = await decodeSessionPathDimensionCursor(
    env,
    SITE,
    WINDOW,
    filters,
    kind,
    search,
    cursorToken,
    audience,
    sortBy,
    sortDirection,
  );
  if (cursorToken && !cursor)
    throw new Error("wave95t_legacy_overview_cursor_invalid");
  const page = await querySessionPathDimensionPageFromD1(
    env,
    SITE,
    WINDOW,
    filters,
    limit,
    kind,
    undefined,
    search,
    cursor,
    audience,
    sortBy,
    sortDirection,
  );
  return {
    dto: {
      data: {
        items: mapTabs([...page.items]),
        pagination: page.pagination,
      },
    },
    deferred,
    filters,
  };
}

async function runOverviewActual(
  database: DatabaseSync,
  query: OverviewTestQuery,
  trace: SqliteD1Trace,
  diagnostics = createD1ReadDiagnostics(),
  envelopes?: QualificationEnvelopeCapture[],
) {
  const provider = createD1SiteProviderRegistry({
    env: envelopes
      ? testEnvWithQualificationEnvelopeCapture(database, trace, envelopes)
      : testEnv(database, trace),
    siteId: SITE,
    diagnostics,
  }).resolve("dimension");
  if (!provider) throw new Error("wave95t_overview_dimension_provider_missing");
  const execution = await provider.execute(query);
  if (!("data" in execution.value))
    throw new Error("wave95t_overview_result_shape_invalid");
  return { result: execution.value, diagnostics };
}

function testEnvWithControlBehavior(
  database: DatabaseSync,
  trace: SqliteD1Trace,
  behavior:
    | "missing-control"
    | "duplicate-control"
    | "wrong-control-scope"
    | "null-activity-proof"
    | "site-identity-proof",
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
          const result = await originalAll<Record<string, unknown>>();
          const control = result.results.find(
            (row) => row.rowKind === "control",
          );
          if (behavior === "missing-control")
            return {
              ...result,
              results: result.results.filter(
                (row) => row.rowKind !== "control",
              ),
            };
          if (behavior === "duplicate-control" && control)
            return { ...result, results: [...result.results, control] };
          if (behavior === "wrong-control-scope")
            return {
              ...result,
              results: result.results.map((row) =>
                row.rowKind === "control"
                  ? { ...row, entityKind: "visitor" }
                  : row,
              ),
            };
          if (behavior === "null-activity-proof")
            return {
              ...result,
              results: result.results
                .filter((row) => row.rowKind === "control")
                .map((row) =>
                  row.rowKind === "control"
                    ? { ...row, nullActivityIdCount: 1 }
                    : row,
                ),
            };
          if (behavior === "site-identity-proof")
            return {
              ...result,
              results: result.results
                .filter((row) => row.rowKind === "control")
                .map((row) =>
                  row.rowKind === "control"
                    ? { ...row, siteIdentityMismatchCount: 1 }
                    : row,
                ),
            };
          return result;
        },
      });
      return replacement;
    },
  } as unknown as D1Database;
  return { DB, MAIN_SECRET: CURSOR_SECRET } as unknown as Env;
}

function testEnvWithSqliteFailure(
  database: DatabaseSync,
  trace: SqliteD1Trace,
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
      Object.defineProperty(replacement, "all", {
        value: async () => {
          throw new Error("wave95j_sqlite_report_failure");
        },
      });
      return replacement;
    },
  } as unknown as D1Database;
  return { DB, MAIN_SECRET: CURSOR_SECRET } as unknown as Env;
}

function testEnvWithMalformedOverviewReport(
  database: DatabaseSync,
  trace: SqliteD1Trace,
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
          const result = await originalAll<Record<string, unknown>>();
          return {
            ...result,
            results: result.results.map((row) =>
              row.rowKind === "report" ? { ...row, value: null } : row,
            ),
          };
        },
      });
      return replacement;
    },
  } as unknown as D1Database;
  return { DB, MAIN_SECRET: CURSOR_SECRET } as unknown as Env;
}

function recordEvidence(kind: string, evidence: Record<string, unknown>): void {
  supplementalEvidence.push({ kind, ...evidence });
}

afterEach(() => {
  for (const database of DATABASES) database.close();
  DATABASES.clear();
});

afterAll(async () => {
  const artifactDirs = [
    process.env.WAVE95J_ARTIFACT_DIR
      ? {
          directory: process.env.WAVE95J_ARTIFACT_DIR,
          name: "session-boundary-regression-evidence.json",
        }
      : undefined,
    process.env.WAVE95T_ARTIFACT_DIR
      ? {
          directory: process.env.WAVE95T_ARTIFACT_DIR,
          name: "overview-session-page-regression-evidence.json",
        }
      : undefined,
    process.env.WAVE97DI_ARTIFACT_DIR
      ? {
          directory: process.env.WAVE97DI_ARTIFACT_DIR,
          name: "private-session-boundary-whole-boolean-evidence.json",
        }
      : undefined,
  ].filter((entry): entry is { directory: string; name: string } => !!entry);
  if (artifactDirs.length === 0) return;
  const { mkdir, writeFile } = await import("node:fs/promises");
  for (const artifact of artifactDirs) {
    await mkdir(artifact.directory, { recursive: true });
    await writeFile(
      `${artifact.directory}/${artifact.name}`,
      JSON.stringify(supplementalEvidence, null, 2),
      "utf8",
    );
  }
});

describe("qualified Session boundary dimension", () => {
  it("selects Event-matched visits before applying session entry and exit boundaries", async () => {
    const { database } = createEventCandidateBoundaryFixture();
    const filterDsl =
      '(page.path eq "/x1" or page.path eq "/x2") and count(event { event.name eq "qualifier" }) gte 1';

    for (const kind of ["entry", "exit"] as const) {
      const dimension =
        kind === "entry" ? "session.entryPath" : "session.exitPath";
      const query = queryFor("session", {
        dimension,
        filterDsl,
        scopePreference: "event",
      });
      const legacy = await legacyBoundaryFor(database, query, traceFor());
      const deferred = legacy.deferred;
      expect(deferred?.countInput.scope).toBe("event");
      expect(
        deferred && "eventCandidateReportProjection" in deferred
          ? deferred.eventCandidateReportProjection
          : undefined,
      ).toBe("page-visits");
      const actual = await runActual(database, query, traceFor());
      expect(actual.result.value).toEqual(legacy.dto);
      expect(actual.result.value.items.map((row) => row.key)).toEqual([
        kind === "entry" ? "/x1" : "/x2",
      ]);
    }

    for (const kind of ["entry", "exit"] as const) {
      const query = queryFor("session", {
        mode: "overview-tab",
        tab: kind === "entry" ? "page.entry" : "page.exit",
        limit: 20,
        filterDsl,
        scopePreference: "event",
      }) as OverviewTestQuery;
      const legacy = await legacyOverviewPageFor(database, query, traceFor());
      expect(legacy.deferred?.countInput.scope).toBe("event");
      const actual = await runOverviewActual(database, query, traceFor());
      expect(actual.result).toEqual(legacy.dto);
      expect(actual.result.data.items.map((row) => row.label)).toEqual([
        kind === "entry" ? "/x1" : "/x2",
      ]);
    }
  });

  it("falls back the complete Event candidate boundary report on numeric incompatibility", async () => {
    const { database } = createEventCandidateBoundaryFixture({
      invalidateX1Duration: true,
    });
    const query = queryFor("session", {
      dimension: "session.entryPath",
      scopePreference: "event",
      filterDsl:
        '(page.path eq "/x1" or page.path eq "/x2") and count(event { event.name eq "qualifier" }) gte 1 and count(page { page.durationMs gt 5 }) eq 1',
    });
    const legacyTrace = traceFor();
    const legacy = await legacyBoundaryFor(database, query, legacyTrace);
    expect(
      legacy.deferred?.countInput.numericCompatibilityRequirements,
    ).not.toHaveLength(0);
    const diagnostics = createD1ReadDiagnostics();
    const runtimeTrace = traceFor();
    const actual = await runActual(database, query, runtimeTrace, diagnostics);

    expect(actual.result.value).toEqual(legacy.dto);
    expect(actual.result.value.items.map((row) => row.key)).toEqual([]);
    expect(diagnostics.advancedCountSqlFallbackReason).toMatchObject({
      kind: "numeric-data-domain",
    });
    expect(runtimeTrace.preparedSql.length).toBeGreaterThan(2);
  });

  it("binds the Event Page Source for a non-empty boundary DTO after numeric refusal", async () => {
    const { database } = createEventCandidateBoundaryFixture();
    const query = queryFor("session", {
      dimension: "session.entryPath",
      scopePreference: "event",
      filterDsl:
        '(page.path eq "/x1" or page.path eq "/x2") and count(event { event.name eq "qualifier" }) gte 1 and count(page { page.durationMs gt 5 }) eq 1',
    });
    const legacy = await legacyBoundaryFor(database, query, traceFor());
    expect(legacy.dto.items.map((row) => row.key)).toEqual(["/x1"]);
    const diagnostics = createD1ReadDiagnostics();
    const runtimeTrace = traceFor();
    const actual = await runActual(database, query, runtimeTrace, diagnostics);

    expect(actual.result.value).toEqual(legacy.dto);
    expect(actual.result.value.items.map((row) => row.key)).toEqual(["/x1"]);
    expect(diagnostics.advancedCountSqlFallbackReason).toMatchObject({
      kind: "numeric-data-domain",
    });
    expect(runtimeTrace.preparedSql.at(-1)).toMatch(/\bvisit_id\b/i);
    expect(runtimeTrace.preparedSql.at(-1)).not.toMatch(/\bentity_id\b/i);
  });

  it.each(
    (["entry", "exit"] as const).flatMap((kind) =>
      (["session", "visitor"] as const).map((scope) => ({ kind, scope })),
    ),
  )(
    "matches the independent legacy Count preparation and boundary report for $kind/$scope",
    async ({ kind, scope }) => {
      const { database } = createFixture();
      const query = queryFor(scope, {
        dimension: kind === "entry" ? "session.entryPath" : "session.exitPath",
      });
      const oldTrace = traceFor();
      const legacy = await legacyBoundaryFor(database, query, oldTrace);
      expect(legacy.deferred).toBeDefined();
      if (!legacy.deferred)
        throw new Error("wave95j_session_boundary_deferred_missing");
      const request = sessionQualificationQuery(query, legacy.deferred);
      const compiled = compileSessionBoundaryDimensionQualificationProgram({
        deferred: legacy.deferred,
        query: request,
      });
      expect(compiled.kind).toBe("compiled");
      if (compiled.kind !== "compiled")
        throw new Error("wave95j_session_boundary_compile_unavailable");

      const runtimeTrace = traceFor();
      const { result } = await runActual(database, query, runtimeTrace);
      expect(result.value).toEqual(legacy.dto);
      expect(result.value).not.toHaveProperty("pagination");
      expect(runtimeTrace.preparedSql).toHaveLength(2);
      expect(runtimeTrace.preparedSql[1]).toBe(compiled.evidence.sql);
      const values = result.value.items.map((row) => row.key);
      expect(values).not.toContain("/outside-low");
      expect(values).not.toContain("/outside-high");
      expect(values).not.toContain("/excluded");
      expect(values).not.toContain("/no-session");
      if (scope === "visitor") expect(values).toContain("/visitor-other");
      if (kind === "entry") expect(values).toContain("/empty-path-valid");
      if (kind === "exit" && scope === "session")
        expect(values).toContain("/attribution-exit");
      if (kind === "entry") expect(values).toContain("/tie-a");
      if (kind === "exit") expect(values).toContain("/tie-z");
      const logicalPlan = buildSessionBoundaryDimensionQualificationPlan({
        siteId: request.siteId,
        queryTime: request.queryTime,
        filters: request.filters,
        scopePlan: request.scopePlan ?? legacy.deferred.metadata.plan,
        count: legacy.deferred.countInput,
        kind: request.kind,
        limit: request.limit,
        ...(request.search !== undefined ? { search: request.search } : {}),
        sortBy: request.sortBy,
        sortDirection: request.sortDirection,
      });
      const logicalGraph = JSON.stringify(logicalPlan.plan, null, 2);
      const compiledPhysicalGraph = JSON.stringify({
        sql: compiled.evidence.sql,
        bindings: compiled.evidence.bindings,
      });
      recordEvidence("legacy-equivalence", {
        kind,
        scope,
        legacyDto: legacy.dto,
        actualDto: result.value,
        compileEvidence: {
          ...compiled.evidence,
          sqlSha256: createHash("sha256")
            .update(compiled.evidence.sql)
            .digest("hex"),
          logicalGraphSha256: createHash("sha256")
            .update(logicalGraph, "utf8")
            .digest("hex"),
          compiledPhysicalGraphSha256: createHash("sha256")
            .update(compiledPhysicalGraph, "utf8")
            .digest("hex"),
        },
        qualificationPlan: {
          primaryReportSourceRelationId:
            logicalPlan.primaryReportSourceRelationId,
          matchesRelationId: logicalPlan.matchesRelationId,
          controlsRelationId: logicalPlan.controlsRelationId,
          groupedSummaryRelationId: logicalPlan.groupedSummaryRelationId,
          controlOutputId: logicalPlan.controlOutputId,
          reportOutputIds: logicalPlan.reportOutputIds,
          reportSourceRelations: logicalPlan.reportSourceRelations,
        },
        oldStatementCount: oldTrace.preparedSql.length,
        runtimeStatements: runtimeTrace.preparedSql,
        sourceBoundary:
          "The report Source is limited to [120, 130); source rows at 119 and 130 are excluded.",
      });
    },
  );

  it.each(
    (["entry", "exit"] as const).flatMap((kind) =>
      (["session", "visitor"] as const).map((scope) => ({ kind, scope })),
    ),
  )(
    "compiles the default overview-page report and preserves the old DTO for $kind/$scope",
    async ({ kind, scope }) => {
      const { database } = createFixture();
      const tab = kind === "entry" ? "page.entry" : "page.exit";
      const query = queryFor(scope, {
        mode: "overview-tab",
        tab,
      }) as OverviewTestQuery;
      const compileTrace = traceFor();
      const env = testEnv(database, compileTrace);
      const forwarded = (await d1AdvancedFilterMiddleware(env, undefined, SITE)(
        "dimension",
        query,
        async (prepared) => prepared,
      )) as OverviewTestQuery;
      const deferred =
        deferredSessionBoundaryOverviewPageQualificationFromQuery(forwarded);
      expect(deferred).toBeDefined();
      if (!deferred)
        throw new Error("wave95t_default_overview_deferred_missing");
      const compileQuery = sessionOverviewQualificationQuery(
        query,
        deferred,
        null,
      );
      const compiled = compileSessionBoundaryOverviewPageQualificationProgram({
        deferred,
        query: compileQuery,
      });
      expect(compiled.kind).toBe("compiled");
      if (compiled.kind !== "compiled")
        throw new Error("wave95t_default_overview_compile_unavailable");
      const prepared = deferred.sessionBoundaryOverviewPageRequest;
      const logical = buildSessionBoundaryOverviewPageQualificationPlan({
        siteId: SITE,
        queryTime: query.time,
        filters: query.filters!,
        scopePlan: query.scopePlan ?? deferred.metadata.plan,
        count: deferred.countInput,
        kind: prepared.kind,
        limit: prepared.limit,
        ...(prepared.search !== undefined ? { search: prepared.search } : {}),
        sortBy: prepared.sortBy,
        sortDirection: prepared.sortDirection,
        cursor: null,
      });
      const legacyTrace = traceFor();
      const legacy = await legacyOverviewPageFor(database, query, legacyTrace);
      const runtimeTrace = traceFor();
      const actual = await runOverviewActual(database, query, runtimeTrace);
      expect(actual.result).toEqual(legacy.dto);
      expect(actual.result.data.pagination.limit).toBe(100);
      expect(runtimeTrace.preparedSql).toHaveLength(2);
      expect(runtimeTrace.preparedSql[1]).toBe(compiled.evidence.sql);
      expect(runtimeTrace.bindings[1]).toEqual(compiled.evidence.bindings);
      recordEvidence("overview-page-default-compile", {
        kind,
        scope,
        actualDto: actual.result,
        legacyDto: legacy.dto,
        compileEvidence: {
          ...compiled.evidence,
          sqlSha256: createHash("sha256")
            .update(compiled.evidence.sql)
            .digest("hex"),
          logicalGraphSha256: createHash("sha256")
            .update(JSON.stringify(logical.plan, null, 2), "utf8")
            .digest("hex"),
          reportOutputIds: logical.reportOutputIds,
          primaryReportSourceRelationId: logical.primaryReportSourceRelationId,
          matchesRelationId: logical.matchesRelationId,
          controlsRelationId: logical.controlsRelationId,
          groupedSummaryRelationId: logical.groupedSummaryRelationId,
          controlOutputId: logical.controlOutputId,
          reportSourceRelations: logical.reportSourceRelations,
        },
        runtimeStatements: runtimeTrace.preparedSql,
        runtimeBindings: runtimeTrace.bindings,
        preparationStatements: compileTrace.preparedSql,
      });
    },
  );

  it.each(
    (["entry", "exit"] as const).flatMap((kind) =>
      (["session", "visitor"] as const).flatMap((scope) =>
        (["views", "sessions", "visitors"] as const).flatMap((sortBy) =>
          (["asc", "desc"] as const).map((sortDirection) => ({
            kind,
            scope,
            sortBy,
            sortDirection,
          })),
        ),
      ),
    ),
  )(
    "preserves the independent full overview cursor chain for $kind/$scope/$sortBy/$sortDirection",
    async ({ kind, scope, sortBy, sortDirection }) => {
      const { database } = createFixture();
      const tab = kind === "entry" ? "page.entry" : "page.exit";
      let cursor: string | null = null;
      let completed = false;
      const actualItems: string[] = [];
      const legacyItems: string[] = [];
      const pageEvidence: Array<Record<string, unknown>> = [];
      for (let pageIndex = 0; pageIndex < 12; pageIndex += 1) {
        const query = queryFor(scope, {
          mode: "overview-tab",
          tab,
          limit: 1,
          page: { cursor },
          sortBy,
          sortDirection,
        }) as OverviewTestQuery;
        const legacyTrace = traceFor();
        const legacy = await legacyOverviewPageFor(
          database,
          query,
          legacyTrace,
        );
        expect(legacy.deferred).toBeDefined();
        const runtimeTrace = traceFor();
        const actual = await runOverviewActual(database, query, runtimeTrace);
        expect(actual.result).toEqual(legacy.dto);
        expect(runtimeTrace.preparedSql).toHaveLength(2);
        expect(actual.result.data.pagination.limit).toBe(1);
        const actualPageKeys = actual.result.data.items.map(
          (item) => item.label ?? "",
        );
        const legacyPageKeys = legacy.dto.data.items.map(
          (item) => item.label ?? "",
        );
        actualItems.push(...actualPageKeys);
        legacyItems.push(...legacyPageKeys);
        pageEvidence.push({
          pageIndex,
          cursorToken: cursor,
          items: actualPageKeys,
          nextCursor: actual.result.data.pagination.nextCursor,
          statementCount: runtimeTrace.preparedSql.length,
        });
        const nextCursor = actual.result.data.pagination.nextCursor;
        if (nextCursor === null) {
          completed = true;
          break;
        }
        expect(nextCursor).toBe(legacy.dto.data.pagination.nextCursor);
        if (pageIndex === 0) {
          const oldCursor = await decodeSessionPathDimensionCursor(
            testEnv(database, traceFor()),
            SITE,
            WINDOW,
            legacy.filters,
            kind,
            undefined,
            nextCursor,
            query.context.policy.audience,
            sortBy,
            sortDirection,
          );
          expect(oldCursor).not.toBeNull();
          if (sortBy === "visitors") {
            expect(oldCursor?.visitors).toBe(
              actual.result.data.items[0]?.visitors,
            );
            expect(oldCursor?.views).toBe(actual.result.data.items[0]?.views);
          } else {
            expect(oldCursor?.visitors).toBeUndefined();
            expect(oldCursor?.views).toBe(
              sortBy === "sessions"
                ? actual.result.data.items[0]?.sessions
                : actual.result.data.items[0]?.views,
            );
          }
        }
        cursor = nextCursor;
      }
      expect(completed).toBe(true);
      expect(actualItems).toEqual(legacyItems);
      expect(new Set(actualItems).size).toBe(actualItems.length);
      const fullLegacy = await legacyOverviewPageFor(
        database,
        queryFor(scope, {
          mode: "overview-tab",
          tab,
          limit: 100,
          sortBy,
          sortDirection,
        }) as OverviewTestQuery,
        traceFor(),
      );
      expect(actualItems).toEqual(
        fullLegacy.dto.data.items.map((item) => item.label ?? ""),
      );
      recordEvidence("overview-page-full-cursor-chain", {
        kind,
        scope,
        sortBy,
        sortDirection,
        actualItems,
        legacyItems,
        pages: pageEvidence,
      });
    },
  );

  it.each(
    (["entry", "exit"] as const).flatMap((kind) =>
      (["session", "visitor"] as const).flatMap((scope) =>
        ([" ENTRY ", " ", "no-such-session-path"] as const).map((search) => ({
          kind,
          scope,
          search,
        })),
      ),
    ),
  )(
    "preserves overview search normalization for $kind/$scope search $search",
    async ({ kind, scope, search }) => {
      const { database } = createFixture();
      const query = queryFor(scope, {
        mode: "overview-tab",
        tab: kind === "entry" ? "page.entry" : "page.exit",
        limit: 3,
        search,
      }) as OverviewTestQuery;
      const legacy = await legacyOverviewPageFor(database, query, traceFor());
      const trace = traceFor();
      const actual = await runOverviewActual(database, query, trace);
      expect(actual.result).toEqual(legacy.dto);
      expect(trace.preparedSql).toHaveLength(2);
      if (search === "no-such-session-path")
        expect(actual.result.data.items).toEqual([]);
      recordEvidence("overview-page-search-compatibility", {
        kind,
        scope,
        search,
        legacyDto: legacy.dto,
        actualDto: actual.result,
        statementCount: trace.preparedSql.length,
      });
    },
  );

  it("keeps exit visitor attribution on the entry Page row, including shared visitor ties", async () => {
    const { database } = createFixture();
    const query = queryFor("session", { dimension: "session.exitPath" });
    const oldTrace = traceFor();
    const legacy = await legacyBoundaryFor(database, query, oldTrace);
    const runtimeTrace = traceFor();
    const { result } = await runActual(database, query, runtimeTrace);
    expect(result.value).toEqual(legacy.dto);
    const attribution = result.value.items.find(
      (row) => row.key === "/attribution-exit",
    );
    expect(attribution).toMatchObject({ sessions: 2, visitors: 1 });
    // Legacy selectedSessionBoundaryPair projects each exit path with its entry-side visitor ID.
    recordEvidence("exit-entry-side-visitor-compatibility", {
      output: attribution,
      observedLegacyRule:
        "Two exit rows with distinct exit-side visitor IDs collapse to one visitor because both entry Pages share one visitor ID.",
    });
  });

  it.each(
    (["entry", "exit"] as const).flatMap((kind) =>
      (["session", "visitor"] as const).flatMap((scope) =>
        (["views", "sessions", "visitors"] as const).flatMap((sortBy) =>
          (["asc", "desc"] as const).map((sortDirection) => ({
            kind,
            scope,
            sortBy,
            sortDirection,
          })),
        ),
      ),
    ),
  )(
    "preserves $kind/$scope Top-N ordering by $sortBy/$sortDirection and ignores cursors",
    async ({ kind, scope, sortBy, sortDirection }) => {
      const { database } = createFixture();
      const query = queryFor(scope, {
        dimension: kind === "entry" ? "session.entryPath" : "session.exitPath",
        page: { limit: 3, cursor: "ignored-invalid-cursor" },
        limit: 1,
        sortBy,
        sortDirection,
      });
      const oldTrace = traceFor();
      const legacy = await legacyBoundaryFor(database, query, oldTrace);
      const runtimeTrace = traceFor();
      const { result } = await runActual(database, query, runtimeTrace);
      expect(result.value).toEqual(legacy.dto);
      expect(result.value.items).toHaveLength(legacy.dto.items.length);
      expect(result.value).not.toHaveProperty("pagination");
    },
  );

  it.each(
    (["entry", "exit"] as const).flatMap((kind) =>
      (["session", "visitor"] as const).flatMap((scope) =>
        (
          [
            { page: { limit: 1, cursor: "ignored" }, limit: 3 },
            { page: {} },
            { page: { limit: 100 }, limit: 2 },
          ] as const
        ).map((options) => ({ kind, scope, options })),
      ),
    ),
  )(
    "keeps $kind/$scope limit precedence for $options",
    async ({ kind, scope, options: rawOptions }) => {
      const options = rawOptions as {
        readonly page: { readonly limit?: number; readonly cursor?: string };
        readonly limit?: number;
      };
      const dimension =
        kind === "entry" ? "session.entryPath" : "session.exitPath";
      const { database } = createFixture();
      const query = queryFor(scope, { dimension, ...options });
      const legacy = await legacyBoundaryFor(database, query, traceFor());
      const actual = await runActual(database, query, traceFor());
      expect(actual.result.value).toEqual(legacy.dto);
      if (options.page.limit === 1)
        expect(actual.result.value.items).toHaveLength(1);
      if (options.page.limit === undefined && options.limit === undefined)
        expect(normalizedFor(query)?.limit).toBe(20);
      if (options.page.limit === 100)
        expect(actual.result.value.items.length).toBeGreaterThan(1);
    },
  );

  it.each(
    (["entry", "exit"] as const).flatMap((kind) =>
      (["session", "visitor"] as const).flatMap((scope) =>
        ([" ENTRY ", " ", "no-such-path"] as const).map((search) => ({
          kind,
          scope,
          search,
        })),
      ),
    ),
  )(
    "preserves $kind/$scope raw search behavior for $search",
    async ({ kind, scope, search }) => {
      const dimension =
        kind === "entry" ? "session.entryPath" : "session.exitPath";
      const { database } = createFixture();
      const query = queryFor(scope, { dimension, search });
      const legacy = await legacyBoundaryFor(database, query, traceFor());
      const actual = await runActual(database, query, traceFor());
      expect(actual.result.value).toEqual(legacy.dto);
      if (search === "no-such-path")
        expect(actual.result.value.items).toEqual([]);
    },
  );

  it.each(
    (["entry", "exit"] as const).flatMap((kind) =>
      (["session", "visitor"] as const).map((scope) => ({ kind, scope })),
    ),
  )(
    "preserves $kind/$scope empty-filter result behavior",
    async ({ kind, scope }) => {
      const dimension =
        kind === "entry" ? "session.entryPath" : "session.exitPath";
      const { database } = createFixture();
      const emptyQuery = queryFor(scope, {
        dimension,
        filterDsl:
          'page.path neq "/excluded" and count(event { event.name eq "absent" }) eq 1',
      });
      const emptyLegacy = await legacyBoundaryFor(
        database,
        emptyQuery,
        traceFor(),
      );
      const emptyActual = await runActual(database, emptyQuery, traceFor());
      expect(emptyActual.result.value).toEqual(emptyLegacy.dto);
      expect(emptyActual.result.value.items).toEqual([]);
    },
  );

  it("keeps invalid limits and unsupported dimensions outside the boundary brand", async () => {
    for (const query of [queryFor("session", { page: { limit: 0 } })]) {
      const { database } = createFixture();
      const oldTrace = traceFor();
      const legacy = await legacyBoundaryFor(database, query, oldTrace);
      expect(legacy.deferred).toBeUndefined();
      const actual = await runActual(database, query, traceFor());
      expect(actual.result.value).toEqual(legacy.dto);
    }

    expect(
      normalizeSessionBoundaryDimensionRequest({
        mode: "overview-tab",
        dimension: "session.entryPath",
        audience: "private-dashboard",
      }),
    ).toBeNull();
    expect(
      normalizeSessionBoundaryDimensionRequest({
        dimension: "session.unknown",
        audience: "private-dashboard",
      }),
    ).toBeNull();
    const { database } = createFixture();
    const invalidKind = queryFor("session", { dimension: "session.unknown" });
    const trace = traceFor();
    const env = testEnv(database, trace);
    const forwarded = await d1AdvancedFilterMiddleware(env, undefined, SITE)(
      "dimension",
      invalidKind,
      async (prepared) => prepared,
    );
    expect(
      deferredSessionBoundaryDimensionQualificationFromQuery(forwarded),
    ).toBeUndefined();
    const invalidKindProvider = createD1SiteProviderRegistry({
      env,
      siteId: SITE,
    }).resolve("dimension");
    if (!invalidKindProvider)
      throw new Error("wave95j_invalid_kind_provider_missing");
    await expect(invalidKindProvider.execute(invalidKind)).rejects.toThrow(
      "unsupported-dimension:session.unknown",
    );

    const overviewQuery = queryFor("session", {
      mode: "overview-tab",
      tab: "page.entry",
      limit: 2,
    });
    const overviewProvider = createD1SiteProviderRegistry({
      env: testEnv(database, traceFor()),
      siteId: SITE,
    }).resolve("dimension");
    if (!overviewProvider) throw new Error("wave95j_overview_provider_missing");
    const overview = await overviewProvider.execute(overviewQuery);
    if (!("data" in overview.value))
      throw new Error("wave95j_overview_result_shape_invalid");
    expect(overview.value).toHaveProperty("data.pagination.limit", 2);
    expect(overview.value).not.toHaveProperty("pagination");
  });

  it("rejects wrong-brand, wrong-site, and pre-aborted requests before report SQL", async () => {
    const { database } = createFixture();
    const boundaryQuery = queryFor("session");
    const trace = traceFor();
    const env = testEnv(database, trace);
    const forwarded = await d1AdvancedFilterMiddleware(env, undefined, SITE)(
      "dimension",
      boundaryQuery,
      async (prepared) => prepared,
    );
    const deferred =
      deferredSessionBoundaryDimensionQualificationFromQuery(forwarded);
    if (!deferred) throw new Error("wave95j_session_boundary_proof_missing");
    const pageQuery = queryFor("session", { dimension: "geo.country" });
    const pageForwarded = await d1AdvancedFilterMiddleware(
      env,
      undefined,
      SITE,
    )("dimension", pageQuery, async (prepared) => prepared);
    const pageDeferred =
      deferredPageDimensionQualificationFromQuery(pageForwarded);
    if (!pageDeferred) throw new Error("wave95j_page_proof_missing");
    const beforeWrongBrand = trace.preparedSql.length;
    expect(() =>
      compileSessionBoundaryDimensionQualificationProgram({
        deferred: pageDeferred as never,
        query: sessionQualificationQuery(boundaryQuery, deferred),
      }),
    ).toThrow("analytics_event_qualification_request_mismatch");
    expect(trace.preparedSql).toHaveLength(beforeWrongBrand);

    const validQuery = sessionQualificationQuery(boundaryQuery, deferred);
    const mismatches = [
      { ...validQuery, siteId: `${SITE}-other` },
      {
        ...validQuery,
        queryTime: { ...validQuery.queryTime, capturedAtMs: 501 },
      },
      {
        ...validQuery,
        queryTime: {
          ...validQuery.queryTime,
          readRange: { startMs: 119, endExclusiveMs: 130 },
        },
      },
      { ...validQuery, kind: "exit" },
      { ...validQuery, dimension: "session.exitPath" },
      { ...validQuery, limit: validQuery.limit + 1 },
      { ...validQuery, sortBy: "sessions" },
      { ...validQuery, sortDirection: "asc" },
      { ...validQuery, search: "different-search" },
      { ...validQuery, audience: "public-report" },
      {
        ...validQuery,
        scopePlan: { ...(validQuery.scopePlan ?? {}), scope: "visitor" },
      },
    ];
    for (const mismatch of mismatches) {
      expect(() =>
        compileSessionBoundaryDimensionQualificationProgram({
          deferred,
          query: mismatch as never,
        }),
      ).toThrow();
    }
    expect(trace.preparedSql).toHaveLength(beforeWrongBrand);

    const wrongSiteTrace = traceFor();
    const wrongSiteProvider = createD1SiteProviderRegistry({
      env: testEnv(database, wrongSiteTrace),
      siteId: `${SITE}-wrong`,
    }).resolve("dimension");
    if (!wrongSiteProvider)
      throw new Error("wave95j_wrong_site_provider_missing");
    await expect(wrongSiteProvider.execute(boundaryQuery)).rejects.toThrow();
    expect(wrongSiteTrace.preparedSql).toHaveLength(0);

    const abortTrace = traceFor();
    const abortProvider = createD1SiteProviderRegistry({
      env: testEnv(database, abortTrace),
      siteId: SITE,
    }).resolve("dimension");
    if (!abortProvider) throw new Error("wave95j_abort_provider_missing");
    const controller = new AbortController();
    controller.abort();
    await expect(
      abortProvider.execute(boundaryQuery, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(abortTrace.preparedSql).toHaveLength(0);
  });

  it("falls back once for actual numeric incompatibility and preserves the legacy DTO", async () => {
    const { database } = createFixture();
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run(10, "session-a-entry");
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "session-a-middle");
    const query = queryFor("session", {
      filterDsl:
        'page.path neq "/excluded" and count(event { event.name eq "qualifier" }) eq 1 and count(page { page.durationMs gt 5 }) eq 1',
    });
    const oldTrace = traceFor();
    const legacy = await legacyBoundaryFor(database, query, oldTrace);
    if (!legacy.deferred) throw new Error("wave95j_numeric_proof_missing");
    const compiled = compileSessionBoundaryDimensionQualificationProgram({
      deferred: legacy.deferred,
      query: sessionQualificationQuery(query, legacy.deferred),
    });
    expect(compiled.kind).toBe("compiled");
    if (compiled.kind !== "compiled")
      throw new Error("wave95j_numeric_compile_unavailable");
    const runtimeTrace = traceFor();
    const diagnostics = createD1ReadDiagnostics();
    const actual = await runActual(database, query, runtimeTrace, diagnostics);
    expect(actual.result.value).toEqual(legacy.dto);
    expect(diagnostics.advancedCountSqlFallbackReason).toMatchObject({
      kind: "numeric-data-domain",
    });
    expect(runtimeTrace.preparedSql).toHaveLength(
      oldTrace.preparedSql.length + 1,
    );
    expect(runtimeTrace.preparedSql).toContain(compiled.evidence.sql);
    recordEvidence("numeric-fallback", {
      fallbackReason: diagnostics.advancedCountSqlFallbackReason,
      oldDto: legacy.dto,
      actualDto: actual.result.value,
      compiledSqlSha256: createHash("sha256")
        .update(compiled.evidence.sql)
        .digest("hex"),
      legacyStatements: oldTrace.preparedSql,
      runtimeStatements: runtimeTrace.preparedSql,
    });
  });

  it("enforces the activity cap before numeric fallback and returns no report rows", async () => {
    const database = createMigratedDatabase();
    DATABASES.add(database);
    database.exec("PRAGMA foreign_keys = OFF");
    const site = addSite(database);
    const activityCount = ADVANCED_FILTER_MAX_ACTIVITIES + 1;
    database
      .prepare(
        `WITH RECURSIVE generated(n) AS (
           SELECT 1 UNION ALL SELECT n + 1 FROM generated WHERE n < ?
         )
         INSERT INTO visits (
           visit_id, site_id, site_pk, visitor_id, session_id, status,
           started_at, last_activity_at, pathname, hostname, duration_ms
         )
         SELECT 'wave95j-cap-' || n, ?, ?, 'cap-visitor', 'cap-session',
           'closed', 125, 125, '/bulk', 'included.test', 10 FROM generated`,
      )
      .run(activityCount, SITE, site.pk);
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "wave95j-cap-1");
    const query = queryFor("session", {
      dimension: "session.entryPath",
      filterDsl:
        'page.path neq "/excluded" and count(page { page.durationMs gt 5 }) eq 1',
    });
    const trace = traceFor();
    const diagnostics = createD1ReadDiagnostics();
    const provider = createD1SiteProviderRegistry({
      env: testEnv(database, trace),
      siteId: SITE,
      diagnostics,
    }).resolve("dimension");
    if (!provider) throw new Error("wave95j_cap_provider_missing");
    await expect(provider.execute(query)).rejects.toMatchObject({
      domainError: {
        kind: "invalid-input",
        issues: [{ path: "filters", code: "filter_activity_limit_exceeded" }],
      },
    });
    expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
    expect(trace.preparedSql).toHaveLength(2);
    const rawRows = database
      .prepare(trace.preparedSql[1]!)
      .all(...(trace.bindings[1] as SQLInputValue[])) as Record<
      string,
      unknown
    >[];
    expect(rawRows.filter((row) => row.rowKind === "control")).toHaveLength(1);
    expect(
      Number(rawRows.find((row) => row.rowKind === "control")!.rawCount),
    ).toBe(activityCount);
    expect(rawRows.filter((row) => row.rowKind === "report")).toHaveLength(0);
  });

  it("enforces the Count cap before rejecting an invalid overview cursor even when numeric proof gates every report row", async () => {
    const database = createMigratedDatabase();
    DATABASES.add(database);
    database.exec("PRAGMA foreign_keys = OFF");
    const site = addSite(database);
    const activityCount = ADVANCED_FILTER_MAX_ACTIVITIES + 1;
    database
      .prepare(
        `WITH RECURSIVE generated(n) AS (
           SELECT 1 UNION ALL SELECT n + 1 FROM generated WHERE n < ?
         )
         INSERT INTO visits (
           visit_id, site_id, site_pk, visitor_id, session_id, status,
           started_at, last_activity_at, pathname, hostname, duration_ms
         )
         SELECT 'wave95t-cap-' || n, ?, ?, 'cap-visitor-' || n,
           'cap-session-' || n,
           'closed', 125, 125, '/bulk', 'included.test', 10 FROM generated`,
      )
      .run(activityCount, SITE, site.pk);
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "wave95t-cap-1");
    const query = queryFor("session", {
      mode: "overview-tab",
      tab: "page.entry",
      limit: 1,
      page: { cursor: "invalid-cursor-token" },
      filterDsl: "count(page { page.durationMs gt 5 }) eq 1",
    }) as OverviewTestQuery;
    const trace = traceFor();
    const diagnostics = createD1ReadDiagnostics();
    const provider = createD1SiteProviderRegistry({
      env: testEnv(database, trace),
      siteId: SITE,
      diagnostics,
    }).resolve("dimension");
    if (!provider) throw new Error("wave95t_cap_overview_provider_missing");
    await expect(provider.execute(query)).rejects.toMatchObject({
      domainError: {
        kind: "invalid-input",
        issues: [{ path: "filters", code: "filter_activity_limit_exceeded" }],
      },
    });
    expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
    expect(trace.preparedSql).toHaveLength(2);
    const rawRows = database
      .prepare(trace.preparedSql[1]!)
      .all(...(trace.bindings[1] as SQLInputValue[])) as Record<
      string,
      unknown
    >[];
    const controls = rawRows.filter((row) => row.rowKind === "control");
    expect(controls).toHaveLength(1);
    expect(Number(controls[0]!.rawCount)).toBe(activityCount);
    expect(rawRows.filter((row) => row.rowKind === "report")).toHaveLength(0);
    recordEvidence("overview-page-cap-before-invalid-cursor", {
      activityCount,
      control: controls[0],
      reportRows: rawRows.filter((row) => row.rowKind === "report").length,
      statements: trace.preparedSql,
      issue: "filter_activity_limit_exceeded",
    });
  });

  it("falls back once for overview numeric incompatibility and preserves the independent DTO", async () => {
    const { database } = createFixture();
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run(10, "session-a-entry");
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "session-a-middle");
    const query = queryFor("session", {
      mode: "overview-tab",
      tab: "page.entry",
      limit: 2,
      filterDsl:
        'page.path neq "/excluded" and count(event { event.name eq "qualifier" }) eq 1 and count(page { page.durationMs gt 5 }) eq 1',
    }) as OverviewTestQuery;
    const legacyTrace = traceFor();
    const legacy = await legacyOverviewPageFor(database, query, legacyTrace);
    const runtimeTrace = traceFor();
    const diagnostics = createD1ReadDiagnostics();
    const actual = await runOverviewActual(
      database,
      query,
      runtimeTrace,
      diagnostics,
    );
    expect(actual.result).toEqual(legacy.dto);
    expect(diagnostics.advancedCountSqlFallbackReason).toMatchObject({
      kind: "numeric-data-domain",
    });
    expect(runtimeTrace.preparedSql.length).toBeGreaterThan(2);
    expect(runtimeTrace.preparedSql.length).toBe(
      legacyTrace.preparedSql.length + 1,
    );
    recordEvidence("overview-page-numeric-fallback", {
      fallbackReason: diagnostics.advancedCountSqlFallbackReason,
      legacyDto: legacy.dto,
      actualDto: actual.result,
      legacyStatements: legacyTrace.preparedSql,
      runtimeStatements: runtimeTrace.preparedSql,
    });
  });

  it("rejects malformed Session page report rows and propagates SQLite errors without retry", async () => {
    const { database } = createFixture();
    const malformedTrace = traceFor();
    const malformedProvider = createD1SiteProviderRegistry({
      env: testEnvWithMalformedOverviewReport(database, malformedTrace),
      siteId: SITE,
    }).resolve("dimension");
    if (!malformedProvider)
      throw new Error("wave95t_malformed_overview_provider_missing");
    const query = queryFor("session", {
      mode: "overview-tab",
      tab: "page.entry",
      limit: 2,
    }) as OverviewTestQuery;
    await expect(malformedProvider.execute(query)).rejects.toThrow(
      "analytics_event_summary_qualification_report_row_invalid",
    );
    expect(malformedTrace.preparedSql).toHaveLength(2);

    const sqliteTrace = traceFor();
    const sqliteProvider = createD1SiteProviderRegistry({
      env: testEnvWithSqliteFailure(database, sqliteTrace),
      siteId: SITE,
    }).resolve("dimension");
    if (!sqliteProvider)
      throw new Error("wave95t_sqlite_overview_provider_missing");
    await expect(sqliteProvider.execute(query)).rejects.toThrow(
      "wave95j_sqlite_report_failure",
    );
    expect(sqliteTrace.preparedSql).toHaveLength(2);
  });

  it("rejects a validly signed visitor cursor that omits its visitor metric", async () => {
    const { database } = createFixture();
    const env = testEnv(database, traceFor());
    const query = queryFor("session", {
      mode: "overview-tab",
      tab: "page.entry",
      sortBy: "visitors",
    }) as OverviewTestQuery;
    const filters = query.filters!;
    const binding = await paginationBindingForWindow(
      { paginationBinding: undefined },
      sessionPathCursorBinding({
        operation: "entry",
        siteId: SITE,
        window: WINDOW,
        filters,
        audience: query.context.policy.audience,
        sortBy: "visitors",
        sortDirection: "desc",
      }),
    );
    const malformedToken = await encodePageCursor(env, binding, {
      views: 1,
      value: "/signed-without-visitors",
    });
    const decoded = await decodeSessionPathDimensionCursor(
      env,
      SITE,
      WINDOW,
      filters,
      "entry",
      undefined,
      malformedToken,
      query.context.policy.audience,
      "visitors",
      "desc",
    );
    expect(decoded).toBeNull();
    recordEvidence("visitor-cursor-requires-visitors-field", {
      tokenSigned: true,
      decoded: false,
    });
  });

  it("binds old Session cursors to site, window, scope, search, audience, tab, and sort", async () => {
    const { database } = createFixture();
    const query = queryFor("session", {
      mode: "overview-tab",
      tab: "page.entry",
      limit: 1,
    }) as OverviewTestQuery;
    const legacy = await legacyOverviewPageFor(database, query, traceFor());
    const token = legacy.dto.data.pagination.nextCursor;
    expect(token).not.toBeNull();
    if (!token) throw new Error("wave95t_cursor_binding_token_missing");
    const env = testEnv(database, traceFor());
    const visitorFilters = queryFor("visitor", {
      mode: "overview-tab",
      tab: "page.entry",
      limit: 1,
    }).filters!;
    const changedWindow = {
      ...WINDOW,
      startMs: WINDOW.startMs + 1,
    };
    const variants = [
      {
        siteId: `${SITE}-other`,
        window: WINDOW,
        filters: query.filters!,
        kind: "entry" as const,
        search: undefined,
        audience: query.context.policy.audience,
        sortBy: "views" as const,
        sortDirection: "desc" as const,
      },
      {
        siteId: SITE,
        window: changedWindow,
        filters: query.filters!,
        kind: "entry" as const,
        search: undefined,
        audience: query.context.policy.audience,
        sortBy: "views" as const,
        sortDirection: "desc" as const,
      },
      {
        siteId: SITE,
        window: WINDOW,
        filters: visitorFilters,
        kind: "entry" as const,
        search: undefined,
        audience: query.context.policy.audience,
        sortBy: "views" as const,
        sortDirection: "desc" as const,
      },
      {
        siteId: SITE,
        window: WINDOW,
        filters: query.filters!,
        kind: "entry" as const,
        search: "needle",
        audience: query.context.policy.audience,
        sortBy: "views" as const,
        sortDirection: "desc" as const,
      },
      {
        siteId: SITE,
        window: WINDOW,
        filters: query.filters!,
        kind: "entry" as const,
        search: undefined,
        audience: "public-share" as const,
        sortBy: "views" as const,
        sortDirection: "desc" as const,
      },
      {
        siteId: SITE,
        window: WINDOW,
        filters: query.filters!,
        kind: "exit" as const,
        search: undefined,
        audience: query.context.policy.audience,
        sortBy: "views" as const,
        sortDirection: "desc" as const,
      },
      {
        siteId: SITE,
        window: WINDOW,
        filters: query.filters!,
        kind: "entry" as const,
        search: undefined,
        audience: query.context.policy.audience,
        sortBy: "sessions" as const,
        sortDirection: "desc" as const,
      },
      {
        siteId: SITE,
        window: WINDOW,
        filters: query.filters!,
        kind: "entry" as const,
        search: undefined,
        audience: query.context.policy.audience,
        sortBy: "views" as const,
        sortDirection: "asc" as const,
      },
    ];
    for (const variant of variants) {
      await expect(
        decodeSessionPathDimensionCursor(
          env,
          variant.siteId,
          variant.window,
          variant.filters,
          variant.kind,
          variant.search,
          token,
          variant.audience,
          variant.sortBy,
          variant.sortDirection,
        ),
      ).rejects.toThrow();
    }
    recordEvidence("session-cursor-binding-rejections", {
      validOldCursorAcceptedByActualChain: true,
      rejectedBindings: [
        "site",
        "window",
        "scope",
        "search",
        "audience",
        "entry-exit",
        "sort",
        "direction",
      ],
    });
  });

  it("keeps comparisons, public shares, invalid controls, and aborted requests outside the overview-page brand", async () => {
    const { database } = createFixture();
    const valid = queryFor("session", {
      mode: "overview-tab",
      tab: "page.entry",
      limit: 1,
    }) as OverviewTestQuery;
    const env = testEnv(database, traceFor());
    const middleware = d1AdvancedFilterMiddleware(env, undefined, SITE);
    const forwarded = await middleware(
      "dimension",
      valid,
      async (prepared) => prepared,
    );
    const deferred =
      deferredSessionBoundaryOverviewPageQualificationFromQuery(forwarded);
    expect(deferred).toBeDefined();
    if (!deferred) throw new Error("wave95t_overview_brand_missing");
    const validCompileQuery = sessionOverviewQualificationQuery(
      valid,
      deferred,
      null,
    );
    const invalidCompileQueries = [
      { ...validCompileQuery, tab: "page.exit" },
      { ...validCompileQuery, dimension: "session.exitPath" },
      { ...validCompileQuery, cursorToken: "other-token" },
      { ...validCompileQuery, limit: 0 },
      { ...validCompileQuery, sortBy: "sessions" },
      { ...validCompileQuery, sortDirection: "asc" },
      { ...validCompileQuery, search: "different" },
      { ...validCompileQuery, audience: "public-report" },
      { ...validCompileQuery, siteId: `${SITE}-wrong` },
    ];
    for (const invalidQuery of invalidCompileQueries)
      expect(() =>
        compileSessionBoundaryOverviewPageQualificationProgram({
          deferred,
          query: invalidQuery as never,
        }),
      ).toThrow();

    const topForwarded = await middleware(
      "dimension",
      queryFor("session"),
      async (prepared) => prepared,
    );
    const topDeferred =
      deferredSessionBoundaryDimensionQualificationFromQuery(topForwarded);
    if (!topDeferred) throw new Error("wave95t_top_n_brand_missing");
    expect(() =>
      compileSessionBoundaryOverviewPageQualificationProgram({
        deferred: topDeferred as never,
        query: validCompileQuery,
      }),
    ).toThrow("analytics_event_qualification_request_mismatch");

    const nonEligibleQueries = [
      { ...valid, tab: "page.path" },
      { ...valid, limit: 0 },
      {
        ...valid,
        comparison: { metric: "views", sortBy: "current", direction: "desc" },
      },
      { ...valid, current: {}, reference: {} },
      {
        ...valid,
        context: siteQueryContext(SITE, "public-share"),
      },
    ];
    for (const query of nonEligibleQueries) {
      const output = await middleware(
        "dimension",
        query,
        async (prepared) => prepared,
      );
      expect(
        deferredSessionBoundaryOverviewPageQualificationFromQuery(output),
      ).toBeUndefined();
    }

    const wrongSiteTrace = traceFor();
    const wrongSiteMiddleware = d1AdvancedFilterMiddleware(
      testEnv(database, wrongSiteTrace),
      undefined,
      `${SITE}-wrong`,
    );
    await expect(
      wrongSiteMiddleware("dimension", valid, async (prepared) => prepared),
    ).rejects.toMatchObject({
      domainError: {
        kind: "invalid-input",
        issues: [
          {
            path: "siteId",
            code: "session_boundary_overview_page_request_context_mismatch",
          },
        ],
      },
    });
    expect(wrongSiteTrace.preparedSql).toHaveLength(0);

    const abortTrace = traceFor();
    const abortProvider = createD1SiteProviderRegistry({
      env: testEnv(database, abortTrace),
      siteId: SITE,
    }).resolve("dimension");
    if (!abortProvider)
      throw new Error("wave95t_abort_overview_provider_missing");
    const controller = new AbortController();
    controller.abort();
    await expect(
      abortProvider.execute(valid, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(abortTrace.preparedSql).toHaveLength(0);
  });

  it.each([
    "missing-control",
    "duplicate-control",
    "wrong-control-scope",
    "null-activity-proof",
    "site-identity-proof",
  ] as const)(
    "propagates malformed %s controls without falling back",
    async (behavior) => {
      const { database } = createFixture();
      const trace = traceFor();
      const provider = createD1SiteProviderRegistry({
        env: testEnvWithControlBehavior(database, trace, behavior),
        siteId: SITE,
      }).resolve("dimension");
      if (!provider) throw new Error("wave95j_control_provider_missing");
      await expect(provider.execute(queryFor("session"))).rejects.toThrow();
      expect(trace.preparedSql).toHaveLength(2);
    },
  );

  it("propagates SQLite report errors without retrying through the fallback", async () => {
    const { database } = createFixture();
    const trace = traceFor();
    const provider = createD1SiteProviderRegistry({
      env: testEnvWithSqliteFailure(database, trace),
      siteId: SITE,
    }).resolve("dimension");
    if (!provider) throw new Error("wave95j_sqlite_provider_missing");
    await expect(provider.execute(queryFor("session"))).rejects.toThrow(
      "wave95j_sqlite_report_failure",
    );
    expect(trace.preparedSql).toHaveLength(2);
  });
});

describe("Private Session boundary whole Boolean qualification", () => {
  it.each(
    (["breakdown", "overview-tab"] as const).flatMap((mode) =>
      (["session", "visitor"] as const).map((scope) => ({ mode, scope })),
    ),
  )(
    "keeps whole OR/NOT owner qualification and legacy boundaries for $mode/$scope",
    async ({ mode, scope }) => {
      const { database, rows } = createWholeBooleanFixture();
      const cases = [
        { kind: "entry" as const, filterKind: "or" as const },
        { kind: "exit" as const, filterKind: "not" as const },
      ];

      for (const { kind, filterKind } of cases) {
        const filterDsl = SESSION_BOUNDARY_WHOLE_BOOLEAN_FILTERS[filterKind];
        const dimension =
          kind === "entry" ? "session.entryPath" : "session.exitPath";
        const query =
          mode === "breakdown"
            ? (queryFor(scope, { dimension, filterDsl }) as BreakdownTestQuery)
            : (queryFor(scope, {
                mode: "overview-tab",
                tab: kind === "entry" ? "page.entry" : "page.exit",
                filterDsl,
                limit: 100,
              }) as OverviewTestQuery);
        const oldTrace = traceFor();
        const legacy =
          mode === "breakdown"
            ? await legacyBoundaryFor(
                database,
                query as BreakdownTestQuery,
                oldTrace,
              )
            : await legacyOverviewPageFor(
                database,
                query as OverviewTestQuery,
                oldTrace,
              );
        const deferred = legacy.deferred;
        expect(deferred?.sessionBoundaryFilterMode).toBe("allow-whole-filter");
        if (!deferred)
          throw new Error("wave97di_whole_boolean_deferred_missing");
        const dimensionDeferred = deferred as NonNullable<
          ReturnType<
            typeof deferredSessionBoundaryDimensionQualificationFromQuery
          >
        >;
        const overviewDeferred = deferred as NonNullable<
          ReturnType<
            typeof deferredSessionBoundaryOverviewPageQualificationFromQuery
          >
        >;

        const envelopes: QualificationEnvelopeCapture[] = [];
        const runtimeTrace = traceFor();
        const expected = independentWholeBooleanBoundaryItems({
          rows,
          scope,
          filterKind,
          kind,
        });
        const expectedKeys = new Set(expected.map((row) => row.key));
        if (filterKind === "or") {
          expect(expectedKeys.has("/native-entry")).toBe(true);
          expect(expectedKeys.has("/native-hit")).toBe(false);
          expect(expectedKeys.has("/count-entry-a")).toBe(true);
          if (scope === "visitor")
            expect(expectedKeys.has("/native-sibling-entry")).toBe(true);
        } else {
          expect(expectedKeys.has("/neither-exit")).toBe(true);
          expect(expectedKeys.has("/count-exit-z")).toBe(true);
        }
        const reportOutputId =
          mode === "breakdown" ? "session-path-top" : "session-path-page";
        const actual =
          mode === "breakdown"
            ? await runActual(
                database,
                query as BreakdownTestQuery,
                runtimeTrace,
                createD1ReadDiagnostics(),
                envelopes,
              )
            : await runOverviewActual(
                database,
                query as OverviewTestQuery,
                runtimeTrace,
                createD1ReadDiagnostics(),
                envelopes,
              );

        const actualItems =
          mode === "breakdown"
            ? (actual as Awaited<ReturnType<typeof runActual>>).result.value
                .items
            : (actual as Awaited<ReturnType<typeof runOverviewActual>>).result
                .data.items;
        const expectedItems =
          mode === "breakdown"
            ? expected
            : expected.map(({ key: _key, ...row }) => row);
        expect(actualItems).toEqual(expectedItems);
        if (mode === "breakdown") {
          expect(
            (actual as Awaited<ReturnType<typeof runActual>>).result.value,
          ).toEqual(legacy.dto);
        } else {
          expect(
            (actual as Awaited<ReturnType<typeof runOverviewActual>>).result,
          ).toEqual(legacy.dto);
        }

        const controlRows = envelopes.flatMap((envelope) =>
          envelope.rows.filter((row) => row.rowKind === "control"),
        );
        const reportRows = envelopes.flatMap((envelope) =>
          envelope.rows.filter((row) => row.rowKind === "report"),
        );
        expect(envelopes).toHaveLength(1);
        expect(controlRows).toHaveLength(1);
        expect(controlRows[0]?.entityKind).toBe(scope);
        expect(reportRows).toHaveLength(expected.length);
        expect(new Set(reportRows.map((row) => row.outputId))).toEqual(
          new Set([reportOutputId]),
        );

        const compiled =
          mode === "breakdown"
            ? compileSessionBoundaryDimensionQualificationProgram({
                deferred: dimensionDeferred,
                query: sessionQualificationQuery(
                  query as BreakdownTestQuery,
                  dimensionDeferred,
                ),
              })
            : compileSessionBoundaryOverviewPageQualificationProgram({
                deferred: overviewDeferred,
                query: sessionOverviewQualificationQuery(
                  query as OverviewTestQuery,
                  overviewDeferred,
                  null,
                ),
              });
        expect(compiled.kind).toBe("compiled");
        if (compiled.kind !== "compiled")
          throw new Error("wave97di_whole_boolean_compile_unavailable");
        const reportSqlIndex = runtimeTrace.preparedSql.lastIndexOf(
          compiled.evidence.sql,
        );
        expect(reportSqlIndex).toBeGreaterThanOrEqual(0);
        expect(runtimeTrace.bindings[reportSqlIndex]).toEqual(
          compiled.evidence.bindings,
        );
        const sqlBytes = new TextEncoder().encode(
          runtimeTrace.preparedSql[reportSqlIndex]!,
        ).byteLength;
        const bindingCount = runtimeTrace.bindings[reportSqlIndex]!.length;
        expect(sqlBytes).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
        expect(bindingCount).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
        expect(runtimeTrace.preparedSql).toHaveLength(2);

        recordEvidence("whole-boolean-success", {
          mode,
          scope,
          kind,
          filterKind,
          filterDsl,
          legacyDto: legacy.dto,
          independentExpected: expected,
          actualDto:
            mode === "breakdown"
              ? (actual as Awaited<ReturnType<typeof runActual>>).result
              : (actual as Awaited<ReturnType<typeof runOverviewActual>>)
                  .result,
          oldSql: oldTrace.preparedSql,
          oldBindings: oldTrace.bindings,
          runtimeSql: runtimeTrace.preparedSql,
          runtimeBindings: runtimeTrace.bindings,
          envelopeRows: envelopes,
          reportSqlBytes: sqlBytes,
          reportBindingCount: bindingCount,
          d1Limits: {
            sqlUtf8Bytes: D1_MAX_SQL_UTF8_BYTES,
            boundParameters: D1_MAX_BOUND_PARAMETERS,
          },
          compiledEvidence: compiled.evidence,
        });
      }
    },
  );

  it("continues the real legacy Overview cursor chain and rejects crossed scope/kind cursors", async () => {
    const { database, rows } = createWholeBooleanFixture();
    const scope = "visitor" as const;
    const filterKind = "or" as const;
    const filterDsl = SESSION_BOUNDARY_WHOLE_BOOLEAN_FILTERS[filterKind];
    const expected = independentWholeBooleanBoundaryItems({
      rows,
      scope,
      filterKind,
      kind: "entry",
    }).map(({ key: _key, ...row }) => row);
    const allActualItems: Array<{
      readonly label?: string;
      readonly views?: number;
      readonly sessions?: number;
      readonly visitors?: number;
    }> = [];
    const pageEvidence: Array<Record<string, unknown>> = [];
    let cursor: string | null = null;
    let firstCursor: string | null = null;
    let pageCount = 0;
    do {
      const query = queryFor(scope, {
        mode: "overview-tab",
        tab: "page.entry",
        filterDsl,
        limit: 2,
        page: { limit: 2, cursor },
      }) as OverviewTestQuery;
      const oldTrace = traceFor();
      const legacy = await legacyOverviewPageFor(database, query, oldTrace);
      expect(legacy.deferred?.sessionBoundaryFilterMode).toBe(
        "allow-whole-filter",
      );
      const envelopes: QualificationEnvelopeCapture[] = [];
      const runtimeTrace = traceFor();
      const actual = await runOverviewActual(
        database,
        query,
        runtimeTrace,
        createD1ReadDiagnostics(),
        envelopes,
      );
      expect(actual.result).toEqual(legacy.dto);
      expect(actual.result.data.items).toEqual(
        expected.slice(pageCount * 2, pageCount * 2 + 2),
      );
      expect(envelopes).toHaveLength(1);
      const controlRows = envelopes[0]!.rows.filter(
        (row) => row.rowKind === "control",
      );
      const reportRows = envelopes[0]!.rows.filter(
        (row) => row.rowKind === "report",
      );
      expect(controlRows).toHaveLength(1);
      expect(controlRows[0]?.entityKind).toBe(scope);
      expect(reportRows.length).toBeGreaterThanOrEqual(
        actual.result.data.items.length,
      );
      expect(reportRows.length).toBeLessThanOrEqual(3);
      expect(new Set(reportRows.map((row) => row.outputId))).toEqual(
        new Set(["session-path-page"]),
      );
      if (pageCount === 0) {
        expect(reportRows).toHaveLength(3);
        expect(legacy.dto.data.pagination.nextCursor).not.toBeNull();
      }
      expect(runtimeTrace.preparedSql).toHaveLength(2);
      const reportSqlIndex = runtimeTrace.preparedSql.length - 1;
      const reportSqlBytes = new TextEncoder().encode(
        runtimeTrace.preparedSql[reportSqlIndex]!,
      ).byteLength;
      const reportBindingCount = runtimeTrace.bindings[reportSqlIndex]!.length;
      expect(reportSqlBytes).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
      expect(reportBindingCount).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
      allActualItems.push(...actual.result.data.items);
      pageEvidence.push({
        page: pageCount,
        cursor,
        legacyDto: legacy.dto,
        actualDto: actual.result,
        oldSql: oldTrace.preparedSql,
        oldBindings: oldTrace.bindings,
        runtimeSql: runtimeTrace.preparedSql,
        runtimeBindings: runtimeTrace.bindings,
        envelopeRows: envelopes,
        reportSqlBytes,
        reportBindingCount,
      });
      cursor = legacy.dto.data.pagination.nextCursor;
      if (pageCount === 0) firstCursor = cursor;
      pageCount += 1;
      expect(pageCount).toBeLessThanOrEqual(4);
    } while (cursor);

    expect(pageCount).toBe(3);
    expect(new Set(allActualItems.map((row) => row.label)).size).toBe(
      allActualItems.length,
    );
    expect(allActualItems).toEqual(expected);
    if (!firstCursor) throw new Error("wave97di_cursor_chain_missing_cursor");
    const env = testEnv(database, traceFor());
    const visitorFilters = queryFor(scope, {
      mode: "overview-tab",
      tab: "page.entry",
      filterDsl,
      limit: 2,
    }).filters!;
    const sessionFilters = queryFor("session", {
      mode: "overview-tab",
      tab: "page.entry",
      filterDsl,
      limit: 2,
    }).filters!;
    await expect(
      decodeSessionPathDimensionCursor(
        env,
        SITE,
        WINDOW,
        visitorFilters,
        "exit",
        undefined,
        firstCursor,
        "private-dashboard",
        "views",
        "desc",
      ),
    ).rejects.toThrow();
    await expect(
      decodeSessionPathDimensionCursor(
        env,
        SITE,
        WINDOW,
        sessionFilters,
        "entry",
        undefined,
        firstCursor,
        "private-dashboard",
        "views",
        "desc",
      ),
    ).rejects.toThrow();
    recordEvidence("whole-boolean-overview-cursor-chain", {
      mode: "overview-tab",
      scope,
      kind: "entry",
      filterKind,
      filterDsl,
      independentExpected: expected,
      actualItems: allActualItems,
      pageCount,
      pages: pageEvidence,
      rejectedCursorBindings: ["kind", "scope"],
    });
  });

  it("limits the internal whole-filter permit to exact private Session boundary requests", async () => {
    const { database } = createWholeBooleanFixture();
    const env = testEnv(database, traceFor());
    const middleware = d1AdvancedFilterMiddleware(env, undefined, SITE);
    const wholeBreakdown = queryFor("session", {
      filterDsl: SESSION_BOUNDARY_WHOLE_BOOLEAN_FILTERS.or,
    });
    const privateForwarded = await middleware(
      "dimension",
      wholeBreakdown,
      async (prepared) => prepared,
    );
    const privateDeferred =
      deferredSessionBoundaryDimensionQualificationFromQuery(privateForwarded);
    expect(privateDeferred?.sessionBoundaryFilterMode).toBe(
      "allow-whole-filter",
    );
    if (!privateDeferred)
      throw new Error("wave97di_private_dimension_permit_missing");
    const privateCompileQuery = sessionQualificationQuery(
      wholeBreakdown,
      privateDeferred,
    );
    for (const mismatch of [
      { ...privateCompileQuery, audience: "public-share" },
      { ...privateCompileQuery, kind: "exit" },
      { ...privateCompileQuery, dimension: "session.exitPath" },
    ])
      expect(() =>
        compileSessionBoundaryDimensionQualificationProgram({
          deferred: privateDeferred,
          query: mismatch as never,
        }),
      ).toThrow();

    const wholeOverview = queryFor("visitor", {
      mode: "overview-tab",
      tab: "page.entry",
      filterDsl: SESSION_BOUNDARY_WHOLE_BOOLEAN_FILTERS.or,
      limit: 2,
    }) as OverviewTestQuery;
    const overviewForwarded = await middleware(
      "dimension",
      wholeOverview,
      async (prepared) => prepared,
    );
    const overviewDeferred =
      deferredSessionBoundaryOverviewPageQualificationFromQuery(
        overviewForwarded,
      );
    expect(overviewDeferred?.sessionBoundaryFilterMode).toBe(
      "allow-whole-filter",
    );
    if (!overviewDeferred)
      throw new Error("wave97di_private_overview_permit_missing");
    const overviewCompileQuery = sessionOverviewQualificationQuery(
      wholeOverview,
      overviewDeferred,
      null,
    );
    for (const mismatch of [
      { ...overviewCompileQuery, audience: "public-share" },
      { ...overviewCompileQuery, tab: "page.exit" },
      { ...overviewCompileQuery, dimension: "session.exitPath" },
      { ...overviewCompileQuery, kind: "exit" },
    ])
      expect(() =>
        compileSessionBoundaryOverviewPageQualificationProgram({
          deferred: overviewDeferred,
          query: mismatch as never,
        }),
      ).toThrow();

    const publicShare = queryFor("session", {
      filterDsl: SESSION_BOUNDARY_WHOLE_BOOLEAN_FILTERS.or,
      audience: "public-share",
    }) as BreakdownTestQuery;
    const withComparison = {
      ...wholeBreakdown,
      comparison: { metric: "views" },
    } as BreakdownTestQuery;
    const withCurrentReference = {
      ...wholeBreakdown,
      current: { time: TIME },
      reference: { time: TIME },
    } as BreakdownTestQuery;
    const wrongMode = {
      ...wholeBreakdown,
      mode: "other-dimension-mode",
    } as unknown as BoundaryTestQuery;
    const excludedQueries = [
      publicShare,
      withComparison,
      withCurrentReference,
      wrongMode,
    ];
    for (const query of excludedQueries) {
      const forwarded = await middleware(
        "dimension",
        query,
        async (prepared) => prepared,
      );
      expect(
        deferredSessionBoundaryDimensionQualificationFromQuery(forwarded),
      ).toBeUndefined();
    }

    const publicWholeOverview = queryFor("session", {
      mode: "overview-tab",
      tab: "page.entry",
      limit: 1,
      filterDsl: SESSION_BOUNDARY_WHOLE_BOOLEAN_FILTERS.or,
      audience: "public-share",
    }) as OverviewTestQuery;
    const publicWholeOverviewForwarded = await middleware(
      "dimension",
      publicWholeOverview,
      async (prepared) => prepared,
    );
    expect(
      deferredSessionBoundaryOverviewPageQualificationFromQuery(
        publicWholeOverviewForwarded,
      ),
    ).toBeUndefined();

    const defaultFilters = queryFor("session", { filterDsl: BASE_FILTER });
    const oldUndefinedMode = {
      ...defaultFilters,
      mode: undefined,
    } as unknown as BoundaryTestQuery;
    const oldOtherMode = {
      ...defaultFilters,
      mode: "other-dimension-mode",
    } as unknown as BoundaryTestQuery;
    for (const query of [oldUndefinedMode, oldOtherMode]) {
      const forwarded = await middleware(
        "dimension",
        query,
        async (prepared) => prepared,
      );
      expect(
        deferredSessionBoundaryDimensionQualificationFromQuery(forwarded),
      ).toBeDefined();
    }
    recordEvidence("whole-boolean-private-request-gates", {
      accepted: ["private-breakdown", "private-overview-entry"],
      rejected: [
        "public-share",
        "comparison",
        "current-reference",
        "non-breakdown-whole-filter",
        "dimension-kind-mismatch",
        "overview-tab-kind-mismatch",
      ],
      oldConjunctionModesRemainAccepted: ["undefined", "other-mode"],
    });
  });
});
