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
  decodePageCursor,
  encodePageCursor,
  hasExactKeys,
  InvalidCursorError,
  paginationBinding,
} from "@/lib/pagination";

import type {
  RequestAnalyticsCategory,
  RequestAnalyticsDisposition,
} from "./analytics-engine/request-schema";
import {
  hasRequestFlag,
  REQUEST_ANALYTICS_CATEGORIES,
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
const REQUEST_CATEGORIES = REQUEST_ANALYTICS_CATEGORIES;
const DISPOSITION_BLOCKED_FLAG = REQUEST_ANALYTICS_FLAGS.dispositionBlocked;
const BLOCKED_DISPOSITION_SQL_FILTER = `intDiv(double19, ${DISPOSITION_BLOCKED_FLAG}) % 2 != 0`;
const INCLUDED_DISPOSITION_SQL_FILTER = `intDiv(double19, ${DISPOSITION_BLOCKED_FLAG}) % 2 = 0`;
const MAX_WORKER_LATENCY_MS = 60_000;
const REQUEST_LATENCY_SQL_FILTER = `double20 = ${REQUEST_ANALYTICS_SCHEMA_VERSION} AND intDiv(double19, ${REQUEST_ANALYTICS_FLAGS.edgeLatencyPresent}) % 2 != 0 AND double3 BETWEEN 0 AND ${MAX_WORKER_LATENCY_MS}`;

function analyticsEngineSqlEndpoint(env: Env): string | null {
  if (env.INSIGHTFLARE_E2E === "1") {
    const mockUrl = env.INSIGHTFLARE_E2E_CLOUDFLARE_API_URL?.trim();
    return mockUrl ? mockUrl.replace(/\/+$/, "") : null;
  }
  return CF_ANALYTICS_ENGINE_SQL_ENDPOINT;
}

type AdminActor = Awaited<ReturnType<typeof requireActor>>;
type RequestObservationCategory = RequestAnalyticsCategory;
type RequestObservationDisposition = RequestAnalyticsDisposition;
type RequestObservationInterval = "minute" | "hour" | "day" | "week";
type NetworkDimension =
  | "asOrganization"
  | "asn"
  | "country"
  | "region"
  | "city"
  | "colo";
type DetailSource = "blocked" | "included";
type DimensionGroup = "detection" | "target" | "network" | "client";

interface DetailCursor {
  timestamp: string;
  receivedAt: number;
  traceId: string;
  rayId: string;
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
const INCLUDED_TARGET_DIMENSION_TABS = [
  "category",
  ...DIMENSION_TABS.target,
] as const;
const EMPTY_DIMENSION_TABS: readonly string[] = [];
const DIMENSION_TABS_BY_SOURCE: Record<
  DetailSource,
  Record<DimensionGroup, readonly string[]>
> = {
  blocked: DIMENSION_TABS,
  included: {
    detection: EMPTY_DIMENSION_TABS,
    target: INCLUDED_TARGET_DIMENSION_TABS,
    network: DIMENSION_TABS.network,
    client: EMPTY_DIMENSION_TABS,
  },
};

function dimensionTabsFor(
  source: DetailSource,
  group: DimensionGroup,
): readonly string[] {
  return DIMENSION_TABS_BY_SOURCE[source][group];
}

interface RequestObservationEvent {
  timestamp: string;
  receivedAt: number;
  eventAt: number;
  edgeLatencyMs: number | null;
  schemaVersion: number;
  siteId: string;
  siteName: string;
  siteDomain: string;
  kind: string;
  category: RequestObservationCategory;
  disposition: RequestObservationDisposition;
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

function detailCursor(value: unknown): DetailCursor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    !hasExactKeys(candidate, ["timestamp", "receivedAt", "traceId", "rayId"])
  ) {
    return null;
  }
  const timestamp = clampString(String(candidate.timestamp || ""), 64);
  const traceId = clampString(String(candidate.traceId || ""), 128);
  const rayId = clampString(String(candidate.rayId || ""), 120);
  // Cloudflare's cf-ray header is not present in local, test, and some
  // upstream requests. traceId is generated at collection time and is the
  // stable identity needed by the final keyset tie-breaker.
  if (!timestamp || !traceId) return null;
  return {
    timestamp,
    receivedAt: Math.max(0, toFiniteNumber(candidate.receivedAt)),
    traceId,
    rayId,
  };
}

function requestObservationBinding(input: {
  from: number;
  to: number;
  interval: RequestObservationInterval;
  timeZone: string;
  source: DetailSource;
}): Promise<string> {
  return paginationBinding([
    "admin-request-observation-v1",
    "admin",
    input.source,
    input.from,
    input.to,
    input.interval,
    input.timeZone,
    "timestamp:desc,receivedAt:desc,traceId:desc,rayId:desc",
  ]);
}

function analyticsSqlString(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

function normalizeObservationCategory(
  value: unknown,
): RequestObservationCategory | null {
  const category = String(value || "");
  return (REQUEST_CATEGORIES as readonly string[]).includes(category)
    ? (category as RequestObservationCategory)
    : null;
}

function normalizeObservationDisposition(
  value: unknown,
  flags: number,
): RequestObservationDisposition {
  if (value === "blocked" || value === "included") return value;
  return requestAnalyticsFlagPresent(flags, DISPOSITION_BLOCKED_FLAG)
    ? "blocked"
    : "included";
}

function requestTimeFilter(input: { from: number; to: number }): string {
  return `timestamp >= toDateTime(${Math.floor(input.from / 1000)}) AND timestamp <= toDateTime(${Math.ceil(input.to / 1000)}) AND double20 = ${REQUEST_ANALYTICS_SCHEMA_VERSION}`;
}

function requestDispositionFilter(source: DetailSource): string {
  return source === "blocked"
    ? BLOCKED_DISPOSITION_SQL_FILTER
    : INCLUDED_DISPOSITION_SQL_FILTER;
}

function requestCursorFilter(cursor?: DetailCursor | null): string {
  if (!cursor) return "";
  return `AND (timestamp < toDateTime(${analyticsSqlString(cursor.timestamp)}) OR (timestamp = toDateTime(${analyticsSqlString(cursor.timestamp)}) AND (double1 < ${cursor.receivedAt} OR (double1 = ${cursor.receivedAt} AND (blob17 < ${analyticsSqlString(cursor.traceId)} OR (blob17 = ${analyticsSqlString(cursor.traceId)} AND blob16 < ${analyticsSqlString(cursor.rayId)}))))))`;
}

function requestRowSelect(): string {
  return `
      timestamp,
      _sample_interval AS sampleWeight,
      index1 AS siteId,
      blob1 AS kind,
      blob2 AS category,
      if(${BLOCKED_DISPOSITION_SQL_FILTER}, 'blocked', 'included') AS disposition,
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

function requestListSelect(source: DetailSource): string {
  const columns = [
    "timestamp",
    "_sample_interval AS sampleWeight",
    "index1 AS siteId",
    "blob1 AS kind",
    "blob2 AS category",
    `'${source}' AS disposition`,
    ...(source === "blocked"
      ? [
          "blob3 AS reasons",
          "blob4 AS ip",
          "blob5 AS userAgent",
          "blob15 AS verifiedBotCategory",
          "double7 AS botScore",
        ]
      : [
          "blob7 AS hostname",
          "blob13 AS colo",
          "blob18 AS requestMethod",
          "double3 AS edgeLatencyMs",
        ]),
    "blob8 AS pathname",
    "blob9 AS country",
    "blob10 AS region",
    "blob14 AS asOrganization",
    "blob16 AS rayId",
    "blob17 AS traceId",
    "double1 AS receivedAt",
    "double4 AS asn",
    "double19 AS flags",
    "double20 AS schemaVersion",
  ];
  return columns.join(",\n      ");
}

function buildRequestAnalyticsSql(input: {
  from: number;
  to: number;
  limit: number;
  source: DetailSource;
  cursor?: DetailCursor | null;
}) {
  return `
    SELECT ${requestListSelect(input.source)}
    FROM ${REQUEST_ANALYTICS_DATASET}
    WHERE ${requestTimeFilter(input)}
      AND ${requestDispositionFilter(input.source)}
      ${requestCursorFilter(input.cursor)}
    ORDER BY timestamp DESC, receivedAt DESC, traceId DESC, rayId DESC
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
  source: DetailSource;
  includeLatency?: boolean;
}) {
  const fromSeconds = Math.floor(input.from / 1000);
  const toSeconds = Math.ceil(input.to / 1000);
  const bucketSeconds = Math.max(60, Math.floor(input.bucketMs / 1000));
  const bucketOffsetSeconds =
    timeZoneOffsetMinutes(input.timeZone, input.from) * 60 +
    (input.interval === "week" ? 3 * 24 * 60 * 60 : 0);
  const bucketExpression = `(intDiv(toUnixTimestamp(timestamp) + ${bucketOffsetSeconds}, ${bucketSeconds}) * ${bucketSeconds} - ${bucketOffsetSeconds}) * 1000`;
  const latencySelect = input.includeLatency
    ? `,
      sumIf(_sample_interval * double3, ${REQUEST_LATENCY_SQL_FILTER}) AS latencyWeightedSumMs,
      sumIf(_sample_interval, ${REQUEST_LATENCY_SQL_FILTER}) AS latencySampleWeight,
      quantileExactWeighted(0.5)(double3, if(${REQUEST_LATENCY_SQL_FILTER}, _sample_interval, 0)) AS p50LatencyMs,
      quantileExactWeighted(0.75)(double3, if(${REQUEST_LATENCY_SQL_FILTER}, _sample_interval, 0)) AS p75LatencyMs,
      quantileExactWeighted(0.95)(double3, if(${REQUEST_LATENCY_SQL_FILTER}, _sample_interval, 0)) AS p95LatencyMs,
      quantileExactWeighted(0.99)(double3, if(${REQUEST_LATENCY_SQL_FILTER}, _sample_interval, 0)) AS p99LatencyMs`
    : "";
  const categorySelect = `,
      sumIf(_sample_interval, blob2 = 'normal') AS normalCount,
      sumIf(_sample_interval, blob2 = 'suspected_bot') AS suspectedBotCount,
      sumIf(_sample_interval, blob2 = 'bot') AS botCount,
      sumIf(_sample_interval, blob2 = 'custom_block') AS customBlockedCount,
      sumIf(_sample_interval, ${INCLUDED_DISPOSITION_SQL_FILTER}) AS includedCount,
      sumIf(_sample_interval, ${BLOCKED_DISPOSITION_SQL_FILTER}) AS blockedCount`;
  const businessEventSelect = `
      sumIf(_sample_interval, blob1 = 'pageview') AS pageviewCount,
      sumIf(_sample_interval, blob1 = 'leave') AS leaveCount,
      sumIf(_sample_interval, blob1 = 'visibility') AS visibilityCount,
      sumIf(_sample_interval, blob1 = 'custom_event') AS customEventCount,
      sumIf(_sample_interval, blob1 = 'identify') AS identifyCount,
      sumIf(_sample_interval, blob1 = 'pageview') AS pageviews,
      sumIf(_sample_interval, blob1 = 'custom_event') AS customEvents`;
  return `
    SELECT
      ${bucketExpression} AS timestampMs,
      max(_sample_interval) AS maxSampleInterval,
      sum(_sample_interval) AS weightedRequestCount,
      sum(_sample_interval) AS count,
      ${businessEventSelect}${categorySelect}${latencySelect}
    FROM ${REQUEST_ANALYTICS_DATASET}
    WHERE timestamp >= toDateTime(${fromSeconds})
      AND timestamp <= toDateTime(${toSeconds})
      AND double20 = ${REQUEST_ANALYTICS_SCHEMA_VERSION}
      AND ${requestDispositionFilter(input.source)}
    GROUP BY timestampMs
    ORDER BY timestampMs ASC
    FORMAT JSONEachRow
  `;
}

function buildMapPointsSql(input: {
  from: number;
  to: number;
  source: DetailSource;
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
      AND ${requestDispositionFilter(input.source)}
    GROUP BY double5, double6, blob9
    ORDER BY pointCount DESC
    LIMIT ${input.limit}
    FORMAT JSONEachRow
  `;
}

function buildNetworkDimensionSql(input: {
  from: number;
  to: number;
  source: DetailSource;
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
  const botSelect = `,\n      sumIf(_sample_interval, blob2 = 'bot') AS botCount`;
  return `
    SELECT
      ${groupColumns.join(",\n      ")},
      max(_sample_interval) AS maxSampleInterval,
      sum(_sample_interval) AS count${botSelect}
    FROM ${REQUEST_ANALYTICS_DATASET}
    WHERE timestamp >= toDateTime(${fromSeconds})
      AND timestamp <= toDateTime(${toSeconds})
      AND double20 = ${REQUEST_ANALYTICS_SCHEMA_VERSION}
      AND ${requestDispositionFilter(input.source)}
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
  const columns = `
      sumIf(_sample_interval, blob2 = 'normal') AS normalRequests,
      sumIf(_sample_interval, blob2 = 'suspected_bot') AS suspectedBotRequests,
      sumIf(_sample_interval, blob2 = 'bot') AS botRequests,
      sumIf(_sample_interval, blob2 = 'custom_block') AS customBlockedRequests,
      sumIf(_sample_interval, ${INCLUDED_DISPOSITION_SQL_FILTER}) AS includedRequests,
      sumIf(_sample_interval, ${BLOCKED_DISPOSITION_SQL_FILTER}) AS blockedRequests,
      sumIf(_sample_interval, blob1 = 'pageview') AS pageviews,
      sumIf(_sample_interval, blob1 = 'custom_event') AS customEvents,
      count(DISTINCT index1) AS affectedSites,
      count(DISTINCT double4) AS uniqueAsns,
      count(DISTINCT blob9) AS uniqueCountries`;
  const latencyColumns =
    input.includeLatency !== false
      ? `,
      sumIf(_sample_interval * double3, ${REQUEST_LATENCY_SQL_FILTER}) AS latencyWeightedSumMs,
      sumIf(_sample_interval, ${REQUEST_LATENCY_SQL_FILTER}) AS latencySampleWeight,
      quantileExactWeighted(0.5)(double3, if(${REQUEST_LATENCY_SQL_FILTER}, _sample_interval, 0)) AS p50LatencyMs,
      quantileExactWeighted(0.75)(double3, if(${REQUEST_LATENCY_SQL_FILTER}, _sample_interval, 0)) AS p75LatencyMs,
      quantileExactWeighted(0.95)(double3, if(${REQUEST_LATENCY_SQL_FILTER}, _sample_interval, 0)) AS p95LatencyMs,
      quantileExactWeighted(0.99)(double3, if(${REQUEST_LATENCY_SQL_FILTER}, _sample_interval, 0)) AS p99LatencyMs`
      : "";
  return `
    SELECT
      sum(_sample_interval) AS total,
      max(_sample_interval) AS maxSampleInterval,${columns}${latencyColumns}
    FROM ${REQUEST_ANALYTICS_DATASET}
    WHERE timestamp >= toDateTime(${fromSeconds})
      AND timestamp <= toDateTime(${toSeconds})
      AND double20 = ${REQUEST_ANALYTICS_SCHEMA_VERSION}
      AND ${requestDispositionFilter(input.source)}
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
  const blocked = input.source === "blocked";
  const fields: Record<string, string[]> = blocked
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
        category: ["blob2 AS label"],
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
  if (
    !columns ||
    !dimensionTabsFor(input.source, input.group).includes(input.tab)
  )
    throw new Error("Invalid analytics dimension");
  const groupBy = columns.map((column) => column.split(" AS ")[1]).join(", ");
  return `SELECT ${columns.join(", ")}, max(_sample_interval) AS maxSampleInterval, sum(_sample_interval) AS count, sumIf(_sample_interval, blob2 = 'bot') AS botCount FROM ${REQUEST_ANALYTICS_DATASET} WHERE timestamp >= toDateTime(${fromSeconds}) AND timestamp <= toDateTime(${toSeconds}) AND double20 = ${REQUEST_ANALYTICS_SCHEMA_VERSION} AND ${requestDispositionFilter(input.source)} GROUP BY ${groupBy} ORDER BY count DESC LIMIT 30 FORMAT JSONEachRow`;
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
      AND ${requestDispositionFilter("blocked")}
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
      sumIf(_sample_interval, blob2 = 'bot') AS botCount
    FROM ${REQUEST_ANALYTICS_DATASET}
    WHERE timestamp >= toDateTime(${fromSeconds})
      AND timestamp <= toDateTime(${toSeconds})
      AND double20 = ${REQUEST_ANALYTICS_SCHEMA_VERSION}
      AND ${requestDispositionFilter("blocked")}
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
  const emptySummary = {
    total: 0,
    normalRequests: 0,
    suspectedBotRequests: 0,
    botRequests: 0,
    customBlockedRequests: 0,
    includedRequests: 0,
    blockedRequests: 0,
    affectedSites: 0,
    uniqueAsns: 0,
    uniqueCountries: 0,
  };
  const emptyPartition = {
    summary: {
      ...emptySummary,
      ratio: 0,
      pageviews: 0,
      customEvents: 0,
      avgLatencyMs: null,
      p50LatencyMs: null,
      p75LatencyMs: null,
      p95LatencyMs: null,
      p99LatencyMs: null,
    },
    mapPoints: [],
    events: [],
    pagination: {
      limit: DETAIL_PAGE_SIZE,
      returned: 0,
      hasMore: false,
      nextCursor: null,
    },
    dimensions: { network: {} },
  };
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
    summary: emptySummary,
    mapPoints: [],
    trend: [],
    reasons: [],
    countries: [],
    asns: [],
    overview: {
      totalRequests: 0,
      includedRequests: 0,
      blockedRequests: 0,
      normalRequests: 0,
      suspectedBotRequests: 0,
      botRequests: 0,
      customBlockedRequests: 0,
      botRequestRatio: 0,
      blockedRequestRatio: 0,
      normalRequestRatio: 0,
      pageviews: 0,
      customEvents: 0,
      avgLatencyMs: null,
      p50LatencyMs: null,
      p75LatencyMs: null,
      p95LatencyMs: null,
      p99LatencyMs: null,
    },
    blocked: emptyPartition,
    included: emptyPartition,
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

function requestAnalyticsFlagPresent(value: unknown, flag: number): boolean {
  return hasRequestFlag(
    Math.trunc(toFiniteNumber(value)),
    flag as (typeof REQUEST_ANALYTICS_FLAGS)[keyof typeof REQUEST_ANALYTICS_FLAGS],
  );
}

function normalizeRequestRow(
  row: Record<string, unknown>,
  sites: Map<string, { name: string; domain: string }>,
  fallbackCategory: RequestObservationCategory = "normal",
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
  const eventAt = toFiniteNumber(row.eventAt);
  const schemaVersion = Math.trunc(toFiniteNumber(row.schemaVersion));
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
    category: normalizeObservationCategory(row.category) ?? fallbackCategory,
    disposition: normalizeObservationDisposition(row.disposition, flags),
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

function serializeListEvent(
  event: RequestObservationEvent,
  source: DetailSource,
) {
  const shared = {
    timestamp: event.timestamp,
    receivedAt: event.receivedAt,
    siteId: event.siteId,
    siteName: event.siteName,
    siteDomain: event.siteDomain,
    kind: event.kind,
    category: event.category,
    disposition: event.disposition,
    pathname: event.pathname,
    country: event.country,
    region: event.region,
    asOrganization: event.asOrganization,
    asn: event.asn,
    rayId: event.rayId,
    traceId: event.traceId,
  };
  if (source === "blocked") {
    return {
      ...shared,
      reasons: event.reasons,
      ip: event.ip,
      userAgent: event.userAgent,
      verifiedBotCategory: event.verifiedBotCategory,
      botScore: event.botScore,
    };
  }
  return {
    ...shared,
    hostname: event.hostname,
    colo: event.colo,
    requestMethod: event.requestMethod,
    edgeLatencyMs: event.edgeLatencyMs,
  };
}

function detailCursorForEvent(event: RequestObservationEvent): DetailCursor {
  return {
    timestamp: event.timestamp,
    receivedAt: event.receivedAt,
    traceId: event.traceId,
    rayId: event.rayId,
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

async function siteLookup(env: Env, events: RequestObservationEvent[]) {
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
      botCount: Math.max(0, Math.trunc(toFiniteNumber(row.botCount))),
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
    { asn: number; asOrganization: string; count: number; botCount: number }
  >();
  for (const row of rows) {
    const asn = Math.trunc(toFiniteNumber(row.asn ?? row.label));
    if (asn <= 0) continue;
    const current = asns.get(asn) ?? {
      asn,
      asOrganization: "",
      count: 0,
      botCount: 0,
    };
    current.count += Math.max(0, toFiniteNumber(row.count));
    current.botCount += Math.max(0, toFiniteNumber(row.botCount));
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
    .map((row) => ({
      ...row,
      count: Math.max(0, Math.trunc(row.count)),
      botCount: Math.max(0, Math.trunc(row.botCount)),
    }));
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
  blockedRows: Record<string, unknown>[];
  includedRows: Record<string, unknown>[];
}) {
  const trend = new Map<
    number,
    {
      timestampMs: number;
      count: number;
      normalCount: number;
      suspectedBotCount: number;
      botCount: number;
      customBlockedCount: number;
      includedCount: number;
      blockedCount: number;
      totalCount: number;
      botRatio: number;
      blockedRatio: number;
      normalRatio: number;
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
      normalCount: 0,
      suspectedBotCount: 0,
      botCount: 0,
      customBlockedCount: 0,
      includedCount: 0,
      blockedCount: 0,
      totalCount: 0,
      botRatio: 0,
      blockedRatio: 0,
      normalRatio: 0,
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
  const addRows = (rows: Record<string, unknown>[], source: DetailSource) => {
    for (const row of rows) {
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
      const categoryCounts = {
        normalCount: Math.max(0, toFiniteNumber(row.normalCount)),
        suspectedBotCount: Math.max(0, toFiniteNumber(row.suspectedBotCount)),
        botCount: Math.max(0, toFiniteNumber(row.botCount)),
        customBlockedCount: Math.max(0, toFiniteNumber(row.customBlockedCount)),
      };
      const categoryTotal = Object.values(categoryCounts).reduce(
        (sum, value) => sum + value,
        0,
      );
      current.normalCount += categoryCounts.normalCount;
      current.suspectedBotCount += categoryCounts.suspectedBotCount;
      current.botCount += categoryCounts.botCount;
      current.customBlockedCount += categoryCounts.customBlockedCount;
      const includedCount = Math.max(
        0,
        toFiniteNumber(
          row.includedCount,
          source === "included" ? weightedRequestCount : 0,
        ),
      );
      const blockedCount = Math.max(
        0,
        toFiniteNumber(
          row.blockedCount,
          source === "blocked" ? weightedRequestCount : 0,
        ),
      );
      current.includedCount += includedCount;
      current.blockedCount += blockedCount;
      if (categoryTotal === 0 && weightedRequestCount > 0) {
        if (source === "included")
          current.includedCount += weightedRequestCount - includedCount;
        else current.blockedCount += weightedRequestCount - blockedCount;
      }
      current.weightedRequestCount += weightedRequestCount;
      current.pageviews += Math.max(0, toFiniteNumber(row.pageviews));
      current.customEvents += Math.max(0, toFiniteNumber(row.customEvents));
      current.pageviewCount += Math.max(0, toFiniteNumber(row.pageviewCount));
      current.leaveCount += Math.max(0, toFiniteNumber(row.leaveCount));
      current.visibilityCount += Math.max(
        0,
        toFiniteNumber(row.visibilityCount),
      );
      current.customEventCount += Math.max(
        0,
        toFiniteNumber(row.customEventCount),
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
        current.latencyWeightedSumMs += latencyWeightedSumMs;
        current.latencySampleWeight += latencySampleWeight;
        current.p50LatencyMs = toFiniteNumber(
          row.p50LatencyMs,
          current.p50LatencyMs ?? Number.NaN,
        );
        current.p75LatencyMs = toFiniteNumber(
          row.p75LatencyMs,
          current.p75LatencyMs ?? Number.NaN,
        );
        current.p95LatencyMs = toFiniteNumber(
          row.p95LatencyMs,
          current.p95LatencyMs ?? Number.NaN,
        );
        current.p99LatencyMs = toFiniteNumber(
          row.p99LatencyMs,
          current.p99LatencyMs ?? Number.NaN,
        );
      }
    }
  };
  addRows(input.blockedRows, "blocked");
  addRows(input.includedRows, "included");
  return [...trend.values()].map((point) => {
    const totalCount = point.includedCount + point.blockedCount;
    point.count = totalCount;
    point.totalCount = totalCount;
    point.avgLatencyMs =
      point.latencySampleWeight > 0
        ? point.latencyWeightedSumMs / point.latencySampleWeight
        : null;
    return {
      ...point,
      botRatio: totalCount > 0 ? point.botCount / totalCount : 0,
      blockedRatio: totalCount > 0 ? point.blockedCount / totalCount : 0,
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
      normalizeRequestRow(row, new Map()),
    );
    const sites = await siteLookup(env, preliminaryEvents);
    const detail = detailRows[0]
      ? normalizeRequestRow(detailRows[0], sites)
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

  const pageSource = url.searchParams.get("source");
  if (pageSource === "blocked" || pageSource === "included") {
    const source: DetailSource = pageSource;
    const pageLimit = parseLimit(url);
    const binding = await requestObservationBinding({
      from,
      to,
      interval,
      timeZone,
      source,
    });
    let cursor: DetailCursor | null = null;
    try {
      cursor = await decodePageCursor(
        env,
        binding,
        url.searchParams.get("cursor"),
        "request-observation",
        detailCursor,
      );
    } catch (error) {
      if (error instanceof InvalidCursorError) {
        return bad(
          "Invalid request observation page cursor",
          "request_observation_invalid_cursor",
          req,
        );
      }
      throw error;
    }
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
      normalizeRequestRow(row, new Map()),
    );
    const sites = await siteLookup(env, preliminaryEvents);
    const events = rows.map((row) =>
      serializeListEvent(normalizeRequestRow(row, sites), source),
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
      source,
      data: {
        items: events,
        pagination: {
          limit: pageLimit,
          returned: events.length,
          hasMore,
          nextCursor:
            hasMore && lastEvent
              ? await encodePageCursor(
                  env,
                  binding,
                  detailCursorForEvent(lastEvent),
                )
              : null,
        },
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
    (dimensionSource === "blocked" || dimensionSource === "included")
  ) {
    const dimensionTabs = dimensionTabsFor(dimensionSource, dimensionGroup);
    if (!dimensionTabs?.includes(dimensionTab)) {
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
    source: "blocked",
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

  const includedSql = buildRequestAnalyticsSql({
    from,
    to,
    limit: limit + 1,
    source: "included",
  });
  const includedResult = await queryCloudflareAnalyticsEngine({
    apiUrl: analyticsApiUrl,
    accountId: config.accountId,
    token,
    sql: includedSql,
  });
  if (!includedResult.ok) {
    return bad(
      cloudflareAnalyticsErrorMessage(includedResult),
      "request_observation_query_failed",
      req,
    );
  }

  let blockedRawRows: Record<string, unknown>[];
  try {
    blockedRawRows = parseJsonEachRow(result.body);
  } catch {
    return bad(
      "Cloudflare Analytics Engine returned invalid JSONEachRow data",
      "request_observation_parse_failed",
      req,
    );
  }

  let includedRawRows: Record<string, unknown>[];
  try {
    includedRawRows = parseJsonEachRow(includedResult.body);
  } catch {
    return bad(
      "Cloudflare Analytics Engine returned invalid JSONEachRow data",
      "request_observation_parse_failed",
      req,
    );
  }

  const blockedHasMore = blockedRawRows.length > limit;
  const includedHasMore = includedRawRows.length > limit;
  blockedRawRows = blockedRawRows.slice(0, limit);
  includedRawRows = includedRawRows.slice(0, limit);

  const preliminaryBlockedEvents = blockedRawRows.map((row) =>
    normalizeRequestRow(row, new Map()),
  );
  const preliminaryIncludedEvents = includedRawRows.map((row) =>
    normalizeRequestRow(row, new Map()),
  );
  const sites = await siteLookup(env, [
    ...preliminaryBlockedEvents,
    ...preliminaryIncludedEvents,
  ]);
  const blockedEvents = blockedRawRows.map((row) =>
    normalizeRequestRow(row, sites),
  );
  const includedEvents = includedRawRows.map((row) =>
    normalizeRequestRow(row, sites),
  );
  const blockedBinding = await requestObservationBinding({
    from,
    to,
    interval,
    timeZone,
    source: "blocked",
  });
  const includedBinding = await requestObservationBinding({
    from,
    to,
    interval,
    timeZone,
    source: "included",
  });
  const blockedNextCursor = blockedHasMore
    ? await encodePageCursor(
        env,
        blockedBinding,
        detailCursorForEvent(blockedEvents[blockedEvents.length - 1]!),
      )
    : null;
  const includedNextCursor = includedHasMore
    ? await encodePageCursor(
        env,
        includedBinding,
        detailCursorForEvent(includedEvents[includedEvents.length - 1]!),
      )
    : null;
  const blockedTrendResult = await queryAnalyticsRows({
    apiUrl: analyticsApiUrl,
    accountId: config.accountId,
    token,
    sql: buildCountByBucketSql({
      from,
      to,
      bucketMs,
      interval,
      timeZone,
      source: "blocked",
    }),
  });
  if (!blockedTrendResult.ok) {
    return bad(
      cloudflareAnalyticsErrorMessage(blockedTrendResult),
      "request_observation_query_failed",
      req,
    );
  }
  const includedTrendResult = await queryAnalyticsRows({
    apiUrl: analyticsApiUrl,
    accountId: config.accountId,
    token,
    sql: buildCountByBucketSql({
      from,
      to,
      bucketMs,
      interval,
      timeZone,
      source: "included",
      includeLatency: true,
    }),
  });
  if (!includedTrendResult.ok) {
    return bad(
      cloudflareAnalyticsErrorMessage(includedTrendResult),
      "request_observation_query_failed",
      req,
    );
  }
  const blockedMapResult = await queryAnalyticsRows({
    apiUrl: analyticsApiUrl,
    accountId: config.accountId,
    token,
    sql: buildMapPointsSql({
      from,
      to,
      source: "blocked",
      limit: 500,
    }),
  });
  if (!blockedMapResult.ok) {
    return bad(
      cloudflareAnalyticsErrorMessage(blockedMapResult),
      "request_observation_query_failed",
      req,
    );
  }
  const includedMapResult = await queryAnalyticsRows({
    apiUrl: analyticsApiUrl,
    accountId: config.accountId,
    token,
    sql: buildMapPointsSql({
      from,
      to,
      source: "included",
      limit: 500,
    }),
  });
  if (!includedMapResult.ok) {
    return bad(
      cloudflareAnalyticsErrorMessage(includedMapResult),
      "request_observation_query_failed",
      req,
    );
  }

  const includedSummaryPromise = queryAnalyticsRows({
    apiUrl: analyticsApiUrl,
    accountId: config.accountId,
    token,
    sql: buildSourceSummarySql({
      from,
      to,
      source: "included",
      includeLatency: true,
    }),
  });
  const [blockedSummaryResult, includedSummaryResult] = await Promise.all([
    queryAnalyticsRows({
      apiUrl: analyticsApiUrl,
      accountId: config.accountId,
      token,
      sql: buildSourceSummarySql({
        from,
        to,
        source: "blocked",
      }),
    }),
    includedSummaryPromise,
  ]);
  if (!blockedSummaryResult.ok) {
    return bad(
      cloudflareAnalyticsErrorMessage(blockedSummaryResult),
      "request_observation_query_failed",
      req,
    );
  }
  if (!includedSummaryResult.ok) {
    return bad(
      cloudflareAnalyticsErrorMessage(includedSummaryResult),
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
  const blockedSummaryRow = blockedSummaryResult.rows[0] ?? {};
  const includedSummaryRow = includedSummaryResult.rows[0] ?? {};
  const weightedSummaryValue = (row: Record<string, unknown>, key: string) =>
    Math.max(0, toFiniteNumber(row[key]));
  const distinctSummaryValue = (row: Record<string, unknown>, key: string) =>
    Math.max(0, Math.trunc(toFiniteNumber(row[key])));
  const blockedSummaryValues = {
    total: weightedSummaryValue(blockedSummaryRow, "total"),
    normalRequests: weightedSummaryValue(blockedSummaryRow, "normalRequests"),
    suspectedBotRequests: weightedSummaryValue(
      blockedSummaryRow,
      "suspectedBotRequests",
    ),
    botRequests: weightedSummaryValue(blockedSummaryRow, "botRequests"),
    customBlockedRequests: weightedSummaryValue(
      blockedSummaryRow,
      "customBlockedRequests",
    ),
    includedRequests: weightedSummaryValue(
      blockedSummaryRow,
      "includedRequests",
    ),
    blockedRequests: weightedSummaryValue(blockedSummaryRow, "blockedRequests"),
    pageviews: weightedSummaryValue(blockedSummaryRow, "pageviews"),
    customEvents: weightedSummaryValue(blockedSummaryRow, "customEvents"),
    affectedSites: distinctSummaryValue(blockedSummaryRow, "affectedSites"),
    uniqueAsns: distinctSummaryValue(blockedSummaryRow, "uniqueAsns"),
    uniqueCountries: distinctSummaryValue(blockedSummaryRow, "uniqueCountries"),
  };
  const includedSummaryValues = {
    total: weightedSummaryValue(includedSummaryRow, "total"),
    normalRequests: weightedSummaryValue(includedSummaryRow, "normalRequests"),
    suspectedBotRequests: weightedSummaryValue(
      includedSummaryRow,
      "suspectedBotRequests",
    ),
    botRequests: weightedSummaryValue(includedSummaryRow, "botRequests"),
    customBlockedRequests: weightedSummaryValue(
      includedSummaryRow,
      "customBlockedRequests",
    ),
    includedRequests: weightedSummaryValue(
      includedSummaryRow,
      "includedRequests",
    ),
    blockedRequests: weightedSummaryValue(
      includedSummaryRow,
      "blockedRequests",
    ),
    pageviews: weightedSummaryValue(includedSummaryRow, "pageviews"),
    customEvents: weightedSummaryValue(includedSummaryRow, "customEvents"),
    affectedSites: distinctSummaryValue(includedSummaryRow, "affectedSites"),
    uniqueAsns: distinctSummaryValue(includedSummaryRow, "uniqueAsns"),
    uniqueCountries: distinctSummaryValue(
      includedSummaryRow,
      "uniqueCountries",
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
          source: "blocked",
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
          source: "included",
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
  const blockedNetworkDimensions = Object.fromEntries(
    networkDimensions.map((dimension, index) => [
      dimension,
      normalizeNetworkDimensionRows(networkDimensionRows[index * 2]),
    ]),
  );
  const includedNetworkDimensions = Object.fromEntries(
    networkDimensions.map((dimension, index) => [
      dimension,
      normalizeNetworkDimensionRows(networkDimensionRows[index * 2 + 1]),
    ]),
  );
  const aggregates = {
    reasons: normalizeReasonRows(reasonResult.rows),
    countries: blockedNetworkDimensions.country.map((row) => ({
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
    blockedRows: blockedTrendResult.rows,
    includedRows: includedTrendResult.rows,
  });
  const includedRequests = includedSummaryValues.total;
  const blockedRequests = blockedSummaryValues.total;
  const totalRequests = includedRequests + blockedRequests;
  const normalRequests =
    includedSummaryValues.normalRequests + blockedSummaryValues.normalRequests;
  const suspectedBotRequests =
    includedSummaryValues.suspectedBotRequests +
    blockedSummaryValues.suspectedBotRequests;
  const botRequests =
    includedSummaryValues.botRequests + blockedSummaryValues.botRequests;
  const customBlockedRequests =
    includedSummaryValues.customBlockedRequests +
    blockedSummaryValues.customBlockedRequests;
  const botRequestRatio = totalRequests > 0 ? botRequests / totalRequests : 0;
  const blockedRequestRatio =
    totalRequests > 0 ? blockedRequests / totalRequests : 0;
  const normalRequestRatio =
    totalRequests > 0 ? normalRequests / totalRequests : 0;
  const pageviews =
    includedSummaryValues.pageviews + blockedSummaryValues.pageviews;
  const customEvents =
    includedSummaryValues.customEvents + blockedSummaryValues.customEvents;
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
  const blockedLatencySummary = normalizeLatencySummary(blockedSummaryRow);
  const includedLatencySummary = normalizeLatencySummary(includedSummaryRow);
  const blockedLatencySum = toFiniteNumber(
    blockedSummaryRow.latencyWeightedSumMs,
    Number.NaN,
  );
  const includedLatencySum = toFiniteNumber(
    includedSummaryRow.latencyWeightedSumMs,
    Number.NaN,
  );
  const blockedLatencyWeight = toFiniteNumber(
    blockedSummaryRow.latencySampleWeight,
    Number.NaN,
  );
  const includedLatencyWeight = toFiniteNumber(
    includedSummaryRow.latencySampleWeight,
    Number.NaN,
  );
  const summaryLatencyWeight =
    (Number.isFinite(blockedLatencyWeight) ? blockedLatencyWeight : 0) +
    (Number.isFinite(includedLatencyWeight) ? includedLatencyWeight : 0);
  const summaryLatencySum =
    (Number.isFinite(blockedLatencySum) ? blockedLatencySum : 0) +
    (Number.isFinite(includedLatencySum) ? includedLatencySum : 0);
  const avgLatencyMs =
    summaryLatencyWeight > 0
      ? summaryLatencySum / summaryLatencyWeight
      : trendLatencyTotals.sampleWeight > 0
        ? trendLatencyTotals.weightedSumMs / trendLatencyTotals.sampleWeight
        : null;
  const p50LatencyMs =
    includedLatencySummary.p50LatencyMs ?? blockedLatencySummary.p50LatencyMs;
  const p75LatencyMs =
    includedLatencySummary.p75LatencyMs ?? blockedLatencySummary.p75LatencyMs;
  const p95LatencyMs =
    includedLatencySummary.p95LatencyMs ?? blockedLatencySummary.p95LatencyMs;
  const p99LatencyMs =
    includedLatencySummary.p99LatencyMs ?? blockedLatencySummary.p99LatencyMs;
  const blockedMapPoints = normalizeMapRows(blockedMapResult.rows);
  const includedMapPoints = normalizeMapRows(includedMapResult.rows);
  const mapPoints = blockedMapPoints;
  const observedSampled = [
    blockedRawRows,
    includedRawRows,
    blockedTrendResult.rows,
    includedTrendResult.rows,
    blockedMapResult.rows,
    includedMapResult.rows,
    blockedSummaryResult.rows,
    includedSummaryResult.rows,
    ...networkDimensionRows,
    reasonResult.rows,
    asnResult.rows,
  ].some(rowsContainObservedSampling);

  const blockedPartitionSummary = {
    ...blockedSummaryValues,
    ratio: blockedRequestRatio,
    avgLatencyMs: blockedLatencySummary.avgLatencyMs,
    p50LatencyMs: blockedLatencySummary.p50LatencyMs,
    p75LatencyMs: blockedLatencySummary.p75LatencyMs,
    p95LatencyMs: blockedLatencySummary.p95LatencyMs,
    p99LatencyMs: blockedLatencySummary.p99LatencyMs,
  };
  const includedPartitionSummary = {
    ...includedSummaryValues,
    ratio: totalRequests > 0 ? includedRequests / totalRequests : 0,
    avgLatencyMs: includedLatencySummary.avgLatencyMs,
    p50LatencyMs: includedLatencySummary.p50LatencyMs,
    p75LatencyMs: includedLatencySummary.p75LatencyMs,
    p95LatencyMs: includedLatencySummary.p95LatencyMs,
    p99LatencyMs: includedLatencySummary.p99LatencyMs,
  };

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
      total: totalRequests,
      normalRequests,
      suspectedBotRequests,
      botRequests,
      customBlockedRequests,
      includedRequests,
      blockedRequests,
      affectedSites:
        blockedSummaryValues.affectedSites +
        includedSummaryValues.affectedSites,
      uniqueAsns:
        blockedSummaryValues.uniqueAsns + includedSummaryValues.uniqueAsns,
      uniqueCountries:
        blockedSummaryValues.uniqueCountries +
        includedSummaryValues.uniqueCountries,
    },
    events: blockedEvents.map((event) => serializeListEvent(event, "blocked")),
    normalEvents: includedEvents.map((event) =>
      serializeListEvent(event, "included"),
    ),
    blockedEvents: blockedEvents.map((event) =>
      serializeListEvent(event, "blocked"),
    ),
    includedEvents: includedEvents.map((event) =>
      serializeListEvent(event, "included"),
    ),
    ...aggregates,
    mapPoints,
    trend: trendWithRatio,
    overview: {
      totalRequests,
      includedRequests,
      blockedRequests,
      normalRequests,
      suspectedBotRequests,
      botRequests,
      customBlockedRequests,
      botRequestRatio,
      blockedRequestRatio,
      normalRequestRatio,
      pageviews,
      customEvents,
      avgLatencyMs,
      p50LatencyMs,
      p75LatencyMs,
      p95LatencyMs,
      p99LatencyMs,
    },
    blocked: {
      summary: blockedPartitionSummary,
      mapPoints: blockedMapPoints,
      events: blockedEvents.map((event) =>
        serializeListEvent(event, "blocked"),
      ),
      pagination: {
        limit,
        returned: blockedEvents.length,
        hasMore: blockedHasMore,
        nextCursor: blockedNextCursor,
      },
      reasons: aggregates.reasons,
      countries: aggregates.countries,
      asns: aggregates.asns,
      dimensions: {
        network: blockedNetworkDimensions,
      },
    },
    included: {
      summary: includedPartitionSummary,
      mapPoints: includedMapPoints,
      events: includedEvents.map((event) =>
        serializeListEvent(event, "included"),
      ),
      pagination: {
        limit,
        returned: includedEvents.length,
        hasMore: includedHasMore,
        nextCursor: includedNextCursor,
      },
      dimensions: {
        network: includedNetworkDimensions,
      },
    },
  });
}
