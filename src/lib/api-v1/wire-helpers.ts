import { jsonResponse } from "@/lib/response";

export const API_V1_VERSION = import.meta.env?.VITE_APP_VERSION || "1.0.0";
export const BATCH_MAX_REQUESTS = 50;

const apiV1RequestIds = new WeakMap<Request, string>();

function serverRequestId(request?: Request | null): string {
  if (request) {
    const existing = apiV1RequestIds.get(request);
    if (existing) return existing;
    const generated = crypto.randomUUID().replaceAll("-", "");
    apiV1RequestIds.set(request, generated);
    return generated;
  }
  return crypto.randomUUID().replaceAll("-", "");
}

function apiV1Headers(
  requestId: string,
  headers?: Record<string, string>,
): Record<string, string> {
  return {
    ...(headers ?? {}),
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Request-Id": requestId,
  };
}

export interface ApiMeta {
  requestId?: string;
  generatedAt: string;
  [key: string]: unknown;
}

export function generatedAt(): string {
  return new Date().toISOString();
}

export function getRequestMeta(request?: Request | null): ApiMeta {
  return {
    ...(request ? { requestId: serverRequestId(request) } : {}),
    generatedAt: generatedAt(),
  };
}

export function jsonSuccess(
  data: unknown,
  options: {
    request?: Request;
    status?: number;
    meta?: Record<string, unknown>;
    links?: Record<string, string>;
    headers?: Record<string, string>;
  } = {},
): Response {
  const requestId = serverRequestId(options.request);
  return jsonResponse(
    {
      data,
      ...(options.links ? { links: options.links } : {}),
      meta: {
        ...(options.meta ?? {}),
        generatedAt: generatedAt(),
        requestId,
      },
    },
    options.status ?? 200,
    apiV1Headers(requestId, options.headers),
  );
}

export function jsonList(
  data: unknown[],
  options: {
    request?: Request;
    status?: number;
    meta?: Record<string, unknown>;
    links?: Record<string, string>;
    headers?: Record<string, string>;
  } = {},
): Response {
  return jsonSuccess(data, options);
}

export function jsonError(
  code: string,
  message: string,
  status: number,
  details?: Record<string, unknown>,
  request?: Request,
): Response {
  const requestId = serverRequestId(request);
  return jsonResponse(
    {
      error: {
        code,
        message,
        ...(details ? { details } : {}),
      },
      meta: { requestId, generatedAt: generatedAt() },
    },
    status,
    apiV1Headers(requestId),
  );
}

export function methodNotAllowed(request: Request, allow?: string): Response {
  const response = jsonError(
    "method_not_allowed",
    "Method Not Allowed",
    405,
    undefined,
    request,
  );
  if (allow) response.headers.set("Allow", allow);
  return response;
}
