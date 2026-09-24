import {
  resolveReportingTimeZone,
  startOfZonedDay,
} from "@/lib/analytics/time-zone";
import { REQUEST_ANALYTICS_DATASET } from "@/lib/analytics-engine-config";
import type { requireActor } from "@/lib/edge/admin/auth";
import type {
  RequestAnalyticsCategory,
  RequestAnalyticsDisposition,
} from "@/lib/edge/analytics-engine/request-schema";
import {
  hasRequestFlag,
  REQUEST_ANALYTICS_CATEGORIES,
  REQUEST_ANALYTICS_FLAGS,
  REQUEST_ANALYTICS_SCHEMA_VERSION,
} from "@/lib/edge/analytics-engine/request-schema";
import type { Env } from "@/lib/edge/types";
import { clampString, ONE_HOUR_MS } from "@/lib/edge/utils";
import { hasExactKeys, paginationBinding } from "@/lib/pagination";
export const DETAIL_PAGE_SIZE = 100;
const MAX_DETAIL_PAGE_SIZE = DETAIL_PAGE_SIZE;
export const MAX_SITE_IDS_PER_D1_QUERY = 100;
export const NETWORK_DIMENSION_LIMIT = 30;
const WINDOW_OPTIONS_MINUTES = new Set([60, 1440, 10080, 43200]);
const MAX_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
export const CF_ANALYTICS_ENGINE_SQL_ENDPOINT =
  "https://api.cloudflare.com/client/v4/accounts";
const REQUEST_CATEGORIES = REQUEST_ANALYTICS_CATEGORIES;
const DISPOSITION_BLOCKED_FLAG = REQUEST_ANALYTICS_FLAGS.dispositionBlocked;
export const BLOCKED_DISPOSITION_SQL_FILTER = `intDiv(double19, ${DISPOSITION_BLOCKED_FLAG}) % 2 != 0`;
export const INCLUDED_DISPOSITION_SQL_FILTER = `intDiv(double19, ${DISPOSITION_BLOCKED_FLAG}) % 2 = 0`;
export const MAX_WORKER_LATENCY_MS = 60_000;
export const REQUEST_LATENCY_SQL_FILTER = `double20 = ${REQUEST_ANALYTICS_SCHEMA_VERSION} AND intDiv(double19, ${REQUEST_ANALYTICS_FLAGS.edgeLatencyPresent}) % 2 != 0 AND double3 BETWEEN 0 AND ${MAX_WORKER_LATENCY_MS}`;
export function analyticsEngineSqlEndpoint(env: Env): string | null {
  if (env.INSIGHTFLARE_E2E === "1") {
    const mockUrl = env.INSIGHTFLARE_E2E_CLOUDFLARE_API_URL?.trim();
    return mockUrl ? mockUrl.replace(/\/+$/, "") : null;
  }
  return CF_ANALYTICS_ENGINE_SQL_ENDPOINT;
}
export type AdminActor = Awaited<ReturnType<typeof requireActor>>;
export type RequestObservationCategory = RequestAnalyticsCategory;
type RequestObservationDisposition = RequestAnalyticsDisposition;
export type RequestObservationInterval = "minute" | "hour" | "day" | "week";
export type NetworkDimension =
  "asOrganization" | "asn" | "country" | "region" | "city" | "colo";
export type DetailSource = "blocked" | "included";
export type DimensionGroup = "detection" | "target" | "network" | "client";
export interface DetailCursor {
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
export function dimensionTabsFor(
  source: DetailSource,
  group: DimensionGroup,
): readonly string[] {
  return DIMENSION_TABS_BY_SOURCE[source][group];
}
export interface RequestObservationEvent {
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
export function analyticsEngineSamplingMeta(input: {
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
export function rowsContainObservedSampling(
  rows: Record<string, unknown>[],
): boolean {
  return rows.some((row) => {
    const value = Number(row.maxSampleInterval ?? row.sampleWeight);
    return Number.isFinite(value) && value > 1;
  });
}
export function toFiniteNumber(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}
export function toNullableCoordinate(value: unknown): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return numeric;
}
function parseWindowMinutes(url: URL): number {
  const value = Number(url.searchParams.get("minutes") || "43200");
  return WINDOW_OPTIONS_MINUTES.has(value) ? value : 43200;
}
export function parseTimeWindow(url: URL, now = Date.now()) {
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
export function parseLimit(url: URL): number {
  const value = Number(url.searchParams.get("limit") || DETAIL_PAGE_SIZE);
  if (!Number.isFinite(value)) return DETAIL_PAGE_SIZE;
  return Math.max(1, Math.min(MAX_DETAIL_PAGE_SIZE, Math.trunc(value)));
}
export function detailCursor(value: unknown): DetailCursor | null {
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
  // upstream requests. The collector normally supplies traceId, but older
  // observations may only have rayId. Accept either identity for the final
  // keyset tuple; rows without both identifiers cannot produce a safe cursor.
  if (!timestamp || (!traceId && !rayId)) return null;
  return {
    timestamp,
    receivedAt: Math.max(0, toFiniteNumber(candidate.receivedAt)),
    traceId,
    rayId,
  };
}
export function requestObservationBinding(input: {
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
export function analyticsSqlString(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}
export function normalizeObservationCategory(
  value: unknown,
): RequestObservationCategory | null {
  const category = String(value || "");
  return (REQUEST_CATEGORIES as readonly string[]).includes(category)
    ? (category as RequestObservationCategory)
    : null;
}
export function normalizeObservationDisposition(
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
export function requestDispositionFilter(source: DetailSource): string {
  return source === "blocked"
    ? BLOCKED_DISPOSITION_SQL_FILTER
    : INCLUDED_DISPOSITION_SQL_FILTER;
}
function requestCursorFilter(cursor?: DetailCursor | null): string {
  if (!cursor) return "";
  return `AND (timestamp < toDateTime(${analyticsSqlString(cursor.timestamp)}) OR (timestamp = toDateTime(${analyticsSqlString(cursor.timestamp)}) AND (double1 < ${cursor.receivedAt} OR (double1 = ${cursor.receivedAt} AND (blob17 < ${analyticsSqlString(cursor.traceId)} OR (blob17 = ${analyticsSqlString(cursor.traceId)} AND blob16 < ${analyticsSqlString(cursor.rayId)}))))))`;
}
export function requestRowSelect(): string {
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
export function buildRequestAnalyticsSql(input: {
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
      AND (blob17 != '' OR blob16 != '')
      ${requestCursorFilter(input.cursor)}
    ORDER BY timestamp DESC, receivedAt DESC, traceId DESC, rayId DESC
    LIMIT ${input.limit}
    FORMAT JSONEachRow
  `;
}
export function requestAnalyticsFlagPresent(
  value: unknown,
  flag: number,
): boolean {
  return hasRequestFlag(
    Math.trunc(toFiniteNumber(value)),
    flag as (typeof REQUEST_ANALYTICS_FLAGS)[keyof typeof REQUEST_ANALYTICS_FLAGS],
  );
}
