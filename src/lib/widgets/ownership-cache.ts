import type { Env } from "@/lib/edge/types";
import { widgetSiteBelongsToTeam } from "@/lib/widgets/store";

/**
 * Public embed pages and their data endpoint run on every visitor of every
 * page that embeds a widget. The site → team ownership check is a D1 join,
 * so the public path reuses a short-lived result instead of querying D1 on
 * each request. Management routes keep using the uncached D1 check.
 *
 * A deleted or transferred site therefore stops serving its widgets within
 * roughly ISOLATE_TTL_MS + EDGE_TTL_SECONDS, which is in line with the
 * propagation delay of the KV widget records themselves.
 */
const EDGE_TTL_SECONDS = 60;
const ISOLATE_TTL_MS = 15_000;
const ISOLATE_MEMO_LIMIT = 512;
const CACHE_NAME = "insightflare-widget-ownership";

const isolateMemo = new Map<string, { owned: boolean; expiresAt: number }>();

function memoKey(teamId: string, siteId: string): string {
  return JSON.stringify([teamId, siteId]);
}

function remember(key: string, owned: boolean, now: number): void {
  isolateMemo.delete(key);
  if (isolateMemo.size >= ISOLATE_MEMO_LIMIT) {
    const oldest = isolateMemo.keys().next().value;
    if (oldest !== undefined) isolateMemo.delete(oldest);
  }
  isolateMemo.set(key, { owned, expiresAt: now + ISOLATE_TTL_MS });
}

async function openOwnershipCache(): Promise<Cache | null> {
  try {
    if (typeof caches === "undefined") return null;
    return await caches.open(CACHE_NAME);
  } catch {
    return null;
  }
}

function edgeCacheKey(teamId: string, siteId: string): Request {
  return new Request(
    `https://widget-ownership.insightflare.internal/${encodeURIComponent(teamId)}/${encodeURIComponent(siteId)}`,
  );
}

export async function cachedWidgetSiteBelongsToTeam(
  env: Env,
  teamId: string,
  siteId: string,
  ctx?: Pick<ExecutionContext, "waitUntil">,
): Promise<boolean> {
  const key = memoKey(teamId, siteId);
  const now = Date.now();
  const memo = isolateMemo.get(key);
  if (memo && memo.expiresAt > now) return memo.owned;

  const cache = await openOwnershipCache();
  const request = edgeCacheKey(teamId, siteId);
  if (cache) {
    const hit = await cache.match(request).catch(() => undefined);
    const body = hit ? await hit.text().catch(() => null) : null;
    if (body === "1" || body === "0") {
      remember(key, body === "1", now);
      return body === "1";
    }
  }

  // D1 failures propagate and are never cached: the caller fails closed.
  const owned = await widgetSiteBelongsToTeam(env, teamId, siteId);
  remember(key, owned, now);
  if (cache) {
    const write = cache
      .put(
        request,
        new Response(owned ? "1" : "0", {
          headers: { "cache-control": `max-age=${EDGE_TTL_SECONDS}` },
        }),
      )
      .catch(() => undefined);
    if (ctx) ctx.waitUntil(write);
    else await write;
  }
  return owned;
}

export function clearWidgetOwnershipMemo(): void {
  isolateMemo.clear();
}
