import type { z } from "zod";

import { DEFAULT_SITE_SCRIPT_SETTINGS } from "@/lib/site-settings";
import {
  FunnelAnalyzeInputSchema,
  FunnelCreateInputSchema,
} from "@/schemas/funnel";
import { SiteCreateInputSchema, SiteUpdateInputSchema } from "@/schemas/site";
import { SiteConfigUpdateInputSchema } from "@/schemas/site-config";

import { normalizeFunnelSteps, queryFunnelAnalysis } from "./query/funnels";
import { routeQuery } from "./query/router";
import { handleTeamDashboardForTeam } from "./query/team";
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
  FILTER_OPERATORS,
  INTERVALS,
  jsonError,
  jsonList,
  jsonPaginated,
  jsonSuccess,
  methodNotAllowed,
  normalizeUnknownDirect,
  parseComplexFilters,
  parseCursorPagination,
  type ParsedTimeRange,
  parseFilter,
  parseMetrics,
  parseSort,
  parseTimeRange,
  requireScope,
  TIME_PRESETS,
  validateCrossBreakdownDimension,
  validateDimension,
} from "./api-v1-helpers";
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

interface LegacyPayload {
  ok?: boolean;
  data?: unknown;
  interval?: unknown;
  pagination?: unknown;
  error?: unknown;
  [key: string]: unknown;
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

const FILTER_TO_LEGACY_PARAM: Partial<Record<AnalyticsDimension, string>> = {
  "geo.country": "geoCountry",
  "geo.region": "geoRegion",
  "geo.city": "geoCity",
  "geo.continent": "geoContinent",
  "geo.timeZone": "geoTimezone",
  "geo.organization": "geoOrganization",
  "client.browser": "clientBrowser",
  "client.osVersion": "clientOsVersion",
  "client.deviceType": "clientDeviceType",
  "client.language": "clientLanguage",
  "client.screenSize": "clientScreenSize",
  "page.path": "path",
  "page.title": "title",
  "page.hostname": "hostname",
  "session.entryPath": "entry",
  "session.exitPath": "exit",
  "referrer.domain": "sourceDomain",
  "referrer.url": "sourceLink",
  "event.name": "eventName",
};

function apiBase(url: URL): string {
  return url.pathname.replace(/^\/api\/v1\/?/, "");
}

function segments(url: URL): string[] {
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
    fromMs: timeRange.fromMs,
    toMs: timeRange.toMs,
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
    next.searchParams.set("from", String(timeRange.fromMs));
    next.searchParams.set("to", String(timeRange.toMs));
    next.searchParams.set("timeZone", timeRange.timeZone);
    next.searchParams.delete("preset");
  }
  const filters = parseFilter(url);
  if (!(filters instanceof Response)) {
    for (const [field, value] of Object.entries(filters)) {
      const legacy = FILTER_TO_LEGACY_PARAM[field as AnalyticsDimension];
      if (legacy) next.searchParams.set(legacy, value);
    }
  }
  const sort = parseSort(url.searchParams.get("sort"));
  if (sort) {
    next.searchParams.set("sortBy", sort.field);
    next.searchParams.set("sortDir", sort.direction);
  }
  if (url.searchParams.has("cursor")) {
    next.searchParams.set("page", "1");
  }
  return next;
}

async function legacyJson(response: Response): Promise<LegacyPayload> {
  try {
    return (await response.json()) as LegacyPayload;
  } catch {
    return {};
  }
}

function stripLegacyPayload(payload: LegacyPayload): {
  data: unknown;
  meta: Record<string, unknown>;
  pagination?: {
    limit: number;
    nextCursor: string | null;
    hasMore: boolean;
  };
} {
  const {
    ok: _ok,
    requestId: _requestId,
    timestamp: _timestamp,
    siteId: _siteId,
    error: _error,
    data,
    interval,
    pagination,
    ...rest
  } = payload;
  const meta: Record<string, unknown> = {};
  if (interval) meta.interval = interval;
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined) meta[key] = value;
  }
  if (
    pagination &&
    typeof pagination === "object" &&
    "pageSize" in pagination
  ) {
    const page = Number((pagination as Record<string, unknown>).page ?? 1);
    const pageSize = Number(
      (pagination as Record<string, unknown>).pageSize ?? 100,
    );
    const total = Number((pagination as Record<string, unknown>).total ?? 0);
    return {
      data,
      meta,
      pagination: {
        limit: pageSize,
        nextCursor: page * pageSize < total ? `page:${page + 1}` : null,
        hasMore: page * pageSize < total,
      },
    };
  }
  return { data, meta };
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

function normalizeTimeseriesRows(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((row) => {
    const record = row && typeof row === "object" ? row : {};
    const source = record as Record<string, unknown>;
    const startMs = Number(source.timestampMs ?? source.bucket ?? 0);
    const endMs = Number.isFinite(startMs) ? startMs + 1 : 0;
    const {
      bucket: _bucket,
      timestampMs: _timestampMs,
      source: _source,
      ...metrics
    } = source;
    return {
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      ...metrics,
    };
  });
}

async function runLegacyQuery(
  request: Request,
  env: Env,
  siteId: string,
  url: URL,
  queryName: string,
  options: {
    timeRange?: ParsedTimeRange;
    transform?: (data: unknown, payload: LegacyPayload) => unknown;
    meta?: Record<string, unknown>;
    paginated?: boolean;
  } = {},
): Promise<Response> {
  const internalUrl = buildInternalUrl(url, options.timeRange);
  const response = await routeQuery(
    env,
    siteId,
    queryName,
    internalUrl,
    { publicMode: false },
    request,
  );
  const payload = await legacyJson(response);
  if (!response.ok) {
    return jsonError(
      "invalid_request",
      typeof payload.error === "string" ? payload.error : "Request failed",
      response.status,
      undefined,
      request,
    );
  }
  const stripped = stripLegacyPayload(payload);
  const data = options.transform
    ? options.transform(stripped.data, payload)
    : stripped.data;
  const meta = { ...stripped.meta, ...(options.meta ?? {}) };
  if (options.paginated || stripped.pagination) {
    const pagination = stripped.pagination ?? {
      limit: 100,
      nextCursor: null,
      hasMore: false,
    };
    return jsonPaginated(Array.isArray(data) ? data : [], pagination, {
      request,
      meta,
    });
  }
  return jsonSuccess(data ?? {}, { request, meta });
}

function requireSiteScope(
  request: Request,
  principal: ApiKeyPrincipal,
  scope: Parameters<typeof requireScope>[1],
): Response | null {
  return requireScope(principal.scopes, scope, request);
}

async function handleRoot(request: Request): Promise<Response> {
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

async function handleToken(
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

async function handleTokenCheck(
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

async function handleCapabilities(
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

async function handleTeam(
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
  const internalUrl = buildInternalUrl(url, timeRange);
  const dashboard = await handleTeamDashboardForTeam(
    env,
    internalUrl,
    principal.teamId,
    toQueryWindow(timeRange),
    hasFullSiteAccess(principal) ? undefined : principal.siteIds,
    { requestId: request.headers.get("cf-ray") || "team-analytics" },
  );
  const payload = await legacyJson(dashboard);
  if (!dashboard.ok) {
    return jsonError(
      "invalid_request",
      "Team analytics query failed",
      dashboard.status,
      undefined,
      request,
    );
  }
  const data =
    payload.data && typeof payload.data === "object"
      ? (payload.data as {
          sites?: Array<Record<string, unknown>>;
          trend?: Array<Record<string, unknown>>;
        })
      : {};
  const sites = data.sites ?? [];
  if (resource === "overview") {
    const overview = sites.reduce<{
      views: number;
      sessions: number;
      visitors: number;
      bounces: number;
      totalDurationMs: number;
    }>(
      (acc, site) => {
        const metrics =
          site.overview && typeof site.overview === "object"
            ? (site.overview as Record<string, unknown>)
            : {};
        acc.views += Number(metrics.views ?? 0);
        acc.sessions += Number(metrics.sessions ?? 0);
        acc.visitors += Number(metrics.visitors ?? 0);
        acc.bounces += Number(metrics.bounces ?? 0);
        acc.totalDurationMs += Number(metrics.totalDurationMs ?? 0);
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
    const rows = (data.trend ?? []).map((row) => {
      const timestampMs = Number(row.timestampMs ?? row.bucket ?? 0);
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
      return {
        start: new Date(timestampMs).toISOString(),
        end: new Date(timestampMs + 1).toISOString(),
        views: totals.views,
        visitors: totals.visitors,
      };
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
  if (resource === "breakdowns" && path[3]) {
    const dimension = validateDimension(path[3]);
    if (dimension instanceof Response) return dimension;
    return jsonList([], { request, meta: { timeRange, dimension } });
  }
  return jsonError(
    "resource_not_found",
    "Resource not found",
    404,
    undefined,
    request,
  );
}

async function handleSitesCollection(
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

async function handleSiteResource(
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

async function handleTracking(
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

async function handlePrivacy(
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

async function handleSharing(
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

async function handleTrackingScript(
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
  const edgeBase = env.EDGE_PUBLIC_BASE_URL || `${url.protocol}//${url.host}`;
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
    operators: [...FILTER_OPERATORS],
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

async function handleAnalytics(
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
  const filters = parseFilter(url);
  if (filters instanceof Response) return filters;

  if (resource === "overview") {
    if (request.method !== "GET") return methodNotAllowed(request);
    const metrics = parseMetrics(
      url.searchParams.get("metrics"),
      ANALYTICS_METRICS,
    );
    if (metrics instanceof Response) return metrics;
    return runLegacyQuery(request, env, siteId, url, "overview", {
      timeRange,
      transform: (data) => filterMetrics(data, metrics),
      meta: { timeRange },
    });
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
    return runLegacyQuery(request, env, siteId, url, "trend", {
      timeRange,
      transform: normalizeTimeseriesRows,
      meta: { timeRange, interval },
    });
  }
  if (resource === "breakdowns" && path[4]) {
    if (request.method !== "GET") return methodNotAllowed(request);
    const dimension = validateDimension(path[4]);
    if (dimension instanceof Response) return dimension;
    const queryName = DIMENSION_TO_QUERY_NAME[dimension];
    if (!queryName) {
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
    return runLegacyQuery(request, env, siteId, url, queryName, {
      timeRange,
      transform: (data) => normalizeBreakdownRows(data, metrics),
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
    const internalUrl = new URL(url.toString());
    internalUrl.searchParams.set("primaryDimension", primary);
    internalUrl.searchParams.set("secondaryDimension", secondary);
    return runLegacyQuery(
      request,
      env,
      siteId,
      internalUrl,
      "client-cross-breakdown",
      {
        timeRange,
        meta: { timeRange, primary, secondary },
      },
    );
  }
  if (resource === "compare") {
    if (request.method !== "GET") return methodNotAllowed(request);
    return runLegacyQuery(request, env, siteId, url, "overview", {
      timeRange,
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
    const complexFilters = parseComplexFilters(record.filters);
    if (complexFilters instanceof Response) return complexFilters;
    return jsonSuccess(
      {
        rows: [],
        metrics: Array.isArray(record.metrics) ? record.metrics : [],
        dimensions: Array.isArray(record.dimensions) ? record.dimensions : [],
        filters: complexFilters,
      },
      { request, meta: { timeRange } },
    );
  }
  if (resource === "retention" && path[4] === "cohorts") {
    if (request.method !== "GET") return methodNotAllowed(request);
    return runLegacyQuery(request, env, siteId, url, "retention", {
      timeRange,
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

async function handleEvents(
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
    return runLegacyQuery(
      request,
      env,
      siteId,
      url,
      path[3] ? "event-type-detail" : "event-types",
      {
        timeRange,
        ...(path[3] ? { meta: { eventName: path[3] } } : {}),
      },
    );
  }
  if (path[2] === "event-fields" && path[3] === "values") {
    if (request.method !== "GET") return methodNotAllowed(request);
    return runLegacyQuery(
      request,
      env,
      siteId,
      url,
      "event-type-field-values",
      { timeRange },
    );
  }
  if (path[2] === "events" && path[3] === "summary") {
    if (request.method !== "GET") return methodNotAllowed(request);
    return runLegacyQuery(request, env, siteId, url, "events-summary", {
      timeRange,
    });
  }
  if (path[2] === "events" && path[3] === "timeseries") {
    if (request.method !== "GET") return methodNotAllowed(request);
    return runLegacyQuery(request, env, siteId, url, "events-trend", {
      timeRange,
      transform: (data, payload) =>
        normalizeTimeseriesRows(
          (data as Record<string, unknown>)?.data ?? payload.data,
        ),
    });
  }
  if (path[2] === "events" && path[3] === "search") {
    if (request.method !== "POST") return methodNotAllowed(request);
    return runLegacyQuery(request, env, siteId, url, "events-records", {
      timeRange,
      paginated: true,
    });
  }
  if (path[2] === "events" && path[3]) {
    if (request.method !== "GET") return methodNotAllowed(request);
    const internalUrl = new URL(url.toString());
    internalUrl.searchParams.set("eventId", path[3]);
    return runLegacyQuery(
      request,
      env,
      siteId,
      internalUrl,
      "event-record-detail",
      { timeRange },
    );
  }
  if (path[2] === "events") {
    if (request.method !== "GET") return methodNotAllowed(request);
    return runLegacyQuery(request, env, siteId, url, "events-records", {
      timeRange,
      paginated: true,
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

async function handleJourneys(
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
    return runLegacyQuery(request, env, siteId, url, "visitors", {
      timeRange,
      paginated: true,
    });
  }
  if (kind === "visitors" && id && !path[4]) {
    if (request.method !== "GET") return methodNotAllowed(request);
    const internalUrl = new URL(url.toString());
    internalUrl.searchParams.set("visitorId", id);
    return runLegacyQuery(request, env, siteId, internalUrl, "visitor-detail", {
      timeRange,
    });
  }
  if (kind === "sessions" && !id) {
    if (request.method !== "GET") return methodNotAllowed(request);
    return runLegacyQuery(request, env, siteId, url, "sessions", {
      timeRange,
      paginated: true,
    });
  }
  if (kind === "sessions" && id && !path[4]) {
    if (request.method !== "GET") return methodNotAllowed(request);
    const internalUrl = new URL(url.toString());
    internalUrl.searchParams.set("sessionId", id);
    return runLegacyQuery(request, env, siteId, internalUrl, "session-detail", {
      timeRange,
    });
  }
  if (path[4] === "events") {
    if (request.method !== "GET") return methodNotAllowed(request);
    return runLegacyQuery(request, env, siteId, url, "events-records", {
      timeRange,
      paginated: true,
    });
  }
  if (path[4] === "sessions") {
    if (request.method !== "GET") return methodNotAllowed(request);
    return runLegacyQuery(request, env, siteId, url, "sessions", {
      timeRange,
      paginated: true,
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

async function handleFunnels(
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
    const analysis = await queryFunnelAnalysis(
      env,
      siteId,
      toQueryWindow(timeRange),
      {},
      parsed.data.steps,
    );
    return jsonSuccess(analysis, { request, meta: { timeRange } });
  }
  if (path[3] && path[4] === "analysis") {
    if (request.method !== "GET") return methodNotAllowed(request);
    const funnel = await getFunnel(env, siteId, path[3]);
    if (!funnel) {
      return jsonError(
        "resource_not_found",
        "Funnel not found",
        404,
        undefined,
        request,
      );
    }
    const steps = parseFunnelSteps(funnel.config_json);
    if (steps.length < 2) {
      return jsonError(
        "validation_failed",
        "Funnel has fewer than 2 steps",
        400,
        { field: "steps" },
        request,
      );
    }
    const analysis = await queryFunnelAnalysis(
      env,
      siteId,
      toQueryWindow(timeRange),
      {},
      steps,
    );
    return jsonSuccess(
      { funnel: funnelPayload(funnel), analysis },
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

async function handlePerformance(
  request: Request,
  env: Env,
  url: URL,
  principal: ApiKeyPrincipal,
  siteId: string,
): Promise<Response> {
  const site = await ensureAnalyticsAccess(request, env, principal, siteId);
  if (site instanceof Response) return site;
  if (request.method !== "GET") return methodNotAllowed(request);
  const timeRange = parseTimeRange(url);
  if (timeRange instanceof Response) return timeRange;
  return runLegacyQuery(request, env, siteId, url, "performance", {
    timeRange,
    meta: { timeRange },
  });
}

async function handleRealtime(
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

async function handleBatch(
  request: Request,
  env: Env,
  url: URL,
  _principal: ApiKeyPrincipal,
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
      const response = await handleApiV1(subRequest, env, subUrl);
      return {
        id: item.id,
        status: response.status,
        body: response.status === 204 ? null : await response.json(),
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

export async function handleApiV1(
  request: Request,
  env: Env,
  url: URL,
  ctx?: ExecutionContext,
): Promise<Response> {
  const path = segments(url);
  if (path.length === 0) return handleRoot(request);

  const principal = await authenticateApiKey(request, env, ctx);
  if (principal instanceof Response) return principal;

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
    return handleBatch(request, env, url, principal);
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
    return handlePerformance(request, env, url, principal, siteId);
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
