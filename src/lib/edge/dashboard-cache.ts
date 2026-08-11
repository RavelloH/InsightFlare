// Edge-cache helper for read-only dashboard and public share queries.
//
// Cache API entries are scoped by the already-authorized analytics tenant,
// not by cookies or bearer tokens. This lets authorized viewers share a
// result without allowing authentication state into the cache key.

const DASHBOARD_CACHE_NAME = "insightflare-dashboard-query";
const DEFAULT_TTL_SECONDS = 60;
const PUBLIC_QUERY_CACHE_NAME = "insightflare-public-query";
export const PUBLIC_QUERY_CACHE_TTL_SECONDS = 300;
const CACHE_KEY_ORIGIN = "https://analytics-cache.insightflare.internal";
const CACHE_SCHEMA_VERSION = "v2";
const DYNAMIC_RESPONSE_FIELDS = new Set(["requestId", "timestamp"]);
export const PUBLIC_QUERY_CACHE_OPTIONS = {
  ttlSeconds: PUBLIC_QUERY_CACHE_TTL_SECONDS,
  cacheName: PUBLIC_QUERY_CACHE_NAME,
  applyCacheHeadersOnBypass: true,
  clientCacheScope: "public",
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

export type DashboardCacheScope = "private" | "public" | "private-team";

export interface DashboardCacheIdentity {
  scope: DashboardCacheScope;
  tenantId: string;
  route: string;
  /**
   * Limits sharing to an authorized audience when a route can return a
   * subset of a tenant's sites, such as the team dashboard.
   */
  audienceId?: string;
}

function sortedSearchParams(url: URL, omitKeys: ReadonlySet<string>): string {
  const sortedEntries = [...url.searchParams.entries()]
    .filter(([key]) => !omitKeys.has(key))
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
      if (leftValue !== rightValue) return leftValue < rightValue ? -1 : 1;
      return 0;
    });
  const search = new URLSearchParams();
  for (const [key, value] of sortedEntries) {
    search.append(key, value);
  }
  return search.toString();
}

function buildCacheKeyRequest(
  url: URL,
  identity?: DashboardCacheIdentity,
): Request {
  const normalized = new URL(url.toString());
  if (!identity) {
    normalized.search = sortedSearchParams(normalized, new Set());
    return new Request(normalized.toString(), { method: "GET" });
  }

  const cacheUrl = new URL(CACHE_KEY_ORIGIN);
  cacheUrl.pathname = [
    "analytics",
    CACHE_SCHEMA_VERSION,
    identity.scope,
    encodeURIComponent(identity.tenantId),
    identity.audienceId ? encodeURIComponent(identity.audienceId) : "shared",
    encodeURIComponent(identity.route),
  ].join("/");
  cacheUrl.search = sortedSearchParams(normalized, new Set(["siteId"]));
  return new Request(cacheUrl.toString(), { method: "GET" });
}

function withCacheControlHeaders(
  response: Response,
  ttlSeconds: number,
  marker?: "HIT" | "MISS",
  scope: "private" | "public" = "private",
  cacheAgeSeconds?: number,
): Response {
  const headers = new Headers(response.headers);
  headers.delete("x-insightflare-cache-created-at");
  headers.delete("x-insightflare-cache-had-dynamic-fields");
  headers.set("cache-control", `${scope}, max-age=${ttlSeconds}`);
  if (scope === "public") {
    headers.set(
      "cache-control",
      `public, max-age=${ttlSeconds}, s-maxage=${ttlSeconds}`,
    );
  }
  // Strip per-user vary so the edge can actually share the entry.
  headers.delete("vary");
  if (marker) {
    headers.set("x-edge-cache", marker);
    headers.set("x-insightflare-cache", marker);
    headers.set("x-insightflare-cache-layer", "response");
    headers.set("x-insightflare-cache-version", CACHE_SCHEMA_VERSION);
  }
  if (typeof cacheAgeSeconds === "number") {
    headers.set("x-insightflare-cache-age", String(cacheAgeSeconds));
  }
  if (marker === "HIT") {
    const generatedRowsRead = headers.get("x-insightflare-d1-rows-read");
    if (generatedRowsRead) {
      headers.set("x-insightflare-cached-d1-rows-read", generatedRowsRead);
      headers.set("x-insightflare-d1-rows-read", "0");
    }
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
  clientCacheScope?: "private" | "public";
  identity?: DashboardCacheIdentity;
  request?: Request;
}

function cacheCreatedAt(response: Response): number | null {
  const value = Number(response.headers.get("x-insightflare-cache-created-at"));
  return Number.isFinite(value) && value > 0 ? value : null;
}

function cacheAgeSeconds(response: Response): number | undefined {
  const createdAt = cacheCreatedAt(response);
  if (!createdAt) return undefined;
  return Math.max(0, Math.floor((Date.now() - createdAt) / 1000));
}

async function removeDynamicResponseFields(response: Response): Promise<{
  response: Response;
  hadDynamicFields: boolean;
}> {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    return { response, hadDynamicFields: false };
  }

  try {
    const payload = (await response.json()) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return { response, hadDynamicFields: false };
    }
    const source = payload as Record<string, unknown>;
    const hadDynamicFields = [...DYNAMIC_RESPONSE_FIELDS].some((key) =>
      Object.hasOwn(source, key),
    );
    const sanitized = Object.fromEntries(
      Object.entries(source).filter(
        ([key]) => !DYNAMIC_RESPONSE_FIELDS.has(key),
      ),
    );
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return {
      response: new Response(JSON.stringify(sanitized), {
        status: response.status,
        statusText: response.statusText,
        headers,
      }),
      hadDynamicFields,
    };
  } catch {
    return { response, hadDynamicFields: false };
  }
}

async function addDynamicResponseFields(
  response: Response,
  request: Request | undefined,
): Promise<Response> {
  if (!request) return response;
  if (response.headers.get("x-insightflare-cache-had-dynamic-fields") !== "1") {
    return response;
  }
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) return response;

  try {
    const payload = (await response.json()) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return response;
    }
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(
      JSON.stringify({
        ...(payload as Record<string, unknown>),
        requestId:
          request.headers.get("cf-ray") ||
          request.headers.get("x-request-id") ||
          crypto.randomUUID().slice(0, 12),
        timestamp: new Date().toISOString(),
      }),
      {
        status: response.status,
        statusText: response.statusText,
        headers,
      },
    );
  } catch {
    return response;
  }
}

async function cacheStorageResponse(
  response: Response,
  ttlSeconds: number,
): Promise<Response> {
  const sanitized = await removeDynamicResponseFields(response);
  const headers = new Headers(sanitized.response.headers);
  headers.set("x-insightflare-cache-created-at", String(Date.now()));
  if (sanitized.hadDynamicFields) {
    headers.set("x-insightflare-cache-had-dynamic-fields", "1");
  }
  headers.set(
    "cache-control",
    `public, max-age=${ttlSeconds}, s-maxage=${ttlSeconds}`,
  );
  headers.delete("vary");
  return new Response(sanitized.response.body, {
    status: sanitized.response.status,
    statusText: sanitized.response.statusText,
    headers,
  });
}

/**
 * Wraps a response generator with edge cache lookup. The generator is only
 * invoked on cache miss. Successful (HTTP 2xx) responses are stored back into
 * the cache with internal public cache headers so the Cloudflare Cache API can
 * reuse the entry. Client-facing responses default to private cache headers;
 * public share routes opt into public headers. Non-2xx responses bypass the
 * cache entirely so error pages never poison the cache.
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
  const clientCacheScope = options.clientCacheScope ?? "private";
  const cache = await openEdgeCache(options.cacheName ?? DASHBOARD_CACHE_NAME);
  if (!cache) {
    const fresh = await generate();
    if (options.applyCacheHeadersOnBypass && fresh.ok) {
      return withCacheControlHeaders(
        fresh,
        ttlSeconds,
        undefined,
        clientCacheScope,
      );
    }
    return fresh;
  }
  const cacheKey = buildCacheKeyRequest(url, options.identity);

  try {
    const cached = await cache.match(cacheKey);
    if (cached) {
      const materialized = await addDynamicResponseFields(
        cached,
        options.request,
      );
      return withCacheControlHeaders(
        materialized,
        ttlSeconds,
        "HIT",
        clientCacheScope,
        cacheAgeSeconds(cached),
      );
    }
  } catch {
    // Fall through to fresh generation on cache read failure.
  }

  const fresh = await generate();
  if (!fresh.ok) {
    return fresh;
  }

  const cacheable = await cacheStorageResponse(fresh.clone(), ttlSeconds);
  const putPromise = cache.put(cacheKey, cacheable).catch(() => undefined);
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(putPromise);
  }

  return withCacheControlHeaders(fresh, ttlSeconds, "MISS", clientCacheScope);
}
