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
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { CROSS_BREAKDOWN_DIMENSIONS } from "@/lib/edge/analytics/contract/dimensions";
import { createQueryTime } from "@/lib/edge/analytics/contract/helpers";
import { ADVANCED_FILTER_MAX_ACTIVITIES } from "@/lib/edge/analytics/engine/advanced-filter-activity-plan";
import {
  DIMENSION_PAGE_REPORT_OUTPUT,
  dimensionPageSelection,
  OVERVIEW_PAGE_TABLES,
  type PageDimensionSelection,
} from "@/lib/edge/analytics/engine/dimension-report-plan";
import { resolveJourneyListQualificationFilters } from "@/lib/edge/analytics/engine/journey-list-qualification-filters";
import { splitPageDimensionNativeFilters } from "@/lib/edge/analytics/engine/page-dimension-qualification-plan";
import { buildPageDimensionQualificationPlan } from "@/lib/edge/analytics/engine/page-dimension-qualification-plan";
import {
  assertWholeFilterCountDocument,
  resolveQualifiedSourceFilters,
} from "@/lib/edge/analytics/engine/qualified-page-source";
import {
  d1AdvancedFilterMiddleware,
  deferredPageDimensionQualificationFromQuery,
  prepareDeferredEventQualificationFallback,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { compilePageDimensionQualificationProgram } from "@/lib/edge/analytics/providers/d1/internal/analytics-qualification-program";
import { AnalyticsLogicalToDbLowerer } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";
import { mapDimensionRows } from "@/lib/edge/analytics/providers/d1/internal/core";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import {
  decodeDimensionCursor,
  queryDimensionPageFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/dimensions";
import type { AnalyticsQualificationAdmissionPolicy } from "@/lib/edge/analytics/providers/d1/internal/lowering/event-summary-admission";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import { InvalidCursorError } from "@/lib/pagination";

const SITE = "wave95d-page-dimension";
const TIME = createQueryTime(120, 130, "UTC", 500);
const WINDOW = {
  startMs: 120,
  endExclusiveMs: 130,
  nowMs: 500,
  timeZone: "UTC",
} as const;
const CURSOR_SECRET = "wave95d-page-dimension-test-secret";
const PLAN_SHA256 =
  "DB07C1A593EDE9E4699F114F3E81D33E33BA6ABA9AE0A172DF365F1272F26506";
const CANONICAL_PLAN_SHA256 =
  "7520F7F8C7AA41974C614BA47162C84A2CC0FA9E50F6D7B2E9C18BB471D9E54A";
const DATABASES = new Set<DatabaseSync>();
const supplementalEvidence: Array<Record<string, unknown>> = [];

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
       VALUES (?, 'wave95d-team', 'Page qualification', 'page.test', 0)`,
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
    readonly country?: string;
    readonly hostname?: string;
    readonly startedAt: number;
  },
): void {
  database
    .prepare(
      "INSERT INTO visits (visit_id, site_id, site_pk, visitor_id, session_id, status, started_at, last_activity_at, pathname, hostname, country) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, ?, ?)",
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
      input.hostname ?? "dimension.test",
      input.country ?? "",
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
  addVisit(database, site, {
    id: "visit-1",
    sessionId: "session-1",
    visitorId: "visitor-1",
    path: "/landing",
    country: " US ",
    startedAt: 125,
  });
  addVisit(database, site, {
    id: "visit-2",
    sessionId: "session-1",
    visitorId: "visitor-1",
    path: "/other",
    country: " CA ",
    startedAt: 126,
  });
  addVisit(database, site, {
    id: "visit-3",
    sessionId: "session-2",
    visitorId: "visitor-1",
    path: "/landing",
    country: " MX ",
    startedAt: 127,
  });
  addVisit(database, site, {
    id: "visit-4",
    sessionId: "session-3",
    visitorId: "visitor-2",
    path: "/landing",
    country: " GB ",
    startedAt: 128,
  });
  addEvent(database, site, { id: "event-1", visitId: "visit-1", at: 129 });
  return { database, site };
}

const DERIVED_PAGE_FILTER =
  'page.path neq "/excluded" and count(event { event.name eq "qualifier" }) eq 1';

function createDerivedFixture(): {
  readonly database: DatabaseSync;
  readonly site: TestSite;
} {
  const fixture = createFixture();
  addVisit(fixture.database, fixture.site, {
    id: "visit-5",
    sessionId: "session-1",
    visitorId: "visitor-1",
    path: "/contact",
    startedAt: 129,
  });
  const update = fixture.database.prepare(
    `UPDATE visits SET
      referrer_host = ?, utm_source = ?, utm_medium = ?, utm_campaign = ?,
      browser = ?, os = ?, os_version = ?, screen_width = ?, screen_height = ?,
      country = ?, region_code = ?, region = ?, city = ?
     WHERE visit_id = ?`,
  );
  const rows = [
    [
      "www.google.com",
      "",
      "",
      "",
      "Chrome",
      "Windows",
      "11",
      1920,
      1080,
      "US",
      "CA",
      "CA",
      "San Francisco",
      "visit-1",
    ],
    [
      "facebook.com",
      "",
      "",
      "",
      "Firefox",
      "Linux",
      "6.8",
      1366,
      768,
      "US",
      "",
      "CA",
      "Oakland",
      "visit-2",
    ],
    [
      "",
      "",
      "",
      "",
      "Safari",
      "iOS",
      "18",
      390,
      844,
      "CA",
      "ON",
      "Ontario",
      "Toronto",
      "visit-3",
    ],
    [
      "partner.example",
      "",
      "",
      "",
      "Mystery",
      "Mystery OS",
      "",
      390,
      null,
      "",
      "",
      "",
      "",
      "visit-5",
    ],
  ] as const;
  for (const row of rows) update.run(...row);
  return fixture;
}

function testEnv(database: DatabaseSync, trace: SqliteD1Trace): Env {
  return {
    DB: createSqliteD1Database(database, trace),
    MAIN_SECRET: CURSOR_SECRET,
  } as unknown as Env;
}

type DimensionTestQuery = QueryInput & {
  readonly mode: "breakdown";
  readonly time: typeof TIME;
  readonly dimension: string;
  readonly page: { readonly limit: number; readonly cursor: string | null };
  readonly sort: {
    readonly key: "views" | "sessions" | "visitors";
    readonly direction: "asc" | "desc";
  };
  readonly search: string;
};

function queryFor(
  scope: "session" | "visitor",
  options: {
    readonly audience?: "private-dashboard" | "api-v1";
    readonly cursor?: string | null;
    readonly dimension?: string;
    readonly limit?: number;
    readonly sortBy?: "views" | "sessions" | "visitors";
    readonly sortDirection?: "asc" | "desc";
    readonly search?: string;
    readonly filterDsl?: string;
  } = {},
): DimensionTestQuery {
  const prepared = prepareScopedQuery("dimension", {
    context: siteQueryContext(SITE, options.audience ?? "private-dashboard"),
    time: TIME,
    filters: parseFilterDsl(
      options.filterDsl ??
        'page.path eq "/landing" and count(event { event.name eq "qualifier" }) eq 1',
      analyticsFilterRegistry,
    ),
    scopePreference: scope,
  } as QueryInput & { readonly time: typeof TIME });
  return {
    ...prepared,
    mode: "breakdown",
    dimension: options.dimension ?? "geo.country",
    page: { limit: options.limit ?? 10, cursor: options.cursor ?? null },
    sort: {
      key: options.sortBy ?? "views",
      direction: options.sortDirection ?? "desc",
    },
    search: options.search ?? "",
  } as DimensionTestQuery;
}

const PRIVATE_PAGE_FIELDS = [
  "page.path",
  "page.title",
  "page.hostname",
] as const;

const PRIVATE_PAGE_FIELD_ROWS = [
  {
    visitId: "visit-1",
    sessionId: "session-1",
    visitorId: "visitor-1",
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
    visitId: "visit-2",
    sessionId: "session-1",
    visitorId: "visitor-1",
    path: " /Other ",
    title: "Beta",
    hostname: "beta.test",
    query: "?a=2",
    hash: " #A ",
    utmSource: "",
    country: "CA",
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
    visitId: "visit-3",
    sessionId: "session-2",
    visitorId: "visitor-1",
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
    visitId: "visit-4",
    sessionId: "session-3",
    visitorId: "visitor-2",
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

function independentPageFieldItems(input: {
  readonly dimension: (typeof PRIVATE_PAGE_FIELDS)[number];
  readonly filterKind: "mixed-or" | "mixed-not" | "count-only" | "neither";
  readonly scope: "session" | "visitor";
}) {
  const ownerIds = {
    "mixed-or": {
      session: new Set(["session-1", "session-2"]),
      visitor: new Set(["visitor-1"]),
    },
    "mixed-not": {
      session: new Set(["session-2", "session-3"]),
      visitor: new Set(["visitor-2"]),
    },
    "count-only": {
      session: new Set(["session-1"]),
      visitor: new Set(["visitor-1"]),
    },
    neither: {
      session: new Set<string>(),
      visitor: new Set<string>(),
    },
  }[input.filterKind][input.scope];
  const field =
    input.dimension === "page.path"
      ? "path"
      : input.dimension === "page.title"
        ? "title"
        : "hostname";
  const groups = new Map<
    string,
    { readonly values: (typeof PRIVATE_PAGE_FIELD_ROWS)[number][] }
  >();
  for (const row of PRIVATE_PAGE_FIELD_ROWS) {
    const owner = input.scope === "session" ? row.sessionId : row.visitorId;
    if (!ownerIds.has(owner)) continue;
    const value = row[field].replace(/^ +| +$/gu, "");
    const values = groups.get(value)?.values ?? [];
    groups.set(value, { values: [...values, row] });
  }
  return [...groups.entries()]
    .map(([key, group]) => ({
      key,
      views: group.values.length,
      sessions: new Set(group.values.map((row) => row.sessionId)).size,
      visitors: new Set(group.values.map((row) => row.visitorId)).size,
    }))
    .sort((left, right) =>
      left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
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

function independentCanonicalPageValue(
  row: (typeof PRIVATE_PAGE_FIELD_ROWS)[number],
  dimension: string,
  overview: boolean,
): string {
  const trimAscii = (value: string) => value.replace(/^ +| +$/gu, "");
  switch (dimension) {
    case "page.query":
      return row.query;
    case "page.hash":
      return row.hash;
    case "country":
      return row.country;
    case "geo.country":
      return overview ? row.country : trimAscii(row.country);
    case "utm.source":
      return trimAscii(row.utmSource);
    case "client.browserEngine":
      if (row.os.toLowerCase().includes("ios")) return "WebKit";
      if (/chrome|chromium|edge/iu.test(row.browser)) return "Blink";
      if (row.browser.toLowerCase().includes("firefox")) return "Gecko";
      if (row.browser.toLowerCase().includes("safari")) return "WebKit";
      return "";
    case "client.osVersion":
      return [row.os, row.osVersion].map(trimAscii).filter(Boolean).join(" ");
    case "client.screenSize":
      return row.screenWidth > 0 && row.screenHeight && row.screenHeight > 0
        ? `${row.screenWidth}x${row.screenHeight}`
        : "";
    case "geo.city": {
      const country = trimAscii(row.country);
      const regionCode = trimAscii(row.regionCode);
      const region = trimAscii(row.region);
      const city = trimAscii(row.city);
      if (!country && !regionCode && !region && !city) return "";
      return `${country}::${regionCode || region}::${region}::${city}`;
    }
    default:
      throw new Error(`wave97dg_unmodeled_independent_dimension:${dimension}`);
  }
}

function independentCanonicalPageItems(input: {
  readonly dimension: string;
  readonly filterKind: CanonicalFilterKind;
  readonly scope: "session" | "visitor";
  readonly overview?: boolean;
}) {
  const ownerIds = {
    "mixed-or": {
      session: new Set(["session-1", "session-2"]),
      visitor: new Set(["visitor-1"]),
    },
    "mixed-not": {
      session: new Set(["session-2", "session-3"]),
      visitor: new Set(["visitor-2"]),
    },
    "native-only": {
      session: new Set(["session-2"]),
      visitor: new Set(["visitor-1"]),
    },
    "count-only": {
      session: new Set(["session-1"]),
      visitor: new Set(["visitor-1"]),
    },
    neither: {
      session: new Set<string>(),
      visitor: new Set<string>(),
    },
  }[input.filterKind][input.scope];
  const descriptor = input.overview
    ? OVERVIEW_PAGE_TABLES[input.dimension as keyof typeof OVERVIEW_PAGE_TABLES]
    : undefined;
  const groups = new Map<
    string,
    { readonly values: (typeof PRIVATE_PAGE_FIELD_ROWS)[number][] }
  >();
  for (const row of PRIVATE_PAGE_FIELD_ROWS) {
    const owner = input.scope === "session" ? row.sessionId : row.visitorId;
    if (!ownerIds.has(owner)) continue;
    const value = independentCanonicalPageValue(
      row,
      input.dimension,
      input.overview ?? false,
    );
    if (descriptor?.excludeEmpty && !value.replace(/^ +| +$/gu, "")) continue;
    const values = groups.get(value)?.values ?? [];
    groups.set(value, { values: [...values, row] });
  }
  return [...groups.entries()]
    .map(([key, group]) => ({
      key,
      views: group.values.length,
      sessions: new Set(group.values.map((row) => row.sessionId)).size,
      visitors: new Set(group.values.map((row) => row.visitorId)).size,
    }))
    .sort((left, right) =>
      left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
    );
}

interface DimensionPageDto {
  readonly items: ReturnType<typeof mapDimensionRows>;
  readonly pagination: {
    readonly limit: number;
    readonly returned: number;
    readonly hasMore: boolean;
    readonly nextCursor: string | null;
  };
}

async function legacyPageFor(
  database: DatabaseSync,
  query: DimensionTestQuery,
  trace: SqliteD1Trace,
): Promise<{
  readonly dto: DimensionPageDto;
  readonly deferred: ReturnType<
    typeof deferredPageDimensionQualificationFromQuery
  >;
}> {
  const env = testEnv(database, trace);
  const forwarded = (await d1AdvancedFilterMiddleware(env, undefined, SITE)(
    "dimension",
    query,
    async (prepared) => prepared,
  )) as DimensionTestQuery;
  const deferred = deferredPageDimensionQualificationFromQuery(forwarded);
  const filters = deferred
    ? await prepareDeferredEventQualificationFallback(deferred)
    : forwarded.filters;
  const selection = dimensionPageSelection(query.dimension);
  if (!filters || !selection)
    throw new Error("wave95d_page_dimension_legacy_request_invalid");
  const cursor = await decodeDimensionCursor(
    env,
    SITE,
    WINDOW,
    filters,
    selection,
    query.search,
    query.page.cursor,
    "private-dashboard",
    query.sort.key,
    query.sort.direction,
  );
  const page = await queryDimensionPageFromD1(
    env,
    SITE,
    WINDOW,
    filters,
    query.page.limit,
    selection,
    {
      excludeEmpty: false,
      search: query.search,
      sortBy: query.sort.key,
      sortDirection: query.sort.direction,
    },
    cursor,
    undefined,
    "private-dashboard",
  );
  return {
    dto: {
      items: mapDimensionRows([...page.items]),
      pagination: page.pagination,
    },
    deferred,
  };
}

function recordSupplementalEvidence(
  kind: string,
  evidence: Record<string, unknown>,
): void {
  supplementalEvidence.push({ kind, ...evidence });
}

function testEnvWithControlResultBehavior(
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

function pageQualificationQuery(
  query: DimensionTestQuery,
  deferred: NonNullable<
    ReturnType<typeof deferredPageDimensionQualificationFromQuery>
  >,
) {
  const request = deferred.pageDimensionRequest;
  return {
    siteId: SITE,
    queryTime: query.time!,
    filters: query.filters!,
    ...(query.scopePlan ? { scopePlan: query.scopePlan } : {}),
    dimension: request.dimension,
    selection: request.selection,
    limit: request.limit,
    cursor: null,
    cursorToken: request.cursorText,
    ...(request.search !== undefined ? { search: request.search } : {}),
    sortBy: request.sortBy,
    sortDirection: request.sortDirection,
    excludeEmpty: false as const,
    audience: request.audience,
  };
}

afterAll(async () => {
  for (const database of DATABASES) database.close();
  const staleBooleanArtifactDir = process.env.WAVE97DK_ARTIFACT_DIR;
  if (staleBooleanArtifactDir) {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(staleBooleanArtifactDir, { recursive: true });
    await writeFile(
      staleBooleanArtifactDir + "/page-dimension-stale-tests.json",
      JSON.stringify(
        {
          planSha256:
            "BAA4E00D0A9B9B2A552779E0E1ACAFB64D305C163E5329AEBCE4234CF93C2241",
          evidence: supplementalEvidence,
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
      `${pageFieldArtifactDir}/private-page-field-breakdown.json`,
      JSON.stringify(
        {
          planSha256:
            "2BB53A4E3E87E2ED2488B9152EE492ED88EE450D6E2A7749A1232BBDCCD90136",
          evidence: supplementalEvidence.filter(
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
      `${canonicalArtifactDir}/canonical-page-dimensions-breakdown.json`,
      JSON.stringify(
        {
          planSha256: CANONICAL_PLAN_SHA256,
          evidence: supplementalEvidence.filter(
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
  const artifactDir = process.env.WAVE95E_ARTIFACT_DIR;
  if (artifactDir) {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(artifactDir, { recursive: true });
    await writeFile(
      artifactDir + "/review-contract-completion.json",
      JSON.stringify(
        {
          planSha256: PLAN_SHA256,
          evidence: supplementalEvidence,
        },
        null,
        2,
      ),
      "utf8",
    );
  }
});

describe("Page dimension Count qualification", () => {
  it("preserves native conjunctions and refuses mixed OR splitting", () => {
    const native = parseFilterDsl(
      'page.path eq "/landing"',
      analyticsFilterRegistry,
    );
    const conjunction = parseFilterDsl(
      'page.path eq "/landing" and count(event { event.name eq "qualifier" }) eq 1',
      analyticsFilterRegistry,
    );
    const disjunction = parseFilterDsl(
      'page.path eq "/landing" or count(event { event.name eq "qualifier" }) eq 1',
      analyticsFilterRegistry,
    );
    const advancedOnly = parseFilterDsl(
      'count(event { event.name eq "qualifier" }) eq 1',
      analyticsFilterRegistry,
    );

    const splitConjunction = splitPageDimensionNativeFilters(conjunction);
    expect(splitConjunction.kind).toBe("supported");
    if (splitConjunction.kind === "supported") {
      expect(splitConjunction.filters.root).toEqual(native.root);
      expect(splitConjunction.advancedFilters.root).toEqual(advancedOnly.root);
    }
    expect(splitPageDimensionNativeFilters(disjunction).kind).toBe(
      "unsupported",
    );
  });

  it.each(["session", "visitor"] as const)(
    "matches the old Page DTO and preserves native Page row filters for %s scope",
    async (scope) => {
      const { database } = createFixture();
      const query = queryFor(scope);
      const oldTrace = traceFor();
      const oldEnv = testEnv(database, oldTrace);
      const forwarded = await d1AdvancedFilterMiddleware(
        oldEnv,
        undefined,
        SITE,
      )("dimension", query, async (prepared) => prepared);
      const deferred = deferredPageDimensionQualificationFromQuery(forwarded);
      if (!deferred)
        throw new Error("wave95d_page_dimension_deferred_request_missing");
      const oldFilters =
        await prepareDeferredEventQualificationFallback(deferred);
      const selection = dimensionPageSelection("geo.country");
      if (!selection)
        throw new Error("wave95d_page_dimension_selection_missing");
      expect(selection.kind).toBe("stored");
      const oldPage = await queryDimensionPageFromD1(
        oldEnv,
        SITE,
        WINDOW,
        oldFilters,
        query.page.limit,
        selection,
        {
          excludeEmpty: false,
          search: "",
          sortBy: "views",
          sortDirection: "desc",
        },
        null,
        undefined,
        "private-dashboard",
      );

      const compileQuery = pageQualificationQuery(query, deferred);
      const compiled = compilePageDimensionQualificationProgram({
        deferred,
        query: compileQuery,
      });
      expect(compiled.kind).toBe("compiled");
      if (compiled.kind !== "compiled")
        throw new Error("wave95d_page_dimension_default_compile_unavailable");
      const qualification = buildPageDimensionQualificationPlan({
        siteId: SITE,
        queryTime: query.time,
        filters: query.filters!,
        scopePlan: query.scopePlan!,
        count: deferred.countInput,
        options: {
          selection,
          limit: query.page.limit,
          cursor: null,
          search: "",
          sortBy: "views",
          sortDirection: "desc",
          excludeEmpty: false,
        },
      });
      const logicalPlan = qualification.plan;
      const graph = JSON.stringify(logicalPlan, null, 2);
      const compiledPhysicalShape = JSON.stringify({
        sql: compiled.evidence.sql,
        bindings: compiled.evidence.bindings,
      });
      const compileEvidence = {
        scope,
        statementTag: compiled.evidence.statementTag,
        sql: compiled.evidence.sql,
        bindings: compiled.evidence.bindings,
        sqlBytes: compiled.evidence.sqlBytes,
        bindingCount: compiled.evidence.bindingCount,
        sqlSha256: createHash("sha256")
          .update(compiled.evidence.sql)
          .digest("hex"),
        compiledPhysicalSha256: createHash("sha256")
          .update(compiledPhysicalShape, "utf8")
          .digest("hex"),
        logicalGraphSha256: createHash("sha256")
          .update(graph, "utf8")
          .digest("hex"),
        rootKind: compiled.evidence.rootKind,
        physicalScanKinds: compiled.evidence.physicalScanKinds,
        sharedRelationCount: compiled.evidence.sharedRelationCount,
        groupWidth: compiled.evidence.groupWidth,
      };

      const runtimeTrace = traceFor();
      const runtimeEnv = testEnv(database, runtimeTrace);
      const provider = createD1SiteProviderRegistry({
        env: runtimeEnv,
        siteId: SITE,
      }).resolve("dimension");
      if (!provider) throw new Error("wave95d_page_dimension_provider_missing");
      const actual = await provider.execute(query);
      if (!("items" in actual.value))
        throw new Error("wave95d_page_dimension_result_shape_invalid");
      expect(actual.value).toEqual({
        items: mapDimensionRows([...oldPage.items]),
        pagination: oldPage.pagination,
      });
      expect(actual.value.items.map((row) => row.key)).toEqual(
        scope === "session" ? ["CA", "US"] : ["CA", "MX", "US"],
      );
      expect(runtimeTrace.preparedSql).toHaveLength(2);
      expect(runtimeTrace.preparedSql[1]).toContain("page");

      const artifactDir = process.env.WAVE95E_ARTIFACT_DIR;
      if (artifactDir) {
        const { mkdir, writeFile } = await import("node:fs/promises");
        await mkdir(artifactDir, { recursive: true });
        await writeFile(
          `${artifactDir}/dimension-${scope}.json`,
          JSON.stringify(
            {
              compileEvidence,
              logicalGraph: graph,
              oldDto: {
                items: mapDimensionRows([...oldPage.items]),
                pagination: oldPage.pagination,
              },
              actualDto: actual.value,
              preparationStatementCount: oldTrace.preparedSql.length,
              oldCompleteRequestStatementCount: oldTrace.preparedSql.length,
              oldStatementCountSemantics:
                "coverage query + Count fallback query + legacy Page report query",
              oldCompleteRequestStatements: oldTrace.preparedSql.map(
                (sql, index) => ({
                  sql,
                  bindingCount: oldTrace.bindings[index]?.length ?? 0,
                }),
              ),
              runtimePreparedStatementCount: runtimeTrace.preparedSql.length,
              runtimeStatements: runtimeTrace.preparedSql.map((sql, index) => ({
                sql,
                bindingCount: runtimeTrace.bindings[index]?.length ?? 0,
              })),
            },
            null,
            2,
          ),
          "utf8",
        );
      }
    },
  );

  const paginationCases = (["session", "visitor"] as const).flatMap((scope) =>
    (["views", "sessions", "visitors"] as const).flatMap((sortBy) =>
      (["asc", "desc"] as const).flatMap((sortDirection) =>
        ([1, 2] as const).map((limit) => ({
          scope,
          sortBy,
          sortDirection,
          limit,
        })),
      ),
    ),
  );

  it.each(paginationCases)(
    "preserves public pagination, signed cursors, and metric ties for $scope/$sortBy/$sortDirection/limit=$limit",
    async ({ scope, sortBy, sortDirection, limit }) => {
      const { database } = createFixture();
      const runtimeTrace = traceFor();
      const provider = createD1SiteProviderRegistry({
        env: testEnv(database, runtimeTrace),
        siteId: SITE,
      }).resolve("dimension");
      if (!provider) throw new Error("wave95d_page_dimension_provider_missing");

      let cursor: string | null = null;
      const pages: DimensionPageDto[] = [];
      const legacyStatementCounts: number[] = [];
      for (let pageNumber = 0; pageNumber < 5; pageNumber += 1) {
        const query = queryFor(scope, {
          cursor,
          limit,
          sortBy,
          sortDirection,
        });
        const oldTrace = traceFor();
        const legacy = await legacyPageFor(database, query, oldTrace);
        expect(legacy.deferred).toBeDefined();
        const actual = await provider.execute(query);
        if (!("items" in actual.value))
          throw new Error("wave95d_page_dimension_result_shape_invalid");
        const actualDto = actual.value as DimensionPageDto;
        expect(actualDto).toEqual(legacy.dto);
        expect(actualDto.pagination.nextCursor).toBe(
          legacy.dto.pagination.nextCursor,
        );
        expect(oldTrace.preparedSql.length).toBeGreaterThanOrEqual(3);
        expect(runtimeTrace.preparedSql).toHaveLength((pageNumber + 1) * 2);
        pages.push(actualDto);
        legacyStatementCounts.push(oldTrace.preparedSql.length);
        cursor = legacy.dto.pagination.nextCursor;
        if (!cursor) break;
      }

      const rows = pages.flatMap((page) => page.items);
      expect(cursor).toBeNull();
      expect(new Set(rows.map((row) => row[sortBy])).size).toBe(1);
      expect(rows.map((row) => row.key)).toEqual(
        scope === "session" ? ["CA", "US"] : ["CA", "MX", "US"],
      );
      expect(pages.at(-1)?.pagination.hasMore).toBe(false);
      recordSupplementalEvidence("public-pagination", {
        scope,
        sortBy,
        sortDirection,
        limit,
        pageDtos: pages,
        metricTieValue: rows[0]?.[sortBy],
        legacyCompleteRequestStatementCounts: legacyStatementCounts,
        runtimeFusedStatementCount: runtimeTrace.preparedSql.length,
        runtimeStatements: runtimeTrace.preparedSql.map((sql, index) => ({
          sql,
          bindingCount: runtimeTrace.bindings[index]?.length ?? 0,
        })),
        signedCursorRoundTrips: pages
          .slice(0, -1)
          .map((page) => page.pagination.nextCursor),
      });
    },
  );

  const derivedShapeCases = [
    {
      dimension: "traffic.channel",
      expectedSessionKeys: ["organic_search", "referral", "social"],
      expectedVisitorKeys: ["direct", "organic_search", "referral", "social"],
    },
    {
      dimension: "client.browserEngine",
      expectedSessionKeys: ["", "Blink", "Gecko"],
      expectedVisitorKeys: ["", "Blink", "Gecko", "WebKit"],
    },
    {
      dimension: "client.osVersion",
      expectedSessionKeys: ["Linux 6.8", "Mystery OS", "Windows 11"],
      expectedVisitorKeys: ["Linux 6.8", "Mystery OS", "Windows 11", "iOS 18"],
    },
    {
      dimension: "client.screenSize",
      expectedSessionKeys: ["", "1366x768", "1920x1080"],
      expectedVisitorKeys: ["", "1366x768", "1920x1080", "390x844"],
    },
    {
      dimension: "referrer.domain",
      expectedSessionKeys: [
        "facebook.com",
        "partner.example",
        "www.google.com",
      ],
      expectedVisitorKeys: [
        "__direct__",
        "facebook.com",
        "partner.example",
        "www.google.com",
      ],
    },
    {
      dimension: "geo.region",
      expectedSessionKeys: ["", "US::CA::CA"],
      expectedVisitorKeys: ["", "CA::ON::Ontario", "US::CA::CA"],
    },
    {
      dimension: "geo.city",
      expectedSessionKeys: [
        "",
        "US::CA::CA::Oakland",
        "US::CA::CA::San Francisco",
      ],
      expectedVisitorKeys: [
        "",
        "CA::ON::Ontario::Toronto",
        "US::CA::CA::Oakland",
        "US::CA::CA::San Francisco",
      ],
    },
  ] as const;

  it.each(
    derivedShapeCases.flatMap((shape) =>
      (["session", "visitor"] as const).map((scope) => ({ shape, scope })),
    ),
  )(
    "compiles and executes the registered $shape.dimension Page expression for $scope scope",
    async ({ shape, scope }) => {
      const { database } = createDerivedFixture();
      const query = queryFor(scope, {
        dimension: shape.dimension,
        filterDsl: DERIVED_PAGE_FILTER,
      });
      const oldTrace = traceFor();
      const legacy = await legacyPageFor(database, query, oldTrace);
      expect(legacy.deferred).toBeDefined();
      if (!legacy.deferred)
        throw new Error("wave95e_page_dimension_deferred_request_missing");

      const selection = dimensionPageSelection(shape.dimension);
      if (!selection)
        throw new Error("wave95e_page_dimension_selection_missing");
      expect(selection.kind).toBe("derived");
      const compiled = compilePageDimensionQualificationProgram({
        deferred: legacy.deferred,
        query: pageQualificationQuery(query, legacy.deferred),
      });
      expect(compiled.kind).toBe("compiled");
      if (compiled.kind !== "compiled")
        throw new Error("wave95e_page_dimension_compile_unavailable");

      const qualification = buildPageDimensionQualificationPlan({
        siteId: SITE,
        queryTime: query.time,
        filters: query.filters!,
        scopePlan: query.scopePlan!,
        count: legacy.deferred.countInput,
        options: {
          selection,
          limit: query.page.limit,
          cursor: null,
          search: query.search,
          sortBy: query.sort.key,
          sortDirection: query.sort.direction,
          excludeEmpty: false,
        },
      });
      const logicalPlan = qualification.plan;
      const logicalGraph = JSON.stringify(logicalPlan, null, 2);
      const runtimeTrace = traceFor();
      const provider = createD1SiteProviderRegistry({
        env: testEnv(database, runtimeTrace),
        siteId: SITE,
      }).resolve("dimension");
      if (!provider) throw new Error("wave95e_page_dimension_provider_missing");
      const actual = await provider.execute(query);
      if (!("items" in actual.value))
        throw new Error("wave95e_page_dimension_result_shape_invalid");

      expect(actual.value).toEqual(legacy.dto);
      expect(actual.value.items.map((row) => row.key).sort()).toEqual(
        [
          ...(scope === "session"
            ? shape.expectedSessionKeys
            : shape.expectedVisitorKeys),
        ].sort(),
      );
      expect(oldTrace.preparedSql.length).toBeGreaterThanOrEqual(3);
      expect(runtimeTrace.preparedSql).toHaveLength(2);

      const compiledPhysicalShape = JSON.stringify({
        sql: compiled.evidence.sql,
        bindings: compiled.evidence.bindings,
      });
      recordSupplementalEvidence("derived-public-shape", {
        dimension: shape.dimension,
        scope,
        selection,
        compileEvidence: {
          statementTag: compiled.evidence.statementTag,
          sqlBytes: compiled.evidence.sqlBytes,
          sqlSha256: createHash("sha256")
            .update(compiled.evidence.sql, "utf8")
            .digest("hex"),
          bindingCount: compiled.evidence.bindingCount,
          physicalPlanSha256: createHash("sha256")
            .update(compiledPhysicalShape, "utf8")
            .digest("hex"),
          logicalGraphSha256: createHash("sha256")
            .update(logicalGraph, "utf8")
            .digest("hex"),
          rootKind: compiled.evidence.rootKind,
          physicalScanKinds: compiled.evidence.physicalScanKinds,
          sharedRelationCount: compiled.evidence.sharedRelationCount,
          groupWidth: compiled.evidence.groupWidth,
        },
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
        logicalGraph,
        legacyDto: legacy.dto,
        actualDto: actual.value,
        oldCompleteRequestStatementCount: oldTrace.preparedSql.length,
        oldCompleteRequestStatements: oldTrace.preparedSql.map(
          (sql, index) => ({
            sql,
            bindingCount: oldTrace.bindings[index]?.length ?? 0,
          }),
        ),
        runtimeFusedStatementCount: runtimeTrace.preparedSql.length,
        runtimeStatements: runtimeTrace.preparedSql.map((sql, index) => ({
          sql,
          bindingCount: runtimeTrace.bindings[index]?.length ?? 0,
        })),
      });
    },
  );

  const derivedPaginationCases = (["session", "visitor"] as const).flatMap(
    (scope) =>
      (["traffic.channel", "geo.city"] as const).flatMap((dimension) =>
        (["views", "sessions", "visitors"] as const).flatMap((sortBy) =>
          (["asc", "desc"] as const).map((sortDirection) => ({
            scope,
            dimension,
            sortBy,
            sortDirection,
          })),
        ),
      ),
  );

  it.each(derivedPaginationCases)(
    "preserves derived Page pagination, ordering ties, and signed cursors for $scope/$dimension/$sortBy/$sortDirection",
    async ({ scope, dimension, sortBy, sortDirection }) => {
      const { database } = createDerivedFixture();
      const trace = traceFor();
      const provider = createD1SiteProviderRegistry({
        env: testEnv(database, trace),
        siteId: SITE,
      }).resolve("dimension");
      if (!provider) throw new Error("wave95e_page_dimension_provider_missing");

      let cursor: string | null = null;
      const rows: DimensionPageDto["items"] = [];
      let requestCount = 0;
      do {
        const query = queryFor(scope, {
          cursor,
          dimension,
          limit: 1,
          sortBy,
          sortDirection,
          filterDsl: DERIVED_PAGE_FILTER,
        });
        const oldTrace = traceFor();
        const legacy = await legacyPageFor(database, query, oldTrace);
        const actual = await provider.execute(query);
        if (!("items" in actual.value))
          throw new Error("wave95e_page_dimension_result_shape_invalid");
        const actualDto = actual.value as DimensionPageDto;
        expect(actualDto).toEqual(legacy.dto);
        expect(actualDto.pagination.nextCursor).toBe(
          legacy.dto.pagination.nextCursor,
        );
        expect(oldTrace.preparedSql.length).toBeGreaterThanOrEqual(3);
        rows.push(...actualDto.items);
        cursor = legacy.dto.pagination.nextCursor;
        requestCount += 1;
        expect(requestCount).toBeLessThanOrEqual(5);
      } while (cursor);

      expect(requestCount).toBeGreaterThan(1);
      expect(trace.preparedSql).toHaveLength(requestCount * 2);
      expect(new Set(rows.map((row) => row[sortBy])).size).toBeLessThan(
        rows.length,
      );
      recordSupplementalEvidence("derived-public-pagination", {
        scope,
        dimension,
        sortBy,
        sortDirection,
        limit: 1,
        rows,
        requestCount,
        metricTieCount:
          rows.length - new Set(rows.map((row) => row[sortBy])).size,
        signedCursorRoundTrips: requestCount - 1,
        runtimeFusedStatementCount: trace.preparedSql.length,
      });
    },
  );

  const derivedSearchCases = [
    {
      dimension: "traffic.channel",
      search: "ORGANIC",
      expectedKey: "organic_search",
    },
    {
      dimension: "geo.city",
      search: "TORONTO",
      expectedKey: "CA::ON::Ontario::Toronto",
    },
    {
      dimension: "traffic.channel",
      search: "no-such-channel",
      expectedKey: null,
    },
  ] as const;

  it.each(derivedSearchCases)(
    "preserves derived Page search for $dimension/$search",
    async (testCase) => {
      const { database } = createDerivedFixture();
      const query = queryFor("visitor", {
        dimension: testCase.dimension,
        search: testCase.search,
        filterDsl: DERIVED_PAGE_FILTER,
      });
      const oldTrace = traceFor();
      const legacy = await legacyPageFor(database, query, oldTrace);
      const runtimeTrace = traceFor();
      const provider = createD1SiteProviderRegistry({
        env: testEnv(database, runtimeTrace),
        siteId: SITE,
      }).resolve("dimension");
      if (!provider) throw new Error("wave95e_page_dimension_provider_missing");
      const actual = await provider.execute(query);
      if (!("items" in actual.value))
        throw new Error("wave95e_page_dimension_result_shape_invalid");
      expect(actual.value).toEqual(legacy.dto);
      expect(actual.value.items.map((row) => row.key)).toEqual(
        testCase.expectedKey === null ? [] : [testCase.expectedKey],
      );
      recordSupplementalEvidence("derived-public-search", {
        ...testCase,
        legacyDto: legacy.dto,
        actualDto: actual.value,
        runtimeStatementCount: runtimeTrace.preparedSql.length,
      });
    },
  );

  it.each(["client.screenSize", "geo.city"] as const)(
    "includes the empty derived Page key for %s",
    async (dimension) => {
      const { database } = createDerivedFixture();
      const query = queryFor("visitor", {
        dimension,
        filterDsl: DERIVED_PAGE_FILTER,
      });
      const oldTrace = traceFor();
      const legacy = await legacyPageFor(database, query, oldTrace);
      const runtimeTrace = traceFor();
      const provider = createD1SiteProviderRegistry({
        env: testEnv(database, runtimeTrace),
        siteId: SITE,
      }).resolve("dimension");
      if (!provider) throw new Error("wave95e_page_dimension_provider_missing");
      const actual = await provider.execute(query);
      if (!("items" in actual.value))
        throw new Error("wave95e_page_dimension_result_shape_invalid");
      expect(actual.value).toEqual(legacy.dto);
      expect(actual.value.items.some((row) => row.key === "")).toBe(true);
      recordSupplementalEvidence("derived-public-empty-key", {
        dimension,
        legacyDto: legacy.dto,
        actualDto: actual.value,
        runtimeStatementCount: runtimeTrace.preparedSql.length,
      });
    },
  );

  it.each([
    ["client.osVersion", "osVersion"],
    ["client.screenSize", "screenSize"],
  ] as const)(
    "shares canonical selection and signed cursors for %s/%s",
    async (left, right) => {
      for (const [firstAlias, secondAlias] of [
        [left, right],
        [right, left],
      ] as const) {
        const { database } = createDerivedFixture();
        const firstQuery = queryFor("visitor", {
          dimension: firstAlias,
          limit: 1,
          filterDsl: DERIVED_PAGE_FILTER,
        });
        const firstTrace = traceFor();
        const firstLegacy = await legacyPageFor(
          database,
          firstQuery,
          firstTrace,
        );
        const firstRuntimeTrace = traceFor();
        const provider = createD1SiteProviderRegistry({
          env: testEnv(database, firstRuntimeTrace),
          siteId: SITE,
        }).resolve("dimension");
        if (!provider)
          throw new Error("wave95e_page_dimension_provider_missing");
        const firstActual = await provider.execute(firstQuery);
        if (!("items" in firstActual.value))
          throw new Error("wave95e_page_dimension_result_shape_invalid");
        expect(firstActual.value).toEqual(firstLegacy.dto);
        expect(firstLegacy.dto.pagination.nextCursor).not.toBeNull();

        const secondQuery = queryFor("visitor", {
          dimension: secondAlias,
          cursor: firstLegacy.dto.pagination.nextCursor,
          limit: 1,
          filterDsl: DERIVED_PAGE_FILTER,
        });
        const secondTrace = traceFor();
        const secondLegacy = await legacyPageFor(
          database,
          secondQuery,
          secondTrace,
        );
        const secondActual = await provider.execute(secondQuery);
        if (!("items" in secondActual.value))
          throw new Error("wave95e_page_dimension_result_shape_invalid");
        expect(secondActual.value).toEqual(secondLegacy.dto);
        expect(dimensionPageSelection(firstAlias)).toEqual(
          dimensionPageSelection(secondAlias),
        );
        recordSupplementalEvidence("derived-alias-cursor-binding", {
          firstAlias,
          secondAlias,
          canonicalSelection: dimensionPageSelection(firstAlias),
          firstPageDto: firstActual.value,
          secondPageDto: secondActual.value,
          legacySecondPageDto: secondLegacy.dto,
          cursorAcceptedAcrossAliases: true,
          runtimeFusedStatementCount: firstRuntimeTrace.preparedSql.length,
        });
      }
    },
  );

  it.each([
    {
      kind: "mixed-or",
      filterDsl:
        'page.path eq "/landing" or count(event { event.name eq "qualifier" }) eq 1',
      expectedDeferred: true,
    },
    {
      kind: "mixed-not",
      filterDsl:
        'not (page.path eq "/other" and count(event { event.name eq "qualifier" }) eq 1)',
      expectedDeferred: true,
    },
    {
      kind: "count-only-or",
      filterDsl:
        'count(event { event.name eq "qualifier" }) eq 1 or count(event { event.name eq "absent" }) eq 1',
      expectedDeferred: true,
    },
    {
      kind: "count-only-not",
      filterDsl: 'not (count(event { event.name eq "qualifier" }) eq 2)',
      expectedDeferred: true,
    },
  ] as const)(
    "keeps middleware and public Page DTO aligned for $kind",
    async ({ kind, filterDsl, expectedDeferred }) => {
      const { database } = createFixture();
      const query = queryFor("session", { filterDsl, limit: 2 });
      const oldTrace = traceFor();
      const legacy = await legacyPageFor(database, query, oldTrace);
      expect(Boolean(legacy.deferred)).toBe(expectedDeferred);
      if (kind.startsWith("mixed-"))
        expect(legacy.deferred?.pageDimensionFilterMode).toBe(
          "allow-whole-filter",
        );

      const runtimeTrace = traceFor();
      const provider = createD1SiteProviderRegistry({
        env: testEnv(database, runtimeTrace),
        siteId: SITE,
      }).resolve("dimension");
      if (!provider) throw new Error("wave95d_page_dimension_provider_missing");
      const actual = await provider.execute(query);
      if (!("items" in actual.value))
        throw new Error("wave95d_page_dimension_result_shape_invalid");
      expect(actual.value).toEqual(legacy.dto);

      let compiledTag: string | undefined;
      let compiledSql: string | undefined;
      let compiledBindings: SQLInputValue[] | undefined;
      if (legacy.deferred) {
        const compiled = compilePageDimensionQualificationProgram({
          deferred: legacy.deferred,
          query: pageQualificationQuery(query, legacy.deferred),
        });
        expect(compiled.kind).toBe("compiled");
        if (compiled.kind === "compiled") {
          compiledTag = compiled.evidence.statementTag;
          compiledSql = compiled.evidence.sql;
          expect(runtimeTrace.preparedSql).toContain(compiled.evidence.sql);
          const compiledStatementIndex = runtimeTrace.preparedSql.indexOf(
            compiled.evidence.sql,
          );
          if (compiledStatementIndex < 0)
            throw new Error(
              "wave95d_page_dimension_compiled_statement_missing",
            );
          const executedBindings =
            runtimeTrace.bindings[compiledStatementIndex];
          if (!executedBindings)
            throw new Error("wave95d_page_dimension_compiled_bindings_missing");
          compiledBindings = [...executedBindings];
          expect(compiledBindings).toEqual(compiled.evidence.bindings);
          if (kind.startsWith("mixed-")) {
            expect(runtimeTrace.preparedSql).toHaveLength(2);
            expect(runtimeTrace.preparedSql[1]).toBe(compiled.evidence.sql);
            expect(runtimeTrace.bindings[1]).toEqual(
              compiled.evidence.bindings,
            );
          }
        }
      }
      recordSupplementalEvidence("middleware-boolean-filter", {
        evidenceKind: "middleware-boolean-filter",
        kind,
        filterDsl,
        audience: query.context.policy.audience,
        expectedDeferred,
        actualDeferred: Boolean(legacy.deferred),
        pageDimensionFilterMode:
          legacy.deferred?.pageDimensionFilterMode ?? null,
        legacyDto: legacy.dto,
        actualDto: actual.value,
        compiledStatementTag: compiledTag,
        compiledSql,
        compiledBindings,
        legacyStatements: oldTrace.preparedSql.map((sql, index) => ({
          sql,
          bindingCount: oldTrace.bindings[index]?.length ?? 0,
          bindings: oldTrace.bindings[index] ?? [],
        })),
        runtimeStatements: runtimeTrace.preparedSql.map((sql, index) => ({
          sql,
          bindingCount: runtimeTrace.bindings[index]?.length ?? 0,
          bindings: runtimeTrace.bindings[index] ?? [],
        })),
      });
    },
  );

  it("covers stored path and hostname normalization, search, empty values, and null predicates", async () => {
    const { database, site } = createFixture();
    database
      .prepare("UPDATE visits SET hostname = ? WHERE visit_id = ?")
      .run(" Alpha.test ", "visit-1");
    database
      .prepare("UPDATE visits SET hostname = ? WHERE visit_id = ?")
      .run(" beta.test ", "visit-2");
    database
      .prepare("UPDATE visits SET hostname = ? WHERE visit_id = ?")
      .run("", "visit-3");
    addVisit(database, site, {
      id: "visit-empty-dimension",
      sessionId: "session-1",
      visitorId: "visitor-1",
      path: "",
      country: "",
      hostname: "   ",
      startedAt: 129,
    });

    const cases = [
      {
        label: "trimmed-path",
        query: queryFor("session", { dimension: "page.path" }),
        expectedKeys: ["", "/landing", "/other"],
      },
      {
        label: "trimmed-hostname",
        query: queryFor("session", { dimension: "page.hostname" }),
        expectedKeys: ["", "Alpha.test", "beta.test"],
      },
      {
        label: "case-insensitive-search",
        query: queryFor("visitor", {
          dimension: "page.hostname",
          search: "ALPHA",
        }),
        expectedKeys: ["Alpha.test"],
      },
      {
        label: "null-predicate-empty-result",
        query: queryFor("session", {
          dimension: "page.path",
          filterDsl:
            'page.path isNull and count(event { event.name eq "qualifier" }) eq 1',
        }),
        expectedKeys: [],
      },
    ] as const;

    for (const { label, query, expectedKeys } of cases) {
      const oldTrace = traceFor();
      const legacy = await legacyPageFor(database, query, oldTrace);
      const runtimeTrace = traceFor();
      const provider = createD1SiteProviderRegistry({
        env: testEnv(database, runtimeTrace),
        siteId: SITE,
      }).resolve("dimension");
      if (!provider) throw new Error("wave95d_page_dimension_provider_missing");
      const actual = await provider.execute(query);
      if (!("items" in actual.value))
        throw new Error("wave95d_page_dimension_result_shape_invalid");
      expect(actual.value).toEqual(legacy.dto);
      expect(actual.value.items.map((row) => row.key)).toEqual(expectedKeys);
      recordSupplementalEvidence("stored-dimension-normalization", {
        label,
        dimension: query.dimension,
        search: query.search,
        expectedKeys,
        actualDto: actual.value,
        legacyStatementCount: oldTrace.preparedSql.length,
        runtimeStatementCount: runtimeTrace.preparedSql.length,
      });
    }
  });

  it("returns an empty DTO and no cursor when the Count match is empty", async () => {
    const { database } = createFixture();
    const query = queryFor("visitor", {
      limit: 1,
      filterDsl: 'count(event { event.name eq "absent" }) eq 1',
    });
    const oldTrace = traceFor();
    const legacy = await legacyPageFor(database, query, oldTrace);
    const runtimeTrace = traceFor();
    const provider = createD1SiteProviderRegistry({
      env: testEnv(database, runtimeTrace),
      siteId: SITE,
    }).resolve("dimension");
    if (!provider) throw new Error("wave95d_page_dimension_provider_missing");
    const actual = await provider.execute(query);
    if (!("items" in actual.value))
      throw new Error("wave95d_page_dimension_result_shape_invalid");
    const actualDto = actual.value as DimensionPageDto;
    expect(actualDto).toEqual(legacy.dto);
    expect(actualDto.items).toEqual([]);
    expect(actualDto.pagination).toMatchObject({
      returned: 0,
      hasMore: false,
      nextCursor: null,
    });
    recordSupplementalEvidence("empty-count-match", {
      legacyDto: legacy.dto,
      actualDto,
      legacyCompleteRequestStatementCount: oldTrace.preparedSql.length,
      runtimeStatements: runtimeTrace.preparedSql.map((sql, index) => ({
        sql,
        bindingCount: runtimeTrace.bindings[index]?.length ?? 0,
      })),
    });
  });

  it("rejects pre-abort, site/time context, sort, and selection mismatches before report SQL", async () => {
    const { database } = createFixture();
    const query = queryFor("session", { dimension: "traffic.channel" });

    const abortTrace = traceFor();
    const abortProvider = createD1SiteProviderRegistry({
      env: testEnv(database, abortTrace),
      siteId: SITE,
    }).resolve("dimension");
    if (!abortProvider)
      throw new Error("wave95d_page_dimension_abort_provider_missing");
    const controller = new AbortController();
    controller.abort();
    await expect(
      abortProvider.execute(query, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(abortTrace.preparedSql).toHaveLength(0);

    const timeTrace = traceFor();
    const timeProvider = createD1SiteProviderRegistry({
      env: testEnv(database, timeTrace),
      siteId: SITE,
    }).resolve("dimension");
    if (!timeProvider)
      throw new Error("wave95d_page_dimension_time_provider_missing");
    const mismatchedTime = {
      ...query,
      time: createQueryTime(110, 130, "UTC", 500),
    } as DimensionTestQuery;
    await expect(timeProvider.execute(mismatchedTime)).rejects.toThrow();
    expect(timeTrace.preparedSql).toHaveLength(0);

    const siteTrace = traceFor();
    const siteProvider = createD1SiteProviderRegistry({
      env: testEnv(database, siteTrace),
      siteId: SITE,
    }).resolve("dimension");
    if (!siteProvider)
      throw new Error("wave95d_page_dimension_site_provider_missing");
    const mismatchedSite = {
      ...query,
      context: siteQueryContext(SITE + "-other", "private-dashboard"),
    } as unknown as DimensionTestQuery;
    await expect(siteProvider.execute(mismatchedSite)).rejects.toThrow();
    expect(siteTrace.preparedSql).toHaveLength(0);

    const expectedSiteTrace = traceFor();
    const expectedSiteProvider = createD1SiteProviderRegistry({
      env: testEnv(database, expectedSiteTrace),
      siteId: SITE + "-other",
    }).resolve("dimension");
    if (!expectedSiteProvider)
      throw new Error("wave95d_page_dimension_expected_site_provider_missing");
    await expect(expectedSiteProvider.execute(query)).rejects.toThrow();
    expect(expectedSiteTrace.preparedSql).toHaveLength(0);

    const compileTrace = traceFor();
    const compileEnv = testEnv(database, compileTrace);
    const forwarded = await d1AdvancedFilterMiddleware(
      compileEnv,
      undefined,
      SITE,
    )("dimension", query, async (prepared) => prepared);
    const deferred = deferredPageDimensionQualificationFromQuery(forwarded);
    if (!deferred)
      throw new Error("wave95d_page_dimension_deferred_request_missing");
    const validRequest = pageQualificationQuery(query, deferred);
    compileTrace.preparedSql.length = 0;
    compileTrace.bindings.length = 0;
    const selectionMismatch = dimensionPageSelection("geo.region");
    if (!selectionMismatch)
      throw new Error("wave95d_page_dimension_hostname_selection_missing");
    const mismatches: Array<{
      readonly kind: string;
      readonly query: typeof validRequest;
    }> = [
      {
        kind: "site",
        query: { ...validRequest, siteId: SITE + "-other" },
      },
      {
        kind: "time",
        query: {
          ...validRequest,
          queryTime: createQueryTime(110, 130, "UTC", 500),
        },
      },
      {
        kind: "sort",
        query: { ...validRequest, sortBy: "sessions" },
      },
      {
        kind: "selection",
        query: { ...validRequest, selection: selectionMismatch },
      },
      {
        kind: "cursor-token",
        query: { ...validRequest, cursorToken: "different-cursor" },
      },
      {
        kind: "unregistered-selection",
        query: {
          ...validRequest,
          selection: {
            id: "unregistered",
            kind: "derived",
            dimension: "notARegisteredPageDimension",
          } as unknown as PageDimensionSelection,
        },
      },
    ];
    for (const mismatch of mismatches) {
      expect(() =>
        compilePageDimensionQualificationProgram({
          deferred,
          query: mismatch.query,
        }),
      ).toThrow();
    }
    expect(compileTrace.preparedSql).toHaveLength(0);
    recordSupplementalEvidence("preflight-context-mismatches", {
      preAbortStatements: abortTrace.preparedSql.length,
      publicTimeMismatchStatements: timeTrace.preparedSql.length,
      publicSubjectSiteMismatchStatements: siteTrace.preparedSql.length,
      expectedSiteMismatchStatements: expectedSiteTrace.preparedSql.length,
      compilerMismatches: mismatches.map(({ kind }) => kind),
      compilerStatementsAfterMismatch: compileTrace.preparedSql.length,
      environmentMismatch:
        "No independent env argument exists at the branded Page compiler boundary; execution uses the env captured by middleware.",
    });
  });

  it("rejects a Page primary source declaration mismatch through the validated logical lowerer", async () => {
    const { database } = createFixture();
    const query = queryFor("session");
    const env = testEnv(database, traceFor());
    const forwarded = await d1AdvancedFilterMiddleware(env, undefined, SITE)(
      "dimension",
      query,
      async (prepared) => prepared,
    );
    const deferred = deferredPageDimensionQualificationFromQuery(forwarded);
    if (!deferred)
      throw new Error("wave95d_page_dimension_deferred_request_missing");
    const selection = dimensionPageSelection(query.dimension);
    if (!selection) throw new Error("wave95d_page_dimension_selection_missing");
    const qualification = buildPageDimensionQualificationPlan({
      siteId: SITE,
      queryTime: query.time,
      filters: query.filters!,
      scopePlan: query.scopePlan!,
      count: deferred.countInput,
      options: {
        selection,
        limit: query.page.limit,
        cursor: null,
        search: query.search,
        sortBy: query.sort.key,
        sortDirection: query.sort.direction,
        excludeEmpty: false,
      },
    });
    const controlsOutput = qualification.plan.outputs.find(
      (output) => output.id === qualification.controlOutputId,
    );
    const reportOutput = qualification.plan.outputs.find(
      (output) => output.id === DIMENSION_PAGE_REPORT_OUTPUT,
    );
    if (!controlsOutput || !reportOutput)
      throw new Error("wave95d_page_dimension_logical_outputs_missing");
    const mismatchedPolicy: AnalyticsQualificationAdmissionPolicy = {
      primaryReportSourceRelationId:
        qualification.primaryReportSourceRelationId,
      reportSourceRelations: qualification.reportSourceRelations.map(
        ({ relationId }) => ({ relationId, entity: "event" as const }),
      ),
      reportRelationIds: [reportOutput.relation],
      controlsRelationId: qualification.controlsRelationId,
      controlSlots: controlsOutput.fields.map(({ name, slot }) => ({
        name,
        slot,
      })),
      scope: qualification.scope,
      maximumActivities: ADVANCED_FILTER_MAX_ACTIVITIES,
      numericCompatibilityControlNames:
        qualification.numericCompatibilityFields.map(
          ({ invalidCountOutput }) => invalidCountOutput,
        ),
    };
    const lowerer = new AnalyticsLogicalToDbLowerer(
      qualification.plan,
      { siteId: SITE, time: qualification.plan.context.time },
      { analyticsQualificationAdmissionPolicy: mismatchedPolicy },
    );
    expect(() => lowerer.lowerMany(qualification.plan.outputs)).toThrow(
      "Provider analytics qualification admission must target its exact reachable primary Page/Event Source, report Sources, and one reachable controls output.",
    );
    recordSupplementalEvidence("validated-page-lowerer-admission", {
      validatedPlanNodeCount: qualification.plan.nodes.length,
      validatedOutputIds: qualification.plan.outputs.map((output) => output.id),
      expectedPrimaryReportSourceRelationId:
        qualification.primaryReportSourceRelationId,
      declaredReportSources: mismatchedPolicy.reportSourceRelations,
      rejected: true,
    });
  });

  it("enforces the real 20001 activity cap before numeric fallback and cursor validation", async () => {
    const database = createMigratedDatabase();
    DATABASES.add(database);
    database.exec("PRAGMA foreign_keys = OFF");
    const site = addSite(database);
    const bulkCount = ADVANCED_FILTER_MAX_ACTIVITIES + 1;
    database
      .prepare(
        "WITH RECURSIVE generated(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM generated WHERE n < ?) INSERT INTO visits (visit_id, site_id, site_pk, visitor_id, session_id, status, started_at, last_activity_at, pathname, hostname, duration_ms) SELECT 'wave95d-cap-' || n, ?, ?, 'wave95d-cap-visitor', 'wave95d-cap-session', 'closed', ?, ?, '/bulk', 'bulk.test', 10 FROM generated",
      )
      .run(
        bulkCount,
        SITE,
        site.pk,
        TIME.range.startMs + 5,
        TIME.range.startMs + 5,
      );
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "wave95d-cap-1");

    const trace = traceFor();
    const diagnostics = createD1ReadDiagnostics();
    const env = testEnv(database, trace);
    const provider = createD1SiteProviderRegistry({
      env,
      siteId: SITE,
      diagnostics,
    }).resolve("dimension");
    if (!provider) throw new Error("wave95d_page_dimension_provider_missing");
    const filterDsl =
      'page.path eq "/bulk" and count(page { page.durationMs gt 5 }) eq 1';
    const capQuery = queryFor("session", { filterDsl });
    await expect(provider.execute(capQuery)).rejects.toMatchObject({
      domainError: {
        kind: "invalid-input",
        issues: [{ path: "filters", code: "filter_activity_limit_exceeded" }],
      },
    });
    expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
    expect(trace.preparedSql).toHaveLength(2);
    const rawRows = database
      .prepare(trace.preparedSql[1]!)
      .all(...trace.bindings[1]!) as Record<string, unknown>[];
    const controls = rawRows.filter((row) => row.rowKind === "control");
    expect(controls).toHaveLength(1);
    expect(Number(controls[0]!.rawCount)).toBe(bulkCount);
    const numericMismatch = Object.entries(controls[0]!).find(
      ([name, value]) =>
        name.toLowerCase().includes("duration") && Number(value) > 0,
    );
    expect(numericMismatch).toBeDefined();
    expect(rawRows.filter((row) => row.rowKind === "report")).toHaveLength(0);

    trace.preparedSql.length = 0;
    trace.bindings.length = 0;
    const invalidCursorQuery = queryFor("session", {
      cursor: "invalid-cursor",
      filterDsl,
    });
    await expect(provider.execute(invalidCursorQuery)).rejects.toMatchObject({
      domainError: {
        kind: "invalid-input",
        issues: [{ path: "filters", code: "filter_activity_limit_exceeded" }],
      },
    });
    expect(trace.preparedSql).toHaveLength(2);
    const cursorRows = database
      .prepare(trace.preparedSql[1]!)
      .all(...trace.bindings[1]!) as Record<string, unknown>[];
    const cursorControls = cursorRows.filter(
      (row) => row.rowKind === "control",
    );
    expect(cursorControls).toHaveLength(1);
    expect(Number(cursorControls[0]!.rawCount)).toBe(bulkCount);
    expect(cursorRows.filter((row) => row.rowKind === "report")).toHaveLength(
      0,
    );
    expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
    recordSupplementalEvidence("activity-cap-precedence", {
      activityLimit: ADVANCED_FILTER_MAX_ACTIVITIES,
      rawCount: Number(controls[0]!.rawCount),
      numericMismatch: numericMismatch?.[1],
      reportRows: 0,
      errorCode: "filter_activity_limit_exceeded",
      initialStatementCount: 2,
      invalidCursorStatementCount: trace.preparedSql.length,
      invalidCursorRawCount: Number(cursorControls[0]!.rawCount),
      fallbackReason: diagnostics.advancedCountSqlFallbackReason,
    });
  });

  it("falls back once for numeric incompatibility and preserves the complete legacy Page DTO", async () => {
    const { database } = createFixture();
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run(10, "visit-1");
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "visit-2");
    const query = queryFor("session", {
      dimension: "client.screenSize",
      limit: 10,
      filterDsl:
        'page.path eq "/landing" and count(event { event.name eq "qualifier" }) eq 1 and count(page { page.durationMs gt 5 }) eq 1',
    });

    const oldTrace = traceFor();
    const legacy = await legacyPageFor(database, query, oldTrace);
    expect(legacy.deferred).toBeDefined();
    if (!legacy.deferred)
      throw new Error("wave95d_page_dimension_deferred_request_missing");
    const selection = dimensionPageSelection(query.dimension);
    if (!selection) throw new Error("wave95d_page_dimension_selection_missing");
    const compiled = compilePageDimensionQualificationProgram({
      deferred: legacy.deferred,
      query: pageQualificationQuery(query, legacy.deferred),
    });
    expect(compiled.kind).toBe("compiled");
    if (compiled.kind !== "compiled")
      throw new Error("wave95d_page_dimension_numeric_compile_unavailable");

    const runtimeTrace = traceFor();
    const diagnostics = createD1ReadDiagnostics();
    const provider = createD1SiteProviderRegistry({
      env: testEnv(database, runtimeTrace),
      siteId: SITE,
      diagnostics,
    }).resolve("dimension");
    if (!provider) throw new Error("wave95d_page_dimension_provider_missing");
    const actual = await provider.execute(query);
    if (!("items" in actual.value))
      throw new Error("wave95d_page_dimension_result_shape_invalid");
    const actualDto = actual.value as DimensionPageDto;
    expect(actualDto).toEqual(legacy.dto);
    expect(actualDto.pagination.nextCursor).toBeNull();
    expect(diagnostics.advancedCountSqlFallbackReason).toMatchObject({
      kind: "numeric-data-domain",
    });
    expect(runtimeTrace.preparedSql).toHaveLength(
      oldTrace.preparedSql.length + 1,
    );
    expect(runtimeTrace.preparedSql).toContain(compiled.evidence.sql);
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
    recordSupplementalEvidence(
      "numeric-compatibility-whole-operation-fallback",
      {
        fallbackReason: diagnostics.advancedCountSqlFallbackReason,
        legacyDto: legacy.dto,
        actualDto,
        statementTag: compiled.evidence.statementTag,
        oldCompleteRequestStatementCount: oldTrace.preparedSql.length,
        oldCompleteRequestStatements: oldTrace.preparedSql.map(
          (sql, index) => ({
            sql,
            bindingCount: oldTrace.bindings[index]?.length ?? 0,
          }),
        ),
        actualStatementCount: runtimeTrace.preparedSql.length,
        actualStatements: runtimeTrace.preparedSql.map((sql, index) => ({
          sql,
          bindingCount: runtimeTrace.bindings[index]?.length ?? 0,
        })),
        reportRowsFromRejectedFusedStatement: 0,
        additionalFusedAttemptCount:
          runtimeTrace.preparedSql.length - oldTrace.preparedSql.length,
        hasFurtherPage: actualDto.pagination.hasMore,
      },
    );
  });

  it("propagates SQLite failures and malformed control envelopes without fallback", async () => {
    const query = queryFor("session", { dimension: "traffic.channel" });
    const malformedCases = [
      {
        kind: "missing-control",
        expectedError:
          "analytics_event_summary_qualification_control_row_invalid",
      },
      {
        kind: "duplicate-control",
        expectedError:
          "analytics_event_summary_qualification_control_row_invalid",
      },
      {
        kind: "wrong-control-scope",
        expectedError:
          "analytics_event_summary_qualification_control_kind_mismatch",
      },
    ] as const;

    for (const testCase of malformedCases) {
      const { database } = createFixture();
      const trace = traceFor();
      const provider = createD1SiteProviderRegistry({
        env: testEnvWithControlResultBehavior(database, trace, testCase.kind),
        siteId: SITE,
      }).resolve("dimension");
      if (!provider)
        throw new Error("wave95d_page_dimension_malformed_provider_missing");
      await expect(provider.execute(query)).rejects.toThrow(
        testCase.expectedError,
      );
      expect(trace.preparedSql).toHaveLength(2);
      recordSupplementalEvidence("malformed-control-no-fallback", {
        kind: testCase.kind,
        expectedError: testCase.expectedError,
        preparedStatementCount: trace.preparedSql.length,
        fallbackRan: false,
        statements: trace.preparedSql.map((sql, index) => ({
          sql,
          bindingCount: trace.bindings[index]?.length ?? 0,
        })),
      });
    }

    const { database } = createFixture();
    database.exec("DROP TABLE visits");
    const trace = traceFor();
    const provider = createD1SiteProviderRegistry({
      env: testEnv(database, trace),
      siteId: SITE,
    }).resolve("dimension");
    if (!provider)
      throw new Error("wave95d_page_dimension_database_error_provider_missing");
    await expect(provider.execute(query)).rejects.toThrow(
      "no such table: visits",
    );
    expect(trace.preparedSql).toHaveLength(2);
    recordSupplementalEvidence("sqlite-failure-no-fallback", {
      error: "no such table: visits",
      preparedStatementCount: trace.preparedSql.length,
      fallbackRan: false,
      statements: trace.preparedSql.map((sql, index) => ({
        sql,
        bindingCount: trace.bindings[index]?.length ?? 0,
      })),
    });
  });
});

describe("qualified Page whole-filter contracts", () => {
  it("keeps split-only defaults and proves whole Count trees only by exact normalization", () => {
    const mixedOr = parseFilterDsl(
      'page.path eq "/landing" or count(event { event.name eq "qualifier" }) eq 1',
      analyticsFilterRegistry,
    );
    const mixedNot = parseFilterDsl(
      'not (page.path eq "/landing" and count(event { event.name eq "qualifier" }) eq 1)',
      analyticsFilterRegistry,
    );

    expect(resolveQualifiedSourceFilters(mixedOr).kind).toBe("unsupported");
    expect(resolveJourneyListQualificationFilters(mixedOr)).toEqual(
      resolveQualifiedSourceFilters(mixedOr),
    );
    const wholeOr = resolveQualifiedSourceFilters(
      mixedOr,
      "allow-whole-filter",
    );
    expect(wholeOr).toEqual({
      kind: "supported",
      mode: "whole-filter",
      nativeFilters: { version: 1, root: null },
      countFilters: mixedOr,
    });
    expect(
      resolveQualifiedSourceFilters(mixedNot, "allow-whole-filter"),
    ).toMatchObject({ kind: "supported", mode: "whole-filter" });
    expect(() =>
      assertWholeFilterCountDocument(
        mixedOr,
        mixedOr,
        "qualified_page_whole_filter_count_document_mismatch",
      ),
    ).not.toThrow();
    expect(() =>
      assertWholeFilterCountDocument(
        mixedOr,
        mixedNot,
        "qualified_page_whole_filter_count_document_mismatch",
      ),
    ).toThrow("qualified_page_whole_filter_count_document_mismatch");
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
    "matches complete legacy DTOs and independent Page values for %s scope",
    async (scope) => {
      const { database } = createFixture();
      installPrivatePageFieldRows(database);
      for (const filterCase of filterCases) {
        for (const dimension of PRIVATE_PAGE_FIELDS) {
          const query = queryFor(scope, {
            dimension,
            limit: 20,
            filterDsl: filterCase.filterDsl,
          });
          const legacyTrace = traceFor();
          const legacy = await legacyPageFor(database, query, legacyTrace);
          if (!legacy.deferred)
            throw new Error("wave97df_page_dimension_deferred_missing");
          expect(legacy.deferred.pageDimensionFilterMode).toBe(
            "allow-whole-filter",
          );
          expect(legacy.deferred.pageDimensionRequest?.selection.id).toBe(
            dimension === "page.path"
              ? "pagePathTrimmed"
              : dimension === "page.title"
                ? "pageTitleTrimmed"
                : "pageHostnameTrimmed",
          );

          const runtimeTrace = traceFor();
          const diagnostics = createD1ReadDiagnostics();
          const provider = createD1SiteProviderRegistry({
            env: testEnv(database, runtimeTrace),
            siteId: SITE,
            diagnostics,
          }).resolve("dimension");
          if (!provider)
            throw new Error("wave97df_page_dimension_provider_missing");
          const actual = await provider.execute(query);
          if (!("items" in actual.value))
            throw new Error("wave97df_page_dimension_result_shape_invalid");
          expect(actual.value).toEqual(legacy.dto);
          const actualItems = actual.value.items
            .map((row) => ({
              key: row.key,
              views: row.views,
              sessions: row.sessions,
              visitors: row.visitors,
            }))
            .sort((left, right) =>
              left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
            );
          expect(actualItems).toEqual(
            independentPageFieldItems({
              dimension,
              filterKind: filterCase.kind,
              scope,
            }),
          );
          expect(new Set(actual.value.items.map((row) => row.key)).size).toBe(
            actual.value.items.length,
          );
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
            query: pageQualificationQuery(query, legacy.deferred),
          });
          expect(compiled.kind).toBe("compiled");
          if (compiled.kind !== "compiled")
            throw new Error("wave97df_page_dimension_compile_unavailable");
          expect(reportEnvelopeSql).toBe(compiled.evidence.sql);
          expect(runtimeTrace.bindings[1]).toEqual(compiled.evidence.bindings);
          recordSupplementalEvidence(
            "private-page-field-whole-boolean-breakdown",
            {
              dimension,
              scope,
              filterKind: filterCase.kind,
              filterDsl: filterCase.filterDsl,
              mode: "breakdown",
              selection: legacy.deferred.pageDimensionRequest?.selection,
              excludeEmpty: false,
              independentExpectedItems: independentPageFieldItems({
                dimension,
                filterKind: filterCase.kind,
                scope,
              }),
              legacyDto: legacy.dto,
              actualDto: actual.value,
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
            },
          );
        }
      }
    },
  );

  it("binds the old cursor to its Page field, mode, and owner scope", async () => {
    const { database } = createFixture();
    installPrivatePageFieldRows(database);
    const filterDsl = filterCases[0]!.filterDsl;
    const firstQuery = queryFor("visitor", {
      dimension: "page.path",
      limit: 2,
      filterDsl,
    });
    const firstLegacy = await legacyPageFor(database, firstQuery, traceFor());
    if (!firstLegacy.deferred)
      throw new Error("wave97df_page_dimension_cursor_deferred_missing");
    expect(firstLegacy.dto.pagination.hasMore).toBe(true);
    expect(firstLegacy.dto.pagination.nextCursor).toBeTruthy();

    const provider = createD1SiteProviderRegistry({
      env: testEnv(database, traceFor()),
      siteId: SITE,
    }).resolve("dimension");
    if (!provider)
      throw new Error("wave97df_page_dimension_cursor_provider_missing");
    const firstTrace = traceFor();
    const firstActualProvider = createD1SiteProviderRegistry({
      env: testEnv(database, firstTrace),
      siteId: SITE,
    }).resolve("dimension");
    if (!firstActualProvider)
      throw new Error("wave97df_page_dimension_cursor_provider_missing");
    const firstActual = await firstActualProvider.execute(firstQuery);
    expect(firstActual.value).toEqual(firstLegacy.dto);
    if (!("items" in firstActual.value))
      throw new Error("wave97df_page_dimension_cursor_shape_invalid");

    const cursor = firstLegacy.dto.pagination.nextCursor;
    if (!cursor) throw new Error("wave97df_page_dimension_cursor_missing");
    const secondQuery = queryFor("visitor", {
      dimension: "page.path",
      limit: 2,
      cursor,
      filterDsl,
    });
    const secondLegacy = await legacyPageFor(database, secondQuery, traceFor());
    const secondTrace = traceFor();
    const secondActualProvider = createD1SiteProviderRegistry({
      env: testEnv(database, secondTrace),
      siteId: SITE,
    }).resolve("dimension");
    if (!secondActualProvider)
      throw new Error("wave97df_page_dimension_cursor_provider_missing");
    const secondActual = await secondActualProvider.execute(secondQuery);
    expect(secondActual.value).toEqual(secondLegacy.dto);
    const secondDto = secondActual.value as typeof secondLegacy.dto;
    expect(secondDto.items).toHaveLength(1);
    expect(secondDto.pagination.hasMore).toBe(false);
    expect(firstLegacy.dto.items.map((row) => row.views)).toEqual([1, 1]);
    const actualCursorKeys = [
      ...firstActual.value.items.map((row) => row.key),
      ...secondDto.items.map((row) => row.key),
    ].sort();
    expect(actualCursorKeys).toEqual(
      independentPageFieldItems({
        dimension: "page.path",
        filterKind: "mixed-or",
        scope: "visitor",
      }).map((row) => row.key),
    );

    await expect(
      provider.execute(
        queryFor("visitor", {
          dimension: "page.title",
          limit: 2,
          cursor,
          filterDsl,
        }),
      ),
    ).rejects.toThrow();
    await expect(
      provider.execute(
        queryFor("session", {
          dimension: "page.path",
          limit: 2,
          cursor,
          filterDsl,
        }),
      ),
    ).rejects.toThrow();
    await expect(
      provider.execute({
        ...firstQuery,
        mode: "overview-tab",
        tab: "page.path",
        limit: 2,
        cursor,
      } as unknown as DimensionTestQuery),
    ).rejects.toThrow();
    recordSupplementalEvidence(
      "private-page-field-whole-boolean-breakdown-cursor",
      {
        dimension: "page.path",
        scope: "visitor",
        oldFirstDto: firstLegacy.dto,
        actualFirstDto: firstActual.value,
        oldSecondDto: secondLegacy.dto,
        actualSecondDto: secondActual.value,
        oldCursorContinued: true,
        tiedViews: firstLegacy.dto.items.map((row) => row.views),
        invalidatedBindings: ["field", "scope", "mode"],
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
      },
    );
  });

  it("opts in only for exact private fields without comparison state", async () => {
    const { database } = createFixture();
    const gateTrace = traceFor();
    const env = testEnv(database, gateTrace);
    const middleware = d1AdvancedFilterMiddleware(env, undefined, SITE);
    const forward = (query: DimensionTestQuery) =>
      middleware("dimension", query, async (prepared) => prepared);
    const expectUnsafeWithoutReads = async (
      query: DimensionTestQuery,
      reads: { value: number },
    ) => {
      const statementsBefore = gateTrace.preparedSql.length;
      await expect(forward(query)).rejects.toMatchObject({
        domainError: {
          kind: "invalid-input",
          issues: [
            {
              path: "comparison",
              code: "comparison_request_own_data_required",
            },
          ],
        },
      });
      expect(reads.value).toBe(0);
      expect(gateTrace.preparedSql).toHaveLength(statementsBefore);
    };
    const mixedOr = filterCases[0]!.filterDsl;
    const eligible = queryFor("session", {
      dimension: "page.path",
      filterDsl: mixedOr,
    });
    const eligibleForwarded = await forward(eligible);
    const eligibleDeferred =
      deferredPageDimensionQualificationFromQuery(eligibleForwarded);
    expect(eligibleDeferred?.pageDimensionFilterMode).toBe(
      "allow-whole-filter",
    );

    const canonicalDimensions = [
      ...new Set([
        ...CROSS_BREAKDOWN_DIMENSIONS,
        "page.query",
        "page.hash",
        "country",
        "geo.timezone",
      ]),
    ];
    for (const dimension of canonicalDimensions) {
      const selection = dimensionPageSelection(dimension);
      if (!selection)
        throw new Error(`wave97dg_dimension_registry_missing:${dimension}`);
      const forwarded = await forward(
        queryFor("session", { dimension, filterDsl: mixedOr }),
      );
      const deferred = deferredPageDimensionQualificationFromQuery(forwarded);
      expect(deferred?.pageDimensionFilterMode).toBe("allow-whole-filter");
      expect(deferred?.pageDimensionRequest?.selection).toEqual(selection);
    }

    const excluded = [
      queryFor("session", {
        audience: "api-v1",
        dimension: "page.path",
        filterDsl: mixedOr,
      }),
      {
        ...eligible,
        comparison: { metric: "views" },
      } as DimensionTestQuery,
      { ...eligible, current: { time: TIME } } as DimensionTestQuery,
      { ...eligible, reference: { time: TIME } } as DimensionTestQuery,
    ];
    for (const query of excluded) {
      const forwarded = await forward(query);
      expect(
        deferredPageDimensionQualificationFromQuery(forwarded),
      ).toBeUndefined();
    }

    const withCurrentGetter = (
      query: DimensionTestQuery,
      count: { value: number },
    ) =>
      Object.defineProperty({ ...query }, "current", {
        enumerable: true,
        get() {
          count.value += 1;
          return undefined;
        },
      }) as DimensionTestQuery;
    const privateGetterCalls = { value: 0 };
    const getterQuery = withCurrentGetter(eligible, privateGetterCalls);
    await expectUnsafeWithoutReads(getterQuery, privateGetterCalls);
    const publicGetterCalls = { value: 0 };
    const publicGetterQuery = withCurrentGetter(
      queryFor("session", {
        audience: "api-v1",
        dimension: "page.path",
        filterDsl: mixedOr,
      }),
      publicGetterCalls,
    );
    await expectUnsafeWithoutReads(publicGetterQuery, publicGetterCalls);

    const withComparisonGetter = (
      query: DimensionTestQuery,
      count: { value: number },
    ) =>
      Object.defineProperty({ ...query }, "comparison", {
        enumerable: true,
        get() {
          count.value += 1;
          return undefined;
        },
      }) as DimensionTestQuery;
    const privateComparisonGetterCalls = { value: 0 };
    const comparisonGetterQuery = withComparisonGetter(
      eligible,
      privateComparisonGetterCalls,
    );
    await expectUnsafeWithoutReads(
      comparisonGetterQuery,
      privateComparisonGetterCalls,
    );
    const nonPrivateComparisonGetterCalls = { value: 0 };
    const nonPrivateComparisonGetterQuery = withComparisonGetter(
      queryFor("session", {
        audience: "api-v1",
        dimension: "page.path",
        filterDsl: mixedOr,
      }),
      nonPrivateComparisonGetterCalls,
    );
    await expectUnsafeWithoutReads(
      nonPrivateComparisonGetterQuery,
      nonPrivateComparisonGetterCalls,
    );

    const conjunction = queryFor("session", {
      dimension: "page.path",
      filterDsl:
        'page.path eq "/Native" and count(event { event.name eq "qualifier" }) eq 1',
    });
    const conjunctionForwarded = await forward(conjunction);
    const conjunctionDeferred =
      deferredPageDimensionQualificationFromQuery(conjunctionForwarded);
    expect(conjunctionDeferred).toBeDefined();
    expect(
      resolveQualifiedSourceFilters(conjunction.filters!, "allow-whole-filter"),
    ).toMatchObject({ kind: "supported", mode: "split" });

    const channelConjunction = queryFor("session", {
      dimension: "traffic.channel",
      filterDsl: 'page.path eq "/landing"',
    });
    const channelForwarded = await forward(channelConjunction);
    const channelDeferred =
      deferredPageDimensionQualificationFromQuery(channelForwarded);
    expect(channelDeferred?.pageDimensionFilterMode).toBeUndefined();

    const legacy = await legacyPageFor(database, eligible, traceFor());
    if (!legacy.deferred)
      throw new Error("wave97df_page_dimension_compile_deferred_missing");
    const runtimeTrace = traceFor();
    const provider = createD1SiteProviderRegistry({
      env: testEnv(database, runtimeTrace),
      siteId: SITE,
    }).resolve("dimension");
    if (!provider)
      throw new Error("wave97df_page_dimension_gate_provider_missing");
    const actual = await provider.execute(eligible);
    expect(actual.value).toEqual(legacy.dto);
    expect(runtimeTrace.preparedSql).toHaveLength(2);
    const validQuery = pageQualificationQuery(eligible, legacy.deferred);
    const wrongSelection = dimensionPageSelection("page.title");
    if (!wrongSelection)
      throw new Error("wave97df_page_dimension_wrong_selection_missing");
    expect(() =>
      compilePageDimensionQualificationProgram({
        deferred: legacy.deferred!,
        query: { ...validQuery, selection: wrongSelection },
      }),
    ).toThrow();

    const canonicalSelection = dimensionPageSelection("page.path");
    if (!canonicalSelection)
      throw new Error("wave97df_page_dimension_selection_missing");
    expect(() =>
      buildPageDimensionQualificationPlan({
        siteId: SITE,
        queryTime: eligible.time,
        filters: eligible.filters!,
        scopePlan: legacy.deferred!.metadata.plan,
        count: legacy.deferred!.countInput,
        options: {
          selection: canonicalSelection,
          limit: 10,
          cursor: null,
          sortBy: "views",
          sortDirection: "desc",
          excludeEmpty: false,
        },
      }),
    ).toThrow();
    recordSupplementalEvidence("private-page-field-whole-boolean-gates", {
      allowed: ["private-dashboard", "breakdown", ...canonicalDimensions],
      rejected: [
        "api-v1",
        "comparison",
        "current",
        "reference",
        "current-accessor",
        "comparison-accessor",
        "selection-swap",
      ],
      privateGetterReads: privateGetterCalls.value,
      nonPrivateGetterReads: publicGetterCalls.value,
      privateComparisonGetterReads: privateComparisonGetterCalls.value,
      nonPrivateComparisonGetterReads: nonPrivateComparisonGetterCalls.value,
      accessorSqlReads: gateTrace.preparedSql.length,
      conjunctionStillDeferred: true,
      conjunctionResolvedAs: "split",
      canonicalDimensionMappings: canonicalDimensions.map((dimension) => ({
        dimension,
        selection: dimensionPageSelection(dimension),
        wholeFilterAllowed: true,
      })),
      trafficChannelRemainsSplitOnly:
        channelDeferred?.pageDimensionFilterMode === undefined,
      defaultBuilderRejectedMixedBoolean: true,
      legacyDto: legacy.dto,
      actualDto: actual.value,
      runtimeStatements: runtimeTrace.preparedSql.map((sql, index) => ({
        sql,
        bindings: runtimeTrace.bindings[index] ?? [],
      })),
    });
  });
});

describe("Canonical Page dimensions whole Boolean qualification", () => {
  const runCase = async (
    database: DatabaseSync,
    input: {
      readonly dimension: string;
      readonly filterKind: CanonicalFilterKind;
      readonly scope: "session" | "visitor";
    },
  ) => {
    const query = queryFor(input.scope, {
      dimension: input.dimension,
      limit: 20,
      filterDsl: CANONICAL_FILTER_DSLS[input.filterKind],
    });
    const legacyTrace = traceFor();
    const legacy = await legacyPageFor(database, query, legacyTrace);
    if (!legacy.deferred)
      throw new Error("wave97dg_page_dimension_deferred_missing");
    expect(legacy.deferred.pageDimensionFilterMode).toBe("allow-whole-filter");
    const selection = dimensionPageSelection(input.dimension);
    if (!selection)
      throw new Error("wave97dg_page_dimension_selection_missing");
    expect(legacy.deferred.pageDimensionRequest?.selection).toEqual(selection);

    const runtimeTrace = traceFor();
    const diagnostics = createD1ReadDiagnostics();
    const provider = createD1SiteProviderRegistry({
      env: testEnv(database, runtimeTrace),
      siteId: SITE,
      diagnostics,
    }).resolve("dimension");
    if (!provider) throw new Error("wave97dg_page_dimension_provider_missing");
    const actual = await provider.execute(query);
    if (!("items" in actual.value))
      throw new Error("wave97dg_page_dimension_result_shape_invalid");
    const actualDto = actual.value as DimensionPageDto;
    expect(actualDto).toEqual(legacy.dto);
    const actualItems = actualDto.items
      .map((row) => ({
        key: row.key,
        views: row.views,
        sessions: row.sessions,
        visitors: row.visitors,
      }))
      .sort((left, right) =>
        left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
      );
    const independentExpectedItems = independentCanonicalPageItems({
      dimension: input.dimension,
      filterKind: input.filterKind,
      scope: input.scope,
    });
    expect(actualItems).toEqual(independentExpectedItems);

    const compiled = compilePageDimensionQualificationProgram({
      deferred: legacy.deferred,
      query: pageQualificationQuery(query, legacy.deferred),
    });
    expect(compiled.kind).toBe("compiled");
    if (compiled.kind !== "compiled")
      throw new Error("wave97dg_page_dimension_compile_unavailable");
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

    recordSupplementalEvidence("canonical-page-dimensions-breakdown", {
      dimension: input.dimension,
      mode: "breakdown",
      scope: input.scope,
      filterKind: input.filterKind,
      filterDsl: CANONICAL_FILTER_DSLS[input.filterKind],
      selection,
      excludeEmpty: false,
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
    return actualDto;
  };

  it("qualifies representative breakdown/session dimensions with independent values", async () => {
    const { database } = createFixture();
    installPrivatePageFieldRows(database);
    for (const input of [
      { dimension: "page.query", filterKind: "mixed-or" },
      { dimension: "country", filterKind: "mixed-or" },
      { dimension: "utm.source", filterKind: "count-only" },
      { dimension: "client.browserEngine", filterKind: "mixed-or" },
    ] as const)
      await runCase(database, { ...input, scope: "session" });
  });

  it("qualifies representative breakdown/visitor dimensions with owner expansion", async () => {
    const { database } = createFixture();
    installPrivatePageFieldRows(database);
    for (const input of [
      { dimension: "geo.country", filterKind: "mixed-or" },
      { dimension: "client.screenSize", filterKind: "mixed-or" },
      { dimension: "page.hash", filterKind: "mixed-not" },
    ] as const)
      await runCase(database, { ...input, scope: "visitor" });
  });

  it("continues a legacy signed page.query cursor without ties or owner rows being lost", async () => {
    const { database } = createFixture();
    installPrivatePageFieldRows(database);
    const filterDsl = CANONICAL_FILTER_DSLS["mixed-or"];
    const firstQuery = queryFor("visitor", {
      dimension: "page.query",
      limit: 2,
      filterDsl,
    });
    const firstLegacyTrace = traceFor();
    const firstLegacy = await legacyPageFor(
      database,
      firstQuery,
      firstLegacyTrace,
    );
    if (!firstLegacy.deferred)
      throw new Error("wave97dg_query_cursor_first_legacy_missing");
    expect(firstLegacy.dto.items).toHaveLength(2);
    expect(firstLegacy.dto.pagination.hasMore).toBe(true);
    expect(firstLegacy.dto.pagination.nextCursor).toBeTruthy();

    const firstTrace = traceFor();
    const provider = createD1SiteProviderRegistry({
      env: testEnv(database, firstTrace),
      siteId: SITE,
    }).resolve("dimension");
    if (!provider) throw new Error("wave97dg_query_cursor_provider_missing");
    const firstActual = await provider.execute(firstQuery);
    expect(firstActual.value).toEqual(firstLegacy.dto);
    expect(firstTrace.preparedSql).toHaveLength(2);
    expect(firstTrace.preparedSql[1]).toContain('"query_string"');

    const cursor = firstLegacy.dto.pagination.nextCursor;
    if (!cursor) throw new Error("wave97dg_query_cursor_missing");
    const secondQuery = queryFor("visitor", {
      dimension: "page.query",
      limit: 2,
      cursor,
      filterDsl,
    });
    const secondLegacyTrace = traceFor();
    const secondLegacy = await legacyPageFor(
      database,
      secondQuery,
      secondLegacyTrace,
    );
    expect(secondLegacy.dto.items).toHaveLength(1);
    expect(secondLegacy.dto.pagination.hasMore).toBe(false);
    const secondTrace = traceFor();
    const secondProvider = createD1SiteProviderRegistry({
      env: testEnv(database, secondTrace),
      siteId: SITE,
    }).resolve("dimension");
    if (!secondProvider)
      throw new Error("wave97dg_query_cursor_second_provider_missing");
    const secondActual = await secondProvider.execute(secondQuery);
    expect(secondActual.value).toEqual(secondLegacy.dto);
    expect(secondTrace.preparedSql).toHaveLength(2);
    const firstDto = firstActual.value as DimensionPageDto;
    const secondDto = secondActual.value as DimensionPageDto;
    const actualKeys = [
      ...firstDto.items.map((row) => row.key),
      ...secondDto.items.map((row) => row.key),
    ];
    const expectedKeys = independentCanonicalPageItems({
      dimension: "page.query",
      filterKind: "mixed-or",
      scope: "visitor",
    }).map((row) => row.key);
    expect(new Set(actualKeys).size).toBe(actualKeys.length);
    expect([...actualKeys].sort()).toEqual(expectedKeys);
    expect(firstLegacy.dto.items.map((row) => row.views)).toEqual([1, 1]);

    const bindingProvider = createD1SiteProviderRegistry({
      env: testEnv(database, traceFor()),
      siteId: SITE,
    }).resolve("dimension");
    if (!bindingProvider)
      throw new Error("wave97dg_query_cursor_binding_provider_missing");
    await expect(
      bindingProvider.execute(
        queryFor("visitor", {
          dimension: "page.hash",
          limit: 2,
          cursor,
          filterDsl,
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidCursorError);
    await expect(
      bindingProvider.execute(
        queryFor("session", {
          dimension: "page.query",
          limit: 2,
          cursor,
          filterDsl,
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidCursorError);
    recordSupplementalEvidence("canonical-page-dimensions-breakdown-cursor", {
      dimension: "page.query",
      scope: "visitor",
      oldFirstDto: firstLegacy.dto,
      actualFirstDto: firstActual.value,
      oldSecondDto: secondLegacy.dto,
      actualSecondDto: secondActual.value,
      expectedKeys,
      actualKeys,
      exactOrderAndNoDuplicates: true,
      legacyStatements: [
        ...firstLegacyTrace.preparedSql.map((sql, index) => ({
          sql,
          bindings: firstLegacyTrace.bindings[index] ?? [],
        })),
        ...secondLegacyTrace.preparedSql.map((sql, index) => ({
          sql,
          bindings: secondLegacyTrace.bindings[index] ?? [],
        })),
      ],
      tiedMetricTupleCount: new Set(
        firstLegacy.dto.items.map(
          (row) => `${row.views}:${row.sessions}:${row.visitors}`,
        ),
      ).size,
      invalidatedBindings: ["dimension", "scope"],
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
});
