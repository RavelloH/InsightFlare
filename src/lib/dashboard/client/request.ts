import type {
  FetchPrivateJsonOptions,
  PrivateReadTransport,
  PrivateRequestParams,
} from "@/lib/dashboard/client/data/types";
import { toQueryString } from "@/lib/dashboard/client/utils";
import type { ManagementJsonValue } from "@/lib/dashboard/management-data";
import {
  analyticsFilterRegistry,
  filterDocumentHasSimpleEventFacts,
  parseFilterParams,
} from "@/lib/filter-contract";
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
  return `/api/public/share/${encodeURIComponent(slug)}/${endpoint}`;
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
type QueuedPrivateRead = {
  path: string;
  query: string;
  signal?: AbortSignal;
  single: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};
type PrivateReadGroup = {
  items: QueuedPrivateRead[];
  timer?: ReturnType<typeof setTimeout>;
};
const privateReadGroups = new Map<string, PrivateReadGroup>();
const PRIVATE_BATCH_SIZE = 4;
function batchableOverviewPath(path: string): boolean {
  return /^(?:page-query|overview-page-(?:path|title|hostname)|overview-source-channel|overview-client-(?:browser|os-version|device-type|language|screen-size)|overview-geo-(?:country|region|city|continent|timezone|organization))$/.test(
    path,
  );
}
function abortError(): Error {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}
async function flushPrivateReads(
  key: string,
  group: PrivateReadGroup,
  siteId: string,
) {
  if (privateReadGroups.get(key) !== group) return;
  privateReadGroups.delete(key);
  clearTimeout(group.timer);
  const items = group.items.filter((item) => {
    if (!item.signal?.aborted) return true;
    item.reject(abortError());
    return false;
  });
  if (items.length < 2) {
    for (const item of items) item.single().then(item.resolve, item.reject);
    return;
  }
  const controller = new AbortController();
  const onAbort = () => {
    for (const item of items) {
      if (item.signal?.aborted) item.reject(abortError());
    }
    if (items.every((item) => item.signal?.aborted)) controller.abort();
  };
  for (const item of items)
    item.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(
      "/api/private/query-batch" + toQueryString({ siteId }),
      {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          items: items.map(({ path, query }) => ({ path, query })),
        }),
        signal: controller.signal,
      },
    );
    if (response.status === 401 || response.status === 403) {
      for (const item of items)
        item.reject(
          new Error(
            "Request failed (" + response.status + " /api/private/query-batch)",
          ),
        );
      return;
    }
    if (!response.ok) throw new Error("Batch unavailable");
    const payload = (await response.json()) as {
      ok?: boolean;
      items?: { status?: number; body?: unknown }[];
    };
    if (
      payload.ok !== true ||
      !Array.isArray(payload.items) ||
      payload.items.length !== items.length ||
      payload.items.some(
        (item) =>
          !item ||
          typeof item !== "object" ||
          !Number.isInteger(item.status) ||
          !("body" in item),
      )
    ) {
      throw new Error("Invalid batch response");
    }
    items.forEach((item, i) => {
      const result = payload.items![i]!;
      if (item.signal?.aborted) item.reject(abortError());
      else if (result.status! >= 200 && result.status! < 300)
        item.resolve(result.body);
      else
        item.reject(
          new Error(
            "Request failed (" +
              result.status +
              " /api/private/" +
              item.path +
              ")",
          ),
        );
    });
  } catch {
    // Rolling deployments and transport failures may leave the batch endpoint
    // unavailable. Only retry independent reads, never mutations.
    for (const item of items) {
      if (item.signal?.aborted) item.reject(abortError());
      else item.single().then(item.resolve, item.reject);
    }
  } finally {
    for (const item of items)
      item.signal?.removeEventListener("abort", onAbort);
  }
}
function queuePrivateOverviewRead<T>(
  path: string,
  params: PrivateRequestParams | undefined,
  options: FetchPrivateJsonOptions | undefined,
  single: () => Promise<T>,
): Promise<T> | undefined {
  const endpoint = path.replace(/^\/api\/private\//, "");
  const siteId = params?.siteId;
  if (
    typeof window === "undefined" ||
    !options?.batchOverview ||
    typeof siteId !== "string" ||
    siteId.startsWith(PUBLIC_SITE_ID_PREFIX) ||
    import.meta.env.VITE_DEMO_MODE === "1" ||
    !batchableOverviewPath(endpoint) ||
    !params ||
    !Object.keys(params).some((key) => key.startsWith("filter[")) ||
    params.compare != null ||
    params.cursor ||
    params.search ||
    !Number.isInteger(Number(params.limit)) ||
    Number(params.limit) < 1 ||
    Number(params.limit) > 100 ||
    params.from == null ||
    params.to == null
  )
    return undefined;
  const query = toQueryString(params);
  if (query.length > 8192) return undefined;
  if (params.scope !== "session" && params.scope !== "visitor") {
    if (
      params.scope != null &&
      params.scope !== "event" &&
      params.scope !== "auto"
    )
      return undefined;
    try {
      if (
        !filterDocumentHasSimpleEventFacts(
          parseFilterParams(
            new URLSearchParams(query),
            analyticsFilterRegistry,
          ),
        )
      )
        return undefined;
    } catch {
      // The original GET adapter owns validation; do not turn malformed input
      // into a different client-side error.
      return undefined;
    }
  }
  const shared = new URLSearchParams(query);
  for (const name of ["limit", "sort", "direction"]) shared.delete(name);
  shared.sort();
  const key = shared.toString();
  return new Promise<T>((resolve, reject) => {
    let group = privateReadGroups.get(key);
    if (!group) {
      group = { items: [] };
      privateReadGroups.set(key, group);
      const current = group;
      current.timer = setTimeout(() => {
        void flushPrivateReads(key, current, siteId);
      }, 5);
    }
    group.items.push({
      path: endpoint,
      query,
      signal: options.signal,
      single,
      resolve: (value) => resolve(value as T),
      reject,
    });
    if (group.items.length === PRIVATE_BATCH_SIZE)
      void flushPrivateReads(key, group, siteId);
  });
}

/** The exact URL identity is shared by the SSR planner and existing query functions.
 * No filter, sort, comparison, cursor or time field is omitted. */
export function privateReadIdentity(
  path: string,
  params?: PrivateRequestParams,
): string {
  const query = new URLSearchParams(toQueryString(params));
  query.sort();
  return path + "?" + query.toString();
}
export type DeferredPrivateReads = Record<
  string,
  Promise<{ value: ManagementJsonValue } | null>
>;
const consumedPrivateReads = new WeakSet<object>();
// Match the normalized React Query freshness window. Pending reads can
// still finish independently; an unused resolved read cannot become a
// second long-lived cache held by the route loader.
const DEFERRED_READ_FRESH_MS = 15_000;
const deferredReadExpiry = new WeakMap<object, number>();
function trackDeferredReadExpiry(reads: DeferredPrivateReads): void {
  for (const deferred of Object.values(reads)) {
    if (deferredReadExpiry.has(deferred)) continue;
    deferredReadExpiry.set(deferred, Infinity);
    const settle = () => {
      deferredReadExpiry.set(deferred, Date.now() + DEFERRED_READ_FRESH_MS);
    };
    void deferred.then(settle, settle);
  }
}

/** Reuse the streamed response inside the normal React Query queryFn. The
 * query cache retains its existing normalized result/key, not a second cache.
 * A cancelled observer cannot install data from a stale navigation. */
export function createDeferredPrivateReadTransport(
  reads: DeferredPrivateReads,
): PrivateReadTransport {
  trackDeferredReadExpiry(reads);
  return async <T>(
    path: string,
    params?: PrivateRequestParams,
    options?: FetchPrivateJsonOptions,
  ): Promise<T> => {
    const signal = options?.signal;
    if (signal?.aborted) throwAbortError();
    const deferred = reads[privateReadIdentity(path, params)];
    if (
      deferred !== undefined &&
      !consumedPrivateReads.has(deferred) &&
      Date.now() < (deferredReadExpiry.get(deferred) ?? 0)
    ) {
      let abort: (() => void) | undefined;
      try {
        const result = await (signal
          ? Promise.race([
              deferred.catch(() => null),
              new Promise<never>((_, reject) => {
                abort = () => reject(abortError());
                signal.addEventListener("abort", abort, { once: true });
              }),
            ])
          : deferred.catch(() => null));
        if (signal?.aborted) throwAbortError();
        consumedPrivateReads.add(deferred);
        if (result) return result.value as T;
      } finally {
        if (abort) signal?.removeEventListener("abort", abort);
      }
    }
    return fetchPrivateJson<T>(path, params, {
      ...options,
      transport: undefined,
    });
  };
}

export async function fetchPrivateJson<T>(
  path: string,
  params?: PrivateRequestParams,
  options?: FetchPrivateJsonOptions,
): Promise<T> {
  if (options?.signal?.aborted) {
    throwAbortError();
  }
  if (options?.transport) return options.transport<T>(path, params, options);
  const publicSlug = publicSlugFromParams(params);
  const requestPath = publicSlug
    ? publicPathForPrivateRequest(path, publicSlug)
    : path;
  const requestParams = publicSlug ? paramsWithoutSiteId(params) : params;
  const url = `${requestPath}${toQueryString(requestParams)}`;
  const shouldDedupe = options?.dedupe !== false && !options?.signal;
  const existing = shouldDedupe
    ? (inflightPrivateRequests.get(url) as Promise<T> | undefined)
    : undefined;
  if (existing) return existing;
  const single = async () => {
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
  };
  const promise =
    queuePrivateOverviewRead(path, params, options, single) ?? single();
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
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  params?: PrivateRequestParams,
  body?: unknown,
): Promise<T> {
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
