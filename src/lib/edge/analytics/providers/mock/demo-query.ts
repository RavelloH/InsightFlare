import "@tanstack/react-start/server-only";

import {
  demoBadRequest,
  demoErr,
  isErrorEnvelope,
} from "@/lib/demo/realtime/envelope";
import type {
  FilterDocument,
  FilterScope,
  QueryOperation,
  QueryTime,
} from "@/lib/edge/analytics/contract";
import { analyticsDiagnosticHeaders } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import { formatFilterDsl } from "@/lib/filter-contract";
import {
  getRequestId,
  jsonResponseWith,
  type ResponseContext,
} from "@/lib/response";
const PRIVATE_CACHE_HEADERS = {
  "cache-control": "private, no-store",
  vary: "authorization, cookie",
};
const PUBLIC_CACHE_HEADERS = {
  "cache-control": "public, max-age=300, s-maxage=300",
  "access-control-allow-origin": "*",
};
export interface DemoQueryRuntimeInput {
  readonly request: Request;
  readonly url: URL;
  readonly siteId: string;
  readonly publicQuery?: boolean;
  readonly context?: ResponseContext;
  /** Selected by the protocol adapter before the mock provider is invoked. */
  readonly operation?: QueryOperation;
  /** Resolved by the canonical query service before demo data generation. */
  readonly resolvedScope?: FilterScope;
  /** Canonical query values, including the request-fixed clock and evaluation range. */
  readonly canonicalQuery?: unknown;
}
const EMPTY_D1_DIAGNOSTICS = {
  rowsRead: 0,
  rowsReadAvailable: true,
};
function responseHeaders(
  publicQuery: boolean,
  success: boolean,
): Record<string, string> {
  const cacheHeaders =
    publicQuery && success ? PUBLIC_CACHE_HEADERS : PRIVATE_CACHE_HEADERS;
  return {
    ...cacheHeaders,
    ...analyticsDiagnosticHeaders("mock", EMPTY_D1_DIAGNOSTICS),
    "content-type": "application/json; charset=utf-8",
  };
}
export function createDemoQueryResponse(
  payload: unknown,
  status: number,
  publicQuery: boolean,
  context: ResponseContext,
): Response {
  const body =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : { data: payload };
  return jsonResponseWith(
    { ...context, deferJsonSerialization: false },
    body,
    status,
    responseHeaders(publicQuery, status < 400),
  );
}
export interface DemoQueryPayloadResult {
  readonly payload: unknown;
  readonly status: number;
}
function successStatus(request: Request, url: URL): number {
  if (request.method !== "POST") return 200;
  const lastPathSegment = url.pathname.split("/").filter(Boolean).at(-1);
  return lastPathSegment === "funnels" ||
    lastPathSegment === "goals" ||
    lastPathSegment === "saved-filters"
    ? 201
    : 200;
}
function requiresJsonBodyValidation(request: Request, url: URL): boolean {
  if (request.method !== "POST") return false;
  const last = url.pathname.split("/").filter(Boolean).at(-1);
  return last === "funnels" || last === "goals";
}
function unsupportedSavedFilterMethod(request: Request, url: URL): boolean {
  const marker = "/api/private/saved-filters";
  if (!url.pathname.startsWith(marker)) return false;
  const suffix = url.pathname.slice(marker.length).replace(/\/$/, "");
  const allowedMethods = suffix
    ? new Set(["GET", "PUT", "DELETE"])
    : new Set(["GET", "POST"]);
  return !allowedMethods.has(request.method);
}
async function requestBody(
  request: Request,
): Promise<
  { readonly valid: true; readonly body: unknown } | { valid: false }
> {
  if (request.method === "GET" || request.method === "HEAD") {
    return { valid: true, body: undefined };
  }
  try {
    const text = await request.clone().text();
    if (!text.trim()) {
      return request.method === "DELETE"
        ? { valid: true, body: undefined }
        : { valid: false };
    }
    return { valid: true, body: JSON.parse(text) as unknown };
  } catch {
    return { valid: false };
  }
}
/**
 * Runs the existing demo generator at the server boundary. Keeping the
 * dispatcher import here prevents demo-only generators from entering the
 * production query adapters unless this runtime is actually selected.
 */
export async function executeDemoQuery(
  input: DemoQueryRuntimeInput,
): Promise<Response> {
  const { request, url, siteId, publicQuery = false } = input;
  const context: ResponseContext = input.context ?? {
    requestId: getRequestId(request),
  };
  if (unsupportedSavedFilterMethod(request, url)) {
    return createDemoQueryResponse(
      demoErr("method_not_allowed", "Method Not Allowed"),
      405,
      publicQuery,
      context,
    );
  }
  const parsedBody = await requestBody(request);
  if (!parsedBody.valid && requiresJsonBodyValidation(request, url)) {
    return createDemoQueryResponse(
      demoBadRequest("Invalid JSON body"),
      400,
      publicQuery,
      context,
    );
  }
  const params = Object.fromEntries(url.searchParams) as Record<
    string,
    string | number
  >;
  params.siteId = siteId;
  if (input.operation) params.operation = input.operation;
  if (input.resolvedScope) params.resolvedScope = input.resolvedScope;
  if (input.canonicalQuery && typeof input.canonicalQuery === "object") {
    const canonical = input.canonicalQuery as {
      readonly time?: QueryTime;
      readonly filters?: FilterDocument;
      readonly scopePreference?: string;
      readonly current?: {
        readonly time?: QueryTime;
        readonly filters?: FilterDocument;
        readonly scopePreference?: string;
      };
    };
    const side = canonical.current ?? canonical;
    const { time, filters, scopePreference } = side;
    if (!time)
      return createDemoQueryResponse(
        demoBadRequest("Canonical query is missing its time range"),
        400,
        publicQuery,
        context,
      );
    params.from = time.range.startMs;
    params.to = time.range.endExclusiveMs;
    params.timeZone = time.reportingTimeZone;
    params.nowMs = time.capturedAtMs;
    params.__filterDsl = formatFilterDsl(filters ?? { version: 1, root: null });
    params.scope = scopePreference ?? "auto";
    if (time.fullHistory) params.__filterFullHistory = "true";
    else delete params.__filterFullHistory;
    if (time.evaluationRange) {
      params.evaluationFromMs = time.evaluationRange.startMs;
      params.evaluationToMs = time.evaluationRange.endExclusiveMs;
    } else {
      delete params.evaluationFromMs;
      delete params.evaluationToMs;
    }
  }

  try {
    const { handleDemoRequest } = await import("@/lib/demo/runtime");
    const result = handleDemoRequest({
      path: url.pathname,
      method: request.method,
      params,
      body: parsedBody.valid ? parsedBody.body : undefined,
    });
    const status = isErrorEnvelope(result)
      ? result.error.code === "not_found"
        ? 404
        : result.error.code === "method_not_allowed"
          ? 405
          : 400
      : successStatus(request, url);
    return createDemoQueryResponse(result, status, publicQuery, context);
  } catch (error) {
    const message = error instanceof Error ? error.message : "demo_query_error";
    if (
      message === "filter_evaluation_range_unavailable" ||
      message === "filter_activity_limit_exceeded" ||
      message === "filter_sequence_match_limit_exceeded" ||
      message === "filter_sequence_work_limit_exceeded"
    ) {
      return createDemoQueryResponse(
        demoBadRequest(message),
        400,
        publicQuery,
        context,
      );
    }
    return createDemoQueryResponse(
      demoErr("internal_error", message),
      500,
      publicQuery,
      context,
    );
  }
}
/**
 * Exposes the fixture result as provider data while keeping the legacy
 * response-producing entry point available to focused runtime tests.
 */
export async function executeDemoQueryPayload(
  input: DemoQueryRuntimeInput,
): Promise<DemoQueryPayloadResult> {
  const result = await executeDemoQuery(input);
  return { payload: await result.json(), status: result.status };
}
