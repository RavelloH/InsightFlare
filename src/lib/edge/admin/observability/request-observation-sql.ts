import { timeZoneOffsetMinutes } from "@/lib/analytics/time-zone";
import { REQUEST_ANALYTICS_DATASET } from "@/lib/analytics-engine-config";
import {
  REQUEST_ANALYTICS_FLAGS,
  REQUEST_ANALYTICS_SCHEMA_VERSION,
} from "@/lib/edge/analytics-engine/request-schema";

import {
  analyticsSqlString,
  BLOCKED_DISPOSITION_SQL_FILTER,
  type DetailSource,
  type DimensionGroup,
  dimensionTabsFor,
  INCLUDED_DISPOSITION_SQL_FILTER,
  NETWORK_DIMENSION_LIMIT,
  type NetworkDimension,
  REQUEST_LATENCY_SQL_FILTER,
  requestDispositionFilter,
  type RequestObservationInterval,
  requestRowSelect,
} from "./request-observation-model";
export function buildCountByBucketSql(input: {
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
export function buildMapPointsSql(input: {
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
export function buildNetworkDimensionSql(input: {
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
export function buildSourceSummarySql(input: {
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
export function buildDimensionSql(input: {
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
export function buildReasonSummarySql(input: { from: number; to: number }) {
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
export function buildAsnSummarySql(input: { from: number; to: number }) {
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
export function buildRequestAnalyticsDetailSql(input: {
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
