import { createEdgeSiteAnalyticsRuntime } from "@/lib/edge/analytics/composition";
import {
  isCrossBreakdownDimension,
  parseFilterUrlForAudience,
  type QueryContext,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { queryWindowToTime } from "@/lib/edge/analytics/contract";
import {
  parseInterval,
  parseLimit,
  parseQueryLimit,
  parseWindow,
} from "@/lib/edge/analytics/interfaces/dashboard/protocol/parsers";
import {
  parseClientDimensionKey,
  parseUtmDimensionKey,
} from "@/lib/edge/analytics/interfaces/dashboard/protocol/parsers";
import {
  badRequest,
  jsonResponseWith,
  queryErrorResponse,
  type ResponseContext,
} from "@/lib/edge/analytics/interfaces/dashboard/protocol/responses";
import type { Env } from "@/lib/edge/types";
import { coerceNumber } from "@/lib/edge/utils";
async function executeTechnology<T>(
  operation: "share-trend" | "radar" | "cross-dimension",
  env: Env,
  siteId: string,
  url: URL,
  ctx: ResponseContext | undefined,
  queryContext: QueryContext,
  parameters: Record<string, unknown>,
  shape: (value: T) => Record<string, unknown>,
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilterUrlForAudience(queryContext.policy.audience, url);
  const result = await createEdgeSiteAnalyticsRuntime({
    env,
    siteId,
  }).execute(operation, {
    context: queryContext,
    time: queryWindowToTime(window),
    filters,
    ...parameters,
  });
  if (!result.ok) return queryErrorResponse(result.error);
  return jsonResponseWith(ctx!, {
    ok: true,
    ...shape(result.data as T),
  });
}
export function handleBrowserTrendContract(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
  queryContext = siteQueryContext(siteId, "private-dashboard"),
) {
  const interval = parseInterval(url);
  return executeTechnology<TechnologyTrend>(
    "share-trend",
    env,
    siteId,
    url,
    ctx,
    queryContext,
    { variant: "browser", interval, limit: parseLimit(url, 5, 12) },
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
  return executeTechnology<TechnologyTrend>(
    "share-trend",
    env,
    siteId,
    url,
    ctx,
    queryContext,
    { variant: "browser-engine", interval, limit: parseLimit(url, 5, 8) },
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
  return executeTechnology<readonly unknown[]>(
    "radar",
    env,
    siteId,
    url,
    ctx,
    queryContext,
    { variant: "version", browserLimit, versionLimit },
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
  return executeTechnology<Record<string, unknown>>(
    "cross-dimension",
    env,
    siteId,
    url,
    ctx,
    queryContext,
    {
      variant: "browser",
      browserLimit: parseQueryLimit(url, "browserLimit", 8, 1, 12),
      osLimit: parseQueryLimit(url, "osLimit", 6, 1, 8),
      deviceTypeLimit: parseQueryLimit(url, "deviceTypeLimit", 5, 1, 8),
    },
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
type TechnologyTrend = {
  readonly series: readonly unknown[];
  readonly data: readonly unknown[];
};
type TechnologyReferrerChannelTrend = {
  readonly source: TechnologyTrend;
  readonly channel: TechnologyTrend;
};
type TechnologyRadarRow = Parameters<typeof radarData>[0][number];
type TechnologyRadarRows = readonly TechnologyRadarRow[];
export function handleBrowserRadarContract(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
  queryContext = siteQueryContext(siteId, "private-dashboard"),
) {
  return executeTechnology<TechnologyRadarRows>(
    "radar",
    env,
    siteId,
    url,
    ctx,
    queryContext,
    { variant: "browser" },
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
  return executeTechnology<TechnologyRadarRows>(
    "radar",
    env,
    siteId,
    url,
    ctx,
    queryContext,
    { variant: "referrer", limit: parseLimit(url, 24, 48) },
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
  return executeTechnology<TechnologyTrend>(
    "share-trend",
    env,
    siteId,
    url,
    ctx,
    queryContext,
    {
      variant: "client",
      interval,
      dimension,
      limit: parseLimit(url, 5, 8),
    },
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
  return executeTechnology<TechnologyTrend>(
    "share-trend",
    env,
    siteId,
    url,
    ctx,
    queryContext,
    {
      variant: "utm",
      interval,
      dimension,
      limit: parseLimit(url, 5, 8),
    },
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
  return executeTechnology<TechnologyTrend>(
    "share-trend",
    env,
    siteId,
    url,
    ctx,
    queryContext,
    { variant: "referrer", interval, limit: parseLimit(url, 5, 8) },
    (trend) => ({ interval, series: trend.series, data: trend.data }),
  );
}
export function handleReferrerChannelTrendContract(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
  queryContext = siteQueryContext(siteId, "private-dashboard"),
) {
  const interval = parseInterval(url);
  return executeTechnology<TechnologyReferrerChannelTrend>(
    "share-trend",
    env,
    siteId,
    url,
    ctx,
    queryContext,
    {
      variant: "referrer-channel",
      interval,
      limit: parseLimit(url, 5, 12),
    },
    (trend) => ({
      interval,
      source: trend.source,
      channel: trend.channel,
    }),
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
  if (!isCrossBreakdownDimension(primaryRaw))
    return Promise.resolve(badRequest("Unsupported primary dimension"));
  if (!isCrossBreakdownDimension(secondaryRaw))
    return Promise.resolve(badRequest("Unsupported secondary dimension"));
  if (primaryRaw === secondaryRaw)
    return Promise.resolve(
      badRequest("Primary and secondary dimensions must differ"),
    );
  return executeTechnology<Record<string, unknown>>(
    "cross-dimension",
    env,
    siteId,
    url,
    ctx,
    queryContext,
    {
      variant: "generic",
      primaryLimit: parseQueryLimit(url, "primaryLimit", 5, 1, 12),
      secondaryLimit: parseQueryLimit(url, "secondaryLimit", 6, 1, 8),
      primaryDimension: primaryRaw,
      secondaryDimension: secondaryRaw,
    },
    (data) => ({ data }),
  );
}
