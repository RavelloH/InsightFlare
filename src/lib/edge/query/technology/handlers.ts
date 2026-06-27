import {
  badRequest,
  jsonResponseWith,
  parseFilters,
  parseInterval,
  parseLimit,
  parseQueryLimit,
  parseWindow,
  resolveCrossBreakdownDimension,
  type ResponseContext,
} from "@/lib/edge/query/core";
import type { Env } from "@/lib/edge/types";
import { coerceNumber } from "@/lib/edge/utils";

import {
  queryBrowserCrossBreakdownFromD1,
  queryBrowserEngineTrendFromD1,
  queryBrowserTrendFromD1,
  queryBrowserVersionBreakdownFromD1,
} from "./browser";
import { queryCrossDimensionFromD1 } from "./client-cross";
import { parseClientDimensionKey, parseUtmDimensionKey } from "./parsers";
import { queryBrowserRadarFromD1, queryReferrerRadarFromD1 } from "./radar";
import {
  queryClientDimensionTrendFromD1,
  queryReferrerTrendFromD1,
  queryUtmDimensionTrendFromD1,
} from "./share-trend";

export async function handleBrowserTrend(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilters(url);
  const interval = parseInterval(url);
  const limit = parseLimit(url, 5, 12);
  const trend = await queryBrowserTrendFromD1(
    env,
    siteId,
    window,
    interval,
    filters,
    limit,
  );
  return jsonResponseWith(ctx!, {
    ok: true,
    interval,
    series: trend.series,
    data: trend.data,
  });
}

export async function handleBrowserEngineTrend(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilters(url);
  const interval = parseInterval(url);
  const limit = parseLimit(url, 5, 8);
  const trend = await queryBrowserEngineTrendFromD1(
    env,
    siteId,
    window,
    interval,
    filters,
    limit,
  );
  return jsonResponseWith(ctx!, {
    ok: true,
    interval,
    series: trend.series,
    data: trend.data,
  });
}

export async function handleBrowserVersionBreakdown(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilters(url);
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
  const data = await queryBrowserVersionBreakdownFromD1(
    env,
    siteId,
    window,
    filters,
    browserLimit,
    versionLimit,
  );
  return jsonResponseWith(ctx!, {
    ok: true,
    data,
  });
}

export async function handleBrowserCrossBreakdown(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilters(url);
  const browserLimit = parseQueryLimit(url, "browserLimit", 8, 1, 12);
  const osLimit = parseQueryLimit(url, "osLimit", 6, 1, 8);
  const deviceTypeLimit = parseQueryLimit(url, "deviceTypeLimit", 5, 1, 8);
  const data = await queryBrowserCrossBreakdownFromD1(
    env,
    siteId,
    window,
    filters,
    browserLimit,
    osLimit,
    deviceTypeLimit,
  );
  return jsonResponseWith(ctx!, {
    ok: true,
    operatingSystem: data.operatingSystem,
    deviceType: data.deviceType,
  });
}

export async function handleBrowserRadar(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilters(url);
  const rows = await queryBrowserRadarFromD1(env, siteId, window, filters);
  const data = rows.map((row) => ({
    browser: row.browser,
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
  return jsonResponseWith(ctx!, { ok: true, data });
}

export async function handleReferrerRadar(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilters(url);
  const limit = parseLimit(url, 24, 48);
  const rows = await queryReferrerRadarFromD1(
    env,
    siteId,
    window,
    filters,
    limit,
  );
  const data = rows.map((row) => ({
    referrer: row.referrer,
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
  return jsonResponseWith(ctx!, { ok: true, data });
}

export async function handleClientDimensionTrend(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
): Promise<Response> {
  const dimension = parseClientDimensionKey(url.searchParams.get("dimension"));
  if (!dimension) return badRequest("Invalid client dimension");
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilters(url);
  const interval = parseInterval(url);
  const limit = parseLimit(url, 5, 8);
  const trend = await queryClientDimensionTrendFromD1(
    env,
    siteId,
    window,
    interval,
    filters,
    dimension,
    limit,
  );
  return jsonResponseWith(ctx!, {
    ok: true,
    interval,
    series: trend.series,
    data: trend.data,
  });
}

export async function handleUtmDimensionTrend(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
): Promise<Response> {
  const dimension = parseUtmDimensionKey(url.searchParams.get("dimension"));
  if (!dimension) return badRequest("Invalid UTM dimension");
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilters(url);
  const interval = parseInterval(url);
  const limit = parseLimit(url, 5, 8);
  const trend = await queryUtmDimensionTrendFromD1(
    env,
    siteId,
    window,
    interval,
    filters,
    dimension,
    limit,
  );
  return jsonResponseWith(ctx!, {
    ok: true,
    interval,
    series: trend.series,
    data: trend.data,
  });
}

export async function handleReferrerDimensionTrend(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilters(url);
  const interval = parseInterval(url);
  const limit = parseLimit(url, 5, 8);
  const trend = await queryReferrerTrendFromD1(
    env,
    siteId,
    window,
    interval,
    filters,
    limit,
  );
  return jsonResponseWith(ctx!, {
    ok: true,
    interval,
    series: trend.series,
    data: trend.data,
  });
}

export async function handleCrossBreakdown(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
): Promise<Response> {
  const primaryRaw = url.searchParams.get("primaryDimension") || "";
  const secondaryRaw = url.searchParams.get("secondaryDimension") || "";
  const primaryDimension = resolveCrossBreakdownDimension(primaryRaw);
  if (!primaryDimension) return badRequest("Unsupported primary dimension");
  const secondaryDimension = resolveCrossBreakdownDimension(secondaryRaw);
  if (!secondaryDimension) return badRequest("Unsupported secondary dimension");
  if (primaryRaw === secondaryRaw) {
    return badRequest("Primary and secondary dimensions must differ");
  }
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilters(url);
  const primaryLimit = parseQueryLimit(url, "primaryLimit", 5, 1, 12);
  const secondaryLimit = parseQueryLimit(url, "secondaryLimit", 6, 1, 8);
  const data = await queryCrossDimensionFromD1(
    env,
    siteId,
    window,
    filters,
    primaryLimit,
    secondaryLimit,
    primaryDimension,
    secondaryDimension,
  );
  return jsonResponseWith(ctx!, { ok: true, data });
}
