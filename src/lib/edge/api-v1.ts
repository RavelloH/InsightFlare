import type { z } from "zod";

import { readJsonResponse } from "@/lib/response";
import { DEFAULT_SITE_SCRIPT_SETTINGS } from "@/lib/site-settings";
import {
  FunnelAnalyzeInputSchema,
  FunnelCreateInputSchema,
} from "@/schemas/funnel";
import { SiteCreateInputSchema, SiteUpdateInputSchema } from "@/schemas/site";
import { SiteConfigUpdateInputSchema } from "@/schemas/site-config";

import {
  buildTimeBuckets,
  buildVisitFilterSql,
  buildVisitSourceCte,
  buildVisitSourceCteForSites,
  parseInterval,
  PERFORMANCE_METRIC_COLUMNS,
  type PerformanceMetricKey,
  queryD1All,
  type QueryWindow,
  resolveCrossBreakdownDimension,
  visitSourceBindings,
  visitSourceBindingsForSites,
} from "./query/core";
import { normalizeFunnelSteps } from "./query/funnels";
import {
  queryAllPerformanceTrendsFromD1,
  queryPerformanceSummariesFromD1,
} from "./query/performance";
import {
  createSiteWithDefaultSettings,
  deleteSiteData,
  ensurePublicSlugAvailable,
} from "./admin-sites";
import {
  type ApiKeyPrincipal,
  authenticateApiKey,
  canAccessSiteId,
  hasFullSiteAccess,
} from "./api-key-auth";
import {
  ANALYTICS_DIMENSIONS,
  ANALYTICS_METRICS,
  type AnalyticsDimension,
  type AnalyticsMetric,
  API_V1_VERSION,
  BATCH_MAX_REQUESTS,
  epochSecondsToIso,
  INTERVALS,
  jsonError,
  jsonList,
  jsonPaginated,
  jsonSuccess,
  methodNotAllowed,
  normalizeUnknownDirect,
  parseCursorPagination,
  type ParsedTimeRange,
  parseMetrics,
  parseSort,
  parseTimeRange,
  requireScope,
  TIME_PRESETS,
  validateCrossBreakdownDimension,
  validateDimension,
} from "./api-v1-helpers";
import {
  apiV1OverviewMetrics,
  queryApiV1Breakdown,
  queryApiV1CrossBreakdown,
  queryApiV1EventFields,
  queryApiV1EventFieldValues,
  queryApiV1EventRecordDetail,
  queryApiV1EventRecords,
  queryApiV1EventsSummary,
  queryApiV1EventsTrend,
  queryApiV1EventTypeDetail,
  queryApiV1EventTypes,
  queryApiV1Explore,
  queryApiV1FilterValues,
  queryApiV1FunnelAnalysis,
  queryApiV1JourneyEvents,
  queryApiV1JourneySessions,
  queryApiV1Overview,
  queryApiV1Performance,
  queryApiV1Retention,
  queryApiV1SavedFunnelAnalysis,
  queryApiV1SessionDetail,
  queryApiV1Sessions,
  queryApiV1TeamBreakdown,
  queryApiV1TeamDashboard,
  queryApiV1Trend,
  queryApiV1VisitorDetail,
  queryApiV1Visitors,
} from "./api-v1-query-adapter";
import {
  FILTER_OPERATOR_IDS,
  type FilterDocument,
  parseApiV1FilterDocument,
  parseApiV1FilterUrl,
} from "./query-contract";
import {
  readSiteScriptSettings,
  upsertSiteScriptSettings,
} from "./site-settings-store";
import type { Env } from "./types";

interface ApiV1SiteRow {
  id: string;
  teamId: string;
  name: string;
  domain: string;
  publicEnabled: number;
  publicSlug: string | null;
  createdAt: number;
  updatedAt: number;
}

interface TeamRow {
  id: string;
  name: string;
  createdAt: number;
}

interface BatchRequestInput {
  id: string;
  method: string;
  path: string;
  query?: Record<string, string | number | boolean | null>;
}

interface FunnelRow {
  id: string;
  site_id: string;
  name: string;
  config_json: string;
  created_at: number;
  updated_at: number;
}

interface FunnelStepInput {
  type: "pageview" | "event";
  value: string;
}

const FUNNEL_KIND = "funnel";

const DIMENSION_TO_QUERY_NAME: Partial<Record<AnalyticsDimension, string>> = {
  "page.path": "overview-page-path",
  "page.title": "overview-page-title",
  "page.hostname": "overview-page-hostname",
  "page.query": "page-query",
  "page.hash": "page-hash",
  "session.entryPath": "overview-page-entry",
  "session.exitPath": "overview-page-exit",
  "referrer.domain": "overview-source-domain",
  "referrer.url": "overview-source-link",
  "utm.source": "utm-source",
  "utm.medium": "utm-medium",
  "utm.campaign": "utm-campaign",
  "utm.term": "utm-term",
  "utm.content": "utm-content",
  "client.browser": "overview-client-browser",
  "client.osVersion": "overview-client-os-version",
  "client.deviceType": "overview-client-device-type",
  "client.language": "overview-client-language",
  "client.screenSize": "overview-client-screen-size",
  "geo.country": "overview-geo-country",
  "geo.region": "overview-geo-region",
  "geo.city": "overview-geo-city",
  "geo.continent": "overview-geo-continent",
  "geo.timeZone": "overview-geo-timezone",
  "geo.organization": "overview-geo-organization",
  "event.name": "event-types",
};

function apiBase(url: URL): string {
  return url.pathname.replace(/^\/api\/v1\/?/, "");
}

export function apiV1Segments(url: URL): string[] {
  return apiBase(url)
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .filter((segment) => segment.length > 0);
}

function siteLinks(siteId: string): Record<string, string> {
  const base = `/api/v1/sites/${encodeURIComponent(siteId)}`;
  return {
    self: base,
    tracking: `${base}/tracking`,
    privacy: `${base}/privacy`,
    sharing: `${base}/sharing`,
    analyticsOverview: `${base}/analytics/overview`,
    analyticsSchema: `${base}/analytics/schema`,
    events: `${base}/events`,
    sessions: `${base}/sessions`,
    visitors: `${base}/visitors`,
    realtime: `${base}/realtime/snapshot`,
  };
}

function sitePayload(row: ApiV1SiteRow) {
  return {
    id: row.id,
    name: row.name,
    domain: row.domain,
    createdAt: epochSecondsToIso(row.createdAt),
    updatedAt: epochSecondsToIso(row.updatedAt),
    sharing: {
      publicEnabled: row.publicEnabled === 1,
      publicSlug: row.publicSlug,
    },
    links: siteLinks(row.id),
  };
}

function trackingPayload(
  config: typeof DEFAULT_SITE_SCRIPT_SETTINGS,
  domain: string,
) {
  return {
    trackPageviews: true,
    trackQuery: config.trackQueryParams,
    trackHash: config.trackHash,
    trackCustomEvents: true,
    trackEngagement: true,
    trackWebVitals: config.performanceSampleRate > 0,
    autoTrackOutboundLinks: config.autoTrackOutboundLinks,
    trackingStrength: config.trackingStrength,
    allowedDomains: [domain, ...config.domainWhitelist],
    excludedPaths: config.pathBlacklist,
  };
}

function toQueryWindow(timeRange: ParsedTimeRange) {
  return {
    startMs: timeRange.startMs,
    endExclusiveMs: timeRange.endExclusiveMs,
    nowMs: Date.now(),
    timeZone: timeRange.timeZone,
  };
}

function parseFunnelSteps(configJson: string): FunnelStepInput[] {
  try {
    const parsed = JSON.parse(configJson) as { steps?: unknown };
    return normalizeFunnelSteps(parsed.steps);
  } catch {
    return [];
  }
}

function serializeFunnelSteps(steps: FunnelStepInput[]): string {
  return JSON.stringify({ steps });
}

function funnelPayload(row: FunnelRow) {
  const siteId = row.site_id;
  const id = row.id;
  return {
    id,
    siteId,
    name: row.name,
    steps: parseFunnelSteps(row.config_json),
    createdAt: epochSecondsToIso(row.created_at),
    updatedAt: epochSecondsToIso(row.updated_at),
    links: {
      self: `/api/v1/sites/${siteId}/funnels/${id}`,
      analysis: `/api/v1/sites/${siteId}/funnels/${id}/analysis`,
    },
  };
}

function privacyPayload(config: typeof DEFAULT_SITE_SCRIPT_SETTINGS) {
  return {
    respectDoNotTrack: !config.ignoreDoNotTrack,
    anonymizeIp: true,
    euMode: config.trackingStrength === "weak",
    visitorTokenMode: "daily",
    dataRetentionDays: 180,
  };
}

function legacySettingsFromTracking(input: unknown): Record<string, unknown> {
  const body = input && typeof input === "object" ? input : {};
  const record = body as Record<string, unknown>;
  return {
    ...(typeof record.trackQuery === "boolean"
      ? { trackQueryParams: record.trackQuery }
      : {}),
    ...(typeof record.trackHash === "boolean"
      ? { trackHash: record.trackHash }
      : {}),
    ...(typeof record.autoTrackOutboundLinks === "boolean"
      ? { autoTrackOutboundLinks: record.autoTrackOutboundLinks }
      : {}),
    ...(typeof record.trackingStrength === "string"
      ? { trackingStrength: record.trackingStrength }
      : {}),
    ...(Array.isArray(record.allowedDomains)
      ? { domainWhitelist: record.allowedDomains.slice(1) }
      : {}),
    ...(Array.isArray(record.excludedPaths)
      ? { pathBlacklist: record.excludedPaths }
      : {}),
    ...(typeof record.trackWebVitals === "boolean"
      ? { performanceSampleRate: record.trackWebVitals ? 100 : 0 }
      : {}),
  };
}

async function parseJsonBody(request: Request): Promise<unknown | Response> {
  try {
    return await request.json();
  } catch {
    return jsonError(
      "invalid_json",
      "Invalid JSON body",
      400,
      undefined,
      request,
    );
  }
}

async function parseAndValidateApiV1Body<T>(
  request: Request,
  schema: z.ZodType<T>,
) {
  const body = await parseJsonBody(request);
  if (body instanceof Response) return { ok: false as const, response: body };
  return validateApiV1Value(request, body, schema);
}

function validateApiV1Value<T>(
  request: Request,
  value: unknown,
  schema: z.ZodType<T>,
) {
  const result = schema.safeParse(value);
  if (!result.success) {
    const message = result.error.issues
      .map((issue) => {
        const path = issue.path.join(".");
        return path ? `${path}: ${issue.message}` : issue.message;
      })
      .join("; ");
    return {
      ok: false as const,
      response: jsonError(
        "validation_failed",
        message || "Validation failed",
        400,
        { issues: result.error.issues },
        request,
      ),
    };
  }
  return { ok: true as const, data: result.data };
}

async function siteById(
  env: Env,
  principal: ApiKeyPrincipal,
  siteId: string,
  request: Request,
): Promise<ApiV1SiteRow | Response> {
  if (!canAccessSiteId(principal, siteId)) {
    return jsonError(
      "site_not_found",
      "Site not found",
      404,
      undefined,
      request,
    );
  }
  const row = await env.DB.prepare(
    `
      SELECT
        id,
        team_id AS teamId,
        name,
        domain,
        public_enabled AS publicEnabled,
        public_slug AS publicSlug,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM sites
      WHERE id=? AND team_id=?
      LIMIT 1
    `,
  )
    .bind(siteId, principal.teamId)
    .first<ApiV1SiteRow>();
  return (
    row ??
    jsonError("site_not_found", "Site not found", 404, undefined, request)
  );
}

async function listSites(
  env: Env,
  principal: ApiKeyPrincipal,
): Promise<ApiV1SiteRow[]> {
  const rows = await env.DB.prepare(
    `
      SELECT
        id,
        team_id AS teamId,
        name,
        domain,
        public_enabled AS publicEnabled,
        public_slug AS publicSlug,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM sites
      WHERE team_id=?
      ORDER BY created_at DESC
    `,
  )
    .bind(principal.teamId)
    .all<ApiV1SiteRow>();
  if (hasFullSiteAccess(principal)) return rows.results;
  const allowed = new Set(principal.siteIds);
  return rows.results.filter((site) => allowed.has(site.id));
}

async function teamByPrincipal(
  env: Env,
  principal: ApiKeyPrincipal,
): Promise<TeamRow> {
  const row = await env.DB.prepare(
    `
      SELECT id, name, created_at AS createdAt
      FROM teams
      WHERE id=?
      LIMIT 1
    `,
  )
    .bind(principal.teamId)
    .first<TeamRow>();
  return (
    row ?? {
      id: principal.teamId,
      name: principal.teamId,
      createdAt: principal.createdAt ?? 0,
    }
  );
}

function buildInternalUrl(url: URL, timeRange?: ParsedTimeRange): URL {
  const next = new URL(url.toString());
  if (timeRange) {
    next.searchParams.set("from", String(timeRange.startMs));
    next.searchParams.set("to", String(timeRange.endExclusiveMs));
    next.searchParams.set("timeZone", timeRange.timeZone);
    next.searchParams.delete("preset");
  }
  const sort = parseSort(url.searchParams.get("sort"));
  if (sort) {
    next.searchParams.set("sortBy", sort.field);
    next.searchParams.set("sortDir", sort.direction);
  }
  return next;
}

function filterMetrics(value: unknown, metrics: AnalyticsMetric[]): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const metric of metrics) {
    if (metric in record) out[metric] = record[metric];
  }
  if ("approximateVisitors" in record) {
    out.approximateVisitors = record.approximateVisitors;
  }
  return out;
}

function apiV1QueryFailure(
  error: { kind: string },
  request: Request,
): Response {
  const status =
    error.kind === "internal" || error.kind === "data-unavailable" ? 500 : 400;
  return jsonError("invalid_request", error.kind, status, undefined, request);
}

function parseApiV1Filters(
  input: URL | unknown,
  request: Request,
): FilterDocument | Response {
  try {
    return input instanceof URL
      ? parseApiV1FilterUrl(input)
      : parseApiV1FilterDocument(input);
  } catch (error) {
    return jsonError(
      "validation_failed",
      error instanceof Error ? error.message : "Invalid filters",
      400,
      undefined,
      request,
    );
  }
}

function normalizeBreakdownRows(value: unknown, metrics: AnalyticsMetric[]) {
  if (!Array.isArray(value)) return [];
  return value.map((row) => {
    const record = row && typeof row === "object" ? row : {};
    const source = record as Record<string, unknown>;
    const normalized = normalizeUnknownDirect(
      source.value ?? source.key ?? source.label,
    );
    const metricValues = filterMetrics(source, metrics);
    return {
      key: normalized.key,
      label: String(source.label ?? normalized.label),
      ...(metricValues && typeof metricValues === "object" ? metricValues : {}),
    };
  });
}

interface AnalyticsOrderBy {
  field: string;
  direction: "asc" | "desc";
}

const D1_MAX_BOUND_PARAMETERS = 100;

function sqlWhereWithExtra(baseClause: string, extraClause: string): string {
  if (!extraClause) return baseClause;
  if (baseClause.trim()) return `${baseClause} AND ${extraClause}`;
  return `WHERE ${extraClause}`;
}

function analyticsMetricSql(metric: AnalyticsMetric): string {
  const sessions =
    "COUNT(DISTINCT CASE WHEN scoped.session_id != '' THEN scoped.session_id ELSE NULL END)";
  const bounces =
    "COUNT(DISTINCT CASE WHEN bounced_sessions.session_id IS NOT NULL THEN scoped.session_id ELSE NULL END)";

  if (metric === "views") return "COUNT(*)";
  if (metric === "sessions") return sessions;
  if (metric === "visitors") {
    return "COUNT(DISTINCT CASE WHEN scoped.visitor_id != '' THEN scoped.visitor_id ELSE NULL END)";
  }
  if (metric === "bounces") return bounces;
  if (metric === "bounceRate") {
    return `CASE WHEN ${sessions} > 0 THEN CAST(${bounces} AS REAL) / ${sessions} ELSE 0 END`;
  }
  if (metric === "avgDurationMs") {
    return `CASE WHEN ${sessions} > 0 THEN ROUND(COALESCE(SUM(CASE WHEN scoped.duration_ms IS NOT NULL AND scoped.duration_ms >= 0 THEN scoped.duration_ms ELSE 0 END), 0) / ${sessions}) ELSE 0 END`;
  }
  if (metric === "viewsPerSession") {
    return `CASE WHEN ${sessions} > 0 THEN CAST(COUNT(*) AS REAL) / ${sessions} ELSE 0 END`;
  }
  return "COALESCE(SUM(event_rollup.event_count), 0)";
}

function validateAnalyticsDimensions(
  dimensions: string[],
  request: Request,
): Response | null {
  for (const dimension of dimensions) {
    const valid = validateDimension(dimension);
    if (valid instanceof Response) return valid;
    if (!resolveCrossBreakdownDimension(dimension)) {
      return jsonError(
        "validation_failed",
        "Unsupported dimension",
        400,
        { dimension },
        request,
      );
    }
  }
  return null;
}

function parseExploreMetrics(value: unknown): AnalyticsMetric[] | Response {
  if (value === undefined) return ["views"];
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    return jsonError("validation_failed", "Invalid metrics", 400, {
      field: "metrics",
    });
  }
  const invalid = value.find(
    (metric) =>
      typeof metric !== "string" ||
      !ANALYTICS_METRICS.includes(metric as AnalyticsMetric),
  );
  if (invalid !== undefined) {
    return jsonError("validation_failed", "Unknown metric", 400, {
      metric: String(invalid),
    });
  }
  return [...new Set(value)] as AnalyticsMetric[];
}

function parseExploreDimensions(value: unknown): string[] | Response {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 5) {
    return jsonError("validation_failed", "Invalid dimensions", 400, {
      field: "dimensions",
    });
  }
  const invalid = value.find((dimension) => typeof dimension !== "string");
  if (invalid !== undefined) {
    return jsonError("validation_failed", "Invalid dimension", 400, {
      dimension: String(invalid),
    });
  }
  return [...new Set(value)] as string[];
}

function parseExploreOrderBy(value: unknown): AnalyticsOrderBy[] | Response {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 5) {
    return jsonError("validation_failed", "Invalid orderBy", 400, {
      field: "orderBy",
    });
  }
  const orderBy: AnalyticsOrderBy[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      return jsonError("validation_failed", "Invalid orderBy", 400);
    }
    const record = item as Record<string, unknown>;
    const field = typeof record.field === "string" ? record.field : "";
    const direction = record.direction === "asc" ? "asc" : "desc";
    if (!field) {
      return jsonError("validation_failed", "Invalid orderBy field", 400);
    }
    orderBy.push({ field, direction });
  }
  return orderBy;
}

function parseExploreLimit(value: unknown): number | Response {
  if (value === undefined) return 100;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    return jsonError("validation_failed", "Invalid limit", 400, {
      field: "limit",
    });
  }
  return limit;
}

function urlWithBodyTimeRange(url: URL, record: Record<string, unknown>): URL {
  const timeRange =
    record.timeRange && typeof record.timeRange === "object"
      ? (record.timeRange as Record<string, unknown>)
      : null;
  if (!timeRange) return url;
  const next = new URL(url.toString());
  for (const key of ["from", "to", "preset", "timeZone"] as const) {
    if (typeof timeRange[key] === "string") {
      next.searchParams.set(key, timeRange[key]);
    }
  }
  return next;
}

async function queryAnalyticsAggregateRows(
  env: Env,
  siteIds: string[],
  window: QueryWindow,
  filters: FilterDocument,
  request: Request,
  options: {
    dimensions: string[];
    metrics: AnalyticsMetric[];
    limit: number;
    orderBy?: AnalyticsOrderBy[];
  },
): Promise<Array<Record<string, unknown>> | Response> {
  if (siteIds.length === 0) return [];
  const invalidDimension = validateAnalyticsDimensions(
    options.dimensions,
    request,
  );
  if (invalidDimension) return invalidDimension;

  const dimensionDefs = options.dimensions.map((dimension) => ({
    dimension,
    definition: resolveCrossBreakdownDimension(dimension)!,
  }));
  const compiledFilters = buildVisitFilterSql(filters);
  const whereClause = compiledFilters.clause;
  const sourceCte =
    siteIds.length === 1
      ? buildVisitSourceCte()
      : buildVisitSourceCteForSites(siteIds.length);
  const sourceBindings =
    siteIds.length === 1
      ? visitSourceBindings(siteIds[0]!, window)
      : visitSourceBindingsForSites(siteIds, window);
  const needsBounces = options.metrics.some(
    (metric) => metric === "bounces" || metric === "bounceRate",
  );
  const needsEvents = options.metrics.includes("events");
  const eventSitePlaceholders = needsEvents
    ? siteIds.map(() => "?").join(", ")
    : "";
  const auxiliaryBindings = needsEvents
    ? [...siteIds, window.startMs, window.endExclusiveMs]
    : [];
  const bindingCount =
    sourceBindings.length +
    compiledFilters.bindings.length +
    auxiliaryBindings.length +
    1;
  if (bindingCount > D1_MAX_BOUND_PARAMETERS) {
    return jsonError(
      "validation_failed",
      "Analytics query exceeds the D1 bound parameter limit",
      400,
      {
        maximumBindings: D1_MAX_BOUND_PARAMETERS,
        requestedBindings: bindingCount,
      },
      request,
    );
  }
  const dimensionSelects = dimensionDefs.map(
    ({ definition }, index) => `${definition.labelExpr} AS d${index}`,
  );
  const groupColumns = dimensionDefs.map((_, index) => `scoped.d${index}`);
  const metricSelects = options.metrics.map(
    (metric) => `${analyticsMetricSql(metric)} AS ${metric}`,
  );
  const selectColumns = [...groupColumns, ...metricSelects];
  const allowedOrderFields = new Set([
    ...options.metrics,
    ...options.dimensions,
  ]);
  const orderBy = (options.orderBy ?? []).filter((item) =>
    allowedOrderFields.has(item.field as AnalyticsMetric),
  );
  const orderSql =
    orderBy.length > 0
      ? orderBy
          .map((item) => {
            const dimensionIndex = options.dimensions.indexOf(item.field);
            const column =
              dimensionIndex >= 0 ? `scoped.d${dimensionIndex}` : item.field;
            return `${column} ${item.direction.toUpperCase()}`;
          })
          .join(", ")
      : options.metrics.length > 0
        ? `${options.metrics[0]} DESC`
        : groupColumns.join(", ");
  const auxiliaryCtes = [
    needsBounces
      ? `
bounced_sessions AS (
  SELECT session_id
  FROM visit_source
  WHERE session_id != ''
  GROUP BY session_id
  HAVING COUNT(*) = 1
)`
      : "",
    needsEvents
      ? `
event_rollup AS (
  SELECT visit_id, COUNT(*) AS event_count
  FROM custom_events
  WHERE site_id IN (${eventSitePlaceholders}) AND occurred_at BETWEEN ? AND ?
  GROUP BY visit_id
)`
      : "",
  ]
    .filter(Boolean)
    .join(",\n");
  const auxiliaryJoins = [
    needsBounces
      ? "LEFT JOIN bounced_sessions ON bounced_sessions.session_id = scoped.session_id"
      : "",
    needsEvents
      ? "LEFT JOIN event_rollup ON event_rollup.visit_id = scoped.visit_id"
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  const sql = `
WITH
${sourceCte},
scoped AS (
  SELECT
    visit_source.*
    ${dimensionSelects.length ? `,\n    ${dimensionSelects.join(",\n    ")}` : ""}
  FROM visit_source
  ${whereClause}
)${auxiliaryCtes ? `,\n${auxiliaryCtes}` : ""}
SELECT
  ${selectColumns.join(",\n  ")}
FROM scoped
${auxiliaryJoins}
${groupColumns.length ? `GROUP BY ${groupColumns.join(", ")}` : ""}
ORDER BY ${orderSql || "views DESC"}
LIMIT ?
`;
  const rows = await queryD1All<Record<string, unknown>>(env, sql, [
    ...sourceBindings,
    ...compiledFilters.bindings,
    ...auxiliaryBindings,
    options.limit,
  ]);
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    options.dimensions.forEach((dimension, index) => {
      out[dimension] = String(row[`d${index}`] ?? "");
    });
    for (const metric of options.metrics) {
      out[metric] = Number(row[metric] ?? 0);
    }
    return out;
  });
}

async function queryTeamAnalyticsBreakdown(
  env: Env,
  siteIds: string[],
  window: QueryWindow,
  url: URL,
  filters: FilterDocument,
  request: Request,
  dimension: AnalyticsDimension,
  metrics: AnalyticsMetric[],
): Promise<Array<Record<string, unknown>> | Response> {
  const limit = parseExploreLimit(Number(url.searchParams.get("limit") ?? 100));
  if (limit instanceof Response) return limit;
  const rows = await queryAnalyticsAggregateRows(
    env,
    siteIds,
    window,
    filters,
    request,
    {
      dimensions: [dimension],
      metrics,
      limit,
    },
  );
  if (rows instanceof Response) return rows;
  return rows.map((row) => {
    const normalized = normalizeUnknownDirect(row[dimension]);
    const metricsOut: Record<string, unknown> = {};
    for (const metric of metrics) metricsOut[metric] = row[metric];
    return {
      key: normalized.key,
      label: normalized.label,
      ...metricsOut,
    };
  });
}

function parsePerformanceMetric(url: URL): PerformanceMetricKey | Response {
  const metric = url.searchParams.get("metric") || "lcp";
  if (metric in PERFORMANCE_METRIC_COLUMNS)
    return metric as PerformanceMetricKey;
  return jsonError("validation_failed", "Invalid performance metric", 400, {
    metric,
  });
}

function performanceSummaryValue(row: {
  p75: number | null;
  avg: number | null;
}): number | null {
  return row.p75 ?? row.avg;
}

async function queryPerformanceSummaryData(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
) {
  const summaries = await queryPerformanceSummariesFromD1(
    env,
    siteId,
    window,
    filters,
  );
  return {
    ttfb: performanceSummaryValue(summaries.ttfb),
    fcp: performanceSummaryValue(summaries.fcp),
    lcp: performanceSummaryValue(summaries.lcp),
    cls: performanceSummaryValue(summaries.cls),
    inp: performanceSummaryValue(summaries.inp),
    details: summaries,
  };
}

async function queryPerformanceTimeseriesData(
  env: Env,
  siteId: string,
  window: QueryWindow,
  url: URL,
  filters: FilterDocument,
) {
  const interval = parseInterval(url);
  const buckets = buildTimeBuckets(window, interval);
  const series = await queryAllPerformanceTrendsFromD1(
    env,
    siteId,
    window,
    interval,
    filters,
  );
  const rows = new Map<number, Record<string, unknown>>();
  for (const metric of Object.keys(series) as PerformanceMetricKey[]) {
    const points = series[metric];
    for (const point of points) {
      const bucket = buckets[point.bucket];
      if (!bucket) continue;
      const row =
        rows.get(point.bucket) ??
        ({
          start: new Date(bucket.startMs).toISOString(),
          end: new Date(bucket.endExclusiveMs).toISOString(),
        } satisfies Record<string, unknown>);
      row[metric] = performanceSummaryValue(point);
      rows.set(point.bucket, row);
    }
  }
  return {
    interval,
    rows: [...rows.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([, row]) => row),
  };
}

async function queryPerformanceBreakdownData(
  env: Env,
  siteId: string,
  window: QueryWindow,
  url: URL,
  filters: FilterDocument,
  request: Request,
  dimension: AnalyticsDimension,
): Promise<Array<Record<string, unknown>> | Response> {
  const metric = parsePerformanceMetric(url);
  if (metric instanceof Response) return metric;
  const definition = resolveCrossBreakdownDimension(dimension);
  if (!definition) {
    return jsonError(
      "validation_failed",
      "Unsupported performance breakdown dimension",
      400,
      { dimension },
      request,
    );
  }
  const compiledFilters = buildVisitFilterSql(filters);
  const whereClause = sqlWhereWithExtra(
    compiledFilters.clause,
    `${PERFORMANCE_METRIC_COLUMNS[metric]} IS NOT NULL`,
  );
  const limit = parseExploreLimit(Number(url.searchParams.get("limit") ?? 100));
  if (limit instanceof Response) return limit;
  const sql = `
WITH
${buildVisitSourceCte()},
scoped AS MATERIALIZED (
  SELECT
    ${definition.labelExpr} AS dimensionValue,
    ${PERFORMANCE_METRIC_COLUMNS[metric]} AS metricValue
  FROM visit_source
  ${whereClause}
),
ordered_values AS (
  SELECT
    dimensionValue,
    metricValue,
    ROW_NUMBER() OVER (PARTITION BY dimensionValue ORDER BY metricValue ASC) AS rowNum,
    COUNT(*) OVER (PARTITION BY dimensionValue) AS sampleCount
  FROM scoped
),
thresholds AS (
  SELECT
    dimensionValue,
    sampleCount,
    AVG(metricValue) AS avgValue,
    CAST(((sampleCount * 50) + 99) / 100 AS INTEGER) AS p50Rank,
    CAST(((sampleCount * 75) + 99) / 100 AS INTEGER) AS p75Rank,
    CAST(((sampleCount * 95) + 99) / 100 AS INTEGER) AS p95Rank
  FROM ordered_values
  GROUP BY dimensionValue, sampleCount
)
SELECT
  thresholds.dimensionValue AS dimensionValue,
  thresholds.sampleCount AS views,
  thresholds.sampleCount AS samples,
  thresholds.avgValue AS avg,
  MIN(CASE WHEN ordered_values.rowNum >= thresholds.p50Rank THEN ordered_values.metricValue END) AS p50,
  MIN(CASE WHEN ordered_values.rowNum >= thresholds.p75Rank THEN ordered_values.metricValue END) AS p75,
  MIN(CASE WHEN ordered_values.rowNum >= thresholds.p95Rank THEN ordered_values.metricValue END) AS p95
FROM thresholds
JOIN ordered_values ON ordered_values.dimensionValue = thresholds.dimensionValue
GROUP BY thresholds.dimensionValue, thresholds.sampleCount, thresholds.avgValue
ORDER BY p75 DESC, views DESC, thresholds.dimensionValue ASC
LIMIT ?
`;
  const rows = await queryD1All<Record<string, unknown>>(env, sql, [
    ...visitSourceBindings(siteId, window),
    ...compiledFilters.bindings,
    limit,
  ]);
  return rows.map((row) => {
    const normalized = normalizeUnknownDirect(row.dimensionValue);
    const p75 = Number(row.p75 ?? 0);
    return {
      key: normalized.key,
      label: normalized.label,
      views: Number(row.views ?? 0),
      [metric]: p75,
      avg: Number(row.avg ?? 0),
      p50: Number(row.p50 ?? 0),
      p75,
      p95: Number(row.p95 ?? 0),
      samples: Number(row.samples ?? 0),
    };
  });
}

function normalizeTimeseriesRows(
  value: unknown,
  buckets: ReturnType<typeof buildTimeBuckets>,
) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => {
    const record = row && typeof row === "object" ? row : {};
    const source = record as Record<string, unknown>;
    const bucketIndex = Number(source.bucket);
    const bucket =
      Number.isInteger(bucketIndex) && bucketIndex >= 0
        ? buckets[bucketIndex]
        : undefined;
    const startMs = Number(source.startMs ?? bucket?.startMs);
    const endExclusiveMs = Number(
      source.endExclusiveMs ?? bucket?.endExclusiveMs,
    );
    if (
      !Number.isFinite(startMs) ||
      !Number.isFinite(endExclusiveMs) ||
      endExclusiveMs <= startMs
    ) {
      return [];
    }
    const {
      bucket: _bucket,
      timestampMs: _timestampMs,
      startMs: _startMs,
      endExclusiveMs: _endExclusiveMs,
      source: _source,
      ...metrics
    } = source;
    return [
      {
        start: new Date(startMs).toISOString(),
        end: new Date(endExclusiveMs).toISOString(),
        ...metrics,
      },
    ];
  });
}

function requireSiteScope(
  request: Request,
  principal: ApiKeyPrincipal,
  scope: Parameters<typeof requireScope>[1],
): Response | null {
  return requireScope(principal.scopes, scope, request);
}

export async function handleRoot(request: Request): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(request);
  return jsonSuccess(
    {
      version: API_V1_VERSION,
      service: "insightflare",
      links: {
        openapi: "/.well-known/openapi.json",
        skills: "/.well-known/skills.json",
        token: "/api/v1/token",
        capabilities: "/api/v1/capabilities",
        team: "/api/v1/team",
        sites: "/api/v1/sites",
        batch: "/api/v1/batch",
      },
    },
    { request },
  );
}

export async function handleToken(
  request: Request,
  env: Env,
  principal: ApiKeyPrincipal,
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(request);
  const team = await teamByPrincipal(env, principal);
  return jsonSuccess(
    {
      id: principal.keyId,
      name: principal.name ?? "",
      status: principal.status ?? "active",
      createdAt: epochSecondsToIso(principal.createdAt),
      expiresAt: epochSecondsToIso(principal.expiresAt),
      lastUsedAt: epochSecondsToIso(principal.lastUsedAt),
      team: {
        id: team.id,
        name: team.name,
      },
      scopes: principal.scopes,
      siteAccess: {
        mode: hasFullSiteAccess(principal) ? "all" : "restricted",
        siteIds: principal.siteIds,
      },
    },
    { request },
  );
}

export async function handleTokenCheck(
  request: Request,
  principal: ApiKeyPrincipal,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(request);
  const body = await parseJsonBody(request);
  if (body instanceof Response) return body;
  const checks = Array.isArray((body as Record<string, unknown>).checks)
    ? ((body as Record<string, unknown>).checks as unknown[])
    : [];
  return jsonSuccess(
    {
      checks: checks.map((check) => {
        const item =
          check && typeof check === "object"
            ? (check as Record<string, unknown>)
            : {};
        const scope = String(item.scope || "");
        const siteId =
          typeof item.siteId === "string" ? item.siteId : undefined;
        const hasScope = principal.scopes.includes(scope as never);
        const hasSite = !siteId || canAccessSiteId(principal, siteId);
        const active = (principal.status ?? "active") === "active";
        return {
          scope,
          ...(siteId ? { siteId } : {}),
          allowed: hasScope && hasSite && active,
          ...(!hasScope
            ? { reason: "missing_scope" }
            : !hasSite
              ? { reason: "site_not_allowed" }
              : !active
                ? { reason: "token_inactive" }
                : {}),
        };
      }),
    },
    { request },
  );
}

export async function handleCapabilities(
  request: Request,
  principal: ApiKeyPrincipal,
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(request);
  const has = (scope: string) => principal.scopes.includes(scope as never);
  return jsonSuccess(
    {
      apiVersion: API_V1_VERSION,
      features: {
        sites: has("site:read") || has("site:write"),
        tracking: has("site_config:read") || has("site_config:write"),
        privacy: has("site_config:read") || has("site_config:write"),
        sharing: has("site_config:read") || has("site_config:write"),
        analytics: has("analytics:read"),
        events: has("analytics:read"),
        visitors: has("analytics:read"),
        sessions: has("analytics:read"),
        funnels: has("analytics:read"),
        performance: has("analytics:read"),
        realtime: has("analytics:read"),
        exports: false,
        batch: true,
      },
      limits: {
        batchMaxRequests: BATCH_MAX_REQUESTS,
        defaultTimeRangeDays: 7,
        maxTimeRangeDays: 365,
        defaultPageLimit: 100,
        maxPageLimit: 1000,
      },
      links: {
        token: "/api/v1/token",
        sites: "/api/v1/sites",
        batch: "/api/v1/batch",
      },
    },
    { request },
  );
}

export async function handleTeam(
  request: Request,
  env: Env,
  url: URL,
  principal: ApiKeyPrincipal,
  path: string[],
): Promise<Response> {
  if (path.length === 1) {
    if (request.method !== "GET") return methodNotAllowed(request);
    const team = await teamByPrincipal(env, principal);
    return jsonSuccess(
      {
        id: team.id,
        name: team.name,
        createdAt: epochSecondsToIso(team.createdAt),
        links: {
          usage: "/api/v1/team/usage",
          sites: "/api/v1/sites",
          analyticsOverview: "/api/v1/team/analytics/overview",
        },
      },
      { request },
    );
  }
  if (path[1] === "usage") {
    if (request.method !== "GET") return methodNotAllowed(request);
    const sites = await listSites(env, principal);
    return jsonSuccess({ sites: sites.length }, { request });
  }
  if (path[1] === "analytics") {
    return handleTeamAnalytics(request, env, url, principal, path);
  }
  return jsonError(
    "resource_not_found",
    "Resource not found",
    404,
    undefined,
    request,
  );
}

async function handleTeamAnalytics(
  request: Request,
  env: Env,
  url: URL,
  principal: ApiKeyPrincipal,
  path: string[],
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(request);
  const denied = requireSiteScope(request, principal, "analytics:read");
  if (denied) return denied;
  const resource = path[2];
  const timeRange = parseTimeRange(url);
  if (timeRange instanceof Response) return timeRange;
  const filters = parseApiV1Filters(url, request);
  if (filters instanceof Response) return filters;
  if (resource === "breakdowns" && path[3]) {
    const dimension = validateDimension(path[3]);
    if (dimension instanceof Response) return dimension;
    const metrics = parseMetrics(url.searchParams.get("metrics"));
    if (metrics instanceof Response) return metrics;
    const sites = await listSites(env, principal);
    const internalUrl = buildInternalUrl(url, timeRange);
    const result = await queryApiV1TeamBreakdown(
      principal.teamId,
      sites.map((site) => site.id),
      internalUrl,
      timeRange,
      () =>
        queryTeamAnalyticsBreakdown(
          env,
          sites.map((site) => site.id),
          toQueryWindow(timeRange),
          internalUrl,
          filters,
          request,
          dimension,
          metrics,
        ),
    );
    if (!result.ok) return apiV1QueryFailure(result.error, request);
    const rows = result.data;
    if (rows instanceof Response) return rows;
    return jsonList(rows, { request, meta: { timeRange, dimension, metrics } });
  }
  const internalUrl = buildInternalUrl(url, timeRange);
  const dashboard = await queryApiV1TeamDashboard(
    env,
    principal.teamId,
    hasFullSiteAccess(principal) ? undefined : principal.siteIds,
    timeRange,
    parseInterval(internalUrl),
  );
  if (!dashboard.ok) {
    return jsonError(
      "invalid_request",
      "Team analytics query failed",
      500,
      undefined,
      request,
    );
  }
  const data = dashboard.data;
  const sites = data.sites;
  if (resource === "overview") {
    const overview = sites.reduce<{
      views: number;
      sessions: number;
      visitors: number;
      bounces: number;
      totalDurationMs: number;
    }>(
      (acc, site) => {
        acc.views += site.overview.views;
        acc.sessions += site.overview.sessions;
        acc.visitors += site.overview.visitors;
        acc.bounces += site.overview.bounces;
        acc.totalDurationMs += site.overview.totalDurationMs;
        return acc;
      },
      {
        views: 0,
        sessions: 0,
        visitors: 0,
        bounces: 0,
        totalDurationMs: 0,
      },
    );
    return jsonSuccess(
      {
        views: overview.views,
        sessions: overview.sessions,
        visitors: overview.visitors,
        bounces: overview.bounces,
        bounceRate:
          overview.sessions > 0 ? overview.bounces / overview.sessions : 0,
        avgDurationMs:
          overview.sessions > 0
            ? Math.round(overview.totalDurationMs / overview.sessions)
            : 0,
        viewsPerSession:
          overview.sessions > 0 ? overview.views / overview.sessions : 0,
        approximateVisitors: false,
      },
      { request, meta: { timeRange } },
    );
  }
  if (resource === "timeseries") {
    const buckets = buildTimeBuckets(
      toQueryWindow(timeRange),
      parseInterval(internalUrl),
    );
    const rows = (data.trend ?? []).flatMap((row) => {
      const bucketIndex = Number(row.bucket);
      const bucket =
        Number.isInteger(bucketIndex) && bucketIndex >= 0
          ? buckets[bucketIndex]
          : undefined;
      if (!bucket) return [];
      const rowSites = Array.isArray(row.sites) ? row.sites : [];
      const totals = rowSites.reduce(
        (acc, site) => {
          const record =
            site && typeof site === "object"
              ? (site as Record<string, unknown>)
              : {};
          acc.views += Number(record.views ?? 0);
          acc.visitors += Number(record.visitors ?? 0);
          return acc;
        },
        { views: 0, visitors: 0 },
      );
      return [
        {
          start: new Date(bucket.startMs).toISOString(),
          end: new Date(bucket.endExclusiveMs).toISOString(),
          views: totals.views,
          visitors: totals.visitors,
        },
      ];
    });
    return jsonList(rows, {
      request,
      meta: {
        timeRange,
        interval: url.searchParams.get("interval") || "day",
      },
    });
  }
  if (resource === "sites") {
    return jsonList(
      sites.map((site) => ({
        key: String(site.id ?? ""),
        label: String(site.name ?? site.domain ?? site.id ?? ""),
        ...((site.overview && typeof site.overview === "object"
          ? site.overview
          : {}) as Record<string, unknown>),
      })),
      { request, meta: { timeRange } },
    );
  }
  return jsonError(
    "resource_not_found",
    "Resource not found",
    404,
    undefined,
    request,
  );
}

export async function handleSitesCollection(
  request: Request,
  env: Env,
  principal: ApiKeyPrincipal,
): Promise<Response> {
  if (request.method === "GET") {
    const denied = requireSiteScope(request, principal, "site:read");
    if (denied) return denied;
    const sites = await listSites(env, principal);
    return jsonList(sites.map(sitePayload), {
      request,
      links: { self: "/api/v1/sites", create: "/api/v1/sites" },
    });
  }

  if (request.method === "POST") {
    const denied = requireSiteScope(request, principal, "site:write");
    if (denied) return denied;
    if (!hasFullSiteAccess(principal)) {
      return jsonError(
        "insufficient_scope",
        "Restricted API keys cannot create sites",
        403,
        undefined,
        request,
      );
    }
    const parsed = await parseAndValidateApiV1Body(
      request,
      SiteCreateInputSchema,
    );
    if (!parsed.ok) return parsed.response;
    const { name, domain, publicEnabled, publicSlug } = parsed.data;
    const resolvedSlug = publicEnabled ? publicSlug || null : null;
    if (resolvedSlug) {
      const available = await ensurePublicSlugAvailable(env, resolvedSlug);
      if (!available) {
        return jsonError(
          "conflict",
          "Public slug already exists",
          409,
          undefined,
          request,
        );
      }
    }
    const siteId = await createSiteWithDefaultSettings(env, {
      teamId: principal.teamId,
      name,
      domain,
      publicEnabled,
      publicSlug: resolvedSlug,
    });
    const row = await siteById(env, principal, siteId, request);
    return row instanceof Response
      ? row
      : jsonSuccess(sitePayload(row), { request, status: 201 });
  }

  return methodNotAllowed(request);
}

export async function handleSiteResource(
  request: Request,
  env: Env,
  principal: ApiKeyPrincipal,
  siteId: string,
): Promise<Response> {
  if (request.method === "GET") {
    const denied = requireSiteScope(request, principal, "site:read");
    if (denied) return denied;
    const row = await siteById(env, principal, siteId, request);
    return row instanceof Response
      ? row
      : jsonSuccess(sitePayload(row), { request });
  }

  if (request.method === "PATCH") {
    const denied = requireSiteScope(request, principal, "site:write");
    if (denied) return denied;
    const existing = await siteById(env, principal, siteId, request);
    if (existing instanceof Response) return existing;
    const parsed = await parseAndValidateApiV1Body(
      request,
      SiteUpdateInputSchema,
    );
    if (!parsed.ok) return parsed.response;
    const name = parsed.data.name ?? existing.name;
    const domain = parsed.data.domain ?? existing.domain;
    const publicEnabled =
      parsed.data.publicEnabled ?? existing.publicEnabled === 1;
    const publicSlug = parsed.data.publicSlug ?? existing.publicSlug ?? "";
    if (publicEnabled && publicSlug) {
      const available = await ensurePublicSlugAvailable(
        env,
        publicSlug,
        siteId,
      );
      if (!available) {
        return jsonError(
          "conflict",
          "Public slug already exists",
          409,
          undefined,
          request,
        );
      }
    }
    await env.DB.prepare(
      "UPDATE sites SET name=?,domain=?,public_enabled=?,public_slug=?,updated_at=unixepoch() WHERE id=? AND team_id=?",
    )
      .bind(
        name,
        domain,
        publicEnabled ? 1 : 0,
        publicEnabled ? publicSlug || null : null,
        siteId,
        principal.teamId,
      )
      .run();
    await upsertSiteScriptSettings(env, siteId, { siteDomain: domain });
    const row = await siteById(env, principal, siteId, request);
    return row instanceof Response
      ? row
      : jsonSuccess(sitePayload(row), { request });
  }

  if (request.method === "DELETE") {
    const denied = requireSiteScope(request, principal, "site:write");
    if (denied) return denied;
    const existing = await siteById(env, principal, siteId, request);
    if (existing instanceof Response) return existing;
    await deleteSiteData(env, siteId);
    return new Response(null, { status: 204 });
  }

  return methodNotAllowed(request);
}

export async function handleTracking(
  request: Request,
  env: Env,
  principal: ApiKeyPrincipal,
  siteId: string,
): Promise<Response> {
  const site = await siteById(env, principal, siteId, request);
  if (site instanceof Response) return site;
  if (request.method === "GET") {
    const denied = requireSiteScope(request, principal, "site_config:read");
    if (denied) return denied;
    const config =
      (await readSiteScriptSettings(env, siteId)) ??
      DEFAULT_SITE_SCRIPT_SETTINGS;
    return jsonSuccess(trackingPayload(config, site.domain), { request });
  }
  if (request.method === "PATCH") {
    const denied = requireSiteScope(request, principal, "site_config:write");
    if (denied) return denied;
    const body = await parseJsonBody(request);
    if (body instanceof Response) return body;
    const parsed = validateApiV1Value(
      request,
      legacySettingsFromTracking(body),
      SiteConfigUpdateInputSchema,
    );
    if (!parsed.ok) return parsed.response;
    const config = await upsertSiteScriptSettings(env, siteId, {
      siteDomain: site.domain,
      settings: parsed.data,
    });
    return jsonSuccess(trackingPayload(config, site.domain), { request });
  }
  return methodNotAllowed(request);
}

export async function handlePrivacy(
  request: Request,
  env: Env,
  principal: ApiKeyPrincipal,
  siteId: string,
): Promise<Response> {
  const site = await siteById(env, principal, siteId, request);
  if (site instanceof Response) return site;
  if (request.method === "GET") {
    const denied = requireSiteScope(request, principal, "site_config:read");
    if (denied) return denied;
    const config =
      (await readSiteScriptSettings(env, siteId)) ??
      DEFAULT_SITE_SCRIPT_SETTINGS;
    return jsonSuccess(privacyPayload(config), { request });
  }
  if (request.method === "PATCH") {
    const denied = requireSiteScope(request, principal, "site_config:write");
    if (denied) return denied;
    const body = await parseJsonBody(request);
    if (body instanceof Response) return body;
    const record =
      body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const parsed = validateApiV1Value(
      request,
      {
        ...(typeof record.respectDoNotTrack === "boolean"
          ? { ignoreDoNotTrack: !record.respectDoNotTrack }
          : {}),
        ...(typeof record.euMode === "boolean"
          ? { trackingStrength: record.euMode ? "weak" : "strong" }
          : {}),
      },
      SiteConfigUpdateInputSchema,
    );
    if (!parsed.ok) return parsed.response;
    const config = await upsertSiteScriptSettings(env, siteId, {
      siteDomain: site.domain,
      settings: parsed.data,
    });
    return jsonSuccess(privacyPayload(config), { request });
  }
  return methodNotAllowed(request);
}

export async function handleSharing(
  request: Request,
  env: Env,
  principal: ApiKeyPrincipal,
  siteId: string,
): Promise<Response> {
  const site = await siteById(env, principal, siteId, request);
  if (site instanceof Response) return site;
  if (request.method === "GET") {
    const denied = requireSiteScope(request, principal, "site_config:read");
    if (denied) return denied;
    return jsonSuccess(sitePayload(site).sharing, { request });
  }
  if (request.method === "PATCH") {
    const denied = requireSiteScope(request, principal, "site_config:write");
    if (denied) return denied;
    const body = await parseJsonBody(request);
    if (body instanceof Response) return body;
    const record =
      body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const publicEnabled = Boolean(record.publicEnabled);
    const publicSlug =
      typeof record.publicSlug === "string" ? record.publicSlug : null;
    if (publicEnabled && publicSlug) {
      const available = await ensurePublicSlugAvailable(
        env,
        publicSlug,
        siteId,
      );
      if (!available) {
        return jsonError(
          "conflict",
          "Public slug already exists",
          409,
          undefined,
          request,
        );
      }
    }
    await env.DB.prepare(
      "UPDATE sites SET public_enabled=?,public_slug=?,updated_at=unixepoch() WHERE id=? AND team_id=?",
    )
      .bind(
        publicEnabled ? 1 : 0,
        publicEnabled ? publicSlug : null,
        siteId,
        principal.teamId,
      )
      .run();
    return jsonSuccess(
      { publicEnabled, publicSlug: publicEnabled ? publicSlug : null },
      { request },
    );
  }
  return methodNotAllowed(request);
}

export async function handleTrackingScript(
  request: Request,
  env: Env,
  url: URL,
  principal: ApiKeyPrincipal,
  siteId: string,
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(request);
  const denied = requireSiteScope(request, principal, "site_config:read");
  if (denied) return denied;
  const site = await siteById(env, principal, siteId, request);
  if (site instanceof Response) return site;
  const edgeBase = `${url.protocol}//${url.host}`;
  const src = `${edgeBase.replace(/\/$/, "")}/script.js?siteId=${encodeURIComponent(siteId)}`;
  return jsonSuccess(
    { siteId, src, snippet: `<script defer src="${src}"></script>` },
    { request },
  );
}

async function ensureAnalyticsAccess(
  request: Request,
  env: Env,
  principal: ApiKeyPrincipal,
  siteId: string,
): Promise<ApiV1SiteRow | Response> {
  const denied = requireSiteScope(request, principal, "analytics:read");
  if (denied) return denied;
  return siteById(env, principal, siteId, request);
}

function analyticsSchema(siteId: string) {
  const metricType = (key: string) => {
    if (key.endsWith("Rate")) return "rate";
    if (key.endsWith("Ms")) return "duration_ms";
    return "integer";
  };
  return {
    metrics: ANALYTICS_METRICS.map((key) => ({
      key,
      label: key,
      type: metricType(key),
      description: `Analytics metric: ${key}.`,
    })),
    dimensions: ANALYTICS_DIMENSIONS.map((key) => ({
      key,
      label: key,
      type: "string",
      description: `Analytics dimension: ${key}.`,
    })),
    filters: [...ANALYTICS_DIMENSIONS],
    operators: [...FILTER_OPERATOR_IDS],
    intervals: [...INTERVALS],
    presets: [...TIME_PRESETS],
    timeRange: {
      earliestAvailableAt: null,
      latestAvailableAt: new Date().toISOString(),
    },
    links: {
      overview: `/api/v1/sites/${siteId}/analytics/overview`,
      timeseries: `/api/v1/sites/${siteId}/analytics/timeseries`,
      explore: `/api/v1/sites/${siteId}/analytics/explore`,
    },
  };
}

export async function handleAnalytics(
  request: Request,
  env: Env,
  url: URL,
  principal: ApiKeyPrincipal,
  siteId: string,
  path: string[],
): Promise<Response> {
  const site = await ensureAnalyticsAccess(request, env, principal, siteId);
  if (site instanceof Response) return site;
  const resource = path[3];
  if (resource === "schema") {
    if (request.method !== "GET") return methodNotAllowed(request);
    return jsonSuccess(analyticsSchema(siteId), { request });
  }

  const timeRange = parseTimeRange(url);
  if (timeRange instanceof Response) return timeRange;
  const filters = parseApiV1Filters(url, request);
  if (filters instanceof Response) return filters;

  if (resource === "overview") {
    if (request.method !== "GET") return methodNotAllowed(request);
    const metrics = parseMetrics(
      url.searchParams.get("metrics"),
      ANALYTICS_METRICS,
    );
    if (metrics instanceof Response) return metrics;
    const result = await queryApiV1Overview(
      env,
      siteId,
      buildInternalUrl(url, timeRange),
      timeRange,
    );
    if (!result.ok) {
      return apiV1QueryFailure(result.error, request);
    }
    return jsonSuccess(
      filterMetrics(apiV1OverviewMetrics(result.data), metrics),
      {
        request,
        meta: { timeRange },
      },
    );
  }
  if (resource === "timeseries") {
    if (request.method !== "GET") return methodNotAllowed(request);
    const interval = url.searchParams.get("interval") || "day";
    if (!INTERVALS.includes(interval as never)) {
      return jsonError(
        "validation_failed",
        "Invalid interval",
        400,
        undefined,
        request,
      );
    }
    const result = await queryApiV1Trend(
      env,
      siteId,
      buildInternalUrl(url, timeRange),
      timeRange,
      interval as (typeof INTERVALS)[number],
    );
    if (!result.ok) {
      return apiV1QueryFailure(result.error, request);
    }
    return jsonList(
      normalizeTimeseriesRows(
        result.data.points,
        buildTimeBuckets(toQueryWindow(timeRange), parseInterval(url)),
      ),
      { request, meta: { timeRange, interval } },
    );
  }
  if (resource === "filter-values") {
    if (request.method !== "GET") return methodNotAllowed(request);
    const field = url.searchParams.get("field")?.trim();
    if (!field) {
      return jsonError(
        "validation_failed",
        "Missing filter field",
        400,
        undefined,
        request,
      );
    }
    const internalUrl = buildInternalUrl(url, timeRange);
    internalUrl.searchParams.set("filterKey", field);
    const result = await queryApiV1FilterValues(
      env,
      siteId,
      internalUrl,
      timeRange,
    );
    if (!result.ok) return apiV1QueryFailure(result.error, request);
    return jsonSuccess(result.data, { request, meta: { timeRange, field } });
  }
  if (resource === "breakdowns" && path[4]) {
    if (request.method !== "GET") return methodNotAllowed(request);
    const dimension = validateDimension(path[4]);
    if (dimension instanceof Response) return dimension;
    if (!DIMENSION_TO_QUERY_NAME[dimension]) {
      return jsonError(
        "validation_failed",
        "Unsupported dimension",
        400,
        { dimension },
        request,
      );
    }
    const metrics = parseMetrics(url.searchParams.get("metrics"));
    if (metrics instanceof Response) return metrics;
    const result = await queryApiV1Breakdown(
      env,
      siteId,
      buildInternalUrl(url, timeRange),
      timeRange,
      dimension,
    );
    if (!result.ok) return apiV1QueryFailure(result.error, request);
    return jsonList(normalizeBreakdownRows(result.data, metrics), {
      request,
      meta: { timeRange, dimension, metrics },
    });
  }
  if (resource === "cross-breakdowns") {
    if (request.method !== "GET") return methodNotAllowed(request);
    const primary = validateCrossBreakdownDimension(
      url.searchParams.get("primary") || "",
    );
    const secondary = validateCrossBreakdownDimension(
      url.searchParams.get("secondary") || "",
    );
    if (primary instanceof Response) return primary;
    if (secondary instanceof Response) return secondary;
    const internalUrl = buildInternalUrl(url, timeRange);
    internalUrl.searchParams.set("primaryDimension", primary);
    internalUrl.searchParams.set("secondaryDimension", secondary);
    const result = await queryApiV1CrossBreakdown(
      env,
      siteId,
      internalUrl,
      timeRange,
      primary,
      secondary,
    );
    if (!result.ok) return apiV1QueryFailure(result.error, request);
    return jsonSuccess(result.data, {
      request,
      meta: { timeRange, primary, secondary },
    });
  }
  if (resource === "compare") {
    if (request.method !== "GET") return methodNotAllowed(request);
    const result = await queryApiV1Overview(
      env,
      siteId,
      buildInternalUrl(url, timeRange),
      timeRange,
    );
    if (!result.ok) return apiV1QueryFailure(result.error, request);
    return jsonSuccess(apiV1OverviewMetrics(result.data), {
      request,
      meta: {
        timeRange,
        compare: url.searchParams.get("compare") || "previous_period",
      },
    });
  }
  if (resource === "explore") {
    if (request.method !== "POST") return methodNotAllowed(request);
    const body = await parseJsonBody(request);
    if (body instanceof Response) return body;
    const record =
      body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const bodyUrl = urlWithBodyTimeRange(url, record);
    const exploreTimeRange = parseTimeRange(bodyUrl);
    if (exploreTimeRange instanceof Response) return exploreTimeRange;
    const metrics = parseExploreMetrics(record.metrics);
    if (metrics instanceof Response) return metrics;
    const dimensions = parseExploreDimensions(record.dimensions);
    if (dimensions instanceof Response) return dimensions;
    const invalidDimension = validateAnalyticsDimensions(dimensions, request);
    if (invalidDimension) return invalidDimension;
    const filters = parseApiV1Filters(
      record.filters ?? { version: 1, root: null },
      request,
    );
    if (filters instanceof Response) return filters;
    const orderBy = parseExploreOrderBy(record.orderBy);
    if (orderBy instanceof Response) return orderBy;
    const limit = parseExploreLimit(record.limit);
    if (limit instanceof Response) return limit;
    const result = await queryApiV1Explore(
      siteId,
      buildInternalUrl(bodyUrl, exploreTimeRange),
      exploreTimeRange,
      () =>
        queryAnalyticsAggregateRows(
          env,
          [siteId],
          toQueryWindow(exploreTimeRange),
          filters,
          request,
          {
            dimensions,
            metrics,
            limit,
            orderBy,
          },
        ),
    );
    if (!result.ok) return apiV1QueryFailure(result.error, request);
    const rows = result.data;
    if (rows instanceof Response) return rows;
    return jsonSuccess(
      {
        rows,
        metrics,
        dimensions,
        filters,
      },
      { request, meta: { timeRange: exploreTimeRange } },
    );
  }
  if (resource === "retention" && path[4] === "cohorts") {
    if (request.method !== "GET") return methodNotAllowed(request);
    const result = await queryApiV1Retention(
      env,
      siteId,
      buildInternalUrl(url, timeRange),
      timeRange,
    );
    if (!result.ok) return apiV1QueryFailure(result.error, request);
    // Retention's legacy wire shape stored the typed payload in metadata.
    return jsonSuccess({}, { request, meta: { timeRange, ...result.data } });
  }

  return jsonError(
    "resource_not_found",
    "Resource not found",
    404,
    undefined,
    request,
  );
}

export async function handleEvents(
  request: Request,
  env: Env,
  url: URL,
  principal: ApiKeyPrincipal,
  siteId: string,
  path: string[],
): Promise<Response> {
  const site = await ensureAnalyticsAccess(request, env, principal, siteId);
  if (site instanceof Response) return site;
  const pagination = parseCursorPagination(url);
  if (pagination instanceof Response) return pagination;
  const timeRange = parseTimeRange(url);
  if (timeRange instanceof Response) return timeRange;
  if (path[2] === "event-types") {
    if (request.method !== "GET") return methodNotAllowed(request);
    if (!path[3]) {
      const result = await queryApiV1EventTypes(
        env,
        siteId,
        buildInternalUrl(url, timeRange),
        timeRange,
      );
      if (!result.ok) return apiV1QueryFailure(result.error, request);
      return jsonList([...result.data], { request, meta: { timeRange } });
    }
    const result = await queryApiV1EventTypeDetail(
      env,
      siteId,
      buildInternalUrl(url, timeRange),
      timeRange,
      path[3],
    );
    if (!result.ok) return apiV1QueryFailure(result.error, request);
    return jsonSuccess({}, { request, meta: { timeRange, ...result.data } });
  }
  if (path[2] === "event-fields" && !path[3]) {
    if (request.method !== "GET") return methodNotAllowed(request);
    const result = await queryApiV1EventFields(
      env,
      siteId,
      buildInternalUrl(url, timeRange),
      timeRange,
    );
    if (!result.ok) return apiV1QueryFailure(result.error, request);
    return jsonSuccess(result.data, { request, meta: { timeRange } });
  }
  if (path[2] === "event-fields" && path[3] === "values") {
    if (request.method !== "GET") return methodNotAllowed(request);
    const result = await queryApiV1EventFieldValues(
      env,
      siteId,
      buildInternalUrl(url, timeRange),
      timeRange,
    );
    if (!result.ok) return apiV1QueryFailure(result.error, request);
    return jsonList([...result.data], { request, meta: { timeRange } });
  }
  if (path[2] === "events" && path[3] === "summary") {
    if (request.method !== "GET") return methodNotAllowed(request);
    const result = await queryApiV1EventsSummary(
      env,
      siteId,
      buildInternalUrl(url, timeRange),
      timeRange,
    );
    if (!result.ok) return apiV1QueryFailure(result.error, request);
    // Legacy V1 exposed these as response metadata rather than `data`.
    return jsonSuccess({}, { request, meta: { timeRange, ...result.data } });
  }
  if (path[2] === "events" && path[3] === "timeseries") {
    if (request.method !== "GET") return methodNotAllowed(request);
    const result = await queryApiV1EventsTrend(
      env,
      siteId,
      buildInternalUrl(url, timeRange),
      timeRange,
    );
    if (!result.ok) return apiV1QueryFailure(result.error, request);
    const trendData = result.data.data;
    return jsonList(
      normalizeTimeseriesRows(
        trendData,
        buildTimeBuckets(toQueryWindow(timeRange), parseInterval(url)),
      ),
      {
        request,
        meta: {
          timeRange,
          interval: result.data.interval,
          series: result.data.series,
        },
      },
    );
  }
  if (path[2] === "events" && path[3] === "search") {
    if (request.method !== "POST") return methodNotAllowed(request);
    const result = await queryApiV1EventRecords(
      env,
      siteId,
      buildInternalUrl(url, timeRange),
      timeRange,
      pagination,
    );
    if (!result.ok) return apiV1QueryFailure(result.error, request);
    return jsonPaginated([...result.data.data], result.data.pagination, {
      request,
      meta: { timeRange },
    });
  }
  if (path[2] === "events" && path[3]) {
    if (request.method !== "GET") return methodNotAllowed(request);
    const result = await queryApiV1EventRecordDetail(
      env,
      siteId,
      path[3],
      timeRange,
    );
    if (!result.ok) return apiV1QueryFailure(result.error, request);
    return jsonSuccess(result.data ?? {}, { request, meta: { timeRange } });
  }
  if (path[2] === "events") {
    if (request.method !== "GET") return methodNotAllowed(request);
    const result = await queryApiV1EventRecords(
      env,
      siteId,
      buildInternalUrl(url, timeRange),
      timeRange,
      pagination,
    );
    if (!result.ok) return apiV1QueryFailure(result.error, request);
    return jsonPaginated([...result.data.data], result.data.pagination, {
      request,
      meta: { timeRange },
    });
  }
  return jsonError(
    "resource_not_found",
    "Resource not found",
    404,
    undefined,
    request,
  );
}

export async function handleJourneys(
  request: Request,
  env: Env,
  url: URL,
  principal: ApiKeyPrincipal,
  siteId: string,
  path: string[],
): Promise<Response> {
  const site = await ensureAnalyticsAccess(request, env, principal, siteId);
  if (site instanceof Response) return site;
  const timeRange = parseTimeRange(url);
  if (timeRange instanceof Response) return timeRange;
  const kind = path[2];
  const id = path[3];
  if (kind === "visitors" && !id) {
    if (request.method !== "GET") return methodNotAllowed(request);
    const pagination = parseCursorPagination(url);
    if (pagination instanceof Response) return pagination;
    const result = await queryApiV1Visitors(
      env,
      siteId,
      buildInternalUrl(url, timeRange),
      timeRange,
      pagination,
    );
    if (!result.ok) return apiV1QueryFailure(result.error, request);
    return jsonPaginated([...result.data.data], result.data.pagination, {
      request,
      meta: { timeRange },
    });
  }
  if (kind === "visitors" && id && !path[4]) {
    if (request.method !== "GET") return methodNotAllowed(request);
    const result = await queryApiV1VisitorDetail(env, siteId, id, timeRange);
    if (!result.ok) return apiV1QueryFailure(result.error, request);
    return jsonSuccess(result.data ?? {}, { request, meta: { timeRange } });
  }
  if (kind === "sessions" && !id) {
    if (request.method !== "GET") return methodNotAllowed(request);
    const pagination = parseCursorPagination(url);
    if (pagination instanceof Response) return pagination;
    const result = await queryApiV1Sessions(
      env,
      siteId,
      buildInternalUrl(url, timeRange),
      timeRange,
      pagination,
    );
    if (!result.ok) return apiV1QueryFailure(result.error, request);
    return jsonPaginated([...result.data.data], result.data.pagination, {
      request,
      meta: { timeRange },
    });
  }
  if (kind === "sessions" && id && !path[4]) {
    if (request.method !== "GET") return methodNotAllowed(request);
    const result = await queryApiV1SessionDetail(env, siteId, id, timeRange);
    if (!result.ok) return apiV1QueryFailure(result.error, request);
    return jsonSuccess(result.data ?? {}, { request, meta: { timeRange } });
  }
  if (path[4] === "events") {
    if (request.method !== "GET") return methodNotAllowed(request);
    const pagination = parseCursorPagination(url);
    if (pagination instanceof Response) return pagination;
    const result = await queryApiV1JourneyEvents(
      env,
      siteId,
      buildInternalUrl(url, timeRange),
      timeRange,
      pagination,
      { type: kind === "visitors" ? "visitor" : "session", value: id },
    );
    if (!result.ok) return apiV1QueryFailure(result.error, request);
    return jsonPaginated([...result.data.data], result.data.pagination, {
      request,
      meta: { timeRange },
    });
  }
  if (path[4] === "sessions") {
    if (request.method !== "GET") return methodNotAllowed(request);
    const pagination = parseCursorPagination(url);
    if (pagination instanceof Response) return pagination;
    const result = await queryApiV1JourneySessions(
      env,
      siteId,
      buildInternalUrl(url, timeRange),
      timeRange,
      pagination,
      { type: kind === "visitors" ? "visitor" : "session", value: id },
    );
    if (!result.ok) return apiV1QueryFailure(result.error, request);
    return jsonPaginated([...result.data.data], result.data.pagination, {
      request,
      meta: { timeRange },
    });
  }
  return jsonError(
    "resource_not_found",
    "Resource not found",
    404,
    undefined,
    request,
  );
}

async function listFunnels(env: Env, siteId: string): Promise<FunnelRow[]> {
  const rows = await env.DB.prepare(
    `
      SELECT id, site_id, name, config_json, created_at, updated_at
      FROM analysis_definitions
      WHERE site_id=? AND kind=? AND archived_at IS NULL
      ORDER BY created_at DESC
    `,
  )
    .bind(siteId, FUNNEL_KIND)
    .all<FunnelRow>();
  return rows.results;
}

async function getFunnel(
  env: Env,
  siteId: string,
  funnelId: string,
): Promise<FunnelRow | null> {
  return (
    (await env.DB.prepare(
      `
        SELECT id, site_id, name, config_json, created_at, updated_at
        FROM analysis_definitions
        WHERE id=? AND site_id=? AND kind=? AND archived_at IS NULL
        LIMIT 1
      `,
    )
      .bind(funnelId, siteId, FUNNEL_KIND)
      .first<FunnelRow>()) ?? null
  );
}

async function handleFunnelCollection(
  request: Request,
  env: Env,
  principal: ApiKeyPrincipal,
  siteId: string,
) {
  if (request.method === "GET") {
    const funnels = await listFunnels(env, siteId);
    return jsonList(funnels.map(funnelPayload), { request });
  }
  if (request.method === "POST") {
    const denied = requireSiteScope(request, principal, "site_config:write");
    if (denied) return denied;
    const parsed = await parseAndValidateApiV1Body(
      request,
      FunnelCreateInputSchema,
    );
    if (!parsed.ok) return parsed.response;
    const id = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `
        INSERT INTO analysis_definitions
          (id, site_id, kind, name, config_json, config_version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      `,
    )
      .bind(
        id,
        siteId,
        FUNNEL_KIND,
        parsed.data.name,
        serializeFunnelSteps(parsed.data.steps),
        now,
        now,
      )
      .run();
    return jsonSuccess(
      {
        id,
        siteId,
        name: parsed.data.name,
        steps: parsed.data.steps,
        createdAt: epochSecondsToIso(now),
        updatedAt: epochSecondsToIso(now),
        links: {
          self: `/api/v1/sites/${siteId}/funnels/${id}`,
          analysis: `/api/v1/sites/${siteId}/funnels/${id}/analysis`,
        },
      },
      { request, status: 201 },
    );
  }
  return methodNotAllowed(request);
}

async function handleFunnelResource(
  request: Request,
  env: Env,
  principal: ApiKeyPrincipal,
  siteId: string,
  funnelId: string,
) {
  const existing = await getFunnel(env, siteId, funnelId);
  if (!existing) {
    return jsonError(
      "resource_not_found",
      "Funnel not found",
      404,
      undefined,
      request,
    );
  }
  if (request.method === "GET") {
    return jsonSuccess(funnelPayload(existing), { request });
  }
  if (request.method === "PATCH") {
    const denied = requireSiteScope(request, principal, "site_config:write");
    if (denied) return denied;
    const body = await parseJsonBody(request);
    if (body instanceof Response) return body;
    const record =
      body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const name =
      typeof record.name === "string" && record.name.trim()
        ? record.name.trim().slice(0, 200)
        : existing.name;
    const steps =
      "steps" in record
        ? normalizeFunnelSteps(record.steps)
        : parseFunnelSteps(existing.config_json);
    if (steps.length < 2) {
      return jsonError(
        "validation_failed",
        "At least 2 funnel steps are required",
        400,
        { field: "steps" },
        request,
      );
    }
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `
        UPDATE analysis_definitions
        SET name=?, config_json=?, updated_at=?
        WHERE id=? AND site_id=? AND kind=? AND archived_at IS NULL
      `,
    )
      .bind(
        name,
        serializeFunnelSteps(steps),
        now,
        funnelId,
        siteId,
        FUNNEL_KIND,
      )
      .run();
    return jsonSuccess(
      {
        ...funnelPayload(existing),
        name,
        steps,
        updatedAt: epochSecondsToIso(now),
      },
      { request },
    );
  }
  if (request.method === "DELETE") {
    const denied = requireSiteScope(request, principal, "site_config:write");
    if (denied) return denied;
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `
        UPDATE analysis_definitions
        SET archived_at=?, updated_at=?
        WHERE id=? AND site_id=? AND kind=? AND archived_at IS NULL
      `,
    )
      .bind(now, now, funnelId, siteId, FUNNEL_KIND)
      .run();
    return new Response(null, { status: 204 });
  }
  return methodNotAllowed(request);
}

export async function handleFunnels(
  request: Request,
  env: Env,
  url: URL,
  principal: ApiKeyPrincipal,
  siteId: string,
  path: string[],
): Promise<Response> {
  const site = await ensureAnalyticsAccess(request, env, principal, siteId);
  if (site instanceof Response) return site;
  const timeRange = parseTimeRange(url);
  if (timeRange instanceof Response) return timeRange;
  if (path.length === 3) {
    return handleFunnelCollection(request, env, principal, siteId);
  }
  if (path[3] === "analysis") {
    if (request.method !== "POST") return methodNotAllowed(request);
    const parsed = await parseAndValidateApiV1Body(
      request,
      FunnelAnalyzeInputSchema,
    );
    if (!parsed.ok) return parsed.response;
    const result = await queryApiV1FunnelAnalysis(
      env,
      siteId,
      timeRange,
      parsed.data.steps,
    );
    if (!result.ok) return apiV1QueryFailure(result.error, request);
    return jsonSuccess(result.data, { request, meta: { timeRange } });
  }
  if (path[3] && path[4] === "analysis") {
    if (request.method !== "GET") return methodNotAllowed(request);
    const result = await queryApiV1SavedFunnelAnalysis(
      env,
      siteId,
      timeRange,
      async () => {
        const funnel = await getFunnel(env, siteId, path[3]);
        return {
          funnel,
          steps: funnel ? parseFunnelSteps(funnel.config_json) : [],
        };
      },
    );
    if (!result.ok) return apiV1QueryFailure(result.error, request);
    const funnel = result.data.funnel;
    if (!funnel) {
      return jsonError(
        "resource_not_found",
        "Funnel not found",
        404,
        undefined,
        request,
      );
    }
    if (!result.data.analysis) {
      return jsonError(
        "validation_failed",
        "Funnel has fewer than 2 steps",
        400,
        { field: "steps" },
        request,
      );
    }
    return jsonSuccess(
      { funnel: funnelPayload(funnel), analysis: result.data.analysis },
      { request, meta: { timeRange } },
    );
  }
  if (path[3]) {
    return handleFunnelResource(request, env, principal, siteId, path[3]);
  }
  return jsonError(
    "resource_not_found",
    "Resource not found",
    404,
    undefined,
    request,
  );
}

export async function handlePerformance(
  request: Request,
  env: Env,
  url: URL,
  principal: ApiKeyPrincipal,
  siteId: string,
  path: string[],
): Promise<Response> {
  const site = await ensureAnalyticsAccess(request, env, principal, siteId);
  if (site instanceof Response) return site;
  if (request.method !== "GET") return methodNotAllowed(request);
  const timeRange = parseTimeRange(url);
  if (timeRange instanceof Response) return timeRange;
  const filters = parseApiV1Filters(url, request);
  if (filters instanceof Response) return filters;
  const window = toQueryWindow(timeRange);
  const internalUrl = buildInternalUrl(url, timeRange);
  const resource = path[3] || "summary";
  if (resource === "summary") {
    const result = await queryApiV1Performance(
      siteId,
      internalUrl,
      timeRange,
      () => queryPerformanceSummaryData(env, siteId, window, filters),
    );
    if (!result.ok) return apiV1QueryFailure(result.error, request);
    const data = result.data;
    return jsonSuccess(data, { request, meta: { timeRange } });
  }
  if (resource === "timeseries") {
    const result = await queryApiV1Performance(
      siteId,
      internalUrl,
      timeRange,
      () =>
        queryPerformanceTimeseriesData(
          env,
          siteId,
          window,
          internalUrl,
          filters,
        ),
    );
    if (!result.ok) return apiV1QueryFailure(result.error, request);
    const data = result.data;
    return jsonList(data.rows, {
      request,
      meta: { timeRange, interval: data.interval },
    });
  }
  if (resource === "breakdowns" && path[4]) {
    const dimension = validateDimension(path[4]);
    if (dimension instanceof Response) return dimension;
    const metric = parsePerformanceMetric(url);
    if (metric instanceof Response) return metric;
    const result = await queryApiV1Performance(
      siteId,
      internalUrl,
      timeRange,
      () =>
        queryPerformanceBreakdownData(
          env,
          siteId,
          window,
          internalUrl,
          filters,
          request,
          dimension,
        ),
    );
    if (!result.ok) return apiV1QueryFailure(result.error, request);
    const rows = result.data;
    if (rows instanceof Response) return rows;
    return jsonList(rows, {
      request,
      meta: { timeRange, dimension, metric },
    });
  }
  return jsonError(
    "resource_not_found",
    "Resource not found",
    404,
    undefined,
    request,
  );
}

export async function handleRealtime(
  request: Request,
  env: Env,
  url: URL,
  principal: ApiKeyPrincipal,
  siteId: string,
  path: string[],
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(request);
  const site = await ensureAnalyticsAccess(request, env, principal, siteId);
  if (site instanceof Response) return site;
  const stubId = env.INGEST_DO.idFromName(siteId);
  const stub = env.INGEST_DO.get(stubId);
  if (path[3] === "active-visitors") {
    const doResp = await stub.fetch("https://ingest.internal/active", {
      method: "GET",
    });
    const doData = (await doResp.json()) as { activeNow?: number };
    return jsonSuccess({ activeVisitors: doData.activeNow ?? 0 }, { request });
  }
  const doUrl = `https://ingest.internal/snapshot?${url.searchParams.toString()}`;
  const doResp = await stub.fetch(doUrl, { method: "GET" });
  const doData = (await doResp.json()) as {
    activeNow?: number;
    data?: unknown[];
  };
  const snapshot = {
    activeVisitors: doData.activeNow ?? 0,
    events: doData.data ?? [],
    sessions: [],
  };
  if (path[3] === "events") return jsonList(snapshot.events, { request });
  if (path[3] === "sessions") return jsonList(snapshot.sessions, { request });
  if (path[3] === "snapshot") return jsonSuccess(snapshot, { request });
  return jsonError(
    "resource_not_found",
    "Resource not found",
    404,
    undefined,
    request,
  );
}

export type ApiV1BatchDispatcher = (
  request: Request,
  env: Env,
  url: URL,
) => Promise<Response>;

export async function handleBatch(
  request: Request,
  env: Env,
  url: URL,
  _principal: ApiKeyPrincipal,
  dispatch: ApiV1BatchDispatcher = handleApiV1,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(request);
  const body = await parseJsonBody(request);
  if (body instanceof Response) return body;
  const requests = Array.isArray((body as Record<string, unknown>).requests)
    ? ((body as Record<string, unknown>).requests as BatchRequestInput[])
    : [];
  if (requests.length < 1 || requests.length > BATCH_MAX_REQUESTS) {
    return jsonError(
      "validation_failed",
      "Invalid batch request count",
      400,
      {
        max: BATCH_MAX_REQUESTS,
      },
      request,
    );
  }
  const responses = await Promise.all(
    requests.map(async (item) => {
      if (item.method !== "GET") {
        return {
          id: item.id,
          status: 400,
          body: {
            error: { code: "invalid_request", message: "Only GET is allowed" },
          },
        };
      }
      if (
        !item.path.startsWith("/api/v1/") ||
        item.path.startsWith("/collect")
      ) {
        return {
          id: item.id,
          status: 400,
          body: {
            error: { code: "invalid_request", message: "Invalid batch path" },
          },
        };
      }
      const subUrl = new URL(item.path, `${url.protocol}//${url.host}`);
      for (const [key, value] of Object.entries(item.query ?? {})) {
        if (value !== null && value !== undefined) {
          subUrl.searchParams.set(key, String(value));
        }
      }
      const subRequest = new Request(subUrl, {
        method: "GET",
        headers: request.headers,
      });
      const response = await dispatch(subRequest, env, subUrl);
      return {
        id: item.id,
        status: response.status,
        body: response.status === 204 ? null : await readJsonResponse(response),
      };
    }),
  );
  return jsonSuccess(
    { responses },
    {
      request,
      meta: {
        partialFailure: responses.some((response) => response.status >= 400),
      },
    },
  );
}

/**
 * Compatibility wrapper. Production routing lives in src/lib/hono/routes.
 */
export async function handleApiV1(
  request: Request,
  env: Env,
  url: URL,
  ctx?: ExecutionContext,
): Promise<Response> {
  const path = apiV1Segments(url);
  if (path.length === 0) return handleRoot(request);

  const principal = await authenticateApiKey(request, env, ctx);
  if (principal instanceof Response) return principal;

  return dispatchApiV1ForPrincipal(request, env, url, path, principal, ctx);
}

export async function handleApiV1ForPrincipal(
  request: Request,
  env: Env,
  url: URL,
  principal: ApiKeyPrincipal,
  ctx?: ExecutionContext,
): Promise<Response> {
  return dispatchApiV1ForPrincipal(
    request,
    env,
    url,
    apiV1Segments(url),
    principal,
    ctx,
  );
}

async function dispatchApiV1ForPrincipal(
  request: Request,
  env: Env,
  url: URL,
  path: string[],
  principal: ApiKeyPrincipal,
  ctx?: ExecutionContext,
): Promise<Response> {
  if (path.length === 0) return handleRoot(request);

  if (path[0] === "token" && path.length === 1) {
    return handleToken(request, env, principal);
  }
  if (path[0] === "token" && path[1] === "check" && path.length === 2) {
    return handleTokenCheck(request, principal);
  }
  if (path[0] === "capabilities" && path.length === 1) {
    return handleCapabilities(request, principal);
  }
  if (path[0] === "team") {
    return handleTeam(request, env, url, principal, path);
  }
  if (path[0] === "batch" && path.length === 1) {
    return handleBatch(
      request,
      env,
      url,
      principal,
      (subrequest, subrequestEnv, subrequestUrl) =>
        handleApiV1ForPrincipal(
          subrequest,
          subrequestEnv,
          subrequestUrl,
          principal,
          ctx,
        ),
    );
  }
  if (path.length === 1 && path[0] === "sites") {
    return handleSitesCollection(request, env, principal);
  }
  if (path[0] !== "sites" || !path[1]) {
    return jsonError(
      "resource_not_found",
      "Resource not found",
      404,
      undefined,
      request,
    );
  }

  const siteId = path[1];
  if (path.length === 2) {
    return handleSiteResource(request, env, principal, siteId);
  }
  if (path.length === 3 && path[2] === "tracking") {
    return handleTracking(request, env, principal, siteId);
  }
  if (path.length === 4 && path[2] === "tracking" && path[3] === "script") {
    return handleTrackingScript(request, env, url, principal, siteId);
  }
  if (path.length === 3 && path[2] === "privacy") {
    return handlePrivacy(request, env, principal, siteId);
  }
  if (path.length === 3 && path[2] === "sharing") {
    return handleSharing(request, env, principal, siteId);
  }
  if (path[2] === "analytics") {
    return handleAnalytics(request, env, url, principal, siteId, path);
  }
  if (
    path[2] === "event-types" ||
    path[2] === "events" ||
    path[2] === "event-fields"
  ) {
    return handleEvents(request, env, url, principal, siteId, path);
  }
  if (path[2] === "visitors" || path[2] === "sessions") {
    return handleJourneys(request, env, url, principal, siteId, path);
  }
  if (path[2] === "funnels") {
    return handleFunnels(request, env, url, principal, siteId, path);
  }
  if (path[2] === "performance") {
    return handlePerformance(request, env, url, principal, siteId, path);
  }
  if (path[2] === "realtime") {
    return handleRealtime(request, env, url, principal, siteId, path);
  }

  return jsonError(
    "resource_not_found",
    "Resource not found",
    404,
    undefined,
    request,
  );
}
