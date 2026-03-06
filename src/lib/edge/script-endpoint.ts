import { buildTrackerScript } from "./script";
import {
  normalizeSiteSettingsKey,
  readSiteTrackingConfig,
} from "./site-settings-store";
import type { Env } from "./types";

const SCRIPT_RESPONSE_CACHE_NAME = "insightflare-script-cache";
const SCRIPT_RESPONSE_CACHE_TTL_SECONDS = 60 * 60;

function isEUCountry(request: Request): boolean {
  const cf = (request as Request & { cf?: { isEUCountry?: boolean } }).cf;
  return Boolean(cf?.isEUCountry);
}

function responseBadRequest(message: string): Response {
  return new Response(message, { status: 400 });
}

function responseNotFound(): Response {
  return new Response("Not Found", { status: 404 });
}

function responseMethodNotAllowed(): Response {
  return new Response("Method Not Allowed", { status: 405 });
}

function responseInternalServerError(message: string): Response {
  return new Response(message, { status: 500 });
}

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

async function openEdgeCache(name: string): Promise<Cache | null> {
  const storage = openCacheStorage();
  if (!storage) return null;
  try {
    return await storage.open(name);
  } catch {
    return null;
  }
}

function determineEuMode(trackingStrength: "strong" | "smart" | "weak", requestEuMode: boolean): boolean {
  if (trackingStrength === "strong") return false;
  if (trackingStrength === "weak") return true;
  return requestEuMode;
}

function settingsFingerprint(input: {
  trackingStrength: "strong" | "smart" | "weak";
  trackQueryParams: boolean;
  trackHash: boolean;
  ignoreDoNotTrack: boolean;
  siteDomain: string;
}): string {
  return [
    input.trackingStrength,
    input.trackQueryParams ? "1" : "0",
    input.trackHash ? "1" : "0",
    input.ignoreDoNotTrack ? "1" : "0",
    input.siteDomain,
  ].join("|");
}

function scriptCacheKeyRequest(siteId: string, euMode: boolean, fingerprint: string): Request {
  const encodedSiteId = encodeURIComponent(siteId);
  const encodedFingerprint = encodeURIComponent(fingerprint);
  return new Request(
    `https://insightflare.internal/__script/${encodedSiteId}?eu=${euMode ? "1" : "0"}&fp=${encodedFingerprint}`,
  );
}

export async function handleTrackerScriptRequest(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") {
    return responseMethodNotAllowed();
  }

  const incomingUrl = new URL(request.url);
  const siteId = normalizeSiteSettingsKey(incomingUrl.searchParams.get("siteId"));
  if (!siteId) {
    return responseBadRequest("Missing siteId");
  }

  let settings;
  try {
    settings = await readSiteTrackingConfig(env, siteId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "site_settings_unavailable";
    return responseInternalServerError(message);
  }
  if (!settings?.siteDomain) {
    return responseNotFound();
  }

  const requestEuMode = isEUCountry(request);
  const euMode = determineEuMode(settings.trackingStrength, requestEuMode);
  const ttlSeconds = SCRIPT_RESPONSE_CACHE_TTL_SECONDS;
  const fingerprint = settingsFingerprint(settings);
  const cacheKey = scriptCacheKeyRequest(siteId, euMode, fingerprint);
  const scriptCache = await openEdgeCache(SCRIPT_RESPONSE_CACHE_NAME);
  if (scriptCache) {
    const cached = await scriptCache.match(cacheKey);
    if (cached) {
      return cached;
    }
  }

  const script = buildTrackerScript({
    siteId,
    isEUMode: euMode,
    trackQueryParams: settings.trackQueryParams,
    trackHash: settings.trackHash,
    ignoreDoNotTrack: settings.ignoreDoNotTrack,
  });

  const response = new Response(script, {
    status: 200,
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": `public, max-age=${ttlSeconds}, s-maxage=${ttlSeconds}`,
      "access-control-allow-origin": "*",
    },
  });

  if (scriptCache) {
    await scriptCache.put(cacheKey, response.clone());
  }

  return response;
}
