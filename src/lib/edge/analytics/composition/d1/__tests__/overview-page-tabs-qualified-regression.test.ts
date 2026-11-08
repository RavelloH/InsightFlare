import { createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

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
  type NormalizedOverviewPageTableRequest,
  normalizeOverviewPageTableRequest,
  overviewPageTableDescriptor,
  PAGE_DIMENSION_SELECTIONS,
} from "@/lib/edge/analytics/engine/dimension-report-plan";
import { buildPageDimensionQualificationPlan } from "@/lib/edge/analytics/engine/page-dimension-qualification-plan";
import {
  d1AdvancedFilterMiddleware,
  deferredChannelListQualificationFromQuery,
  deferredChannelOverviewQualificationFromQuery,
  deferredOverviewPageTableQualificationFromQuery,
  prepareDeferredEventQualificationFallback,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { compilePageDimensionQualificationProgram } from "@/lib/edge/analytics/providers/d1/internal/analytics-qualification-program";
import { queryChannelsFromD1 } from "@/lib/edge/analytics/providers/d1/internal/channels";
import { mapTabs } from "@/lib/edge/analytics/providers/d1/internal/core";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import {
  decodeDimensionCursor,
  queryDimensionPageFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/dimensions";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import type { FilterDocument } from "@/lib/filter-contract/filters";
import { InvalidCursorError } from "@/lib/pagination";

const SITE = "wave95l-overview-page-table";
const TIME = createQueryTime(120, 130, "UTC", 500);
const WINDOW = {
  startMs: 120,
  endExclusiveMs: 130,
  nowMs: 500,
  timeZone: "UTC",
} as const;
const CURSOR_SECRET = "wave95l-overview-page-tabs-test-secret";
const PLAN_SHA256 =
  "7C17BA18A6F7CE66EC90830ADCEB96851AF6123A30F2EF63D326159720D8BC50";
const WAVE95S_PLAN_SHA256 =
  "B4728DF4A0762B98B5C8A7F564695E39127020CC37B63F0482167774CD1072FE";
const BASE_FILTER =
  'page.path neq "/excluded" and count(event { event.name eq "qualifier" }) gte 1';
const databases = new Set<DatabaseSync>();
const evidence: Array<Record<string, unknown>> = [];
const channelEvidence: Array<Record<string, unknown>> = [];
const wholeBooleanEvidence: Array<Record<string, unknown>> = [];
const WHOLE_BOOLEAN_OR_FILTER =
  'page.path eq "/native-only" or count(event { event.name eq "qualifier" }) gte 1';
const WHOLE_BOOLEAN_NOT_FILTER =
  'not count(event { event.name eq "qualifier" }) gte 1';

interface TestSite {
  readonly id: string;
  readonly pk: number;
}

interface OverviewTestQuery extends QueryInput {
  readonly mode: "overview-tab";
  readonly time: QueryTime;
  readonly tab: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly sort?: string;
  readonly direction?: "asc" | "desc";
  readonly search?: string;
}

interface OverviewQueryOptions {
  readonly operation?: "dimension" | "channels";
  readonly tab?: string;
  readonly limit?: number;
  readonly cursor?: string | null;
  readonly sort?: string;
  readonly direction?: "asc" | "desc";
  readonly search?: string;
  readonly audience?: "private-dashboard" | "api-v1" | "public-share";
  readonly filterDsl?: string;
}

interface CursorOverviewItem {
  readonly value?: string;
  readonly label?: string;
  readonly views?: number;
  readonly sessions?: number;
  readonly visitors?: number;
}

interface CursorOverviewDto {
  readonly data: {
    readonly items: readonly CursorOverviewItem[];
    readonly pagination: {
      readonly limit: number;
      readonly returned: number;
      readonly hasMore: boolean;
      readonly nextCursor: string | null;
    };
  };
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
       VALUES (?, 'wave95l-team', 'Overview table qualification', 'overview.test', 0)`,
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
    readonly query: string;
    readonly title: string;
    readonly hostname: string;
    readonly startedAt: number;
  },
): void {
  database
    .prepare(
      `INSERT INTO visits (
        visit_id, site_id, site_pk, visitor_id, session_id, status,
        started_at, last_activity_at, pathname, query_string, title, hostname,
        duration_ms
      ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, ?, ?, ?, 10)`,
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
      input.query,
      input.title,
      input.hostname,
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
  databases.add(database);
  database.exec("PRAGMA foreign_keys = OFF");
  const site = addSite(database);
  const visits = [
    {
      id: "visit-a1",
      sessionId: "session-a",
      visitorId: "visitor-a",
      path: "/landing",
      query: "",
      title: " Raw title ",
      hostname: " host.example ",
      startedAt: 121,
    },
    {
      id: "visit-a2",
      sessionId: "session-a",
      visitorId: "visitor-a",
      path: " /second",
      query: "  ",
      title: "Title%2F",
      hostname: "host.example",
      startedAt: 122,
    },
    {
      id: "visit-a3",
      sessionId: "session-b",
      visitorId: "visitor-a",
      path: "/delta",
      query: "q=%2F",
      title: " Raw title ",
      hostname: "host.example",
      startedAt: 124,
    },
    {
      id: "visit-a4",
      sessionId: "session-c",
      visitorId: "visitor-a",
      path: "/gamma",
      query: "campaign=one%2Ftwo",
      title: "Another",
      hostname: "other.example",
      startedAt: 126,
    },
    {
      id: "visit-a5",
      sessionId: "session-d",
      visitorId: "visitor-a",
      path: "/epsilon",
      query: "ref=x",
      title: "Another",
      hostname: "other.example",
      startedAt: 127,
    },
    {
      id: "visit-a6-empty-page-values",
      sessionId: "session-b",
      visitorId: "visitor-a",
      path: "",
      query: "",
      title: "",
      hostname: "",
      startedAt: 128,
    },
    {
      id: "visit-excluded",
      sessionId: "session-x",
      visitorId: "visitor-x",
      path: "/excluded",
      query: "blocked",
      title: "Excluded",
      hostname: "excluded.example",
      startedAt: 125,
    },
  ] as const;
  for (const visit of visits) addVisit(database, site, visit);

  const update = database.prepare(
    `UPDATE visits SET
      utm_source = ?, utm_medium = ?, utm_campaign = ?, utm_term = ?, utm_content = ?,
      browser = ?, os = ?, os_version = ?, device_type = ?, language = ?,
      screen_width = ?, screen_height = ?, country = ?, region_code = ?, region = ?,
      city = ?, continent = ?, timezone = ?, as_organization = ?
     WHERE visit_id = ?`,
  );
  const values = [
    [
      "",
      "",
      "",
      "",
      "",
      "Chrome",
      "Windows",
      "11",
      "desktop",
      "en-US",
      1920,
      1080,
      "US",
      "CA",
      "California",
      "San Francisco",
      "NA",
      "America/Los_Angeles",
      "Acme",
      "visit-a1",
    ],
    [
      "newsletter",
      "email",
      "spring",
      "launch",
      "hero",
      "Firefox",
      "Linux",
      "6.8",
      "desktop",
      "en-GB",
      1366,
      768,
      "US",
      "NY",
      "New York",
      "New York",
      "NA",
      "America/New_York",
      "Example Net",
      "visit-a2",
    ],
    [
      "google",
      "organic",
      "",
      "",
      "",
      "Safari",
      "iOS",
      "18",
      "mobile",
      "en",
      390,
      844,
      "CA",
      "ON",
      "Ontario",
      "Toronto",
      "NA",
      "America/Toronto",
      "North Network",
      "visit-a3",
    ],
    [
      "",
      "",
      "",
      "",
      "",
      "Chrome",
      "Windows",
      "11",
      "desktop",
      "",
      1920,
      1080,
      "US",
      "CA",
      "California",
      "San Francisco",
      "",
      "",
      "",
      "visit-a4",
    ],
    [
      "blocked",
      "referral",
      "",
      "",
      "",
      "Chrome",
      "Windows",
      "11",
      "desktop",
      "en",
      1920,
      1080,
      "GB",
      "ENG",
      "England",
      "London",
      "EU",
      "Europe/London",
      "Excluded",
      "visit-excluded",
    ],
  ] as const;
  for (const row of values) update.run(...row);
  addEvent(database, site, { id: "event-a1", visitId: "visit-a1", at: 123 });
  addEvent(database, site, { id: "event-a2", visitId: "visit-a2", at: 123 });
  addEvent(database, site, { id: "event-a3", visitId: "visit-a3", at: 125 });
  addEvent(database, site, { id: "event-a4", visitId: "visit-a4", at: 127 });
  addEvent(database, site, { id: "event-a5", visitId: "visit-a5", at: 128 });
  addEvent(database, site, {
    id: "event-a6",
    visitId: "visit-a6-empty-page-values",
    at: 128,
  });
  return { database, site };
}

function seedChannelAttribution(database: DatabaseSync): void {
  const update = database.prepare(
    `UPDATE visits SET utm_source = ?, utm_medium = ?, utm_campaign = ?,
      referrer_host = ? WHERE visit_id = ?`,
  );
  for (const row of [
    ["", "", "", "", "visit-a1"],
    ["search-ad", "cpc", "spring", "", "visit-a2"],
    ["", "", "", "www.google.com", "visit-a3"],
    ["", "", "", "publisher.example", "visit-a4"],
  ] as const)
    update.run(...row);
}

function seedWholeBooleanChannelCases(
  database: DatabaseSync,
  site: TestSite,
): void {
  addVisit(database, site, {
    id: "native-only",
    sessionId: "session-native-only",
    visitorId: "visitor-native-only",
    path: "/native-only",
    query: "",
    title: "Native only",
    hostname: "overview.test",
    startedAt: 122,
  });
  addVisit(database, site, {
    id: "neither-only",
    sessionId: "session-neither-only",
    visitorId: "visitor-neither-only",
    path: "/neither",
    query: "",
    title: "Neither branch",
    hostname: "overview.test",
    startedAt: 123,
  });
  const update = database.prepare(
    "UPDATE visits SET utm_source = ?, utm_medium = ? WHERE visit_id = ?",
  );
  update.run("newsletter", "email", "native-only");
  update.run("unclassified", "unclassified", "neither-only");
}

function independentChannelRows(
  database: DatabaseSync,
  scope: "session" | "visitor",
  branch: "or" | "not",
): readonly {
  readonly label: string;
  readonly views: number;
  readonly sessions: number;
  readonly visitors: number;
}[] {
  const countOwners = new Set(
    (
      database
        .prepare(
          `SELECT DISTINCT v.session_id, v.visitor_id
           FROM custom_events e
           JOIN custom_event_names n
             ON n.id = e.event_name_id AND n.site_id = e.site_id
           JOIN visits v
             ON v.visit_id = e.visit_id AND v.site_id = e.site_id
           WHERE e.site_id = ? AND n.name = 'qualifier'`,
        )
        .all(SITE) as Array<{
        readonly session_id: string;
        readonly visitor_id: string;
      }>
    ).map((row) => (scope === "session" ? row.session_id : row.visitor_id)),
  );
  const channelByVisit: Readonly<Record<string, string>> = {
    "visit-a1": "direct",
    "visit-a2": "paid_search",
    "visit-a3": "organic_search",
    "visit-a4": "referral",
    "visit-a5": "direct",
    "visit-a6-empty-page-values": "direct",
    "visit-excluded": "campaign",
    "native-only": "email",
    "neither-only": "other",
  };
  const visits = database
    .prepare(
      `SELECT visit_id, session_id, visitor_id, pathname
       FROM visits WHERE site_id = ? AND started_at >= ? AND started_at < ?`,
    )
    .all(SITE, WINDOW.startMs, WINDOW.endExclusiveMs) as Array<{
    readonly visit_id: string;
    readonly session_id: string;
    readonly visitor_id: string;
    readonly pathname: string;
  }>;
  const grouped = new Map<
    string,
    { views: number; sessions: Set<string>; visitors: Set<string> }
  >();
  for (const visit of visits) {
    const owner = scope === "session" ? visit.session_id : visit.visitor_id;
    const countMatch = countOwners.has(owner);
    const nativeMatch = visit.pathname === "/native-only";
    if (branch === "or" ? !nativeMatch && !countMatch : countMatch) continue;
    const label = channelByVisit[visit.visit_id];
    if (!label)
      throw new Error(`wave97dh_channel_expectation_missing:${visit.visit_id}`);
    const group = grouped.get(label) ?? {
      views: 0,
      sessions: new Set<string>(),
      visitors: new Set<string>(),
    };
    group.views += 1;
    group.sessions.add(visit.session_id);
    group.visitors.add(visit.visitor_id);
    grouped.set(label, group);
  }
  return [...grouped.entries()]
    .map(([label, totals]) => ({
      label,
      views: totals.views,
      sessions: totals.sessions.size,
      visitors: totals.visitors.size,
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

function testEnv(database: DatabaseSync, trace: SqliteD1Trace): Env {
  return {
    DB: createSqliteD1Database(database, trace),
    MAIN_SECRET: CURSOR_SECRET,
  } as unknown as Env;
}

function queryFor(
  scope: "session" | "visitor" | "event",
  options: OverviewQueryOptions = {},
): OverviewTestQuery {
  const prepared = prepareScopedQuery(options.operation ?? "dimension", {
    context: siteQueryContext(SITE, options.audience ?? "private-dashboard"),
    time: TIME,
    filters: parseFilterDsl(
      options.filterDsl ?? BASE_FILTER,
      analyticsFilterRegistry,
    ),
    scopePreference: scope,
  } as QueryInput & { readonly time: typeof TIME });
  return {
    ...prepared,
    mode: "overview-tab",
    tab: options.tab ?? "page.path",
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    ...(options.cursor ? { cursor: options.cursor } : {}),
    ...(options.sort !== undefined ? { sort: options.sort } : {}),
    ...(options.direction !== undefined
      ? { direction: options.direction }
      : {}),
    ...(options.search !== undefined ? { search: options.search } : {}),
  } as OverviewTestQuery;
}

function normalizedRequest(query: OverviewTestQuery) {
  return normalizeOverviewPageTableRequest({
    mode: query.mode,
    tab: query.tab,
    limit: query.limit,
    cursor: query.cursor,
    sort: query.sort,
    direction: query.direction,
    search: query.search,
  });
}

function overviewDto(
  tab: string,
  page: Awaited<ReturnType<typeof queryDimensionPageFromD1>>,
) {
  const descriptor = overviewPageTableDescriptor(tab);
  if (!descriptor) throw new Error("wave95l_overview_descriptor_missing");
  const items =
    tab === "page.query"
      ? page.items.map((row) => ({
          value: row.value,
          label: row.value,
          views: row.views,
          sessions: row.sessions,
          visitors: row.visitors,
        }))
      : mapTabs([...page.items]);
  return { data: { items, pagination: page.pagination } };
}

async function legacyOverviewTableFor(
  database: DatabaseSync,
  query: OverviewTestQuery,
  trace: SqliteD1Trace,
) {
  const env = testEnv(database, trace);
  const forwarded = await d1AdvancedFilterMiddleware(env, undefined, SITE)(
    "dimension",
    query,
    async (prepared) => prepared,
  );
  const deferred = deferredOverviewPageTableQualificationFromQuery(forwarded);
  const filters = deferred
    ? await prepareDeferredEventQualificationFallback(deferred)
    : ((forwarded as OverviewTestQuery).filters ?? query.filters);
  const normalized = normalizedRequest(query);
  if (!filters || !normalized)
    throw new Error("wave95l_legacy_overview_request_invalid");
  const cursor = await decodeDimensionCursor(
    env,
    SITE,
    WINDOW,
    filters,
    normalized.selection,
    normalized.search,
    normalized.cursorText,
    query.context.policy.audience,
    normalized.sortBy,
    normalized.sortDirection,
  );
  const page = await queryDimensionPageFromD1(
    env,
    SITE,
    WINDOW,
    filters,
    normalized.limit,
    normalized.selection,
    {
      excludeEmpty: normalized.excludeEmpty,
      ...(normalized.search !== undefined ? { search: normalized.search } : {}),
      sortBy: normalized.sortBy,
      sortDirection: normalized.sortDirection,
    },
    cursor,
    undefined,
    query.context.policy.audience,
  );
  return { dto: overviewDto(query.tab, page), deferred, filters, normalized };
}

async function legacyChannelOverviewTableFor(
  database: DatabaseSync,
  query: OverviewTestQuery,
  trace: SqliteD1Trace,
) {
  const env = testEnv(database, trace);
  const eventCandidate = query.scopePlan?.scope === "event";
  const legacyChannelsQuery = eventCandidate
    ? query
    : ({ ...query, mode: "list" } as unknown as OverviewTestQuery);
  // "channels" + "list" now defers channel-list qualification and leaves
  // Count matches unprepared for queryDimensionPageFromD1. Keep this legacy
  // oracle on the generic middleware preparation path via "pages".
  const forwarded = await d1AdvancedFilterMiddleware(env, undefined, SITE)(
    eventCandidate ? "channels" : "pages",
    legacyChannelsQuery,
    async (prepared) => prepared,
  );
  const deferred = eventCandidate
    ? deferredChannelOverviewQualificationFromQuery(forwarded)
    : undefined;
  const filters = deferred
    ? await prepareDeferredEventQualificationFallback(deferred)
    : ((forwarded as OverviewTestQuery).filters ?? query.filters);
  const normalized = normalizeOverviewPageTableRequest({
    operation: "channels",
    mode: query.mode,
    tab: query.tab,
    limit: query.limit,
    cursor: query.cursor,
    sort: query.sort,
    direction: query.direction,
    search: query.search,
  });
  if (!filters || !normalized)
    throw new Error("wave95s_legacy_channel_overview_request_invalid");
  const cursor = await decodeDimensionCursor(
    env,
    SITE,
    WINDOW,
    filters,
    PAGE_DIMENSION_SELECTIONS.trafficChannel,
    normalized.search,
    normalized.cursorText,
    query.context.policy.audience,
    normalized.sortBy,
    normalized.sortDirection,
  );
  const page = await queryDimensionPageFromD1(
    env,
    SITE,
    WINDOW,
    filters,
    normalized.limit,
    PAGE_DIMENSION_SELECTIONS.trafficChannel,
    {
      excludeEmpty: true,
      ...(normalized.search !== undefined ? { search: normalized.search } : {}),
      sortBy: normalized.sortBy,
      sortDirection: normalized.sortDirection,
    },
    cursor,
    undefined,
    query.context.policy.audience,
  );
  return { dto: overviewDto(query.tab, page), filters, normalized, deferred };
}

async function legacyDimensionChannelOverviewTableFor(
  database: DatabaseSync,
  query: OverviewTestQuery,
  trace: SqliteD1Trace,
) {
  const env = testEnv(database, trace);
  const forwarded = await d1AdvancedFilterMiddleware(env, undefined, SITE)(
    "dimension",
    query,
    async (prepared) => prepared,
  );
  const filters = (forwarded as OverviewTestQuery).filters ?? query.filters;
  if (!filters)
    throw new Error("wave95s_legacy_dimension_channel_filters_missing");
  const limit =
    typeof query.limit === "number" && Number.isFinite(query.limit)
      ? query.limit
      : 100;
  const sortBy =
    query.sort === "sessions" || query.sort === "visitors"
      ? query.sort
      : "views";
  const sortDirection = query.direction === "asc" ? "asc" : "desc";
  const search = query.search || undefined;
  const cursor = await decodeDimensionCursor(
    env,
    SITE,
    WINDOW,
    filters,
    PAGE_DIMENSION_SELECTIONS.trafficChannel,
    search,
    query.cursor || null,
    query.context.policy.audience,
    sortBy,
    sortDirection,
  );
  const page = await queryDimensionPageFromD1(
    env,
    SITE,
    WINDOW,
    filters,
    limit,
    PAGE_DIMENSION_SELECTIONS.trafficChannel,
    {
      excludeEmpty: true,
      ...(search !== undefined ? { search } : {}),
      sortBy,
      sortDirection,
    },
    cursor,
    undefined,
    query.context.policy.audience,
  );
  return { dto: overviewDto(query.tab, page), filters };
}

function qualifiedQuery(
  query: OverviewTestQuery,
  normalized: NormalizedOverviewPageTableRequest,
) {
  return {
    siteId: SITE,
    queryTime: query.time,
    filters: query.filters!,
    ...(query.scopePlan ? { scopePlan: query.scopePlan } : {}),
    family: "overview-tab" as const,
    tab: normalized.tab,
    selection: normalized.selection,
    limit: normalized.limit,
    cursor: null,
    cursorToken: normalized.cursorText,
    ...(normalized.search !== undefined ? { search: normalized.search } : {}),
    sortBy: normalized.sortBy,
    sortDirection: normalized.sortDirection,
    excludeEmpty: normalized.excludeEmpty,
    audience: query.context.policy.audience,
  } as const;
}

function testEnvWithControlBehavior(
  database: DatabaseSync,
  trace: SqliteD1Trace,
  behavior:
    "missing-control" | "duplicate-control" | "wrong-control-scope" | "observe",
  observed?: { controlRows?: number; reportRows?: number },
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
          if (observed) {
            observed.controlRows = result.results.filter(
              (row) => row.rowKind === "control",
            ).length;
            observed.reportRows = result.results.filter(
              (row) => row.rowKind === "report",
            ).length;
          }
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
          throw new Error("wave95l_sqlite_report_failure");
        },
      });
      return replacement;
    },
  } as unknown as D1Database;
  return { DB, MAIN_SECRET: CURSOR_SECRET } as unknown as Env;
}

function recordEvidence(kind: string, values: Record<string, unknown>): void {
  evidence.push({ kind, ...values });
}

function recordChannelEvidence(
  kind: string,
  values: Record<string, unknown>,
): void {
  channelEvidence.push({ kind, ...values });
}

afterAll(async () => {
  for (const database of databases) database.close();
  const staleBooleanArtifactDir = process.env.WAVE97DK_ARTIFACT_DIR;
  if (staleBooleanArtifactDir) {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(staleBooleanArtifactDir, { recursive: true });
    await writeFile(
      `${staleBooleanArtifactDir}/overview-page-tabs-stale-tests.json`,
      JSON.stringify(
        {
          planSha256:
            "BAA4E00D0A9B9B2A552779E0E1ACAFB64D305C163E5329AEBCE4234CF93C2241",
          evidence,
        },
        null,
        2,
      ),
      "utf8",
    );
  }
  const legacyArtifactDir = process.env.WAVE95L_ARTIFACT_DIR;
  const channelArtifactDir = process.env.WAVE95S_ARTIFACT_DIR;
  const wholeBooleanArtifactDir = process.env.WAVE97DH_ARTIFACT_DIR;
  if (!legacyArtifactDir && !channelArtifactDir && !wholeBooleanArtifactDir)
    return;
  const { mkdir, writeFile } = await import("node:fs/promises");
  if (legacyArtifactDir) {
    await mkdir(legacyArtifactDir, { recursive: true });
    await writeFile(
      `${legacyArtifactDir}/overview-page-table-regression-evidence.json`,
      JSON.stringify({ planSha256: PLAN_SHA256, evidence }, null, 2),
      "utf8",
    );
  }
  if (channelArtifactDir) {
    await mkdir(channelArtifactDir, { recursive: true });
    await writeFile(
      `${channelArtifactDir}/channel-overview-qualification-evidence.json`,
      JSON.stringify(
        { planSha256: WAVE95S_PLAN_SHA256, evidence: channelEvidence },
        null,
        2,
      ),
      "utf8",
    );
  }
  if (wholeBooleanArtifactDir) {
    await mkdir(wholeBooleanArtifactDir, { recursive: true });
    await writeFile(
      `${wholeBooleanArtifactDir}/channel-overview-whole-boolean-evidence.json`,
      JSON.stringify({ evidence: wholeBooleanEvidence }, null, 2),
      "utf8",
    );
  }
});

describe("qualified single-period overview page tables", () => {
  const wave95lOverviewTabCohort = [
    "page.path",
    "page.query",
    "page.title",
    "page.hostname",
  ] as const;
  const overviewCases = wave95lOverviewTabCohort.flatMap((tab) =>
    (["session", "visitor"] as const).map((scope) => ({ tab, scope })),
  );

  it.each(overviewCases)(
    "matches the full legacy overview DTO and compiled SQL for $tab/$scope",
    async ({ tab, scope }) => {
      const { database } = createFixture();
      const query = queryFor(scope, { tab });
      const oldTrace = traceFor();
      const legacy = await legacyOverviewTableFor(database, query, oldTrace);
      expect(legacy.deferred).toBeDefined();
      if (!legacy.deferred || !legacy.normalized)
        throw new Error("wave95l_overview_deferred_missing");
      const q = qualifiedQuery(query, legacy.normalized);
      const compiled = compilePageDimensionQualificationProgram({
        deferred: legacy.deferred,
        query: q,
      });
      expect(compiled.kind).toBe("compiled");
      if (compiled.kind !== "compiled")
        throw new Error("wave95l_overview_compile_unavailable");
      const qualification = buildPageDimensionQualificationPlan({
        siteId: SITE,
        queryTime: query.time,
        filters: query.filters!,
        scopePlan: query.scopePlan!,
        count: legacy.deferred.countInput,
        options: {
          selection: legacy.normalized.selection,
          limit: legacy.normalized.limit,
          cursor: null,
          ...(legacy.normalized.search !== undefined
            ? { search: legacy.normalized.search }
            : {}),
          sortBy: legacy.normalized.sortBy,
          sortDirection: legacy.normalized.sortDirection,
          excludeEmpty: legacy.normalized.excludeEmpty,
        },
      });
      const logicalGraph = JSON.stringify(qualification.plan, null, 2);
      const physicalPlan = JSON.stringify(
        compiled.evidence.physicalPlanShape ?? null,
      );
      const runtimeTrace = traceFor();
      const diagnostics = createD1ReadDiagnostics();
      const provider = createD1SiteProviderRegistry({
        env: testEnv(database, runtimeTrace),
        siteId: SITE,
        diagnostics,
      }).resolve("dimension");
      if (!provider) throw new Error("wave95l_overview_provider_missing");
      const actual = await provider.execute(query);
      expect(actual.value).toEqual(legacy.dto);
      expect((actual.value as typeof legacy.dto).data.pagination.limit).toBe(
        100,
      );
      expect(runtimeTrace.preparedSql).toHaveLength(2);
      expect(runtimeTrace.preparedSql[1]).toBe(compiled.evidence.sql);
      expect(runtimeTrace.bindings[1]).toEqual(compiled.evidence.bindings);
      expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
      const expectedSelections = {
        "page.path": "pagePath",
        "page.query": "pageQuery",
        "page.title": "pageTitle",
        "page.hostname": "pageHostname",
      } as const;
      expect(legacy.normalized.selection.id).toBe(expectedSelections[tab]);
      expect(legacy.normalized.selection).toMatchObject({
        kind: "stored",
        normalization: "raw",
      });
      expect(legacy.normalized.excludeEmpty).toBe(true);
      const whitespaceQueryValue = database
        .prepare("SELECT query_string FROM visits WHERE visit_id = ?")
        .get("visit-a2") as { readonly query_string: string };
      expect(whitespaceQueryValue.query_string).toBe("  ");
      const items = (actual.value as typeof legacy.dto).data.items;
      const values = items.map((row) =>
        tab === "page.query"
          ? "value" in row
            ? row.value
            : undefined
          : "label" in row
            ? row.label
            : undefined,
      );
      expect(values).not.toContain("");
      if (tab === "page.query") expect(values).not.toContain("  ");
      if (tab === "page.query" && scope === "visitor") {
        expect(values).toContain("q=%2F");
        expect(values).toContain("campaign=one%2Ftwo");
      }
      if (tab === "page.path") expect(values).toContain(" /second");
      if (tab === "page.title") expect(values).toContain(" Raw title ");
      if (tab === "page.hostname") expect(values).toContain(" host.example ");
      if (tab === "page.query")
        for (const row of items)
          expect(Object.keys(row).sort()).toEqual(
            ["label", "sessions", "value", "views", "visitors"].sort(),
          );
      const physicalShape = JSON.stringify({
        sql: compiled.evidence.sql,
        bindings: compiled.evidence.bindings,
      });
      recordEvidence("default-overview-table", {
        tab,
        scope,
        family: legacy.normalized.family,
        selection: legacy.normalized.selection,
        excludeEmpty: legacy.normalized.excludeEmpty,
        rawWhitespaceQueryInput: whitespaceQueryValue.query_string,
        rawWhitespaceQueryExcludedByLegacyEmptyRule: true,
        actualDto: actual.value,
        legacyDto: legacy.dto,
        statementCount: runtimeTrace.preparedSql.length,
        statementTag: compiled.evidence.statementTag,
        sqlBytes: compiled.evidence.sqlBytes,
        bindingCount: compiled.evidence.bindingCount,
        sqlSha256: createHash("sha256")
          .update(compiled.evidence.sql, "utf8")
          .digest("hex"),
        compiledPhysicalSha256: createHash("sha256")
          .update(physicalShape, "utf8")
          .digest("hex"),
        physicalPlanSha256: createHash("sha256")
          .update(physicalPlan, "utf8")
          .digest("hex"),
        logicalGraphSha256: createHash("sha256")
          .update(logicalGraph, "utf8")
          .digest("hex"),
        rootKind: compiled.evidence.rootKind,
        physicalScanKinds: compiled.evidence.physicalScanKinds,
        sharedRelationCount: compiled.evidence.sharedRelationCount,
        groupWidth: compiled.evidence.groupWidth,
        admission: {
          primaryReportSourceRelationId:
            qualification.primaryReportSourceRelationId,
          reportSourceRelations: qualification.reportSourceRelations,
          matchesRelationId: qualification.matchesRelationId,
          controlsRelationId: qualification.controlsRelationId,
          groupedSummaryRelationId: qualification.groupedSummaryRelationId,
          controlOutputId: qualification.controlOutputId,
          reportOutputIds: qualification.reportOutputIds,
          scope: qualification.scope,
        },
        compileEvidence: compiled.evidence,
        logicalGraph,
        sql: compiled.evidence.sql,
        bindings: compiled.evidence.bindings,
        legacyStatements: oldTrace.preparedSql.map((sql, index) => ({
          sql,
          sqlSha256: createHash("sha256").update(sql, "utf8").digest("hex"),
          bindings: oldTrace.bindings[index] ?? [],
        })),
      });
    },
  );

  const cursorChainCases = (["page.path", "page.query"] as const).flatMap(
    (tab) =>
      (["session", "visitor"] as const).flatMap((scope) =>
        (["views", "sessions", "visitors"] as const).flatMap((sort) =>
          (["asc", "desc"] as const).map((direction) => ({
            tab,
            scope,
            sort,
            direction,
          })),
        ),
      ),
  );

  it.each(cursorChainCases)(
    "walks the complete legacy cursor chain for $tab/$scope/$sort/$direction",
    async ({ tab, scope, sort, direction }) => {
      const { database } = createFixture();
      const trace = traceFor();
      const provider = createD1SiteProviderRegistry({
        env: testEnv(database, trace),
        siteId: SITE,
      }).resolve("dimension");
      if (!provider) throw new Error("wave95l_overview_provider_missing");

      const maximumPages = 10;
      const actualPages: CursorOverviewDto[] = [];
      const pageEvidence: Array<Record<string, unknown>> = [];
      let cursor: string | null = null;
      let finished = false;
      for (let pageNumber = 0; pageNumber < maximumPages; pageNumber += 1) {
        const query = queryFor(scope, {
          tab,
          limit: 1,
          cursor,
          sort,
          direction,
        });
        const oldTrace = traceFor();
        const legacy = await legacyOverviewTableFor(database, query, oldTrace);
        expect(legacy.deferred).toBeDefined();
        expect(legacy.normalized).toBeDefined();
        if (!legacy.deferred || !legacy.normalized)
          throw new Error("wave95l_cursor_chain_legacy_deferred_missing");

        const statementOffset = trace.preparedSql.length;
        const execution = await provider.execute(query);
        const actual = execution.value as CursorOverviewDto;
        expect(actual).toEqual(legacy.dto);
        expect(trace.preparedSql.length - statementOffset).toBe(2);
        expect(actual.data.pagination.limit).toBe(1);
        expect(actual.data.pagination.returned).toBe(actual.data.items.length);
        expect(actual.data.pagination.returned).toBe(1);
        expect(actual.data.pagination.hasMore).toBe(
          actual.data.pagination.nextCursor !== null,
        );
        expect(oldTrace.preparedSql.length).toBeGreaterThanOrEqual(3);

        const pageCursor = legacy.dto.data.pagination.nextCursor;
        expect(actual.data.pagination.nextCursor).toBe(pageCursor);
        actualPages.push(actual);
        pageEvidence.push({
          pageNumber,
          inputCursor: cursor,
          actualDto: actual,
          legacyDto: legacy.dto,
          oldStatementCount: oldTrace.preparedSql.length,
          oldStatements: oldTrace.preparedSql.map((sql, index) => ({
            sqlSha256: createHash("sha256").update(sql, "utf8").digest("hex"),
            bindingCount: oldTrace.bindings[index]?.length ?? 0,
          })),
          runtimeStatementCount: trace.preparedSql.length - statementOffset,
          runtimeSqlSha256: trace.preparedSql
            .slice(statementOffset)
            .map((sql) =>
              createHash("sha256").update(sql, "utf8").digest("hex"),
            ),
        });

        if (pageCursor === null) {
          expect(actual.data.pagination.hasMore).toBe(false);
          expect(actual.data.pagination.nextCursor).toBeNull();
          finished = true;
          break;
        }
        expect(pageNumber + 1).toBeLessThan(maximumPages);
        cursor = pageCursor;
      }
      expect(finished).toBe(true);

      const fullQuery = queryFor(scope, {
        tab,
        limit: 100,
        sort,
        direction,
      });
      const fullLegacy = await legacyOverviewTableFor(
        database,
        fullQuery,
        traceFor(),
      );
      const allActualItems = actualPages.flatMap((page) => page.data.items);
      const key = (row: CursorOverviewItem) =>
        tab === "page.query" ? (row.value ?? "") : (row.label ?? "");
      const actualKeys = allActualItems.map(key);
      const fullItems = [...fullLegacy.dto.data.items];
      const expectedKeys = fullItems.map(key);
      expect(expectedKeys.length).toBeGreaterThan(1);
      expect(actualKeys).toEqual(expectedKeys);
      expect(new Set(actualKeys).size).toBe(actualKeys.length);
      expect(actualPages).toHaveLength(fullItems.length);
      expect(actualPages.at(-1)?.data.pagination.hasMore).toBe(false);
      expect(actualPages.at(-1)?.data.pagination.nextCursor).toBeNull();

      const secondary = sort === "views" ? "sessions" : "views";
      const directionFactor = direction === "asc" ? 1 : -1;
      const sortedExpectedKeys = [...fullItems]
        .sort((left, right) => {
          const primaryDifference =
            ((left[sort] ?? 0) - (right[sort] ?? 0)) * directionFactor;
          if (primaryDifference !== 0) return primaryDifference;
          const secondaryDifference =
            ((left[secondary] ?? 0) - (right[secondary] ?? 0)) *
            directionFactor;
          if (secondaryDifference !== 0) return secondaryDifference;
          const leftKey = key(left);
          const rightKey = key(right);
          return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
        })
        .map(key);
      expect(actualKeys).toEqual(sortedExpectedKeys);
      const tiedMetricTuples = fullItems.map(
        (row) => `${row[sort] ?? 0}\u0000${row[secondary] ?? 0}`,
      );
      expect(new Set(tiedMetricTuples).size).toBeLessThan(fullItems.length);

      recordEvidence("overview-complete-cursor-chain", {
        tab,
        scope,
        sort,
        direction,
        pages: pageEvidence,
        fullLegacyDto: fullLegacy.dto,
        actualKeys,
        expectedKeys,
        sortedExpectedKeys,
        exactOrderAndNoDuplicates: true,
        metricTieTupleCount: new Set(tiedMetricTuples).size,
        rawQueryValuesPreserved: tab === "page.query",
        completedAtNullCursor: true,
      });
    },
  );

  it("invalidates cursors across tab, sort, search, and audience bindings", async () => {
    const { database } = createFixture();
    const provider = createD1SiteProviderRegistry({
      env: testEnv(database, traceFor()),
      siteId: SITE,
    }).resolve("dimension");
    if (!provider) throw new Error("wave95l_overview_provider_missing");
    const initial = await provider.execute(
      queryFor("visitor", { tab: "page.path", limit: 1 }),
    );
    const cursor = (
      initial.value as { data: { pagination: { nextCursor: string | null } } }
    ).data.pagination.nextCursor;
    if (!cursor) throw new Error("wave95l_overview_cursor_missing");
    const invalidCases = [
      queryFor("visitor", { tab: "page.title", limit: 1, cursor }),
      queryFor("visitor", {
        tab: "page.path",
        limit: 1,
        cursor,
        sort: "sessions",
      }),
      queryFor("visitor", {
        tab: "page.path",
        limit: 1,
        cursor,
        search: "landing",
      }),
      queryFor("visitor", {
        tab: "page.path",
        limit: 1,
        cursor,
        audience: "api-v1",
      }),
    ];
    for (const query of invalidCases)
      await expect(provider.execute(query)).rejects.toBeInstanceOf(
        InvalidCursorError,
      );
    recordEvidence("overview-cursor-binding-rejections", {
      invalidatedBindings: ["tab", "sort", "search", "audience"],
      allRejected: true,
    });
  });

  it.each([
    { tab: "page.path", search: "LANDING" },
    { tab: "page.query", search: " " },
    { tab: "page.query", search: "ONE%2F" },
    { tab: "page.title", search: "no-such-title" },
  ] as const)(
    "matches the legacy search for $tab/$search",
    async ({ tab, search }) => {
      const { database } = createFixture();
      const query = queryFor("visitor", {
        tab,
        search,
      });
      const legacy = await legacyOverviewTableFor(database, query, traceFor());
      const trace = traceFor();
      const provider = createD1SiteProviderRegistry({
        env: testEnv(database, trace),
        siteId: SITE,
      }).resolve("dimension");
      if (!provider) throw new Error("wave95l_overview_provider_missing");
      const actual = await provider.execute(query);
      expect(actual.value).toEqual(legacy.dto);
      expect(trace.preparedSql).toHaveLength(2);
      recordEvidence("overview-search", { tab, search, dto: actual.value });
    },
  );

  it("qualifies only allowlisted single-period overview tabs with safe limits and matching context", async () => {
    const { database } = createFixture();
    const env = testEnv(database, traceFor());
    const eligible = queryFor("session", { tab: "page.path" });
    const middleware = d1AdvancedFilterMiddleware(env, undefined, SITE);
    const forward = async (query: OverviewTestQuery) =>
      middleware("dimension", query, async (prepared) => prepared, undefined);
    const eligibleForwarded = await forward(eligible);
    const eligibleDeferred =
      deferredOverviewPageTableQualificationFromQuery(eligibleForwarded);
    expect(eligibleDeferred?.overviewPageTableRequest.tab).toBe("page.path");

    const mismatchedTab = queryFor("session", { tab: "page.query" });
    const normalizedMismatch = normalizedRequest(mismatchedTab);
    if (!eligibleDeferred || !normalizedMismatch)
      throw new Error("wave95l_context_mismatch_setup_invalid");
    let mismatchError: unknown;
    try {
      compilePageDimensionQualificationProgram({
        deferred: eligibleDeferred,
        query: qualifiedQuery(mismatchedTab, normalizedMismatch),
      });
    } catch (error) {
      mismatchError = error;
    }
    expect(mismatchError).toMatchObject({
      domainError: {
        issues: [
          { path: "query", code: "page_dimension_request_context_mismatch" },
        ],
      },
    });

    const wholeBooleanCases = [
      {
        kind: "mixed-or",
        filterDsl:
          'page.path eq "/landing" or count(event { event.name eq "qualifier" }) eq 1',
      },
      {
        kind: "mixed-not",
        filterDsl:
          'not (page.path eq "/excluded" and count(event { event.name eq "qualifier" }) eq 1)',
      },
    ] as const;
    const admittedWholeBoolean: Array<Record<string, unknown>> = [];
    for (const { kind, filterDsl } of wholeBooleanCases) {
      const query = queryFor("session", { tab: "page.path", filterDsl });
      const forwarded = await forward(query);
      const deferred =
        deferredOverviewPageTableQualificationFromQuery(forwarded);
      const descriptor = overviewPageTableDescriptor(query.tab);
      if (!descriptor) throw new Error("wave97dk_page_path_descriptor_missing");
      expect(deferred?.pageDimensionFilterMode).toBe("allow-whole-filter");
      expect(deferred?.overviewPageTableRequest).toMatchObject({
        mode: "overview-tab",
        tab: query.tab,
        family: descriptor.family,
        selection: descriptor.selection,
        excludeEmpty: descriptor.excludeEmpty,
      });
      admittedWholeBoolean.push({
        kind,
        filterDsl,
        audience: query.context.policy.audience,
        tab: query.tab,
        family: deferred?.overviewPageTableRequest?.family,
        selection: deferred?.overviewPageTableRequest?.selection,
        excludeEmpty: deferred?.overviewPageTableRequest?.excludeEmpty,
        pageDimensionFilterMode: deferred?.pageDimensionFilterMode,
      });
    }

    const excluded = [
      queryFor("session", { tab: "page.unknown" }),
      queryFor("session", { tab: "page.entry" }),
      queryFor("session", { tab: "page.exit" }),
      queryFor("session", { tab: "source.channel" }),
      queryFor("session", { tab: "source.referrer" }),
      queryFor("session", {
        tab: "page.path",
        limit: 1.5,
      }),
      queryFor("session", {
        tab: "page.path",
        audience: "api-v1",
        filterDsl: wholeBooleanCases[0].filterDsl,
      }),
      queryFor("session", {
        tab: "page.path",
        audience: "api-v1",
        filterDsl: wholeBooleanCases[1].filterDsl,
      }),
      queryFor("session", {
        tab: "page.path",
        audience: "public-share",
        filterDsl: wholeBooleanCases[0].filterDsl,
      }),
      queryFor("session", {
        tab: "page.path",
        audience: "public-share",
        filterDsl: wholeBooleanCases[1].filterDsl,
      }),
      { ...eligible, comparison: { metric: "views" } } as OverviewTestQuery,
      {
        ...eligible,
        current: { time: TIME },
        reference: { time: TIME },
      } as OverviewTestQuery,
    ];
    for (const query of excluded) {
      const forwarded = await forward(query);
      expect(
        deferredOverviewPageTableQualificationFromQuery(forwarded),
      ).toBeUndefined();
    }

    const publicShareQuery = queryFor("session", {
      tab: "page.path",
      audience: "public-share",
      filterDsl: 'page.path neq "/excluded"',
    });
    const publicShareForwarded = await forward(publicShareQuery);
    expect(
      deferredOverviewPageTableQualificationFromQuery(publicShareForwarded),
    ).toBeUndefined();

    await expect(
      d1AdvancedFilterMiddleware(env, undefined, "another-site")(
        "dimension",
        eligible,
        async (prepared) => prepared,
      ),
    ).rejects.toMatchObject({
      domainError: {
        issues: [
          { path: "siteId", code: "page_dimension_request_context_mismatch" },
        ],
      },
    });
    const mismatchedTime = {
      ...eligible,
      time: { ...TIME, capturedAtMs: TIME.capturedAtMs + 1 },
    } as OverviewTestQuery;
    await expect(forward(mismatchedTime)).rejects.toMatchObject({
      domainError: {
        issues: [
          { path: "time", code: "page_dimension_request_context_mismatch" },
        ],
      },
    });

    recordEvidence("overview-qualification-gates", {
      eligibleTabs: ["page.path", "page.query", "page.title", "page.hostname"],
      admittedWholeBoolean,
      rejected: [
        "unknown-tab",
        "page.entry",
        "page.exit",
        "source-channel",
        "source-referrer",
        "fractional-limit",
        "api-v1-mixed-or",
        "api-v1-mixed-not",
        "public-share-mixed-or",
        "public-share-mixed-not",
        "comparison",
        "current-reference",
      ],
      expectedSiteMismatchRejected: true,
      requestTimeMismatchRejected: true,
      tabBrandMismatchRejected: true,
      publicShareNativeFilterRemainsLegacy: true,
    });
  });

  it("keeps a public-share Page tab on its legacy native-filter route", async () => {
    const { database } = createFixture();
    const query = queryFor("session", {
      tab: "page.path",
      audience: "public-share",
      filterDsl: 'page.path neq "/excluded"',
    });
    const oldTrace = traceFor();
    const legacy = await legacyOverviewTableFor(database, query, oldTrace);
    expect(legacy.deferred).toBeUndefined();
    const runtimeTrace = traceFor();
    const provider = createD1SiteProviderRegistry({
      env: testEnv(database, runtimeTrace),
      siteId: SITE,
    }).resolve("dimension");
    if (!provider) throw new Error("wave95l_public_share_provider_missing");
    const actual = await provider.execute(query);
    expect(actual.value).toEqual(legacy.dto);
    expect(runtimeTrace.preparedSql).toHaveLength(oldTrace.preparedSql.length);
    recordEvidence("overview-public-share-legacy-route", {
      audience: "public-share",
      dto: actual.value,
      statementCount: runtimeTrace.preparedSql.length,
      qualificationRejected: true,
    });
  });

  it.each([
    {
      name: "mixed OR",
      expectedWholeFilter: true,
      options: {
        filterDsl:
          'page.path eq "/landing" or count(event { event.name eq "qualifier" }) eq 1',
      },
    },
    { name: "comparison request", expectedWholeFilter: false, options: {} },
  ])(
    "uses the correct overview route for $name",
    async ({ name, expectedWholeFilter, options }) => {
      const { database } = createFixture();
      const base = queryFor("visitor", {
        tab: "page.path",
        limit: 2,
        ...options,
      });
      const query =
        name === "comparison request"
          ? ({ ...base, comparison: { metric: "views" } } as OverviewTestQuery)
          : base;
      const oldTrace = traceFor();
      const legacy = await legacyOverviewTableFor(database, query, oldTrace);
      expect(Boolean(legacy.deferred)).toBe(expectedWholeFilter);
      const runtimeTrace = traceFor();
      const provider = createD1SiteProviderRegistry({
        env: testEnv(database, runtimeTrace),
        siteId: SITE,
      }).resolve("dimension");
      if (!provider) throw new Error("wave95l_legacy_provider_missing");
      const actual = await provider.execute(query);
      expect(actual.value).toEqual(legacy.dto);
      if (expectedWholeFilter) {
        const deferred = legacy.deferred;
        const normalized = legacy.normalized;
        const descriptor = overviewPageTableDescriptor(query.tab);
        if (!deferred || !normalized || !descriptor)
          throw new Error("wave97dk_overview_whole_filter_setup_invalid");
        expect(deferred.pageDimensionFilterMode).toBe("allow-whole-filter");
        expect(deferred.overviewPageTableRequest).toMatchObject({
          mode: "overview-tab",
          tab: query.tab,
          family: descriptor.family,
          selection: descriptor.selection,
          excludeEmpty: descriptor.excludeEmpty,
        });
        const compiled = compilePageDimensionQualificationProgram({
          deferred,
          query: qualifiedQuery(query, normalized),
        });
        expect(compiled.kind).toBe("compiled");
        if (compiled.kind !== "compiled")
          throw new Error("wave97dk_overview_whole_filter_compile_missing");
        expect(runtimeTrace.preparedSql).toHaveLength(2);
        expect(runtimeTrace.bindings).toHaveLength(2);
        expect(runtimeTrace.preparedSql[0]).toContain('"sites"');
        expect(runtimeTrace.preparedSql[1]).toBe(compiled.evidence.sql);
        expect(runtimeTrace.bindings[1]).toEqual(compiled.evidence.bindings);
        expect(runtimeTrace.preparedSql[1]).toContain("rowKind");
        expect(runtimeTrace.preparedSql[1]).toContain("outputId");
      } else {
        expect(legacy.deferred).toBeUndefined();
        expect(runtimeTrace.preparedSql).toEqual(oldTrace.preparedSql);
        expect(runtimeTrace.bindings).toEqual(oldTrace.bindings);
      }
      recordEvidence("overview-route-by-case", {
        name,
        tab: query.tab,
        filterDsl: options.filterDsl ?? null,
        audience: query.context.policy.audience,
        expectedWholeFilter,
        actualDeferred: Boolean(legacy.deferred),
        pageDimensionFilterMode:
          legacy.deferred?.pageDimensionFilterMode ?? null,
        deferredTab: legacy.deferred?.overviewPageTableRequest?.tab ?? null,
        deferredFamily:
          legacy.deferred?.overviewPageTableRequest?.family ?? null,
        deferredSelection:
          legacy.deferred?.overviewPageTableRequest?.selection ?? null,
        legacyDto: legacy.dto,
        actualDto: actual.value,
        legacyStatementCount: oldTrace.preparedSql.length,
        actualStatementCount: runtimeTrace.preparedSql.length,
        legacyStatements: oldTrace.preparedSql.map((sql, index) => ({
          sql,
          bindings: oldTrace.bindings[index] ?? [],
        })),
        actualStatements: runtimeTrace.preparedSql.map((sql, index) => ({
          sql,
          bindings: runtimeTrace.bindings[index] ?? [],
        })),
      });
    },
  );

  it("retains the legacy invalid-limit behavior for a fractional overview limit", async () => {
    const { database } = createFixture();
    const query = queryFor("session", {
      tab: "page.path",
      limit: 1.5,
    });
    const oldTrace = traceFor();
    await expect(
      legacyOverviewTableFor(database, query, oldTrace),
    ).rejects.toThrow();
    const runtimeTrace = traceFor();
    const provider = createD1SiteProviderRegistry({
      env: testEnv(database, runtimeTrace),
      siteId: SITE,
    }).resolve("dimension");
    if (!provider) throw new Error("wave95l_invalid_limit_provider_missing");
    await expect(provider.execute(query)).rejects.toThrow();
    expect(runtimeTrace.preparedSql).toHaveLength(oldTrace.preparedSql.length);
    recordEvidence("overview-invalid-limit-legacy", {
      limit: 1.5,
      oldStatementCount: oldTrace.preparedSql.length,
      runtimeStatementCount: runtimeTrace.preparedSql.length,
      qualificationRejected: true,
    });
  });

  it("keeps an already aborted overview request at zero D1 reads", async () => {
    const { database } = createFixture();
    const trace = traceFor();
    const provider = createD1SiteProviderRegistry({
      env: testEnv(database, trace),
      siteId: SITE,
    }).resolve("dimension");
    if (!provider) throw new Error("wave95l_overview_provider_missing");
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.execute(queryFor("session"), { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(trace.preparedSql).toHaveLength(0);
    recordEvidence("overview-preabort", { statementCount: 0, rejected: true });
  });

  it("falls back once for numeric data and preserves the complete overview DTO", async () => {
    const { database } = createFixture();
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run(10, "visit-a1");
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "visit-a2");
    const query = queryFor("session", {
      tab: "page.path",
      filterDsl: `${BASE_FILTER} and count(page { page.durationMs gt 5 }) eq 1`,
    });
    const oldTrace = traceFor();
    const legacy = await legacyOverviewTableFor(database, query, oldTrace);
    expect(legacy.deferred).toBeDefined();
    if (!legacy.deferred || !legacy.normalized)
      throw new Error("wave95l_numeric_deferred_missing");
    const compiled = compilePageDimensionQualificationProgram({
      deferred: legacy.deferred,
      query: qualifiedQuery(query, legacy.normalized),
    });
    expect(compiled.kind).toBe("compiled");
    if (compiled.kind !== "compiled")
      throw new Error("wave95l_numeric_compile_unavailable");
    const trace = traceFor();
    const diagnostics = createD1ReadDiagnostics();
    const provider = createD1SiteProviderRegistry({
      env: testEnv(database, trace),
      siteId: SITE,
      diagnostics,
    }).resolve("dimension");
    if (!provider) throw new Error("wave95l_numeric_provider_missing");
    const actual = await provider.execute(query);
    expect(actual.value).toEqual(legacy.dto);
    expect(diagnostics.advancedCountSqlFallbackReason).toMatchObject({
      kind: "numeric-data-domain",
    });
    expect(trace.preparedSql).toHaveLength(oldTrace.preparedSql.length + 1);
    expect(trace.preparedSql).toContain(compiled.evidence.sql);
    const fusedRows = database
      .prepare(compiled.evidence.sql)
      .all(...(compiled.evidence.bindings as SQLInputValue[])) as Record<
      string,
      unknown
    >[];
    expect(fusedRows.filter((row) => row.rowKind === "control")).toHaveLength(
      1,
    );
    expect(fusedRows.filter((row) => row.rowKind === "report")).toHaveLength(0);
    recordEvidence("overview-numeric-fallback", {
      fallbackReason: diagnostics.advancedCountSqlFallbackReason,
      actualDto: actual.value,
      legacyDto: legacy.dto,
      oldStatementCount: oldTrace.preparedSql.length,
      runtimeStatementCount: trace.preparedSql.length,
      reportRowsFromRejectedFusion: 0,
      oneAdditionalFusedAttempt: true,
    });
  });

  it("preserves Count cap precedence for an invalid cursor over 20,000 activities", async () => {
    const database = createMigratedDatabase();
    databases.add(database);
    database.exec("PRAGMA foreign_keys = OFF");
    const site = addSite(database);
    const bulkCount = ADVANCED_FILTER_MAX_ACTIVITIES + 1;
    database
      .prepare(
        `WITH RECURSIVE generated(n) AS (
          SELECT 1 UNION ALL SELECT n + 1 FROM generated WHERE n < ?
        ) INSERT INTO visits (
          visit_id, site_id, site_pk, visitor_id, session_id, status,
          started_at, last_activity_at, pathname, hostname, duration_ms
        ) SELECT 'wave95l-cap-' || n, ?, ?, 'wave95l-cap-visitor',
          'wave95l-cap-session', 'closed', ?, ?, '/bulk', 'bulk.test', 10
          FROM generated`,
      )
      .run(bulkCount, SITE, site.pk, 125, 125);
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "wave95l-cap-1");
    const trace = traceFor();
    const diagnostics = createD1ReadDiagnostics();
    const provider = createD1SiteProviderRegistry({
      env: testEnv(database, trace),
      siteId: SITE,
      diagnostics,
    }).resolve("dimension");
    if (!provider) throw new Error("wave95l_cap_provider_missing");
    const query = queryFor("session", {
      tab: "page.path",
      cursor: "malformed-cursor",
      filterDsl:
        'page.path eq "/bulk" and count(page { page.durationMs gt 5 }) eq 1',
    });
    await expect(provider.execute(query)).rejects.toMatchObject({
      domainError: {
        issues: [{ path: "filters", code: "filter_activity_limit_exceeded" }],
      },
    });
    expect(trace.preparedSql).toHaveLength(2);
    expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
    const rows = database
      .prepare(trace.preparedSql[1]!)
      .all(...trace.bindings[1]!) as Record<string, unknown>[];
    const controls = rows.filter((row) => row.rowKind === "control");
    expect(controls).toHaveLength(1);
    expect(Number(controls[0]!.rawCount)).toBe(bulkCount);
    expect(rows.filter((row) => row.rowKind === "report")).toHaveLength(0);
    recordEvidence("overview-cap-before-cursor", {
      activityLimit: ADVANCED_FILTER_MAX_ACTIVITIES,
      rawCount: Number(controls[0]!.rawCount),
      reportRows: 0,
      errorCode: "filter_activity_limit_exceeded",
      statementCount: trace.preparedSql.length,
      fallbackReason: diagnostics.advancedCountSqlFallbackReason,
    });
  });

  it("propagates malformed control envelopes and SQLite errors without fallback", async () => {
    const malformed = [
      [
        "missing-control",
        "analytics_event_summary_qualification_control_row_invalid",
      ],
      [
        "duplicate-control",
        "analytics_event_summary_qualification_control_row_invalid",
      ],
      [
        "wrong-control-scope",
        "analytics_event_summary_qualification_control_kind_mismatch",
      ],
    ] as const;
    for (const [behavior, error] of malformed) {
      const { database } = createFixture();
      const trace = traceFor();
      const provider = createD1SiteProviderRegistry({
        env: testEnvWithControlBehavior(database, trace, behavior),
        siteId: SITE,
      }).resolve("dimension");
      if (!provider) throw new Error("wave95l_malformed_provider_missing");
      await expect(provider.execute(queryFor("session"))).rejects.toThrow(
        error,
      );
      expect(trace.preparedSql).toHaveLength(2);
      recordEvidence("overview-malformed-control", {
        behavior,
        error,
        statementCount: trace.preparedSql.length,
        fallbackRan: false,
      });
    }

    const { database } = createFixture();
    const trace = traceFor();
    const provider = createD1SiteProviderRegistry({
      env: testEnvWithSqliteFailure(database, trace),
      siteId: SITE,
    }).resolve("dimension");
    if (!provider) throw new Error("wave95l_sqlite_provider_missing");
    await expect(provider.execute(queryFor("session"))).rejects.toThrow(
      "wave95l_sqlite_report_failure",
    );
    expect(trace.preparedSql).toHaveLength(2);
    recordEvidence("overview-sqlite-error", {
      statementCount: trace.preparedSql.length,
      fallbackRan: false,
    });
  });
});

describe("qualified channels source.channel overview", () => {
  const channelSorts = ["views", "sessions", "visitors"] as const;
  const channelDirections = ["asc", "desc"] as const;
  const channelScopes = ["session", "visitor"] as const;
  const channelCursorCases = channelScopes.flatMap((scope) =>
    channelSorts.flatMap((sort) =>
      channelDirections.map((direction) => ({ scope, sort, direction })),
    ),
  );

  it("matches the Core fallback for a private Event candidate channel overview", async () => {
    const { database, site } = createFixture();
    seedChannelAttribution(database);
    seedWholeBooleanChannelCases(database, site);
    const query = queryFor("event", {
      operation: "channels",
      tab: "source.channel",
      filterDsl: WHOLE_BOOLEAN_OR_FILTER,
      limit: 2,
    });
    const legacyTrace = traceFor();
    const legacy = await legacyChannelOverviewTableFor(
      database,
      query,
      legacyTrace,
    );
    expect(legacy.deferred?.countInput.scope).toBe("event");
    expect(legacy.deferred?.countInput.candidateAnchor?.kind).toBe(
      "event-candidate",
    );
    expect(
      legacy.deferred && "eventCandidateReportProjection" in legacy.deferred
        ? legacy.deferred.eventCandidateReportProjection
        : undefined,
    ).toBe("page-visits");

    const runtimeTrace = traceFor();
    const diagnostics = createD1ReadDiagnostics();
    const provider = createD1SiteProviderRegistry({
      env: testEnv(database, runtimeTrace),
      siteId: SITE,
      diagnostics,
    }).resolve("channels");
    if (!provider)
      throw new Error("wave97ep_event_channel_overview_provider_missing");
    const actual = await provider.execute(query as never);
    expect(actual.value).toEqual(legacy.dto);
    expect((actual.value as CursorOverviewDto).data.items).toHaveLength(2);
    expect(runtimeTrace.preparedSql).toHaveLength(2);
    expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
    recordChannelEvidence("event-candidate-core-fallback", {
      legacyDto: legacy.dto,
      actualDto: actual.value,
      legacyStatements: legacyTrace.preparedSql.length,
      actualStatements: runtimeTrace.preparedSql.length,
      candidateProjection: "page-visits",
    });
  });

  it.each(channelScopes)(
    "compiles the actual channels operation and preserves the legacy DTO for %s scope",
    async (scope) => {
      const { database } = createFixture();
      seedChannelAttribution(database);
      const query = queryFor(scope, {
        operation: "channels",
        tab: "source.channel",
      });
      const oldTrace = traceFor();
      const legacy = await legacyChannelOverviewTableFor(
        database,
        query,
        oldTrace,
      );
      expect(legacy.normalized.selection.id).toBe("trafficChannel");
      expect(legacy.normalized.excludeEmpty).toBe(true);
      expect(legacy.dto.data.items.map((item) => item.label)).toEqual(
        expect.arrayContaining([
          "direct",
          "paid_search",
          "organic_search",
          "referral",
        ]),
      );

      const prepared = await d1AdvancedFilterMiddleware(
        testEnv(database, traceFor()),
        undefined,
        SITE,
      )("channels", query, async (value) => value);
      const deferred = deferredChannelOverviewQualificationFromQuery(prepared);
      expect(deferred?.operation).toBe("channel-overview");
      expect(
        deferredOverviewPageTableQualificationFromQuery(prepared),
      ).toBeUndefined();
      if (!deferred)
        throw new Error("wave95s_channel_overview_deferred_missing");
      const compiled = compilePageDimensionQualificationProgram({
        deferred,
        query: qualifiedQuery(query, legacy.normalized),
      });
      expect(compiled.kind).toBe("compiled");
      if (compiled.kind !== "compiled")
        throw new Error("wave95s_channel_overview_compile_unavailable");
      const logicalPlan = buildPageDimensionQualificationPlan({
        semanticOperation: "channels",
        siteId: SITE,
        queryTime: query.time,
        filters: query.filters!,
        scopePlan: query.scopePlan!,
        count: deferred.countInput,
        options: {
          selection: legacy.normalized.selection,
          limit: legacy.normalized.limit,
          cursor: null,
          sortBy: legacy.normalized.sortBy,
          sortDirection: legacy.normalized.sortDirection,
          excludeEmpty: true,
        },
      });

      const trace = traceFor();
      const provider = createD1SiteProviderRegistry({
        env: testEnv(database, trace),
        siteId: SITE,
      }).resolve("channels");
      if (!provider)
        throw new Error("wave95s_channel_overview_provider_missing");
      const actual = await provider.execute(query as never);
      expect(actual.value).toEqual(legacy.dto);
      expect(trace.preparedSql).toHaveLength(2);
      expect(trace.preparedSql[1]).toBe(compiled.evidence.sql);
      expect(trace.bindings[1]).toEqual(compiled.evidence.bindings);
      recordChannelEvidence("channel-overview-scope-compile", {
        scope,
        operation: deferred.operation,
        tab: deferred.overviewPageTableRequest.tab,
        selection: deferred.overviewPageTableRequest.selection,
        excludeEmpty: deferred.overviewPageTableRequest.excludeEmpty,
        returnedDto: actual.value,
        statementCount: trace.preparedSql.length,
        sql: compiled.evidence.sql,
        bindings: compiled.evidence.bindings,
        sqlBytes: Buffer.byteLength(compiled.evidence.sql, "utf8"),
        bindingCount: compiled.evidence.bindingCount,
        statementTag: compiled.evidence.statementTag,
        rootKind: compiled.evidence.rootKind,
        physicalScanKinds: compiled.evidence.physicalScanKinds,
        logicalPlanSha256: createHash("sha256")
          .update(JSON.stringify(logicalPlan.plan), "utf8")
          .digest("hex"),
        physicalPlanSha256: createHash("sha256")
          .update(
            JSON.stringify(compiled.evidence.physicalPlanShape ?? null),
            "utf8",
          )
          .digest("hex"),
        sourceRelation: logicalPlan.primaryReportSourceRelationId,
        reportOutputIds: logicalPlan.reportOutputIds,
      });
    },
  );

  it.each(channelScopes)(
    "preserves private whole Boolean OR channels pages and old signed cursors for %s scope",
    async (scope) => {
      const { database, site } = createFixture();
      seedChannelAttribution(database);
      seedWholeBooleanChannelCases(database, site);
      const expectedRows = independentChannelRows(database, scope, "or");
      expect(expectedRows.map(({ label }) => label)).toContain("email");
      expect(expectedRows.map(({ label }) => label)).toContain("paid_search");
      expect(expectedRows.map(({ label }) => label)).not.toContain("other");
      if (scope === "visitor")
        expect(
          expectedRows.find(({ label }) => label === "direct")?.sessions,
        ).toBeGreaterThan(1);
      const metricTies = expectedRows.map(({ views }) => views);
      expect(new Set(metricTies).size).toBeLessThan(metricTies.length);

      const firstQuery = queryFor(scope, {
        operation: "channels",
        tab: "source.channel",
        filterDsl: WHOLE_BOOLEAN_OR_FILTER,
        limit: 2,
        sort: "views",
        direction: "desc",
      });
      const prepareTrace = traceFor();
      const prepared = await d1AdvancedFilterMiddleware(
        testEnv(database, prepareTrace),
        undefined,
        SITE,
      )("channels", firstQuery, async (value) => value);
      const deferred = deferredChannelOverviewQualificationFromQuery(prepared);
      if (!deferred?.overviewPageTableRequest)
        throw new Error("wave97dh_channel_overview_deferred_missing");
      expect(deferred.pageDimensionFilterMode).toBe("allow-whole-filter");
      const normalized = normalizeOverviewPageTableRequest({
        operation: "channels",
        mode: firstQuery.mode,
        tab: firstQuery.tab,
        limit: firstQuery.limit,
        cursor: firstQuery.cursor,
        sort: firstQuery.sort,
        direction: firstQuery.direction,
        search: firstQuery.search,
      });
      if (!normalized)
        throw new Error("wave97dh_channel_overview_normalization_failed");
      const compiled = compilePageDimensionQualificationProgram({
        deferred,
        query: qualifiedQuery(firstQuery, normalized),
      });
      expect(compiled.kind).toBe("compiled");
      if (compiled.kind !== "compiled")
        throw new Error("wave97dh_channel_overview_compile_unavailable");
      const logicalPlan = buildPageDimensionQualificationPlan({
        semanticOperation: "channels",
        ...(deferred.pageDimensionFilterMode === "allow-whole-filter"
          ? { filterMode: "allow-whole-filter" as const }
          : {}),
        siteId: SITE,
        queryTime: firstQuery.time,
        filters: firstQuery.filters!,
        scopePlan: firstQuery.scopePlan!,
        count: deferred.countInput,
        options: {
          selection: normalized.selection,
          limit: normalized.limit,
          cursor: null,
          sortBy: normalized.sortBy,
          sortDirection: normalized.sortDirection,
          excludeEmpty: normalized.excludeEmpty,
        },
      });

      let cursor: string | null = null;
      const actualItems: CursorOverviewItem[] = [];
      const pages: Array<Record<string, unknown>> = [];
      let finished = false;
      for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
        const query = queryFor(scope, {
          operation: "channels",
          tab: "source.channel",
          filterDsl: WHOLE_BOOLEAN_OR_FILTER,
          limit: 2,
          cursor,
          sort: "views",
          direction: "desc",
        });
        const oldTrace = traceFor();
        const legacy = await legacyChannelOverviewTableFor(
          database,
          query,
          oldTrace,
        );
        const actualTrace = traceFor();
        const observed: { controlRows?: number; reportRows?: number } = {};
        const provider = createD1SiteProviderRegistry({
          env: testEnvWithControlBehavior(
            database,
            actualTrace,
            "observe",
            observed,
          ),
          siteId: SITE,
        }).resolve("channels");
        if (!provider)
          throw new Error("wave97dh_channel_overview_provider_missing");
        const actual = (await provider.execute(query as never))
          .value as CursorOverviewDto;
        expect(actual).toEqual(legacy.dto);
        expect(actualTrace.preparedSql).toHaveLength(2);
        expect(actualTrace.bindings).toHaveLength(2);
        if (pageNumber === 0) {
          expect(actualTrace.preparedSql[1]).toBe(compiled.evidence.sql);
          expect(actualTrace.bindings[1]).toEqual(compiled.evidence.bindings);
        }
        expect(observed.controlRows).toBe(1);
        expect(observed.reportRows).toBe(
          actual.data.items.length + (actual.data.pagination.hasMore ? 1 : 0),
        );
        expect(actual.data.pagination.returned).toBe(actual.data.items.length);
        expect(actual.data.pagination.hasMore).toBe(
          actual.data.pagination.nextCursor !== null,
        );
        actualItems.push(...actual.data.items);
        pages.push({
          pageNumber,
          inputCursor: cursor,
          oldSignedCursor: legacy.dto.data.pagination.nextCursor,
          legacyDto: legacy.dto,
          actualDto: actual,
          legacySql: oldTrace.preparedSql,
          legacyBindings: oldTrace.bindings,
          actualSql: actualTrace.preparedSql,
          actualBindings: actualTrace.bindings,
          observedControlRows: observed.controlRows,
          observedReportRows: observed.reportRows,
          reportEnvelopeHasNoFallback: actualTrace.preparedSql.length === 2,
        });
        const oldSignedCursor = legacy.dto.data.pagination.nextCursor;
        if (oldSignedCursor === null) {
          finished = true;
          break;
        }
        expect(pageNumber + 1).toBeLessThan(10);
        cursor = oldSignedCursor;
      }
      expect(finished).toBe(true);
      expect(pages.length).toBeGreaterThan(1);
      const actualRows = actualItems
        .map(({ label, views, sessions, visitors }) => ({
          label: label ?? "",
          views: views ?? 0,
          sessions: sessions ?? 0,
          visitors: visitors ?? 0,
        }))
        .sort((left, right) => left.label.localeCompare(right.label));
      expect(actualRows).toEqual(expectedRows);
      expect(new Set(actualRows.map(({ label }) => label)).size).toBe(
        actualRows.length,
      );
      wholeBooleanEvidence.push({
        mode: "overview-tab",
        scope,
        tab: "source.channel",
        filter: WHOLE_BOOLEAN_OR_FILTER,
        wholeFilterMode: deferred.pageDimensionFilterMode,
        selection: deferred.overviewPageTableRequest.selection,
        family: deferred.overviewPageTableRequest.family,
        excludeEmpty: deferred.overviewPageTableRequest.excludeEmpty,
        pages,
        independentExpected: expectedRows,
        actualRows,
        actualSqlBytes: Buffer.byteLength(compiled.evidence.sql, "utf8"),
        bindingCount: compiled.evidence.bindingCount,
        statementTag: compiled.evidence.statementTag,
        physicalScanKinds: compiled.evidence.physicalScanKinds,
        logicalPlanSha256: createHash("sha256")
          .update(JSON.stringify(logicalPlan.plan), "utf8")
          .digest("hex"),
        oldSignedCursorUsedForEveryContinuation: true,
        noMissingOrDuplicateRows: true,
      });

      const swappedSelection = {
        ...qualifiedQuery(firstQuery, normalized),
        selection: PAGE_DIMENSION_SELECTIONS.pagePath,
      };
      expect(() =>
        compilePageDimensionQualificationProgram({
          deferred,
          query: swappedSelection,
        }),
      ).toThrow();
    },
  );

  it.each(channelScopes)(
    "qualifies private Count NOT channels overview for %s scope",
    async (scope) => {
      const { database, site } = createFixture();
      seedChannelAttribution(database);
      seedWholeBooleanChannelCases(database, site);
      const query = queryFor(scope, {
        operation: "channels",
        tab: "source.channel",
        filterDsl: WHOLE_BOOLEAN_NOT_FILTER,
        limit: 100,
      });
      const oldTrace = traceFor();
      const legacy = await legacyChannelOverviewTableFor(
        database,
        query,
        oldTrace,
      );
      const trace = traceFor();
      const observed: { controlRows?: number; reportRows?: number } = {};
      const provider = createD1SiteProviderRegistry({
        env: testEnvWithControlBehavior(database, trace, "observe", observed),
        siteId: SITE,
      }).resolve("channels");
      if (!provider) throw new Error("wave97dh_channel_not_provider_missing");
      const actual = (await provider.execute(query as never))
        .value as CursorOverviewDto;
      const expectedRows = independentChannelRows(database, scope, "not");
      const actualRows = actual.data.items
        .map(({ label, views, sessions, visitors }) => ({
          label: label ?? "",
          views: views ?? 0,
          sessions: sessions ?? 0,
          visitors: visitors ?? 0,
        }))
        .sort((left, right) => left.label.localeCompare(right.label));
      expect(actual).toEqual(legacy.dto);
      expect(actualRows).toEqual(expectedRows);
      expect(actualRows.map(({ label }) => label)).toContain("email");
      expect(actualRows.map(({ label }) => label)).toContain("other");
      expect(trace.preparedSql).toHaveLength(2);
      expect(observed.controlRows).toBe(1);
      expect(observed.reportRows).toBe(actual.data.items.length);
      wholeBooleanEvidence.push({
        mode: "overview-tab",
        scope,
        tab: "source.channel",
        filter: WHOLE_BOOLEAN_NOT_FILTER,
        legacyDto: legacy.dto,
        actualDto: actual,
        independentExpected: expectedRows,
        legacySql: oldTrace.preparedSql,
        legacyBindings: oldTrace.bindings,
        actualSql: trace.preparedSql,
        actualBindings: trace.bindings,
        observedControlRows: observed.controlRows,
        observedReportRows: observed.reportRows,
        oneQualificationAndReportEnvelope: trace.preparedSql.length === 2,
      });
    },
  );

  it.each(channelCursorCases)(
    "walks all legacy signed cursor pages for $scope/$sort/$direction",
    async ({ scope, sort, direction }) => {
      const { database } = createFixture();
      seedChannelAttribution(database);
      const trace = traceFor();
      const provider = createD1SiteProviderRegistry({
        env: testEnv(database, trace),
        siteId: SITE,
      }).resolve("channels");
      if (!provider) throw new Error("wave95s_channel_cursor_provider_missing");

      let cursor: string | null = null;
      let finished = false;
      const actualItems: CursorOverviewItem[] = [];
      const pageEvidence: Array<Record<string, unknown>> = [];
      const maximumPages = 10;
      for (let pageNumber = 0; pageNumber < maximumPages; pageNumber += 1) {
        const query = queryFor(scope, {
          operation: "channels",
          tab: "source.channel",
          limit: 1,
          cursor,
          sort,
          direction,
        });
        const oldTrace = traceFor();
        const legacy = await legacyChannelOverviewTableFor(
          database,
          query,
          oldTrace,
        );
        const statementOffset = trace.preparedSql.length;
        const result = await provider.execute(query as never);
        const actual = result.value as CursorOverviewDto;
        expect(actual).toEqual(legacy.dto);
        expect(trace.preparedSql.length - statementOffset).toBe(2);
        expect(actual.data.pagination.limit).toBe(1);
        expect(actual.data.pagination.returned).toBe(actual.data.items.length);
        expect(actual.data.pagination.returned).toBe(1);
        expect(actual.data.pagination.hasMore).toBe(
          actual.data.pagination.nextCursor !== null,
        );
        expect(actual.data.pagination.nextCursor).toBe(
          legacy.dto.data.pagination.nextCursor,
        );
        actualItems.push(...actual.data.items);
        pageEvidence.push({
          pageNumber,
          inputCursor: cursor,
          actualDto: actual,
          legacyDto: legacy.dto,
          runtimeSql: trace.preparedSql.slice(statementOffset),
          runtimeBindings: trace.bindings.slice(statementOffset),
        });

        const oldCursor = legacy.dto.data.pagination.nextCursor;
        if (oldCursor === null) {
          expect(actual.data.pagination.hasMore).toBe(false);
          finished = true;
          break;
        }
        expect(pageNumber + 1).toBeLessThan(maximumPages);
        cursor = oldCursor;
      }
      expect(finished).toBe(true);

      const fullLegacy = await legacyChannelOverviewTableFor(
        database,
        queryFor(scope, {
          operation: "channels",
          tab: "source.channel",
          limit: 100,
          sort,
          direction,
        }),
        traceFor(),
      );
      const actualKeys = actualItems.map((item) => item.label ?? "");
      const expectedKeys = fullLegacy.dto.data.items.map(
        (item) => item.label ?? "",
      );
      expect(actualKeys).toEqual(expectedKeys);
      expect(new Set(actualKeys).size).toBe(actualKeys.length);
      expect(actualItems).toHaveLength(expectedKeys.length);
      expect(actualItems.at(-1)?.label).toBe(expectedKeys.at(-1));
      expect(expectedKeys.length).toBeGreaterThan(1);

      const secondary = sort === "visitors" ? "views" : "views";
      const directionFactor = direction === "asc" ? 1 : -1;
      const sortedExpectedKeys = [...fullLegacy.dto.data.items]
        .sort((left, right) => {
          const primaryDifference =
            ((left[sort] ?? 0) - (right[sort] ?? 0)) * directionFactor;
          if (primaryDifference !== 0) return primaryDifference;
          const secondaryDifference =
            ((left[secondary] ?? 0) - (right[secondary] ?? 0)) *
            directionFactor;
          if (secondaryDifference !== 0) return secondaryDifference;
          const leftKey = left.label ?? "";
          const rightKey = right.label ?? "";
          return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
        })
        .map((item) => item.label ?? "");
      expect(actualKeys).toEqual(sortedExpectedKeys);
      const metricTuples = fullLegacy.dto.data.items.map(
        (item) => `${item[sort] ?? 0}\u0000${item[secondary] ?? 0}`,
      );
      expect(new Set(metricTuples).size).toBeLessThan(metricTuples.length);
      recordChannelEvidence("channel-overview-cursor-chain", {
        scope,
        sort,
        direction,
        pages: pageEvidence,
        fullLegacyDto: fullLegacy.dto,
        actualKeys,
        expectedKeys,
        sortedExpectedKeys,
        noMissingOrDuplicateRows: true,
        oldSignedCursorUsedForNextRequest: true,
        tieTupleCount: new Set(metricTuples).size,
      });
    },
  );

  it("keeps channel qualification tied to the real operation and exact tab", async () => {
    const { database } = createFixture();
    seedChannelAttribution(database);
    const env = testEnv(database, traceFor());
    const channelQuery = queryFor("session", {
      operation: "channels",
      tab: "source.channel",
    });
    const channelMiddleware = d1AdvancedFilterMiddleware(env, undefined, SITE);
    const channelForwarded = await channelMiddleware(
      "channels",
      channelQuery,
      async (value) => value,
    );
    const deferred =
      deferredChannelOverviewQualificationFromQuery(channelForwarded);
    expect(deferred?.overviewPageTableRequest.selection.id).toBe(
      "trafficChannel",
    );
    expect(
      deferredChannelOverviewQualificationFromQuery(
        Object.assign({}, channelForwarded),
      ),
    ).toBeUndefined();
    expect(
      normalizeOverviewPageTableRequest({
        mode: "overview-tab",
        tab: "source.channel",
      }),
    ).toBeNull();
    expect(
      normalizeOverviewPageTableRequest({
        operation: "channels",
        mode: "overview-tab",
        tab: "page.path",
      }),
    ).toBeNull();

    const dimensionQuery = queryFor("session", { tab: "source.channel" });
    const dimensionForwarded = await channelMiddleware(
      "dimension",
      dimensionQuery,
      async (value) => value,
    );
    expect(
      deferredChannelOverviewQualificationFromQuery(dimensionForwarded),
    ).toBeUndefined();
    expect(
      deferredOverviewPageTableQualificationFromQuery(dimensionForwarded),
    ).toBeUndefined();

    const apiConjunctionQuery = queryFor("session", {
      operation: "channels",
      tab: "source.channel",
      audience: "api-v1",
    });
    const apiConjunctionForwarded = await channelMiddleware(
      "channels",
      apiConjunctionQuery,
      async (value) => value,
    );
    expect(
      deferredChannelOverviewQualificationFromQuery(apiConjunctionForwarded),
    ).toBeDefined();

    const normalized = normalizeOverviewPageTableRequest({
      operation: "channels",
      mode: channelQuery.mode,
      tab: channelQuery.tab,
      limit: channelQuery.limit,
      cursor: channelQuery.cursor,
      sort: channelQuery.sort,
      direction: channelQuery.direction,
      search: channelQuery.search,
    });
    if (!deferred || !normalized)
      throw new Error("wave95s_channel_mismatch_setup_invalid");
    const validQualifiedQuery = qualifiedQuery(channelQuery, normalized);
    const compileRejects = (query: typeof validQualifiedQuery) => {
      try {
        compilePageDimensionQualificationProgram({ deferred, query });
        return false;
      } catch {
        return true;
      }
    };
    expect(compileRejects({ ...validQualifiedQuery, tab: "page.path" })).toBe(
      true,
    );
    expect(
      compileRejects({
        ...validQualifiedQuery,
        selection: PAGE_DIMENSION_SELECTIONS.pagePath,
      }),
    ).toBe(true);
    expect(
      compileRejects({ ...validQualifiedQuery, cursorToken: "wrong-cursor" }),
    ).toBe(true);
    expect(
      compileRejects({
        ...validQualifiedQuery,
        queryTime: createQueryTime(120, 130, "UTC", 501),
      }),
    ).toBe(true);

    const rejectedRequests = [
      { ...channelQuery, mode: "list" },
      { ...channelQuery, tab: "source.referrer" },
      { ...channelQuery, comparison: { metric: "views" } },
      { ...channelQuery, current: { time: TIME } },
      { ...channelQuery, reference: { time: TIME } },
      queryFor("session", {
        operation: "channels",
        tab: "source.channel",
        audience: "public-share",
      }),
      queryFor("session", {
        operation: "channels",
        tab: "source.channel",
        audience: "api-v1",
        filterDsl:
          'page.path eq "/landing" or count(event { event.name eq "qualifier" }) gte 1',
      }),
      Object.defineProperty(
        queryFor("session", {
          operation: "channels",
          tab: "source.channel",
          filterDsl:
            'page.path eq "/landing" or count(event { event.name eq "qualifier" }) gte 1',
        }),
        "tab",
        { enumerable: true, get: () => "source.channel" },
      ),
    ] as const;
    for (const request of rejectedRequests) {
      const forwarded = await channelMiddleware(
        "channels",
        request,
        async (value) => value,
      );
      expect(
        deferredChannelOverviewQualificationFromQuery(forwarded),
      ).toBeUndefined();
    }

    recordChannelEvidence("channel-overview-operation-gates", {
      actualOperation: deferred?.operation,
      normalizedSourceChannelRequiresChannels: true,
      copiedRequestLosesPrivateBrand: true,
      wrongTabSelectionCursorAndTimeRejected: true,
      dimensionOperationRemainsLegacy: true,
      rejected: [
        "channels-list",
        "other-channel-tab",
        "comparison",
        "current",
        "reference",
        "public-share",
        "api-v1-mixed-native-count-or",
      ],
    });
  });

  it("preserves channels list, dimension source.channel, and invalid-limit behavior", async () => {
    const { database } = createFixture();
    seedChannelAttribution(database);
    const channelsBase = queryFor("session", {
      operation: "channels",
      tab: "source.channel",
      limit: 100,
    });
    const legacyListInput = {
      ...channelsBase,
      mode: "list",
    } as unknown as OverviewTestQuery;
    const channelForwarded = await d1AdvancedFilterMiddleware(
      testEnv(database, traceFor()),
      undefined,
      SITE,
    )("channels", legacyListInput, async (value) => value);
    expect(
      deferredChannelListQualificationFromQuery(channelForwarded),
    ).toBeDefined();
    expect(
      deferredChannelOverviewQualificationFromQuery(channelForwarded),
    ).toBeUndefined();
    const listTrace = traceFor();
    const listEnv = testEnv(database, listTrace);
    const listForwarded = await d1AdvancedFilterMiddleware(
      listEnv,
      undefined,
      SITE,
    )("pages", legacyListInput, async (value) => value);
    const listFilters = (listForwarded as OverviewTestQuery).filters;
    if (!listFilters) throw new Error("wave95s_channel_list_filters_missing");
    const expectedListRows = await queryChannelsFromD1(
      listEnv,
      SITE,
      WINDOW,
      listFilters,
      100,
    );
    const listProvider = createD1SiteProviderRegistry({
      env: testEnv(database, traceFor()),
      siteId: SITE,
    }).resolve("channels");
    if (!listProvider) throw new Error("wave95s_channel_list_provider_missing");
    const actualList = await listProvider.execute(legacyListInput as never);
    expect(actualList.value).toEqual({
      items: expectedListRows.map((row) => ({
        channel: row.channel,
        views: row.views,
        sessions: row.sessions,
        visitors: row.visitors,
      })),
    });

    const dimensionQuery = queryFor("visitor", {
      tab: "source.channel",
    });
    const oldDimension = await legacyDimensionChannelOverviewTableFor(
      database,
      dimensionQuery,
      traceFor(),
    );
    const dimensionTrace = traceFor();
    const dimensionProvider = createD1SiteProviderRegistry({
      env: testEnv(database, dimensionTrace),
      siteId: SITE,
    }).resolve("dimension");
    if (!dimensionProvider)
      throw new Error("wave95s_dimension_channel_provider_missing");
    const actualDimension = await dimensionProvider.execute(
      dimensionQuery as never,
    );
    expect(actualDimension.value).toEqual(oldDimension.dto);
    const preparedDimension = await d1AdvancedFilterMiddleware(
      testEnv(database, traceFor()),
      undefined,
      SITE,
    )("dimension", dimensionQuery, async (value) => value);
    expect(
      deferredChannelOverviewQualificationFromQuery(preparedDimension),
    ).toBeUndefined();

    const invalidLimitQuery = queryFor("visitor", {
      operation: "channels",
      tab: "source.channel",
      limit: 1.5,
    });
    await expect(
      legacyChannelOverviewTableFor(database, invalidLimitQuery, traceFor()),
    ).rejects.toThrow("logical_builder_invalid_limit");
    await expect(
      listProvider.execute(invalidLimitQuery as never),
    ).rejects.toThrow("logical_builder_invalid_limit");
    recordChannelEvidence("channel-overview-legacy-boundaries", {
      channelsListDto: actualList.value,
      channelsListHasSeparateQualificationBrand: true,
      channelsListUsesPageOverviewProof: false,
      dimensionChannelDto: actualDimension.value,
      dimensionChannelUsesChannelProof: false,
      fractionalLimitPreservesLegacyError: "logical_builder_invalid_limit",
    });
  });

  it("preserves default/search behavior and performs one numeric fallback", async () => {
    const { database } = createFixture();
    seedChannelAttribution(database);
    const defaultQuery = queryFor("visitor", {
      operation: "channels",
      tab: "source.channel",
    });
    const defaultLegacy = await legacyChannelOverviewTableFor(
      database,
      defaultQuery,
      traceFor(),
    );
    const defaultTrace = traceFor();
    const provider = createD1SiteProviderRegistry({
      env: testEnv(database, defaultTrace),
      siteId: SITE,
    }).resolve("channels");
    if (!provider) throw new Error("wave95s_channel_default_provider_missing");
    const defaultActual = await provider.execute(defaultQuery as never);
    expect(defaultActual.value).toEqual(defaultLegacy.dto);
    expect(defaultLegacy.dto.data.pagination.limit).toBe(100);

    for (const search of ["ORGANIC_SEARCH", " ", "no-such-channel"]) {
      const query = queryFor("visitor", {
        operation: "channels",
        tab: "source.channel",
        search,
      });
      const legacy = await legacyChannelOverviewTableFor(
        database,
        query,
        traceFor(),
      );
      const actual = await provider.execute(query as never);
      expect(actual.value).toEqual(legacy.dto);
    }

    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "visit-a2");
    const numericQuery = queryFor("session", {
      operation: "channels",
      tab: "source.channel",
      filterDsl: `${BASE_FILTER} and count(page { page.durationMs gt 5 }) eq 1`,
    });
    const numericOldTrace = traceFor();
    const numericLegacy = await legacyChannelOverviewTableFor(
      database,
      numericQuery,
      numericOldTrace,
    );
    const numericTrace = traceFor();
    const diagnostics = createD1ReadDiagnostics();
    const numericProvider = createD1SiteProviderRegistry({
      env: testEnv(database, numericTrace),
      siteId: SITE,
      diagnostics,
    }).resolve("channels");
    if (!numericProvider)
      throw new Error("wave95s_channel_numeric_provider_missing");
    const numericActual = await numericProvider.execute(numericQuery as never);
    expect(numericActual.value).toEqual(numericLegacy.dto);
    expect(diagnostics.advancedCountSqlFallbackReason).toMatchObject({
      kind: "numeric-data-domain",
    });
    expect(numericTrace.preparedSql.length).toBe(
      numericOldTrace.preparedSql.length + 1,
    );
    recordChannelEvidence("channel-overview-numeric-fallback", {
      fallbackReason: diagnostics.advancedCountSqlFallbackReason,
      legacyDto: numericLegacy.dto,
      actualDto: numericActual.value,
      oldStatementCount: numericOldTrace.preparedSql.length,
      actualStatementCount: numericTrace.preparedSql.length,
      actualStatements: numericTrace.preparedSql,
      actualBindings: numericTrace.bindings,
      fallbackDidNotChangeDto: true,
    });
  });

  it("keeps Count cap errors ahead of a malformed channel cursor", async () => {
    const database = createMigratedDatabase();
    databases.add(database);
    database.exec("PRAGMA foreign_keys = OFF");
    const site = addSite(database);
    const bulkCount = ADVANCED_FILTER_MAX_ACTIVITIES + 1;
    database
      .prepare(
        `WITH RECURSIVE generated(n) AS (
          SELECT 1 UNION ALL SELECT n + 1 FROM generated WHERE n < ?
        ) INSERT INTO visits (
          visit_id, site_id, site_pk, visitor_id, session_id, status,
          started_at, last_activity_at, pathname, hostname, duration_ms
        ) SELECT 'wave95s-cap-' || n, ?, ?, 'wave95s-cap-visitor',
          'wave95s-cap-session', 'closed', ?, ?, '/bulk', 'bulk.test', 10
          FROM generated`,
      )
      .run(bulkCount, SITE, site.pk, 125, 125);
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "wave95s-cap-1");

    const trace = traceFor();
    const diagnostics = createD1ReadDiagnostics();
    const provider = createD1SiteProviderRegistry({
      env: testEnv(database, trace),
      siteId: SITE,
      diagnostics,
    }).resolve("channels");
    if (!provider) throw new Error("wave95s_channel_cap_provider_missing");
    const query = queryFor("session", {
      operation: "channels",
      tab: "source.channel",
      cursor: "malformed-cursor",
      filterDsl:
        'page.path eq "/bulk" and count(page { page.durationMs gt 5 }) eq 1',
    });
    await expect(provider.execute(query as never)).rejects.toMatchObject({
      domainError: {
        issues: [{ path: "filters", code: "filter_activity_limit_exceeded" }],
      },
    });
    expect(trace.preparedSql).toHaveLength(2);
    expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
    const rows = database
      .prepare(trace.preparedSql[1]!)
      .all(...trace.bindings[1]!) as Record<string, unknown>[];
    const controls = rows.filter((row) => row.rowKind === "control");
    expect(controls).toHaveLength(1);
    expect(Number(controls[0]!.rawCount)).toBe(bulkCount);
    expect(rows.filter((row) => row.rowKind === "report")).toHaveLength(0);
    recordChannelEvidence("channel-overview-cap-before-cursor", {
      activityLimit: ADVANCED_FILTER_MAX_ACTIVITIES,
      rawCount: Number(controls[0]!.rawCount),
      reportRows: 0,
      errorCode: "filter_activity_limit_exceeded",
      statementCount: trace.preparedSql.length,
      fallbackReason: diagnostics.advancedCountSqlFallbackReason,
    });
  });

  it("propagates invalid controls and database failures without channel fallback", async () => {
    const malformed = [
      [
        "missing-control",
        "analytics_event_summary_qualification_control_row_invalid",
      ],
      [
        "duplicate-control",
        "analytics_event_summary_qualification_control_row_invalid",
      ],
      [
        "wrong-control-scope",
        "analytics_event_summary_qualification_control_kind_mismatch",
      ],
    ] as const;
    for (const [behavior, error] of malformed) {
      const { database } = createFixture();
      seedChannelAttribution(database);
      const trace = traceFor();
      const provider = createD1SiteProviderRegistry({
        env: testEnvWithControlBehavior(database, trace, behavior),
        siteId: SITE,
      }).resolve("channels");
      if (!provider)
        throw new Error("wave95s_channel_control_provider_missing");
      await expect(
        provider.execute(
          queryFor("session", {
            operation: "channels",
            tab: "source.channel",
          }) as never,
        ),
      ).rejects.toThrow(error);
      expect(trace.preparedSql).toHaveLength(2);
      recordChannelEvidence("channel-overview-malformed-control", {
        behavior,
        error,
        statementCount: trace.preparedSql.length,
        fallbackRan: false,
      });
    }

    const { database } = createFixture();
    seedChannelAttribution(database);
    const trace = traceFor();
    const provider = createD1SiteProviderRegistry({
      env: testEnvWithSqliteFailure(database, trace),
      siteId: SITE,
    }).resolve("channels");
    if (!provider) throw new Error("wave95s_channel_sqlite_provider_missing");
    await expect(
      provider.execute(
        queryFor("session", {
          operation: "channels",
          tab: "source.channel",
        }) as never,
      ),
    ).rejects.toThrow("wave95l_sqlite_report_failure");
    expect(trace.preparedSql).toHaveLength(2);
    recordChannelEvidence("channel-overview-sqlite-error", {
      statementCount: trace.preparedSql.length,
      fallbackRan: false,
    });
  });

  it("keeps a pre-aborted real channels overview at zero D1 reads", async () => {
    const { database } = createFixture();
    seedChannelAttribution(database);
    const trace = traceFor();
    const provider = createD1SiteProviderRegistry({
      env: testEnv(database, trace),
      siteId: SITE,
    }).resolve("channels");
    if (!provider) throw new Error("wave95s_channel_abort_provider_missing");
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.execute(
        queryFor("session", {
          operation: "channels",
          tab: "source.channel",
        }) as never,
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(trace.preparedSql).toHaveLength(0);
    recordChannelEvidence("channel-overview-pre-aborted", {
      statementCount: trace.preparedSql.length,
      errorName: "AbortError",
    });
  });
});
