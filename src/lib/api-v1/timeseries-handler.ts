import type { AnalysisDefinitionReader } from "@/lib/api-v1/analysis-definition-reader";
import { executeApiV1SiteTimeseries } from "@/lib/api-v1/analytics-timeseries";
import { apiV1ErrorRegistry } from "@/lib/api-v1/errors";
import { readBoundedJson } from "@/lib/api-v1/request-budget";
import { serializeAnalyticsResult } from "@/lib/api-v1/serializer";
import type { QueryExecutionContext } from "@/lib/edge/analytics/application/service";
import type { OverviewReader } from "@/lib/edge/analytics/contract";
import type { ApiKeyPrincipal } from "@/lib/edge/api-key-auth";

const MAX_BODY_BYTES = 64 * 1024;

function id(): string {
  return crypto.randomUUID();
}

function response(status: number, body: unknown, requestId = id()): Response {
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

function errorResponse(
  code: keyof typeof apiV1ErrorRegistry,
  status = apiV1ErrorRegistry[code].status,
): Response {
  const requestId = id();
  return response(
    status,
    {
      error: {
        code,
        message: apiV1ErrorRegistry[code].message,
        retryable: apiV1ErrorRegistry[code].retryable,
      },
      meta: { requestId },
    },
    requestId,
  );
}

function acceptsJson(request: Request): boolean {
  const accept = request.headers.get("accept");
  if (!accept || accept.trim() === "") return true;
  return accept.split(",").some((part) => {
    const mediaType = part.split(";", 1)[0]?.trim().toLowerCase();
    return ["application/json", "application/*", "*/*"].includes(mediaType);
  });
}

async function readBody(request: Request): Promise<unknown> {
  return readBoundedJson(request, MAX_BODY_BYTES);
}

function mapAdapterError(error: {
  readonly kind: string;
}): keyof typeof apiV1ErrorRegistry {
  if (
    error.kind === "request_cancelled" ||
    error.kind === "request-cancelled"
  ) {
    return "internal_error";
  }
  if (error.kind === "query-cost-exceeded") return "unsupported_query";
  if (
    error.kind === "deadline_exceeded" ||
    error.kind === "deadline-exceeded"
  ) {
    return "deadline_exceeded";
  }
  if (error.kind === "missing_scope") return "missing_scope";
  if (error.kind === "token_inactive") return "missing_scope";
  if (
    error.kind === "site_not_found" ||
    error.kind === "saved_filter_not_available"
  ) {
    return "resource_not_found";
  }
  if (error.kind === "invalid_input") return "validation_failed";
  if (error.kind === "query-cost-exceeded") return "unsupported_query";
  return "internal_error";
}

/** Planned typed timeseries adapter; route registration remains gated. */
export async function handlePlannedSiteTimeseries(
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
  if (request.headers.has("content-encoding")) {
    return errorResponse("unsupported_media_type");
  }
  const contentType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    return errorResponse("unsupported_media_type");
  }
  if (!acceptsJson(request)) return errorResponse("not_acceptable");
  let input: unknown;
  try {
    input = await readBody(request);
  } catch {
    return errorResponse("validation_failed");
  }
  let result: Awaited<ReturnType<typeof executeApiV1SiteTimeseries>>;
  try {
    result = await executeApiV1SiteTimeseries(
      input,
      principal,
      siteId,
      reader,
      executionContext,
      definitions,
    );
  } catch {
    return errorResponse("data_unavailable");
  }
  if (!result.ok) return errorResponse(mapAdapterError(result.error));
  if (!result.value.ok)
    return errorResponse(mapAdapterError(result.value.error));
  const analytics = result.value.value;
  if (!analytics.ok) return errorResponse("internal_error");
  const serialized = serializeAnalyticsResult(
    {
      ok: true,
      data: {
        interval: analytics.data.interval,
        points: analytics.data.points.map((point) => ({
          timestamp: new Date(point.timestampMs).toISOString(),
          views: point.views,
          sessions: point.sessions,
          visitors: point.visitors,
          bounces: point.bounces,
          totalDurationMs: point.totalDurationMs,
          avgDurationMs:
            point.sessions > 0
              ? Math.round(point.totalDurationMs / point.sessions)
              : 0,
          bounceRate: point.sessions > 0 ? point.bounces / point.sessions : 0,
        })),
      },
      meta: analytics.meta,
    },
    id(),
    new Date(
      executionContext.capturedAtMs ?? executionContext.now?.() ?? Date.now(),
    ).toISOString(),
  );
  return response(
    serialized.status,
    serialized.body,
    serialized.body.meta.requestId,
  );
}
