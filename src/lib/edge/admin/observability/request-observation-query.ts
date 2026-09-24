import {
  addZonedInterval,
  startOfZonedInterval,
} from "@/lib/analytics/time-zone";
import {
  type AnalyticsEngineConfig,
  redactAnalyticsEngineConfig,
} from "@/lib/analytics-engine-config";
import { forb } from "@/lib/edge/admin/response";
import { analyticsEngineAvailability } from "@/lib/edge/analytics-engine/config";
import {
  REQUEST_ANALYTICS_FLAGS,
  REQUEST_ANALYTICS_SCHEMA_VERSION,
} from "@/lib/edge/analytics-engine/request-schema";
import type { Env } from "@/lib/edge/types";
import { clampString } from "@/lib/edge/utils";

import {
  type AdminActor,
  analyticsEngineSamplingMeta,
  CF_ANALYTICS_ENGINE_SQL_ENDPOINT,
  DETAIL_PAGE_SIZE,
  type DetailCursor,
  type DetailSource,
  MAX_SITE_IDS_PER_D1_QUERY,
  MAX_WORKER_LATENCY_MS,
  normalizeObservationCategory,
  normalizeObservationDisposition,
  requestAnalyticsFlagPresent,
  type RequestObservationCategory,
  type RequestObservationEvent,
  type RequestObservationInterval,
  toFiniteNumber,
  toNullableCoordinate,
} from "./request-observation-model";
export function emptyRequestObservationResponse(
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
export function requireAdmin(
  actor: AdminActor,
  request: Request,
): Response | null {
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
export function parseJsonEachRow(text: string): Record<string, unknown>[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
export function normalizeRequestRow(
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
export function serializeListEvent(
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
export function detailCursorForEvent(
  event: RequestObservationEvent,
): DetailCursor {
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
export async function siteLookup(env: Env, events: RequestObservationEvent[]) {
  const ids = [...new Set(events.map((event) => event.siteId).filter(Boolean))];
  return siteLookupByIds(env, ids);
}
export async function siteLookupByIds(env: Env, ids: string[]) {
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
export async function queryAnalyticsRows(input: {
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
export function normalizeMapRows(rows: Record<string, unknown>[]) {
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
export function normalizeNetworkDimensionRows(rows: Record<string, unknown>[]) {
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
export function normalizeReasonRows(rows: Record<string, unknown>[]) {
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
export function normalizeAsnRows(rows: Record<string, unknown>[]) {
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
export function normalizeLatencySummary(row: Record<string, unknown>) {
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
export function mergeTrendRows(input: {
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
export async function queryCloudflareAnalyticsEngine(input: {
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
export function cloudflareAnalyticsErrorMessage(input: {
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
