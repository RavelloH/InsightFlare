import {
  type AnalysisDefinitionReader,
  executeApiV1SiteOverview,
} from "@/lib/api-v1/analytics-overview";
import { apiV1ErrorRegistry } from "@/lib/api-v1/errors";
import { readBoundedJson } from "@/lib/api-v1/request-budget";
import { serializeAnalyticsResult } from "@/lib/api-v1/serializer";
import type { TypedApplicationProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import type { QueryExecutionContext } from "@/lib/edge/analytics/application/service";
import type { ApiKeyPrincipal } from "@/lib/edge/api-key-auth";

const MAX_BODY_BYTES = 64 * 1024;

function getServerRequestId(): string {
  return crypto.randomUUID();
}

function response(_request: Request, status: number, body: unknown): Response {
  const bodyRequestId =
    body && typeof body === "object" && "meta" in body
      ? (body as { readonly meta?: { readonly requestId?: unknown } }).meta
          ?.requestId
      : undefined;
  const requestId =
    typeof bodyRequestId === "string" ? bodyRequestId : getServerRequestId();
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
  request: Request,
  code: keyof typeof apiV1ErrorRegistry,
  details?: Record<string, unknown>,
): Response {
  const definition = apiV1ErrorRegistry[code];
  return response(request, definition.status, {
    error: {
      code,
      message: definition.message,
      retryable: definition.retryable,
      ...(details
        ? {
            issues: Object.entries(details).map(([path, value]) => ({
              path: `/${path}`,
              code: String(value),
            })),
          }
        : {}),
    },
    meta: { requestId: getServerRequestId() },
  });
}

function protocolError(
  request: Request,
  status: 406 | 415,
  code: string,
  message: string,
): Response {
  return response(request, status, {
    error: { code, message, retryable: false },
    meta: { requestId: getServerRequestId() },
  });
}

function acceptsJson(request: Request): boolean {
  const accept = request.headers.get("accept");
  if (!accept || accept.trim() === "") return true;
  return accept.split(",").some((part) => {
    const mediaType = part.split(";", 1)[0]?.trim().toLowerCase();
    return (
      mediaType === "application/json" ||
      mediaType === "application/*" ||
      mediaType === "*/*"
    );
  });
}

async function readBody(request: Request): Promise<unknown> {
  return readBoundedJson(request, MAX_BODY_BYTES);
}

function serviceErrorResponse(
  request: Request,
  error: { readonly kind: string },
): Response {
  if (
    error.kind === "request_cancelled" ||
    error.kind === "request-cancelled"
  ) {
    return response(request, 499, {
      error: {
        code: "request_cancelled",
        message: "The request was cancelled by the client.",
        retryable: false,
      },
      meta: { requestId: getServerRequestId() },
    });
  }
  if (
    error.kind === "deadline_exceeded" ||
    error.kind === "deadline-exceeded"
  ) {
    return errorResponse(request, "deadline_exceeded");
  }
  if (error.kind === "query-cost-exceeded") {
    return errorResponse(request, "unsupported_query");
  }
  if (error.kind === "missing_scope") {
    return errorResponse(request, "missing_scope");
  }
  if (
    error.kind === "site_not_found" ||
    error.kind === "saved_filter_not_available"
  ) {
    return errorResponse(request, "resource_not_found");
  }
  if (error.kind === "token_inactive") {
    return errorResponse(request, "missing_scope");
  }
  if (error.kind === "invalid_input") {
    return errorResponse(request, "validation_failed");
  }
  return errorResponse(request, "internal_error");
}

/** Planned HTTP adapter; route registration remains lifecycle-gated. */
export async function handlePlannedSiteOverview(
  request: Request,
  principal: ApiKeyPrincipal,
  siteId: string,
  providerRegistry: TypedApplicationProviderRegistry,
  executionContext: QueryExecutionContext,
  definitions?: AnalysisDefinitionReader,
): Promise<Response> {
  if (request.method !== "POST") {
    const result = errorResponse(request, "method_not_allowed");
    result.headers.set("Allow", "POST");
    return result;
  }
  if (request.headers.has("content-encoding")) {
    return protocolError(
      request,
      415,
      "unsupported_media_type",
      "Content-Encoding is not supported.",
    );
  }
  const contentType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    return protocolError(
      request,
      415,
      "unsupported_media_type",
      "The request Content-Type must be application/json.",
    );
  }
  if (!acceptsJson(request)) {
    return protocolError(
      request,
      406,
      "not_acceptable",
      "The route only produces application/json.",
    );
  }
  let input: unknown;
  try {
    input = await readBody(request);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "invalid_json";
    return errorResponse(request, "validation_failed", { reason });
  }
  let result: Awaited<ReturnType<typeof executeApiV1SiteOverview>>;
  try {
    result = await executeApiV1SiteOverview(
      input,
      principal,
      siteId,
      providerRegistry,
      executionContext,
      definitions,
    );
  } catch {
    return errorResponse(request, "data_unavailable");
  }
  if (!result.ok) return serviceErrorResponse(request, result.error);
  const serviceResult = result.value;
  if (!serviceResult.ok)
    return serviceErrorResponse(request, serviceResult.error);
  const analyticsResult = serviceResult.value;
  if (!analyticsResult.ok)
    return serviceErrorResponse(request, analyticsResult.error);
  const metrics = analyticsResult.data.current;
  const serialized = serializeAnalyticsResult(
    {
      ok: true,
      data: {
        views: metrics.views,
        sessions: metrics.sessions,
        visitors: metrics.visitors,
        bounces: metrics.bounces,
        totalDurationMs: metrics.totalDurationMs,
        avgDurationMs:
          metrics.sessions > 0
            ? Math.round(metrics.totalDurationMs / metrics.sessions)
            : 0,
        bounceRate:
          metrics.sessions > 0 ? metrics.bounces / metrics.sessions : 0,
        approximateVisitors: analyticsResult.meta.approximateVisitors,
      },
      meta: analyticsResult.meta,
    },
    getServerRequestId(),
    new Date(
      executionContext.capturedAtMs ?? executionContext.now?.() ?? Date.now(),
    ).toISOString(),
  );
  return response(request, serialized.status, serialized.body);
}
