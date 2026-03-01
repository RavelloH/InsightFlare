import { DEFAULT_EDGE_BASE_URL } from "./constants";
import { getSessionToken } from "./auth";

export function resolveEdgeBaseUrl(requestUrl?: string): string {
  const configured = (process.env.INSIGHTFLARE_EDGE_URL || "").trim();
  if (configured.length > 0) {
    return configured;
  }
  if (requestUrl) {
    try {
      const origin = new URL(requestUrl).origin;
      if (origin.length > 0) {
        return origin;
      }
    } catch {
      // ignore malformed request URL
    }
  }
  return DEFAULT_EDGE_BASE_URL;
}

export function buildEdgeUrl(pathname: string, params?: Record<string, string>): string {
  return buildEdgeUrlWithBase(resolveEdgeBaseUrl(), pathname, params);
}

export function buildEdgeUrlWithBase(
  baseUrl: string,
  pathname: string,
  params?: Record<string, string>,
): string {
  const url = new URL(pathname, baseUrl);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

export async function fetchEdgeForServer(input: {
  baseUrl?: string;
  pathname: string;
  method?: "GET" | "HEAD" | "POST" | "PATCH";
  params?: Record<string, string>;
  headers?: Record<string, string | undefined>;
  body?: unknown;
}): Promise<Response> {
  const method = input.method || "GET";
  const url = buildEdgeUrlWithBase(input.baseUrl || resolveEdgeBaseUrl(), input.pathname, input.params);
  const headers = new Headers();

  try {
    const sessionToken = await getSessionToken();
    if (sessionToken) {
      headers.set("authorization", `Bearer ${sessionToken}`);
    }
  } catch {
    // Ignore when session is unavailable outside request scope.
  }
  if (input.headers) {
    for (const [key, value] of Object.entries(input.headers)) {
      if (typeof value === "string" && value.length > 0) {
        headers.set(key, value);
      }
    }
  }
  if (method === "POST" || method === "PATCH") {
    headers.set("content-type", "application/json");
  }

  return fetch(url, {
    method,
    headers,
    body: method === "POST" || method === "PATCH" ? JSON.stringify(input.body ?? {}) : undefined,
    cache: "no-store",
  });
}
