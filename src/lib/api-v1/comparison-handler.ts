import type { AnalysisDefinitionReader } from "@/lib/api-v1/analysis-definition-reader";
import {
  type ComparisonOverviewData,
  executeApiV1SiteOverviewComparison,
} from "@/lib/api-v1/analytics-comparison";
import { apiV1ErrorRegistry } from "@/lib/api-v1/errors";
import { readBoundedJson } from "@/lib/api-v1/request-budget";
import type { QueryExecutionContext } from "@/lib/edge/analytics/service";
import type { ApiKeyPrincipal } from "@/lib/edge/api-key-auth";
import type {
  OverviewMetrics,
  OverviewReader,
} from "@/lib/edge/query-contract";

const MAX_BODY_BYTES = 64 * 1024;

function response(
  status: number,
  body: unknown,
  requestId = crypto.randomUUID(),
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Request-Id": requestId,
    },
  });
}

function errorResponse(code: keyof typeof apiV1ErrorRegistry): Response {
  const requestId = crypto.randomUUID();
  const error = apiV1ErrorRegistry[code];
  return response(
    error.status,
    {
      error: { code, message: error.message, retryable: error.retryable },
      meta: { requestId },
    },
    requestId,
  );
}

function acceptsJson(request: Request): boolean {
  const accept = request.headers.get("accept");
  return (
    !accept ||
    accept.split(",").some((part) => {
      const type = part.split(";", 1)[0]?.trim().toLowerCase();
      return (
        type === "application/json" ||
        type === "application/*" ||
        type === "*/*"
      );
    })
  );
}

function toWireMetrics(metrics: OverviewMetrics) {
  return {
    views: metrics.views,
    sessions: metrics.sessions,
    visitors: metrics.visitors,
    bounces: metrics.bounces,
    totalDurationMs: metrics.totalDurationMs,
    avgDurationMs:
      metrics.sessions > 0
        ? Math.round(metrics.totalDurationMs / metrics.sessions)
        : 0,
    bounceRate: metrics.sessions > 0 ? metrics.bounces / metrics.sessions : 0,
    approximateVisitors: false,
  };
}

function mapError(kind: string): keyof typeof apiV1ErrorRegistry {
  if (kind === "request_cancelled" || kind === "request-cancelled")
    return "request_cancelled";
  if (kind === "missing_scope" || kind === "token_inactive")
    return "missing_scope";
  if (kind === "site_not_found" || kind === "saved_filter_not_available")
    return "resource_not_found";
  if (kind === "invalid_input") return "validation_failed";
  if (kind === "deadline_exceeded" || kind === "deadline-exceeded")
    return "deadline_exceeded";
  if (kind === "query-cost-exceeded") return "unsupported_query";
  return "internal_error";
}

/** HTTP adapter for the site overview comparison variants. */
export async function handleSiteOverviewComparison(
  request: Request,
  principal: ApiKeyPrincipal,
  siteId: string,
  reader: OverviewReader,
  executionContext: QueryExecutionContext,
  definitions?: AnalysisDefinitionReader,
): Promise<Response> {
  if (request.method !== "POST") {
    const result = errorResponse("method_not_allowed");
    result.headers.set("Allow", "POST");
    return result;
  }
  if (request.headers.has("content-encoding"))
    return errorResponse("unsupported_media_type");
  if (
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() !== "application/json"
  ) {
    return errorResponse("unsupported_media_type");
  }
  if (!acceptsJson(request)) return errorResponse("not_acceptable");

  let body: unknown;
  try {
    body = await readBoundedJson(request, MAX_BODY_BYTES);
  } catch {
    return errorResponse("validation_failed");
  }
  try {
    const result = await executeApiV1SiteOverviewComparison(
      body,
      principal,
      siteId,
      reader,
      executionContext,
      definitions,
    );
    if (!result.ok) return errorResponse(mapError(result.error.kind));
    if (!result.value.ok)
      return errorResponse(mapError(result.value.error.kind));
    if (!result.value.value.ok) return errorResponse("unsupported_query");
    const comparison = result.value.value;
    const requestId = crypto.randomUUID();
    const data: ComparisonOverviewData = comparison.data;
    return response(
      200,
      {
        data: {
          a: toWireMetrics(data.a),
          b: toWireMetrics(data.b),
          delta: data.delta,
        },
        meta: {
          requestId,
          generatedAt: new Date().toISOString(),
          aTimeRange: {
            from: new Date(data.aTime.range.startMs).toISOString(),
            to: new Date(data.aTime.range.endExclusiveMs).toISOString(),
            timeZone: data.aTime.reportingTimeZone,
          },
          bTimeRange: {
            from: new Date(data.bTime.range.startMs).toISOString(),
            to: new Date(data.bTime.range.endExclusiveMs).toISOString(),
            timeZone: data.bTime.reportingTimeZone,
          },
          source: comparison.meta.source,
          accuracy: comparison.meta.approximateVisitors
            ? "approximate"
            : "exact",
        },
      },
      requestId,
    );
  } catch {
    return errorResponse("internal_error");
  }
}
