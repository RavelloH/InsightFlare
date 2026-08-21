import type { AnalysisDefinitionReader } from "@/lib/api-v1/analysis-definition-reader";
import { executeApiV1SiteTimeseriesComparison } from "@/lib/api-v1/analytics-comparison-timeseries";
import { apiV1ErrorRegistry } from "@/lib/api-v1/errors";
import { readBoundedJson } from "@/lib/api-v1/request-budget";
import type { QueryExecutionContext } from "@/lib/edge/analytics/service";
import type { ApiKeyPrincipal } from "@/lib/edge/api-key-auth";
import type { OverviewReader } from "@/lib/edge/query-contract";

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
  if (
    kind === "unsupported-operation" ||
    kind === "unsupported-query" ||
    kind === "query-cost-exceeded"
  )
    return "unsupported_query";
  return "internal_error";
}

/** HTTP adapter for explicit site comparison timeseries. */
export async function handleSiteTimeseriesComparison(
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
  )
    return errorResponse("unsupported_media_type");
  if (!acceptsJson(request)) return errorResponse("not_acceptable");
  let body: unknown;
  try {
    body = await readBoundedJson(request, MAX_BODY_BYTES);
  } catch {
    return errorResponse("validation_failed");
  }
  try {
    const result = await executeApiV1SiteTimeseriesComparison(
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
    if (!result.value.value.ok)
      return errorResponse(mapError(result.value.value.error.kind));
    const comparison = result.value.value;
    const requestId = crypto.randomUUID();
    return response(
      200,
      {
        data: {
          interval: comparison.data.interval,
          a: {
            interval: comparison.data.a.interval,
            points: comparison.data.a.points.map((point) => ({
              timestamp: new Date(point.timestampMs).toISOString(),
              views: point.views,
              sessions: point.sessions,
              visitors: point.visitors,
              bounces: point.bounces,
              totalDurationMs: point.totalDurationMs,
              avgDurationMs: point.sessions
                ? Math.round(point.totalDurationMs / point.sessions)
                : 0,
              bounceRate: point.sessions ? point.bounces / point.sessions : 0,
            })),
          },
          b: {
            interval: comparison.data.b.interval,
            points: comparison.data.b.points.map((point) => ({
              timestamp: new Date(point.timestampMs).toISOString(),
              views: point.views,
              sessions: point.sessions,
              visitors: point.visitors,
              bounces: point.bounces,
              totalDurationMs: point.totalDurationMs,
              avgDurationMs: point.sessions
                ? Math.round(point.totalDurationMs / point.sessions)
                : 0,
              bounceRate: point.sessions ? point.bounces / point.sessions : 0,
            })),
          },
          delta: {
            points: comparison.data.delta.map((point) => ({
              ordinal: point.ordinal,
              aTimestamp: new Date(point.a.timestampMs).toISOString(),
              bTimestamp: new Date(point.b.timestampMs).toISOString(),
              ...point.values,
            })),
          },
        },
        meta: {
          requestId,
          generatedAt: new Date().toISOString(),
          aTimeRange: {
            from: new Date(comparison.data.aTime.range.startMs).toISOString(),
            to: new Date(
              comparison.data.aTime.range.endExclusiveMs,
            ).toISOString(),
            timeZone: comparison.data.aTime.reportingTimeZone,
          },
          bTimeRange: {
            from: new Date(comparison.data.bTime.range.startMs).toISOString(),
            to: new Date(
              comparison.data.bTime.range.endExclusiveMs,
            ).toISOString(),
            timeZone: comparison.data.bTime.reportingTimeZone,
          },
          source: comparison.data.source,
          accuracy: comparison.data.approximateVisitors
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
