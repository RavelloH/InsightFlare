import {
  type FilterDocument,
  parseFilterUrlForAudience,
} from "@/lib/edge/query-contract";
import {
  executeQueryOperation,
  type QueryContext,
  siteQueryContext,
} from "@/lib/edge/query-contract";
import type { Env } from "@/lib/edge/types";
import { coerceNumber } from "@/lib/edge/utils";

import {
  queryBrowserCrossBreakdownFromD1,
  queryBrowserEngineTrendFromD1,
  queryBrowserTrendFromD1,
  queryBrowserVersionBreakdownFromD1,
} from "./technology/browser";
import { queryCrossDimensionFromD1 } from "./technology/client-cross";
import {
  parseClientDimensionKey,
  parseUtmDimensionKey,
} from "./technology/parsers";
import {
  queryBrowserRadarFromD1,
  queryReferrerRadarFromD1,
} from "./technology/radar";
import {
  queryClientDimensionTrendFromD1,
  queryReferrerTrendFromD1,
  queryUtmDimensionTrendFromD1,
} from "./technology/share-trend";
import {
  badRequest,
  jsonResponseWith,
  parseInterval,
  parseLimit,
  parseQueryLimit,
  parseWindow,
  resolveCrossBreakdownDimension,
  type ResponseContext,
} from "./core";
import { toQueryTime } from "./overview-contract-adapter";

async function executeTechnology<T>(
  operation: "share-trend" | "radar" | "cross-dimension",
  env: Env,
  siteId: string,
  url: URL,
  ctx: ResponseContext | undefined,
  queryContext: QueryContext,
  reader: (
    window: ReturnType<typeof parseWindow> extends infer W
      ? Exclude<W, null>
      : never,
    filters: FilterDocument,
  ) => Promise<T>,
  shape: (value: T) => Record<string, unknown>,
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilterUrlForAudience(queryContext.policy.audience, url);
  const result = await executeQueryOperation(
    operation,
    {
      context: queryContext,
      time: toQueryTime(window),
      filters: filters,
    },
    async () => ({ value: shape(await reader(window, filters)) }),
  );
  if (!result.ok) return badRequest(result.error.kind);
  return jsonResponseWith(ctx!, { ok: true, ...result.data });
}

export function handleBrowserTrendContract(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
  queryContext = siteQueryContext(siteId, "private-dashboard"),
) {
  const interval = parseInterval(url);
  return executeTechnology(
    "share-trend",
    env,
    siteId,
    url,
    ctx,
    queryContext,
    (window, filters) =>
      queryBrowserTrendFromD1(
        env,
        siteId,
        window,
        interval,
        filters,
        parseLimit(url, 5, 12),
      ),
    (trend) => ({ interval, series: trend.series, data: trend.data }),
  );
}

export function handleBrowserEngineTrendContract(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
  queryContext = siteQueryContext(siteId, "private-dashboard"),
) {
  const interval = parseInterval(url);
  return executeTechnology(
    "share-trend",
    env,
    siteId,
    url,
    ctx,
    queryContext,
    (window, filters) =>
      queryBrowserEngineTrendFromD1(
        env,
        siteId,
        window,
        interval,
        filters,
        parseLimit(url, 5, 8),
      ),
    (trend) => ({ interval, series: trend.series, data: trend.data }),
  );
}

export function handleBrowserVersionBreakdownContract(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
  queryContext = siteQueryContext(siteId, "private-dashboard"),
) {
  const rawBrowserLimit = coerceNumber(url.searchParams.get("browserLimit"), 0);
  const browserLimit =
    Number.isFinite(rawBrowserLimit ?? NaN) && (rawBrowserLimit ?? 0) > 0
      ? Math.max(1, Math.floor(rawBrowserLimit ?? 0))
      : 0;
  const versionLimit = Math.min(
    8,
    Math.max(
      1,
      Math.floor(coerceNumber(url.searchParams.get("versionLimit"), 5) ?? 5),
    ),
  );
  return executeTechnology(
    "radar",
    env,
    siteId,
    url,
    ctx,
    queryContext,
    (window, filters) =>
      queryBrowserVersionBreakdownFromD1(
        env,
        siteId,
        window,
        filters,
        browserLimit,
        versionLimit,
      ),
    (data) => ({ data }),
  );
}

export function handleBrowserCrossBreakdownContract(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
  queryContext = siteQueryContext(siteId, "private-dashboard"),
) {
  return executeTechnology(
    "cross-dimension",
    env,
    siteId,
    url,
    ctx,
    queryContext,
    (window, filters) =>
      queryBrowserCrossBreakdownFromD1(
        env,
        siteId,
        window,
        filters,
        parseQueryLimit(url, "browserLimit", 8, 1, 12),
        parseQueryLimit(url, "osLimit", 6, 1, 8),
        parseQueryLimit(url, "deviceTypeLimit", 5, 1, 8),
      ),
    (data) => ({
      operatingSystem: data.operatingSystem,
      deviceType: data.deviceType,
    }),
  );
}

function radarData(
  rows: readonly {
    readonly browser?: string;
    readonly referrer?: string;
    readonly visitors: number;
    readonly sessions: number;
    readonly avgDurationMs: number;
    readonly bounces: number;
    readonly avgDepth: number;
    readonly returningVisitors: number;
    readonly avgFrequency: number;
    readonly trafficShare: number;
  }[],
  key: "browser" | "referrer",
) {
  return rows.map((row) => ({
    [key]: row[key],
    visitors: row.visitors,
    sessions: row.sessions,
    metrics: {
      duration: row.avgDurationMs,
      engagement:
        row.sessions > 0
          ? Number(((row.sessions - row.bounces) / row.sessions).toFixed(6))
          : 0,
      depth: row.avgDepth,
      loyalty:
        row.visitors > 0
          ? Number((row.returningVisitors / row.visitors).toFixed(6))
          : 0,
      frequency: row.avgFrequency,
      traffic: row.trafficShare,
    },
  }));
}

export function handleBrowserRadarContract(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
  queryContext = siteQueryContext(siteId, "private-dashboard"),
) {
  return executeTechnology(
    "radar",
    env,
    siteId,
    url,
    ctx,
    queryContext,
    (window, filters) => queryBrowserRadarFromD1(env, siteId, window, filters),
    (rows) => ({ data: radarData(rows, "browser") }),
  );
}

export function handleReferrerRadarContract(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
  queryContext = siteQueryContext(siteId, "private-dashboard"),
) {
  return executeTechnology(
    "radar",
    env,
    siteId,
    url,
    ctx,
    queryContext,
    (window, filters) =>
      queryReferrerRadarFromD1(
        env,
        siteId,
        window,
        filters,
        parseLimit(url, 24, 48),
      ),
    (rows) => ({ data: radarData(rows, "referrer") }),
  );
}

export function handleClientDimensionTrendContract(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
  queryContext = siteQueryContext(siteId, "private-dashboard"),
) {
  const dimension = parseClientDimensionKey(url.searchParams.get("dimension"));
  if (!dimension)
    return Promise.resolve(badRequest("Invalid client dimension"));
  const interval = parseInterval(url);
  return executeTechnology(
    "share-trend",
    env,
    siteId,
    url,
    ctx,
    queryContext,
    (window, filters) =>
      queryClientDimensionTrendFromD1(
        env,
        siteId,
        window,
        interval,
        filters,
        dimension,
        parseLimit(url, 5, 8),
      ),
    (trend) => ({ interval, series: trend.series, data: trend.data }),
  );
}

export function handleUtmDimensionTrendContract(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
  queryContext = siteQueryContext(siteId, "private-dashboard"),
) {
  const dimension = parseUtmDimensionKey(url.searchParams.get("dimension"));
  if (!dimension) return Promise.resolve(badRequest("Invalid UTM dimension"));
  const interval = parseInterval(url);
  return executeTechnology(
    "share-trend",
    env,
    siteId,
    url,
    ctx,
    queryContext,
    (window, filters) =>
      queryUtmDimensionTrendFromD1(
        env,
        siteId,
        window,
        interval,
        filters,
        dimension,
        parseLimit(url, 5, 8),
      ),
    (trend) => ({ interval, series: trend.series, data: trend.data }),
  );
}

export function handleReferrerDimensionTrendContract(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
  queryContext = siteQueryContext(siteId, "private-dashboard"),
) {
  const interval = parseInterval(url);
  return executeTechnology(
    "share-trend",
    env,
    siteId,
    url,
    ctx,
    queryContext,
    (window, filters) =>
      queryReferrerTrendFromD1(
        env,
        siteId,
        window,
        interval,
        filters,
        parseLimit(url, 5, 8),
      ),
    (trend) => ({ interval, series: trend.series, data: trend.data }),
  );
}

export function handleCrossBreakdownContract(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
  queryContext = siteQueryContext(siteId, "private-dashboard"),
) {
  const primaryRaw = url.searchParams.get("primaryDimension") || "";
  const secondaryRaw = url.searchParams.get("secondaryDimension") || "";
  const primary = resolveCrossBreakdownDimension(primaryRaw);
  const secondary = resolveCrossBreakdownDimension(secondaryRaw);
  if (!primary)
    return Promise.resolve(badRequest("Unsupported primary dimension"));
  if (!secondary)
    return Promise.resolve(badRequest("Unsupported secondary dimension"));
  if (primaryRaw === secondaryRaw)
    return Promise.resolve(
      badRequest("Primary and secondary dimensions must differ"),
    );
  return executeTechnology(
    "cross-dimension",
    env,
    siteId,
    url,
    ctx,
    queryContext,
    (window, filters) =>
      queryCrossDimensionFromD1(
        env,
        siteId,
        window,
        filters,
        parseQueryLimit(url, "primaryLimit", 5, 1, 12),
        parseQueryLimit(url, "secondaryLimit", 6, 1, 8),
        primary,
        secondary,
      ),
    (data) => ({ data }),
  );
}
