import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { D1_MAX_BOUND_PARAMETERS, D1_MAX_SQL_UTF8_BYTES } from "@/lib/db";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import {
  attachScopedFilterMetadata,
  createQueryTime,
  EMPTY_FILTER_DOCUMENT,
  type FilterDocument,
  prepareScopedQuery,
  type QueryInput,
  type QueryTime,
  scopedFilterMetadata,
  type ScopedFilterPlan,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { queryWindowToTime } from "@/lib/edge/analytics/contract/helpers";
import type { QueryWindow } from "@/lib/edge/analytics/contract/types";
import type { LogicalRelationHandle } from "@/lib/edge/analytics/engine/logical/builder";
import { LogicalPlanBuilder } from "@/lib/edge/analytics/engine/logical/builder";
import type {
  LogicalPlan,
  ValidatedLogicalPlan,
} from "@/lib/edge/analytics/engine/logical/plan";
import { printLogicalPlan } from "@/lib/edge/analytics/engine/logical/printer";
import {
  LogicalPlanError,
  validateLogicalPlan,
} from "@/lib/edge/analytics/engine/logical/validator";
import { createPageReportSource } from "@/lib/edge/analytics/engine/page-report-plan";
import {
  buildPerformanceDashboardPlan,
  buildPerformanceSummariesPlan,
  buildPerformanceTrendPlan,
  PERFORMANCE_DASHBOARD_OUTPUT_IDS,
  PERFORMANCE_REPORT_OUTPUT_FIELDS,
} from "@/lib/edge/analytics/engine/performance-sample-statistics-report-plan";
import { resolveAnalyticsScope } from "@/lib/edge/analytics/engine/semantic/entities";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { createSemanticTemporalDomains } from "@/lib/edge/analytics/engine/semantic/time";
import {
  queryAllPerformanceTrendsFromD1 as queryParentAllTrends,
  queryPerformanceCountriesFromD1 as queryParentCountries,
  queryPerformanceDashboardFromD1 as queryParentDashboard,
  queryPerformanceRoutesFromD1 as queryParentRoutes,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/performance-parent-oracle";
import { queryAnalyticsReportOutputRowsFromD1 } from "@/lib/edge/analytics/providers/d1/internal/analytics-report-query";
import type {
  PerformanceMetricKey,
  PerformanceSummaryRow,
  PerformanceTrendPointRow,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  appendSqlConditions,
  buildTimeBuckets,
  buildVisitFilterSql,
  buildVisitSourceCte,
  scopedDatasetFor,
  timeBucketCase,
  timeBucketTimestamp,
  visitSourceBindings,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  queryAllPerformanceTrendsFromD1,
  queryPerformanceCountriesFromD1,
  queryPerformanceDashboardFromD1,
  queryPerformanceRoutesFromD1,
  queryPerformanceSummariesFromD1,
  queryPerformanceTrendFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/performance";
import { instrumentEnv } from "@/lib/edge/observability/bindings";
import {
  createInvocationLogger,
  runWithD1Operation,
  runWithInvocationLogger,
} from "@/lib/edge/observability/logger";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";
import { normalizeFilterDocument } from "@/lib/filter-contract/filters";

const SITE_ID = "sample-statistics-site";
const WINDOW: QueryWindow = {
  startMs: Date.UTC(2026, 9, 5, 0),
  endExclusiveMs: Date.UTC(2026, 9, 5, 2),
  nowMs: Date.UTC(2026, 9, 5, 2),
  timeZone: "UTC",
};
const PREVIOUS_WINDOW: QueryWindow = {
  startMs: WINDOW.startMs - (WINDOW.endExclusiveMs - WINDOW.startMs),
  endExclusiveMs: WINDOW.startMs,
  nowMs: WINDOW.nowMs,
  timeZone: WINDOW.timeZone,
};

interface PageInput {
  readonly id: string;
  readonly startedAt: number;
  readonly pathname?: string | null;
  readonly country?: string | null;
  readonly latitude: number | null;
  readonly ttfb: number | null;
  readonly fcp: number | null;
  readonly lcp: number | null;
  readonly cls: number | null;
  readonly inp: number | null;
}

const PAGE_ROWS: readonly PageInput[] = [
  {
    id: "sample-a",
    startedAt: WINDOW.startMs + 10,
    latitude: null,
    ttfb: 0,
    fcp: 5,
    lcp: 10,
    cls: 0.1,
    inp: null,
  },
  {
    id: "sample-b",
    startedAt: WINDOW.startMs + 20,
    latitude: null,
    ttfb: 10,
    fcp: null,
    lcp: 10,
    cls: 0.4,
    inp: 0,
  },
  {
    id: "sample-c",
    startedAt: WINDOW.startMs + 60 * 60 * 1000 + 10,
    latitude: 1,
    ttfb: -5,
    fcp: 10,
    lcp: 30,
    cls: null,
    inp: 100,
  },
  {
    id: "sample-d",
    startedAt: WINDOW.startMs + 60 * 60 * 1000 + 20,
    latitude: 1,
    ttfb: null,
    fcp: 20,
    lcp: 20,
    cls: 0.9,
    inp: 100,
  },
  {
    id: "outside-end",
    startedAt: WINDOW.endExclusiveMs,
    latitude: 2,
    ttfb: 999,
    fcp: 999,
    lcp: 999,
    cls: 9,
    inp: 999,
  },
];

function operatorRow(
  id: string,
  latitude: number | null,
  lcp: number | null,
): PageInput {
  return {
    id,
    startedAt: WINDOW.startMs + 100,
    latitude,
    ttfb: null,
    fcp: null,
    lcp,
    cls: null,
    inp: null,
  };
}

const OPERATOR_ROWS = [
  operatorRow("g-null-a", null, 0),
  operatorRow("g-null-b", null, 10),
  operatorRow("g-null-null", null, null),
  operatorRow("g-one", 1, -2),
  operatorRow("g-two-a", 2, 0),
  operatorRow("g-two-b", 2, 10),
  operatorRow("g-three-a", 3, -1),
  operatorRow("g-three-b", 3, 0),
  operatorRow("g-three-c", 3, 1),
  operatorRow("g-four-a", 4, 1),
  operatorRow("g-four-b", 4, 1),
  operatorRow("g-four-c", 4, 3),
  operatorRow("g-four-d", 4, 5),
  operatorRow("g-five-a", 5, 2),
  operatorRow("g-five-b", 5, 2),
  operatorRow("g-five-c", 5, 2),
  operatorRow("g-five-d", 5, 4),
  operatorRow("g-five-e", 5, 6),
  operatorRow("g-empty", 6, null),
] as const;

let activeDatabase: DatabaseSync | undefined;

function createDatabase(rows: readonly PageInput[] = PAGE_ROWS) {
  const database = createMigratedDatabase();
  activeDatabase = database;
  database
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .run(SITE_ID);
  const sitePk = Number(
    (
      database
        .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
        .get(SITE_ID) as { readonly site_pk: number }
    ).site_pk,
  );
  const insert = database.prepare(`
    INSERT INTO visits (
      visit_id, site_id, visitor_id, session_id, status, started_at,
      last_activity_at, pathname, hostname, country, latitude,
      perf_ttfb_ms, perf_fcp_ms, perf_lcp_ms, perf_cls, perf_inp_ms, site_pk
    ) VALUES (?, ?, ?, ?, 'closed', ?, ?, ?, 'sample.test', ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of rows) {
    insert.run(
      row.id,
      SITE_ID,
      `visitor-${row.id}`,
      `session-${row.id}`,
      row.startedAt,
      row.startedAt,
      row.pathname === undefined ? "/sample" : row.pathname,
      row.country ?? "",
      row.latitude,
      row.ttfb,
      row.fcp,
      row.lcp,
      row.cls,
      row.inp,
      sitePk,
    );
  }
  const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
  return {
    database,
    sitePk,
    trace,
    env: { DB: createSqliteD1Database(database, trace) } as unknown as Env,
  };
}

function insertPayloadMatches(
  database: DatabaseSync,
  sitePk: number,
  input: {
    readonly visitId: string;
    readonly count: number;
    readonly eventPk: number;
  },
) {
  database
    .prepare(
      "INSERT INTO custom_event_names (id, site_id, site_pk, name, last_seen_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
    )
    .run(1, SITE_ID, sitePk, "wave59-payload", WINDOW.startMs);
  database
    .prepare(
      `INSERT INTO custom_events (
        event_pk, event_id, site_id, site_pk, visit_id, event_name_id,
        occurred_at, received_at, node_count, value_count
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    )
    .run(
      input.eventPk,
      `wave59-payload-event-${input.eventPk}`,
      SITE_ID,
      sitePk,
      input.visitId,
      WINDOW.startMs + 10,
      WINDOW.startMs + 10,
      input.count,
      input.count,
    );
  const insertPath = database.prepare(
    `INSERT INTO custom_event_json_paths (site_id, site_pk, path, last_seen_at)
     VALUES (?, ?, ?, ?) ON CONFLICT(site_pk, path) DO NOTHING`,
  );
  const insertNode = database.prepare(
    `INSERT INTO custom_event_json_nodes (
      event_pk, node_id, parent_node_id, key_id, path_id, value_type,
      array_index, depth
    ) VALUES (?, ?, NULL, NULL, ?, 1, NULL, 1)`,
  );
  const insertValue = database.prepare(
    `INSERT INTO custom_event_json_values (
      event_pk, node_id, site_id, event_name_id, path_id, occurred_at,
      value_type, string_value, number_value, boolean_value, site_pk
    ) VALUES (?, ?, ?, 1, ?, ?, 1, 'present', NULL, NULL, ?)`,
  );
  for (let index = 0; index < input.count; index += 1) {
    const path = `/wave59-payload-${index}`;
    const nodeId = index + 1;
    insertPath.run(SITE_ID, sitePk, path, WINDOW.startMs + 10);
    const pathId = Number(
      (
        database
          .prepare(
            "SELECT id FROM custom_event_json_paths WHERE site_pk = ? AND path = ?",
          )
          .get(sitePk, path) as { readonly id: number }
      ).id,
    );
    insertNode.run(input.eventPk, nodeId, pathId);
    insertValue.run(
      input.eventPk,
      nodeId,
      SITE_ID,
      pathId,
      WINDOW.startMs + 10,
      sitePk,
    );
  }
}

function createCaptureEnv() {
  const calls: Array<{
    readonly sql: string;
    readonly bindings: Array<string | number | null>;
  }> = [];
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind(...bindings: Array<string | number | null>) {
            calls.push({ sql, bindings });
            return {
              async all() {
                return { success: true, results: [] };
              },
            };
          },
        };
      },
    },
  } as unknown as Env;
  return { env, calls };
}

function pageAttribute(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
  name: string,
) {
  return builder.slot(pages, `attribute:page.report.${name}`);
}

function createGroupedStatisticsPlan(): ValidatedLogicalPlan {
  const { builder, pages } = createPageReportSource({
    siteId: SITE_ID,
    queryTime: queryWindowToTime(WINDOW),
    filters: EMPTY_FILTER_DOCUMENT,
    attributes: ["page.report.latitude", "page.report.perfLcpMs"],
  });
  const statistics = builder.sampleStatistics(
    pages,
    { latitude: pageAttribute(builder, pages, "latitude") },
    pageAttribute(builder, pages, "perfLcpMs"),
    [
      { name: "p0", percentile: 0 },
      { name: "p50", percentile: 50 },
      { name: "p75", percentile: 75 },
      { name: "p95", percentile: 95 },
      { name: "p100", percentile: 100 },
    ],
  );
  builder.output("sample-statistics", statistics, [
    { name: "latitude", slot: "latitude" },
    { name: "samples", slot: "samples" },
    { name: "avg", slot: "avg" },
    { name: "p0", slot: "p0" },
    { name: "p50", slot: "p50" },
    { name: "p75", slot: "p75" },
    { name: "p95", slot: "p95" },
    { name: "p100", slot: "p100" },
  ]);
  const emptyInput = builder.filter(
    pages,
    builder.compare(
      "gt",
      pageAttribute(builder, pages, "perfLcpMs"),
      builder.literal(1_000, { kind: "scalar", scalar: "number", unit: "ms" }),
    ),
  );
  const emptyStatistics = builder.sampleStatistics(
    emptyInput,
    {},
    pageAttribute(builder, emptyInput, "perfLcpMs"),
    [
      { name: "p0", percentile: 0 },
      { name: "p50", percentile: 50 },
      { name: "p75", percentile: 75 },
      { name: "p95", percentile: 95 },
      { name: "p100", percentile: 100 },
    ],
  );
  builder.output("sample-statistics-empty", emptyStatistics, [
    { name: "samples", slot: "samples" },
    { name: "avg", slot: "avg" },
    { name: "p0", slot: "p0" },
    { name: "p50", slot: "p50" },
    { name: "p75", slot: "p75" },
    { name: "p95", slot: "p95" },
    { name: "p100", slot: "p100" },
  ]);
  return builder.finish();
}

function createNestedStatisticsPlan(): ValidatedLogicalPlan {
  const { builder, pages } = createPageReportSource({
    siteId: SITE_ID,
    queryTime: queryWindowToTime(WINDOW),
    filters: EMPTY_FILTER_DOCUMENT,
    attributes: ["page.report.country", "page.report.perfLcpMs"],
  });
  const country = pageAttribute(builder, pages, "country");
  const countryCode = builder.pageDimension("countryCode", {
    "page.report.country": country,
  });
  const normalizedCountry = builder.normalizeString(
    countryCode,
    "trim-ascii-space",
  );
  const metric = pageAttribute(builder, pages, "perfLcpMs");
  const zeroMs = builder.literal(0, {
    kind: "scalar",
    scalar: "number",
    unit: "ms",
  });
  const oneMs = builder.literal(1, {
    kind: "scalar",
    scalar: "number",
    unit: "ms",
  });
  const positiveMetric = builder.compare("gt", metric, zeroMs);
  const isUs = builder.compare(
    "eq",
    normalizedCountry,
    builder.literal("US", { kind: "scalar", scalar: "string" }),
  );
  const group = builder.caseWhen(
    [
      {
        when: builder.and(isUs, positiveMetric),
        then: builder.coalesce(
          normalizedCountry,
          builder.literal("UNKNOWN", {
            kind: "scalar",
            scalar: "string",
          }),
        ),
      },
    ],
    builder.literal("OTHER", { kind: "scalar", scalar: "string" }),
  );
  const adjustedMetric = builder.caseWhen(
    [
      {
        when: positiveMetric,
        then: builder.arithmetic("subtract", metric, oneMs),
      },
    ],
    metric,
  );
  const value = builder.coalesce(adjustedMetric, metric);
  const statistics = builder.sampleStatistics(
    pages,
    { segment: group },
    value,
    [
      { name: "p50", percentile: 50 },
      { name: "p75", percentile: 75 },
      { name: "p100", percentile: 100 },
    ],
  );
  builder.output("nested-statistics", statistics, [
    { name: "segment", slot: "segment" },
    { name: "samples", slot: "samples" },
    { name: "avg", slot: "avg" },
    { name: "p50", slot: "p50" },
    { name: "p75", slot: "p75" },
    { name: "p100", slot: "p100" },
  ]);
  return builder.finish();
}

function sortedValues(values: readonly (number | null)[]) {
  return values
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
}

function nearestRank(values: readonly (number | null)[], percentile: number) {
  const ordered = sortedValues(values);
  if (ordered.length === 0) return null;
  const oneBasedRank = Math.max(
    1,
    Math.ceil((ordered.length * percentile) / 100),
  );
  return ordered[oneBasedRank - 1] ?? null;
}

function expectedStatistics(values: readonly (number | null)[]) {
  const samples = sortedValues(values);
  return {
    samples: samples.length,
    avg: samples.length
      ? samples.reduce((total, value) => total + value, 0) / samples.length
      : null,
    p0: nearestRank(values, 0),
    p50: nearestRank(values, 50),
    p75: nearestRank(values, 75),
    p95: nearestRank(values, 95),
    p100: nearestRank(values, 100),
  };
}

function round(value: number | null) {
  return value === null ? null : Math.round(value * 1000) / 1000;
}

const LEGACY_METRICS = [
  ["ttfb", "perf_ttfb_ms"],
  ["fcp", "perf_fcp_ms"],
  ["lcp", "perf_lcp_ms"],
  ["cls", "perf_cls"],
  ["inp", "perf_inp_ms"],
] as const satisfies readonly (readonly [PerformanceMetricKey, string])[];

function parentPerformanceSource(
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
) {
  const scoped = scopedDatasetFor(siteId, window, filters);
  if (scoped) {
    return {
      ctes: scoped.ctes,
      relation: scoped.visitRelation,
      bindings: scoped.bindings.map(({ value }) => value),
      filterClause: "",
      filterBindings: [],
    };
  }
  const filter = buildVisitFilterSql(filters, "visit_source", { window });
  return {
    ctes: buildVisitSourceCte(),
    relation: "visit_source",
    bindings: visitSourceBindings(siteId, window),
    filterClause: filter.clause,
    filterBindings: filter.bindings,
  };
}

function parentSummaryDto(
  database: DatabaseSync,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
): Record<PerformanceMetricKey, PerformanceSummaryRow> {
  const source = parentPerformanceSource(siteId, window, filters);
  const metricVisits = LEGACY_METRICS.map(
    ([
      metric,
      column,
    ]) => `SELECT '${metric}' AS metric, ${column} AS metricValue
  FROM filtered_visits
  WHERE ${column} IS NOT NULL`,
  ).join("\n  UNION ALL\n  ");
  const sql = `
WITH
${source.ctes},
filtered_visits AS MATERIALIZED (
  SELECT perf_ttfb_ms, perf_fcp_ms, perf_lcp_ms, perf_cls, perf_inp_ms
  FROM ${source.relation}
  ${source.filterClause}
),
metric_visits AS (
  ${metricVisits}
),
ordered_values AS (
  SELECT metric, metricValue,
    ROW_NUMBER() OVER (PARTITION BY metric ORDER BY metricValue ASC) AS rowNum,
    COUNT(*) OVER (PARTITION BY metric) AS sampleCount
  FROM metric_visits
),
metric_thresholds AS (
  SELECT metric, sampleCount, AVG(metricValue) AS avgValue,
    CAST(((sampleCount * 50) + 99) / 100 AS INTEGER) AS p50Rank,
    CAST(((sampleCount * 75) + 99) / 100 AS INTEGER) AS p75Rank,
    CAST(((sampleCount * 95) + 99) / 100 AS INTEGER) AS p95Rank
  FROM ordered_values
  GROUP BY metric, sampleCount
)
SELECT thresholds.metric AS metric, thresholds.sampleCount AS samples,
  thresholds.avgValue AS avgValue,
  MIN(CASE WHEN ordered.rowNum >= thresholds.p50Rank THEN ordered.metricValue END) AS p50,
  MIN(CASE WHEN ordered.rowNum >= thresholds.p75Rank THEN ordered.metricValue END) AS p75,
  MIN(CASE WHEN ordered.rowNum >= thresholds.p95Rank THEN ordered.metricValue END) AS p95
FROM metric_thresholds thresholds
JOIN ordered_values ordered ON ordered.metric = thresholds.metric
GROUP BY thresholds.metric, thresholds.sampleCount, thresholds.avgValue
`;
  const rows = database
    .prepare(sql)
    .all(...source.bindings, ...source.filterBindings) as Array<
    Record<string, unknown>
  >;
  const emptyMetric = (): PerformanceSummaryRow => ({
    avg: null,
    p50: null,
    p75: null,
    p95: null,
    samples: 0,
  });
  const summaries = Object.fromEntries(
    LEGACY_METRICS.map(([metric]) => [metric, emptyMetric()]),
  ) as Record<PerformanceMetricKey, PerformanceSummaryRow>;
  for (const row of rows) {
    const metric = String(row.metric) as PerformanceMetricKey;
    summaries[metric] = {
      avg: round(row.avgValue === null ? null : Number(row.avgValue)),
      p50: round(row.p50 === null ? null : Number(row.p50)),
      p75: round(row.p75 === null ? null : Number(row.p75)),
      p95: round(row.p95 === null ? null : Number(row.p95)),
      samples: Number(row.samples ?? 0),
    };
  }
  return summaries;
}

function parentTrendDto(
  database: DatabaseSync,
  siteId: string,
  window: QueryWindow,
  interval: "minute" | "hour" | "day" | "week" | "month",
  filters: FilterDocument,
  metric: PerformanceMetricKey,
): PerformanceTrendPointRow[] {
  const source = parentPerformanceSource(siteId, window, filters);
  const buckets = buildTimeBuckets(window, interval);
  const bucket = timeBucketCase(buckets, "started_at");
  const column = LEGACY_METRICS.find(([key]) => key === metric)![1];
  const filteredClause = appendSqlConditions(source.filterClause, [
    `${column} IS NOT NULL`,
  ]);
  const sql = `
WITH
${source.ctes},
metric_visits AS (
  SELECT ${bucket.sql} AS bucket, ${column} AS metricValue
  FROM ${source.relation}
  ${filteredClause}
),
ordered_values AS (
  SELECT bucket, metricValue,
    ROW_NUMBER() OVER (PARTITION BY bucket ORDER BY metricValue ASC) AS rowNum,
    COUNT(*) OVER (PARTITION BY bucket) AS sampleCount
  FROM metric_visits
),
bucket_thresholds AS (
  SELECT bucket, sampleCount, AVG(metricValue) AS avgValue,
    CAST(((sampleCount * 50) + 99) / 100 AS INTEGER) AS p50Rank,
    CAST(((sampleCount * 75) + 99) / 100 AS INTEGER) AS p75Rank,
    CAST(((sampleCount * 95) + 99) / 100 AS INTEGER) AS p95Rank
  FROM ordered_values
  GROUP BY bucket, sampleCount
)
SELECT thresholds.bucket AS bucket, thresholds.sampleCount AS samples,
  thresholds.avgValue AS avgValue,
  MIN(CASE WHEN ordered.rowNum >= thresholds.p50Rank THEN ordered.metricValue END) AS p50,
  MIN(CASE WHEN ordered.rowNum >= thresholds.p75Rank THEN ordered.metricValue END) AS p75,
  MIN(CASE WHEN ordered.rowNum >= thresholds.p95Rank THEN ordered.metricValue END) AS p95
FROM bucket_thresholds thresholds
JOIN ordered_values ordered ON ordered.bucket = thresholds.bucket
GROUP BY thresholds.bucket, thresholds.sampleCount, thresholds.avgValue
ORDER BY thresholds.bucket ASC
`;
  const rows = database
    .prepare(sql)
    .all(
      ...source.bindings,
      ...bucket.bindings,
      ...source.filterBindings,
    ) as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const bucketIndex = Number(row.bucket ?? 0);
    return {
      bucket: bucketIndex,
      timestampMs: timeBucketTimestamp(buckets, bucketIndex),
      avg: round(row.avgValue === null ? null : Number(row.avgValue)),
      p50: round(row.p50 === null ? null : Number(row.p50)),
      p75: round(row.p75 === null ? null : Number(row.p75)),
      p95: round(row.p95 === null ? null : Number(row.p95)),
      samples: Number(row.samples ?? 0),
    };
  });
}

function payloadExistsFilter(count: number) {
  return normalizeFilterDocument(
    {
      version: 1,
      root: {
        kind: "and",
        children: Array.from({ length: count }, (_unused, index) => ({
          kind: "condition" as const,
          target: {
            kind: "event-payload" as const,
            path: `/wave59-payload-${index}`,
          },
          operator: "exists" as const,
        })),
      },
    },
    analyticsFilterRegistry,
  );
}

function preparedPageMatches(visitCount = 128): FilterDocument {
  const filters = normalizeFilterDocument(
    {
      version: 1,
      root: {
        kind: "condition",
        target: { kind: "field", field: "page.path" },
        operator: "eq",
        value: "/prepared-budget",
      },
    },
    analyticsFilterRegistry,
  );
  const prepared = prepareScopedQuery("performance", {
    context: siteQueryContext(SITE_ID, "private-dashboard"),
    time: createQueryTime(
      WINDOW.startMs,
      WINDOW.endExclusiveMs,
      WINDOW.timeZone,
      WINDOW.nowMs,
    ),
    filters,
    scopePreference: "event",
  } as QueryInput & { readonly time: QueryTime }) as QueryInput & {
    readonly filters?: FilterDocument;
    readonly scopePlan?: ScopedFilterPlan;
  };
  if (!prepared.filters || !prepared.scopePlan)
    throw new Error("wave59_prepared_page_budget_missing");
  const metadata = scopedFilterMetadata(prepared.filters);
  if (!metadata) throw new Error("wave59_prepared_page_metadata_missing");
  return attachScopedFilterMetadata(prepared.filters, {
    ...metadata,
    plan: {
      ...prepared.scopePlan,
      advancedMatches: {
        visitIds: Array.from({ length: visitCount }, (_unused, index) => ({
          siteId: SITE_ID,
          id: `wave59-prepared-page-${index}`,
        })),
      },
    },
  });
}

async function compileObserved(
  tag: string,
  invoke: (env: Env) => Promise<unknown>,
): Promise<{
  readonly sql: string;
  readonly bindings: readonly (string | number | null)[];
  readonly observation: Record<string, unknown>;
  readonly statementCount: number;
}> {
  const { env, calls } = createCaptureEnv();
  const logger = createInvocationLogger({
    source: "worker",
    trigger: "request",
  });
  const operation = `wave59.performance.${tag}`;
  await runWithInvocationLogger(logger, () =>
    runWithD1Operation(operation, () => invoke(instrumentEnv(env, logger))),
  );
  const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  let emitted;
  try {
    emitted = await logger.emitWhenComplete();
  } finally {
    consoleLog.mockRestore();
  }
  const call = calls[0];
  const observation = emitted.logs.find(
    (entry) =>
      entry.message === "db.query.v1.all.success" &&
      entry.data?.tag === operation,
  )?.data;
  if (!call || !observation)
    throw new Error("wave59_public_compile_observation_missing");
  return {
    sql: call.sql,
    bindings: call.bindings,
    observation,
    statementCount: calls.length,
  };
}

async function captureParentSql(
  invoke: (env: Env) => Promise<unknown>,
): Promise<{
  readonly sql: string;
  readonly bindings: readonly (string | number | null)[];
  readonly statementCount: number;
}> {
  const { env, calls } = createCaptureEnv();
  await invoke(env);
  const call = calls[0];
  if (!call) throw new Error("wave60_parent_sql_capture_missing");
  return {
    sql: call.sql,
    bindings: call.bindings,
    statementCount: calls.length,
  };
}

describe("Logical sample statistics and migrated performance readers", () => {
  afterEach(() => {
    activeDatabase?.close();
    activeDatabase = undefined;
  });

  it("lowers nullable groups and exact nearest-rank quantiles against SQLite", async () => {
    const { env } = createDatabase(OPERATOR_ROWS);
    const plan = createGroupedStatisticsPlan();
    const node = plan.nodes.find(
      (candidate) => candidate.kind === "sample-statistics",
    );
    expect(node).toMatchObject({
      kind: "sample-statistics",
      groups: [{ name: "latitude" }],
      percentiles: [
        { name: "p0", percentile: 0 },
        { name: "p50", percentile: 50 },
        { name: "p75", percentile: 75 },
        { name: "p95", percentile: 95 },
        { name: "p100", percentile: 100 },
      ],
    });
    expect(printLogicalPlan(plan)).toContain("SampleStatistics");
    const rows = await queryAnalyticsReportOutputRowsFromD1(
      env,
      plan,
      "sample-statistics",
    );
    const groupRows = (
      rows as Array<{
        readonly latitude: number | null;
        readonly samples: number;
        readonly p50: number | null;
      }>
    ).sort((left, right) => {
      if (left.latitude === null) return right.latitude === null ? 0 : -1;
      if (right.latitude === null) return 1;
      return Number(left.latitude) - Number(right.latitude);
    });
    const expected = [...new Set(OPERATOR_ROWS.map(({ latitude }) => latitude))]
      .map((latitude) => ({
        latitude,
        ...expectedStatistics(
          OPERATOR_ROWS.filter((row) => Object.is(row.latitude, latitude)).map(
            (row) => row.lcp,
          ),
        ),
      }))
      .filter((row) => row.samples > 0)
      .sort((left, right) => {
        if (left.latitude === null) return right.latitude === null ? 0 : -1;
        if (right.latitude === null) return 1;
        return Number(left.latitude) - Number(right.latitude);
      });
    expect(groupRows).toEqual(expected);
    expect(nearestRank([0, 10], 50)).toBe(0);
    expect(expectedStatistics([])).toEqual({
      samples: 0,
      avg: null,
      p0: null,
      p50: null,
      p75: null,
      p95: null,
      p100: null,
    });
    expect(groupRows.find((row) => row.latitude === 2)?.p50).toBe(0);
    expect(groupRows.map((row) => row.samples)).toEqual([2, 1, 2, 3, 4, 5]);
    expect(
      await queryAnalyticsReportOutputRowsFromD1(
        env,
        plan,
        "sample-statistics-empty",
      ),
    ).toEqual([
      {
        samples: 0,
        avg: null,
        p0: null,
        p50: null,
        p75: null,
        p95: null,
        p100: null,
      },
    ]);
    expect(expectedStatistics([-2, 0, 0, 4])).toMatchObject({
      samples: 4,
      p0: -2,
      p50: 0,
      p100: 4,
    });
  });

  it("validates nested group and value lineage and computes grouped statistics in SQLite", async () => {
    const rows = [
      { ...operatorRow("nested-us-a", null, 10), country: "US" },
      { ...operatorRow("nested-us-b", null, 10), country: " us " },
      { ...operatorRow("nested-us-c", null, 2), country: "us" },
      { ...operatorRow("nested-us-null", null, null), country: "US" },
      { ...operatorRow("nested-ca-a", null, 4), country: "CA" },
      { ...operatorRow("nested-ca-b", null, 8), country: "CA" },
    ] as const;
    const { env } = createDatabase(rows);
    const plan = createNestedStatisticsPlan();
    expect(() => validateLogicalPlan(plan)).not.toThrow();

    const statisticsNode = plan.nodes.find(
      (candidate) => candidate.kind === "sample-statistics",
    );
    if (!statisticsNode || statisticsNode.kind !== "sample-statistics")
      throw new Error("wave66_nested_statistics_node_missing");
    const group = statisticsNode.groups.find(
      (candidate) => candidate.name === "segment",
    );
    if (!group) throw new Error("wave66_nested_statistics_group_missing");
    expect(group.expression.kind).toBe("case");
    expect(statisticsNode.value.kind).toBe("coalesce");

    const actualRows = await queryAnalyticsReportOutputRowsFromD1(
      env,
      plan,
      "nested-statistics",
    );
    const expectedRows = [
      {
        segment: "OTHER",
        ...expectedStatistics([3, 7, null]),
      },
      {
        segment: "US",
        ...expectedStatistics([9, 9, 1, null]),
      },
    ].map(({ segment, samples, avg, p50, p75, p100 }) => ({
      segment,
      samples,
      avg,
      p50,
      p75,
      p100,
    }));
    expect(
      (actualRows as typeof expectedRows).sort((left, right) =>
        left.segment.localeCompare(right.segment),
      ),
    ).toEqual(expectedRows);

    const metricSlot = plan.slots.find(
      (candidate) =>
        candidate.lineage.kind === "attribute" &&
        candidate.lineage.attribute === "page.report.perfLcpMs",
    );
    const groupSlot = plan.slots.find(
      (candidate) => candidate.id === group.slot,
    );
    if (!metricSlot || !groupSlot || groupSlot.lineage.kind !== "derived")
      throw new Error("wave66_nested_statistics_lineage_missing");
    expect(groupSlot.lineage.inputs).toContain(metricSlot.id);

    const forgedPlan = {
      ...plan,
      slots: plan.slots.map((candidate) =>
        candidate.id === group.slot && candidate.lineage.kind === "derived"
          ? {
              ...candidate,
              lineage: {
                ...candidate.lineage,
                inputs: candidate.lineage.inputs.filter(
                  (input) => input !== metricSlot.id,
                ),
              },
            }
          : candidate,
      ),
    } satisfies LogicalPlan;
    let validationError: unknown;
    try {
      validateLogicalPlan(forgedPlan);
    } catch (error) {
      validationError = error;
    }
    expect(validationError).toBeInstanceOf(LogicalPlanError);
    expect((validationError as LogicalPlanError).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "invalid-expression",
          message: "Group output lineage does not match its expression.",
        }),
      ]),
    );
  });

  it("preserves five metric units and matches the previous reader's summary and trend rows", async () => {
    const summaryPlan = buildPerformanceSummariesPlan({
      siteId: SITE_ID,
      queryTime: queryWindowToTime(WINDOW),
      filters: EMPTY_FILTER_DOCUMENT,
    });
    expect(
      summaryPlan.nodes.filter((node) => node.kind === "source"),
    ).toHaveLength(1);
    expect(
      summaryPlan.nodes.filter((node) => node.kind === "sample-statistics"),
    ).toHaveLength(5);
    const summaryOutput = summaryPlan.outputs.find(
      (output) => output.id === "performance-summaries",
    );
    if (!summaryOutput) throw new Error("wave59_summary_output_missing");
    const summaryTypes = new Map(
      summaryOutput.fields.map(({ name, slot }) => [
        name,
        summaryPlan.slots.find((candidate) => candidate.id === slot)?.type,
      ]),
    );
    for (const metric of ["ttfb", "fcp", "lcp", "inp"] as const) {
      expect(summaryTypes.get(`${metric}AvgValue`)).toEqual({
        kind: "scalar",
        scalar: "number",
        unit: "ms",
      });
      expect(summaryTypes.get(`${metric}P50`)).toEqual({
        kind: "scalar",
        scalar: "number",
        unit: "ms",
      });
    }
    expect(summaryTypes.get("clsAvgValue")).toEqual({
      kind: "scalar",
      scalar: "number",
      unit: "ratio",
    });
    expect(summaryTypes.get("clsP50")).toEqual({
      kind: "scalar",
      scalar: "number",
      unit: "ratio",
    });
    expect(summaryTypes.get("lcpSamples")).toEqual({
      kind: "scalar",
      scalar: "number",
    });

    const { env, trace, database } = createDatabase();
    const summary = await queryPerformanceSummariesFromD1(
      env,
      SITE_ID,
      WINDOW,
      EMPTY_FILTER_DOCUMENT,
    );
    const validRows = PAGE_ROWS.filter(
      (row) =>
        row.startedAt >= WINDOW.startMs &&
        row.startedAt < WINDOW.endExclusiveMs,
    );
    const columns = {
      ttfb: "ttfb",
      fcp: "fcp",
      lcp: "lcp",
      cls: "cls",
      inp: "inp",
    } as const;
    for (const [metric, column] of Object.entries(columns) as Array<
      [keyof typeof columns, keyof PageInput]
    >) {
      const values = validRows.map((row) => row[column] as number | null);
      const expected = expectedStatistics(values);
      expect(summary[metric]).toEqual({
        avg: round(expected.avg),
        p50: expected.p50,
        p75: expected.p75,
        p95: expected.p95,
        samples: expected.samples,
      });
    }
    expect(summary).toEqual(
      parentSummaryDto(database, SITE_ID, WINDOW, EMPTY_FILTER_DOCUMENT),
    );
    expect(summary.cls.avg).toBe(0.467);
    expect(summary.lcp.samples).toBe(4);
    expect(trace.preparedSql).toHaveLength(1);
    expect(trace.preparedSql[0]).toContain("ROW_NUMBER() OVER");
    expect(trace.preparedSql[0]).toContain("COUNT(*) OVER");

    const lcpTrend = await queryPerformanceTrendFromD1(
      env,
      SITE_ID,
      WINDOW,
      "hour",
      EMPTY_FILTER_DOCUMENT,
      "lcp",
    );
    expect(lcpTrend).toEqual([
      {
        bucket: 0,
        timestampMs: WINDOW.startMs,
        avg: 10,
        p50: 10,
        p75: 10,
        p95: 10,
        samples: 2,
      },
      {
        bucket: 1,
        timestampMs: WINDOW.startMs + 60 * 60 * 1000,
        avg: 25,
        p50: 20,
        p75: 30,
        p95: 30,
        samples: 2,
      },
    ]);
    expect(lcpTrend).toEqual(
      parentTrendDto(
        database,
        SITE_ID,
        WINDOW,
        "hour",
        EMPTY_FILTER_DOCUMENT,
        "lcp",
      ),
    );
    const clsTrend = await queryPerformanceTrendFromD1(
      env,
      SITE_ID,
      WINDOW,
      "hour",
      EMPTY_FILTER_DOCUMENT,
      "cls",
    );
    expect(clsTrend.map((row) => row.avg)).toEqual([0.25, 0.9]);
    expect(clsTrend).toEqual(
      parentTrendDto(
        database,
        SITE_ID,
        WINDOW,
        "hour",
        EMPTY_FILTER_DOCUMENT,
        "cls",
      ),
    );
    expect(trace.preparedSql).toHaveLength(3);
  });

  it("retains all 20 typed dashboard outputs and their metric units", () => {
    const plan = buildPerformanceDashboardPlan({
      siteId: SITE_ID,
      queryTime: queryWindowToTime(WINDOW),
      filters: EMPTY_FILTER_DOCUMENT,
      interval: "hour",
      routeLimit: 20,
    });
    expect(PERFORMANCE_DASHBOARD_OUTPUT_IDS).toHaveLength(20);
    expect(plan.outputs.map(({ id }) => id)).toEqual(
      PERFORMANCE_DASHBOARD_OUTPUT_IDS,
    );
    const types = new Map(plan.slots.map(({ id, type }) => [id, type]));
    for (const output of plan.outputs) {
      expect(output.fields.map(({ name }) => name)).toEqual(
        PERFORMANCE_REPORT_OUTPUT_FIELDS,
      );
      const outputTypes = new Map(
        output.fields.map(({ name, slot }) => [name, types.get(slot)]),
      );
      for (const metric of ["ttfb", "fcp", "lcp", "cls", "inp"] as const) {
        expect(outputTypes.get(`${metric}Samples`)).toEqual({
          kind: "scalar",
          scalar: "number",
        });
        const unit = metric === "cls" ? "ratio" : "ms";
        for (const suffix of ["AvgValue", "P50", "P75", "P95"])
          expect(outputTypes.get(`${metric}${suffix}`)).toEqual({
            kind: "scalar",
            scalar: "number",
            unit,
          });
      }
    }
  });

  it("returns scalar empty bags for every summary metric", async () => {
    const { env, trace } = createDatabase([]);
    await expect(
      queryPerformanceSummariesFromD1(
        env,
        SITE_ID,
        WINDOW,
        EMPTY_FILTER_DOCUMENT,
      ),
    ).resolves.toEqual({
      ttfb: { avg: null, p50: null, p75: null, p95: null, samples: 0 },
      fcp: { avg: null, p50: null, p75: null, p95: null, samples: 0 },
      lcp: { avg: null, p50: null, p75: null, p95: null, samples: 0 },
      cls: { avg: null, p50: null, p75: null, p95: null, samples: 0 },
      inp: { avg: null, p50: null, p75: null, p95: null, samples: 0 },
    });
    expect(trace.preparedSql).toHaveLength(1);
  });

  it("matches the parent DTOs for all four public readers on a rich fixture", async () => {
    const row = (
      id: string,
      minute: number,
      pathname: string | null,
      country: string | null,
      metrics: Pick<PageInput, "ttfb" | "fcp" | "lcp" | "cls" | "inp">,
    ): PageInput => ({
      id,
      startedAt: WINDOW.startMs + minute * 60_000,
      pathname,
      country,
      latitude: null,
      ...metrics,
    });
    const rows: PageInput[] = [
      row("pricing-a", 1, " /pricing ", " us ", {
        ttfb: 0,
        fcp: null,
        lcp: 10,
        cls: 0,
        inp: null,
      }),
      row("pricing-b", 2, "/pricing", "US", {
        ttfb: -5,
        fcp: 5,
        lcp: null,
        cls: 0.4,
        inp: 20,
      }),
      row("pricing-c", 61, "/pricing", "US", {
        ttfb: 100,
        fcp: 0,
        lcp: null,
        cls: null,
        inp: 30,
      }),
      row("tie-a-1", 5, "/tie-a", "ca", {
        ttfb: 20,
        fcp: null,
        lcp: 50,
        cls: 0.2,
        inp: null,
      }),
      row("tie-a-2", 65, "/tie-a", "CA", {
        ttfb: null,
        fcp: 8,
        lcp: null,
        cls: 0.8,
        inp: 40,
      }),
      row("tie-b-1", 6, "/tie-b", "CA", {
        ttfb: 30,
        fcp: 9,
        lcp: null,
        cls: 0.1,
        inp: 50,
      }),
      row("tie-b-2", 66, "/tie-b", "CA", {
        ttfb: null,
        fcp: null,
        lcp: null,
        cls: null,
        inp: null,
      }),
      row("unicode-sharp-s", 7, "/unicode-a", "ß", {
        ttfb: 7,
        fcp: null,
        lcp: null,
        cls: null,
        inp: null,
      }),
      row("unicode-ascii-ss", 8, "/unicode-b", "SS", {
        ttfb: null,
        fcp: 11,
        lcp: null,
        cls: null,
        inp: null,
      }),
      row("tab-country", 9, "/tab-country", "\t", {
        ttfb: 90,
        fcp: 90,
        lcp: 90,
        cls: 0.9,
        inp: 90,
      }),
      row("nbsp-country", 10, "/nbsp-country", "\u00a0", {
        ttfb: 91,
        fcp: 91,
        lcp: 91,
        cls: 0.91,
        inp: 91,
      }),
      row("empty-country", 11, "/empty-country", "", {
        ttfb: 92,
        fcp: 92,
        lcp: 92,
        cls: 0.92,
        inp: 92,
      }),
      ...Array.from({ length: 5 }, (_unused, index) =>
        row(`all-null-${index}`, 12 + index, "/all-null", "US", {
          ttfb: null,
          fcp: null,
          lcp: null,
          cls: null,
          inp: null,
        }),
      ),
      row("outside-start", -1, "/outside-start", "ZZ", {
        ttfb: 999,
        fcp: 999,
        lcp: 999,
        cls: 9,
        inp: 999,
      }),
      {
        ...row("end-exclusive", 120, "/end-exclusive", "ZZ", {
          ttfb: 999,
          fcp: 999,
          lcp: 999,
          cls: 9,
          inp: 999,
        }),
        startedAt: WINDOW.endExclusiveMs,
      },
    ];
    const { env, database, trace } = createDatabase(rows);
    const foreignSitePk = Number(
      (
        database
          .prepare(
            "INSERT INTO site_identities (site_id) VALUES (?) RETURNING site_pk",
          )
          .get("performance-other-site") as { readonly site_pk: number }
      ).site_pk,
    );
    database
      .prepare(
        `
        INSERT INTO visits (
          visit_id, site_id, visitor_id, session_id, status, started_at,
          last_activity_at, pathname, hostname, country, latitude,
          perf_ttfb_ms, perf_fcp_ms, perf_lcp_ms, perf_cls, perf_inp_ms, site_pk
        ) VALUES (?, ?, ?, ?, 'closed', ?, ?, ?, 'sample.test', ?, NULL, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "foreign-site-row",
        "performance-other-site",
        "visitor-foreign",
        "session-foreign",
        WINDOW.startMs + 10,
        WINDOW.startMs + 10,
        "/foreign-site",
        "ZZ",
        888,
        888,
        888,
        8,
        888,
        foreignSitePk,
      );

    const allTrends = await queryAllPerformanceTrendsFromD1(
      env,
      SITE_ID,
      WINDOW,
      "hour",
      EMPTY_FILTER_DOCUMENT,
    );
    expect(allTrends).toEqual(
      await queryParentAllTrends(
        env,
        SITE_ID,
        WINDOW,
        "hour",
        EMPTY_FILTER_DOCUMENT,
      ),
    );
    expect(allTrends.lcp.map(({ bucket }) => bucket)).toEqual([0]);

    const routes = await queryPerformanceRoutesFromD1(
      env,
      SITE_ID,
      WINDOW,
      EMPTY_FILTER_DOCUMENT,
      20,
    );
    expect(routes).toEqual(
      await queryParentRoutes(env, SITE_ID, WINDOW, EMPTY_FILTER_DOCUMENT, 20),
    );
    expect(routes.find(({ pathname }) => pathname === "/pricing")?.views).toBe(
      3,
    );
    expect(routes.some(({ pathname }) => pathname === "/all-null")).toBe(false);
    expect(routes.some(({ pathname }) => pathname === "/foreign-site")).toBe(
      false,
    );

    const countries = await queryPerformanceCountriesFromD1(
      env,
      SITE_ID,
      WINDOW,
      EMPTY_FILTER_DOCUMENT,
    );
    expect(countries).toEqual(
      await queryParentCountries(env, SITE_ID, WINDOW, EMPTY_FILTER_DOCUMENT),
    );
    expect(countries.some(({ country }) => country === "SS")).toBe(true);
    expect(countries.some(({ country }) => country === "")).toBe(false);
    expect(countries.some(({ country }) => country === "ZZ")).toBe(false);

    const dashboard = await queryPerformanceDashboardFromD1(
      env,
      SITE_ID,
      WINDOW,
      "hour",
      EMPTY_FILTER_DOCUMENT,
      20,
    );
    expect(dashboard).toEqual(
      await queryParentDashboard(
        env,
        SITE_ID,
        WINDOW,
        "hour",
        EMPTY_FILTER_DOCUMENT,
        20,
      ),
    );
    expect(dashboard.trends).toEqual(allTrends);
    expect(new Set(dashboard.routes.map(({ pathname }) => pathname))).toEqual(
      new Set(routes.map(({ pathname }) => pathname)),
    );
    expect(dashboard.routes.map(({ pathname }) => pathname)).not.toEqual(
      routes.map(({ pathname }) => pathname),
    );
    expect(new Set(dashboard.countries.map(({ country }) => country))).toEqual(
      new Set(countries.map(({ country }) => country)),
    );

    const topNullOnly = await queryPerformanceRoutesFromD1(
      env,
      SITE_ID,
      WINDOW,
      EMPTY_FILTER_DOCUMENT,
      1,
    );
    expect(topNullOnly).toEqual([]);
    expect(topNullOnly).toEqual(
      await queryParentRoutes(env, SITE_ID, WINDOW, EMPTY_FILTER_DOCUMENT, 1),
    );
    const limitedDashboard = await queryPerformanceDashboardFromD1(
      env,
      SITE_ID,
      WINDOW,
      "hour",
      EMPTY_FILTER_DOCUMENT,
      1,
    );
    expect(limitedDashboard.routes).toEqual([]);
    expect(limitedDashboard).toEqual(
      await queryParentDashboard(
        env,
        SITE_ID,
        WINDOW,
        "hour",
        EMPTY_FILTER_DOCUMENT,
        1,
      ),
    );
    for (const limit of [0, -1]) {
      const limitedRoutes = await queryPerformanceRoutesFromD1(
        env,
        SITE_ID,
        WINDOW,
        EMPTY_FILTER_DOCUMENT,
        limit,
      );
      expect(limitedRoutes).toEqual(
        await queryParentRoutes(
          env,
          SITE_ID,
          WINDOW,
          EMPTY_FILTER_DOCUMENT,
          limit,
        ),
      );
      const limitedDashboardRoutes = await queryPerformanceDashboardFromD1(
        env,
        SITE_ID,
        WINDOW,
        "hour",
        EMPTY_FILTER_DOCUMENT,
        limit,
      );
      expect(limitedDashboardRoutes).toEqual(
        await queryParentDashboard(
          env,
          SITE_ID,
          WINDOW,
          "hour",
          EMPTY_FILTER_DOCUMENT,
          limit,
        ),
      );
    }
    const statementCountBeforeInvalidLimits = trace.preparedSql.length;
    for (const limit of [0.5, Number.NaN]) {
      await expect(
        queryPerformanceRoutesFromD1(
          env,
          SITE_ID,
          WINDOW,
          EMPTY_FILTER_DOCUMENT,
          limit,
        ),
      ).rejects.toThrow("performance_invalid_route_limit");
      await expect(
        queryPerformanceDashboardFromD1(
          env,
          SITE_ID,
          WINDOW,
          "hour",
          EMPTY_FILTER_DOCUMENT,
          limit,
        ),
      ).rejects.toThrow("performance_invalid_route_limit");
    }
    expect(trace.preparedSql).toHaveLength(statementCountBeforeInvalidLimits);

    const indexedVisitScans = (sql: string, bindings: readonly unknown[]) =>
      (
        database
          .prepare(`EXPLAIN QUERY PLAN ${sql}`)
          .all(...(bindings as never[])) as Array<{ readonly detail: string }>
      ).filter(({ detail }) => detail.includes("idx_visits_site_pk_started_at"))
        .length;
    expect(trace.preparedSql).toHaveLength(trace.bindings.length);
    const currentPlans = [0, 2, 4, 6].map((index) =>
      indexedVisitScans(trace.preparedSql[index]!, trace.bindings[index] ?? []),
    );
    const parentPlans = [1, 3, 5, 7].map((index) =>
      indexedVisitScans(trace.preparedSql[index]!, trace.bindings[index] ?? []),
    );
    expect(currentPlans).toEqual([1, 1, 1, 1]);
    expect(parentPlans).toEqual([1, 1, 1, 1]);
  });

  it("executes direct 40/40 and 39/40 payload filters through both migrated readers", async () => {
    const rows: PageInput[] = [
      {
        id: "payload-full-match",
        startedAt: WINDOW.startMs + 10,
        pathname: "/payload/full",
        country: "us",
        latitude: null,
        ttfb: 1,
        fcp: 2,
        lcp: 11,
        cls: 0.1,
        inp: 3,
      },
      {
        id: "payload-partial-match",
        startedAt: WINDOW.startMs + 20,
        pathname: "/payload/partial",
        country: "CA",
        latitude: 1,
        ttfb: 2,
        fcp: 4,
        lcp: 29,
        cls: 0.3,
        inp: 5,
      },
    ];
    const { env, database, sitePk, trace } = createDatabase(rows);
    insertPayloadMatches(database, sitePk, {
      visitId: rows[0]!.id,
      count: 40,
      eventPk: 1,
    });
    insertPayloadMatches(database, sitePk, {
      visitId: rows[1]!.id,
      count: 39,
      eventPk: 2,
    });

    const direct40 = payloadExistsFilter(40);
    const direct39 = payloadExistsFilter(39);
    const summary40 = await queryPerformanceSummariesFromD1(
      env,
      SITE_ID,
      WINDOW,
      direct40,
    );
    const summary39 = await queryPerformanceSummariesFromD1(
      env,
      SITE_ID,
      WINDOW,
      direct39,
    );
    expect(summary40.lcp).toEqual({
      avg: 11,
      p50: 11,
      p75: 11,
      p95: 11,
      samples: 1,
    });
    expect(summary39.lcp).toEqual({
      avg: 20,
      p50: 11,
      p75: 29,
      p95: 29,
      samples: 2,
    });
    expect(summary40).toEqual(
      parentSummaryDto(database, SITE_ID, WINDOW, direct40),
    );
    expect(summary39).toEqual(
      parentSummaryDto(database, SITE_ID, WINDOW, direct39),
    );

    const trend40 = await queryPerformanceTrendFromD1(
      env,
      SITE_ID,
      WINDOW,
      "hour",
      direct40,
      "lcp",
    );
    const trend39 = await queryPerformanceTrendFromD1(
      env,
      SITE_ID,
      WINDOW,
      "hour",
      direct39,
      "lcp",
    );
    expect(trend40.map(({ avg, samples }) => ({ avg, samples }))).toEqual([
      { avg: 11, samples: 1 },
    ]);
    expect(trend39.map(({ avg, samples }) => ({ avg, samples }))).toEqual([
      { avg: 20, samples: 2 },
    ]);
    expect(trend40).toEqual(
      parentTrendDto(database, SITE_ID, WINDOW, "hour", direct40, "lcp"),
    );
    expect(trend39).toEqual(
      parentTrendDto(database, SITE_ID, WINDOW, "hour", direct39, "lcp"),
    );

    for (const [filters, expectedRoutes, expectedDashboard] of [
      [direct40, ["/payload/full"], ["/payload/full"]],
      [
        direct39,
        ["/payload/full", "/payload/partial"],
        ["/payload/full", "/payload/partial"],
      ],
    ] as const) {
      const allTrends = await queryAllPerformanceTrendsFromD1(
        env,
        SITE_ID,
        WINDOW,
        "hour",
        filters,
      );
      expect(allTrends).toEqual(
        await queryParentAllTrends(env, SITE_ID, WINDOW, "hour", filters),
      );
      const routes = await queryPerformanceRoutesFromD1(
        env,
        SITE_ID,
        WINDOW,
        filters,
        20,
      );
      expect(routes.map(({ pathname }) => pathname)).toEqual(expectedRoutes);
      expect(routes).toEqual(
        await queryParentRoutes(env, SITE_ID, WINDOW, filters, 20),
      );
      const countries = await queryPerformanceCountriesFromD1(
        env,
        SITE_ID,
        WINDOW,
        filters,
      );
      expect(countries).toEqual(
        await queryParentCountries(env, SITE_ID, WINDOW, filters),
      );
      const dashboard = await queryPerformanceDashboardFromD1(
        env,
        SITE_ID,
        WINDOW,
        "hour",
        filters,
        20,
      );
      expect(dashboard.routes.map(({ pathname }) => pathname)).toEqual(
        expectedDashboard,
      );
      expect(dashboard).toEqual(
        await queryParentDashboard(env, SITE_ID, WINDOW, "hour", filters, 20),
      );
    }

    const indexedVisitScans = (sql: string, bindings: readonly unknown[]) =>
      (
        database
          .prepare(`EXPLAIN QUERY PLAN ${sql}`)
          .all(...(bindings as never[])) as Array<{ readonly detail: string }>
      ).filter(({ detail }) => detail.includes("idx_visits_site_pk_started_at"))
        .length;
    const direct40Plans = [6, 7, 10, 11].map((index) =>
      indexedVisitScans(trace.preparedSql[index]!, trace.bindings[index] ?? []),
    );
    expect(direct40Plans).toEqual([1, 1, 1, 1]);
  });

  it("uses the actual previous reader window with current prepared Page metadata", async () => {
    const row: PageInput = {
      id: "wave59-prepared-page-0",
      startedAt: PREVIOUS_WINDOW.startMs + 10,
      pathname: "/prepared-budget",
      latitude: null,
      ttfb: 3,
      fcp: 5,
      lcp: 17,
      cls: 0.25,
      inp: 8,
      country: "fr",
    };
    const { env, database } = createDatabase([row]);
    const prepared = preparedPageMatches(1);
    const summary = await queryPerformanceSummariesFromD1(
      env,
      SITE_ID,
      PREVIOUS_WINDOW,
      prepared,
    );
    expect(summary.lcp).toEqual({
      avg: 17,
      p50: 17,
      p75: 17,
      p95: 17,
      samples: 1,
    });
    expect(summary).toEqual(
      parentSummaryDto(database, SITE_ID, PREVIOUS_WINDOW, prepared),
    );

    const trend = await queryPerformanceTrendFromD1(
      env,
      SITE_ID,
      PREVIOUS_WINDOW,
      "hour",
      prepared,
      "lcp",
    );
    expect(trend).toHaveLength(1);
    expect(trend[0]).toMatchObject({
      bucket: 0,
      timestampMs: PREVIOUS_WINDOW.startMs,
      avg: 17,
      samples: 1,
    });
    expect(trend).toEqual(
      parentTrendDto(
        database,
        SITE_ID,
        PREVIOUS_WINDOW,
        "hour",
        prepared,
        "lcp",
      ),
    );

    const routes = await queryPerformanceRoutesFromD1(
      env,
      SITE_ID,
      PREVIOUS_WINDOW,
      prepared,
      20,
    );
    expect(routes).toEqual(
      await queryParentRoutes(env, SITE_ID, PREVIOUS_WINDOW, prepared, 20),
    );
    const countries = await queryPerformanceCountriesFromD1(
      env,
      SITE_ID,
      PREVIOUS_WINDOW,
      prepared,
    );
    expect(countries).toEqual(
      await queryParentCountries(env, SITE_ID, PREVIOUS_WINDOW, prepared),
    );
    const allTrends = await queryAllPerformanceTrendsFromD1(
      env,
      SITE_ID,
      PREVIOUS_WINDOW,
      "hour",
      prepared,
    );
    expect(allTrends).toEqual(
      await queryParentAllTrends(
        env,
        SITE_ID,
        PREVIOUS_WINDOW,
        "hour",
        prepared,
      ),
    );
    const dashboard = await queryPerformanceDashboardFromD1(
      env,
      SITE_ID,
      PREVIOUS_WINDOW,
      "hour",
      prepared,
      20,
    );
    expect(dashboard).toEqual(
      await queryParentDashboard(
        env,
        SITE_ID,
        PREVIOUS_WINDOW,
        "hour",
        prepared,
        20,
      ),
    );

    const emptyPrepared = preparedPageMatches(0);
    const emptySummary = await queryPerformanceSummariesFromD1(
      env,
      SITE_ID,
      PREVIOUS_WINDOW,
      emptyPrepared,
    );
    expect(emptySummary).toEqual(
      parentSummaryDto(database, SITE_ID, PREVIOUS_WINDOW, emptyPrepared),
    );
    const emptyTrend = await queryPerformanceTrendFromD1(
      env,
      SITE_ID,
      PREVIOUS_WINDOW,
      "hour",
      emptyPrepared,
      "lcp",
    );
    expect(emptyTrend).toEqual(
      parentTrendDto(
        database,
        SITE_ID,
        PREVIOUS_WINDOW,
        "hour",
        emptyPrepared,
        "lcp",
      ),
    );
    const emptyAllTrends = await queryAllPerformanceTrendsFromD1(
      env,
      SITE_ID,
      PREVIOUS_WINDOW,
      "hour",
      emptyPrepared,
    );
    expect(emptyAllTrends).toEqual(
      await queryParentAllTrends(
        env,
        SITE_ID,
        PREVIOUS_WINDOW,
        "hour",
        emptyPrepared,
      ),
    );
    expect(
      await queryPerformanceRoutesFromD1(
        env,
        SITE_ID,
        PREVIOUS_WINDOW,
        emptyPrepared,
        20,
      ),
    ).toEqual(
      await queryParentRoutes(env, SITE_ID, PREVIOUS_WINDOW, emptyPrepared, 20),
    );
    expect(
      await queryPerformanceCountriesFromD1(
        env,
        SITE_ID,
        PREVIOUS_WINDOW,
        emptyPrepared,
      ),
    ).toEqual(
      await queryParentCountries(env, SITE_ID, PREVIOUS_WINDOW, emptyPrepared),
    );
    const emptyDashboard = await queryPerformanceDashboardFromD1(
      env,
      SITE_ID,
      PREVIOUS_WINDOW,
      "hour",
      emptyPrepared,
      20,
    );
    expect(emptyDashboard).toEqual(
      await queryParentDashboard(
        env,
        SITE_ID,
        PREVIOUS_WINDOW,
        "hour",
        emptyPrepared,
        20,
      ),
    );
  });

  it("compiles one-statement public performance plans within the D1 budget", async () => {
    const direct40 = payloadExistsFilter(40);
    const direct39 = payloadExistsFilter(39);
    const prepared128 = preparedPageMatches();
    const preparedMetadata = scopedFilterMetadata(prepared128);
    if (!preparedMetadata)
      throw new Error("wave59_prepared_page_metadata_missing");
    const preparedPreviousTrend = buildPerformanceTrendPlan({
      siteId: SITE_ID,
      queryTime: queryWindowToTime(PREVIOUS_WINDOW),
      filters: prepared128,
      scopePlan: preparedMetadata.plan,
      preparedTimePolicy: "reader-window-v1",
      interval: "hour",
      metric: "lcp",
    });
    const preparedSource = preparedPreviousTrend.nodes.find(
      (node) => node.kind === "source",
    );
    expect(preparedSource).toMatchObject({
      selection: {
        time: {
          candidate: {
            startMs: PREVIOUS_WINDOW.startMs,
            endExclusiveMs: PREVIOUS_WINDOW.endExclusiveMs,
          },
        },
        preparationTime: {
          candidate: {
            startMs: WINDOW.startMs,
            endExclusiveMs: WINDOW.endExclusiveMs,
          },
        },
      },
    });
    const profiles: Array<{
      readonly name: string;
      readonly invoke: (env: Env) => Promise<unknown>;
      readonly enforceBudget?: boolean;
    }> = [
      {
        name: "summary-plain",
        invoke: (env: Env) =>
          queryPerformanceSummariesFromD1(
            env,
            SITE_ID,
            WINDOW,
            EMPTY_FILTER_DOCUMENT,
          ),
      },
      {
        name: "trend-lcp-plain",
        invoke: (env: Env) =>
          queryPerformanceTrendFromD1(
            env,
            SITE_ID,
            WINDOW,
            "hour",
            EMPTY_FILTER_DOCUMENT,
            "lcp",
          ),
      },
      {
        name: "trend-cls-plain",
        invoke: (env: Env) =>
          queryPerformanceTrendFromD1(
            env,
            SITE_ID,
            WINDOW,
            "hour",
            EMPTY_FILTER_DOCUMENT,
            "cls",
          ),
      },
      {
        name: "all-trends-plain",
        invoke: (env: Env) =>
          queryAllPerformanceTrendsFromD1(
            env,
            SITE_ID,
            WINDOW,
            "hour",
            EMPTY_FILTER_DOCUMENT,
          ),
      },
      {
        name: "routes-plain",
        invoke: (env: Env) =>
          queryPerformanceRoutesFromD1(
            env,
            SITE_ID,
            WINDOW,
            EMPTY_FILTER_DOCUMENT,
            20,
          ),
      },
      {
        name: "countries-plain",
        invoke: (env: Env) =>
          queryPerformanceCountriesFromD1(
            env,
            SITE_ID,
            WINDOW,
            EMPTY_FILTER_DOCUMENT,
          ),
      },
      {
        name: "dashboard-plain",
        invoke: (env: Env) =>
          queryPerformanceDashboardFromD1(
            env,
            SITE_ID,
            WINDOW,
            "hour",
            EMPTY_FILTER_DOCUMENT,
            20,
          ),
      },
      {
        name: "summary-direct-40",
        invoke: (env: Env) =>
          queryPerformanceSummariesFromD1(env, SITE_ID, WINDOW, direct40),
      },
      {
        name: "trend-direct-40",
        invoke: (env: Env) =>
          queryPerformanceTrendFromD1(
            env,
            SITE_ID,
            WINDOW,
            "hour",
            direct40,
            "lcp",
          ),
      },
      {
        name: "summary-direct-39",
        invoke: (env: Env) =>
          queryPerformanceSummariesFromD1(env, SITE_ID, WINDOW, direct39),
      },
      {
        name: "trend-direct-39",
        invoke: (env: Env) =>
          queryPerformanceTrendFromD1(
            env,
            SITE_ID,
            WINDOW,
            "hour",
            direct39,
            "lcp",
          ),
      },
      {
        name: "routes-direct-40",
        invoke: (env: Env) =>
          queryPerformanceRoutesFromD1(env, SITE_ID, WINDOW, direct40, 20),
      },
      {
        name: "routes-direct-39",
        invoke: (env: Env) =>
          queryPerformanceRoutesFromD1(env, SITE_ID, WINDOW, direct39, 20),
      },
      {
        name: "dashboard-direct-40",
        invoke: (env: Env) =>
          queryPerformanceDashboardFromD1(
            env,
            SITE_ID,
            WINDOW,
            "hour",
            direct40,
            20,
          ),
      },
      {
        name: "dashboard-direct-39",
        invoke: (env: Env) =>
          queryPerformanceDashboardFromD1(
            env,
            SITE_ID,
            WINDOW,
            "hour",
            direct39,
            20,
          ),
      },
      {
        name: "summary-prepared-page-128-previous-window",
        invoke: (env: Env) =>
          queryPerformanceSummariesFromD1(
            env,
            SITE_ID,
            PREVIOUS_WINDOW,
            prepared128,
          ),
      },
      {
        name: "trend-prepared-page-128-previous-window",
        invoke: (env: Env) =>
          queryPerformanceTrendFromD1(
            env,
            SITE_ID,
            PREVIOUS_WINDOW,
            "hour",
            prepared128,
            "lcp",
          ),
      },
      {
        name: "dashboard-prepared-page-128-previous-window",
        invoke: (env: Env) =>
          queryPerformanceDashboardFromD1(
            env,
            SITE_ID,
            PREVIOUS_WINDOW,
            "hour",
            prepared128,
            20,
          ),
      },
    ];

    const coverageInputs = [
      { suffix: "plain", window: WINDOW, filters: EMPTY_FILTER_DOCUMENT },
      { suffix: "direct-40", window: WINDOW, filters: direct40 },
      { suffix: "direct-39", window: WINDOW, filters: direct39 },
      {
        suffix: "prepared-page-128-previous-window",
        window: PREVIOUS_WINDOW,
        filters: prepared128,
      },
    ] as const;
    const readers = [
      {
        key: "all-trends",
        current: (env: Env, window: QueryWindow, filters: FilterDocument) =>
          queryAllPerformanceTrendsFromD1(
            env,
            SITE_ID,
            window,
            "hour",
            filters,
          ),
        parent: (env: Env, window: QueryWindow, filters: FilterDocument) =>
          queryParentAllTrends(env, SITE_ID, window, "hour", filters),
      },
      {
        key: "routes",
        current: (env: Env, window: QueryWindow, filters: FilterDocument) =>
          queryPerformanceRoutesFromD1(env, SITE_ID, window, filters, 20),
        parent: (env: Env, window: QueryWindow, filters: FilterDocument) =>
          queryParentRoutes(env, SITE_ID, window, filters, 20),
      },
      {
        key: "countries",
        current: (env: Env, window: QueryWindow, filters: FilterDocument) =>
          queryPerformanceCountriesFromD1(env, SITE_ID, window, filters),
        parent: (env: Env, window: QueryWindow, filters: FilterDocument) =>
          queryParentCountries(env, SITE_ID, window, filters),
      },
      {
        key: "dashboard",
        current: (env: Env, window: QueryWindow, filters: FilterDocument) =>
          queryPerformanceDashboardFromD1(
            env,
            SITE_ID,
            window,
            "hour",
            filters,
            20,
          ),
        parent: (env: Env, window: QueryWindow, filters: FilterDocument) =>
          queryParentDashboard(env, SITE_ID, window, "hour", filters, 20),
      },
    ] as const;
    const existingProfileNames = new Set(profiles.map(({ name }) => name));
    for (const input of coverageInputs) {
      for (const reader of readers) {
        const currentName = `${reader.key}-${input.suffix}`;
        if (input.suffix !== "plain" && !existingProfileNames.has(currentName))
          profiles.push({
            name: currentName,
            invoke: (env) => reader.current(env, input.window, input.filters),
          });
        profiles.push({
          name: `parent-${reader.key}-${input.suffix}`,
          invoke: (env) => reader.parent(env, input.window, input.filters),
          enforceBudget: false,
        });
      }
    }

    const evidence = [];
    for (const profile of profiles) {
      const compiled =
        profile.enforceBudget === false
          ? {
              ...(await captureParentSql(profile.invoke)),
              observation: undefined,
            }
          : await compileObserved(profile.name, profile.invoke);
      const sqlBytes = new TextEncoder().encode(compiled.sql).byteLength;
      const bindCount = compiled.bindings.length;
      expect(compiled.statementCount, profile.name).toBe(1);
      if (profile.enforceBudget !== false) {
        expect(sqlBytes, profile.name).toBeLessThanOrEqual(
          D1_MAX_SQL_UTF8_BYTES,
        );
        expect(bindCount, profile.name).toBeLessThanOrEqual(
          D1_MAX_BOUND_PARAMETERS,
        );
      }
      if (profile.enforceBudget !== false)
        expect(compiled.observation?.physicalPlanHash, profile.name).toMatch(
          /^v\d+:/u,
        );
      evidence.push({
        name: profile.name,
        sqlBytes,
        bindCount,
        statements: compiled.statementCount,
        physicalPlanHash:
          profile.enforceBudget === false
            ? undefined
            : compiled.observation?.physicalPlanHash,
        tag:
          profile.enforceBudget === false
            ? undefined
            : compiled.observation?.tag,
        meetsBudget:
          sqlBytes <= D1_MAX_SQL_UTF8_BYTES &&
          bindCount <= D1_MAX_BOUND_PARAMETERS,
      });
    }
    expect(evidence).toHaveLength(profiles.length);
  });

  it("rejects nonnumeric values, percentile bounds, and output-name collisions", () => {
    const builder = new LogicalPlanBuilder({
      subject: createSemanticSubjectDomain({
        origin: "site",
        siteIds: [SITE_ID as never],
      }),
      time: createSemanticTemporalDomains({
        candidate: { startMs: 0, endExclusiveMs: 1 } as never,
        read: {
          kind: "bounded",
          range: { startMs: 0, endExclusiveMs: 1 } as never,
        },
        reportingTimeZone: "UTC" as never,
        capturedAtMs: 1 as never,
      }),
      scope: resolveAnalyticsScope("auto"),
    });
    const source = builder.source("page", {
      attributes: ["page.report.country", "page.report.perfLcpMs"],
    });
    const value = pageAttribute(builder, source, "perfLcpMs");
    const text = pageAttribute(builder, source, "country");
    expect(() => builder.sampleStatistics(source, {}, text, [])).toThrow(
      "logical_builder_sample_statistics_requires_numeric_value",
    );
    expect(() =>
      builder.sampleStatistics(source, {}, value, [
        { name: "p101", percentile: 101 },
      ]),
    ).toThrow("logical_builder_sample_statistics_invalid_percentile");
    expect(() =>
      builder.sampleStatistics(source, { avg: text }, value, []),
    ).toThrow("logical_builder_sample_statistics_output_name_collision");
  });
});
