import "@tanstack/react-start/server-only";

import type {
  FilterScope,
  QueryOperation,
} from "@/lib/edge/analytics/contract";
import {
  getRequestId,
  jsonResponseWith,
  type ResponseContext,
} from "@/lib/edge/analytics/providers/d1/internal/core-responses";
import {
  PRIVATE_CACHE_HEADERS,
  PUBLIC_CACHE_HEADERS,
} from "@/lib/edge/analytics/providers/d1/internal/core-types";
import { analyticsDiagnosticHeaders } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import {
  demoBadRequest,
  demoErr,
  isErrorEnvelope,
} from "@/lib/realtime/mock/envelope";

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
  return lastPathSegment === "funnels" || lastPathSegment === "saved-filters"
    ? 201
    : 200;
}

function requiresJsonBodyValidation(request: Request, url: URL): boolean {
  if (request.method !== "POST") return false;
  return url.pathname.split("/").filter(Boolean).at(-1) === "funnels";
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

  try {
    const { handleDemoRequest } = await import("@/lib/realtime/mock");
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
