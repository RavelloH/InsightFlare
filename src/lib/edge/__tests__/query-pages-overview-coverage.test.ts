import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { buildTrafficChannelSqlExpression } from "@/lib/analytics/traffic-channel-rules";
import {
  attachScopedFilterMetadata,
  createQueryTime,
  effectiveScopeForPagination,
  EMPTY_FILTER_DOCUMENT,
  type FilterDocument,
  filterFingerprint,
  prepareScopedQuery,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import {
  analyticsPageDimensionSelection,
  PAGE_DIMENSION_SELECTIONS,
} from "@/lib/edge/analytics/engine/dimension-report-plan";
import { handleFilterValuesContract } from "@/lib/edge/analytics/interfaces/dashboard/protocol/filter-values";
import {
  handleOverviewContract as handleOverview,
  handleTrendContract as handleTrend,
} from "@/lib/edge/analytics/interfaces/dashboard/protocol/overview";
import { handleOverviewGeoPointsContract as handleOverviewGeoPoints } from "@/lib/edge/analytics/interfaces/dashboard/protocol/overview-extras";
import { handleOverviewTabContract } from "@/lib/edge/analytics/interfaces/dashboard/protocol/overview-tabs";
import {
  handlePagesContract as handlePages,
  handlePagesDashboardContract as handlePagesDashboard,
  handleReferrersContract as handleReferrers,
} from "@/lib/edge/analytics/interfaces/dashboard/protocol/pages";
import { queryChannelsFromD1 } from "@/lib/edge/analytics/providers/d1/internal/channels";
import {
  geoTabLabel,
  mapDimensionRows,
  type QueryWindow,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  buildVisitFilterSql,
  buildVisitSourceCte,
  queryD1All,
  scopedDatasetFor,
  scopedDatasetForUnpreparedReader,
  visitSourceBindings,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  cityValueExpr,
  clientDimensionDefinition,
  regionValueExpr,
  resolveCrossBreakdownDimension,
  utmDimensionDefinition,
} from "@/lib/edge/analytics/providers/d1/internal/core-dimensions";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import {
  decodeDimensionCursor,
  decodeSessionPathDimensionCursor,
  queryDimensionFromD1,
  queryDimensionPageFromD1,
  queryOverviewClientDimensionsFromD1,
  queryOverviewGeoDimensionsFromD1,
  querySessionPathDimensionFromD1,
  querySessionPathDimensionPageFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/dimensions";
import { queryRetentionFromD1 } from "@/lib/edge/analytics/providers/d1/internal/journey-retention";
import {
  queryLatestSiteActivity,
  queryOverviewFromD1,
  queryTrendFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/overview";
import {
  decodePagesCursor,
  queryDimensionAggregate,
  queryPageCardMetricsFromD1,
  queryPageCardTitlesFromD1,
  queryPageCardTrendFromD1,
  queryPagesAggregate,
  queryPagesFromD1,
  queryPagesPageFromD1,
  queryPagesWithTabsFromD1,
  queryPageTabsAggregate,
  queryTopPagesFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/pages";
import { queryPagesDashboard } from "@/lib/edge/analytics/providers/d1/internal/pages-dashboard";
import {
  encodePageCursor,
  paginationBindingForWindow,
} from "@/lib/edge/analytics/providers/d1/internal/pagination";
import {
  decodeReferrersCursor,
  queryReferrerAggregate,
  queryReferrersPageFromD1,
  queryReferrerSummaryFromD1,
  queryTopReferrersFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/referrers";
import type { Env } from "@/lib/edge/types";
import { parseFilterDsl } from "@/lib/filter-contract/filter-dsl";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";
import { normalizeFilterDocument } from "@/lib/filter-contract/filters";

import { filterFixture } from "./filter-fixtures";
import { installVisitSiteIdentityFixture } from "./site-identity-fixture";
type D1Row = Record<string, unknown>;
type QueryBinding = string | number | null;
interface QueryCall {
  sql: string;
  bindings: QueryBinding[];
}
const siteId = "site-pages";
const baseMs = Date.UTC(2026, 0, 2, 1);
const window: QueryWindow = {
  startMs: baseMs,
  endExclusiveMs: baseMs + 2 * 60 * 60 * 1000,
  nowMs: baseMs + 3 * 60 * 60 * 1000,
  timeZone: "UTC",
};
function createD1Env(
  resultSets: D1Row[][],
  rowsRead?: number,
): {
  env: Env;
  calls: QueryCall[];
  prepare: ReturnType<typeof vi.fn>;
} {
  const calls: QueryCall[] = [];
  const pendingResults = [...resultSets];
  const prepare = vi.fn((sql: string) => ({
    bind: vi.fn((...bindings: QueryBinding[]) => ({
      all: vi.fn(async () => {
        calls.push({ sql, bindings });
        return {
          results: pendingResults.shift() ?? [],
          ...(rowsRead === undefined ? {} : { meta: { rows_read: rowsRead } }),
        };
      }),
    })),
  }));

  return {
    env: {
      DB: { prepare } as unknown as D1Database,
      DAILY_SALT_SECRET: "test-secret",
      INGEST_DO: {} as DurableObjectNamespace,
    },
    calls,
    prepare,
  };
}
function installDirectEventFilterTables(database: DatabaseSync): void {
  const columns = database
    .prepare("PRAGMA table_info(custom_events)")
    .all() as Array<{ name?: string }>;
  if (columns.some((column) => column.name === "event_pk")) return;
  database.exec(`
    DROP TABLE IF EXISTS custom_events;
    DROP TABLE IF EXISTS custom_event_names;
    CREATE TABLE custom_event_names (
      id INTEGER PRIMARY KEY,
      site_id TEXT NOT NULL,
      name TEXT NOT NULL
    );
    CREATE TABLE custom_events (
      event_pk INTEGER PRIMARY KEY,
      event_id TEXT NOT NULL,
      site_id TEXT NOT NULL,
      site_pk INTEGER NOT NULL DEFAULT 1,
      visit_id TEXT NOT NULL,
      event_name_id INTEGER NOT NULL,
      occurred_at INTEGER NOT NULL
    );
  `);
}
function createScopedOverviewSqliteEnv(): {
  env: Env;
  database: DatabaseSync;
  close: () => void;
} {
  const database = new DatabaseSync(":memory:");
  for (const migration of [
    "migrations/0008_rebuild_analytics.sql",
    "migrations/0013_add_visit_performance_metrics.sql",
    "migrations/0017_structured_custom_events.sql",
    "migrations/0019_add_user_identity.sql",
  ]) {
    database.exec(readFileSync(migration, "utf8"));
  }
  installVisitSiteIdentityFixture(database);
  database.exec(`
    ALTER TABLE custom_event_names ADD COLUMN site_pk INTEGER;
    ALTER TABLE custom_events ADD COLUMN site_pk INTEGER;

    CREATE TRIGGER test_custom_event_names_site_pk
    AFTER INSERT ON custom_event_names
    WHEN NEW.site_pk IS NULL
    BEGIN
      UPDATE custom_event_names
      SET site_pk = (SELECT site_pk FROM site_identities WHERE site_id = NEW.site_id)
      WHERE id = NEW.id;
    END;

    CREATE TRIGGER test_custom_events_site_pk
    AFTER INSERT ON custom_events
    WHEN NEW.site_pk IS NULL
    BEGIN
      UPDATE custom_events
      SET site_pk = (SELECT site_pk FROM site_identities WHERE site_id = NEW.site_id)
      WHERE event_pk = NEW.event_pk;
    END;
  `);
  const env = {
    DB: {
      prepare: (sql: string) => ({
        bind: (...bindings: QueryBinding[]) => ({
          all: async () => ({
            results: database.prepare(sql).all(...bindings) as D1Row[],
          }),
        }),
      }),
    },
    DAILY_SALT_SECRET: "test-secret",
    INGEST_DO: {} as DurableObjectNamespace,
  } as unknown as Env;
  return { env, database, close: () => database.close() };
}
function createMigratedPagesSqliteEnv(): {
  env: Env;
  database: DatabaseSync;
  calls: QueryCall[];
  close: () => void;
} {
  const database = createMigratedDatabase();
  const calls: QueryCall[] = [];
  const env = {
    DB: {
      prepare: (sql: string) => ({
        bind: (...bindings: QueryBinding[]) => ({
          all: async () => {
            calls.push({ sql, bindings });
            return {
              results: database.prepare(sql).all(...bindings) as D1Row[],
            };
          },
        }),
      }),
    },
    DAILY_SALT_SECRET: "test-secret",
    INGEST_DO: {} as DurableObjectNamespace,
  } as unknown as Env;
  return { env, database, calls, close: () => database.close() };
}
interface LegacyPageAggregateRow {
  pathname: unknown;
  queryValue: unknown;
  hashValue: unknown;
  views: unknown;
  sessions: unknown;
}
function legacyPageAggregateRow(row: LegacyPageAggregateRow) {
  return {
    pathname: String(row.pathname ?? ""),
    query: String(row.queryValue ?? ""),
    hash: String(row.hashValue ?? ""),
    views: Number(row.views ?? 0),
    sessions: Number(row.sessions ?? 0),
  };
}
/** Frozen pre-Logical reader SQL used as a differential oracle for Wave43. */
async function legacyTopPagesOracle(
  env: Env,
  targetSiteId: string,
  targetWindow: QueryWindow,
  limit: number,
  includeDetails: boolean,
  filters: FilterDocument,
) {
  const dataset = scopedDatasetFor(targetSiteId, targetWindow, filters);
  const filter = dataset
    ? null
    : buildVisitFilterSql(filters, "visit_source", {
        window: targetWindow,
      });
  const queryExpr = includeDetails ? "query_string" : "''";
  const hashExpr = includeDetails ? "hash_fragment" : "''";
  const sql = `
WITH
${dataset?.ctes ?? buildVisitSourceCte()},
filtered_visits AS (
  SELECT *
  FROM ${dataset?.visitRelation ?? "visit_source"}
  ${filter?.clause ?? ""}
)
SELECT
  pathname,
  ${queryExpr} AS queryValue,
  ${hashExpr} AS hashValue,
  count(*) AS views,
  count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS sessions
FROM filtered_visits
GROUP BY pathname, queryValue, hashValue
ORDER BY views DESC, pathname ASC
LIMIT ?
`;
  const rows = await queryD1All<LegacyPageAggregateRow>(env, sql, [
    ...(dataset
      ? dataset.bindings.map((binding) => binding.value)
      : [
          ...visitSourceBindings(targetSiteId, targetWindow),
          ...(filter?.bindings ?? []),
        ]),
    limit,
  ]);
  return rows.map(legacyPageAggregateRow);
}
/** Frozen pre-Logical paginated reader SQL, including all 15 cursor bindings. */
async function legacyPagesPageRowsOracle(
  env: Env,
  targetSiteId: string,
  targetWindow: QueryWindow,
  filters: FilterDocument,
  limit: number,
  includeDetails: boolean,
  cursor?: {
    views: number;
    sessions: number;
    pathname: string;
    query: string;
    hash: string;
  } | null,
) {
  const dataset = scopedDatasetFor(targetSiteId, targetWindow, filters);
  const filter = dataset
    ? null
    : buildVisitFilterSql(filters, "visit_source", {
        window: targetWindow,
      });
  const queryExpr = includeDetails ? "query_string" : "''";
  const hashExpr = includeDetails ? "hash_fragment" : "''";
  const cursorClause = cursor
    ? `
WHERE views < ?
   OR (views = ? AND sessions < ?)
   OR (views = ? AND sessions = ? AND pathname > ?)
   OR (views = ? AND sessions = ? AND pathname = ? AND queryValue > ?)
   OR (views = ? AND sessions = ? AND pathname = ? AND queryValue = ? AND hashValue > ?)`
    : "";
  const sql = `
WITH
${dataset?.ctes ?? buildVisitSourceCte()},
filtered_visits AS (
  SELECT *
  FROM ${dataset?.visitRelation ?? "visit_source"}
  ${filter?.clause ?? ""}
),
rollup AS (
  SELECT
    pathname,
    ${queryExpr} AS queryValue,
    ${hashExpr} AS hashValue,
    count(*) AS views,
    count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS sessions
  FROM filtered_visits
  GROUP BY pathname, queryValue, hashValue
)
SELECT pathname, queryValue, hashValue, views, sessions
FROM rollup
${cursorClause}
ORDER BY views DESC, sessions DESC, pathname ASC, queryValue ASC, hashValue ASC
LIMIT ?
`;
  const cursorBindings = cursor
    ? [
        cursor.views,
        cursor.views,
        cursor.sessions,
        cursor.views,
        cursor.sessions,
        cursor.pathname,
        cursor.views,
        cursor.sessions,
        cursor.pathname,
        cursor.query,
        cursor.views,
        cursor.sessions,
        cursor.pathname,
        cursor.query,
        cursor.hash,
      ]
    : [];
  const rows = await queryD1All<LegacyPageAggregateRow>(env, sql, [
    ...(dataset
      ? dataset.bindings.map((binding) => binding.value)
      : [
          ...visitSourceBindings(targetSiteId, targetWindow),
          ...(filter?.bindings ?? []),
        ]),
    ...cursorBindings,
    limit + 1,
  ]);
  return rows.map(legacyPageAggregateRow);
}
function normalizedFilters(root: unknown): FilterDocument {
  return normalizeFilterDocument({ version: 1, root }, analyticsFilterRegistry);
}
function filterCondition(
  target:
    | { readonly kind: "field"; readonly field: string }
    | {
        readonly kind: "event-payload";
        readonly path: string;
      },
  value: string,
) {
  return {
    kind: "condition",
    target,
    operator: "eq",
    value,
  } as const;
}
function insertPageRow(
  database: DatabaseSync,
  input: {
    visitId: string | null;
    visitorId: string;
    sessionId: string;
    pathname: string;
    country: string;
    siteId?: string;
    startedAt?: number;
    browser?: string;
    query?: string;
    hash?: string;
  },
): void {
  const targetSiteId = input.siteId ?? siteId;
  database
    .prepare("INSERT OR IGNORE INTO site_identities (site_id) VALUES (?)")
    .run(targetSiteId);
  const siteIdentity = database
    .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
    .get(targetSiteId) as { site_pk: number };
  database
    .prepare(
      `
      INSERT INTO visits (
        visit_id, site_id, visitor_id, session_id, status, started_at,
        last_activity_at, pathname, hostname, title, query_string,
        hash_fragment, country, browser, site_pk
      ) VALUES (?, ?, ?, ?, 'closed', ?, ?, ?, 'example.test', '', ?, ?, ?, ?, ?)
    `,
    )
    .run(
      input.visitId,
      targetSiteId,
      input.visitorId,
      input.sessionId,
      input.startedAt ?? baseMs,
      input.startedAt ?? baseMs,
      input.pathname,
      input.query ?? "",
      input.hash ?? "",
      input.country,
      input.browser ?? "",
      siteIdentity.site_pk,
    );
}
function visitBindings(targetWindow = window): QueryBinding[] {
  return [siteId, targetWindow.startMs, targetWindow.endExclusiveMs];
}
type PageDimensionSelection =
  (typeof PAGE_DIMENSION_SELECTIONS)[keyof typeof PAGE_DIMENSION_SELECTIONS];
type DimensionSortKey = "views" | "sessions" | "visitors";
function legacyDimensionExpression(selection: PageDimensionSelection): string {
  const cross = (dimension: string) => {
    const definition = resolveCrossBreakdownDimension(dimension);
    if (!definition) throw new Error(`missing-frozen-dimension:${dimension}`);
    return definition.labelExpr;
  };
  switch (selection.id) {
    case "pagePath":
      return "pathname";
    case "pagePathTrimmed":
      return cross("page.path");
    case "pageTitle":
      return "title";
    case "pageTitleTrimmed":
      return cross("page.title");
    case "pageHostname":
      return "hostname";
    case "pageHostnameTrimmed":
      return cross("page.hostname");
    case "pageQuery":
      return "query_string";
    case "pageQueryTrimmed":
      return cross("page.query");
    case "pageHash":
      return "hash_fragment";
    case "pageHashTrimmed":
      return cross("page.hash");
    case "referrerUrl":
      return cross("referrer.url");
    case "utmSource":
      return utmDimensionDefinition("source").labelExpr;
    case "utmMedium":
      return utmDimensionDefinition("medium").labelExpr;
    case "utmCampaign":
      return utmDimensionDefinition("campaign").labelExpr;
    case "utmTerm":
      return utmDimensionDefinition("term").labelExpr;
    case "utmContent":
      return utmDimensionDefinition("content").labelExpr;
    case "country":
      return "country";
    case "countryTrimmed":
      return cross("geo.country");
    case "region":
      return regionValueExpr();
    case "city":
      return cityValueExpr();
    case "continent":
      return "continent";
    case "continentTrimmed":
      return cross("geo.continent");
    case "timezone":
      return "timezone";
    case "timezoneTrimmed":
      return cross("geo.timeZone");
    case "organization":
      return "as_organization";
    case "organizationTrimmed":
      return cross("geo.organization");
    case "browser":
      return clientDimensionDefinition("browser").labelExpr;
    case "browserVersion":
      return cross("client.browserVersion");
    case "browserEngine":
      return cross("client.browserEngine");
    case "operatingSystem":
      return clientDimensionDefinition("operatingSystem").labelExpr;
    case "osVersion":
      return clientDimensionDefinition("osVersion").labelExpr;
    case "deviceType":
      return clientDimensionDefinition("deviceType").labelExpr;
    case "language":
      return clientDimensionDefinition("language").labelExpr;
    case "screenSize":
      return clientDimensionDefinition("screenSize").labelExpr;
    case "userId":
      return cross("user.id");
    case "userName":
      return cross("user.name");
    case "referrerDomain":
      return cross("referrer.domain");
    case "trafficChannel":
      return buildTrafficChannelSqlExpression();
  }
}
interface LegacyDimensionOracleOptions {
  excludeEmpty?: boolean;
  search?: string;
  sortBy?: DimensionSortKey;
  sortDirection?: "asc" | "desc";
  cursor?: { primary: number; secondary: number; value: string } | null;
  limit?: number;
  paginated?: boolean;
}
function legacyDimensionRowsOracle(
  database: DatabaseSync,
  targetSiteId: string,
  targetWindow: QueryWindow,
  selection: PageDimensionSelection,
  options: LegacyDimensionOracleOptions = {},
) {
  const expression = legacyDimensionExpression(selection);
  const sortBy = options.sortBy ?? "views";
  const secondaryBy = sortBy === "views" ? "sessions" : "views";
  const direction = options.sortDirection === "asc" ? "ASC" : "DESC";
  const directional = direction === "ASC" ? ">" : "<";
  const predicates: string[] = [];
  const bindings: QueryBinding[] = visitSourceBindings(
    targetSiteId,
    targetWindow,
  );
  if (options.excludeEmpty) predicates.push("TRIM(value) != ''");
  const normalizedSearch = options.search?.trim().toLowerCase() ?? "";
  if (normalizedSearch) {
    predicates.push("LOWER(value) LIKE ? ESCAPE '\\'");
    bindings.push(`%${normalizedSearch.replace(/[\\%_]/g, "\\$&")}%`);
  }
  if (options.cursor) {
    predicates.push(
      `("${sortBy}" ${directional} ? OR ("${sortBy}" = ? AND "${secondaryBy}" ${directional} ?) OR ("${sortBy}" = ? AND "${secondaryBy}" = ? AND value > ?))`,
    );
    bindings.push(
      options.cursor.primary,
      options.cursor.primary,
      options.cursor.secondary,
      options.cursor.primary,
      options.cursor.secondary,
      options.cursor.value,
    );
  }
  const where = predicates.length ? `WHERE ${predicates.join(" AND ")}` : "";
  const limit = options.limit;
  const limitClause =
    limit === undefined || (limit <= 0 && !options.paginated) ? "" : "LIMIT ?";
  if (limitClause) bindings.push(options.paginated ? limit! + 1 : limit!);
  const sql = `
WITH
${buildVisitSourceCte()},
rollup AS (
  SELECT
    COALESCE(${expression}, '') AS value,
    count(*) AS views,
    count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS sessions,
    count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS visitors
  FROM visit_source
  GROUP BY COALESCE(${expression}, '')
)
SELECT value, views, sessions, visitors
FROM rollup
${where}
ORDER BY "${sortBy}" ${direction}, "${secondaryBy}" ${direction}, value ASC
${limitClause}
`;
  return (database.prepare(sql).all(...bindings) as D1Row[]).map((row) => ({
    value: String(row.value ?? ""),
    views: Number(row.views ?? 0),
    sessions: Number(row.sessions ?? 0),
    visitors: Number(row.visitors ?? 0),
  }));
}

interface LegacySessionPathCursor {
  views: number;
  value: string;
  visitors?: number;
}

interface LegacySessionPathOracleOptions {
  kind: "entry" | "exit";
  search?: string;
  sortBy?: DimensionSortKey;
  sortDirection?: "asc" | "desc";
  cursor?: LegacySessionPathCursor | null;
  limit?: number;
  paginated?: boolean;
}

/** Frozen pre-Logical Session Path SQL, including the legacy scoped source. */
function legacySessionPathRowsOracle(
  database: DatabaseSync,
  targetSiteId: string,
  targetWindow: QueryWindow,
  filters: FilterDocument,
  options: LegacySessionPathOracleOptions,
) {
  const scoped =
    scopedDatasetFor(targetSiteId, targetWindow, filters) ??
    scopedDatasetForUnpreparedReader(
      "dimension",
      targetSiteId,
      targetWindow,
      filters,
      "session",
    );
  const filter = scoped
    ? null
    : buildVisitFilterSql(filters, "visit_source", { window: targetWindow });
  const sortBy = options.sortBy ?? "views";
  const direction = options.sortDirection === "asc" ? "ASC" : "DESC";
  const operator = direction === "ASC" ? ">" : "<";
  const boundary = options.kind === "entry" ? "first_rank" : "latest_rank";
  const predicates: string[] = [];
  const bindings: QueryBinding[] = scoped
    ? scoped.bindings.map((binding) => binding.value)
    : [
        ...visitSourceBindings(targetSiteId, targetWindow),
        ...(filter?.bindings ?? []),
      ];
  if (options.search) {
    predicates.push("LOWER(value) LIKE ? ESCAPE '\\'");
    bindings.push(
      `%${options.search
        .trim()
        .toLowerCase()
        .replace(/[\\%_]/g, "\\$&")}%`,
    );
  }
  if (options.cursor) {
    if (sortBy === "visitors") {
      predicates.push(
        `(visitors ${operator} ? OR (visitors = ? AND views ${operator} ?) OR (visitors = ? AND views = ? AND value > ?))`,
      );
      bindings.push(
        options.cursor.visitors ?? options.cursor.views,
        options.cursor.visitors ?? options.cursor.views,
        options.cursor.views,
        options.cursor.visitors ?? options.cursor.views,
        options.cursor.views,
        options.cursor.value,
      );
    } else {
      predicates.push(
        `(${sortBy} ${operator} ? OR (${sortBy} = ? AND value > ?))`,
      );
      bindings.push(
        options.cursor.views,
        options.cursor.views,
        options.cursor.value,
      );
    }
  }
  const where = predicates.length ? `WHERE ${predicates.join(" AND ")}` : "";
  const limit = options.limit;
  const limitClause =
    limit === undefined || (limit <= 0 && !options.paginated) ? "" : "LIMIT ?";
  if (limitClause) bindings.push(options.paginated ? limit! + 1 : limit!);
  const sql = `
WITH
${scoped?.ctes ?? buildVisitSourceCte()},
filtered_visits AS MATERIALIZED (
  SELECT visitor_id, session_id, started_at, visit_id,
    TRIM(COALESCE(pathname, '')) AS pathname
  FROM ${scoped?.visitRelation ?? "visit_source"}
  ${filter?.clause ?? ""}
),
ranked_session_visits AS (
  SELECT
    vs.session_id,
    vs.visitor_id,
    TRIM(COALESCE(vs.pathname, '')) AS pathname,
    ROW_NUMBER() OVER (
      PARTITION BY vs.session_id
      ORDER BY vs.started_at ASC, vs.visit_id ASC
    ) AS first_rank,
    ROW_NUMBER() OVER (
      PARTITION BY vs.session_id
      ORDER BY vs.started_at DESC, vs.visit_id DESC
    ) AS latest_rank
  FROM filtered_visits vs
  WHERE vs.session_id != '' AND TRIM(COALESCE(vs.pathname, '')) != ''
),
session_edges AS (
  SELECT
    session_id,
    MAX(CASE WHEN first_rank = 1 THEN visitor_id END) AS visitor_id,
    MAX(CASE WHEN ${boundary} = 1 THEN pathname END) AS value
  FROM ranked_session_visits
  GROUP BY session_id
),
session_path_rollup AS (
  SELECT
    value,
    count(*) AS views,
    count(*) AS sessions,
    count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS visitors
  FROM session_edges
  WHERE TRIM(value) != ''
  GROUP BY value
)
SELECT value, views, sessions, visitors
FROM session_path_rollup
${where}
ORDER BY ${sortBy} ${direction}${sortBy === "visitors" ? `, views ${direction}` : ""}, value ASC
${limitClause}
`;
  return (database.prepare(sql).all(...bindings) as D1Row[]).map((row) => ({
    value: String(row.value ?? ""),
    views: Number(row.views ?? 0),
    sessions: Number(row.sessions ?? 0),
    visitors: Number(row.visitors ?? 0),
  }));
}

function seedDimensionReportFixture(database: DatabaseSync): void {
  const records = [
    {
      visitId: "dimension-1",
      visitorId: "visitor-a",
      sessionId: "session-a",
      pathname: " /alpha ",
      country: " US ",
      title: "  Alpha  ",
      hostname: " example.test ",
      query_string: " q=one ",
      hash_fragment: " h1 ",
      referrer_url: " https://google.com/a ",
      referrer_host: "google.com",
      utm_source: " news ",
      utm_medium: " cpc ",
      utm_campaign: " spring ",
      utm_term: " term ",
      utm_content: " content ",
      region: " California ",
      region_code: "CA",
      city: "San::Jose",
      continent: " NA ",
      timezone: " UTC ",
      as_organization: " Org A ",
      browser: " Chrome ",
      browser_version: "124.0",
      os: " Android ",
      os_version: "14",
      device_type: " mobile ",
      screen_width: 1280,
      screen_height: 720,
      language: " en ",
      user_id: " user-a ",
      user_name: " Alice ",
    },
    {
      visitId: "dimension-2",
      visitorId: "visitor-b",
      sessionId: "session-a",
      pathname: "/alpha",
      country: "US",
      title: "Alpha",
      hostname: "example.test",
      query_string: "q=one",
      hash_fragment: "h1",
      referrer_url: "https://news.example/post",
      referrer_host: "news.example",
      utm_source: "",
      utm_medium: "social",
      utm_campaign: "",
      utm_term: "",
      utm_content: "",
      region: "California",
      region_code: "",
      city: "San::Jose",
      continent: "NA",
      timezone: "UTC",
      as_organization: "Org A",
      browser: "Firefox",
      browser_version: "125.2",
      os: "Linux",
      os_version: "6.1",
      device_type: "desktop",
      screen_width: 0,
      screen_height: 720,
      language: "fr",
      user_id: "user-b",
      user_name: "Bob",
    },
    {
      visitId: "dimension-3",
      visitorId: "visitor-a",
      sessionId: "session-c",
      pathname: "\tspace\u00a0",
      country: "CA",
      title: "\u00a0Title\t",
      hostname: "example.test",
      query_string: "q=two",
      hash_fragment: "h2",
      referrer_url: "",
      referrer_host: "",
      utm_source: " newsletter ",
      utm_medium: " email ",
      utm_campaign: " autumn ",
      utm_term: "",
      utm_content: "",
      region: "\t",
      region_code: "",
      city: " City ",
      continent: " EU ",
      timezone: " Europe/Paris ",
      as_organization: " Org B ",
      browser: "Safari",
      browser_version: "17",
      os: "iOS",
      os_version: "17.4",
      device_type: "tablet",
      screen_width: null,
      screen_height: 900,
      language: " zh-CN ",
      user_id: "",
      user_name: "\u00a0",
    },
    {
      visitId: "dimension-4",
      visitorId: "visitor-d",
      sessionId: "session-d",
      pathname: "/beta",
      country: "DE",
      title: "Beta",
      hostname: "example.test",
      query_string: "",
      hash_fragment: "",
      referrer_url: "",
      referrer_host: "",
      utm_source: "",
      utm_medium: "",
      utm_campaign: "tagged",
      utm_term: "",
      utm_content: "",
      region: "",
      region_code: "",
      city: "",
      continent: "EU",
      timezone: "Europe/Berlin",
      as_organization: "",
      browser: "Edge",
      browser_version: "126.0",
      os: "Windows",
      os_version: "11",
      device_type: "desktop",
      screen_width: -1,
      screen_height: 768,
      language: "de",
      user_id: "user-d",
      user_name: "Dana",
    },
    {
      visitId: "dimension-5",
      visitorId: " ",
      sessionId: " ",
      pathname: "   ",
      country: "",
      title: "",
      hostname: "",
      query_string: "",
      hash_fragment: "",
      referrer_url: "",
      referrer_host: "",
      utm_source: "",
      utm_medium: "",
      utm_campaign: "",
      utm_term: "",
      utm_content: "",
      region: "",
      region_code: "",
      city: "",
      continent: "",
      timezone: "",
      as_organization: "",
      browser: "",
      browser_version: "",
      os: "",
      os_version: "",
      device_type: "",
      screen_width: 1920,
      screen_height: 1080,
      language: "",
      user_id: " ",
      user_name: "",
    },
    {
      visitId: "dimension-6",
      visitorId: "",
      sessionId: "",
      pathname: "/special%/_\\\u0000token",
      country: "JP",
      title: "Special",
      hostname: "example.test",
      query_string: "x=100%",
      hash_fragment: "slash\\",
      referrer_url: "https://search.example/?q=%25",
      referrer_host: "search.example",
      utm_source: "x%_\\",
      utm_medium: "affiliate",
      utm_campaign: "",
      utm_term: "",
      utm_content: "",
      region: "Tokyo::East",
      region_code: "13",
      city: "Tokyo",
      continent: "AS",
      timezone: "Asia/Tokyo",
      as_organization: "Search",
      browser: "Chrome Mobile",
      browser_version: "125",
      os: "Android",
      os_version: "15",
      device_type: "mobile",
      screen_width: 360,
      screen_height: 800,
      language: "ja",
      user_id: "",
      user_name: "",
    },
  ] as const;
  const attributes = Object.keys(records[0]).filter(
    (key) =>
      !["visitId", "visitorId", "sessionId", "pathname", "country"].includes(
        key,
      ),
  );
  const update = database.prepare(
    `UPDATE visits SET ${attributes.map((key) => `${key} = ?`).join(", ")} WHERE visit_id = ?`,
  );
  for (const record of records) {
    insertPageRow(database, record);
    update.run(
      ...attributes.map((key) => record[key as keyof typeof record] ?? null),
      record.visitId,
    );
  }
}

function overviewOracleSource(
  targetSiteId: string,
  targetWindow: QueryWindow,
  filters: FilterDocument,
) {
  const scopedDataset = scopedDatasetFor(targetSiteId, targetWindow, filters);
  const filter = scopedDataset
    ? null
    : buildVisitFilterSql(filters, "visit_source", { window: targetWindow });
  return {
    ctes: scopedDataset?.ctes ?? buildVisitSourceCte(),
    visitRelation: scopedDataset?.visitRelation ?? "visit_source",
    filterClause: filter?.clause ?? "",
    bindings: (limit: number) => [
      ...(scopedDataset
        ? scopedDataset.bindings.map((binding) => binding.value)
        : [
            ...visitSourceBindings(targetSiteId, targetWindow),
            ...(filter?.bindings ?? []),
          ]),
      limit,
    ],
  };
}

function legacyOverviewChannelsOracle(
  database: DatabaseSync,
  targetSiteId: string,
  targetWindow: QueryWindow,
  limit: number,
  filters: FilterDocument = EMPTY_FILTER_DOCUMENT,
) {
  const source = overviewOracleSource(targetSiteId, targetWindow, filters);
  const sql = `
WITH
${source.ctes},
filtered_visits AS (
  SELECT * FROM ${source.visitRelation}
  ${source.filterClause}
),
channel_rollup AS (
  SELECT
    ${buildTrafficChannelSqlExpression()} AS channel,
    count(*) AS views,
    count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS sessions,
    count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS visitors
  FROM filtered_visits
  GROUP BY channel
)
SELECT channel, views, sessions, visitors
FROM channel_rollup
ORDER BY views DESC, sessions DESC, channel ASC
LIMIT ?
`;
  return (database.prepare(sql).all(...source.bindings(limit)) as D1Row[]).map(
    (row) => ({
      channel: String(row.channel ?? "other"),
      views: Number(row.views ?? 0),
      sessions: Number(row.sessions ?? 0),
      visitors: Number(row.visitors ?? 0),
    }),
  );
}

function legacyOverviewClientOracle(
  database: DatabaseSync,
  targetSiteId: string,
  targetWindow: QueryWindow,
  limit: number,
  filters: FilterDocument = EMPTY_FILTER_DOCUMENT,
) {
  const source = overviewOracleSource(targetSiteId, targetWindow, filters);
  const sql = `
WITH
${source.ctes},
filtered_visits AS MATERIALIZED (
  SELECT
    session_id,
    TRIM(COALESCE(browser, '')) AS browser,
    TRIM(CASE
      WHEN TRIM(COALESCE(os, '')) != '' AND TRIM(COALESCE(os_version, '')) != ''
        THEN TRIM(os) || ' ' || TRIM(os_version)
      WHEN TRIM(COALESCE(os, '')) != '' THEN TRIM(os)
      ELSE TRIM(COALESCE(os_version, ''))
    END) AS osVersion,
    TRIM(COALESCE(device_type, '')) AS deviceType,
    TRIM(COALESCE(language, '')) AS language,
    CASE
      WHEN screen_width > 0 AND screen_height > 0
        THEN CAST(screen_width AS INTEGER) || 'x' || CAST(screen_height AS INTEGER)
      ELSE ''
    END AS screenSize
  FROM ${source.visitRelation}
  ${source.filterClause}
),
card_rows AS (
  SELECT 'browser' AS card_type, browser AS value, COUNT(*) AS views,
    COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id END) AS sessions
  FROM filtered_visits WHERE browser != '' GROUP BY browser
  UNION ALL
  SELECT 'osVersion', osVersion, COUNT(*),
    COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id END)
  FROM filtered_visits WHERE osVersion != '' GROUP BY osVersion
  UNION ALL
  SELECT 'deviceType', deviceType, COUNT(*),
    COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id END)
  FROM filtered_visits WHERE deviceType != '' GROUP BY deviceType
  UNION ALL
  SELECT 'language', language, COUNT(*),
    COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id END)
  FROM filtered_visits WHERE language != '' GROUP BY language
  UNION ALL
  SELECT 'screenSize', screenSize, COUNT(*),
    COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id END)
  FROM filtered_visits WHERE screenSize != '' GROUP BY screenSize
),
ranked_cards AS (
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY card_type ORDER BY views DESC, sessions DESC, value ASC
  ) AS card_rank
  FROM card_rows
)
SELECT card_type AS cardType, value, views, sessions
FROM ranked_cards
WHERE card_rank <= ?
ORDER BY card_type ASC, card_rank ASC
`;
  const rows = database.prepare(sql).all(...source.bindings(limit)) as D1Row[];
  const byCard = new Map<string, D1Row[]>();
  for (const row of rows) {
    const card = String(row.cardType ?? "");
    byCard.set(card, [...(byCard.get(card) ?? []), row]);
  }
  const read = (cardType: string) =>
    (byCard.get(cardType) ?? []).map((row) => ({
      value: String(row.value ?? ""),
      views: Number(row.views ?? 0),
      sessions: Number(row.sessions ?? 0),
      visitors: 0,
    }));
  return {
    browser: read("browser"),
    osVersion: read("osVersion"),
    deviceType: read("deviceType"),
    language: read("language"),
    screenSize: read("screenSize"),
  };
}

function legacyOverviewGeoOracle(
  database: DatabaseSync,
  targetSiteId: string,
  targetWindow: QueryWindow,
  limit: number,
  filters: FilterDocument = EMPTY_FILTER_DOCUMENT,
) {
  const source = overviewOracleSource(targetSiteId, targetWindow, filters);
  const cardSources = [
    `SELECT 'country' AS card_type, country AS value, COUNT(*) AS views,
    COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id END) AS sessions,
    COUNT(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id END) AS visitors
  FROM filtered_visits WHERE country != '' GROUP BY country`,
    `SELECT 'region', region, COUNT(*),
    COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id END),
    COUNT(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id END)
  FROM filtered_visits WHERE region != '' GROUP BY region`,
    `SELECT 'city', city, COUNT(*),
    COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id END),
    COUNT(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id END)
  FROM filtered_visits WHERE city != '' GROUP BY city`,
    `SELECT 'continent', continent, COUNT(*),
    COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id END),
    COUNT(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id END)
  FROM filtered_visits WHERE continent != '' GROUP BY continent`,
    `SELECT 'timezone', timezone, COUNT(*),
    COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id END),
    COUNT(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id END)
  FROM filtered_visits WHERE timezone != '' GROUP BY timezone`,
    // The legacy one-card organization query omitted these aliases, making
    // its ranked_cards references invalid in SQLite. Name its intended DTO
    // columns explicitly in the frozen semantic oracle.
    `SELECT 'organization' AS card_type, organization AS value, COUNT(*) AS views,
    COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id END) AS sessions,
    COUNT(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id END) AS visitors
  FROM filtered_visits WHERE organization != '' GROUP BY organization`,
  ];
  const cardRows: D1Row[] = [];
  for (const sources of [cardSources.slice(0, 5), cardSources.slice(5)]) {
    const sql = `
WITH
${source.ctes},
filtered_visits AS MATERIALIZED (
  SELECT
    session_id,
    visitor_id,
    TRIM(COALESCE(country, '')) AS country,
    ${regionValueExpr()} AS region,
    ${cityValueExpr()} AS city,
    TRIM(COALESCE(continent, '')) AS continent,
    TRIM(COALESCE(timezone, '')) AS timezone,
    TRIM(COALESCE(as_organization, '')) AS organization
  FROM ${source.visitRelation}
  ${source.filterClause}
),
card_rows AS (
${sources.join("\n  UNION ALL\n")}
),
ranked_cards AS (
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY card_type
    ORDER BY views DESC, sessions DESC, visitors DESC, value ASC
  ) AS card_rank
  FROM card_rows
)
SELECT card_type AS cardType, value, views, sessions, visitors
FROM ranked_cards
WHERE card_rank <= ?
ORDER BY card_type ASC, card_rank ASC
`;
    cardRows.push(
      ...(database.prepare(sql).all(...source.bindings(limit)) as D1Row[]),
    );
  }
  const byCard = new Map<string, D1Row[]>();
  for (const row of cardRows) {
    const card = String(row.cardType ?? "");
    byCard.set(card, [...(byCard.get(card) ?? []), row]);
  }
  const read = (cardType: string) =>
    (byCard.get(cardType) ?? []).map((row) => {
      const value = String(row.value ?? "");
      return {
        value,
        label: geoTabLabel(
          value,
          cardType as Parameters<typeof geoTabLabel>[1],
        ),
        views: Number(row.views ?? 0),
        sessions: Number(row.sessions ?? 0),
        visitors: Number(row.visitors ?? 0),
      };
    });
  return {
    country: read("country"),
    region: read("region"),
    city: read("city"),
    continent: read("continent"),
    timezone: read("timezone"),
    organization: read("organization"),
  };
}

function seedSessionPathFixture(database: DatabaseSync): void {
  const sessions = [
    {
      id: "path-session-a",
      firstVisitor: "visitor-a",
      lastVisitor: "visitor-last-a",
      firstPath: " /shared ",
      lastPath: "/exit-shared",
      firstCountry: "US",
      lastCountry: "CA",
      firstBrowser: "Chrome",
      lastBrowser: "Firefox",
    },
    {
      id: "path-session-b",
      firstVisitor: "visitor-a",
      lastVisitor: "visitor-last-b",
      firstPath: "/shared",
      lastPath: "/exit-alpha",
      firstCountry: "US",
      lastCountry: "CA",
      firstBrowser: "Chrome",
      lastBrowser: "Firefox",
    },
    {
      id: "path-session-c",
      firstVisitor: "visitor-c",
      lastVisitor: "visitor-c-last",
      firstPath: "/alpha",
      lastPath: "/exit-beta",
      firstCountry: "CA",
      lastCountry: "CA",
    },
    {
      id: "path-session-d",
      firstVisitor: "",
      lastVisitor: "visitor-d-last",
      firstPath: "/beta",
      lastPath: "/exit-shared",
      firstCountry: "CA",
      lastCountry: "CA",
    },
    {
      id: "path-session-e",
      firstVisitor: " ",
      lastVisitor: "visitor-e-last",
      firstPath: "/beta",
      lastPath: "/exit-gamma",
      firstCountry: "CA",
      lastCountry: "CA",
    },
    {
      id: "path-session-f",
      firstVisitor: "visitor-f",
      lastVisitor: "visitor-f-last",
      firstPath: "/delta",
      lastPath: "/exit-gamma",
      firstCountry: "CA",
      lastCountry: "CA",
    },
    {
      id: "path-session-g",
      firstVisitor: "visitor-g",
      lastVisitor: "visitor-g-last",
      firstPath: "/alpha",
      lastPath: "/exit-delta",
      firstCountry: "CA",
      lastCountry: "CA",
    },
    {
      id: "path-session-h",
      firstVisitor: "visitor-h",
      lastVisitor: "visitor-h-last",
      firstPath: "/zeta",
      lastPath: "/exit-zeta",
      firstCountry: "CA",
      lastCountry: "CA",
    },
    {
      id: "path-session-i",
      firstVisitor: "visitor-i",
      lastVisitor: "visitor-i-last",
      firstPath: "/search%/_\\value",
      lastPath: "/nul-path",
      firstCountry: "CA",
      lastCountry: "CA",
    },
    {
      id: "path-session-j",
      firstVisitor: "visitor-j",
      lastVisitor: "visitor-j-last",
      firstPath: " \t ",
      lastPath: "/after-empty",
      firstCountry: "CA",
      lastCountry: "CA",
    },
    {
      id: "path-session-k",
      firstVisitor: "visitor-k",
      lastVisitor: "visitor-k-last",
      firstPath: "/nul-entry",
      lastPath: "/after-nul",
      firstCountry: "CA",
      lastCountry: "CA",
    },
    {
      id: "path-session-unicode",
      firstVisitor: "visitor-unicode",
      lastVisitor: "visitor-unicode-last",
      firstPath: "/café-東京",
      lastPath: "/exit-café-東京",
      firstCountry: "CA",
      lastCountry: "CA",
    },
  ] as const;
  for (const [index, session] of sessions.entries()) {
    const startedAt = baseMs + index * 10_000;
    insertPageRow(database, {
      visitId: `${session.id}-first`,
      visitorId: session.firstVisitor,
      sessionId: session.id,
      pathname: session.firstPath,
      country: session.firstCountry,
      browser: "firstBrowser" in session ? session.firstBrowser : undefined,
      startedAt,
    });
    if (session.id === "path-session-a") {
      insertPageRow(database, {
        visitId: `${session.id}-middle-blank`,
        visitorId: "visitor-middle",
        sessionId: session.id,
        pathname: " \t ",
        country: "CA",
        browser: "Safari",
        startedAt: startedAt + 1_000,
      });
    }
    insertPageRow(database, {
      visitId: `${session.id}-last`,
      visitorId: session.lastVisitor,
      sessionId: session.id,
      pathname: session.lastPath,
      country: session.lastCountry,
      browser: "lastBrowser" in session ? session.lastBrowser : undefined,
      startedAt: startedAt + 2_000,
    });
  }
  insertPageRow(database, {
    visitId: "path-other-site",
    visitorId: "other-site-visitor",
    sessionId: "other-site-session",
    pathname: "/ignored-other-site",
    country: "US",
    siteId: "site-other",
  });
  insertPageRow(database, {
    visitId: "path-outside-window",
    visitorId: "outside-window-visitor",
    sessionId: "outside-window-session",
    pathname: "/ignored-outside-window",
    country: "US",
    startedAt: window.endExclusiveMs,
  });
  insertPageRow(database, {
    visitId: "path-whitespace-session",
    visitorId: "visitor-whitespace-session",
    sessionId: " ",
    pathname: "/whitespace-session",
    country: "CA",
  });
  insertPageRow(database, {
    visitId: "path-empty-session",
    visitorId: "visitor-empty-session",
    sessionId: "",
    pathname: "/ignored-empty-session",
    country: "CA",
  });
  insertPageRow(database, {
    visitId: null,
    visitorId: "visitor-null-id-first",
    sessionId: "path-session-null-id-tie",
    pathname: "/null-id-first",
    country: "CA",
    startedAt: baseMs + 50_000,
  });
  insertPageRow(database, {
    visitId: "path-session-null-id-tie-z",
    visitorId: "visitor-null-id-last",
    sessionId: "path-session-null-id-tie",
    pathname: "/nonnull-id-last",
    country: "CA",
    startedAt: baseMs + 50_000,
  });
}

function url(path: string, params: Record<string, string | number | boolean>) {
  const parsed = new URL(`https://edge.test${path}`);
  for (const [key, value] of Object.entries(params)) {
    parsed.searchParams.set(key, String(value));
  }
  return parsed;
}

describe("edge Session Path D1 reports", () => {
  it("matches frozen SQL for entry and exit TopN and all six paginated sort orders", async () => {
    const { env, database, close } = createMigratedPagesSqliteEnv();
    seedSessionPathFixture(database);
    try {
      for (const kind of ["entry", "exit"] as const) {
        for (const [sortBy, sortDirection] of [
          ["views", "asc"],
          ["views", "desc"],
          ["sessions", "asc"],
          ["sessions", "desc"],
          ["visitors", "asc"],
          ["visitors", "desc"],
        ] as const) {
          const expectedAll = legacySessionPathRowsOracle(
            database,
            siteId,
            window,
            EMPTY_FILTER_DOCUMENT,
            { kind, sortBy, sortDirection },
          );
          await expect(
            querySessionPathDimensionFromD1(
              env,
              siteId,
              window,
              EMPTY_FILTER_DOCUMENT,
              0,
              kind,
              undefined,
              undefined,
              sortBy,
              sortDirection,
            ),
          ).resolves.toEqual(expectedAll);
          if (sortBy === "views" && sortDirection === "asc") {
            await expect(
              querySessionPathDimensionFromD1(
                env,
                siteId,
                window,
                EMPTY_FILTER_DOCUMENT,
                -1,
                kind,
                undefined,
                undefined,
                sortBy,
                sortDirection,
              ),
            ).resolves.toEqual(expectedAll);
          }

          let cursor: LegacySessionPathCursor | null = null;
          const actualAll: Array<{
            value: string;
            views: number;
            sessions: number;
            visitors: number;
          }> = [];
          for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
            const expectedWithLookahead = legacySessionPathRowsOracle(
              database,
              siteId,
              window,
              EMPTY_FILTER_DOCUMENT,
              {
                kind,
                sortBy,
                sortDirection,
                cursor,
                limit: 2,
                paginated: true,
              },
            );
            const actual = await querySessionPathDimensionPageFromD1(
              env,
              siteId,
              window,
              EMPTY_FILTER_DOCUMENT,
              2,
              kind,
              undefined,
              undefined,
              cursor,
              "private-dashboard",
              sortBy,
              sortDirection,
            );
            expect(
              actual.items,
              `${kind}/${sortBy}/${sortDirection}/${pageIndex}`,
            ).toEqual(expectedWithLookahead.slice(0, 2));
            expect(actual.pagination.hasMore).toBe(
              expectedWithLookahead.length > 2,
            );
            actualAll.push(...actual.items);
            if (!actual.pagination.nextCursor) break;
            cursor = await decodeSessionPathDimensionCursor(
              env,
              siteId,
              window,
              EMPTY_FILTER_DOCUMENT,
              kind,
              undefined,
              actual.pagination.nextCursor,
              "private-dashboard",
              sortBy,
              sortDirection,
            );
            expect(
              cursor,
              `${kind}/${sortBy}/${sortDirection}/${pageIndex} cursor`,
            ).not.toBeNull();
          }
          expect(
            actualAll,
            `${kind}/${sortBy}/${sortDirection} full traversal`,
          ).toEqual(expectedAll);
        }
      }
    } finally {
      close();
    }
  });

  it("preserves unprepared session expansion, prepared scopes, fact filters, and legacy search", async () => {
    const { env, database, close } = createMigratedPagesSqliteEnv();
    seedSessionPathFixture(database);
    const countryFilter = filterFixture({ country: "US" });
    const prepared = prepareScopedQuery("dimension", {
      context: siteQueryContext(siteId, "private-dashboard"),
      time: createQueryTime(
        window.startMs,
        window.endExclusiveMs,
        "UTC",
        window.nowMs,
      ),
      filters: countryFilter,
      scopePreference: "session",
    } as never);
    const preparedVisitor = prepareScopedQuery("dimension", {
      context: siteQueryContext(siteId, "private-dashboard"),
      time: createQueryTime(
        window.startMs,
        window.endExclusiveMs,
        "UTC",
        window.nowMs,
      ),
      filters: countryFilter,
      scopePreference: "visitor",
    } as never);
    const preparedEvent = prepareScopedQuery("dimension", {
      context: siteQueryContext(siteId, "private-dashboard"),
      time: createQueryTime(
        window.startMs,
        window.endExclusiveMs,
        "UTC",
        window.nowMs,
      ),
      filters: countryFilter,
      scopePreference: "event",
    } as never);
    const preparedMetadata = scopedFilterMetadata(prepared.filters!);
    if (!preparedMetadata)
      throw new Error("wave46_prepared_session_scope_missing");
    const preparedIdentity = attachScopedFilterMetadata(prepared.filters!, {
      ...preparedMetadata,
      plan: {
        ...preparedMetadata.plan,
        advancedMatches: {
          entityIds: [{ siteId, id: "path-session-a" }],
        },
      },
    });
    const preparedEventMetadata = scopedFilterMetadata(preparedEvent.filters!);
    if (!preparedEventMetadata)
      throw new Error("wave46_prepared_event_scope_missing");
    const preparedPageIdentity = attachScopedFilterMetadata(
      preparedEvent.filters!,
      {
        ...preparedEventMetadata,
        plan: {
          ...preparedEventMetadata.plan,
          advancedMatches: {
            visitIds: [{ siteId, id: "path-session-a-first" }],
          },
        },
      },
    );
    const preparedEmptyIdentity = attachScopedFilterMetadata(
      preparedEvent.filters!,
      {
        ...preparedEventMetadata,
        plan: {
          ...preparedEventMetadata.plan,
          advancedMatches: { visitIds: [] },
        },
      },
    );
    const splitPageFilter = filterFixture({
      country: "US",
      browser: "Firefox",
    });
    const preparedSplitPageFilter = prepareScopedQuery("dimension", {
      context: siteQueryContext(siteId, "private-dashboard"),
      time: createQueryTime(
        window.startMs,
        window.endExclusiveMs,
        "UTC",
        window.nowMs,
      ),
      filters: splitPageFilter,
      scopePreference: "session",
    } as never);
    const sessionFactFilter = normalizedFilters({
      kind: "condition",
      target: { kind: "field", field: "session.views" },
      operator: "gte",
      value: 3,
    });
    const visitorFactFilter = normalizedFilters({
      kind: "condition",
      target: { kind: "field", field: "visitor.sessions" },
      operator: "gte",
      value: 2,
    });
    const siteIdentity = database
      .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
      .get(siteId) as { site_pk: number };
    const otherSiteIdentity = database
      .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
      .get("site-other") as { site_pk: number };
    database
      .prepare(
        "INSERT INTO custom_event_names (id, site_id, name, last_seen_at, site_pk) VALUES (?, ?, ?, ?, ?)",
      )
      .run(70, siteId, "purchase", baseMs, siteIdentity.site_pk);
    database
      .prepare(
        "INSERT INTO custom_event_names (id, site_id, name, last_seen_at, site_pk) VALUES (?, ?, ?, ?, ?)",
      )
      .run(71, "site-other", "purchase", baseMs, otherSiteIdentity.site_pk);
    database
      .prepare(
        "INSERT INTO custom_event_names (id, site_id, name, last_seen_at, site_pk) VALUES (?, ?, ?, ?, ?)",
      )
      .run(72, siteId, "refund", baseMs, siteIdentity.site_pk);
    const insertEvent = database.prepare(`
      INSERT INTO custom_events (
        event_pk, event_id, site_id, visit_id, event_name_id, occurred_at,
        received_at, sequence, node_count, value_count, site_pk
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 0, ?)
    `);
    insertEvent.run(
      70,
      "path-session-a-event",
      siteId,
      "path-session-a-first",
      70,
      baseMs + 10,
      baseMs + 10,
      siteIdentity.site_pk,
    );
    insertEvent.run(
      71,
      "path-session-b-outside-event-time",
      siteId,
      "path-session-b-first",
      70,
      window.endExclusiveMs,
      window.endExclusiveMs,
      siteIdentity.site_pk,
    );
    insertEvent.run(
      72,
      "other-site-event",
      "site-other",
      "path-other-site",
      71,
      baseMs + 10,
      baseMs + 10,
      otherSiteIdentity.site_pk,
    );
    insertEvent.run(
      73,
      "path-session-c-refund",
      siteId,
      "path-session-c-first",
      72,
      baseMs + 20,
      baseMs + 20,
      siteIdentity.site_pk,
    );
    insertEvent.run(
      74,
      "path-outside-window-in-window-event",
      siteId,
      "path-outside-window",
      70,
      baseMs + 30,
      baseMs + 30,
      siteIdentity.site_pk,
    );
    database
      .prepare(
        "INSERT INTO custom_event_json_paths (id, site_id, path, last_seen_at, site_pk) VALUES (?, ?, ?, ?, ?)",
      )
      .run(73, siteId, "/session-path-plan", baseMs, siteIdentity.site_pk);
    database
      .prepare(
        `
        INSERT INTO custom_event_json_nodes (
          event_pk, node_id, parent_node_id, key_id, path_id, value_type,
          member_order, array_index, depth
        ) VALUES (70, 700, NULL, NULL, 73, 1, NULL, NULL, 1)
      `,
      )
      .run();
    database
      .prepare(
        `
        INSERT INTO custom_event_json_values (
          event_pk, node_id, site_id, event_name_id, path_id, occurred_at,
          value_type, string_value, number_value, boolean_value, site_pk
        ) VALUES (70, 700, ?, 70, 73, ?, 1, 'yes', NULL, NULL, ?)
      `,
      )
      .run(siteId, baseMs + 10, siteIdentity.site_pk);
    const eventFilter = normalizedFilters(
      filterCondition({ kind: "field", field: "event.name" }, "purchase"),
    );
    const eventPayloadOrPageFilter = normalizedFilters({
      kind: "or",
      children: [
        filterCondition({ kind: "field", field: "geo.country" }, "US"),
        {
          kind: "condition",
          target: { kind: "event-payload", path: "/session-path-plan" },
          operator: "exists",
        },
      ],
    });
    const notRefundFilter = normalizedFilters({
      kind: "not",
      child: filterCondition({ kind: "field", field: "event.name" }, "refund"),
    });
    try {
      for (const filters of [
        countryFilter,
        prepared.filters!,
        preparedVisitor.filters!,
        preparedEvent.filters!,
        preparedIdentity,
        preparedPageIdentity,
        preparedEmptyIdentity,
      ]) {
        const expected = legacySessionPathRowsOracle(
          database,
          siteId,
          window,
          filters,
          { kind: "exit" },
        );
        await expect(
          querySessionPathDimensionFromD1(
            env,
            siteId,
            window,
            filters,
            0,
            "exit",
          ),
        ).resolves.toEqual(expected);
      }
      await expect(
        querySessionPathDimensionFromD1(
          env,
          siteId,
          window,
          sessionFactFilter,
          0,
          "entry",
        ),
      ).resolves.toEqual(
        legacySessionPathRowsOracle(
          database,
          siteId,
          window,
          sessionFactFilter,
          { kind: "entry" },
        ),
      );
      await expect(
        querySessionPathDimensionFromD1(
          env,
          siteId,
          window,
          visitorFactFilter,
          0,
          "entry",
        ),
      ).resolves.toEqual(
        legacySessionPathRowsOracle(
          database,
          siteId,
          window,
          visitorFactFilter,
          { kind: "entry" },
        ),
      );

      await expect(
        querySessionPathDimensionFromD1(
          env,
          siteId,
          window,
          eventFilter,
          0,
          "exit",
        ),
      ).resolves.toEqual(
        legacySessionPathRowsOracle(database, siteId, window, eventFilter, {
          kind: "exit",
        }),
      );
      await expect(
        querySessionPathDimensionFromD1(
          env,
          siteId,
          window,
          eventFilter,
          0,
          "exit",
        ),
      ).resolves.toEqual([
        { value: "/exit-shared", views: 1, sessions: 1, visitors: 1 },
      ]);
      for (const filters of [eventPayloadOrPageFilter, notRefundFilter]) {
        await expect(
          querySessionPathDimensionFromD1(
            env,
            siteId,
            window,
            filters,
            0,
            "entry",
          ),
        ).resolves.toEqual(
          legacySessionPathRowsOracle(database, siteId, window, filters, {
            kind: "entry",
          }),
        );
      }
      const unpreparedAdvancedFilter = parseFilterDsl(
        "session { session.views gte 3 } exists",
        analyticsFilterRegistry,
      );
      await expect(
        querySessionPathDimensionFromD1(
          env,
          siteId,
          window,
          unpreparedAdvancedFilter,
          0,
          "entry",
        ),
      ).rejects.toThrow("invalid_semantic_scoped_source_selection");
      await expect(
        querySessionPathDimensionFromD1(
          env,
          siteId,
          window,
          splitPageFilter,
          0,
          "entry",
        ),
      ).resolves.toEqual([]);
      const preparedSplitRows = await querySessionPathDimensionFromD1(
        env,
        siteId,
        window,
        preparedSplitPageFilter.filters!,
        0,
        "entry",
      );
      expect(preparedSplitRows).toEqual(
        legacySessionPathRowsOracle(
          database,
          siteId,
          window,
          preparedSplitPageFilter.filters!,
          { kind: "entry" },
        ),
      );
      expect(preparedSplitRows).toContainEqual({
        value: "/shared",
        views: 2,
        sessions: 2,
        visitors: 1,
      });

      for (const [kind, search] of [
        ["entry", "%/_\\"],
        ["entry", " CAFÉ-東京 "],
        ["entry", "\u0000"],
        ["exit", "\u0000"],
      ] as const) {
        await expect(
          querySessionPathDimensionFromD1(
            env,
            siteId,
            window,
            EMPTY_FILTER_DOCUMENT,
            0,
            kind,
            undefined,
            search,
          ),
        ).resolves.toEqual(
          legacySessionPathRowsOracle(
            database,
            siteId,
            window,
            EMPTY_FILTER_DOCUMENT,
            { kind, search },
          ),
        );
      }
    } finally {
      close();
    }
  });

  it("decodes signed legacy cursors and rejects the incomplete visitor shape", async () => {
    const { env, database, close } = createMigratedPagesSqliteEnv();
    seedSessionPathFixture(database);
    const audience = "private-dashboard" as const;
    const viewsBinding = await paginationBindingForWindow(window, [
      "analytics-session-entry-v1",
      siteId,
      window.startMs,
      window.endExclusiveMs,
      window.timeZone,
      filterFingerprint(EMPTY_FILTER_DOCUMENT, analyticsFilterRegistry),
      effectiveScopeForPagination(EMPTY_FILTER_DOCUMENT),
      "",
      audience,
      "views",
      "desc",
    ]);
    const visitorBinding = await paginationBindingForWindow(window, [
      "analytics-session-entry-v1",
      siteId,
      window.startMs,
      window.endExclusiveMs,
      window.timeZone,
      filterFingerprint(EMPTY_FILTER_DOCUMENT, analyticsFilterRegistry),
      effectiveScopeForPagination(EMPTY_FILTER_DOCUMENT),
      "",
      audience,
      "visitors",
      "desc",
    ]);
    try {
      const legacyCursor = await encodePageCursor(env, viewsBinding, {
        views: 2,
        value: "/shared",
      });
      await expect(
        decodeSessionPathDimensionCursor(
          env,
          siteId,
          window,
          EMPTY_FILTER_DOCUMENT,
          "entry",
          undefined,
          legacyCursor,
          audience,
        ),
      ).resolves.toEqual({ views: 2, value: "/shared" });
      const page = await querySessionPathDimensionPageFromD1(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        2,
        "entry",
        undefined,
        undefined,
        { views: 2, value: "/shared" },
      );
      expect(page.items).toEqual(
        legacySessionPathRowsOracle(
          database,
          siteId,
          window,
          EMPTY_FILTER_DOCUMENT,
          {
            kind: "entry",
            cursor: { views: 2, value: "/shared" },
            limit: 2,
            paginated: true,
          },
        ).slice(0, 2),
      );

      const incompleteVisitorCursor = await encodePageCursor(
        env,
        visitorBinding,
        { views: 2, value: "/shared" },
      );
      await expect(
        decodeSessionPathDimensionCursor(
          env,
          siteId,
          window,
          EMPTY_FILTER_DOCUMENT,
          "entry",
          undefined,
          incompleteVisitorCursor,
          audience,
          "visitors",
          "desc",
        ),
      ).resolves.toBeNull();
    } finally {
      close();
    }
  });

  it("reports Session Path D1 rows-read availability through the shared adapter", async () => {
    const success = createD1Env([[]], 7);
    const successDiagnostics = createD1ReadDiagnostics();
    await querySessionPathDimensionFromD1(
      success.env,
      siteId,
      window,
      EMPTY_FILTER_DOCUMENT,
      5,
      "entry",
      successDiagnostics,
    );
    expect(success.calls).toHaveLength(1);
    expect(successDiagnostics).toMatchObject({
      rowsRead: 7,
      rowsReadAvailable: true,
    });

    const unavailable = createD1Env([[]]);
    const unavailableDiagnostics = createD1ReadDiagnostics();
    await querySessionPathDimensionFromD1(
      unavailable.env,
      siteId,
      window,
      EMPTY_FILTER_DOCUMENT,
      5,
      "exit",
      unavailableDiagnostics,
    );
    expect(unavailable.calls).toHaveLength(1);
    expect(unavailableDiagnostics.rowsReadAvailable).toBe(false);
  });

  it("keeps Session Path readers within one statement and the query budgets", async () => {
    const countryFilter = filterFixture({ country: "US" });
    const prepared = prepareScopedQuery("dimension", {
      context: siteQueryContext(siteId, "private-dashboard"),
      time: createQueryTime(
        window.startMs,
        window.endExclusiveMs,
        "UTC",
        window.nowMs,
      ),
      filters: countryFilter,
      scopePreference: "session",
    } as never);
    if (!prepared.filters)
      throw new Error("wave46_budget_prepared_scope_missing");
    const preparedMetadata = scopedFilterMetadata(prepared.filters);
    if (!preparedMetadata)
      throw new Error("wave46_budget_prepared_metadata_missing");
    const advancedPrepared = attachScopedFilterMetadata(prepared.filters, {
      ...preparedMetadata,
      plan: {
        ...preparedMetadata.plan,
        advancedMatches: {
          entityIds: Array.from({ length: 128 }, (_, index) => ({
            siteId,
            id: `budget-session-${index}`,
          })),
        },
      },
    });
    const payloadForty = normalizedFilters({
      kind: "and",
      children: Array.from({ length: 40 }, (_, index) => ({
        kind: "condition",
        target: {
          kind: "event-payload",
          path: `/session-path-budget/${index}`,
        },
        operator: "exists",
      })),
    });
    const sessionFacts = normalizedFilters({
      kind: "condition",
      target: { kind: "field", field: "session.views" },
      operator: "gte",
      value: 2,
    });
    const visitorFacts = normalizedFilters({
      kind: "condition",
      target: { kind: "field", field: "visitor.sessions" },
      operator: "gte",
      value: 2,
    });
    const requests = [
      {
        name: "plain-entry",
        run: (env: Env) =>
          querySessionPathDimensionFromD1(
            env,
            siteId,
            window,
            EMPTY_FILTER_DOCUMENT,
            10,
            "entry",
          ),
      },
      {
        name: "plain-exit",
        run: (env: Env) =>
          querySessionPathDimensionFromD1(
            env,
            siteId,
            window,
            EMPTY_FILTER_DOCUMENT,
            10,
            "exit",
          ),
      },
      {
        name: "searched-top",
        run: (env: Env) =>
          querySessionPathDimensionFromD1(
            env,
            siteId,
            window,
            EMPTY_FILTER_DOCUMENT,
            10,
            "entry",
            undefined,
            "%/_\\",
          ),
      },
      {
        name: "cursor-page",
        run: (env: Env) =>
          querySessionPathDimensionPageFromD1(
            env,
            siteId,
            window,
            EMPTY_FILTER_DOCUMENT,
            10,
            "exit",
            undefined,
            "exit",
            { views: 2, value: "/cursor" },
          ),
      },
      {
        name: "event-payload-40",
        run: (env: Env) =>
          querySessionPathDimensionFromD1(
            env,
            siteId,
            window,
            payloadForty,
            10,
            "entry",
          ),
      },
      {
        name: "session-facts",
        run: (env: Env) =>
          querySessionPathDimensionFromD1(
            env,
            siteId,
            window,
            sessionFacts,
            10,
            "entry",
          ),
      },
      {
        name: "visitor-facts",
        run: (env: Env) =>
          querySessionPathDimensionFromD1(
            env,
            siteId,
            window,
            visitorFacts,
            10,
            "entry",
          ),
      },
      {
        name: "prepared-session-scope",
        run: (env: Env) =>
          querySessionPathDimensionFromD1(
            env,
            siteId,
            window,
            prepared.filters!,
            10,
            "exit",
          ),
      },
      {
        name: "prepared-128-session-identities",
        run: (env: Env) =>
          querySessionPathDimensionFromD1(
            env,
            siteId,
            window,
            advancedPrepared,
            10,
            "entry",
          ),
      },
      {
        name: "empty-result",
        run: (env: Env) =>
          querySessionPathDimensionFromD1(
            env,
            siteId,
            window,
            filterFixture({ country: "ZZ" }),
            10,
            "entry",
          ),
      },
    ];
    const metrics: Array<{
      name: string;
      statements: number;
      sqlBytes: number;
      bindings: number;
    }> = [];
    let explainSql: QueryCall | undefined;
    for (const request of requests) {
      const captured = createD1Env([[]]);
      try {
        await request.run(captured.env);
      } catch (error) {
        throw new Error(
          `wave46_session_path_budget_compile_failed:${request.name}`,
          {
            cause: error,
          },
        );
      }
      expect(captured.calls, request.name).toHaveLength(1);
      const call = captured.calls[0]!;
      const sqlBytes = new TextEncoder().encode(call.sql).byteLength;
      expect(sqlBytes, `${request.name} SQL bytes`).toBeLessThanOrEqual(
        100_000,
      );
      expect(
        call.bindings.length,
        `${request.name} bindings`,
      ).toBeLessThanOrEqual(100);
      metrics.push({
        name: request.name,
        statements: captured.calls.length,
        sqlBytes,
        bindings: call.bindings.length,
      });
      if (request.name === "plain-entry") explainSql = call;
    }
    if (!explainSql) throw new Error("wave46_session_path_eqp_query_missing");
    const { database, close } = createMigratedPagesSqliteEnv();
    try {
      const explain = database
        .prepare(`EXPLAIN QUERY PLAN ${explainSql.sql}`)
        .all(...explainSql.bindings) as Array<{ detail?: string }>;
      expect(explain.length).toBeGreaterThan(0);
      console.info("wave46_session_path_query_budget", JSON.stringify(metrics));
    } finally {
      close();
    }
  });
});

describe("edge pages D1 queries", () => {
  it("queries top pages with details, filters, numeric mapping, and limit binding", async () => {
    const { env, calls } = createD1Env([
      [
        {
          pathname: "/pricing",
          queryValue: "plan=pro",
          hashValue: "faq",
          views: "12",
          sessions: "5",
        },
      ],
    ]);

    await expect(
      queryTopPagesFromD1(
        env,
        siteId,
        window,
        15,
        true,
        filterFixture({
          country: "US",
          hostname: "Example.COM",
          path: "/pricing",
        }),
      ),
    ).resolves.toEqual([
      {
        pathname: "/pricing",
        query: "plan=pro",
        hash: "faq",
        views: 12,
        sessions: 5,
      },
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("queryValue");
    expect(calls[0].sql).toContain("hashValue");
    expect(calls[0].sql).toContain("GROUP BY");
    expect(calls[0].bindings.at(-1)).toBe(15);
    expect(calls[0].bindings).toEqual(
      expect.arrayContaining([
        ...visitBindings(),
        "us",
        "example.com",
        "/pricing",
      ]),
    );
  });

  it("preserves direct Page row bags and prepared Page membership for null visit IDs", async () => {
    const { env, database, close } = createMigratedPagesSqliteEnv();
    insertPageRow(database, {
      visitId: null,
      visitorId: "null-visitor-us",
      sessionId: "null-session-us",
      pathname: "/null-us",
      country: "US",
    });
    insertPageRow(database, {
      visitId: null,
      visitorId: "null-visitor-ca",
      sessionId: "null-session-ca",
      pathname: "/null-ca",
      country: "CA",
    });
    insertPageRow(database, {
      visitId: "page-normal-us",
      visitorId: "normal-visitor-us",
      sessionId: "normal-session-us",
      pathname: "/normal-us",
      country: "US",
    });

    try {
      const directAll = await queryTopPagesFromD1(
        env,
        siteId,
        window,
        10,
        false,
        EMPTY_FILTER_DOCUMENT,
      );
      expect(directAll).toEqual(
        await legacyTopPagesOracle(
          env,
          siteId,
          window,
          10,
          false,
          EMPTY_FILTER_DOCUMENT,
        ),
      );
      expect(directAll.map((row) => row.pathname)).toEqual([
        "/normal-us",
        "/null-ca",
        "/null-us",
      ]);

      const countryFilters = filterFixture({ country: "US" });
      const directCountry = await queryTopPagesFromD1(
        env,
        siteId,
        window,
        10,
        false,
        countryFilters,
      );
      expect(directCountry).toEqual(
        await legacyTopPagesOracle(
          env,
          siteId,
          window,
          10,
          false,
          countryFilters,
        ),
      );
      expect(directCountry.map((row) => row.pathname)).toEqual([
        "/normal-us",
        "/null-us",
      ]);

      const prepared = prepareScopedQuery("pages", {
        context: siteQueryContext(siteId, "private-dashboard"),
        time: createQueryTime(
          window.startMs,
          window.endExclusiveMs,
          "UTC",
          window.nowMs,
        ),
        filters: countryFilters,
        scopePreference: "event",
      });
      expect(prepared.filters).toBeDefined();
      const preparedPages = await queryTopPagesFromD1(
        env,
        siteId,
        window,
        10,
        false,
        prepared.filters!,
      );
      expect(preparedPages).toEqual(
        await legacyTopPagesOracle(
          env,
          siteId,
          window,
          10,
          false,
          prepared.filters!,
        ),
      );
      expect(preparedPages.map((row) => row.pathname)).toEqual(["/normal-us"]);
    } finally {
      close();
    }
  });

  it("uses prepared Page visit snapshots without event expansion and entity snapshots by kind", async () => {
    const { env, database, close } = createMigratedPagesSqliteEnv();
    insertPageRow(database, {
      visitId: "page-id-selected",
      visitorId: "selected-visitor",
      sessionId: "selected-session",
      pathname: "/selected-page",
      country: "US",
    });
    insertPageRow(database, {
      visitId: "same-session-page",
      visitorId: "selected-visitor",
      sessionId: "selected-session",
      pathname: "/same-session-ca",
      country: "CA",
    });
    insertPageRow(database, {
      visitId: "same-visitor-page",
      visitorId: "selected-visitor",
      sessionId: "other-session",
      pathname: "/same-visitor-ca",
      country: "CA",
    });
    insertPageRow(database, {
      visitId: "event-owner-page",
      visitorId: "event-owner-visitor",
      sessionId: "event-owner-session",
      pathname: "/event-owner",
      country: "CA",
    });
    const siteIdentity = database
      .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
      .get(siteId) as { site_pk: number };
    database
      .prepare(
        "INSERT INTO custom_event_names (id, site_id, name, last_seen_at, site_pk) VALUES (41, ?, 'purchase', ?, ?)",
      )
      .run(siteId, baseMs, siteIdentity.site_pk);
    database
      .prepare(
        `
        INSERT INTO custom_events (
          event_pk, event_id, site_id, visit_id, event_name_id, occurred_at,
          received_at, sequence, node_count, value_count, site_pk
        ) VALUES (41, 'advanced-event-id', ?, 'event-owner-page', 41, ?, ?, 1, 1, 1, ?)
      `,
      )
      .run(siteId, baseMs + 10, baseMs + 10, siteIdentity.site_pk);

    const time = createQueryTime(
      window.startMs,
      window.endExclusiveMs,
      "UTC",
      window.nowMs,
    );
    const context = siteQueryContext(siteId, "private-dashboard");
    const baseFilters = filterFixture({ country: "US" });
    const preparedObservation = prepareScopedQuery("pages", {
      context,
      time,
      filters: baseFilters,
      scopePreference: "event",
    } as never) as { filters?: FilterDocument };
    const observationMetadata = scopedFilterMetadata(
      preparedObservation.filters,
    );
    if (!preparedObservation.filters || !observationMetadata)
      throw new Error("wave43_prepared_observation_incomplete");
    const observationFilters = attachScopedFilterMetadata(
      preparedObservation.filters,
      {
        ...observationMetadata,
        plan: {
          ...observationMetadata.plan,
          advancedMatches: {
            visitIds: [{ siteId, id: "page-id-selected" }],
            eventIds: [{ siteId, id: "advanced-event-id" }],
          },
        },
      },
    );
    const makeEntityFilters = (
      scopePreference: "session" | "visitor",
      entityId?: string,
    ): FilterDocument => {
      const preparedEntity = prepareScopedQuery("pages", {
        context,
        time,
        filters: baseFilters,
        scopePreference,
      } as never) as { filters?: FilterDocument };
      const metadata = scopedFilterMetadata(preparedEntity.filters);
      if (!preparedEntity.filters || !metadata)
        throw new Error(`wave43_prepared_${scopePreference}_incomplete`);
      return entityId
        ? attachScopedFilterMetadata(preparedEntity.filters, {
            ...metadata,
            plan: {
              ...metadata.plan,
              advancedMatches: {
                entityIds: [{ siteId, id: entityId }],
              },
            },
          })
        : preparedEntity.filters;
    };
    const ordinarySessionFilters = makeEntityFilters("session");
    const ordinaryVisitorFilters = makeEntityFilters("visitor");
    const sessionFilters = makeEntityFilters("session", "event-owner-session");
    const visitorFilters = makeEntityFilters("visitor", "event-owner-visitor");

    try {
      const observationRows = await queryTopPagesFromD1(
        env,
        siteId,
        window,
        10,
        false,
        observationFilters,
      );
      expect(observationRows).toEqual(
        await legacyTopPagesOracle(
          env,
          siteId,
          window,
          10,
          false,
          observationFilters,
        ),
      );
      expect(observationRows.map((row) => row.pathname)).toEqual([
        "/selected-page",
      ]);

      const ordinarySessionRows = await queryTopPagesFromD1(
        env,
        siteId,
        window,
        10,
        false,
        ordinarySessionFilters,
      );
      expect(ordinarySessionRows).toEqual(
        await legacyTopPagesOracle(
          env,
          siteId,
          window,
          10,
          false,
          ordinarySessionFilters,
        ),
      );
      expect(ordinarySessionRows.map((row) => row.pathname)).toEqual([
        "/same-session-ca",
        "/selected-page",
      ]);

      const ordinaryVisitorRows = await queryTopPagesFromD1(
        env,
        siteId,
        window,
        10,
        false,
        ordinaryVisitorFilters,
      );
      expect(ordinaryVisitorRows).toEqual(
        await legacyTopPagesOracle(
          env,
          siteId,
          window,
          10,
          false,
          ordinaryVisitorFilters,
        ),
      );
      expect(ordinaryVisitorRows.map((row) => row.pathname)).toEqual([
        "/same-session-ca",
        "/same-visitor-ca",
        "/selected-page",
      ]);

      const sessionRows = await queryTopPagesFromD1(
        env,
        siteId,
        window,
        10,
        false,
        sessionFilters,
      );
      expect(sessionRows).toEqual(
        await legacyTopPagesOracle(
          env,
          siteId,
          window,
          10,
          false,
          sessionFilters,
        ),
      );
      expect(sessionRows.map((row) => row.pathname)).toEqual(["/event-owner"]);

      const visitorRows = await queryTopPagesFromD1(
        env,
        siteId,
        window,
        10,
        false,
        visitorFilters,
      );
      expect(visitorRows).toEqual(
        await legacyTopPagesOracle(
          env,
          siteId,
          window,
          10,
          false,
          visitorFilters,
        ),
      );
      expect(visitorRows.map((row) => row.pathname)).toEqual(["/event-owner"]);
    } finally {
      close();
    }
  });

  it("matches the frozen reader for Event payload and mixed Page/Event predicates", async () => {
    const { env, database, close } = createMigratedPagesSqliteEnv();
    insertPageRow(database, {
      visitId: "page-event-country",
      visitorId: "page-event-visitor",
      sessionId: "page-event-session",
      pathname: "/page-country",
      country: "US",
    });
    insertPageRow(database, {
      visitId: "payload-event-owner",
      visitorId: "payload-event-visitor",
      sessionId: "payload-event-session",
      pathname: "/event-owner",
      country: "CA",
    });
    const siteIdentity = database
      .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
      .get(siteId) as { site_pk: number };
    database
      .prepare(
        "INSERT INTO custom_event_names (id, site_id, name, last_seen_at, site_pk) VALUES (?, ?, ?, ?, ?)",
      )
      .run(31, siteId, "purchase", baseMs, siteIdentity.site_pk);
    database
      .prepare(
        `
        INSERT INTO custom_events (
          event_pk, event_id, site_id, visit_id, event_name_id, occurred_at,
          received_at, sequence, node_count, value_count, site_pk
        ) VALUES (1, 'payload-event-1', ?, 'payload-event-owner', 31, ?, ?, 1, 1, 1, ?)
      `,
      )
      .run(siteId, baseMs + 10, baseMs + 10, siteIdentity.site_pk);
    database
      .prepare(
        "INSERT INTO custom_event_json_paths (id, site_id, path, last_seen_at, site_pk) VALUES (?, ?, ?, ?, ?)",
      )
      .run(51, siteId, "/plan", baseMs, siteIdentity.site_pk);
    database
      .prepare(
        `
        INSERT INTO custom_event_json_nodes (
          event_pk, node_id, parent_node_id, key_id, path_id, value_type,
          member_order, array_index, depth
        ) VALUES (1, 1, NULL, NULL, 51, 1, NULL, NULL, 1)
      `,
      )
      .run();
    database
      .prepare(
        `
        INSERT INTO custom_event_json_values (
          event_pk, node_id, site_id, event_name_id, path_id, occurred_at,
          value_type, string_value, number_value, boolean_value, site_pk
        ) VALUES (1, 1, ?, 31, 51, ?, 1, 'pro', NULL, NULL, ?)
      `,
      )
      .run(siteId, baseMs + 10, siteIdentity.site_pk);

    const payloadOnly = normalizedFilters(
      filterCondition({ kind: "event-payload", path: "/plan" }, "pro"),
    );
    const mixedCases = [
      normalizedFilters({
        kind: "or",
        children: [
          filterCondition({ kind: "field", field: "geo.country" }, "US"),
          filterCondition({ kind: "field", field: "event.name" }, "purchase"),
        ],
      }),
      normalizedFilters({
        kind: "and",
        children: [
          filterCondition({ kind: "field", field: "geo.country" }, "US"),
          filterCondition({ kind: "field", field: "event.name" }, "purchase"),
        ],
      }),
      normalizedFilters({
        kind: "not",
        child: filterCondition(
          { kind: "field", field: "event.name" },
          "refund",
        ),
      }),
    ];

    try {
      for (const filters of [payloadOnly, ...mixedCases]) {
        await expect(
          queryTopPagesFromD1(env, siteId, window, 10, true, filters),
        ).resolves.toEqual(
          await legacyTopPagesOracle(env, siteId, window, 10, true, filters),
        );
      }
      await expect(
        queryTopPagesFromD1(env, siteId, window, 10, true, payloadOnly),
      ).resolves.toMatchObject([{ pathname: "/event-owner", views: 1 }]);
    } finally {
      close();
    }
  });

  it("preserves NULL Page row bags when an in-window Event belongs to an out-of-window Page", async () => {
    const { env, database, close } = createMigratedPagesSqliteEnv();
    insertPageRow(database, {
      visitId: null,
      visitorId: "null-or-visitor",
      sessionId: "null-or-session",
      pathname: "/null-or-match",
      country: "CA",
    });
    insertPageRow(database, {
      visitId: "outside-window-event-owner",
      visitorId: "outside-owner-visitor",
      sessionId: "outside-owner-session",
      pathname: "/outside-window-owner",
      country: "US",
    });
    database
      .prepare("UPDATE visits SET started_at = ? WHERE visit_id = ?")
      .run(window.endExclusiveMs, "outside-window-event-owner");
    const siteIdentity = database
      .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
      .get(siteId) as { site_pk: number };
    database
      .prepare(
        "INSERT INTO custom_event_names (id, site_id, name, last_seen_at, site_pk) VALUES (42, ?, 'purchase', ?, ?)",
      )
      .run(siteId, baseMs, siteIdentity.site_pk);
    database
      .prepare(
        `
        INSERT INTO custom_events (
          event_pk, event_id, site_id, visit_id, event_name_id, occurred_at,
          received_at, sequence, node_count, value_count, site_pk
        ) VALUES (42, 'outside-owner-event', ?, 'outside-window-event-owner', 42, ?, ?, 1, 1, 1, ?)
      `,
      )
      .run(siteId, baseMs + 10, baseMs + 10, siteIdentity.site_pk);

    const filters = normalizedFilters({
      kind: "or",
      children: [
        filterCondition({ kind: "field", field: "geo.country" }, "CA"),
        filterCondition({ kind: "field", field: "event.name" }, "purchase"),
      ],
    });

    try {
      const rows = await queryTopPagesFromD1(
        env,
        siteId,
        window,
        10,
        false,
        filters,
      );
      expect(rows).toEqual(
        await legacyTopPagesOracle(env, siteId, window, 10, false, filters),
      );
      expect(rows).toMatchObject([
        { pathname: "/null-or-match", views: 1, sessions: 1 },
      ]);
      expect(
        database
          .prepare(
            "SELECT count(*) AS count FROM custom_events WHERE event_id = 'outside-owner-event' AND occurred_at >= ? AND occurred_at < ?",
          )
          .get(window.startMs, window.endExclusiveMs),
      ).toEqual({ count: 1 });
      expect(
        database
          .prepare(
            "SELECT count(*) AS count FROM visits WHERE visit_id = 'outside-window-event-owner' AND started_at >= ? AND started_at < ?",
          )
          .get(window.startMs, window.endExclusiveMs),
      ).toEqual({ count: 0 });
    } finally {
      close();
    }
  });

  it("keeps paginated Page groups in the legacy keyset order without gaps", async () => {
    const { env, database, close } = createMigratedPagesSqliteEnv();
    const rows = [
      ["page-a-1", "session-a", "/same", "plan=a", "x"],
      ["page-a-2", "session-a", "/same", "plan=a", "x"],
      ["page-b-1", "session-b1", "/same", "plan=b", "x"],
      ["page-b-2", "session-b2", "/same", "plan=b", "x"],
      ["page-next", "session-next", "/next", "", ""],
      ["page-other", "session-other", "/other", "", ""],
    ] as const;
    for (const [visitId, sessionId, pathname, query, hash] of rows) {
      insertPageRow(database, {
        visitId,
        visitorId: `visitor-${sessionId}`,
        sessionId,
        pathname,
        country: "US",
        query,
        hash,
      });
    }

    try {
      const first = await queryPagesPageFromD1(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        2,
        true,
      );
      const firstOracle = await legacyPagesPageRowsOracle(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        2,
        true,
      );
      expect(first.items).toEqual(firstOracle.slice(0, 2));
      expect(first.pagination.hasMore).toBe(true);
      const firstCursor = await decodePagesCursor(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        true,
        first.pagination.nextCursor,
      );
      expect(firstCursor).toEqual({
        views: 2,
        sessions: 1,
        pathname: "/same",
        query: "plan=a",
        hash: "x",
      });

      const second = await queryPagesPageFromD1(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        2,
        true,
        firstCursor,
      );
      const secondOracle = await legacyPagesPageRowsOracle(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        2,
        true,
        firstCursor,
      );
      expect(second.items).toEqual(secondOracle.slice(0, 2));
      expect(second.items.map((row) => row.pathname)).toEqual([
        "/next",
        "/other",
      ]);
      expect(second.pagination).toMatchObject({
        returned: 2,
        hasMore: false,
        nextCursor: null,
      });
      expect([
        ...first.items.map((row) => `${row.pathname}|${row.query}|${row.hash}`),
        ...second.items.map(
          (row) => `${row.pathname}|${row.query}|${row.hash}`,
        ),
      ]).toEqual(["/same|plan=b|x", "/same|plan=a|x", "/next||", "/other||"]);
    } finally {
      close();
    }
  });

  it("matches frozen pre-migration SQL for every finite Page dimension selector", async () => {
    const { env, database, close } = createMigratedPagesSqliteEnv();
    seedDimensionReportFixture(database);
    const selections = Object.values(PAGE_DIMENSION_SELECTIONS);
    try {
      expect(analyticsPageDimensionSelection("geo.timezone")).toBe(
        PAGE_DIMENSION_SELECTIONS.timezoneTrimmed,
      );
      for (const selection of selections) {
        const actual = await queryDimensionFromD1(
          env,
          siteId,
          window,
          EMPTY_FILTER_DOCUMENT,
          0,
          selection,
        );
        const expected = legacyDimensionRowsOracle(
          database,
          siteId,
          window,
          selection,
        );
        expect(actual, selection.id).toEqual(expected);
      }
    } finally {
      close();
    }
  });

  it("matches frozen channel, client, and geo overview SQL with bounded typed reads", async () => {
    const { env, database, calls, close } = createMigratedPagesSqliteEnv();
    seedDimensionReportFixture(database);
    insertPageRow(database, {
      visitId: "dimension-start-boundary",
      visitorId: "visitor-start-boundary",
      sessionId: "session-start-boundary",
      pathname: "/start-boundary",
      country: "US",
      startedAt: window.startMs,
    });
    insertPageRow(database, {
      visitId: "dimension-end-boundary",
      visitorId: "visitor-end-boundary",
      sessionId: "session-end-boundary",
      pathname: "/end-boundary",
      country: "US",
      startedAt: window.endExclusiveMs,
    });
    insertPageRow(database, {
      visitId: "dimension-other-site",
      visitorId: "visitor-other-site",
      sessionId: "session-other-site",
      pathname: "/other-site",
      country: "US",
      siteId: "site-pages-other",
      startedAt: window.startMs,
    });
    try {
      const channelRows = await queryChannelsFromD1(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        -1,
      );
      expect(channelRows.reduce((total, row) => total + row.views, 0)).toBe(7);
      expect(channelRows.find((row) => row.channel === "direct")).toMatchObject(
        {
          views: 2,
          sessions: 2,
          visitors: 2,
        },
      );

      for (const limit of [2, 0, -1]) {
        calls.length = 0;
        await expect(
          queryChannelsFromD1(
            env,
            siteId,
            window,
            EMPTY_FILTER_DOCUMENT,
            limit,
          ),
        ).resolves.toEqual(
          legacyOverviewChannelsOracle(database, siteId, window, limit),
        );
        expect(calls).toHaveLength(1);

        calls.length = 0;
        await expect(
          queryOverviewClientDimensionsFromD1(
            env,
            siteId,
            window,
            EMPTY_FILTER_DOCUMENT,
            limit,
          ),
        ).resolves.toEqual(
          legacyOverviewClientOracle(database, siteId, window, limit),
        );
        expect(calls).toHaveLength(1);

        calls.length = 0;
        await expect(
          queryOverviewGeoDimensionsFromD1(
            env,
            siteId,
            window,
            EMPTY_FILTER_DOCUMENT,
            limit,
          ),
        ).resolves.toEqual(
          legacyOverviewGeoOracle(database, siteId, window, limit),
        );
        expect(calls).toHaveLength(2);
        for (const call of calls) {
          const sqlBytes = Buffer.byteLength(call.sql, "utf8");
          expect(sqlBytes).toBeLessThanOrEqual(100_000);
          expect(call.bindings.length).toBeLessThanOrEqual(100);
        }
      }

      await expect(
        queryChannelsFromD1(env, siteId, window, EMPTY_FILTER_DOCUMENT, 1.5),
      ).rejects.toThrow("channel_limit_must_be_integer");
      expect(() =>
        legacyOverviewChannelsOracle(database, siteId, window, 1.5),
      ).toThrow();

      calls.length = 0;
      await expect(
        queryOverviewClientDimensionsFromD1(
          env,
          siteId,
          window,
          EMPTY_FILTER_DOCUMENT,
          1.5,
        ),
      ).resolves.toEqual(
        legacyOverviewClientOracle(database, siteId, window, 1.5),
      );
      expect(calls).toHaveLength(1);
      calls.length = 0;
      await expect(
        queryOverviewGeoDimensionsFromD1(
          env,
          siteId,
          window,
          EMPTY_FILTER_DOCUMENT,
          1.5,
        ),
      ).resolves.toEqual(
        legacyOverviewGeoOracle(database, siteId, window, 1.5),
      );
      expect(calls).toHaveLength(2);
    } finally {
      close();
    }
  });

  it("matches prepared observation, advanced identity, empty identity, and Event payload scopes", async () => {
    const { env, database, calls, close } = createMigratedPagesSqliteEnv();
    seedDimensionReportFixture(database);
    const prepared = prepareScopedQuery("overview", {
      context: siteQueryContext(siteId, "private-dashboard"),
      time: createQueryTime(
        window.startMs,
        window.endExclusiveMs,
        "UTC",
        window.nowMs,
      ),
      filters: filterFixture({ path: "/alpha" }),
      scopePreference: "event",
    } as never) as { filters?: FilterDocument };
    if (!prepared.filters)
      throw new Error("wave47_prepared_observation_scope_missing");
    const metadata = scopedFilterMetadata(prepared.filters);
    if (!metadata) throw new Error("wave47_prepared_metadata_missing");
    const advancedPrepared = (count: number) =>
      attachScopedFilterMetadata(prepared.filters!, {
        ...metadata,
        plan: {
          ...metadata.plan,
          advancedMatches: {
            visitIds: Array.from({ length: count }, (_, index) => ({
              siteId,
              id: index < 6 ? `dimension-${index + 1}` : `missing-${index}`,
            })),
          },
        },
      });
    const payloadForty = normalizedFilters({
      kind: "and",
      children: Array.from({ length: 40 }, (_, index) => ({
        kind: "condition",
        target: {
          kind: "event-payload",
          path: `/overview-diff/${index}`,
        },
        operator: "exists",
      })),
    });
    const cases = [
      { name: "prepared-observation", filters: prepared.filters },
      { name: "advanced-128-visit-ids", filters: advancedPrepared(128) },
      { name: "advanced-empty-visit-ids", filters: advancedPrepared(0) },
      { name: "event-payload-40", filters: payloadForty },
    ];
    try {
      for (const testCase of cases) {
        calls.length = 0;
        await expect(
          queryChannelsFromD1(env, siteId, window, testCase.filters, 3),
        ).resolves.toEqual(
          legacyOverviewChannelsOracle(
            database,
            siteId,
            window,
            3,
            testCase.filters,
          ),
        );
        expect(calls, `${testCase.name}/channels`).toHaveLength(1);

        calls.length = 0;
        await expect(
          queryOverviewClientDimensionsFromD1(
            env,
            siteId,
            window,
            testCase.filters,
            3,
          ),
        ).resolves.toEqual(
          legacyOverviewClientOracle(
            database,
            siteId,
            window,
            3,
            testCase.filters,
          ),
        );
        expect(calls, `${testCase.name}/client`).toHaveLength(1);

        calls.length = 0;
        await expect(
          queryOverviewGeoDimensionsFromD1(
            env,
            siteId,
            window,
            testCase.filters,
            3,
          ),
        ).resolves.toEqual(
          legacyOverviewGeoOracle(
            database,
            siteId,
            window,
            3,
            testCase.filters,
          ),
        );
        expect(calls, `${testCase.name}/geo`).toHaveLength(2);
      }
    } finally {
      close();
    }
  });

  it("keeps public overview statement shapes within D1 SQL and binding budgets", async () => {
    const payloadForty = normalizedFilters({
      kind: "and",
      children: Array.from({ length: 40 }, (_, index) => ({
        kind: "condition",
        target: {
          kind: "event-payload",
          path: `/overview-budget/${index}`,
        },
        operator: "exists",
      })),
    });
    const prepared = prepareScopedQuery("overview", {
      context: siteQueryContext(siteId, "private-dashboard"),
      time: createQueryTime(
        window.startMs,
        window.endExclusiveMs,
        "UTC",
        window.nowMs,
      ),
      filters: filterFixture({ country: "US" }),
      scopePreference: "event",
    } as never) as { filters?: FilterDocument };
    if (!prepared.filters)
      throw new Error("wave47_budget_prepared_scope_missing");
    const metadata = scopedFilterMetadata(prepared.filters);
    if (!metadata) throw new Error("wave47_budget_metadata_missing");
    const advancedPrepared = attachScopedFilterMetadata(prepared.filters, {
      ...metadata,
      plan: {
        ...metadata.plan,
        advancedMatches: {
          visitIds: Array.from({ length: 128 }, (_, index) => ({
            siteId,
            id: `overview-budget-visit-${index}`,
          })),
        },
      },
    });
    const readers = [
      {
        name: "channels-plain",
        expectedStatements: 1,
        run: (env: Env) =>
          queryChannelsFromD1(env, siteId, window, EMPTY_FILTER_DOCUMENT, 10),
      },
      {
        name: "client-plain",
        expectedStatements: 1,
        run: (env: Env) =>
          queryOverviewClientDimensionsFromD1(
            env,
            siteId,
            window,
            EMPTY_FILTER_DOCUMENT,
            10,
          ),
      },
      {
        name: "geo-plain",
        expectedStatements: 2,
        run: (env: Env) =>
          queryOverviewGeoDimensionsFromD1(
            env,
            siteId,
            window,
            EMPTY_FILTER_DOCUMENT,
            10,
          ),
      },
      {
        name: "channels-event-payload-40",
        expectedStatements: 1,
        run: (env: Env) =>
          queryChannelsFromD1(env, siteId, window, payloadForty, 10),
      },
      {
        name: "client-event-payload-40",
        expectedStatements: 1,
        run: (env: Env) =>
          queryOverviewClientDimensionsFromD1(
            env,
            siteId,
            window,
            payloadForty,
            10,
          ),
      },
      {
        name: "geo-event-payload-40",
        expectedStatements: 2,
        run: (env: Env) =>
          queryOverviewGeoDimensionsFromD1(
            env,
            siteId,
            window,
            payloadForty,
            10,
          ),
      },
      {
        name: "client-prepared-128-visit-ids",
        expectedStatements: 1,
        run: (env: Env) =>
          queryOverviewClientDimensionsFromD1(
            env,
            siteId,
            window,
            advancedPrepared,
            10,
          ),
      },
    ];
    const evidence: Array<Record<string, unknown>> = [];
    for (const reader of readers) {
      const captured = createD1Env([[], []]);
      await reader.run(captured.env);
      expect(captured.calls, reader.name).toHaveLength(
        reader.expectedStatements,
      );
      for (const [index, call] of captured.calls.entries()) {
        const sqlBytes = Buffer.byteLength(call.sql, "utf8");
        expect(sqlBytes, `${reader.name}/${index}`).toBeLessThanOrEqual(
          100_000,
        );
        expect(
          call.bindings.length,
          `${reader.name}/${index}`,
        ).toBeLessThanOrEqual(100);
        evidence.push({
          name: reader.name,
          statement: index + 1,
          statements: captured.calls.length,
          sqlBytes,
          bindings: call.bindings.length,
          sha256: createHash("sha256").update(call.sql).digest("hex"),
        });
      }
    }
    console.info("wave47_overview_query_budget", JSON.stringify(evidence));
  });

  it("preserves typed dimension grouping, search, and six keyset sort orders", async () => {
    const { env, database, close } = createMigratedPagesSqliteEnv();
    seedDimensionReportFixture(database);
    const selection = PAGE_DIMENSION_SELECTIONS.pagePath;
    try {
      for (const [sortBy, sortDirection] of [
        ["views", "asc"],
        ["views", "desc"],
        ["sessions", "asc"],
        ["sessions", "desc"],
        ["visitors", "asc"],
        ["visitors", "desc"],
      ] as const) {
        let cursor: {
          primary: number;
          secondary: number;
          value: string;
        } | null = null;
        const actualRows: Array<{
          value: string;
          views: number;
          sessions: number;
          visitors: number;
        }> = [];
        for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
          const actual = await queryDimensionPageFromD1(
            env,
            siteId,
            window,
            EMPTY_FILTER_DOCUMENT,
            2,
            selection,
            { sortBy, sortDirection },
            cursor,
          );
          const expectedWithLookahead = legacyDimensionRowsOracle(
            database,
            siteId,
            window,
            selection,
            { sortBy, sortDirection, cursor, limit: 2, paginated: true },
          );
          expect(
            actual.items,
            `${sortBy}/${sortDirection}/${pageIndex}`,
          ).toEqual(expectedWithLookahead.slice(0, 2));
          expect(actual.pagination.hasMore).toBe(
            expectedWithLookahead.length > 2,
          );
          actualRows.push(...actual.items);
          if (!actual.pagination.nextCursor) break;
          cursor = await decodeDimensionCursor(
            env,
            siteId,
            window,
            EMPTY_FILTER_DOCUMENT,
            selection,
            undefined,
            actual.pagination.nextCursor,
            "private-dashboard",
            sortBy,
            sortDirection,
          );
          expect(
            cursor,
            `${sortBy}/${sortDirection}/${pageIndex} cursor`,
          ).not.toBeNull();
        }
        expect(actualRows).toEqual(
          legacyDimensionRowsOracle(database, siteId, window, selection, {
            sortBy,
            sortDirection,
          }),
        );
      }

      for (const search of ["%/_\\", "\u0000"]) {
        const options = { search, excludeEmpty: true };
        await expect(
          queryDimensionFromD1(
            env,
            siteId,
            window,
            EMPTY_FILTER_DOCUMENT,
            0,
            selection,
            options,
          ),
        ).resolves.toEqual(
          legacyDimensionRowsOracle(
            database,
            siteId,
            window,
            selection,
            options,
          ),
        );
      }
      await expect(
        queryDimensionFromD1(
          env,
          siteId,
          window,
          EMPTY_FILTER_DOCUMENT,
          0,
          selection,
          { excludeEmpty: true },
        ),
      ).resolves.toEqual(
        legacyDimensionRowsOracle(database, siteId, window, selection, {
          excludeEmpty: true,
        }),
      );
    } finally {
      close();
    }
  });

  it("decodes an existing signed legacy dimension cursor with its frozen selector token", async () => {
    const { env } = createD1Env([[]]);
    const selection = PAGE_DIMENSION_SELECTIONS.pagePathTrimmed;
    const legacyToken = resolveCrossBreakdownDimension("page.path")!.labelExpr;
    const binding = await paginationBindingForWindow(window, [
      "analytics-dimensions-v1",
      "private-dashboard",
      siteId,
      window.startMs,
      window.endExclusiveMs,
      window.timeZone,
      filterFingerprint(EMPTY_FILTER_DOCUMENT, analyticsFilterRegistry),
      effectiveScopeForPagination(EMPTY_FILTER_DOCUMENT),
      legacyToken,
      "",
      "views",
      "desc",
    ]);
    const legacyCursor = await encodePageCursor(env, binding, {
      primary: 4,
      secondary: 3,
      value: "/frozen",
    });
    await expect(
      decodeDimensionCursor(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        selection,
        undefined,
        legacyCursor,
      ),
    ).resolves.toEqual({ primary: 4, secondary: 3, value: "/frozen" });
  });

  it("keeps typed dimension readers within one-statement SQL and binding budgets", async () => {
    const payloadForty = normalizedFilters({
      kind: "and",
      children: Array.from(
        { length: 40 },
        (_, index) =>
          ({
            kind: "condition",
            target: {
              kind: "event-payload",
              path: `/dimension-budget/${index}`,
            },
            operator: "exists",
          }) as const,
      ),
    });
    const prepared = prepareScopedQuery("pages", {
      context: siteQueryContext(siteId, "private-dashboard"),
      time: createQueryTime(
        window.startMs,
        window.endExclusiveMs,
        "UTC",
        window.nowMs,
      ),
      filters: filterFixture({ country: "US" }),
      scopePreference: "event",
    } as never) as { filters?: FilterDocument };
    if (!prepared.filters)
      throw new Error("wave45_dimension_budget_preparation_failed");
    const metadata = scopedFilterMetadata(prepared.filters);
    if (!metadata) throw new Error("wave45_dimension_budget_metadata_missing");
    const advanced = (count: number) =>
      attachScopedFilterMetadata(prepared.filters!, {
        ...metadata,
        plan: {
          ...metadata.plan,
          advancedMatches: {
            visitIds: Array.from({ length: count }, (_, index) => ({
              siteId,
              id: `dimension-budget-visit-${index}`,
            })),
          },
        },
      });
    const requests = [
      {
        name: "stored-raw",
        run: (env: Env) =>
          queryDimensionFromD1(
            env,
            siteId,
            window,
            EMPTY_FILTER_DOCUMENT,
            10,
            PAGE_DIMENSION_SELECTIONS.pagePath,
          ),
      },
      {
        name: "derived-traffic-channel",
        run: (env: Env) =>
          queryDimensionFromD1(
            env,
            siteId,
            window,
            EMPTY_FILTER_DOCUMENT,
            10,
            PAGE_DIMENSION_SELECTIONS.trafficChannel,
          ),
      },
      {
        name: "search-cursor-page",
        run: (env: Env) =>
          queryDimensionPageFromD1(
            env,
            siteId,
            window,
            EMPTY_FILTER_DOCUMENT,
            10,
            PAGE_DIMENSION_SELECTIONS.browserEngine,
            { excludeEmpty: true, search: "chrome" },
            { primary: 4, secondary: 2, value: "Chromium" },
          ),
      },
      {
        name: "event-payload-40-independent",
        run: (env: Env) =>
          queryDimensionFromD1(
            env,
            siteId,
            window,
            payloadForty,
            10,
            PAGE_DIMENSION_SELECTIONS.pagePath,
          ),
      },
      {
        name: "prepared-observation",
        run: (env: Env) =>
          queryDimensionFromD1(
            env,
            siteId,
            window,
            prepared.filters!,
            10,
            PAGE_DIMENSION_SELECTIONS.pagePath,
          ),
      },
      {
        name: "advanced-128-visit-ids",
        run: (env: Env) =>
          queryDimensionFromD1(
            env,
            siteId,
            window,
            advanced(128),
            10,
            PAGE_DIMENSION_SELECTIONS.pagePath,
          ),
      },
      {
        name: "advanced-empty-visit-ids",
        run: (env: Env) =>
          queryDimensionFromD1(
            env,
            siteId,
            window,
            advanced(0),
            10,
            PAGE_DIMENSION_SELECTIONS.pagePath,
          ),
      },
    ];
    const metrics: Array<{
      name: string;
      statements: number;
      sqlBytes: number;
      bindings: number;
      hash: string;
    }> = [];
    for (const request of requests) {
      const captured = createD1Env([[]]);
      await request.run(captured.env);
      expect(captured.calls, request.name).toHaveLength(1);
      const call = captured.calls[0]!;
      const sqlBytes = new TextEncoder().encode(call.sql).byteLength;
      expect(sqlBytes, request.name).toBeLessThanOrEqual(100_000);
      expect(call.bindings.length, request.name).toBeLessThanOrEqual(100);
      metrics.push({
        name: request.name,
        statements: captured.calls.length,
        sqlBytes,
        bindings: call.bindings.length,
        hash: createHash("sha256").update(call.sql).digest("hex").slice(0, 16),
      });
    }
    console.info("wave45_dimension_query_budget", JSON.stringify(metrics));
  });

  it("records one-statement Page query size, bind, hash, and query plans", async () => {
    const deepPath = `/${Array.from({ length: 40 }, () => "x").join("/")}`;
    const payload40 = normalizedFilters(
      filterCondition({ kind: "event-payload", path: deepPath }, "value"),
    );
    const payloadMulti = normalizedFilters({
      kind: "and",
      children: Array.from({ length: 6 }, (_, index) =>
        filterCondition(
          { kind: "event-payload", path: `/budget/${index}` },
          `value-${index}`,
        ),
      ),
    });
    const prepared = prepareScopedQuery("pages", {
      context: siteQueryContext(siteId, "private-dashboard"),
      time: createQueryTime(
        window.startMs,
        window.endExclusiveMs,
        "UTC",
        window.nowMs,
      ),
      filters: parseFilterDsl("count(page) gte 1", analyticsFilterRegistry),
      scopePreference: "event",
    } as never) as { filters?: FilterDocument };
    if (!prepared.filters)
      throw new Error("wave43_page_budget_preparation_failed");
    const metadata = scopedFilterMetadata(prepared.filters);
    if (!metadata) throw new Error("wave43_page_budget_metadata_missing");
    const advancedPrepared = (count: number) =>
      attachScopedFilterMetadata(prepared.filters!, {
        ...metadata,
        plan: {
          ...metadata.plan,
          advancedMatches: {
            visitIds: Array.from({ length: count }, (_, index) => ({
              siteId,
              id: `budget-visit-${index}`,
            })),
          },
        },
      });
    const requests = [
      {
        name: "plain",
        run: (env: Env) =>
          queryTopPagesFromD1(
            env,
            siteId,
            window,
            10,
            false,
            EMPTY_FILTER_DOCUMENT,
          ),
      },
      {
        name: "event-payload-40-level",
        run: (env: Env) =>
          queryTopPagesFromD1(env, siteId, window, 10, true, payload40),
      },
      {
        name: "event-payload-multi",
        run: (env: Env) =>
          queryTopPagesFromD1(env, siteId, window, 10, true, payloadMulti),
      },
      {
        name: "advanced-128-visit-ids",
        run: (env: Env) =>
          queryTopPagesFromD1(
            env,
            siteId,
            window,
            10,
            false,
            advancedPrepared(128),
          ),
      },
      {
        name: "advanced-empty-visit-ids",
        run: (env: Env) =>
          queryTopPagesFromD1(
            env,
            siteId,
            window,
            10,
            false,
            advancedPrepared(0),
          ),
      },
      {
        name: "page-cursor",
        run: (env: Env) =>
          queryPagesPageFromD1(
            env,
            siteId,
            window,
            EMPTY_FILTER_DOCUMENT,
            10,
            true,
            {
              views: 3,
              sessions: 2,
              pathname: "/cursor",
              query: "q=1",
              hash: "details",
            },
          ),
      },
    ];
    const databases: DatabaseSync[] = [];

    try {
      const metrics: Array<{
        name: string;
        statements: number;
        sqlBytes: number;
        bindings: number;
        hash: string;
      }> = [];
      const explainCounts: Record<string, number> = {};
      for (const request of requests) {
        const captured = createD1Env([[]]);
        try {
          await request.run(captured.env);
        } catch (error) {
          throw new Error(`wave43_page_budget_compile_failed:${request.name}`, {
            cause: error,
          });
        }
        expect(captured.calls).toHaveLength(1);
        const call = captured.calls[0]!;
        const sqlBytes = new TextEncoder().encode(call.sql).byteLength;
        expect(sqlBytes).toBeLessThanOrEqual(100_000);
        expect(call.bindings.length).toBeLessThanOrEqual(100);
        metrics.push({
          name: request.name,
          statements: captured.calls.length,
          sqlBytes,
          bindings: call.bindings.length,
          hash: createHash("sha256")
            .update(call.sql)
            .digest("hex")
            .slice(0, 16),
        });
        if (
          request.name === "plain" ||
          request.name === "event-payload-multi"
        ) {
          const { database } = createMigratedPagesSqliteEnv();
          databases.push(database);
          const explain = database
            .prepare(`EXPLAIN QUERY PLAN ${call.sql}`)
            .all(...call.bindings) as Array<{ detail?: string }>;
          expect(explain.length).toBeGreaterThan(0);
          explainCounts[request.name] = explain.length;
        }
      }
      console.info("wave43_page_query_budget", JSON.stringify(metrics));
      console.info(
        "wave43_page_query_plan_rows",
        JSON.stringify(explainCounts),
      );
    } finally {
      for (const database of databases) database.close();
    }
  });

  it("keeps the combined page and tabs reader read-only for empty and scoped pages", async () => {
    const empty = createD1Env([[]]);
    await expect(
      queryPagesWithTabsFromD1(
        empty.env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        5,
        false,
      ),
    ).resolves.toEqual({
      pages: {
        items: [],
        pagination: {
          limit: 5,
          returned: 0,
          hasMore: false,
          nextCursor: null,
        },
      },
      tabs: { path: [], title: [], hostname: [], entry: [], exit: [] },
    });
    expect(empty.calls).toHaveLength(1);
    expect(empty.calls[0]?.sql).toContain("filtered_visits AS MATERIALIZED");
    expect(empty.calls[0]?.sql).toContain("'' AS queryValue");
    expect(empty.calls[0]?.sql).toContain("'' AS hashValue");

    const filtered = createD1Env([[]]);
    await queryPagesWithTabsFromD1(
      filtered.env,
      siteId,
      window,
      filterFixture({ browser: "Chrome" }),
      5,
      true,
    );
    expect(filtered.calls[0]?.sql).not.toContain("matched_sessions");

    const prepared = prepareScopedQuery("pages", {
      context: siteQueryContext(siteId, "private-dashboard"),
      time: createQueryTime(
        window.startMs,
        window.endExclusiveMs,
        "UTC",
        window.nowMs,
      ),
      filters: filterFixture({ path: "/docs" }),
      scopePreference: "visitor",
    } as never);
    const scoped = createD1Env([
      [
        {
          rowType: "page",
          pathname: "/docs",
          queryValue: "",
          hashValue: "",
          views: 2,
          sessions: 1,
        },
        {
          rowType: "page",
          pathname: "/other",
          queryValue: "",
          hashValue: "",
          views: 1,
          sessions: 1,
        },
      ],
    ]);
    await expect(
      queryPagesWithTabsFromD1(
        scoped.env,
        siteId,
        window,
        prepared.filters!,
        1,
        false,
        {
          views: 3,
          sessions: 2,
          pathname: "/before",
          query: "",
          hash: "",
        },
      ),
    ).resolves.toMatchObject({
      pages: {
        items: [{ pathname: "/docs" }],
        pagination: { limit: 1, returned: 1, hasMore: true },
      },
    });
    expect(scoped.calls).toHaveLength(1);
    expect(scoped.calls[0]?.sql).toContain("scope_raw_visits AS MATERIALIZED");
    expect(scoped.calls[0]?.bindings.length).toBeGreaterThan(3);
  });

  it("keeps combined pages and tabs results identical to the legacy readers", async () => {
    const { env, database, close } = createScopedOverviewSqliteEnv();
    const insert = database.prepare(`
      INSERT INTO visits (
        visit_id, site_id, visitor_id, session_id, status, started_at,
        last_activity_at, pathname, hostname, title, query_string, hash_fragment
      ) VALUES (?, ?, ?, ?, 'closed', ?, ?, ?, ?, ?, ?, ?)
    `);

    try {
      insert.run(
        "pages-session-1-first",
        siteId,
        "visitor-1",
        "session-1",
        baseMs,
        baseMs,
        "/",
        "example.test",
        "Home",
        "",
        "",
      );
      insert.run(
        "pages-session-1-last",
        siteId,
        "visitor-1",
        "session-1",
        baseMs + 1,
        baseMs + 1,
        "/pricing",
        "example.test",
        "Pricing",
        "",
        "",
      );
      insert.run(
        "pages-session-2",
        siteId,
        "visitor-2",
        "session-2",
        baseMs + 2,
        baseMs + 2,
        "/pricing",
        "example.test",
        "Pricing",
        "",
        "",
      );
      insert.run(
        "pages-outside-window",
        siteId,
        "visitor-outside",
        "session-outside",
        window.endExclusiveMs,
        window.endExclusiveMs,
        "/outside",
        "outside.test",
        "Outside",
        "",
        "",
      );

      const combined = await queryPagesWithTabsFromD1(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        10,
        true,
      );
      const legacyPages = await queryPagesPageFromD1(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        10,
        true,
      );
      const legacyTabs = await queryPageTabsAggregate(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        10,
      );

      expect(combined.pages).toEqual(legacyPages);
      expect(combined.tabs).toEqual(legacyTabs);
      expect(combined.pages.items).toEqual([
        { pathname: "/pricing", query: "", hash: "", views: 2, sessions: 2 },
        { pathname: "/", query: "", hash: "", views: 1, sessions: 1 },
      ]);
      expect(combined.tabs).toMatchObject({
        path: [
          { value: "/pricing", views: 2, sessions: 2, visitors: 2 },
          { value: "/", views: 1, sessions: 1, visitors: 1 },
        ],
        entry: [
          { value: "/", views: 1, sessions: 1, visitors: 1 },
          { value: "/pricing", views: 1, sessions: 1, visitors: 1 },
        ],
        exit: [{ value: "/pricing", views: 2, sessions: 2, visitors: 2 }],
      });
    } finally {
      close();
    }
  });

  it("omits query and hash details when details are disabled", async () => {
    const { env, calls } = createD1Env([[{ pathname: "/docs", views: 3 }]]);

    await expect(
      queryTopPagesFromD1(env, siteId, window, 5, false, EMPTY_FILTER_DOCUMENT),
    ).resolves.toEqual([
      { pathname: "/docs", query: "", hash: "", views: 3, sessions: 0 },
    ]);

    expect(calls[0].sql).toContain("queryValue");
    expect(calls[0].sql).toContain("hashValue");
    expect(calls[0].sql).not.toMatch(/query_string|hash_fragment/u);
    expect(calls[0].bindings.at(-1)).toBe(5);
  });

  it("keeps the combined path tab normalization identical to the legacy reader", async () => {
    const { env, database, close } = createScopedOverviewSqliteEnv();
    const insert = database.prepare(`
      INSERT INTO visits (
        visit_id, site_id, visitor_id, session_id, status, started_at,
        last_activity_at, pathname, hostname, title, query_string, hash_fragment
      ) VALUES (?, ?, ?, ?, 'closed', ?, ?, ?, ?, ?, ?, ?)
    `);

    try {
      insert.run(
        "pages-trimmed-path",
        siteId,
        "visitor-trimmed",
        "session-trimmed",
        baseMs,
        baseMs,
        " /trimmed ",
        "example.test",
        "Trimmed",
        "",
        "",
      );

      const combined = await queryPagesWithTabsFromD1(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        10,
        true,
      );
      const legacy = await queryPageTabsAggregate(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        10,
      );

      expect(combined.tabs).toEqual(legacy);
      expect(combined.tabs.path).toEqual([
        { value: "/trimmed", views: 1, sessions: 1, visitors: 1 },
      ]);
    } finally {
      close();
    }
  });

  it("normalizes sparse rows from the combined pages and tabs reader", async () => {
    const { env } = createD1Env([
      [
        {
          rowType: "page",
          pathname: null,
          queryValue: undefined,
          hashValue: null,
          views: undefined,
          sessions: null,
        },
        {
          rowType: "tab",
          cardType: null,
          value: null,
          views: null,
          sessions: undefined,
          visitors: null,
        },
      ],
    ]);

    await expect(
      queryPagesWithTabsFromD1(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        5,
        false,
      ),
    ).resolves.toEqual({
      pages: {
        items: [{ pathname: "", query: "", hash: "", views: 0, sessions: 0 }],
        pagination: {
          limit: 5,
          returned: 1,
          hasMore: false,
          nextCursor: null,
        },
      },
      tabs: { path: [], title: [], hostname: [], entry: [], exit: [] },
    });
  });

  it("normalizes sparse top page rows", async () => {
    const { env } = createD1Env([
      [
        {
          pathname: null,
          queryValue: undefined,
          hashValue: null,
          views: undefined,
          sessions: null,
        },
      ],
    ]);

    await expect(
      queryTopPagesFromD1(env, siteId, window, 1, true, EMPTY_FILTER_DOCUMENT),
    ).resolves.toEqual([
      { pathname: "", query: "", hash: "", views: 0, sessions: 0 },
    ]);
  });

  it("dedupes page card path filters, applies pagination, and maps aggregate rows", async () => {
    const { env, calls } = createD1Env([
      [
        {
          pathname: "/pricing",
          views: "8",
          sessions: "4",
          visitors: "3",
          bounces: "1",
          totalDuration: "120000",
        },
      ],
    ]);

    await expect(
      queryPageCardMetricsFromD1(
        env,
        siteId,
        window,
        filterFixture({ browser: "Chrome" }),
        {
          pathnames: [" /pricing ", "/pricing", "", "/docs"],
          limit: 10,
          cursor: null,
        },
      ),
    ).resolves.toEqual([
      {
        pathname: "/pricing",
        views: 8,
        sessions: 4,
        visitors: 3,
        bounces: 1,
        totalDuration: 120000,
        durationViews: 0,
      },
    ]);

    expect(calls[0].sql).toContain("path_bounce_rollup AS");
    expect(calls[0].sql).toContain("TRIM(COALESCE(pathname, '')) IN (?, ?)");
    expect(calls[0].sql).toContain("LIMIT ?");
    expect(calls[0].sql).not.toContain("OFFSET");
    expect(calls[0].bindings).toEqual([
      ...visitBindings(),
      "Chrome",
      window.startMs,
      window.endExclusiveMs,
      "Chrome",
      "/pricing",
      "/docs",
      10,
    ]);
  });

  it("maps sparse page card rows without pagination options", async () => {
    const { env, calls } = createD1Env([
      [
        {
          pathname: null,
          views: undefined,
          sessions: null,
          visitors: undefined,
          bounces: null,
          totalDuration: undefined,
          durationViews: null,
        },
      ],
    ]);

    await expect(
      queryPageCardMetricsFromD1(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        undefined,
      ),
    ).resolves.toEqual([
      {
        pathname: "",
        views: 0,
        sessions: 0,
        visitors: 0,
        bounces: 0,
        totalDuration: 0,
        durationViews: 0,
      },
    ]);
    expect(calls[0].sql).not.toContain("LIMIT ? OFFSET ?");
    expect(calls[0].bindings).toEqual(visitBindings());
  });

  it("materializes page-card visits once while preserving path-level bounces", async () => {
    const database = new DatabaseSync(":memory:");
    for (const migration of [
      "migrations/0008_rebuild_analytics.sql",
      "migrations/0013_add_visit_performance_metrics.sql",
      "migrations/0019_add_user_identity.sql",
    ]) {
      database.exec(readFileSync(migration, "utf8"));
    }
    installVisitSiteIdentityFixture(database);
    installDirectEventFilterTables(database);
    const calls: QueryCall[] = [];
    const env = {
      DB: {
        prepare: (sql: string) => ({
          bind: (...bindings: QueryBinding[]) => {
            const call = { sql, bindings };
            calls.push(call);
            return {
              all: async () => ({
                results: database.prepare(sql).all(...bindings) as D1Row[],
              }),
            };
          },
        }),
      } as unknown as D1Database,
    } as Env;
    const insert = database.prepare(`
      INSERT INTO visits (
        visit_id, site_id, visitor_id, session_id, status, started_at,
        last_activity_at, pathname, hostname, duration_ms
      ) VALUES (?, ?, ?, ?, 'closed', ?, ?, ?, 'example.test', ?)
    `);

    try {
      insert.run(
        "root-first",
        siteId,
        "visitor-1",
        "session-1",
        baseMs,
        baseMs,
        "/",
        100,
      );
      insert.run(
        "root-last",
        siteId,
        "visitor-1",
        "session-1",
        baseMs + 1,
        baseMs + 1,
        "/",
        200,
      );
      insert.run(
        "pricing-first",
        siteId,
        "visitor-1",
        "session-2",
        baseMs + 2,
        baseMs + 2,
        "/pricing",
        50,
      );
      insert.run(
        "pricing-second",
        siteId,
        "visitor-2",
        "session-3",
        baseMs + 3,
        baseMs + 3,
        "/pricing",
        null,
      );
      insert.run(
        "outside-window",
        siteId,
        "visitor-3",
        "session-4",
        window.endExclusiveMs,
        window.endExclusiveMs,
        "/pricing",
        999,
      );

      await expect(
        queryPageCardMetricsFromD1(
          env,
          siteId,
          window,
          EMPTY_FILTER_DOCUMENT,
          undefined,
        ),
      ).resolves.toEqual([
        {
          pathname: "/pricing",
          views: 2,
          sessions: 2,
          visitors: 2,
          bounces: 2,
          totalDuration: 50,
          durationViews: 0,
        },
        {
          pathname: "/",
          views: 2,
          sessions: 1,
          visitors: 1,
          bounces: 0,
          totalDuration: 300,
          durationViews: 0,
        },
      ]);

      expect(calls).toHaveLength(1);
      expect(calls[0]?.sql).toContain("filtered_visits AS MATERIALIZED");
      const plan = database
        .prepare(`EXPLAIN QUERY PLAN ${calls[0]?.sql ?? "SELECT 1"}`)
        .all(...(calls[0]?.bindings ?? [])) as Array<{ detail: string }>;
      expect(
        plan.filter((row) => row.detail.includes("SEARCH visits USING INDEX")),
      ).toHaveLength(1);
      expect(
        plan.some((row) =>
          row.detail.includes("idx_visits_site_pk_started_at"),
        ),
      ).toBe(true);
    } finally {
      database.close();
    }
  });

  it("returns empty title and trend queries without touching D1 when pathnames are empty", async () => {
    const { env, prepare } = createD1Env([]);

    await expect(
      queryPageCardTitlesFromD1(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        ["", "  "],
        3,
      ),
    ).resolves.toEqual([]);
    await expect(
      queryPageCardTrendFromD1(
        env,
        siteId,
        window,
        "hour",
        EMPTY_FILTER_DOCUMENT,
        [],
      ),
    ).resolves.toEqual([]);

    expect(prepare).not.toHaveBeenCalled();
  });

  it("maps page card titles and hourly trend buckets with path filters", async () => {
    const { env, calls } = createD1Env([
      [
        { pathname: "/pricing", title: "Pricing", views: "6" },
        { pathname: "/pricing", title: "Plans", views: 2 },
      ],
      [
        { pathname: "/pricing", bucket: "0", views: "3", visitors: "2" },
        { pathname: "/pricing", bucket: 1, views: 5, visitors: 4 },
      ],
    ]);

    await expect(
      queryPageCardTitlesFromD1(
        env,
        siteId,
        window,
        filterFixture({ clientDeviceType: "desktop" }),
        ["/pricing"],
        2,
      ),
    ).resolves.toEqual([
      { pathname: "/pricing", title: "Pricing", views: 6 },
      { pathname: "/pricing", title: "Plans", views: 2 },
    ]);
    await expect(
      queryPageCardTrendFromD1(
        env,
        siteId,
        window,
        "hour",
        filterFixture({ clientDeviceType: "desktop" }),
        ["/pricing"],
      ),
    ).resolves.toEqual([
      {
        pathname: "/pricing",
        bucket: 0,
        timestampMs: Date.UTC(2026, 0, 2, 1),
        views: 3,
        visitors: 2,
      },
      {
        pathname: "/pricing",
        bucket: 1,
        timestampMs: Date.UTC(2026, 0, 2, 2),
        views: 5,
        visitors: 4,
      },
    ]);

    expect(calls[0].bindings).toEqual([
      ...visitBindings(),
      "desktop",
      window.startMs,
      window.endExclusiveMs,
      "desktop",
      "/pricing",
      2,
    ]);
    expect(calls[1].sql).toContain("CASE WHEN startedAt >=");
    expect(calls[1].bindings).toEqual([
      ...visitBindings(),
      "desktop",
      window.startMs,
      window.endExclusiveMs,
      "desktop",
      "/pricing",
    ]);
  });

  it("normalizes sparse page card title and trend rows", async () => {
    const { env } = createD1Env([
      [
        {
          pathname: null,
          title: undefined,
          views: null,
        },
      ],
      [
        {
          pathname: null,
          bucket: null,
          views: undefined,
          visitors: null,
        },
      ],
    ]);

    await expect(
      queryPageCardTitlesFromD1(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        ["/pricing"],
        3,
      ),
    ).resolves.toEqual([{ pathname: "", title: "", views: 0 }]);
    await expect(
      queryPageCardTrendFromD1(
        env,
        siteId,
        window,
        "hour",
        EMPTY_FILTER_DOCUMENT,
        ["/pricing"],
      ),
    ).resolves.toEqual([
      {
        pathname: "",
        bucket: 0,
        timestampMs: Date.UTC(2026, 0, 2, 1),
        views: 0,
        visitors: 0,
      },
    ]);
  });

  it("uses final scoped dataset bindings for page card queries", async () => {
    const { env, calls } = createD1Env([
      [{ pathname: "/pricing", title: "Pricing", views: 3 }],
      [{ pathname: "/pricing", bucket: 0, views: 2, visitors: 1 }],
    ]);
    const prepared = prepareScopedQuery("pages", {
      context: siteQueryContext("site-pages", "private-dashboard"),
      time: createQueryTime(
        window.startMs,
        window.endExclusiveMs,
        "UTC",
        window.nowMs,
      ),
      filters: filterFixture({ path: "/pricing" }),
      scopePreference: "visitor",
    } as never);

    await queryPageCardTitlesFromD1(
      env,
      siteId,
      window,
      prepared.filters!,
      ["/pricing"],
      3,
    );
    await queryPageCardTrendFromD1(
      env,
      siteId,
      window,
      "hour",
      prepared.filters!,
      ["/pricing"],
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]?.bindings.length).toBeGreaterThan(3);
    expect(calls[1]?.bindings.length).toBeGreaterThan(3);
    expect(calls[0]?.sql).toContain("scope_final_visits");
    expect(calls[1]?.sql).toContain("scope_final_visits");
  });

  it("uses prepared scoped datasets for top pages and dashboard comparisons", async () => {
    const prepared = prepareScopedQuery("pages", {
      context: siteQueryContext("site-pages", "private-dashboard"),
      time: createQueryTime(
        window.startMs,
        window.endExclusiveMs,
        "UTC",
        window.nowMs,
      ),
      filters: filterFixture({ path: "/pricing" }),
      scopePreference: "visitor",
    } as never);

    const topPages = createD1Env([[]]);
    await queryTopPagesFromD1(
      topPages.env,
      siteId,
      window,
      3,
      false,
      prepared.filters!,
    );
    expect(topPages.calls).toHaveLength(1);
    expect(topPages.calls[0]?.sql).toContain("GROUP BY");
    expect(topPages.calls[0]?.bindings).toContain("/pricing");

    const dashboard = createD1Env([
      [
        {
          pathname: "/pricing",
          current_views: 4,
          current_sessions: 2,
          current_visitors: 2,
          current_bounces: 1,
          current_total_duration: 2000,
          current_duration_views: 0,
          reference_views: 2,
          reference_sessions: 1,
          reference_visitors: 1,
          reference_bounces: 1,
          reference_total_duration: 1000,
          reference_duration_views: 0,
        },
      ],
      [],
    ]);
    await queryPagesDashboard(dashboard.env, siteId, {
      window,
      filters: prepared.filters!,
      interval: "day",
      page: { limit: 1, cursor: null },
      comparison: {
        current: {
          time: createQueryTime(
            window.startMs,
            window.endExclusiveMs,
            "UTC",
            window.nowMs,
          ),
          filters: prepared.filters!,
        },
        reference: {
          time: createQueryTime(
            window.startMs - 2 * 60 * 60 * 1000,
            window.startMs,
            "UTC",
            window.nowMs,
          ),
          filters: prepared.filters!,
        },
        metric: "views",
        sortBy: "current",
        direction: "desc",
      },
    });
    expect(dashboard.calls[0]?.sql).toContain("current_scope_final_visits");
  });
});
describe("edge paginated page and referrer readers", () => {
  it("returns a signed page cursor and accepts it on the next request", async () => {
    const filters = EMPTY_FILTER_DOCUMENT;
    const first = createD1Env([
      [
        { pathname: "/", queryValue: "", hashValue: "", views: 8, sessions: 5 },
        {
          pathname: "/docs",
          queryValue: "lang=en",
          hashValue: "intro",
          views: 6,
          sessions: 4,
        },
        {
          pathname: "/pricing",
          queryValue: "",
          hashValue: "",
          views: 4,
          sessions: 3,
        },
      ],
    ]);
    const firstPage = await queryPagesPageFromD1(
      first.env,
      siteId,
      window,
      filters,
      2,
      true,
    );

    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.pagination).toMatchObject({
      limit: 2,
      returned: 2,
      hasMore: true,
      nextCursor: expect.any(String),
    });
    expect(first.calls[0].bindings.at(-1)).toBe(3);

    const decoded = await decodePagesCursor(
      first.env,
      siteId,
      window,
      filters,
      true,
      firstPage.pagination.nextCursor,
    );
    expect(decoded).toEqual({
      views: 6,
      sessions: 4,
      pathname: "/docs",
      query: "lang=en",
      hash: "intro",
    });

    const second = createD1Env([
      [
        {
          pathname: "/pricing",
          queryValue: "",
          hashValue: "",
          views: 4,
          sessions: 3,
        },
      ],
    ]);
    await expect(
      queryPagesPageFromD1(
        second.env,
        siteId,
        window,
        filters,
        2,
        true,
        decoded,
        "public-share",
      ),
    ).resolves.toMatchObject({
      items: [{ pathname: "/pricing", views: 4 }],
      pagination: { hasMore: false, nextCursor: null },
    });
    expect(second.calls[0].sql).toContain("queryValue");
    expect(second.calls[0].bindings).toContain(6);
    expect(second.calls[0].bindings.at(-1)).toBe(3);
  });

  it("paginates referrers with search, alternate sorting, and full URLs", async () => {
    const filters = EMPTY_FILTER_DOCUMENT;
    const first = createD1Env([
      [
        { referrer: "google.com", views: 10, sessions: 7, visitors: 6 },
        { referrer: "news.example", views: 8, sessions: 5, visitors: 4 },
      ],
    ]);
    const firstPage = await queryReferrersPageFromD1(
      first.env,
      siteId,
      window,
      filters,
      1,
      true,
      " News ",
      null,
      undefined,
      "public-share",
      "visitors",
      "asc",
    );

    expect(firstPage.items).toEqual([
      { referrer: "google.com", views: 10, sessions: 7, visitors: 6 },
    ]);
    expect(firstPage.pagination).toMatchObject({
      hasMore: true,
      nextCursor: expect.any(String),
    });
    expect(first.calls[0].sql).toContain("referrer_url");
    expect(first.calls[0].sql).toContain("LOWER(COALESCE(");
    expect(first.calls[0].sql).toContain("LIKE ? ESCAPE ?");

    const cursor = await decodeReferrersCursor(
      first.env,
      siteId,
      window,
      filters,
      true,
      " News ",
      firstPage.pagination.nextCursor,
      "public-share",
      "visitors",
      "asc",
    );
    expect(cursor).toEqual({
      primary: 6,
      secondary: 10,
      referrer: "google.com",
    });

    const second = createD1Env([
      [{ referrer: "news.example", views: 8, sessions: 5, visitors: 4 }],
    ]);
    await expect(
      queryReferrersPageFromD1(
        second.env,
        siteId,
        window,
        filters,
        2,
        false,
        undefined,
        cursor,
        undefined,
        "private-dashboard",
        "views",
        "desc",
      ),
    ).resolves.toMatchObject({
      items: [{ referrer: "news.example" }],
      pagination: { hasMore: false },
    });
    expect(second.calls[0].sql).toContain("referrer_host");
    expect(second.calls[0].bindings).toContain(10);
  });

  it("keeps referrer totals independent from the top-N source list", async () => {
    const { env, calls } = createD1Env([
      [
        {
          rowType: "summary",
          referrer: "",
          totalViews: 20,
          directViews: 5,
          externalViews: 15,
          uniqueDomains: 3,
          uniqueLinks: 4,
        },
        { rowType: "top", referrer: "google.com", views: 10, rowRank: 1 },
        { rowType: "top", referrer: "news.example", views: 8, rowRank: 2 },
      ],
    ]);

    await expect(
      queryReferrerSummaryFromD1(env, siteId, window, EMPTY_FILTER_DOCUMENT, 1),
    ).resolves.toEqual({
      totalViews: 20,
      directViews: 5,
      externalViews: 15,
      uniqueDomains: 3,
      uniqueLinks: 4,
      truncated: true,
      topSources: [{ referrer: "google.com", views: 10 }],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].bindings.at(-1)).toBe(2);

    const empty = createD1Env([[]]);
    await expect(
      queryReferrerSummaryFromD1(
        empty.env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        5,
      ),
    ).resolves.toMatchObject({
      totalViews: 0,
      topSources: [],
      truncated: false,
    });
  });

  it("matches the frozen referrer summary for 40 independent Event payload predicates", async () => {
    const { env: baseEnv, database, close } = createMigratedPagesSqliteEnv();
    const matchingVisitId = "summary-payload-match";
    insertPageRow(database, {
      visitId: matchingVisitId,
      visitorId: "summary-payload-visitor",
      sessionId: "summary-payload-session",
      pathname: "/summary-match",
      country: "US",
    });
    insertPageRow(database, {
      visitId: "summary-payload-no-match",
      visitorId: "summary-no-match-visitor",
      sessionId: "summary-no-match-session",
      pathname: "/summary-no-match",
      country: "CA",
    });
    database
      .prepare(
        "UPDATE visits SET referrer_host = ?, referrer_url = ? WHERE visit_id = ?",
      )
      .run(" google.com ", " https://google.com/plan ", matchingVisitId);
    database
      .prepare(
        "UPDATE visits SET referrer_host = ?, referrer_url = ? WHERE visit_id = ?",
      )
      .run(
        "news.example",
        "https://news.example/other",
        "summary-payload-no-match",
      );
    const siteIdentity = database
      .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
      .get(siteId) as { site_pk: number };
    database
      .prepare(
        "INSERT INTO custom_event_names (id, site_id, name, last_seen_at, site_pk) VALUES (?, ?, ?, ?, ?)",
      )
      .run(71, siteId, "payload", baseMs, siteIdentity.site_pk);
    const paths = Array.from({ length: 40 }, (_, index) => ({
      id: 700 + index,
      path: `/summary-payload/${index}`,
      eventPk: 800 + index,
    }));
    const addPath = database.prepare(
      "INSERT INTO custom_event_json_paths (id, site_id, path, last_seen_at, site_pk) VALUES (?, ?, ?, ?, ?)",
    );
    const addEvent = database.prepare(`
      INSERT INTO custom_events (
        event_pk, event_id, site_id, visit_id, event_name_id, occurred_at,
        received_at, sequence, node_count, value_count, site_pk
      ) VALUES (?, ?, ?, ?, 71, ?, ?, 1, 1, 1, ?)
    `);
    const addNode = database.prepare(`
      INSERT INTO custom_event_json_nodes (
        event_pk, node_id, parent_node_id, key_id, path_id, value_type,
        member_order, array_index, depth
      ) VALUES (?, 1, NULL, NULL, ?, 1, NULL, NULL, 1)
    `);
    const addValue = database.prepare(`
      INSERT INTO custom_event_json_values (
        event_pk, node_id, site_id, event_name_id, path_id, occurred_at,
        value_type, string_value, number_value, boolean_value, site_pk
      ) VALUES (?, 1, ?, 71, ?, ?, 1, 'match', NULL, NULL, ?)
    `);
    for (const path of paths) {
      addPath.run(path.id, siteId, path.path, baseMs, siteIdentity.site_pk);
      addEvent.run(
        path.eventPk,
        `summary-payload-${path.eventPk}`,
        siteId,
        matchingVisitId,
        baseMs + 10,
        baseMs + 10,
        siteIdentity.site_pk,
      );
      addNode.run(path.eventPk, path.id);
      addValue.run(
        path.eventPk,
        siteId,
        path.id,
        baseMs + 10,
        siteIdentity.site_pk,
      );
    }
    const filters = normalizedFilters({
      kind: "and",
      children: paths.map(
        (path) =>
          ({
            kind: "condition",
            target: { kind: "event-payload", path: path.path },
            operator: "exists",
          }) as const,
      ),
    });
    const dataset = scopedDatasetFor(siteId, window, filters);
    const filter = dataset
      ? null
      : buildVisitFilterSql(filters, "visit_source", { window });
    const source = dataset?.visitRelation ?? "visit_source";
    const ctes = dataset?.ctes ?? buildVisitSourceCte();
    const bindings = dataset
      ? dataset.bindings.map((binding) => binding.value)
      : [...visitSourceBindings(siteId, window), ...(filter?.bindings ?? [])];
    const filterClause = filter?.clause ?? "";
    const summary = database
      .prepare(
        `
        WITH ${ctes}, filtered AS (SELECT * FROM ${source} ${filterClause})
        SELECT
          count(*) AS totalViews,
          sum(CASE WHEN TRIM(COALESCE(referrer_host, '')) = '' THEN 1 ELSE 0 END) AS directViews,
          sum(CASE WHEN TRIM(COALESCE(referrer_host, '')) != '' THEN 1 ELSE 0 END) AS externalViews,
          count(DISTINCT NULLIF(TRIM(COALESCE(referrer_host, '')), '')) AS uniqueDomains,
          count(DISTINCT NULLIF(TRIM(COALESCE(referrer_url, '')), '')) AS uniqueLinks
        FROM filtered
      `,
      )
      .get(...bindings) as D1Row;
    const topRows = database
      .prepare(
        `
        WITH ${ctes}, filtered AS (SELECT * FROM ${source} ${filterClause})
        SELECT TRIM(COALESCE(referrer_host, '')) AS referrer, count(*) AS views
        FROM filtered
        WHERE TRIM(COALESCE(referrer_host, '')) != ''
        GROUP BY referrer
        ORDER BY views DESC, referrer ASC
        LIMIT 11
      `,
      )
      .all(...bindings) as D1Row[];
    const legacyResult = {
      totalViews: Number(summary.totalViews ?? 0),
      directViews: Number(summary.directViews ?? 0),
      externalViews: Number(summary.externalViews ?? 0),
      uniqueDomains: Number(summary.uniqueDomains ?? 0),
      uniqueLinks: Number(summary.uniqueLinks ?? 0),
      truncated: topRows.length > 10,
      topSources: topRows.slice(0, 10).map((row) => ({
        referrer: String(row.referrer ?? ""),
        views: Number(row.views ?? 0),
      })),
    };
    const calls: QueryCall[] = [];
    const env = {
      ...baseEnv,
      DB: {
        prepare(sql: string) {
          return {
            bind(...queryBindings: QueryBinding[]) {
              return {
                async all() {
                  calls.push({ sql, bindings: queryBindings });
                  return {
                    results: database
                      .prepare(sql)
                      .all(...queryBindings) as D1Row[],
                  };
                },
              };
            },
          };
        },
      } as unknown as D1Database,
    } as Env;
    try {
      await expect(
        queryReferrerSummaryFromD1(env, siteId, window, filters, 10),
      ).resolves.toEqual(legacyResult);
      expect(calls).toHaveLength(1);
      expect(
        new TextEncoder().encode(calls[0]!.sql).byteLength,
      ).toBeLessThanOrEqual(100_000);
      expect(calls[0]!.bindings.length).toBeLessThanOrEqual(100);
      console.info(
        "wave45_referrer_summary_40_payload_budget",
        JSON.stringify({
          statements: calls.length,
          sqlBytes: new TextEncoder().encode(calls[0]!.sql).byteLength,
          bindings: calls[0]!.bindings.length,
          hash: createHash("sha256")
            .update(calls[0]!.sql)
            .digest("hex")
            .slice(0, 16),
        }),
      );
    } finally {
      close();
    }
  });

  it("returns an empty dashboard page without loading comparison details", async () => {
    const { env, calls } = createD1Env([[]]);
    await expect(
      queryPagesDashboard(env, siteId, {
        window,
        filters: EMPTY_FILTER_DOCUMENT,
        interval: "day",
        page: { limit: 3, cursor: null },
      }),
    ).resolves.toMatchObject({
      items: [],
      pagination: { limit: 3, returned: 0, hasMore: false, nextCursor: null },
    });
    expect(calls).toHaveLength(1);
  });

  it("keeps the legacy aggregate wrappers and enriches non-empty dashboard pages", async () => {
    const pageRow = {
      pathname: "/docs",
      queryValue: "",
      hashValue: "",
      views: 4,
      sessions: 3,
    };
    await expect(
      queryPagesFromD1(
        createD1Env([[pageRow]]).env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        10,
        false,
      ),
    ).resolves.toEqual([
      { pathname: "/docs", query: "", hash: "", views: 4, sessions: 3 },
    ]);
    await expect(
      queryPagesAggregate(
        createD1Env([[pageRow]]).env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        10,
        false,
      ),
    ).resolves.toHaveLength(1);
    await expect(
      queryPageTabsAggregate(
        createD1Env([
          [{ cardType: "path", value: "/docs", views: 4, sessions: 2 }],
        ]).env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        10,
      ),
    ).resolves.toMatchObject({
      path: [{ value: "/docs", views: 4, sessions: 2 }],
    });
    await expect(
      queryReferrerAggregate(
        createD1Env([[{ referrer: "google.com", views: 4, sessions: 2 }]]).env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        10,
        false,
      ),
    ).resolves.toEqual([
      { referrer: "google.com", views: 4, sessions: 2, visitors: 0 },
    ]);
    await expect(
      queryTopReferrersFromD1(
        createD1Env([[{ referrer: "news.example", views: 3, sessions: 2 }]])
          .env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        10,
        false,
      ),
    ).resolves.toEqual([
      { referrer: "news.example", views: 3, sessions: 2, visitors: 0 },
    ]);

    const dashboard = createD1Env([
      [
        {
          pathname: "/docs",
          views: 10,
          sessions: 5,
          visitors: 4,
          bounces: 1,
          totalDuration: 5_000,
          durationViews: 4,
        },
      ],
      [
        {
          pathname: "/docs",
          views: 8,
          sessions: 4,
          visitors: 3,
          bounces: 2,
          totalDuration: 4_000,
          durationViews: 3,
        },
      ],
      [
        {
          rowKind: "title",
          pathname: "/docs",
          title: "Docs",
          views: 5,
          rowOrder: 1,
        },
        {
          rowKind: "title",
          pathname: "/docs",
          title: "Docs",
          views: 4,
          rowOrder: 2,
        },
        {
          rowKind: "title",
          pathname: "/docs",
          title: "Reference",
          views: 3,
          rowOrder: 3,
        },
        {
          rowKind: "title",
          pathname: "/docs",
          title: "",
          views: 2,
          rowOrder: 4,
        },
        {
          rowKind: "trend",
          pathname: "/docs",
          bucket: 0,
          views: 5,
          visitors: 3,
          rowOrder: 0,
        },
        {
          rowKind: "other",
          pathname: "/docs",
          bucket: 1,
          views: 1,
          visitors: 1,
          rowOrder: 1,
        },
      ],
    ]);
    await expect(
      queryPagesDashboard(dashboard.env, siteId, {
        window,
        filters: EMPTY_FILTER_DOCUMENT,
        interval: "day",
        page: { limit: 3, cursor: null },
      }),
    ).resolves.toMatchObject({
      items: [
        {
          pathname: "/docs",
          titles: ["Docs", "Reference"],
          trend: [{ views: 5, visitors: 3 }],
        },
      ],
      pagination: { limit: 3, returned: 1, hasMore: false, nextCursor: null },
    });
    expect(dashboard.calls).toHaveLength(3);
  });

  it("decodes a dashboard cursor before loading the next page", async () => {
    const rows = (pathname: string, views: number, sessions: number) => ({
      pathname,
      views,
      sessions,
      visitors: views,
      bounces: 0,
      totalDuration: 1_000,
      durationViews: 1,
    });
    const first = createD1Env([
      [rows("/first", 10, 5), rows("/second", 8, 4)],
      [],
      [],
    ]);
    const firstPage = await queryPagesDashboard(first.env, siteId, {
      window,
      filters: EMPTY_FILTER_DOCUMENT,
      interval: "day",
      page: { limit: 1, cursor: null },
    });
    expect(firstPage.pagination.nextCursor).toEqual(expect.any(String));

    const second = createD1Env([[rows("/second", 8, 4)], [], []]);
    await expect(
      queryPagesDashboard(second.env, siteId, {
        window,
        filters: EMPTY_FILTER_DOCUMENT,
        interval: "day",
        page: { limit: 1, cursor: firstPage.pagination.nextCursor },
      }),
    ).resolves.toMatchObject({
      items: [{ pathname: "/second" }],
      pagination: { hasMore: false, nextCursor: null },
    });
    expect(second.calls[0].sql).toContain("pathname > ?");
  });

  it("aggregates current and comparison page rows in one dashboard request", async () => {
    const comparison = {
      current: {
        time: createQueryTime(
          window.startMs,
          window.endExclusiveMs,
          window.timeZone,
          window.nowMs,
        ),
        filters: EMPTY_FILTER_DOCUMENT,
      },
      reference: {
        time: createQueryTime(
          window.startMs - 2 * 60 * 60 * 1000,
          window.startMs,
          window.timeZone,
          window.nowMs,
        ),
        filters: EMPTY_FILTER_DOCUMENT,
      },
      metric: "views" as const,
      sortBy: "current" as const,
      direction: "desc" as const,
    };
    const rows = (
      pathname: string,
      currentViews: number,
      referenceViews: number,
    ) => ({
      pathname,
      current_views: currentViews,
      current_sessions: 2,
      current_visitors: 2,
      current_bounces: 1,
      current_total_duration: 4_000,
      current_duration_views: 0,
      reference_views: referenceViews,
      reference_sessions: 1,
      reference_visitors: 1,
      reference_bounces: 1,
      reference_total_duration: 2_000,
      reference_duration_views: 0,
    });
    const first = createD1Env([
      [rows("/current", 10, 5), rows("/next", 8, 4)],
      [
        {
          rowKind: "title",
          pathname: "/current",
          title: "Current",
          views: 3,
          rowOrder: 1,
        },
      ],
    ]);
    const firstPage = await queryPagesDashboard(first.env, siteId, {
      window,
      filters: EMPTY_FILTER_DOCUMENT,
      interval: "day",
      page: { limit: 1, cursor: null },
      comparison,
    });
    expect(firstPage.items[0]).toMatchObject({
      pathname: "/current",
      metrics: { views: 10, sessions: 2 },
      reference: { views: 5, sessions: 1 },
      change: {
        views: { absolute: 5, relative: 100 },
      },
    });
    expect(firstPage.pagination).toMatchObject({
      hasMore: true,
      nextCursor: expect.any(String),
    });

    const second = createD1Env([[rows("/next", 8, 4)], []]);
    await expect(
      queryPagesDashboard(second.env, siteId, {
        window,
        filters: EMPTY_FILTER_DOCUMENT,
        interval: "day",
        page: { limit: 1, cursor: firstPage.pagination.nextCursor },
        comparison,
      }),
    ).resolves.toMatchObject({
      items: [{ pathname: "/next" }],
      pagination: { hasMore: false, nextCursor: null },
    });
    expect(first.calls[0].sql).toContain("current_metrics");
    expect(first.calls[0].sql).toContain("reference_metrics");
    expect(second.calls[0].sql).toContain("change_relative");

    const changeComparison = { ...comparison, sortBy: "change" as const };
    const changeFirst = createD1Env([
      [rows("/a", 10, 5), rows("/b", 8, 4)],
      [],
    ]);
    const changeFirstPage = await queryPagesDashboard(changeFirst.env, siteId, {
      window,
      filters: EMPTY_FILTER_DOCUMENT,
      interval: "day",
      page: { limit: 1, cursor: null },
      comparison: changeComparison,
    });
    const changeSecond = createD1Env([[rows("/b", 8, 4)], []]);
    await expect(
      queryPagesDashboard(changeSecond.env, siteId, {
        window,
        filters: EMPTY_FILTER_DOCUMENT,
        interval: "day",
        page: {
          limit: 1,
          cursor: changeFirstPage.pagination.nextCursor,
        },
        comparison: changeComparison,
      }),
    ).resolves.toMatchObject({ items: [{ pathname: "/b" }] });
    expect(changeSecond.calls[0].sql).toContain("change_class");
  });

  it("supports page dashboard metric and comparison ordering variants", async () => {
    const comparisonBase = {
      current: {
        time: createQueryTime(
          window.startMs,
          window.endExclusiveMs,
          window.timeZone,
          window.nowMs,
        ),
        filters: EMPTY_FILTER_DOCUMENT,
      },
      reference: {
        time: createQueryTime(
          window.startMs - 2 * 60 * 60 * 1000,
          window.startMs,
          window.timeZone,
          window.nowMs,
        ),
        filters: EMPTY_FILTER_DOCUMENT,
      },
      direction: "asc" as const,
    };
    const row = {
      pathname: "/docs",
      current_views: 10,
      current_sessions: 5,
      current_visitors: 4,
      current_bounces: 1,
      current_total_duration: 5_000,
      current_duration_views: 0,
      reference_views: 8,
      reference_sessions: 4,
      reference_visitors: 3,
      reference_bounces: 2,
      reference_total_duration: 4_000,
      reference_duration_views: 0,
    };
    for (const metric of [
      "views",
      "visitors",
      "sessions",
      "bounceRate",
      "pagesPerSession",
      "avgDurationMs",
    ] as const) {
      for (const sortBy of ["current", "reference", "change"] as const) {
        const { env } = createD1Env([[row], []]);
        await queryPagesDashboard(env, siteId, {
          window,
          filters: EMPTY_FILTER_DOCUMENT,
          interval: "day",
          search: "docs",
          page: { limit: 1, cursor: null },
          comparison: { ...comparisonBase, metric, sortBy },
        });
      }
    }
    const normalRow = {
      pathname: "/docs",
      views: 3,
      sessions: 2,
      visitors: 2,
      bounces: 1,
      totalDuration: 1_000,
    };
    for (const key of [
      "views",
      "visitors",
      "sessions",
      "bounceRate",
      "pagesPerSession",
      "avgDurationMs",
    ] as const) {
      const cursorRow =
        key === "pagesPerSession" || key === "avgDurationMs"
          ? { ...normalRow, sessions: 0 }
          : normalRow;
      const normal = createD1Env([
        [cursorRow, { ...normalRow, pathname: "/next", views: 2 }],
        [],
        [],
      ]);
      await queryPagesDashboard(normal.env, siteId, {
        window,
        filters: EMPTY_FILTER_DOCUMENT,
        interval: "day",
        search: "docs",
        sort: { key, direction: "asc" },
        page: { limit: 1, cursor: null },
      });
      expect(normal.calls[0].sql).toContain("LOWER(pr.pathname) LIKE");
      expect(normal.calls[0].sql).toContain(`ORDER BY pr.${key} asc`);
    }
  });
});
describe("edge pages handlers", () => {
  it("maps pages and all tabs from D1 when includeTabs is enabled", async () => {
    const { env, calls } = createD1Env([
      [
        {
          rowType: "page",
          pathname: "/home",
          queryValue: "x=1",
          hashValue: "",
          views: 7,
          sessions: 2,
          rowRank: 1,
        },
        {
          rowType: "tab",
          cardType: "path",
          value: "/home",
          views: 2,
          sessions: 2,
          visitors: 2,
          rowRank: 1,
        },
        {
          rowType: "tab",
          cardType: "path",
          value: "/pricing",
          views: 1,
          sessions: 1,
          visitors: 1,
          rowRank: 2,
        },
        {
          rowType: "tab",
          cardType: "title",
          value: "Home",
          views: 2,
          sessions: 2,
          visitors: 2,
          rowRank: 1,
        },
        {
          rowType: "tab",
          cardType: "title",
          value: "Pricing",
          views: 1,
          sessions: 1,
          visitors: 1,
          rowRank: 2,
        },
        {
          rowType: "tab",
          cardType: "hostname",
          value: "example.com",
          views: 3,
          sessions: 2,
          visitors: 2,
          rowRank: 1,
        },
        {
          rowType: "tab",
          cardType: "entry",
          value: "/home",
          views: 2,
          sessions: 2,
          visitors: 2,
          rowRank: 1,
        },
        {
          rowType: "tab",
          cardType: "exit",
          value: "/home",
          views: 1,
          sessions: 1,
          visitors: 1,
          rowRank: 1,
        },
        {
          rowType: "tab",
          cardType: "exit",
          value: "/pricing",
          views: 1,
          sessions: 1,
          visitors: 1,
          rowRank: 2,
        },
      ],
    ]);

    const response = await handlePages(
      env,
      siteId,
      url("/pages", {
        from: window.startMs,
        to: window.endExclusiveMs,
        details: true,
        "filter[geo.country]": "US",
        limit: 5,
      }),
      true,
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: {
        items: [
          {
            pathname: "/home",
            query: "x=1",
            hash: "",
            views: 7,
            sessions: 2,
          },
        ],
        pagination: {
          limit: 5,
          returned: 1,
          hasMore: false,
          nextCursor: null,
        },
      },
      tabs: {
        path: [
          { label: "/home", views: 2, sessions: 2, visitors: 2 },
          { label: "/pricing", views: 1, sessions: 1, visitors: 1 },
        ],
        title: [
          { label: "Home", views: 2, sessions: 2, visitors: 2 },
          { label: "Pricing", views: 1, sessions: 1, visitors: 1 },
        ],
        hostname: [
          { label: "example.com", views: 3, sessions: 2, visitors: 2 },
        ],
        entry: [{ label: "/home", views: 2, sessions: 2, visitors: 2 }],
        exit: [
          { label: "/home", views: 1, sessions: 1, visitors: 1 },
          { label: "/pricing", views: 1, sessions: 1, visitors: 1 },
        ],
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].bindings).toContain("us");
    expect(calls[0].bindings.slice(-2)).toEqual([6, 5]);
    expect(calls[0].sql).toContain("ranked_cards AS");
  });

  it("maps referrer handler rows with full URL mode and filters", async () => {
    const { env, calls } = createD1Env([
      [
        {
          referrer: "https://news.example/post",
          views: "6",
          sessions: "3",
          visitors: "2",
        },
      ],
    ]);

    const response = await handleReferrers(
      env,
      siteId,
      url("/referrers", {
        from: window.startMs,
        to: window.endExclusiveMs,
        fullUrl: true,
        "filter[client.browser]": "Chrome",
        limit: 7,
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: {
        items: [
          {
            referrer: "https://news.example/post",
            views: 6,
            sessions: 3,
          },
        ],
        pagination: {
          limit: 7,
          returned: 1,
          hasMore: false,
          nextCursor: null,
        },
      },
    });
    expect(calls[0].sql).toContain("referrer_url");
    expect(calls[0].sql).toContain("GROUP BY COALESCE(");
    expect(calls[0].bindings).toContain("Chrome");
    expect(calls[0].bindings.at(-1)).toBe(8);
  });

  it("maps dimension aggregate rows and drops geo filters before querying", async () => {
    const { env, calls } = createD1Env([
      [
        {
          value: "Chrome",
          views: "5",
          sessions: "3",
          visitors: "2",
        },
      ],
    ]);

    const rows = await queryDimensionAggregate(
      env,
      siteId,
      window,
      filterFixture({ device: "desktop" }),
      4,
      PAGE_DIMENSION_SELECTIONS.browser,
    );

    expect(mapDimensionRows(rows)).toEqual([
      {
        key: "Chrome",
        label: "Chrome",
        views: 5,
        sessions: 3,
        visitors: 2,
      },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("GROUP BY COALESCE(");
    expect(calls[0].bindings).toEqual(
      expect.arrayContaining([...visitBindings(), "desktop", 4]),
    );
  });

  it("returns an empty dashboard page without loading previous, titles, or trend rows", async () => {
    const { env, calls } = createD1Env([[]]);

    const response = await handlePagesDashboard(
      env,
      siteId,
      url("/pages/dashboard", {
        from: window.startMs,
        to: window.endExclusiveMs,
        limit: 4,
        interval: "hour",
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      interval: "hour",
      data: {
        items: [],
        pagination: {
          limit: 4,
          returned: 0,
          hasMore: false,
          nextCursor: null,
        },
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].bindings.at(-1)).toBe(5);
  });

  it("compiles URL visitor scope before invoking the page dashboard provider", async () => {
    const { env, calls } = createD1Env([[]]);

    const response = await handlePagesDashboard(
      env,
      siteId,
      url("/pages/dashboard", {
        from: window.startMs,
        to: window.endExclusiveMs,
        scope: "visitor",
        "filter[page.path]": "/pricing",
      }),
    );

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("scope_final_visits");
    expect(calls[0].bindings.length).toBeGreaterThan(4);
  });

  it("parses dashboard comparison controls and custom reference filters", async () => {
    const { env, calls } = createD1Env([
      [
        {
          pathname: "/docs",
          current_views: 4,
          current_sessions: 2,
          current_visitors: 2,
          current_bounces: 1,
          current_total_duration: 2000,
          current_duration_views: 0,
          reference_views: 2,
          reference_sessions: 1,
          reference_visitors: 1,
          reference_bounces: 1,
          reference_total_duration: 1000,
          reference_duration_views: 0,
        },
      ],
      [],
    ]);
    const response = await handlePagesDashboard(
      env,
      siteId,
      new URL(
        `https://edge.test/pages/dashboard?from=${window.startMs}&to=${window.endExclusiveMs}&limit=1&compare=previous&metric=avgDurationMs&sortBy=reference&direction=asc&search=docs&compareFilter%5Bpage.path%5D=%2Fdocs`,
      ),
    );

    expect(response.status).toBe(200);
    expect(calls[0]?.sql).toContain("current_metrics");
    expect(calls[0]?.sql).toContain("reference_metrics");
    await expect(response.json()).resolves.toMatchObject({
      data: { items: [{ pathname: "/docs", reference: { views: 2 } }] },
    });
  });

  it("rejects invalid dashboard comparison controls before querying D1", async () => {
    const requests = ["sort=invalid", "direction=sideways", "compare=invalid"];
    for (const control of requests) {
      const { env, calls } = createD1Env([]);
      const response = await handlePagesDashboard(
        env,
        siteId,
        new URL(
          `https://edge.test/pages/dashboard?from=${window.startMs}&to=${window.endExclusiveMs}&${control}`,
        ),
      );
      expect(response.status).toBe(400);
      expect(calls).toHaveLength(0);
    }
  });

  it("treats same-period comparison without a reference filter as inactive", async () => {
    const { env, calls } = createD1Env([[]]);
    const response = await handlePagesDashboard(
      env,
      siteId,
      new URL(
        `https://edge.test/pages/dashboard?from=${window.startMs}&to=${window.endExclusiveMs}&compare=same`,
      ),
    );
    expect(response.status).toBe(200);
    expect(calls[0]?.sql).toContain("path_metrics");
    expect(calls[0]?.sql).not.toContain("current_metrics");
  });

  it("rejects invalid dashboard cursors before querying D1", async () => {
    const { env, calls } = createD1Env([]);

    const response = await handlePagesDashboard(
      env,
      siteId,
      url("/pages/dashboard", {
        from: window.startMs,
        to: window.endExclusiveMs,
        limit: 24,
        cursor: "invalid-cursor",
      }),
    );

    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("maps dashboard cards, titles, trends, previous changes, and hasMore pagination", async () => {
    const currentRows = [
      {
        pathname: "/pricing",
        views: 10,
        sessions: 5,
        visitors: 4,
        bounces: 1,
        totalDuration: 50000,
      },
      {
        pathname: "/docs",
        views: 4,
        sessions: 2,
        visitors: 2,
        bounces: 2,
        totalDuration: 20000,
      },
      {
        pathname: "/more",
        views: 1,
        sessions: 1,
        visitors: 1,
        bounces: 1,
        totalDuration: 1000,
      },
    ];
    const { env, calls } = createD1Env([
      currentRows,
      [
        {
          pathname: "/pricing",
          views: 5,
          sessions: 5,
          visitors: 2,
          bounces: 2,
          totalDuration: 25000,
        },
      ],
      [
        {
          rowKind: "title",
          pathname: "/pricing",
          title: " Pricing ",
          views: 8,
        },
        {
          rowKind: "title",
          pathname: "/pricing",
          title: "Pricing",
          views: 2,
        },
        { rowKind: "title", pathname: "/docs", title: "Docs", views: 4 },
        {
          rowKind: "trend",
          pathname: "/pricing",
          bucket: 0,
          views: 6,
          visitors: 3,
        },
        {
          rowKind: "trend",
          pathname: "/docs",
          bucket: 1,
          views: 4,
          visitors: 2,
        },
      ],
    ]);

    const response = await handlePagesDashboard(
      env,
      siteId,
      url("/pages/dashboard", {
        from: window.startMs,
        to: window.endExclusiveMs,
        limit: 2,
        interval: "hour",
      }),
    );
    const payload = await response.json();

    expect(payload).toMatchObject({
      ok: true,
      interval: "hour",
      data: {
        items: [
          {
            pathname: "/pricing",
            titles: ["Pricing"],
            metrics: {
              views: 10,
              visitors: 4,
              sessions: 5,
              bounceRate: 0.2,
              pagesPerSession: 2,
              avgDurationMs: 10000,
            },
            changeRates: {
              views: 100,
              visitors: 100,
              sessions: 0,
              bounceRate: -50,
              pagesPerSession: 100,
              avgDurationMs: 100,
            },
            trend: [
              {
                timestampMs: Date.UTC(2026, 0, 2, 1),
                views: 6,
                visitors: 3,
              },
            ],
          },
          {
            pathname: "/docs",
            titles: ["Docs"],
            metrics: {
              views: 4,
              visitors: 2,
              sessions: 2,
              bounceRate: 1,
              pagesPerSession: 2,
              avgDurationMs: 10000,
            },
            changeRates: {
              views: null,
              visitors: null,
              sessions: null,
              bounceRate: null,
              pagesPerSession: null,
              avgDurationMs: null,
            },
            trend: [
              {
                timestampMs: Date.UTC(2026, 0, 2, 2),
                views: 4,
                visitors: 2,
              },
            ],
          },
        ],
        pagination: {
          limit: 2,
          returned: 2,
          hasMore: true,
          nextCursor: expect.any(String),
        },
      },
    });
    expect(calls).toHaveLength(3);
    expect(calls[0].bindings.slice(-2)).toEqual([window.endExclusiveMs, 3]);
    expect(calls[1].bindings.slice(-2)).toEqual(["/pricing", "/docs"]);
    expect(calls[2].bindings.slice(-3)).toEqual(["/pricing", "/docs", 3]);
    expect(calls[2].sql).toContain("filtered_visits AS MATERIALIZED");
  });
});
describe("edge overview D1 queries and handlers", () => {
  it("reads the latest filtered site activity without turning an absent value into epoch", async () => {
    const { env, calls } = createD1Env([
      [{ lastActivityAt: 123 }],
      [{ lastActivityAt: null }],
      [{ lastActivityAt: "not-a-time" }],
    ]);
    const filters = filterFixture({ country: "US" });

    await expect(
      queryLatestSiteActivity(env, siteId, window, filters),
    ).resolves.toBe(123);
    await expect(
      queryLatestSiteActivity(env, siteId, window, filters),
    ).resolves.toBeNull();
    await expect(
      queryLatestSiteActivity(env, siteId, window, filters),
    ).resolves.toBeNull();
    expect(calls).toHaveLength(3);
    expect(calls[0]?.sql).toContain("MAX(last_activity_at)");
    expect(calls[0]?.bindings).toEqual([
      ...visitBindings(),
      "us",
      window.startMs,
      window.endExclusiveMs,
      "us",
    ]);
  });

  it("maps overview aggregate fallback values and applies filters", async () => {
    const { env, calls } = createD1Env([[]]);

    await expect(
      queryOverviewFromD1(
        env,
        siteId,
        window,
        filterFixture({
          country: "US",
          clientBrowser: "Chrome",
        }),
      ),
    ).resolves.toEqual({
      views: 0,
      sessions: 0,
      visitors: 0,
      bounces: 0,
      totalDuration: 0,
      durationViews: 0,
    });

    expect(calls[0].sql).toContain("session_rollup AS");
    expect(calls[0].bindings).toEqual([
      ...visitBindings(),
      "Chrome",
      "us",
      window.startMs,
      window.endExclusiveMs,
      "Chrome",
      "us",
    ]);
  });

  it("materializes filtered overview visits once while preserving aggregates", async () => {
    const database = new DatabaseSync(":memory:");
    for (const migration of [
      "migrations/0008_rebuild_analytics.sql",
      "migrations/0013_add_visit_performance_metrics.sql",
      "migrations/0019_add_user_identity.sql",
    ]) {
      database.exec(readFileSync(migration, "utf8"));
    }
    installVisitSiteIdentityFixture(database);
    installDirectEventFilterTables(database);
    const calls: QueryCall[] = [];
    const env = {
      DB: {
        prepare: (sql: string) => ({
          bind: (...bindings: QueryBinding[]) => {
            const call = { sql, bindings };
            calls.push(call);
            return {
              all: async () => ({
                results: database.prepare(sql).all(...bindings) as D1Row[],
              }),
            };
          },
        }),
      } as unknown as D1Database,
    } as Env;
    const insert = database.prepare(`
      INSERT INTO visits (
        visit_id, site_id, visitor_id, session_id, status, started_at,
        last_activity_at, pathname, hostname, country, browser, duration_ms
      ) VALUES (?, ?, ?, ?, 'closed', ?, ?, ?, 'example.test', ?, ?, ?)
    `);

    try {
      insert.run(
        "first-session-first-visit",
        siteId,
        "visitor-1",
        "session-1",
        baseMs,
        baseMs,
        "/",
        "US",
        "Chrome",
        100,
      );
      insert.run(
        "first-session-second-visit",
        siteId,
        "visitor-1",
        "session-1",
        baseMs + 1,
        baseMs + 1,
        "/docs",
        "US",
        "Chrome",
        null,
      );
      insert.run(
        "second-session-visit",
        siteId,
        "visitor-1",
        "session-2",
        baseMs + 2,
        baseMs + 2,
        "/pricing",
        "US",
        "Chrome",
        50,
      );
      insert.run(
        "excluded-country",
        siteId,
        "visitor-2",
        "session-3",
        baseMs + 3,
        baseMs + 3,
        "/",
        "CA",
        "Chrome",
        999,
      );

      await expect(
        queryOverviewFromD1(
          env,
          siteId,
          window,
          filterFixture({ path: "/docs" }),
        ),
      ).resolves.toEqual({
        views: 2,
        sessions: 1,
        visitors: 1,
        bounces: 0,
        totalDuration: 100,
        durationViews: 1,
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]?.sql).toContain("filtered_visits AS MATERIALIZED");
      const plan = database
        .prepare(`EXPLAIN QUERY PLAN ${calls[0]?.sql ?? "SELECT 1"}`)
        .all(...(calls[0]?.bindings ?? [])) as Array<{ detail: string }>;
      expect(
        plan.filter((row) => row.detail.includes("SEARCH visits USING INDEX")),
      ).toHaveLength(1);
      expect(
        plan.some((row) =>
          row.detail.includes("idx_visits_site_pk_started_at"),
        ),
      ).toBe(true);
    } finally {
      database.close();
    }
  });

  it("counts event-only Session entities in scoped overview and trend", async () => {
    const sqlite = createScopedOverviewSqliteEnv();
    const eventAt = baseMs + 15 * 60 * 1000;
    try {
      sqlite.database
        .prepare(
          `
          INSERT INTO visits (
            visit_id, site_id, visitor_id, session_id, status, started_at,
            last_activity_at, pathname, hostname
          ) VALUES (?, ?, ?, ?, 'closed', ?, ?, ?, 'example.test')
        `,
        )
        .run(
          "event-only-visit",
          siteId,
          "event-only-visitor",
          "event-only-session",
          baseMs - 60 * 60 * 1000,
          baseMs - 60 * 60 * 1000,
          "/event-only",
        );
      sqlite.database
        .prepare(
          "INSERT INTO custom_event_names (id, site_id, name, last_seen_at) VALUES (?, ?, ?, ?)",
        )
        .run(1, siteId, "signup", eventAt);
      sqlite.database
        .prepare(
          `
          INSERT INTO custom_events (
            event_pk, event_id, site_id, visit_id, event_name_id, occurred_at,
            received_at, sequence, node_count, value_count
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          1,
          "event-only-event",
          siteId,
          "event-only-visit",
          1,
          eventAt,
          eventAt,
          0,
          0,
          0,
        );

      const prepared = prepareScopedQuery("overview", {
        context: siteQueryContext(siteId, "private-dashboard"),
        time: createQueryTime(
          window.startMs,
          window.endExclusiveMs,
          window.timeZone,
          window.nowMs,
        ),
        filters: {
          version: 1,
          root: {
            kind: "condition",
            target: { kind: "field", field: "event.name" as never },
            operator: "eq",
            value: "signup",
          },
        },
        scopePreference: "session",
      } as never);
      const filters = prepared.filters!;

      await expect(
        queryOverviewFromD1(sqlite.env, siteId, window, filters),
      ).resolves.toMatchObject({
        views: 0,
        sessions: 1,
        visitors: 1,
      });
      await expect(
        queryTrendFromD1(sqlite.env, siteId, window, "hour", filters),
      ).resolves.toEqual([
        expect.objectContaining({
          bucket: 0,
          views: 0,
          sessions: 1,
          visitors: 1,
          bounces: 0,
        }),
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("filters overview visits by each session's entry path", async () => {
    const database = new DatabaseSync(":memory:");
    for (const migration of [
      "migrations/0008_rebuild_analytics.sql",
      "migrations/0013_add_visit_performance_metrics.sql",
      "migrations/0019_add_user_identity.sql",
    ]) {
      database.exec(readFileSync(migration, "utf8"));
    }
    installVisitSiteIdentityFixture(database);
    installDirectEventFilterTables(database);
    const calls: QueryCall[] = [];
    const env = {
      DB: {
        prepare: (sql: string) => ({
          bind: (...bindings: QueryBinding[]) => {
            const call = { sql, bindings };
            calls.push(call);
            return {
              all: async () => ({
                results: database.prepare(sql).all(...bindings) as D1Row[],
              }),
            };
          },
        }),
      } as unknown as D1Database,
    } as Env;
    const insert = database.prepare(`
      INSERT INTO visits (
        visit_id, site_id, visitor_id, session_id, status, started_at,
        last_activity_at, pathname, hostname, duration_ms
      ) VALUES (?, ?, ?, ?, 'closed', ?, ?, ?, 'example.test', ?)
    `);

    try {
      insert.run(
        "matching-entry",
        siteId,
        "visitor-1",
        "matching-session",
        baseMs,
        baseMs,
        "/landing",
        20,
      );
      insert.run(
        "matching-follow-up",
        siteId,
        "visitor-1",
        "matching-session",
        baseMs + 1,
        baseMs + 1,
        "/pricing",
        30,
      );
      insert.run(
        "different-entry",
        siteId,
        "visitor-2",
        "other-session",
        baseMs + 2,
        baseMs + 2,
        "/docs",
        99,
      );
      insert.run(
        "empty-session",
        siteId,
        "visitor-3",
        "",
        baseMs + 3,
        baseMs + 3,
        "/landing",
        999,
      );

      await expect(
        queryOverviewFromD1(
          env,
          siteId,
          window,
          filterFixture({
            entry: "/landing",
            exit: "/pricing",
          }),
        ),
      ).resolves.toEqual({
        views: 2,
        sessions: 1,
        visitors: 1,
        bounces: 0,
        totalDuration: 50,
        durationViews: 2,
      });

      expect(calls).toHaveLength(1);
      const plan = database
        .prepare(`EXPLAIN QUERY PLAN ${calls[0]?.sql ?? "SELECT 1"}`)
        .all(...(calls[0]?.bindings ?? [])) as Array<{ detail: string }>;
      expect(plan.length).toBeGreaterThan(0);
      expect(calls[0]?.sql).toContain("event_filter_source");
    } finally {
      database.close();
    }
  });

  it("uses filtered visits to select retention visitors, then counts their later visits", async () => {
    const database = new DatabaseSync(":memory:");
    for (const migration of [
      "migrations/0008_rebuild_analytics.sql",
      "migrations/0013_add_visit_performance_metrics.sql",
      "migrations/0019_add_user_identity.sql",
    ]) {
      database.exec(readFileSync(migration, "utf8"));
    }
    installVisitSiteIdentityFixture(database);
    installDirectEventFilterTables(database);
    const env = {
      DB: {
        prepare: (sql: string) => ({
          bind: (...bindings: QueryBinding[]) => ({
            all: async () => ({
              results: database.prepare(sql).all(...bindings) as D1Row[],
            }),
          }),
        }),
      } as unknown as D1Database,
    } as Env;
    const insert = database.prepare(`
      INSERT INTO visits (
        visit_id, site_id, visitor_id, session_id, status, started_at,
        last_activity_at, pathname, hostname
      ) VALUES (?, ?, ?, ?, 'closed', ?, ?, ?, 'example.test')
    `);

    try {
      insert.run(
        "retention-match",
        siteId,
        "visitor-match",
        "retention-session",
        baseMs + 100,
        baseMs + 100,
        "/match",
      );
      insert.run(
        "retention-return",
        siteId,
        "visitor-match",
        "retention-session",
        baseMs + 60 * 60 * 1000 + 100,
        baseMs + 60 * 60 * 1000 + 100,
        "/return",
      );
      insert.run(
        "retention-other",
        siteId,
        "visitor-other",
        "other-session",
        baseMs + 100,
        baseMs + 100,
        "/other",
      );

      await expect(
        queryRetentionFromD1(
          env,
          siteId,
          window,
          filterFixture({ path: "/match" }),
          "hour",
        ),
      ).resolves.toEqual({
        granularity: "hour",
        cohorts: [
          {
            bucket: baseMs,
            size: 1,
            periods: [
              { index: 0, visitors: 1, rate: 1 },
              { index: 1, visitors: 1, rate: 1 },
            ],
          },
        ],
      });
    } finally {
      database.close();
    }
  });

  it("maps trend rows, bucket timestamps, and filter bindings", async () => {
    const filters: FilterDocument = filterFixture({
      sourceDomain: "Ref.Example",
      clientDeviceType: "mobile",
    });
    const { env, calls } = createD1Env([
      [
        {
          bucket: "0",
          views: "3",
          visitors: "2",
          sessions: "2",
          bounces: "1",
          totalDuration: "6000",
          durationViews: "3",
        },
        {
          bucket: 1,
          views: 4,
          visitors: 3,
          sessions: 2,
          bounces: 0,
          totalDuration: 8000,
          durationViews: 4,
        },
      ],
    ]);

    await expect(
      queryTrendFromD1(env, siteId, window, "hour", filters),
    ).resolves.toEqual([
      {
        bucket: 0,
        timestampMs: Date.UTC(2026, 0, 2, 1),
        views: 3,
        visitors: 2,
        sessions: 2,
        bounces: 1,
        totalDuration: 6000,
        durationViews: 3,
      },
      {
        bucket: 1,
        timestampMs: Date.UTC(2026, 0, 2, 2),
        views: 4,
        visitors: 3,
        sessions: 2,
        bounces: 0,
        totalDuration: 8000,
        durationViews: 4,
      },
    ]);

    expect(calls[0].sql).toContain("visit_bucket_rollup AS");
    expect(calls[0].sql).toContain("session_bucket_rollup AS");
    expect(calls[0].sql).toContain("CASE WHEN started_at >=");
    expect(calls[0].bindings).toEqual([
      ...visitBindings(),
      "mobile",
      "ref.example",
      window.startMs,
      window.endExclusiveMs,
      "mobile",
      "ref.example",
    ]);
  });

  it("materializes filtered trend visits once while preserving bucket metrics", async () => {
    const database = new DatabaseSync(":memory:");
    for (const migration of [
      "migrations/0008_rebuild_analytics.sql",
      "migrations/0013_add_visit_performance_metrics.sql",
      "migrations/0019_add_user_identity.sql",
    ]) {
      database.exec(readFileSync(migration, "utf8"));
    }
    installVisitSiteIdentityFixture(database);
    installDirectEventFilterTables(database);
    const calls: QueryCall[] = [];
    const env = {
      DB: {
        prepare: (sql: string) => ({
          bind: (...bindings: QueryBinding[]) => {
            const call = { sql, bindings };
            calls.push(call);
            return {
              all: async () => ({
                results: database.prepare(sql).all(...bindings) as D1Row[],
              }),
            };
          },
        }),
      } as unknown as D1Database,
    } as Env;
    const insert = database.prepare(`
      INSERT INTO visits (
        visit_id, site_id, visitor_id, session_id, status, started_at,
        last_activity_at, pathname, hostname, country, duration_ms
      ) VALUES (?, ?, ?, ?, 'closed', ?, ?, ?, 'example.test', ?, ?)
    `);

    try {
      insert.run(
        "first-hour",
        siteId,
        "visitor-1",
        "session-1",
        baseMs + 100,
        baseMs + 100,
        "/",
        "US",
        100,
      );
      insert.run(
        "second-hour-first",
        siteId,
        "visitor-1",
        "session-2",
        baseMs + 60 * 60 * 1000 + 100,
        baseMs + 60 * 60 * 1000 + 100,
        "/docs",
        "US",
        200,
      );
      insert.run(
        "second-hour-last",
        siteId,
        "visitor-1",
        "session-2",
        baseMs + 60 * 60 * 1000 + 200,
        baseMs + 60 * 60 * 1000 + 200,
        "/pricing",
        "US",
        300,
      );
      insert.run(
        "excluded-country",
        siteId,
        "visitor-2",
        "session-3",
        baseMs + 300,
        baseMs + 300,
        "/",
        "CA",
        999,
      );

      await expect(
        queryTrendFromD1(
          env,
          siteId,
          window,
          "hour",
          filterFixture({ path: "/docs" }),
        ),
      ).resolves.toEqual([
        {
          bucket: 1,
          timestampMs: baseMs + 60 * 60 * 1000,
          views: 2,
          visitors: 1,
          sessions: 1,
          bounces: 0,
          totalDuration: 500,
          durationViews: 2,
        },
      ]);

      expect(calls).toHaveLength(1);
      expect(calls[0]?.sql).toContain("filtered_visits AS MATERIALIZED");
      const plan = database
        .prepare(`EXPLAIN QUERY PLAN ${calls[0]?.sql ?? "SELECT 1"}`)
        .all(...(calls[0]?.bindings ?? [])) as Array<{ detail: string }>;
      expect(
        plan.filter((row) => row.detail.includes("SEARCH visits USING INDEX")),
      ).toHaveLength(1);
      expect(
        plan.some((row) =>
          row.detail.includes("idx_visits_site_pk_started_at"),
        ),
      ).toBe(true);
    } finally {
      database.close();
    }
  });

  it("returns overview metrics with previous change rates and detail trend mapping", async () => {
    const { env, calls } = createD1Env([
      [
        {
          views: 10,
          sessions: 5,
          visitors: 4,
          bounces: 1,
          totalDuration: 50000,
          durationViews: 10,
        },
      ],
      [
        {
          views: 5,
          sessions: 5,
          visitors: 2,
          bounces: 2,
          totalDuration: 25000,
          durationViews: 5,
        },
      ],
      [
        {
          bucket: 0,
          views: 6,
          visitors: 3,
          sessions: 3,
          bounces: 1,
          totalDuration: 30000,
          durationViews: 6,
        },
      ],
    ]);

    const response = await handleOverview(
      env,
      siteId,
      url("/overview", {
        from: window.startMs,
        to: window.endExclusiveMs,
        interval: "hour",
        includeChange: true,
        includeDetail: true,
        "filter[page.path]": "/pricing",
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: {
        views: 10,
        sessions: 5,
        visitors: 4,
        bounces: 1,
        totalDurationMs: 50000,
        avgDurationMs: 10000,
        bounceRate: 0.2,
        approximateVisitors: false,
      },
      previousData: {
        views: 5,
        sessions: 5,
        visitors: 2,
        bounces: 2,
        totalDurationMs: 25000,
        avgDurationMs: 5000,
        bounceRate: 0.4,
        approximateVisitors: false,
      },
      changeRates: {
        views: 100,
        sessions: 0,
        visitors: 100,
        bounces: -50,
        bounceRate: -50,
        avgDurationMs: 100,
      },
      detail: {
        interval: "hour",
        data: [
          {
            bucket: 0,
            timestampMs: Date.UTC(2026, 0, 2, 1),
            views: 6,
            visitors: 3,
            sessions: 3,
            bounces: 1,
            totalDurationMs: 30000,
            avgDurationMs: 10000,
            source: "detail",
          },
        ],
      },
    });
    expect(response.headers.get("x-insightflare-data-source")).toBe("raw");
    expect(response.headers.get("x-insightflare-d1-rows-read")).toBe(
      "unavailable",
    );
    expect(calls).toHaveLength(3);
    expect(calls.map((call) => call.bindings.at(-1))).toEqual([
      "/pricing",
      "/pricing",
      "/pricing",
    ]);
  });

  it("maps trend handler rows without optional overview change payload", async () => {
    const { env, calls } = createD1Env([
      [
        {
          bucket: 0,
          views: 2,
          visitors: 1,
          sessions: 1,
          bounces: 0,
          totalDuration: 3000,
          durationViews: 1,
        },
      ],
    ]);

    const response = await handleTrend(
      env,
      siteId,
      url("/trend", {
        from: window.startMs,
        to: window.endExclusiveMs,
        interval: "hour",
        "filter[referrer.domain]": "Ref.Example",
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      interval: "hour",
      data: [
        {
          bucket: 0,
          timestampMs: Date.UTC(2026, 0, 2, 1),
          views: 2,
          visitors: 1,
          sessions: 1,
          bounces: 0,
          totalDurationMs: 3000,
          avgDurationMs: 3000,
          source: "detail",
        },
      ],
    });
    expect(calls[0].bindings.at(-1)).toBe("ref.example");
  });

  it("maps overview page, source, client, and geo tab handlers", async () => {
    const { env, calls } = createD1Env(
      [
        [
          {
            value: "/home",
            views: "1",
            sessions: "1",
            visitors: "1",
          },
        ],
        [
          {
            referrer: "",
            views: "4",
            sessions: "2",
            visitors: "2",
          },
        ],
        [
          {
            value: "organic_search",
            views: "3",
            sessions: "2",
            visitors: "2",
          },
        ],
        [
          {
            value: "1440x900",
            views: "2",
            sessions: "2",
            visitors: "2",
          },
        ],
        [
          {
            value: "US",
            views: "1",
            sessions: "1",
            visitors: "1",
          },
        ],
      ],
      37,
    );

    const pageTab = await handleOverviewTabContract(
      env,
      siteId,
      url("/overview/page-tab", {
        from: window.startMs,
        to: window.endExclusiveMs,
        limit: 2,
      }),
      "page.path",
    );
    const sourceTab = await handleOverviewTabContract(
      env,
      siteId,
      url("/overview/source-tab", {
        from: window.startMs,
        to: window.endExclusiveMs,
        limit: 3,
      }),
      "source.domain",
    );
    const sourceChannelTab = await handleOverviewTabContract(
      env,
      siteId,
      url("/overview/source-channel-tab", {
        from: window.startMs,
        to: window.endExclusiveMs,
        limit: 3,
      }),
      "source.channel",
    );
    const clientTab = await handleOverviewTabContract(
      env,
      siteId,
      url("/overview/client-tab", {
        from: window.startMs,
        to: window.endExclusiveMs,
        limit: 3,
      }),
      "client.screenSize",
    );
    const geoTab = await handleOverviewTabContract(
      env,
      siteId,
      url("/overview/geo-tab", {
        from: window.startMs,
        to: window.endExclusiveMs,
        geo: "US::CA::California",
        limit: 3,
      }),
      "geo.country",
    );

    await expect(pageTab.json()).resolves.toEqual({
      ok: true,
      data: {
        items: [{ label: "/home", views: 1, sessions: 1, visitors: 1 }],
        pagination: {
          limit: 2,
          returned: 1,
          hasMore: false,
          nextCursor: null,
        },
      },
    });
    await expect(sourceTab.json()).resolves.toEqual({
      ok: true,
      data: {
        items: [{ label: "", views: 4, sessions: 2, visitors: 2 }],
        pagination: {
          limit: 3,
          returned: 1,
          hasMore: false,
          nextCursor: null,
        },
      },
    });
    await expect(sourceChannelTab.json()).resolves.toEqual({
      ok: true,
      data: {
        items: [
          {
            label: "organic_search",
            views: 3,
            sessions: 2,
            visitors: 2,
          },
        ],
        pagination: {
          limit: 3,
          returned: 1,
          hasMore: false,
          nextCursor: null,
        },
      },
    });
    await expect(clientTab.json()).resolves.toEqual({
      ok: true,
      data: {
        items: [{ label: "1440x900", views: 2, sessions: 2, visitors: 2 }],
        pagination: {
          limit: 3,
          returned: 1,
          hasMore: false,
          nextCursor: null,
        },
      },
    });
    await expect(geoTab.json()).resolves.toEqual({
      ok: true,
      data: {
        items: [
          {
            value: "US",
            label: "US",
            views: 1,
            sessions: 1,
            visitors: 1,
          },
        ],
        pagination: {
          limit: 3,
          returned: 1,
          hasMore: false,
          nextCursor: null,
        },
      },
    });
    expect(calls.map((call) => call.bindings.at(-1))).toEqual([3, 4, 4, 4, 4]);
    expect(calls).toHaveLength(5);
    expect(calls[0].sql).toContain("GROUP BY COALESCE(");
    expect(calls[2].sql).toContain("organic_search");
    expect(calls[3].sql).toContain("screen_width");
    expect(calls[4].sql).toContain("country");
  });

  it("routes comparison requests for every dimension tab and validates controls", async () => {
    const comparisonTabs = [
      "page.path",
      "page.query",
      "page.title",
      "page.hostname",
      "page.entry",
      "page.exit",
      "source.domain",
      "source.link",
      "client.browser",
      "client.osVersion",
      "client.deviceType",
      "client.language",
      "client.screenSize",
      "geo.country",
      "geo.region",
      "geo.city",
      "geo.continent",
      "geo.timezone",
      "geo.organization",
    ] as const;
    const { env, calls } = createD1Env(
      comparisonTabs.map((tab) => [
        {
          key: `${tab}-value`,
          current_views: 4,
          current_sessions: 2,
          current_visitors: 2,
          reference_views: 3,
          reference_sessions: 1,
          reference_visitors: 1,
        },
      ]),
    );

    for (const tab of comparisonTabs) {
      const response = await handleOverviewTabContract(
        env,
        siteId,
        url(`/overview/${tab}`, {
          from: window.startMs,
          to: window.endExclusiveMs,
          compare: "previous",
          sort: "visitors",
          sortBy: "change",
          direction: "asc",
          search: "value",
          limit: 1,
        }),
        tab,
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ ok: true });
    }

    expect(calls).toHaveLength(comparisonTabs.length);
    expect(calls.every((call) => call.sql.includes("reference_rollup"))).toBe(
      true,
    );

    const invalidSort = await handleOverviewTabContract(
      env,
      siteId,
      url("/overview/page.path", {
        from: window.startMs,
        to: window.endExclusiveMs,
        sort: "sessions",
      }),
      "page.path",
    );
    expect(invalidSort.status).toBe(400);

    const invalidDirection = await handleOverviewTabContract(
      env,
      siteId,
      url("/overview/page.path", {
        from: window.startMs,
        to: window.endExclusiveMs,
        direction: "sideways",
      }),
      "page.path",
    );
    expect(invalidDirection.status).toBe(400);

    const invalidComparison = await handleOverviewTabContract(
      env,
      siteId,
      url("/overview/page.path", {
        from: window.startMs,
        to: window.endExclusiveMs,
        compare: "future",
      }),
      "page.path",
    );
    expect(invalidComparison.status).toBe(400);
  });

  it("maps filter option branches across page, source, client, geo, and scalar keys", async () => {
    const { env, calls } = createD1Env([
      [
        {
          value: "US",
          views: "5",
          sessions: "3",
          visitors: "2",
        },
      ],
      [
        {
          cardType: "path",
          value: "/home",
          views: 1,
          sessions: 1,
          visitors: 1,
        },
      ],
      [
        {
          referrer: "",
          views: "4",
          sessions: "2",
          visitors: "1",
        },
      ],
      [
        {
          cardType: "screenSize",
          value: "390x844",
          views: 1,
          sessions: 1,
        },
      ],
      [
        {
          cardType: "country",
          value: "US",
          views: 1,
          sessions: 1,
          visitors: 1,
        },
        {
          cardType: "region",
          value: "US::CA::California",
          views: 1,
          sessions: 1,
          visitors: 1,
        },
        {
          cardType: "city",
          value: "US::CA::California::San Francisco",
          views: 1,
          sessions: 1,
          visitors: 1,
        },
      ],
      [],
      [],
      [
        {
          cardType: "organization",
          value: "Example ISP",
          views: 1,
          sessions: 1,
          visitors: 1,
        },
      ],
    ]);

    const scalar = await handleFilterValuesContract(
      env,
      siteId,
      url("/filter-values", {
        filterKey: "geo.country",
        "filter[geo.country]": "US",
        "filter[client.browser]": "Chrome",
        from: window.startMs,
        to: window.endExclusiveMs,
        limit: 4,
      }),
    );
    const page = await handleFilterValuesContract(
      env,
      siteId,
      url("/filter-values", {
        filterKey: "page.path",
        "filter[page.path]": "/home",
        from: window.startMs,
        to: window.endExclusiveMs,
        limit: 4,
      }),
    );
    const source = await handleFilterValuesContract(
      env,
      siteId,
      url("/filter-values", {
        filterKey: "referrer.domain",
        "filter[referrer.domain]": "__direct__",
        from: window.startMs,
        to: window.endExclusiveMs,
        limit: 4,
      }),
    );
    const client = await handleFilterValuesContract(
      env,
      siteId,
      url("/filter-values", {
        filterKey: "client.screenSize",
        "filter[client.screenSize]": "390x844",
        from: window.startMs,
        to: window.endExclusiveMs,
        limit: 4,
      }),
    );
    const geo = await handleFilterValuesContract(
      env,
      siteId,
      url("/filter-values", {
        filterKey: "geo.region",
        "filter[geo.country]": "US",
        "filter[geo.region]": "California",
        from: window.startMs,
        to: window.endExclusiveMs,
        limit: 4,
      }),
    );
    const geoOrganization = await handleFilterValuesContract(
      env,
      siteId,
      url("/filter-values", {
        filterKey: "geo.organization",
        "filter[geo.organization]": "Example ISP",
        from: window.startMs,
        to: window.endExclusiveMs,
        limit: 4,
      }),
    );

    const responses = [
      [scalar, "geo.country"],
      [page, "page.path"],
      [source, "referrer.domain"],
      [client, "client.screenSize"],
      [geo, "geo.region"],
      [geoOrganization, "geo.organization"],
    ] as const;
    for (const [response, field] of responses) {
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        field,
        data: {
          items: expect.any(Array),
          pagination: expect.any(Object),
        },
      });
    }
    expect(calls[0]?.bindings.at(-1)).toBe(5);
    expect(calls.every((call) => call.bindings.at(-1) === 5)).toBe(true);
    expect(calls.flatMap((call) => call.bindings)).toEqual(
      expect.arrayContaining(["us"]),
    );
  });

  it("maps device and browser filter option scalar branches", async () => {
    const { env, calls } = createD1Env([
      [
        {
          value: "desktop",
          views: "6",
          sessions: "4",
          visitors: "3",
        },
      ],
      [
        {
          value: "Chrome",
          views: "5",
          sessions: "3",
          visitors: "2",
        },
      ],
    ]);

    const device = await handleFilterValuesContract(
      env,
      siteId,
      url("/filter-values", {
        filterKey: "client.deviceType",
        "filter[client.deviceType]": "desktop",
        "filter[client.browser]": "Chrome",
        from: window.startMs,
        to: window.endExclusiveMs,
        limit: 4,
      }),
    );
    const browser = await handleFilterValuesContract(
      env,
      siteId,
      url("/filter-values", {
        filterKey: "client.browser",
        "filter[client.browser]": "Chrome",
        "filter[geo.country]": "US",
        from: window.startMs,
        to: window.endExclusiveMs,
        limit: 4,
      }),
    );

    await expect(device.json()).resolves.toEqual({
      ok: true,
      field: "client.deviceType",
      data: {
        items: [{ value: "desktop", label: "desktop", occurrences: 6 }],
        pagination: {
          limit: 4,
          returned: 1,
          hasMore: false,
          nextCursor: null,
        },
      },
    });
    await expect(browser.json()).resolves.toEqual({
      ok: true,
      field: "client.browser",
      data: {
        items: [{ value: "Chrome", label: "Chrome", occurrences: 5 }],
        pagination: {
          limit: 4,
          returned: 1,
          hasMore: false,
          nextCursor: null,
        },
      },
    });
    expect(calls).toHaveLength(2);
    expect(calls[0].sql).toContain("device_type");
    expect(calls[1].sql).toContain("browser");
    expect(calls.map((call) => call.bindings.at(-1))).toEqual([5, 5]);
  });

  it("maps overview geo points with and without applying geo filters", async () => {
    const { env, calls } = createD1Env([
      [
        {
          latitude: "37.7",
          longitude: "-122.4",
          timestampMs: String(window.startMs),
          country: "US",
          region: "California",
          regionCode: "CA",
          city: "San Francisco",
        },
      ],
      [
        {
          country: "US",
          views: "7",
          sessions: "4",
          visitors: "3",
        },
      ],
      [],
      [
        {
          country: "us",
          regionCode: "ca",
          region: "California",
          city: "San Francisco",
          views: "5",
          sessions: "3",
          visitors: "2",
        },
      ],
    ]);

    const withoutGeo = await handleOverviewGeoPoints(
      env,
      siteId,
      url("/overview/geo-points", {
        from: window.startMs,
        to: window.endExclusiveMs,
        "filter[geo.country]": "US",
        "filter[geo.region]": "California",
        limit: 9,
      }),
    );
    const withGeo = await handleOverviewGeoPoints(
      env,
      siteId,
      url("/overview/geo-points", {
        from: window.startMs,
        to: window.endExclusiveMs,
        "filter[geo.country]": "US",
        "filter[geo.region]": "California",
        applyGeoFilter: true,
        limit: 10,
      }),
    );

    await expect(withoutGeo.json()).resolves.toEqual({
      ok: true,
      data: [
        {
          latitude: 37.7,
          longitude: -122.4,
          timestampMs: window.startMs,
          country: "US",
          region: "California",
          regionCode: "CA",
          city: "San Francisco",
          pointCount: 1,
        },
      ],
      countryCounts: [{ country: "US", views: 7, sessions: 4, visitors: 3 }],
      regionCounts: [],
      cityCounts: [],
    });
    await expect(withGeo.json()).resolves.toEqual({
      ok: true,
      data: [],
      countryCounts: [],
      regionCounts: [],
      cityCounts: [
        {
          value: "US::CA::California::San Francisco",
          label: "San Francisco",
          views: 5,
          sessions: 3,
          visitors: 2,
        },
      ],
    });
    expect(calls[0].bindings.at(-1)).toBe(9);
    expect(calls[2].bindings.at(-1)).toBe(10);
    expect(calls[2].bindings).toEqual(
      expect.arrayContaining(["us", "california"]),
    );
  });

  it("rejects invalid overview windows before querying D1", async () => {
    const { env, prepare } = createD1Env([]);

    const response = await handleOverview(
      env,
      siteId,
      new URL("https://edge.test/overview?from=20&to=10"),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { message: "Invalid time window" },
    });
    expect(prepare).not.toHaveBeenCalled();
  });
});
