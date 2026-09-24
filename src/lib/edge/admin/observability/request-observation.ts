import {
  defaultAnalyticsEngineConfig,
  normalizeAnalyticsEngineConfig,
  redactAnalyticsEngineConfig,
  SYSTEM_ANALYTICS_ENGINE_CONFIG_KEY,
  validateAnalyticsEngineConfig,
} from "@/lib/analytics-engine-config";
import { requireActor } from "@/lib/edge/admin/auth";
import { bad, jsonResponseFor, na } from "@/lib/edge/admin/response";
import { analyticsEngineAvailability } from "@/lib/edge/analytics-engine/config";
import { decryptAnalyticsEngineSecret } from "@/lib/edge/auth/secret-encryption";
import { readConfig } from "@/lib/edge/system-config";
import type { Env } from "@/lib/edge/types";
import { clampString } from "@/lib/edge/utils";
import {
  decodePageCursor,
  encodePageCursor,
  InvalidCursorError,
} from "@/lib/pagination";

import {
  analyticsEngineSamplingMeta,
  analyticsEngineSqlEndpoint,
  buildRequestAnalyticsSql,
  type DetailCursor,
  detailCursor,
  type DetailSource,
  type DimensionGroup,
  dimensionTabsFor,
  type NetworkDimension,
  parseLimit,
  parseTimeWindow,
  requestObservationBinding,
  rowsContainObservedSampling,
  toFiniteNumber,
} from "./request-observation-model";
import {
  cloudflareAnalyticsErrorMessage,
  detailCursorForEvent,
  emptyRequestObservationResponse,
  mergeTrendRows,
  normalizeAsnRows,
  normalizeLatencySummary,
  normalizeMapRows,
  normalizeNetworkDimensionRows,
  normalizeReasonRows,
  normalizeRequestRow,
  parseJsonEachRow,
  queryAnalyticsRows,
  queryCloudflareAnalyticsEngine,
  requireAdmin,
  serializeListEvent,
  siteLookup,
  siteLookupByIds,
} from "./request-observation-query";
import {
  buildAsnSummarySql,
  buildCountByBucketSql,
  buildDimensionSql,
  buildMapPointsSql,
  buildNetworkDimensionSql,
  buildReasonSummarySql,
  buildRequestAnalyticsDetailSql,
  buildSourceSummarySql,
} from "./request-observation-sql";
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
