import type { AnalyticsDomainError } from "@/lib/edge/query-contract";
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
  if (error.kind === "internal") {
    return errorResponse(null, 500, "internal", "Internal Server Error");
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
