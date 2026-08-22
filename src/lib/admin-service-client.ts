import {
  adminServicePath,
  type AdminServiceRoute,
} from "@/lib/admin-service-contract";
import { extractErrorMessage } from "@/lib/response-envelope";

import { fetchEdgeJson } from "./edge-client";

export type AdminServiceHttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

export interface AdminServiceClientOptions {
  readonly method?: AdminServiceHttpMethod;
  readonly params?: Record<string, string | number | boolean | undefined>;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

interface AdminServiceEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: unknown;
  message?: unknown;
}

function normalizeParams(
  params?: AdminServiceClientOptions["params"],
): Record<string, string | number> | undefined {
  if (!params) return undefined;
  return Object.fromEntries(
    Object.entries(params).flatMap(([key, value]) =>
      value === undefined ? [] : [[key, String(value)]],
    ),
  );
}

/**
 * Typed client boundary for authenticated management requests. Components do
 * not need to know URL layout, demo dispatch, credentials, or response
 * envelope details.
 */
export async function requestAdminService<T>(
  route: AdminServiceRoute,
  options: AdminServiceClientOptions = {},
): Promise<T> {
  const response = await fetchEdgeJson<AdminServiceEnvelope<T>>({
    method: options.method,
    path: adminServicePath(route),
    params: normalizeParams(options.params),
    body: options.body,
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(
      extractErrorMessage(response, `admin_service_${route}_failed`),
    );
  }
  return (response.data === undefined ? response : response.data) as T;
}
