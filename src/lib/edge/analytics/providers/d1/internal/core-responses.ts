import type { AnalyticsDomainError } from "@/lib/edge/analytics/contract";
import {
  bad as badRequest,
  errorResponse,
  jsonResponse as createJsonResponse,
  type ResponseContext,
} from "@/lib/response";

import {
  PRIVATE_CACHE_HEADERS,
  PUBLIC_CACHE_HEADERS,
  PUBLIC_PRIVACY,
  type SiteQueryResponseOptions,
} from "./core-types";

export type { ResponseContext } from "@/lib/response";
export {
  bad as badRequest,
  forb,
  getRequestId,
  j as jsonResponse,
  jsonResponseWith,
  na as notAllowed,
  nf as notFound,
  una as unauthorized,
} from "@/lib/response";

export function queryErrorResponse(error: AnalyticsDomainError): Response {
  if (error.kind === "invalid-cursor") {
    return errorResponse(null, 400, "invalid-cursor", "Invalid cursor");
  }
  if (error.kind === "internal") {
    return errorResponse(null, 500, "internal", "Internal Server Error");
  }
  if (error.kind === "range-not-supported") {
    return errorResponse(
      null,
      422,
      error.reason === "too-many-buckets"
        ? "too_many_buckets"
        : "range_too_wide",
      error.reason === "too-many-buckets"
        ? "The requested trend contains too many buckets."
        : "The requested time range is too wide.",
    );
  }
  return badRequest(error.kind);
}

export function siteQueryHeaders(
  options: SiteQueryResponseOptions,
): Record<string, string> {
  return options.publicSite ? PUBLIC_CACHE_HEADERS : PRIVATE_CACHE_HEADERS;
}

export function siteQueryResponse(
  siteId: string,
  payload: Record<string, unknown>,
  options: SiteQueryResponseOptions = {},
  ctx?: ResponseContext,
): Response {
  const base: Record<string, unknown> = options.publicSite
    ? { ...payload, site: options.publicSite, privacy: PUBLIC_PRIVACY }
    : { ...payload, siteId };
  const body = ctx
    ? { ...base, requestId: ctx.requestId, timestamp: new Date().toISOString() }
    : base;
  return createJsonResponse(body, 200, siteQueryHeaders(options));
}
