import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { type SQLInputValue } from "node:sqlite";

import { describe, expect, it } from "vitest";
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  compileD1Query,
  D1_MAX_BOUND_PARAMETERS,
  D1_MAX_SQL_UTF8_BYTES,
  type DatabaseQueryObservation,
  lowerLogicalPlan,
  registerDatabaseQueryObserver,
} from "@/lib/db";
import {
  attachScopedFilterMetadata,
  createQueryTime,
  EMPTY_FILTER_DOCUMENT,
  type FilterDocument,
  type PagesDashboardMetric,
  type PagesDashboardResult,
  type PagesDashboardSortBy,
  prepareScopedQuery,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { queryWindowToTime } from "@/lib/edge/analytics/contract/helpers";
import {
  buildPagesDashboardComparisonPlan,
  PAGES_DASHBOARD_COMPARISON_OUTPUT_ID,
  type PagesDashboardComparisonCursor,
} from "@/lib/edge/analytics/engine/pages-dashboard-comparison-report-plan";
import { scopedDatasetFor } from "@/lib/edge/analytics/providers/d1/internal/__tests__/journey-list-parent-scoped-oracle";
import { buildVisitFilterSql } from "@/lib/edge/analytics/providers/d1/internal/__tests__/legacy-core-filters";
import {
  buildVisitSourceCte,
  visitSourceBindings,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/legacy-core-sources";
import { VISIT_SOURCE_COLUMNS } from "@/lib/edge/analytics/providers/d1/internal/__tests__/legacy-core-sources";
import { AnalyticsLogicalToDbLowerer } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";
import { queryAnalyticsReportOutputRowsFromD1 } from "@/lib/edge/analytics/providers/d1/internal/analytics-report-query";
import {
  mapPageCardMetrics,
  normalizePathname,
  type PageCardAggregateRow,
  percentChange,
  type QueryWindow,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import { queryPagesDashboard } from "@/lib/edge/analytics/providers/d1/internal/pages-dashboard";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";
import { normalizeFilterDocument } from "@/lib/filter-contract/filters";
const SITE_ID = "pages-comparison-wave72";
const FOREIGN_SITE_ID = "pages-comparison-wave72-foreign";
const START = 1_767_225_600_000;
const REFERENCE_WINDOW: QueryWindow = {
  startMs: START - 2_000,
  endExclusiveMs: START,
  nowMs: START + 4_000,
  timeZone: "UTC",
};
const CURRENT_WINDOW: QueryWindow = {
  startMs: START,
  endExclusiveMs: START + 2_000,
  nowMs: START + 4_000,
  timeZone: "UTC",
};
type Binding = string | number | null;
type SqlRow = Record<string, unknown>;

interface PageDashboardComparisonSide {
  readonly ctes: string;
  readonly relation: string;
  readonly filterClause: string;
  readonly bindings: readonly Binding[];
}

function legacySide(
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  prefix: string,
): PageDashboardComparisonSide {
  const scoped = scopedDatasetFor(siteId, window, filters);
  if (scoped) {
    const rename = (value: string) =>
      value
        .replace(/\bscope_[A-Za-z0-9_]*/g, (name) => `${prefix}_${name}`)
        .replace(/\bvisit_source\b/g, `${prefix}_visit_source`);
    return {
      ctes: rename(scoped.ctes),
      relation: rename(scoped.visitRelation),
      filterClause: "",
      bindings: scoped.bindings.map((binding) => binding.value),
    };
  }
  const relation = `${prefix}_visit_source`;
  const filter = buildVisitFilterSql(filters, relation, { window });
  return {
    ctes: buildVisitSourceCte().replace(/\bvisit_source\b/g, relation),
    relation,
    filterClause: filter.clause,
    bindings: [...visitSourceBindings(siteId, window), ...filter.bindings],
  };
}

function legacyMetricColumn(
  metric: PagesDashboardMetric,
  side: "current" | "reference",
): string {
  const name =
    metric === "bounceRate"
      ? "bounce_rate"
      : metric === "pagesPerSession"
        ? "pages_per_session"
        : metric === "avgDurationMs"
          ? "avg_duration_ms"
          : metric;
  return `${side}_${name}`;
}

function legacySortColumns(
  metric: PagesDashboardMetric,
  sortBy: PagesDashboardSortBy,
) {
  if (sortBy === "change")
    return { primary: "change_relative", secondary: "pathname" };
  const side = sortBy === "reference" ? "reference" : "current";
  return {
    primary: legacyMetricColumn(metric, side),
    secondary: legacyMetricColumn(
      metric,
      side === "current" ? "reference" : "current",
    ),
  };
}

/** Frozen pre-Logical SQL, bindings, source assembly, and row mapper. */
function mapLegacyComparisonRows(rows: readonly SqlRow[], limit: number) {
  const number = (row: SqlRow, key: string) => Number(row[key] ?? 0);
  const mapped = rows.map((row) => ({
    current: {
      pathname: String(row.pathname ?? ""),
      views: number(row, "current_views"),
      sessions: number(row, "current_sessions"),
      visitors: number(row, "current_visitors"),
      bounces: number(row, "current_bounces"),
      totalDuration: number(row, "current_total_duration"),
      durationViews: number(row, "current_duration_views"),
    },
    reference: {
      pathname: String(row.pathname ?? ""),
      views: number(row, "reference_views"),
      sessions: number(row, "reference_sessions"),
      visitors: number(row, "reference_visitors"),
      bounces: number(row, "reference_bounces"),
      totalDuration: number(row, "reference_total_duration"),
      durationViews: number(row, "reference_duration_views"),
    },
  }));
  return {
    rows: mapped.slice(0, limit),
    hasMore: mapped.length > limit,
  };
}

function legacyComparisonOracle(
  database: DatabaseSync,
  input: {
    siteId: string;
    current: QueryWindow;
    currentFilters: FilterDocument;
    reference: QueryWindow;
    referenceFilters: FilterDocument;
    metric: PagesDashboardMetric;
    sortBy: PagesDashboardSortBy;
    direction: "asc" | "desc";
    limit: number;
    search?: string;
    cursor?: PagesDashboardComparisonCursor | null;
  },
) {
  const currentSide = legacySide(
    input.siteId,
    input.current,
    input.currentFilters,
    "current",
  );
  const referenceSide = legacySide(
    input.siteId,
    input.reference,
    input.referenceFilters,
    "reference",
  );
  const currentMetric = legacyMetricColumn(input.metric, "current");
  const referenceMetric = legacyMetricColumn(input.metric, "reference");
  const relative = `CASE WHEN ${referenceMetric} = 0 THEN CASE WHEN ${currentMetric} = 0 THEN 0.0 ELSE NULL END ELSE (${currentMetric} - ${referenceMetric}) * 1.0 / ${referenceMetric} END`;
  const changeClass = `CASE WHEN ${referenceMetric} = 0 AND ${currentMetric} > 0 THEN 1 ELSE 0 END`;
  const ordering = legacySortColumns(input.metric, input.sortBy);
  const operator = input.direction === "asc" ? ">" : "<";
  const orderExpression =
    input.sortBy === "change"
      ? `change_class ${input.direction}, change_relative ${input.direction}, pathname ASC`
      : `${ordering.primary} ${input.direction}, ${ordering.secondary} ${input.direction}, pathname ASC`;
  const cursorClause = input.cursor
    ? input.sortBy === "change"
      ? `AND (
          change_class ${operator} ?
          OR (change_class = ? AND (
            change_relative ${operator} ?
            OR (change_relative = ? AND pathname > ?)
          ))
        )`
      : `AND (
          ${ordering.primary} ${operator} ?
          OR (${ordering.primary} = ? AND ${ordering.secondary} ${operator} ?)
          OR (${ordering.primary} = ? AND ${ordering.secondary} = ? AND pathname > ?)
        )`
    : "";
  const searchClause = input.search?.trim()
    ? "AND LOWER(pathname) LIKE ? ESCAPE '\\'"
    : "";
  const sideSql = (side: PageDashboardComparisonSide, prefix: string) => `
${prefix}_visits AS MATERIALIZED (
  SELECT pathname, session_id AS sessionId, visitor_id AS visitorId,
    duration_ms AS durationMs
  FROM ${side.relation}
  ${side.filterClause || "WHERE 1 = 1"}
  AND TRIM(COALESCE(pathname, '')) != ''
),
${prefix}_path_rollup AS (
  SELECT pathname,
    count(*) AS ${prefix}_views,
    count(DISTINCT CASE WHEN sessionId != '' THEN sessionId ELSE NULL END) AS ${prefix}_sessions,
    count(DISTINCT CASE WHEN visitorId != '' THEN visitorId ELSE NULL END) AS ${prefix}_visitors,
    COALESCE(sum(CASE WHEN durationMs IS NOT NULL AND durationMs >= 0 THEN durationMs ELSE 0 END), 0) AS ${prefix}_total_duration
  FROM ${prefix}_visits
  GROUP BY pathname
),
${prefix}_path_sessions AS (
  SELECT pathname, sessionId, count(*) AS visitCount
  FROM ${prefix}_visits
  WHERE sessionId != ''
  GROUP BY pathname, sessionId
),
${prefix}_path_bounces AS (
  SELECT pathname, count(*) AS ${prefix}_bounces
  FROM ${prefix}_path_sessions
  WHERE visitCount = 1
  GROUP BY pathname
),
${prefix}_metrics AS (
  SELECT
    pr.pathname AS pathname,
    pr.${prefix}_views AS ${prefix}_views,
    pr.${prefix}_sessions AS ${prefix}_sessions,
    pr.${prefix}_visitors AS ${prefix}_visitors,
    COALESCE(pb.${prefix}_bounces, 0) AS ${prefix}_bounces,
    pr.${prefix}_total_duration AS ${prefix}_total_duration,
    0 AS ${prefix}_duration_views,
    CASE WHEN pr.${prefix}_sessions <= 0 THEN 0.0 ELSE COALESCE(pb.${prefix}_bounces, 0) * 1.0 / pr.${prefix}_sessions END AS ${prefix}_bounce_rate,
    CASE WHEN pr.${prefix}_sessions <= 0 THEN 0.0 ELSE pr.${prefix}_views * 1.0 / pr.${prefix}_sessions END AS ${prefix}_pages_per_session,
    CASE WHEN pr.${prefix}_sessions <= 0 THEN 0.0 ELSE pr.${prefix}_total_duration * 1.0 / pr.${prefix}_sessions END AS ${prefix}_avg_duration_ms
  FROM ${prefix}_path_rollup pr
  LEFT JOIN ${prefix}_path_bounces pb ON pb.pathname = pr.pathname
)`;
  const sql = `
WITH
${currentSide.ctes},
${referenceSide.ctes},
${sideSql(currentSide, "current")},
${sideSql(referenceSide, "reference")},
joined AS (
  SELECT keys.pathname,
    COALESCE(c.current_views, 0) AS current_views,
    COALESCE(c.current_sessions, 0) AS current_sessions,
    COALESCE(c.current_visitors, 0) AS current_visitors,
    COALESCE(c.current_bounces, 0) AS current_bounces,
    COALESCE(c.current_total_duration, 0) AS current_total_duration,
    COALESCE(c.current_duration_views, 0) AS current_duration_views,
    COALESCE(c.current_bounce_rate, 0) AS current_bounce_rate,
    COALESCE(c.current_pages_per_session, 0) AS current_pages_per_session,
    COALESCE(c.current_avg_duration_ms, 0) AS current_avg_duration_ms,
    COALESCE(r.reference_views, 0) AS reference_views,
    COALESCE(r.reference_sessions, 0) AS reference_sessions,
    COALESCE(r.reference_visitors, 0) AS reference_visitors,
    COALESCE(r.reference_bounces, 0) AS reference_bounces,
    COALESCE(r.reference_total_duration, 0) AS reference_total_duration,
    COALESCE(r.reference_duration_views, 0) AS reference_duration_views,
    COALESCE(r.reference_bounce_rate, 0) AS reference_bounce_rate,
    COALESCE(r.reference_pages_per_session, 0) AS reference_pages_per_session,
    COALESCE(r.reference_avg_duration_ms, 0) AS reference_avg_duration_ms
  FROM (
    SELECT pathname FROM current_metrics
    UNION
    SELECT pathname FROM reference_metrics
  ) keys
  LEFT JOIN current_metrics c ON c.pathname = keys.pathname
  LEFT JOIN reference_metrics r ON r.pathname = keys.pathname
),
projected AS (
  SELECT *, ${relative} AS change_relative, ${changeClass} AS change_class
  FROM joined
)
SELECT * FROM projected
WHERE 1 = 1
${searchClause}
${cursorClause}
ORDER BY ${orderExpression}
LIMIT ?
`;
  const searchBindings = input.search?.trim()
    ? [
        `%${input.search
          .trim()
          .toLowerCase()
          .replaceAll("\\", "\\\\")
          .replaceAll("%", "\\%")
          .replaceAll("_", "\\_")}%`,
      ]
    : [];
  const cursorBindings = input.cursor
    ? input.sortBy === "change"
      ? [
          input.cursor.sortClass,
          input.cursor.sortClass,
          input.cursor.primary,
          input.cursor.primary,
          input.cursor.pathname,
        ]
      : [
          input.cursor.primary,
          input.cursor.primary,
          input.cursor.secondary,
          input.cursor.primary,
          input.cursor.secondary,
          input.cursor.pathname,
        ]
    : [];
  const bindings = [
    ...currentSide.bindings,
    ...referenceSide.bindings,
    ...searchBindings,
    ...cursorBindings,
    input.limit + 1,
  ];
  const rows = database
    .prepare(sql)
    .all(...(bindings as SQLInputValue[])) as SqlRow[];
  return {
    ...mapLegacyComparisonRows(rows, input.limit),
    sql,
    bindings,
  };
}

function explainQueryPlan(
  database: DatabaseSync,
  sql: string,
  bindings: readonly SQLInputValue[],
): string[] {
  return (
    database
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...(bindings as SQLInputValue[])) as Array<{ detail: string }>
  ).map(({ detail }) => detail);
}

function createFixture() {
  const database = createMigratedDatabase();
  const calls: Array<{ sql: string; bindings: Binding[] }> = [];
  const observations: DatabaseQueryObservation[] = [];
  const observationCompletions: Promise<void>[] = [];
  const env = {
    DB: {
      prepare: (sql: string) => ({
        bind: (...bindings: Binding[]) => ({
          all: async () => {
            calls.push({ sql, bindings });
            return {
              results: database
                .prepare(sql)
                .all(...(bindings as SQLInputValue[])) as SqlRow[],
            };
          },
        }),
      }),
    },
    DAILY_SALT_SECRET: "wave72-page-comparison-test-secret",
    INGEST_DO: {} as DurableObjectNamespace,
  } as unknown as Env;
  registerDatabaseQueryObserver(env.DB, {
    begin({ operation, statementCount }) {
      let finish!: () => void;
      observationCompletions.push(
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
      );
      return {
        statementIndexes: Array.from({ length: statementCount }, (_, index) =>
          operation === "batch" ? index : 0,
        ),
        includeBatchSummary: operation === "batch",
        record: (event) => {
          observations.push(event);
        },
        release: finish,
      };
    },
  });
  database
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .run(SITE_ID);
  database
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .run(FOREIGN_SITE_ID);
  const sitePk = Number(
    (
      database
        .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
        .get(SITE_ID) as { site_pk: number }
    ).site_pk,
  );
  const foreignSitePk = Number(
    (
      database
        .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
        .get(FOREIGN_SITE_ID) as { site_pk: number }
    ).site_pk,
  );
  const insert = database.prepare(`
    INSERT INTO visits (
      visit_id, site_id, site_pk, visitor_id, session_id, status, started_at,
      last_activity_at, pathname, hostname, duration_ms, title
    ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, 'example.test', ?, ?)
  `);
  let nextVisitId = 0;
  const seed = (
    prefix: string,
    site: string,
    siteKey: number,
    time: number,
    pathname: string | null,
    sessionId: string | null,
    visitorId: string | null,
    duration: number | null,
    title = pathname ?? "",
    visitIdOverride?: string,
  ) => {
    const visitId = visitIdOverride ?? `${prefix}-${nextVisitId}`;
    nextVisitId += 1;
    insert.run(
      visitId,
      site,
      siteKey,
      visitorId === null ? "__NULL_VISITOR__" : visitorId,
      sessionId === null ? "__NULL_SESSION__" : sessionId,
      time,
      time,
      pathname === null ? "__NULL_PATH__" : pathname,
      duration,
      title,
    );
    return visitId;
  };
  const ref = (
    index: number,
    path: string | null,
    session: string | null,
    visitor: string | null,
    duration: number | null,
    visitId?: string,
  ) =>
    seed(
      `r${index}`,
      SITE_ID,
      sitePk,
      REFERENCE_WINDOW.startMs + 100 + index,
      path,
      session,
      visitor,
      duration,
      undefined,
      visitId,
    );
  const current = (
    index: number,
    path: string | null,
    session: string | null,
    visitor: string | null,
    duration: number | null,
    visitId?: string,
  ) =>
    seed(
      `c${index}`,
      SITE_ID,
      sitePk,
      CURRENT_WINDOW.startMs + 100 + index,
      path,
      session,
      visitor,
      duration,
      undefined,
      visitId,
    );

  ref(1, "/docs", "shared-session", "visitor-1", 1_000);
  ref(2, "/docs", "shared-session", "visitor-1", 500);
  ref(3, "/docs", "solo-session", "visitor-2", -5);
  ref(4, "/docs", " ", " ", 12.5);
  ref(5, "/docs", "", "", null);
  ref(6, "/docs", null, null, 20);
  ref(7, " /docs ", "padded-ref", "padded-visitor", 100.25);
  ref(8, "/old", "old-session", "old-visitor", 75);
  ref(9, "  ", "blank-session", "blank-visitor", 200);
  ref(10, "", "empty-path-session", "empty-path-visitor", 300);
  ref(11, null, "null-path-session", "null-path-visitor", 400);

  current(1, "/docs", "shared-session", "visitor-1", 2_000);
  current(2, "/docs", "shared-session", "visitor-1", 250.5);
  current(3, "/docs", "solo-session", "visitor-2", 300);
  current(4, "/docs", " ", " ", 12.25);
  current(5, "/docs", "", "", null);
  current(6, "/docs", null, null, 15);
  current(7, " /docs ", "padded-current", "padded-visitor", 125.75);
  current(8, "/new", "new-session", "new-visitor", 33.5);
  current(9, "/a-tie", "tie-session", "tie-visitor", 10);
  current(10, "/b-tie", "tie-session", "tie-visitor", 10);
  current(11, " ", "blank-current-session", "blank-current-visitor", 100);
  current(12, "", "empty-current-session", "empty-current-visitor", 100);
  current(13, null, "null-current-session", "null-current-visitor", 100);
  current(16, "/literal%", "literal-percent", "literal-percent", 1);
  current(17, "/literal_under", "literal-underscore", "literal-underscore", 1);
  current(18, "/literal\\slash", "literal-backslash", "literal-backslash", 1);
  const longIdentity = (prefix: string, index: number) =>
    `${prefix}-${index}`.padEnd(128, "x");
  const longSessionIdentity = "s".repeat(128);
  const longVisitorIdentity = "v".repeat(128);
  const preparedCurrentVisitId = current(
    14,
    "/prepared",
    longSessionIdentity,
    longVisitorIdentity,
    41.5,
    longIdentity("prepared-current-visit", 0),
  );
  current(15, "/prepared", longSessionIdentity, longVisitorIdentity, 42.5);
  const preparedReferenceVisitId = ref(
    12,
    "/prepared",
    longSessionIdentity,
    longVisitorIdentity,
    21.25,
    longIdentity("prepared-reference-visit", 0),
  );
  ref(13, "/prepared", longSessionIdentity, longVisitorIdentity, 22.75);
  const currentPreparedIdentities = [
    {
      visitId: preparedCurrentVisitId,
      sessionId: longSessionIdentity,
      visitorId: longVisitorIdentity,
    },
    ...Array.from({ length: 3 }, (_, index) => {
      const identity = {
        visitId: longIdentity("prepared-current-visit", index + 1),
        sessionId: longIdentity("prepared-current-session", index),
        visitorId: longIdentity("prepared-current-visitor", index),
      };
      seed(
        `prepared-current-${index}`,
        SITE_ID,
        sitePk,
        CURRENT_WINDOW.startMs + 200 + index,
        "/prepared",
        identity.sessionId,
        identity.visitorId,
        5 + index,
        "Prepared",
        identity.visitId,
      );
      return identity;
    }),
  ];
  const referencePreparedIdentities = [
    {
      visitId: preparedReferenceVisitId,
      sessionId: longSessionIdentity,
      visitorId: longVisitorIdentity,
    },
    ...Array.from({ length: 3 }, (_, index) => {
      const identity = {
        visitId: longIdentity("prepared-reference-visit", index + 1),
        sessionId: longIdentity("prepared-reference-session", index),
        visitorId: longIdentity("prepared-reference-visitor", index),
      };
      seed(
        `prepared-reference-${index}`,
        SITE_ID,
        sitePk,
        REFERENCE_WINDOW.startMs + 200 + index,
        "/prepared",
        identity.sessionId,
        identity.visitorId,
        5 + index,
        "Prepared",
        identity.visitId,
      );
      return identity;
    }),
  ];
  const crossSiteIdentity = longIdentity("prepared-cross-site", 0);
  seed(
    "foreign",
    FOREIGN_SITE_ID,
    foreignSitePk,
    CURRENT_WINDOW.startMs + 100,
    "/docs",
    crossSiteIdentity,
    crossSiteIdentity,
    999,
    "Prepared foreign",
    longIdentity("prepared-foreign-visit", 0),
  );

  const columns = database.prepare("PRAGMA table_info(visits)").all() as Array<{
    name: string;
  }>;
  const viewColumns = columns.map(({ name }) => {
    const escaped = `"${name.replaceAll('"', '""')}"`;
    const sentinel =
      name === "visitor_id"
        ? "__NULL_VISITOR__"
        : name === "session_id"
          ? "__NULL_SESSION__"
          : name === "pathname"
            ? "__NULL_PATH__"
            : null;
    return sentinel
      ? `CASE WHEN ${escaped} = '${sentinel}' THEN NULL ELSE ${escaped} END AS ${escaped}`
      : escaped;
  });
  database.exec("ALTER TABLE visits RENAME TO visits_storage");
  database.exec(
    `CREATE VIEW visits AS SELECT ${viewColumns.join(", ")} FROM visits_storage`,
  );

  return {
    database,
    env,
    calls,
    observations,
    awaitObservations: () => Promise.all(observationCompletions),
    preparedCurrentVisitId,
    preparedReferenceVisitId,
    currentPreparedIdentities,
    referencePreparedIdentities,
    crossSiteIdentity,
    close: () => database.close(),
  };
}

interface MiniflareReadMeasurement {
  readonly sql: string;
  readonly bindingCount: number;
  readonly bindings: readonly SQLInputValue[];
  readonly resultCount: number;
  readonly rowsRead: number;
  readonly durationMs: number;
  readonly durationSource: "sql_duration_ms" | "meta.duration" | "wall";
  readonly wallMs: number;
}

function observeMiniflareDatabase(database: D1Database) {
  const reads: MiniflareReadMeasurement[] = [];
  const wrapStatement = (
    statement: D1PreparedStatement,
    sql: string,
    bindings: readonly SQLInputValue[],
  ): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property, receiver) {
        if (property === "bind")
          return (...values: unknown[]) =>
            wrapStatement(
              target.bind(...(values as SQLInputValue[])),
              sql,
              values as SQLInputValue[],
            );
        if (property === "all")
          return async (...args: unknown[]) => {
            const startedAt = performance.now();
            const result = (await Reflect.apply(
              Reflect.get(target, property, target) as (
                ...input: unknown[]
              ) => unknown,
              target,
              args,
            )) as {
              readonly results?: readonly unknown[];
              readonly meta?: {
                readonly rows_read?: unknown;
                readonly duration?: unknown;
                readonly timings?: { readonly sql_duration_ms?: unknown };
              };
            };
            const wallMs = performance.now() - startedAt;
            const rawRowsRead = result.meta?.rows_read;
            if (
              typeof rawRowsRead !== "number" ||
              !Number.isFinite(rawRowsRead)
            )
              throw new Error("wave72_miniflare_rows_read_unavailable");
            const rawSqlDuration = result.meta?.timings?.sql_duration_ms;
            const rawDuration = result.meta?.duration;
            const durationSource =
              typeof rawSqlDuration === "number" &&
              Number.isFinite(rawSqlDuration)
                ? "sql_duration_ms"
                : typeof rawDuration === "number" &&
                    Number.isFinite(rawDuration)
                  ? "meta.duration"
                  : "wall";
            reads.push({
              sql,
              bindingCount: bindings.length,
              bindings,
              resultCount: result.results?.length ?? 0,
              rowsRead: Math.max(0, Math.trunc(rawRowsRead)),
              durationMs:
                durationSource === "sql_duration_ms"
                  ? (rawSqlDuration as number)
                  : durationSource === "meta.duration"
                    ? (rawDuration as number)
                    : wallMs,
              durationSource,
              wallMs,
            });
            return result;
          };
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const tracedDatabase = new Proxy(database, {
    get(target, property, receiver) {
      if (property === "prepare")
        return (sql: string) => wrapStatement(target.prepare(sql), sql, []);
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { database: tracedDatabase as D1Database, reads };
}

function observeRuntimeQueries(database: D1Database) {
  const observations: DatabaseQueryObservation[] = [];
  let completions: Promise<void>[] = [];
  registerDatabaseQueryObserver(database, {
    begin({ statementCount }) {
      let release!: () => void;
      completions.push(
        new Promise<void>((resolveCompletion) => {
          release = resolveCompletion;
        }),
      );
      return {
        statementIndexes: Array.from(
          { length: statementCount },
          (_, index) => index,
        ),
        includeBatchSummary: true,
        record(event) {
          observations.push(event);
        },
        release,
      };
    },
  });
  return {
    observations,
    reset() {
      observations.length = 0;
      completions = [];
    },
    async settle() {
      await Promise.all(completions);
      completions = [];
    },
  };
}

async function applyMiniflareSchema(database: D1Database): Promise<void> {
  const schema = readFileSync(
    resolve(process.cwd(), "docs/schema.sql"),
    "utf8",
  );
  const statements = unstable_splitSqlQuery(schema).map((statement) =>
    database.prepare(statement),
  );
  for (let index = 0; index < statements.length; index += 50)
    await database.batch(statements.slice(index, index + 50));
}

async function copyPageFixtureToMiniflare(
  source: DatabaseSync,
  target: D1Database,
): Promise<number> {
  const sites = source
    .prepare("SELECT site_pk, site_id FROM site_identities ORDER BY site_pk")
    .all() as Array<{ readonly site_pk: number; readonly site_id: string }>;
  for (let index = 0; index < sites.length; index += 10)
    await target.batch(
      sites
        .slice(index, index + 10)
        .map((site) =>
          target
            .prepare(
              "INSERT INTO site_identities (site_pk, site_id) VALUES (?, ?)",
            )
            .bind(site.site_pk, site.site_id),
        ),
    );
  const sourceColumns = source
    .prepare("PRAGMA table_info(visits_storage)")
    .all() as Array<{ readonly name: string }>;
  const targetColumns = await target.prepare("PRAGMA table_info(visits)").all<{
    readonly name: string;
    readonly notnull: number;
    readonly dflt_value: unknown;
    readonly pk: number;
  }>();
  const targetColumnNames = new Set(
    targetColumns.results.map(({ name }) => name),
  );
  const columns = sourceColumns
    .map(({ name }) => name)
    .filter((name) => targetColumnNames.has(name));
  const requiredColumns = targetColumns.results
    .filter(
      ({ notnull, dflt_value, pk }) =>
        notnull === 1 && dflt_value === null && pk === 0,
    )
    .map(({ name }) => name);
  const missingRequiredColumns = requiredColumns.filter(
    (column) => !columns.includes(column),
  );
  if (missingRequiredColumns.length > 0)
    throw new Error(
      `wave72_miniflare_fixture_missing_columns:${missingRequiredColumns.join(",")}`,
    );
  const requiredQueryColumns = VISIT_SOURCE_COLUMNS.split(",")
    .map((column) => column.trim())
    .filter(Boolean);
  const missingQueryColumns = requiredQueryColumns.filter(
    (column) => !columns.includes(column),
  );
  if (missingQueryColumns.length > 0)
    throw new Error(
      `wave72_miniflare_query_columns_missing:${missingQueryColumns.join(",")}`,
    );
  const quotedColumns = columns.map(
    (column) => `"${column.replaceAll('"', '""')}"`,
  );
  const rows = source
    .prepare(
      `SELECT ${quotedColumns.join(", ")} FROM visits_storage ORDER BY visit_id`,
    )
    .all() as Array<Record<string, SQLInputValue>>;
  const insert = `INSERT INTO visits (${quotedColumns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
  for (let index = 0; index < rows.length; index += 10)
    await target.batch(
      rows.slice(index, index + 10).map((row) =>
        target.prepare(insert).bind(
          ...columns.map((column) => {
            const value = row[column] ?? null;
            if (column === "visitor_id" && value === "__NULL_VISITOR__")
              return "";
            if (column === "session_id" && value === "__NULL_SESSION__")
              return "";
            if (column === "pathname" && value === "__NULL_PATH__") return "";
            return value;
          }),
        ),
      ),
    );
  const site = sites.find(({ site_id }) => site_id === SITE_ID);
  if (!site) throw new Error("wave72_miniflare_site_missing");
  return site.site_pk;
}

async function copyFormalPayloadEventsToMiniflare(
  source: DatabaseSync,
  target: D1Database,
): Promise<void> {
  const events = source
    .prepare(
      `
      SELECT event_pk, event_id, site_id, visit_id, event_name_id,
        occurred_at, received_at, sequence, node_count, value_count, site_pk
      FROM custom_events
      WHERE event_id LIKE 'wave72-payload-%-event'
      ORDER BY event_pk
    `,
    )
    .all() as Array<Record<string, SQLInputValue> & { event_pk: number }>;
  if (events.length !== 2)
    throw new Error(`wave72_formal_payload_events_missing:${events.length}`);
  const eventPks = events.map(({ event_pk }) => event_pk);
  const placeholders = eventPks.map(() => "?").join(", ");
  const names = source
    .prepare(
      `
      SELECT DISTINCT n.id, n.site_id, n.name, n.last_seen_at, n.site_pk
      FROM custom_event_names n
      INNER JOIN custom_events e ON e.event_name_id = n.id
      WHERE e.event_pk IN (${placeholders})
      ORDER BY n.id
    `,
    )
    .all(...(eventPks as SQLInputValue[])) as Array<
    Record<string, SQLInputValue>
  >;
  const paths = source
    .prepare(
      `
      SELECT DISTINCT p.id, p.site_id, p.path, p.last_seen_at, p.site_pk
      FROM custom_event_json_paths p
      INNER JOIN custom_event_json_values v ON v.path_id = p.id
      WHERE v.event_pk IN (${placeholders})
      ORDER BY p.id
    `,
    )
    .all(...(eventPks as SQLInputValue[])) as Array<
    Record<string, SQLInputValue>
  >;
  const eventNodes = source
    .prepare(
      `
      SELECT event_pk, node_id, parent_node_id, key_id, path_id, value_type,
        member_order, array_index, depth
      FROM custom_event_json_nodes
      WHERE event_pk IN (${placeholders})
      ORDER BY event_pk, node_id
    `,
    )
    .all(...(eventPks as SQLInputValue[])) as Array<
    Record<string, SQLInputValue>
  >;
  const values = source
    .prepare(
      `
      SELECT event_pk, node_id, site_id, event_name_id, path_id, occurred_at,
        scope_node_id, value_type, string_value, string_hash, number_value,
        boolean_value, site_pk
      FROM custom_event_json_values
      WHERE event_pk IN (${placeholders})
      ORDER BY event_pk, node_id
    `,
    )
    .all(...(eventPks as SQLInputValue[])) as Array<
    Record<string, SQLInputValue>
  >;
  const copyRows = async (
    table: string,
    columns: readonly string[],
    rows: readonly Record<string, SQLInputValue>[],
  ) => {
    const insert = `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
    for (let index = 0; index < rows.length; index += 50) {
      const batch = rows
        .slice(index, index + 50)
        .map((row) =>
          target
            .prepare(insert)
            .bind(...columns.map((column) => row[column] ?? null)),
        );
      if (batch.length > 0) await target.batch(batch);
    }
  };
  await copyRows(
    "custom_event_names",
    ["id", "site_id", "name", "last_seen_at", "site_pk"],
    names,
  );
  await copyRows(
    "custom_event_json_paths",
    ["id", "site_id", "path", "last_seen_at", "site_pk"],
    paths,
  );
  await copyRows(
    "custom_events",
    [
      "event_pk",
      "event_id",
      "site_id",
      "visit_id",
      "event_name_id",
      "occurred_at",
      "received_at",
      "sequence",
      "node_count",
      "value_count",
      "site_pk",
    ],
    events,
  );
  await copyRows(
    "custom_event_json_nodes",
    [
      "event_pk",
      "node_id",
      "parent_node_id",
      "key_id",
      "path_id",
      "value_type",
      "member_order",
      "array_index",
      "depth",
    ],
    eventNodes,
  );
  await copyRows(
    "custom_event_json_values",
    [
      "event_pk",
      "node_id",
      "site_id",
      "event_name_id",
      "path_id",
      "occurred_at",
      "scope_node_id",
      "value_type",
      "string_value",
      "string_hash",
      "number_value",
      "boolean_value",
      "site_pk",
    ],
    values,
  );
}

async function insertUnrelatedPages(
  database: D1Database,
  sitePk: number,
): Promise<void> {
  const rows = Array.from({ length: 1_024 }, (_, index) => {
    const id = `wave72-unrelated-${index}`;
    return [
      id,
      `wave72-unrelated-visitor-${index}`,
      `wave72-unrelated-session-${index}`,
      1_900_000_000_000 + index,
      `/unrelated/${index}`,
    ];
  });
  await database
    .prepare(
      `
      INSERT INTO visits (
        visit_id, site_id, visitor_id, session_id, status, started_at,
        last_activity_at, pathname, hostname, site_pk
      )
      SELECT json_extract(value, '$[0]'), ?, json_extract(value, '$[1]'),
        json_extract(value, '$[2]'), 'closed', json_extract(value, '$[3]'),
        json_extract(value, '$[3]'), json_extract(value, '$[4]'),
        'pages-comparison.fixture', ?
      FROM json_each(?)
    `,
    )
    .bind(SITE_ID, sitePk, JSON.stringify(rows))
    .run();
}

function createPreparedIdentityFilters(
  fixture: ReturnType<typeof createFixture>,
  window: QueryWindow,
  scope: "event" | "session" | "visitor",
  identities: readonly {
    readonly visitId: string;
    readonly sessionId: string;
    readonly visitorId: string;
  }[],
  includePressureValues: boolean,
): FilterDocument {
  const prepared = prepareScopedQuery("pages", {
    context: siteQueryContext(SITE_ID, "private-dashboard"),
    time: queryWindowToTime(window),
    filters: EMPTY_FILTER_DOCUMENT,
    scopePreference: scope,
  } as never) as { readonly filters?: FilterDocument };
  const metadata = scopedFilterMetadata(prepared.filters);
  if (!prepared.filters || !metadata)
    throw new Error(`wave72_prepared_${scope}_identity_filter_missing`);
  const selectedIds = identities.map(({ visitId, sessionId, visitorId }) =>
    scope === "event" ? visitId : scope === "session" ? sessionId : visitorId,
  );
  const matches = includePressureValues
    ? [
        ...selectedIds.map((id) => ({ siteId: SITE_ID, id })),
        ...selectedIds.slice(0, 4).map((id) => ({ siteId: SITE_ID, id })),
        { siteId: SITE_ID, id: fixture.crossSiteIdentity },
        ...Array.from({ length: 119 }, (_, index) => ({
          siteId: SITE_ID,
          id: `prepared-missing-${scope}-${index}`.padEnd(128, "x"),
        })),
      ]
    : selectedIds.map((id) => ({ siteId: SITE_ID, id }));
  if (includePressureValues && matches.length !== 128)
    throw new Error("wave72_prepared_identity_count_invalid");
  return attachScopedFilterMetadata(prepared.filters, {
    ...metadata,
    plan: {
      ...metadata.plan,
      advancedMatches:
        scope === "event" ? { visitIds: matches } : { entityIds: matches },
    },
  });
}

function createPreparedPayloadExistsFilters(
  window: QueryWindow,
  scope: "event" | "session",
  count: number,
  siteId: string,
): FilterDocument {
  const filters = normalizeFilterDocument(
    {
      version: 1,
      root: {
        kind: "and",
        children: Array.from({ length: count }, (_unused, index) => ({
          kind: "condition" as const,
          target: {
            kind: "event-payload" as const,
            path: `/pages-comparison-payload/${index}`,
          },
          operator: "exists" as const,
        })),
      },
    } as never,
    analyticsFilterRegistry,
  );
  const prepared = prepareScopedQuery("pages", {
    context: siteQueryContext(siteId, "private-dashboard"),
    time: queryWindowToTime(window),
    filters,
    scopePreference: scope,
  } as never) as { readonly filters?: FilterDocument };
  if (!prepared.filters || !scopedFilterMetadata(prepared.filters))
    throw new Error(`wave72_prepared_payload_${scope}_filter_missing`);
  return prepared.filters;
}

function seedFormalPayloadBudgetPages(
  fixture: ReturnType<typeof createFixture>,
): void {
  const site = fixture.database
    .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
    .get(FOREIGN_SITE_ID) as { readonly site_pk: number };
  const insertVisit = fixture.database.prepare(`
    INSERT INTO visits_storage (
      visit_id, site_id, site_pk, visitor_id, session_id, status, started_at,
      last_activity_at, pathname, hostname, duration_ms, title
    ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, 'example.test', ?, ?)
  `);
  const currentAt = CURRENT_WINDOW.startMs + 100;
  const referenceAt = REFERENCE_WINDOW.startMs + 100;
  insertVisit.run(
    "wave72-payload-current",
    FOREIGN_SITE_ID,
    site.site_pk,
    "wave72-payload-current-visitor",
    "wave72-payload-current-session",
    currentAt,
    currentAt,
    "/payload-budget",
    2_000,
    "Payload budget",
  );
  insertVisit.run(
    "wave72-payload-reference-1",
    FOREIGN_SITE_ID,
    site.site_pk,
    "wave72-payload-reference-visitor",
    "wave72-payload-reference-session",
    referenceAt,
    referenceAt,
    "/payload-budget",
    1_000,
    "Payload budget",
  );
  insertVisit.run(
    "wave72-payload-reference-2",
    FOREIGN_SITE_ID,
    site.site_pk,
    "wave72-payload-reference-visitor",
    "wave72-payload-reference-session",
    referenceAt + 1,
    referenceAt + 1,
    "/payload-budget",
    500,
    "Payload budget",
  );

  const payloadPaths = Array.from(
    { length: 40 },
    (_unused, index) => `/pages-comparison-payload/${index}`,
  );
  const insertPayloadEvent = (eventId: string, visitId: string, at: number) => {
    fixture.database
      .prepare(
        `
        INSERT INTO custom_event_names (site_id, name, last_seen_at, site_pk)
        VALUES (?, 'wave72-formal-payload-budget', ?, ?)
        ON CONFLICT(site_pk, name) DO UPDATE SET last_seen_at = excluded.last_seen_at
      `,
      )
      .run(FOREIGN_SITE_ID, at, site.site_pk);
    const eventName = fixture.database
      .prepare(
        "SELECT id FROM custom_event_names WHERE site_pk = ? AND name = 'wave72-formal-payload-budget'",
      )
      .get(site.site_pk) as { readonly id: number };
    fixture.database
      .prepare(
        `
        INSERT INTO custom_events (
          event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
          received_at, sequence, node_count, value_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `,
      )
      .run(
        eventId,
        FOREIGN_SITE_ID,
        site.site_pk,
        visitId,
        eventName.id,
        at,
        at,
        payloadPaths.length,
        payloadPaths.length,
      );
    const event = fixture.database
      .prepare("SELECT event_pk FROM custom_events WHERE event_id = ?")
      .get(eventId) as { readonly event_pk: number };
    const insertPath = fixture.database.prepare(`
      INSERT INTO custom_event_json_paths (site_id, site_pk, path, last_seen_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(site_pk, path) DO UPDATE SET last_seen_at = excluded.last_seen_at
    `);
    const insertNode = fixture.database.prepare(`
      INSERT INTO custom_event_json_nodes (event_pk, node_id, path_id, value_type, depth)
      VALUES (?, ?, ?, 1, 1)
    `);
    const insertValue = fixture.database.prepare(`
      INSERT INTO custom_event_json_values (
        event_pk, node_id, site_id, site_pk, event_name_id, path_id,
        occurred_at, value_type, string_value
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'present')
    `);
    for (const [index, path] of payloadPaths.entries()) {
      insertPath.run(FOREIGN_SITE_ID, site.site_pk, path, at);
      const pathRow = fixture.database
        .prepare(
          "SELECT id FROM custom_event_json_paths WHERE site_pk = ? AND path = ?",
        )
        .get(site.site_pk, path) as { readonly id: number };
      const nodeId = index + 1;
      insertNode.run(event.event_pk, nodeId, pathRow.id);
      insertValue.run(
        event.event_pk,
        nodeId,
        FOREIGN_SITE_ID,
        site.site_pk,
        eventName.id,
        pathRow.id,
        at,
      );
    }
  };
  insertPayloadEvent(
    "wave72-payload-current-event",
    "wave72-payload-current",
    currentAt,
  );
  insertPayloadEvent(
    "wave72-payload-reference-event",
    "wave72-payload-reference-1",
    referenceAt,
  );
}

function sourceForPreparedFilters(
  window: QueryWindow,
  filters: FilterDocument,
  siteId = SITE_ID,
) {
  const metadata = scopedFilterMetadata(filters);
  if (!metadata) throw new Error("wave72_prepared_metadata_missing");
  return {
    siteId,
    queryTime: queryWindowToTime(window),
    filters,
    scopePlan: metadata.plan,
    preparedTimePolicy: "reader-window-v1" as const,
  };
}

function makePlanInput(
  metric: PagesDashboardMetric,
  sortBy: PagesDashboardSortBy,
  direction: "asc" | "desc",
  limit = 100,
  cursor?: PagesDashboardComparisonCursor | null,
  search?: string,
) {
  return {
    current: {
      siteId: SITE_ID,
      queryTime: createQueryTime(
        CURRENT_WINDOW.startMs,
        CURRENT_WINDOW.endExclusiveMs,
        CURRENT_WINDOW.timeZone,
        CURRENT_WINDOW.nowMs,
      ),
      filters: EMPTY_FILTER_DOCUMENT,
    },
    reference: {
      siteId: SITE_ID,
      queryTime: createQueryTime(
        REFERENCE_WINDOW.startMs,
        REFERENCE_WINDOW.endExclusiveMs,
        REFERENCE_WINDOW.timeZone,
        REFERENCE_WINDOW.nowMs,
      ),
      filters: EMPTY_FILTER_DOCUMENT,
    },
    metric,
    sortBy,
    direction,
    limit,
    ...(cursor ? { cursor } : {}),
    ...(search ? { search } : {}),
  };
}

async function runPlan(
  env: Env,
  input: Parameters<typeof buildPagesDashboardComparisonPlan>[0],
) {
  const plan = buildPagesDashboardComparisonPlan(input);
  return queryAnalyticsReportOutputRowsFromD1(
    env,
    plan,
    PAGES_DASHBOARD_COMPARISON_OUTPUT_ID,
  );
}

function compilePlanInput(
  input: Parameters<typeof buildPagesDashboardComparisonPlan>[0],
) {
  const plan = buildPagesDashboardComparisonPlan(input);
  const output = plan.outputs.find(
    (candidate) => candidate.id === PAGES_DASHBOARD_COMPARISON_OUTPUT_ID,
  );
  const siteIds = plan.context.subject.siteIds;
  if (!output || !Array.isArray(siteIds) || siteIds.length !== 1)
    throw new Error("wave72_comparison_compile_fixture_invalid");
  const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
    siteId: siteIds[0]!,
    time: plan.context.time,
  });
  const lowered = lowerer.lower(output);
  const relation = lowerer.projectOutput(
    lowered,
    output.fields.map(({ name, slot }) => ({ name, slot })),
  );
  return compileD1Query(lowerLogicalPlan(relation));
}

function mappedPlanRows(rows: SqlRow[]) {
  const number = (row: SqlRow, key: string) => Number(row[key] ?? 0);
  return rows.map((row) => ({
    current: {
      pathname: String(row.pathname ?? ""),
      views: number(row, "current_views"),
      sessions: number(row, "current_sessions"),
      visitors: number(row, "current_visitors"),
      bounces: number(row, "current_bounces"),
      totalDuration: number(row, "current_total_duration"),
      durationViews: number(row, "current_duration_views"),
    },
    reference: {
      pathname: String(row.pathname ?? ""),
      views: number(row, "reference_views"),
      sessions: number(row, "reference_sessions"),
      visitors: number(row, "reference_visitors"),
      bounces: number(row, "reference_bounces"),
      totalDuration: number(row, "reference_total_duration"),
      durationViews: number(row, "reference_duration_views"),
    },
  }));
}

function expectDashboardCore(
  actual: PagesDashboardResult,
  expected: Array<{
    current: PageCardAggregateRow;
    reference: PageCardAggregateRow;
  }>,
) {
  expect(
    actual.items.map((item) => ({
      pathname: item.pathname,
      metrics: item.metrics,
      reference: item.reference,
      change: item.change,
    })),
  ).toEqual(
    expected.map(({ current, reference }) => {
      const metrics = mapPageCardMetrics(current);
      const referenceMetrics = mapPageCardMetrics(reference);
      const changes = {
        views: {
          absolute: metrics.views - referenceMetrics.views,
          relative: percentChange(metrics.views, referenceMetrics.views),
        },
        visitors: {
          absolute: metrics.visitors - referenceMetrics.visitors,
          relative: percentChange(metrics.visitors, referenceMetrics.visitors),
        },
        sessions: {
          absolute: metrics.sessions - referenceMetrics.sessions,
          relative: percentChange(metrics.sessions, referenceMetrics.sessions),
        },
        bounceRate: {
          absolute: metrics.bounceRate - referenceMetrics.bounceRate,
          relative: percentChange(
            metrics.bounceRate,
            referenceMetrics.bounceRate,
          ),
        },
        pagesPerSession: {
          absolute: metrics.pagesPerSession - referenceMetrics.pagesPerSession,
          relative: percentChange(
            metrics.pagesPerSession,
            referenceMetrics.pagesPerSession,
          ),
        },
        avgDurationMs: {
          absolute: metrics.avgDurationMs - referenceMetrics.avgDurationMs,
          relative: percentChange(
            metrics.avgDurationMs,
            referenceMetrics.avgDurationMs,
          ),
        },
      };
      return {
        pathname: normalizePathname(current.pathname),
        metrics,
        reference: referenceMetrics,
        change: changes,
      };
    }),
  );
}

describe("Pages dashboard comparison Logical plan", () => {
  it("matches the frozen SQL oracle for every metric, comparison sort, and direction", async () => {
    const fixture = createFixture();
    try {
      for (const metric of [
        "views",
        "visitors",
        "sessions",
        "bounceRate",
        "pagesPerSession",
        "avgDurationMs",
      ] as const) {
        for (const sortBy of ["current", "reference", "change"] as const) {
          for (const direction of ["asc", "desc"] as const) {
            const input = makePlanInput(metric, sortBy, direction);
            const actual = mappedPlanRows(await runPlan(fixture.env, input));
            const expected = legacyComparisonOracle(fixture.database, {
              siteId: SITE_ID,
              current: CURRENT_WINDOW,
              currentFilters: EMPTY_FILTER_DOCUMENT,
              reference: REFERENCE_WINDOW,
              referenceFilters: EMPTY_FILTER_DOCUMENT,
              metric,
              sortBy,
              direction,
              limit: input.limit,
            });
            expect(actual, `${metric}/${sortBy}/${direction}`).toEqual(
              expected.rows,
            );
          }
        }
      }
      const unsorted = mappedPlanRows(
        await runPlan(fixture.env, makePlanInput("views", "current", "desc")),
      );
      expect(
        unsorted.find(({ current }) => current.pathname === "/docs"),
      ).toEqual({
        current: {
          pathname: "/docs",
          views: 6,
          sessions: 3,
          visitors: 3,
          bounces: 2,
          totalDuration: 2_577.75,
          durationViews: 0,
        },
        reference: {
          pathname: "/docs",
          views: 6,
          sessions: 3,
          visitors: 3,
          bounces: 2,
          totalDuration: 1_532.5,
          durationViews: 0,
        },
      });
      expect(unsorted.map(({ current }) => current.pathname)).toContain(
        " /docs ",
      );
      expect(
        unsorted.some(({ current }) => current.pathname.trim().length === 0),
      ).toBe(false);
      expect(
        unsorted
          .filter(({ current }) =>
            ["/a-tie", "/b-tie"].includes(current.pathname),
          )
          .map(({ current }) => current.bounces),
      ).toEqual([1, 1]);
      const representative = fixture.calls[0]!;
      const legacyRepresentative = legacyComparisonOracle(fixture.database, {
        siteId: SITE_ID,
        current: CURRENT_WINDOW,
        currentFilters: EMPTY_FILTER_DOCUMENT,
        reference: REFERENCE_WINDOW,
        referenceFilters: EMPTY_FILTER_DOCUMENT,
        metric: "views",
        sortBy: "current",
        direction: "asc",
        limit: 100,
      });
      const logicalPlan = explainQueryPlan(
        fixture.database,
        representative.sql,
        representative.bindings,
      );
      const legacyPlan = explainQueryPlan(
        fixture.database,
        legacyRepresentative.sql,
        legacyRepresentative.bindings,
      );
      await fixture.awaitObservations();
      expect(fixture.calls).toHaveLength(37);
      expect(fixture.observations).toHaveLength(37);
      expect(
        fixture.observations[0],
        "the generic runtime reports one budgeted statement with a stable physical-plan hash",
      ).toMatchObject({
        operation: "all",
        status: "success",
        sqlBytes: Buffer.byteLength(representative.sql, "utf8"),
        bindings: representative.bindings.length,
        physicalPlanHash: expect.stringMatching(/^v\d+:[a-f0-9]{64}$/u),
      });
      expect(Buffer.byteLength(representative.sql, "utf8")).toBeLessThanOrEqual(
        D1_MAX_SQL_UTF8_BYTES,
      );
      expect(representative.bindings.length).toBeLessThanOrEqual(
        D1_MAX_BOUND_PARAMETERS,
      );
      expect(
        Buffer.byteLength(legacyRepresentative.sql, "utf8"),
      ).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
      expect(legacyRepresentative.bindings.length).toBeLessThanOrEqual(
        D1_MAX_BOUND_PARAMETERS,
      );
      expect(
        logicalPlan.filter((detail) => /\bSCAN\b/u.test(detail)).length,
      ).toBeLessThan(
        legacyPlan.filter((detail) => /\bSCAN\b/u.test(detail)).length,
      );
      expect(
        logicalPlan.some((detail) =>
          detail.includes("idx_visits_site_pk_started_at"),
        ),
      ).toBe(true);
      expect(representative.sql).not.toContain("current_metrics AS");
      expect(representative.sql).toContain("UNION ALL");
    } finally {
      fixture.close();
    }
  });

  it.each(["%", "_", "\\", " DOCS "])(
    "preserves escaped, case-folded dashboard search for %j",
    async (search) => {
      const fixture = createFixture();
      try {
        const input = makePlanInput(
          "views",
          "current",
          "desc",
          100,
          null,
          search,
        );
        const actual = mappedPlanRows(await runPlan(fixture.env, input));
        const expected = legacyComparisonOracle(fixture.database, {
          siteId: SITE_ID,
          current: CURRENT_WINDOW,
          currentFilters: EMPTY_FILTER_DOCUMENT,
          reference: REFERENCE_WINDOW,
          referenceFilters: EMPTY_FILTER_DOCUMENT,
          metric: "views",
          sortBy: "current",
          direction: "desc",
          limit: input.limit,
          search,
        });
        expect(actual).toEqual(expected.rows);
      } finally {
        fixture.close();
      }
    },
  );

  it.each([
    ["event", "session"],
    ["session", "visitor"],
    ["visitor", "event"],
  ] as const)(
    "keeps independently prepared %s and %s domains for 128-character identities",
    async (currentScope, referenceScope) => {
      const fixture = createFixture();
      try {
        const prepare = (
          window: QueryWindow,
          scope: "event" | "session" | "visitor",
          identities: readonly {
            visitId: string;
            sessionId: string;
            visitorId: string;
          }[],
        ): FilterDocument => {
          const prepared = prepareScopedQuery("pages", {
            context: siteQueryContext(SITE_ID, "private-dashboard"),
            time: queryWindowToTime(window),
            filters: EMPTY_FILTER_DOCUMENT,
            scopePreference: scope,
          } as never) as { filters?: FilterDocument };
          const metadata = scopedFilterMetadata(prepared.filters);
          if (!prepared.filters || !metadata)
            throw new Error("wave72_prepared_page_scope_missing");
          const selectedIds = identities.map(
            ({ visitId, sessionId, visitorId }) =>
              scope === "event"
                ? visitId
                : scope === "session"
                  ? sessionId
                  : visitorId,
          );
          const identities128 = [
            ...selectedIds.map((id) => ({ siteId: SITE_ID, id })),
            ...selectedIds.slice(0, 4).map((id) => ({ siteId: SITE_ID, id })),
            { siteId: SITE_ID, id: fixture.crossSiteIdentity },
            ...Array.from({ length: 119 }, (_, index) => ({
              siteId: SITE_ID,
              id: `${`prepared-missing-${scope}-${index}`.padEnd(128, "x")}`,
            })),
          ];
          if (identities128.length !== 128)
            throw new Error("wave72_prepared_identity_count_invalid");
          return attachScopedFilterMetadata(prepared.filters, {
            ...metadata,
            plan: {
              ...metadata.plan,
              advancedMatches:
                scope === "event"
                  ? { visitIds: identities128 }
                  : { entityIds: identities128 },
            },
          });
        };
        const currentFilters = prepare(
          CURRENT_WINDOW,
          currentScope,
          fixture.currentPreparedIdentities,
        );
        const referenceFilters = prepare(
          REFERENCE_WINDOW,
          referenceScope,
          fixture.referencePreparedIdentities,
        );
        const source = (window: QueryWindow, filters: FilterDocument) => {
          const metadata = scopedFilterMetadata(filters)!;
          return {
            siteId: SITE_ID,
            queryTime: queryWindowToTime(window),
            filters,
            scopePlan: metadata.plan,
            preparedTimePolicy: "reader-window-v1" as const,
          };
        };
        const planInput = {
          current: source(CURRENT_WINDOW, currentFilters),
          reference: source(REFERENCE_WINDOW, referenceFilters),
          metric: "views" as const,
          sortBy: "current" as const,
          direction: "desc" as const,
          limit: 10,
        };
        const actual = mappedPlanRows(await runPlan(fixture.env, planInput));
        const expected = legacyComparisonOracle(fixture.database, {
          siteId: SITE_ID,
          current: CURRENT_WINDOW,
          currentFilters,
          reference: REFERENCE_WINDOW,
          referenceFilters,
          metric: "views",
          sortBy: "current",
          direction: "desc",
          limit: 10,
        });
        const actualStatement = fixture.calls[0]!;
        const actualSqlBytes = Buffer.byteLength(actualStatement.sql, "utf8");
        const legacySqlBytes = Buffer.byteLength(expected.sql, "utf8");
        const logicalPlan = explainQueryPlan(
          fixture.database,
          actualStatement.sql,
          actualStatement.bindings,
        );
        const legacyPlan = explainQueryPlan(
          fixture.database,
          expected.sql,
          expected.bindings,
        );
        expect(actualSqlBytes).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
        expect(actualStatement.bindings.length).toBeLessThanOrEqual(
          D1_MAX_BOUND_PARAMETERS,
        );
        expect(legacySqlBytes).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
        // The legacy SQL remains a SQLite-only semantic oracle here: expanding
        // 128 prepared identities exceeds the production D1 binding budget.
        expect(expected.bindings.length).toBeGreaterThan(
          D1_MAX_BOUND_PARAMETERS,
        );
        expect(logicalPlan).not.toHaveLength(0);
        expect(legacyPlan).not.toHaveLength(0);
        expect(
          logicalPlan.some((detail) =>
            detail.includes("idx_visits_site_pk_started_at"),
          ),
        ).toBe(true);
        expect(actual).toEqual(expected.rows);
        expect(actual).toEqual([
          {
            current: {
              pathname: "/prepared",
              views: currentScope === "event" ? 4 : 5,
              sessions: 4,
              visitors: 4,
              bounces: currentScope === "event" ? 4 : 3,
              totalDuration: currentScope === "event" ? 59.5 : 102,
              durationViews: 0,
            },
            reference: {
              pathname: "/prepared",
              views: referenceScope === "event" ? 4 : 5,
              sessions: 4,
              visitors: 4,
              bounces: referenceScope === "event" ? 4 : 3,
              totalDuration: referenceScope === "event" ? 39.25 : 62,
              durationViews: 0,
            },
          },
        ]);
        expect(fixture.calls).toHaveLength(1);
        expect(fixture.calls[0]!.bindings.length).toBeLessThanOrEqual(
          D1_MAX_BOUND_PARAMETERS,
        );
      } finally {
        fixture.close();
      }
    },
  );

  it("preserves signed public first/after pages and the known nullable-change cursor omission", async () => {
    const fixture = createFixture();
    try {
      const comparison = {
        current: {
          time: createQueryTime(
            CURRENT_WINDOW.startMs,
            CURRENT_WINDOW.endExclusiveMs,
            CURRENT_WINDOW.timeZone,
            CURRENT_WINDOW.nowMs,
          ),
          filters: EMPTY_FILTER_DOCUMENT,
        },
        reference: {
          time: createQueryTime(
            REFERENCE_WINDOW.startMs,
            REFERENCE_WINDOW.endExclusiveMs,
            REFERENCE_WINDOW.timeZone,
            REFERENCE_WINDOW.nowMs,
          ),
          filters: EMPTY_FILTER_DOCUMENT,
        },
        metric: "views" as const,
        sortBy: "current" as const,
        direction: "desc" as const,
      };
      const input = {
        window: CURRENT_WINDOW,
        filters: EMPTY_FILTER_DOCUMENT,
        interval: "day" as const,
        page: { limit: 2, cursor: null as string | null },
        comparison,
      };
      const expectedFirst = legacyComparisonOracle(fixture.database, {
        siteId: SITE_ID,
        current: CURRENT_WINDOW,
        currentFilters: EMPTY_FILTER_DOCUMENT,
        reference: REFERENCE_WINDOW,
        referenceFilters: EMPTY_FILTER_DOCUMENT,
        metric: comparison.metric,
        sortBy: comparison.sortBy,
        direction: comparison.direction,
        limit: 2,
      });
      const first = await queryPagesDashboard(fixture.env, SITE_ID, input);
      expectDashboardCore(first, expectedFirst.rows);
      expect(first.pagination).toMatchObject({
        returned: 2,
        hasMore: true,
        nextCursor: expect.any(String),
      });
      expect(fixture.calls).toHaveLength(3);
      fixture.calls.length = 0;

      const last = expectedFirst.rows.at(-1)!;
      const lastCurrent = mapPageCardMetrics(last.current);
      const lastReference = mapPageCardMetrics(last.reference);
      const cursor: PagesDashboardComparisonCursor = {
        sortClass: lastReference.views === 0 && lastCurrent.views > 0 ? 1 : 0,
        primary: lastCurrent.views,
        secondary: lastReference.views,
        pathname: last.current.pathname,
      };
      const expectedAfter = legacyComparisonOracle(fixture.database, {
        siteId: SITE_ID,
        current: CURRENT_WINDOW,
        currentFilters: EMPTY_FILTER_DOCUMENT,
        reference: REFERENCE_WINDOW,
        referenceFilters: EMPTY_FILTER_DOCUMENT,
        metric: comparison.metric,
        sortBy: comparison.sortBy,
        direction: comparison.direction,
        limit: 2,
        cursor,
      });
      const after = await queryPagesDashboard(fixture.env, SITE_ID, {
        ...input,
        page: { limit: 2, cursor: first.pagination.nextCursor },
      });
      expectDashboardCore(after, expectedAfter.rows);
      expect(fixture.calls).toHaveLength(3);

      const change = {
        ...comparison,
        sortBy: "change" as const,
        direction: "desc" as const,
      };
      const changeRows = legacyComparisonOracle(fixture.database, {
        siteId: SITE_ID,
        current: CURRENT_WINDOW,
        currentFilters: EMPTY_FILTER_DOCUMENT,
        reference: REFERENCE_WINDOW,
        referenceFilters: EMPTY_FILTER_DOCUMENT,
        metric: change.metric,
        sortBy: change.sortBy,
        direction: change.direction,
        limit: 20,
      });
      expect(
        changeRows.rows.filter(
          ({ current, reference }) =>
            current.views > 0 && reference.views === 0,
        ).length,
      ).toBeGreaterThanOrEqual(3);
      const changeFirst = await queryPagesDashboard(fixture.env, SITE_ID, {
        ...input,
        comparison: change,
        page: { limit: 1, cursor: null },
      });
      const changeLast = changeRows.rows[0]!;
      const currentMetrics = mapPageCardMetrics(changeLast.current);
      const referenceMetrics = mapPageCardMetrics(changeLast.reference);
      const changeCursor: PagesDashboardComparisonCursor = {
        sortClass: 1,
        primary: 0,
        secondary: 0,
        pathname: changeLast.current.pathname,
      };
      const legacyAfterChange = legacyComparisonOracle(fixture.database, {
        siteId: SITE_ID,
        current: CURRENT_WINDOW,
        currentFilters: EMPTY_FILTER_DOCUMENT,
        reference: REFERENCE_WINDOW,
        referenceFilters: EMPTY_FILTER_DOCUMENT,
        metric: change.metric,
        sortBy: change.sortBy,
        direction: change.direction,
        limit: 20,
        cursor: changeCursor,
      });
      const afterChange = await queryPagesDashboard(fixture.env, SITE_ID, {
        ...input,
        comparison: change,
        page: { limit: 20, cursor: changeFirst.pagination.nextCursor },
      });
      expectDashboardCore(afterChange, legacyAfterChange.rows);
      expect(afterChange.items.some((item) => item.pathname === "/new")).toBe(
        false,
      );
    } finally {
      fixture.close();
    }
  });
});

describe("Pages dashboard comparison cost in Miniflare D1", () => {
  it("keeps old/new DTOs stable and bounds actual D1 reads after 1,024 unrelated pages", async () => {
    const fixture = createFixture();
    seedFormalPayloadBudgetPages(fixture);
    const configDirectory = mkdtempSync(
      join(tmpdir(), "pages-comparison-miniflare-"),
    );
    const configPath = join(configDirectory, "wrangler.toml");
    writeFileSync(
      configPath,
      [
        'name = "pages-comparison-cost-test"',
        'compatibility_date = "2026-03-01"',
        "[[d1_databases]]",
        'binding = "DB"',
        'database_name = "pages_comparison_cost_test"',
        'database_id = "local-test"',
        "",
      ].join("\n"),
    );
    let disposePlatform: (() => Promise<void>) | undefined;
    try {
      const platform = await getPlatformProxy<Env>({
        configPath,
        envFiles: [],
        persist: false,
        remoteBindings: false,
      });
      disposePlatform = platform.dispose;
      await applyMiniflareSchema(platform.env.DB);
      const sitePk = await copyPageFixtureToMiniflare(
        fixture.database,
        platform.env.DB,
      );
      await copyFormalPayloadEventsToMiniflare(
        fixture.database,
        platform.env.DB,
      );
      const miniflareTrace = observeMiniflareDatabase(platform.env.DB);
      const runtimeTrace = observeRuntimeQueries(miniflareTrace.database);
      const env = {
        ...platform.env,
        DB: miniflareTrace.database,
        DAILY_SALT_SECRET: "wave72-miniflare-pages-dashboard-secret",
        INGEST_DO: {} as DurableObjectNamespace,
      } as unknown as Env;

      const defaultInput = makePlanInput("views", "current", "desc", 5);
      const preparedCurrent = createPreparedIdentityFilters(
        fixture,
        CURRENT_WINDOW,
        "event",
        fixture.currentPreparedIdentities,
        false,
      );
      const preparedReference = createPreparedIdentityFilters(
        fixture,
        REFERENCE_WINDOW,
        "session",
        fixture.referencePreparedIdentities,
        false,
      );
      const pressureCurrent = createPreparedIdentityFilters(
        fixture,
        CURRENT_WINDOW,
        "event",
        fixture.currentPreparedIdentities,
        true,
      );
      const pressureReference = createPreparedIdentityFilters(
        fixture,
        REFERENCE_WINDOW,
        "session",
        fixture.referencePreparedIdentities,
        true,
      );
      const formalPayloadCurrent = createPreparedPayloadExistsFilters(
        CURRENT_WINDOW,
        "event",
        40,
        FOREIGN_SITE_ID,
      );
      const formalPayloadReference = createPreparedPayloadExistsFilters(
        REFERENCE_WINDOW,
        "session",
        40,
        FOREIGN_SITE_ID,
      );
      const makePreparedPlanInput = (
        currentFilters: FilterDocument,
        referenceFilters: FilterDocument,
      ) => ({
        current: sourceForPreparedFilters(CURRENT_WINDOW, currentFilters),
        reference: sourceForPreparedFilters(REFERENCE_WINDOW, referenceFilters),
        metric: "views" as const,
        sortBy: "current" as const,
        direction: "desc" as const,
        limit: 5,
      });
      const formalPayloadPlanInput = {
        current: sourceForPreparedFilters(
          CURRENT_WINDOW,
          formalPayloadCurrent,
          FOREIGN_SITE_ID,
        ),
        reference: sourceForPreparedFilters(
          REFERENCE_WINDOW,
          formalPayloadReference,
          FOREIGN_SITE_ID,
        ),
        metric: "views" as const,
        sortBy: "current" as const,
        direction: "desc" as const,
        limit: 5,
      };
      const formalPayloadAfterCursor = {
        sortClass: 0,
        primary: 1,
        secondary: 1,
        pathname: "/payload-budget",
      };
      const formalPayloadMetricInputs = (
        [
          "views",
          "visitors",
          "sessions",
          "bounceRate",
          "pagesPerSession",
          "avgDurationMs",
        ] as const
      ).flatMap((metric) => [
        { ...formalPayloadPlanInput, metric },
        {
          ...formalPayloadPlanInput,
          metric,
          cursor: formalPayloadAfterCursor,
        },
      ]);
      const formalPayloadSortedCursorInputs = (
        ["current", "reference", "change"] as const
      ).map((sortBy) => ({
        ...formalPayloadPlanInput,
        metric: "views" as const,
        sortBy,
        cursor: formalPayloadAfterCursor,
      }));
      const formalPayloadCompileInputs = [
        ...formalPayloadMetricInputs,
        ...formalPayloadSortedCursorInputs,
      ];
      const formalPayloadCompileBudgets = formalPayloadCompileInputs.map(
        (input) => {
          const compiled = compilePlanInput(input);
          const sqlBytes = Buffer.byteLength(compiled.sql, "utf8");
          const bindings = compiled.bindings ?? [];
          expect(sqlBytes).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
          expect(bindings.length).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
          expect(bindings.length).toBeGreaterThan(40);
          return {
            sqlBytes,
            bindings: bindings.length,
          };
        },
      );
      expect(formalPayloadCompileBudgets).toHaveLength(15);
      const formalPayloadExpected = [
        {
          current: {
            pathname: "/payload-budget",
            views: 1,
            sessions: 1,
            visitors: 1,
            bounces: 1,
            totalDuration: 2_000,
            durationViews: 0,
          },
          reference: {
            pathname: "/payload-budget",
            views: 2,
            sessions: 1,
            visitors: 1,
            bounces: 0,
            totalDuration: 1_500,
            durationViews: 0,
          },
        },
      ];
      const scenarios = [
        {
          name: "default",
          input: defaultInput,
          currentFilters: EMPTY_FILTER_DOCUMENT,
          referenceFilters: EMPTY_FILTER_DOCUMENT,
          legacyExecutable: true,
        },
        {
          name: "prepared-event-session-four-identities",
          input: makePreparedPlanInput(preparedCurrent, preparedReference),
          currentFilters: preparedCurrent,
          referenceFilters: preparedReference,
          legacyExecutable: true,
        },
        {
          name: "prepared-event-session-128-values",
          input: makePreparedPlanInput(pressureCurrent, pressureReference),
          currentFilters: pressureCurrent,
          referenceFilters: pressureReference,
          legacyExecutable: false,
        },
      ] as const;
      const legacyByScenario = new Map<
        string,
        ReturnType<typeof legacyComparisonOracle>
      >();
      for (const scenario of scenarios) {
        const legacy = legacyComparisonOracle(fixture.database, {
          siteId: SITE_ID,
          current: CURRENT_WINDOW,
          currentFilters: scenario.currentFilters,
          reference: REFERENCE_WINDOW,
          referenceFilters: scenario.referenceFilters,
          metric: "views",
          sortBy: "current",
          direction: "desc",
          limit: 5,
        });
        legacyByScenario.set(scenario.name, legacy);
        expect(legacy.rows.length, scenario.name).toBeGreaterThan(0);
        expect(
          legacy.bindings.length <= D1_MAX_BOUND_PARAMETERS,
          `${scenario.name} legacy D1 feasibility`,
        ).toBe(scenario.legacyExecutable);
      }

      const runLegacy = async (scenarioName: string) => {
        const legacy = legacyByScenario.get(scenarioName);
        if (!legacy) throw new Error("wave72_miniflare_legacy_missing");
        miniflareTrace.reads.length = 0;
        const result = await miniflareTrace.database
          .prepare(legacy.sql)
          .bind(...legacy.bindings)
          .all<SqlRow>();
        expect(miniflareTrace.reads).toHaveLength(1);
        expect(result.results).toBeDefined();
        return {
          rows: result.results ?? [],
          sample: miniflareTrace.reads[0]!,
          rawSqlSha256: createHash("sha256").update(legacy.sql).digest("hex"),
        };
      };
      const runLogical = async (scenario: (typeof scenarios)[number]) => {
        miniflareTrace.reads.length = 0;
        runtimeTrace.reset();
        const rows = await runPlan(env, scenario.input);
        await runtimeTrace.settle();
        expect(miniflareTrace.reads).toHaveLength(1);
        expect(runtimeTrace.observations).toHaveLength(1);
        const sample = miniflareTrace.reads[0]!;
        const observation = runtimeTrace.observations[0]!;
        const sqlBytes = Buffer.byteLength(sample.sql, "utf8");
        expect(sqlBytes).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
        expect(sample.bindingCount).toBeLessThanOrEqual(
          D1_MAX_BOUND_PARAMETERS,
        );
        expect(observation.sqlBytes).toBe(sqlBytes);
        expect(observation.bindings).toBe(sample.bindingCount);
        expect(observation.rowsRead).toBe(sample.rowsRead);
        expect(observation.physicalPlanHash).toMatch(/^v\d+:/u);
        return {
          rows,
          sample,
          observation,
          rawSqlSha256: createHash("sha256").update(sample.sql).digest("hex"),
        };
      };
      const publicInput = (scenario: (typeof scenarios)[number]) => ({
        window: CURRENT_WINDOW,
        filters: scenario.currentFilters,
        interval: "day" as const,
        page: { limit: 5, cursor: null },
        comparison: {
          current: {
            time: queryWindowToTime(CURRENT_WINDOW),
            filters: scenario.currentFilters,
          },
          reference: {
            time: queryWindowToTime(REFERENCE_WINDOW),
            filters: scenario.referenceFilters,
          },
          metric: "views" as const,
          sortBy: "current" as const,
          direction: "desc" as const,
        },
      });
      const formalPayloadPublicInput = {
        window: CURRENT_WINDOW,
        filters: formalPayloadCurrent,
        interval: "day" as const,
        page: { limit: 5, cursor: null },
        comparison: {
          current: {
            time: queryWindowToTime(CURRENT_WINDOW),
            filters: formalPayloadCurrent,
          },
          reference: {
            time: queryWindowToTime(REFERENCE_WINDOW),
            filters: formalPayloadReference,
          },
          metric: "views" as const,
          sortBy: "current" as const,
          direction: "desc" as const,
        },
      };
      const formalPayloadMeasurements = new Map<
        "baseline" | "grown",
        MiniflareReadMeasurement[]
      >();
      const formalPayloadDtos = new Map<
        "baseline" | "grown",
        PagesDashboardResult
      >();
      const runFormalPayload = async () => {
        miniflareTrace.reads.length = 0;
        runtimeTrace.reset();
        const rows = await runPlan(env, formalPayloadPlanInput);
        await runtimeTrace.settle();
        expect(miniflareTrace.reads).toHaveLength(1);
        expect(runtimeTrace.observations).toHaveLength(1);
        const sample = miniflareTrace.reads[0]!;
        const observation = runtimeTrace.observations[0]!;
        const sqlBytes = Buffer.byteLength(sample.sql, "utf8");
        expect(sqlBytes).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
        expect(sample.bindingCount).toBeLessThanOrEqual(
          D1_MAX_BOUND_PARAMETERS,
        );
        expect(observation.sqlBytes).toBe(sqlBytes);
        expect(observation.bindings).toBe(sample.bindingCount);
        expect(observation.rowsRead).toBe(sample.rowsRead);
        expect(observation.physicalPlanHash).toMatch(/^v\d+:/u);
        expect(mappedPlanRows(rows)).toEqual(formalPayloadExpected);
        return { sample, observation };
      };
      const measureFormalPayload = async (phase: "baseline" | "grown") => {
        const samples: MiniflareReadMeasurement[] = [];
        const planHashes: string[] = [];
        const sqlHashes: string[] = [];
        for (let iteration = 0; iteration < 3; iteration += 1) {
          const result = await runFormalPayload();
          samples.push(result.sample);
          planHashes.push(result.observation.physicalPlanHash ?? "");
          sqlHashes.push(
            result.sample.sql
              ? createHash("sha256").update(result.sample.sql).digest("hex")
              : "",
          );
        }
        const dto = await queryPagesDashboard(
          env,
          FOREIGN_SITE_ID,
          formalPayloadPublicInput,
        );
        await runtimeTrace.settle();
        expectDashboardCore(dto, formalPayloadExpected);
        expect(dto.pagination.returned).toBe(1);
        for (const item of dto.items) {
          expect(item.titles).toEqual(expect.any(Array));
          expect(item.trend).toEqual(expect.any(Array));
          expect(item.referenceTrend).toEqual(expect.any(Array));
          expect(item.changeRates).toEqual(
            Object.fromEntries(
              Object.entries(item.change ?? {}).map(([key, change]) => [
                key,
                change.relative,
              ]),
            ),
          );
        }
        formalPayloadMeasurements.set(phase, samples);
        formalPayloadDtos.set(phase, dto);
        console.info(
          "wave72_pages_comparison_formal_payload40_miniflare_cost",
          JSON.stringify({
            phase,
            unrelatedPages: phase === "baseline" ? 0 : 1_024,
            actualReads: samples.map(({ rowsRead }) => rowsRead),
            durationMs: samples.map(({ durationMs }) => durationMs),
            durationSource: samples.map(({ durationSource }) => durationSource),
            wallMs: samples.map(({ wallMs }) => wallMs),
            sqlBytes: samples.map(({ sql }) => Buffer.byteLength(sql, "utf8")),
            bindings: samples.map(({ bindingCount }) => bindingCount),
            physicalPlanHashes: planHashes,
            sqlHashes,
            dtoItemCount: dto.items.length,
          }),
        );
      };
      const publicDtos = new Map<string, PagesDashboardResult>();
      const measurements = new Map<
        string,
        {
          readonly legacy: MiniflareReadMeasurement[];
          readonly logical: MiniflareReadMeasurement[];
        }
      >();

      const measurePhase = async (phase: "baseline" | "grown") => {
        for (const scenario of scenarios) {
          const expectedCore = legacyByScenario.get(scenario.name)!.rows;
          const legacySamples: MiniflareReadMeasurement[] = [];
          const logicalSamples: MiniflareReadMeasurement[] = [];
          const plannedRows: SqlRow[][] = [];
          const legacyRows: SqlRow[][] = [];
          for (let iteration = 0; iteration < 3; iteration += 1) {
            if (!scenario.legacyExecutable) {
              const logical = await runLogical(scenario);
              logicalSamples.push(logical.sample);
              plannedRows.push(logical.rows);
              expect(mappedPlanRows(logical.rows).slice(0, 5)).toEqual(
                expectedCore,
              );
              continue;
            }
            const order =
              iteration % 2 === 0
                ? (["legacy", "logical"] as const)
                : (["logical", "legacy"] as const);
            for (const operation of order) {
              if (operation === "legacy") {
                const legacy = await runLegacy(scenario.name);
                legacySamples.push(legacy.sample);
                legacyRows.push(legacy.rows);
                expect(mapLegacyComparisonRows(legacy.rows, 5).rows).toEqual(
                  expectedCore,
                );
              } else {
                const logical = await runLogical(scenario);
                logicalSamples.push(logical.sample);
                plannedRows.push(logical.rows);
                expect(mappedPlanRows(logical.rows).slice(0, 5)).toEqual(
                  expectedCore,
                );
              }
            }
          }
          expect(plannedRows).toHaveLength(3);
          if (scenario.legacyExecutable) expect(legacyRows).toHaveLength(3);
          const dto = await queryPagesDashboard(
            env,
            SITE_ID,
            publicInput(scenario),
          );
          await runtimeTrace.settle();
          expect(dto.items.length, `${phase}/${scenario.name}`).toBeGreaterThan(
            0,
          );
          expectDashboardCore(dto, expectedCore);
          expect(dto.pagination.returned).toBe(expectedCore.length);
          for (const item of dto.items) {
            expect(item.titles).toEqual(expect.any(Array));
            expect(item.trend).toEqual(expect.any(Array));
            expect(item.referenceTrend).toEqual(expect.any(Array));
            expect(item.changeRates).toEqual(
              Object.fromEntries(
                Object.entries(item.change ?? {}).map(([key, change]) => [
                  key,
                  change.relative,
                ]),
              ),
            );
          }
          publicDtos.set(`${phase}:${scenario.name}`, dto);
          measurements.set(`${phase}:${scenario.name}`, {
            legacy: legacySamples,
            logical: logicalSamples,
          });

          const representative = scenario.legacyExecutable
            ? legacyByScenario.get(scenario.name)!
            : null;
          const logical = await runLogical(scenario);
          const logicalGraph = explainQueryPlan(
            fixture.database,
            logical.sample.sql,
            logical.sample.bindings,
          );
          expect(
            logicalGraph.length,
            `${scenario.name} SQLite EQP`,
          ).toBeGreaterThan(0);
          const legacyGraph = representative
            ? explainQueryPlan(
                fixture.database,
                representative.sql,
                representative.bindings,
              )
            : explainQueryPlan(
                fixture.database,
                legacyByScenario.get(scenario.name)!.sql,
                legacyByScenario.get(scenario.name)!.bindings,
              );
          const mapGraph = (details: readonly string[]) => ({
            deduplicatedPlanKindsOnly: true,
            baseVisitsIndexAccesses: Array.from(
              new Set(
                details.filter((detail) =>
                  /\bvisits(?:_storage)?\b.*\bUSING (?:COVERING )?INDEX\b/u.test(
                    detail,
                  ),
                ),
              ),
            ),
            currentWindowCteOperations: Array.from(
              new Set(
                details.filter((detail) => /\bcurrent_visits\b/u.test(detail)),
              ),
            ),
            referenceWindowCteOperations: Array.from(
              new Set(
                details.filter((detail) =>
                  /\breference_visits\b/u.test(detail),
                ),
              ),
            ),
            otherNamedStages: Array.from(
              new Set(
                details.filter((detail) =>
                  /\b(?:MATERIALIZE|CO-ROUTINE|UNION|GROUP BY|DISTINCT|ORDER BY)\b/u.test(
                    detail,
                  ),
                ),
              ),
            ),
          });
          const graph = {
            source: "offline_sqlite_explain_only",
            planShapeIsNotRowsRead: true,
            legacy: mapGraph(legacyGraph),
            logical: mapGraph(logicalGraph),
          };
          const groupedReads = (
            samples: readonly MiniflareReadMeasurement[],
          ) => ({
            rowsRead: samples.map(({ rowsRead }) => rowsRead),
            durationMs: samples.map(({ durationMs }) => durationMs),
            durationSource: samples.map(({ durationSource }) => durationSource),
            wallMs: samples.map(({ wallMs }) => wallMs),
          });
          const sqlAndBindingBudgets = {
            legacyD1Executable: scenario.legacyExecutable,
            legacySqlBytes: Buffer.byteLength(
              legacyByScenario.get(scenario.name)!.sql,
              "utf8",
            ),
            legacyBindings: legacyByScenario.get(scenario.name)!.bindings
              .length,
            legacySqlSha256: createHash("sha256")
              .update(legacyByScenario.get(scenario.name)!.sql)
              .digest("hex"),
            logicalSqlBytes: Buffer.byteLength(logical.sample.sql, "utf8"),
            logicalBindings: logical.sample.bindingCount,
            logicalPhysicalPlanHash: logical.observation.physicalPlanHash,
            logicalSqlSha256: logical.rawSqlSha256,
          };
          console.info(
            "wave72_pages_comparison_miniflare_cost",
            JSON.stringify({
              phase,
              scenario: scenario.name,
              unrelatedPages: phase === "baseline" ? 0 : 1_024,
              sqlAndBindingBudgets,
              readAndDurationSamples: {
                legacy: groupedReads(legacySamples),
                logical: groupedReads(logicalSamples),
              },
              graph,
              dtoItemCount: dto.items.length,
            }),
          );
        }
      };

      await measurePhase("baseline");
      await measureFormalPayload("baseline");
      const baselineDtos = new Map(publicDtos);
      await insertUnrelatedPages(platform.env.DB, sitePk);
      await measurePhase("grown");
      await measureFormalPayload("grown");
      for (const scenario of scenarios) {
        const baseline = measurements.get(`baseline:${scenario.name}`)!;
        const grown = measurements.get(`grown:${scenario.name}`)!;
        const median = (values: readonly number[]) => {
          const sorted = [...values].sort((left, right) => left - right);
          return sorted[Math.floor(sorted.length / 2)] ?? 0;
        };
        for (const kind of ["logical", "legacy"] as const) {
          if (kind === "legacy" && !scenario.legacyExecutable) continue;
          const baselineMedianReads = median(
            baseline[kind].map(({ rowsRead }) => rowsRead),
          );
          const grownMedianReads = median(
            grown[kind].map(({ rowsRead }) => rowsRead),
          );
          expect(
            grownMedianReads - baselineMedianReads,
            `${scenario.name}/${kind} actual rows_read growth after 1,024 unrelated pages`,
          ).toBeLessThanOrEqual(4);
        }
        expect(publicDtos.get(`grown:${scenario.name}`)).toEqual(
          baselineDtos.get(`baseline:${scenario.name}`),
        );
      }
      const baselinePayload = formalPayloadMeasurements.get("baseline")!;
      const grownPayload = formalPayloadMeasurements.get("grown")!;
      const medianReads = (samples: readonly MiniflareReadMeasurement[]) => {
        const sorted = samples
          .map(({ rowsRead }) => rowsRead)
          .sort((left, right) => left - right);
        return sorted[Math.floor(sorted.length / 2)] ?? 0;
      };
      expect(
        medianReads(grownPayload) - medianReads(baselinePayload),
        "formal prepared 40-payload actual rows_read growth after 1,024 unrelated pages",
      ).toBeLessThanOrEqual(4);
      expect(formalPayloadDtos.get("grown")).toEqual(
        formalPayloadDtos.get("baseline"),
      );
    } finally {
      await disposePlatform?.();
      fixture.close();
      unlinkSync(configPath);
      rmdirSync(configDirectory);
    }
  }, 120_000);
});
