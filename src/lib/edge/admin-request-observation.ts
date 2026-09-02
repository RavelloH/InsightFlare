import {
  type AnalyticsEngineConfig,
  defaultAnalyticsEngineConfig,
  normalizeAnalyticsEngineConfig,
  redactAnalyticsEngineConfig,
  REQUEST_ANALYTICS_DATASET,
  SYSTEM_ANALYTICS_ENGINE_CONFIG_KEY,
  validateAnalyticsEngineConfig,
} from "@/lib/analytics-engine-config";
import {
  addZonedInterval,
  resolveReportingTimeZone,
  startOfZonedDay,
  startOfZonedInterval,
  timeZoneOffsetMinutes,
} from "@/lib/dashboard/time-zone";

import {
  hasRequestFlag,
  REQUEST_ANALYTICS_FLAGS,
  REQUEST_ANALYTICS_SCHEMA_VERSION,
} from "./analytics-engine/request-schema";
import { requireActor } from "./admin-auth";
import { bad, forb, jsonResponseFor, na } from "./admin-response";
import { analyticsEngineAvailability } from "./analytics-engine";
import { decryptAnalyticsEngineSecret } from "./secret-encryption";
import { readConfig } from "./system-config";
import type { Env } from "./types";
import { clampString, ONE_HOUR_MS } from "./utils";

const DETAIL_PAGE_SIZE = 100;
const MAX_DETAIL_PAGE_SIZE = DETAIL_PAGE_SIZE;
const MAX_SITE_IDS_PER_D1_QUERY = 100;
const NETWORK_DIMENSION_LIMIT = 30;
const WINDOW_OPTIONS_MINUTES = new Set([60, 1440, 10080, 43200]);
const MAX_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const CF_ANALYTICS_ENGINE_SQL_ENDPOINT =
  "https://api.cloudflare.com/client/v4/accounts";
const NORMAL_CATEGORY_SQL_FILTER = "blob2 = 'normal'";
const ABNORMAL_CATEGORY_SQL_FILTER =
  "blob2 IN ('medium_threat', 'high_threat', 'custom_block')";
const MAX_WORKER_LATENCY_MS = 60_000;
const NORMAL_LATENCY_SQL_FILTER = `double20 = ${REQUEST_ANALYTICS_SCHEMA_VERSION} AND intDiv(double19, ${REQUEST_ANALYTICS_FLAGS.edgeLatencyPresent}) % 2 != 0 AND double3 BETWEEN 0 AND ${MAX_WORKER_LATENCY_MS}`;

function analyticsEngineSqlEndpoint(env: Env): string | null {
  if (env.INSIGHTFLARE_E2E === "1") {
    const mockUrl = env.INSIGHTFLARE_E2E_CLOUDFLARE_API_URL?.trim();
    return mockUrl ? mockUrl.replace(/\/+$/, "") : null;
  }
  return CF_ANALYTICS_ENGINE_SQL_ENDPOINT;
}

type AdminActor = Awaited<ReturnType<typeof requireActor>>;
type RequestObservationCategory =
  | "normal"
  | "medium_threat"
  | "high_threat"
  | "custom_block";
type RequestObservationInterval = "minute" | "hour" | "day" | "week";
type NetworkDimension =
  | "asOrganization"
  | "asn"
  | "country"
  | "region"
  | "city"
  | "colo";
type DetailSource = "abnormal" | "normal";
type DimensionGroup = "detection" | "target" | "network" | "client";

interface DetailCursor {
  timestamp: string;
  receivedAt: number;
}

const DIMENSION_TABS: Record<DimensionGroup, readonly string[]> = {
  detection: [
    "reason",
    "category",
    "kind",
    "botScoreBucket",
    "verifiedBotCategory",
  ],
  target: ["site", "hostname", "pathname", "origin"],
  network: ["asOrganization", "asn", "country", "region", "city", "colo"],
  client: ["ip", "userAgent", "userAgentLengthBucket", "ipPrefix"],
};

interface RequestObservationEvent {
  timestamp: string;
  receivedAt: number;
  siteId: string;
  siteName: string;
  siteDomain: string;
  kind: string;
  category: RequestObservationCategory;
  reasons: string[];
  ip: string;
  userAgent: string;
  origin: string;
  hostname: string;
  pathname: string;
  country: string;
  region: string;
  city: string;
  continent: string;
  colo: string;
  asn: number;
  asOrganization: string;
  verifiedBotCategory: string;
  rayId: string;
  traceId: string;
  requestMethod: string;
  httpProtocol: string;
  metadataJson: string;
  latitude: number | null;
  longitude: number | null;
  botScore: number | null;
  userAgentLength: number;
  flags: number;
}

interface RequestObservationNormalEvent {
  timestamp: string;
  receivedAt: number;
  eventAt: number;
  edgeLatencyMs: number | null;
  schemaVersion: number;
  siteId: string;
  siteName: string;
  siteDomain: string;
  kind: string;
  origin: string;
  hostname: string;
  pathname: string;
  country: string;
  region: string;
  city: string;
  continent: string;
  colo: string;
  asn: number;
  asOrganization: string;
  rayId: string;
  traceId: string;
  requestMethod: string;
  metadataJson: string;
  latitude: number | null;
  longitude: number | null;
  userAgentLength: number;
  flags: number;
}

interface AnalyticsEngineSamplingMeta {
  provider: "cloudflare_analytics_engine";
  mode: "automatic";
  observedSampled: boolean;
  aggregatesWeighted: boolean;
  detailsAreSampled: boolean;
  distinctAreApproximate: boolean;
}

function analyticsEngineSamplingMeta(input: {
  observedSampled: boolean;
  aggregatesWeighted: boolean;
  detailsAreSampled: boolean;
  distinctAreApproximate: boolean;
}): AnalyticsEngineSamplingMeta {
  return {
    provider: "cloudflare_analytics_engine",
    mode: "automatic",
    observedSampled: input.observedSampled,
    aggregatesWeighted: input.aggregatesWeighted,
    detailsAreSampled: input.detailsAreSampled,
    distinctAreApproximate: input.distinctAreApproximate,
  };
}

function rowsContainObservedSampling(rows: Record<string, unknown>[]): boolean {
  return rows.some((row) => {
    const value = Number(row.maxSampleInterval ?? row.sampleWeight);
    return Number.isFinite(value) && value > 1;
  });
}

function toFiniteNumber(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toNullableCoordinate(value: unknown): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return numeric;
}

function parseWindowMinutes(url: URL): number {
  const value = Number(url.searchParams.get("minutes") || "43200");
  return WINDOW_OPTIONS_MINUTES.has(value) ? value : 43200;
}

function parseTimeWindow(url: URL, now = Date.now()) {
  const rawFrom = Number(url.searchParams.get("from"));
  const rawTo = Number(url.searchParams.get("to"));
  const hasExplicitWindow = Number.isFinite(rawFrom) && Number.isFinite(rawTo);
  const timeZone = resolveReportingTimeZone(url.searchParams.get("timeZone"));
  const fallbackMinutes = parseWindowMinutes(url);
  const fallbackFrom = now - fallbackMinutes * 60 * 1000;
  const requestedTo = hasExplicitWindow ? rawTo : now;
  const requestedFrom = hasExplicitWindow ? rawFrom : fallbackFrom;
  const to = Math.min(now, Math.max(1, Math.floor(requestedTo)));
  const from = Math.max(0, Math.floor(requestedFrom));
  const boundedFrom = Math.max(0, Math.min(from, to - 1));
  const cappedFrom = Math.max(boundedFrom, to - MAX_WINDOW_MS);
  const interval = parseInterval(url, to - cappedFrom);
  const safeFrom =
    interval === "day" || interval === "week"
      ? Math.max(0, startOfZonedDay(cappedFrom, timeZone))
      : cappedFrom;
  return {
    from: safeFrom,
    to,
    minutes: Math.max(1, Math.ceil((to - safeFrom) / 60000)),
    interval,
    bucketMs: intervalToBucketMs(interval),
    timeZone,
  };
}

function parseInterval(url: URL, spanMs: number): RequestObservationInterval {
  const raw = url.searchParams.get("interval");
  if (raw === "minute" && spanMs <= 24 * 60 * 60 * 1000) return "minute";
  if (raw === "hour") return "hour";
  if (raw === "day") return "day";
  if (raw === "week") return "week";
  if (spanMs <= 6 * 60 * 60 * 1000) return "minute";
  if (spanMs <= 14 * 24 * 60 * 60 * 1000) return "hour";
  return "day";
}

function intervalToBucketMs(interval: RequestObservationInterval) {
  if (interval === "minute") return 60 * 1000;
  if (interval === "hour") return ONE_HOUR_MS;
  if (interval === "week") return 7 * 24 * ONE_HOUR_MS;
  return 24 * ONE_HOUR_MS;
}

function parseLimit(url: URL): number {
  const value = Number(url.searchParams.get("limit") || DETAIL_PAGE_SIZE);
  if (!Number.isFinite(value)) return DETAIL_PAGE_SIZE;
  return Math.max(1, Math.min(MAX_DETAIL_PAGE_SIZE, Math.trunc(value)));
}

function parseDetailCursor(url: URL): DetailCursor | null {
  const raw = url.searchParams.get("cursor");
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<DetailCursor>;
    const timestamp = clampString(String(value.timestamp || ""), 64);
    if (!timestamp) return null;
    return {
      timestamp,
      receivedAt: Math.max(0, toFiniteNumber(value.receivedAt)),
    };
  } catch {
    return null;
  }
}

function analyticsSqlString(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

function normalizeObservationCategory(
  value: unknown,
): RequestObservationCategory | null {
  const category = String(value || "");
  if (category === "high_threat") {
    return "high_threat";
  }
  if (category === "medium_threat") {
    return "medium_threat";
  }
  if (category === "custom_block") {
    return category;
  }
  return null;
}

function requestTimeFilter(input: { from: number; to: number }): string {
  return `timestamp >= toDateTime(${Math.floor(input.from / 1000)}) AND timestamp <= toDateTime(${Math.ceil(input.to / 1000)}) AND double20 = ${REQUEST_ANALYTICS_SCHEMA_VERSION}`;
}

function requestCategoryFilter(source: DetailSource): string {
  return source === "normal"
    ? NORMAL_CATEGORY_SQL_FILTER
    : ABNORMAL_CATEGORY_SQL_FILTER;
}

function requestCursorFilter(cursor?: DetailCursor | null): string {
  if (!cursor) return "";
  return `AND (timestamp < toDateTime(${analyticsSqlString(cursor.timestamp)}) OR (timestamp = toDateTime(${analyticsSqlString(cursor.timestamp)}) AND double1 < ${cursor.receivedAt}))`;
}

function requestRowSelect(): string {
  return `
      timestamp,
      _sample_interval AS sampleWeight,
      index1 AS siteId,
      blob1 AS kind,
      blob2 AS category,
      blob3 AS reasons,
      blob4 AS ip,
      blob5 AS userAgent,
      blob6 AS origin,
      blob7 AS hostname,
      blob8 AS pathname,
      blob9 AS country,
      blob10 AS region,
      blob11 AS city,
      blob12 AS continent,
      blob13 AS colo,
      blob14 AS asOrganization,
      blob15 AS verifiedBotCategory,
      blob16 AS rayId,
      blob17 AS traceId,
      blob18 AS requestMethod,
      blob19 AS httpProtocol,
      blob20 AS metadataJson,
      double1 AS receivedAt,
      double2 AS eventAt,
      double3 AS edgeLatencyMs,
      double4 AS asn,
      double5 AS latitude,
      double6 AS longitude,
      double7 AS botScore,
      double8 AS userAgentLength,
      double9 AS clientTcpRtt,
      double10 AS clientQuicRtt,
      double11 AS tlsClientHelloLength,
      double19 AS flags,
      double20 AS schemaVersion`;
}

function buildRequestAnalyticsSql(input: {
  from: number;
  to: number;
  limit: number;
  source: DetailSource;
  cursor?: DetailCursor | null;
}) {
  return `
    SELECT ${requestRowSelect()}
    FROM ${REQUEST_ANALYTICS_DATASET}
    WHERE ${requestTimeFilter(input)}
      AND ${requestCategoryFilter(input.source)}
      ${requestCursorFilter(input.cursor)}
    ORDER BY timestamp DESC, receivedAt DESC
    LIMIT ${input.limit}
    FORMAT JSONEachRow
  `;
}

function buildCountByBucketSql(input: {
  from: number;
  to: number;
  bucketMs: number;
  interval: RequestObservationInterval;
  timeZone: string;
  source: "normal" | "abnormal";
  includeLatency?: boolean;
}) {
  const fromSeconds = Math.floor(input.from / 1000);
  const toSeconds = Math.ceil(input.to / 1000);
  const bucketSeconds = Math.max(60, Math.floor(input.bucketMs / 1000));
  const bucketOffsetSeconds =
    timeZoneOffsetMinutes(input.timeZone, input.from) * 60 +
    (input.interval === "week" ? 3 * 24 * 60 * 60 : 0);
  const bucketExpression = `(intDiv(toUnixTimestamp(timestamp) + ${bucketOffsetSeconds}, ${bucketSeconds}) * ${bucketSeconds} - ${bucketOffsetSeconds}) * 1000`;
  const latencySelect =
    input.includeLatency && input.source === "normal"
      ? `,
      sumIf(_sample_interval * double3, ${NORMAL_LATENCY_SQL_FILTER}) AS latencyWeightedSumMs,
      sumIf(_sample_interval, ${NORMAL_LATENCY_SQL_FILTER}) AS latencySampleWeight,
      quantileExactWeighted(0.5)(double3, if(${NORMAL_LATENCY_SQL_FILTER}, _sample_interval, 0)) AS p50LatencyMs,
      quantileExactWeighted(0.75)(double3, if(${NORMAL_LATENCY_SQL_FILTER}, _sample_interval, 0)) AS p75LatencyMs,
      quantileExactWeighted(0.95)(double3, if(${NORMAL_LATENCY_SQL_FILTER}, _sample_interval, 0)) AS p95LatencyMs,
      quantileExactWeighted(0.99)(double3, if(${NORMAL_LATENCY_SQL_FILTER}, _sample_interval, 0)) AS p99LatencyMs`
      : "";
  const categorySelect =
    input.source === "abnormal"
      ? `,
      sumIf(_sample_interval, blob2 = 'medium_threat') AS mediumThreatCount,
      sumIf(_sample_interval, blob2 = 'high_threat') AS highThreatCount,
      sumIf(_sample_interval, blob2 = 'custom_block') AS customBlockedCount`
      : `,
      0 AS mediumThreatCount,
      0 AS highThreatCount,
      0 AS customBlockedCount`;
  const businessEventSelect =
    input.source === "normal"
      ? `,
      sumIf(_sample_interval, blob1 = 'pageview') AS pageviewCount,
      0 AS leaveCount,
      0 AS visibilityCount,
      sumIf(_sample_interval, blob1 = 'custom_event') AS customEventCount,
      0 AS identifyCount`
      : `,
      0 AS pageviewCount,
      0 AS leaveCount,
      0 AS visibilityCount,
      0 AS customEventCount,
      0 AS identifyCount`;
  const normalEventTotals =
    input.source === "normal"
      ? `sumIf(_sample_interval, blob1 = 'pageview') AS pageviews,
      sumIf(_sample_interval, blob1 = 'custom_event') AS customEvents`
      : `0 AS pageviews,
      0 AS customEvents`;
  return `
    SELECT
      ${bucketExpression} AS timestampMs,
      max(_sample_interval) AS maxSampleInterval,
      sum(_sample_interval) AS weightedRequestCount,
      sum(_sample_interval) AS count,
      ${normalEventTotals}${businessEventSelect}${categorySelect}${latencySelect}
    FROM ${REQUEST_ANALYTICS_DATASET}
    WHERE timestamp >= toDateTime(${fromSeconds})
      AND timestamp <= toDateTime(${toSeconds})
      AND double20 = ${REQUEST_ANALYTICS_SCHEMA_VERSION}
      AND ${requestCategoryFilter(input.source)}
    GROUP BY timestampMs
    ORDER BY timestampMs ASC
    FORMAT JSONEachRow
  `;
}

function buildMapPointsSql(input: {
  from: number;
  to: number;
  source: "normal" | "abnormal";
  limit: number;
}) {
  const fromSeconds = Math.floor(input.from / 1000);
  const toSeconds = Math.ceil(input.to / 1000);
  const latColumn = "double5";
  const lonColumn = "double6";
  return `
    SELECT
      round(${latColumn}, 3) AS latitude,
      round(${lonColumn}, 3) AS longitude,
      blob9 AS country,
      max(_sample_interval) AS maxSampleInterval,
      sum(_sample_interval) AS pointCount
    FROM ${REQUEST_ANALYTICS_DATASET}
    WHERE timestamp >= toDateTime(${fromSeconds})
      AND timestamp <= toDateTime(${toSeconds})
      AND intDiv(double19, ${REQUEST_ANALYTICS_FLAGS.coordinatePresent}) % 2 != 0
      AND double20 = ${REQUEST_ANALYTICS_SCHEMA_VERSION}
      AND ${requestCategoryFilter(input.source)}
    GROUP BY double5, double6, blob9
    ORDER BY pointCount DESC
    LIMIT ${input.limit}
    FORMAT JSONEachRow
  `;
}

function buildNetworkDimensionSql(input: {
  from: number;
  to: number;
  source: "normal" | "abnormal";
  dimension: NetworkDimension;
}) {
  const fromSeconds = Math.floor(input.from / 1000);
  const toSeconds = Math.ceil(input.to / 1000);
  const columns = {
    asOrganization: ["blob14 AS label"],
    asn: ["double4 AS label"],
    country: ["blob9 AS label"],
    region: ["blob10 AS label", "blob9 AS country"],
    city: ["blob11 AS label", "blob9 AS country", "blob10 AS region"],
    colo: ["blob13 AS label"],
  };
  const groupColumns = columns[input.dimension];
  const threatSelect =
    input.source === "abnormal"
      ? ",\n      sumIf(_sample_interval, blob2 = 'high_threat') AS highThreat"
      : ",\n      0 AS highThreat";
  return `
    SELECT
      ${groupColumns.join(",\n      ")},
      max(_sample_interval) AS maxSampleInterval,
      sum(_sample_interval) AS count${threatSelect}
    FROM ${REQUEST_ANALYTICS_DATASET}
    WHERE timestamp >= toDateTime(${fromSeconds})
      AND timestamp <= toDateTime(${toSeconds})
      AND double20 = ${REQUEST_ANALYTICS_SCHEMA_VERSION}
      AND ${requestCategoryFilter(input.source)}
    GROUP BY ${groupColumns.map((column) => column.split(" AS ")[1]).join(", ")}
    ORDER BY count DESC
    LIMIT ${NETWORK_DIMENSION_LIMIT}
    FORMAT JSONEachRow
  `;
}

function buildSourceSummarySql(input: {
  from: number;
  to: number;
  source: DetailSource;
  includeLatency?: boolean;
}) {
  const fromSeconds = Math.floor(input.from / 1000);
  const toSeconds = Math.ceil(input.to / 1000);
  // index1 is the Analytics Engine sampling key. Distinct fields that are
  // not the sampling key remain estimates; multiplying them by sample weight
  // would be incorrect, so the response advertises them as approximate.
  const columns =
    input.source === "abnormal"
      ? `
      sumIf(_sample_interval, blob2 = 'high_threat') AS highThreat,
      sumIf(_sample_interval, blob2 = 'medium_threat') AS mediumThreat,
      sumIf(_sample_interval, blob2 = 'custom_block') AS customBlocked,
      count(DISTINCT index1) AS affectedSites,
      count(DISTINCT double4) AS uniqueAsns,
      count(DISTINCT blob9) AS uniqueCountries`
      : `
      count(DISTINCT index1) AS affectedSites,
      count(DISTINCT double4) AS uniqueAsns,
      count(DISTINCT blob9) AS uniqueCountries`;
  const latencyColumns =
    input.source === "normal" && input.includeLatency !== false
      ? `,
      sumIf(_sample_interval * double3, ${NORMAL_LATENCY_SQL_FILTER}) AS latencyWeightedSumMs,
      sumIf(_sample_interval, ${NORMAL_LATENCY_SQL_FILTER}) AS latencySampleWeight,
      quantileExactWeighted(0.5)(double3, if(${NORMAL_LATENCY_SQL_FILTER}, _sample_interval, 0)) AS p50LatencyMs,
      quantileExactWeighted(0.75)(double3, if(${NORMAL_LATENCY_SQL_FILTER}, _sample_interval, 0)) AS p75LatencyMs,
      quantileExactWeighted(0.95)(double3, if(${NORMAL_LATENCY_SQL_FILTER}, _sample_interval, 0)) AS p95LatencyMs,
      quantileExactWeighted(0.99)(double3, if(${NORMAL_LATENCY_SQL_FILTER}, _sample_interval, 0)) AS p99LatencyMs`
      : "";
  return `
    SELECT
      sum(_sample_interval) AS total,
      max(_sample_interval) AS maxSampleInterval,${columns}${latencyColumns}
    FROM ${REQUEST_ANALYTICS_DATASET}
    WHERE timestamp >= toDateTime(${fromSeconds})
      AND timestamp <= toDateTime(${toSeconds})
      AND double20 = ${REQUEST_ANALYTICS_SCHEMA_VERSION}
      AND ${requestCategoryFilter(input.source)}
    FORMAT JSONEachRow
  `;
}

function buildDimensionSql(input: {
  from: number;
  to: number;
  source: DetailSource;
  group: DimensionGroup;
  tab: string;
}) {
  const fromSeconds = Math.floor(input.from / 1000);
  const toSeconds = Math.ceil(input.to / 1000);
  const abnormal = input.source === "abnormal";
  const fields: Record<string, string[]> = abnormal
    ? {
        reason: ["blob3 AS label"],
        category: ["blob2 AS label"],
        kind: ["blob1 AS label"],
        botScoreBucket: [
          `if(intDiv(double19, ${REQUEST_ANALYTICS_FLAGS.botScorePresent}) % 2 = 0, '', if(double7 < 20, '1-19', if(double7 < 40, '20-39', if(double7 < 60, '40-59', if(double7 < 80, '60-79', '80-99'))))) AS label`,
        ],
        verifiedBotCategory: ["blob15 AS label"],
        site: ["index1 AS label"],
        hostname: ["blob7 AS label"],
        pathname: ["blob8 AS label"],
        origin: ["blob6 AS label"],
        asOrganization: ["blob14 AS label"],
        asn: ["double4 AS label"],
        country: ["blob9 AS label"],
        region: ["blob10 AS label", "blob9 AS country"],
        city: ["blob11 AS label", "blob9 AS country", "blob10 AS region"],
        colo: ["blob13 AS label"],
        ip: ["blob4 AS label"],
        userAgent: ["blob5 AS label"],
        userAgentLengthBucket: [
          "if(double8 <= 0, '', if(double8 < 80, '1-79', if(double8 < 160, '80-159', if(double8 < 256, '160-255', if(double8 < 512, '256-511', '512+'))))) AS label",
        ],
        ipPrefix: ["blob4 AS label"],
      }
    : {
        site: ["index1 AS label"],
        hostname: ["blob7 AS label"],
        pathname: ["blob8 AS label"],
        origin: ["blob6 AS label"],
        asOrganization: ["blob14 AS label"],
        asn: ["double4 AS label"],
        country: ["blob9 AS label"],
        region: ["blob10 AS label", "blob9 AS country"],
        city: ["blob11 AS label", "blob9 AS country", "blob10 AS region"],
        colo: ["blob13 AS label"],
      };
  const columns = fields[input.tab];
  if (!columns || !DIMENSION_TABS[input.group].includes(input.tab))
    throw new Error("Invalid analytics dimension");
  const groupBy = columns.map((column) => column.split(" AS ")[1]).join(", ");
  return `SELECT ${columns.join(", ")}, max(_sample_interval) AS maxSampleInterval, sum(_sample_interval) AS count${abnormal ? ", sumIf(_sample_interval, blob2 = 'high_threat') AS highThreat" : ", 0 AS highThreat"} FROM ${REQUEST_ANALYTICS_DATASET} WHERE timestamp >= toDateTime(${fromSeconds}) AND timestamp <= toDateTime(${toSeconds}) AND double20 = ${REQUEST_ANALYTICS_SCHEMA_VERSION} AND ${requestCategoryFilter(input.source)} GROUP BY ${groupBy} ORDER BY count DESC LIMIT 30 FORMAT JSONEachRow`;
}

function buildReasonSummarySql(input: { from: number; to: number }) {
  const fromSeconds = Math.floor(input.from / 1000);
  const toSeconds = Math.ceil(input.to / 1000);
  return `
    SELECT
      blob3 AS reasons,
      max(_sample_interval) AS maxSampleInterval,
      sum(_sample_interval) AS weight
    FROM ${REQUEST_ANALYTICS_DATASET}
    WHERE timestamp >= toDateTime(${fromSeconds})
      AND timestamp <= toDateTime(${toSeconds})
      AND double20 = ${REQUEST_ANALYTICS_SCHEMA_VERSION}
      AND ${requestCategoryFilter("abnormal")}
    GROUP BY reasons
    ORDER BY weight DESC
    LIMIT 100
    FORMAT JSONEachRow
  `;
}

function buildAsnSummarySql(input: { from: number; to: number }) {
  const fromSeconds = Math.floor(input.from / 1000);
  const toSeconds = Math.ceil(input.to / 1000);
  return `
    SELECT
      double4 AS asn,
      blob14 AS asOrganization,
      max(_sample_interval) AS maxSampleInterval,
      sum(_sample_interval) AS count,
      sumIf(_sample_interval, blob2 = 'high_threat') AS highThreat
    FROM ${REQUEST_ANALYTICS_DATASET}
    WHERE timestamp >= toDateTime(${fromSeconds})
      AND timestamp <= toDateTime(${toSeconds})
      AND double20 = ${REQUEST_ANALYTICS_SCHEMA_VERSION}
      AND ${requestCategoryFilter("abnormal")}
    GROUP BY asn, asOrganization
    ORDER BY count DESC
    LIMIT 30
    FORMAT JSONEachRow
  `;
}

function buildRequestAnalyticsDetailSql(input: {
  since: number;
  traceId?: string;
  rayId?: string;
}) {
  const sinceSeconds = Math.floor(input.since / 1000);
  const identityFilters = [
    input.traceId ? `blob17 = ${analyticsSqlString(input.traceId)}` : "",
    input.rayId ? `blob16 = ${analyticsSqlString(input.rayId)}` : "",
  ].filter(Boolean);
  return `
    SELECT ${requestRowSelect()}
    FROM ${REQUEST_ANALYTICS_DATASET}
    WHERE timestamp >= toDateTime(${sinceSeconds})
      AND double20 = ${REQUEST_ANALYTICS_SCHEMA_VERSION}
      AND ${requestCategoryFilter("abnormal")}
      AND (${identityFilters.join(" OR ") || "0"})
    ORDER BY timestamp DESC, receivedAt DESC
    LIMIT 1
    FORMAT JSONEachRow
  `;
}

function emptyRequestObservationResponse(
  env: Env,
  config: AnalyticsEngineConfig,
  error: string,
) {
  const now = Date.now();
  return {
    ok: true,
    configured: false,
    generatedAt: now,
    config: redactAnalyticsEngineConfig(
      config,
      analyticsEngineAvailability(env),
    ),
    sampling: analyticsEngineSamplingMeta({
      observedSampled: false,
      aggregatesWeighted: false,
      detailsAreSampled: false,
      distinctAreApproximate: false,
    }),
    error,
    events: [],
    normalEvents: [],
    summary: {
      total: 0,
      baselineRequests: 0,
      botRequestRatio: 0,
      highThreat: 0,
      mediumThreat: 0,
      customBlocked: 0,
      affectedSites: 0,
      uniqueAsns: 0,
      uniqueCountries: 0,
    },
    mapPoints: [],
    trend: [],
    reasons: [],
    countries: [],
    asns: [],
    overview: {
      totalRequests: 0,
      normalRequests: 0,
      abnormalRequests: 0,
      abnormalRequestRatio: 0,
      normalRequestRatio: 0,
      pageviews: 0,
      customEvents: 0,
      avgLatencyMs: null,
      p50LatencyMs: null,
      p75LatencyMs: null,
      p95LatencyMs: null,
      p99LatencyMs: null,
    },
    abnormal: {
      summary: {
        total: 0,
        ratio: 0,
        highThreat: 0,
        mediumThreat: 0,
        customBlocked: 0,
        affectedSites: 0,
        uniqueAsns: 0,
        uniqueCountries: 0,
      },
      mapPoints: [],
      events: [],
    },
    normal: {
      summary: {
        total: 0,
        ratio: 0,
        pageviews: 0,
        customEvents: 0,
        affectedSites: 0,
        uniqueAsns: 0,
        uniqueCountries: 0,
        avgLatencyMs: null,
        p50LatencyMs: null,
        p75LatencyMs: null,
        p95LatencyMs: null,
        p99LatencyMs: null,
      },
      mapPoints: [],
      events: [],
    },
  };
}

function requireAdmin(actor: AdminActor, request: Request): Response | null {
  if (actor instanceof Response) return actor;
  if (!actor.isAdmin) {
    return forb(
      "Only system admin can manage request observation settings",
      undefined,
      request,
    );
  }
  return null;
}

function parseJsonEachRow(text: string): Record<string, unknown>[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function requestAnalyticsFlagPresent(
  value: unknown,
  flag: (typeof REQUEST_ANALYTICS_FLAGS)[keyof typeof REQUEST_ANALYTICS_FLAGS],
): boolean {
  return hasRequestFlag(Math.trunc(toFiniteNumber(value)), flag);
}

function normalizeAbnormalRow(
  row: Record<string, unknown>,
  sites: Map<string, { name: string; domain: string }>,
): RequestObservationEvent {
  const siteId = clampString(String(row.siteId || ""), 128);
  const site = sites.get(siteId);
  const reasons = String(row.reasons || "")
    .split(",")
    .map((reason) => reason.trim())
    .filter(Boolean);
  const flags = Math.trunc(toFiniteNumber(row.flags));
  const botScore = toFiniteNumber(row.botScore, Number.NaN);
  const receivedAt = toFiniteNumber(row.receivedAt);
  return {
    timestamp: clampString(String(row.timestamp || ""), 64),
    receivedAt,
    siteId,
    siteName: clampString(site?.name || siteId || "Unknown site", 160),
    siteDomain: clampString(site?.domain || "", 255),
    kind: clampString(String(row.kind || ""), 40),
    category: normalizeObservationCategory(row.category) ?? "custom_block",
    reasons,
    ip: clampString(String(row.ip || ""), 80),
    userAgent: clampString(String(row.userAgent || ""), 1024),
    origin: clampString(String(row.origin || ""), 255),
    hostname: clampString(String(row.hostname || ""), 255),
    pathname: clampString(String(row.pathname || ""), 2048),
    country: clampString(String(row.country || ""), 10),
    region: clampString(String(row.region || ""), 128),
    city: clampString(String(row.city || ""), 128),
    continent: clampString(String(row.continent || ""), 32),
    colo: clampString(String(row.colo || ""), 16),
    asn: Math.trunc(toFiniteNumber(row.asn)),
    asOrganization: clampString(String(row.asOrganization || ""), 255),
    verifiedBotCategory: clampString(String(row.verifiedBotCategory || ""), 80),
    rayId: clampString(String(row.rayId || ""), 120),
    traceId: clampString(String(row.traceId || ""), 128),
    requestMethod: clampString(String(row.requestMethod || ""), 16),
    httpProtocol: clampString(String(row.httpProtocol || ""), 40),
    metadataJson: clampString(String(row.metadataJson || ""), 8000),
    latitude: requestAnalyticsFlagPresent(
      flags,
      REQUEST_ANALYTICS_FLAGS.coordinatePresent,
    )
      ? toNullableCoordinate(row.latitude)
      : null,
    longitude: requestAnalyticsFlagPresent(
      flags,
      REQUEST_ANALYTICS_FLAGS.coordinatePresent,
    )
      ? toNullableCoordinate(row.longitude)
      : null,
    botScore:
      requestAnalyticsFlagPresent(
        flags,
        REQUEST_ANALYTICS_FLAGS.botScorePresent,
      ) && Number.isFinite(botScore)
        ? botScore
        : null,
    userAgentLength: Math.trunc(toFiniteNumber(row.userAgentLength)),
    flags,
  };
}

function normalizeNormalRow(
  row: Record<string, unknown>,
  sites: Map<string, { name: string; domain: string }>,
): RequestObservationNormalEvent {
  const siteId = clampString(String(row.siteId || ""), 128);
  const site = sites.get(siteId);
  const receivedAt = toFiniteNumber(row.receivedAt);
  const eventAt = toFiniteNumber(row.eventAt);
  const schemaVersion = Math.trunc(toFiniteNumber(row.schemaVersion));
  const flags = Math.trunc(toFiniteNumber(row.flags));
  const rawEdgeLatencyMs = toFiniteNumber(row.edgeLatencyMs, Number.NaN);
  const edgeLatencyMs =
    schemaVersion === REQUEST_ANALYTICS_SCHEMA_VERSION &&
    requestAnalyticsFlagPresent(
      flags,
      REQUEST_ANALYTICS_FLAGS.edgeLatencyPresent,
    ) &&
    Number.isFinite(rawEdgeLatencyMs) &&
    rawEdgeLatencyMs >= 0 &&
    rawEdgeLatencyMs <= MAX_WORKER_LATENCY_MS
      ? rawEdgeLatencyMs
      : null;
  return {
    timestamp: clampString(String(row.timestamp || ""), 64),
    receivedAt,
    eventAt,
    edgeLatencyMs,
    schemaVersion,
    siteId,
    siteName: clampString(site?.name || siteId || "Unknown site", 160),
    siteDomain: clampString(site?.domain || "", 255),
    kind: clampString(String(row.kind || ""), 40),
    origin: clampString(String(row.origin || ""), 255),
    hostname: clampString(String(row.hostname || ""), 255),
    pathname: clampString(String(row.pathname || ""), 2048),
    country: clampString(String(row.country || ""), 10),
    region: clampString(String(row.region || ""), 128),
    city: clampString(String(row.city || ""), 128),
    continent: clampString(String(row.continent || ""), 32),
    colo: clampString(String(row.colo || ""), 16),
    asn: Math.trunc(toFiniteNumber(row.asn)),
    asOrganization: clampString(String(row.asOrganization || ""), 255),
    rayId: clampString(String(row.rayId || ""), 120),
    traceId: clampString(String(row.traceId || ""), 128),
    requestMethod: clampString(String(row.requestMethod || ""), 16),
    metadataJson: clampString(String(row.metadataJson || ""), 8000),
    latitude: requestAnalyticsFlagPresent(
      flags,
      REQUEST_ANALYTICS_FLAGS.coordinatePresent,
    )
      ? toNullableCoordinate(row.latitude)
      : null,
    longitude: requestAnalyticsFlagPresent(
      flags,
      REQUEST_ANALYTICS_FLAGS.coordinatePresent,
    )
      ? toNullableCoordinate(row.longitude)
      : null,
    userAgentLength: Math.trunc(toFiniteNumber(row.userAgentLength)),
    flags,
  };
}

function serializeAbnormalListEvent(event: RequestObservationEvent) {
  const {
    metadataJson: _metadataJson,
    requestMethod: _requestMethod,
    httpProtocol: _httpProtocol,
    flags: _flags,
    ...listEvent
  } = event;
  return listEvent;
}

function serializeNormalListEvent(event: RequestObservationNormalEvent) {
  // Normal requests open their Drawer from the selected list row, so retain
  // the compact metadata payload instead of requiring a second detail query.
  const { schemaVersion: _schemaVersion, flags: _flags, ...listEvent } = event;
  return listEvent;
}

function detailCursorForEvent(
  event: RequestObservationEvent | RequestObservationNormalEvent,
): DetailCursor {
  return {
    timestamp: event.timestamp,
    receivedAt: event.receivedAt,
  };
}

function buildTrendBuckets(
  from: number,
  to: number,
  interval: RequestObservationInterval,
  timeZone: string,
) {
  const buckets: number[] = [];
  let bucket = startOfZonedInterval(from, interval, timeZone);
  let guard = 0;
  while (bucket <= to && guard < 5000) {
    buckets.push(bucket);
    const nextBucket = addZonedInterval(bucket, interval, timeZone);
    if (nextBucket <= bucket) break;
    bucket = nextBucket;
    guard += 1;
  }
  return Array.from(new Set(buckets)).sort((left, right) => left - right);
}

function bucketTimestamp(
  timestampMs: number,
  interval: RequestObservationInterval,
  timeZone: string,
): number {
  return startOfZonedInterval(timestampMs, interval, timeZone);
}

async function siteLookup(
  env: Env,
  events: Array<RequestObservationEvent | RequestObservationNormalEvent>,
) {
  const ids = [...new Set(events.map((event) => event.siteId).filter(Boolean))];
  return siteLookupByIds(env, ids);
}

async function siteLookupByIds(env: Env, ids: string[]) {
  if (ids.length === 0)
    return new Map<string, { name: string; domain: string }>();
  const sites = new Map<string, { name: string; domain: string }>();
  for (let index = 0; index < ids.length; index += MAX_SITE_IDS_PER_D1_QUERY) {
    const chunk = ids.slice(index, index + MAX_SITE_IDS_PER_D1_QUERY);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await env.DB.prepare(
      `SELECT id, name, domain FROM sites WHERE id IN (${placeholders})`,
    )
      .bind(...chunk)
      .all<{ id: string; name: string; domain: string }>();
    for (const row of rows.results) {
      sites.set(String(row.id || ""), {
        name: String(row.name || ""),
        domain: String(row.domain || ""),
      });
    }
  }
  return sites;
}

async function queryAnalyticsRows(input: {
  apiUrl?: string;
  accountId: string;
  token: string;
  sql: string;
}) {
  const result = await queryCloudflareAnalyticsEngine(input);
  if (!result.ok) return result;
  try {
    return {
      ok: true as const,
      rows: parseJsonEachRow(result.body),
    };
  } catch {
    return {
      ok: false as const,
      status: 502,
      body: "Cloudflare Analytics Engine returned invalid JSONEachRow data",
    };
  }
}

function normalizeMapRows(rows: Record<string, unknown>[]) {
  return rows
    .map((row) => ({
      latitude: toNullableCoordinate(row.latitude),
      longitude: toNullableCoordinate(row.longitude),
      country: clampString(String(row.country || ""), 10),
      pointCount: Math.max(0, Math.trunc(toFiniteNumber(row.pointCount))),
    }))
    .filter(
      (
        row,
      ): row is {
        latitude: number;
        longitude: number;
        country: string;
        pointCount: number;
      } => row.latitude !== null && row.longitude !== null,
    );
}

function normalizeNetworkDimensionRows(rows: Record<string, unknown>[]) {
  return rows.map((row) => {
    const label = clampString(String(row.label || ""), 255);
    const country = clampString(String(row.country || ""), 10);
    const region = clampString(String(row.region || ""), 128);
    return {
      key: [label, country, region].join("\u0000"),
      label,
      count: Math.max(0, Math.trunc(toFiniteNumber(row.count))),
      highThreat: Math.max(0, Math.trunc(toFiniteNumber(row.highThreat))),
      country,
      region,
    };
  });
}

function normalizeReasonRows(rows: Record<string, unknown>[]) {
  const reasonCounts = new Map<string, number>();
  for (const row of rows) {
    const weight = Math.max(0, toFiniteNumber(row.weight));
    for (const reason of String(row.reasons || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)) {
      reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + weight);
    }
  }
  return [...reasonCounts.entries()]
    .map(([reason, count]) => ({
      reason,
      count: Math.max(0, Math.trunc(count)),
    }))
    .sort((left, right) => right.count - left.count)
    .slice(0, 10);
}

function normalizeAsnRows(rows: Record<string, unknown>[]) {
  const asns = new Map<
    number,
    { asn: number; asOrganization: string; count: number }
  >();
  for (const row of rows) {
    const asn = Math.trunc(toFiniteNumber(row.asn ?? row.label));
    if (asn <= 0) continue;
    const current = asns.get(asn) ?? {
      asn,
      asOrganization: "",
      count: 0,
    };
    current.count += Math.max(0, toFiniteNumber(row.count));
    if (!current.asOrganization) {
      current.asOrganization = clampString(
        String(row.asOrganization || ""),
        255,
      );
    }
    asns.set(asn, current);
  }
  return [...asns.values()]
    .sort((left, right) => right.count - left.count)
    .slice(0, 30)
    .map((row) => ({ ...row, count: Math.max(0, Math.trunc(row.count)) }));
}

function aggregateNormalEvents(events: RequestObservationNormalEvent[]) {
  const uniqueAsns = new Set(events.map((event) => event.asn).filter(Boolean));
  const uniqueCountries = new Set(
    events.map((event) => event.country).filter(Boolean),
  );
  const affectedSites = new Set(
    events.map((event) => event.siteId).filter(Boolean),
  );
  const latencyValues = events
    .filter(
      (event) =>
        event.schemaVersion === REQUEST_ANALYTICS_SCHEMA_VERSION &&
        requestAnalyticsFlagPresent(
          event.flags,
          REQUEST_ANALYTICS_FLAGS.edgeLatencyPresent,
        ),
    )
    .map((event) => event.edgeLatencyMs)
    .filter(
      (value): value is number =>
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= 0 &&
        value <= MAX_WORKER_LATENCY_MS,
    )
    .sort((left, right) => left - right);
  const avgLatencyMs =
    latencyValues.length > 0
      ? latencyValues.reduce((sum, value) => sum + value, 0) /
        latencyValues.length
      : null;
  const p50LatencyMs = percentile(latencyValues, 0.5);
  const p75LatencyMs = percentile(latencyValues, 0.75);
  const p95LatencyMs = percentile(latencyValues, 0.95);
  const p99LatencyMs = percentile(latencyValues, 0.99);
  return {
    total: events.length,
    pageviews: events.filter((event) => event.kind === "pageview").length,
    customEvents: events.filter((event) => event.kind === "custom_event")
      .length,
    affectedSites: affectedSites.size,
    uniqueAsns: uniqueAsns.size,
    uniqueCountries: uniqueCountries.size,
    avgLatencyMs,
    p50LatencyMs,
    p75LatencyMs,
    p95LatencyMs,
    p99LatencyMs,
  };
}

function percentile(
  sortedValues: number[],
  percentileValue: number,
): number | null {
  if (sortedValues.length === 0) return null;
  return sortedValues[
    Math.min(
      sortedValues.length - 1,
      Math.ceil(sortedValues.length * percentileValue) - 1,
    )
  ];
}

function normalizeLatencySummary(row: Record<string, unknown>) {
  const latencyWeightedSumMs = toFiniteNumber(
    row.latencyWeightedSumMs,
    Number.NaN,
  );
  const latencySampleWeight = toFiniteNumber(
    row.latencySampleWeight,
    Number.NaN,
  );
  const hasWeightedLatency =
    Number.isFinite(latencyWeightedSumMs) &&
    latencyWeightedSumMs >= 0 &&
    Number.isFinite(latencySampleWeight) &&
    latencySampleWeight > 0;
  const normalizePercentile = (value: unknown) => {
    const numeric = toFiniteNumber(value, Number.NaN);
    return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
  };

  return {
    avgLatencyMs: hasWeightedLatency
      ? latencyWeightedSumMs / latencySampleWeight
      : null,
    p50LatencyMs: hasWeightedLatency
      ? normalizePercentile(row.p50LatencyMs)
      : null,
    p75LatencyMs: hasWeightedLatency
      ? normalizePercentile(row.p75LatencyMs)
      : null,
    p95LatencyMs: hasWeightedLatency
      ? normalizePercentile(row.p95LatencyMs)
      : null,
    p99LatencyMs: hasWeightedLatency
      ? normalizePercentile(row.p99LatencyMs)
      : null,
  };
}

function mergeTrendRows(input: {
  from: number;
  to: number;
  bucketMs: number;
  interval: RequestObservationInterval;
  timeZone: string;
  abnormalRows: Record<string, unknown>[];
  normalRows: Record<string, unknown>[];
  normalEvents?: RequestObservationNormalEvent[];
}) {
  const trend = new Map<
    number,
    {
      timestampMs: number;
      count: number;
      baselineCount: number;
      normalCount: number;
      abnormalCount: number;
      totalCount: number;
      botRatio: number;
      abnormalRatio: number;
      normalRatio: number;
      mediumThreatCount: number;
      highThreatCount: number;
      customBlockedCount: number;
      pageviews: number;
      customEvents: number;
      pageviewCount: number;
      leaveCount: number;
      visibilityCount: number;
      customEventCount: number;
      identifyCount: number;
      weightedRequestCount: number;
      latencyWeightedSumMs: number;
      latencySampleWeight: number;
      avgLatencyMs: number | null;
      p50LatencyMs: number | null;
      p75LatencyMs: number | null;
      p95LatencyMs: number | null;
      p99LatencyMs: number | null;
    }
  >();
  for (const timestampMs of buildTrendBuckets(
    input.from,
    input.to,
    input.interval,
    input.timeZone,
  )) {
    trend.set(timestampMs, {
      timestampMs,
      count: 0,
      baselineCount: 0,
      normalCount: 0,
      abnormalCount: 0,
      totalCount: 0,
      botRatio: 0,
      abnormalRatio: 0,
      normalRatio: 0,
      mediumThreatCount: 0,
      highThreatCount: 0,
      customBlockedCount: 0,
      pageviews: 0,
      customEvents: 0,
      pageviewCount: 0,
      leaveCount: 0,
      visibilityCount: 0,
      customEventCount: 0,
      identifyCount: 0,
      weightedRequestCount: 0,
      latencyWeightedSumMs: 0,
      latencySampleWeight: 0,
      avgLatencyMs: null,
      p50LatencyMs: null,
      p75LatencyMs: null,
      p95LatencyMs: null,
      p99LatencyMs: null,
    });
  }
  for (const row of input.abnormalRows) {
    const timestampMs = bucketTimestamp(
      Math.floor(toFiniteNumber(row.timestampMs)),
      input.interval,
      input.timeZone,
    );
    const current = trend.get(timestampMs);
    if (!current) continue;
    const weightedRequestCount = Math.max(
      0,
      toFiniteNumber(row.weightedRequestCount, toFiniteNumber(row.count)),
    );
    current.abnormalCount = weightedRequestCount;
    current.count = current.abnormalCount;
    current.weightedRequestCount += weightedRequestCount;
    current.mediumThreatCount = Math.max(
      0,
      toFiniteNumber(row.mediumThreatCount),
    );
    current.highThreatCount = Math.max(0, toFiniteNumber(row.highThreatCount));
    current.customBlockedCount = Math.max(
      0,
      toFiniteNumber(row.customBlockedCount),
    );
    current.pageviews += Math.max(0, toFiniteNumber(row.pageviews));
    current.customEvents += Math.max(0, toFiniteNumber(row.customEvents));
  }
  for (const row of input.normalRows) {
    const timestampMs = bucketTimestamp(
      Math.floor(toFiniteNumber(row.timestampMs)),
      input.interval,
      input.timeZone,
    );
    const current = trend.get(timestampMs);
    if (!current) continue;
    const weightedRequestCount = Math.max(
      0,
      toFiniteNumber(row.weightedRequestCount, toFiniteNumber(row.count)),
    );
    current.normalCount = weightedRequestCount;
    current.baselineCount = current.normalCount;
    current.weightedRequestCount += weightedRequestCount;
    current.pageviews += Math.max(0, toFiniteNumber(row.pageviews));
    current.customEvents += Math.max(0, toFiniteNumber(row.customEvents));
    current.pageviewCount += Math.max(
      0,
      toFiniteNumber(row.pageviewCount, toFiniteNumber(row.pageviews)),
    );
    current.leaveCount += Math.max(0, toFiniteNumber(row.leaveCount));
    current.visibilityCount += Math.max(0, toFiniteNumber(row.visibilityCount));
    current.customEventCount += Math.max(
      0,
      toFiniteNumber(row.customEventCount, toFiniteNumber(row.customEvents)),
    );
    current.identifyCount += Math.max(0, toFiniteNumber(row.identifyCount));
    const latencyWeightedSumMs = toFiniteNumber(
      row.latencyWeightedSumMs,
      Number.NaN,
    );
    const latencySampleWeight = toFiniteNumber(
      row.latencySampleWeight,
      Number.NaN,
    );
    if (
      Number.isFinite(latencyWeightedSumMs) &&
      latencyWeightedSumMs >= 0 &&
      Number.isFinite(latencySampleWeight) &&
      latencySampleWeight > 0
    ) {
      current.latencyWeightedSumMs = latencyWeightedSumMs;
      current.latencySampleWeight = latencySampleWeight;
    }
    const p50LatencyMs = toFiniteNumber(row.p50LatencyMs, Number.NaN);
    const p75LatencyMs = toFiniteNumber(row.p75LatencyMs, Number.NaN);
    const p95LatencyMs = toFiniteNumber(row.p95LatencyMs, Number.NaN);
    const p99LatencyMs = toFiniteNumber(row.p99LatencyMs, Number.NaN);
    current.avgLatencyMs =
      current.latencySampleWeight > 0
        ? current.latencyWeightedSumMs / current.latencySampleWeight
        : null;
    current.p50LatencyMs = Number.isFinite(p50LatencyMs)
      ? p50LatencyMs
      : current.avgLatencyMs;
    current.p75LatencyMs = Number.isFinite(p75LatencyMs)
      ? p75LatencyMs
      : Number.isFinite(p95LatencyMs)
        ? p95LatencyMs
        : null;
    current.p95LatencyMs = Number.isFinite(p95LatencyMs) ? p95LatencyMs : null;
    current.p99LatencyMs = Number.isFinite(p99LatencyMs)
      ? p99LatencyMs
      : current.p95LatencyMs;
  }
  return [...trend.values()].map((point) => {
    const totalCount = point.normalCount + point.abnormalCount;
    point.count = totalCount;
    point.avgLatencyMs =
      point.latencySampleWeight > 0
        ? point.latencyWeightedSumMs / point.latencySampleWeight
        : null;
    return {
      ...point,
      totalCount,
      botRatio: totalCount > 0 ? point.abnormalCount / totalCount : 0,
      abnormalRatio: totalCount > 0 ? point.abnormalCount / totalCount : 0,
      normalRatio: totalCount > 0 ? point.normalCount / totalCount : 0,
    };
  });
}

async function queryCloudflareAnalyticsEngine(input: {
  apiUrl?: string;
  accountId: string;
  token: string;
  sql: string;
  fetchImpl?: typeof fetch;
}) {
  const fetchImpl = input.fetchImpl || fetch;
  const response = await fetchImpl(
    `${input.apiUrl || CF_ANALYTICS_ENGINE_SQL_ENDPOINT}/${encodeURIComponent(
      input.accountId,
    )}/analytics_engine/sql`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.token}`,
        "content-type": "text/plain",
      },
      body: input.sql,
    },
  );
  const text = await response.text();
  if (!response.ok) {
    return {
      ok: false as const,
      status: response.status,
      body: text.slice(0, 500),
    };
  }
  return { ok: true as const, body: text };
}

function cloudflareAnalyticsErrorMessage(input: {
  status: number;
  body: string;
}): string {
  const fallback = `Cloudflare Analytics Engine query failed (${input.status})`;
  const body = input.body.trim();
  if (!body) return fallback;

  try {
    const parsed = JSON.parse(body) as {
      errors?: Array<{ message?: unknown; code?: unknown }>;
      error?: unknown;
      message?: unknown;
    };
    const details =
      parsed.errors
        ?.map((error) => [error.code, error.message].filter(Boolean).join(": "))
        .filter(Boolean)
        .join("; ") ||
      (typeof parsed.message === "string" ? parsed.message : "") ||
      (typeof parsed.error === "string" ? parsed.error : "");
    if (details) return `${fallback}: ${clampString(details, 500)}`;
  } catch {}

  return `${fallback}: ${clampString(body, 500)}`;
}

export async function handleRequestObservationAdmin(
  req: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const actor = await requireActor(env, req);
  const authError = requireAdmin(actor, req);
  if (authError) return authError;
  if (req.method !== "GET") return na(req);

  const rawConfig = await readConfig(env, SYSTEM_ANALYTICS_ENGINE_CONFIG_KEY);
  const config = rawConfig
    ? normalizeAnalyticsEngineConfig(rawConfig)
    : defaultAnalyticsEngineConfig();
  if (analyticsEngineAvailability(env).analyticsEngineDisabled) {
    return jsonResponseFor(
      req,
      emptyRequestObservationResponse(env, config, "analytics_engine_disabled"),
    );
  }

  const configError = validateAnalyticsEngineConfig(config);
  if (configError || !config.configured || !config.apiTokenEncrypted) {
    return jsonResponseFor(req, {
      ...emptyRequestObservationResponse(
        env,
        config,
        configError || "request_observation_not_configured",
      ),
    });
  }

  let token: string;
  try {
    token = await decryptAnalyticsEngineSecret(env, config.apiTokenEncrypted);
  } catch {
    return bad(
      "Unable to decrypt Cloudflare API token",
      "request_observation_secret_decryption_failed",
      req,
    );
  }

  const generatedAt = Date.now();
  const analyticsApiUrl = analyticsEngineSqlEndpoint(env);
  if (!analyticsApiUrl) {
    return bad(
      "E2E Cloudflare Analytics Engine mock URL is required",
      "e2e_analytics_mock_url_required",
      req,
    );
  }
  const timeWindow = parseTimeWindow(url, generatedAt);
  const { from, to, minutes, interval, bucketMs, timeZone } = timeWindow;
  const limit = parseLimit(url);
  const detailTraceId = clampString(
    url.searchParams.get("traceId")?.trim() || "",
    128,
  );
  const detailRayId = clampString(
    url.searchParams.get("rayId")?.trim() || "",
    120,
  );

  if (url.searchParams.get("detail") === "1" || detailTraceId || detailRayId) {
    if (!detailTraceId && !detailRayId) {
      return bad(
        "Request observation detail requires traceId or rayId",
        "request_observation_detail_missing_id",
        req,
      );
    }

    const detailSql = buildRequestAnalyticsDetailSql({
      since: from,
      traceId: detailTraceId,
      rayId: detailRayId,
    });
    const detailResult = await queryCloudflareAnalyticsEngine({
      apiUrl: analyticsApiUrl,
      accountId: config.accountId,
      token,
      sql: detailSql,
    });
    if (!detailResult.ok) {
      return bad(
        cloudflareAnalyticsErrorMessage(detailResult),
        "request_observation_query_failed",
        req,
      );
    }

    let detailRows: Record<string, unknown>[];
    try {
      detailRows = parseJsonEachRow(detailResult.body);
    } catch {
      return bad(
        "Cloudflare Analytics Engine returned invalid JSONEachRow data",
        "request_observation_parse_failed",
        req,
      );
    }

    const preliminaryEvents = detailRows.map((row) =>
      normalizeAbnormalRow(row, new Map()),
    );
    const sites = await siteLookup(env, preliminaryEvents);
    const detail = detailRows[0]
      ? normalizeAbnormalRow(detailRows[0], sites)
      : null;
    return jsonResponseFor(req, {
      ok: true,
      configured: true,
      generatedAt,
      config: redactAnalyticsEngineConfig(
        config,
        analyticsEngineAvailability(env),
      ),
      sampling: analyticsEngineSamplingMeta({
        observedSampled: rowsContainObservedSampling(detailRows),
        aggregatesWeighted: false,
        detailsAreSampled: true,
        distinctAreApproximate: false,
      }),
      detail,
    });
  }

  const pageSource = url.searchParams.get("page");
  if (pageSource === "abnormal" || pageSource === "normal") {
    const source: DetailSource = pageSource;
    const cursor = parseDetailCursor(url);
    if (url.searchParams.has("cursor") && !cursor) {
      return bad(
        "Invalid request observation page cursor",
        "request_observation_invalid_cursor",
        req,
      );
    }
    const pageLimit = parseLimit(url);
    const pageResult = await queryCloudflareAnalyticsEngine({
      apiUrl: analyticsApiUrl,
      accountId: config.accountId,
      token,
      sql: buildRequestAnalyticsSql({
        from,
        to,
        limit: pageLimit + 1,
        source,
        cursor,
      }),
    });
    if (!pageResult.ok) {
      return bad(
        cloudflareAnalyticsErrorMessage(pageResult),
        "request_observation_query_failed",
        req,
      );
    }
    let pageRows: Record<string, unknown>[];
    try {
      pageRows = parseJsonEachRow(pageResult.body);
    } catch {
      return bad(
        "Cloudflare Analytics Engine returned invalid JSONEachRow data",
        "request_observation_parse_failed",
        req,
      );
    }
    const hasMore = pageRows.length > pageLimit;
    const rows = pageRows.slice(0, pageLimit);
    const preliminaryEvents = rows.map((row) =>
      source === "abnormal"
        ? normalizeAbnormalRow(row, new Map())
        : normalizeNormalRow(row, new Map()),
    );
    const sites = await siteLookup(env, preliminaryEvents);
    const events = rows.map((row) =>
      source === "abnormal"
        ? serializeAbnormalListEvent(normalizeAbnormalRow(row, sites))
        : serializeNormalListEvent(normalizeNormalRow(row, sites)),
    );
    const lastEvent = preliminaryEvents[preliminaryEvents.length - 1];
    return jsonResponseFor(req, {
      ok: true,
      configured: true,
      generatedAt,
      sampling: analyticsEngineSamplingMeta({
        observedSampled: rowsContainObservedSampling(pageRows),
        aggregatesWeighted: false,
        detailsAreSampled: true,
        distinctAreApproximate: false,
      }),
      page: {
        source,
        events,
        hasMore,
        nextCursor:
          hasMore && lastEvent ? detailCursorForEvent(lastEvent) : null,
      },
    });
  }

  const dimensionGroup = url.searchParams.get(
    "dimensionGroup",
  ) as DimensionGroup | null;
  const dimensionTab = url.searchParams.get("dimensionTab") || "";
  const dimensionSource = url.searchParams.get("dimensionSource");
  if (
    dimensionGroup &&
    (dimensionSource === "abnormal" || dimensionSource === "normal")
  ) {
    if (!DIMENSION_TABS[dimensionGroup]?.includes(dimensionTab)) {
      return bad(
        "Invalid request observation dimension",
        "request_observation_invalid_dimension",
        req,
      );
    }
    let sql: string;
    try {
      sql = buildDimensionSql({
        from,
        to,
        source: dimensionSource,
        group: dimensionGroup,
        tab: dimensionTab,
      });
    } catch {
      return bad(
        "Invalid request observation dimension",
        "request_observation_invalid_dimension",
        req,
      );
    }
    const result = await queryAnalyticsRows({
      apiUrl: analyticsApiUrl,
      accountId: config.accountId,
      token,
      sql,
    });
    if (!result.ok)
      return bad(
        cloudflareAnalyticsErrorMessage(result),
        "request_observation_query_failed",
        req,
      );
    let rows = normalizeNetworkDimensionRows(result.rows);
    if (dimensionTab === "region") {
      rows = rows.map((row) => ({ ...row, region: row.label }));
    }
    if (dimensionTab === "site") {
      const sites = await siteLookupByIds(
        env,
        rows.map((row) => row.label).filter(Boolean),
      );
      rows = rows.map((row) => {
        const site = sites.get(row.label);
        return {
          ...row,
          label: site?.name || site?.domain || row.label,
          iconLabel: site?.domain || undefined,
        };
      });
    }
    return jsonResponseFor(req, {
      ok: true,
      configured: true,
      generatedAt,
      sampling: analyticsEngineSamplingMeta({
        observedSampled: rowsContainObservedSampling(result.rows),
        aggregatesWeighted: true,
        detailsAreSampled: false,
        distinctAreApproximate: false,
      }),
      dimension: {
        group: dimensionGroup,
        tab: dimensionTab,
        source: dimensionSource,
        rows,
      },
    });
  }

  const sql = buildRequestAnalyticsSql({
    from,
    to,
    limit: limit + 1,
    source: "abnormal",
  });
  const result = await queryCloudflareAnalyticsEngine({
    apiUrl: analyticsApiUrl,
    accountId: config.accountId,
    token,
    sql,
  });
  if (!result.ok) {
    return bad(
      cloudflareAnalyticsErrorMessage(result),
      "request_observation_query_failed",
      req,
    );
  }

  const normalSql = buildRequestAnalyticsSql({
    from,
    to,
    limit: limit + 1,
    source: "normal",
  });
  const normalResult = await queryCloudflareAnalyticsEngine({
    apiUrl: analyticsApiUrl,
    accountId: config.accountId,
    token,
    sql: normalSql,
  });
  if (!normalResult.ok) {
    return bad(
      cloudflareAnalyticsErrorMessage(normalResult),
      "request_observation_query_failed",
      req,
    );
  }

  let rawRows: Record<string, unknown>[];
  try {
    rawRows = parseJsonEachRow(result.body);
  } catch {
    return bad(
      "Cloudflare Analytics Engine returned invalid JSONEachRow data",
      "request_observation_parse_failed",
      req,
    );
  }

  let normalRawRows: Record<string, unknown>[];
  try {
    normalRawRows = parseJsonEachRow(normalResult.body);
  } catch {
    return bad(
      "Cloudflare Analytics Engine returned invalid JSONEachRow data",
      "request_observation_parse_failed",
      req,
    );
  }

  const abnormalHasMore = rawRows.length > limit;
  const normalHasMore = normalRawRows.length > limit;
  rawRows = rawRows.slice(0, limit);
  normalRawRows = normalRawRows.slice(0, limit);

  const preliminaryEvents = rawRows.map((row) =>
    normalizeAbnormalRow(row, new Map()),
  );
  const preliminaryNormalEvents = normalRawRows.map((row) =>
    normalizeNormalRow(row, new Map()),
  );
  const sites = await siteLookup(env, [
    ...preliminaryEvents,
    ...preliminaryNormalEvents,
  ]);
  const events = rawRows.map((row) => normalizeAbnormalRow(row, sites));
  const normalEvents = normalRawRows.map((row) =>
    normalizeNormalRow(row, sites),
  );
  const abnormalNextCursor = abnormalHasMore
    ? detailCursorForEvent(events[events.length - 1])
    : null;
  const normalNextCursor = normalHasMore
    ? detailCursorForEvent(normalEvents[normalEvents.length - 1])
    : null;
  const abnormalTrendResult = await queryAnalyticsRows({
    apiUrl: analyticsApiUrl,
    accountId: config.accountId,
    token,
    sql: buildCountByBucketSql({
      from,
      to,
      bucketMs,
      interval,
      timeZone,
      source: "abnormal",
    }),
  });
  if (!abnormalTrendResult.ok) {
    return bad(
      cloudflareAnalyticsErrorMessage(abnormalTrendResult),
      "request_observation_query_failed",
      req,
    );
  }
  const normalTrendResult = await queryAnalyticsRows({
    apiUrl: analyticsApiUrl,
    accountId: config.accountId,
    token,
    sql: buildCountByBucketSql({
      from,
      to,
      bucketMs,
      interval,
      timeZone,
      source: "normal",
      includeLatency: true,
    }),
  });
  if (!normalTrendResult.ok) {
    return bad(
      cloudflareAnalyticsErrorMessage(normalTrendResult),
      "request_observation_query_failed",
      req,
    );
  }
  const abnormalMapResult = await queryAnalyticsRows({
    apiUrl: analyticsApiUrl,
    accountId: config.accountId,
    token,
    sql: buildMapPointsSql({
      from,
      to,
      source: "abnormal",
      limit: 500,
    }),
  });
  if (!abnormalMapResult.ok) {
    return bad(
      cloudflareAnalyticsErrorMessage(abnormalMapResult),
      "request_observation_query_failed",
      req,
    );
  }
  const normalMapResult = await queryAnalyticsRows({
    apiUrl: analyticsApiUrl,
    accountId: config.accountId,
    token,
    sql: buildMapPointsSql({
      from,
      to,
      source: "normal",
      limit: 500,
    }),
  });
  if (!normalMapResult.ok) {
    return bad(
      cloudflareAnalyticsErrorMessage(normalMapResult),
      "request_observation_query_failed",
      req,
    );
  }

  const normalSummaryPromise = queryAnalyticsRows({
    apiUrl: analyticsApiUrl,
    accountId: config.accountId,
    token,
    sql: buildSourceSummarySql({
      from,
      to,
      source: "normal",
      includeLatency: true,
    }),
  });
  const [abnormalSummaryResult, normalSummaryResult] = await Promise.all([
    queryAnalyticsRows({
      apiUrl: analyticsApiUrl,
      accountId: config.accountId,
      token,
      sql: buildSourceSummarySql({
        from,
        to,
        source: "abnormal",
      }),
    }),
    normalSummaryPromise,
  ]);
  if (!abnormalSummaryResult.ok) {
    return bad(
      cloudflareAnalyticsErrorMessage(abnormalSummaryResult),
      "request_observation_query_failed",
      req,
    );
  }
  if (!normalSummaryResult.ok) {
    return bad(
      cloudflareAnalyticsErrorMessage(normalSummaryResult),
      "request_observation_query_failed",
      req,
    );
  }
  const [reasonResult, asnResult] = await Promise.all([
    queryAnalyticsRows({
      apiUrl: analyticsApiUrl,
      accountId: config.accountId,
      token,
      sql: buildReasonSummarySql({
        from,
        to,
      }),
    }),
    queryAnalyticsRows({
      apiUrl: analyticsApiUrl,
      accountId: config.accountId,
      token,
      sql: buildAsnSummarySql({
        from,
        to,
      }),
    }),
  ]);
  if (!reasonResult.ok) {
    return bad(
      cloudflareAnalyticsErrorMessage(reasonResult),
      "request_observation_query_failed",
      req,
    );
  }
  if (!asnResult.ok) {
    return bad(
      cloudflareAnalyticsErrorMessage(asnResult),
      "request_observation_query_failed",
      req,
    );
  }
  const abnormalSummaryRow = abnormalSummaryResult.rows[0] ?? {};
  const normalSummaryRow = normalSummaryResult.rows[0] ?? {};
  const abnormalSummaryValues = {
    highThreat: Math.max(
      0,
      Math.trunc(toFiniteNumber(abnormalSummaryRow.highThreat)),
    ),
    mediumThreat: Math.max(
      0,
      Math.trunc(toFiniteNumber(abnormalSummaryRow.mediumThreat)),
    ),
    customBlocked: Math.max(
      0,
      Math.trunc(toFiniteNumber(abnormalSummaryRow.customBlocked)),
    ),
    affectedSites: Math.max(
      0,
      Math.trunc(toFiniteNumber(abnormalSummaryRow.affectedSites)),
    ),
    uniqueAsns: Math.max(
      0,
      Math.trunc(toFiniteNumber(abnormalSummaryRow.uniqueAsns)),
    ),
    uniqueCountries: Math.max(
      0,
      Math.trunc(toFiniteNumber(abnormalSummaryRow.uniqueCountries)),
    ),
  };
  const normalSummaryValues = {
    affectedSites: Math.max(
      0,
      Math.trunc(toFiniteNumber(normalSummaryRow.affectedSites)),
    ),
    uniqueAsns: Math.max(
      0,
      Math.trunc(toFiniteNumber(normalSummaryRow.uniqueAsns)),
    ),
    uniqueCountries: Math.max(
      0,
      Math.trunc(toFiniteNumber(normalSummaryRow.uniqueCountries)),
    ),
  };

  const networkDimensions: NetworkDimension[] = [
    "asOrganization",
    "asn",
    "country",
    "region",
    "city",
    "colo",
  ];
  const networkDimensionResults = await Promise.all(
    networkDimensions.flatMap((dimension) => [
      queryAnalyticsRows({
        apiUrl: analyticsApiUrl,
        accountId: config.accountId,
        token,
        sql: buildNetworkDimensionSql({
          from,
          to,
          source: "abnormal",
          dimension,
        }),
      }),
      queryAnalyticsRows({
        apiUrl: analyticsApiUrl,
        accountId: config.accountId,
        token,
        sql: buildNetworkDimensionSql({
          from,
          to,
          source: "normal",
          dimension,
        }),
      }),
    ]),
  );
  const failedNetworkDimensionResult = networkDimensionResults.find(
    (result) => !result.ok,
  );
  if (failedNetworkDimensionResult && !failedNetworkDimensionResult.ok) {
    return bad(
      cloudflareAnalyticsErrorMessage(failedNetworkDimensionResult),
      "request_observation_query_failed",
      req,
    );
  }
  const networkDimensionRows = networkDimensionResults.map((result) =>
    result.ok ? result.rows : [],
  );
  const abnormalNetworkDimensions = Object.fromEntries(
    networkDimensions.map((dimension, index) => [
      dimension,
      normalizeNetworkDimensionRows(networkDimensionRows[index * 2]),
    ]),
  );
  const normalNetworkDimensions = Object.fromEntries(
    networkDimensions.map((dimension, index) => [
      dimension,
      normalizeNetworkDimensionRows(networkDimensionRows[index * 2 + 1]),
    ]),
  );
  const aggregates = {
    reasons: normalizeReasonRows(reasonResult.rows),
    countries: abnormalNetworkDimensions.country.map((row) => ({
      country: row.label,
      count: row.count,
    })),
    asns: normalizeAsnRows(asnResult.rows),
  };

  const trendWithRatio = mergeTrendRows({
    from,
    to,
    bucketMs,
    interval,
    timeZone,
    abnormalRows: abnormalTrendResult.rows,
    normalRows: normalTrendResult.rows,
    normalEvents,
  });
  const botRequests = trendWithRatio.reduce(
    (sum, point) => sum + point.abnormalCount,
    0,
  );
  const normalRequests = trendWithRatio.reduce(
    (sum, point) => sum + point.normalCount,
    0,
  );
  const totalRequests = normalRequests + botRequests;
  const botRequestRatio = totalRequests > 0 ? botRequests / totalRequests : 0;
  const normalRequestRatio =
    totalRequests > 0 ? normalRequests / totalRequests : 0;
  const pageviews = trendWithRatio.reduce(
    (sum, point) => sum + point.pageviews,
    0,
  );
  const customEvents = trendWithRatio.reduce(
    (sum, point) => sum + point.customEvents,
    0,
  );
  const trendLatencyPoints = trendWithRatio.filter(
    (point) => point.latencySampleWeight > 0,
  );
  const trendLatencyTotals = trendLatencyPoints.reduce(
    (totals, point) => {
      totals.weightedSumMs += point.latencyWeightedSumMs;
      totals.sampleWeight += point.latencySampleWeight;
      return totals;
    },
    { sampleWeight: 0, weightedSumMs: 0 },
  );
  const latencySummary = normalizeLatencySummary(normalSummaryRow);
  const avgLatencyMs =
    latencySummary.avgLatencyMs ??
    (trendLatencyTotals.sampleWeight > 0
      ? trendLatencyTotals.weightedSumMs / trendLatencyTotals.sampleWeight
      : null);
  const p50LatencyMs = latencySummary.p50LatencyMs;
  const p75LatencyMs = latencySummary.p75LatencyMs;
  const p95LatencyMs = latencySummary.p95LatencyMs;
  const p99LatencyMs = latencySummary.p99LatencyMs;
  const normalListSummary = aggregateNormalEvents(normalEvents);
  const abnormalMapPoints = normalizeMapRows(abnormalMapResult.rows);
  const normalMapPoints = normalizeMapRows(normalMapResult.rows);
  const mapPoints = abnormalMapPoints;
  const observedSampled = [
    rawRows,
    normalRawRows,
    abnormalTrendResult.rows,
    normalTrendResult.rows,
    abnormalMapResult.rows,
    normalMapResult.rows,
    abnormalSummaryResult.rows,
    normalSummaryResult.rows,
    ...networkDimensionRows,
    reasonResult.rows,
    asnResult.rows,
  ].some(rowsContainObservedSampling);

  return jsonResponseFor(req, {
    ok: true,
    configured: true,
    generatedAt,
    window: {
      minutes,
      from,
      to,
      interval,
      timeZone,
    },
    config: redactAnalyticsEngineConfig(
      config,
      analyticsEngineAvailability(env),
    ),
    sampling: analyticsEngineSamplingMeta({
      observedSampled,
      aggregatesWeighted: true,
      detailsAreSampled: true,
      distinctAreApproximate: true,
    }),
    summary: {
      total: botRequests,
      baselineRequests: normalRequests,
      botRequestRatio,
      ...abnormalSummaryValues,
    },
    events: events.map(serializeAbnormalListEvent),
    normalEvents: normalEvents.map(serializeNormalListEvent),
    ...aggregates,
    mapPoints,
    trend: trendWithRatio,
    overview: {
      totalRequests,
      normalRequests,
      abnormalRequests: botRequests,
      abnormalRequestRatio: botRequestRatio,
      normalRequestRatio,
      pageviews,
      customEvents,
      avgLatencyMs,
      p50LatencyMs,
      p75LatencyMs,
      p95LatencyMs,
      p99LatencyMs,
    },
    abnormal: {
      summary: {
        total: botRequests,
        ratio: botRequestRatio,
        ...abnormalSummaryValues,
      },
      mapPoints: abnormalMapPoints,
      events: events.map(serializeAbnormalListEvent),
      hasMore: abnormalHasMore,
      nextCursor: abnormalNextCursor,
      reasons: aggregates.reasons,
      countries: aggregates.countries,
      asns: aggregates.asns,
      dimensions: {
        network: abnormalNetworkDimensions,
      },
    },
    normal: {
      summary: {
        ...normalListSummary,
        ...normalSummaryValues,
        total: normalRequests,
        ratio: normalRequestRatio,
        pageviews,
        customEvents,
        avgLatencyMs,
        p50LatencyMs,
        p75LatencyMs,
        p95LatencyMs,
        p99LatencyMs,
      },
      mapPoints: normalMapPoints,
      events: normalEvents.map(serializeNormalListEvent),
      hasMore: normalHasMore,
      nextCursor: normalNextCursor,
      dimensions: {
        network: normalNetworkDimensions,
      },
    },
  });
}
