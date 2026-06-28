// Edge-cache helper for read-only dashboard and public share queries.
//
// Goal: hot dashboards (Devices, Browsers, Geo, etc.) currently fan out into
// 10–20 D1 statements per page load and re-issue the same SQL on every
// reload. We do NOT want to rely on D1 transparent read replication, so we
// cache the JSON response in the Cloudflare Cache API for a short TTL.
//
// Caching is keyed on the entire request URL with query parameters sorted
// alphabetically so that two visually identical requests with parameters in
// different orders still hit the same cache entry. The cache lookup is
// performed AFTER `resolvePrivateSite` runs, so we never serve cached data
// to an unauthorized user — auth always runs first.

const DASHBOARD_CACHE_NAME = "insightflare-dashboard-query";
const DEFAULT_TTL_SECONDS = 60;
const PUBLIC_QUERY_CACHE_NAME = "insightflare-public-query";
export const PUBLIC_QUERY_CACHE_TTL_SECONDS = 300;
export const PUBLIC_QUERY_CACHE_OPTIONS = {
  ttlSeconds: PUBLIC_QUERY_CACHE_TTL_SECONDS,
  cacheName: PUBLIC_QUERY_CACHE_NAME,
  applyCacheHeadersOnBypass: true,
} as const;

function openCacheStorage(): CacheStorage | null {
  if (typeof globalThis !== "object" || !("caches" in globalThis)) {
    return null;
  }
  const maybeCaches = (globalThis as { caches?: CacheStorage }).caches;
  if (!maybeCaches || typeof maybeCaches.open !== "function") {
    return null;
  }
  return maybeCaches;
}

async function openEdgeCache(cacheName: string): Promise<Cache | null> {
  const storage = openCacheStorage();
  if (!storage) return null;
  try {
    return await storage.open(cacheName);
  } catch {
    return null;
  }
}

function buildCacheKeyRequest(url: URL): Request {
  const normalized = new URL(url.toString());
  const sortedEntries = [...normalized.searchParams.entries()].sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
  );
  const search = new URLSearchParams();
  for (const [key, value] of sortedEntries) {
    search.append(key, value);
  }
  normalized.search = search.toString();
  return new Request(normalized.toString(), { method: "GET" });
}

function withCacheControlHeaders(
  response: Response,
  ttlSeconds: number,
  marker?: "HIT" | "MISS",
): Response {
  const headers = new Headers(response.headers);
  headers.set(
    "cache-control",
    `public, max-age=${ttlSeconds}, s-maxage=${ttlSeconds}`,
  );
  // Strip per-user vary so the edge can actually share the entry.
  headers.delete("vary");
  if (marker) {
    headers.set("x-edge-cache", marker);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export interface DashboardCacheOptions {
  ttlSeconds?: number;
  cacheName?: string;
  applyCacheHeadersOnBypass?: boolean;
}

/**
 * Wraps a response generator with edge cache lookup. The generator is only
 * invoked on cache miss. Successful (HTTP 2xx) responses are stored back into
 * the cache with `cache-control: public, max-age=N, s-maxage=N` so that both
 * the Cloudflare edge and downstream browsers cache the result for `N`
 * seconds. Non-2xx responses bypass the cache entirely so error pages never
 * poison the cache.
 */
export async function withDashboardCache(
  ctx: ExecutionContext | undefined,
  url: URL,
  generate: () => Promise<Response>,
  options: DashboardCacheOptions = {},
): Promise<Response> {
  const ttlSeconds = Math.max(
    1,
    Math.floor(options.ttlSeconds ?? DEFAULT_TTL_SECONDS),
  );
  const cache = await openEdgeCache(options.cacheName ?? DASHBOARD_CACHE_NAME);
  if (!cache) {
    const fresh = await generate();
    if (options.applyCacheHeadersOnBypass && fresh.ok) {
      return withCacheControlHeaders(fresh, ttlSeconds);
    }
    return fresh;
  }
  const cacheKey = buildCacheKeyRequest(url);

  try {
    const cached = await cache.match(cacheKey);
    if (cached) {
      return withCacheControlHeaders(cached, ttlSeconds, "HIT");
    }
  } catch {
    // Fall through to fresh generation on cache read failure.
  }

  const fresh = await generate();
  if (!fresh.ok) {
    return fresh;
  }

  const cacheable = withCacheControlHeaders(fresh.clone(), ttlSeconds, "HIT");
  const putPromise = cache.put(cacheKey, cacheable).catch(() => undefined);
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(putPromise);
  }

  return withCacheControlHeaders(fresh, ttlSeconds, "MISS");
}
