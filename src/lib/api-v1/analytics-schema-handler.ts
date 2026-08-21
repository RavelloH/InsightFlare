import {
  type AnalyticsSchemaClock,
  buildSiteAnalyticsSchema,
  buildTeamAnalyticsSchema,
} from "@/lib/api-v1/analytics-schema";
import { apiV1ErrorRegistry } from "@/lib/api-v1/errors";
import type { ApiKeyPrincipal } from "@/lib/edge/api-key-auth";
import { canAccessSiteId } from "@/lib/edge/api-key-auth";

function requestId(): string {
  return crypto.randomUUID();
}

function jsonResponse(
  status: number,
  body: unknown,
  id = requestId(),
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Request-Id": id,
    },
  });
}

function errorResponse(
  code: keyof typeof apiV1ErrorRegistry,
  status = apiV1ErrorRegistry[code].status,
): Response {
  const id = requestId();
  return jsonResponse(
    status,
    {
      error: {
        code,
        message: apiV1ErrorRegistry[code].message,
        retryable: apiV1ErrorRegistry[code].retryable,
      },
      meta: { requestId: id },
    },
    id,
  );
}

/** Planned schema catalog adapter; registration remains lifecycle-gated. */
export function handlePlannedSiteAnalyticsSchema(
  request: Request,
  principal: ApiKeyPrincipal,
  siteId: string,
  clock: AnalyticsSchemaClock = {},
): Response {
  if (request.method !== "GET") {
    const response = errorResponse("method_not_allowed");
    response.headers.set("Allow", "GET");
    return response;
  }
  if (principal.status !== undefined && principal.status !== "active") {
    return errorResponse("missing_scope");
  }
  if (!principal.scopes.includes("analytics:read")) {
    return errorResponse("missing_scope");
  }
  if (!canAccessSiteId(principal, siteId)) {
    return errorResponse("resource_not_found");
  }
  const data = buildSiteAnalyticsSchema(siteId, clock);
  const id = requestId();
  const body = { data, meta: { requestId: id } };
  return jsonResponse(200, body, id);
}

/** Planned team schema catalog adapter; registration remains lifecycle-gated. */
export function handlePlannedTeamAnalyticsSchema(
  request: Request,
  principal: ApiKeyPrincipal,
  clock: AnalyticsSchemaClock = {},
): Response {
  if (request.method !== "GET") {
    const response = errorResponse("method_not_allowed");
    response.headers.set("Allow", "GET");
    return response;
  }
  if (principal.status !== undefined && principal.status !== "active") {
    return errorResponse("missing_scope");
  }
  if (!principal.scopes.includes("analytics:read")) {
    return errorResponse("missing_scope");
  }
  const id = requestId();
  return jsonResponse(
    200,
    { data: buildTeamAnalyticsSchema(clock), meta: { requestId: id } },
    id,
  );
}
