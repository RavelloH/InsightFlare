import type {
  FetchPrivateJsonOptions,
  PrivateRequestParams,
} from "@/lib/dashboard/client-data-types";

import { toQueryString } from "./client-utils";

// Concurrent identical GET requests share a single in-flight promise so a
// dashboard page mounting many cards at once does not fan out into multiple
// fetches for the same URL. The map is cleared as soon as the request
// settles so subsequent retries / re-fetches still hit the network.
const inflightPrivateRequests = new Map<string, Promise<unknown>>();
const PUBLIC_SITE_ID_PREFIX = "public:";

function throwAbortError(): never {
  const error = new Error("Aborted");
  error.name = "AbortError";
  throw error;
}

function publicSlugFromParams(params?: PrivateRequestParams): string | null {
  const siteId = params?.siteId;
  if (typeof siteId !== "string") return null;
  if (!siteId.startsWith(PUBLIC_SITE_ID_PREFIX)) return null;
  const slug = siteId.slice(PUBLIC_SITE_ID_PREFIX.length).trim();
  return slug.length > 0 ? slug : null;
}

function publicPathForPrivateRequest(path: string, slug: string): string {
  const endpoint = path.replace(/^\/api\/private\/?/, "");
  return `/api/public/${encodeURIComponent(slug)}/${endpoint}`;
}

function paramsWithoutSiteId(
  params?: PrivateRequestParams,
): PrivateRequestParams | undefined {
  if (!params) return undefined;
  const next = { ...params };
  delete next.siteId;
  return next;
}

export function publicDashboardSiteId(slug: string): string {
  return `${PUBLIC_SITE_ID_PREFIX}${slug}`;
}

export async function fetchPrivateJson<T>(
  path: string,
  params?: PrivateRequestParams,
  options?: FetchPrivateJsonOptions,
): Promise<T> {
  if (options?.signal?.aborted) {
    throwAbortError();
  }
  const publicSlug = publicSlugFromParams(params);
  const requestPath = publicSlug
    ? publicPathForPrivateRequest(path, publicSlug)
    : path;
  const requestParams = publicSlug ? paramsWithoutSiteId(params) : params;
  if (process.env.NEXT_PUBLIC_DEMO_MODE === "1") {
    const { handleDemoRequest } = await import("@/lib/realtime/mock");
    if (options?.signal?.aborted) {
      throwAbortError();
    }
    return handleDemoRequest({ path: requestPath, params: requestParams }) as T;
  }
  const url = `${requestPath}${toQueryString(requestParams)}`;
  const shouldDedupe = options?.dedupe !== false && !options?.signal;
  const existing = shouldDedupe
    ? (inflightPrivateRequests.get(url) as Promise<T> | undefined)
    : undefined;
  if (existing) return existing;
  const promise = (async () => {
    const res = await fetch(url, {
      method: "GET",
      credentials: publicSlug ? "omit" : "include",
      signal: options?.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Request failed (${res.status} ${requestPath}): ${text}`);
    }
    return (await res.json()) as T;
  })();
  if (shouldDedupe) {
    inflightPrivateRequests.set(url, promise);
    void promise
      .finally(() => {
        if (inflightPrivateRequests.get(url) === promise) {
          inflightPrivateRequests.delete(url);
        }
      })
      .catch(() => {});
  }
  return promise;
}

export async function fetchPrivateJsonMutate<T>(
  path: string,
  method: "POST" | "DELETE",
  params?: PrivateRequestParams,
  body?: unknown,
): Promise<T> {
  if (process.env.NEXT_PUBLIC_DEMO_MODE === "1") {
    const { handleDemoRequest } = await import("@/lib/realtime/mock");
    return handleDemoRequest({ path, method, params, body }) as T;
  }
  const url = `${path}${toQueryString(params)}`;
  const res = await fetch(url, {
    method,
    credentials: "include",
    cache: "no-store",
    ...(body != null
      ? {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Request failed (${res.status} ${path}): ${text}`);
  }
  return (await res.json()) as T;
}
