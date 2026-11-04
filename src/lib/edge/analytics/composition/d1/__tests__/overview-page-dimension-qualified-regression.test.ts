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
  OVERVIEW_PAGE_TABLES,
  overviewPageTableDescriptor,
} from "@/lib/edge/analytics/engine/dimension-report-plan";
import { buildPageDimensionQualificationPlan } from "@/lib/edge/analytics/engine/page-dimension-qualification-plan";
import { resolveQualifiedSourceFilters } from "@/lib/edge/analytics/engine/qualified-page-source";
import {
  d1AdvancedFilterMiddleware,
  deferredOverviewPageTableQualificationFromQuery,
  prepareDeferredEventQualificationFallback,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { compilePageDimensionQualificationProgram } from "@/lib/edge/analytics/providers/d1/internal/analytics-qualification-program";
import {
  geoTabLabel,
  mapGeoTabs,
  mapTabs,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import {
  decodeDimensionCursor,
  queryDimensionPageFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/dimensions";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import type { FilterDocument } from "@/lib/filter-contract/filters";
import { InvalidCursorError } from "@/lib/pagination";

const SITE = "wave95k-overview-page-table";
const TIME = createQueryTime(120, 130, "UTC", 500);
const WINDOW = {
  startMs: 120,
  endExclusiveMs: 130,
  nowMs: 500,
  timeZone: "UTC",
} as const;
const CURSOR_SECRET = "wave95k-overview-page-table-test-secret";
const PLAN_SHA256 =
  "5e49473e1194fd07d0421dd5c984853012e4ba0388744cafb92a694e0f4da55f";
const CANONICAL_PLAN_SHA256 =
  "7520F7F8C7AA41974C614BA47162C84A2CC0FA9E50F6D7B2E9C18BB471D9E54A";
const BASE_FILTER =
  'page.path neq "/excluded" and count(event { event.name eq "qualifier" }) eq 1';
const databases = new Set<DatabaseSync>();
const evidence: Array<Record<string, unknown>> = [];

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
  readonly tab?: string;
  readonly limit?: number;
  readonly cursor?: string | null;
  readonly sort?: string;
  readonly direction?: "asc" | "desc";
  readonly search?: string;
  readonly audience?: "private-dashboard" | "api-v1";
  readonly filterDsl?: string;
}

const PRIVATE_PAGE_FIELDS = [
  "page.path",
  "page.title",
  "page.hostname",
] as const;

const PRIVATE_PAGE_FIELD_ROWS = [
  {
    visitId: "visit-a1",
    sessionId: "session-a",
    visitorId: "visitor-a",
    path: "/Native",
    title: " Alpha ",
    hostname: " Alpha.test ",
    query: " ?a=1 ",
    hash: "",
    utmSource: " News-A ",
    country: " US ",
    regionCode: "CA",
    region: "California",
    city: "San Francisco",
    browser: "Chrome",
    os: "Windows",
    osVersion: "11",
    screenWidth: 1920,
    screenHeight: 1080,
  },
  {
    visitId: "visit-a2",
    sessionId: "session-a",
    visitorId: "visitor-a",
    path: " /Other ",
    title: "Beta",
    hostname: "beta.test",
    query: "?a=2",
    hash: " #A ",
    utmSource: "",
    country: "US",
    regionCode: "ON",
    region: "Ontario",
    city: "Toronto",
    browser: "Firefox",
    os: "Linux",
    osVersion: "6.8",
    screenWidth: 1366,
    screenHeight: 768,
  },
  {
    visitId: "visit-a3",
    sessionId: "session-b",
    visitorId: "visitor-a",
    path: "/landing",
    title: "",
    hostname: "",
    query: "?A=3",
    hash: "#a",
    utmSource: " news-a ",
    country: " MX ",
    regionCode: "CMX",
    region: "Mexico City",
    city: "Cuauhtemoc",
    browser: "Safari",
    os: "iOS",
    osVersion: "18",
    screenWidth: 390,
    screenHeight: null,
  },
  {
    visitId: "visit-a4",
    sessionId: "session-c",
    visitorId: "visitor-a",
    path: "/Landing",
    title: "alpha",
    hostname: "ALPHA.test",
    query: " ?a=4 ",
    hash: "#A",
    utmSource: "Other",
    country: "US",
    regionCode: "CA",
    region: "California",
    city: "San Francisco",
    browser: "Edge",
    os: "Windows",
    osVersion: "10",
    screenWidth: 390,
    screenHeight: 844,
  },
  {
    visitId: "visit-excluded",
    sessionId: "session-x",
    visitorId: "visitor-x",
    path: "/excluded",
    title: "Hidden",
    hostname: "excluded.test",
    query: "?blocked",
    hash: "#blocked",
    utmSource: "Blocked",
    country: "GB",
    regionCode: "ENG",
    region: "England",
    city: "London",
    browser: "Chrome",
    os: "Windows",
    osVersion: "11",
    screenWidth: 1920,
    screenHeight: 1080,
  },
] as const;

function installPrivatePageFieldRows(database: DatabaseSync): void {
  const update = database.prepare(
    `UPDATE visits SET pathname = ?, title = ?, hostname = ?, query_string = ?,
      hash_fragment = ?, utm_source = ?, country = ?, region_code = ?, region = ?,
      city = ?, browser = ?, os = ?, os_version = ?, screen_width = ?, screen_height = ?
     WHERE visit_id = ?`,
  );
  for (const row of PRIVATE_PAGE_FIELD_ROWS)
    update.run(
      row.path,
      row.title,
      row.hostname,
      row.query,
      row.hash,
      row.utmSource,
      row.country,
      row.regionCode,
      row.region,
      row.city,
      row.browser,
      row.os,
      row.osVersion,
      row.screenWidth,
      row.screenHeight,
      row.visitId,
    );
}

function independentOverviewPageFieldItems(input: {
  readonly tab: (typeof PRIVATE_PAGE_FIELDS)[number];
  readonly filterKind: "mixed-or" | "mixed-not" | "count-only" | "neither";
  readonly scope: "session" | "visitor";
}) {
  const ownerIds = {
    "mixed-or": {
      session: new Set(["session-a", "session-b"]),
      visitor: new Set(["visitor-a"]),
    },
    "mixed-not": {
      session: new Set(["session-b", "session-c", "session-x"]),
      visitor: new Set(["visitor-x"]),
    },
    "count-only": {
      session: new Set(["session-a"]),
      visitor: new Set(["visitor-a"]),
    },
    neither: {
      session: new Set<string>(),
      visitor: new Set<string>(),
    },
  }[input.filterKind][input.scope];
  const field =
    input.tab === "page.path"
      ? "path"
      : input.tab === "page.title"
        ? "title"
        : "hostname";
  const groups = new Map<
    string,
    { readonly values: (typeof PRIVATE_PAGE_FIELD_ROWS)[number][] }
  >();
  for (const row of PRIVATE_PAGE_FIELD_ROWS) {
    const owner = input.scope === "session" ? row.sessionId : row.visitorId;
    if (!ownerIds.has(owner)) continue;
    const value = row[field];
    if (value === "") continue;
    const values = groups.get(value)?.values ?? [];
    groups.set(value, { values: [...values, row] });
  }
  return [...groups.entries()]
    .map(([label, group]) => ({
      label,
      views: group.values.length,
      sessions: new Set(group.values.map((row) => row.sessionId)).size,
      visitors: new Set(group.values.map((row) => row.visitorId)).size,
    }))
    .sort((left, right) =>
      left.label < right.label ? -1 : left.label > right.label ? 1 : 0,
    );
}

type CanonicalFilterKind =
  "mixed-or" | "mixed-not" | "native-only" | "count-only" | "neither";

const CANONICAL_FILTER_DSLS: Record<CanonicalFilterKind, string> = {
  "mixed-or":
    'page.path eq "/landing" or count(event { event.name eq "qualifier" }) eq 1',
  "mixed-not":
    'not (page.path eq "/Native" and count(event { event.name eq "qualifier" }) eq 1)',
  "native-only": 'page.path eq "/landing"',
  "count-only": 'count(event { event.name eq "qualifier" }) eq 1',
  neither:
    'page.path eq "/void" or count(event { event.name eq "absent" }) eq 1',
};

function independentCanonicalOverviewValue(
  row: (typeof PRIVATE_PAGE_FIELD_ROWS)[number],
  tab: string,
): string {
  const trimAscii = (value: string) => value.replace(/^ +| +$/gu, "");
  switch (tab) {
    case "page.query":
      return row.query;
    case "utm.source":
      return trimAscii(row.utmSource);
    case "geo.country":
      return row.country;
    case "geo.city": {
      const country = trimAscii(row.country);
      const regionCode = trimAscii(row.regionCode);
      const region = trimAscii(row.region);
      const city = trimAscii(row.city);
      if (!country && !regionCode && !region && !city) return "";
      return `${country}::${regionCode || region}::${region}::${city}`;
    }
    case "client.osVersion":
      return [row.os, row.osVersion].map(trimAscii).filter(Boolean).join(" ");
    case "client.screenSize":
      return row.screenWidth > 0 && row.screenHeight && row.screenHeight > 0
        ? `${row.screenWidth}x${row.screenHeight}`
        : "";
    case "client.browser":
      return trimAscii(row.browser);
    default:
      throw new Error(`wave97dg_unmodeled_independent_overview_tab:${tab}`);
  }
}

function independentCanonicalOverviewItems(input: {
  readonly tab: string;
  readonly filterKind: CanonicalFilterKind;
  readonly scope: "session" | "visitor";
}) {
  const ownerIds = {
    "mixed-or": {
      session: new Set(["session-a", "session-b"]),
      visitor: new Set(["visitor-a"]),
    },
    "mixed-not": {
      session: new Set(["session-b", "session-c", "session-x"]),
      visitor: new Set(["visitor-x"]),
    },
    "native-only": {
      session: new Set(["session-b"]),
      visitor: new Set(["visitor-a"]),
    },
    "count-only": {
      session: new Set(["session-a"]),
      visitor: new Set(["visitor-a"]),
    },
    neither: {
      session: new Set<string>(),
      visitor: new Set<string>(),
    },
  }[input.filterKind][input.scope];
  const descriptor = overviewPageTableDescriptor(input.tab);
  if (!descriptor)
    throw new Error("wave97dg_overview_descriptor_missing_for_oracle");
  const groups = new Map<
    string,
    { readonly values: (typeof PRIVATE_PAGE_FIELD_ROWS)[number][] }
  >();
  for (const row of PRIVATE_PAGE_FIELD_ROWS) {
    const owner = input.scope === "session" ? row.sessionId : row.visitorId;
    if (!ownerIds.has(owner)) continue;
    const key = independentCanonicalOverviewValue(row, input.tab);
    if (descriptor.excludeEmpty && !key.replace(/^ +| +$/gu, "")) continue;
    const values = groups.get(key)?.values ?? [];
    groups.set(key, { values: [...values, row] });
  }
  return [...groups.entries()]
    .map(([key, group]) => ({
      key,
      ...(descriptor.family === "geo"
        ? {
            label: geoTabLabel(
              key,
              input.tab.slice("geo.".length) as
                | "country"
                | "region"
                | "city"
                | "continent"
                | "timezone"
                | "organization",
            ),
          }
        : { label: key }),
      views: group.values.length,
      sessions: new Set(group.values.map((row) => row.sessionId)).size,
      visitors: new Set(group.values.map((row) => row.visitorId)).size,
    }))
    .sort((left, right) =>
      left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
    );
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
       VALUES (?, 'wave95k-team', 'Overview table qualification', 'overview.test', 0)`,
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
  },
): void {
  database
    .prepare(
      `INSERT INTO visits (
        visit_id, site_id, site_pk, visitor_id, session_id, status,
        started_at, last_activity_at, pathname, hostname
      ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, 'overview.test')`,
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
    ["visit-a1", "session-a", "visitor-a", "/landing", 121],
    ["visit-a2", "session-a", "visitor-a", "/second", 122],
    ["visit-a3", "session-b", "visitor-a", "/landing", 124],
    ["visit-a4", "session-c", "visitor-a", "/landing", 126],
    ["visit-excluded", "session-x", "visitor-x", "/excluded", 125],
  ] as const;
  for (const [id, sessionId, visitorId, path, startedAt] of visits)
    addVisit(database, site, { id, sessionId, visitorId, path, startedAt });

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
  return { database, site };
}

function testEnv(database: DatabaseSync, trace: SqliteD1Trace): Env {
  return {
    DB: createSqliteD1Database(database, trace),
    MAIN_SECRET: CURSOR_SECRET,
  } as unknown as Env;
}

function queryFor(
  scope: "session" | "visitor",
  options: OverviewQueryOptions = {},
): OverviewTestQuery {
  const prepared = prepareScopedQuery("dimension", {
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
    tab: options.tab ?? "client.browser",
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
  if (!descriptor) throw new Error("wave95k_overview_descriptor_missing");
  const items =
    descriptor.family === "geo"
      ? mapGeoTabs(
          page.items.map((row) => ({
            ...row,
            label: geoTabLabel(
              row.value,
              tab.slice("geo.".length) as
                | "country"
                | "region"
                | "city"
                | "continent"
                | "timezone"
                | "organization",
            ),
          })),
        )
      : tab === "page.query"
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
    throw new Error("wave95k_legacy_overview_request_invalid");
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
  behavior: "missing-control" | "duplicate-control" | "wrong-control-scope",
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
          return {
            ...result,
            results: result.results.map((row) =>
              row.rowKind === "control"
                ? { ...row, entityKind: "visitor" }
                : row,
            ),
          };
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
          throw new Error("wave95k_sqlite_report_failure");
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

afterAll(async () => {
  for (const database of databases) database.close();
  const staleBooleanArtifactDir = process.env.WAVE97DK_ARTIFACT_DIR;
  if (staleBooleanArtifactDir) {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(staleBooleanArtifactDir, { recursive: true });
    await writeFile(
      `${staleBooleanArtifactDir}/overview-page-dimension-stale-tests.json`,
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
  const pageFieldArtifactDir = process.env.WAVE97DF_ARTIFACT_DIR;
  if (pageFieldArtifactDir) {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(pageFieldArtifactDir, { recursive: true });
    await writeFile(
      `${pageFieldArtifactDir}/private-page-field-overview.json`,
      JSON.stringify(
        {
          planSha256:
            "2BB53A4E3E87E2ED2488B9152EE492ED88EE450D6E2A7749A1232BBDCCD90136",
          evidence: evidence.filter(
            (entry) =>
              typeof entry.kind === "string" &&
              entry.kind.startsWith("private-page-field-whole-boolean"),
          ),
        },
        null,
        2,
      ),
      "utf8",
    );
  }
  const canonicalArtifactDir = process.env.WAVE97DG_ARTIFACT_DIR;
  if (canonicalArtifactDir) {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(canonicalArtifactDir, { recursive: true });
    await writeFile(
      `${canonicalArtifactDir}/canonical-page-dimensions-overview.json`,
      JSON.stringify(
        {
          planSha256: CANONICAL_PLAN_SHA256,
          evidence: evidence.filter(
            (entry) =>
              typeof entry.kind === "string" &&
              entry.kind.startsWith("canonical-page-dimensions"),
          ),
        },
        null,
        2,
      ),
      "utf8",
    );
  }
  const artifactDir = process.env.WAVE95K_ARTIFACT_DIR;
  if (!artifactDir) return;
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(artifactDir, { recursive: true });
  await writeFile(
    `${artifactDir}/overview-page-table-regression-evidence.json`,
    JSON.stringify({ planSha256: PLAN_SHA256, evidence }, null, 2),
    "utf8",
  );
});

describe("qualified single-period overview page tables", () => {
  const wave95kOverviewTabCohort = [
    "client.browser",
    "client.osVersion",
    "client.deviceType",
    "client.language",
    "client.screenSize",
    "utm.source",
    "utm.medium",
    "utm.campaign",
    "utm.term",
    "utm.content",
    "geo.country",
    "geo.region",
    "geo.city",
    "geo.continent",
    "geo.timezone",
    "geo.organization",
  ] as const;
  const overviewCases = wave95kOverviewTabCohort.flatMap((tab) =>
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
        throw new Error("wave95k_overview_deferred_missing");
      const q = qualifiedQuery(query, legacy.normalized);
      const compiled = compilePageDimensionQualificationProgram({
        deferred: legacy.deferred,
        query: q,
      });
      expect(compiled.kind).toBe("compiled");
      if (compiled.kind !== "compiled")
        throw new Error("wave95k_overview_compile_unavailable");
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
      const runtimeTrace = traceFor();
      const diagnostics = createD1ReadDiagnostics();
      const provider = createD1SiteProviderRegistry({
        env: testEnv(database, runtimeTrace),
        siteId: SITE,
        diagnostics,
      }).resolve("dimension");
      if (!provider) throw new Error("wave95k_overview_provider_missing");
      const actual = await provider.execute(query);
      expect(actual.value).toEqual(legacy.dto);
      expect((actual.value as typeof legacy.dto).data.pagination.limit).toBe(
        100,
      );
      expect(runtimeTrace.preparedSql).toHaveLength(2);
      expect(runtimeTrace.preparedSql[1]).toBe(compiled.evidence.sql);
      expect(runtimeTrace.bindings[1]).toEqual(compiled.evidence.bindings);
      expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
      if (tab.startsWith("utm."))
        expect(
          (actual.value as typeof legacy.dto).data.items.some(
            (row) => row.label === "",
          ),
        ).toBe(true);
      if (tab.startsWith("client.") || tab.startsWith("geo."))
        expect(
          (actual.value as typeof legacy.dto).data.items.some(
            (row) => row.label === "",
          ),
        ).toBe(false);
      if (tab === "client.browser") {
        const chrome = (actual.value as typeof legacy.dto).data.items.find(
          (row) => row.label === "Chrome",
        );
        expect(chrome?.sessions).toBe(scope === "visitor" ? 2 : 1);
      }
      if (tab === "geo.country")
        expect(legacy.normalized.selection).toEqual({
          id: "country",
          kind: "stored",
          attribute: "page.report.country",
          normalization: "raw",
        });
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
        logicalGraphSha256: createHash("sha256")
          .update(logicalGraph, "utf8")
          .digest("hex"),
        rootKind: compiled.evidence.rootKind,
        physicalScanKinds: compiled.evidence.physicalScanKinds,
        sharedRelationCount: compiled.evidence.sharedRelationCount,
        logicalGraph,
        sql: compiled.evidence.sql,
        bindings: compiled.evidence.bindings,
      });
    },
  );

  const cursorChainCases = (
    ["client.browser", "geo.city", "utm.source"] as const
  ).flatMap((tab) =>
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
      if (!provider) throw new Error("wave95k_overview_provider_missing");

      const maximumPages = 10;
      const actualPages: CursorOverviewDto[] = [];
      const pageEvidence: Array<Record<string, unknown>> = [];
      let cursor: string | null = null;
      let finished = false;
      let emptyUtmCursorBoundary = false;
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
          throw new Error("wave95k_cursor_chain_legacy_deferred_missing");

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
          runtimeStatementCount: trace.preparedSql.length - statementOffset,
          runtimeSqlSha256: trace.preparedSql
            .slice(statementOffset)
            .map((sql) =>
              createHash("sha256").update(sql, "utf8").digest("hex"),
            ),
        });

        if (
          tab === "utm.source" &&
          sort === "views" &&
          direction === "desc" &&
          pageNumber === 0
        ) {
          expect(actual.data.items[0]?.label).toBe("");
          expect(pageCursor).not.toBeNull();
          const decoded = await decodeDimensionCursor(
            testEnv(database, traceFor()),
            SITE,
            WINDOW,
            legacy.filters,
            legacy.normalized.selection,
            legacy.normalized.search,
            pageCursor,
            query.context.policy.audience,
            legacy.normalized.sortBy,
            legacy.normalized.sortDirection,
          );
          expect(decoded?.value).toBe("");
          emptyUtmCursorBoundary = true;
        }

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
      if (tab === "utm.source" && sort === "views" && direction === "desc")
        expect(emptyUtmCursorBoundary).toBe(true);

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
        tab.startsWith("geo.") ? (row.value ?? "") : (row.label ?? "");
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
        emptyUtmCursorBoundary,
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
    if (!provider) throw new Error("wave95k_overview_provider_missing");
    const initial = await provider.execute(
      queryFor("visitor", { tab: "client.browser", limit: 1 }),
    );
    const cursor = (
      initial.value as { data: { pagination: { nextCursor: string | null } } }
    ).data.pagination.nextCursor;
    if (!cursor) throw new Error("wave95k_overview_cursor_missing");
    const invalidCases = [
      queryFor("visitor", { tab: "client.deviceType", limit: 1, cursor }),
      queryFor("visitor", {
        tab: "client.browser",
        limit: 1,
        cursor,
        sort: "sessions",
      }),
      queryFor("visitor", {
        tab: "client.browser",
        limit: 1,
        cursor,
        search: "Chrome",
      }),
      queryFor("visitor", {
        tab: "client.browser",
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

  it.each(["CHROME", " ", "no-such-browser"] as const)(
    "matches the legacy case-insensitive and whitespace search for %s",
    async (search) => {
      const { database } = createFixture();
      const query = queryFor("visitor", {
        tab: "client.browser",
        search,
      });
      const legacy = await legacyOverviewTableFor(database, query, traceFor());
      const trace = traceFor();
      const provider = createD1SiteProviderRegistry({
        env: testEnv(database, trace),
        siteId: SITE,
      }).resolve("dimension");
      if (!provider) throw new Error("wave95k_overview_provider_missing");
      const actual = await provider.execute(query);
      expect(actual.value).toEqual(legacy.dto);
      expect(trace.preparedSql).toHaveLength(2);
      recordEvidence("overview-search", { search, dto: actual.value });
    },
  );

  it("qualifies only allowlisted single-period overview tabs with safe limits and matching context", async () => {
    const { database } = createFixture();
    const env = testEnv(database, traceFor());
    const eligible = queryFor("session", { tab: "geo.country" });
    const middleware = d1AdvancedFilterMiddleware(env, undefined, SITE);
    const forward = async (query: OverviewTestQuery) =>
      middleware("dimension", query, async (prepared) => prepared, undefined);
    const eligibleForwarded = await forward(eligible);
    expect(
      deferredOverviewPageTableQualificationFromQuery(eligibleForwarded)
        ?.overviewPageTableRequest.tab,
    ).toBe("geo.country");

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
      const query = queryFor("session", {
        tab: "client.browser",
        filterDsl,
      });
      const forwarded = await forward(query);
      const deferred =
        deferredOverviewPageTableQualificationFromQuery(forwarded);
      const descriptor = overviewPageTableDescriptor(query.tab);
      if (!descriptor)
        throw new Error("wave97dk_client_browser_descriptor_missing");
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
      queryFor("session", { tab: "client.unsupported" }),
      queryFor("session", { tab: "source.channel" }),
      queryFor("session", {
        tab: "client.browser",
        limit: 1.5,
      }),
      queryFor("session", {
        tab: "client.browser",
        audience: "api-v1",
        filterDsl: wholeBooleanCases[0].filterDsl,
      }),
      queryFor("session", {
        tab: "client.browser",
        audience: "api-v1",
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
      eligibleTab: "geo.country",
      admittedWholeBoolean,
      rejected: [
        "unknown-tab",
        "source-channel",
        "fractional-limit",
        "api-v1-mixed-or",
        "api-v1-mixed-not",
        "comparison",
        "current-reference",
      ],
      expectedSiteMismatchRejected: true,
      requestTimeMismatchRejected: true,
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
        tab: "client.browser",
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
      if (!provider) throw new Error("wave95k_legacy_provider_missing");
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
      tab: "client.browser",
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
    if (!provider) throw new Error("wave95k_invalid_limit_provider_missing");
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
    if (!provider) throw new Error("wave95k_overview_provider_missing");
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
      tab: "client.browser",
      filterDsl: `${BASE_FILTER} and count(page { page.durationMs gt 5 }) eq 1`,
    });
    const oldTrace = traceFor();
    const legacy = await legacyOverviewTableFor(database, query, oldTrace);
    expect(legacy.deferred).toBeDefined();
    if (!legacy.deferred || !legacy.normalized)
      throw new Error("wave95k_numeric_deferred_missing");
    const compiled = compilePageDimensionQualificationProgram({
      deferred: legacy.deferred,
      query: qualifiedQuery(query, legacy.normalized),
    });
    expect(compiled.kind).toBe("compiled");
    if (compiled.kind !== "compiled")
      throw new Error("wave95k_numeric_compile_unavailable");
    const trace = traceFor();
    const diagnostics = createD1ReadDiagnostics();
    const provider = createD1SiteProviderRegistry({
      env: testEnv(database, trace),
      siteId: SITE,
      diagnostics,
    }).resolve("dimension");
    if (!provider) throw new Error("wave95k_numeric_provider_missing");
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
        ) SELECT 'wave95k-cap-' || n, ?, ?, 'wave95k-cap-visitor',
          'wave95k-cap-session', 'closed', ?, ?, '/bulk', 'bulk.test', 10
          FROM generated`,
      )
      .run(bulkCount, SITE, site.pk, 125, 125);
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "wave95k-cap-1");
    const trace = traceFor();
    const diagnostics = createD1ReadDiagnostics();
    const provider = createD1SiteProviderRegistry({
      env: testEnv(database, trace),
      siteId: SITE,
      diagnostics,
    }).resolve("dimension");
    if (!provider) throw new Error("wave95k_cap_provider_missing");
    const query = queryFor("session", {
      tab: "client.browser",
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
      if (!provider) throw new Error("wave95k_malformed_provider_missing");
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
    if (!provider) throw new Error("wave95k_sqlite_provider_missing");
    await expect(provider.execute(queryFor("session"))).rejects.toThrow(
      "wave95k_sqlite_report_failure",
    );
    expect(trace.preparedSql).toHaveLength(2);
    recordEvidence("overview-sqlite-error", {
      statementCount: trace.preparedSql.length,
      fallbackRan: false,
    });
  });
});

describe("Private Page field whole Boolean qualification", () => {
  const filterCases = [
    {
      kind: "mixed-or",
      filterDsl:
        'page.path eq "/landing" or count(event { event.name eq "qualifier" }) eq 1',
    },
    {
      kind: "mixed-not",
      filterDsl:
        'not (page.path eq "/Native" and count(event { event.name eq "qualifier" }) eq 1)',
    },
    {
      kind: "count-only",
      filterDsl: 'count(event { event.name eq "qualifier" }) eq 1',
    },
    {
      kind: "neither",
      filterDsl:
        'page.path eq "/void" or count(event { event.name eq "absent" }) eq 1',
    },
  ] as const;

  it.each(["session", "visitor"] as const)(
    "matches complete legacy overview DTOs and independent raw values for %s scope",
    async (scope) => {
      const { database } = createFixture();
      installPrivatePageFieldRows(database);
      for (const filterCase of filterCases) {
        for (const tab of PRIVATE_PAGE_FIELDS) {
          const query = queryFor(scope, {
            tab,
            limit: 20,
            filterDsl: filterCase.filterDsl,
          });
          const legacyTrace = traceFor();
          const legacy = await legacyOverviewTableFor(
            database,
            query,
            legacyTrace,
          );
          if (!legacy.deferred || !legacy.normalized)
            throw new Error("wave97df_overview_page_deferred_missing");
          expect(legacy.deferred.pageDimensionFilterMode).toBe(
            "allow-whole-filter",
          );
          expect(legacy.deferred.overviewPageTableRequest).toMatchObject({
            mode: "overview-tab",
            tab,
            family: "page",
            excludeEmpty: true,
            selection: {
              id:
                tab === "page.path"
                  ? "pagePath"
                  : tab === "page.title"
                    ? "pageTitle"
                    : "pageHostname",
              normalization: "raw",
            },
          });

          const runtimeTrace = traceFor();
          const diagnostics = createD1ReadDiagnostics();
          const provider = createD1SiteProviderRegistry({
            env: testEnv(database, runtimeTrace),
            siteId: SITE,
            diagnostics,
          }).resolve("dimension");
          if (!provider)
            throw new Error("wave97df_overview_page_provider_missing");
          const actual = await provider.execute(query);
          const actualDto = actual.value as typeof legacy.dto;
          expect(actualDto).toEqual(legacy.dto);
          const actualItems = actualDto.data.items
            .map((row) => ({
              label: row.label,
              views: row.views,
              sessions: row.sessions,
              visitors: row.visitors,
            }))
            .sort((left, right) =>
              (left.label ?? "") < (right.label ?? "")
                ? -1
                : (left.label ?? "") > (right.label ?? "")
                  ? 1
                  : 0,
            );
          const independentExpectedItems = independentOverviewPageFieldItems({
            tab,
            filterKind: filterCase.kind,
            scope,
          });
          expect(actualItems).toEqual(independentExpectedItems);
          expect(
            new Set(actualDto.data.items.map((row) => row.label)).size,
          ).toBe(actualDto.data.items.length);
          expect(runtimeTrace.preparedSql).toHaveLength(2);
          const reportEnvelopeSql = runtimeTrace.preparedSql[1]!;
          expect(reportEnvelopeSql).toContain("rowKind");
          expect(reportEnvelopeSql).toContain("outputId");
          expect(
            Buffer.byteLength(reportEnvelopeSql, "utf8"),
          ).toBeLessThanOrEqual(100_000);
          expect(runtimeTrace.bindings[1]!.length).toBeLessThanOrEqual(100);
          expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();

          const compiled = compilePageDimensionQualificationProgram({
            deferred: legacy.deferred,
            query: qualifiedQuery(query, legacy.normalized),
          });
          expect(compiled.kind).toBe("compiled");
          if (compiled.kind !== "compiled")
            throw new Error("wave97df_overview_page_compile_unavailable");
          expect(reportEnvelopeSql).toBe(compiled.evidence.sql);
          expect(runtimeTrace.bindings[1]).toEqual(compiled.evidence.bindings);
          recordEvidence("private-page-field-whole-boolean-overview", {
            tab,
            scope,
            filterKind: filterCase.kind,
            filterDsl: filterCase.filterDsl,
            mode: "overview-tab",
            family: legacy.normalized.family,
            selection: legacy.normalized.selection,
            excludeEmpty: legacy.normalized.excludeEmpty,
            independentExpectedItems,
            legacyDto: legacy.dto,
            actualDto,
            legacyStatements: legacyTrace.preparedSql.map((sql, index) => ({
              sql,
              bindings: legacyTrace.bindings[index] ?? [],
            })),
            runtimeStatements: runtimeTrace.preparedSql.map((sql, index) => ({
              sql,
              bindings: runtimeTrace.bindings[index] ?? [],
            })),
            compiledStatementTag: compiled.evidence.statementTag,
            sqlBytes: Buffer.byteLength(reportEnvelopeSql, "utf8"),
            bindingCount: runtimeTrace.bindings[1]!.length,
            metadataStatements: 1,
            qualificationReportControlEnvelopes: 1,
            extraCountScans: 0,
            fallbackReports: 0,
          });
        }
      }
    },
  );

  it("continues the old cursor and invalidates it across field, mode, and scope", async () => {
    const { database } = createFixture();
    installPrivatePageFieldRows(database);
    const filterDsl = filterCases[0]!.filterDsl;
    const firstQuery = queryFor("visitor", {
      tab: "page.path",
      limit: 2,
      filterDsl,
    });
    const firstLegacy = await legacyOverviewTableFor(
      database,
      firstQuery,
      traceFor(),
    );
    if (!firstLegacy.deferred || !firstLegacy.normalized)
      throw new Error("wave97df_overview_cursor_deferred_missing");
    expect(firstLegacy.dto.data.pagination.hasMore).toBe(true);
    expect(firstLegacy.dto.data.pagination.nextCursor).toBeTruthy();

    const firstTrace = traceFor();
    const provider = createD1SiteProviderRegistry({
      env: testEnv(database, firstTrace),
      siteId: SITE,
    }).resolve("dimension");
    if (!provider) throw new Error("wave97df_overview_cursor_provider_missing");
    const firstActual = await provider.execute(firstQuery);
    expect(firstActual.value).toEqual(firstLegacy.dto);
    const bindingProvider = createD1SiteProviderRegistry({
      env: testEnv(database, traceFor()),
      siteId: SITE,
    }).resolve("dimension");
    if (!bindingProvider)
      throw new Error("wave97df_overview_cursor_provider_missing");

    const cursor = firstLegacy.dto.data.pagination.nextCursor;
    if (!cursor) throw new Error("wave97df_overview_cursor_missing");
    const secondQuery = queryFor("visitor", {
      tab: "page.path",
      limit: 2,
      cursor,
      filterDsl,
    });
    const secondLegacy = await legacyOverviewTableFor(
      database,
      secondQuery,
      traceFor(),
    );
    const secondTrace = traceFor();
    const secondProvider = createD1SiteProviderRegistry({
      env: testEnv(database, secondTrace),
      siteId: SITE,
    }).resolve("dimension");
    if (!secondProvider)
      throw new Error("wave97df_overview_cursor_provider_missing");
    const secondActual = await secondProvider.execute(secondQuery);
    expect(secondActual.value).toEqual(secondLegacy.dto);
    expect(secondLegacy.dto.data.items).toHaveLength(2);
    expect(secondLegacy.dto.data.pagination.hasMore).toBe(false);
    expect(firstLegacy.dto.data.items.map((row) => row.views)).toEqual([1, 1]);
    const actualCursorLabels = [
      ...firstLegacy.dto.data.items.map((row) => row.label ?? ""),
      ...secondLegacy.dto.data.items.map((row) => row.label ?? ""),
    ].sort();
    expect(actualCursorLabels).toEqual(
      independentOverviewPageFieldItems({
        tab: "page.path",
        filterKind: "mixed-or",
        scope: "visitor",
      }).map((row) => row.label),
    );

    await expect(
      bindingProvider.execute(
        queryFor("visitor", {
          tab: "page.title",
          limit: 2,
          cursor,
          filterDsl,
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidCursorError);
    await expect(
      bindingProvider.execute(
        queryFor("session", {
          tab: "page.path",
          limit: 2,
          cursor,
          filterDsl,
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidCursorError);

    const breakdownBase = prepareScopedQuery("dimension", {
      context: firstQuery.context,
      time: firstQuery.time,
      filters: firstQuery.filters,
      scopePreference: "visitor",
    } as QueryInput & { readonly time: QueryTime });
    const breakdownQuery = {
      ...breakdownBase,
      mode: "breakdown",
      dimension: "page.path",
      page: { limit: 2, cursor },
      sort: { key: "views", direction: "desc" },
      search: "",
    } as unknown as OverviewTestQuery;
    await expect(
      bindingProvider.execute(breakdownQuery),
    ).rejects.toBeInstanceOf(InvalidCursorError);
    recordEvidence("private-page-field-whole-boolean-overview-cursor", {
      tab: "page.path",
      scope: "visitor",
      oldFirstDto: firstLegacy.dto,
      actualFirstDto: firstActual.value,
      oldSecondDto: secondLegacy.dto,
      actualSecondDto: secondActual.value,
      oldCursorContinued: true,
      tiedViews: firstLegacy.dto.data.items.map((row) => row.views),
      invalidatedBindings: ["field", "mode", "scope"],
      runtimeStatements: [
        ...firstTrace.preparedSql.map((sql, index) => ({
          sql,
          bindings: firstTrace.bindings[index] ?? [],
        })),
        ...secondTrace.preparedSql.map((sql, index) => ({
          sql,
          bindings: secondTrace.bindings[index] ?? [],
        })),
      ],
    });
  });

  it("opts in only for exact private Page tabs without comparison state", async () => {
    const { database } = createFixture();
    const middleware = d1AdvancedFilterMiddleware(
      testEnv(database, traceFor()),
      undefined,
      SITE,
    );
    const forward = (query: OverviewTestQuery) =>
      middleware("dimension", query, async (prepared) => prepared);
    const mixedOr = filterCases[0]!.filterDsl;
    const eligible = queryFor("session", {
      tab: "page.path",
      filterDsl: mixedOr,
    });
    const eligibleForwarded = await forward(eligible);
    const eligibleDeferred =
      deferredOverviewPageTableQualificationFromQuery(eligibleForwarded);
    expect(eligibleDeferred?.pageDimensionFilterMode).toBe(
      "allow-whole-filter",
    );

    const canonicalTabs = Object.keys(
      OVERVIEW_PAGE_TABLES,
    ) as (keyof typeof OVERVIEW_PAGE_TABLES)[];
    for (const tab of canonicalTabs) {
      const descriptor = overviewPageTableDescriptor(tab);
      if (!descriptor)
        throw new Error(`wave97dg_overview_registry_missing:${tab}`);
      const forwarded = await forward(
        queryFor("session", { tab, filterDsl: mixedOr }),
      );
      const deferred =
        deferredOverviewPageTableQualificationFromQuery(forwarded);
      if (descriptor.family === "channel") {
        expect(deferred).toBeUndefined();
        continue;
      }
      expect(deferred?.pageDimensionFilterMode).toBe("allow-whole-filter");
      expect(deferred?.overviewPageTableRequest).toMatchObject({
        tab,
        family: descriptor.family,
        selection: descriptor.selection,
        excludeEmpty: descriptor.excludeEmpty,
      });
    }
    const browserEligible = queryFor("session", {
      tab: "client.browser",
      filterDsl: mixedOr,
    });
    expect(
      deferredOverviewPageTableQualificationFromQuery(
        await forward(browserEligible),
      )?.pageDimensionFilterMode,
    ).toBe("allow-whole-filter");

    const excluded = [
      queryFor("session", {
        audience: "api-v1",
        tab: "page.path",
        filterDsl: mixedOr,
      }),
      {
        ...eligible,
        comparison: { metric: "views" },
      } as OverviewTestQuery,
      { ...eligible, current: { time: TIME } } as OverviewTestQuery,
      { ...eligible, reference: { time: TIME } } as OverviewTestQuery,
    ];
    for (const query of excluded) {
      const forwarded = await forward(query);
      expect(
        deferredOverviewPageTableQualificationFromQuery(forwarded),
      ).toBeUndefined();
    }

    const conjunction = queryFor("session", {
      tab: "page.path",
      filterDsl:
        'page.path eq "/Native" and count(event { event.name eq "qualifier" }) eq 1',
    });
    const conjunctionForwarded = await forward(conjunction);
    const conjunctionDeferred =
      deferredOverviewPageTableQualificationFromQuery(conjunctionForwarded);
    expect(conjunctionDeferred).toBeDefined();
    expect(
      resolveQualifiedSourceFilters(conjunction.filters!, "allow-whole-filter"),
    ).toMatchObject({ kind: "supported", mode: "split" });

    const legacy = await legacyOverviewTableFor(database, eligible, traceFor());
    if (!legacy.deferred || !legacy.normalized)
      throw new Error("wave97df_overview_compile_deferred_missing");
    const validQuery = qualifiedQuery(eligible, legacy.normalized);
    const titleDescriptor = overviewPageTableDescriptor("page.title");
    if (!titleDescriptor)
      throw new Error("wave97df_overview_title_descriptor_missing");
    expect(() =>
      compilePageDimensionQualificationProgram({
        deferred: legacy.deferred!,
        query: { ...validQuery, selection: titleDescriptor.selection },
      }),
    ).toThrow();

    const pathDescriptor = overviewPageTableDescriptor("page.path");
    if (!pathDescriptor)
      throw new Error("wave97df_overview_path_descriptor_missing");
    expect(() =>
      buildPageDimensionQualificationPlan({
        siteId: SITE,
        queryTime: eligible.time,
        filters: eligible.filters!,
        scopePlan: legacy.deferred!.metadata.plan,
        count: legacy.deferred!.countInput,
        options: {
          selection: pathDescriptor.selection,
          limit: 10,
          cursor: null,
          sortBy: "views",
          sortDirection: "desc",
          excludeEmpty: true,
        },
      }),
    ).toThrow();
    recordEvidence("private-page-field-whole-boolean-overview-gates", {
      allowed: [
        "private-dashboard",
        "overview-tab",
        ...canonicalTabs.filter(
          (tab) => OVERVIEW_PAGE_TABLES[tab].family !== "channel",
        ),
      ],
      rejected: [
        "api-v1",
        "comparison",
        "current",
        "reference",
        "selection-swap",
      ],
      conjunctionStillDeferred: true,
      conjunctionResolvedAs: "split",
      canonicalTabs: canonicalTabs.map((tab) => ({
        tab,
        family: OVERVIEW_PAGE_TABLES[tab].family,
        selection: OVERVIEW_PAGE_TABLES[tab].selection,
        excludeEmpty: OVERVIEW_PAGE_TABLES[tab].excludeEmpty,
        wholeFilterAllowed: OVERVIEW_PAGE_TABLES[tab].family !== "channel",
      })),
      defaultBuilderRejectedMixedBoolean: true,
    });
  });
});

describe("Canonical Page dimensions whole Boolean qualification", () => {
  const runCase = async (
    database: DatabaseSync,
    input: {
      readonly tab: string;
      readonly filterKind: CanonicalFilterKind;
      readonly scope: "session" | "visitor";
    },
  ) => {
    const query = queryFor(input.scope, {
      tab: input.tab,
      limit: 20,
      filterDsl: CANONICAL_FILTER_DSLS[input.filterKind],
    });
    const legacyTrace = traceFor();
    const legacy = await legacyOverviewTableFor(database, query, legacyTrace);
    const descriptor = overviewPageTableDescriptor(input.tab);
    if (!descriptor) throw new Error("wave97dg_overview_descriptor_missing");

    const runtimeTrace = traceFor();
    const diagnostics = createD1ReadDiagnostics();
    const provider = createD1SiteProviderRegistry({
      env: testEnv(database, runtimeTrace),
      siteId: SITE,
      diagnostics,
    }).resolve("dimension");
    if (!provider) throw new Error("wave97dg_overview_provider_missing");
    const actual = await provider.execute(query);
    const actualDto = actual.value as typeof legacy.dto;
    expect(actualDto).toEqual(legacy.dto);
    const actualItems = (
      actualDto.data.items as readonly {
        readonly value?: string;
        readonly label?: string;
        readonly views: number;
        readonly sessions: number;
        readonly visitors: number;
      }[]
    )
      .map((row) => ({
        key:
          descriptor.family === "geo" ? (row.value ?? "") : (row.label ?? ""),
        label: row.label ?? "",
        views: row.views,
        sessions: row.sessions,
        visitors: row.visitors,
      }))
      .sort((left, right) =>
        left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
      );
    const independentExpectedItems = independentCanonicalOverviewItems({
      tab: input.tab,
      filterKind: input.filterKind,
      scope: input.scope,
    });
    expect(actualItems).toEqual(independentExpectedItems);

    if (!legacy.deferred || !legacy.normalized) {
      expect(input.filterKind).toBe("native-only");
      expect(
        resolveQualifiedSourceFilters(query.filters!, "allow-whole-filter"),
      ).toMatchObject({ kind: "supported", mode: "split" });
      expect(actualDto).toEqual(legacy.dto);
      expect(runtimeTrace.preparedSql).toEqual(legacyTrace.preparedSql);
      expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
      recordEvidence("canonical-page-dimensions-overview", {
        tab: input.tab,
        mode: "overview-tab",
        family: descriptor.family,
        scope: input.scope,
        filterKind: input.filterKind,
        filterDsl: CANONICAL_FILTER_DSLS[input.filterKind],
        selection: descriptor.selection,
        excludeEmpty: descriptor.excludeEmpty,
        qualificationUsed: false,
        independentExpectedItems,
        legacyDto: legacy.dto,
        actualDto,
        legacyStatements: legacyTrace.preparedSql.map((sql, index) => ({
          sql,
          bindings: legacyTrace.bindings[index] ?? [],
        })),
        runtimeStatements: runtimeTrace.preparedSql.map((sql, index) => ({
          sql,
          bindings: runtimeTrace.bindings[index] ?? [],
        })),
      });
      return;
    }

    expect(legacy.deferred.pageDimensionFilterMode).toBe("allow-whole-filter");
    expect(legacy.deferred.overviewPageTableRequest).toMatchObject({
      tab: input.tab,
      family: descriptor.family,
      selection: descriptor.selection,
      excludeEmpty: descriptor.excludeEmpty,
    });

    const compiled = compilePageDimensionQualificationProgram({
      deferred: legacy.deferred,
      query: qualifiedQuery(query, legacy.normalized),
    });
    expect(compiled.kind).toBe("compiled");
    if (compiled.kind !== "compiled")
      throw new Error("wave97dg_overview_compile_unavailable");
    expect(runtimeTrace.preparedSql).toHaveLength(2);
    expect(runtimeTrace.preparedSql[0]).toContain('"sites"');
    expect(runtimeTrace.preparedSql[1]).toBe(compiled.evidence.sql);
    expect(runtimeTrace.bindings[1]).toEqual(compiled.evidence.bindings);
    const envelopeRows = database
      .prepare(runtimeTrace.preparedSql[1]!)
      .all(...runtimeTrace.bindings[1]!) as Record<string, unknown>[];
    const controlRows = envelopeRows.filter((row) => row.rowKind === "control");
    expect(controlRows).toHaveLength(1);
    expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
    expect(
      Buffer.byteLength(runtimeTrace.preparedSql[1]!, "utf8"),
    ).toBeLessThanOrEqual(100_000);
    expect(runtimeTrace.bindings[1]!.length).toBeLessThanOrEqual(100);

    recordEvidence("canonical-page-dimensions-overview", {
      tab: input.tab,
      mode: "overview-tab",
      family: descriptor.family,
      scope: input.scope,
      filterKind: input.filterKind,
      filterDsl: CANONICAL_FILTER_DSLS[input.filterKind],
      selection: descriptor.selection,
      excludeEmpty: descriptor.excludeEmpty,
      independentExpectedItems,
      legacyDto: legacy.dto,
      actualDto,
      legacyStatements: legacyTrace.preparedSql.map((sql, index) => ({
        sql,
        bindings: legacyTrace.bindings[index] ?? [],
      })),
      runtimeStatements: runtimeTrace.preparedSql.map((sql, index) => ({
        sql,
        bindings: runtimeTrace.bindings[index] ?? [],
      })),
      controlRows: controlRows.length,
      reportRows: envelopeRows.filter((row) => row.rowKind === "report").length,
      compiledStatementTag: compiled.evidence.statementTag,
      sqlBytes: Buffer.byteLength(runtimeTrace.preparedSql[1]!, "utf8"),
      bindingCount: runtimeTrace.bindings[1]!.length,
      metadataStatements: 1,
      qualificationReportControlEnvelopes: 1,
      extraCountScans: runtimeTrace.preparedSql.length - 2,
      fallbackReports: diagnostics.advancedCountSqlFallbackReason ? 1 : 0,
    });
  };

  it("qualifies representative overview/session tabs with raw and empty-value contracts", async () => {
    const { database } = createFixture();
    installPrivatePageFieldRows(database);
    for (const input of [
      { tab: "page.query", filterKind: "mixed-or" },
      { tab: "utm.source", filterKind: "mixed-or" },
      { tab: "geo.country", filterKind: "mixed-or" },
      { tab: "client.screenSize", filterKind: "mixed-not" },
    ] as const)
      await runCase(database, { ...input, scope: "session" });
  });

  it("qualifies representative overview/visitor tabs including derived values", async () => {
    const { database } = createFixture();
    installPrivatePageFieldRows(database);
    for (const input of [
      { tab: "geo.city", filterKind: "native-only" },
      { tab: "client.osVersion", filterKind: "count-only" },
      { tab: "page.query", filterKind: "neither" },
    ] as const)
      await runCase(database, { ...input, scope: "visitor" });
  });
});
